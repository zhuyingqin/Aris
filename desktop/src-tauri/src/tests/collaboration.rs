use super::*;
use runtime::agent_control::AgentStatus;
use runtime::ConversationRuntime;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpListener;

struct Gateway {
    url: String,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<Value>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Gateway {
    fn new(file: PathBuf) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop_worker = stop.clone();
        let captured = requests.clone();
        let worker = std::thread::spawn(move || {
            let mut handlers = Vec::new();
            while !stop_worker.load(Ordering::SeqCst) {
                let Ok((mut socket, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                };
                let captured = captured.clone();
                let file = file.clone();
                handlers.push(std::thread::spawn(move || {
                    // Winsock hands out accepted sockets in the listener's
                    // non-blocking mode; an early read would then see
                    // WouldBlock, take it for a closed peer and drop the request.
                    socket.set_nonblocking(false).unwrap();
                    socket.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
                    let mut bytes=Vec::new(); let mut buffer=[0;4096];
                    let header_end=loop { let count=socket.read(&mut buffer).unwrap_or(0); if count==0{return;} bytes.extend_from_slice(&buffer[..count]); if let Some(i)=bytes.windows(4).position(|w|w==b"\r\n\r\n"){break i+4;} };
                    let header=String::from_utf8_lossy(&bytes[..header_end]);
                    let length:usize=header.lines().find_map(|line|line.split_once(':').filter(|(k,_)|k.eq_ignore_ascii_case("content-length")).and_then(|(_,v)|v.trim().parse().ok())).unwrap();
                    while bytes.len()<header_end+length {let n=socket.read(&mut buffer).unwrap_or(0);if n==0{return;}bytes.extend_from_slice(&buffer[..n]);}
                    let request:Value=serde_json::from_slice(&bytes[header_end..header_end+length]).unwrap();
                    captured.lock().unwrap().push(request.clone());
                    if request.to_string().contains("fail_request") {
                        let body = r#"{"error":{"message":"simulated isolated child failure"}}"#;
                        let _ = write!(socket, "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                        return;
                    }
                    let messages=request["messages"].as_array().unwrap();
                    let tool_done=messages.iter().any(|m|m["role"]=="tool");
                    let delta=if tool_done {
                        json!({"content":"Device-local validation only. Evidence: recovery.txt; cross-device data is missing."})
                    } else {
                        // Keep both children in flight long enough to deliver an amendment.
                        std::thread::sleep(Duration::from_millis(250));
                        json!({"tool_calls":[{"index":0,"id":"read-evidence","type":"function","function":{"name":"read_file","arguments":json!({"path":file.display().to_string()}).to_string()}}]})
                    };
                    let finish=if tool_done {"stop"}else{"tool_calls"};
                    let data=format!("data: {}\n\ndata: {}\n\ndata: [DONE]\n\n",json!({"id":"mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":delta,"finish_reason":null}]}),json!({"id":"mock","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":finish}],"usage":{"prompt_tokens":30,"completion_tokens":20}}));
                    let reply=format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}",data.len());
                    let _=socket.write_all(reply.as_bytes());
                }));
            }
            for handler in handlers {
                let _ = handler.join();
            }
        });
        Self {
            url,
            stop,
            requests,
            worker: Some(worker),
        }
    }
}
impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct Fixture {
    host: Arc<Host>,
    gateway: Gateway,
    _bound: crate::chat_events::SessionEventDirGuard,
    dir: tempfile::TempDir,
}
impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("recovery.txt");
        fs::write(&file, "Only device-local observations are available.").unwrap();
        let gateway = Gateway::new(file);
        let sessions = dir.path().join("sessions");
        let control = crate::agent_threads::control_for(&sessions).unwrap();
        let parent = format!("chat-{:x}", rand::random::<u64>());
        let bound = crate::chat_events::bind_session_event_dir(&parent, sessions.clone()).unwrap();
        control
            .register_root(&parent, Some("project-frozen"))
            .unwrap();
        control.begin_turn(&parent, "parent-turn").unwrap();
        let available = aris_chat::chat_tool_specs(tools::mvp_tool_specs());
        let host = Arc::new(Host {
            app: None,
            control,
            parent: parent.clone(),
            parent_turn: "parent-turn".into(),
            parent_cancel: Arc::new(AtomicBool::new(false)),
            sessions_dir: sessions,
            context: runtime::ProjectExecutionContext::new(dir.path()),
            config: aris_chat::ChatExecutorConfig::OpenAiCompatible {
                api_key: "mock-only".into(),
                base_url: gateway.url.clone(),
                send_routing_session_header: false,
                transport: aris_executor::OpenAiTransport::Auto,
                known_models: vec!["mock-executor".into()],
            },
            model: "mock-executor".into(),
            permission: PermissionMode::WorkspaceWrite,
            features: runtime::RuntimeFeatureConfig::default(),
            tool_specs: available
                .into_iter()
                .filter(|s| {
                    (CHILD_TOOLS.contains(&s.name.as_str()) || s.name == "send_message")
                        && s.required_permission == PermissionMode::ReadOnly
                })
                .collect(),
        });
        hosts().lock().unwrap().insert(parent, host.clone());
        Self {
            dir,
            host,
            gateway,
            _bound: bound,
        }
    }
    fn call(&self, name: &str, value: Value) -> Result<Value, String> {
        serde_json::from_str(&execute(
            &self.host.parent,
            "parent-turn",
            "tool-parent",
            name,
            &value.to_string(),
        )?)
        .map_err(|e| e.to_string())
    }
    fn contract(name: &str) -> Value {
        json!({"name":name,"task":format!("Inspect {name} recovery"),"reason":"parallel independent context inspection","inputs":"recovery.txt in current project","deliverable":"findings, evidence and gaps","stop_condition":"report available evidence and stop","role":"read_only","prerequisites_ready":true,"max_iterations":4,"max_seconds":30})
    }
    fn settled(&self, count: usize) {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let infos = self.host.control.task_infos(&self.host.parent);
            if infos.len() == count
                && infos.iter().all(|i| {
                    matches!(
                        i.status,
                        AgentStatus::Completed(_)
                            | AgentStatus::Errored(_)
                            | AgentStatus::Interrupted
                    )
                })
            {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "children did not settle: {infos:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.host.parent_cancel.store(true, Ordering::SeqCst);
        self.host.control.cancel_subtree(&self.host.parent);
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until
            && self
                .host
                .control
                .task_infos(&self.host.parent)
                .iter()
                .any(|i| runs().lock().unwrap().contains(&i.session_id))
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        hosts().lock().unwrap().remove(&self.host.parent);
        crate::review_thread::discard_session(&self.host.parent);
        crate::agent_threads::evict_control(&self.host.sessions_dir);
    }
}

#[test]
fn simulated_two_children_amendment_mail_results_and_followup_use_the_shared_executor() {
    let f = Fixture::new();
    let first = f.call("spawn_agent", Fixture::contract("backend")).unwrap();
    f.call("Agent", Fixture::contract("frontend")).unwrap();
    assert_eq!(
        runs()
            .lock()
            .unwrap()
            .iter()
            .filter(|id| f.host.control.info(id).is_some())
            .count(),
        2
    );
    f.call(
        "send_message",
        json!({"target":"backend","message":"Additional condition: device-local only"}),
    )
    .unwrap();
    let wait = f.call("wait_agent", json!({"timeout_ms":10000})).unwrap();
    assert_eq!(wait["notification"], "mail");
    f.settled(2);
    let infos = f.host.control.task_infos(&f.host.parent);
    assert!(
        infos
            .iter()
            .all(|i| matches!(i.status, AgentStatus::Completed(_))),
        "{infos:?}"
    );
    assert!(infos
        .iter()
        .all(|i| i.project_id.as_deref() == Some("project-frozen")
            && i.task.as_ref().unwrap().model == "mock-executor"));
    assert_eq!(f.host.control.take_mail(&f.host.parent).len(), 2);
    let backend = first["sessionId"].as_str().unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while runs().lock().unwrap().contains(backend) {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
    f.call(
        "send_message",
        json!({"target":"backend","message":"Idle message must not wake the child"}),
    )
    .unwrap();
    let before = f.gateway.requests.lock().unwrap().len();
    assert!(!runs().lock().unwrap().contains(backend));
    f.call("followup_task",json!({"target":"backend","message":"Follow-up: identify the missing cross-device evidence"})).unwrap();
    f.call("wait_agent", json!({"timeout_ms":10000})).unwrap();
    f.settled(2);
    assert!(f.gateway.requests.lock().unwrap().len() > before);
    assert_eq!(
        f.host
            .control
            .resolve(&f.host.parent, "backend")
            .unwrap()
            .session_id,
        backend
    );
    let requests = f.gateway.requests.lock().unwrap();
    assert!(requests.iter().any(|r| r
        .to_string()
        .contains("Additional condition: device-local only")));
    assert!(requests
        .iter()
        .any(|r| r.to_string().contains("Follow-up: identify")));
    assert!(requests.iter().all(|r| r["model"] == "mock-executor"));
    assert!(requests.iter().all(
        |r| r["tools"].as_array().unwrap().iter().all(|t| CHILD_TOOLS
            .contains(&t["function"]["name"].as_str().unwrap())
            || t["function"]["name"] == "send_message")
    ));
    assert!(f.dir.path().join("sessions/agents").exists());
}

struct ParentScript {
    responses: VecDeque<Vec<runtime::AssistantEvent>>,
    requests: Arc<Mutex<Vec<Vec<ConversationMessage>>>>,
}
impl runtime::ApiClient for ParentScript {
    fn stream(
        &mut self,
        request: runtime::ApiRequest,
    ) -> Result<Vec<runtime::AssistantEvent>, RuntimeError> {
        self.requests.lock().unwrap().push(request.messages);
        self.responses
            .pop_front()
            .ok_or_else(|| RuntimeError::new("script exhausted"))
    }
}
fn call(id: &str, name: &str, input: Value) -> runtime::AssistantEvent {
    runtime::AssistantEvent::ToolUse {
        id: id.into(),
        name: name.into(),
        input: input.to_string(),
    }
}
fn scripted_parent(
    f: &Fixture,
    responses: Vec<Vec<runtime::AssistantEvent>>,
) -> (
    ConversationRuntime<ParentScript, KernelToolExecutor>,
    Arc<Mutex<Vec<Vec<ConversationMessage>>>>,
) {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let tools = aris_chat::chat_tool_specs(tools::collaboration::tool_specs());
    let runtime = ConversationRuntime::new(
        Session::new(),
        ParentScript {
            responses: responses.into(),
            requests: requests.clone(),
        },
        KernelToolExecutor {
            session_id: f.host.parent.clone(),
            turn_id: f.host.parent_turn.clone(),
            extra_blocked_tools: &[],
            cancelled: Some(f.host.parent_cancel.clone()),
            progress_sink: None,
            max_output_tokens: Some(8000),
            project_execution_context: f.host.context.clone(),
        },
        aris_chat::permission_policy_for_tools(tools, f.host.permission),
        vec![tools::collaboration::DELEGATION_POLICY.into()],
    )
    .without_retrieval_guard()
    .with_event_sink(Box::new(
        f.host
            .control
            .lifecycle_sink(&f.host.parent, Some(&f.host.parent_turn)),
    ))
    .with_turn_input_source(Box::new(
        f.host
            .control
            .turn_input_source(&f.host.parent, Some(&f.host.parent_turn)),
    ));
    (runtime, requests)
}

#[test]
fn simulated_simple_function_explanation_does_not_create_tasks() {
    let f = Fixture::new();
    let (mut parent, _) = scripted_parent(
        &f,
        vec![vec![
            runtime::AssistantEvent::TextDelta("This function returns 42.".into()),
            runtime::AssistantEvent::MessageStop,
        ]],
    );
    parent
        .run_turn("Explain fn answer() -> u32 { 42 }", None)
        .unwrap();
    assert!(f.host.control.task_infos(&f.host.parent).is_empty());
    assert!(f.gateway.requests.lock().unwrap().is_empty());
}

#[test]
fn simulated_model_tools_deliver_results_to_parent_then_independent_reviewer_checks_the_evidence() {
    use crate::review_thread::tests::{verdict, FakeBackend, Step};
    use crate::review_thread::{run_round, Packets, RoundRequest};
    let f = Fixture::new();
    let (mut parent,requests) = scripted_parent(&f,vec![
        vec![call("spawn-backend","spawn_agent",Fixture::contract("backend")),call("spawn-frontend","spawn_agent",Fixture::contract("frontend")),runtime::AssistantEvent::MessageStop],
        vec![call("amend","send_message",json!({"target":"backend","message":"Additional condition: device-local only"})),runtime::AssistantEvent::MessageStop],
        vec![call("wait-1","wait_agent",json!({"timeout_ms":10000})),runtime::AssistantEvent::MessageStop],
        vec![call("wait-2","wait_agent",json!({"timeout_ms":1000})),runtime::AssistantEvent::MessageStop],
        vec![call("followup","followup_task",json!({"target":"backend","message":"Follow-up: explain why cross-device generalization is unsupported"})),runtime::AssistantEvent::MessageStop],
        vec![call("wait-3","wait_agent",json!({"timeout_ms":10000})),runtime::AssistantEvent::MessageStop],
        vec![runtime::AssistantEvent::TextDelta("Adopted the child findings: device-local validation only. Missing cross-device data prevents a generalization claim; that claim is removed.".into()),runtime::AssistantEvent::MessageStop],
    ]);
    let summary = runtime::with_project_execution_context(&f.host.context, || {
        parent.run_turn(
            "Check backend recovery and frontend synchronization in parallel",
            None,
        )
    })
    .unwrap();
    f.settled(2);
    let saved = parent.session();
    let mail_count=saved.messages.iter().flat_map(|m|&m.blocks).filter(|b|matches!(b,ContentBlock::Text{text} if text.starts_with("[Inter-agent message") && text.contains("(result, id "))).count();
    assert_eq!(
        mail_count, 3,
        "two results and one follow-up delivered once"
    );
    assert_eq!(f.host.control.pending_mail(&f.host.parent), 0);
    assert!(requests.lock().unwrap().last().unwrap().iter().any(|m|m.blocks.iter().any(|b|matches!(b,ContentBlock::Text{text} if text.contains("cross-device data is missing")))));
    let agent = crate::agent_threads::TurnAgent::register(
        &f.host.sessions_dir,
        &f.host.parent,
        &f.host.parent_turn,
        Some("project-frozen"),
    )
    .unwrap();
    let evidence = review_evidence(&agent, &f.host.sessions_dir);
    assert!(
        evidence.contains("read_file")
            && evidence.contains("recovery.txt")
            && evidence.contains("cross-device data is missing")
    );
    let answer = runtime::assistant_text_from_turn_summary(&summary);
    let packet=format!("Verify the scoped answer independently. Child checks cannot replace your review.\nAnswer: {answer}\n{evidence}");
    let reviewer = FakeBackend::new(
        "independent-model",
        vec![
            Step::Tool("read_file", json!({"path":"recovery.txt"}).to_string()),
            Step::Say(verdict("pass")),
        ],
    );
    let output = run_round(
        &reviewer,
        &agent,
        &f.host.parent_cancel,
        &RoundRequest {
            attempt: 1,
            packets: Packets {
                full: &|| packet.clone(),
                incremental: &|| packet.clone(),
            },
            workspace: f.dir.path(),
            provider: "independent-test",
            model: "independent-reviewer",
        },
    )
    .unwrap();
    assert_eq!(
        parse_independent_review(&output.text).unwrap().verdict,
        IndependentReviewVerdict::Pass
    );
    assert_eq!(output.tool_calls.len(), 1);
    assert!(reviewer.tools_offered().iter().all(|offered| offered
        .iter()
        .all(|name| crate::review_thread::REVIEWER_TOOLS.contains(&name.as_str()))));
    assert!(f
        .host
        .control
        .resolve(&f.host.parent, "/root/~reviewer")
        .is_err());
    assert_eq!(
        f.host.control.pending_mail(&f.host.parent),
        0,
        "Reviewer verdict never reaches the Executor mailbox"
    );
}

#[test]
fn simulated_child_failure_is_mailed_without_breaking_its_sibling_or_parent() {
    let f = Fixture::new();
    f.call("spawn_agent", Fixture::contract("fail_request"))
        .unwrap();
    f.call("spawn_agent", Fixture::contract("frontend"))
        .unwrap();
    f.settled(2);
    let items = f.host.control.task_infos(&f.host.parent);
    assert!(items
        .iter()
        .any(|i| matches!(i.status, AgentStatus::Errored(_))));
    assert!(items
        .iter()
        .any(|i| matches!(i.status, AgentStatus::Completed(_))));
    let (mut parent, _) = scripted_parent(
        &f,
        vec![vec![
            runtime::AssistantEvent::TextDelta(
                "The failed investigation leaves a gap; the sibling's evidence remains usable."
                    .into(),
            ),
            runtime::AssistantEvent::MessageStop,
        ]],
    );
    parent
        .run_turn("Report the evidence and the failure", None)
        .unwrap();
    assert!(matches!(
        f.host.control.status(&f.host.parent),
        AgentStatus::Completed(_)
    ));
    assert_eq!(f.host.control.pending_mail(&f.host.parent), 0);
}

#[test]
fn simulated_stop_one_child_preserves_other_results_and_stale_parent_cannot_delegate() {
    let f = Fixture::new();
    let first = f.call("spawn_agent", Fixture::contract("backend")).unwrap();
    f.call("spawn_agent", Fixture::contract("frontend"))
        .unwrap();
    f.call(
        "send_message",
        json!({"target":"frontend","message":"Cross-device data is unavailable"}),
    )
    .unwrap();
    f.call("interrupt_agent", json!({"target":"backend"}))
        .unwrap();
    f.settled(2);
    assert_eq!(
        f.host.control.status(first["sessionId"].as_str().unwrap()),
        AgentStatus::Interrupted
    );
    let mail = f.host.control.take_mail(&f.host.parent);
    assert_eq!(mail.len(), 1);
    assert!(mail[0].content.contains("cross-device data is missing"));
    f.host.parent_cancel.store(true, Ordering::SeqCst);
    f.host.control.cancel_subtree(&f.host.parent);
    assert!(f
        .call(
            "followup_task",
            json!({"target":"backend","message":"stale task"})
        )
        .unwrap_err()
        .contains("stale or stopped"));
}

#[test]
fn prerequisites_roles_capacity_and_child_tool_permissions_are_runtime_constraints() {
    let f = Fixture::new();
    let mut contract = Fixture::contract("backend");
    contract["prerequisites_ready"] = json!(false);
    assert!(f.call("spawn_agent", contract.clone()).is_err());
    contract["prerequisites_ready"] = json!(true);
    contract["role"] = json!("writer");
    assert!(f.call("spawn_agent", contract).is_err());
    f.call("spawn_agent", Fixture::contract("backend")).unwrap();
    f.call("spawn_agent", Fixture::contract("frontend"))
        .unwrap();
    assert!(f
        .call("spawn_agent", Fixture::contract("third"))
        .unwrap_err()
        .contains("at most 2"));
    let handle = f.host.control.resolve(&f.host.parent, "backend").unwrap();
    assert!(f
        .host
        .control
        .spawn(SpawnRequest {
            parent_session_id: handle.session_id,
            name: "grandchild".into(),
            role: "read_only".into(),
            origin: SpawnOrigin::Model,
            spawn_ref: None,
            parent_turn_id: None
        })
        .unwrap_err()
        .to_string()
        .contains("at most 1"));
    let mut tools = ChildTools {
        control: f.host.control.clone(),
        parent: f.host.parent.clone(),
        inner: KernelToolExecutor {
            session_id: "child".into(),
            turn_id: "turn".into(),
            extra_blocked_tools: &[],
            cancelled: None,
            progress_sink: None,
            max_output_tokens: None,
            project_execution_context: f.host.context.clone(),
        },
        parent_cancel: Arc::new(AtomicBool::new(false)),
        deadline: Instant::now() + Duration::from_secs(10),
        allowed: CHILD_TOOLS.iter().map(|s| s.to_string()).collect(),
    };
    for name in [
        "write_file",
        "PowerShell",
        "Agent",
        "spawn_agent",
        "LlmReview",
        "SendEmail",
    ] {
        assert!(tools.execute(name, "{}").is_err());
    }
}

#[test]
fn failed_creation_is_a_failed_card_and_does_not_hold_capacity() {
    let f = Fixture::new();
    let handle = f
        .host
        .control
        .spawn(SpawnRequest {
            parent_session_id: f.host.parent.clone(),
            name: "failed".into(),
            role: "read_only".into(),
            origin: SpawnOrigin::Model,
            spawn_ref: None,
            parent_turn_id: None,
        })
        .unwrap();
    let mut task = Fixture::contract("failed");
    task["role"] = json!("read_only");
    f.host
        .control
        .set_task(
            &handle.session_id,
            AgentTask {
                reason: "test".into(),
                task: "test".into(),
                inputs: "x".into(),
                deliverable: "x".into(),
                stop_condition: "x".into(),
                model: "mock-executor".into(),
                connection: "mock".into(),
                permission: "read-only".into(),
                workspace: "test".into(),
                max_iterations: 1,
                max_seconds: 10,
            },
        )
        .unwrap();
    f.host
        .control
        .fail_creation(&handle.session_id, "thread creation failed");
    let cards = f.host.cards().unwrap();
    assert_eq!(cards[0]["status"]["state"], "errored");
    f.call("spawn_agent", Fixture::contract("backend")).unwrap();
    f.call("spawn_agent", Fixture::contract("frontend"))
        .unwrap();
}

#[test]
fn failed_initializer_does_not_retry_and_explicit_followup_keeps_its_mail() {
    let f = Fixture::new();
    let child = f
        .host
        .control
        .spawn(SpawnRequest {
            parent_session_id: f.host.parent.clone(),
            name: "initialization".into(),
            role: "read_only".into(),
            origin: SpawnOrigin::Model,
            spawn_ref: Some("creation-tool".into()),
            parent_turn_id: Some(f.host.parent_turn.clone()),
        })
        .unwrap();
    f.host
        .control
        .set_task(
            &child.session_id,
            runtime::agent_control::AgentTask {
                reason: "check initialization recovery".into(),
                task: "inspect evidence".into(),
                inputs: "recovery.txt".into(),
                deliverable: "facts and gaps".into(),
                stop_condition: "after checking evidence".into(),
                model: f.host.model.clone(),
                connection: connection_label(&f.host.config),
                permission: "workspace-write intersect read-only".into(),
                workspace: f.dir.path().display().to_string(),
                max_iterations: 4,
                max_seconds: 30,
            },
        )
        .unwrap();
    let path = crate::agent_threads::agents_dir(&f.host.sessions_dir)
        .join(format!("{}.json", child.session_id));
    fs::write(&path, "invalid session checkpoint").unwrap();
    f.call(
        "followup_task",
        json!({"target":"initialization","message":"first explicit request"}),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while runs().lock().unwrap().contains(&child.session_id) {
        assert!(
            Instant::now() < deadline,
            "failed initializer kept restarting"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(matches!(
        f.host.control.status(&child.session_id),
        AgentStatus::Errored(_)
    ));
    assert!(!f.host.control.has_pending_trigger(&child.session_id));
    assert_eq!(
        f.host.control.pending_mail(&child.session_id),
        1,
        "input remains traceable"
    );
    Session::new().save_to_path(&path).unwrap();
    f.call(
        "followup_task",
        json!({"target":"initialization","message":"retry after checkpoint repair"}),
    )
    .unwrap();
    f.settled(1);
    assert!(matches!(
        f.host.control.status(&child.session_id),
        AgentStatus::Completed(_)
    ));
    let captured = f.gateway.requests.lock().unwrap();
    assert!(captured.iter().any(|request| {
        let text = request.to_string();
        text.contains("first explicit request") && text.contains("retry after checkpoint repair")
    }));
}

#[test]
fn detail_conversation_reuses_chat_tools_and_redacts_private_content() {
    use runtime::{ConversationMessage, MessageRole};
    let mut session = Session::new();
    session.messages = vec![
        ConversationMessage { role: MessageRole::System, blocks: vec![ContentBlock::Text { text: "private-system-prompt".into() }], usage: None },
        ConversationMessage { role: MessageRole::User, blocks: vec![ContentBlock::Text { text: "Check the checkpoint".into() }], usage: None },
        ConversationMessage { role: MessageRole::Assistant, blocks: vec![
            ContentBlock::Thinking { thinking: "private-reasoning".into(), signature: "private-signature".into() },
            ContentBlock::ToolUse { id: "read-checkpoint".into(), name: "read_file".into(), input: "{\"path\":\"checkpoint.rs\"}".into() },
        ], usage: None },
        ConversationMessage { role: MessageRole::Tool, blocks: vec![ContentBlock::ToolResult {
            tool_use_id: "read-checkpoint".into(), tool_name: "read_file".into(),
            output: "checkpoint is saved\napi_key=must-redact-this-secret".into(), is_error: false,
        }], usage: None },
    ];
    let turns = task_conversation(&session);
    assert_eq!(turns.len(), 2);
    assert_eq!(turns[0]["role"], "user");
    assert_eq!(turns[1]["role"], "assistant");
    assert_eq!(turns[1]["blocks"].as_array().unwrap().len(), 1);
    assert_eq!(turns[1]["blocks"][0]["name"], "read_file");
    assert_eq!(turns[1]["blocks"][0]["isError"], false);
    assert!(turns[1]["blocks"][0]["output"].as_str().unwrap().contains("checkpoint is saved"));
    assert!(turns.iter().all(|turn| turn["readOnly"] == true));
    let rendered = serde_json::to_string(&turns).unwrap();
    for secret in ["private-system-prompt", "private-reasoning", "private-signature", "must-redact-this-secret"] {
        assert!(!rendered.contains(secret), "exposed {secret}");
    }
    assert!(session.messages[2].blocks.iter().any(|block| matches!(block, ContentBlock::Thinking { .. })), "viewing must not change the canonical session");
}

#[test]
fn detail_timeline_uses_durable_execution_tool_mail_and_stop_events() {
    let f = Fixture::new();
    let first = f.call("spawn_agent", Fixture::contract("backend")).unwrap();
    f.settled(1);
    let directory = crate::agent_threads::agents_dir(&f.host.sessions_dir);
    let session = first["sessionId"].as_str().unwrap();
    crate::chat_events::record_event_in_dir(
        &directory,
        session,
        "agent.execution",
        json!({"model":"mock-executor","apiKey":"secret-must-not-reach-timeline"}),
    );
    let timeline = task_timeline(&directory, session).unwrap();
    for kind in [
        "agent.lineage",
        "agent.execution",
        "agent.turn.started",
        "agent.tool.started",
        "agent.tool.finished",
        "agent.mail.delivered",
        "agent.mail.sent",
        "agent.turn.finished",
    ] {
        assert!(
            timeline.iter().any(|event| event["kind"] == kind),
            "missing {kind}: {timeline:?}"
        );
    }
    assert!(timeline
        .windows(2)
        .all(|pair| pair[0]["seq"].as_u64() < pair[1]["seq"].as_u64()));
    assert!(!serde_json::to_string(&timeline)
        .unwrap()
        .contains("secret-must-not-reach-timeline"));
    let cards = f.host.cards().unwrap();
    assert_eq!(cards[0]["startedAt"], timeline.iter().find(|event| event["kind"] == "agent.turn.started").unwrap()["ts"]);
    assert_eq!(cards[0]["finishedAt"], timeline.iter().find(|event| event["kind"] == "agent.turn.finished").unwrap()["ts"]);
    let stopped = f
        .call("spawn_agent", Fixture::contract("frontend"))
        .unwrap();
    f.call("interrupt_agent", json!({"target":"frontend"}))
        .unwrap();
    let timeline = task_timeline(&directory, stopped["sessionId"].as_str().unwrap()).unwrap();
    assert!(timeline
        .iter()
        .any(|event| event["kind"] == "agent.interrupted"
            && event["reason"] == "stopped by user or parent"));
}

fn timing_card(events: &[(u64, &str, Option<&str>)], status: AgentStatus) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let sessions = dir.path().join("sessions");
    let agents = crate::agent_threads::agents_dir(&sessions);
    fs::create_dir_all(&agents).unwrap();
    let log = agents.join("agent-timing.events.jsonl");
    let raw = events.iter().enumerate().map(|(index, (ts, kind, turn))| {
        serde_json::to_string(&crate::chat_events::ChatEventLogEntry {
            version: 1, seq: index as u64 + 1, ts: *ts,
            session_id: "agent-timing".into(), kind: (*kind).into(), payload: json!({"turnId":turn}),
        }).unwrap() + "\n"
    }).collect::<String>();
    fs::write(&log, &raw).unwrap();
    let mut card = json!({});
    project_task_timing(&mut card, &sessions, "agent-timing", &status);
    assert_eq!(fs::read_to_string(log).unwrap(), raw, "viewing must not change execution evidence");
    card
}

#[test]
fn task_time_freezes_at_the_original_stop_and_does_not_grow_on_recovery() {
    let card = timing_card(&[
        (1000, "agent.turn.started", Some("turn-one")),
        (42000, "agent.interrupted", Some("turn-one")),
        (45000, "agent.turn.finished", Some("turn-one")),
        (900000, "agent.recovered", None),
    ], AgentStatus::Interrupted);
    assert_eq!(card["startedAt"], 1000);
    assert_eq!(card["finishedAt"], 42000);
}

#[test]
fn task_time_uses_the_latest_execution_and_ignores_a_late_previous_turn_end() {
    let card = timing_card(&[
        (1000, "agent.turn.started", Some("turn-one")),
        (41000, "agent.turn.finished", Some("turn-one")),
        (100000, "agent.turn.started", Some("turn-two")),
        (101000, "agent.turn.finished", Some("turn-one")),
        (120000, "agent.turn.finished", Some("turn-two")),
    ], AgentStatus::Completed(None));
    assert_eq!(card["startedAt"], 100000);
    assert_eq!(card["finishedAt"], 120000);
}

#[test]
fn task_time_does_not_invent_a_duration_for_old_records_or_a_lost_process() {
    for events in [vec![], vec![(1000, "agent.turn.started", Some("turn-one")), (900000, "agent.recovered", None)]] {
        let card = timing_card(&events, AgentStatus::Interrupted);
        assert!(card["startedAt"].is_null());
        assert!(card["finishedAt"].is_null());
    }
}

#[test]
fn task_time_counts_a_live_execution_but_not_a_settled_previous_turn() {
    let start = [(1000, "agent.turn.started", Some("turn-one"))];
    let live = timing_card(&start, AgentStatus::Running);
    assert_eq!(live["startedAt"], 1000);
    assert!(live["finishedAt"].is_null());
    let starting = timing_card(&[
        start[0], (42000, "agent.turn.finished", Some("turn-one")),
    ], AgentStatus::Running);
    assert!(starting["startedAt"].is_null());
    assert!(starting["finishedAt"].is_null());
}

#[test]
fn child_coordination_reaches_only_its_parent_without_starting_a_new_turn() {
    let f = Fixture::new();
    let child = f
        .host
        .control
        .spawn(SpawnRequest {
            parent_session_id: f.host.parent.clone(),
            name: "coordination".into(),
            role: "read_only".into(),
            origin: SpawnOrigin::Model,
            spawn_ref: None,
            parent_turn_id: Some(f.host.parent_turn.clone()),
        })
        .unwrap();
    let handle = f
        .host
        .control
        .begin_turn(&child.session_id, "coordinate-turn")
        .unwrap();
    let mut tools = ChildTools {
        control: f.host.control.clone(),
        parent: f.host.parent.clone(),
        inner: KernelToolExecutor {
            session_id: child.session_id.clone(),
            turn_id: "coordinate-turn".into(),
            extra_blocked_tools: &[],
            cancelled: Some(handle.cancel.clone()),
            progress_sink: None,
            max_output_tokens: Some(8000),
            project_execution_context: f.host.context.clone(),
        },
        parent_cancel: f.host.parent_cancel.clone(),
        deadline: Instant::now() + Duration::from_secs(10),
        allowed: HashSet::from(["send_message".into()]),
    };
    tools.execute_with_id("coordinate-1","send_message",&json!({"target":"/root","message":"Need the missing cross-device input before proceeding"}).to_string()).unwrap();
    assert!(!f.host.control.has_pending_trigger(&f.host.parent));
    assert_eq!(
        f.host.control.take_mail(&f.host.parent)[0].kind,
        MailKind::Message
    );
    assert!(tools
        .execute(
            "send_message",
            &json!({"target":"/root/sibling","message":"outside scope"}).to_string()
        )
        .is_err());
    f.host.control.cancel_subtree(&child.session_id);
    assert!(tools
        .execute(
            "send_message",
            &json!({"target":"/root","message":"late"}).to_string()
        )
        .is_err());
}

// Opt-in: these tests use the real configured account connections and consume
// model tokens. Keep their evidence separate from deterministic simulations.
struct LiveFixture {
    host: Arc<Host>,
    agent: crate::agent_threads::TurnAgent,
    _bound: crate::chat_events::SessionEventDirGuard,
    directory: PathBuf,
    provider: String,
}
impl LiveFixture {
    fn new(scenario: &str) -> Result<Self, String> {
        let (model, provider, config) = resolve_executor_for_model(None)?;
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../.somniq/runtime")
            .join(format!(
                "chat-collaboration-live-{scenario}-{:016x}",
                rand::random::<u64>()
            ));
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let directory = directory.canonicalize().map_err(|e| e.to_string())?;
        fs::write(directory.join("backend.txt"),"BACKEND EVIDENCE B17: Checkpoints are local to one device. Leased mail is reconciled by stable id. A saved tool intent without a saved outcome is unknown and must not be replayed. No cross-device measurements exist.\n").map_err(|e|e.to_string())?;
        fs::write(directory.join("frontend.txt"),"FRONTEND EVIDENCE F23: Cards use controller events with monotonic revisions. Queued is not running. Stopped tasks retain partial evidence. Device-local behavior has been observed; cross-device behavior has not been measured.\n").map_err(|e|e.to_string())?;
        let sessions = directory.join("sessions");
        let parent = format!("live-{:016x}", rand::random::<u64>());
        let bound = crate::chat_events::bind_session_event_dir(&parent, sessions.clone())?;
        let agent = crate::agent_threads::TurnAgent::register(
            &sessions,
            &parent,
            "live-parent",
            Some("collaboration-live-acceptance"),
        )
        .ok_or("could not bind parent")?;
        let available = aris_chat::chat_tool_specs(tools::mvp_tool_specs());
        let permission = configured_default_permission_mode_for(&directory);
        let host = Arc::new(Host {
            app: None,
            control: agent.control().clone(),
            parent: parent.clone(),
            parent_turn: agent.turn_id().into(),
            parent_cancel: Arc::new(AtomicBool::new(false)),
            sessions_dir: sessions,
            context: runtime::ProjectExecutionContext::new(&directory),
            config,
            model,
            permission,
            features: runtime::RuntimeFeatureConfig::default(),
            tool_specs: available
                .into_iter()
                .filter(|s| {
                    (CHILD_TOOLS.contains(&s.name.as_str()) || s.name == "send_message")
                        && s.required_permission == PermissionMode::ReadOnly
                })
                .collect(),
        });
        hosts().lock().unwrap().insert(parent, host.clone());
        eprintln!(
            "LIVE {scenario}: model={}, connection={}, permission={}, evidence={}",
            host.model,
            connection_label(&host.config),
            host.permission.as_str(),
            directory.display()
        );
        Ok(Self {
            host,
            agent,
            _bound: bound,
            directory,
            provider,
        })
    }

    fn run(&self, input: &str) -> Result<String, String> {
        let specs = aris_chat::chat_tool_specs(tools::collaboration::tool_specs());
        let observer = Box::new(LiveObserver {
            cancel: self.host.parent_cancel.clone(),
            deadline: Instant::now() + Duration::from_secs(240),
        });
        let executor = KernelToolExecutor {
            session_id: self.host.parent.clone(),
            turn_id: self.host.parent_turn.clone(),
            extra_blocked_tools: &[],
            cancelled: Some(self.host.parent_cancel.clone()),
            progress_sink: None,
            max_output_tokens: Some(8000),
            project_execution_context: self.host.context.clone(),
        };
        let runtime=aris_chat::build_conversation_runtime(Session::new(),self.host.config.clone(),self.host.model.clone(),true,specs.clone(),observer,executor,
            aris_chat::permission_policy_for_tools(specs,self.host.permission),vec![tools::collaboration::DELEGATION_POLICY.into(),format!("This is a bounded collaboration acceptance run in {}. Only the supplied local fixture evidence is in scope. Use the offered actions when justified. All children must read their evidence using read_file and report the evidence marker, supported scope and limitations; a second hand opinion is not formal review. Return a concise answer in Chinese.",self.directory.display())],self.host.features.clone(),None,None)?;
        let mut runtime = runtime
            .with_compaction_session_id(self.host.parent.clone())
            .with_max_iterations(20)
            .with_max_turn_duration(Some(Duration::from_secs(240)))
            .without_retrieval_guard()
            .with_event_sink(Box::new(
                self.host
                    .control
                    .lifecycle_sink(&self.host.parent, Some(&self.host.parent_turn)),
            ))
            .with_turn_input_source(Box::new(
                self.host
                    .control
                    .turn_input_source(&self.host.parent, Some(&self.host.parent_turn)),
            ));
        let result = runtime::with_project_execution_context(&self.host.context, || {
            runtime.run_turn(input, None)
        });
        let text = result
            .as_ref()
            .map(runtime::assistant_text_from_turn_summary)
            .unwrap_or_default();
        let report = json!({"kind":"live-model","input":input,"model":self.host.model,"provider":self.provider,"connection":connection_label(&self.host.config),"permission":self.host.permission.as_str(),"project":"collaboration-live-acceptance","result":text,"error":result.as_ref().err().map(ToString::to_string),"usage":crate::chat_events::token_usage_to_value(runtime.usage().cumulative_usage()),"cards":self.host.cards()?});
        fs::write(
            self.directory.join("result.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        result.map(|_| text).map_err(|e| e.to_string())
    }

    fn review(&self, answer: &str) -> Result<crate::review_thread::RoundOutput, String> {
        let (provider, model) = review_participants(&self.provider, &self.host.model)
            .map_err(|run| run.result.summary.clone())?;
        if provider == "oracle-web" {
            return Err("live headless acceptance requires the configured API Reviewer".into());
        }
        crate::config::apply_reviewer_environment(true);
        let backend = crate::review_thread::ConfiguredBackend(tools::prepare_llm_review(Some(
            model.clone(),
        ))?);
        let evidence = review_evidence(&self.agent, &self.host.sessions_dir);
        let packet = independent_review_prompt(
            "检查后端恢复与前端状态同步；核对证据范围与跨设备结论。",
            answer,
            &evidence,
            "",
            &[],
            1,
            &self.directory,
            &self.provider,
            &self.host.model,
        );
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancel = cancelled.clone();
        let (finish_tx, finish_rx) = std::sync::mpsc::channel::<()>();
        let watchdog = std::thread::spawn(move || {
            if finish_rx.recv_timeout(Duration::from_secs(240)).is_err() {
                cancel.store(true, Ordering::SeqCst);
            }
        });
        let output = crate::review_thread::run_round(
            &backend,
            &self.agent,
            &cancelled,
            &crate::review_thread::RoundRequest {
                attempt: 1,
                packets: crate::review_thread::Packets {
                    full: &|| packet.clone(),
                    incremental: &|| packet.clone(),
                },
                workspace: &self.directory,
                provider: &provider,
                model: &model,
            },
        );
        let _ = finish_tx.send(());
        let _ = watchdog.join();
        let report = match &output {
            Ok(value) => {
                json!({"kind":"live-independent-review","provider":provider,"model":model,"sessionId":value.reviewer_session_id,"text":value.text,"toolChecks":value.tool_calls.iter().map(|c|json!({"label":c.label,"ok":c.ok})).collect::<Vec<_>>(),"usages":value.usages.iter().map(|usage|crate::chat_events::token_usage_to_value(*usage)).collect::<Vec<_>>()})
            }
            Err(error) => {
                json!({"kind":"live-independent-review","provider":provider,"model":model,"error":format!("{error:?}")})
            }
        };
        fs::write(
            self.directory.join("review.json"),
            serde_json::to_vec_pretty(&report).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        output.map_err(|error| format!("{error:?}"))
    }
}
impl Drop for LiveFixture {
    fn drop(&mut self) {
        self.host.parent_cancel.store(true, Ordering::SeqCst);
        self.host.control.cancel_subtree(&self.host.parent);
        let deadline = Instant::now() + Duration::from_secs(5);
        while self
            .host
            .control
            .task_infos(&self.host.parent)
            .iter()
            .any(|i| runs().lock().unwrap().contains(&i.session_id))
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(20));
        }
        hosts().lock().unwrap().remove(&self.host.parent);
        crate::review_thread::discard_session(&self.host.parent);
        crate::agent_threads::evict_control(&self.host.sessions_dir);
    }
}
struct LiveObserver {
    cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl aris_executor::StreamObserver for LiveObserver {
    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst) || Instant::now() >= self.deadline
    }
    fn on_tool_call(&mut self, _id: &str, name: &str, _input: &str) -> Result<(), RuntimeError> {
        eprintln!("LIVE parent tool: {name}");
        Ok(())
    }
}

#[test]
#[ignore = "paid live model acceptance; opt in explicitly"]
fn live_simple_explanation_has_no_delegation() {
    let f = LiveFixture::new("simple").unwrap();
    let answer = f
        .run("解释这个函数：fn answer() -> u32 { 42 }。只需要解释返回值。")
        .unwrap();
    assert!(!answer.is_empty());
    assert!(
        f.host.control.task_infos(&f.host.parent).is_empty(),
        "simple question delegated unnecessarily"
    );
}

#[test]
#[ignore = "paid live model acceptance; opt in explicitly"]
fn live_parallel_investigation_and_independent_review() {
    let f = LiveFixture::new("parallel").unwrap();
    let answer=f.run(&format!("检查后端恢复与前端状态同步。这是两个可独立完成的只读调查：后端输入 {}，前端输入 {}，文件均已存在。请判断并利用并行收益，分别核对真实文件，等待双方结果，再向后端原有子任务追问缺少哪些跨设备证据。整合时明确采纳、拒绝和待查内容，以及子任务如何影响最终结论。",f.directory.join("backend.txt").display(),f.directory.join("frontend.txt").display())).unwrap();
    let items = f.host.control.task_infos(&f.host.parent);
    assert_eq!(
        items.len(),
        2,
        "parallel investigation did not dispatch two children"
    );
    assert!(
        items
            .iter()
            .all(|i| matches!(i.status, AgentStatus::Completed(_))),
        "{items:?}"
    );
    assert!(
        items.iter().all(|i| i.last_activity.is_some()),
        "children never used an evidence tool"
    );
    let output = f.review(&answer).unwrap();
    let verdict = parse_independent_review(&output.text).unwrap();
    assert_eq!(
        verdict.verdict,
        IndependentReviewVerdict::Pass,
        "{}",
        output.text
    );
}

#[test]
#[ignore = "paid live model acceptance; opt in explicitly"]
fn live_amend_then_stop_one_child_and_report_gap() {
    let f = LiveFixture::new("stop").unwrap();
    let answer=f.run(&format!("并行核查两个方向，分别只读核查 {} 和 {}。请在第一组工具调用中按顺序创建名为 backend、frontend 的两个任务，给 frontend 用 send_message 补充条件“只允许设备内结论，补充条件 C99”，然后 interrupt_agent 停止 backend，模拟用户途中停止一方。等待 frontend 自动回传，向 frontend 的原有子会话 followup_task 追问 C99 对结论的影响。最终如实说明已采用证据和停止方留下的缺口；不要通过输出文件轮询。",f.directory.join("backend.txt").display(),f.directory.join("frontend.txt").display())).unwrap();
    let items = f.host.control.task_infos(&f.host.parent);
    assert_eq!(items.len(), 2);
    assert!(
        items
            .iter()
            .any(|i| matches!(i.status, AgentStatus::Interrupted)),
        "stop did not interrupt execution: {items:?}"
    );
    assert!(
        items
            .iter()
            .any(|i| matches!(i.status, AgentStatus::Completed(_))),
        "remaining child never completed"
    );
    assert!(
        answer.contains("停止") || answer.contains("中断"),
        "missing stopped-task gap"
    );
}

#[test]
fn a_childs_result_traces_back_to_its_tool_calls_and_the_parents_spawn() {
    let f = Fixture::new();
    let spawned = f.call("spawn_agent", Fixture::contract("backend")).unwrap();
    f.settled(1);
    let child = spawned["sessionId"].as_str().unwrap();

    let trace = agent_trace(&f.host.sessions_dir, &f.host.parent);
    let result = trace
        .edges
        .iter()
        .find(|edge| edge.kind == runtime::agent_trace::InteractionKind::AgentResult)
        .expect("result edge");
    assert_eq!(result.from_session_id.as_deref(), Some(child));
    let turn = trace.source_turn(result).expect("the child's turn");
    assert!(
        turn.tools.iter().any(|call| call.tool_use_id.is_some() && call.finished_ts.is_some()),
        "the turn's tool calls are on the trace: {turn:?}"
    );
    let chain = trace.provenance(&result.id);
    assert!(
        chain
            .iter()
            .any(|edge| edge.source_tool_use_id.as_deref() == Some("tool-parent")
                && edge.from_session_id.as_deref() == Some(f.host.parent.as_str())),
        "the result leads back to the parent's spawn call: {chain:?}"
    );

    let (exported, files) =
        agent_tree_export(&f.host.sessions_dir, &f.host.parent).expect("a tree to export");
    assert_eq!(exported.edges.len(), trace.edges.len());
    let names: Vec<_> = files.iter().map(|(name, _)| name.as_str()).collect();
    assert!(names.contains(&format!("{child}.json").as_str()), "{names:?}");
    assert!(names.contains(&format!("{child}.events.jsonl").as_str()), "{names:?}");
    assert!(names.iter().all(|name| name.starts_with(child)), "{names:?}");
}

#[test]
fn a_chat_without_agents_exports_no_agent_tree() {
    let f = Fixture::new();
    assert!(agent_tree_export(&f.host.sessions_dir, &f.host.parent).is_none());
}
