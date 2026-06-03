//! `flow` — P0 of the ARIS dynamic-workflow runtime.
//!
//! A [`FlowDef`] is a reusable DAG of steps that serializes to `flow.json`. Running
//! it produces an append-only event log plus a content-addressed result store under
//! `.clawd-flows/<run_id>/`. Those two artifacts deliver the P0 goals:
//!
//! * **Reuse** — a flow is a serializable artifact (`flow.json`) re-runnable with `args`.
//! * **Rewind** — [`fold`] reconstructs run state at any point in its history.
//! * **Resume / fork** — completed steps replay from the [`store`] by content address;
//!   forking from a step re-executes it (and everything downstream) on a new run.
//!
//! Only [`StepKind::Llm`] executes in P0, piloted on MiniMax; the type model already
//! carries the seams (per-step [`def::RoleRef`] in the cache key) for P1 heterogeneous
//! agents, P2 fan-out, and the P4 agent-team controller.

// Product/identifier names (MiniMax, OpenAI, run_id, …) trip doc_markdown constantly;
// silence it for this crate, matching the workspace's relaxed pedantic posture.
#![allow(clippy::doc_markdown)]

pub mod def;
pub mod error;
pub mod event;
pub mod provider;
pub mod run;
pub mod store;

pub use def::{
    default_minimax_role, idea_pilot, Binding, CachePolicy, FlowDef, Ref, RoleRef, Step, StepId,
    StepKind,
};
pub use error::{FlowError, Result};
pub use event::{fold, read_entries, FlowEvent, FlowEventLog, LogEntry, RunState};
pub use provider::{strip_think, Completer, Completion, MiniMaxProvider};
pub use run::{
    default_provider_factory, read_manifest, FlowRunner, ProviderFactory, RunManifest, RunOutcome,
};
pub use store::{compute_key, flows_root, run_dir, StepKey, StepResult, StepStore};
