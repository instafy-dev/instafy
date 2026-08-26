use std::str::FromStr;
use std::time::Duration;

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{
    DateTime, Datelike, Duration as ChronoDuration, NaiveDate, NaiveDateTime, TimeZone, Utc,
    Weekday,
};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tracing::{info, warn};
use uuid::Uuid;

use crate::active_job_auth::{
    authorize_active_job_if_scoped, ActiveJobAuthorization, ActiveJobProjectAccess,
};
use crate::auth::{authenticate_request, RequestContext};
use crate::{
    bad_request, ensure_project_write_access, internal_error, load_project_record, not_found,
    unauthorized, ApiError, AppState,
};

const DEFAULT_TIMEZONE: &str = "UTC";
const DEFAULT_HOURLY_INTERVAL: i32 = 24;
const AUTOMATION_SCHEDULER_TICK_SECONDS: u64 = 30;
const AUTOMATION_SCHEDULER_LOCK_SECONDS: i64 = 10 * 60;
const AUTOMATION_SCHEDULER_BATCH_SIZE: i64 = 10;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateAutomationBody {
    name: String,
    #[serde(default)]
    prompt_text: Option<String>,
    #[serde(default)]
    metadata: Option<JsonValue>,
    schedule_kind: String,
    #[serde(default)]
    run_at: Option<String>,
    #[serde(default)]
    interval_hours: Option<i32>,
    #[serde(default)]
    by_day: Option<Vec<String>>,
    #[serde(default)]
    by_hour: Option<i32>,
    #[serde(default)]
    by_minute: Option<i32>,
    #[serde(default)]
    timezone: Option<String>,
    #[serde(default)]
    runtime_mode: Option<String>,
    #[serde(default)]
    runtime_provider: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    silent_when_nothing_to_report: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAutomationBody {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    prompt_text: Option<String>,
    #[serde(default)]
    metadata: Option<JsonValue>,
    #[serde(default)]
    schedule_kind: Option<String>,
    #[serde(default)]
    run_at: Option<String>,
    #[serde(default)]
    interval_hours: Option<i32>,
    #[serde(default)]
    by_day: Option<Vec<String>>,
    #[serde(default)]
    by_hour: Option<i32>,
    #[serde(default)]
    by_minute: Option<i32>,
    #[serde(default)]
    timezone: Option<String>,
    #[serde(default)]
    runtime_mode: Option<String>,
    #[serde(default)]
    runtime_provider: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    silent_when_nothing_to_report: Option<bool>,
}

impl UpdateAutomationBody {
    fn is_status_only(&self) -> bool {
        self.status.is_some()
            && self.name.is_none()
            && self.prompt_text.is_none()
            && self.metadata.is_none()
            && self.schedule_kind.is_none()
            && self.run_at.is_none()
            && self.interval_hours.is_none()
            && self.by_day.is_none()
            && self.by_hour.is_none()
            && self.by_minute.is_none()
            && self.timezone.is_none()
            && self.runtime_mode.is_none()
            && self.runtime_provider.is_none()
            && self.silent_when_nothing_to_report.is_none()
    }
}

fn can_access_owned_automation(
    owner_user_id: Uuid,
    actor_user_id: Uuid,
    is_service_role: bool,
    is_active_job: bool,
) -> bool {
    owner_user_id == actor_user_id || (is_service_role && !is_active_job)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AutomationPayload {
    id: String,
    project_id: String,
    user_id: String,
    name: String,
    prompt_text: String,
    metadata: JsonValue,
    schedule_kind: String,
    run_at: Option<String>,
    interval_hours: Option<i32>,
    by_day: Vec<String>,
    by_hour: Option<i32>,
    by_minute: Option<i32>,
    timezone: String,
    runtime_mode: String,
    runtime_provider: Option<String>,
    silent_when_nothing_to_report: bool,
    conversation_id: Option<String>,
    status: String,
    locked_until: Option<String>,
    last_run_at: Option<String>,
    next_run_at: Option<String>,
    last_error: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone)]
struct AutomationRecord {
    id: Uuid,
    project_id: Uuid,
    user_id: Uuid,
    name: String,
    prompt_text: String,
    metadata: JsonValue,
    schedule_kind: String,
    run_at: Option<DateTime<Utc>>,
    interval_hours: Option<i32>,
    by_day: Vec<String>,
    by_hour: Option<i32>,
    by_minute: Option<i32>,
    timezone: String,
    runtime_mode: String,
    runtime_provider: Option<String>,
    silent_when_nothing_to_report: bool,
    conversation_id: Option<Uuid>,
    status: String,
    locked_until: Option<DateTime<Utc>>,
    last_run_at: Option<DateTime<Utc>>,
    next_run_at: Option<DateTime<Utc>>,
    last_error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

fn normalize_timezone(raw: Option<String>) -> String {
    raw.map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_TIMEZONE.to_string())
}

fn parse_tz(raw: &str) -> Option<Tz> {
    Tz::from_str(raw.trim()).ok()
}

fn normalize_runtime_mode(raw: Option<String>) -> String {
    raw.map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "auto".to_string())
}

fn normalize_status(raw: Option<String>) -> String {
    raw.map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "active".to_string())
}

fn normalize_schedule_kind(raw: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let normalized = raw.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "hourly" | "weekly" | "once" => Ok(normalized),
        _ => Err(bad_request("scheduleKind must be hourly, weekly, or once")),
    }
}

fn normalize_metadata(raw: Option<JsonValue>) -> Result<JsonValue, (StatusCode, Json<ApiError>)> {
    match raw {
        Some(JsonValue::Object(map)) => Ok(JsonValue::Object(map)),
        Some(_) => Err(bad_request("metadata must be a JSON object")),
        None => Ok(json!({})),
    }
}

fn normalize_execution_mode(raw: Option<&str>) -> &'static str {
    let normalized = raw.map(|value| value.trim().to_ascii_lowercase());
    match normalized.as_deref() {
        // Note: runtime-agent currently only supports "apply" for the Codex bridge.
        // Treat other modes as "apply" for now so automations still run.
        Some("apply") => "apply",
        Some("approval_required") | Some("plan_only") => "apply",
        _ => "apply",
    }
}

fn ensure_execution_mode(metadata: &mut JsonMap<String, JsonValue>) -> String {
    let raw = metadata.get("execution_mode").and_then(JsonValue::as_str);
    let normalized = normalize_execution_mode(raw);
    metadata.insert(
        "execution_mode".to_string(),
        JsonValue::String(normalized.to_string()),
    );
    normalized.to_string()
}

fn parse_weekday_token(raw: &str) -> Option<Weekday> {
    let value = raw.trim().to_ascii_lowercase();
    match value.as_str() {
        "mo" | "mon" | "monday" => Some(Weekday::Mon),
        "tu" | "tue" | "tues" | "tuesday" => Some(Weekday::Tue),
        "we" | "wed" | "wednesday" => Some(Weekday::Wed),
        "th" | "thu" | "thur" | "thurs" | "thursday" => Some(Weekday::Thu),
        "fr" | "fri" | "friday" => Some(Weekday::Fri),
        "sa" | "sat" | "saturday" => Some(Weekday::Sat),
        "su" | "sun" | "sunday" => Some(Weekday::Sun),
        _ => None,
    }
}

fn format_weekday_token(day: Weekday) -> &'static str {
    match day {
        Weekday::Mon => "mo",
        Weekday::Tue => "tu",
        Weekday::Wed => "we",
        Weekday::Thu => "th",
        Weekday::Fri => "fr",
        Weekday::Sat => "sa",
        Weekday::Sun => "su",
    }
}

fn normalize_weekly_days(
    raw: Option<Vec<String>>,
) -> Result<Vec<String>, (StatusCode, Json<ApiError>)> {
    let mut seen = std::collections::HashSet::<String>::new();
    let mut out: Vec<String> = Vec::new();
    for entry in raw.unwrap_or_default() {
        let Some(day) = parse_weekday_token(&entry) else {
            return Err(bad_request(
                "byDay entries must be weekday abbreviations (mo..su)",
            ));
        };
        let token = format_weekday_token(day).to_string();
        if seen.insert(token.clone()) {
            out.push(token);
        }
    }
    out.sort();
    Ok(out)
}

fn parse_run_at(raw: &str, timezone: &str) -> Result<DateTime<Utc>, (StatusCode, Json<ApiError>)> {
    let value = raw.trim();
    if value.is_empty() {
        return Err(bad_request("runAt is required for once schedules"));
    }

    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Ok(parsed.with_timezone(&Utc));
    }

    let naive = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S"))
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M"))
        .or_else(|_| NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M"))
        .map_err(|_| {
            bad_request("runAt must be RFC3339 or local datetime (YYYY-MM-DDTHH:MM[:SS])")
        })?;

    let tz = parse_tz(timezone).unwrap_or(chrono_tz::UTC);
    // Handle DST gaps/overlaps. Prefer earliest mapping when ambiguous.
    let mut candidate_local = tz.from_local_datetime(&naive).earliest();
    if candidate_local.is_none() {
        // If the local time does not exist (DST jump), try bumping forward in 30m steps.
        for bump in 1..=6i64 {
            let bumped = naive + ChronoDuration::minutes(30 * bump);
            candidate_local = tz.from_local_datetime(&bumped).earliest();
            if candidate_local.is_some() {
                break;
            }
        }
    }

    let Some(candidate_local) = candidate_local else {
        return Err(bad_request(
            "runAt maps to a non-existent local time in the chosen timezone",
        ));
    };

    Ok(candidate_local.with_timezone(&Utc))
}

fn compute_next_run_at(
    now: DateTime<Utc>,
    schedule_kind: &str,
    interval_hours: Option<i32>,
    by_day: &[String],
    by_hour: Option<i32>,
    by_minute: Option<i32>,
    timezone: &str,
) -> DateTime<Utc> {
    let tz = parse_tz(timezone).unwrap_or(chrono_tz::UTC);
    match schedule_kind {
        "weekly" => compute_next_weekly_run_at(now, tz, by_day, by_hour, by_minute)
            .unwrap_or_else(|| now + ChronoDuration::hours(24)),
        _ => {
            let interval = interval_hours.unwrap_or(DEFAULT_HOURLY_INTERVAL).max(1) as i64;
            now + ChronoDuration::hours(interval)
        }
    }
}

fn compute_next_weekly_run_at(
    now: DateTime<Utc>,
    tz: Tz,
    by_day_tokens: &[String],
    by_hour: Option<i32>,
    by_minute: Option<i32>,
) -> Option<DateTime<Utc>> {
    let hour = by_hour.unwrap_or(9).clamp(0, 23) as u32;
    let minute = by_minute.unwrap_or(0).clamp(0, 59) as u32;
    let mut days: Vec<Weekday> = by_day_tokens
        .iter()
        .filter_map(|token| parse_weekday_token(token))
        .collect();
    days.sort_by_key(|day| day.num_days_from_monday());
    days.dedup();
    if days.is_empty() {
        return None;
    }

    let now_local = now.with_timezone(&tz);
    let today = NaiveDate::from_ymd_opt(now_local.year(), now_local.month(), now_local.day())?;

    for offset_days in 0..=7i64 {
        let candidate_date = today + ChronoDuration::days(offset_days);
        let weekday = candidate_date.weekday();
        if !days.contains(&weekday) {
            continue;
        }

        let naive = NaiveDateTime::new(
            candidate_date,
            chrono::NaiveTime::from_hms_opt(hour, minute, 0)?,
        );
        // Handle DST gaps/overlaps. Prefer earliest mapping when ambiguous.
        let mut candidate_local = tz.from_local_datetime(&naive).earliest();
        if candidate_local.is_none() {
            // If the local time does not exist (DST jump), try bumping forward in 30m steps.
            for bump in 1..=6i64 {
                let bumped = naive + ChronoDuration::minutes(30 * bump);
                candidate_local = tz.from_local_datetime(&bumped).earliest();
                if candidate_local.is_some() {
                    break;
                }
            }
        }

        let Some(candidate_local) = candidate_local else {
            continue;
        };

        if candidate_local > now_local {
            return Some(candidate_local.with_timezone(&Utc));
        }
    }

    None
}

fn row_to_record(row: &tokio_postgres::Row) -> AutomationRecord {
    AutomationRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        user_id: row.get("user_id"),
        name: row.get("name"),
        prompt_text: row.get("prompt_text"),
        metadata: row.get::<_, JsonValue>("metadata"),
        schedule_kind: row.get("schedule_kind"),
        run_at: row.get("run_at"),
        interval_hours: row.get("interval_hours"),
        by_day: row.get::<_, Vec<String>>("by_day"),
        by_hour: row.get("by_hour"),
        by_minute: row.get("by_minute"),
        timezone: row.get("timezone"),
        runtime_mode: row.get("runtime_mode"),
        runtime_provider: row.get("runtime_provider"),
        silent_when_nothing_to_report: row.get("silent_when_nothing_to_report"),
        conversation_id: row.get("conversation_id"),
        status: row.get("status"),
        locked_until: row.get("locked_until"),
        last_run_at: row.get("last_run_at"),
        next_run_at: row.get("next_run_at"),
        last_error: row.get("last_error"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    }
}

fn record_to_payload(record: AutomationRecord) -> AutomationPayload {
    AutomationPayload {
        id: record.id.to_string(),
        project_id: record.project_id.to_string(),
        user_id: record.user_id.to_string(),
        name: record.name,
        prompt_text: record.prompt_text,
        metadata: record.metadata,
        schedule_kind: record.schedule_kind,
        run_at: record.run_at.map(|value| value.to_rfc3339()),
        interval_hours: record.interval_hours,
        by_day: record.by_day,
        by_hour: record.by_hour,
        by_minute: record.by_minute,
        timezone: record.timezone,
        runtime_mode: record.runtime_mode,
        runtime_provider: record.runtime_provider,
        silent_when_nothing_to_report: record.silent_when_nothing_to_report,
        conversation_id: record.conversation_id.map(|value| value.to_string()),
        status: record.status,
        locked_until: record.locked_until.map(|value| value.to_rfc3339()),
        last_run_at: record.last_run_at.map(|value| value.to_rfc3339()),
        next_run_at: record.next_run_at.map(|value| value.to_rfc3339()),
        last_error: record.last_error,
        created_at: record.created_at.to_rfc3339(),
        updated_at: record.updated_at.to_rfc3339(),
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/:project_id/automations",
            get(list_project_automations).post(create_project_automation),
        )
        .route(
            "/automations/:automation_id",
            get(get_automation)
                .patch(update_automation)
                .delete(delete_automation),
        )
        .route("/automations/:automation_id/run", post(run_automation_now))
}

pub(crate) fn spawn_automation_scheduler(state: AppState) {
    tokio::spawn(async move {
        let mut ticker =
            tokio::time::interval(Duration::from_secs(AUTOMATION_SCHEDULER_TICK_SECONDS));
        loop {
            ticker.tick().await;
            if let Err(error) = automation_scheduler_tick(&state).await {
                warn!(?error, "automation scheduler tick failed");
            }
        }
    });
}

pub(crate) async fn automation_scheduler_tick(state: &AppState) -> anyhow::Result<()> {
    let claimed = claim_due_automations(state).await?;
    if claimed.is_empty() {
        return Ok(());
    }

    info!(
        count = claimed.len(),
        "automation scheduler executing due automations"
    );

    let mut join_set = tokio::task::JoinSet::new();
    for record in claimed {
        let state = state.clone();
        join_set.spawn(async move {
            if let Err(error) = execute_automation_once(&state, &record).await {
                warn!(
                    automation_id = %record.id,
                    project_id = %record.project_id,
                    user_id = %record.user_id,
                    ?error,
                    "automation execution failed"
                );
            }
        });
    }

    while let Some(_result) = join_set.join_next().await {}

    Ok(())
}

async fn claim_due_automations(state: &AppState) -> anyhow::Result<Vec<AutomationRecord>> {
    let mut connection = state.pool.get().await?;
    let transaction = connection.transaction().await?;

    let rows = transaction
        .query(
            "update automations
             set locked_until = now() + ($1::bigint * interval '1 second')
             where id in (
               select id
               from automations
               where status = 'active'
                 and next_run_at is not null
                 and next_run_at <= now()
                 and (locked_until is null or locked_until <= now())
               order by next_run_at asc
               limit $2
               for update skip locked
             )
             returning id,
                       project_id,
                       user_id,
                       name,
                       prompt_text,
                       metadata,
                       schedule_kind,
                       run_at,
                       interval_hours,
                       by_day,
                       by_hour,
                       by_minute,
                       timezone,
                       runtime_mode,
                       runtime_provider,
                       silent_when_nothing_to_report,
                       conversation_id,
                       status,
                       locked_until,
                       last_run_at,
                       next_run_at,
                       last_error,
                       created_at,
                       updated_at",
            &[
                &AUTOMATION_SCHEDULER_LOCK_SECONDS,
                &AUTOMATION_SCHEDULER_BATCH_SIZE,
            ],
        )
        .await?;

    transaction.commit().await?;

    Ok(rows.iter().map(row_to_record).collect())
}

async fn execute_automation_once(
    state: &AppState,
    record: &AutomationRecord,
) -> anyhow::Result<()> {
    let now = Utc::now();
    let (next_run_at, status_override) = if record.schedule_kind == "once" {
        (None, Some("paused"))
    } else {
        (
            Some(compute_next_run_at(
                now,
                record.schedule_kind.as_str(),
                record.interval_hours,
                &record.by_day,
                record.by_hour,
                record.by_minute,
                record.timezone.as_str(),
            )),
            None,
        )
    };

    if let Err((_, Json(api_error))) = authorize_automation_execution(state, record).await {
        finalize_automation_attempt(
            state,
            record.id,
            now,
            next_run_at,
            status_override,
            Some(api_error.message),
        )
        .await?;
        return Ok(());
    }

    let mut metadata = record.metadata.clone();
    let execution_mode = if let JsonValue::Object(map) = &mut metadata {
        let automation_meta = json!({
            "id": record.id.to_string(),
            "name": record.name.clone(),
        });
        map.entry("automation".to_string())
            .or_insert(automation_meta);
        ensure_execution_mode(map)
    } else {
        metadata = json!({});
        let JsonValue::Object(map) = &mut metadata else {
            unreachable!("metadata normalization must yield an object");
        };
        ensure_execution_mode(map)
    };

    let runtime_mode = record.runtime_mode.trim().to_ascii_lowercase();

    let runtime_id = match runtime_mode.as_str() {
        "hosted" => {
            let runtime_provider = record
                .runtime_provider
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .unwrap_or_else(|| state.provider_registry.default_provider_id());
            let provider_is_self_hosted =
                crate::runtime::provider_is_private_self_hosted_or_quarantined(
                    state,
                    &runtime_provider,
                );
            if !hosted_automation_provider_is_managed(&runtime_provider, provider_is_self_hosted) {
                finalize_automation_attempt(
                    state,
                    record.id,
                    now,
                    next_run_at,
                    status_override,
                    Some(
                        "Hosted automations require a controller-managed runtime provider"
                            .to_string(),
                    ),
                )
                .await?;
                return Ok(());
            }
            let response = crate::runtime::ensure_runtime_for_automation(
                state,
                record.project_id,
                Some(runtime_provider),
                None,
                None,
                None,
                Some(json!({
                    "source": "automation",
                    "automation_id": record.id.to_string(),
                })),
            )
            .await;
            match response {
                Ok(response) => Some(Uuid::from_str(&response.runtime_id)?),
                Err((_, Json(api_error))) => {
                    finalize_automation_attempt(
                        state,
                        record.id,
                        now,
                        next_run_at,
                        status_override,
                        Some(api_error.message),
                    )
                    .await?;
                    return Ok(());
                }
            }
        }
        "auto" => {
            if let Some(runtime_id) = select_viable_runtime_id(
                state,
                record.project_id,
                record.user_id,
                record.runtime_provider.as_deref(),
            )
            .await?
            {
                Some(runtime_id)
            } else {
                let response = crate::runtime::ensure_runtime_for_automation(
                    state,
                    record.project_id,
                    record.runtime_provider.clone(),
                    None,
                    None,
                    None,
                    Some(json!({
                        "source": "automation",
                        "automation_id": record.id.to_string(),
                    })),
                )
                .await;
                match response {
                    Ok(response) => Some(Uuid::from_str(&response.runtime_id)?),
                    Err((_, Json(api_error))) => {
                        finalize_automation_attempt(
                            state,
                            record.id,
                            now,
                            next_run_at,
                            status_override,
                            Some(api_error.message),
                        )
                        .await?;
                        return Ok(());
                    }
                }
            }
        }
        _ => None,
    };

    let mut request_metadata = metadata;
    if !matches!(request_metadata, JsonValue::Object(_)) {
        request_metadata = json!({});
    }
    let workspace_mode = if execution_mode == "plan_only" {
        "shared_read".to_string()
    } else {
        "shared_write".to_string()
    };
    if let Some(map) = request_metadata.as_object_mut() {
        map.insert(
            "execution_mode".to_string(),
            JsonValue::String(execution_mode.clone()),
        );
        map.insert(
            "executionMode".to_string(),
            JsonValue::String(workspace_mode.clone()),
        );
        map.insert(
            "workspaceMode".to_string(),
            JsonValue::String(workspace_mode.clone()),
        );
        map.entry("writeIntent".to_string())
            .or_insert(JsonValue::Bool(execution_mode != "plan_only"));
    }

    let response = crate::dispatch::process_dispatch_prompt(
        state,
        &RequestContext {
            user_id: Some(record.user_id),
            is_service_role: false,
            scoped_claims: None,
        },
        crate::dispatch::DispatchPromptNormalized {
            project_id: record.project_id,
            session_id: None,
            session_raw: None,
            conversation_id: record.conversation_id,
            conversation_raw: record.conversation_id.map(|value| value.to_string()),
            conversation_metadata: Some(build_automation_conversation_metadata(
                record.user_id,
                record.id,
                record.name.as_str(),
            )),
            parent_conversation_id: None,
            thread_kind: Some("automation".to_string()),
            conversation_is_new: false,
            prompt_text: record.prompt_text.clone(),
            intent: "feature".to_string(),
            plan_seed: None,
            metadata: request_metadata,
            tool_limits: None,
            repo: None,
            requested_preview: None,
            priority: 100,
            runtime_type: None,
            idle_ttl_seconds: None,
            project_type_hint: None,
            execution_mode,
            workspace_mode,
            runtime_id,
            runtime_source: runtime_id.map(|_| "automation".to_string()),
            runtime_updated_at: runtime_id.map(|_| now),
            runtime_display_name: None,
            prefer_runtime: runtime_id.is_some(),
            expected_lane_idle: false,
            dispatch_queue_entry_id: None,
            allow_silent_automation_decline: record.silent_when_nothing_to_report,
        },
    )
    .await;

    match response {
        Ok(result) => {
            if record.conversation_id.is_none() {
                if let Some(conversation_id) = result.conversation_id {
                    attach_automation_conversation(state, record.id, conversation_id).await?;
                }
            }
            finalize_automation_attempt(state, record.id, now, next_run_at, status_override, None)
                .await?;
        }
        Err((_, Json(api_error))) => {
            finalize_automation_attempt(
                state,
                record.id,
                now,
                next_run_at,
                status_override,
                Some(api_error.message),
            )
            .await?;
        }
    }

    Ok(())
}

async fn authorize_automation_execution(
    state: &AppState,
    record: &AutomationRecord,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let context = RequestContext {
        user_id: Some(record.user_id),
        is_service_role: false,
        scoped_claims: None,
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
    let project = load_project_record(&transaction, &record.project_id).await?;
    ensure_project_write_access(&transaction, &project, &context, None).await?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize automation permission check: {error}"
        ))
    })?;
    Ok(())
}

fn build_automation_conversation_metadata(
    user_id: Uuid,
    automation_id: Uuid,
    name: &str,
) -> JsonValue {
    let lifecycle_key = format!("instafy_conversation_lifecycle_v1_{user_id}");
    json!({
        "title": name,
        "visibility": "private",
        lifecycle_key: "hidden",
        "automationId": automation_id.to_string(),
    })
}

async fn attach_automation_conversation(
    state: &AppState,
    automation_id: Uuid,
    conversation_id: Uuid,
) -> anyhow::Result<()> {
    let connection = state.pool.get().await?;
    connection
        .execute(
            "update automations set conversation_id = $2, updated_at = now() where id = $1 and conversation_id is null",
            &[&automation_id, &conversation_id],
        )
        .await?;
    Ok(())
}

async fn finalize_automation_attempt(
    state: &AppState,
    automation_id: Uuid,
    attempted_at: DateTime<Utc>,
    next_run_at: Option<DateTime<Utc>>,
    status_override: Option<&str>,
    error: Option<String>,
) -> anyhow::Result<()> {
    let connection = state.pool.get().await?;
    let error_value = error
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());
    let stored_error = error_value.map(|value| {
        if value.len() > 2048 {
            value.chars().take(2048).collect::<String>()
        } else {
            value.to_string()
        }
    });

    let status_override = status_override
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    connection
        .execute(
            "update automations
             set locked_until = null,
                 last_run_at = $2,
                 next_run_at = $3,
                 last_error = $4,
                 status = coalesce($5, status),
                 updated_at = now()
             where id = $1",
            &[
                &automation_id,
                &attempted_at,
                &next_run_at,
                &stored_error,
                &status_override,
            ],
        )
        .await?;
    Ok(())
}

async fn select_viable_runtime_id(
    state: &AppState,
    project_id: Uuid,
    owner_user_id: Uuid,
    provider: Option<&str>,
) -> anyhow::Result<Option<Uuid>> {
    let connection = state.pool.get().await?;
    let rows = if let Some(provider) = provider.map(str::trim).filter(|value| !value.is_empty()) {
        connection
            .query(
                "select id, provider, capabilities
                 from runtimes
                 where project_id = $1
                   and provider = $2
                   and status in ('ready', 'leased')
                 order by updated_at desc",
                &[&project_id, &provider],
            )
            .await?
    } else {
        connection
            .query(
                "select id, provider, capabilities
                 from runtimes
                 where project_id = $1
                   and status in ('ready', 'leased')
                 order by updated_at desc",
                &[&project_id],
            )
            .await?
    };
    Ok(rows.into_iter().find_map(|row| {
        let provider: String = row.get("provider");
        let capabilities: JsonValue = row.get("capabilities");
        let provider_is_self_hosted =
            crate::runtime::runtime_is_private_self_hosted(state, &provider, &capabilities);
        automation_runtime_is_selectable(
            &provider,
            &capabilities,
            owner_user_id,
            provider_is_self_hosted,
        )
        .then(|| row.get::<_, Uuid>("id"))
    }))
}

fn automation_runtime_is_selectable(
    provider: &str,
    capabilities: &JsonValue,
    owner_user_id: Uuid,
    provider_is_self_hosted: bool,
) -> bool {
    if !provider_is_self_hosted
        && !crate::runtime::runtime_has_private_self_hosted_identity(provider, capabilities)
    {
        return true;
    }

    crate::runtime::self_hosted_owner_user_id(capabilities) == Some(owner_user_id)
}

fn hosted_automation_provider_is_managed(provider: &str, configured_as_self_hosted: bool) -> bool {
    !configured_as_self_hosted && !crate::provider_identifiers::is_self_hosted_provider_id(provider)
}

async fn list_project_automations(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
) -> Result<Json<Vec<AutomationPayload>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Read,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        active_job.ensure_project_id(&project_id)?;
    }
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());
    let user_id = access_context
        .user_id
        .ok_or_else(|| unauthorized("authentication required"))?;

    let project = crate::load_project_record(&transaction, &project_id).await?;
    crate::ensure_project_access(&transaction, &project, &access_context, None).await?;

    let rows = transaction
        .query(
            "select id,
	                    project_id,
	                    user_id,
	                    name,
	                    prompt_text,
	                    metadata,
	                    schedule_kind,
	                    run_at,
	                    interval_hours,
	                    by_day,
	                    by_hour,
	                    by_minute,
	                    timezone,
	                    runtime_mode,
	                    runtime_provider,
	                    silent_when_nothing_to_report,
	                    conversation_id,
                    status,
                    locked_until,
                    last_run_at,
                    next_run_at,
                    last_error,
                    created_at,
                    updated_at
             from automations
             where project_id = $1 and user_id = $2
             order by created_at desc",
            &[&project_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to list automations: {error}")))?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit automations list: {error}")))?;

    Ok(Json(
        rows.into_iter()
            .map(|row| record_to_payload(row_to_record(&row)))
            .collect(),
    ))
}

async fn get_automation(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(automation_id_raw): AxumPath<String>,
) -> Result<Json<AutomationPayload>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let automation_id = Uuid::from_str(automation_id_raw.trim())
        .map_err(|_| bad_request("automationId must be a valid UUID"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Read,
    )
    .await?;
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());
    let user_id = access_context
        .user_id
        .ok_or_else(|| unauthorized("authentication required"))?;

    let row = transaction
        .query_opt(
            "select id,
                    project_id,
                    user_id,
                    name,
                    prompt_text,
                    metadata,
                    schedule_kind,
                    run_at,
                    interval_hours,
                    by_day,
                    by_hour,
                    by_minute,
                    timezone,
                    runtime_mode,
                    runtime_provider,
                    silent_when_nothing_to_report,
                    conversation_id,
                    status,
                    locked_until,
                    last_run_at,
                    next_run_at,
                    last_error,
                    created_at,
                    updated_at
             from automations
             where id = $1",
            &[&automation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load automation: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("automation not found"));
    };
    let record = row_to_record(&row);
    if let Some(active_job) = active_job.as_ref() {
        active_job.ensure_project_id(&record.project_id)?;
    }
    if !can_access_owned_automation(
        record.user_id,
        user_id,
        access_context.is_service_role,
        active_job.is_some(),
    ) {
        return Err(crate::forbidden("automation not found"));
    }

    let project = crate::load_project_record(&transaction, &record.project_id).await?;
    crate::ensure_project_access(&transaction, &project, &access_context, None).await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit automation load: {error}")))?;

    Ok(Json(record_to_payload(record)))
}

async fn create_project_automation(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Json(body): Json<CreateAutomationBody>,
) -> Result<Json<AutomationPayload>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let project_id = Uuid::from_str(project_id_raw.trim())
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;

    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err(bad_request("name is required"));
    }

    let schedule_kind = normalize_schedule_kind(&body.schedule_kind)?;
    let timezone = normalize_timezone(body.timezone);
    if parse_tz(&timezone).is_none() {
        return Err(bad_request(
            "timezone must be a valid IANA tz name (e.g. America/New_York)",
        ));
    }
    let metadata = normalize_metadata(body.metadata)?;
    let runtime_mode = normalize_runtime_mode(body.runtime_mode);
    let runtime_provider = body
        .runtime_provider
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let status = normalize_status(body.status);

    let now = Utc::now();

    let (interval_hours, by_day, by_hour, by_minute, run_at) = match schedule_kind.as_str() {
        "weekly" => {
            let by_day = normalize_weekly_days(body.by_day)?;
            if by_day.is_empty() {
                return Err(bad_request("byDay must include at least one weekday"));
            }
            let Some(by_hour) = body.by_hour else {
                return Err(bad_request("byHour is required for weekly schedules"));
            };
            let Some(by_minute) = body.by_minute else {
                return Err(bad_request("byMinute is required for weekly schedules"));
            };
            if !(0..=23).contains(&by_hour) {
                return Err(bad_request("byHour must be between 0 and 23"));
            }
            if !(0..=59).contains(&by_minute) {
                return Err(bad_request("byMinute must be between 0 and 59"));
            }
            (None, by_day, Some(by_hour), Some(by_minute), None)
        }
        "hourly" => {
            let interval_hours = body
                .interval_hours
                .unwrap_or(DEFAULT_HOURLY_INTERVAL)
                .max(1);
            (Some(interval_hours), Vec::new(), None, None, None)
        }
        _ => {
            let Some(run_at_raw) = body.run_at.as_deref() else {
                return Err(bad_request("runAt is required for once schedules"));
            };
            let run_at = parse_run_at(run_at_raw, timezone.as_str())?;
            if run_at <= now {
                return Err(bad_request("runAt must be in the future"));
            }
            (None, Vec::new(), None, None, Some(run_at))
        }
    };

    if runtime_mode != "auto" && runtime_mode != "hosted" && runtime_mode != "existing" {
        return Err(bad_request("runtimeMode must be auto, hosted, or existing"));
    }
    if status != "active" && status != "paused" {
        return Err(bad_request("status must be active or paused"));
    }

    let prompt_text = body.prompt_text.unwrap_or_default();

    let next_run_at = if schedule_kind == "once" {
        run_at.expect("once schedules require runAt")
    } else {
        compute_next_run_at(
            now,
            schedule_kind.as_str(),
            interval_hours,
            &by_day,
            by_hour,
            by_minute,
            timezone.as_str(),
        )
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

    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        active_job.ensure_project_id(&project_id)?;
    }
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());
    let user_id = access_context
        .user_id
        .ok_or_else(|| unauthorized("authentication required"))?;

    let project = crate::load_project_record(&transaction, &project_id).await?;
    crate::ensure_project_write_access(&transaction, &project, &access_context, None).await?;

    let automation_id = Uuid::new_v4();
    let conversation_id = Uuid::new_v4();
    let conversation_metadata =
        build_automation_conversation_metadata(user_id, automation_id, name.as_str());
    let conversation_metadata_param = PgJson(&conversation_metadata);

    transaction
        .execute(
            "insert into conversations (id, project_id, created_by, metadata, visibility, thread_kind)
             values ($1, $2, $3, $4::jsonb, 'private', 'automation')",
            &[&conversation_id, &project_id, &user_id, &conversation_metadata_param],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert automation conversation: {error}")))?;
    transaction
        .execute(
            "insert into conversation_participants (conversation_id, user_id, role, added_by)
             values ($1, $2, 'owner', $3)
             on conflict (conversation_id, user_id) do nothing",
            &[&conversation_id, &user_id, &user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to insert automation participant: {error}"))
        })?;

    let metadata_param = PgJson(&metadata);
    let inserted = transaction
        .query_one(
            "insert into automations (
	                 id,
	                 project_id,
	                 user_id,
	                 name,
	                 prompt_text,
	                 metadata,
	                 schedule_kind,
	                 interval_hours,
	                 by_day,
	                 by_hour,
	                 by_minute,
	                 timezone,
	                 runtime_mode,
	                 runtime_provider,
	                 silent_when_nothing_to_report,
	                 conversation_id,
	                 status,
	                 run_at,
	                 next_run_at
	             ) values (
	                 $1,
	                 $2,
	                 $3,
	                 $4,
	                 $5,
	                 $6::jsonb,
	                 $7,
	                 $8,
	                 $9,
	                 $10,
	                 $11,
	                 $12,
	                 $13,
	                 $14,
	                 $15,
	                 $16,
	                 $17,
	                 $18,
	                 $19
	             )
	             returning id,
	                       project_id,
	                       user_id,
	                       name,
	                       prompt_text,
	                       metadata,
	                       schedule_kind,
	                       run_at,
	                       interval_hours,
	                       by_day,
	                       by_hour,
	                       by_minute,
	                       timezone,
                       runtime_mode,
                       runtime_provider,
                       silent_when_nothing_to_report,
                       conversation_id,
                       status,
                       locked_until,
                       last_run_at,
                       next_run_at,
                       last_error,
                       created_at,
                       updated_at",
            &[
                &automation_id,
                &project_id,
                &user_id,
                &name,
                &prompt_text,
                &metadata_param,
                &schedule_kind,
                &interval_hours,
                &by_day,
                &by_hour,
                &by_minute,
                &timezone,
                &runtime_mode,
                &runtime_provider,
                &body.silent_when_nothing_to_report,
                &conversation_id,
                &status,
                &run_at,
                &next_run_at,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert automation: {error}")))?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit automation create: {error}")))?;

    Ok(Json(record_to_payload(row_to_record(&inserted))))
}

async fn update_automation(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(automation_id_raw): AxumPath<String>,
    Json(body): Json<UpdateAutomationBody>,
) -> Result<Json<AutomationPayload>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let automation_id = Uuid::from_str(automation_id_raw.trim())
        .map_err(|_| bad_request("automationId must be a valid UUID"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    if active_job.is_some() && !body.is_status_only() {
        return Err(crate::forbidden(
            "job token may only pause or resume an automation",
        ));
    }
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());
    let user_id = access_context
        .user_id
        .ok_or_else(|| unauthorized("authentication required"))?;

    let existing = transaction
        .query_opt(
            "select id,
	                    project_id,
	                    user_id,
	                    name,
	                    prompt_text,
	                    metadata,
	                    schedule_kind,
	                    run_at,
	                    interval_hours,
	                    by_day,
	                    by_hour,
	                    by_minute,
	                    timezone,
	                    runtime_mode,
	                    runtime_provider,
	                    silent_when_nothing_to_report,
	                    conversation_id,
                    status,
                    locked_until,
                    last_run_at,
                    next_run_at,
                    last_error,
                    created_at,
                    updated_at
             from automations
             where id = $1
             for update",
            &[&automation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load automation: {error}")))?;

    let Some(existing) = existing else {
        return Err(not_found("automation not found"));
    };
    let existing_record = row_to_record(&existing);
    if let Some(active_job) = active_job.as_ref() {
        active_job.ensure_project_id(&existing_record.project_id)?;
    }
    if !can_access_owned_automation(
        existing_record.user_id,
        user_id,
        access_context.is_service_role,
        active_job.is_some(),
    ) {
        return Err(crate::forbidden("automation not found"));
    }

    let project = crate::load_project_record(&transaction, &existing_record.project_id).await?;
    crate::ensure_project_write_access(&transaction, &project, &access_context, None).await?;

    let name = body
        .name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or(existing_record.name.clone());

    let prompt_text = match body.prompt_text {
        Some(value) => value,
        None => existing_record.prompt_text.clone(),
    };

    let metadata = match body.metadata {
        Some(value) => normalize_metadata(Some(value))?,
        None => existing_record.metadata.clone(),
    };

    let schedule_kind = match body.schedule_kind.as_deref() {
        Some(raw) => normalize_schedule_kind(raw)?,
        None => existing_record.schedule_kind.clone(),
    };

    let timezone = match body.timezone {
        Some(value) => {
            let normalized = normalize_timezone(Some(value));
            if parse_tz(&normalized).is_none() {
                return Err(bad_request(
                    "timezone must be a valid IANA tz name (e.g. America/New_York)",
                ));
            }
            normalized
        }
        None => existing_record.timezone.clone(),
    };

    let run_at_is_set = body.run_at.is_some();

    let (interval_hours, by_day, by_hour, by_minute, run_at) = match schedule_kind.as_str() {
        "weekly" => {
            let by_day = if body.by_day.is_some() {
                normalize_weekly_days(body.by_day)?
            } else {
                existing_record.by_day.clone()
            };
            if by_day.is_empty() {
                return Err(bad_request("byDay must include at least one weekday"));
            }

            let by_hour = body.by_hour.or(existing_record.by_hour);
            let by_minute = body.by_minute.or(existing_record.by_minute);
            let Some(by_hour) = by_hour else {
                return Err(bad_request("byHour is required for weekly schedules"));
            };
            let Some(by_minute) = by_minute else {
                return Err(bad_request("byMinute is required for weekly schedules"));
            };
            if !(0..=23).contains(&by_hour) {
                return Err(bad_request("byHour must be between 0 and 23"));
            }
            if !(0..=59).contains(&by_minute) {
                return Err(bad_request("byMinute must be between 0 and 59"));
            }

            (None, by_day, Some(by_hour), Some(by_minute), None)
        }
        "hourly" => {
            let interval_hours = body
                .interval_hours
                .or(existing_record.interval_hours)
                .unwrap_or(DEFAULT_HOURLY_INTERVAL)
                .max(1);
            (Some(interval_hours), Vec::new(), None, None, None)
        }
        _ => {
            let run_at = if let Some(raw) = body.run_at.as_deref() {
                Some(parse_run_at(raw, timezone.as_str())?)
            } else {
                existing_record.run_at
            };
            let Some(run_at) = run_at else {
                return Err(bad_request("runAt is required for once schedules"));
            };
            (None, Vec::new(), None, None, Some(run_at))
        }
    };

    let runtime_mode = if body.runtime_mode.is_some() {
        normalize_runtime_mode(body.runtime_mode)
    } else {
        existing_record.runtime_mode.clone()
    };
    if runtime_mode != "auto" && runtime_mode != "hosted" && runtime_mode != "existing" {
        return Err(bad_request("runtimeMode must be auto, hosted, or existing"));
    }

    let runtime_provider = body
        .runtime_provider
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or(existing_record.runtime_provider.clone());

    let silent_when_nothing_to_report = body
        .silent_when_nothing_to_report
        .unwrap_or(existing_record.silent_when_nothing_to_report);

    let status = if body.status.is_some() {
        normalize_status(body.status).trim().to_string()
    } else {
        existing_record.status.clone()
    };
    if status != "active" && status != "paused" {
        return Err(bad_request("status must be active or paused"));
    }

    let now = Utc::now();
    let next_run_at = if status == "active" {
        match schedule_kind.as_str() {
            "once" => {
                let run_at = run_at.expect("once schedules require runAt");
                Some(if run_at > now { run_at } else { now })
            }
            _ => Some(compute_next_run_at(
                now,
                schedule_kind.as_str(),
                interval_hours,
                &by_day,
                by_hour,
                by_minute,
                timezone.as_str(),
            )),
        }
    } else if schedule_kind == "once" && run_at_is_set {
        run_at
    } else {
        existing_record.next_run_at
    };

    if let Some(conversation_id) = existing_record.conversation_id {
        let meta =
            build_automation_conversation_metadata(user_id, existing_record.id, name.as_str());
        let meta_param = PgJson(&meta);
        transaction
            .execute(
                "update conversations set metadata = $2::jsonb, updated_at = now() where id = $1",
                &[&conversation_id, &meta_param],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to update automation conversation metadata: {error}"
                ))
            })?;
    }

    let metadata_param = PgJson(&metadata);
    let updated = transaction
        .query_one(
            "update automations
	             set name = $2,
	                 prompt_text = $3,
	                 metadata = $4::jsonb,
	                 schedule_kind = $5,
	                 interval_hours = $6,
	                 by_day = $7,
	                 by_hour = $8,
	                 by_minute = $9,
	                 timezone = $10,
	                 runtime_mode = $11,
	                 runtime_provider = $12,
	                 status = $13,
	                 run_at = $14,
	                 next_run_at = $15,
	                 silent_when_nothing_to_report = $16,
	                 updated_at = now()
	             where id = $1
	             returning id,
	                       project_id,
	                       user_id,
	                       name,
	                       prompt_text,
	                       metadata,
	                       schedule_kind,
	                       run_at,
	                       interval_hours,
	                       by_day,
	                       by_hour,
	                       by_minute,
	                       timezone,
                       runtime_mode,
                       runtime_provider,
                       silent_when_nothing_to_report,
                       conversation_id,
                       status,
                       locked_until,
                       last_run_at,
                       next_run_at,
                       last_error,
                       created_at,
                       updated_at",
            &[
                &automation_id,
                &name,
                &prompt_text,
                &metadata_param,
                &schedule_kind,
                &interval_hours,
                &by_day,
                &by_hour,
                &by_minute,
                &timezone,
                &runtime_mode,
                &runtime_provider,
                &status,
                &run_at,
                &next_run_at,
                &silent_when_nothing_to_report,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update automation: {error}")))?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit automation update: {error}")))?;

    Ok(Json(record_to_payload(row_to_record(&updated))))
}

async fn delete_automation(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(automation_id_raw): AxumPath<String>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let automation_id = Uuid::from_str(automation_id_raw.trim())
        .map_err(|_| bad_request("automationId must be a valid UUID"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());
    let user_id = access_context
        .user_id
        .ok_or_else(|| unauthorized("authentication required"))?;

    let row = transaction
        .query_opt(
            "select project_id, user_id, conversation_id from automations where id = $1 for update",
            &[&automation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load automation: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("automation not found"));
    };

    let project_id: Uuid = row.get("project_id");
    let owner_id: Uuid = row.get("user_id");
    if let Some(active_job) = active_job.as_ref() {
        active_job.ensure_project_id(&project_id)?;
    }
    if !can_access_owned_automation(
        owner_id,
        user_id,
        access_context.is_service_role,
        active_job.is_some(),
    ) {
        return Err(crate::forbidden("automation not found"));
    }

    let project = crate::load_project_record(&transaction, &project_id).await?;
    crate::ensure_project_write_access(&transaction, &project, &access_context, None).await?;

    transaction
        .execute("delete from automations where id = $1", &[&automation_id])
        .await
        .map_err(|error| internal_error(format!("failed to delete automation: {error}")))?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit automation delete: {error}")))?;

    Ok(Json(json!({ "ok": true })))
}

async fn run_automation_now(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(automation_id_raw): AxumPath<String>,
) -> Result<Json<JsonValue>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let automation_id = Uuid::from_str(automation_id_raw.trim())
        .map_err(|_| bad_request("automationId must be a valid UUID"))?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    let access_context = active_job
        .as_ref()
        .map(ActiveJobAuthorization::subject_context)
        .unwrap_or_else(|| context.clone());
    let user_id = access_context
        .user_id
        .ok_or_else(|| unauthorized("authentication required"))?;

    let row = transaction
        .query_opt(
            "select id,
	                    project_id,
	                    user_id,
	                    name,
	                    prompt_text,
	                    metadata,
	                    schedule_kind,
	                    run_at,
	                    interval_hours,
	                    by_day,
	                    by_hour,
	                    by_minute,
	                    timezone,
	                    runtime_mode,
	                    runtime_provider,
	                    silent_when_nothing_to_report,
	                    conversation_id,
                    status,
                    locked_until,
                    last_run_at,
                    next_run_at,
                    last_error,
                    created_at,
                    updated_at
             from automations
             where id = $1
             for update",
            &[&automation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load automation: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("automation not found"));
    };
    let record = row_to_record(&row);
    if let Some(active_job) = active_job.as_ref() {
        active_job.ensure_project_id(&record.project_id)?;
    }
    if !can_access_owned_automation(
        record.user_id,
        user_id,
        access_context.is_service_role,
        active_job.is_some(),
    ) {
        return Err(crate::forbidden("automation not found"));
    }

    let project = crate::load_project_record(&transaction, &record.project_id).await?;
    crate::ensure_project_write_access(&transaction, &project, &access_context, None).await?;

    let now = Utc::now();
    let locked_until = now + ChronoDuration::seconds(AUTOMATION_SCHEDULER_LOCK_SECONDS);
    transaction
        .execute(
            "update automations
             set next_run_at = $2,
                 locked_until = $3,
                 status = 'active',
                 updated_at = now()
             where id = $1",
            &[&automation_id, &now, &locked_until],
        )
        .await
        .map_err(|error| internal_error(format!("failed to schedule automation: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit automation run schedule: {error}"))
    })?;

    // Opportunistic: execute immediately in the background so UI feels responsive.
    let state_clone = state.clone();
    tokio::spawn(async move {
        if let Err(error) = execute_automation_once(&state_clone, &record).await {
            warn!(automation_id = %automation_id, ?error, "automation manual run failed");
        }
    });

    Ok(Json(json!({ "ok": true })))
}

#[cfg(test)]
mod tests {
    use super::{
        automation_runtime_is_selectable, can_access_owned_automation,
        hosted_automation_provider_is_managed, UpdateAutomationBody,
    };
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn active_jobs_cannot_use_service_role_to_cross_automation_owners() {
        let owner = Uuid::new_v4();
        let actor = Uuid::new_v4();

        assert!(!can_access_owned_automation(owner, actor, true, true));
        assert!(can_access_owned_automation(owner, actor, true, false));
        assert!(can_access_owned_automation(owner, owner, false, true));
    }

    #[test]
    fn job_automation_update_accepts_status_only() {
        assert!(UpdateAutomationBody {
            status: Some("paused".to_string()),
            ..UpdateAutomationBody::default()
        }
        .is_status_only());
    }

    #[test]
    fn job_automation_update_rejects_schedule_or_prompt_changes() {
        assert!(!UpdateAutomationBody {
            status: Some("active".to_string()),
            prompt_text: Some("do something else".to_string()),
            ..UpdateAutomationBody::default()
        }
        .is_status_only());
        assert!(!UpdateAutomationBody {
            timezone: Some("Europe/Stockholm".to_string()),
            ..UpdateAutomationBody::default()
        }
        .is_status_only());
        assert!(!UpdateAutomationBody {
            status: Some("active".to_string()),
            silent_when_nothing_to_report: Some(true),
            ..UpdateAutomationBody::default()
        }
        .is_status_only());
    }

    #[test]
    fn automation_silence_defaults_off_and_accepts_explicit_opt_in() {
        let defaulted: super::CreateAutomationBody = serde_json::from_value(json!({
            "name": "Daily check",
            "scheduleKind": "hourly"
        }))
        .expect("deserialize default automation silence");
        assert!(!defaulted.silent_when_nothing_to_report);

        let opted_in: super::CreateAutomationBody = serde_json::from_value(json!({
            "name": "Daily check",
            "scheduleKind": "hourly",
            "silentWhenNothingToReport": true
        }))
        .expect("deserialize automation silence opt-in");
        assert!(opted_in.silent_when_nothing_to_report);
    }

    #[test]
    fn automation_runtime_selection_requires_attested_self_hosted_owner() {
        let owner = Uuid::new_v4();
        let teammate = Uuid::new_v4();
        let capabilities = json!({
            "_instafySelfHostedAccess": {
                "mode": "private",
                "ownerUserId": owner.to_string(),
            }
        });

        assert!(automation_runtime_is_selectable(
            "self-hosted",
            &capabilities,
            owner,
            true,
        ));
        assert!(!automation_runtime_is_selectable(
            "self-hosted",
            &capabilities,
            teammate,
            true,
        ));
    }

    #[test]
    fn custom_self_hosted_automation_runtime_fails_closed_without_attestation() {
        let owner = Uuid::new_v4();

        assert!(!automation_runtime_is_selectable(
            "developer-workstation",
            &json!({}),
            owner,
            true,
        ));
        assert!(automation_runtime_is_selectable(
            "instafy-cloud",
            &json!({}),
            owner,
            false,
        ));
    }

    #[test]
    fn hosted_automation_mode_rejects_builtin_and_custom_self_hosted_providers() {
        assert!(!hosted_automation_provider_is_managed("self-hosted", true,));
        assert!(!hosted_automation_provider_is_managed(
            "developer-workstation",
            true,
        ));
        assert!(hosted_automation_provider_is_managed(
            "instafy-cloud",
            false,
        ));
    }
}
