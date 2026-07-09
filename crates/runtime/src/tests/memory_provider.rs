use super::{MemoryProvider, MemoryProviderManager};

struct MockProvider;

impl MemoryProvider for MockProvider {
    fn name(&self) -> &str {
        "mock"
    }

    fn prefetch(&mut self, query: &str) -> Result<Option<String>, String> {
        Ok(Some(format!("recalled:{query}")))
    }
}

#[test]
fn manager_allows_one_external_provider() {
    let mut manager = MemoryProviderManager::new();
    manager
        .set_external(Box::new(MockProvider))
        .expect("first provider");
    assert_eq!(manager.active_provider_name(), Some("mock"));
    assert_eq!(manager.prefetch("topic").as_deref(), Some("recalled:topic"));
    assert!(manager.set_external(Box::new(MockProvider)).is_err());
}
