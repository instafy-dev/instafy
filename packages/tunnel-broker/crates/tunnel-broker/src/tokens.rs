use anyhow::{Context, Result};
use chrono::{DateTime, Duration, Utc};
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use tunnel_broker_types::TunnelTokenClaims;
use uuid::Uuid;

use crate::config::BrokerConfig;

pub fn sign_tunnel_token(
    cfg: &BrokerConfig,
    tunnel_id: Uuid,
    project_id: Uuid,
    runtime_id: Option<Uuid>,
    lease_id: Option<Uuid>,
    hostname: &str,
) -> Result<(String, DateTime<Utc>)> {
    let now = Utc::now();
    let default_exp = now + Duration::seconds(cfg.token_ttl_seconds as i64);
    let exp = default_exp;

    let claims = TunnelTokenClaims {
        sub: tunnel_id.to_string(),
        project_id,
        hostname: hostname.to_string(),
        ingress_host: cfg.ingress_host.clone(),
        ingress_port: cfg.ingress_port,
        iss: cfg.token_issuer.clone(),
        iat: now.timestamp(),
        exp: exp.timestamp(),
        aud: cfg.token_audience.clone(),
        runtime_id,
        lease_id,
    };

    let mut header = Header::new(Algorithm::HS256);
    header.typ = Some("JWT".into());

    let token = encode(
        &header,
        &claims,
        &EncodingKey::from_secret(cfg.token_signing_key.as_bytes()),
    )
    .context("failed to sign tunnel token")?;

    Ok((token, exp))
}

pub fn resolve_tunnel_expiry(
    requested: Option<DateTime<Utc>>,
    token_expiry: DateTime<Utc>,
) -> DateTime<Utc> {
    match requested {
        Some(requested) => std::cmp::min(requested, token_expiry),
        None => token_expiry,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{decode, DecodingKey, Validation};

    #[test]
    fn signs_and_encodes_claims() {
        let cfg = BrokerConfig {
            database_url: "postgres://localhost/test".into(),
            database_pool_size: 4,
            rathole_config_notify_channel: "tunnel_config_refresh".into(),
            http_bind: "0.0.0.0:8080".into(),
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
            token_signing_key: "secret-key".into(),
            api_tokens: vec![],
            token_issuer: "issuer".into(),
            token_audience: Some("aud".into()),
            token_ttl_seconds: 120,
            traefik_cert_resolver: None,
            acl_hook: None,
            event_hook: None,
        };
        let tunnel_id = Uuid::nil();
        let project_id = Uuid::new_v4();
        let (token, exp) =
            sign_tunnel_token(&cfg, tunnel_id, project_id, None, None, "abc.rt.test").unwrap();

        let data = decode::<TunnelTokenClaims>(
            &token,
            &DecodingKey::from_secret(cfg.token_signing_key.as_bytes()),
            &{
                let mut v = Validation::new(Algorithm::HS256);
                v.set_audience(&["aud"]);
                v
            },
        )
        .unwrap();

        assert_eq!(data.claims.sub, tunnel_id.to_string());
        assert_eq!(data.claims.project_id, project_id);
        assert_eq!(data.claims.ingress_host, cfg.ingress_host);
        assert_eq!(data.claims.aud.as_deref(), Some("aud"));
        assert!(data.claims.exp >= exp.timestamp());
    }

    #[test]
    fn resolves_expiry_min() {
        let now = Utc::now();
        let token_expiry = now + Duration::seconds(600);
        let requested = now + Duration::seconds(300);
        assert_eq!(
            resolve_tunnel_expiry(Some(requested), token_expiry),
            requested
        );
        assert_eq!(resolve_tunnel_expiry(None, token_expiry), token_expiry);
    }
}
