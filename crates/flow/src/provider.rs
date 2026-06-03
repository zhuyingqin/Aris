//! Thin MiniMax (OpenAI-compatible) client for P0.
//!
//! Deliberately self-contained — it does not depend on `aris-cli`'s
//! `OpenAIRuntimeClient` (which lives in the binary crate). P1 replaces this with
//! the real `ApiClient`/`ExecutorClient` so a step can run on any provider.
//!
//! MiniMax-M2.7 is a reasoning model: it emits `<think>…</think>` inline in
//! `content`, which [`strip_think`] removes before the text is used downstream.

use std::time::Duration;

use serde_json::Value;

use crate::def::RoleRef;
use crate::error::{FlowError, Result};

const API_KEY_ENV: &str = "MINIMAX_API_KEY";
const BASE_URL_ENV: &str = "MINIMAX_BASE_URL";
const MODEL_ENV: &str = "MINIMAX_MODEL";
const REASONING_EFFORT_ENV: &str = "MINIMAX_REASONING_EFFORT";
const DEFAULT_MAX_TOKENS: u32 = 2048;
// M2.7 reasons heavily; "low" keeps a hard research prompt from blowing the token
// budget on <think> (verified: ~1.8k completion tokens, finish_reason=stop).
const DEFAULT_REASONING_EFFORT: &str = "low";
// 3 minutes: MiniMax-M2.7 reasoning completions can be slow. Kept in seconds
// deliberately (from_mins isn't a stable const fn on all supported toolchains).
#[allow(clippy::duration_suboptimal_units)]
const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);

/// A completion returned by the provider.
#[derive(Debug, Clone)]
pub struct Completion {
    /// The model output, with `<think>` blocks stripped.
    pub output: String,
    /// The raw provider `usage` object, if present.
    pub usage: Option<Value>,
}

/// A MiniMax OpenAI-compatible chat client bound to one model/endpoint.
#[derive(Debug, Clone)]
pub struct MiniMaxProvider {
    http: reqwest::blocking::Client,
    api_key: String,
    base_url: String,
    model: String,
    max_tokens: u32,
    reasoning_effort: String,
}

impl MiniMaxProvider {
    /// Build a provider from a role, applying `MINIMAX_BASE_URL` / `MINIMAX_MODEL`
    /// env overrides and reading the key from `MINIMAX_API_KEY`.
    ///
    /// # Errors
    /// Returns [`FlowError::MissingEnv`] if `MINIMAX_API_KEY` is unset/empty, or
    /// [`FlowError::Provider`] if the HTTP client cannot be built.
    pub fn from_role(role: &RoleRef) -> Result<Self> {
        let api_key = std::env::var(API_KEY_ENV)
            .ok()
            .filter(|k| !k.is_empty())
            .ok_or_else(|| FlowError::MissingEnv(API_KEY_ENV.to_string()))?;
        let base_url = env_override(BASE_URL_ENV).unwrap_or_else(|| role.base_url.clone());
        let model = env_override(MODEL_ENV).unwrap_or_else(|| role.model.clone());
        let http = reqwest::blocking::Client::builder()
            .user_agent(concat!("aris-flow/", env!("CARGO_PKG_VERSION")))
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| FlowError::Provider(format!("http client build failed: {e}")))?;
        Ok(Self {
            http,
            api_key,
            base_url,
            model,
            max_tokens: role.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
            reasoning_effort: env_override(REASONING_EFFORT_ENV)
                .unwrap_or_else(|| DEFAULT_REASONING_EFFORT.to_string()),
        })
    }

    /// The model id this provider will call (after env override).
    #[must_use]
    pub fn model(&self) -> &str {
        &self.model
    }

    /// Send a single user prompt and return the (think-stripped) completion.
    ///
    /// # Errors
    /// Returns [`FlowError::Provider`] on transport errors, non-2xx responses,
    /// MiniMax `base_resp` errors, or an unparseable / empty completion.
    pub fn complete(&self, prompt: &str) -> Result<Completion> {
        let url = format!("{}/chat/completions", self.base_url.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": self.model,
            "messages": [{ "role": "user", "content": prompt }],
            "max_tokens": self.max_tokens,
            "reasoning_effort": self.reasoning_effort,
            "stream": false,
        });

        let resp = self
            .http
            .post(&url)
            .bearer_auth(&self.api_key)
            .json(&body)
            .send()
            .map_err(|e| FlowError::Provider(format!("request to {url} failed: {e}")))?;

        let status = resp.status();
        let text = resp
            .text()
            .map_err(|e| FlowError::Provider(format!("reading response body failed: {e}")))?;
        if !status.is_success() {
            return Err(FlowError::Provider(format!(
                "{status} from {url}: {}",
                snippet(&text)
            )));
        }

        let value: Value = serde_json::from_str(&text)
            .map_err(|e| FlowError::Provider(format!("invalid JSON ({e}): {}", snippet(&text))))?;

        // MiniMax signals logical errors via base_resp.status_code even on HTTP 200.
        if let Some(code) = value
            .get("base_resp")
            .and_then(|b| b.get("status_code"))
            .and_then(Value::as_i64)
        {
            if code != 0 {
                let msg = value
                    .get("base_resp")
                    .and_then(|b| b.get("status_msg"))
                    .and_then(Value::as_str)
                    .unwrap_or("unknown");
                return Err(FlowError::Provider(format!(
                    "MiniMax base_resp {code}: {msg}"
                )));
            }
        }

        let raw = value
            .get("choices")
            .and_then(|c| c.get(0))
            .and_then(|c| c.get("message"))
            .and_then(|m| m.get("content"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                FlowError::Provider(format!("no choices[0].message.content: {}", snippet(&text)))
            })?;

        let output = strip_think(raw).trim().to_string();
        if output.is_empty() {
            return Err(FlowError::Provider(
                "completion was empty after stripping <think> (try a larger max_tokens)"
                    .to_string(),
            ));
        }
        Ok(Completion {
            output,
            usage: value.get("usage").cloned(),
        })
    }
}

fn env_override(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn snippet(s: &str) -> String {
    const MAX: usize = 300;
    if s.len() <= MAX {
        return s.to_string();
    }
    let mut end = MAX;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Remove `<think>…</think>` reasoning blocks from model content. Handles multiple
/// blocks and an unterminated trailing `<think>` (truncated output).
#[must_use]
pub fn strip_think(content: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("<think>") {
        out.push_str(&rest[..start]);
        let after = &rest[start + "<think>".len()..];
        if let Some(end) = after.find("</think>") {
            rest = &after[end + "</think>".len()..];
        } else {
            // Unterminated (truncated) — drop everything from here.
            rest = "";
            break;
        }
    }
    out.push_str(rest);
    out
}

/// Abstraction over a single-prompt completion provider. Implemented by
/// [`MiniMaxProvider`] in P0; P1 adds Anthropic/OpenAI-backed completers so a flow
/// step can run on any model (the heterogeneous-agent seam).
pub trait Completer {
    /// Send one prompt and return the completion.
    ///
    /// # Errors
    /// Provider-specific failures (transport, non-2xx, empty completion).
    fn complete(&self, prompt: &str) -> Result<Completion>;
    /// The model id this completer targets.
    fn model(&self) -> &str;
}

impl Completer for MiniMaxProvider {
    fn complete(&self, prompt: &str) -> Result<Completion> {
        MiniMaxProvider::complete(self, prompt)
    }
    fn model(&self) -> &str {
        MiniMaxProvider::model(self)
    }
}
