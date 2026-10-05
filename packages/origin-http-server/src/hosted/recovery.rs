//! Unsaved work on the gateway: restoring what a recovery or salvage ref
//! holds onto `main` (`POST /git/recovery/restore`) and dismissing a
//! recovery ref (`POST /git/recovery/dismiss`). Listing is a read
//! (`GET /git/recovery`, [`super::read::recovery_list`]).
//!
//! A ref is read on canonical by exactly its name. A request that names
//! the id it listed (`rev`: the ref's own id, or for a restore also its
//! commit) gets 409 `recovery_ref_moved` when the ref names something else
//! now or is gone. Removing a recovery ref is a delete under a lease on
//! that id, so newer work pushed to the same name is never removed.
//!
//! Salvage refs (work kept from retired gateway working copies) are kept
//! for good: they can be restored as often as wanted and never dismissed
//! (409 `salvage_ref_kept`). The recovery list marks one restored through
//! the `Instafy-Restored-From` trailer of the gateway's restore commit.

use std::collections::BTreeSet;
use std::time::Instant;

use axum::extract::State;
use axum::response::Json;
use axum::Extension;
use serde::Deserialize;
use tracing::{info, warn};

use super::answers::{internal, push_rejected, recovery_ref_moved, salvage_ref_kept};
use super::cache::{canonical_unreachable, MirrorLease};
use super::cas::save_author;
use super::change::Change;
use super::restore::Restore;
use super::routes::{
    caller_token, fetch_ref, on_mirror, project_of, ref_error, Admission, HostedState,
    REF_FETCH_DEADLINE,
};
use super::write::{caller_expiry, commit_change, gateway_identity, write_token};
use crate::apply::normalize_relative_path;
use crate::auth::OriginClaims;
use crate::error::OriginError;
use crate::push::{self, PushClass};
use crate::recovery_view::{parse_rev, remote_tip, restore_commit_message, RecoveryRef, ViewError};
use crate::route_auth::OriginAccessToken;
use crate::workspace_git::WorkspaceGit;

/// The most paths a restore can be asked to keep.
const MAX_KEEP_PATHS: usize = 1_000;

/// An optional full commit id from a request; empty counts as absent.
fn optional_rev(value: Option<&str>) -> Result<Option<String>, OriginError> {
    Ok(value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(parse_rev)
        .transpose()?)
}

/// The paths to keep, normalized and without repeats.
fn keep_paths(keep: Option<Vec<String>>) -> Result<Vec<String>, OriginError> {
    let keep = keep.unwrap_or_default();
    if keep.len() > MAX_KEEP_PATHS {
        return Err(OriginError::bad_request(format!(
            "at most {MAX_KEEP_PATHS} paths can be kept"
        )));
    }
    let mut paths = BTreeSet::new();
    for path in keep {
        if path.trim().is_empty() {
            continue;
        }
        paths.insert(normalize_relative_path(&path).ok_or(ViewError::InvalidPath)?);
    }
    Ok(paths.into_iter().collect())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RestoreRequest {
    #[serde(rename = "ref")]
    reference: String,
    /// The id the client listed the ref at.
    rev: Option<String>,
    /// The `main` the client last saw.
    base_rev: Option<String>,
    /// Paths that keep `main`'s version.
    keep: Option<Vec<String>>,
}

/// Restore unsaved work: the ref's commit merged onto `main` and saved as
/// one commit, then (for a recovery ref whose work is now all on `main`)
/// the ref removed. Answers `{rev, baseRev, committed, marked,
/// notRestored, refDeleted}`; `committed: false` when `main` already has
/// the work. A salvage ref with nothing left to bring back is recorded with
/// an empty restore commit (`marked: true`, `rev` the new commit) unless
/// `main` has one of it already, by Desktop's rule
/// ([`crate::recovery_view::restore_marker`]).
pub(super) async fn handle_restore(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    Extension(admission): Extension<Admission>,
    Json(request): Json<RestoreRequest>,
) -> Result<Json<serde_json::Value>, OriginError> {
    let project = project_of(&state, &claims)?;
    let reference = RecoveryRef::parse(request.reference.trim())?;
    let rev = optional_rev(request.rev.as_deref())?;
    let base_rev = optional_rev(request.base_rev.as_deref())?;
    let keep = keep_paths(request.keep)?;

    // Held for the whole restore, so the ref's objects stay in the mirror.
    let lease = state.cache.lease(project);
    // Fetching the ref waits on canonical: not work that needs the slot.
    let fetched = admission
        .paused(fetch_ref(
            &state,
            &lease,
            caller_token(&token),
            reference.clone(),
        ))
        .await?;
    let fetched = match (fetched, rev) {
        (None, Some(_)) => return Err(recovery_ref_moved(None)),
        (None, None) => return Err(ViewError::RefNotFound.into()),
        (Some(fetched), Some(rev)) if rev != fetched.tip && rev != fetched.commit => {
            return Err(recovery_ref_moved(Some(&fetched.tip)))
        }
        (Some(fetched), _) => fetched,
    };

    let gateway = gateway_identity(&state);
    let author = save_author(&claims, &gateway);
    let restore = Restore::new(
        reference.clone(),
        fetched.commit.clone(),
        keep,
        base_rev,
        gateway.email.clone(),
    );
    // The gateway writes the trailer that marks the ref restored (callers
    // never can: their messages lose every `Instafy-` trailer git reads).
    let (outcome, change) = commit_change(
        &state,
        project,
        &token,
        caller_expiry(&claims),
        admission.clone(),
        Change::Restore(restore),
        author,
        restore_commit_message(reference.as_str()),
    )
    .await?;
    // Removing the ref is network work too.
    admission.release();
    let Change::Restore(restore) = change else {
        return Err(internal("a restore came back as another change"));
    };

    // A recovery ref goes once `main` has its work (all of it but what the
    // person chose to keep). Salvage refs stay for good, and so does a ref
    // holding work that could not be saved here.
    let ref_deleted = if reference.dismissible() && !restore.left_out_unsaveable() {
        // A credential of its own: the restore's push may have outlived
        // the one it used.
        let removal = match write_token(&state, project, &token).await {
            Ok(write_token) => {
                remove_ref(&state, &lease, write_token, &reference, &fetched.tip).await
            }
            Err(error) => Err(error),
        };
        match removal {
            Ok(Removal::Deleted | Removal::Missing) => true,
            Ok(other) => {
                info!(%project, reference = reference.as_str(), outcome = ?other, "kept a restored ref");
                false
            }
            Err(error) => {
                warn!(%project, reference = reference.as_str(), %error, "could not remove a restored ref");
                false
            }
        }
    } else {
        false
    };
    // The commit that landed is the empty restore commit when the last
    // attempt recorded one.
    let marked = outcome.committed && restore.marker();
    let committed = outcome.committed && !marked;
    if committed {
        info!(%project, reference = reference.as_str(), "restored unsaved work on main");
    } else if marked {
        info!(%project, reference = reference.as_str(), "recorded a restore that brought nothing new");
    }
    Ok(Json(serde_json::json!({
        "rev": outcome.rev,
        "baseRev": outcome.base_rev,
        "committed": committed,
        "marked": marked,
        "notRestored": restore.not_restored(),
        "refDeleted": ref_deleted,
    })))
}

#[derive(Debug, Deserialize)]
pub(super) struct DismissRequest {
    #[serde(rename = "ref")]
    reference: String,
    /// The id the client listed the ref at: only that is removed.
    rev: Option<String>,
}

/// Remove unsaved work for everyone in the space: the recovery ref is
/// deleted on canonical while it still names `rev`. Answers `{dismissed,
/// missing}`; a ref that is already gone is `missing: true`.
pub(super) async fn handle_dismiss(
    State(state): State<HostedState>,
    Extension(claims): Extension<OriginClaims>,
    Extension(token): Extension<OriginAccessToken>,
    Json(request): Json<DismissRequest>,
) -> Result<Json<serde_json::Value>, OriginError> {
    let project = project_of(&state, &claims)?;
    let reference = RecoveryRef::parse(request.reference.trim())?;
    if !reference.dismissible() {
        return Err(salvage_ref_kept());
    }
    let rev = optional_rev(request.rev.as_deref())?.ok_or(ViewError::InvalidRev)?;
    let write_token = write_token(&state, project, &token).await?;
    let lease = state.cache.lease(project);
    let (dismissed, missing) =
        match remove_ref(&state, &lease, write_token, &reference, &rev).await? {
            Removal::Deleted => (true, false),
            Removal::Missing => (false, true),
            Removal::Moved(tip) => return Err(recovery_ref_moved(Some(&tip))),
            Removal::Refused => return Err(push_rejected()),
            Removal::Unknown => return Err(canonical_unreachable()),
        };
    if dismissed {
        info!(%project, reference = reference.as_str(), "dismissed unsaved work");
    }
    Ok(Json(serde_json::json!({
        "dismissed": dismissed,
        "missing": missing,
    })))
}

/// What removing a ref came to.
#[derive(Debug, PartialEq, Eq)]
enum Removal {
    Deleted,
    /// Already gone.
    Missing,
    /// It names this id now, not the listed one; left as it is.
    Moved(String),
    /// Canonical refused the delete.
    Refused,
    /// The delete got no answer and the ref is still there.
    Unknown,
}

/// Delete `reference` on canonical if it still names `rev`, with the
/// caller's `git.write` credential.
async fn remove_ref(
    state: &HostedState,
    lease: &MirrorLease,
    write_token: Option<String>,
    reference: &RecoveryRef,
    rev: &str,
) -> Result<Removal, OriginError> {
    let url = state.cache.remote_url(lease.project())?;
    let reference = reference.as_str().to_string();
    let rev = rev.to_string();
    on_mirror(state, lease, None, move |dir| {
        let git = WorkspaceGit::bare(dir, write_token.as_deref())
            .with_network_deadline(Instant::now() + REF_FETCH_DEADLINE);
        let reference = RecoveryRef::validate(&git, &reference)?;
        // What it names now: gone, or moved, is answered without a push.
        match remote_tip(&git, &url, &reference).map_err(ref_error)? {
            None => return Ok(Removal::Missing),
            Some(tip) if tip != rev => return Ok(Removal::Moved(tip)),
            Some(_) => {}
        }
        let class = match push::delete_with_lease(&git, &url, reference.as_str(), &rev) {
            Ok(result) => result.class,
            Err(error) => PushClass::Ambiguous(format!("{error:#}")),
        };
        let lost_race = match class {
            PushClass::Pushed => return Ok(Removal::Deleted),
            PushClass::Rejected(detail) => {
                warn!(detail = %detail, "canonical refused to delete a recovery ref");
                return Ok(Removal::Refused);
            }
            PushClass::PathRejected { path, .. } => {
                warn!(path = %path, "canonical refused to delete a recovery ref");
                return Ok(Removal::Refused);
            }
            PushClass::LostRace(_) => true,
            PushClass::Ambiguous(detail) => {
                warn!(detail = %detail, "deleting a recovery ref got no answer; checking it");
                false
            }
        };
        // Changed while it was deleted, or no answer: look again.
        Ok(
            match remote_tip(&git, &url, &reference).map_err(ref_error)? {
                None if lost_race => Removal::Missing,
                None => Removal::Deleted,
                Some(tip) if tip != rev => Removal::Moved(tip),
                Some(_) => Removal::Unknown,
            },
        )
    })
    .await
}
