use std::str::FromStr;

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use uuid::Uuid;

use crate::auth::authenticate_request;
use crate::conversations::{ensure_conversation_access, load_conversation_record};
use crate::{bad_request, ensure_project_write_access, internal_error, ApiError, AppState};

pub(crate) const GROUP_PARTICIPATION_SKILL_PATH: &str =
    ".agents/skills/instafy-group-participation/SKILL.md";
pub(crate) const HUMAN_ANSWER_CANCELLATION_REASON: &str =
    "Covered by a human answer in the shared conversation.";

const LOCK_COVERED_DEFAULT_OCTO_JOB_SQL: &str = "select id, run_id
     from agent_jobs
     where id = $1
       and project_id = $2
       and conversation_id = $3
       and run_id = $4
       and status in ('queued','leased')
       and coalesce(intent, 'feature') = 'feature'
       and parent_job_id is null
       and plan_group_id is null
       and lower(coalesce(payload #>> '{metadata,agent,handle}', '')) = 'octo'
     for update";

const CANCEL_COVERED_DEFAULT_OCTO_JOB_SQL: &str = "update agent_jobs
     set status = 'canceled',
         outcome = 'canceled',
         summary = coalesce(summary, $5),
         completed_at = now(),
         lease_expires_at = null,
         active_input_ready_runtime_id = null,
         active_input_ready_expires_at = null,
         active_input_ready_turn_id = null,
         heartbeat_at = now()
     where id = $1
       and project_id = $2
       and conversation_id = $3
       and run_id = $4
       and status in ('queued','leased')
       and coalesce(intent, 'feature') = 'feature'
       and parent_job_id is null
       and plan_group_id is null
       and lower(coalesce(payload #>> '{metadata,agent,handle}', '')) = 'octo'
     returning id, run_id";

const LOCK_DEFAULT_OCTO_JOB_FOR_AWAIT_REVALIDATION_SQL: &str = "select status
     from agent_jobs
     where id = $1
       and project_id = $2
       and conversation_id = $3
       and run_id = $4
       and coalesce(intent, 'feature') = 'feature'
       and parent_job_id is null
       and plan_group_id is null
       and lower(coalesce(payload #>> '{metadata,agent,handle}', '')) = 'octo'
     for update";

const LOAD_PREVIOUS_USER_TURN_SQL: &str = "select message.id,
            message.content,
            message.run_id,
            prior_job.id as job_id,
            prior_job.status as job_status,
            prior_job.payload #>> '{metadata,agent,handle}' as agent_handle,
            coalesce(
              (
                select array_agg(answer.content order by answer.created_at asc, answer.id asc)
                from conversation_messages answer
                where answer.conversation_id = message.conversation_id
                  and answer.project_id = message.project_id
                  and answer.run_id = message.run_id
                  and answer.role = 'assistant'
                  and answer.created_by is null
                  and nullif(btrim(answer.content), '') is not null
              ),
              array[]::text[]
            ) as completed_assistant_contents
     from conversation_messages message
     left join lateral (
         select id, status, payload
         from agent_jobs
         where run_id = message.run_id
           and conversation_id = message.conversation_id
           and coalesce(intent, 'feature') = 'feature'
           and parent_job_id is null
           and plan_group_id is null
           and lower(coalesce(payload #>> '{metadata,agent,handle}', '')) = 'octo'
         order by created_at desc, id desc
         limit 1
     ) prior_job on true
     where message.conversation_id = $1
       and message.role = 'user'
     order by message.created_at desc, message.id desc
     limit 1";

const LOAD_VERIFIED_OCTO_ANSWER_SQL: &str = "select prompt.content as question,
            coalesce(
              (
                select array_agg(answer.content order by answer.created_at asc, answer.id asc)
                from conversation_messages answer
                where answer.conversation_id = $3
                  and answer.project_id = $4
                  and answer.run_id = $2
                  and answer.role = 'assistant'
                  and answer.created_by is null
                  and nullif(btrim(answer.content), '') is not null
              ),
              array[]::text[]
            ) as answers
     from conversation_messages prompt
     where prompt.id = $1
       and prompt.run_id = $2
       and prompt.conversation_id = $3
       and prompt.project_id = $4
       and prompt.role = 'user'";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupParticipationResolveBody {
    content: String,
    metadata: Option<JsonValue>,
    #[serde(default)]
    explicit_octo: bool,
    #[serde(default)]
    reply_to_octo: bool,
    #[serde(default)]
    reply_to_human: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GroupParticipationDecision {
    Respond,
    Correct,
    Silent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum GroupParticipationDomain {
    Direct,
    HumanDirected,
    Arithmetic,
    Ambiguous,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GroupParticipationResolution {
    pub(crate) decision: GroupParticipationDecision,
    pub(crate) domain: GroupParticipationDomain,
    pub(crate) reason: &'static str,
    /// Confidence in the inclusive 0-100 range used by the bundled skill.
    pub(crate) confidence: u8,
    pub(crate) participant_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) target_message_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) covered_run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) covered_job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) coverage: Option<&'static str>,
    pub(crate) policy_skill_path: &'static str,
}

impl GroupParticipationResolution {
    pub(crate) fn new(
        decision: GroupParticipationDecision,
        domain: GroupParticipationDomain,
        reason: &'static str,
        confidence: u8,
        participant_count: usize,
        target_message_id: Option<String>,
    ) -> Self {
        Self {
            decision,
            domain,
            reason,
            confidence,
            participant_count,
            target_message_id,
            covered_run_id: None,
            covered_job_id: None,
            coverage: None,
            policy_skill_path: GROUP_PARTICIPATION_SKILL_PATH,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GroupParticipationContext {
    pub(crate) participant_count: usize,
    pub(crate) previous_user_content: Option<String>,
    pub(crate) previous_user_message_id: Option<Uuid>,
    pub(crate) previous_user_run_id: Option<Uuid>,
    pub(crate) previous_user_job_id: Option<Uuid>,
    pub(crate) previous_user_job_status: Option<String>,
    pub(crate) previous_user_job_agent_handle: Option<String>,
    pub(crate) previous_user_completed_assistant_contents: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArithmeticCoverageAction {
    CancelActiveOcto,
    AwaitActiveOcto,
    ReuseCompletedOcto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ArithmeticCoverage {
    pub(crate) action: ArithmeticCoverageAction,
    pub(crate) message_id: Uuid,
    pub(crate) run_id: Uuid,
    pub(crate) job_id: Uuid,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct GroupParticipationReplyTargets {
    pub(crate) reply_to_octo: bool,
    pub(crate) reply_to_human: bool,
    pub(crate) reply_to_other_agent: bool,
}

pub(crate) async fn load_group_participation_context(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation: &crate::conversations::ConversationRecord,
    project: &crate::ProjectRecord,
    current_user_id: Option<Uuid>,
) -> Result<GroupParticipationContext, (StatusCode, Json<ApiError>)> {
    // A public project conversation can already be visible to another project or
    // org member before that person sends their first message, so those authorized
    // potential viewers count too. Private conversations remain limited to their
    // creator, explicit participants, prior human senders, and the current sender.
    let include_potential_project_viewers =
        should_include_potential_project_viewers(&conversation.visibility);
    let participant_count: i64 = transaction
        .query_one(
            "select count(*)::bigint
             from (
                 select created_by as user_id
                 from conversations
                 where id = $1 and created_by is not null
                 union
                 select user_id
                 from conversation_participants
                 where conversation_id = $1 and user_id is not null
                 union
                 select created_by as user_id
                 from conversation_messages
                 where conversation_id = $1
                   and role = 'user'
                   and created_by is not null
                 union
                 select $2::uuid as user_id
                 union
                 select owner_user_id as user_id
                 from projects
                 where id = $3
                   and $5::boolean
                   and owner_user_id is not null
                 union
                 select user_id
                 from project_memberships
                 where project_id = $3
                   and $5::boolean
                 union
                 select user_id
                 from org_memberships
                 where org_id = $4
                   and $5::boolean
             ) humans
             where user_id is not null",
            &[
                &conversation.id,
                &current_user_id,
                &project.id,
                &project.org_id,
                &include_potential_project_viewers,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to resolve conversation participant count: {error}"
            ))
        })?
        .get(0);

    let previous_user_turn = transaction
        .query_opt(LOAD_PREVIOUS_USER_TURN_SQL, &[&conversation.id])
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to load recent conversation context: {error}"
            ))
        })?;

    Ok(GroupParticipationContext {
        participant_count: participant_count.max(0) as usize,
        previous_user_content: previous_user_turn
            .as_ref()
            .map(|row| row.get::<_, String>("content")),
        previous_user_message_id: previous_user_turn
            .as_ref()
            .map(|row| row.get::<_, Uuid>("id")),
        previous_user_run_id: previous_user_turn
            .as_ref()
            .and_then(|row| row.get::<_, Option<Uuid>>("run_id")),
        previous_user_job_id: previous_user_turn
            .as_ref()
            .and_then(|row| row.get::<_, Option<Uuid>>("job_id")),
        previous_user_job_status: previous_user_turn
            .as_ref()
            .and_then(|row| row.get::<_, Option<String>>("job_status")),
        previous_user_job_agent_handle: previous_user_turn
            .as_ref()
            .and_then(|row| row.get::<_, Option<String>>("agent_handle")),
        previous_user_completed_assistant_contents: previous_user_turn
            .as_ref()
            .map(|row| row.get::<_, Vec<String>>("completed_assistant_contents"))
            .unwrap_or_default(),
    })
}

pub(crate) async fn resolve_group_participation(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(conversation_id_raw): AxumPath<String>,
    Json(body): Json<GroupParticipationResolveBody>,
) -> Result<Json<GroupParticipationResolution>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    let conversation_id = Uuid::from_str(conversation_id_raw.trim())
        .map_err(|_| bad_request("conversationId must be a valid UUID"))?;
    let content = body.content.trim();
    if content.is_empty() {
        return Err(bad_request("content is required"));
    }

    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;

    let conversation = load_conversation_record(&transaction, &conversation_id).await?;
    let project = crate::load_project_record(&transaction, &conversation.project_id).await?;
    ensure_project_write_access(&transaction, &project, &context, conversation.session_id).await?;
    ensure_conversation_access(&transaction, &conversation, &context).await?;

    let participation_context =
        load_group_participation_context(&transaction, &conversation, &project, context.user_id)
            .await?;

    transaction.commit().await.map_err(|error| {
        internal_error(format!(
            "failed to finalize group participation lookup: {error}"
        ))
    })?;

    let target_message_id = extract_target_message_id(body.metadata.as_ref());
    let base_resolution = classify_group_participation(
        content,
        participation_context.participant_count,
        body.explicit_octo,
        body.reply_to_octo,
        body.reply_to_human,
        target_message_id,
        participation_context.previous_user_content.as_deref(),
    );
    let resolution = resolve_arithmetic_coverage(&base_resolution, &participation_context)
        .map(|coverage| apply_arithmetic_coverage(base_resolution.clone(), coverage))
        .unwrap_or(base_resolution);
    // The preflight always tells clients to keep dispatching: the dispatch
    // path is the authority that records mechanically silent turns
    // (arithmetic, human-answer coverage) without a job and runs their
    // coverage actions, and ambient turns already carry the
    // skill_mode_ambient respond outcome so the dispatched agent decides.
    Ok(Json(apply_skill_mode_preflight(resolution)))
}

fn should_include_potential_project_viewers(visibility: &str) -> bool {
    visibility.trim().eq_ignore_ascii_case("public")
}

/// Preflight verdict: any mechanically Silent classification (arithmetic
/// equality, human-answer coverage) becomes a "respond" so the client keeps
/// dispatching and the authoritative dispatch path records it without a job.
fn apply_skill_mode_preflight(
    mut resolution: GroupParticipationResolution,
) -> GroupParticipationResolution {
    if resolution.decision == GroupParticipationDecision::Silent {
        resolution.decision = GroupParticipationDecision::Respond;
        resolution.reason = SKILL_MODE_AMBIENT_REASON;
    }
    resolution
}

pub(crate) fn classify_group_participation(
    content: &str,
    participant_count: usize,
    explicit_octo: bool,
    reply_to_octo: bool,
    reply_to_human: bool,
    target_message_id: Option<String>,
    previous_user_content: Option<&str>,
) -> GroupParticipationResolution {
    // Only contracts are decided here: explicit addressing, single-human
    // conversations, and the mechanical arithmetic answer-race layer. Every
    // other multi-human turn dispatches as an ambient agent evaluation and
    // the bundled group-participation skill decides whether Octo answers
    // (declining with the swallowed NO_RESPONSE sentinel).
    if reply_to_octo {
        return GroupParticipationResolution::new(
            GroupParticipationDecision::Respond,
            GroupParticipationDomain::Direct,
            "reply_to_octo",
            100,
            participant_count,
            target_message_id,
        );
    }

    if explicit_octo || content_mentions_octo(content) {
        return GroupParticipationResolution::new(
            GroupParticipationDecision::Respond,
            GroupParticipationDomain::Direct,
            "explicit_octo",
            100,
            participant_count,
            target_message_id,
        );
    }

    if participant_count <= 1 {
        return GroupParticipationResolution::new(
            GroupParticipationDecision::Respond,
            GroupParticipationDomain::Direct,
            "single_human_conversation",
            100,
            participant_count,
            target_message_id,
        );
    }

    if reply_to_human {
        return GroupParticipationResolution::new(
            GroupParticipationDecision::Respond,
            GroupParticipationDomain::HumanDirected,
            SKILL_MODE_AMBIENT_REASON,
            100,
            participant_count,
            target_message_id,
        );
    }

    if let Some(previous) = previous_user_content {
        if let Some(answer_is_correct) = arithmetic_equality_follow_up_is_correct(content, previous)
            .or_else(|| arithmetic_follow_up_is_correct(content, previous))
        {
            let (decision, reason) = if answer_is_correct {
                (
                    GroupParticipationDecision::Silent,
                    "correct_arithmetic_follow_up",
                )
            } else {
                (
                    GroupParticipationDecision::Correct,
                    "incorrect_arithmetic_follow_up",
                )
            };
            return GroupParticipationResolution::new(
                decision,
                GroupParticipationDomain::Arithmetic,
                reason,
                100,
                participant_count,
                target_message_id,
            );
        }
    }

    if let Some(equality_is_correct) = simple_arithmetic_equality(content) {
        let (decision, reason_code) = if equality_is_correct {
            (GroupParticipationDecision::Silent, "correct_arithmetic")
        } else {
            (GroupParticipationDecision::Correct, "incorrect_arithmetic")
        };
        return GroupParticipationResolution::new(
            decision,
            GroupParticipationDomain::Arithmetic,
            reason_code,
            100,
            participant_count,
            target_message_id,
        );
    }

    GroupParticipationResolution::new(
        GroupParticipationDecision::Respond,
        GroupParticipationDomain::Ambiguous,
        SKILL_MODE_AMBIENT_REASON,
        70,
        participant_count,
        target_message_id,
    )
}

pub(crate) fn resolve_arithmetic_coverage(
    resolution: &GroupParticipationResolution,
    context: &GroupParticipationContext,
) -> Option<ArithmeticCoverage> {
    let is_default_octo = context
        .previous_user_job_agent_handle
        .as_deref()
        .map(|handle| handle.trim().trim_start_matches('@').to_ascii_lowercase())
        .as_deref()
        == Some("octo");
    if !is_default_octo {
        return None;
    }
    let action = match (
        resolution.decision,
        resolution.reason,
        context.previous_user_job_status.as_deref(),
    ) {
        (
            GroupParticipationDecision::Silent,
            "correct_arithmetic_follow_up",
            Some("queued" | "leased"),
        ) if !completed_octo_answer_covers_question(context) => {
            ArithmeticCoverageAction::CancelActiveOcto
        }
        (
            GroupParticipationDecision::Correct,
            "incorrect_arithmetic_follow_up",
            Some("queued" | "leased"),
        ) => ArithmeticCoverageAction::AwaitActiveOcto,
        (
            GroupParticipationDecision::Correct,
            "incorrect_arithmetic_follow_up",
            Some("completed"),
        ) if completed_octo_answer_covers_question(context) => {
            ArithmeticCoverageAction::ReuseCompletedOcto
        }
        _ => return None,
    };

    Some(ArithmeticCoverage {
        action,
        message_id: context.previous_user_message_id?,
        run_id: context.previous_user_run_id?,
        job_id: context.previous_user_job_id?,
    })
}

fn completed_octo_answer_covers_question(context: &GroupParticipationContext) -> bool {
    let Some(question) = context.previous_user_content.as_deref() else {
        return false;
    };
    persisted_octo_answer_covers_question(
        question,
        &context.previous_user_completed_assistant_contents,
    )
}

fn persisted_octo_answer_covers_question(question: &str, answers: &[String]) -> bool {
    answers.iter().any(|answer| {
        arithmetic_equality_follow_up_is_correct(answer, question)
            .or_else(|| arithmetic_follow_up_is_correct(answer, question))
            == Some(true)
    })
}

fn revalidated_await_action(
    job_status: &str,
    completed_answer_covers_question: bool,
) -> Option<ArithmeticCoverageAction> {
    match job_status {
        "queued" | "leased" => Some(ArithmeticCoverageAction::AwaitActiveOcto),
        "completed" if completed_answer_covers_question => {
            Some(ArithmeticCoverageAction::ReuseCompletedOcto)
        }
        _ => None,
    }
}

async fn verified_octo_answer_covers_question(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    conversation_id: &Uuid,
    coverage: ArithmeticCoverage,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let delivered_answer = transaction
        .query_opt(
            LOAD_VERIFIED_OCTO_ANSWER_SQL,
            &[
                &coverage.message_id,
                &coverage.run_id,
                conversation_id,
                project_id,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to recheck delivered default Octo answer: {error}"
            ))
        })?;
    Ok(delivered_answer.is_some_and(|row| {
        let question = row.get::<_, String>("question");
        let answers = row.get::<_, Vec<String>>("answers");
        persisted_octo_answer_covers_question(&question, &answers)
    }))
}

pub(crate) async fn revalidate_awaited_default_octo_job(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    conversation_id: &Uuid,
    mut coverage: ArithmeticCoverage,
) -> Result<Option<ArithmeticCoverage>, (StatusCode, Json<ApiError>)> {
    if coverage.action != ArithmeticCoverageAction::AwaitActiveOcto {
        return Ok(Some(coverage));
    }

    // Completion and message delivery both lock this exact row. Taking the same
    // lock closes the gap between the context read and the human-only commit:
    // a job that has just failed/canceled cannot suppress a needed correction.
    let locked_job = transaction
        .query_opt(
            LOCK_DEFAULT_OCTO_JOB_FOR_AWAIT_REVALIDATION_SQL,
            &[
                &coverage.job_id,
                project_id,
                conversation_id,
                &coverage.run_id,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to revalidate awaited default Octo job: {error}"
            ))
        })?;
    let Some(locked_job) = locked_job else {
        return Ok(None);
    };
    let status = locked_job.get::<_, String>("status");
    let completed_answer_covers_question = if status == "completed" {
        verified_octo_answer_covers_question(transaction, project_id, conversation_id, coverage)
            .await?
    } else {
        false
    };
    let Some(action) = revalidated_await_action(&status, completed_answer_covers_question) else {
        return Ok(None);
    };
    coverage.action = action;
    Ok(Some(coverage))
}

pub(crate) fn apply_arithmetic_coverage(
    mut resolution: GroupParticipationResolution,
    coverage: ArithmeticCoverage,
) -> GroupParticipationResolution {
    resolution.decision = GroupParticipationDecision::Silent;
    resolution.reason = match coverage.action {
        ArithmeticCoverageAction::CancelActiveOcto => {
            "correct_arithmetic_follow_up_covered_by_human"
        }
        ArithmeticCoverageAction::AwaitActiveOcto => {
            "incorrect_arithmetic_follow_up_covered_by_active_octo"
        }
        ArithmeticCoverageAction::ReuseCompletedOcto => {
            "incorrect_arithmetic_follow_up_covered_by_completed_octo"
        }
    };
    resolution.target_message_id = Some(coverage.message_id.to_string());
    resolution.covered_run_id = Some(coverage.run_id.to_string());
    resolution.covered_job_id = Some(coverage.job_id.to_string());
    resolution.coverage = Some(match coverage.action {
        ArithmeticCoverageAction::CancelActiveOcto => "cancel_active_octo",
        ArithmeticCoverageAction::AwaitActiveOcto => "await_active_octo",
        ArithmeticCoverageAction::ReuseCompletedOcto => "reuse_completed_octo",
    });
    resolution
}

pub(crate) async fn cancel_covered_default_octo_job(
    transaction: &tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    conversation_id: &Uuid,
    coverage: ArithmeticCoverage,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    if coverage.action != ArithmeticCoverageAction::CancelActiveOcto {
        return Ok(false);
    }

    let locked_job = transaction
        .query_opt(
            LOCK_COVERED_DEFAULT_OCTO_JOB_SQL,
            &[
                &coverage.job_id,
                project_id,
                conversation_id,
                &coverage.run_id,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to lock covered default Octo job: {error}"))
        })?;
    if locked_job.is_none() {
        return Ok(false);
    }

    // `/agent/message` locks this same job row before persisting a streamed
    // final answer. Read again after taking the lock so a delivered answer can
    // never be followed by a stale cancellation of its still-leased job.
    if verified_octo_answer_covers_question(transaction, project_id, conversation_id, coverage)
        .await?
    {
        return Ok(false);
    }

    let reason: Option<&str> = Some(HUMAN_ANSWER_CANCELLATION_REASON);
    let canceled = transaction
        .query_opt(
            CANCEL_COVERED_DEFAULT_OCTO_JOB_SQL,
            &[
                &coverage.job_id,
                project_id,
                conversation_id,
                &coverage.run_id,
                &reason,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to cancel covered default Octo job: {error}"
            ))
        })?;
    if canceled.is_none() {
        return Ok(false);
    }

    let updated_run_count = transaction
        .execute(
            "update runs
             set status = 'canceled',
                 progress_stage = null,
                 last_message = $4,
                 updated_at = now()
             where id = $1
               and project_id = $2
               and conversation_id = $3
               and status in ('queued','in_progress','awaiting_approval')",
            &[
                &coverage.run_id,
                project_id,
                conversation_id,
                &HUMAN_ANSWER_CANCELLATION_REASON,
            ],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to cancel covered default Octo run: {error}"
            ))
        })?;
    if updated_run_count != 1 {
        return Err(internal_error(
            "covered default Octo job did not have one active matching run",
        ));
    }
    crate::conversations::persist_canceled_run_metadata(
        transaction,
        &[coverage.run_id],
        HUMAN_ANSWER_CANCELLATION_REASON,
    )
    .await?;
    Ok(true)
}

/// Marker decision stamped on controller-authenticated evaluation turns: the
/// dispatched agent (not the controller) decides whether to respond.
pub(crate) const AGENT_EVALUATION_DECISION: &str = "agent_evaluation";
pub(crate) const SKILL_MODE_AMBIENT_REASON: &str = "skill_mode_ambient";
pub(crate) const AUTOMATION_NOTHING_TO_REPORT_REASON: &str = "automation_nothing_to_report";
pub(crate) const AGENT_DECLINED_REASON: &str = "agent_declined";
/// Exact bare token an agent emits as its first and only conversational output
/// to decline a marked evaluation turn.
pub(crate) const DECLINE_SENTINEL: &str = "NO_RESPONSE";

pub(crate) fn agent_evaluation_marker() -> JsonValue {
    agent_evaluation_marker_with_reason(SKILL_MODE_AMBIENT_REASON)
}

fn agent_evaluation_marker_with_reason(reason: &str) -> JsonValue {
    serde_json::json!({
        "decision": AGENT_EVALUATION_DECISION,
        "reason": reason,
        "enforcedBy": "runtime-controller",
    })
}

pub(crate) fn agent_declined_marker() -> JsonValue {
    serde_json::json!({
        "decision": "silent",
        "reason": AGENT_DECLINED_REASON,
        "enforcedBy": "runtime-controller",
    })
}

/// Server-stamped marker for ambient skill-mode turns. Client-supplied
/// `groupParticipation` claims were already stripped upstream, so this marker
/// can only originate from the controller.
pub(crate) fn inject_skill_mode_agent_evaluation_metadata(metadata: &mut JsonValue) {
    inject_agent_evaluation_metadata(metadata, agent_evaluation_marker());
}

/// Server-stamped marker for an opted-in scheduled automation. Like ambient
/// evaluations, this lets the agent explicitly decline with `NO_RESPONSE`,
/// but it remains a normally billed automation dispatch.
pub(crate) fn inject_automation_agent_evaluation_metadata(metadata: &mut JsonValue) {
    inject_agent_evaluation_metadata(
        metadata,
        agent_evaluation_marker_with_reason(AUTOMATION_NOTHING_TO_REPORT_REASON),
    );
}

fn inject_agent_evaluation_metadata(metadata: &mut JsonValue, marker: JsonValue) {
    if !metadata.is_object() {
        *metadata = JsonValue::Object(serde_json::Map::new());
    }
    if let Some(map) = metadata.as_object_mut() {
        map.insert("groupParticipation".to_string(), marker);
    }
}

pub(crate) fn metadata_marks_agent_evaluation(metadata: &JsonValue) -> bool {
    let Some(participation) = metadata.get("groupParticipation") else {
        return false;
    };
    participation.get("decision").and_then(JsonValue::as_str) == Some(AGENT_EVALUATION_DECISION)
        && participation.get("enforcedBy").and_then(JsonValue::as_str) == Some("runtime-controller")
}

pub(crate) fn metadata_marks_skill_mode_ambient_evaluation(metadata: &JsonValue) -> bool {
    metadata_marks_agent_evaluation(metadata)
        && metadata
            .get("groupParticipation")
            .and_then(|participation| participation.get("reason"))
            .and_then(JsonValue::as_str)
            == Some(SKILL_MODE_AMBIENT_REASON)
}

/// Whether an agent job was dispatched as a controller-authenticated
/// evaluation (marker lives under the job payload's `metadata` object).
pub(crate) fn job_payload_marks_agent_evaluation(job_payload: &JsonValue) -> bool {
    job_payload
        .get("metadata")
        .map(metadata_marks_agent_evaluation)
        .unwrap_or(false)
}

pub(crate) fn job_payload_marks_skill_mode_ambient_evaluation(job_payload: &JsonValue) -> bool {
    job_payload
        .get("metadata")
        .map(metadata_marks_skill_mode_ambient_evaluation)
        .unwrap_or(false)
}

pub(crate) fn metadata_marks_agent_declined(metadata: &JsonValue) -> bool {
    let Some(participation) = metadata.get("groupParticipation") else {
        return false;
    };
    participation.get("decision").and_then(JsonValue::as_str) == Some("silent")
        && participation.get("reason").and_then(JsonValue::as_str) == Some(AGENT_DECLINED_REASON)
        && participation.get("enforcedBy").and_then(JsonValue::as_str) == Some("runtime-controller")
}

pub(crate) fn job_payload_marks_agent_declined(job_payload: &JsonValue) -> bool {
    job_payload
        .get("metadata")
        .map(metadata_marks_agent_declined)
        .unwrap_or(false)
}

/// A decline is the bare sentinel token; tolerate whitespace, inline-code
/// backticks, and a fenced code block (optionally with a language tag).
pub(crate) fn is_group_participation_decline_sentinel(content: &str) -> bool {
    let trimmed = content.trim();
    if trimmed == DECLINE_SENTINEL {
        return true;
    }
    if let Some(rest) = trimmed.strip_prefix("```") {
        let rest = rest.strip_suffix("```").unwrap_or(rest);
        let rest = rest.trim();
        if rest == DECLINE_SENTINEL {
            return true;
        }
        if let Some((first_line, remainder)) = rest.split_once('\n') {
            let looks_like_language_tag = !first_line.trim().is_empty()
                && first_line
                    .trim()
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'));
            return looks_like_language_tag && remainder.trim() == DECLINE_SENTINEL;
        }
        return false;
    }
    trimmed.trim_matches('`').trim() == DECLINE_SENTINEL
}

pub(crate) fn inject_group_participation_metadata(
    metadata: &mut JsonValue,
    resolution: &GroupParticipationResolution,
) {
    if !metadata.is_object() {
        *metadata = JsonValue::Object(serde_json::Map::new());
    }
    let mut value = serde_json::to_value(resolution).unwrap_or_else(|_| JsonValue::Null);
    if let Some(map) = value.as_object_mut() {
        map.insert(
            "enforcedBy".to_string(),
            JsonValue::String("runtime-controller".to_string()),
        );
    }
    if let Some(map) = metadata.as_object_mut() {
        map.insert("groupParticipation".to_string(), value);
    }
}

pub(crate) async fn resolve_group_participation_reply_targets(
    transaction: &tokio_postgres::Transaction<'_>,
    conversation_id: &Uuid,
    metadata: &JsonValue,
) -> Result<GroupParticipationReplyTargets, (StatusCode, Json<ApiError>)> {
    let Some(message_id) =
        extract_target_message_id(Some(metadata)).and_then(|raw| Uuid::parse_str(raw.trim()).ok())
    else {
        return Ok(GroupParticipationReplyTargets::default());
    };
    let row = transaction
        .query_opt(
            "select role, metadata
             from conversation_messages
             where id = $1 and conversation_id = $2
             limit 1",
            &[&message_id, conversation_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to resolve participation reply target: {error}"
            ))
        })?;
    let Some(row) = row else {
        return Ok(GroupParticipationReplyTargets::default());
    };
    let role: String = row.get("role");
    let message_metadata: JsonValue = row.get("metadata");
    Ok(classify_group_reply_target(&role, &message_metadata))
}

fn classify_group_reply_target(role: &str, metadata: &JsonValue) -> GroupParticipationReplyTargets {
    if role.trim().eq_ignore_ascii_case("user") {
        return GroupParticipationReplyTargets {
            reply_to_human: true,
            ..GroupParticipationReplyTargets::default()
        };
    }
    if !role.trim().eq_ignore_ascii_case("assistant") {
        return GroupParticipationReplyTargets::default();
    }

    let message_type = metadata
        .as_object()
        .and_then(|map| map.get("messageType").or_else(|| map.get("message_type")))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_ascii_lowercase());
    if matches!(
        message_type.as_deref(),
        Some("agent_job_thread" | "run_cancellation" | "runtime_alert" | "runtime_switch")
    ) {
        return GroupParticipationReplyTargets::default();
    }

    let agent_handle = metadata
        .as_object()
        .and_then(|map| map.get("agent"))
        .and_then(JsonValue::as_object)
        .and_then(|agent| agent.get("handle"))
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().trim_start_matches('@').to_ascii_lowercase());
    match agent_handle.as_deref() {
        Some("octo") | None => GroupParticipationReplyTargets {
            reply_to_octo: true,
            ..GroupParticipationReplyTargets::default()
        },
        Some(_) => GroupParticipationReplyTargets {
            reply_to_other_agent: true,
            ..GroupParticipationReplyTargets::default()
        },
    }
}

pub(crate) fn extract_target_message_id(metadata: Option<&JsonValue>) -> Option<String> {
    let object = metadata?.as_object()?;
    for key in [
        "targetMessageId",
        "target_message_id",
        "replyToMessageId",
        "reply_to_message_id",
    ] {
        if let Some(value) = object
            .get(key)
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return Some(value.to_string());
        }
    }

    for key in ["replyTo", "reply_to", "replyContext", "reply_context"] {
        let Some(reply) = object.get(key).and_then(JsonValue::as_object) else {
            continue;
        };
        for id_key in ["messageId", "message_id", "id"] {
            if let Some(value) = reply
                .get(id_key)
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn content_mentions_octo(content: &str) -> bool {
    let characters: Vec<char> = content.chars().collect();
    let mut index = 0;

    while index < characters.len() {
        if characters[index] != '@' {
            index += 1;
            continue;
        }

        // Avoid interpreting the domain part of an email address as a mention.
        if index > 0
            && (characters[index - 1].is_alphanumeric()
                || matches!(characters[index - 1], '.' | '_' | '%' | '+' | '-'))
        {
            index += 1;
            continue;
        }

        let mut end = index + 1;
        while end < characters.len()
            && (characters[end].is_alphanumeric() || matches!(characters[end], '_' | '-' | '.'))
        {
            end += 1;
        }

        if end > index + 1 {
            // "@octo/anything" is an npm package scope, not the agent.
            if characters.get(end) == Some(&'/') {
                index = end;
                continue;
            }
            let handle: String = characters[index + 1..end].iter().collect();
            let normalized = handle
                .trim_end_matches('.')
                .chars()
                .flat_map(char::to_lowercase)
                .collect::<String>();
            if normalized == "octo" {
                return true;
            }
        }
        index = end.max(index + 1);
    }

    false
}

fn normalize_for_matching(content: &str) -> String {
    let mut normalized = String::new();
    let mut last_was_space = true;

    for ch in content.chars().flat_map(char::to_lowercase) {
        if ch.is_alphanumeric() || ch == '_' {
            normalized.push(ch);
            last_was_space = false;
        } else if !last_was_space {
            normalized.push(' ');
            last_was_space = true;
        }
    }

    normalized.trim().to_string()
}
// The integer-only scanners flush on '.' and ',', so "1.5 + 1.5" would parse
// as "5 + 1" and "1,000 + 500" as "000 + 500". Any digit-adjacent decimal or
// grouping mark means this parser cannot faithfully read the content, and a
// confident wrong verdict is worse than falling through to the other rules.
fn contains_decimal_or_comma_grouped_number(content: &str) -> bool {
    let characters: Vec<char> = content.chars().collect();
    characters.windows(3).any(|window| {
        window[0].is_ascii_digit() && matches!(window[1], '.' | ',') && window[2].is_ascii_digit()
    })
}

// "10/5" and "3-1" without spaces are date and score shapes, not arithmetic.
// Spaced forms ("10 / 5") and equality forms ("10/5=2") keep their meaning;
// '+' and '*' are never date-like.
fn is_bare_date_or_score_token(candidate: &str) -> bool {
    let trimmed = candidate.trim();
    if trimmed.chars().any(char::is_whitespace) {
        return false;
    }
    let Some((left, right)) = trimmed.split_once(['/', '-']) else {
        return false;
    };
    !left.is_empty()
        && !right.is_empty()
        && left.chars().all(|ch| ch.is_ascii_digit())
        && right.chars().all(|ch| ch.is_ascii_digit())
}

fn simple_arithmetic_equality(content: &str) -> Option<bool> {
    if contains_decimal_or_comma_grouped_number(content) {
        return None;
    }
    let mut candidate = String::new();
    for ch in content.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit()
            || ch.is_whitespace()
            || matches!(ch, '+' | '-' | '*' | '/' | '×' | '÷' | '=')
        {
            candidate.push(ch);
            continue;
        }

        if let Some(result) = parse_arithmetic_candidate(&candidate) {
            return Some(result);
        }
        candidate.clear();
    }
    parse_arithmetic_candidate(&candidate)
}

fn find_simple_arithmetic_expression_result(content: &str) -> Option<i128> {
    if contains_decimal_or_comma_grouped_number(content) {
        return None;
    }
    let mut candidate = String::new();
    for ch in content.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit()
            || ch.is_whitespace()
            || matches!(ch, '+' | '-' | '*' | '/' | '×' | '÷')
        {
            candidate.push(ch);
            continue;
        }

        if let Some(result) = parse_open_arithmetic_expression(&candidate) {
            return Some(result);
        }
        candidate.clear();
    }
    parse_open_arithmetic_expression(&candidate)
}

fn parse_open_arithmetic_expression(candidate: &str) -> Option<i128> {
    if is_bare_date_or_score_token(candidate) {
        return None;
    }
    parse_simple_arithmetic_expression(candidate)
}

fn arithmetic_follow_up_is_correct(current: &str, previous: &str) -> Option<bool> {
    let previous_normalized = normalize_for_matching(previous);
    let previous_is_question = previous.contains('?')
        || previous_normalized.starts_with("calculate ")
        || previous_normalized.starts_with("compute ");
    if !previous_is_question {
        return None;
    }

    let expected = find_simple_arithmetic_expression_result(previous)?;
    let normalized = normalize_for_matching(current);
    let claimed_raw = [
        "the answer is ",
        "the result is ",
        "answer is ",
        "result is ",
        "it is ",
        "its ",
    ]
    .iter()
    .find_map(|prefix| normalized.strip_prefix(prefix))
    .unwrap_or(normalized.as_str());
    let claimed = claimed_raw.parse::<i128>().ok()?;
    Some(claimed == expected)
}

fn arithmetic_equality_follow_up_is_correct(current: &str, previous: &str) -> Option<bool> {
    let previous_normalized = normalize_for_matching(previous);
    let previous_is_question = previous.contains('?')
        || previous_normalized.starts_with("calculate ")
        || previous_normalized.starts_with("compute ");
    if !previous_is_question {
        return None;
    }

    let previous_expression = find_simple_arithmetic_expression_signature(previous)?;
    let (current_expression, current_is_correct) = find_arithmetic_equality(current)?;
    (current_expression == previous_expression).then_some(current_is_correct)
}

fn find_simple_arithmetic_expression_signature(content: &str) -> Option<String> {
    if contains_decimal_or_comma_grouped_number(content) {
        return None;
    }
    let mut candidate = String::new();
    for ch in content.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit()
            || ch.is_whitespace()
            || matches!(ch, '+' | '-' | '*' | '/' | '×' | '÷')
        {
            candidate.push(ch);
            continue;
        }

        if let Some(signature) = open_arithmetic_expression_signature(&candidate) {
            return Some(signature);
        }
        candidate.clear();
    }
    open_arithmetic_expression_signature(&candidate)
}

fn open_arithmetic_expression_signature(candidate: &str) -> Option<String> {
    if is_bare_date_or_score_token(candidate) {
        return None;
    }
    arithmetic_expression_signature(candidate)
}

fn find_arithmetic_equality(content: &str) -> Option<(String, bool)> {
    if contains_decimal_or_comma_grouped_number(content) {
        return None;
    }
    let mut candidate = String::new();
    for ch in content.chars().chain(std::iter::once(' ')) {
        if ch.is_ascii_digit()
            || ch.is_whitespace()
            || matches!(ch, '+' | '-' | '*' | '/' | '×' | '÷' | '=')
        {
            candidate.push(ch);
            continue;
        }

        if let Some(equality) = parse_arithmetic_equality(&candidate) {
            return Some(equality);
        }
        candidate.clear();
    }
    parse_arithmetic_equality(&candidate)
}

fn parse_arithmetic_equality(candidate: &str) -> Option<(String, bool)> {
    let compact: String = candidate.chars().filter(|ch| !ch.is_whitespace()).collect();
    if compact.matches('=').count() != 1 {
        return None;
    }
    let (expression, claimed_raw) = compact.split_once('=')?;
    let signature = arithmetic_expression_signature(expression)?;
    let claimed = claimed_raw.parse::<i128>().ok()?;
    let actual = parse_simple_arithmetic_expression(expression)?;
    Some((signature, claimed == actual))
}

fn arithmetic_expression_signature(candidate: &str) -> Option<String> {
    parse_simple_arithmetic_expression(candidate)?;
    Some(
        candidate
            .chars()
            .filter(|ch| !ch.is_whitespace())
            .map(|ch| match ch {
                '×' => '*',
                '÷' => '/',
                other => other,
            })
            .collect(),
    )
}

fn parse_simple_arithmetic_expression(candidate: &str) -> Option<i128> {
    let compact: String = candidate.chars().filter(|ch| !ch.is_whitespace()).collect();
    let mut operator = None;
    let mut operator_index = 0;
    for (index, ch) in compact.char_indices() {
        if matches!(ch, '+' | '-' | '*' | '/' | '×' | '÷') {
            if operator.is_some() {
                return None;
            }
            operator = Some(ch);
            operator_index = index;
        }
    }
    let operator = operator?;
    let left = compact.get(..operator_index)?.parse::<i128>().ok()?;
    let right = compact
        .get(operator_index + operator.len_utf8()..)?
        .parse::<i128>()
        .ok()?;
    match operator {
        '+' => left.checked_add(right),
        '-' => left.checked_sub(right),
        '*' | '×' => left.checked_mul(right),
        '/' | '÷' if right != 0 && left % right == 0 => left.checked_div(right),
        _ => None,
    }
}

fn parse_arithmetic_candidate(candidate: &str) -> Option<bool> {
    let compact: String = candidate.chars().filter(|ch| !ch.is_whitespace()).collect();
    if compact.matches('=').count() != 1 {
        return None;
    }
    let (expression, claimed_raw) = compact.split_once('=')?;
    let claimed = claimed_raw.parse::<i128>().ok()?;
    let actual = parse_simple_arithmetic_expression(expression)?;
    Some(actual == claimed)
}

#[cfg(test)]
mod tests {
    use super::{
        apply_arithmetic_coverage, classify_group_participation, classify_group_reply_target,
        extract_target_message_id, inject_group_participation_metadata,
        resolve_arithmetic_coverage, revalidated_await_action,
        should_include_potential_project_viewers, ArithmeticCoverageAction,
        GroupParticipationContext, GroupParticipationDecision, GroupParticipationDomain,
        GroupParticipationReplyTargets, CANCEL_COVERED_DEFAULT_OCTO_JOB_SQL,
        LOAD_PREVIOUS_USER_TURN_SQL, LOAD_VERIFIED_OCTO_ANSWER_SQL,
        LOCK_COVERED_DEFAULT_OCTO_JOB_SQL, LOCK_DEFAULT_OCTO_JOB_FOR_AWAIT_REVALIDATION_SQL,
        SKILL_MODE_AMBIENT_REASON,
    };
    use serde_json::json;
    use uuid::Uuid;

    fn classify(
        content: &str,
        participants: usize,
        explicit_octo: bool,
        reply_to_octo: bool,
        reply_to_human: bool,
    ) -> super::GroupParticipationResolution {
        classify_group_participation(
            content,
            participants,
            explicit_octo,
            reply_to_octo,
            reply_to_human,
            None,
            None,
        )
    }

    struct Case {
        name: &'static str,
        content: &'static str,
        participants: usize,
        explicit_octo: bool,
        reply_to_octo: bool,
        decision: GroupParticipationDecision,
        domain: GroupParticipationDomain,
        reason_code: &'static str,
    }

    #[test]
    fn classifies_contracts_and_arithmetic_and_defers_the_rest_to_the_agent() {
        let cases = [
            Case {
                name: "reply to Octo",
                content: "Can you explain that?",
                participants: 3,
                explicit_octo: false,
                reply_to_octo: true,
                decision: GroupParticipationDecision::Respond,
                domain: GroupParticipationDomain::Direct,
                reason_code: "reply_to_octo",
            },
            Case {
                name: "explicit Octo flag",
                content: "what do you think?",
                participants: 3,
                explicit_octo: true,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Respond,
                domain: GroupParticipationDomain::Direct,
                reason_code: "explicit_octo",
            },
            Case {
                name: "explicit Octo mention",
                content: "@Octo what do you think?",
                participants: 3,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Respond,
                domain: GroupParticipationDomain::Direct,
                reason_code: "explicit_octo",
            },
            Case {
                name: "one human always has Octo",
                content: "Thanks",
                participants: 1,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Respond,
                domain: GroupParticipationDomain::Direct,
                reason_code: "single_human_conversation",
            },
            Case {
                name: "correct arithmetic",
                content: "1 + 1 = 2",
                participants: 2,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Silent,
                domain: GroupParticipationDomain::Arithmetic,
                reason_code: "correct_arithmetic",
            },
            Case {
                name: "incorrect arithmetic",
                content: "I make it 12 × 3 = 35.",
                participants: 2,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Correct,
                domain: GroupParticipationDomain::Arithmetic,
                reason_code: "incorrect_arithmetic",
            },
            Case {
                name: "terse incorrect equality",
                content: "2+2=5",
                participants: 2,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Correct,
                domain: GroupParticipationDomain::Arithmetic,
                reason_code: "incorrect_arithmetic",
            },
            Case {
                name: "unspaced division equality stays arithmetic",
                content: "10/5=2",
                participants: 2,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Silent,
                domain: GroupParticipationDomain::Arithmetic,
                reason_code: "correct_arithmetic",
            },
            Case {
                name: "bare date shape is not arithmetic",
                content: "Can we meet 10/5?",
                participants: 2,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Respond,
                domain: GroupParticipationDomain::Ambiguous,
                reason_code: SKILL_MODE_AMBIENT_REASON,
            },
            Case {
                name: "bare score shape is not arithmetic",
                content: "Was the score 3-1?",
                participants: 2,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Respond,
                domain: GroupParticipationDomain::Ambiguous,
                reason_code: SKILL_MODE_AMBIENT_REASON,
            },
            Case {
                name: "open question goes to the agent",
                content: "What is 1 + 1?",
                participants: 2,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Respond,
                domain: GroupParticipationDomain::Ambiguous,
                reason_code: SKILL_MODE_AMBIENT_REASON,
            },
            Case {
                name: "human decision goes to the agent",
                content: "Should we ship the blue version?",
                participants: 2,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Respond,
                domain: GroupParticipationDomain::Ambiguous,
                reason_code: SKILL_MODE_AMBIENT_REASON,
            },
            Case {
                name: "named human mention goes to the agent",
                content: "@bob can you take a look?",
                participants: 2,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Respond,
                domain: GroupParticipationDomain::Ambiguous,
                reason_code: SKILL_MODE_AMBIENT_REASON,
            },
            Case {
                name: "social turn goes to the agent",
                content: "Thanks for the help!",
                participants: 2,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Respond,
                domain: GroupParticipationDomain::Ambiguous,
                reason_code: SKILL_MODE_AMBIENT_REASON,
            },
            Case {
                name: "ambiguous group turn goes to the agent",
                content: "That might be the one",
                participants: 2,
                explicit_octo: false,
                reply_to_octo: false,
                decision: GroupParticipationDecision::Respond,
                domain: GroupParticipationDomain::Ambiguous,
                reason_code: SKILL_MODE_AMBIENT_REASON,
            },
        ];

        for case in cases {
            let result = classify(
                case.content,
                case.participants,
                case.explicit_octo,
                case.reply_to_octo,
                false,
            );
            assert_eq!(result.decision, case.decision, "{} decision", case.name);
            assert_eq!(result.domain, case.domain, "{} domain", case.name);
            assert_eq!(result.reason, case.reason_code, "{} reason code", case.name);
        }
    }

    #[test]
    fn does_not_treat_an_email_domain_or_package_scope_as_an_octo_mention() {
        for content in [
            "What does dev@octo.dev receive from the API?",
            "Why is @octo/cli breaking the build?",
        ] {
            let result = classify(content, 2, false, false, false);
            assert_eq!(result.reason, SKILL_MODE_AMBIENT_REASON, "{content}");
        }
        let mention = classify("Ping @octo. when you can", 2, false, false, false);
        assert_eq!(mention.reason, "explicit_octo");
    }

    #[test]
    fn reply_to_human_is_evaluated_by_the_agent_skill() {
        let result = classify(
            "Does the iPhone keyboard scroll correctly?",
            2,
            false,
            false,
            true,
        );
        assert_eq!(result.decision, GroupParticipationDecision::Respond);
        assert_eq!(result.domain, GroupParticipationDomain::HumanDirected);
        assert_eq!(result.reason, SKILL_MODE_AMBIENT_REASON);
    }

    #[test]
    fn preserves_target_message_id() {
        let result = classify_group_participation(
            "What is this?",
            2,
            false,
            false,
            false,
            Some("message-123".to_string()),
            None,
        );
        assert_eq!(result.target_message_id.as_deref(), Some("message-123"));
    }

    #[test]
    fn extracts_reply_context_message_id_used_by_the_frontend() {
        let message_id = Uuid::new_v4();
        let metadata = json!({
            "replyContext": {
                "messageId": message_id.to_string(),
                "quotedText": "Earlier message"
            }
        });

        assert_eq!(
            extract_target_message_id(Some(&metadata)).as_deref(),
            Some(message_id.to_string().as_str())
        );
    }

    #[test]
    fn classifies_reply_targets_without_treating_system_alerts_as_octo() {
        assert_eq!(
            classify_group_reply_target("user", &json!({})),
            GroupParticipationReplyTargets {
                reply_to_human: true,
                ..GroupParticipationReplyTargets::default()
            }
        );
        assert_eq!(
            classify_group_reply_target("assistant", &json!({ "agent": { "handle": "octo" } })),
            GroupParticipationReplyTargets {
                reply_to_octo: true,
                ..GroupParticipationReplyTargets::default()
            }
        );
        assert_eq!(
            classify_group_reply_target("assistant", &json!({ "agent": { "handle": "reviewer" } })),
            GroupParticipationReplyTargets {
                reply_to_other_agent: true,
                ..GroupParticipationReplyTargets::default()
            }
        );
        assert_eq!(
            classify_group_reply_target("assistant", &json!({ "messageType": "runtime_alert" })),
            GroupParticipationReplyTargets::default()
        );
    }

    #[test]
    fn injects_authoritative_policy_metadata_for_a_classified_turn() {
        let resolution = classify(
            "Why does the Android layout scale incorrectly?",
            2,
            false,
            false,
            false,
        );
        let mut metadata = json!({ "attachments": [{ "name": "phone.png" }] });

        inject_group_participation_metadata(&mut metadata, &resolution);

        assert_eq!(
            metadata["groupParticipation"]["enforcedBy"],
            "runtime-controller"
        );
        assert_eq!(metadata["groupParticipation"]["decision"], "respond");
        assert_eq!(
            metadata["groupParticipation"]["policySkillPath"],
            super::GROUP_PARTICIPATION_SKILL_PATH
        );
        assert!(metadata["attachments"].is_array());
    }

    #[test]
    fn uses_the_immediately_previous_arithmetic_question_for_bare_answers() {
        let with_previous = |content: &str| {
            classify_group_participation(
                content,
                2,
                false,
                false,
                false,
                None,
                Some("What is 1 + 1?"),
            )
        };
        let correct = with_previous("It is 2");
        assert_eq!(correct.decision, GroupParticipationDecision::Silent);
        assert_eq!(correct.domain, GroupParticipationDomain::Arithmetic);
        assert_eq!(correct.reason, "correct_arithmetic_follow_up");

        let wrong = with_previous("It is 3");
        assert_eq!(wrong.decision, GroupParticipationDecision::Correct);
        assert_eq!(wrong.domain, GroupParticipationDomain::Arithmetic);
        assert_eq!(wrong.reason, "incorrect_arithmetic_follow_up");

        assert_eq!(
            with_previous("1+1=2").reason,
            "correct_arithmetic_follow_up"
        );
        assert_eq!(
            with_previous("1+1=3").reason,
            "incorrect_arithmetic_follow_up"
        );
        assert_eq!(with_previous("2+2=4").reason, "correct_arithmetic");
    }

    #[test]
    fn refuses_to_verify_decimal_or_comma_grouped_arithmetic_follow_ups() {
        // The integer-only parser would read "1.5 + 1.5" as "5 + 1" and
        // "1,000 + 500" as "000 + 500"; it must refuse to grade those instead
        // of correcting a correct human answer with confidence 100. Refused
        // turns fall through to the ambient agent evaluation.
        for (previous, answer) in [
            ("What is 1.5 + 1.5?", "It is 3"),
            ("What is 1,000 + 500?", "The answer is 1500"),
        ] {
            let result =
                classify_group_participation(answer, 2, false, false, false, None, Some(previous));
            assert_eq!(
                result.decision,
                GroupParticipationDecision::Respond,
                "{previous} -> {answer}"
            );
            assert_eq!(
                result.reason, SKILL_MODE_AMBIENT_REASON,
                "{previous} -> {answer}"
            );
        }

        let bare_integer_answer = classify_group_participation(
            "13",
            2,
            false,
            false,
            false,
            None,
            Some("What is 6 + 7?"),
        );
        assert_eq!(
            bare_integer_answer.decision,
            GroupParticipationDecision::Silent
        );
        assert_eq!(bare_integer_answer.reason, "correct_arithmetic_follow_up");
    }

    fn arithmetic_context(status: &str, handle: &str) -> GroupParticipationContext {
        GroupParticipationContext {
            participant_count: 2,
            previous_user_content: Some("What is 1 + 1?".to_string()),
            previous_user_message_id: Some(Uuid::new_v4()),
            previous_user_run_id: Some(Uuid::new_v4()),
            previous_user_job_id: Some(Uuid::new_v4()),
            previous_user_job_status: Some(status.to_string()),
            previous_user_job_agent_handle: Some(handle.to_string()),
            previous_user_completed_assistant_contents: if status == "completed" {
                vec!["The answer is 2.".to_string()]
            } else {
                vec![]
            },
        }
    }

    #[test]
    fn active_octo_arithmetic_answers_are_covered_without_a_second_run() {
        let context = arithmetic_context("leased", "Octo");
        let classify_answer = |content: &str| {
            classify_group_participation(
                content,
                2,
                false,
                false,
                false,
                None,
                context.previous_user_content.as_deref(),
            )
        };
        let correct = classify_answer("It is 2");
        let correct_coverage =
            resolve_arithmetic_coverage(&correct, &context).expect("correct answer coverage");
        assert_eq!(
            correct_coverage.action,
            ArithmeticCoverageAction::CancelActiveOcto
        );
        let correct = apply_arithmetic_coverage(correct, correct_coverage);
        assert_eq!(correct.decision, GroupParticipationDecision::Silent);
        assert_eq!(
            correct.target_message_id.as_deref(),
            context
                .previous_user_message_id
                .map(|id| id.to_string())
                .as_deref()
        );
        assert_eq!(correct.coverage, Some("cancel_active_octo"));
        let serialized = serde_json::to_value(&correct).expect("serialize covered resolution");
        assert_eq!(serialized["coverage"], "cancel_active_octo");
        assert!(serialized["coveredRunId"].is_string());
        assert!(serialized["coveredJobId"].is_string());
        assert!(serialized["targetMessageId"].is_string());

        let wrong = classify_answer("It is 3");
        let wrong_coverage =
            resolve_arithmetic_coverage(&wrong, &context).expect("wrong answer coverage");
        assert_eq!(
            wrong_coverage.action,
            ArithmeticCoverageAction::AwaitActiveOcto
        );
        let wrong = apply_arithmetic_coverage(wrong, wrong_coverage);
        assert_eq!(wrong.decision, GroupParticipationDecision::Silent);
        assert_eq!(wrong.coverage, Some("await_active_octo"));

        for (answer, expected_action) in [
            ("1+1=2", ArithmeticCoverageAction::CancelActiveOcto),
            ("1+1=3", ArithmeticCoverageAction::AwaitActiveOcto),
        ] {
            let resolution = classify_answer(answer);
            assert_eq!(
                resolve_arithmetic_coverage(&resolution, &context)
                    .expect("matching equality must be covered")
                    .action,
                expected_action,
                "coverage action for {answer}"
            );
        }
    }

    #[test]
    fn a_delivered_answer_is_not_canceled_while_completion_is_still_in_flight() {
        let resolution = classify_group_participation(
            "It is 2",
            2,
            false,
            false,
            false,
            None,
            Some("What is 1 + 1?"),
        );

        let human_first = arithmetic_context("leased", "octo");
        assert_eq!(
            resolve_arithmetic_coverage(&resolution, &human_first)
                .expect("human-first answer should cancel pending Octo")
                .action,
            ArithmeticCoverageAction::CancelActiveOcto
        );

        let mut message_first = arithmetic_context("leased", "octo");
        message_first.previous_user_completed_assistant_contents =
            vec!["The answer is 2.".to_string()];
        assert!(resolve_arithmetic_coverage(&resolution, &message_first).is_none());
    }

    #[test]
    fn completed_octo_answer_covers_an_incorrect_follow_up_without_a_second_job() {
        let wrong = classify_group_participation(
            "It is 3",
            2,
            false,
            false,
            false,
            None,
            Some("What is 1 + 1?"),
        );
        let context = arithmetic_context("completed", "octo");
        let coverage = resolve_arithmetic_coverage(&wrong, &context)
            .expect("the completed answer already supplies the correction");
        assert_eq!(
            coverage.action,
            ArithmeticCoverageAction::ReuseCompletedOcto
        );
        let covered = apply_arithmetic_coverage(wrong, coverage);
        assert_eq!(covered.decision, GroupParticipationDecision::Silent);
        assert_eq!(covered.coverage, Some("reuse_completed_octo"));
        assert_eq!(
            covered.reason,
            "incorrect_arithmetic_follow_up_covered_by_completed_octo"
        );
    }

    #[test]
    fn failed_or_custom_agent_jobs_do_not_cover_an_incorrect_answer() {
        let wrong = classify_group_participation(
            "It is 3",
            2,
            false,
            false,
            false,
            None,
            Some("What is 1 + 1?"),
        );
        assert!(
            resolve_arithmetic_coverage(&wrong, &arithmetic_context("failed", "octo")).is_none()
        );
        assert!(
            resolve_arithmetic_coverage(&wrong, &arithmetic_context("leased", "reviewer"))
                .is_none()
        );
        assert_eq!(wrong.decision, GroupParticipationDecision::Correct);
    }

    #[test]
    fn completed_octo_job_without_a_correct_persisted_answer_does_not_cover_correction() {
        let wrong = classify_group_participation(
            "It is 3",
            2,
            false,
            false,
            false,
            None,
            Some("What is 1 + 1?"),
        );
        for contents in [
            Vec::new(),
            vec!["I could not answer.".to_string()],
            vec!["It is 3.".to_string()],
        ] {
            let mut context = arithmetic_context("completed", "octo");
            context.previous_user_completed_assistant_contents = contents;
            assert!(resolve_arithmetic_coverage(&wrong, &context).is_none());
        }
    }

    #[test]
    fn awaited_octo_is_rechecked_after_lock_when_job_status_changes() {
        assert_eq!(
            revalidated_await_action("queued", false),
            Some(ArithmeticCoverageAction::AwaitActiveOcto)
        );
        assert_eq!(
            revalidated_await_action("leased", false),
            Some(ArithmeticCoverageAction::AwaitActiveOcto)
        );
        assert_eq!(
            revalidated_await_action("completed", true),
            Some(ArithmeticCoverageAction::ReuseCompletedOcto)
        );
        for status in ["failed", "canceled", "expired"] {
            assert_eq!(
                revalidated_await_action(status, false),
                None,
                "a stale active read must not be reused after {status}"
            );
        }
        assert_eq!(
            revalidated_await_action("completed", false),
            None,
            "completion without a verified answer still needs a correction"
        );
    }

    #[test]
    fn only_controller_authored_assistant_answers_cover_arithmetic() {
        for sql in [LOAD_PREVIOUS_USER_TURN_SQL, LOAD_VERIFIED_OCTO_ANSWER_SQL] {
            assert!(sql.contains("answer.role = 'assistant'"));
            assert!(sql.contains("answer.created_by is null"));
        }
    }

    #[test]
    fn awaited_job_revalidation_locks_the_exact_default_octo_run_at_any_status() {
        for required in [
            "where id = $1",
            "project_id = $2",
            "conversation_id = $3",
            "run_id = $4",
            "parent_job_id is null",
            "plan_group_id is null",
            "'{metadata,agent,handle}'",
            "= 'octo'",
            "for update",
        ] {
            assert!(
                LOCK_DEFAULT_OCTO_JOB_FOR_AWAIT_REVALIDATION_SQL.contains(required),
                "missing awaited-job lock fence: {required}"
            );
        }
        assert!(
            !LOCK_DEFAULT_OCTO_JOB_FOR_AWAIT_REVALIDATION_SQL.contains("status in"),
            "the revalidation lock must still find a job that just reached a terminal status"
        );
    }

    #[test]
    fn covered_job_cancellation_sql_is_bound_to_one_default_octo_run() {
        for required in [
            "where id = $1",
            "project_id = $2",
            "conversation_id = $3",
            "run_id = $4",
            "status in ('queued','leased')",
            "parent_job_id is null",
            "plan_group_id is null",
            "'{metadata,agent,handle}'",
            "= 'octo'",
        ] {
            assert!(
                CANCEL_COVERED_DEFAULT_OCTO_JOB_SQL.contains(required),
                "missing cancellation fence: {required}"
            );
            assert!(
                LOCK_COVERED_DEFAULT_OCTO_JOB_SQL.contains(required),
                "missing lock fence: {required}"
            );
        }
        assert!(LOCK_COVERED_DEFAULT_OCTO_JOB_SQL.contains("for update"));
    }

    #[test]
    fn only_public_conversations_count_potential_project_viewers() {
        assert!(should_include_potential_project_viewers("public"));
        assert!(should_include_potential_project_viewers(" PUBLIC "));
        assert!(!should_include_potential_project_viewers("private"));
    }

    #[test]
    fn decline_sentinel_tolerates_whitespace_and_fences() {
        for declined in [
            "NO_RESPONSE",
            "  NO_RESPONSE\n",
            "`NO_RESPONSE`",
            "```\nNO_RESPONSE\n```",
            "```NO_RESPONSE```",
            "```text\nNO_RESPONSE\n```",
            "```markdown\nNO_RESPONSE\n```",
        ] {
            assert!(
                super::is_group_participation_decline_sentinel(declined),
                "must swallow: {declined:?}"
            );
        }
        for answered in [
            "no_response",
            "NO_RESPONSE!",
            "Sure — NO_RESPONSE was the flag you asked about.",
            "NO_RESPONSE\nActually, one more thing.",
            "```\nSome real answer\nNO_RESPONSE\n```",
            "",
        ] {
            assert!(
                !super::is_group_participation_decline_sentinel(answered),
                "must persist: {answered:?}"
            );
        }
    }

    #[test]
    fn preflight_flips_mechanically_silent_decisions_to_respond() {
        use super::GroupParticipationResolution;
        let silent = GroupParticipationResolution::new(
            GroupParticipationDecision::Silent,
            GroupParticipationDomain::Arithmetic,
            "correct_arithmetic",
            100,
            3,
            None,
        );
        let flipped = super::apply_skill_mode_preflight(silent);
        assert_eq!(flipped.decision, GroupParticipationDecision::Respond);
        assert_eq!(flipped.reason, SKILL_MODE_AMBIENT_REASON);

        let respond = GroupParticipationResolution::new(
            GroupParticipationDecision::Respond,
            GroupParticipationDomain::Ambiguous,
            SKILL_MODE_AMBIENT_REASON,
            70,
            3,
            None,
        );
        let untouched = super::apply_skill_mode_preflight(respond.clone());
        assert_eq!(untouched, respond);
    }

    #[test]
    fn agent_evaluation_marker_round_trips_through_job_payload() {
        let mut metadata = serde_json::json!({ "clientMessageId": "abc" });
        super::inject_skill_mode_agent_evaluation_metadata(&mut metadata);
        assert_eq!(
            metadata["groupParticipation"]["decision"],
            serde_json::json!("agent_evaluation")
        );
        assert_eq!(
            metadata["groupParticipation"]["reason"],
            serde_json::json!("skill_mode_ambient")
        );
        assert_eq!(
            metadata["groupParticipation"]["enforcedBy"],
            serde_json::json!("runtime-controller")
        );
        let payload = serde_json::json!({ "metadata": metadata });
        assert!(super::job_payload_marks_agent_evaluation(&payload));

        // A forged marker without the controller stamp is not honored.
        let forged = serde_json::json!({
            "metadata": { "groupParticipation": { "decision": "agent_evaluation" } }
        });
        assert!(!super::job_payload_marks_agent_evaluation(&forged));
        assert!(!super::job_payload_marks_agent_evaluation(
            &serde_json::json!({})
        ));
    }

    #[test]
    fn automation_evaluation_and_controller_decline_markers_are_authenticated() {
        let mut metadata = serde_json::json!({});
        super::inject_automation_agent_evaluation_metadata(&mut metadata);
        assert_eq!(
            metadata["groupParticipation"]["reason"],
            serde_json::json!(super::AUTOMATION_NOTHING_TO_REPORT_REASON)
        );
        assert!(super::job_payload_marks_agent_evaluation(
            &serde_json::json!({ "metadata": metadata })
        ));
        assert!(!super::job_payload_marks_skill_mode_ambient_evaluation(
            &serde_json::json!({ "metadata": metadata })
        ));

        let ambient = serde_json::json!({
            "metadata": {
                "groupParticipation": super::agent_evaluation_marker()
            }
        });
        assert!(super::job_payload_marks_skill_mode_ambient_evaluation(
            &ambient
        ));

        let declined = serde_json::json!({
            "metadata": { "groupParticipation": super::agent_declined_marker() }
        });
        assert!(super::job_payload_marks_agent_declined(&declined));
        assert!(!super::job_payload_marks_agent_declined(
            &serde_json::json!({
                "metadata": {
                    "groupParticipation": {
                        "decision": "silent",
                        "reason": "agent_declined"
                    }
                }
            })
        ));
    }
}
