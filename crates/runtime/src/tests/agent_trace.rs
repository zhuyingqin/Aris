use super::*;
use crate::agent_control::{
    read_edges, AgentControl, AgentControlConfig, AgentEventRecorder, AgentHandle, MailCause,
    MailKind, SendRequest, SpawnOrigin, SpawnRequest,
};
use crate::conversation::TurnInputSource;
use crate::event_sink::{EventType, TurnOutcome};
use crate::session::Session;
use serde_json::json;
use std::sync::{Arc, Mutex};

type Log = Arc<Mutex<Vec<TraceEvent>>>;

/// Records the control's events the way a host's logs would hold them: in
/// order, each with its own sequence number and a clock that only moves on.
fn recorder(log: &Log) -> AgentEventRecorder {
    let log = Arc::clone(log);
    Arc::new(move |session_id, kind, payload| {
        let mut log = log.lock().unwrap();
        let n = log.len() as u64;
        log.push(TraceEvent {
            session_id: session_id.to_string(),
            seq: n,
            ts: 1_000 + n,
            kind: kind.to_string(),
            payload,
        });
    })
}

/// What the desktop's child sink writes next to the control's own events.
fn host_event(log: &Log, session_id: &str, kind: &str, payload: serde_json::Value) {
    let mut log = log.lock().unwrap();
    let n = log.len() as u64;
    log.push(TraceEvent {
        session_id: session_id.to_string(),
        seq: n,
        ts: 1_000 + n,
        kind: kind.to_string(),
        payload,
    });
}

struct Tree {
    dir: tempfile::TempDir,
    log: Log,
    control: AgentControl,
}

impl Tree {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let log = Log::default();
        let control = AgentControl::open(
            AgentControlConfig::new(dir.path().join("agents")),
            recorder(&log),
        )
        .unwrap();
        control.register_root("chat-root", Some("project-1")).unwrap();
        control.begin_turn("chat-root", "turn-parent").unwrap();
        Self { dir, log, control }
    }

    fn spawn(&self, name: &str, tool_use_id: &str) -> AgentHandle {
        let child = self
            .control
            .spawn(SpawnRequest {
                parent_session_id: "chat-root".into(),
                name: name.into(),
                role: "read_only".into(),
                origin: SpawnOrigin::Model,
                spawn_ref: Some(tool_use_id.into()),
                parent_turn_id: Some("turn-parent".into()),
            })
            .unwrap();
        self.mail("chat-root", &child.path.to_string(), MailKind::Task, "turn-parent", tool_use_id);
        child
    }

    fn mail(&self, author: &str, target: &str, kind: MailKind, turn: &str, tool_use_id: &str) {
        self.control
            .send(SendRequest {
                author_session_id: author.into(),
                target: target.into(),
                kind,
                content: "work".into(),
                trigger_turn: false,
                cause: MailCause {
                    turn_id: Some(turn.into()),
                    tool_use_id: Some(tool_use_id.into()),
                    action_id: None,
                },
            })
            .unwrap();
    }

    fn read_mail(&self, session_id: &str, turn: &str) {
        let mut source = self.control.turn_input_source(session_id, Some(turn));
        assert!(!source.take_ready().is_empty(), "{session_id} had mail to read");
        source.checkpoint(&Session::new()).unwrap();
    }

    /// One child turn: read the mailbox, call `tools`, finish with `answer`.
    fn child_turn(&self, child: &AgentHandle, turn: &str, tools: &[(&str, &str)], answer: &str) {
        self.control.begin_turn(&child.session_id, turn).unwrap();
        host_event(&self.log, &child.session_id, "agent.turn.started", json!({"turnId": turn}));
        self.read_mail(&child.session_id, turn);
        for (id, name) in tools {
            host_event(
                &self.log,
                &child.session_id,
                "agent.tool.started",
                json!({"turnId": turn, "toolUseId": id, "toolName": name}),
            );
            host_event(
                &self.log,
                &child.session_id,
                "agent.tool.finished",
                json!({"turnId": turn, "toolName": name, "isError": false}),
            );
        }
        self.control.observe_event(
            &child.session_id,
            Some(turn),
            &EventType::TurnFinished {
                outcome: TurnOutcome::Completed,
                last_message: Some(answer.into()),
            },
        );
        host_event(
            &self.log,
            &child.session_id,
            "agent.turn.finished",
            json!({"turnId": turn, "status": "completed"}),
        );
    }

    fn trace(&self) -> AgentTrace {
        let events = self.log.lock().unwrap().clone();
        reduce_agent_trace("chat-root", &read_edges(&self.dir.path().join("agents")), &events)
    }
}

#[test]
fn a_result_traces_back_through_the_child_turn_to_the_tool_call_that_spawned_it() {
    let tree = Tree::new();
    let child = tree.spawn("scout", "toolu_spawn");
    tree.child_turn(&child, "child-1", &[("toolu_read", "read_file"), ("toolu_grep", "grep_search")], "found it");
    tree.control.begin_turn("chat-root", "turn-parent-2").unwrap();
    tree.read_mail("chat-root", "turn-parent-2");

    let trace = tree.trace();
    let result = trace
        .edges
        .iter()
        .find(|edge| edge.kind == InteractionKind::AgentResult)
        .expect("a result edge");
    assert_eq!(result.from_session_id.as_deref(), Some(child.session_id.as_str()));
    assert_eq!(result.to_session_id.as_deref(), Some("chat-root"));
    assert_eq!(result.status.as_deref(), Some("completed"));
    assert_eq!(result.delivered_turn_id.as_deref(), Some("turn-parent-2"));

    // The turn that produced the conclusion, with the tools it called.
    let turn = trace.source_turn(result).expect("the child's turn");
    assert_eq!(turn.turn_id, "child-1");
    let tools: Vec<_> = turn
        .tools
        .iter()
        .map(|call| (call.tool_use_id.as_deref(), call.tool_name.as_str(), call.is_error))
        .collect();
    assert_eq!(
        tools,
        [
            (Some("toolu_read"), "read_file", Some(false)),
            (Some("toolu_grep"), "grep_search", Some(false))
        ]
    );

    // And back to the chat's own tool call.
    let chain = trace.provenance(&result.id);
    assert_eq!(chain.len(), 1, "{chain:?}");
    assert_eq!(chain[0].kind, InteractionKind::AssignTask);
    assert_eq!(chain[0].from_session_id.as_deref(), Some("chat-root"));
    assert_eq!(chain[0].source_turn_id.as_deref(), Some("turn-parent"));
    assert_eq!(chain[0].source_tool_use_id.as_deref(), Some("toolu_spawn"));
    assert_eq!(chain[0].delivered_turn_id.as_deref(), Some("child-1"));
    let spawn = trace.edge(&format!("spawn:{}", child.session_id)).unwrap();
    assert_eq!(spawn.source_tool_use_id.as_deref(), Some("toolu_spawn"));
}

#[test]
fn a_follow_up_is_part_of_the_provenance_of_the_turn_it_started() {
    let tree = Tree::new();
    let child = tree.spawn("scout", "toolu_spawn");
    tree.child_turn(&child, "child-1", &[], "first pass");
    tree.mail("chat-root", "/root/scout", MailKind::Task, "turn-parent", "toolu_follow");
    tree.child_turn(&child, "child-2", &[("toolu_read", "read_file")], "second pass");

    let trace = tree.trace();
    let results: Vec<_> = trace
        .edges
        .iter()
        .filter(|edge| edge.kind == InteractionKind::AgentResult)
        .collect();
    assert_eq!(results.len(), 2);
    let second = results
        .iter()
        .find(|edge| edge.source_turn_id.as_deref() == Some("child-2"))
        .unwrap();
    let sources: Vec<_> = trace
        .provenance(&second.id)
        .iter()
        .filter_map(|edge| edge.source_tool_use_id.clone())
        .collect();
    assert_eq!(sources, ["toolu_follow"], "the second turn read only the follow-up");
    assert_eq!(trace.node(&child.session_id).unwrap().turns.len(), 2);
}

#[test]
fn edges_are_in_time_order_and_a_close_is_recorded_once() {
    let tree = Tree::new();
    let child = tree.spawn("scout", "toolu_spawn");
    tree.child_turn(&child, "child-1", &[], "done");
    tree.control.close(&child.session_id, "finished").unwrap();

    let trace = tree.trace();
    let kinds: Vec<_> = trace.edges.iter().map(|edge| edge.kind).collect();
    assert_eq!(
        kinds,
        [
            InteractionKind::SpawnAgent,
            InteractionKind::AssignTask,
            InteractionKind::AgentResult,
            InteractionKind::CloseAgent
        ]
    );
    let node = trace.node(&child.session_id).unwrap();
    assert_eq!(node.closed_reason.as_deref(), Some("finished"));
    assert_eq!(node.path, "/root/scout");
    assert_eq!(node.parent_session_id.as_deref(), Some("chat-root"));
}

#[test]
fn other_chats_in_the_same_project_stay_out_of_the_trace() {
    let tree = Tree::new();
    let mine = tree.spawn("scout", "toolu_spawn");
    tree.control.register_root("chat-other", Some("project-1")).unwrap();
    let theirs = tree
        .control
        .spawn(SpawnRequest {
            parent_session_id: "chat-other".into(),
            name: "scout".into(),
            role: "read_only".into(),
            origin: SpawnOrigin::Model,
            spawn_ref: Some("toolu_other".into()),
            parent_turn_id: None,
        })
        .unwrap();

    let trace = tree.trace();
    assert!(trace.node(&mine.session_id).is_some());
    assert!(trace.node(&theirs.session_id).is_none());
    assert!(trace.edges.iter().all(|edge| {
        edge.from_session_id.as_deref() != Some(theirs.session_id.as_str())
            && edge.to_session_id.as_deref() != Some(theirs.session_id.as_str())
    }));
}

#[test]
fn a_lost_edge_log_still_yields_the_agents_that_announced_themselves() {
    let tree = Tree::new();
    let child = tree.spawn("scout", "toolu_spawn");
    tree.child_turn(&child, "child-1", &[("toolu_read", "read_file")], "done");
    let events = tree.log.lock().unwrap().clone();

    let trace = reduce_agent_trace("chat-root", &[], &events);
    let node = trace.node(&child.session_id).expect("node from agent.lineage");
    assert_eq!(node.path, "/root/scout");
    assert_eq!(node.turns[0].tools[0].tool_name, "read_file");
}

#[test]
fn a_review_round_is_a_request_and_a_verdict_with_the_reviewers_own_checks() {
    let events = vec![
        TraceEvent {
            session_id: "chat-root".into(),
            seq: 1,
            ts: 10,
            kind: "agent.review.request".into(),
            payload: json!({"turnId":"turn-1","reviewerSessionId":"agent-r","reviewerPath":"/root/~reviewer","mailId":"mail-9","attempt":1}),
        },
        TraceEvent {
            session_id: "chat-root".into(),
            seq: 2,
            ts: 20,
            kind: "agent.review.verdict".into(),
            payload: json!({"turnId":"turn-1","reviewerSessionId":"agent-r","verdict":"revise","toolChecks":["read_file src/a.rs"]}),
        },
    ];
    let trace = reduce_agent_trace("chat-root", &[], &events);
    assert_eq!(trace.edges.len(), 2);
    assert_eq!(trace.edges[0].kind, InteractionKind::ReviewRequest);
    assert_eq!(trace.edges[0].to_path.as_deref(), Some("/root/~reviewer"));
    assert_eq!(trace.edges[1].kind, InteractionKind::ReviewVerdict);
    assert_eq!(trace.edges[1].status.as_deref(), Some("revise"));
    assert_eq!(trace.edges[1].tool_checks, ["read_file src/a.rs"]);
}

#[test]
fn damaged_rows_leave_gaps_not_errors() {
    let events = vec![
        TraceEvent {
            session_id: "chat-root".into(),
            seq: 1,
            ts: 1,
            kind: "agent.mail.sent".into(),
            payload: json!({"kind":"task"}),
        },
        TraceEvent {
            session_id: "chat-root".into(),
            seq: 2,
            ts: 2,
            kind: "agent.mail.delivered".into(),
            payload: json!({"mailId":"mail-1","kind":"unknown"}),
        },
        TraceEvent {
            session_id: "chat-root".into(),
            seq: 3,
            ts: 3,
            kind: "agent.spawn".into(),
            payload: json!("not an object"),
        },
    ];
    let trace = reduce_agent_trace("chat-root", &[], &events);
    assert!(trace.edges.is_empty());
    assert!(trace.provenance("mail-1").is_empty());
}
