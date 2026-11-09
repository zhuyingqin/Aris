use super::*;

#[test]
fn refuses_word_and_wps_automation_before_it_can_touch_an_editor() {
    for source in [
        "$word = New-Object -ComObject Word.Application; $word.Quit()",
        "$wps = New-Object -ComObject 'KWPS.Application'; $wps.Documents.Close()",
        "import win32com.client\nword = win32com.client.Dispatch('Word.Application')\nword.Quit()",
        "win32com.client.DispatchEx(\"Word.Application\")",
        "win32com.client.gencache.EnsureDispatch('WPS.Application')",
        "[Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')",
        "[Type]::GetTypeFromProgID('Word.Application')",
        "CreateObject(\"kwps.Application\")",
        "$progId = 'Word.Application'; $word = New-Object -ComObject $progId; $word.Quit()",
        "win32com.client.GetObject(None, 'Word.Application')",
        "win32com.client.GetObject('paper.docx').Close()",
        "New-Object Microsoft.Office.Interop.Word.ApplicationClass",
    ] {
        let error = check_source(source).expect_err(source);
        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(error.to_string().contains("read_docx/read_file/read_files"));
    }
}

#[test]
fn refuses_ending_editor_processes_by_name() {
    for source in [
        "taskkill /F /IM WINWORD.EXE",
        "taskkill.exe //IM wps.exe //F",
        "Stop-Process -Name WINWORD -Force",
        "Get-Process wps | Stop-Process -Force",
        "Get-Process wpspdf | ForEach-Object { $_.Kill() }",
        "for p in psutil.process_iter():\n if p.name() == 'wps.exe': p.terminate()",
    ] {
        assert!(
            check_source(source)
                .unwrap_err()
                .to_string()
                .contains("unsaved edits"),
            "{source}"
        );
    }
}

#[test]
fn resolves_literal_pids_even_when_process_name_was_in_an_earlier_call() {
    for source in [
        "Stop-Process -Id 3210 -Force",
        "taskkill /PID 3210 /T /F",
        "os.kill(3210, 9)",
        "pid = 3210\npsutil.Process(pid).terminate()",
    ] {
        assert!(has_termination(source));
        assert!(protects_pid(source, |pid| pid == 3210));
        assert!(!protects_pid(source, |pid| pid == 7777));
    }
}

#[cfg(windows)]
#[test]
fn native_pid_lookup_refuses_the_command_and_leaves_the_target_running() {
    use std::process::Stdio;
    let root = tempfile::tempdir().unwrap();
    // Use a disposable command process with an editor image name, never a
    // real Word/WPS instance or a user's document. set /p waits on our pipe.
    let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap());
    let executable = root.path().join("wps.exe");
    std::fs::copy(system.join("System32/cmd.exe"), &executable).unwrap();
    let mut child = crate::hidden_command(&executable)
        .args(["/D", "/Q", "/C", "set /p document_safety_input="])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let result = ensure_document_command_safe(&format!("Stop-Process -Id {} -Force", child.id()));
    let still_running = child.try_wait();
    // Clean up only this owned test process before making assertions.
    let _ = child.kill();
    let _ = child.wait();
    assert!(still_running.unwrap().is_none());
    assert!(result
        .unwrap_err()
        .to_string()
        .contains("target PID belongs to a Word/WPS editor"));
}

#[test]
fn permits_file_parsers_process_queries_and_literal_source_searches() {
    for source in [
        "from docx import Document\ndoc = Document('paper.docx')\nprint(doc.paragraphs[0].text)",
        "with open('paper.docx', 'rb') as file:\n data = file.read()",
        "$zip = [IO.Compression.ZipFile]::OpenRead('paper.docx'); $zip.Dispose()",
        "Get-Process -Name WINWORD",
        "rg -n 'New-Object -ComObject Word.Application' reader.py",
        r#"rg -n 'Dispatch("Word.Application")' reader.py"#,
        "Get-Content 'reader.ps1'",
        "$shell = New-Object -ComObject Shell.Application",
    ] {
        ensure_document_command_safe(source).expect(source);
    }
    assert!(check_source("rg 'Word.Application' file.py; Stop-Process -Name WINWORD").is_err());
    assert!(check_source(r#"rg "$(taskkill /IM WINWORD.EXE /F)" reader.py"#).is_err());
}

#[test]
fn inspects_directly_invoked_helpers_but_does_not_execute_them() {
    let root = tempfile::tempdir().unwrap();
    let script = root.path().join("read word.py");
    std::fs::write(
        &script,
        "word = Dispatch('Word.Application')\nword.Quit()\n",
    )
    .unwrap();
    for command in [
        format!("python \"{}\"", script.display()),
        format!("python3 '{}'", script.display()),
    ] {
        assert!(ensure_document_command_safe(&command).is_err(), "{command}");
    }
    let script = root.path().join("reader.ps1");
    std::fs::write(
        &script,
        "$word = New-Object -ComObject Word.Application\n$word.Quit()",
    )
    .unwrap();
    for command in [
        format!("powershell -NoProfile -File \"{}\"", script.display()),
        format!("& '{}'", script.display()),
        format!(". '{}'", script.display()),
    ] {
        assert!(ensure_document_command_safe(&command).is_err(), "{command}");
    }
    ensure_document_command_safe(&format!("Get-Content '{}'", script.display())).unwrap();
    std::fs::write(&script, "Get-Content 'paper.txt'").unwrap();
    ensure_document_command_safe(&format!("& '{}'", script.display())).unwrap();
    let unsafe_source = "$word = New-Object -ComObject Word.Application\n$word.Quit()";
    let utf16: Vec<u8> = [0xff, 0xfe]
        .into_iter()
        .chain(unsafe_source.encode_utf16().flat_map(u16::to_le_bytes))
        .collect();
    std::fs::write(&script, utf16).unwrap();
    assert!(
        ensure_document_command_safe(&format!("powershell -File '{}'", script.display())).is_err()
    );
}

#[test]
fn locked_reads_offer_a_copy_instead_of_closing_the_editor() {
    for error in [
        io::Error::new(io::ErrorKind::PermissionDenied, "access denied"),
        io::Error::from_raw_os_error(32),
        io::Error::from_raw_os_error(33),
    ] {
        let message = document_read_error(error);
        assert!(message.contains("document_read_unavailable"));
        assert!(message.contains("keeping the editor open"));
        assert!(message.contains("saved copy"));
    }
    assert_eq!(
        document_read_error(io::Error::new(io::ErrorKind::NotFound, "missing")),
        "missing"
    );
}
