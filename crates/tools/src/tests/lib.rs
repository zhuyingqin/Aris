#![allow(unused_imports)]
//! Shared imports + fixtures for the `tools` unit tests. Domain-specific
//! test bodies live in sibling files under `lib/` and pull these in via
//! `use super::*;`, so each domain module sees the exact symbol set the
//! former monolithic `tests/lib.rs` provided.
use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::thread;
use std::time::Duration;

use super::{
    agent_permission_policy, allowed_tools_for_subagent, discover_skills, execute_agent_with_spawn,
    execute_tool, execute_tool_with_cancel, execute_tool_with_context, extract_latex_diagnostics,
    final_assistant_text, latex_input_manifest_hash, latex_input_snapshot,
    latex_input_snapshot_changed, latex_pdf_state, latex_pdf_state_after_compile, mvp_tool_specs,
    persist_agent_terminal_state, preferred_latex_engine, render_latex_template,
    repl_invokes_latex_compiler, resolve_anthropic_compat_reviewer_model,
    resolve_existing_workspace_path, resolve_output_workspace_path, resolve_reviewer_model,
    reviewer_stream_observer, route_openai_compat_model, run_llm_review, skill_markdown,
    tex_tool_path, tool_execution, workspace_path_candidate, AgentInput, AgentJob,
    LatexEnginePreference, LatexOutputFingerprint, LatexPdfState, LlmReviewInput,
    SubagentToolExecutor, ToolRunContext,
};
use runtime::{
    ApiRequest, AssistantEvent, ContentBlock, ConversationMessage, ConversationRuntime,
    RuntimeError, Session, TokenUsage, ToolExecution, TurnSummary, ARIS_AGENT_STORE_DIR_ENV,
    ARIS_WORKSPACE_ROOT_ENV, MAX_FILE_TOOL_PAYLOAD_BYTES,
};
use serde_json::json;

fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn temp_path(name: &str) -> PathBuf {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("time")
        .as_nanos();
    std::env::temp_dir().join(format!("clawd-tools-{unique}-{name}"))
}

struct EnvGuard {
    key: &'static str,
    previous: Option<OsString>,
}

impl EnvGuard {
    fn unset(key: &'static str) -> Self {
        let previous = std::env::var_os(key);
        std::env::remove_var(key);
        Self { key, previous }
    }

    fn set(key: &'static str, value: impl AsRef<OsStr>) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        if let Some(previous) = self.previous.as_ref() {
            std::env::set_var(self.key, previous);
        } else {
            std::env::remove_var(self.key);
        }
    }
}

#[path = "lib/agent.rs"]
mod agent;
#[path = "lib/file_ops.rs"]
mod file_ops;
#[path = "lib/latex.rs"]
mod latex;
#[path = "lib/misc.rs"]
mod misc;
#[path = "lib/notebook.rs"]
mod notebook;
#[path = "lib/repl.rs"]
mod repl;
#[path = "lib/reviewer.rs"]
mod reviewer;
#[path = "lib/skill.rs"]
mod skill;
#[path = "lib/web.rs"]
mod web;

/// Full-text search over the project's own PDFs existed only behind a desktop
/// command, so an agent asked about a paper the user already had went to the
/// network and answered from an abstract.
#[test]
fn the_library_full_text_index_is_reachable_as_a_read_only_tool() {
    let spec = mvp_tool_specs()
        .into_iter()
        .find(|spec| spec.name == "LibraryRetrieve")
        .expect("LibraryRetrieve is registered");
    assert_eq!(spec.required_permission, runtime::PermissionMode::ReadOnly);
    assert_eq!(
        crate::tool_execution("LibraryRetrieve"),
        crate::ToolExecution::Parallel
    );
    assert!(spec.input_schema["properties"]["query"].is_object());
}
