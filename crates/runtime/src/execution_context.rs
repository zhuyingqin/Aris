use std::cell::RefCell;
use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Immutable process-like context for one project-bound execution.
///
/// Desktop keeps a process-wide environment for its currently visible project,
/// but a Chat turn may outlive that selection. Project-bound work therefore
/// carries this context explicitly instead of temporarily mutating `std::env`
/// and the process working directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectExecutionContext {
    current_dir: PathBuf,
    environment: BTreeMap<OsString, Option<OsString>>,
}

impl ProjectExecutionContext {
    #[must_use]
    pub fn new(current_dir: impl Into<PathBuf>) -> Self {
        Self {
            current_dir: current_dir.into(),
            environment: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn with_env(mut self, name: impl Into<OsString>, value: impl Into<OsString>) -> Self {
        self.environment.insert(name.into(), Some(value.into()));
        self
    }

    #[must_use]
    pub fn without_env(mut self, name: impl Into<OsString>) -> Self {
        self.environment.insert(name.into(), None);
        self
    }

    #[must_use]
    pub fn current_dir(&self) -> &Path {
        &self.current_dir
    }

    /// Apply this context to the Desktop's process-wide active-project state.
    /// Long-running turns use [`with_project_execution_context`] instead.
    pub fn apply_to_current_process(&self) -> io::Result<()> {
        for (name, value) in &self.environment {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
        std::env::set_current_dir(&self.current_dir)
    }

    fn apply_to_command(&self, command: &mut Command) {
        command.current_dir(&self.current_dir);
        for (name, value) in &self.environment {
            match value {
                Some(value) => {
                    command.env(name, value);
                }
                None => {
                    command.env_remove(name);
                }
            }
        }
    }

    fn env_var_os(&self, name: &OsStr) -> Option<Option<OsString>> {
        self.environment.get(name).cloned()
    }
}

thread_local! {
    static PROJECT_EXECUTION_CONTEXTS: RefCell<Vec<ProjectExecutionContext>> = const { RefCell::new(Vec::new()) };
}

struct ProjectExecutionContextGuard;

impl Drop for ProjectExecutionContextGuard {
    fn drop(&mut self) {
        PROJECT_EXECUTION_CONTEXTS.with(|contexts| {
            contexts.borrow_mut().pop();
        });
    }
}

/// Run one synchronous operation with an immutable project binding.
///
/// The binding is thread-local by design. Callers that fan work out to another
/// thread must pass the context to that worker and enter it there as well.
pub fn with_project_execution_context<T>(
    context: &ProjectExecutionContext,
    action: impl FnOnce() -> T,
) -> T {
    PROJECT_EXECUTION_CONTEXTS.with(|contexts| {
        contexts.borrow_mut().push(context.clone());
    });
    let _guard = ProjectExecutionContextGuard;
    action()
}

#[must_use]
pub fn execution_env_var_os(name: impl AsRef<OsStr>) -> Option<OsString> {
    let name = name.as_ref();
    let scoped = PROJECT_EXECUTION_CONTEXTS.with(|contexts| {
        contexts
            .borrow()
            .last()
            .and_then(|context| context.env_var_os(name))
    });
    scoped.unwrap_or_else(|| std::env::var_os(name))
}

pub fn execution_current_dir() -> io::Result<PathBuf> {
    PROJECT_EXECUTION_CONTEXTS
        .with(|contexts| {
            contexts
                .borrow()
                .last()
                .map(|context| context.current_dir.clone())
        })
        .map_or_else(std::env::current_dir, Ok)
}

/// Give a child process the project binding active on this worker thread.
/// Child processes cannot observe Rust thread-local state, so the context must
/// be copied into their own cwd/environment before spawn.
pub(crate) fn apply_project_execution_context_to_command(command: &mut Command) {
    PROJECT_EXECUTION_CONTEXTS.with(|contexts| {
        if let Some(context) = contexts.borrow().last() {
            context.apply_to_command(command);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        execution_current_dir, execution_env_var_os, with_project_execution_context,
        ProjectExecutionContext,
    };

    #[test]
    fn scoped_context_does_not_mutate_process_environment() {
        let original = std::env::var_os("ARIS_WORKSPACE_ROOT");
        let root = std::env::temp_dir().join("somniq-project-context-a");
        let context = ProjectExecutionContext::new(&root)
            .with_env("ARIS_WORKSPACE_ROOT", root.as_os_str())
            .with_env("ARIS_DESKTOP_PROJECT_ID", "project-a");

        with_project_execution_context(&context, || {
            assert_eq!(execution_current_dir().expect("scoped cwd"), root);
            assert_eq!(
                execution_env_var_os("ARIS_DESKTOP_PROJECT_ID"),
                Some(OsString::from("project-a"))
            );
            assert_eq!(std::env::var_os("ARIS_WORKSPACE_ROOT"), original);
        });

        assert_eq!(std::env::var_os("ARIS_WORKSPACE_ROOT"), original);
    }

    #[test]
    fn scoped_context_is_copied_into_child_processes() {
        let root = std::env::temp_dir().join("somniq-project-context-child");
        std::fs::create_dir_all(&root).expect("child cwd");
        let context = ProjectExecutionContext::new(&root)
            .with_env("ARIS_DESKTOP_PROJECT_ID", "project-child");
        let output = with_project_execution_context(&context, || {
            if cfg!(windows) {
                crate::hidden_command("cmd")
                    .args(["/C", "echo %ARIS_DESKTOP_PROJECT_ID% & cd"])
                    .output()
            } else {
                crate::hidden_command("sh")
                    .args([
                        "-c",
                        "printf '%s\\n%s' \"$ARIS_DESKTOP_PROJECT_ID\" \"$PWD\"",
                    ])
                    .output()
            }
        })
        .expect("scoped child process");
        assert!(output.status.success());
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("project-child"));
        assert!(stdout
            .to_ascii_lowercase()
            .contains(&root.display().to_string().to_ascii_lowercase()));
        let _ = std::fs::remove_dir_all(root);
    }

    use std::ffi::OsString;
}
