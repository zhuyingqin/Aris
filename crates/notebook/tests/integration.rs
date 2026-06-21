//! M1 acceptance: a reusable kernel session that persists state across executes,
//! plus document edit round-trips. Kernel tests skip gracefully when no Jupyter
//! kernel is installed (e.g. CI without ipykernel).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use notebook::{CellOutput, ExecStatus, KernelManager, NotebookDoc};

fn stdout_text(outputs: &[CellOutput]) -> String {
    outputs
        .iter()
        .filter_map(|o| match o {
            CellOutput::Stream { name, text } if name == "stdout" => Some(text.clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn kernel_runs_and_persists_state_across_cells() {
    let workdir = std::env::temp_dir();
    let id = format!("aris-test-{}", std::process::id());

    let info = match KernelManager::start(&id, None, &workdir) {
        Ok(info) => info,
        // Skip ONLY when there is genuinely no kernel to test against (e.g. CI).
        // Any other error (connection, handshake, port race not recovered) is a
        // real failure and must not hide as a skip.
        Err(e) if e.to_string().contains("no Jupyter kernelspec installed") => {
            eprintln!("SKIP kernel test (no kernel installed): {e}");
            return;
        }
        Err(e) => panic!("kernel failed to start: {e}"),
    };
    assert!(info.pid > 0, "kernel should report a pid");

    // Cell 1 sets state; Cell 2 reads it -> proves the session is long-lived.
    let out1 = KernelManager::execute(&id, "x = 41", Duration::from_secs(30)).unwrap();
    assert_eq!(out1.status, ExecStatus::Ok, "assignment should succeed");

    let out2 = KernelManager::execute(&id, "print(x + 1)", Duration::from_secs(30)).unwrap();
    assert_eq!(out2.status, ExecStatus::Ok);
    let text = stdout_text(&out2.outputs);
    assert!(
        text.contains("42"),
        "expected '42' from persisted state, got {text:?}"
    );

    // execute_result path (a bare expression).
    let out3 = KernelManager::execute(&id, "6 * 7", Duration::from_secs(30)).unwrap();
    assert_eq!(out3.status, ExecStatus::Ok);
    assert!(
        out3.execution_count.is_some(),
        "execute_result carries a count"
    );

    // Error path must be reported, not swallowed.
    let out4 =
        KernelManager::execute(&id, "raise ValueError('boom')", Duration::from_secs(30)).unwrap();
    assert_eq!(out4.status, ExecStatus::Error);

    KernelManager::shutdown(&id).unwrap();
    assert!(!KernelManager::is_running(&id));
}

#[test]
fn execute_streaming_reports_outputs_before_return() {
    let workdir = std::env::temp_dir();
    let id = format!("aris-stream-{}", std::process::id());

    match KernelManager::start(&id, None, &workdir) {
        Ok(_) => {}
        Err(e) if e.to_string().contains("no Jupyter kernelspec installed") => {
            eprintln!("SKIP streaming test (no kernel installed): {e}");
            return;
        }
        Err(e) => panic!("kernel failed to start: {e}"),
    }

    let streamed = Arc::new(Mutex::new(String::new()));
    let streamed_cb = streamed.clone();
    let out = KernelManager::execute_streaming(
        &id,
        "print('alpha')\nprint('beta')",
        Duration::from_secs(30),
        move |output| {
            if let CellOutput::Stream { name, text } = output {
                if name == "stdout" {
                    streamed_cb.lock().unwrap().push_str(&text);
                }
            }
        },
    )
    .unwrap();

    assert_eq!(out.status, ExecStatus::Ok);
    let streamed = streamed.lock().unwrap().clone();
    assert!(
        streamed.contains("alpha"),
        "streamed stdout missing alpha: {streamed:?}"
    );
    assert!(
        streamed.contains("beta"),
        "streamed stdout missing beta: {streamed:?}"
    );
    let final_text = stdout_text(&out.outputs);
    assert!(final_text.contains("alpha") && final_text.contains("beta"));

    KernelManager::shutdown(&id).unwrap();
}

#[test]
fn interrupt_stops_a_runaway_cell() {
    let workdir = std::env::temp_dir();
    let id = format!("aris-int-{}", std::process::id());

    match KernelManager::start(&id, None, &workdir) {
        Ok(_) => {}
        Err(e) if e.to_string().contains("no Jupyter kernelspec installed") => {
            eprintln!("SKIP interrupt test (no kernel installed): {e}");
            return;
        }
        Err(e) => panic!("kernel failed to start: {e}"),
    }

    let started = std::time::Instant::now();
    // Fire the interrupt from another thread shortly after the (blocking)
    // execute starts. This exercises the Windows JPY_INTERRUPT_EVENT path + the
    // POSIX control-message path; either way the cell must stop well before its
    // sleep.
    let int_id = id.clone();
    let interrupter = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        KernelManager::interrupt(&int_id).expect("interrupt should reach a running kernel");
    });

    // A busy loop would blow the 25s timeout if the interrupt did nothing.
    // On Windows, ipykernel's event poller raises KeyboardInterrupt via
    // `_thread.interrupt_main()`, which cannot immediately break C-level calls
    // like `time.sleep`, so this uses bytecode that checks pending interrupts.
    let out =
        KernelManager::execute(&id, "while True:\n    pass", Duration::from_secs(25)).unwrap();
    let elapsed = started.elapsed();
    interrupter.join().unwrap();

    assert_eq!(
        out.status,
        ExecStatus::Error,
        "interrupted cell should report Error (KeyboardInterrupt), got {:?}",
        out.status
    );
    assert!(
        elapsed < Duration::from_secs(15),
        "interrupt should stop the cell quickly, took {elapsed:?}"
    );

    // The kernel must survive the interrupt and keep executing.
    let after = KernelManager::execute(&id, "1 + 1", Duration::from_secs(30)).unwrap();
    assert_eq!(
        after.status,
        ExecStatus::Ok,
        "kernel should survive interrupt"
    );

    KernelManager::shutdown(&id).unwrap();
}

#[test]
fn doc_edit_roundtrip_validates_against_nbformat() {
    let mut doc = NotebookDoc::new_empty();
    assert!(doc.is_empty());

    assert_eq!(doc.append("code", "print('hi')").unwrap(), 0);
    doc.append("markdown", "# title").unwrap();
    doc.insert(1, "code", "y = 2").unwrap();
    assert_eq!(doc.len(), 3);

    doc.replace_source(0, "print('bye')").unwrap();
    assert_eq!(doc.cell_source(0).unwrap(), "print('bye')");

    let outline = doc.outline();
    assert_eq!(outline[0].cell_type, "code");
    assert_eq!(outline[1].cell_type, "code");
    assert_eq!(outline[2].cell_type, "markdown");

    doc.delete(1).unwrap();
    assert_eq!(doc.len(), 2);

    // Out-of-range edits are errors, not panics.
    assert!(doc.delete(99).is_err());

    // Save then reload: this reparses through nbformat, validating the JSON we wrote.
    let tmp = std::env::temp_dir().join(format!("aris-doc-{}.ipynb", std::process::id()));
    doc.save(&tmp).unwrap();
    let reloaded = NotebookDoc::load(&tmp).unwrap();
    assert_eq!(reloaded.len(), 2);
    let _ = std::fs::remove_file(&tmp);
}
