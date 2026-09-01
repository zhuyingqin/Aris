use crate::error::ApiError;
use crate::types::StreamEvent;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedSseEvent {
    pub event: StreamEvent,
    pub raw_data: String,
}

#[derive(Debug, Default)]
pub struct SseParser {
    buffer: Vec<u8>,
}

impl SseParser {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<StreamEvent>, ApiError> {
        Ok(self
            .push_with_raw(chunk)?
            .into_iter()
            .map(|event| event.event)
            .collect())
    }

    pub fn push_with_raw(&mut self, chunk: &[u8]) -> Result<Vec<ParsedSseEvent>, ApiError> {
        self.buffer.extend_from_slice(chunk);
        let mut events = Vec::new();

        while let Some(frame) = self.next_frame()? {
            if let Some(event) = parse_frame_with_raw(&frame)? {
                events.push(event);
            }
        }

        Ok(events)
    }

    pub fn finish(&mut self) -> Result<Vec<StreamEvent>, ApiError> {
        Ok(self
            .finish_with_raw()?
            .into_iter()
            .map(|event| event.event)
            .collect())
    }

    pub fn finish_with_raw(&mut self) -> Result<Vec<ParsedSseEvent>, ApiError> {
        if self.buffer.is_empty() {
            return Ok(Vec::new());
        }

        let trailing = std::mem::take(&mut self.buffer);
        let trailing =
            std::str::from_utf8(&trailing).map_err(|error| ApiError::InvalidSseUtf8 {
                context: "trailing SSE data",
                valid_up_to: error.valid_up_to(),
            })?;
        match parse_frame_with_raw(trailing)? {
            Some(event) => Ok(vec![event]),
            None => Ok(Vec::new()),
        }
    }

    fn next_frame(&mut self) -> Result<Option<String>, ApiError> {
        let separator = self
            .buffer
            .windows(2)
            .position(|window| window == b"\n\n")
            .map(|position| (position, 2))
            .or_else(|| {
                self.buffer
                    .windows(4)
                    .position(|window| window == b"\r\n\r\n")
                    .map(|position| (position, 4))
            });
        let Some(separator) = separator else {
            return Ok(None);
        };

        let (position, separator_len) = separator;
        let frame = self
            .buffer
            .drain(..position + separator_len)
            .collect::<Vec<_>>();
        let frame_len = frame.len().saturating_sub(separator_len);
        let frame = String::from_utf8(frame[..frame_len].to_vec()).map_err(|error| {
            ApiError::InvalidSseUtf8 {
                context: "SSE frame",
                valid_up_to: error.utf8_error().valid_up_to(),
            }
        })?;
        Ok(Some(frame))
    }
}

pub fn parse_frame(frame: &str) -> Result<Option<StreamEvent>, ApiError> {
    Ok(parse_frame_with_raw(frame)?.map(|event| event.event))
}

pub fn parse_frame_with_raw(frame: &str) -> Result<Option<ParsedSseEvent>, ApiError> {
    let trimmed = frame.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let mut data_lines = Vec::new();
    let mut event_name: Option<&str> = None;

    for line in trimmed.lines() {
        if line.starts_with(':') {
            continue;
        }
        if let Some(name) = line.strip_prefix("event:") {
            event_name = Some(name.trim());
            continue;
        }
        if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start());
        }
    }

    if matches!(event_name, Some("ping")) {
        return Ok(None);
    }

    if data_lines.is_empty() {
        return Ok(None);
    }

    let payload = data_lines.join("\n");
    if payload == "[DONE]" {
        return Ok(None);
    }

    serde_json::from_str::<StreamEvent>(&payload)
        .map(|event| {
            Some(ParsedSseEvent {
                event,
                raw_data: payload,
            })
        })
        .map_err(ApiError::from)
}

#[cfg(test)]
#[path = "tests/sse.rs"]
mod tests;
