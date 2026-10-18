use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
use crate::state::{AppState, ControllerEvent, ACCESS_CHANGED_SPACE_DELETED};
use crate::{database_unavailable, forbidden, load_project_record};

mod private_runtime_visibility;

const PROJECT_ACCESS_CHANGED_EVENT: &str = "project.access_changed";

/// Open event streams one user may hold on one controller node. Every Studio
/// tab, Desktop window and phone holds one, so four refused the fifth tab of
/// an ordinary session. A stream is cheap to hold: a receiver on the node's
/// shared broadcast, a project watch count and a keep-alive every 15 s (Redis
/// is one subscription per node, not per stream). It costs the pool when fed:
/// an event it matches takes a connection for an access check, at most once
/// per conversation per `EVENT_ACCESS_RECHECK_AFTER`, and on every runtime,
/// origin, tunnel, workspace or roster event. Streams do not share those
/// checks, so one user's eight streams on one space can ask for eight
/// connections for a single event: more than the pool holds (6 in
/// production, 4 by default, `DATABASE_POOL_SIZE`). The checks past the pool
/// wait for a connection (up to its 10 s timeout, then one retry, then the
/// event is dropped for that stream), and other requests on the node wait
/// behind them. Eight is sized for a handful of tabs, Desktop and a phone,
/// plus a tab whose last stream has not closed yet, not to fit the pool.
pub(crate) const MAX_EVENT_STREAMS_PER_USER: usize = 8;

/// How long a stream refused for [`MAX_EVENT_STREAMS_PER_USER`] is asked to
/// wait (`Retry-After`). The client doubles it on each refusal in a row.
pub(crate) const EVENT_STREAM_RETRY_AFTER_SECS: u64 = 10;

/// The `code` of that refusal.
pub(crate) const TOO_MANY_EVENT_STREAMS_CODE: &str = "too_many_event_streams";

fn event_stream_limit_key(user_id: uuid::Uuid) -> String {
    format!("events:user:{user_id}")
}

/// The answer to a stream over [`MAX_EVENT_STREAMS_PER_USER`]: a 429 that
/// says how long to wait, so a refused tab backs off instead of asking again
/// every few seconds.
fn too_many_event_streams() -> axum::response::Response {
    (
        StatusCode::TOO_MANY_REQUESTS,
        [(
            axum::http::header::RETRY_AFTER,
            EVENT_STREAM_RETRY_AFTER_SECS.to_string(),
        )],
        Json(ApiError {
            message: "Too many open event streams. Close other Instafy tabs and try again."
                .to_string(),
            code: Some(TOO_MANY_EVENT_STREAMS_CODE.to_string()),
            details: None,
        }),
    )
        .into_response()
}

/// The access checks one stream has passed lately, by conversation (`None`
/// for an event of the project as a whole), so a burst of events takes one
/// check, not one pool connection per event. A check holds for
/// `AppConfig::event_access_recheck_after`; an access change the stream sees
/// drops them all.
#[derive(Default)]
struct RecentAccess {
    passed: Mutex<HashMap<Option<uuid::Uuid>, Instant>>,
}

impl RecentAccess {
    fn holds(
        &self,
        conversation_id: Option<uuid::Uuid>,
        now: Instant,
        for_how_long: Duration,
    ) -> bool {
        self.passed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(&conversation_id)
            .is_some_and(|passed_at| now.saturating_duration_since(*passed_at) < for_how_long)
    }

    fn record(&self, conversation_id: Option<uuid::Uuid>, now: Instant, for_how_long: Duration) {
        let mut passed = self
            .passed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        passed.retain(|_, passed_at| now.saturating_duration_since(*passed_at) < for_how_long);
        passed.insert(conversation_id, now);
    }

    fn forget(&self) {
        self.passed
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }
}

/// Whether `event` can change who may read the project, so the stream checks
/// access afresh for it and the events after it.
fn changes_access(event: &ControllerEvent) -> bool {
    event.kind == PROJECT_ACCESS_CHANGED_EVENT || event.kind == PROJECT_MEMBERS_CHANGED_EVENT
}

/// Whether delivering `event` reads the database beyond the stream's project
/// and conversation access: a runtime, origin, tunnel or local workspace it
/// refers to, or the organization roster.
fn event_needs_lookup(event: &ControllerEvent, context: &RequestContext) -> bool {
    private_runtime_visibility::needs_lookup(event, context)
        || (event.kind == PROJECT_MEMBERS_CHANGED_EVENT
            && event.data.get("reason").and_then(serde_json::Value::as_str)
                != Some(MEMBERS_CHANGED_PROJECT_MEMBERSHIP))
}

/// Runs an access check once more when the database was only briefly out of
/// reach (503, such as a pool wait that timed out), so a busy moment does not
/// cost the subscriber the event. Any other answer stands.
async fn retry_once_if_unavailable<T, F, Fut>(
    mut check: F,
) -> Result<T, (StatusCode, Json<ApiError>)>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<T, (StatusCode, Json<ApiError>)>>,
{
    match check().await {
        Err((status, _)) if status == StatusCode::SERVICE_UNAVAILABLE => check().await,
        answer => answer,
    }
}

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
) -> Result<axum::response::Response, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;

    // Before any database read, so a refused tab costs a token check and
    // nothing more each time it asks.
    let permit = match context.user_id {
        Some(user_id) if !state.config.dev_mode && !context.is_service_role => {
            let Some(permit) = state
                .connection_limiter
                .try_acquire(event_stream_limit_key(user_id), MAX_EVENT_STREAMS_PER_USER)
                .await
            else {
                debug!(%user_id, "event stream refused: too many open streams");
                return Ok(too_many_event_streams());
            };
            Some(permit)
        }
        _ => None,
    };

    let filters = build_event_filters(&state, params, &context).await?;

    // Watch before subscribing, so no project signal published after the
    // subscription skips this node's broadcast.
    let watch = Arc::new(state.events.watch_project(filters.project_id));
    let receiver = state.events.subscribe();
    let filters = Arc::new(filters);
    let context = Arc::new(context);
    let permit = Arc::new(permit);
    let recent_access = Arc::new(RecentAccess::default());
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
        let recent_access = recent_access.clone();
        async move {
            // Keep the connection permit and the project watch alive for as
            // long as the response stream.
            let _permit = &permit;
            let _watch = &watch;
            match result {
                Ok(mut event) => {
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
                    if changes_access(&event) {
                        recent_access.forget();
                    }
                    // The project and conversation access this stream passed
                    // within `event_access_recheck_after` still holds for an
                    // event that needs no lookup of its own.
                    let now = Instant::now();
                    let recheck_after = state.config.event_access_recheck_after;
                    let access_holds =
                        recent_access.holds(event.conversation_id, now, recheck_after)
                            && !event_needs_lookup(&event, &context);
                    if !is_targeted_access_invalidation(&event, &context) && !access_holds {
                        let checked = retry_once_if_unavailable(|| {
                            ensure_event_delivery_access(
                                &state,
                                filters.project_id,
                                filters.session_id,
                                event.conversation_id,
                                &event,
                                &context,
                            )
                        })
                        .await;
                        match checked {
                            Ok(Some(projected)) => {
                                recent_access.record(event.conversation_id, now, recheck_after);
                                event = projected;
                            }
                            Ok(None) => {
                                recent_access.record(event.conversation_id, now, recheck_after);
                            }
                            Err((status, Json(error))) => {
                                recent_access.forget();
                                if status.is_server_error() {
                                    warn!(
                                        %status,
                                        kind = %event.kind,
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

    Ok(Sse::new(stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        )
        .into_response())
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
        && (event.data == serde_json::json!({ "reason": "membership_changed" })
            || is_space_deleted_invalidation(event))
}

/// A space deletion's invalidation (`publish_project_deleted`): no project,
/// and exactly the reason and the deleted space's id.
fn is_space_deleted_invalidation(event: &ControllerEvent) -> bool {
    event.project_id.is_none()
        && event.data.as_object().is_some_and(|data| {
            data.len() == 2
                && data.get("reason").and_then(serde_json::Value::as_str)
                    == Some(ACCESS_CHANGED_SPACE_DELETED)
                && data
                    .get("projectId")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|project_id| uuid::Uuid::parse_str(project_id).is_ok())
        })
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
    .map(|_| ())
}

async fn ensure_event_delivery_access(
    state: &AppState,
    project_id: uuid::Uuid,
    session_id: Option<uuid::Uuid>,
    conversation_id: Option<uuid::Uuid>,
    event: &ControllerEvent,
    context: &RequestContext,
) -> Result<Option<ControllerEvent>, (StatusCode, Json<ApiError>)> {
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
) -> Result<Option<ControllerEvent>, (StatusCode, Json<ApiError>)> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Conversation event access", error))?;
    let mut transaction = connection
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

    let mut projected = None;
    if let Some(event) = event {
        if let Err(error) = private_runtime_visibility::ensure_visible(
            state,
            &transaction,
            project_id,
            event,
            context,
        )
        .await
        {
            // Runtime privacy must not strand a conversation's run as queued.
            // Only this payload-level denial can use a basic lifecycle view;
            // project/conversation denials and database failures still fail closed.
            if error.0 != StatusCode::FORBIDDEN {
                return Err(error);
            }
            projected = project_run_lifecycle(&mut transaction, project_id, event).await?;
            if projected.is_none() {
                return Err(error);
            }
        }
        ensure_org_roster_signal_visible(&transaction, &project, event, context).await?;
    }

    transaction
        .commit()
        .await
        .map_err(|error| database_unavailable("Controller event access", error))?;
    Ok(projected)
}

async fn project_run_lifecycle(
    transaction: &mut tokio_postgres::Transaction<'_>,
    project_id: uuid::Uuid,
    event: &ControllerEvent,
) -> Result<Option<ControllerEvent>, (StatusCode, Json<ApiError>)> {
    if !matches!(
        event.kind.as_str(),
        "run.queued" | "run.progress" | "run.completed"
    ) {
        return Ok(None);
    }
    let (Some(run_id), Some(conversation_id)) = (event.run_id, event.conversation_id) else {
        return Ok(None);
    };
    let Some(run) = crate::runs::load_run_snapshot(transaction, &run_id).await? else {
        return Ok(None);
    };
    if event.project_id != Some(project_id)
        || run.project_id != Some(project_id)
        || run.conversation_id != Some(conversation_id)
    {
        return Ok(None);
    }

    // Read current status rather than replaying a stale progress payload after
    // completion. Never copy free-form data or routing from the original event.
    Ok(Some(ControllerEvent {
        kind: event.kind.clone(),
        project_id: Some(project_id),
        conversation_id: Some(conversation_id),
        run_id: Some(run_id),
        session_id: None,
        job_id: None,
        channel: None,
        channels: Vec::new(),
        target_user_id: None,
        data: serde_json::json!({ "status": run.status, "percent": run.progress }),
        timestamp: run.updated_at,
    }))
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

    /// A space deletion's invalidation, as published, reaches every stream of
    /// its target user, on any space, past the access check. Any other shape
    /// of it is an ordinary event that no stream of another space matches.
    #[test]
    fn space_deleted_invalidation_is_exactly_its_published_shape() {
        let hub = crate::state::EventHub::new();
        let mut published = hub.subscribe();
        let target_user_id = Uuid::new_v4();
        let deleted_project_id = Uuid::new_v4();
        crate::state::publish_project_deleted(&hub, deleted_project_id, target_user_id);
        let event = published.try_recv().expect("space deletion published");
        assert_eq!(event.kind, PROJECT_ACCESS_CHANGED_EVENT);
        assert_eq!(event.project_id, None);
        assert_eq!(event.target_user_id, Some(target_user_id));
        assert_eq!(
            event.data,
            json!({ "reason": "space_deleted", "projectId": deleted_project_id.to_string() })
        );

        assert!(is_canonical_access_invalidation(&event));
        assert!(is_targeted_access_invalidation(
            &event,
            &user_context(target_user_id)
        ));
        assert!(!event_targets_context(
            &event,
            &user_context(Uuid::new_v4())
        ));
        assert!(!is_targeted_access_invalidation(
            &event,
            &user_context(Uuid::new_v4())
        ));

        let other_project_id = Uuid::new_v4();
        for project_id in [deleted_project_id, other_project_id] {
            let filters = EventFilters {
                project_id,
                session_id: None,
                run_id: None,
                conversation_id: None,
                kinds: Vec::new(),
            };
            assert!(filters.matches(&event));
            let scoped_filters = EventFilters {
                project_id,
                session_id: Some(Uuid::new_v4()),
                run_id: Some(Uuid::new_v4()),
                conversation_id: Some(Uuid::new_v4()),
                kinds: vec![PROJECT_ACCESS_CHANGED_EVENT.to_string()],
            };
            assert!(scoped_filters.matches(&event));
        }
        let other_kinds = EventFilters {
            project_id: other_project_id,
            session_id: None,
            run_id: None,
            conversation_id: None,
            kinds: vec!["run.completed".to_string()],
        };
        assert!(!other_kinds.matches(&event));

        let other_space_stream = EventFilters {
            project_id: other_project_id,
            session_id: None,
            run_id: None,
            conversation_id: None,
            kinds: Vec::new(),
        };
        let deleted_id = deleted_project_id.to_string();
        let malformed_payloads = [
            json!({ "reason": "space_deleted" }),
            json!({ "reason": "space_deleted", "projectId": deleted_id, "name": "Old space" }),
            json!({ "reason": "space_deleted", "projectId": "not-a-uuid" }),
            json!({ "reason": "space_deleted", "projectId": 42 }),
            json!({ "reason": "membership_changed", "projectId": deleted_id }),
            json!({ "reason": "space_removed", "projectId": deleted_id }),
            json!(["space_deleted", deleted_id]),
        ];
        for data in malformed_payloads {
            let mut malformed = event.clone();
            malformed.data = data;
            assert!(
                !is_canonical_access_invalidation(&malformed),
                "{:?}",
                malformed.data
            );
            assert!(
                !other_space_stream.matches(&malformed),
                "{:?}",
                malformed.data
            );
        }

        // Scoped to the deleted space, it would take the access check that
        // space fails, and miss every other space's stream.
        let mut scoped_to_space = event.clone();
        scoped_to_space.project_id = Some(deleted_project_id);
        assert!(!is_canonical_access_invalidation(&scoped_to_space));
        assert!(!is_targeted_access_invalidation(
            &scoped_to_space,
            &user_context(target_user_id)
        ));
        assert!(!other_space_stream.matches(&scoped_to_space));

        let mut untargeted = event.clone();
        untargeted.target_user_id = None;
        assert!(!is_canonical_access_invalidation(&untargeted));
        assert!(!other_space_stream.matches(&untargeted));

        let mut conversation_scoped = event.clone();
        conversation_scoped.conversation_id = Some(Uuid::new_v4());
        assert!(!is_canonical_access_invalidation(&conversation_scoped));
        assert!(!other_space_stream.matches(&conversation_scoped));
    }

    /// A stream's passed access check holds per conversation, for the window
    /// only, and an access change drops every one of them.
    #[test]
    fn recent_access_holds_per_conversation_for_the_window_only() {
        let window = Duration::from_secs(5);
        let recent = RecentAccess::default();
        let conversation = Some(Uuid::new_v4());
        let start = Instant::now();
        assert!(!recent.holds(conversation, start, window));

        recent.record(conversation, start, window);
        assert!(recent.holds(conversation, start + Duration::from_millis(4_900), window));
        assert!(!recent.holds(conversation, start + window, window));
        assert!(
            !recent.holds(None, start, window),
            "the project's own events check on their own"
        );
        assert!(!recent.holds(Some(Uuid::new_v4()), start, window));

        recent.record(None, start, window);
        recent.forget();
        assert!(!recent.holds(conversation, start, window));
        assert!(!recent.holds(None, start, window));
    }

    /// Events about runtimes, origins, tunnels, local workspaces or the org
    /// roster are checked on their own every time; others can use the
    /// stream's recent check.
    #[test]
    fn only_events_without_a_lookup_of_their_own_use_a_recent_check() {
        let user = user_context(Uuid::new_v4());
        let mut event = targeted_event("conversation.message_created", Uuid::new_v4());
        event.data = json!({ "marker": "plain" });
        assert!(!event_needs_lookup(&event, &user));

        event.data = json!({ "nested": { "runtimeId": Uuid::new_v4() } });
        assert!(event_needs_lookup(&event, &user));

        for kind in [
            "runtime.stopped",
            "origin.expired",
            "tunnel.grant_revoked",
            "local_workspace.updated",
        ] {
            event.kind = kind.to_string();
            event.data = json!({});
            assert!(event_needs_lookup(&event, &user), "{kind}");
        }

        event.kind = PROJECT_MEMBERS_CHANGED_EVENT.to_string();
        event.data = json!({ "reason": "org_membership" });
        assert!(event_needs_lookup(&event, &user));
        event.data = json!({ "reason": MEMBERS_CHANGED_PROJECT_MEMBERSHIP });
        assert!(!event_needs_lookup(&event, &user));
        assert!(changes_access(&event));
    }

    /// A pool wait that timed out (503) is tried once more; a refusal stands,
    /// and a second 503 is the answer.
    #[tokio::test]
    async fn an_access_check_is_retried_once_when_the_database_was_busy() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let unavailable = || crate::errors::service_unavailable("busy");
        let calls = AtomicUsize::new(0);
        let answer = retry_once_if_unavailable(|| {
            let attempt = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                if attempt == 0 {
                    Err(unavailable())
                } else {
                    Ok(attempt)
                }
            }
        })
        .await;
        assert_eq!(answer.ok(), Some(1));
        assert_eq!(calls.load(Ordering::SeqCst), 2);

        let calls = AtomicUsize::new(0);
        let answer: Result<(), _> = retry_once_if_unavailable(|| {
            calls.fetch_add(1, Ordering::SeqCst);
            async { Err(forbidden("no access")) }
        })
        .await;
        assert_eq!(
            answer.err().map(|(status, _)| status),
            Some(StatusCode::FORBIDDEN)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);

        let calls = AtomicUsize::new(0);
        let answer: Result<(), _> = retry_once_if_unavailable(|| {
            calls.fetch_add(1, Ordering::SeqCst);
            async move { Err(unavailable()) }
        })
        .await;
        assert_eq!(
            answer.err().map(|(status, _)| status),
            Some(StatusCode::SERVICE_UNAVAILABLE)
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    /// A user who already holds every stream the node allows is told to wait
    /// (429, `Retry-After`, a code) before the database is read: the pool
    /// here cannot connect and is never asked for a connection.
    #[tokio::test]
    async fn a_stream_over_the_limit_is_refused_with_retry_after_before_any_database_read(
    ) -> anyhow::Result<()> {
        use tower::ServiceExt;

        let config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "event-stream-limit",
        );
        assert!(!config.dev_mode);
        let user_id = Uuid::new_v4();
        let token = crate::auth::issue_controller_token(&config, &user_id)
            .map_err(|(status, _)| anyhow::anyhow!("issue controller token: {status}"))?
            .token;
        let manager = bb8_postgres::PostgresConnectionManager::new_from_stringlike(
            "postgresql://ignored:ignored@127.0.0.1:1/postgres",
            crate::config::database_tls(),
        )?;
        let pool = bb8::Pool::builder().max_size(1).build_unchecked(manager);
        let state = crate::tests::build_test_state(pool, config);

        let mut held = Vec::new();
        for _ in 0..MAX_EVENT_STREAMS_PER_USER {
            held.push(
                state
                    .connection_limiter
                    .try_acquire(event_stream_limit_key(user_id), MAX_EVENT_STREAMS_PER_USER)
                    .await
                    .expect("a place below the limit"),
            );
        }

        let response = router()
            .with_state(state.clone())
            .oneshot(
                axum::http::Request::builder()
                    .method("GET")
                    .uri(format!("/events?projectId={}", Uuid::new_v4()))
                    .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(axum::body::Body::empty())?,
            )
            .await?;

        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(
            response
                .headers()
                .get(axum::http::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
            Some(EVENT_STREAM_RETRY_AFTER_SECS.to_string().as_str())
        );
        let body = axum::body::to_bytes(response.into_body(), 64 * 1024).await?;
        let body: serde_json::Value = serde_json::from_slice(&body)?;
        assert_eq!(body["code"], json!(TOO_MANY_EVENT_STREAMS_CODE));
        assert_eq!(crate::tests::pool_gets(&state.pool), 0);
        drop(held);
        Ok(())
    }
}
