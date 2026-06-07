use std::ffi::OsStr;
use std::process::Command;

pub fn hidden_command<S>(program: S) -> Command
where
    S: AsRef<OsStr>,
{
    runtime::hidden_command(program)
}
