//! `somniq-computer`: the read-only computer-use helper the desktop app
//! starts on demand. One JSON request per stdin line, one response per stdout
//! line, in order (see `computer::protocol`).
//!
//! A separate process because a hung UI Automation provider blocks the
//! calling thread inside COM: the desktop kills and restarts this process
//! instead of freezing. Its snapshot cache dies with it, so every element
//! number from before a restart is stale.

#[cfg(not(windows))]
fn main() {
    eprintln!("somniq-computer: Windows only");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    std::process::exit(windows_helper::run());
}

#[cfg(windows)]
mod windows_helper {
    use std::collections::HashMap;
    use std::io::{BufRead, Write};
    use std::time::{Duration, Instant};

    use computer::image::{base64, crop_permille, fit_long_edge, is_blank, to_png, trim_unrendered};
    use computer::platform::windows::{
        capture, enable_per_monitor_dpi, list_windows, snapshot, window_info, ProbeError,
        Strategy, WalkLimits, WalkOutcome, WindowInfo,
    };
    use computer::policy::Tier;
    use computer::protocol::{parse_request, Op, Request, Response};
    use computer::snapshot::{find, render, render_at, same_element, stats, Filter, Node, RenderOptions};
    use serde_json::{json, Value};

    /// A find without a fresh snapshot takes a new one.
    const SNAPSHOT_FRESH_FOR: Duration = Duration::from_secs(30);
    const DEFAULT_MAX_CHARS: usize = 12_000;
    const MAX_MAX_CHARS: usize = 40_000;
    const DEFAULT_LONG_EDGE: u32 = 1_568;
    const MAX_LONG_EDGE: u32 = 2_576;

    struct Cached {
        seq: u64,
        taken: Instant,
        root: Node,
    }

    #[derive(Default)]
    struct Helper {
        cache: HashMap<isize, Cached>,
        next_seq: u64,
    }

    pub fn run() -> i32 {
        enable_per_monitor_dpi();
        let mut helper = Helper::default();
        let stdin = std::io::stdin();
        let mut out = std::io::stdout().lock();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            let response = match parse_request(&line) {
                Ok(request) => helper.handle(request),
                Err((id, message)) => Response::error(id, "BAD_REQUEST", message),
            };
            if serde_json::to_writer(&mut out, &response).is_err()
                || out.write_all(b"\n").is_err()
                || out.flush().is_err()
            {
                break;
            }
        }
        0
    }

    fn fail(id: u64, error: &ProbeError) -> Response {
        Response::error(id, error.code, error.message.clone())
    }

    fn window_json(window: &WindowInfo) -> Value {
        let protected = window.classification.tier == Tier::Protected;
        json!({
            "hwnd": window.hwnd,
            "pid": window.pid,
            "exe": window.exe_name,
            "class": window.class_name,
            // Protected windows' titles are never read in the first place.
            "title": if protected { Value::Null } else { json!(window.title) },
            "tier": window.classification.tier,
            "tierReason": window.classification.reason,
            "minimized": window.minimized,
            "rect": window.rect,
            "dpi": window.dpi,
        })
    }

    impl Helper {
        fn handle(&mut self, request: Request) -> Response {
            let id = request.id;
            match request.op {
                Op::Ping => Response::ok(id, json!({ "pong": true, "version": env!("CARGO_PKG_VERSION") })),
                Op::ListWindows => {
                    let list = list_windows();
                    Response::ok(
                        id,
                        json!({
                            "windows": list.windows.iter().map(window_json).collect::<Vec<_>>(),
                            "hiddenByPolicy": list.hidden_by_policy,
                        }),
                    )
                }
                Op::Window { hwnd } => match window_info(hwnd) {
                    Some(window) => Response::ok(id, window_json(&window)),
                    None => Response::error(id, "WINDOW_GONE", "窗口已不存在"),
                },
                Op::Snapshot {
                    hwnd,
                    filter,
                    max_chars,
                    reference,
                } => self.snapshot(id, hwnd, filter, max_chars, reference),
                Op::Find { hwnd, query, limit } => self.find(id, hwnd, &query, limit),
                Op::Screenshot {
                    hwnd,
                    max_long_edge,
                    region,
                } => screenshot(id, hwnd, max_long_edge, region),
            }
        }

        /// Subtree first (one cross-process call, R0: 1.7–1.9× faster); if
        /// that times out or fails, the walker, which can stop at a deadline
        /// and still return what it read.
        fn take_snapshot(&mut self, hwnd: isize) -> Result<(u64, WalkOutcome), ProbeError> {
            let quick = WalkLimits {
                deadline: Duration::from_secs(8),
                max_elements: 3_000,
                ..WalkLimits::default()
            };
            let outcome = match snapshot(hwnd, Strategy::Subtree, quick) {
                Ok(outcome) => outcome,
                Err(error) if error.code == "HELPER_TIMEOUT" || error.code == "UIA_ERROR" => {
                    snapshot(
                        hwnd,
                        Strategy::Walker,
                        WalkLimits {
                            deadline: Duration::from_secs(12),
                            max_elements: 3_000,
                            ..WalkLimits::default()
                        },
                    )?
                }
                Err(error) => return Err(error),
            };
            self.next_seq += 1;
            Ok((self.next_seq, outcome))
        }

        fn snapshot(
            &mut self,
            id: u64,
            hwnd: isize,
            filter: Option<Filter>,
            max_chars: Option<usize>,
            reference: Option<usize>,
        ) -> Response {
            let Some(window) = window_info(hwnd) else {
                return Response::error(id, "WINDOW_GONE", "窗口已不存在");
            };
            let (seq, outcome) = match self.take_snapshot(hwnd) {
                Ok(taken) => taken,
                Err(error) => return fail(id, &error),
            };
            let options = RenderOptions {
                filter: filter.unwrap_or(Filter::Interactive),
                max_chars: max_chars.unwrap_or(DEFAULT_MAX_CHARS).clamp(500, MAX_MAX_CHARS),
                ..RenderOptions::default()
            };
            let rendered = match reference {
                Some(reference) => {
                    let still_there = self
                        .cache
                        .get(&hwnd)
                        .is_some_and(|previous| same_element(&previous.root, &outcome.root, reference));
                    if !still_there {
                        return Response::error(
                            id,
                            "STALE_SNAPSHOT",
                            format!("e{reference} 已经不是上次快照里的那个元素（或没有上次快照）；请先不带 ref 重新快照"),
                        );
                    }
                    match render_at(&outcome.root, reference, &options) {
                        Some(rendered) => rendered,
                        None => return Response::error(id, "STALE_SNAPSHOT", format!("没有 e{reference}")),
                    }
                }
                None => render(&outcome.root, &options),
            };
            let tree = stats(&outcome.root);
            let result = json!({
                "snapshotSeq": seq,
                "window": window_json(&window),
                "text": rendered.text,
                "shown": rendered.shown,
                "eligible": rendered.eligible,
                "hiddenOffscreen": rendered.hidden_offscreen,
                "truncated": rendered.truncated,
                "chars": rendered.chars,
                "approxTokens": rendered.approx_tokens,
                "elements": tree.elements,
                "strategy": outcome.strategy,
                "fetchMs": outcome.fetch_ms,
                "stoppedBy": outcome.stopped_by,
            });
            self.cache.insert(
                hwnd,
                Cached {
                    seq,
                    taken: Instant::now(),
                    root: outcome.root,
                },
            );
            Response::ok(id, result)
        }

        fn find(&mut self, id: u64, hwnd: isize, query: &str, limit: Option<usize>) -> Response {
            if window_info(hwnd).is_none() {
                return Response::error(id, "WINDOW_GONE", "窗口已不存在");
            }
            let fresh = self
                .cache
                .get(&hwnd)
                .is_some_and(|cached| cached.taken.elapsed() < SNAPSHOT_FRESH_FOR);
            if !fresh {
                match self.take_snapshot(hwnd) {
                    Ok((seq, outcome)) => {
                        self.cache.insert(
                            hwnd,
                            Cached {
                                seq,
                                taken: Instant::now(),
                                root: outcome.root,
                            },
                        );
                    }
                    Err(error) => return fail(id, &error),
                }
            }
            let Some(cached) = self.cache.get(&hwnd) else {
                return Response::error(id, "STALE_SNAPSHOT", "没有可用的快照");
            };
            let limit = limit.unwrap_or(20).clamp(1, 50);
            let matches = find(&cached.root, query, limit, &RenderOptions::default());
            Response::ok(
                id,
                json!({
                    "snapshotSeq": cached.seq,
                    "ageMs": u64::try_from(cached.taken.elapsed().as_millis()).unwrap_or(u64::MAX),
                    "matches": matches,
                }),
            )
        }
    }

    fn screenshot(
        id: u64,
        hwnd: isize,
        max_long_edge: Option<u32>,
        region: Option<computer::image::Region>,
    ) -> Response {
        let image = match capture(hwnd, Duration::from_secs(6)) {
            Ok(image) => trim_unrendered(&image),
            Err(error) => return fail(id, &error),
        };
        if is_blank(&image) {
            return Response::error(
                id,
                "CAPTURE_FAILED",
                "窗口没有渲染出内容（可能被保护、正在加载或使用了不支持截图的绘制方式）",
            );
        }
        let (source_width, source_height) = (image.width, image.height);
        let cropped = match region {
            Some(region) => crop_permille(&image, region),
            None => image,
        };
        let (fitted, scale) = fit_long_edge(
            &cropped,
            max_long_edge.unwrap_or(DEFAULT_LONG_EDGE).clamp(256, MAX_LONG_EDGE),
        );
        let png = match to_png(&fitted) {
            Ok(png) => png,
            Err(error) => return Response::error(id, "CAPTURE_FAILED", error),
        };
        Response::ok(
            id,
            json!({
                "mediaType": "image/png",
                "data": base64(&png),
                "bytes": png.len(),
                "width": fitted.width,
                "height": fitted.height,
                "scale": scale,
                "sourceWidth": source_width,
                "sourceHeight": source_height,
                "region": region,
            }),
        )
    }
}
