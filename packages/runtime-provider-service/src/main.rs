use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, Request, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use runtime_provider_core::allocator::{
    build_runtime_allocator_for_kind, DynRuntimeAllocator, EnsureRuntimeRequest,
    RuntimeAllocatorKind, RuntimeCensus,
};
use runtime_provider_core::config::{ProviderConfig, RuntimeProviderConfig};
use serde::Deserialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use std::collections::HashMap;
use std::env;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Weak};
use std::time::Duration;
use tokio::signal;
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio::time;
use tracing::{error, info, warn};
use uuid::Uuid;

#[derive(Clone)]
struct ProviderState {
    allocator: DynRuntimeAllocator,
    runtime_operations: RuntimeOperationLocks,
    provider_id: String,
    inbound_auth: InboundAuth,
    provider_auth_token: Option<String>,
    controller_registration_token: Option<String>,
}

/// Where the service listens unless `BIND_ADDR` says otherwise.
const DEFAULT_BIND_ADDR: &str = "0.0.0.0:9090";
/// Where it listens without a token, unless `BIND_ADDR` names another
/// loopback address.
const UNAUTHENTICATED_BIND_ADDR: &str = "127.0.0.1:9090";
/// The local-development opt-in to run without `PROVIDER_AUTH_TOKEN`.
const ALLOW_UNAUTHENTICATED_ENV: &str = "PROVIDER_ALLOW_UNAUTHENTICATED";

/// Who may call the service's routes.
#[derive(Clone, Debug, PartialEq, Eq)]
enum InboundAuth {
    /// A request must carry one of these bearer tokens. An empty list admits
    /// nothing.
    Bearer(Vec<String>),
    /// Local development only: `PROVIDER_ALLOW_UNAUTHENTICATED=1` without
    /// `PROVIDER_AUTH_TOKEN`. No token is checked, and the service listens on
    /// a loopback address only.
    LoopbackUnauthenticated,
}

#[derive(Clone, Default)]
struct RuntimeOperationLocks {
    locks: Arc<Mutex<HashMap<(Uuid, Uuid), Weak<Mutex<()>>>>>,
}

impl RuntimeOperationLocks {
    async fn acquire(&self, project_id: Uuid, runtime_id: Uuid) -> OwnedMutexGuard<()> {
        let runtime_lock = {
            let mut locks = self.locks.lock().await;
            locks.retain(|_, lock| lock.strong_count() > 0);
            let key = (project_id, runtime_id);
            match locks.get(&key).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(Mutex::new(()));
                    locks.insert(key, Arc::downgrade(&lock));
                    lock
                }
            }
        };
        runtime_lock.lock_owned().await
    }
}

#[derive(Deserialize)]
struct EnsurePayload {
    project_id: Uuid,
    runtime_id: Uuid,
    lease_id: Uuid,
    provider: String,
    runtime_token: String,
    #[serde(default)]
    metadata: Option<JsonValue>,
    #[serde(default)]
    origin_instance_id: Option<Uuid>,
    #[serde(default)]
    origin_mode: Option<String>,
    #[serde(default)]
    origin_protocols: Vec<String>,
    #[serde(default)]
    origin_metadata: Option<JsonValue>,
}

#[derive(Deserialize)]
struct ReleasePayload {
    project_id: Uuid,
    runtime_id: Uuid,
    #[serde(default)]
    lease_id: Option<Uuid>,
}

#[derive(serde::Serialize)]
struct EnsureResponse {
    message: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderRegistrationRequest<'a> {
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    display_name: Option<&'a str>,
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    endpoint: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    auth_token: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata: Option<&'a JsonValue>,
}

async fn auth_layer(
    State(state): State<ProviderState>,
    req: Request<Body>,
    next: Next,
) -> impl IntoResponse {
    if !request_is_authorized(&state.inbound_auth, req.headers()) {
        return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
    }
    next.run(req).await
}

/// Whether a request may reach the service's routes. It fails closed: a
/// service with no accepted token admits nothing.
fn request_is_authorized(inbound_auth: &InboundAuth, headers: &HeaderMap) -> bool {
    let accepted = match inbound_auth {
        InboundAuth::LoopbackUnauthenticated => return true,
        InboundAuth::Bearer(accepted) => accepted,
    };
    let Some(presented) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .map(|raw| raw.strip_prefix("Bearer ").unwrap_or(raw))
    else {
        return false;
    };
    // Every accepted token is compared, so the time taken does not tell
    // which of them a guess came closest to.
    accepted.iter().fold(false, |matched, expected| {
        matched | tokens_equal(presented, expected)
    })
}

/// Compares two tokens in time that does not depend on where they first
/// differ. An empty token never matches.
fn tokens_equal(presented: &str, expected: &str) -> bool {
    let (presented, expected) = (presented.as_bytes(), expected.as_bytes());
    !expected.is_empty()
        && presented.len() == expected.len()
        && presented
            .iter()
            .zip(expected)
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            == 0
}

fn default_public_endpoint(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Every route, behind the auth layer.
fn app(state: ProviderState) -> Router {
    Router::new()
        .route("/runtime/ensure", post(ensure_runtime))
        .route("/runtime/release", post(release_runtime))
        .route("/runtime/inspect", post(inspect_runtime))
        .route("/runtime/census", post(census_runtimes))
        .route("/runtime/origin", post(runtime_origin))
        .route("/healthz", axum::routing::get(|| async { StatusCode::OK }))
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(state, auth_layer))
}

async fn ensure_runtime(
    State(state): State<ProviderState>,
    Json(payload): Json<EnsurePayload>,
) -> Result<Json<EnsureResponse>, (StatusCode, String)> {
    if payload.provider != state.provider_id {
        warn!(
            expected = %state.provider_id,
            got = %payload.provider,
            "provider mismatch in request"
        );
        return Err((StatusCode::CONFLICT, "provider mismatch".to_string()));
    }

    // Own the guard and allocator future in a detached task. Dropping the HTTP
    // handler after a client timeout must not release the guard while an
    // uncancellable spawn_blocking Docker operation is still running.
    let operation_state = state.clone();
    let operation = tokio::spawn(async move {
        let _operation_guard = operation_state
            .runtime_operations
            .acquire(payload.project_id, payload.runtime_id)
            .await;
        let req = EnsureRuntimeRequest {
            project_id: payload.project_id,
            runtime_id: payload.runtime_id,
            lease_id: payload.lease_id,
            provider: payload.provider,
            runtime_token: payload.runtime_token,
            metadata: payload.metadata,
            origin_instance_id: payload.origin_instance_id,
            origin_mode: payload.origin_mode,
            origin_protocols: payload.origin_protocols,
            origin_metadata: payload.origin_metadata,
        };
        operation_state.allocator.ensure_runtime(req).await
    });

    let outcome = operation
        .await
        .map_err(|error| {
            error!(%error, "ensure runtime operation task failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "ensure operation failed".to_string(),
            )
        })?
        .map_err(|error| {
            error!(%error, "ensure runtime failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("ensure failed: {error}"),
            )
        })?;

    Ok(Json(EnsureResponse {
        message: outcome.message,
    }))
}

async fn release_runtime(
    State(state): State<ProviderState>,
    Json(payload): Json<ReleasePayload>,
) -> Result<StatusCode, (StatusCode, String)> {
    let Some(lease_id) = payload.lease_id else {
        return Err((
            StatusCode::BAD_REQUEST,
            "runtime release requires lease_id".to_string(),
        ));
    };
    let operation_state = state.clone();
    tokio::spawn(async move {
        let _operation_guard = operation_state
            .runtime_operations
            .acquire(payload.project_id, payload.runtime_id)
            .await;
        operation_state
            .allocator
            .stop_runtime_if_lease(payload.project_id, payload.runtime_id, Some(lease_id))
            .await
    })
    .await
    .map_err(|error| {
        error!(%error, "release runtime operation task failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "runtime release failed".to_string(),
        )
    })?
    .map_err(|error| {
        error!(%error, "release runtime failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "runtime release failed".to_string(),
        )
    })?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(serde::Serialize)]
struct InspectResponse {
    oom_killed: Option<bool>,
}

/// Read-only container post-mortem: lets the controller attribute a dead
/// runtime to the OOM killer instead of reporting a generic timeout.
async fn inspect_runtime(
    State(state): State<ProviderState>,
    Json(payload): Json<ReleasePayload>,
) -> Result<Json<InspectResponse>, (StatusCode, String)> {
    let oom_killed = state
        .allocator
        .runtime_oom_killed(payload.project_id, payload.runtime_id)
        .await
        .unwrap_or_else(|error| {
            error!(%error, "runtime inspect failed");
            None
        });
    Ok(Json(InspectResponse { oom_killed }))
}

/// Read-only: the runtime containers on this node, for the controller's
/// drain before the node is retired. No identity beyond the runtime, project
/// and lease ids leaves the node, and no credential.
async fn census_runtimes(
    State(state): State<ProviderState>,
) -> Result<Json<RuntimeCensus>, (StatusCode, String)> {
    state.allocator.census().await.map(Json).map_err(|error| {
        error!(%error, "runtime census failed");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "runtime census failed".to_string(),
        )
    })
}

#[derive(Deserialize)]
struct OriginPayload {
    project_id: Uuid,
    runtime_id: Uuid,
    lease_id: Uuid,
}

#[derive(Debug, serde::Serialize)]
struct OriginResponse {
    endpoint: String,
}

/// Read-only: where the controller reaches a runtime's origin on this node,
/// for exactly the lease generation it names. A stop sends its save
/// credential there and nowhere else: never to the endpoint the runtime
/// registered itself, which may be a public tunnel or any address the
/// runtime chose. 404 when no running runtime of that generation is here.
async fn runtime_origin(
    State(state): State<ProviderState>,
    Json(payload): Json<OriginPayload>,
) -> Result<Json<OriginResponse>, (StatusCode, String)> {
    match state
        .allocator
        .origin_endpoint(payload.project_id, payload.runtime_id, payload.lease_id)
        .await
    {
        Ok(Some(endpoint)) => Ok(Json(OriginResponse { endpoint })),
        Ok(None) => Err((
            StatusCode::NOT_FOUND,
            "no running runtime of that generation here".to_string(),
        )),
        Err(error) => {
            error!(%error, "runtime origin lookup failed");
            Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                "runtime origin lookup failed".to_string(),
            ))
        }
    }
}

/// Evicts stopped workspace checkouts from this node's disk on a schedule:
/// after `RUNTIME_CHECKOUT_TTL_DAYS` (default 7) idle, or oldest first while
/// they exceed `RUNTIME_CHECKOUT_DISK_BUDGET_GIB`. The allocator never evicts
/// a checkout with a runtime container or a start in progress, or one whose
/// last stop did not leave the `durable v1` marker, and a stop never evicts.
/// Canonical git is the durable copy; the next start clones again.
fn spawn_checkout_eviction(allocator: runtime_provider_core::allocator::DynRuntimeAllocator) {
    let interval = env::var("RUNTIME_CHECKOUT_SWEEP_INTERVAL_SECS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(6 * 60 * 60);
    if interval == 0 {
        return;
    }
    tokio::spawn(async move {
        // Let runtimes that were running before a restart be ensured again
        // before the first sweep looks at their checkouts.
        time::sleep(Duration::from_secs(10 * 60)).await;
        loop {
            match allocator.evict_idle_checkouts().await {
                Ok(report) => {
                    if !report.evicted.is_empty() || !report.kept_unpushed.is_empty() {
                        info!(
                            evicted = ?report.evicted,
                            kept_unpushed = ?report.kept_unpushed,
                            "workspace checkout sweep finished"
                        );
                    }
                }
                Err(error) => error!(%error, "workspace checkout sweep failed"),
            }
            time::sleep(Duration::from_secs(interval)).await;
        }
    });
}

/// Bounds the per-project toolchain caches (/workspace/.cache mounts): they
/// live on the shared host disk with no quota, so caches for projects nobody
/// has touched in RUNTIME_CACHE_TTL_DAYS (default 30, 0 disables) are removed.
/// Deletion is fail-safe: a cache is only removed when a bounded scan PROVES
/// every file in it is older than the cutoff.
fn spawn_workspace_cache_cleanup() {
    let ttl_days = env::var("RUNTIME_CACHE_TTL_DAYS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(30);
    if ttl_days == 0 {
        return;
    }
    let cache_root = env::var("RUNTIME_CACHE_ROOT")
        .map(PathBuf::from)
        .ok()
        .or_else(|| {
            // Mirrors DockerRuntimeAllocator::build_env: caches live next to
            // the codex root as <parent>/workspace-caches/<project_id>.
            // DOCKER_CODEX_ROOT is the production name (provider config);
            // RUNTIME_DOCKER_CODEX_ROOT is what the dev harness exports.
            let codex_root = env::var("DOCKER_CODEX_ROOT")
                .or_else(|_| env::var("RUNTIME_DOCKER_CODEX_ROOT"))
                .map(PathBuf::from)
                .unwrap_or_else(|_| std::env::temp_dir().join("instafy-runtime-codex"));
            Some(
                codex_root
                    .parent()
                    .map(|base| base.join("workspace-caches"))
                    .unwrap_or_else(|| codex_root.join("workspace-caches")),
            )
        });
    let Some(cache_root) = cache_root else {
        return;
    };
    if !cache_root.exists() {
        warn!(
            cache_root = %cache_root.display(),
            "workspace cache root does not exist; cache cleanup will be a no-op (is the directory mounted into this container?)"
        );
    }

    tokio::spawn(async move {
        loop {
            let root = cache_root.clone();
            let ttl = Duration::from_secs(ttl_days * 24 * 60 * 60);
            let result =
                tokio::task::spawn_blocking(move || cleanup_stale_workspace_caches(&root, ttl))
                    .await;
            match result {
                Ok(removed) if !removed.is_empty() => {
                    info!(removed = ?removed, "removed stale workspace caches");
                }
                Ok(_) => {}
                Err(error) => error!(%error, "workspace cache cleanup task panicked"),
            }
            time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

/// Returns the names of removed cache directories. A directory survives when
/// any file was modified within the TTL — or when the scan hits its entry cap
/// without proof of staleness (never delete on uncertainty).
fn cleanup_stale_workspace_caches(root: &std::path::Path, ttl: Duration) -> Vec<String> {
    const SCAN_ENTRY_CAP: usize = 200_000;
    let cutoff = std::time::SystemTime::now() - ttl;
    let mut removed = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return removed;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let mut scanned = 0usize;
        let mut has_recent = false;
        let mut capped = false;
        let mut stack = vec![path.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(children) = std::fs::read_dir(&dir) else {
                continue;
            };
            for child in children.flatten() {
                scanned += 1;
                if scanned > SCAN_ENTRY_CAP {
                    capped = true;
                    break;
                }
                let child_path = child.path();
                if child_path.is_dir() {
                    stack.push(child_path);
                    continue;
                }
                if let Ok(metadata) = child.metadata() {
                    if metadata.modified().map(|m| m > cutoff).unwrap_or(true) {
                        has_recent = true;
                        break;
                    }
                }
            }
            if has_recent || capped {
                break;
            }
        }
        // Also treat the directory's own mtime as a signal (fresh, empty
        // caches have no files yet but must not be deleted).
        if !has_recent {
            if let Ok(metadata) = std::fs::metadata(&path) {
                if metadata.modified().map(|m| m > cutoff).unwrap_or(true) {
                    has_recent = true;
                }
            }
        }
        if !has_recent && !capped {
            if std::fs::remove_dir_all(&path).is_ok() {
                removed.push(entry.file_name().to_string_lossy().to_string());
            }
        }
    }
    removed
}

fn build_config() -> anyhow::Result<(ProviderState, SocketAddr)> {
    // Who may call the service, and where it listens, is settled before
    // anything else starts: without its own token it refuses to start
    // rather than run runtimes for whoever reaches its port.
    let auth_settings = AuthSettings::from_env();
    if auth_settings.allow_unauthenticated && auth_settings.provider_auth_token.is_some() {
        warn!("{ALLOW_UNAUTHENTICATED_ENV} is ignored because PROVIDER_AUTH_TOKEN is set");
    }
    let service_auth = resolve_service_auth(auth_settings)?;

    let provider_id = env::var("PROVIDER_ID").unwrap_or_else(|_| "external-http".to_string());
    let provider_kind = env::var("PROVIDER_KIND")
        .ok()
        .map(|raw| RuntimeAllocatorKind::from_str(&raw))
        .unwrap_or(RuntimeAllocatorKind::Docker);

    let base = ProviderConfig::from_env();

    let provider = RuntimeProviderConfig {
        id: provider_id.clone(),
        display_name: env::var("PROVIDER_DISPLAY_NAME")
            .unwrap_or_else(|_| "External Provider".to_string()),
        kind: provider_kind,
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: None,
        auth_token: None,
        metadata: build_metadata(&base),
    };

    let allocator = build_runtime_allocator_for_kind(&base, &provider)?;

    Ok((
        ProviderState {
            allocator,
            runtime_operations: RuntimeOperationLocks::default(),
            provider_id,
            inbound_auth: service_auth.inbound_auth,
            provider_auth_token: service_auth.provider_auth_token,
            controller_registration_token: service_auth.controller_registration_token,
        },
        service_auth.bind_addr,
    ))
}

/// What the service reads from its environment to decide who may call it
/// and where it listens.
#[derive(Clone, Debug, Default)]
struct AuthSettings {
    provider_auth_token: Option<String>,
    controller_service_role_key: Option<String>,
    controller_internal_token: Option<String>,
    supabase_service_role_key: Option<String>,
    allow_unauthenticated: bool,
    bind_addr: Option<String>,
}

impl AuthSettings {
    fn from_env() -> Self {
        Self {
            provider_auth_token: read_token_env("PROVIDER_AUTH_TOKEN"),
            controller_service_role_key: read_token_env("CONTROLLER_SERVICE_ROLE_KEY"),
            controller_internal_token: read_token_env("CONTROLLER_INTERNAL_TOKEN"),
            supabase_service_role_key: read_token_env("SUPABASE_SERVICE_ROLE_KEY"),
            allow_unauthenticated: parse_flag(env::var(ALLOW_UNAUTHENTICATED_ENV).ok().as_deref()),
            bind_addr: env::var("BIND_ADDR").ok(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ServiceAuth {
    inbound_auth: InboundAuth,
    bind_addr: SocketAddr,
    /// What this provider registers as its own credential, which the
    /// controller stores with it and sends on every call: only ever
    /// `PROVIDER_AUTH_TOKEN`.
    provider_auth_token: Option<String>,
    /// The service credential this provider registers with.
    controller_registration_token: Option<String>,
}

/// Decides who may call the service and where it listens.
///
/// It requires `PROVIDER_AUTH_TOKEN`: without it anyone who can reach the
/// port could launch, list and stop runtimes. The one exception is local
/// development (`PROVIDER_ALLOW_UNAUTHENTICATED=1`), which checks no token and
/// listens on a loopback address only.
///
/// The controller-wide tokens (`CONTROLLER_INTERNAL_TOKEN`,
/// `CONTROLLER_SERVICE_ROLE_KEY`) are credentials this service sends: to
/// register, to ask the controller about spaces, and to the runtime proxies it
/// starts. They never stand in for `PROVIDER_AUTH_TOKEN`, so they are never
/// registered as this provider's credential, where the controller would store
/// them with the provider and send them to its endpoint on every call. A
/// token-protected service still accepts them from its caller: the controller
/// falls back to them for its own Instafy Cloud route, and a provider that
/// registered one of them before this rule keeps answering its controller
/// until its new token is registered.
fn resolve_service_auth(settings: AuthSettings) -> anyhow::Result<ServiceAuth> {
    let controller_registration_token = settings
        .controller_service_role_key
        .clone()
        .or_else(|| settings.supabase_service_role_key.clone())
        .or_else(|| settings.controller_internal_token.clone());

    let Some(provider_auth_token) = settings.provider_auth_token.clone() else {
        if !settings.allow_unauthenticated {
            anyhow::bail!(missing_provider_token_message(&settings));
        }
        let bind_addr = parse_bind_addr(settings.bind_addr.as_deref(), UNAUTHENTICATED_BIND_ADDR)?;
        if !bind_addr.ip().is_loopback() {
            anyhow::bail!(
                "{ALLOW_UNAUTHENTICATED_ENV}=1 listens only on a loopback address, and BIND_ADDR \
                 is {bind_addr}. Set PROVIDER_AUTH_TOKEN to listen on any other address."
            );
        }
        return Ok(ServiceAuth {
            inbound_auth: InboundAuth::LoopbackUnauthenticated,
            bind_addr,
            provider_auth_token: None,
            controller_registration_token,
        });
    };

    let mut accepted_auth_tokens = Vec::new();
    push_unique_token(&mut accepted_auth_tokens, Some(&provider_auth_token));
    push_unique_token(
        &mut accepted_auth_tokens,
        settings.controller_service_role_key.as_deref(),
    );
    push_unique_token(
        &mut accepted_auth_tokens,
        settings.controller_internal_token.as_deref(),
    );
    Ok(ServiceAuth {
        inbound_auth: InboundAuth::Bearer(accepted_auth_tokens),
        bind_addr: parse_bind_addr(settings.bind_addr.as_deref(), DEFAULT_BIND_ADDR)?,
        provider_auth_token: Some(provider_auth_token),
        controller_registration_token,
    })
}

fn missing_provider_token_message(settings: &AuthSettings) -> String {
    let mut message = format!(
        "PROVIDER_AUTH_TOKEN is not set, and without it anyone who can reach this service could \
         launch, list and stop runtimes. Set it to a long random secret (for example the output \
         of `openssl rand -hex 32`) and register the same value as this provider's authToken (a \
         provider with CONTROLLER_URL set registers it itself). For local development only, \
         {ALLOW_UNAUTHENTICATED_ENV}=1 starts the service without a token on a loopback address."
    );
    if settings.controller_internal_token.is_some()
        || settings.controller_service_role_key.is_some()
    {
        message.push_str(
            " CONTROLLER_INTERNAL_TOKEN and CONTROLLER_SERVICE_ROLE_KEY no longer stand in for \
             it: a provider must not register the controller's own credential as its token.",
        );
    }
    message
}

fn parse_bind_addr(raw: Option<&str>, default: &str) -> anyhow::Result<SocketAddr> {
    let raw = raw.unwrap_or(default).trim();
    raw.parse().map_err(|error| {
        anyhow::anyhow!("BIND_ADDR '{raw}' is not an address and port such as {default}: {error}")
    })
}

/// `1`, `true`, `yes` or `on`, in any case; anything else, or unset, is off.
fn parse_flag(raw: Option<&str>) -> bool {
    raw.map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"))
}

fn read_token_env(name: &str) -> Option<String> {
    env::var(name)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn push_unique_token(tokens: &mut Vec<String>, token: Option<&str>) {
    let Some(token) = token else {
        return;
    };
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return;
    }
    if tokens.iter().any(|existing| existing == trimmed) {
        return;
    }
    tokens.push(trimmed.to_string());
}

fn build_metadata(config: &ProviderConfig) -> Option<JsonValue> {
    let mut map = JsonMap::new();
    if let Some(path) = config.runtime_docker_compose_file.as_ref() {
        map.insert(
            "dockerComposeFile".to_string(),
            JsonValue::String(path.display().to_string()),
        );
    }
    map.insert(
        "dockerService".to_string(),
        JsonValue::String(config.runtime_docker_service.clone()),
    );
    map.insert(
        "dockerProjectPrefix".to_string(),
        JsonValue::String(config.runtime_docker_project_prefix.clone()),
    );
    if let Some(repo) = config.runtime_docker_repo_host.as_ref() {
        map.insert(
            "dockerRepoHost".to_string(),
            JsonValue::String(repo.display().to_string()),
        );
    }
    if let Some(codex) = config.runtime_docker_codex_root.as_ref() {
        map.insert(
            "dockerCodexRoot".to_string(),
            JsonValue::String(codex.display().to_string()),
        );
    }

    if let Some(token) = config.hetzner_token.as_ref() {
        map.insert("hetznerToken".to_string(), JsonValue::String(token.clone()));
    }
    if let Some(value) = config.hetzner_server_type.as_ref() {
        map.insert(
            "hetznerServerType".to_string(),
            JsonValue::String(value.clone()),
        );
    }
    if let Some(value) = config.hetzner_image.as_ref() {
        map.insert("hetznerImage".to_string(), JsonValue::String(value.clone()));
    }
    if let Some(value) = config.hetzner_location.as_ref() {
        map.insert(
            "hetznerLocation".to_string(),
            JsonValue::String(value.clone()),
        );
    }
    if let Some(value) = config.hetzner_runtime_user_data.as_ref() {
        map.insert(
            "hetznerUserData".to_string(),
            JsonValue::String(value.clone()),
        );
    }
    if let Some(value) = config.hetzner_network_id {
        map.insert("hetznerNetworkId".to_string(), JsonValue::from(value));
    }
    if let Some(value) = config.hetzner_firewall_id {
        map.insert("hetznerFirewallId".to_string(), JsonValue::from(value));
    }
    if map.is_empty() {
        None
    } else {
        Some(JsonValue::Object(map))
    }
}

async fn try_register_with_controller(state: &ProviderState) -> bool {
    let controller_url = match env::var("CONTROLLER_URL") {
        Ok(url) if !url.trim().is_empty() => url.trim().trim_end_matches('/').to_string(),
        _ => return true,
    };
    let token = match state.controller_registration_token.as_deref() {
        Some(token) => token,
        None => {
            warn!(
                "no controller registration token available; set CONTROLLER_SERVICE_ROLE_KEY, SUPABASE_SERVICE_ROLE_KEY, or CONTROLLER_INTERNAL_TOKEN"
            );
            return true;
        }
    };

    let endpoint = env::var("PROVIDER_PUBLIC_ENDPOINT")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| {
            let port = env::var("PROVIDER_PORT")
                .ok()
                .and_then(|raw| raw.parse().ok())
                .unwrap_or(9090);
            default_public_endpoint(port)
        });
    let kind = env::var("CONTROLLER_PROVIDER_KIND").unwrap_or_else(|_| "external_http".to_string());
    let display_name = env::var("PROVIDER_DISPLAY_NAME").ok();

    let payload = ProviderRegistrationRequest {
        id: &state.provider_id,
        display_name: display_name.as_deref(),
        kind: &kind,
        endpoint: Some(&endpoint),
        auth_token: state.provider_auth_token.as_deref(),
        metadata: None,
    };

    let url = format!("{}/providers", controller_url);
    let client = reqwest::Client::new();
    match client
        .post(url)
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await
    {
        Ok(res) if res.status().is_success() => {
            info!("registered provider with controller at {}", controller_url);
            true
        }
        Ok(res) => {
            let status = res.status();
            let body = res.text().await.unwrap_or_default();
            warn!(%status, %body, "failed to register provider with controller");
            false
        }
        Err(error) => {
            warn!(%error, "failed to register provider with controller");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        app, census_runtimes, ensure_runtime, parse_flag, release_runtime, request_is_authorized,
        resolve_service_auth, runtime_origin, tokens_equal, AuthSettings, EnsurePayload,
        InboundAuth, OriginPayload, ProviderState, ReleasePayload, RuntimeOperationLocks,
    };
    use async_trait::async_trait;
    use axum::http::HeaderMap;
    use axum::{extract::State, http::StatusCode, Json};
    use runtime_provider_core::allocator::{
        EnsureRuntimeOutcome, EnsureRuntimeRequest, RuntimeAllocator,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};
    use tokio::sync::Semaphore;
    use uuid::Uuid;

    struct ReleaseAllocator {
        fail_release: bool,
        release_calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl RuntimeAllocator for ReleaseAllocator {
        async fn ensure_runtime(
            &self,
            _request: EnsureRuntimeRequest,
        ) -> anyhow::Result<EnsureRuntimeOutcome> {
            Ok(EnsureRuntimeOutcome::default())
        }

        async fn stop_runtime(&self, _project_id: Uuid, _runtime_id: Uuid) -> anyhow::Result<()> {
            self.release_calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_release {
                anyhow::bail!("compose down sentinel failure");
            }
            Ok(())
        }
    }

    struct CancellationAllocator {
        ensure_entered: Arc<Semaphore>,
        ensure_continue: Arc<Semaphore>,
        release_entered: Arc<Semaphore>,
    }

    struct GenerationAllocator {
        observed_lease_id: Arc<StdMutex<Option<Option<Uuid>>>>,
    }

    #[async_trait]
    impl RuntimeAllocator for GenerationAllocator {
        async fn ensure_runtime(
            &self,
            _request: EnsureRuntimeRequest,
        ) -> anyhow::Result<EnsureRuntimeOutcome> {
            Ok(EnsureRuntimeOutcome::default())
        }

        async fn stop_runtime_if_lease(
            &self,
            _project_id: Uuid,
            _runtime_id: Uuid,
            lease_id: Option<Uuid>,
        ) -> anyhow::Result<()> {
            *self
                .observed_lease_id
                .lock()
                .expect("generation observation lock") = Some(lease_id);
            Ok(())
        }
    }

    #[async_trait]
    impl RuntimeAllocator for CancellationAllocator {
        async fn ensure_runtime(
            &self,
            _request: EnsureRuntimeRequest,
        ) -> anyhow::Result<EnsureRuntimeOutcome> {
            self.ensure_entered.add_permits(1);
            self.ensure_continue
                .acquire()
                .await
                .expect("test ensure gate must remain open")
                .forget();
            Ok(EnsureRuntimeOutcome::default())
        }

        async fn stop_runtime(&self, _project_id: Uuid, _runtime_id: Uuid) -> anyhow::Result<()> {
            self.release_entered.add_permits(1);
            Ok(())
        }
    }

    fn provider_state(fail_release: bool, release_calls: Arc<AtomicUsize>) -> ProviderState {
        ProviderState {
            allocator: Arc::new(ReleaseAllocator {
                fail_release,
                release_calls,
            }),
            runtime_operations: RuntimeOperationLocks::default(),
            provider_id: "test-provider".to_string(),
            inbound_auth: InboundAuth::Bearer(vec![]),
            provider_auth_token: None,
            controller_registration_token: None,
        }
    }

    #[tokio::test]
    async fn runtime_operation_lock_serializes_same_runtime_without_retaining_dead_entries() {
        let locks = RuntimeOperationLocks::default();
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let first = locks.acquire(project_id, runtime_id).await;

        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(20),
            locks.acquire(project_id, runtime_id),
        )
        .await
        .is_err());

        drop(first);
        let second = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            locks.acquire(project_id, runtime_id),
        )
        .await
        .expect("second operation should acquire after the first exits");
        drop(second);

        let different_runtime = tokio::time::timeout(
            std::time::Duration::from_secs(1),
            locks.acquire(project_id, Uuid::new_v4()),
        )
        .await
        .expect("different runtimes should have independent operation locks");
        drop(different_runtime);
    }

    /// The census of an allocator that cannot list its node says so, rather
    /// than reporting an empty node. It lists containers only: no checkout
    /// list can cut it short.
    #[tokio::test]
    async fn census_of_an_allocator_without_node_listing_is_unsupported() {
        let Json(census) =
            census_runtimes(State(provider_state(false, Arc::new(AtomicUsize::new(0)))))
                .await
                .expect("census");
        let body = serde_json::to_value(&census).expect("census body");
        assert_eq!(
            body,
            serde_json::json!({
                "supported": false,
                "containers": [],
                "truncated": false,
            })
        );
    }

    #[tokio::test]
    async fn ensure_endpoint_rejects_provider_identity_mismatch() {
        let result = ensure_runtime(
            State(provider_state(false, Arc::new(AtomicUsize::new(0)))),
            Json(EnsurePayload {
                project_id: Uuid::new_v4(),
                runtime_id: Uuid::new_v4(),
                lease_id: Uuid::new_v4(),
                provider: "different-provider".to_string(),
                runtime_token: "test-runtime-token".to_string(),
                metadata: None,
                origin_instance_id: None,
                origin_mode: None,
                origin_protocols: vec![],
                origin_metadata: None,
            }),
        )
        .await;

        let (status, message) = match result {
            Err(error) => error,
            Ok(_) => panic!("provider mismatch must fail closed"),
        };
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(message, "provider mismatch");
    }

    #[tokio::test]
    async fn aborted_ensure_handler_keeps_release_serialized_until_allocator_finishes() {
        let allocator = Arc::new(CancellationAllocator {
            ensure_entered: Arc::new(Semaphore::new(0)),
            ensure_continue: Arc::new(Semaphore::new(0)),
            release_entered: Arc::new(Semaphore::new(0)),
        });
        let state = ProviderState {
            allocator: allocator.clone(),
            runtime_operations: RuntimeOperationLocks::default(),
            provider_id: "test-provider".to_string(),
            inbound_auth: InboundAuth::Bearer(vec![]),
            provider_auth_token: None,
            controller_registration_token: None,
        };
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();

        let ensure_handler = tokio::spawn(ensure_runtime(
            State(state.clone()),
            Json(EnsurePayload {
                project_id,
                runtime_id,
                lease_id: Uuid::new_v4(),
                provider: "test-provider".to_string(),
                runtime_token: "test-runtime-token".to_string(),
                metadata: None,
                origin_instance_id: None,
                origin_mode: None,
                origin_protocols: vec![],
                origin_metadata: None,
            }),
        ));

        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            allocator.ensure_entered.acquire(),
        )
        .await
        .expect("ensure allocator should start")
        .expect("test ensure signal must remain open")
        .forget();

        ensure_handler.abort();
        let ensure_join = match ensure_handler.await {
            Ok(_) => panic!("outer ensure handler should be cancelled"),
            Err(error) => error,
        };
        assert!(ensure_join.is_cancelled());

        let release_handler = tokio::spawn(release_runtime(
            State(state),
            Json(ReleasePayload {
                project_id,
                runtime_id,
                lease_id: Some(Uuid::new_v4()),
            }),
        ));

        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(100),
                allocator.release_entered.acquire(),
            )
            .await
            .is_err(),
            "release must remain behind the detached ensure operation"
        );

        allocator.ensure_continue.add_permits(1);
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            allocator.release_entered.acquire(),
        )
        .await
        .expect("release should start once ensure finishes")
        .expect("test release signal must remain open")
        .forget();

        let release_result =
            tokio::time::timeout(std::time::Duration::from_secs(1), release_handler)
                .await
                .expect("release handler should finish")
                .expect("release handler task should not fail");
        assert_eq!(
            release_result.expect("release operation should succeed"),
            StatusCode::NO_CONTENT
        );
    }

    fn with_provider_token(settings: AuthSettings) -> AuthSettings {
        AuthSettings {
            provider_auth_token: Some("provider-token".to_string()),
            ..settings
        }
    }

    /// Without its own token the service refuses to start. It used to start
    /// and check nothing, so anyone who reached its port could launch, list
    /// and stop runtimes. A controller-wide credential does not stand in for
    /// the token, and neither does an opt-in that is not an explicit yes.
    #[test]
    fn service_without_a_provider_token_refuses_to_start() {
        let message = resolve_service_auth(AuthSettings::default())
            .expect_err("no token, no service")
            .to_string();
        assert!(
            message.contains("PROVIDER_AUTH_TOKEN is not set"),
            "{message}"
        );
        assert!(
            message.contains("PROVIDER_ALLOW_UNAUTHENTICATED=1"),
            "{message}"
        );
        assert!(!message.contains("no longer stand in"), "{message}");

        for settings in [
            AuthSettings {
                controller_internal_token: Some("internal-token".to_string()),
                ..AuthSettings::default()
            },
            AuthSettings {
                controller_service_role_key: Some("controller-token".to_string()),
                ..AuthSettings::default()
            },
        ] {
            let message = resolve_service_auth(settings)
                .expect_err("a controller credential is not this provider's token")
                .to_string();
            assert!(
                message.contains("PROVIDER_AUTH_TOKEN is not set"),
                "{message}"
            );
            assert!(message.contains("no longer stand in"), "{message}");
        }
        resolve_service_auth(AuthSettings {
            supabase_service_role_key: Some("supabase-token".to_string()),
            ..AuthSettings::default()
        })
        .expect_err("a registration credential is not this provider's token");

        for no in ["", "0", "false", "no", "off", "2", "y"] {
            assert!(!parse_flag(Some(no)), "{no:?}");
        }
        assert!(!parse_flag(None));
        for yes in ["1", "true", "TRUE", " yes ", "On"] {
            assert!(parse_flag(Some(yes)), "{yes:?}");
        }
    }

    /// The provider registers only its own token as its credential. The
    /// controller-wide tokens are still accepted from the caller, but were
    /// they registered, the controller would store them with this provider
    /// and send them to its endpoint on every call.
    #[test]
    fn service_registers_only_its_own_token() {
        let resolved = resolve_service_auth(with_provider_token(AuthSettings {
            controller_service_role_key: Some("controller-token".to_string()),
            controller_internal_token: Some("internal-token".to_string()),
            supabase_service_role_key: Some("supabase-token".to_string()),
            ..AuthSettings::default()
        }))
        .expect("a token-protected service");
        assert_eq!(
            resolved.inbound_auth,
            InboundAuth::Bearer(vec![
                "provider-token".to_string(),
                "controller-token".to_string(),
                "internal-token".to_string(),
            ])
        );
        assert_eq!(
            resolved.provider_auth_token.as_deref(),
            Some("provider-token")
        );
        assert_eq!(
            resolved.controller_registration_token.as_deref(),
            Some("controller-token")
        );
        assert_eq!(resolved.bind_addr, "0.0.0.0:9090".parse().unwrap());

        let resolved = resolve_service_auth(with_provider_token(AuthSettings {
            controller_internal_token: Some("internal-token".to_string()),
            ..AuthSettings::default()
        }))
        .expect("a token-protected service");
        assert_eq!(
            resolved.provider_auth_token.as_deref(),
            Some("provider-token")
        );
        assert_eq!(
            resolved.controller_registration_token.as_deref(),
            Some("internal-token")
        );

        // With a token, the local-development opt-in changes nothing.
        let resolved = resolve_service_auth(with_provider_token(AuthSettings {
            allow_unauthenticated: true,
            ..AuthSettings::default()
        }))
        .expect("a token-protected service");
        assert_eq!(
            resolved.inbound_auth,
            InboundAuth::Bearer(vec!["provider-token".to_string()])
        );
        assert_eq!(resolved.bind_addr, "0.0.0.0:9090".parse().unwrap());
    }

    /// Local development may run without a token, but only on loopback: by
    /// default on 127.0.0.1:9090, and never on an address others can reach.
    #[test]
    fn unauthenticated_service_listens_on_loopback_only() {
        let resolved = resolve_service_auth(AuthSettings {
            allow_unauthenticated: true,
            controller_internal_token: Some("internal-token".to_string()),
            ..AuthSettings::default()
        })
        .expect("local development");
        assert_eq!(resolved.inbound_auth, InboundAuth::LoopbackUnauthenticated);
        assert_eq!(resolved.bind_addr, "127.0.0.1:9090".parse().unwrap());
        // Nothing to register as its credential, and never the controller's.
        assert_eq!(resolved.provider_auth_token, None);
        assert_eq!(
            resolved.controller_registration_token.as_deref(),
            Some("internal-token")
        );

        let resolved = resolve_service_auth(AuthSettings {
            allow_unauthenticated: true,
            bind_addr: Some("[::1]:9191".to_string()),
            ..AuthSettings::default()
        })
        .expect("IPv6 loopback");
        assert_eq!(resolved.bind_addr, "[::1]:9191".parse().unwrap());

        for exposed in ["0.0.0.0:9090", "[::]:9090", "192.168.1.20:9090"] {
            let message = resolve_service_auth(AuthSettings {
                allow_unauthenticated: true,
                bind_addr: Some(exposed.to_string()),
                ..AuthSettings::default()
            })
            .expect_err("an unauthenticated service stays on loopback")
            .to_string();
            assert!(
                message.contains("listens only on a loopback address"),
                "{message}"
            );
        }
    }

    #[test]
    fn unparseable_bind_address_refuses_to_start() {
        for raw in ["", "localhost:9090", "9090"] {
            let message = resolve_service_auth(with_provider_token(AuthSettings {
                bind_addr: Some(raw.to_string()),
                ..AuthSettings::default()
            }))
            .expect_err("not an address and port")
            .to_string();
            assert!(message.contains("BIND_ADDR"), "{message}");
        }
    }

    fn bearer(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {token}").parse().expect("header value"),
        );
        headers
    }

    #[test]
    fn auth_check_fails_closed() {
        let accepted = InboundAuth::Bearer(vec![
            "provider-token".to_string(),
            "internal-token".to_string(),
        ]);
        assert!(request_is_authorized(&accepted, &bearer("provider-token")));
        assert!(request_is_authorized(&accepted, &bearer("internal-token")));
        assert!(!request_is_authorized(
            &accepted,
            &bearer("provider-token-")
        ));
        assert!(!request_is_authorized(&accepted, &bearer("provider-toke")));
        assert!(!request_is_authorized(&accepted, &bearer("")));
        assert!(!request_is_authorized(&accepted, &HeaderMap::new()));

        // An empty list admits nothing: it no longer means "no check".
        let nothing = InboundAuth::Bearer(vec![]);
        assert!(!request_is_authorized(&nothing, &bearer("anything")));
        assert!(!request_is_authorized(&nothing, &HeaderMap::new()));

        assert!(request_is_authorized(
            &InboundAuth::LoopbackUnauthenticated,
            &HeaderMap::new()
        ));

        assert!(tokens_equal("abc", "abc"));
        assert!(!tokens_equal("abc", "abd"));
        assert!(!tokens_equal("abc", "abcd"));
        assert!(!tokens_equal("", ""));
    }

    /// Counts every allocator call the routes make.
    #[derive(Default)]
    struct CountingAllocator {
        calls: AtomicUsize,
    }

    #[async_trait]
    impl RuntimeAllocator for CountingAllocator {
        async fn ensure_runtime(
            &self,
            _request: EnsureRuntimeRequest,
        ) -> anyhow::Result<EnsureRuntimeOutcome> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(EnsureRuntimeOutcome::default())
        }

        async fn stop_runtime(&self, _project_id: Uuid, _runtime_id: Uuid) -> anyhow::Result<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn runtime_oom_killed(
            &self,
            _project_id: Uuid,
            _runtime_id: Uuid,
        ) -> anyhow::Result<Option<bool>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }

        async fn census(&self) -> anyhow::Result<super::RuntimeCensus> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(super::RuntimeCensus::default())
        }

        async fn origin_endpoint(
            &self,
            _project_id: Uuid,
            _runtime_id: Uuid,
            _lease_id: Uuid,
        ) -> anyhow::Result<Option<String>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(None)
        }
    }

    /// Serves `app` on an ephemeral loopback port.
    async fn serve(inbound_auth: InboundAuth) -> (std::net::SocketAddr, Arc<CountingAllocator>) {
        let allocator = Arc::new(CountingAllocator::default());
        let state = ProviderState {
            allocator: allocator.clone(),
            runtime_operations: RuntimeOperationLocks::default(),
            provider_id: "test-provider".to_string(),
            inbound_auth,
            provider_auth_token: None,
            controller_registration_token: None,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind an ephemeral port");
        let address = listener.local_addr().expect("listener address");
        tokio::spawn(async move {
            axum::serve(listener, app(state).into_make_service())
                .await
                .expect("serve the provider routes");
        });
        (address, allocator)
    }

    fn lifecycle_requests() -> Vec<(&'static str, serde_json::Value)> {
        let runtime = serde_json::json!({
            "project_id": Uuid::new_v4(),
            "runtime_id": Uuid::new_v4(),
            "lease_id": Uuid::new_v4(),
        });
        let mut ensure = runtime.clone();
        ensure["provider"] = "test-provider".into();
        ensure["runtime_token"] = "test-runtime-token".into();
        vec![
            ("/runtime/ensure", ensure),
            ("/runtime/release", runtime.clone()),
            ("/runtime/inspect", runtime.clone()),
            ("/runtime/census", serde_json::json!({})),
            ("/runtime/origin", runtime),
        ]
    }

    /// Every route sits behind the provider's token: launching, stopping,
    /// inspecting, listing and locating runtimes. A request without the
    /// token, or with another one, is refused before the allocator sees it.
    #[tokio::test]
    async fn every_route_refuses_a_request_without_the_provider_token() {
        let (address, allocator) =
            serve(InboundAuth::Bearer(vec!["provider-token".to_string()])).await;
        let client = reqwest::Client::new();
        let requests = lifecycle_requests();

        for (path, body) in &requests {
            for token in [None, Some("wrong-token"), Some("")] {
                let mut request = client.post(format!("http://{address}{path}")).json(body);
                if let Some(token) = token {
                    request = request.bearer_auth(token);
                }
                let status = request.send().await.expect("request").status();
                assert_eq!(
                    status,
                    reqwest::StatusCode::UNAUTHORIZED,
                    "{path} with {token:?}"
                );
            }
        }
        let status = client
            .get(format!("http://{address}/healthz"))
            .send()
            .await
            .expect("request")
            .status();
        assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
        assert_eq!(allocator.calls.load(Ordering::SeqCst), 0);

        for (path, body) in &requests {
            let status = client
                .post(format!("http://{address}{path}"))
                .bearer_auth("provider-token")
                .json(body)
                .send()
                .await
                .expect("request")
                .status();
            assert_ne!(status, reqwest::StatusCode::UNAUTHORIZED, "{path}");
        }
        assert_eq!(allocator.calls.load(Ordering::SeqCst), requests.len());
    }

    /// A service with no accepted token refuses everything, and only the
    /// local-development mode admits a request without one.
    #[tokio::test]
    async fn routes_admit_no_token_only_in_local_development() {
        let client = reqwest::Client::new();

        let (address, allocator) = serve(InboundAuth::Bearer(vec![])).await;
        for (path, body) in lifecycle_requests() {
            let status = client
                .post(format!("http://{address}{path}"))
                .json(&body)
                .send()
                .await
                .expect("request")
                .status();
            assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED, "{path}");
        }
        assert_eq!(allocator.calls.load(Ordering::SeqCst), 0);

        let (address, allocator) = serve(InboundAuth::LoopbackUnauthenticated).await;
        let status = client
            .post(format!("http://{address}/runtime/census"))
            .send()
            .await
            .expect("request")
            .status();
        assert_eq!(status, reqwest::StatusCode::OK);
        assert_eq!(allocator.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn release_endpoint_acknowledges_successful_allocator_release() {
        let release_calls = Arc::new(AtomicUsize::new(0));
        let result = release_runtime(
            State(provider_state(false, release_calls.clone())),
            Json(ReleasePayload {
                project_id: Uuid::new_v4(),
                runtime_id: Uuid::new_v4(),
                lease_id: Some(Uuid::new_v4()),
            }),
        )
        .await;

        assert_eq!(result.expect("release success"), StatusCode::NO_CONTENT);
        assert_eq!(release_calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn release_endpoint_rejects_generation_blind_release() {
        let release_calls = Arc::new(AtomicUsize::new(0));
        let result = release_runtime(
            State(provider_state(false, release_calls.clone())),
            Json(ReleasePayload {
                project_id: Uuid::new_v4(),
                runtime_id: Uuid::new_v4(),
                lease_id: None,
            }),
        )
        .await;

        let (status, body) = result.expect_err("missing generation must fail closed");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body, "runtime release requires lease_id");
        assert_eq!(release_calls.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn release_endpoint_forwards_exact_lease_generation() {
        let lease_id = Uuid::new_v4();
        let observed_lease_id = Arc::new(StdMutex::new(None));
        let state = ProviderState {
            allocator: Arc::new(GenerationAllocator {
                observed_lease_id: observed_lease_id.clone(),
            }),
            runtime_operations: RuntimeOperationLocks::default(),
            provider_id: "test-provider".to_string(),
            inbound_auth: InboundAuth::Bearer(vec![]),
            provider_auth_token: None,
            controller_registration_token: None,
        };

        let result = release_runtime(
            State(state),
            Json(ReleasePayload {
                project_id: Uuid::new_v4(),
                runtime_id: Uuid::new_v4(),
                lease_id: Some(lease_id),
            }),
        )
        .await;

        assert_eq!(result.expect("release success"), StatusCode::NO_CONTENT);
        assert_eq!(
            *observed_lease_id
                .lock()
                .expect("generation observation lock"),
            Some(Some(lease_id))
        );
    }

    /// Knows one running runtime generation and where its origin is.
    struct OriginAllocator {
        lease_id: Uuid,
    }

    #[async_trait]
    impl RuntimeAllocator for OriginAllocator {
        async fn ensure_runtime(
            &self,
            _request: EnsureRuntimeRequest,
        ) -> anyhow::Result<EnsureRuntimeOutcome> {
            Ok(EnsureRuntimeOutcome::default())
        }

        async fn origin_endpoint(
            &self,
            _project_id: Uuid,
            _runtime_id: Uuid,
            lease_id: Uuid,
        ) -> anyhow::Result<Option<String>> {
            Ok(
                (lease_id == self.lease_id)
                    .then(|| "http://host.docker.internal:49153".to_string()),
            )
        }
    }

    /// The origin route answers where the allocator sees the origin of
    /// exactly the generation asked for, and nothing for any other.
    #[tokio::test]
    async fn origin_endpoint_answers_only_for_the_running_generation() {
        let lease_id = Uuid::new_v4();
        let state = ProviderState {
            allocator: Arc::new(OriginAllocator { lease_id }),
            runtime_operations: RuntimeOperationLocks::default(),
            provider_id: "test-provider".to_string(),
            inbound_auth: InboundAuth::Bearer(vec![]),
            provider_auth_token: None,
            controller_registration_token: None,
        };
        let ask = |lease_id| {
            runtime_origin(
                State(state.clone()),
                Json(OriginPayload {
                    project_id: Uuid::new_v4(),
                    runtime_id: Uuid::new_v4(),
                    lease_id,
                }),
            )
        };

        let Json(found) = ask(lease_id).await.expect("the running generation");
        assert_eq!(found.endpoint, "http://host.docker.internal:49153");
        let (status, _) = ask(Uuid::new_v4())
            .await
            .expect_err("another generation has no origin here");
        assert_eq!(status, StatusCode::NOT_FOUND);
        // An allocator that cannot tell vouches for nothing.
        let (status, _) = runtime_origin(
            State(provider_state(false, Arc::new(AtomicUsize::new(0)))),
            Json(OriginPayload {
                project_id: Uuid::new_v4(),
                runtime_id: Uuid::new_v4(),
                lease_id,
            }),
        )
        .await
        .expect_err("nothing to vouch for");
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn release_endpoint_sanitizes_allocator_failure() {
        let release_calls = Arc::new(AtomicUsize::new(0));
        let result = release_runtime(
            State(provider_state(true, release_calls.clone())),
            Json(ReleasePayload {
                project_id: Uuid::new_v4(),
                runtime_id: Uuid::new_v4(),
                lease_id: Some(Uuid::new_v4()),
            }),
        )
        .await;

        let (status, body) = result.expect_err("release failure must propagate");
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body, "runtime release failed");
        assert!(!body.contains("compose down sentinel failure"));
        assert_eq!(release_calls.load(Ordering::SeqCst), 1);
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info,runtime_provider=info".to_string()),
        )
        .init();

    let (state, addr) = build_config()?;
    if state.inbound_auth == InboundAuth::LoopbackUnauthenticated {
        warn!(
            %addr,
            "{ALLOW_UNAUTHENTICATED_ENV}=1: serving without a token, for local development only"
        );
    }

    let registration_state = state.clone();
    tokio::spawn(async move {
        let mut delay = Duration::from_secs(2);
        loop {
            if try_register_with_controller(&registration_state).await {
                break;
            }
            time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(60));
        }
    });

    spawn_workspace_cache_cleanup();
    spawn_checkout_eviction(state.allocator.clone());

    info!(%addr, "runtime provider service starting");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let server = axum::serve(listener, app(state).into_make_service());
    tokio::select! {
        result = server => {
            if let Err(error) = result {
                error!(%error, "server error");
            }
        }
        _ = signal::ctrl_c() => {
            info!("shutdown signal received");
        }
    }
    Ok(())
}
