use super::*;
use crate::agent_threads::tests::{bind_chat, TempProject};
use crate::agent_threads::{cancel_session_tree, forget_session};
use crate::chat_events::{read_events_for_session_in_dir, SessionEventDirGuard};
use runtime::agent_control::{AgentControlError, SendRequest};
use serde_json::Value;
use runtime::{
    ApiRequest, AssistantEvent, ContentBlock, MessageRole, PermissionOutcome, RuntimeError,
};
use std::collections::VecDeque;

// ---- a scripted Reviewer model --------------------------------------------------

/// The verdict a Reviewer answers with.
pub(crate) fn verdict(verdict: &str) -> String {
    format!(
        r#"{{"verdict":"{verdict}","summary":"checked","issues":[],"evidenceChecked":["the answer"],"missingChecks":[],"revisionInstructions":[],"relevantToGoal":true,"progressDelta":null,"criteriaSatisfied":[]}}"#
    )
}

/// What the scripted model does at its next request.
#[derive(Clone, Debug)]
pub(crate) enum Step {
    /// Answer with this text.
    Say(String),
    /// Ask for a tool, then carry on with the step after it.
    Tool(&'static str, String),
    /// Wait for the answer that never comes, watching for a Stop the way the
    /// real client does.
    Hang,
    /// Fail the request.
    Fail(String),
}

#[derive(Default)]
pub(crate) struct Script {
    steps: VecDeque<Step>,
    requests: Vec<Vec<ConversationMessage>>,
    tools_offered: Vec<Vec<String>>,
    calls: usize,
}

pub(crate) struct FakeBackend {
    signature: String,
    script: Arc<Mutex<Script>>,
}

impl FakeBackend {
    pub(crate) fn new(signature: &str, steps: Vec<Step>) -> Self {
        let script = Script {
            steps: steps.into(),
            ..Script::default()
        };
        Self {
            signature: signature.to_string(),
            script: Arc::new(Mutex::new(script)),
        }
    }

    pub(crate) fn push(&self, steps: Vec<Step>) {
        self.script.lock().unwrap().steps.extend(steps);
    }

    /// The messages of every model request so far.
    pub(crate) fn requests(&self) -> Vec<Vec<ConversationMessage>> {
        self.script.lock().unwrap().requests.clone()
    }

    /// The tool names each client was built with.
    pub(crate) fn tools_offered(&self) -> Vec<Vec<String>> {
        self.script.lock().unwrap().tools_offered.clone()
    }
}

pub(crate) struct FakeClient {
    script: Arc<Mutex<Script>>,
    observer: Box<dyn StreamObserver>,
}

impl ReviewerBackend for FakeBackend {
    type Client = FakeClient;

    fn signature(&self) -> String {
        self.signature.clone()
    }

    fn client(
        &self,
        tools: Vec<ExecutorToolSpec>,
        observer: Box<dyn StreamObserver>,
    ) -> Result<FakeClient, String> {
        self.script
            .lock()
            .unwrap()
            .tools_offered
            .push(tools.into_iter().map(|tool| tool.name).collect());
        Ok(FakeClient {
            script: Arc::clone(&self.script),
            observer,
        })
    }
}

impl ApiClient for FakeClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let (step, call) = {
            let mut script = self.script.lock().unwrap();
            script.requests.push(request.messages);
            script.calls += 1;
            (script.steps.pop_front(), script.calls)
        };
        match step.unwrap_or_else(|| Step::Say(verdict("pass"))) {
            Step::Say(text) => Ok(vec![
                AssistantEvent::TextDelta(text),
                AssistantEvent::Usage(TokenUsage {
                    input_tokens: 100,
                    output_tokens: 20,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                }),
                AssistantEvent::MessageStop,
            ]),
            Step::Tool(name, input) => Ok(vec![
                AssistantEvent::ToolUse {
                    id: format!("call-{call}"),
                    name: name.to_string(),
                    input,
                },
                AssistantEvent::MessageStop,
            ]),
            Step::Fail(message) => Err(RuntimeError::new(message)),
            Step::Hang => loop {
                if self.observer.is_cancelled() {
                    return Err(RuntimeError::new("interrupted by user"));
                }
                std::thread::sleep(Duration::from_millis(10));
            },
        }
    }
}

// ---- a chat with a project ----------------------------------------------------------

pub(crate) struct Chat {
    pub(crate) agent: TurnAgent,
    pub(crate) workspace: PathBuf,
    _bound: SessionEventDirGuard,
    pub(crate) project: TempProject,
}

fn write(path: &Path, contents: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().expect("parent")).expect("directory");
    fs::write(path, contents).expect("file");
}

fn write_workspace(root: &Path) {
    write(&root.join("notes.md"), "# Notes\nsecond line\nthird line\n");
    write(
        &root.join("src/lib.rs"),
        "pub fn answer() -> u32 { 42 }\n// TODO: tighten the answer\n",
    );
    write(&root.join("src/deep/mod.rs"), "// the answer lives here\n");
    write(&root.join(".env"), "TOKEN=hunter2\n");
    write(&root.join("config/secrets.txt"), "do not read\n");
    write(&root.join("keys.md"), "api_key=sk-live-123\nvisible line\n");
    write(&root.join("figure.png"), [0x89, b'P', b'N', b'G']);
    write(&root.join("node_modules/pkg/index.js"), "answer in vendored code\n");
    write(&root.join("big.log"), "x".repeat(1_100_000));
    write(
        &root.parent().expect("project root").join("outside.txt"),
        "outside the workspace\n",
    );
}

pub(crate) fn chat(label: &str) -> Chat {
    let project = TempProject::new(label);
    let session_id = format!("chat-review-{label}");
    let bound = bind_chat(&project, &session_id);
    let agent = TurnAgent::register(&project.sessions_dir(), &session_id, "turn-1", Some("project-1"))
        .expect("the chat is a root");
    let workspace = project.root.join("workspace");
    write_workspace(&workspace);
    Chat {
        agent,
        workspace,
        _bound: bound,
        project,
    }
}

fn round_with(
    chat: &Chat,
    backend: &FakeBackend,
    attempt: usize,
    full: &str,
    incremental: &str,
    cancelled: &Arc<AtomicBool>,
) -> Result<RoundOutput, RoundError> {
    run_round(
        backend,
        &chat.agent,
        cancelled,
        &RoundRequest {
            attempt,
            packets: Packets {
                full: &|| full.to_string(),
                incremental: &|| incremental.to_string(),
            },
            workspace: &chat.workspace,
            provider: "test",
            model: "reviewer-model",
        },
    )
}

fn round(
    chat: &Chat,
    backend: &FakeBackend,
    attempt: usize,
    full: &str,
    incremental: &str,
) -> Result<RoundOutput, RoundError> {
    round_with(
        chat,
        backend,
        attempt,
        full,
        incremental,
        &Arc::new(AtomicBool::new(false)),
    )
}

/// The review requests among a request's messages, header included.
fn mail_texts(messages: &[ConversationMessage]) -> Vec<String> {
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

fn wait_until(what: &str, condition: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

// ---- the Reviewer is the controller's -----------------------------------------------

#[test]
fn no_model_tool_can_address_the_reviewer() {
    let chat = chat("address");
    let backend = FakeBackend::new("model-a", vec![Step::Say(verdict("pass"))]);
    let output = round(&chat, &backend, 1, "FULL", "INCREMENT").expect("a round");
    let control = chat.agent.control();
    let root = chat.agent.session_id();

    // The controller sees it...
    let all = control.list_all(root).unwrap();
    let reviewer = all
        .iter()
        .find(|agent| agent.path.to_string() == "/root/~reviewer")
        .expect("the Reviewer is an agent of the chat's tree");
    assert_eq!(reviewer.role, "reviewer");
    assert_eq!(reviewer.origin, SpawnOrigin::Controller);
    assert_eq!(reviewer.session_id, output.reviewer_session_id);
    // ...and nothing a model can call does.
    assert!(control.list(root).unwrap().iter().all(|agent| !agent.path.is_reserved()));
    for target in ["~reviewer", "/root/~reviewer", "reviewer", "/root/reviewer"] {
        let sent = control.send(SendRequest {
            author_session_id: root.to_string(),
            target: target.to_string(),
            kind: MailKind::Message,
            content: "go easy on this one".to_string(),
            trigger_turn: false,
            cause: MailCause::default(),
        });
        assert!(
            matches!(sent, Err(AgentControlError::UnknownAgent(_))),
            "{target}: {sent:?}"
        );
        assert!(
            matches!(control.resolve(root, target), Err(AgentControlError::UnknownAgent(_))),
            "{target}"
        );
    }
    let model_spawn = |name: &str| {
        control.spawn(SpawnRequest {
            parent_session_id: root.to_string(),
            name: name.to_string(),
            role: "scout".to_string(),
            origin: SpawnOrigin::Model,
            spawn_ref: None,
            parent_turn_id: None,
        })
    };
    assert!(matches!(model_spawn("~reviewer"), Err(AgentControlError::ReservedName(_))));
    assert!(matches!(model_spawn("~anything"), Err(AgentControlError::ReservedName(_))));
    // Nothing the Reviewer says is mail for the Executor.
    assert_eq!(control.pending_mail(root), 0);
    assert_eq!(
        control.status(&output.reviewer_session_id),
        AgentStatus::Completed(Some(verdict("pass"))),
        "the controller reads the outcome from the thread's own status"
    );
}

#[test]
fn the_reviewers_own_tools_read_and_nothing_more() {
    let names = reviewer_tool_specs()
        .into_iter()
        .map(|tool| tool.name)
        .collect::<Vec<_>>();
    assert_eq!(names, REVIEWER_TOOLS.to_vec());

    let policy = reviewer_permission_policy();
    for allowed in REVIEWER_TOOLS {
        assert_eq!(policy.authorize(allowed, "{}", None), PermissionOutcome::Allow, "{allowed}");
    }
    // Nothing that writes, runs or reaches an agent has a place in it.
    for forbidden in [
        "bash",
        "write_file",
        "edit_file",
        "Agent",
        "spawn_agent",
        "send_message",
        "close_agent",
    ] {
        assert!(
            matches!(policy.authorize(forbidden, "{}", None), PermissionOutcome::Deny { .. }),
            "{forbidden}"
        );
    }

    let project = TempProject::new("tool-names");
    let mut tools = tools_in(&project);
    for forbidden in ["bash", "write_file", "spawn_agent", "send_message"] {
        let error = tools.execute(forbidden, "{}").unwrap_err().to_string();
        assert!(error.contains("not available to the Reviewer"), "{forbidden}: {error}");
    }
}

// ---- a thread, not a request -----------------------------------------------------------

#[test]
fn a_later_round_continues_the_same_thread_and_carries_only_the_increment() {
    let chat = chat("increment");
    let backend = FakeBackend::new(
        "model-a",
        vec![Step::Say(verdict("revise")), Step::Say(verdict("pass"))],
    );
    let whole_case = format!("FIRST-ONLY-MARKER\n{}", "evidence line\n".repeat(7_000));
    let increment = "SECOND-ROUND-DELTA";

    let first = round(&chat, &backend, 1, &whole_case, increment).expect("first round");
    let second = round(&chat, &backend, 2, &whole_case, increment).expect("second round");

    assert!(!first.incremental && first.round == 1);
    assert!(first.packet.len() > 90_000, "first contact sends the whole case");
    assert!(second.incremental && second.round == 2);
    assert_eq!(second.reviewer_session_id, first.reviewer_session_id, "one thread");
    assert_eq!(second.packet, increment);
    assert!(second.packet.len() < 100 && !second.packet.contains("FIRST-ONLY-MARKER"));

    // What the model was actually sent the second time: the earlier case only as
    // history it already had, and this round's increment once.
    let requests = backend.requests();
    assert_eq!(requests.len(), 2);
    let mails = mail_texts(&requests[1]);
    assert_eq!(mails.len(), 2, "history plus this round: {} mails", mails.len());
    assert!(mails[0].contains("FIRST-ONLY-MARKER"));
    assert!(mails[1].ends_with(increment) && !mails[1].contains("FIRST-ONLY-MARKER"));
    assert!(mails[1].contains("review_request"), "{}", &mails[1][..120]);

    // One agent was started, and both requests are on the chat's record.
    let dir = chat.project.sessions_dir();
    let root = chat.agent.session_id();
    let spawned = read_events_for_session_in_dir(root, &dir, Some(&["agent.spawn"])).unwrap();
    assert_eq!(spawned.len(), 1, "{spawned:?}");
    let requested =
        read_events_for_session_in_dir(root, &dir, Some(&["agent.review.request"])).unwrap();
    let incremental_flags = requested
        .iter()
        .map(|event| event.payload["incremental"].as_bool().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(incremental_flags, vec![false, true]);
    assert_eq!(requested[1].payload["attempt"], json!(2));
    assert_eq!(requested[1].payload["turnId"], json!("turn-1"));
    assert_eq!(requested[1].payload["mailId"], json!(second.mail_id));
    assert_eq!(
        chat.agent
            .control()
            .list_all(root)
            .unwrap()
            .iter()
            .filter(|agent| agent.path.is_reserved())
            .count(),
        1
    );
    // The Reviewer's token use is reported for the controller to account.
    assert_eq!(second.usages.len(), 1);
    assert_eq!(second.usages[0].input_tokens, 100);
}

#[test]
fn a_changed_reviewer_starts_a_fresh_thread_and_closes_the_old_one() {
    let chat = chat("changed");
    let old = FakeBackend::new("openai|https://gateway/v1|model-a", vec![Step::Say(verdict("pass"))]);
    let new = FakeBackend::new("openai|https://gateway/v1|model-b", vec![Step::Say(verdict("pass"))]);

    let first = round(&chat, &old, 1, "FULL", "INCREMENT").expect("first");
    let second = round(&chat, &new, 2, "FULL", "INCREMENT").expect("second");

    assert!(!second.incremental, "a thread started elsewhere is not carried on");
    assert_ne!(second.reviewer_session_id, first.reviewer_session_id);
    let control = chat.agent.control();
    assert_eq!(control.status(&first.reviewer_session_id), AgentStatus::Shutdown);
    let live = control
        .list_all(chat.agent.session_id())
        .unwrap()
        .into_iter()
        .filter(|agent| agent.path.is_reserved())
        .map(|agent| agent.session_id)
        .collect::<Vec<_>>();
    assert_eq!(live, vec![second.reviewer_session_id]);
}

#[test]
fn a_failed_round_is_reported_and_leaves_the_thread_usable() {
    let chat = chat("failure");
    let backend = FakeBackend::new(
        "model-a",
        vec![
            Step::Fail("the provider refused this request".to_string()),
            Step::Say(verdict("pass")),
        ],
    );

    let failed = round(&chat, &backend, 1, "FULL", "INCREMENT").unwrap_err();
    let ok = round(&chat, &backend, 1, "FULL", "INCREMENT").expect("the next try works");

    assert!(
        matches!(&failed, RoundError::Failed(message) if message.contains("refused this request")),
        "{failed:?}"
    );
    assert!(
        !ok.incremental && ok.round == 1,
        "a round that did not finish is not part of the thread's memory"
    );
    assert_eq!(
        chat.agent
            .control()
            .list_all(chat.agent.session_id())
            .unwrap()
            .iter()
            .filter(|agent| agent.path.is_reserved())
            .count(),
        1,
        "one thread throughout"
    );
}

#[test]
fn clearing_the_review_closes_the_thread_and_the_next_review_starts_over() {
    let chat = chat("cleared");
    let backend = FakeBackend::new("model-a", vec![Step::Say(verdict("pass")), Step::Say(verdict("pass"))]);
    let first = round(&chat, &backend, 1, "FULL", "INCREMENT").expect("first");

    reset_session(chat.agent.session_id());

    assert_eq!(
        chat.agent.control().status(&first.reviewer_session_id),
        AgentStatus::Shutdown
    );
    let second = round(&chat, &backend, 2, "FULL", "INCREMENT").expect("second");
    assert!(!second.incremental);
    assert_ne!(second.reviewer_session_id, first.reviewer_session_id);
}

#[test]
fn a_reviewer_the_registry_lost_track_of_does_not_block_the_chat() {
    let chat = chat("stray");
    // What a round that panicked leaves behind: an agent holding the name, and
    // nothing in the registry that knows about it.
    let stray = chat
        .agent
        .control()
        .spawn(SpawnRequest {
            parent_session_id: chat.agent.session_id().to_string(),
            name: REVIEWER_NAME.to_string(),
            role: REVIEWER_ROLE.to_string(),
            origin: SpawnOrigin::Controller,
            spawn_ref: None,
            parent_turn_id: None,
        })
        .unwrap();
    let backend = FakeBackend::new("model-a", vec![Step::Say(verdict("pass"))]);

    let output = round(&chat, &backend, 1, "FULL", "INCREMENT").expect("a round");

    assert_ne!(output.reviewer_session_id, stray.session_id);
    assert_eq!(chat.agent.control().status(&stray.session_id), AgentStatus::Shutdown);
}

#[test]
fn a_conversation_grown_too_large_is_replaced_before_the_next_round() {
    let chat = chat("grown");
    let backend = FakeBackend::new("model-a", vec![Step::Say(verdict("pass")), Step::Say(verdict("pass"))]);
    let first = round(&chat, &backend, 1, "FULL", "INCREMENT").expect("first");
    // The thread has read a great deal since.
    let root = chat.agent.session_id();
    {
        let mut residents = residents().lock().unwrap();
        let resident = residents.get_mut(root).expect("the chat's thread is kept");
        resident
            .session
            .messages
            .push(ConversationMessage::user_text("x".repeat(500_000)));
    }

    let second = round(&chat, &backend, 2, "FULL", "INCREMENT").expect("second");

    assert!(!second.incremental, "a fresh thread reads the whole case again");
    assert_ne!(second.reviewer_session_id, first.reviewer_session_id);
    assert_eq!(
        chat.agent.control().status(&first.reviewer_session_id),
        AgentStatus::Shutdown
    );
}

fn resident_for(agent: &TurnAgent) -> ResidentReviewer {
    let handle = agent
        .control()
        .spawn(SpawnRequest {
            parent_session_id: agent.session_id().to_string(),
            name: REVIEWER_NAME.to_string(),
            role: REVIEWER_ROLE.to_string(),
            origin: SpawnOrigin::Controller,
            spawn_ref: None,
            parent_turn_id: None,
        })
        .expect("a Reviewer");
    ResidentReviewer {
        agent: handle,
        control: agent.control().clone(),
        signature: "model".to_string(),
        session: Session::new(),
        rounds: 0,
        last_used: Instant::now(),
    }
}

#[test]
fn a_thread_whose_chat_was_closed_mid_round_is_not_kept() {
    let project = TempProject::new("closed-mid-round");
    let id = "chat-closed-mid-round";
    let _bound = bind_chat(&project, id);
    let agent = TurnAgent::register(&project.sessions_dir(), id, "turn-1", None).expect("a root");
    let resident = resident_for(&agent);
    let registry = Mutex::new(HashMap::new());

    // The chat is deleted while the Reviewer is still answering.
    agent.control().close(id, "session deleted").unwrap();
    store_into(&registry, 2, id, resident);

    assert!(registry.lock().unwrap().is_empty());
}

#[test]
fn a_full_registry_closes_the_least_recently_used_thread() {
    let project = TempProject::new("evict");
    let ids = ["chat-evict-a", "chat-evict-b", "chat-evict-c"];
    let _bound = ids.map(|id| bind_chat(&project, id));
    let agents = ids.map(|id| {
        TurnAgent::register(&project.sessions_dir(), id, "turn-1", None).expect("a root")
    });
    let registry = Mutex::new(HashMap::new());

    for (id, agent) in ids.iter().zip(&agents) {
        store_into(&registry, 2, id, resident_for(agent));
        std::thread::sleep(Duration::from_millis(5));
    }

    let kept = {
        let registry = registry.lock().unwrap();
        let mut kept = registry.keys().cloned().collect::<Vec<_>>();
        kept.sort();
        kept
    };
    assert_eq!(kept, vec!["chat-evict-b", "chat-evict-c"]);
    let reviewer_of = |agent: &TurnAgent| {
        agent
            .control()
            .list_all(agent.session_id())
            .unwrap()
            .into_iter()
            .find(|info| info.path.is_reserved())
    };
    assert!(reviewer_of(&agents[0]).is_none(), "the evicted chat's Reviewer was closed");
    assert!(reviewer_of(&agents[2]).is_some());

    // Renewing a chat that already has a thread never costs another chat its own.
    let renewed = registry.lock().unwrap().remove("chat-evict-b").unwrap();
    store_into(&registry, 2, "chat-evict-b", renewed);
    assert_eq!(registry.lock().unwrap().len(), 2);
    assert!(reviewer_of(&agents[2]).is_some());
}

// ---- Stop ----------------------------------------------------------------------------------

#[test]
fn stop_ends_a_review_in_flight_within_a_second_through_either_flag() {
    for (label, through_the_agent) in [("stop-agent", true), ("stop-turn", false)] {
        let mut chat = chat(label);
        let backend = Arc::new(FakeBackend::new("model-a", vec![Step::Hang]));
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker = {
            let backend = Arc::clone(&backend);
            let agent = chat.agent.clone();
            let cancelled = Arc::clone(&cancelled);
            let workspace = chat.workspace.clone();
            std::thread::spawn(move || {
                run_round(
                    &*backend,
                    &agent,
                    &cancelled,
                    &RoundRequest {
                        attempt: 1,
                        packets: Packets {
                            full: &|| "FULL".to_string(),
                            incremental: &|| "INCREMENT".to_string(),
                        },
                        workspace: &workspace,
                        provider: "test",
                        model: "reviewer-model",
                    },
                )
            })
        };
        wait_until("the model request to be in flight", || !backend.requests().is_empty());

        let stopped_at = Instant::now();
        if through_the_agent {
            // What the Stop button does: the chat's tree is told, not the turn.
            cancel_session_tree(chat.agent.session_id());
        } else {
            cancelled.store(true, Ordering::SeqCst);
        }
        let outcome = worker.join().expect("the round's thread");

        assert!(
            stopped_at.elapsed() < Duration::from_secs(1),
            "{label}: Stop took {:?}",
            stopped_at.elapsed()
        );
        assert!(matches!(outcome, Err(RoundError::Cancelled)), "{label}: {:?}", outcome.err());

        // The next turn's review is not poisoned by the Stop before it. The
        // stopped round never finished, so it left nothing in the thread.
        backend.push(vec![Step::Say(verdict("pass"))]);
        chat.agent=TurnAgent::register(&chat.project.sessions_dir(),chat.agent.session_id(),"turn-2",Some("project-1")).unwrap();
        let next = round(&chat, &backend, 2, "FULL", "INCREMENT").expect("the thread survives a Stop");
        assert!(!next.incremental && next.round == 1, "{label}");
        assert_eq!(
            chat.agent.control().status(&next.reviewer_session_id),
            AgentStatus::Completed(Some(verdict("pass")))
        );
    }
}

#[test]
fn a_review_asked_for_after_the_chat_was_stopped_never_starts() {
    let chat = chat("already-stopped");
    let backend = FakeBackend::new("model-a", vec![Step::Say(verdict("pass"))]);
    let cancelled = Arc::new(AtomicBool::new(true));

    let outcome = round_with(&chat, &backend, 1, "FULL", "INCREMENT", &cancelled);

    assert!(matches!(outcome, Err(RoundError::Cancelled)));
    assert!(backend.requests().is_empty(), "no model request was made");
    assert!(
        chat.agent
            .control()
            .list_all(chat.agent.session_id())
            .unwrap()
            .iter()
            .all(|agent| !agent.path.is_reserved()),
        "and no Reviewer was started for it"
    );
}

#[test]
fn deleting_the_chat_takes_its_reviewer_thread_with_it() {
    let chat = chat("deleted");
    let backend = FakeBackend::new("model-a", vec![Step::Say(verdict("pass"))]);
    let output = round(&chat, &backend, 1, "FULL", "INCREMENT").expect("a round");
    let log = crate::agent_threads::agents_dir(&chat.project.sessions_dir())
        .join(format!("{}.events.jsonl", output.reviewer_session_id));
    assert!(log.is_file(), "the thread has a log of its own");

    forget_session(chat.agent.session_id());

    assert_eq!(
        chat.agent.control().status(&output.reviewer_session_id),
        AgentStatus::Shutdown
    );
    assert!(!log.exists());
    assert!(!residents().lock().unwrap().contains_key(chat.agent.session_id()));
}

// ---- looking at the project ----------------------------------------------------------------

#[test]
fn the_reviewer_checks_the_project_with_its_own_tools_and_the_controller_keeps_the_record() {
    let chat = chat("tools");
    let backend = FakeBackend::new(
        "model-a",
        vec![
            Step::Tool(TOOL_READ, r#"{"path":"notes.md"}"#.to_string()),
            Step::Tool(TOOL_GREP, r#"{"pattern":"answer","glob":"*.rs"}"#.to_string()),
            Step::Tool(TOOL_READ, r#"{"path":"../outside.txt"}"#.to_string()),
            Step::Say(verdict("pass")),
        ],
    );

    let output = round(&chat, &backend, 1, "FULL", "INCREMENT").expect("a round");

    let calls = output
        .tool_calls
        .iter()
        .map(|call| (call.label.as_str(), call.ok))
        .collect::<Vec<_>>();
    assert_eq!(
        calls,
        vec![
            ("read_file notes.md", true),
            ("grep_search \"answer\"", true),
            ("read_file ../outside.txt", false),
        ],
        "recorded by the controller as the calls happened"
    );
    assert_eq!(backend.tools_offered(), vec![REVIEWER_TOOLS.map(String::from).to_vec()]);
    let requests = backend.requests();
    assert_eq!(requests.len(), 4, "three tool steps and the verdict");
    let results = requests
        .last()
        .unwrap()
        .iter()
        .flat_map(|message| &message.blocks)
        .filter_map(|block| match block {
            ContentBlock::ToolResult { output, is_error, .. } => Some((output.clone(), *is_error)),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert!(results[0].0.contains("FILE notes.md lines 1-3 of 3") && !results[0].1);
    assert!(results[0].0.contains("     2| second line"));
    assert!(results[1].0.contains("src/lib.rs:1| pub fn answer"));
    assert!(results[1].0.contains("src/deep/mod.rs:1| // the answer lives here"));
    assert!(!results[1].0.contains("node_modules"));
    assert!(results[2].1, "an attempt to leave the workspace is an error the model sees");
    assert!(results[2].0.contains("outside the project workspace"), "{}", results[2].0);
    // When the wire trace is on, it has one row per call.
    if crate::chat_events::chat_wire_log_exists(chat.agent.session_id()) {
        let wire = fs::read_to_string(
            crate::chat_events::chat_wire_log_path(chat.agent.session_id()).unwrap(),
        )
        .unwrap();
        assert_eq!(wire.matches("\"reviewer.tool\"").count(), 3, "{wire}");
    }
}

// ---- the tools themselves ------------------------------------------------------------------

fn tools_in(project: &TempProject) -> ReviewerTools {
    let workspace = project.root.join("workspace");
    write_workspace(&workspace);
    let cancel = ReviewCancel::new(Arc::new(AtomicBool::new(false)), Arc::new(AtomicBool::new(false)));
    ReviewerTools::new(&workspace, cancel, ToolLog::default()).expect("tools")
}

fn run(tools: &mut ReviewerTools, name: &str, input: Value) -> Result<String, String> {
    tools
        .execute(name, &input.to_string())
        .map_err(|error| error.to_string())
}

#[test]
fn reading_numbers_the_lines_and_can_continue_where_it_stopped() {
    let project = TempProject::new("read");
    let mut tools = tools_in(&project);

    let whole = run(&mut tools, TOOL_READ, json!({"path": "notes.md"})).unwrap();
    assert_eq!(
        whole,
        "FILE notes.md lines 1-3 of 3\n     1| # Notes\n     2| second line\n     3| third line\n"
    );
    let part = run(&mut tools, TOOL_READ, json!({"path": "notes.md", "offset": 2, "limit": 1})).unwrap();
    assert!(part.starts_with("FILE notes.md lines 2-2 of 3\n     2| second line\n"), "{part}");
    assert!(part.contains("read again with offset 3"), "{part}");
    let past = run(&mut tools, TOOL_READ, json!({"path": "notes.md", "offset": 9})).unwrap_err();
    assert!(past.contains("only 3 lines"), "{past}");
    // A path may be given absolutely, as long as it is inside the project.
    let absolute = project.root.join("workspace").join("notes.md");
    assert!(run(&mut tools, TOOL_READ, json!({"path": absolute.to_string_lossy()})).is_ok());
}

#[test]
fn reading_refuses_what_is_outside_secret_binary_or_huge_and_redacts_the_rest() {
    let project = TempProject::new("refuse");
    let mut tools = tools_in(&project);
    let outside = project.root.join("outside.txt");

    for (path, expected) in [
        ("../outside.txt", "outside the project workspace"),
        (outside.to_str().unwrap(), "outside the project workspace"),
        (".env", "credentials"),
        ("config/secrets.txt", "credentials"),
        ("figure.png", "not a text or source file"),
        ("big.log", "larger than"),
        ("src", "is not a file"),
        ("missing.rs", "does not exist"),
        ("", "empty"),
    ] {
        let error = run(&mut tools, TOOL_READ, json!({ "path": path })).unwrap_err();
        assert!(error.contains(expected), "{path}: {error}");
    }
    let invalid = tools.execute(TOOL_READ, "not json").unwrap_err().to_string();
    assert!(invalid.contains("invalid tool input"), "{invalid}");

    // A file that may be read still loses the lines that mention credentials.
    let keys = run(&mut tools, TOOL_READ, json!({"path": "keys.md"})).unwrap();
    assert!(keys.contains("[redacted sensitive evidence line]"), "{keys}");
    assert!(!keys.contains("sk-live-123"));
    assert!(keys.contains("visible line"));
}

#[test]
fn a_link_cannot_lead_out_of_the_workspace() {
    let project = TempProject::new("link");
    let mut tools = tools_in(&project);
    let outside = project.root.join("outside.txt");
    let link = project.root.join("workspace").join("link.txt");
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(&outside, &link);
    #[cfg(not(windows))]
    let linked = std::os::unix::fs::symlink(&outside, &link);
    if linked.is_err() {
        // Creating a link needs a privilege some machines do not give a test.
        return;
    }

    let error = run(&mut tools, TOOL_READ, json!({"path": "link.txt"})).unwrap_err();
    assert!(error.contains("outside the project workspace"), "{error}");
    let listed = run(&mut tools, TOOL_GLOB, json!({"pattern": "*.txt"})).unwrap();
    assert!(!listed.contains("link.txt"), "a link is not a file of the project: {listed}");
}

#[test]
fn searching_finds_lines_in_readable_files_only() {
    let project = TempProject::new("grep");
    let mut tools = tools_in(&project);

    let found = run(&mut tools, TOOL_GREP, json!({"pattern": "answer"})).unwrap();
    assert!(found.contains("src/lib.rs:1| pub fn answer() -> u32 { 42 }"), "{found}");
    assert!(found.contains("src/lib.rs:2| // TODO: tighten the answer"));
    assert!(found.contains("src/deep/mod.rs:1| // the answer lives here"));
    assert!(!found.contains("node_modules"), "vendored code is skipped: {found}");

    let markdown_only = run(&mut tools, TOOL_GREP, json!({"pattern": "line", "glob": "*.md"})).unwrap();
    assert!(markdown_only.contains("notes.md:2| second line"), "{markdown_only}");
    assert!(markdown_only.contains("keys.md:2| visible line"));
    assert!(!markdown_only.contains(".rs"));

    // A match inside a secret is reported without the secret.
    let secret = run(&mut tools, TOOL_GREP, json!({"pattern": "sk-live"})).unwrap();
    assert!(secret.contains("keys.md:1| [redacted sensitive evidence line]"), "{secret}");
    assert!(!secret.contains("sk-live-123"));
    // And a secret file is never searched at all.
    let hunter = run(&mut tools, TOOL_GREP, json!({"pattern": "hunter2"})).unwrap();
    assert!(hunter.starts_with("No matches"), "{hunter}");

    let one_file = run(&mut tools, TOOL_GREP, json!({"pattern": "answer", "path": "src/lib.rs"})).unwrap();
    assert!(one_file.starts_with("2 matching lines in 1 files"), "{one_file}");
    let limited = run(
        &mut tools,
        TOOL_GREP,
        json!({"pattern": "answer", "head_limit": 1, "case_insensitive": true}),
    )
    .unwrap();
    assert!(limited.starts_with("1 matching lines"), "{limited}");
    assert!(limited.contains("[stopped early"));
    // Naming a file that may not be searched says so, rather than finding nothing.
    for (path, expected) in [(".env", "credentials"), ("figure.png", "not a text or source file"), ("big.log", "larger than")] {
        let refused = run(&mut tools, TOOL_GREP, json!({"pattern": "x", "path": path})).unwrap_err();
        assert!(refused.contains(expected), "{path}: {refused}");
    }
    let invalid = run(&mut tools, TOOL_GREP, json!({"pattern": "("})).unwrap_err();
    assert!(invalid.contains("invalid pattern"), "{invalid}");
    let outside = run(&mut tools, TOOL_GREP, json!({"pattern": "x", "path": ".."})).unwrap_err();
    assert!(outside.contains("outside the project workspace"), "{outside}");
}

#[test]
fn listing_shows_what_exists_and_hides_what_looks_secret() {
    let project = TempProject::new("glob");
    let mut tools = tools_in(&project);

    let rust = run(&mut tools, TOOL_GLOB, json!({"pattern": "**/*.rs"})).unwrap();
    assert!(rust.starts_with("2 files\n"), "{rust}");
    assert!(rust.contains("src/lib.rs") && rust.contains("src/deep/mod.rs"));
    let markdown = run(&mut tools, TOOL_GLOB, json!({"pattern": "*.md"})).unwrap();
    assert!(markdown.contains("notes.md") && markdown.contains("keys.md"), "{markdown}");
    let under_src = run(&mut tools, TOOL_GLOB, json!({"pattern": "mod.rs", "path": "src"})).unwrap();
    assert!(under_src.contains("src/deep/mod.rs"), "{under_src}");
    // That a figure exists is often what a claim rests on, though it cannot be read.
    let figure = run(&mut tools, TOOL_GLOB, json!({"pattern": "*.png"})).unwrap();
    assert!(figure.contains("figure.png (exists; not a text file the Reviewer can read)"), "{figure}");
    // A name that says it holds credentials is not even listed.
    let secrets = run(&mut tools, TOOL_GLOB, json!({"pattern": "*.txt"})).unwrap();
    assert_eq!(secrets, "No files match.");
    let dotenv = run(&mut tools, TOOL_GLOB, json!({"pattern": ".env*"})).unwrap();
    assert_eq!(dotenv, "No files match.");
    let not_a_directory = run(&mut tools, TOOL_GLOB, json!({"pattern": "*", "path": "notes.md"})).unwrap_err();
    assert!(not_a_directory.contains("not a directory"), "{not_a_directory}");
}

#[test]
fn every_call_is_recorded_and_a_stopped_round_interrupts_the_tool() {
    let project = TempProject::new("log");
    let workspace = project.root.join("workspace");
    write_workspace(&workspace);
    let turn = Arc::new(AtomicBool::new(false));
    let cancel = ReviewCancel::new(Arc::clone(&turn), Arc::new(AtomicBool::new(false)));
    let log = ToolLog::default();
    let mut tools = ReviewerTools::new(&workspace, cancel, Arc::clone(&log)).expect("tools");

    run(&mut tools, TOOL_READ, json!({"path": "notes.md"})).unwrap();
    run(&mut tools, TOOL_READ, json!({"path": ".env"})).unwrap_err();
    assert_eq!(
        log.lock().unwrap().iter().map(|call| (call.label.clone(), call.ok)).collect::<Vec<_>>(),
        vec![
            ("read_file notes.md".to_string(), true),
            ("read_file .env".to_string(), false)
        ]
    );
    assert!(log.lock().unwrap()[0].output_chars > 20);

    assert!(!tools.is_cancelled());
    turn.store(true, Ordering::SeqCst);
    assert!(tools.is_cancelled());
    let error = tools
        .execute(TOOL_GREP, r#"{"pattern":"answer"}"#)
        .unwrap_err();
    assert!(error.is_interrupted(), "the runtime must see a Stop, not a failed search");
}

#[test]
fn globs_mean_what_a_model_writing_them_means() {
    let matches = |glob: &str, relative: &str| {
        let matcher = GlobMatcher::new(glob).unwrap();
        let base = Path::new("base");
        matcher.matches_file(&base.join(relative), base)
    };
    // No slash: a file name at any depth.
    assert!(matches("*.rs", "lib.rs") && matches("*.rs", "src/deep/lib.rs"));
    assert!(!matches("*.rs", "lib.rs.bak"));
    // With a slash: a path below the search directory.
    assert!(matches("src/*.rs", "src/lib.rs") && !matches("src/*.rs", "src/deep/lib.rs"));
    assert!(matches("**/*.rs", "lib.rs") && matches("**/*.rs", "a/b/c.rs"));
    assert!(matches("src/**", "src/a/b.txt"));
    assert!(matches("*.{md,txt}", "a.md") && matches("*.{md,txt}", "dir/b.txt") && !matches("*.{md,txt}", "c.rs"));
    assert!(matches("fig?.png", "fig1.png") && !matches("fig?.png", "fig10.png"));
    assert!(matches("[ab]c.rs", "ac.rs") && !matches("[ab]c.rs", "cc.rs"));
    assert!(matches("[!a]c.rs", "bc.rs") && !matches("[!a]c.rs", "ac.rs"));
    assert!(matches("a.b+c", "a.b+c"), "regex characters are literal");
    assert!(GlobMatcher::new("{unclosed").is_err());
}
