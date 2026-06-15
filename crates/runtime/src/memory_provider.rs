use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::ConversationMessage;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryProviderContext {
    pub session_id: String,
    pub project_scope: String,
    pub workspace: PathBuf,
    pub user_id: Option<String>,
}

pub trait MemoryProvider: Send {
    fn name(&self) -> &str;

    fn initialize(&mut self, _context: &MemoryProviderContext) -> Result<(), String> {
        Ok(())
    }

    fn system_prompt_block(&self) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn prefetch(&mut self, _query: &str) -> Result<Option<String>, String> {
        Ok(None)
    }

    fn sync_turn(&mut self, _user_content: &str, _assistant_content: &str) -> Result<(), String> {
        Ok(())
    }

    fn on_session_end(&mut self, _messages: &[ConversationMessage]) -> Result<(), String> {
        Ok(())
    }

    fn on_memory_write(
        &mut self,
        _action: &str,
        _target: &str,
        _content: &str,
    ) -> Result<(), String> {
        Ok(())
    }

    fn shutdown(&mut self) -> Result<(), String> {
        Ok(())
    }
}

pub struct MemoryProviderManager {
    external: Option<Box<dyn MemoryProvider>>,
}

impl MemoryProviderManager {
    #[must_use]
    pub fn new() -> Self {
        Self { external: None }
    }

    pub fn set_external(&mut self, provider: Box<dyn MemoryProvider>) -> Result<(), String> {
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

    pub fn initialize(&mut self, context: &MemoryProviderContext) -> Result<(), String> {
        if let Some(provider) = self.external.as_deref_mut() {
            provider.initialize(context)?;
        }
        Ok(())
    }

    pub fn system_prompt_block(&self) -> Option<String> {
        self.external
            .as_deref()
            .and_then(|provider| provider.system_prompt_block().ok().flatten())
    }

    pub fn prefetch(&mut self, query: &str) -> Option<String> {
        self.external
            .as_deref_mut()
            .and_then(|provider| provider.prefetch(query).ok().flatten())
    }

    pub fn sync_turn(&mut self, user_content: &str, assistant_content: &str) {
        if let Some(provider) = self.external.as_deref_mut() {
            let _ = provider.sync_turn(user_content, assistant_content);
        }
    }

    pub fn on_session_end(&mut self, messages: &[ConversationMessage]) {
        if let Some(provider) = self.external.as_deref_mut() {
            let _ = provider.on_session_end(messages);
        }
    }

    pub fn on_memory_write(&mut self, action: &str, target: &str, content: &str) {
        if let Some(provider) = self.external.as_deref_mut() {
            let _ = provider.on_memory_write(action, target, content);
        }
    }

    pub fn shutdown(&mut self) {
        if let Some(provider) = self.external.as_deref_mut() {
            let _ = provider.shutdown();
        }
    }
}

impl Default for MemoryProviderManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
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
}
