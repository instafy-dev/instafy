use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};
use tokio::sync::{OnceCell, RwLock};
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::types::ToSql;
use tokio_postgres::Row;
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session, RequestContext};
use crate::config::PgPool;
use crate::geo::extract_country_code_from_headers;
use crate::{bad_request, forbidden, internal_error, not_found, ApiError, AppState};

const DEFAULT_LIST_EVENTS_LIMIT: i64 = 100;
const DEFAULT_LIST_DEVICE_STATES_LIMIT: i64 = 100;
const DEFAULT_LIST_CHANNEL_HISTORY_LIMIT: i64 = 20;
const DEFAULT_DOWNLOAD_INSIGHTS_DAYS: i64 = 14;
const MAX_LIST_EVENTS_LIMIT: i64 = 500;
const MAX_LIST_DEVICE_STATES_LIMIT: i64 = 500;
const MAX_LIST_CHANNEL_HISTORY_LIMIT: i64 = 100;
const MAX_DOWNLOAD_INSIGHTS_DAYS: i64 = 90;
const MAX_STORED_EVENTS: i64 = 5_000;
const MAX_STORED_CHANNEL_HISTORY: usize = 2_000;
const EVENT_RETENTION_DAYS: i32 = 30;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/ota/releases", get(list_releases).post(register_release))
        .route("/ota/channels", get(list_channels))
        .route(
            "/ota/channels/:platform/:channel/history",
            get(list_channel_history),
        )
        .route(
            "/ota/channels/:platform/:channel/activate",
            post(activate_channel),
        )
        .route(
            "/ota/channels/:platform/:channel/rollback",
            post(rollback_channel),
        )
        .route("/ota/device-states", get(list_device_states))
        .route("/ota/events", get(list_events).post(post_update_event))
        .route("/ota/download-insights", get(get_download_insights))
        .route("/ota/check", post(check_for_update))
}

#[derive(Clone)]
pub(crate) struct OtaRegistry {
    backend: OtaRegistryBackend,
}

#[derive(Clone)]
enum OtaRegistryBackend {
    InMemory(Arc<RwLock<OtaRegistrySnapshot>>),
    Postgres(PostgresOtaRegistry),
}

#[derive(Clone)]
struct PostgresOtaRegistry {
    pool: PgPool,
    tables_ready: Arc<OnceCell<()>>,
}

#[derive(Debug, Clone)]
struct ResolvedDeviceStateListParams {
    limit: i64,
    platform: Option<OtaPlatform>,
    channel: Option<String>,
    query: Option<String>,
    attention_only: bool,
    before_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
struct ResolvedEventListParams {
    limit: i64,
    platform: Option<OtaPlatform>,
    channel: Option<String>,
    event_type: Option<OtaEventType>,
    query: Option<String>,
    before_occurred_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone)]
struct ResolvedDownloadInsightsParams {
    days: i64,
    platform: Option<OtaPlatform>,
    channel: Option<String>,
}

impl OtaRegistry {
    pub(crate) fn new_in_memory() -> Self {
        Self {
            backend: OtaRegistryBackend::InMemory(Arc::new(RwLock::new(
                OtaRegistrySnapshot::default(),
            ))),
        }
    }

    pub(crate) fn new_postgres(pool: PgPool) -> Self {
        Self {
            backend: OtaRegistryBackend::Postgres(PostgresOtaRegistry {
                pool,
                tables_ready: Arc::new(OnceCell::new()),
            }),
        }
    }

    async fn list_releases(&self) -> Result<Vec<OtaReleaseRecord>, OtaRegistryError> {
        match &self.backend {
            OtaRegistryBackend::InMemory(store) => {
                let guard = store.read().await;
                let mut releases = guard.releases.values().cloned().collect::<Vec<_>>();
                releases.sort_by(|left, right| right.published_at.cmp(&left.published_at));
                Ok(releases)
            }
            OtaRegistryBackend::Postgres(store) => store.list_releases().await,
        }
    }

    async fn list_channels(&self) -> Result<Vec<OtaChannelAssignment>, OtaRegistryError> {
        match &self.backend {
            OtaRegistryBackend::InMemory(store) => {
                let guard = store.read().await;
                Ok(guard.channels.values().cloned().collect())
            }
            OtaRegistryBackend::Postgres(store) => store.list_channels().await,
        }
    }

    async fn list_channel_history(
        &self,
        platform: OtaPlatform,
        channel: String,
        limit: i64,
    ) -> Result<Vec<OtaChannelHistoryEntry>, OtaRegistryError> {
        match &self.backend {
            OtaRegistryBackend::InMemory(store) => {
                let guard = store.read().await;
                let mut history = guard
                    .channel_history
                    .iter()
                    .filter(|entry| entry.platform == platform && entry.channel == channel)
                    .cloned()
                    .collect::<Vec<_>>();
                history.sort_by(|left, right| right.activated_at.cmp(&left.activated_at));
                history.truncate(limit as usize);
                Ok(history)
            }
            OtaRegistryBackend::Postgres(store) => {
                store.list_channel_history(platform, channel, limit).await
            }
        }
    }

    async fn list_device_states(
        &self,
        params: ResolvedDeviceStateListParams,
    ) -> Result<Vec<OtaDeviceState>, OtaRegistryError> {
        match &self.backend {
            OtaRegistryBackend::InMemory(store) => {
                let guard = store.read().await;
                let mut devices = guard.device_states.values().cloned().collect::<Vec<_>>();
                devices.sort_by(|left, right| right.last_seen_at.cmp(&left.last_seen_at));
                devices.retain(|device| device_matches_filters(device, &params));
                devices.truncate(params.limit as usize);
                Ok(devices)
            }
            OtaRegistryBackend::Postgres(store) => store.list_device_states(params).await,
        }
    }

    async fn list_events(
        &self,
        params: ResolvedEventListParams,
    ) -> Result<Vec<OtaUpdateEvent>, OtaRegistryError> {
        match &self.backend {
            OtaRegistryBackend::InMemory(store) => {
                let guard = store.read().await;
                let mut events = guard.recent_events.clone();
                events.sort_by(|left, right| right.occurred_at.cmp(&left.occurred_at));
                events.retain(|event| event_matches_filters(event, &params));
                events.truncate(params.limit as usize);
                Ok(events)
            }
            OtaRegistryBackend::Postgres(store) => store.list_events(params).await,
        }
    }

    async fn get_download_insights(
        &self,
        params: ResolvedDownloadInsightsParams,
    ) -> Result<OtaDownloadInsights, OtaRegistryError> {
        match &self.backend {
            OtaRegistryBackend::InMemory(store) => {
                let guard = store.read().await;
                build_download_insights_from_events(&guard.recent_events, params)
            }
            OtaRegistryBackend::Postgres(store) => store.get_download_insights(params).await,
        }
    }

    async fn register_release(
        &self,
        mut release: OtaReleaseRecord,
    ) -> Result<OtaReleaseRecord, OtaRegistryError> {
        normalize_release(&mut release)?;
        match &self.backend {
            OtaRegistryBackend::InMemory(store) => {
                let mut guard = store.write().await;
                guard
                    .releases
                    .insert(release.release_id.clone(), release.clone());
                Ok(release)
            }
            OtaRegistryBackend::Postgres(store) => store.register_release(release).await,
        }
    }

    async fn activate_channel(
        &self,
        platform: OtaPlatform,
        channel: String,
        request: ActivateChannelRequest,
    ) -> Result<OtaChannelAssignment, OtaRegistryError> {
        match &self.backend {
            OtaRegistryBackend::InMemory(store) => {
                activate_channel_in_memory(store, platform, channel, request).await
            }
            OtaRegistryBackend::Postgres(store) => {
                store.activate_channel(platform, channel, request).await
            }
        }
    }

    async fn rollback_channel(
        &self,
        platform: OtaPlatform,
        channel: String,
        request: RollbackChannelRequest,
    ) -> Result<OtaChannelAssignment, OtaRegistryError> {
        match &self.backend {
            OtaRegistryBackend::InMemory(store) => {
                rollback_channel_in_memory(store, platform, channel, request).await
            }
            OtaRegistryBackend::Postgres(store) => {
                store.rollback_channel(platform, channel, request).await
            }
        }
    }

    async fn check_for_update(
        &self,
        mut request: OtaCheckRequest,
    ) -> Result<OtaCheckResponse, OtaRegistryError> {
        normalize_check_request(&mut request)?;
        match &self.backend {
            OtaRegistryBackend::InMemory(store) => check_for_update_in_memory(store, request).await,
            OtaRegistryBackend::Postgres(store) => store.check_for_update(request).await,
        }
    }

    async fn record_event(
        &self,
        mut event: OtaUpdateEvent,
    ) -> Result<OtaUpdateEvent, OtaRegistryError> {
        normalize_event(&mut event)?;
        match &self.backend {
            OtaRegistryBackend::InMemory(store) => record_event_in_memory(store, event).await,
            OtaRegistryBackend::Postgres(store) => store.record_event(event).await,
        }
    }
}

impl PostgresOtaRegistry {
    async fn ensure_tables(&self) -> Result<(), OtaRegistryError> {
        self.tables_ready
            .get_or_try_init(|| async {
                ensure_ota_tables(&self.pool).await.map_err(ota_internal)?;
                Ok(())
            })
            .await
            .map(|_| ())
    }

    async fn list_releases(&self) -> Result<Vec<OtaReleaseRecord>, OtaRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(ota_internal)?;
        let rows = connection
            .query(
                "select release_id, platform, channel, bundle_version, git_sha, native_version,
                        min_supported_native_version, artifact_url, artifact_sha256,
                        artifact_size_bytes, artifact_type, signature, rollout_percentage,
                        status, published_at, published_by, notes
                   from ota_releases
               order by published_at desc",
                &[],
            )
            .await
            .map_err(ota_internal)?;
        rows.into_iter().map(map_release_row).collect()
    }

    async fn list_channels(&self) -> Result<Vec<OtaChannelAssignment>, OtaRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(ota_internal)?;
        let rows = connection
            .query(
                "select platform, channel, active_release_id, previous_release_id,
                        rollout_percentage, activated_at, activated_by
                   from ota_channel_assignments
               order by platform asc, channel asc",
                &[],
            )
            .await
            .map_err(ota_internal)?;
        rows.into_iter().map(map_channel_assignment_row).collect()
    }

    async fn list_channel_history(
        &self,
        platform: OtaPlatform,
        channel: String,
        limit: i64,
    ) -> Result<Vec<OtaChannelHistoryEntry>, OtaRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(ota_internal)?;
        let rows = connection
            .query(
                "select history_id, platform, channel, action, previous_release_id,
                        next_release_id, rollout_percentage, activated_at, activated_by
                   from ota_channel_history
                  where platform = $1 and channel = $2
               order by activated_at desc, history_id desc
                  limit $3",
                &[&platform.to_string(), &channel, &limit],
            )
            .await
            .map_err(ota_internal)?;
        rows.into_iter().map(map_channel_history_row).collect()
    }

    async fn list_device_states(
        &self,
        params: ResolvedDeviceStateListParams,
    ) -> Result<Vec<OtaDeviceState>, OtaRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(ota_internal)?;
        let mut bindings: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();
        let mut clauses = Vec::new();

        if let Some(platform) = params.platform {
            bindings.push(Box::new(platform.to_string()));
            clauses.push(format!("platform = ${}", bindings.len()));
        }
        if let Some(channel) = params.channel {
            bindings.push(Box::new(channel));
            clauses.push(format!("channel = ${}", bindings.len()));
        }
        if let Some(before_seen_at) = params.before_seen_at {
            bindings.push(Box::new(before_seen_at));
            clauses.push(format!("last_seen_at < ${}", bindings.len()));
        }
        if params.attention_only {
            clauses.push(
                "(current_bundle_version is null or last_event_type in ('download_failed', 'install_failed', 'rollback_triggered'))"
                    .to_string(),
            );
        }
        if let Some(query) = params.query {
            bindings.push(Box::new(format!("%{query}%")));
            let placeholder = bindings.len();
            clauses.push(format!(
                "(device_id ilike ${placeholder} or channel ilike ${placeholder} or coalesce(current_bundle_version, '') ilike ${placeholder} or coalesce(current_git_sha, '') ilike ${placeholder} or coalesce(last_user_id, '') ilike ${placeholder})"
            ));
        }

        let mut sql = String::from(
            "select device_id, platform, channel, native_version, current_bundle_version,
                    current_git_sha, last_seen_at, last_check_at, last_event_type,
                    last_event_at, last_release_id, last_session_id, last_user_id,
                    last_space_id
               from ota_device_states",
        );
        if !clauses.is_empty() {
            sql.push_str(" where ");
            sql.push_str(&clauses.join(" and "));
        }
        bindings.push(Box::new(params.limit));
        sql.push_str(&format!(
            " order by last_seen_at desc limit ${}",
            bindings.len()
        ));
        let params = bindings
            .iter()
            .map(|value| value.as_ref() as &(dyn ToSql + Sync))
            .collect::<Vec<_>>();
        let rows = connection
            .query(sql.as_str(), &params)
            .await
            .map_err(ota_internal)?;
        rows.into_iter().map(map_device_state_row).collect()
    }

    async fn list_events(
        &self,
        params: ResolvedEventListParams,
    ) -> Result<Vec<OtaUpdateEvent>, OtaRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(ota_internal)?;
        let mut bindings: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();
        let mut clauses = Vec::new();

        if let Some(platform) = params.platform {
            bindings.push(Box::new(platform.to_string()));
            clauses.push(format!("platform = ${}", bindings.len()));
        }
        if let Some(channel) = params.channel {
            bindings.push(Box::new(channel));
            clauses.push(format!("channel = ${}", bindings.len()));
        }
        if let Some(event_type) = params.event_type {
            bindings.push(Box::new(event_type.to_string()));
            clauses.push(format!("event_type = ${}", bindings.len()));
        }
        if let Some(before_occurred_at) = params.before_occurred_at {
            bindings.push(Box::new(before_occurred_at));
            clauses.push(format!("occurred_at < ${}", bindings.len()));
        }
        if let Some(query) = params.query {
            bindings.push(Box::new(format!("%{query}%")));
            let placeholder = bindings.len();
            clauses.push(format!(
                "(event_type ilike ${placeholder} or device_id ilike ${placeholder} or channel ilike ${placeholder} or coalesce(bundle_version, '') ilike ${placeholder} or coalesce(session_id, '') ilike ${placeholder})"
            ));
        }

        let mut sql = String::from(
            "select event_id, event_type, occurred_at, device_id, platform, channel,
                    native_version, bundle_version, git_sha, space_id, user_id,
                    session_id, country_code, properties
               from ota_events",
        );
        if !clauses.is_empty() {
            sql.push_str(" where ");
            sql.push_str(&clauses.join(" and "));
        }
        bindings.push(Box::new(params.limit));
        sql.push_str(&format!(
            " order by occurred_at desc limit ${}",
            bindings.len()
        ));
        let params = bindings
            .iter()
            .map(|value| value.as_ref() as &(dyn ToSql + Sync))
            .collect::<Vec<_>>();
        let rows = connection
            .query(sql.as_str(), &params)
            .await
            .map_err(ota_internal)?;
        rows.into_iter().map(map_event_row).collect()
    }

    async fn get_download_insights(
        &self,
        params: ResolvedDownloadInsightsParams,
    ) -> Result<OtaDownloadInsights, OtaRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(ota_internal)?;
        let (start_day, end_day, start_at, end_exclusive) = resolve_download_window(params.days)?;

        let daily_rows = {
            let (clauses, bindings) =
                build_download_insight_query_parts(&params, start_at, end_exclusive);
            let query_params = bindings
                .iter()
                .map(|value| value.as_ref() as &(dyn ToSql + Sync))
                .collect::<Vec<_>>();
            let sql = format!(
                "select timezone('UTC', occurred_at)::date as day,
                        count(*) filter (where event_type = 'download_started') as started,
                        count(*) filter (where event_type = 'download_completed') as completed,
                        count(*) filter (where event_type = 'update_available') as available,
                        count(*) filter (where event_type in ('download_failed', 'install_failed', 'rollback_triggered')) as failures
                   from ota_events
                  where {}
               group by timezone('UTC', occurred_at)::date
               order by timezone('UTC', occurred_at)::date asc",
                clauses.join(" and ")
            );
            connection
                .query(sql.as_str(), &query_params)
                .await
                .map_err(ota_internal)?
        };

        let by_channel_rows = {
            let (clauses, bindings) =
                build_download_insight_query_parts(&params, start_at, end_exclusive);
            let query_params = bindings
                .iter()
                .map(|value| value.as_ref() as &(dyn ToSql + Sync))
                .collect::<Vec<_>>();
            let sql = format!(
                "select channel,
                        count(*) filter (where event_type = 'download_started') as started,
                        count(*) filter (where event_type = 'download_completed') as completed,
                        count(*) filter (where event_type = 'update_available') as available,
                        count(*) filter (where event_type in ('download_failed', 'install_failed', 'rollback_triggered')) as failures
                   from ota_events
                  where {}
               group by channel
               order by channel asc",
                clauses.join(" and ")
            );
            connection
                .query(sql.as_str(), &query_params)
                .await
                .map_err(ota_internal)?
        };

        let by_platform_rows = {
            let (clauses, bindings) =
                build_download_insight_query_parts(&params, start_at, end_exclusive);
            let query_params = bindings
                .iter()
                .map(|value| value.as_ref() as &(dyn ToSql + Sync))
                .collect::<Vec<_>>();
            let sql = format!(
                "select platform,
                        count(*) filter (where event_type = 'download_started') as started,
                        count(*) filter (where event_type = 'download_completed') as completed,
                        count(*) filter (where event_type = 'update_available') as available,
                        count(*) filter (where event_type in ('download_failed', 'install_failed', 'rollback_triggered')) as failures
                   from ota_events
                  where {}
               group by platform
               order by started desc, completed desc, platform asc",
                clauses.join(" and ")
            );
            connection
                .query(sql.as_str(), &query_params)
                .await
                .map_err(ota_internal)?
        };

        let by_country_rows = {
            let (clauses, bindings) =
                build_download_insight_query_parts(&params, start_at, end_exclusive);
            let query_params = bindings
                .iter()
                .map(|value| value.as_ref() as &(dyn ToSql + Sync))
                .collect::<Vec<_>>();
            let sql = format!(
                "select coalesce(nullif(country_code, ''), 'unknown') as country_code,
                        count(*) filter (where event_type = 'download_started') as started,
                        count(*) filter (where event_type = 'download_completed') as completed,
                        count(*) filter (where event_type = 'update_available') as available,
                        count(*) filter (where event_type in ('download_failed', 'install_failed', 'rollback_triggered')) as failures
                   from ota_events
                  where {}
               group by coalesce(nullif(country_code, ''), 'unknown')
               order by started desc, completed desc, country_code asc",
                clauses.join(" and ")
            );
            connection
                .query(sql.as_str(), &query_params)
                .await
                .map_err(ota_internal)?
        };

        Ok(build_download_insights_response(
            params,
            start_day,
            end_day,
            daily_rows
                .into_iter()
                .map(|row| {
                    let day = row.get::<_, NaiveDate>("day");
                    let counts = OtaDownloadInsightCounts {
                        started: row.get("started"),
                        completed: row.get("completed"),
                        available: row.get("available"),
                        failures: row.get("failures"),
                    };
                    (day, counts)
                })
                .collect(),
            by_channel_rows
                .into_iter()
                .map(|row| {
                    let channel = row.get::<_, String>("channel");
                    let counts = OtaDownloadInsightCounts {
                        started: row.get("started"),
                        completed: row.get("completed"),
                        available: row.get("available"),
                        failures: row.get("failures"),
                    };
                    (channel, counts)
                })
                .collect(),
            by_platform_rows
                .into_iter()
                .map(|row| {
                    let platform = row.get::<_, String>("platform");
                    let counts = OtaDownloadInsightCounts {
                        started: row.get("started"),
                        completed: row.get("completed"),
                        available: row.get("available"),
                        failures: row.get("failures"),
                    };
                    (platform, counts)
                })
                .collect(),
            by_country_rows
                .into_iter()
                .map(|row| {
                    let country = row.get::<_, String>("country_code");
                    let counts = OtaDownloadInsightCounts {
                        started: row.get("started"),
                        completed: row.get("completed"),
                        available: row.get("available"),
                        failures: row.get("failures"),
                    };
                    (country, counts)
                })
                .collect(),
        ))
    }

    async fn register_release(
        &self,
        release: OtaReleaseRecord,
    ) -> Result<OtaReleaseRecord, OtaRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(ota_internal)?;
        let row = connection
            .query_one(
                "insert into ota_releases (
                    release_id, platform, channel, bundle_version, git_sha, native_version,
                    min_supported_native_version, artifact_url, artifact_sha256,
                    artifact_size_bytes, artifact_type, signature, rollout_percentage,
                    status, published_at, published_by, notes
                 ) values (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9,
                    $10, $11, $12, $13,
                    $14, $15, $16, $17
                 )
                 on conflict (release_id) do update set
                    platform = excluded.platform,
                    channel = excluded.channel,
                    bundle_version = excluded.bundle_version,
                    git_sha = excluded.git_sha,
                    native_version = excluded.native_version,
                    min_supported_native_version = excluded.min_supported_native_version,
                    artifact_url = excluded.artifact_url,
                    artifact_sha256 = excluded.artifact_sha256,
                    artifact_size_bytes = excluded.artifact_size_bytes,
                    artifact_type = excluded.artifact_type,
                    signature = excluded.signature,
                    rollout_percentage = excluded.rollout_percentage,
                    status = excluded.status,
                    published_at = excluded.published_at,
                    published_by = excluded.published_by,
                    notes = excluded.notes,
                    updated_at = now()
                 returning release_id, platform, channel, bundle_version, git_sha, native_version,
                           min_supported_native_version, artifact_url, artifact_sha256,
                           artifact_size_bytes, artifact_type, signature, rollout_percentage,
                           status, published_at, published_by, notes",
                &[
                    &release.release_id,
                    &release.platform.to_string(),
                    &release.channel,
                    &release.bundle_version,
                    &release.git_sha,
                    &release.native_version,
                    &release.min_supported_native_version,
                    &release.artifact_url,
                    &release.artifact_sha256,
                    &to_i64(release.artifact_size_bytes, "artifact_size_bytes")?,
                    &release.artifact_type,
                    &release.signature,
                    &i32::from(release.rollout_percentage),
                    &release.status.to_string(),
                    &release.published_at,
                    &release.published_by,
                    &release.notes,
                ],
            )
            .await
            .map_err(ota_internal)?;
        map_release_row(row)
    }

    async fn activate_channel(
        &self,
        platform: OtaPlatform,
        channel: String,
        request: ActivateChannelRequest,
    ) -> Result<OtaChannelAssignment, OtaRegistryError> {
        self.ensure_tables().await?;
        let activated_by = normalize_non_empty(&request.activated_by, "activated_by")?;
        let release_id = normalize_non_empty(&request.release_id, "release_id")?;
        let mut connection = self.pool.get().await.map_err(ota_internal)?;
        let transaction = connection.transaction().await.map_err(ota_internal)?;

        let release = load_release_for_update(&transaction, &release_id).await?;
        if release.platform != platform {
            return Err(OtaRegistryError::Invalid(format!(
                "release '{}' targets platform '{}' not '{}'",
                release_id, release.platform, platform
            )));
        }
        if release.channel != channel {
            return Err(OtaRegistryError::Invalid(format!(
                "release '{}' targets channel '{}' not '{}'",
                release_id, release.channel, channel
            )));
        }

        let existing_assignment =
            load_channel_assignment_for_update(&transaction, platform, &channel).await?;
        let previous_release_id = if let Some(existing) = existing_assignment.as_ref() {
            if existing.active_release_id != release_id {
                if let Err(error) = transaction
                    .execute(
                        "update ota_releases
                            set status = 'paused', updated_at = now()
                          where release_id = $1
                            and status = 'live'",
                        &[&existing.active_release_id],
                    )
                    .await
                {
                    return Err(OtaRegistryError::Internal(error.into()));
                }
                Some(existing.active_release_id.clone())
            } else {
                existing.previous_release_id.clone()
            }
        } else {
            None
        };

        let rollout_percentage = request
            .rollout_percentage
            .unwrap_or(release.rollout_percentage);
        transaction
            .execute(
                "update ota_releases
                    set rollout_percentage = $2,
                        status = 'live',
                        updated_at = now()
                  where release_id = $1",
                &[&release_id, &i32::from(rollout_percentage)],
            )
            .await
            .map_err(ota_internal)?;

        let activated_at = Utc::now();
        transaction
            .execute(
                "insert into ota_channel_assignments (
                    platform, channel, active_release_id, previous_release_id,
                    rollout_percentage, activated_at, activated_by
                 ) values ($1, $2, $3, $4, $5, $6, $7)
                 on conflict (platform, channel) do update set
                    active_release_id = excluded.active_release_id,
                    previous_release_id = excluded.previous_release_id,
                    rollout_percentage = excluded.rollout_percentage,
                    activated_at = excluded.activated_at,
                    activated_by = excluded.activated_by",
                &[
                    &platform.to_string(),
                    &channel,
                    &release_id,
                    &previous_release_id,
                    &i32::from(rollout_percentage),
                    &activated_at,
                    &activated_by,
                ],
            )
            .await
            .map_err(ota_internal)?;
        transaction
            .execute(
                "insert into ota_channel_history (
                    history_id, platform, channel, action, previous_release_id,
                    next_release_id, rollout_percentage, activated_at, activated_by
                 ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                &[
                    &Uuid::new_v4().to_string(),
                    &platform.to_string(),
                    &channel,
                    &OtaChannelHistoryAction::Activate.to_string(),
                    &previous_release_id,
                    &release_id,
                    &i32::from(rollout_percentage),
                    &activated_at,
                    &activated_by,
                ],
            )
            .await
            .map_err(ota_internal)?;

        let assignment_row = transaction
            .query_one(
                "select platform, channel, active_release_id, previous_release_id,
                        rollout_percentage, activated_at, activated_by
                   from ota_channel_assignments
                  where platform = $1 and channel = $2",
                &[&platform.to_string(), &channel],
            )
            .await
            .map_err(ota_internal)?;

        transaction.commit().await.map_err(ota_internal)?;
        map_channel_assignment_row(assignment_row)
    }

    async fn rollback_channel(
        &self,
        platform: OtaPlatform,
        channel: String,
        request: RollbackChannelRequest,
    ) -> Result<OtaChannelAssignment, OtaRegistryError> {
        self.ensure_tables().await?;
        let activated_by = normalize_non_empty(&request.activated_by, "activated_by")?;
        let mut connection = self.pool.get().await.map_err(ota_internal)?;
        let transaction = connection.transaction().await.map_err(ota_internal)?;

        let existing_assignment =
            load_channel_assignment_for_update(&transaction, platform, &channel)
                .await?
                .ok_or_else(|| {
                    OtaRegistryError::NotFound("no active release for channel".to_string())
                })?;

        let target_release_id = if let Some(explicit) = request.release_id.as_ref() {
            normalize_non_empty(explicit, "release_id")?
        } else if let Some(previous) = existing_assignment.previous_release_id.as_ref() {
            previous.clone()
        } else {
            return Err(OtaRegistryError::Invalid(
                "rollback requires release_id when no previous release exists".to_string(),
            ));
        };

        let target_release = load_release_for_update(&transaction, &target_release_id).await?;
        if target_release.platform != platform {
            return Err(OtaRegistryError::Invalid(format!(
                "release '{}' targets platform '{}' not '{}'",
                target_release_id, target_release.platform, platform
            )));
        }
        if target_release.channel != channel {
            return Err(OtaRegistryError::Invalid(format!(
                "release '{}' targets channel '{}' not '{}'",
                target_release_id, target_release.channel, channel
            )));
        }

        transaction
            .execute(
                "update ota_releases
                    set status = 'rolled_back', updated_at = now()
                  where release_id = $1",
                &[&existing_assignment.active_release_id],
            )
            .await
            .map_err(ota_internal)?;
        transaction
            .execute(
                "update ota_releases
                    set status = 'live', updated_at = now()
                  where release_id = $1",
                &[&target_release_id],
            )
            .await
            .map_err(ota_internal)?;
        let activated_at = Utc::now();
        transaction
            .execute(
                "insert into ota_channel_assignments (
                    platform, channel, active_release_id, previous_release_id,
                    rollout_percentage, activated_at, activated_by
                 ) values ($1, $2, $3, $4, $5, $6, $7)
                 on conflict (platform, channel) do update set
                    active_release_id = excluded.active_release_id,
                    previous_release_id = excluded.previous_release_id,
                    rollout_percentage = excluded.rollout_percentage,
                    activated_at = excluded.activated_at,
                    activated_by = excluded.activated_by",
                &[
                    &platform.to_string(),
                    &channel,
                    &target_release_id,
                    &Some(existing_assignment.active_release_id.clone()),
                    &i32::from(target_release.rollout_percentage),
                    &activated_at,
                    &activated_by,
                ],
            )
            .await
            .map_err(ota_internal)?;
        transaction
            .execute(
                "insert into ota_channel_history (
                    history_id, platform, channel, action, previous_release_id,
                    next_release_id, rollout_percentage, activated_at, activated_by
                 ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
                &[
                    &Uuid::new_v4().to_string(),
                    &platform.to_string(),
                    &channel,
                    &OtaChannelHistoryAction::Rollback.to_string(),
                    &Some(existing_assignment.active_release_id.clone()),
                    &target_release_id,
                    &i32::from(target_release.rollout_percentage),
                    &activated_at,
                    &activated_by,
                ],
            )
            .await
            .map_err(ota_internal)?;

        let assignment_row = transaction
            .query_one(
                "select platform, channel, active_release_id, previous_release_id,
                        rollout_percentage, activated_at, activated_by
                   from ota_channel_assignments
                  where platform = $1 and channel = $2",
                &[&platform.to_string(), &channel],
            )
            .await
            .map_err(ota_internal)?;

        transaction.commit().await.map_err(ota_internal)?;
        map_channel_assignment_row(assignment_row)
    }

    async fn check_for_update(
        &self,
        request: OtaCheckRequest,
    ) -> Result<OtaCheckResponse, OtaRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(ota_internal)?;
        let joined = connection
            .query_opt(
                "select r.release_id, r.platform, r.channel, r.bundle_version, r.git_sha,
                        r.native_version, r.min_supported_native_version, r.artifact_url,
                        r.artifact_sha256, r.artifact_size_bytes, r.artifact_type,
                        r.signature, r.rollout_percentage, r.status, r.published_at,
                        r.published_by, r.notes, a.rollout_percentage as assignment_rollout
                   from ota_channel_assignments a
                   join ota_releases r on r.release_id = a.active_release_id
                  where a.platform = $1 and a.channel = $2",
                &[&request.platform.to_string(), &request.channel],
            )
            .await
            .map_err(ota_internal)?;

        let now = Utc::now();
        let response = if let Some(row) = joined {
            let release = map_release_row(row.clone())?;
            let rollout_percentage = row.get::<_, i32>("assignment_rollout").clamp(0, 100) as u8;
            if !version_is_compatible(
                &request.native_version,
                &release.min_supported_native_version,
            ) {
                OtaCheckResponse::not_available("native_version_too_old")
            } else if request
                .current_bundle_version
                .as_ref()
                .is_some_and(|value| value == &release.bundle_version)
                || request
                    .current_git_sha
                    .as_ref()
                    .is_some_and(|value| value == &release.git_sha)
            {
                OtaCheckResponse::not_available("already_active")
            } else if !device_is_in_rollout(
                &request.device_id,
                &release.release_id,
                rollout_percentage,
            ) {
                OtaCheckResponse::not_available("rollout_excluded")
            } else {
                OtaCheckResponse {
                    update_available: true,
                    reason: "update_available".to_string(),
                    release_id: Some(release.release_id.clone()),
                    bundle_version: Some(release.bundle_version.clone()),
                    git_sha: Some(release.git_sha.clone()),
                    artifact_url: Some(release.artifact_url.clone()),
                    artifact_sha256: Some(release.artifact_sha256.clone()),
                    artifact_size_bytes: Some(release.artifact_size_bytes),
                    artifact_type: Some(release.artifact_type.clone()),
                    signature: release.signature.clone(),
                    rollout_percentage: Some(rollout_percentage),
                }
            }
        } else {
            OtaCheckResponse::not_available("channel_not_configured")
        };

        connection
            .execute(
                "insert into ota_device_states (
                    platform, channel, device_id, native_version, current_bundle_version,
                    current_git_sha, last_seen_at, last_check_at, last_event_type,
                    last_event_at, last_release_id, last_session_id, last_user_id,
                    last_space_id
                 ) values (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9,
                    $10, $11, $12, $13,
                    $14
                 )
                 on conflict (platform, channel, device_id) do update set
                    native_version = excluded.native_version,
                    current_bundle_version = excluded.current_bundle_version,
                    current_git_sha = excluded.current_git_sha,
                    last_seen_at = excluded.last_seen_at,
                    last_check_at = excluded.last_check_at,
                    last_event_type = excluded.last_event_type,
                    last_event_at = excluded.last_event_at,
                    last_release_id = excluded.last_release_id,
                    last_session_id = excluded.last_session_id,
                    last_user_id = excluded.last_user_id,
                    last_space_id = excluded.last_space_id,
                    updated_at = now()",
                &[
                    &request.platform.to_string(),
                    &request.channel,
                    &request.device_id,
                    &request.native_version,
                    &request.current_bundle_version,
                    &request.current_git_sha,
                    &now,
                    &Some(now),
                    &Some(if response.update_available {
                        OtaEventType::UpdateAvailable.to_string()
                    } else {
                        OtaEventType::UpdateNotAvailable.to_string()
                    }),
                    &Some(now),
                    &response.release_id,
                    &Option::<String>::None,
                    &Option::<String>::None,
                    &Option::<String>::None,
                ],
            )
            .await
            .map_err(ota_internal)?;

        Ok(response)
    }

    async fn record_event(
        &self,
        event: OtaUpdateEvent,
    ) -> Result<OtaUpdateEvent, OtaRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(ota_internal)?;
        let release_id = if let Some(bundle_version) = event.bundle_version.as_ref() {
            connection
                .query_opt(
                    "select release_id
                       from ota_releases
                      where platform = $1 and channel = $2 and bundle_version = $3
                   order by published_at desc
                      limit 1",
                    &[&event.platform.to_string(), &event.channel, bundle_version],
                )
                .await
                .map_err(ota_internal)?
                .map(|row| row.get::<_, String>("release_id"))
        } else {
            None
        };

        connection
            .execute(
                "insert into ota_events (
                    event_id, event_type, occurred_at, device_id, platform, channel,
                    native_version, bundle_version, git_sha, space_id, user_id,
                    session_id, country_code, properties
                 ) values (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11,
                    $12, $13, $14
                 )
                 on conflict (event_id) do update set
                    event_type = excluded.event_type,
                    occurred_at = excluded.occurred_at,
                    device_id = excluded.device_id,
                    platform = excluded.platform,
                    channel = excluded.channel,
                    native_version = excluded.native_version,
                    bundle_version = excluded.bundle_version,
                    git_sha = excluded.git_sha,
                    space_id = excluded.space_id,
                    user_id = excluded.user_id,
                    session_id = excluded.session_id,
                    country_code = excluded.country_code,
                    properties = excluded.properties",
                &[
                    &event.event_id,
                    &event.event_type.to_string(),
                    &event.occurred_at,
                    &event.device_id,
                    &event.platform.to_string(),
                    &event.channel,
                    &event.native_version,
                    &event.bundle_version,
                    &event.git_sha,
                    &event.space_id,
                    &event.user_id,
                    &event.session_id,
                    &event.country_code,
                    &PgJson(properties_to_json(&event.properties)),
                ],
            )
            .await
            .map_err(ota_internal)?;
        prune_recent_events(&connection).await?;

        connection
            .execute(
                "insert into ota_device_states (
                    platform, channel, device_id, native_version, current_bundle_version,
                    current_git_sha, last_seen_at, last_check_at, last_event_type,
                    last_event_at, last_release_id, last_session_id, last_user_id,
                    last_space_id
                 ) values (
                    $1, $2, $3, $4, $5,
                    $6, $7, $8, $9,
                    $10, $11, $12, $13,
                    $14
                 )
                 on conflict (platform, channel, device_id) do update set
                    native_version = excluded.native_version,
                    current_bundle_version = coalesce(excluded.current_bundle_version, ota_device_states.current_bundle_version),
                    current_git_sha = coalesce(excluded.current_git_sha, ota_device_states.current_git_sha),
                    last_seen_at = excluded.last_seen_at,
                    last_event_type = excluded.last_event_type,
                    last_event_at = excluded.last_event_at,
                    last_release_id = coalesce(excluded.last_release_id, ota_device_states.last_release_id),
                    last_session_id = excluded.last_session_id,
                    last_user_id = excluded.last_user_id,
                    last_space_id = excluded.last_space_id,
                    updated_at = now()",
                &[
                    &event.platform.to_string(),
                    &event.channel,
                    &event.device_id,
                    &event.native_version,
                    &event.bundle_version,
                    &event.git_sha,
                    &event.occurred_at,
                    &Option::<DateTime<Utc>>::None,
                    &Some(event.event_type.to_string()),
                    &Some(event.occurred_at),
                    &release_id,
                    &event.session_id,
                    &event.user_id,
                    &event.space_id,
                ],
            )
            .await
            .map_err(ota_internal)?;

        Ok(event)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(default)]
struct OtaRegistrySnapshot {
    releases: BTreeMap<String, OtaReleaseRecord>,
    channels: BTreeMap<String, OtaChannelAssignment>,
    device_states: BTreeMap<String, OtaDeviceState>,
    recent_events: Vec<OtaUpdateEvent>,
    channel_history: Vec<OtaChannelHistoryEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum OtaPlatform {
    Ios,
    Android,
}

impl fmt::Display for OtaPlatform {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ios => f.write_str("ios"),
            Self::Android => f.write_str("android"),
        }
    }
}

impl FromStr for OtaPlatform {
    type Err = OtaRegistryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "ios" => Ok(Self::Ios),
            "android" => Ok(Self::Android),
            _ => Err(OtaRegistryError::Invalid(
                "platform must be one of ios or android".to_string(),
            )),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OtaReleaseStatus {
    Draft,
    Live,
    Paused,
    RolledBack,
    Archived,
}

impl fmt::Display for OtaReleaseStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Draft => f.write_str("draft"),
            Self::Live => f.write_str("live"),
            Self::Paused => f.write_str("paused"),
            Self::RolledBack => f.write_str("rolled_back"),
            Self::Archived => f.write_str("archived"),
        }
    }
}

impl FromStr for OtaReleaseStatus {
    type Err = OtaRegistryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "draft" => Ok(Self::Draft),
            "live" => Ok(Self::Live),
            "paused" => Ok(Self::Paused),
            "rolled_back" => Ok(Self::RolledBack),
            "archived" => Ok(Self::Archived),
            _ => Err(OtaRegistryError::Invalid(format!(
                "invalid release status '{}'",
                value
            ))),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OtaChannelHistoryAction {
    Activate,
    Rollback,
}

impl fmt::Display for OtaChannelHistoryAction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Activate => f.write_str("activate"),
            Self::Rollback => f.write_str("rollback"),
        }
    }
}

impl FromStr for OtaChannelHistoryAction {
    type Err = OtaRegistryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "activate" => Ok(Self::Activate),
            "rollback" => Ok(Self::Rollback),
            _ => Err(OtaRegistryError::Invalid(format!(
                "invalid channel history action '{}'",
                value
            ))),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct OtaChannelHistoryEntry {
    pub(crate) history_id: String,
    pub(crate) platform: OtaPlatform,
    pub(crate) channel: String,
    pub(crate) action: OtaChannelHistoryAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) previous_release_id: Option<String>,
    pub(crate) next_release_id: String,
    pub(crate) rollout_percentage: u8,
    pub(crate) activated_at: DateTime<Utc>,
    pub(crate) activated_by: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum OtaEventType {
    UpdateCheckRequested,
    UpdateAvailable,
    UpdateNotAvailable,
    DownloadStarted,
    DownloadCompleted,
    DownloadFailed,
    InstallStarted,
    InstallCompleted,
    InstallFailed,
    AppReloaded,
    RollbackTriggered,
    SessionStarted,
    SessionEnded,
    UsageHeartbeat,
}

impl fmt::Display for OtaEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UpdateCheckRequested => f.write_str("update_check_requested"),
            Self::UpdateAvailable => f.write_str("update_available"),
            Self::UpdateNotAvailable => f.write_str("update_not_available"),
            Self::DownloadStarted => f.write_str("download_started"),
            Self::DownloadCompleted => f.write_str("download_completed"),
            Self::DownloadFailed => f.write_str("download_failed"),
            Self::InstallStarted => f.write_str("install_started"),
            Self::InstallCompleted => f.write_str("install_completed"),
            Self::InstallFailed => f.write_str("install_failed"),
            Self::AppReloaded => f.write_str("app_reloaded"),
            Self::RollbackTriggered => f.write_str("rollback_triggered"),
            Self::SessionStarted => f.write_str("session_started"),
            Self::SessionEnded => f.write_str("session_ended"),
            Self::UsageHeartbeat => f.write_str("usage_heartbeat"),
        }
    }
}

impl FromStr for OtaEventType {
    type Err = OtaRegistryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "update_check_requested" => Ok(Self::UpdateCheckRequested),
            "update_available" => Ok(Self::UpdateAvailable),
            "update_not_available" => Ok(Self::UpdateNotAvailable),
            "download_started" => Ok(Self::DownloadStarted),
            "download_completed" => Ok(Self::DownloadCompleted),
            "download_failed" => Ok(Self::DownloadFailed),
            "install_started" => Ok(Self::InstallStarted),
            "install_completed" => Ok(Self::InstallCompleted),
            "install_failed" => Ok(Self::InstallFailed),
            "app_reloaded" => Ok(Self::AppReloaded),
            "rollback_triggered" => Ok(Self::RollbackTriggered),
            "session_started" => Ok(Self::SessionStarted),
            "session_ended" => Ok(Self::SessionEnded),
            "usage_heartbeat" => Ok(Self::UsageHeartbeat),
            _ => Err(OtaRegistryError::Invalid(format!(
                "invalid event type '{}'",
                value
            ))),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct OtaReleaseRecord {
    pub(crate) release_id: String,
    pub(crate) platform: OtaPlatform,
    pub(crate) channel: String,
    pub(crate) bundle_version: String,
    pub(crate) git_sha: String,
    pub(crate) native_version: String,
    pub(crate) min_supported_native_version: String,
    pub(crate) artifact_url: String,
    pub(crate) artifact_sha256: String,
    pub(crate) artifact_size_bytes: u64,
    pub(crate) artifact_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) signature: Option<String>,
    pub(crate) rollout_percentage: u8,
    pub(crate) status: OtaReleaseStatus,
    pub(crate) published_at: DateTime<Utc>,
    pub(crate) published_by: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) notes: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct OtaChannelAssignment {
    pub(crate) platform: OtaPlatform,
    pub(crate) channel: String,
    pub(crate) active_release_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) previous_release_id: Option<String>,
    pub(crate) rollout_percentage: u8,
    pub(crate) activated_at: DateTime<Utc>,
    pub(crate) activated_by: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct OtaDeviceState {
    pub(crate) device_id: String,
    pub(crate) platform: OtaPlatform,
    pub(crate) channel: String,
    pub(crate) native_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) current_bundle_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) current_git_sha: Option<String>,
    pub(crate) last_seen_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_check_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_event_type: Option<OtaEventType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_event_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_release_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_space_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct OtaUpdateEvent {
    pub(crate) event_id: String,
    pub(crate) event_type: OtaEventType,
    pub(crate) occurred_at: DateTime<Utc>,
    pub(crate) device_id: String,
    pub(crate) platform: OtaPlatform,
    pub(crate) channel: String,
    pub(crate) native_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bundle_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) git_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) space_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) country_code: Option<String>,
    #[serde(default)]
    pub(crate) properties: BTreeMap<String, JsonValue>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OtaDownloadInsightCounts {
    pub(crate) started: i64,
    pub(crate) completed: i64,
    pub(crate) available: i64,
    pub(crate) failures: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OtaDownloadInsightDay {
    pub(crate) day: String,
    #[serde(flatten)]
    pub(crate) counts: OtaDownloadInsightCounts,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OtaDownloadInsightBreakdown {
    pub(crate) key: String,
    pub(crate) label: String,
    #[serde(flatten)]
    pub(crate) counts: OtaDownloadInsightCounts,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OtaDownloadInsights {
    pub(crate) days: i64,
    pub(crate) range_start: String,
    pub(crate) range_end: String,
    pub(crate) totals: OtaDownloadInsightCounts,
    pub(crate) daily: Vec<OtaDownloadInsightDay>,
    pub(crate) by_channel: Vec<OtaDownloadInsightBreakdown>,
    pub(crate) by_platform: Vec<OtaDownloadInsightBreakdown>,
    pub(crate) by_country: Vec<OtaDownloadInsightBreakdown>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct OtaCheckRequest {
    pub(crate) device_id: String,
    pub(crate) platform: OtaPlatform,
    pub(crate) channel: String,
    pub(crate) native_version: String,
    #[serde(default)]
    pub(crate) current_bundle_version: Option<String>,
    #[serde(default)]
    pub(crate) current_git_sha: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct OtaCheckResponse {
    pub(crate) update_available: bool,
    pub(crate) reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) release_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) bundle_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) git_sha: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) artifact_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) artifact_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) artifact_size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) artifact_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rollout_percentage: Option<u8>,
}

impl OtaCheckResponse {
    fn not_available(reason: &str) -> Self {
        Self {
            update_available: false,
            reason: reason.to_string(),
            release_id: None,
            bundle_version: None,
            git_sha: None,
            artifact_url: None,
            artifact_sha256: None,
            artifact_size_bytes: None,
            artifact_type: None,
            signature: None,
            rollout_percentage: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct ActivateChannelRequest {
    release_id: String,
    #[serde(default)]
    rollout_percentage: Option<u8>,
    activated_by: String,
}

#[derive(Debug, Deserialize)]
struct RollbackChannelRequest {
    #[serde(default)]
    release_id: Option<String>,
    activated_by: String,
}

#[derive(Debug)]
pub(crate) enum OtaRegistryError {
    Invalid(String),
    NotFound(String),
    Internal(anyhow::Error),
}

impl OtaRegistryError {
    fn into_response(self) -> (StatusCode, Json<ApiError>) {
        match self {
            Self::Invalid(message) => bad_request(message),
            Self::NotFound(message) => not_found(message),
            Self::Internal(error) => internal_error(format!("ota registry error: {error}")),
        }
    }
}

fn ota_internal<E>(error: E) -> OtaRegistryError
where
    E: Into<anyhow::Error>,
{
    OtaRegistryError::Internal(error.into())
}

async fn list_releases(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<OtaReleaseRecord>>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    Ok(Json(
        state
            .ota_registry
            .list_releases()
            .await
            .map_err(OtaRegistryError::into_response)?,
    ))
}

async fn register_release(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(release): Json<OtaReleaseRecord>,
) -> Result<(StatusCode, Json<OtaReleaseRecord>), (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let stored = state
        .ota_registry
        .register_release(release)
        .await
        .map_err(OtaRegistryError::into_response)?;
    Ok((StatusCode::CREATED, Json(stored)))
}

async fn list_channels(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<OtaChannelAssignment>>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    Ok(Json(
        state
            .ota_registry
            .list_channels()
            .await
            .map_err(OtaRegistryError::into_response)?,
    ))
}

async fn list_channel_history(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
    AxumPath((platform, channel)): AxumPath<(String, String)>,
) -> Result<Json<Vec<OtaChannelHistoryEntry>>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let platform = OtaPlatform::from_str(&platform).map_err(OtaRegistryError::into_response)?;
    let channel = normalize_channel(&channel).map_err(OtaRegistryError::into_response)?;
    let limit = parse_channel_history_limit(&uri).map_err(OtaRegistryError::into_response)?;
    Ok(Json(
        state
            .ota_registry
            .list_channel_history(platform, channel, limit)
            .await
            .map_err(OtaRegistryError::into_response)?,
    ))
}

async fn activate_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((platform, channel)): AxumPath<(String, String)>,
    Json(body): Json<ActivateChannelRequest>,
) -> Result<Json<OtaChannelAssignment>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let platform = OtaPlatform::from_str(&platform).map_err(OtaRegistryError::into_response)?;
    let channel = normalize_channel(&channel).map_err(OtaRegistryError::into_response)?;
    let assignment = state
        .ota_registry
        .activate_channel(platform, channel, body)
        .await
        .map_err(OtaRegistryError::into_response)?;
    Ok(Json(assignment))
}

async fn rollback_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath((platform, channel)): AxumPath<(String, String)>,
    Json(body): Json<RollbackChannelRequest>,
) -> Result<Json<OtaChannelAssignment>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let platform = OtaPlatform::from_str(&platform).map_err(OtaRegistryError::into_response)?;
    let channel = normalize_channel(&channel).map_err(OtaRegistryError::into_response)?;
    let assignment = state
        .ota_registry
        .rollback_channel(platform, channel, body)
        .await
        .map_err(OtaRegistryError::into_response)?;
    Ok(Json(assignment))
}

async fn list_device_states(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Json<Vec<OtaDeviceState>>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let params = parse_device_state_list_params(&uri).map_err(OtaRegistryError::into_response)?;
    Ok(Json(
        state
            .ota_registry
            .list_device_states(params)
            .await
            .map_err(OtaRegistryError::into_response)?,
    ))
}

async fn list_events(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Json<Vec<OtaUpdateEvent>>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let params = parse_event_list_params(&uri).map_err(OtaRegistryError::into_response)?;
    Ok(Json(
        state
            .ota_registry
            .list_events(params)
            .await
            .map_err(OtaRegistryError::into_response)?,
    ))
}

async fn get_download_insights(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Json<OtaDownloadInsights>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let params = parse_download_insights_params(&uri).map_err(OtaRegistryError::into_response)?;
    Ok(Json(
        state
            .ota_registry
            .get_download_insights(params)
            .await
            .map_err(OtaRegistryError::into_response)?,
    ))
}

async fn check_for_update(
    State(state): State<AppState>,
    Json(request): Json<OtaCheckRequest>,
) -> Result<Json<OtaCheckResponse>, (StatusCode, Json<ApiError>)> {
    let response = state
        .ota_registry
        .check_for_update(request)
        .await
        .map_err(OtaRegistryError::into_response)?;
    Ok(Json(response))
}

async fn post_update_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut event): Json<OtaUpdateEvent>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    event.country_code = extract_country_code_from_headers(&headers);
    state
        .ota_registry
        .record_event(event)
        .await
        .map_err(OtaRegistryError::into_response)?;
    Ok(StatusCode::ACCEPTED)
}

pub(crate) async fn require_operator_access(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<RequestContext, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, headers).await?;
    if context.is_service_role {
        return Ok(context);
    }

    let user_id =
        require_user_session(&context).map_err(|_| forbidden("operator session required"))?;

    if state
        .config
        .operator_console_allowed_user_ids
        .iter()
        .any(|allowed| *allowed == user_id)
    {
        return Ok(context);
    }

    let Some(operator_org_id) = state.config.operator_console_org_id else {
        return Err(forbidden(
            "operator access is not configured; set OPERATOR_CONSOLE_ORG_ID or OPERATOR_CONSOLE_ALLOWED_USER_IDS",
        ));
    };

    let connection = state.pool.get().await.map_err(|error| {
        internal_error(format!(
            "failed to check operator access against organization membership: {error}"
        ))
    })?;

    let row = connection
        .query_opt(
            "select role from org_memberships where org_id = $1 and user_id = $2",
            &[&operator_org_id, &user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load operator organization membership: {error}"
            ))
        })?;

    let Some(row) = row else {
        return Err(forbidden(
            "operator access requires membership in the configured internal organization",
        ));
    };

    let role: String = row.get("role");
    if role != "owner" && role != "admin" {
        return Err(forbidden(
            "operator access requires owner or admin role in the configured internal organization",
        ));
    }
    Ok(context)
}

fn parse_device_state_list_params(
    uri: &Uri,
) -> Result<ResolvedDeviceStateListParams, OtaRegistryError> {
    let params = parse_query_map(uri)?;
    Ok(ResolvedDeviceStateListParams {
        limit: clamp_list_limit(
            parse_i64_param(&params, "limit")?,
            DEFAULT_LIST_DEVICE_STATES_LIMIT,
            MAX_LIST_DEVICE_STATES_LIMIT,
        )?,
        platform: params
            .get("platform")
            .map(String::as_str)
            .map(OtaPlatform::from_str)
            .transpose()?,
        channel: params
            .get("channel")
            .map(String::as_str)
            .map(normalize_channel)
            .transpose()?,
        query: normalize_optional_query(params.get("query").cloned()),
        attention_only: parse_bool_param(&params, "attention_only")?.unwrap_or(false),
        before_seen_at: params
            .get("before_seen_at")
            .map(String::as_str)
            .map(parse_utc_timestamp)
            .transpose()?,
    })
}

fn parse_event_list_params(uri: &Uri) -> Result<ResolvedEventListParams, OtaRegistryError> {
    let params = parse_query_map(uri)?;
    Ok(ResolvedEventListParams {
        limit: clamp_list_limit(
            parse_i64_param(&params, "limit")?,
            DEFAULT_LIST_EVENTS_LIMIT,
            MAX_LIST_EVENTS_LIMIT,
        )?,
        platform: params
            .get("platform")
            .map(String::as_str)
            .map(OtaPlatform::from_str)
            .transpose()?,
        channel: params
            .get("channel")
            .map(String::as_str)
            .map(normalize_channel)
            .transpose()?,
        event_type: params
            .get("event_type")
            .map(String::as_str)
            .map(OtaEventType::from_str)
            .transpose()?,
        query: normalize_optional_query(params.get("query").cloned()),
        before_occurred_at: params
            .get("before_occurred_at")
            .map(String::as_str)
            .map(parse_utc_timestamp)
            .transpose()?,
    })
}

fn parse_download_insights_params(
    uri: &Uri,
) -> Result<ResolvedDownloadInsightsParams, OtaRegistryError> {
    let params = parse_query_map(uri)?;
    Ok(ResolvedDownloadInsightsParams {
        days: clamp_list_limit(
            parse_i64_param(&params, "days")?,
            DEFAULT_DOWNLOAD_INSIGHTS_DAYS,
            MAX_DOWNLOAD_INSIGHTS_DAYS,
        )?,
        platform: params
            .get("platform")
            .map(String::as_str)
            .map(OtaPlatform::from_str)
            .transpose()?,
        channel: params
            .get("channel")
            .map(String::as_str)
            .map(normalize_channel)
            .transpose()?,
    })
}

fn parse_channel_history_limit(uri: &Uri) -> Result<i64, OtaRegistryError> {
    let params = parse_query_map(uri)?;
    clamp_list_limit(
        parse_i64_param(&params, "limit")?,
        DEFAULT_LIST_CHANNEL_HISTORY_LIMIT,
        MAX_LIST_CHANNEL_HISTORY_LIMIT,
    )
}

fn parse_query_map(uri: &Uri) -> Result<BTreeMap<String, String>, OtaRegistryError> {
    let mut values = BTreeMap::new();
    let Some(query) = uri.query() else {
        return Ok(values);
    };
    for pair in query.split('&').filter(|segment| !segment.is_empty()) {
        let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        let key = decode_query_component(raw_key)?;
        let value = decode_query_component(raw_value)?;
        values.insert(key, value);
    }
    Ok(values)
}

fn decode_query_component(value: &str) -> Result<String, OtaRegistryError> {
    urlencoding::decode(value)
        .map(|decoded| decoded.into_owned())
        .map_err(|error| {
            OtaRegistryError::Invalid(format!("invalid query string encoding: {error}"))
        })
}

fn parse_i64_param(
    params: &BTreeMap<String, String>,
    key: &str,
) -> Result<Option<i64>, OtaRegistryError> {
    params
        .get(key)
        .map(|value| {
            value.parse::<i64>().map_err(|error| {
                OtaRegistryError::Invalid(format!("{key} must be an integer: {error}"))
            })
        })
        .transpose()
}

fn parse_bool_param(
    params: &BTreeMap<String, String>,
    key: &str,
) -> Result<Option<bool>, OtaRegistryError> {
    let Some(value) = params.get(key) else {
        return Ok(None);
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" => Ok(Some(true)),
        "0" | "false" | "no" => Ok(Some(false)),
        _ => Err(OtaRegistryError::Invalid(format!(
            "{key} must be true or false"
        ))),
    }
}

fn clamp_list_limit(
    limit: Option<i64>,
    default_limit: i64,
    max_limit: i64,
) -> Result<i64, OtaRegistryError> {
    let limit = limit.unwrap_or(default_limit);
    if limit <= 0 {
        return Err(OtaRegistryError::Invalid(
            "limit must be greater than 0".to_string(),
        ));
    }
    Ok(limit.min(max_limit))
}

fn normalize_optional_query(query: Option<String>) -> Option<String> {
    query.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn parse_utc_timestamp(value: &str) -> Result<DateTime<Utc>, OtaRegistryError> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|error| {
            OtaRegistryError::Invalid(format!("invalid RFC3339 timestamp '{value}': {error}"))
        })
}

fn resolve_download_window(
    days: i64,
) -> Result<(NaiveDate, NaiveDate, DateTime<Utc>, DateTime<Utc>), OtaRegistryError> {
    if days <= 0 {
        return Err(OtaRegistryError::Invalid(
            "days must be greater than 0".to_string(),
        ));
    }
    let end_day = Utc::now().date_naive();
    let start_day = end_day - Duration::days(days - 1);
    let start_at = start_day
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| OtaRegistryError::Invalid("invalid insight start day".to_string()))?
        .and_utc();
    let end_exclusive = (end_day + Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| OtaRegistryError::Invalid("invalid insight end day".to_string()))?
        .and_utc();
    Ok((start_day, end_day, start_at, end_exclusive))
}

fn build_download_insight_query_parts(
    params: &ResolvedDownloadInsightsParams,
    start_at: DateTime<Utc>,
    end_exclusive: DateTime<Utc>,
) -> (Vec<String>, Vec<Box<dyn ToSql + Sync + Send>>) {
    let mut clauses = vec![
        "occurred_at >= $1".to_string(),
        "occurred_at < $2".to_string(),
        "event_type in ('update_available', 'download_started', 'download_completed', 'download_failed', 'install_failed', 'rollback_triggered')".to_string(),
    ];
    let mut bindings: Vec<Box<dyn ToSql + Sync + Send>> =
        vec![Box::new(start_at), Box::new(end_exclusive)];
    if let Some(platform) = params.platform {
        bindings.push(Box::new(platform.to_string()));
        clauses.push(format!("platform = ${}", bindings.len()));
    }
    if let Some(channel) = &params.channel {
        bindings.push(Box::new(channel.clone()));
        clauses.push(format!("channel = ${}", bindings.len()));
    }
    (clauses, bindings)
}

fn build_download_insights_from_events(
    events: &[OtaUpdateEvent],
    params: ResolvedDownloadInsightsParams,
) -> Result<OtaDownloadInsights, OtaRegistryError> {
    let (start_day, end_day, start_at, end_exclusive) = resolve_download_window(params.days)?;
    let mut by_day = BTreeMap::<NaiveDate, OtaDownloadInsightCounts>::new();
    let mut by_channel = BTreeMap::<String, OtaDownloadInsightCounts>::new();
    let mut by_platform = BTreeMap::<String, OtaDownloadInsightCounts>::new();
    let mut by_country = BTreeMap::<String, OtaDownloadInsightCounts>::new();

    for event in events {
        if event.occurred_at < start_at || event.occurred_at >= end_exclusive {
            continue;
        }
        if let Some(platform) = params.platform {
            if event.platform != platform {
                continue;
            }
        }
        if let Some(channel) = &params.channel {
            if &event.channel != channel {
                continue;
            }
        }

        let day = event.occurred_at.date_naive();
        let channel_counts = by_channel.entry(event.channel.clone()).or_default();
        let platform_counts = by_platform.entry(event.platform.to_string()).or_default();
        let country_counts = by_country
            .entry(
                event
                    .country_code
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("unknown")
                    .to_string(),
            )
            .or_default();
        let day_counts = by_day.entry(day).or_default();
        for counts in [day_counts, channel_counts, platform_counts, country_counts] {
            match event.event_type {
                OtaEventType::DownloadStarted => counts.started += 1,
                OtaEventType::DownloadCompleted => counts.completed += 1,
                OtaEventType::UpdateAvailable => counts.available += 1,
                OtaEventType::DownloadFailed
                | OtaEventType::InstallFailed
                | OtaEventType::RollbackTriggered => counts.failures += 1,
                _ => {}
            }
        }
    }

    Ok(build_download_insights_response(
        params,
        start_day,
        end_day,
        by_day.into_iter().collect(),
        by_channel.into_iter().collect(),
        by_platform.into_iter().collect(),
        by_country.into_iter().collect(),
    ))
}

fn build_download_insights_response(
    params: ResolvedDownloadInsightsParams,
    start_day: NaiveDate,
    end_day: NaiveDate,
    daily_rows: Vec<(NaiveDate, OtaDownloadInsightCounts)>,
    mut by_channel_rows: Vec<(String, OtaDownloadInsightCounts)>,
    mut by_platform_rows: Vec<(String, OtaDownloadInsightCounts)>,
    mut by_country_rows: Vec<(String, OtaDownloadInsightCounts)>,
) -> OtaDownloadInsights {
    let daily_map = daily_rows.into_iter().collect::<BTreeMap<_, _>>();
    let mut daily = Vec::new();
    let mut totals = OtaDownloadInsightCounts::default();
    let mut cursor = start_day;
    while cursor <= end_day {
        let counts = daily_map.get(&cursor).cloned().unwrap_or_default();
        totals.started += counts.started;
        totals.completed += counts.completed;
        totals.available += counts.available;
        totals.failures += counts.failures;
        daily.push(OtaDownloadInsightDay {
            day: cursor.to_string(),
            counts,
        });
        cursor += Duration::days(1);
    }

    by_channel_rows.sort_by(|left, right| left.0.cmp(&right.0));
    by_platform_rows.sort_by(|left, right| {
        right
            .1
            .started
            .cmp(&left.1.started)
            .then(right.1.completed.cmp(&left.1.completed))
            .then(left.0.cmp(&right.0))
    });
    by_country_rows.sort_by(|left, right| {
        right
            .1
            .started
            .cmp(&left.1.started)
            .then(right.1.completed.cmp(&left.1.completed))
            .then(left.0.cmp(&right.0))
    });

    OtaDownloadInsights {
        days: params.days,
        range_start: start_day.to_string(),
        range_end: end_day.to_string(),
        totals,
        daily,
        by_channel: by_channel_rows
            .into_iter()
            .map(|(key, counts)| OtaDownloadInsightBreakdown {
                label: key.clone(),
                key,
                counts,
            })
            .collect(),
        by_platform: by_platform_rows
            .into_iter()
            .map(|(key, counts)| OtaDownloadInsightBreakdown {
                label: key.clone(),
                key,
                counts,
            })
            .collect(),
        by_country: by_country_rows
            .into_iter()
            .map(|(key, counts)| OtaDownloadInsightBreakdown {
                label: key.clone(),
                key,
                counts,
            })
            .collect(),
    }
}

fn device_matches_filters(device: &OtaDeviceState, params: &ResolvedDeviceStateListParams) -> bool {
    if let Some(platform) = &params.platform {
        if &device.platform != platform {
            return false;
        }
    }
    if let Some(channel) = &params.channel {
        if &device.channel != channel {
            return false;
        }
    }
    if let Some(before_seen_at) = params.before_seen_at {
        if device.last_seen_at >= before_seen_at {
            return false;
        }
    }
    if params.attention_only && !device_attention(device) {
        return false;
    }
    if let Some(query) = &params.query {
        let lower = query.to_lowercase();
        if ![
            device.device_id.as_str(),
            device.channel.as_str(),
            device.current_bundle_version.as_deref().unwrap_or_default(),
            device.current_git_sha.as_deref().unwrap_or_default(),
            device.last_user_id.as_deref().unwrap_or_default(),
        ]
        .iter()
        .any(|value| value.to_lowercase().contains(&lower))
        {
            return false;
        }
    }
    true
}

fn event_matches_filters(event: &OtaUpdateEvent, params: &ResolvedEventListParams) -> bool {
    if let Some(platform) = &params.platform {
        if &event.platform != platform {
            return false;
        }
    }
    if let Some(channel) = &params.channel {
        if &event.channel != channel {
            return false;
        }
    }
    if let Some(event_type) = &params.event_type {
        if &event.event_type != event_type {
            return false;
        }
    }
    if let Some(before_occurred_at) = params.before_occurred_at {
        if event.occurred_at >= before_occurred_at {
            return false;
        }
    }
    if let Some(query) = &params.query {
        let lower = query.to_lowercase();
        if ![
            event.event_type.to_string(),
            event.device_id.clone(),
            event.channel.clone(),
            event.bundle_version.clone().unwrap_or_default(),
            event.session_id.clone().unwrap_or_default(),
        ]
        .iter()
        .any(|value| value.to_lowercase().contains(&lower))
        {
            return false;
        }
    }
    true
}

fn device_attention(device: &OtaDeviceState) -> bool {
    matches!(
        device.last_event_type,
        None | Some(OtaEventType::DownloadFailed)
            | Some(OtaEventType::InstallFailed)
            | Some(OtaEventType::RollbackTriggered)
    ) || device.current_bundle_version.is_none()
}

async fn activate_channel_in_memory(
    store: &Arc<RwLock<OtaRegistrySnapshot>>,
    platform: OtaPlatform,
    channel: String,
    request: ActivateChannelRequest,
) -> Result<OtaChannelAssignment, OtaRegistryError> {
    let activated_by = normalize_non_empty(&request.activated_by, "activated_by")?;
    let release_id = normalize_non_empty(&request.release_id, "release_id")?;
    let mut guard = store.write().await;
    let release = guard.releases.get(&release_id).cloned().ok_or_else(|| {
        OtaRegistryError::NotFound(format!("unknown release_id '{}'", release_id))
    })?;
    if release.platform != platform {
        return Err(OtaRegistryError::Invalid(format!(
            "release '{}' targets platform '{}' not '{}'",
            release_id, release.platform, platform
        )));
    }
    if release.channel != channel {
        return Err(OtaRegistryError::Invalid(format!(
            "release '{}' targets channel '{}' not '{}'",
            release_id, release.channel, channel
        )));
    }

    let assignment_key = channel_key(platform, &channel);
    let existing = guard.channels.get(&assignment_key).cloned();
    let previous_release_id = if let Some(existing_assignment) = existing.as_ref() {
        if existing_assignment.active_release_id != release_id {
            if let Some(previous_release) = guard
                .releases
                .get_mut(&existing_assignment.active_release_id)
            {
                if previous_release.status == OtaReleaseStatus::Live {
                    previous_release.status = OtaReleaseStatus::Paused;
                }
            }
            Some(existing_assignment.active_release_id.clone())
        } else {
            existing_assignment.previous_release_id.clone()
        }
    } else {
        None
    };

    let rollout_percentage = request
        .rollout_percentage
        .unwrap_or(release.rollout_percentage);
    if let Some(active_release) = guard.releases.get_mut(&release_id) {
        active_release.rollout_percentage = rollout_percentage;
        active_release.status = OtaReleaseStatus::Live;
    }

    let assignment = OtaChannelAssignment {
        platform,
        channel: channel.clone(),
        active_release_id: release_id,
        previous_release_id,
        rollout_percentage,
        activated_at: Utc::now(),
        activated_by,
    };
    guard.channels.insert(assignment_key, assignment.clone());
    guard.channel_history.push(OtaChannelHistoryEntry {
        history_id: Uuid::new_v4().to_string(),
        platform,
        channel,
        action: OtaChannelHistoryAction::Activate,
        previous_release_id: assignment.previous_release_id.clone(),
        next_release_id: assignment.active_release_id.clone(),
        rollout_percentage: assignment.rollout_percentage,
        activated_at: assignment.activated_at,
        activated_by: assignment.activated_by.clone(),
    });
    if guard.channel_history.len() > MAX_STORED_CHANNEL_HISTORY {
        let overflow = guard.channel_history.len() - MAX_STORED_CHANNEL_HISTORY;
        guard.channel_history.drain(0..overflow);
    }
    Ok(assignment)
}

async fn rollback_channel_in_memory(
    store: &Arc<RwLock<OtaRegistrySnapshot>>,
    platform: OtaPlatform,
    channel: String,
    request: RollbackChannelRequest,
) -> Result<OtaChannelAssignment, OtaRegistryError> {
    let activated_by = normalize_non_empty(&request.activated_by, "activated_by")?;
    let assignment_key = channel_key(platform, &channel);
    let mut guard = store.write().await;
    let existing_assignment = guard
        .channels
        .get(&assignment_key)
        .cloned()
        .ok_or_else(|| OtaRegistryError::NotFound("no active release for channel".to_string()))?;

    let target_release_id = if let Some(explicit) = request.release_id.as_ref() {
        normalize_non_empty(explicit, "release_id")?
    } else if let Some(previous) = existing_assignment.previous_release_id.as_ref() {
        previous.clone()
    } else {
        return Err(OtaRegistryError::Invalid(
            "rollback requires release_id when no previous release exists".to_string(),
        ));
    };

    let target_release = guard
        .releases
        .get(&target_release_id)
        .cloned()
        .ok_or_else(|| {
            OtaRegistryError::NotFound(format!("unknown release_id '{}'", target_release_id))
        })?;
    if target_release.platform != platform {
        return Err(OtaRegistryError::Invalid(format!(
            "release '{}' targets platform '{}' not '{}'",
            target_release_id, target_release.platform, platform
        )));
    }
    if target_release.channel != channel {
        return Err(OtaRegistryError::Invalid(format!(
            "release '{}' targets channel '{}' not '{}'",
            target_release_id, target_release.channel, channel
        )));
    }

    if let Some(current_release) = guard
        .releases
        .get_mut(&existing_assignment.active_release_id)
    {
        current_release.status = OtaReleaseStatus::RolledBack;
    }
    if let Some(restored_release) = guard.releases.get_mut(&target_release_id) {
        restored_release.status = OtaReleaseStatus::Live;
    }

    let assignment = OtaChannelAssignment {
        platform,
        channel: channel.clone(),
        active_release_id: target_release_id,
        previous_release_id: Some(existing_assignment.active_release_id),
        rollout_percentage: target_release.rollout_percentage,
        activated_at: Utc::now(),
        activated_by,
    };
    guard.channels.insert(assignment_key, assignment.clone());
    guard.channel_history.push(OtaChannelHistoryEntry {
        history_id: Uuid::new_v4().to_string(),
        platform,
        channel,
        action: OtaChannelHistoryAction::Rollback,
        previous_release_id: assignment.previous_release_id.clone(),
        next_release_id: assignment.active_release_id.clone(),
        rollout_percentage: assignment.rollout_percentage,
        activated_at: assignment.activated_at,
        activated_by: assignment.activated_by.clone(),
    });
    if guard.channel_history.len() > MAX_STORED_CHANNEL_HISTORY {
        let overflow = guard.channel_history.len() - MAX_STORED_CHANNEL_HISTORY;
        guard.channel_history.drain(0..overflow);
    }
    Ok(assignment)
}

async fn check_for_update_in_memory(
    store: &Arc<RwLock<OtaRegistrySnapshot>>,
    request: OtaCheckRequest,
) -> Result<OtaCheckResponse, OtaRegistryError> {
    let assignment_key = channel_key(request.platform, &request.channel);
    let device_key = device_key(request.platform, &request.channel, &request.device_id);
    let now = Utc::now();
    let mut guard = store.write().await;
    let response = match guard.channels.get(&assignment_key).cloned() {
        Some(assignment) => match guard.releases.get(&assignment.active_release_id).cloned() {
            Some(release) => {
                if !version_is_compatible(
                    &request.native_version,
                    &release.min_supported_native_version,
                ) {
                    OtaCheckResponse::not_available("native_version_too_old")
                } else if request
                    .current_bundle_version
                    .as_ref()
                    .is_some_and(|value| value == &release.bundle_version)
                    || request
                        .current_git_sha
                        .as_ref()
                        .is_some_and(|value| value == &release.git_sha)
                {
                    OtaCheckResponse::not_available("already_active")
                } else if !device_is_in_rollout(
                    &request.device_id,
                    &release.release_id,
                    assignment.rollout_percentage,
                ) {
                    OtaCheckResponse::not_available("rollout_excluded")
                } else {
                    OtaCheckResponse {
                        update_available: true,
                        reason: "update_available".to_string(),
                        release_id: Some(release.release_id.clone()),
                        bundle_version: Some(release.bundle_version.clone()),
                        git_sha: Some(release.git_sha.clone()),
                        artifact_url: Some(release.artifact_url.clone()),
                        artifact_sha256: Some(release.artifact_sha256.clone()),
                        artifact_size_bytes: Some(release.artifact_size_bytes),
                        artifact_type: Some(release.artifact_type.clone()),
                        signature: release.signature.clone(),
                        rollout_percentage: Some(assignment.rollout_percentage),
                    }
                }
            }
            None => OtaCheckResponse::not_available("active_release_missing"),
        },
        None => OtaCheckResponse::not_available("channel_not_configured"),
    };

    guard.device_states.insert(
        device_key,
        OtaDeviceState {
            device_id: request.device_id,
            platform: request.platform,
            channel: request.channel,
            native_version: request.native_version,
            current_bundle_version: request.current_bundle_version,
            current_git_sha: request.current_git_sha,
            last_seen_at: now,
            last_check_at: Some(now),
            last_event_type: Some(if response.update_available {
                OtaEventType::UpdateAvailable
            } else {
                OtaEventType::UpdateNotAvailable
            }),
            last_event_at: Some(now),
            last_release_id: response.release_id.clone(),
            last_session_id: None,
            last_user_id: None,
            last_space_id: None,
        },
    );

    Ok(response)
}

async fn record_event_in_memory(
    store: &Arc<RwLock<OtaRegistrySnapshot>>,
    event: OtaUpdateEvent,
) -> Result<OtaUpdateEvent, OtaRegistryError> {
    let device_key = device_key(event.platform, &event.channel, &event.device_id);
    let mut guard = store.write().await;
    let existing = guard.device_states.get(&device_key).cloned();
    let release_id = event.bundle_version.as_ref().and_then(|bundle_version| {
        guard.releases.values().find_map(|release| {
            if release.platform == event.platform
                && release.channel == event.channel
                && release.bundle_version == *bundle_version
            {
                Some(release.release_id.clone())
            } else {
                None
            }
        })
    });

    guard.device_states.insert(
        device_key,
        OtaDeviceState {
            device_id: event.device_id.clone(),
            platform: event.platform,
            channel: event.channel.clone(),
            native_version: event.native_version.clone(),
            current_bundle_version: event.bundle_version.clone().or_else(|| {
                existing
                    .as_ref()
                    .and_then(|state| state.current_bundle_version.clone())
            }),
            current_git_sha: event.git_sha.clone().or_else(|| {
                existing
                    .as_ref()
                    .and_then(|state| state.current_git_sha.clone())
            }),
            last_seen_at: event.occurred_at,
            last_check_at: existing.as_ref().and_then(|state| state.last_check_at),
            last_event_type: Some(event.event_type.clone()),
            last_event_at: Some(event.occurred_at),
            last_release_id: release_id.or_else(|| {
                existing
                    .as_ref()
                    .and_then(|state| state.last_release_id.clone())
            }),
            last_session_id: event.session_id.clone(),
            last_user_id: event.user_id.clone(),
            last_space_id: event.space_id.clone(),
        },
    );

    guard
        .recent_events
        .retain(|existing_event| existing_event.event_id != event.event_id);
    guard.recent_events.push(event.clone());
    guard
        .recent_events
        .sort_by(|left, right| left.occurred_at.cmp(&right.occurred_at));
    if guard.recent_events.len() > MAX_STORED_EVENTS as usize {
        let overflow = guard.recent_events.len() - MAX_STORED_EVENTS as usize;
        guard.recent_events.drain(0..overflow);
    }
    Ok(event)
}

fn map_release_row(row: Row) -> Result<OtaReleaseRecord, OtaRegistryError> {
    Ok(OtaReleaseRecord {
        release_id: row.get("release_id"),
        platform: OtaPlatform::from_str(row.get::<_, String>("platform").as_str())?,
        channel: row.get("channel"),
        bundle_version: row.get("bundle_version"),
        git_sha: row.get("git_sha"),
        native_version: row.get("native_version"),
        min_supported_native_version: row.get("min_supported_native_version"),
        artifact_url: row.get("artifact_url"),
        artifact_sha256: row.get("artifact_sha256"),
        artifact_size_bytes: to_u64(
            row.get::<_, i64>("artifact_size_bytes"),
            "artifact_size_bytes",
        )?,
        artifact_type: row.get("artifact_type"),
        signature: row.get("signature"),
        rollout_percentage: to_u8(
            row.get::<_, i32>("rollout_percentage"),
            "rollout_percentage",
        )?,
        status: OtaReleaseStatus::from_str(row.get::<_, String>("status").as_str())?,
        published_at: row.get("published_at"),
        published_by: row.get("published_by"),
        notes: row.get("notes"),
    })
}

fn map_channel_assignment_row(row: Row) -> Result<OtaChannelAssignment, OtaRegistryError> {
    Ok(OtaChannelAssignment {
        platform: OtaPlatform::from_str(row.get::<_, String>("platform").as_str())?,
        channel: row.get("channel"),
        active_release_id: row.get("active_release_id"),
        previous_release_id: row.get("previous_release_id"),
        rollout_percentage: to_u8(
            row.get::<_, i32>("rollout_percentage"),
            "rollout_percentage",
        )?,
        activated_at: row.get("activated_at"),
        activated_by: row.get("activated_by"),
    })
}

fn map_channel_history_row(row: Row) -> Result<OtaChannelHistoryEntry, OtaRegistryError> {
    Ok(OtaChannelHistoryEntry {
        history_id: row.get("history_id"),
        platform: OtaPlatform::from_str(row.get::<_, String>("platform").as_str())?,
        channel: row.get("channel"),
        action: OtaChannelHistoryAction::from_str(row.get::<_, String>("action").as_str())?,
        previous_release_id: row.get("previous_release_id"),
        next_release_id: row.get("next_release_id"),
        rollout_percentage: to_u8(
            row.get::<_, i32>("rollout_percentage"),
            "rollout_percentage",
        )?,
        activated_at: row.get("activated_at"),
        activated_by: row.get("activated_by"),
    })
}

fn map_device_state_row(row: Row) -> Result<OtaDeviceState, OtaRegistryError> {
    Ok(OtaDeviceState {
        device_id: row.get("device_id"),
        platform: OtaPlatform::from_str(row.get::<_, String>("platform").as_str())?,
        channel: row.get("channel"),
        native_version: row.get("native_version"),
        current_bundle_version: row.get("current_bundle_version"),
        current_git_sha: row.get("current_git_sha"),
        last_seen_at: row.get("last_seen_at"),
        last_check_at: row.get("last_check_at"),
        last_event_type: row
            .get::<_, Option<String>>("last_event_type")
            .map(|value| OtaEventType::from_str(value.as_str()))
            .transpose()?,
        last_event_at: row.get("last_event_at"),
        last_release_id: row.get("last_release_id"),
        last_session_id: row.get("last_session_id"),
        last_user_id: row.get("last_user_id"),
        last_space_id: row.get("last_space_id"),
    })
}

fn map_event_row(row: Row) -> Result<OtaUpdateEvent, OtaRegistryError> {
    let properties_json = row.get::<_, PgJson<JsonValue>>("properties").0;
    Ok(OtaUpdateEvent {
        event_id: row.get("event_id"),
        event_type: OtaEventType::from_str(row.get::<_, String>("event_type").as_str())?,
        occurred_at: row.get("occurred_at"),
        device_id: row.get("device_id"),
        platform: OtaPlatform::from_str(row.get::<_, String>("platform").as_str())?,
        channel: row.get("channel"),
        native_version: row.get("native_version"),
        bundle_version: row.get("bundle_version"),
        git_sha: row.get("git_sha"),
        space_id: row.get("space_id"),
        user_id: row.get("user_id"),
        session_id: row.get("session_id"),
        country_code: row.get("country_code"),
        properties: json_to_properties(properties_json),
    })
}

async fn load_release_for_update(
    transaction: &tokio_postgres::Transaction<'_>,
    release_id: &str,
) -> Result<OtaReleaseRecord, OtaRegistryError> {
    let row = transaction
        .query_opt(
            "select release_id, platform, channel, bundle_version, git_sha, native_version,
                    min_supported_native_version, artifact_url, artifact_sha256,
                    artifact_size_bytes, artifact_type, signature, rollout_percentage,
                    status, published_at, published_by, notes
               from ota_releases
              where release_id = $1
              for update",
            &[&release_id],
        )
        .await
        .map_err(ota_internal)?
        .ok_or_else(|| {
            OtaRegistryError::NotFound(format!("unknown release_id '{}'", release_id))
        })?;
    map_release_row(row)
}

async fn load_channel_assignment_for_update(
    transaction: &tokio_postgres::Transaction<'_>,
    platform: OtaPlatform,
    channel: &str,
) -> Result<Option<OtaChannelAssignment>, OtaRegistryError> {
    let row = transaction
        .query_opt(
            "select platform, channel, active_release_id, previous_release_id,
                    rollout_percentage, activated_at, activated_by
               from ota_channel_assignments
              where platform = $1 and channel = $2
              for update",
            &[&platform.to_string(), &channel],
        )
        .await
        .map_err(ota_internal)?;
    row.map(map_channel_assignment_row).transpose()
}

async fn ensure_ota_tables(pool: &PgPool) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .batch_execute(
            "
            create table if not exists ota_releases (
              release_id text primary key,
              platform text not null check (platform in ('ios', 'android')),
              channel text not null,
              bundle_version text not null,
              git_sha text not null,
              native_version text not null,
              min_supported_native_version text not null,
              artifact_url text not null,
              artifact_sha256 text not null,
              artifact_size_bytes bigint not null check (artifact_size_bytes >= 0),
              artifact_type text not null check (artifact_type = 'zip'),
              signature text,
              rollout_percentage integer not null check (rollout_percentage between 0 and 100),
              status text not null check (status in ('draft', 'live', 'paused', 'rolled_back', 'archived')),
              published_at timestamptz not null,
              published_by text not null,
              notes text,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now()
            );

            create table if not exists ota_channel_assignments (
              platform text not null check (platform in ('ios', 'android')),
              channel text not null,
              active_release_id text not null references ota_releases(release_id) on delete restrict,
              previous_release_id text references ota_releases(release_id) on delete set null,
              rollout_percentage integer not null check (rollout_percentage between 0 and 100),
              activated_at timestamptz not null,
              activated_by text not null,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now(),
              primary key (platform, channel)
            );

            create table if not exists ota_channel_history (
              history_id text primary key,
              platform text not null check (platform in ('ios', 'android')),
              channel text not null,
              action text not null check (action in ('activate', 'rollback')),
              previous_release_id text references ota_releases(release_id) on delete set null,
              next_release_id text not null references ota_releases(release_id) on delete restrict,
              rollout_percentage integer not null check (rollout_percentage between 0 and 100),
              activated_at timestamptz not null,
              activated_by text not null,
              created_at timestamptz not null default now()
            );

            create table if not exists ota_device_states (
              platform text not null check (platform in ('ios', 'android')),
              channel text not null,
              device_id text not null,
              native_version text not null,
              current_bundle_version text,
              current_git_sha text,
              last_seen_at timestamptz not null,
              last_check_at timestamptz,
              last_event_type text,
              last_event_at timestamptz,
              last_release_id text references ota_releases(release_id) on delete set null,
              last_session_id text,
              last_user_id text,
              last_space_id text,
              created_at timestamptz not null default now(),
              updated_at timestamptz not null default now(),
              primary key (platform, channel, device_id)
            );

            create table if not exists ota_events (
              event_id text primary key,
              event_type text not null,
              occurred_at timestamptz not null,
              device_id text not null,
              platform text not null check (platform in ('ios', 'android')),
              channel text not null,
              native_version text not null,
              bundle_version text,
              git_sha text,
              space_id text,
              user_id text,
              session_id text,
              country_code text,
              properties jsonb not null default '{}'::jsonb,
              created_at timestamptz not null default now()
            );

            alter table ota_events
              add column if not exists country_code text;

            create index if not exists ota_releases_platform_channel_published_idx
              on ota_releases (platform, channel, published_at desc);
            create unique index if not exists ota_releases_platform_channel_bundle_version_idx
              on ota_releases (platform, channel, bundle_version);
            create index if not exists ota_channel_assignments_active_release_idx
              on ota_channel_assignments (active_release_id);
            create index if not exists ota_channel_history_lookup_idx
              on ota_channel_history (platform, channel, activated_at desc);
            create index if not exists ota_device_states_last_seen_idx
              on ota_device_states (last_seen_at desc);
            create index if not exists ota_events_occurred_at_idx
              on ota_events (occurred_at desc);
            create index if not exists ota_events_platform_channel_idx
              on ota_events (platform, channel, occurred_at desc);
            create index if not exists ota_events_device_idx
              on ota_events (device_id, occurred_at desc);

            alter table ota_releases enable row level security;
            alter table ota_channel_assignments enable row level security;
            alter table ota_channel_history enable row level security;
            alter table ota_device_states enable row level security;
            alter table ota_events enable row level security;

            revoke all privileges on table ota_releases from anon, authenticated;
            revoke all privileges on table ota_channel_assignments from anon, authenticated;
            revoke all privileges on table ota_channel_history from anon, authenticated;
            revoke all privileges on table ota_device_states from anon, authenticated;
            revoke all privileges on table ota_events from anon, authenticated;
        ",
        )
        .await?;
    Ok(())
}

async fn prune_recent_events(
    connection: &bb8::PooledConnection<'_, crate::config::PgConnectionManager>,
) -> Result<(), OtaRegistryError> {
    connection
        .execute(
            "delete from ota_events
              where occurred_at < now() - make_interval(days => $1)",
            &[&EVENT_RETENTION_DAYS],
        )
        .await
        .map_err(ota_internal)?;
    connection
        .execute(
            "delete from ota_events
              where event_id in (
                select event_id
                  from ota_events
              order by occurred_at desc
                offset $1
              )",
            &[&MAX_STORED_EVENTS],
        )
        .await
        .map_err(ota_internal)?;
    Ok(())
}

fn properties_to_json(properties: &BTreeMap<String, JsonValue>) -> JsonValue {
    JsonValue::Object(
        properties
            .iter()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect::<JsonMap<String, JsonValue>>(),
    )
}

fn json_to_properties(value: JsonValue) -> BTreeMap<String, JsonValue> {
    match value {
        JsonValue::Object(map) => map.into_iter().collect(),
        _ => BTreeMap::new(),
    }
}

fn normalize_release(release: &mut OtaReleaseRecord) -> Result<(), OtaRegistryError> {
    release.release_id = normalize_non_empty(&release.release_id, "release_id")?;
    release.channel = normalize_channel(&release.channel)?;
    release.bundle_version = normalize_non_empty(&release.bundle_version, "bundle_version")?;
    release.git_sha = normalize_non_empty(&release.git_sha, "git_sha")?;
    if release.git_sha.len() < 7 {
        return Err(OtaRegistryError::Invalid(
            "git_sha must contain at least 7 characters".to_string(),
        ));
    }
    release.native_version = normalize_non_empty(&release.native_version, "native_version")?;
    release.min_supported_native_version = normalize_non_empty(
        &release.min_supported_native_version,
        "min_supported_native_version",
    )?;
    release.artifact_url = normalize_non_empty(&release.artifact_url, "artifact_url")?;
    release.artifact_sha256 =
        normalize_non_empty(&release.artifact_sha256, "artifact_sha256")?.to_ascii_lowercase();
    if release.artifact_sha256.len() != 64
        || !release
            .artifact_sha256
            .chars()
            .all(|value| value.is_ascii_hexdigit())
    {
        return Err(OtaRegistryError::Invalid(
            "artifact_sha256 must be a 64-character hex digest".to_string(),
        ));
    }
    release.artifact_type = normalize_non_empty(&release.artifact_type, "artifact_type")?;
    if release.artifact_type != "zip" {
        return Err(OtaRegistryError::Invalid(
            "artifact_type must be 'zip'".to_string(),
        ));
    }
    if release.rollout_percentage > 100 {
        return Err(OtaRegistryError::Invalid(
            "rollout_percentage must be between 0 and 100".to_string(),
        ));
    }
    release.published_by = normalize_non_empty(&release.published_by, "published_by")?;
    release.notes = release
        .notes
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    release.signature = release
        .signature
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(())
}

fn normalize_check_request(request: &mut OtaCheckRequest) -> Result<(), OtaRegistryError> {
    request.device_id = normalize_non_empty(&request.device_id, "device_id")?;
    request.channel = normalize_channel(&request.channel)?;
    request.native_version = normalize_non_empty(&request.native_version, "native_version")?;
    request.current_bundle_version = request
        .current_bundle_version
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    request.current_git_sha = request
        .current_git_sha
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(())
}

fn normalize_event(event: &mut OtaUpdateEvent) -> Result<(), OtaRegistryError> {
    event.event_id = normalize_non_empty(&event.event_id, "event_id")?;
    event.device_id = normalize_non_empty(&event.device_id, "device_id")?;
    event.channel = normalize_channel(&event.channel)?;
    event.native_version = normalize_non_empty(&event.native_version, "native_version")?;
    event.bundle_version = event
        .bundle_version
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    event.git_sha = event
        .git_sha
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    event.space_id = event
        .space_id
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    event.user_id = event
        .user_id
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    event.session_id = event
        .session_id
        .take()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    event.country_code = event
        .country_code
        .take()
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| value.len() == 2 && value.chars().all(|ch| ch.is_ascii_uppercase()));
    Ok(())
}

fn normalize_non_empty(value: &str, field: &str) -> Result<String, OtaRegistryError> {
    let normalized = value.trim().to_string();
    if normalized.is_empty() {
        return Err(OtaRegistryError::Invalid(format!("{field} is required")));
    }
    Ok(normalized)
}

fn normalize_channel(value: &str) -> Result<String, OtaRegistryError> {
    Ok(normalize_non_empty(value, "channel")?.to_ascii_lowercase())
}

fn channel_key(platform: OtaPlatform, channel: &str) -> String {
    format!("{platform}:{channel}")
}

fn device_key(platform: OtaPlatform, channel: &str, device_id: &str) -> String {
    format!("{platform}:{channel}:{}", device_id.trim())
}

fn device_is_in_rollout(device_id: &str, release_id: &str, rollout_percentage: u8) -> bool {
    if rollout_percentage >= 100 {
        return true;
    }
    if rollout_percentage == 0 {
        return false;
    }

    let mut hasher = Sha256::new();
    hasher.update(device_id.as_bytes());
    hasher.update(b":");
    hasher.update(release_id.as_bytes());
    let digest = hasher.finalize();
    let bucket = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 100;
    bucket < u32::from(rollout_percentage)
}

fn version_is_compatible(current: &str, minimum: &str) -> bool {
    compare_versions(current, minimum) != Ordering::Less
}

fn compare_versions(left: &str, right: &str) -> Ordering {
    let left_parts = split_version(left);
    let right_parts = split_version(right);
    let max_len = left_parts.len().max(right_parts.len());

    for index in 0..max_len {
        let left_part = left_parts.get(index).map(String::as_str).unwrap_or("0");
        let right_part = right_parts.get(index).map(String::as_str).unwrap_or("0");

        let ordering = match (left_part.parse::<u64>(), right_part.parse::<u64>()) {
            (Ok(left_num), Ok(right_num)) => left_num.cmp(&right_num),
            _ => left_part.cmp(right_part),
        };
        if ordering != Ordering::Equal {
            return ordering;
        }
    }

    Ordering::Equal
}

fn split_version(value: &str) -> Vec<String> {
    value
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| part.to_ascii_lowercase())
        .collect()
}

fn to_i64(value: u64, field: &str) -> Result<i64, OtaRegistryError> {
    i64::try_from(value)
        .map_err(|_| OtaRegistryError::Invalid(format!("{field} exceeds i64 range")))
}

fn to_u64(value: i64, field: &str) -> Result<u64, OtaRegistryError> {
    u64::try_from(value)
        .map_err(|_| OtaRegistryError::Invalid(format!("{field} cannot be negative")))
}

fn to_u8(value: i32, field: &str) -> Result<u8, OtaRegistryError> {
    u8::try_from(value).map_err(|_| OtaRegistryError::Invalid(format!("{field} is out of range")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{
        build_app_config, build_test_state, test_origin_private_key, test_origin_public_key,
    };
    use crate::tokens::{mint_scoped_token, ScopedTokenRequest};
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use bb8::Pool;
    use bb8_postgres::PostgresConnectionManager;
    use tempfile::TempDir;
    use tower::ServiceExt;
    use uuid::Uuid;

    fn sample_release() -> OtaReleaseRecord {
        OtaReleaseRecord {
            release_id: "ios-stable-20260318".to_string(),
            platform: OtaPlatform::Ios,
            channel: "stable".to_string(),
            bundle_version: "2026.03.18.1".to_string(),
            git_sha: "abcdef123456".to_string(),
            native_version: "1.2.0".to_string(),
            min_supported_native_version: "1.2.0".to_string(),
            artifact_url: "https://downloads.instafy.dev/ota/ios-stable-20260318.zip".to_string(),
            artifact_sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                .to_string(),
            artifact_size_bytes: 1024,
            artifact_type: "zip".to_string(),
            signature: None,
            rollout_percentage: 100,
            status: OtaReleaseStatus::Draft,
            published_at: Utc::now(),
            published_by: "ci@instafy.dev".to_string(),
            notes: Some("first cut".to_string()),
        }
    }

    fn build_dummy_pool() -> anyhow::Result<crate::config::PgPool> {
        let manager = PostgresConnectionManager::new_from_stringlike(
            "postgresql://ignored:ignored@127.0.0.1:1/postgres",
            crate::config::database_tls(),
        )?;
        Ok(Pool::builder().max_size(1).build_unchecked(manager))
    }

    async fn test_state() -> anyhow::Result<(AppState, TempDir)> {
        let temp_dir = tempfile::tempdir()?;
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "test-origin-key",
        );
        let mut state = build_test_state(build_dummy_pool()?, config);
        state.ota_registry = OtaRegistry::new_in_memory();
        Ok((state, temp_dir))
    }

    fn service_role_header() -> (&'static str, &'static str) {
        ("authorization", "Bearer service-role-token")
    }

    fn controller_user_header(
        config: &crate::config::AppConfig,
        user_id: Uuid,
    ) -> anyhow::Result<(String, String)> {
        let token = crate::auth::issue_controller_token(config, &user_id)
            .map_err(|error| anyhow::anyhow!("failed to issue controller token: {:?}", error))?;
        Ok((
            "authorization".to_string(),
            format!("Bearer {}", token.token),
        ))
    }

    #[tokio::test]
    async fn register_release_requires_operator_access() -> anyhow::Result<()> {
        let (state, _temp_dir) = test_state().await?;

        let response = router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/ota/releases")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&sample_release())?))?,
            )
            .await?;

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        Ok(())
    }

    #[tokio::test]
    async fn register_release_allows_allowed_operator_user() -> anyhow::Result<()> {
        let (mut state, _temp_dir) = test_state().await?;
        let operator_user_id = Uuid::new_v4();
        state.config.operator_console_allowed_user_ids = vec![operator_user_id];
        let auth_header = controller_user_header(&state.config, operator_user_id)?;

        let response = router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/ota/releases")
                    .header("content-type", "application/json")
                    .header(auth_header.0, auth_header.1)
                    .body(Body::from(serde_json::to_vec(&sample_release())?))?,
            )
            .await?;

        assert_eq!(response.status(), StatusCode::CREATED);
        Ok(())
    }

    #[tokio::test]
    async fn register_release_rejects_scoped_token_for_allowed_operator_user() -> anyhow::Result<()>
    {
        let (mut state, _temp_dir) = test_state().await?;
        let operator_user_id = Uuid::new_v4();
        state.config.operator_console_allowed_user_ids = vec![operator_user_id];
        let scoped = mint_scoped_token(
            &state.config,
            ScopedTokenRequest {
                audience: Uuid::new_v4().to_string(),
                subject: operator_user_id.to_string(),
                project_id: Uuid::new_v4().to_string(),
                origin_id: Some(Uuid::new_v4().to_string()),
                runtime_id: None,
                protocol: Some("webdav".to_string()),
                scopes: vec!["fs.read".to_string()],
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: Some(300),
            },
        )
        .map_err(|error| anyhow::anyhow!("failed to mint scoped token: {error:?}"))?;

        let response = router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/ota/releases")
                    .header("content-type", "application/json")
                    .header("authorization", format!("Bearer {}", scoped.token))
                    .body(Body::from(serde_json::to_vec(&sample_release())?))?,
            )
            .await?;

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        Ok(())
    }

    #[tokio::test]
    async fn register_activate_and_check_returns_update() -> anyhow::Result<()> {
        let (state, _temp_dir) = test_state().await?;

        let app = router().with_state(state.clone());
        let release = sample_release();

        let register_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/ota/releases")
                    .header("content-type", "application/json")
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::from(serde_json::to_vec(&release)?))?,
            )
            .await?;
        assert_eq!(register_response.status(), StatusCode::CREATED);

        let activate_body = serde_json::json!({
            "release_id": release.release_id,
            "rollout_percentage": 100,
            "activated_by": "ops@instafy.dev"
        });
        let activate_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/ota/channels/ios/stable/activate")
                    .header("content-type", "application/json")
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::from(serde_json::to_vec(&activate_body)?))?,
            )
            .await?;
        assert_eq!(activate_response.status(), StatusCode::OK);

        let check_body = serde_json::json!({
            "device_id": "device-1",
            "platform": "ios",
            "channel": "stable",
            "native_version": "1.2.0"
        });
        let check_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/ota/check")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&check_body)?))?,
            )
            .await?;
        assert_eq!(check_response.status(), StatusCode::OK);
        let payload: OtaCheckResponse =
            serde_json::from_slice(&to_bytes(check_response.into_body(), usize::MAX).await?)?;
        assert!(payload.update_available);
        assert_eq!(payload.release_id.as_deref(), Some("ios-stable-20260318"));
        assert_eq!(payload.bundle_version.as_deref(), Some("2026.03.18.1"));

        Ok(())
    }

    #[tokio::test]
    async fn check_respects_rollout_gate() -> anyhow::Result<()> {
        let (state, _temp_dir) = test_state().await?;

        let app = router().with_state(state.clone());
        let release = sample_release();

        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/ota/releases")
                    .header("content-type", "application/json")
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::from(serde_json::to_vec(&release)?))?,
            )
            .await?;

        let activate_body = serde_json::json!({
            "release_id": release.release_id,
            "rollout_percentage": 0,
            "activated_by": "ops@instafy.dev"
        });
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/ota/channels/ios/stable/activate")
                    .header("content-type", "application/json")
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::from(serde_json::to_vec(&activate_body)?))?,
            )
            .await?;

        let check_body = serde_json::json!({
            "device_id": "device-rollout",
            "platform": "ios",
            "channel": "stable",
            "native_version": "1.2.0"
        });
        let check_response = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/ota/check")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&check_body)?))?,
            )
            .await?;
        assert_eq!(check_response.status(), StatusCode::OK);
        let payload: OtaCheckResponse =
            serde_json::from_slice(&to_bytes(check_response.into_body(), usize::MAX).await?)?;
        assert!(!payload.update_available);
        assert_eq!(payload.reason, "rollout_excluded");
        Ok(())
    }

    #[tokio::test]
    async fn record_event_updates_device_state() -> anyhow::Result<()> {
        let (state, _temp_dir) = test_state().await?;

        let app = router().with_state(state.clone());
        let event = serde_json::json!({
            "event_id": "evt-1",
            "event_type": "install_completed",
            "occurred_at": Utc::now(),
            "device_id": "device-42",
            "platform": "ios",
            "channel": "stable",
            "native_version": "1.2.0",
            "bundle_version": "2026.03.18.1",
            "git_sha": "abcdef123456",
            "session_id": "session-1",
            "properties": {
                "apply_ms": 3200
            }
        });

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/ota/events")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&event)?))?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::ACCEPTED);

        let devices_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/ota/device-states")
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(devices_response.status(), StatusCode::OK);
        let payload: Vec<OtaDeviceState> =
            serde_json::from_slice(&to_bytes(devices_response.into_body(), usize::MAX).await?)?;
        assert_eq!(payload.len(), 1);
        assert_eq!(payload[0].device_id, "device-42");
        assert_eq!(
            payload[0].current_bundle_version.as_deref(),
            Some("2026.03.18.1")
        );
        assert_eq!(
            payload[0].last_event_type,
            Some(OtaEventType::InstallCompleted)
        );

        Ok(())
    }

    #[tokio::test]
    async fn list_events_applies_filters_and_cursor() -> anyhow::Result<()> {
        let (state, _temp_dir) = test_state().await?;
        let app = router().with_state(state.clone());
        let older_time = Utc::now() - chrono::Duration::minutes(2);
        let newer_time = Utc::now() - chrono::Duration::minutes(1);

        for event in [
            serde_json::json!({
                "event_id": "evt-old",
                "event_type": "install_failed",
                "occurred_at": older_time,
                "device_id": "device-old",
                "platform": "ios",
                "channel": "stable",
                "native_version": "1.2.0",
                "bundle_version": "2026.03.18.0",
                "session_id": "session-old"
            }),
            serde_json::json!({
                "event_id": "evt-new",
                "event_type": "install_completed",
                "occurred_at": newer_time,
                "device_id": "device-new",
                "platform": "android",
                "channel": "beta",
                "native_version": "1.2.0",
                "bundle_version": "2026.03.18.1",
                "session_id": "session-new"
            }),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/ota/events")
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(&event)?))?,
                )
                .await?;
            assert_eq!(response.status(), StatusCode::ACCEPTED);
        }

        let filtered_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/ota/events?platform=ios&event_type=install_failed&limit=1")
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(filtered_response.status(), StatusCode::OK);
        let filtered: Vec<OtaUpdateEvent> =
            serde_json::from_slice(&to_bytes(filtered_response.into_body(), usize::MAX).await?)?;
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].event_id, "evt-old");

        let encoded_time = newer_time.to_rfc3339();
        let cursor = urlencoding::encode(&encoded_time);
        let paged_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/ota/events?before_occurred_at={cursor}&limit=10"))
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(paged_response.status(), StatusCode::OK);
        let paged: Vec<OtaUpdateEvent> =
            serde_json::from_slice(&to_bytes(paged_response.into_body(), usize::MAX).await?)?;
        assert_eq!(paged.len(), 1);
        assert_eq!(paged[0].event_id, "evt-old");

        Ok(())
    }

    #[tokio::test]
    async fn download_insights_aggregate_recent_ota_download_events() -> anyhow::Result<()> {
        let (state, _temp_dir) = test_state().await?;
        let app = router().with_state(state.clone());
        let now = Utc::now();

        for (event, country) in [
            (
                serde_json::json!({
                    "event_id": "evt-ota-available",
                    "event_type": "update_available",
                    "occurred_at": now - chrono::Duration::hours(6),
                    "device_id": "device-ota-1",
                    "platform": "ios",
                    "channel": "stable",
                    "native_version": "1.2.0",
                    "bundle_version": "2026.03.22.1"
                }),
                "AT",
            ),
            (
                serde_json::json!({
                    "event_id": "evt-ota-started",
                    "event_type": "download_started",
                    "occurred_at": now - chrono::Duration::hours(5),
                    "device_id": "device-ota-1",
                    "platform": "ios",
                    "channel": "stable",
                    "native_version": "1.2.0",
                    "bundle_version": "2026.03.22.1"
                }),
                "AT",
            ),
            (
                serde_json::json!({
                    "event_id": "evt-ota-completed",
                    "event_type": "download_completed",
                    "occurred_at": now - chrono::Duration::hours(4),
                    "device_id": "device-ota-1",
                    "platform": "ios",
                    "channel": "stable",
                    "native_version": "1.2.0",
                    "bundle_version": "2026.03.22.1"
                }),
                "AT",
            ),
            (
                serde_json::json!({
                    "event_id": "evt-ota-failed",
                    "event_type": "download_failed",
                    "occurred_at": now - chrono::Duration::hours(3),
                    "device_id": "device-ota-2",
                    "platform": "android",
                    "channel": "beta",
                    "native_version": "1.2.0",
                    "bundle_version": "2026.03.22.1"
                }),
                "US",
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/ota/events")
                        .header("content-type", "application/json")
                        .header("CF-IPCountry", country)
                        .body(Body::from(serde_json::to_vec(&event)?))?,
                )
                .await?;
            assert_eq!(response.status(), StatusCode::ACCEPTED);
        }

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/ota/download-insights?days=7")
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
        let payload: OtaDownloadInsights =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;

        assert_eq!(payload.days, 7);
        assert_eq!(payload.totals.started, 1);
        assert_eq!(payload.totals.completed, 1);
        assert_eq!(payload.totals.available, 1);
        assert_eq!(payload.totals.failures, 1);
        assert!(payload.by_channel.iter().any(|row| row.key == "stable"
            && row.counts.started == 1
            && row.counts.completed == 1));
        assert!(payload
            .by_channel
            .iter()
            .any(|row| row.key == "beta" && row.counts.failures == 1));
        assert!(payload
            .by_platform
            .iter()
            .any(|row| row.key == "ios" && row.counts.available == 1));
        assert!(payload
            .by_platform
            .iter()
            .any(|row| row.key == "android" && row.counts.failures == 1));
        assert!(payload
            .by_country
            .iter()
            .any(|row| row.key == "AT" && row.counts.started == 1 && row.counts.completed == 1));
        assert!(payload
            .by_country
            .iter()
            .any(|row| row.key == "US" && row.counts.failures == 1));

        Ok(())
    }

    #[tokio::test]
    async fn list_device_states_applies_attention_filter() -> anyhow::Result<()> {
        let (state, _temp_dir) = test_state().await?;
        let app = router().with_state(state.clone());

        for event in [
            serde_json::json!({
                "event_id": "evt-device-failed",
                "event_type": "install_failed",
                "occurred_at": Utc::now() - chrono::Duration::minutes(3),
                "device_id": "device-failed",
                "platform": "ios",
                "channel": "stable",
                "native_version": "1.2.0",
                "bundle_version": "2026.03.18.1"
            }),
            serde_json::json!({
                "event_id": "evt-device-healthy",
                "event_type": "install_completed",
                "occurred_at": Utc::now() - chrono::Duration::minutes(1),
                "device_id": "device-healthy",
                "platform": "ios",
                "channel": "stable",
                "native_version": "1.2.0",
                "bundle_version": "2026.03.18.2"
            }),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/ota/events")
                        .header("content-type", "application/json")
                        .body(Body::from(serde_json::to_vec(&event)?))?,
                )
                .await?;
            assert_eq!(response.status(), StatusCode::ACCEPTED);
        }

        let response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/ota/device-states?platform=ios&attention_only=true&limit=10")
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
        let payload: Vec<OtaDeviceState> =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
        assert_eq!(payload.len(), 1);
        assert_eq!(payload[0].device_id, "device-failed");
        assert_eq!(
            payload[0].last_event_type,
            Some(OtaEventType::InstallFailed)
        );

        Ok(())
    }

    #[tokio::test]
    async fn channel_history_tracks_activate_and_rollback() -> anyhow::Result<()> {
        let (state, _temp_dir) = test_state().await?;
        let app = router().with_state(state.clone());

        let release_a = sample_release();
        let mut release_b = sample_release();
        release_b.release_id = "ios-stable-20260319".to_string();
        release_b.bundle_version = "2026.03.19.1".to_string();
        release_b.git_sha = "fedcba654321".to_string();

        for release in [&release_a, &release_b] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/ota/releases")
                        .header("content-type", "application/json")
                        .header(service_role_header().0, service_role_header().1)
                        .body(Body::from(serde_json::to_vec(release)?))?,
                )
                .await?;
            assert_eq!(response.status(), StatusCode::CREATED);
        }

        for body in [
            serde_json::json!({
                "release_id": release_a.release_id,
                "rollout_percentage": 100,
                "activated_by": "ops-a@instafy.dev"
            }),
            serde_json::json!({
                "release_id": release_b.release_id,
                "rollout_percentage": 50,
                "activated_by": "ops-b@instafy.dev"
            }),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/ota/channels/ios/stable/activate")
                        .header("content-type", "application/json")
                        .header(service_role_header().0, service_role_header().1)
                        .body(Body::from(serde_json::to_vec(&body)?))?,
                )
                .await?;
            assert_eq!(response.status(), StatusCode::OK);
        }

        let rollback_response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/ota/channels/ios/stable/rollback")
                    .header("content-type", "application/json")
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::from(serde_json::to_vec(&serde_json::json!({
                        "activated_by": "ops-c@instafy.dev"
                    }))?))?,
            )
            .await?;
        assert_eq!(rollback_response.status(), StatusCode::OK);

        let history_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/ota/channels/ios/stable/history?limit=10")
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(history_response.status(), StatusCode::OK);
        let history: Vec<OtaChannelHistoryEntry> =
            serde_json::from_slice(&to_bytes(history_response.into_body(), usize::MAX).await?)?;
        assert_eq!(history.len(), 3);
        assert_eq!(history[0].action, OtaChannelHistoryAction::Rollback);
        assert_eq!(history[0].next_release_id, release_a.release_id);
        assert_eq!(
            history[0].previous_release_id.as_deref(),
            Some("ios-stable-20260319")
        );
        assert_eq!(history[1].action, OtaChannelHistoryAction::Activate);
        assert_eq!(history[1].next_release_id, release_b.release_id);
        assert_eq!(history[2].next_release_id, release_a.release_id);

        Ok(())
    }
}
