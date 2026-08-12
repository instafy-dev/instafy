use std::collections::BTreeMap;
use std::fmt;
use std::str::FromStr;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use tokio::sync::{OnceCell, RwLock};
use tokio_postgres::types::{Json as PgJson, ToSql};
use tokio_postgres::Row;
use uuid::Uuid;

use crate::geo::extract_country_code_from_headers;
use crate::ota::require_operator_access;
use crate::{bad_request, internal_error, ApiError, AppState};

const DEFAULT_DEVICE_LIMIT: i64 = 100;
const DEFAULT_EVENT_LIMIT: i64 = 100;
const DEFAULT_PROMOTION_LIMIT: i64 = 50;
const DEFAULT_DOWNLOAD_INSIGHTS_DAYS: i64 = 14;
const MAX_DEVICE_LIMIT: i64 = 500;
const MAX_EVENT_LIMIT: i64 = 500;
const MAX_PROMOTION_LIMIT: i64 = 200;
const MAX_DOWNLOAD_INSIGHTS_DAYS: i64 = 90;
const MAX_STORED_EVENTS: i64 = 5_000;
const MAX_STORED_PROMOTIONS: i64 = 2_000;
const GITHUB_API_BASE_URL: &str = "https://api.github.com";
const GITHUB_API_VERSION: &str = "2022-11-28";
const DESKTOP_PROMOTION_WORKFLOW_REF: &str = "main";

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/desktop-updates/device-states", get(list_device_states))
        .route("/desktop-updates/events", get(list_events).post(post_event))
        .route(
            "/desktop-updates/download-insights",
            get(get_download_insights),
        )
        .route(
            "/desktop-updates/promotions",
            get(list_promotions).post(request_promotion),
        )
        .route(
            "/desktop-updates/promotions/:request_id",
            get(get_promotion),
        )
}

#[derive(Clone)]
pub(crate) struct DesktopUpdateRegistry {
    backend: DesktopUpdateRegistryBackend,
}

#[derive(Clone)]
enum DesktopUpdateRegistryBackend {
    InMemory(Arc<RwLock<DesktopUpdateSnapshot>>),
    Postgres(PostgresDesktopUpdateRegistry),
}

#[derive(Clone)]
struct PostgresDesktopUpdateRegistry {
    pool: crate::config::PgPool,
    tables_ready: Arc<OnceCell<()>>,
}

#[derive(Default, Clone)]
struct DesktopUpdateSnapshot {
    device_states: BTreeMap<String, DesktopUpdateDeviceState>,
    recent_events: Vec<DesktopUpdateEvent>,
    promotions: Vec<DesktopPromotionRecord>,
}

#[derive(Clone, Debug)]
struct ResolvedDesktopDeviceStateListParams {
    limit: i64,
    channel: Option<DesktopReleaseChannel>,
    query: Option<String>,
    attention_only: bool,
    before_seen_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug)]
struct ResolvedDesktopEventListParams {
    limit: i64,
    channel: Option<DesktopReleaseChannel>,
    event_type: Option<DesktopUpdateEventType>,
    query: Option<String>,
    before_occurred_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug)]
struct ResolvedDesktopPromotionListParams {
    limit: i64,
    target_channel: Option<DesktopReleaseChannel>,
    query: Option<String>,
    before_requested_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug)]
struct ResolvedDesktopDownloadInsightsParams {
    days: i64,
    channel: Option<DesktopReleaseChannel>,
}

impl DesktopUpdateRegistry {
    pub(crate) fn new_in_memory() -> Self {
        Self {
            backend: DesktopUpdateRegistryBackend::InMemory(Arc::new(RwLock::new(
                DesktopUpdateSnapshot::default(),
            ))),
        }
    }

    pub(crate) fn new_postgres(pool: crate::config::PgPool) -> Self {
        Self {
            backend: DesktopUpdateRegistryBackend::Postgres(PostgresDesktopUpdateRegistry {
                pool,
                tables_ready: Arc::new(OnceCell::new()),
            }),
        }
    }

    async fn list_device_states(
        &self,
        params: ResolvedDesktopDeviceStateListParams,
    ) -> Result<Vec<DesktopUpdateDeviceState>, DesktopUpdateRegistryError> {
        match &self.backend {
            DesktopUpdateRegistryBackend::InMemory(store) => {
                let guard = store.read().await;
                let mut rows = guard.device_states.values().cloned().collect::<Vec<_>>();
                rows.sort_by(|left, right| right.last_seen_at.cmp(&left.last_seen_at));
                rows.retain(|row| desktop_device_matches_filters(row, &params));
                rows.truncate(params.limit as usize);
                Ok(rows)
            }
            DesktopUpdateRegistryBackend::Postgres(store) => store.list_device_states(params).await,
        }
    }

    async fn list_events(
        &self,
        params: ResolvedDesktopEventListParams,
    ) -> Result<Vec<DesktopUpdateEvent>, DesktopUpdateRegistryError> {
        match &self.backend {
            DesktopUpdateRegistryBackend::InMemory(store) => {
                let guard = store.read().await;
                let mut rows = guard.recent_events.clone();
                rows.sort_by(|left, right| right.occurred_at.cmp(&left.occurred_at));
                rows.retain(|row| desktop_event_matches_filters(row, &params));
                rows.truncate(params.limit as usize);
                Ok(rows)
            }
            DesktopUpdateRegistryBackend::Postgres(store) => store.list_events(params).await,
        }
    }

    async fn list_promotions(
        &self,
        params: ResolvedDesktopPromotionListParams,
    ) -> Result<Vec<DesktopPromotionRecord>, DesktopUpdateRegistryError> {
        match &self.backend {
            DesktopUpdateRegistryBackend::InMemory(store) => {
                let guard = store.read().await;
                let mut rows = guard.promotions.clone();
                rows.sort_by(|left, right| right.requested_at.cmp(&left.requested_at));
                rows.retain(|row| desktop_promotion_matches_filters(row, &params));
                rows.truncate(params.limit as usize);
                Ok(rows)
            }
            DesktopUpdateRegistryBackend::Postgres(store) => store.list_promotions(params).await,
        }
    }

    async fn get_promotion(
        &self,
        request_id: &str,
    ) -> Result<Option<DesktopPromotionRecord>, DesktopUpdateRegistryError> {
        match &self.backend {
            DesktopUpdateRegistryBackend::InMemory(store) => {
                let guard = store.read().await;
                Ok(guard
                    .promotions
                    .iter()
                    .find(|row| row.request_id == request_id)
                    .cloned())
            }
            DesktopUpdateRegistryBackend::Postgres(store) => store.get_promotion(request_id).await,
        }
    }

    async fn record_event(
        &self,
        mut event: DesktopUpdateEvent,
    ) -> Result<DesktopUpdateEvent, DesktopUpdateRegistryError> {
        normalize_desktop_event(&mut event)?;
        match &self.backend {
            DesktopUpdateRegistryBackend::InMemory(store) => {
                record_event_in_memory(store, event).await
            }
            DesktopUpdateRegistryBackend::Postgres(store) => store.record_event(event).await,
        }
    }

    async fn record_promotion(
        &self,
        mut promotion: DesktopPromotionRecord,
    ) -> Result<DesktopPromotionRecord, DesktopUpdateRegistryError> {
        normalize_desktop_promotion(&mut promotion)?;
        match &self.backend {
            DesktopUpdateRegistryBackend::InMemory(store) => {
                record_promotion_in_memory(store, promotion).await
            }
            DesktopUpdateRegistryBackend::Postgres(store) => {
                store.record_promotion(promotion).await
            }
        }
    }

    async fn get_download_insights(
        &self,
        params: ResolvedDesktopDownloadInsightsParams,
    ) -> Result<DesktopDownloadInsights, DesktopUpdateRegistryError> {
        match &self.backend {
            DesktopUpdateRegistryBackend::InMemory(store) => {
                let guard = store.read().await;
                build_download_insights_from_events(&guard.recent_events, params)
            }
            DesktopUpdateRegistryBackend::Postgres(store) => {
                store.get_download_insights(params).await
            }
        }
    }
}

impl PostgresDesktopUpdateRegistry {
    async fn ensure_tables(&self) -> Result<(), DesktopUpdateRegistryError> {
        self.tables_ready
            .get_or_try_init(|| async {
                ensure_desktop_update_tables(&self.pool)
                    .await
                    .map_err(desktop_internal)?;
                Ok(())
            })
            .await
            .map(|_| ())
    }

    async fn list_device_states(
        &self,
        params: ResolvedDesktopDeviceStateListParams,
    ) -> Result<Vec<DesktopUpdateDeviceState>, DesktopUpdateRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(desktop_internal)?;
        let mut bindings: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();
        // Leave any historical rows from retired channels untouched while
        // keeping them out of the two-channel product surface.
        let mut clauses = vec!["channel in ('internal', 'stable')".to_string()];

        if let Some(channel) = params.channel {
            bindings.push(Box::new(channel.to_string()));
            clauses.push(format!("channel = ${}", bindings.len()));
        }
        if let Some(before_seen_at) = params.before_seen_at {
            bindings.push(Box::new(before_seen_at));
            clauses.push(format!("last_seen_at < ${}", bindings.len()));
        }
        if params.attention_only {
            clauses.push("(phase = 'error' or last_error is not null)".to_string());
        }
        if let Some(query) = params.query {
            bindings.push(Box::new(format!("%{query}%")));
            let placeholder = bindings.len();
            clauses.push(format!(
                "(device_id ilike ${placeholder} or channel ilike ${placeholder} or current_version ilike ${placeholder} or coalesce(available_version, '') ilike ${placeholder} or coalesce(last_error, '') ilike ${placeholder})"
            ));
        }

        let mut sql = String::from(
            "select device_id, channel, current_version, available_version, phase, feed_url,
                    platform, arch, last_seen_at, last_event_type, last_event_at, last_checked_at,
                    last_downloaded_at, last_error
               from desktop_update_device_states",
        );
        sql.push_str(" where ");
        sql.push_str(&clauses.join(" and "));
        bindings.push(Box::new(params.limit));
        sql.push_str(&format!(
            " order by last_seen_at desc limit ${}",
            bindings.len()
        ));
        let query_params = bindings
            .iter()
            .map(|value| value.as_ref() as &(dyn ToSql + Sync))
            .collect::<Vec<_>>();
        let rows = connection
            .query(sql.as_str(), &query_params)
            .await
            .map_err(desktop_internal)?;
        rows.into_iter().map(map_desktop_device_state_row).collect()
    }

    async fn list_events(
        &self,
        params: ResolvedDesktopEventListParams,
    ) -> Result<Vec<DesktopUpdateEvent>, DesktopUpdateRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(desktop_internal)?;
        let mut bindings: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();
        // Leave any historical rows from retired channels untouched while
        // keeping them out of the two-channel product surface.
        let mut clauses = vec!["channel in ('internal', 'stable')".to_string()];

        if let Some(channel) = params.channel {
            bindings.push(Box::new(channel.to_string()));
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
                "(device_id ilike ${placeholder} or channel ilike ${placeholder} or current_version ilike ${placeholder} or coalesce(available_version, '') ilike ${placeholder} or phase ilike ${placeholder} or event_type ilike ${placeholder})"
            ));
        }

        let mut sql = String::from(
            "select event_id, event_type, occurred_at, device_id, channel, current_version,
                    available_version, phase, feed_url, platform, arch, country_code, properties
               from desktop_update_events",
        );
        sql.push_str(" where ");
        sql.push_str(&clauses.join(" and "));
        bindings.push(Box::new(params.limit));
        sql.push_str(&format!(
            " order by occurred_at desc limit ${}",
            bindings.len()
        ));
        let query_params = bindings
            .iter()
            .map(|value| value.as_ref() as &(dyn ToSql + Sync))
            .collect::<Vec<_>>();
        let rows = connection
            .query(sql.as_str(), &query_params)
            .await
            .map_err(desktop_internal)?;
        rows.into_iter().map(map_desktop_event_row).collect()
    }

    async fn list_promotions(
        &self,
        params: ResolvedDesktopPromotionListParams,
    ) -> Result<Vec<DesktopPromotionRecord>, DesktopUpdateRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(desktop_internal)?;
        let mut bindings: Vec<Box<dyn ToSql + Sync + Send>> = Vec::new();
        // Promotions from retired routes remain in storage for audit, but are
        // no longer part of the active desktop release model.
        let mut clauses = vec![
            "source_channel in ('internal', 'stable')".to_string(),
            "target_channel in ('internal', 'stable')".to_string(),
        ];

        if let Some(target_channel) = params.target_channel {
            bindings.push(Box::new(target_channel.to_string()));
            clauses.push(format!("target_channel = ${}", bindings.len()));
        }
        if let Some(before_requested_at) = params.before_requested_at {
            bindings.push(Box::new(before_requested_at));
            clauses.push(format!("requested_at < ${}", bindings.len()));
        }
        if let Some(query) = params.query {
            bindings.push(Box::new(format!("%{query}%")));
            let placeholder = bindings.len();
            clauses.push(format!(
                "(source_channel ilike ${placeholder} or target_channel ilike ${placeholder} or requested_by ilike ${placeholder} or workflow_ref ilike ${placeholder} or coalesce(notes, '') ilike ${placeholder})"
            ));
        }

        let mut sql = String::from(
            "select request_id, source_channel, target_channel, workflow_ref, requested_at,
                    requested_by, status, notes
               from desktop_update_promotions",
        );
        sql.push_str(" where ");
        sql.push_str(&clauses.join(" and "));
        bindings.push(Box::new(params.limit));
        sql.push_str(&format!(
            " order by requested_at desc limit ${}",
            bindings.len()
        ));
        let query_params = bindings
            .iter()
            .map(|value| value.as_ref() as &(dyn ToSql + Sync))
            .collect::<Vec<_>>();
        let rows = connection
            .query(sql.as_str(), &query_params)
            .await
            .map_err(desktop_internal)?;
        rows.into_iter().map(map_desktop_promotion_row).collect()
    }

    async fn get_download_insights(
        &self,
        params: ResolvedDesktopDownloadInsightsParams,
    ) -> Result<DesktopDownloadInsights, DesktopUpdateRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(desktop_internal)?;
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
                        count(*) filter (where event_type = 'update_ready') as ready,
                        count(*) filter (where event_type = 'install_applied') as applied,
                        count(*) filter (where event_type = 'update_error') as errors
                   from desktop_update_events
                  where {}
               group by timezone('UTC', occurred_at)::date
               order by timezone('UTC', occurred_at)::date asc",
                clauses.join(" and ")
            );
            connection
                .query(sql.as_str(), &query_params)
                .await
                .map_err(desktop_internal)?
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
                        count(*) filter (where event_type = 'update_ready') as ready,
                        count(*) filter (where event_type = 'install_applied') as applied,
                        count(*) filter (where event_type = 'update_error') as errors
                   from desktop_update_events
                  where {}
               group by channel
               order by channel asc",
                clauses.join(" and ")
            );
            connection
                .query(sql.as_str(), &query_params)
                .await
                .map_err(desktop_internal)?
        };

        let by_platform_rows = {
            let (clauses, bindings) =
                build_download_insight_query_parts(&params, start_at, end_exclusive);
            let query_params = bindings
                .iter()
                .map(|value| value.as_ref() as &(dyn ToSql + Sync))
                .collect::<Vec<_>>();
            let sql = format!(
                "select coalesce(nullif(platform, ''), 'unknown') as platform,
                        count(*) filter (where event_type = 'download_started') as started,
                        count(*) filter (where event_type = 'download_completed') as completed,
                        count(*) filter (where event_type = 'update_ready') as ready,
                        count(*) filter (where event_type = 'install_applied') as applied,
                        count(*) filter (where event_type = 'update_error') as errors
                   from desktop_update_events
                  where {}
               group by coalesce(nullif(platform, ''), 'unknown')
               order by started desc, completed desc, platform asc",
                clauses.join(" and ")
            );
            connection
                .query(sql.as_str(), &query_params)
                .await
                .map_err(desktop_internal)?
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
                        count(*) filter (where event_type = 'update_ready') as ready,
                        count(*) filter (where event_type = 'install_applied') as applied,
                        count(*) filter (where event_type = 'update_error') as errors
                   from desktop_update_events
                  where {}
               group by coalesce(nullif(country_code, ''), 'unknown')
               order by started desc, completed desc, country_code asc",
                clauses.join(" and ")
            );
            connection
                .query(sql.as_str(), &query_params)
                .await
                .map_err(desktop_internal)?
        };

        Ok(build_download_insights_response(
            params,
            start_day,
            end_day,
            daily_rows
                .into_iter()
                .map(|row| {
                    let day = row.get::<_, NaiveDate>("day");
                    let counts = DesktopDownloadInsightCounts {
                        started: row.get("started"),
                        completed: row.get("completed"),
                        ready: row.get("ready"),
                        applied: row.get("applied"),
                        errors: row.get("errors"),
                    };
                    (day, counts)
                })
                .collect(),
            by_channel_rows
                .into_iter()
                .map(|row| {
                    let channel =
                        DesktopReleaseChannel::from_str(row.get::<_, String>("channel").as_str())?;
                    let counts = DesktopDownloadInsightCounts {
                        started: row.get("started"),
                        completed: row.get("completed"),
                        ready: row.get("ready"),
                        applied: row.get("applied"),
                        errors: row.get("errors"),
                    };
                    Ok((channel.to_string(), counts))
                })
                .collect::<Result<Vec<_>, DesktopUpdateRegistryError>>()?,
            by_platform_rows
                .into_iter()
                .map(|row| {
                    let platform = row.get::<_, String>("platform");
                    let counts = DesktopDownloadInsightCounts {
                        started: row.get("started"),
                        completed: row.get("completed"),
                        ready: row.get("ready"),
                        applied: row.get("applied"),
                        errors: row.get("errors"),
                    };
                    (platform, counts)
                })
                .collect(),
            by_country_rows
                .into_iter()
                .map(|row| {
                    let country = row.get::<_, String>("country_code");
                    let counts = DesktopDownloadInsightCounts {
                        started: row.get("started"),
                        completed: row.get("completed"),
                        ready: row.get("ready"),
                        applied: row.get("applied"),
                        errors: row.get("errors"),
                    };
                    (country, counts)
                })
                .collect(),
        ))
    }

    async fn get_promotion(
        &self,
        request_id: &str,
    ) -> Result<Option<DesktopPromotionRecord>, DesktopUpdateRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(desktop_internal)?;
        let row = connection
            .query_opt(
                "select request_id, source_channel, target_channel, workflow_ref, requested_at,
                        requested_by, status, notes
                  from desktop_update_promotions
                  where request_id = $1
                    and source_channel in ('internal', 'stable')
                    and target_channel in ('internal', 'stable')",
                &[&request_id],
            )
            .await
            .map_err(desktop_internal)?;
        row.map(map_desktop_promotion_row).transpose()
    }

    async fn record_event(
        &self,
        event: DesktopUpdateEvent,
    ) -> Result<DesktopUpdateEvent, DesktopUpdateRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(desktop_internal)?;
        connection
            .execute(
                "insert into desktop_update_events (
                    event_id, event_type, occurred_at, device_id, channel, current_version,
                    available_version, phase, feed_url, platform, arch, country_code, properties
                 ) values (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12, $13
                 )
                 on conflict (event_id) do update set
                    event_type = excluded.event_type,
                    occurred_at = excluded.occurred_at,
                    device_id = excluded.device_id,
                    channel = excluded.channel,
                    current_version = excluded.current_version,
                    available_version = excluded.available_version,
                    phase = excluded.phase,
                    feed_url = excluded.feed_url,
                    platform = excluded.platform,
                    arch = excluded.arch,
                    country_code = excluded.country_code,
                    properties = excluded.properties",
                &[
                    &event.event_id,
                    &event.event_type.to_string(),
                    &event.occurred_at,
                    &event.device_id,
                    &event.channel.to_string(),
                    &event.current_version,
                    &event.available_version,
                    &event.phase.to_string(),
                    &event.feed_url,
                    &event.platform,
                    &event.arch,
                    &event.country_code,
                    &PgJson(properties_to_json(&event.properties)),
                ],
            )
            .await
            .map_err(desktop_internal)?;
        connection
            .execute(
                "delete from desktop_update_events
                  where event_id in (
                        select event_id
                          from desktop_update_events
                      order by occurred_at desc
                         offset $1
                  )",
                &[&MAX_STORED_EVENTS],
            )
            .await
            .map_err(desktop_internal)?;

        let last_error = event
            .properties
            .get("reason")
            .and_then(JsonValue::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        let last_checked_at = if matches!(
            event.event_type,
            DesktopUpdateEventType::UpdateAvailable | DesktopUpdateEventType::UpdateNotAvailable
        ) {
            Some(event.occurred_at)
        } else {
            None
        };
        let last_downloaded_at = if matches!(
            event.event_type,
            DesktopUpdateEventType::DownloadCompleted
                | DesktopUpdateEventType::UpdateReady
                | DesktopUpdateEventType::InstallApplied
        ) {
            Some(event.occurred_at)
        } else {
            None
        };

        connection
            .execute(
                "insert into desktop_update_device_states (
                    device_id, channel, current_version, available_version, phase, feed_url,
                    platform, arch, last_seen_at, last_event_type, last_event_at, last_checked_at,
                    last_downloaded_at, last_error
                 ) values (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12,
                    $13, $14
                 )
                 on conflict (device_id) do update set
                    channel = excluded.channel,
                    current_version = excluded.current_version,
                    available_version = coalesce(excluded.available_version, desktop_update_device_states.available_version),
                    phase = excluded.phase,
                    feed_url = excluded.feed_url,
                    platform = excluded.platform,
                    arch = excluded.arch,
                    last_seen_at = excluded.last_seen_at,
                    last_event_type = excluded.last_event_type,
                    last_event_at = excluded.last_event_at,
                    last_checked_at = coalesce(excluded.last_checked_at, desktop_update_device_states.last_checked_at),
                    last_downloaded_at = coalesce(excluded.last_downloaded_at, desktop_update_device_states.last_downloaded_at),
                    last_error = excluded.last_error,
                    updated_at = now()",
                &[
                    &event.device_id,
                    &event.channel.to_string(),
                    &event.current_version,
                    &event.available_version,
                    &event.phase.to_string(),
                    &event.feed_url,
                    &event.platform,
                    &event.arch,
                    &event.occurred_at,
                    &Some(event.event_type.to_string()),
                    &Some(event.occurred_at),
                    &last_checked_at,
                    &last_downloaded_at,
                    &last_error,
                ],
            )
            .await
            .map_err(desktop_internal)?;

        Ok(event)
    }

    async fn record_promotion(
        &self,
        promotion: DesktopPromotionRecord,
    ) -> Result<DesktopPromotionRecord, DesktopUpdateRegistryError> {
        self.ensure_tables().await?;
        let connection = self.pool.get().await.map_err(desktop_internal)?;
        let row = connection
            .query_one(
                "insert into desktop_update_promotions (
                    request_id, source_channel, target_channel, workflow_ref, requested_at,
                    requested_by, status, notes
                 ) values ($1, $2, $3, $4, $5, $6, $7, $8)
                 on conflict (request_id) do update set
                    source_channel = excluded.source_channel,
                    target_channel = excluded.target_channel,
                    workflow_ref = excluded.workflow_ref,
                    requested_at = excluded.requested_at,
                    requested_by = excluded.requested_by,
                    status = excluded.status,
                    notes = excluded.notes
                 returning request_id, source_channel, target_channel, workflow_ref, requested_at,
                           requested_by, status, notes",
                &[
                    &promotion.request_id,
                    &promotion.source_channel.to_string(),
                    &promotion.target_channel.to_string(),
                    &promotion.workflow_ref,
                    &promotion.requested_at,
                    &promotion.requested_by,
                    &promotion.status.to_string(),
                    &promotion.notes,
                ],
            )
            .await
            .map_err(desktop_internal)?;
        connection
            .execute(
                "delete from desktop_update_promotions
                  where request_id in (
                        select request_id
                          from desktop_update_promotions
                      order by requested_at desc
                         offset $1
                  )",
                &[&MAX_STORED_PROMOTIONS],
            )
            .await
            .map_err(desktop_internal)?;
        map_desktop_promotion_row(row)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopReleaseChannel {
    Internal,
    Stable,
}

impl fmt::Display for DesktopReleaseChannel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Internal => f.write_str("internal"),
            Self::Stable => f.write_str("stable"),
        }
    }
}

impl FromStr for DesktopReleaseChannel {
    type Err = DesktopUpdateRegistryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "internal" => Ok(Self::Internal),
            "stable" => Ok(Self::Stable),
            _ => Err(DesktopUpdateRegistryError::Invalid(
                "channel must be one of internal or stable".to_string(),
            )),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopUpdatePhase {
    Idle,
    Checking,
    UpdateAvailable,
    Downloading,
    Downloaded,
    UpToDate,
    Error,
}

impl fmt::Display for DesktopUpdatePhase {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Idle => f.write_str("idle"),
            Self::Checking => f.write_str("checking"),
            Self::UpdateAvailable => f.write_str("update_available"),
            Self::Downloading => f.write_str("downloading"),
            Self::Downloaded => f.write_str("downloaded"),
            Self::UpToDate => f.write_str("up_to_date"),
            Self::Error => f.write_str("error"),
        }
    }
}

impl FromStr for DesktopUpdatePhase {
    type Err = DesktopUpdateRegistryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "idle" => Ok(Self::Idle),
            "checking" => Ok(Self::Checking),
            "update_available" => Ok(Self::UpdateAvailable),
            "downloading" => Ok(Self::Downloading),
            "downloaded" => Ok(Self::Downloaded),
            "up_to_date" => Ok(Self::UpToDate),
            "error" => Ok(Self::Error),
            _ => Err(DesktopUpdateRegistryError::Invalid(format!(
                "invalid desktop phase '{}'",
                value
            ))),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopUpdateEventType {
    UpdateAvailable,
    UpdateNotAvailable,
    DownloadStarted,
    DownloadCompleted,
    UpdateReady,
    InstallApplied,
    UpdateError,
}

impl fmt::Display for DesktopUpdateEventType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UpdateAvailable => f.write_str("update_available"),
            Self::UpdateNotAvailable => f.write_str("update_not_available"),
            Self::DownloadStarted => f.write_str("download_started"),
            Self::DownloadCompleted => f.write_str("download_completed"),
            Self::UpdateReady => f.write_str("update_ready"),
            Self::InstallApplied => f.write_str("install_applied"),
            Self::UpdateError => f.write_str("update_error"),
        }
    }
}

impl FromStr for DesktopUpdateEventType {
    type Err = DesktopUpdateRegistryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "update_available" => Ok(Self::UpdateAvailable),
            "update_not_available" => Ok(Self::UpdateNotAvailable),
            "download_started" => Ok(Self::DownloadStarted),
            "download_completed" => Ok(Self::DownloadCompleted),
            "update_ready" => Ok(Self::UpdateReady),
            "install_applied" => Ok(Self::InstallApplied),
            "update_error" => Ok(Self::UpdateError),
            _ => Err(DesktopUpdateRegistryError::Invalid(format!(
                "invalid desktop event type '{}'",
                value
            ))),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopPromotionStatus {
    Dispatched,
}

impl fmt::Display for DesktopPromotionStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Dispatched => f.write_str("dispatched"),
        }
    }
}

impl FromStr for DesktopPromotionStatus {
    type Err = DesktopUpdateRegistryError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "dispatched" => Ok(Self::Dispatched),
            _ => Err(DesktopUpdateRegistryError::Invalid(format!(
                "invalid desktop promotion status '{}'",
                value
            ))),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct DesktopUpdateDeviceState {
    pub(crate) device_id: String,
    pub(crate) channel: DesktopReleaseChannel,
    pub(crate) current_version: String,
    pub(crate) phase: DesktopUpdatePhase,
    pub(crate) feed_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) arch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) available_version: Option<String>,
    pub(crate) last_seen_at: DateTime<Utc>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_event_type: Option<DesktopUpdateEventType>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_event_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_checked_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_downloaded_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct DesktopUpdateEvent {
    pub(crate) event_id: String,
    pub(crate) event_type: DesktopUpdateEventType,
    pub(crate) occurred_at: DateTime<Utc>,
    pub(crate) device_id: String,
    pub(crate) channel: DesktopReleaseChannel,
    pub(crate) current_version: String,
    pub(crate) phase: DesktopUpdatePhase,
    pub(crate) feed_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) arch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) available_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) country_code: Option<String>,
    #[serde(default)]
    pub(crate) properties: BTreeMap<String, JsonValue>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct DesktopPromotionRecord {
    pub(crate) request_id: String,
    pub(crate) source_channel: DesktopReleaseChannel,
    pub(crate) target_channel: DesktopReleaseChannel,
    pub(crate) workflow_ref: String,
    pub(crate) requested_at: DateTime<Utc>,
    pub(crate) requested_by: String,
    pub(crate) status: DesktopPromotionStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) notes: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DesktopPromotionRequest {
    pub(crate) source_channel: DesktopReleaseChannel,
    pub(crate) target_channel: DesktopReleaseChannel,
    pub(crate) requested_by: String,
    #[serde(default)]
    pub(crate) notes: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopDownloadInsightCounts {
    pub(crate) started: i64,
    pub(crate) completed: i64,
    pub(crate) ready: i64,
    pub(crate) applied: i64,
    pub(crate) errors: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopDownloadInsightDay {
    pub(crate) day: String,
    #[serde(flatten)]
    pub(crate) counts: DesktopDownloadInsightCounts,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopDownloadInsightBreakdown {
    pub(crate) key: String,
    pub(crate) label: String,
    #[serde(flatten)]
    pub(crate) counts: DesktopDownloadInsightCounts,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopDownloadInsights {
    pub(crate) days: i64,
    pub(crate) range_start: String,
    pub(crate) range_end: String,
    pub(crate) totals: DesktopDownloadInsightCounts,
    pub(crate) daily: Vec<DesktopDownloadInsightDay>,
    pub(crate) by_channel: Vec<DesktopDownloadInsightBreakdown>,
    pub(crate) by_platform: Vec<DesktopDownloadInsightBreakdown>,
    pub(crate) by_country: Vec<DesktopDownloadInsightBreakdown>,
}

#[derive(Debug)]
pub(crate) enum DesktopUpdateRegistryError {
    Invalid(String),
    NotFound(String),
    Internal(anyhow::Error),
}

impl DesktopUpdateRegistryError {
    fn into_response(self) -> (StatusCode, Json<ApiError>) {
        match self {
            Self::Invalid(message) => bad_request(message),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, Json(ApiError::new(message))),
            Self::Internal(error) => internal_error(error.to_string()),
        }
    }
}

impl fmt::Display for DesktopUpdateRegistryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid(message) | Self::NotFound(message) => f.write_str(message),
            Self::Internal(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for DesktopUpdateRegistryError {}

async fn list_device_states(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Json<Vec<DesktopUpdateDeviceState>>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let params = parse_desktop_device_state_params(&uri)
        .map_err(DesktopUpdateRegistryError::into_response)?;
    Ok(Json(
        state
            .desktop_update_registry
            .list_device_states(params)
            .await
            .map_err(DesktopUpdateRegistryError::into_response)?,
    ))
}

async fn list_events(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Json<Vec<DesktopUpdateEvent>>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let params =
        parse_desktop_event_params(&uri).map_err(DesktopUpdateRegistryError::into_response)?;
    Ok(Json(
        state
            .desktop_update_registry
            .list_events(params)
            .await
            .map_err(DesktopUpdateRegistryError::into_response)?,
    ))
}

async fn list_promotions(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Json<Vec<DesktopPromotionRecord>>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let params =
        parse_desktop_promotion_params(&uri).map_err(DesktopUpdateRegistryError::into_response)?;
    Ok(Json(
        state
            .desktop_update_registry
            .list_promotions(params)
            .await
            .map_err(DesktopUpdateRegistryError::into_response)?,
    ))
}

async fn get_download_insights(
    State(state): State<AppState>,
    uri: Uri,
    headers: HeaderMap,
) -> Result<Json<DesktopDownloadInsights>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let params = parse_desktop_download_insights_params(&uri)
        .map_err(DesktopUpdateRegistryError::into_response)?;
    Ok(Json(
        state
            .desktop_update_registry
            .get_download_insights(params)
            .await
            .map_err(DesktopUpdateRegistryError::into_response)?,
    ))
}

async fn get_promotion(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(request_id): AxumPath<String>,
) -> Result<Json<DesktopPromotionRecord>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let request_id = normalize_non_empty(&request_id, "request_id")
        .map_err(DesktopUpdateRegistryError::into_response)?;
    let record = state
        .desktop_update_registry
        .get_promotion(&request_id)
        .await
        .map_err(DesktopUpdateRegistryError::into_response)?
        .ok_or_else(|| {
            DesktopUpdateRegistryError::NotFound(format!(
                "desktop promotion '{}' was not found",
                request_id
            ))
        })
        .map_err(DesktopUpdateRegistryError::into_response)?;
    Ok(Json(record))
}

async fn post_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut event): Json<DesktopUpdateEvent>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    event.country_code = extract_country_code_from_headers(&headers);
    state
        .desktop_update_registry
        .record_event(event)
        .await
        .map_err(DesktopUpdateRegistryError::into_response)?;
    Ok(StatusCode::ACCEPTED)
}

async fn request_promotion(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DesktopPromotionRequest>,
) -> Result<(StatusCode, Json<DesktopPromotionRecord>), (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;

    let workflow_ref = dispatch_desktop_promotion_workflow(&state, &request)
        .await
        .map_err(DesktopUpdateRegistryError::into_response)?;
    let stored = state
        .desktop_update_registry
        .record_promotion(DesktopPromotionRecord {
            request_id: Uuid::new_v4().to_string(),
            source_channel: request.source_channel,
            target_channel: request.target_channel,
            workflow_ref,
            requested_at: Utc::now(),
            requested_by: request.requested_by,
            status: DesktopPromotionStatus::Dispatched,
            notes: request.notes,
        })
        .await
        .map_err(DesktopUpdateRegistryError::into_response)?;
    Ok((StatusCode::CREATED, Json(stored)))
}

async fn dispatch_desktop_promotion_workflow(
    state: &AppState,
    request: &DesktopPromotionRequest,
) -> Result<String, DesktopUpdateRegistryError> {
    validate_desktop_promotion_route(request.source_channel, request.target_channel)?;

    let owner = state
        .config
        .desktop_release_github_owner
        .as_deref()
        .ok_or_else(|| {
            DesktopUpdateRegistryError::Invalid(
                "desktop release GitHub owner is not configured".to_string(),
            )
        })?;
    let repo = state
        .config
        .desktop_release_github_repo
        .as_deref()
        .ok_or_else(|| {
            DesktopUpdateRegistryError::Invalid(
                "desktop release GitHub repo is not configured".to_string(),
            )
        })?;
    let token = state
        .config
        .desktop_release_github_token
        .as_deref()
        .ok_or_else(|| {
            DesktopUpdateRegistryError::Invalid(
                "desktop release GitHub token is not configured".to_string(),
            )
        })?;
    let payload = serde_json::json!({
        "ref": DESKTOP_PROMOTION_WORKFLOW_REF,
        "inputs": {
            "source_channel": request.source_channel.to_string(),
            "target_channel": request.target_channel.to_string(),
        }
    });
    let url = format!(
        "{GITHUB_API_BASE_URL}/repos/{owner}/{repo}/actions/workflows/{}/dispatches",
        state.config.desktop_release_promote_workflow
    );
    let response = state
        .http_client
        .post(url)
        .header("accept", "application/vnd.github+json")
        .header("authorization", format!("Bearer {token}"))
        .header("x-github-api-version", GITHUB_API_VERSION)
        .header("user-agent", "instafy-runtime-controller/desktop-updates")
        .json(&payload)
        .send()
        .await
        .map_err(desktop_internal)?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(DesktopUpdateRegistryError::Internal(anyhow::anyhow!(
            "GitHub workflow dispatch failed ({status}): {text}"
        )));
    }

    Ok(DESKTOP_PROMOTION_WORKFLOW_REF.to_string())
}

fn validate_desktop_promotion_route(
    source_channel: DesktopReleaseChannel,
    target_channel: DesktopReleaseChannel,
) -> Result<(), DesktopUpdateRegistryError> {
    if source_channel != DesktopReleaseChannel::Stable
        || target_channel != DesktopReleaseChannel::Internal
    {
        return Err(DesktopUpdateRegistryError::Invalid(
            "desktop channel copying only supports stable to internal".to_string(),
        ));
    }

    Ok(())
}

fn parse_desktop_device_state_params(
    uri: &Uri,
) -> Result<ResolvedDesktopDeviceStateListParams, DesktopUpdateRegistryError> {
    let params = parse_query_map(uri)?;
    Ok(ResolvedDesktopDeviceStateListParams {
        limit: clamp_list_limit(
            parse_i64_param(&params, "limit")?,
            DEFAULT_DEVICE_LIMIT,
            MAX_DEVICE_LIMIT,
        )?,
        channel: params
            .get("channel")
            .map(String::as_str)
            .map(DesktopReleaseChannel::from_str)
            .transpose()?,
        query: params
            .get("query")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        attention_only: parse_bool_param(&params, "attention_only")?.unwrap_or(false),
        before_seen_at: parse_datetime_param(&params, "before_seen_at")?,
    })
}

fn parse_desktop_event_params(
    uri: &Uri,
) -> Result<ResolvedDesktopEventListParams, DesktopUpdateRegistryError> {
    let params = parse_query_map(uri)?;
    Ok(ResolvedDesktopEventListParams {
        limit: clamp_list_limit(
            parse_i64_param(&params, "limit")?,
            DEFAULT_EVENT_LIMIT,
            MAX_EVENT_LIMIT,
        )?,
        channel: params
            .get("channel")
            .map(String::as_str)
            .map(DesktopReleaseChannel::from_str)
            .transpose()?,
        event_type: params
            .get("event_type")
            .map(String::as_str)
            .map(DesktopUpdateEventType::from_str)
            .transpose()?,
        query: params
            .get("query")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        before_occurred_at: parse_datetime_param(&params, "before_occurred_at")?,
    })
}

fn parse_desktop_promotion_params(
    uri: &Uri,
) -> Result<ResolvedDesktopPromotionListParams, DesktopUpdateRegistryError> {
    let params = parse_query_map(uri)?;
    Ok(ResolvedDesktopPromotionListParams {
        limit: clamp_list_limit(
            parse_i64_param(&params, "limit")?,
            DEFAULT_PROMOTION_LIMIT,
            MAX_PROMOTION_LIMIT,
        )?,
        target_channel: params
            .get("target_channel")
            .map(String::as_str)
            .map(DesktopReleaseChannel::from_str)
            .transpose()?,
        query: params
            .get("query")
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        before_requested_at: parse_datetime_param(&params, "before_requested_at")?,
    })
}

fn parse_desktop_download_insights_params(
    uri: &Uri,
) -> Result<ResolvedDesktopDownloadInsightsParams, DesktopUpdateRegistryError> {
    let params = parse_query_map(uri)?;
    Ok(ResolvedDesktopDownloadInsightsParams {
        days: clamp_positive_i64(
            parse_i64_param(&params, "days")?,
            DEFAULT_DOWNLOAD_INSIGHTS_DAYS,
            MAX_DOWNLOAD_INSIGHTS_DAYS,
            "days",
        )?,
        channel: params
            .get("channel")
            .map(String::as_str)
            .map(DesktopReleaseChannel::from_str)
            .transpose()?,
    })
}

fn desktop_device_matches_filters(
    device: &DesktopUpdateDeviceState,
    params: &ResolvedDesktopDeviceStateListParams,
) -> bool {
    if let Some(channel) = params.channel {
        if device.channel != channel {
            return false;
        }
    }
    if let Some(before_seen_at) = params.before_seen_at {
        if device.last_seen_at >= before_seen_at {
            return false;
        }
    }
    if params.attention_only
        && device.phase != DesktopUpdatePhase::Error
        && device.last_error.is_none()
    {
        return false;
    }
    if let Some(query) = params.query.as_ref() {
        let haystack = [
            device.device_id.as_str(),
            &device.channel.to_string(),
            device.current_version.as_str(),
            device.available_version.as_deref().unwrap_or(""),
            device.last_error.as_deref().unwrap_or(""),
        ]
        .join(" ")
        .to_ascii_lowercase();
        if !tokenize(query).iter().all(|term| haystack.contains(term)) {
            return false;
        }
    }
    true
}

fn desktop_event_matches_filters(
    event: &DesktopUpdateEvent,
    params: &ResolvedDesktopEventListParams,
) -> bool {
    if let Some(channel) = params.channel {
        if event.channel != channel {
            return false;
        }
    }
    if let Some(event_type) = params.event_type {
        if event.event_type != event_type {
            return false;
        }
    }
    if let Some(before_occurred_at) = params.before_occurred_at {
        if event.occurred_at >= before_occurred_at {
            return false;
        }
    }
    if let Some(query) = params.query.as_ref() {
        let haystack = [
            event.device_id.as_str(),
            &event.channel.to_string(),
            event.current_version.as_str(),
            event.available_version.as_deref().unwrap_or(""),
            &event.phase.to_string(),
            &event.event_type.to_string(),
        ]
        .join(" ")
        .to_ascii_lowercase();
        if !tokenize(query).iter().all(|term| haystack.contains(term)) {
            return false;
        }
    }
    true
}

fn desktop_promotion_matches_filters(
    promotion: &DesktopPromotionRecord,
    params: &ResolvedDesktopPromotionListParams,
) -> bool {
    if let Some(target_channel) = params.target_channel {
        if promotion.target_channel != target_channel {
            return false;
        }
    }
    if let Some(before_requested_at) = params.before_requested_at {
        if promotion.requested_at >= before_requested_at {
            return false;
        }
    }
    if let Some(query) = params.query.as_ref() {
        let haystack = [
            &promotion.source_channel.to_string(),
            &promotion.target_channel.to_string(),
            promotion.requested_by.as_str(),
            promotion.workflow_ref.as_str(),
            promotion.notes.as_deref().unwrap_or(""),
        ]
        .join(" ")
        .to_ascii_lowercase();
        if !tokenize(query).iter().all(|term| haystack.contains(term)) {
            return false;
        }
    }
    true
}

async fn record_event_in_memory(
    store: &Arc<RwLock<DesktopUpdateSnapshot>>,
    event: DesktopUpdateEvent,
) -> Result<DesktopUpdateEvent, DesktopUpdateRegistryError> {
    let mut guard = store.write().await;
    let event_type = event.event_type;
    let occurred_at = event.occurred_at;
    let last_error = extract_reason(&event.properties);
    let last_checked_at = if matches!(
        event_type,
        DesktopUpdateEventType::UpdateAvailable | DesktopUpdateEventType::UpdateNotAvailable
    ) {
        Some(occurred_at)
    } else {
        None
    };
    let last_downloaded_at = if matches!(
        event_type,
        DesktopUpdateEventType::DownloadCompleted
            | DesktopUpdateEventType::UpdateReady
            | DesktopUpdateEventType::InstallApplied
    ) {
        Some(occurred_at)
    } else {
        None
    };

    let row = guard
        .device_states
        .entry(event.device_id.clone())
        .or_insert_with(|| DesktopUpdateDeviceState {
            device_id: event.device_id.clone(),
            channel: event.channel,
            current_version: event.current_version.clone(),
            phase: event.phase,
            feed_url: event.feed_url.clone(),
            platform: event.platform.clone(),
            arch: event.arch.clone(),
            available_version: event.available_version.clone(),
            last_seen_at: occurred_at,
            last_event_type: Some(event_type),
            last_event_at: Some(occurred_at),
            last_checked_at,
            last_downloaded_at,
            last_error: last_error.clone(),
        });
    row.channel = event.channel;
    row.current_version = event.current_version.clone();
    row.phase = event.phase;
    row.feed_url = event.feed_url.clone();
    row.platform = event.platform.clone();
    row.arch = event.arch.clone();
    if event.available_version.is_some() {
        row.available_version = event.available_version.clone();
    }
    row.last_seen_at = occurred_at;
    row.last_event_type = Some(event_type);
    row.last_event_at = Some(occurred_at);
    if last_checked_at.is_some() {
        row.last_checked_at = last_checked_at;
    }
    if last_downloaded_at.is_some() {
        row.last_downloaded_at = last_downloaded_at;
    }
    row.last_error = last_error;

    guard.recent_events.push(event.clone());
    guard
        .recent_events
        .sort_by(|left, right| right.occurred_at.cmp(&left.occurred_at));
    guard.recent_events.truncate(MAX_STORED_EVENTS as usize);
    Ok(event)
}

async fn record_promotion_in_memory(
    store: &Arc<RwLock<DesktopUpdateSnapshot>>,
    promotion: DesktopPromotionRecord,
) -> Result<DesktopPromotionRecord, DesktopUpdateRegistryError> {
    let mut guard = store.write().await;
    guard.promotions.push(promotion.clone());
    guard
        .promotions
        .sort_by(|left, right| right.requested_at.cmp(&left.requested_at));
    guard.promotions.truncate(MAX_STORED_PROMOTIONS as usize);
    Ok(promotion)
}

fn normalize_desktop_event(
    event: &mut DesktopUpdateEvent,
) -> Result<(), DesktopUpdateRegistryError> {
    event.event_id = normalize_non_empty(&event.event_id, "event_id")?;
    event.device_id = normalize_non_empty(&event.device_id, "device_id")?;
    event.current_version = normalize_non_empty(&event.current_version, "current_version")?;
    event.feed_url = normalize_non_empty(&event.feed_url, "feed_url")?;
    event.platform = normalize_optional(&event.platform);
    event.arch = normalize_optional(&event.arch);
    event.available_version = normalize_optional(&event.available_version);
    event.country_code = normalize_optional(&event.country_code)
        .map(|value| value.to_ascii_uppercase())
        .filter(|value| value.len() == 2 && value.chars().all(|ch| ch.is_ascii_uppercase()));
    Ok(())
}

fn normalize_desktop_promotion(
    promotion: &mut DesktopPromotionRecord,
) -> Result<(), DesktopUpdateRegistryError> {
    promotion.request_id = normalize_non_empty(&promotion.request_id, "request_id")?;
    promotion.workflow_ref = normalize_non_empty(&promotion.workflow_ref, "workflow_ref")?;
    promotion.requested_by = normalize_non_empty(&promotion.requested_by, "requested_by")?;
    promotion.notes = normalize_optional(&promotion.notes);
    Ok(())
}

fn normalize_non_empty(value: &str, field: &str) -> Result<String, DesktopUpdateRegistryError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(DesktopUpdateRegistryError::Invalid(format!(
            "{field} is required"
        )));
    }
    Ok(trimmed.to_string())
}

fn normalize_optional(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn tokenize(value: &str) -> Vec<String> {
    value
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| part.to_ascii_lowercase())
        .collect()
}

fn extract_reason(properties: &BTreeMap<String, JsonValue>) -> Option<String> {
    properties
        .get("reason")
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn build_download_insights_from_events(
    events: &[DesktopUpdateEvent],
    params: ResolvedDesktopDownloadInsightsParams,
) -> Result<DesktopDownloadInsights, DesktopUpdateRegistryError> {
    let (start_day, end_day, start_at, end_exclusive) = resolve_download_window(params.days)?;
    let mut daily_rows = Vec::new();
    let mut by_channel = BTreeMap::<String, DesktopDownloadInsightCounts>::new();
    let mut by_platform = BTreeMap::<String, DesktopDownloadInsightCounts>::new();
    let mut by_country = BTreeMap::<String, DesktopDownloadInsightCounts>::new();

    for event in events {
        if event.occurred_at < start_at || event.occurred_at >= end_exclusive {
            continue;
        }
        if let Some(channel) = params.channel {
            if event.channel != channel {
                continue;
            }
        }
        let mut counts = DesktopDownloadInsightCounts::default();
        if !apply_download_event_type(&mut counts, event.event_type) {
            continue;
        }
        daily_rows.push((event.occurred_at.date_naive(), counts.clone()));
        increment_counts(
            by_channel.entry(event.channel.to_string()).or_default(),
            &counts,
        );
        increment_counts(
            by_platform
                .entry(
                    event
                        .platform
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("unknown")
                        .to_string(),
                )
                .or_default(),
            &counts,
        );
        increment_counts(
            by_country
                .entry(
                    event
                        .country_code
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("unknown")
                        .to_string(),
                )
                .or_default(),
            &counts,
        );
    }

    let daily = collapse_daily_rows(daily_rows);
    Ok(build_download_insights_response(
        params,
        start_day,
        end_day,
        daily,
        by_channel.into_iter().collect(),
        by_platform.into_iter().collect(),
        by_country.into_iter().collect(),
    ))
}

fn build_download_insights_response(
    params: ResolvedDesktopDownloadInsightsParams,
    start_day: NaiveDate,
    end_day: NaiveDate,
    daily_rows: Vec<(NaiveDate, DesktopDownloadInsightCounts)>,
    by_channel_rows: Vec<(String, DesktopDownloadInsightCounts)>,
    by_platform_rows: Vec<(String, DesktopDownloadInsightCounts)>,
    by_country_rows: Vec<(String, DesktopDownloadInsightCounts)>,
) -> DesktopDownloadInsights {
    let daily_map = daily_rows.into_iter().collect::<BTreeMap<_, _>>();
    let mut totals = DesktopDownloadInsightCounts::default();
    let mut daily = Vec::new();
    let mut day = start_day;
    while day <= end_day {
        let counts = daily_map.get(&day).cloned().unwrap_or_default();
        increment_counts(&mut totals, &counts);
        daily.push(DesktopDownloadInsightDay {
            day: day.format("%Y-%m-%d").to_string(),
            counts,
        });
        let Some(next_day) = day.checked_add_signed(Duration::days(1)) else {
            break;
        };
        day = next_day;
    }

    let by_channel = build_channel_breakdown_rows(params.channel, by_channel_rows);
    let by_platform = sort_breakdown_rows(by_platform_rows);
    let by_country = sort_breakdown_rows(by_country_rows);

    DesktopDownloadInsights {
        days: params.days,
        range_start: start_day.format("%Y-%m-%d").to_string(),
        range_end: end_day.format("%Y-%m-%d").to_string(),
        totals,
        daily,
        by_channel,
        by_platform,
        by_country,
    }
}

fn sort_breakdown_rows(
    rows: Vec<(String, DesktopDownloadInsightCounts)>,
) -> Vec<DesktopDownloadInsightBreakdown> {
    let mut breakdown = rows
        .into_iter()
        .map(|(label, counts)| DesktopDownloadInsightBreakdown {
            key: label.clone(),
            label,
            counts,
        })
        .collect::<Vec<_>>();
    breakdown.sort_by(|left, right| {
        right
            .counts
            .started
            .cmp(&left.counts.started)
            .then(right.counts.completed.cmp(&left.counts.completed))
            .then(left.label.cmp(&right.label))
    });
    breakdown
}

fn build_channel_breakdown_rows(
    channel_filter: Option<DesktopReleaseChannel>,
    rows: Vec<(String, DesktopDownloadInsightCounts)>,
) -> Vec<DesktopDownloadInsightBreakdown> {
    let row_map = rows.into_iter().collect::<BTreeMap<_, _>>();
    let channels = match channel_filter {
        Some(channel) => vec![channel],
        None => vec![
            DesktopReleaseChannel::Internal,
            DesktopReleaseChannel::Stable,
        ],
    };
    channels
        .into_iter()
        .map(|channel| {
            let key = channel.to_string();
            DesktopDownloadInsightBreakdown {
                key: key.clone(),
                label: key.clone(),
                counts: row_map.get(&key).cloned().unwrap_or_default(),
            }
        })
        .collect()
}

fn build_download_insight_query_parts(
    params: &ResolvedDesktopDownloadInsightsParams,
    start_at: DateTime<Utc>,
    end_exclusive: DateTime<Utc>,
) -> (Vec<String>, Vec<Box<dyn ToSql + Sync + Send>>) {
    let mut bindings: Vec<Box<dyn ToSql + Sync + Send>> =
        vec![Box::new(start_at), Box::new(end_exclusive)];
    let mut clauses = vec![
        "channel in ('internal', 'stable')".to_string(),
        "occurred_at >= $1".to_string(),
        "occurred_at < $2".to_string(),
    ];
    if let Some(channel) = params.channel {
        bindings.push(Box::new(channel.to_string()));
        clauses.push(format!("channel = ${}", bindings.len()));
    }
    (clauses, bindings)
}

fn resolve_download_window(
    days: i64,
) -> Result<(NaiveDate, NaiveDate, DateTime<Utc>, DateTime<Utc>), DesktopUpdateRegistryError> {
    let end_day = Utc::now().date_naive();
    let start_day = end_day
        .checked_sub_signed(Duration::days(days.saturating_sub(1)))
        .ok_or_else(|| {
            DesktopUpdateRegistryError::Invalid("days window underflowed".to_string())
        })?;
    let start_at = DateTime::from_naive_utc_and_offset(
        start_day.and_hms_opt(0, 0, 0).ok_or_else(|| {
            DesktopUpdateRegistryError::Invalid("invalid range start".to_string())
        })?,
        Utc,
    );
    let end_exclusive = DateTime::from_naive_utc_and_offset(
        end_day
            .checked_add_signed(Duration::days(1))
            .ok_or_else(|| {
                DesktopUpdateRegistryError::Invalid("days window overflowed".to_string())
            })?
            .and_hms_opt(0, 0, 0)
            .ok_or_else(|| DesktopUpdateRegistryError::Invalid("invalid range end".to_string()))?,
        Utc,
    );
    Ok((start_day, end_day, start_at, end_exclusive))
}

fn collapse_daily_rows(
    rows: Vec<(NaiveDate, DesktopDownloadInsightCounts)>,
) -> Vec<(NaiveDate, DesktopDownloadInsightCounts)> {
    let mut out = BTreeMap::<NaiveDate, DesktopDownloadInsightCounts>::new();
    for (day, counts) in rows {
        increment_counts(out.entry(day).or_default(), &counts);
    }
    out.into_iter().collect()
}

fn increment_counts(
    target: &mut DesktopDownloadInsightCounts,
    source: &DesktopDownloadInsightCounts,
) {
    target.started += source.started;
    target.completed += source.completed;
    target.ready += source.ready;
    target.applied += source.applied;
    target.errors += source.errors;
}

fn apply_download_event_type(
    counts: &mut DesktopDownloadInsightCounts,
    event_type: DesktopUpdateEventType,
) -> bool {
    match event_type {
        DesktopUpdateEventType::DownloadStarted => counts.started += 1,
        DesktopUpdateEventType::DownloadCompleted => counts.completed += 1,
        DesktopUpdateEventType::UpdateReady => counts.ready += 1,
        DesktopUpdateEventType::InstallApplied => counts.applied += 1,
        DesktopUpdateEventType::UpdateError => counts.errors += 1,
        DesktopUpdateEventType::UpdateAvailable | DesktopUpdateEventType::UpdateNotAvailable => {
            return false;
        }
    }
    true
}

fn parse_query_map(uri: &Uri) -> Result<BTreeMap<String, String>, DesktopUpdateRegistryError> {
    let Some(query) = uri.query() else {
        return Ok(BTreeMap::new());
    };
    let mut out = BTreeMap::new();
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut parts = pair.splitn(2, '=');
        let key = parts.next().unwrap_or_default();
        let value = parts.next().unwrap_or_default();
        let decoded_key = urlencoding::decode(key)
            .map_err(|_| {
                DesktopUpdateRegistryError::Invalid(
                    "query string is not valid URL encoding".to_string(),
                )
            })?
            .to_string();
        let decoded_value = urlencoding::decode(value)
            .map_err(|_| {
                DesktopUpdateRegistryError::Invalid(
                    "query string is not valid URL encoding".to_string(),
                )
            })?
            .to_string();
        out.insert(decoded_key, decoded_value);
    }
    Ok(out)
}

fn parse_i64_param(
    params: &BTreeMap<String, String>,
    key: &str,
) -> Result<Option<i64>, DesktopUpdateRegistryError> {
    params
        .get(key)
        .map(|value| {
            value.trim().parse::<i64>().map_err(|_| {
                DesktopUpdateRegistryError::Invalid(format!("{key} must be an integer"))
            })
        })
        .transpose()
}

fn parse_bool_param(
    params: &BTreeMap<String, String>,
    key: &str,
) -> Result<Option<bool>, DesktopUpdateRegistryError> {
    params
        .get(key)
        .map(|value| match value.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Ok(true),
            "false" | "0" | "no" => Ok(false),
            _ => Err(DesktopUpdateRegistryError::Invalid(format!(
                "{key} must be a boolean"
            ))),
        })
        .transpose()
}

fn parse_datetime_param(
    params: &BTreeMap<String, String>,
    key: &str,
) -> Result<Option<DateTime<Utc>>, DesktopUpdateRegistryError> {
    params
        .get(key)
        .map(|value| {
            DateTime::parse_from_rfc3339(value.trim())
                .map(|value| value.with_timezone(&Utc))
                .map_err(|_| {
                    DesktopUpdateRegistryError::Invalid(format!(
                        "{key} must be an RFC3339 timestamp"
                    ))
                })
        })
        .transpose()
}

fn clamp_list_limit(
    value: Option<i64>,
    default: i64,
    max: i64,
) -> Result<i64, DesktopUpdateRegistryError> {
    let value = value.unwrap_or(default);
    if value <= 0 || value > max {
        return Err(DesktopUpdateRegistryError::Invalid(format!(
            "limit must be between 1 and {max}"
        )));
    }
    Ok(value)
}

fn clamp_positive_i64(
    value: Option<i64>,
    default: i64,
    max: i64,
    field: &str,
) -> Result<i64, DesktopUpdateRegistryError> {
    let value = value.unwrap_or(default);
    if value <= 0 || value > max {
        return Err(DesktopUpdateRegistryError::Invalid(format!(
            "{field} must be between 1 and {max}"
        )));
    }
    Ok(value)
}

fn properties_to_json(properties: &BTreeMap<String, JsonValue>) -> JsonValue {
    JsonValue::Object(JsonMap::from_iter(
        properties
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    ))
}

fn map_desktop_device_state_row(
    row: Row,
) -> Result<DesktopUpdateDeviceState, DesktopUpdateRegistryError> {
    Ok(DesktopUpdateDeviceState {
        device_id: row.get("device_id"),
        channel: DesktopReleaseChannel::from_str(row.get::<_, String>("channel").as_str())?,
        current_version: row.get("current_version"),
        available_version: row.get("available_version"),
        phase: DesktopUpdatePhase::from_str(row.get::<_, String>("phase").as_str())?,
        feed_url: row.get("feed_url"),
        platform: row.get("platform"),
        arch: row.get("arch"),
        last_seen_at: row.get("last_seen_at"),
        last_event_type: row
            .get::<_, Option<String>>("last_event_type")
            .map(|value| DesktopUpdateEventType::from_str(value.as_str()))
            .transpose()?,
        last_event_at: row.get("last_event_at"),
        last_checked_at: row.get("last_checked_at"),
        last_downloaded_at: row.get("last_downloaded_at"),
        last_error: row.get("last_error"),
    })
}

fn map_desktop_event_row(row: Row) -> Result<DesktopUpdateEvent, DesktopUpdateRegistryError> {
    Ok(DesktopUpdateEvent {
        event_id: row.get("event_id"),
        event_type: DesktopUpdateEventType::from_str(row.get::<_, String>("event_type").as_str())?,
        occurred_at: row.get("occurred_at"),
        device_id: row.get("device_id"),
        channel: DesktopReleaseChannel::from_str(row.get::<_, String>("channel").as_str())?,
        current_version: row.get("current_version"),
        available_version: row.get("available_version"),
        phase: DesktopUpdatePhase::from_str(row.get::<_, String>("phase").as_str())?,
        feed_url: row.get("feed_url"),
        platform: row.get("platform"),
        arch: row.get("arch"),
        country_code: row.get("country_code"),
        properties: row
            .get::<_, PgJson<JsonValue>>("properties")
            .0
            .as_object()
            .map(|value| {
                value
                    .iter()
                    .map(|(key, value)| (key.clone(), value.clone()))
                    .collect::<BTreeMap<_, _>>()
            })
            .unwrap_or_default(),
    })
}

fn map_desktop_promotion_row(
    row: Row,
) -> Result<DesktopPromotionRecord, DesktopUpdateRegistryError> {
    Ok(DesktopPromotionRecord {
        request_id: row.get("request_id"),
        source_channel: DesktopReleaseChannel::from_str(
            row.get::<_, String>("source_channel").as_str(),
        )?,
        target_channel: DesktopReleaseChannel::from_str(
            row.get::<_, String>("target_channel").as_str(),
        )?,
        workflow_ref: row.get("workflow_ref"),
        requested_at: row.get("requested_at"),
        requested_by: row.get("requested_by"),
        status: DesktopPromotionStatus::from_str(row.get::<_, String>("status").as_str())?,
        notes: row.get("notes"),
    })
}

async fn ensure_desktop_update_tables(pool: &crate::config::PgPool) -> Result<(), anyhow::Error> {
    let connection = pool.get().await?;
    connection
        .batch_execute(
            "create table if not exists desktop_update_device_states (
                device_id text primary key,
                channel text not null check (channel in ('internal', 'stable')),
                current_version text not null,
                available_version text,
                phase text not null check (phase in ('idle', 'checking', 'update_available', 'downloading', 'downloaded', 'up_to_date', 'error')),
                feed_url text not null,
                platform text,
                arch text,
                last_seen_at timestamptz not null,
                last_event_type text,
                last_event_at timestamptz,
                last_checked_at timestamptz,
                last_downloaded_at timestamptz,
                last_error text,
                created_at timestamptz not null default now(),
                updated_at timestamptz not null default now()
            );

            create table if not exists desktop_update_events (
                event_id text primary key,
                event_type text not null check (event_type in ('update_available', 'update_not_available', 'download_started', 'download_completed', 'update_ready', 'install_applied', 'update_error')),
                occurred_at timestamptz not null,
                device_id text not null,
                channel text not null check (channel in ('internal', 'stable')),
                current_version text not null,
                available_version text,
                phase text not null check (phase in ('idle', 'checking', 'update_available', 'downloading', 'downloaded', 'up_to_date', 'error')),
                feed_url text not null,
                platform text,
                arch text,
                country_code text,
                properties jsonb not null default '{}'::jsonb,
                created_at timestamptz not null default now()
            );

            alter table desktop_update_events
                add column if not exists country_code text;

            create table if not exists desktop_update_promotions (
                request_id text primary key,
                source_channel text not null check (source_channel in ('internal', 'stable')),
                target_channel text not null check (target_channel in ('internal', 'stable')),
                workflow_ref text not null,
                requested_at timestamptz not null,
                requested_by text not null,
                status text not null check (status in ('dispatched')),
                notes text,
                created_at timestamptz not null default now()
            );

            create index if not exists desktop_update_device_states_last_seen_idx
                on desktop_update_device_states (last_seen_at desc);
            create index if not exists desktop_update_events_occurred_at_idx
                on desktop_update_events (occurred_at desc);
            create index if not exists desktop_update_events_channel_idx
                on desktop_update_events (channel, occurred_at desc);
            create index if not exists desktop_update_promotions_requested_at_idx
                on desktop_update_promotions (requested_at desc);

            alter table desktop_update_device_states enable row level security;
            alter table desktop_update_events enable row level security;
            alter table desktop_update_promotions enable row level security;

            revoke all privileges on table desktop_update_device_states from anon, authenticated;
            revoke all privileges on table desktop_update_events from anon, authenticated;
            revoke all privileges on table desktop_update_promotions from anon, authenticated;",
        )
        .await?;
    Ok(())
}

fn desktop_internal(error: impl Into<anyhow::Error>) -> DesktopUpdateRegistryError {
    DesktopUpdateRegistryError::Internal(error.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tests::{
        build_app_config, build_test_state, test_origin_private_key, test_origin_public_key,
    };
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use bb8::Pool;
    use bb8_postgres::PostgresConnectionManager;
    use tower::ServiceExt;

    fn sample_event() -> DesktopUpdateEvent {
        DesktopUpdateEvent {
            event_id: Uuid::new_v4().to_string(),
            event_type: DesktopUpdateEventType::UpdateAvailable,
            occurred_at: Utc::now(),
            device_id: "desktop-device-1".to_string(),
            channel: DesktopReleaseChannel::Internal,
            current_version: "0.1.2".to_string(),
            available_version: Some("0.1.3".to_string()),
            phase: DesktopUpdatePhase::UpdateAvailable,
            feed_url: "https://downloads.instafy.dev/desktop-app/internal".to_string(),
            platform: Some("darwin".to_string()),
            arch: Some("arm64".to_string()),
            country_code: None,
            properties: BTreeMap::new(),
        }
    }

    fn sample_event_with(
        event_type: DesktopUpdateEventType,
        occurred_at: DateTime<Utc>,
        channel: DesktopReleaseChannel,
        platform: &str,
    ) -> DesktopUpdateEvent {
        let mut event = sample_event();
        event.event_id = Uuid::new_v4().to_string();
        event.event_type = event_type;
        event.occurred_at = occurred_at;
        event.channel = channel;
        event.platform = Some(platform.to_string());
        event.phase = match event_type {
            DesktopUpdateEventType::DownloadStarted => DesktopUpdatePhase::Downloading,
            DesktopUpdateEventType::DownloadCompleted
            | DesktopUpdateEventType::UpdateReady
            | DesktopUpdateEventType::InstallApplied => DesktopUpdatePhase::Downloaded,
            DesktopUpdateEventType::UpdateError => DesktopUpdatePhase::Error,
            DesktopUpdateEventType::UpdateAvailable => DesktopUpdatePhase::UpdateAvailable,
            DesktopUpdateEventType::UpdateNotAvailable => DesktopUpdatePhase::UpToDate,
        };
        event
    }

    fn build_dummy_pool() -> anyhow::Result<crate::config::PgPool> {
        let manager = PostgresConnectionManager::new_from_stringlike(
            "postgresql://ignored:ignored@127.0.0.1:1/postgres",
            crate::config::database_tls(),
        )?;
        Ok(Pool::builder().max_size(1).build_unchecked(manager))
    }

    async fn test_state() -> anyhow::Result<AppState> {
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "test-origin-key",
        );
        let mut state = build_test_state(build_dummy_pool()?, config);
        state.desktop_update_registry = DesktopUpdateRegistry::new_in_memory();
        Ok(state)
    }

    fn service_role_header() -> (&'static str, &'static str) {
        ("authorization", "Bearer service-role-token")
    }

    #[test]
    fn desktop_channel_copying_only_allows_stable_to_internal() {
        assert!(validate_desktop_promotion_route(
            DesktopReleaseChannel::Stable,
            DesktopReleaseChannel::Internal,
        )
        .is_ok());
        assert!(validate_desktop_promotion_route(
            DesktopReleaseChannel::Stable,
            DesktopReleaseChannel::Stable,
        )
        .is_err());
        assert!(validate_desktop_promotion_route(
            DesktopReleaseChannel::Internal,
            DesktopReleaseChannel::Stable,
        )
        .is_err());
    }

    #[test]
    fn desktop_promotion_requests_cannot_select_workflow_code() {
        assert_eq!(DESKTOP_PROMOTION_WORKFLOW_REF, "main");

        let valid = serde_json::json!({
            "source_channel": "stable",
            "target_channel": "internal",
            "requested_by": "release-operator",
        });
        assert!(serde_json::from_value::<DesktopPromotionRequest>(valid).is_ok());

        let override_attempt = serde_json::json!({
            "source_channel": "stable",
            "target_channel": "internal",
            "workflow_ref": "untrusted-release-branch",
            "requested_by": "release-operator",
        });
        assert!(serde_json::from_value::<DesktopPromotionRequest>(override_attempt).is_err());
    }

    #[test]
    fn beta_is_not_a_desktop_release_channel() {
        assert!(DesktopReleaseChannel::from_str("beta").is_err());

        let mut event = serde_json::to_value(sample_event()).expect("serialize event");
        event["channel"] = JsonValue::String("beta".to_string());
        assert!(serde_json::from_value::<DesktopUpdateEvent>(event).is_err());
    }

    #[tokio::test]
    async fn posting_event_updates_device_state() -> anyhow::Result<()> {
        let state = test_state().await?;
        let app = router().with_state(state.clone());

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/desktop-updates/events")
                    .header("content-type", "application/json")
                    .body(Body::from(serde_json::to_vec(&sample_event())?))?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::ACCEPTED);

        let list_response = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/desktop-updates/device-states")
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(list_response.status(), StatusCode::OK);
        let body = to_bytes(list_response.into_body(), usize::MAX).await?;
        let devices: Vec<DesktopUpdateDeviceState> = serde_json::from_slice(&body)?;
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].current_version, "0.1.2");
        assert_eq!(devices[0].available_version.as_deref(), Some("0.1.3"));
        Ok(())
    }

    #[tokio::test]
    async fn listing_promotions_requires_operator_access() -> anyhow::Result<()> {
        let state = test_state().await?;

        let response = router()
            .with_state(state)
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/desktop-updates/promotions")
                    .body(Body::empty())?,
            )
            .await?;

        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        Ok(())
    }

    #[tokio::test]
    async fn download_insights_aggregate_recent_download_events() -> anyhow::Result<()> {
        let state = test_state().await?;
        let app = router().with_state(state.clone());
        let now = Utc::now();
        let events = vec![
            (
                sample_event_with(
                    DesktopUpdateEventType::DownloadStarted,
                    now - Duration::days(1),
                    DesktopReleaseChannel::Internal,
                    "darwin",
                ),
                "AT",
            ),
            (
                sample_event_with(
                    DesktopUpdateEventType::DownloadCompleted,
                    now - Duration::days(1),
                    DesktopReleaseChannel::Internal,
                    "darwin",
                ),
                "AT",
            ),
            (
                sample_event_with(
                    DesktopUpdateEventType::DownloadStarted,
                    now,
                    DesktopReleaseChannel::Stable,
                    "windows",
                ),
                "US",
            ),
            (
                sample_event_with(
                    DesktopUpdateEventType::UpdateError,
                    now,
                    DesktopReleaseChannel::Stable,
                    "windows",
                ),
                "US",
            ),
            (
                sample_event_with(
                    DesktopUpdateEventType::UpdateReady,
                    now,
                    DesktopReleaseChannel::Stable,
                    "linux",
                ),
                "DE",
            ),
            (
                sample_event_with(
                    DesktopUpdateEventType::DownloadStarted,
                    now - Duration::days(12),
                    DesktopReleaseChannel::Stable,
                    "darwin",
                ),
                "AT",
            ),
        ];

        for (event, country) in events {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/desktop-updates/events")
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
                    .uri("/desktop-updates/download-insights?days=7")
                    .header(service_role_header().0, service_role_header().1)
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::OK);

        let body = to_bytes(response.into_body(), usize::MAX).await?;
        let insights: DesktopDownloadInsights = serde_json::from_slice(&body)?;

        assert_eq!(insights.days, 7);
        assert_eq!(insights.daily.len(), 7);
        assert_eq!(insights.totals.started, 2);
        assert_eq!(insights.totals.completed, 1);
        assert_eq!(insights.totals.ready, 1);
        assert_eq!(insights.totals.errors, 1);
        assert_eq!(insights.by_channel.len(), 2);
        assert_eq!(
            insights
                .by_channel
                .iter()
                .find(|entry| entry.key == "stable")
                .map(|entry| entry.counts.errors),
            Some(1)
        );
        assert_eq!(
            insights
                .by_platform
                .iter()
                .find(|entry| entry.key == "windows")
                .map(|entry| entry.counts.started),
            Some(1)
        );
        assert_eq!(
            insights
                .by_country
                .iter()
                .find(|entry| entry.key == "AT")
                .map(|entry| entry.counts.completed),
            Some(1)
        );
        assert_eq!(
            insights
                .by_country
                .iter()
                .find(|entry| entry.key == "US")
                .map(|entry| entry.counts.errors),
            Some(1)
        );

        Ok(())
    }
}
