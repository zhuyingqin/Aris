//! Agent threads in the desktop: one [`AgentControl`] per project, shared by
//! every chat of that project (docs/development-logic/multi-agent-threads.md).
//!
//! A chat is the root (`/root`) of its own agent tree. This module is the
//! desktop's side of the contract the shared control states: it opens the
//! control for a project, registers a chat's turn as a root, joins the
//! runtime's lifecycle and mail hooks onto that turn, and carries Stop and
//! deletion down to the agents below a chat.
//!
//! Agents the control creates live in `<sessions dir>/agents/`. That directory
//! also holds their event logs, so nothing in the user's own session list
//! (which only looks at the sessions directory itself) can mistake one for a chat.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use runtime::agent_control::{
    is_agent_session_id, AgentControl, AgentControlConfig, AgentEventRecorder,
};
use runtime::{ApiClient, ConversationRuntime, EventSink, TeeEventSink, ToolExecutor};

const AGENTS_DIR: &str = "agents";

/// Controls opened so far, by the sessions directory of their project. A
/// project's agents are one registry: every chat of the project shares it, and
/// opening a second one on the same directory would split the tree in two.
static CONTROLS: OnceLock<Mutex<HashMap<PathBuf, AgentControl>>> = OnceLock::new();

fn controls() -> &'static Mutex<HashMap<PathBuf, AgentControl>> {
    CONTROLS.get_or_init(Mutex::default)
}

/// Where a project's agent bookkeeping and agent sessions live.
pub(crate) fn agents_dir(sessions_dir: &Path) -> PathBuf {
    sessions_dir.join(AGENTS_DIR)
}

/// Writes an agent event to the log of the session it is about. An agent's own
/// session is created by the control, so no directory is registered for it yet
/// when its first event arrives: those go to the agents directory by their id.
/// Every other session is a chat whose directory its turn has bound.
fn recorder_for(sessions_dir: &Path) -> AgentEventRecorder {
    let agents_dir = agents_dir(sessions_dir);
    Arc::new(move |session_id, kind, payload| {
        if is_agent_session_id(session_id) {
            crate::chat_events::record_event_in_dir(&agents_dir, session_id, kind, payload);
        } else {
            crate::chat_events::record_event(session_id, kind, payload);
        }
    })
}

/// The control of the project whose sessions live in `sessions_dir`, opened the
/// first time it is asked for. `None` only when the bookkeeping cannot be
/// opened; the chat then simply runs without agent features, as it did before
/// they existed.
pub(crate) fn control_for(sessions_dir: &Path) -> Option<AgentControl> {
    let mut open = controls().lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(control) = open.get(sessions_dir) {
        return Some(control.clone());
    }
    match AgentControl::open(
        AgentControlConfig::new(agents_dir(sessions_dir)),
        recorder_for(sessions_dir),
    ) {
        Ok(control) => {
            if !control.owns_directory() {
                eprintln!(
                    "SomniQ desktop: another process is running agents in {}; its agents are left alone",
                    sessions_dir.display()
                );
            }
            open.insert(sessions_dir.to_path_buf(), control.clone());
            Some(control)
        }
        Err(error) => {
            eprintln!(
                "SomniQ desktop: agent bookkeeping for {} is unavailable: {error}",
                sessions_dir.display()
            );
            None
        }
    }
}

/// Forget a project's control, so the lock file it holds open can be deleted
/// together with a test's temporary directory.
#[cfg(test)]
pub(crate) fn evict_control(sessions_dir: &Path) {
    controls()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(sessions_dir);
}

fn open_controls() -> Vec<(PathBuf, AgentControl)> {
    controls()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .map(|(sessions_dir, control)| (sessions_dir.clone(), control.clone()))
        .collect()
}

/// One chat turn's place in its project's agent tree.
#[derive(Clone)]
pub(crate) struct TurnAgent {
    control: AgentControl,
    session_id: String,
    turn_id: String,
}

impl TurnAgent {
    /// Make `session_id` the root of its tree for the turn `turn_id`. Asking
    /// again for a chat that is already a root returns that root, so a chat
    /// registers on every turn it runs.
    pub(crate) fn register(
        sessions_dir: &Path,
        session_id: &str,
        turn_id: &str,
        project_id: Option<&str>,
    ) -> Option<Self> {
        let control = control_for(sessions_dir)?;
        match control
            .register_root(session_id, project_id)
            .and_then(|_| control.begin_turn(session_id, turn_id))
        {
            Ok(_) => Some(Self {
                control,
                session_id: session_id.to_string(),
                turn_id: turn_id.to_string(),
            }),
            Err(error) => {
                eprintln!("SomniQ desktop: chat {session_id} is not an agent root: {error}");
                None
            }
        }
    }

    #[must_use]
    pub(crate) fn control(&self) -> &AgentControl {
        &self.control
    }

    #[must_use]
    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }

    #[must_use]
    pub(crate) fn turn_id(&self) -> &str {
        &self.turn_id
    }
}

/// Give a chat turn's runtime its event sink, and with it the agent hooks.
///
/// A runtime has one sink, so the desktop's own is joined with the control's
/// lifecycle sink: the chat's status follows its turns, and the result of a
/// finished sub-agent turn reaches the parent. The runtime also asks the
/// chat's mailbox for mail before each model request. Without an agent (an
/// ephemeral turn, or bookkeeping that would not open) only the desktop sink
/// is installed, exactly as before.
pub(crate) fn attach_to_runtime<C, T>(
    agent: Option<&TurnAgent>,
    runtime: ConversationRuntime<C, T>,
    desktop_sink: Box<dyn EventSink>,
) -> ConversationRuntime<C, T>
where
    C: ApiClient,
    T: ToolExecutor,
{
    let Some(agent) = agent else {
        return runtime.with_event_sink(desktop_sink);
    };
    let lifecycle = agent
        .control
        .lifecycle_sink(&agent.session_id, Some(&agent.turn_id));
    let input = agent
        .control
        .turn_input_source(&agent.session_id, Some(&agent.turn_id));
    runtime
        .with_event_sink(Box::new(
            TeeEventSink::new()
                .with(desktop_sink)
                .with(Box::new(lifecycle)),
        ))
        .with_turn_input_source(Box::new(input))
}

/// Stop: raise the cancellation flag of every agent below the chat, its
/// Reviewer included. The chat's own turn is cancelled by the caller; this
/// reaches the agents that turn is waiting on, which no flag of the turn does.
pub(crate) fn cancel_session_tree(session_id: &str) {
    for (_, control) in open_controls() {
        control.cancel_subtree(session_id);
    }
}

pub(crate) fn shutdown() {
    stop_all("application exited; continue explicitly from the saved checkpoint");
}

pub(crate) fn stop_all(reason: &str) {
    for (_, control) in open_controls() {
        // Keep contracts, checkpoints and unconsumed mail for explicit recovery.
        for agent in control.roots() {
            control.cancel_subtree_with_reason(&agent, reason);
        }
    }
}

/// The chat is being deleted: close it and everything below it, and delete the
/// sessions of those agents, which have no meaning without their chat. Safe to
/// call for a chat that never had an agent.
pub(crate) fn forget_session(session_id: &str) {
    crate::engine::collaboration::discard_session(session_id);
    crate::review_thread::discard_session(session_id);
    for (sessions_dir, control) in open_controls() {
        let Ok(report) = control.close(session_id, "session deleted") else {
            continue;
        };
        if let Some(error) = report.persistence_error {
            eprintln!("SomniQ desktop: could not record the closing of chat {session_id}: {error}");
        }
        let agents_dir = agents_dir(&sessions_dir);
        for agent_session_id in report
            .closed
            .iter()
            .filter(|id| is_agent_session_id(id.as_str()))
        {
            remove_agent_session_files(&agents_dir, agent_session_id);
        }
    }
}

/// Delete every file an agent's session left in the agents directory.
fn remove_agent_session_files(agents_dir: &Path, agent_session_id: &str) {
    let prefix = format!("{agent_session_id}.");
    let Ok(entries) = fs::read_dir(agents_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let belongs = entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(&prefix));
        if belongs {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
#[path = "tests/agent_threads.rs"]
pub(crate) mod tests;
