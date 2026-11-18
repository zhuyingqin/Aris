//! Developer-only natural-language office runs using the real Desktop config,
//! assembled product prompt, shared Chat routing/runtime and production tools.
//! No API key leaves the process. This does not drive or certify the UI.
use runtime::{ToolError, ToolExecutor};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct RecordedTools {
    allowed: BTreeSet<String>,
    calls: Arc<Mutex<Vec<Value>>>,
    log: PathBuf,
}

impl ToolExecutor for RecordedTools {
    fn execute(&mut self, name: &str, input: &str) -> Result<String, ToolError> {
        self.execute_with_id("", name, input)
    }

    fn execute_with_id(&mut self, id: &str, name: &str, input: &str) -> Result<String, ToolError> {
        eprintln!("office agent tool: {name}");
        let value: Value =
            serde_json::from_str(input).map_err(|e| ToolError::new(e.to_string()))?;
        let started = Instant::now();
        let result = if self.allowed.contains(name) {
            tools::execute_tool_with_context(
                name,
                &value,
                tools::ToolRunContext::new(Some(id.to_string())),
            )
        } else {
            Err(
                "This office acceptance run only executes local document, file and audit tools."
                    .to_string(),
            )
        };
        let mut calls = self
            .calls
            .lock()
            .map_err(|_| ToolError::new("call log lock poisoned"))?;
        calls.push(json!({"toolUseId":id,"tool":name,"input":value,"elapsedMs":started.elapsed().as_millis(),
            "output":result.as_ref().ok(),"error":result.as_ref().err()}));
        fs::write(
            &self.log,
            serde_json::to_vec_pretty(&*calls).map_err(|e| ToolError::new(e.to_string()))?,
        )
        .map_err(|e| ToolError::new(e.to_string()))?;
        result.map_err(ToolError::new)
    }
}

fn snapshot_turn_artifacts(
    workspace: &Path,
    output: &Path,
    turn: usize,
    request: &Value,
) -> io::Result<Vec<Value>> {
    let mut snapshots = Vec::new();
    for (index, value) in request["snapshot_artifacts"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        let relative = Path::new(value.as_str().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "artifact path must be text")
        })?);
        if relative
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "artifact path must stay inside workspace",
            ));
        }
        let source = workspace.join(relative);
        if !source.is_file() {
            snapshots.push(json!({"relativePath":relative,"exists":false}));
            continue;
        }
        let source = fs::canonicalize(source)?;
        if !source.starts_with(workspace) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "artifact resolves outside workspace",
            ));
        }
        let folder = output.join(format!("turn-{turn}"));
        fs::create_dir_all(&folder)?;
        let name = relative.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "artifact filename required")
        })?;
        let snapshot = folder.join(format!("{}-{}", index + 1, name.to_string_lossy()));
        fs::write(&snapshot, fs::read(&source)?)?;
        snapshots.push(json!({"relativePath":relative,"sourcePath":source,"snapshotPath":snapshot,"exists":true}));
    }
    Ok(snapshots)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|a| a == "--describe") {
        println!("{}", aris_desktop_lib::memory_eval_bridge::describe());
        return Ok(());
    }
    let mut data = String::new();
    io::stdin().read_to_string(&mut data)?;
    let request: Value = serde_json::from_str(&data)?;
    let turns = if let Some(turns) = request["turns"].as_array() {
        turns
            .iter()
            .map(|turn| {
                turn.as_str()
                    .map(str::to_string)
                    .ok_or("turns must contain text")
            })
            .collect::<Result<Vec<_>, _>>()?
    } else {
        vec![request["request"]
            .as_str()
            .ok_or("request or turns required")?
            .to_string()]
    };
    if turns.is_empty() || turns.len() > 8 {
        return Err("supply 1-8 turns".into());
    }
    let workspace = fs::canonicalize(request["workspace"].as_str().ok_or("workspace required")?)?;
    let requested_output = PathBuf::from(
        request["evidence_directory"]
            .as_str()
            .ok_or("evidence_directory required")?,
    );
    let output = fs::canonicalize(
        requested_output
            .parent()
            .ok_or("evidence parent required")?,
    )?
    .join(
        requested_output
            .file_name()
            .ok_or("evidence directory name required")?,
    );
    if output.starts_with(&workspace) {
        return Err("evidence_directory must be outside the model workspace".into());
    }
    if output.exists() {
        return Err("use a fresh case workspace; evidence already exists".into());
    }
    fs::create_dir(&output)?;
    let context = runtime::ProjectExecutionContext::new(&workspace)
        .with_env("ARIS_WORKSPACE_ROOT", &workspace)
        .with_env("ARIS_SESSION_ID", "office-agent-acceptance");
    runtime::with_project_execution_context(
        &context,
        || -> Result<(), Box<dyn std::error::Error>> {
            let (model, provider, config) =
                aris_desktop_lib::memory_eval_bridge::configured_executor()?;
            let allowed: BTreeSet<String> = [
                "bash",
                "PowerShell",
                "read_file",
                "read_files",
                "ReadMediaFile",
                "write_file",
                "ToolSearch",
                "Skill",
                "WorkspaceLayout",
                "export_docx",
                "read_docx",
                "edit_docx",
                "format_docx",
                "edit_docx_structure",
                "delete_docx_paragraphs",
                "export_docx_pdf",
                "render_docx",
                "glob_search",
                "grep_search",
                "change_get",
                "change_list",
                "change_revert",
            ]
            .into_iter()
            .map(str::to_string)
            .collect();
            let catalog = aris_chat::chat_tool_specs(tools::mvp_tool_specs());
            let routing = aris_chat::route_chat_tools(
                &turns[0],
                &catalog,
                aris_chat::ToolRoutingMode::Active,
            );
            // Route the same builtin catalog as Desktop. The execution allowlist
            // bounds side effects, without hand-picking the model's visible tools.
            let specs = catalog;
            let policy = aris_chat::permission_policy_for_tools(
                specs.clone(),
                runtime::PermissionMode::WorkspaceWrite,
            );
            let sections = aris_desktop_lib::memory_eval_bridge::product_prompt_sections(
                &workspace.to_string_lossy(),
                false,
            );
            let prompt: Vec<String> = sections
                .as_array()
                .ok_or("invalid product prompt")?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            fs::write(
                output.join("system-prompt.json"),
                serde_json::to_vec_pretty(&prompt)?,
            )?;
            fs::write(output.join("tool-catalog.json"), serde_json::to_vec_pretty(&specs.iter().map(|s| json!({"name":s.name,"description":s.description,"inputSchema":s.input_schema})).collect::<Vec<_>>())?)?;
            let calls = Arc::new(Mutex::new(Vec::new()));
            let executor = RecordedTools {
                allowed,
                calls: calls.clone(),
                log: output.join("tool-calls.json"),
            };
            let mut chat = aris_chat::build_conversation_runtime(
                runtime::Session::new(),
                config,
                model.clone(),
                true,
                specs,
                Box::new(aris_executor::NoopStreamObserver),
                executor,
                policy,
                prompt,
                runtime::RuntimeFeatureConfig::default(),
                None,
                None,
            )?
            .with_max_iterations(32)
            .with_max_turn_duration(Some(Duration::from_secs(900)))
            .with_dynamic_tool_routing(routing.runtime_routing());
            let started = Instant::now();
            let mut outcomes = Vec::new();
            for (index, turn) in turns.iter().enumerate() {
                // Never expose a future user turn through a readable fixture/log.
                fs::write(
                    output.join("requests-presented.json"),
                    serde_json::to_vec_pretty(&turns[..=index])?,
                )?;
                let result = chat.run_turn(turn, None);
                let failed = result.is_err();
                let artifacts = snapshot_turn_artifacts(&workspace, &output, index + 1, &request)?;
                outcomes.push(json!({"conversationCompleted":result.is_ok(),
                "assistantText":result.as_ref().ok().map(aris_chat::final_assistant_text),
                "error":result.err().map(|error|error.to_string()),"artifacts":artifacts}));
                // Preserve every completed turn even if a later provider call fails.
                chat.session().save_to_path(output.join("session.json"))?;
                fs::write(
                    output.join("turns.json"),
                    serde_json::to_vec_pretty(&outcomes)?,
                )?;
                if failed {
                    break;
                }
            }
            chat.session().save_to_path(output.join("session.json"))?;
            fs::write(
                output.join("request.json"),
                serde_json::to_vec_pretty(&request)?,
            )?;
            let summary = json!({"model":model,"provider":provider,"sharedConversationRuntime":true,
            "harnessVersion":2,"evidenceOutsideWorkspace":true,"futureTurnsPersistedBeforePresentation":false,
            "desktopConfiguredConnection":true,"desktopProductPrompt":true,"productionTools":true,"uiAutomation":false,
            "catalogScope":"production builtin catalog with production dynamic routing; execution limited to local office/file/audit tools",
            "productionRoutingProfile":routing.profile,"initialActiveTools":routing.active_names,
            "elapsedMs":started.elapsed().as_millis(),
            "conversationCompleted":outcomes.len()==turns.len() && outcomes.iter().all(|turn|turn["conversationCompleted"]==true),
            "assistantText":outcomes.last().and_then(|turn|turn.get("assistantText")),
            "turns":outcomes,"toolCalls":calls.lock().map_err(|_|"call log lock poisoned")?.len(),
            "independentReviewer":"not_run","visualReview":"pending","wordWpsVerification":"not_run"});
            fs::write(
                output.join("summary.json"),
                serde_json::to_vec_pretty(&summary)?,
            )?;
            println!("{summary}");
            Ok(())
        },
    )
}
