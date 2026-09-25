mod client;
mod error;
mod sse;
mod types;

pub use client::{
    apply_opencode_session_header, apply_routing_session_header, is_opencode_base_url,
    oauth_token_is_expired, read_base_url, read_send_betas, resolve_saved_oauth_token,
    resolve_startup_auth_source, resolve_stream_idle_timeout, AnthropicClient, ApiTraceSink,
    AuthSource, MessageStream, OAuthTokenSet, OPENCODE_SESSION_HEADER,
};
pub use error::ApiError;
pub use sse::{parse_frame, ParsedSseEvent, SseParser};
pub use types::{
    ContentBlockDelta, ContentBlockDeltaEvent, ContentBlockStartEvent, ContentBlockStopEvent,
    ImageSource, InputContentBlock, InputMessage, MessageDelta, MessageDeltaEvent, MessageRequest,
    MessageResponse, MessageStartEvent, MessageStopEvent, OutputContentBlock, StreamEvent,
    ThinkingConfig, ToolChoice, ToolDefinition, ToolResultContentBlock, Usage,
};
