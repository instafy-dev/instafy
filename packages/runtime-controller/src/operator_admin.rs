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
