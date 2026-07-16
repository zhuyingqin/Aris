use std::path::{Path, PathBuf};

use crate::{
    load_hot_memory, load_knowledge_memory_catalog, memory_write_approval_enabled,
    CompactionResult, ConfigLoader, ConfigSource, TokenUsage,
};

/// Environment details shown in the shared `/status` report.
#[derive(Debug, Clone)]
pub struct StatusContext {
    pub cwd: PathBuf,
    pub session_path: Option<PathBuf>,
    pub loaded_config_files: usize,
    pub discovered_config_files: usize,
    pub memory_file_count: usize,
    pub project_root: Option<PathBuf>,
    pub git_branch: Option<String>,
}

/// Usage details shown in the shared `/status` report.
#[derive(Debug, Clone, Copy)]
pub struct StatusUsage {
    pub message_count: usize,
    pub turns: u32,
    pub latest: TokenUsage,
    pub cumulative: TokenUsage,
    pub estimated_tokens: usize,
}

/// Render the stable, surface-independent `/status` report.
#[must_use]
pub fn format_status_report(
    model: &str,
    usage: StatusUsage,
    permission_mode: &str,
    context: &StatusContext,
    default_session_label: &str,
) -> String {
    [
        format!(
            "Status\n  Model            {model}\n  Permission mode  {permission_mode}\n  Messages         {}\n  Turns            {}\n  Estimated tokens {}",
            usage.message_count, usage.turns, usage.estimated_tokens,
        ),
        format!(
            "Usage\n  Latest total     {}\n  Cumulative input {}\n  Cumulative output {}\n  Cumulative total {}",
            usage.latest.total_tokens(),
            usage.cumulative.input_tokens,
            usage.cumulative.output_tokens,
            usage.cumulative.total_tokens(),
        ),
        format!(
            "Workspace\n  Cwd              {}\n  Project root     {}\n  Git branch       {}\n  Session          {}\n  Config files     loaded {}/{}\n  Memory files     {}",
            context.cwd.display(),
            context
                .project_root
                .as_ref()
                .map_or_else(|| "unknown".to_string(), |path| path.display().to_string()),
            context.git_branch.as_deref().unwrap_or("unknown"),
            context.session_path.as_ref().map_or_else(
                || default_session_label.to_string(),
                |path| path.display().to_string()
            ),
            context.loaded_config_files,
            context.discovered_config_files,
            context.memory_file_count,
        ),
    ]
    .join("\n\n")
}

/// Render the common `/config` report for an explicit workspace.
pub fn render_config_report(workspace: &Path, section: Option<&str>) -> Result<String, String> {
    let loader = ConfigLoader::default_for(workspace);
    let discovered = loader.discover();
    let runtime_config = loader.load().map_err(|error| error.to_string())?;

    let mut lines = vec![
        format!(
            "Config\n  Working directory {}\n  Loaded files      {}\n  Merged keys       {}",
            workspace.display(),
            runtime_config.loaded_entries().len(),
            runtime_config.merged().len(),
        ),
        "Discovered files".to_string(),
    ];
    for entry in discovered {
        let source = match entry.source {
            ConfigSource::User => "user",
            ConfigSource::Project => "project",
            ConfigSource::Local => "local",
        };
        let status = if runtime_config
            .loaded_entries()
            .iter()
            .any(|loaded_entry| loaded_entry.path == entry.path)
        {
            "loaded"
        } else {
            "missing"
        };
        lines.push(format!(
            "  {source:<7} {status:<7} {}",
            entry.path.display()
        ));
    }

    if let Some(section) = section {
        lines.push(format!("Merged section: {section}"));
        let value = match section {
            "env" => runtime_config.get("env"),
            "hooks" => runtime_config.get("hooks"),
            "model" => runtime_config.get("model"),
            other => {
                lines.push(format!(
                    "  Unsupported config section '{other}'. Use env, hooks, or model."
                ));
                return Ok(lines.join("\n"));
            }
        };
        lines.push(format!(
            "  {}",
            value.map_or_else(|| "<unset>".to_string(), |value| value.render())
        ));
        return Ok(lines.join("\n"));
    }

    lines.push("Merged JSON".to_string());
    lines.push(format!("  {}", runtime_config.as_json().render()));
    Ok(lines.join("\n"))
}

/// Render the common `/memory` report for an explicit workspace.
pub fn render_memory_report(workspace: &Path) -> Result<String, String> {
    let hot = load_hot_memory(workspace)?;
    let knowledge = load_knowledge_memory_catalog();
    let mut lines = vec![
        "Memory".to_string(),
        format!("  Working directory {}", workspace.display()),
        format!("  Project scope     {}", hot.project_scope),
        format!(
            "  Hot memory        memory={}/{} chars, user={}/{} chars",
            hot.memory_chars, hot.memory_limit, hot.user_chars, hot.user_limit
        ),
        format!("  Pending writes    {}", hot.pending_count),
        format!("  Write approval    {}", memory_write_approval_enabled()),
        format!("  Knowledge files   {}", knowledge.len()),
        "Hot entries".to_string(),
    ];
    for entry in hot.user.iter().chain(hot.memory.iter()) {
        lines.push(format!(
            "  [{}] {} scope={} source={} expires={}",
            entry.id,
            entry.content,
            entry.scope,
            entry.source,
            entry.expires_at.as_deref().unwrap_or("never")
        ));
    }
    if hot.user.is_empty() && hot.memory.is_empty() {
        lines.push("  No active hot-memory entries.".to_string());
    }
    lines.push("Knowledge catalog".to_string());
    for entry in knowledge {
        lines.push(format!(
            "  {} - {} ({})",
            entry.name,
            entry.description,
            entry.path.display()
        ));
    }
    Ok(lines.join("\n"))
}

/// Render the stable, surface-independent token-usage report used by `/cost`.
#[must_use]
pub fn format_cost_report(usage: TokenUsage) -> String {
    format!(
        "Cost\n  Input tokens     {}\n  Output tokens    {}\n  Cache create     {}\n  Cache read       {}\n  Total tokens     {}",
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_creation_input_tokens,
        usage.cache_read_input_tokens,
        usage.total_tokens(),
    )
}

/// Render the stable, surface-independent compaction report used by `/compact`.
#[must_use]
pub fn format_compact_report(result: &CompactionResult) -> String {
    let removed = result.removed_message_count;
    let resulting_messages = result.compacted_session.messages.len();
    if removed == 0 {
        return format!(
            "Compact\n  Result           skipped\n  Reason           no safe prefix or session below threshold\n  Messages kept    {resulting_messages}\n  Tokens before    {}\n  Tokens after     {}",
            result.tokens_before, result.tokens_after
        );
    }

    let saved = result.tokens_before.saturating_sub(result.tokens_after);
    format!(
        "Compact\n  Result           compacted\n  Summary source   {}\n  Token estimate   {}\n  Messages removed {removed}\n  Messages kept    {resulting_messages}\n  Tail preserved   {}\n  Tokens before    {}\n  Tokens after     {}\n  Tokens saved     {saved}",
        result.summary_source.as_str(),
        result.token_estimate_source.as_str(),
        result.preserved_message_count,
        result.tokens_before,
        result.tokens_after
    )
}

#[cfg(test)]
#[path = "tests/reports.rs"]
mod tests;
