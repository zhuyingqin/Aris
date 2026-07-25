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
