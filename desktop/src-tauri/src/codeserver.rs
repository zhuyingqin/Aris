//! Embedded VS Code runtime for the Code page.
//!
//! The Code page renders a real VSCodium workbench (`reh-web`, MIT) so users
//! can install extensions from Open VSX. This module owns everything below the
//! UI: resolving, downloading and verifying the runtime, launching the server
//! on loopback, and tearing it down.
//!
//! Four constraints shape the code, all of them measured rather than assumed:
//!
//! * **The workbench must be addressed as `http://code.tauri.localhost:<port>`,
//!   never `http://127.0.0.1:<port>`.** The server hands its connection token
//!   back as `Set-Cookie: vscode-tkn=…; SameSite=Lax` and immediately redirects
//!   `/?tkn=…` to `/`, so a *cross-site* iframe never replays the cookie and
//!   every request after the redirect is 403. Chromium treats `localhost` as a
//!   public suffix, which puts `code.tauri.localhost` and Tauri's own
//!   `tauri.localhost` on one site — the cookie flows and the iframe works. A
//!   sibling name like `aris-code.localhost` is a *different* site and fails.
//! * **The sub-domain label must not be `tauri`.** wry filters WebView2 traffic
//!   with the prefix `http://tauri.` and routes anything matching into Tauri's
//!   custom-protocol handler, so `http://tauri.code.localhost` would never
//!   reach us. `http://code.tauri.localhost` starts with `http://code.` and is
//!   left alone.
//! * **The server stays bound to loopback.** It does not validate the `Host`
//!   header — every `*.localhost` name is served — so the bind address is the
//!   only real boundary. `--without-connection-token` is never an option:
//!   WebSockets are not subject to CORS, so any web page could connect and get
//!   local code execution.
//! * **Extensions and settings live outside the version directory**, so
//!   upgrading the runtime does not throw away what the user installed.
//!
//! The Windows release bundles the runtime so users do not need a first-use
//! network fetch. Development builds and packages produced without the
//! generated resource still fall back to a verified download; see
//! [`bundled_archive`]. At ~56 MB compressed it is a deliberate installer-size
//! tradeoff, but it keeps the shipped Windows app usable offline.
//!
//! A freshly extracted runtime is also patched (see [`PATCHES`]): the web
//! workbench bakes both its product name and its startup-editor default into
//! `workbench.js`, and neither can be reached through configuration.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc::{sync_channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

/// Pinned VSCodium release. Bump together with [`expected_sha256`].
const RUNTIME_VERSION: &str = "1.126.04524";

/// Event carrying [`CodeServerStatus`] as the runtime downloads and starts.
const STATUS_EVENT: &str = "code-server-status";

/// Host the workbench is served under in a packaged build, where the app
/// itself is `tauri.localhost`. See the module docs: this is load bearing, not
/// cosmetic.
const CODE_HOST: &str = "code.tauri.localhost";

/// Pick the host the workbench must be addressed by, given the origin the app
/// is *actually* running on.
///
/// A packaged Windows build serves the UI from `tauri.localhost`, so the
/// workbench goes under `code.tauri.localhost` and the two are same-site.
/// `tauri dev` serves it from `127.0.0.1:1420` instead — and
/// `code.tauri.localhost` is cross-site from there, which drops the token
/// cookie and turns the Code page into a 403 that only appears in development.
/// Following the app's own hostname keeps both cases same-site.
fn workbench_host(app_host: Option<&str>) -> String {
    let host = app_host.map(str::trim).filter(|host| !host.is_empty());
    match host {
        // Loopback literals are their own site; reuse them verbatim.
        Some(host) if host == "127.0.0.1" || host == "localhost" || host == "[::1]" => {
            host.to_string()
        }
        // `a.localhost` and `code.a.localhost` share the registrable domain.
        Some(host) if host.ends_with(".localhost") && !host.starts_with("code.") => {
            format!("code.{host}")
        }
        Some(host) if host.starts_with("code.") && host.ends_with(".localhost") => host.to_string(),
        _ => CODE_HOST.to_string(),
    }
}

/// How long to wait for the server to report the port it bound.
const START_TIMEOUT: Duration = Duration::from_secs(90);

/// Port range the workbench is served from, lowest free port wins.
///
/// **The port has to be stable across restarts.** The web workbench keeps user
/// settings, the colour theme and all UI state in browser storage
/// (`vscode-web-db` in IndexedDB), which is scoped to the *origin* — and an
/// origin includes the port. Handing out an ephemeral port would silently
/// reset the user's editor every time the app restarted. A narrow range keeps
/// the same port in practice while still surviving a collision; only then does
/// stored state reset.
const PORT_RANGE: &str = "52411-52430";

/// Progress events are coalesced to this granularity so a 100 MB download does
/// not flood the UI with thousands of emits.
const PROGRESS_STEP_BYTES: u64 = 2 * 1024 * 1024;

/// Upper bound on a single download attempt.
///
/// `reqwest` 0.12's *blocking* builder exposes no per-read timeout (only the
/// async one does), so this whole-request cap is the only thing standing
/// between a half-open socket and an install that hangs forever. It is sized
/// to tolerate a genuinely slow link — 103 MB in an hour is ~29 KB/s — because
/// the responsive escape hatch is [`code_server_stop`], not the clock.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    /// Nothing is running. Says nothing about whether the runtime is on disk —
    /// that is [`CodeServerStatus::installed`], read from the filesystem.
    #[default]
    Idle,
    Downloading,
    Extracting,
    /// Pulling the default extension set from Open VSX, first run only.
    Extensions,
    Starting,
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeServerStatus {
    pub phase: Phase,
    pub version: String,
    pub installed: bool,
    pub port: Option<u16>,
    /// Full workbench URL including the connection token, ready for an iframe.
    /// `None` until the server is [`Phase::Ready`].
    pub url: Option<String>,
    /// Human-readable failure reason, only set for [`Phase::Failed`].
    pub message: Option<String>,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

#[derive(Default)]
struct Inner {
    phase: Phase,
    /// Set while an install/launch is in flight. Without it, a double-invoked
    /// `code_server_ensure` — which React makes easy — would race two
    /// downloads into the same staging directory and leave two servers running.
    busy: bool,
    /// Raised by [`code_server_stop`] so a long download can be abandoned. The
    /// download loop checks it between chunks; without it a stalled fetch would
    /// hold `busy` until the app restarts and every retry would be refused.
    cancel: bool,
    child: Option<Child>,
    guard: Option<runtime::ManagedProcessGuard>,
    pid: Option<u32>,
    port: Option<u16>,
    token: String,
    folder: Option<String>,
    /// Host the workbench is addressed by, derived from the app's own origin.
    host: String,
    message: Option<String>,
    downloaded_bytes: u64,
    total_bytes: u64,
}

impl Inner {
    fn status(&self) -> CodeServerStatus {
        CodeServerStatus {
            phase: self.phase,
            version: RUNTIME_VERSION.to_string(),
            installed: is_installed(&version_dir()),
            port: self.port,
            url: match (self.phase, self.port) {
                // Routed through `workbench_host` again so a state that never
                // went through `ensure` cannot produce `http://:<port>/`.
                (Phase::Ready, Some(port)) => Some(workbench_url(
                    port,
                    &self.token,
                    self.folder.as_deref(),
                    &workbench_host(Some(&self.host)),
                )),
                _ => None,
            },
            message: self.message.clone(),
            downloaded_bytes: self.downloaded_bytes,
            total_bytes: self.total_bytes,
        }
    }

    /// Notice a server that died on its own.
    ///
    /// Nothing pushes us that news: the child is reaped here or not at all, so
    /// without this the UI would keep pointing an iframe at a dead port and
    /// show a blank pane with no way to tell why.
    fn poll_liveness(&mut self) {
        if self.phase != Phase::Ready {
            return;
        }
        let exited = match self.child.as_mut() {
            Some(child) => child.try_wait().ok().flatten(),
            // Ready with no child at all is already inconsistent.
            None => {
                self.phase = Phase::Failed;
                self.message = Some("VS Code server is no longer running".to_string());
                self.port = None;
                return;
            }
        };
        if let Some(status) = exited {
            self.phase = Phase::Failed;
            self.message = Some(format!("VS Code server exited unexpectedly ({status})"));
            self.port = None;
            if let Some(pid) = self.pid.take() {
                runtime::terminate_managed_process_tree(pid);
                runtime::unregister_managed_process(pid);
            }
            self.child = None;
            self.guard = None;
        }
    }

    /// Kill the server and everything it forked (extension host, pty host).
    fn shutdown(&mut self) {
        if let Some(pid) = self.pid.take() {
            runtime::terminate_managed_process_tree(pid);
            runtime::unregister_managed_process(pid);
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        self.guard = None;
        self.port = None;
        self.token.clear();
        self.phase = Phase::Idle;
    }
}

/// App-managed handle to the single embedded VS Code server.
#[derive(Clone)]
pub struct CodeServerState(Arc<Mutex<Inner>>);

impl Default for CodeServerState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Inner::default())))
    }
}

impl CodeServerState {
    fn handle(&self) -> Arc<Mutex<Inner>> {
        self.0.clone()
    }
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/// VSCodium's platform slug for the current build target.
fn target_slug() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("win32-x64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

/// Published SHA-256 of the `reh-web` tarball for `slug`, taken from
/// VSCodium's own `.sha256` sidecars for [`RUNTIME_VERSION`]. A download that
/// does not match is discarded — there is no "skip verification" path.
fn expected_sha256(slug: &str) -> Option<&'static str> {
    match slug {
        "win32-x64" => Some("43f15c8e5c95b795d6eb72a62095498d901ee633938cb3f8297256192062b333"),
        "darwin-x64" => Some("c3cbece13b47c748be8ac64c773471a20fcb809ae8de0188abcd949cb0ef49c4"),
        "darwin-arm64" => Some("bd587280e1d29113ff73f67438571853536b88f6af5bc58e59a16010ce1c9734"),
        "linux-x64" => Some("9964a8b66431dced583a820d60a852a7995c86607c4c983152adc7a5c876d60d"),
        "linux-arm64" => Some("c6181d32dda122df3bba7ad6e9194ded2dc3dd1204c1f8b142f4440f4e4e2ce4"),
        _ => None,
    }
}

fn asset_name(slug: &str) -> String {
    format!("vscodium-reh-web-{slug}-{RUNTIME_VERSION}.tar.gz")
}

/// Where to fetch the runtime, most-preferred first.
///
/// `ARIS_CODE_RUNTIME_URL` short-circuits everything (used by tests and by
/// air-gapped installs). Otherwise our own mirror is tried before GitHub:
/// pulling 103 MB from a GitHub release is slow from mainland China. A source
/// only counts as successful after its bytes pass the pinned SHA-256 gate;
/// this matters because a missing mirror route can return the SomniQ website
/// with HTTP 200 instead of returning a transport error.
fn download_urls(slug: &str) -> Vec<String> {
    if let Ok(url) = std::env::var("ARIS_CODE_RUNTIME_URL") {
        if !url.trim().is_empty() {
            return vec![url];
        }
    }
    let asset = asset_name(slug);
    vec![
        format!("https://somni.chat/runtime/vscodium/{RUNTIME_VERSION}/{asset}"),
        format!("https://github.com/VSCodium/vscodium/releases/download/{RUNTIME_VERSION}/{asset}"),
    ]
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Root for every runtime version plus the shared user state.
///
/// `ARIS_CODE_RUNTIME_DIR` overrides it so tests never touch the real profile.
fn install_root() -> PathBuf {
    if let Some(dir) = std::env::var_os("ARIS_CODE_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(runtime::home_dir()).join(".local/share"));
    base.join("com.aris.studio").join("code")
}

fn version_dir() -> PathBuf {
    install_root().join(RUNTIME_VERSION)
}

/// Extensions the user installed. Deliberately a sibling of the version
/// directory: upgrading the runtime must not uninstall anything.
fn extensions_dir() -> PathBuf {
    install_root().join("extensions")
}

/// Server-side profile state — same reasoning as [`extensions_dir`].
///
/// Note this is *not* where user settings end up: the web workbench keeps
/// those in browser storage, keyed by origin. See [`PORT_RANGE`].
fn server_data_dir() -> PathBuf {
    install_root().join("server-data")
}

fn node_binary(dir: &Path) -> PathBuf {
    if cfg!(windows) {
        dir.join("node.exe")
    } else {
        dir.join("node")
    }
}

fn server_entry(dir: &Path) -> PathBuf {
    dir.join("out").join("server-main.js")
}

/// Written only after a verified archive has been fully extracted, so a crash
/// mid-install leaves the directory looking uninstalled instead of subtly
/// broken.
fn marker_path(dir: &Path) -> PathBuf {
    dir.join(".aris-installed")
}

/// A runtime counts as installed only when the marker matches the pinned
/// checksum *and* the two files we actually launch are present.
fn is_installed(dir: &Path) -> bool {
    let Some(expected) = target_slug().and_then(expected_sha256) else {
        return false;
    };
    let Ok(marker) = std::fs::read_to_string(marker_path(dir)) else {
        return false;
    };
    marker.trim() == expected && node_binary(dir).is_file() && server_entry(dir).is_file()
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/// The server announces its listening port on stdout as
/// `Server bound to 127.0.0.1:39217 (IPv4)`. We start it with `--port 0` and
/// read the port back rather than guessing a free one and racing for it.
fn parse_bound_port(line: &str) -> Option<u16> {
    let rest = line.split("Server bound to").nth(1)?;
    let after_colon = rest.rsplit(':').next()?;
    let digits: String = after_colon
        .trim()
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// Convert a native path into the form the web workbench's `folder` parameter
/// expects: a URI path, so `C:\Users\wt\p` becomes `/c:/Users/wt/p`.
///
/// Passing the native Windows path instead **silently loses the drive letter**
/// — the workbench opens with a title of `\Users\wt\p` and an explorer that
/// cannot resolve anything, which looks like an empty workspace rather than an
/// error. Measured against the shipped runtime; the same shape appears in the
/// server's own `vscode-remote-resource?path=` requests.
fn folder_uri_path(path: &str) -> String {
    let forward = path.replace('\\', "/");
    let mut chars = forward.chars();
    let drive = chars.next();
    let colon = chars.next();
    if let (Some(drive), Some(':')) = (drive, colon) {
        if drive.is_ascii_alphabetic() {
            return format!("/{}{}", drive.to_ascii_lowercase(), &forward[1..]);
        }
    }
    forward
}

/// Workbench URL for the iframe. `folder` is the workspace to open; it is
/// percent-encoded because a path is full of `/` and `:`.
fn workbench_url(port: u16, token: &str, folder: Option<&str>, host: &str) -> String {
    let mut url = format!("http://{host}:{port}/?tkn={token}");
    if let Some(folder) = folder.filter(|f| !f.trim().is_empty()) {
        url.push_str("&folder=");
        url.push_str(&urlencoding::encode(&folder_uri_path(folder)));
    }
    url
}

/// 32 hex characters from the OS CSPRNG. Short enough for a URL, long enough
/// that guessing it is not a threat model.
fn random_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/// Where progress goes. Keeping this behind a trait means the whole
/// download → verify → extract → launch pipeline runs without an `AppHandle`,
/// so it can be exercised end to end from a test instead of only through a
/// packaged app.
pub trait StatusSink: Send + Sync {
    fn emit(&self, status: &CodeServerStatus);
}

impl StatusSink for AppHandle {
    fn emit(&self, status: &CodeServerStatus) {
        let _ = Emitter::emit(self, STATUS_EVENT, status);
    }
}

/// Drives the pipeline without a UI attached.
#[cfg(test)]
pub struct SilentSink;

#[cfg(test)]
impl StatusSink for SilentSink {
    fn emit(&self, _status: &CodeServerStatus) {}
}

fn set_phase(
    sink: &dyn StatusSink,
    inner: &Arc<Mutex<Inner>>,
    phase: Phase,
    message: Option<String>,
) {
    let status = {
        let Ok(mut guard) = inner.lock() else {
            return;
        };
        guard.phase = phase;
        guard.message = message;
        guard.status()
    };
    sink.emit(&status);
}

/// Stream `url` to `dest`, hashing as we go so the archive is never read twice.
/// Returns the hex digest.
fn download_to(
    sink: &dyn StatusSink,
    inner: &Arc<Mutex<Inner>>,
    url: &str,
    dest: &Path,
) -> Result<String, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(DOWNLOAD_TIMEOUT)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| format!("build http client: {err}"))?;
    let mut response = client
        .get(url)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|err| format!("GET {url}: {err}"))?;

    let total = response.content_length().unwrap_or(0);
    let mut file =
        std::fs::File::create(dest).map_err(|err| format!("create {}: {err}", dest.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 128 * 1024];
    let mut written: u64 = 0;
    let mut last_emit: u64 = 0;

    loop {
        let read = response
            .read(&mut buf)
            .map_err(|err| format!("read body: {err}"))?;
        if read == 0 {
            break;
        }
        if inner.lock().map(|guard| guard.cancel).unwrap_or(false) {
            return Err("download cancelled".to_string());
        }
        hasher.update(&buf[..read]);
        file.write_all(&buf[..read])
            .map_err(|err| format!("write {}: {err}", dest.display()))?;
        written += read as u64;

        if written - last_emit >= PROGRESS_STEP_BYTES {
            last_emit = written;
            let status = {
                let Ok(mut guard) = inner.lock() else {
                    continue;
                };
                guard.downloaded_bytes = written;
                guard.total_bytes = total;
                guard.status()
            };
            sink.emit(&status);
        }
    }
    file.flush().map_err(|err| format!("flush: {err}"))?;
    Ok(hex_digest(hasher))
}

fn hex_digest(hasher: Sha256) -> String {
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Download the first candidate whose bytes match `expected`.
///
/// A successful HTTP status is not enough: reverse proxies and SPA fallbacks
/// commonly answer a missing artifact route with a small HTML page and 200.
/// Verify each candidate inside the fallback loop so such a response cannot
/// prevent the next (usually GitHub) source from being tried.
fn download_verified_to(
    sink: &dyn StatusSink,
    inner: &Arc<Mutex<Inner>>,
    urls: &[String],
    dest: &Path,
    expected: &str,
) -> Result<(), String> {
    let mut last_error = "no runtime download source was configured".to_string();
    for url in urls {
        match download_to(sink, inner, url, dest) {
            Ok(digest) if digest == expected => return Ok(()),
            Ok(digest) => {
                let _ = std::fs::remove_file(dest);
                last_error = format!("checksum mismatch: expected {expected}, got {digest}");
            }
            Err(error) => last_error = format!("download failed: {error}"),
        }
        // A user-requested stop must not fall through to the next mirror.
        if inner.lock().map(|guard| guard.cancel).unwrap_or(false) {
            break;
        }
    }
    Err(last_error)
}

/// Extract the tarball into `dest`. The VSCodium tarball has no leading
/// component, so entries land directly under `dest`.
///
/// Both compressed and plain tars are accepted: the downloaded asset is
/// VSCodium's own `.tar.gz`, while the optional bundled copy ships as a plain
/// `.tar` so the installer's own LZMA does the compression instead of paying
/// for an already-gzipped payload twice.
fn extract_tarball(archive: &Path, dest: &Path) -> Result<(), String> {
    let file =
        std::fs::File::open(archive).map_err(|err| format!("open {}: {err}", archive.display()))?;
    let reader = std::io::BufReader::new(file);
    let gzipped = archive
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("gz"));
    if gzipped {
        unpack(tar::Archive::new(flate2::read::GzDecoder::new(reader)), dest)
    } else {
        unpack(tar::Archive::new(reader), dest)
    }
}

fn unpack<R: std::io::Read>(mut tar: tar::Archive<R>, dest: &Path) -> Result<(), String> {
    tar.set_overwrite(true);
    // Windows has no meaningful unix mode bits and applying them fails on some
    // volumes; the launcher only needs the files to exist.
    tar.set_preserve_permissions(!cfg!(windows));
    tar.unpack(dest)
        .map_err(|err| format!("extract into {}: {err}", dest.display()))
}

/// The file carrying the workbench's baked-in product identity.
fn workbench_bundle(dir: &Path) -> PathBuf {
    dir.join("out")
        .join("vs")
        .join("code")
        .join("browser")
        .join("workbench")
        .join("workbench.js")
}

/// A literal substitution in the compiled workbench.
pub(crate) struct Patch {
    /// Narrows the search to the text right after this marker. `None` replaces
    /// every occurrence in the file.
    ///
    /// Needed for values that are not unique on their own: there are many
    /// `default:"welcomePage"` in a 17 MB bundle, and only the one inside the
    /// `workbench.startupEditor` schema may be touched.
    pub(crate) anchor: Option<&'static str>,
    pub(crate) find: &'static str,
    pub(crate) replace: &'static str,
}

/// How far past an anchor to look. The schema entry it scopes is ~400 bytes;
/// a bound this tight means a shifted anchor misses rather than corrupting
/// some unrelated setting further down the bundle.
const ANCHOR_WINDOW: usize = 1024;

/// Substitutions applied to a freshly extracted runtime.
///
/// The *web* workbench cannot be reconfigured for the branding or startup
/// behavior below through the normal app settings before the bundle loads;
/// each substitution was measured against the shipped runtime rather than
/// assumed:
///
/// * The product name is a literal compiled into `workbench.js`. `product.json`
///   is not consulted for it (the server forwards only `embedderIdentifier` and
///   `extensionsGallery` into the page), and the `_VSCODE_PRODUCT_JSON` global
///   that would override it is undefined in a browser.
/// * The startup editor *can* be set from the extension host, but not in time:
///   the welcome page is already open before an `onStartupFinished` extension
///   runs, and closing it there loses a race with the workbench's own restore
///   pass, which paints the stock page back over the top. Changing the schema
///   default means it never opens, with no flicker and nothing to race. A user
///   who sets `workbench.startupEditor` explicitly still overrides this.
/// * Workspace Trust is deliberately kept enabled. The web workbench's default
///   startup prompt is `never`, which leaves an untrusted folder in Restricted
///   Mode behind a small banner that is easy to miss. Changing that default to
///   `always` makes the workbench ask for an explicit trust decision whenever a
///   new untrusted folder is opened. An explicit user setting still wins.
pub(crate) const PATCHES: &[Patch] = &[
    Patch {
        anchor: None,
        find: r#"nameShort:"VSCodium",nameLong:"VSCodium""#,
        replace: r#"nameShort:"SomniQ Code",nameLong:"SomniQ Code""#,
    },
    Patch {
        anchor: Some(r#""workbench.startupEditor":{"#),
        find: r#"default:"welcomePage""#,
        replace: r#"default:"none""#,
    },
    Patch {
        // `rbi` is the minified variable used for
        // `security.workspace.trust.startupPrompt` in the schema below.
        anchor: Some(r#"[rbi]:{type:"string","#),
        find: r#"default:"never""#,
        replace: r#"default:"always""#,
    },
];

/// Apply one patch to `body`, returning whether it matched.
pub(crate) fn apply_patch(body: &mut String, patch: &Patch) -> bool {
    let Some(anchor) = patch.anchor else {
        if !body.contains(patch.find) {
            return false;
        }
        *body = body.replace(patch.find, patch.replace);
        return true;
    };

    let Some(start) = body.find(anchor).map(|at| at + anchor.len()) else {
        return false;
    };
    let mut end = (start + ANCHOR_WINDOW).min(body.len());
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    let Some(offset) = body[start..end].find(patch.find) else {
        return false;
    };
    let at = start + offset;
    body.replace_range(at..at + patch.find.len(), patch.replace);
    true
}

/// Apply [`PATCHES`] to an extracted runtime, returning how many matched.
///
/// A miss is *not* an error: it means a newer VSCodium minified that literal
/// differently, and an editor that still says "VSCodium" is much better than
/// refusing to install one. The e2e test asserts against the real bundle, so a
/// version bump fails there rather than silently regressing in front of users.
fn patch_workbench(dir: &Path) -> Result<usize, String> {
    let path = workbench_bundle(dir);
    let mut body = std::fs::read_to_string(&path)
        .map_err(|err| format!("read {}: {err}", path.display()))?;
    let applied = PATCHES
        .iter()
        .filter(|patch| apply_patch(&mut body, patch))
        .count();
    if applied > 0 {
        std::fs::write(&path, body).map_err(|err| format!("write {}: {err}", path.display()))?;
    }
    Ok(applied)
}

/// Name of the plain tar an offline build drops into the app's resources.
fn bundled_asset_name(slug: &str) -> String {
    format!("vscodium-reh-web-{slug}-{RUNTIME_VERSION}.tar")
}

/// The bundled runtime, if this build shipped one.
///
/// The Windows release bundles this archive. A development build or an
/// installer produced without the generated resource falls back to the
/// verified download path below. The pinned version is identical either way,
/// so the installed runtime is deterministic.
fn bundled_archive(resource_dir: Option<&Path>) -> Option<PathBuf> {
    let slug = target_slug()?;
    let path = resource_dir?
        .join("code")
        .join(RUNTIME_VERSION)
        .join(bundled_asset_name(slug));
    path.is_file().then_some(path)
}

/// Acquire + extract + rebrand, atomically: everything happens in a scratch
/// directory that is only renamed into place once the source was trusted and
/// the launch entry points exist.
fn install(
    sink: &dyn StatusSink,
    inner: &Arc<Mutex<Inner>>,
    resource_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let slug = target_slug()
        .ok_or_else(|| "no VS Code runtime is published for this platform".to_string())?;
    let expected =
        expected_sha256(slug).ok_or_else(|| format!("no pinned checksum for target {slug}"))?;

    let target = version_dir();
    if is_installed(&target) {
        return Ok(target);
    }

    let root = install_root();
    std::fs::create_dir_all(&root).map_err(|err| format!("create {}: {err}", root.display()))?;
    let staging = root.join(format!("{RUNTIME_VERSION}.staging"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|err| format!("create {}: {err}", staging.display()))?;

    // A bundled copy arrived inside our own signed installer, so it is not
    // re-verified against the download checksum — it is a different artifact
    // (plain tar, not VSCodium's gzip) and the installer is the trust anchor.
    // The extracted tree is still checked below, exactly as a download is.
    let archive = match bundled_archive(resource_dir) {
        Some(bundled) => bundled,
        None => {
            let archive = root.join(asset_name(slug));
            set_phase(sink, inner, Phase::Downloading, None);
            let urls = download_urls(slug);
            download_verified_to(sink, inner, &urls, &archive, expected)?;
            archive
        }
    };

    set_phase(sink, inner, Phase::Extracting, None);
    extract_tarball(&archive, &staging)?;

    if !node_binary(&staging).is_file() || !server_entry(&staging).is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("extracted runtime is missing node or out/server-main.js".to_string());
    }
    match patch_workbench(&staging) {
        // Cosmetic. An editor that says VSCodium still works.
        Ok(applied) if applied < PATCHES.len() => eprintln!(
            "[codeserver] only {applied} of {} workbench patches matched in {RUNTIME_VERSION}",
            PATCHES.len()
        ),
        Ok(_) => {}
        Err(error) => eprintln!("[codeserver] could not patch the workbench: {error}"),
    }
    std::fs::write(marker_path(&staging), expected)
        .map_err(|err| format!("write install marker: {err}"))?;

    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&staging, &target).map_err(|err| {
        format!(
            "move {} into {}: {err}",
            staging.display(),
            target.display()
        )
    })?;
    // A downloaded archive is 100 MB of dead weight once extracted. A bundled
    // one belongs to the installation and is left for the uninstaller.
    if archive.starts_with(&root) {
        let _ = std::fs::remove_file(&archive);
    }
    Ok(target)
}

// ---------------------------------------------------------------------------
// Launch
// ---------------------------------------------------------------------------

/// Arguments for `out/server-main.js`.
///
/// The server picks the lowest free port in [`PORT_RANGE`] and announces it on
/// stdout, which we read back rather than assume — a collision inside the
/// range still has to be handled.
///
/// `--user-data-dir` is deliberately absent. It looks like the place user
/// settings would live, but the *web* workbench stores them in browser
/// IndexedDB instead, and passing it only creates an empty directory that
/// nothing reads.
fn server_args(entry: &Path, token: &str) -> Vec<String> {
    vec![
        entry.to_string_lossy().into_owned(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        PORT_RANGE.into(),
        "--connection-token".into(),
        token.to_string(),
        "--extensions-dir".into(),
        extensions_dir().to_string_lossy().into_owned(),
        "--server-data-dir".into(),
        server_data_dir().to_string_lossy().into_owned(),
        "--telemetry-level".into(),
        "off".into(),
    ]
}

/// Spawn the server and block until it reports its port.
///
/// The launcher script `bin/codium-server.cmd` is bypassed on purpose: it only
/// forwards to `node.exe out/server-main.js`, and going through it would mean
/// spawning `cmd.exe` (which `CreateProcess` cannot run directly, and which
/// flashes a console window).
fn spawn_server(
    dir: &Path,
    token: &str,
    bridge: Option<(String, String)>,
) -> Result<(Child, u32, u16), String> {
    for dir in [extensions_dir(), server_data_dir()] {
        std::fs::create_dir_all(&dir).map_err(|err| format!("create {}: {err}", dir.display()))?;
    }

    let mut command: Command = runtime::hidden_command(node_binary(dir));
    command
        .args(server_args(&server_entry(dir), token))
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // The extension host inherits this, which is how `aris-code-bridge` learns
    // where to call home. There is no other bootstrap: the desktop is the only
    // side that knows both addresses.
    if let Some((url, bridge_token)) = bridge {
        command
            .env(remote_protocol::CODE_BRIDGE_URL_ENV, url)
            .env(remote_protocol::CODE_BRIDGE_TOKEN_ENV, bridge_token);
    }

    let mut child = command
        .spawn()
        .map_err(|err| format!("spawn VS Code server: {err}"))?;
    let pid = child.id();

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "server stdout unavailable".to_string())?;
    let (tx, rx) = sync_channel::<u16>(1);
    // The pipe must keep being drained after the port is found, or the server
    // blocks on a full buffer the moment it logs anything else.
    std::thread::spawn(move || {
        let mut sender = Some(tx);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let (Some(port), Some(tx)) = (parse_bound_port(&line), sender.as_ref()) {
                let _ = tx.try_send(port);
                sender = None;
            }
        }
    });
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(
            move || {
                for _ in BufReader::new(stderr).lines().map_while(Result::ok) {}
            },
        );
    }

    match rx.recv_timeout(START_TIMEOUT) {
        Ok(port) => Ok((child, pid, port)),
        Err(RecvTimeoutError::Timeout) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(format!(
                "VS Code server did not report a port within {}s",
                START_TIMEOUT.as_secs()
            ))
        }
        Err(RecvTimeoutError::Disconnected) => {
            let status = child.wait().ok();
            Err(match status {
                Some(status) => format!("VS Code server exited during startup ({status})"),
                None => "VS Code server exited during startup".to_string(),
            })
        }
    }
}

/// Confirm the HTTP surface is actually answering before telling the UI to
/// point an iframe at it. A tokenless request must be rejected — if it is not,
/// the server came up without auth and we refuse to use it.
fn health_check(port: u16) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|err| format!("build http client: {err}"))?;
    let url = format!("http://127.0.0.1:{port}/");
    let mut last = String::from("no response");
    for _ in 0..40 {
        match client.get(&url).send() {
            Ok(response) => {
                let code = response.status().as_u16();
                if code == 403 {
                    return Ok(());
                }
                if code == 200 {
                    return Err(
                        "VS Code server answered an unauthenticated request; refusing to use it"
                            .to_string(),
                    );
                }
                last = format!("unexpected status {code}");
            }
            Err(err) => last = err.to_string(),
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Err(format!("VS Code server never became healthy: {last}"))
}

/// Install if needed, then start if not already running. Idempotent: a second
/// call while the server is up only retargets the workspace folder.
/// Name of the first-party bridge extension, both in `resources/` and under
/// the extensions directory.
const BRIDGE_EXTENSION: &str = "aris-code-bridge";

/// Extensions installed from Open VSX the first time the editor runs.
///
/// Notebooks, Python and MATLAB are deliberately *not* reimplemented: the
/// official extensions exist, are MIT, and are on Open VSX, so the editor gets
/// the upstream experience — variable explorer, plot viewer, notebook
/// debugging — rather than a thinner in-house copy.
///
/// The cost of that choice is recorded in `docs/development-logic/
/// vscode-code-tab.md` §10: a notebook the user runs here has a different
/// kernel from the one Aris's `notebook_execute` tool drives, so variables do
/// not cross between them.
const DEFAULT_EXTENSIONS: &[&str] = &[
    "ms-python.python",
    "ms-toolsai.jupyter",
    // Language support only; harmless when MATLAB is not installed.
    "MathWorks.language-matlab",
];

/// Marker recording that the default set was installed, so a user who removes
/// one of them does not get it pushed back on the next launch.
fn default_extensions_marker() -> PathBuf {
    extensions_dir().join(".aris-defaults")
}

/// Install [`DEFAULT_EXTENSIONS`], once.
///
/// Failure is reported but never fatal: a network hiccup on first run must
/// leave the user with a working editor they can install into by hand, not a
/// Code page that refuses to open.
fn install_default_extensions(dir: &Path) -> Result<(), String> {
    let marker = default_extensions_marker();
    if marker.exists() {
        return Ok(());
    }
    let mut args = vec![server_entry(dir).to_string_lossy().into_owned()];
    for id in DEFAULT_EXTENSIONS {
        args.push("--install-extension".into());
        args.push((*id).into());
    }
    args.push("--extensions-dir".into());
    args.push(extensions_dir().to_string_lossy().into_owned());
    args.push("--server-data-dir".into());
    args.push(server_data_dir().to_string_lossy().into_owned());

    let output = runtime::hidden_command(node_binary(dir))
        .args(&args)
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .map_err(|err| format!("install default extensions: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "installing the default extensions failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    std::fs::write(&marker, DEFAULT_EXTENSIONS.join("\n"))
        .map_err(|err| format!("write {}: {err}", marker.display()))
}

/// Copy the bridge extension into the extensions directory.
///
/// Deliberately a plain directory copy rather than `--install-extension`: the
/// workbench loads a folder dropped into `--extensions-dir` as-is (measured
/// against the shipped runtime), so there is no `.vsix` to build and no second
/// toolchain in the desktop build.
///
/// Re-copied on every launch so an app upgrade ships a new bridge without the
/// user reinstalling anything. The user's own extensions live in sibling
/// directories and are untouched.
fn install_bridge_extension(resource_dir: Option<&Path>) -> Result<(), String> {
    let Some(source) = resource_dir.map(|dir| dir.join(BRIDGE_EXTENSION)) else {
        return Ok(());
    };
    if !source.join("package.json").is_file() {
        // A dev build without bundled resources still gets a working editor,
        // just without the Aris integration.
        return Ok(());
    }
    let target = extensions_dir().join(BRIDGE_EXTENSION);
    let _ = std::fs::remove_dir_all(&target);
    std::fs::create_dir_all(&target)
        .map_err(|err| format!("create {}: {err}", target.display()))?;
    for entry in std::fs::read_dir(&source)
        .map_err(|err| format!("read {}: {err}", source.display()))?
        .flatten()
    {
        if entry
            .file_type()
            .map(|kind| kind.is_file())
            .unwrap_or(false)
        {
            let name = entry.file_name();
            std::fs::copy(entry.path(), target.join(&name))
                .map_err(|err| format!("copy {}: {err}", name.to_string_lossy()))?;
        }
    }
    Ok(())
}

fn ensure(
    sink: &dyn StatusSink,
    inner: &Arc<Mutex<Inner>>,
    folder: Option<String>,
    app_host: Option<String>,
    bridge: Option<(String, String)>,
    resource_dir: Option<PathBuf>,
) -> Result<CodeServerStatus, String> {
    {
        let mut guard = inner.lock().map_err(|_| "code server state poisoned")?;
        // A crashed server must fall through to a fresh launch instead of
        // short-circuiting on a stale `Ready`.
        guard.poll_liveness();
        if guard.phase == Phase::Ready && guard.port.is_some() {
            if folder.is_some() {
                guard.folder = folder;
            }
            guard.host = workbench_host(app_host.as_deref());
            return Ok(guard.status());
        }
        // Another call already owns the install/launch; report progress rather
        // than starting a second one.
        if guard.busy {
            return Ok(guard.status());
        }
        guard.busy = true;
        guard.cancel = false;
        guard.host = workbench_host(app_host.as_deref());
        guard.folder = folder.or_else(|| guard.folder.clone());
    }

    let result = (|| {
        let dir = install(sink, inner, resource_dir.as_deref())?;
        // `install` patches a fresh extraction. Re-run the idempotent patch
        // pass for an already-installed runtime too, so an app upgrade can
        // change workbench defaults without requiring a runtime version bump.
        // A failure is cosmetic: the editor can still run with upstream
        // defaults, while the next launch gets another chance.
        if let Err(error) = patch_workbench(&dir) {
            eprintln!("[codeserver] could not refresh workbench patches: {error}");
        }
        install_bridge_extension(resource_dir.as_deref())?;
        if !default_extensions_marker().exists() {
            set_phase(sink, inner, Phase::Extensions, None);
            if let Err(error) = install_default_extensions(&dir) {
                // Surfaced, not fatal: the editor still opens and the user can
                // install by hand from the Extensions view.
                eprintln!("SomniQ code page: {error}");
            }
        }
        set_phase(sink, inner, Phase::Starting, None);
        let token = random_token();
        let (child, pid, port) = spawn_server(&dir, &token, bridge)?;
        if let Err(err) = health_check(port) {
            runtime::terminate_managed_process_tree(pid);
            let mut child = child;
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
        let guard = runtime::register_managed_process(
            pid,
            format!("vscode-server:{RUNTIME_VERSION}"),
            runtime::ManagedProcessKind::Mcp,
        );
        let mut state = inner.lock().map_err(|_| "code server state poisoned")?;
        state.child = Some(child);
        state.guard = Some(guard);
        state.pid = Some(pid);
        state.port = Some(port);
        state.token = token;
        state.phase = Phase::Ready;
        state.message = None;
        Ok(state.status())
    })();

    if let Ok(mut guard) = inner.lock() {
        guard.busy = false;
        guard.cancel = false;
    }
    match result {
        Ok(status) => {
            sink.emit(&status);
            Ok(status)
        }
        Err(err) => {
            set_phase(sink, inner, Phase::Failed, Some(err.clone()));
            Err(err)
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Current runtime state, including whether the server died since the last
/// call. Cheap enough to poll.
#[tauri::command]
pub fn code_server_status(state: State<'_, CodeServerState>) -> Result<CodeServerStatus, String> {
    let mut guard = state.0.lock().map_err(|_| "code server state poisoned")?;
    guard.poll_liveness();
    Ok(guard.status())
}

/// Download (first run only) and start the server, returning the URL the Code
/// page should render.
#[tauri::command]
pub async fn code_server_ensure(
    app: AppHandle,
    state: State<'_, CodeServerState>,
    bridge: State<'_, crate::codebridge::CodeBridgeState>,
    folder: Option<String>,
    app_host: Option<String>,
) -> Result<CodeServerStatus, String> {
    let inner = state.handle();
    let endpoint = bridge.endpoint();
    let resource_dir = crate::bundled_resource_dir(&app);
    tauri::async_runtime::spawn_blocking(move || {
        ensure(&app, &inner, folder, app_host, endpoint, resource_dir)
    })
    .await
    .map_err(|err| format!("code server task failed: {err}"))?
}

/// Stop the server and its children, and abandon an install still in flight.
/// Safe to call when nothing is running.
#[tauri::command]
pub fn code_server_stop(state: State<'_, CodeServerState>) -> Result<CodeServerStatus, String> {
    let mut guard = state.0.lock().map_err(|_| "code server state poisoned")?;
    guard.cancel = true;
    guard.shutdown();
    Ok(guard.status())
}

/// Called from the app's exit path so closing the window does not leave a
/// server, an extension host and a pty host running.
pub fn shutdown_on_exit(state: &CodeServerState) {
    if let Ok(mut guard) = state.0.lock() {
        guard.shutdown();
    }
}

#[cfg(test)]
#[path = "tests/codeserver.rs"]
mod tests;
