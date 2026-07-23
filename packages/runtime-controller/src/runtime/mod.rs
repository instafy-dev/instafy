use axum::routing::{get, post};
use axum::Router;

use crate::AppState;

mod access;
mod db;
mod ensure;
mod lease;
mod managed;
mod provider;
mod register;
pub(crate) mod sizes;
mod status;
mod stop;
mod token;
mod utils;

mod sweeps;

#[cfg(test)]
mod visibility_tests;

pub(crate) use access::{
    ensure_self_hosted_runtime_access, provider_is_private_self_hosted_or_quarantined,
    runtime_has_private_self_hosted_identity, runtime_is_private_self_hosted,
    self_hosted_owner_user_id, self_hosted_runtime_is_accessible_to_user,
    set_self_hosted_access_attestation,
};
pub(crate) use db::{
    ensure_runtime_record, mark_runtime_ready, record_runtime_event,
    record_runtime_event_with_conversation, touch_runtime_last_seen, RuntimeRecord,
};
pub(crate) use ensure::{ensure_runtime_for_automation, ensure_runtime_for_dispatch_reconnect};
pub(crate) use managed::runtime_supports_shared_browser_agent_consent;
pub(crate) use provider::provider_is_self_hosted;
pub(crate) use register::RuntimeRegisterResponse;
pub(crate) use status::{
    load_runtime_status_response, runtime_supports_agent_and_origin,
    runtime_supports_conversation_state, RuntimeStatusResponse,
};
pub(crate) use stop::runtime_mark_offline;
pub(crate) use stop::{stop_runtime_for_project, RuntimeStopResponse};
pub(crate) use sweeps::{
    prune_expired_runtime_events, sweep_hosted_runtime_credit_usage, sweep_idle_activity,
};
pub(crate) use token::{
    ensure_bound_runtime_generation_matches, ensure_runtime_generation_matches,
    runtime_generation_from_capabilities, set_runtime_generation_capability,
    RUNTIME_TOKEN_DEFAULT_SCOPES, RUNTIME_TOKEN_GIT_MINT_SCOPE, RUNTIME_TOKEN_REQUIRED_SCOPES,
    RUNTIME_TOKEN_WORKSPACE_LEASE_READ_SCOPE,
};

#[cfg(test)]
pub(crate) use db::{fetch_runtime_for_update, release_origin_instances_for_runtime};
#[cfg(test)]
pub(crate) use stop::{
    perform_runtime_stop, RuntimeIdentityExpectation, StopOptions,
    PERSONAL_BROWSER_DISCONNECTED_ERROR, SHARED_BROWSER_DISCONNECTED_ERROR,
};
#[cfg(test)]
pub(crate) use token::RuntimeTokenResponse;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/runtime/register", post(register::runtime_register))
        .route("/runtime/ensure", post(ensure::runtime_ensure))
        .route("/runtime/stop", post(stop::runtime_stop))
        .route(
            "/runtime/offline/:project_id",
            post(stop::runtime_mark_offline),
        )
        .route(
            "/projects/:project_id/runtime/token",
            post(token::mint_runtime_access_token),
        )
        .route("/runtime/remove", post(stop::runtime_remove))
        .route("/runtime/idle-reaper", post(stop::runtime_idle_reaper))
        .route(
            "/projects/:project_id/runtime/activity",
            post(status::runtime_activity),
        )
        .route(
            "/projects/:project_id/runtime/status",
            get(status::runtime_status),
        )
        .route(
            "/projects/:project_id/runtime/preference",
            get(status::runtime_preference).post(status::set_runtime_preference),
        )
        .route(
            "/projects/:project_id/runtime/logs",
            get(status::runtime_logs),
        )
        .route(
            "/projects/:project_id/runtime/request",
            post(ensure::request_runtime),
        )
}
