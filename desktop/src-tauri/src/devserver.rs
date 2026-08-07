//! Dev-only HTTP host for the review-workflow controller.
//!
//! The desktop UI already renders in a plain browser, but every `invoke` there
//! either hits a hand-written fake or throws, so the Workflows tab could not be
//! exercised against real Rust. This server closes that gap: it implements
//! [`AppCtx`] outside Tauri and dispatches the same controller functions the
//! `#[tauri::command]` shims call, so `npm run dev` plus this binary is a
//! complete, inspectable stack — no webview, no installer, no clicking through
//! a packaged app to reproduce a bug.
//!
//! It is compiled only under the `devserver` feature and binds to loopback.
//!
//! Two things it deliberately does *not* do:
//!
//! * Executor turns do not run through the desktop Chat engine, which is bound
//!   to `AppHandle` for permission prompts and streaming deltas. They are
//!   answered by [`ExecutorMode`] instead — deterministic by default, which is
//!   what makes a reproduction reproducible.
//! * Emitted events are buffered for polling rather than pushed, so a reader
//!   can also just `curl /events` and see the same stream the UI sees.

use std::collections::VecDeque;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::extract::{Path, Query, State};
use axum::response::Json;
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::app_ctx::AppCtx;
use crate::engine::{ChatState, WorkflowSessionBinding, WorkflowTurnRequest};

/// Every command this server knows how to dispatch.  Kept explicit so
/// `/health` can report the surface and an unknown command fails loudly
/// instead of silently doing nothing.
const COMMANDS: &[&str] = &[
    "review_workflows_list",
    "review_workflow_load",
    "review_workflow_create",
    "review_workflow_save",
    "review_workflow_transcript",
    "review_workflow_drive_once",
    "review_workflow_submit_scope_plan",
    "review_workflow_confirm_scope_plan",
    "review_workflow_reset_scope_plan",
    "review_workflow_executor_turn",
    "review_workflow_discuss",
    "review_workflow_reviewer_turn",
    "review_workflow_lease_acquire",
    "review_workflow_lease_release",
    "review_workflow_rename",
    "review_workflow_delete",
];

/// How Executor turns are answered.
pub enum ExecutorMode {
    /// Deterministic output derived from the run's own ledger binding.  Offline
    /// and repeatable, so a UI or controller bug reproduces the same way twice.
    Stub,
    /// Responses replayed in order from a `--script` file, one JSON string or
    /// raw line per turn.  Running out is an error, not a hang.
    Script(Mutex<VecDeque<String>>),
    /// Real one-shot model calls through the configured provider.  There is no
    /// persistent workflow Chat session behind these, so transcript continuity
    /// across turns is weaker than in the packaged app.  The optional model id
    /// overrides both the request's own `model_override` and the run's locked
    /// `executorModel`, which otherwise default to whatever `executor_model` is
    /// configured in `config.json` — this is how `--model deepseek-v4-flash-free`
    /// forces a specific model without first locking it onto the run.
    Live(Option<String>),
}

/// One event the controller emitted, in arrival order.
#[derive(Debug, Clone, Serialize)]
struct StoredEvent {
    seq: u64,
    name: String,
    payload: Value,
}

pub struct ServerCtx {
    workspace: PathBuf,
    project_id: String,
    chat: ChatState,
    events: Mutex<Vec<StoredEvent>>,
    executor: ExecutorMode,
    allow_run_save: bool,
}

impl ServerCtx {
    pub fn new(
        workspace: PathBuf,
        project_id: String,
        executor: ExecutorMode,
        allow_run_save: bool,
    ) -> Self {
        Self {
            workspace,
            project_id,
            chat: ChatState::default(),
            events: Mutex::new(Vec::new()),
            executor,
            allow_run_save,
        }
    }

    fn events_since(&self, since: u64) -> (Vec<StoredEvent>, u64) {
        let events = self.events.lock().expect("event log");
        let next = events.last().map_or(0, |event| event.seq);
        let pending = events
            .iter()
            .filter(|event| event.seq > since)
            .cloned()
            .collect();
        (pending, next)
    }

    /// Deterministic stand-in for an Executor turn.
    ///
    /// It returns the scope plan the controller asks for at `scope-and-plan`,
    /// built from the run's own ledger binding so every configured source is
    /// represented and the transition actually advances.  Other stages get a
    /// plain acknowledgement; the controller's own normalization decides what
    /// to do with it.
    fn stub_turn(request: &WorkflowTurnRequest) -> String {
        if request.stage_id != "scope-and-plan" {
            return format!(
                "[devserver stub] No scripted response for stage `{}`.",
                request.stage_id
            );
        }
        let binding = &request.binding;
        let terms = if binding.keywords.is_empty() {
            binding.topic.clone()
        } else {
            binding
                .keywords
                .iter()
                .map(|keyword| format!("\"{keyword}\""))
                .collect::<Vec<_>>()
                .join(" AND ")
        };
        let queries: Vec<Value> = binding
            .databases
            .iter()
            .map(|source| {
                json!({
                    "source": source,
                    "language": binding.languages.first().cloned().unwrap_or_else(|| "English".to_string()),
                    "query": if source == "scopus" {
                        format!("TITLE-ABS-KEY({terms})")
                    } else {
                        terms.clone()
                    },
                    "rationale": format!("devserver stub sweep for `{source}`"),
                })
            })
            .collect();
        json!({
            "queries": queries,
            "inclusionCriteria": ["peer-reviewed review articles"],
            "exclusionCriteria": ["editorials", "abstracts without full text"],
        })
        .to_string()
    }
}

#[async_trait::async_trait]
impl AppCtx for ServerCtx {
    fn project_path(&self) -> Result<PathBuf, String> {
        Ok(self.workspace.clone())
    }

    fn project_id(&self) -> Result<String, String> {
        Ok(self.project_id.clone())
    }

    fn emit(&self, event: &str, payload: Value) {
        let mut events = self.events.lock().expect("event log");
        let seq = events.last().map_or(0, |event| event.seq) + 1;
        events.push(StoredEvent {
            seq,
            name: event.to_string(),
            payload,
        });
    }

    fn append_ledger_transcript(
        &self,
        binding: &WorkflowSessionBinding,
        action_id: &str,
        stage_id: &str,
        text: &str,
    ) -> Result<(), String> {
        crate::engine::append_workflow_ledger_transcript(
            &self.chat,
            binding,
            action_id,
            stage_id,
            text,
        )
    }

    fn append_reviewer_transcript(
        &self,
        binding: &WorkflowSessionBinding,
        action_id: &str,
        stage_id: &str,
        text: &str,
    ) -> Result<(), String> {
        crate::engine::append_workflow_reviewer_transcript(
            &self.chat,
            binding,
            action_id,
            stage_id,
            text,
        )
    }

    async fn run_workflow_turn(&self, request: WorkflowTurnRequest) -> Result<String, String> {
        match &self.executor {
            ExecutorMode::Stub => Ok(Self::stub_turn(&request)),
            ExecutorMode::Script(queue) => queue
                .lock()
                .expect("script queue")
                .pop_front()
                .ok_or_else(|| "devserver: --script ran out of executor responses".to_string()),
            ExecutorMode::Live(forced_model) => {
                let system = request.instruction.clone();
                let prompt = request
                    .task_context
                    .clone()
                    .unwrap_or_else(|| request.instruction.clone());
                let model = forced_model.clone().or_else(|| request.model_override.clone());
                tokio::task::spawn_blocking(move || {
                    crate::literature::run_oneshot_with_model(
                        &system,
                        runtime::ConversationMessage::user_text(prompt),
                        model.as_deref(),
                    )
                    .map(|(text, _model)| text)
                })
                .await
                .map_err(|error| error.to_string())?
            }
        }
    }

    async fn run_reviewer_oneshot(
        &self,
        system: String,
        prompt: String,
        action_id: String,
    ) -> Result<String, String> {
        // The reviewer path has no `AppHandle` dependency in the app either, so
        // this is the same call the packaged build makes.
        tokio::task::spawn_blocking(move || {
            crate::literature::run_review_oneshot_cancellable(&system, &prompt, Some(&action_id))
        })
        .await
        .map_err(|error| error.to_string())?
    }
}

/// Route one command to the controller function its `#[tauri::command]` shim
/// would have called.
async fn dispatch(ctx: &ServerCtx, command: &str, args: Value) -> Result<Value, String> {
    fn parse<T: for<'de> Deserialize<'de>>(args: &Value, field: &str) -> Result<T, String> {
        let value = args
            .get(field)
            .ok_or_else(|| format!("missing argument `{field}`"))?;
        serde_json::from_value(value.clone())
            .map_err(|error| format!("argument `{field}` is invalid: {error}"))
    }
    fn encode<T: Serialize>(value: T) -> Result<Value, String> {
        serde_json::to_value(value).map_err(|error| error.to_string())
    }

    match command {
        "review_workflows_list" => encode(crate::workflow::list_workflows(ctx)?),
        "review_workflow_load" => {
            encode(crate::workflow::load_workflow(ctx, &parse::<String>(&args, "id")?)?)
        }
        "review_workflow_create" => {
            encode(crate::workflow::create_workflow(ctx, parse(&args, "input")?)?)
        }
        // `review_workflow_save` accepts a whole run composed by the browser,
        // including reviewer gates. Stages that still have no Rust controller
        // fall back to a preview heuristic that auto-approves its own gate, and
        // against a real ledger that writes an approval nobody performed. The
        // ported stages all have proper controller commands, so this is refused
        // unless a caller explicitly opts in.
        "review_workflow_save" if !ctx.allow_run_save => Err(
            "devserver refuses `review_workflow_save`: it lets the browser write a whole run, \
             including reviewer gates it may have auto-approved locally. Use the controller \
             commands, or restart with --allow-run-save if you are deliberately testing this path."
                .to_string(),
        ),
        "review_workflow_save" => {
            encode(crate::workflow::save_workflow(ctx, parse(&args, "input")?)?)
        }
        "review_workflow_transcript" => encode(crate::workflow::workflow_transcript(
            ctx,
            &parse::<String>(&args, "runId")?,
        )?),
        "review_workflow_drive_once" => {
            encode(crate::workflow::drive_once(ctx, parse(&args, "input")?).await?)
        }
        "review_workflow_submit_scope_plan" => encode(crate::workflow::submit_scope_plan(
            ctx,
            parse(&args, "input")?,
        )?),
        "review_workflow_confirm_scope_plan" => encode(crate::workflow::confirm_scope_plan(
            ctx,
            parse(&args, "input")?,
        )?),
        "review_workflow_reset_scope_plan" => encode(crate::workflow::reset_scope_plan(
            ctx,
            parse(&args, "input")?,
        )?),
        "review_workflow_executor_turn" => {
            encode(crate::workflow::executor_turn(ctx, parse(&args, "input")?).await?)
        }
        "review_workflow_discuss" => {
            encode(crate::workflow::discuss(ctx, parse(&args, "input")?).await?)
        }
        "review_workflow_reviewer_turn" => {
            encode(crate::workflow::reviewer_turn(ctx, parse(&args, "input")?).await?)
        }
        "review_workflow_lease_acquire" => encode(crate::workflow::lease_acquire(
            ctx,
            &parse::<String>(&args, "id")?,
            &parse::<String>(&args, "ownerTurnId")?,
        )?),
        "review_workflow_lease_release" => encode(crate::workflow::lease_release(
            ctx,
            &parse::<String>(&args, "id")?,
            &parse::<String>(&args, "ownerTurnId")?,
        )?),
        "review_workflow_rename" => encode(crate::workflow::rename_workflow(
            ctx,
            &parse::<String>(&args, "id")?,
            &parse::<String>(&args, "title")?,
        )?),
        "review_workflow_delete" => {
            encode(crate::workflow::delete_workflow(ctx, &parse::<String>(&args, "id")?)?)
        }
        other => Err(format!(
            "devserver does not host `{other}`; it currently dispatches only the AppCtx-ported workflow commands"
        )),
    }
}

#[derive(Deserialize)]
struct EventQuery {
    #[serde(default)]
    since: u64,
}

async fn health(State(ctx): State<Arc<ServerCtx>>) -> Json<Value> {
    Json(json!({
        "ok": true,
        "workspace": ctx.workspace.to_string_lossy(),
        "projectId": ctx.project_id,
        "commands": COMMANDS,
    }))
}

async fn events(
    State(ctx): State<Arc<ServerCtx>>,
    Query(query): Query<EventQuery>,
) -> Json<Value> {
    let (pending, next) = ctx.events_since(query.since);
    Json(json!({ "events": pending, "next": next }))
}

/// Mirrors Tauri's `invoke` contract: a rejected command is still a successful
/// HTTP response carrying `err`, so the browser transport can reject the
/// promise exactly the way the webview would.
async fn invoke(
    State(ctx): State<Arc<ServerCtx>>,
    Path(command): Path<String>,
    body: Option<Json<Value>>,
) -> Json<Value> {
    let args = body.map_or_else(|| json!({}), |Json(value)| value);
    eprintln!("[devserver] invoke {command} {args}");
    match dispatch(&ctx, &command, args).await {
        Ok(value) => Json(json!({ "ok": value })),
        Err(error) => {
            eprintln!("[devserver]   -> error: {error}");
            Json(json!({ "err": error }))
        }
    }
}

fn router(ctx: Arc<ServerCtx>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/events", get(events))
        .route("/invoke/{command}", post(invoke))
        .layer(axum::middleware::from_fn(permissive_cors))
        .with_state(ctx)
}

/// The Vite dev server and this process are different origins, so the browser
/// preflights every `invoke`.  Loopback-only dev tooling can answer everything.
async fn permissive_cors(
    request: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::http::header::{
        ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS, ACCESS_CONTROL_ALLOW_ORIGIN,
    };
    let is_preflight = request.method() == axum::http::Method::OPTIONS;
    let mut response = if is_preflight {
        axum::response::Response::new(axum::body::Body::empty())
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, "*".parse().expect("origin"));
    headers.insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        "GET,POST,OPTIONS".parse().expect("methods"),
    );
    headers.insert(
        ACCESS_CONTROL_ALLOW_HEADERS,
        "content-type".parse().expect("headers"),
    );
    response
}

/// Parsed `aris-devserver` invocation.
pub struct Options {
    pub workspace: PathBuf,
    pub project_id: String,
    pub port: u16,
    pub executor: ExecutorMode,
    pub allow_run_save: bool,
}

impl Options {
    /// Reads `--project <path> [--project-id <id>] [--port <n>]
    /// [--executor stub|live] [--script <file>]`.
    pub fn from_args() -> Result<Self, String> {
        let mut workspace: Option<PathBuf> = None;
        let mut project_id: Option<String> = None;
        let mut port = 1421_u16;
        let mut executor = None;
        let mut script: Option<PathBuf> = None;
        let mut allow_run_save = false;
        let mut model: Option<String> = None;

        let mut args = std::env::args().skip(1);
        while let Some(flag) = args.next() {
            let mut value = || {
                args.next()
                    .ok_or_else(|| format!("`{flag}` needs a value"))
            };
            match flag.as_str() {
                "--project" => workspace = Some(PathBuf::from(value()?)),
                "--project-id" => project_id = Some(value()?),
                "--port" => {
                    port = value()?
                        .parse()
                        .map_err(|_| "`--port` must be a number".to_string())?;
                }
                "--executor" => executor = Some(value()?),
                "--script" => script = Some(PathBuf::from(value()?)),
                "--allow-run-save" => allow_run_save = true,
                "--model" => model = Some(value()?),
                "--help" | "-h" => return Err(usage()),
                other => return Err(format!("unknown flag `{other}`\n\n{}", usage())),
            }
        }

        let workspace = workspace.ok_or_else(|| format!("`--project` is required\n\n{}", usage()))?;
        if !workspace.is_dir() {
            return Err(format!(
                "`--project {}` is not a directory",
                workspace.display()
            ));
        }

        // Derived the same way the app derives it, so chat session storage for
        // this run lands where the packaged app would look for it.
        let project_id = project_id.unwrap_or_else(|| crate::projects::project_id(&workspace));
        if !crate::state::valid_project_id(&project_id) {
            return Err(format!(
                "`--project-id {project_id}` is not a valid project id (expected `default` or `project-<16 hex>`)"
            ));
        }

        if model.is_some() && executor.as_deref() != Some("live") {
            return Err("`--model` only applies to `--executor live`".to_string());
        }
        let executor = match (executor.as_deref(), script) {
            (Some("live"), _) => ExecutorMode::Live(model),
            (_, Some(path)) => {
                let raw = std::fs::read_to_string(&path)
                    .map_err(|error| format!("cannot read `{}`: {error}", path.display()))?;
                let responses = raw
                    .lines()
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    // A quoted line is a JSON string holding the response, which
                    // is how a captured multi-line model reply round-trips.
                    .map(|line| {
                        serde_json::from_str::<String>(line).unwrap_or_else(|_| line.to_string())
                    })
                    .collect();
                ExecutorMode::Script(Mutex::new(responses))
            }
            (Some("stub") | None, None) => ExecutorMode::Stub,
            (Some(other), None) => {
                return Err(format!("unknown `--executor {other}`; use stub or live"))
            }
        };

        Ok(Self {
            workspace,
            project_id,
            port,
            executor,
            allow_run_save,
        })
    }
}

fn usage() -> String {
    "aris-devserver — host the workflow controller over HTTP for browser-based debugging\n\n\
     USAGE:\n  \
       aris-devserver --project <dir> [--project-id <id>] [--port <n>] \\\n    \
         [--executor stub|live] [--script <file>] [--model <id>] [--allow-run-save]\n\n\
     `--model` forces the given model id for every live Executor turn, overriding\n\
     both the request's own model and the run's locked `executorModel`. Only valid\n\
     with `--executor live`.\n\n\
     Point the UI at it with:  npm run dev  →  http://127.0.0.1:1420/?devBackend=1"
        .to_string()
}

/// Serve until interrupted.
pub async fn serve(options: Options) -> Result<(), String> {
    // The same project activation the app performs when a project is selected.
    // Several kernel paths read the resulting environment (session storage
    // roots, the active-project guard) rather than taking it as an argument, so
    // skipping this makes the very first transcript append fail.
    crate::state::apply_project_environment(&options.workspace, &options.project_id)
        .map_err(|error| format!("cannot prepare project environment: {error}"))?;

    let addr = SocketAddr::from(([127, 0, 0, 1], options.port));
    let ctx = Arc::new(ServerCtx::new(
        options.workspace.clone(),
        options.project_id.clone(),
        options.executor,
        options.allow_run_save,
    ));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|error| format!("cannot bind {addr}: {error}"))?;
    eprintln!("[devserver] listening on http://{addr}");
    eprintln!("[devserver] project  {}", options.workspace.display());
    eprintln!("[devserver] open     http://127.0.0.1:1420/?devBackend=1");
    axum::serve(listener, router(ctx))
        .await
        .map_err(|error| error.to_string())
}
