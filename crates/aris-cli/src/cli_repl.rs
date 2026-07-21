//! The interactive REPL loop (`run_repl`), extracted from main.rs.
//! It orchestrates most CLI helpers, so it imports the crate-root symbol
//! set via `use crate::*` — the same environment it had inline. Macros,
//! which globs do not re-export, are imported explicitly.

#[allow(clippy::wildcard_imports)]
use crate::*;
use serde_json::json;

pub(crate) fn run_repl(
    model: String,
    allowed_tools: Option<AllowedToolSet>,
    permission_mode: PermissionMode,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut cli = LiveCli::new(model, true, allowed_tools, permission_mode)?;
    let mut editor = input::LineEditor::new(
        "\x1b[38;5;74m❯\x1b[0m ",
        slash_command_completion_candidates(),
    );

    // Install Ctrl+C handler: set runtime interrupt flag instead of killing the process
    let _ = ctrlc::set_handler(|| {
        runtime::set_interrupt();
    });

    println!("{}", cli.startup_banner());

    loop {
        match editor.read_line()? {
            input::ReadOutcome::Submit(input) => {
                let trimmed = input.trim().to_string();
                if trimmed.is_empty() {
                    continue;
                }
                if matches!(trimmed.as_str(), "/exit" | "/quit") {
                    cli.persist_session()?;
                    break;
                }
                if let Some(command) = SlashCommand::parse(&trimmed) {
                    // Clear interrupt flag before command
                    runtime::clear_interrupt();
                    match cli.handle_repl_command(command) {
                        Ok(persist) => {
                            if persist {
                                let _ = cli.persist_session();
                            }
                        }
                        Err(e) => {
                            if runtime::is_interrupted() {
                                eprintln!("\n\x1b[38;5;208m● Interrupted\x1b[0m");
                            } else {
                                eprintln!("\n\x1b[38;5;203m● Error:\x1b[0m {e}");
                            }
                            runtime::clear_interrupt();
                        }
                    }
                    continue;
                }
                editor.push_history(input);
                // Visual separator before assistant response
                let term_w = crossterm::terminal::size()
                    .map(|(w, _)| w as usize)
                    .unwrap_or(80);
                let sep = "─".repeat(term_w.min(80));
                println!("\x1b[38;5;240m{sep}\x1b[0m");
                // Clear interrupt flag before starting
                runtime::clear_interrupt();
                if let Err(e) = cli.run_turn(&trimmed) {
                    if runtime::is_interrupted() {
                        eprintln!("\n\x1b[38;5;208m● Interrupted\x1b[0m");
                    } else {
                        eprintln!("\n\x1b[38;5;203m● Error:\x1b[0m {e}");
                    }
                    runtime::clear_interrupt();
                    // Don't exit REPL — let user retry or switch model
                }
            }
            input::ReadOutcome::Cancel => {}
            input::ReadOutcome::Exit => {
                cli.persist_session()?;
                break;
            }
        }
    }

    Ok(())
}

pub(crate) struct LiveCli {
    model: String,
    reviewer_model: String,
    allowed_tools: Option<AllowedToolSet>,
    permission_mode: PermissionMode,
    system_prompt: Vec<String>,
    runtime: ConversationRuntime<aris_executor::ExecutorClient, CliToolExecutor>,
    session: SessionHandle,
    /// Plan mode state: stores original permissions/tools before entering plan mode.
    plan_mode: Option<PlanModeState>,
    /// Set once we've fallen back from DEFAULT_MODEL (Opus 4.8) to
    /// DEFAULT_MODEL_FALLBACK (4.7) because 4.8 was unavailable. Latches the
    /// fallback for the session and prevents a retry loop.
    model_fell_back: bool,
}

#[derive(Debug, Clone)]
struct PlanModeState {
    previous_permission_mode: PermissionMode,
    previous_allowed_tools: Option<AllowedToolSet>,
}

impl LiveCli {
    pub(crate) fn new(
        model: String,
        enable_tools: bool,
        allowed_tools: Option<AllowedToolSet>,
        permission_mode: PermissionMode,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let system_prompt = build_system_prompt(Some(&model))?;
        let session = create_managed_session_handle()?;
        set_coordination_context_env(&session.id, allowed_tools.as_ref(), permission_mode);
        let runtime = build_runtime(
            Session::new(),
            model.clone(),
            system_prompt.clone(),
            enable_tools,
            true,
            allowed_tools.clone(),
            permission_mode,
        )?;
        // Determine default reviewer model. saved_config.apply_to_env() runs
        // BEFORE this point in run(), so when a user has persisted
        // reviewer_model in config.json we read it back via the
        // ARIS_REVIEWER_MODEL env var. The fallback only fires when no model
        // has been persisted (first run / config load failed).
        //
        // v0.4.8: when the user has a Custom reviewer provider configured
        // (ARIS_REVIEWER_PROVIDER=custom + auth token), don't fall back to
        // gpt-5.5 — that's surely the wrong default for a custom proxy. Warn
        // and leave the field empty so LlmReview's Custom branch hard-errors
        // with a clear message instead of silently routing to gpt-5.5.
        let has_custom_reviewer_provider = std::env::var("ARIS_REVIEWER_PROVIDER").as_deref()
            == Ok("custom")
            && std::env::var("ARIS_REVIEWER_AUTH_TOKEN").is_ok();
        let reviewer_model = std::env::var("ARIS_REVIEWER_MODEL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                if has_custom_reviewer_provider {
                    eprintln!(
                        "\x1b[33mwarning:\x1b[0m custom reviewer provider configured but \
                         model name is empty in config. Run /setup or /reviewer <model-name>."
                    );
                    String::new()
                } else if std::env::var("GEMINI_API_KEY").is_ok() {
                    "gemini-2.5-pro".to_string()
                } else {
                    "gpt-5.5".to_string()
                }
            });
        std::env::set_var("ARIS_REVIEWER_MODEL", &reviewer_model);
        let cli = Self {
            model,
            reviewer_model,
            allowed_tools,
            permission_mode,
            system_prompt,
            runtime,
            session,
            plan_mode: None,
            model_fell_back: false,
        };
        cli.persist_session()?;
        Ok(cli)
    }

    fn startup_banner(&self) -> String {
        let cwd = env::current_dir().map_or_else(
            |_| "<unknown>".to_string(),
            |path| path.display().to_string(),
        );

        // ── Pixel sprites (13 wide × 12 tall → 13 cols × 6 terminal lines) ──
        // Designed to match ARIS GitHub banner pixel art as closely as possible.
        // Half-block rendering: rows 0+1, 2+3, 4+5, 6+7, 8+9, 10+11 → 6 lines
        //
        // 0=transparent 1=brown-hair 2=skin 3=black 4=blue 5=khaki 6=olive 7=unused 8=dark-gray
        const CLAUDE: [[u8; 13]; 12] = [
            [0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0], // hair top
            [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0], // hair wider
            [0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0], // face
            [0, 0, 2, 2, 3, 2, 2, 2, 3, 2, 2, 0, 0], // eyes
            [0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0], // face
            [0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0], // chin
            [0, 2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 2, 0], // arms + shirt top
            [0, 2, 4, 4, 4, 4, 4, 4, 4, 4, 4, 2, 0], // arms + shirt
            [0, 0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 0, 0], // shirt body
            [0, 0, 4, 4, 4, 4, 4, 4, 4, 4, 4, 0, 0], // shirt lower
            [0, 0, 0, 3, 3, 0, 0, 0, 3, 3, 0, 0, 0], // legs
            [0, 0, 0, 3, 3, 0, 0, 0, 3, 3, 0, 0, 0], // shoes
        ];
        const GPT: [[u8; 13]; 12] = [
            [0, 0, 8, 8, 8, 8, 8, 8, 8, 8, 8, 0, 0], // hat
            [0, 0, 8, 8, 8, 8, 8, 8, 8, 8, 8, 0, 0], // hat
            [0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0], // face
            [0, 0, 2, 3, 3, 2, 2, 2, 3, 3, 2, 0, 0], // sunglasses: 2px + gap + 2px
            [0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0], // face below
            [0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0], // chin
            [0, 2, 6, 6, 6, 6, 6, 6, 6, 6, 6, 2, 0], // arms + shirt
            [0, 2, 6, 6, 6, 6, 6, 6, 6, 6, 6, 2, 0], // arms + shirt
            [0, 0, 6, 6, 6, 6, 6, 6, 6, 6, 6, 0, 0], // shirt body
            [0, 0, 6, 6, 6, 6, 6, 6, 6, 6, 6, 0, 0], // shirt lower
            [0, 0, 0, 3, 3, 0, 0, 0, 3, 3, 0, 0, 0], // legs
            [0, 0, 0, 3, 3, 0, 0, 0, 3, 3, 0, 0, 0], // shoes
        ];
        // ANSI 256-color per index (None = terminal background)
        const COLOR: [Option<u8>; 9] = [
            None,      // 0 transparent
            Some(137), // 1 warm brown hair (Claude) - #af875f
            Some(223), // 2 skin/peach - #ffd7af
            Some(233), // 3 near-black (eyes, glasses, shoes) - #121212
            Some(74),  // 4 medium blue shirt (Claude) - #5fafd7
            Some(101), // 5 khaki pants - #87875f
            Some(65),  // 6 olive shirt (GPT) - #5f875f
            Some(217), // 7 mouth - #ffafaf (light pink)
            Some(240), // 8 dark gray hat (GPT, visible on dark bg) - #585858
        ];

        let render = |sprite: &[[u8; 13]; 12]| -> Vec<String> {
            (0..6usize)
                .map(|line| {
                    let r0 = &sprite[line * 2];
                    let r1 = &sprite[line * 2 + 1];
                    let mut s = String::new();
                    for col in 0..13usize {
                        let top = COLOR[r0[col] as usize];
                        let bot = COLOR[r1[col] as usize];
                        match (top, bot) {
                            (None, None) => s.push(' '),
                            (Some(t), None) => s.push_str(&format!("\x1b[38;5;{t}m▀\x1b[0m")),
                            (None, Some(b)) => s.push_str(&format!("\x1b[38;5;{b}m▄\x1b[0m")),
                            (Some(t), Some(b)) if t == b => {
                                s.push_str(&format!("\x1b[48;5;{t}m \x1b[0m"))
                            }
                            (Some(t), Some(b)) => {
                                s.push_str(&format!("\x1b[38;5;{t};48;5;{b}m▀\x1b[0m"))
                            }
                        }
                    }
                    s
                })
                .collect()
        };

        let left = render(&CLAUDE);
        let right = render(&GPT);

        // Center text: 6 lines, ALL exactly 34 visible chars
        // 0: 2sp + 30 dashes + 2sp                            = 34
        // 1: 7sp + "A     R     I     S" (19) + 8sp             = 34
        // 2: 6sp + "Auto Research in Sleep" (22) + 6sp        = 34
        // 3: 4sp + "adversarial | multi-agent" (25) + 5sp     = 34
        // 4: 6sp + "Claude x GPT-5.5 xhigh" (22) + 6sp       = 34
        // 5: same as 0                                        = 34
        let center = [
            "\x1b[2m  ──────────────────────────────  \x1b[0m",
            "\x1b[1;38;5;45m       A     R     I     S        \x1b[0m",
            "\x1b[38;5;45m      Auto Research in Sleep      \x1b[0m",
            "\x1b[2m    adversarial | multi-agent     \x1b[0m",
            "      \x1b[38;5;45mClaude\x1b[0m x \x1b[38;5;71mGPT-5.5 xhigh\x1b[0m      ",
            "\x1b[2m  ──────────────────────────────  \x1b[0m",
        ];

        // Build sprite lines
        let mut sprite_lines: Vec<String> = Vec::new();
        for i in 0..6 {
            let mut line = String::new();
            line.push_str(&left[i]);
            line.push_str("  ");
            line.push_str(center[i]);
            line.push_str("  ");
            line.push_str(&right[i]);
            sprite_lines.push(line);
        }

        let executor_label = if aris_executor::resolve_openai_executor_config().is_some() {
            // Check if this is a custom provider
            let is_custom =
                config::ArisConfig::load().executor_provider.as_deref() == Some("custom");
            if is_custom {
                "Custom"
            } else {
                let base = std::env::var("EXECUTOR_BASE_URL").unwrap_or_default();
                if base.contains("deepseek") {
                    "DeepSeek"
                } else if base.contains("bigmodel") {
                    "GLM"
                } else if base.contains("minimax") {
                    "MiniMax"
                } else if base.contains("moonshot") {
                    "Moonshot"
                } else if base.contains("dashscope") || base.contains("qwen") {
                    "Qwen"
                } else if base.contains("generativelanguage.googleapis") {
                    "Gemini"
                } else if base.contains("xiaomimimo") {
                    "Xiaomi"
                } else if base.contains("volces") {
                    "Doubao"
                } else {
                    "OpenAI"
                }
            }
        } else {
            "Anthropic"
        };

        let info_lines = [
            format!(
                "\x1b[2mExecutor\x1b[0m     {executor_label} · {}",
                self.model
            ),
            format!("\x1b[2mReviewer\x1b[0m     {}", self.reviewer_model),
            format!(
                "\x1b[2mPermissions\x1b[0m  {}",
                self.permission_mode.as_str()
            ),
            format!("\x1b[2mDirectory\x1b[0m    {cwd}"),
            format!("\x1b[2mSession\x1b[0m      {}", self.session.id),
        ];

        // Box drawing
        let term_w = crossterm::terminal::size()
            .map(|(w, _)| w as usize)
            .unwrap_or(80);
        let box_w = term_w.min(76);
        let hr = "─".repeat(box_w.saturating_sub(2));
        let dim = "\x1b[38;5;240m";
        let reset = "\x1b[0m";

        let mut banner = String::new();
        // Top border with title
        banner.push_str(&format!(
            "{dim}╭─ {reset}ARIS-Code v{VERSION}{dim} {hr}{reset}\n",
            hr = "─".repeat(box_w.saturating_sub(18 + VERSION.len()))
        ));
        // Sprite lines
        for line in &sprite_lines {
            banner.push_str(&format!("{dim}│{reset} {line}\n"));
        }
        // Separator
        banner.push_str(&format!("{dim}├{hr}┤{reset}\n"));
        // Info lines
        for line in &info_lines {
            banner.push_str(&format!("{dim}│{reset}  {line}\n"));
        }
        // Bottom border
        banner.push_str(&format!("{dim}╰{hr}╯{reset}\n"));
        // Help hint (outside box)
        banner.push_str(&format!(
            "\n  Type \x1b[1m/help\x1b[0m for commands · \x1b[2m/model\x1b[0m or \x1b[2m/reviewer\x1b[0m to switch"
        ));
        banner
    }

    fn run_turn(&mut self, input: &str) -> Result<(), Box<dyn std::error::Error>> {
        let mut stdout = io::stdout();
        // Snapshot the session BEFORE the turn. ConversationRuntime::run_turn
        // appends the user message before the API call, so a failed attempt
        // leaves `input` in the session. If we fall back, we rebuild from THIS
        // pre-turn snapshot so the retry appends `input` exactly once.
        let pre_turn_session = self.runtime.session().clone();
        loop {
            let mut spinner = Spinner::new();
            spinner.tick(
                "\x1b[38;5;74m●\x1b[0m \x1b[2mThinking...\x1b[0m",
                TerminalRenderer::new().color_theme(),
                &mut stdout,
            )?;
            execute!(stdout, MoveToColumn(0), Clear(ClearType::CurrentLine))?;
            stdout.flush()?;
            let mut permission_prompter = CliPermissionPrompter::new(self.permission_mode);
            let result = self.runtime.run_turn(input, Some(&mut permission_prompter));
            match result {
                Ok(summary) => {
                    spinner.finish_after_stream(
                        "\x1b[38;5;74m●\x1b[0m \x1b[2mDone\x1b[0m",
                        TerminalRenderer::new().color_theme(),
                        &mut stdout,
                    )?;
                    println!();
                    if let Some(event) = summary.auto_compaction {
                        println!(
                            "{}",
                            format_auto_compaction_notice(event.removed_message_count)
                        );
                    }
                    self.persist_session()?;
                    return Ok(());
                }
                Err(error) => {
                    // If the default Opus 4.8 is unavailable on this account,
                    // fall back to 4.7 — rebuilding runtime and system prompt
                    // so the model identity stays coherent — and retry once.
                    if self.fall_back_default_model_if_needed(&error)? {
                        spinner.finish(
                            "\x1b[33m●\x1b[0m \x1b[2mretrying with the fallback model…\x1b[0m",
                            TerminalRenderer::new().color_theme(),
                            &mut stdout,
                        )?;
                        self.runtime = build_runtime(
                            pre_turn_session.clone(),
                            self.model.clone(),
                            self.system_prompt.clone(),
                            true,
                            true,
                            self.allowed_tools.clone(),
                            self.permission_mode,
                        )?;
                        continue;
                    }
                    spinner.fail(
                        "\x1b[38;5;203m●\x1b[0m \x1b[1;31mRequest failed\x1b[0m",
                        TerminalRenderer::new().color_theme(),
                        &mut stdout,
                    )?;
                    return Err(Box::new(error));
                }
            }
        }
    }

    /// When `error` is "model unavailable on this account" and we're still on
    /// DEFAULT_MODEL (Opus 4.8), switch to DEFAULT_MODEL_FALLBACK (4.7),
    /// rebuild the system prompt, warn once, and return `true` so the caller
    /// rebuilds its runtime and retries. Returns `false` otherwise.
    fn fall_back_default_model_if_needed(
        &mut self,
        error: &RuntimeError,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        if !error.is_model_unavailable() || self.model != DEFAULT_MODEL || self.model_fell_back {
            return Ok(false);
        }
        self.model_fell_back = true;
        self.model = DEFAULT_MODEL_FALLBACK.to_string();
        self.system_prompt = build_system_prompt(Some(&self.model))?;
        eprintln!(
            "\x1b[33mwarning:\x1b[0m {DEFAULT_MODEL} is not available on this account; \
             falling back to {DEFAULT_MODEL_FALLBACK} for this session."
        );
        Ok(true)
    }

    pub(crate) fn run_turn_with_output(
        &mut self,
        input: &str,
        output_format: CliOutputFormat,
    ) -> Result<(), Box<dyn std::error::Error>> {
        match output_format {
            CliOutputFormat::Text => self.run_turn(input),
            CliOutputFormat::Json => self.run_prompt_json(input),
        }
    }

    fn run_prompt_json(&mut self, input: &str) -> Result<(), Box<dyn std::error::Error>> {
        // Same default-model fallback as the text path. On a "model unavailable"
        // failure we switch to 4.7, rebuild from the new model + system prompt,
        // and retry once.
        let summary = loop {
            let session = self.runtime.session().clone();
            let mut runtime = build_runtime(
                session,
                self.model.clone(),
                self.system_prompt.clone(),
                true,
                false,
                self.allowed_tools.clone(),
                self.permission_mode,
            )?;
            let mut permission_prompter = CliPermissionPrompter::new(self.permission_mode);
            match runtime.run_turn(input, Some(&mut permission_prompter)) {
                Ok(summary) => {
                    self.runtime = runtime;
                    break summary;
                }
                Err(error) => {
                    if self.fall_back_default_model_if_needed(&error)? {
                        continue;
                    }
                    return Err(Box::new(error));
                }
            }
        };
        self.persist_session()?;
        println!(
            "{}",
            json!({
                "message": final_assistant_text(&summary),
                "model": self.model,
                "iterations": summary.iterations,
                "auto_compaction": summary.auto_compaction.map(|event| json!({
                    "removed_messages": event.removed_message_count,
                    "notice": format_auto_compaction_notice(event.removed_message_count),
                })),
                "tool_uses": collect_tool_uses(&summary),
                "tool_results": collect_tool_results(&summary),
                "usage": {
                    "input_tokens": summary.usage.input_tokens,
                    "output_tokens": summary.usage.output_tokens,
                    "cache_creation_input_tokens": summary.usage.cache_creation_input_tokens,
                    "cache_read_input_tokens": summary.usage.cache_read_input_tokens,
                }
            })
        );
        Ok(())
    }

    fn handle_repl_command(
        &mut self,
        command: SlashCommand,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        Ok(match command {
            SlashCommand::Help => {
                println!("{}", render_repl_help());
                false
            }
            SlashCommand::Status => {
                self.print_status();
                false
            }
            SlashCommand::Bughunter { scope } => {
                self.run_bughunter(scope.as_deref())?;
                false
            }
            SlashCommand::Commit => {
                self.run_commit()?;
                true
            }
            SlashCommand::Pr { context } => {
                self.run_pr(context.as_deref())?;
                false
            }
            SlashCommand::Issue { context } => {
                self.run_issue(context.as_deref())?;
                false
            }
            SlashCommand::Ultraplan { task } => {
                self.run_ultraplan(task.as_deref())?;
                false
            }
            SlashCommand::Teleport { target } => {
                self.run_teleport(target.as_deref())?;
                false
            }
            SlashCommand::DebugToolCall => {
                self.run_debug_tool_call()?;
                false
            }
            SlashCommand::Compact { instruction } => {
                self.compact(instruction)?;
                false
            }
            SlashCommand::Model { model } => self.set_model(model)?,
            SlashCommand::Reviewer { model } => self.set_reviewer(model)?,
            SlashCommand::Setup => self.run_inline_setup()?,
            SlashCommand::Plan { task } => self.handle_plan_mode(task.as_deref())?,
            SlashCommand::Tasks { action } => {
                Self::handle_tasks(action.as_deref())?;
                false
            }
            SlashCommand::Skills { action, target } => {
                Self::handle_skills(action.as_deref(), target.as_deref())?;
                false
            }
            SlashCommand::Permissions { mode } => self.set_permissions(mode)?,
            SlashCommand::Clear { confirm } => self.clear_session(confirm)?,
            SlashCommand::Cost => {
                self.print_cost();
                false
            }
            SlashCommand::Resume { session_path } => self.resume_session(session_path)?,
            SlashCommand::Config { section } => {
                Self::print_config(section.as_deref())?;
                false
            }
            SlashCommand::Memory { action, target } => {
                Self::handle_memory(action.as_deref(), target.as_deref())?;
                false
            }
            SlashCommand::Goal { action, objective } => {
                println!(
                    "{}",
                    handle_goal_command(action.as_deref(), objective.as_deref())?
                );
                false
            }
            SlashCommand::Init => {
                run_init()?;
                false
            }
            SlashCommand::Diff => {
                Self::print_diff()?;
                false
            }
            SlashCommand::Version => {
                Self::print_version();
                false
            }
            SlashCommand::Export { path } => {
                self.export_session(path.as_deref())?;
                false
            }
            SlashCommand::ExportDebugZip { .. } => {
                eprintln!("export-debug-zip is only available in desktop chat");
                false
            }
            SlashCommand::Session { action, target } => {
                self.handle_session_command(action.as_deref(), target.as_deref())?
            }
            SlashCommand::Team { action, target } => {
                self.handle_team_command(action.as_deref(), target.as_deref())?;
                false
            }
            SlashCommand::Workflows { action, target } => {
                self.handle_workflows_command(action.as_deref(), target.as_deref())?
            }
            SlashCommand::MetaOptimize { action, target } => {
                self.handle_meta_optimize(action.as_deref(), target.as_deref())?;
                false
            }
            SlashCommand::Unknown { ref name, ref args } => {
                // Try to resolve as a skill invocation
                if is_known_skill(name) {
                    let args_hint = args.as_deref().unwrap_or("");
                    let skill_prompt = if args_hint.is_empty() {
                        format!(
                            "Use the Skill tool to invoke the skill named \"{name}\". Follow the skill instructions precisely."
                        )
                    } else {
                        format!(
                            "Use the Skill tool to invoke the skill named \"{name}\" with arguments: {args_hint}. Follow the skill instructions precisely."
                        )
                    };
                    self.run_turn(&skill_prompt)?;
                    false
                } else {
                    eprintln!("unknown slash command: /{name}");
                    false
                }
            }
        })
    }

    fn persist_session(&self) -> Result<(), Box<dyn std::error::Error>> {
        save_session_artifacts(&self.session.id, &self.session.path, self.runtime.session())?;
        Ok(())
    }

    fn print_status(&self) {
        let cumulative = self.runtime.usage().cumulative_usage();
        let latest = self.runtime.usage().current_turn_usage();
        println!(
            "{}",
            format_status_report(
                &self.model,
                StatusUsage {
                    message_count: self.runtime.session().messages.len(),
                    turns: self.runtime.usage().turns(),
                    latest,
                    cumulative,
                    estimated_tokens: self.runtime.estimated_tokens(),
                },
                self.permission_mode.as_str(),
                &status_context(Some(&self.session.path)).expect("status context should load"),
                "live-repl",
            )
        );
    }

    fn set_model(&mut self, model: Option<String>) -> Result<bool, Box<dyn std::error::Error>> {
        let model = match model {
            Some(m) => resolve_model_alias(&m).to_string(),
            None => {
                // Show interactive menu
                let is_openai = aris_executor::resolve_openai_executor_config().is_some();
                let is_custom =
                    config::ArisConfig::load().executor_provider.as_deref() == Some("custom");

                let items: Vec<input::SelectItem> = if is_custom {
                    // Custom provider: try dynamic /models fetch
                    let cfg = config::ArisConfig::load();
                    let api_key = cfg.executor_api_key.as_deref().unwrap_or("");
                    let base_url = cfg.executor_base_url.as_deref().unwrap_or("");
                    if !api_key.is_empty() && !base_url.is_empty() {
                        match openai_compat::fetch_openai_models(base_url, api_key) {
                            Ok(models) => openai_compat::model_select_items(&models, &self.model),
                            Err(err) => {
                                println!("\x1b[33m⚠ Could not fetch models: {err}\x1b[0m");
                                println!("  Use /model <name> to switch directly.");
                                return Ok(false);
                            }
                        }
                    } else {
                        println!("Custom provider not fully configured. Run /setup first.");
                        return Ok(false);
                    }
                } else if is_openai {
                    // OpenAI-compat mode: show common models
                    vec![
                        (
                            "gpt-5.5",
                            "OpenAI · Best intelligence at scale (xhigh reasoning)",
                        ),
                        ("gpt-5.4", "OpenAI · Previous flagship"),
                        ("gpt-5.4-mini", "OpenAI · Strong mini model"),
                        ("gpt-5.4-nano", "OpenAI · Cheapest, high-volume"),
                        ("gemini-2.5-pro", "Google · Most capable Gemini"),
                        ("gemini-2.5-flash", "Google · Fast Gemini"),
                        ("GLM-5", "Zhipu · GLM 5 latest"),
                        ("MiniMax-M2.7", "MiniMax · M2.7 latest"),
                        ("kimi-k2.5", "Kimi · K2.5 reasoning"),
                        ("mimo-v2.5-pro", "Xiaomi · MiMo v2.5 Pro"),
                        ("mimo-v2.5", "Xiaomi · MiMo v2.5"),
                        ("mimo-v2-pro", "Xiaomi · MiMo v2 Pro"),
                        ("mimo-v2-omni", "Xiaomi · MiMo v2 Omni"),
                        ("qwen3.6-plus", "Alibaba · Qwen 3.6 Plus (1M ctx)"),
                        ("qwen3.6-flash", "Alibaba · Qwen 3.6 Flash (1M ctx)"),
                        ("qwen3.6-max-preview", "Alibaba · Qwen 3.6 Max Preview"),
                        ("doubao-pro-4k", "ByteDance · Doubao Pro 4K"),
                        ("doubao-lite-4k", "ByteDance · Doubao Lite 4K"),
                    ]
                    .into_iter()
                    .map(|(name, desc)| input::SelectItem {
                        label: name.to_string(),
                        description: desc.to_string(),
                        is_current: self.model == name,
                    })
                    .collect()
                } else {
                    // Anthropic mode
                    vec![
                        (
                            "claude-opus-4-8",
                            "Opus 4.8 · Most capable for complex work",
                        ),
                        ("claude-sonnet-4-6", "Sonnet 4.6 · Best for everyday tasks"),
                        (
                            "claude-haiku-4-5-20251001",
                            "Haiku 4.5 · Fastest for quick answers",
                        ),
                    ]
                    .into_iter()
                    .map(|(name, desc)| input::SelectItem {
                        label: name.to_string(),
                        description: desc.to_string(),
                        is_current: self.model == name,
                    })
                    .collect()
                };

                match input::select_menu(
                    "Select executor model",
                    "Switch the model used for the main conversation.",
                    &items,
                )? {
                    Some(idx) => items[idx].label.clone(),
                    None => return Ok(false),
                }
            }
        };

        if model == self.model {
            println!(
                "{}",
                format_model_report(
                    &self.model,
                    self.runtime.session().messages.len(),
                    self.runtime.usage().turns(),
                )
            );
            return Ok(false);
        }

        let previous = self.model.clone();
        // Rebuild system prompt with new model identity
        let new_system_prompt = build_system_prompt(Some(&model))?;
        let session = self.runtime.session().clone();
        let message_count = session.messages.len();
        self.runtime = build_runtime(
            session,
            model.clone(),
            new_system_prompt.clone(),
            true,
            true,
            self.allowed_tools.clone(),
            self.permission_mode,
        )?;
        self.system_prompt = new_system_prompt;
        self.model.clone_from(&model);
        println!(
            "{}",
            format_model_switch_report(&previous, &model, message_count)
        );
        Ok(true)
    }

    fn set_reviewer(&mut self, model: Option<String>) -> Result<bool, Box<dyn std::error::Error>> {
        let model = match model {
            Some(m) => m,
            None => {
                let has_gemini = std::env::var("GEMINI_API_KEY").is_ok();
                let has_openai = std::env::var("OPENAI_API_KEY").is_ok();
                // Custom OpenAI-compatible reviewer: API key lives in
                // ARIS_REVIEWER_AUTH_TOKEN (not OPENAI_API_KEY, deliberately
                // separate to avoid colliding with the executor's key). The
                // bare `/reviewer` menu used to miss this entirely and tell
                // users "No reviewer API key found" even when they had just
                // configured a custom provider.
                let has_custom_reviewer = std::env::var("ARIS_REVIEWER_PROVIDER").as_deref()
                    == Ok("custom")
                    && std::env::var("ARIS_REVIEWER_AUTH_TOKEN").is_ok();

                let mut items: Vec<input::SelectItem> = Vec::new();
                if has_gemini {
                    for (name, desc) in [
                        ("gemini-2.5-pro", "Google · Most capable, deep reasoning"),
                        ("gemini-2.5-flash", "Google · Fast and efficient"),
                        ("gemini-2.0-flash-001", "Google · Previous gen fast model"),
                    ] {
                        items.push(input::SelectItem {
                            label: name.to_string(),
                            description: desc.to_string(),
                            is_current: self.reviewer_model == name,
                        });
                    }
                }
                // GLM models
                if std::env::var("GLM_API_KEY").is_ok() {
                    for (name, desc) in [
                        ("GLM-5", "Zhipu · Most capable"),
                        ("GLM-5-Turbo", "Zhipu · Fast"),
                        ("GLM-4.7", "Zhipu · Previous gen"),
                    ] {
                        items.push(input::SelectItem {
                            label: name.to_string(),
                            description: desc.to_string(),
                            is_current: self.reviewer_model == name,
                        });
                    }
                }
                // MiniMax models
                if std::env::var("MINIMAX_API_KEY").is_ok() {
                    for (name, desc) in [
                        (
                            "MiniMax-M2.7",
                            "MiniMax · Latest, recursive self-improvement",
                        ),
                        ("MiniMax-M2.7-highspeed", "MiniMax · Fast inference"),
                        ("MiniMax-M2.5", "MiniMax · Code generation"),
                    ] {
                        items.push(input::SelectItem {
                            label: name.to_string(),
                            description: desc.to_string(),
                            is_current: self.reviewer_model == name,
                        });
                    }
                }
                // Kimi models
                if std::env::var("KIMI_API_KEY").is_ok() {
                    for (name, desc) in [("kimi-k2.5", "Kimi · K2.5 reasoning")] {
                        items.push(input::SelectItem {
                            label: name.to_string(),
                            description: desc.to_string(),
                            is_current: self.reviewer_model == name,
                        });
                    }
                }
                if has_openai {
                    for (name, desc) in [
                        (
                            "gpt-5.5",
                            "OpenAI · Best intelligence for reviews (xhigh reasoning)",
                        ),
                        ("gpt-5.4", "OpenAI · Previous flagship"),
                        ("gpt-5.4-mini", "OpenAI · Strong and affordable"),
                        ("gpt-5.4-nano", "OpenAI · Cheapest, high-volume"),
                        ("gpt-4o", "OpenAI · Older gen, stable"),
                    ] {
                        items.push(input::SelectItem {
                            label: name.to_string(),
                            description: desc.to_string(),
                            is_current: self.reviewer_model == name,
                        });
                    }
                }

                if items.is_empty() {
                    if has_custom_reviewer {
                        // Custom provider is configured but we can't enumerate
                        // its model catalog. Show the current model and tell
                        // the user how to change it (`/reviewer <model-name>`).
                        let current = std::env::var("ARIS_REVIEWER_MODEL")
                            .ok()
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| self.reviewer_model.clone());
                        let base_url = std::env::var("ARIS_REVIEWER_BASE_URL")
                            .ok()
                            .unwrap_or_else(|| "(not set)".to_string());
                        println!(
                            "\x1b[1mCustom reviewer configured\x1b[0m\n  Endpoint  {base_url}\n  Model     \x1b[1;32m{current}\x1b[0m"
                        );
                        println!(
                            "  \x1b[2mType '/reviewer <model-name>' to change, or '/setup' to re-enter API key / endpoint.\x1b[0m"
                        );
                        return Ok(false);
                    }
                    // No known API keys set — guide the user to /setup.
                    println!("No reviewer API key found. Set GEMINI_API_KEY, OPENAI_API_KEY, or use /setup to configure a custom provider.");
                    println!("  You can also type: /reviewer <model-name>");
                    return Ok(false);
                }

                match input::select_menu(
                    "Select reviewer model",
                    "Switch the model used by LlmReview for external reviews.",
                    &items,
                )? {
                    Some(idx) => items[idx].label.clone(),
                    None => return Ok(false),
                }
            }
        };

        let previous = self.reviewer_model.clone();
        self.reviewer_model.clone_from(&model);

        // Update the REVIEWER_MODEL env var so LlmReview picks it up
        std::env::set_var("ARIS_REVIEWER_MODEL", &model);

        println!(
            "\x1b[1mReviewer model\x1b[0m\n  Previous         {previous}\n  Current          \x1b[1;32m{model}\x1b[0m"
        );
        Ok(false)
    }

    fn run_inline_setup(&mut self) -> Result<bool, Box<dyn std::error::Error>> {
        let new_config = config::run_interactive_setup()?;
        new_config.force_apply_to_env();

        // Update model if config changed it
        if let Some(new_model) = new_config.executor_model() {
            let new_model = resolve_model_alias(new_model).to_string();
            if new_model != self.model {
                let previous = self.model.clone();
                // Rebuild system prompt with new model identity
                let new_system_prompt = build_system_prompt(Some(&new_model))?;
                let session = self.runtime.session().clone();
                self.runtime = build_runtime(
                    session,
                    new_model.clone(),
                    new_system_prompt.clone(),
                    true,
                    true,
                    self.allowed_tools.clone(),
                    self.permission_mode,
                )?;
                self.system_prompt = new_system_prompt;
                self.model.clone_from(&new_model);
                println!("  Executor model: {previous} → \x1b[1;32m{new_model}\x1b[0m");
            }
        }

        // Update reviewer model
        if let Some(new_reviewer) = &new_config.reviewer_model {
            self.reviewer_model.clone_from(new_reviewer);
        }

        Ok(true)
    }

    fn handle_tasks(action: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
        let tasks_path = aris_tasks_path();
        match action {
            Some("clear") => {
                if tasks_path.exists() {
                    fs::remove_file(&tasks_path)?;
                    println!("\x1b[1;32m✓\x1b[0m Tasks cleared.");
                } else {
                    println!("No tasks file to clear.");
                }
            }
            _ => {
                if tasks_path.exists() {
                    let content = fs::read_to_string(&tasks_path)?;
                    if let Ok(todos) = serde_json::from_str::<Vec<serde_json::Value>>(&content) {
                        if todos.is_empty() {
                            println!("\x1b[2mNo tasks yet. The model manages tasks automatically via TodoWrite.\x1b[0m");
                        } else {
                            println!("\x1b[1mTasks\x1b[0m\n");
                            for todo in &todos {
                                let status = todo
                                    .get("status")
                                    .and_then(|s| s.as_str())
                                    .unwrap_or("pending");
                                let content_text =
                                    todo.get("content").and_then(|c| c.as_str()).unwrap_or("?");
                                let icon = match status {
                                    "completed" => "\x1b[1;32m✓\x1b[0m",
                                    "in_progress" => "\x1b[1;33m●\x1b[0m",
                                    _ => "\x1b[2m○\x1b[0m",
                                };
                                println!("  {icon} {content_text}");
                            }
                            println!();
                        }
                    } else {
                        // Fallback: show raw content
                        println!("{content}");
                    }
                } else {
                    println!("\x1b[2mNo tasks yet. The model manages tasks automatically via TodoWrite.\x1b[0m");
                }
            }
        }
        Ok(())
    }

    fn handle_skills(
        action: Option<&str>,
        target: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        match action {
            None | Some("list") => {
                let skills = discover_all_skills();
                if skills.is_empty() {
                    println!("No skills found.");
                    return Ok(());
                }
                let max_name = skills.iter().map(|(n, _, _)| n.len()).max().unwrap_or(10);
                let name_col = max_name.max(15) + 2;
                println!("\x1b[1mAvailable skills\x1b[0m\n");
                for (name, desc, source) in &skills {
                    let tag = match *source {
                        "aris" => "\x1b[1;32m[aris]\x1b[0m  ",
                        "project" => "\x1b[1;36m[project]\x1b[0m",
                        "compat" => "\x1b[1;34m[compat]\x1b[0m ",
                        _ => "\x1b[2m[built-in]\x1b[0m",
                    };
                    let d = if desc.is_empty() { "" } else { desc.as_str() };
                    println!("  {tag} {name:<width$} \x1b[2m{d}\x1b[0m", width = name_col);
                }
                let skill_dirs = skill_search_dirs()
                    .into_iter()
                    .map(|dir| dir.display().to_string())
                    .collect::<Vec<_>>()
                    .join(" > ");
                println!("\n\x1b[2mSkill dirs: {skill_dirs} > bundled\x1b[0m");
                println!("\x1b[2mUse /skills show <name> to view · /skills export <name> to customize\x1b[0m");
            }
            Some("show") => {
                let Some(name) = target else {
                    println!("Usage: /skills show <name>");
                    return Ok(());
                };
                if let Some(content) = find_skill_content(name) {
                    println!("\x1b[1m/{name}\x1b[0m\n");
                    println!("{content}");
                } else {
                    println!("Skill '{name}' not found.");
                }
            }
            Some("export") => {
                let Some(name) = target else {
                    println!("Usage: /skills export <name>");
                    return Ok(());
                };
                let Some(content) = find_skill_content(name) else {
                    println!("Skill '{name}' not found.");
                    return Ok(());
                };
                // Canonicalise the skill name so the export dir and the
                // BUNDLED_RESOURCES prefix match exactly. find_skill_content
                // matches bundled names case-insensitively; without this,
                // `/skills export Research-Wiki` would write SKILL.md but
                // miss every helper because `skills/Research-Wiki/` ≠
                // `skills/research-wiki/` in the bundle keys.
                let canonical_name = runtime::BUNDLED_SKILLS
                    .iter()
                    .find(|(n, _)| n.eq_ignore_ascii_case(name))
                    .map(|(n, _)| (*n).to_string())
                    .unwrap_or_else(|| name.to_string());
                let target_dir = dirs_aris_skills().join(&canonical_name);
                let target_file = target_dir.join("SKILL.md");
                if target_file.exists() {
                    println!(
                        "Already exists: {}\n\x1b[2mEdit it directly to customize.\x1b[0m",
                        target_file.display()
                    );
                    return Ok(());
                }
                fs::create_dir_all(&target_dir)?;
                fs::write(&target_file, &content)?;

                // v0.4.8: also copy bundled skill-local helpers (`skills/<name>/*`)
                // into the exported skill dir, preserving subdirectories. Without
                // this, the exported skill loses access to its bundled helpers
                // (templates/, tools/, etc.) because the filesystem skill takes
                // precedence over the bundled one in execute_skill (`tools/src/lib.rs`).
                // Shared `tools/*` and `shared-references/*` stay in cache and are
                // accessed via $ARIS_CACHE_DIR by the resolver chain.
                let skill_prefix = format!("skills/{canonical_name}/");
                let mut copied = 0usize;
                let mut failed: Vec<(String, String)> = Vec::new();
                for (key, body) in runtime::BUNDLED_RESOURCES {
                    let Some(rel) = key.strip_prefix(&skill_prefix) else {
                        continue;
                    };
                    let dst = target_dir.join(rel);
                    if dst.exists() {
                        continue; // user-edited files are preserved
                    }
                    if let Some(parent) = dst.parent() {
                        if let Err(e) = fs::create_dir_all(parent) {
                            failed.push((key.to_string(), e.to_string()));
                            continue;
                        }
                    }
                    if let Err(e) = fs::write(&dst, body) {
                        failed.push((key.to_string(), e.to_string()));
                        continue;
                    }
                    copied += 1;
                }

                println!(
                    "\x1b[1;32m✓\x1b[0m Exported to {}\n\x1b[2mEdit this file to customize the skill.\x1b[0m",
                    target_file.display()
                );
                if copied > 0 {
                    println!(
                        "\x1b[2mBundled {copied} helper file(s) into {}\x1b[0m",
                        target_dir.display()
                    );
                }
                for (key, err) in &failed {
                    eprintln!("\x1b[33mwarning:\x1b[0m failed to copy {key}: {err}");
                }
            }
            Some(other) => {
                println!("Unknown action '{other}'. Use: /skills [list|show <name>|export <name>]");
            }
        }
        Ok(())
    }

    fn set_permissions(
        &mut self,
        mode: Option<String>,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        let mode = match mode {
            Some(m) => m,
            None => {
                let items: Vec<input::SelectItem> = vec![
                    ("read-only", "Safe · Read files only, no writes or commands"),
                    (
                        "workspace-write",
                        "Normal · Read + write files in workspace",
                    ),
                    ("danger-full-access", "Full · All tools, no restrictions"),
                ]
                .into_iter()
                .map(|(name, desc)| input::SelectItem {
                    label: name.to_string(),
                    description: desc.to_string(),
                    is_current: self.permission_mode.as_str() == name,
                })
                .collect();

                match input::select_menu(
                    "Select permission mode",
                    "Controls which tools require approval.",
                    &items,
                )? {
                    Some(idx) => items[idx].label.clone(),
                    None => return Ok(false),
                }
            }
        };

        let normalized = normalize_permission_mode(&mode).ok_or_else(|| {
            format!(
                "unsupported permission mode '{mode}'. Use read-only, workspace-write, or danger-full-access."
            )
        })?;

        if normalized == self.permission_mode.as_str() {
            println!("{}", format_permissions_report(normalized));
            return Ok(false);
        }

        let previous = self.permission_mode.as_str().to_string();
        let session = self.runtime.session().clone();
        self.permission_mode = permission_mode_from_label(normalized);
        set_coordination_context_env(
            &self.session.id,
            self.allowed_tools.as_ref(),
            self.permission_mode,
        );
        self.runtime = build_runtime(
            session,
            self.model.clone(),
            self.system_prompt.clone(),
            true,
            true,
            self.allowed_tools.clone(),
            self.permission_mode,
        )?;
        println!(
            "{}",
            format_permissions_switch_report(&previous, normalized)
        );
        Ok(true)
    }

    fn clear_session(&mut self, confirm: bool) -> Result<bool, Box<dyn std::error::Error>> {
        if !confirm {
            println!(
                "clear: confirmation required; run /clear --confirm to start a fresh session."
            );
            return Ok(false);
        }

        self.session = create_managed_session_handle()?;
        set_coordination_context_env(
            &self.session.id,
            self.allowed_tools.as_ref(),
            self.permission_mode,
        );
        self.runtime = build_runtime(
            Session::new(),
            self.model.clone(),
            self.system_prompt.clone(),
            true,
            true,
            self.allowed_tools.clone(),
            self.permission_mode,
        )?;
        println!(
            "Session cleared\n  Mode             fresh session\n  Preserved model  {}\n  Permission mode  {}\n  Session          {}",
            self.model,
            self.permission_mode.as_str(),
            self.session.id,
        );
        Ok(true)
    }

    fn print_cost(&self) {
        let cumulative = self.runtime.usage().cumulative_usage();
        println!("{}", format_cost_report(cumulative));
    }

    fn resume_session(
        &mut self,
        session_path: Option<String>,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        let Some(session_ref) = session_path else {
            println!("Usage: /resume <session-path>");
            return Ok(false);
        };

        let handle = resolve_session_reference(&session_ref)?;
        let session = Session::load_from_path(&handle.path)?;
        let message_count = session.messages.len();
        set_coordination_context_env(
            &handle.id,
            self.allowed_tools.as_ref(),
            self.permission_mode,
        );
        self.runtime = build_runtime(
            session,
            self.model.clone(),
            self.system_prompt.clone(),
            true,
            true,
            self.allowed_tools.clone(),
            self.permission_mode,
        )?;
        self.session = handle;
        println!(
            "{}",
            format_resume_report(
                &self.session.path.display().to_string(),
                message_count,
                self.runtime.usage().turns(),
            )
        );
        Ok(true)
    }

    fn print_config(section: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
        println!("{}", render_config_report(section)?);
        Ok(())
    }

    fn print_memory() -> Result<(), Box<dyn std::error::Error>> {
        println!("{}", render_memory_report()?);
        Ok(())
    }

    fn handle_memory(
        action: Option<&str>,
        target: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        match action {
            None | Some("show") => Self::print_memory(),
            Some("pending") => {
                let scope = runtime::project_scope(&std::env::current_dir()?);
                println!(
                    "{}",
                    serde_json::to_string_pretty(&runtime::list_pending_for_scope(&scope)?)?
                );
                Ok(())
            }
            Some("approve") => {
                let id = target.ok_or("Usage: /memory approve <id>")?;
                println!(
                    "{}",
                    serde_json::to_string_pretty(&runtime::approve_pending(id)?)?
                );
                Ok(())
            }
            Some("reject") => {
                let id = target.ok_or("Usage: /memory reject <id>")?;
                runtime::reject_pending(id)?;
                println!("Rejected pending memory write {id}.");
                Ok(())
            }
            Some("approval") => {
                let enabled = match target {
                    Some("on") => true,
                    Some("off") => false,
                    _ => return Err("Usage: /memory approval on|off".into()),
                };
                let mut config = config::ArisConfig::load();
                config.memory_write_approval = Some(enabled);
                config.save()?;
                std::env::set_var(
                    "ARIS_MEMORY_WRITE_APPROVAL",
                    if enabled { "true" } else { "false" },
                );
                println!(
                    "Memory write approval is now {}.",
                    if enabled { "on" } else { "off" }
                );
                Ok(())
            }
            Some(other) => Err(format!(
                "Unknown /memory action `{other}`. Use show, pending, approve, reject, or approval."
            )
            .into()),
        }
    }

    fn print_diff() -> Result<(), Box<dyn std::error::Error>> {
        println!("{}", render_diff_report()?);
        Ok(())
    }

    fn print_version() {
        println!("{}", render_version_report());
    }

    fn export_session(
        &self,
        requested_path: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let export_path = resolve_export_path(requested_path, self.runtime.session())?;
        fs::write(&export_path, render_export_text(self.runtime.session()))?;
        println!(
            "Export\n  Result           wrote transcript\n  File             {}\n  Messages         {}",
            export_path.display(),
            self.runtime.session().messages.len(),
        );
        Ok(())
    }

    fn handle_session_command(
        &mut self,
        action: Option<&str>,
        target: Option<&str>,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        match action {
            None | Some("list") => {
                println!("{}", render_session_list(&self.session.id)?);
                Ok(false)
            }
            Some("switch") => {
                let Some(target) = target else {
                    println!("Usage: /session switch <session-id>");
                    return Ok(false);
                };
                let handle = resolve_session_reference(target)?;
                let session = Session::load_from_path(&handle.path)?;
                let message_count = session.messages.len();
                set_coordination_context_env(
                    &handle.id,
                    self.allowed_tools.as_ref(),
                    self.permission_mode,
                );
                self.runtime = build_runtime(
                    session,
                    self.model.clone(),
                    self.system_prompt.clone(),
                    true,
                    true,
                    self.allowed_tools.clone(),
                    self.permission_mode,
                )?;
                self.session = handle;
                println!(
                    "Session switched\n  Active session   {}\n  File             {}\n  Messages         {}",
                    self.session.id,
                    self.session.path.display(),
                    message_count,
                );
                Ok(true)
            }
            Some("timeline") => {
                let (handle, session) = if let Some(target) = target {
                    let handle = resolve_session_reference(target)?;
                    let session = Session::load_from_path(&handle.path)?;
                    (handle, session)
                } else {
                    (self.session.clone(), self.runtime.session().clone())
                };
                println!(
                    "{}",
                    timeline::render_timeline_report(&handle.id, &handle.path, &session, 24)?
                );
                Ok(false)
            }
            Some("search") => {
                let result = runtime::search_sessions(&sessions_dir()?, target, None, 5, 5)?;
                println!("{}", serde_json::to_string_pretty(&result)?);
                Ok(false)
            }
            Some(other) => {
                println!(
                    "Unknown /session action '{other}'. Use /session list, /session search <query>, /session switch <session-id>, or /session timeline [session-id]."
                );
                Ok(false)
            }
        }
    }

    fn handle_team_command(
        &self,
        action: Option<&str>,
        target: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let output = match plan_team_command(action, target) {
            TeamCommandPlan::RenderTeamView { team_id } => {
                tools::render_team_view(team_id.as_deref()).map_err(|error| {
                    Box::new(io::Error::new(io::ErrorKind::Other, error))
                        as Box<dyn std::error::Error>
                })?
            }
            TeamCommandPlan::Tool { name, input } => execute_tool_for_cli(name, &input)?,
            TeamCommandPlan::Message(message) => {
                println!("{message}");
                return Ok(());
            }
        };
        println!("{output}");
        Ok(())
    }

    fn handle_workflows_command(
        &mut self,
        action: Option<&str>,
        target: Option<&str>,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        match plan_workflows_command(action, target) {
            WorkflowCommandPlan::Tool { input } => {
                println!("{}", execute_tool_for_cli("Workflow", &input)?);
                Ok(false)
            }
            WorkflowCommandPlan::Inject { run_id } => self.inject_workflow_result(&run_id),
            WorkflowCommandPlan::Message(message) => {
                println!("{message}");
                Ok(false)
            }
        }
    }

    fn inject_workflow_result(&mut self, run_id: &str) -> Result<bool, Box<dyn std::error::Error>> {
        let output =
            execute_tool_for_cli("Workflow", &json!({ "action": "inspect", "runId": run_id }))?;
        let value: serde_json::Value = serde_json::from_str(&output)?;
        let result = value
            .get("run")
            .and_then(|run| run.get("result"))
            .and_then(|result| result.as_str())
            .filter(|result| !result.trim().is_empty())
            .ok_or_else(|| format!("workflow {run_id} has no completed result to inject"))?;
        let text =
            format!("# Workflow Result\n\nRun `{run_id}` completed in the background.\n\n{result}");
        let mut session = self.runtime.session().clone();
        session
            .messages
            .push(ConversationMessage::assistant(vec![ContentBlock::Text {
                text: text.clone(),
            }]));
        self.runtime = build_runtime(
            session,
            self.model.clone(),
            self.system_prompt.clone(),
            true,
            true,
            self.allowed_tools.clone(),
            self.permission_mode,
        )?;
        self.persist_session()?;
        println!(
            "Workflow\n  Result           injected\n  Run              {run_id}\n  Session          {}",
            self.session.id
        );
        Ok(true)
    }

    fn handle_plan_mode(&mut self, task: Option<&str>) -> Result<bool, Box<dyn std::error::Error>> {
        match task.map(str::trim) {
            // /plan execute — exit plan mode and execute
            Some(arg) if arg.starts_with("execute") => {
                if self.plan_mode.is_none() {
                    println!("Not in plan mode. Use /plan <task> to enter plan mode first.");
                    return Ok(false);
                }
                let state = self
                    .plan_mode
                    .as_ref()
                    .expect("plan_mode checked above")
                    .clone();
                let session = self.runtime.session().clone();
                let new_runtime = match build_runtime(
                    session,
                    self.model.clone(),
                    self.system_prompt.clone(),
                    true,
                    true,
                    state.previous_allowed_tools.clone(),
                    state.previous_permission_mode,
                ) {
                    Ok(rt) => rt,
                    Err(e) => {
                        eprintln!("\x1b[1;31mFailed to exit plan mode:\x1b[0m {e}");
                        return Ok(false);
                    }
                };
                // Commit only on success
                self.runtime = new_runtime;
                self.permission_mode = state.previous_permission_mode;
                self.allowed_tools = state.previous_allowed_tools;
                self.plan_mode = None;
                println!(
                    "\x1b[1;32m✓\x1b[0m Plan mode ended. Permissions restored to \x1b[1m{}\x1b[0m.",
                    self.permission_mode.as_str()
                );
                let extra = arg.strip_prefix("execute").unwrap_or("").trim();
                let exec_prompt = if extra.is_empty() {
                    "Execute the plan you proposed. Proceed step by step.".to_string()
                } else {
                    format!("Execute the plan you proposed. Additional instructions: {extra}")
                };
                self.run_turn(&exec_prompt)?;
                Ok(true)
            }
            // /plan exit — exit plan mode without executing
            Some("exit") => {
                if let Some(state) = self.plan_mode.as_ref().cloned() {
                    let session = self.runtime.session().clone();
                    let new_runtime = match build_runtime(
                        session,
                        self.model.clone(),
                        self.system_prompt.clone(),
                        true,
                        true,
                        state.previous_allowed_tools.clone(),
                        state.previous_permission_mode,
                    ) {
                        Ok(rt) => rt,
                        Err(e) => {
                            eprintln!("\x1b[1;31mFailed to exit plan mode:\x1b[0m {e}");
                            return Ok(false);
                        }
                    };
                    self.runtime = new_runtime;
                    self.permission_mode = state.previous_permission_mode;
                    self.allowed_tools = state.previous_allowed_tools;
                    self.plan_mode = None;
                    println!(
                        "\x1b[1;32m✓\x1b[0m Plan mode exited. Permissions restored to \x1b[1m{}\x1b[0m.",
                        self.permission_mode.as_str()
                    );
                } else {
                    println!("Not in plan mode.");
                }
                Ok(false)
            }
            // /plan <task> — enter plan mode
            _ => {
                if self.plan_mode.is_some() {
                    println!("Already in plan mode. Use /plan execute or /plan exit.");
                    return Ok(false);
                }

                // Save previous state for rollback
                let prev_perm = self.permission_mode;
                let prev_tools = self.allowed_tools.clone();

                // Prepare plan-mode tools
                let plan_tools: AllowedToolSet = [
                    "read_file",
                    "glob_search",
                    "grep_search",
                    "WebFetch",
                    "WebSearch",
                    "ToolSearch",
                    "Skill",
                ]
                .iter()
                .map(|s| s.to_string())
                .collect();

                // Try rebuilding runtime FIRST, then commit state only on success
                let session = self.runtime.session().clone();
                let new_runtime = match build_runtime(
                    session,
                    self.model.clone(),
                    self.system_prompt.clone(),
                    true,
                    true,
                    Some(plan_tools.clone()),
                    PermissionMode::ReadOnly,
                ) {
                    Ok(rt) => rt,
                    Err(e) => {
                        eprintln!("\x1b[1;31mFailed to enter plan mode:\x1b[0m {e}");
                        return Ok(false);
                    }
                };

                // Commit state only after runtime built successfully
                self.runtime = new_runtime;
                self.allowed_tools = Some(plan_tools);
                self.permission_mode = PermissionMode::ReadOnly;
                self.plan_mode = Some(PlanModeState {
                    previous_permission_mode: prev_perm,
                    previous_allowed_tools: prev_tools,
                });

                println!(
                    "\x1b[1;34m●\x1b[0m \x1b[1mPlan mode\x1b[0m — read-only tools only. \
                     Use \x1b[1m/plan execute\x1b[0m to run or \x1b[1m/plan exit\x1b[0m to cancel."
                );

                let task_desc = task.unwrap_or("the user's request");
                let plan_prompt = format!(
                    "You are in PLAN MODE. You can ONLY read and search — no writing, editing, or commands.\n\n\
                     Analyze the codebase and create a detailed step-by-step plan for: {task_desc}\n\n\
                     For each step:\n\
                     1. What file(s) to change and why\n\
                     2. The specific changes needed\n\
                     3. Potential risks or edge cases\n\n\
                     Do NOT attempt to execute anything. Only produce the plan."
                );
                self.run_turn(&plan_prompt)?;
                Ok(true)
            }
        }
    }

    fn handle_meta_optimize(
        &mut self,
        action: Option<&str>,
        target: Option<&str>,
    ) -> Result<(), Box<dyn std::error::Error>> {
        match action {
            Some("apply") => {
                let Some(id_str) = target else {
                    println!("Usage: /meta-optimize apply <proposal-number>");
                    return Ok(());
                };
                let id: usize = id_str
                    .parse()
                    .map_err(|_| format!("Invalid proposal number: {id_str}"))?;
                match meta_optimize::apply_proposal(id) {
                    Ok(msg) => println!("{msg}"),
                    Err(e) => eprintln!("\x1b[1;31mError\x1b[0m: {e}"),
                }
            }
            Some("status") | None => match meta_optimize::status_report() {
                Ok(report) => println!("{report}"),
                Err(e) => eprintln!("\x1b[1;31mError\x1b[0m: {e}"),
            },
            Some(other) => {
                // Anything else (e.g., a skill name or "all") → run as skill invocation
                let args = if let Some(t) = target {
                    format!("{other} {t}")
                } else {
                    other.to_string()
                };
                let prompt = format!(
                    "Use the Skill tool to invoke the skill named \"meta-optimize\" with arguments: {args}. Follow the skill instructions precisely."
                );
                self.run_turn(&prompt)?;
            }
        }
        Ok(())
    }

    fn compact(&mut self, instruction: Option<String>) -> Result<(), Box<dyn std::error::Error>> {
        let result = self.runtime.compact(CompactionConfig::manual(instruction));
        let report = format_compact_report(&result);
        self.runtime = build_runtime(
            result.compacted_session,
            self.model.clone(),
            self.system_prompt.clone(),
            true,
            true,
            self.allowed_tools.clone(),
            self.permission_mode,
        )?;
        self.persist_session()?;
        println!("{report}");
        Ok(())
    }

    fn run_internal_prompt_text(
        &self,
        prompt: &str,
        enable_tools: bool,
    ) -> Result<String, Box<dyn std::error::Error>> {
        let session = self.runtime.session().clone();
        let mut runtime = build_runtime(
            session,
            self.model.clone(),
            self.system_prompt.clone(),
            enable_tools,
            false,
            self.allowed_tools.clone(),
            self.permission_mode,
        )?;
        let mut permission_prompter = CliPermissionPrompter::new(self.permission_mode);
        let summary = runtime.run_turn(prompt, Some(&mut permission_prompter))?;
        Ok(final_assistant_text(&summary).trim().to_string())
    }

    fn run_bughunter(&self, scope: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
        let scope = scope.unwrap_or("the current repository");
        let prompt = format!(
            "You are /bughunter. Inspect {scope} and identify the most likely bugs or correctness issues. Prioritize concrete findings with file paths, severity, and suggested fixes. Use tools if needed."
        );
        println!("{}", self.run_internal_prompt_text(&prompt, true)?);
        Ok(())
    }

    fn run_ultraplan(&self, task: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
        let task = task.unwrap_or("the current repo work");
        let prompt = format!(
            "You are /ultraplan. Produce a deep multi-step execution plan for {task}. Include goals, risks, implementation sequence, verification steps, and rollback considerations. Use tools if needed."
        );
        println!("{}", self.run_internal_prompt_text(&prompt, true)?);
        Ok(())
    }

    fn run_teleport(&self, target: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
        let Some(target) = target.map(str::trim).filter(|value| !value.is_empty()) else {
            println!("Usage: /teleport <symbol-or-path>");
            return Ok(());
        };

        println!("{}", render_teleport_report(target)?);
        Ok(())
    }

    fn run_debug_tool_call(&self) -> Result<(), Box<dyn std::error::Error>> {
        println!("{}", render_last_tool_debug_report(self.runtime.session())?);
        Ok(())
    }

    fn run_commit(&mut self) -> Result<(), Box<dyn std::error::Error>> {
        let status = git_output(&["status", "--short"])?;
        if status.trim().is_empty() {
            println!("Commit\n  Result           skipped\n  Reason           no workspace changes");
            return Ok(());
        }

        git_status_ok(&["add", "-A"])?;
        let staged_stat = git_output(&["diff", "--cached", "--stat"])?;
        let prompt = format!(
            "Generate a git commit message in plain text Lore format only. Base it on this staged diff summary:\n\n{}\n\nRecent conversation context:\n{}",
            truncate_for_prompt(&staged_stat, 8_000),
            recent_user_context(self.runtime.session(), 6)
        );
        let message = sanitize_generated_message(&self.run_internal_prompt_text(&prompt, false)?);
        if message.trim().is_empty() {
            return Err("generated commit message was empty".into());
        }

        let path = write_temp_text_file("aris-commit-message.txt", &message)?;
        let output = Command::new("git")
            .args(["commit", "--file"])
            .arg(&path)
            .current_dir(env::current_dir()?)
            .output()?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(format!("git commit failed: {stderr}").into());
        }

        println!(
            "Commit\n  Result           created\n  Message file     {}\n\n{}",
            path.display(),
            message.trim()
        );
        Ok(())
    }

    fn run_pr(&self, context: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
        let staged = git_output(&["diff", "--stat"])?;
        let prompt = format!(
            "Generate a pull request title and body from this conversation and diff summary. Output plain text in this format exactly:\nTITLE: <title>\nBODY:\n<body markdown>\n\nContext hint: {}\n\nDiff summary:\n{}",
            context.unwrap_or("none"),
            truncate_for_prompt(&staged, 10_000)
        );
        let draft = sanitize_generated_message(&self.run_internal_prompt_text(&prompt, false)?);
        let (title, body) = parse_titled_body(&draft)
            .ok_or_else(|| "failed to parse generated PR title/body".to_string())?;

        if runtime::command_exists("gh") {
            let body_path = write_temp_text_file("aris-pr-body.md", &body)?;
            let output = Command::new("gh")
                .args(["pr", "create", "--title", &title, "--body-file"])
                .arg(&body_path)
                .current_dir(env::current_dir()?)
                .output()?;
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                println!(
                    "PR\n  Result           created\n  Title            {title}\n  URL              {}",
                    if stdout.is_empty() { "<unknown>" } else { &stdout }
                );
                return Ok(());
            }
        }

        println!("PR draft\n  Title            {title}\n\n{body}");
        Ok(())
    }

    fn run_issue(&self, context: Option<&str>) -> Result<(), Box<dyn std::error::Error>> {
        let prompt = format!(
            "Generate a GitHub issue title and body from this conversation. Output plain text in this format exactly:\nTITLE: <title>\nBODY:\n<body markdown>\n\nContext hint: {}\n\nConversation context:\n{}",
            context.unwrap_or("none"),
            truncate_for_prompt(&recent_user_context(self.runtime.session(), 10), 10_000)
        );
        let draft = sanitize_generated_message(&self.run_internal_prompt_text(&prompt, false)?);
        let (title, body) = parse_titled_body(&draft)
            .ok_or_else(|| "failed to parse generated issue title/body".to_string())?;

        if runtime::command_exists("gh") {
            let body_path = write_temp_text_file("aris-issue-body.md", &body)?;
            let output = Command::new("gh")
                .args(["issue", "create", "--title", &title, "--body-file"])
                .arg(&body_path)
                .current_dir(env::current_dir()?)
                .output()?;
            if output.status.success() {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                println!(
                    "Issue\n  Result           created\n  Title            {title}\n  URL              {}",
                    if stdout.is_empty() { "<unknown>" } else { &stdout }
                );
                return Ok(());
            }
        }

        println!("Issue draft\n  Title            {title}\n\n{body}");
        Ok(())
    }
}
