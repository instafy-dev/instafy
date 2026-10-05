//! The gateway's answers to a change it refuses, as JSON `{error, code,
//! ...}` with the paths concerned (at most [`MAX_REPORTED_PATHS`]; a
//! restore's conflicts all, up to as many as a restore can keep).

use axum::http::StatusCode;

use super::cache::{disk_full, says_disk_full};
use crate::error::OriginError;
use crate::publish_policy::RejectReason;

/// Paths named in one answer.
const MAX_REPORTED_PATHS: usize = 200;

/// An unexpected failure: 500, or 503 `disk_full` when it says the
/// gateway's disk is full.
pub(super) fn internal(error: impl std::fmt::Display) -> OriginError {
    // `{:#}` keeps the causes of an error that has them (a quarantine or
    // staging folder that could not be made because the disk is full).
    or_disk_full(OriginError::internal(format!("{error:#}")))
}

/// `error`, or 503 `disk_full` when it is an unexpected failure that says
/// the gateway's disk is full.
pub(super) fn or_disk_full(error: OriginError) -> OriginError {
    match &error {
        OriginError::Internal(message) if says_disk_full(message) => disk_full(),
        _ => error,
    }
}

/// Whether `error` is 503 `disk_full`.
pub(super) fn is_disk_full(error: &OriginError) -> bool {
    matches!(error, OriginError::RetryLater { code, .. } if *code == "disk_full")
}

pub(super) fn report(
    status: StatusCode,
    code: &'static str,
    message: &str,
    extra: serde_json::Value,
) -> OriginError {
    OriginError::with_report(status, code, message, extra)
}

/// `paths` as an error answer lists them: sorted, at most
/// [`MAX_REPORTED_PATHS`], with how many more there were.
pub(super) fn listed(paths: Vec<String>) -> serde_json::Value {
    listed_up_to(paths, MAX_REPORTED_PATHS)
}

/// [`listed`], at most `most` paths.
fn listed_up_to(mut paths: Vec<String>, most: usize) -> serde_json::Value {
    paths.sort();
    paths.dedup();
    let more = paths.len().saturating_sub(most);
    paths.truncate(most);
    if more > 0 {
        serde_json::json!({ "paths": paths, "morePaths": more })
    } else {
        serde_json::json!({ "paths": paths })
    }
}

pub(super) fn with_fields(
    mut value: serde_json::Value,
    fields: serde_json::Value,
) -> serde_json::Value {
    if let (Some(target), serde_json::Value::Object(fields)) = (value.as_object_mut(), fields) {
        target.extend(fields);
    }
    value
}

pub(crate) fn head_moved(head: Option<&str>, paths: Vec<String>) -> OriginError {
    report(
        StatusCode::CONFLICT,
        "head_moved",
        "these files changed since they were read; reload them and save again",
        with_fields(listed(paths), serde_json::json!({ "head": head })),
    )
}

pub(super) fn path_type_conflict(head: Option<&str>, paths: Vec<String>) -> OriginError {
    report(
        StatusCode::CONFLICT,
        "path_type_conflict",
        "a file and a folder would have the same name",
        with_fields(listed(paths), serde_json::json!({ "head": head })),
    )
}

pub(crate) fn main_busy() -> OriginError {
    report(
        StatusCode::CONFLICT,
        "main_busy",
        "other saves kept landing first; try again in a moment",
        serde_json::json!({}),
    )
}

pub(super) fn unsupported_entry(paths: Vec<String>) -> OriginError {
    report(
        StatusCode::BAD_REQUEST,
        "unsupported_entry",
        "a link or a submodule cannot be changed here",
        listed(paths),
    )
}

pub(super) fn delete_requires_base_rev(paths: Vec<String>) -> OriginError {
    report(
        StatusCode::BAD_REQUEST,
        "delete_requires_base_rev",
        "deleting a folder needs the version it was read at (baseRev)",
        listed(paths),
    )
}

/// 422 for paths that may never be saved. One answer names one reason:
/// secrets first (the client points to project secrets), then legacy chat
/// uploads, then everything else.
pub(super) fn excluded_path(refused: Vec<(String, RejectReason)>) -> OriginError {
    let rank = |reason: RejectReason| match reason {
        RejectReason::Secret => 0,
        RejectReason::Attachment => 1,
        _ => 2,
    };
    let reason = refused
        .iter()
        .map(|(_, reason)| *reason)
        .min_by_key(|reason| rank(*reason))
        .unwrap_or(RejectReason::Excluded);
    let paths = refused
        .into_iter()
        .filter(|(_, other)| rank(*other) == rank(reason))
        .map(|(path, _)| path)
        .collect();
    let message = match reason {
        RejectReason::Secret => {
            "secret files are never saved to history; keep them in project secrets"
        }
        RejectReason::Attachment => "chat uploads are not saved to the workspace any more",
        _ => "these paths are never saved to history (build output, dependencies or Instafy files)",
    };
    report(
        StatusCode::UNPROCESSABLE_ENTITY,
        "excluded_path",
        message,
        with_fields(
            listed(paths),
            serde_json::json!({ "reason": reason.name() }),
        ),
    )
}

pub(super) fn policy_rejected(paths: Vec<String>, reason: RejectReason) -> OriginError {
    report(
        StatusCode::UNPROCESSABLE_ENTITY,
        "policy_rejected",
        "these files are larger than a save may hold",
        with_fields(
            listed(paths),
            serde_json::json!({ "reason": reason.name() }),
        ),
    )
}

pub(super) fn ignored_path(paths: Vec<String>) -> OriginError {
    report(
        StatusCode::UNPROCESSABLE_ENTITY,
        "ignored_path",
        "the space's .gitignore ignores these new files, so they are not saved",
        listed(paths),
    )
}

pub(super) fn push_rejected() -> OriginError {
    report(
        StatusCode::BAD_GATEWAY,
        "push_rejected",
        "the saved versions refused this change",
        serde_json::json!({}),
    )
}

pub(crate) fn idempotency_conflict() -> OriginError {
    report(
        StatusCode::CONFLICT,
        "idempotency_conflict",
        "this import key was already used for a different request",
        serde_json::json!({}),
    )
}

pub(crate) fn rev_not_on_main(head: Option<&str>) -> OriginError {
    report(
        StatusCode::CONFLICT,
        "rev_not_on_main",
        "that version is not part of the saved history",
        serde_json::json!({ "head": head }),
    )
}

pub(super) fn revert_conflict(head: &str, paths: Vec<String>) -> OriginError {
    report(
        StatusCode::CONFLICT,
        "revert_conflict",
        "later changes touch the same lines; this version cannot be reverted automatically",
        with_fields(listed(paths), serde_json::json!({ "head": head })),
    )
}

/// 409 for the paths of a restore both sides changed. Every one is listed,
/// as on Desktop, up to as many as a restore can keep, so the person can
/// choose for all of them and send them back at once.
pub(super) fn restore_conflict(head: Option<&str>, paths: Vec<String>) -> OriginError {
    report(
        StatusCode::CONFLICT,
        "restore_conflict",
        "the saved version changed these files too; choose a version for each",
        with_fields(
            listed_up_to(paths, crate::publish::MAX_RESTORE_KEEP_PATHS),
            serde_json::json!({ "head": head }),
        ),
    )
}

/// The unsaved work moved (or went) since the client listed it: `rev` is
/// what the ref names now (`None`: it is gone).
pub(super) fn recovery_ref_moved(rev: Option<&str>) -> OriginError {
    report(
        StatusCode::CONFLICT,
        "recovery_ref_moved",
        "this unsaved work changed since it was listed; refresh and try again",
        serde_json::json!({ "rev": rev }),
    )
}

pub(super) fn salvage_ref_kept() -> OriginError {
    report(
        StatusCode::CONFLICT,
        "salvage_ref_kept",
        "work kept from a retired workspace stays available and cannot be removed",
        serde_json::json!({}),
    )
}

/// What the shard refused about one path, as an answer.
pub(super) fn hook_refusal(path: String, reason: RejectReason) -> OriginError {
    match reason {
        RejectReason::TooLarge => policy_rejected(vec![path], RejectReason::TooLarge),
        RejectReason::Unsupported => unsupported_entry(vec![path]),
        other => excluded_path(vec![(path, other)]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse as _;

    #[test]
    fn a_full_disk_is_asked_to_retry() {
        for text in [
            "failed to write ./objects/ab: No space left on device (os error 28)",
            "git hash-object failed: fatal: write error: Disk quota exceeded",
        ] {
            let error = internal(text);
            assert!(is_disk_full(&error), "{text}");
            let response = error.into_response();
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
            assert_eq!(
                response
                    .headers()
                    .get(axum::http::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok()),
                Some("2")
            );
        }
        // The OS error under the context a step added (creating a
        // quarantine, staging) counts too.
        let quarantine = anyhow::Error::from(std::io::Error::from_raw_os_error(28))
            .context("failed to create quarantine \"/c/.quarantine/x\"");
        assert!(is_disk_full(&internal(quarantine)));
        let other = internal("git write-tree failed: fatal: unable to read tree");
        assert!(!is_disk_full(&other));
        assert_eq!(
            other.into_response().status(),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }
}
