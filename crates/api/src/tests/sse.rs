use super::{parse_frame, SseParser};
use crate::types::{ContentBlockDelta, MessageDelta, OutputContentBlock, StreamEvent, Usage};

#[test]
fn parses_single_frame() {
    let frame = concat!(
        "event: content_block_start\n",
        "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Hi\"}}\n\n"
    );

    let event = parse_frame(frame).expect("frame should parse");
    assert_eq!(
        event,
        Some(StreamEvent::ContentBlockStart(
            crate::types::ContentBlockStartEvent {
                index: 0,
                content_block: OutputContentBlock::Text {
                    text: "Hi".to_string(),
                },
            },
        ))
    );
}

#[test]
fn parses_chunked_stream() {
    let mut parser = SseParser::new();
    let first = b"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hel";
    let second = b"lo\"}}\n\n";

    assert!(parser
        .push(first)
        .expect("first chunk should buffer")
        .is_empty());
    let events = parser.push(second).expect("second chunk should parse");

    assert_eq!(
        events,
        vec![StreamEvent::ContentBlockDelta(
            crate::types::ContentBlockDeltaEvent {
                index: 0,
                delta: ContentBlockDelta::TextDelta {
                    text: "Hello".to_string(),
                },
            }
        )]
    );
}

#[test]
fn ignores_ping_and_done() {
    let mut parser = SseParser::new();
    let payload = concat!(
        ": keepalive\n",
        "event: ping\n",
        "data: {\"type\":\"ping\"}\n\n",
        "event: message_delta\n",
        "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\",\"stop_sequence\":null},\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}\n\n",
        "event: message_stop\n",
        "data: {\"type\":\"message_stop\"}\n\n",
        "data: [DONE]\n\n"
    );

    let events = parser
        .push(payload.as_bytes())
        .expect("parser should succeed");
    assert_eq!(
        events,
        vec![
            StreamEvent::MessageDelta(crate::types::MessageDeltaEvent {
                delta: MessageDelta {
                    stop_reason: Some("tool_use".to_string()),
                    stop_sequence: None,
                },
                usage: Usage {
                    input_tokens: 1,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                    output_tokens: 2,
                },
            }),
            StreamEvent::MessageStop(crate::types::MessageStopEvent {}),
        ]
    );
}

#[test]
fn ignores_data_less_event_frames() {
    let frame = "event: ping\n\n";
    let event = parse_frame(frame).expect("frame without data should be ignored");
    assert_eq!(event, None);
}

#[test]
fn parses_split_json_across_data_lines() {
    let frame = concat!(
        "event: content_block_delta\n",
        "data: {\"type\":\"content_block_delta\",\"index\":0,\n",
        "data: \"delta\":{\"type\":\"text_delta\",\"text\":\"Hello\"}}\n\n"
    );

    let event = parse_frame(frame).expect("frame should parse");
    assert_eq!(
        event,
        Some(StreamEvent::ContentBlockDelta(
            crate::types::ContentBlockDeltaEvent {
                index: 0,
                delta: ContentBlockDelta::TextDelta {
                    text: "Hello".to_string(),
                },
            }
        ))
    );
}
