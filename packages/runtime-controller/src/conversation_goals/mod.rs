//! A goal outlives the browser and an individual agent job. Skills still decide
//! what useful work remains; this module owns delivery, admission and recovery.
mod policy;
mod request;
use request::{continuation_metadata, source_requires_explicit_resume};
pub(crate) mod state;
#[cfg(test)]
mod sweep_tests;
#[cfg(test)]
mod teammate_tests;
#[cfg(test)]
mod tests;

use axum::{http::StatusCode, Json};
use chrono::Utc;
use serde_json::{json, Value};
use tokio_postgres::{types::Json as PgJson, Transaction};
use uuid::Uuid;

use crate::{
    auth::RequestContext,
    conversations::ConversationRecord,
    dispatch::{DispatchPromptNormalized, DispatchPromptRequest},
    internal_error, ApiError, AppState,
};
use policy::{ContinuationDecision, GoalStatus, RunEvidence};

type Error = (StatusCode, Json<ApiError>);

pub(crate) fn conflict(message: &str) -> Error {
    (StatusCode::CONFLICT, Json(ApiError::new(message)))
}

pub(crate) fn strip_job_claims(metadata: &mut Value) {
    if let Some(map) = metadata.as_object_mut() {
        map.remove("_controllerGoal");
    }
}

pub(crate) fn is_legacy_automatic_continuation(metadata: &Value) -> bool {
    let continuation = metadata
        .get("goalContinuation")
        .or_else(|| metadata.get("goal_continuation"));
    continuation.is_some_and(|value| value.get("triggerRunId").is_some())
}

fn revision(metadata: &Value) -> Option<Uuid> {
    metadata
        .pointer("/_goalController/revision")?
        .as_str()?
        .parse()
        .ok()
}

fn goal(metadata: &Value) -> Option<policy::Goal> {
    policy::normalize_goal(
        metadata
            .get("instafyGoal")
            .or_else(|| metadata.get("instafy_goal"))?,
        &Utc::now().to_rfc3339(),
    )
}

/// Called after idempotent message lookup, under both the conversation row lock
/// and the dispatch fence, before any prompt/run/job is inserted.
pub(crate) async fn bind_dispatch(
    tx: &Transaction<'_>,
    context: &RequestContext,
    conversation: &ConversationRecord,
    request: &mut DispatchPromptNormalized,
) -> Result<(), Error> {
    let Some(owner) = context.user_id else {
        return Ok(());
    };
    let row = tx.query_one("select coalesce(metadata, '{}'::jsonb) as metadata from conversations where id=$1 for update", &[&conversation.id])
        .await.map_err(|e| internal_error(format!("load goal admission: {e}")))?;
    let mut metadata = row.get::<_, PgJson<Value>>("metadata").0;
    let current_revision = revision(&metadata);
    let binding = if let Some((source_job_id, claim_token)) = request.goal_wakeup {
        let row = tx.query_opt("select goal_revision, owner_user_id from conversation_goal_continuations where source_job_id=$1 and conversation_id=$2 and claim_token=$3 and status='claimed' and locked_until>now() for update", &[&source_job_id, &conversation.id, &claim_token])
            .await.map_err(|e| internal_error(format!("check goal wakeup: {e}")))?;
        let Some(row) = row else {
            return Err(conflict("Goal continuation claim is no longer current."));
        };
        let expected: Uuid = row.get("goal_revision");
        if current_revision != Some(expected)
            || row.get::<_, Uuid>("owner_user_id") != owner
            || !goal(&metadata).is_some_and(|g| g.status == GoalStatus::Active)
        {
            return Err(conflict(
                "The goal changed before its continuation started.",
            ));
        }
        if !is_current_source(tx, conversation.id, source_job_id, expected).await? {
            return Err(conflict("A newer goal turn superseded this continuation."));
        }
        ensure_idle(tx, conversation.id, source_job_id).await?;
        json!({"revision": expected, "ownerUserId": owner})
    } else if let Some(parent_job_id) = request.goal_parent_job_id {
        // This private field is only set by the final team-checkpoint dispatcher.
        let row = tx.query_opt("select j.payload, p.user_id from agent_jobs j join prompts p on p.id=j.prompt_id where j.id=$1 and j.conversation_id=$2", &[&parent_job_id, &conversation.id])
            .await.map_err(|e| internal_error(format!("load team goal binding: {e}")))?;
        let Some(row) = row else {
            return Ok(());
        };
        let payload = row.get::<_, PgJson<Value>>("payload").0;
        let Some(binding) = payload.pointer("/metadata/_controllerGoal") else {
            return Ok(());
        };
        if row.get::<_, Option<Uuid>>("user_id") != Some(owner)
            || binding
                .get("revision")
                .and_then(Value::as_str)
                .and_then(|s| s.parse().ok())
                != current_revision
        {
            return Ok(());
        }
        let mut binding = binding.clone();
        binding["userTurn"] = json!(false);
        if binding.get("rootJobId").is_none() {
            binding["rootJobId"] = json!(parent_job_id);
        }
        binding
    } else {
        // Access in a person's name is not a new instruction from them. Only
        // authenticated ingress stamps a trigger; internal dispatches (including
        // browser hand-backs) may synthesize the same access context. Checked
        // system turns sent by a client are also continuations, not fresh goal
        // instructions. Dispatch verifies these stamps before calling us.
        if context.is_service_role
            || context.scoped_claims.is_some()
            || request.delegating_job_id.is_some()
            || !request
                .trigger
                .as_ref()
                .is_some_and(|trigger| trigger.user_id == owner)
            || crate::system_turns::system_turn_of(&json!({"metadata": request.metadata})).is_some()
        {
            return Ok(());
        }
        state::require_goal_command_snapshot(&request.metadata, Some(&metadata))?;
        // A newer user turn supersedes every older automatic wakeup, even when
        // the goal's text did not change. Late agent messages cannot undo it.
        let next_revision = Uuid::new_v4();
        metadata["_goalController"] = json!({"revision":next_revision,"ownerUserId":owner});
        tx.execute(
            "update conversations set metadata=$2::jsonb where id=$1",
            &[&conversation.id, &PgJson(&metadata)],
        )
        .await
        .map_err(|e| internal_error(format!("bind goal revision: {e}")))?;
        json!({"revision":next_revision,"ownerUserId":owner,"userTurn":true})
    };
    request.metadata["_controllerGoal"] = binding;
    // The persisted goal, not a stale client's goal snapshot, governs this turn.
    if let Some(goal) = goal(&metadata) {
        request.metadata["goal"] = serde_json::to_value(goal).expect("goal serializes");
    } else if let Some(map) = request.metadata.as_object_mut() {
        map.remove("goal");
    }
    Ok(())
}

async fn is_current_source(
    tx: &Transaction<'_>,
    conversation_id: Uuid,
    source_job_id: Uuid,
    revision: Uuid,
) -> Result<bool, Error> {
    // Several selected agents may finish the same user turn. Only one source
    // may wake it; a subsequently admitted turn supersedes all older sources.
    let row = tx.query_one("select not exists(select 1 from agent_jobs newer join agent_jobs source on source.id=$2 where newer.conversation_id=$1 and newer.payload#>>'{metadata,_controllerGoal,revision}'=$3 and (newer.created_at,newer.id)>(source.created_at,source.id)) as current", &[&conversation_id,&source_job_id,&revision.to_string()])
        .await.map_err(|e|internal_error(format!("check current goal source: {e}")))?;
    Ok(row.get("current"))
}

async fn ensure_idle(
    tx: &Transaction<'_>,
    conversation_id: Uuid,
    source_job_id: Uuid,
) -> Result<(), Error> {
    let row=tx.query_one("select exists(select 1 from agent_jobs where conversation_id=$1 and status in ('queued','leased')) or exists(select 1 from agent_user_input_requests where conversation_id=$1 and status in ('pending','answered')) or exists(select 1 from conversation_send_queue where conversation_id=$1 and (status='queued' or (status='dispatched' and dispatched_run_id is null and dispatched_at>=now()-interval '10 minutes'))) as busy", &[&conversation_id])
        .await.map_err(|e| internal_error(format!("check goal conversation availability: {e}")))?;
    if row.get::<_, bool>("busy") {
        return Err(conflict("The conversation has work or user input waiting."));
    }
    // A final team checkpoint replaces the planner's completed job as the
    // continuation source. Never race its workers or its checkpoint dispatcher.
    let row = tx
        .query_one(
            "select planning_receipt_state is not null as delegated from agent_jobs where id=$1",
            &[&source_job_id],
        )
        .await
        .map_err(|e| internal_error(format!("check goal team handoff: {e}")))?;
    if row.get::<_, bool>("delegated") {
        return Err(conflict(
            "The goal is waiting for its team's final checkpoint.",
        ));
    }
    Ok(())
}

#[derive(Debug)]
pub(crate) struct Wakeup {
    pub(crate) source_job_id: Uuid,
    pub(crate) conversation_id: Uuid,
    pub(crate) goal_revision: Uuid,
    pub(crate) owner_user_id: Uuid,
    pub(crate) attempts: i32,
    pub(crate) claim_token: Uuid,
}

/// The queued job and the wakeup result commit together. Losing the HTTP result
/// or dying immediately after commit cannot leave an uncertain second send.
pub(crate) async fn record_dispatch(
    tx: &Transaction<'_>,
    wakeup: Option<(Uuid, Uuid)>,
    run_id: Uuid,
) -> Result<(), Error> {
    if let Some((source, claim)) = wakeup {
        tx.execute("update conversation_goal_continuations set status='dispatched',run_id=$3,locked_until=null,claim_token=null,updated_at=now() where source_job_id=$1 and claim_token=$2 and status='claimed'", &[&source,&claim,&run_id])
            .await.map_err(|e|internal_error(format!("record goal dispatch: {e}")))?;
    }
    Ok(())
}

pub(crate) async fn claim_due(tx: &Transaction<'_>) -> Result<Option<Wakeup>, Error> {
    claim(tx, None).await
}

async fn claim(tx: &Transaction<'_>, source: Option<Uuid>) -> Result<Option<Wakeup>, Error> {
    let token = Uuid::new_v4();
    let row=tx.query_opt("with candidate as (select source_job_id from conversation_goal_continuations where ($2::uuid is null or source_job_id=$2) and ((status='pending' and next_attempt_at<=now()) or (status='claimed' and locked_until<=now())) order by next_attempt_at,source_job_id for update skip locked limit 1) update conversation_goal_continuations w set status='claimed',claim_token=$1,locked_until=now()+interval '5 minutes',updated_at=now() from candidate c where w.source_job_id=c.source_job_id returning w.*", &[&token,&source])
        .await.map_err(|e| internal_error(format!("claim goal continuation: {e}")))?;
    Ok(row.map(|r| Wakeup {
        source_job_id: r.get("source_job_id"),
        conversation_id: r.get("conversation_id"),
        goal_revision: r.get("goal_revision"),
        owner_user_id: r.get("owner_user_id"),
        attempts: r.get("attempts"),
        claim_token: token,
    }))
}

/// Normal completions wake promptly; the periodic sweep is crash recovery.
pub(crate) fn wake_after_completion(app: AppState, source: Uuid) {
    tokio::spawn(async move {
        let result = async {
            let mut conn = app
                .pool
                .get()
                .await
                .map_err(|e| internal_error(format!("goal wake connection: {e}")))?;
            let tx = conn
                .transaction()
                .await
                .map_err(|e| internal_error(format!("goal wake transaction: {e}")))?;
            let wake = claim(&tx, Some(source)).await?;
            tx.commit()
                .await
                .map_err(|e| internal_error(format!("commit goal wake: {e}")))?;
            drop(conn);
            if let Some(wake) = wake {
                process_wakeup(&app, &wake).await?;
            }
            Ok::<_, Error>(())
        }
        .await;
        if let Err(error) = result {
            tracing::warn!(source_job_id=%source,error=%error.1.0.message,"goal continuation wake failed; recovery will retry");
        }
    });
}

pub(crate) fn spawn_scheduler(app: AppState) {
    tokio::spawn(async move {
        let mut ticks =
            crate::background_loops::staggered_interval(crate::background_loops::GOAL_CONTINUATION);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticks.tick().await;
            if let Err(error) = sweep(&app).await {
                tracing::warn!(error=%error.1.0.message,"goal continuation recovery failed");
            }
        }
    });
}

async fn sweep(app: &AppState) -> Result<(), Error> {
    // Covers non-agent terminal paths (cancellation/expiry) and a process dying
    // between settlement and an immediate wake. Only newly bound jobs qualify.
    settle_ended_jobs(app).await?;
    // One tick does bounded work, and never holds a pool slot across dispatch.
    for _ in 0..8 {
        let mut conn = app
            .pool
            .get()
            .await
            .map_err(|e| internal_error(format!("goal claim connection: {e}")))?;
        let tx = conn
            .transaction()
            .await
            .map_err(|e| internal_error(format!("goal claim transaction: {e}")))?;
        let wake = claim_due(&tx).await?;
        tx.commit()
            .await
            .map_err(|e| internal_error(format!("commit goal claim: {e}")))?;
        drop(conn);
        let Some(wake) = wake else {
            break;
        };
        process_wakeup(app, &wake).await?;
    }
    Ok(())
}

/// Settles the goals of bound jobs that ended without settling them.
///
/// Each job is settled in a transaction of its own that commits before the
/// next, so the sweep never holds one conversation while it locks another. A
/// message written into a thread updates the thread and then its root, and
/// some writers update several conversations in one transaction, so holding
/// one while waiting for the next deadlocked with them.
///
/// The job is locked before its conversation, the order a completion and a
/// Stop take them, and the sweep waits for neither. Waiting for the
/// conversation while it held the job would deadlock with a team delete,
/// which removes a space's conversations before their jobs, and waiting for
/// the job would stall the tick behind whoever holds it. A job or
/// conversation another transaction holds is left for the next tick. A job
/// that fails to settle is logged, and the tick goes on to the next job.
///
/// A job the sweep leaves unsettled is still one it looks for. settle_job
/// leaves some goals as they are, such as one without an id or one a worker's
/// turn is bound to, and a job may fail to settle on every try. A tick takes
/// sixteen jobs, so sixteen of those first in line would keep it from every
/// other job. The sweep records each job it looked at and left, and takes
/// the jobs it has never looked at first, in the order they ended, and then
/// the ones it looked at longest ago. A busy job is not recorded, so it keeps
/// its place for the next tick.
async fn settle_ended_jobs(app: &AppState) -> Result<(), Error> {
    let mut conn = app
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("goal recovery connection: {e}")))?;
    let candidates = format!(
        "select j.id from agent_jobs j
         join conversations c on c.id = j.conversation_id
         left join conversation_goal_recovery_checks r on r.job_id = j.id
         where {UNSETTLED_JOB}
         order by r.checked_at nulls first, j.completed_at, j.id
         limit 16"
    );
    let jobs = conn
        .query(candidates.as_str(), &[])
        .await
        .map_err(|e| recovery_failure("recover settled goals", e))?;
    for job in jobs {
        let job_id: Uuid = job.get("id");
        match settle_ended_job(&mut conn, job_id).await {
            Ok(Some(updated)) => state::publish_update(app, &updated),
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(source_job_id=%job_id,error=%error.1.0.message,"goal recovery could not settle a job; a later tick retries");
            }
        }
    }
    Ok(())
}

/// The jobs [`settle_ended_jobs`] looks for, with `j` the job and `c` its
/// conversation: a job that ended bound to the current revision of an active
/// goal, that no wakeup was recorded for, and that is not a completed
/// planning receipt, whose team's final checkpoint carries the goal on.
const UNSETTLED_JOB: &str = "j.status not in ('queued', 'leased')
    and j.payload #>> '{metadata,_controllerGoal,revision}'
        = c.metadata #>> '{_goalController,revision}'
    and c.metadata #>> '{instafyGoal,status}' = 'active'
    and (j.planning_receipt_state is null or j.status <> 'completed')
    and not exists (
        select 1 from conversation_goal_continuations w where w.source_job_id = j.id
    )";

/// Settles one job for [`settle_ended_jobs`], or leaves it when another
/// transaction holds the job or its conversation. The job may have changed
/// since it was picked, so it is read again under its lock. A job it leaves
/// unsettled otherwise, or that fails to settle, is recorded as looked at.
async fn settle_ended_job(
    db: &mut tokio_postgres::Client,
    job_id: Uuid,
) -> Result<Option<ConversationRecord>, Error> {
    let mut tx = db
        .transaction()
        .await
        .map_err(|e| recovery_failure("goal recovery transaction", e))?;
    let Some(job) = tx
        .query_opt(
            "select payload, conversation_id, outcome, status from agent_jobs
             where id = $1 and status not in ('queued', 'leased')
               and conversation_id is not null
             for no key update skip locked",
            &[&job_id],
        )
        .await
        .map_err(|e| recovery_failure("lock recovered goal job", e))?
    else {
        return Ok(None);
    };
    let conversation_id: Uuid = job.get("conversation_id");
    // Taken here, the lock settle_job takes, so that it finds the lock held
    // instead of waiting for it.
    let conversation = tx
        .query_opt(
            "select 1 from conversations where id = $1 for no key update skip locked",
            &[&conversation_id],
        )
        .await
        .map_err(|e| recovery_failure("lock recovered goal conversation", e))?;
    if conversation.is_none() {
        return Ok(None);
    }
    let status: String = job.get("status");
    let fallback = match status.as_str() {
        "completed" => "succeeded",
        "canceled" => "canceled",
        "expired" => "expired",
        _ => "failed",
    };
    let outcome: Option<String> = job.get("outcome");
    // In a savepoint, so that a job that fails to settle is still recorded
    // under the locks taken above.
    let attempt = tx
        .transaction()
        .await
        .map_err(|e| recovery_failure("goal recovery savepoint", e))?;
    let settled = state::settle_job(
        &attempt,
        job_id,
        &job.get::<_, PgJson<Value>>("payload").0,
        conversation_id,
        outcome.as_deref().unwrap_or(fallback),
    )
    .await;
    let updated = match settled {
        Ok(updated) => {
            attempt
                .commit()
                .await
                .map_err(|e| recovery_failure("release goal recovery savepoint", e))?;
            updated
        }
        Err(error) => {
            attempt
                .rollback()
                .await
                .map_err(|e| recovery_failure("roll back goal recovery savepoint", e))?;
            record_check(&tx, job_id).await?;
            tx.commit()
                .await
                .map_err(|e| recovery_failure("commit goal recovery check", e))?;
            return Err(error);
        }
    };
    // settle_job returns the conversation only when it blocked or canceled
    // the goal. Otherwise it recorded a wakeup or left the job as it was, and
    // a job left as it was would be taken again.
    if updated.is_none() && is_unsettled(&tx, job_id).await? {
        record_check(&tx, job_id).await?;
    }
    tx.commit()
        .await
        .map_err(|e| recovery_failure("commit recovered goal", e))?;
    Ok(updated)
}

/// Whether `job_id` is still a job [`settle_ended_jobs`] looks for.
async fn is_unsettled(tx: &Transaction<'_>, job_id: Uuid) -> Result<bool, Error> {
    let unsettled = format!(
        "select exists (
             select 1 from agent_jobs j join conversations c on c.id = j.conversation_id
             where j.id = $1 and {UNSETTLED_JOB}
         )"
    );
    tx.query_one(unsettled.as_str(), &[&job_id])
        .await
        .map(|row| row.get(0))
        .map_err(|e| recovery_failure("check recovered goal", e))
}

/// Records that [`settle_ended_jobs`] looked at `job_id` and left it, which
/// puts it behind the jobs it has not looked at since.
async fn record_check(tx: &Transaction<'_>, job_id: Uuid) -> Result<(), Error> {
    tx.execute(
        "insert into conversation_goal_recovery_checks (job_id, checked_at)
         values ($1, now())
         on conflict (job_id) do update set checked_at = excluded.checked_at",
        &[&job_id],
    )
    .await
    .map_err(|e| recovery_failure("record goal recovery check", e))?;
    Ok(())
}

/// The failure of one of the statements of [`settle_ended_jobs`], with the
/// cause Postgres reported.
fn recovery_failure(context: &str, error: tokio_postgres::Error) -> Error {
    internal_error(format!(
        "{context}: {}",
        crate::errors::describe_db_error(&error)
    ))
}

async fn process_wakeup(app: &AppState, wake: &Wakeup) -> Result<(), Error> {
    let prepared = prepare_request(app, wake).await?;
    let Some(value) = prepared else {
        return Ok(());
    };
    let payload: DispatchPromptRequest = serde_json::from_value(value)
        .map_err(|e| internal_error(format!("decode goal dispatch: {e}")))?;
    let mut request = crate::dispatch::normalize_dispatch_request(payload)?;
    request.goal_wakeup = Some((wake.source_job_id, wake.claim_token));
    request.expected_lane_idle = true;
    let context = RequestContext {
        user_id: Some(wake.owner_user_id),
        is_service_role: false,
        scoped_claims: None,
    };
    let result = crate::dispatch::process_dispatch_prompt(app, &context, request).await;
    let (status, run_id, error, failed_attempt) = match result {
        Ok(response) if response.run_id.is_some() => ("dispatched", response.run_id, None, false),
        Ok(_) => (
            "blocked",
            None,
            Some(
                "Goal continuation could not start under the current conversation permissions."
                    .to_string(),
            ),
            false,
        ),
        Err((StatusCode::CONFLICT, _)) => ("pending", None, None, false),
        Err((status, Json(error))) => {
            let retry = status.is_server_error() && wake.attempts < 2;
            (
                if retry { "pending" } else { "blocked" },
                None,
                Some(error.message),
                true,
            )
        }
    };
    let mut conn = app
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("finish goal connection: {e}")))?;
    let tx = conn
        .transaction()
        .await
        .map_err(|e| internal_error(format!("finish goal transaction: {e}")))?;
    // Match dispatch/metadata-update lock order: conversation before wakeup.
    tx.query_opt(
        "select id from conversations where id=$1 for update",
        &[&wake.conversation_id],
    )
    .await
    .map_err(|e| internal_error(format!("lock goal settlement: {e}")))?;
    let changed=tx.execute("update conversation_goal_continuations set status=$3,run_id=$4,error=$5,attempts=attempts+$6,next_attempt_at=now()+interval '30 seconds',locked_until=null,claim_token=null,updated_at=now() where source_job_id=$1 and claim_token=$2 and status='claimed'", &[&wake.source_job_id,&wake.claim_token,&status,&run_id,&error,&i32::from(failed_attempt)])
        .await.map_err(|e|internal_error(format!("finish goal wakeup: {e}")))?;
    let update = if changed > 0 && status == "blocked" {
        block_goal(
            &tx,
            wake,
            error
                .as_deref()
                .unwrap_or("Goal continuation could not start."),
        )
        .await?
    } else {
        None
    };
    tx.commit()
        .await
        .map_err(|e| internal_error(format!("commit goal wakeup: {e}")))?;
    drop(conn);
    if let Some(update) = update {
        state::publish_update(app, &update);
    }
    Ok(())
}

async fn block_goal(
    tx: &Transaction<'_>,
    wake: &Wakeup,
    reason: &str,
) -> Result<Option<ConversationRecord>, Error> {
    let row=tx.query_one("select coalesce(metadata,'{}'::jsonb) as metadata from conversations where id=$1 for update", &[&wake.conversation_id])
        .await.map_err(|e|internal_error(format!("load blocked goal: {e}")))?;
    let mut metadata = row.get::<_, PgJson<Value>>("metadata").0;
    let Some(mut goal) = goal(&metadata) else {
        return Ok(None);
    };
    if revision(&metadata) != Some(wake.goal_revision) || goal.status != GoalStatus::Active {
        return Ok(None);
    }
    goal.status = GoalStatus::Blocked;
    goal.progress_summary = Some(reason.into());
    goal.updated_at = Utc::now().to_rfc3339();
    metadata["instafyGoal"] = serde_json::to_value(goal).expect("goal serializes");
    tx.execute(
        "update conversations set metadata=$2::jsonb,updated_at=now() where id=$1",
        &[&wake.conversation_id, &PgJson(metadata)],
    )
    .await
    .map_err(|e| internal_error(format!("block goal: {e}")))?;
    crate::conversations::load_conversation_record(tx, &wake.conversation_id)
        .await
        .map(Some)
}

async fn prepare_request(app: &AppState, wake: &Wakeup) -> Result<Option<Value>, Error> {
    let mut conn = app
        .pool
        .get()
        .await
        .map_err(|e| internal_error(format!("prepare goal connection: {e}")))?;
    let tx = conn
        .transaction()
        .await
        .map_err(|e| internal_error(format!("prepare goal transaction: {e}")))?;
    // Lock conversation first, like normal dispatch and explicit goal edits.
    let row=tx.query_opt("select coalesce(metadata,'{}'::jsonb) as metadata from conversations where id=$1 for update", &[&wake.conversation_id])
        .await.map_err(|e|internal_error(format!("load continuation goal: {e}")))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let metadata = row.get::<_, PgJson<Value>>("metadata").0;
    let row=tx.query_opt("select w.request,j.payload,j.project_id,j.session_id,j.run_id,j.target_runtime_id,j.planning_receipt_state from conversation_goal_continuations w join agent_jobs j on j.id=w.source_job_id where w.source_job_id=$1 and w.claim_token=$2 and w.status='claimed' for update of w", &[&wake.source_job_id,&wake.claim_token])
        .await.map_err(|e|internal_error(format!("load goal source: {e}")))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let active = goal(&metadata).filter(|g| g.status == GoalStatus::Active);
    if revision(&metadata) != Some(wake.goal_revision)
        || active.is_none()
        || !is_current_source(
            &tx,
            wake.conversation_id,
            wake.source_job_id,
            wake.goal_revision,
        )
        .await?
    {
        tx.execute("update conversation_goal_continuations set status='canceled',locked_until=null,claim_token=null,updated_at=now() where source_job_id=$1 and claim_token=$2", &[&wake.source_job_id,&wake.claim_token]).await.map_err(|e|internal_error(format!("cancel stale goal wakeup: {e}")))?;
        tx.commit()
            .await
            .map_err(|e| internal_error(format!("commit stale goal wakeup: {e}")))?;
        return Ok(None);
    }
    let goal = active.expect("active goal checked");
    // Preserve the exact prompt across an uncertain dispatch outcome. Its
    // stable clientMessageId lets ordinary dispatch return an already-made run.
    if let Some(request) = row.get::<_, Option<PgJson<Value>>>("request") {
        return Ok(Some(request.0));
    }
    if let Err(error) = ensure_idle(&tx, wake.conversation_id, wake.source_job_id).await {
        if error.0 != StatusCode::CONFLICT {
            return Err(error);
        }
        tx.execute("update conversation_goal_continuations set status='pending',next_attempt_at=now()+interval '30 seconds',locked_until=null,claim_token=null where source_job_id=$1 and claim_token=$2", &[&wake.source_job_id,&wake.claim_token]).await.map_err(|e|internal_error(format!("defer busy goal: {e}")))?;
        tx.commit()
            .await
            .map_err(|e| internal_error(format!("commit deferred goal: {e}")))?;
        return Ok(None);
    }
    let rows=tx.query("select j.payload,j.run_id,(select m.content from conversation_messages m where m.run_id=j.run_id and m.role='assistant' and coalesce(m.metadata->>'messageType','') not in ('goal_update','token_usage','reasoning','status','command_execution','mcp_tool_call','error','runtime_alert') order by m.created_at desc limit 1) as reply, exists(select 1 from conversation_messages m where m.run_id=j.run_id and (m.metadata->>'messageType' in ('command_execution','mcp_tool_call','file_change') or m.metadata->>'kind' in ('command_execution','mcp_tool_call','file_change'))) as activity from agent_jobs j where j.conversation_id=$1 and (j.payload#>>'{metadata,goal,id}'=$2 or j.payload#>>'{metadata,_controllerGoal,revision}'=$3) and j.status='completed' and j.planning_receipt_state is null order by j.created_at desc,j.id desc limit 101", &[&wake.conversation_id,&goal.id,&wake.goal_revision.to_string()])
        .await.map_err(|e|internal_error(format!("load goal evidence: {e}")))?;
    let recent: Vec<_> = rows
        .iter()
        .rev()
        .map(|r| {
            let p = r.get::<_, PgJson<Value>>("payload").0;
            RunEvidence {
                assistant_text: r.get("reply"),
                has_activity: r.get("activity"),
                turn: p
                    .pointer("/metadata/goalContinuation/turn")
                    .and_then(Value::as_u64)
                    .and_then(|v| v.try_into().ok()),
            }
        })
        .collect();
    let count=tx.query_one("select coalesce(max(case when jsonb_typeof(j.payload#>'{metadata,goalContinuation,turn}')='number' then greatest(0,least(100,(j.payload#>>'{metadata,goalContinuation,turn}')::numeric))::bigint else 0 end),0)::bigint as count from agent_jobs j where j.conversation_id=$1 and (j.payload#>>'{metadata,goal,id}'=$2 or j.payload#>>'{metadata,_controllerGoal,revision}'=$3::text)", &[&wake.conversation_id,&goal.id,&wake.goal_revision.to_string()])
        .await.map_err(|e|internal_error(format!("count goal turns: {e}")))?.get::<_,i64>("count").max(0) as u32;
    let (next_turn, warning) = match policy::decide_continuation(&goal, count, &recent) {
        ContinuationDecision::Continue { next_turn, warning } => (next_turn, warning),
        ContinuationDecision::Stop { summary, .. } => {
            let update = block_goal(&tx, wake, summary).await?;
            tx.execute("update conversation_goal_continuations set status='blocked',error=$2,claim_token=null,locked_until=null where source_job_id=$1", &[&wake.source_job_id,&summary]).await.map_err(|e|internal_error(format!("stop goal wakeup: {e}")))?;
            tx.commit()
                .await
                .map_err(|e| internal_error(format!("commit goal stop: {e}")))?;
            drop(conn);
            if let Some(update) = update {
                state::publish_update(app, &update);
            }
            return Ok(None);
        }
    };
    let source = row.get::<_, PgJson<Value>>("payload").0;
    let (settings, runtime_id) = if let Some(root) = source
        .pointer("/metadata/_controllerGoal/rootJobId")
        .and_then(Value::as_str)
        .and_then(|v| v.parse::<Uuid>().ok())
    {
        let root=tx.query_one("select payload,target_runtime_id from agent_jobs where id=$1 and conversation_id=$2", &[&root,&wake.conversation_id]).await.map_err(|e|internal_error(format!("load original goal settings: {e}")))?;
        (
            root.get::<_, PgJson<Value>>("payload").0,
            root.get::<_, Option<Uuid>>("target_runtime_id"),
        )
    } else {
        (source, row.get::<_, Option<Uuid>>("target_runtime_id"))
    };
    if source_requires_explicit_resume(&settings["metadata"]) {
        let reason = "This goal needs browser control. Resume it from the browser to choose the current page and permissions.";
        let update = block_goal(&tx, wake, reason).await?;
        tx.execute("update conversation_goal_continuations set status='blocked',error=$2,claim_token=null,locked_until=null where source_job_id=$1", &[&wake.source_job_id,&reason]).await.map_err(|e|internal_error(format!("stop browser goal wakeup: {e}")))?;
        tx.commit()
            .await
            .map_err(|e| internal_error(format!("commit browser goal stop: {e}")))?;
        drop(conn);
        if let Some(update) = update {
            state::publish_update(app, &update);
        }
        return Ok(None);
    }
    let prompt = policy::build_continuation_prompt(&goal, next_turn, &recent, warning);
    let mut next_metadata = continuation_metadata(&settings["metadata"]);
    next_metadata["goal"] = serde_json::to_value(&goal).expect("goal serializes");
    next_metadata["goalContinuation"] = json!({"goalId":goal.id,"triggerRunId":row.get::<_,Option<Uuid>>("run_id"),"turn":next_turn,"source":"controller"});
    next_metadata["clientMessageId"] = json!(format!(
        "goal-continuation:{}:{}",
        goal.id, wake.source_job_id
    ));
    let request = json!({"projectId":row.get::<_,Uuid>("project_id"),"sessionId":row.get::<_,Option<Uuid>>("session_id"),"conversationId":wake.conversation_id,"promptText":prompt,"metadata":next_metadata,"toolLimits":settings.get("tool_limits"),"runtimeId":runtime_id,"preferRuntime":false,"intent":"feature"});
    tx.execute("update conversation_goal_continuations set request=$3::jsonb where source_job_id=$1 and claim_token=$2", &[&wake.source_job_id,&wake.claim_token,&PgJson(&request)]).await.map_err(|e|internal_error(format!("save goal dispatch: {e}")))?;
    tx.commit()
        .await
        .map_err(|e| internal_error(format!("commit goal dispatch: {e}")))?;
    Ok(Some(request))
}
