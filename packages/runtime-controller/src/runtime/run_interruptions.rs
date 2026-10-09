//! A turn that a runtime stop cut off, as its run records it.
//!
//! A stop requeues the jobs its runtime was running
//! (`stop::resolve_jobs_for_unavailable_runtime`). In the same transaction it
//! moves the run of each one that was running back to `queued`, with
//! `progress_stage` `requeued` and the why in `metadata.interruption`, so the
//! turn no longer looks alive while it waits for a runtime. The lease that
//! resumes the job flips the run to `in_progress` like any queued run, and the
//! requeued-job expiry fails it with a message if nothing does
//! (`sweeps::expire_stale_requeued_jobs`).
//!
//! `/runtime/stop` and `/runtime/remove` also announce such runs as
//! `run.progress` once the stop has answered, so open tabs see the turn stop
//! working without a reload.

use std::str::FromStr;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde_json::{json, Value as JsonValue};
use tokio_postgres::Transaction;
use tracing::warn;
use uuid::Uuid;

use crate::runs::{map_run_row, run_snapshot_to_json, RunSnapshot};
use crate::{internal_error, ApiError, AppState};

use super::stop::{
    RuntimeRemovePayload, RuntimeRemoveResponse, RuntimeStopPayload, RuntimeStopResponse,
};
use super::sweeps::REQUEUED_JOB_EXPIRY_SECONDS;

/// The longest stop reason a run records as given.
const MAX_REASON_TOKEN_LEN: usize = 64;
/// The most interrupted runs one stop announces.
const ANNOUNCED_RUNS_LIMIT: i64 = 50;

/// A stop's reason as a run records it: the reason itself when it is a plain
/// token such as `user_stop` or `credits_exhausted`, otherwise `other`. A
/// stop's reason is free text from its caller, and it ends up in run and chat
/// metadata.
pub(super) fn interruption_reason_token(raw: &str) -> &str {
    let plain = !raw.is_empty()
        && raw.len() <= MAX_REASON_TOKEN_LEN
        && raw.bytes().all(|byte| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || matches!(byte, b'_' | b'.' | b':' | b'-')
        });
    if plain {
        raw
    } else {
        "other"
    }
}

/// Move the runs of `requeued_job_ids`, jobs of `project_id` a stop has just
/// requeued for `requeue_reason`, from running back to `queued`, with
/// `progress_stage` `requeued` and `metadata.interruption`
/// `{reason, jobId, interruptedAt, resumeBy}`. `interruptedAt` is the
/// transaction's time, as is the job's `payload.requeuedAt`, and `resumeBy` is
/// the earliest the requeued-job expiry may give the turn up. A run that was
/// not running, such as a queued job's, is left as it is. It runs in the
/// requeue's transaction, so a stop that rolls back marks nothing.
pub(super) async fn mark_interrupted_runs(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    requeued_job_ids: &[Uuid],
    requeue_reason: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if requeued_job_ids.is_empty() {
        return Ok(());
    }
    // Only a job with a run has a turn to mark.
    let jobs = transaction
        .query(
            "select id, run_id from agent_jobs
             where id = any($1::uuid[])
               and project_id = $2
               and run_id is not null",
            &[&requeued_job_ids, project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load the runs of requeued jobs: {error}"))
        })?;
    if jobs.is_empty() {
        return Ok(());
    }
    let (job_ids, run_ids): (Vec<Uuid>, Vec<Uuid>) = jobs
        .iter()
        .map(|row| (row.get::<_, Uuid>("id"), row.get::<_, Uuid>("run_id")))
        .unzip();

    transaction
        .execute(
            "update runs r
             set status = 'queued',
                 progress_stage = 'requeued',
                 metadata = coalesce(r.metadata, '{}'::jsonb) || jsonb_build_object(
                     'interruption', jsonb_build_object(
                         'reason', $4::text,
                         'jobId', interrupted.job_id,
                         'interruptedAt', to_jsonb(now()),
                         'resumeBy', to_jsonb(now() + $5::double precision * interval '1 second')
                     )
                 ),
                 updated_at = now()
             from unnest($1::uuid[], $2::uuid[]) as interrupted(job_id, run_id)
             where r.id = interrupted.run_id
               and r.project_id = $3
               and r.status in ('in_progress', 'awaiting_approval')",
            &[
                &job_ids,
                &run_ids,
                project_id,
                &interruption_reason_token(requeue_reason),
                &(REQUEUED_JOB_EXPIRY_SECONDS as f64),
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to mark runs interrupted by a runtime stop: {error}"
            ))
        })?;
    Ok(())
}

/// Publish every run of the runtime's space that a stop interrupted and that
/// still waits to resume, as the `run.progress` it is: its stored snapshot,
/// stamped with the time it was interrupted. Viewers see the turn stop
/// working without a reload, and a repeat tells them nothing new. Best
/// effort: a failure is logged and the stop's answer stands.
///
/// The snapshot is a plain read that locks nothing, and its connection goes
/// back to the pool before anything is published. A run a lease has already
/// resumed is not read. A lease that resumes a turn between the read and the
/// publish sends its own `run.progress`, stamped later than this one, which
/// viewers keep.
pub(super) async fn announce_interrupted_runs(state: &AppState, runtime_id: &Uuid) {
    let connection = match state.pool.get().await {
        Ok(connection) => connection,
        Err(error) => {
            warn!(
                runtime_id = %runtime_id,
                %error,
                "failed to get a connection to announce interrupted runs"
            );
            return;
        }
    };
    let rows = connection
        .query(
            "select r.id, r.project_id, r.session_id, r.conversation_id, r.prompt_id,
                    r.run_type, r.status, r.progress, r.progress_stage, r.preview_url,
                    r.last_message, r.metadata, r.created_at, r.updated_at,
                    j.id as job_id
             from runtimes rt
             join agent_jobs j on j.project_id = rt.project_id
             join runs r on r.id = j.run_id
             where rt.id = $1
               and j.status = 'queued'
               and j.payload ? 'requeuedAt'
               and r.status = 'queued'
               and r.progress_stage = 'requeued'
               and r.metadata #>> '{interruption,jobId}' = j.id::text
             order by r.updated_at desc
             limit $2",
            &[runtime_id, &ANNOUNCED_RUNS_LIMIT],
        )
        .await;
    drop(connection);
    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            warn!(
                runtime_id = %runtime_id,
                %error,
                "failed to load interrupted runs to announce"
            );
            return;
        }
    };

    for row in &rows {
        let snapshot = map_run_row(row);
        let job_id: Uuid = row.get("job_id");
        crate::state::publish_controller_event_with_conversation_at(
            &state.events,
            "run.progress",
            snapshot.project_id,
            snapshot.session_id,
            snapshot.conversation_id,
            Some(snapshot.id),
            Some(job_id),
            interrupted_run_event_data(&snapshot, &job_id),
            snapshot.updated_at,
        );
    }
}

/// The `run.progress` data of an interrupted run: its status and stage, as on
/// any `run.progress`, and the stored run.
fn interrupted_run_event_data(snapshot: &RunSnapshot, job_id: &Uuid) -> JsonValue {
    json!({
        "status": snapshot.status,
        "stage": snapshot.progress_stage,
        "jobId": job_id,
        "run": run_snapshot_to_json(snapshot),
    })
}

/// Whether a stop that answered `outcome` may have requeued a running turn.
/// Only a request refused before it reached a runtime (malformed, without
/// credentials, without access, or for no such runtime) cannot have. A
/// conflict or a server error can follow a committed quarantine, and so can
/// the 502 that reports a provider release still pending.
fn announces_after(outcome: Result<(), StatusCode>) -> bool {
    !matches!(
        outcome,
        Err(StatusCode::BAD_REQUEST
            | StatusCode::UNAUTHORIZED
            | StatusCode::FORBIDDEN
            | StatusCode::NOT_FOUND)
    )
}

/// `POST /runtime/stop`: [`super::stop::runtime_stop`], then the announcement
/// of the turns it interrupted. The request and the answer are the stop's.
pub(super) async fn runtime_stop_announcing_interruptions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RuntimeStopPayload>,
) -> Result<(StatusCode, Json<RuntimeStopResponse>), (StatusCode, Json<ApiError>)> {
    let runtime_id = Uuid::from_str(&payload.runtime_id).ok();
    let stopped = super::stop::runtime_stop(State(state.clone()), headers, Json(payload)).await;
    if let Some(runtime_id) = runtime_id {
        if announces_after(stopped.as_ref().map(|_| ()).map_err(|(status, _)| *status)) {
            announce_interrupted_runs(&state, &runtime_id).await;
        }
    }
    stopped
}

/// `POST /runtime/remove`: [`super::stop::runtime_remove`], then the
/// announcement of the turns it interrupted. The request and the answer are
/// the removal's.
pub(super) async fn runtime_remove_announcing_interruptions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RuntimeRemovePayload>,
) -> Result<Json<RuntimeRemoveResponse>, (StatusCode, Json<ApiError>)> {
    let runtime_id = Uuid::from_str(&payload.runtime_id).ok();
    let removed = super::stop::runtime_remove(State(state.clone()), headers, Json(payload)).await;
    if let Some(runtime_id) = runtime_id {
        if announces_after(removed.as_ref().map(|_| ()).map_err(|(status, _)| *status)) {
            announce_interrupted_runs(&state, &runtime_id).await;
        }
    }
    removed
}

#[cfg(test)]
#[path = "run_interruptions_tests.rs"]
pub(super) mod db_tests;

#[cfg(test)]
mod tests {
    use chrono::{Duration as ChronoDuration, Utc};

    use super::*;

    fn interrupted_snapshot(job_id: Uuid) -> RunSnapshot {
        let interrupted_at = Utc::now();
        RunSnapshot {
            id: Uuid::new_v4(),
            project_id: Some(Uuid::new_v4()),
            session_id: None,
            conversation_id: Some(Uuid::new_v4()),
            prompt_id: Some(Uuid::new_v4()),
            run_type: "prompt".to_string(),
            status: "queued".to_string(),
            progress: Some(40.0),
            progress_stage: Some("requeued".to_string()),
            preview_url: None,
            last_message: Some("Reading the repository".to_string()),
            metadata: Some(json!({
                "managedAiUsed": true,
                "interruption": {
                    "reason": "user_stop",
                    "jobId": job_id,
                    "interruptedAt": interrupted_at,
                    "resumeBy": interrupted_at + ChronoDuration::seconds(REQUEUED_JOB_EXPIRY_SECONDS),
                }
            })),
            created_at: interrupted_at - ChronoDuration::minutes(3),
            updated_at: interrupted_at,
        }
    }

    #[test]
    fn interrupted_run_event_data_mirrors_the_stored_run() {
        let job_id = Uuid::new_v4();
        let snapshot = interrupted_snapshot(job_id);

        let data = interrupted_run_event_data(&snapshot, &job_id);

        assert_eq!(
            data,
            json!({
                "status": "queued",
                "stage": "requeued",
                "jobId": job_id,
                "run": run_snapshot_to_json(&snapshot),
            })
        );
        assert_eq!(
            data["run"]["metadata"]["interruption"]["reason"],
            "user_stop"
        );
        assert_eq!(data["run"]["status"], "queued");
        assert!(data.get("percent").is_none());
        assert!(data.get("message").is_none());
    }

    /// The private-runtime filter of the event stream withholds an event
    /// with any key naming a runtime id. An interruption names none, so it
    /// reaches whoever may see the run.
    #[test]
    fn interruption_payloads_name_no_runtime() {
        fn keys(value: &JsonValue, found: &mut Vec<String>) {
            match value {
                JsonValue::Object(map) => {
                    for (key, nested) in map {
                        found.push(key.clone());
                        keys(nested, found);
                    }
                }
                JsonValue::Array(items) => items.iter().for_each(|item| keys(item, found)),
                _ => {}
            }
        }
        let job_id = Uuid::new_v4();
        let mut found = Vec::new();
        keys(
            &interrupted_run_event_data(&interrupted_snapshot(job_id), &job_id),
            &mut found,
        );
        assert!(found.iter().any(|key| key == "interruptedAt"));
        for key in found {
            let normalized: String = key
                .chars()
                .filter(char::is_ascii_alphanumeric)
                .flat_map(char::to_lowercase)
                .collect();
            assert!(
                !normalized.ends_with("runtimeid") && !normalized.ends_with("runtimeids"),
                "{key} names a runtime"
            );
        }
    }

    #[test]
    fn interruption_reason_is_a_bounded_token() {
        assert_eq!(interruption_reason_token("user_stop"), "user_stop");
        assert_eq!(
            interruption_reason_token("playwright:runtime-recovery"),
            "playwright:runtime-recovery"
        );
        assert_eq!(
            interruption_reason_token("pool.retirement"),
            "pool.retirement"
        );
        assert_eq!(interruption_reason_token(&"a".repeat(64)), "a".repeat(64));
        assert_eq!(interruption_reason_token(&"a".repeat(200)), "other");
        assert_eq!(interruption_reason_token(""), "other");
        assert_eq!(interruption_reason_token("<b>x</b>"), "other");
        assert_eq!(interruption_reason_token("User Stop"), "other");
    }

    #[test]
    fn announces_after_requeues_that_may_have_committed() {
        for refused in [
            StatusCode::BAD_REQUEST,
            StatusCode::UNAUTHORIZED,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
        ] {
            assert!(!announces_after(Err(refused)), "{refused}");
        }
        for after_a_requeue in [
            StatusCode::CONFLICT,
            StatusCode::INTERNAL_SERVER_ERROR,
            StatusCode::BAD_GATEWAY,
        ] {
            assert!(announces_after(Err(after_a_requeue)), "{after_a_requeue}");
        }
        // A 200, and the 502 answer of a stop whose provider release is
        // still pending, are both `Ok` to the wrapper.
        assert!(announces_after(Ok(())));
    }
}
