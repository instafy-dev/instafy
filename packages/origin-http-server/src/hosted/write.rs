//! The gateway's write routes: uploads (`/apply`, `/apply-json`), import
//! receipts (`/apply/status`) and reverting a saved change
//! (`/git/revert-commit`). Each becomes one commit on canonical `main`
//! through [`super::cas::cas_commit`]; nothing is kept on the gateway.
//! Restoring unsaved work goes the same way ([`super::recovery`]).

use std::collections::BTreeMap;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::time::Instant;

use axum::extract::{Multipart, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Json;
use axum::Extension;
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use serde::Deserialize;
use tracing::info;
use uuid::Uuid;

use super::answers::idempotency_conflict;
use super::cache::Freshness;
use super::cas::{
    applied_size, caller_message, cas_commit, default_message, find_applied, save_author, ApplyKey,
    CachedCanonical, CasOutcome, CasTarget, IMPORT_BUDGET, SAVE_BUDGET,
};
use super::change::{Change, Edits, Revert};
use super::disk::{create_private_dir, remove_entry};
use super::read;
use super::routes::{blocking, caller_token, coded, project_of, resolve_rev, HostedState};
use crate::apply::{
    normalize_relative_path, stage_archive, validate_apply_paths, ApplyManifest, StagedArchive,
};
use crate::apply_idempotency::{
    normalize_apply_idempotency_key, normalize_apply_request_fingerprint,
};
use crate::apply_request::{
    read_apply_json, read_apply_multipart, validate_apply_lease, ApplyArchive,
};
use crate::auth::{OriginClaims, WORKSPACE_IMPORT_SCOPE};
use crate::error::OriginError;
use crate::git::is_full_object_id;
use crate::git_tokens;
use crate::recovery_view::parse_rev;
use crate::route_auth::OriginAccessToken;
use crate::workspace_git::{GitIdentity, WorkspaceGit};

/// The header a client names itself in (diagnostics only).
const CLIENT_HEADER: &str = "x-instafy-client";

/// The log target of saves that came without a `baseRev`.
pub(crate) const NO_BASE_REV_TARGET: &str = "origin_apply_no_base_rev";

/// The client's own label, when it is a plain one.
fn client_label(headers: &HeaderMap) -> String {
    headers
        .get(CLIENT_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._/+-".contains(&byte))
        })
        .unwrap_or("unknown")
        .to_string()
}

fn idempotency_requires_import() -> OriginError {
    coded(
        StatusCode::BAD_REQUEST,
        "idempotency_requires_import",
        "an idempotency key is only accepted on an import",
    )
}

/// A staging folder for one upload under the cache's `.staging/`, removed
/// with whatever is in it when dropped.
struct Staging(PathBuf);

impl Staging {
    fn create(parent: &Path) -> Result<Self, OriginError> {
        let path = parent.join(Uuid::new_v4().as_hyphenated().to_string());
        create_private_dir(&path).map_err(|error| {
            OriginError::internal(format!("failed to create a staging folder: {error}"))
        })?;
        Ok(Self(path))
    }
}

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = remove_entry(&self.0);
    }
}

/// The gateway's own identity: every commit's committer.
pub(super) fn gateway_identity(state: &HostedState) -> GitIdentity {
    GitIdentity::new(
        state.auth.config.git_author_name.clone(),
        state.auth.config.git_author_email.clone(),
    )
}

/// The `git.write` credential for this request, exchanged from the
/// caller's own `fs.write` token (never the gateway's machine credential).
pub(super) async fn write_token(
    state: &HostedState,
    project: Uuid,
    token: &OriginAccessToken,
) -> Result<Option<String>, OriginError> {
    let caller = caller_token(token);
    if state.auth.config.skip_auth && caller.is_none() {
        return Ok(None);
    }
    Ok(git_tokens::mint_git_access_token(
        &state.auth.http_client,
        &state.auth.config,
        project,
        &["git.read", "git.write"],
        caller,
    )
    .await?
    .map(|minted| minted.token))
}

/// `expected` with normalized paths and lower-case full blob ids (`None`:
/// the path must not exist).
fn normalized_expected(
    expected: Option<BTreeMap<String, Option<String>>>,
) -> Result<BTreeMap<String, Option<String>>, OriginError> {
    let mut normalized = BTreeMap::new();
    for (path, oid) in expected.unwrap_or_default() {
        let path = normalize_relative_path(&path)
            .ok_or_else(|| OriginError::bad_request("invalid path in expected"))?;
        let oid = oid
            .map(|oid| oid.trim().to_ascii_lowercase())
            .filter(|oid| !oid.is_empty());
        if oid.as_deref().is_some_and(|oid| !is_full_object_id(oid)) {
            return Err(OriginError::bad_request(
                "expected blob ids must be full object ids",
            ));
        }
        normalized.insert(path, oid);
    }
    Ok(normalized)
}

pub(super) async fn handle_apply(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, OriginError> {
    let spool = state.cache.staging_dir()?;
    let (manifest, archive) = read_apply_multipart(
        &mut multipart,
        state.auth.config.max_archive_bytes,
        Some(&spool),
    )
    .await?;
    apply(state, claims, token, &headers, manifest, archive).await
}

pub(super) async fn handle_apply_json(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    request: Request,
) -> Result<Json<serde_json::Value>, OriginError> {
    let headers = request.headers().clone();
    let (manifest, archive) = read_apply_json(request, state.auth.config.max_archive_bytes).await?;
    apply(state, claims, token, &headers, manifest, archive).await
}

/// One upload: staged from the archive, then committed on `main`.
async fn apply(
    state: HostedState,
    claims: OriginClaims,
    token: OriginAccessToken,
    headers: &HeaderMap,
    manifest: ApplyManifest,
    archive: ApplyArchive,
) -> Result<Json<serde_json::Value>, OriginError> {
    let project = project_of(&state, &claims)?;
    if let Some(manifest_project) = manifest.project_id.as_deref() {
        if manifest_project.trim() != claims.project_id.trim() {
            return Err(OriginError::bad_request("manifest project mismatch"));
        }
    }
    validate_apply_lease(manifest.lease_id.as_deref(), claims.lease_id.as_deref())?;
    let key = normalize_apply_idempotency_key(manifest.idempotency_key.as_deref())?;
    let fingerprint = normalize_apply_request_fingerprint(manifest.request_fingerprint.as_deref())?;
    if key.is_none() && fingerprint.is_some() {
        return Err(OriginError::bad_request(
            "requestFingerprint requires idempotencyKey",
        ));
    }
    // Only the controller's import tokens may name an apply key: its keys
    // are the only ones nobody else can know.
    if key.is_some() && !claims.has_scope(WORKSPACE_IMPORT_SCOPE) {
        return Err(idempotency_requires_import());
    }
    let key = key.map(|key| ApplyKey { key, fingerprint });
    let import = key.is_some();
    let base_rev = manifest
        .base_rev
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(parse_rev)
        .transpose()?;
    let expected = normalized_expected(manifest.expected)?;
    if base_rev.is_none() && !import {
        info!(
            target: NO_BASE_REV_TARGET,
            %project,
            client = %client_label(headers),
            "a save came without baseRev; only exact paths are changed"
        );
    }
    let gateway = gateway_identity(&state);
    let author = save_author(&claims, &gateway);
    let caller_text = manifest.commit_message.clone();

    // Stage the upload under the cache, never in a space folder.
    let staging = Staging::create(&state.cache.staging_dir()?)?;
    let staging_path = staging.0.clone();
    let max_archive_bytes = state.auth.config.max_archive_bytes;
    let (files, deletes) = (manifest.files, manifest.deletes);
    let staged: StagedArchive = blocking(move || {
        let dir = Dir::open_ambient_dir(&staging_path, ambient_authority()).map_err(|error| {
            OriginError::internal(format!("failed to open the staging folder: {error}"))
        })?;
        let size = match &archive {
            ApplyArchive::InMemory(bytes) => bytes.len() as u64,
            ApplyArchive::TempFile { size, .. } => *size,
        };
        let paths = validate_apply_paths(files, deletes, size, max_archive_bytes)?;
        match archive {
            ApplyArchive::InMemory(bytes) => {
                stage_archive(Cursor::new(bytes), paths, max_archive_bytes, &dir)
            }
            ApplyArchive::TempFile { file, .. } => {
                stage_archive(file, paths, max_archive_bytes, &dir)
            }
        }
    })
    .await?;
    let written: Vec<String> = staged.files.iter().map(|file| file.path.clone()).collect();
    let message = caller_message(caller_text.as_deref())
        .unwrap_or_else(|| default_message(&written, &staged.deletes));
    let (file_count, bytes_written) = (staged.file_count, staged.bytes_written);

    let write_token = write_token(&state, project, &token).await?;
    let budget = if import { IMPORT_BUDGET } else { SAVE_BUDGET };
    let change = Change::Edits(Edits::new(
        staging.0.clone(),
        staged.files,
        staged.deletes,
        base_rev,
        expected,
        import,
    ));
    let (outcome, change) = commit(
        &state,
        project,
        &token,
        write_token,
        change,
        Some(staging),
        author,
        message,
        key,
        budget,
    )
    .await?;

    // Counts of what was saved: a replay's from its commit, an import's
    // without the files it left out.
    let (file_count, bytes_written) = match (&outcome.receipt, &change) {
        (Some(receipt), _) => *receipt,
        (None, Change::Edits(edits)) if import => edits.kept(),
        _ => (file_count, bytes_written),
    };
    let mut body = serde_json::json!({
        "rev": outcome.rev,
        "baseRev": outcome.base_rev,
        "committed": outcome.committed,
        "fileCount": file_count,
        "bytesWritten": bytes_written,
    });
    if outcome.replayed {
        body["replayed"] = serde_json::json!(true);
    }
    if let Change::Edits(edits) = &change {
        let skipped = edits.skipped();
        if !skipped.is_empty() {
            body["skippedPaths"] = serde_json::json!(skipped);
        }
    }
    if outcome.committed && !outcome.replayed {
        info!(%project, import, "saved a change on main");
    }
    Ok(Json(body))
}

/// Run [`cas_commit`] for `change` on `project`'s mirror, off the async
/// threads, with fetches through the mirror cache. `staging` (the upload's
/// files) lives as long as that work, even when the request is gone.
/// Returns the change too (what an import skipped).
#[allow(clippy::too_many_arguments)]
async fn commit(
    state: &HostedState,
    project: Uuid,
    token: &OriginAccessToken,
    write_token: Option<String>,
    mut change: Change,
    staging: Option<Staging>,
    author: GitIdentity,
    message: String,
    key: Option<ApplyKey>,
    budget: std::time::Duration,
) -> Result<(CasOutcome, Change), OriginError> {
    let lease = state.cache.lease(project);
    let mirror = lease.mirror();
    let remote = state.cache.remote_url(project)?;
    let quarantine_parent = state.cache.quarantine_dir()?;
    let committer = gateway_identity(state);
    let cache = state.cache.clone();
    let read_token = caller_token(token).map(str::to_string);
    let runtime = tokio::runtime::Handle::current();
    let deadline = Instant::now() + budget;
    blocking(move || {
        let dir = cache.ensure_mirror(&mirror)?;
        let mut canonical = CachedCanonical::new(cache, lease, read_token, runtime);
        let target = CasTarget {
            mirror: &dir,
            quarantine_parent: &quarantine_parent,
            remote: &remote,
            write_token: write_token.as_deref(),
            committer: &committer,
            deadline,
        };
        let outcome = cas_commit(
            &target,
            &mut change,
            &author,
            &message,
            key.as_ref(),
            &mut canonical,
        );
        drop(staging);
        Ok((outcome?, change))
    })
    .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ApplyStatusRequest {
    idempotency_key: String,
    request_fingerprint: Option<String>,
}

/// An import's receipt, read from `main`: the gateway's commit carrying
/// the import's key, with the counts the controller records.
pub(super) async fn handle_apply_status(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    Json(request): Json<ApplyStatusRequest>,
) -> Result<Json<serde_json::Value>, OriginError> {
    let project = project_of(&state, &claims)?;
    let key = normalize_apply_idempotency_key(Some(&request.idempotency_key))?
        .ok_or_else(|| OriginError::bad_request("idempotencyKey is required"))?;
    let fingerprint = normalize_apply_request_fingerprint(request.request_fingerprint.as_deref())?;
    if !claims.has_scope(WORKSPACE_IMPORT_SCOPE) {
        return Err(idempotency_requires_import());
    }
    let lease = state.cache.lease(project);
    let main = state
        .cache
        .resolve_main(&lease, Freshness::Fresh, caller_token(&token))
        .await?;
    let cache = state.cache.clone();
    let mirror = lease.mirror();
    let gateway_email = state.auth.config.git_author_email.clone();
    let found = blocking(move || {
        let dir = cache.ensure_mirror(&mirror)?;
        let git = WorkspaceGit::bare(&dir, None);
        let Some(applied) = find_applied(&git, main.as_deref(), &gateway_email, &key)? else {
            return Ok(None);
        };
        let (file_count, bytes_written) =
            applied_size(&git, &applied.commit, applied.parent.as_deref())?;
        Ok(Some((applied, file_count, bytes_written)))
    })
    .await?;
    let Some((applied, file_count, bytes_written)) = found else {
        return Err(coded(
            StatusCode::NOT_FOUND,
            "not_found",
            "no import with this key was saved",
        ));
    };
    if fingerprint.is_some() && applied.fingerprint != fingerprint {
        return Err(idempotency_conflict());
    }
    Ok(Json(serde_json::json!({
        "status": "succeeded",
        "rev": applied.commit,
        "baseRev": applied.parent,
        "fileCount": file_count,
        "bytesWritten": bytes_written,
    })))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RevertCommitRequest {
    commit: String,
    /// The version to revert to; required for a merge or a first commit.
    base: Option<String>,
}

/// Revert a saved change: the inverse of `commit` against `base` (its only
/// parent by default), merged onto `main` and saved as a new commit.
pub(super) async fn handle_git_revert_commit(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    Json(request): Json<RevertCommitRequest>,
) -> Result<Json<serde_json::Value>, OriginError> {
    let project = project_of(&state, &claims)?;
    let commit = parse_rev(request.commit.trim())?;
    let base = request
        .base
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(parse_rev)
        .transpose()?;
    let caller = caller_token(&token);
    let lease = state.cache.lease(project);
    let commit = resolve_rev(&state, &lease, caller, &commit).await?;
    let base = match base {
        Some(base) => Some(resolve_rev(&state, &lease, caller, &base).await?),
        None => None,
    };
    let cache = state.cache.clone();
    let mirror = lease.mirror();
    let reverted = commit.clone();
    let (base, subject) = blocking(move || {
        let dir = cache.ensure_mirror(&mirror)?;
        let git = WorkspaceGit::bare(&dir, None);
        let base = match base {
            Some(base) => {
                if !git
                    .is_ancestor(&base, &reverted)
                    .map_err(|error| OriginError::internal(error.to_string()))?
                {
                    return Err(OriginError::bad_request(
                        "base must be an ancestor of the reverted commit",
                    ));
                }
                base
            }
            None => match read::parents(&git, &reverted)?.as_slice() {
                [parent] => parent.clone(),
                _ => {
                    return Err(OriginError::bad_request(
                        "a merge or first commit needs a base to revert against",
                    ))
                }
            },
        };
        let subject = git
            .stdout(&[
                "log",
                "-1",
                "--format=%s",
                "--end-of-options",
                &reverted,
                "--",
            ])
            .map_err(|error| OriginError::internal(error.to_string()))?;
        Ok((base, subject))
    })
    .await?;
    drop(lease);

    let message = format!("Revert \"{subject}\"\n\nThis reverts commit {commit}.");
    let write_token = write_token(&state, project, &token).await?;
    let author = save_author(&claims, &gateway_identity(&state));
    let (outcome, _) = commit_change(
        &state,
        project,
        &token,
        write_token,
        Change::Revert(Revert::new(commit, base)),
        author,
        message,
    )
    .await?;
    Ok(Json(serde_json::json!({
        "rev": outcome.rev,
        "baseRev": outcome.base_rev,
        "committed": outcome.committed,
    })))
}

/// [`commit`] for a person's change (the save budget, no import key).
pub(super) async fn commit_change(
    state: &HostedState,
    project: Uuid,
    token: &OriginAccessToken,
    write_token: Option<String>,
    change: Change,
    author: GitIdentity,
    message: String,
) -> Result<(CasOutcome, Change), OriginError> {
    commit(
        state,
        project,
        token,
        write_token,
        change,
        None,
        author,
        message,
        None,
        SAVE_BUDGET,
    )
    .await
}
