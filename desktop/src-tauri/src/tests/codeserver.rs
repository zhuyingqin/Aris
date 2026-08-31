use super::{
    asset_name, brand_runtime, bundled_archive, bundled_asset_name, download_urls,
    asset_revision, bust_static_cache, download_verified_to, ensure, expected_sha256,
    folder_uri_path,
    generate_nls_bundle,
    hex_digest, is_installed, marker_path, node_binary, apply_patch, parse_bound_port,
    random_token, server_args, server_entry, set_nls_base_url, target_slug, version_dir,
    runtime_file, workbench_host, workbench_locale, workbench_url, Inner, Patch, Phase,
    SilentSink, BRANDING_DIR, BRAND_ASSETS, CODE_HOST, LOCALE_ENV, PATCHES, PORT_RANGE,
    RUNTIME_VERSION, SERVER_BUNDLE, WORKBENCH_BUNDLE,
};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    crate::test_env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("somniq-codeserver-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

/// Lay out a directory that looks like a finished install for the *current*
/// target, so `is_installed` has something real to accept.
fn fake_install(dir: &Path) {
    let sha = expected_sha256(target_slug().expect("supported target")).expect("pinned checksum");
    std::fs::create_dir_all(dir.join("out")).expect("create out dir");
    std::fs::write(node_binary(dir), b"node").expect("write node");
    std::fs::write(server_entry(dir), b"// server").expect("write entry");
    std::fs::write(marker_path(dir), sha).expect("write marker");
}

#[test]
fn parses_the_port_the_server_reports() {
    assert_eq!(
        parse_bound_port("Server bound to 127.0.0.1:39217 (IPv4)"),
        Some(39217)
    );
    assert_eq!(
        parse_bound_port("[01:01:31] Server bound to 127.0.0.1:8080 (IPv4)"),
        Some(8080)
    );
}

#[test]
fn ignores_lines_that_are_not_the_bind_announcement() {
    assert_eq!(
        parse_bound_port("Extension host agent listening on 39217"),
        None
    );
    assert_eq!(
        parse_bound_port("Web UI available at http://localhost:39217"),
        None
    );
    assert_eq!(parse_bound_port(""), None);
}

/// The whole embedding scheme rests on this host name; see the module docs.
#[test]
fn workbench_url_uses_the_tauri_subdomain_not_loopback() {
    let url = workbench_url(39217, "abc123", None, CODE_HOST);
    assert_eq!(url, "http://code.tauri.localhost:39217/?tkn=abc123");
    assert!(!url.contains("127.0.0.1"));
}

/// wry routes anything starting `http://tauri.` into Tauri's own custom
/// protocol handler, so the host must not begin with that label.
#[test]
fn workbench_host_is_not_swallowed_by_the_wry_custom_protocol_filter() {
    assert!(!format!("http://{CODE_HOST}").starts_with("http://tauri."));
    assert!(CODE_HOST.ends_with(".tauri.localhost"));
}

/// A packaged Windows build serves the UI from `tauri.localhost`.
#[test]
fn a_packaged_app_gets_the_code_subdomain() {
    assert_eq!(
        workbench_host(Some("tauri.localhost")),
        "code.tauri.localhost"
    );
}

/// `tauri dev` serves the UI from `127.0.0.1:1420`, where
/// `code.tauri.localhost` is *cross-site* — the token cookie would be dropped
/// and the Code page would 403 in development only.
#[test]
fn a_dev_build_stays_on_loopback_so_the_token_cookie_survives() {
    assert_eq!(workbench_host(Some("127.0.0.1")), "127.0.0.1");
    assert_eq!(workbench_host(Some("localhost")), "localhost");
}

#[test]
fn an_unknown_or_missing_host_falls_back_to_the_packaged_name() {
    assert_eq!(workbench_host(None), CODE_HOST);
    assert_eq!(workbench_host(Some("   ")), CODE_HOST);
    assert_eq!(workbench_host(Some("example.com")), CODE_HOST);
}

/// Deriving twice must not produce `code.code.tauri.localhost`.
#[test]
fn deriving_the_host_twice_is_stable() {
    let once = workbench_host(Some("tauri.localhost"));
    assert_eq!(workbench_host(Some(&once)), once);
}

/// The workbench wants a URI path. Handing it the native Windows path drops
/// the drive letter: the title becomes `\Users\wt\project` and the explorer
/// resolves nothing, which reads as an empty workspace rather than an error.
#[test]
fn a_windows_path_becomes_a_uri_path() {
    assert_eq!(
        folder_uri_path(r"C:\Users\wt\project"),
        "/c:/Users/wt/project"
    );
    assert_eq!(folder_uri_path("D:/work"), "/d:/work");
}

#[test]
fn a_posix_path_is_left_alone() {
    assert_eq!(folder_uri_path("/home/wt/project"), "/home/wt/project");
    assert_eq!(folder_uri_path("relative/dir"), "relative/dir");
}

#[test]
fn workbench_url_encodes_the_uri_form_of_a_windows_folder() {
    let url = workbench_url(4000, "tok", Some(r"C:\Users\wt\project"), CODE_HOST);
    assert!(
        url.contains("&folder=%2Fc%3A%2FUsers%2Fwt%2Fproject"),
        "{url}"
    );
    assert!(
        !url.contains("%5C"),
        "backslashes must not reach the workbench: {url}"
    );
}

#[test]
fn workbench_url_omits_a_blank_folder() {
    assert!(!workbench_url(4000, "tok", Some("   "), CODE_HOST).contains("folder="));
    assert!(!workbench_url(4000, "tok", None, CODE_HOST).contains("folder="));
}

#[test]
fn token_is_thirty_two_hex_chars() {
    let token = random_token();
    assert_eq!(token.len(), 32);
    assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(token, random_token());
}

#[test]
fn every_pinned_target_has_a_checksum_and_an_asset_name() {
    for slug in [
        "win32-x64",
        "darwin-x64",
        "darwin-arm64",
        "linux-x64",
        "linux-arm64",
    ] {
        let sha = expected_sha256(slug).unwrap_or_else(|| panic!("no checksum for {slug}"));
        assert_eq!(sha.len(), 64, "{slug} checksum is not a sha256");
        assert!(sha.chars().all(|c| c.is_ascii_hexdigit()), "{slug}");
        assert_eq!(
            asset_name(slug),
            format!("vscodium-reh-web-{slug}-{RUNTIME_VERSION}.tar.gz")
        );
    }
}

#[test]
fn the_current_build_target_is_supported() {
    let slug = target_slug().expect("desktop target must have a runtime");
    assert!(expected_sha256(slug).is_some());
}

#[test]
fn mirror_is_tried_before_github() {
    let _lock = env_lock();
    std::env::remove_var("ARIS_CODE_RUNTIME_URL");
    let urls = download_urls("win32-x64");
    assert_eq!(urls.len(), 2);
    assert!(urls[0].contains("somni.chat"), "{:?}", urls);
    assert!(urls[1].contains("github.com"), "{:?}", urls);
}

#[test]
fn explicit_runtime_url_overrides_both_sources() {
    let _lock = env_lock();
    std::env::set_var("ARIS_CODE_RUNTIME_URL", "http://127.0.0.1:9/local.tar.gz");
    let urls = download_urls("win32-x64");
    std::env::remove_var("ARIS_CODE_RUNTIME_URL");
    assert_eq!(urls, vec!["http://127.0.0.1:9/local.tar.gz".to_string()]);
}

/// A missing mirror route currently returns the SomniQ HTML shell with 200.
/// The HTTP success must not suppress the official release fallback.
#[test]
fn a_bad_checksum_falls_through_to_the_next_download_source() {
    let root = temp_dir("checksum-fallback");
    let dest = root.join("runtime.tar.gz");
    let bad = FileServer::serve_bytes(b"<!doctype html><title>SomniQ</title>".to_vec())
        .expect("serve bad mirror response");
    let trusted_bytes = b"trusted runtime archive".to_vec();
    let good = FileServer::serve_bytes(trusted_bytes.clone()).expect("serve trusted response");

    let mut hasher = Sha256::new();
    hasher.update(&trusted_bytes);
    let expected = hex_digest(hasher);
    let inner = Arc::new(Mutex::new(Inner::default()));
    download_verified_to(
        &SilentSink,
        &inner,
        &[bad.url.clone(), good.url.clone()],
        &dest,
        &expected,
    )
    .expect("the valid fallback should be accepted");

    assert_eq!(
        std::fs::read(&dest).expect("downloaded bytes"),
        trusted_bytes
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_complete_install_is_recognized() {
    let dir = temp_dir("complete");
    fake_install(&dir);
    assert!(is_installed(&dir));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_install_missing_its_entry_point_is_rejected() {
    let dir = temp_dir("no-entry");
    fake_install(&dir);
    std::fs::remove_file(server_entry(&dir)).expect("remove entry");
    assert!(!is_installed(&dir));
    let _ = std::fs::remove_dir_all(&dir);
}

/// A half-written directory from a previous version must not be mistaken for
/// the pinned one, or the app would launch the wrong runtime.
#[test]
fn an_install_from_another_version_is_rejected() {
    let dir = temp_dir("stale");
    fake_install(&dir);
    std::fs::write(marker_path(&dir), "0".repeat(64)).expect("write stale marker");
    assert!(!is_installed(&dir));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn an_extracted_but_unmarked_install_is_rejected() {
    let dir = temp_dir("unmarked");
    fake_install(&dir);
    std::fs::remove_file(marker_path(&dir)).expect("remove marker");
    assert!(!is_installed(&dir));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn server_args_bind_loopback() {
    let args = server_args(Path::new("/runtime/out/server-main.js"), "tok");
    let host = args.iter().position(|a| a == "--host").expect("--host");
    assert_eq!(args[host + 1], "127.0.0.1");
}

/// The web workbench stores settings, theme and UI state in browser storage
/// keyed by origin — and an origin includes the port. An ephemeral port would
/// silently reset the user's editor on every restart, so the range has to be
/// narrow and fixed.
#[test]
fn the_port_range_is_narrow_and_fixed_so_browser_state_survives_a_restart() {
    let args = server_args(Path::new("/runtime/out/server-main.js"), "tok");
    let port = args.iter().position(|a| a == "--port").expect("--port");
    assert_eq!(args[port + 1], PORT_RANGE);
    assert_ne!(args[port + 1], "0", "an ephemeral port loses browser state");

    let (low, high) = PORT_RANGE
        .split_once('-')
        .expect("a range, not a single port");
    let low: u32 = low.parse().expect("low bound");
    let high: u32 = high.parse().expect("high bound");
    assert!(low > 1024 && high > low && high - low <= 32, "{PORT_RANGE}");
}

/// `--user-data-dir` looks like the place user settings would live, but the
/// web workbench keeps them in the browser; passing it only creates an empty
/// directory that nothing reads.
#[test]
fn server_args_do_not_pass_a_user_data_dir() {
    let args = server_args(Path::new("/runtime/out/server-main.js"), "tok");
    assert!(!args.iter().any(|a| a == "--user-data-dir"));
}

/// `--without-connection-token` would leave the server open to any web page,
/// because WebSocket connections are not subject to CORS.
#[test]
fn server_args_always_carry_a_connection_token() {
    let args = server_args(Path::new("/runtime/out/server-main.js"), "s3cret");
    assert!(!args.iter().any(|a| a == "--without-connection-token"));
    let token = args
        .iter()
        .position(|a| a == "--connection-token")
        .expect("--connection-token");
    assert_eq!(args[token + 1], "s3cret");
}

/// Extensions and settings must not live under the versioned directory, or a
/// runtime upgrade would silently uninstall everything the user added.
#[test]
fn user_state_lives_outside_the_version_directory() {
    let _lock = env_lock();
    let root = temp_dir("layout");
    std::env::set_var("ARIS_CODE_RUNTIME_DIR", &root);
    let args = server_args(Path::new("entry.js"), "tok");
    std::env::remove_var("ARIS_CODE_RUNTIME_DIR");

    let versioned = root.join(RUNTIME_VERSION);
    for flag in ["--extensions-dir", "--server-data-dir"] {
        let idx = args.iter().position(|a| a == flag).expect(flag);
        let path = PathBuf::from(&args[idx + 1]);
        assert!(path.starts_with(&root), "{flag} escaped the runtime root");
        assert!(
            !path.starts_with(&versioned),
            "{flag} would be wiped on upgrade: {}",
            path.display()
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn telemetry_is_off_by_default() {
    let args = server_args(Path::new("entry.js"), "tok");
    let idx = args
        .iter()
        .position(|a| a == "--telemetry-level")
        .expect("flag");
    assert_eq!(args[idx + 1], "off");
}

/// React effects fire twice in StrictMode, so a second `ensure` arriving while
/// the first is still downloading must be a no-op — not a second 103 MB
/// download racing into the same staging directory.
#[test]
fn a_concurrent_ensure_does_not_start_a_second_install() {
    let inner = Arc::new(Mutex::new(Inner::default()));
    inner.lock().expect("state").busy = true;
    inner.lock().expect("state").phase = Phase::Downloading;

    let status =
        ensure(&SilentSink, &inner, None, None, None, None, None)
            .expect("busy ensure returns status");

    assert_eq!(status.phase, Phase::Downloading);
    // Still claimed: the in-flight call owns it and clears the flag itself.
    assert!(inner.lock().expect("state").busy);
}

/// A process that stays up long enough to stand in for a running server, so
/// `poll_liveness` sees a live child rather than the inconsistent
/// "ready but nothing is running" state.
fn spawn_placeholder_child() -> std::process::Child {
    #[cfg(windows)]
    let mut command = std::process::Command::new("ping");
    #[cfg(windows)]
    command.args(["-n", "30", "127.0.0.1"]);
    #[cfg(not(windows))]
    let mut command = std::process::Command::new("sleep");
    #[cfg(not(windows))]
    command.arg("30");
    command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn placeholder process")
}

/// A ready server should be reused, with the second call only retargeting the
/// workspace folder.
#[test]
fn ensure_on_a_ready_server_only_retargets_the_folder() {
    let inner = Arc::new(Mutex::new(Inner::default()));
    let child = spawn_placeholder_child();
    let pid = child.id();
    {
        let mut guard = inner.lock().expect("state");
        guard.phase = Phase::Ready;
        guard.port = Some(4321);
        guard.token = "tok".into();
        guard.child = Some(child);
    }

    let status = ensure(
        &SilentSink,
        &inner,
        Some("D:/work".into()),
        None,
        None,
        None,
        None,
    )
    .expect("reuse");

    assert_eq!(status.phase, Phase::Ready);
    assert_eq!(status.port, Some(4321));
    assert!(status.url.expect("url").contains("folder=%2Fd%3A%2Fwork"));
    assert!(!inner.lock().expect("state").busy, "reuse must not claim");

    inner.lock().expect("state").shutdown();
    let _ = std::process::Command::new(if cfg!(windows) { "taskkill" } else { "kill" })
        .args(if cfg!(windows) {
            vec!["/PID".to_string(), pid.to_string(), "/F".to_string()]
        } else {
            vec!["-9".to_string(), pid.to_string()]
        })
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

/// A live server must survive a liveness poll untouched.
#[test]
fn a_running_server_stays_ready() {
    let mut inner = Inner {
        phase: Phase::Ready,
        port: Some(4321),
        token: "tok".into(),
        child: Some(spawn_placeholder_child()),
        ..Inner::default()
    };
    inner.poll_liveness();

    assert_eq!(inner.phase, Phase::Ready);
    assert_eq!(inner.port, Some(4321));
    inner.shutdown();
}

/// `Idle` means "not running" and carries no claim about the disk; the
/// filesystem answers that separately.
#[test]
fn shutdown_returns_to_idle_without_claiming_the_runtime_is_gone() {
    let inner = Arc::new(Mutex::new(Inner::default()));
    {
        let mut guard = inner.lock().expect("state");
        guard.phase = Phase::Ready;
        guard.port = Some(9);
        guard.token = "tok".into();
    }
    inner.lock().expect("state").shutdown();

    let status = inner.lock().expect("state").status();
    assert_eq!(status.phase, Phase::Idle);
    assert_eq!(status.port, None);
    assert_eq!(status.url, None);
}

/// A stalled download must be abandonable. Without this the `busy` claim would
/// outlive the fetch and every later retry would be refused until restart.
#[test]
fn a_cancelled_install_releases_the_busy_claim() {
    let _lock = env_lock();
    let root = temp_dir("cancel");
    std::env::set_var("ARIS_CODE_RUNTIME_DIR", &root);
    // Port 9 (discard) never answers, so the fetch fails rather than succeeds.
    std::env::set_var("ARIS_CODE_RUNTIME_URL", "http://127.0.0.1:9/nope.tar.gz");

    let inner = Arc::new(Mutex::new(Inner::default()));
    inner.lock().expect("state").cancel = true;
    let result = ensure(&SilentSink, &inner, None, None, None, None, None);

    std::env::remove_var("ARIS_CODE_RUNTIME_URL");
    std::env::remove_var("ARIS_CODE_RUNTIME_DIR");

    assert!(
        result.is_err(),
        "a cancelled install must not report success"
    );
    let guard = inner.lock().expect("state");
    assert!(!guard.busy, "busy claim leaked past a cancel");
    assert!(!guard.cancel, "cancel flag must not latch");
    assert_eq!(guard.phase, Phase::Failed);
    let _ = std::fs::remove_dir_all(&root);
}

/// Nothing pushes us the news that the server died, so `status` has to notice.
/// Without this the UI keeps pointing an iframe at a dead port.
#[test]
fn a_ready_server_with_no_process_is_reported_as_failed() {
    let mut inner = Inner {
        phase: Phase::Ready,
        port: Some(4321),
        token: "tok".into(),
        ..Inner::default()
    };
    inner.poll_liveness();

    assert_eq!(inner.phase, Phase::Failed);
    assert_eq!(inner.port, None);
    assert!(inner
        .message
        .unwrap_or_default()
        .contains("no longer running"));
}

#[test]
fn liveness_polling_leaves_non_running_phases_alone() {
    for phase in [
        Phase::Idle,
        Phase::Downloading,
        Phase::Extracting,
        Phase::Starting,
    ] {
        let mut inner = Inner {
            phase,
            ..Inner::default()
        };
        inner.poll_liveness();
        assert_eq!(inner.phase, phase, "poll_liveness disturbed {phase:?}");
    }
}

// ---------------------------------------------------------------------------
// End-to-end
// ---------------------------------------------------------------------------

/// Serve one file over loopback HTTP so the real download → SHA-256 → extract
/// path runs without reaching the network. Returns the URL and shuts down when
/// dropped.
struct FileServer {
    url: String,
    stop: Arc<std::sync::atomic::AtomicBool>,
}

impl FileServer {
    fn serve(path: &Path) -> std::io::Result<Self> {
        let body = std::fs::read(path)?;
        Self::serve_bytes(body)
    }

    fn serve_bytes(body: Vec<u8>) -> std::io::Result<Self> {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
        let url = format!("http://{}/runtime.tar.gz", listener.local_addr()?);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stop.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if flag.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                let Ok(mut stream) = stream else { continue };
                let mut scratch = [0u8; 1024];
                let _ = stream.read(&mut scratch);
                let header = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/gzip\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(&body);
                let _ = stream.flush();
            }
        });
        Ok(Self { url, stop })
    }
}

impl Drop for FileServer {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = std::net::TcpStream::connect(
            self.url
                .trim_start_matches("http://")
                .split('/')
                .next()
                .unwrap_or_default(),
        );
    }
}

/// Drives the whole M1 pipeline against the real VSCodium tarball: install
/// (download over loopback, verify the pinned checksum, extract atomically),
/// launch, health-check, then shut the process tree down.
///
/// Ignored by default because it needs the ~103 MB archive on disk. Run with:
///
/// ```text
/// ARIS_CODE_RUNTIME_ARCHIVE=<path to vscodium-reh-web-…tar.gz> \
///   cargo test --lib codeserver::tests::installs_and_starts -- --ignored --nocapture
/// ```
#[test]
#[ignore = "downloads/extracts ~336 MB and spawns a real server"]
fn installs_and_starts_the_real_runtime() {
    let _lock = env_lock();
    let Some(archive) = std::env::var_os("ARIS_CODE_RUNTIME_ARCHIVE").map(PathBuf::from) else {
        panic!("set ARIS_CODE_RUNTIME_ARCHIVE to the reh-web tarball");
    };
    let server = FileServer::serve(&archive).expect("serve archive");
    let root = temp_dir("e2e");
    std::env::set_var("ARIS_CODE_RUNTIME_DIR", &root);
    std::env::set_var("ARIS_CODE_RUNTIME_URL", &server.url);

    let inner = Arc::new(Mutex::new(Inner::default()));
    let outcome = ensure(
        &SilentSink,
        &inner,
        Some(root.display().to_string()),
        None,
        None,
        None,
        None,
    );

    std::env::remove_var("ARIS_CODE_RUNTIME_URL");
    let status = match outcome {
        Ok(status) => status,
        Err(err) => {
            std::env::remove_var("ARIS_CODE_RUNTIME_DIR");
            let _ = std::fs::remove_dir_all(&root);
            panic!("ensure failed: {err}");
        }
    };

    assert_eq!(status.phase, Phase::Ready);
    assert!(status.installed, "install marker was not written");
    let port = status.port.expect("a bound port");
    let url = status.url.clone().expect("a workbench url");
    assert!(
        url.starts_with(&format!("http://{CODE_HOST}:{port}/?tkn=")),
        "{url}"
    );
    assert!(is_installed(&version_dir()), "version dir is not complete");
    // The staging directory must not survive a successful install.
    assert!(!root.join(format!("{RUNTIME_VERSION}.staging")).exists());
    // Nor should the 103 MB archive.
    assert!(!root
        .join(asset_name(target_slug().expect("target")))
        .exists());
    // Branding is a literal substitution into a minified bundle, so it is the
    // one part of the install that a VSCodium version bump can silently break.
    // Assert it against the real runtime rather than trusting the patch table.
    let workbench = std::fs::read_to_string(runtime_file(&version_dir(), WORKBENCH_BUNDLE))
        .expect("read the workbench bundle");
    assert!(
        workbench.contains(r#"nameLong:"SomniQ Code""#),
        "the workbench was not rebranded; the product literal in {RUNTIME_VERSION} has changed \
         shape and BRANDING needs updating"
    );
    assert!(
        workbench.contains(r#"[rbi]:{type:"string",default:"always""#),
        "Workspace Trust startup prompts are not enabled; the trust schema in {RUNTIME_VERSION} \
         has changed shape and TRUST needs updating"
    );
    // Brand assets are addressed by path instead of patched into the bundle,
    // so the way a VSCodium reshuffle breaks them is by making a target vanish.
    // `ensure` above ran without bundled resources (that is the download path
    // this test exists to cover), so drive the pass explicitly against the real
    // tree, where a missing target is the whole point.
    let resources = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
    let applied = brand_runtime(&version_dir(), Some(&resources)).expect("branding pass");
    assert_eq!(
        applied,
        Some(BRAND_ASSETS.len()),
        "a brand asset has no counterpart in {RUNTIME_VERSION}; BRAND_ASSETS needs updating"
    );

    // The server-side patch is what lets SomniQ's language switch reach the
    // workbench at all; without it the display language follows the host's
    // `Accept-Language` instead.
    let server = std::fs::read_to_string(runtime_file(&version_dir(), SERVER_BUNDLE))
        .expect("read the server bundle");
    assert!(
        server.contains(LOCALE_ENV),
        "the locale lookup in {RUNTIME_VERSION} has changed shape; the server patch missed"
    );
    // Without all three of these the webview host stays on Microsoft's CDN,
    // where it is too old to speak this workbench's resource protocol — every
    // Markdown preview, notebook renderer and custom editor comes up blank.
    assert!(
        server.contains(r#"webviewEndpoint:"http://{{uuid}}.localhost:""#),
        "the workbench construction options in {RUNTIME_VERSION} have changed shape; webviews \
         would fall back to the CDN host and render nothing"
    );
    assert!(
        server.contains(r#"!s.startsWith("/static/out/vs/workbench/contrib/webview/browser/pre/")"#),
        "the connection-token gate in {RUNTIME_VERSION} has changed shape; the webview service \
         worker would be fetched without a cookie and refused"
    );
    assert!(
        server.contains("http://*.localhost:*;"),
        "the page CSP in {RUNTIME_VERSION} has changed shape; the webview iframe would be blocked"
    );

    // `ensure` has already moved the asset prefix, so the commit read here is
    // the busted one — which is exactly the value the page will ask for.
    let product: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(version_dir().join("product.json")).expect("read product.json"),
    )
    .expect("parse product.json");
    let commit = product["commit"].as_str().expect("a commit");
    assert!(
        commit.contains("-aris"),
        "the asset prefix was not moved, so a cached workbench would survive the patches"
    );
    // The page announces its own commit on the management handshake and the
    // server refuses the socket if the two disagree, so moving one without the
    // other does not leave a stale editor — it leaves no editor at all.
    assert!(
        workbench.contains(&format!(r#"commit:"{commit}""#)),
        "the page still announces a different commit than the server expects; the \
         management socket would be refused with a version mismatch"
    );

    // Generating against the real runtime is the only check that the vendored
    // translations still line up with the message table it ships.
    assert_eq!(
        generate_nls_bundle(&version_dir(), Some(&resources), "zh-cn"),
        Ok(true),
        "the Chinese message bundle could not be built for {RUNTIME_VERSION}"
    );
    let bundle = std::fs::read_to_string(
        version_dir()
            .join("nls")
            .join(commit)
            .join(RUNTIME_VERSION)
            .join("zh-cn")
            .join("nls.messages.js"),
    )
    .expect("read the generated bundle");
    let messages: Vec<String> = serde_json::from_str(
        bundle
            .trim_end_matches(';')
            .trim_start_matches("globalThis._VSCODE_NLS_MESSAGES="),
    )
    .expect("parse the generated bundle");
    let translated = messages
        .iter()
        .filter(|message| message.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)))
        .count();
    // Measured at 98.6% against 1.126.04524. A collapse here means the pack and
    // the runtime have drifted apart, which the fallback hides.
    assert!(
        translated * 100 / messages.len() >= 90,
        "only {translated}/{} messages are Chinese; the language pack has drifted from \
         {RUNTIME_VERSION}",
        messages.len()
    );
    assert!(
        !messages.iter().any(|m| m.contains("VSCodium")),
        "the generated bundle still names the upstream product"
    );

    let pid = inner.lock().expect("state").pid.expect("a pid");
    inner.lock().expect("state").shutdown();
    std::thread::sleep(std::time::Duration::from_millis(750));
    assert!(
        !process_alive(pid),
        "server process {pid} survived shutdown"
    );

    std::env::remove_var("ARIS_CODE_RUNTIME_DIR");
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output();
    match output {
        Ok(output) => String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()),
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn process_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

// ---------------------------------------------------------------------------
// Branding
// ---------------------------------------------------------------------------

#[test]
fn patching_replaces_the_product_name_in_place() {
    let mut body =
        r#"var x=1;nv={nameShort:"VSCodium",nameLong:"VSCodium",applicationName:"codium"};"#
            .to_string();

    assert!(apply_patch(&mut body, &PATCHES[0]));

    assert!(body.contains(r#"nameShort:"SomniQ Code",nameLong:"SomniQ Code""#));
    // Only the product name changes: the rest of the object has to survive, or
    // the workbench loses the identifiers it uses for storage and IPC.
    assert!(body.contains(r#"applicationName:"codium""#));
    assert!(body.starts_with("var x=1;"));
}

/// A newer VSCodium can minify a literal differently. That must degrade to
/// "the editor still looks like VSCodium", never to a failed install.
#[test]
fn a_patch_that_does_not_match_changes_nothing() {
    let original = r#"nv={nameShort: "VSCodium", nameLong: "VSCodium"};"#;
    let mut body = original.to_string();

    assert!(!apply_patch(&mut body, &PATCHES[0]));
    assert_eq!(body, original);
}

/// `default:"welcomePage"` appears many times in a 17 MB bundle. Only the one
/// inside the startup-editor schema may be touched.
#[test]
fn an_anchored_patch_only_touches_the_setting_it_names() {
    let mut body = concat!(
        r#""workbench.other":{default:"welcomePage"},"#,
        r#""workbench.startupEditor":{scope:5,enum:["none","welcomePage"],default:"welcomePage"},"#,
        r#""workbench.later":{default:"welcomePage"}"#,
    )
    .to_string();

    assert!(apply_patch(&mut body, &PATCHES[1]));

    assert_eq!(body.matches(r#"default:"welcomePage""#).count(), 2);
    assert!(body.contains(r#""workbench.startupEditor":{scope:5,enum:["none","welcomePage"],default:"none"}"#));
    assert!(body.starts_with(r#""workbench.other":{default:"welcomePage"}"#));
}

#[test]
fn workspace_trust_startup_prompt_defaults_to_always() {
    let mut body = concat!(
        r#"[rbi]:{type:"string",default:"never",enum:["always","once","never"]},"#,
        r#"otherSetting:{default:"never"}"#,
    )
    .to_string();

    assert!(apply_patch(&mut body, &PATCHES[2]));
    assert!(body.contains(r#"[rbi]:{type:"string",default:"always""#));
    assert_eq!(body.matches(r#"default:"never""#).count(), 1);
}

/// The anchor must not reach across the whole file: a moved anchor should miss
/// rather than rewrite some unrelated setting far below it.
#[test]
fn an_anchored_patch_gives_up_outside_its_window() {
    let mut body = format!(
        r#""workbench.startupEditor":{{{}}}default:"welcomePage""#,
        "x".repeat(2000)
    );
    let before = body.clone();

    assert!(!apply_patch(&mut body, &PATCHES[1]));
    assert_eq!(body, before);
}

#[test]
fn an_anchored_patch_without_its_anchor_does_nothing() {
    let mut body = r#"somethingElse:{default:"welcomePage"}"#.to_string();
    assert!(!apply_patch(&mut body, &PATCHES[1]));
    assert_eq!(body, r#"somethingElse:{default:"welcomePage"}"#);
}

#[test]
fn patching_is_idempotent() {
    let mut body = r#"nv={nameShort:"VSCodium",nameLong:"VSCodium"};"#.to_string();

    assert!(apply_patch(&mut body, &PATCHES[0]));
    assert!(!apply_patch(&mut body, &PATCHES[0]), "second pass changed bytes");
}

/// Every replacement has to change something, and none may reintroduce a
/// *different* rule's search text — a table like that would keep rewriting on
/// every pass. A rule that contains its own search text is fine and expected:
/// that is what an insertion looks like, and `apply_patch` stops the second
/// application by recognising its own replacement.
#[test]
fn the_patch_table_is_well_formed() {
    for (i, patch) in PATCHES.iter().enumerate() {
        assert_ne!(patch.find, patch.replace, "a no-op replacement");
        assert!(!patch.file.is_empty(), "a patch with no target file");
        for (j, other) in PATCHES.iter().enumerate() {
            if i == j || patch.file != other.file {
                continue;
            }
            assert!(
                !patch.replace.contains(other.find),
                "a replacement contains another rule's search text, so applying                  the table twice would keep rewriting"
            );
        }
    }
}

/// Every rule has to survive the pass running again on the next launch. The
/// locale rule is the one that makes this non-trivial: it *inserts*, so its
/// replacement still contains its own search text, and a naive second pass
/// would append another `process.env` lookup every time the app started.
#[test]
fn applying_the_whole_table_twice_changes_nothing() {
    for patch in PATCHES {
        let mut body = format!("prefix{}suffix", patch.find);
        let anchored = match patch.anchor {
            Some(anchor) => {
                body = format!("{anchor}{}suffix", patch.find);
                true
            }
            None => false,
        };
        assert!(apply_patch(&mut body, patch), "first pass missed");
        let once = body.clone();
        assert!(
            !apply_patch(&mut body, patch),
            "second pass re-applied {:?} (anchored: {anchored})",
            patch.find
        );
        assert_eq!(body, once, "second pass changed bytes");
    }
}

/// Guarding idempotence by asking whether the replacement appears *anywhere*
/// nearby is not the same question. The startup-editor rule's anchor window
/// really does contain an unrelated `default:"none"` in the shipped bundle, and
/// a looser check silently stopped rebranding the welcome page.
#[test]
fn a_rule_still_applies_when_its_replacement_text_appears_nearby() {
    let mut body = concat!(
        r#""workbench.startupEditor":{"#,
        r#"other:{default:"none"},"#,
        r#"scope:5,default:"welcomePage""#,
    )
    .to_string();

    assert!(apply_patch(&mut body, &PATCHES[1]), "the rule was skipped");
    assert!(body.ends_with(r#"scope:5,default:"none""#), "{body}");
    // The neighbour it was confused by has to survive untouched.
    assert!(body.contains(r#"other:{default:"none"}"#));
}

/// The workbench takes its display language from `Accept-Language` unless the
/// server is told otherwise, which would follow the operating system rather
/// than SomniQ's own switch.
#[test]
fn the_locale_patch_reads_an_environment_variable() {
    let patch = PATCHES
        .iter()
        .find(|patch| patch.file == SERVER_BUNDLE)
        .expect("a server-side patch");
    assert!(patch.replace.contains(LOCALE_ENV));
    // Ordering matters: the cookie comes first, so a language chosen inside the
    // editor still beats the app's setting.
    let cookie = patch
        .replace
        .find("vscode.nls.locale")
        .expect("cookie lookup");
    let env = patch.replace.find(LOCALE_ENV).expect("env lookup");
    assert!(cookie < env, "the app setting must not override the editor's");
}

/// A patch whose search text is multi-byte must not slice a UTF-8 boundary
/// while clamping the anchor window.
#[test]
fn an_anchor_window_landing_mid_character_is_safe() {
    let patch = Patch {
        file: WORKBENCH_BUNDLE,
        anchor: Some("anchor"),
        find: "needle",
        replace: "x",
    };
    let mut body = format!("anchor{}needle", "中".repeat(500));

    // Only asserting that this does not panic; the window ends inside the CJK
    // run, so the match is legitimately out of reach.
    let _ = apply_patch(&mut body, &patch);
}

/// Lay out a resource directory holding one brand asset per entry, and a
/// runtime carrying upstream's version of each, so a pass has something real to
/// replace.
fn fake_branding(root: &Path) -> (PathBuf, PathBuf) {
    let resources = root.join("resources");
    let runtime = root.join("runtime");
    std::fs::create_dir_all(resources.join(BRANDING_DIR)).expect("create branding dir");
    for asset in BRAND_ASSETS {
        std::fs::write(
            resources.join(BRANDING_DIR).join(asset.source),
            format!("somniq {}", asset.source),
        )
        .expect("write brand asset");

        let mut target = runtime.clone();
        for segment in asset.target {
            target.push(segment);
        }
        std::fs::create_dir_all(target.parent().expect("parent")).expect("create runtime dir");
        std::fs::write(&target, b"upstream").expect("write upstream asset");
    }
    (resources, runtime)
}

fn runtime_asset(runtime: &Path, asset: &super::BrandAsset) -> PathBuf {
    let mut path = runtime.to_path_buf();
    for segment in asset.target {
        path.push(segment);
    }
    path
}

#[test]
fn branding_replaces_every_asset_it_ships() {
    let root = temp_dir("brand-replaces");
    let (resources, runtime) = fake_branding(&root);

    let applied = brand_runtime(&runtime, Some(&resources)).expect("branding pass");

    assert_eq!(applied, Some(BRAND_ASSETS.len()));
    for asset in BRAND_ASSETS {
        let body = std::fs::read_to_string(runtime_asset(&runtime, asset)).expect("read replaced");
        assert_eq!(body, format!("somniq {}", asset.source));
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// A newer VSCodium may rename or drop one of these files. The right outcome is
/// upstream's artwork, not a file we invented that nothing loads.
#[test]
fn branding_never_creates_a_file_upstream_does_not_have() {
    let root = temp_dir("brand-no-create");
    let (resources, runtime) = fake_branding(&root);
    let orphan = runtime_asset(&runtime, &BRAND_ASSETS[0]);
    std::fs::remove_file(&orphan).expect("drop the upstream file");

    let applied = brand_runtime(&runtime, Some(&resources)).expect("branding pass");

    assert_eq!(applied, Some(BRAND_ASSETS.len() - 1));
    assert!(!orphan.exists(), "branding recreated a file upstream dropped");
    let _ = std::fs::remove_dir_all(&root);
}

/// Every launch runs this pass. A second one must not rewrite bytes that are
/// already correct, or each launch would churn files inside the install.
#[test]
fn branding_is_idempotent_and_does_not_rewrite_matching_files() {
    let root = temp_dir("brand-idempotent");
    let (resources, runtime) = fake_branding(&root);
    assert_eq!(
        brand_runtime(&runtime, Some(&resources)).expect("first pass"),
        Some(BRAND_ASSETS.len())
    );
    let target = runtime_asset(&runtime, &BRAND_ASSETS[0]);
    let before = std::fs::metadata(&target)
        .and_then(|meta| meta.modified())
        .expect("read mtime");

    std::thread::sleep(std::time::Duration::from_millis(20));
    assert_eq!(
        brand_runtime(&runtime, Some(&resources)).expect("second pass"),
        Some(BRAND_ASSETS.len())
    );

    let after = std::fs::metadata(&target)
        .and_then(|meta| meta.modified())
        .expect("read mtime");
    assert_eq!(before, after, "an unchanged asset was rewritten");
    let _ = std::fs::remove_dir_all(&root);
}

/// A dev build without bundled resources still gets a working editor. That is
/// not a partial pass worth warning about, so it reports nothing at all.
#[test]
fn branding_without_bundled_resources_reports_nothing() {
    let root = temp_dir("brand-no-resources");
    let (_, runtime) = fake_branding(&root);

    assert_eq!(brand_runtime(&runtime, None).expect("no resource dir"), None);
    assert_eq!(
        brand_runtime(&runtime, Some(&root.join("missing"))).expect("absent branding dir"),
        None
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// The table names files by hand on both sides. A typo would degrade silently
/// into "the editor still looks like VSCodium", so it is checked here instead.
#[test]
fn every_brand_asset_is_shipped_and_lands_somewhere_distinct() {
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(BRANDING_DIR);
    let mut seen = std::collections::HashSet::new();

    for asset in BRAND_ASSETS {
        assert!(
            bundled.join(asset.source).is_file(),
            "resources/{BRANDING_DIR}/{} is not in the repo",
            asset.source
        );
        assert!(!asset.target.is_empty(), "an asset with no target path");
        assert!(
            asset.target.iter().all(|segment| {
                !segment.is_empty() && *segment != ".." && !segment.contains(['/', '\\'])
            }),
            "{} targets a path that escapes the runtime root",
            asset.source
        );
        assert!(
            seen.insert(asset.target),
            "two assets claim {:?}",
            asset.target
        );
    }
}

// ---------------------------------------------------------------------------
// Display language
// ---------------------------------------------------------------------------

#[test]
fn only_chinese_asks_for_a_translated_workbench() {
    assert_eq!(workbench_locale(Some("cn")), Some("zh-cn"));
    assert_eq!(workbench_locale(Some("zh-CN")), Some("zh-cn"));
    // English maps to nothing on purpose: the compiled strings are already
    // English, and the server refuses to look for a bundle for a locale that
    // starts with `en`, so generating one would be dead weight.
    assert_eq!(workbench_locale(Some("en")), None);
    assert_eq!(workbench_locale(None), None);
}

/// Lay out a runtime with the two files the bundle is built from, plus a
/// resource directory holding a translation for `locale`.
fn fake_nls_runtime(root: &Path, locale: &str, translations: serde_json::Value) -> (PathBuf, PathBuf) {
    let runtime = root.join("runtime");
    let resources = root.join("resources");
    std::fs::create_dir_all(runtime.join("out")).expect("create out");
    std::fs::create_dir_all(resources.join("code-nls")).expect("create nls dir");
    std::fs::write(
        runtime.join("product.json"),
        r#"{"commit":"abc123","version":"1.126.04524","quality":"stable"}"#,
    )
    .expect("write product.json");
    // The page sends this back on the management handshake, so it has to move
    // together with the server's copy.
    let bundle = runtime_file(&runtime, WORKBENCH_BUNDLE);
    std::fs::create_dir_all(bundle.parent().expect("parent")).expect("create bundle dir");
    std::fs::write(&bundle, r#"var p={nameLong:"SomniQ Code",commit:"abc123"};"#)
        .expect("write bundle");
    std::fs::write(
        runtime.join("out").join("nls.keys.json"),
        r#"[["vs/one",["a","b"]],["vs/two",["c"]]]"#,
    )
    .expect("write keys");
    std::fs::write(
        runtime.join("out").join("nls.messages.json"),
        r#"["Alpha","Open VSCodium","Gamma"]"#,
    )
    .expect("write messages");
    std::fs::write(
        resources.join("code-nls").join(format!("{locale}.i18n.json")),
        serde_json::to_string(&translations).expect("serialize"),
    )
    .expect("write translations");
    (runtime, resources)
}

fn generated_messages(runtime: &Path, locale: &str) -> Vec<String> {
    let path = runtime
        .join("nls")
        .join("abc123")
        .join("1.126.04524")
        .join(locale)
        .join("nls.messages.js");
    let body = std::fs::read_to_string(path).expect("read generated bundle");
    let json = body
        .trim_end_matches(';')
        .trim_start_matches("globalThis._VSCODE_NLS_MESSAGES=");
    serde_json::from_str(json).expect("parse generated bundle")
}

#[test]
fn the_bundle_translates_what_it_can_and_keeps_english_for_the_rest() {
    let root = temp_dir("nls-build");
    let (runtime, resources) = fake_nls_runtime(
        &root,
        "zh-cn",
        serde_json::json!({ "contents": { "vs/one": { "a": "阿尔法" } } }),
    );

    assert_eq!(
        generate_nls_bundle(&runtime, Some(&resources), "zh-cn"),
        Ok(true)
    );

    let messages = generated_messages(&runtime, "zh-cn");
    assert_eq!(messages[0], "阿尔法");
    // Untranslated keys fall back to the English at the *same index*, which is
    // the only thing keeping the array aligned.
    assert_eq!(messages[1], "Open SomniQ Code");
    assert_eq!(messages[2], "Gamma");
    let _ = std::fs::remove_dir_all(&root);
}

/// The vendored translations come from Microsoft's language pack, so they name
/// the upstream product wherever VSCodium's own build names itself. Both are
/// wrong for someone looking at SomniQ's Code page.
#[test]
fn the_bundle_renames_the_upstream_product() {
    let root = temp_dir("nls-rebrand");
    let (runtime, resources) = fake_nls_runtime(
        &root,
        "zh-cn",
        serde_json::json!({ "contents": { "vs/one": { "a": "欢迎使用 Visual Studio Code" } } }),
    );

    assert_eq!(
        generate_nls_bundle(&runtime, Some(&resources), "zh-cn"),
        Ok(true)
    );

    let messages = generated_messages(&runtime, "zh-cn");
    assert_eq!(messages[0], "欢迎使用 SomniQ Code");
    assert!(!messages.iter().any(|m| m.contains("VSCodium")));
    let _ = std::fs::remove_dir_all(&root);
}

/// The bundle is a positional array. A key list that does not flatten to the
/// same length as the English one would shift every later string, so the UI
/// would be confidently wrong rather than merely untranslated — refusing is the
/// only safe answer.
#[test]
fn a_misaligned_key_list_is_refused_rather_than_shifted() {
    let root = temp_dir("nls-misaligned");
    let (runtime, resources) = fake_nls_runtime(&root, "zh-cn", serde_json::json!({ "contents": {} }));
    std::fs::write(
        runtime.join("out").join("nls.keys.json"),
        r#"[["vs/one",["a","b"]]]"#,
    )
    .expect("shorten keys");

    let error = generate_nls_bundle(&runtime, Some(&resources), "zh-cn")
        .expect_err("a misaligned bundle must not be written");
    assert!(error.contains("misaligned"), "{error}");
    assert!(
        !runtime.join("nls").exists(),
        "a refused build still wrote something"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_build_without_vendored_translations_stays_english() {
    let root = temp_dir("nls-absent");
    let (runtime, resources) = fake_nls_runtime(&root, "zh-cn", serde_json::json!({ "contents": {} }));
    std::fs::remove_file(resources.join("code-nls").join("zh-cn.i18n.json")).expect("drop payload");

    assert_eq!(
        generate_nls_bundle(&runtime, Some(&resources), "zh-cn"),
        Ok(false)
    );
    assert_eq!(generate_nls_bundle(&runtime, None, "zh-cn"), Ok(false));
    let _ = std::fs::remove_dir_all(&root);
}

/// Regenerating parses megabytes of JSON, and the pass runs on every launch.
#[test]
fn a_current_bundle_is_not_rebuilt() {
    let root = temp_dir("nls-stamp");
    let (runtime, resources) = fake_nls_runtime(
        &root,
        "zh-cn",
        serde_json::json!({ "contents": { "vs/one": { "a": "阿尔法" } } }),
    );
    assert_eq!(
        generate_nls_bundle(&runtime, Some(&resources), "zh-cn"),
        Ok(true)
    );
    let bundle = runtime
        .join("nls")
        .join("abc123")
        .join("1.126.04524")
        .join("zh-cn")
        .join("nls.messages.js");
    let before = std::fs::metadata(&bundle)
        .and_then(|meta| meta.modified())
        .expect("mtime");

    std::thread::sleep(std::time::Duration::from_millis(20));
    assert_eq!(
        generate_nls_bundle(&runtime, Some(&resources), "zh-cn"),
        Ok(true)
    );

    let after = std::fs::metadata(&bundle)
        .and_then(|meta| meta.modified())
        .expect("mtime");
    assert_eq!(before, after, "an unchanged bundle was rebuilt");
    let _ = std::fs::remove_dir_all(&root);
}

/// A hand-maintained counter has to be remembered; a digest cannot be
/// forgotten. Changing any input this module rewrites has to move the URL, or
/// the webview keeps serving the previous bytes from a year-long cache.
#[test]
fn the_asset_revision_follows_what_the_runtime_serves() {
    let shipped = Path::new(env!("CARGO_MANIFEST_DIR")).join("resources");
    let with_assets = asset_revision(Some(&shipped));
    println!("asset revision for the shipped resources: {with_assets}");

    assert_eq!(with_assets.len(), 8, "{with_assets}");
    assert!(with_assets.chars().all(|c| c.is_ascii_hexdigit()));
    // Stable across calls: an unstable suffix would re-download 17 MB of
    // workbench on every launch.
    assert_eq!(with_assets, asset_revision(Some(&shipped)));
    // The brand assets are part of it, so a build without them is a different
    // revision rather than silently the same one.
    assert_ne!(with_assets, asset_revision(None));
}

/// Patching a served file in place changes nothing a user sees: the workbench's
/// static route is cached for a year and its URL does not move. This is what
/// makes every other rewrite in this module actually reach the screen.
#[test]
fn asset_urls_move_when_the_bytes_behind_them_change() {
    let root = temp_dir("cache-bust");
    let (runtime, _) = fake_nls_runtime(&root, "zh-cn", serde_json::json!({ "contents": {} }));

    bust_static_cache(&runtime, None).expect("first bust");
    let commit = |dir: &Path| -> String {
        let product: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("product.json")).expect("read product"),
        )
        .expect("parse product");
        product["commit"].as_str().expect("commit").to_string()
    };
    let once = commit(&runtime);
    assert_ne!(once, "abc123", "the asset URL prefix did not move");
    assert!(once.starts_with("abc123"), "{once}");
    // Both sides of the handshake have to agree, or the workbench cannot open a
    // management socket at all.
    let bundle = std::fs::read_to_string(runtime_file(&runtime, WORKBENCH_BUNDLE)).expect("read");
    assert!(
        bundle.contains(&format!(r#"commit:"{once}""#)),
        "the page would still announce the old commit: {bundle}"
    );

    // Idempotent: this runs on every launch, and a prefix that moved each time
    // would re-download 17 MB of workbench on every start.
    bust_static_cache(&runtime, None).expect("second bust");
    assert_eq!(commit(&runtime), once);
    let _ = std::fs::remove_dir_all(&root);
}

/// Moving only the server's copy of the commit does not degrade to a stale
/// editor — it degrades to `Client refused: version mismatch` and no editor at
/// all. A runtime whose page bundle cannot be rewritten has to keep its cached
/// assets instead.
#[test]
fn the_prefix_stays_put_when_the_page_cannot_be_moved_with_it() {
    let root = temp_dir("cache-bust-atomic");
    let (runtime, _) = fake_nls_runtime(&root, "zh-cn", serde_json::json!({ "contents": {} }));
    std::fs::write(
        runtime_file(&runtime, WORKBENCH_BUNDLE),
        r#"var p={nameLong:"SomniQ Code",commit:"something else entirely"};"#,
    )
    .expect("rewrite bundle");

    let error = bust_static_cache(&runtime, None).expect_err("the move must be refused");
    assert!(error.contains("leaving the asset URLs"), "{error}");

    let product: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(runtime.join("product.json")).expect("read product"),
    )
    .expect("parse product");
    assert_eq!(
        product["commit"],
        serde_json::json!("abc123"),
        "the server moved without the page"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A later revision has to *replace* the marker, not stack another one behind
/// it, or the id would grow without bound across upgrades.
#[test]
fn a_new_revision_replaces_the_previous_marker() {
    let root = temp_dir("cache-bust-restack");
    let (runtime, _) = fake_nls_runtime(&root, "zh-cn", serde_json::json!({ "contents": {} }));
    std::fs::write(
        runtime.join("product.json"),
        r#"{"commit":"abc123-aris0","version":"1.126.04524","quality":"stable"}"#,
    )
    .expect("seed an older marker");
    std::fs::write(
        runtime_file(&runtime, WORKBENCH_BUNDLE),
        r#"var p={nameLong:"SomniQ Code",commit:"abc123-aris0"};"#,
    )
    .expect("seed the matching page bundle");

    bust_static_cache(&runtime, None).expect("bust");

    let product: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(runtime.join("product.json")).expect("read product"),
    )
    .expect("parse product");
    let commit = product["commit"].as_str().expect("commit");
    assert_eq!(commit.matches("-aris").count(), 1, "{commit}");
    assert!(commit.starts_with("abc123-aris"), "{commit}");
    let _ = std::fs::remove_dir_all(&root);
}

/// Message bundles are addressed by commit, so the ones built under the old
/// prefix become unreachable the moment it moves.
#[test]
fn moving_the_prefix_drops_message_bundles_it_orphans() {
    let root = temp_dir("cache-bust-nls");
    let (runtime, resources) = fake_nls_runtime(
        &root,
        "zh-cn",
        serde_json::json!({ "contents": { "vs/one": { "a": "阿尔法" } } }),
    );
    generate_nls_bundle(&runtime, Some(&resources), "zh-cn").expect("build");
    assert!(runtime.join("nls").join("abc123").exists());

    bust_static_cache(&runtime, None).expect("bust");

    assert!(
        !runtime.join("nls").join("abc123").exists(),
        "an orphaned bundle was left behind"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// Unlike the browser side — which only ever receives `embedderIdentifier` and
/// `extensionsGallery` — the Node server reads `product.json` normally, which
/// is what makes this one key enough to switch the whole workbench over.
#[test]
fn the_base_url_points_at_the_servers_own_static_route() {
    let root = temp_dir("nls-base-url");
    let (runtime, _) = fake_nls_runtime(&root, "zh-cn", serde_json::json!({ "contents": {} }));

    set_nls_base_url(&runtime).expect("set base url");

    let product: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(runtime.join("product.json")).expect("read product"),
    )
    .expect("parse product");
    assert_eq!(
        product["nlsCoreBaseUrl"],
        serde_json::json!("/stable-abc123/static/nls/")
    );
    // The other keys have to survive: the server reads its own identity from
    // this file.
    assert_eq!(product["commit"], serde_json::json!("abc123"));

    // Idempotent, because it runs on every launch.
    let before = std::fs::read_to_string(runtime.join("product.json")).expect("read");
    set_nls_base_url(&runtime).expect("second pass");
    assert_eq!(
        std::fs::read_to_string(runtime.join("product.json")).expect("read"),
        before
    );
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------
// Bundled runtime (offline installer variant)
// ---------------------------------------------------------------------------

#[test]
fn no_bundled_runtime_means_the_download_path() {
    assert!(bundled_archive(None).is_none());

    let root = temp_dir("no-bundle");
    std::fs::create_dir_all(&root).expect("create");
    assert!(
        bundled_archive(Some(&root)).is_none(),
        "an empty resource dir must not look like a bundled runtime"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_bundled_runtime_is_found_under_its_pinned_version() {
    let Some(slug) = target_slug() else { return };
    let root = temp_dir("bundle");
    let dir = root.join("code").join(RUNTIME_VERSION);
    std::fs::create_dir_all(&dir).expect("create");
    let archive = dir.join(bundled_asset_name(slug));
    std::fs::write(&archive, b"tar").expect("write");

    assert_eq!(bundled_archive(Some(&root)), Some(archive));
    let _ = std::fs::remove_dir_all(&root);
}

/// A payload left over from a previous pinned version must be ignored rather
/// than extracted over the version we actually want to run.
#[test]
fn a_bundled_runtime_for_another_version_is_ignored() {
    let Some(slug) = target_slug() else { return };
    let root = temp_dir("bundle-stale");
    let dir = root.join("code").join("0.0.1");
    std::fs::create_dir_all(&dir).expect("create");
    std::fs::write(dir.join(bundled_asset_name(slug)), b"tar").expect("write");

    assert!(bundled_archive(Some(&root)).is_none());
    let _ = std::fs::remove_dir_all(&root);
}

/// The bundled tar is deliberately *not* gzipped, so the installer's LZMA is
/// not asked to compress an already-compressed file.
#[test]
fn the_bundled_asset_is_an_uncompressed_tar() {
    let Some(slug) = target_slug() else { return };
    assert!(bundled_asset_name(slug).ends_with(".tar"));
    assert!(!bundled_asset_name(slug).ends_with(".tar.gz"));
    assert!(asset_name(slug).ends_with(".tar.gz"));
}

/// `build-vscodium-resource.cjs` fetches and names the payload from its own
/// copy of the version and checksum. If they drift from these, the offline
/// installer ships a runtime this code will not recognise as installed.
#[test]
fn pinned_runtime_matches_the_offline_build_script() {
    let script = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("scripts")
            .join("build-vscodium-resource.cjs"),
    )
    .expect("read the offline build script");

    assert!(
        script.contains(&format!(r#"RUNTIME_VERSION = "{RUNTIME_VERSION}""#)),
        "the build script pins a different runtime version than codeserver.rs"
    );
    let expected = expected_sha256("win32-x64").expect("pinned checksum");
    assert!(
        script.contains(&format!(r#"SHA256 = "{expected}""#)),
        "the build script pins a different checksum than codeserver.rs"
    );
}
