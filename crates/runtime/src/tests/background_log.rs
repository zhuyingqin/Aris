use super::{create, slug};
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_workspace(name: &str) -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let root = std::env::temp_dir().join(format!("somniq-background-log-{name}-{nanos}"));
    fs::create_dir_all(&root).expect("create temp workspace");
    root
}

#[test]
fn creates_a_named_capture_file_under_the_workspace() {
    let workspace = temp_workspace("create");
    let log = create(&workspace, "npm run dev -- --port 5173").expect("log should be created");

    assert!(
        std::path::Path::new(&log.display()).is_file(),
        "the capture file exists before the process is spawned"
    );
    assert!(log.display().contains(".somniq/tmp/background/"));
    assert!(
        log.display().ends_with("-npm-run-dev-port-5173.log"),
        "the file name should hint at the command: {}",
        log.display()
    );

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn both_streams_write_to_the_same_file() {
    let workspace = temp_workspace("streams");
    let log = create(&workspace, "serve").expect("log should be created");

    #[cfg(windows)]
    let mut command = {
        let mut command = crate::hidden_command("cmd");
        command.args(["/C", "echo out& echo err 1>&2"]);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = crate::hidden_command("sh");
        command.args(["-lc", "printf out; printf err >&2"]);
        command
    };
    command
        .stdout(log.stdout().expect("stdout handle"))
        .stderr(log.stderr().expect("stderr handle"));
    assert!(command.status().expect("command should run").success());

    let captured = fs::read_to_string(log.display()).expect("log should be readable");
    assert!(captured.contains("out"), "stdout captured: {captured:?}");
    assert!(captured.contains("err"), "stderr captured: {captured:?}");

    fs::remove_dir_all(workspace).expect("cleanup");
}

#[test]
fn slugs_stay_short_and_filesystem_safe() {
    assert_eq!(slug("npm run dev"), "npm-run-dev");
    assert_eq!(slug("./scripts/serve.sh --watch"), "scripts-serve-sh-watch");
    assert_eq!(slug("!!!"), "command");
    assert!(slug(&"a".repeat(200)).chars().count() <= 40);
    assert!(!slug("python -m http.server").contains(' '));
}

#[test]
fn returns_none_when_the_capture_directory_cannot_be_created() {
    let workspace = temp_workspace("unwritable");
    let not_a_directory = workspace.join("regular-file");
    fs::write(&not_a_directory, b"").expect("seed a regular file");

    // `.somniq/tmp/background/` cannot be created underneath a file, and the
    // command must still be allowed to run without a log.
    assert!(create(&not_a_directory, "npm run dev").is_none());

    fs::remove_dir_all(workspace).expect("cleanup");
}
