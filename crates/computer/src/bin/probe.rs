//! R0 UI Automation probe.
//!
//! ```text
//! somniq-computer-probe list [--show-titles]
//! somniq-computer-probe find --exe <name.exe> [--title-contains <text>] [--show-titles]
//! somniq-computer-probe snapshot --hwnd <h> [--strategy walker|subtree|both] [--repeat <n>]
//!     [--max-depth <n>] [--max-elements <n>] [--deadline-ms <n>] [--txn-timeout-ms <n>]
//!     [--max-chars <n>] [--rects] [--offscreen] [--out-dir <dir>] [--label <name>]
//! somniq-computer-probe act --hwnd <h> --ref <n> --expect-name <text>
//!     (--invoke | --toggle | --set-value <text>)
//! ```
//!
//! stdout is one JSON document. It carries measurements, classes and process
//! names but no window titles (unless `--show-titles`) and no element text:
//! rendered trees go only to `--out-dir`, so a probe run does not by itself
//! copy screen content anywhere.

#[cfg(not(windows))]
fn main() {
    eprintln!("somniq-computer-probe: Windows only in R0");
    std::process::exit(2);
}

#[cfg(windows)]
fn main() {
    std::process::exit(windows_main::run(std::env::args().skip(1).collect()));
}

#[cfg(windows)]
mod windows_main {
    use std::path::PathBuf;
    use std::time::Duration;

    use computer::platform::windows::{
        act_on_fixture, enable_per_monitor_dpi, input_state, list_windows, snapshot,
        window_info, Action, ProbeError, Strategy, WalkLimits, WindowInfo,
    };
    use computer::snapshot::{render, stats, Filter, RenderOptions};
    use serde_json::{json, Value};

    struct Args {
        command: String,
        flags: Vec<(String, Option<String>)>,
    }

    const SWITCHES: &[&str] = &[
        "--show-titles",
        "--rects",
        "--offscreen",
        "--invoke",
        "--toggle",
    ];

    impl Args {
        fn parse(raw: Vec<String>) -> Result<Self, String> {
            let mut items = raw.into_iter();
            let command = items.next().ok_or("missing command")?;
            let mut flags = Vec::new();
            while let Some(flag) = items.next() {
                if !flag.starts_with("--") {
                    return Err(format!("unexpected argument {flag:?}"));
                }
                if SWITCHES.contains(&flag.as_str()) {
                    flags.push((flag, None));
                } else {
                    let value = items.next().ok_or(format!("{flag} needs a value"))?;
                    flags.push((flag, Some(value)));
                }
            }
            Ok(Self { command, flags })
        }

        fn has(&self, name: &str) -> bool {
            self.flags.iter().any(|(flag, _)| flag == name)
        }

        fn get(&self, name: &str) -> Option<&str> {
            self.flags
                .iter()
                .find(|(flag, _)| flag == name)
                .and_then(|(_, value)| value.as_deref())
        }

        fn number(&self, name: &str, default: usize) -> Result<usize, String> {
            self.get(name).map_or(Ok(default), |value| {
                value
                    .parse()
                    .map_err(|_| format!("{name} expects a number, got {value:?}"))
            })
        }

        fn hwnd(&self) -> Result<isize, String> {
            let raw = self.get("--hwnd").ok_or("--hwnd is required")?;
            let parsed = raw.strip_prefix("0x").map_or_else(
                || raw.parse::<isize>(),
                |hex| isize::from_str_radix(hex, 16),
            );
            parsed.map_err(|_| format!("--hwnd expects decimal or 0x hex, got {raw:?}"))
        }
    }

    pub fn run(raw: Vec<String>) -> i32 {
        enable_per_monitor_dpi();
        let result = Args::parse(raw).and_then(|args| match args.command.as_str() {
            "list" => Ok(list(&args)),
            "find" => find(&args),
            "snapshot" => snapshot_command(&args),
            "act" => act(&args),
            other => Err(format!("unknown command {other:?}")),
        });
        match result {
            Ok(Outcome::Ok(value)) => {
                print(&value);
                0
            }
            Ok(Outcome::ProbeFailed(error)) => {
                print(&json!({ "ok": false, "error": error }));
                3
            }
            Err(usage) => {
                eprintln!("usage error: {usage}");
                2
            }
        }
    }

    enum Outcome {
        Ok(Value),
        ProbeFailed(ProbeError),
    }

    fn print(value: &Value) {
        println!(
            "{}",
            serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
        );
    }

    fn window_json(window: &WindowInfo, show_title: bool) -> Value {
        let title = if show_title {
            json!(window.title)
        } else {
            json!(format!("<标题已隐藏，{} 字>", window.title.chars().count()))
        };
        json!({
            "hwnd": format!("{:#x}", window.hwnd),
            "pid": window.pid,
            "exe": window.exe_name,
            "class": window.class_name,
            "title": title,
            "rect": window.rect,
            "minimized": window.minimized,
            "dpi": window.dpi,
            "foreground": window.foreground,
            "tier": window.classification.tier,
            "tierReason": window.classification.reason,
        })
    }

    fn list(args: &Args) -> Outcome {
        let show = args.has("--show-titles");
        let started = std::time::Instant::now();
        let list = list_windows();
        let elapsed_ms = started.elapsed().as_secs_f64() * 1_000.0;
        Outcome::Ok(json!({
            "ok": true,
            "elapsedMs": elapsed_ms,
            "windows": list.windows.iter().map(|window| window_json(window, show)).collect::<Vec<_>>(),
            "hiddenByPolicy": list.hidden_by_policy,
            "skippedInvisible": list.skipped_invisible,
            "skippedCloaked": list.skipped_cloaked,
            "skippedToolWindows": list.skipped_tool_windows,
        }))
    }

    fn find(args: &Args) -> Result<Outcome, String> {
        let exe = args.get("--exe").ok_or("--exe is required")?.to_lowercase();
        let needle = args.get("--title-contains");
        let show = args.has("--show-titles");
        let matches: Vec<Value> = list_windows()
            .windows
            .iter()
            .filter(|window| window.exe_name == exe)
            .filter(|window| needle.is_none_or(|needle| window.title.contains(needle)))
            .map(|window| window_json(window, show))
            .collect();
        Ok(Outcome::Ok(json!({ "ok": true, "matches": matches })))
    }

    fn limits(args: &Args) -> Result<WalkLimits, String> {
        let defaults = WalkLimits::default();
        let deadline_ms = args.number(
            "--deadline-ms",
            usize::try_from(defaults.deadline.as_millis()).unwrap_or(20_000),
        )?;
        Ok(WalkLimits {
            max_depth: args.number("--max-depth", defaults.max_depth)?,
            max_elements: args.number("--max-elements", defaults.max_elements)?,
            deadline: Duration::from_millis(u64::try_from(deadline_ms).unwrap_or(20_000)),
            transaction_timeout_ms: u32::try_from(args.number(
                "--txn-timeout-ms",
                usize::try_from(defaults.transaction_timeout_ms).unwrap_or(5_000),
            )?)
            .unwrap_or(5_000),
            value_cap_chars: defaults.value_cap_chars,
            max_values: defaults.max_values,
        })
    }

    fn snapshot_command(args: &Args) -> Result<Outcome, String> {
        let hwnd = args.hwnd()?;
        let limits = limits(args)?;
        let strategies = match args.get("--strategy").unwrap_or("both") {
            "walker" => vec![Strategy::Walker],
            "subtree" => vec![Strategy::Subtree],
            "both" => vec![Strategy::Walker, Strategy::Subtree],
            other => return Err(format!("unknown --strategy {other:?}")),
        };
        let repeat = args.number("--repeat", 3)?.max(1);
        let render_base = RenderOptions {
            max_chars: args.number("--max-chars", RenderOptions::default().max_chars)?,
            include_rects: args.has("--rects"),
            include_offscreen: args.has("--offscreen"),
            ..RenderOptions::default()
        };
        let out_dir = args.get("--out-dir").map(PathBuf::from);
        let label = args.get("--label").unwrap_or("window").to_string();
        let Some(window) = window_info(hwnd) else {
            return Ok(Outcome::ProbeFailed(ProbeError {
                code: "WINDOW_GONE",
                message: format!("{hwnd:#x}"),
            }));
        };

        let before = input_state();
        let mut runs = Vec::new();
        for strategy in strategies {
            let mut timings = Vec::new();
            let mut last = None;
            for _ in 0..repeat {
                match snapshot(hwnd, strategy, limits) {
                    Ok(outcome) => {
                        timings.push(json!({
                            "fetchMs": outcome.fetch_ms,
                            "convertMs": outcome.convert_ms,
                            "elements": outcome.elements,
                            "crossProcessCalls": outcome.cross_process_calls,
                            "stoppedBy": outcome.stopped_by,
                        }));
                        last = Some(outcome);
                    }
                    Err(error) => return Ok(Outcome::ProbeFailed(error)),
                }
            }
            let Some(outcome) = last else { continue };
            let prefix = out_dir.as_ref().map(|dir| {
                let strategy_name = match strategy {
                    Strategy::Walker => "walker",
                    Strategy::Subtree => "subtree",
                };
                dir.join(format!("{label}-{strategy_name}"))
            });
            let views = render_views(&outcome.root, &render_base, prefix.as_deref())?;
            runs.push(json!({
                "strategy": strategy,
                "timings": timings,
                "stats": stats(&outcome.root),
                "views": views,
            }));
        }
        let after = input_state();
        Ok(Outcome::Ok(json!({
            "ok": true,
            "window": window_json(&window, false),
            "limits": {
                "maxDepth": limits.max_depth,
                "maxElements": limits.max_elements,
                "deadlineMs": limits.deadline.as_millis(),
                "transactionTimeoutMs": limits.transaction_timeout_ms,
            },
            "runs": runs,
            "inputBefore": before,
            "inputAfter": after,
            "foregroundChanged": before.foreground_hwnd != after.foreground_hwnd,
            "cursorMoved": before.cursor != after.cursor,
        })))
    }

    /// Renders both filters; with `prefix`, also writes `<prefix>-<view>.txt`
    /// and `<prefix>-tree.json` (these hold screen content, so they go only
    /// where the caller pointed).
    fn render_views(
        root: &computer::snapshot::Node,
        base: &RenderOptions,
        prefix: Option<&std::path::Path>,
    ) -> Result<Value, String> {
        let write = |suffix: &str, body: &str| -> Result<(), String> {
            let Some(prefix) = prefix else { return Ok(()) };
            let path = PathBuf::from(format!("{}-{suffix}", prefix.display()));
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|error| format!("create {}: {error}", dir.display()))?;
            }
            std::fs::write(&path, body).map_err(|error| format!("write {}: {error}", path.display()))
        };
        let mut views = serde_json::Map::new();
        for (filter, name) in [(Filter::Interactive, "interactive"), (Filter::All, "all")] {
            let rendered = render(root, &RenderOptions { filter, ..*base });
            write(&format!("{name}.txt"), &rendered.text)?;
            views.insert(
                name.to_string(),
                json!({
                    "shown": rendered.shown,
                    "eligible": rendered.eligible,
                    "hiddenOffscreen": rendered.hidden_offscreen,
                    "truncated": rendered.truncated,
                    "chars": rendered.chars,
                    "approxTokens": rendered.approx_tokens,
                }),
            );
        }
        write(
            "tree.json",
            &serde_json::to_string_pretty(root).unwrap_or_default(),
        )?;
        Ok(Value::Object(views))
    }

    fn act(args: &Args) -> Result<Outcome, String> {
        let hwnd = args.hwnd()?;
        let reference = args.number("--ref", 0)?;
        let expected = args
            .get("--expect-name")
            .ok_or("--expect-name is required")?;
        let action = if args.has("--invoke") {
            Action::Invoke
        } else if args.has("--toggle") {
            Action::Toggle
        } else if let Some(text) = args.get("--set-value") {
            Action::SetValue(text.to_string())
        } else {
            return Err("one of --invoke, --toggle, --set-value is required".to_string());
        };
        let limits = limits(args)?;
        let before = input_state();
        let result = act_on_fixture(hwnd, reference, expected, action, limits);
        let after = input_state();
        // Effects of an action can land asynchronously on the target's UI
        // thread; sample again after a short settle.
        std::thread::sleep(Duration::from_millis(300));
        let settled = input_state();
        Ok(match result {
            Ok(report) => Outcome::Ok(json!({
                "ok": true,
                "report": report,
                "inputBefore": before,
                "inputAfter": after,
                "inputSettled": settled,
                "foregroundChanged": before.foreground_hwnd != settled.foreground_hwnd,
                "cursorMoved": before.cursor != settled.cursor,
            })),
            Err(error) => Outcome::ProbeFailed(error),
        })
    }
}
