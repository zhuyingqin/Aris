//! Shared, isolated single-request execution for paid artifact workflows.
use crate::{ExecutorClient, StreamObserver};
use runtime::{ApiClient, ApiRequest, AssistantEvent, RuntimeError, TokenUsage};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Default, Clone, Debug)]
pub struct ModelReply {
    pub text: String,
    pub usage: Option<TokenUsage>,
    pub stop_reason: Option<String>,
    pub error: Option<String>,
}

struct Observer {
    cancelled: Arc<AtomicBool>,
    text: Arc<Mutex<String>>,
}
impl StreamObserver for Observer {
    fn on_text_delta(&mut self, value: &str) -> Result<(), RuntimeError> {
        self.text
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push_str(value);
        Ok(())
    }
    fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
}

pub fn perform(
    build: impl FnOnce(Box<dyn StreamObserver>) -> Result<ExecutorClient, String>,
    session_id: &str,
    request: ApiRequest,
    cancelled: Arc<AtomicBool>,
) -> Result<ModelReply, String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err("Task cancelled before submission".into());
    }
    let partial = Arc::new(Mutex::new(String::new()));
    let mut client = build(Box::new(Observer {
        cancelled,
        text: partial.clone(),
    }))?;
    client.set_session_id(session_id);
    match client.stream(request) {
        Ok(events) => Ok(collect(events)),
        Err(error) => Ok(ModelReply {
            text: partial.lock().unwrap_or_else(|e| e.into_inner()).clone(),
            error: Some(error.to_string()),
            ..ModelReply::default()
        }),
    }
}

pub fn collect(events: Vec<AssistantEvent>) -> ModelReply {
    let mut reply = ModelReply::default();
    for event in events {
        match event {
            AssistantEvent::TextDelta(text) => reply.text.push_str(&text),
            AssistantEvent::Usage(usage) => reply.usage = Some(usage),
            AssistantEvent::StopReason(reason) => reply.stop_reason = Some(reason),
            _ => {}
        }
    }
    reply
}

pub fn is_budget_truncated(reason: Option<&str>) -> bool {
    matches!(
        reason,
        Some("length" | "max_tokens" | "max_output_tokens" | "max_output")
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retains_provider_stop_reason_separately_from_svg_validity() {
        let reply = collect(vec![
            AssistantEvent::TextDelta("<svg".into()),
            AssistantEvent::Usage(TokenUsage {
                output_tokens: 8192,
                ..TokenUsage::default()
            }),
            AssistantEvent::StopReason("length".into()),
        ]);
        assert!(is_budget_truncated(reply.stop_reason.as_deref()));
        assert_eq!(reply.usage.unwrap().output_tokens, 8192);
        assert!(!is_budget_truncated(Some("stream_truncated")));
    }
}
