use super::*;

#[test]
fn skill_loads_local_skill_prompt() {
    // Create a temporary skill directory
    let tmp = std::env::temp_dir().join(format!("aris-skill-test-{}", std::process::id()));
    let skill_dir = tmp.join("test-skill");
    fs::create_dir_all(&skill_dir).expect("create skill dir");
    fs::write(
            skill_dir.join("SKILL.md"),
            "---\nname: test-skill\ndescription: \"A test skill\"\n---\n\n# Test Skill\n\nThis is a test skill prompt.",
        )
        .expect("write SKILL.md");

    // Point HOME/USERPROFILE to temp dir so ~/.config/SomniQ/skills resolves there.
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let aris_home = tmp.parent().unwrap().join("somniq-home");
    let aris_skills = aris_home.join(".config").join("SomniQ").join("skills");
    let _home_guard = EnvGuard::set("HOME", &aris_home);
    let _userprofile_guard = EnvGuard::set("USERPROFILE", &aris_home);
    let _claude_compat_guard = EnvGuard::unset("ARIS_ENABLE_CLAUDE_SKILLS");
    fs::create_dir_all(&aris_skills).expect("create SomniQ skills dir");

    // Copy the skill into the SomniQ skills dir.
    let target_skill = aris_skills.join("test-skill");
    fs::create_dir_all(&target_skill).expect("create target skill dir");
    fs::copy(skill_dir.join("SKILL.md"), target_skill.join("SKILL.md")).expect("copy skill");

    let result = execute_tool(
        "Skill",
        &json!({
            "skill": "test-skill",
            "args": "overview"
        }),
    )
    .expect("Skill should succeed");

    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    assert_eq!(output["skill"], "test-skill");
    assert!(output["path"]
        .as_str()
        .expect("path")
        .ends_with("/test-skill/SKILL.md"));
    assert!(output["prompt"]
        .as_str()
        .expect("prompt")
        .contains("This is a test skill prompt"));

    // Test $skill form
    let dollar_result = execute_tool(
        "Skill",
        &json!({
            "skill": "$test-skill"
        }),
    )
    .expect("Skill should accept $skill invocation form");
    let dollar_output: serde_json::Value =
        serde_json::from_str(&dollar_result).expect("valid json");
    assert_eq!(dollar_output["skill"], "$test-skill");
    assert!(dollar_output["path"]
        .as_str()
        .expect("path")
        .ends_with("/test-skill/SKILL.md"));

    // Cleanup
    let _ = fs::remove_dir_all(&tmp);
    let _ = fs::remove_dir_all(&aris_home);
}

#[test]
fn claude_skills_require_explicit_compat_flag() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let tmp = temp_path("legacy-claude-skills");
    let home = tmp.join("home");
    let claude_skills = home.join(".claude").join("skills");
    let _home_guard = EnvGuard::set("HOME", &home);
    let _userprofile_guard = EnvGuard::set("USERPROFILE", &home);
    let _codex_home_guard = EnvGuard::unset("CODEX_HOME");
    let _claude_compat_guard = EnvGuard::unset("ARIS_ENABLE_CLAUDE_SKILLS");
    fs::create_dir_all(&claude_skills).expect("create claude skills dir");
    let target_skill = claude_skills.join("legacy-claude-only");
    fs::create_dir_all(&target_skill).expect("create target skill dir");
    fs::write(
            target_skill.join("SKILL.md"),
            "---\nname: legacy-claude-only\ndescription: \"Legacy Claude skill\"\n---\n\n# Legacy Claude Skill\n",
        )
        .expect("write legacy skill");

    assert!(
        skill_markdown("legacy-claude-only").is_none(),
        "Claude Code skills should not be visible by default"
    );

    let _claude_compat_enabled = EnvGuard::set("ARIS_ENABLE_CLAUDE_SKILLS", "1");
    let markdown = skill_markdown("legacy-claude-only")
        .expect("legacy Claude skill should load when compat is enabled");
    assert!(markdown.contains("# Legacy Claude Skill"));

    let result = execute_tool(
        "Skill",
        &json!({
            "skill": "legacy-claude-only"
        }),
    )
    .expect("legacy Claude skill should execute when compat is enabled");
    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    let expected_path = target_skill
        .join("SKILL.md")
        .display()
        .to_string()
        .replace('\\', "/");
    assert_eq!(output["path"].as_str().expect("path"), expected_path);

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn bundled_skill_is_discoverable_and_invokable() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let tmp = temp_path("bundled-skill-home");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).expect("create isolated home");
    let _home = EnvGuard::set("HOME", &tmp);
    let _userprofile = EnvGuard::set("USERPROFILE", &tmp);
    let _codex_home = EnvGuard::unset("CODEX_HOME");

    let skills = discover_skills();
    assert!(
        skills.iter().any(|skill| skill.name == "research-lit"),
        "research-lit should be listed among bundled skills"
    );

    let markdown = skill_markdown("research-lit").expect("bundled skill markdown");
    assert!(markdown.contains("# Literature Search"));
    assert!(markdown.contains("legacy alias `research-lit`"));

    let result = execute_tool(
        "Skill",
        &json!({
            "skill": "research-lit",
            "args": "reservoir computing"
        }),
    )
    .expect("bundled Skill should load");
    let output: serde_json::Value = serde_json::from_str(&result).expect("valid json");
    assert_eq!(output["skill"], "research-lit");
    assert_eq!(output["path"], "<bundled:literature-search>");
    assert_eq!(output["args"], "reservoir computing");
    assert!(output["prompt"]
        .as_str()
        .expect("prompt")
        .contains("# Literature Search"));
    assert!(output["prompt"]
        .as_str()
        .expect("prompt")
        .contains("legacy alias `research-lit`"));

    let literature_search = skill_markdown("literature-search").expect("canonical skill markdown");
    assert!(literature_search.contains("# Literature Search"));
    assert!(literature_search.contains("LiteratureSearchPreview"));
    assert!(skill_markdown("literature-screen")
        .expect("screen skill markdown")
        .contains("# Literature Screen"));
    assert!(skill_markdown("literature-evidence")
        .expect("evidence skill markdown")
        .contains("# Literature Evidence"));

    let _ = fs::remove_dir_all(&tmp);
}

/// An activated alias never executes its own `SKILL.md`, so the listing must
/// not advertise that file's frontmatter. Before this, `/skills list` described
/// `/scopus-search` as an elsapy export pipeline and `/arxiv` as an arXiv
/// download workflow, while invoking either ran the canonical protocol
/// workflow.
///
/// An alias whose directory has been retired from the bundle drops out of the
/// listing entirely — but `resolve_skill_path` still redirects it, so typing the
/// old name keeps working. Both shapes are checked below.
#[test]
fn activated_aliases_are_listed_as_what_they_actually_run() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let tmp = temp_path("alias-listing-home");
    let _ = fs::remove_dir_all(&tmp);
    fs::create_dir_all(&tmp).expect("create isolated home");
    let _home = EnvGuard::set("HOME", &tmp);
    let _userprofile = EnvGuard::set("USERPROFILE", &tmp);
    let _codex_home = EnvGuard::unset("CODEX_HOME");

    let skills = discover_skills();
    let by_name = |name: &str| {
        skills
            .iter()
            .find(|skill| skill.name == name)
            .unwrap_or_else(|| panic!("{name} should be listed"))
    };

    let canonical = by_name("literature-search");
    let canonical_description = canonical
        .description
        .clone()
        .expect("canonical description");

    for (alias, profile) in [("research-lit", "default"), ("arxiv", "arxiv")] {
        let listed = by_name(alias);
        let description = listed.description.as_deref().expect("alias description");
        assert!(
            description.starts_with(&format!(
                "Alias of /literature-search (profile: {profile})."
            )),
            "{alias}: {description}"
        );
        assert!(description.contains(&canonical_description), "{alias}");
        // The alias must advertise the canonical tool surface, not its own.
        assert_eq!(listed.allowed_tools, canonical.allowed_tools, "{alias}");
        assert_eq!(listed.path, canonical.path, "{alias}");
    }

    // Retired alias directories: no listing entry, but the name still resolves
    // to the canonical workflow so existing muscle memory doesn't break.
    for alias in ["scopus-search", "comm-lit-review"] {
        assert!(
            !skills.iter().any(|skill| skill.name == alias),
            "{alias}: retired alias must not be listed"
        );
        assert_eq!(
            runtime::activated_canonical_skill_name(alias),
            Some("literature-search"),
            "{alias}: retired alias must still redirect"
        );
    }

    // The directory name is the invocable identity. `comm-lit-review` declares a
    // different frontmatter `name:`, which used to be listed as
    // `comm-lit-review-claude-single` — a name no resolver accepts.
    assert!(
        !skills
            .iter()
            .any(|skill| skill.name == "comm-lit-review-claude-single"),
        "an uninvokable frontmatter name must not be listed"
    );

    // A Planned entry is not activated, so it keeps its own implementation.
    let novelty = by_name("novelty-check");
    assert!(
        !novelty
            .description
            .as_deref()
            .unwrap_or_default()
            .starts_with("Alias of"),
        "novelty-check is Planned, not Active"
    );

    let _ = fs::remove_dir_all(&tmp);
}

#[test]
fn tool_search_supports_keyword_and_select_queries() {
    let keyword = execute_tool(
        "ToolSearch",
        &json!({"query": "web current", "max_results": 3}),
    )
    .expect("ToolSearch should succeed");
    let keyword_output: serde_json::Value = serde_json::from_str(&keyword).expect("valid json");
    let matches = keyword_output["matches"].as_array().expect("matches");
    assert!(matches.iter().any(|value| value == "WebSearch"));

    let selected = execute_tool("ToolSearch", &json!({"query": "select:Agent,Skill"}))
        .expect("ToolSearch should succeed");
    let selected_output: serde_json::Value = serde_json::from_str(&selected).expect("valid json");
    assert_eq!(selected_output["matches"][0], "Agent");
    assert_eq!(selected_output["matches"][1], "Skill");

    let aliased = execute_tool("ToolSearch", &json!({"query": "AgentTool"}))
        .expect("ToolSearch should support tool aliases");
    let aliased_output: serde_json::Value = serde_json::from_str(&aliased).expect("valid json");
    assert_eq!(aliased_output["matches"][0], "Agent");
    assert_eq!(aliased_output["normalized_query"], "agent");

    let selected_with_alias =
        execute_tool("ToolSearch", &json!({"query": "select:AgentTool,Skill"}))
            .expect("ToolSearch alias select should succeed");
    let selected_with_alias_output: serde_json::Value =
        serde_json::from_str(&selected_with_alias).expect("valid json");
    assert_eq!(selected_with_alias_output["matches"][0], "Agent");
    assert_eq!(selected_with_alias_output["matches"][1], "Skill");
}
