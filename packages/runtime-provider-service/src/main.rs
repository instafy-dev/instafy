use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::{self, Next},
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use runtime_provider_core::allocator::{
    build_runtime_allocator_for_kind, DynRuntimeAllocator, EnsureRuntimeRequest,
    RuntimeAllocatorKind,
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
    accepted_auth_tokens: Vec<String>,
    provider_auth_token: Option<String>,
    controller_registration_token: Option<String>,
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
    if !state.accepted_auth_tokens.is_empty() {
        let ok = req
            .headers()
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .map(|raw| raw.trim())
            .map(|raw| raw.strip_prefix("Bearer ").unwrap_or(raw))
            .map(|token| {
                state
                    .accepted_auth_tokens
                    .iter()
                    .any(|expected| token == expected)
            })
            .unwrap_or(false);
        if !ok {
            return (StatusCode::UNAUTHORIZED, "unauthorized").into_response();
        }
    }
    next.run(req).await
}

fn default_public_endpoint(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
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

fn build_config() -> anyhow::Result<ProviderState> {
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

    let resolved_tokens = resolve_auth_tokens(
        read_token_env("PROVIDER_AUTH_TOKEN"),
        read_token_env("CONTROLLER_SERVICE_ROLE_KEY"),
        read_token_env("CONTROLLER_INTERNAL_TOKEN"),
        read_token_env("SUPABASE_SERVICE_ROLE_KEY"),
    );

    Ok(ProviderState {
        allocator,
        runtime_operations: RuntimeOperationLocks::default(),
        provider_id,
        accepted_auth_tokens: resolved_tokens.accepted_auth_tokens,
        provider_auth_token: resolved_tokens.provider_auth_token,
        controller_registration_token: resolved_tokens.controller_registration_token,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedAuthTokens {
    accepted_auth_tokens: Vec<String>,
    provider_auth_token: Option<String>,
    controller_registration_token: Option<String>,
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

fn resolve_auth_tokens(
    provider_auth_token: Option<String>,
    controller_service_role_key: Option<String>,
    controller_internal_token: Option<String>,
    supabase_service_role_key: Option<String>,
) -> ResolvedAuthTokens {
    let mut accepted_auth_tokens = Vec::new();
    push_unique_token(&mut accepted_auth_tokens, provider_auth_token.as_deref());
    push_unique_token(
        &mut accepted_auth_tokens,
        controller_service_role_key.as_deref(),
    );
    push_unique_token(
        &mut accepted_auth_tokens,
        controller_internal_token.as_deref(),
    );

    let provider_auth_token = provider_auth_token
        .or_else(|| controller_service_role_key.clone())
        .or_else(|| controller_internal_token.clone());

    let controller_registration_token = controller_service_role_key
        .or_else(|| supabase_service_role_key)
        .or(controller_internal_token);

    ResolvedAuthTokens {
        accepted_auth_tokens,
        provider_auth_token,
        controller_registration_token,
    }
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
        ensure_runtime, release_runtime, resolve_auth_tokens, EnsurePayload, ProviderState,
        ReleasePayload, RuntimeOperationLocks,
    };
    use async_trait::async_trait;
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
            accepted_auth_tokens: vec![],
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
            accepted_auth_tokens: vec![],
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

    #[test]
    fn resolve_auth_tokens_prefers_provider_token_and_accepts_all_known_tokens() {
        let resolved = resolve_auth_tokens(
            Some("provider-token".to_string()),
            Some("controller-token".to_string()),
            Some("internal-token".to_string()),
            Some("supabase-token".to_string()),
        );

        assert_eq!(
            resolved.accepted_auth_tokens,
            vec![
                "provider-token".to_string(),
                "controller-token".to_string(),
                "internal-token".to_string()
            ]
        );
        assert_eq!(
            resolved.provider_auth_token.as_deref(),
            Some("provider-token")
        );
        assert_eq!(
            resolved.controller_registration_token.as_deref(),
            Some("controller-token")
        );
    }

    #[test]
    fn resolve_auth_tokens_falls_back_to_internal_for_registration() {
        let resolved = resolve_auth_tokens(None, None, Some("internal-token".to_string()), None);

        assert_eq!(
            resolved.accepted_auth_tokens,
            vec!["internal-token".to_string()]
        );
        assert_eq!(
            resolved.provider_auth_token.as_deref(),
            Some("internal-token")
        );
        assert_eq!(
            resolved.controller_registration_token.as_deref(),
            Some("internal-token")
        );
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
            accepted_auth_tokens: vec![],
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

    let state = build_config()?;

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

    let app = Router::new()
        .route("/runtime/ensure", post(ensure_runtime))
        .route("/runtime/release", post(release_runtime))
        .route("/runtime/inspect", post(inspect_runtime))
        .route("/healthz", axum::routing::get(|| async { StatusCode::OK }))
        .with_state(state.clone())
        .layer(middleware::from_fn_with_state(state, auth_layer));

    let addr: SocketAddr = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "0.0.0.0:9090".to_string())
        .parse()
        .expect("valid BIND_ADDR");
    info!(%addr, "runtime provider service starting");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let server = axum::serve(listener, app.into_make_service());
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
