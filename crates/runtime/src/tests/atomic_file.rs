use super::write_replace;
use std::{
    sync::{Arc, Barrier},
    thread,
};

#[cfg(windows)]
use std::time::Duration;

#[test]
fn write_replace_creates_and_replaces_file() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "aris-runtime-atomic-file-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("session.json");

    write_replace(&path, b"old").expect("initial write");
    write_replace(&path, b"new").expect("replacement write");

    assert_eq!(std::fs::read(&path).expect("read file"), b"new");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn concurrent_replacements_complete_without_file_access_errors() {
    const WRITERS: usize = 8;
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "aris-runtime-atomic-file-concurrent-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("session.json");
    write_replace(&path, b"initial").expect("initial write");

    let start = Arc::new(Barrier::new(WRITERS));
    let mut writers = Vec::new();
    for index in 0..WRITERS {
        let path = path.clone();
        let start = Arc::clone(&start);
        writers.push(thread::spawn(move || {
            start.wait();
            write_replace(&path, format!("writer-{index}"))
        }));
    }
    for writer in writers {
        writer
            .join()
            .expect("writer thread should not panic")
            .expect("concurrent replacement should succeed");
    }

    let value = String::from_utf8(std::fs::read(&path).expect("read final file"))
        .expect("replacement body is UTF-8");
    assert!(value.starts_with("writer-"));
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(windows)]
#[test]
fn write_replace_retries_a_transient_windows_share_violation() {
    use std::os::windows::fs::OpenOptionsExt;

    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "aris-runtime-atomic-file-retry-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let path = dir.join("session.json");
    write_replace(&path, b"old").expect("initial write");

    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&path)
        .expect("hold target without delete sharing");
    let writer_path = path.clone();
    let writer = thread::spawn(move || write_replace(&writer_path, b"new"));
    thread::sleep(Duration::from_millis(30));
    drop(held);

    writer
        .join()
        .expect("writer thread should not panic")
        .expect("retry should persist after the target is released");
    assert_eq!(std::fs::read(&path).expect("read replacement"), b"new");
    let _ = std::fs::remove_dir_all(dir);
}

#[cfg(windows)]
#[test]
fn write_replace_waits_for_a_readable_windows_handle_to_release_delete_sharing() {
    use std::os::windows::fs::OpenOptionsExt;

    let temp = tempfile::tempdir().expect("temporary workspace");
    let dir = temp.path().join("答辩 资料");
    std::fs::create_dir(&dir).expect("Unicode directory");
    let path = dir.join("main.tex");
    write_replace(&path, b"old").expect("initial write");
    // Readers may still inspect the source while an editor or watcher denies
    // delete sharing. Atomic replacement needs that sharing to be released.
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2) // FILE_SHARE_READ | FILE_SHARE_WRITE
        .open(&path)
        .expect("hold readable target without delete sharing");
    assert_eq!(
        std::fs::read(&path).expect("source remains readable"),
        b"old"
    );

    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let writer_path = path.clone();
    let writer = thread::spawn(move || {
        started_tx.send(()).expect("signal writer start");
        write_replace(&writer_path, b"new")
    });
    started_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("writer should start");
    thread::sleep(Duration::from_millis(600));
    drop(held);

    writer
        .join()
        .expect("writer thread should not panic")
        .expect("replacement should survive a 600ms editor or watcher lock");
    assert_eq!(std::fs::read(&path).expect("read replacement"), b"new");
    assert_eq!(std::fs::read_dir(&dir).expect("list directory").count(), 1);
}

#[cfg(windows)]
#[test]
fn write_replace_preserves_the_original_under_a_persistent_windows_handle_lock() {
    use std::os::windows::fs::OpenOptionsExt;

    let temp = tempfile::tempdir().expect("temporary workspace");
    let path = temp.path().join("main.tex");
    write_replace(&path, b"original source").expect("initial write");
    let held = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0x1 | 0x2) // FILE_SHARE_READ | FILE_SHARE_WRITE
        .open(&path)
        .expect("hold readable target without delete sharing");

    let error = write_replace(&path, b"replacement source")
        .expect_err("a persistent handle lock must refuse replacement");
    assert_windows_replace_failure(&error, &path);

    assert_eq!(
        std::fs::read(&path).expect("read unchanged target"),
        b"original source"
    );
    assert_eq!(
        std::fs::read_dir(temp.path())
            .expect("list directory after failed replacement")
            .count(),
        1,
        "failed replacement must remove its temporary file"
    );
    drop(held);
}

#[cfg(windows)]
#[test]
fn write_replace_respects_a_readonly_windows_target_and_keeps_its_attributes() {
    let temp = tempfile::tempdir().expect("temporary workspace");
    let path = temp.path().join("main.tex");
    write_replace(&path, b"original source").expect("initial write");
    let original_permissions = std::fs::metadata(&path).expect("metadata").permissions();
    let mut readonly_permissions = original_permissions.clone();
    readonly_permissions.set_readonly(true);
    std::fs::set_permissions(&path, readonly_permissions).expect("mark target readonly");

    let result = write_replace(&path, b"replacement source");
    let after = std::fs::read(&path).expect("read readonly target");
    let still_readonly = std::fs::metadata(&path)
        .expect("metadata after refused replacement")
        .permissions()
        .readonly();
    let entries = std::fs::read_dir(temp.path())
        .expect("list directory after refused replacement")
        .count();
    // Restore only this disposable test file's original attributes so its
    // temporary directory can be removed, even when an assertion below fails.
    std::fs::set_permissions(&path, original_permissions).expect("restore test attributes");

    let error = result.expect_err("readonly targets must not be overwritten");
    assert_windows_replace_failure(&error, &path);
    assert_eq!(after, b"original source");
    assert!(
        still_readonly,
        "a failed write must preserve readonly attributes"
    );
    assert_eq!(entries, 1, "failed writes must not leak temporary files");
}

#[cfg(windows)]
fn assert_windows_replace_failure(error: &std::io::Error, path: &std::path::Path) {
    let report: serde_json::Value =
        serde_json::from_str(&error.to_string()).expect("structured atomic write diagnostic");
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(report["ok"], false);
    assert_eq!(report["code"], "atomic_write_failed");
    assert_eq!(report["stage"], "replace_destination");
    assert_eq!(report["filePath"], path.to_string_lossy().as_ref());
    assert!(
        matches!(report["osErrorCode"].as_i64(), Some(5) | Some(32)),
        "retain the Windows access or sharing violation code: {report}"
    );
}
