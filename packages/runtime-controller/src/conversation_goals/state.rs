use axum::{http::StatusCode, Json};
use chrono::Utc;
use serde_json::{json, Value};
use tokio_postgres::{types::Json as PgJson, Transaction};
use uuid::Uuid;

use super::policy::{apply_goal_update, normalize_goal, Goal, GoalStatus, GoalUpdate};
use crate::conversations::{load_conversation_record, ConversationRecord};
use crate::{internal_error, ApiError, AppState};

type StateResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

/// Client edits always replace the controller revision, including clear/pause.
/// A metadata patch unrelated to goals leaves the stored revision untouched.
pub(crate) fn prepare_client_metadata(metadata: &mut Value) {
    let Some(metadata) = metadata.as_object_mut() else {
        return;
    };
    metadata.remove("_goalController");
    let alias = metadata.remove("instafy_goal");
    if !metadata.contains_key("instafyGoal") {
        if let Some(goal) = alias {
            metadata.insert("instafyGoal".into(), goal);
        }
    }
    if metadata.contains_key("instafyGoal") {
        metadata.insert(
            "_goalController".into(),
            json!({"revision": Uuid::new_v4()}),
        );
    }
}

/// Compare under the conversation row lock. A retry carrying the same goal
/// snapshot must not invalidate a job admitted by the first request. An explicit
/// clear always fences old jobs, even if the goal is already absent.
pub(crate) fn preserve_unchanged_goal_revision(patch: &mut Value, existing: Option<&Value>) {
    let Some(existing) = existing else { return };
    let existing_goal = existing
        .get("instafyGoal")
        .or_else(|| existing.get("instafy_goal"));
    if uuid_at(existing, "/_goalController/revision").is_some()
        && patch
            .get("instafyGoal")
            .filter(|goal| !goal.is_null())
            .is_some_and(|goal| Some(goal) == existing_goal)
    {
        if let Some(patch) = patch.as_object_mut() {
            patch.remove("_goalController");
        }
    }
}

/// An explicit goal command is saved before its first dispatch. Reject a late
/// callback if a newer edit changed that saved goal. Check under the conversation
/// row lock after resolving idempotent retries; inline dispatch metadata cannot
/// overwrite the separately saved goal.
pub(crate) fn require_goal_command_snapshot(
    request_metadata: &Value,
    conversation_metadata: Option<&Value>,
) -> StateResult<()> {
    if request_metadata
        .pointer("/command/type")
        .and_then(Value::as_str)
        != Some("goal")
    {
        return Ok(());
    }
    let now = Utc::now().to_rfc3339();
    let requested = request_metadata
        .get("goal")
        .and_then(|value| normalize_goal(value, &now));
    let current = conversation_metadata
        .and_then(|metadata| {
            metadata
                .get("instafyGoal")
                .or_else(|| metadata.get("instafy_goal"))
        })
        .and_then(|value| normalize_goal(value, &now));
    if requested
        .as_ref()
        .is_none_or(|goal| goal.status != GoalStatus::Active)
        || requested != current
    {
        return Err(super::conflict(
            "The goal changed before this turn started. Resume the current goal to continue.",
        ));
    }
    Ok(())
}

fn uuid_at(value: &Value, pointer: &str) -> Option<Uuid> {
    value.pointer(pointer)?.as_str()?.parse().ok()
}

fn binding(payload: &Value) -> Option<(Uuid, Uuid)> {
    Some((
        uuid_at(payload, "/metadata/_controllerGoal/revision")?,
        uuid_at(payload, "/metadata/_controllerGoal/ownerUserId")?,
    ))
}

fn worker_or_early_lead(payload: &Value) -> bool {
    let metadata = &payload["metadata"];
    let plan = metadata
        .get("multiAgentPlan")
        .or_else(|| metadata.get("multi_agent_plan"));
    plan.and_then(|plan| plan.get("role"))
        .and_then(Value::as_str)
        == Some("worker")
        || crate::multi_agent_plan::job_payload_can_wake_plan_checkpoint(payload)
}

struct BoundGoal {
    revision: Uuid,
    owner: Uuid,
    metadata: Value,
    goal: Option<Goal>,
    job_status: String,
    planning_receipt: bool,
    user_turn: bool,
}

/// Callers already hold the source job lock. Lock only its owning conversation
/// here, in that order, so metadata edits and late runtime updates serialize.
async fn load_bound_goal(
    transaction: &Transaction<'_>,
    job_id: Uuid,
    payload: &Value,
    conversation_id: Uuid,
) -> StateResult<Option<BoundGoal>> {
    let Some((revision, owner)) = binding(payload) else {
        return Ok(None);
    };
    if worker_or_early_lead(payload) {
        return Ok(None);
    }
    let row = transaction
        .query_opt(
            "select c.metadata, p.user_id, j.payload, j.agent_role, j.status,
                    j.planning_receipt_state is not null as planning_receipt
         from agent_jobs j
         join prompts p on p.id = j.prompt_id and p.project_id = j.project_id
         join conversations c on c.id = j.conversation_id and c.project_id = j.project_id
         where j.id = $1 and c.id = $2
         for update of c",
            &[&job_id, &conversation_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load bound conversation goal: {error}"))
        })?;
    let Some(row) = row else { return Ok(None) };
    let source_payload: Value = row.get::<_, PgJson<Value>>("payload").0;
    let role: Option<String> = row.get("agent_role");
    let prompt_owner: Option<Uuid> = row.get("user_id");
    let metadata: Value = row
        .get::<_, Option<Value>>("metadata")
        .unwrap_or_else(|| json!({}));
    if binding(&source_payload) != Some((revision, owner))
        || prompt_owner != Some(owner)
        || role.as_deref() == Some("worker")
        || worker_or_early_lead(&source_payload)
        || uuid_at(&metadata, "/_goalController/revision") != Some(revision)
        || uuid_at(&metadata, "/_goalController/ownerUserId").is_some_and(|id| id != owner)
    {
        return Ok(None);
    }
    let raw_goal = metadata
        .get("instafyGoal")
        .or_else(|| metadata.get("instafy_goal"));
    let goal = raw_goal.and_then(|value| normalize_goal(value, &Utc::now().to_rfc3339()));
    // Malformed non-null goal state is not permission to create a replacement.
    if raw_goal.is_some_and(|value| !value.is_null()) && goal.is_none() {
        return Ok(None);
    }
    Ok(Some(BoundGoal {
        revision,
        owner,
        metadata,
        goal,
        job_status: row.get("status"),
        planning_receipt: row.get("planning_receipt"),
        user_turn: source_payload.pointer("/metadata/_controllerGoal/userTurn")
            == Some(&Value::Bool(true)),
    }))
}

async fn persist_goal(
    transaction: &Transaction<'_>,
    conversation_id: Uuid,
    mut metadata: Value,
    goal: Option<&Goal>,
) -> StateResult<ConversationRecord> {
    let map = metadata
        .as_object_mut()
        .expect("a bound goal has object metadata");
    map.remove("instafy_goal");
    map.insert(
        "instafyGoal".into(),
        serde_json::to_value(goal).map_err(|error| {
            internal_error(format!("failed to encode conversation goal: {error}"))
        })?,
    );
    transaction
        .execute(
            "update conversations set metadata = $2::jsonb, updated_at = now() where id = $1",
            &[&conversation_id, &PgJson(&metadata)],
        )
        .await
        .map_err(|error| internal_error(format!("failed to persist conversation goal: {error}")))?;
    load_conversation_record(transaction, &conversation_id).await
}

/// Only called for authenticated goal_update messages from a leased source job.
pub(crate) async fn apply_runtime_update(
    transaction: &Transaction<'_>,
    job_id: Uuid,
    payload: &Value,
    conversation_id: Uuid,
    metadata: &Value,
    content: &str,
) -> StateResult<Option<ConversationRecord>> {
    let Some(bound) = load_bound_goal(transaction, job_id, payload, conversation_id).await? else {
        return Ok(None);
    };
    if bound.job_status != "leased" {
        return Ok(None);
    }
    // Only a newly admitted human turn can create/resume an inactive goal.
    // Automatic continuations and team checkpoints cannot grant themselves this
    // authority by echoing a userTurn flag in their goal_update message.
    if !bound.user_turn
        && bound
            .goal
            .as_ref()
            .is_none_or(|goal| goal.status != GoalStatus::Active)
    {
        return Ok(None);
    }
    let now = Utc::now().to_rfc3339();
    let owner = bound.owner.to_string();
    match apply_goal_update(
        bound.goal.as_ref(),
        metadata,
        content,
        &Uuid::new_v4().to_string(),
        &now,
        Some(&owner),
    ) {
        GoalUpdate::Ignored => Ok(None),
        GoalUpdate::Set(goal) => {
            persist_goal(transaction, conversation_id, bound.metadata, Some(&goal))
                .await
                .map(Some)
        }
        GoalUpdate::Clear => persist_goal(transaction, conversation_id, bound.metadata, None)
            .await
            .map(Some),
    }
}

/// The completion transaction atomically closes a job and records its wakeup.
/// Planning receipts and provider retry requeues return before reaching this hook.
pub(crate) async fn settle_job(
    transaction: &Transaction<'_>,
    job_id: Uuid,
    payload: &Value,
    conversation_id: Uuid,
    outcome: &str,
) -> StateResult<Option<ConversationRecord>> {
    let Some(bound) = load_bound_goal(transaction, job_id, payload, conversation_id).await? else {
        return Ok(None);
    };
    let Some(mut goal) = bound.goal else {
        return Ok(None);
    };
    if goal.status != GoalStatus::Active {
        return Ok(None);
    }
    match (outcome, bound.job_status.as_str()) {
        ("succeeded", "completed") => {
            if bound.planning_receipt {
                return Ok(None);
            }
            transaction.execute(
                "insert into conversation_goal_continuations (source_job_id, conversation_id, goal_revision, owner_user_id)
                 values ($1, $2, $3, $4) on conflict (source_job_id) do nothing",
                &[&job_id, &conversation_id, &bound.revision, &bound.owner],
            ).await.map_err(|error| internal_error(format!("failed to record goal continuation: {error}")))?;
            Ok(None)
        }
        ("failed", "failed") | ("canceled", "canceled") | ("expired", "expired" | "failed") => {
            goal.status = if outcome == "failed" {
                GoalStatus::Blocked
            } else {
                GoalStatus::Canceled
            };
            goal.progress_summary = Some(format!("The goal run {outcome}."));
            goal.updated_at = Utc::now().to_rfc3339();
            goal.updated_by = Some(bound.owner.to_string());
            persist_goal(transaction, conversation_id, bound.metadata, Some(&goal))
                .await
                .map(Some)
        }
        _ => Ok(None),
    }
}

/// The Stop endpoint already authorized the human and locked its exact target
/// jobs. Pause the goal even if those jobs just finished and a wakeup is pending.
pub(crate) async fn pause_for_user_stop(
    transaction: &Transaction<'_>,
    conversation_id: Uuid,
    actor_id: Uuid,
) -> StateResult<Option<ConversationRecord>> {
    let row = transaction
        .query_one(
            "select metadata from conversations where id = $1 for update",
            &[&conversation_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock stopped goal: {error}")))?;
    let mut metadata = row
        .get::<_, Option<Value>>("metadata")
        .unwrap_or_else(|| json!({}));
    let now = Utc::now().to_rfc3339();
    let Some(mut goal) = metadata
        .get("instafyGoal")
        .or_else(|| metadata.get("instafy_goal"))
        .and_then(|goal| normalize_goal(goal, &now))
        .filter(|goal| goal.status == GoalStatus::Active)
    else {
        return Ok(None);
    };
    goal.status = GoalStatus::Paused;
    goal.updated_at = now;
    goal.updated_by = Some(actor_id.to_string());
    metadata["_goalController"] = json!({"revision": Uuid::new_v4(), "ownerUserId": actor_id});
    persist_goal(transaction, conversation_id, metadata, Some(&goal))
        .await
        .map(Some)
}

pub(crate) fn publish_update(state: &AppState, conversation: &ConversationRecord) {
    crate::publish_controller_event_with_conversation(
        &state.events,
        "conversation.updated",
        Some(conversation.project_id),
        conversation.session_id,
        Some(conversation.id),
        None,
        None,
        json!({
            "conversationId": conversation.id, "projectId": conversation.project_id,
            "sessionId": conversation.session_id, "createdBy": conversation.created_by,
            "metadata": crate::conversations::public_conversation_metadata(conversation.metadata.clone()),
            "visibility": conversation.visibility, "parentConversationId": conversation.parent_conversation_id,
            "rootConversationId": conversation.root_conversation_id, "threadKind": conversation.thread_kind,
            "lastMessageId": conversation.last_message_id, "lastMessageAt": conversation.last_message_at.map(|date| date.to_rfc3339()),
            "lastMessagePreview": conversation.last_message_preview,
            "createdAt": conversation.created_at.to_rfc3339(), "updatedAt": conversation.updated_at.to_rfc3339(),
        }),
    );
}

/// A team's final lead that will never start (its dispatch was refused, or the
/// lost-handoff recovery gave it up) leaves the goal its planning turn still
/// holds blocked, with `reason`: a planning receipt records no wakeup and the
/// goal sweep skips it, so nothing else would continue that goal. Blocked as a
/// failed run is in `settle_job`, and only while that turn holds it: its
/// binding is current, it is the newest source of its revision, and the goal
/// is active. The revision is kept, so a late lead, which inherits it, finds
/// the goal inactive. The planning job has ended and its binding is written
/// once, so its row is not locked; the conversation lock `load_bound_goal`
/// takes must be the caller's first row lock, before it writes any row that
/// references the conversation.
pub(crate) async fn block_for_unstarted_team_lead(
    transaction: &Transaction<'_>,
    planning_job_id: Uuid,
    conversation_id: Uuid,
    reason: &str,
) -> StateResult<Option<ConversationRecord>> {
    let Some(row) = transaction
        .query_opt(
            "select payload from agent_jobs where id = $1 and conversation_id = $2",
            &[&planning_job_id, &conversation_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load a team's planning turn: {error}"))
        })?
    else {
        return Ok(None);
    };
    let payload: Value = row.get::<_, PgJson<Value>>("payload").0;
    let Some(bound) =
        load_bound_goal(transaction, planning_job_id, &payload, conversation_id).await?
    else {
        return Ok(None);
    };
    let Some(mut goal) = bound.goal.filter(|goal| goal.status == GoalStatus::Active) else {
        return Ok(None);
    };
    if !bound.planning_receipt
        || bound.job_status != "completed"
        || !super::is_current_source(
            transaction,
            conversation_id,
            planning_job_id,
            bound.revision,
        )
        .await?
    {
        return Ok(None);
    }
    goal.status = GoalStatus::Blocked;
    goal.progress_summary = Some(reason.to_string());
    goal.updated_at = Utc::now().to_rfc3339();
    goal.updated_by = Some(bound.owner.to_string());
    persist_goal(transaction, conversation_id, bound.metadata, Some(&goal))
        .await
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_goal_edits_rotate_revision_and_alias_cannot_override_clear() {
        let forged = Uuid::new_v4();
        let mut metadata = json!({
            "instafy_goal": {"id":"goal", "objective":"Verify"},
            "_goalController": {"revision":forged, "ownerUserId":Uuid::new_v4()}
        });
        prepare_client_metadata(&mut metadata);
        let revision = uuid_at(&metadata, "/_goalController/revision").unwrap();
        assert_ne!(revision, forged);
        assert!(metadata.get("instafy_goal").is_none());
        assert_eq!(metadata["instafyGoal"]["id"], "goal");
        assert!(metadata["_goalController"].get("ownerUserId").is_none());

        metadata["instafy_goal"] = metadata["instafyGoal"].clone();
        metadata["instafyGoal"] = Value::Null;
        prepare_client_metadata(&mut metadata);
        assert_eq!(metadata["instafyGoal"], Value::Null);
        assert!(metadata.get("instafy_goal").is_none());
        assert_ne!(
            uuid_at(&metadata, "/_goalController/revision"),
            Some(revision)
        );
    }

    #[test]
    fn unrelated_client_patch_cannot_replace_controller_authority() {
        let mut patch = json!({"title":"New title", "_goalController":{"revision":Uuid::new_v4()}});
        prepare_client_metadata(&mut patch);
        assert_eq!(patch, json!({"title":"New title"}));
        let public = crate::conversations::public_conversation_metadata(Some(json!({
            "instafyGoal":{"id":"goal"}, "_goalController":{"revision":Uuid::new_v4()}
        })));
        assert_eq!(public, json!({"instafyGoal":{"id":"goal"}}));
    }

    #[test]
    fn identical_goal_snapshot_preserves_revision_but_clear_and_changes_do_not() {
        let existing = json!({"instafyGoal":{"id":"goal","status":"active"}, "_goalController":{"revision":Uuid::new_v4()}});
        let mut retry = json!({"instafy_goal":existing["instafyGoal"]});
        prepare_client_metadata(&mut retry);
        preserve_unchanged_goal_revision(&mut retry, Some(&existing));
        assert_eq!(retry, json!({"instafyGoal":existing["instafyGoal"]}));
        for goal in [Value::Null, json!({"id":"goal","status":"paused"})] {
            let mut patch = json!({"instafyGoal":goal});
            prepare_client_metadata(&mut patch);
            preserve_unchanged_goal_revision(&mut patch, Some(&existing));
            assert!(uuid_at(&patch, "/_goalController/revision").is_some());
        }
        let mut clear = json!({"instafyGoal":null});
        prepare_client_metadata(&mut clear);
        preserve_unchanged_goal_revision(
            &mut clear,
            Some(&json!({"instafyGoal":null,"_goalController":{"revision":Uuid::new_v4()}})),
        );
        assert!(uuid_at(&clear, "/_goalController/revision").is_some());
    }
}
