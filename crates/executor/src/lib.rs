//! Shared executor layer for ARIS.
//!
//! This crate owns provider request/stream parsing. UI surfaces pass in a
//! [`StreamObserver`] for rendering or event emission; the executor itself only
//! returns normalized [`runtime::AssistantEvent`] values.

use api::{
    AnthropicClient, AuthSource, ContentBlockDelta, InputContentBlock, InputMessage,
    MessageRequest, MessageResponse, OutputContentBlock, StreamEvent as ApiStreamEvent, ToolChoice,
    ToolDefinition, ToolResultContentBlock,
};
use runtime::{
    ApiClient, ApiRequest, AssistantEvent, ContentBlock, ConversationMessage, MessageRole,
    RuntimeError, TokenUsage,
};
use serde_json::json;

mod openai;

pub use openai::{resolve_openai_executor_config, OpenAIExecutorConfig, OpenAIRuntimeClient};

#[derive(Debug, Clone)]
pub struct ExecutorToolSpec {
    pub name: String,
    pub description: String,
    pub input_schema: serde_json::Value,
}

impl ExecutorToolSpec {
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        input_schema: serde_json::Value,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema,
        }
    }
}

pub trait StreamObserver: Send {
    fn on_text_delta(&mut self, _text: &str) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn on_thinking_delta(&mut self, _thinking: &str) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn on_tool_call(&mut self, _id: &str, _name: &str, _input: &str) -> Result<(), RuntimeError> {
        Ok(())
    }

    fn on_message_stop(&mut self) -> Result<(), RuntimeError> {
        Ok(())
    }
}

pub struct NoopStreamObserver;

impl StreamObserver for NoopStreamObserver {}

pub enum ExecutorClient {
    Anthropic(AnthropicRuntimeClient),
    OpenAI(OpenAIRuntimeClient),
}

impl ApiClient for ExecutorClient {
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        match self {
            Self::Anthropic(client) => client.stream(request),
            Self::OpenAI(client) => client.stream(request),
        }
    }

    fn on_session_compacted(&mut self, removed_count: usize) {
        match self {
            Self::Anthropic(_) => {}
            Self::OpenAI(client) => client.on_session_compacted(removed_count),
        }
    }
}

pub struct AnthropicRuntimeClient {
    runtime: tokio::runtime::Runtime,
    client: AnthropicClient,
    model: String,
    enable_tools: bool,
    tool_specs: Vec<ExecutorToolSpec>,
    max_tokens: u32,
    observer: Box<dyn StreamObserver>,
}

impl AnthropicRuntimeClient {
    pub fn new(
        auth: AuthSource,
        base_url: String,
        send_betas: bool,
        model: String,
        enable_tools: bool,
        tool_specs: Vec<ExecutorToolSpec>,
        max_tokens: u32,
        observer: Box<dyn StreamObserver>,
    ) -> Result<Self, String> {
        Ok(Self {
            runtime: tokio::runtime::Runtime::new().map_err(|error| error.to_string())?,
            client: AnthropicClient::from_auth(auth)
                .with_base_url(base_url)
                .with_send_betas(send_betas),
            model,
            enable_tools,
            tool_specs,
            max_tokens,
            observer,
        })
    }
}

impl ApiClient for AnthropicRuntimeClient {
    #[allow(clippy::too_many_lines)]
    fn stream(&mut self, request: ApiRequest) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let message_request = MessageRequest {
            model: self.model.clone(),
            max_tokens: self.max_tokens,
            messages: convert_messages(&request.messages),
            system: if request.system_prompt.is_empty() {
                None
            } else {
                let prompt = request.system_prompt.join("\n\n");
                let is_oauth = self.client.auth_source().bearer_token().is_some()
                    && self.client.auth_source().api_key().is_none();
                let cache_control = if is_oauth {
                    json!({ "type": "ephemeral", "ttl": "1h" })
                } else {
                    json!({ "type": "ephemeral" })
                };
                Some(json!([{
                    "type": "text",
                    "text": prompt,
                    "cache_control": cache_control
                }]))
            },
            tools: self.enable_tools.then(|| {
                self.tool_specs
                    .iter()
                    .map(|spec| ToolDefinition {
                        name: spec.name.clone(),
                        description: Some(spec.description.clone()),
                        input_schema: spec.input_schema.clone(),
                    })
                    .collect()
            }),
            tool_choice: self.enable_tools.then_some(ToolChoice::Auto),
            stream: true,
        };

        let client = &self.client;
        let observer = &mut self.observer;
        self.runtime.block_on(async {
            let mut stream = client
                .stream_message(&message_request)
                .await
                .map_err(|error| RuntimeError::new(error.to_string()))?;
            let mut events = Vec::new();
            let mut pending_tool: Option<(String, String, String)> = None;
            let mut pending_thinking: Option<(String, String)> = None;
            let mut saw_stop = false;
            let mut start_usage: Option<api::Usage> = None;

            while let Some(event) = stream
                .next_event()
                .await
                .map_err(|error| RuntimeError::new(error.to_string()))?
            {
                if runtime::is_interrupted() {
                    runtime::clear_interrupt();
                    return Err(RuntimeError::new("interrupted by user"));
                }
                match event {
                    ApiStreamEvent::MessageStart(start) => {
                        start_usage = Some(start.message.usage.clone());
                        for block in start.message.content {
                            push_output_block(block, observer, &mut events, &mut pending_tool)?;
                        }
                    }
                    ApiStreamEvent::ContentBlockStart(start) => {
                        if let OutputContentBlock::Thinking {
                            thinking,
                            signature,
                        } = &start.content_block
                        {
                            if !thinking.is_empty() {
                                observer.on_thinking_delta(thinking)?;
                            }
                            pending_thinking = Some((thinking.clone(), signature.clone()));
                        } else {
                            push_output_block(
                                start.content_block,
                                observer,
                                &mut events,
                                &mut pending_tool,
                            )?;
                        }
                    }
                    ApiStreamEvent::ContentBlockDelta(delta) => match delta.delta {
                        ContentBlockDelta::TextDelta { text } => {
                            if !text.is_empty() {
                                observer.on_text_delta(&text)?;
                                events.push(AssistantEvent::TextDelta(text));
                            }
                        }
                        ContentBlockDelta::InputJsonDelta { partial_json } => {
                            if let Some((_, _, input)) = &mut pending_tool {
                                input.push_str(&partial_json);
                            }
                        }
                        ContentBlockDelta::ThinkingDelta { thinking } => {
                            if let Some((text, _)) = &mut pending_thinking {
                                text.push_str(&thinking);
                            }
                            if !thinking.is_empty() {
                                observer.on_thinking_delta(&thinking)?;
                            }
                        }
                        ContentBlockDelta::SignatureDelta { signature } => {
                            if let Some((_, sig)) = &mut pending_thinking {
                                *sig = signature;
                            }
                        }
                    },
                    ApiStreamEvent::ContentBlockStop(_) => {
                        if let Some((id, name, input)) = pending_tool.take() {
                            observer.on_tool_call(&id, &name, &input)?;
                            events.push(AssistantEvent::ToolUse { id, name, input });
                        }
                        if let Some((thinking, signature)) = pending_thinking.take() {
                            events.push(AssistantEvent::Thinking {
                                thinking,
                                signature,
                            });
                        }
                    }
                    ApiStreamEvent::MessageDelta(delta) => {
                        let start = start_usage.as_ref();
                        events.push(AssistantEvent::Usage(TokenUsage {
                            input_tokens: start
                                .map_or(delta.usage.input_tokens, |usage| usage.input_tokens),
                            output_tokens: delta.usage.output_tokens,
                            cache_creation_input_tokens: start
                                .map_or(delta.usage.cache_creation_input_tokens, |usage| {
                                    usage.cache_creation_input_tokens
                                }),
                            cache_read_input_tokens: start
                                .map_or(delta.usage.cache_read_input_tokens, |usage| {
                                    usage.cache_read_input_tokens
                                }),
                        }));
                    }
                    ApiStreamEvent::MessageStop(_) => {
                        saw_stop = true;
                        observer.on_message_stop()?;
                        events.push(AssistantEvent::MessageStop);
                    }
                    ApiStreamEvent::Error(error) => {
                        let msg = error
                            .error
                            .get("message")
                            .and_then(|value| value.as_str())
                            .unwrap_or("stream error")
                            .to_string();
                        return Err(RuntimeError::new(msg));
                    }
                }
            }

            if !saw_stop
                && events.iter().any(|event| {
                    matches!(event, AssistantEvent::TextDelta(text) if !text.is_empty())
                        || matches!(event, AssistantEvent::ToolUse { .. })
                })
            {
                observer.on_message_stop()?;
                events.push(AssistantEvent::MessageStop);
            }

            if events
                .iter()
                .any(|event| matches!(event, AssistantEvent::MessageStop))
            {
                return Ok(events);
            }

            let response = client
                .send_message(&MessageRequest {
                    stream: false,
                    ..message_request.clone()
                })
                .await
                .map_err(|error| RuntimeError::new(error.to_string()))?;
            response_to_events(response, observer)
        })
    }
}

fn push_output_block(
    block: OutputContentBlock,
    observer: &mut Box<dyn StreamObserver>,
    events: &mut Vec<AssistantEvent>,
    pending_tool: &mut Option<(String, String, String)>,
) -> Result<(), RuntimeError> {
    match block {
        OutputContentBlock::Text { text } => {
            if !text.is_empty() {
                observer.on_text_delta(&text)?;
                events.push(AssistantEvent::TextDelta(text));
            }
        }
        OutputContentBlock::ToolUse { id, name, input } => {
            let input_json = if input.is_null() || input == json!({}) {
                String::new()
            } else {
                input.to_string()
            };
            *pending_tool = Some((id, name, input_json));
        }
        OutputContentBlock::Thinking {
            thinking,
            signature,
        } => {
            if !thinking.is_empty() {
                observer.on_thinking_delta(&thinking)?;
            }
            events.push(AssistantEvent::Thinking {
                thinking,
                signature,
            });
        }
    }
    Ok(())
}

fn response_to_events(
    response: MessageResponse,
    observer: &mut Box<dyn StreamObserver>,
) -> Result<Vec<AssistantEvent>, RuntimeError> {
    let mut events = Vec::new();
    for block in response.content {
        match block {
            OutputContentBlock::Text { text } => {
                if !text.is_empty() {
                    observer.on_text_delta(&text)?;
                    events.push(AssistantEvent::TextDelta(text));
                }
            }
            OutputContentBlock::ToolUse { id, name, input } => {
                let input_json = if input.is_null() || input == json!({}) {
                    String::new()
                } else {
                    input.to_string()
                };
                observer.on_tool_call(&id, &name, &input_json)?;
                events.push(AssistantEvent::ToolUse {
                    id,
                    name,
                    input: input_json,
                });
            }
            OutputContentBlock::Thinking {
                thinking,
                signature,
            } => {
                if !thinking.is_empty() {
                    observer.on_thinking_delta(&thinking)?;
                }
                events.push(AssistantEvent::Thinking {
                    thinking,
                    signature,
                });
            }
        }
    }
    observer.on_message_stop()?;
    events.push(AssistantEvent::MessageStop);
    Ok(events)
}

fn convert_messages(messages: &[ConversationMessage]) -> Vec<InputMessage> {
    messages
        .iter()
        .filter_map(|message| {
            let role = match message.role {
                MessageRole::System | MessageRole::User | MessageRole::Tool => "user",
                MessageRole::Assistant => "assistant",
            };
            let content = message
                .blocks
                .iter()
                .map(|block| match block {
                    ContentBlock::Text { text } => InputContentBlock::Text { text: text.clone() },
                    ContentBlock::ToolUse { id, name, input } => InputContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: serde_json::from_str(input).unwrap_or_else(|_| json!({})),
                    },
                    ContentBlock::ToolResult {
                        tool_use_id,
                        output,
                        is_error,
                        ..
                    } => InputContentBlock::ToolResult {
                        tool_use_id: tool_use_id.clone(),
                        content: vec![ToolResultContentBlock::Text {
                            text: output.clone(),
                        }],
                        is_error: *is_error,
                    },
                    ContentBlock::Thinking {
                        thinking,
                        signature,
                    } => InputContentBlock::Thinking {
                        thinking: thinking.clone(),
                        signature: signature.clone(),
                    },
                })
                .collect::<Vec<_>>();
            (!content.is_empty()).then(|| InputMessage {
                role: role.to_string(),
                content,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use api::{MessageResponse, OutputContentBlock, Usage};
    use runtime::RuntimeError;

    use super::{response_to_events, StreamObserver};

    struct RecordingObserver {
        deltas: Arc<Mutex<Vec<String>>>,
    }

    impl StreamObserver for RecordingObserver {
        fn on_text_delta(&mut self, text: &str) -> Result<(), RuntimeError> {
            self.deltas.lock().unwrap().push(format!("text:{text}"));
            Ok(())
        }

        fn on_thinking_delta(&mut self, thinking: &str) -> Result<(), RuntimeError> {
            self.deltas
                .lock()
                .unwrap()
                .push(format!("thinking:{thinking}"));
            Ok(())
        }
    }

    #[test]
    fn response_notifies_observer_about_thinking_blocks() {
        let deltas = Arc::new(Mutex::new(Vec::new()));
        let mut observer: Box<dyn StreamObserver> = Box::new(RecordingObserver {
            deltas: Arc::clone(&deltas),
        });
        let response = MessageResponse {
            id: "msg-test".to_string(),
            kind: "message".to_string(),
            role: "assistant".to_string(),
            content: vec![
                OutputContentBlock::Thinking {
                    thinking: "inspect".to_string(),
                    signature: String::new(),
                },
                OutputContentBlock::Text {
                    text: "answer".to_string(),
                },
            ],
            model: "test-model".to_string(),
            stop_reason: Some("end_turn".to_string()),
            stop_sequence: None,
            usage: Usage {
                input_tokens: 1,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 0,
                output_tokens: 2,
            },
            request_id: None,
        };

        response_to_events(response, &mut observer).unwrap();

        assert_eq!(
            *deltas.lock().unwrap(),
            vec!["thinking:inspect".to_string(), "text:answer".to_string()]
        );
    }
}
