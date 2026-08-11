use std::path::PathBuf;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Isolation coordinates shared by every memory provider.  Keeping these in
/// the runtime crate makes Desktop and CLI adapters use the same mapping
/// without coupling the runtime to TencentDB's HTTP SDK.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryScope {
    pub team_id: String,
    pub agent_id: String,
    pub user_id: String,
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

impl MemoryScope {
    pub fn validate(&self) -> Result<(), String> {
        for (name, value) in [
            ("team_id", self.team_id.as_str()),
            ("agent_id", self.agent_id.as_str()),
            ("user_id", self.user_id.as_str()),
            ("session_id", self.session_id.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(format!("memory scope requires non-empty {name}"));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryProviderContext {
    pub scope: MemoryScope,
    pub project_scope: String,
    pub workspace: PathBuf,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AtomicMemory {
    pub id: String,
    pub kind: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(default)]
    pub score_millis: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScenarioMemory {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryRecall {
    pub atomic_memories: Vec<AtomicMemory>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub core_profile: Option<String>,
    pub scenario_index: Vec<ScenarioMemory>,
    #[serde(default)]
    pub manual_memories: Vec<ScenarioMemory>,
    pub latency_ms: u64,
    #[serde(default)]
    pub degraded_sources: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapturedTurn {
    pub source_event_ids: Vec<String>,
    pub user_text: String,
    pub assistant_text: String,
    pub occurred_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySearchHit {
    pub id: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default)]
    pub score_millis: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryHealthStatus {
    Stopped,
    Starting,
    Healthy,
    Degraded,
}

impl Default for MemoryHealthStatus {
    fn default() -> Self {
        Self::Stopped
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryHealth {
    pub status: MemoryHealthStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
}

/// Provider contract used by product surfaces.  Implementations must be safe
/// to call from independent chat workers; slow or failed providers return an
/// error and the caller retains the built-in memory path.
pub trait MemoryProvider: Send + Sync {
    fn name(&self) -> &str;
    fn health(&self) -> MemoryHealth;
    fn recall(&self, scope: &MemoryScope, query: &str) -> Result<MemoryRecall, String>;
    fn capture_turn(&self, scope: &MemoryScope, turn: &CapturedTurn) -> Result<(), String>;
    fn search_memories(
        &self,
        scope: &MemoryScope,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemorySearchHit>, String>;
    fn search_conversations(
        &self,
        scope: &MemoryScope,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemorySearchHit>, String>;
    fn read_scenario(&self, scope: &MemoryScope, path: &str) -> Result<Option<String>, String>;
    fn read_manual_memory(&self, scope: &MemoryScope) -> Result<Option<String>, String>;
    fn write_manual_memory(&self, scope: &MemoryScope, content: &str) -> Result<(), String>;
    fn shutdown(&self) -> Result<(), String>;
}

#[derive(Default)]
pub struct MemoryProviderManager {
    external: Option<Arc<dyn MemoryProvider>>,
}

impl MemoryProviderManager {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_external(&mut self, provider: Arc<dyn MemoryProvider>) -> Result<(), String> {
        if self.external.is_some() {
            return Err("only one external memory provider may be active".to_string());
        }
        self.external = Some(provider);
        Ok(())
    }

    #[must_use]
    pub fn active_provider_name(&self) -> Option<&str> {
        self.external.as_deref().map(MemoryProvider::name)
    }

    #[must_use]
    pub fn provider(&self) -> Option<Arc<dyn MemoryProvider>> {
        self.external.clone()
    }

    pub fn shutdown(&self) {
        if let Some(provider) = self.external.as_deref() {
            let _ = provider.shutdown();
        }
    }
}

#[cfg(test)]
#[path = "tests/memory_provider.rs"]
mod tests;
