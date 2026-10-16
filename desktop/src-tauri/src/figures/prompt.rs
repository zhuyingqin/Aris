//! Executor-authored image instructions, recorded before the image submission.
use super::*;

pub(super) struct CompiledPrompt {
    pub request_id: String,
    pub prompt: String,
    pub title: Option<String>,
}

pub(super) fn executor(run: &FigureRun) -> Result<workflow::FigureExecutor, String> {
    let (executor, _) =
        crate::engine::figure_connections(Some(&run.executor.model), Some(&run.reviewer.model))?;
    if executor.identity != run.executor {
        return Err(
            "Executor connection changed; create a new task before submitting requests".into(),
        );
    }
    Ok(executor)
}

pub(super) fn compile_once(
    workspace: &Path,
    run: &FigureRun,
    kind: &str,
    request: runtime::ApiRequest,
    cancelled: &AtomicBool,
    perform: impl FnOnce(runtime::ApiRequest) -> Result<ModelReply, String>,
    notify: impl Fn(),
) -> Result<CompiledPrompt, String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("Task cancelled before prompt planning".into());
    }
    let request_id = format!(
        "request-{:02}",
        store::load(workspace, &run.id)?.requests.len() + 1
    );
    let blocks: Vec<Value> = request
        .messages
        .iter()
        .flat_map(|m| &m.blocks)
        .map(|block| match block {
            runtime::ContentBlock::Text { text } => json!({"type": "text", "text": text}),
            runtime::ContentBlock::Image { media_type, data } => {
                json!({"type": "image", "mediaType": media_type, "data": data})
            }
            _ => Value::Null,
        })
        .collect();
    let dir = store::directory(workspace, &run.id)?;
    runtime::write_file_atomically(&dir.join(format!("{request_id}.prompt-input.json")),
        serde_json::to_vec_pretty(&json!({"systemPrompt": request.system_prompt, "content": blocks, "identity": run.executor, "maxOutputTokens": run.output_limit})).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    store::update(workspace, &run.id, |current| {
        current.status = if kind == "manual_image_prompt" {
            "planning_image_edit"
        } else {
            "planning_image"
        }
        .into();
        current.error = None;
        Ok(())
    })?;
    let reply = call(
        workspace,
        &run.id,
        kind,
        "executor",
        run.executor.clone(),
        run.output_limit,
        || {
            // call() records submitted before this closure runs.
            notify();
            perform(request)
        },
    )?;
    if is_budget_truncated(reply.stop_reason.as_deref())
        || matches!(
            reply.stop_reason.as_deref(),
            Some("stream_truncated" | "stream_error_after_partial_output")
        )
    {
        return Err("Executor image prompt was incomplete; raw output is saved, no image request was sent and nothing will be retried automatically".into());
    }
    let prompt = match workflow::parse_image_prompt(&reply.text) {
        Ok(prompt) => prompt,
        Err(error) => {
            store::update(workspace, &run.id, |current| {
                let entry = current
                    .requests
                    .iter_mut()
                    .find(|entry| entry.id == request_id)
                    .ok_or("Missing prompt request")?;
                entry.status = "failed".into();
                entry.error = Some(error.clone());
                Ok(())
            })?;
            return Err(error);
        }
    };
    runtime::write_file_atomically(
        &dir.join(format!("{request_id}.image-prompt.txt")),
        &prompt.prompt,
    )
    .map_err(|e| e.to_string())?;
    if cancelled.load(Ordering::SeqCst) {
        return Err("Task cancelled after prompt planning; no image request was sent".into());
    }
    Ok(CompiledPrompt {
        request_id,
        prompt: prompt.prompt,
        title: prompt.title,
    })
}

pub(super) fn generate_once(
    workspace: &Path,
    run: &FigureRun,
    cancelled: &AtomicBool,
    perform: impl FnOnce(runtime::ApiRequest) -> Result<ModelReply, String>,
    send: impl FnOnce(String) -> Result<Value, String>,
    notify: impl Fn(),
) -> Result<Value, String> {
    let request = workflow::image_prompt_request(
        json!({"action": "generate", "requirements": run.method, "style": run.style}),
        vec![],
    );
    let compiled = compile_once(
        workspace,
        run,
        "plan_image",
        request,
        cancelled,
        perform,
        &notify,
    )?;
    let identity = run
        .image_identity
        .clone()
        .ok_or("Missing image connection")?;
    let next_id = format!(
        "request-{:02}",
        store::load(workspace, &run.id)?.requests.len() + 1
    );
    runtime::write_file_atomically(&store::directory(workspace, &run.id)?.join(format!("{next_id}.generation-input.json")),
        serde_json::to_vec_pretty(&json!({"prompt": compiled.prompt, "title": compiled.title, "promptRequestId": compiled.request_id, "identity": identity})).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if cancelled.load(Ordering::SeqCst) {
        return Err("Task cancelled before image generation".into());
    }
    let request = store::begin_request(workspace, &run.id, "generate_image", "image", identity, 0)?;
    store::update(workspace, &run.id, |current| {
        if let Some(title) = &compiled.title {
            current.title = title.clone();
        }
        current.status = "generating".into();
        Ok(())
    })?;
    notify();
    let started = Instant::now();
    let result = send(compiled.prompt);
    store::update(workspace, &run.id, |current| {
        let entry = current
            .requests
            .iter_mut()
            .find(|r| r.id == request.id)
            .ok_or("Missing image request")?;
        entry.status = match &result {
            Ok(_) => "completed",
            Err(error) if known_rejection(error) => "failed",
            Err(_) => "unknown",
        }
        .into();
        entry.error = result.as_ref().err().cloned();
        entry.usage = result
            .as_ref()
            .ok()
            .and_then(|output| output.get("usage").cloned());
        entry.finished_at = Some(runtime::now_iso8601());
        entry.duration_ms = started.elapsed().as_millis() as u64;
        Ok(())
    })?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn fixture(workspace: &Path) -> FigureRun {
        let run: FigureRun = serde_json::from_value(json!({
            "schemaVersion": 1, "id": "d".repeat(32), "title": "Generate", "method": "AR and MA inside reservoir", "style": "paper", "sourceMode": "generate", "sourceMime": null, "sourceHash": null,
            "status": "ready", "outputLimit": 0, "executor": ModelIdentity::default(), "reviewer": ModelIdentity::default(), "imageIdentity": ModelIdentity::default(),
            "executorVision": false, "reviewerVision": false, "revisionUsed": false, "versions": [], "requests": [], "review": null, "error": null, "createdAt": "now", "updatedAt": "now"
        })).unwrap();
        store::create(workspace, run, None).unwrap()
    }

    #[test]
    fn generation_records_executor_before_sending_its_prompt_to_image_model() {
        let workspace = tempfile::tempdir().unwrap();
        let run = fixture(workspace.path());
        let order = RefCell::new(Vec::new());
        let output = generate_once(workspace.path(), &run, &AtomicBool::new(false), |request| {
            order.borrow_mut().push("executor");
            assert!(matches!(&request.messages[0].blocks[0], runtime::ContentBlock::Text { text } if text.contains("AR and MA inside reservoir")));
            assert_eq!(store::load(workspace.path(), &run.id).unwrap().requests[0].status, "submitted");
            Ok(ModelReply { text: r#"{"title":"ESN-ARMA 流程图","prompt":"Draw AR and MA together inside the reservoir, with labeled arrows."}"#.into(), usage: Some(runtime::TokenUsage { input_tokens: 100, output_tokens: 20, ..Default::default() }), ..Default::default() })
        }, |prompt| {
            order.borrow_mut().push("image");
            assert!(prompt.starts_with("Draw AR and MA together"));
            let current = store::load(workspace.path(), &run.id).unwrap();
            assert_eq!(current.requests[0].status, "completed");
            assert_eq!(current.requests[1].status, "submitted");
            assert_eq!(current.title, "ESN-ARMA 流程图");
            assert_eq!(current.method, run.method);
            Ok(json!({"usage": {"total_tokens": 5}}))
        }, || {}).unwrap();
        assert_eq!(*order.borrow(), ["executor", "image"]);
        assert_eq!(output["usage"]["total_tokens"], 5);
        let recorded = store::load(workspace.path(), &run.id).unwrap();
        assert_eq!(recorded.requests.len(), 2);
        assert_eq!(recorded.requests[0].kind, "plan_image");
        assert_eq!(recorded.requests[0].max_output_tokens, 0);
        assert_eq!(
            recorded.requests[0].usage.as_ref().unwrap()["outputTokens"],
            20
        );
        assert_eq!(recorded.requests[1].kind, "generate_image");
        let input: Value = serde_json::from_slice(
            &store::read_artifact(
                workspace.path(),
                &run.id,
                "request-02.generation-input.json",
                10000,
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(input["promptRequestId"], "request-01");
        assert_eq!(input["title"], "ESN-ARMA 流程图");
        assert!(input["prompt"].as_str().unwrap().starts_with("Draw AR"));
    }

    #[test]
    fn rejected_unknown_invalid_truncated_or_cancelled_plans_never_generate_images() {
        for mode in [
            "rejected",
            "unknown",
            "invalid",
            "invalid_title",
            "truncated",
            "cancelled",
        ] {
            let workspace = tempfile::tempdir().unwrap();
            let run = fixture(workspace.path());
            let cancelled = AtomicBool::new(false);
            let result = generate_once(
                workspace.path(),
                &run,
                &cancelled,
                |_| {
                    if mode == "rejected" {
                        return Err("HTTP 400: fixture rejected prompt".into());
                    }
                    if mode == "unknown" {
                        return Err("connection closed".into());
                    }
                    if mode == "cancelled" {
                        cancelled.store(true, Ordering::SeqCst);
                    }
                    Ok(ModelReply {
                        text: if mode == "invalid" {
                            "not JSON"
                        } else if mode == "invalid_title" {
                            r#"{"title":"","prompt":"Draw the figure."}"#
                        } else {
                            r#"{"prompt":"Draw the figure."}"#
                        }
                        .into(),
                        stop_reason: (mode == "truncated").then(|| "max_tokens".into()),
                        ..Default::default()
                    })
                },
                |_| panic!("Image model must not be called after {mode} planning"),
                || {},
            );
            assert!(result.is_err());
            let recorded = store::recover(workspace.path(), &run.id).unwrap();
            assert_eq!(recorded.requests.len(), 1);
            assert_eq!(recorded.title, run.title);
            if mode == "invalid_title" {
                assert_eq!(recorded.requests[0].status, "failed");
            }
            if mode == "invalid" {
                assert_eq!(recorded.requests[0].status, "failed");
                assert!(recorded.requests[0]
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("valid image prompt"));
            }
            assert!(!recorded.can_start());
            assert_eq!(
                recorded.status,
                if mode == "unknown" {
                    "unknown"
                } else {
                    "draft"
                }
            );
        }
    }
}
