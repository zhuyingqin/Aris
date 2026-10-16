//! Reduce an agent tree's `agent.*` events into an interaction graph.
//!
//! [`crate::agent_control`] writes facts where they happen: a spawn into the
//! parent's log, a child's turns and tool calls into the child's log, a mail's
//! sending into the author's log and its delivery into the recipient's. None of
//! those logs alone can say where a conclusion came from. [`reduce_agent_trace`]
//! joins them on the ids the control stamps everywhere (session, turn, tool use
//! and mail ids), so a child's result can be followed back through the child
//! turn that produced it, the tools that turn called and the mail that started
//! it, to the parent's tool call behind the spawn.
//!
//! The reducer is pure and offline: it reads what the logs already hold, and a
//! missing or damaged log leaves gaps rather than errors.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::Value;

use crate::agent_control::{AgentEdge, EdgeStatus, ROOT_AGENT_PATH};

/// One row of a session's event log, as the host read it.
#[derive(Clone, Debug, PartialEq)]
pub struct TraceEvent {
    /// The session whose log held the row.
    pub session_id: String,
    pub seq: u64,
    pub ts: u64,
    pub kind: String,
    pub payload: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InteractionKind {
    SpawnAgent,
    AssignTask,
    SendMessage,
    AgentResult,
    CloseAgent,
    ReviewRequest,
    ReviewVerdict,
}

impl InteractionKind {
    fn from_mail_kind(kind: &str) -> Option<Self> {
        Some(match kind {
            "task" => Self::AssignTask,
            "message" => Self::SendMessage,
            "result" => Self::AgentResult,
            "review_request" => Self::ReviewRequest,
            "verdict" => Self::ReviewVerdict,
            _ => return None,
        })
    }
}

/// Something one agent did to another.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionEdge {
    /// `mail-…` for mail, `spawn:<child>` / `close:<child>` otherwise.
    pub id: String,
    pub kind: InteractionKind,
    pub from_session_id: Option<String>,
    pub from_path: Option<String>,
    pub to_session_id: Option<String>,
    pub to_path: Option<String>,
    pub mail_id: Option<String>,
    /// The sender's turn.
    pub source_turn_id: Option<String>,
    /// The sender's tool call behind it, when a model caused it.
    pub source_tool_use_id: Option<String>,
    /// The controller action behind it, such as a review attempt.
    pub source_action_id: Option<String>,
    pub ts: Option<u64>,
    /// The recipient's turn that read the mail; `None` while undelivered.
    pub delivered_turn_id: Option<String>,
    pub delivered_ts: Option<u64>,
    /// Result state, close reason or review verdict.
    pub status: Option<String>,
    /// For a verdict: the tool calls the Reviewer actually made.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_checks: Vec<String>,
}

impl InteractionEdge {
    fn new(id: String, kind: InteractionKind) -> Self {
        Self {
            id,
            kind,
            from_session_id: None,
            from_path: None,
            to_session_id: None,
            to_path: None,
            mail_id: None,
            source_turn_id: None,
            source_tool_use_id: None,
            source_action_id: None,
            ts: None,
            delivered_turn_id: None,
            delivered_ts: None,
            status: None,
            tool_checks: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceToolCall {
    pub tool_use_id: Option<String>,
    pub tool_name: String,
    pub started_ts: Option<u64>,
    pub finished_ts: Option<u64>,
    pub is_error: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceTurn {
    pub turn_id: String,
    pub started_ts: Option<u64>,
    pub finished_ts: Option<u64>,
    /// `completed`, `interrupted` or `errored` once the turn ended.
    pub status: Option<String>,
    pub reason: Option<String>,
    pub tools: Vec<TraceToolCall>,
    /// Edge ids of the mail this turn read.
    pub received: Vec<String>,
    /// Edge ids of the mail this turn sent.
    pub sent: Vec<String>,
}

impl TraceTurn {
    fn new(turn_id: &str) -> Self {
        Self {
            turn_id: turn_id.to_string(),
            started_ts: None,
            finished_ts: None,
            status: None,
            reason: None,
            tools: Vec::new(),
            received: Vec::new(),
            sent: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceNode {
    pub session_id: String,
    pub path: String,
    pub parent_session_id: Option<String>,
    pub role: Option<String>,
    pub origin: Option<String>,
    pub depth: usize,
    pub closed_reason: Option<String>,
    /// Turns in the order they first appear. The root has none: its turns are
    /// the chat's own and live in the chat's log.
    pub turns: Vec<TraceTurn>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTrace {
    pub root_session_id: String,
    pub nodes: Vec<TraceNode>,
    /// In the order they happened.
    pub edges: Vec<InteractionEdge>,
}

impl AgentTrace {
    #[must_use]
    pub fn node(&self, session_id: &str) -> Option<&TraceNode> {
        self.nodes.iter().find(|node| node.session_id == session_id)
    }

    #[must_use]
    pub fn edge(&self, id: &str) -> Option<&InteractionEdge> {
        self.edges.iter().find(|edge| edge.id == id)
    }

    /// The turn that sent `edge`, if the sender's log recorded it.
    #[must_use]
    pub fn source_turn(&self, edge: &InteractionEdge) -> Option<&TraceTurn> {
        let node = self.node(edge.from_session_id.as_deref()?)?;
        let turn = edge.source_turn_id.as_deref()?;
        node.turns.iter().find(|candidate| candidate.turn_id == turn)
    }

    /// Everything `edge` rests on, nearest first: the mail its source turn read,
    /// then what that mail rests on, until a mail sent from the root (whose
    /// `source_tool_use_id` names the chat's tool call) or a gap in the logs.
    /// Each edge appears once.
    #[must_use]
    pub fn provenance(&self, edge_id: &str) -> Vec<&InteractionEdge> {
        let mut chain = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut pending = vec![edge_id.to_string()];
        while let Some(id) = pending.pop() {
            let Some(edge) = self.edge(&id) else { continue };
            if !seen.insert(id) {
                continue;
            }
            if let Some(turn) = self.source_turn(edge) {
                // Pushed in reverse so the earliest mail is followed first.
                pending.extend(turn.received.iter().rev().cloned());
            }
            if edge.id != edge_id {
                chain.push(edge);
            }
        }
        chain
    }
}

fn text(payload: &Value, key: &str) -> Option<String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn fill(slot: &mut Option<String>, value: Option<String>) {
    if slot.is_none() {
        *slot = value;
    }
}

struct Reducer {
    root: String,
    nodes: Vec<TraceNode>,
    node_index: HashMap<String, usize>,
    edges: Vec<InteractionEdge>,
    edge_index: HashMap<String, usize>,
}

impl Reducer {
    fn add_node(&mut self, node: TraceNode) {
        if !self.node_index.contains_key(&node.session_id) {
            self.node_index
                .insert(node.session_id.clone(), self.nodes.len());
            self.nodes.push(node);
        }
    }

    fn path_of(&self, session_id: Option<&str>) -> Option<String> {
        let index = *self.node_index.get(session_id?)?;
        Some(self.nodes[index].path.clone())
    }

    fn edge(&mut self, id: &str, kind: InteractionKind) -> &mut InteractionEdge {
        let index = match self.edge_index.get(id) {
            Some(index) => *index,
            None => {
                self.edge_index.insert(id.to_string(), self.edges.len());
                self.edges.push(InteractionEdge::new(id.to_string(), kind));
                self.edges.len() - 1
            }
        };
        &mut self.edges[index]
    }

    /// The turn of a non-root node, created when first seen.
    fn turn(&mut self, session_id: &str, turn_id: Option<&str>) -> Option<&mut TraceTurn> {
        let turn_id = turn_id?;
        if session_id == self.root {
            return None;
        }
        let node = &mut self.nodes[*self.node_index.get(session_id)?];
        let index = match node.turns.iter().position(|turn| turn.turn_id == turn_id) {
            Some(index) => index,
            None => {
                node.turns.push(TraceTurn::new(turn_id));
                node.turns.len() - 1
            }
        };
        Some(&mut node.turns[index])
    }

    fn apply(&mut self, event: &TraceEvent) {
        let p = &event.payload;
        let at = event.session_id.as_str();
        let turn_id = text(p, "turnId");
        match event.kind.as_str() {
            "agent.spawn" => {
                let Some(child) = text(p, "childSessionId") else { return };
                let from_path = self.path_of(Some(at));
                let edge = self.edge(&format!("spawn:{child}"), InteractionKind::SpawnAgent);
                fill(&mut edge.from_session_id, Some(at.to_string()));
                fill(&mut edge.from_path, from_path);
                fill(&mut edge.to_session_id, Some(child));
                fill(&mut edge.to_path, text(p, "childPath"));
                fill(&mut edge.source_turn_id, turn_id);
                fill(&mut edge.source_tool_use_id, text(p, "spawnRef"));
                edge.ts.get_or_insert(event.ts);
                fill(&mut edge.status, text(p, "origin"));
            }
            "agent.mail.sent" => {
                let Some(mail) = text(p, "mailId") else { return };
                let Some(kind) = p
                    .get("kind")
                    .and_then(Value::as_str)
                    .and_then(InteractionKind::from_mail_kind)
                else {
                    return;
                };
                let edge = self.edge(&mail, kind);
                edge.mail_id = Some(mail.clone());
                edge.from_session_id = Some(at.to_string());
                fill(&mut edge.from_path, text(p, "from"));
                fill(&mut edge.to_session_id, text(p, "toSessionId"));
                fill(&mut edge.to_path, text(p, "to"));
                fill(&mut edge.source_turn_id, turn_id.clone());
                fill(&mut edge.source_tool_use_id, text(p, "toolUseId"));
                fill(&mut edge.source_action_id, text(p, "actionId"));
                edge.ts = Some(event.ts);
                if let Some(turn) = self.turn(at, turn_id.as_deref()) {
                    if !turn.sent.contains(&mail) {
                        turn.sent.push(mail);
                    }
                }
            }
            "agent.mail.delivered" => {
                let Some(mail) = text(p, "mailId") else { return };
                let Some(kind) = p
                    .get("kind")
                    .and_then(Value::as_str)
                    .and_then(InteractionKind::from_mail_kind)
                else {
                    return;
                };
                let edge = self.edge(&mail, kind);
                edge.mail_id = Some(mail.clone());
                edge.to_session_id = Some(at.to_string());
                fill(&mut edge.to_path, text(p, "to"));
                fill(&mut edge.from_session_id, text(p, "fromSessionId"));
                fill(&mut edge.from_path, text(p, "from"));
                fill(&mut edge.source_turn_id, text(p, "sentTurnId"));
                edge.delivered_turn_id = turn_id.clone();
                edge.delivered_ts = Some(event.ts);
                if let Some(turn) = self.turn(at, turn_id.as_deref()) {
                    if !turn.received.contains(&mail) {
                        turn.received.push(mail);
                    }
                }
            }
            "agent.result" => {
                let Some(mail) = text(p, "mailId") else { return };
                let edge = self.edge(&mail, InteractionKind::AgentResult);
                edge.mail_id = Some(mail.clone());
                fill(&mut edge.from_session_id, text(p, "childSessionId"));
                fill(&mut edge.from_path, text(p, "childPath"));
                fill(&mut edge.to_session_id, Some(at.to_string()));
                fill(&mut edge.source_turn_id, text(p, "childTurnId"));
                edge.ts.get_or_insert(event.ts);
                edge.status = text(p, "status");
            }
            "agent.close" => {
                if let Some(child) = text(p, "childSessionId") {
                    let from_path = self.path_of(Some(at));
                    let edge = self.edge(&format!("close:{child}"), InteractionKind::CloseAgent);
                    fill(&mut edge.from_session_id, Some(at.to_string()));
                    fill(&mut edge.from_path, from_path);
                    fill(&mut edge.to_session_id, Some(child.clone()));
                    fill(&mut edge.to_path, text(p, "childPath"));
                    edge.ts.get_or_insert(event.ts);
                    fill(&mut edge.status, text(p, "reason"));
                    if let Some(index) = self.node_index.get(&child) {
                        fill(&mut self.nodes[*index].closed_reason, text(p, "reason"));
                    }
                } else if let Some(index) = self.node_index.get(at) {
                    fill(&mut self.nodes[*index].closed_reason, text(p, "reason"));
                }
            }
            "agent.review.request" => {
                let Some(mail) = text(p, "mailId") else { return };
                let reviewer = text(p, "reviewerSessionId");
                let edge = self.edge(&mail, InteractionKind::ReviewRequest);
                edge.mail_id = Some(mail);
                fill(&mut edge.from_session_id, Some(at.to_string()));
                fill(&mut edge.from_path, Some(ROOT_AGENT_PATH.to_string()));
                fill(&mut edge.to_session_id, reviewer);
                fill(&mut edge.to_path, text(p, "reviewerPath"));
                fill(&mut edge.source_turn_id, turn_id);
                edge.ts.get_or_insert(event.ts);
            }
            "agent.review.verdict" => {
                // The verdict comes back through the controller, not as mail,
                // so its edge is keyed by the event itself.
                let reviewer = text(p, "reviewerSessionId");
                let reviewer_path = self.path_of(reviewer.as_deref());
                let edge = self.edge(
                    &format!("verdict:{at}:{}", event.seq),
                    InteractionKind::ReviewVerdict,
                );
                edge.from_session_id = reviewer;
                edge.from_path = reviewer_path;
                edge.to_session_id = Some(at.to_string());
                edge.to_path = Some(ROOT_AGENT_PATH.to_string());
                edge.delivered_turn_id = turn_id;
                edge.ts = Some(event.ts);
                edge.delivered_ts = Some(event.ts);
                edge.status = text(p, "verdict");
                edge.tool_checks = p
                    .get("toolChecks")
                    .and_then(Value::as_array)
                    .map(|checks| {
                        checks
                            .iter()
                            .filter_map(|check| check.as_str().map(str::to_string))
                            .collect()
                    })
                    .unwrap_or_default();
            }
            "agent.turn.started" => {
                if let Some(turn) = self.turn(at, turn_id.as_deref()) {
                    turn.started_ts.get_or_insert(event.ts);
                }
            }
            "agent.turn.finished" => {
                if let Some(turn) = self.turn(at, turn_id.as_deref()) {
                    turn.finished_ts = Some(event.ts);
                    turn.status = text(p, "status");
                    turn.reason = text(p, "reason");
                }
            }
            "agent.tool.started" => {
                let name = text(p, "toolName").unwrap_or_default();
                if let Some(turn) = self.turn(at, turn_id.as_deref()) {
                    turn.tools.push(TraceToolCall {
                        tool_use_id: text(p, "toolUseId"),
                        tool_name: name,
                        started_ts: Some(event.ts),
                        finished_ts: None,
                        is_error: None,
                    });
                }
            }
            "agent.tool.finished" => {
                let name = text(p, "toolName").unwrap_or_default();
                let is_error = p.get("isError").and_then(Value::as_bool);
                let tool_use_id = text(p, "toolUseId");
                if let Some(turn) = self.turn(at, turn_id.as_deref()) {
                    // The finish row carries the id when the writer had it;
                    // otherwise it pairs with the oldest open call of that name.
                    let open = turn.tools.iter_mut().find(|call| {
                        call.finished_ts.is_none()
                            && match (&tool_use_id, &call.tool_use_id) {
                                (Some(id), Some(call_id)) => id == call_id,
                                _ => call.tool_name == name,
                            }
                    });
                    match open {
                        Some(call) => {
                            call.finished_ts = Some(event.ts);
                            call.is_error = is_error;
                        }
                        None => turn.tools.push(TraceToolCall {
                            tool_use_id,
                            tool_name: name,
                            started_ts: None,
                            finished_ts: Some(event.ts),
                            is_error,
                        }),
                    }
                }
            }
            _ => {}
        }
    }
}

/// Build the interaction graph of the tree under `root_session_id`.
///
/// `edges` is the project's edge log ([`crate::agent_control::read_edges`]);
/// agents of other roots in it are ignored. `events` are the `agent.*` rows of
/// the root's log and of every agent's own log, in any order; rows of sessions
/// outside the tree are ignored.
#[must_use]
pub fn reduce_agent_trace(
    root_session_id: &str,
    edges: &[AgentEdge],
    events: &[TraceEvent],
) -> AgentTrace {
    let mut reducer = Reducer {
        root: root_session_id.to_string(),
        nodes: Vec::new(),
        node_index: HashMap::new(),
        edges: Vec::new(),
        edge_index: HashMap::new(),
    };
    reducer.add_node(TraceNode {
        session_id: root_session_id.to_string(),
        path: ROOT_AGENT_PATH.to_string(),
        parent_session_id: None,
        role: None,
        origin: None,
        depth: 0,
        closed_reason: None,
        turns: Vec::new(),
    });
    for edge in edges {
        let Some(lineage) = &edge.lineage else { continue };
        if lineage.root_session_id != root_session_id {
            continue;
        }
        reducer.add_node(TraceNode {
            session_id: lineage.session_id.clone(),
            path: lineage.path.as_str().to_string(),
            parent_session_id: lineage.parent_session_id.clone(),
            role: Some(lineage.role.clone()),
            origin: Some(lineage.origin.as_str().to_string()),
            depth: lineage.depth,
            closed_reason: match edge.status {
                EdgeStatus::Closed => edge.closed_reason.clone(),
                EdgeStatus::Open => None,
            },
            turns: Vec::new(),
        });
    }
    // An agent whose edge row was lost still announced itself in its own log.
    for event in events.iter().filter(|event| event.kind == "agent.lineage") {
        let p = &event.payload;
        if text(p, "rootSessionId").as_deref() != Some(root_session_id) {
            continue;
        }
        let Some(path) = text(p, "path") else { continue };
        reducer.add_node(TraceNode {
            session_id: event.session_id.clone(),
            path,
            parent_session_id: text(p, "parentSessionId"),
            role: text(p, "role"),
            origin: text(p, "origin"),
            depth: p.get("depth").and_then(Value::as_u64).unwrap_or(1) as usize,
            closed_reason: None,
            turns: Vec::new(),
        });
    }

    let mut ordered: Vec<&TraceEvent> = events
        .iter()
        .filter(|event| reducer.node_index.contains_key(&event.session_id))
        .collect();
    // Logs are separate files with separate sequence numbers; time orders them
    // against each other, and each log's own order breaks ties.
    ordered.sort_by(|a, b| {
        a.ts.cmp(&b.ts)
            .then_with(|| a.session_id.cmp(&b.session_id))
            .then_with(|| a.seq.cmp(&b.seq))
    });
    for event in ordered {
        reducer.apply(event);
    }
    reducer
        .edges
        .sort_by_key(|edge| edge.ts.or(edge.delivered_ts).unwrap_or(u64::MAX));

    AgentTrace {
        root_session_id: root_session_id.to_string(),
        nodes: reducer.nodes,
        edges: reducer.edges,
    }
}

#[cfg(test)]
#[path = "tests/agent_trace.rs"]
mod tests;
