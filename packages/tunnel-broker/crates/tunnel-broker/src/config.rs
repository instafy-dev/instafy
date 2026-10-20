use anyhow::{Context, Result};
use std::{env, net::IpAddr};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct BrokerConfig {
    pub database_url: String,
    pub database_pool_size: u32,
    pub rathole_config_notify_channel: String,
    pub http_bind: String,
    pub tunnel_domain: String,
    pub ingress_host: String,
    pub ingress_port: u16,
    /// Public-facing ingress port for end-user URLs (may differ from rathole control port).
    pub public_ingress_port: u16,
    pub ingress_ipv4: Option<IpAddr>,
    pub ingress_ipv6: Option<IpAddr>,
    pub rathole_shared_token: Option<String>,
    pub rathole_port_range_start: i32,
    pub rathole_port_range_end: i32,
    pub default_ttl_seconds: i32,
    pub token_signing_key: String,
    pub api_tokens: Vec<String>,
    pub token_issuer: String,
    pub token_audience: Option<String>,
    pub token_ttl_seconds: i64,
    /// Optional Traefik certificate resolver name (e.g. "le") to include in rendered dynamic
    /// config. When unset, sidecars omit TLS config so plain HTTP routes work without ACME.
    pub traefik_cert_resolver: Option<String>,
    pub acl_hook: Option<HookConfig>,
    pub event_hook: Option<HookConfig>,
    /// Private preview routing. `None` when `PREVIEW_DOMAIN` or `PREVIEW_AUTH_ADDRESS` is unset
    /// or invalid; private bindings then render no router and private tunnels are refused.
    pub preview: Option<PreviewConfig>,
    /// Controller hook that decides each preview capability (`PREVIEW_AUTH_HOOK_URL`, called
    /// with the `ACL_HOOK_TOKEN` bearer). Without it every preview request is denied.
    pub preview_auth_hook: Option<HookConfig>,
    /// Upper bound for `labels.kind == "preview"` tunnels, which outlive the token TTL cap.
    pub preview_max_ttl_seconds: i64,
    /// Host the broker dials to probe a binding's rathole port.
    pub rathole_upstream_host: String,
}

#[derive(Debug, Clone)]
pub struct HookConfig {
    pub url: String,
    pub token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PreviewConfig {
    /// Registrable domain that carries `p-<label>--<tunnel>.<domain>` capability hosts.
    pub domain: String,
    /// Broker base URL as Traefik sees it; serves `/preview-auth` and `/preview-error/:status`.
    /// Only the ingress renderer reads it.
    #[allow(dead_code)]
    pub auth_address: String,
}

pub const DEFAULT_PREVIEW_MAX_TTL_SECONDS: i64 = 43_200;

impl BrokerConfig {
    pub fn from_env() -> Result<Self> {
        dotenvy::dotenv().ok();

        let database_url =
            env::var("DATABASE_URL").context("DATABASE_URL env var missing for tunnel broker")?;
        let database_pool_size = env::var("DATABASE_POOL_SIZE")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(1);
        let http_bind = env::var("HTTP_BIND").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
        let rathole_config_notify_channel = env::var("RATHOLE_CONFIG_NOTIFY_CHANNEL")
            .unwrap_or_else(|_| "tunnel_config_refresh".to_string());
        let tunnel_domain = env::var("TUNNEL_DOMAIN").unwrap_or_else(|_| "rt.test".to_string());
        let ingress_host =
            env::var("INGRESS_HOST").unwrap_or_else(|_| format!("ingress.{tunnel_domain}"));
        let ingress_port = env::var("INGRESS_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(7000);
        let public_ingress_port = env::var("PUBLIC_INGRESS_PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(ingress_port);
        let ingress_ipv4 = env::var("INGRESS_IPV4").ok().and_then(|v| v.parse().ok());
        let ingress_ipv6 = env::var("INGRESS_IPV6").ok().and_then(|v| v.parse().ok());
        let rathole_shared_token = env::var("RATHOLE_SHARED_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let rathole_port_range_start = env::var("RATHOLE_PORT_RANGE_START")
            .ok()
            .and_then(|v| v.parse::<i32>().ok())
            .unwrap_or(20000);
        let rathole_port_range_end = env::var("RATHOLE_PORT_RANGE_END")
            .ok()
            .and_then(|v| v.parse::<i32>().ok())
            .unwrap_or(40000);
        let default_ttl_seconds = env::var("DEFAULT_TTL_SECONDS")
            .ok()
            .and_then(|v| v.parse::<i32>().ok())
            .unwrap_or(60);
        let token_signing_key =
            env::var("TOKEN_SIGNING_KEY").unwrap_or_else(|_| "dev-secret-change-me".to_string());
        let api_tokens = env::var("BROKER_API_TOKENS")
            .ok()
            .map(|value| {
                value
                    .split(',')
                    .map(|v| v.trim().to_string())
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let token_issuer =
            env::var("TOKEN_ISSUER").unwrap_or_else(|_| "instafy-tunnel-broker".to_string());
        let token_audience = env::var("TOKEN_AUDIENCE").ok();
        let mut token_ttl_seconds = env::var("TUNNEL_TOKEN_TTL_SECONDS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(900);
        if token_ttl_seconds <= 0 {
            token_ttl_seconds = 900;
        }
        let acl_hook = env::var("ACL_HOOK_URL")
            .ok()
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())
            .map(|url| HookConfig {
                url: url.trim_end_matches('/').to_string(),
                token: env::var("ACL_HOOK_TOKEN").ok(),
            });
        let event_hook = env::var("EVENT_HOOK_URL")
            .ok()
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())
            .map(|url| HookConfig {
                url: url.trim_end_matches('/').to_string(),
                token: env::var("EVENT_HOOK_TOKEN").ok(),
            });
        let traefik_cert_resolver = env::var("TRAEFIK_CERT_RESOLVER")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let preview = preview_config(
            env::var("PREVIEW_DOMAIN").ok().as_deref(),
            env::var("PREVIEW_AUTH_ADDRESS").ok().as_deref(),
        );
        let preview_auth_hook = env::var("PREVIEW_AUTH_HOOK_URL")
            .ok()
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())
            .map(|url| HookConfig {
                url: url.trim_end_matches('/').to_string(),
                token: env::var("ACL_HOOK_TOKEN").ok(),
            });
        let preview_max_ttl_seconds = env::var("PREVIEW_MAX_TTL_SECONDS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_PREVIEW_MAX_TTL_SECONDS);
        let rathole_upstream_host = env::var("RATHOLE_UPSTREAM_HOST")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "rathole".to_string());

        Ok(Self {
            database_url,
            database_pool_size,
            rathole_config_notify_channel,
            http_bind,
            tunnel_domain,
            ingress_host,
            ingress_port,
            public_ingress_port,
            ingress_ipv4,
            ingress_ipv6,
            rathole_shared_token,
            rathole_port_range_start,
            rathole_port_range_end,
            default_ttl_seconds,
            token_signing_key,
            api_tokens,
            token_issuer,
            token_audience,
            token_ttl_seconds,
            traefik_cert_resolver,
            acl_hook,
            event_hook,
            preview,
            preview_auth_hook,
            preview_max_ttl_seconds,
            rathole_upstream_host,
        })
    }

    /// Private tunnels need a routable preview domain and an auth hook; without either the
    /// broker refuses to issue one rather than leave it reachable or permanently 401.
    pub fn private_previews_enabled(&self) -> bool {
        self.preview.is_some() && self.preview_auth_hook.is_some()
    }

    pub fn hostname_for(&self, tunnel_id: &Uuid) -> String {
        format!("{}.{}", tunnel_id.simple(), self.tunnel_domain)
    }

    pub fn ingress_url(&self) -> String {
        format!("{}:{}", self.ingress_host, self.ingress_port)
    }

    pub fn tunnel_url(&self, hostname: &str) -> String {
        let tls_enabled = self.traefik_cert_resolver.as_deref().is_some();
        let (scheme, port) = if tls_enabled {
            ("https", self.public_ingress_port)
        } else if self.public_ingress_port == 443 {
            // Common production default; if we don't have a cert resolver configured, prefer
            // plain HTTP on the standard port instead of advertising a broken HTTPS URL.
            ("http", 80)
        } else {
            ("http", self.public_ingress_port)
        };

        if (scheme == "https" && port == 443) || (scheme == "http" && port == 80) {
            format!("{scheme}://{hostname}")
        } else {
            format!("{scheme}://{hostname}:{port}")
        }
    }
}

/// A complete local-style config for handler tests; no field reaches the network.
#[cfg(test)]
#[allow(dead_code)]
pub(crate) fn test_broker_config() -> BrokerConfig {
    BrokerConfig {
        database_url: "postgres://localhost/unused".into(),
        database_pool_size: 1,
        rathole_config_notify_channel: "tunnel_config_refresh".into(),
        http_bind: "127.0.0.1:0".into(),
        tunnel_domain: "rt.test".into(),
        ingress_host: "ingress.rt.test".into(),
        ingress_port: 7000,
        public_ingress_port: 8083,
        ingress_ipv4: None,
        ingress_ipv6: None,
        rathole_shared_token: None,
        rathole_port_range_start: 20000,
        rathole_port_range_end: 40000,
        default_ttl_seconds: 60,
        token_signing_key: "secret".into(),
        api_tokens: vec![],
        token_issuer: "issuer".into(),
        token_audience: None,
        token_ttl_seconds: 900,
        traefik_cert_resolver: None,
        acl_hook: None,
        event_hook: None,
        preview: Some(PreviewConfig {
            domain: "preview.localhost".into(),
            auth_address: "http://broker:8080".into(),
        }),
        preview_auth_hook: Some(HookConfig {
            url: "http://127.0.0.1:9/hook".into(),
            token: Some("hook-secret".into()),
        }),
        preview_max_ttl_seconds: DEFAULT_PREVIEW_MAX_TTL_SECONDS,
        rathole_upstream_host: "rathole".into(),
    }
}

/// Validates the preview pair. The domain is interpolated into a Traefik regex and the address
/// into forwardAuth config, so anything unexpected disables private routing instead.
fn preview_config(domain: Option<&str>, auth_address: Option<&str>) -> Option<PreviewConfig> {
    let domain = domain?.trim().trim_end_matches('.').to_ascii_lowercase();
    let valid_domain = !domain.is_empty()
        && domain.split('.').all(|part| {
            !part.is_empty()
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        });
    let auth_address = auth_address?.trim().trim_end_matches('/').to_string();
    let valid_address = (auth_address.starts_with("http://")
        || auth_address.starts_with("https://"))
        && !auth_address.contains(|c: char| c.is_whitespace() || c == '"' || c == '`');
    if !valid_domain || !valid_address {
        tracing::warn!("ignoring invalid PREVIEW_DOMAIN or PREVIEW_AUTH_ADDRESS");
        return None;
    }
    Some(PreviewConfig {
        domain,
        auth_address,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_config_requires_both_values() {
        let cfg = preview_config(Some(" Preview.Localhost. "), Some("http://broker:8080/"))
            .expect("valid preview config");
        assert_eq!(cfg.domain, "preview.localhost");
        assert_eq!(cfg.auth_address, "http://broker:8080");

        assert!(preview_config(None, Some("http://broker:8080")).is_none());
        assert!(preview_config(Some("preview.localhost"), None).is_none());
        assert!(preview_config(Some(""), Some("http://broker:8080")).is_none());
        assert!(preview_config(Some("preview.localhost"), Some("broker:8080")).is_none());
        assert!(preview_config(Some("pre$view.test"), Some("http://broker:8080")).is_none());
        assert!(preview_config(Some("a..test"), Some("http://broker:8080")).is_none());
    }

    #[test]
    fn builds_hostname() {
        let cfg = BrokerConfig {
            database_url: "postgres://localhost/test".into(),
            database_pool_size: 4,
            rathole_config_notify_channel: "tunnel_config_refresh".into(),
            http_bind: "127.0.0.1:8080".into(),
            tunnel_domain: "rt.test".into(),
            ingress_host: "ingress.rt.test".into(),
            ingress_port: 443,
            public_ingress_port: 443,
            ingress_ipv4: None,
            ingress_ipv6: None,
            rathole_shared_token: None,
            rathole_port_range_start: 20000,
            rathole_port_range_end: 40000,
            default_ttl_seconds: 60,
            token_signing_key: "secret".into(),
            api_tokens: vec![],
            token_issuer: "issuer".into(),
            token_audience: None,
            token_ttl_seconds: 900,
            traefik_cert_resolver: None,
            acl_hook: None,
            event_hook: None,
            preview: None,
            preview_auth_hook: None,
            preview_max_ttl_seconds: DEFAULT_PREVIEW_MAX_TTL_SECONDS,
            rathole_upstream_host: "rathole".into(),
        };

        let id = Uuid::nil();
        assert_eq!(cfg.hostname_for(&id), format!("{}.rt.test", id.simple()));
        assert_eq!(cfg.ingress_url(), "ingress.rt.test:443".to_string());
        assert_eq!(
            cfg.tunnel_url("abc.rt.test"),
            "http://abc.rt.test".to_string()
        );
    }
}
