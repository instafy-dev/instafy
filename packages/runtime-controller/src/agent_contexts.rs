use std::str::FromStr;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use tokio_postgres::error::SqlState;
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::active_job_auth::{authorize_active_job_if_scoped, ActiveJobProjectAccess};
use crate::auth::authenticate_request;
use crate::conversations::load_conversation_record;
use crate::projects::{ensure_project_access, ensure_project_write_access, load_project_record};
use crate::{
    ai_agents, bad_request, forbidden, internal_error, not_found, unauthorized, ApiError, AppState,
};

const MAX_CONTEXT_LEN: usize = 4_000;
const MAX_SCOPE_ID_LEN: usize = 200;
const MAX_TITLE_LEN: usize = 160;
const MAX_AGENT_HANDLE_LEN: usize = 20;
const DEFAULT_LIMIT: i64 = 50;
const MAX_LIMIT: i64 = 200;
pub(crate) const MAX_CONTEXT_CARDS_PER_AGENT_PROJECT: i64 = 200;

#[derive(Debug, PartialEq, Eq)]
enum ActiveJobContextWriteTarget {
    Project,
    Conversation(Uuid),
}

fn active_job_context_write_target(
    project_id: &Uuid,
    project_scope_allowed: bool,
    scope_kind: &str,
    scope_id: &str,
) -> Result<ActiveJobContextWriteTarget, (StatusCode, Json<ApiError>)> {
    if scope_kind == "project" {
        if project_scope_allowed && scope_id == project_id.to_string() {
            return Ok(ActiveJobContextWriteTarget::Project);
        }
        return Err(forbidden(
            "job token cannot write the requested project context",
        ));
    }
    if scope_kind == "conversation" {
        return Uuid::parse_str(scope_id.trim())
            .map(ActiveJobContextWriteTarget::Conversation)
            .map_err(|_| {
                forbidden("job token conversation context must name a valid conversation")
            });
    }
    Err(forbidden(
        "job tokens may only write project- or conversation-scoped context cards",
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentContextQuery {
    #[serde(default, alias = "agent_id")]
    agent_id: Option<String>,
    agent: Option<String>,
    #[serde(default, alias = "scope_kind")]
    scope_kind: Option<String>,
    #[serde(default, alias = "scope_id")]
    scope_id: Option<String>,
    q: Option<String>,
    limit: Option<i64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertAgentContextBody {
    #[serde(default, alias = "agent_id")]
    agent_id: Option<String>,
    agent: Option<String>,
    #[serde(alias = "scope_kind")]
    scope_kind: String,
    #[serde(alias = "scope_id")]
    scope_id: String,
    title: Option<String>,
    context: String,
    metadata: Option<JsonValue>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentContextAgent {
    id: String,
    handle: String,
    display_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentContextCard {
    id: String,
    agent_id: String,
    agent: AgentContextAgent,
    scope_kind: String,
    scope_id: String,
    title: Option<String>,
    context: String,
    metadata: JsonValue,
    created_at: String,
    updated_at: String,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/projects/:project_id/agent-contexts",
            get(list_agent_contexts),
        )
        .route(
            "/projects/:project_id/agent-contexts",
            post(upsert_agent_context),
        )
}

async fn list_agent_contexts(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Query(query): Query<AgentContextQuery>,
) -> Result<Json<Vec<AgentContextCard>>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers, None).await?;
    let project_id = parse_uuid(&project_id_raw, "projectId")?;
    let limit = normalize_limit(query.limit);
    let scope_kind = query
        .scope_kind
        .as_deref()
        .map(normalize_scope_kind)
        .transpose()?;
    let scope_id = query
        .scope_id
        .as_deref()
        .map(normalize_scope_id)
        .transpose()?;
    let search_terms = normalize_search_terms(query.q);

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = load_project_record(&transaction, &project_id).await?;
    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &context,
        ActiveJobProjectAccess::Read,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        active_job.ensure_project_id(&project_id)?;
    } else {
        ensure_project_access(&transaction, &project, &context, None).await?;
    }
    let user_id = active_job
        .as_ref()
        .map(|job| job.subject_user_id)
        .or(context.user_id)
        .ok_or_else(|| unauthorized("user session required"))?;
    let active_root_conversation_id = active_job.as_ref().map(|job| job.root_conversation_id);
    let active_job_restricted = active_job.is_some();

    let agent_filter = resolve_optional_agent_filter(
        &transaction,
        &user_id,
        query.agent_id.as_deref(),
        query.agent.as_deref(),
    )
    .await?;

    if agent_filter.requested && agent_filter.agent_id.is_none() {
        transaction
            .commit()
            .await
            .map_err(|error| internal_error(format!("failed to commit context list: {error}")))?;
        return Ok(Json(Vec::new()));
    }

    let rows = transaction
        .query(
            "select acc.id,
                    acc.agent_id,
                    ua.handle,
                    ua.display_name,
                    acc.scope_kind,
                    acc.scope_id,
                    acc.title,
                    acc.context,
                    acc.metadata,
                    acc.created_at,
                    acc.updated_at
             from agent_context_cards acc
             join user_agents ua on ua.id = acc.agent_id
             left join conversations scoped_conversation
               on acc.scope_kind = 'conversation'
              and acc.scope_id = scoped_conversation.id::text
             where acc.project_id = $1
               and acc.user_id = $2
               and ua.deleted_at is null
               and ($3::uuid is null or acc.agent_id = $3)
               and ($4::text is null or acc.scope_kind = $4)
               and ($5::text is null or acc.scope_id = $5)
               and (
                 not $7
                 or (acc.scope_kind = 'project' and acc.scope_id = $1::text)
                 or (
                   $8::uuid is not null
                   and scoped_conversation.project_id = $1
                   and coalesce(
                     scoped_conversation.root_conversation_id,
                     scoped_conversation.id
                   ) = $8
                 )
               )
               and (
                 $6::text[] is null
                 or not exists (
                   select 1
                   from unnest($6::text[]) as search_term(term)
                   where not (
                     acc.context ilike '%' || search_term.term || '%'
                     or coalesce(acc.title, '') ilike '%' || search_term.term || '%'
                     or ua.handle ilike '%' || search_term.term || '%'
                     or coalesce(ua.display_name, '') ilike '%' || search_term.term || '%'
                   )
                 )
               )
             order by acc.updated_at desc, acc.id asc
             limit $9",
            &[
                &project_id,
                &user_id,
                &agent_filter.agent_id,
                &scope_kind,
                &scope_id,
                &search_terms,
                &active_job_restricted,
                &active_root_conversation_id,
                &limit,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to list agent contexts: {error}")))?;

    let cards = rows.into_iter().map(map_context_row).collect();
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit context list: {error}")))?;

    Ok(Json(cards))
}

async fn upsert_agent_context(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(project_id_raw): AxumPath<String>,
    Json(body): Json<UpsertAgentContextBody>,
) -> Result<Json<AgentContextCard>, (StatusCode, Json<ApiError>)> {
    let request_context = authenticate_request(&state.config, &headers, None).await?;
    let project_id = parse_uuid(&project_id_raw, "projectId")?;
    let scope_kind = normalize_scope_kind(&body.scope_kind)?;
    let scope_id = normalize_scope_id(&body.scope_id)?;
    let context = normalize_context(&body.context)?;
    let title = normalize_optional_title(body.title)?;
    let metadata = normalize_metadata(body.metadata)?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = load_project_record(&transaction, &project_id).await?;
    let active_job = authorize_active_job_if_scoped(
        &transaction,
        &state,
        &request_context,
        ActiveJobProjectAccess::Write,
    )
    .await?;
    if let Some(active_job) = active_job.as_ref() {
        active_job.ensure_project_id(&project_id)?;
        match active_job_context_write_target(
            &project_id,
            active_job.can_write_project_context(),
            &scope_kind,
            &scope_id,
        )? {
            ActiveJobContextWriteTarget::Project => {}
            ActiveJobContextWriteTarget::Conversation(conversation_id) => {
                let conversation = load_conversation_record(&transaction, &conversation_id).await?;
                active_job
                    .ensure_conversation_write(&transaction, &conversation)
                    .await?;
            }
        }
    } else {
        ensure_project_write_access(&transaction, &project, &request_context, None).await?;
    }
    let user_id = active_job
        .as_ref()
        .map(|job| job.subject_user_id)
        .or(request_context.user_id)
        .ok_or_else(|| unauthorized("user session required"))?;

    let agent_id = resolve_required_agent(
        &transaction,
        &user_id,
        body.agent_id.as_deref(),
        body.agent.as_deref(),
    )
    .await?;

    let row = transaction
        .query_one(
            "insert into agent_context_cards (
                 user_id, project_id, agent_id, scope_kind, scope_id, title, context, metadata
             ) values ($1, $2, $3, $4, $5, $6, $7, $8)
             on conflict (user_id, project_id, agent_id, scope_kind, scope_id)
             do update set title = excluded.title,
                           context = excluded.context,
                           metadata = excluded.metadata,
                           updated_at = now()
             returning id,
                       agent_id,
                       (select handle from user_agents where id = agent_context_cards.agent_id) as handle,
                       (select display_name from user_agents where id = agent_context_cards.agent_id) as display_name,
                       scope_kind,
                       scope_id,
                       title,
                       context,
                       metadata,
                       created_at,
                       updated_at",
            &[
                &user_id,
                &project_id,
                &agent_id,
                &scope_kind,
                &scope_id,
                &title,
                &context,
                &PgJson(metadata),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to upsert agent context: {error}")))?;

    prune_agent_context_cards(&transaction, &user_id, &project_id, &agent_id).await?;

    let card = map_context_row(row);
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit context upsert: {error}")))?;

    Ok(Json(card))
}

fn parse_uuid(raw: &str, label: &str) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    Uuid::from_str(raw.trim()).map_err(|_| bad_request(format!("{label} must be a valid UUID")))
}

fn normalize_limit(value: Option<i64>) -> i64 {
    value.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT)
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
}

fn normalize_search_terms(value: Option<String>) -> Option<Vec<String>> {
    let terms: Vec<String> = value
        .unwrap_or_default()
        .split_whitespace()
        .map(str::trim)
        .filter(|term| !term.is_empty())
        .map(ToString::to_string)
        .take(12)
        .collect();
    if terms.is_empty() {
        None
    } else {
        Some(terms)
    }
}

fn normalize_scope_kind(raw: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let value = raw.trim().to_ascii_lowercase();
    if value.is_empty() || value.len() > 32 {
        return Err(bad_request("scopeKind must be 1-32 characters"));
    }
    let mut chars = value.chars();
    let Some(first) = chars.next() else {
        return Err(bad_request("scopeKind is required"));
    };
    if !first.is_ascii_lowercase() {
        return Err(bad_request("scopeKind must start with a lowercase letter"));
    }
    if !chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_') {
        return Err(bad_request(
            "scopeKind must contain only lowercase letters, numbers, or '_'",
        ));
    }
    Ok(value)
}

fn normalize_scope_id(raw: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let value = raw.trim().to_string();
    if value.is_empty() {
        return Err(bad_request("scopeId is required"));
    }
    if value.len() > MAX_SCOPE_ID_LEN {
        return Err(bad_request(format!(
            "scopeId is too long (max {MAX_SCOPE_ID_LEN} chars)"
        )));
    }
    Ok(value)
}

fn normalize_context(raw: &str) -> Result<String, (StatusCode, Json<ApiError>)> {
    let value = raw.trim().to_string();
    if value.is_empty() {
        return Err(bad_request("context is required"));
    }
    if value.len() > MAX_CONTEXT_LEN {
        return Err(bad_request(format!(
            "context is too long (max {MAX_CONTEXT_LEN} chars)"
        )));
    }
    Ok(value)
}

fn normalize_optional_title(
    raw: Option<String>,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let value = normalize_optional_text(raw);
    if value
        .as_ref()
        .map(|entry| entry.len() > MAX_TITLE_LEN)
        .unwrap_or(false)
    {
        return Err(bad_request(format!(
            "title is too long (max {MAX_TITLE_LEN} chars)"
        )));
    }
    Ok(value)
}

fn normalize_metadata(value: Option<JsonValue>) -> Result<JsonValue, (StatusCode, Json<ApiError>)> {
    let metadata = value.unwrap_or_else(|| JsonValue::Object(Default::default()));
    if !metadata.is_object() {
        return Err(bad_request("metadata must be a JSON object"));
    }
    Ok(metadata)
}

fn normalize_agent_handle(raw: &str) -> Option<String> {
    let value = raw
        .trim()
        .trim_start_matches('@')
        .trim()
        .to_ascii_lowercase();
    if value.is_empty() || value.len() > MAX_AGENT_HANDLE_LEN {
        return None;
    }
    let mut bytes = value.bytes();
    let first = bytes.next()?;
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return None;
    }
    if !bytes.all(|byte| {
        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
    }) {
        return None;
    }
    Some(value)
}

struct AgentFilter {
    requested: bool,
    agent_id: Option<Uuid>,
}

async fn resolve_optional_agent_filter(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
    agent_id_raw: Option<&str>,
    agent_raw: Option<&str>,
) -> Result<AgentFilter, (StatusCode, Json<ApiError>)> {
    let requested = agent_id_raw
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
        || agent_raw
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
    if !requested {
        return Ok(AgentFilter {
            requested: false,
            agent_id: None,
        });
    }

    let agent_id = resolve_agent_id(transaction, user_id, agent_id_raw, agent_raw, false).await?;
    Ok(AgentFilter {
        requested: true,
        agent_id,
    })
}

async fn resolve_required_agent(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
    agent_id_raw: Option<&str>,
    agent_raw: Option<&str>,
) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    if let Some(raw) = agent_id_raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let id = parse_uuid(raw, "agentId")?;
        return find_agent_by_id(transaction, user_id, &id)
            .await?
            .ok_or_else(|| not_found("agent not found"));
    }

    let Some(raw_agent) = agent_raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Err(not_found("agent not found"));
    };

    if let Ok(id) = Uuid::from_str(raw_agent) {
        return find_agent_by_id(transaction, user_id, &id)
            .await?
            .ok_or_else(|| not_found("agent not found"));
    }

    let Some(handle) = normalize_agent_handle(raw_agent) else {
        return Err(not_found("agent not found"));
    };

    if handle == "octo" {
        let profile = ai_agents::load_or_create_octo_agent_profile(transaction, user_id).await?;
        return Ok(profile.id);
    }

    if let Some(agent_id) = find_agent_by_handle(transaction, user_id, &handle).await? {
        return Ok(agent_id);
    }

    create_context_agent_profile(transaction, user_id, &handle).await
}

async fn resolve_agent_id(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
    agent_id_raw: Option<&str>,
    agent_raw: Option<&str>,
    create_octo: bool,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    if let Some(raw) = agent_id_raw
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let id = parse_uuid(raw, "agentId")?;
        return find_agent_by_id(transaction, user_id, &id).await;
    }

    let Some(raw_agent) = agent_raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };

    if let Ok(id) = Uuid::from_str(raw_agent) {
        return find_agent_by_id(transaction, user_id, &id).await;
    }

    let Some(handle) = normalize_agent_handle(raw_agent) else {
        return Ok(None);
    };

    if create_octo && handle == "octo" {
        let profile = ai_agents::load_or_create_octo_agent_profile(transaction, user_id).await?;
        return Ok(Some(profile.id));
    }

    find_agent_by_handle(transaction, user_id, &handle).await
}

async fn find_agent_by_handle(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
    handle: &str,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select id
             from user_agents
             where user_id = $1
               and lower(handle) = lower($2)
               and deleted_at is null
             limit 1",
            &[user_id, &handle],
        )
        .await
        .map_err(|error| internal_error(format!("failed to resolve agent handle: {error}")))?;

    Ok(row.map(|row| row.get("id")))
}

async fn create_context_agent_profile(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
    handle: &str,
) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    let agent_id = Uuid::new_v4();
    let provider = "assistant".to_string();
    let display_name = Some(display_name_from_handle(handle));
    let description = Some("Created automatically for scoped agent context cards.".to_string());
    let avatar_seed = handle.to_string();

    let insert = transaction
        .execute(
            "insert into user_agents (
                 id, user_id, provider, handle, display_name, description, avatar_seed
             ) values ($1, $2, $3, $4, $5, $6, $7)",
            &[
                &agent_id,
                user_id,
                &provider,
                &handle,
                &display_name,
                &description,
                &avatar_seed,
            ],
        )
        .await;

    match insert {
        Ok(_) => Ok(agent_id),
        Err(error) => {
            if error
                .as_db_error()
                .map(|db| db.code() == &SqlState::UNIQUE_VIOLATION)
                .unwrap_or(false)
            {
                return find_agent_by_handle(transaction, user_id, handle)
                    .await?
                    .ok_or_else(|| {
                        internal_error("agent handle conflicted but could not be reloaded")
                    });
            }
            Err(internal_error(format!(
                "failed to create context agent profile: {error}"
            )))
        }
    }
}

fn display_name_from_handle(handle: &str) -> String {
    let mut out = String::new();
    for part in handle.split(['-', '_']).filter(|part| !part.is_empty()) {
        if !out.is_empty() {
            out.push(' ');
        }
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
    }
    if out.is_empty() {
        handle.to_string()
    } else {
        out
    }
}

async fn find_agent_by_id(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
    agent_id: &Uuid,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select id
             from user_agents
             where id = $1
               and user_id = $2
               and deleted_at is null
             limit 1",
            &[agent_id, user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to resolve agent id: {error}")))?;
    Ok(row.map(|row| row.get("id")))
}

async fn prune_agent_context_cards(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
    project_id: &Uuid,
    agent_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .execute(
            "with ranked as (
                select id,
                       row_number() over (
                         order by updated_at desc, created_at desc, id desc
                       ) as card_rank
                from agent_context_cards
                where user_id = $1
                  and project_id = $2
                  and agent_id = $3
             )
             delete from agent_context_cards
             where id in (
                select id from ranked where card_rank > $4
             )",
            &[
                user_id,
                project_id,
                agent_id,
                &MAX_CONTEXT_CARDS_PER_AGENT_PROJECT,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to prune agent contexts: {error}")))?;
    Ok(())
}

fn map_context_row(row: tokio_postgres::Row) -> AgentContextCard {
    let id: Uuid = row.get("id");
    let agent_id: Uuid = row.get("agent_id");
    let handle: String = row.get("handle");
    let display_name: Option<String> = row.get("display_name");
    let scope_kind: String = row.get("scope_kind");
    let scope_id: String = row.get("scope_id");
    let title: Option<String> = row.get("title");
    let context: String = row.get("context");
    let metadata: JsonValue = row.get::<_, PgJson<JsonValue>>("metadata").0;
    let created_at: DateTime<Utc> = row.get("created_at");
    let updated_at: DateTime<Utc> = row.get("updated_at");

    AgentContextCard {
        id: id.to_string(),
        agent_id: agent_id.to_string(),
        agent: AgentContextAgent {
            id: agent_id.to_string(),
            handle,
            display_name,
        },
        scope_kind,
        scope_id,
        title,
        context,
        metadata,
        created_at: created_at.to_rfc3339(),
        updated_at: updated_at.to_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_job_context_writes_are_limited_to_safe_project_or_conversation_scopes() {
        let project_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        assert_eq!(
            active_job_context_write_target(
                &project_id,
                false,
                "conversation",
                &conversation_id.to_string(),
            )
            .expect("conversation scope should resolve"),
            ActiveJobContextWriteTarget::Conversation(conversation_id)
        );
        assert_eq!(
            active_job_context_write_target(&project_id, true, "project", &project_id.to_string(),)
                .expect("public job should resolve exact project scope"),
            ActiveJobContextWriteTarget::Project
        );
        assert!(active_job_context_write_target(
            &project_id,
            false,
            "project",
            &project_id.to_string(),
        )
        .is_err());
        assert!(active_job_context_write_target(
            &project_id,
            true,
            "project",
            &Uuid::new_v4().to_string(),
        )
        .is_err());
        assert!(
            active_job_context_write_target(&project_id, true, "conversation", "not-a-uuid")
                .is_err()
        );
        assert!(active_job_context_write_target(&project_id, true, "workspace", "host").is_err());
    }

    #[test]
    fn normalize_agent_handle_accepts_scoped_worker_handles() {
        assert_eq!(normalize_agent_handle("@Front"), Some("front".to_string()));
        assert_eq!(
            normalize_agent_handle("api-review"),
            Some("api-review".to_string())
        );
        assert_eq!(
            normalize_agent_handle("runtime_tools"),
            Some("runtime_tools".to_string())
        );
    }

    #[test]
    fn normalize_agent_handle_rejects_invalid_handles() {
        assert_eq!(normalize_agent_handle(""), None);
        assert_eq!(normalize_agent_handle("-front"), None);
        assert_eq!(normalize_agent_handle("front!"), None);
        assert_eq!(normalize_agent_handle("this-handle-is-far-too-long"), None);
    }

    #[test]
    fn display_name_from_handle_titles_worker_handles() {
        assert_eq!(display_name_from_handle("front"), "Front");
        assert_eq!(display_name_from_handle("api-review"), "Api Review");
        assert_eq!(display_name_from_handle("runtime_tools"), "Runtime Tools");
    }
}
