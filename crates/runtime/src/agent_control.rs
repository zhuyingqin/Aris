//! Agent threads: who exists, who started whom, what each is doing, and the
//! mail between them.
//!
//! An *agent* is an ordinary SomniQ session plus a place in a tree. The user's
//! chat is `/root`; everything it starts hangs below it (`/root/scout_1`).
//! [`AgentControl`] is the one place that knows the tree. It does not run
//! models: whoever drives an agent's [`crate::ConversationRuntime`] attaches
//! [`AgentControl::lifecycle_sink`] and [`AgentControl::turn_input_source`] to
//! it, and the control does the rest.
//!
//! Invariants this module exists to keep (each has a test):
//!
//! * **Reserved agents are the controller's.** A path segment starting with `~`
//!   (`/root/~reviewer`) can only be created and addressed by controller code.
//!   Everything a model can reach — [`AgentControl::send`],
//!   [`AgentControl::list`], [`AgentControl::resolve`] — treats such an agent as
//!   if it did not exist, so an Executor can neither message nor discover the
//!   independent Reviewer.
//! * **Status is derived, not stored by hand.** An agent's status is a pure
//!   function of the runtime's own turn events ([`agent_status_from_event`]).
//! * **A finished turn reports once.** When a child's turn completes or fails,
//!   exactly one `Result` mail reaches its parent, however many times the same
//!   event is observed.
//! * **Capacity is reserved, never leaked.** A spawn holds its slot and name
//!   through an RAII [`SpawnReservation`]; dropping it without committing gives
//!   both back.
//! * **The tree survives a restart.** Contracts, mail leases and checkpoints
//!   survive in `state.json`; `edges.jsonl` records lineage. Completed and queued
//!   tasks are retained; running tasks become interrupted and require explicit
//!   continuation. Legacy agents without a contract are closed as `Shutdown`.
//!   Recovery is checked, not assumed: the control holds an exclusive file lock on
//!   `.owner.lock` for as long as it lives, and only a control that got the
//!   lock may reap. The lock dies with its process, so a crash releases it,
//!   while a second running instance cannot take it and leaves the first
//!   one's agents alone.
//! * **Locks never wrap callbacks.** Events reach the recorder only after the
//!   internal lock is released, so a recorder may call back into the control.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fmt;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::conversation::{TurnInput, TurnInputSource};
use crate::event_sink::{now_iso8601, EventSink, EventType, RuntimeEvent, TurnOutcome};

/// The path of the user's own conversation, the root of every tree.
pub const ROOT_AGENT_PATH: &str = "/root";
/// Agents a model or the user may have alive at once under one root.
pub const DEFAULT_MAX_THREADS: usize = 2;
/// How deep the model-visible tree may grow. `1` means sub-agents cannot start
/// sub-agents of their own.
pub const DEFAULT_MAX_DEPTH: usize = 1;
/// Controller-owned agents (the Reviewer and its forks) have their own budget so
/// they can never be crowded out by, or crowd out, the agents a model starts.
pub const DEFAULT_MAX_RESERVED_THREADS: usize = 4;

/// `agent.*` event kinds written to a session's event log.
pub const EVENT_AGENT_LINEAGE: &str = "agent.lineage";
pub const EVENT_AGENT_SPAWN: &str = "agent.spawn";
pub const EVENT_AGENT_MAIL_SENT: &str = "agent.mail.sent";
pub const EVENT_AGENT_MAIL_DELIVERED: &str = "agent.mail.delivered";
pub const EVENT_AGENT_RESULT: &str = "agent.result";
pub const EVENT_AGENT_CLOSE: &str = "agent.close";
/// Written by the Reviewer integration, not by this module.
pub const EVENT_AGENT_REVIEW_REQUEST: &str = "agent.review.request";
pub const EVENT_AGENT_REVIEW_VERDICT: &str = "agent.review.verdict";

const MAX_SEGMENT_CHARS: usize = 32;
const MAX_ROLE_CHARS: usize = 32;
const MAX_SESSION_ID_CHARS: usize = 128;
const MAX_MAIL_CONTENT_CHARS: usize = 60_000;
/// What controller code may deliver. A model's mail is bounded tightly because
/// another model wrote it; the controller builds its packets itself (a first
/// review packet runs to a hundred thousand characters) and bounds them first.
const MAX_CONTROLLER_MAIL_CONTENT_CHARS: usize = 240_000;
const EDGE_LOG_FILE: &str = "edges.jsonl";
const EDGE_LOG_VERSION: u32 = 1;
/// Exclusive lock a control holds for its whole life; see [`AgentControl::open`].
const OWNER_LOCK_FILE: &str = ".owner.lock";
/// Every agent session id the control mints starts with this, so code outside
/// can tell an agent's session from a user's chat by the id alone.
const AGENT_SESSION_ID_PREFIX: &str = "agent";
/// A blocked wait wakes this often to look at its cancellation flag, so Stop
/// reaches it promptly even if no mail ever arrives.
const WAIT_SLICE: Duration = Duration::from_millis(250);
const RESERVED_PREFIX: char = '~';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Why an agent operation was refused. The messages are written to be shown to
/// a model as a tool error, so they say what to do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentControlError {
    InvalidPath(String),
    InvalidName(String),
    /// A model or user tried to use a name the controller keeps for itself.
    ReservedName(String),
    /// No such agent, or one the caller is not allowed to know about. The two
    /// are deliberately indistinguishable.
    UnknownAgent(String),
    AgentClosed(String),
    DepthLimit {
        max_depth: usize,
    },
    CapacityReached {
        max_threads: usize,
    },
    NameInUse(String),
    NotPermitted(String),
    /// The edge log could not be written, so the change was not made.
    Persistence(String),
}

impl fmt::Display for AgentControlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidPath(path) => write!(f, "`{path}` is not a valid agent path"),
            Self::InvalidName(message) => write!(f, "invalid agent name: {message}"),
            Self::ReservedName(name) => write!(f, "the name `{name}` is reserved"),
            Self::UnknownAgent(target) => write!(f, "no agent named `{target}`"),
            Self::AgentClosed(target) => write!(f, "agent `{target}` has been closed"),
            Self::DepthLimit { max_depth } => write!(
                f,
                "agents may be nested at most {max_depth} level(s) deep; do this work yourself or from the agent that owns it"
            ),
            Self::CapacityReached { max_threads } => write!(
                f,
                "at most {max_threads} agents can exist at once; reuse an existing idle agent with followup_task, or close one through its controller"
            ),
            Self::NameInUse(name) => write!(f, "an agent named `{name}` already exists here"),
            Self::NotPermitted(message) => f.write_str(message),
            Self::Persistence(message) => write!(f, "could not record the agent tree: {message}"),
        }
    }
}

impl std::error::Error for AgentControlError {}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// An agent's absolute place in its tree: `/root`, `/root/scout_1`,
/// `/root/~reviewer`.
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct AgentPath(String);

impl AgentPath {
    #[must_use]
    pub fn root() -> Self {
        Self(ROOT_AGENT_PATH.to_string())
    }

    /// Parse an absolute path such as `/root/scout_1`.
    pub fn parse(path: &str) -> Result<Self, AgentControlError> {
        let invalid = || AgentControlError::InvalidPath(path.to_string());
        if path == ROOT_AGENT_PATH {
            return Ok(Self::root());
        }
        let rest = path
            .strip_prefix(ROOT_AGENT_PATH)
            .and_then(|rest| rest.strip_prefix('/'))
            .ok_or_else(invalid)?;
        for segment in rest.split('/') {
            if !is_valid_segment(segment) {
                return Err(invalid());
            }
        }
        Ok(Self(path.to_string()))
    }

    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }

    #[must_use]
    pub fn is_root(&self) -> bool {
        self.0 == ROOT_AGENT_PATH
    }

    /// Whether any segment is one the controller keeps for itself.
    #[must_use]
    pub fn is_reserved(&self) -> bool {
        self.segments()
            .any(|segment| segment.starts_with(RESERVED_PREFIX))
    }

    /// The last segment (`scout_1` for `/root/scout_1`).
    #[must_use]
    pub fn name(&self) -> &str {
        self.0.rsplit('/').next().unwrap_or("root")
    }

    /// Number of levels below the root: `/root` is 0, `/root/a` is 1.
    #[must_use]
    pub fn depth(&self) -> usize {
        self.segments().count()
    }

    #[must_use]
    pub fn parent(&self) -> Option<Self> {
        if self.is_root() {
            return None;
        }
        let (parent, _) = self.0.rsplit_once('/')?;
        Some(Self(parent.to_string()))
    }

    /// Whether this path is `ancestor` or lies below it.
    #[must_use]
    pub fn is_within(&self, ancestor: &Self) -> bool {
        self.0 == ancestor.0
            || self
                .0
                .strip_prefix(ancestor.0.as_str())
                .is_some_and(|rest| rest.starts_with('/'))
    }

    /// The child called `name`, for a name a model or user chose. A reserved
    /// (`~`) name is refused: only [`Self::join_reserved`] can make one.
    pub fn join(&self, name: &str) -> Result<Self, AgentControlError> {
        if name.starts_with(RESERVED_PREFIX) {
            return Err(AgentControlError::ReservedName(name.to_string()));
        }
        if !is_valid_segment(name) {
            return Err(AgentControlError::InvalidName(format!(
                "`{name}` must be 1-{MAX_SEGMENT_CHARS} characters of a-z, 0-9 or _"
            )));
        }
        Ok(Self(format!("{}/{name}", self.0)))
    }

    /// The controller-only child called `name`, which must start with `~`.
    pub fn join_reserved(&self, name: &str) -> Result<Self, AgentControlError> {
        if !name.starts_with(RESERVED_PREFIX) || !is_valid_segment(name) {
            return Err(AgentControlError::InvalidName(format!(
                "a reserved name starts with `{RESERVED_PREFIX}` followed by a-z, 0-9 or _, got `{name}`"
            )));
        }
        Ok(Self(format!("{}/{name}", self.0)))
    }

    /// Resolve what a caller wrote — an absolute path, or a name below `self` —
    /// without deciding whether the caller may see the result.
    fn resolve_reference(&self, reference: &str) -> Result<Self, AgentControlError> {
        let reference = reference.trim();
        if reference.is_empty() {
            return Err(AgentControlError::InvalidPath(String::new()));
        }
        if reference.starts_with('/') {
            return Self::parse(reference);
        }
        Self::parse(&format!("{}/{reference}", self.0))
    }

    fn segments(&self) -> impl Iterator<Item = &str> {
        self.0.split('/').skip(2)
    }
}

impl fmt::Display for AgentPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl TryFrom<String> for AgentPath {
    type Error = AgentControlError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<AgentPath> for String {
    fn from(path: AgentPath) -> Self {
        path.0
    }
}

fn is_valid_segment(segment: &str) -> bool {
    let body = segment.strip_prefix(RESERVED_PREFIX).unwrap_or(segment);
    !body.is_empty()
        && segment.chars().count() <= MAX_SEGMENT_CHARS
        && body != "root"
        && body
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_')
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// What an agent is doing, as told by the runtime's own turn events.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "state", content = "message", rename_all = "snake_case")]
pub enum AgentStatus {
    /// Registered, no turn has started yet.
    PendingInit,
    Running,
    Waiting,
    /// The last turn was cancelled. The agent is still there and can be asked
    /// to do more.
    Interrupted,
    /// The last turn finished; carries its final answer.
    Completed(Option<String>),
    Errored(String),
    /// Closed, or left open by a process that is gone.
    Shutdown,
    NotFound,
}

impl AgentStatus {
    /// Whether the agent's current turn has a settled outcome. `Interrupted` is
    /// not settled: the work was stopped, not answered.
    #[must_use]
    pub fn is_final(&self) -> bool {
        !matches!(
            self,
            Self::PendingInit | Self::Running | Self::Waiting | Self::Interrupted
        )
    }

    fn label(&self) -> &'static str {
        match self {
            Self::PendingInit => "pending_init",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Interrupted => "interrupted",
            Self::Completed(_) => "completed",
            Self::Errored(_) => "errored",
            Self::Shutdown => "shutdown",
            Self::NotFound => "not_found",
        }
    }
}

/// The agent status a runtime event implies, or `None` when the event does not
/// change it. This is the only way a status moves.
#[must_use]
pub fn agent_status_from_event(event: &EventType) -> Option<AgentStatus> {
    match event {
        EventType::TurnStarted => Some(AgentStatus::Running),
        EventType::TurnFinished {
            outcome: TurnOutcome::Completed,
            last_message,
        } => Some(AgentStatus::Completed(last_message.clone())),
        EventType::TurnFinished {
            outcome: TurnOutcome::Interrupted,
            ..
        } => Some(AgentStatus::Interrupted),
        EventType::TurnFinished {
            outcome: TurnOutcome::Failed { message },
            ..
        } => Some(AgentStatus::Errored(message.clone())),
        EventType::SessionEnd => Some(AgentStatus::Shutdown),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

/// Who caused an agent to exist.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpawnOrigin {
    /// A model called a spawn tool.
    Model,
    /// Controller code, such as the Reviewer or a workflow fan-out.
    Controller,
    /// The user started it by hand.
    User,
    WorkTask,
    Scheduled,
}

impl SpawnOrigin {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Model => "model",
            Self::Controller => "controller",
            Self::User => "user",
            Self::WorkTask => "work_task",
            Self::Scheduled => "scheduled",
        }
    }
}

/// Where an agent came from. Written once, when it is created.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLineage {
    pub root_session_id: String,
    pub session_id: String,
    pub parent_session_id: Option<String>,
    /// The parent's turn that caused the spawn.
    pub parent_turn_id: Option<String>,
    pub origin: SpawnOrigin,
    /// The tool-use id, controller action id, command id or task id behind it.
    pub spawn_ref: Option<String>,
    pub path: AgentPath,
    pub role: String,
    pub depth: usize,
    pub project_id: Option<String>,
    pub created_at: String,
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MailKind {
    /// Work to do.
    Task,
    /// Information, no action implied.
    Message,
    /// A child turn's outcome, sent by the control itself.
    Result,
    /// Controller to Reviewer.
    ReviewRequest,
    /// Reviewer to controller.
    Verdict,
}

impl MailKind {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Task => "task",
            Self::Message => "message",
            Self::Result => "result",
            Self::ReviewRequest => "review_request",
            Self::Verdict => "verdict",
        }
    }

    /// Only these two can be sent by a model. A model cannot forge a `Result`
    /// from a child, or a Reviewer's request or verdict.
    #[must_use]
    pub fn model_may_send(self) -> bool {
        matches!(self, Self::Task | Self::Message)
    }
}

/// What caused a piece of mail, so a trace can draw the edge.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MailCause {
    /// The sender's turn.
    pub turn_id: Option<String>,
    pub tool_use_id: Option<String>,
    pub action_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentMail {
    pub id: String,
    pub root_session_id: String,
    pub author: AgentPath,
    pub author_session_id: String,
    pub recipient: AgentPath,
    pub recipient_session_id: String,
    pub kind: MailKind,
    pub content: String,
    /// Whether the recipient should start a turn for this if it is idle. The
    /// control only records the wish; whoever drives the recipient acts on it.
    pub trigger_turn: bool,
    pub cause: MailCause,
    pub created_at: String,
}

/// A message a model asks to send. Resolved and checked against what the author
/// is allowed to reach.
#[derive(Clone, Debug)]
pub struct SendRequest {
    pub author_session_id: String,
    /// A name below the author, or an absolute path.
    pub target: String,
    pub kind: MailKind,
    pub content: String,
    pub trigger_turn: bool,
    pub cause: MailCause,
}

/// Mail sent by controller code, which may use every kind and reach every
/// agent, reserved ones included.
#[derive(Clone, Debug)]
pub struct ControllerMail {
    pub author_session_id: String,
    pub recipient: AgentPath,
    pub kind: MailKind,
    pub content: String,
    pub trigger_turn: bool,
    pub cause: MailCause,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MailReceipt {
    pub mail_id: String,
    pub recipient: AgentPath,
    pub recipient_session_id: String,
    pub trigger_turn: bool,
}

/// How a wait for mail ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MailWait {
    Mail,
    TimedOut,
    Cancelled,
    /// The agent was closed, or never existed.
    Closed,
}

// ---------------------------------------------------------------------------
// Public data
// ---------------------------------------------------------------------------

/// Where `edges.jsonl` lives and how large a tree may grow.
#[derive(Clone, Debug)]
pub struct AgentControlConfig {
    /// Directory for this project's agent bookkeeping.
    pub agents_dir: PathBuf,
    pub max_threads: usize,
    pub max_depth: usize,
    pub max_reserved_threads: usize,
}

impl AgentControlConfig {
    #[must_use]
    pub fn new(agents_dir: impl Into<PathBuf>) -> Self {
        Self {
            agents_dir: agents_dir.into(),
            max_threads: DEFAULT_MAX_THREADS,
            max_depth: DEFAULT_MAX_DEPTH,
            max_reserved_threads: DEFAULT_MAX_RESERVED_THREADS,
        }
    }
}

/// Receives `(session_id, kind, payload)` for every `agent.*` event, to be
/// appended to that session's event log.
pub type AgentEventRecorder = Arc<dyn Fn(&str, &str, Value) + Send + Sync>;

/// Everything a driver needs to run an agent.
#[derive(Clone, Debug)]
pub struct AgentHandle {
    pub session_id: String,
    pub root_session_id: String,
    pub path: AgentPath,
    /// Raised by [`AgentControl::cancel_subtree`] and [`AgentControl::close`].
    /// The driver wires it into the agent's runtime so Stop reaches it.
    pub cancel: Arc<AtomicBool>,
}

/// A point-in-time view of one agent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub revision: u64,
    pub resumable: bool,
    pub session_id: String,
    pub root_session_id: String,
    pub parent_session_id: Option<String>,
    pub path: AgentPath,
    pub role: String,
    pub depth: usize,
    pub origin: SpawnOrigin,
    pub status: AgentStatus,
    pub pending_mail: usize,
    pub project_id: Option<String>,
    pub task: Option<AgentTask>,
    pub last_activity: Option<String>,
    pub interruption_reason: Option<String>,
}

/// The auditable contract of a read-only delegation. Never contains credentials.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTask {
    pub reason: String,
    pub task: String,
    pub inputs: String,
    pub deliverable: String,
    pub stop_condition: String,
    pub model: String,
    pub connection: String,
    pub permission: String,
    pub workspace: String,
    pub max_iterations: usize,
    pub max_seconds: u64,
}

#[derive(Clone, Debug)]
pub struct SpawnRequest {
    pub parent_session_id: String,
    /// The new agent's name below its parent. Controller code may use a
    /// reserved `~name`; nobody else may.
    pub name: String,
    pub role: String,
    pub origin: SpawnOrigin,
    pub spawn_ref: Option<String>,
    pub parent_turn_id: Option<String>,
}

/// An agent found still open by [`AgentControl::open`]: its process is gone.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RecoveredAgent {
    pub lineage: AgentLineage,
    pub status: AgentStatus,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CloseReport {
    /// Every agent closed, deepest first.
    pub closed: Vec<String>,
    /// Set when the edge log could not be updated. The agents are closed in
    /// memory regardless.
    pub persistence_error: Option<String>,
}

// ---------------------------------------------------------------------------
// Edge log
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeStatus {
    Open,
    Closed,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EdgeRow {
    v: u32,
    ts: String,
    status: EdgeStatus,
    child: String,
    /// Present on the `open` row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lineage: Option<AgentLineage>,
    /// Present on the `closed` row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

/// One parent-to-child link as the log leaves it: what was opened, and whether
/// and why it was closed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentEdge {
    pub child: String,
    pub lineage: Option<AgentLineage>,
    pub status: EdgeStatus,
    pub closed_reason: Option<String>,
}

/// Fold an edge log into one record per child, last row wins.
fn fold_edges(rows: Vec<EdgeRow>) -> Vec<AgentEdge> {
    let mut order = Vec::new();
    let mut edges: HashMap<String, AgentEdge> = HashMap::new();
    for row in rows {
        let edge = edges.entry(row.child.clone()).or_insert_with(|| {
            order.push(row.child.clone());
            AgentEdge {
                child: row.child.clone(),
                lineage: None,
                status: EdgeStatus::Open,
                closed_reason: None,
            }
        });
        if row.lineage.is_some() {
            edge.lineage = row.lineage;
        }
        edge.status = row.status;
        edge.closed_reason = match row.status {
            EdgeStatus::Closed => row.reason,
            EdgeStatus::Open => None,
        };
    }
    order
        .into_iter()
        .filter_map(|child| edges.remove(&child))
        .collect()
}

fn read_edge_rows(path: &Path) -> Vec<EdgeRow> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let mut reader = BufReader::new(file);
    let mut rows = Vec::new();
    let mut line = Vec::new();
    loop {
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                // A damaged row, even one that is not valid UTF-8, must not hide
                // the rest of the tree.
                if let Ok(row) =
                    serde_json::from_str::<EdgeRow>(String::from_utf8_lossy(&line).trim())
                {
                    rows.push(row);
                }
            }
        }
    }
    rows
}

/// Read a project's edge log. Used by the trace reducer.
#[must_use]
pub fn read_edges(agents_dir: &Path) -> Vec<AgentEdge> {
    fold_edges(read_edge_rows(&agents_dir.join(EDGE_LOG_FILE)))
}

fn append_edge_rows(path: &Path, rows: &[EdgeRow]) -> Result<(), AgentControlError> {
    let persistence = |error: std::io::Error| AgentControlError::Persistence(error.to_string());
    let mut text = String::new();
    for row in rows {
        text.push_str(
            &serde_json::to_string(row)
                .map_err(|error| AgentControlError::Persistence(error.to_string()))?,
        );
        text.push('\n');
    }
    crate::with_path_lock(path, || {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(persistence)?;
        }
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(persistence)?;
        file.write_all(text.as_bytes()).map_err(persistence)
    })
}

fn open_row(lineage: &AgentLineage) -> EdgeRow {
    EdgeRow {
        v: EDGE_LOG_VERSION,
        ts: now_iso8601(),
        status: EdgeStatus::Open,
        child: lineage.session_id.clone(),
        lineage: Some(lineage.clone()),
        reason: None,
    }
}

fn closed_row(child: &str, reason: &str) -> EdgeRow {
    EdgeRow {
        v: EDGE_LOG_VERSION,
        ts: now_iso8601(),
        status: EdgeStatus::Closed,
        child: child.to_string(),
        lineage: None,
        reason: Some(reason.to_string()),
    }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct AgentRecord {
    #[serde(default)]
    revision: u64,
    lineage: AgentLineage,
    status: AgentStatus,
    mailbox: VecDeque<AgentMail>,
    #[serde(skip, default = "fresh_cancel")]
    cancel: Arc<AtomicBool>,
    closed: bool,
    /// Turns this agent has started.
    turn_seq: u64,
    /// The turn whose outcome was last reported to the parent. Compared with
    /// `turn_seq` so a repeated event cannot send the same result twice.
    result_turn_seq: Option<u64>,
    current_turn_id: Option<String>,
    #[serde(default)]
    retired_turns: HashSet<String>,
    #[serde(default)]
    inflight: Vec<AgentMail>,
    #[serde(default)]
    task: Option<AgentTask>,
    #[serde(default)]
    last_activity: Option<String>,
    #[serde(default)]
    interruption_reason: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct Tree {
    /// Live (registered, not closed) agents by path.
    paths: BTreeMap<AgentPath, String>,
    /// Paths promised to a [`SpawnReservation`] that has not committed.
    #[serde(skip)]
    pending: HashSet<AgentPath>,
}

#[derive(Default, Serialize, Deserialize)]
struct State {
    agents: HashMap<String, AgentRecord>,
    trees: HashMap<String, Tree>,
}

impl State {
    /// Live agents below `target` (inclusive), deepest first.
    fn subtree(&self, root_session_id: &str, target: &AgentPath) -> Vec<String> {
        let Some(tree) = self.trees.get(root_session_id) else {
            return Vec::new();
        };
        let mut members = tree
            .paths
            .iter()
            .filter(|(path, _)| path.is_within(target))
            .collect::<Vec<_>>();
        members.sort_by(|(left, _), (right, _)| {
            right
                .depth()
                .cmp(&left.depth())
                .then_with(|| left.cmp(right))
        });
        members.into_iter().map(|(_, id)| id.clone()).collect()
    }

    fn info(&self, session_id: &str) -> Option<AgentInfo> {
        self.agents.get(session_id).map(|record| AgentInfo {
            revision: record.revision,
            resumable: !record.closed && record.task.is_some(),
            session_id: record.lineage.session_id.clone(),
            root_session_id: record.lineage.root_session_id.clone(),
            parent_session_id: record.lineage.parent_session_id.clone(),
            path: record.lineage.path.clone(),
            role: record.lineage.role.clone(),
            depth: record.lineage.depth,
            origin: record.lineage.origin,
            status: record.status.clone(),
            pending_mail: record.mailbox.len(),
            project_id: record.lineage.project_id.clone(),
            task: record.task.clone(),
            last_activity: record.last_activity.clone(),
            interruption_reason: record.interruption_reason.clone(),
        })
    }
}

struct PendingEvent {
    session_id: String,
    kind: &'static str,
    payload: Value,
}

struct Inner {
    config: AgentControlConfig,
    recorder: AgentEventRecorder,
    edge_log: PathBuf,
    /// The directory's ownership lock, or `None` when another process has it.
    /// Dropping the file releases the lock.
    owner_lock: Mutex<Option<fs::File>>,
    state: Mutex<State>,
    persistence_error: Mutex<Option<String>>,
    /// Signalled whenever mail arrives or an agent closes.
    changed: Condvar,
    nonce: String,
    sequence: AtomicU64,
    recovered: Vec<RecoveredAgent>,
}

impl Inner {
    fn persist(&self, state: &State) -> Result<(), AgentControlError> {
        let result = self.persist_state(state);
        *self
            .persistence_error
            .lock()
            .unwrap_or_else(PoisonError::into_inner) =
            result.as_ref().err().map(ToString::to_string);
        result
    }

    fn persist_state(&self, state: &State) -> Result<(), AgentControlError> {
        if self
            .owner_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_none()
        {
            return Err(AgentControlError::Persistence(
                "another process owns the agent directory".into(),
            ));
        }
        let bytes = serde_json::to_vec(state)
            .map_err(|error| AgentControlError::Persistence(error.to_string()))?;
        crate::write_file_atomically(&self.config.agents_dir.join("state.json"), bytes)
            .map_err(|error| AgentControlError::Persistence(error.to_string()))
    }
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn next_id(&self, prefix: &str) -> String {
        let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{}-{sequence}", self.nonce)
    }

    /// Hand events to the recorder. Always called with the state lock released.
    fn flush(&self, events: Vec<PendingEvent>) {
        if let Err(error) = self.persist(&self.lock()) {
            eprintln!("agent state checkpoint failed: {error}");
        }
        for event in events {
            (self.recorder)(&event.session_id, event.kind, event.payload);
        }
    }
}

// ---------------------------------------------------------------------------
// AgentControl
// ---------------------------------------------------------------------------

/// The registry of one project's agents. Cheap to clone; clones share state.
#[derive(Clone)]
pub struct AgentControl {
    inner: Arc<Inner>,
}

impl AgentControl {
    /// Open a project's agent bookkeeping, recovering from the edge log.
    ///
    /// With directory ownership, restore mail and contracts without starting
    /// workers. Running tasks become interrupted; queued and completed tasks
    /// keep their state. Legacy agents with no task contract are closed.
    ///
    /// That holds only for the process that owns the directory, which is the one
    /// that takes the exclusive lock on `.owner.lock` here and keeps it until
    /// the last clone of the control is dropped. When another live process
    /// already holds it, or the lock cannot be set up at all, nothing proves an
    /// open edge is abandoned, so this control recovers nothing and the edge log
    /// is left exactly as it is; [`Self::owns_directory`] says which case it is.
    pub fn open(
        config: AgentControlConfig,
        recorder: AgentEventRecorder,
    ) -> Result<Self, AgentControlError> {
        let edge_log = config.agents_dir.join(EDGE_LOG_FILE);
        let owner_lock = acquire_owner_lock(&config.agents_dir);
        let orphans = if owner_lock.is_some() {
            fold_edges(read_edge_rows(&edge_log))
                .into_iter()
                .filter(|edge| edge.status == EdgeStatus::Open)
                .collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        // Restore contracts and delivery progress, never restart workers here.
        // A snapshot is authoritative for mail; the edge log remains an audit log.
        let mut restored: State = if owner_lock.is_some() {
            match fs::read(config.agents_dir.join("state.json")) {
                Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                    AgentControlError::Persistence(format!("invalid agent checkpoint: {error}"))
                })?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => State::default(),
                Err(error) => return Err(AgentControlError::Persistence(error.to_string())),
            }
        } else {
            State::default()
        };
        restored.trees.clear();
        for record in restored.agents.values_mut() {
            record.revision = record.revision.saturating_add(1);
            if record.lineage.parent_session_id.is_some() && record.task.is_none() {
                record.closed = true;
                record.status = AgentStatus::Shutdown;
            } else if matches!(record.status, AgentStatus::Running | AgentStatus::Waiting) {
                record.status = AgentStatus::Interrupted;
                record.interruption_reason = Some("application exited during execution; continue explicitly; uncertain tool operations are not replayed".into());
            }
            if let Some(turn) = record.current_turn_id.take() {
                record.retired_turns.insert(turn);
            }
            record.cancel.store(true, Ordering::SeqCst);
            // An input was leased but its canonical session may or may not have
            // been saved. Reconcile by its stable mail id before redelivering.
            let saved =
                crate::Session::load_from_path(checkpoint_path(&config, &record.lineage)).ok();
            if let Some(session) = saved.as_ref().filter(|_| !record.closed) {
                let uncertain = session.unresolved_tool_calls();
                if !uncertain.is_empty() {
                    record.status = AgentStatus::Interrupted;
                    record.interruption_reason = Some(format!(
                        "application exited with uncertain tool calls ({}); inspect evidence before continuing; these calls will not be replayed",
                        uncertain.iter().map(|(id, name)| format!("{name} ({id})")).collect::<Vec<_>>().join(", ")
                    ));
                }
            }
            reconcile_inflight(record, saved.as_ref());
            if !record.closed {
                restored
                    .trees
                    .entry(record.lineage.root_session_id.clone())
                    .or_default()
                    .paths
                    .insert(
                        record.lineage.path.clone(),
                        record.lineage.session_id.clone(),
                    );
            }
        }

        let mut recovery_events = Vec::new();
        let mut closed_rows = Vec::new();
        let recovered = orphans.into_iter().filter_map(|edge| {
            let lineage = edge.lineage?;
            let record = restored.agents.get(&lineage.session_id).filter(|r| !r.closed && r.task.is_some());
            let status = if let Some(record) = record {
                recovery_events.push(PendingEvent {
                    session_id: lineage.session_id.clone(), kind: "agent.recovered",
                    payload: json!({"turnId": Value::Null, "status":record.status,"reason":record.interruption_reason}),
                });
                record.status.clone()
            } else {
                closed_rows.push(closed_row(&lineage.session_id, "orphaned"));
                recovery_events.push(close_event(&lineage.session_id, &lineage.path, "orphaned", None));
                AgentStatus::Shutdown
            };
            Some(RecoveredAgent {lineage, status})
        }).collect();
        if !closed_rows.is_empty() {
            append_edge_rows(&edge_log, &closed_rows)?;
        }

        let control = Self {
            inner: Arc::new(Inner {
                config,
                recorder,
                edge_log,
                owner_lock: Mutex::new(owner_lock),
                state: Mutex::new(restored),
                persistence_error: Mutex::new(None),
                changed: Condvar::new(),
                nonce: random_nonce(),
                sequence: AtomicU64::new(1),
                recovered,
            }),
        };
        if control.owns_directory() {
            control.inner.flush(recovery_events);
        }
        Ok(control)
    }

    /// Agents that [`Self::open`] found left over from a previous process.
    #[must_use]
    pub fn recovered_agents(&self) -> &[RecoveredAgent] {
        &self.inner.recovered
    }

    /// Visible to the host even when an event sink cannot return an I/O error.
    pub fn persistence_error(&self) -> Option<String> {
        self.inner
            .persistence_error
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    /// Whether this control holds the project's ownership lock. `false` means
    /// another live process runs agents in the same directory (or the lock could
    /// not be taken): the control works, but it left the edge log's open rows
    /// alone because they may belong to that process.
    #[must_use]
    pub fn owns_directory(&self) -> bool {
        self.inner
            .owner_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .is_some()
    }

    /// Give up the ownership lock as the operating system does when the process
    /// ends, so a test can play the part of a restart without a second process.
    #[cfg(test)]
    fn release_owner_lock(&self) {
        *self
            .inner
            .owner_lock
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = None;
    }

    /// Make `session_id` the root (`/root`) of a new tree, or return the root
    /// it already is.
    pub fn register_root(
        &self,
        session_id: &str,
        project_id: Option<&str>,
    ) -> Result<AgentHandle, AgentControlError> {
        validate_session_id(session_id)?;
        let mut state = self.inner.lock();
        if let Some(record) = state.agents.get(session_id) {
            return if record.lineage.parent_session_id.is_none() && !record.closed {
                Ok(handle_of(record))
            } else {
                Err(AgentControlError::NotPermitted(format!(
                    "session `{session_id}` is already registered as a sub-agent or was closed"
                )))
            };
        }
        let lineage = AgentLineage {
            root_session_id: session_id.to_string(),
            session_id: session_id.to_string(),
            parent_session_id: None,
            parent_turn_id: None,
            origin: SpawnOrigin::User,
            spawn_ref: None,
            path: AgentPath::root(),
            role: "root".to_string(),
            depth: 0,
            project_id: project_id.map(str::to_string),
            created_at: now_iso8601(),
        };
        let record = new_record(lineage.clone());
        let handle = handle_of(&record);
        state
            .trees
            .entry(session_id.to_string())
            .or_default()
            .paths
            .insert(AgentPath::root(), session_id.to_string());
        state.agents.insert(session_id.to_string(), record);
        if let Err(error) = self.inner.persist(&state) {
            state.agents.remove(session_id);
            state.trees.remove(session_id);
            return Err(error);
        }
        Ok(handle)
    }

    /// Promise a slot and a name for a new agent. Nothing exists until
    /// [`SpawnReservation::commit`]; dropping the reservation gives both back.
    pub fn reserve(&self, request: SpawnRequest) -> Result<SpawnReservation, AgentControlError> {
        if !self.owns_directory() {
            return Err(AgentControlError::Persistence(
                "another process owns the agent directory".into(),
            ));
        }
        validate_role(&request.role)?;
        let reserved_name = request.name.starts_with(RESERVED_PREFIX);
        if reserved_name && request.origin != SpawnOrigin::Controller {
            return Err(AgentControlError::ReservedName(request.name));
        }
        let config = &self.inner.config;
        let mut state = self.inner.lock();
        let parent = state
            .agents
            .get(&request.parent_session_id)
            .ok_or_else(|| AgentControlError::UnknownAgent(request.parent_session_id.clone()))?;
        if parent.closed || parent.cancel.load(Ordering::SeqCst) {
            return Err(AgentControlError::AgentClosed(
                parent.lineage.path.to_string(),
            ));
        }
        validate_turn_author(parent, request.parent_turn_id.as_deref())?;
        let parent_path = parent.lineage.path.clone();
        let parent_depth = parent.lineage.depth;
        let root = parent.lineage.root_session_id.clone();

        // Nothing but the controller works inside a reserved subtree.
        if parent_path.is_reserved() && request.origin != SpawnOrigin::Controller {
            return Err(AgentControlError::UnknownAgent(parent_path.to_string()));
        }
        let path = if reserved_name {
            parent_path.join_reserved(&request.name)?
        } else {
            parent_path.join(&request.name)?
        };
        let reserved = path.is_reserved();
        let depth = parent_depth + 1;
        if !reserved && depth > config.max_depth {
            return Err(AgentControlError::DepthLimit {
                max_depth: config.max_depth,
            });
        }
        let tree = state.trees.entry(root.clone()).or_default();
        if tree.paths.contains_key(&path) || tree.pending.contains(&path) {
            return Err(AgentControlError::NameInUse(request.name));
        }
        let holding = tree
            .paths
            .keys()
            .chain(tree.pending.iter())
            .filter(|held| !held.is_root() && held.is_reserved() == reserved)
            .count();
        let limit = if reserved {
            config.max_reserved_threads
        } else {
            config.max_threads
        };
        if holding >= limit {
            return Err(AgentControlError::CapacityReached { max_threads: limit });
        }
        tree.pending.insert(path.clone());
        Ok(SpawnReservation {
            inner: Arc::clone(&self.inner),
            request,
            root_session_id: root,
            path,
            depth,
            armed: true,
        })
    }

    /// [`Self::reserve`] and [`SpawnReservation::commit`] in one step.
    pub fn spawn(&self, request: SpawnRequest) -> Result<AgentHandle, AgentControlError> {
        self.reserve(request)?.commit()
    }

    /// Close an agent and everything below it. Closing is idempotent.
    pub fn close(&self, session_id: &str, reason: &str) -> Result<CloseReport, AgentControlError> {
        self.close_for_turn(session_id, reason, None)
    }

    fn close_for_turn(
        &self,
        session_id: &str,
        reason: &str,
        expected_turn: Option<&str>,
    ) -> Result<CloseReport, AgentControlError> {
        let mut closed = Vec::new();
        {
            let mut state = self.inner.lock();
            let record = state
                .agents
                .get(session_id)
                .ok_or_else(|| AgentControlError::UnknownAgent(session_id.to_string()))?;
            if record.closed {
                return Ok(CloseReport::default());
            }
            if let Some(turn) = expected_turn {
                validate_turn_author(record, Some(turn))?;
            }
            let root = record.lineage.root_session_id.clone();
            let target = record.lineage.path.clone();
            for id in state.subtree(&root, &target) {
                if let Some(record) = state.agents.get_mut(&id) {
                    record.revision = record.revision.saturating_add(1);
                    record.closed = true;
                    record.status = AgentStatus::Shutdown;
                    record.mailbox.clear();
                    record.cancel.store(true, Ordering::SeqCst);
                    closed.push((record.lineage.clone(), record.current_turn_id.clone()));
                }
                if let Some(tree) = state.trees.get_mut(&root) {
                    tree.paths.retain(|_, held| held != &id);
                }
            }
        }
        self.inner.changed.notify_all();

        let rows = closed
            .iter()
            .filter(|(lineage, _)| lineage.parent_session_id.is_some())
            .map(|(lineage, _)| closed_row(&lineage.session_id, reason))
            .collect::<Vec<_>>();
        let persistence_error = if rows.is_empty() {
            None
        } else {
            append_edge_rows(&self.inner.edge_log, &rows)
                .err()
                .map(|error| error.to_string())
        };
        let mut events = Vec::new();
        for (lineage, turn_id) in &closed {
            events.push(close_event(
                &lineage.session_id,
                &lineage.path,
                reason,
                turn_id.as_deref(),
            ));
            if let Some(parent) = &lineage.parent_session_id {
                events.push(PendingEvent {
                    session_id: parent.clone(),
                    kind: EVENT_AGENT_CLOSE,
                    payload: json!({
                        "turnId": Value::Null,
                        "childSessionId": lineage.session_id,
                        "childPath": lineage.path,
                        "reason": reason,
                    }),
                });
            }
        }
        self.inner.flush(events);
        Ok(CloseReport {
            closed: closed
                .into_iter()
                .map(|(lineage, _)| lineage.session_id)
                .collect(),
            persistence_error,
        })
    }

    /// Raise the cancellation flag of an agent and of everything below it. This
    /// is how Stop on a root reaches its sub-agents and its Reviewer.
    pub fn cancel_subtree(&self, session_id: &str) -> usize {
        self.cancel_subtree_with_reason(session_id, "stopped by user or parent")
    }

    pub fn cancel_subtree_with_reason(&self, session_id: &str, reason: &str) -> usize {
        let mut state = self.inner.lock();
        let mut events = Vec::new();
        let count = cancel_locked(&mut state, session_id, reason, &mut events);
        let _ = self.inner.persist(&state);
        drop(state);
        self.inner.changed.notify_all();
        self.inner.flush(events);
        count
    }

    /// A model's interrupt is authorized and applied in one critical section;
    /// an old tool call cannot stop a child after its parent was replaced.
    pub fn interrupt_child(
        &self,
        parent: &str,
        parent_turn: &str,
        child: &str,
    ) -> Result<(), AgentControlError> {
        let mut state = self.inner.lock();
        validate_child_author(&state, parent, parent_turn, child)?;
        let mut events = Vec::new();
        cancel_locked(&mut state, child, "stopped by user or parent", &mut events);
        self.inner.persist(&state)?;
        drop(state);
        self.inner.changed.notify_all();
        self.inner.flush(events);
        Ok(())
    }

    #[must_use]
    pub fn info(&self, session_id: &str) -> Option<AgentInfo> {
        self.inner.lock().info(session_id)
    }

    /// Reserve a turn before starting a worker. Every turn gets a fresh flag;
    /// clearing cancellation can never revive a previous worker.
    pub fn begin_turn(
        &self,
        session_id: &str,
        turn_id: &str,
    ) -> Result<AgentHandle, AgentControlError> {
        self.begin_turn_inner(session_id, turn_id, None)
    }

    /// Atomically bind the actual execution contract to a live parent's turn.
    pub fn begin_child_turn(
        &self,
        parent: &str,
        parent_turn: &str,
        child: &str,
        child_turn: &str,
        task: AgentTask,
    ) -> Result<AgentHandle, AgentControlError> {
        self.begin_turn_inner(child, child_turn, Some((parent, parent_turn, task)))
    }

    fn begin_turn_inner(
        &self,
        session_id: &str,
        turn_id: &str,
        parent: Option<(&str, &str, AgentTask)>,
    ) -> Result<AgentHandle, AgentControlError> {
        let mut state = self.inner.lock();
        if let Some((parent, parent_turn, _)) = parent.as_ref() {
            validate_child_author(&state, parent, parent_turn, session_id)?;
        }
        let record = state
            .agents
            .get_mut(session_id)
            .ok_or_else(|| AgentControlError::UnknownAgent(session_id.into()))?;
        if record.closed {
            return Err(AgentControlError::AgentClosed(session_id.into()));
        }
        if record.retired_turns.contains(turn_id) {
            return Err(AgentControlError::NotPermitted(
                "turn was already retired".into(),
            ));
        }
        if record.current_turn_id.as_deref() == Some(turn_id) {
            return Ok(handle_of(record));
        }
        // Stop can retire a worker between leasing its mail and saving the
        // canonical session. A same-process follow-up needs the same lease
        // reconciliation as a restart; clearing inflight at its next save
        // would otherwise lose those inputs permanently.
        if !record.inflight.is_empty() {
            let path = checkpoint_path(&self.inner.config, &record.lineage);
            let saved = match crate::Session::load_from_path(&path) {
                Ok(session) => Some(session),
                Err(crate::session::SessionError::Io(error))
                    if error.kind() == std::io::ErrorKind::NotFound =>
                {
                    None
                }
                Err(error) => return Err(AgentControlError::Persistence(error.to_string())),
            };
            reconcile_inflight(record, saved.as_ref());
        }
        record.revision = record.revision.saturating_add(1);
        record.cancel.store(true, Ordering::SeqCst);
        record.cancel = fresh_cancel();
        if let Some(old) = record.current_turn_id.replace(turn_id.into()) {
            if old != turn_id {
                record.retired_turns.insert(old);
            }
        }
        record.turn_seq += 1;
        record.status = AgentStatus::PendingInit;
        record.interruption_reason = None;
        if let Some((_, _, task)) = parent {
            record.task = Some(task);
            // Reserving this execution handles the existing wake-up requests.
            // Keep their contents until canonical delivery, but do not retry a
            // failed initializer forever. Later follow-ups keep their trigger.
            for mail in &mut record.mailbox {
                mail.trigger_turn = false;
            }
        }
        let handle = handle_of(record);
        self.inner.persist(&state)?;
        Ok(handle)
    }

    pub fn is_current_turn(&self, session_id: &str, turn_id: &str) -> bool {
        self.inner
            .lock()
            .agents
            .get(session_id)
            .is_some_and(|record| {
                !record.closed
                    && !record.cancel.load(Ordering::SeqCst)
                    && record.current_turn_id.as_deref() == Some(turn_id)
            })
    }

    pub fn set_task(&self, session_id: &str, task: AgentTask) -> Result<(), AgentControlError> {
        let mut state = self.inner.lock();
        let record = state
            .agents
            .get_mut(session_id)
            .ok_or_else(|| AgentControlError::UnknownAgent(session_id.into()))?;
        record.task = Some(task);
        record.revision = record.revision.saturating_add(1);
        self.inner.persist(&state)
    }

    pub fn activity(&self, session_id: &str, turn_id: &str, activity: &str) {
        let mut state = self.inner.lock();
        if let Some(record) = state.agents.get_mut(session_id).filter(|record| {
            record.current_turn_id.as_deref() == Some(turn_id)
                && !record.cancel.load(Ordering::SeqCst)
        }) {
            record.last_activity = Some(truncate_chars(activity, 1000));
            record.revision = record.revision.saturating_add(1);
        }
        let _ = self.inner.persist(&state);
    }

    pub fn set_waiting(&self, session_id: &str, turn_id: &str, waiting: bool) {
        let mut state = self.inner.lock();
        if let Some(record) = state.agents.get_mut(session_id).filter(|record| {
            record.current_turn_id.as_deref() == Some(turn_id)
                && !record.cancel.load(Ordering::SeqCst)
        }) {
            record.status = if waiting {
                AgentStatus::Waiting
            } else {
                AgentStatus::Running
            };
            record.revision = record.revision.saturating_add(1);
        }
        let _ = self.inner.persist(&state);
    }

    /// Persist canonical conversation before acknowledging leased mail.
    pub fn checkpoint(
        &self,
        session_id: &str,
        turn_id: Option<&str>,
        session: &crate::Session,
    ) -> Result<(), AgentControlError> {
        let mut state = self.inner.lock();
        let Some(record) = state.agents.get_mut(session_id) else {
            return Ok(());
        };
        if record.closed
            || record.current_turn_id.as_deref() != turn_id
            || record.cancel.load(Ordering::SeqCst)
        {
            return Err(AgentControlError::NotPermitted(
                "stale or stopped turn cannot checkpoint".into(),
            ));
        }
        let dir = if record.lineage.path.is_root() {
            self.inner
                .config
                .agents_dir
                .parent()
                .unwrap_or(&self.inner.config.agents_dir)
        } else {
            &self.inner.config.agents_dir
        };
        session
            .save_to_path(dir.join(format!("{session_id}.json")))
            .map_err(|error| AgentControlError::Persistence(error.to_string()))?;
        record.inflight.clear();
        self.inner.persist(&state)
    }

    /// The agent's status, `NotFound` for a session the control does not know.
    #[must_use]
    pub fn status(&self, session_id: &str) -> AgentStatus {
        self.inner
            .lock()
            .agents
            .get(session_id)
            .map_or(AgentStatus::NotFound, |record| record.status.clone())
    }

    pub fn roots(&self) -> Vec<String> {
        self.inner
            .lock()
            .agents
            .values()
            .filter(|r| r.lineage.path.is_root() && !r.closed)
            .map(|r| r.lineage.session_id.clone())
            .collect()
    }

    /// Includes failed creation attempts and closed tasks for the chat history.
    /// Reserved Reviewer sessions remain invisible.
    pub fn task_infos(&self, parent: &str) -> Vec<AgentInfo> {
        let state = self.inner.lock();
        let mut items: Vec<_> = state
            .agents
            .values()
            .filter(|r| {
                r.task.is_some()
                    && !r.lineage.path.is_reserved()
                    && r.lineage.parent_session_id.as_deref() == Some(parent)
            })
            .filter_map(|r| state.info(&r.lineage.session_id))
            .collect();
        items.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        items
    }

    pub fn fail_creation(&self, session: &str, message: &str) {
        let mut state = self.inner.lock();
        let Some(record) = state.agents.get_mut(session) else {
            return;
        };
        record.cancel.store(true, Ordering::SeqCst);
        record.revision = record.revision.saturating_add(1);
        record.status = AgentStatus::Errored(message.into());
        record.closed = true;
        record.interruption_reason = Some(format!("creation failed: {message}"));
        let root = record.lineage.root_session_id.clone();
        if let Some(tree) = state.trees.get_mut(&root) {
            tree.paths.retain(|_, id| id != session);
        }
        let _ = self.inner.persist(&state);
        let _ = append_edge_rows(
            &self.inner.edge_log,
            &[closed_row(session, "creation failed")],
        );
    }

    /// The agents below the author a model may see: its whole tree, minus
    /// reserved agents, which are not listed.
    pub fn list(&self, author_session_id: &str) -> Result<Vec<AgentInfo>, AgentControlError> {
        Ok(self
            .tree_infos(author_session_id)?
            .into_iter()
            .filter(|info| !info.path.is_reserved())
            .collect())
    }

    /// Every live agent in the author's tree, reserved ones included.
    pub fn list_all(&self, author_session_id: &str) -> Result<Vec<AgentInfo>, AgentControlError> {
        self.tree_infos(author_session_id)
    }

    fn tree_infos(&self, author_session_id: &str) -> Result<Vec<AgentInfo>, AgentControlError> {
        let state = self.inner.lock();
        let author = state
            .agents
            .get(author_session_id)
            .ok_or_else(|| AgentControlError::UnknownAgent(author_session_id.to_string()))?;
        let Some(tree) = state.trees.get(&author.lineage.root_session_id) else {
            return Ok(Vec::new());
        };
        Ok(tree
            .paths
            .values()
            .filter_map(|id| state.info(id))
            .collect())
    }

    /// What a model's reference (`scout_1`, `/root/scout_1`) means from the
    /// author's position. A reserved agent resolves exactly like a missing one.
    pub fn resolve(
        &self,
        author_session_id: &str,
        reference: &str,
    ) -> Result<AgentInfo, AgentControlError> {
        let state = self.inner.lock();
        resolve_for_model(&state, author_session_id, reference)
    }

    /// Send a message on a model's behalf.
    pub fn send(&self, request: SendRequest) -> Result<MailReceipt, AgentControlError> {
        if !request.kind.model_may_send() {
            return Err(AgentControlError::NotPermitted(format!(
                "a `{}` message cannot be sent by an agent",
                request.kind.as_str()
            )));
        }
        let content = bounded_content(&request.content)?;
        let (mail, events) = {
            let mut state = self.inner.lock();
            let target = resolve_for_model(&state, &request.author_session_id, &request.target)?;
            if target.session_id == request.author_session_id {
                return Err(AgentControlError::NotPermitted(
                    "an agent cannot send mail to itself".to_string(),
                ));
            }
            if request.trigger_turn && target.path.is_root() {
                return Err(AgentControlError::NotPermitted(
                    "the user's own conversation cannot be woken by a follow-up; send a plain message and it will see it on its next step"
                        .to_string(),
                ));
            }
            let author = state
                .agents
                .get(&request.author_session_id)
                .ok_or_else(|| {
                    AgentControlError::UnknownAgent(request.author_session_id.clone())
                })?;
            validate_turn_author(author, request.cause.turn_id.as_deref())?;
            let mail = AgentMail {
                id: self.inner.next_id("mail"),
                root_session_id: author.lineage.root_session_id.clone(),
                author: author.lineage.path.clone(),
                author_session_id: author.lineage.session_id.clone(),
                recipient: target.path,
                recipient_session_id: target.session_id,
                kind: request.kind,
                content,
                trigger_turn: request.trigger_turn,
                cause: request.cause,
                created_at: now_iso8601(),
            };
            let events = enqueue_mail(&mut state, mail.clone())?;
            if let Err(error) = self.inner.persist(&state) {
                if let Some(target) = state.agents.get_mut(&mail.recipient_session_id) {
                    target.mailbox.retain(|pending| pending.id != mail.id);
                }
                return Err(error);
            }
            (mail, events)
        };
        self.inner.changed.notify_all();
        self.inner.flush(events);
        Ok(receipt_of(&mail))
    }

    /// Send mail as the controller: any kind, to any live agent in the author's
    /// tree, reserved agents included.
    pub fn deliver(&self, mail: ControllerMail) -> Result<MailReceipt, AgentControlError> {
        let content = bounded_content_to(&mail.content, MAX_CONTROLLER_MAIL_CONTENT_CHARS)?;
        let (mail, events) = {
            let mut state = self.inner.lock();
            let author = state
                .agents
                .get(&mail.author_session_id)
                .ok_or_else(|| AgentControlError::UnknownAgent(mail.author_session_id.clone()))?;
            if author.closed {
                return Err(AgentControlError::AgentClosed(
                    author.lineage.path.to_string(),
                ));
            }
            validate_turn_author(author, mail.cause.turn_id.as_deref())?;
            let root = author.lineage.root_session_id.clone();
            let recipient_session_id = state
                .trees
                .get(&root)
                .and_then(|tree| tree.paths.get(&mail.recipient))
                .cloned()
                .ok_or_else(|| AgentControlError::UnknownAgent(mail.recipient.to_string()))?;
            let author = &state.agents[&mail.author_session_id];
            let built = AgentMail {
                id: self.inner.next_id("mail"),
                root_session_id: root,
                author: author.lineage.path.clone(),
                author_session_id: author.lineage.session_id.clone(),
                recipient: mail.recipient,
                recipient_session_id,
                kind: mail.kind,
                content,
                trigger_turn: mail.trigger_turn,
                cause: mail.cause,
                created_at: now_iso8601(),
            };
            let events = enqueue_mail(&mut state, built.clone())?;
            if let Err(error) = self.inner.persist(&state) {
                if let Some(target) = state.agents.get_mut(&built.recipient_session_id) {
                    target.mailbox.retain(|pending| pending.id != built.id);
                }
                return Err(error);
            }
            (built, events)
        };
        self.inner.changed.notify_all();
        self.inner.flush(events);
        Ok(receipt_of(&mail))
    }

    /// Remove and return everything waiting for `session_id`, oldest first.
    #[must_use]
    pub fn take_mail(&self, session_id: &str) -> Vec<AgentMail> {
        let mut state = self.inner.lock();
        let mails = state
            .agents
            .get_mut(session_id)
            .map(|record| record.mailbox.drain(..).collect())
            .unwrap_or_default();
        let _ = self.inner.persist(&state);
        mails
    }

    #[must_use]
    pub fn pending_mail(&self, session_id: &str) -> usize {
        self.inner
            .lock()
            .agents
            .get(session_id)
            .map_or(0, |record| record.mailbox.len())
    }

    /// Whether waiting mail asks for a turn. A driver that finds this after a
    /// turn ends should start another.
    #[must_use]
    pub fn has_pending_trigger(&self, session_id: &str) -> bool {
        self.inner
            .lock()
            .agents
            .get(session_id)
            .is_some_and(|record| record.mailbox.iter().any(|mail| mail.trigger_turn))
    }

    /// Block until mail is waiting for `session_id`, the timeout passes, the
    /// agent closes, or `cancelled` is raised. The flag is looked at every few
    /// hundred milliseconds, so a Stop is never stuck behind a long wait.
    pub fn wait_for_mail(
        &self,
        session_id: &str,
        timeout: Duration,
        cancelled: &AtomicBool,
    ) -> MailWait {
        let deadline = Instant::now() + timeout;
        let mut state = self.inner.lock();
        loop {
            match state.agents.get(session_id) {
                None => return MailWait::Closed,
                Some(record) if record.closed => return MailWait::Closed,
                Some(record) if !record.mailbox.is_empty() => return MailWait::Mail,
                Some(_) => {}
            }
            if cancelled.load(Ordering::SeqCst) {
                return MailWait::Cancelled;
            }
            let now = Instant::now();
            if now >= deadline {
                return MailWait::TimedOut;
            }
            let slice = WAIT_SLICE.min(deadline - now);
            state = self
                .inner
                .changed
                .wait_timeout(state, slice)
                .unwrap_or_else(PoisonError::into_inner)
                .0;
        }
    }

    /// Update an agent from a runtime event. Events that do not change status are
    /// ignored; `turn_id` names the turn the event belongs to.
    pub fn observe_event(&self, session_id: &str, turn_id: Option<&str>, event: &EventType) {
        let Some(status) = agent_status_from_event(event) else {
            return;
        };
        if status == AgentStatus::Shutdown {
            // The session is over. That closes the agent, with its slot and
            // name, rather than leaving a live-looking entry behind. An unknown
            // session has nothing to close.
            let _ = self.close_for_turn(session_id, "session ended", turn_id);
            return;
        }
        let mut events = Vec::new();
        {
            let mut state = self.inner.lock();
            apply_status(
                &self.inner,
                &mut state,
                session_id,
                turn_id,
                &status,
                &mut events,
            );
        }
        self.inner.changed.notify_all();
        self.inner.flush(events);
    }

    /// An [`EventSink`] to attach to the agent's runtime. It keeps the agent's
    /// status current and sends the parent its result.
    #[must_use]
    pub fn lifecycle_sink(&self, session_id: &str, turn_id: Option<&str>) -> AgentLifecycleSink {
        AgentLifecycleSink {
            control: self.clone(),
            session_id: session_id.to_string(),
            turn_id: turn_id.map(str::to_string),
        }
    }

    /// A [`TurnInputSource`] to attach to the agent's runtime, so mail reaches
    /// the turn between provider requests.
    #[must_use]
    pub fn turn_input_source(&self, session_id: &str, turn_id: Option<&str>) -> MailboxTurnInput {
        MailboxTurnInput {
            control: self.clone(),
            session_id: session_id.to_string(),
            turn_id: turn_id.map(str::to_string),
            delivery_error: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Reservation
// ---------------------------------------------------------------------------

/// A slot and a name held for an agent that is about to be created.
#[must_use = "an uncommitted reservation gives its slot back when dropped"]
pub struct SpawnReservation {
    inner: Arc<Inner>,
    request: SpawnRequest,
    root_session_id: String,
    path: AgentPath,
    depth: usize,
    armed: bool,
}

impl SpawnReservation {
    /// The path the agent will have.
    #[must_use]
    pub fn path(&self) -> &AgentPath {
        &self.path
    }

    /// Create the agent: record it durably first, then register it.
    pub fn commit(mut self) -> Result<AgentHandle, AgentControlError> {
        let inner = Arc::clone(&self.inner);
        let session_id = inner.next_id(AGENT_SESSION_ID_PREFIX);
        let lineage = AgentLineage {
            root_session_id: self.root_session_id.clone(),
            session_id,
            parent_session_id: Some(self.request.parent_session_id.clone()),
            parent_turn_id: self.request.parent_turn_id.clone(),
            origin: self.request.origin,
            spawn_ref: self.request.spawn_ref.clone(),
            path: self.path.clone(),
            role: self.request.role.clone(),
            depth: self.depth,
            project_id: inner
                .lock()
                .agents
                .get(&self.request.parent_session_id)
                .and_then(|parent| parent.lineage.project_id.clone()),
            created_at: now_iso8601(),
        };
        // Durable before visible: an agent the log does not know about could not
        // be recovered after a restart. On failure `self` is still armed and its
        // drop returns the slot.
        append_edge_rows(&inner.edge_log, &[open_row(&lineage)])?;

        let record = new_record(lineage.clone());
        let handle = handle_of(&record);
        {
            let mut state = inner.lock();
            // The parent may have been closed while the edge was being written.
            // Registering a child under it would leave a live agent in a closed
            // tree, so refuse, and say in the log that it never lived.
            let parent_is_live = state
                .agents
                .get(&self.request.parent_session_id)
                .is_some_and(|parent| {
                    validate_turn_author(parent, self.request.parent_turn_id.as_deref()).is_ok()
                });
            if !parent_is_live {
                drop(state);
                let _ = append_edge_rows(
                    &inner.edge_log,
                    &[closed_row(&lineage.session_id, "parent_closed")],
                );
                return Err(AgentControlError::AgentClosed(
                    self.request.parent_session_id.clone(),
                ));
            }
            if let Some(tree) = state.trees.get_mut(&self.root_session_id) {
                tree.pending.remove(&self.path);
                tree.paths
                    .insert(self.path.clone(), lineage.session_id.clone());
            }
            state.agents.insert(lineage.session_id.clone(), record);
            if let Err(error) = inner.persist(&state) {
                state.agents.remove(&lineage.session_id);
                if let Some(tree) = state.trees.get_mut(&self.root_session_id) {
                    tree.paths.remove(&self.path);
                }
                let _ = append_edge_rows(
                    &inner.edge_log,
                    &[closed_row(&lineage.session_id, "checkpoint failed")],
                );
                return Err(error);
            }
        }
        self.armed = false;

        let mut lineage_payload = serde_json::to_value(&lineage).unwrap_or(Value::Null);
        if let Value::Object(fields) = &mut lineage_payload {
            fields.insert("turnId".to_string(), Value::Null);
        }
        inner.flush(vec![
            PendingEvent {
                session_id: lineage.session_id.clone(),
                kind: EVENT_AGENT_LINEAGE,
                payload: lineage_payload,
            },
            PendingEvent {
                session_id: self.request.parent_session_id.clone(),
                kind: EVENT_AGENT_SPAWN,
                payload: json!({
                    "turnId": lineage.parent_turn_id,
                    "childSessionId": lineage.session_id,
                    "childPath": lineage.path,
                    "role": lineage.role,
                    "origin": lineage.origin.as_str(),
                    "spawnRef": lineage.spawn_ref,
                    "depth": lineage.depth,
                }),
            },
        ]);
        Ok(handle)
    }
}

impl Drop for SpawnReservation {
    fn drop(&mut self) {
        if self.armed {
            if let Some(tree) = self.inner.lock().trees.get_mut(&self.root_session_id) {
                tree.pending.remove(&self.path);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Runtime adapters
// ---------------------------------------------------------------------------

/// Reports a runtime's turn events to the [`AgentControl`] that owns its agent.
pub struct AgentLifecycleSink {
    control: AgentControl,
    session_id: String,
    turn_id: Option<String>,
}

impl EventSink for AgentLifecycleSink {
    fn emit(&mut self, event: &RuntimeEvent) {
        self.control
            .observe_event(&self.session_id, self.turn_id.as_deref(), &event.event_type);
    }
}

/// Feeds an agent's waiting mail to its running turn.
pub struct MailboxTurnInput {
    control: AgentControl,
    session_id: String,
    turn_id: Option<String>,
    delivery_error: Option<String>,
}

impl TurnInputSource for MailboxTurnInput {
    fn take_ready(&mut self) -> Vec<TurnInput> {
        let mails = {
            let mut state = self.control.inner.lock();
            let Some(record) = state.agents.get_mut(&self.session_id) else {
                return Vec::new();
            };
            if record.current_turn_id != self.turn_id || record.cancel.load(Ordering::SeqCst) {
                return Vec::new();
            }
            let mails: Vec<_> = record.mailbox.drain(..).collect();
            record.inflight.extend(mails.clone());
            if let Err(error) = self.control.inner.persist(&state) {
                if let Some(record) = state.agents.get_mut(&self.session_id) {
                    record
                        .inflight
                        .truncate(record.inflight.len().saturating_sub(mails.len()));
                    for mail in mails.into_iter().rev() {
                        record.mailbox.push_front(mail);
                    }
                }
                self.delivery_error = Some(error.to_string());
                return Vec::new();
            }
            mails
        };
        let events = mails
            .iter()
            .map(|mail| PendingEvent {
                session_id: self.session_id.clone(),
                kind: EVENT_AGENT_MAIL_DELIVERED,
                payload: json!({
                    "turnId": self.turn_id,
                    "mailId": mail.id,
                    "kind": mail.kind.as_str(),
                    "from": mail.author,
                    "fromSessionId": mail.author_session_id,
                    "to": mail.recipient,
                    "sentTurnId": mail.cause.turn_id,
                }),
            })
            .collect();
        self.control.inner.flush(events);
        mails
            .into_iter()
            .map(|mail| TurnInput {
                id: mail.id,
                from: mail.author.to_string(),
                kind: mail.kind.as_str().to_string(),
                text: mail.content,
            })
            .collect()
    }

    fn checkpoint(&mut self, session: &crate::Session) -> Result<(), crate::RuntimeError> {
        if let Some(error) = self.delivery_error.take() {
            return Err(crate::RuntimeError::new(error));
        }
        self.control
            .checkpoint(&self.session_id, self.turn_id.as_deref(), session)
            .map_err(|error| crate::RuntimeError::new(error.to_string()))
    }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

fn checkpoint_path(config: &AgentControlConfig, lineage: &AgentLineage) -> PathBuf {
    let dir = if lineage.path.is_root() {
        config.agents_dir.parent().unwrap_or(&config.agents_dir)
    } else {
        &config.agents_dir
    };
    dir.join(format!("{}.json", lineage.session_id))
}

fn validate_child_author(
    state: &State,
    parent: &str,
    parent_turn: &str,
    child: &str,
) -> Result<(), AgentControlError> {
    let author = state
        .agents
        .get(parent)
        .ok_or_else(|| AgentControlError::UnknownAgent(parent.into()))?;
    validate_turn_author(author, Some(parent_turn))?;
    let child = state
        .agents
        .get(child)
        .ok_or_else(|| AgentControlError::UnknownAgent(child.into()))?;
    if child.closed
        || child.lineage.parent_session_id.as_deref() != Some(parent)
        || child.lineage.path.is_reserved()
    {
        return Err(AgentControlError::NotPermitted(
            "only this parent's ordinary children may be controlled".into(),
        ));
    }
    Ok(())
}

fn cancel_locked(
    state: &mut State,
    session_id: &str,
    reason: &str,
    events: &mut Vec<PendingEvent>,
) -> usize {
    let Some(record) = state.agents.get(session_id) else {
        return 0;
    };
    let targets = state.subtree(&record.lineage.root_session_id, &record.lineage.path);
    for id in &targets {
        if let Some(record) = state.agents.get_mut(id) {
            let stopped_turn = record.current_turn_id.clone();
            record.revision = record.revision.saturating_add(1);
            record.cancel.store(true, Ordering::SeqCst);
            if let Some(turn) = record.current_turn_id.take() {
                record.retired_turns.insert(turn);
            }
            for mail in &mut record.mailbox {
                mail.trigger_turn = false;
            }
            if matches!(
                record.status,
                AgentStatus::Running
                    | AgentStatus::Waiting
                    | AgentStatus::PendingInit
                    | AgentStatus::Interrupted
            ) {
                record.status = AgentStatus::Interrupted;
                record.interruption_reason = Some(reason.into());
                events.push(PendingEvent {
                    session_id: id.clone(), kind: "agent.interrupted",
                    payload: json!({"turnId":stopped_turn,"reason":reason,"revision":record.revision}),
                });
            }
        }
    }
    targets.len()
}

fn reconcile_inflight(record: &mut AgentRecord, saved: Option<&crate::Session>) {
    for mail in std::mem::take(&mut record.inflight).into_iter().rev() {
        let delivered = saved.is_some_and(|session| {
            session.messages.iter()
                .chain(session.compactions.iter().flat_map(|record| record.messages.iter()))
                .any(|message| message.role == crate::MessageRole::User
                    && message.blocks.iter().any(|block| matches!(block,
                        crate::ContentBlock::Text { text }
                        if text.starts_with("[Inter-agent message")
                            && text.contains(&format!(", id {}) - written by another agent", mail.id)))))
        });
        if !delivered {
            record.mailbox.push_front(mail);
        }
    }
}

fn new_record(lineage: AgentLineage) -> AgentRecord {
    AgentRecord {
        revision: 1,
        lineage,
        status: AgentStatus::PendingInit,
        mailbox: VecDeque::new(),
        cancel: Arc::new(AtomicBool::new(false)),
        closed: false,
        turn_seq: 0,
        result_turn_seq: None,
        current_turn_id: None,
        retired_turns: HashSet::new(),
        inflight: Vec::new(),
        task: None,
        last_activity: None,
        interruption_reason: None,
    }
}

fn fresh_cancel() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

fn validate_turn_author(record: &AgentRecord, turn: Option<&str>) -> Result<(), AgentControlError> {
    if record.closed
        || record.cancel.load(Ordering::SeqCst)
        || turn.is_some_and(|id| {
            record.retired_turns.contains(id)
                || record
                    .current_turn_id
                    .as_deref()
                    .is_some_and(|current| current != id)
        })
    {
        return Err(AgentControlError::NotPermitted(
            "stale or stopped turn cannot delegate or send mail".into(),
        ));
    }
    Ok(())
}

fn handle_of(record: &AgentRecord) -> AgentHandle {
    AgentHandle {
        session_id: record.lineage.session_id.clone(),
        root_session_id: record.lineage.root_session_id.clone(),
        path: record.lineage.path.clone(),
        cancel: Arc::clone(&record.cancel),
    }
}

fn receipt_of(mail: &AgentMail) -> MailReceipt {
    MailReceipt {
        mail_id: mail.id.clone(),
        recipient: mail.recipient.clone(),
        recipient_session_id: mail.recipient_session_id.clone(),
        trigger_turn: mail.trigger_turn,
    }
}

/// A model's reference resolved from its own position. Anything reserved,
/// closed or absent is the same `UnknownAgent`, so the answer reveals nothing.
fn resolve_for_model(
    state: &State,
    author_session_id: &str,
    reference: &str,
) -> Result<AgentInfo, AgentControlError> {
    let unknown = || AgentControlError::UnknownAgent(reference.trim().to_string());
    let author = state
        .agents
        .get(author_session_id)
        .ok_or_else(|| AgentControlError::UnknownAgent(author_session_id.to_string()))?;
    if author.closed {
        return Err(AgentControlError::AgentClosed(
            author.lineage.path.to_string(),
        ));
    }
    let path = author
        .lineage
        .path
        .resolve_reference(reference)
        .map_err(|_| unknown())?;
    if path.is_reserved() {
        return Err(unknown());
    }
    let session_id = state
        .trees
        .get(&author.lineage.root_session_id)
        .and_then(|tree| tree.paths.get(&path))
        .ok_or_else(unknown)?;
    state.info(session_id).ok_or_else(unknown)
}

/// Put `mail` in its recipient's mailbox, returning the events to record.
fn enqueue_mail(
    state: &mut State,
    mail: AgentMail,
) -> Result<Vec<PendingEvent>, AgentControlError> {
    let recipient = state
        .agents
        .get_mut(&mail.recipient_session_id)
        .ok_or_else(|| AgentControlError::UnknownAgent(mail.recipient.to_string()))?;
    if recipient.closed {
        return Err(AgentControlError::AgentClosed(mail.recipient.to_string()));
    }
    let event = PendingEvent {
        session_id: mail.author_session_id.clone(),
        kind: EVENT_AGENT_MAIL_SENT,
        payload: json!({
            "turnId": mail.cause.turn_id,
            "mailId": mail.id,
            "kind": mail.kind.as_str(),
            "from": mail.author,
            "to": mail.recipient,
            "toSessionId": mail.recipient_session_id,
            "triggerTurn": mail.trigger_turn,
            "toolUseId": mail.cause.tool_use_id,
            "actionId": mail.cause.action_id,
        }),
    };
    recipient.mailbox.push_back(mail);
    Ok(vec![event])
}

/// Apply a derived status and, when it ends a turn, report to the parent once.
fn apply_status(
    inner: &Inner,
    state: &mut State,
    session_id: &str,
    turn_id: Option<&str>,
    status: &AgentStatus,
    events: &mut Vec<PendingEvent>,
) {
    let Some(record) = state.agents.get_mut(session_id) else {
        return;
    };
    // A closed agent stays closed; a late event must not bring it back.
    if record.closed || turn_id.is_some_and(|turn| record.retired_turns.contains(turn)) {
        return;
    }
    if record.current_turn_id.as_deref() != turn_id && record.current_turn_id.is_some() {
        return;
    }
    if record.cancel.load(Ordering::SeqCst) {
        return;
    }
    if turn_id.is_some()
        && record.current_turn_id.as_deref() == turn_id
        && record.result_turn_seq == Some(record.turn_seq)
    {
        return;
    }
    match status {
        AgentStatus::Running => {
            if record.current_turn_id.as_deref() != turn_id || turn_id.is_none() {
                if let Some(old) = record.current_turn_id.take() {
                    record.retired_turns.insert(old);
                }
                record.turn_seq += 1;
            }
            record.current_turn_id = turn_id.map(str::to_string);
        }
        _ => {
            if record.current_turn_id.is_none() {
                record.current_turn_id = turn_id.map(str::to_string);
            }
        }
    }
    record.status = status.clone();
    record.revision = record.revision.saturating_add(1);
    if matches!(status, AgentStatus::Interrupted) {
        if let Some(turn) = turn_id {
            record.retired_turns.insert(turn.into());
        }
    }

    let label = status.label();
    let message = match status {
        AgentStatus::Completed(message) => message.clone(),
        AgentStatus::Errored(message) => Some(message.clone()),
        // Only a settled turn is reported; a start or a cancellation is not.
        _ => return,
    };
    if record.result_turn_seq == Some(record.turn_seq) {
        return;
    }
    record.result_turn_seq = Some(record.turn_seq);
    // A reserved agent answers to the controller that drives it, and the
    // controller reads the outcome from the turn itself. Mailing it to the
    // parent would put the Reviewer's verdict in front of the very Executor it
    // judges, ahead of the controller's own instruction to that Executor.
    if record.lineage.path.is_reserved() {
        return;
    }
    let lineage = record.lineage.clone();
    let child_turn_id = record.current_turn_id.clone();
    let Some(parent_session_id) = lineage.parent_session_id.clone() else {
        return;
    };
    let Some(parent) = state.agents.get_mut(&parent_session_id) else {
        return;
    };
    if parent.closed {
        return;
    }
    let content = match (label, message) {
        ("errored", Some(message)) => format!("The agent failed: {message}"),
        (_, Some(message)) if !message.trim().is_empty() => message,
        _ => "The agent finished without a final message.".to_string(),
    };
    let mail = AgentMail {
        id: inner.next_id("mail"),
        root_session_id: lineage.root_session_id.clone(),
        author: lineage.path.clone(),
        author_session_id: lineage.session_id.clone(),
        recipient: parent.lineage.path.clone(),
        recipient_session_id: parent_session_id.clone(),
        kind: MailKind::Result,
        content: truncate_chars(&content, MAX_MAIL_CONTENT_CHARS),
        trigger_turn: false,
        cause: MailCause {
            turn_id: child_turn_id.clone(),
            tool_use_id: None,
            action_id: None,
        },
        created_at: now_iso8601(),
    };
    events.push(PendingEvent {
        session_id: lineage.session_id.clone(),
        kind: EVENT_AGENT_MAIL_SENT,
        payload: json!({
            "turnId": child_turn_id,
            "mailId": mail.id,
            "kind": mail.kind.as_str(),
            "from": mail.author,
            "to": mail.recipient,
            "toSessionId": mail.recipient_session_id,
            "triggerTurn": false,
            "toolUseId": Value::Null,
            "actionId": Value::Null,
        }),
    });
    events.push(PendingEvent {
        session_id: parent_session_id,
        kind: EVENT_AGENT_RESULT,
        payload: json!({
            "turnId": lineage.parent_turn_id,
            "childSessionId": lineage.session_id,
            "childPath": lineage.path,
            "childTurnId": child_turn_id,
            "status": label,
            "mailId": mail.id,
        }),
    });
    parent.mailbox.push_back(mail);
}

fn close_event(
    session_id: &str,
    path: &AgentPath,
    reason: &str,
    turn_id: Option<&str>,
) -> PendingEvent {
    PendingEvent {
        session_id: session_id.to_string(),
        kind: EVENT_AGENT_CLOSE,
        payload: json!({
            "turnId": turn_id,
            "sessionId": session_id,
            "path": path,
            "reason": reason,
        }),
    }
}

/// Whether `session_id` names a session the control created for an agent, as
/// opposed to a chat the user started. Such a session belongs to its root's
/// project but keeps its files apart from the user's session list.
#[must_use]
pub fn is_agent_session_id(session_id: &str) -> bool {
    // `agent-<16 hex digits of nonce>-<sequence>`, exactly as `next_id` writes it.
    let mut parts = session_id.splitn(3, '-');
    parts.next() == Some(AGENT_SESSION_ID_PREFIX)
        && parts.next().is_some_and(|nonce| {
            nonce.len() == 16 && nonce.bytes().all(|byte| byte.is_ascii_hexdigit())
        })
        && parts.next().is_some_and(|sequence| {
            !sequence.is_empty() && sequence.bytes().all(|byte| byte.is_ascii_digit())
        })
}

/// Take the exclusive advisory lock that marks this process as the one running
/// a project's agents. The operating system drops it when the process ends,
/// however it ends, so a held lock means a live owner. `None` means someone else
/// has it or it could not be set up; the caller must then not touch open edges.
fn acquire_owner_lock(agents_dir: &Path) -> Option<fs::File> {
    fs::create_dir_all(agents_dir).ok()?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(agents_dir.join(OWNER_LOCK_FILE))
        .ok()?;
    file.try_lock().ok()?;
    Some(file)
}

fn validate_session_id(session_id: &str) -> Result<(), AgentControlError> {
    if session_id.trim().is_empty()
        || session_id.chars().count() > MAX_SESSION_ID_CHARS
        || session_id.contains(['/', '\\'])
        || session_id.contains("..")
        || session_id.chars().any(char::is_control)
    {
        return Err(AgentControlError::InvalidName(
            "invalid session id".to_string(),
        ));
    }
    Ok(())
}

fn validate_role(role: &str) -> Result<(), AgentControlError> {
    let valid = !role.is_empty()
        && role.chars().count() <= MAX_ROLE_CHARS
        && role
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' || ch == '-');
    if valid {
        Ok(())
    } else {
        Err(AgentControlError::InvalidName(format!(
            "role `{role}` must be 1-{MAX_ROLE_CHARS} characters of a-z, 0-9, _ or -"
        )))
    }
}

fn bounded_content(content: &str) -> Result<String, AgentControlError> {
    bounded_content_to(content, MAX_MAIL_CONTENT_CHARS)
}

fn bounded_content_to(content: &str, limit: usize) -> Result<String, AgentControlError> {
    if content.trim().is_empty() {
        return Err(AgentControlError::NotPermitted(
            "a message cannot be empty".to_string(),
        ));
    }
    Ok(truncate_chars(content, limit))
}

fn truncate_chars(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    let kept = text.chars().take(limit).collect::<String>();
    format!("{kept}\n[... truncated: the message exceeded {limit} characters ...]")
}

/// 64 random bits, hex, so ids made by different processes do not collide.
fn random_nonce() -> String {
    use std::fmt::Write as _;

    let mut bytes = [0_u8; 8];
    if getrandom::fill(&mut bytes).is_err() {
        // No system entropy: the clock is still different in every process.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos());
        bytes.copy_from_slice(&nanos.to_le_bytes()[..8]);
    }
    bytes.iter().fold(String::new(), |mut hex, byte| {
        let _ = write!(hex, "{byte:02x}");
        hex
    })
}

#[cfg(test)]
#[path = "tests/agent_control.rs"]
mod tests;
