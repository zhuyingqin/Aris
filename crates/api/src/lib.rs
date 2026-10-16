mod client;
mod error;
mod image;
mod sse;
mod types;

pub use client::{
    apply_opencode_session_header, apply_routing_session_header,
    connection_uses_routing_session_header, is_opencode_base_url,
    oauth_token_is_expired, read_base_url, read_send_betas, resolve_saved_oauth_token,
    resolve_response_header_timeout, resolve_startup_auth_source, resolve_stream_idle_timeout,
    AnthropicClient, ApiTraceSink, AuthSource, MessageStream, OAuthTokenSet, StreamWaitPolicy,
    MAX_TIMEOUT_RESENDS, OPENCODE_SESSION_HEADER,
};
pub use error::ApiError;
pub use image::{
    composite_masked_edit, image_as_png, image_dimensions_match_with_rounding, resize_image_exact, is_image_generation_model, validate_edit_mask, validate_image_bytes, GeneratedImage, ImageApiClient, ImageEditMask,
    ImageGenerationRequest, ImageGenerationResult, ImageReference, MAX_IMAGE_BYTES,
};
pub use sse::{parse_frame, ParsedSseEvent, SseParser};
pub use types::{
    ContentBlockDelta, ContentBlockDeltaEvent, ContentBlockStartEvent, ContentBlockStopEvent,
    ImageSource, InputContentBlock, InputMessage, MessageDelta, MessageDeltaEvent, MessageRequest,
    MessageResponse, MessageStartEvent, MessageStopEvent, OutputContentBlock, StreamEvent,
    ThinkingConfig, ToolChoice, ToolDefinition, ToolResultContentBlock, Usage,
};
