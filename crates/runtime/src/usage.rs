use crate::session::Session;

const DEFAULT_INPUT_COST_PER_MILLION: f64 = 15.0;
const DEFAULT_OUTPUT_COST_PER_MILLION: f64 = 75.0;
const DEFAULT_CACHE_CREATION_COST_PER_MILLION: f64 = 18.75;
const DEFAULT_CACHE_READ_COST_PER_MILLION: f64 = 1.5;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ModelPricing {
    pub input_cost_per_million: f64,
    pub output_cost_per_million: f64,
    pub cache_creation_cost_per_million: f64,
    pub cache_read_cost_per_million: f64,
}

impl ModelPricing {
    #[must_use]
    pub const fn default_sonnet_tier() -> Self {
        Self {
            input_cost_per_million: DEFAULT_INPUT_COST_PER_MILLION,
            output_cost_per_million: DEFAULT_OUTPUT_COST_PER_MILLION,
            cache_creation_cost_per_million: DEFAULT_CACHE_CREATION_COST_PER_MILLION,
            cache_read_cost_per_million: DEFAULT_CACHE_READ_COST_PER_MILLION,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_creation_input_tokens: u32,
    pub cache_read_input_tokens: u32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UsageCostEstimate {
    pub input_cost_usd: f64,
    pub output_cost_usd: f64,
    pub cache_creation_cost_usd: f64,
    pub cache_read_cost_usd: f64,
}

impl UsageCostEstimate {
    #[must_use]
    pub fn total_cost_usd(self) -> f64 {
        self.input_cost_usd
            + self.output_cost_usd
            + self.cache_creation_cost_usd
            + self.cache_read_cost_usd
    }
}

/// Look up per-token pricing for a model. Returns `None` when the model
/// string doesn't match any known family — callers then fall back to a
/// generic Sonnet-tier estimate with `pricing=estimated-default` suffix.
///
/// v0.4.10 (C9 landmine) extended this from "Claude only" to cover the
/// major OpenAI / Gemini / DeepSeek / GLM / MiniMax / Kimi / Xiaomi /
/// Qwen / Doubao families that ARIS-Code already routes to. Prices are
/// USD per million tokens, sourced from each provider's published list
/// at the time of bundling (2026-05). They will drift; treat `/cost`
/// as a rough estimate, not billing-grade.
///
/// Cache-tier handling per provider:
/// - **Anthropic**: distinct cache_creation (1.25x input) and cache_read
///   (0.1x input) tiers per the public schedule.
/// - **OpenAI**: automatic prefix-cache; reads billed at 10% of input,
///   no separate write tier (`cache_creation` = `input`).
/// - **DeepSeek V3/V4**: explicit cache-hit / cache-miss pricing in the
///   docs; we use cache-miss rate for `input`/`cache_creation`,
///   cache-hit rate (~10% of input for V4) for `cache_read`.
/// - **All others (Gemini, GLM, MiniMax, Kimi, MiMo, Qwen, Doubao)**:
///   no exposed cache billing; cache_creation = input, cache_read =
///   input/2 (a generic optimistic default).
#[must_use]
pub fn pricing_for_model(model: &str) -> Option<ModelPricing> {
    let m = model.to_ascii_lowercase();

    // ── Anthropic Claude family ──────────────────────────────────
    if m.contains("haiku") {
        return Some(ModelPricing {
            input_cost_per_million: 1.0,
            output_cost_per_million: 5.0,
            cache_creation_cost_per_million: 1.25,
            cache_read_cost_per_million: 0.1,
        });
    }
    if m.contains("opus") {
        // Deprecated Opus 4.0 / 4.1 keep the legacy $15/$75 tier.
        // Use `has_word` with "opus-" prefix for boundary safety: a future
        // "opus-4-10" must NOT be mis-classified as 4.1.
        // Also match the dated 4.0 form and the bare "claude-opus-4" alias.
        let legacy_opus = has_word(&m, "opus-4-0")    // claude-opus-4-0 alias (4.0)
            || has_word(&m, "opus-4-1")               // claude-opus-4-1[-date] (4.1)
            || m.contains("opus-4-2025")              // claude-opus-4-20250514 (dated 4.0)
            || m.ends_with("opus-4");                 // bare claude-opus-4 (4.0)
        if legacy_opus {
            return Some(ModelPricing {
                input_cost_per_million: 15.0,
                output_cost_per_million: 75.0,
                cache_creation_cost_per_million: 18.75,
                cache_read_cost_per_million: 1.5,
            });
        }
        // Current Opus 4.5–4.8 — corrected pricing (verified 2026-06).
        return Some(ModelPricing {
            input_cost_per_million: 5.0,
            output_cost_per_million: 25.0,
            cache_creation_cost_per_million: 6.25,
            cache_read_cost_per_million: 0.5,
        });
    }
    if m.contains("sonnet") {
        return Some(ModelPricing {
            input_cost_per_million: 3.0,
            output_cost_per_million: 15.0,
            cache_creation_cost_per_million: 3.75,
            cache_read_cost_per_million: 0.3,
        });
    }

    // ── OpenAI families ──────────────────────────────────────────
    // Public price list as of 2026-05. cache_read = 10% of input
    // (OpenAI's documented automatic-prefix-cache discount).
    if m.contains("gpt-5.5") {
        return Some(openai_pricing(5.0, 30.0));
    }
    if m.contains("gpt-5.4-nano") {
        return Some(openai_pricing(0.20, 1.25));
    }
    if m.contains("gpt-5.4-mini") {
        return Some(openai_pricing(0.75, 4.5));
    }
    if m.contains("gpt-5.4") {
        return Some(openai_pricing(2.5, 15.0));
    }
    if m.contains("gpt-4o-mini") {
        return Some(openai_pricing(0.15, 0.6));
    }
    if m.contains("gpt-4o") {
        return Some(openai_pricing(2.5, 10.0));
    }
    // o-series reasoning models — match on word boundary to avoid
    // false-positives like "google/o3" being prefix-matched on a
    // provider-prefixed model string.
    if has_word(&m, "o4") {
        return Some(openai_pricing(4.0, 16.0));
    }
    if has_word(&m, "o3") {
        return Some(openai_pricing(2.0, 8.0));
    }
    if has_word(&m, "o1") {
        return Some(openai_pricing(15.0, 60.0));
    }

    // ── Google Gemini ────────────────────────────────────────────
    // Gemini Pro pricing is context-window-tiered (prompts ≤200K vs
    // >200K). We list the small-context tier; long-context users will
    // see /cost as an under-estimate. Tracked for v0.5.0 (full
    // context-aware pricing matrix).
    if m.contains("gemini-2.5-flash") {
        return Some(generic_pricing(0.3, 2.5));
    }
    if m.contains("gemini-2.5-pro") {
        return Some(generic_pricing(2.5, 10.0));
    }
    if m.contains("gemini-2.0-flash") {
        return Some(generic_pricing(0.1, 0.4));
    }

    // ── DeepSeek ────────────────────────────────────────────────
    // V3 / V4 / R1 expose explicit cache hit vs miss rates. cache_read =
    // cache-hit rate; input/cache_creation = cache-miss rate.
    //
    // NOTE: DeepSeek V4 currently ships in Flash and Pro tiers with
    // distinct rates; ARIS-Code v0.4.10 collapses both onto the
    // V3-equivalent cache-miss schedule (0.27 / 1.10 / cache-hit 0.07)
    // pending a context-aware pricing matrix in v0.5.0. Treat /cost
    // as a rough estimate for V4-Pro users; V4-Flash should be close.
    if m.contains("deepseek-v4") {
        return Some(ModelPricing {
            input_cost_per_million: 0.27,
            output_cost_per_million: 1.10,
            cache_creation_cost_per_million: 0.27,
            cache_read_cost_per_million: 0.07,
        });
    }
    if m.contains("deepseek-v3") {
        return Some(ModelPricing {
            input_cost_per_million: 0.27,
            output_cost_per_million: 1.10,
            cache_creation_cost_per_million: 0.27,
            cache_read_cost_per_million: 0.07,
        });
    }
    // DeepSeek-R1: only match the deepseek-prefixed name, NOT bare
    // "*-reasoner" which would catch other providers' reasoners.
    if m.contains("deepseek-r1") || m.contains("deepseek-reasoner") {
        return Some(ModelPricing {
            input_cost_per_million: 0.55,
            output_cost_per_million: 2.19,
            cache_creation_cost_per_million: 0.55,
            cache_read_cost_per_million: 0.14,
        });
    }
    if m.contains("deepseek") {
        return Some(ModelPricing {
            input_cost_per_million: 0.27,
            output_cost_per_million: 1.10,
            cache_creation_cost_per_million: 0.27,
            cache_read_cost_per_million: 0.07,
        });
    }

    // ── Other Chinese providers ─────────────────────────────────
    // No exposed cache-tier billing — generic_pricing (cache_read =
    // input/2, cache_creation = input).
    //
    // v0.4.12 P2 (codex audit): switched from `contains()` to
    // `provider_match()` which requires the family name to be either
    // a model-name prefix (`kimi-k2.5`, `qwen3.6-plus`, `glm-4-plus`)
    // OR appear as a provider segment (`openai/kimi-k2.5`). This
    // protects user-named models like `my-kimi-clone` from being
    // silently routed to the wrong tier while still catching real
    // model identifiers — including those with digit suffixes
    // (`qwen3.6`) that the boundary-based `has_word` would miss.
    if provider_match(&m, "glm") {
        return Some(generic_pricing(0.5, 2.0));
    }
    if provider_match(&m, "minimax") {
        return Some(generic_pricing(0.6, 2.4));
    }
    if provider_match(&m, "kimi") || provider_match(&m, "moonshot") {
        return Some(generic_pricing(0.6, 2.5));
    }
    if provider_match(&m, "mimo") {
        return Some(generic_pricing(0.4, 1.6));
    }
    if provider_match(&m, "qwen") {
        return Some(generic_pricing(0.4, 1.6));
    }
    if provider_match(&m, "doubao") {
        return Some(generic_pricing(0.3, 1.2));
    }

    None
}

/// v0.4.12 P2 — provider family name match. Recognises the prefix at the
/// start of a model name (`kimi-k2.5`, `qwen3.6-plus`) OR after a `/`
/// provider segment separator (`openai/kimi-foo`, `provider:moonshot-v1`).
/// Rejects mid-word matches (`my-kimi-clone`) which `contains()` would
/// have caught. More permissive than `has_word` for cases where the
/// suffix is a digit (Qwen versioning).
fn provider_match(model: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return false;
    }
    if model.starts_with(prefix) {
        return true;
    }
    // provider-prefixed forms: "openai/kimi-...", "proxy:moonshot-..."
    for sep in &['/', ':'] {
        let needle = format!("{sep}{prefix}");
        if model.contains(&needle) {
            return true;
        }
    }
    false
}

/// OpenAI pricing helper. cache_read = 10% of input — OpenAI's
/// documented automatic-prefix-cache discount (e.g. GPT-5.5 input 5.0
/// → cached input 0.50; GPT-5.4 2.5 → 0.25; -mini 0.75 → 0.075).
/// Previously this was input/2; Codex audit caught the mismatch.
/// cache_creation = input (OpenAI bills writes at the regular input
/// rate since caching is silent / automatic).
fn openai_pricing(input: f64, output: f64) -> ModelPricing {
    ModelPricing {
        input_cost_per_million: input,
        output_cost_per_million: output,
        cache_creation_cost_per_million: input,
        cache_read_cost_per_million: input * 0.1,
    }
}

/// Generic pricing fallback for providers that don't publish a separate
/// cache-tier rate. Approximates with cache_read = input/2 (optimistic;
/// real billing is at full input rate unless the provider quietly
/// supports prefix caching). cache_creation = input.
fn generic_pricing(input: f64, output: f64) -> ModelPricing {
    ModelPricing {
        input_cost_per_million: input,
        output_cost_per_million: output,
        cache_creation_cost_per_million: input,
        cache_read_cost_per_million: input / 2.0,
    }
}

/// Word-boundary check so model fragments like `o3` don't accidentally
/// match `gpt-5.4-nano` or `provider-prefixed-o3-foo` from earlier
/// branches. Treats `-`, `_`, `/`, `:` and start-of-string as word
/// boundaries.
fn has_word(haystack: &str, needle: &str) -> bool {
    let bytes = haystack.as_bytes();
    let nbytes = needle.as_bytes();
    if nbytes.is_empty() || bytes.len() < nbytes.len() {
        return false;
    }
    let is_boundary = |b: u8| matches!(b, b'-' | b'_' | b'/' | b':');
    let mut i = 0;
    while i + nbytes.len() <= bytes.len() {
        if &bytes[i..i + nbytes.len()] == nbytes {
            let before_ok = i == 0 || is_boundary(bytes[i - 1]);
            let after_idx = i + nbytes.len();
            let after_ok = after_idx == bytes.len() || is_boundary(bytes[after_idx]);
            if before_ok && after_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

impl TokenUsage {
    #[must_use]
    pub fn total_tokens(self) -> u32 {
        self.input_tokens
            + self.output_tokens
            + self.cache_creation_input_tokens
            + self.cache_read_input_tokens
    }

    /// Real size of the prompt that was sent — i.e. how full the context
    /// window currently is. Cached tokens (read + creation) still occupy the
    /// window, so they count alongside fresh input. This is the signal to
    /// compare against the model's context window when deciding to compact;
    /// it excludes `output_tokens`, which are generated, not prompt.
    #[must_use]
    pub fn prompt_tokens(self) -> u32 {
        self.input_tokens
            .saturating_add(self.cache_creation_input_tokens)
            .saturating_add(self.cache_read_input_tokens)
    }

    #[must_use]
    pub fn estimate_cost_usd(self) -> UsageCostEstimate {
        self.estimate_cost_usd_with_pricing(ModelPricing::default_sonnet_tier())
    }

    #[must_use]
    pub fn estimate_cost_usd_with_pricing(self, pricing: ModelPricing) -> UsageCostEstimate {
        UsageCostEstimate {
            input_cost_usd: cost_for_tokens(self.input_tokens, pricing.input_cost_per_million),
            output_cost_usd: cost_for_tokens(self.output_tokens, pricing.output_cost_per_million),
            cache_creation_cost_usd: cost_for_tokens(
                self.cache_creation_input_tokens,
                pricing.cache_creation_cost_per_million,
            ),
            cache_read_cost_usd: cost_for_tokens(
                self.cache_read_input_tokens,
                pricing.cache_read_cost_per_million,
            ),
        }
    }

    #[must_use]
    pub fn summary_lines(self, label: &str) -> Vec<String> {
        self.summary_lines_for_model(label, None)
    }

    #[must_use]
    pub fn summary_lines_for_model(self, label: &str, model: Option<&str>) -> Vec<String> {
        let pricing = model.and_then(pricing_for_model);
        let cost = pricing.map_or_else(
            || self.estimate_cost_usd(),
            |pricing| self.estimate_cost_usd_with_pricing(pricing),
        );
        let model_suffix =
            model.map_or_else(String::new, |model_name| format!(" model={model_name}"));
        let pricing_suffix = if pricing.is_some() {
            ""
        } else if model.is_some() {
            " pricing=estimated-default"
        } else {
            ""
        };
        vec![
            format!(
                "{label}: total_tokens={} input={} output={} cache_write={} cache_read={} estimated_cost={}{}{}",
                self.total_tokens(),
                self.input_tokens,
                self.output_tokens,
                self.cache_creation_input_tokens,
                self.cache_read_input_tokens,
                format_usd(cost.total_cost_usd()),
                model_suffix,
                pricing_suffix,
            ),
            format!(
                "  cost breakdown: input={} output={} cache_write={} cache_read={}",
                format_usd(cost.input_cost_usd),
                format_usd(cost.output_cost_usd),
                format_usd(cost.cache_creation_cost_usd),
                format_usd(cost.cache_read_cost_usd),
            ),
        ]
    }
}

fn cost_for_tokens(tokens: u32, usd_per_million_tokens: f64) -> f64 {
    f64::from(tokens) / 1_000_000.0 * usd_per_million_tokens
}

#[must_use]
pub fn format_usd(amount: f64) -> String {
    format!("${amount:.4}")
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UsageTracker {
    latest_turn: TokenUsage,
    cumulative: TokenUsage,
    turns: u32,
}

impl UsageTracker {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    #[must_use]
    pub fn from_session(session: &Session) -> Self {
        let mut tracker = Self::new();
        for message in &session.messages {
            if let Some(usage) = message.usage {
                tracker.record(usage);
            }
        }
        tracker
    }

    pub fn record(&mut self, usage: TokenUsage) {
        self.latest_turn = usage;
        self.cumulative.input_tokens += usage.input_tokens;
        self.cumulative.output_tokens += usage.output_tokens;
        self.cumulative.cache_creation_input_tokens += usage.cache_creation_input_tokens;
        self.cumulative.cache_read_input_tokens += usage.cache_read_input_tokens;
        self.turns += 1;
    }

    #[must_use]
    pub fn current_turn_usage(&self) -> TokenUsage {
        self.latest_turn
    }

    #[must_use]
    pub fn cumulative_usage(&self) -> TokenUsage {
        self.cumulative
    }

    #[must_use]
    pub fn turns(&self) -> u32 {
        self.turns
    }
}

#[cfg(test)]
mod tests {
    use super::{format_usd, pricing_for_model, TokenUsage, UsageTracker};
    use crate::session::{ContentBlock, ConversationMessage, MessageRole, Session};

    fn assert_pricing(model: &str, input: f64, output: f64, cache_create: f64, cache_read: f64) {
        let p = pricing_for_model(model).unwrap_or_else(|| panic!("no pricing for {model}"));
        assert_eq!(p.input_cost_per_million, input, "input for {model}");
        assert_eq!(p.output_cost_per_million, output, "output for {model}");
        assert_eq!(p.cache_creation_cost_per_million, cache_create, "cache_create for {model}");
        assert_eq!(p.cache_read_cost_per_million, cache_read, "cache_read for {model}");
    }

    #[test]
    fn tracks_true_cumulative_usage() {
        let mut tracker = UsageTracker::new();
        tracker.record(TokenUsage {
            input_tokens: 10,
            output_tokens: 4,
            cache_creation_input_tokens: 2,
            cache_read_input_tokens: 1,
        });
        tracker.record(TokenUsage {
            input_tokens: 20,
            output_tokens: 6,
            cache_creation_input_tokens: 3,
            cache_read_input_tokens: 2,
        });

        assert_eq!(tracker.turns(), 2);
        assert_eq!(tracker.current_turn_usage().input_tokens, 20);
        assert_eq!(tracker.current_turn_usage().output_tokens, 6);
        assert_eq!(tracker.cumulative_usage().output_tokens, 10);
        assert_eq!(tracker.cumulative_usage().input_tokens, 30);
        assert_eq!(tracker.cumulative_usage().total_tokens(), 48);
    }

    #[test]
    fn computes_cost_summary_lines() {
        let usage = TokenUsage {
            input_tokens: 1_000_000,
            output_tokens: 500_000,
            cache_creation_input_tokens: 100_000,
            cache_read_input_tokens: 200_000,
        };

        let cost = usage.estimate_cost_usd();
        assert_eq!(format_usd(cost.input_cost_usd), "$15.0000");
        assert_eq!(format_usd(cost.output_cost_usd), "$37.5000");
        let lines = usage.summary_lines_for_model("usage", Some("claude-sonnet-4-20250514"));
        assert!(lines[0].contains("estimated_cost=$10.9350"));
        assert!(lines[0].contains("model=claude-sonnet-4-20250514"));
        assert!(lines[1].contains("cache_read=$0.0600"));
    }

    #[test]
    fn supports_model_specific_pricing() {
        let usage = TokenUsage {
            input_tokens: 1_000_000,
            output_tokens: 500_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        };

        let haiku = pricing_for_model("claude-haiku-4-5-20251001").expect("haiku pricing");
        let opus = pricing_for_model("claude-opus-4-7").expect("opus pricing");
        let haiku_cost = usage.estimate_cost_usd_with_pricing(haiku);
        let opus_cost = usage.estimate_cost_usd_with_pricing(opus);
        assert_eq!(format_usd(haiku_cost.total_cost_usd()), "$3.5000");
        assert_eq!(format_usd(opus_cost.total_cost_usd()), "$17.5000");
    }

    #[test]
    fn marks_unknown_model_pricing_as_fallback() {
        let usage = TokenUsage {
            input_tokens: 100,
            output_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
        };
        let lines = usage.summary_lines_for_model("usage", Some("custom-model"));
        assert!(lines[0].contains("pricing=estimated-default"));
    }

    #[test]
    fn reconstructs_usage_from_session_messages() {
        let session = Session {
            version: 1,
            messages: vec![ConversationMessage {
                role: MessageRole::Assistant,
                blocks: vec![ContentBlock::Text {
                    text: "done".to_string(),
                }],
                usage: Some(TokenUsage {
                    input_tokens: 5,
                    output_tokens: 2,
                    cache_creation_input_tokens: 1,
                    cache_read_input_tokens: 0,
                }),
            }],
        };

        let tracker = UsageTracker::from_session(&session);
        assert_eq!(tracker.turns(), 1);
        assert_eq!(tracker.cumulative_usage().total_tokens(), 8);
    }

    // v0.4.13 regression — v0.4.12 P2 swapped the OSS provider lookup from
    // `contains()` to `provider_match()`. That match requires the family
    // name to appear at start-of-string OR after a `/`/`:` provider
    // separator — never mid-word. This guards against three landmines at
    // once:
    //   (a) real model names (`kimi-k2.5`, `qwen3.6-plus`, `glm-4-plus`)
    //       still resolve, including digit-suffix versions that
    //       `has_word` would miss.
    //   (b) provider-prefixed names (`openai/kimi-k2.5`) resolve via the
    //       slash branch.
    //   (c) user-named models with a family substring in the middle
    //       (`my-kimi-clone`) do NOT silently route to the wrong tier —
    //       they fall through to `None` so callers see the
    //       `pricing=estimated-default` marker.
    // Note: the start-of-string branch is intentionally permissive, so
    // `kimiclone-foo` does match — documented behaviour we want to keep
    // pinned so future tightening doesn't accidentally break the real
    // `kimi-...` names.
    #[test]
    fn provider_match_distinguishes_real_vs_userdefined() {
        // Real model names — must resolve to the family tier.
        assert!(
            pricing_for_model("qwen3.6-plus").is_some(),
            "qwen3.6-plus is a real Qwen model and must price"
        );
        assert!(
            pricing_for_model("kimi-k2.5").is_some(),
            "kimi-k2.5 is a real Kimi model and must price"
        );
        assert!(
            pricing_for_model("glm-4-plus").is_some(),
            "glm-4-plus is a real GLM model and must price"
        );

        // Provider-prefixed forms must resolve via the `/` branch.
        assert!(
            pricing_for_model("openai/kimi-k2.5").is_some(),
            "openai/kimi-k2.5 must resolve via provider-prefix branch"
        );

        // Mid-word matches must NOT route — falls through to None so
        // callers see pricing=estimated-default rather than silently
        // billing at the Kimi tier for a user model that happens to
        // contain the substring.
        assert!(
            pricing_for_model("my-kimi-clone").is_none(),
            "my-kimi-clone must NOT match Kimi family (mid-word rejection)"
        );

        // Start-of-string matches stay permissive (documented behaviour).
        assert!(
            pricing_for_model("kimiclone-foo").is_some(),
            "kimiclone-foo starts with `kimi` so the provider_match prefix branch fires"
        );
    }

    /// Current Opus (4.5–4.8) is $5/$25 — NOT the old $15/$75 deprecated tier.
    #[test]
    fn price_opus() {
        assert_pricing("claude-opus-4-8", 5.0, 25.0, 6.25, 0.5);
        assert_pricing("claude-opus-4-7", 5.0, 25.0, 6.25, 0.5);
        assert_pricing("claude-opus-4-5", 5.0, 25.0, 6.25, 0.5);
    }

    /// Deprecated Opus 4.0 / 4.1 keep the legacy $15/$75 tier. Locks the
    /// tier split so a current-minor (4.5+) never falls into legacy and a
    /// legacy id never falls into current. `has_word` boundary handling means
    /// `opus-4-1` matches 4.1 but NOT a future `opus-4-10`.
    #[test]
    fn price_opus_legacy() {
        assert_pricing("claude-opus-4-1", 15.0, 75.0, 18.75, 1.5);
        assert_pricing("claude-opus-4-20250514", 15.0, 75.0, 18.75, 1.5);
    }

    /// Sonnet 4.x is $3/$15 — NOT the deprecated $15/$75 Opus tier.
    #[test]
    fn price_sonnet() {
        assert_pricing("claude-sonnet-4-6", 3.0, 15.0, 3.75, 0.30);
        assert_pricing("claude-sonnet-4-20250514", 3.0, 15.0, 3.75, 0.30);
    }
}
