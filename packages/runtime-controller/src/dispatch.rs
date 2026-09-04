use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::time::Duration;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::Json;
use axum::Router;
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use jsonwebtoken::errors::ErrorKind as JwtErrorKind;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tokio_postgres::Transaction;
use tracing::{info, instrument, warn};
use uuid::Uuid;

use crate::agent_write_scopes::{
    apply_agent_write_scope_metadata, build_agent_write_scope_plan, AgentWriteScopeAssignment,
};
use crate::ai_agents;
use crate::auth::{authenticate_request, RequestContext};
use crate::bug_reports::{record_system_bug_report, SystemBugReportInput};
use crate::credentials;
use crate::model_defaults::DEFAULT_MANAGED_AI_PROVIDER_ID;
use crate::state::publish_controller_event_to_user;
use crate::{
    agent, bad_request, coerce_idle_ttl, conversations, credits, forbidden, internal_error,
    projects::ensure_project_org, publish_controller_event,
    publish_controller_event_with_conversation, runs, runtime, too_many_requests, unauthorized,
    workspace, ApiError, AppConfig, AppState, ProjectRecord,
};

const DEFAULT_PROMPT_INTENT: &str = "feature";
const DEFAULT_PROMPT_PRIORITY: i32 = 100;
const EXECUTION_MODE_APPLY: &str = "apply";
const EXECUTION_MODE_APPROVAL: &str = "approval_required";
const EXECUTION_MODE_PLAN_ONLY: &str = "plan_only";
const WORKSPACE_MODE_SHARED_READ: &str = "shared_read";
const WORKSPACE_MODE_SHARED_WRITE: &str = "shared_write";
const WORKSPACE_MODE_ISOLATED_WRITE: &str = "isolated_write";
const SHARED_BROWSER_CONSENT_VERSION: u64 = 1;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/dispatch-prompt", post(dispatch_prompt))
        .route("/progress-callback", post(progress_callback))
}

pub(crate) async fn ensure_project_prompt_access(
    transaction: &Transaction<'_>,
    project: &ProjectRecord,
    context: &RequestContext,
    session_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    crate::ensure_project_write_access(transaction, project, context, session_id)
        .await
        .map(|_| ())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchPromptRequest {
    pub(crate) project_id: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) prompt_text: Option<String>,
    pub(crate) intent: Option<String>,
    pub(crate) plan_seed: Option<JsonValue>,
    pub(crate) metadata: Option<JsonValue>,
    #[serde(rename = "conversationMetadata", alias = "conversation_metadata")]
    pub(crate) conversation_metadata: Option<JsonValue>,
    #[serde(rename = "parentConversationId", alias = "parent_conversation_id")]
    pub(crate) parent_conversation_id: Option<String>,
    #[serde(rename = "threadKind", alias = "thread_kind")]
    pub(crate) thread_kind: Option<String>,
    #[serde(default)]
    pub(crate) tool_limits: Option<JsonValue>,
    pub(crate) repo: Option<DispatchPromptRepo>,
    pub(crate) ui: Option<DispatchPromptUi>,
    pub(crate) priority: Option<i32>,
    pub(crate) runtime_type: Option<String>,
    pub(crate) idle_ttl_seconds: Option<u32>,
    pub(crate) conversation_id: Option<String>,
    #[serde(rename = "runtimeId", alias = "runtime_id")]
    pub(crate) runtime_id: Option<String>,
    #[serde(rename = "runtimeDisplayName", alias = "runtime_display_name")]
    pub(crate) runtime_display_name: Option<String>,
    #[serde(rename = "preferRuntime", alias = "prefer_runtime")]
    pub(crate) prefer_runtime: Option<bool>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchPromptRepo {
    pub(crate) owner: Option<String>,
    pub(crate) name: Option<String>,
    #[serde(rename = "installationId")]
    pub(crate) installation_id: Option<i64>,
    #[serde(rename = "defaultBranch")]
    pub(crate) default_branch: Option<String>,
    #[serde(rename = "workingBranch")]
    pub(crate) working_branch: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct DispatchPromptRepoNormalized {
    pub(crate) owner: Option<String>,
    pub(crate) name: Option<String>,
    pub(crate) installation_id: Option<i64>,
    pub(crate) default_branch: Option<String>,
    pub(crate) working_branch: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DispatchPromptUi {
    pub(crate) requested_preview: Option<bool>,
}

#[derive(Debug, Serialize)]
pub(crate) struct DispatchPromptResponse {
    #[serde(rename = "runId", skip_serializing_if = "Option::is_none")]
    pub(crate) run_id: Option<Uuid>,
    #[serde(rename = "runIds", skip_serializing_if = "Option::is_none")]
    pub(crate) run_ids: Option<Vec<Uuid>>,
    #[serde(rename = "promptId", skip_serializing_if = "Option::is_none")]
    pub(crate) prompt_id: Option<Uuid>,
    #[serde(rename = "jobId")]
    pub(crate) job_id: Option<Uuid>,
    #[serde(rename = "jobIds", skip_serializing_if = "Option::is_none")]
    pub(crate) job_ids: Option<Vec<Uuid>>,
    pub(crate) status: String,
    #[serde(rename = "conversationId")]
    pub(crate) conversation_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
struct AgentTarget {
    handle: String,
    agent_id: Option<Uuid>,
    credential_id: Option<Uuid>,
    runtime_id: Option<Uuid>,
    display_name: Option<String>,
    description: Option<String>,
    avatar_seed: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct DispatchPromptNormalized {
    pub(crate) project_id: Uuid,
    pub(crate) session_id: Option<Uuid>,
    pub(crate) session_raw: Option<String>,
    pub(crate) conversation_id: Option<Uuid>,
    pub(crate) conversation_raw: Option<String>,
    pub(crate) conversation_metadata: Option<JsonValue>,
    pub(crate) parent_conversation_id: Option<Uuid>,
    pub(crate) thread_kind: Option<String>,
    pub(crate) conversation_is_new: bool,
    pub(crate) prompt_text: String,
    pub(crate) intent: String,
    pub(crate) plan_seed: Option<JsonValue>,
    pub(crate) metadata: JsonValue,
    pub(crate) tool_limits: Option<JsonValue>,
    pub(crate) repo: Option<DispatchPromptRepoNormalized>,
    pub(crate) requested_preview: Option<bool>,
    pub(crate) priority: i32,
    pub(crate) runtime_type: Option<String>,
    pub(crate) idle_ttl_seconds: Option<u32>,
    pub(crate) project_type_hint: Option<String>,
    pub(crate) execution_mode: String,
    pub(crate) workspace_mode: String,
    pub(crate) runtime_id: Option<Uuid>,
    pub(crate) runtime_source: Option<String>,
    pub(crate) runtime_updated_at: Option<DateTime<Utc>>,
    pub(crate) runtime_display_name: Option<String>,
    pub(crate) prefer_runtime: bool,
    /// Optimistic admission fence used by interactive composer sends. Callers
    /// that intentionally allow overlapping work leave this false.
    pub(crate) expected_lane_idle: bool,
    /// Controller-private queue reservation ignored by that entry's own lane
    /// admission check. Browser payloads can never set this field.
    pub(crate) dispatch_queue_entry_id: Option<Uuid>,
    /// Trusted internal opt-in set only by the automation scheduler. This is
    /// deliberately absent from the public dispatch request shape.
    pub(crate) allow_silent_automation_decline: bool,
}

fn normalize_agent_handle(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_start_matches('@').trim().to_lowercase();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.len() > 20 {
        return None;
    }
    if !trimmed
        .chars()
        .next()
        .map(|ch| ch.is_ascii_alphanumeric())
        .unwrap_or(false)
    {
        return None;
    }
    if !trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return None;
    }
    Some(trimmed)
}

fn parse_agent_mention_at(input: &str, at_index: usize) -> Option<(String, usize)> {
    if !input.get(at_index..)?.starts_with('@') {
        return None;
    }
    if input
        .get(..at_index)
        .and_then(|prefix| prefix.chars().next_back())
        .map(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.')
        .unwrap_or(false)
    {
        return None;
    }

    let tail = input.get(at_index + 1..)?;
    let mut end = at_index + 1;
    let mut count = 0usize;

    for (offset, ch) in tail.char_indices() {
        if !(ch.is_ascii_alphanumeric() || ch == '_' || ch == '-') {
            break;
        }
        if count >= 20 {
            return None;
        }
        end = at_index + 1 + offset + ch.len_utf8();
        count += 1;
    }

    if count == 0 {
        return None;
    }

    if input
        .get(end..)
        .and_then(|rest| rest.chars().next())
        .map(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
        .unwrap_or(false)
    {
        return None;
    }

    let handle = input.get(at_index + 1..end)?;
    normalize_agent_handle(handle).map(|handle| (handle, end))
}

fn strip_leading_agent_mentions(input: &str) -> String {
    let mut rest = input.trim_start();

    loop {
        if !rest.starts_with('@') {
            break;
        }
        let Some((_handle, end)) = parse_agent_mention_at(rest, 0) else {
            break;
        };
        rest = rest.get(end..).unwrap_or_default().trim_start();
    }

    rest.trim().to_string()
}

fn build_prompt_segments_by_handle(
    prompt: &str,
    explicit_handles: &[String],
) -> HashMap<String, String> {
    let allowed_handles = explicit_handles
        .iter()
        .filter_map(|handle| normalize_agent_handle(handle))
        .collect::<HashSet<_>>();
    if allowed_handles.is_empty() {
        return HashMap::new();
    }

    let leading_text_start = prompt
        .char_indices()
        .find(|(_index, ch)| !ch.is_whitespace())
        .map(|(index, _ch)| index)
        .unwrap_or(prompt.len());
    let mut first_any_mention_start: Option<usize> = None;
    let mut seen = HashSet::<String>::new();
    let mut mentions: Vec<(String, usize)> = Vec::new();
    for (index, ch) in prompt.char_indices() {
        if ch != '@' {
            continue;
        }
        let Some((handle, _end)) = parse_agent_mention_at(prompt, index) else {
            continue;
        };
        first_any_mention_start.get_or_insert(index);
        if !allowed_handles.contains(&handle) {
            continue;
        }
        if seen.insert(handle.clone()) {
            mentions.push((handle, index));
        }
    }

    if first_any_mention_start
        .map(|start| start != leading_text_start)
        .unwrap_or(false)
    {
        return HashMap::new();
    }

    let mut segments = HashMap::new();
    for index in 0..mentions.len() {
        let (handle, start) = &mentions[index];
        let next_start = mentions
            .get(index + 1)
            .map(|(_handle, next_start)| *next_start)
            .unwrap_or(prompt.len());
        let raw_segment = prompt[*start..next_start].trim();
        if raw_segment.is_empty() {
            continue;
        }

        let segment_without_mentions = strip_leading_agent_mentions(raw_segment);
        let segment = if segment_without_mentions.is_empty() {
            prompt.trim()
        } else {
            raw_segment
        };
        if !segment.is_empty() {
            segments.insert(handle.clone(), segment.to_string());
        }
    }

    segments
}

fn extract_agent_selection_prompt_segments(
    metadata: &JsonValue,
    agent_handles: &[String],
) -> HashMap<String, String> {
    let allowed_handles = agent_handles
        .iter()
        .filter_map(|handle| normalize_agent_handle(handle))
        .collect::<HashSet<_>>();
    if allowed_handles.is_empty() {
        return HashMap::new();
    }

    let Some(metadata_map) = metadata.as_object() else {
        return HashMap::new();
    };
    let containers = [
        metadata_map
            .get("agentSelection")
            .and_then(JsonValue::as_object)
            .and_then(|selection| {
                selection
                    .get("promptSegments")
                    .or_else(|| selection.get("prompt_segments"))
            }),
        metadata_map
            .get("agentPromptSegments")
            .or_else(|| metadata_map.get("agent_prompt_segments")),
    ];

    let mut segments = HashMap::new();
    for container in containers.into_iter().flatten() {
        let Some(segment_map) = container.as_object() else {
            continue;
        };
        for (raw_handle, value) in segment_map {
            let Some(handle) = normalize_agent_handle(raw_handle) else {
                continue;
            };
            if !allowed_handles.contains(&handle) {
                continue;
            }
            let Some(segment) = parse_agent_prompt_segment_value(value) else {
                continue;
            };
            segments.insert(handle, segment);
        }
    }

    segments
}

fn parse_agent_prompt_segment_value(value: &JsonValue) -> Option<String> {
    let raw = match value {
        JsonValue::String(raw) => raw.as_str(),
        JsonValue::Object(map) => map
            .get("prompt")
            .or_else(|| map.get("text"))
            .and_then(JsonValue::as_str)?,
        _ => return None,
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn apply_agent_prompt_segment(
    request: &mut DispatchPromptNormalized,
    prompt_segments: &HashMap<String, String>,
    target: &AgentTarget,
) {
    if let Some(segment) = prompt_segments
        .get(&target.handle)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        request.prompt_text = segment.to_string();
    }
}

fn has_explicit_agent_mentions(metadata: &JsonValue) -> bool {
    metadata
        .as_object()
        .and_then(|map| map.get("agentSelection"))
        .and_then(JsonValue::as_object)
        .and_then(|selection| selection.get("mentions"))
        .and_then(JsonValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|value| value.as_str())
                .filter_map(normalize_agent_handle)
                .next()
                .is_some()
        })
        .unwrap_or(false)
}

fn extract_agent_selection_handles(metadata: &JsonValue) -> Vec<String> {
    let selection = metadata
        .as_object()
        .and_then(|map| map.get("agentSelection"))
        .and_then(JsonValue::as_object);

    let list_for_key = |key: &str| -> Vec<String> {
        selection
            .and_then(|map| map.get(key))
            .and_then(JsonValue::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|value| value.as_str())
                    .filter_map(normalize_agent_handle)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    };

    let mentions = list_for_key("mentions");
    let active = list_for_key("active");
    let raw = if !mentions.is_empty() {
        mentions
    } else {
        active
    };

    let mut seen = HashSet::<String>::new();
    let mut out = Vec::new();
    for handle in raw {
        if seen.insert(handle.clone()) {
            out.push(handle);
        }
    }

    if out.is_empty() {
        out.push("octo".to_string());
    }

    out
}

async fn resolve_agent_targets(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    user_id: Option<Uuid>,
    handles: Vec<String>,
    default_credential_id: Option<Uuid>,
) -> Result<Vec<AgentTarget>, (StatusCode, Json<ApiError>)> {
    let mut targets = Vec::new();

    for handle in handles {
        let mut agent_id: Option<Uuid> = None;
        let mut credential_id: Option<Uuid> = None;
        let mut runtime_id: Option<Uuid> = None;
        let mut display_name: Option<String> = None;
        let mut description: Option<String> = None;
        let mut avatar_seed: Option<String> = None;

        if let Some(user_uuid) = user_id {
            let row = transaction
                .query_opt(
                    "select ua.id as agent_id,
                            uc.id as credential_id,
                            uaps.runtime_id as runtime_id,
                            ua.display_name as display_name,
                            ua.description as description,
                            ua.avatar_seed as avatar_seed
                     from user_agents ua
                     left join user_credentials uc
                       on uc.id = ua.credential_id and uc.revoked_at is null
                     left join user_agent_project_settings uaps
                       on uaps.user_id = ua.user_id
                      and uaps.agent_id = ua.id
                      and uaps.project_id = $3
                     where ua.user_id = $1
                       and lower(ua.handle) = lower($2)
                       and ua.deleted_at is null
                     limit 1",
                    &[&user_uuid, &handle, project_id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to load agent credential mapping: {error}"))
                })?;
            if let Some(row) = row {
                agent_id = row.get("agent_id");
                credential_id = row.get("credential_id");
                runtime_id = row.get("runtime_id");
                display_name = row.get("display_name");
                description = row.get("description");
                avatar_seed = Some(row.get("avatar_seed"));
            }
        }

        if handle == "octo" && agent_id.is_none() {
            let (octo_agent_id, octo_display_name, octo_description) = match user_id {
                Some(user_id) => {
                    let profile =
                        ai_agents::load_or_create_octo_agent_profile(transaction, &user_id).await?;
                    (Some(profile.id), profile.display_name, profile.description)
                }
                None => (None, Some("Octo".to_string()), None),
            };
            agent_id = octo_agent_id;
            display_name = octo_display_name;
            description = octo_description;
            avatar_seed = Some("octo".to_string());
        }

        let resolved_credential_id = credential_id.or(default_credential_id);
        targets.push(AgentTarget {
            handle,
            agent_id,
            credential_id: resolved_credential_id,
            runtime_id,
            display_name,
            description,
            avatar_seed,
        });
    }

    if targets.is_empty() {
        let (agent_id, display_name, description) = match user_id {
            Some(user_id) => {
                let profile =
                    ai_agents::load_or_create_octo_agent_profile(transaction, &user_id).await?;
                (Some(profile.id), profile.display_name, profile.description)
            }
            None => (None, Some("Octo".to_string()), None),
        };
        targets.push(AgentTarget {
            handle: "octo".to_string(),
            agent_id,
            credential_id: default_credential_id,
            runtime_id: None,
            display_name,
            description,
            avatar_seed: Some("octo".to_string()),
        });
    }

    Ok(targets)
}

fn inject_agent_target_metadata(metadata: &mut JsonValue, target: &AgentTarget) {
    let map = ensure_object(metadata);
    let mut agent_map = JsonMap::new();
    agent_map.insert(
        "handle".to_string(),
        JsonValue::String(target.handle.clone()),
    );
    if let Some(agent_id) = target.agent_id {
        agent_map.insert("id".to_string(), JsonValue::String(agent_id.to_string()));
    }
    if let Some(display_name) = target.display_name.as_ref() {
        agent_map.insert(
            "displayName".to_string(),
            JsonValue::String(display_name.clone()),
        );
    }
    if let Some(description) = target.description.as_ref() {
        agent_map.insert(
            "description".to_string(),
            JsonValue::String(description.clone()),
        );
    }
    let avatar_seed = target
        .avatar_seed
        .as_ref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
        .or_else(|| target.agent_id.map(|value| value.to_string()))
        .unwrap_or_else(|| target.handle.clone());
    agent_map.insert("avatarSeed".to_string(), JsonValue::String(avatar_seed));
    map.insert("agent".to_string(), JsonValue::Object(agent_map));
}

/// Roster of every AI participant receiving an ambient evaluation dispatch
/// for this turn (handle plus display name/description when available), in
/// dispatch order. Stamped on each evaluation job payload so the delivered
/// turn can list the agent's AI peers.
fn build_ambient_ai_participants(agent_runs: &[(Uuid, AgentTarget)]) -> JsonValue {
    let participants = agent_runs
        .iter()
        .map(|(_, target)| {
            let mut entry = JsonMap::new();
            entry.insert(
                "handle".to_string(),
                JsonValue::String(target.handle.clone()),
            );
            if let Some(display_name) = target
                .display_name
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                entry.insert(
                    "displayName".to_string(),
                    JsonValue::String(display_name.to_string()),
                );
            }
            if let Some(description) = target
                .description
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                entry.insert(
                    "description".to_string(),
                    JsonValue::String(description.to_string()),
                );
            }
            JsonValue::Object(entry)
        })
        .collect::<Vec<_>>();
    JsonValue::Array(participants)
}

fn managed_ai_gate_message(managed_ai: &credentials::ManagedAiAccessResponse) -> String {
    if !managed_ai.enabled {
        return "Connect your own AI to continue. Managed Instafy AI is unavailable right now."
            .to_string();
    }

    if let Some(remaining) = managed_ai.remaining_prompts {
        if remaining <= 0 && managed_ai.daily_prompt_limit > 0 {
            return format!(
                "Connect your own AI to continue. You have used all {} Instafy AI prompts available today.",
                managed_ai.daily_prompt_limit
            );
        }
    }

    "Connect your own AI to continue. This request needs a personal AI connection.".to_string()
}

fn dispatch_requires_ai_access(intent: &str) -> bool {
    !intent.trim().eq_ignore_ascii_case("terminal_command")
}

#[instrument(skip(state, headers, payload))]
async fn dispatch_prompt(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<DispatchPromptRequest>,
) -> Result<Json<DispatchPromptResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let mut request = normalize_dispatch_request(payload)?;

    if !state.config.dev_mode && !context.is_service_role {
        if let Some(user_id) = context.user_id {
            state
                .rate_limiter
                .enforce(
                    format!("dispatch:user:{user_id}"),
                    90,
                    Duration::from_secs(60),
                )
                .await
                .map_err(|limit| {
                    let seconds = limit.retry_after.as_secs().max(1);
                    too_many_requests(format!("Too many prompts. Try again in {seconds}s."))
                })?;
        }
    }

    let conversation_was_missing = request.conversation_id.is_none();
    if request.conversation_id.is_none() {
        request.conversation_id = Some(Uuid::new_v4());
        request.conversation_raw = request.conversation_id.map(|value| value.to_string());
    }
    request.conversation_is_new = request.conversation_is_new || conversation_was_missing;

    if let Some(conversation_id) = request.conversation_id {
        conversations::inject_conversation_metadata(&mut request.metadata, &conversation_id);
    }

    let response = process_dispatch_prompt(&state, &context, request).await?;
    Ok(Json(response))
}

pub(crate) async fn process_dispatch_prompt(
    state: &AppState,
    context: &RequestContext,
    mut request: DispatchPromptNormalized,
) -> Result<DispatchPromptResponse, (StatusCode, Json<ApiError>)> {
    // Parity with the record path: untrusted callers must not persist a forged
    // controller participation marker through gate-bypassing dispatches (e.g.
    // explicit @octo). The controller stamps its own resolution for ambient
    // turns further down.
    if !context.is_service_role {
        conversations::strip_client_group_participation_claims(&mut request.metadata);
    }
    // Browser control is bound to the runtime that owns the visible page.
    // Capture the caller's explicit runtime before project/conversation
    // preferences are considered so these requests can never drift to an
    // agent-specific or hosted runtime later in dispatch.
    let strict_personal_browser_runtime_id =
        personal_browser_runtime_id(&request.metadata, request.runtime_id)?;
    let strict_shared_browser_runtime_id =
        shared_browser_runtime_id(&request.metadata, request.runtime_id)?;
    if strict_shared_browser_runtime_id.is_some() {
        canonicalize_shared_browser_request(&mut request)?;
    }
    let strict_browser_runtime_id =
        strict_personal_browser_runtime_id.or(strict_shared_browser_runtime_id);

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let mut transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project =
        ensure_project_record_for_dispatch(&transaction, &state.config, &request, context).await?;
    crate::ensure_project_access(&transaction, &project, context, request.session_id).await?;
    ensure_project_prompt_access(&transaction, &project, context, request.session_id).await?;

    if let Some(user_id) = context.user_id {
        let map = ensure_object(&mut request.metadata);
        map.entry("userId".to_string())
            .or_insert_with(|| JsonValue::String(user_id.to_string()));
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize project ensure: {error}")))?;

    let (selected_runtime_preference, runtime_preference_target_user) =
        if let Some(user_id) = context.user_id {
            if let Some(preference) = state
                .runtime_preferences
                .get_private(&project.id, &user_id)
                .await
            {
                (Some(preference), Some(user_id))
            } else {
                (state.runtime_preferences.get(&project.id).await, None)
            }
        } else {
            (state.runtime_preferences.get(&project.id).await, None)
        };
    let project_runtime_preference = if let Some(preference) = selected_runtime_preference {
        let accessible = if let Some(runtime_id) = preference.runtime_id {
            workspace::fetch_runtime_candidate_with_client(&*connection, &project.id, &runtime_id)
                .await?
                .is_some_and(|candidate| {
                    runtime::self_hosted_runtime_is_accessible_to_user(
                        &state,
                        &candidate.provider,
                        &candidate.capabilities,
                        context.user_id,
                        context.is_service_role,
                    )
                })
        } else {
            true
        };
        accessible.then_some(preference)
    } else {
        None
    };

    transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = ensure_project_org(&transaction, &project).await?;
    crate::ensure_project_access(&transaction, &project, context, request.session_id).await?;
    ensure_project_prompt_access(&transaction, &project, context, request.session_id).await?;

    let strict_browser_runtime_record = if let Some(runtime_id) = strict_personal_browser_runtime_id
    {
        Some(
            ensure_personal_browser_runtime_dispatchable(
                &transaction,
                &project.id,
                &runtime_id,
                context.user_id,
            )
            .await?,
        )
    } else if let Some(runtime_id) = strict_shared_browser_runtime_id {
        Some(
            ensure_shared_browser_runtime_dispatchable(
                &state,
                &transaction,
                &project.id,
                &runtime_id,
            )
            .await?,
        )
    } else {
        None
    };

    let conversation =
        conversations::ensure_conversation_record(&transaction, &project, &mut request, context)
            .await?;

    // Every dispatch that can create an agent job crosses this fence. Most
    // internal callers intentionally retain their existing overlap policy,
    // but interactive sends and send-queue drains perform their authoritative
    // lane-idle comparison while holding the same lock as job insertion. This
    // closes the stale-client/drain race across controller processes.
    let dispatch_fence_key = format!("conversation-dispatch:{}", conversation.id);
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&dispatch_fence_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to acquire conversation dispatch fence: {error}"
            ))
        })?;

    let mut existing_recorded_message = None;
    if !should_suppress_dispatch_user_message(&request.metadata) {
        if let Some(client_message_id) =
            conversations::extract_client_message_id_from_metadata(&request.metadata)
        {
            let advisory_lock_key = conversations::conversation_message_idempotency_lock_key(
                &conversation.id,
                &client_message_id,
            );
            transaction
                .query_one("select pg_advisory_xact_lock($1)", &[&advisory_lock_key])
                .await
                .map_err(|error| {
                    internal_error(format!(
                        "failed to acquire dispatch message idempotency lock: {error}"
                    ))
                })?;

            if let Some(existing) = conversations::find_conversation_message_by_client_message_id(
                &transaction,
                &conversation.id,
                &client_message_id,
            )
            .await?
            {
                conversations::ensure_conversation_message_idempotency_match(
                    &existing,
                    context.user_id,
                    "user",
                    &request.prompt_text,
                )?;
                if let Some(existing_run_id) = existing.run_id {
                    transaction.commit().await.map_err(|error| {
                        internal_error(format!(
                            "failed to finalize duplicate dispatch lookup: {error}"
                        ))
                    })?;
                    return Ok(DispatchPromptResponse {
                        run_id: Some(existing_run_id),
                        run_ids: None,
                        prompt_id: existing.prompt_id,
                        job_id: None,
                        job_ids: None,
                        status: "queued".to_string(),
                        conversation_id: Some(conversation.id),
                    });
                }
                if conversations::is_controller_enforced_silent_group_message(&existing.metadata) {
                    transaction.commit().await.map_err(|error| {
                        internal_error(format!(
                            "failed to finalize duplicate human-only dispatch lookup: {error}"
                        ))
                    })?;
                    return Ok(recorded_dispatch_response(conversation.id));
                }
                existing_recorded_message = Some(existing);
            }
        }
    }

    // Idempotent retries must win before the optimistic lane comparison. A
    // retry of a successfully admitted message naturally finds its own active
    // job and must return that run, never enqueue a duplicate follow-up.
    if request.expected_lane_idle {
        let requested_handles = extract_agent_selection_handles(&request.metadata);
        let rows = transaction
            .query(
                "select payload from agent_jobs
                 where conversation_id = $1
                   and status in ('queued','leased')",
                &[&conversation.id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to verify dispatch lane availability: {error}"
                ))
            })?;
        let mut active_handles = HashSet::new();
        let mut has_unknown_active_lane = false;
        for row in rows {
            let payload = row.get::<_, PgJson<JsonValue>>("payload").0;
            let handle = payload
                .get("metadata")
                .and_then(JsonValue::as_object)
                .and_then(|metadata| metadata.get("agent"))
                .and_then(JsonValue::as_object)
                .and_then(|agent| agent.get("handle"))
                .and_then(JsonValue::as_str)
                .and_then(normalize_agent_handle);
            if let Some(handle) = handle {
                active_handles.insert(handle);
            } else {
                has_unknown_active_lane = true;
            }
        }
        let reservation_rows = transaction
            .query(
                "select request
                 from conversation_send_queue
                 where conversation_id = $1
                   and (
                     (
                       status = 'dispatched'
                       and dispatched_run_id is null
                       and dispatched_at >= now() - interval '10 minutes'
                       and ($2::uuid is null or id <> $2)
                     )
                     or ($2::uuid is null and status = 'queued')
                   )",
                &[&conversation.id, &request.dispatch_queue_entry_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to verify queued lane reservations: {error}"
                ))
            })?;
        for row in reservation_rows {
            let queued_request = row.get::<_, PgJson<JsonValue>>("request").0;
            let metadata = queued_request
                .get("metadata")
                .cloned()
                .unwrap_or_else(|| json!({}));
            active_handles.extend(extract_agent_selection_handles(&metadata));
        }
        if has_unknown_active_lane
            || requested_handles
                .iter()
                .any(|handle| active_handles.contains(handle))
        {
            return Err((
                StatusCode::CONFLICT,
                Json(ApiError::with_details(
                    "The selected agent lane became busy before this message was dispatched.",
                    "dispatch_lane_busy",
                    json!({
                        "conversationId": conversation.id,
                        "targetAgentHandles": requested_handles,
                    }),
                )),
            ));
        }
    }

    // An ambient multi-human turn dispatches to the default agent stamped with
    // the agent_evaluation marker; the agent's participation skill decides
    // whether to answer or decline via the swallowed NO_RESPONSE sentinel.
    let mut skill_mode_ambient_evaluation = false;
    let verified_custom_agent_mention =
        has_verified_custom_agent_mention(&transaction, context.user_id, &request.metadata).await?;
    let enforce_ambient_participation =
        should_enforce_ambient_group_participation(AmbientDispatchGateInput {
            intent: &request.intent,
            prompt_text: &request.prompt_text,
            metadata: &request.metadata,
            request_thread_kind: request.thread_kind.as_deref(),
            conversation_thread_kind: conversation.thread_kind.as_deref(),
            has_plan_seed: request.plan_seed.is_some(),
            has_tool_limits: request.tool_limits.is_some(),
            has_repo_request: request.repo.is_some(),
            has_preview_request: request.requested_preview == Some(true),
            execution_mode: &request.execution_mode,
            strict_browser_target: strict_browser_runtime_id.is_some(),
            authenticated_human: context.user_id.is_some() && !context.is_service_role,
            verified_custom_agent_mention,
        });
    if enforce_ambient_participation {
        let reply_targets = crate::group_participation::resolve_group_participation_reply_targets(
            &transaction,
            &conversation.id,
            &request.metadata,
        )
        .await?;
        if !reply_targets.reply_to_other_agent {
            let participation_context =
                crate::group_participation::load_group_participation_context(
                    &transaction,
                    &conversation,
                    &project,
                    context.user_id,
                )
                .await?;
            let base_participation = crate::group_participation::classify_group_participation(
                &request.prompt_text,
                participation_context.participant_count,
                false,
                reply_targets.reply_to_octo,
                reply_targets.reply_to_human,
                crate::group_participation::extract_target_message_id(Some(&request.metadata)),
                participation_context.previous_user_content.as_deref(),
            );
            let arithmetic_coverage = crate::group_participation::resolve_arithmetic_coverage(
                &base_participation,
                &participation_context,
            );
            let arithmetic_coverage = match arithmetic_coverage {
                Some(coverage)
                    if coverage.action
                        == crate::group_participation::ArithmeticCoverageAction::AwaitActiveOcto =>
                {
                    crate::group_participation::revalidate_awaited_default_octo_job(
                        &transaction,
                        &project.id,
                        &conversation.id,
                        coverage,
                    )
                    .await?
                }
                coverage => coverage,
            };
            let mut canceled_arithmetic_coverage = None;
            let mut canceled_job_input_state_updates = Vec::new();
            let mut participation = match arithmetic_coverage {
                Some(coverage)
                    if coverage.action
                        == crate::group_participation::ArithmeticCoverageAction::CancelActiveOcto =>
                {
                    if crate::group_participation::cancel_covered_default_octo_job(
                        &transaction,
                        &project.id,
                        &conversation.id,
                        coverage,
                    )
                    .await?
                    {
                        canceled_job_input_state_updates.extend(
                            crate::send_intents::reject_unacknowledged_inputs_for_job(
                                &transaction,
                                &coverage.job_id,
                                "agent job was canceled before input acknowledgement",
                            )
                            .await?,
                        );
                        canceled_arithmetic_coverage = Some(coverage);
                        crate::group_participation::apply_arithmetic_coverage(
                            base_participation,
                            coverage,
                        )
                    } else {
                        base_participation
                    }
                }
                Some(coverage) => crate::group_participation::apply_arithmetic_coverage(
                    base_participation,
                    coverage,
                ),
                None => base_participation,
            };
            // Ambient turns (reason skill_mode_ambient) dispatch as agent
            // evaluations. A managed-AI turn while managed AI is hard-disabled
            // and the sender has no credential cannot run an evaluation job;
            // that fallback records the human's chat message without dispatch
            // so it still lands instead of erroring.
            let ambient_agent_evaluation =
                participation.reason == crate::group_participation::SKILL_MODE_AMBIENT_REASON;
            let dispatch_agent_evaluation = if ambient_agent_evaluation {
                if !dispatch_requires_ai_access(&request.intent) || state.config.managed_ai_enabled
                {
                    true
                } else {
                    credentials::load_default_credential_id(&transaction, context.user_id)
                        .await?
                        .is_some()
                }
            } else {
                false
            };
            if dispatch_agent_evaluation {
                crate::group_participation::inject_skill_mode_agent_evaluation_metadata(
                    &mut request.metadata,
                );
                skill_mode_ambient_evaluation = true;
            } else {
                if ambient_agent_evaluation {
                    // Record-only fallback: stamp the controller-silent marker
                    // so idempotent retries recognize the delivered message.
                    participation.decision =
                        crate::group_participation::GroupParticipationDecision::Silent;
                }
                crate::group_participation::inject_group_participation_metadata(
                    &mut request.metadata,
                    &participation,
                );
            }
            if !dispatch_agent_evaluation
                && participation.decision
                    == crate::group_participation::GroupParticipationDecision::Silent
            {
                let (user_message, silenced_existing_message) =
                    match existing_recorded_message.as_ref() {
                        Some(existing) => {
                            let updated =
                                conversations::persist_controller_enforced_group_participation(
                                    &transaction,
                                    existing,
                                    &request.metadata,
                                )
                                .await?;
                            (None, Some(updated))
                        }
                        None => (
                            Some(
                                conversations::record_conversation_message_without_dispatch(
                                    &transaction,
                                    &project,
                                    &conversation,
                                    &request,
                                    context,
                                )
                                .await?,
                            ),
                            None,
                        ),
                    };
                transaction.commit().await.map_err(|error| {
                    internal_error(format!(
                        "failed to finalize ambient human-only message: {error}"
                    ))
                })?;
                crate::send_intents::publish_job_input_state_updates(
                    state,
                    &canceled_job_input_state_updates,
                );
                if let Some(message) = user_message.as_ref() {
                    conversations::publish_conversation_message_event(&state.events, message);
                    crate::notifications::enqueue_message_push_notifications(
                        state.clone(),
                        message.clone(),
                    );
                }
                if let Some(message) = silenced_existing_message.as_ref() {
                    // Clients already hold this row from the record path and
                    // upsert message_created events by id, so republishing the
                    // updated record delivers the controller-silenced marker.
                    // Push notifications went out when it was first recorded.
                    conversations::publish_conversation_message_event(&state.events, message);
                }
                if let Some(coverage) = canceled_arithmetic_coverage {
                    conversations::publish_job_run_cancellation_events(
                        state,
                        &mut *connection,
                        project.id,
                        conversation.id,
                        &[(coverage.job_id, coverage.run_id)],
                        crate::group_participation::HUMAN_ANSWER_CANCELLATION_REASON,
                    )
                    .await;
                    crate::send_queue::spawn_send_queue_drain(state.clone(), conversation.id);
                }
                return Ok(recorded_dispatch_response(conversation.id));
            }
        }
    }

    // Scheduled automations can explicitly opt in to the same authenticated
    // NO_RESPONSE decline protocol as ambient evaluations. Keep this outside
    // the ambient gate: automations are ordinary billed runs and must not gain
    // ambient roster or deferred-billing semantics.
    if should_mark_silent_automation_decline(
        request.allow_silent_automation_decline,
        request.thread_kind.as_deref(),
        conversation.thread_kind.as_deref(),
    ) {
        crate::group_participation::inject_automation_agent_evaluation_metadata(
            &mut request.metadata,
        );
    }

    let default_credential_id =
        credentials::load_default_credential_id(&transaction, context.user_id).await?;
    let agent_handles = extract_agent_selection_handles(&request.metadata);
    if strict_shared_browser_runtime_id.is_some() && agent_handles.len() != 1 {
        return Err(bad_request(
            "Shared Browser requests must target exactly one agent",
        ));
    }
    let mut prompt_segments =
        extract_agent_selection_prompt_segments(&request.metadata, &agent_handles);
    if has_explicit_agent_mentions(&request.metadata) {
        prompt_segments.extend(build_prompt_segments_by_handle(
            &request.prompt_text,
            &agent_handles,
        ));
    }
    let agent_targets = resolve_agent_targets(
        &transaction,
        &project.id,
        context.user_id,
        agent_handles,
        default_credential_id,
    )
    .await?;

    let mut runtime_id = request.runtime_id;
    let mut runtime_source = request.runtime_source.clone();
    let mut runtime_updated_at = request.runtime_updated_at;
    let mut runtime_display_name = request.runtime_display_name.clone();

    let allow_runtime_spread = metadata_allows_runtime_spread(&request.metadata);
    if runtime_id.is_none() && !allow_runtime_spread {
        if let Some(entry) = project_runtime_preference.as_ref() {
            if let Some(preference_id) = entry.runtime_id {
                runtime_id = Some(preference_id);
                runtime_source = entry.source.clone().or_else(|| Some("project".to_string()));
                runtime_updated_at = Some(entry.updated_at);
                if runtime_display_name.is_none() {
                    runtime_display_name = entry.display_name.clone();
                }
            }
        }
    }

    let selected_runtime_provider = ensure_runtime_target_owner(
        &state,
        &transaction,
        &project.id,
        runtime_id,
        context.user_id,
        context.is_service_role,
        metadata_uses_personal_browser(&request.metadata),
    )
    .await?;

    let prompt_id = Uuid::new_v4();
    let agent_runs: Vec<(Uuid, AgentTarget)> = agent_targets
        .into_iter()
        .map(|target| (Uuid::new_v4(), target))
        .collect();
    let agent_handles_for_scope: Vec<String> = agent_runs
        .iter()
        .map(|(_, target)| target.handle.clone())
        .collect();
    let write_scope_plan = build_agent_write_scope_plan(
        &request.metadata,
        &request.prompt_text,
        &agent_handles_for_scope,
        &prompt_segments,
    );
    let primary_run_id = agent_runs
        .first()
        .map(|(run_id, _)| *run_id)
        .unwrap_or_else(Uuid::new_v4);
    let primary_agent_metadata = agent_runs.first().map(|(_, target)| {
        json!({
            "handle": target.handle,
            "displayName": target.display_name,
            "avatarSeed": target.avatar_seed,
        })
    });

    insert_prompt_record(&transaction, &project, context, &request, &prompt_id).await?;

    for (run_id, target) in agent_runs.iter() {
        let mut run_request = request.clone();
        apply_agent_prompt_segment(&mut run_request, &prompt_segments, target);
        inject_agent_target_metadata(&mut run_request.metadata, target);
        apply_agent_write_scope_metadata(
            &mut run_request.metadata,
            write_scope_plan.get(&target.handle),
        );
        insert_run_record(&transaction, &project, &run_request, run_id, &prompt_id).await?;
    }

    let user_message_was_previously_recorded = existing_recorded_message.is_some();
    let user_message = if should_suppress_dispatch_user_message(&request.metadata) {
        None
    } else if let Some(existing) = existing_recorded_message.as_ref() {
        Some(
            conversations::attach_dispatch_to_recorded_message(
                &transaction,
                existing,
                &request,
                &prompt_id,
                &primary_run_id,
            )
            .await?,
        )
    } else {
        Some(
            conversations::record_conversation_message(
                &transaction,
                &project,
                &conversation,
                &request,
                &prompt_id,
                &primary_run_id,
                context,
            )
            .await?,
        )
    };

    let mut runtime_metadata_map = JsonMap::new();
    runtime_metadata_map.insert(
        "source".to_string(),
        JsonValue::String("dispatch_prompt".to_string()),
    );
    runtime_metadata_map.insert(
        "intent".to_string(),
        JsonValue::String(request.intent.clone()),
    );
    runtime_metadata_map.insert(
        "execution_mode".to_string(),
        JsonValue::String(request.execution_mode.clone()),
    );
    runtime_metadata_map.insert("priority".to_string(), JsonValue::from(request.priority));
    runtime_metadata_map.insert(
        "run_id".to_string(),
        JsonValue::String(primary_run_id.to_string()),
    );
    if let Some(session_raw) = request.session_raw.as_ref() {
        runtime_metadata_map.insert(
            "session_id".to_string(),
            JsonValue::String(session_raw.clone()),
        );
    }
    if let Some(preview) = request.requested_preview {
        runtime_metadata_map.insert("requested_preview".to_string(), JsonValue::Bool(preview));
    }
    if let Some(repo) = request.repo.as_ref() {
        if let Some(owner) = repo.owner.as_ref() {
            runtime_metadata_map.insert("repo_owner".to_string(), JsonValue::String(owner.clone()));
        }
        if let Some(name) = repo.name.as_ref() {
            runtime_metadata_map.insert("repo_name".to_string(), JsonValue::String(name.clone()));
        }
    }
    if let Some(conversation_id) = request.conversation_id {
        runtime_metadata_map.insert(
            "conversation_id".to_string(),
            JsonValue::String(conversation_id.to_string()),
        );
    }
    let runtime_metadata = JsonValue::Object(runtime_metadata_map);

    let runtime_idle_ttl = coerce_idle_ttl(request.idle_ttl_seconds);
    let default_provider_id = state.provider_registry.default_provider_id();
    let runtime_type = request
        .runtime_type
        .as_deref()
        .or(selected_runtime_provider.as_deref())
        .unwrap_or(default_provider_id.as_str());

    let runtime_record = if let Some(record) = strict_browser_runtime_record {
        // Exact browser targets were already validated under this transaction.
        // Re-ensuring them with the project's default provider can both mutate
        // the record and misclassify a valid self-hosted Personal runtime as an
        // unavailable Instafy Cloud runtime.
        Some(record)
    } else {
        match runtime::ensure_runtime_record(
            &transaction,
            &project.id,
            runtime_id,
            runtime_type,
            runtime_idle_ttl,
            runtime_display_name.as_deref(),
            Some(runtime_metadata),
            request.idle_ttl_seconds.is_some(),
        )
        .await
        {
            Ok(record) => Some(record),
            Err((status, Json(api_error))) => {
                warn!(
                    project_id = %project.id,
                    runtime_type,
                    status = status.as_u16(),
                    error = %api_error.message,
                    "dispatch prompt failed to ensure runtime"
                );
                None
            }
        }
    };
    if let Some(record) = runtime_record.as_ref() {
        runtime::ensure_self_hosted_runtime_access(
            &state,
            &record.provider,
            &record.capabilities,
            context.user_id,
            context.is_service_role,
        )?;
    }

    let runtime_display_name_resolved = runtime_display_name.clone().or_else(|| {
        runtime_record
            .as_ref()
            .and_then(|record| record.display_name.clone())
    });

    if let Some(runtime_value) = runtime_id {
        let updated_at_value = runtime_updated_at.unwrap_or_else(Utc::now);
        runtime_updated_at = Some(updated_at_value);
        merge_runtime_preference(
            &mut request.metadata,
            Some(runtime_value),
            runtime_source.as_deref(),
            Some(updated_at_value),
            runtime_display_name_resolved.as_deref(),
        );
        if request.prefer_runtime {
            merge_runtime_preference_option(
                &mut request.conversation_metadata,
                Some(runtime_value),
                runtime_source.as_deref(),
                Some(updated_at_value),
                runtime_display_name_resolved.as_deref(),
            );
            conversations::upsert_conversation_runtime_preference(
                &transaction,
                &conversation.id,
                &runtime_value,
                runtime_source.as_deref(),
                updated_at_value,
                runtime_display_name_resolved.as_deref(),
            )
            .await?;
        }
    }

    runtime_display_name = runtime_display_name_resolved;
    request.runtime_id = runtime_id;
    request.runtime_source = runtime_source;
    request.runtime_updated_at = runtime_updated_at;
    request.runtime_display_name = runtime_display_name.clone();

    // Terminal commands are executed directly by the selected runtime before
    // the Codex/provider lane is entered. They must remain usable when the
    // assistant is disabled or the user has not connected an AI credential,
    // and must not consume an included-AI prompt or credit.
    let uses_managed_ai = dispatch_requires_ai_access(&request.intent)
        && !context.is_service_role
        && agent_runs
            .iter()
            .any(|(_, target)| target.credential_id.is_none());

    if uses_managed_ai && skill_mode_ambient_evaluation {
        // Deferred billing: ambient evaluations are free unless the agent
        // actually speaks. The flat prompt burn (and the managedAiUsed
        // marking that feeds the daily prompt count) happens in agent_message
        // when the run's first visible assistant message persists; a declined
        // turn (NO_RESPONSE sentinel) burns nothing. The availability gate is
        // deferred with it: erroring here would reject the human's own chat
        // message, which these ambient turns must never do.
        let map = ensure_object(&mut request.metadata);
        map.insert(
            "aiAccessMode".to_string(),
            JsonValue::String("managed".to_string()),
        );
        map.insert("managedAiUsed".to_string(), JsonValue::Bool(false));
        map.insert(
            "managedAiBillingDeferred".to_string(),
            JsonValue::Bool(true),
        );
        map.insert(
            "managedAiLabel".to_string(),
            JsonValue::String(state.config.managed_ai_label.clone()),
        );
        map.insert(
            "managedAiProvider".to_string(),
            JsonValue::String(DEFAULT_MANAGED_AI_PROVIDER_ID.to_string()),
        );
        map.insert(
            "managedAiModelLabel".to_string(),
            JsonValue::String(state.config.managed_ai_model_label.clone()),
        );
        map.insert(
            "managedAiCreditBurnAmount".to_string(),
            JsonValue::from(state.config.managed_ai_credit_burn_amount),
        );
    } else if uses_managed_ai {
        let proxy_requirements = if let Some(proxy_base_url) = state.config.proxy_base_url.as_ref()
        {
            credentials::fetch_proxy_credential_requirements(
                &state.http_client,
                proxy_base_url,
                Duration::from_secs(2),
            )
            .await
        } else {
            credentials::ProxyCredentialRequirements {
                requires_user_credentials: true,
                proxy_backend: "disabled".to_string(),
                error: None,
            }
        };
        if state.config.proxy_base_url.is_some() {
            if let Some(error_message) = proxy_requirements
                .error
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                if let Err(report_error) = record_system_bug_report(
                    state,
                    SystemBugReportInput {
                        message: "Managed AI proxy credential check failed".to_string(),
                        details: Some(error_message.to_string()),
                        project_id: Some(project.id),
                        runtime_id,
                        run_id: None,
                        conversation_id: Some(conversation.id),
                        priority: "high".to_string(),
                        labels: vec![
                            "managed-ai".to_string(),
                            "proxy".to_string(),
                            "monitoring".to_string(),
                        ],
                        metadata: json!({
                            "source": "dispatch.managed_ai",
                            "promptId": prompt_id,
                            "proxyBackend": proxy_requirements.proxy_backend,
                        }),
                        logs: json!([
                            {
                                "kind": "managed_ai.proxy.credential_check_failed",
                                "error": error_message,
                            }
                        ]),
                        fingerprint: Some("managed_ai.proxy.credential_check".to_string()),
                        dedupe_window_seconds: Some(15 * 60),
                    },
                )
                .await
                {
                    warn!(
                        %report_error,
                        "failed to record managed AI proxy credential check issue"
                    );
                }
            }
        }
        let daily_prompts_used = credentials::count_recent_managed_ai_prompts(
            &transaction,
            context.user_id,
            Utc::now() - ChronoDuration::hours(24),
        )
        .await?;
        let managed_ai = credentials::build_managed_ai_access_response(
            &state.config,
            &proxy_requirements,
            default_credential_id.is_some(),
            daily_prompts_used,
        );

        if !managed_ai.available {
            return Err(bad_request(managed_ai_gate_message(&managed_ai)));
        }

        let org_id = project
            .org_id
            .ok_or_else(|| internal_error("managed AI requires project organization"))?;
        let mut credit_burn_metadata = json!({
            "source": "managed_ai",
            "promptId": prompt_id,
            "proxyBackend": proxy_requirements.proxy_backend,
            "dailyPromptsUsedBeforeBurn": daily_prompts_used,
            "managedAiLabel": managed_ai.label,
            "managedAiProvider": DEFAULT_MANAGED_AI_PROVIDER_ID,
            "managedAiModelLabel": state.config.managed_ai_model_label,
        });
        let credit_snapshot = credits::process_credit_burn(
            &transaction,
            &project.id,
            &org_id,
            runtime_id,
            state.config.managed_ai_credit_burn_amount,
            "managed_ai_prompt",
            Some(&format!("managed-ai-prompt:{prompt_id}")),
            &mut credit_burn_metadata,
        )
        .await?;
        let reserve_idempotency_key = format!("managed-ai-prompt:{prompt_id}");
        let managed_ai_credit_trace = match build_managed_ai_reserve_trace(
            &transaction,
            &org_id,
            &project.id,
            &prompt_id,
            state.config.managed_ai_credit_burn_amount,
        )
        .await
        {
            Ok(trace) => trace,
            Err((status, Json(api_error))) => {
                warn!(
                    project_id = %project.id,
                    prompt_id = %prompt_id,
                    status = status.as_u16(),
                    error = %api_error.message,
                    "failed to resolve managed AI reserve ledger trace"
                );
                json!({
                    "promptId": prompt_id,
                    "reserve": {
                        "ledgerId": JsonValue::Null,
                        "idempotencyKey": reserve_idempotency_key,
                        "reason": "managed_ai_prompt",
                        "delta": -(state.config.managed_ai_credit_burn_amount.abs()),
                    }
                })
            }
        };

        let map = ensure_object(&mut request.metadata);
        map.insert("managedAiUsed".to_string(), JsonValue::Bool(true));
        map.insert(
            "aiAccessMode".to_string(),
            JsonValue::String("managed".to_string()),
        );
        map.insert(
            "managedAiLabel".to_string(),
            JsonValue::String(managed_ai.label.clone()),
        );
        map.insert(
            "managedAiProvider".to_string(),
            JsonValue::String(DEFAULT_MANAGED_AI_PROVIDER_ID.to_string()),
        );
        map.insert(
            "managedAiModelLabel".to_string(),
            JsonValue::String(state.config.managed_ai_model_label.clone()),
        );
        map.insert(
            "managedAiCreditBurnAmount".to_string(),
            JsonValue::from(state.config.managed_ai_credit_burn_amount),
        );
        map.insert(
            "managedAiDailyPromptLimit".to_string(),
            JsonValue::from(state.config.managed_ai_daily_prompt_limit),
        );
        map.insert(
            "managedAiDailyPromptsUsedBeforeBurn".to_string(),
            JsonValue::from(daily_prompts_used),
        );
        map.insert(
            "creditSnapshot".to_string(),
            json!({
                "balance": credit_snapshot.balance,
                "creditLimit": credit_snapshot.credit_limit,
                "lastBurnAt": credit_snapshot.last_burn_at.map(|value| value.to_rfc3339()),
                "lastRefillAt": credit_snapshot.last_refill_at.map(|value| value.to_rfc3339()),
            }),
        );
        map.insert(
            "managedAiCredit".to_string(),
            managed_ai_credit_trace.clone(),
        );
        let run_ids: Vec<Uuid> = agent_runs.iter().map(|(run_id, _)| *run_id).collect();
        if let Err((status, Json(api_error))) =
            persist_run_managed_ai_credit_metadata(&transaction, &run_ids, &managed_ai_credit_trace)
                .await
        {
            warn!(
                project_id = %project.id,
                prompt_id = %prompt_id,
                status = status.as_u16(),
                error = %api_error.message,
                "failed to persist managed AI credit trace onto queued runs"
            );
        }
    } else {
        let map = ensure_object(&mut request.metadata);
        map.insert(
            "aiAccessMode".to_string(),
            JsonValue::String("byoc".to_string()),
        );
        map.insert("managedAiUsed".to_string(), JsonValue::Bool(false));
    }

    // Runs are inserted before runtime allocation and AI access selection so a
    // failed allocation still has a durable run to report. Persist the
    // authoritative access decision after selection as a separate step; do not
    // trust similarly named client metadata for billing or audit assertions.
    let run_ids: Vec<Uuid> = agent_runs.iter().map(|(run_id, _)| *run_id).collect();
    // Deferred skill-mode evaluations audit as managed access without a usage
    // mark: managedAiUsed flips to true (and the burn lands) only when the
    // run's first visible assistant message persists.
    let managed_ai_used_at_dispatch = uses_managed_ai && !skill_mode_ambient_evaluation;
    persist_prompt_ai_access_metadata(
        &transaction,
        &prompt_id,
        uses_managed_ai,
        managed_ai_used_at_dispatch,
    )
    .await?;
    persist_run_ai_access_metadata(
        &transaction,
        &run_ids,
        uses_managed_ai,
        managed_ai_used_at_dispatch,
    )
    .await?;

    let supports_provider_state = runtime_record
        .as_ref()
        .map(|record| {
            runtime::runtime_supports_conversation_state(&record.capabilities)
                && runtime::runtime_supports_agent_and_origin(&record.capabilities)
        })
        .unwrap_or(false);

    let mut job_ids: Vec<Uuid> = Vec::new();
    let mut primary_job_id: Option<Uuid> = None;
    let mut dispatches: Vec<(Uuid, Option<Uuid>, Option<JsonValue>, Option<JsonValue>)> =
        Vec::new();

    // Evaluation dispatches carry the full AI-participant roster so each
    // agent's delivered turn can name the peers that are also evaluating it
    // (the wrapper excludes the agent itself). Job-payload-only: the persisted
    // human message keeps only the server-authored participation marker.
    let ambient_ai_participants = skill_mode_ambient_evaluation
        .then(|| build_ambient_ai_participants(&agent_runs))
        .filter(|value| value.as_array().is_some_and(|list| !list.is_empty()));

    for (run_id, target) in agent_runs.iter() {
        let mut agent_request = request.clone();
        apply_agent_prompt_segment(&mut agent_request, &prompt_segments, target);
        inject_agent_target_metadata(&mut agent_request.metadata, target);
        apply_agent_write_scope_metadata(
            &mut agent_request.metadata,
            write_scope_plan.get(&target.handle),
        );
        if skill_mode_ambient_evaluation {
            let map = ensure_object(&mut agent_request.metadata);
            if let Some(participants) = ambient_ai_participants.as_ref() {
                map.insert("groupAiParticipants".to_string(), participants.clone());
            }
            // A BYOC evaluation job has no flat managed-AI burn to defer: its
            // upstream usage bills to the user's own credential. The deferral
            // markers were stamped on the shared dispatch metadata for the
            // managed participants, so override them per credentialed job or
            // a custom agent's first visible message would burn a managed
            // prompt it never used.
            if target.credential_id.is_some() {
                map.insert(
                    "aiAccessMode".to_string(),
                    JsonValue::String("byoc".to_string()),
                );
                map.insert("managedAiUsed".to_string(), JsonValue::Bool(false));
                map.insert(
                    "managedAiBillingDeferred".to_string(),
                    JsonValue::Bool(false),
                );
            }
        }
        if let Some(scope) = write_scope_plan.get(&target.handle) {
            if scope.is_coordination_required() {
                warn!(
                    project_id = %project.id,
                    run_id = %run_id,
                    agent_handle = %target.handle,
                    rationale = %scope.rationale(),
                    "queued multi-agent job requires write-scope coordination"
                );
            }
        }
        let provider_conversation_state = if supports_provider_state {
            if let Some(conversation_id) = request.conversation_id {
                let expected_provider =
                    load_target_credential_provider(&transaction, target.credential_id).await?;
                load_previous_provider_conversation_state(
                    &transaction,
                    &conversation_id,
                    expected_provider.as_deref(),
                    target.agent_id.as_ref(),
                    Some(target.handle.as_str()),
                )
                .await?
            } else {
                None
            }
        } else {
            None
        };
        let target_runtime_id =
            target_runtime_for_agent_job(&agent_request.metadata, target.runtime_id, runtime_id);
        ensure_runtime_target_owner(
            &state,
            &transaction,
            &project.id,
            target_runtime_id,
            context.user_id,
            context.is_service_role,
            metadata_uses_personal_browser(&agent_request.metadata),
        )
        .await?;
        let job_id = agent::enqueue_agent_job_record(
            &transaction,
            &project,
            context,
            &agent_request,
            run_id,
            &prompt_id,
            target_runtime_id,
            target.credential_id,
            provider_conversation_state.as_ref(),
        )
        .await?;
        if let Some(job_uuid) = job_id {
            // The run is the frontend's authoritative live-activity record,
            // while the job is the controller's exact steer CAS target. Keep
            // that one-to-one identity durable in the same transaction as the
            // enqueue so initial hydration and reconnect cannot lose it.
            persist_run_job_identity(&transaction, &project.id, run_id, &job_uuid).await?;
        }
        dispatches.push((
            *run_id,
            job_id,
            write_scope_plan
                .get(&target.handle)
                .map(AgentWriteScopeAssignment::to_json),
            agent_request
                .metadata
                .get("multiAgentPlan")
                .or_else(|| agent_request.metadata.get("multi_agent_plan"))
                .cloned(),
        ));
        if let Some(job_uuid) = job_id {
            if primary_job_id.is_none() {
                primary_job_id = Some(job_uuid);
            }
            job_ids.push(job_uuid);
        }
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit dispatch prompt: {error}")))?;

    if let Some(user_message) = user_message.as_ref() {
        conversations::publish_conversation_message_event(&state.events, user_message);
        // A reused record-then-dispatch row already sent push notifications
        // when it was first recorded; republishing the event alone lets
        // clients upsert the run linkage by message id.
        if !user_message_was_previously_recorded {
            crate::notifications::enqueue_message_push_notifications(
                state.clone(),
                user_message.clone(),
            );
        }
    }

    let mut primary_event_session = request.session_id;
    let mut primary_event_conversation = request.conversation_id;

    for (run_id, job_id, write_scope, multi_agent_plan) in dispatches.iter() {
        let (event_session, event_conversation, run_payload) =
            match runs::load_run_snapshot(&mut *connection, run_id).await {
                Ok(Some(snapshot)) => {
                    let session = snapshot.session_id.or(request.session_id);
                    let conversation = snapshot.conversation_id.or(request.conversation_id);
                    let run_json = runs::run_snapshot_to_json(&snapshot);
                    (session, conversation, run_json)
                }
                Ok(None) => {
                    warn!(run_id = %run_id, "run snapshot missing after dispatch_prompt commit");
                    (request.session_id, request.conversation_id, JsonValue::Null)
                }
                Err((status, Json(api_error))) => {
                    warn!(
                        run_id = %run_id,
                        status = status.as_u16(),
                        error = %api_error.message,
                        "failed to load run snapshot after dispatch"
                    );
                    (request.session_id, request.conversation_id, JsonValue::Null)
                }
            };

        if *run_id == primary_run_id {
            primary_event_session = event_session;
            primary_event_conversation = event_conversation;
        }

        publish_controller_event_with_conversation(
            &state.events,
            "run.queued",
            Some(project.id),
            event_session,
            event_conversation,
            Some(*run_id),
            *job_id,
            json!({
                "status": "queued",
                "promptId": prompt_id,
                "jobId": job_id,
                "writeScope": write_scope,
                "multiAgentPlan": multi_agent_plan,
                "run": run_payload,
            }),
        );
    }

    if request.conversation_is_new {
        let conversation_metadata = conversation
            .metadata
            .clone()
            .unwrap_or_else(|| JsonValue::Object(serde_json::Map::new()));
        publish_controller_event_with_conversation(
            &state.events,
            "conversation.created",
            Some(project.id),
            conversation.session_id.or(primary_event_session),
            Some(conversation.id),
            Some(primary_run_id),
            None,
            json!({
                "conversationId": conversation.id,
                "runId": primary_run_id,
                "promptId": prompt_id,
                "projectId": project.id,
                "sessionId": conversation.session_id,
                "createdBy": conversation.created_by,
                "metadata": conversation_metadata,
                "visibility": conversation.visibility,
                "parentConversationId": conversation.parent_conversation_id,
                "rootConversationId": conversation.root_conversation_id,
                "threadKind": conversation.thread_kind,
                "lastMessageId": conversation.last_message_id,
                "lastMessageAt": conversation.last_message_at.map(|value| value.to_rfc3339()),
                "lastMessagePreview": conversation.last_message_preview,
                "createdAt": conversation.created_at.to_rfc3339(),
                "updatedAt": conversation.updated_at.to_rfc3339(),
            }),
        );
    }

    let mut runtime_alert_reason: Option<&'static str> = None;
    let mut runtime_alert_detail: Option<String> = None;

    if let Some(record) = runtime_record.as_ref() {
        match workspace::fetch_runtime_candidate_with_client(&*connection, &project.id, &record.id)
            .await
        {
            Ok(candidate_opt) => {
                let status_viable = matches!(record.status.as_str(), "ready" | "running");
                let candidate_recent_strict = candidate_opt
                    .as_ref()
                    .map(|candidate| {
                        candidate
                            .last_seen_at
                            .map(|last_seen| {
                                Utc::now().signed_duration_since(last_seen).num_seconds() <= 90
                            })
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                if !(status_viable && candidate_recent_strict) {
                    runtime_alert_reason = Some("runtime_not_ready");
                    let mut detail_parts = Vec::new();
                    detail_parts.push(format!("status={}", record.status));
                    if let Some(candidate) = candidate_opt.as_ref() {
                        let last_seen = candidate
                            .last_seen_at
                            .map(|value| value.to_rfc3339())
                            .unwrap_or_else(|| "unknown".to_string());
                        detail_parts.push(format!("lastSeen={}", last_seen));
                    }
                    runtime_alert_detail = Some(detail_parts.join(", "));
                } else if !runtime::runtime_supports_agent_and_origin(&record.capabilities) {
                    runtime_alert_reason = Some("runtime_not_ready");
                    runtime_alert_detail = Some("agent/origin capabilities missing".to_string());
                }
            }
            Err((status, Json(api_error))) => {
                warn!(
                    project_id = %project.id,
                    run_id = %primary_run_id,
                    status = status.as_u16(),
                    error = %api_error.message,
                    "dispatch prompt could not inspect runtime availability"
                );
                runtime_alert_reason = Some("runtime_inspection_failed");
                runtime_alert_detail = Some(format!(
                    "status={}, error={}",
                    status.as_u16(),
                    api_error.message
                ));
            }
        }
    } else {
        runtime_alert_reason = Some("runtime_unavailable");
    }

    if let Some(reason) = runtime_alert_reason {
        let detail_message = runtime_alert_detail
            .as_deref()
            .filter(|value| !value.is_empty());
        let mut retargeted_job_ids: Vec<Uuid> = Vec::new();
        let mut cleared_runtime_preference = false;
        let mut reconnect_metadata: Option<JsonValue> = None;
        if should_retarget_unavailable_runtime(reason, strict_browser_runtime_id) {
            if let Some(target_runtime_id) = runtime_id {
                for job_id in &job_ids {
                    match connection
                        .query_opt(
                            "update agent_jobs
                             set target_runtime_id = null,
                                 updated_at = now()
                             where id = $1
                               and project_id = $2
                               and status = 'queued'
                               and target_runtime_id = $3
                             returning id",
                            &[job_id, &project.id, &target_runtime_id],
                        )
                        .await
                    {
                        Ok(Some(row)) => retargeted_job_ids.push(row.get::<_, Uuid>("id")),
                        Ok(None) => {}
                        Err(error) => {
                            warn!(
                                project_id = %project.id,
                                run_id = %primary_run_id,
                                job_id = %job_id,
                                runtime_id = %target_runtime_id,
                                %error,
                                "dispatch prompt failed to unpin queued job runtime target"
                            );
                        }
                    }
                }

                let should_clear_preference = reason == "runtime_unavailable"
                    || (reason == "runtime_not_ready"
                        && detail_message
                            .map(|detail| {
                                detail.contains("status=requested")
                                    && detail.contains("lastSeen=unknown")
                            })
                            .unwrap_or(false));
                if should_clear_preference
                    && project_runtime_preference
                        .as_ref()
                        .and_then(|entry| entry.runtime_id)
                        == Some(target_runtime_id)
                {
                    if let Some(user_id) = runtime_preference_target_user {
                        state
                            .runtime_preferences
                            .clear_private(&project.id, &user_id)
                            .await;
                    } else {
                        state.runtime_preferences.clear(&project.id).await;
                    }
                    let preference_event = json!({
                        "runtimeId": JsonValue::Null,
                        "source": "auto_clear_unavailable",
                        "updatedAt": Utc::now().to_rfc3339(),
                        "displayName": JsonValue::Null,
                    });
                    if let Some(target_user_id) = runtime_preference_target_user {
                        publish_controller_event_to_user(
                            &state.events,
                            "runtime.preference_updated",
                            Some(project.id),
                            target_user_id,
                            preference_event,
                        );
                    } else {
                        publish_controller_event(
                            &state.events,
                            "runtime.preference_updated",
                            Some(project.id),
                            None,
                            None,
                            None,
                            preference_event,
                        );
                    }
                    cleared_runtime_preference = true;
                }
            }

            if let Some(record) = runtime_record.as_ref() {
                let force_new_lease = reason == "runtime_not_ready"
                    && detail_message
                        .map(|detail| {
                            detail.contains("lastSeen=") && !detail.contains("lastSeen=unknown")
                        })
                        .unwrap_or(false);
                // Reconnect owns its database lifecycle and may wait on a
                // provider. Do not pin the dispatch connection while it runs.
                drop(connection);
                let reconnect_result = runtime::ensure_runtime_for_dispatch_reconnect(
                    state,
                    record,
                    "dispatch_runtime_alert",
                    force_new_lease,
                )
                .await;
                connection = state.pool.get().await.map_err(|error| {
                    internal_error(format!("failed to get connection: {error}"))
                })?;
                match reconnect_result {
                    Ok(response) => {
                        reconnect_metadata = Some(json!({
                            "status": "requested",
                            "runtimeId": response.runtime_id,
                            "leaseId": response.lease_id,
                            "provider": response.provider,
                            "forceNewLease": force_new_lease,
                        }));
                    }
                    Err((status, Json(api_error))) => {
                        warn!(
                            project_id = %project.id,
                            run_id = %primary_run_id,
                            runtime_id = %record.id,
                            status = status.as_u16(),
                            error = %api_error.message,
                            "dispatch prompt failed to reconnect unavailable runtime"
                        );
                        reconnect_metadata = Some(json!({
                            "status": "failed",
                            "runtimeId": record.id.to_string(),
                            "error": api_error.message,
                        }));
                    }
                }
            }
        }

        let persist_runtime_alert_message = should_persist_runtime_alert_conversation_message(
            reason,
            detail_message,
            reconnect_metadata.as_ref(),
        );
        let fallback_message =
            runtime_alert_fallback_message(reason, persist_runtime_alert_message);
        let message = fallback_message;
        warn!(
            project_id = %project.id,
            run_id = %primary_run_id,
            reason,
            detail = detail_message.unwrap_or("n/a"),
            "dispatch prompt queued but runtime is unavailable"
        );
        let mut runtime_alert_metadata = json!({
            "reason": reason,
            "message": message,
            "updatedAt": Utc::now().to_rfc3339(),
        });
        if let Some(extra) = detail_message {
            if let Some(map) = runtime_alert_metadata.as_object_mut() {
                map.insert("detail".to_string(), JsonValue::String(extra.to_string()));
            }
        }
        if !retargeted_job_ids.is_empty() {
            let ids: Vec<String> = retargeted_job_ids
                .iter()
                .map(|job_id| job_id.to_string())
                .collect();
            if let Some(map) = runtime_alert_metadata.as_object_mut() {
                map.insert("retargetedJobIds".to_string(), json!(ids));
            }
        }
        if cleared_runtime_preference {
            if let Some(map) = runtime_alert_metadata.as_object_mut() {
                map.insert(
                    "clearedRuntimePreference".to_string(),
                    JsonValue::Bool(true),
                );
            }
        }
        if let Some(reconnect) = reconnect_metadata.clone() {
            if let Some(map) = runtime_alert_metadata.as_object_mut() {
                map.insert("reconnect".to_string(), reconnect);
            }
        }
        let queued_run_ids: Vec<Uuid> = agent_runs.iter().map(|(run_id, _)| *run_id).collect();
        if let Err(error) = persist_run_runtime_alert_metadata(
            &mut connection,
            &project.id,
            &queued_run_ids,
            &runtime_alert_metadata,
        )
        .await
        {
            warn!(
                project_id = %project.id,
                run_id = %primary_run_id,
                ?error,
                "failed to persist runtime alert metadata onto queued runs"
            );
        }
        let mut payload = json!({
            "reason": reason,
            "message": message,
            "runId": primary_run_id,
            "jobId": primary_job_id,
        });
        if let Some(extra) = detail_message {
            if let Some(map) = payload.as_object_mut() {
                map.insert("detail".to_string(), JsonValue::String(extra.to_string()));
            }
        }
        if !retargeted_job_ids.is_empty() {
            let ids: Vec<String> = retargeted_job_ids
                .iter()
                .map(|job_id| job_id.to_string())
                .collect();
            if let Some(map) = payload.as_object_mut() {
                map.insert("retargetedJobIds".to_string(), json!(ids));
            }
            warn!(
                project_id = %project.id,
                run_id = %primary_run_id,
                runtime_id = ?runtime_id,
                retargeted_job_count = retargeted_job_ids.len(),
                retargeted_job_ids = ?retargeted_job_ids,
                "dispatch prompt unpinned queued jobs from unavailable runtime target"
            );
        }
        if cleared_runtime_preference {
            if let Some(map) = payload.as_object_mut() {
                map.insert(
                    "clearedRuntimePreference".to_string(),
                    JsonValue::Bool(true),
                );
            }
        }
        if let Some(reconnect) = reconnect_metadata {
            if let Some(map) = payload.as_object_mut() {
                map.insert("reconnect".to_string(), reconnect);
            }
        }
        publish_controller_event_with_conversation(
            &state.events,
            "runtime.unavailable",
            Some(project.id),
            primary_event_session,
            primary_event_conversation,
            Some(primary_run_id),
            primary_job_id,
            payload,
        );
        if persist_runtime_alert_message {
            if let Some(conversation_id) = request.conversation_id {
                let controller_message_metadata = build_runtime_alert_conversation_metadata(
                    runtime_alert_metadata,
                    primary_agent_metadata,
                );
                let controller_message = match connection.transaction().await {
                    Ok(transaction) => {
                        let inserted = conversations::record_controller_assistant_message(
                            &transaction,
                            &project.id,
                            &conversation_id,
                            primary_event_session,
                            Some(prompt_id),
                            Some(primary_run_id),
                            message,
                            &controller_message_metadata,
                        )
                        .await;
                        match inserted {
                            Ok(message_row) => {
                                if let Err(error) = transaction.commit().await {
                                    warn!(
                                        project_id = %project.id,
                                        conversation_id = %conversation_id,
                                        run_id = %primary_run_id,
                                        %error,
                                        "failed to commit runtime alert conversation message"
                                    );
                                    None
                                } else {
                                    Some(message_row)
                                }
                            }
                            Err((status, Json(api_error))) => {
                                warn!(
                                    project_id = %project.id,
                                    conversation_id = %conversation_id,
                                    run_id = %primary_run_id,
                                    status = status.as_u16(),
                                    error = %api_error.message,
                                    "failed to persist runtime alert conversation message"
                                );
                                let _ = transaction.rollback().await;
                                None
                            }
                        }
                    }
                    Err(error) => {
                        warn!(
                            project_id = %project.id,
                            conversation_id = %conversation_id,
                            run_id = %primary_run_id,
                            %error,
                            "failed to start runtime alert conversation message transaction"
                        );
                        None
                    }
                };
                if let Some(message_row) = controller_message.as_ref() {
                    conversations::publish_conversation_message_event(&state.events, message_row);
                    crate::notifications::enqueue_message_push_notifications(
                        state.clone(),
                        message_row.clone(),
                    );
                }
            }
        }
    }

    info!(
        run_id = %primary_run_id,
        project_id = %project.id,
        job_id = ?primary_job_id,
        "dispatch prompt enqueued"
    );

    Ok(DispatchPromptResponse {
        run_id: Some(primary_run_id),
        run_ids: if agent_runs.len() > 1 {
            Some(agent_runs.iter().map(|(run_id, _)| *run_id).collect())
        } else {
            None
        },
        prompt_id: Some(prompt_id),
        job_id: primary_job_id,
        job_ids: if job_ids.len() > 1 {
            Some(job_ids)
        } else {
            None
        },
        status: "queued".to_string(),
        conversation_id: request.conversation_id,
    })
}

pub(crate) fn normalize_dispatch_request(
    payload: DispatchPromptRequest,
) -> Result<DispatchPromptNormalized, (StatusCode, Json<ApiError>)> {
    let project_id_str = payload
        .project_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_request("projectId is required"))?;
    let project_id = Uuid::from_str(&project_id_str)
        .map_err(|_| bad_request("projectId must be a valid UUID"))?;

    let prompt_text = payload
        .prompt_text
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_request("promptText is required"))?;

    let session_raw = payload
        .session_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let session_id = session_raw
        .as_ref()
        .and_then(|value| Uuid::from_str(value).ok());

    let conversation_raw = payload
        .conversation_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let conversation_id = conversation_raw
        .as_ref()
        .and_then(|value| Uuid::from_str(value).ok());
    let conversation_metadata = payload.conversation_metadata.and_then(|value| match value {
        JsonValue::Object(_) => Some(value),
        _ => None,
    });

    let parent_conversation_id = payload
        .parent_conversation_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            Uuid::from_str(value)
                .map_err(|_| bad_request("parentConversationId must be a valid UUID"))
        })
        .transpose()?;

    let thread_kind = payload
        .thread_kind
        .as_deref()
        .and_then(conversations::normalize_thread_kind);

    let intent = payload
        .intent
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_PROMPT_INTENT.to_string());

    let (metadata, execution_mode, workspace_mode) =
        normalize_metadata(payload.metadata, session_raw.as_ref());
    let project_type_hint = metadata
        .as_object()
        .and_then(|map| map.get("project_type"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());

    let tool_limits = normalize_tool_limits(payload.tool_limits);
    let repo = normalize_repo(payload.repo);
    let requested_preview = payload.ui.and_then(|ui| ui.requested_preview);

    let priority_candidate = payload.priority.unwrap_or(DEFAULT_PROMPT_PRIORITY);
    let priority = priority_candidate.clamp(1, 1000);

    let runtime_type = payload
        .runtime_type
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let runtime_id_raw = payload
        .runtime_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let runtime_display_name = payload
        .runtime_display_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let (runtime_id, runtime_source, runtime_updated_at) = match runtime_id_raw {
        Some(value) => {
            let parsed = Uuid::from_str(&value)
                .map_err(|_| bad_request("runtimeId must be a valid UUID"))?;
            (
                Some(parsed),
                Some("conversation".to_string()),
                Some(Utc::now()),
            )
        }
        None => (None, None, None),
    };

    let prefer_runtime = payload.prefer_runtime.unwrap_or(runtime_id.is_some());

    Ok(DispatchPromptNormalized {
        project_id,
        session_id,
        session_raw,
        conversation_id,
        conversation_raw,
        conversation_metadata,
        parent_conversation_id,
        thread_kind,
        conversation_is_new: false,
        prompt_text,
        intent,
        plan_seed: payload.plan_seed,
        metadata,
        tool_limits,
        repo,
        requested_preview,
        priority,
        runtime_type,
        idle_ttl_seconds: payload.idle_ttl_seconds,
        project_type_hint,
        execution_mode,
        workspace_mode,
        runtime_id,
        runtime_source,
        runtime_updated_at,
        runtime_display_name,
        prefer_runtime,
        expected_lane_idle: false,
        dispatch_queue_entry_id: None,
        allow_silent_automation_decline: false,
    })
}

async fn insert_prompt_record(
    transaction: &Transaction<'_>,
    project: &ProjectRecord,
    context: &RequestContext,
    request: &DispatchPromptNormalized,
    prompt_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let plan_seed_param = request.plan_seed.as_ref().map(|value| PgJson(value));
    let metadata_param = PgJson(&request.metadata);

    transaction
        .execute(
            "insert into prompts (
                 id,
                 project_id,
                 session_id,
                 conversation_id,
                 user_id,
                 intent,
                 prompt_text,
                 plan_seed,
                 metadata
             ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)",
            &[
                prompt_id,
                &project.id,
                &request.session_id,
                &request.conversation_id,
                &context.user_id,
                &request.intent,
                &request.prompt_text,
                &plan_seed_param,
                &metadata_param,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert prompt: {error}")))?;

    Ok(())
}

async fn insert_run_record(
    transaction: &Transaction<'_>,
    project: &ProjectRecord,
    request: &DispatchPromptNormalized,
    run_id: &Uuid,
    prompt_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let metadata_param = PgJson(&request.metadata);
    let run_type = "prompt";
    let status = "queued";
    let progress_stage = "agent:queued";
    transaction
        .execute(
            "insert into runs (
                 id,
                 project_id,
                 session_id,
                 conversation_id,
                 prompt_id,
                 run_type,
                 status,
                 progress,
                 progress_stage,
                 metadata
             ) values ($1, $2, $3, $4, $5, $6, $7, 0, $8, $9::jsonb)",
            &[
                &run_id,
                &project.id,
                &request.session_id,
                &request.conversation_id,
                prompt_id,
                &run_type,
                &status,
                &progress_stage,
                &metadata_param,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert run: {error}")))?;

    Ok(())
}

pub(crate) fn build_run_result_payload(
    job_id: &Uuid,
    run_id: &Uuid,
    project_id: &Uuid,
    conversation_id: Option<Uuid>,
    session_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    summary: Option<&String>,
    error_message: Option<&String>,
    outcome: &str,
    run_status: &str,
    final_status: &str,
    provider: Option<&str>,
    conversation_state: Option<&JsonValue>,
    artifacts: &JsonValue,
    credit_snapshot: Option<&JsonValue>,
) -> JsonValue {
    let mut map = JsonMap::new();
    map.insert("jobId".to_string(), JsonValue::String(job_id.to_string()));
    map.insert("runId".to_string(), JsonValue::String(run_id.to_string()));
    map.insert(
        "projectId".to_string(),
        JsonValue::String(project_id.to_string()),
    );
    if let Some(conversation) = conversation_id {
        map.insert(
            "conversationId".to_string(),
            JsonValue::String(conversation.to_string()),
        );
    }
    if let Some(session) = session_id {
        map.insert(
            "sessionId".to_string(),
            JsonValue::String(session.to_string()),
        );
    }
    if let Some(prompt) = prompt_id {
        map.insert(
            "promptId".to_string(),
            JsonValue::String(prompt.to_string()),
        );
    }
    if let Some(value) = summary {
        map.insert("summary".to_string(), JsonValue::String(value.clone()));
    }
    if let Some(value) = error_message {
        map.insert("errorMessage".to_string(), JsonValue::String(value.clone()));
    }
    map.insert(
        "outcome".to_string(),
        JsonValue::String(outcome.to_string()),
    );
    map.insert(
        "runStatus".to_string(),
        JsonValue::String(run_status.to_string()),
    );
    map.insert(
        "status".to_string(),
        JsonValue::String(final_status.to_string()),
    );
    if let Some(value) = provider {
        map.insert("provider".to_string(), JsonValue::String(value.to_string()));
    }
    if let Some(state) = conversation_state {
        map.insert("conversationState".to_string(), state.clone());
    }
    map.insert("artifacts".to_string(), artifacts.clone());
    if let Some(snapshot) = credit_snapshot {
        map.insert("creditSnapshot".to_string(), snapshot.clone());
    }
    map.insert(
        "timestamp".to_string(),
        JsonValue::String(Utc::now().to_rfc3339()),
    );

    JsonValue::Object(map)
}

fn normalize_metadata(
    metadata: Option<JsonValue>,
    session_id: Option<&String>,
) -> (JsonValue, String, String) {
    let mut map = match metadata {
        Some(JsonValue::Object(map)) => map,
        _ => JsonMap::new(),
    };

    let execution_mode_raw = map
        .get("execution_mode")
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_lowercase());

    let execution_mode = match execution_mode_raw.as_deref() {
        Some("approval_required") => EXECUTION_MODE_APPROVAL,
        Some("plan_only") => EXECUTION_MODE_PLAN_ONLY,
        Some("apply") => EXECUTION_MODE_APPLY,
        _ => EXECUTION_MODE_APPLY,
    };
    let write_intent = if execution_mode == EXECUTION_MODE_PLAN_ONLY {
        false
    } else {
        resolve_structured_write_intent(&map)
    };
    let workspace_mode = resolve_workspace_mode(&map, execution_mode);

    map.insert(
        "execution_mode".to_string(),
        JsonValue::String(execution_mode.to_string()),
    );
    map.insert(
        "executionMode".to_string(),
        JsonValue::String(workspace_mode.clone()),
    );
    map.insert(
        "workspaceMode".to_string(),
        JsonValue::String(workspace_mode.clone()),
    );
    map.insert("writeIntent".to_string(), JsonValue::Bool(write_intent));

    let session_value = session_id
        .filter(|value| !value.is_empty())
        .map(|value| JsonValue::String(value.clone()))
        .unwrap_or(JsonValue::Null);
    map.insert("session_id".to_string(), session_value);

    (
        JsonValue::Object(map),
        execution_mode.to_string(),
        workspace_mode,
    )
}

fn resolve_structured_write_intent(metadata: &JsonMap<String, JsonValue>) -> bool {
    first_runtime_bool(metadata, &["writeIntent", "write_intent"])
        .or_else(|| {
            runtime_expectation_bool(
                metadata,
                &["workspaceFileChanges", "workspace_file_changes"],
            )
        })
        .unwrap_or(false)
}

fn runtime_expectation_bool(
    metadata: &JsonMap<String, JsonValue>,
    expectation_keys: &[&str],
) -> Option<bool> {
    ["runtimeExpectations", "runtime_expectations"]
        .iter()
        .filter_map(|key| metadata.get(*key).and_then(JsonValue::as_object))
        .find_map(|expectations| first_runtime_bool(expectations, expectation_keys))
}

fn first_runtime_bool(map: &JsonMap<String, JsonValue>, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| map.get(*key).and_then(parse_runtime_bool))
}

fn parse_runtime_bool(value: &JsonValue) -> Option<bool> {
    match value {
        JsonValue::Bool(value) => Some(*value),
        JsonValue::Number(value) => value.as_i64().map(|number| number != 0),
        JsonValue::String(value) => match value.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" | "required" | "require" => Some(true),
            "0" | "false" | "no" | "off" | "none" | "optional" | "disabled" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn resolve_workspace_mode(metadata: &JsonMap<String, JsonValue>, execution_mode: &str) -> String {
    let explicit = metadata
        .get("workspaceMode")
        .or_else(|| metadata.get("executionMode"))
        .or_else(|| metadata.get("workspace_mode"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase());

    match explicit.as_deref() {
        Some(WORKSPACE_MODE_SHARED_READ) => WORKSPACE_MODE_SHARED_READ.to_string(),
        Some(WORKSPACE_MODE_SHARED_WRITE) => WORKSPACE_MODE_SHARED_WRITE.to_string(),
        Some(WORKSPACE_MODE_ISOLATED_WRITE) => WORKSPACE_MODE_ISOLATED_WRITE.to_string(),
        _ if execution_mode == EXECUTION_MODE_PLAN_ONLY => WORKSPACE_MODE_SHARED_READ.to_string(),
        _ => WORKSPACE_MODE_SHARED_WRITE.to_string(),
    }
}

fn normalize_tool_limits(value: Option<JsonValue>) -> Option<JsonValue> {
    match value {
        Some(JsonValue::Object(map)) if !map.is_empty() => Some(JsonValue::Object(map)),
        _ => None,
    }
}

fn ensure_object(value: &mut JsonValue) -> &mut JsonMap<String, JsonValue> {
    if !matches!(value, JsonValue::Object(_)) {
        *value = JsonValue::Object(JsonMap::new());
    }
    value.as_object_mut().expect("value must be object")
}

fn should_suppress_dispatch_user_message(metadata: &JsonValue) -> bool {
    metadata
        .as_object()
        .and_then(|map| {
            map.get("controllerDispatch")
                .or_else(|| map.get("controller_dispatch"))
        })
        .and_then(JsonValue::as_object)
        .and_then(|dispatch| {
            dispatch
                .get("suppressUserMessage")
                .or_else(|| dispatch.get("suppress_user_message"))
        })
        .and_then(JsonValue::as_bool)
        .unwrap_or(false)
}

#[derive(Debug, Clone, Copy)]
struct AmbientDispatchGateInput<'a> {
    intent: &'a str,
    prompt_text: &'a str,
    metadata: &'a JsonValue,
    request_thread_kind: Option<&'a str>,
    conversation_thread_kind: Option<&'a str>,
    has_plan_seed: bool,
    has_tool_limits: bool,
    has_repo_request: bool,
    has_preview_request: bool,
    execution_mode: &'a str,
    strict_browser_target: bool,
    authenticated_human: bool,
    verified_custom_agent_mention: bool,
}

fn should_enforce_ambient_group_participation(input: AmbientDispatchGateInput<'_>) -> bool {
    if !input.authenticated_human
        || input.intent != DEFAULT_PROMPT_INTENT
        || input.execution_mode != EXECUTION_MODE_APPLY
        || input.strict_browser_target
        || input.request_thread_kind.is_some()
        || input.conversation_thread_kind.is_some()
        || input.has_plan_seed
        || input.has_tool_limits
        || input.has_repo_request
        || input.has_preview_request
        || input.verified_custom_agent_mention
        || input.prompt_text.trim_start().starts_with('/')
        || prompt_contains_explicit_octo_mention(input.prompt_text)
        || metadata_marks_special_dispatch(input.metadata)
    {
        return false;
    }

    let explicit_mentions = extract_explicit_agent_mention_handles(input.metadata);
    if !explicit_mentions.is_empty() {
        return !explicit_mentions.iter().any(|handle| handle == "octo");
    }

    // Ambient turns arbitrate through the dispatched agents themselves,
    // regardless of which AI participants are active: every ambient-active
    // agent (default and/or custom) receives an evaluation dispatch and
    // decides participation via the skill-mode decline protocol. Explicit
    // mentions of the default agent or of a verified custom agent already
    // bailed above as direct dispatches, and `extract_agent_selection_handles`
    // falls back to the default agent when the selection is empty, so every
    // remaining selection qualifies.
    true
}

fn should_mark_silent_automation_decline(
    opted_in: bool,
    request_thread_kind: Option<&str>,
    conversation_thread_kind: Option<&str>,
) -> bool {
    opted_in
        && request_thread_kind.is_some_and(|kind| kind.eq_ignore_ascii_case("automation"))
        && conversation_thread_kind.is_some_and(|kind| kind.eq_ignore_ascii_case("automation"))
}

fn extract_explicit_agent_mention_handles(metadata: &JsonValue) -> Vec<String> {
    metadata
        .as_object()
        .and_then(|map| map.get("agentSelection"))
        .and_then(JsonValue::as_object)
        .and_then(|selection| selection.get("mentions"))
        .and_then(JsonValue::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(JsonValue::as_str)
                .filter_map(normalize_agent_handle)
                .collect()
        })
        .unwrap_or_default()
}

async fn has_verified_custom_agent_mention(
    transaction: &Transaction<'_>,
    user_id: Option<Uuid>,
    metadata: &JsonValue,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let Some(user_id) = user_id else {
        return Ok(false);
    };
    let handles = extract_explicit_agent_mention_handles(metadata)
        .into_iter()
        .filter(|handle| handle != "octo")
        .collect::<Vec<_>>();
    if handles.is_empty() {
        return Ok(false);
    }

    transaction
        .query_one(
            "select exists (
                 select 1
                 from user_agents
                 where user_id = $1
                   and lower(handle) = any($2::text[])
                   and deleted_at is null
             )",
            &[&user_id, &handles],
        )
        .await
        .map(|row| row.get::<_, bool>(0))
        .map_err(|error| {
            internal_error(format!(
                "failed to verify explicit custom agent mention: {error}"
            ))
        })
}

fn prompt_contains_explicit_octo_mention(prompt: &str) -> bool {
    prompt
        .char_indices()
        .filter(|(_, ch)| *ch == '@')
        .filter_map(|(index, _)| parse_agent_mention_at(prompt, index))
        .any(|(handle, _)| handle == "octo")
}

fn metadata_marks_special_dispatch(metadata: &JsonValue) -> bool {
    let Some(map) = metadata.as_object() else {
        return false;
    };
    if metadata_uses_personal_browser(metadata) || metadata_uses_shared_browser(metadata) {
        return true;
    }
    if [
        "agentThread",
        "agent_thread",
        "automation",
        "command",
        "goalContinuation",
        "goal_continuation",
        "linkedThreadId",
        "linked_thread_id",
        "multiAgentPlan",
        "multi_agent_plan",
    ]
    .iter()
    .any(|key| map.contains_key(*key))
    {
        return true;
    }
    map.get("controllerDispatch")
        .or_else(|| map.get("controller_dispatch"))
        .and_then(JsonValue::as_object)
        .and_then(|dispatch| {
            let suppress_user_message = dispatch
                .get("suppressUserMessage")
                .or_else(|| dispatch.get("suppress_user_message"))
                .and_then(JsonValue::as_bool)
                .unwrap_or(false);
            Some(suppress_user_message)
        })
        .unwrap_or(false)
}

fn recorded_dispatch_response(conversation_id: Uuid) -> DispatchPromptResponse {
    DispatchPromptResponse {
        run_id: None,
        run_ids: None,
        prompt_id: None,
        job_id: None,
        job_ids: None,
        status: "recorded".to_string(),
        conversation_id: Some(conversation_id),
    }
}

fn runtime_preference_json(
    runtime_id: Uuid,
    source: Option<&str>,
    updated_at: DateTime<Utc>,
    display_name: Option<&str>,
) -> JsonValue {
    let mut map = JsonMap::new();
    map.insert(
        "runtimeId".to_string(),
        JsonValue::String(runtime_id.to_string()),
    );
    if let Some(source_value) = source {
        map.insert(
            "source".to_string(),
            JsonValue::String(source_value.to_string()),
        );
    }
    map.insert(
        "updatedAt".to_string(),
        JsonValue::String(updated_at.to_rfc3339()),
    );
    if let Some(name) = display_name {
        map.insert(
            "displayName".to_string(),
            JsonValue::String(name.to_string()),
        );
    }
    JsonValue::Object(map)
}

fn merge_runtime_preference(
    metadata: &mut JsonValue,
    runtime_id: Option<Uuid>,
    source: Option<&str>,
    updated_at: Option<DateTime<Utc>>,
    display_name: Option<&str>,
) {
    let runtime_id = match runtime_id {
        Some(value) => value,
        None => return,
    };
    let updated_at_value = updated_at.unwrap_or_else(Utc::now);
    let map = ensure_object(metadata);
    map.insert(
        "runtimePreference".to_string(),
        runtime_preference_json(runtime_id, source, updated_at_value, display_name),
    );
}

fn merge_runtime_preference_option(
    target: &mut Option<JsonValue>,
    runtime_id: Option<Uuid>,
    source: Option<&str>,
    updated_at: Option<DateTime<Utc>>,
    display_name: Option<&str>,
) {
    if runtime_id.is_none() {
        return;
    }
    let mut value = target.take().unwrap_or(JsonValue::Object(JsonMap::new()));
    merge_runtime_preference(&mut value, runtime_id, source, updated_at, display_name);
    *target = Some(value);
}

fn metadata_allows_runtime_spread(metadata: &JsonValue) -> bool {
    let Some(routing) = metadata
        .get("runtimeRouting")
        .or_else(|| metadata.get("runtime_routing"))
        .and_then(JsonValue::as_object)
    else {
        return false;
    };

    if routing
        .get("allowUntargetedAcrossPreferredRuntimes")
        .or_else(|| routing.get("allowRuntimeSpread"))
        .or_else(|| routing.get("allow_runtime_spread"))
        .and_then(JsonValue::as_bool)
        == Some(true)
    {
        return true;
    }

    routing
        .get("strategy")
        .or_else(|| routing.get("mode"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"))
        .is_some_and(|value| matches!(value.as_str(), "spread" | "parallel" | "scale_out"))
}

fn metadata_uses_personal_browser(metadata: &JsonValue) -> bool {
    metadata
        .get("browserTransport")
        .or_else(|| metadata.get("browser_transport"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase().replace('_', "-"))
        .as_deref()
        == Some("desktop-personal")
}

fn metadata_uses_shared_browser(metadata: &JsonValue) -> bool {
    metadata
        .get("browserTransport")
        .or_else(|| metadata.get("browser_transport"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase().replace('_', "-"))
        .as_deref()
        == Some("shared")
}

fn validate_shared_browser_consent_version(
    metadata: &JsonMap<String, JsonValue>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let mut observed = None;
    for key in ["browserConsentVersion", "browser_consent_version"] {
        let Some(value) = metadata.get(key) else {
            continue;
        };
        let version = value.as_u64().ok_or_else(|| {
            bad_request(
                "Shared Browser action approvals require a current Studio client; refresh and try again",
            )
        })?;
        if version != SHARED_BROWSER_CONSENT_VERSION || observed.is_some_and(|seen| seen != version)
        {
            return Err(bad_request(
                "Shared Browser action approvals require a current Studio client; refresh and try again",
            ));
        }
        observed = Some(version);
    }
    if observed != Some(SHARED_BROWSER_CONSENT_VERSION) {
        return Err(bad_request(
            "Shared Browser action approvals require a current Studio client; refresh and try again",
        ));
    }
    Ok(())
}

fn personal_browser_runtime_id(
    metadata: &JsonValue,
    explicit_runtime_id: Option<Uuid>,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    if !metadata_uses_personal_browser(metadata) {
        return Ok(None);
    }

    explicit_runtime_id.map(Some).ok_or_else(|| {
        bad_request("Personal Browser requests require an explicit desktop runtimeId")
    })
}

fn shared_browser_runtime_id(
    metadata: &JsonValue,
    explicit_runtime_id: Option<Uuid>,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let Some(metadata) = metadata.as_object() else {
        return Ok(None);
    };

    let mut declares_shared_browser = false;
    for key in ["browserTransport", "browser_transport"] {
        let Some(value) = metadata.get(key) else {
            continue;
        };
        let normalized = value
            .as_str()
            .map(|value| value.trim().to_ascii_lowercase().replace('_', "-"));
        if normalized.as_deref() == Some("shared") {
            declares_shared_browser = true;
        }
    }
    if !declares_shared_browser {
        return Ok(None);
    }

    for key in ["browserTransport", "browser_transport"] {
        let Some(value) = metadata.get(key) else {
            continue;
        };
        let normalized = value
            .as_str()
            .map(|value| value.trim().to_ascii_lowercase().replace('_', "-"));
        if normalized.as_deref() != Some("shared") {
            return Err(bad_request(
                "Shared Browser requests cannot contain conflicting browser transport metadata",
            ));
        }
    }

    let explicit_runtime_id = explicit_runtime_id
        .ok_or_else(|| bad_request("Shared Browser requests require an explicit runtimeId"))?;

    for key in ["browserRuntimeId", "browser_runtime_id"] {
        let Some(value) = metadata.get(key) else {
            continue;
        };
        let raw = value
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| bad_request("browserRuntimeId must be a valid UUID"))?;
        let browser_runtime_id = Uuid::parse_str(raw)
            .map_err(|_| bad_request("browserRuntimeId must be a valid UUID"))?;
        if browser_runtime_id != explicit_runtime_id {
            return Err(bad_request(
                "browserRuntimeId must match runtimeId for Shared Browser requests",
            ));
        }
    }

    Ok(Some(explicit_runtime_id))
}

fn canonicalize_shared_browser_request(
    request: &mut DispatchPromptNormalized,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let metadata = request
        .metadata
        .as_object_mut()
        .ok_or_else(|| bad_request("Shared Browser metadata must be an object"))?;
    validate_shared_browser_consent_version(metadata)?;

    for key in ["writeIntent", "write_intent"] {
        if let Some(value) = metadata.get(key) {
            if parse_runtime_bool(value) != Some(false) {
                return Err(bad_request(
                    "Shared Browser requests cannot modify workspace files",
                ));
            }
        }
    }

    for key in ["writeScope", "write_scope"] {
        if let Some(scope) = metadata.get(key) {
            validate_shared_browser_write_scope(scope)?;
        }
    }

    for key in [
        "agentWriteScopes",
        "agent_write_scopes",
        "writeScopes",
        "write_scopes",
    ] {
        if metadata.get(key).is_some_and(|value| !value.is_null()) {
            return Err(bad_request(
                "Shared Browser requests cannot use per-agent write scopes",
            ));
        }
    }
    if metadata
        .get("agentSelection")
        .and_then(JsonValue::as_object)
        .is_some_and(|selection| {
            ["writeScopes", "write_scopes"]
                .iter()
                .any(|key| selection.get(*key).is_some_and(|value| !value.is_null()))
        })
    {
        return Err(bad_request(
            "Shared Browser requests cannot use per-agent write scopes",
        ));
    }

    validate_shared_browser_runtime_routing(metadata)?;
    if metadata.contains_key("multiAgentPlan") || metadata.contains_key("multi_agent_plan") {
        return Err(bad_request(
            "Shared Browser requests cannot use multi-agent plans",
        ));
    }
    for key in ["agentCollaboration", "agent_collaboration"] {
        let Some(value) = metadata.get(key) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let collaboration = value.as_object().ok_or_else(|| {
            bad_request("Shared Browser agent collaboration metadata must be an object")
        })?;
        for flag in ["requested", "multiAgent", "multi_agent"] {
            if collaboration
                .get(flag)
                .is_some_and(|value| parse_runtime_bool(value) != Some(false))
            {
                return Err(bad_request(
                    "Shared Browser requests cannot use multi-agent planning or fanout",
                ));
            }
        }
        for mode_key in ["mode", "kind"] {
            let Some(value) = collaboration.get(mode_key) else {
                continue;
            };
            if value.is_null() {
                continue;
            }
            let mode = value
                .as_str()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    bad_request(
                        "Shared Browser agent collaboration mode must be a non-empty string",
                    )
                })?
                .to_ascii_lowercase()
                .replace('-', "_");
            if matches!(mode.as_str(), "team_plan" | "multi_agent") {
                return Err(bad_request(
                    "Shared Browser requests cannot use multi-agent planning or fanout",
                ));
            }
        }
    }
    if extract_agent_selection_handles(&JsonValue::Object(metadata.clone())).len() != 1 {
        return Err(bad_request(
            "Shared Browser requests must target exactly one agent",
        ));
    }

    for key in ["runtimeExpectations", "runtime_expectations"] {
        let Some(value) = metadata.get(key) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let expectations = value
            .as_object()
            .ok_or_else(|| bad_request("Shared Browser runtime expectations must be an object"))?;
        validate_shared_browser_expectation(
            expectations,
            &["workspaceFileChanges", "workspace_file_changes"],
            false,
            "Shared Browser requests cannot modify workspace files",
        )?;
        validate_shared_browser_expectation(
            expectations,
            &["commandExecution", "command_execution"],
            false,
            "Shared Browser requests cannot execute shell commands",
        )?;
        validate_shared_browser_expectation(
            expectations,
            &[
                "genericMcpToolExecution",
                "generic_mcp_tool_execution",
                "mcpToolExecution",
                "mcp_tool_execution",
            ],
            false,
            "Shared Browser requests cannot execute generic MCP tools",
        )?;
        validate_shared_browser_expectation(
            expectations,
            &["browserExecution", "browser_execution"],
            true,
            "Shared Browser requests require browser execution",
        )?;
    }

    for alias in [
        "browser_transport",
        "browser_consent_version",
        "browser_runtime_id",
        "write_intent",
        "write_scope",
        "runtime_expectations",
        "runtime_routing",
        "workspace_mode",
        "agent_collaboration",
    ] {
        metadata.remove(alias);
    }
    // Collaboration routing is not part of the Shared Browser execution
    // contract. Remove it after rejecting every team-planning shape recognized
    // by the runtime so later stages cannot reinterpret the turn as fanout.
    metadata.remove("agentCollaboration");
    metadata.insert(
        "browserTransport".to_string(),
        JsonValue::String("shared".to_string()),
    );
    metadata.insert(
        "browserConsentVersion".to_string(),
        JsonValue::Number(SHARED_BROWSER_CONSENT_VERSION.into()),
    );
    metadata.insert(
        "browserRuntimeId".to_string(),
        JsonValue::String(
            request
                .runtime_id
                .expect("Shared Browser runtime was validated before canonicalization")
                .to_string(),
        ),
    );
    metadata.insert("writeIntent".to_string(), JsonValue::Bool(false));
    metadata.insert(
        "writeScope".to_string(),
        json!({ "mode": "read_only", "ownedPaths": [] }),
    );
    metadata.insert(
        "runtimeExpectations".to_string(),
        json!({
            "workspaceFileChanges": false,
            "commandExecution": false,
            "genericMcpToolExecution": false,
            "browserExecution": true,
        }),
    );
    metadata.insert(
        "runtimeRouting".to_string(),
        json!({
            "strategy": "exact",
            "allowUntargetedAcrossPreferredRuntimes": false,
        }),
    );
    metadata.insert(
        "executionMode".to_string(),
        JsonValue::String(WORKSPACE_MODE_SHARED_READ.to_string()),
    );
    metadata.insert(
        "workspaceMode".to_string(),
        JsonValue::String(WORKSPACE_MODE_SHARED_READ.to_string()),
    );
    request.workspace_mode = WORKSPACE_MODE_SHARED_READ.to_string();

    Ok(())
}

fn validate_shared_browser_expectation(
    expectations: &JsonMap<String, JsonValue>,
    keys: &[&str],
    expected: bool,
    error_message: &'static str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    for key in keys {
        if let Some(value) = expectations.get(*key) {
            if parse_runtime_bool(value) != Some(expected) {
                return Err(bad_request(error_message));
            }
        }
    }
    Ok(())
}

fn validate_shared_browser_write_scope(
    scope: &JsonValue,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if scope.is_null() {
        return Ok(());
    }

    let read_only = match scope {
        JsonValue::String(mode) => {
            matches!(
                mode.trim().to_ascii_lowercase().replace('-', "_").as_str(),
                "read_only" | "readonly"
            )
        }
        JsonValue::Object(scope) if scope.is_empty() => true,
        JsonValue::Object(scope) => {
            let mode = scope
                .get("mode")
                .or_else(|| scope.get("status"))
                .and_then(JsonValue::as_str)
                .map(|mode| mode.trim().to_ascii_lowercase().replace('-', "_"));
            let declares_read_only = matches!(mode.as_deref(), Some("read_only" | "readonly"))
                || scope
                    .get("readOnly")
                    .or_else(|| scope.get("read_only"))
                    .is_some_and(|value| parse_runtime_bool(value) == Some(true));
            let declares_owned_paths = [
                "ownedPaths",
                "owned_paths",
                "paths",
                "pathGlobs",
                "path_globs",
                "ownedPathGlobs",
                "owned_path_globs",
            ]
            .iter()
            .any(|key| {
                scope.get(*key).is_some_and(|value| match value {
                    JsonValue::Null => false,
                    JsonValue::String(value) => !value.trim().is_empty(),
                    JsonValue::Array(values) => !values.is_empty(),
                    _ => true,
                })
            });
            declares_read_only && !declares_owned_paths
        }
        _ => false,
    };

    if !read_only {
        return Err(bad_request(
            "Shared Browser requests require a read-only write scope",
        ));
    }
    Ok(())
}

fn validate_shared_browser_runtime_routing(
    metadata: &JsonMap<String, JsonValue>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    for key in ["runtimeRouting", "runtime_routing"] {
        let Some(value) = metadata.get(key) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let routing = value
            .as_object()
            .ok_or_else(|| bad_request("Shared Browser runtime routing must be an object"))?;
        for allow_key in [
            "allowUntargetedAcrossPreferredRuntimes",
            "allowRuntimeSpread",
            "allow_runtime_spread",
        ] {
            if let Some(value) = routing.get(allow_key) {
                if parse_runtime_bool(value) != Some(false) {
                    return Err(bad_request(
                        "Shared Browser requests cannot use runtime spread",
                    ));
                }
            }
        }
        for strategy_key in ["strategy", "mode"] {
            if let Some(value) = routing.get(strategy_key) {
                let normalized = value
                    .as_str()
                    .map(|value| value.trim().to_ascii_lowercase().replace('-', "_"));
                if !matches!(
                    normalized.as_deref(),
                    Some("exact" | "reuse" | "pinned" | "single_runtime")
                ) {
                    return Err(bad_request(
                        "Shared Browser requests cannot use runtime spread",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn should_retarget_unavailable_runtime(
    reason: &str,
    strict_browser_runtime_id: Option<Uuid>,
) -> bool {
    matches!(reason, "runtime_not_ready" | "runtime_unavailable")
        && strict_browser_runtime_id.is_none()
}

fn should_persist_runtime_alert_conversation_message(
    reason: &str,
    detail: Option<&str>,
    reconnect: Option<&JsonValue>,
) -> bool {
    if reason != "runtime_not_ready" {
        return true;
    }

    let reconnect_status = reconnect
        .and_then(JsonValue::as_object)
        .and_then(|value| value.get("status"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase());
    if matches!(
        reconnect_status.as_deref(),
        Some("requested" | "starting" | "launching" | "provisioning" | "pending")
    ) {
        return false;
    }
    if reconnect_status.as_deref() == Some("failed") {
        return true;
    }

    let runtime_status = detail.and_then(|value| {
        value.split(',').find_map(|part| {
            part.trim()
                .strip_prefix("status=")
                .map(|status| status.trim().to_ascii_lowercase())
        })
    });
    !matches!(
        runtime_status.as_deref(),
        Some("requested" | "starting" | "launching" | "provisioning" | "pending")
    )
}

/// These sentences name the surface the reader can actually reach. They used to
/// say "the Runtime button by the composer"; that button's only renderer lost
/// its last importer and has since been deleted, so the copy was pointing at a
/// control that no longer exists. Machines is where runtimes live now.
/// The frontend mirrors these in `controllerConversationNotice.ts` and renders
/// an "Open Machines" action beside them.
fn runtime_alert_fallback_message(reason: &str, terminal_alert: bool) -> &'static str {
    match reason {
        "runtime_not_ready" if terminal_alert => {
            "Workspace startup failed. Open Machines to reconnect Instafy Cloud."
        }
        "runtime_not_ready" => {
            "Starting the workspace. Your queued request will continue automatically."
        }
        "runtime_unavailable" => {
            "No runtime is connected for this space. Open Machines to start Instafy Cloud."
        }
        "runtime_inspection_failed" => {
            "The workspace runtime could not be verified. Open Machines to inspect or reconnect it."
        }
        _ => {
            "The workspace runtime could not be reached. Open Machines to inspect or reconnect it."
        }
    }
}

fn build_runtime_alert_conversation_metadata(
    details: JsonValue,
    primary_agent_metadata: Option<JsonValue>,
) -> JsonValue {
    json!({
        "source": "controller",
        "kind": "runtime_alert",
        "details": details,
        "agent": primary_agent_metadata,
    })
}

fn shared_browser_runtime_is_dispatchable(
    status: &str,
    last_seen_at: Option<DateTime<Utc>>,
    capabilities: &JsonValue,
) -> bool {
    let seen_recently = last_seen_at
        .map(|last_seen| Utc::now().signed_duration_since(last_seen).num_seconds() <= 90)
        .unwrap_or(false);
    matches!(status, "ready" | "running")
        && seen_recently
        && runtime::runtime_supports_agent_and_origin(capabilities)
        && runtime::runtime_supports_shared_browser_agent_consent(capabilities)
}

async fn ensure_shared_browser_runtime_dispatchable(
    state: &AppState,
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    runtime_id: &Uuid,
) -> Result<runtime::RuntimeRecord, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select id, project_id, provider, status, idle_ttl_seconds,
                    last_seen_at, capabilities, display_name, active_lease_id
             from runtimes
             where project_id = $1 and id = $2
             for share",
            &[project_id, runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate Shared Browser runtime: {error}"
            ))
        })?;

    let Some(row) = row else {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "Shared Browser runtime is not connected to this project. Reconnect the browser runtime and try again.",
            )),
        ));
    };

    let provider: String = row.get("provider");
    let capabilities: JsonValue = row.get("capabilities");
    if !crate::provider_identifiers::is_trusted_instafy_cloud_provider_id(&provider)
        || runtime::runtime_is_private_self_hosted(state, &provider, &capabilities)
    {
        return Err(forbidden(
            "Shared Browser is available only on managed Instafy Cloud runtimes",
        ));
    }

    let status: String = row.get("status");
    let last_seen_at: Option<DateTime<Utc>> = row.get("last_seen_at");
    if !shared_browser_runtime_is_dispatchable(&status, last_seen_at, &capabilities) {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "Shared Browser runtime is unavailable or predates action approvals. Reconnect it and try again; this request was not sent to another runtime.",
            )),
        ));
    }

    Ok(runtime::RuntimeRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        provider,
        status,
        idle_ttl_seconds: row.get("idle_ttl_seconds"),
        capabilities,
        display_name: row.get("display_name"),
        active_lease_id: row.get("active_lease_id"),
    })
}

async fn ensure_personal_browser_runtime_dispatchable(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    runtime_id: &Uuid,
    requesting_user_id: Option<Uuid>,
) -> Result<runtime::RuntimeRecord, (StatusCode, Json<ApiError>)> {
    let requesting_user_id = requesting_user_id
        .ok_or_else(|| unauthorized("Personal Browser requests require an authenticated user"))?;
    let row = transaction
        .query_opt(
            "select id, project_id, provider, status, idle_ttl_seconds,
                    last_seen_at, capabilities, display_name, active_lease_id
             from runtimes
             where project_id = $1 and id = $2
             for share",
            &[project_id, runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate Personal Browser desktop runtime: {error}"
            ))
        })?;

    let Some(row) = row else {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "Personal Browser agent is not connected to this project. Resume agent control and try again.",
            )),
        ));
    };

    let provider: String = row.get("provider");
    let status: String = row.get("status");
    let last_seen_at: Option<DateTime<Utc>> = row.get("last_seen_at");
    let capabilities: JsonValue = row.get("capabilities");
    let attested_owner = personal_browser_owner_user_id(&capabilities);
    if provider.trim().to_ascii_lowercase().replace('_', "-") != "self-hosted"
        || attested_owner != Some(requesting_user_id)
    {
        return Err((
            StatusCode::FORBIDDEN,
            Json(ApiError::new(
                "Personal Browser runtime is not available to the current user.",
            )),
        ));
    }
    let seen_recently = last_seen_at
        .map(|last_seen| Utc::now().signed_duration_since(last_seen).num_seconds() <= 90)
        .unwrap_or(false);
    let dispatchable = matches!(status.as_str(), "ready" | "running")
        && seen_recently
        && runtime::runtime_supports_agent_and_origin(&capabilities);

    if !dispatchable {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(
                "Personal Browser agent is unavailable. Resume agent control and try again; this request was not sent to a shared runtime.",
            )),
        ));
    }

    Ok(runtime::RuntimeRecord {
        id: row.get("id"),
        project_id: row.get("project_id"),
        provider,
        status,
        idle_ttl_seconds: row.get("idle_ttl_seconds"),
        capabilities,
        display_name: row.get("display_name"),
        active_lease_id: row.get("active_lease_id"),
    })
}

fn personal_browser_owner_user_id(capabilities: &JsonValue) -> Option<Uuid> {
    let capability = capabilities
        .get("personalBrowser")
        .or_else(|| capabilities.get("personal_browser"))?;
    if capability.get("enabled").and_then(JsonValue::as_bool) != Some(true) {
        return None;
    }
    capability
        .get("ownerUserId")
        .or_else(|| capability.get("owner_user_id"))
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
}

fn personal_browser_target_owner_is_authorized(
    capabilities: &JsonValue,
    requesting_user_id: Option<Uuid>,
    personal_browser_job: bool,
) -> bool {
    let has_personal_browser_capability = capabilities.get("personalBrowser").is_some()
        || capabilities.get("personal_browser").is_some();
    if !has_personal_browser_capability {
        return true;
    }
    if !personal_browser_job {
        return false;
    }
    personal_browser_owner_user_id(capabilities)
        .is_some_and(|owner| requesting_user_id == Some(owner))
}

pub(crate) async fn ensure_runtime_target_owner(
    state: &AppState,
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    runtime_id: Option<Uuid>,
    requesting_user_id: Option<Uuid>,
    is_service_role: bool,
    personal_browser_job: bool,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let Some(runtime_id) = runtime_id else {
        return Ok(None);
    };
    let row = transaction
        .query_opt(
            "select provider, capabilities
             from runtimes
             where project_id = $1 and id = $2
             for share",
            &[project_id, &runtime_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to validate Personal Browser runtime target owner: {error}"
            ))
        })?;
    let Some(row) = row else {
        return Ok(None);
    };
    let provider: String = row.get("provider");
    let capabilities: JsonValue = row.get("capabilities");
    runtime::ensure_self_hosted_runtime_access(
        state,
        &provider,
        &capabilities,
        requesting_user_id,
        is_service_role,
    )?;
    if !personal_browser_target_owner_is_authorized(
        &capabilities,
        requesting_user_id,
        personal_browser_job,
    ) {
        return Err(forbidden(
            "Personal Browser runtime is not available to the current user",
        ));
    }
    Ok(Some(provider))
}

fn target_runtime_for_agent_job(
    metadata: &JsonValue,
    target_runtime_id: Option<Uuid>,
    preferred_runtime_id: Option<Uuid>,
) -> Option<Uuid> {
    if metadata_uses_personal_browser(metadata) || metadata_uses_shared_browser(metadata) {
        // The explicit per-send runtime wins over both an agent's configured
        // runtime and spread metadata. Returning None here is intentional when
        // called with invalid input: it must not fall back to another worker.
        preferred_runtime_id
    } else if metadata_allows_runtime_spread(metadata) {
        None
    } else {
        target_runtime_id.or(preferred_runtime_id)
    }
}

async fn build_managed_ai_reserve_trace(
    transaction: &Transaction<'_>,
    org_id: &Uuid,
    project_id: &Uuid,
    prompt_id: &Uuid,
    reserve_units: i32,
) -> Result<JsonValue, (StatusCode, Json<ApiError>)> {
    let idempotency_key = format!("managed-ai-prompt:{prompt_id}");
    let reserve = credits::load_credit_ledger_reference_by_idempotency_key(
        transaction,
        org_id,
        project_id,
        &idempotency_key,
    )
    .await?;

    Ok(json!({
        "promptId": prompt_id,
        "reserve": reserve.map(|value| json!(value)).unwrap_or_else(|| json!({
            "ledgerId": JsonValue::Null,
            "idempotencyKey": idempotency_key,
            "reason": "managed_ai_prompt",
            "delta": -(reserve_units.abs()),
        }))
    }))
}

pub(crate) async fn persist_run_job_identity(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    run_id: &Uuid,
    job_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let updated = transaction
        .execute(
            "update runs
             set metadata =
                 (case
                    when jsonb_typeof(metadata) = 'object' then metadata
                    else '{}'::jsonb
                  end)
                 || jsonb_build_object('jobId', $3::uuid)
             where id = $1
               and project_id = $2",
            &[run_id, project_id, job_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to persist authoritative agent job identity onto run: {error}"
            ))
        })?;

    if updated != 1 {
        return Err(internal_error(
            "failed to persist authoritative agent job identity: run not found in project",
        ));
    }

    Ok(())
}

pub(crate) async fn persist_run_managed_ai_credit_metadata(
    transaction: &Transaction<'_>,
    run_ids: &[Uuid],
    managed_ai_credit: &JsonValue,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if run_ids.is_empty() {
        return Ok(());
    }

    for run_id in run_ids {
        let row = transaction
            .query_opt(
                "select metadata from runs where id = $1 for update",
                &[run_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to load run metadata for managed AI credit trace: {error}"
                ))
            })?;

        let Some(row) = row else {
            continue;
        };

        let existing = row
            .get::<_, Option<PgJson<JsonValue>>>("metadata")
            .map(|json| json.0);
        let merged = merge_run_managed_ai_credit_metadata(existing.as_ref(), managed_ai_credit);
        let merged_param = PgJson(&merged);
        transaction
            .execute(
                "update runs set metadata = $2::jsonb where id = $1",
                &[run_id, &merged_param],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to persist managed AI credit trace onto run: {error}"
                ))
            })?;
    }

    Ok(())
}

fn merge_run_managed_ai_credit_metadata(
    existing: Option<&JsonValue>,
    managed_ai_credit: &JsonValue,
) -> JsonValue {
    let mut root = match existing.cloned() {
        Some(JsonValue::Object(map)) => map,
        _ => JsonMap::new(),
    };

    let merged_credit = match (root.remove("managedAiCredit"), managed_ai_credit.clone()) {
        (Some(JsonValue::Object(mut existing_map)), JsonValue::Object(incoming_map)) => {
            for (key, value) in incoming_map {
                existing_map.insert(key, value);
            }
            JsonValue::Object(existing_map)
        }
        (_, incoming) => incoming,
    };

    root.insert("managedAiCredit".to_string(), merged_credit);
    JsonValue::Object(root)
}

pub(crate) async fn persist_run_ai_access_metadata(
    transaction: &Transaction<'_>,
    run_ids: &[Uuid],
    managed_ai_access: bool,
    managed_ai_used: bool,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if run_ids.is_empty() {
        return Ok(());
    }

    for run_id in run_ids {
        let row = transaction
            .query_opt(
                "select metadata from runs where id = $1 for update",
                &[run_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to load run metadata for AI access audit: {error}"
                ))
            })?;

        let Some(row) = row else {
            continue;
        };
        let existing = row
            .get::<_, Option<PgJson<JsonValue>>>("metadata")
            .map(|json| json.0);
        let merged =
            merge_ai_access_metadata(existing.as_ref(), managed_ai_access, managed_ai_used);
        let merged_param = PgJson(&merged);
        transaction
            .execute(
                "update runs set metadata = $2::jsonb where id = $1",
                &[run_id, &merged_param],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to persist run AI access audit: {error}"))
            })?;
    }

    Ok(())
}

pub(crate) async fn persist_prompt_ai_access_metadata(
    transaction: &Transaction<'_>,
    prompt_id: &Uuid,
    managed_ai_access: bool,
    managed_ai_used: bool,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select metadata from prompts where id = $1 for update",
            &[prompt_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load prompt metadata for AI access audit: {error}"
            ))
        })?;

    let Some(row) = row else {
        return Ok(());
    };
    let existing = row
        .get::<_, Option<PgJson<JsonValue>>>("metadata")
        .map(|json| json.0);
    let merged = merge_ai_access_metadata(existing.as_ref(), managed_ai_access, managed_ai_used);
    let merged_param = PgJson(&merged);
    transaction
        .execute(
            "update prompts set metadata = $2::jsonb where id = $1",
            &[prompt_id, &merged_param],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to persist prompt AI access audit: {error}"))
        })?;

    Ok(())
}

fn merge_ai_access_metadata(
    existing: Option<&JsonValue>,
    managed_ai_access: bool,
    managed_ai_used: bool,
) -> JsonValue {
    let mut root = match existing.cloned() {
        Some(JsonValue::Object(map)) => map,
        _ => JsonMap::new(),
    };
    root.insert(
        "aiAccessMode".to_string(),
        JsonValue::String(if managed_ai_access { "managed" } else { "byoc" }.to_string()),
    );
    root.insert(
        "managedAiUsed".to_string(),
        JsonValue::Bool(managed_ai_used),
    );
    JsonValue::Object(root)
}

async fn load_target_credential_provider(
    transaction: &Transaction<'_>,
    credential_id: Option<Uuid>,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let Some(credential_id) = credential_id else {
        return Ok(None);
    };

    let row = transaction
        .query_opt(
            "select kind, metadata
             from user_credentials
             where id = $1 and revoked_at is null
             limit 1",
            &[&credential_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load credential provider for dispatch target: {error}"
            ))
        })?;

    let Some(row) = row else {
        return Ok(None);
    };

    let kind: String = row.get("kind");
    let metadata = row
        .get::<_, Option<PgJson<JsonValue>>>("metadata")
        .map(|json| json.0)
        .unwrap_or_else(|| JsonValue::Object(JsonMap::new()));

    Ok(Some(credentials::provider_for_credential(
        kind.as_str(),
        &metadata,
    )))
}

pub(crate) async fn persist_run_runtime_alert_metadata(
    client: &mut tokio_postgres::Client,
    project_id: &Uuid,
    run_ids: &[Uuid],
    alert: &JsonValue,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if run_ids.is_empty() {
        return Ok(());
    }

    let transaction = client.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start runtime alert transaction: {error}"
        ))
    })?;

    for run_id in run_ids {
        let row = transaction
            .query_opt(
                "select metadata
                 from runs
                 where id = $1 and project_id = $2
                 for update",
                &[run_id, project_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to load run metadata for runtime alert: {error}"
                ))
            })?;

        let Some(row) = row else {
            continue;
        };

        let existing = row
            .get::<_, Option<PgJson<JsonValue>>>("metadata")
            .map(|json| json.0);
        let merged = merge_run_runtime_alert_metadata(existing.as_ref(), alert);
        let merged_param = PgJson(&merged);
        transaction
            .execute(
                "update runs set metadata = $3::jsonb where id = $1 and project_id = $2",
                &[run_id, project_id, &merged_param],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to persist runtime alert metadata: {error}"))
            })?;
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to commit runtime alert metadata: {error}"))
    })?;

    Ok(())
}

fn merge_run_runtime_alert_metadata(existing: Option<&JsonValue>, alert: &JsonValue) -> JsonValue {
    let mut root = match existing.cloned() {
        Some(JsonValue::Object(map)) => map,
        _ => JsonMap::new(),
    };
    root.insert("runtimeAlert".to_string(), alert.clone());
    JsonValue::Object(root)
}

pub(crate) async fn load_previous_provider_conversation_state(
    transaction: &Transaction<'_>,
    conversation_id: &Uuid,
    expected_provider: Option<&str>,
    agent_id: Option<&Uuid>,
    agent_handle: Option<&str>,
) -> Result<Option<JsonValue>, (StatusCode, Json<ApiError>)> {
    let rows = match expected_provider {
        Some(provider) => {
            transaction
                .query(
                    "select metadata->'provider'->'conversation' as conversation_state
                            , metadata->'agent' as agent
                     from runs
                     where conversation_id = $1
                       and metadata->'provider'->>'id' = $2
                       and metadata->'provider'->'conversation' is not null
                     order by created_at desc
                     limit 25",
                    &[conversation_id, &provider],
                )
                .await
        }
        None => {
            transaction
                .query(
                    "select metadata->'provider'->'conversation' as conversation_state
                            , metadata->'agent' as agent
                     from runs
                     where conversation_id = $1
                       and metadata->'provider'->'conversation' is not null
                     order by created_at desc
                     limit 25",
                    &[conversation_id],
                )
                .await
        }
    }
    .map_err(|error| {
        internal_error(format!(
            "failed to load provider conversation state: {error}"
        ))
    })?;

    for row in rows {
        let agent_metadata = row.get::<_, Option<JsonValue>>("agent");
        if !matches_agent_scope(agent_metadata.as_ref(), agent_id, agent_handle) {
            continue;
        }
        let state = row.get::<_, Option<JsonValue>>("conversation_state");
        if state.is_some() {
            return Ok(state);
        }
    }

    Ok(None)
}

fn matches_agent_scope(
    metadata: Option<&JsonValue>,
    agent_id: Option<&Uuid>,
    agent_handle: Option<&str>,
) -> bool {
    let metadata = metadata.and_then(JsonValue::as_object);
    let metadata_id = metadata
        .and_then(|agent| agent.get("id"))
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok());
    if let Some(agent_id) = agent_id {
        if metadata_id == Some(*agent_id) {
            return true;
        }
    }

    let normalized_handle = agent_handle
        .map(|value| value.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|value| !value.is_empty());
    let metadata_handle = metadata
        .and_then(|agent| agent.get("handle"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().trim_start_matches('@').to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    if let Some(expected_handle) = normalized_handle {
        return metadata_handle.as_deref() == Some(expected_handle.as_str());
    }

    agent_id.is_none()
}

fn normalize_repo(repo: Option<DispatchPromptRepo>) -> Option<DispatchPromptRepoNormalized> {
    let repo = repo?;
    let trim_string = |input: Option<String>| -> Option<String> {
        input
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };

    let normalized = DispatchPromptRepoNormalized {
        owner: trim_string(repo.owner),
        name: trim_string(repo.name),
        installation_id: repo.installation_id,
        default_branch: trim_string(repo.default_branch),
        working_branch: trim_string(repo.working_branch),
    };

    if normalized.owner.is_none()
        && normalized.name.is_none()
        && normalized.installation_id.is_none()
        && normalized.default_branch.is_none()
        && normalized.working_branch.is_none()
    {
        return None;
    }

    Some(normalized)
}

async fn ensure_project_record_for_dispatch(
    transaction: &Transaction<'_>,
    config: &AppConfig,
    request: &DispatchPromptNormalized,
    context: &RequestContext,
) -> Result<ProjectRecord, (StatusCode, Json<ApiError>)> {
    let existing = transaction
        .query_opt(
            "select id, org_id, name, sandbox_session_id, project_type, owner_user_id, status from projects where id = $1",
            &[&request.project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load project: {error}")))?;

    if let Some(row) = existing {
        let project = map_project_row(&row);
        let project = ensure_project_org(transaction, &project).await?;
        credits::ensure_sandbox_credit_seed(transaction, config, &project, request, context)
            .await?;
        return Ok(project);
    }

    let inferred_type = request.project_type_hint.clone().unwrap_or_else(|| {
        if context.user_id.is_some() {
            "customer".to_string()
        } else {
            "sandbox".to_string()
        }
    });

    let inserted = transaction
        .query_opt(
            "insert into projects (id, project_type, status, sandbox_session_id, owner_user_id)
             values ($1, $2, 'active', $3, $4)
             on conflict (id) do nothing
             returning id, org_id, name, sandbox_session_id, project_type, owner_user_id, status",
            &[
                &request.project_id,
                &inferred_type,
                &request.session_id,
                &context.user_id,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert project: {error}")))?;

    let project_row = if let Some(row) = inserted {
        row
    } else {
        transaction
            .query_one(
                "select id, org_id, name, sandbox_session_id, project_type, owner_user_id, status
                 from projects
                 where id = $1",
                &[&request.project_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to reload project: {error}")))?
    };

    let project = map_project_row(&project_row);
    let project = ensure_project_org(transaction, &project).await?;
    credits::ensure_sandbox_credit_seed(transaction, config, &project, request, context).await?;
    Ok(project)
}

fn map_project_row(row: &tokio_postgres::Row) -> ProjectRecord {
    ProjectRecord {
        id: row.get("id"),
        org_id: row.get("org_id"),
        name: row.get("name"),
        sandbox_session_id: row.get("sandbox_session_id"),
        project_type: row.get("project_type"),
        owner_user_id: row.get("owner_user_id"),
        _status: row.get("status"),
    }
}

#[allow(dead_code)]
fn build_progress_callback_url(config: &AppConfig) -> Option<String> {
    let base = config._controller_external_url.as_ref()?;
    Some(format!("{}/progress-callback", base.trim_end_matches('/')))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ProgressCallbackRequest {
    run_id: String,
    stage: Option<String>,
    percent: Option<f64>,
    message: Option<String>,
    #[serde(rename = "preview_url", alias = "previewUrl")]
    preview_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct ProgressCallbackResponse {
    ok: bool,
}

#[derive(Debug, Deserialize)]
struct ProgressClaims {
    run_id: Option<String>,
    #[serde(rename = "exp")]
    _exp: Option<i64>,
}

fn verify_progress_callback_token(
    config: &AppConfig,
    headers: &HeaderMap,
    expected_run_id: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let secret = config
        .progress_callback_secret
        .as_ref()
        .ok_or_else(|| unauthorized("progress callback secret not configured"))?;

    let auth_header = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| unauthorized("missing authorization header"))?;

    if !auth_header.starts_with("Bearer ") {
        return Err(unauthorized("authorization header must be Bearer token"));
    }
    let token = auth_header.trim_start_matches("Bearer ").trim();
    if token.is_empty() {
        return Err(unauthorized("authorization token is empty"));
    }

    let mut validation = Validation::new(Algorithm::HS256);
    validation.validate_aud = false;
    let token_data = decode::<ProgressClaims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )
    .map_err(|error| match error.kind() {
        JwtErrorKind::ExpiredSignature => unauthorized("progress token expired"),
        _ => unauthorized("invalid progress token"),
    })?;

    if let Some(run_id_claim) = token_data.claims.run_id {
        if run_id_claim != expected_run_id {
            return Err(unauthorized("progress token run_id mismatch"));
        }
    }

    Ok(())
}

#[allow(dead_code)]
fn issue_progress_callback_token(config: &AppConfig, run_id: &Uuid) -> Option<String> {
    let secret = config.progress_callback_secret.as_ref()?;
    let expires_at = Utc::now() + ChronoDuration::minutes(30);
    #[derive(Serialize)]
    struct ProgressTokenClaims<'a> {
        run_id: &'a str,
        exp: i64,
    }
    let run_id_string = run_id.to_string();
    let claims = ProgressTokenClaims {
        run_id: run_id_string.as_str(),
        exp: expires_at.timestamp(),
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .ok()
}

fn normalize_progress_percent(input: Option<f64>) -> Option<i32> {
    input.and_then(|value| {
        if !value.is_finite() {
            return None;
        }
        let clamped = value.clamp(0.0, 100.0);
        Some(clamped.round() as i32)
    })
}

#[instrument(skip(state, headers, payload))]
async fn progress_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ProgressCallbackRequest>,
) -> Result<Json<ProgressCallbackResponse>, (StatusCode, Json<ApiError>)> {
    let run_id_raw = payload.run_id.trim();
    if run_id_raw.is_empty() {
        return Err(bad_request("run_id is required"));
    }

    verify_progress_callback_token(&state.config, &headers, run_id_raw)?;

    let run_id =
        Uuid::from_str(run_id_raw).map_err(|_| bad_request("run_id must be a valid UUID"))?;

    let percent = normalize_progress_percent(payload.percent);
    let status_update = percent.and_then(|value| {
        if value >= 100 {
            Some("success")
        } else if value > 0 {
            Some("in_progress")
        } else {
            None
        }
    });

    let (project_id, session_id, conversation_id, run_payload) = {
        let client = &mut *state
            .pool
            .get()
            .await
            .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
        match runs::load_run_snapshot(client, &run_id).await {
            Ok(Some(snapshot)) => (
                snapshot.project_id,
                snapshot.session_id,
                snapshot.conversation_id,
                runs::run_snapshot_to_json(&snapshot),
            ),
            Ok(None) => (None, None, None, JsonValue::Null),
            Err(error) => return Err(error),
        }
    };

    if let Some(stage) = payload.stage.as_deref() {
        publish_controller_event_with_conversation(
            &state.events,
            "run.progress",
            project_id,
            session_id,
            conversation_id,
            Some(run_id),
            None,
            json!({
                "status": status_update,
                "stage": stage,
                "percent": percent,
                "message": payload.message,
                "previewUrl": payload.preview_url,
                "run": run_payload,
            }),
        );
    }

    Ok(Json(ProgressCallbackResponse { ok: true }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value as JsonValue};

    fn ambient_gate_for(prompt: &str, intent: &str, metadata: &JsonValue) -> bool {
        ambient_gate_for_with_verified_agent(prompt, intent, metadata, false)
    }

    fn ambient_gate_for_with_verified_agent(
        prompt: &str,
        intent: &str,
        metadata: &JsonValue,
        verified_custom_agent_mention: bool,
    ) -> bool {
        should_enforce_ambient_group_participation(AmbientDispatchGateInput {
            intent,
            prompt_text: prompt,
            metadata,
            request_thread_kind: None,
            conversation_thread_kind: None,
            has_plan_seed: false,
            has_tool_limits: false,
            has_repo_request: false,
            has_preview_request: false,
            execution_mode: EXECUTION_MODE_APPLY,
            strict_browser_target: false,
            authenticated_human: true,
            verified_custom_agent_mention,
        })
    }

    #[test]
    fn ambient_group_enforcement_accepts_plain_turns_for_any_agent_selection() {
        assert!(ambient_gate_for(
            "Should the button be blue?",
            "feature",
            &json!({})
        ));
        assert!(ambient_gate_for(
            "Should the button be blue?",
            "feature",
            &json!({ "agentSelection": { "active": ["octo"], "mentions": [] } })
        ));
        assert!(!ambient_gate_for(
            "@octo should the button be blue?",
            "feature",
            &json!({})
        ));
        assert!(ambient_gate_for(
            "@Marcus should the button be blue?",
            "feature",
            &json!({})
        ));
        assert!(ambient_gate_for(
            "@Marcus should the button be blue?",
            "feature",
            &json!({ "agentSelection": { "active": ["octo"], "mentions": ["marcus"] } })
        ));
        assert!(!ambient_gate_for_with_verified_agent(
            "@reviewer please inspect this",
            "feature",
            &json!({ "agentSelection": { "active": ["octo"], "mentions": ["reviewer"] } }),
            true,
        ));
        assert!(ambient_gate_for(
            "Please review this",
            "feature",
            &json!({ "agentSelection": { "active": ["reviewer"], "mentions": [] } })
        ));
        assert!(ambient_gate_for(
            "Please review this",
            "feature",
            &json!({ "agentSelection": { "active": ["octo", "reviewer"], "mentions": [] } })
        ));
        assert!(!ambient_gate_for("ls -la", "terminal_command", &json!({})));
        assert!(!ambient_gate_for(
            "  /skills list",
            "feature",
            &json!({ "agentSelection": { "active": ["octo"], "mentions": [] } })
        ));
        assert!(!ambient_gate_for(
            "Open the page",
            "feature",
            &json!({ "browserTransport": "shared" })
        ));
        assert!(ambient_gate_for(
            "Continue the queued work",
            "feature",
            &json!({ "controllerDispatch": { "fromSendQueue": true } })
        ));
        assert!(ambient_gate_for(
            "Marcus, does this padding look right?",
            "feature",
            &json!({ "attachments": [{ "name": "phone.png" }] })
        ));
        assert!(ambient_gate_for(
            "Marcus, should we keep the blue version?",
            "feature",
            &json!({ "goal": { "id": "goal-1", "status": "active" } })
        ));
        assert!(!ambient_gate_for(
            "Continue the active goal",
            "feature",
            &json!({
                "goal": { "id": "goal-1", "status": "active" },
                "goalContinuation": { "turn": 2 }
            })
        ));
        assert!(!ambient_gate_for(
            "/goal start Ship the release",
            "feature",
            &json!({
                "goal": { "id": "goal-1", "status": "active" },
                "command": { "type": "goal" }
            })
        ));
    }

    #[test]
    fn terminal_dispatch_does_not_require_ai_access() {
        assert!(!dispatch_requires_ai_access("terminal_command"));
        assert!(!dispatch_requires_ai_access(" TERMINAL_COMMAND "));
        assert!(dispatch_requires_ai_access("feature"));
    }

    #[test]
    fn recorded_dispatch_response_has_no_execution_identifiers() {
        let conversation_id = Uuid::new_v4();
        let serialized = serde_json::to_value(recorded_dispatch_response(conversation_id))
            .expect("serialize recorded response");
        assert_eq!(serialized["status"], "recorded");
        assert_eq!(serialized["conversationId"], conversation_id.to_string());
        assert!(serialized.get("runId").is_none());
        assert!(serialized.get("promptId").is_none());
        assert!(serialized.get("jobId").is_some());
    }

    #[test]
    fn normalize_dispatch_request_applies_defaults() {
        let project_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let request = DispatchPromptRequest {
            project_id: Some(project_id.to_string()),
            session_id: Some(format!(" {} ", session_id)),
            prompt_text: Some("  Hello world   ".to_string()),
            intent: None,
            plan_seed: None,
            metadata: None,
            conversation_metadata: None,
            parent_conversation_id: None,
            thread_kind: None,
            tool_limits: None,
            repo: None,
            ui: None,
            priority: None,
            runtime_type: None,
            idle_ttl_seconds: None,
            conversation_id: None,
            runtime_id: None,
            runtime_display_name: None,
            prefer_runtime: None,
        };

        let normalized = normalize_dispatch_request(request).expect("normalize");

        assert_eq!(normalized.project_id, project_id);
        assert_eq!(normalized.session_id, Some(session_id));
        assert_eq!(normalized.prompt_text, "Hello world");
        assert_eq!(normalized.intent, DEFAULT_PROMPT_INTENT);
        assert_eq!(normalized.priority, DEFAULT_PROMPT_PRIORITY);
        assert_eq!(normalized.execution_mode, EXECUTION_MODE_APPLY);
        assert_eq!(normalized.workspace_mode, WORKSPACE_MODE_SHARED_WRITE);
        assert!(normalized.runtime_id.is_none());
        assert!(normalized.runtime_source.is_none());
        assert!(!normalized.prefer_runtime);
        assert!(!normalized.allow_silent_automation_decline);
        let metadata_map = normalized.metadata.as_object().expect("metadata object");
        assert_eq!(
            metadata_map
                .get("session_id")
                .and_then(JsonValue::as_str)
                .map(|value| value.parse::<Uuid>().expect("uuid")),
            Some(session_id)
        );
        assert_eq!(
            metadata_map
                .get("executionMode")
                .and_then(JsonValue::as_str),
            Some(WORKSPACE_MODE_SHARED_WRITE)
        );
        assert_eq!(
            metadata_map
                .get("workspaceMode")
                .and_then(JsonValue::as_str),
            Some(WORKSPACE_MODE_SHARED_WRITE)
        );
        assert_eq!(
            metadata_map.get("writeIntent").and_then(JsonValue::as_bool),
            Some(false)
        );
    }

    #[test]
    fn matches_agent_scope_uses_handle_when_agent_id_is_absent() {
        assert!(matches_agent_scope(
            Some(&json!({
                "handle": "planner"
            })),
            None,
            Some("planner"),
        ));

        assert!(!matches_agent_scope(
            Some(&json!({
                "handle": "builder"
            })),
            None,
            Some("planner"),
        ));

        assert!(matches_agent_scope(None, None, None));
    }

    #[test]
    fn normalize_dispatch_request_keeps_prompt_text_out_of_write_intent() {
        let request = DispatchPromptRequest {
            project_id: Some(Uuid::new_v4().to_string()),
            session_id: None,
            prompt_text: Some("Update the landing page and edit the README.".to_string()),
            intent: None,
            plan_seed: None,
            metadata: None,
            conversation_metadata: None,
            parent_conversation_id: None,
            thread_kind: None,
            tool_limits: None,
            repo: None,
            ui: None,
            priority: None,
            runtime_type: None,
            idle_ttl_seconds: None,
            conversation_id: None,
            runtime_id: None,
            runtime_display_name: None,
            prefer_runtime: None,
        };

        let normalized = normalize_dispatch_request(request).expect("normalize");
        let metadata_map = normalized.metadata.as_object().expect("metadata object");

        assert_eq!(normalized.workspace_mode, WORKSPACE_MODE_SHARED_WRITE);
        assert_eq!(
            metadata_map.get("writeIntent").and_then(JsonValue::as_bool),
            Some(false)
        );
        assert_eq!(
            metadata_map
                .get("executionMode")
                .and_then(JsonValue::as_str),
            Some(WORKSPACE_MODE_SHARED_WRITE)
        );
    }

    #[test]
    fn normalize_dispatch_request_keeps_plan_only_read_only_by_default() {
        let request = DispatchPromptRequest {
            project_id: Some(Uuid::new_v4().to_string()),
            session_id: None,
            prompt_text: Some("Make a plan only.".to_string()),
            intent: None,
            plan_seed: None,
            metadata: Some(json!({
                "execution_mode": "plan_only"
            })),
            conversation_metadata: None,
            parent_conversation_id: None,
            thread_kind: None,
            tool_limits: None,
            repo: None,
            ui: None,
            priority: None,
            runtime_type: None,
            idle_ttl_seconds: None,
            conversation_id: None,
            runtime_id: None,
            runtime_display_name: None,
            prefer_runtime: None,
        };

        let normalized = normalize_dispatch_request(request).expect("normalize");
        let metadata_map = normalized.metadata.as_object().expect("metadata object");

        assert_eq!(normalized.execution_mode, EXECUTION_MODE_PLAN_ONLY);
        assert_eq!(normalized.workspace_mode, WORKSPACE_MODE_SHARED_READ);
        assert_eq!(
            metadata_map.get("writeIntent").and_then(JsonValue::as_bool),
            Some(false)
        );
    }

    #[test]
    fn normalize_dispatch_request_marks_structured_write_intent_shared_write_without_requiring_files(
    ) {
        let request = DispatchPromptRequest {
            project_id: Some(Uuid::new_v4().to_string()),
            session_id: None,
            prompt_text: Some("Update the landing page and edit the README.".to_string()),
            intent: None,
            plan_seed: None,
            metadata: Some(json!({
                "writeIntent": true
            })),
            conversation_metadata: None,
            parent_conversation_id: None,
            thread_kind: None,
            tool_limits: None,
            repo: None,
            ui: None,
            priority: None,
            runtime_type: None,
            idle_ttl_seconds: None,
            conversation_id: None,
            runtime_id: None,
            runtime_display_name: None,
            prefer_runtime: None,
        };

        let normalized = normalize_dispatch_request(request).expect("normalize");
        let metadata_map = normalized.metadata.as_object().expect("metadata object");

        assert_eq!(normalized.workspace_mode, WORKSPACE_MODE_SHARED_WRITE);
        assert_eq!(
            metadata_map.get("writeIntent").and_then(JsonValue::as_bool),
            Some(true)
        );
        assert_eq!(
            metadata_map
                .get("executionMode")
                .and_then(JsonValue::as_str),
            Some(WORKSPACE_MODE_SHARED_WRITE)
        );
        assert_eq!(
            metadata_map
                .get("runtimeExpectations")
                .and_then(JsonValue::as_object)
                .and_then(|expectations| expectations.get("workspaceFileChanges"))
                .and_then(JsonValue::as_bool),
            None
        );
    }

    #[test]
    fn normalize_dispatch_request_marks_runtime_expectation_write_shared_write() {
        let request = DispatchPromptRequest {
            project_id: Some(Uuid::new_v4().to_string()),
            session_id: None,
            prompt_text: Some("Any language can describe this.".to_string()),
            intent: None,
            plan_seed: None,
            metadata: Some(json!({
                "runtimeExpectations": {
                    "workspaceFileChanges": true
                }
            })),
            conversation_metadata: None,
            parent_conversation_id: None,
            thread_kind: None,
            tool_limits: None,
            repo: None,
            ui: None,
            priority: None,
            runtime_type: None,
            idle_ttl_seconds: None,
            conversation_id: None,
            runtime_id: None,
            runtime_display_name: None,
            prefer_runtime: None,
        };

        let normalized = normalize_dispatch_request(request).expect("normalize");

        assert_eq!(normalized.workspace_mode, WORKSPACE_MODE_SHARED_WRITE);
    }

    #[test]
    fn runtime_spread_metadata_allows_bypassing_project_preference() {
        assert!(metadata_allows_runtime_spread(&json!({
            "runtimeRouting": {
                "strategy": "spread"
            }
        })));
        assert!(metadata_allows_runtime_spread(&json!({
            "runtime_routing": {
                "allow_runtime_spread": true
            }
        })));
        assert!(!metadata_allows_runtime_spread(&json!({
            "runtimeRouting": {
                "strategy": "reuse"
            }
        })));
    }

    #[test]
    fn runtime_spread_jobs_do_not_preserve_stale_runtime_targets() {
        let stale_target = Uuid::new_v4();
        let preferred_runtime = Uuid::new_v4();

        assert_eq!(
            target_runtime_for_agent_job(
                &json!({
                    "runtimeRouting": {
                        "strategy": "spread"
                    }
                }),
                Some(stale_target),
                Some(preferred_runtime),
            ),
            None
        );

        assert_eq!(
            target_runtime_for_agent_job(
                &json!({
                    "runtimeRouting": {
                        "strategy": "reuse"
                    }
                }),
                Some(stale_target),
                Some(preferred_runtime),
            ),
            Some(stale_target)
        );
        assert_eq!(
            target_runtime_for_agent_job(
                &json!({
                    "runtimeRouting": {
                        "strategy": "reuse"
                    }
                }),
                None,
                Some(preferred_runtime),
            ),
            Some(preferred_runtime)
        );
    }

    #[test]
    fn recoverable_runtime_start_does_not_persist_a_conversation_alert() {
        assert!(!should_persist_runtime_alert_conversation_message(
            "runtime_not_ready",
            Some("status=requested, lastSeen=unknown"),
            None,
        ));

        let reconnect = json!({ "status": "requested" });
        assert!(!should_persist_runtime_alert_conversation_message(
            "runtime_not_ready",
            Some("status=ready, lastSeen=2026-07-16T10:00:00Z"),
            Some(&reconnect),
        ));
    }

    #[test]
    fn terminal_runtime_alerts_remain_actionable_conversation_messages() {
        let reconnect_failed = json!({ "status": "failed", "error": "allocator offline" });
        assert!(should_persist_runtime_alert_conversation_message(
            "runtime_not_ready",
            Some("status=offline, lastSeen=2026-07-16T10:00:00Z"),
            Some(&reconnect_failed),
        ));
        assert!(should_persist_runtime_alert_conversation_message(
            "runtime_not_ready",
            Some("status=stopped, lastSeen=unknown"),
            None,
        ));
        assert!(should_persist_runtime_alert_conversation_message(
            "runtime_unavailable",
            None,
            None,
        ));
        assert!(should_persist_runtime_alert_conversation_message(
            "runtime_inspection_failed",
            Some("status=503"),
            None,
        ));
    }

    #[test]
    fn raw_runtime_alert_copy_is_neutral_while_custom_agent_identity_is_preserved() {
        let custom_agent = json!({
            "handle": "reviewer",
            "displayName": "Reviewer",
            "avatarSeed": "reviewer-avatar",
        });

        for (reason, terminal_alert) in [
            ("runtime_not_ready", false),
            ("runtime_not_ready", true),
            ("runtime_unavailable", true),
            ("runtime_inspection_failed", true),
            ("unexpected_runtime_error", true),
        ] {
            let raw_message = runtime_alert_fallback_message(reason, terminal_alert);
            let metadata = build_runtime_alert_conversation_metadata(
                json!({
                    "reason": reason,
                    "message": raw_message,
                }),
                Some(custom_agent.clone()),
            );

            assert!(
                !raw_message.to_ascii_lowercase().contains("octo"),
                "raw controller content must not relabel a custom agent: {raw_message}"
            );
            assert_eq!(metadata["agent"], custom_agent);
            assert_eq!(metadata["details"]["message"], raw_message);
            assert_eq!(metadata["source"], "controller");
            assert_eq!(metadata["kind"], "runtime_alert");
        }
    }

    #[test]
    fn personal_browser_jobs_require_and_preserve_the_explicit_desktop_runtime() {
        let stale_agent_target = Uuid::new_v4();
        let desktop_runtime = Uuid::new_v4();
        let metadata = json!({
            "browserTransport": "desktop-personal",
            "runtimeRouting": {
                "strategy": "spread"
            }
        });

        assert_eq!(
            personal_browser_runtime_id(&metadata, Some(desktop_runtime)).expect("valid routing"),
            Some(desktop_runtime)
        );
        assert_eq!(
            target_runtime_for_agent_job(
                &metadata,
                Some(stale_agent_target),
                Some(desktop_runtime),
            ),
            Some(desktop_runtime)
        );
        assert_eq!(
            target_runtime_for_agent_job(&metadata, Some(stale_agent_target), None),
            None
        );
        assert!(personal_browser_runtime_id(&metadata, None).is_err());
        assert!(!should_retarget_unavailable_runtime(
            "runtime_not_ready",
            Some(desktop_runtime),
        ));
        assert!(!should_retarget_unavailable_runtime(
            "runtime_unavailable",
            Some(desktop_runtime),
        ));
        assert!(should_retarget_unavailable_runtime(
            "runtime_not_ready",
            None,
        ));
    }

    #[test]
    fn personal_browser_metadata_accepts_snake_case_alias() {
        assert!(metadata_uses_personal_browser(&json!({
            "browser_transport": "desktop_personal"
        })));
    }

    #[test]
    fn shared_browser_jobs_require_and_preserve_the_explicit_runtime() {
        let stale_agent_target = Uuid::new_v4();
        let shared_runtime = Uuid::new_v4();
        let metadata = json!({
            "browserTransport": "shared",
            "browserRuntimeId": shared_runtime.to_string(),
            "runtimeRouting": {
                "strategy": "spread"
            }
        });

        assert_eq!(
            shared_browser_runtime_id(&metadata, Some(shared_runtime)).expect("valid routing"),
            Some(shared_runtime)
        );
        assert_eq!(
            target_runtime_for_agent_job(&metadata, Some(stale_agent_target), Some(shared_runtime)),
            Some(shared_runtime)
        );
        assert_eq!(
            target_runtime_for_agent_job(&metadata, Some(stale_agent_target), None),
            None
        );

        let (status, Json(error)) =
            shared_browser_runtime_id(&metadata, None).expect_err("runtimeId is required");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error.message.contains("explicit runtimeId"));
        assert!(!should_retarget_unavailable_runtime(
            "runtime_not_ready",
            Some(shared_runtime),
        ));
        assert!(!should_retarget_unavailable_runtime(
            "runtime_unavailable",
            Some(shared_runtime),
        ));
    }

    #[test]
    fn shared_browser_runtime_attestation_must_match_the_explicit_runtime() {
        let explicit_runtime = Uuid::new_v4();
        let other_runtime = Uuid::new_v4();

        assert_eq!(
            shared_browser_runtime_id(
                &json!({ "browserTransport": "shared" }),
                Some(explicit_runtime),
            )
            .expect("browserRuntimeId is optional"),
            Some(explicit_runtime)
        );

        let (status, Json(error)) = shared_browser_runtime_id(
            &json!({
                "browserTransport": "shared",
                "browserRuntimeId": other_runtime.to_string(),
            }),
            Some(explicit_runtime),
        )
        .expect_err("mismatched browser runtime must fail closed");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error.message.contains("must match runtimeId"));

        let (status, Json(error)) = shared_browser_runtime_id(
            &json!({
                "browser_transport": "shared",
                "browser_runtime_id": "not-a-runtime-id",
            }),
            Some(explicit_runtime),
        )
        .expect_err("invalid browser runtime must fail closed");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error.message.contains("valid UUID"));
    }

    fn normalized_shared_browser_request(metadata: JsonValue) -> DispatchPromptNormalized {
        let mut metadata = metadata;
        if let Some(metadata) = metadata.as_object_mut() {
            metadata
                .entry("browserConsentVersion".to_string())
                .or_insert_with(|| json!(SHARED_BROWSER_CONSENT_VERSION));
        }
        normalize_dispatch_request(DispatchPromptRequest {
            project_id: Some(Uuid::new_v4().to_string()),
            session_id: None,
            prompt_text: Some("Click the visible button.".to_string()),
            intent: None,
            plan_seed: None,
            metadata: Some(metadata),
            conversation_metadata: None,
            parent_conversation_id: None,
            thread_kind: None,
            tool_limits: None,
            repo: None,
            ui: None,
            priority: None,
            runtime_type: None,
            idle_ttl_seconds: None,
            conversation_id: None,
            runtime_id: Some(Uuid::new_v4().to_string()),
            runtime_display_name: None,
            prefer_runtime: Some(true),
        })
        .expect("normalize Shared Browser request")
    }

    #[test]
    fn shared_browser_dispatch_canonicalizes_browser_only_read_only_metadata() {
        let mut request = normalized_shared_browser_request(json!({
            "browserTransport": "shared",
            "agentCollaboration": {
                "requested": false,
                "mode": "thread"
            },
            "runtimeExpectations": {
                "workspaceFileChanges": false,
                "commandExecution": false,
                "browserExecution": true
            }
        }));

        canonicalize_shared_browser_request(&mut request).expect("valid Shared Browser metadata");

        assert_eq!(request.workspace_mode, WORKSPACE_MODE_SHARED_READ);
        assert_eq!(
            request.metadata["browserRuntimeId"],
            request
                .runtime_id
                .expect("normalized request has a runtime")
                .to_string()
        );
        assert_eq!(request.metadata["writeIntent"], false);
        assert_eq!(
            request.metadata["browserConsentVersion"],
            SHARED_BROWSER_CONSENT_VERSION
        );
        assert_eq!(request.metadata["writeScope"]["mode"], "read_only");
        assert_eq!(
            request.metadata["runtimeExpectations"],
            json!({
                "workspaceFileChanges": false,
                "commandExecution": false,
                "genericMcpToolExecution": false,
                "browserExecution": true,
            })
        );
        assert_eq!(request.metadata["runtimeRouting"]["strategy"], "exact");
        assert_eq!(
            request.metadata["runtimeRouting"]["allowUntargetedAcrossPreferredRuntimes"],
            false
        );
        assert_eq!(
            request.metadata["workspaceMode"],
            WORKSPACE_MODE_SHARED_READ
        );
        assert!(request.metadata.get("agentCollaboration").is_none());
        assert!(request.metadata.get("agent_collaboration").is_none());
    }

    #[test]
    fn shared_browser_dispatch_requires_exact_client_consent_version() {
        for invalid in [None, Some(json!(true)), Some(json!(0)), Some(json!(2))] {
            let mut request = normalized_shared_browser_request(json!({
                "browserTransport": "shared",
            }));
            let metadata = request
                .metadata
                .as_object_mut()
                .expect("Shared Browser metadata object");
            metadata.remove("browserConsentVersion");
            if let Some(invalid) = invalid {
                metadata.insert("browserConsentVersion".to_string(), invalid);
            }

            let (status, Json(error)) = canonicalize_shared_browser_request(&mut request)
                .expect_err("old or malformed Shared Browser clients must fail closed");
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert!(error.message.contains("current Studio client"));
        }

        let mut conflicting = normalized_shared_browser_request(json!({
            "browserTransport": "shared",
            "browser_consent_version": 2,
        }));
        let (status, Json(error)) = canonicalize_shared_browser_request(&mut conflicting)
            .expect_err("conflicting consent versions must fail closed");
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(error.message.contains("current Studio client"));
    }

    #[test]
    fn shared_browser_dispatch_rejects_workspace_spread_and_multi_agent_authority() {
        for (metadata, expected_message) in [
            (
                json!({
                    "browserTransport": "shared",
                    "writeIntent": true,
                }),
                "cannot modify workspace files",
            ),
            (
                json!({
                    "browserTransport": "shared",
                    "writeScope": { "mode": "owned", "ownedPaths": ["src/App.tsx"] },
                }),
                "read-only write scope",
            ),
            (
                json!({
                    "browserTransport": "shared",
                    "runtimeRouting": { "strategy": "spread" },
                }),
                "cannot use runtime spread",
            ),
            (
                json!({
                    "browserTransport": "shared",
                    "runtime_routing": { "allow_runtime_spread": "true" },
                }),
                "cannot use runtime spread",
            ),
            (
                json!({
                    "browserTransport": "shared",
                    "multiAgentPlan": { "groupId": Uuid::new_v4(), "role": "worker" },
                }),
                "cannot use multi-agent plans",
            ),
            (
                json!({
                    "browserTransport": "shared",
                    "agentCollaboration": { "requested": true },
                }),
                "cannot use multi-agent planning or fanout",
            ),
            (
                json!({
                    "browserTransport": "shared",
                    "agentCollaboration": { "mode": "team-plan" },
                }),
                "cannot use multi-agent planning or fanout",
            ),
            (
                json!({
                    "browserTransport": "shared",
                    "agent_collaboration": { "kind": "multi_agent" },
                }),
                "cannot use multi-agent planning or fanout",
            ),
            (
                json!({
                    "browserTransport": "shared",
                    "runtimeExpectations": { "commandExecution": true },
                }),
                "cannot execute shell commands",
            ),
            (
                json!({
                    "browserTransport": "shared",
                    "runtimeExpectations": { "browserExecution": false },
                }),
                "require browser execution",
            ),
            (
                json!({
                    "browserTransport": "shared",
                    "agentSelection": {
                        "active": ["octo", "ben"],
                        "mentions": ["octo", "ben"]
                    },
                }),
                "exactly one agent",
            ),
        ] {
            let mut request = normalized_shared_browser_request(metadata);
            let (status, Json(error)) = canonicalize_shared_browser_request(&mut request)
                .expect_err("conflicting Shared Browser authority must fail closed");
            assert_eq!(status, StatusCode::BAD_REQUEST);
            assert!(
                error.message.contains(expected_message),
                "unexpected Shared Browser rejection: {}",
                error.message
            );
        }
    }

    #[test]
    fn shared_browser_runtime_requires_a_recent_agent_and_origin() {
        let capabilities = json!({
            "agent": true,
            "origin": true,
            "_instafySharedBrowserAgentConsent": { "version": 1 },
        });
        assert!(shared_browser_runtime_is_dispatchable(
            "ready",
            Some(Utc::now()),
            &capabilities,
        ));
        assert!(shared_browser_runtime_is_dispatchable(
            "running",
            Some(Utc::now()),
            &capabilities,
        ));
        assert!(!shared_browser_runtime_is_dispatchable(
            "requested",
            Some(Utc::now()),
            &capabilities,
        ));
        assert!(!shared_browser_runtime_is_dispatchable(
            "ready",
            Some(Utc::now() - ChronoDuration::seconds(91)),
            &capabilities,
        ));
        assert!(!shared_browser_runtime_is_dispatchable(
            "ready",
            Some(Utc::now()),
            &json!({ "agent": true }),
        ));
        assert!(!shared_browser_runtime_is_dispatchable(
            "ready",
            Some(Utc::now()),
            &json!({ "agent": true, "origin": true }),
        ));
        assert!(!shared_browser_runtime_is_dispatchable(
            "ready",
            Some(Utc::now()),
            &json!({
                "agent": true,
                "origin": true,
                "_instafySharedBrowserAgentConsent": { "version": 2 },
            }),
        ));
    }

    #[test]
    fn personal_browser_runtime_owner_requires_controller_attestation() {
        let owner_user_id = Uuid::new_v4();
        assert_eq!(
            personal_browser_owner_user_id(&json!({
                "personalBrowser": {
                    "enabled": true,
                    "ownerUserId": owner_user_id.to_string(),
                }
            })),
            Some(owner_user_id)
        );
        assert_eq!(
            personal_browser_owner_user_id(&json!({
                "personalBrowser": {
                    "enabled": false,
                    "ownerUserId": owner_user_id.to_string(),
                }
            })),
            None
        );
        assert_eq!(
            personal_browser_owner_user_id(&json!({
                "personalBrowser": {
                    "enabled": true,
                    "ownerUserId": "not-a-user-id",
                }
            })),
            None
        );
    }

    #[test]
    fn personal_browser_runtime_target_is_private_even_without_transport_metadata() {
        let owner = Uuid::new_v4();
        let teammate = Uuid::new_v4();
        let capabilities = json!({
            "personalBrowser": {
                "enabled": true,
                "ownerUserId": owner.to_string(),
            }
        });

        assert!(personal_browser_target_owner_is_authorized(
            &capabilities,
            Some(owner),
            true
        ));
        assert!(!personal_browser_target_owner_is_authorized(
            &capabilities,
            Some(teammate),
            true
        ));
        assert!(!personal_browser_target_owner_is_authorized(
            &capabilities,
            None,
            true
        ));
        assert!(!personal_browser_target_owner_is_authorized(
            &capabilities,
            Some(owner),
            false
        ));
        assert!(personal_browser_target_owner_is_authorized(
            &json!({ "agent": true }),
            Some(teammate),
            false
        ));
    }

    #[test]
    fn normalize_dispatch_request_preserves_explicit_isolated_workspace_mode() {
        let request = DispatchPromptRequest {
            project_id: Some(Uuid::new_v4().to_string()),
            session_id: None,
            prompt_text: Some("Refactor the billing controller.".to_string()),
            intent: None,
            plan_seed: None,
            metadata: Some(json!({
                "workspaceMode": "isolated_write"
            })),
            conversation_metadata: None,
            parent_conversation_id: None,
            thread_kind: None,
            tool_limits: None,
            repo: None,
            ui: None,
            priority: None,
            runtime_type: None,
            idle_ttl_seconds: None,
            conversation_id: None,
            runtime_id: None,
            runtime_display_name: None,
            prefer_runtime: None,
        };

        let normalized = normalize_dispatch_request(request).expect("normalize");

        assert_eq!(normalized.workspace_mode, WORKSPACE_MODE_ISOLATED_WRITE);
    }

    #[test]
    fn normalize_dispatch_request_rejects_invalid_project() {
        let request = DispatchPromptRequest {
            project_id: Some("not-a-uuid".to_string()),
            session_id: None,
            prompt_text: Some("text".to_string()),
            intent: None,
            plan_seed: None,
            metadata: None,
            conversation_metadata: None,
            parent_conversation_id: None,
            thread_kind: None,
            tool_limits: None,
            repo: None,
            ui: None,
            priority: None,
            runtime_type: None,
            idle_ttl_seconds: None,
            conversation_id: None,
            runtime_id: None,
            runtime_display_name: None,
            prefer_runtime: None,
        };

        let error = normalize_dispatch_request(request).unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
    }

    #[test]
    fn normalize_progress_percent_clamps_and_rounds() {
        assert_eq!(normalize_progress_percent(Some(-10.0)), Some(0));
        assert_eq!(normalize_progress_percent(Some(12.4)), Some(12));
        assert_eq!(normalize_progress_percent(Some(12.6)), Some(13));
        assert_eq!(normalize_progress_percent(Some(150.0)), Some(100));
        assert_eq!(normalize_progress_percent(Some(f64::NAN)), None);
    }

    #[test]
    fn extract_agent_selection_handles_prefers_mentions_and_dedupes() {
        let metadata = serde_json::json!({
            "agentSelection": {
                "active": ["octo", "sloth"],
                "mentions": ["sloth", "octo", "sloth", "bad handle"]
            }
        });

        let handles = extract_agent_selection_handles(&metadata);
        assert_eq!(handles, vec!["sloth".to_string(), "octo".to_string()]);
    }

    #[test]
    fn extract_agent_selection_handles_uses_active_when_mentions_empty() {
        let metadata = serde_json::json!({
            "agentSelection": {
                "active": ["Octo", "sloth", "sloth"],
                "mentions": []
            }
        });

        let handles = extract_agent_selection_handles(&metadata);
        assert_eq!(handles, vec!["octo".to_string(), "sloth".to_string()]);
    }

    #[test]
    fn extract_agent_selection_handles_falls_back_to_octo() {
        let metadata = serde_json::json!({
            "agentSelection": {
                "active": ["***"],
                "mentions": ["!"]
            }
        });

        let handles = extract_agent_selection_handles(&metadata);
        assert_eq!(handles, vec!["octo".to_string()]);
    }

    #[test]
    fn has_explicit_agent_mentions_ignores_active_only_selection() {
        let metadata = serde_json::json!({
            "agentSelection": {
                "active": ["octo"],
                "mentions": []
            }
        });

        assert!(!has_explicit_agent_mentions(&metadata));
    }

    #[test]
    fn extract_agent_selection_prompt_segments_uses_active_fanout_metadata() {
        let metadata = serde_json::json!({
            "agentSelection": {
                "active": ["sec-front", "sec-api"],
                "mentions": [],
                "promptSegments": {
                    "sec-front": "Read-only frontend security audit.",
                    "@sec-api": {
                        "prompt": "Read-only controller API security audit."
                    },
                    "unknown": "ignored"
                }
            }
        });
        let handles = vec!["sec-front".to_string(), "sec-api".to_string()];

        let segments = extract_agent_selection_prompt_segments(&metadata, &handles);

        assert_eq!(
            segments.get("sec-front").map(String::as_str),
            Some("Read-only frontend security audit.")
        );
        assert_eq!(
            segments.get("sec-api").map(String::as_str),
            Some("Read-only controller API security audit.")
        );
        assert!(!segments.contains_key("unknown"));
    }

    #[test]
    fn build_prompt_segments_by_handle_splits_explicit_multi_agent_prompt() {
        let handles = vec!["ben".to_string(), "octo".to_string()];
        let segments = build_prompt_segments_by_handle(
            "@ben what is 2+2? @octo write a one-line ocean poem.",
            &handles,
        );

        assert_eq!(
            segments.get("ben").map(String::as_str),
            Some("@ben what is 2+2?")
        );
        assert_eq!(
            segments.get("octo").map(String::as_str),
            Some("@octo write a one-line ocean poem.")
        );
    }

    #[test]
    fn build_prompt_segments_by_handle_ignores_unselected_mentions() {
        let handles = vec!["octo".to_string()];
        let segments = build_prompt_segments_by_handle(
            "@ben what is 2+2? @octo write a one-line ocean poem.",
            &handles,
        );

        assert_eq!(
            segments.get("octo").map(String::as_str),
            Some("@octo write a one-line ocean poem.")
        );
        assert!(!segments.contains_key("ben"));
    }

    #[test]
    fn build_prompt_segments_by_handle_ignores_email_like_at_text() {
        let handles = vec!["octo".to_string()];
        let segments = build_prompt_segments_by_handle("Email ops@octo.dev today.", &handles);

        assert!(segments.is_empty());
    }

    #[test]
    fn build_prompt_segments_by_handle_keeps_cli_agent_argument_as_full_prompt() {
        let handles = vec!["octo".to_string()];
        let prompt =
            "Run `instafy agents context list --agent @octo --query \"device-provider serial\" --json`.";
        let segments = build_prompt_segments_by_handle(prompt, &handles);

        assert!(segments.is_empty());
    }

    #[test]
    fn build_prompt_segments_by_handle_does_not_scope_mid_sentence_mentions() {
        let handles = vec!["octo".to_string()];
        let segments =
            build_prompt_segments_by_handle("Please ask @octo to inspect this later.", &handles);

        assert!(segments.is_empty());
    }

    #[test]
    fn build_prompt_segments_by_handle_falls_back_when_segment_has_only_mentions() {
        let handles = vec!["ben".to_string(), "octo".to_string()];
        let prompt = "@ben @octo";
        let segments = build_prompt_segments_by_handle(prompt, &handles);

        assert_eq!(segments.get("ben").map(String::as_str), Some(prompt));
        assert_eq!(segments.get("octo").map(String::as_str), Some(prompt));
    }

    #[test]
    fn apply_agent_prompt_segment_scopes_request_to_target_agent() {
        let project_id = Uuid::new_v4();
        let request = DispatchPromptRequest {
            project_id: Some(project_id.to_string()),
            session_id: None,
            prompt_text: Some("@ben what is 3+3? @octo write a one-line forest poem.".to_string()),
            intent: None,
            plan_seed: None,
            metadata: None,
            conversation_metadata: None,
            parent_conversation_id: None,
            thread_kind: None,
            tool_limits: None,
            repo: None,
            ui: None,
            priority: None,
            runtime_type: None,
            idle_ttl_seconds: None,
            conversation_id: None,
            runtime_id: None,
            runtime_display_name: None,
            prefer_runtime: None,
        };
        let mut normalized = normalize_dispatch_request(request).expect("normalize");
        let handles = vec!["ben".to_string(), "octo".to_string()];
        let segments = build_prompt_segments_by_handle(&normalized.prompt_text, &handles);
        let target = AgentTarget {
            handle: "octo".to_string(),
            agent_id: None,
            credential_id: None,
            runtime_id: None,
            display_name: None,
            description: None,
            avatar_seed: None,
        };

        apply_agent_prompt_segment(&mut normalized, &segments, &target);

        assert_eq!(
            normalized.prompt_text,
            "@octo write a one-line forest poem."
        );
    }

    #[test]
    fn run_ai_access_metadata_records_byoc_authoritatively() {
        let existing = json!({
            "custom": true,
            "aiAccessMode": "managed",
            "managedAiUsed": true,
        });

        let merged = merge_ai_access_metadata(Some(&existing), false, false);

        assert_eq!(merged["custom"], json!(true));
        assert_eq!(merged["aiAccessMode"], json!("byoc"));
        assert_eq!(merged["managedAiUsed"], json!(false));
    }

    #[test]
    fn run_ai_access_metadata_records_deferred_managed_access_without_usage() {
        let merged = merge_ai_access_metadata(None, true, false);

        assert_eq!(merged["aiAccessMode"], json!("managed"));
        assert_eq!(merged["managedAiUsed"], json!(false));
    }

    #[test]
    fn run_ai_access_metadata_records_managed_authoritatively() {
        let existing = json!({
            "aiAccessMode": "byoc",
            "managedAiUsed": false,
        });

        let merged = merge_ai_access_metadata(Some(&existing), true, true);

        assert_eq!(merged["aiAccessMode"], json!("managed"));
        assert_eq!(merged["managedAiUsed"], json!(true));
    }

    #[test]
    fn silent_decline_opt_in_is_restricted_to_automation_threads() {
        assert!(should_mark_silent_automation_decline(
            true,
            Some("automation"),
            Some("automation"),
        ));
        assert!(!should_mark_silent_automation_decline(
            false,
            Some("automation"),
            Some("automation"),
        ));
        assert!(!should_mark_silent_automation_decline(
            true,
            None,
            Some("automation"),
        ));
        assert!(!should_mark_silent_automation_decline(
            true,
            Some("automation"),
            Some("standard"),
        ));
    }
}
