use std::collections::HashMap;
use std::path::PathBuf;
use std::thread;
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL;
use base64::Engine;
use serde::Deserialize;
use serde_json::Value as JsonValue;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use bb8::Pool;
use bb8_postgres::PostgresConnectionManager;
use rand::distributions::Alphanumeric;
use rand::Rng;
use tokio::sync::RwLock;
use tokio_postgres_rustls::MakeRustlsConnect;
use tracing::{info, warn};

use crate::jwks;
use crate::model_defaults::{
    default_managed_ai_model_id, default_managed_ai_model_label,
    DEFAULT_MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K, DEFAULT_MANAGED_AI_INPUT_USD_MICROS_PER_1K,
    DEFAULT_MANAGED_AI_OUTPUT_USD_MICROS_PER_1K,
};

/// Supabase-managed Postgres endpoints (including the shared session pooler)
/// present certificate chains rooted in Supabase's own authority rather than
/// a public one, so the public web roots alone cannot verify them.
const SUPABASE_PROD_CA_2021: &str = include_str!("../certs/supabase-prod-ca-2021.pem");

pub type PgConnectionManager = PostgresConnectionManager<MakeRustlsConnect>;
pub type PgPool = Pool<PgConnectionManager>;

fn database_root_store() -> rustls::RootCertStore {
    let mut roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    for certificate in rustls_pemfile::certs(&mut SUPABASE_PROD_CA_2021.as_bytes()) {
        let certificate = certificate.expect("embedded Supabase CA certificate parses");
        roots
            .add(certificate)
            .expect("embedded Supabase CA certificate is a valid trust anchor");
    }
    roots
}

pub(crate) fn database_tls() -> MakeRustlsConnect {
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(database_root_store())
        .with_no_client_auth();
    MakeRustlsConnect::new(config)
}

fn database_pool_size_from_values(
    configured_pool_size: Option<&str>,
    dev_mode: Option<&str>,
) -> u32 {
    let dev_mode_hint = dev_mode
        .map(str::to_lowercase)
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false);

    configured_pool_size
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(if dev_mode_hint { 12 } else { 4 })
}

#[derive(Clone)]
pub struct CredentialEncryptionKey([u8; 32]);

impl CredentialEncryptionKey {
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    fn derive_from_user_token_secret(user_token_secret: &str) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(b"instafy:credential-encryption-key:v1:");
        hasher.update(user_token_secret.as_bytes());
        let digest = hasher.finalize();
        let mut key = [0u8; 32];
        key.copy_from_slice(&digest);
        Self(key)
    }

    #[cfg(test)]
    #[allow(dead_code)]
    pub(crate) fn for_test(seed: &str) -> Self {
        Self::derive_from_user_token_secret(seed)
    }

    fn from_base64(raw: &str) -> anyhow::Result<Self> {
        let decoded = BASE64.decode(raw.trim().as_bytes())?;
        anyhow::ensure!(
            decoded.len() == 32,
            "CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes"
        );
        let mut key = [0u8; 32];
        key.copy_from_slice(&decoded);
        Ok(Self(key))
    }
}

impl std::fmt::Debug for CredentialEncryptionKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("<redacted>")
    }
}

/// The value USER_TOKEN_SECRET falls back to when unset. It is published in
/// this repository, so it is acceptable only under DEV_MODE.
const DEV_USER_TOKEN_SECRET: &str = "dev-user-token-secret";

/// RFC 7518 section 3.2: an HS256 key must be at least as long as the hash
/// output, which also rules out short placeholders such as the one above.
const MIN_USER_TOKEN_SECRET_BYTES: usize = 32;

/// Resolve the HS256 secret that signs controller session tokens.
///
/// `authenticate_request` accepts any token that verifies against this secret
/// and returns a full user session for whatever `sub` it names; there is no
/// session table or revocation list behind it. A secret anyone can read
/// therefore lets anyone who can reach the controller act as any user.
/// Outside DEV_MODE the controller refuses to start instead of signing with a
/// missing, published or short secret. Messages never include the value.
fn resolve_user_token_secret(dev_mode: bool, configured: Option<&str>) -> anyhow::Result<String> {
    let configured = configured.map(str::trim).filter(|value| !value.is_empty());
    if dev_mode {
        return Ok(match configured {
            Some(secret) => secret.to_string(),
            None => {
                warn!(
                    "DEV_MODE: USER_TOKEN_SECRET is unset, so session tokens are signed with the \
                     published development value; anyone who can reach this controller can sign \
                     in as any user"
                );
                DEV_USER_TOKEN_SECRET.to_string()
            }
        });
    }
    match configured {
        None => anyhow::bail!(
            "USER_TOKEN_SECRET must be set outside DEV_MODE. It signs controller session tokens; \
             generate one with `openssl rand -hex 32`, or set DEV_MODE=1 for local development"
        ),
        Some(DEV_USER_TOKEN_SECRET) => anyhow::bail!(
            "USER_TOKEN_SECRET is the development value published in the Instafy source; anyone \
             could forge a session with it. Generate a new one with `openssl rand -hex 32`"
        ),
        Some(secret) if secret.len() < MIN_USER_TOKEN_SECRET_BYTES => anyhow::bail!(
            "USER_TOKEN_SECRET must be at least {MIN_USER_TOKEN_SECRET_BYTES} bytes outside \
             DEV_MODE. Generate one with `openssl rand -hex 32`"
        ),
        Some(secret) => Ok(secret.to_string()),
    }
}

/// Resolve the key that encrypts stored credentials, project secrets and OAuth
/// tokens.
///
/// Earlier releases derived it from USER_TOKEN_SECRET whenever it was unset.
/// That couples two secrets with opposite lifecycles: the signing secret must
/// be rotatable at any time (the cost is a sign-in), while this key cannot
/// change without re-encrypting every stored row. Rotating the signing secret
/// would therefore silently make every stored credential unreadable, and so
/// would the first real USER_TOKEN_SECRET on a controller that ran without one.
/// Outside DEV_MODE the key must be configured explicitly.
fn resolve_credential_encryption_key(
    dev_mode: bool,
    configured: Option<&str>,
    user_token_secret: &str,
) -> anyhow::Result<CredentialEncryptionKey> {
    match configured.map(str::trim).filter(|value| !value.is_empty()) {
        Some(raw) => CredentialEncryptionKey::from_base64(raw),
        None if dev_mode => Ok(CredentialEncryptionKey::derive_from_user_token_secret(
            user_token_secret,
        )),
        None => anyhow::bail!(
            "CREDENTIAL_ENCRYPTION_KEY must be set outside DEV_MODE to a base64-encoded 32-byte \
             key (`openssl rand -base64 32`). A controller that previously ran without it stored \
             credentials under a key derived from USER_TOKEN_SECRET; see the runtime-controller \
             README before choosing a value, or those credentials become unreadable"
        ),
    }
}

/// Whether this is the key earlier releases derived from the published
/// development USER_TOKEN_SECRET. Anyone can compute it, so credentials stored
/// under it are readable by anyone holding a copy of the database. It is still
/// accepted, because refusing it would strand those rows until they are
/// re-encrypted, but the controller warns on every boot while it is in use.
fn is_published_credential_encryption_key(key: &CredentialEncryptionKey) -> bool {
    key.as_bytes()
        == CredentialEncryptionKey::derive_from_user_token_secret(DEV_USER_TOKEN_SECRET).as_bytes()
}

pub(crate) const DEFAULT_SERVICE_RUNTIME_USER_EMAIL: &str = "service-runtime@instafy.dev";

fn parse_browser_profile_persist_project_ids(raw: &str) -> anyhow::Result<Vec<Uuid>> {
    let mut project_ids = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::parse_str(value).map_err(|error| {
                anyhow::anyhow!(
                    "BROWSER_PROFILE_PERSIST_PROJECT_IDS contains invalid UUID '{value}': {error}"
                )
            })
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    project_ids.sort_unstable();
    project_ids.dedup();
    Ok(project_ids)
}

fn extract_supabase_admin_user_id(payload: &JsonValue) -> Option<Uuid> {
    let extract_id_from_entry = |entry: &JsonValue| {
        entry
            .as_object()
            .and_then(|map| map.get("id"))
            .and_then(JsonValue::as_str)
            .and_then(|raw| Uuid::parse_str(raw.trim()).ok())
    };

    if let Some(users) = payload.get("users").and_then(JsonValue::as_array) {
        for entry in users {
            if let Some(id) = extract_id_from_entry(entry) {
                return Some(id);
            }
        }
    }

    if let Some(array) = payload.as_array() {
        for entry in array {
            if let Some(id) = extract_id_from_entry(entry) {
                return Some(id);
            }
        }
    }

    extract_id_from_entry(payload)
}

fn generate_service_runtime_password() -> String {
    let suffix: String = rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();
    format!("Instafy-{suffix}!")
}

pub(crate) fn ensure_service_runtime_user_id_via_supabase(
    supabase_project_url: &str,
    service_role_key: &str,
    email: &str,
    password_override: Option<&str>,
) -> Option<Uuid> {
    let base = supabase_project_url.trim().trim_end_matches('/');
    if base.is_empty() || service_role_key.trim().is_empty() || email.trim().is_empty() {
        return None;
    }

    let client = match reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            warn!(
                ?error,
                "failed to build Supabase admin client for service runtime user"
            );
            return None;
        }
    };

    let query_url = format!(
        "{}/auth/v1/admin/users?email={}",
        base,
        urlencoding::encode(email.trim())
    );

    let query = client
        .get(&query_url)
        .header("apikey", service_role_key)
        .bearer_auth(service_role_key)
        .send();

    if let Ok(response) = query {
        if response.status().is_success() {
            match response.json::<JsonValue>() {
                Ok(payload) => {
                    if let Some(id) = extract_supabase_admin_user_id(&payload) {
                        return Some(id);
                    }
                }
                Err(error) => {
                    warn!(
                        ?error,
                        "failed to parse Supabase admin user lookup response"
                    );
                }
            }
        }
    }

    let create_url = format!("{}/auth/v1/admin/users", base);
    let password = password_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(generate_service_runtime_password);
    let create_payload = serde_json::json!({
        "email": email.trim(),
        "password": password,
        "email_confirm": true,
    });

    let created = client
        .post(&create_url)
        .header("apikey", service_role_key)
        .bearer_auth(service_role_key)
        .json(&create_payload)
        .send();

    match created {
        Ok(response) if response.status().is_success() => match response.json::<JsonValue>() {
            Ok(payload) => extract_supabase_admin_user_id(&payload),
            Err(error) => {
                warn!(
                    ?error,
                    "failed to parse Supabase admin user create response"
                );
                None
            }
        },
        Ok(response) => {
            let status = response.status();
            let body = response.text().unwrap_or_default();
            if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY && body.contains("email_exists")
            {
                let retry = client
                    .get(&query_url)
                    .header("apikey", service_role_key)
                    .bearer_auth(service_role_key)
                    .send();
                if let Ok(retry_response) = retry {
                    if retry_response.status().is_success() {
                        if let Ok(payload) = retry_response.json::<JsonValue>() {
                            return extract_supabase_admin_user_id(&payload);
                        }
                    }
                }
            }

            warn!(
                %status,
                response_body = %body.trim().chars().take(240).collect::<String>(),
                "failed to create service runtime user via Supabase admin API"
            );
            None
        }
        Err(error) => {
            warn!(
                ?error,
                "failed to create service runtime user via Supabase admin API"
            );
            None
        }
    }
}

/// Fixed id the proxy leases for the managed ("Instafy AI") lane. It is not
/// a `user_credentials` row: the internal credential-lease route answers it
/// from `AppConfig::managed_ai_openai_api_key` without any user lookup, and
/// `agent_jobs.credential_id` (a foreign key to `user_credentials`) keeps
/// `NULL` for managed jobs. The same string is a constant in the proxy
/// (`openai_proxy_server::proxy::MANAGED_AI_CREDENTIAL_ID`); keep them equal.
pub const MANAGED_AI_CREDENTIAL_ID: &str = "4d414e41-4745-4441-8949-4e5354414659";

pub fn managed_ai_credential_id() -> Uuid {
    Uuid::from_u128(0x4d41_4e41_4745_4441_8949_4e53_5441_4659)
}

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub port: u16,
    pub database_url: String,
    pub database_pool_size: u32,
    pub redis_url: Option<String>,
    pub redis_namespace: Option<String>,
    pub redis_events_channel: Option<String>,
    pub _supabase_project_url: String,
    pub supabase_jwks_url: String,
    pub supabase_jwks: std::sync::Arc<RwLock<jwks::SupabaseJwks>>,
    pub supabase_jwks_refresh_seconds: u64,
    pub supabase_jwks_refresh_enabled: bool,
    pub controller_internal_token: Option<String>,
    pub proxy_credential_lease_token: Option<String>,
    pub supabase_service_role_key: Option<String>,
    pub agent_token_ttl_seconds: i64,
    pub user_token_ttl_seconds: i64,
    pub user_token_secret: String,
    /// PEM encoded Ed25519 private key for origin access token signing.
    pub origin_token_private_key: Option<String>,
    /// PEM encoded Ed25519 public key that matches `origin_token_private_key`.
    pub origin_token_public_key: Option<String>,
    /// Optional key identifier advertised via JWKS.
    pub origin_token_key_id: Option<String>,
    /// Lifetime (seconds) for origin access tokens.
    pub origin_token_ttl_seconds: i64,
    pub lease_path: String,
    pub heartbeat_path: String,
    pub stop_path: String,
    pub proxy_signing_secret: Option<String>,
    pub proxy_base_url: Option<String>,
    pub proxy_token_ttl_seconds: i64,
    pub credential_encryption_key: Option<CredentialEncryptionKey>,
    /// Projects explicitly permitted to persist the shared hosted-browser
    /// profile. Empty by default: durable shared logins are a privacy-sensitive
    /// capability and must never be enabled from client-supplied metadata.
    pub browser_profile_persist_project_ids: Vec<Uuid>,
    /// Controller-owned interval forwarded to allowlisted runtimes. The client
    /// cannot override this value through runtime metadata.
    pub browser_profile_snapshot_secs: u64,
    pub progress_callback_secret: Option<String>,
    pub git_remote_base_url: Option<String>,
    pub git_remote_public_base_url: Option<String>,
    pub git_shards: Vec<String>,
    pub hosted_origin_endpoint: Option<String>,
    #[allow(dead_code)]
    pub(crate) browser_turn_rest: Option<crate::browser_turn::BrowserTurnRestConfig>,
    pub sandbox_credit_seed_amount: i32,
    pub sandbox_credit_seed_limit: i32,
    pub billing_unit_label: String,
    pub billing_units_per_usd: i64,
    pub tunnel_credit_burn_amount: i32,
    pub tunnel_credit_burn_interval_seconds: i64,
    pub tunnel_credit_burn_lead_seconds: i64,
    pub hosted_runtime_credit_burn_amount: i32,
    pub hosted_runtime_credit_burn_interval_seconds: i64,
    pub managed_ai_enabled: bool,
    pub managed_ai_label: String,
    pub managed_ai_credit_burn_amount: i32,
    pub managed_ai_daily_prompt_limit: i32,
    pub managed_ai_model_id: String,
    pub managed_ai_model_label: String,
    pub managed_ai_input_usd_micros_per_1k: i64,
    pub managed_ai_cached_input_usd_micros_per_1k: i64,
    pub managed_ai_output_usd_micros_per_1k: i64,
    pub managed_ai_startup_check: bool,
    /// Controller-owned OpenAI API key for the managed lane. Proxies lease it
    /// through the internal credential-lease route under
    /// [`MANAGED_AI_CREDENTIAL_ID`], so a per-runtime proxy sidecar with no
    /// static credentials of its own can still serve managed turns. Unset
    /// keeps the static-proxy path: managed turns then need a proxy that
    /// holds its own `OPENAI_API_KEY` or `auth.json`.
    pub managed_ai_openai_api_key: Option<String>,
    pub tunnel_broker_hook_secret: Option<String>,
    pub git_event_hook_secret: Option<String>,
    pub _controller_external_url: Option<String>,
    /// Canonical public Studio origin used for links that leave the app, such
    /// as invitation emails. This is validated at startup so invitation tokens
    /// are never accidentally placed in an unsupported or insecure URL.
    pub public_app_url: String,
    pub workspace_root: Option<PathBuf>,
    pub strict_mode: bool,
    pub dev_isolation_mode: bool,
    pub dev_mode: bool,
    pub runtime_idle_release_seconds: i64,
    /// Stop a healthy hosted runtime after this many seconds with no user
    /// activity and no leased job. Without this, an abandoned runtime bills
    /// credits until the org runs dry. 0 disables. Distinct from
    /// runtime_idle_release_seconds, which only releases job leases.
    pub runtime_idle_stop_seconds: i64,
    /// How long a hosted runtime in another space must have been idle before a
    /// space that is blocked by the org's runtime limit may reclaim its slot.
    /// 0 disables demand-driven reclaim and restores the plain refusal.
    pub runtime_limit_reclaim_idle_seconds: i64,
    /// Max organizations a single non-service user may own. Bounds open-signup
    /// abuse: every org auto-subscribes to Starter (daily credits + runtime
    /// slots), so unbounded org creation multiplies free compute. 0 disables.
    pub max_orgs_per_user: i64,
    /// Platform-wide ceiling on concurrently-active Instafy Cloud runtimes.
    /// Hosted runtimes run as containers on the controller box, so open signup
    /// without this can OOM the host. Checked before per-org limits at the
    /// runtime-allocation gate; over it, allocation is refused with a clean
    /// "at capacity". 0 disables (no global cap).
    pub max_active_hosted_runtimes_global: i64,
    pub auto_create_projects: bool,
    pub service_runtime_user_id: Option<Uuid>,
    pub dev_project_registry_path: Option<PathBuf>,
    pub runtime_providers: Vec<RuntimeProviderConfig>,
    pub self_hosted_tunnel_broker: Option<SelfHostedTunnelConfig>,
    pub stripe: Option<StripeConfig>,
    pub operator_console_org_id: Option<Uuid>,
    pub operator_console_allowed_user_ids: Vec<Uuid>,
    /// User ids granted the operator projection and triage updates on the
    /// bug-report routes only. Unlike `operator_console_allowed_user_ids`,
    /// this list grants nothing else (no OTA, desktop-update, telemetry or
    /// operator-admin access). Empty/unset means nobody holds the role.
    pub bug_reports_operator_user_ids: Vec<Uuid>,
    pub desktop_release_github_owner: Option<String>,
    pub desktop_release_github_repo: Option<String>,
    pub desktop_release_github_token: Option<String>,
    pub desktop_release_promote_workflow: String,
    pub cloudflare_api_token: Option<String>,
    pub cloudflare_zone_id: Option<String>,
    pub downloads_public_host: String,
    pub desktop_downloads_prefix: String,
    pub mobile_ota_downloads_prefix: String,
    pub web_push_vapid_public_key: Option<String>,
    pub web_push_vapid_private_key: Option<String>,
    pub web_push_vapid_subject: Option<String>,
    pub apns_key_id: Option<String>,
    pub apns_team_id: Option<String>,
    pub apns_bundle_id: Option<String>,
    pub apns_private_key: Option<String>,
    pub apns_use_sandbox: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeProviderConfig {
    pub id: String,
    pub display_name: String,
    pub kind: String,
    #[serde(default)]
    pub owner_org_id: Option<Uuid>,
    #[serde(default)]
    pub allowed_org_ids: Vec<Uuid>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub auth_token: Option<String>,
    #[serde(default)]
    pub metadata: Option<JsonValue>,
}

fn normalize_public_app_url(configured: Option<&str>, dev_mode: bool) -> anyhow::Result<String> {
    let default = if dev_mode {
        "http://localhost:5173"
    } else {
        "https://instafy.dev"
    };
    let raw = configured.unwrap_or(default).trim();
    let parsed = reqwest::Url::parse(raw)
        .map_err(|error| anyhow::anyhow!("PUBLIC_APP_URL must be an absolute URL: {error}"))?;

    if !matches!(parsed.scheme(), "http" | "https") {
        anyhow::bail!("PUBLIC_APP_URL must use http or https");
    }
    if parsed.host_str().is_none() {
        anyhow::bail!("PUBLIC_APP_URL must include a host");
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        anyhow::bail!("PUBLIC_APP_URL must not include credentials");
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        anyhow::bail!("PUBLIC_APP_URL must not include a query or fragment");
    }
    if parsed.path() != "/" && !parsed.path().is_empty() {
        anyhow::bail!("PUBLIC_APP_URL must be an origin without a path");
    }
    if parsed.scheme() == "http" && !dev_mode {
        anyhow::bail!("PUBLIC_APP_URL must use https outside development mode");
    }

    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

impl AppConfig {
    pub fn from_env() -> anyhow::Result<Self> {
        fn read_first_env(vars: &[&str]) -> Option<String> {
            vars.iter().find_map(|name| {
                std::env::var(name)
                    .ok()
                    .map(|raw| raw.trim().to_string())
                    .filter(|value| !value.is_empty())
            })
        }

        fn read_first_env_b64(vars: &[&str]) -> anyhow::Result<Option<String>> {
            for name in vars {
                let raw = match std::env::var(name) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let decoded = BASE64
                    .decode(trimmed.as_bytes())
                    .map_err(|error| anyhow::anyhow!("{name} must be valid base64: {error}"))?;
                let decoded = String::from_utf8(decoded)
                    .map_err(|error| anyhow::anyhow!("{name} must decode to UTF-8: {error}"))?;
                let decoded = decoded.trim().to_string();
                if !decoded.is_empty() {
                    return Ok(Some(decoded));
                }
            }

            Ok(None)
        }

        fn parse_jwt_role(token: &str) -> Option<String> {
            let mut parts = token.split('.');
            let _header = parts.next()?;
            let payload = parts.next()?;
            if payload.trim().is_empty() {
                return None;
            }
            let decoded = BASE64URL.decode(payload.as_bytes()).ok()?;
            let json: JsonValue = serde_json::from_slice(&decoded).ok()?;
            json.get("role")
                .and_then(JsonValue::as_str)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        }

        fn parse_uuid_list(raw: &str) -> Vec<Uuid> {
            raw.split(',')
                .filter_map(|value| Uuid::parse_str(value.trim()).ok())
                .collect()
        }

        // Parse controller-only TURN secrets before any network-dependent
        // startup work so partial or unsafe configuration fails immediately.
        let browser_turn_rest = crate::browser_turn::BrowserTurnRestConfig::from_env()?;

        let dev_mode = std::env::var("DEV_MODE")
            .ok()
            .map(|value| value.to_lowercase())
            .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false);
        // The session signing secret and the credential encryption key are
        // checked here, before any network IO, for the same reason: a
        // controller running on a published or missing value must not start.
        let user_token_secret = resolve_user_token_secret(
            dev_mode,
            std::env::var("USER_TOKEN_SECRET").ok().as_deref(),
        )?;
        let credential_encryption_key = resolve_credential_encryption_key(
            dev_mode,
            std::env::var("CREDENTIAL_ENCRYPTION_KEY").ok().as_deref(),
            &user_token_secret,
        )?;
        if !dev_mode && is_published_credential_encryption_key(&credential_encryption_key) {
            warn!(
                "CREDENTIAL_ENCRYPTION_KEY is the key derived from the published development \
                 USER_TOKEN_SECRET. Anyone with a copy of the database can decrypt stored \
                 credentials; re-encrypt them under a freshly generated key"
            );
        }

        let port = std::env::var("PORT")
            .ok()
            .and_then(|raw| raw.parse::<u16>().ok())
            .unwrap_or(8788);
        let database_url = std::env::var("DATABASE_URL")
            .map_err(|_| anyhow::anyhow!("DATABASE_URL must be set"))?;
        // Playwright/local dev runs can fan out many concurrent controller requests. If callers
        // don't explicitly size the pool, default to a slightly larger pool in dev mode to avoid
        // bb8 timeouts during e2e runs.
        let configured_database_pool_size = std::env::var("DATABASE_POOL_SIZE").ok();
        let dev_mode_hint = std::env::var("DEV_MODE").ok();
        let database_pool_size = database_pool_size_from_values(
            configured_database_pool_size.as_deref(),
            dev_mode_hint.as_deref(),
        );
        let redis_url = std::env::var("REDIS_URL")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty());
        let redis_namespace = std::env::var("REDIS_NAMESPACE")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty());
        let redis_events_channel = std::env::var("REDIS_EVENTS_CHANNEL")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty());
        let (redis_namespace, redis_events_channel) = if redis_url.is_some() {
            let namespace = redis_namespace.unwrap_or_else(|| "instafy".to_string());
            let channel =
                redis_events_channel.unwrap_or_else(|| format!("{namespace}:controller:events"));
            (Some(namespace), Some(channel))
        } else {
            (None, None)
        };
        let supabase_project_url = std::env::var("SUPABASE_PROJECT_URL")
            .or_else(|_| std::env::var("SUPABASE_URL"))
            .or_else(|_| std::env::var("VITE_SUPABASE_URL"))
            .or_else(|_| std::env::var("NEXT_PUBLIC_SUPABASE_URL"))
            .map_err(|_| {
                anyhow::anyhow!(
                    "SUPABASE_PROJECT_URL must be set (or SUPABASE_URL / VITE_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL)"
                )
            })?;
        let supabase_project_url = supabase_project_url
            .trim()
            .trim_end_matches('/')
            .to_string();
        let supabase_jwks_url = std::env::var("SUPABASE_JWKS_URL")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| format!("{}/auth/v1/.well-known/jwks.json", supabase_project_url));
        let shared_hmac_secret = std::env::var("SUPABASE_JWT_SECRET")
            .or_else(|_| std::env::var("JWT_SECRET"))
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty());

        let (supabase_jwks, supabase_jwks_refresh_enabled) = match thread::spawn({
            let url = supabase_jwks_url.clone();
            move || jwks::SupabaseJwks::load(&url)
        })
        .join()
        {
            Ok(Ok(value)) => (value, true),
            Ok(Err(error)) => {
                if let Some(secret) = shared_hmac_secret.clone() {
                    warn!(
                        %error,
                        jwks_url = %supabase_jwks_url,
                        "initial Supabase JWKS load failed; falling back to HS256 shared secret and RETRYING (see https://github.com/supabase/cli/issues/4098)"
                    );
                    // Refresh stays ENABLED. Returning false here latched the
                    // process into HS256 for its whole lifetime: both recovery
                    // paths (the periodic refresher in main.rs and the
                    // retry-on-auth-failure in auth.rs) are gated on this flag
                    // and nothing ever set it back. A transient fetch failure
                    // at boot therefore became permanent, and stayed invisible
                    // until the project rotated to asymmetric signing keys --
                    // at which point every token failed and the outage was
                    // 16 hours rather than the <=5 minutes one refresh cycle
                    // would have cost (2026-08-11).
                    (jwks::SupabaseJwks::from_hmac_secret(&secret), true)
                } else {
                    return Err(error.context(
                        "failed to load Supabase JWKS and no SUPABASE_JWT_SECRET / JWT_SECRET fallback provided",
                    ));
                }
            }
            Err(panic) => {
                if let Some(secret) = shared_hmac_secret.clone() {
                    warn!(
                        ?panic,
                        jwks_url = %supabase_jwks_url,
                        "JWKS loader panicked; falling back to HS256 shared secret and RETRYING (see https://github.com/supabase/cli/issues/4098)"
                    );
                    // Enabled for the same reason as the arm above: a fallback
                    // must be temporary, never a latch.
                    (jwks::SupabaseJwks::from_hmac_secret(&secret), true)
                } else {
                    return Err(anyhow::anyhow!(
                        "failed to load Supabase JWKS: loader thread panicked"
                    ));
                }
            }
        };
        let supabase_jwks_refresh_seconds = std::env::var("SUPABASE_JWKS_REFRESH_SECONDS")
            .ok()
            .and_then(|raw| raw.parse::<u64>().ok())
            .filter(|value| *value >= 30)
            .unwrap_or(300);
        let controller_internal_token = std::env::var("CONTROLLER_INTERNAL_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let proxy_credential_lease_token = std::env::var("PROXY_CREDENTIAL_LEASE_TOKEN")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let supabase_service_role_key = std::env::var("SUPABASE_SERVICE_ROLE_KEY")
            .or_else(|_| std::env::var("SERVICE_ROLE_KEY"))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if let Some(token) = supabase_service_role_key.as_deref() {
            if let Some(role) = parse_jwt_role(token) {
                if role == "anon" {
                    return Err(anyhow::anyhow!(
                        "SUPABASE_SERVICE_ROLE_KEY appears to be an anon key; use the service_role key instead"
                    ));
                }
            }
        }
        let agent_token_ttl_seconds = std::env::var("AGENT_TOKEN_TTL_SECONDS")
            .ok()
            .and_then(|raw| raw.parse::<i64>().ok())
            .filter(|ttl| *ttl > 0)
            .unwrap_or(3600);
        let user_token_ttl_seconds = std::env::var("USER_TOKEN_TTL_SECONDS")
            .ok()
            .and_then(|raw| raw.parse::<i64>().ok())
            .filter(|ttl| *ttl > 0)
            .unwrap_or(900);
        let origin_token_private_key = read_first_env_b64(&["RUNTIME_SIGNING_PRIVATE_KEY_B64"])?
            .or_else(|| read_first_env(&["RUNTIME_SIGNING_PRIVATE_KEY"]));
        let origin_token_public_key = read_first_env_b64(&["RUNTIME_SIGNING_PUBLIC_KEY_B64"])?
            .or_else(|| read_first_env(&["RUNTIME_SIGNING_PUBLIC_KEY"]));
        let origin_token_key_id = read_first_env(&["RUNTIME_SIGNING_KEY_ID"]);

        let origin_token_ttl_seconds = std::env::var("RUNTIME_SIGNING_TOKEN_TTL_SECONDS")
            .ok()
            .and_then(|raw| raw.parse::<i64>().ok())
            .unwrap_or(300);

        let lease_path = std::env::var("RUNTIME_LEASE_PATH")
            .ok()
            .unwrap_or_else(|| "/agent/lease".to_string());
        let heartbeat_path = std::env::var("RUNTIME_HEARTBEAT_PATH")
            .ok()
            .unwrap_or_else(|| "/agent/heartbeat".to_string());
        let stop_path = std::env::var("RUNTIME_STOP_PATH")
            .ok()
            .unwrap_or_else(|| "/runtime/stop".to_string());

        let proxy_signing_secret = std::env::var("PROXY_SIGNING_SECRET")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let operator_console_org_id = std::env::var("OPERATOR_CONSOLE_ORG_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(|value| Uuid::parse_str(&value))
            .transpose()
            .map_err(|error| {
                anyhow::anyhow!("OPERATOR_CONSOLE_ORG_ID must be a valid UUID: {error}")
            })?;
        let operator_console_allowed_user_ids = std::env::var("OPERATOR_CONSOLE_ALLOWED_USER_IDS")
            .ok()
            .map(|value| parse_uuid_list(&value))
            .unwrap_or_default();
        let bug_reports_operator_user_ids = std::env::var("BUG_REPORTS_OPERATOR_USER_IDS")
            .ok()
            .map(|value| parse_uuid_list(&value))
            .unwrap_or_default();
        let desktop_release_github_owner = read_first_env(&["DESKTOP_RELEASE_GITHUB_OWNER"]);
        let desktop_release_github_repo = read_first_env(&["DESKTOP_RELEASE_GITHUB_REPO"]);
        let desktop_release_github_token = read_first_env(&["DESKTOP_RELEASE_GITHUB_TOKEN"]);
        let desktop_release_promote_workflow =
            read_first_env(&["DESKTOP_RELEASE_PROMOTE_WORKFLOW"])
                .unwrap_or_else(|| "desktop-promote.yml".to_string());
        let cloudflare_api_token = read_first_env(&["CLOUDFLARE_API_TOKEN"]);
        let cloudflare_zone_id = read_first_env(&["CLOUDFLARE_ZONE_ID"]);
        let downloads_public_host = read_first_env(&["DOWNLOADS_PUBLIC_HOST"])
            .unwrap_or_else(|| "downloads.instafy.dev".to_string());
        let desktop_downloads_prefix = read_first_env(&["DESKTOP_DOWNLOADS_PREFIX"])
            .unwrap_or_else(|| "desktop-app".to_string());
        let mobile_ota_downloads_prefix = read_first_env(&["MOBILE_OTA_DOWNLOADS_PREFIX"])
            .unwrap_or_else(|| "mobile".to_string());
        let proxy_base_url = std::env::var("PROXY_BASE_URL")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let proxy_token_ttl_seconds = std::env::var("PROXY_TOKEN_TTL_SECONDS")
            .ok()
            .and_then(|raw| raw.parse::<i64>().ok())
            .filter(|ttl| *ttl > 0)
            .unwrap_or(1800);

        let browser_profile_persist_project_ids =
            std::env::var("BROWSER_PROFILE_PERSIST_PROJECT_IDS")
                .ok()
                .map(|raw| parse_browser_profile_persist_project_ids(&raw))
                .transpose()?
                .unwrap_or_default();
        let browser_profile_snapshot_secs = match std::env::var("BROWSER_PROFILE_SNAPSHOT_SECS") {
            Ok(raw) if !raw.trim().is_empty() => {
                let value = raw.trim().parse::<u64>().map_err(|error| {
                    anyhow::anyhow!(
                        "BROWSER_PROFILE_SNAPSHOT_SECS must be an integer from 5 to 3600: {error}"
                    )
                })?;
                anyhow::ensure!(
                    (5..=3600).contains(&value),
                    "BROWSER_PROFILE_SNAPSHOT_SECS must be between 5 and 3600"
                );
                value
            }
            _ => 30,
        };

        let progress_callback_secret = std::env::var("PROGRESS_CALLBACK_SECRET")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let git_remote_base_url = read_first_env(&["GIT_REMOTE_BASE_URL"])
            .map(|value| value.trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty());

        // Base advertised to runtimes outside the cluster network (Desktop/CLI);
        // falls back to GIT_REMOTE_BASE_URL when unset.
        let git_remote_public_base_url = read_first_env(&["GIT_REMOTE_PUBLIC_BASE_URL"])
            .map(|value| value.trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty());

        let git_shards = read_first_env(&["GIT_SHARDS"])
            .map(|raw| {
                raw.split(',')
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();

        let hosted_origin_endpoint = read_first_env(&["HOSTED_ORIGIN_ENDPOINT"])
            .map(|value| value.trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty());

        let sandbox_credit_seed_amount = std::env::var("SANDBOX_CREDIT_SEED_AMOUNT")
            .ok()
            .and_then(|raw| raw.parse::<i32>().ok())
            .unwrap_or(25);
        let sandbox_credit_seed_limit = std::env::var("SANDBOX_CREDIT_SEED_LIMIT")
            .ok()
            .and_then(|raw| raw.parse::<i32>().ok())
            .unwrap_or(25);

        let tunnel_credit_burn_amount = std::env::var("TUNNEL_CREDIT_BURN_AMOUNT")
            .ok()
            .and_then(|raw| raw.parse::<i32>().ok())
            .unwrap_or(0);
        let tunnel_credit_burn_interval_seconds =
            std::env::var("TUNNEL_CREDIT_BURN_INTERVAL_SECONDS")
                .ok()
                .and_then(|raw| raw.parse::<i64>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(600);
        let tunnel_credit_burn_lead_seconds = std::env::var("TUNNEL_CREDIT_BURN_LEAD_SECONDS")
            .ok()
            .and_then(|raw| raw.parse::<i64>().ok())
            .filter(|value| *value >= 0)
            .unwrap_or(60);

        let hosted_runtime_credit_burn_amount = std::env::var("HOSTED_RUNTIME_CREDIT_BURN_AMOUNT")
            .ok()
            .and_then(|raw| raw.parse::<i32>().ok())
            .unwrap_or(0);
        let hosted_runtime_credit_burn_interval_seconds =
            std::env::var("HOSTED_RUNTIME_CREDIT_BURN_INTERVAL_SECONDS")
                .ok()
                .and_then(|raw| raw.parse::<i64>().ok())
                .filter(|value| *value > 0)
                .unwrap_or(600);
        let billing_unit_label =
            read_first_env(&["BILLING_UNIT_LABEL"]).unwrap_or_else(|| "credits".to_string());
        let billing_units_per_usd = std::env::var("BILLING_UNITS_PER_USD")
            .ok()
            .and_then(|raw| raw.parse::<i64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(1_000);
        let managed_ai_enabled = std::env::var("MANAGED_AI_ENABLED")
            .ok()
            .map(|value| value.to_lowercase())
            .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(true);
        let managed_ai_label =
            read_first_env(&["MANAGED_AI_LABEL"]).unwrap_or_else(|| "Instafy AI".to_string());
        let managed_ai_credit_burn_amount = std::env::var("MANAGED_AI_CREDIT_BURN_AMOUNT")
            .ok()
            .and_then(|raw| raw.parse::<i32>().ok())
            .unwrap_or(1);
        let managed_ai_daily_prompt_limit = std::env::var("MANAGED_AI_DAILY_PROMPT_LIMIT")
            .ok()
            .and_then(|raw| raw.parse::<i32>().ok())
            .unwrap_or(20);
        // Managed "Instafy AI" tier (operator-paid): model and list prices default
        // to Luna. BYO credential defaults live in credentials.rs and stay on Sol.
        let managed_ai_model_id = read_first_env(&["MANAGED_AI_MODEL_ID"])
            .unwrap_or_else(|| default_managed_ai_model_id().to_string());
        let managed_ai_model_label = read_first_env(&["MANAGED_AI_MODEL_LABEL"])
            .unwrap_or_else(|| default_managed_ai_model_label().to_string());
        let managed_ai_input_usd_micros_per_1k =
            std::env::var("MANAGED_AI_INPUT_USD_MICROS_PER_1K")
                .ok()
                .and_then(|raw| raw.parse::<i64>().ok())
                .unwrap_or(DEFAULT_MANAGED_AI_INPUT_USD_MICROS_PER_1K);
        let managed_ai_cached_input_usd_micros_per_1k =
            std::env::var("MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K")
                .ok()
                .and_then(|raw| raw.parse::<i64>().ok())
                .unwrap_or(DEFAULT_MANAGED_AI_CACHED_INPUT_USD_MICROS_PER_1K);
        let managed_ai_output_usd_micros_per_1k =
            std::env::var("MANAGED_AI_OUTPUT_USD_MICROS_PER_1K")
                .ok()
                .and_then(|raw| raw.parse::<i64>().ok())
                .unwrap_or(DEFAULT_MANAGED_AI_OUTPUT_USD_MICROS_PER_1K);
        // Platform key served to proxies as the managed credential lease. Kept
        // on the controller only; it never reaches runtime containers.
        // Hosted deployments hand the managed key to the controller as
        // OPENAI_API_KEY (it is also copied into the controller-side proxy),
        // so honour that name as the fallback and keep the lease and the
        // static proxy on one key.
        let managed_ai_openai_api_key =
            read_first_env(&["MANAGED_AI_OPENAI_API_KEY", "OPENAI_API_KEY"]);

        let tunnel_broker_hook_secret = std::env::var("TUNNEL_BROKER_HOOK_SECRET")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let git_event_hook_secret = read_first_env(&["GIT_EVENT_HOOK_SECRET"])
            .or_else(|| controller_internal_token.clone())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        let workspace_root = std::env::var("WORKSPACE_ROOT")
            .ok()
            .map(|value| PathBuf::from(value.trim()))
            .filter(|value| value.exists());

        let strict_mode = std::env::var("STRICT_MODE")
            .ok()
            .map(|value| value.to_lowercase())
            .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false);
        let dev_isolation_mode = std::env::var("DEV_ISOLATION_MODE")
            .ok()
            .map(|value| value.to_lowercase())
            .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false);
        let configured_public_app_url = read_first_env(&["PUBLIC_APP_URL", "VITE_PUBLIC_APP_URL"]);
        let public_app_url =
            normalize_public_app_url(configured_public_app_url.as_deref(), dev_mode)?;
        let managed_ai_startup_check = std::env::var("MANAGED_AI_STARTUP_CHECK")
            .ok()
            .map(|value| value.to_lowercase())
            .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(managed_ai_enabled && !dev_mode);

        let runtime_idle_release_seconds = std::env::var("RUNTIME_IDLE_RELEASE_SECONDS")
            .ok()
            .and_then(|raw| raw.parse::<i64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(if strict_mode { 15 } else { 150 });
        // "Paused after N min of inactivity" — full stop, not lease release.
        // 0 disables (explicitly setting 0 keeps old always-on behavior).
        let runtime_idle_stop_seconds = std::env::var("RUNTIME_IDLE_STOP_SECONDS")
            .ok()
            .and_then(|raw| raw.parse::<i64>().ok())
            .filter(|value| *value >= 0)
            .unwrap_or(1800);
        // Demand-driven slot reclaim. Deliberately far shorter than the idle
        // sweep above: nobody is waiting during a background sweep, whereas
        // here a person is staring at a blocked prompt. Short enough to help
        // when they moved to another space, long enough that a machine someone
        // is still using (or that just booted) is never taken. 0 disables.
        let runtime_limit_reclaim_idle_seconds =
            std::env::var("RUNTIME_LIMIT_RECLAIM_IDLE_SECONDS")
                .ok()
                .and_then(|raw| raw.parse::<i64>().ok())
                .filter(|value| *value >= 0)
                .unwrap_or(120);
        // 0 disables the cap. Default 5: a legit user has 1 auto-created
        // personal org plus room for a few team/project orgs; well below the
        // volume an abuser needs to multiply free Starter credits.
        let max_orgs_per_user = std::env::var("MAX_ORGS_PER_USER")
            .ok()
            .and_then(|raw| raw.parse::<i64>().ok())
            .filter(|value| *value >= 0)
            .unwrap_or(5);
        // 0 disables the platform cap. Defaults off so no environment changes
        // behavior implicitly; production sets a real value sized to the host
        // (see deploy.yml). Negative values are ignored.
        let max_active_hosted_runtimes_global = std::env::var("MAX_ACTIVE_HOSTED_RUNTIMES_GLOBAL")
            .ok()
            .and_then(|raw| raw.parse::<i64>().ok())
            .filter(|value| *value >= 0)
            .unwrap_or(0);
        let auto_create_projects = std::env::var("AUTO_CREATE_PROJECTS")
            .map(|raw| raw.to_lowercase())
            .map(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
            .unwrap_or(false);

        let service_runtime_user_id = std::env::var("SERVICE_RUNTIME_USER_ID")
            .ok()
            .and_then(|raw| {
                let cleaned = raw.trim();
                if cleaned.is_empty() {
                    None
                } else {
                    Some(cleaned.to_string())
                }
            })
            .and_then(|raw| {
                let decoded = BASE64
                    .decode(raw.as_bytes())
                    .ok()
                    .and_then(|bytes| String::from_utf8(bytes).ok());
                decoded.unwrap_or(raw).parse().ok()
            });
        let service_runtime_user_email = std::env::var("SERVICE_RUNTIME_USER_EMAIL")
            .ok()
            .map(|raw| raw.trim().to_ascii_lowercase())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| DEFAULT_SERVICE_RUNTIME_USER_EMAIL.to_string());
        let service_runtime_user_password = std::env::var("SERVICE_RUNTIME_USER_PASSWORD")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|value| !value.is_empty());
        let service_runtime_user_id = service_runtime_user_id.or_else(|| {
            let Some(service_role_key) = supabase_service_role_key.as_deref() else {
                warn!("SERVICE_RUNTIME_USER_ID is unset and SUPABASE_SERVICE_ROLE_KEY is unavailable; runtime agents cannot sync workspace changes.");
                return None;
            };
            let ensured = ensure_service_runtime_user_id_via_supabase(
                &supabase_project_url,
                service_role_key,
                &service_runtime_user_email,
                service_runtime_user_password.as_deref(),
            );
            if let Some(id) = ensured {
                info!(service_runtime_user_id = %id, "bootstrapped SERVICE_RUNTIME_USER_ID via Supabase admin API");
            } else {
                warn!("failed to bootstrap SERVICE_RUNTIME_USER_ID via Supabase admin API; runtime agents may not sync workspace changes");
            }
            ensured
        });

        let dev_project_registry_path = std::env::var("DEV_PROJECT_REGISTRY_PATH")
            .ok()
            .map(|value| PathBuf::from(value.trim()))
            .filter(|value| value.exists());
        let mut runtime_providers: Vec<RuntimeProviderConfig> = std::env::var("RUNTIME_PROVIDERS")
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_else(|| {
                let kind = std::env::var("RUNTIME_PROVIDER_KIND")
                    .ok()
                    .map(|value| crate::provider_identifiers::canonical_provider_kind(&value))
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "external_http".to_string());
                let endpoint = std::env::var("RUNTIME_PROVIDER_ENDPOINT").ok();
                let auth_token = std::env::var("RUNTIME_PROVIDER_AUTH_TOKEN").ok();

                vec![RuntimeProviderConfig {
                    id: "default".to_string(),
                    display_name: "Default".to_string(),
                    kind,
                    owner_org_id: None,
                    allowed_org_ids: vec![],
                    endpoint,
                    auth_token,
                    metadata: None,
                }]
            });
        for provider in &mut runtime_providers {
            provider.kind = crate::provider_identifiers::canonical_provider_kind(&provider.kind);
        }

        let self_hosted_tunnel_broker = std::env::var("TUNNEL_BROKER_BASE_URL").ok().map(|base| {
            let token =
                std::env::var("TUNNEL_BROKER_TOKEN").unwrap_or_else(|_| "dev-token".to_string());
            SelfHostedTunnelConfig {
                base_url: base.trim_end_matches('/').to_string(),
                api_token: token,
            }
        });

        let stripe = StripeConfig::from_env();

        let web_push_vapid_public_key =
            read_first_env(&["WEB_PUSH_VAPID_PUBLIC_KEY", "VAPID_PUBLIC_KEY"]);
        let web_push_vapid_private_key =
            read_first_env(&["WEB_PUSH_VAPID_PRIVATE_KEY", "VAPID_PRIVATE_KEY"]);
        let web_push_vapid_subject = read_first_env(&["WEB_PUSH_VAPID_SUBJECT", "VAPID_SUBJECT"]);

        let apns_key_id = read_first_env(&["APNS_KEY_ID"]);
        let apns_team_id = read_first_env(&["APNS_TEAM_ID"]);
        let apns_bundle_id = read_first_env(&["APNS_BUNDLE_ID"]);
        let apns_private_key = read_first_env_b64(&["APNS_PRIVATE_KEY_B64"])?
            .or_else(|| read_first_env(&["APNS_PRIVATE_KEY"]));
        let apns_use_sandbox = std::env::var("APNS_USE_SANDBOX")
            .ok()
            .map(|raw| raw.trim().eq_ignore_ascii_case("true") || raw.trim() == "1")
            .unwrap_or(false);

        Ok(Self {
            port,
            database_url,
            database_pool_size,
            redis_url,
            redis_namespace,
            redis_events_channel,
            _supabase_project_url: supabase_project_url,
            supabase_jwks_url,
            supabase_jwks: std::sync::Arc::new(RwLock::new(supabase_jwks)),
            supabase_jwks_refresh_seconds,
            supabase_jwks_refresh_enabled,
            controller_internal_token,
            proxy_credential_lease_token,
            supabase_service_role_key,
            agent_token_ttl_seconds,
            user_token_ttl_seconds,
            user_token_secret,
            origin_token_private_key,
            origin_token_public_key,
            origin_token_key_id,
            origin_token_ttl_seconds,
            lease_path,
            heartbeat_path,
            stop_path,
            proxy_signing_secret,
            proxy_base_url,
            proxy_token_ttl_seconds,
            credential_encryption_key: Some(credential_encryption_key),
            browser_profile_persist_project_ids,
            browser_profile_snapshot_secs,
            progress_callback_secret,
            git_remote_base_url,
            git_remote_public_base_url,
            git_shards,
            hosted_origin_endpoint,
            browser_turn_rest,
            sandbox_credit_seed_amount,
            sandbox_credit_seed_limit,
            billing_unit_label,
            billing_units_per_usd,
            tunnel_credit_burn_amount,
            tunnel_credit_burn_interval_seconds,
            tunnel_credit_burn_lead_seconds,
            hosted_runtime_credit_burn_amount,
            hosted_runtime_credit_burn_interval_seconds,
            managed_ai_enabled,
            managed_ai_label,
            managed_ai_credit_burn_amount,
            managed_ai_daily_prompt_limit,
            managed_ai_model_id,
            managed_ai_model_label,
            managed_ai_input_usd_micros_per_1k,
            managed_ai_cached_input_usd_micros_per_1k,
            managed_ai_output_usd_micros_per_1k,
            managed_ai_startup_check,
            managed_ai_openai_api_key,
            tunnel_broker_hook_secret,
            git_event_hook_secret,
            _controller_external_url: std::env::var("CONTROLLER_EXTERNAL_URL").ok(),
            public_app_url,
            workspace_root,
            strict_mode,
            dev_isolation_mode,
            dev_mode,
            runtime_idle_release_seconds,
            runtime_idle_stop_seconds,
            runtime_limit_reclaim_idle_seconds,
            max_orgs_per_user,
            max_active_hosted_runtimes_global,
            auto_create_projects,
            service_runtime_user_id,
            dev_project_registry_path,
            runtime_providers,
            self_hosted_tunnel_broker,
            stripe,
            operator_console_org_id,
            operator_console_allowed_user_ids,
            bug_reports_operator_user_ids,
            desktop_release_github_owner,
            desktop_release_github_repo,
            desktop_release_github_token,
            desktop_release_promote_workflow,
            cloudflare_api_token,
            cloudflare_zone_id,
            downloads_public_host,
            desktop_downloads_prefix,
            mobile_ota_downloads_prefix,
            web_push_vapid_public_key,
            web_push_vapid_private_key,
            web_push_vapid_subject,
            apns_key_id,
            apns_team_id,
            apns_bundle_id,
            apns_private_key,
            apns_use_sandbox,
        })
    }

    pub async fn build_pool(&self) -> anyhow::Result<PgPool> {
        let manager =
            PostgresConnectionManager::new_from_stringlike(&self.database_url, database_tls())
                .map_err(|error| anyhow::anyhow!("failed to parse DATABASE_URL: {error}"))?;
        Pool::builder()
            .max_size(self.database_pool_size)
            .connection_timeout(Duration::from_secs(10))
            .build(manager)
            .await
            .map_err(|error| anyhow::anyhow!("failed to create postgres pool: {error}"))
    }

    pub fn browser_profile_persistence_enabled_for_project(&self, project_id: &Uuid) -> bool {
        self.browser_profile_persist_project_ids
            .iter()
            .any(|allowed| allowed == project_id)
    }
}

#[derive(Clone, Debug)]
pub struct SelfHostedTunnelConfig {
    pub base_url: String,
    pub api_token: String,
}

#[derive(Clone, Debug)]
pub struct StripeConfig {
    pub secret_key: String,
    pub api_base_url: String,
    pub price_lookup: HashMap<String, String>,
    pub webhook_secret: Option<String>,
    /// Explicit billing-portal configuration (bpc_…). When unset, portal
    /// sessions use the account's default configuration, which can drift.
    pub portal_configuration_id: Option<String>,
    /// Max age (seconds) accepted for the `t=` timestamp in Stripe-Signature
    /// headers; older/newer deliveries are rejected to prevent replay.
    pub webhook_tolerance_seconds: i64,
    /// Require the Stripe-hosted checkout to collect terms-of-service consent
    /// (needs the ToS URL configured in the Stripe dashboard first).
    pub checkout_tos_consent: bool,
}

impl StripeConfig {
    pub fn from_env() -> Option<Self> {
        let secret_key = std::env::var("STRIPE_SECRET_KEY").ok()?.trim().to_string();
        if secret_key.is_empty() {
            return None;
        }
        let api_base_url = std::env::var("STRIPE_API_BASE_URL")
            .unwrap_or_else(|_| "https://api.stripe.com".to_string());

        let mut price_lookup = HashMap::new();
        if let Ok(mapping) = std::env::var("STRIPE_PRICE_MAPPING") {
            for pair in mapping.split(',') {
                let mut parts = pair.splitn(2, ':');
                if let (Some(key), Some(value)) = (parts.next(), parts.next()) {
                    let plan_key = key.trim().to_ascii_lowercase();
                    let price_id = value.trim();
                    if !plan_key.is_empty() && !price_id.is_empty() {
                        price_lookup.insert(plan_key, price_id.to_string());
                    }
                }
            }
        }

        for (key, value) in std::env::vars() {
            let Some(plan_suffix) = key.strip_prefix("STRIPE_PRICE_ID_") else {
                continue;
            };
            let plan_key = plan_suffix.trim().to_ascii_lowercase();
            let price_id = value.trim();
            if plan_key.is_empty() || price_id.is_empty() {
                continue;
            }
            price_lookup.insert(plan_key, price_id.to_string());
        }

        let webhook_secret = std::env::var("STRIPE_WEBHOOK_SECRET").ok();
        let portal_configuration_id = std::env::var("STRIPE_PORTAL_CONFIGURATION_ID")
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let webhook_tolerance_seconds = std::env::var("STRIPE_WEBHOOK_TOLERANCE_SECONDS")
            .ok()
            .and_then(|value| value.trim().parse::<i64>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(300);
        let checkout_tos_consent = std::env::var("STRIPE_CHECKOUT_TOS_CONSENT")
            .map(|value| matches!(value.trim(), "1" | "true" | "TRUE"))
            .unwrap_or(false);

        Some(Self {
            secret_key,
            api_base_url,
            price_lookup,
            webhook_secret,
            portal_configuration_id,
            webhook_tolerance_seconds,
            checkout_tos_consent,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        database_pool_size_from_values, is_published_credential_encryption_key,
        normalize_public_app_url, parse_browser_profile_persist_project_ids,
        resolve_credential_encryption_key, resolve_user_token_secret, CredentialEncryptionKey,
        DEV_USER_TOKEN_SECRET,
    };
    use base64::Engine;
    use uuid::Uuid;

    const STRONG_SECRET: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn user_token_secret_is_refused_outside_dev_mode_when_unset_published_or_short() {
        // authenticate_request turns any token that verifies against this
        // secret into a full session for the `sub` it names. A missing value
        // used to fall back to the published one, which let anyone who could
        // reach the controller sign in as any user.
        let short = "a-private-but-short-secret";
        assert!(short.len() < 32);
        for configured in [
            None,
            Some(""),
            Some("   "),
            Some(DEV_USER_TOKEN_SECRET),
            Some(" dev-user-token-secret\n"),
            Some(short),
            Some(&STRONG_SECRET[..31]),
        ] {
            let error = resolve_user_token_secret(false, configured)
                .expect_err("outside DEV_MODE the controller must refuse to start")
                .to_string();
            assert!(error.contains("USER_TOKEN_SECRET"), "{error}");
            assert!(
                !error.contains(short),
                "refusals must never echo the configured value"
            );
        }
    }

    #[test]
    fn user_token_secret_accepts_a_strong_value_outside_dev_mode() {
        assert_eq!(
            resolve_user_token_secret(false, Some(&format!("  {STRONG_SECRET}\n")))
                .expect("a 32-byte secret boots"),
            STRONG_SECRET
        );
    }

    #[test]
    fn dev_mode_keeps_the_development_signing_fallback() {
        assert_eq!(
            resolve_user_token_secret(true, None).expect("dev fallback"),
            DEV_USER_TOKEN_SECRET
        );
        assert_eq!(
            resolve_user_token_secret(true, Some("  ")).expect("dev fallback"),
            DEV_USER_TOKEN_SECRET
        );
        assert_eq!(
            resolve_user_token_secret(true, Some("short")).expect("dev accepts any value"),
            "short"
        );
    }

    #[test]
    fn credential_encryption_key_is_required_outside_dev_mode() {
        // Deriving it from USER_TOKEN_SECRET made rotating the signing secret
        // silently strand every stored credential.
        for configured in [None, Some(""), Some("  \n")] {
            let error = resolve_credential_encryption_key(false, configured, STRONG_SECRET)
                .expect_err("outside DEV_MODE the key must be explicit")
                .to_string();
            assert!(error.contains("CREDENTIAL_ENCRYPTION_KEY"), "{error}");
        }
    }

    #[test]
    fn credential_encryption_key_uses_the_configured_key_in_every_mode() {
        let raw = [7u8; 32];
        let encoded = base64::engine::general_purpose::STANDARD.encode(raw);
        for dev_mode in [false, true] {
            let key =
                resolve_credential_encryption_key(dev_mode, Some(&format!(" {encoded} ")), "x")
                    .expect("valid configured key");
            assert_eq!(key.as_bytes(), &raw);
            assert!(resolve_credential_encryption_key(
                dev_mode,
                Some("bm90LTMyLWJ5dGVz"),
                STRONG_SECRET
            )
            .is_err());
        }
    }

    #[test]
    fn dev_mode_keeps_the_derived_credential_key_fallback() {
        let key = resolve_credential_encryption_key(true, None, STRONG_SECRET)
            .expect("dev fallback derives the key");
        assert_eq!(
            key.as_bytes(),
            CredentialEncryptionKey::for_test(STRONG_SECRET).as_bytes()
        );
    }

    #[test]
    fn the_key_derived_from_the_published_signing_secret_is_recognised() {
        assert!(is_published_credential_encryption_key(
            &CredentialEncryptionKey::for_test(DEV_USER_TOKEN_SECRET)
        ));
        assert!(!is_published_credential_encryption_key(
            &CredentialEncryptionKey::for_test(STRONG_SECRET)
        ));
    }

    /// The HS256 fallback must never disable JWKS refresh.
    ///
    /// This is a source invariant rather than a behavioural test because the
    /// fallback lives inside `AppConfig::from_env`, which reads a hundred-odd
    /// environment variables; isolating it would mean refactoring the builder.
    /// The regression it guards is a one-character edit (`true` -> `false`)
    /// with a 16-hour outage attached, so it is worth pinning directly.
    #[test]
    fn hmac_fallback_never_disables_jwks_refresh() {
        let source = include_str!("config.rs");
        // Needles are assembled at runtime so this test does not match its own
        // source text -- `include_str!` includes these very assertions.
        let call = "from_hmac_secret(&secret), ";
        let latched = format!("{call}{}", "false)");
        let healing = format!("{call}{}", "true)");
        assert!(
            !source.contains(&latched),
            "the HS256 fallback must keep JWKS refresh enabled: disabling it latches the \
             process into HS256 for its entire lifetime, because both recovery paths \
             (main.rs periodic refresher, auth.rs retry-on-auth-failure) are gated on that \
             flag and nothing ever sets it back"
        );
        assert_eq!(
            source.matches(&healing).count(),
            2,
            "both fallback arms (load error, loader panic) must keep refresh enabled"
        );
    }

    #[test]
    fn database_trust_store_holds_public_roots_and_the_supabase_authority() {
        let roots = super::database_root_store();
        assert_eq!(
            roots.roots.len(),
            webpki_roots::TLS_SERVER_ROOTS.len() + 1,
            "expected every public web root plus exactly the embedded Supabase CA",
        );
    }

    #[test]
    fn database_tls_builds_a_verifying_connector() {
        // Constructing the connector proves the embedded certificate parses
        // and forms a valid rustls client configuration at startup rather
        // than on the first pooled connection.
        let _connector = super::database_tls();
    }

    #[test]
    fn database_pool_defaults_to_four_outside_development() {
        assert_eq!(database_pool_size_from_values(None, None), 4);
        assert_eq!(database_pool_size_from_values(None, Some("false")), 4);
    }

    #[test]
    fn database_pool_keeps_the_larger_development_default() {
        for dev_mode in ["1", "true", "TRUE", "yes", "on"] {
            assert_eq!(
                database_pool_size_from_values(None, Some(dev_mode)),
                12,
                "expected DEV_MODE={dev_mode:?} to select the development default"
            );
        }
    }

    #[test]
    fn database_pool_honors_explicit_positive_overrides_in_every_mode() {
        for dev_mode in [None, Some("true")] {
            assert_eq!(database_pool_size_from_values(Some(" 1 "), dev_mode), 1);
            assert_eq!(database_pool_size_from_values(Some("20"), dev_mode), 20);
        }
    }

    #[test]
    fn database_pool_rejects_non_positive_or_malformed_overrides() {
        for configured in ["", "0", "-1", "not-a-number"] {
            assert_eq!(
                database_pool_size_from_values(Some(configured), None),
                4,
                "expected {configured:?} to use the production fallback"
            );
            assert_eq!(
                database_pool_size_from_values(Some(configured), Some("true")),
                12,
                "expected {configured:?} to use the development fallback"
            );
        }
    }

    #[test]
    fn browser_profile_project_allowlist_is_empty_by_default_shape() {
        assert!(parse_browser_profile_persist_project_ids("  , \n")
            .expect("empty allowlist")
            .is_empty());
    }

    #[test]
    fn browser_profile_project_allowlist_trims_and_deduplicates() {
        let first = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let second = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let parsed =
            parse_browser_profile_persist_project_ids(&format!(" {first},\n{second}, {first} "))
                .expect("valid allowlist");

        assert_eq!(parsed, vec![first, second]);
    }

    #[test]
    fn browser_profile_project_allowlist_rejects_malformed_uuid() {
        let error = parse_browser_profile_persist_project_ids("not-a-project")
            .expect_err("invalid allowlist must fail closed");
        assert!(error
            .to_string()
            .contains("BROWSER_PROFILE_PERSIST_PROJECT_IDS contains invalid UUID"));
    }

    #[test]
    fn public_app_url_uses_environment_appropriate_defaults() {
        assert_eq!(
            normalize_public_app_url(None, false).expect("production default"),
            "https://instafy.dev"
        );
        assert_eq!(
            normalize_public_app_url(None, true).expect("development default"),
            "http://localhost:5173"
        );
    }

    #[test]
    fn public_app_url_normalizes_a_trailing_slash() {
        assert_eq!(
            normalize_public_app_url(Some("  https://studio.example.com/  "), false)
                .expect("valid public app URL"),
            "https://studio.example.com"
        );
    }

    #[test]
    fn public_app_url_rejects_unsafe_or_ambiguous_values() {
        for value in [
            "javascript:alert(1)",
            "https://user:secret@studio.example.com",
            "https://studio.example.com/base",
            "https://studio.example.com?redirect=elsewhere",
            "http://studio.example.com",
        ] {
            assert!(
                normalize_public_app_url(Some(value), false).is_err(),
                "expected {value:?} to be rejected"
            );
        }
    }
}
