use std::str::FromStr;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::credits::{
    get_credit_snapshot, load_credit_ledger_entries, load_org_subscription_summary,
    process_credit_burn, process_credit_refill, CreditLedgerEntry, CreditSnapshotData,
    OrgSubscriptionSummary,
};
use crate::ota::require_operator_access;
use crate::projects::ensure_project_org;
use crate::runtime::{self, RuntimeStatusResponse, RuntimeStopResponse};
use crate::{bad_request, internal_error, load_project_record, ApiError, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/operator/projects/search", get(search_projects))
        .route(
            "/operator/projects/:project_id/support",
            get(project_support_snapshot),
        )
        .route(
            "/operator/projects/:project_id/credits/adjust",
            post(adjust_project_credits),
        )
        .route(
            "/operator/projects/:project_id/runtimes/:runtime_id/stop",
            post(stop_project_runtime),
        )
        .route("/operator/metrics/summary", get(operator_metrics_summary))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperatorProjectSupportSnapshot {
    project: OperatorProjectSummary,
    credits: OperatorProjectCreditsSnapshot,
    runtime: RuntimeStatusResponse,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperatorProjectSummary {
    project_id: String,
    project_name: Option<String>,
    project_type: Option<String>,
    owner_user_id: Option<String>,
    owner_email: Option<String>,
    org_id: String,
    org_name: Option<String>,
    org_slug: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperatorProjectSearchResponse {
    projects: Vec<OperatorProjectSearchResult>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperatorProjectSearchResult {
    project_id: String,
    project_name: Option<String>,
    project_type: Option<String>,
    project_status: Option<String>,
    owner_user_id: Option<String>,
    owner_email: Option<String>,
    org_id: String,
    org_name: Option<String>,
    org_slug: Option<String>,
    last_activity_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OperatorProjectCreditsSnapshot {
    balance: i32,
    credit_limit: i32,
    last_burn_at: Option<String>,
    last_refill_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    subscription: Option<OrgSubscriptionSummary>,
    entries: Vec<CreditLedgerEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperatorCreditAdjustPayload {
    action: String,
    amount: i32,
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperatorRuntimeStopPayload {
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OperatorProjectSearchQuery {
    q: String,
    #[serde(default)]
    limit: Option<i64>,
}

async fn search_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<OperatorProjectSearchQuery>,
) -> Result<Json<OperatorProjectSearchResponse>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;

    let query = params.q.trim();
    if query.is_empty() {
        return Err(bad_request("q is required"));
    }

    let limit = params.limit.unwrap_or(10).clamp(1, 25);
    let exact_project_id = Uuid::parse_str(query).ok();
    let fuzzy_query = format!("%{query}%");
    let normalized_query = query.to_ascii_lowercase();

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let rows = transaction
        .query(
            "with conversation_activity as (
                 select c.project_id, max(c.updated_at) as last_activity_at
                 from conversations c
                 group by c.project_id
             ),
             runtime_activity as (
                 select
                     r.project_id,
                     greatest(
                         coalesce(max(r.last_seen_at), 'epoch'::timestamptz),
                         coalesce(max(r.updated_at), 'epoch'::timestamptz)
                     ) as last_activity_at
                 from runtimes r
                 group by r.project_id
             ),
             project_member_matches as (
                 select
                     pm.project_id,
                     bool_or(
                         lower(coalesce(member_user.email, '')) = $3
                         or pm.user_id::text = $4
                     ) as exact_match,
                     bool_or(
                         coalesce(member_user.email, '') ilike $2
                         or pm.user_id::text ilike $2
                     ) as fuzzy_match
                 from project_memberships pm
                 join auth.users member_user on member_user.id = pm.user_id
                 group by pm.project_id
             ),
             org_member_matches as (
                 select
                     om.org_id,
                     bool_or(
                         lower(coalesce(member_user.email, '')) = $3
                         or om.user_id::text = $4
                     ) as exact_match,
                     bool_or(
                         coalesce(member_user.email, '') ilike $2
                         or om.user_id::text ilike $2
                     ) as fuzzy_match
                 from org_memberships om
                 join auth.users member_user on member_user.id = om.user_id
                 group by om.org_id
             )
             select p.id,
                    p.name,
                    p.project_type,
                    p.status,
                    p.owner_user_id,
                    u.email as owner_email,
                    coalesce(pm_search.exact_match, false) as exact_project_member_match,
                    coalesce(om_search.exact_match, false) as exact_org_member_match,
                    greatest(
                        coalesce(conversation_activity.last_activity_at, p.updated_at, p.created_at, 'epoch'::timestamptz),
                        coalesce(runtime_activity.last_activity_at, p.updated_at, p.created_at, 'epoch'::timestamptz),
                        coalesce(p.updated_at, p.created_at, 'epoch'::timestamptz),
                        coalesce(p.created_at, 'epoch'::timestamptz)
                    ) as last_activity_at,
                    o.id as org_id,
                    o.slug as org_slug,
                    o.name as org_name
             from projects p
             join organizations o on o.id = p.org_id
             left join auth.users u on u.id = p.owner_user_id
             left join conversation_activity on conversation_activity.project_id = p.id
             left join runtime_activity on runtime_activity.project_id = p.id
             left join project_member_matches pm_search on pm_search.project_id = p.id
             left join org_member_matches om_search on om_search.org_id = p.org_id
             where p.status <> 'deleted'
               and (
                    ($1::uuid is not null and p.id = $1)
                    or p.id::text ilike $2
                    or coalesce(p.name, '') ilike $2
                    or coalesce(o.slug, '') ilike $2
                    or coalesce(o.name, '') ilike $2
                    or coalesce(u.email, '') ilike $2
                    or coalesce(p.owner_user_id::text, '') ilike $2
                    or coalesce(pm_search.fuzzy_match, false)
                    or coalesce(om_search.fuzzy_match, false)
               )
             order by
                case when $1::uuid is not null and p.id = $1 then 0 else 1 end,
                case
                    when lower(coalesce(u.email, '')) = $3 then 0
                    when coalesce(pm_search.exact_match, false) then 1
                    when lower(coalesce(o.slug, '')) = $3 then 2
                    when lower(coalesce(o.name, '')) = $3 then 3
                    when lower(coalesce(p.name, '')) = $3 then 4
                    when p.id::text = $4 then 5
                    when coalesce(om_search.exact_match, false) then 6
                    else 7
                end,
                greatest(
                    coalesce(conversation_activity.last_activity_at, p.updated_at, p.created_at, 'epoch'::timestamptz),
                    coalesce(runtime_activity.last_activity_at, p.updated_at, p.created_at, 'epoch'::timestamptz),
                    coalesce(p.updated_at, p.created_at, 'epoch'::timestamptz),
                    coalesce(p.created_at, 'epoch'::timestamptz)
                ) desc,
                p.updated_at desc,
                p.created_at desc,
                p.id desc
             limit $5",
            &[
                &exact_project_id,
                &fuzzy_query,
                &normalized_query,
                &query,
                &limit,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to search projects: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize operator project search transaction: {error}"
        ))
    })?;

    let projects = rows
        .into_iter()
        .map(|row| OperatorProjectSearchResult {
            project_id: row.get::<_, Uuid>("id").to_string(),
            project_name: row.get("name"),
            project_type: row.get("project_type"),
            project_status: row.get("status"),
            owner_user_id: row
                .get::<_, Option<Uuid>>("owner_user_id")
                .map(|value| value.to_string()),
            owner_email: row.get("owner_email"),
            org_id: row.get::<_, Uuid>("org_id").to_string(),
            org_name: row.get("org_name"),
            org_slug: row.get("org_slug"),
            last_activity_at: row
                .get::<_, Option<chrono::DateTime<chrono::Utc>>>("last_activity_at")
                .map(|value| value.to_rfc3339()),
        })
        .collect();

    Ok(Json(OperatorProjectSearchResponse { projects }))
}

async fn project_support_snapshot(
    State(state): State<AppState>,
    Path(project_id_raw): Path<String>,
    headers: HeaderMap,
) -> Result<Json<OperatorProjectSupportSnapshot>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let project_id = parse_uuid(&project_id_raw, "project_id")?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project_record = load_project_record(&transaction, &project_id).await?;
    let project = ensure_project_org(&transaction, &project_record).await?;
    let org_id = project
        .org_id
        .ok_or_else(|| internal_error("project missing organization"))?;

    let org_row = transaction
        .query_opt(
            "select slug, name from organizations where id = $1",
            &[&org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load organization summary: {error}")))?;
    let owner_email = load_owner_email(&transaction, project.owner_user_id).await?;

    let credit_snapshot = get_credit_snapshot(&transaction, &org_id).await?;
    let subscription = load_org_subscription_summary(&transaction, &org_id).await?;
    let ledger_entries = load_credit_ledger_entries(&transaction, &org_id, 25).await?;
    let runtime = runtime::load_runtime_status_response(&state, &transaction, &project.id).await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize operator support snapshot: {error}"
        ))
    })?;

    let (org_slug, org_name) = match org_row {
        Some(row) => (
            row.get::<_, Option<String>>("slug"),
            row.get::<_, Option<String>>("name"),
        ),
        None => (None, None),
    };

    Ok(Json(OperatorProjectSupportSnapshot {
        project: OperatorProjectSummary {
            project_id: project.id.to_string(),
            project_name: project.name.clone(),
            project_type: project.project_type.clone(),
            owner_user_id: project.owner_user_id.map(|value| value.to_string()),
            owner_email,
            org_id: org_id.to_string(),
            org_name,
            org_slug,
        },
        credits: build_credit_snapshot(credit_snapshot, subscription, ledger_entries),
        runtime,
    }))
}

async fn adjust_project_credits(
    State(state): State<AppState>,
    Path(project_id_raw): Path<String>,
    headers: HeaderMap,
    Json(payload): Json<OperatorCreditAdjustPayload>,
) -> Result<Json<OperatorProjectCreditsSnapshot>, (StatusCode, Json<ApiError>)> {
    let context = require_operator_access(&state, &headers).await?;
    let project_id = parse_uuid(&project_id_raw, "project_id")?;

    let normalized_action = payload.action.trim().to_ascii_lowercase();
    if normalized_action != "add" && normalized_action != "set" {
        return Err(bad_request("action must be add or set"));
    }
    if payload.amount < 0 {
        return Err(bad_request("amount must be zero or positive"));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project_record = load_project_record(&transaction, &project_id).await?;
    let project = ensure_project_org(&transaction, &project_record).await?;
    let org_id = project
        .org_id
        .ok_or_else(|| internal_error("project missing organization"))?;
    let starting_snapshot = get_credit_snapshot(&transaction, &org_id).await?;

    let note = payload
        .note
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let operator_user_id = context.user_id.map(|value| value.to_string());

    let ending_snapshot = match normalized_action.as_str() {
        "add" => {
            if payload.amount <= 0 {
                return Err(bad_request("amount must be greater than zero for add"));
            }
            let mut metadata = json!({
                "source": "operator_admin",
                "action": "add",
                "requestedAmount": payload.amount,
                "operatorUserId": operator_user_id,
                "category": "operator_credit_adjustment",
            });
            if let Some(note) = note {
                metadata["note"] = JsonValue::String(note.to_string());
            }
            process_credit_refill(
                &transaction,
                &project.id,
                &org_id,
                None,
                payload.amount,
                None,
                "operator_credit_adjustment",
                None,
                &mut metadata,
            )
            .await?
        }
        "set" => {
            if payload.amount == starting_snapshot.balance {
                starting_snapshot
            } else if payload.amount > starting_snapshot.balance {
                let delta = payload.amount - starting_snapshot.balance;
                let mut metadata = json!({
                    "source": "operator_admin",
                    "action": "set",
                    "targetBalance": payload.amount,
                    "appliedDelta": delta,
                    "operatorUserId": operator_user_id,
                    "category": "operator_credit_adjustment",
                });
                if let Some(note) = note {
                    metadata["note"] = JsonValue::String(note.to_string());
                }
                process_credit_refill(
                    &transaction,
                    &project.id,
                    &org_id,
                    None,
                    delta,
                    None,
                    "operator_credit_adjustment",
                    None,
                    &mut metadata,
                )
                .await?
            } else {
                let delta = starting_snapshot.balance - payload.amount;
                let mut metadata = json!({
                    "source": "operator_admin",
                    "action": "set",
                    "targetBalance": payload.amount,
                    "appliedDelta": delta,
                    "operatorUserId": operator_user_id,
                    "category": "operator_credit_adjustment",
                });
                if let Some(note) = note {
                    metadata["note"] = JsonValue::String(note.to_string());
                }
                process_credit_burn(
                    &transaction,
                    &project.id,
                    &org_id,
                    None,
                    delta,
                    "operator_credit_adjustment",
                    None,
                    &mut metadata,
                )
                .await?
            }
        }
        _ => unreachable!(),
    };

    let subscription = load_org_subscription_summary(&transaction, &org_id).await?;
    let ledger_entries = load_credit_ledger_entries(&transaction, &org_id, 25).await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to commit operator credit adjustment: {error}"
        ))
    })?;
    crate::credits::publish_credits_updated(
        &*connection,
        &state.events,
        &org_id,
        crate::credits::CREDITS_UPDATED_LEDGER,
    )
    .await;

    Ok(Json(build_credit_snapshot(
        ending_snapshot,
        subscription,
        ledger_entries,
    )))
}

async fn stop_project_runtime(
    State(state): State<AppState>,
    Path((project_id_raw, runtime_id_raw)): Path<(String, String)>,
    headers: HeaderMap,
    Json(payload): Json<OperatorRuntimeStopPayload>,
) -> Result<Json<RuntimeStopResponse>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;
    let project_id = parse_uuid(&project_id_raw, "project_id")?;
    let runtime_id = parse_uuid(&runtime_id_raw, "runtime_id")?;
    let response = runtime::stop_runtime_for_project(
        &state,
        &project_id,
        &runtime_id,
        payload.reason,
        "operator_admin",
    )
    .await?;
    Ok(Json(response))
}

fn build_credit_snapshot(
    snapshot: CreditSnapshotData,
    subscription: Option<OrgSubscriptionSummary>,
    ledger_entries: Vec<crate::credits::CreditLedgerEntryData>,
) -> OperatorProjectCreditsSnapshot {
    OperatorProjectCreditsSnapshot {
        balance: snapshot.balance,
        credit_limit: snapshot.credit_limit,
        last_burn_at: snapshot.last_burn_at.map(|value| value.to_rfc3339()),
        last_refill_at: snapshot.last_refill_at.map(|value| value.to_rfc3339()),
        subscription,
        entries: ledger_entries
            .into_iter()
            .map(|entry| CreditLedgerEntry {
                delta: entry.delta,
                reason: entry.reason,
                metadata: entry.metadata,
                created_at: entry.created_at.to_rfc3339(),
            })
            .collect(),
    }
}

fn parse_uuid(raw: &str, field_name: &str) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    Uuid::from_str(raw.trim())
        .map_err(|_| bad_request(format!("{field_name} must be a valid UUID")))
}

async fn load_owner_email(
    transaction: &tokio_postgres::Transaction<'_>,
    owner_user_id: Option<Uuid>,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let Some(owner_user_id) = owner_user_id else {
        return Ok(None);
    };

    let row = transaction
        .query_opt(
            "select email from auth.users where id = $1 limit 1",
            &[&owner_user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load owner email: {error}")))?;

    Ok(row.and_then(|value| value.get::<_, Option<String>>("email")))
}

// ---------------------------------------------------------------------------
// Operator metrics summary
//
// One request that answers "how is the product doing" for the internal
// operator console. Everything here is an aggregate over data the product
// already writes; nothing new is instrumented. The one non-aggregate is the
// recent sign-up feed, a short newest-first slice of auth.users.
//
// Human activity is measured from conversation_messages and prompts rather
// than conversations, because both carry the acting user and neither is
// written by the agent on a user's behalf: assistant messages are inserted
// with a null created_by, so `created_by is not null` isolates real people.
// conversations.updated_at, by contrast, is bumped by agent traffic and would
// silently count robots as users.
// ---------------------------------------------------------------------------

/// Distinct people who did something, by window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperatorPeopleMetrics {
    #[serde(rename = "active24h")]
    active_24h: i64,
    #[serde(rename = "active7d")]
    active_7d: i64,
    #[serde(rename = "active30d")]
    active_30d: i64,
    /// Active in the last 7 days who were also active in the 7 days before.
    #[serde(rename = "returning7d")]
    returning_7d: i64,
    #[serde(rename = "newUsers7d")]
    new_users_7d: i64,
    total_users: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperatorBugMetrics {
    open: i64,
    in_progress: i64,
    resolved: i64,
    #[serde(rename = "new24h")]
    new_24h: i64,
    #[serde(rename = "new7d")]
    new_7d: i64,
    /// Unresolved reports filed by the system rather than a person.
    system_open: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperatorProjectMetrics {
    #[serde(rename = "active7d")]
    active_7d: i64,
    total: i64,
}

/// One entry in the newest-first sign-up feed. Every field but `created_at`
/// is nullable on the wire so the console can show "unknown" rather than
/// guess; absent values are sent as null, never skipped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperatorRecentSignup {
    email: Option<String>,
    full_name: Option<String>,
    created_at: String,
    /// GoTrue's `raw_app_meta_data.provider`, e.g. `email` or `google`.
    provider: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperatorMetricsSummary {
    generated_at: String,
    people: OperatorPeopleMetrics,
    bugs: OperatorBugMetrics,
    projects: OperatorProjectMetrics,
    recent_signups: Vec<OperatorRecentSignup>,
}

/// Raw counts as they come back from Postgres, kept separate from the response
/// so the row-to-field mapping can be tested without a database.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct OperatorMetricsCounts {
    pub(crate) active_24h: i64,
    pub(crate) active_7d: i64,
    pub(crate) active_30d: i64,
    pub(crate) returning_7d: i64,
    pub(crate) new_users_7d: i64,
    pub(crate) total_users: i64,
    pub(crate) projects_active_7d: i64,
    pub(crate) projects_total: i64,
    pub(crate) bugs_open: i64,
    pub(crate) bugs_in_progress: i64,
    pub(crate) bugs_resolved: i64,
    pub(crate) bugs_new_24h: i64,
    pub(crate) bugs_new_7d: i64,
    pub(crate) bugs_system_open: i64,
}

/// One auth.users row as it comes back from Postgres, before the timestamp
/// is formatted for the wire.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OperatorRecentSignupRow {
    pub(crate) email: Option<String>,
    pub(crate) full_name: Option<String>,
    pub(crate) created_at: chrono::DateTime<chrono::Utc>,
    pub(crate) provider: Option<String>,
}

pub(crate) fn build_operator_metrics_summary(
    generated_at: chrono::DateTime<chrono::Utc>,
    counts: OperatorMetricsCounts,
    recent_signups: Vec<OperatorRecentSignupRow>,
) -> OperatorMetricsSummary {
    OperatorMetricsSummary {
        generated_at: generated_at.to_rfc3339(),
        people: OperatorPeopleMetrics {
            active_24h: counts.active_24h,
            active_7d: counts.active_7d,
            active_30d: counts.active_30d,
            returning_7d: counts.returning_7d,
            new_users_7d: counts.new_users_7d,
            total_users: counts.total_users,
        },
        bugs: OperatorBugMetrics {
            open: counts.bugs_open,
            in_progress: counts.bugs_in_progress,
            resolved: counts.bugs_resolved,
            new_24h: counts.bugs_new_24h,
            new_7d: counts.bugs_new_7d,
            system_open: counts.bugs_system_open,
        },
        projects: OperatorProjectMetrics {
            active_7d: counts.projects_active_7d,
            total: counts.projects_total,
        },
        recent_signups: recent_signups
            .into_iter()
            .map(|row| OperatorRecentSignup {
                email: row.email,
                full_name: row.full_name,
                created_at: row.created_at.to_rfc3339(),
                provider: row.provider,
            })
            .collect(),
    }
}

const OPERATOR_ACTIVITY_SQL: &str = "
    with human_activity as (
        select created_by as actor_id, project_id, created_at
          from conversation_messages
         where created_by is not null
        union all
        select user_id as actor_id, project_id, created_at
          from prompts
         where user_id is not null and project_id is not null
    ),
    recent_actors as (
        select distinct actor_id from human_activity where created_at >= $2
    ),
    prior_actors as (
        select distinct actor_id
          from human_activity
         where created_at >= $4 and created_at < $2
    )
    select
        count(distinct actor_id) filter (where created_at >= $1) as active_24h,
        count(distinct actor_id) filter (where created_at >= $2) as active_7d,
        count(distinct actor_id) filter (where created_at >= $3) as active_30d,
        count(distinct project_id) filter (where created_at >= $2) as projects_active_7d,
        (
            select count(*)
              from recent_actors r
              join prior_actors p on p.actor_id = r.actor_id
        ) as returning_7d,
        (select count(*) from auth.users where created_at >= $2) as new_users_7d,
        (select count(*) from auth.users) as total_users,
        (select count(*) from projects where status <> 'deleted') as projects_total
      from human_activity
";

const OPERATOR_BUGS_SQL: &str = "
    select
        count(*) filter (where status = 'open') as open,
        count(*) filter (where status = 'in_progress') as in_progress,
        count(*) filter (where status = 'resolved') as resolved,
        count(*) filter (where created_at >= $1) as new_24h,
        count(*) filter (where created_at >= $2) as new_7d,
        count(*) filter (
            where coalesce(reporter_email, '') = 'system@instafy.dev'
              and status <> 'resolved'
        ) as system_open
      from bug_reports
";

/// How many sign-ups the summary carries. Small on purpose: this is a glance
/// at who is arriving, not a user directory.
const OPERATOR_RECENT_SIGNUPS_LIMIT: i64 = 8;

// The display name mirrors the coalesce in activity.rs so a person is named
// the same way here as in their activity feed. GoTrue leaves created_at
// nullable; a row without one has no place in a newest-first list.
const OPERATOR_RECENT_SIGNUPS_SQL: &str = "
    select
        u.email,
        coalesce(
            nullif(btrim(p.full_name), ''),
            nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
            nullif(btrim(u.raw_user_meta_data ->> 'name'), '')
        ) as full_name,
        u.created_at,
        u.raw_app_meta_data ->> 'provider' as provider
      from auth.users u
      left join profiles p on p.user_id = u.id
     where u.created_at is not null and u.deleted_at is null
     order by u.created_at desc, u.id desc
     limit $1
";

async fn operator_metrics_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<OperatorMetricsSummary>, (StatusCode, Json<ApiError>)> {
    require_operator_access(&state, &headers).await?;

    let generated_at = chrono::Utc::now();
    let since_24h = generated_at - chrono::Duration::hours(24);
    let since_7d = generated_at - chrono::Duration::days(7);
    let since_30d = generated_at - chrono::Duration::days(30);
    let since_14d = generated_at - chrono::Duration::days(14);

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let activity = transaction
        .query_one(
            OPERATOR_ACTIVITY_SQL,
            &[&since_24h, &since_7d, &since_30d, &since_14d],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load activity metrics: {error}")))?;

    let bugs = transaction
        .query_one(OPERATOR_BUGS_SQL, &[&since_24h, &since_7d])
        .await
        .map_err(|error| internal_error(format!("failed to load bug metrics: {error}")))?;

    let signups = transaction
        .query(
            OPERATOR_RECENT_SIGNUPS_SQL,
            &[&OPERATOR_RECENT_SIGNUPS_LIMIT],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load recent signups: {error}")))?;

    let counts = OperatorMetricsCounts {
        active_24h: activity.get("active_24h"),
        active_7d: activity.get("active_7d"),
        active_30d: activity.get("active_30d"),
        returning_7d: activity.get("returning_7d"),
        new_users_7d: activity.get("new_users_7d"),
        total_users: activity.get("total_users"),
        projects_active_7d: activity.get("projects_active_7d"),
        projects_total: activity.get("projects_total"),
        bugs_open: bugs.get("open"),
        bugs_in_progress: bugs.get("in_progress"),
        bugs_resolved: bugs.get("resolved"),
        bugs_new_24h: bugs.get("new_24h"),
        bugs_new_7d: bugs.get("new_7d"),
        bugs_system_open: bugs.get("system_open"),
    };

    let recent_signups = signups
        .into_iter()
        .map(|row| OperatorRecentSignupRow {
            email: row.get("email"),
            full_name: row.get("full_name"),
            created_at: row.get("created_at"),
            provider: row.get("provider"),
        })
        .collect();

    Ok(Json(build_operator_metrics_summary(
        generated_at,
        counts,
        recent_signups,
    )))
}

#[cfg(test)]
mod operator_metrics_tests {
    use super::{build_operator_metrics_summary, OperatorMetricsCounts, OperatorRecentSignupRow};
    use chrono::TimeZone;
    use serde_json::Value as JsonValue;

    fn sample_signups() -> Vec<OperatorRecentSignupRow> {
        vec![
            OperatorRecentSignupRow {
                email: Some("ada@example.com".to_string()),
                full_name: Some("Ada Lovelace".to_string()),
                created_at: chrono::Utc.with_ymd_and_hms(2026, 9, 3, 11, 30, 0).unwrap(),
                provider: Some("google".to_string()),
            },
            OperatorRecentSignupRow {
                email: None,
                full_name: None,
                created_at: chrono::Utc.with_ymd_and_hms(2026, 9, 2, 8, 15, 0).unwrap(),
                provider: None,
            },
        ]
    }

    fn sample_counts() -> OperatorMetricsCounts {
        OperatorMetricsCounts {
            active_24h: 1,
            active_7d: 2,
            active_30d: 3,
            returning_7d: 4,
            new_users_7d: 5,
            total_users: 6,
            projects_active_7d: 7,
            projects_total: 8,
            bugs_open: 9,
            bugs_in_progress: 10,
            bugs_resolved: 11,
            bugs_new_24h: 12,
            bugs_new_7d: 13,
            bugs_system_open: 14,
        }
    }

    #[test]
    fn serialises_the_exact_keys_the_console_reads() {
        // serde's camelCase does not reliably produce `active24h` from
        // `active_24h`, so every digit-bearing field carries an explicit
        // rename. This locks the wire shape the console is written against.
        let summary = build_operator_metrics_summary(
            chrono::Utc.with_ymd_and_hms(2026, 9, 3, 12, 0, 0).unwrap(),
            sample_counts(),
            Vec::new(),
        );
        let payload = serde_json::to_value(&summary).expect("summary serialises");

        assert_eq!(payload["generatedAt"], "2026-09-03T12:00:00+00:00");

        let people = &payload["people"];
        assert_eq!(people["active24h"], 1);
        assert_eq!(people["active7d"], 2);
        assert_eq!(people["active30d"], 3);
        assert_eq!(people["returning7d"], 4);
        assert_eq!(people["newUsers7d"], 5);
        assert_eq!(people["totalUsers"], 6);

        let projects = &payload["projects"];
        assert_eq!(projects["active7d"], 7);
        assert_eq!(projects["total"], 8);

        let bugs = &payload["bugs"];
        assert_eq!(bugs["open"], 9);
        assert_eq!(bugs["inProgress"], 10);
        assert_eq!(bugs["resolved"], 11);
        assert_eq!(bugs["new24h"], 12);
        assert_eq!(bugs["new7d"], 13);
        assert_eq!(bugs["systemOpen"], 14);
    }

    #[test]
    fn leaks_no_snake_case_keys() {
        let summary = build_operator_metrics_summary(
            chrono::Utc.with_ymd_and_hms(2026, 9, 3, 12, 0, 0).unwrap(),
            sample_counts(),
            sample_signups(),
        );
        let payload = serde_json::to_value(&summary).expect("summary serialises");
        for (section, key) in [
            ("people", "active_24h"),
            ("people", "new_users_7d"),
            ("people", "total_users"),
            ("bugs", "in_progress"),
            ("bugs", "system_open"),
            ("projects", "active_7d"),
        ] {
            assert!(
                payload[section].get(key).is_none(),
                "{section}.{key} leaked in snake_case"
            );
        }
        assert!(payload.get("generated_at").is_none());
        assert!(payload.get("recent_signups").is_none());
        for key in ["full_name", "created_at"] {
            assert!(
                payload["recentSignups"][0].get(key).is_none(),
                "recentSignups[].{key} leaked in snake_case"
            );
        }
    }

    #[test]
    fn maps_every_count_to_its_own_field() {
        // A transposed active7d/active30d is invisible to a test that seeds
        // symmetric data, so each input here is distinct.
        let summary =
            build_operator_metrics_summary(chrono::Utc::now(), sample_counts(), Vec::new());
        let payload = serde_json::to_value(&summary).expect("summary serialises");
        let mut seen: Vec<i64> = Vec::new();
        for section in ["people", "bugs", "projects"] {
            for (_, value) in payload[section].as_object().expect("section object") {
                seen.push(value.as_i64().expect("count is an integer"));
            }
        }
        seen.sort_unstable();
        assert_eq!(seen, (1..=14).collect::<Vec<i64>>());
    }

    #[test]
    fn serialises_recent_signups_in_query_order_with_explicit_nulls() {
        // The console treats `recentSignups` as optional but, when present,
        // reads each entry's keys directly: missing values must arrive as
        // null rather than be dropped, and the order is whatever Postgres
        // returned (newest first) — the builder must not re-sort.
        let summary = build_operator_metrics_summary(
            chrono::Utc.with_ymd_and_hms(2026, 9, 3, 12, 0, 0).unwrap(),
            sample_counts(),
            sample_signups(),
        );
        let payload = serde_json::to_value(&summary).expect("summary serialises");
        let signups = payload["recentSignups"]
            .as_array()
            .expect("recentSignups is an array");
        assert_eq!(signups.len(), 2);

        assert_eq!(signups[0]["email"], "ada@example.com");
        assert_eq!(signups[0]["fullName"], "Ada Lovelace");
        assert_eq!(signups[0]["createdAt"], "2026-09-03T11:30:00+00:00");
        assert_eq!(signups[0]["provider"], "google");

        for key in ["email", "fullName", "provider"] {
            assert!(
                signups[1].get(key).is_some_and(JsonValue::is_null),
                "recentSignups[1].{key} should be present and null"
            );
        }
        assert_eq!(signups[1]["createdAt"], "2026-09-02T08:15:00+00:00");
    }

    #[test]
    fn serialises_an_empty_signup_feed_as_an_empty_array() {
        // Present-but-empty and absent both mean "nothing to render" to the
        // console; this build always sends the key so the shape is stable.
        let summary =
            build_operator_metrics_summary(chrono::Utc::now(), sample_counts(), Vec::new());
        let payload = serde_json::to_value(&summary).expect("summary serialises");
        assert_eq!(payload["recentSignups"], serde_json::json!([]));
    }
}
