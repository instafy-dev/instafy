//! The face each AI without a profile wears in a chat (docs/Brand.md, "Octo's
//! hatchlings"). Right after dispatch resolves its targets, under the
//! conversation's dispatch fence, every target that is neither a saved agent
//! nor Octo gets `hatchling:<n>` as its avatar seed. Its runs, jobs and every
//! later message and Home row carry that seed in `metadata.agent.avatarSeed`,
//! so no surface works a face out again.
//!
//! [`allocate_faces`] decides. A face belongs to a persona: a handle in one
//! root conversation, so a thread shares its parent's faces and an AI asked
//! again later gets its face back. This module reads what the allocator needs
//! in one statement over the root's subtree, under the root's face lock.
//!
//! Lock order. A dispatch into the root already holds the root's row
//! (`ensure_conversation_record` locks its conversation for update); a
//! thread's dispatch locks the root's row here, after its own, as recording a
//! message in a thread bumps the root after the thread. Only then does either
//! take the face lock, so dispatches that allocate in one root wait for one
//! another on the root's row and never while holding the face lock. Nothing
//! that holds the face lock takes a conversation's dispatch fence or a plan
//! group's checkpoint lock.
//!
//! A face only dresses an AI, so nothing here can lose a dispatch. Its reads
//! and locks run in a savepoint: when one fails (the wait for the root's row
//! picked as a deadlock's victim, say), rolling the savepoint back releases
//! what it locked, and an AI left without a face wears its handle's, as it did
//! before the controller stamped faces.

use runtime_contracts::agent_face::{
    allocate_faces, hatchling_seed, is_octo_handle, AgentFaceIdentity, AgentSighting, FaceLane,
};
use tokio_postgres::Row;

use super::*;

/// How many of the root conversation's newest jobs show the faces it has
/// used, newest by their last use. Jobs at work, and the planning jobs of their
/// plans, count however old.
const FACE_HISTORY_JOBS: i64 = 200;

/// How long a plan's lead keeps its face once a job of its plan ends: the
/// controller queues the lead's continuation after the last one ends, in the
/// moments the completion's settlement takes, and the lead wears its face again.
const LEAD_HANDOVER_SECONDS: f64 = 120.0;

/// Every AI the root conversation's subtree has run: its newest jobs, the jobs
/// at work (queued, leased, or asking a question that is not yet resumed) and
/// the planning jobs those belong to, whose leads continue once their plans
/// end, as do the planning jobs of a job that has just ended. One statement, so
/// a question registered while it reads cannot fall between two reads. A saved
/// agent shows the face its profile picks now: its owner may have picked
/// another since it ran. Each job's payload is read once.
const FACE_SIGHTINGS_SQL: &str = "
    with subtree as (
        select id from conversations
        where project_id = $1 and (id = $2 or root_conversation_id = $2)
    ),
    working as (
        select jobs.id, jobs.parent_job_id
        from agent_jobs jobs
        where jobs.project_id = $1
          and jobs.status in ('queued', 'leased')
          and jobs.conversation_id in (select id from subtree)
        union
        select jobs.id, jobs.parent_job_id
        from agent_user_input_requests questions
        join agent_jobs jobs on jobs.id = questions.job_id
        where questions.project_id = $1
          and questions.status in ('pending', 'answered')
          and questions.conversation_id in (select id from subtree)
    ),
    handing_over as (
        select jobs.parent_job_id as id
        from agent_jobs jobs
        where jobs.project_id = $1
          and jobs.parent_job_id is not null
          and jobs.completed_at > now() - make_interval(secs => $4)
          and jobs.conversation_id in (select id from subtree)
    ),
    recent as (
        select jobs.id
        from agent_jobs jobs
        where jobs.project_id = $1
          and jobs.conversation_id in (select id from subtree)
        order by greatest(jobs.created_at, jobs.completed_at, jobs.updated_at) desc, jobs.id desc
        limit $3
    ),
    seen as (
        select id from recent
        union select id from working
        union select parent_job_id from working where parent_job_id is not null
        union select id from handing_over
    ),
    sighted as materialized (
        select jobs.payload #> '{metadata,agent}' as agent,
               greatest(jobs.created_at, jobs.completed_at, jobs.updated_at) as last_used,
               exists (
                   select 1 from working
                   where working.id = jobs.id or working.parent_job_id = jobs.id
               ) or exists (
                   select 1 from handing_over where handing_over.id = jobs.id
               ) as open
        from seen
        join agent_jobs jobs on jobs.id = seen.id
        where jobs.project_id = $1
    )
    select sighted.agent ->> 'handle' as handle,
           coalesce(saved.avatar_seed, sighted.agent ->> 'avatarSeed') as avatar_seed,
           sighted.agent ->> 'id' as agent_id,
           sighted.last_used,
           sighted.open
    from sighted
    left join user_agents saved
      on saved.id = case
             when sighted.agent ->> 'id'
                  ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             then (sighted.agent ->> 'id')::uuid
         end
     and saved.deleted_at is null";

/// Gives each target without a profile its face in this chat. A rerun first
/// keeps its predecessor's face; a dispatch with no AI left to give a face to
/// takes no lock and reads nothing more.
pub(super) async fn stamp_faces(
    transaction: &mut Transaction<'_>,
    context: &RequestContext,
    project_id: Uuid,
    conversation: &conversations::ConversationRecord,
    metadata: &JsonValue,
    targets: &mut [AgentTarget],
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let predecessor = rerun_predecessor(context, metadata);
    if predecessor.is_none() && !targets.iter().any(needs_face) {
        return Ok(());
    }
    let savepoint = open_savepoint(transaction, "dispatch_agent_faces").await?;
    let stamped = read_faces(&savepoint, project_id, conversation, predecessor, targets).await;
    close_savepoint(savepoint, stamped, "give its AIs their faces").await?;
    Ok(())
}

async fn read_faces(
    transaction: &Transaction<'_>,
    project_id: Uuid,
    conversation: &conversations::ConversationRecord,
    predecessor: Option<Uuid>,
    targets: &mut [AgentTarget],
) -> Result<(), (StatusCode, Json<ApiError>)> {
    if let Some(predecessor) = predecessor {
        let row = transaction
            .query_opt(
                "select payload #>> '{metadata,agent,handle}' as handle,
                        payload #>> '{metadata,agent,avatarSeed}' as avatar_seed
                 from agent_jobs
                 where id = $1 and project_id = $2 and conversation_id = $3",
                &[&predecessor, &project_id, &conversation.id],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to load the rerun's earlier job: {error}"))
            })?;
        if let Some(row) = row {
            keep_predecessor_face(targets, row.get("handle"), row.get("avatar_seed"));
        }
    }
    if !targets.iter().any(needs_face) {
        return Ok(());
    }

    let root_id = crate::active_job_auth::conversation_root_id(conversation);
    lock_root_faces(transaction, &root_id).await?;
    let rows = transaction
        .query(
            FACE_SIGHTINGS_SQL,
            &[
                &project_id,
                &root_id,
                &FACE_HISTORY_JOBS,
                &LEAD_HANDOVER_SECONDS,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load the faces the conversation shows: {error}"
            ))
        })?;
    let sightings: Vec<AgentSighting<'_, DateTime<Utc>>> = rows.iter().map(sighting).collect();
    assign_faces(targets, &sightings);
    Ok(())
}

async fn open_savepoint<'a>(
    transaction: &'a mut Transaction<'_>,
    name: &str,
) -> Result<Transaction<'a>, (StatusCode, Json<ApiError>)> {
    transaction
        .savepoint(name)
        .await
        .map_err(|error| internal_error(format!("failed to open a savepoint: {error}")))
}

/// Keeps what `savepoint` read and locked when `outcome` is fine. Else rolls it
/// back, which releases its locks and leaves the dispatch's transaction usable,
/// says why, and gives `None`: the dispatch goes on as if the step found nothing.
async fn close_savepoint<T>(
    savepoint: Transaction<'_>,
    outcome: Result<T, (StatusCode, Json<ApiError>)>,
    step: &str,
) -> Result<Option<T>, (StatusCode, Json<ApiError>)> {
    match outcome {
        Ok(value) => {
            savepoint.commit().await.map_err(|error| {
                internal_error(format!("failed to release a savepoint: {error}"))
            })?;
            Ok(Some(value))
        }
        Err((status, Json(api_error))) => {
            savepoint.rollback().await.map_err(|error| {
                internal_error(format!("failed to roll back a savepoint: {error}"))
            })?;
            warn!(
                status = status.as_u16(),
                error = %api_error.message,
                "dispatch could not {step}; it goes on without"
            );
            Ok(None)
        }
    }
}

/// See the module's lock order. The root's row is already this transaction's
/// when it dispatches into the root.
async fn lock_root_faces(
    transaction: &Transaction<'_>,
    root_id: &Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .query_opt(
            "select 1 from conversations where id = $1 for no key update",
            &[root_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to lock the root conversation: {error}"))
        })?;
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&format!("conversation-faces:{root_id}")],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to acquire the conversation face lock: {error}"
            ))
        })?;
    Ok(())
}

/// Whether the controller gives `target` a face: an AI without a profile. A
/// saved agent keeps its own seed, as does a rerun that copied its
/// predecessor's, and Octo is Octo by its handle or its alias.
fn needs_face(target: &AgentTarget) -> bool {
    target.agent_id.is_none()
        && target
            .avatar_seed
            .as_deref()
            .is_none_or(|seed| seed.trim().is_empty())
        && !is_octo_handle(&target.handle)
}

/// Stamps `hatchling:<n>` on each target that needs a face, as the allocator
/// picks them from what the chat shows.
fn assign_faces<T: Ord>(targets: &mut [AgentTarget], sightings: &[AgentSighting<'_, T>]) {
    let agent_ids: Vec<Option<String>> = targets
        .iter()
        .map(|target| target.agent_id.map(|id| id.to_string()))
        .collect();
    let faces = {
        let lanes: Vec<FaceLane<'_>> = targets
            .iter()
            .zip(&agent_ids)
            .map(|(target, agent_id)| face_lane(target, agent_id.as_deref()))
            .collect();
        allocate_faces(&lanes, sightings)
    };
    for (target, face) in targets.iter_mut().zip(faces) {
        if let Some(face) = face {
            target.avatar_seed = Some(hatchling_seed(face));
        }
    }
}

fn face_lane<'a>(target: &'a AgentTarget, agent_id: Option<&'a str>) -> FaceLane<'a> {
    if needs_face(target) {
        return FaceLane::Persona(&target.handle);
    }
    FaceLane::Fixed(AgentFaceIdentity {
        handle: Some(&target.handle),
        avatar_seed: target.avatar_seed.as_deref(),
        agent_id,
        ..AgentFaceIdentity::default()
    })
}

fn sighting(row: &Row) -> AgentSighting<'_, DateTime<Utc>> {
    AgentSighting {
        identity: AgentFaceIdentity {
            handle: row.get("handle"),
            avatar_seed: row.get("avatar_seed"),
            agent_id: row.get("agent_id"),
            ..AgentFaceIdentity::default()
        },
        last_used: row.get("last_used"),
        open: row.get("open"),
    }
}

/// The job a controller rerun of a plan worker continues: a rate-limit retry,
/// else a turn continuation, else an answered question's continuation, as the
/// plan group's snapshot reads them. Only the controller's own dispatches say.
fn rerun_predecessor(context: &RequestContext, metadata: &JsonValue) -> Option<Uuid> {
    if !context.is_service_role {
        return None;
    }
    crate::multi_agent_plan::RerunReason::of(worker_plan(metadata)?).map(|(of, _)| of)
}

/// A rerun keeps its lane's face: the predecessor's seed, copied as it is (a
/// handle seed from before the controller stamped faces included), even when
/// the handle has since become a saved agent's.
fn keep_predecessor_face(targets: &mut [AgentTarget], handle: Option<&str>, seed: Option<&str>) {
    let Some(handle) = handle.and_then(normalize_agent_handle) else {
        return;
    };
    let Some(seed) = seed.filter(|seed| !seed.trim().is_empty()) else {
        return;
    };
    for target in targets.iter_mut().filter(|target| target.handle == handle) {
        target.avatar_seed = Some(seed.to_string());
    }
}

fn worker_plan(metadata: &JsonValue) -> Option<&JsonMap<String, JsonValue>> {
    let plan = metadata
        .get("multiAgentPlan")
        .or_else(|| metadata.get("multi_agent_plan"))?
        .as_object()?;
    (plan.get("role").and_then(JsonValue::as_str).map(str::trim) == Some("worker")).then_some(plan)
}

/// Who a plan dispatch's own notices (a runtime alert) speak as: the plan's
/// lead as its planning job stamped it, not the plan's first lane. `None` for
/// any other dispatch.
pub(super) async fn plan_lead_agent(
    transaction: &mut Transaction<'_>,
    context: &RequestContext,
    project_id: Uuid,
    metadata: &JsonValue,
) -> Result<Option<JsonValue>, (StatusCode, Json<ApiError>)> {
    if !context.is_service_role {
        return Ok(None);
    }
    let Some(plan) = worker_plan(metadata) else {
        return Ok(None);
    };
    let planning_job = plan
        .get("parentJobId")
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::from_str(value.trim()).ok());
    let planning_agent = match planning_job {
        Some(job_id) => {
            let savepoint = open_savepoint(transaction, "dispatch_plan_lead").await?;
            let read = load_planning_agent(&savepoint, job_id, project_id).await;
            close_savepoint(savepoint, read, "read its plan's lead")
                .await?
                .flatten()
        }
        None => None,
    };
    Ok(plan_lead_identity(plan, planning_agent.as_ref()))
}

async fn load_planning_agent(
    transaction: &Transaction<'_>,
    job_id: Uuid,
    project_id: Uuid,
) -> Result<Option<JsonValue>, (StatusCode, Json<ApiError>)> {
    let row = transaction
        .query_opt(
            "select payload #> '{metadata,agent}' as agent
             from agent_jobs where id = $1 and project_id = $2",
            &[&job_id, &project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load the plan's lead: {error}")))?;
    Ok(row
        .and_then(|row| row.get::<_, Option<PgJson<JsonValue>>>("agent"))
        .map(|agent| agent.0))
}

/// The lead's planning job's `metadata.agent`, cut to what a notice carries
/// (its saved agent's id included, so a client draws it from the profile),
/// else the handle the plan names, seeded with itself as dispatch seeds an AI
/// it gave no face.
fn plan_lead_identity(
    plan: &JsonMap<String, JsonValue>,
    planning_agent: Option<&JsonValue>,
) -> Option<JsonValue> {
    if let Some(agent) = planning_agent {
        if let Some(handle) = agent.get("handle").and_then(JsonValue::as_str) {
            let seed = agent.get("avatarSeed").and_then(JsonValue::as_str);
            let mut lead = json!({
                "handle": handle,
                "displayName": agent.get("displayName"),
                "avatarSeed": seed.unwrap_or(handle),
            });
            if let Some(id) = agent
                .get("id")
                .and_then(JsonValue::as_str)
                .filter(|id| !id.trim().is_empty())
            {
                lead["id"] = json!(id);
            }
            return Some(lead);
        }
    }
    let handle = plan
        .get("lead")
        .and_then(|lead| lead.get("leadHandle"))
        .and_then(JsonValue::as_str)
        .and_then(normalize_agent_handle)?;
    Some(json!({ "handle": handle, "displayName": null, "avatarSeed": handle }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(handle: &str) -> AgentTarget {
        AgentTarget {
            handle: handle.to_string(),
            agent_id: None,
            credential_id: None,
            runtime_id: None,
            display_name: None,
            description: None,
            avatar_seed: None,
        }
    }

    fn saved(handle: &str, seed: &str) -> AgentTarget {
        AgentTarget {
            agent_id: Some(Uuid::new_v4()),
            avatar_seed: Some(seed.to_string()),
            ..target(handle)
        }
    }

    fn seeds(targets: &[AgentTarget]) -> Vec<Option<&str>> {
        targets
            .iter()
            .map(|target| target.avatar_seed.as_deref())
            .collect()
    }

    fn row<'a>(handle: &'a str, seed: &'a str) -> AgentFaceIdentity<'a> {
        AgentFaceIdentity {
            handle: Some(handle),
            avatar_seed: Some(seed),
            ..AgentFaceIdentity::default()
        }
    }

    fn service() -> RequestContext {
        RequestContext {
            user_id: Some(Uuid::new_v4()),
            is_service_role: true,
            scoped_claims: None,
        }
    }

    #[test]
    fn only_ais_without_a_profile_are_given_a_face() {
        let pia = saved("pia", "hatchling:1");
        let legacy = saved("max", "3f6c1f0e-8a1b-4c55-9d1e-2b7a6c9e4f10");
        let octo = AgentTarget {
            avatar_seed: Some("octo".to_string()),
            ..target("octo")
        };
        let mut targets = vec![
            target("reviewer"),
            pia.clone(),
            octo,
            // Octo's alias: every client draws it as Octo, so it keeps its handle.
            target("ai"),
            legacy.clone(),
            target("writer"),
        ];
        assign_faces::<u32>(&mut targets, &[]);
        assert_eq!(
            seeds(&targets),
            [
                // Pia holds face 1 and Max's id hashes to face 4, so the helpers take 2 and 3.
                Some("hatchling:2"),
                Some("hatchling:1"),
                Some("octo"),
                None,
                Some("3f6c1f0e-8a1b-4c55-9d1e-2b7a6c9e4f10"),
                Some("hatchling:3"),
            ]
        );
        assert_eq!(targets[1].agent_id, pia.agent_id);
        assert_eq!(targets[4].agent_id, legacy.agent_id);
        assert!(targets.iter().all(|target| !needs_face(target)));
    }

    #[test]
    fn helpers_keep_off_the_faces_the_chat_shows() {
        // Helper `sam` is at work in face 1, and a saved agent wore face 2.
        let saved_id = Uuid::new_v4().to_string();
        let sightings = [
            AgentSighting {
                identity: row("sam", "hatchling:1"),
                last_used: 9,
                open: true,
            },
            AgentSighting {
                identity: AgentFaceIdentity {
                    agent_id: Some(&saved_id),
                    ..row("pia", "hatchling:2")
                },
                last_used: 3,
                open: false,
            },
            AgentSighting {
                identity: row("ben", "hatchling:5"),
                last_used: 4,
                open: false,
            },
        ];
        let mut targets = vec![target("ben"), target("new")];
        assign_faces(&mut targets, &sightings);
        // Ben comes back to his face; the newcomer takes the first free one.
        assert_eq!(seeds(&targets), [Some("hatchling:5"), Some("hatchling:3")]);
    }

    #[test]
    fn a_rerun_continues_the_job_the_group_snapshot_names() {
        let retried = Uuid::new_v4();
        let continued = Uuid::new_v4();
        let asked = Uuid::new_v4();
        let request = Uuid::new_v4();
        // A rate-limit retry of a continued turn carries both, and replaces the retried run.
        let retry = json!({"multiAgentPlan": {
            "role": "worker",
            "rateLimitRetry": {"of": retried, "waitMs": 3000, "holdMs": 3000, "reason": "rate_limit"},
            "continuation": {"of": continued, "turn": 2, "last": false, "endedBy": "time_limit"},
        }});
        assert_eq!(rerun_predecessor(&service(), &retry), Some(retried));
        let turn = json!({"multiAgentPlan": {
            "role": "worker",
            "continuation": {"of": continued, "turn": 2, "last": false, "endedBy": "time_limit"},
            "userInputContinuation": {"of": asked, "requestId": request},
        }});
        assert_eq!(rerun_predecessor(&service(), &turn), Some(continued));
        // An answered question keeps only its turn number as `continuation`.
        let answer = json!({"multiAgentPlan": {
            "role": "worker",
            "userInputContinuation": {"of": asked, "requestId": request},
            "continuation": {"turn": 1},
        }});
        assert_eq!(rerun_predecessor(&service(), &answer), Some(asked));

        // A fresh lane, a lead's turn and anyone but the controller name none.
        let fresh = json!({"multiAgentPlan": {"role": "worker"}});
        assert_eq!(rerun_predecessor(&service(), &fresh), None);
        let lead = json!({"multiAgentPlan": {
            "role": "lead_continuation",
            "continuation": {"of": continued},
        }});
        assert_eq!(rerun_predecessor(&service(), &lead), None);
        let member = RequestContext {
            is_service_role: false,
            ..service()
        };
        assert_eq!(rerun_predecessor(&member, &retry), None);
        let snake =
            json!({"multi_agent_plan": {"role": "worker", "continuation": {"of": continued}}});
        assert_eq!(rerun_predecessor(&service(), &snake), Some(continued));
    }

    #[test]
    fn a_rerun_keeps_its_lanes_face_as_it_was_stamped() {
        let mut targets = vec![target("reading_list")];
        keep_predecessor_face(&mut targets, Some("reading_list"), Some("hatchling:3"));
        assert_eq!(seeds(&targets), [Some("hatchling:3")]);
        assert!(!needs_face(&targets[0]));

        // A lane stamped before faces were keeps its handle seed.
        let mut targets = vec![target("release_note")];
        keep_predecessor_face(&mut targets, Some("Release_Note"), Some("release_note"));
        assert_eq!(seeds(&targets), [Some("release_note")]);

        // A handle that has since become a saved agent's still wears the lane's face.
        let mut targets = vec![saved("reading_list", "reading_list")];
        keep_predecessor_face(&mut targets, Some("reading_list"), Some("hatchling:3"));
        assert_eq!(seeds(&targets), [Some("hatchling:3")]);

        // Only the predecessor's own lane, and only a seed it had.
        let mut targets = vec![target("other")];
        keep_predecessor_face(&mut targets, Some("reading_list"), Some("hatchling:3"));
        assert_eq!(seeds(&targets), [None]);
        keep_predecessor_face(&mut targets, Some("other"), Some("  "));
        keep_predecessor_face(&mut targets, Some("other"), None);
        keep_predecessor_face(&mut targets, None, Some("hatchling:3"));
        assert_eq!(seeds(&targets), [None]);
        assert!(needs_face(&targets[0]));
    }

    #[test]
    fn a_plans_notices_speak_as_its_lead() {
        let plan = json!({"role": "worker", "lead": {"leadHandle": "ben"}});
        let plan = plan.as_object().expect("plan");
        let planning = json!({
            "handle": "ben",
            "displayName": "Ben",
            "avatarSeed": "hatchling:6",
            "description": "not for notices",
        });
        assert_eq!(
            plan_lead_identity(plan, Some(&planning)),
            Some(json!({"handle": "ben", "displayName": "Ben", "avatarSeed": "hatchling:6"}))
        );
        // A saved agent's lead keeps its id, so a client draws it as its profile does now.
        let saved = json!({
            "handle": "pia",
            "id": "3f6c1f0e-8a1b-4c55-9d1e-2b7a6c9e4f10",
            "avatarSeed": "hatchling:8",
        });
        assert_eq!(
            plan_lead_identity(plan, Some(&saved)),
            Some(json!({
                "handle": "pia",
                "id": "3f6c1f0e-8a1b-4c55-9d1e-2b7a6c9e4f10",
                "displayName": null,
                "avatarSeed": "hatchling:8",
            }))
        );
        // Without its planning job, the lead is the handle the plan names.
        assert_eq!(
            plan_lead_identity(plan, None),
            Some(json!({"handle": "ben", "displayName": null, "avatarSeed": "ben"}))
        );
        let octo = json!({"role": "worker", "lead": {"leadHandle": "@Octo"}});
        assert_eq!(
            plan_lead_identity(octo.as_object().expect("plan"), Some(&json!({}))),
            Some(json!({"handle": "octo", "displayName": null, "avatarSeed": "octo"}))
        );
        assert_eq!(
            plan_lead_identity(json!({}).as_object().expect("plan"), None),
            None
        );
    }
}
