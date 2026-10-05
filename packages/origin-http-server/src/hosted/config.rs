//! Settings only the hosted gateway reads. They are kept apart from
//! [`crate::config::ServerConfig`], which single-tenant origins (hosted
//! runtimes and Desktop) build in many places.

use anyhow::{bail, Result};

/// The default soft cap of the mirror cache: 20 GiB.
pub const DEFAULT_CACHE_MAX_BYTES: u64 = 20 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostedGatewayConfig {
    /// Soft cap of the mirror cache, in bytes (`ORIGIN_CACHE_MAX_BYTES`).
    /// Only mirrors nobody used for an hour are removed to stay under it.
    pub cache_max_bytes: u64,
}

impl Default for HostedGatewayConfig {
    fn default() -> Self {
        Self {
            cache_max_bytes: DEFAULT_CACHE_MAX_BYTES,
        }
    }
}

impl HostedGatewayConfig {
    /// The settings from the value of `ORIGIN_CACHE_MAX_BYTES` (unset or
    /// blank: the default). Anything but a positive whole number of bytes
    /// stops the gateway from starting.
    pub fn from_cache_max_bytes(value: Option<&str>) -> Result<Self> {
        let cache_max_bytes = match value.map(str::trim).filter(|value| !value.is_empty()) {
            None => DEFAULT_CACHE_MAX_BYTES,
            Some(raw) => match raw.parse::<u64>() {
                Ok(bytes) if bytes > 0 && raw.bytes().all(|byte| byte.is_ascii_digit()) => bytes,
                _ => bail!("ORIGIN_CACHE_MAX_BYTES must be a positive whole number of bytes"),
            },
        };
        Ok(Self { cache_max_bytes })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cache_cap_defaults_and_must_be_a_positive_byte_count() {
        assert_eq!(
            HostedGatewayConfig::from_cache_max_bytes(None).unwrap(),
            HostedGatewayConfig::default()
        );
        assert_eq!(
            HostedGatewayConfig::from_cache_max_bytes(Some("  "))
                .unwrap()
                .cache_max_bytes,
            DEFAULT_CACHE_MAX_BYTES
        );
        assert_eq!(
            HostedGatewayConfig::from_cache_max_bytes(Some(" 1048576 "))
                .unwrap()
                .cache_max_bytes,
            1_048_576
        );
        for bad in [
            "0",
            "-1",
            "+5",
            "1.5",
            "20GiB",
            "1e9",
            "18446744073709551616",
        ] {
            let error = HostedGatewayConfig::from_cache_max_bytes(Some(bad))
                .expect_err(bad)
                .to_string();
            assert!(error.contains("ORIGIN_CACHE_MAX_BYTES"), "{error}");
        }
    }
}
