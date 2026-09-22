use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex, RwLock as StdRwLock};

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio::sync::{broadcast, mpsc, Mutex as TokioMutex, RwLock};
use uuid::Uuid;

use crate::config::{AppConfig, PgPool};
use crate::connection_limit::ConnectionLimiter;
use crate::device_auth::DeviceAuthRegistry;
use crate::rate_limit::RateLimiter;
use crate::tunnels::DynTunnelBroker;

#[derive(Clone)]
pub(crate) struct AppState {
    pub(crate) config: AppConfig,
    pub(crate) pool: PgPool,
    pub(crate) rate_limiter: RateLimiter,
    pub(crate) connection_limiter: ConnectionLimiter,
    pub(crate) events: EventHub,
    pub(crate) http_client: reqwest::Client,
    pub(crate) origin_proxy_client: reqwest::Client,
    pub(crate) runtime_activity: RuntimeActivityTracker,
    pub(crate) local_workspaces: LocalWorkspaceRegistry,
    pub(crate) runtime_preferences: RuntimePreferenceRegistry,
    pub(crate) runtime_resource_usage: RuntimeResourceUsageRegistry,
    pub(crate) provider_registry: ProviderRegistry,
    pub(crate) tunnel_broker: Option<DynTunnelBroker>,
    pub(crate) device_auth_sessions: DeviceAuthRegistry,
    pub(crate) ota_registry: crate::ota::OtaRegistry,
    pub(crate) desktop_update_registry: crate::desktop_updates::DesktopUpdateRegistry,
    pub(crate) credential_refresh_locks: CredentialRefreshLocks,
}

/// Serializes OAuth token refreshes per credential. ChatGPT refresh tokens
/// rotate on use, so two concurrent refreshes reading the same stored token
/// invalidate the whole token family; every read→refresh→persist cycle must
/// run under this lock.
#[derive(Clone)]
pub(crate) struct CredentialRefreshLocks {
    inner: Arc<TokioMutex<HashMap<Uuid, Arc<TokioMutex<()>>>>>,
}

impl CredentialRefreshLocks {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(TokioMutex::new(HashMap::new())),
        }
    }

    pub(crate) async fn lock_for(&self, credential_id: Uuid) -> Arc<TokioMutex<()>> {
        let mut map = self.inner.lock().await;
        map.entry(credential_id)
            .or_insert_with(|| Arc::new(TokioMutex::new(())))
            .clone()
    }
}

#[derive(Clone)]
pub(crate) struct ProviderRegistry {
    inner: Arc<StdRwLock<ProviderState>>,
}

#[derive(Default)]
struct ProviderState {
    configs: HashMap<String, crate::config::RuntimeProviderConfig>,
    default_provider_id: String,
}

impl ProviderRegistry {
    pub(crate) fn new(
        configs: HashMap<String, crate::config::RuntimeProviderConfig>,
        default_provider_id: String,
    ) -> Self {
        Self {
            inner: Arc::new(StdRwLock::new(ProviderState {
                configs,
                default_provider_id,
            })),
        }
    }

    pub(crate) fn provider_config(
        &self,
        provider: &str,
    ) -> Option<crate::config::RuntimeProviderConfig> {
        let guard = self.inner.read().ok()?;
        guard
            .configs
            .get(&crate::provider_identifiers::provider_id_key(provider))
            .cloned()
    }

    pub(crate) fn provider_configs(&self) -> Vec<crate::config::RuntimeProviderConfig> {
        let Ok(guard) = self.inner.read() else {
            return Vec::new();
        };
        guard.configs.values().cloned().collect()
    }

    #[allow(dead_code)]
    pub(crate) fn default_provider_id(&self) -> String {
        let guard = self.inner.read().expect("provider registry poisoned");
        guard.default_provider_id.clone()
    }

    pub(crate) fn replace(
        &self,
        configs: HashMap<String, crate::config::RuntimeProviderConfig>,
        default_provider_id: String,
    ) {
        let mut guard = self.inner.write().expect("provider registry poisoned");
        guard.configs = configs;
        guard.default_provider_id = default_provider_id;
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct RuntimeActivityEntry {
    pub(crate) last_active: DateTime<Utc>,
    pub(crate) idle_ttl_seconds: i64,
}

#[derive(Clone)]
pub(crate) struct RuntimeActivityTracker {
    default_idle_ttl_seconds: i64,
    inner: Arc<RwLock<HashMap<Uuid, RuntimeActivityEntry>>>,
}

impl RuntimeActivityTracker {
    pub(crate) fn new(default_idle_ttl_seconds: i64) -> Self {
        Self {
            default_idle_ttl_seconds: default_idle_ttl_seconds.max(30),
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) async fn mark_active(
        &self,
        project_id: Uuid,
        idle_ttl_seconds: Option<i64>,
        at: Option<DateTime<Utc>>,
    ) -> RuntimeActivityEntry {
        let idle_ttl = idle_ttl_seconds
            .map(|value| value.max(30))
            .unwrap_or(self.default_idle_ttl_seconds);
        let timestamp = at.unwrap_or_else(Utc::now);
        let mut guard = self.inner.write().await;
        let entry = guard.entry(project_id).or_insert(RuntimeActivityEntry {
            last_active: timestamp,
            idle_ttl_seconds: idle_ttl,
        });
        entry.last_active = timestamp;
        entry.idle_ttl_seconds = idle_ttl;
        *entry
    }

    pub(crate) async fn mark_released(&self, project_id: &Uuid) {
        let mut guard = self.inner.write().await;
        let entry = guard.entry(*project_id).or_insert(RuntimeActivityEntry {
            last_active: Utc::now(),
            idle_ttl_seconds: self.default_idle_ttl_seconds,
        });
        entry.last_active = Utc::now();
    }

    /// Most recent activity mark for a project, if the tracker has one.
    /// Absent entries mean "no activity seen since controller start" — treat
    /// as idle only in combination with durable (DB) signals.
    pub(crate) async fn last_activity_for(
        &self,
        project_id: &Uuid,
    ) -> Option<RuntimeActivityEntry> {
        let guard = self.inner.read().await;
        guard.get(project_id).copied()
    }

    pub(crate) async fn idle_candidates(&self) -> Vec<(Uuid, RuntimeActivityEntry)> {
        let now = Utc::now();
        let guard = self.inner.read().await;
        guard
            .iter()
            .filter_map(|(project_id, entry)| {
                let idle_ttl = entry.idle_ttl_seconds.max(30);
                if now.signed_duration_since(entry.last_active) >= ChronoDuration::seconds(idle_ttl)
                {
                    Some((*project_id, *entry))
                } else {
                    None
                }
            })
            .collect()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LocalWorkspaceEntry {
    #[serde(skip)]
    pub(crate) owner_user_id: Uuid,
    pub(crate) device_id: String,
    pub(crate) path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) release: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) arch: Option<String>,
    pub(crate) last_heartbeat: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) expires_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) preferred_runtime_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) presence_status: Option<String>,
}

#[derive(Clone)]
pub(crate) struct LocalWorkspaceRegistry {
    inner: Arc<RwLock<HashMap<(Uuid, Uuid), LocalWorkspaceEntry>>>,
}

impl LocalWorkspaceRegistry {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) async fn register(
        &self,
        project_id: Uuid,
        mut entry: LocalWorkspaceEntry,
        ttl: ChronoDuration,
    ) -> LocalWorkspaceEntry {
        let now = Utc::now();
        entry.last_heartbeat = now;
        entry.expires_at = Some(now + ttl);
        let mut guard = self.inner.write().await;
        guard.insert((project_id, entry.owner_user_id), entry.clone());
        entry
    }

    pub(crate) async fn heartbeat(
        &self,
        project_id: Uuid,
        owner_user_id: Uuid,
        device_id: &str,
        runtime_id: Option<Uuid>,
        ttl: ChronoDuration,
    ) -> Option<LocalWorkspaceEntry> {
        let mut guard = self.inner.write().await;
        if let Some(existing) = guard.get_mut(&(project_id, owner_user_id)) {
            if existing.device_id == device_id {
                let now = Utc::now();
                existing.last_heartbeat = now;
                existing.expires_at = Some(now + ttl);
                if let Some(runtime) = runtime_id {
                    existing.preferred_runtime_id = Some(runtime);
                }
                return Some(existing.clone());
            }
        }
        None
    }

    pub(crate) async fn set_preferred_runtime(
        &self,
        project_id: &Uuid,
        owner_user_id: &Uuid,
        runtime_id: Uuid,
    ) -> Option<LocalWorkspaceEntry> {
        let mut guard = self.inner.write().await;
        if let Some(existing) = guard.get_mut(&(*project_id, *owner_user_id)) {
            existing.preferred_runtime_id = Some(runtime_id);
            return Some(existing.clone());
        }
        None
    }

    pub(crate) async fn get_active(
        &self,
        project_id: &Uuid,
        owner_user_id: &Uuid,
        ttl: ChronoDuration,
    ) -> Option<LocalWorkspaceEntry> {
        let mut guard = self.inner.write().await;
        let key = (*project_id, *owner_user_id);
        match guard.get(&key) {
            Some(entry) => {
                if is_entry_expired(entry, ttl) {
                    guard.remove(&key);
                    None
                } else {
                    Some(entry.clone())
                }
            }
            None => None,
        }
    }

    pub(crate) async fn unregister(
        &self,
        project_id: &Uuid,
        owner_user_id: &Uuid,
        device_id: Option<&str>,
    ) -> bool {
        let mut guard = self.inner.write().await;
        let key = (*project_id, *owner_user_id);
        if let Some(entry) = guard.get(&key) {
            if let Some(expected) = device_id {
                if entry.device_id != expected {
                    return false;
                }
            }
        }
        guard.remove(&key).is_some()
    }

    pub(crate) async fn prune_expired(
        &self,
        ttl: ChronoDuration,
    ) -> Vec<(Uuid, Uuid, LocalWorkspaceEntry)> {
        let mut guard = self.inner.write().await;
        let mut expired = Vec::new();
        guard.retain(|(project_id, owner_user_id), entry| {
            if is_entry_expired(entry, ttl) {
                expired.push((*project_id, *owner_user_id, entry.clone()));
                false
            } else {
                true
            }
        });
        expired
    }
}

#[derive(Clone)]
pub(crate) struct EventHub {
    sender: broadcast::Sender<ControllerEvent>,
    outbound: Option<mpsc::Sender<ControllerEvent>>,
    /// Open `/events` streams on this node, per project.
    project_watchers: Arc<StdMutex<HashMap<Uuid, usize>>>,
    /// Per-org spacing of `credits.updated`.
    pub(crate) credit_signals: SignalCoalescer,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimePreferenceEntry {
    pub(crate) runtime_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) source: Option<String>,
    pub(crate) updated_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "displayName")]
    pub(crate) display_name: Option<String>,
}

#[derive(Clone)]
pub(crate) struct RuntimePreferenceRegistry {
    inner: Arc<RwLock<HashMap<Uuid, RuntimePreferenceEntry>>>,
    private_inner: Arc<RwLock<HashMap<(Uuid, Uuid), RuntimePreferenceEntry>>>,
}

impl RuntimePreferenceRegistry {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
            private_inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) async fn set(
        &self,
        project_id: Uuid,
        runtime_id: Option<Uuid>,
        source: Option<String>,
        display_name: Option<String>,
    ) -> RuntimePreferenceEntry {
        let mut guard = self.inner.write().await;
        let entry = RuntimePreferenceEntry {
            runtime_id,
            source,
            updated_at: Utc::now(),
            display_name,
        };
        guard.insert(project_id, entry.clone());
        entry
    }

    pub(crate) async fn clear(&self, project_id: &Uuid) {
        let mut guard = self.inner.write().await;
        guard.remove(project_id);
    }

    pub(crate) async fn set_private(
        &self,
        project_id: Uuid,
        owner_user_id: Uuid,
        runtime_id: Option<Uuid>,
        source: Option<String>,
        display_name: Option<String>,
    ) -> RuntimePreferenceEntry {
        let entry = RuntimePreferenceEntry {
            runtime_id,
            source,
            updated_at: Utc::now(),
            display_name,
        };
        self.private_inner
            .write()
            .await
            .insert((project_id, owner_user_id), entry.clone());
        entry
    }

    pub(crate) async fn clear_private(&self, project_id: &Uuid, owner_user_id: &Uuid) -> bool {
        self.private_inner
            .write()
            .await
            .remove(&(*project_id, *owner_user_id))
            .is_some()
    }

    pub(crate) async fn get_private(
        &self,
        project_id: &Uuid,
        owner_user_id: &Uuid,
    ) -> Option<RuntimePreferenceEntry> {
        self.private_inner
            .read()
            .await
            .get(&(*project_id, *owner_user_id))
            .cloned()
    }

    pub(crate) async fn clear_runtime(&self, project_id: &Uuid, runtime_id: &Uuid) {
        {
            let mut global = self.inner.write().await;
            if global.get(project_id).and_then(|entry| entry.runtime_id) == Some(*runtime_id) {
                global.remove(project_id);
            }
        }
        self.private_inner
            .write()
            .await
            .retain(|(entry_project_id, _), entry| {
                entry_project_id != project_id || entry.runtime_id != Some(*runtime_id)
            });
    }

    pub(crate) async fn get(&self, project_id: &Uuid) -> Option<RuntimePreferenceEntry> {
        let guard = self.inner.read().await;
        guard.get(project_id).cloned()
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeResourceUsagePayload {
    #[serde(default)]
    pub(crate) cpu_pct: Option<f64>,
    #[serde(default)]
    pub(crate) cpu_limit_cores: Option<f64>,
    #[serde(default)]
    pub(crate) memory_used_bytes: Option<u64>,
    #[serde(default)]
    pub(crate) memory_limit_bytes: Option<u64>,
    #[serde(default)]
    pub(crate) disk_used_bytes: Option<u64>,
    #[serde(default)]
    pub(crate) disk_limit_bytes: Option<u64>,
}

#[derive(Clone, Debug)]
pub(crate) struct RuntimeResourceUsageSnapshot {
    pub(crate) payload: RuntimeResourceUsagePayload,
    pub(crate) updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeResourceUsageEntry {
    #[serde(flatten)]
    pub(crate) payload: RuntimeResourceUsagePayload,
    pub(crate) updated_at: String,
}

impl From<RuntimeResourceUsageSnapshot> for RuntimeResourceUsageEntry {
    fn from(snapshot: RuntimeResourceUsageSnapshot) -> Self {
        Self {
            payload: snapshot.payload,
            updated_at: snapshot.updated_at.to_rfc3339(),
        }
    }
}

#[derive(Clone)]
pub(crate) struct RuntimeResourceUsageRegistry {
    inner: Arc<RwLock<HashMap<Uuid, RuntimeResourceUsageSnapshot>>>,
}

impl RuntimeResourceUsageRegistry {
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub(crate) async fn set(
        &self,
        runtime_id: Uuid,
        payload: RuntimeResourceUsagePayload,
    ) -> RuntimeResourceUsageSnapshot {
        let snapshot = RuntimeResourceUsageSnapshot {
            payload,
            updated_at: Utc::now(),
        };
        let mut guard = self.inner.write().await;
        guard.insert(runtime_id, snapshot.clone());
        snapshot
    }

    pub(crate) async fn get(&self, runtime_id: &Uuid) -> Option<RuntimeResourceUsageSnapshot> {
        let guard = self.inner.read().await;
        guard.get(runtime_id).cloned()
    }
}

fn is_entry_expired(entry: &LocalWorkspaceEntry, ttl: ChronoDuration) -> bool {
    let now = Utc::now();
    now.signed_duration_since(entry.last_heartbeat) > ttl
}

impl EventHub {
    pub(crate) fn new() -> Self {
        Self::with_outbound(None)
    }

    pub(crate) fn new_with_outbound(outbound: mpsc::Sender<ControllerEvent>) -> Self {
        Self::with_outbound(Some(outbound))
    }

    fn with_outbound(outbound: Option<mpsc::Sender<ControllerEvent>>) -> Self {
        let (sender, _receiver) = broadcast::channel(256);
        Self {
            sender,
            outbound,
            project_watchers: Arc::new(StdMutex::new(HashMap::new())),
            credit_signals: SignalCoalescer::new(CREDITS_UPDATED_INTERVAL),
        }
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<ControllerEvent> {
        self.sender.subscribe()
    }

    /// Counts one open stream of `project_id` on this node until the
    /// returned guard is dropped. Project signals reach this node's
    /// broadcast only for watched projects.
    pub(crate) fn watch_project(&self, project_id: Uuid) -> ProjectWatch {
        *lock_unpoisoned(&self.project_watchers)
            .entry(project_id)
            .or_insert(0) += 1;
        ProjectWatch {
            watchers: self.project_watchers.clone(),
            project_id,
        }
    }

    pub(crate) fn publish(&self, event: ControllerEvent) {
        if let Some(outbound) = &self.outbound {
            let _ = outbound.try_send(event.clone());
        }
        self.send_local(event);
    }

    pub(crate) fn publish_local(&self, event: ControllerEvent) {
        self.send_local(event);
    }

    /// An org-wide signal is one event per project, and a large org would
    /// otherwise flood the 256-slot broadcast every stream on this node
    /// shares, lagging them and dropping other tenants' events. No stream can
    /// match a project nobody here watches, so those signals skip the local
    /// broadcast. The bus still carries them: other nodes apply the same check
    /// to their own streams in `publish_local`.
    fn send_local(&self, event: ControllerEvent) {
        if PROJECT_SIGNAL_KINDS.contains(&event.kind.as_str())
            && !event.project_id.is_some_and(|project_id| {
                lock_unpoisoned(&self.project_watchers).contains_key(&project_id)
            })
        {
            return;
        }
        let _ = self.sender.send(event);
    }
}

/// The kinds `publish_project_signal` fans out per project.
const PROJECT_SIGNAL_KINDS: [&str; 2] = [
    crate::projects::PROJECT_MEMBERS_CHANGED_EVENT,
    crate::credits::CREDITS_UPDATED_EVENT,
];

/// Minimum spacing of `credits.updated` for one org on one node.
pub(crate) const CREDITS_UPDATED_INTERVAL: std::time::Duration = std::time::Duration::from_secs(2);

fn lock_unpoisoned<T>(mutex: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One open stream's claim on a project; see `EventHub::watch_project`.
/// `/events` keeps it inside its response stream, so a finished, failed or
/// disconnected stream always stops counting.
pub(crate) struct ProjectWatch {
    watchers: Arc<StdMutex<HashMap<Uuid, usize>>>,
    project_id: Uuid,
}

impl Drop for ProjectWatch {
    fn drop(&mut self) {
        let mut watchers = lock_unpoisoned(&self.watchers);
        if let Some(count) = watchers.get_mut(&self.project_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                watchers.remove(&self.project_id);
            }
        }
    }
}

/// Spaces out a per-key signal (per org) on this node. The first signal
/// publishes at once; later ones inside the interval fold into a single
/// trailing publish when it ends, so the last change is always announced and
/// a key publishes at most once per interval.
#[derive(Clone)]
pub(crate) struct SignalCoalescer {
    interval: std::time::Duration,
    windows: Arc<StdMutex<HashMap<Uuid, SignalWindow>>>,
}

struct SignalWindow {
    published_at: tokio::time::Instant,
    /// Reason of the newest change waiting for the trailing publish.
    trailing: Option<&'static str>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum SignalAdmission {
    /// Publish now.
    Now,
    /// Schedule the one trailing publish (`take_trailing`) after this delay.
    Trailing(std::time::Duration),
    /// The scheduled trailing publish will announce this change too.
    Coalesced,
}

impl SignalCoalescer {
    pub(crate) fn new(interval: std::time::Duration) -> Self {
        Self {
            interval,
            windows: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    pub(crate) fn admit(
        &self,
        key: Uuid,
        reason: &'static str,
        now: tokio::time::Instant,
    ) -> SignalAdmission {
        let interval = self.interval;
        let mut windows = lock_unpoisoned(&self.windows);
        windows.retain(|_, window| {
            window.trailing.is_some()
                || now.saturating_duration_since(window.published_at) < interval
        });
        let Some(window) = windows.get_mut(&key) else {
            windows.insert(
                key,
                SignalWindow {
                    published_at: now,
                    trailing: None,
                },
            );
            return SignalAdmission::Now;
        };
        if window.trailing.replace(reason).is_some() {
            return SignalAdmission::Coalesced;
        }
        SignalAdmission::Trailing(
            interval.saturating_sub(now.saturating_duration_since(window.published_at)),
        )
    }

    /// Runs the scheduled trailing publish: returns the newest pending reason
    /// and restarts the key's interval at `now`.
    pub(crate) fn take_trailing(
        &self,
        key: Uuid,
        now: tokio::time::Instant,
    ) -> Option<&'static str> {
        let mut windows = lock_unpoisoned(&self.windows);
        let window = windows.get_mut(&key)?;
        let reason = window.trailing.take()?;
        window.published_at = now;
        Some(reason)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ControllerEvent {
    pub(crate) kind: String,
    pub(crate) project_id: Option<Uuid>,
    pub(crate) session_id: Option<Uuid>,
    pub(crate) conversation_id: Option<Uuid>,
    pub(crate) run_id: Option<Uuid>,
    pub(crate) job_id: Option<Uuid>,
    pub(crate) channel: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) channels: Vec<String>,
    /// Optional human-user audience for non-sensitive control events. This is
    /// serialized across the Redis event bus so rolling/multi-node
    /// deployments preserve targeting. Consumers must still explicitly opt a
    /// kind into any authorization exception before this field has an effect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) target_user_id: Option<Uuid>,
    pub(crate) data: JsonValue,
    pub(crate) timestamp: DateTime<Utc>,
}

pub(crate) fn publish_controller_event(
    hub: &EventHub,
    kind: &str,
    project_id: Option<Uuid>,
    session_id: Option<Uuid>,
    run_id: Option<Uuid>,
    job_id: Option<Uuid>,
    data: JsonValue,
) {
    publish_controller_event_with_conversation(
        hub, kind, project_id, session_id, None, run_id, job_id, data,
    );
}

pub(crate) fn publish_controller_event_to_user(
    hub: &EventHub,
    kind: &str,
    project_id: Option<Uuid>,
    target_user_id: Uuid,
    data: JsonValue,
) {
    hub.publish(ControllerEvent {
        kind: kind.to_string(),
        project_id,
        session_id: None,
        conversation_id: None,
        run_id: None,
        job_id: None,
        channel: None,
        channels: Vec::new(),
        target_user_id: Some(target_user_id),
        data,
        timestamp: Utc::now(),
    });
}

pub(crate) fn publish_controller_event_with_conversation(
    hub: &EventHub,
    kind: &str,
    project_id: Option<Uuid>,
    session_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    run_id: Option<Uuid>,
    job_id: Option<Uuid>,
    data: JsonValue,
) {
    let session_chan = session_channel(session_id);
    let conversation_chan = conversation_channel(conversation_id);
    let mut channels = Vec::new();
    if let Some(ref value) = session_chan {
        channels.push(value.clone());
    }
    if let Some(ref value) = conversation_chan {
        channels.push(value.clone());
    }

    let event = ControllerEvent {
        kind: kind.to_string(),
        project_id,
        session_id,
        conversation_id,
        run_id,
        job_id,
        channel: session_chan.clone().or(conversation_chan.clone()),
        channels,
        target_user_id: None,
        data,
        timestamp: Utc::now(),
    };
    hub.publish(event);
}

/// Publishes a capability invalidation to open streams owned by
/// `target_user_id`. `Some(project_id)` scopes a direct-membership change;
/// `None` efficiently invalidates every open project stream for an org-wide
/// membership change. The payload intentionally contains no role/capability
/// snapshot: clients must refetch the authoritative project summary after the
/// membership transaction commits.
pub(crate) fn publish_project_access_changed(
    hub: &EventHub,
    project_id: Option<Uuid>,
    target_user_id: Uuid,
) {
    hub.publish(ControllerEvent {
        kind: "project.access_changed".to_string(),
        project_id,
        session_id: None,
        conversation_id: None,
        run_id: None,
        job_id: None,
        channel: None,
        channels: Vec::new(),
        target_user_id: Some(target_user_id),
        data: serde_json::json!({ "reason": "membership_changed" }),
        timestamp: Utc::now(),
    });
}

/// Publishes one untargeted, signal-only event per project so every open
/// stream of those projects learns that something it can already read has
/// changed, and refetches it through its own authorized endpoint. The events
/// take the ordinary per-event project access recheck, so the payload is the
/// reason alone and must never carry data a project viewer could not fetch
/// (no balance, plan, member or role). Publish only after the transaction
/// that made the change has committed. A node's broadcast carries them only
/// for projects that one of its streams watches (`EventHub::send_local`).
pub(crate) fn publish_project_signal(
    hub: &EventHub,
    kind: &str,
    project_ids: &[Uuid],
    reason: &str,
) {
    for project_id in project_ids {
        publish_controller_event(
            hub,
            kind,
            Some(*project_id),
            None,
            None,
            None,
            serde_json::json!({ "reason": reason }),
        );
    }
}

fn session_channel(session_id: Option<Uuid>) -> Option<String> {
    session_id.map(|value| format!("session:{value}"))
}

fn conversation_channel(conversation_id: Option<Uuid>) -> Option<String> {
    conversation_id.map(|value| format!("conversation:{value}"))
}
