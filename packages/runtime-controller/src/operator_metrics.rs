//! Operator console metrics: AI token usage and the runtime fleet.
//!
//! Two read-only routes behind the same operator gate as `operator_admin`.
//! Every daily series is zero-filled for each UTC day in its window, oldest
//! first, so the console can chart it without reindexing. SQL only groups;
//! the window arithmetic, classification and JSON assembly live in pure
//! builders so the wire shape is unit-testable without a database.
//!
//! Tokens are counted, never priced: the pricing envs default to another
//! model's rates, so USD will come from OpenAI's Costs API later rather than
//! from a guess here.

use std::collections::BTreeMap;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::ota::require_operator_access;
use crate::provider_identifiers::{
    is_instafy_cloud_provider_id, is_self_hosted_provider_id, is_self_hosted_provider_kind,
};
use crate::workspace::REMOTE_RUNTIME_RECENCY_SECONDS;
use crate::{internal_error, ApiError, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/operator/metrics/ai-usage", get(operator_ai_usage))
        .route("/operator/metrics/runtimes", get(operator_runtimes))
}

// ---------------------------------------------------------------------------
// Day windows
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS: i64 = 30;
const MIN_WINDOW_DAYS: i64 = 1;
const MAX_WINDOW_DAYS: i64 = 90;
/// runtime_events are pruned after two weeks (see runtime/sweeps.rs), so the
/// stop-reason series is pinned to that window regardless of `?days=`.
const STOP_WINDOW_DAYS: i64 = 14;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperatorMetricsWindowQuery {
    #[serde(default)]
    days: Option<i64>,
}

fn clamp_window_days(requested: Option<i64>) -> i64 {
    requested
        .unwrap_or(DEFAULT_WINDOW_DAYS)
        .clamp(MIN_WINDOW_DAYS, MAX_WINDOW_DAYS)
}

/// A run of consecutive UTC days ending on the day `now` falls in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DayWindow {
    pub(crate) start: NaiveDate,
    pub(crate) end: NaiveDate,
}

impl DayWindow {
    pub(crate) fn ending(now: DateTime<Utc>, days: i64) -> Self {
        let end = now.date_naive();
        let start = end - Duration::days(days.max(1) - 1);
        Self { start, end }
    }

    /// UTC midnight at the start of the first day; the lower bound for the
    /// `created_at >= $n` filters.
    pub(crate) fn start_at(&self) -> DateTime<Utc> {
        self.start
            .and_hms_opt(0, 0, 0)
            .expect("midnight is a valid time")
            .and_utc()
    }

    pub(crate) fn len(&self) -> i64 {
        (self.end - self.start).num_days() + 1
    }

    fn days(&self) -> impl Iterator<Item = NaiveDate> {
        let start = self.start;
        (0..self.len()).map(move |offset| start + Duration::days(offset))
    }
}

/// Lay `by_day` over the window: one entry per day, oldest first, defaults
/// where Postgres returned nothing. Rows outside the window are dropped rather
/// than appended so the series length is always the window length.
fn fill_day_window<T: Default>(
    window: &DayWindow,
    mut by_day: BTreeMap<NaiveDate, T>,
) -> Vec<(NaiveDate, T)> {
    window
        .days()
        .map(|day| (day, by_day.remove(&day).unwrap_or_default()))
        .collect()
}

// ---------------------------------------------------------------------------
// AI usage
//
// A "run" is one token_usage row in conversation_messages, deduplicated to a
// single row per run_id (the agent stream and the controller completion can
// both write one). Cached input tokens are a subset of input tokens, so
// `tokens` is input + output and never adds cached.
// ---------------------------------------------------------------------------

const TOP_PROJECTS_LIMIT: usize = 8;

/// One (day, access mode, origin) group as it comes back from Postgres. The
/// mode is passed through raw and folded in Rust so the classification is
/// testable and a typo'd value lands in `unknown` rather than vanishing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AiUsageBreakdownRow {
    pub(crate) day: NaiveDate,
    pub(crate) access_mode: Option<String>,
    pub(crate) automation: bool,
    pub(crate) runs: i64,
    pub(crate) input_tokens: i64,
    pub(crate) cached_input_tokens: i64,
    pub(crate) output_tokens: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AiUsageProjectRow {
    pub(crate) project_id: Uuid,
    pub(crate) project_name: Option<String>,
    pub(crate) org_name: Option<String>,
    pub(crate) runs: i64,
    pub(crate) input_tokens: i64,
    pub(crate) output_tokens: i64,
    pub(crate) automation_runs: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AiAccessMode {
    Managed,
    Byoc,
    Unknown,
}

fn classify_access_mode(raw: Option<&str>) -> AiAccessMode {
    match raw.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("managed") => AiAccessMode::Managed,
        Some("byoc") => AiAccessMode::Byoc,
        _ => AiAccessMode::Unknown,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiUsageDay {
    day: String,
    runs: i64,
    input_tokens: i64,
    cached_input_tokens: i64,
    output_tokens: i64,
    managed_runs: i64,
    automation_runs: i64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiUsageBucket {
    runs: i64,
    /// input + output; cached input is already inside input.
    tokens: i64,
}

impl AiUsageBucket {
    fn add(&mut self, row: &AiUsageBreakdownRow) {
        self.runs += row.runs;
        self.tokens += row.input_tokens + row.output_tokens;
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiUsageByMode {
    managed: AiUsageBucket,
    byoc: AiUsageBucket,
    unknown: AiUsageBucket,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiUsageByOrigin {
    automation: AiUsageBucket,
    people: AiUsageBucket,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiUsageTopProject {
    project_id: String,
    project_name: Option<String>,
    org_name: Option<String>,
    runs: i64,
    input_tokens: i64,
    output_tokens: i64,
    automation_runs: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperatorAiUsage {
    generated_at: String,
    days: i64,
    range_start: String,
    range_end: String,
    daily: Vec<AiUsageDay>,
    by_mode: AiUsageByMode,
    by_origin: AiUsageByOrigin,
    top_projects: Vec<AiUsageTopProject>,
}

pub(crate) fn build_operator_ai_usage(
    generated_at: DateTime<Utc>,
    window: DayWindow,
    breakdown: Vec<AiUsageBreakdownRow>,
    projects: Vec<AiUsageProjectRow>,
) -> OperatorAiUsage {
    let mut by_day = BTreeMap::<NaiveDate, AiUsageDay>::new();
    let mut by_mode = AiUsageByMode::default();
    let mut by_origin = AiUsageByOrigin::default();

    for row in &breakdown {
        let mode = classify_access_mode(row.access_mode.as_deref());

        let day = by_day.entry(row.day).or_default();
        day.runs += row.runs;
        day.input_tokens += row.input_tokens;
        day.cached_input_tokens += row.cached_input_tokens;
        day.output_tokens += row.output_tokens;
        if mode == AiAccessMode::Managed {
            day.managed_runs += row.runs;
        }
        if row.automation {
            day.automation_runs += row.runs;
        }

        match mode {
            AiAccessMode::Managed => by_mode.managed.add(row),
            AiAccessMode::Byoc => by_mode.byoc.add(row),
            AiAccessMode::Unknown => by_mode.unknown.add(row),
        }
        if row.automation {
            by_origin.automation.add(row);
        } else {
            by_origin.people.add(row);
        }
    }

    let daily = fill_day_window(&window, by_day)
        .into_iter()
        .map(|(day, counts)| AiUsageDay {
            day: day.to_string(),
            ..counts
        })
        .collect();

    // Postgres already orders and limits; re-sorting here keeps the contract
    // (by input + output, descending, at most eight) independent of the SQL.
    let mut projects = projects;
    projects.sort_by(|left, right| {
        (right.input_tokens + right.output_tokens)
            .cmp(&(left.input_tokens + left.output_tokens))
            .then(right.runs.cmp(&left.runs))
            .then(left.project_id.cmp(&right.project_id))
    });
    projects.truncate(TOP_PROJECTS_LIMIT);
    let top_projects = projects
        .into_iter()
        .map(|row| AiUsageTopProject {
            project_id: row.project_id.to_string(),
            project_name: row.project_name,
            org_name: row.org_name,
            runs: row.runs,
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            automation_runs: row.automation_runs,
        })
        .collect();

    OperatorAiUsage {
        generated_at: generated_at.to_rfc3339(),
        days: window.len(),
        range_start: window.start.to_string(),
        range_end: window.end.to_string(),
        daily,
        by_mode,
        by_origin,
        top_projects,
    }
}

// The dedupe prefers the row that carries a model id (the agent stream's),
// then the newest; the controller's completion row is the fallback. Usage
// fields are bigint-or-zero so a partial payload still counts as a run.
const OPERATOR_AI_USAGE_BREAKDOWN_SQL: &str = "
    with usage_rows as (
        select distinct on (m.run_id)
               m.run_id,
               m.prompt_id,
               m.created_at,
               coalesce((m.metadata -> 'details' -> 'usage' ->> 'input_tokens')::bigint, 0)
                   as input_tokens,
               coalesce((m.metadata -> 'details' -> 'usage' ->> 'cached_input_tokens')::bigint, 0)
                   as cached_input_tokens,
               coalesce((m.metadata -> 'details' -> 'usage' ->> 'output_tokens')::bigint, 0)
                   as output_tokens
          from conversation_messages m
         where m.metadata ->> 'messageType' = 'token_usage'
           and m.run_id is not null
           and m.created_at >= $1
         order by m.run_id, (m.metadata -> 'details' ->> 'model') is null, m.created_at desc
    )
    select (u.created_at at time zone 'UTC')::date as day,
           pr.metadata ->> 'aiAccessMode' as access_mode,
           coalesce(pr.metadata ? 'automation', false) as automation,
           count(*) as runs,
           coalesce(sum(u.input_tokens), 0)::bigint as input_tokens,
           coalesce(sum(u.cached_input_tokens), 0)::bigint as cached_input_tokens,
           coalesce(sum(u.output_tokens), 0)::bigint as output_tokens
      from usage_rows u
      left join prompts pr on pr.id = u.prompt_id
     group by 1, 2, 3
     order by 1, 2, 3
";

const OPERATOR_AI_USAGE_TOP_PROJECTS_SQL: &str = "
    with usage_rows as (
        select distinct on (m.run_id)
               m.run_id,
               m.prompt_id,
               m.project_id,
               coalesce((m.metadata -> 'details' -> 'usage' ->> 'input_tokens')::bigint, 0)
                   as input_tokens,
               coalesce((m.metadata -> 'details' -> 'usage' ->> 'output_tokens')::bigint, 0)
                   as output_tokens
          from conversation_messages m
         where m.metadata ->> 'messageType' = 'token_usage'
           and m.run_id is not null
           and m.created_at >= $1
         order by m.run_id, (m.metadata -> 'details' ->> 'model') is null, m.created_at desc
    )
    select u.project_id,
           p.name as project_name,
           o.name as org_name,
           count(*) as runs,
           coalesce(sum(u.input_tokens), 0)::bigint as input_tokens,
           coalesce(sum(u.output_tokens), 0)::bigint as output_tokens,
           count(*) filter (where coalesce(pr.metadata ? 'automation', false)) as automation_runs
      from usage_rows u
      left join prompts pr on pr.id = u.prompt_id
      left join projects p on p.id = u.project_id
      left join organizations o on o.id = p.org_id
     group by u.project_id, p.name, o.name
     order by coalesce(sum(u.input_tokens), 0) + coalesce(sum(u.output_tokens), 0) desc,
              count(*) desc,
              u.project_id
     limit $2
";

async fn operator_ai_usage(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<OperatorMetricsWindowQuery>,
) -> Result<Json<OperatorAiUsage>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;

    let generated_at = Utc::now();
    let window = DayWindow::ending(generated_at, clamp_window_days(params.days));
    let since = window.start_at();
    let top_projects_limit = TOP_PROJECTS_LIMIT as i64;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let breakdown = transaction
        .query(OPERATOR_AI_USAGE_BREAKDOWN_SQL, &[&since])
        .await
        .map_err(|error| internal_error(format!("failed to load ai usage breakdown: {error}")))?
        .into_iter()
        .map(|row| AiUsageBreakdownRow {
            day: row.get("day"),
            access_mode: row.get("access_mode"),
            automation: row.get("automation"),
            runs: row.get("runs"),
            input_tokens: row.get("input_tokens"),
            cached_input_tokens: row.get("cached_input_tokens"),
            output_tokens: row.get("output_tokens"),
        })
        .collect();

    let projects = transaction
        .query(
            OPERATOR_AI_USAGE_TOP_PROJECTS_SQL,
            &[&since, &top_projects_limit],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load ai usage by project: {error}")))?
        .into_iter()
        .map(|row| AiUsageProjectRow {
            project_id: row.get("project_id"),
            project_name: row.get("project_name"),
            org_name: row.get("org_name"),
            runs: row.get("runs"),
            input_tokens: row.get("input_tokens"),
            output_tokens: row.get("output_tokens"),
            automation_runs: row.get("automation_runs"),
        })
        .collect();

    Ok(Json(build_operator_ai_usage(
        generated_at,
        window,
        breakdown,
        projects,
    )))
}

// ---------------------------------------------------------------------------
// Runtime fleet
//
// One scan of the non-terminal runtimes feeds the hosted counters, the
// per-family health rollup, the instance list and the silent list, so the
// four views can never disagree about which machines exist. Health mirrors
// runtime::status::determine_runtime_health; the fleet view has no viewer or
// origin context, so every runtime is judged with the remote recency grace.
// ---------------------------------------------------------------------------

const INSTANCE_LIMIT: usize = 50;
/// Upper bound on the fleet scan. The hosted fleet is capped in single digits
/// and self-hosted runtimes are reaped once they stop heartbeating, so this
/// is a memory guard, not a page size.
const RUNTIME_SCAN_LIMIT: i64 = 1000;
/// A ready/running runtime that has not heartbeated for this long is listed
/// as silent: still "live" to the controller, but not talking.
const SILENT_AFTER_SECONDS: i64 = 300;
/// The platform-wide admission cap (migration 20260000000045) reported when
/// the controller is not configured with an explicit global cap.
const PLATFORM_HOSTED_RUNTIME_CAP: i64 = 8;
const DEFAULT_SIZE_ID: &str = "standard";

const FAMILY_INSTAFY_CLOUD: &str = "instafy-cloud";
const FAMILY_SELF_HOSTED: &str = "self-hosted";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeScanRow {
    pub(crate) runtime_id: Uuid,
    pub(crate) project_id: Option<Uuid>,
    pub(crate) project_name: Option<String>,
    pub(crate) provider: String,
    pub(crate) status: String,
    pub(crate) last_seen_at: Option<DateTime<Utc>>,
    pub(crate) idle_ttl_seconds: i32,
    pub(crate) display_name: Option<String>,
    pub(crate) has_active_lease: bool,
    pub(crate) lease_started_at: Option<DateTime<Utc>>,
    pub(crate) size_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct HostedHoursRow {
    pub(crate) day: NaiveDate,
    pub(crate) seconds: i64,
    pub(crate) leases: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeLifecycleRow {
    pub(crate) day: NaiveDate,
    pub(crate) created: i64,
    pub(crate) destroyed: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeStopRow {
    pub(crate) day: NaiveDate,
    pub(crate) reason: Option<String>,
    pub(crate) stops: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RuntimeProviderRow {
    pub(crate) id: String,
    pub(crate) kind: Option<String>,
    pub(crate) endpoint: Option<String>,
    pub(crate) updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub(crate) struct OriginPresenceCounts {
    pub(crate) online: i64,
    pub(crate) offline: i64,
    pub(crate) degraded: i64,
    pub(crate) avg_latency_ms: Option<f64>,
}

/// Everything the fleet builder needs, gathered so the handler and the tests
/// hand over the same bundle.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct RuntimeMetricsInputs {
    pub(crate) hosted_cap: i64,
    /// Seconds a remote runtime may go without a heartbeat before it is idle
    /// rather than online; `REMOTE_RUNTIME_RECENCY_SECONDS` in production.
    pub(crate) recency_grace_seconds: i64,
    pub(crate) window: DayWindow,
    pub(crate) stop_window: DayWindow,
    pub(crate) runtimes: Vec<RuntimeScanRow>,
    pub(crate) hosted_hours: Vec<HostedHoursRow>,
    pub(crate) lifecycle: Vec<RuntimeLifecycleRow>,
    pub(crate) stops: Vec<RuntimeStopRow>,
    pub(crate) providers: Vec<RuntimeProviderRow>,
    pub(crate) origins: OriginPresenceCounts,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostedRuntimeSummary {
    active: i64,
    cap: i64,
    by_size: BTreeMap<String, i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderHealthSummary {
    provider_family: String,
    online: i64,
    idle: i64,
    offline: i64,
    total: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeInstance {
    runtime_id: String,
    project_id: Option<String>,
    project_name: Option<String>,
    provider_family: String,
    provider: String,
    status: String,
    health: String,
    last_seen_at: Option<String>,
    lease_started_at: Option<String>,
    size_id: Option<String>,
    display_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HostedHoursDay {
    day: String,
    hours: f64,
    leases: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeLifecycleDay {
    day: String,
    created: i64,
    destroyed: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStopsDay {
    day: String,
    heartbeat_timeout: i64,
    oom_killed: i64,
    terminal_cleanup: i64,
    manual: i64,
    other: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SilentRuntime {
    runtime_id: String,
    project_name: Option<String>,
    last_seen_at: Option<String>,
    status: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeProviderSummary {
    id: String,
    kind: Option<String>,
    family: Option<String>,
    endpoint: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OriginPresenceSummary {
    online: i64,
    offline: i64,
    degraded: i64,
    avg_latency_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperatorRuntimes {
    generated_at: String,
    hosted: HostedRuntimeSummary,
    by_provider_health: Vec<ProviderHealthSummary>,
    instances: Vec<RuntimeInstance>,
    daily_hours: Vec<HostedHoursDay>,
    daily_lifecycle: Vec<RuntimeLifecycleDay>,
    #[serde(rename = "stops14d")]
    stops_14d: Vec<RuntimeStopsDay>,
    silent: Vec<SilentRuntime>,
    providers: Vec<RuntimeProviderSummary>,
    origins: OriginPresenceSummary,
}

/// Same thresholds as `determine_runtime_health`, with `now` and the recency
/// grace passed in so the fleet builder stays pure.
fn classify_runtime_health(
    now: DateTime<Utc>,
    last_seen_at: Option<DateTime<Utc>>,
    idle_ttl_seconds: i32,
    status: &str,
    recency_grace_seconds: i64,
) -> &'static str {
    if matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "offline" | "stopped" | "stopping" | "error"
    ) {
        return "offline";
    }
    let Some(last_seen) = last_seen_at else {
        return "offline";
    };
    let elapsed = now.signed_duration_since(last_seen).num_seconds();
    let ttl = i64::from(idle_ttl_seconds.max(1));
    let online_threshold = ttl.min(recency_grace_seconds);
    let idle_threshold = ttl.saturating_mul(3).max(recency_grace_seconds);
    if elapsed <= online_threshold {
        "online"
    } else if elapsed <= idle_threshold {
        "idle"
    } else {
        "offline"
    }
}

/// Statuses a runtime never comes back from; excluded from the instance list.
fn is_terminal_runtime_status(status: &str) -> bool {
    matches!(
        status.trim().to_ascii_lowercase().as_str(),
        "stopped" | "offline" | "removed" | "failed"
    )
}

fn runtime_provider_family(provider: &str) -> &'static str {
    if is_instafy_cloud_provider_id(provider) {
        FAMILY_INSTAFY_CLOUD
    } else {
        FAMILY_SELF_HOSTED
    }
}

/// Family for a configured provider route. Unlike runtimes, a route can be
/// neither: the seeded `runtime` docker route, for one, so that is `None`.
fn provider_route_family(id: &str, kind: Option<&str>) -> Option<&'static str> {
    if is_instafy_cloud_provider_id(id) {
        Some(FAMILY_INSTAFY_CLOUD)
    } else if is_self_hosted_provider_id(id) || kind.is_some_and(is_self_hosted_provider_kind) {
        Some(FAMILY_SELF_HOSTED)
    } else {
        None
    }
}

/// The same predicate the billing sweep applies (runtime/sweeps.rs), minus
/// the status filter that already ran in SQL.
fn is_hosted_runtime(row: &RuntimeScanRow) -> bool {
    row.has_active_lease && is_instafy_cloud_provider_id(&row.provider)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StopReasonBucket {
    HeartbeatTimeout,
    OomKilled,
    TerminalCleanup,
    Manual,
    Other,
}

// Reasons are written by the idle reaper and the sweeps (runtime/sweeps.rs,
// runtime/stop.rs); anything unrecognised, including a missing reason, is
// `other` so the daily total still adds up.
fn classify_stop_reason(reason: Option<&str>) -> StopReasonBucket {
    let normalized = reason
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if normalized.starts_with("heartbeat_timeout") {
        StopReasonBucket::HeartbeatTimeout
    } else {
        match normalized.as_str() {
            "oom_killed" => StopReasonBucket::OomKilled,
            "terminal_runtime_cleanup" | "terminal_cleanup" => StopReasonBucket::TerminalCleanup,
            "manual" => StopReasonBucket::Manual,
            _ => StopReasonBucket::Other,
        }
    }
}

fn round_hours(seconds: i64) -> f64 {
    (seconds as f64 / 3600.0 * 100.0).round() / 100.0
}

pub(crate) fn build_operator_runtimes(
    generated_at: DateTime<Utc>,
    inputs: RuntimeMetricsInputs,
) -> OperatorRuntimes {
    let RuntimeMetricsInputs {
        hosted_cap,
        recency_grace_seconds,
        window,
        stop_window,
        runtimes,
        hosted_hours,
        lifecycle,
        stops,
        providers,
        origins,
    } = inputs;

    let mut hosted_active = 0;
    let mut hosted_by_size = BTreeMap::<String, i64>::new();
    let mut by_family = BTreeMap::<&'static str, ProviderHealthSummary>::new();
    for family in [FAMILY_INSTAFY_CLOUD, FAMILY_SELF_HOSTED] {
        by_family.insert(
            family,
            ProviderHealthSummary {
                provider_family: family.to_string(),
                ..ProviderHealthSummary::default()
            },
        );
    }
    let mut instances = Vec::new();
    let mut silent = Vec::new();

    for row in &runtimes {
        let hosted = is_hosted_runtime(row);
        if hosted {
            hosted_active += 1;
            *hosted_by_size
                .entry(
                    row.size_id
                        .clone()
                        .unwrap_or_else(|| DEFAULT_SIZE_ID.to_string()),
                )
                .or_default() += 1;
        }

        if is_terminal_runtime_status(&row.status) {
            continue;
        }

        let family = runtime_provider_family(&row.provider);
        let health = classify_runtime_health(
            generated_at,
            row.last_seen_at,
            row.idle_ttl_seconds,
            &row.status,
            recency_grace_seconds,
        );
        let summary = by_family
            .entry(family)
            .or_insert_with(|| ProviderHealthSummary {
                provider_family: family.to_string(),
                ..ProviderHealthSummary::default()
            });
        summary.total += 1;
        match health {
            "online" => summary.online += 1,
            "idle" => summary.idle += 1,
            _ => summary.offline += 1,
        }

        let normalized_status = row.status.trim().to_ascii_lowercase();
        let heartbeat_stale = row
            .last_seen_at
            .map(|seen| {
                generated_at.signed_duration_since(seen).num_seconds() > SILENT_AFTER_SECONDS
            })
            .unwrap_or(true);
        if matches!(normalized_status.as_str(), "ready" | "running") && heartbeat_stale {
            silent.push((
                row.last_seen_at,
                SilentRuntime {
                    runtime_id: row.runtime_id.to_string(),
                    project_name: row.project_name.clone(),
                    last_seen_at: row.last_seen_at.map(|value| value.to_rfc3339()),
                    status: row.status.clone(),
                },
            ));
        }

        let size_id = if hosted {
            Some(
                row.size_id
                    .clone()
                    .unwrap_or_else(|| DEFAULT_SIZE_ID.to_string()),
            )
        } else {
            row.size_id.clone()
        };
        instances.push((
            row.lease_started_at,
            RuntimeInstance {
                runtime_id: row.runtime_id.to_string(),
                project_id: row.project_id.map(|value| value.to_string()),
                project_name: row.project_name.clone(),
                provider_family: family.to_string(),
                provider: row.provider.clone(),
                status: row.status.clone(),
                health: health.to_string(),
                last_seen_at: row.last_seen_at.map(|value| value.to_rfc3339()),
                lease_started_at: row.lease_started_at.map(|value| value.to_rfc3339()),
                size_id,
                display_name: row.display_name.clone(),
            },
        ));
    }

    // Newest lease first; runtimes without a lease trail in scan order.
    instances.sort_by(|(left, _), (right, _)| match (left, right) {
        (Some(left), Some(right)) => right.cmp(left),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    instances.truncate(INSTANCE_LIMIT);
    let instances = instances
        .into_iter()
        .map(|(_, instance)| instance)
        .collect();

    // Quietest first: never-heartbeated, then the longest silence.
    silent.sort_by(|(left, _), (right, _)| match (left, right) {
        (Some(left), Some(right)) => left.cmp(right),
        (None, Some(_)) => std::cmp::Ordering::Less,
        (Some(_), None) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    let silent = silent.into_iter().map(|(_, entry)| entry).collect();

    let daily_hours = fill_day_window(
        &window,
        hosted_hours
            .into_iter()
            .map(|row| (row.day, (row.seconds, row.leases)))
            .collect(),
    )
    .into_iter()
    .map(|(day, (seconds, leases))| HostedHoursDay {
        day: day.to_string(),
        hours: round_hours(seconds),
        leases,
    })
    .collect();

    let daily_lifecycle = fill_day_window(
        &window,
        lifecycle
            .into_iter()
            .map(|row| (row.day, (row.created, row.destroyed)))
            .collect(),
    )
    .into_iter()
    .map(|(day, (created, destroyed))| RuntimeLifecycleDay {
        day: day.to_string(),
        created,
        destroyed,
    })
    .collect();

    let mut stops_by_day = BTreeMap::<NaiveDate, RuntimeStopsDay>::new();
    for row in &stops {
        let day = stops_by_day.entry(row.day).or_default();
        match classify_stop_reason(row.reason.as_deref()) {
            StopReasonBucket::HeartbeatTimeout => day.heartbeat_timeout += row.stops,
            StopReasonBucket::OomKilled => day.oom_killed += row.stops,
            StopReasonBucket::TerminalCleanup => day.terminal_cleanup += row.stops,
            StopReasonBucket::Manual => day.manual += row.stops,
            StopReasonBucket::Other => day.other += row.stops,
        }
    }
    let stops_14d = fill_day_window(&stop_window, stops_by_day)
        .into_iter()
        .map(|(day, counts)| RuntimeStopsDay {
            day: day.to_string(),
            ..counts
        })
        .collect();

    let providers = providers
        .into_iter()
        .map(|row| RuntimeProviderSummary {
            family: provider_route_family(&row.id, row.kind.as_deref()).map(str::to_string),
            id: row.id,
            kind: row.kind,
            endpoint: row.endpoint,
            updated_at: row.updated_at.map(|value| value.to_rfc3339()),
        })
        .collect();

    OperatorRuntimes {
        generated_at: generated_at.to_rfc3339(),
        hosted: HostedRuntimeSummary {
            active: hosted_active,
            cap: hosted_cap,
            by_size: hosted_by_size,
        },
        by_provider_health: by_family.into_values().collect(),
        instances,
        daily_hours,
        daily_lifecycle,
        stops_14d,
        silent,
        providers,
        origins: OriginPresenceSummary {
            online: origins.online,
            offline: origins.offline,
            degraded: origins.degraded,
            avg_latency_ms: origins.avg_latency_ms,
        },
    }
}

// The status filter is the billing sweep's (runtime/sweeps.rs), so a `failed`
// runtime that still holds a lease is counted as hosted here exactly as the
// sweep bills it; the builder drops it from the instance list afterwards.
const OPERATOR_RUNTIME_SCAN_SQL: &str = "
    select r.id as runtime_id,
           r.project_id,
           p.name as project_name,
           r.provider,
           r.status,
           r.last_seen_at,
           r.idle_ttl_seconds,
           r.display_name,
           (r.active_lease_id is not null) as has_active_lease,
           coalesce(rl.launched_at, rl.requested_at) as lease_started_at,
           rl.metadata ->> 'sizeId' as size_id
      from runtimes r
      left join projects p on p.id = r.project_id
      left join runtime_leases rl on rl.id = r.active_lease_id
     where r.status not in ('stopped', 'offline', 'removed')
     order by coalesce(rl.launched_at, rl.requested_at) desc nulls last,
              r.created_at desc,
              r.id
     limit $1
";

// Hosted lease time is sliced at UTC midnight so a lease that runs overnight
// is charged to both days; open leases run to $3 (now). generate_series is
// only the slicing device — days with no lease produce no row and are
// zero-filled by the builder.
const OPERATOR_HOSTED_HOURS_SQL: &str = "
    with days as (
        select generate_series($1::date, $2::date, interval '1 day')::date as day
    ),
    hosted_leases as (
        select rl.id,
               coalesce(rl.launched_at, rl.requested_at) as started_at,
               coalesce(rl.released_at, $3::timestamptz) as ended_at
          from runtime_leases rl
          join runtimes r on r.id = rl.runtime_id
         where (
                 replace(lower(r.provider), '-', '_') = 'instafy_cloud'
                 or replace(lower(r.provider), '-', '_') like 'instafy\\_cloud\\_%'
               )
           and coalesce(rl.released_at, $3::timestamptz) > ($1::date::timestamp at time zone 'UTC')
    )
    select d.day,
           count(hl.id) as leases,
           coalesce(sum(greatest(0, extract(epoch from (
               least(hl.ended_at, ((d.day + 1)::timestamp at time zone 'UTC'))
               - greatest(hl.started_at, (d.day::timestamp at time zone 'UTC'))
           )))), 0)::bigint as seconds
      from days d
      join hosted_leases hl
        on hl.started_at < ((d.day + 1)::timestamp at time zone 'UTC')
       and hl.ended_at > (d.day::timestamp at time zone 'UTC')
     group by d.day
     order by d.day
";

// runtimes rows are never deleted (cleanup sets status = 'removed'), so
// created_at is durable; a lease's released_at is the teardown timestamp.
const OPERATOR_RUNTIME_LIFECYCLE_SQL: &str = "
    with created as (
        select (created_at at time zone 'UTC')::date as day, count(*) as created
          from runtimes
         where created_at >= $1
         group by 1
    ),
    destroyed as (
        select (released_at at time zone 'UTC')::date as day, count(*) as destroyed
          from runtime_leases
         where released_at >= $1
         group by 1
    )
    select coalesce(c.day, d.day) as day,
           coalesce(c.created, 0) as created,
           coalesce(d.destroyed, 0) as destroyed
      from created c
      full outer join destroyed d on d.day = c.day
     order by 1
";

const OPERATOR_RUNTIME_STOPS_SQL: &str = "
    select (e.created_at at time zone 'UTC')::date as day,
           e.data ->> 'reason' as reason,
           count(*) as stops
      from runtime_events e
     where e.kind = 'stopped'
       and e.created_at >= $1
     group by 1, 2
     order by 1, 2
";

const OPERATOR_RUNTIME_PROVIDERS_SQL: &str = "
    select id, kind, endpoint, updated_at
      from runtime_providers
     order by updated_at desc nulls last, id
";

const OPERATOR_ORIGIN_PRESENCE_SQL: &str = "
    select count(*) filter (where status = 'online') as online,
           count(*) filter (where status = 'offline') as offline,
           count(*) filter (where status = 'degraded') as degraded,
           avg(latency_ms)::double precision as avg_latency_ms
      from origin_presence
";

async fn operator_runtimes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<OperatorMetricsWindowQuery>,
) -> Result<Json<OperatorRuntimes>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;

    let generated_at = Utc::now();
    let window = DayWindow::ending(generated_at, clamp_window_days(params.days));
    let stop_window = DayWindow::ending(generated_at, STOP_WINDOW_DAYS);
    let hosted_cap = match state.config.max_active_hosted_runtimes_global {
        cap if cap > 0 => cap,
        _ => PLATFORM_HOSTED_RUNTIME_CAP,
    };

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let scanned = transaction
        .query(OPERATOR_RUNTIME_SCAN_SQL, &[&RUNTIME_SCAN_LIMIT])
        .await
        .map_err(|error| internal_error(format!("failed to scan runtimes: {error}")))?;
    // Leased runtimes sort first, so the hosted figures survive a truncated scan;
    // the self-hosted rollup and the silent list would not, hence the warning.
    if scanned.len() as i64 >= RUNTIME_SCAN_LIMIT {
        tracing::warn!(
            limit = RUNTIME_SCAN_LIMIT,
            "operator runtime scan hit its limit; fleet aggregates may undercount"
        );
    }
    let runtimes = scanned
        .into_iter()
        .map(|row| RuntimeScanRow {
            runtime_id: row.get("runtime_id"),
            project_id: row.get("project_id"),
            project_name: row.get("project_name"),
            provider: row.get("provider"),
            status: row.get("status"),
            last_seen_at: row.get("last_seen_at"),
            idle_ttl_seconds: row.get("idle_ttl_seconds"),
            display_name: row.get("display_name"),
            has_active_lease: row.get("has_active_lease"),
            lease_started_at: row.get("lease_started_at"),
            size_id: row.get("size_id"),
        })
        .collect();

    let hosted_hours = transaction
        .query(
            OPERATOR_HOSTED_HOURS_SQL,
            &[&window.start, &window.end, &generated_at],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load hosted runtime hours: {error}")))?
        .into_iter()
        .map(|row| HostedHoursRow {
            day: row.get("day"),
            seconds: row.get("seconds"),
            leases: row.get("leases"),
        })
        .collect();

    let lifecycle = transaction
        .query(OPERATOR_RUNTIME_LIFECYCLE_SQL, &[&window.start_at()])
        .await
        .map_err(|error| internal_error(format!("failed to load runtime lifecycle: {error}")))?
        .into_iter()
        .map(|row| RuntimeLifecycleRow {
            day: row.get("day"),
            created: row.get("created"),
            destroyed: row.get("destroyed"),
        })
        .collect();

    let stops = transaction
        .query(OPERATOR_RUNTIME_STOPS_SQL, &[&stop_window.start_at()])
        .await
        .map_err(|error| internal_error(format!("failed to load runtime stop reasons: {error}")))?
        .into_iter()
        .map(|row| RuntimeStopRow {
            day: row.get("day"),
            reason: row.get("reason"),
            stops: row.get("stops"),
        })
        .collect();

    let providers = transaction
        .query(OPERATOR_RUNTIME_PROVIDERS_SQL, &[])
        .await
        .map_err(|error| internal_error(format!("failed to load runtime providers: {error}")))?
        .into_iter()
        .map(|row| RuntimeProviderRow {
            id: row.get("id"),
            kind: row.get("kind"),
            endpoint: row.get("endpoint"),
            updated_at: row.get("updated_at"),
        })
        .collect();

    let origins_row = transaction
        .query_one(OPERATOR_ORIGIN_PRESENCE_SQL, &[])
        .await
        .map_err(|error| internal_error(format!("failed to load origin presence: {error}")))?;
    let origins = OriginPresenceCounts {
        online: origins_row.get("online"),
        offline: origins_row.get("offline"),
        degraded: origins_row.get("degraded"),
        avg_latency_ms: origins_row.get("avg_latency_ms"),
    };

    Ok(Json(build_operator_runtimes(
        generated_at,
        RuntimeMetricsInputs {
            hosted_cap,
            recency_grace_seconds: *REMOTE_RUNTIME_RECENCY_SECONDS,
            window,
            stop_window,
            runtimes,
            hosted_hours,
            lifecycle,
            stops,
            providers,
            origins,
        },
    )))
}

#[cfg(test)]
mod operator_metrics_tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::Value as JsonValue;

    fn at(y: i32, m: u32, d: u32, h: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap()
    }

    fn day(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    /// Every object key, recursively, so a leaked snake_case field anywhere in
    /// the payload fails one assertion instead of needing a bespoke check.
    fn collect_keys(value: &JsonValue, into: &mut Vec<String>) {
        match value {
            JsonValue::Object(map) => {
                for (key, child) in map {
                    into.push(key.clone());
                    collect_keys(child, into);
                }
            }
            JsonValue::Array(items) => items.iter().for_each(|item| collect_keys(item, into)),
            _ => {}
        }
    }

    fn assert_no_snake_case_keys(payload: &JsonValue) {
        let mut keys = Vec::new();
        collect_keys(payload, &mut keys);
        // bySize is keyed by size ids, which are user-facing identifiers, not
        // field names; everything else must be camelCase.
        let leaked: Vec<&String> = keys.iter().filter(|key| key.contains('_')).collect();
        assert!(leaked.is_empty(), "snake_case keys leaked: {leaked:?}");
    }

    // -- windows ------------------------------------------------------------

    #[test]
    fn clamps_the_requested_window() {
        assert_eq!(clamp_window_days(None), 30);
        assert_eq!(clamp_window_days(Some(0)), 1);
        assert_eq!(clamp_window_days(Some(-7)), 1);
        assert_eq!(clamp_window_days(Some(1)), 1);
        assert_eq!(clamp_window_days(Some(45)), 45);
        assert_eq!(clamp_window_days(Some(90)), 90);
        assert_eq!(clamp_window_days(Some(400)), 90);
    }

    #[test]
    fn window_ends_today_and_counts_days_inclusively() {
        let window = DayWindow::ending(at(2026, 9, 7, 23), 30);
        assert_eq!(window.end, day(2026, 9, 7));
        assert_eq!(window.start, day(2026, 8, 9));
        assert_eq!(window.len(), 30);
        assert_eq!(window.start_at(), at(2026, 8, 9, 0));

        let single = DayWindow::ending(at(2026, 9, 7, 0), 1);
        assert_eq!(single.start, single.end);
        assert_eq!(single.len(), 1);
    }

    #[test]
    fn zero_fills_every_day_in_order_and_drops_strays() {
        let window = DayWindow::ending(at(2026, 9, 7, 12), 3);
        let mut by_day = BTreeMap::new();
        by_day.insert(day(2026, 9, 7), 7);
        by_day.insert(day(2026, 9, 5), 5);
        by_day.insert(day(2026, 9, 1), 99); // before the window
        by_day.insert(day(2026, 9, 8), 99); // after the window
        let filled = fill_day_window(&window, by_day);
        assert_eq!(
            filled,
            vec![
                (day(2026, 9, 5), 5),
                (day(2026, 9, 6), 0),
                (day(2026, 9, 7), 7),
            ]
        );
    }

    // -- ai usage -----------------------------------------------------------

    fn usage_row(
        d: NaiveDate,
        mode: Option<&str>,
        automation: bool,
        runs: i64,
        input: i64,
        cached: i64,
        output: i64,
    ) -> AiUsageBreakdownRow {
        AiUsageBreakdownRow {
            day: d,
            access_mode: mode.map(str::to_string),
            automation,
            runs,
            input_tokens: input,
            cached_input_tokens: cached,
            output_tokens: output,
        }
    }

    fn project_row(seed: u8, input: i64, output: i64) -> AiUsageProjectRow {
        AiUsageProjectRow {
            project_id: Uuid::from_bytes([seed; 16]),
            project_name: Some(format!("project-{seed}")),
            org_name: None,
            runs: 1,
            input_tokens: input,
            output_tokens: output,
            automation_runs: 0,
        }
    }

    #[test]
    fn classifies_access_modes_case_insensitively() {
        assert_eq!(classify_access_mode(Some("managed")), AiAccessMode::Managed);
        assert_eq!(classify_access_mode(Some(" BYOC ")), AiAccessMode::Byoc);
        assert_eq!(classify_access_mode(Some("legacy")), AiAccessMode::Unknown);
        assert_eq!(classify_access_mode(Some("")), AiAccessMode::Unknown);
        assert_eq!(classify_access_mode(None), AiAccessMode::Unknown);
    }

    #[test]
    fn ai_usage_serialises_the_exact_keys_the_console_reads() {
        let now = at(2026, 9, 7, 12);
        let window = DayWindow::ending(now, 2);
        let usage = build_operator_ai_usage(
            now,
            window,
            vec![usage_row(
                day(2026, 9, 7),
                Some("managed"),
                true,
                2,
                100,
                40,
                10,
            )],
            vec![project_row(1, 100, 10)],
        );
        let payload = serde_json::to_value(&usage).expect("ai usage serialises");
        assert_no_snake_case_keys(&payload);

        assert_eq!(payload["generatedAt"], "2026-09-07T12:00:00+00:00");
        assert_eq!(payload["days"], 2);
        assert_eq!(payload["rangeStart"], "2026-09-06");
        assert_eq!(payload["rangeEnd"], "2026-09-07");

        let today = &payload["daily"][1];
        for key in [
            "day",
            "runs",
            "inputTokens",
            "cachedInputTokens",
            "outputTokens",
            "managedRuns",
            "automationRuns",
        ] {
            assert!(today.get(key).is_some(), "daily[].{key} missing");
        }
        for mode in ["managed", "byoc", "unknown"] {
            assert!(payload["byMode"][mode].get("runs").is_some());
            assert!(payload["byMode"][mode].get("tokens").is_some());
        }
        for origin in ["automation", "people"] {
            assert!(payload["byOrigin"][origin].get("runs").is_some());
            assert!(payload["byOrigin"][origin].get("tokens").is_some());
        }
        let project = &payload["topProjects"][0];
        for key in [
            "projectId",
            "projectName",
            "orgName",
            "runs",
            "inputTokens",
            "outputTokens",
            "automationRuns",
        ] {
            assert!(project.get(key).is_some(), "topProjects[].{key} missing");
        }
        assert!(
            project["orgName"].is_null(),
            "absent names are null, not dropped"
        );
    }

    #[test]
    fn ai_usage_folds_modes_and_origins_and_never_adds_cached_tokens() {
        let now = at(2026, 9, 7, 12);
        let window = DayWindow::ending(now, 3);
        let d7 = day(2026, 9, 7);
        let d5 = day(2026, 9, 5);
        let usage = build_operator_ai_usage(
            now,
            window,
            vec![
                usage_row(d7, Some("managed"), true, 3, 1_000, 400, 100),
                usage_row(d7, Some("byoc"), false, 2, 500, 200, 50),
                usage_row(d7, None, false, 1, 10, 0, 1),
                usage_row(d5, Some("byoc"), true, 4, 2_000, 1_000, 200),
                usage_row(d5, Some("odd"), false, 1, 20, 0, 2),
            ],
            Vec::new(),
        );
        let payload = serde_json::to_value(&usage).expect("ai usage serialises");

        let daily = payload["daily"].as_array().expect("daily is an array");
        assert_eq!(daily.len(), 3, "one entry per day in the window");
        assert_eq!(daily[0]["day"], "2026-09-05");
        assert_eq!(daily[1]["day"], "2026-09-06");
        assert_eq!(daily[2]["day"], "2026-09-07");

        // The empty middle day is zero-filled, not skipped.
        assert_eq!(daily[1]["runs"], 0);
        assert_eq!(daily[1]["inputTokens"], 0);
        assert_eq!(daily[1]["managedRuns"], 0);

        assert_eq!(daily[2]["runs"], 6);
        assert_eq!(daily[2]["inputTokens"], 1_510);
        assert_eq!(daily[2]["cachedInputTokens"], 600);
        assert_eq!(daily[2]["outputTokens"], 151);
        assert_eq!(daily[2]["managedRuns"], 3);
        assert_eq!(daily[2]["automationRuns"], 3);

        assert_eq!(daily[0]["runs"], 5);
        assert_eq!(daily[0]["managedRuns"], 0);
        assert_eq!(daily[0]["automationRuns"], 4);

        // tokens = input + output; cached is a subset of input.
        assert_eq!(payload["byMode"]["managed"]["runs"], 3);
        assert_eq!(payload["byMode"]["managed"]["tokens"], 1_100);
        assert_eq!(payload["byMode"]["byoc"]["runs"], 6);
        assert_eq!(payload["byMode"]["byoc"]["tokens"], 2_750);
        assert_eq!(payload["byMode"]["unknown"]["runs"], 2);
        assert_eq!(payload["byMode"]["unknown"]["tokens"], 33);

        assert_eq!(payload["byOrigin"]["automation"]["runs"], 7);
        assert_eq!(payload["byOrigin"]["automation"]["tokens"], 3_300);
        assert_eq!(payload["byOrigin"]["people"]["runs"], 4);
        assert_eq!(payload["byOrigin"]["people"]["tokens"], 583);
    }

    #[test]
    fn ai_usage_caps_top_projects_at_eight_by_total_tokens() {
        let now = at(2026, 9, 7, 12);
        let projects = (1..=12u8)
            .map(|seed| project_row(seed, i64::from(seed) * 100, 5))
            .collect();
        let usage = build_operator_ai_usage(now, DayWindow::ending(now, 1), Vec::new(), projects);
        let payload = serde_json::to_value(&usage).expect("ai usage serialises");
        let top = payload["topProjects"].as_array().expect("array");
        assert_eq!(top.len(), TOP_PROJECTS_LIMIT);
        let totals: Vec<i64> = top
            .iter()
            .map(|entry| {
                entry["inputTokens"].as_i64().unwrap() + entry["outputTokens"].as_i64().unwrap()
            })
            .collect();
        assert_eq!(
            totals,
            vec![1_205, 1_105, 1_005, 905, 805, 705, 605, 505],
            "descending by input + output"
        );
        assert_eq!(top[0]["projectId"], Uuid::from_bytes([12; 16]).to_string());
    }

    #[test]
    fn ai_usage_with_no_rows_is_a_full_zero_series() {
        let now = at(2026, 9, 7, 12);
        let usage =
            build_operator_ai_usage(now, DayWindow::ending(now, 30), Vec::new(), Vec::new());
        let payload = serde_json::to_value(&usage).expect("ai usage serialises");
        assert_eq!(payload["daily"].as_array().unwrap().len(), 30);
        assert_eq!(payload["byMode"]["managed"]["runs"], 0);
        assert_eq!(payload["byOrigin"]["people"]["tokens"], 0);
        assert_eq!(payload["topProjects"].as_array().unwrap().len(), 0);
    }

    // -- runtime fleet ------------------------------------------------------

    fn runtime_row(seed: u8, provider: &str, status: &str) -> RuntimeScanRow {
        RuntimeScanRow {
            runtime_id: Uuid::from_bytes([seed; 16]),
            project_id: Some(Uuid::from_bytes([seed.wrapping_add(0xA0); 16])),
            project_name: Some(format!("project-{seed}")),
            provider: provider.to_string(),
            status: status.to_string(),
            last_seen_at: None,
            idle_ttl_seconds: 3_600,
            display_name: None,
            has_active_lease: false,
            lease_started_at: None,
            size_id: None,
        }
    }

    fn empty_inputs(now: DateTime<Utc>) -> RuntimeMetricsInputs {
        RuntimeMetricsInputs {
            hosted_cap: 8,
            recency_grace_seconds: 300,
            window: DayWindow::ending(now, 30),
            stop_window: DayWindow::ending(now, STOP_WINDOW_DAYS),
            runtimes: Vec::new(),
            hosted_hours: Vec::new(),
            lifecycle: Vec::new(),
            stops: Vec::new(),
            providers: Vec::new(),
            origins: OriginPresenceCounts::default(),
        }
    }

    #[test]
    fn runtimes_serialise_the_exact_keys_the_console_reads() {
        let now = at(2026, 9, 7, 12);
        let mut hosted = runtime_row(1, "instafy-cloud", "ready");
        hosted.has_active_lease = true;
        hosted.last_seen_at = Some(now);
        hosted.lease_started_at = Some(at(2026, 9, 7, 10));
        let mut inputs = empty_inputs(now);
        inputs.runtimes = vec![hosted];
        inputs.hosted_hours = vec![HostedHoursRow {
            day: day(2026, 9, 7),
            seconds: 5_400,
            leases: 1,
        }];
        inputs.lifecycle = vec![RuntimeLifecycleRow {
            day: day(2026, 9, 7),
            created: 2,
            destroyed: 1,
        }];
        inputs.stops = vec![RuntimeStopRow {
            day: day(2026, 9, 7),
            reason: Some("manual".to_string()),
            stops: 1,
        }];
        inputs.providers = vec![RuntimeProviderRow {
            id: "instafy-cloud".to_string(),
            kind: Some("docker".to_string()),
            endpoint: Some("http://instafy-runtime-provider:9090".to_string()),
            updated_at: Some(now),
        }];
        inputs.origins = OriginPresenceCounts {
            online: 3,
            offline: 1,
            degraded: 0,
            avg_latency_ms: Some(42.5),
        };

        let payload =
            serde_json::to_value(build_operator_runtimes(now, inputs)).expect("serialises");
        assert_no_snake_case_keys(&payload);

        assert_eq!(payload["generatedAt"], "2026-09-07T12:00:00+00:00");
        assert_eq!(payload["hosted"]["active"], 1);
        assert_eq!(payload["hosted"]["cap"], 8);
        assert_eq!(payload["hosted"]["bySize"]["standard"], 1);

        let family = &payload["byProviderHealth"][0];
        for key in ["providerFamily", "online", "idle", "offline", "total"] {
            assert!(
                family.get(key).is_some(),
                "byProviderHealth[].{key} missing"
            );
        }

        let instance = &payload["instances"][0];
        for key in [
            "runtimeId",
            "projectId",
            "projectName",
            "providerFamily",
            "provider",
            "status",
            "health",
            "lastSeenAt",
            "leaseStartedAt",
            "sizeId",
            "displayName",
        ] {
            assert!(instance.get(key).is_some(), "instances[].{key} missing");
        }
        assert!(
            instance["displayName"].is_null(),
            "absent values are null, not dropped"
        );

        let hours = &payload["dailyHours"][29];
        assert_eq!(hours["day"], "2026-09-07");
        assert_eq!(hours["hours"], 1.5);
        assert_eq!(hours["leases"], 1);

        let lifecycle = &payload["dailyLifecycle"][29];
        assert_eq!(lifecycle["created"], 2);
        assert_eq!(lifecycle["destroyed"], 1);

        assert!(payload.get("stops_14d").is_none());
        assert!(payload.get("stops14D").is_none());
        let stops = payload["stops14d"]
            .as_array()
            .expect("stops14d is an array");
        for key in [
            "day",
            "heartbeatTimeout",
            "oomKilled",
            "terminalCleanup",
            "manual",
            "other",
        ] {
            assert!(stops[13].get(key).is_some(), "stops14d[].{key} missing");
        }
        assert_eq!(stops[13]["manual"], 1);

        assert!(payload["silent"].is_array());

        let provider = &payload["providers"][0];
        assert_eq!(provider["id"], "instafy-cloud");
        assert_eq!(provider["kind"], "docker");
        assert_eq!(provider["family"], "instafy-cloud");
        assert_eq!(provider["endpoint"], "http://instafy-runtime-provider:9090");
        assert_eq!(provider["updatedAt"], "2026-09-07T12:00:00+00:00");

        assert_eq!(payload["origins"]["online"], 3);
        assert_eq!(payload["origins"]["offline"], 1);
        assert_eq!(payload["origins"]["degraded"], 0);
        assert_eq!(payload["origins"]["avgLatencyMs"], 42.5);
    }

    #[test]
    fn stop_window_is_always_fourteen_days_and_buckets_reasons() {
        let now = at(2026, 9, 7, 12);
        let mut inputs = empty_inputs(now);
        // A 90-day request must not widen the stop series.
        inputs.window = DayWindow::ending(now, 90);
        let d7 = day(2026, 9, 7);
        inputs.stops = vec![
            RuntimeStopRow {
                day: d7,
                reason: Some("heartbeat_timeout".to_string()),
                stops: 3,
            },
            RuntimeStopRow {
                day: d7,
                reason: Some("oom_killed".to_string()),
                stops: 2,
            },
            RuntimeStopRow {
                day: d7,
                reason: Some("terminal_runtime_cleanup".to_string()),
                stops: 4,
            },
            RuntimeStopRow {
                day: d7,
                reason: Some("manual".to_string()),
                stops: 5,
            },
            RuntimeStopRow {
                day: d7,
                reason: Some("launch_timeout".to_string()),
                stops: 6,
            },
            RuntimeStopRow {
                day: d7,
                reason: None,
                stops: 1,
            },
            // Older than the retention window: dropped, not appended.
            RuntimeStopRow {
                day: day(2026, 8, 1),
                reason: Some("manual".to_string()),
                stops: 99,
            },
        ];
        let payload =
            serde_json::to_value(build_operator_runtimes(now, inputs)).expect("serialises");
        let stops = payload["stops14d"].as_array().expect("array");
        assert_eq!(stops.len(), 14);
        assert_eq!(stops[0]["day"], "2026-08-25");
        assert_eq!(stops[13]["day"], "2026-09-07");
        assert_eq!(stops[0]["manual"], 0);
        assert_eq!(stops[13]["heartbeatTimeout"], 3);
        assert_eq!(stops[13]["oomKilled"], 2);
        assert_eq!(stops[13]["terminalCleanup"], 4);
        assert_eq!(stops[13]["manual"], 5);
        assert_eq!(stops[13]["other"], 7);
        assert_eq!(payload["dailyHours"].as_array().unwrap().len(), 90);
    }

    #[test]
    fn hosted_predicate_matches_the_billing_sweep() {
        let now = at(2026, 9, 7, 12);
        let mut a = runtime_row(1, "instafy-cloud", "ready");
        a.has_active_lease = true;
        a.size_id = Some("boost".to_string());
        let mut b = runtime_row(2, "Instafy_Cloud_Webdev", "launching");
        b.has_active_lease = true;
        // Failed but still leased: the sweep bills it, so it counts as hosted,
        // yet it is terminal and stays out of the instance list.
        let mut c = runtime_row(3, "instafy-cloud", "failed");
        c.has_active_lease = true;
        // Leased but not our cloud: never hosted.
        let mut d = runtime_row(4, "self-hosted", "ready");
        d.has_active_lease = true;
        // Our cloud without a lease: not hosted.
        let e = runtime_row(5, "instafy-cloud", "ready");
        // Lookalike prefix: not hosted.
        let mut f = runtime_row(6, "instafy-clouded", "ready");
        f.has_active_lease = true;

        let mut inputs = empty_inputs(now);
        inputs.runtimes = vec![a, b, c, d, e, f];
        let payload =
            serde_json::to_value(build_operator_runtimes(now, inputs)).expect("serialises");
        assert_eq!(payload["hosted"]["active"], 3);
        assert_eq!(payload["hosted"]["bySize"]["boost"], 1);
        assert_eq!(payload["hosted"]["bySize"]["standard"], 2);

        let instances = payload["instances"].as_array().unwrap();
        assert_eq!(instances.len(), 5);
        assert!(instances.iter().all(|entry| entry["status"] != "failed"));
        let hosted_instance = instances
            .iter()
            .find(|entry| entry["runtimeId"] == Uuid::from_bytes([2; 16]).to_string())
            .unwrap();
        assert_eq!(
            hosted_instance["sizeId"], "standard",
            "hosted defaults the size"
        );
        assert_eq!(hosted_instance["providerFamily"], "instafy-cloud");
        let unleased = instances
            .iter()
            .find(|entry| entry["runtimeId"] == Uuid::from_bytes([5; 16]).to_string())
            .unwrap();
        assert!(unleased["sizeId"].is_null());
        let lookalike = instances
            .iter()
            .find(|entry| entry["runtimeId"] == Uuid::from_bytes([6; 16]).to_string())
            .unwrap();
        assert_eq!(lookalike["providerFamily"], "self-hosted");
    }

    #[test]
    fn health_matches_determine_runtime_health() {
        // Same inputs through the production function and the pure mirror;
        // the mirror gets the same grace the production function reads.
        let grace = *REMOTE_RUNTIME_RECENCY_SECONDS;
        let now = Utc::now();
        let cases = [
            (Some(now - Duration::seconds(5)), 3_600, "ready"),
            (Some(now - Duration::seconds(5)), 20, "ready"),
            (Some(now - Duration::seconds(45)), 20, "ready"),
            (Some(now - Duration::seconds(grace + 1)), 3_600, "ready"),
            (Some(now - Duration::seconds(grace * 4)), 3_600, "running"),
            (Some(now - Duration::seconds(3 * 3_600 + 1)), 3_600, "ready"),
            (None, 3_600, "ready"),
            (Some(now), 3_600, "stopping"),
            (Some(now), 3_600, "error"),
            (Some(now), 3_600, "Offline"),
            (Some(now), 0, "ready"),
        ];
        for (last_seen, ttl, status) in cases {
            let expected = crate::runtime::determine_runtime_health(last_seen, ttl, status, false);
            let actual = classify_runtime_health(now, last_seen, ttl, status, grace);
            assert_eq!(
                actual, expected,
                "last_seen={last_seen:?} ttl={ttl} status={status}"
            );
        }
    }

    #[test]
    fn health_thresholds_split_online_idle_offline() {
        let now = at(2026, 9, 7, 12);
        let grace = 300;
        assert_eq!(
            classify_runtime_health(
                now,
                Some(now - Duration::seconds(300)),
                3_600,
                "ready",
                grace
            ),
            "online"
        );
        assert_eq!(
            classify_runtime_health(
                now,
                Some(now - Duration::seconds(301)),
                3_600,
                "ready",
                grace
            ),
            "idle"
        );
        assert_eq!(
            classify_runtime_health(
                now,
                Some(now - Duration::seconds(10_800)),
                3_600,
                "ready",
                grace
            ),
            "idle"
        );
        assert_eq!(
            classify_runtime_health(
                now,
                Some(now - Duration::seconds(10_801)),
                3_600,
                "ready",
                grace
            ),
            "offline"
        );
        // A short TTL still enjoys the grace before going offline.
        assert_eq!(
            classify_runtime_health(now, Some(now - Duration::seconds(200)), 30, "ready", grace),
            "idle"
        );
    }

    #[test]
    fn rolls_health_up_per_family_with_both_families_always_present() {
        let now = at(2026, 9, 7, 12);
        let mut online = runtime_row(1, "instafy-cloud", "ready");
        online.last_seen_at = Some(now - Duration::seconds(10));
        let mut idle = runtime_row(2, "instafy-cloud", "ready");
        idle.last_seen_at = Some(now - Duration::seconds(600));
        let never = runtime_row(3, "instafy-cloud", "launching");
        let mut inputs = empty_inputs(now);
        inputs.runtimes = vec![online, idle, never];
        let payload =
            serde_json::to_value(build_operator_runtimes(now, inputs)).expect("serialises");
        let families = payload["byProviderHealth"].as_array().unwrap();
        assert_eq!(families.len(), 2);
        assert_eq!(families[0]["providerFamily"], "instafy-cloud");
        assert_eq!(families[0]["online"], 1);
        assert_eq!(families[0]["idle"], 1);
        assert_eq!(families[0]["offline"], 1);
        assert_eq!(families[0]["total"], 3);
        assert_eq!(families[1]["providerFamily"], "self-hosted");
        assert_eq!(families[1]["total"], 0);
    }

    #[test]
    fn instances_are_capped_at_fifty_newest_lease_first() {
        let now = at(2026, 9, 7, 12);
        let mut runtimes: Vec<RuntimeScanRow> = (0..60u8)
            .map(|seed| {
                let mut row = runtime_row(seed, "self-hosted", "ready");
                // Oldest lease first in the input so the sort is exercised.
                row.lease_started_at = Some(at(2026, 9, 1, 0) + Duration::minutes(i64::from(seed)));
                row
            })
            .collect();
        runtimes.push(runtime_row(200, "self-hosted", "ready")); // no lease
        let mut inputs = empty_inputs(now);
        inputs.runtimes = runtimes;
        let payload =
            serde_json::to_value(build_operator_runtimes(now, inputs)).expect("serialises");
        let instances = payload["instances"].as_array().unwrap();
        assert_eq!(instances.len(), INSTANCE_LIMIT);
        assert_eq!(
            instances[0]["runtimeId"],
            Uuid::from_bytes([59; 16]).to_string()
        );
        assert_eq!(
            instances[49]["runtimeId"],
            Uuid::from_bytes([10; 16]).to_string()
        );
        assert!(
            instances
                .iter()
                .all(|entry| entry["runtimeId"] != Uuid::from_bytes([200; 16]).to_string()),
            "the unleased runtime sorts last and falls off the cap"
        );
        // The rollup still counts every runtime, not just the listed fifty.
        assert_eq!(payload["byProviderHealth"][1]["total"], 61);
    }

    #[test]
    fn silent_lists_live_runtimes_that_stopped_heartbeating() {
        let now = at(2026, 9, 7, 12);
        let mut talking = runtime_row(1, "self-hosted", "ready");
        talking.last_seen_at = Some(now - Duration::seconds(299));
        let mut quiet = runtime_row(2, "self-hosted", "running");
        quiet.last_seen_at = Some(now - Duration::seconds(301));
        let mut quieter = runtime_row(3, "instafy-cloud", "ready");
        quieter.last_seen_at = Some(now - Duration::hours(2));
        let never = runtime_row(4, "instafy-cloud", "ready");
        // Not a live status: launching is expected to be quiet.
        let launching = runtime_row(5, "instafy-cloud", "launching");
        let mut inputs = empty_inputs(now);
        inputs.runtimes = vec![talking, quiet, quieter, never, launching];
        let payload =
            serde_json::to_value(build_operator_runtimes(now, inputs)).expect("serialises");
        let silent = payload["silent"].as_array().unwrap();
        let ids: Vec<&str> = silent
            .iter()
            .map(|entry| entry["runtimeId"].as_str().unwrap())
            .collect();
        assert_eq!(
            ids,
            vec![
                Uuid::from_bytes([4; 16]).to_string(),
                Uuid::from_bytes([3; 16]).to_string(),
                Uuid::from_bytes([2; 16]).to_string(),
            ]
        );
        assert!(silent[0]["lastSeenAt"].is_null());
        assert_eq!(silent[0]["projectName"], "project-4");
        assert_eq!(silent[2]["status"], "running");
    }

    #[test]
    fn hosted_hours_round_to_two_decimals_and_zero_fill() {
        let now = at(2026, 9, 7, 12);
        let mut inputs = empty_inputs(now);
        inputs.window = DayWindow::ending(now, 3);
        inputs.hosted_hours = vec![
            HostedHoursRow {
                day: day(2026, 9, 5),
                seconds: 3_661, // 1.01694h
                leases: 2,
            },
            HostedHoursRow {
                day: day(2026, 9, 7),
                seconds: 86_400,
                leases: 1,
            },
        ];
        inputs.lifecycle = vec![RuntimeLifecycleRow {
            day: day(2026, 9, 6),
            created: 3,
            destroyed: 0,
        }];
        let payload =
            serde_json::to_value(build_operator_runtimes(now, inputs)).expect("serialises");
        let hours = payload["dailyHours"].as_array().unwrap();
        assert_eq!(hours.len(), 3);
        assert_eq!(hours[0]["day"], "2026-09-05");
        assert_eq!(hours[0]["hours"], 1.02);
        assert_eq!(hours[0]["leases"], 2);
        assert_eq!(hours[1]["hours"], 0.0);
        assert_eq!(hours[1]["leases"], 0);
        assert_eq!(hours[2]["hours"], 24.0);

        let lifecycle = payload["dailyLifecycle"].as_array().unwrap();
        assert_eq!(lifecycle.len(), 3);
        assert_eq!(lifecycle[0]["created"], 0);
        assert_eq!(lifecycle[1]["created"], 3);
        assert_eq!(lifecycle[1]["destroyed"], 0);
        assert_eq!(lifecycle[2]["destroyed"], 0);
    }

    #[test]
    fn classifies_provider_route_families() {
        assert_eq!(
            provider_route_family("instafy-cloud", Some("docker")),
            Some("instafy-cloud")
        );
        assert_eq!(
            provider_route_family("instafy_cloud_webdev", Some("http")),
            Some("instafy-cloud")
        );
        assert_eq!(
            provider_route_family("self-hosted", Some("self_hosted")),
            Some("self-hosted")
        );
        assert_eq!(
            provider_route_family("lima-box", Some("self-hosted")),
            Some("self-hosted")
        );
        assert_eq!(provider_route_family("runtime", Some("docker")), None);
        assert_eq!(provider_route_family("runtime", None), None);
    }

    #[test]
    fn classifies_stop_reasons_into_the_console_buckets() {
        assert_eq!(
            classify_stop_reason(Some("heartbeat_timeout")),
            StopReasonBucket::HeartbeatTimeout
        );
        assert_eq!(
            classify_stop_reason(Some("oom_killed")),
            StopReasonBucket::OomKilled
        );
        assert_eq!(
            classify_stop_reason(Some("terminal_runtime_cleanup")),
            StopReasonBucket::TerminalCleanup
        );
        assert_eq!(
            classify_stop_reason(Some("manual")),
            StopReasonBucket::Manual
        );
        assert_eq!(
            classify_stop_reason(Some("idle_timeout")),
            StopReasonBucket::Other
        );
        assert_eq!(classify_stop_reason(None), StopReasonBucket::Other);
    }

    #[test]
    fn origins_average_latency_is_null_when_nothing_reports() {
        let now = at(2026, 9, 7, 12);
        let payload = serde_json::to_value(build_operator_runtimes(now, empty_inputs(now)))
            .expect("serialises");
        assert!(payload["origins"].get("avgLatencyMs").is_some());
        assert!(payload["origins"]["avgLatencyMs"].is_null());
        assert_eq!(payload["origins"]["online"], 0);
        assert_eq!(payload["hosted"]["active"], 0);
        assert_eq!(payload["hosted"]["bySize"].as_object().unwrap().len(), 0);
        assert_eq!(payload["instances"].as_array().unwrap().len(), 0);
        assert_eq!(payload["dailyHours"].as_array().unwrap().len(), 30);
        assert_eq!(payload["dailyLifecycle"].as_array().unwrap().len(), 30);
        assert_eq!(payload["stops14d"].as_array().unwrap().len(), 14);
    }
}
