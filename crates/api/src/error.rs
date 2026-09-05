use std::env::VarError;
use std::fmt::{Display, Formatter};
use std::time::Duration;

#[derive(Debug)]
pub enum ApiError {
    MissingApiKey,
    ExpiredOAuthToken,
    Auth(String),
    InvalidApiKeyEnv(VarError),
    Http(reqwest::Error),
    Io(std::io::Error),
    Json(serde_json::Error),
    Api {
        status: reqwest::StatusCode,
        error_type: Option<String>,
        message: Option<String>,
        body: String,
        retryable: bool,
    },
    RetriesExhausted {
        attempts: u32,
        last_error: Box<ApiError>,
    },
    InvalidSseFrame(&'static str),
    InvalidSseUtf8 {
        context: &'static str,
        valid_up_to: usize,
    },
    BackoffOverflow {
        attempt: u32,
        base_delay: Duration,
    },
}

impl ApiError {
    /// True when the API rejected the request because the model is not
    /// available on this account — Anthropic returns HTTP 404 with
    /// `error.type == "not_found_error"` for an unknown/unavailable model.
    /// Used to drive the Opus 4.8 → 4.7 fallback. Deliberately NOT matching
    /// 400, which covers a broad range of unrelated request errors.
    #[must_use]
    pub fn is_model_unavailable(&self) -> bool {
        match self {
            Self::Api {
                status, error_type, ..
            } => status.as_u16() == 404 && error_type.as_deref() == Some("not_found_error"),
            Self::RetriesExhausted { last_error, .. } => last_error.is_model_unavailable(),
            _ => false,
        }
    }

    #[must_use]
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Http(error) => error.is_connect() || error.is_timeout() || error.is_request(),
            Self::Api { retryable, .. } => *retryable,
            Self::RetriesExhausted { last_error, .. } => last_error.is_retryable(),
            // Invalid UTF-8 in an HTTP event stream means the response was
            // corrupted or cut in the middle of a code point. Retrying is
            // safer than manufacturing U+FFFD and allowing a damaged tool
            // argument to reach a mutating tool.
            Self::InvalidSseUtf8 { .. } => true,
            Self::MissingApiKey
            | Self::ExpiredOAuthToken
            | Self::Auth(_)
            | Self::InvalidApiKeyEnv(_)
            | Self::Io(_)
            | Self::Json(_)
            | Self::InvalidSseFrame(_)
            | Self::BackoffOverflow { .. } => false,
        }
    }
}

impl Display for ApiError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingApiKey => {
                write!(
                    f,
                    "ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY is not set; export one before calling the Anthropic API"
                )
            }
            Self::ExpiredOAuthToken => {
                write!(
                    f,
                    "saved OAuth token is expired and no refresh token is available"
                )
            }
            Self::Auth(message) => write!(f, "auth error: {message}"),
            Self::InvalidApiKeyEnv(error) => {
                write!(
                    f,
                    "failed to read ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY: {error}"
                )
            }
            Self::Http(error) => write!(f, "http error: {error}"),
            Self::Io(error) => write!(f, "io error: {error}"),
            Self::Json(error) => write!(f, "json error: {error}"),
            Self::Api {
                status,
                error_type,
                message,
                body,
                ..
            } => match (error_type, message) {
                (Some(error_type), Some(message)) => {
                    write!(
                        f,
                        "anthropic api returned {status} ({error_type}): {message}"
                    )
                }
                _ => write!(f, "anthropic api returned {status}: {body}"),
            },
            Self::RetriesExhausted {
                attempts,
                last_error,
            } => write!(
                f,
                "anthropic api failed after {attempts} attempts: {last_error}"
            ),
            Self::InvalidSseFrame(message) => write!(f, "invalid sse frame: {message}"),
            Self::InvalidSseUtf8 {
                context,
                valid_up_to,
            } => write!(
                f,
                "invalid UTF-8 in {context} at byte {valid_up_to}; the stream was rejected without lossy replacement",
            ),
            Self::BackoffOverflow {
                attempt,
                base_delay,
            } => write!(
                f,
                "retry backoff overflowed on attempt {attempt} with base delay {base_delay:?}"
            ),
        }
    }
}

impl std::error::Error for ApiError {}

impl From<reqwest::Error> for ApiError {
    fn from(value: reqwest::Error) -> Self {
        Self::Http(value)
    }
}

impl From<std::io::Error> for ApiError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value)
    }
}

impl From<serde_json::Error> for ApiError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

impl From<VarError> for ApiError {
    fn from(value: VarError) -> Self {
        Self::InvalidApiKeyEnv(value)
    }
}

#[cfg(test)]
#[path = "tests/error.rs"]
mod tests;
