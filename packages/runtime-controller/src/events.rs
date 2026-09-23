use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::Query;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use futures_util::StreamExt;
use serde::Deserialize;
use tokio_stream::wrappers::{errors::BroadcastStreamRecvError, BroadcastStream};
use tracing::{debug, info, instrument, warn};

use crate::auth::{authenticate_request, RequestContext};
use crate::conversations::{ensure_conversation_access, load_conversation_record};
use crate::errors::ApiError;
use crate::projects::{
    ensure_project_access, parse_optional_uuid_param, require_org_access, resolve_scope,
    ScopeParams, MEMBERS_CHANGED_PROJECT_MEMBERSHIP, PROJECT_MEMBERS_CHANGED_EVENT,
};
use crate::state::{AppState, ControllerEvent};
use crate::{database_unavailable, forbidden, load_project_record, too_many_requests};

mod private_runtime_visibility;

const PROJECT_ACCESS_CHANGED_EVENT: &str = "project.access_changed";

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/events", get(events_stream))
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EventsQuery {
    project_id: Option<String>,
    session_id: Option<String>,
    run_id: Option<String>,
    kind: Option<String>,
    #[serde(default)]
    kinds: Vec<String>,
    #[serde(rename = "conversationId", alias = "conversation_id")]
    conversation_id: Option<String>,
}

#[derive(Debug, Clone)]
struct EventFilters {
    project_id: uuid::Uuid,
    session_id: Option<uuid::Uuid>,
    run_id: Option<uuid::Uuid>,
    conversation_id: Option<uuid::Uuid>,
    kinds: Vec<String>,
}

#[instrument(skip(state, headers))]
async fn events_stream(
    axum::extract::State(state): axum::extract::State<AppState>,
    headers: HeaderMap,
    Query(params): Query<EventsQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let filters = build_event_filters(&state, params, &context).await?;

    let permit = if !state.config.dev_mode && !context.is_service_role {
        if let Some(user_id) = context.user_id {
            state
                .connection_limiter
                .try_acquire(format!("events:user:{user_id}"), 4)
                .await
        } else {
            None
        }
    } else {
        None
    };

    if !state.config.dev_mode
        && !context.is_service_role
        && context.user_id.is_some()
        && permit.is_none()
    {
        return Err(too_many_requests(
            "Too many open event streams. Close other Instafy tabs and try again.",
        ));
    }

    // Watch before subscribing, so no project signal published after the
    // subscription skips this node's broadcast.
    let watch = Arc::new(state.events.watch_project(filters.project_id));
    let receiver = state.events.subscribe();
    let filters = Arc::new(filters);
    let context = Arc::new(context);
    let permit = Arc::new(permit);
    info!(
        project_id = %filters.project_id,
        session_id = ?filters.session_id,
        run_id = ?filters.run_id,
        conversation_id = ?filters.conversation_id,
        kinds = ?filters.kinds,
        service_role = context.is_service_role,
        user_id = ?context.user_id,
        "events stream subscribed"
    );

    let stream = BroadcastStream::new(receiver).filter_map(move |result| {
        let filters = filters.clone();
        let state = state.clone();
        let context = context.clone();
        let permit = permit.clone();
        let watch = watch.clone();
        async move {
            // Keep the connection permit and the project watch alive for as
            // long as the response stream.
            let _permit = &permit;
            let _watch = &watch;
            match result {
                Ok(event) => {
                    if !filters.matches(&event) {
                        return None;
                    }
                    if !event_targets_context(&event, &context) {
                        return None;
                    }
                    // The stream can outlive the membership that authorized the
                    // initial request. Recheck current project access before
                    // every matching event, including project-wide events with
                    // no conversation id, then apply private-conversation
                    // visibility. This suppresses all content as soon as a
                    // revoked subscriber's next matching event is published.
                    // The sole exception is a server-targeted, non-sensitive
                    // access invalidation for that same human user. It must be
                    // deliverable after revocation so an already-open client
                    // can immediately fail closed and refetch authoritative
                    // capabilities.
                    if !is_targeted_access_invalidation(&event, &context) {
                        if let Err((status, Json(error))) = ensure_event_delivery_access(
                            &state,
                            filters.project_id,
                            filters.session_id,
                            event.conversation_id,
                            &event,
                            &context,
                        )
                        .await
                        {
                            if status.is_server_error() {
                                warn!(
                                    %status,
                                    conversation_id = ?event.conversation_id,
                                    project_id = %filters.project_id,
                                    error = %error.message,
                                    "failed to authorize controller event; dropping it"
                                );
                            } else {
                                debug!(
                                    %status,
                                    conversation_id = ?event.conversation_id,
                                    project_id = %filters.project_id,
                                    "controller event is not visible to subscriber; dropping it"
                                );
                            }
                            return None;
                        }
                    }
                    match SseEvent::default().json_data(&event) {
                        Ok(payload) => Some(Ok::<SseEvent, Infallible>(payload)),
                        Err(error) => {
                            warn!(?error, "failed to encode controller event");
                            None
                        }
                    }
                }
                Err(BroadcastStreamRecvError::Lagged(skipped)) => {
                    warn!(
                        lagged = skipped,
                        "controller event stream lagged; dropping events"
                    );
                    None
                }
            }
        }
    });

    Ok(Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    ))
}

fn event_targets_context(event: &ControllerEvent, context: &RequestContext) -> bool {
    event
        .target_user_id
        .map(|target_user_id| context.user_id == Some(target_user_id))
        .unwrap_or(true)
}

fn is_targeted_access_invalidation(event: &ControllerEvent, context: &RequestContext) -> bool {
    is_canonical_access_invalidation(event) && event_targets_context(event, context)
}

fn is_canonical_access_invalidation(event: &ControllerEvent) -> bool {
    event.kind == PROJECT_ACCESS_CHANGED_EVENT
        && event.session_id.is_none()
        && event.conversation_id.is_none()
        && event.run_id.is_none()
        && event.job_id.is_none()
        && event.channel.is_none()
        && event.channels.is_empty()
        && event.target_user_id.is_some()
        && event.data == serde_json::json!({ "reason": "membership_changed" })
}

impl EventFilters {
    fn matches(&self, event: &ControllerEvent) -> bool {
        if is_canonical_access_invalidation(event) {
            let project_matches = event
                .project_id
                .map(|project_id| project_id == self.project_id)
                .unwrap_or(true);
            return project_matches
                && (self.kinds.is_empty() || self.kinds.iter().any(|kind| kind == &event.kind));
        }
        if event.project_id != Some(self.project_id) {
            return false;
        }
        if let Some(expected_session) = self.session_id {
            if event.session_id != Some(expected_session) {
                return false;
            }
        }
        if let Some(expected_conversation) = self.conversation_id {
            if event.conversation_id != Some(expected_conversation) {
                return false;
            }
        }
        if let Some(expected_run) = self.run_id {
            if event.run_id != Some(expected_run) {
                return false;
            }
        }
        if !self.kinds.is_empty() && !self.kinds.iter().any(|kind| kind == &event.kind) {
            return false;
        }
        true
    }
}

async fn build_event_filters(
    state: &AppState,
    params: EventsQuery,
    context: &RequestContext,
) -> Result<EventFilters, (StatusCode, Json<ApiError>)> {
    let EventsQuery {
        project_id,
        session_id,
        run_id,
        kind,
        kinds,
        conversation_id,
    } = params;

    let scope = resolve_scope(
        state,
        ScopeParams {
            project_id,
            session_id,
            run_id,
        },
        context,
    )
    .await?;

    let kinds = normalize_event_kinds(kind, kinds);
    let conversation_id = parse_optional_uuid_param(conversation_id, "conversationId")?;
    if let Some(conversation_id) = conversation_id {
        ensure_event_access(
            state,
            scope.project.id,
            scope.session_id,
            Some(conversation_id),
            context,
        )
        .await?;
    }

    Ok(EventFilters {
        project_id: scope.project.id,
        session_id: scope.session_id,
        run_id: scope.run_id,
        conversation_id,
        kinds,
    })
}

pub(crate) async fn ensure_event_access(
    state: &AppState,
    project_id: uuid::Uuid,
    session_id: Option<uuid::Uuid>,
    conversation_id: Option<uuid::Uuid>,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    ensure_event_access_inner(
        state,
        project_id,
        session_id,
        conversation_id,
        None,
        context,
    )
    .await
}

async fn ensure_event_delivery_access(
    state: &AppState,
    project_id: uuid::Uuid,
    session_id: Option<uuid::Uuid>,
    conversation_id: Option<uuid::Uuid>,
    event: &ControllerEvent,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    ensure_event_access_inner(
        state,
        project_id,
        session_id,
        conversation_id,
        Some(event),
        context,
    )
    .await
}

async fn ensure_event_access_inner(
    state: &AppState,
    project_id: uuid::Uuid,
    session_id: Option<uuid::Uuid>,
    conversation_id: Option<uuid::Uuid>,
    event: Option<&ControllerEvent>,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Conversation event access", error))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| database_unavailable("Controller event access", error))?;

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_access(&transaction, &project, context, session_id).await?;

    if let Some(conversation_id) = conversation_id {
        let conversation = load_conversation_record(&transaction, &conversation_id).await?;
        if conversation.project_id != project_id {
            return Err(forbidden("conversation does not belong to this project"));
        }
        ensure_conversation_access(&transaction, &conversation, context).await?;
    }

    if let Some(event) = event {
        private_runtime_visibility::ensure_visible(state, &transaction, project_id, event, context)
            .await?;
        ensure_org_roster_signal_visible(&transaction, &project, event, context).await?;
    }

    transaction
        .commit()
        .await
        .map_err(|error| database_unavailable("Controller event access", error))?;
    Ok(())
}

/// An org roster change reaches only subscribers who can read the org
/// directory (`require_org_access`): a project guest must not learn that or
/// when the org roster changed. Every `project.members_changed` except the
/// space's own `project_membership` counts as an org roster change, and any
/// error, including a failed membership query, drops the event.
async fn ensure_org_roster_signal_visible(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &crate::ProjectRecord,
    event: &ControllerEvent,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if event.kind != PROJECT_MEMBERS_CHANGED_EVENT
        || event.data.get("reason").and_then(serde_json::Value::as_str)
            == Some(MEMBERS_CHANGED_PROJECT_MEMBERSHIP)
    {
        return Ok(());
    }
    let Some(org_id) = project.org_id else {
        return Err(forbidden(
            "organization roster changes need an organization",
        ));
    };
    require_org_access(transaction, &org_id, context)
        .await
        .map(|_| ())
}

fn normalize_event_kinds(kind: Option<String>, mut kinds: Vec<String>) -> Vec<String> {
    let mut values = Vec::new();
    if let Some(single) = kind {
        let trimmed = single.trim();
        if !trimmed.is_empty() {
            values.push(trimmed.to_string());
        }
    }

    for value in kinds.drain(..) {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            values.push(trimmed.to_string());
        }
    }

    values.sort();
    values.dedup();
    values
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use serde_json::json;
    use uuid::Uuid;

    fn targeted_event(kind: &str, target_user_id: Uuid) -> ControllerEvent {
        ControllerEvent {
            kind: kind.to_string(),
            project_id: Some(Uuid::new_v4()),
            session_id: None,
            conversation_id: None,
            run_id: None,
            job_id: None,
            channel: None,
            channels: Vec::new(),
            target_user_id: Some(target_user_id),
            data: json!({ "reason": "membership_changed" }),
            timestamp: Utc::now(),
        }
    }

    fn user_context(user_id: Uuid) -> RequestContext {
        RequestContext {
            user_id: Some(user_id),
            is_service_role: false,
            scoped_claims: None,
        }
    }

    #[test]
    fn access_invalidation_bypass_is_exactly_kind_and_target_scoped() {
        let target_user_id = Uuid::new_v4();
        let other_user_id = Uuid::new_v4();
        let access_event = targeted_event(PROJECT_ACCESS_CHANGED_EVENT, target_user_id);

        assert!(event_targets_context(
            &access_event,
            &user_context(target_user_id)
        ));
        assert!(is_targeted_access_invalidation(
            &access_event,
            &user_context(target_user_id)
        ));
        assert!(!event_targets_context(
            &access_event,
            &user_context(other_user_id)
        ));
        assert!(!is_targeted_access_invalidation(
            &access_event,
            &user_context(other_user_id)
        ));

        let ordinary_event = targeted_event("conversation.message_created", target_user_id);
        assert!(event_targets_context(
            &ordinary_event,
            &user_context(target_user_id)
        ));
        assert!(!is_targeted_access_invalidation(
            &ordinary_event,
            &user_context(target_user_id)
        ));

        let mut sensitive_payload = access_event.clone();
        sensitive_payload.data = json!({
            "reason": "membership_changed",
            "role": "owner"
        });
        assert!(!is_targeted_access_invalidation(
            &sensitive_payload,
            &user_context(target_user_id)
        ));

        let mut conversation_scoped = access_event.clone();
        conversation_scoped.conversation_id = Some(Uuid::new_v4());
        assert!(!is_targeted_access_invalidation(
            &conversation_scoped,
            &user_context(target_user_id)
        ));

        let project_id = access_event.project_id.expect("project-scoped event");
        let filters = EventFilters {
            project_id,
            session_id: None,
            run_id: None,
            conversation_id: None,
            kinds: vec![PROJECT_ACCESS_CHANGED_EVENT.to_string()],
        };
        assert!(filters.matches(&access_event));

        let mut global_access_event = access_event.clone();
        global_access_event.project_id = None;
        assert!(filters.matches(&global_access_event));
        assert!(is_targeted_access_invalidation(
            &global_access_event,
            &user_context(target_user_id)
        ));

        let mut malformed_global_event = sensitive_payload;
        malformed_global_event.project_id = None;
        assert!(!filters.matches(&malformed_global_event));

        let scoped_filters = EventFilters {
            project_id,
            session_id: Some(Uuid::new_v4()),
            run_id: Some(Uuid::new_v4()),
            conversation_id: Some(Uuid::new_v4()),
            kinds: vec![PROJECT_ACCESS_CHANGED_EVENT.to_string()],
        };
        assert!(scoped_filters.matches(&access_event));
        assert!(scoped_filters.matches(&global_access_event));

        let mut other_project_event = access_event.clone();
        other_project_event.project_id = Some(Uuid::new_v4());
        assert!(!scoped_filters.matches(&other_project_event));
    }
}
