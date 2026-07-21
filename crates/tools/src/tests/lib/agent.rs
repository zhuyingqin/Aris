use super::*;

#[test]
fn agent_persists_handoff_metadata() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = temp_path("agent-store");
    let _agent_store = EnvGuard::set("CLAWD_AGENT_STORE", &dir);
    let captured = Arc::new(Mutex::new(None::<AgentJob>));
    let captured_for_spawn = Arc::clone(&captured);

    let manifest = execute_agent_with_spawn(
        AgentInput {
            description: "Audit the branch".to_string(),
            prompt: "Check tests and outstanding work.".to_string(),
            subagent_type: Some("Explore".to_string()),
            name: Some("ship-audit".to_string()),
            model: None,
        },
        move |job| {
            *captured_for_spawn
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(job);
            Ok(())
        },
    )
    .expect("Agent should succeed");

    assert_eq!(manifest.name, "ship-audit");
    assert_eq!(manifest.subagent_type.as_deref(), Some("Explore"));
    assert_eq!(manifest.status, "running");
    assert!(!manifest.created_at.is_empty());
    assert!(manifest.started_at.is_some());
    assert!(manifest.completed_at.is_none());
    let contents = std::fs::read_to_string(&manifest.output_file).expect("agent file exists");
    let manifest_contents =
        std::fs::read_to_string(&manifest.manifest_file).expect("manifest file exists");
    assert!(contents.contains("Audit the branch"));
    assert!(contents.contains("Check tests and outstanding work."));
    assert!(manifest_contents.contains("\"subagentType\": \"Explore\""));
    assert!(manifest_contents.contains("\"status\": \"running\""));
    let captured_job = captured
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .expect("spawn job should be captured");
    assert_eq!(captured_job.prompt, "Check tests and outstanding work.");
    assert!(captured_job.allowed_tools.contains("read_file"));
    assert!(!captured_job.allowed_tools.contains("Agent"));

    let normalized = execute_tool(
        "Agent",
        &json!({
            "description": "Verify the branch",
            "prompt": "Check tests.",
            "subagent_type": "explorer"
        }),
    )
    .expect("Agent should normalize built-in aliases");
    let normalized_output: serde_json::Value =
        serde_json::from_str(&normalized).expect("valid json");
    assert_eq!(normalized_output["subagentType"], "Explore");

    let named = execute_tool(
        "Agent",
        &json!({
            "description": "Review the branch",
            "prompt": "Inspect diff.",
            "name": "Ship Audit!!!"
        }),
    )
    .expect("Agent should normalize explicit names");
    let named_output: serde_json::Value = serde_json::from_str(&named).expect("valid json");
    assert_eq!(named_output["name"], "ship-audit");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn agent_fake_runner_can_persist_completion_and_failure() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let dir = temp_path("agent-runner");
    // SomniQ sessions may set ARIS_AGENT_STORE_DIR globally. Set both the
    // canonical and legacy variables so this test owns the path it inspects.
    let _agent_store = EnvGuard::set(ARIS_AGENT_STORE_DIR_ENV, &dir);
    let _legacy_agent_store = EnvGuard::set("CLAWD_AGENT_STORE", &dir);

    let completed = execute_agent_with_spawn(
        AgentInput {
            description: "Complete the task".to_string(),
            prompt: "Do the work".to_string(),
            subagent_type: Some("Explore".to_string()),
            name: Some("complete-task".to_string()),
            model: Some("claude-sonnet-4-6".to_string()),
        },
        |job| {
            persist_agent_terminal_state(
                &job.manifest,
                "completed",
                Some("Finished successfully"),
                None,
                None,
            )
        },
    )
    .expect("completed agent should succeed");

    let completed_manifest =
        std::fs::read_to_string(&completed.manifest_file).expect("completed manifest should exist");
    let completed_output =
        std::fs::read_to_string(&completed.output_file).expect("completed output should exist");
    assert!(completed_manifest.contains("\"status\": \"completed\""));
    assert!(completed_output.contains("Finished successfully"));

    let failed = execute_agent_with_spawn(
        AgentInput {
            description: "Fail the task".to_string(),
            prompt: "Do the failing work".to_string(),
            subagent_type: Some("Verification".to_string()),
            name: Some("fail-task".to_string()),
            model: None,
        },
        |job| {
            persist_agent_terminal_state(
                &job.manifest,
                "failed",
                None,
                Some(String::from("simulated failure")),
                None,
            )
        },
    )
    .expect("failed agent should still spawn");

    let failed_manifest =
        std::fs::read_to_string(&failed.manifest_file).expect("failed manifest should exist");
    let failed_output =
        std::fs::read_to_string(&failed.output_file).expect("failed output should exist");
    assert!(failed_manifest.contains("\"status\": \"failed\""));
    assert!(failed_manifest.contains("simulated failure"));
    assert!(failed_output.contains("simulated failure"));

    let spawn_error = execute_agent_with_spawn(
        AgentInput {
            description: "Spawn error task".to_string(),
            prompt: "Never starts".to_string(),
            subagent_type: None,
            name: Some("spawn-error".to_string()),
            model: None,
        },
        |_| Err(String::from("thread creation failed")),
    )
    .expect_err("spawn errors should surface");
    assert!(spawn_error.contains("failed to spawn sub-agent"));
    let spawn_error_manifest = std::fs::read_dir(&dir)
        .expect("agent dir should exist")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .find_map(|path| {
            let contents = std::fs::read_to_string(&path).ok()?;
            contents
                .contains("\"name\": \"spawn-error\"")
                .then_some(contents)
        })
        .expect("failed manifest should still be written");
    assert!(spawn_error_manifest.contains("\"status\": \"failed\""));
    assert!(spawn_error_manifest.contains("thread creation failed"));

    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn agent_tool_subset_mapping_is_expected() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _env = EnvGuard::unset("ARIS_ALLOWED_TOOLS");
    let general = allowed_tools_for_subagent("general-purpose");
    assert!(general.contains("bash"));
    assert!(general.contains("write_file"));
    assert!(general.contains("append_file"));
    assert!(!general.contains("Agent"));
    assert!(general.contains("ListTeam"));

    let explore = allowed_tools_for_subagent("Explore");
    assert!(explore.contains("read_file"));
    assert!(explore.contains("grep_search"));
    assert!(!explore.contains("bash"));
    assert!(explore.contains("SendMessage"));

    let plan = allowed_tools_for_subagent("Plan");
    assert!(plan.contains("TodoWrite"));
    assert!(plan.contains("StructuredOutput"));
    assert!(!plan.contains("Agent"));

    let verification = allowed_tools_for_subagent("Verification");
    assert!(verification.contains("bash"));
    assert!(verification.contains("PowerShell"));
    assert!(!verification.contains("write_file"));
    assert!(!verification.contains("append_file"));
}

#[test]
fn file_tool_descriptions_preserve_existing_artifact_paths() {
    let specs = mvp_tool_specs();
    let description = |name: &str| {
        specs
            .iter()
            .find(|spec| spec.name == name)
            .unwrap_or_else(|| panic!("{name} spec should exist"))
            .description
    };

    assert!(description("write_file").contains("reuse the existing path"));
    assert!(description("write_file").contains("_v2"));
    assert!(description("write_file").contains("unless explicitly requested"));
    assert!(description("write_file").contains("read the target first"));
    assert!(description("write_file").contains("prefer edit_file"));
    assert!(description("append_file").contains("existing/current artifacts"));
    assert!(description("append_file").contains("long generated artifacts"));
    assert!(description("edit_file").contains("existing/current artifacts"));
    assert!(description("edit_file").contains("Read the target file first"));
    assert!(description("edit_file").contains("old_string should be unique"));
}

#[test]
fn shell_tool_descriptions_prefer_dedicated_tools_and_parallel_reads() {
    let specs = mvp_tool_specs();
    let description = |name: &str| {
        specs
            .iter()
            .find(|spec| spec.name == name)
            .unwrap_or_else(|| panic!("{name} spec should exist"))
            .description
    };

    for name in ["bash", "PowerShell"] {
        let desc = description(name);
        assert!(desc.contains("Prefer dedicated tools"));
        assert!(desc.contains("read_file"));
        assert!(desc.contains("glob_search"));
        assert!(desc.contains("grep_search"));
        assert!(desc.contains("edit_file"));
        assert!(desc.contains("run_in_background only for long-running services"));
        assert!(desc.contains("separate parallel tool calls"));
        assert!(desc.contains("chain commands only when they genuinely depend"));
    }
}

#[test]
fn inherited_allowed_tools_filter_subagent_and_coordination_tools() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let _env = EnvGuard::set(
        "ARIS_ALLOWED_TOOLS",
        "read_file,grep_search,ListTeam,CompleteTask",
    );

    let general = allowed_tools_for_subagent("general-purpose");

    assert!(general.contains("read_file"));
    assert!(general.contains("grep_search"));
    assert!(general.contains("ListTeam"));
    assert!(general.contains("CompleteTask"));
    assert!(!general.contains("bash"));
    assert!(!general.contains("PowerShell"));
    assert!(!general.contains("Workflow"));
    assert!(!general.contains("EnterWorktree"));
    assert!(!general.contains("AgentSupervisor"));
    assert!(!general.contains("SpawnTeammate"));
}

