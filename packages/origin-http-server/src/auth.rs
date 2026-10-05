use anyhow::Result;
use axum::http::{header, HeaderMap};
use jsonwebtoken::errors::ErrorKind;
use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::RwLock;
use tracing::warn;
use uuid::Uuid;

use crate::config::ServerConfig;
use crate::error::OriginError;
use crate::jwks::OriginJwks;

#[derive(Debug, Clone, Deserialize)]
pub struct OriginClaims {
    pub aud: String,
    pub sub: String,
    pub project_id: String,
    #[serde(default)]
    pub origin_id: Option<String>,
    #[serde(default)]
    pub runtime_id: Option<String>,
    #[serde(default)]
    pub protocol: Option<String>,
    pub scopes: Vec<String>,
    #[serde(default)]
    pub lease_id: Option<String>,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub prefer_runtime: Option<String>,
    pub iat: Option<i64>,
    pub exp: Option<i64>,
    #[serde(default)]
    pub jti: Option<String>,
    #[serde(default)]
    pub actor_label: Option<String>,
    #[serde(default)]
    pub browser_session_id: Option<String>,
    /// Display name for commits a person saves: the controller sets it with
    /// [`Self::author_email`] on a person's own workspace-write tokens.
    #[serde(default)]
    pub author_name: Option<String>,
    /// The person's per-space pseudonymous address
    /// (`p<version>-<hash>@users.noreply.instafy.dev`), never their account
    /// id or email.
    #[serde(default)]
    pub author_email: Option<String>,
}

/// The domain every author pseudonym the controller issues is under.
pub const AUTHOR_PSEUDONYM_DOMAIN: &str = "@users.noreply.instafy.dev";

/// Author name used when the token names no usable display name.
const DEFAULT_AUTHOR_NAME: &str = "Instafy user";

/// Longest author name or address taken from a token.
const MAX_AUTHOR_FIELD_BYTES: usize = 254;

/// The scope the controller adds to the origin tokens of a GitHub import:
/// it alone lets an apply carry an `idempotencyKey`. Browsers cannot ask
/// for it.
pub const WORKSPACE_IMPORT_SCOPE: &str = "workspace.import";

impl OriginClaims {
    /// The author of a commit a person saves with this token: the
    /// pseudonym and display name the controller put in it. `None` (the
    /// origin then commits as itself) for job tokens (`run_id`), for tokens
    /// without author claims (an older controller, or one without the
    /// pseudonym keyring), and for an address that is not a pseudonym.
    /// The token subject (an account id) is never used.
    pub fn user_author(&self) -> Option<crate::workspace_git::GitIdentity> {
        let is_job = self
            .run_id
            .as_deref()
            .is_some_and(|run| !run.trim().is_empty());
        if is_job {
            return None;
        }
        let email = self.author_email.as_deref()?.trim();
        let local = email.strip_suffix(AUTHOR_PSEUDONYM_DOMAIN)?;
        let plain = |byte: u8| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.');
        if local.is_empty() || email.len() > MAX_AUTHOR_FIELD_BYTES || !local.bytes().all(plain) {
            return None;
        }
        let name = self
            .author_name
            .as_deref()
            .map(str::trim)
            .filter(|name| {
                !name.is_empty()
                    && name.len() <= MAX_AUTHOR_FIELD_BYTES
                    && !name
                        .chars()
                        .any(|c| c.is_control() || matches!(c, '<' | '>'))
            })
            .unwrap_or(DEFAULT_AUTHOR_NAME);
        Some(crate::workspace_git::GitIdentity::new(name, email))
    }

    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|value| value == scope)
    }
}

/// Resolve the signed JWT expiry to an absolute wall-clock deadline. Initial
/// JWT decoding rejects expired tokens, but long-lived browser transports must
/// retain and enforce this deadline after their HTTP upgrade/offer completes.
pub(crate) fn validated_claim_expiry(claims: &OriginClaims) -> Result<SystemTime, OriginError> {
    let expires_at_seconds = claims
        .exp
        .ok_or_else(|| OriginError::unauthorized("origin token is missing its expiry"))?;
    let expires_at_seconds = u64::try_from(expires_at_seconds)
        .map_err(|_| OriginError::unauthorized("origin token expiry is invalid"))?;
    let expires_at = UNIX_EPOCH
        .checked_add(Duration::from_secs(expires_at_seconds))
        .ok_or_else(|| OriginError::unauthorized("origin token expiry is invalid"))?;
    if expires_at <= SystemTime::now() {
        return Err(OriginError::unauthorized("origin token has expired"));
    }
    Ok(expires_at)
}

#[derive(Clone)]
pub struct TokenValidator {
    client: reqwest::Client,
    jwks_url: reqwest::Url,
    cache: Arc<RwLock<Option<OriginJwks>>>,
    jwks_last_refresh: Arc<RwLock<Option<Instant>>>,
}

impl TokenValidator {
    pub fn new(client: reqwest::Client, jwks_url: reqwest::Url) -> Self {
        Self {
            client,
            jwks_url,
            cache: Arc::new(RwLock::new(None)),
            jwks_last_refresh: Arc::new(RwLock::new(None)),
        }
    }

    pub async fn authorize(
        &self,
        config: &ServerConfig,
        headers: &HeaderMap,
        required_scopes: &[&str],
    ) -> Result<OriginClaims, OriginError> {
        if config.skip_auth {
            return Ok(self.synthetic_claims(config, required_scopes));
        }

        let token = extract_bearer(headers).map_err(OriginError::unauthorized)?;
        let header = decode_header(token).map_err(|error| {
            OriginError::unauthorized(format!("invalid origin token header: {error}"))
        })?;
        let kid = header.kid.as_deref();
        let algorithm = header.alg;
        validate_origin_token_algorithm(algorithm)?;

        let key = self.decoding_key(kid).await.map_err(|error| {
            OriginError::unauthorized(format!("origin token validation failed: {error}"))
        })?;

        let mut validation = Validation::new(Algorithm::EdDSA);
        if config.multi_tenant {
            validation.validate_aud = false;
        } else {
            validation.set_audience(&[config.origin_id.to_string()]);
        }
        validation.validate_exp = true;
        validation.leeway = 5;

        let mut token_result = decode::<OriginClaims>(token, &key, &validation);
        if let Err(error) = &token_result {
            if matches!(error.kind(), ErrorKind::InvalidSignature) {
                if let Err(refresh_error) = self.refresh_jwks(false).await {
                    warn!(?refresh_error, "origin JWKS refresh failed");
                } else if let Ok(refreshed_key) = self.decoding_key(kid).await {
                    token_result = decode::<OriginClaims>(token, &refreshed_key, &validation);
                }
            }
        }

        let token_data = match token_result {
            Ok(data) => data,
            Err(error) => {
                warn!(
                    ?error,
                    kid = kid.unwrap_or(""),
                    algorithm = ?algorithm,
                    "origin token validation failed"
                );
                return Err(OriginError::unauthorized(format!(
                    "invalid origin token: {error}"
                )));
            }
        };

        let claims = token_data.claims;
        validate_claims(config, required_scopes, &claims)?;
        Ok(claims)
    }

    async fn decoding_key(&self, kid: Option<&str>) -> Result<Arc<DecodingKey>> {
        {
            let guard = self.cache.read().await;
            if let Some(jwks) = guard.as_ref() {
                if let Some(key) = jwks.decoding_key(kid) {
                    return Ok(key);
                }
            }
        }

        let fresh = OriginJwks::fetch(&self.client, &self.jwks_url).await?;
        let key = fresh
            .decoding_key(kid)
            .ok_or_else(|| anyhow::anyhow!("origin key id {:?} not found in JWKS", kid))?;

        let mut guard = self.cache.write().await;
        *guard = Some(fresh);

        let mut refreshed = self.jwks_last_refresh.write().await;
        *refreshed = Some(Instant::now());

        Ok(key)
    }

    async fn refresh_jwks(&self, force: bool) -> Result<()> {
        let now = Instant::now();
        if !force {
            let guard = self.jwks_last_refresh.read().await;
            if let Some(last) = *guard {
                if now.duration_since(last) < Duration::from_secs(10) {
                    return Ok(());
                }
            }
        }

        let fresh = OriginJwks::fetch(&self.client, &self.jwks_url).await?;
        let mut cache = self.cache.write().await;
        *cache = Some(fresh);

        let mut refreshed = self.jwks_last_refresh.write().await;
        *refreshed = Some(now);
        Ok(())
    }

    fn synthetic_claims(&self, config: &ServerConfig, required: &[&str]) -> OriginClaims {
        let mut scopes: Vec<String> = required.iter().map(|s| s.to_string()).collect();
        if !scopes.contains(&"fs.read".to_string()) {
            scopes.push("fs.read".to_string());
        }
        if !scopes.contains(&"fs.write".to_string()) {
            scopes.push("fs.write".to_string());
        }
        OriginClaims {
            aud: config.origin_id.to_string(),
            sub: "origin-test-user".to_string(),
            project_id: config.project_id.to_string(),
            origin_id: Some(config.origin_id.to_string()),
            runtime_id: None,
            protocol: Some("http".to_string()),
            scopes,
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            iat: None,
            exp: Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs()
                    .saturating_add(60 * 60)
                    .try_into()
                    .unwrap_or(i64::MAX),
            ),
            jti: None,
            actor_label: Some("Origin test user".to_string()),
            browser_session_id: Some("origin-test-session".to_string()),
            author_name: None,
            author_email: None,
        }
    }
}

fn extract_bearer(headers: &HeaderMap) -> Result<&str, String> {
    let header = headers
        .get(header::AUTHORIZATION)
        .ok_or_else(|| "missing Authorization header".to_string())?;

    let value = header
        .to_str()
        .map_err(|_| "invalid Authorization header".to_string())?;

    let parts: Vec<&str> = value.split_whitespace().collect();
    if parts.len() != 2 || !parts[0].eq_ignore_ascii_case("bearer") {
        return Err("invalid Authorization header scheme".to_string());
    }
    Ok(parts[1])
}

fn validate_claims(
    config: &ServerConfig,
    required_scopes: &[&str],
    claims: &OriginClaims,
) -> Result<(), OriginError> {
    if config.multi_tenant {
        let project_id = Uuid::parse_str(claims.project_id.trim())
            .map_err(|_| OriginError::unauthorized("invalid project id"))?;

        let expected_origin_id = hosted_origin_id_for_project(&project_id);
        let expected = expected_origin_id.to_string();

        let origin_id = claims
            .origin_id
            .as_deref()
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .ok_or_else(|| OriginError::unauthorized("origin mismatch"))?;

        if origin_id != expected {
            return Err(OriginError::unauthorized("origin mismatch"));
        }
        if claims.aud.trim() != expected {
            return Err(OriginError::unauthorized("audience mismatch"));
        }
    } else {
        if claims.project_id != config.project_id.to_string() {
            return Err(OriginError::unauthorized("project mismatch"));
        }
        let Some(origin_id) = claims.origin_id.as_deref() else {
            return Err(OriginError::unauthorized("origin mismatch"));
        };
        if origin_id != config.origin_id.to_string() {
            return Err(OriginError::unauthorized("origin mismatch"));
        }
    }
    let protocol = claims.protocol.as_deref().unwrap_or("http");
    if config.multi_tenant {
        if protocol != "http" {
            return Err(OriginError::unauthorized("unsupported protocol"));
        }
    } else if protocol != "http" && protocol != "webdav" {
        return Err(OriginError::unauthorized("unsupported protocol"));
    }

    for scope in required_scopes {
        if !claims.scopes.iter().any(|value| value == scope) {
            return Err(OriginError::unauthorized(format!(
                "missing required scope {scope}"
            )));
        }
    }

    Ok(())
}

fn hosted_origin_id_for_project(project_id: &Uuid) -> Uuid {
    // Keep consistent with the runtime-controller stable hosted origin ID derivation.
    let name = format!("instafy:hosted-origin:{}", project_id);
    Uuid::new_v5(&Uuid::NAMESPACE_URL, name.as_bytes())
}

fn validate_origin_token_algorithm(header_alg: Algorithm) -> Result<(), OriginError> {
    if header_alg != Algorithm::EdDSA {
        return Err(OriginError::unauthorized(
            "origin tokens must use the EdDSA signing algorithm",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use jsonwebtoken::{decode, jwk::JwkSet, Algorithm, EncodingKey, Header};
    use ring::rand::SystemRandom;
    use ring::signature::{Ed25519KeyPair, KeyPair};
    use serde_json::json;

    #[test]
    fn eddsa_token_round_trip_with_jwks() {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("generate keypair");
        let key_pair =
            Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("construct keypair from pkcs8");

        let public_key = key_pair.public_key().as_ref();
        let jwks_json = json!({
            "keys": [{
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "use": "sig",
                "kid": "test-key",
                "x": URL_SAFE_NO_PAD.encode(public_key)
            }]
        });
        let jwk_set: JwkSet = serde_json::from_value(jwks_json).expect("deserialize jwks");
        let origin_jwks =
            OriginJwks::from_jwk_set(jwk_set).expect("construct jwks decoding key collection");
        let decoding_key = origin_jwks
            .decoding_key(Some("test-key"))
            .expect("retrieve decoding key");

        let header = Header {
            kid: Some("test-key".to_string()),
            alg: Algorithm::EdDSA,
            ..Header::default()
        };
        let claims = json!({
            "aud": "origin",
            "sub": "user",
            "project_id": "project",
            "origin_id": "origin",
            "protocol": "http",
            "scopes": ["fs.write"],
            "iat": 0i64,
            "exp": 10i64
        });

        let private_pem = format_pem_block("PRIVATE KEY", pkcs8.as_ref());
        let encoding_key =
            EncodingKey::from_ed_pem(private_pem.as_bytes()).expect("construct encoding key");
        let token = jsonwebtoken::encode(&header, &claims, &encoding_key).expect("sign token");

        let mut validation = Validation::new(Algorithm::EdDSA);
        validation.set_audience(&["origin"]);
        validation.validate_exp = false;
        let decoded =
            decode::<serde_json::Value>(&token, &decoding_key, &validation).expect("decode token");
        assert_eq!(decoded.claims["origin_id"], "origin");
    }

    #[test]
    fn origin_jwks_requires_kid_match() {
        let jwks_json = json!({
            "keys": [{
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "use": "sig",
                "kid": "test-key",
                "x": URL_SAFE_NO_PAD.encode([0u8; 32]),
            }]
        });
        let jwk_set: JwkSet = serde_json::from_value(jwks_json).expect("deserialize jwks");
        let origin_jwks =
            OriginJwks::from_jwk_set(jwk_set).expect("construct jwks decoding key collection");

        assert!(origin_jwks.decoding_key(Some("missing")).is_none());
        assert!(origin_jwks.decoding_key(None).is_some());
    }

    fn claims_test_config(multi_tenant: bool, project_id: Uuid) -> ServerConfig {
        ServerConfig {
            project_id,
            origin_id: Uuid::new_v4(),
            workspace_root: std::path::PathBuf::from("/tmp"),
            git_remote_url: None,
            git_remote_base_url: None,
            git_branch: "main".into(),
            git_remote_name: "origin".into(),
            git_author_name: "Instafy".into(),
            git_author_email: "instafy@example.invalid".into(),
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            controller_base_url: "http://127.0.0.1:1/".parse().expect("base url"),
            controller_internal_token: None,
            controller_token_source: None,
            jwks_url: "http://127.0.0.1:1/jwks".parse().expect("jwks url"),
            skip_auth: false,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(30),
            max_archive_bytes: 1024,
            staging_base: None,
            multi_tenant,
            hosted_checkout: false,
        }
    }

    #[test]
    fn controller_import_scope_and_author_claims_are_accepted_and_read() {
        // The controller adds `workspace.import` to import tokens and
        // `author_name` / `author_email` to users' workspace-write tokens.
        // Such a token authorizes exactly as before (the scope check is a
        // subset check), and the extra claims are read; tokens without
        // them still deserialize.
        let project_id = Uuid::new_v4();
        for multi_tenant in [false, true] {
            let config = claims_test_config(multi_tenant, project_id);
            let origin_id = if multi_tenant {
                hosted_origin_id_for_project(&project_id)
            } else {
                config.origin_id
            };
            let claims: OriginClaims = serde_json::from_value(json!({
                "aud": origin_id.to_string(),
                "sub": Uuid::new_v4().to_string(),
                "project_id": project_id.to_string(),
                "origin_id": origin_id.to_string(),
                "protocol": "http",
                "scopes": ["fs.write", "workspace.import"],
                "lease_id": Uuid::new_v4().to_string(),
                "iat": 0i64,
                "exp": i64::MAX,
                "jti": Uuid::new_v4().to_string(),
                "author_name": "Ada Lovelace",
                "author_email": "p1-3ujoyn5txgxsverj7psd@users.noreply.instafy.dev",
            }))
            .expect("claims with the new fields deserialize");
            validate_claims(&config, &["fs.write"], &claims).expect("fs.write still authorizes");
            assert!(validate_claims(&config, &["fs.read"], &claims).is_err());
            assert!(claims.has_scope(WORKSPACE_IMPORT_SCOPE));
            assert_eq!(claims.author_name.as_deref(), Some("Ada Lovelace"));
            assert_eq!(
                claims.author_email.as_deref(),
                Some("p1-3ujoyn5txgxsverj7psd@users.noreply.instafy.dev")
            );
        }
        let plain: OriginClaims = serde_json::from_value(json!({
            "aud": "origin",
            "sub": "user",
            "project_id": project_id.to_string(),
            "scopes": ["fs.write"],
            "iat": 0i64,
            "exp": i64::MAX,
        }))
        .expect("claims without the new fields deserialize");
        assert!(!plain.has_scope(WORKSPACE_IMPORT_SCOPE));
        assert_eq!((plain.author_name, plain.author_email), (None, None));
    }

    fn author_claims(extra: serde_json::Value) -> OriginClaims {
        let mut value = json!({
            "aud": "origin",
            "sub": "0f0e0d0c-0b0a-4908-8706-050403020100",
            "project_id": "project",
            "origin_id": "origin",
            "scopes": ["fs.write"],
            "iat": 0i64,
            "exp": 10i64,
        });
        for (key, field) in extra.as_object().expect("an object") {
            value[key] = field.clone();
        }
        serde_json::from_value(value).expect("claims")
    }

    #[test]
    fn a_persons_save_is_authored_by_the_pseudonym_never_the_subject() {
        let pseudonym = "p1-3ujoyn5txgxsverj7psd@users.noreply.instafy.dev";
        let author = author_claims(json!({
            "author_name": "Ada Lovelace",
            "author_email": pseudonym,
        }))
        .user_author()
        .expect("a person's token names an author");
        assert_eq!(author.name, "Ada Lovelace");
        assert_eq!(author.email, pseudonym);

        // No usable display name: the plain fallback, never the subject.
        for name in [
            json!(null),
            json!(""),
            json!("  "),
            json!("Ada <x@y>"),
            json!("a\nb"),
        ] {
            let author = author_claims(json!({ "author_name": name, "author_email": pseudonym }))
                .user_author()
                .expect("the address alone is enough");
            assert_eq!(author.name, "Instafy user");
            assert_eq!(author.email, pseudonym);
        }
    }

    #[test]
    fn jobs_old_controllers_and_other_addresses_commit_as_the_origin() {
        let pseudonym = "p1-3ujoyn5txgxsverj7psd@users.noreply.instafy.dev";
        // A job's token carries a run: its work keeps the origin identity.
        assert!(author_claims(json!({
            "author_name": "Ada",
            "author_email": pseudonym,
            "run_id": "run-1",
        }))
        .user_author()
        .is_none());
        // An older controller (or one without the keyring) sends no author.
        assert!(author_claims(json!({ "actor_label": "Ada" }))
            .user_author()
            .is_none());
        assert!(author_claims(json!({ "author_name": "Ada" }))
            .user_author()
            .is_none());
        // Only pseudonyms: a real address or anything git would misread is
        // never written into history.
        for email in [
            "ada@example.com",
            "@users.noreply.instafy.dev",
            "a b@users.noreply.instafy.dev",
            "a>b@users.noreply.instafy.dev",
            "x@users.noreply.instafy.dev.example.com",
        ] {
            assert!(
                author_claims(json!({ "author_name": "Ada", "author_email": email }))
                    .user_author()
                    .is_none(),
                "{email}"
            );
        }
    }

    #[test]
    fn origin_token_algorithm_is_pinned_to_eddsa() {
        assert!(validate_origin_token_algorithm(Algorithm::EdDSA).is_ok());
        assert!(validate_origin_token_algorithm(Algorithm::HS256).is_err());
        assert!(validate_origin_token_algorithm(Algorithm::RS256).is_err());
    }

    fn format_pem_block(label: &str, der: &[u8]) -> String {
        format!(
            "-----BEGIN {label}-----\n{}\n-----END {label}-----\n",
            base64::engine::general_purpose::STANDARD.encode(der)
        )
    }
}
