//! Turns Instafy starts by itself, and what they cost.
//!
//! Two kinds of turn start without the person sending anything new:
//!
//! - a browser hand-back ([`crate::browser_hand_back`]): after a browser turn
//!   read pages for something Octo is building, Studio sends what it found
//!   back to the building turn;
//! - an automatic retry: after a turn fails for a passing reason (a dropped
//!   reply, a short rate limit), Studio sends the person's prompt again once,
//!   marked `retryAutomatic: true` with `retryOfMessageId` naming the failed
//!   message (Studio's `useRunFailureAutoRetry`).
//!
//! Such a turn reserves its credit at dispatch like any other, and costs what
//! any turn costs only when it ends with Octo's reply. One that fails, is
//! stopped, expires or ends without a reply gets its reserve and its daily
//! prompt slot back, and its tokens are never charged (docs/Credits-Billing.md,
//! "Turns Instafy starts by itself").
//!
//! Anyone who can send a message can write the marks above, so billing reads
//! only the controller's own stamps on the job: the hand-back record dispatch
//! puts on a hand-back it checked, and [`AUTOMATIC_RETRY_KEY`], which dispatch
//! puts on a resend only when [`verify_automatic_retry`] finds that it retries
//! the failed run of a prompt its sender sent in this conversation, at most
//! [`AUTOMATIC_RETRY_WINDOW_MINUTES`] ago, that was not itself a turn Instafy
//! started, with no prompt sent since and no earlier automatic retry of it. A
//! resend that fails a check still goes out, as an ordinary turn.

use axum::{http::StatusCode, Json};
use chrono::{DateTime, Utc};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::Transaction;
use tracing::{info, warn};
use uuid::Uuid;

use crate::auth::{require_user_session, RequestContext};
use crate::credits::ManagedAiRefundOutcome;
use crate::{internal_error, ApiError};

/// The controller's stamp on an automatic retry it checked.
pub(crate) const AUTOMATIC_RETRY_KEY: &str = "automaticRetry";
const AUTOMATIC_RETRY_ALIASES: [&str; 2] = [AUTOMATIC_RETRY_KEY, "automatic_retry"];
/// Studio's marks on a resend it sent by itself.
const RETRY_AUTOMATIC_KEY: &str = "retryAutomatic";
const RETRY_OF_MESSAGE_ID_KEY: &str = "retryOfMessageId";
/// Nested copies of the message metadata a client could also fill in.
const NESTED_METADATA_KEYS: [&str; 3] = ["prompt_metadata", "promptMetadata", "details"];
const AUTOMATIC_RETRY_VERSION: u64 = 1;
/// Studio resends a failure by itself only this soon after it
/// (`isRunFailureRecentForAutoRetry`).
pub(crate) const AUTOMATIC_RETRY_WINDOW_MINUTES: i64 = 10;
/// Why a turn Instafy started by itself got its reserve back.
pub(crate) const SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON: &str = "system_turn_without_reply";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SystemTurn {
    BrowserHandBack,
    AutomaticRetry,
}

/// Which turn Instafy started by itself a job is, from the controller's own
/// stamps on its payload; None for a turn someone sent.
pub(crate) fn system_turn_of(job_payload: &JsonValue) -> Option<SystemTurn> {
    let metadata = job_payload.get("metadata")?;
    if metadata
        .get(crate::browser_hand_back::HAND_BACK_KEY)
        .is_some_and(JsonValue::is_object)
    {
        return Some(SystemTurn::BrowserHandBack);
    }
    if metadata
        .get(AUTOMATIC_RETRY_KEY)
        .is_some_and(JsonValue::is_object)
    {
        return Some(SystemTurn::AutomaticRetry);
    }
    None
}

/// Whether a turn's completion is Octo's reply: it succeeded and says
/// something, not the decline sentinel that posts nothing.
pub(crate) fn completion_is_a_reply(outcome: &str, summary: Option<&str>) -> bool {
    outcome == "succeeded"
        && summary.is_some_and(|text| {
            !text.trim().is_empty()
                && !crate::group_participation::is_group_participation_decline_sentinel(text)
        })
}

/// Removes every client copy of the controller's automatic-retry stamp, top
/// level and nested, so only [`verify_automatic_retry`] can put one back.
pub(crate) fn strip_automatic_retry_stamps(metadata: &mut JsonValue) {
    let Some(map) = metadata.as_object_mut() else {
        return;
    };
    for key in AUTOMATIC_RETRY_ALIASES {
        map.remove(key);
    }
    for key in NESTED_METADATA_KEYS {
        if let Some(nested) = map.get_mut(key).and_then(JsonValue::as_object_mut) {
            for alias in AUTOMATIC_RETRY_ALIASES {
                nested.remove(alias);
            }
        }
    }
}

/// The failed message a resend says Instafy sent again by itself:
/// `retryAutomatic: true` with that message's id in `retryOfMessageId`. Only
/// a claim until [`verify_automatic_retry`] checks it.
pub(crate) fn automatic_retry_claim(metadata: &JsonValue) -> Option<Uuid> {
    if metadata
        .get(RETRY_AUTOMATIC_KEY)
        .and_then(JsonValue::as_bool)
        != Some(true)
    {
        return None;
    }
    metadata
        .get(RETRY_OF_MESSAGE_ID_KEY)?
        .as_str()
        .map(str::trim)
        .and_then(|raw| Uuid::parse_str(raw).ok())
}

/// Checks an automatic retry's claim and returns the stamp to put on its job,
/// or None for a resend that goes out as an ordinary turn. Runs inside the
/// dispatch transaction, after the conversation's dispatch fence, so two
/// resends of one failure cannot both pass the once-only check.
pub(crate) async fn verify_automatic_retry(
    transaction: &Transaction<'_>,
    conversation_id: &Uuid,
    context: &RequestContext,
    failure_message_id: &Uuid,
) -> Result<Option<JsonValue>, (StatusCode, Json<ApiError>)> {
    let Ok(user_id) = require_user_session(context) else {
        return Ok(None);
    };
    let failure = transaction
        .query_opt(
            "select message.run_id, message.created_at, run.status as run_status,
                    prompt.user_id as sender
               from conversation_messages message
               join runs run on run.id = message.run_id
               left join prompts prompt on prompt.id = run.prompt_id
              where message.id = $1
                and message.conversation_id = $2
                and message.role = 'assistant'
                and run.conversation_id = $2",
            &[failure_message_id, conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load the retried failure: {error}")))?;
    let Some(failure) = failure else {
        return Ok(None);
    };
    let failed_run_id: Uuid = failure.get("run_id");
    let failed_at: DateTime<Utc> = failure.get("created_at");
    if failure.get::<_, String>("run_status") != "failed"
        || failure.get::<_, Option<Uuid>>("sender") != Some(user_id)
        || Utc::now() - failed_at > chrono::Duration::minutes(AUTOMATIC_RETRY_WINDOW_MINUTES)
    {
        return Ok(None);
    }
    let checks = transaction
        .query_one(
            "select
                 exists (
                     select 1 from agent_jobs
                      where run_id = $2
                        and (payload #> '{metadata,automaticRetry}' is not null
                             or payload #> '{metadata,browserHandBack}' is not null)
                 ) as failed_turn_was_instafys,
                 exists (
                     select 1 from prompts
                      where conversation_id = $1 and created_at > $3
                 ) as written_after,
                 exists (
                     select 1 from agent_jobs
                      where conversation_id = $1
                        and payload #>> '{metadata,automaticRetry,failedRunId}' = $4
                 ) as already_retried",
            &[
                conversation_id,
                &failed_run_id,
                &failed_at,
                &failed_run_id.to_string(),
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check an automatic retry: {error}")))?;
    // One automatic hop: a failed turn Instafy started by itself is never
    // resent for free, so failures cannot chain into free turns.
    if checks.get::<_, bool>("failed_turn_was_instafys")
        || checks.get::<_, bool>("written_after")
        || checks.get::<_, bool>("already_retried")
    {
        return Ok(None);
    }
    Ok(Some(json!({
        "version": AUTOMATIC_RETRY_VERSION,
        "failureMessageId": failure_message_id,
        "failedRunId": failed_run_id,
    })))
}

/// Gives a turn Instafy started by itself its reserve and daily prompt slot
/// back when it ended without a reply: it failed, was stopped, expired, or
/// finished with nothing to say. A turn someone sent, or one that did not run
/// on Instafy AI, is left alone. Runs in a savepoint, so a ledger failure is
/// logged and never blocks the caller; the reserve then stands. Returns the
/// org whose credits this call changed, for a `credits.updated` once the
/// caller commits.
pub(crate) async fn give_back_reserve_without_reply(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
    run_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    leased_runtime_id: Option<Uuid>,
    job_payload: &JsonValue,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    if system_turn_of(job_payload).is_none() {
        return Ok(None);
    }
    let managed_ai_used = job_payload
        .pointer("/metadata/managedAiUsed")
        .and_then(JsonValue::as_bool)
        .unwrap_or(false);
    let prompt_id = prompt_id.or_else(|| {
        job_payload
            .get("prompt_id")
            .and_then(JsonValue::as_str)
            .and_then(|raw| Uuid::parse_str(raw.trim()).ok())
    });
    let (true, Some(prompt_id)) = (managed_ai_used, prompt_id) else {
        return Ok(None);
    };

    transaction
        .batch_execute("savepoint system_turn_refund")
        .await
        .map_err(|error| internal_error(format!("failed to open refund savepoint: {error}")))?;
    let outcome = refund_in_savepoint(
        transaction,
        project_id,
        run_id,
        &prompt_id,
        leased_runtime_id,
    )
    .await;
    match outcome {
        Ok(refunded) => {
            transaction
                .batch_execute("release savepoint system_turn_refund")
                .await
                .map_err(|error| {
                    internal_error(format!("failed to release refund savepoint: {error}"))
                })?;
            if refunded.is_some() {
                info!(
                    project_id = %project_id,
                    job_id = %job_id,
                    prompt_id = %prompt_id,
                    "gave back the reserve of a turn Instafy started that ended without a reply"
                );
            }
            Ok(refunded)
        }
        Err((status, Json(api_error))) => {
            warn!(
                project_id = %project_id,
                job_id = %job_id,
                prompt_id = %prompt_id,
                status = status.as_u16(),
                error = %api_error.message,
                "refund of a turn Instafy started failed; its reserve stands"
            );
            transaction
                .batch_execute(
                    "rollback to savepoint system_turn_refund;
                     release savepoint system_turn_refund",
                )
                .await
                .map_err(|error| {
                    internal_error(format!("failed to roll back refund savepoint: {error}"))
                })?;
            Ok(None)
        }
    }
}

async fn refund_in_savepoint(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    run_id: Option<Uuid>,
    prompt_id: &Uuid,
    leased_runtime_id: Option<Uuid>,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let project = crate::projects::load_project_record(transaction, project_id).await?;
    let Some(org_id) = project.org_id else {
        return Ok(None);
    };
    let ManagedAiRefundOutcome::Applied(refund) = crate::credits::refund_unused_managed_ai_prompt(
        transaction,
        project_id,
        &org_id,
        leased_runtime_id,
        prompt_id,
        SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON,
    )
    .await?
    else {
        return Ok(None);
    };
    // The daily prompt count reads prompts.metadata.managedAiUsed: clearing it
    // gives the slot back.
    crate::dispatch::persist_prompt_ai_access_metadata(transaction, prompt_id, true, false).await?;
    if let Some(run_id) = run_id {
        crate::dispatch::persist_run_ai_access_metadata(transaction, &[run_id], true, false)
            .await?;
        let mut refund_trace = json!(refund);
        refund_trace["refundReason"] = json!(SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON);
        crate::dispatch::persist_run_managed_ai_credit_metadata(
            transaction,
            &[run_id],
            &json!({ "promptId": prompt_id, "refund": refund_trace }),
        )
        .await?;
    }
    Ok(Some(org_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_controllers_own_stamps_make_a_turn_instafys() {
        assert_eq!(
            system_turn_of(&json!({"metadata": {"browserHandBack": {"version": 1}}})),
            Some(SystemTurn::BrowserHandBack)
        );
        assert_eq!(
            system_turn_of(&json!({"metadata": {"automaticRetry": {"version": 1}}})),
            Some(SystemTurn::AutomaticRetry)
        );
        // A client's marks are claims, not stamps.
        for metadata in [
            json!({"retryAutomatic": true, "retryOfMessageId": Uuid::new_v4().to_string()}),
            json!({"continuesFromBrowserJob": Uuid::new_v4().to_string()}),
            json!({"automaticRetry": true}),
            json!({"browserHandBack": "yes"}),
            json!({}),
        ] {
            assert_eq!(system_turn_of(&json!({ "metadata": metadata })), None);
        }
        assert_eq!(system_turn_of(&json!({})), None);
    }

    #[test]
    fn a_client_copy_of_the_stamp_never_survives_dispatch() {
        let mut metadata = json!({
            "automaticRetry": {"version": 1},
            "automatic_retry": {"version": 1},
            "retryAutomatic": true,
            "prompt_metadata": {"automaticRetry": {"version": 1}, "kept": 1},
            "promptMetadata": {"automatic_retry": {"version": 1}},
            "details": {"automaticRetry": {"version": 1}},
        });
        strip_automatic_retry_stamps(&mut metadata);
        assert_eq!(
            metadata,
            json!({
                "retryAutomatic": true,
                "prompt_metadata": {"kept": 1},
                "promptMetadata": {},
                "details": {},
            })
        );
    }

    #[test]
    fn a_claim_needs_the_automatic_mark_and_one_message_id() {
        let failure = Uuid::new_v4();
        assert_eq!(
            automatic_retry_claim(&json!({
                "retryAutomatic": true,
                "retryOfMessageId": format!(" {failure} "),
            })),
            Some(failure)
        );
        for metadata in [
            // "Try again" pressed by the person: their own turn.
            json!({"retryOfMessageId": failure.to_string()}),
            json!({"retryAutomatic": "true", "retryOfMessageId": failure.to_string()}),
            json!({"retryAutomatic": true}),
            json!({"retryAutomatic": true, "retryOfMessageId": "msg-1"}),
            json!({"retryAutomatic": true, "retryOfMessageId": [failure.to_string()]}),
        ] {
            assert_eq!(automatic_retry_claim(&metadata), None, "{metadata}");
        }
    }

    #[test]
    fn only_a_successful_turn_that_says_something_is_a_reply() {
        assert!(completion_is_a_reply(
            "succeeded",
            Some("Built the comparison page.")
        ));
        assert!(!completion_is_a_reply("succeeded", Some("  ")));
        assert!(!completion_is_a_reply("succeeded", None));
        assert!(!completion_is_a_reply("succeeded", Some("NO_RESPONSE")));
        for outcome in ["failed", "canceled", "expired"] {
            assert!(!completion_is_a_reply(outcome, Some("Partial answer")));
        }
    }
}
