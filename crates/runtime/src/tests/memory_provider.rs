use std::sync::Arc;

use super::{
    CapturedTurn, MemoryHealth, MemoryProvider, MemoryProviderManager, MemoryRecall, MemoryScope,
    MemorySearchHit,
};

struct MockProvider;

impl MemoryProvider for MockProvider {
    fn name(&self) -> &str {
        "mock"
    }

    fn health(&self) -> MemoryHealth {
        MemoryHealth::default()
    }

    fn recall(&self, _scope: &MemoryScope, query: &str) -> Result<MemoryRecall, String> {
        Ok(MemoryRecall {
            core_profile: Some(format!("recalled:{query}")),
            ..MemoryRecall::default()
        })
    }

    fn capture_turn(&self, _scope: &MemoryScope, _turn: &CapturedTurn) -> Result<(), String> {
        Ok(())
    }

    fn search_memories(
        &self,
        _scope: &MemoryScope,
        _query: &str,
        _limit: usize,
    ) -> Result<Vec<MemorySearchHit>, String> {
        Ok(Vec::new())
    }

    fn search_conversations(
        &self,
        _scope: &MemoryScope,
        _query: &str,
        _limit: usize,
    ) -> Result<Vec<MemorySearchHit>, String> {
        Ok(Vec::new())
    }

    fn read_scenario(&self, _scope: &MemoryScope, _path: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn read_manual_memory(&self, _scope: &MemoryScope) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn write_manual_memory(&self, _scope: &MemoryScope, _content: &str) -> Result<(), String> {
        Ok(())
    }

    fn shutdown(&self) -> Result<(), String> {
        Ok(())
    }
}

fn scope() -> MemoryScope {
    MemoryScope {
        team_id: "somniq-local".to_string(),
        agent_id: "project:test:executor".to_string(),
        user_id: "user-test".to_string(),
        session_id: "session-test".to_string(),
        task_id: None,
    }
}

#[test]
fn manager_allows_one_external_provider() {
    let mut manager = MemoryProviderManager::new();
    manager
        .set_external(Arc::new(MockProvider))
        .expect("first provider");
    assert_eq!(manager.active_provider_name(), Some("mock"));
    let recall = manager
        .provider()
        .expect("provider")
        .recall(&scope(), "topic")
        .expect("recall");
    assert_eq!(recall.core_profile.as_deref(), Some("recalled:topic"));
    assert!(manager.set_external(Arc::new(MockProvider)).is_err());
}

#[test]
fn scope_rejects_missing_isolation_fields() {
    let mut invalid = scope();
    invalid.agent_id.clear();
    assert!(invalid.validate().is_err());
}
