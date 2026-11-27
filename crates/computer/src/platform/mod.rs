//! Platform backends. Only Windows exists in R0; macOS keeps no stub because
//! nothing calls into the backend generically yet.

#[cfg(windows)]
pub mod windows;
