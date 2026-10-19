//! Allowlisted Responses metadata. Cache identities are independent of stored
//! conversations; opaque routing state may only return to its original scope.
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Result, anyhow, bail};
use axum::http::HeaderMap;
use jsonwebtoken::{Algorithm, DecodingKey, EncodingKey, Header, Validation, decode, encode};
use ring::digest::{SHA256, digest};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::auth::Credentials;
use crate::proxy_auth::ProxyClaims;

pub(crate) const TURN_STATE_HEADER: &str = "x-codex-turn-state";
const MAX_TURN_STATE_BYTES: usize = 4096;
const MAX_ENVELOPE_BYTES: usize = 8192;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReasoningContext {
    Auto,
    CurrentTurn,
    AllTurns,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum CacheRetention {
    InMemory,
    #[serde(rename = "24h")]
    Extended,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum CacheMode {
    Implicit,
    Explicit,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
enum CacheTtl {
    #[serde(rename = "30m")]
    ThirtyMinutes,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct CacheOptions {
    #[serde(skip_serializing_if = "Option::is_none")]
    mode: Option<CacheMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ttl: Option<CacheTtl>,
    #[serde(skip_serializing_if = "Option::is_none")]
    comparison_response_id: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ResponseContext {
    cache_key: Option<String>,
    retention: Option<CacheRetention>,
    cache_options: Option<CacheOptions>,
    reasoning_context: Option<ReasoningContext>,
    encrypted_reasoning: bool,
    has_breakpoints: bool,
    session_id: Option<String>,
    thread_id: Option<String>,
    turn_state: Option<String>,
}

fn field<T: for<'de> Deserialize<'de>>(payload: &Value, name: &str) -> Result<Option<T>> {
    payload
        .get(name)
        .filter(|v| !v.is_null())
        .map(|value| serde_json::from_value(value.clone()).map_err(|_| anyhow!("invalid {name}")))
        .transpose()
}

fn bounded(value: Option<String>, name: &str, max: usize) -> Result<Option<String>> {
    if let Some(value) = value.as_ref()
        && (value.is_empty() || value.len() > max || value.chars().any(char::is_control))
    {
        bail!("invalid {name}");
    }
    Ok(value)
}

fn header(headers: &HeaderMap, name: &str, max: usize) -> Result<Option<String>> {
    let values = headers.get_all(name).iter().collect::<Vec<_>>();
    if values.len() > 1 {
        bail!("duplicate {name}");
    }
    let value = values
        .first()
        .map(|value| value.to_str().map(str::to_string))
        .transpose()
        .map_err(|_| anyhow!("invalid {name}"))?;
    bounded(value, name, max)
}

impl ResponseContext {
    pub(crate) fn parse(payload: &Value, headers: &HeaderMap) -> Result<Self> {
        let mut has_breakpoints = false;
        for (name, chat) in [("input", false), ("messages", true)] {
            let Some(items) = payload.get(name) else {
                continue;
            };
            let items: &[Value] = match items {
                Value::Array(items) => items,
                Value::Object(_) => std::slice::from_ref(items),
                _ => &[],
            };
            for item in items {
                let Some(parts) = item.get("content").and_then(Value::as_array) else {
                    continue;
                };
                for part in parts {
                    if let Some(marker) = part.get("prompt_cache_breakpoint") {
                        has_breakpoints = true;
                        if marker != &json!({"mode":"explicit"}) {
                            bail!("invalid prompt_cache_breakpoint");
                        }
                        let role = item.get("role").and_then(Value::as_str).unwrap_or_default();
                        if chat
                            || role.eq_ignore_ascii_case("developer")
                            || role.eq_ignore_ascii_case("system")
                        {
                            bail!(
                                "prompt_cache_breakpoint requires Responses content preserved by proxy instruction normalization"
                            );
                        }
                    }
                }
            }
        }
        let cache_key = bounded(field(payload, "prompt_cache_key")?, "prompt_cache_key", 256)?;
        let retention = field(payload, "prompt_cache_retention")?;
        let mut cache_options: Option<CacheOptions> = field(payload, "prompt_cache_options")?;
        if let Some(options) = cache_options.as_mut() {
            options.comparison_response_id = bounded(
                options.comparison_response_id.take(),
                "comparison_response_id",
                256,
            )?;
        }
        let reasoning_context = match payload.get("reasoning").filter(|v| !v.is_null()) {
            Some(value) if value.is_object() => field(value, "context")?,
            Some(_) => bail!("invalid reasoning"),
            None => None,
        };
        // Other include values have provider-specific capabilities; this slice
        // adds only the native Codex encrypted-reasoning request.
        let include: Option<Vec<String>> = field(payload, "include")?;
        let encrypted_reasoning = include
            .as_ref()
            .is_some_and(|values| values.iter().any(|v| v == "reasoning.encrypted_content"));
        let session_id = header(headers, "session-id", 256)?;
        let legacy_session = header(headers, "session_id", 256)?;
        if session_id.is_some() && legacy_session.is_some() && session_id != legacy_session {
            bail!("conflicting session identity headers");
        }
        Ok(Self {
            cache_key,
            retention,
            cache_options,
            reasoning_context,
            encrypted_reasoning,
            has_breakpoints,
            session_id: session_id.or(legacy_session),
            thread_id: header(headers, "thread-id", 256)?,
            turn_state: header(headers, TURN_STATE_HEADER, MAX_ENVELOPE_BYTES)?,
        })
    }

    pub(crate) fn validate_upstream(&self, responses_wire: bool, subscription: bool) -> Result<()> {
        if !responses_wire
            && (self.has_breakpoints || self.cache_options.is_some() || self.retention.is_some())
        {
            bail!("Public cache controls require a Responses upstream");
        }
        if subscription
            && (self.has_breakpoints || self.cache_options.is_some() || self.retention.is_some())
        {
            bail!(
                "prompt_cache_options, prompt_cache_retention and explicit breakpoints are unsupported on imported Codex credentials"
            );
        }
        Ok(())
    }

    pub(crate) fn validate_diagnostic_scope(
        &self,
        claims: Option<&ProxyClaims>,
        controller_integrated: bool,
    ) -> Result<()> {
        if controller_integrated
            && self
                .cache_options
                .as_ref()
                .and_then(|options| options.comparison_response_id.as_ref())
                .is_some()
            && claims
                .and_then(|claims| claims.credential_id.as_deref())
                .filter(|id| !id.trim().is_empty())
                .is_none()
        {
            bail!(
                "prompt_cache_options.comparison_response_id requires a bring-your-own credential"
            );
        }
        Ok(())
    }

    pub(crate) fn scoped(
        &self,
        claims: Option<&ProxyClaims>,
        credentials: &Credentials,
        model: &str,
        codec: &Arc<AffinityCodec>,
    ) -> ScopedResponseContext {
        let provider = if credentials.is_chatgpt() {
            "codex"
        } else {
            "api"
        };
        let account_scope = match credentials.chatgpt_account_id() {
            Some(account) if !account.trim().is_empty() => json!(account),
            _ if credentials.is_chatgpt() => {
                // Some supported login snapshots have no account ID. Bind
                // their routing state to the exact token instead of treating
                // every unknown account as the same account. Normal refreshes
                // remain stable when an account ID is available.
                json!({"unknown_account_token": fingerprint(&json!([
                    "instafy-unknown-account-v1",
                    &codec.namespace,
                    credentials.bearer(),
                ]))})
            }
            _ => Value::Null,
        };
        let scope = fingerprint(&json!([
            "instafy-responses-context-v1",
            claims
                .map(|c| c.project_id.as_str())
                .unwrap_or("standalone"),
            claims
                .and_then(|c| c.credential_id.as_deref())
                .unwrap_or("platform"),
            provider,
            credentials.endpoint(),
            account_scope,
            codec.namespace,
        ]));
        let identity = |value: &str| scoped_uuid(&json!([&scope, value]));
        let affinity_scope = self
            .session_id
            .as_ref()
            .or(self.cache_key.as_ref())
            .map(|session| fingerprint(&json!([&scope, session, model])));
        let turn_state = if credentials.is_chatgpt() {
            affinity_scope.as_deref().and_then(|scope| {
                self.turn_state
                    .as_deref()
                    .and_then(|token| codec.open(token, scope))
            })
        } else {
            None
        };
        ScopedResponseContext {
            controls: self.clone(),
            claims: claims.cloned(),
            cache_key: self.cache_key.as_deref().map(identity),
            session_id: self.session_id.as_deref().map(identity),
            thread_id: self.thread_id.as_deref().map(identity),
            turn_state,
            affinity_scope: credentials.is_chatgpt().then_some(affinity_scope).flatten(),
            codec: Arc::clone(codec),
        }
    }
}

// Preserve the UUID-shaped native session/thread contract while deriving a
// collision-resistant namespace. Use the same mapping for a matching cache key.
fn scoped_uuid(value: &Value) -> String {
    let hash = digest(&SHA256, value.to_string().as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&hash.as_ref()[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

fn fingerprint(value: &Value) -> String {
    digest(&SHA256, value.to_string().as_bytes())
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[derive(Clone)]
pub(crate) struct ScopedResponseContext {
    controls: ResponseContext,
    claims: Option<ProxyClaims>,
    cache_key: Option<String>,
    session_id: Option<String>,
    thread_id: Option<String>,
    turn_state: Option<String>,
    affinity_scope: Option<String>,
    codec: Arc<AffinityCodec>,
}

impl ScopedResponseContext {
    pub(crate) fn rebind(&self, credentials: &Credentials, model: &str) -> Self {
        self.controls
            .scoped(self.claims.as_ref(), credentials, model, &self.codec)
    }

    pub(crate) fn apply_payload(&self, payload: &mut Value, subscription: bool) {
        if let Some(key) = self.cache_key.as_ref() {
            payload["prompt_cache_key"] = json!(key);
        }
        // These newer public API controls are opt-in. Imported Codex login
        // credentials use a different endpoint with no public support guarantee.
        if !subscription {
            if let Some(retention) = self.controls.retention.as_ref() {
                payload["prompt_cache_retention"] = json!(retention);
            }
            if let Some(options) = self.controls.cache_options.as_ref() {
                payload["prompt_cache_options"] = json!(options);
            }
        }
        if let Some(context) = self.controls.reasoning_context.as_ref() {
            if !payload.get("reasoning").is_some_and(Value::is_object) {
                payload["reasoning"] = json!({});
            }
            payload["reasoning"]["context"] = json!(context);
        }
        if self.controls.encrypted_reasoning {
            payload["include"] = json!(["reasoning.encrypted_content"]);
        }
    }

    pub(crate) fn apply_headers(&self, headers: &mut HeaderMap) {
        // Do not leave the legacy conversation flag's unscoped session alias
        // beside a caller's scoped native session identity.
        if self.session_id.is_some() {
            headers.remove("session_id");
        }
        for (name, value) in [
            ("session-id", &self.session_id),
            ("thread-id", &self.thread_id),
            (TURN_STATE_HEADER, &self.turn_state),
        ] {
            if let Some(value) = value.as_ref().and_then(|v| v.parse().ok()) {
                headers.insert(name, value);
            }
        }
    }

    pub(crate) fn response_turn_state(&self, headers: &HeaderMap) -> Option<String> {
        let scope = self.affinity_scope.as_deref()?;
        let state = header(headers, TURN_STATE_HEADER, MAX_TURN_STATE_BYTES).ok()??;
        self.codec.seal(&state, scope)
    }
}

/// The native header is opaque to Codex. Signing its envelope prevents a client
/// from carrying provider state across a project, credential, endpoint or root
/// session. No cache contents or conversation state are stored in this proxy.
pub(crate) struct AffinityCodec {
    encoding: EncodingKey,
    decoding: DecodingKey,
    namespace: String,
}

#[derive(Serialize, Deserialize)]
struct AffinityEnvelope {
    scope: String,
    state: String,
    exp: u64,
    aud: String,
}

impl AffinityCodec {
    pub(crate) fn from_env() -> Self {
        let secret = std::env::var("PROXY_SIGNING_SECRET")
            .ok()
            .filter(|v| !v.trim().is_empty())
            .or_else(|| {
                std::env::var("CONTROLLER_INTERNAL_TOKEN")
                    .ok()
                    .filter(|v| !v.trim().is_empty())
                    .map(|v| format!("instafy-proxy-signing:{v}"))
            })
            .unwrap_or_else(|| format!("{}{}", Uuid::new_v4(), Uuid::new_v4()));
        Self::new(&secret)
    }

    fn new(secret: &str) -> Self {
        let secret = format!("instafy-affinity-v1:{secret}");
        Self {
            encoding: EncodingKey::from_secret(secret.as_bytes()),
            decoding: DecodingKey::from_secret(secret.as_bytes()),
            namespace: fingerprint(&json!(secret)),
        }
    }

    fn seal(&self, state: &str, scope: &str) -> Option<String> {
        let exp = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs() + 3600;
        encode(
            &Header::new(Algorithm::HS256),
            &AffinityEnvelope {
                scope: scope.to_string(),
                state: state.to_string(),
                exp,
                aud: "instafy-affinity".into(),
            },
            &self.encoding,
        )
        .ok()
        .filter(|token| token.len() <= MAX_ENVELOPE_BYTES)
    }

    fn open(&self, token: &str, scope: &str) -> Option<String> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_audience(&["instafy-affinity"]);
        let envelope = decode::<AffinityEnvelope>(token, &self.decoding, &validation)
            .ok()?
            .claims;
        if envelope.scope != scope {
            return None;
        }
        bounded(
            Some(envelope.state),
            TURN_STATE_HEADER,
            MAX_TURN_STATE_BYTES,
        )
        .ok()
        .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claims(project: &str, credential: &str, job: &str) -> ProxyClaims {
        serde_json::from_value(
            json!({"project_id":project,"credential_id":credential,"job_id":job,"runtime_id":job}),
        )
        .unwrap()
    }

    fn credentials(subscription: bool) -> Credentials {
        if subscription {
            Credentials::ChatGpt {
                access_token: "inert".into(),
                refresh_token: None,
                account_id: None,
                default_model: None,
                auth_path: None,
            }
        } else {
            Credentials::ApiKey {
                key: "inert".into(),
                endpoint: Some("https://api.openai.com/v1/responses".into()),
                default_model: None,
            }
        }
    }

    fn context() -> ResponseContext {
        let mut headers = HeaderMap::new();
        headers.insert("session-id", "root-session".parse().unwrap());
        headers.insert("thread-id", "child-thread".parse().unwrap());
        ResponseContext::parse(&json!({
            "prompt_cache_key":"root-session",
            "prompt_cache_options":{"mode":"explicit","ttl":"30m","comparison_response_id":"resp-prior","unknown":"not-forwarded"},
            "reasoning":{"context":"all_turns"},
            "include":["reasoning.encrypted_content","unknown-not-forwarded"]
        }), &headers).unwrap()
    }

    #[test]
    fn native_children_share_scoped_identity_but_other_projects_and_credentials_do_not() {
        let codec = Arc::new(AffinityCodec::new("test"));
        let creds = credentials(true);
        let controls = context();
        let root = controls.scoped(
            Some(&claims("project", "credential", "root")),
            &creds,
            "gpt-5.6-sol",
            &codec,
        );
        let child = controls.scoped(
            Some(&claims("project", "credential", "child")),
            &creds,
            "gpt-5.6-sol",
            &codec,
        );
        assert_eq!(root.cache_key, child.cache_key);
        assert_eq!(root.cache_key, root.session_id);
        assert_eq!(
            Uuid::parse_str(root.session_id.as_deref().unwrap())
                .unwrap()
                .get_version_num(),
            8
        );
        assert_ne!(root.session_id, root.thread_id);
        assert_ne!(root.cache_key.as_deref(), Some("root-session"));
        for other in [
            claims("other-project", "credential", "root"),
            claims("project", "other-credential", "root"),
        ] {
            assert_ne!(
                root.cache_key,
                controls
                    .scoped(Some(&other), &creds, "gpt-5.6-sol", &codec)
                    .cache_key
            );
        }
        let other_endpoint = Credentials::ApiKey {
            key: "inert".into(),
            endpoint: Some("https://other.example/v1/responses".into()),
            default_model: None,
        };
        let api = controls.scoped(
            Some(&claims("project", "credential", "root")),
            &credentials(false),
            "gpt-5.6-sol",
            &codec,
        );
        assert_ne!(
            api.cache_key,
            controls
                .scoped(
                    Some(&claims("project", "credential", "root")),
                    &other_endpoint,
                    "gpt-5.6-sol",
                    &codec
                )
                .cache_key
        );
        assert_ne!(root.cache_key, api.cache_key);
    }

    #[test]
    fn public_cache_options_are_opt_in_and_never_sent_to_imported_codex() {
        let codec = Arc::new(AffinityCodec::new("test"));
        for subscription in [false, true] {
            let controls =
                context().scoped(None, &credentials(subscription), "gpt-5.6-sol", &codec);
            let mut payload = json!({"reasoning":{"effort":"high","summary":"auto"}});
            controls.apply_payload(&mut payload, subscription);
            assert_eq!(payload["reasoning"]["context"], "all_turns");
            assert_eq!(payload["reasoning"]["effort"], "high");
            assert_eq!(payload["include"], json!(["reasoning.encrypted_content"]));
            assert_eq!(payload.get("prompt_cache_options").is_none(), subscription);
            if !subscription {
                assert_eq!(
                    payload["prompt_cache_options"],
                    json!({"mode":"explicit","ttl":"30m","comparison_response_id":"resp-prior"})
                );
            }
        }
        let mut empty = json!({});
        ResponseContext::default()
            .scoped(None, &credentials(false), "gpt-5.6-sol", &codec)
            .apply_payload(&mut empty, false);
        assert_eq!(empty, json!({}));
    }

    #[test]
    fn malformed_or_oversized_known_controls_are_rejected_without_echoing_values() {
        for payload in [
            json!({"prompt_cache_key":false}),
            json!({"prompt_cache_key":"x".repeat(257)}),
            json!({"prompt_cache_options":{"ttl":"forever"}}),
            json!({"prompt_cache_retention":42}),
            json!({"reasoning":{"context":"unknown"}}),
            json!({"include":false}),
        ] {
            assert!(ResponseContext::parse(&payload, &HeaderMap::new()).is_err());
        }
        let mut headers = HeaderMap::new();
        headers.insert("session-id", "one".parse().unwrap());
        headers.insert("session_id", "two".parse().unwrap());
        assert!(ResponseContext::parse(&json!({}), &headers).is_err());
        headers.remove("session_id");
        headers.append("session-id", "one".parse().unwrap());
        assert!(ResponseContext::parse(&json!({}), &headers).is_err());
    }

    #[test]
    fn sticky_state_roundtrips_only_as_a_valid_envelope_for_same_scope() {
        let codec = Arc::new(AffinityCodec::new("test"));
        let creds = credentials(true);
        let claims = claims("project", "credential", "job");
        let controls = context().scoped(Some(&claims), &creds, "gpt-5.6-sol", &codec);
        let mut upstream = HeaderMap::new();
        upstream.insert(TURN_STATE_HEADER, "provider-state".parse().unwrap());
        let token = controls.response_turn_state(&upstream).unwrap();
        let mut next = context();
        next.turn_state = Some(token.clone());
        let next = next.scoped(Some(&claims), &creds, "gpt-5.6-sol", &codec);
        let mut headers = HeaderMap::new();
        next.apply_headers(&mut headers);
        assert_eq!(headers[TURN_STATE_HEADER], "provider-state");
        assert_eq!(headers.len(), 3);
        let mut other_context = context();
        other_context.turn_state = Some(token.clone());
        other_context.session_id = Some("other-session".into());
        assert!(
            other_context
                .scoped(Some(&claims), &creds, "gpt-5.6-sol", &codec)
                .turn_state
                .is_none()
        );
        assert!(codec.open(&token, "other-scope").is_none());
        assert!(
            AffinityCodec::new("different-key")
                .open(&token, controls.affinity_scope.as_deref().unwrap())
                .is_none()
        );
        assert!(
            codec
                .open(
                    "provider-state",
                    controls.affinity_scope.as_deref().unwrap()
                )
                .is_none()
        );
        let mut context = context();
        context.turn_state = Some(token);
        assert!(
            context
                .scoped(Some(&claims), &credentials(false), "gpt-5.6-sol", &codec)
                .turn_state
                .is_none()
        );
    }

    #[test]
    fn expired_or_oversized_affinity_is_not_replayed() {
        let codec = AffinityCodec::new("test");
        let expired = encode(
            &Header::new(Algorithm::HS256),
            &AffinityEnvelope {
                scope: "scope".into(),
                state: "value".into(),
                aud: "instafy-affinity".into(),
                exp: 1,
            },
            &codec.encoding,
        )
        .unwrap();
        assert!(codec.open(&expired, "scope").is_none());
        let oversized = codec
            .seal(&"x".repeat(MAX_TURN_STATE_BYTES + 1), "scope")
            .unwrap();
        assert!(codec.open(&oversized, "scope").is_none());
    }
    #[test]
    fn account_and_model_changes_invalidate_affinity_but_token_refresh_does_not() {
        let codec = Arc::new(AffinityCodec::new("test"));
        let account = |id: &str, token: &str| Credentials::ChatGpt {
            access_token: token.into(),
            refresh_token: None,
            account_id: Some(id.into()),
            default_model: None,
            auth_path: None,
        };
        let initial = context().scoped(None, &account("account-a", "old-token"), "model-a", &codec);
        let mut headers = HeaderMap::new();
        headers.insert(TURN_STATE_HEADER, "sticky".parse().unwrap());
        let mut next = context();
        next.turn_state = initial.response_turn_state(&headers);
        let bound = next.scoped(None, &account("account-a", "old-token"), "model-a", &codec);
        assert_eq!(
            bound
                .rebind(&account("account-a", "new-token"), "model-a")
                .turn_state
                .as_deref(),
            Some("sticky")
        );
        assert!(
            bound
                .rebind(&account("account-b", "new-token"), "model-a")
                .turn_state
                .is_none()
        );
        assert!(
            bound
                .rebind(&account("account-a", "new-token"), "model-b")
                .turn_state
                .is_none()
        );
        assert_eq!(
            bound.cache_key,
            bound
                .rebind(&account("account-a", "new-token"), "model-b")
                .cache_key
        );
    }

    #[test]
    fn unknown_account_token_replacement_invalidates_cache_identity_and_affinity() {
        let codec = Arc::new(AffinityCodec::new("test"));
        let credentials = |token: &str, account_id: Option<&str>| Credentials::ChatGpt {
            access_token: token.into(),
            refresh_token: None,
            account_id: account_id.map(str::to_string),
            default_model: None,
            auth_path: None,
        };
        let initial = context().scoped(None, &credentials("first-token", None), "model", &codec);
        let mut headers = HeaderMap::new();
        headers.insert(TURN_STATE_HEADER, "sticky".parse().unwrap());
        let mut next = context();
        next.turn_state = initial.response_turn_state(&headers);
        for account_id in [None, Some(""), Some("  ")] {
            let unchanged = next.scoped(
                None,
                &credentials("first-token", account_id),
                "model",
                &codec,
            );
            assert_eq!(initial.cache_key, unchanged.cache_key);
            assert_eq!(unchanged.turn_state.as_deref(), Some("sticky"));
            let replaced = unchanged.rebind(&credentials("second-token", account_id), "model");
            assert_ne!(initial.cache_key, replaced.cache_key);
            assert!(replaced.turn_state.is_none());
        }
    }

    #[test]
    fn diagnostic_comparison_requires_byoc_or_standalone() {
        let controls = context();
        assert!(controls.validate_diagnostic_scope(None, false).is_ok());
        assert!(controls.validate_diagnostic_scope(None, true).is_err());
        assert!(
            controls
                .validate_diagnostic_scope(Some(&claims("p", "c", "j")), true)
                .is_ok()
        );
        assert!(
            ResponseContext::default()
                .validate_diagnostic_scope(None, true)
                .is_ok()
        );
    }

    #[test]
    fn breakpoints_cannot_be_silently_lost_by_instruction_or_chat_normalization() {
        for role in ["developer", "system"] {
            let payload = json!({"input":[{"type":"message","role":role,"content":[{"type":"input_text","text":"policy","prompt_cache_breakpoint":{"mode":"explicit"}}]}]});
            assert!(ResponseContext::parse(&payload, &HeaderMap::new()).is_err());
        }
        let chat = json!({"messages":[{"role":"user","content":[{"type":"text","text":"message","prompt_cache_breakpoint":{"mode":"explicit"}}]}]});
        assert!(ResponseContext::parse(&chat, &HeaderMap::new()).is_err());
        let mut preserved = json!({"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"message","prompt_cache_breakpoint":{"mode":"explicit"}}]}]});
        assert!(ResponseContext::parse(&preserved, &HeaderMap::new()).is_ok());
        preserved["input"][0]["content"][0]["prompt_cache_breakpoint"] = json!(true);
        assert!(ResponseContext::parse(&preserved, &HeaderMap::new()).is_err());
    }
    #[test]
    fn unsupported_public_api_controls_are_rejected_before_subscription_or_chat_upstream() {
        for payload in [
            json!({"prompt_cache_options":{"ttl":"30m"}}),
            json!({"prompt_cache_retention":"24h"}),
            json!({"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"x","prompt_cache_breakpoint":{"mode":"explicit"}}]}]}),
        ] {
            let controls = ResponseContext::parse(&payload, &HeaderMap::new()).unwrap();
            assert!(controls.validate_upstream(true, false).is_ok());
            assert!(controls.validate_upstream(true, true).is_err());
            assert!(controls.validate_upstream(false, false).is_err());
        }
        let native = ResponseContext::parse(&json!({"prompt_cache_key":"root","reasoning":{"context":"all_turns"},"include":["reasoning.encrypted_content"]}),&HeaderMap::new()).unwrap();
        assert!(native.validate_upstream(true, true).is_ok());
        // Native Codex sends these even when a BYOC provider uses Chat
        // Completions; keep its existing adaptation instead of rejecting it.
        assert!(native.validate_upstream(false, false).is_ok());
    }
}
