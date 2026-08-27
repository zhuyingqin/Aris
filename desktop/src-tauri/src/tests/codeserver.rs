use super::{
    asset_name, bundled_archive, bundled_asset_name, download_urls, download_verified_to, ensure,
    expected_sha256, folder_uri_path, hex_digest, is_installed, marker_path, node_binary,
    apply_patch, parse_bound_port, random_token, server_args, server_entry, target_slug,
    version_dir, workbench_bundle, workbench_host, workbench_url, Inner, Patch, Phase, SilentSink,
    CODE_HOST, PATCHES, PORT_RANGE, RUNTIME_VERSION,
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
        ensure(&SilentSink, &inner, None, None, None, None).expect("busy ensure returns status");

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
    let result = ensure(&SilentSink, &inner, None, None, None, None);

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
    let workbench = std::fs::read_to_string(workbench_bundle(&version_dir()))
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

fn write_workbench(dir: &Path, body: &str) -> PathBuf {
    let path = workbench_bundle(dir);
    std::fs::create_dir_all(path.parent().expect("parent")).expect("create bundle dir");
    std::fs::write(&path, body).expect("write bundle");
    path
}

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

/// Every replacement has to change something, and none may reintroduce another
/// rule's search text — a table like that would keep rewriting on every pass.
#[test]
fn the_patch_table_is_well_formed() {
    for patch in PATCHES {
        assert_ne!(patch.find, patch.replace, "a no-op replacement");
        for other in PATCHES {
            assert!(
                !patch.replace.contains(other.find),
                "a replacement contains another rule's search text, so applying                  the table twice would keep rewriting"
            );
        }
    }
}

/// A patch whose search text is multi-byte must not slice a UTF-8 boundary
/// while clamping the anchor window.
#[test]
fn an_anchor_window_landing_mid_character_is_safe() {
    let patch = Patch {
        anchor: Some("anchor"),
        find: "needle",
        replace: "x",
    };
    let mut body = format!("anchor{}needle", "中".repeat(500));

    // Only asserting that this does not panic; the window ends inside the CJK
    // run, so the match is legitimately out of reach.
    let _ = apply_patch(&mut body, &patch);
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
