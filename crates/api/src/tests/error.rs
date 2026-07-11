use super::ApiError;

fn api(status: reqwest::StatusCode, error_type: Option<&str>) -> ApiError {
    ApiError::Api {
        status,
        error_type: error_type.map(str::to_string),
        message: Some("model: claude-opus-4-8".to_string()),
        body: String::new(),
        retryable: false,
    }
}

#[test]
fn model_unavailable_only_on_404_not_found() {
    assert!(api(reqwest::StatusCode::NOT_FOUND, Some("not_found_error")).is_model_unavailable());
    assert!(!api(reqwest::StatusCode::NOT_FOUND, Some("rate_limit_error")).is_model_unavailable());
    assert!(!api(reqwest::StatusCode::BAD_REQUEST, Some("not_found_error")).is_model_unavailable());
    assert!(!api(
        reqwest::StatusCode::TOO_MANY_REQUESTS,
        Some("not_found_error")
    )
    .is_model_unavailable());
    assert!(!ApiError::MissingApiKey.is_model_unavailable());
}

#[test]
fn model_unavailable_unwraps_retries_exhausted() {
    let inner = api(reqwest::StatusCode::NOT_FOUND, Some("not_found_error"));
    let exhausted = ApiError::RetriesExhausted {
        attempts: 3,
        last_error: Box::new(inner),
    };
    assert!(exhausted.is_model_unavailable());
}
