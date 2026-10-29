//! Turns Instafy starts by itself, turns that end in a failure, and what they
//! cost (docs/Credits-Billing.md, "Turns Instafy starts by itself" and
//! "Failed turns").
//!
//! Three kinds of turn start without the person sending anything of their own:
//!
//! - a browser hand-back ([`crate::browser_hand_back`]): after a browser turn
//!   read pages for something Octo is building, Studio sends what it found
//!   back to the building turn;
//! - an automatic retry: after a turn fails for a passing reason (a dropped
//!   reply, a short rate limit), Studio sends the person's prompt again once,
//!   marked `retryAutomatic: true` with `retryOfMessageId` naming the failed
//!   message (Studio's `useRunFailureAutoRetry`);
//! - a card's browser turn: the browser turn that carries on Octo's
//!   `request_browser` card with the card's own task, marked
//!   `browserRequestOf: "job:<card job>"`. Studio opens it by itself or the
//!   person presses the card; billing cannot tell the two apart, and both ask
//!   only what Octo asked.
//!
//! Each reserves its credit at dispatch like any other turn. A hand-back or an
//! automatic retry costs what any turn costs when it ends with Octo's reply (a
//! team plan it writes is its reply once the plan goes out), or when it left
//! the person something without one, by the test for a failed turn below:
//! otherwise it could do the work and then fail, or be stopped, for free. A
//! card's browser turn costs what any turn costs only when it did something
//! in the browser beyond looking at the page it was given (it opened a page,
//! clicked, typed): a refusal is a reply too, so a reply cannot be the test.
//! A turn of these kinds that is not charged gets its reserve and its daily
//! prompt slot back, and its tokens are never charged, whether it finished,
//! failed, was stopped, expired or had its plan refused.
//!
//! Any turn that fails gets the same, as long as it left the person nothing:
//! no reply or note, no step that worked (a command, a tool call or a file
//! change; a look at the browser's tabs or page does not count) and no file
//! written. The runtime fails a turn whose model ended without a final answer,
//! and a model can be asked to do that, so a failure alone is not proof that
//! the person got nothing ([`turn_left_nothing`]).
//!
//! Anyone who can send a message can write the marks above, so billing reads
//! only the controller's own stamps on the job: the hand-back record dispatch
//! puts on a hand-back it checked, [`AUTOMATIC_RETRY_KEY`], which dispatch
//! puts on a resend only when [`verify_automatic_retry`] finds that it repeats,
//! word for word and with no attachments or browser, the failed prompt its
//! sender sent in this conversation at most [`AUTOMATIC_RETRY_WINDOW_MINUTES`]
//! ago, that the failed run was not itself a turn Instafy started, and that no
//! prompt was sent since and no earlier automatic retry of it, and
//! [`BROWSER_CARD_TURN_KEY`], which dispatch puts on a browser send only when
//! [`verify_browser_card_turn`] finds that it asks the card's own task and
//! nothing else, once per card, for a card from an ordinary turn its sender
//! sent. A send that fails a check still goes out, as an ordinary turn. Nor
//! does a hand-back carry anything of the sender's: dispatch gives it Studio's
//! words ([`crate::browser_hand_back::HAND_BACK_PROMPT`]) and refuses
//! attachments. Words someone sends into any of them while it runs (a steer)
//! make it a turn they sent ([`mark_steered`]).

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
/// Why a card's browser turn that did nothing in the browser beyond looking
/// got its reserve back.
pub(crate) const BROWSER_CARD_WITHOUT_PAGE_REFUND_REASON: &str = "browser_card_without_page";
/// Why a failed turn that left the person nothing got its reserve back.
pub(crate) const FAILED_TURN_WITHOUT_RESULT_REFUND_REASON: &str = "failed_turn_without_result";

/// The controller's stamp on a card's browser turn it checked.
pub(crate) const BROWSER_CARD_TURN_KEY: &str = "browserCardTurn";
const BROWSER_CARD_TURN_ALIASES: [&str; 2] = [BROWSER_CARD_TURN_KEY, "browser_card_turn"];
const BROWSER_CARD_TURN_VERSION: u64 = 1;
/// Studio's claim on a card's continuation: `"job:<card job>"`
/// (`BROWSER_REQUEST_OF_METADATA_KEY`).
const BROWSER_REQUEST_OF_KEY: &str = "browserRequestOf";
/// The line Studio has sent in front of a card's task
/// (`browserRequestContinuation`, system_turns_fixtures.json). A send of the
/// task alone, as Studio may send it, matches too.
const BROWSER_CARD_CONTINUATION_PREFIX: &str = "Continue this browser task using the browser attached to this turn. Inspect its current state first, preserve existing session state, and avoid repeating work that is already complete.\n\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SystemTurn {
    BrowserHandBack,
    AutomaticRetry,
    BrowserCard,
}

/// Put on such a turn when someone sends words into it while it runs (a
/// steer, crate::send_intents): their request rides on it from then on, so it
/// is charged as a turn they sent. Its stamp stays, for the checks that read
/// which turns Instafy started.
const STEERED_KEY: &str = "steeredByPerson";

/// Which turn Instafy started by itself a job is, from the controller's own
/// stamps on its payload; None for a turn someone sent or steered.
pub(crate) fn system_turn_of(job_payload: &JsonValue) -> Option<SystemTurn> {
    let metadata = job_payload.get("metadata")?;
    if metadata.get(STEERED_KEY).is_some() {
        return None;
    }
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
    if metadata
        .get(BROWSER_CARD_TURN_KEY)
        .is_some_and(JsonValue::is_object)
    {
        return Some(SystemTurn::BrowserCard);
    }
    None
}

/// Whether a job carries any of the controller's stamps for a turn Instafy
/// started, whether or not someone steered it since.
fn started_by_instafy(job_payload: &JsonValue) -> bool {
    job_payload.get("metadata").is_some_and(|metadata| {
        [
            crate::browser_hand_back::HAND_BACK_KEY,
            AUTOMATIC_RETRY_KEY,
            BROWSER_CARD_TURN_KEY,
        ]
        .iter()
        .any(|key| metadata.get(*key).is_some_and(JsonValue::is_object))
    })
}

/// Marks the steered job `job_id`, a turn Instafy started, as the sender's
/// own. Its row is locked by the steer.
pub(crate) async fn mark_steered(
    transaction: &Transaction<'_>,
    job_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .execute(
            "update agent_jobs
                set payload = jsonb_set(payload, array['metadata', $2::text], 'true'::jsonb, true)
              where id = $1",
            &[job_id, &STEERED_KEY],
        )
        .await
        .map_err(|error| internal_error(format!("failed to mark a steered turn: {error}")))?;
    Ok(())
}

/// Whether a turn's completion is Octo's reply: it succeeded and says
/// something, and is not a decline the controller swallows (`swallowed`: an
/// evaluation turn's `NO_RESPONSE`, which posts nothing). Any other turn
/// posts that word as its message, so for it the word is a reply.
pub(crate) fn completion_is_a_reply(outcome: &str, summary: Option<&str>, swallowed: bool) -> bool {
    outcome == "succeeded" && !swallowed && summary.is_some_and(|text| !text.trim().is_empty())
}

/// Removes every client copy of the controller's automatic-retry and card
/// browser turn stamps, top level and nested, so only
/// [`verify_automatic_retry`] and [`verify_browser_card_turn`] can put one
/// back.
pub(crate) fn strip_system_turn_stamps(metadata: &mut JsonValue) {
    let Some(map) = metadata.as_object_mut() else {
        return;
    };
    let stamps = AUTOMATIC_RETRY_ALIASES
        .iter()
        .chain(BROWSER_CARD_TURN_ALIASES.iter());
    for key in stamps.clone() {
        map.remove(*key);
    }
    for key in NESTED_METADATA_KEYS {
        if let Some(nested) = map.get_mut(key).and_then(JsonValue::as_object_mut) {
            for alias in stamps.clone() {
                nested.remove(*alias);
            }
        }
    }
}

/// Whether a send carries attachments where the runtime reads them: the
/// message's `attachments`, or its prompt metadata's (crate::chat_attachments).
pub(crate) fn carries_attachments(metadata: &JsonValue) -> bool {
    ["attachments", "prompt_metadata", "promptMetadata"]
        .iter()
        .filter_map(|key| metadata.get(*key))
        .filter_map(|source| match source {
            JsonValue::Array(entries) => Some(entries),
            JsonValue::Object(map) => map.get("attachments").and_then(JsonValue::as_array),
            _ => None,
        })
        .any(|entries| !entries.is_empty())
}

/// Whether a send carries words for one agent in its metadata
/// (`agentPromptSegments`, or `agentSelection.promptSegments`): dispatch hands
/// an agent that segment in place of the send's own words
/// (crate::dispatch `apply_agent_prompt_segment`), so a turn checked by its
/// words must carry none.
pub(crate) fn carries_prompt_segments(metadata: &JsonValue) -> bool {
    let segments = |value: Option<&JsonValue>| {
        value
            .and_then(JsonValue::as_object)
            .is_some_and(|segments| !segments.is_empty())
    };
    let selection = metadata
        .get("agentSelection")
        .and_then(JsonValue::as_object);
    segments(metadata.get("agentPromptSegments"))
        || segments(metadata.get("agent_prompt_segments"))
        || selection.is_some_and(|selection| {
            segments(selection.get("promptSegments")) || segments(selection.get("prompt_segments"))
        })
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

/// The rest of an automatic retry's checks, for conversation `$1`, the failed
/// run `$2` (and as text, `$4`) and the failure's time `$3`: whether that run
/// was itself a turn Instafy started, whether a prompt was sent since, and
/// whether the run was already retried automatically. Each reads only the
/// conversation's rows, through its index: `agent_jobs` has none on `run_id`.
const AUTOMATIC_RETRY_CHECKS_SQL: &str = "select
     exists (
         select 1 from agent_jobs
          where conversation_id = $1
            and run_id = $2
            and (payload #> '{metadata,automaticRetry}' is not null
                 or payload #> '{metadata,browserHandBack}' is not null
                 or payload #> '{metadata,browserCardTurn}' is not null)
     ) as failed_turn_was_instafys,
     exists (
         select 1 from prompts
          where conversation_id = $1 and created_at > $3
     ) as written_after,
     exists (
         select 1 from agent_jobs
          where conversation_id = $1
            and payload #>> '{metadata,automaticRetry,failedRunId}' = $4
     ) as already_retried";

/// Checks an automatic retry's claim and returns the stamp to put on its job,
/// or None for a resend that goes out as an ordinary turn. `prompt_text` and
/// `metadata` are the resend's: Studio sends the failed prompt again word for
/// word, never with attachments or a browser
/// (`isRunFailurePromptAutoResendable`), and never with words for one agent
/// ([`carries_prompt_segments`]), so a send with other words or with any of
/// them is the person's own new request. Runs inside the dispatch
/// transaction, after the conversation's dispatch fence, so two resends of
/// one failure cannot both pass the once-only check.
pub(crate) async fn verify_automatic_retry(
    transaction: &Transaction<'_>,
    conversation_id: &Uuid,
    context: &RequestContext,
    failure_message_id: &Uuid,
    prompt_text: &str,
    metadata: &JsonValue,
) -> Result<Option<JsonValue>, (StatusCode, Json<ApiError>)> {
    let Ok(user_id) = require_user_session(context) else {
        return Ok(None);
    };
    if carries_attachments(metadata)
        || carries_prompt_segments(metadata)
        || crate::browser_hand_back::browser_transport_of(metadata).is_some()
    {
        return Ok(None);
    }
    let failure = transaction
        .query_opt(
            "select message.run_id, message.created_at, run.status as run_status,
                    prompt.user_id as sender, prompt.prompt_text as failed_prompt
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
        || failure
            .get::<_, Option<String>>("failed_prompt")
            .as_deref()
            .map(str::trim)
            != Some(prompt_text.trim())
        || Utc::now() - failed_at > chrono::Duration::minutes(AUTOMATIC_RETRY_WINDOW_MINUTES)
    {
        return Ok(None);
    }
    let checks = transaction
        .query_one(
            AUTOMATIC_RETRY_CHECKS_SQL,
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

/// The card a browser send says it carries on: `browserRequestOf:
/// "job:<card job>"`. Only a claim until [`verify_browser_card_turn`] checks
/// it.
fn browser_card_claim(metadata: &JsonValue) -> Option<Uuid> {
    let raw = metadata.get(BROWSER_REQUEST_OF_KEY)?.as_str()?;
    Uuid::parse_str(raw.trim().strip_prefix("job:")?.trim()).ok()
}

/// Whether a send's words ask the card's task and nothing else: the task
/// alone, or after Studio's continuation prefix, as Studio sends it.
fn asks_only_the_card_task(prompt_text: &str, task: &str) -> bool {
    let task = task.trim();
    if task.is_empty() {
        return false;
    }
    let words = prompt_text.trim();
    let words = words
        .strip_prefix(BROWSER_CARD_CONTINUATION_PREFIX.trim_end())
        .map(str::trim_start)
        .unwrap_or(words);
    words == task
}

/// A card's checks, for conversation `$1` and the card's job `$2` (and as
/// text, `$3`): who sent the card's turn and its stamps, the task of the card
/// that turn's runtime posted (its own `action_request` message, never a
/// client's), and whether a browser turn already carried that card on. Each
/// reads only the conversation's rows, through its index.
const BROWSER_CARD_CHECKS_SQL: &str = "select
     job.payload as card_payload,
     prompt.user_id as card_sender,
     (select coalesce(card.metadata #>> '{details,browserRequest,task}',
                      card.metadata #>> '{details,details,browserRequest,task}')
        from conversation_messages card
       where card.conversation_id = $1
         and card.role = 'assistant'
         and card.created_by is null
         and card.metadata #>> '{jobId}' = $3
         and lower(coalesce(card.metadata #>> '{messageType}', card.metadata #>> '{message_type}', ''))
             = 'action_request'
         and coalesce(card.metadata #> '{details,browserRequest}',
                      card.metadata #> '{details,details,browserRequest}') is not null
       order by card.created_at desc
       limit 1) as card_task,
     exists (
         select 1 from agent_jobs earlier
          where earlier.conversation_id = $1
            and earlier.payload #>> '{metadata,browserCardTurn,cardJobId}' = $3
     ) as already_carried_on
   from agent_jobs job
   left join prompts prompt on prompt.id = job.prompt_id
  where job.id = $2 and job.conversation_id = $1";

/// Checks a browser send's claim that it carries on Octo's card and returns
/// the stamp to put on its job, or None for a send that goes out as the
/// sender's own turn. The send must ask the card's task and nothing else (no
/// other words, no attachments), as Studio's continuation does whether Studio
/// opened it or the sender pressed the card; the card must be the runtime's
/// own, from an ordinary turn the sender sent (not one Instafy started, so
/// cards never chain into free turns); and no browser turn may have carried
/// it on before. Runs inside the dispatch transaction, after the
/// conversation's dispatch fence, so two sends for one card cannot both pass
/// the once-only check.
pub(crate) async fn verify_browser_card_turn(
    transaction: &Transaction<'_>,
    conversation_id: &Uuid,
    context: &RequestContext,
    prompt_text: &str,
    metadata: &JsonValue,
) -> Result<Option<JsonValue>, (StatusCode, Json<ApiError>)> {
    let Some(card_job_id) = browser_card_claim(metadata) else {
        return Ok(None);
    };
    let Ok(user_id) = require_user_session(context) else {
        return Ok(None);
    };
    if crate::browser_hand_back::browser_transport_of(metadata).is_none()
        || carries_attachments(metadata)
        || carries_prompt_segments(metadata)
    {
        return Ok(None);
    }
    let Some(card) = transaction
        .query_opt(
            BROWSER_CARD_CHECKS_SQL,
            &[conversation_id, &card_job_id, &card_job_id.to_string()],
        )
        .await
        .map_err(|error| internal_error(format!("failed to check a browser card: {error}")))?
    else {
        return Ok(None);
    };
    let card_payload = card
        .get::<_, tokio_postgres::types::Json<JsonValue>>("card_payload")
        .0;
    // A card from a turn Instafy started, steered or not, stays the sender's
    // own to carry on: one free hop at most.
    let ordinary_card_turn = card.get::<_, Option<Uuid>>("card_sender") == Some(user_id)
        && !started_by_instafy(&card_payload);
    let asks_the_card = card
        .get::<_, Option<String>>("card_task")
        .is_some_and(|task| asks_only_the_card_task(prompt_text, &task));
    if !ordinary_card_turn || !asks_the_card || card.get::<_, bool>("already_carried_on") {
        return Ok(None);
    }
    Ok(Some(json!({
        "version": BROWSER_CARD_TURN_VERSION,
        "cardJobId": card_job_id,
    })))
}

/// Statuses a step ends with when it did not work (Studio's `FAILED_STATES`).
const STEP_FAILED_STATES: &str =
    "('failed', 'failure', 'error', 'errored', 'declined', 'cancelled', 'canceled')";

/// The browser tools that only look: at the tabs, the browser's state or the
/// page it is on. Anything else a browser turn does that works (opening a
/// page, a click, typing) is something done in the browser.
const BROWSER_LOOK_TOOLS: &str = "('list_tabs', 'status', 'snapshot')";

/// Whether any step of job `$2` in project `$1` worked: a command, a tool call
/// or a file change whose last report is not a failure (one whose end never
/// arrived counts, since it may have worked), other than a look at the
/// browser's tabs or page and the runtime's own routing pre-observation.
fn step_that_worked_sql() -> String {
    format!(
        "select exists (
             select 1
               from (
                 select distinct on (coalesce(metadata #>> '{{details,itemId}}', id::text))
                        lower(coalesce(metadata #>> '{{details,status}}', '')) as status,
                        coalesce(metadata #>> '{{details,exitCode}}', metadata #>> '{{details,exit_code}}') as exit_code,
                        metadata #>> '{{details,server}}' as server,
                        metadata #>> '{{details,tool}}' as tool
                   from conversation_messages
                  where project_id = $1
                    and coalesce(metadata #>> '{{jobId}}', metadata #>> '{{job_id}}') = $2
                    and lower(coalesce(metadata #>> '{{messageType}}', metadata #>> '{{message_type}}', ''))
                        in ('command_execution', 'mcp_tool_call', 'web_search', 'file_change')
                    and metadata #>> '{{details,source}}' is distinct from 'routing_pre_observation'
                  order by coalesce(metadata #>> '{{details,itemId}}', id::text), created_at desc, id desc
               ) step
              where step.status not in {STEP_FAILED_STATES}
                and coalesce(step.exit_code, '0') = '0'
                and not coalesce(step.server in ('instafy_shared_browser', 'instafy_personal_browser')
                                 and step.tool in {BROWSER_LOOK_TOOLS}, false)
         )"
    )
}

/// Whether job `job_id` did something that worked (see [`step_that_worked_sql`]).
pub(crate) async fn job_has_a_step_that_worked(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    transaction
        .query_one(
            step_that_worked_sql().as_str(),
            &[project_id, &job_id.to_string()],
        )
        .await
        .map(|row| row.get::<_, bool>(0))
        .map_err(|error| internal_error(format!("failed to read a turn's steps: {error}")))
}

/// Whether a completion's artifacts say the turn wrote files: an applied file
/// list or a save to the space's origin that names a path.
pub(crate) fn artifacts_wrote_files(artifacts: &JsonValue) -> bool {
    artifacts.as_array().into_iter().flatten().any(|artifact| {
        let listed = |value: Option<&JsonValue>| {
            value
                .and_then(JsonValue::as_array)
                .is_some_and(|entries| !entries.is_empty())
        };
        match artifact.get("kind").and_then(JsonValue::as_str) {
            Some("apply/files") => listed(artifact.get("files")),
            Some("origin/apply") => listed(artifact.pointer("/metadata/paths")),
            _ => false,
        }
    })
}

/// Whether a turn left the person nothing: no step that worked, no file it
/// wrote (`artifacts`, when its completion carried any) and, when `counts_text`,
/// nothing it said, a note included. A card's browser turn leaves its reply
/// out: a refusal is a reply too.
pub(crate) async fn turn_left_nothing(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
    run_id: Option<Uuid>,
    artifacts: Option<&JsonValue>,
    counts_text: bool,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    if artifacts.is_some_and(artifacts_wrote_files)
        || job_has_a_step_that_worked(transaction, project_id, job_id).await?
    {
        return Ok(false);
    }
    if counts_text
        && crate::agent::run_has_visible_assistant_message(transaction, project_id, run_id).await?
    {
        return Ok(false);
    }
    Ok(true)
}

/// Why a completed turn costs nothing, as its refund's reason, or None for a
/// turn charged as any turn is. `swallowed` says the completion is a decline
/// the controller posts nothing for (see [`completion_is_a_reply`]).
#[allow(clippy::too_many_arguments)]
pub(crate) async fn completion_refund_reason(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
    run_id: Option<Uuid>,
    job_payload: &JsonValue,
    outcome: &str,
    summary: Option<&str>,
    swallowed: bool,
    artifacts: &JsonValue,
) -> Result<Option<&'static str>, (StatusCode, Json<ApiError>)> {
    Ok(match system_turn_of(job_payload) {
        Some(SystemTurn::BrowserHandBack | SystemTurn::AutomaticRetry) => {
            if completion_is_a_reply(outcome, summary, swallowed) {
                None
            } else {
                turn_left_nothing(
                    transaction,
                    project_id,
                    job_id,
                    run_id,
                    Some(artifacts),
                    true,
                )
                .await?
                .then_some(SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON)
            }
        }
        Some(SystemTurn::BrowserCard) => turn_left_nothing(
            transaction,
            project_id,
            job_id,
            run_id,
            Some(artifacts),
            false,
        )
        .await?
        .then_some(BROWSER_CARD_WITHOUT_PAGE_REFUND_REASON),
        None if outcome == "failed" => turn_left_nothing(
            transaction,
            project_id,
            job_id,
            run_id,
            Some(artifacts),
            true,
        )
        .await?
        .then_some(FAILED_TURN_WITHOUT_RESULT_REFUND_REASON),
        None => None,
    })
}

/// Gives a turn Instafy started by itself its reserve and daily prompt slot
/// back when it ended without what it is charged for, and without a
/// completion: it was stopped, expired, had its plan refused or was covered
/// by a teammate's answer. A hand-back or an automatic retry then never ended
/// with a reply, and costs nothing when it left the person nothing else
/// either; a card's browser turn is charged when it did something in the
/// browser beyond looking. A turn someone sent, or one that did not run on
/// Instafy AI, is left alone. See [`give_back_reserve`].
pub(crate) async fn give_back_reserve_without_reply(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
    run_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    leased_runtime_id: Option<Uuid>,
    job_payload: &JsonValue,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    let reason = match system_turn_of(job_payload) {
        None => return Ok(None),
        Some(SystemTurn::BrowserHandBack | SystemTurn::AutomaticRetry) => {
            if !turn_left_nothing(transaction, project_id, job_id, run_id, None, true).await? {
                return Ok(None);
            }
            SYSTEM_TURN_WITHOUT_REPLY_REFUND_REASON
        }
        Some(SystemTurn::BrowserCard) => {
            if !turn_left_nothing(transaction, project_id, job_id, run_id, None, false).await? {
                return Ok(None);
            }
            BROWSER_CARD_WITHOUT_PAGE_REFUND_REASON
        }
    };
    give_back_reserve(
        transaction,
        project_id,
        job_id,
        run_id,
        prompt_id,
        leased_runtime_id,
        job_payload,
        reason,
    )
    .await
}

/// Gives back the reserve of a browser turn whose machine went away. A browser
/// turn cannot move to another machine, so a stop of its machine fails it on
/// the spot (crate::runtime stop), with no completion and no expiry sweep: it
/// is judged as any failed turn is. A card's browser turn follows its own rule
/// (it costs nothing unless it did something in the browser), and a turn
/// someone sent costs nothing when it left the person nothing
/// ([`turn_left_nothing`]). Its tokens never reached the ledger, so its
/// reserve is all it was charged. The checks and the refund run in a
/// savepoint, so a failure is logged and never blocks the stop. Returns the
/// org whose credits this call changed, for a `credits.updated` once the
/// caller commits.
pub(crate) async fn give_back_reserve_of_lost_browser_turn(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
    run_id: Option<Uuid>,
    job_payload: &JsonValue,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
    transaction
        .batch_execute("savepoint lost_browser_turn")
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to open lost browser turn savepoint: {error}"
            ))
        })?;
    let outcome = async {
        if system_turn_of(job_payload).is_some() {
            return give_back_reserve_without_reply(
                transaction,
                project_id,
                job_id,
                run_id,
                None,
                None,
                job_payload,
            )
            .await;
        }
        if !turn_left_nothing(transaction, project_id, job_id, run_id, None, true).await? {
            return Ok(None);
        }
        give_back_reserve(
            transaction,
            project_id,
            job_id,
            run_id,
            None,
            None,
            job_payload,
            FAILED_TURN_WITHOUT_RESULT_REFUND_REASON,
        )
        .await
    }
    .await;
    match outcome {
        Ok(refunded) => {
            transaction
                .batch_execute("release savepoint lost_browser_turn")
                .await
                .map_err(|error| {
                    internal_error(format!(
                        "failed to release lost browser turn savepoint: {error}"
                    ))
                })?;
            Ok(refunded)
        }
        Err((status, Json(api_error))) => {
            warn!(
                project_id = %project_id,
                job_id = %job_id,
                status = status.as_u16(),
                error = %api_error.message,
                "could not settle the reserve of a browser turn whose machine stopped; it stands"
            );
            transaction
                .batch_execute(
                    "rollback to savepoint lost_browser_turn;
                     release savepoint lost_browser_turn",
                )
                .await
                .map_err(|error| {
                    internal_error(format!(
                        "failed to roll back lost browser turn savepoint: {error}"
                    ))
                })?;
            Ok(None)
        }
    }
}

/// Gives a managed-AI turn's reserve and daily prompt slot back, once, with
/// `reason` on the refund, for a turn that costs nothing (its caller decided
/// that). One that did not run on Instafy AI is left alone. Runs in a
/// savepoint, so a ledger failure is logged and never blocks the caller; the
/// reserve then stands. Returns the org whose credits this call changed, for
/// a `credits.updated` once the caller commits.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn give_back_reserve(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
    job_id: &Uuid,
    run_id: Option<Uuid>,
    prompt_id: Option<Uuid>,
    leased_runtime_id: Option<Uuid>,
    job_payload: &JsonValue,
    reason: &'static str,
) -> Result<Option<Uuid>, (StatusCode, Json<ApiError>)> {
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
        reason,
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
                    reason,
                    "gave back the reserve of a turn that costs nothing"
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
                reason,
                "refund of a turn that costs nothing failed; its reserve stands"
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
    reason: &'static str,
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
        reason,
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
        refund_trace["refundReason"] = json!(reason);
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
        assert_eq!(
            system_turn_of(&json!({"metadata": {"browserCardTurn": {"version": 1}}})),
            Some(SystemTurn::BrowserCard)
        );
        assert_eq!(
            system_turn_of(&json!({"metadata": {
                "browserCardTurn": {"version": 1},
                "steeredByPerson": true,
            }})),
            None
        );
        // Someone wrote into it while it ran: it is their turn now.
        assert_eq!(
            system_turn_of(&json!({"metadata": {
                "automaticRetry": {"version": 1},
                "steeredByPerson": true,
            }})),
            None
        );
        // A client's marks are claims, not stamps.
        for metadata in [
            json!({"retryAutomatic": true, "retryOfMessageId": Uuid::new_v4().to_string()}),
            json!({"continuesFromBrowserJob": Uuid::new_v4().to_string()}),
            json!({"automaticRetry": true}),
            json!({"browserHandBack": "yes"}),
            // Studio's marks on a card it opened: the claim the dispatch checks.
            json!({"browserRequestOf": format!("job:{}", Uuid::new_v4()), "browserAutoStarted": true}),
            json!({"browserCardTurn": true}),
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
            "browserCardTurn": {"version": 1},
            "browser_card_turn": {"version": 1},
            "browserRequestOf": "job:00000000-0000-4000-8000-000000000001",
            "prompt_metadata": {"automaticRetry": {"version": 1}, "kept": 1},
            "promptMetadata": {"automatic_retry": {"version": 1}, "browserCardTurn": {"version": 1}},
            "details": {"automaticRetry": {"version": 1}, "browser_card_turn": {"version": 1}},
        });
        strip_system_turn_stamps(&mut metadata);
        assert_eq!(
            metadata,
            json!({
                "retryAutomatic": true,
                "browserRequestOf": "job:00000000-0000-4000-8000-000000000001",
                "prompt_metadata": {"kept": 1},
                "promptMetadata": {},
                "details": {},
            })
        );
    }

    #[test]
    fn a_card_claim_names_one_card_job() {
        let card = Uuid::new_v4();
        assert_eq!(
            browser_card_claim(&json!({ "browserRequestOf": format!(" job:{card} ") })),
            Some(card)
        );
        for metadata in [
            json!({ "browserRequestOf": format!("message:{card}") }),
            json!({ "browserRequestOf": card.to_string() }),
            json!({ "browserRequestOf": ["job:", card.to_string()] }),
            json!({ "browserAutoStarted": true }),
        ] {
            assert_eq!(browser_card_claim(&metadata), None, "{metadata}");
        }
    }

    // A card's browser turn costs nothing unless it does something in the
    // browser, so it may ask only what Octo asked: no word of the sender's
    // rides on it.
    #[test]
    fn only_the_cards_own_task_is_a_card_turn() {
        let task = "Open www.example.com and find the opening hours. Stop after reading them.";
        let fixtures: JsonValue =
            serde_json::from_str(include_str!("system_turns_fixtures.json")).expect("fixtures");
        let prefix = fixtures["browserCardContinuationPrefix"]
            .as_str()
            .expect("Studio's continuation prefix");
        assert_eq!(prefix, BROWSER_CARD_CONTINUATION_PREFIX);
        assert!(asks_only_the_card_task(&format!("{prefix}{task}"), task));
        assert!(asks_only_the_card_task(task, &format!("  {task}\n")));
        for words in [
            format!("{prefix}{task} Then summarize the page in full."),
            format!("Also write me a poem.\n\n{prefix}{task}"),
            format!("{prefix}Summarize the page in full."),
            "Summarize the page in full.".to_string(),
            prefix.to_string(),
        ] {
            assert!(!asks_only_the_card_task(&words, task), "{words}");
        }
        assert!(!asks_only_the_card_task(prefix, "  "));
    }

    #[test]
    fn written_files_come_from_applied_files_or_a_saved_path() {
        assert!(artifacts_wrote_files(&json!([
            {"kind": "apply/files", "files": [{"path": "sites/hello/index.html"}]}
        ])));
        assert!(artifacts_wrote_files(&json!([
            {"kind": "origin/apply", "metadata": {"paths": ["sites/hello/index.html"]}}
        ])));
        for artifacts in [
            json!([{"kind": "apply/files", "files": []}]),
            json!([{"kind": "origin/apply", "metadata": {"paths": []}}]),
            json!([{"kind": "codex/run-log", "files": [{"path": "x"}]}]),
            json!([]),
            json!(null),
        ] {
            assert!(!artifacts_wrote_files(&artifacts), "{artifacts}");
        }
    }

    // conversation_messages is large: the steps query narrows to the
    // project's rows first, through its index, as the tool update count does.
    #[test]
    fn the_steps_query_reads_only_its_projects_messages() {
        let sql = step_that_worked_sql();
        let filter = sql
            .split_once("from conversation_messages")
            .and_then(|(_, rest)| rest.split_once("where"))
            .map(|(_, filter)| filter.trim_start())
            .unwrap_or_default();
        assert!(filter.starts_with("project_id = $1"), "{sql}");
        assert!(sql.contains(STEP_FAILED_STATES), "{sql}");
        assert!(sql.contains(BROWSER_LOOK_TOOLS), "{sql}");
    }

    #[test]
    fn every_check_of_a_card_reads_only_its_conversation() {
        let subqueries = BROWSER_CARD_CHECKS_SQL
            .split(" from ")
            .skip(1)
            .collect::<Vec<_>>();
        assert!(!subqueries.is_empty());
        for subquery in subqueries {
            let filter = subquery
                .split_once("where")
                .map(|(_, filter)| filter.trim_start())
                .unwrap_or_default();
            assert!(
                filter.starts_with("card.conversation_id = $1")
                    || filter.starts_with("earlier.conversation_id = $1")
                    || filter.starts_with("job.id = $2 and job.conversation_id = $1"),
                "not narrowed to the conversation first: {subquery}"
            );
        }
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

    // agent_jobs has no index on run_id: a check that does not first narrow
    // to the conversation reads the whole table, inside the dispatch
    // transaction and under the conversation's dispatch fence.
    #[test]
    fn every_check_of_an_automatic_retry_reads_only_its_conversation() {
        let subqueries = AUTOMATIC_RETRY_CHECKS_SQL
            .split("select 1 from ")
            .skip(1)
            .collect::<Vec<_>>();
        assert_eq!(subqueries.len(), 3);
        for subquery in subqueries {
            let filter = subquery
                .split_once("where")
                .map(|(_, filter)| filter.trim_start())
                .unwrap_or_default();
            assert!(
                filter.starts_with("conversation_id = $1"),
                "not narrowed to the conversation first: {subquery}"
            );
        }
    }

    #[test]
    fn only_a_successful_turn_that_says_something_is_a_reply() {
        assert!(completion_is_a_reply(
            "succeeded",
            Some("Built the comparison page."),
            false
        ));
        assert!(!completion_is_a_reply("succeeded", Some("  "), false));
        assert!(!completion_is_a_reply("succeeded", None, false));
        // The decline word is a reply unless the controller swallows it.
        assert!(completion_is_a_reply(
            "succeeded",
            Some("NO_RESPONSE"),
            false
        ));
        assert!(!completion_is_a_reply(
            "succeeded",
            Some("NO_RESPONSE"),
            true
        ));
        for outcome in ["failed", "canceled", "expired"] {
            assert!(!completion_is_a_reply(
                outcome,
                Some("Partial answer"),
                false
            ));
        }
    }
}
