use super::*;
use crate::chat_events::{bind_session_event_dir, read_events_for_session_in_dir};
use runtime::agent_control::{
    read_edges, AgentStatus, EdgeStatus, MailCause, MailKind, SendRequest, SpawnOrigin,
    SpawnRequest,
};
use runtime::{
    ApiRequest, AssistantEvent, ContentBlock, ConversationMessage, MessageRole, PermissionMode,
    PermissionPolicy, RuntimeError, RuntimeEvent, Session, StaticToolExecutor,
};
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};

// ---- fixtures ---------------------------------------------------------------

/// A project's sessions directory in a place of its own, removed afterwards.
pub(crate) struct TempProject {
    pub(crate) root: PathBuf,
}

impl TempProject {
    pub(crate) fn new(label: &str) -> Self {
        let root = std::env::temp_dir().join(format!(
            "somniq-agent-threads-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos()
        ));
        fs::create_dir_all(root.join("sessions")).expect("sessions dir");
        Self { root }
    }

    pub(crate) fn sessions_dir(&self) -> PathBuf {
        self.root.join("sessions")
    }
}

impl Drop for TempProject {
    fn drop(&mut self) {
        // The cached control holds the directory's lock file open.
        evict_control(&self.sessions_dir());
        let _ = fs::remove_dir_all(&self.root);
    }
}

/// Keep a chat's own events in the test's directory rather than wherever the
/// process-wide default would put them.
pub(crate) fn bind_chat(
    project: &TempProject,
    session_id: &str,
) -> crate::chat_events::SessionEventDirGuard {
    bind_session_event_dir(session_id, project.sessions_dir()).expect("bind chat events")
}

type Requests = Arc<Mutex<Vec<Vec<ConversationMessage>>>>;

/// A model that answers "done" to everything and remembers what it was sent.
struct Scripted {
    requests: Requests,
}

impl ApiClient for Scripted {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        self.requests.lock().unwrap().push(request.messages);
        Ok(vec![
            AssistantEvent::TextDelta("done".to_string()),
            AssistantEvent::MessageStop,
        ])
    }
}

fn chat_runtime(requests: &Requests) -> ConversationRuntime<Scripted, StaticToolExecutor> {
    ConversationRuntime::new(
        Session::new(),
        Scripted {
            requests: Arc::clone(requests),
        },
        StaticToolExecutor::new(),
        PermissionPolicy::new(PermissionMode::DangerFullAccess),
        vec!["system".to_string()],
    )
}

#[derive(Clone, Default)]
struct SeenEvents(Arc<Mutex<Vec<String>>>);

impl SeenEvents {
    fn all(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }
}

struct RecordingSink(SeenEvents);

impl EventSink for RecordingSink {
    fn emit(&mut self, event: &RuntimeEvent) {
        self.0 .0.lock().unwrap().push(event.event_type.to_string());
    }
}

fn controller_spawn(parent: &str, name: &str, role: &str) -> SpawnRequest {
    SpawnRequest {
        parent_session_id: parent.to_string(),
        name: name.to_string(),
        role: role.to_string(),
        origin: SpawnOrigin::Controller,
        spawn_ref: Some("action-1".to_string()),
        parent_turn_id: Some("turn-1".to_string()),
    }
}

fn mail_text(messages: &[ConversationMessage]) -> Vec<String> {
    messages
        .iter()
        .filter(|message| message.role == MessageRole::User)
        .flat_map(|message| &message.blocks)
        .filter_map(|block| match block {
            ContentBlock::Text { text } if text.starts_with("[Inter-agent message") => {
                Some(text.clone())
            }
            _ => None,
        })
        .collect()
}

// ---- the control of a project ---------------------------------------------------

#[test]
fn a_project_has_one_control_and_projects_keep_their_own() {
    let first = TempProject::new("first");
    let second = TempProject::new("second");

    let a = control_for(&first.sessions_dir()).expect("first");
    let again = control_for(&first.sessions_dir()).expect("first again");
    let b = control_for(&second.sessions_dir()).expect("second");
    a.register_root("chat-shared-registry", None).unwrap();

    assert_eq!(again.status("chat-shared-registry"), AgentStatus::PendingInit);
    assert_eq!(b.status("chat-shared-registry"), AgentStatus::NotFound);
    assert!(a.owns_directory());
    assert!(agents_dir(&first.sessions_dir()).join(".owner.lock").is_file());
}

// ---- a turn's hooks -----------------------------------------------------------------

#[test]
fn a_chat_turn_reports_its_lifecycle_and_the_desktop_sink_still_hears_everything() {
    let project = TempProject::new("lifecycle");
    let _bound = bind_chat(&project, "chat-lifecycle");
    let agent = TurnAgent::register(
        &project.sessions_dir(),
        "chat-lifecycle",
        "turn-1",
        Some("project-1"),
    )
    .expect("a root");
    assert_eq!(agent.session_id(), "chat-lifecycle");
    assert_eq!(agent.turn_id(), "turn-1");
    assert_eq!(agent.control().status("chat-lifecycle"), AgentStatus::PendingInit);
    let requests = Requests::default();
    let seen = SeenEvents::default();

    let mut runtime = attach_to_runtime(
        Some(&agent),
        chat_runtime(&requests),
        Box::new(RecordingSink(seen.clone())),
    );
    runtime.run_turn("hello", None).unwrap();

    assert_eq!(
        agent.control().status("chat-lifecycle"),
        AgentStatus::Completed(Some("done".to_string())),
        "the control learned how the turn ended from the runtime itself"
    );
    let heard = seen.all();
    assert!(heard.contains(&"turn_started".to_string()), "{heard:?}");
    assert!(heard.contains(&"turn_finished:completed".to_string()), "{heard:?}");
}

#[test]
fn a_chat_without_an_agent_still_gets_its_desktop_sink() {
    let requests = Requests::default();
    let seen = SeenEvents::default();

    let mut runtime = attach_to_runtime(
        None,
        chat_runtime(&requests),
        Box::new(RecordingSink(seen.clone())),
    );
    runtime.run_turn("hello", None).unwrap();

    assert!(seen.all().contains(&"turn_finished:completed".to_string()));
    assert_eq!(requests.lock().unwrap().len(), 1);
}

#[test]
fn mail_for_the_chat_joins_its_next_request_exactly_once() {
    let project = TempProject::new("mail");
    let _bound = bind_chat(&project, "chat-mail");
    let agent = TurnAgent::register(&project.sessions_dir(), "chat-mail", "turn-1", None)
        .expect("a root");
    let scout = agent
        .control()
        .spawn(SpawnRequest {
            origin: SpawnOrigin::Model,
            ..controller_spawn("chat-mail", "scout_1", "scout")
        })
        .expect("scout");
    agent
        .control()
        .send(SendRequest {
            author_session_id: scout.session_id.clone(),
            target: "/root".to_string(),
            kind: MailKind::Message,
            content: "section 3 is ready".to_string(),
            trigger_turn: false,
            cause: MailCause::default(),
        })
        .expect("the scout reports in");
    let requests = Requests::default();

    let mut first = attach_to_runtime(
        Some(&agent),
        chat_runtime(&requests),
        Box::new(RecordingSink(SeenEvents::default())),
    );
    first.run_turn("what is ready?", None).unwrap();
    let next = TurnAgent::register(&project.sessions_dir(), "chat-mail", "turn-2", None)
        .expect("the same root on its next turn");
    let mut second = attach_to_runtime(
        Some(&next),
        chat_runtime(&requests),
        Box::new(RecordingSink(SeenEvents::default())),
    );
    second.run_turn("and now?", None).unwrap();

    let requests = requests.lock().unwrap();
    let delivered = mail_text(&requests[0]);
    assert_eq!(delivered.len(), 1, "the mail joined the first request: {delivered:?}");
    assert!(delivered[0].contains("from /root/scout_1"));
    assert!(delivered[0].ends_with("section 3 is ready"));
    assert!(mail_text(&requests[1]).is_empty(), "and was not delivered again");
    assert_eq!(agent.control().pending_mail("chat-mail"), 0);
    let log = read_events_for_session_in_dir(
        "chat-mail",
        &project.sessions_dir(),
        Some(&["agent.mail.delivered"]),
    )
    .unwrap();
    assert_eq!(log.len(), 1, "the delivery is in the chat's own log: {log:?}");
    assert_eq!(log[0].payload["turnId"], serde_json::json!("turn-1"));
}

// ---- the agents' own sessions -------------------------------------------------------

#[test]
fn an_agents_events_go_to_the_agents_directory_and_never_to_the_session_list() {
    let project = TempProject::new("agent-files");
    let _bound = bind_chat(&project, "chat-files");
    let agent = TurnAgent::register(&project.sessions_dir(), "chat-files", "turn-1", None)
        .expect("a root");

    let reviewer = agent
        .control()
        .spawn(controller_spawn("chat-files", "~reviewer", "reviewer"))
        .expect("reviewer");

    let log = agents_dir(&project.sessions_dir()).join(format!("{}.events.jsonl", reviewer.session_id));
    let text = fs::read_to_string(&log).expect("the lineage is the first event of its session");
    assert!(text.contains("agent.lineage"), "{text}");
    let in_session_list = fs::read_dir(project.sessions_dir())
        .unwrap()
        .flatten()
        .any(|entry| entry.file_name().to_string_lossy().starts_with("agent-"));
    assert!(!in_session_list, "nothing an agent wrote sits among the chats");
    let spawned = read_events_for_session_in_dir(
        "chat-files",
        &project.sessions_dir(),
        Some(&["agent.spawn"]),
    )
    .unwrap();
    assert_eq!(spawned.len(), 1, "the parent's own log says it started the reviewer");
}

// ---- Stop and deletion -----------------------------------------------------------------

#[test]
fn stop_reaches_the_reviewer_of_that_chat_and_no_other() {
    let project = TempProject::new("stop");
    let _bound_a = bind_chat(&project, "chat-stop-a");
    let _bound_b = bind_chat(&project, "chat-stop-b");
    let a = TurnAgent::register(&project.sessions_dir(), "chat-stop-a", "turn-a", None).unwrap();
    let b = TurnAgent::register(&project.sessions_dir(), "chat-stop-b", "turn-b", None).unwrap();
    let reviewer_a = a
        .control()
        .spawn(SpawnRequest { parent_turn_id:Some(a.turn_id().into()), ..controller_spawn("chat-stop-a", "~reviewer", "reviewer") })
        .unwrap();
    let reviewer_b = b
        .control()
        .spawn(SpawnRequest { parent_turn_id:Some(b.turn_id().into()), ..controller_spawn("chat-stop-b", "~reviewer", "reviewer") })
        .unwrap();

    cancel_session_tree("chat-stop-a");

    assert!(reviewer_a.cancel.load(Ordering::SeqCst));
    assert!(!reviewer_b.cancel.load(Ordering::SeqCst), "another chat keeps running");
    cancel_session_tree("a-chat-nobody-registered");
}

#[test]
fn deleting_a_chat_closes_its_agents_and_removes_their_sessions() {
    let project = TempProject::new("delete");
    let _bound = bind_chat(&project, "chat-delete");
    let agent = TurnAgent::register(&project.sessions_dir(), "chat-delete", "turn-1", None).unwrap();
    let reviewer = agent
        .control()
        .spawn(controller_spawn("chat-delete", "~reviewer", "reviewer"))
        .unwrap();
    let agents = agents_dir(&project.sessions_dir());
    let reviewer_log = agents.join(format!("{}.events.jsonl", reviewer.session_id));
    assert!(reviewer_log.is_file());

    forget_session("chat-delete");

    assert_eq!(agent.control().status(&reviewer.session_id), AgentStatus::Shutdown);
    assert!(reviewer.cancel.load(Ordering::SeqCst), "closing stops whatever it was doing");
    assert!(!reviewer_log.exists(), "an agent's session goes with its chat");
    let edges = read_edges(&agents);
    assert_eq!(edges.len(), 1);
    assert_eq!(edges[0].status, EdgeStatus::Closed);
    assert_eq!(edges[0].closed_reason.as_deref(), Some("session deleted"));
    // The chat's own log records the closing where its turn bound it; deleting
    // the chat's files is what removes that log, and it follows this call.
    let closed = read_events_for_session_in_dir(
        "chat-delete",
        &project.sessions_dir(),
        Some(&["agent.close"]),
    )
    .unwrap();
    assert!(!closed.is_empty(), "the closing was written to the chat's log");

    // Deleting twice, or deleting a chat that never had an agent, is harmless...
    forget_session("chat-delete");
    forget_session("a-chat-nobody-registered");
    // ...and a deleted chat is not quietly revived as a root.
    assert!(TurnAgent::register(&project.sessions_dir(), "chat-delete", "turn-2", None).is_none());
}
