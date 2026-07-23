use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tracing::instrument;
use uuid::Uuid;

use crate::auth::bearer_token;
use crate::errors::{bad_request, unauthorized, ApiError};
use crate::state::publish_controller_event;
use crate::AppState;

pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/git/hooks/events", post(post_git_hook_event))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHookRefUpdate {
    #[serde(alias = "ref")]
    ref_name: String,
    #[serde(default)]
    old_rev: Option<String>,
    #[serde(default)]
    new_rev: Option<String>,
    #[serde(default)]
    deleted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GitHookEventBody {
    kind: String,
    repo: String,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    default_branch: Option<String>,
    #[serde(default)]
    updates: Vec<GitHookRefUpdate>,
    #[serde(default)]
    received_at_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitHookEventResponse {
    accepted: bool,
    mapped_events: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ref_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    rev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[instrument(skip_all)]
async fn post_git_hook_event(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<GitHookEventBody>,
) -> Result<Json<GitHookEventResponse>, (StatusCode, Json<ApiError>)> {
    authorize_git_event_hook(&headers, state.config.git_event_hook_secret.as_deref())?;

    if body.kind.trim().to_ascii_lowercase() != "git.push.received" {
        return Ok(Json(GitHookEventResponse {
            accepted: true,
            mapped_events: 0,
            project_id: None,
            ref_name: None,
            rev: None,
            reason: Some("unsupported_kind".to_string()),
        }));
    }

    let project_id = resolve_project_id(body.project_id.as_deref(), body.repo.as_str())?;
    let default_branch = body
        .default_branch
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("main")
        .to_string();
    let main_ref = format!("refs/heads/{default_branch}");

    let matched_update = body
        .updates
        .iter()
        .rev()
        .find(|update| update.ref_name.trim() == main_ref && commit_rev(update).is_some());

    let Some(update) = matched_update else {
        return Ok(Json(GitHookEventResponse {
            accepted: true,
            mapped_events: 0,
            project_id: Some(project_id.to_string()),
            ref_name: None,
            rev: None,
            reason: Some("no_default_branch_update".to_string()),
        }));
    };

    let rev = commit_rev(update).expect("matched update guarantees rev");
    publish_controller_event(
        &state.events,
        "workspace.commit",
        Some(project_id),
        None,
        None,
        None,
        json!({
            "source": "git-service-hook",
            "eventKind": body.kind.trim(),
            "repo": body.repo.trim(),
            "projectId": project_id.to_string(),
            "defaultBranch": default_branch,
            "ref": update.ref_name.trim(),
            "oldRev": normalize_rev(update.old_rev.as_deref()),
            "rev": rev,
            "receivedAtMs": body.received_at_ms,
            "updates": updates_to_json(&body.updates),
        }),
    );

    Ok(Json(GitHookEventResponse {
        accepted: true,
        mapped_events: 1,
        project_id: Some(project_id.to_string()),
        ref_name: Some(update.ref_name.trim().to_string()),
        rev: Some(rev.to_string()),
        reason: None,
    }))
}

fn authorize_git_event_hook(
    headers: &HeaderMap,
    expected_secret: Option<&str>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let Some(expected) = expected_secret
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            Json(ApiError::new("git event hook secret not configured")),
        ));
    };

    let supplied = bearer_token(headers).or_else(|| {
        headers
            .get("x-instafy-hook-token")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.to_string())
    });

    if supplied.as_deref() == Some(expected) {
        Ok(())
    } else {
        Err(unauthorized("invalid git event hook token"))
    }
}

fn resolve_project_id(
    explicit_project_id: Option<&str>,
    repo: &str,
) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    if let Some(raw) = explicit_project_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Uuid::parse_str(raw)
            .map_err(|_| bad_request("projectId must be a valid UUID for git hook events"));
    }

    let candidate = repo.trim().trim_end_matches(".git").trim();
    Uuid::parse_str(candidate)
        .map_err(|_| bad_request("projectId missing and repo name is not a UUID repo"))
}

fn commit_rev(update: &GitHookRefUpdate) -> Option<&str> {
    let rev = normalize_rev(update.new_rev.as_deref())?;
    if update.deleted || is_zero_oid(rev) {
        return None;
    }
    Some(rev)
}

fn normalize_rev(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|raw| !raw.is_empty())
}

fn is_zero_oid(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && trimmed.chars().all(|ch| ch == '0')
}

fn updates_to_json(updates: &[GitHookRefUpdate]) -> Vec<JsonValue> {
    updates
        .iter()
        .map(|update| {
            json!({
                "ref": update.ref_name.trim(),
                "oldRev": normalize_rev(update.old_rev.as_deref()),
                "newRev": normalize_rev(update.new_rev.as_deref()),
                "deleted": update.deleted,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{is_zero_oid, resolve_project_id};

    #[test]
    fn zero_oid_detection_handles_hashes() {
        assert!(is_zero_oid("0000000000000000000000000000000000000000"));
        assert!(!is_zero_oid("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
        assert!(!is_zero_oid(""));
    }

    #[test]
    fn resolve_project_id_falls_back_to_repo_name() {
        let project_id = resolve_project_id(None, "123e4567-e89b-12d3-a456-426614174000.git")
            .expect("project id");
        assert_eq!(
            project_id.to_string(),
            "123e4567-e89b-12d3-a456-426614174000"
        );
    }
}
