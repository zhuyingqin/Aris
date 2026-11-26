use super::*;

#[test]
fn identity_is_the_lowercased_image_file_name() {
    assert_eq!(
        exe_file_name(r"C:\Program Files\Microsoft\Edge\Application\MSEDGE.EXE"),
        "msedge.exe"
    );
    assert_eq!(exe_file_name("/usr/bin/Code.exe"), "code.exe");
    assert_eq!(exe_file_name("notepad.exe"), "notepad.exe");
}

#[test]
fn somniq_credentials_and_password_managers_are_protected() {
    for image in [
        r"E:\Programs\SomniQ Studio\SomniQ Studio.exe",
        r"F:\Agent\Aris\desktop\src-tauri\target\debug\aris-desktop.exe",
        r"C:\Windows\System32\consent.exe",
        r"C:\Windows\System32\CredentialUIBroker.exe",
        r"C:\Windows\System32\Taskmgr.exe",
        r"C:\Program Files\KeePassXC\KeePassXC.exe",
        "",
    ] {
        assert_eq!(classify(image).tier, Tier::Protected, "{image}");
    }
}

#[test]
fn messaging_remote_desktop_and_other_agents_are_protected() {
    for image in [
        r"C:\Program Files\Tencent\QQNT\QQ.exe",
        r"C:\Program Files\Tencent\Weixin\Weixin.exe",
        r"C:\Program Files (x86)\WXWork\WXWork.exe",
        r"C:\Program Files\Mozilla Thunderbird\thunderbird.exe",
        r"C:\Program Files\RustDesk\rustdesk.exe",
        r"C:\Users\u\AppData\Local\AnthropicClaude\claude.exe",
        r"C:\Users\u\AppData\Local\Programs\ChatGPT\ChatGPT.exe",
    ] {
        assert_eq!(classify(image).tier, Tier::Protected, "{image}");
    }
}

#[test]
fn browsers_terminals_and_ides_are_read_only() {
    for image in [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        r"C:\Users\u\AppData\Local\Programs\Microsoft VS Code\Code.exe",
        r"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal\WindowsTerminal.exe",
    ] {
        assert_eq!(classify(image).tier, Tier::ReadOnly, "{image}");
    }
}

#[test]
fn everything_else_requires_an_explicit_grant() {
    for image in [
        r"C:\Windows\explorer.exe",
        r"C:\Program Files\WindowsApps\Microsoft.WindowsNotepad\Notepad\Notepad.exe",
        r"E:\Program Files (x86)\WPSOffice\WPS Office\12.1.0.29690\office6\wps.exe",
        r"C:\Windows\System32\ApplicationFrameHost.exe",
    ] {
        assert_eq!(classify(image).tier, Tier::RequiresGrant, "{image}");
    }
}

#[test]
fn only_the_powershell_hosted_fixture_window_is_actionable() {
    let host = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
    assert!(is_fixture_window("SomniQ CU R0 Fixture run-1", host));
    assert!(is_fixture_window("SomniQ CU R0 Fixture", r"C:\pwsh\pwsh.exe"));
    // A document or page can copy the title, but not the host process.
    assert!(!is_fixture_window(
        "SomniQ CU R0 Fixture run-1",
        r"C:\Windows\System32\notepad.exe"
    ));
    assert!(!is_fixture_window("Fixture SomniQ CU R0", host));
    assert!(!is_fixture_window("", host));
}
