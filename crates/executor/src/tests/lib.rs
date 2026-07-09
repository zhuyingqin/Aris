use std::sync::{Arc, Mutex};

use api::{InputContentBlock, MessageResponse, OutputContentBlock, Usage};
use runtime::{AssistantEvent, ContentBlock, ConversationMessage, RuntimeError};

use super::{
    convert_messages, merge_anthropic_stream_usage, push_text_event, response_to_events,
    StreamObserver,
};

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

#[test]
fn anthropic_stream_usage_prefers_corrected_delta_input() {
    let start = Usage {
        input_tokens: 180_000,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 120_000,
        output_tokens: 0,
    };
    let delta = Usage {
        input_tokens: 12_000,
        cache_creation_input_tokens: 500,
        cache_read_input_tokens: 110_000,
        output_tokens: 42,
    };
    let mut input_from_delta = false;

    let usage = merge_anthropic_stream_usage(Some(&start), &delta, &mut input_from_delta);

    assert_eq!(usage.input_tokens, 12_000);
    assert_eq!(usage.output_tokens, 42);
    assert_eq!(usage.cache_creation_input_tokens, 500);
    assert_eq!(usage.cache_read_input_tokens, 110_000);
    assert!(input_from_delta);
}

#[test]
fn anthropic_stream_usage_keeps_start_cache_when_delta_omits_it() {
    let start = Usage {
        input_tokens: 180_000,
        cache_creation_input_tokens: 2_000,
        cache_read_input_tokens: 120_000,
        output_tokens: 0,
    };
    let delta = Usage {
        input_tokens: 12_000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 42,
    };
    let mut input_from_delta = false;

    let usage = merge_anthropic_stream_usage(Some(&start), &delta, &mut input_from_delta);

    assert_eq!(usage.input_tokens, 12_000);
    assert_eq!(usage.cache_creation_input_tokens, 2_000);
    assert_eq!(usage.cache_read_input_tokens, 120_000);
}

#[test]
fn convert_messages_maps_images_to_anthropic_image_blocks() {
    let messages = vec![ConversationMessage::user_blocks(vec![
        ContentBlock::Text {
            text: "describe this".to_string(),
        },
        ContentBlock::Image {
            media_type: "image/png".to_string(),
            data: "ZmFrZQ==".to_string(),
        },
    ])];

    let converted = convert_messages(&messages);

    assert_eq!(converted.len(), 1);
    assert_eq!(converted[0].role, "user");
    assert!(matches!(
        &converted[0].content[1],
        InputContentBlock::Image { source }
            if source.kind == "base64"
                && source.media_type == "image/png"
                && source.data == "ZmFrZQ=="
    ));
}

#[test]
fn coalesces_large_streams_into_one_text_event() {
    let mut events = Vec::new();
    for _ in 0..100_000 {
        push_text_event(&mut events, "x".to_string());
    }

    assert_eq!(events.len(), 1);
    assert!(matches!(
        &events[0],
        AssistantEvent::TextDelta(text) if text.len() == 100_000
    ));
}
