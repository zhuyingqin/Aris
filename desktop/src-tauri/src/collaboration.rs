//! Chat's six collaboration actions. Connection and project context are frozen
//! from the parent turn. Ordinary children only receive read-only tools.
use super::*;
use runtime::agent_control::{
    AgentControl, AgentHandle, AgentTask, MailCause, MailKind, MailWait, SendRequest, SpawnOrigin,
    SpawnRequest,
};

static HOSTS: OnceLock<Mutex<HashMap<String, Arc<Host>>>> = OnceLock::new();
static RUNS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
fn hosts() -> &'static Mutex<HashMap<String, Arc<Host>>> {
    HOSTS.get_or_init(Mutex::default)
}
fn runs() -> &'static Mutex<HashSet<String>> {
    RUNS.get_or_init(Mutex::default)
}

pub(crate) fn discard_session(parent: &str) {
    if let Some(host) = hosts()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(parent)
    {
        host.parent_cancel.store(true, Ordering::SeqCst);
    }
}

struct Host {
    app: Option<AppHandle>,
    control: AgentControl,
    parent: String,
    parent_turn: String,
    parent_cancel: Arc<AtomicBool>,
    sessions_dir: PathBuf,
    context: runtime::ProjectExecutionContext,
    config: aris_chat::ChatExecutorConfig,
    model: String,
    permission: PermissionMode,
    features: runtime::RuntimeFeatureConfig,
    tool_specs: Vec<aris_chat::ChatToolSpec>,
}

pub(super) fn bind(
    app: &AppHandle,
    agent: &crate::agent_threads::TurnAgent,
    sessions_dir: &Path,
    context: &runtime::ProjectExecutionContext,
    config: &aris_chat::ChatExecutorConfig,
    model: &str,
    permission: PermissionMode,
    features: &runtime::RuntimeFeatureConfig,
    parent_cancel: Arc<AtomicBool>,
    available: &[aris_chat::ChatToolSpec],
) {
    let mut specs: Vec<_> = available
        .iter()
        .filter(|s| {
            CHILD_TOOLS.contains(&s.name.as_str())
                && s.required_permission == PermissionMode::ReadOnly
        })
        .cloned()
        .collect();
    specs.extend(
        aris_chat::chat_tool_specs(tools::collaboration::tool_specs())
            .into_iter()
            .filter(|s| s.name == "send_message"),
    );
    hosts()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(
            agent.session_id().into(),
            Arc::new(Host {
                app: Some(app.clone()),
                control: agent.control().clone(),
                parent: agent.session_id().into(),
                parent_turn: agent.turn_id().into(),
                parent_cancel,
                sessions_dir: sessions_dir.into(),
                context: context.clone(),
                config: config.clone(),
                model: model.into(),
                permission,
                features: features.clone(),
                tool_specs: specs,
            }),
        );
}

// No shells, file mutation, paid generation, arbitrary MCP or delegation.
// The only coordination action separately added is send_message to /root.
const CHILD_TOOLS: &[&str] = &[
    "read_file",
    "read_files",
    "read_docx",
    "glob_search",
    "grep_search",
    "WebFetch",
    "WebSearch",
    "LiteratureSearch",
    "StructuredOutput",
];

fn required(value: &Value, field: &str) -> Result<String, String> {
    let text = value
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{field} must be non-empty"))?;
    if text.chars().count() > 20_000 {
        return Err(format!("{field} is too long"));
    }
    Ok(text.into())
}

pub(super) fn execute(
    session: &str,
    turn: &str,
    tool_id: &str,
    name: &str,
    input: &str,
) -> Result<String, String> {
    let host = hosts()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(session)
        .cloned()
        .ok_or("collaboration is unavailable for this session; no task was started")?;
    if host.parent_turn != turn
        || host.parent_cancel.load(Ordering::SeqCst)
        || !host.control.is_current_turn(session, turn)
    {
        return Err("stale or stopped parent turn cannot delegate or deliver messages".into());
    }
    let value: Value = serde_json::from_str(input).map_err(|e| e.to_string())?;
    let result = match name {
        "spawn_agent" | "Agent" => host.spawn(&value, tool_id),
        "send_message" | "followup_task" => {
            let target = host
                .control
                .resolve(session, &required(&value, "target")?)
                .map_err(|e| e.to_string())?;
            if target.parent_session_id.as_deref() != Some(session) {
                return Err("only this parent's children can be addressed".into());
            }
            let followup = name == "followup_task";
            let receipt = host
                .control
                .send(SendRequest {
                    author_session_id: session.into(),
                    target: target.path.to_string(),
                    kind: if followup {
                        MailKind::Task
                    } else {
                        MailKind::Message
                    },
                    content: required(&value, "message")?,
                    trigger_turn: followup,
                    cause: MailCause {
                        turn_id: Some(turn.into()),
                        tool_use_id: Some(tool_id.into()),
                        action_id: None,
                    },
                })
                .map_err(|e| e.to_string())?;
            if followup {
                host.start(&target.session_id)?;
            }
            host.publish();
            Ok(json!({"mailId":receipt.mail_id,"target":target.path,"triggerTurn":followup}))
        }
        "wait_agent" => {
            let millis = value
                .get("timeout_ms")
                .and_then(Value::as_u64)
                .unwrap_or(30_000)
                .min(60_000);
            host.control.set_waiting(session, turn, true);
            host.publish();
            let outcome = host.control.wait_for_mail(
                session,
                Duration::from_millis(millis),
                &host.parent_cancel,
            );
            host.control.set_waiting(session, turn, false);
            Ok(
                json!({"notification":match outcome { MailWait::Mail=>"mail",MailWait::TimedOut=>"timeout",MailWait::Cancelled=>"cancelled",MailWait::Closed=>"closed"},"pendingMail":host.control.pending_mail(session)}),
            )
        }
        "list_agents" => Ok(json!({"agents":host.cards()?})),
        "interrupt_agent" => {
            let target = host
                .control
                .resolve(session, &required(&value, "target")?)
                .map_err(|e| e.to_string())?;
            if target.parent_session_id.as_deref() != Some(session) {
                return Err("only your own children can be interrupted".into());
            }
            host.control
                .interrupt_child(session, turn, &target.session_id)
                .map_err(|error| error.to_string())?;
            host.publish();
            Ok(json!({"target":target.path,"state":"interrupted"}))
        }
        _ => Err(format!("unknown collaboration action {name}")),
    }?;
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

fn connection_label(config: &aris_chat::ChatExecutorConfig) -> String {
    // Parse out credentials, query strings and paths that could carry secrets.
    let (provider, base) = match config {
        aris_chat::ChatExecutorConfig::Anthropic { base_url, .. } => ("anthropic", base_url),
        aris_chat::ChatExecutorConfig::OpenAiCompatible { base_url, .. } => {
            ("openai-compatible", base_url)
        }
    };
    let endpoint = reqwest::Url::parse(base)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .unwrap_or_else(|| "configured endpoint".into());
    format!("{provider} / {endpoint}")
}

impl Host {
    fn cards(&self) -> Result<Value, String> {
        cards(&self.control, &self.parent, &self.sessions_dir)
    }
    fn publish(&self) {
        if let Ok(cards) = self.cards() {
            if let Some(app) = &self.app {
                let _ = app.emit(
                    "chat-agents",
                    json!({"sessionId":self.parent,"agents":cards}),
                );
            }
        }
    }

    fn spawn(self: &Arc<Self>, value: &Value, tool_id: &str) -> Result<Value, String> {
        if value.get("role").and_then(Value::as_str) != Some("read_only") {
            return Err("first version permits only read_only children".into());
        }
        if value.get("prerequisites_ready").and_then(Value::as_bool) != Some(true) {
            return Err("obtain prerequisite inputs before delegation".into());
        }
        if value.get("model").is_some() {
            return Err(
                "children use the current Executor connection; model overrides are unavailable"
                    .into(),
            );
        }
        let task = AgentTask {
            reason: required(value, "reason")?,
            task: required(value, "task")?,
            inputs: required(value, "inputs")?,
            deliverable: required(value, "deliverable")?,
            stop_condition: required(value, "stop_condition")?,
            model: self.model.clone(),
            connection: connection_label(&self.config),
            permission: format!("{} intersect read-only", self.permission.as_str()),
            workspace: self.context.current_dir().display().to_string(),
            max_iterations: value
                .get("max_iterations")
                .and_then(Value::as_u64)
                .unwrap_or(12)
                .clamp(1, 16) as usize,
            max_seconds: value
                .get("max_seconds")
                .and_then(Value::as_u64)
                .unwrap_or(300)
                .clamp(10, 600),
        };
        let handle = self
            .control
            .spawn(SpawnRequest {
                parent_session_id: self.parent.clone(),
                name: required(value, "name")?,
                role: "read_only".into(),
                origin: SpawnOrigin::Model,
                spawn_ref: Some(tool_id.into()),
                parent_turn_id: Some(self.parent_turn.clone()),
            })
            .map_err(|e| e.to_string())?;
        let setup = (|| {
            self.control
                .set_task(&handle.session_id, task.clone())
                .map_err(|e| e.to_string())?;
            self.control
                .send(SendRequest {
                    author_session_id: self.parent.clone(),
                    target: handle.path.to_string(),
                    kind: MailKind::Task,
                    content: format!(
                        "Task: {}\nInputs: {}\nDeliverable: {}\nStop when: {}",
                        task.task, task.inputs, task.deliverable, task.stop_condition
                    ),
                    trigger_turn: true,
                    cause: MailCause {
                        turn_id: Some(self.parent_turn.clone()),
                        tool_use_id: Some(tool_id.into()),
                        action_id: None,
                    },
                })
                .map_err(|e| e.to_string())?;
            self.start(&handle.session_id)
        })();
        if let Err(error) = setup {
            self.control.fail_creation(&handle.session_id, &error);
            self.publish();
            return Err(error);
        }
        self.publish();
        Ok(
            json!({"sessionId":handle.session_id,"path":handle.path,"state":self.control.status(&handle.session_id),"task":task}),
        )
    }

    fn start(self: &Arc<Self>, session_id: &str) -> Result<(), String> {
        let mut active = runs().lock().unwrap_or_else(PoisonError::into_inner);
        if active.contains(session_id) {
            return Ok(());
        }
        if self.parent_cancel.load(Ordering::SeqCst) {
            return Err("parent was stopped; follow up from a new parent turn".into());
        }
        let mut task = self
            .control
            .info(session_id)
            .and_then(|i| i.task)
            .ok_or("missing delegation contract")?;
        task.model = self.model.clone();
        task.connection = connection_label(&self.config);
        task.permission = format!("{} intersect read-only", self.permission.as_str());
        task.workspace = self.context.current_dir().display().to_string();
        let turn = format!("child-{:032x}", rand::random::<u128>());
        let handle = self
            .control
            .begin_child_turn(&self.parent, &self.parent_turn, session_id, &turn, task)
            .map_err(|e| e.to_string())?;
        active.insert(session_id.into());
        let host = Arc::clone(self);
        let id = session_id.to_string();
        let failure_turn = turn.clone();
        if let Err(error) = std::thread::Builder::new()
            .name(format!("agent-{id}"))
            .spawn(move || host.worker(handle, turn))
        {
            active.remove(session_id);
            self.control.observe_event(
                session_id,
                Some(&failure_turn),
                &runtime::EventType::TurnFinished {
                    outcome: runtime::TurnOutcome::Failed {
                        message: error.to_string(),
                    },
                    last_message: None,
                },
            );
            return Err(format!("could not create worker: {error}"));
        }
        Ok(())
    }

    fn worker(self: Arc<Self>, handle: AgentHandle, turn: String) {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            runtime::with_project_execution_context(&self.context, || self.drive(&handle, &turn))
        }));
        let failure = match outcome {
            Ok(Ok(())) => None,
            Ok(Err(error)) => Some(error),
            Err(_) => Some("child worker panicked; parent session remains available".into()),
        };
        if let Some(error) = failure {
            self.control.observe_event(
                &handle.session_id,
                Some(&turn),
                &runtime::EventType::TurnFinished {
                    outcome: runtime::TurnOutcome::Failed { message: error },
                    last_message: None,
                },
            );
            // begin_child_turn handled the existing wake-up requests. Do not
            // clear a later explicit follow-up while this worker unwinds.
        }
        self.publish();
        runs()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&handle.session_id);
        let latest = hosts()
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&self.parent)
            .cloned();
        if self.control.has_pending_trigger(&handle.session_id) {
            if let Some(latest) = latest.filter(|h| !h.parent_cancel.load(Ordering::SeqCst)) {
                let _ = latest.start(&handle.session_id);
            }
        }
    }

    fn drive(&self, handle: &AgentHandle, turn: &str) -> Result<(), String> {
        let cancel = Arc::clone(&handle.cancel);
        let path = crate::agent_threads::agents_dir(&self.sessions_dir)
            .join(format!("{}.json", handle.session_id));
        let session = if path.exists() {
            Session::load_from_path(&path).map_err(|e| e.to_string())?
        } else {
            Session::new()
        };
        let task = self
            .control
            .info(&handle.session_id)
            .and_then(|i| i.task)
            .ok_or("missing delegation contract")?;
        let deadline = Instant::now() + Duration::from_secs(task.max_seconds);
        let _binding = crate::chat_events::bind_session_event_dir(
            &handle.session_id,
            crate::agent_threads::agents_dir(&self.sessions_dir),
        )?;
        let _tag = crate::chat_events::TurnTag::new(&handle.session_id, turn).enter();
        crate::chat_events::record_event(
            &handle.session_id,
            "agent.execution",
            json!({
                "turnId":turn,"model":self.model,"connection":connection_label(&self.config),
                "projectId":self.control.info(&handle.session_id).and_then(|i|i.project_id),
                "permission":task.permission,"workspace":task.workspace,
                "maxIterations":task.max_iterations,"maxSeconds":task.max_seconds,
            }),
        );
        let observer = Box::new(ChildObserver {
            control: self.control.clone(),
            app: self.app.clone(),
            parent: self.parent.clone(),
            session: handle.session_id.clone(),
            turn: turn.into(),
            cancel: cancel.clone(),
            parent_cancel: self.parent_cancel.clone(),
            deadline,
        });
        let executor = ChildTools {
            control: self.control.clone(),
            parent: self.parent.clone(),
            inner: KernelToolExecutor {
                session_id: handle.session_id.clone(),
                turn_id: turn.into(),
                extra_blocked_tools: &[],
                cancelled: Some(cancel.clone()),
                progress_sink: None,
                max_output_tokens: Some(8000),
                project_execution_context: self.context.clone(),
            },
            parent_cancel: self.parent_cancel.clone(),
            deadline,
            allowed: self.tool_specs.iter().map(|s| s.name.clone()).collect(),
        };
        let policy =
            aris_chat::permission_policy_for_tools(self.tool_specs.clone(), self.permission);
        let prompt=vec![format!("You are a read-only research child in {}. Complete only the delegated contract. Do not mutate files, run commands, contact people, spawn agents, change models or act as the formal Reviewer. Use send_message to target /root when you need to coordinate with your parent; this does not start a new parent turn. Use supplied evidence and read-only tools; report exact evidence locations, uncertainty and stopping conditions. Return a concise summary with findings, evidence and limitations. Stop at the contract's budget. Reason: {}",self.context.current_dir().display(),task.reason)];
        let runtime = aris_chat::build_conversation_runtime(
            session,
            self.config.clone(),
            self.model.clone(),
            true,
            self.tool_specs.clone(),
            observer,
            executor,
            policy,
            prompt,
            self.features.clone(),
            None,
            None,
        )?;
        let mut runtime = runtime
            .with_compaction_session_id(handle.session_id.clone())
            .with_max_iterations(task.max_iterations)
            .with_max_turn_duration(Some(Duration::from_secs(task.max_seconds)))
            .without_retrieval_guard()
            .with_event_sink(Box::new(ChildSink {
                host: self.clone_for_sink(),
                session: handle.session_id.clone(),
                turn: turn.into(),
            }))
            .with_turn_input_source(Box::new(
                self.control
                    .turn_input_source(&handle.session_id, Some(turn)),
            ));
        self.publish();
        let started = Instant::now();
        let before = runtime.usage().cumulative_usage();
        let outcome = runtime.run_turn("Read the task and any additional messages from your mailbox; deliver the requested evidence.",None);
        let after = runtime.usage().cumulative_usage();
        let usage = TokenUsage {
            input_tokens: after.input_tokens.saturating_sub(before.input_tokens),
            output_tokens: after.output_tokens.saturating_sub(before.output_tokens),
            cache_creation_input_tokens: after
                .cache_creation_input_tokens
                .saturating_sub(before.cache_creation_input_tokens),
            cache_read_input_tokens: after
                .cache_read_input_tokens
                .saturating_sub(before.cache_read_input_tokens),
        };
        crate::chat_events::record_event(
            &handle.session_id,
            "agent.usage",
            json!({"turnId":turn,"model":self.model,"usage":crate::chat_events::token_usage_to_value(usage)}),
        );
        if self.app.is_some() {
            let _ = crate::usage_log::append_turn_usage(
                &handle.session_id,
                turn,
                "subagent",
                &self.model,
                &connection_label(&self.config),
                &executor_server_label(&self.config),
                &[usage],
                &[],
                started.elapsed().as_millis() as u64,
                "",
            );
        }
        outcome.map(|_| ()).map_err(|e| e.to_string())
    }

    fn clone_for_sink(&self) -> (AgentControl, Option<AppHandle>, String, PathBuf) {
        (
            self.control.clone(),
            self.app.clone(),
            self.parent.clone(),
            self.sessions_dir.clone(),
        )
    }
}

struct ChildSink {
    host: (AgentControl, Option<AppHandle>, String, PathBuf),
    session: String,
    turn: String,
}
impl runtime::EventSink for ChildSink {
    fn emit(&mut self, event: &runtime::RuntimeEvent) {
        // Durable first, visible second: whoever sees the status change (a
        // card, the parent's result mail, a waiter) must find the row behind it.
        let audit = match &event.event_type {
            runtime::EventType::TurnStarted => Some(("agent.turn.started", json!({}))),
            runtime::EventType::TurnFinished { outcome, .. } => Some((
                "agent.turn.finished",
                match outcome {
                    runtime::TurnOutcome::Completed => json!({"status":"completed"}),
                    runtime::TurnOutcome::Interrupted => json!({"status":"interrupted"}),
                    runtime::TurnOutcome::Failed { message } => {
                        json!({"status":"errored","reason":redact_review_evidence(message)})
                    }
                },
            )),
            runtime::EventType::ToolCall {
                tool_name,
                is_error,
                ..
            } => Some((
                "agent.tool.finished",
                json!({"toolName":tool_name,"isError":is_error}),
            )),
            _ => None,
        };
        if let Some((kind, mut payload)) = audit {
            payload["turnId"] = json!(self.turn);
            crate::chat_events::record_event_in_dir(
                &crate::agent_threads::agents_dir(&self.host.3),
                &self.session,
                kind,
                payload,
            );
        }
        self.host
            .0
            .observe_event(&self.session, Some(&self.turn), &event.event_type);
        if let runtime::EventType::ToolCall {
            tool_name,
            input_summary,
            is_error,
        } = &event.event_type
        {
            self.host.0.activity(
                &self.session,
                &self.turn,
                &format!(
                    "{tool_name}: {input_summary}{}",
                    if *is_error { " (failed)" } else { "" }
                ),
            );
        }
        if let Ok(items) = cards(&self.host.0, &self.host.2, &self.host.3) {
            if let Some(app) = &self.host.1 {
                let _ = app.emit(
                    "chat-agents",
                    json!({"sessionId":self.host.2,"agents":items}),
                );
            }
        }
    }
}

struct ChildObserver {
    control: AgentControl,
    app: Option<AppHandle>,
    parent: String,
    session: String,
    turn: String,
    cancel: Arc<AtomicBool>,
    parent_cancel: Arc<AtomicBool>,
    deadline: Instant,
}
impl aris_executor::StreamObserver for ChildObserver {
    fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
            || self.parent_cancel.load(Ordering::SeqCst)
            || Instant::now() >= self.deadline
    }
    fn on_tool_call(&mut self, id: &str, name: &str, _input: &str) -> Result<(), RuntimeError> {
        if self.is_cancelled() || !self.control.is_current_turn(&self.session, &self.turn) {
            return Err(RuntimeError::new("interrupted by user"));
        }
        self.control
            .activity(&self.session, &self.turn, &format!("{name} ({id})"));
        crate::chat_events::record_event(
            &self.session,
            "agent.tool.started",
            json!({"turnId":self.turn,"toolUseId":id,"toolName":name}),
        );
        if let Some(app) = &self.app {
            let _ = app.emit(
                "chat-agent-activity",
                json!({"sessionId":self.parent,"childSessionId":self.session,"activity":name,"revision":self.control.info(&self.session).map(|i|i.revision)}),
            );
        }
        Ok(())
    }
}

struct ChildTools {
    control: AgentControl,
    parent: String,
    inner: KernelToolExecutor,
    parent_cancel: Arc<AtomicBool>,
    deadline: Instant,
    allowed: HashSet<String>,
}
impl ToolExecutor for ChildTools {
    fn execute(&mut self, name: &str, input: &str) -> Result<String, ToolError> {
        self.execute_with_id("", name, input)
    }
    fn execute_with_id(&mut self, id: &str, name: &str, input: &str) -> Result<String, ToolError> {
        if self.is_cancelled() {
            return Err(ToolError::interrupted_by_user());
        }
        if name == "send_message" && self.allowed.contains(name) {
            let value: Value =
                serde_json::from_str(input).map_err(|e| ToolError::new(e.to_string()))?;
            if required(&value, "target").map_err(ToolError::new)? != "/root" {
                return Err(ToolError::new("a child may only coordinate with /root"));
            }
            let receipt = self
                .control
                .send(SendRequest {
                    author_session_id: self.inner.session_id.clone(),
                    target: "/root".into(),
                    kind: MailKind::Message,
                    content: required(&value, "message").map_err(ToolError::new)?,
                    trigger_turn: false,
                    cause: MailCause {
                        turn_id: Some(self.inner.turn_id.clone()),
                        tool_use_id: Some(id.into()),
                        action_id: None,
                    },
                })
                .map_err(|e| ToolError::new(e.to_string()))?;
            return Ok(json!({"mailId":receipt.mail_id,"parentSessionId":self.parent}).to_string());
        }
        if !self.allowed.contains(name) {
            return Err(ToolError::new(
                "child tool is outside the inherited read-only permission intersection",
            ));
        }
        self.inner.execute_with_id(id, name, input)
    }
    fn is_cancelled(&self) -> bool {
        self.inner.is_cancelled()
            || self.parent_cancel.load(Ordering::SeqCst)
            || Instant::now() >= self.deadline
    }
}

fn cards(control: &AgentControl, parent: &str, sessions_dir: &Path) -> Result<Value, String> {
    let agents = control.task_infos(parent);
    Ok(Value::Array(
        agents
            .into_iter()
            .filter(|i| i.parent_session_id.as_deref() == Some(parent))
            .map(|info| {
                let mut value = serde_json::to_value(&info).unwrap_or(Value::Null);
                value["persistenceError"] = json!(control.persistence_error());
                value["sessionPath"] = json!(crate::agent_threads::agents_dir(sessions_dir)
                    .join(format!("{}.json", info.session_id))
                    .display()
                    .to_string());
                value["evidencePath"] = json!(crate::agent_threads::agents_dir(sessions_dir)
                    .join(format!("{}.events.jsonl", info.session_id))
                    .display()
                    .to_string());
                project_task_timing(&mut value, sessions_dir, &info.session_id, &info.status);
                value
            })
            .collect(),
    ))
}

/// Timing is a read-only projection of the latest durable execution. Opening a
/// panel must never start a clock at "now" or count idle time between follow-ups.
fn project_task_timing(
    card: &mut Value,
    sessions_dir: &Path,
    session_id: &str,
    status: &runtime::agent_control::AgentStatus,
) {
    use runtime::agent_control::AgentStatus;
    let kinds = [
        "agent.turn.started",
        "agent.turn.finished",
        "agent.interrupted",
        "agent.recovered",
        "agent.close",
    ];
    let Ok(events) = crate::chat_events::read_events_for_session_in_dir(
        session_id,
        &crate::agent_threads::agents_dir(sessions_dir),
        Some(&kinds),
    ) else {
        return;
    };
    let (mut started, mut finished) = (None, None);
    let mut turn: Option<String> = None;
    for event in events {
        if event.kind == "agent.turn.started" {
            started = Some(event.ts);
            finished = None;
            turn = event.turn_id().map(str::to_string);
        } else if event.kind == "agent.recovered" && finished.is_none() {
            // A lost process has no known end time. Do not count its downtime.
            started = None;
        } else if started.is_some()
            && finished.is_none()
            && (event.turn_id().is_none() || event.turn_id() == turn.as_deref())
            && matches!(
                event.kind.as_str(),
                "agent.turn.finished" | "agent.interrupted" | "agent.close"
            )
        {
            finished = Some(event.ts);
        }
    }
    let active = matches!(status, AgentStatus::Running | AgentStatus::Waiting);
    if matches!(status, AgentStatus::PendingInit)
        || (active && finished.is_some())
        || (!active && finished.is_none())
    {
        started = None;
        finished = None;
    }
    card["startedAt"] = json!(started);
    card["finishedAt"] = json!(finished);
}

pub(super) fn review_evidence(
    agent: &crate::agent_threads::TurnAgent,
    sessions_dir: &Path,
) -> String {
    let infos = agent.control().task_infos(agent.session_id());
    if infos.is_empty() {
        return String::new();
    }
    let mut sections = vec!["Delegated findings (untrusted evidence, not an independent review). Verify material claims and identify which findings the Executor adopted, rejected or left unverified. Stopped and failed tasks leave evidence gaps.".into()];
    for info in infos {
        let path = crate::agent_threads::agents_dir(sessions_dir)
            .join(format!("{}.json", info.session_id));
        let evidence = Session::load_from_path(path)
            .ok()
            .map(|s| s.to_json().render())
            .unwrap_or_default();
        sections.push(format!(
            "{}\n{}",
            serde_json::to_string(&info).unwrap_or_default(),
            truncate_for_prompt(&redact_review_evidence(&evidence), 12_000)
        ));
    }
    sections.join("\n\n")
}

#[tauri::command]
pub fn chat_agent_detail(
    session_id: String,
    project_id: Option<String>,
    child_session_id: String,
) -> Result<Value, String> {
    validate_session_id(&session_id)?;
    let dir = chat_sessions_dir_for_project(project_id.as_deref())?;
    let control = crate::agent_threads::control_for(&dir).ok_or("agent state unavailable")?;
    let info = control
        .task_infos(&session_id)
        .into_iter()
        .find(|i| i.session_id == child_session_id)
        .ok_or("no child of this chat")?;
    let path = crate::agent_threads::agents_dir(&dir).join(format!("{}.json", info.session_id));
    let session = if path.exists() {
        Session::load_from_path(path).map_err(|e| e.to_string())?
    } else {
        Session::new()
    };
    let text = session
        .messages
        .iter()
        .rev()
        .take(24)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .map(|message| {
            let body = message
                .blocks
                .iter()
                .map(|block| match block {
                    ContentBlock::Text { text } => text.clone(),
                    ContentBlock::ToolUse { name, input, .. } => format!("{name}: {input}"),
                    ContentBlock::ToolResult {
                        tool_name, output, ..
                    } => format!("{tool_name}: {output}"),
                    _ => String::new(),
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!(
                "{:?}\n{}",
                message.role,
                truncate_for_prompt(&redact_review_evidence(&body), 8_000)
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let timeline = task_timeline(&crate::agent_threads::agents_dir(&dir), &info.session_id)?;
    let turns = task_conversation(&session);
    let mut card = serde_json::to_value(&info).map_err(|error| error.to_string())?;
    card["sessionPath"] = json!(crate::agent_threads::agents_dir(&dir)
        .join(format!("{}.json", info.session_id)).display().to_string());
    card["evidencePath"] = json!(crate::agent_threads::agents_dir(&dir)
        .join(format!("{}.events.jsonl", info.session_id)).display().to_string());
    card["persistenceError"] = json!(control.persistence_error());
    project_task_timing(&mut card, &dir, &info.session_id, &info.status);
    Ok(json!({"info":card,"transcript":text,"turns":turns,"timeline":timeline}))
}

/// Reuse Chat's tool/result grouping for the child view. Only visible,
/// redacted conversation blocks leave this projection; model prompts and
/// private reasoning remain in the local canonical session.
fn task_conversation(session: &Session) -> Vec<Value> {
    let mut turns = crate::chat_events::turns_from_session(session);
    let start = turns.len().saturating_sub(24);
    turns.drain(..start);
    for turn in &mut turns {
        turn["readOnly"] = json!(true);
        if let Some(blocks) = turn.get_mut("blocks").and_then(Value::as_array_mut) {
            blocks.retain(|block| block["kind"] != "thinking");
            for block in blocks {
                for key in ["text", "input", "output", "message"] {
                    if let Some(text) = block.get(key).and_then(Value::as_str) {
                        block[key] = json!(truncate_for_prompt(&redact_review_evidence(text), 8_000));
                    }
                }
            }
        }
    }
    turns.retain(|turn| turn["blocks"].as_array().is_some_and(|blocks| !blocks.is_empty()));
    turns
}

fn task_timeline(agents_dir: &Path, session_id: &str) -> Result<Vec<Value>, String> {
    let kinds = [
        "agent.lineage",
        "agent.execution",
        "agent.turn.started",
        "agent.turn.finished",
        "agent.tool.started",
        "agent.tool.finished",
        "agent.mail.sent",
        "agent.mail.delivered",
        "agent.interrupted",
        "agent.recovered",
        "agent.close",
    ];
    let events =
        crate::chat_events::read_events_for_session_in_dir(session_id, agents_dir, Some(&kinds))?;
    Ok(events.into_iter().rev().take(80).collect::<Vec<_>>().into_iter().rev().map(|event| {
        // The UI projection exposes only audit labels, never model inputs or
        // connection credentials that might be present in the raw event.
        json!({"seq":event.seq,"ts":event.ts,"kind":event.kind,"turnId":event.turn_id(),
            "toolName":event.payload.get("toolName"),"isError":event.payload.get("isError"),
            "status":event.payload.get("status"),
            "reason":event.payload.get("reason").and_then(Value::as_str).map(redact_review_evidence),
            "model":event.payload.get("model")})
    }).collect())
}

#[tauri::command]
pub fn chat_agent_list(session_id: String, project_id: Option<String>) -> Result<Value, String> {
    validate_session_id(&session_id)?;
    let dir = chat_sessions_dir_for_project(project_id.as_deref())?;
    let control = crate::agent_threads::control_for(&dir).ok_or("agent state unavailable")?;
    control
        .register_root(&session_id, project_id.as_deref())
        .map_err(|e| e.to_string())?;
    cards(&control, &session_id, &dir)
}

#[tauri::command]
pub fn chat_agent_interrupt(
    app: AppHandle,
    session_id: String,
    project_id: Option<String>,
    target: String,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let dir = chat_sessions_dir_for_project(project_id.as_deref())?;
    let control = crate::agent_threads::control_for(&dir).ok_or("agent state unavailable")?;
    let child = control
        .resolve(&session_id, &target)
        .map_err(|e| e.to_string())?;
    if child.parent_session_id.as_deref() != Some(&session_id) {
        return Err("not this chat's child".into());
    }
    control.cancel_subtree(&child.session_id);
    let _ = app.emit(
        "chat-agents",
        json!({"sessionId":session_id,"agents":cards(&control,&session_id,&dir)?}),
    );
    Ok(())
}

/// The `agent.*` rows the trace reducer reads.
const TRACE_KINDS: &[&str] = &[
    "agent.lineage",
    "agent.spawn",
    "agent.mail.sent",
    "agent.mail.delivered",
    "agent.result",
    "agent.close",
    "agent.review.request",
    "agent.review.verdict",
    "agent.turn.started",
    "agent.turn.finished",
    "agent.tool.started",
    "agent.tool.finished",
];

/// The interaction graph of the agent tree under the chat `root`, read from
/// the chat's log, the edge log and every agent's own log.
pub(crate) fn agent_trace(sessions_dir: &Path, root: &str) -> runtime::agent_trace::AgentTrace {
    let agents_dir = crate::agent_threads::agents_dir(sessions_dir);
    let edges = runtime::agent_control::read_edges(&agents_dir);
    let mut events = Vec::new();
    let mut read = |session_id: &str, dir: &Path| {
        // An unreadable log is a gap in the graph, not a failure of it.
        let rows = crate::chat_events::read_events_for_session_in_dir(
            session_id,
            dir,
            Some(TRACE_KINDS),
        )
        .unwrap_or_default();
        events.extend(rows.into_iter().map(|row| runtime::agent_trace::TraceEvent {
            session_id: session_id.to_string(),
            seq: row.seq,
            ts: row.ts,
            kind: row.kind,
            payload: row.payload,
        }));
    };
    read(root, sessions_dir);
    for edge in &edges {
        if let Some(lineage) = edge.lineage.as_ref().filter(|l| l.root_session_id == root) {
            read(&lineage.session_id, &agents_dir);
        }
    }
    runtime::agent_trace::reduce_agent_trace(root, &edges, &events)
}

/// What a debug bundle carries for the chat `root`'s agent tree: the reduced
/// trace, and every file the tree's agents own, by file name. `None` when the
/// chat never had an agent.
pub(crate) fn agent_tree_export(
    sessions_dir: &Path,
    root: &str,
) -> Option<(runtime::agent_trace::AgentTrace, Vec<(String, PathBuf)>)> {
    let trace = agent_trace(sessions_dir, root);
    if trace.nodes.len() <= 1 && trace.edges.is_empty() {
        return None;
    }
    let agents_dir = crate::agent_threads::agents_dir(sessions_dir);
    let prefixes: Vec<String> = trace
        .nodes
        .iter()
        .filter(|node| node.session_id != root)
        .map(|node| format!("{}.", node.session_id))
        .collect();
    let mut files: Vec<(String, PathBuf)> = fs::read_dir(&agents_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            let owned = prefixes.iter().any(|prefix| name.starts_with(prefix.as_str()));
            (owned && entry.path().is_file()).then(|| (name, entry.path()))
        })
        .collect();
    files.sort();
    Some((trace, files))
}

#[tauri::command]
pub async fn chat_agent_trace(
    session_id: String,
    project_id: Option<String>,
) -> Result<Value, String> {
    validate_session_id(&session_id)?;
    let dir = chat_sessions_dir_for_project(project_id.as_deref())?;
    // A chat's log can be large; keep the reading off the main thread.
    tauri::async_runtime::spawn_blocking(move || {
        serde_json::to_value(agent_trace(&dir, &session_id)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
#[path = "tests/collaboration.rs"]
mod tests;
