//! Model requests can outlive a short HTTP deadline while still making progress. Bound
//! connection setup, upstream silence and received bytes separately; the caller owns the
//! turn deadline and cancellation, including time spent retrying.

use std::time::Duration;

use anyhow::{Context, Result, bail};

use crate::upstream_error::UpstreamFailure;

pub(crate) const DEFAULT_MAX_RESPONSE_BYTES: usize = 64 * 1024 * 1024;

pub(crate) struct ModelTransportConfig {
    connect_timeout: Duration,
    read_timeout: Duration,
    pub(crate) max_response_bytes: usize,
}

impl ModelTransportConfig {
    pub(crate) fn from_env() -> Result<Self> {
        Ok(Self {
            connect_timeout: Duration::from_millis(positive_env(
                "PROXY_MODEL_CONNECT_TIMEOUT_MS",
                30_000,
            )?),
            read_timeout: Duration::from_millis(positive_env(
                "PROXY_MODEL_READ_TIMEOUT_MS",
                600_000,
            )?),
            max_response_bytes: usize::try_from(positive_env(
                "PROXY_MODEL_MAX_RESPONSE_BYTES",
                DEFAULT_MAX_RESPONSE_BYTES as u64,
            )?)
            .context("PROXY_MODEL_MAX_RESPONSE_BYTES is too large for this platform")?,
        })
    }

    pub(crate) fn http_client(&self) -> Result<reqwest::Client> {
        reqwest::Client::builder()
            .connect_timeout(self.connect_timeout)
            // A successful read resets this timer. Do not add a total `.timeout`: that
            // cuts off healthy long responses even while upstream is sending events.
            .read_timeout(self.read_timeout)
            .build()
            .context("failed to create model HTTP client")
    }
}

fn positive_env(name: &str, default: u64) -> Result<u64> {
    let value = match std::env::var(name) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => bail!("{name} must be a positive integer"),
    };
    positive_value(name, value.as_deref(), default)
}

fn positive_value(name: &str, value: Option<&str>, default: u64) -> Result<u64> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => Ok(default),
        Some(value) => value
            .parse::<u64>()
            .ok()
            .filter(|value| *value > 0)
            .with_context(|| format!("{name} must be a positive integer")),
    }
}

/// Counts wire-body bytes, including SSE framing and comments. This bounds the aggregate
/// retained output and read-ahead as well as buffered responses, not just one SSE event.
pub(crate) struct ResponseBodyLimit {
    remaining: usize,
}

impl ResponseBodyLimit {
    pub(crate) fn new(max_bytes: usize) -> Self {
        Self {
            remaining: max_bytes,
        }
    }

    pub(crate) fn receive(&mut self, bytes: usize) -> Result<()> {
        self.remaining = self
            .remaining
            .checked_sub(bytes)
            .ok_or(UpstreamFailure::ResponseTooLarge)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_require_positive_integers_without_echoing_invalid_values() {
        assert_eq!(positive_value("SETTING", None, 30).unwrap(), 30);
        assert_eq!(positive_value("SETTING", Some(" "), 30).unwrap(), 30);
        assert_eq!(
            positive_value("SETTING", Some(" 600000 "), 30).unwrap(),
            600000
        );
        for value in ["0", "-1", "1.5", "not-a-number", "18446744073709551616"] {
            assert_eq!(
                positive_value("SETTING", Some(value), 30)
                    .unwrap_err()
                    .to_string(),
                "SETTING must be a positive integer"
            );
        }
    }

    #[test]
    fn body_limit_counts_all_chunks_and_rejects_overflow() {
        let mut limit = ResponseBodyLimit::new(10);
        limit.receive(6).unwrap();
        limit.receive(4).unwrap();
        let error = limit.receive(1).unwrap_err();
        let classified = crate::upstream_error::classify(&error);
        assert_eq!(classified.code, "upstream_response_too_large");
        assert!(!classified.retryable);
        assert!(ResponseBodyLimit::new(10).receive(usize::MAX).is_err());
    }
}
