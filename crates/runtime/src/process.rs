use std::ffi::OsStr;
use std::process::Command;

use tokio::process::Command as TokioCommand;

#[must_use]
pub fn hidden_command<S>(program: S) -> Command
where
    S: AsRef<OsStr>,
{
    let mut command = Command::new(program);
    hide_window(&mut command);
    command
}

#[must_use]
pub fn hidden_tokio_command<S>(program: S) -> TokioCommand
where
    S: AsRef<OsStr>,
{
    let mut command = TokioCommand::new(program);
    hide_window(command.as_std_mut());
    command
}

pub fn hide_window(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    #[cfg(not(windows))]
    let _ = command;
}

#[cfg(all(test, windows))]
mod tests {
    use super::{hidden_command, hidden_tokio_command};

    #[test]
    fn runs_hidden_std_process() {
        let mut command = hidden_command("cmd");
        let output = command
            .args(["/C", "exit", "0"])
            .output()
            .expect("hidden std command should run");
        assert!(output.status.success());
    }

    #[tokio::test]
    async fn runs_hidden_tokio_process() {
        let mut command = hidden_tokio_command("cmd");
        let output = command
            .args(["/C", "exit", "0"])
            .output()
            .await
            .expect("hidden tokio command should run");
        assert!(output.status.success());
    }
}
