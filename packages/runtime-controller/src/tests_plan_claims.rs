#![cfg(test)]

// Who says a job belongs to a team's plan, on the migrated database: only the
// controller. A member's send, a runtime job token's (which acts as the person
// its job is for) and a queued send drop every `multiAgentPlan` they carry, so
// their jobs have no `parent_job_id`, `plan_group_id` or `agent_role` for the
// team's checkpoints or its lost lead's recovery to trust. The controller's own
// plan dispatches keep theirs. Requires `TEST_DATABASE_URL` like the tests in
// `tests.rs`.

use axum::Json;
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use uuid::Uuid;

use crate::auth::RequestContext;
use crate::tests_provider_space::{
    dispatch_directly, normalized, person, person_with, with_space, Harness,
};

/// How `job` was queued: its plan hierarchy, its metadata and the metadata of
/// the person's message that started it.
struct Queued {
    parent_job_id: Option<Uuid>,
    plan_group_id: Option<Uuid>,
    agent_role: Option<String>,
    metadata: JsonValue,
    message: Option<JsonValue>,
}

async fn queued(harness: &Harness, job: Uuid) -> anyhow::Result<Queued> {
    let row = harness
        .pool
        .get()
        .await?
        .query_one(
            "select j.parent_job_id, j.plan_group_id, j.agent_role, j.payload -> 'metadata',
                    (select m.metadata from conversation_messages m
                      where m.run_id = j.run_id and m.role = 'user'
                      order by m.created_at limit 1)
               from agent_jobs j where j.id = $1",
            &[&job],
        )
        .await?;
    Ok(Queued {
        parent_job_id: row.get(0),
        plan_group_id: row.get(1),
        agent_role: row.get(2),
        metadata: row.get::<_, PgJson<JsonValue>>(3).0,
        message: row
            .get::<_, Option<PgJson<JsonValue>>>(4)
            .map(|value| value.0),
    })
}

/// Whether `value` claims a plan anywhere in it.
fn claims_a_plan(value: &JsonValue) -> bool {
    match value {
        JsonValue::Object(map) => map.iter().any(|(key, value)| {
            matches!(key.as_str(), "multiAgentPlan" | "multi_agent_plan") || claims_a_plan(value)
        }),
        JsonValue::Array(items) => items.iter().any(claims_a_plan),
        _ => false,
    }
}

/// `job`, which `sender` sent claiming a plan, is no plan job, and neither its
/// metadata nor its message keeps a copy of the claim.
async fn assert_in_no_plan(harness: &Harness, job: Uuid, sender: &str) -> anyhow::Result<()> {
    let queued = queued(harness, job).await?;
    assert_eq!(
        (
            queued.parent_job_id,
            queued.plan_group_id,
            queued.agent_role.as_deref()
        ),
        (None, None, None),
        "{sender}"
    );
    assert!(
        !claims_a_plan(&queued.metadata),
        "{sender}: {}",
        queued.metadata
    );
    if let Some(message) = queued.message {
        assert!(!claims_a_plan(&message), "{sender}: {message}");
    }
    Ok(())
}

/// A member's send cannot put its job in a team: not as a lead, which the
/// team's lost lead's recovery would read as led, and whose `parentJobId` would
/// make a new turn pass for an earlier one's, nor as any other plan job. Nor can
/// a runtime job token's send or a queued send. The same claim from the
/// controller's own lead dispatch keeps its job's hierarchy, and a plan the
/// member's turn really posts dispatches its workers with theirs.
#[tokio::test]
async fn only_the_controller_puts_a_job_in_a_teams_plan() -> anyhow::Result<()> {
    with_space("plan-claims", false, |harness| async move {
        let space = &harness.space;
        // An earlier turn of the owner's, which the forged lead names as its parent.
        let earlier = harness.send(space.owner, space.log, person()).await?;
        let group = Uuid::new_v4();
        let claim = json!({
            "groupId": group,
            "role": "lead_continuation",
            "parentJobId": earlier.id,
        });
        let forged = person_with(json!({
            "multiAgentPlan": claim,
            "multi_agent_plan": claim,
            "details": { "multiAgentPlan": claim },
            "prompt_metadata": {
                "multi_agent_plan": claim,
                "details": { "multiAgentPlan": claim },
            },
            "promptMetadata": { "multiAgentPlan": claim },
        }));

        let members_turn = harness
            .send(space.member, space.log, forged.clone())
            .await?;
        assert!(
            queued(&harness, members_turn.id).await?.message.is_some(),
            "the member's message is recorded"
        );
        assert_in_no_plan(&harness, members_turn.id, "member").await?;

        // A runtime's job token acts as the person its job is for, not as the controller.
        let leased = harness.lease(space.runtime).await?;
        let job_token = leased["controller_token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("no job token: {leased}"))?
            .to_string();
        let tokens_turn = harness
            .send_as(&job_token, space.log, forged.clone())
            .await?;
        assert_in_no_plan(&harness, tokens_turn.id, "job token").await?;

        // The controller's lead dispatch sends that claim, on the member's
        // behalf (`dispatch_lead_continuation`), and its job keeps it.
        let mut request = normalized(space, space.log)?;
        request.metadata["multiAgentPlan"] = claim.clone();
        let lead = dispatch_directly(
            &harness,
            RequestContext {
                user_id: Some(space.member),
                is_service_role: true,
                scoped_claims: None,
            },
            request,
        )
        .await?;
        let lead = queued(&harness, lead.id).await?;
        assert_eq!(lead.parent_job_id, Some(earlier.id));
        assert_eq!(lead.plan_group_id, Some(group));
        assert_eq!(lead.agent_role.as_deref(), Some("lead_continuation"));
        assert_eq!(lead.metadata["multiAgentPlan"]["groupId"], json!(group));
        assert_eq!(
            lead.metadata["multiAgentPlan"]["parentJobId"],
            json!(earlier.id)
        );

        // A plan the member's turn really posts: its runtime sends the plan as
        // the turn's message, and the controller dispatches the workers.
        let row = harness
            .pool
            .get()
            .await?
            .query_one(
                "select payload, run_id from agent_jobs where id = $1",
                &[&members_turn.id],
            )
            .await?;
        let payload = row.get::<_, PgJson<JsonValue>>(0).0;
        let message = json!({ "messageType": "multi_agent_plan", "details": {
            "mode": "read_only",
            "agents": [{ "handle": "helper", "prompt": "Read how the door's hinges are fixed." }],
            "lead": { "leadHandle": "helper", "continuationPrompt": "Report what was found." },
        }});
        let handled = Box::pin(
            crate::multi_agent_plan::maybe_execute_multi_agent_plan_message(
                &harness.state,
                &payload,
                members_turn.id,
                row.get(1),
                &message,
                "A helper will read the hinges.",
                None,
                None,
            ),
        )
        .await
        .map_err(|(status, Json(error))| anyhow::anyhow!("plan: {status} {}", error.message))?;
        assert!(handled, "the plan message was handled");
        let workers = harness
            .pool
            .get()
            .await?
            .query(
                "select id from agent_jobs where parent_job_id = $1",
                &[&members_turn.id],
            )
            .await?;
        assert_eq!(workers.len(), 1, "one worker per lane");
        let worker = queued(&harness, workers[0].get(0)).await?;
        assert_eq!(worker.parent_job_id, Some(members_turn.id));
        assert_eq!(worker.agent_role.as_deref(), Some("worker"));
        let worker_group = worker.plan_group_id.expect("the worker's group");
        assert_ne!(worker_group, group, "the controller picks the group");
        assert_eq!(
            worker.metadata["multiAgentPlan"]["groupId"],
            json!(worker_group)
        );

        // A queued send goes out later, still as the person who queued it.
        let entry = harness.queue(space.member, forged).await?;
        let queued_turn = harness.drain(entry).await?;
        assert_in_no_plan(&harness, queued_turn.id, "queued send").await?;
        Ok(())
    })
    .await
}
