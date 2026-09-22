use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Path as StdPath, PathBuf};
use std::str::FromStr;
use std::time::Duration as StdDuration;

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tokio::time::timeout;
use uuid::Uuid;
use zip::write::{FileOptions, ZipWriter};

use crate::auth::{authenticate_request, RequestContext};
use crate::conversations::{ensure_conversation_access, load_conversation_record};
use crate::errors::{
    bad_request, database_unavailable, describe_db_error, forbidden, internal_error, not_found,
    unauthorized, ApiError,
};
use crate::origins::{
    acquire_fresh_lease, release_lease,
    resolve_accessible_origin_for_protocol_with_hosted_fallback, LeaseAcquireOutcome,
};
use crate::state::{publish_project_access_changed, publish_project_signal, AppState, EventHub};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};

const ORIGIN_APPLY_TIMEOUT_SECS: u64 = 180;

/// Roster invalidation for everyone viewing a space (the targeted
/// `project.access_changed` still tells the affected user). Signal only:
/// viewers refetch `/projects/{id}/members` or the org directory through
/// their own authorization.
pub(crate) const PROJECT_MEMBERS_CHANGED_EVENT: &str = "project.members_changed";
const MEMBERS_CHANGED_PROJECT_MEMBERSHIP: &str = "project_membership";
const MEMBERS_CHANGED_ORG_MEMBERSHIP: &str = "org_membership";

#[derive(Debug, Clone)]
pub(crate) struct ScopeParams {
    pub(crate) project_id: Option<String>,
    pub(crate) session_id: Option<String>,
    pub(crate) run_id: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProjectScope {
    pub(crate) project: ProjectRecord,
    pub(crate) session_id: Option<Uuid>,
    pub(crate) run_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub(crate) struct ProjectRecord {
    pub(crate) id: Uuid,
    pub(crate) org_id: Option<Uuid>,
    #[allow(dead_code)]
    pub(crate) name: Option<String>,
    pub(crate) sandbox_session_id: Option<Uuid>,
    pub(crate) project_type: Option<String>,
    pub(crate) owner_user_id: Option<Uuid>,
    #[allow(dead_code)]
    pub(crate) _status: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum ProjectRole {
    Viewer,
    Builder,
    Admin,
    Owner,
}

impl ProjectRole {
    fn from_membership_role(role: &str) -> Option<Self> {
        match role.trim().to_ascii_lowercase().as_str() {
            "viewer" => Some(Self::Viewer),
            "builder" => Some(Self::Builder),
            "admin" => Some(Self::Admin),
            "owner" => Some(Self::Owner),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Viewer => "viewer",
            Self::Builder => "builder",
            Self::Admin => "admin",
            Self::Owner => "owner",
        }
    }

    fn can_write(self) -> bool {
        self >= Self::Builder
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ProjectAccess {
    pub(crate) role: ProjectRole,
    pub(crate) can_share: bool,
    pub(crate) can_manage: bool,
}

impl ProjectAccess {
    fn builder() -> Self {
        Self {
            role: ProjectRole::Builder,
            can_share: false,
            can_manage: false,
        }
    }

    fn owner() -> Self {
        Self {
            role: ProjectRole::Owner,
            can_share: true,
            can_manage: true,
        }
    }

    fn from_membership(role: ProjectRole, organization_grant: bool) -> Self {
        let can_share = organization_grant && role >= ProjectRole::Builder;
        let can_manage = organization_grant && role >= ProjectRole::Admin;
        Self {
            role,
            can_share,
            can_manage,
        }
    }

    fn merge(self, other: Self) -> Self {
        Self {
            role: self.role.max(other.role),
            can_share: self.can_share || other.can_share,
            can_manage: self.can_manage || other.can_manage,
        }
    }

    pub(crate) fn can_write(self) -> bool {
        self.role.can_write()
    }
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/orgs", get(list_organizations).post(create_organization))
        .route("/projects", get(list_accessible_projects))
        .route(
            "/orgs/:org_id",
            patch(update_organization).delete(delete_organization),
        )
        .route(
            "/orgs/:org_id/limits",
            get(get_org_limits).patch(patch_org_limits),
        )
        .route(
            "/projects/:project_id",
            get(get_project_summary)
                .patch(update_project)
                .delete(delete_project),
        )
        .route(
            "/projects/:project_id/memory/bootstrap",
            post(bootstrap_project_memory),
        )
        .route("/projects/:project_id/members", get(list_project_members))
        .route(
            "/projects/:project_id/members/:user_id/profile",
            get(get_project_member_profile),
        )
        .route(
            "/projects/:project_id/members/:user_id",
            patch(update_project_member).delete(remove_project_member),
        )
        .route(
            "/orgs/:org_id/projects",
            get(list_org_projects).post(create_org_project),
        )
        .route(
            "/orgs/:org_id/members",
            get(list_org_members).post(add_org_member),
        )
        .route(
            "/orgs/:org_id/invitations",
            get(list_org_invitations).post(create_org_invitation),
        )
        .route(
            "/orgs/:org_id/invite-links",
            get(list_org_invite_links).post(create_org_invite_link),
        )
        .route(
            "/orgs/:org_id/invite-links/:invite_link_id",
            delete(revoke_org_invite_link),
        )
        .route(
            "/orgs/:org_id/invitations/:invitation_id",
            delete(cancel_org_invitation).patch(update_org_invitation),
        )
        .route("/org-invitations/accept", post(accept_org_invitation))
        .route("/org-invitations/preview", get(preview_org_invitation))
        .route(
            "/orgs/:org_id/members/:user_id",
            patch(update_org_member).delete(remove_org_member),
        )
}

pub(crate) async fn resolve_scope(
    state: &AppState,
    params: ScopeParams,
    context: &RequestContext,
) -> Result<ProjectScope, (StatusCode, Json<ApiError>)> {
    let ScopeParams {
        project_id: project_raw,
        session_id: session_raw,
        run_id: run_raw,
    } = params;

    let mut session_id = parse_optional_uuid_param(session_raw, "sessionId")?;
    let mut project_id = parse_optional_uuid_param(project_raw, "projectId")?;
    let run_id = parse_optional_uuid_param(run_raw, "runId")?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Project access", error))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| database_unavailable("Project access", error))?;

    let mut project_record: Option<ProjectRecord> = None;

    if let Some(project_uuid) = project_id {
        let record = load_project_record(&transaction, &project_uuid).await?;
        project_record = Some(record);
    }

    if project_record.is_none() {
        if let Some(run_uuid) = run_id {
            let run_row = transaction
                .query_opt(
                    "select project_id, session_id from runs where id = $1",
                    &[&run_uuid],
                )
                .await
                .map_err(|error| internal_error(format!("failed to load run: {error}")))?;
            let row = run_row.ok_or_else(|| not_found("run not found"))?;
            project_id = row.get("project_id");
            if session_id.is_none() {
                session_id = row.get("session_id");
            }
            if let Some(project_uuid) = project_id {
                let record = load_project_record(&transaction, &project_uuid).await?;
                project_record = Some(record);
            }
        }
    }

    if project_record.is_none() {
        if let Some(session_uuid) = session_id {
            let project_row = transaction
                .query_opt(
                    "select id, org_id, sandbox_session_id, project_type, owner_user_id, status from projects where sandbox_session_id = $1 limit 1",
                    &[&session_uuid],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to load project for session: {error}"))
                })?;
            let row = project_row.ok_or_else(|| not_found("project not found for session"))?;
            let project = map_project_row(&row);
            project_record = Some(project);
        }
    }

    let project =
        project_record.ok_or_else(|| bad_request("projectId, sessionId, or runId is required"))?;

    ensure_project_access(&transaction, &project, context, session_id).await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize scope resolution: {error}")))?;

    Ok(ProjectScope {
        project,
        session_id,
        run_id,
    })
}

pub(crate) async fn load_project_record(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
) -> Result<ProjectRecord, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select id, org_id, name, sandbox_session_id, project_type, owner_user_id, status
             from projects
             where id = $1",
            &[project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load project: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("project not found"));
    };

    Ok(map_project_row(&row))
}

pub(crate) async fn resolve_effective_project_access(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &ProjectRecord,
    context: &RequestContext,
    session_id: Option<Uuid>,
) -> Result<ProjectAccess, (StatusCode, Json<ApiError>)> {
    if project
        ._status
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("deleted"))
        .unwrap_or(false)
    {
        return Err(not_found("project not found"));
    }

    if context.is_service_role {
        return Ok(ProjectAccess::owner());
    }

    // A scoped token is a capability, not a project membership. Generic read
    // authorization would let any narrow token (for example fs.read) reach
    // unrelated project APIs. Endpoints that intentionally accept scoped
    // tokens must validate both their exact scopes and project binding, then
    // call `ensure_scoped_project_match` instead.
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Scoped access tokens require an exact endpoint capability",
        ));
    }

    if let Some(project_type) = project.project_type.as_deref() {
        if project_type == "sandbox" {
            if let (Some(project_session), Some(request_session)) =
                (project.sandbox_session_id, session_id)
            {
                if project_session == request_session {
                    return Ok(ProjectAccess::builder());
                }
            }
        }
    }

    let user_id = context
        .user_id
        .ok_or_else(|| unauthorized("authentication required for this project"))?;

    if let Some(owner) = project.owner_user_id {
        if owner == user_id {
            return Ok(ProjectAccess::owner());
        }
    }

    let mut effective_access: Option<ProjectAccess> = None;

    let project_membership = transaction
        .query_opt(
            "select role from project_memberships where project_id = $1 and user_id = $2 limit 1",
            &[&project.id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to verify project access: {error}")))?;

    if let Some(row) = project_membership {
        let role: String = row.get("role");
        if let Some(role) = ProjectRole::from_membership_role(&role) {
            effective_access = Some(ProjectAccess::from_membership(role, false));
        } else {
            tracing::warn!(
                project_id = %project.id,
                request_user_id = %user_id,
                membership_role = %role,
                "ignoring invalid project membership role"
            );
        }
    }

    if let Some(org_id) = project.org_id {
        let membership = transaction
            .query_opt(
                "select role from org_memberships where org_id = $1 and user_id = $2 limit 1",
                &[&org_id, &user_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to verify project access: {error}")))?;

        if let Some(row) = membership {
            let role: String = row.get("role");
            if let Some(role) = ProjectRole::from_membership_role(&role) {
                let organization_access = ProjectAccess::from_membership(role, true);
                effective_access = Some(match effective_access {
                    Some(project_access) => project_access.merge(organization_access),
                    None => organization_access,
                });
            } else {
                tracing::warn!(
                    project_id = %project.id,
                    org_id = %org_id,
                    request_user_id = %user_id,
                    membership_role = %role,
                    "ignoring invalid organization membership role"
                );
            }
        }
    }

    if let Some(access) = effective_access {
        return Ok(access);
    }

    tracing::warn!(
        project_id = %project.id,
        org_id = ?project.org_id,
        owner_user_id = ?project.owner_user_id,
        request_user_id = %user_id,
        session_id = ?session_id,
        project_type = ?project.project_type,
        "project access denied"
    );

    Err(forbidden("You do not have access to this project"))
}

/// Prevents a project-scoped token from minting a child token with capabilities
/// that were not present in the parent grant.
pub(crate) fn ensure_scoped_claims_allow_requested_scopes(
    context: &RequestContext,
    requested_scopes: &[String],
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let Some(claims) = context.scoped_claims.as_ref() else {
        return Ok(());
    };
    if requested_scopes
        .iter()
        .all(|requested| claims.scopes.iter().any(|scope| scope == requested))
    {
        return Ok(());
    }
    Err(forbidden(
        "A scoped access token cannot grant additional scopes",
    ))
}

/// Returns the maximum lifetime available to a delegated token. The token
/// signer enforces a 60-second minimum, so a nearly-expired parent cannot be
/// used to create a child that outlives it through that minimum clamp.
pub(crate) fn scoped_claims_remaining_ttl_seconds(
    context: &RequestContext,
) -> Result<Option<i64>, (StatusCode, Json<ApiError>)> {
    let Some(claims) = context.scoped_claims.as_ref() else {
        return Ok(None);
    };
    let remaining = claims.exp.saturating_sub(Utc::now().timestamp());
    if remaining < 60 {
        return Err(unauthorized(
            "Scoped access token expires too soon to delegate",
        ));
    }
    Ok(Some(remaining))
}

pub(crate) fn ensure_scoped_project_match(
    context: &RequestContext,
    project_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let claims = context
        .scoped_claims
        .as_ref()
        .ok_or_else(|| unauthorized("scoped access token required"))?;
    let scoped_project_id = Uuid::from_str(claims.project_id.trim())
        .map_err(|_| unauthorized("access token project scope invalid"))?;
    if scoped_project_id != *project_id {
        return Err(forbidden("You do not have access to this project"));
    }
    Ok(())
}

pub(crate) async fn ensure_project_read_access(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &ProjectRecord,
    context: &RequestContext,
    session_id: Option<Uuid>,
) -> Result<ProjectAccess, (StatusCode, Json<ApiError>)> {
    resolve_effective_project_access(transaction, project, context, session_id).await
}

pub(crate) async fn ensure_project_write_access(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &ProjectRecord,
    context: &RequestContext,
    session_id: Option<Uuid>,
) -> Result<ProjectAccess, (StatusCode, Json<ApiError>)> {
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Scoped access tokens cannot authorize project writes",
        ));
    }
    let access = ensure_project_read_access(transaction, project, context, session_id).await?;
    if !access.can_write() {
        return Err(forbidden("Read-only members cannot modify this project"));
    }
    Ok(access)
}

/// Authorize a mutating request that a scoped runtime token may perform.
///
/// A scoped access token (the runtime's fs.write / git.write origin token)
/// authorizes the write iff it is scoped to this project and carries every
/// required scope. Non-scoped (human/session/service-role) callers fall back
/// to the normal membership write check. This preserves the import-hardening
/// contract that lets the runtime write while keeping human writes gated by
/// project membership.
pub(crate) async fn ensure_project_scoped_write_access(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &ProjectRecord,
    context: &RequestContext,
    session_id: Option<Uuid>,
    required_scoped_scopes: &[&str],
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if context.is_service_role {
        return Ok(());
    }
    if project
        ._status
        .as_deref()
        .map(|value| value.eq_ignore_ascii_case("deleted"))
        .unwrap_or(false)
    {
        return Err(not_found("project not found"));
    }
    if context.scoped_claims.is_some() {
        ensure_scoped_project_match(context, &project.id)?;
        if required_scoped_scopes.is_empty() {
            return Err(forbidden("Project write scope is required"));
        }
        let required: Vec<String> = required_scoped_scopes
            .iter()
            .map(|scope| (*scope).to_string())
            .collect();
        ensure_scoped_claims_allow_requested_scopes(context, &required)?;
        return Ok(());
    }
    ensure_project_write_access(transaction, project, context, session_id)
        .await
        .map(|_| ())
}

/// Backward-compatible read alias. Mutating routes should use
/// `ensure_project_write_access` explicitly.
pub(crate) async fn ensure_project_access(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &ProjectRecord,
    context: &RequestContext,
    session_id: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    ensure_project_read_access(transaction, project, context, session_id)
        .await
        .map(|_| ())
}

async fn require_project_deleter(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &ProjectRecord,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Scoped access tokens cannot manage project settings",
        ));
    }
    if context.is_service_role {
        return Ok(());
    }

    let user_id = context
        .user_id
        .ok_or_else(|| unauthorized("authentication required to delete projects"))?;

    if project.owner_user_id == Some(user_id) {
        return Ok(());
    }

    let Some(org_id) = project.org_id else {
        return Err(forbidden(
            "You do not have permission to delete this project",
        ));
    };

    let role = require_org_access(transaction, &org_id, context).await?;
    if let Some(role) = role {
        if role != "owner" && role != "admin" {
            return Err(forbidden(
                "Only organization owners and admins can delete projects",
            ));
        }
    }
    Ok(())
}

pub(crate) fn parse_optional_uuid_param(
    value: Option<String>,
    field: &str,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    match value {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                return Err(bad_request(format!("{field} must be a valid UUID")));
            }
            Uuid::from_str(trimmed)
                .map(Some)
                .map_err(|_| bad_request(format!("{field} must be a valid UUID")))
        }
        None => Ok(None),
    }
}

#[derive(Debug, Serialize)]
struct OrgSummary {
    #[serde(rename = "id")]
    org_id: Uuid,
    #[serde(rename = "slug")]
    org_slug: String,
    #[serde(rename = "name")]
    org_name: String,
    #[serde(rename = "avatarUrl", skip_serializing_if = "Option::is_none")]
    avatar_url: Option<String>,
    #[serde(rename = "accentColor", skip_serializing_if = "Option::is_none")]
    accent_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    role: Option<String>,
}

#[derive(Debug, Serialize)]
struct OrgListResponse {
    orgs: Vec<OrgSummary>,
}

#[derive(Debug, Clone)]
struct OrgRecord {
    id: Uuid,
    slug: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateOrgBody {
    #[serde(default, rename = "orgSlug", alias = "org_slug")]
    org_slug: Option<String>,
    #[serde(default, rename = "orgName", alias = "org_name")]
    org_name: Option<String>,
    #[serde(default, rename = "ownerUserId", alias = "owner_user_id")]
    owner_user_id: Option<String>,
    accent_color: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateOrgResponse {
    org_id: Uuid,
    org_slug: String,
    org_name: String,
    accent_color: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummary {
    project_id: Uuid,
    org_id: Option<Uuid>,
    org_slug: Option<String>,
    org_name: Option<String>,
    project_name: Option<String>,
    project_icon: Option<String>,
    project_color: Option<String>,
    project_avatar_url: Option<String>,
    owner_user_id: Option<Uuid>,
    project_type: Option<String>,
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effective_role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_write: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_share: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    can_manage: Option<bool>,
    /// The newest of the project's own timestamps and its conversations'
    /// last messages, so a client with nothing remembered can open the space
    /// the person last worked in rather than the first row. Only the list
    /// endpoints compute it.
    #[serde(skip_serializing_if = "Option::is_none")]
    last_activity_at: Option<String>,
}

impl ProjectSummary {
    fn with_access(mut self, access: ProjectAccess) -> Self {
        self.effective_role = Some(access.role.as_str().to_string());
        self.can_write = Some(access.can_write());
        self.can_share = Some(access.can_share);
        self.can_manage = Some(access.can_manage);
        self
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectListResponse {
    projects: Vec<ProjectSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapProjectMemoryResponse {
    ok: bool,
    seeded: bool,
    file_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    rev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginManifestFileEntry {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

#[derive(Debug, Clone)]
struct ProjectMemoryTemplateFile {
    path: &'static str,
    asset_relative_path: &'static str,
    fallback_content: &'static str,
}

#[derive(Debug, Clone)]
struct ProjectMemoryWriteFile {
    path: String,
    content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ProjectMemoryManagedDefaultsState {
    version: u32,
    files: BTreeMap<String, ProjectMemoryManagedDefaultsFileState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMemoryManagedDefaultsFileState {
    applied_sha256: String,
}

#[derive(Debug, Default)]
struct BootstrapProjectMemoryOutcome {
    seeded: bool,
    file_count: usize,
    rev: Option<String>,
    reason: Option<String>,
}

const INSTAFY_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/INSTAFY.md"
));
const AGENTS_DOC_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/AGENTS.md"
));
const CLAUDE_DOC_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/CLAUDE.md"
));
const AGENTS_SCRIPT_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/AGENTS.py"
));
const LEARNING_POLICY_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-learning-policy/SKILL.md"
));
const GIT_CANONICAL_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-git-canonical-sync/SKILL.md"
));
const GIT_CANONICAL_CONFLICTS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-git-canonical-conflicts/SKILL.md"
));
const RUNTIME_FLAVORS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-runtime-flavors/SKILL.md"
));
const SECRETS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-secrets/SKILL.md"
));
const FRONTEND_PREVIEWS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-frontend-previews/SKILL.md"
));
const INTEGRATION_ONBOARDING_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-integration-onboarding/SKILL.md"
));
const BYOC_AI_CREDENTIALS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-byoc-ai-credentials/SKILL.md"
));
const COLLABORATION_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-collaboration/SKILL.md"
));
const AGENT_COLLABORATION_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-agent-collaboration/SKILL.md"
));
const GROUP_PARTICIPATION_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-group-participation/SKILL.md"
));
const CONVERSATION_HISTORY_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-conversation-history/SKILL.md"
));
const DIAGNOSTICS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-diagnostics/SKILL.md"
));
const DIAGNOSTICS_OPENAI_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-diagnostics/agents/openai.yaml"
));
const LOCATION_SHARING_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-location-sharing/SKILL.md"
));
const SKILL_IMPORT_COMPAT_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-skill-import-compat/SKILL.md"
));
const SKILL_ROUTER_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-skill-router/SKILL.md"
));
const SKILL_READING_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-skill-reading/SKILL.md"
));
const LEARNED_SKILLS_INDEX_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-learned/SKILL.md"
));
const BROWSER_AUTOMATION_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-browser-automation/SKILL.md"
));
const AUTOMATIONS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-automations/SKILL.md"
));
const PERSISTENT_CONTEXTS_TEMPLATE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../runtime-agent/assets/instafy/.agents/skills/instafy-persistent-contexts/SKILL.md"
));
const PROJECT_MEMORY_MANAGED_DEFAULTS_STATE_PATH: &str =
    ".agents/.instafy-managed-defaults-state.json";
const PROJECT_MEMORY_ASSETS_ROOT_ENV: &str = "INSTAFY_PROJECT_MEMORY_ASSETS_ROOT";

const PROJECT_MEMORY_TEMPLATE_FILES: [ProjectMemoryTemplateFile; 26] = [
    ProjectMemoryTemplateFile {
        path: "INSTAFY.md",
        asset_relative_path: "INSTAFY.md",
        fallback_content: INSTAFY_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: "AGENTS.md",
        asset_relative_path: "AGENTS.md",
        fallback_content: AGENTS_DOC_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: "CLAUDE.md",
        asset_relative_path: "CLAUDE.md",
        fallback_content: CLAUDE_DOC_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: "AGENTS.py",
        asset_relative_path: "AGENTS.py",
        fallback_content: AGENTS_SCRIPT_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-learning-policy/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-learning-policy/SKILL.md",
        fallback_content: LEARNING_POLICY_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-git-canonical-sync/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-git-canonical-sync/SKILL.md",
        fallback_content: GIT_CANONICAL_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-git-canonical-conflicts/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-git-canonical-conflicts/SKILL.md",
        fallback_content: GIT_CANONICAL_CONFLICTS_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-runtime-flavors/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-runtime-flavors/SKILL.md",
        fallback_content: RUNTIME_FLAVORS_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-secrets/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-secrets/SKILL.md",
        fallback_content: SECRETS_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-frontend-previews/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-frontend-previews/SKILL.md",
        fallback_content: FRONTEND_PREVIEWS_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-integration-onboarding/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-integration-onboarding/SKILL.md",
        fallback_content: INTEGRATION_ONBOARDING_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-byoc-ai-credentials/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-byoc-ai-credentials/SKILL.md",
        fallback_content: BYOC_AI_CREDENTIALS_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-collaboration/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-collaboration/SKILL.md",
        fallback_content: COLLABORATION_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-agent-collaboration/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-agent-collaboration/SKILL.md",
        fallback_content: AGENT_COLLABORATION_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-group-participation/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-group-participation/SKILL.md",
        fallback_content: GROUP_PARTICIPATION_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-conversation-history/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-conversation-history/SKILL.md",
        fallback_content: CONVERSATION_HISTORY_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-diagnostics/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-diagnostics/SKILL.md",
        fallback_content: DIAGNOSTICS_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-diagnostics/agents/openai.yaml",
        asset_relative_path: ".agents/skills/instafy-diagnostics/agents/openai.yaml",
        fallback_content: DIAGNOSTICS_OPENAI_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-location-sharing/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-location-sharing/SKILL.md",
        fallback_content: LOCATION_SHARING_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-skill-import-compat/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-skill-import-compat/SKILL.md",
        fallback_content: SKILL_IMPORT_COMPAT_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-skill-router/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-skill-router/SKILL.md",
        fallback_content: SKILL_ROUTER_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-skill-reading/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-skill-reading/SKILL.md",
        fallback_content: SKILL_READING_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-learned/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-learned/SKILL.md",
        fallback_content: LEARNED_SKILLS_INDEX_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-browser-automation/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-browser-automation/SKILL.md",
        fallback_content: BROWSER_AUTOMATION_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-automations/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-automations/SKILL.md",
        fallback_content: AUTOMATIONS_TEMPLATE,
    },
    ProjectMemoryTemplateFile {
        path: ".agents/skills/instafy-persistent-contexts/SKILL.md",
        asset_relative_path: ".agents/skills/instafy-persistent-contexts/SKILL.md",
        fallback_content: PERSISTENT_CONTEXTS_TEMPLATE,
    },
];

fn project_memory_assets_root() -> PathBuf {
    if let Some(override_root) = std::env::var_os(PROJECT_MEMORY_ASSETS_ROOT_ENV) {
        let candidate = PathBuf::from(override_root);
        if candidate.exists() {
            return candidate;
        }
    }
    StdPath::new(env!("CARGO_MANIFEST_DIR"))
        .join("../runtime-agent/assets/instafy")
        .to_path_buf()
}

fn load_project_memory_template_content(template: &ProjectMemoryTemplateFile) -> String {
    let candidate = project_memory_assets_root().join(template.asset_relative_path);
    match fs::read_to_string(&candidate) {
        Ok(content) => content,
        Err(error) => {
            tracing::debug!(
                path = %candidate.display(),
                error = %error,
                "falling back to bundled project memory template",
            );
            template.fallback_content.to_string()
        }
    }
}

const ORG_MEMBER_ROLES: [&str; 4] = ["owner", "admin", "builder", "viewer"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgMemberSummary {
    user_id: Uuid,
    email: Option<String>,
    full_name: Option<String>,
    role: String,
    invited_by: Option<Uuid>,
    created_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgMembersQuery {
    #[serde(default)]
    limit: Option<i64>,
    cursor: Option<String>,
    q: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgMembersResponse {
    members: Vec<OrgMemberSummary>,
    #[serde(rename = "nextCursor")]
    next_cursor: Option<String>,
    #[serde(rename = "hasMore")]
    has_more: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgMemberResponse {
    member: OrgMemberSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgMemberCreateRequest {
    email: Option<String>,
    #[serde(rename = "userId", alias = "user_id")]
    user_id: Option<String>,
    role: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgMemberUpdateRequest {
    role: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgInvitationSummary {
    id: Uuid,
    org_id: Uuid,
    project_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    email: String,
    role: String,
    invited_by: Option<Uuid>,
    status: String,
    created_at: String,
    expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgInvitationsResponse {
    invitations: Vec<OrgInvitationSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgInvitationResponse {
    invitation: OrgInvitationSummary,
    accept_url: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgInvitationCreateRequest {
    email: String,
    role: Option<String>,
    #[serde(rename = "projectId", alias = "project_id")]
    project_id: Option<String>,
    #[serde(rename = "conversationId", alias = "conversation_id")]
    conversation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgInvitationUpdateRequest {
    role: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgInvitationsQuery {
    #[serde(rename = "projectId", alias = "project_id")]
    project_id: Option<String>,
    #[serde(rename = "conversationId", alias = "conversation_id")]
    conversation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgInviteLinkCreateRequest {
    role: Option<String>,
    #[serde(rename = "projectId", alias = "project_id")]
    project_id: Option<String>,
    #[serde(rename = "conversationId", alias = "conversation_id")]
    conversation_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgInvitationAcceptRequest {
    token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgInvitationAcceptResponse {
    org_id: Uuid,
    org_slug: String,
    org_name: String,
    role: String,
    project_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct OrgInvitationPreviewQuery {
    token: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgInvitationPreviewResponse {
    kind: String,
    org_id: Uuid,
    org_slug: String,
    org_name: String,
    role: String,
    invited_email_masked: Option<String>,
    inviter_name: Option<String>,
    inviter_email: Option<String>,
    project_id: Option<Uuid>,
    project_name: Option<String>,
    conversation_id: Option<Uuid>,
    conversation_name: Option<String>,
    expires_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgInviteLinkPayload {
    id: Uuid,
    org_id: Uuid,
    project_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    role: String,
    status: String,
    created_at: String,
    expires_at: Option<String>,
    token: Uuid,
    accept_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgInviteLinkResponse {
    invite_link: OrgInviteLinkPayload,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgInviteLinkListQuery {
    #[serde(rename = "projectId", alias = "project_id")]
    project_id: Option<String>,
    #[serde(rename = "conversationId", alias = "conversation_id")]
    conversation_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgInviteLinksResponse {
    invite_links: Vec<OrgInviteLinkPayload>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMemberSummary {
    user_id: Uuid,
    email: Option<String>,
    full_name: Option<String>,
    role: String,
    invited_by: Option<Uuid>,
    created_at: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMembersResponse {
    members: Vec<ProjectMemberSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMemberResponse {
    member: ProjectMemberSummary,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectMemberUpdateRequest {
    role: String,
}

async fn list_organizations(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<OrgListResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden("Scoped access tokens cannot list organizations"));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!("failed to start org list transaction: {error}"))
    })?;

    let rows = if context.is_service_role {
        transaction
            .query(
                "select o.id, o.slug, o.name, null as role,
                        to_jsonb(o) ->> 'avatar_url' as avatar_url,
                        to_jsonb(o) ->> 'accent_color' as accent_color
                 from organizations o",
                &[],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load organizations: {error}")))?
    } else if let Some(user_id) = context.user_id {
        transaction
            .query(
                "select o.id, o.slug, o.name, m.role,
                        to_jsonb(o) ->> 'avatar_url' as avatar_url,
                        to_jsonb(o) ->> 'accent_color' as accent_color
                 from organizations o
                 join org_memberships m on m.org_id = o.id
                 where m.user_id = $1",
                &[&user_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load organizations: {error}")))?
    } else {
        return Err(unauthorized(
            "authentication required to list organizations",
        ));
    };

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize org list: {error}")))?;

    let orgs = rows
        .into_iter()
        .filter_map(|row| {
            let slug: Option<String> = row.get("slug");
            let name: Option<String> = row.get("name");
            let id: Uuid = row.get("id");
            if let (Some(slug), Some(name)) = (slug, name) {
                Some(OrgSummary {
                    org_id: id,
                    org_slug: slug,
                    org_name: name,
                    avatar_url: row.get::<_, Option<String>>("avatar_url"),
                    accent_color: row.get::<_, Option<String>>("accent_color"),
                    role: row.get::<_, Option<String>>("role"),
                })
            } else {
                None
            }
        })
        .collect();

    Ok(Json(OrgListResponse { orgs }))
}

async fn create_organization(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<CreateOrgBody>,
) -> Result<Json<CreateOrgResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Scoped access tokens cannot create organizations",
        ));
    }

    validate_org_accent(body.accent_color.as_deref())?;
    let requested_owner = parse_optional_uuid_param(body.owner_user_id, "ownerUserId")?;
    let owner_user_id = if let Some(owner) = requested_owner {
        if !context.is_service_role && Some(owner) != context.user_id {
            return Err(forbidden("You cannot assign other users as owners."));
        }
        Some(owner)
    } else {
        context.user_id
    };

    if owner_user_id.is_none() && !context.is_service_role {
        return Err(unauthorized(
            "You must be signed in to create an organization.",
        ));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!("failed to start org create transaction: {error}"))
    })?;

    let trimmed_slug = body
        .org_slug
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase());
    let trimmed_name = body
        .org_name
        .clone()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    // An explicit slug that collides with a foreign org must 409, while a
    // slug derived from a display name silently gets a unique suffix instead.
    let slug_is_explicit = trimmed_slug.is_some();
    let resolved_slug = if let Some(slug) = trimmed_slug {
        slug
    } else if let Some(name) = trimmed_name.as_deref() {
        let candidate = slugify_org_name(name);
        // Default single-tenant workspace names must never resolve to a
        // shared global slug: every client sends the same label, and a shared
        // slug would funnel every signup into one org (this is exactly how the
        // personal-organization/personal-team/personal-workspace orgs ended up
        // co-mingling real tenants). Pin these known defaults per-user. Any
        // other collision is still caught by the SlugTakenByOthers path below.
        if matches!(
            candidate.as_str(),
            "personal-organization" | "personal-team" | "personal-workspace"
        ) {
            owner_user_id
                .map(|owner| format!("user-{owner}").to_ascii_lowercase())
                .unwrap_or(candidate)
        } else {
            candidate
        }
    } else if let Some(owner) = owner_user_id {
        format!("user-{owner}").to_ascii_lowercase()
    } else {
        return Err(bad_request("orgSlug or orgName is required"));
    };

    if resolved_slug.trim().is_empty() {
        return Err(bad_request("orgSlug must not be empty"));
    }

    let resolved_name = trimmed_name.unwrap_or_else(|| {
        owner_user_id
            .map(|owner| format!("Workspace {}", owner.to_string()[..8].to_string()))
            .unwrap_or_else(|| "Instafy Workspace".to_string())
    });

    // Bound open-signup abuse: cap how many orgs a single user may own. Every
    // org auto-subscribes to Starter (daily credits + runtime slots), so
    // unbounded org creation multiplies free compute. Service-role callers
    // (backend/admin) are exempt. An idempotent re-create of a slug the user
    // already owns never counts against the cap.
    if let Some(owner) = owner_user_id {
        if !context.is_service_role && state.config.max_orgs_per_user > 0 {
            let already_owns_slug: bool = transaction
                .query_one(
                    "select exists(
                       select 1 from org_memberships m
                       join organizations o on o.id = m.org_id
                       where o.slug = $1 and m.user_id = $2 and m.role = 'owner'
                     )",
                    &[&resolved_slug, &owner],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to check existing org ownership: {error}"))
                })?
                .get(0);
            if !already_owns_slug {
                // Count only orgs the user MINTED, not ones they were invited
                // into as owner: upsert_org leaves invited_by NULL for the
                // creator, while the add-member/invite-accept paths set it to
                // the inviter. Without this, a user invited as owner into many
                // orgs would be wrongly blocked from creating their own first
                // workspace with a "delete an org" message they can't act on.
                let owned_count: i64 = transaction
                    .query_one(
                        "select count(*) from org_memberships
                         where user_id = $1 and role = 'owner' and invited_by is null",
                        &[&owner],
                    )
                    .await
                    .map_err(|error| {
                        internal_error(format!("failed to count owned orgs: {error}"))
                    })?
                    .get(0);
                if owned_count >= state.config.max_orgs_per_user {
                    return Err(forbidden(format!(
                        "Organization limit reached ({}). Delete an existing organization before creating another.",
                        state.config.max_orgs_per_user
                    )));
                }
            }
        }
    }

    let mut final_slug = resolved_slug.clone();
    let (org_id, org_name, created) =
        match upsert_org(&transaction, &resolved_slug, &resolved_name, owner_user_id).await? {
            OrgUpsertOutcome::Created(id, name) => (id, name, true),
            OrgUpsertOutcome::Existing(id, name) => (id, name, false),
            OrgUpsertOutcome::SlugTakenByOthers if !slug_is_explicit => {
                // The display-name-derived slug belongs to somebody else's
                // org: mint a fresh unique slug instead of joining theirs.
                let suffix = Uuid::new_v4().simple().to_string();
                final_slug = format!("{resolved_slug}-{}", &suffix[..8]);
                match upsert_org(&transaction, &final_slug, &resolved_name, owner_user_id).await? {
                    OrgUpsertOutcome::Created(id, name) => (id, name, true),
                    OrgUpsertOutcome::Existing(id, name) => (id, name, false),
                    OrgUpsertOutcome::SlugTakenByOthers => {
                        return Err(internal_error(
                            "failed to allocate a unique organization slug".to_string(),
                        ));
                    }
                }
            }
            OrgUpsertOutcome::SlugTakenByOthers => {
                return Err((
                    StatusCode::CONFLICT,
                    Json(ApiError {
                        message: "That organization slug is already in use. Pick a different slug."
                            .to_string(),
                        code: Some("org_slug_taken".to_string()),
                        details: None,
                    }),
                ));
            }
        };

    // Idempotent creation must not recolor an existing organization.
    if created {
        if let Some(color) = body.accent_color.as_deref() {
            transaction
                .execute(
                    "update organizations set accent_color = $2 where id = $1",
                    &[&org_id, &color],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to save organization color: {error}"))
                })?;
        }
    }
    let accent_color = transaction.query_one("select to_jsonb(o) ->> 'accent_color' as accent_color from organizations o where id = $1", &[&org_id])
        .await.map_err(|error| internal_error(format!("failed to read organization color: {error}")))?.get("accent_color");

    if let Err(error) =
        crate::billing::service::ensure_default_org_subscription(&transaction, &org_id).await
    {
        tracing::warn!(
            org_id = %org_id,
            error = %error,
            "ensure_default_org_subscription failed",
        );
    }

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize org create: {error}")))?;

    Ok(Json(CreateOrgResponse {
        org_id,
        org_slug: final_slug,
        org_name,
        accent_color,
    }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgLimitsSubscriptionResponse {
    plan_id: String,
    status: String,
    processor: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgLimitsOverridesResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    max_active_tunnels: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_active_hosted_runtimes: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgLimitsDefaultsResponse {
    max_active_tunnels: i64,
    max_active_hosted_runtimes: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrgLimitsResponse {
    org_id: Uuid,
    max_active_tunnels: i64,
    max_active_hosted_runtimes: i64,
    subscription: OrgLimitsSubscriptionResponse,
    defaults: OrgLimitsDefaultsResponse,
    overrides: OrgLimitsOverridesResponse,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OrgLimitsUpdateRequest {
    #[serde(default)]
    max_active_tunnels: Option<Option<i64>>,
    #[serde(default)]
    max_active_hosted_runtimes: Option<Option<i64>>,
}

async fn get_org_limits(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id_raw): Path<String>,
) -> Result<Json<OrgLimitsResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let _org = load_org_record(&transaction, &org_id).await?;
    if !context.is_service_role {
        require_org_access(&transaction, &org_id, &context).await?;
    }

    if let Err(error) =
        crate::billing::service::ensure_default_org_subscription(&transaction, &org_id).await
    {
        tracing::warn!(
            org_id = %org_id,
            error = %error,
            "ensure_default_org_subscription failed",
        );
    }

    let limits = crate::org_limits::resolve_org_resource_limits(&transaction, &org_id).await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize org limits: {error}")))?;

    Ok(Json(OrgLimitsResponse {
        org_id,
        max_active_tunnels: limits.max_active_tunnels,
        max_active_hosted_runtimes: limits.max_active_hosted_runtimes,
        subscription: OrgLimitsSubscriptionResponse {
            plan_id: limits.subscription.plan_id,
            status: limits.subscription.status,
            processor: limits.subscription.processor,
        },
        defaults: OrgLimitsDefaultsResponse {
            max_active_tunnels: limits.defaults.max_active_tunnels,
            max_active_hosted_runtimes: limits.defaults.max_active_hosted_runtimes,
        },
        overrides: OrgLimitsOverridesResponse {
            max_active_tunnels: limits.overrides.max_active_tunnels,
            max_active_hosted_runtimes: limits.overrides.max_active_hosted_runtimes,
        },
    }))
}

async fn patch_org_limits(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id_raw): Path<String>,
    Json(body): Json<OrgLimitsUpdateRequest>,
) -> Result<Json<OrgLimitsResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if !context.is_service_role {
        return Err(forbidden("Only the service role can update org limits."));
    }
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;

    if body.max_active_tunnels.is_none() && body.max_active_hosted_runtimes.is_none() {
        return Err(bad_request(
            "At least one limit field must be provided (maxActiveTunnels, maxActiveHostedRuntimes).",
        ));
    }

    let max_value = crate::org_limits::ORG_RESOURCE_LIMIT_MAX;
    for (label, value) in [
        ("maxActiveTunnels", body.max_active_tunnels.flatten()),
        (
            "maxActiveHostedRuntimes",
            body.max_active_hosted_runtimes.flatten(),
        ),
    ] {
        if let Some(limit) = value {
            if limit < 0 {
                return Err(bad_request(format!("{label} must be >= 0")));
            }
            if limit > max_value {
                return Err(bad_request(format!("{label} must be <= {max_value}")));
            }
        }
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

    let _org = load_org_record(&transaction, &org_id).await?;

    let existing = transaction
        .query_opt(
            "select max_active_tunnels, max_active_hosted_runtimes
             from org_resource_limits
             where org_id = $1
             limit 1
             for update",
            &[&org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load org limits: {error}")))?;

    let (mut next_tunnels, mut next_hosted) = match existing {
        Some(row) => (
            row.get::<_, Option<i64>>("max_active_tunnels"),
            row.get::<_, Option<i64>>("max_active_hosted_runtimes"),
        ),
        None => (None, None),
    };

    if let Some(value) = body.max_active_tunnels {
        next_tunnels = value;
    }
    if let Some(value) = body.max_active_hosted_runtimes {
        next_hosted = value;
    }

    transaction
        .execute(
            "insert into org_resource_limits (org_id, max_active_tunnels, max_active_hosted_runtimes)
             values ($1, $2, $3)
             on conflict (org_id) do update
             set max_active_tunnels = excluded.max_active_tunnels,
                 max_active_hosted_runtimes = excluded.max_active_hosted_runtimes,
                 updated_at = now()",
            &[&org_id, &next_tunnels, &next_hosted],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update org limits: {error}")))?;

    if let Err(error) =
        crate::billing::service::ensure_default_org_subscription(&transaction, &org_id).await
    {
        tracing::warn!(
            org_id = %org_id,
            error = %error,
            "ensure_default_org_subscription failed",
        );
    }

    let limits = crate::org_limits::resolve_org_resource_limits(&transaction, &org_id).await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize org limits update: {error}"))
    })?;

    Ok(Json(OrgLimitsResponse {
        org_id,
        max_active_tunnels: limits.max_active_tunnels,
        max_active_hosted_runtimes: limits.max_active_hosted_runtimes,
        subscription: OrgLimitsSubscriptionResponse {
            plan_id: limits.subscription.plan_id,
            status: limits.subscription.status,
            processor: limits.subscription.processor,
        },
        defaults: OrgLimitsDefaultsResponse {
            max_active_tunnels: limits.defaults.max_active_tunnels,
            max_active_hosted_runtimes: limits.defaults.max_active_hosted_runtimes,
        },
        overrides: OrgLimitsOverridesResponse {
            max_active_tunnels: limits.overrides.max_active_tunnels,
            max_active_hosted_runtimes: limits.overrides.max_active_hosted_runtimes,
        },
    }))
}

async fn get_project_summary(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id_raw): Path<String>,
) -> Result<Json<ProjectSummary>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let project_id = parse_uuid_param(project_id_raw, "project_id")?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Project summary", error))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| database_unavailable("Project summary", error))?;

    let record = load_project_record(&transaction, &project_id).await?;
    let access = ensure_project_read_access(&transaction, &record, &context, None).await?;

    let row = transaction
        .query_opt(
            "select p.id, p.org_id, p.name, p.icon, p.color, to_jsonb(p) ->> 'avatar_url' as avatar_url, p.owner_user_id, p.project_type, p.status,
                    o.slug as org_slug, o.name as org_name
             from projects p
             left join organizations o on o.id = p.org_id
             where p.id = $1
             limit 1",
            &[&project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load project summary: {error}")))?
        .ok_or_else(|| not_found("project not found"))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize project summary transaction: {error}"
        ))
    })?;

    Ok(Json(map_project_summary(row).with_access(access)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectUpdateRequest {
    #[serde(default, rename = "projectName", alias = "project_name")]
    project_name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_identity_patch")]
    project_icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_identity_patch")]
    project_color: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_identity_patch")]
    project_avatar_url: Option<Option<String>>,
}

// Public uploads on the configured self-hosted storage origin may use HTTP.
// External images must use HTTPS; credentials and executable URL schemes are rejected.
fn validate_identity_image_url(
    value: &str,
    storage_origin: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let url =
        reqwest::Url::parse(value).map_err(|_| bad_request("Picture must be a valid image URL"))?;
    let local_storage = reqwest::Url::parse(storage_origin)
        .ok()
        .is_some_and(|storage| {
            url.origin() == storage.origin()
                && url
                    .path()
                    .starts_with("/storage/v1/object/public/identity-images/")
        });
    if value.len() > 2048
        || !url.username().is_empty()
        || url.password().is_some()
        || !(url.scheme() == "https" || (url.scheme() == "http" && local_storage))
    {
        return Err(bad_request(
            "Picture must use HTTPS or the configured image storage",
        ));
    }
    Ok(())
}

fn deserialize_identity_patch<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

impl ProjectUpdateRequest {
    fn validate(&mut self) -> Result<(), (StatusCode, Json<ApiError>)> {
        if self.project_name.is_none()
            && self.project_icon.is_none()
            && self.project_color.is_none()
            && self.project_avatar_url.is_none()
        {
            return Err(bad_request(
                "Provide a projectName, projectIcon, projectColor or projectAvatarUrl",
            ));
        }
        if let Some(name) = &mut self.project_name {
            *name = name.trim().to_string();
            if name.is_empty() || name.chars().count() > 120 {
                return Err(bad_request(
                    "projectName must be between 1 and 120 characters",
                ));
            }
        }
        if let Some(Some(icon)) = &self.project_icon {
            if ![
                "🚀", "🛠️", "💡", "🌱", "🎨", "📚", "🔬", "🎯", "🌍", "⚡", "🏡", "🧩",
            ]
            .contains(&icon.as_str())
            {
                return Err(bad_request(
                    "projectIcon must be one of the supported space icons",
                ));
            }
        }
        if let Some(Some(color)) = &self.project_color {
            if ![
                "slate", "blue", "violet", "pink", "red", "orange", "green", "teal",
            ]
            .contains(&color.as_str())
            {
                return Err(bad_request(
                    "projectColor must be one of the supported space colors",
                ));
            }
        }
        Ok(())
    }
}

async fn update_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id_raw): Path<String>,
    Json(mut body): Json<ProjectUpdateRequest>,
) -> Result<Json<ProjectSummary>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let project_id = parse_uuid_param(project_id_raw, "project_id")?;

    body.validate()?;
    if let Some(Some(url)) = &body.project_avatar_url {
        validate_identity_image_url(url, &state.config._supabase_project_url)?;
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start project update transaction: {error}"
        ))
    })?;

    let record = load_project_record(&transaction, &project_id).await?;
    let access = ensure_project_write_access(&transaction, &record, &context, None).await?;

    transaction
        .execute(
            "update projects set name = coalesce($2, name),
                 icon = case when $3 then $4 else icon end,
                 color = case when $5 then $6 else color end,
                 avatar_url = case when $7 then $8 else avatar_url end,
                 updated_at = now() where id = $1",
            &[
                &project_id,
                &body.project_name,
                &body.project_icon.is_some(),
                &body.project_icon.clone().flatten(),
                &body.project_color.is_some(),
                &body.project_color.clone().flatten(),
                &body.project_avatar_url.is_some(),
                &body.project_avatar_url.clone().flatten(),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update project: {error}")))?;

    let row = transaction
        .query_one(
            "select p.id, p.org_id, p.name, p.icon, p.color, to_jsonb(p) ->> 'avatar_url' as avatar_url, p.owner_user_id, p.project_type, p.status,
                    o.slug as org_slug, o.name as org_name
             from projects p
             left join organizations o on o.id = p.org_id
             where p.id = $1
             limit 1",
            &[&project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load updated project: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize project update transaction: {error}"
        ))
    })?;

    Ok(Json(map_project_summary(row).with_access(access)))
}

async fn delete_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id_raw): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let project_id = parse_uuid_param(project_id_raw, "project_id")?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start project delete transaction: {error}"
        ))
    })?;

    let record = load_project_record(&transaction, &project_id).await?;
    if !context.is_service_role {
        ensure_project_write_access(&transaction, &record, &context, None).await?;
        require_project_deleter(&transaction, &record, &context).await?;
    }

    transaction
        .execute(
            "update projects set status = 'deleted', updated_at = now() where id = $1 and status <> 'deleted'",
            &[&project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to delete project: {error}")))?;

    transaction
        .execute(
            "delete from project_browser_profiles where project_id = $1",
            &[&project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to delete project browser profile: {error}"))
        })?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize project delete transaction: {error}"
        ))
    })?;

    Ok(StatusCode::NO_CONTENT)
}

async fn list_project_members(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id_raw): Path<String>,
) -> Result<Json<ProjectMembersResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let project_id = parse_uuid_param(project_id_raw, "project_id")?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Project members", error))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| database_unavailable("Project members", error))?;

    let record = load_project_record(&transaction, &project_id).await?;
    ensure_project_access(&transaction, &record, &context, None).await?;

    let members = load_project_memberships(&transaction, &project_id).await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize project member list transaction: {error}"
        ))
    })?;

    Ok(Json(ProjectMembersResponse { members }))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HumanProfileResponse {
    user_id: Uuid,
    display_name: Option<String>,
    avatar_url: Option<String>,
    bio: Option<String>,
}

// Match the browser profile defaults' JavaScript trim()/\s normalization,
// including the byte-order mark, without treating JSON numbers as names.
fn is_profile_metadata_whitespace(character: char) -> bool {
    matches!(character,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}'
        | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}'
        | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

fn human_profile_metadata_defaults(
    metadata: &serde_json::Value,
) -> (Option<String>, Option<String>) {
    let values = metadata.as_object();
    let string_claim = |key: &str| {
        values
            .and_then(|values| values.get(key))
            .and_then(serde_json::Value::as_str)
    };
    let display_name = [
        "full_name",
        "name",
        "display_name",
        "user_name",
        "preferred_username",
        "username",
    ]
    .into_iter()
    .filter_map(string_claim)
    .map(|value| {
        value
            .split(is_profile_metadata_whitespace)
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    })
    .find(|name| !name.is_empty() && !name.contains('@'));
    let avatar_url = ["avatar_url", "picture"]
        .into_iter()
        .filter_map(string_claim)
        .map(|value| value.trim_matches(is_profile_metadata_whitespace))
        .find(|value| !value.is_empty())
        .map(str::to_owned);
    (display_name, avatar_url)
}

async fn get_project_member_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id_raw, user_id_raw)): Path<(String, String)>,
) -> Result<Json<HumanProfileResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    crate::auth::require_user_session(&context)?;
    let project_id = parse_uuid_param(project_id_raw, "project_id")?;
    let user_id = parse_uuid_param(user_id_raw, "user_id")?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| database_unavailable("Member profile", error))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| database_unavailable("Member profile", error))?;

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_read_access(&transaction, &project, &context, None).await?;
    // The target must still be able to read this exact space. A shared team
    // elsewhere or a historical conversation appearance is not sufficient.
    let target_context = RequestContext {
        user_id: Some(user_id),
        is_service_role: false,
        scoped_claims: None,
    };
    ensure_project_read_access(&transaction, &project, &target_context, None).await?;

    let row = transaction
        .query_opt(
            "select u.id as user_id,
                    p.user_id is not null as has_saved_profile,
                    p.full_name as display_name, p.avatar_url, p.bio,
                    case when p.user_id is null then u.raw_user_meta_data
                    end as fallback_metadata
             from auth.users u
             left join profiles p on p.user_id = u.id
             where u.id = $1",
            &[&user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load member profile: {error}")))?
        .ok_or_else(|| not_found("member profile not found"))?;
    let (display_name, avatar_url) = if row.get::<_, bool>("has_saved_profile") {
        (row.get("display_name"), row.get("avatar_url"))
    } else {
        let metadata: Option<serde_json::Value> = row.get("fallback_metadata");
        human_profile_metadata_defaults(metadata.as_ref().unwrap_or(&serde_json::Value::Null))
    };
    let profile = HumanProfileResponse {
        user_id: row.get("user_id"),
        display_name,
        avatar_url,
        bio: row.get("bio"),
    };
    transaction.commit().await.map_err(|error| {
        internal_error(format!("failed to finalize member profile read: {error}"))
    })?;
    Ok(Json(profile))
}

/// Live (not deleted) projects of an org: the streams an org-wide signal
/// must reach, since every event stream is scoped to one project.
pub(crate) async fn load_org_project_ids(
    client: &impl tokio_postgres::GenericClient,
    org_id: &Uuid,
) -> Result<Vec<Uuid>, tokio_postgres::Error> {
    let rows = client
        .query(
            "select id from projects
             where org_id = $1 and lower(coalesce(status, '')) <> 'deleted'",
            &[org_id],
        )
        .await?;
    Ok(rows.into_iter().map(|row| row.get("id")).collect())
}

/// Publishes `project.members_changed` on every project stream of the org
/// after an org membership change has committed. Best effort: the membership
/// change already succeeded, and clients still refresh on focus/reconnect.
async fn publish_org_members_changed(
    client: &impl tokio_postgres::GenericClient,
    events: &EventHub,
    org_id: &Uuid,
) {
    match load_org_project_ids(client, org_id).await {
        Ok(project_ids) => publish_project_signal(
            events,
            PROJECT_MEMBERS_CHANGED_EVENT,
            &project_ids,
            MEMBERS_CHANGED_ORG_MEMBERSHIP,
        ),
        Err(error) => tracing::warn!(
            org_id = %org_id,
            %error,
            "failed to load org projects for members_changed; roster viewers refresh on focus"
        ),
    }
}

fn publish_project_members_changed(events: &EventHub, project_id: Uuid) {
    publish_project_signal(
        events,
        PROJECT_MEMBERS_CHANGED_EVENT,
        &[project_id],
        MEMBERS_CHANGED_PROJECT_MEMBERSHIP,
    );
}

async fn update_project_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id_raw, user_id_raw)): Path<(String, String)>,
    Json(body): Json<ProjectMemberUpdateRequest>,
) -> Result<Json<ProjectMemberResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let project_id = parse_uuid_param(project_id_raw, "project_id")?;
    let user_id = parse_uuid_param(user_id_raw, "user_id")?;
    let role = normalize_project_share_role(Some(body.role), None)?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start project member update transaction: {error}"
        ))
    })?;

    let record = load_project_record(&transaction, &project_id).await?;
    ensure_project_write_access(&transaction, &record, &context, None).await?;
    require_project_sharer(&transaction, &record, &context).await?;

    let updated = transaction
        .execute(
            "update project_memberships set role = $3 where project_id = $1 and user_id = $2",
            &[&project_id, &user_id, &role],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update project member: {error}")))?;

    if updated == 0 {
        return Err(not_found("project member not found"));
    }

    let member = load_project_member(&transaction, &project_id, &user_id).await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize project member update transaction: {error}"
        ))
    })?;

    publish_project_access_changed(&state.events, Some(project_id), user_id);
    publish_project_members_changed(&state.events, project_id);

    Ok(Json(ProjectMemberResponse { member }))
}

async fn remove_project_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((project_id_raw, user_id_raw)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let project_id = parse_uuid_param(project_id_raw, "project_id")?;
    let user_id = parse_uuid_param(user_id_raw, "user_id")?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start project member removal transaction: {error}"
        ))
    })?;

    let record = load_project_record(&transaction, &project_id).await?;
    ensure_project_write_access(&transaction, &record, &context, None).await?;
    require_project_sharer(&transaction, &record, &context).await?;

    let deleted = transaction
        .execute(
            "delete from project_memberships where project_id = $1 and user_id = $2",
            &[&project_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to remove project member: {error}")))?;

    if deleted == 0 {
        return Err(not_found("project member not found"));
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize project member removal transaction: {error}"
        ))
    })?;

    publish_project_access_changed(&state.events, Some(project_id), user_id);
    publish_project_members_changed(&state.events, project_id);

    Ok(StatusCode::NO_CONTENT)
}

async fn list_org_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id_raw): Path<String>,
) -> Result<Json<ProjectListResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!("failed to start org projects transaction: {error}"))
    })?;

    let _org = load_org_record(&transaction, &org_id).await?;
    if !context.is_service_role {
        require_org_access(&transaction, &org_id, &context).await?;
    }

    // Bounded result: an org's project list must never return an unbounded row
    // set (paired with the projects(org_id, status) index so it's a bounded
    // index scan, not a full-table seqscan). 1000 is far above any real org;
    // proper keyset pagination is the follow-up if an org ever approaches it.
    const ORG_PROJECT_LIST_LIMIT: i64 = 1000;
    let request_user_id = context.user_id;
    let rows = transaction
        .query(
            "select p.id, p.org_id, p.name, p.icon, p.color, to_jsonb(p) ->> 'avatar_url' as avatar_url, p.owner_user_id, p.project_type, p.status,
                    o.slug as org_slug, o.name as org_name,
                    access_pm.role as project_member_role,
                    access_om.role as org_member_role
             from projects p
             left join organizations o on o.id = p.org_id
             left join project_memberships access_pm
               on access_pm.project_id = p.id and access_pm.user_id = $2
             left join org_memberships access_om
               on access_om.org_id = p.org_id and access_om.user_id = $2
             where p.org_id = $1
               and p.status <> 'deleted'
             order by p.id
             limit $3",
            &[&org_id, &request_user_id, &ORG_PROJECT_LIST_LIMIT],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load org projects: {error}")))?;

    let mut projects = Vec::with_capacity(rows.len());
    for row in rows {
        let access = project_access_from_list_row(&row, &context)?;
        projects.push(map_project_summary(row).with_access(access));
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org project list transaction: {error}"
        ))
    })?;

    Ok(Json(ProjectListResponse { projects }))
}

async fn list_accessible_projects(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ProjectListResponse>, (StatusCode, Json<ApiError>)> {
    const ACCESSIBLE_PROJECT_LIST_LIMIT: i64 = 1000;
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden("Scoped access tokens cannot list projects"));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start accessible project list transaction: {error}"
        ))
    })?;

    let rows = if context.is_service_role {
        transaction
            .query(
                "select p.id, p.org_id, p.name, p.icon, p.color, to_jsonb(p) ->> 'avatar_url' as avatar_url, p.owner_user_id, p.project_type, p.status,
                        o.slug as org_slug, o.name as org_name,
                        null::text as project_member_role,
                        null::text as org_member_role,
                        greatest(p.created_at, p.updated_at,
                                 (select max(c.last_message_at) from conversations c where c.project_id = p.id)) as last_activity_at
                 from projects p
                 left join organizations o on o.id = p.org_id
                 where p.status <> 'deleted'
                 order by last_activity_at desc nulls last, p.id
                 limit $1",
                &[&ACCESSIBLE_PROJECT_LIST_LIMIT],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to load accessible projects: {error}"))
            })?
    } else if let Some(user_id) = context.user_id {
        transaction
            .query(
                "with accessible_project_ids as (
                   select p.id
                   from projects p
                   where p.owner_user_id = $1
                   union
                   select pm.project_id
                   from project_memberships pm
                   where pm.user_id = $1
                   union
                   select p.id
                   from org_memberships om
                   join projects p on p.org_id = om.org_id
                   where om.user_id = $1
                 )
                 select p.id, p.org_id, p.name, p.icon, p.color, to_jsonb(p) ->> 'avatar_url' as avatar_url, p.owner_user_id, p.project_type, p.status,
                        o.slug as org_slug, o.name as org_name,
                        access_pm.role as project_member_role,
                        access_om.role as org_member_role,
                        greatest(p.created_at, p.updated_at,
                                 (select max(c.last_message_at) from conversations c where c.project_id = p.id)) as last_activity_at
                 from accessible_project_ids accessible
                 join projects p on p.id = accessible.id
                 left join organizations o on o.id = p.org_id
                 left join project_memberships access_pm
                   on access_pm.project_id = p.id and access_pm.user_id = $1
                 left join org_memberships access_om
                   on access_om.org_id = p.org_id and access_om.user_id = $1
                 where p.status <> 'deleted'
                 order by last_activity_at desc nulls last, p.id
                 limit $2",
                &[&user_id, &ACCESSIBLE_PROJECT_LIST_LIMIT],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to load accessible projects: {error}"))
            })?
    } else {
        return Err(unauthorized(
            "authentication required to list accessible projects",
        ));
    };

    let mut projects = Vec::with_capacity(rows.len());
    for row in rows {
        let access = project_access_from_list_row(&row, &context)?;
        projects.push(map_project_summary(row).with_access(access));
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize accessible project list transaction: {error}"
        ))
    })?;

    Ok(Json(ProjectListResponse { projects }))
}

async fn list_org_members(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id_raw): Path<String>,
    Query(params): Query<OrgMembersQuery>,
) -> Result<Json<OrgMembersResponse>, (StatusCode, Json<ApiError>)> {
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;
    let context = authenticate_request(&state.config, &headers).await?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start org member list transaction: {error}"
        ))
    })?;

    require_org_access(&transaction, &org_id, &context).await?;
    let response = load_org_members(&transaction, &org_id, params).await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org member list transaction: {error}"
        ))
    })?;

    Ok(Json(response))
}

async fn add_org_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id_raw): Path<String>,
    Json(body): Json<OrgMemberCreateRequest>,
) -> Result<Json<OrgMemberResponse>, (StatusCode, Json<ApiError>)> {
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;
    let context = authenticate_request(&state.config, &headers).await?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start org member create transaction: {error}"
        ))
    })?;

    lock_org_membership_management(&transaction, &org_id).await?;
    let actor_role = require_org_manager(&transaction, &org_id, &context).await?;
    let normalized_role = normalize_org_role(body.role, Some("builder"))?;
    if normalized_role == "owner" && !actor_can_manage_owner(&context, actor_role.as_deref()) {
        return Err(forbidden(
            "Only organization owners can assign the owner role.",
        ));
    }

    let (user_id, resolved_email) =
        resolve_member_user_id(&transaction, body.user_id, body.email).await?;

    let inserted = transaction
        .execute(
            "insert into org_memberships (org_id, user_id, role, invited_by)
             values ($1, $2, $3, $4)
             on conflict (org_id, user_id) do nothing",
            &[&org_id, &user_id, &normalized_role, &context.user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to add org membership: {error}")))?;
    if inserted == 0 {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError {
                message: "User is already a member of this organization. Update the existing member to change their role."
                    .to_string(),
                code: Some("org_member_exists".to_string()),
                details: None,
            }),
        ));
    }

    let member = load_org_member(&transaction, &org_id, &user_id, resolved_email).await?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org member create transaction: {error}"
        ))
    })?;

    publish_project_access_changed(&state.events, None, user_id);
    publish_org_members_changed(&*connection, &state.events, &org_id).await;

    Ok(Json(OrgMemberResponse { member }))
}

async fn update_org_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((org_id_raw, user_id_raw)): Path<(String, String)>,
    Json(body): Json<OrgMemberUpdateRequest>,
) -> Result<Json<OrgMemberResponse>, (StatusCode, Json<ApiError>)> {
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;
    let user_id = parse_uuid_param(user_id_raw, "user_id")?;
    let context = authenticate_request(&state.config, &headers).await?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start org member update transaction: {error}"
        ))
    })?;

    lock_org_membership_management(&transaction, &org_id).await?;
    let actor_role = require_org_manager(&transaction, &org_id, &context).await?;
    let normalized_role = normalize_org_role(Some(body.role), None)?;

    let existing_role = load_org_member_role(&transaction, &org_id, &user_id).await?;
    let Some(existing_role) = existing_role else {
        return Err(not_found("org member not found"));
    };

    if existing_role == "owner" && normalized_role != "owner" {
        if !actor_can_manage_owner(&context, actor_role.as_deref()) {
            return Err(forbidden(
                "Only organization owners can change owner roles.",
            ));
        }
        ensure_owner_remaining(&transaction, &org_id, &user_id).await?;
    }

    if normalized_role == "owner" && !actor_can_manage_owner(&context, actor_role.as_deref()) {
        return Err(forbidden(
            "Only organization owners can assign the owner role.",
        ));
    }

    transaction
        .execute(
            "update org_memberships set role = $1 where org_id = $2 and user_id = $3",
            &[&normalized_role, &org_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to update org membership: {error}")))?;

    let member = load_org_member(&transaction, &org_id, &user_id, None).await?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org member update transaction: {error}"
        ))
    })?;

    publish_project_access_changed(&state.events, None, user_id);
    publish_org_members_changed(&*connection, &state.events, &org_id).await;

    Ok(Json(OrgMemberResponse { member }))
}

async fn remove_org_member(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((org_id_raw, user_id_raw)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;
    let user_id = parse_uuid_param(user_id_raw, "user_id")?;
    let context = authenticate_request(&state.config, &headers).await?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start org member removal transaction: {error}"
        ))
    })?;

    lock_org_membership_management(&transaction, &org_id).await?;
    let actor_role = require_org_manager(&transaction, &org_id, &context).await?;

    let existing_role = load_org_member_role(&transaction, &org_id, &user_id).await?;
    let Some(existing_role) = existing_role else {
        return Err(not_found("org member not found"));
    };

    if existing_role == "owner" {
        if !actor_can_manage_owner(&context, actor_role.as_deref()) {
            return Err(forbidden("Only organization owners can remove owners."));
        }
        ensure_owner_remaining(&transaction, &org_id, &user_id).await?;
    }

    transaction
        .execute(
            "delete from org_memberships where org_id = $1 and user_id = $2",
            &[&org_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to remove org membership: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org member removal transaction: {error}"
        ))
    })?;

    publish_project_access_changed(&state.events, None, user_id);
    publish_org_members_changed(&*connection, &state.events, &org_id).await;

    Ok(StatusCode::NO_CONTENT)
}

async fn list_org_invitations(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id_raw): Path<String>,
    Query(query): Query<OrgInvitationsQuery>,
) -> Result<Json<OrgInvitationsResponse>, (StatusCode, Json<ApiError>)> {
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;
    let context = authenticate_request(&state.config, &headers).await?;
    let project_id = match query.project_id {
        Some(raw) => Some(parse_uuid_param(raw, "projectId")?),
        None => None,
    };
    let conversation_id = match query.conversation_id {
        Some(raw) => Some(parse_uuid_param(raw, "conversationId")?),
        None => None,
    };
    if conversation_id.is_some() && project_id.is_none() {
        return Err(bad_request("conversationId requires projectId"));
    }
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start org invitation list transaction: {error}"
        ))
    })?;

    let rows = if let Some(project_id) = project_id {
        load_org_project_for_sharing(&transaction, &org_id, &project_id, &context).await?;
        validate_invite_conversation(&transaction, Some(project_id), conversation_id, &context)
            .await?;
        if let Some(conversation_id) = conversation_id {
            transaction
                .query(
                    "select id, org_id, project_id, conversation_id, email::text as email, role, invited_by, status, created_at, expires_at
                     from org_invitations
                     where org_id = $1 and project_id = $2 and conversation_id = $3 and status = 'pending'
                     order by created_at desc",
                    &[&org_id, &project_id, &conversation_id],
                )
                .await
                .map_err(|error| internal_error(format!("failed to load org invitations: {error}")))?
        } else {
            transaction
                .query(
                    "select id, org_id, project_id, conversation_id, email::text as email, role, invited_by, status, created_at, expires_at
                     from org_invitations
                     where org_id = $1
                       and project_id = $2
                       and conversation_id is null
                       and status = 'pending'
                     order by created_at desc",
                    &[&org_id, &project_id],
                )
                .await
                .map_err(|error| internal_error(format!("failed to load org invitations: {error}")))?
        }
    } else {
        require_org_manager(&transaction, &org_id, &context).await?;
        transaction
            .query(
                "select id, org_id, project_id, conversation_id, email::text as email, role, invited_by, status, created_at, expires_at
                 from org_invitations
                 where org_id = $1 and project_id is null and status = 'pending'
                 order by created_at desc",
                &[&org_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load org invitations: {error}")))?
    };

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org invitation list transaction: {error}"
        ))
    })?;

    let invitations = rows.into_iter().map(map_org_invitation_row).collect();
    Ok(Json(OrgInvitationsResponse { invitations }))
}

fn invitation_accept_urls(
    public_app_url: &str,
    token: &Uuid,
    project_id: Option<&Uuid>,
    conversation_id: Option<&Uuid>,
) -> (String, String) {
    let mut accept_path = format!("/invite?token={token}");
    if let Some(project_id) = project_id {
        accept_path.push_str(&format!("&projectId={project_id}"));
    }
    if let Some(conversation_id) = conversation_id {
        accept_path.push_str(&format!("&conversationControllerId={conversation_id}"));
    }
    accept_path.push_str("&panel=chat");

    let accept_url = format!("{}{}", public_app_url.trim_end_matches('/'), accept_path);
    (accept_path, accept_url)
}

async fn lock_org_invitation_scope(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: &Uuid,
    project_id: Option<&Uuid>,
    conversation_id: Option<&Uuid>,
    email: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    // The database has one pending invitation per email and exact share scope.
    // Match that invariant with a transaction lock so concurrent requests can
    // deterministically reuse the first invite instead of racing the unique
    // index or silently replacing its role/token.
    let lock_key = format!(
        "org-invitation:{org_id}:{}:{}:{}",
        project_id
            .map(Uuid::to_string)
            .unwrap_or_else(|| "org".to_string()),
        conversation_id
            .map(Uuid::to_string)
            .unwrap_or_else(|| "project".to_string()),
        email.trim().to_lowercase(),
    );
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&lock_key],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock org invitation scope: {error}")))?;
    Ok(())
}

async fn create_org_invitation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id_raw): Path<String>,
    Json(body): Json<OrgInvitationCreateRequest>,
) -> Result<Json<OrgInvitationResponse>, (StatusCode, Json<ApiError>)> {
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;
    let context = authenticate_request(&state.config, &headers).await?;

    let trimmed_email = body.email.trim().to_string();
    if trimmed_email.is_empty() {
        return Err(bad_request("email is required"));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start org invitation create transaction: {error}"
        ))
    })?;

    let project_id = match body.project_id {
        Some(raw) => Some(parse_uuid_param(raw, "projectId")?),
        None => None,
    };
    let conversation_id = match body.conversation_id {
        Some(raw) => Some(parse_uuid_param(raw, "conversationId")?),
        None => None,
    };
    if conversation_id.is_some() && project_id.is_none() {
        return Err(bad_request("conversationId requires projectId"));
    }
    let actor_role = if let Some(project_id) = project_id {
        load_org_project_for_sharing(&transaction, &org_id, &project_id, &context).await?;
        None
    } else {
        require_org_manager(&transaction, &org_id, &context).await?
    };
    let normalized_role = if project_id.is_some() {
        normalize_project_share_role(body.role, Some("builder"))?
    } else {
        normalize_org_role(body.role, Some("builder"))?
    };
    if project_id.is_none()
        && normalized_role == "owner"
        && !actor_can_manage_owner(&context, actor_role.as_deref())
    {
        return Err(forbidden(
            "Only organization owners can assign the owner role.",
        ));
    }

    if let Some(project_id) = project_id {
        let row = transaction
            .query_opt(
                "select name from projects where id = $1 and org_id = $2 and status <> 'deleted' limit 1",
                &[&project_id, &org_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to verify project: {error}")))?;
        if row.is_none() {
            return Err(bad_request(
                "projectId does not belong to this organization",
            ));
        }
        validate_invite_conversation(&transaction, Some(project_id), conversation_id, &context)
            .await?;
    }

    let existing_org_member = transaction
        .query_opt(
            "select 1
             from org_memberships m
             join auth.users u on u.id = m.user_id
             where m.org_id = $1 and lower(u.email) = lower($2)
             limit 1",
            &[&org_id, &trimmed_email],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check org membership: {error}")))?;

    if project_id.is_none() {
        if existing_org_member.is_some() {
            return Err(bad_request("user is already a member of this organization"));
        }
    } else if conversation_id.is_none() && existing_org_member.is_some() {
        return Err(bad_request(
            "user already has access to this space through the organization",
        ));
    }

    if let Some(project_id) = project_id {
        let existing_project_member = transaction
            .query_opt(
                "select 1
                 from project_memberships pm
                 join auth.users u on u.id = pm.user_id
                 where pm.project_id = $1 and lower(u.email) = lower($2)
                 limit 1",
                &[&project_id, &trimmed_email],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to check project membership: {error}"))
            })?;
        if conversation_id.is_none() && existing_project_member.is_some() {
            return Err(bad_request("user already has access to this space"));
        }
    }

    lock_org_invitation_scope(
        &transaction,
        &org_id,
        project_id.as_ref(),
        conversation_id.as_ref(),
        &trimmed_email,
    )
    .await?;

    let pending_row = if let Some(project_id) = project_id {
        transaction
            .query_opt(
                "select id, org_id, project_id, conversation_id, email::text as email, role,
                        token, invited_by, status, created_at, expires_at
                 from org_invitations
                 where org_id = $1
                   and project_id = $2
                   and conversation_id is not distinct from $3
                   and lower(email) = lower($4)
                   and status = 'pending'
                 limit 1
                 for update",
                &[&org_id, &project_id, &conversation_id, &trimmed_email],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to check existing project invitation: {error}"
                ))
            })?
    } else {
        transaction
            .query_opt(
                "select id, org_id, project_id, conversation_id, email::text as email, role,
                        token, invited_by, status, created_at, expires_at
                 from org_invitations
                 where org_id = $1 and project_id is null and lower(email) = lower($2) and status = 'pending'
                 limit 1
                 for update",
                &[&org_id, &trimmed_email],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to check existing org invitation: {error}"))
            })?
    };

    if let Some(existing) = pending_row {
        let invitation_id: Uuid = existing.get("id");
        let existing_role: String = existing.get("role");
        let existing_expires_at: Option<DateTime<Utc>> = existing.get("expires_at");
        let is_unexpired = existing_expires_at
            .map(|value| value > Utc::now())
            .unwrap_or(true);

        if is_unexpired && existing_role != normalized_role {
            return Err((
                StatusCode::CONFLICT,
                Json(ApiError::with_details(
                    "A pending invitation already exists with a different role.",
                    "invitation_role_conflict",
                    json!({
                        "invitationId": invitation_id,
                        "existingRole": existing_role,
                        "requestedRole": normalized_role,
                    }),
                )),
            ));
        }

        if is_unexpired {
            let token: Uuid = existing.get("token");
            let invitation = map_org_invitation_row(existing);
            let (_, accept_url) = invitation_accept_urls(
                &state.config.public_app_url,
                &token,
                project_id.as_ref(),
                conversation_id.as_ref(),
            );
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to finalize existing org invitation lookup: {error}"
                ))
            })?;
            return Ok(Json(OrgInvitationResponse {
                invitation,
                accept_url,
            }));
        }

        transaction
            .execute(
                "update org_invitations
                 set status = 'expired'
                 where id = $1 and org_id = $2 and status = 'pending'",
                &[&invitation_id, &org_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to expire stale org invitation: {error}"))
            })?;
    }

    let org = load_org_record(&transaction, &org_id).await?;
    let project_name = if let Some(project_id) = project_id {
        transaction
            .query_opt(
                "select name from projects where id = $1 limit 1",
                &[&project_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load project name: {error}")))?
            .and_then(|row| row.get::<_, Option<String>>("name"))
    } else {
        None
    };
    let token = Uuid::new_v4();
    let expires_at = Utc::now() + Duration::days(7);
    let row = transaction
        .query_one(
            "insert into org_invitations (org_id, project_id, conversation_id, email, role, token, invited_by, expires_at)
             values ($1, $2, $3, $4, $5, $6, $7, $8)
             returning id, org_id, project_id, conversation_id, email::text as email, role, invited_by, status, created_at, expires_at",
            &[
                &org_id,
                &project_id,
                &conversation_id,
                &trimmed_email,
                &normalized_role,
                &token,
                &context.user_id,
                &expires_at,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to create org invitation: {error}")))?;

    let invitation = map_org_invitation_row(row);
    let (accept_path, accept_url) = invitation_accept_urls(
        &state.config.public_app_url,
        &token,
        project_id.as_ref(),
        conversation_id.as_ref(),
    );
    let subject = if let Some(project_name) = project_name.as_deref() {
        format!(
            "You're invited to join {} in {} on Instafy",
            project_name, org.name
        )
    } else {
        format!("You're invited to join {} on Instafy", org.name)
    };
    let body_text = if let Some(project_name) = project_name.as_deref() {
        format!(
            "You've been invited to join {} in {} as {}.\n\nAccept: {}\n\nIf you did not expect this email, you can ignore it.\n",
            project_name, org.name, normalized_role, accept_url
        )
    } else {
        format!(
            "You've been invited to join {} as {}.\n\nAccept: {}\n\nIf you did not expect this email, you can ignore it.\n",
            org.name, normalized_role, accept_url
        )
    };

    transaction
        .execute(
            "insert into email_outbox (to_email, subject, body_text, metadata)
             values ($1, $2, $3, $4)",
            &[
                &invitation.email,
                &subject,
                &body_text,
                &json!({
                    "kind": "org_invitation",
                    "orgId": org_id,
                    "orgName": org.name,
                    "projectId": project_id,
                    "conversationId": conversation_id,
                    "projectName": project_name,
                    "invitationId": invitation.id,
                    "token": token,
                    "acceptPath": accept_path,
                    "acceptUrl": accept_url,
                    "role": normalized_role,
                }),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to store invitation email: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org invitation create transaction: {error}"
        ))
    })?;

    Ok(Json(OrgInvitationResponse {
        invitation,
        accept_url,
    }))
}

async fn list_org_invite_links(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id_raw): Path<String>,
    Query(query): Query<OrgInviteLinkListQuery>,
) -> Result<Json<OrgInviteLinksResponse>, (StatusCode, Json<ApiError>)> {
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;
    let context = authenticate_request(&state.config, &headers).await?;

    let project_id = match query.project_id {
        Some(raw) => Some(parse_uuid_param(raw, "projectId")?),
        None => None,
    };
    let conversation_id = match query.conversation_id {
        Some(raw) => Some(parse_uuid_param(raw, "conversationId")?),
        None => None,
    };
    if conversation_id.is_some() && project_id.is_none() {
        return Err(bad_request("conversationId requires projectId"));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start org invite link list transaction: {error}"
        ))
    })?;

    if let Some(project_id) = project_id {
        load_org_project_for_sharing(&transaction, &org_id, &project_id, &context).await?;
        validate_invite_conversation(&transaction, Some(project_id), conversation_id, &context)
            .await?;
    } else {
        require_org_manager(&transaction, &org_id, &context).await?;
    }

    let rows = if let Some(project_id) = project_id {
        if let Some(conversation_id) = conversation_id {
            transaction
                .query(
                    "select id, org_id, project_id, conversation_id, role, token, status, created_at, expires_at
                     from org_invite_links
                     where org_id = $1
                       and project_id = $2
                       and conversation_id = $3
                       and status = 'active'
                       and (expires_at is null or expires_at > now())
                     order by created_at desc",
                    &[&org_id, &project_id, &conversation_id],
                )
                .await
                .map_err(|error| internal_error(format!("failed to load invite links: {error}")))?
        } else {
            transaction
                .query(
                    "select id, org_id, project_id, conversation_id, role, token, status, created_at, expires_at
                     from org_invite_links
                     where org_id = $1
                       and project_id = $2
                       and conversation_id is null
                       and status = 'active'
                       and (expires_at is null or expires_at > now())
                     order by created_at desc",
                    &[&org_id, &project_id],
                )
                .await
                .map_err(|error| internal_error(format!("failed to load invite links: {error}")))?
        }
    } else {
        transaction
            .query(
                "select id, org_id, project_id, conversation_id, role, token, status, created_at, expires_at
                 from org_invite_links
                 where org_id = $1
                   and project_id is null
                   and conversation_id is null
                   and status = 'active'
                   and (expires_at is null or expires_at > now())
                 order by created_at desc",
                &[&org_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load invite links: {error}")))?
    };

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org invite link list transaction: {error}"
        ))
    })?;

    let invite_links = rows
        .into_iter()
        .map(|row| {
            let id: Uuid = row.get("id");
            let org_id: Uuid = row.get("org_id");
            let project_id: Option<Uuid> = row.get("project_id");
            let conversation_id: Option<Uuid> = row.get("conversation_id");
            let role: String = row.get("role");
            let token: Uuid = row.get("token");
            let status: String = row.get("status");
            let created_at: DateTime<Utc> = row.get("created_at");
            let expires_at: Option<DateTime<Utc>> = row.get("expires_at");

            let mut accept_path = format!("/invite?token={token}");
            if let Some(project_id) = project_id {
                accept_path.push_str(&format!("&projectId={project_id}"));
            }
            if let Some(conversation_id) = conversation_id {
                accept_path.push_str(&format!("&conversationControllerId={conversation_id}"));
            }
            accept_path.push_str("&panel=chat");

            OrgInviteLinkPayload {
                id,
                org_id,
                project_id,
                conversation_id,
                role,
                status,
                created_at: created_at.to_rfc3339(),
                expires_at: expires_at.map(|value| value.to_rfc3339()),
                token,
                accept_path,
            }
        })
        .collect();

    Ok(Json(OrgInviteLinksResponse { invite_links }))
}

async fn create_org_invite_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id_raw): Path<String>,
    Json(body): Json<OrgInviteLinkCreateRequest>,
) -> Result<Json<OrgInviteLinkResponse>, (StatusCode, Json<ApiError>)> {
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;
    let context = authenticate_request(&state.config, &headers).await?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start org invite link create transaction: {error}"
        ))
    })?;

    let normalized_role = normalize_project_share_role(body.role, Some("builder"))?;

    let project_id = match body.project_id {
        Some(raw) => Some(parse_uuid_param(raw, "projectId")?),
        None => None,
    };
    let conversation_id = match body.conversation_id {
        Some(raw) => Some(parse_uuid_param(raw, "conversationId")?),
        None => None,
    };
    if conversation_id.is_some() && project_id.is_none() {
        return Err(bad_request("conversationId requires projectId"));
    }

    if let Some(project_id) = project_id {
        load_org_project_for_sharing(&transaction, &org_id, &project_id, &context).await?;
    } else {
        require_org_manager(&transaction, &org_id, &context).await?;
    }

    if let Some(project_id) = project_id {
        let row = transaction
            .query_opt(
                "select 1 from projects where id = $1 and org_id = $2 and status <> 'deleted' limit 1",
                &[&project_id, &org_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to verify project: {error}")))?;
        if row.is_none() {
            return Err(bad_request(
                "projectId does not belong to this organization",
            ));
        }
        validate_invite_conversation(&transaction, Some(project_id), conversation_id, &context)
            .await?;
    }

    // Serialize rotation for the exact sharing scope. Without a transaction-level
    // lock, two concurrent create requests can both revoke the old link and then
    // insert separate active links.
    let invite_scope_lock = format!(
        "org-invite-link:{org_id}:{}:{}",
        project_id
            .map(|value| value.to_string())
            .unwrap_or_else(|| "org".to_string()),
        conversation_id
            .map(|value| value.to_string())
            .unwrap_or_else(|| "project".to_string()),
    );
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&invite_scope_lock],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock invite link scope: {error}")))?;

    // Rotate only links with the same project/conversation scope. A project
    // share link must not silently replace a private-chat invitation.
    transaction
        .execute(
            "update org_invite_links
             set status = 'revoked', revoked_at = now(), revoked_by = $4
             where org_id = $1
               and project_id is not distinct from $2
               and conversation_id is not distinct from $3
               and status = 'active'",
            &[&org_id, &project_id, &conversation_id, &context.user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to revoke existing invite links: {error}"))
        })?;

    let _org = load_org_record(&transaction, &org_id).await?;
    let token = Uuid::new_v4();
    let expires_at = Utc::now() + Duration::days(30);

    let row = transaction
        .query_one(
            "insert into org_invite_links (org_id, project_id, conversation_id, role, token, created_by, expires_at)
             values ($1, $2, $3, $4, $5, $6, $7)
             returning id, org_id, project_id, conversation_id, role, token, status, created_at, expires_at",
            &[
                &org_id,
                &project_id,
                &conversation_id,
                &normalized_role,
                &token,
                &context.user_id,
                &expires_at,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to create org invite link: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org invite link create transaction: {error}"
        ))
    })?;

    let id: Uuid = row.get("id");
    let created_at: DateTime<Utc> = row.get("created_at");
    let status: String = row.get("status");
    let expires_at: Option<DateTime<Utc>> = row.get("expires_at");

    let mut accept_path = format!("/invite?token={token}");
    if let Some(project_id) = project_id {
        accept_path.push_str(&format!("&projectId={project_id}"));
    }
    if let Some(conversation_id) = conversation_id {
        accept_path.push_str(&format!("&conversationControllerId={conversation_id}"));
    }
    accept_path.push_str("&panel=chat");

    Ok(Json(OrgInviteLinkResponse {
        invite_link: OrgInviteLinkPayload {
            id,
            org_id,
            project_id,
            conversation_id,
            role: normalized_role,
            status,
            created_at: created_at.to_rfc3339(),
            expires_at: expires_at.map(|value| value.to_rfc3339()),
            token,
            accept_path,
        },
    }))
}

async fn revoke_org_invite_link(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((org_id_raw, invite_link_id_raw)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;
    let invite_link_id = parse_uuid_param(invite_link_id_raw, "invite_link_id")?;
    let context = authenticate_request(&state.config, &headers).await?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start org invite link revoke transaction: {error}"
        ))
    })?;

    let row = transaction
        .query_opt(
            "select id, project_id, conversation_id, status
             from org_invite_links
             where id = $1 and org_id = $2
             limit 1
             for update",
            &[&invite_link_id, &org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load invite link: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("invite link not found"));
    };

    let project_id: Option<Uuid> = row.get("project_id");
    let conversation_id: Option<Uuid> = row.get("conversation_id");
    let status: String = row.get("status");

    if let Some(project_id) = project_id {
        load_org_project_for_sharing(&transaction, &org_id, &project_id, &context).await?;
        validate_invite_conversation(&transaction, Some(project_id), conversation_id, &context)
            .await
            .map_err(|_| not_found("invite link not found"))?;
    } else {
        require_org_manager(&transaction, &org_id, &context).await?;
    }

    if status != "active" {
        transaction.commit().await.map_err(|error| {
            internal_error(format!(
                "failed to finalize org invite link revoke transaction: {error}"
            ))
        })?;
        return Ok(StatusCode::NO_CONTENT);
    }

    transaction
        .execute(
            "update org_invite_links
             set status = 'revoked', revoked_at = now(), revoked_by = $2
             where id = $1",
            &[&invite_link_id, &context.user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to revoke invite link: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org invite link revoke transaction: {error}"
        ))
    })?;

    Ok(StatusCode::NO_CONTENT)
}

async fn cancel_org_invitation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((org_id_raw, invitation_id_raw)): Path<(String, String)>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;
    let invitation_id = parse_uuid_param(invitation_id_raw, "invitation_id")?;
    let context = authenticate_request(&state.config, &headers).await?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start org invitation cancel transaction: {error}"
        ))
    })?;

    let invitation = transaction
        .query_opt(
            "select project_id, conversation_id
             from org_invitations
             where id = $1 and org_id = $2 and status = 'pending'
             limit 1",
            &[&invitation_id, &org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load org invitation: {error}")))?;

    let Some(invitation) = invitation else {
        return Err(not_found("org invitation not found"));
    };
    let project_id: Option<Uuid> = invitation.get("project_id");
    let conversation_id: Option<Uuid> = invitation.get("conversation_id");
    if let Some(project_id) = project_id {
        load_org_project_for_sharing(&transaction, &org_id, &project_id, &context).await?;
        validate_invite_conversation(&transaction, Some(project_id), conversation_id, &context)
            .await
            .map_err(|_| not_found("org invitation not found"))?;
    } else {
        require_org_manager(&transaction, &org_id, &context).await?;
    }

    let updated = transaction
        .execute(
            "update org_invitations
             set status = 'canceled', canceled_at = now()
             where id = $1 and org_id = $2 and status = 'pending'",
            &[&invitation_id, &org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to cancel org invitation: {error}")))?;

    if updated == 0 {
        return Err(not_found("org invitation not found"));
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org invitation cancel transaction: {error}"
        ))
    })?;

    Ok(StatusCode::NO_CONTENT)
}

/// Changes the role on a pending invitation in place.
///
/// Replaces the cancel-and-recreate dance the create handler's 409
/// `invitation_role_conflict` used to force. The token is deliberately
/// untouched: an accept link already sitting in the invitee's inbox stays
/// valid and grants the new role, because accept resolves the role from the
/// row at accept time. For the same reason no email_outbox entry is written
/// here — the create-path email remains the only invitation mail.
async fn update_org_invitation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((org_id_raw, invitation_id_raw)): Path<(String, String)>,
    Json(body): Json<OrgInvitationUpdateRequest>,
) -> Result<Json<OrgInvitationResponse>, (StatusCode, Json<ApiError>)> {
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;
    let invitation_id = parse_uuid_param(invitation_id_raw, "invitation_id")?;
    let context = authenticate_request(&state.config, &headers).await?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start org invitation role transaction: {error}"
        ))
    })?;

    // Read WITHOUT `for update`: create acquires the scope advisory lock
    // before its row lock, so this handler must take them in the same order
    // (advisory below, then the guarded UPDATE) to serialize against a
    // concurrent create without lock inversion. The UPDATE's status guard
    // re-checks the race window this unlocked read leaves open.
    let invitation = transaction
        .query_opt(
            "select project_id, conversation_id, email::text as email, expires_at
             from org_invitations
             where id = $1 and org_id = $2 and status = 'pending'
             limit 1",
            &[&invitation_id, &org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load org invitation: {error}")))?;

    let Some(invitation) = invitation else {
        return Err(not_found("org invitation not found"));
    };
    let project_id: Option<Uuid> = invitation.get("project_id");
    let conversation_id: Option<Uuid> = invitation.get("conversation_id");
    let invited_email: String = invitation.get("email");
    let expires_at: Option<DateTime<Utc>> = invitation.get("expires_at");

    let actor_role = if let Some(project_id) = project_id {
        load_org_project_for_sharing(&transaction, &org_id, &project_id, &context).await?;
        validate_invite_conversation(&transaction, Some(project_id), conversation_id, &context)
            .await
            .map_err(|_| not_found("org invitation not found"))?;
        None
    } else {
        require_org_manager(&transaction, &org_id, &context).await?
    };

    // Same normalization split as create: the caller may only assign roles
    // they could have granted when issuing the invite in the first place.
    let normalized_role = if project_id.is_some() {
        normalize_project_share_role(Some(body.role), None)?
    } else {
        normalize_org_role(Some(body.role), None)?
    };
    if project_id.is_none()
        && normalized_role == "owner"
        && !actor_can_manage_owner(&context, actor_role.as_deref())
    {
        return Err(forbidden(
            "Only organization owners can assign the owner role.",
        ));
    }

    // Create treats an expired pending row as replaceable, not mutable;
    // changing its role here would resurrect an invite that the next create
    // on this scope is entitled to expire and supersede.
    if expires_at.map(|value| value <= Utc::now()).unwrap_or(false) {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::with_details(
                "This invitation has expired. Send a new invite instead.",
                "invitation_expired",
                json!({ "invitationId": invitation_id }),
            )),
        ));
    }

    lock_org_invitation_scope(
        &transaction,
        &org_id,
        project_id.as_ref(),
        conversation_id.as_ref(),
        &invited_email,
    )
    .await?;

    let row = transaction
        .query_opt(
            "update org_invitations
             set role = $1
             where id = $2 and org_id = $3 and status = 'pending'
               and (expires_at is null or expires_at > now())
             returning id, org_id, project_id, conversation_id, email::text as email, role,
                       token, invited_by, status, created_at, expires_at",
            &[&normalized_role, &invitation_id, &org_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to update org invitation role: {error}"))
        })?;

    let Some(row) = row else {
        // The invitation was canceled, accepted, or expired between the
        // unlocked read and the guarded UPDATE; the expiry predicate above
        // keeps the pre-lock expiry check from being a TOCTOU hole.
        return Err(not_found("org invitation not found"));
    };

    let token: Uuid = row.get("token");
    let invitation = map_org_invitation_row(row);
    let (_, accept_url) = invitation_accept_urls(
        &state.config.public_app_url,
        &token,
        project_id.as_ref(),
        conversation_id.as_ref(),
    );

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org invitation role transaction: {error}"
        ))
    })?;

    Ok(Json(OrgInvitationResponse {
        invitation,
        accept_url,
    }))
}

/// Shows an invitee what a token grants BEFORE any membership is written.
///
/// Strictly read-only: unlike accept, expiry is computed and reported but the
/// lazy status='expired' transition is never performed, so previewing an
/// invitation cannot mutate it. Error strings are identical to accept's so
/// the consent card needs no copy of its own.
///
/// Same auth gate as accept (signed-in, unscoped) but deliberately WITHOUT
/// the invited-email match: a wrong-account user needs to see who invited
/// them and to what in order to choose "Use another account". The invited
/// address is returned masked so preview exposes no more than accept's own
/// error message already implies.
fn mask_invited_email(email: &str) -> String {
    match email.split_once('@') {
        Some((local, domain)) if !local.is_empty() => {
            let first = local.chars().next().unwrap_or('?');
            format!("{first}\u{2026}@{domain}")
        }
        _ => "\u{2026}".to_string(),
    }
}

async fn preview_org_invitation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<OrgInvitationPreviewQuery>,
) -> Result<Json<OrgInvitationPreviewResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Scoped access tokens cannot preview organization invitations",
        ));
    }
    context.user_id.ok_or_else(|| {
        unauthorized("authentication required to preview organization invitations")
    })?;

    let token = parse_uuid_param(query.token, "token")?;

    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;

    // Same lookups as accept, minus `for update` and minus every write.
    let invite_row = connection
        .query_opt(
            "select org_id, project_id, conversation_id, email::text as email, role, invited_by, status, expires_at
             from org_invitations
             where token = $1
             limit 1",
            &[&token],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load org invitation: {error}")))?;

    let (
        kind,
        org_id,
        project_id,
        conversation_id,
        invited_email,
        role,
        inviter_id,
        status_ok,
        expires_at,
    ) = if let Some(row) = invite_row {
        let status: String = row.get("status");
        let expires_at: Option<DateTime<Utc>> = row.get("expires_at");
        if status != "pending" {
            return Err(bad_request("invitation is no longer valid"));
        }
        if expires_at.is_some_and(|expiration| expiration < Utc::now()) {
            return Err(bad_request("invitation has expired"));
        }
        (
            "invitation",
            row.get::<_, Uuid>("org_id"),
            row.get::<_, Option<Uuid>>("project_id"),
            row.get::<_, Option<Uuid>>("conversation_id"),
            row.get::<_, Option<String>>("email"),
            row.get::<_, String>("role"),
            row.get::<_, Option<Uuid>>("invited_by"),
            true,
            expires_at,
        )
    } else {
        let link_row = connection
            .query_opt(
                "select org_id, project_id, conversation_id, role, created_by, status, expires_at
                     from org_invite_links
                     where token = $1
                     limit 1",
                &[&token],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load org invite link: {error}")))?;
        let Some(row) = link_row else {
            return Err(not_found("invitation not found"));
        };
        let status: String = row.get("status");
        let expires_at: Option<DateTime<Utc>> = row.get("expires_at");
        if status != "active" {
            return Err(bad_request("invite link is no longer valid"));
        }
        if expires_at.is_some_and(|expiration| expiration < Utc::now()) {
            return Err(bad_request("invite link has expired"));
        }
        (
            "inviteLink",
            row.get::<_, Uuid>("org_id"),
            row.get::<_, Option<Uuid>>("project_id"),
            row.get::<_, Option<Uuid>>("conversation_id"),
            None,
            row.get::<_, String>("role"),
            row.get::<_, Option<Uuid>>("created_by"),
            true,
            expires_at,
        )
    };
    debug_assert!(status_ok);

    let org_row = connection
        .query_opt(
            "select slug, name from organizations where id = $1 limit 1",
            &[&org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load organization: {error}")))?;
    let Some(org_row) = org_row else {
        return Err(not_found("organization not found"));
    };

    let (project_name, conversation_name) = {
        let mut project_name: Option<String> = None;
        let mut conversation_name: Option<String> = None;
        if let Some(project_id) = project_id {
            let project_row = connection
                .query_opt(
                    "select status, name from projects where id = $1 limit 1",
                    &[&project_id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to load project for invite: {error}"))
                })?;
            let Some(project_row) = project_row else {
                return Err(not_found("project not found"));
            };
            let status: String = project_row.get("status");
            if status == "deleted" {
                return Err(bad_request("project is no longer available"));
            }
            project_name = project_row.get::<_, Option<String>>("name");
        }
        // Softer than accept on purpose: a vanished or now-public conversation
        // should fail at accept time, not blank the consent card.
        if let Some(conversation_id) = conversation_id {
            conversation_name = connection
                .query_opt(
                    "select title from conversations where id = $1 limit 1",
                    &[&conversation_id],
                )
                .await
                .ok()
                .flatten()
                .and_then(|row| row.get::<_, Option<String>>("title"));
        }
        (project_name, conversation_name)
    };

    let (inviter_name, inviter_email) = if let Some(inviter_id) = inviter_id {
        connection
            .query_opt(
                "select u.email::text as email,
                        coalesce(
                          nullif(btrim(p.full_name), ''),
                          nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                          nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                          nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '')
                        ) as display_name
                 from auth.users u
                 left join profiles p on p.user_id = u.id
                 where u.id = $1
                 limit 1",
                &[&inviter_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load inviter: {error}")))?
            .map(|row| {
                (
                    row.get::<_, Option<String>>("display_name"),
                    row.get::<_, Option<String>>("email"),
                )
            })
            .unwrap_or((None, None))
    } else {
        (None, None)
    };

    Ok(Json(OrgInvitationPreviewResponse {
        kind: kind.to_string(),
        org_id,
        org_slug: org_row.get("slug"),
        org_name: org_row.get("name"),
        role,
        invited_email_masked: invited_email.as_deref().map(mask_invited_email),
        inviter_name,
        inviter_email,
        project_id,
        project_name,
        conversation_id,
        conversation_name,
        expires_at: expires_at.map(|value| value.to_rfc3339()),
    }))
}

async fn accept_org_invitation(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<OrgInvitationAcceptRequest>,
) -> Result<Json<OrgInvitationAcceptResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Scoped access tokens cannot accept organization invitations",
        ));
    }
    let user_id = context.user_id.ok_or_else(|| {
        unauthorized("authentication required to accept organization invitations")
    })?;

    let token = parse_uuid_param(body.token, "token")?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start org invitation accept transaction: {error}"
        ))
    })?;

    let invite_row = transaction
        .query_opt(
            "select id, org_id, project_id, conversation_id, email::text as email, role, invited_by, status, expires_at
             from org_invitations
             where token = $1
             limit 1
             for update",
            &[&token],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load org invitation: {error}")))?;

    if invite_row.is_none() {
        let link_row = transaction
            .query_opt(
                "select id, org_id, project_id, conversation_id, role, created_by, status, expires_at
                 from org_invite_links
                 where token = $1
                 limit 1
                 for update",
                &[&token],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load org invite link: {error}")))?;

        let Some(link_row) = link_row else {
            return Err(not_found("invitation not found"));
        };

        let link_id: Uuid = link_row.get("id");
        let org_id: Uuid = link_row.get("org_id");
        let project_id: Option<Uuid> = link_row.get("project_id");
        let conversation_id: Option<Uuid> = link_row.get("conversation_id");
        let role: String = link_row.get("role");
        let created_by: Option<Uuid> = link_row.get("created_by");
        let status: String = link_row.get("status");
        let expires_at: Option<DateTime<Utc>> = link_row.get("expires_at");

        if status != "active" {
            return Err(bad_request("invite link is no longer valid"));
        }

        if let Some(expiration) = expires_at {
            if expiration < Utc::now() {
                transaction
                    .execute(
                        "update org_invite_links set status = 'expired' where id = $1",
                        &[&link_id],
                    )
                    .await
                    .map_err(|error| {
                        internal_error(format!("failed to expire invite link: {error}"))
                    })?;
                transaction.commit().await.map_err(|error| {
                    internal_error(format!(
                        "failed to finalize invite link expiration: {error}"
                    ))
                })?;
                return Err(bad_request("invite link has expired"));
            }
        }

        if let Some(project_id) = project_id {
            let project_row = transaction
                .query_opt(
                    "select status from projects where id = $1 limit 1",
                    &[&project_id],
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to load project for invite: {error}"))
                })?;
            let Some(project_row) = project_row else {
                return Err(not_found("project not found"));
            };
            let status: String = project_row.get("status");
            if status == "deleted" {
                return Err(bad_request("project is no longer available"));
            }
            let accepted_role = ensure_invited_membership(
                &transaction,
                org_id,
                Some(project_id),
                user_id,
                &role,
                created_by,
            )
            .await?;
            grant_invited_conversation_access(
                &transaction,
                Some(project_id),
                conversation_id,
                user_id,
                created_by,
            )
            .await?;

            let org = load_org_record(&transaction, &org_id).await?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to finalize org invite link accept transaction: {error}"
                ))
            })?;

            publish_project_access_changed(&state.events, Some(project_id), user_id);
            publish_project_members_changed(&state.events, project_id);

            return Ok(Json(OrgInvitationAcceptResponse {
                org_id,
                org_slug: org.slug,
                org_name: org.name,
                role: accepted_role,
                project_id: Some(project_id),
                conversation_id,
            }));
        } else {
            let accepted_role =
                ensure_invited_membership(&transaction, org_id, None, user_id, &role, created_by)
                    .await?;
            grant_invited_conversation_access(
                &transaction,
                None,
                conversation_id,
                user_id,
                created_by,
            )
            .await?;

            let org = load_org_record(&transaction, &org_id).await?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!(
                    "failed to finalize org invite link accept transaction: {error}"
                ))
            })?;

            publish_project_access_changed(&state.events, None, user_id);
            publish_org_members_changed(&*connection, &state.events, &org_id).await;

            return Ok(Json(OrgInvitationAcceptResponse {
                org_id,
                org_slug: org.slug,
                org_name: org.name,
                role: accepted_role,
                project_id: None,
                conversation_id,
            }));
        }
    }

    let invite_row = invite_row.expect("invite_row already checked");

    let invitation_id: Uuid = invite_row.get("id");
    let org_id: Uuid = invite_row.get("org_id");
    let project_id: Option<Uuid> = invite_row.get("project_id");
    let conversation_id: Option<Uuid> = invite_row.get("conversation_id");
    let invited_email: String = invite_row.get("email");
    let role: String = invite_row.get("role");
    let invited_by: Option<Uuid> = invite_row.get("invited_by");
    let status: String = invite_row.get("status");
    let expires_at: Option<DateTime<Utc>> = invite_row.get("expires_at");

    if status != "pending" {
        return Err(bad_request("invitation is no longer valid"));
    }

    if let Some(expiration) = expires_at {
        if expiration < Utc::now() {
            transaction
                .execute(
                    "update org_invitations set status = 'expired' where id = $1",
                    &[&invitation_id],
                )
                .await
                .map_err(|error| internal_error(format!("failed to expire invitation: {error}")))?;
            transaction.commit().await.map_err(|error| {
                internal_error(format!("failed to finalize invitation expiration: {error}"))
            })?;
            return Err(bad_request("invitation has expired"));
        }
    }

    let user_email_row = transaction
        .query_opt("select email from auth.users where id = $1", &[&user_id])
        .await
        .map_err(|error| internal_error(format!("failed to load user email: {error}")))?;
    let Some(user_email_row) = user_email_row else {
        return Err(unauthorized("user not found"));
    };
    let user_email: Option<String> = user_email_row.get("email");
    let user_email = user_email.unwrap_or_default();
    if user_email.is_empty()
        || user_email.to_ascii_lowercase() != invited_email.to_ascii_lowercase()
    {
        return Err(forbidden(
            "You must be signed in with the invited email address to accept this invitation.",
        ));
    }

    let accepted_role = if let Some(project_id) = project_id {
        let project_row = transaction
            .query_opt(
                "select status from projects where id = $1 limit 1",
                &[&project_id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to load project for invitation: {error}"))
            })?;
        let Some(project_row) = project_row else {
            return Err(not_found("project not found"));
        };
        let project_status: String = project_row.get("status");
        if project_status == "deleted" {
            return Err(bad_request("project is no longer available"));
        }
        ensure_invited_membership(
            &transaction,
            org_id,
            Some(project_id),
            user_id,
            &role,
            invited_by,
        )
        .await?
    } else {
        ensure_invited_membership(&transaction, org_id, None, user_id, &role, invited_by).await?
    };

    grant_invited_conversation_access(
        &transaction,
        project_id,
        conversation_id,
        user_id,
        invited_by,
    )
    .await?;

    let updated = transaction
        .execute(
            "update org_invitations
             set status = 'accepted', accepted_at = now(), accepted_by = $1
             where id = $2 and status = 'pending'",
            &[&user_id, &invitation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to accept org invitation: {error}")))?;
    if updated != 1 {
        return Err(bad_request("invitation is no longer valid"));
    }

    let org = load_org_record(&transaction, &org_id).await?;
    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize org invitation accept transaction: {error}"
        ))
    })?;

    publish_project_access_changed(&state.events, project_id, user_id);
    match project_id {
        Some(project_id) => publish_project_members_changed(&state.events, project_id),
        None => publish_org_members_changed(&*connection, &state.events, &org_id).await,
    }

    Ok(Json(OrgInvitationAcceptResponse {
        org_id,
        org_slug: org.slug,
        org_name: org.name,
        role: accepted_role,
        project_id,
        conversation_id,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateOrgBody {
    name: Option<String>,
    avatar_url: Option<String>,
    #[serde(default, deserialize_with = "deserialize_identity_patch")]
    accent_color: Option<Option<String>>,
}

fn validate_org_accent(color: Option<&str>) -> Result<(), (StatusCode, Json<ApiError>)> {
    if color.is_some_and(|value| {
        ![
            "slate", "blue", "violet", "pink", "red", "orange", "green", "teal",
        ]
        .contains(&value)
    }) {
        return Err(bad_request(
            "accentColor must be one of the supported team colors",
        ));
    }
    Ok(())
}

/// Owner/admin-editable org profile: display name, avatar and accent. The avatar is
/// an https image URL (typically a Supabase storage public URL); an empty
/// string clears it.
async fn update_organization(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id_raw): Path<String>,
    Json(body): Json<UpdateOrgBody>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;

    let name = match body.name.as_deref().map(str::trim) {
        Some("") => return Err(bad_request("name must not be empty")),
        Some(value) if value.len() > 120 => {
            return Err(bad_request("name must be 120 characters or fewer"))
        }
        Some(value) => Some(value.to_string()),
        None => None,
    };
    let avatar_url = match body.avatar_url.as_deref().map(str::trim) {
        Some("") => Some(None),
        Some(value) => {
            validate_identity_image_url(value, &state.config._supabase_project_url)?;
            Some(Some(value.to_string()))
        }
        None => None,
    };
    validate_org_accent(
        body.accent_color
            .as_ref()
            .and_then(|color| color.as_deref()),
    )?;
    if name.is_none() && avatar_url.is_none() && body.accent_color.is_none() {
        return Err(bad_request("nothing to update"));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start organization update transaction: {error}"
        ))
    })?;

    let _org = load_org_record(&transaction, &org_id).await?;
    let role = require_org_access(&transaction, &org_id, &context).await?;
    if !context.is_service_role {
        match role.as_deref() {
            Some("owner") | Some("admin") => {}
            _ => {
                return Err(forbidden(
                    "Only organization owners or admins can edit the organization",
                ));
            }
        }
    }

    if let Some(name) = name.as_deref() {
        transaction
            .execute(
                "update organizations set name = $2, updated_at = now() where id = $1",
                &[&org_id, &name],
            )
            .await
            .map_err(|error| internal_error(format!("failed to update organization: {error}")))?;
    }
    if let Some(avatar) = avatar_url {
        transaction
            .execute(
                "update organizations set avatar_url = $2, updated_at = now() where id = $1",
                &[&org_id, &avatar],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to update organization avatar: {error}"))
            })?;
    }

    if let Some(color) = body.accent_color {
        transaction
            .execute(
                "update organizations set accent_color = $2, updated_at = now() where id = $1",
                &[&org_id, &color],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to update organization color: {error}"))
            })?;
    }

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize organization update transaction: {error}"
        ))
    })?;

    Ok(StatusCode::NO_CONTENT)
}

async fn delete_organization(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id_raw): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection.transaction().await.map_err(|error| {
        internal_error(format!(
            "failed to start organization delete transaction: {error}"
        ))
    })?;

    let _org = match load_org_record(&transaction, &org_id).await {
        Ok(org) => org,
        Err((StatusCode::NOT_FOUND, _)) if context.is_service_role => {
            // Recovery may repeat after the first service-role deletion
            // committed but its response was lost. Keep that narrow cleanup
            // operation idempotent without changing normal org visibility.
            return Ok(StatusCode::NO_CONTENT);
        }
        Err(error) => return Err(error),
    };
    let role = require_org_access(&transaction, &org_id, &context).await?;
    if !context.is_service_role {
        match role.as_deref() {
            Some("owner") => {}
            _ => {
                return Err(forbidden(
                    "Only organization owners can delete organizations",
                ));
            }
        }
    }

    // A deleted org must not keep billing: cancel any live Stripe subscription
    // first, and refuse the deletion when that cancellation cannot be
    // confirmed (otherwise the customer is charged forever with no portal
    // access left to stop it).
    let billing_ref = crate::billing::service::load_org_billing_ref(&transaction, &org_id)
        .await
        .map_err(internal_error)?;
    if let Some(subscription) = billing_ref.filter(|subscription| {
        subscription.processor == "stripe"
            && matches!(
                subscription.status.as_str(),
                "active" | "trialing" | "past_due"
            )
    }) {
        if state.config.stripe.is_none() {
            return Err(internal_error(
                "cannot delete organization: it has a live Stripe subscription but Stripe is not configured on this controller",
            ));
        }
        if !subscription.external_id.starts_with("sub_") {
            return Err(internal_error(
                "cannot delete organization: its Stripe subscription reference is not a subscription id; cancel the subscription in the Stripe dashboard first",
            ));
        }
        let processor_context = crate::billing::processors::ProcessorContext {
            config: &state.config,
            http_client: &state.http_client,
        };
        crate::billing::processors::stripe::cancel_subscription(
            &processor_context,
            &subscription.external_id,
        )
        .await
        .map_err(|error| error.into_response())?;
        tracing::info!(
            org_id = %org_id,
            subscription_id = %subscription.external_id,
            "canceled Stripe subscription before organization deletion"
        );
    }

    // Keep encrypted browser identity data tied to the org lifecycle even on
    // installations that have not yet acquired the cascade FK from migration
    // 20260000000048. The migration remains the database-level backstop.
    transaction
        .execute(
            "delete from project_browser_profiles
             where project_id in (select id from projects where org_id = $1)",
            &[&org_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to delete organization browser profiles: {error}"
            ))
        })?;

    transaction
        .execute("delete from organizations where id = $1", &[&org_id])
        .await
        .map_err(|error| internal_error(format!("failed to delete organization: {error}")))?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize organization delete transaction: {error}"
        ))
    })?;

    Ok(StatusCode::NO_CONTENT)
}

fn parse_uuid_param(raw: String, field: &str) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(bad_request(format!("{field} must be a valid UUID")));
    }
    Uuid::from_str(trimmed).map_err(|_| bad_request(format!("{field} must be a valid UUID")))
}

fn slugify_org_name(name: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in name.trim().to_ascii_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    slug.trim_matches('-').to_string()
}

async fn load_org_record(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: &Uuid,
) -> Result<OrgRecord, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select id, slug, name from organizations where id = $1",
            &[org_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load organization: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("organization not found"));
    };

    Ok(OrgRecord {
        id: row.get("id"),
        slug: row.get("slug"),
        name: row.get("name"),
    })
}

fn normalize_org_role(
    role: Option<String>,
    default_role: Option<&str>,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let resolved = role
        .as_deref()
        .unwrap_or(default_role.unwrap_or(""))
        .trim()
        .to_ascii_lowercase();
    if resolved.is_empty() {
        return Err(bad_request("role is required"));
    }
    if !ORG_MEMBER_ROLES.iter().any(|value| value == &resolved) {
        return Err(bad_request(
            "role must be one of owner, admin, builder, viewer",
        ));
    }
    Ok(resolved)
}

fn normalize_project_share_role(
    role: Option<String>,
    default_role: Option<&str>,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let resolved = role
        .as_deref()
        .unwrap_or(default_role.unwrap_or(""))
        .trim()
        .to_ascii_lowercase();
    if resolved.is_empty() {
        return Err(bad_request("role is required"));
    }
    if resolved != "viewer" && resolved != "builder" {
        return Err(bad_request("role must be one of builder, viewer"));
    }
    Ok(resolved)
}

fn actor_can_manage_owner(context: &RequestContext, actor_role: Option<&str>) -> bool {
    if context.is_service_role {
        return true;
    }
    matches!(actor_role, Some("owner"))
}

fn role_can_manage_members(role: &str) -> bool {
    matches!(role, "owner" | "admin")
}

fn role_can_share_projects(role: &str) -> bool {
    matches!(role, "owner" | "admin" | "builder")
}

async fn require_org_access(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: &Uuid,
    context: &RequestContext,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Scoped access tokens cannot authorize organization membership",
        ));
    }
    if context.is_service_role {
        return Ok(None);
    }

    let user_id = context
        .user_id
        .ok_or_else(|| unauthorized("authentication required to access organizations"))?;

    let row = transaction
        .query_opt(
            "select role from org_memberships where org_id = $1 and user_id = $2",
            &[org_id, &user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to verify org access: {error}")))?;

    let Some(row) = row else {
        return Err(forbidden("You do not have access to this organization"));
    };

    let role: String = row.get("role");
    Ok(Some(role))
}

async fn require_org_project_sharer(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: &Uuid,
    context: &RequestContext,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    if context.is_service_role {
        return Ok(None);
    }

    let role = require_org_access(transaction, org_id, context).await?;
    if let Some(ref value) = role {
        if !role_can_share_projects(value) {
            return Err(forbidden(
                "You need to be an org owner, admin, or builder to share projects.",
            ));
        }
    }
    Ok(role)
}

async fn validate_invite_conversation(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let Some(conversation_id) = conversation_id else {
        return Ok(());
    };
    let Some(project_id) = project_id else {
        return Err(bad_request("conversationId requires projectId"));
    };

    let conversation = load_conversation_record(transaction, &conversation_id).await?;
    if conversation.project_id != project_id {
        return Err(bad_request(
            "conversationId does not belong to the invited project",
        ));
    }
    if conversation.visibility != "private" {
        return Err(bad_request(
            "conversation-scoped invitations are only supported for private conversations",
        ));
    }
    ensure_conversation_access(transaction, &conversation, context).await
}

async fn ensure_invited_membership(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: Uuid,
    project_id: Option<Uuid>,
    user_id: Uuid,
    invited_role: &str,
    invited_by: Option<Uuid>,
) -> Result<String, (StatusCode, Json<ApiError>)> {
    let invited_access = ProjectRole::from_membership_role(invited_role)
        .ok_or_else(|| bad_request("invitation role is invalid"))?;
    if let Some(existing_role) =
        load_existing_invited_access_role(transaction, org_id, project_id, user_id).await?
    {
        let existing_access = ProjectRole::from_membership_role(&existing_role)
            .ok_or_else(|| internal_error("existing membership role is invalid"))?;
        if existing_access >= invited_access {
            return Ok(existing_role);
        }
    }

    if let Some(project_id) = project_id {
        transaction
            .execute(
                "insert into project_memberships (project_id, user_id, role, invited_by)
                 values ($1, $2, $3, $4)
                 on conflict (project_id, user_id) do update
                 set role = excluded.role
                 where case project_memberships.role
                           when 'owner' then 4
                           when 'admin' then 3
                           when 'builder' then 2
                           when 'viewer' then 1
                           else 0
                       end
                     < case excluded.role
                           when 'owner' then 4
                           when 'admin' then 3
                           when 'builder' then 2
                           when 'viewer' then 1
                           else 0
                       end",
                &[&project_id, &user_id, &invited_role, &invited_by],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to add invited project membership: {error}"))
            })?;
    } else {
        transaction
            .execute(
                "insert into org_memberships (org_id, user_id, role, invited_by)
                 values ($1, $2, $3, $4)
                 on conflict (org_id, user_id) do update
                 set role = excluded.role
                 where case org_memberships.role
                           when 'owner' then 4
                           when 'admin' then 3
                           when 'builder' then 2
                           when 'viewer' then 1
                           else 0
                       end
                     < case excluded.role
                           when 'owner' then 4
                           when 'admin' then 3
                           when 'builder' then 2
                           when 'viewer' then 1
                           else 0
                       end",
                &[&org_id, &user_id, &invited_role, &invited_by],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to add invited organization membership: {error}"
                ))
            })?;
    }

    load_existing_invited_access_role(transaction, org_id, project_id, user_id)
        .await?
        .ok_or_else(|| internal_error("failed to load membership after accepting invitation"))
}

async fn load_existing_invited_access_role(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: Uuid,
    project_id: Option<Uuid>,
    user_id: Uuid,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let row = if let Some(project_id) = project_id {
        transaction
            .query_opt(
                "select access_grant.role
                 from (
                     select 'owner'::text as role, 4 as role_rank
                     from projects p
                     where p.id = $1 and p.org_id = $2 and p.owner_user_id = $3
                     union all
                     select pm.role,
                            case pm.role
                                when 'owner' then 4
                                when 'admin' then 3
                                when 'builder' then 2
                                when 'viewer' then 1
                                else 0
                            end as role_rank
                     from project_memberships pm
                     where pm.project_id = $1 and pm.user_id = $3
                     union all
                     select om.role,
                            case om.role
                                when 'owner' then 4
                                when 'admin' then 3
                                when 'builder' then 2
                                when 'viewer' then 1
                                else 0
                            end as role_rank
                     from org_memberships om
                     where om.org_id = $2 and om.user_id = $3
                 ) access_grant
                 where access_grant.role_rank > 0
                 order by access_grant.role_rank desc
                 limit 1",
                &[&project_id, &org_id, &user_id],
            )
            .await
    } else {
        transaction
            .query_opt(
                "select role
                 from org_memberships
                 where org_id = $1 and user_id = $2
                   and role in ('owner', 'admin', 'builder', 'viewer')
                 limit 1",
                &[&org_id, &user_id],
            )
            .await
    }
    .map_err(|error| internal_error(format!("failed to load existing invite access: {error}")))?;

    Ok(row.map(|row| row.get::<_, String>("role")))
}

async fn grant_invited_conversation_access(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    user_id: Uuid,
    added_by: Option<Uuid>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let Some(conversation_id) = conversation_id else {
        return Ok(());
    };
    let Some(project_id) = project_id else {
        return Err(bad_request(
            "conversation-scoped invitation is missing its project",
        ));
    };

    let conversation = transaction
        .query_opt(
            "select visibility
             from conversations
             where id = $1 and project_id = $2
             limit 1",
            &[&conversation_id, &project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to validate invited conversation: {error}"))
        })?;
    let Some(conversation) = conversation else {
        return Err(bad_request(
            "the conversation attached to this invitation is no longer available",
        ));
    };
    if conversation.get::<_, String>("visibility") != "private" {
        return Err(bad_request(
            "the conversation attached to this invitation is no longer private",
        ));
    }

    transaction
        .execute(
            "insert into conversation_participants (conversation_id, user_id, role, added_by)
             values ($1, $2, 'member', $3)
             on conflict (conversation_id, user_id) do nothing",
            &[&conversation_id, &user_id, &added_by],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to add invited conversation participant: {error}"
            ))
        })?;

    Ok(())
}

async fn require_project_sharer(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &ProjectRecord,
    context: &RequestContext,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Scoped access tokens cannot manage project sharing",
        ));
    }
    if context.is_service_role {
        return Ok(());
    }

    let user_id = context
        .user_id
        .ok_or_else(|| unauthorized("authentication required to manage project access"))?;

    if let Some(owner_id) = project.owner_user_id {
        if owner_id == user_id {
            return Ok(());
        }
    }

    let Some(org_id) = project.org_id else {
        return Err(forbidden(
            "Project sharing is only available for organization workspaces.",
        ));
    };

    require_org_project_sharer(transaction, &org_id, context).await?;

    Ok(())
}

async fn load_org_project_for_sharing(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: &Uuid,
    project_id: &Uuid,
    context: &RequestContext,
) -> Result<ProjectRecord, (StatusCode, Json<ApiError>)> {
    let project = load_project_record(transaction, project_id).await?;
    if project.org_id != Some(*org_id) {
        return Err(bad_request(
            "projectId does not belong to this organization",
        ));
    }
    if project
        ._status
        .as_deref()
        .is_some_and(|status| status.eq_ignore_ascii_case("deleted"))
    {
        return Err(not_found("project not found"));
    }
    require_project_sharer(transaction, &project, context).await?;
    Ok(project)
}

async fn require_org_manager(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: &Uuid,
    context: &RequestContext,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    if context.is_service_role {
        return Ok(None);
    }

    let role = require_org_access(transaction, org_id, context).await?;
    if let Some(ref value) = role {
        if !role_can_manage_members(value) {
            return Err(forbidden(
                "You need to be an org owner or admin to manage members.",
            ));
        }
    }
    Ok(role)
}

async fn lock_org_membership_management(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    // Authorization, the last-owner check, and the mutation must observe one
    // serialized org membership state. In particular, two owners must not be
    // able to concurrently demote/remove themselves after both see the other.
    let lock_key = format!("org-membership-management:{org_id}");
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&lock_key],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to lock organization membership management: {error}"
            ))
        })?;
    Ok(())
}

async fn load_org_member_role(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: &Uuid,
    user_id: &Uuid,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select role from org_memberships where org_id = $1 and user_id = $2",
            &[org_id, user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load org membership: {error}")))?;
    Ok(row.map(|row| row.get::<_, String>("role")))
}

async fn ensure_owner_remaining(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: &Uuid,
    user_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_one(
            "select count(*)::int as count from org_memberships where org_id = $1 and role = 'owner' and user_id <> $2",
            &[org_id, user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load owner count: {error}")))?;

    let count: i32 = row.get("count");
    if count <= 0 {
        return Err(bad_request("organization must have at least one owner"));
    }
    Ok(())
}

async fn resolve_member_user_id(
    transaction: &tokio_postgres::Transaction<'_>,
    user_id_raw: Option<String>,
    email_raw: Option<String>,
) -> Result<(Uuid, Option<String>), (StatusCode, Json<ApiError>)> {
    if let Some(value) = user_id_raw {
        let user_id = parse_uuid_param(value, "userId")?;
        return Ok((user_id, None));
    }

    let email = email_raw
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| bad_request("email or userId is required"))?;

    let row = transaction
        .query_opt(
            "select id, email from auth.users where lower(email) = lower($1) limit 1",
            &[&email],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lookup user by email: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("user not found for provided email"));
    };

    let user_id: Uuid = row.get("id");
    let resolved_email: Option<String> = row.get("email");
    Ok((user_id, resolved_email))
}

async fn load_org_members(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: &Uuid,
    params: OrgMembersQuery,
) -> Result<OrgMembersResponse, (StatusCode, Json<ApiError>)> {
    let limit = params.limit.unwrap_or(50).clamp(1, 200);
    let fetch_limit = limit + 1;

    let search_pattern = params
        .q
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("%{value}%"));

    let total = if params.cursor.is_some() {
        None
    } else if let Some(pattern) = search_pattern.as_ref() {
        let row = transaction
            .query_one(
                "select count(*)::bigint as count
                 from org_memberships m
                 join auth.users u on u.id = m.user_id
                 left join profiles p on p.user_id = m.user_id
                 where m.org_id = $1
                   and (u.email ilike $2
                        or coalesce(
                             nullif(btrim(p.full_name), ''),
                             nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                             nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                             nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '')
                           ) ilike $2
                        or m.user_id::text ilike $2)",
                &[org_id, pattern],
            )
            .await
            .map_err(|error| internal_error(format!("failed to count org members: {error}")))?;
        let count: i64 = row.get("count");
        Some(count)
    } else {
        let row = transaction
            .query_one(
                "select count(*)::bigint as count from org_memberships where org_id = $1",
                &[org_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to count org members: {error}")))?;
        let count: i64 = row.get("count");
        Some(count)
    };

    let rows = if let Some(cursor_raw) = params.cursor.as_ref() {
        let cursor_id = Uuid::from_str(cursor_raw.trim())
            .map_err(|_| bad_request("cursor must be a valid UUID"))?;
        let cursor_row = transaction
            .query_opt(
                "select created_at from org_memberships where org_id = $1 and user_id = $2",
                &[org_id, &cursor_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to resolve cursor: {error}")))?;
        let Some(row) = cursor_row else {
            return Err(not_found("cursor member not found"));
        };
        let cursor_created_at: DateTime<Utc> = row.get("created_at");

        if let Some(pattern) = search_pattern.as_ref() {
            let query = "select m.user_id, m.role, m.invited_by, m.created_at, u.email,
                                coalesce(
                                  nullif(btrim(p.full_name), ''),
                                  nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                                  nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                                  nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '')
                                ) as full_name
                         from org_memberships m
                         join auth.users u on u.id = m.user_id
                         left join profiles p on p.user_id = m.user_id
                         where m.org_id = $1
                           and (u.email ilike $2
                                or coalesce(
                                     nullif(btrim(p.full_name), ''),
                                     nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                                     nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                                     nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '')
                                   ) ilike $2
                                or m.user_id::text ilike $2)
                           and (m.created_at > $3 or (m.created_at = $3 and m.user_id > $4))
                         order by m.created_at asc, m.user_id asc
                         limit $5";
            transaction
                .query(
                    query,
                    &[
                        org_id,
                        pattern,
                        &cursor_created_at,
                        &cursor_id,
                        &fetch_limit,
                    ],
                )
                .await
                .map_err(|error| internal_error(format!("failed to load org members: {error}")))
        } else {
            let query = "select m.user_id, m.role, m.invited_by, m.created_at, u.email,
                                coalesce(
                                  nullif(btrim(p.full_name), ''),
                                  nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                                  nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                                  nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '')
                                ) as full_name
                         from org_memberships m
                         join auth.users u on u.id = m.user_id
                         left join profiles p on p.user_id = m.user_id
                         where m.org_id = $1
                           and (m.created_at > $2 or (m.created_at = $2 and m.user_id > $3))
                         order by m.created_at asc, m.user_id asc
                         limit $4";
            transaction
                .query(
                    query,
                    &[org_id, &cursor_created_at, &cursor_id, &fetch_limit],
                )
                .await
                .map_err(|error| internal_error(format!("failed to load org members: {error}")))
        }?
    } else if let Some(pattern) = search_pattern.as_ref() {
        let query = "select m.user_id, m.role, m.invited_by, m.created_at, u.email,
                            coalesce(
                              nullif(btrim(p.full_name), ''),
                              nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                              nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                              nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '')
                            ) as full_name
                     from org_memberships m
                     join auth.users u on u.id = m.user_id
                     left join profiles p on p.user_id = m.user_id
                     where m.org_id = $1
                       and (u.email ilike $2
                            or coalesce(
                                 nullif(btrim(p.full_name), ''),
                                 nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                                 nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                                 nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '')
                               ) ilike $2
                            or m.user_id::text ilike $2)
                     order by m.created_at asc, m.user_id asc
                     limit $3";
        transaction
            .query(query, &[org_id, pattern, &fetch_limit])
            .await
            .map_err(|error| internal_error(format!("failed to load org members: {error}")))?
    } else {
        let query = "select m.user_id, m.role, m.invited_by, m.created_at, u.email,
                            coalesce(
                              nullif(btrim(p.full_name), ''),
                              nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                              nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                              nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '')
                            ) as full_name
                     from org_memberships m
                     join auth.users u on u.id = m.user_id
                     left join profiles p on p.user_id = m.user_id
                     where m.org_id = $1
                     order by m.created_at asc, m.user_id asc
                     limit $2";
        transaction
            .query(query, &[org_id, &fetch_limit])
            .await
            .map_err(|error| internal_error(format!("failed to load org members: {error}")))?
    };

    let has_more = rows.len() as i64 > limit;
    let mut members = rows
        .into_iter()
        .map(|row| OrgMemberSummary {
            user_id: row.get("user_id"),
            email: row.get::<_, Option<String>>("email"),
            full_name: row.get::<_, Option<String>>("full_name"),
            role: row.get::<_, String>("role"),
            invited_by: row.get::<_, Option<Uuid>>("invited_by"),
            created_at: row.get::<_, DateTime<Utc>>("created_at").to_rfc3339(),
        })
        .collect::<Vec<_>>();

    if has_more {
        members.truncate(limit as usize);
    }

    let next_cursor = if has_more {
        members.last().map(|member| member.user_id.to_string())
    } else {
        None
    };

    Ok(OrgMembersResponse {
        members,
        next_cursor,
        has_more,
        total,
    })
}

async fn load_org_member(
    transaction: &tokio_postgres::Transaction<'_>,
    org_id: &Uuid,
    user_id: &Uuid,
    email_override: Option<String>,
) -> Result<OrgMemberSummary, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select m.user_id, m.role, m.invited_by, m.created_at, u.email,
                    coalesce(
                      nullif(btrim(p.full_name), ''),
                      nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                      nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                      nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '')
                    ) as full_name
             from org_memberships m
             join auth.users u on u.id = m.user_id
             left join profiles p on p.user_id = m.user_id
             where m.org_id = $1 and m.user_id = $2",
            &[org_id, user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load org member: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("org member not found"));
    };

    Ok(OrgMemberSummary {
        user_id: row.get("user_id"),
        email: email_override.or_else(|| row.get::<_, Option<String>>("email")),
        full_name: row.get::<_, Option<String>>("full_name"),
        role: row.get::<_, String>("role"),
        invited_by: row.get::<_, Option<Uuid>>("invited_by"),
        created_at: row.get::<_, DateTime<Utc>>("created_at").to_rfc3339(),
    })
}

async fn load_project_memberships(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
) -> Result<Vec<ProjectMemberSummary>, (StatusCode, Json<ApiError>)> {
    let rows = transaction
        .query(
            "select pm.user_id, pm.role, pm.invited_by, pm.created_at, u.email,
                    coalesce(
                      nullif(btrim(p.full_name), ''),
                      nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                      nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                      nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '')
                    ) as full_name
             from project_memberships pm
             join auth.users u on u.id = pm.user_id
             left join profiles p on p.user_id = pm.user_id
             where pm.project_id = $1
             order by pm.created_at asc",
            &[project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load project members: {error}")))?;

    let members = rows
        .into_iter()
        .map(|row| ProjectMemberSummary {
            user_id: row.get("user_id"),
            email: row.get::<_, Option<String>>("email"),
            full_name: row.get::<_, Option<String>>("full_name"),
            role: row.get::<_, String>("role"),
            invited_by: row.get::<_, Option<Uuid>>("invited_by"),
            created_at: row.get::<_, DateTime<Utc>>("created_at").to_rfc3339(),
        })
        .collect();

    Ok(members)
}

async fn load_project_member(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    user_id: &Uuid,
) -> Result<ProjectMemberSummary, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select pm.user_id, pm.role, pm.invited_by, pm.created_at, u.email,
                    coalesce(
                      nullif(btrim(p.full_name), ''),
                      nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                      nullif(btrim(u.raw_user_meta_data ->> 'name'), ''),
                      nullif(btrim(u.raw_user_meta_data ->> 'display_name'), '')
                    ) as full_name
             from project_memberships pm
             join auth.users u on u.id = pm.user_id
             left join profiles p on p.user_id = pm.user_id
             where pm.project_id = $1 and pm.user_id = $2
             limit 1",
            &[project_id, user_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load project member: {error}")))?;

    let Some(row) = row else {
        return Err(not_found("project member not found"));
    };

    Ok(ProjectMemberSummary {
        user_id: row.get("user_id"),
        email: row.get::<_, Option<String>>("email"),
        full_name: row.get::<_, Option<String>>("full_name"),
        role: row.get::<_, String>("role"),
        invited_by: row.get::<_, Option<Uuid>>("invited_by"),
        created_at: row.get::<_, DateTime<Utc>>("created_at").to_rfc3339(),
    })
}

fn map_org_invitation_row(row: tokio_postgres::Row) -> OrgInvitationSummary {
    OrgInvitationSummary {
        id: row.get("id"),
        org_id: row.get("org_id"),
        project_id: row.get("project_id"),
        conversation_id: row.get("conversation_id"),
        email: row.get("email"),
        role: row.get("role"),
        invited_by: row.get("invited_by"),
        status: row.get("status"),
        created_at: row.get::<_, DateTime<Utc>>("created_at").to_rfc3339(),
        expires_at: row
            .get::<_, Option<DateTime<Utc>>>("expires_at")
            .map(|value| value.to_rfc3339()),
    }
}

pub(crate) async fn ensure_project_org(
    transaction: &tokio_postgres::Transaction<'_>,
    project: &ProjectRecord,
) -> Result<ProjectRecord, (StatusCode, Json<ApiError>)> {
    if let Some(org_id) = project.org_id {
        if let Err(error) =
            crate::billing::service::ensure_default_org_subscription(transaction, &org_id).await
        {
            tracing::warn!(
                org_id = %org_id,
                error = %error,
                "ensure_default_org_subscription failed",
            );
        }
        return Ok(project.clone());
    }

    let slug = format!("project-{}", project.id);
    let name = project
        .project_type
        .as_deref()
        .filter(|value| value.eq_ignore_ascii_case("sandbox"))
        .map(|_| "Sandbox Workspace".to_string())
        .unwrap_or_else(|| format!("Workspace {}", project.id.to_string()[..8].to_string()));

    let row = transaction
        .query_one(
            "insert into organizations (slug, name)
             values ($1, $2)
             on conflict (slug) do update set name = excluded.name
             returning id",
            &[&slug, &name],
        )
        .await
        .map_err(|error| internal_error(format!("failed to create organization: {error}")))?;

    let org_id: Uuid = row.get("id");

    transaction
        .execute(
            "update projects set org_id = $2, updated_at = now() where id = $1",
            &[&project.id, &org_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to link project to organization: {}",
                describe_db_error(&error)
            ))
        })?;

    if let Some(owner) = project.owner_user_id {
        transaction
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner')
                 on conflict (org_id, user_id) do nothing",
                &[&org_id, &owner],
            )
            .await
            .map_err(|error| {
                internal_error(format!(
                    "failed to upsert org membership: {}",
                    describe_db_error(&error)
                ))
            })?;
    }

    if let Err(error) =
        crate::billing::service::ensure_default_org_subscription(transaction, &org_id).await
    {
        tracing::warn!(
            org_id = %org_id,
            error = %error,
            "ensure_default_org_subscription failed",
        );
    }

    let mut updated = project.clone();
    updated.org_id = Some(org_id);
    Ok(updated)
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

fn project_access_from_list_row(
    row: &tokio_postgres::Row,
    context: &RequestContext,
) -> Result<ProjectAccess, (StatusCode, Json<ApiError>)> {
    if context.is_service_role {
        return Ok(ProjectAccess::owner());
    }
    if context.scoped_claims.is_some() {
        return Err(forbidden(
            "Scoped access tokens cannot list project membership",
        ));
    }

    let user_id = context
        .user_id
        .ok_or_else(|| unauthorized("authentication required to list projects"))?;
    if row.get::<_, Option<Uuid>>("owner_user_id") == Some(user_id) {
        return Ok(ProjectAccess::owner());
    }

    let project_id: Uuid = row.get("id");
    let mut effective_access: Option<ProjectAccess> = None;
    for (column, organization_grant) in [("project_member_role", false), ("org_member_role", true)]
    {
        let Some(role) = row.get::<_, Option<String>>(column) else {
            continue;
        };
        let Some(role) = ProjectRole::from_membership_role(&role) else {
            tracing::warn!(
                project_id = %project_id,
                request_user_id = %user_id,
                membership_role = %role,
                membership_source = column,
                "ignoring invalid project-list membership role"
            );
            continue;
        };
        let access = ProjectAccess::from_membership(role, organization_grant);
        effective_access = Some(match effective_access {
            Some(existing) => existing.merge(access),
            None => access,
        });
    }

    effective_access.ok_or_else(|| forbidden("You do not have access to this project"))
}

fn map_project_summary(row: tokio_postgres::Row) -> ProjectSummary {
    ProjectSummary {
        project_id: row.get("id"),
        org_id: row.get("org_id"),
        org_slug: row.get("org_slug"),
        org_name: row.get("org_name"),
        project_name: row.get("name"),
        project_icon: row.get("icon"),
        project_color: row.get("color"),
        project_avatar_url: row.get("avatar_url"),
        owner_user_id: row.get("owner_user_id"),
        project_type: row.get("project_type"),
        status: row.get("status"),
        effective_role: None,
        can_write: None,
        can_share: None,
        can_manage: None,
        last_activity_at: row
            .try_get::<_, Option<DateTime<Utc>>>("last_activity_at")
            .ok()
            .flatten()
            .map(|value| value.to_rfc3339()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateOrgProjectBody {
    #[serde(default, rename = "projectType", alias = "project_type")]
    project_type: Option<String>,
    #[serde(default, rename = "projectName", alias = "project_name")]
    project_name: Option<String>,
    #[serde(default, rename = "sandboxSessionId", alias = "sandbox_session_id")]
    sandbox_session_id: Option<String>,
    #[serde(default, rename = "ownerUserId", alias = "owner_user_id")]
    owner_user_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectResponse {
    project_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    project_name: Option<String>,
    org_id: Option<Uuid>,
    org_name: Option<String>,
}

#[tracing::instrument(skip(state, headers))]
async fn bootstrap_project_memory(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(project_id_raw): Path<String>,
) -> Result<Json<BootstrapProjectMemoryResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let project_id = parse_uuid_param(project_id_raw, "project_id")?;

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let project = load_project_record(&transaction, &project_id).await?;
    ensure_project_write_access(&transaction, &project, &context, None).await?;

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize authorization: {error}")))?;

    let actor_user_id = context.user_id.or(project.owner_user_id);
    let (ok, outcome) =
        match bootstrap_project_memory_scaffold(&state, &project_id, actor_user_id).await {
            Ok(outcome) => (true, outcome),
            Err((_status, Json(api_error))) => {
                tracing::warn!(
                    project_id = %project_id,
                    error = %api_error.message,
                    "project memory bootstrap failed"
                );
                (
                    false,
                    BootstrapProjectMemoryOutcome {
                        seeded: false,
                        file_count: 0,
                        rev: None,
                        reason: Some(api_error.message),
                    },
                )
            }
        };

    Ok(Json(BootstrapProjectMemoryResponse {
        ok,
        seeded: outcome.seeded,
        file_count: outcome.file_count,
        rev: outcome.rev,
        reason: outcome.reason,
    }))
}

async fn bootstrap_project_memory_scaffold(
    state: &AppState,
    project_id: &Uuid,
    actor_user_id: Option<Uuid>,
) -> Result<BootstrapProjectMemoryOutcome, (StatusCode, Json<ApiError>)> {
    let actor_user_id = actor_user_id.or(state.config.service_runtime_user_id);
    let Some(origin_subject) = actor_user_id else {
        return Ok(BootstrapProjectMemoryOutcome {
            reason: Some("no-origin-subject".to_string()),
            ..BootstrapProjectMemoryOutcome::default()
        });
    };
    let resolved = resolve_accessible_origin_for_protocol_with_hosted_fallback(
        state,
        project_id,
        "http",
        origin_subject,
        state.config.service_runtime_user_id == Some(origin_subject),
    )
    .await?;
    let Some(resolved) = resolved else {
        return Ok(BootstrapProjectMemoryOutcome {
            reason: Some("no-origin".to_string()),
            ..BootstrapProjectMemoryOutcome::default()
        });
    };

    let origin = resolved.origin;
    let endpoint = origin.endpoint.trim_end_matches('/').to_string();
    let token_subject = origin_subject.to_string();

    let read_token = mint_scoped_token(
        &state.config,
        ScopedTokenRequest {
            audience: origin.id.to_string(),
            subject: token_subject.clone(),
            project_id: project_id.to_string(),
            origin_id: Some(origin.id.to_string()),
            runtime_id: None,
            protocol: Some("http".to_string()),
            scopes: vec!["fs.read".to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(180),
        },
    )?;

    let existing_managed_state =
        read_project_memory_managed_defaults_state(state, &endpoint, &read_token.token).await?;
    let existing_state_file_content = origin_read_text_file(
        state,
        &endpoint,
        &read_token.token,
        PROJECT_MEMORY_MANAGED_DEFAULTS_STATE_PATH,
    )
    .await?;

    let mut next_state_files: BTreeMap<String, ProjectMemoryManagedDefaultsFileState> =
        BTreeMap::new();
    let mut files_to_write: Vec<ProjectMemoryWriteFile> = Vec::new();

    for template in PROJECT_MEMORY_TEMPLATE_FILES {
        let path = template.path.to_string();
        let template_content = load_project_memory_template_content(&template);
        let template_hash = sha256_hex(&template_content);
        let existing_file_content =
            origin_read_text_file(state, &endpoint, &read_token.token, &path).await?;
        let tracked_hash = existing_managed_state
            .as_ref()
            .and_then(|managed| managed.files.get(&path))
            .map(|entry| entry.applied_sha256.as_str());

        match existing_file_content {
            None => {
                files_to_write.push(ProjectMemoryWriteFile {
                    path: path.clone(),
                    content: template_content.clone(),
                });
                next_state_files.insert(
                    path,
                    ProjectMemoryManagedDefaultsFileState {
                        applied_sha256: template_hash,
                    },
                );
            }
            Some(current_content) => {
                let current_hash = sha256_hex(&current_content);
                let should_update = matches!(tracked_hash, Some(recorded_hash) if recorded_hash == current_hash && recorded_hash != template_hash);

                if should_update {
                    files_to_write.push(ProjectMemoryWriteFile {
                        path: path.clone(),
                        content: template_content.clone(),
                    });
                    next_state_files.insert(
                        path,
                        ProjectMemoryManagedDefaultsFileState {
                            applied_sha256: template_hash,
                        },
                    );
                } else {
                    // Keep existing file content (including user edits) and update managed
                    // baseline so future template changes only auto-apply when unchanged.
                    next_state_files.insert(
                        path,
                        ProjectMemoryManagedDefaultsFileState {
                            applied_sha256: current_hash,
                        },
                    );
                }
            }
        }
    }

    let next_managed_state = ProjectMemoryManagedDefaultsState {
        version: 1,
        files: next_state_files,
    };
    let next_state_content =
        serde_json::to_string_pretty(&next_managed_state).map_err(|error| {
            internal_error(format!(
                "failed to serialize managed defaults state: {error}"
            ))
        })?;
    let next_state_content = format!("{next_state_content}\n");
    let should_write_state = existing_state_file_content
        .as_deref()
        .map(|current| current != next_state_content)
        .unwrap_or(true);
    if should_write_state {
        files_to_write.push(ProjectMemoryWriteFile {
            path: PROJECT_MEMORY_MANAGED_DEFAULTS_STATE_PATH.to_string(),
            content: next_state_content,
        });
    }

    if files_to_write.is_empty() {
        return Ok(BootstrapProjectMemoryOutcome {
            reason: Some("already-present".to_string()),
            ..BootstrapProjectMemoryOutcome::default()
        });
    }

    // Project-memory seeding is a one-shot mutation with its own unconditional
    // release below. A fresh lease neither renews a same-user editor/agent
    // lease nor allows a later ordinary acquisition to adopt this lease, so
    // neither operation can release the other's active write lease.
    let lease_id = match acquire_fresh_lease(
        &state.pool,
        project_id,
        actor_user_id.as_ref(),
        None,
        180,
        Some(&json!({ "source": "project_memory_bootstrap" })),
    )
    .await
    .map_err(|error| internal_error(format!("failed to acquire lease: {error}")))?
    {
        LeaseAcquireOutcome::Granted(lease) => lease.id,
        LeaseAcquireOutcome::Renewed(lease) => lease.id,
        LeaseAcquireOutcome::Conflict { holder: _ } => {
            return Ok(BootstrapProjectMemoryOutcome {
                reason: Some("workspace-busy".to_string()),
                ..BootstrapProjectMemoryOutcome::default()
            });
        }
    };

    // Axum drops a handler future when the client navigates away or otherwise
    // cancels its request. Once this one-shot mutation owns a workspace lease,
    // keep the apply + release sequence in a detached task so request
    // cancellation cannot strand that lease until its 180-second expiry.
    let task_state = state.clone();
    let task_project_id = *project_id;
    let task_origin_id = origin.id;
    let apply_task = tokio::spawn(async move {
        let apply_result: Result<BootstrapProjectMemoryOutcome, (StatusCode, Json<ApiError>)> =
            async {
                let write_token = mint_scoped_token(
                    &task_state.config,
                    ScopedTokenRequest {
                        audience: task_origin_id.to_string(),
                        subject: token_subject,
                        project_id: task_project_id.to_string(),
                        origin_id: Some(task_origin_id.to_string()),
                        runtime_id: None,
                        protocol: Some("http".to_string()),
                        scopes: vec!["fs.write".to_string()],
                        lease_id: Some(lease_id.to_string()),
                        run_id: None,
                        prefer_runtime: None,
                        ttl_seconds: Some(300),
                    },
                )?;

                let (archive, manifest_files) = build_project_memory_archive(&files_to_write)
                    .map_err(|error| {
                        internal_error(format!("failed to build bootstrap archive: {error}"))
                    })?;

                let manifest = json!({
                    "projectId": task_project_id.to_string(),
                    "leaseId": lease_id.to_string(),
                    "generatedAt": Utc::now().to_rfc3339(),
                    "files": manifest_files,
                    "deletes": [],
                    // Ensure managed defaults never leave git-canonical workspaces dirty when we
                    // introduce new template files (for example new default skills).
                    "autoCommitAfterApply": true,
                    "commitMessage": "instafy: bootstrap project memory",
                });

                let manifest_json = serde_json::to_vec(&manifest).map_err(|error| {
                    internal_error(format!("failed to serialize bootstrap manifest: {error}"))
                })?;

                let apply_url = format!("{endpoint}/apply");
                let form = Form::new()
                    .part(
                        "manifest",
                        Part::bytes(manifest_json)
                            .file_name("manifest.json")
                            .mime_str("application/json")
                            .map_err(|error| {
                                internal_error(format!("failed to build manifest part: {error}"))
                            })?,
                    )
                    .part(
                        "archive",
                        Part::bytes(archive)
                            .file_name("workspace.zip")
                            .mime_str("application/zip")
                            .map_err(|error| {
                                internal_error(format!("failed to build archive part: {error}"))
                            })?,
                    );

                let response = timeout(
                    StdDuration::from_secs(ORIGIN_APPLY_TIMEOUT_SECS),
                    task_state
                        .http_client
                        .post(apply_url)
                        .bearer_auth(write_token.token)
                        .multipart(form)
                        .send(),
                )
                .await
                .map_err(|_| internal_error("origin apply request timed out"))?
                .map_err(|error| internal_error(format!("origin apply request failed: {error}")))?;

                let status = response.status();
                if !status.is_success() {
                    let body = response.text().await.unwrap_or_default();
                    return Err(internal_error(format!(
                        "origin apply failed ({}): {}",
                        status.as_u16(),
                        body
                    )));
                }

                let payload = response
                    .json::<serde_json::Value>()
                    .await
                    .map_err(|error| {
                        internal_error(format!("origin apply response invalid: {error}"))
                    })?;
                let rev = payload
                    .get("rev")
                    .and_then(|value| value.as_str())
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty());

                Ok(BootstrapProjectMemoryOutcome {
                    seeded: true,
                    file_count: files_to_write.len(),
                    rev,
                    reason: None,
                })
            }
            .await;

        if let Err(error) = release_lease(
            &task_state.pool,
            &lease_id,
            &task_project_id,
            actor_user_id.as_ref(),
            None,
            "released",
        )
        .await
        {
            tracing::warn!(
                project_id = %task_project_id,
                lease_id = %lease_id,
                error = %error,
                "failed to release project memory bootstrap lease"
            );
        }

        apply_result
    });

    apply_task.await.map_err(|error| {
        internal_error(format!(
            "project memory bootstrap apply task failed: {error}"
        ))
    })?
}

async fn read_project_memory_managed_defaults_state(
    state: &AppState,
    endpoint: &str,
    token: &str,
) -> Result<Option<ProjectMemoryManagedDefaultsState>, (StatusCode, Json<ApiError>)> {
    let Some(raw) = origin_read_text_file(
        state,
        endpoint,
        token,
        PROJECT_MEMORY_MANAGED_DEFAULTS_STATE_PATH,
    )
    .await?
    else {
        return Ok(None);
    };

    let parsed = serde_json::from_str::<ProjectMemoryManagedDefaultsState>(&raw);
    match parsed {
        Ok(mut state) => {
            if state.version == 0 {
                state.version = 1;
            }
            Ok(Some(state))
        }
        Err(error) => {
            tracing::warn!(
                error = %error,
                "failed to parse managed defaults state; re-initializing"
            );
            Ok(None)
        }
    }
}

async fn origin_read_text_file(
    state: &AppState,
    endpoint: &str,
    token: &str,
    path: &str,
) -> Result<Option<String>, (StatusCode, Json<ApiError>)> {
    let encoded = encode_workspace_path(path);
    let url = format!("{endpoint}/files/{encoded}?encoding=base64");
    let response = timeout(
        StdDuration::from_secs(20),
        state.http_client.get(url).bearer_auth(token).send(),
    )
    .await
    .map_err(|_| internal_error("origin file lookup timed out"))?
    .map_err(|error| internal_error(format!("origin file lookup failed: {error}")))?;
    let status = response.status();

    if status.as_u16() == 404 {
        return Ok(None);
    }

    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(internal_error(format!(
            "origin file lookup failed ({}): {}",
            status.as_u16(),
            text
        )));
    }

    let payload = response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| internal_error(format!("origin file response invalid: {error}")))?;
    let encoded_content = payload
        .get("contentBase64")
        .or_else(|| payload.get("content_base64"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| internal_error("origin file response missing contentBase64"))?;
    let bytes = BASE64_STANDARD.decode(encoded_content).map_err(|error| {
        internal_error(format!(
            "origin file response base64 decode failed: {error}"
        ))
    })?;
    let text = String::from_utf8(bytes)
        .map_err(|error| internal_error(format!("origin file response was not UTF-8: {error}")))?;
    Ok(Some(text))
}

fn encode_workspace_path(path: &str) -> String {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| urlencoding::encode(segment).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn build_project_memory_archive(
    files: &[ProjectMemoryWriteFile],
) -> Result<(Vec<u8>, Vec<OriginManifestFileEntry>), String> {
    let out = Cursor::new(Vec::<u8>::new());
    let mut writer = ZipWriter::new(out);
    let options = FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated);
    let mut manifest_files: Vec<OriginManifestFileEntry> = Vec::new();

    for file in files {
        writer
            .start_file(file.path.as_str(), options)
            .map_err(|error| format!("zip write failed: {error}"))?;
        writer
            .write_all(file.content.as_bytes())
            .map_err(|error| format!("zip write failed: {error}"))?;
        manifest_files.push(OriginManifestFileEntry {
            path: file.path.to_string(),
            size: Some(file.content.len() as u64),
        });
    }

    let cursor = writer
        .finish()
        .map_err(|error| format!("zip finalize failed: {error}"))?;

    Ok((cursor.into_inner(), manifest_files))
}

fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = hasher.finalize();
    hex::encode(digest)
}

#[tracing::instrument(skip(state, headers, body))]
async fn create_org_project(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(org_id_raw): Path<String>,
    Json(body): Json<CreateOrgProjectBody>,
) -> Result<Json<CreateProjectResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let org_id = parse_uuid_param(org_id_raw, "org_id")?;

    let requested_owner = parse_optional_uuid_param(body.owner_user_id, "ownerUserId")?;
    let owner_user_id = if let Some(owner) = requested_owner {
        if !context.is_service_role && Some(owner) != context.user_id {
            return Err(forbidden("You cannot assign other users as owners."));
        }
        Some(owner)
    } else {
        context.user_id
    };

    if owner_user_id.is_none() && !context.is_service_role {
        return Err(unauthorized(
            "You must be signed in to create a project without specifying an owner.",
        ));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to acquire connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let org = load_org_record(&transaction, &org_id).await?;
    if !context.is_service_role {
        require_org_project_sharer(&transaction, &org_id, &context).await?;
    }

    if let Err(error) =
        crate::billing::service::ensure_default_org_subscription(&transaction, &org_id).await
    {
        tracing::warn!(
            org_id = %org_id,
            error = %error,
            "ensure_default_org_subscription failed",
        );
    }

    let sandbox_session_id =
        parse_optional_uuid_param(body.sandbox_session_id, "sandboxSessionId")?;
    let project_name = body
        .project_name
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let project_type = match body
        .project_type
        .as_deref()
        .map(|value| value.to_ascii_lowercase())
    {
        Some(ref t) if t == "sandbox" => "sandbox",
        Some(ref t) if t == "customer" => "customer",
        _ => "customer",
    };

    let row = transaction
        .query_one(
            "insert into projects (org_id, owner_user_id, sandbox_session_id, project_type, name)
             values ($1, $2, $3, $4, $5)
             returning id",
            &[
                &org_id,
                &owner_user_id,
                &sandbox_session_id,
                &project_type,
                &project_name,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to insert project: {error}")))?;

    let project_id: Uuid = row.get("id");

    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to finalize project creation: {error}")))?;

    Ok(Json(CreateProjectResponse {
        project_id,
        project_name,
        org_id: Some(org.id),
        org_name: Some(org.name),
    }))
}

#[cfg_attr(test, derive(Debug))]
pub(crate) enum OrgUpsertOutcome {
    /// Slug was free: a brand-new org was created (caller added as owner).
    Created(Uuid, String),
    /// Slug exists and the caller already belongs to it (or the caller is a
    /// service-role/backend job): resolved to the existing org.
    Existing(Uuid, String),
    /// Slug exists and belongs to an org the caller is NOT a member of.
    /// The caller must never be attached to it — creating an org can not be
    /// a way to join (let alone own) somebody else's workspace.
    SlugTakenByOthers,
}

pub(crate) async fn upsert_org(
    transaction: &tokio_postgres::Transaction<'_>,
    slug: &str,
    desired_name: &str,
    owner_user_id: Option<Uuid>,
) -> Result<OrgUpsertOutcome, (StatusCode, Json<ApiError>)> {
    let trimmed_name = desired_name.trim();
    if trimmed_name.is_empty() {
        return Err(bad_request("orgName must not be empty"));
    }

    let inserted = transaction
        .query_opt(
            "insert into organizations (slug, name)
             values ($1, $2)
             on conflict (slug) do nothing
             returning id, name",
            &[&slug, &trimmed_name],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to upsert organization: {}",
                describe_db_error(&error)
            ))
        })?;

    if let Some(row) = inserted {
        let org_id: Uuid = row.get("id");
        let org_name: String = row.get("name");
        if let Some(owner) = owner_user_id {
            transaction
                .execute(
                    "insert into org_memberships (org_id, user_id, role)
                     values ($1, $2, 'owner')
                     on conflict (org_id, user_id) do nothing",
                    &[&org_id, &owner],
                )
                .await
                .map_err(|error| {
                    internal_error(format!(
                        "failed to upsert org membership: {}",
                        describe_db_error(&error)
                    ))
                })?;
        }
        return Ok(OrgUpsertOutcome::Created(org_id, org_name));
    }

    let existing = transaction
        .query_one(
            "select id, name from organizations where slug = $1",
            &[&slug],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load existing org: {error}")))?;
    let org_id: Uuid = existing.get("id");
    let org_name: String = existing.get("name");

    let Some(owner) = owner_user_id else {
        // Service-role/backend callers keep the historical idempotent-by-slug
        // resolution; they act on behalf of the platform, not a tenant.
        return Ok(OrgUpsertOutcome::Existing(org_id, org_name));
    };

    let is_member: bool = transaction
        .query_one(
            "select exists(
               select 1 from org_memberships
               where org_id = $1 and user_id = $2
             )",
            &[&org_id, &owner],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check org membership: {error}")))?
        .get(0);

    if is_member {
        Ok(OrgUpsertOutcome::Existing(org_id, org_name))
    } else {
        Ok(OrgUpsertOutcome::SlugTakenByOthers)
    }
}

#[cfg(test)]
mod project_access_tests {
    use super::ProjectUpdateRequest;
    use super::{
        invitation_accept_urls, OrgInvitationResponse, OrgInvitationSummary, ProjectAccess,
        ProjectRole, CLAUDE_DOC_TEMPLATE, DIAGNOSTICS_OPENAI_TEMPLATE, DIAGNOSTICS_TEMPLATE,
        GROUP_PARTICIPATION_TEMPLATE, PROJECT_MEMORY_TEMPLATE_FILES,
    };
    use serde_json::json;
    use uuid::Uuid;

    #[test]
    fn project_identity_patch_distinguishes_omitted_from_null_and_rejects_unknown_values() {
        let mut rename: ProjectUpdateRequest =
            serde_json::from_value(json!({"projectName": " New name "})).unwrap();
        rename.validate().unwrap();
        assert_eq!(rename.project_name.as_deref(), Some("New name"));
        assert!(rename.project_icon.is_none());
        let mut clear: ProjectUpdateRequest =
            serde_json::from_value(json!({"projectIcon": null})).unwrap();
        clear.validate().unwrap();
        assert_eq!(clear.project_icon, Some(None));
        assert!(clear.project_color.is_none());
        for invalid in [
            json!({}),
            json!({"projectIcon": "<img>"}),
            json!({"projectColor": "url(bad)"}),
            json!({"projectName": " "}),
        ] {
            let mut request: ProjectUpdateRequest = serde_json::from_value(invalid).unwrap();
            assert!(request.validate().is_err());
        }
    }

    #[test]
    fn project_capabilities_distinguish_direct_and_organization_builders() {
        let direct_builder = ProjectAccess::from_membership(ProjectRole::Builder, false);
        assert!(direct_builder.can_write());
        assert!(!direct_builder.can_share);
        assert!(!direct_builder.can_manage);

        let organization_builder = ProjectAccess::from_membership(ProjectRole::Builder, true);
        assert!(organization_builder.can_write());
        assert!(organization_builder.can_share);
        assert!(!organization_builder.can_manage);

        let organization_admin = ProjectAccess::from_membership(ProjectRole::Admin, true);
        assert!(organization_admin.can_write());
        assert!(organization_admin.can_share);
        assert!(organization_admin.can_manage);
    }

    #[test]
    fn managed_defaults_include_group_participation_policy() {
        let template = PROJECT_MEMORY_TEMPLATE_FILES
            .iter()
            .find(|template| template.path == ".agents/skills/instafy-group-participation/SKILL.md")
            .expect("group participation managed default");

        assert_eq!(template.fallback_content, GROUP_PARTICIPATION_TEMPLATE);
        assert!(template.fallback_content.contains("always_include: true"));
        assert!(template.fallback_content.contains("targetMessageId"));
        assert!(template.fallback_content.contains("do not call tools"));
    }

    #[test]
    fn managed_defaults_include_ai_diagnostics_for_codex_and_claude() {
        let diagnostics = PROJECT_MEMORY_TEMPLATE_FILES
            .iter()
            .find(|template| template.path == ".agents/skills/instafy-diagnostics/SKILL.md")
            .expect("diagnostics managed default");
        let openai = PROJECT_MEMORY_TEMPLATE_FILES
            .iter()
            .find(|template| {
                template.path == ".agents/skills/instafy-diagnostics/agents/openai.yaml"
            })
            .expect("diagnostics OpenAI metadata managed default");
        let claude = PROJECT_MEMORY_TEMPLATE_FILES
            .iter()
            .find(|template| template.path == "CLAUDE.md")
            .expect("Claude bridge managed default");

        assert_eq!(diagnostics.fallback_content, DIAGNOSTICS_TEMPLATE);
        assert_eq!(openai.fallback_content, DIAGNOSTICS_OPENAI_TEMPLATE);
        assert_eq!(claude.fallback_content, CLAUDE_DOC_TEMPLATE);
        assert!(diagnostics
            .fallback_content
            .contains("instafy-diagnostics-v1"));
        assert!(diagnostics
            .fallback_content
            .contains("obtain explicit confirmation"));
        assert!(diagnostics
            .fallback_content
            .contains("correlation, not proof of causation"));
        assert_eq!(claude.fallback_content, "@AGENTS.md\n");
    }

    #[test]
    fn effective_access_keeps_the_strongest_role_and_combines_capabilities() {
        let direct_builder = ProjectAccess::from_membership(ProjectRole::Builder, false);
        let organization_viewer = ProjectAccess::from_membership(ProjectRole::Viewer, true);
        let merged = direct_builder.merge(organization_viewer);

        assert_eq!(merged.role, ProjectRole::Builder);
        assert!(merged.can_write());
        assert!(!merged.can_share);
        assert!(!merged.can_manage);

        let organization_admin = ProjectAccess::from_membership(ProjectRole::Admin, true);
        let merged = merged.merge(organization_admin);
        assert_eq!(merged.role, ProjectRole::Admin);
        assert!(merged.can_share);
        assert!(merged.can_manage);
    }

    #[test]
    fn invitation_accept_url_is_absolute_and_preserves_scoped_destination() {
        let token = Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap();
        let project_id = Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap();
        let conversation_id = Uuid::parse_str("cccccccc-cccc-4ccc-8ccc-cccccccccccc").unwrap();

        let (path, url) = invitation_accept_urls(
            "https://studio.example.com/",
            &token,
            Some(&project_id),
            Some(&conversation_id),
        );

        assert_eq!(
            path,
            "/invite?token=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&projectId=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&conversationControllerId=cccccccc-cccc-4ccc-8ccc-cccccccccccc&panel=chat"
        );
        assert_eq!(url, format!("https://studio.example.com{path}"));
    }

    #[test]
    fn invitation_creation_response_exposes_accept_url_without_changing_summary_shape() {
        let invitation = OrgInvitationSummary {
            id: Uuid::parse_str("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").unwrap(),
            org_id: Uuid::parse_str("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb").unwrap(),
            project_id: None,
            conversation_id: None,
            email: "teammate@example.com".to_string(),
            role: "viewer".to_string(),
            invited_by: None,
            status: "pending".to_string(),
            created_at: "2026-07-14T12:00:00Z".to_string(),
            expires_at: Some("2026-08-13T12:00:00Z".to_string()),
        };
        let summary_json = serde_json::to_value(&invitation).expect("serialize invitation summary");
        assert!(summary_json.get("acceptUrl").is_none());

        let response_json = serde_json::to_value(OrgInvitationResponse {
            invitation,
            accept_url: "https://studio.example.com/invite?token=one-time".to_string(),
        })
        .expect("serialize invitation creation response");

        assert_eq!(
            response_json,
            json!({
                "invitation": {
                    "id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "orgId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "projectId": null,
                    "conversationId": null,
                    "email": "teammate@example.com",
                    "role": "viewer",
                    "invitedBy": null,
                    "status": "pending",
                    "createdAt": "2026-07-14T12:00:00Z",
                    "expiresAt": "2026-08-13T12:00:00Z"
                },
                "acceptUrl": "https://studio.example.com/invite?token=one-time"
            })
        );
    }
}
