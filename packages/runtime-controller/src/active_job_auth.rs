use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde_json::Value as JsonValue;
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::auth::{claims_have_scopes, RequestContext};
use crate::conversations::{
    ensure_conversation_access, load_conversation_record, ConversationRecord,
};
use crate::projects::{
    ensure_project_read_access, ensure_project_write_access, load_project_record,
};
use crate::{forbidden, internal_error, unauthorized, ApiError, AppState};

pub(crate) const ACTIVE_JOB_CONTROLLER_SCOPE: &str = "prompt.execute";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ActiveJobProjectAccess {
    Read,
    Write,
}

/// The live job behind a model-facing `CONTROLLER_ACCESS_TOKEN`.
///
/// A prompt token is deliberately not a reusable user session. Routes that
/// need to support collaboration commands must first resolve it back to the
/// still-leased job, then use this bounded authorization context.
#[derive(Clone, Debug)]
pub(crate) struct ActiveJobAuthorization {
    pub(crate) job_id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) subject_user_id: Uuid,
    pub(crate) conversation_id: Uuid,
    pub(crate) root_conversation_id: Uuid,
    pub(crate) plan_group_id: Option<Uuid>,
    conversation_is_private: bool,
    subject_is_service: bool,
}

impl ActiveJobAuthorization {
    pub(crate) fn ensure_project_id(
        &self,
        project_id: &Uuid,
    ) -> Result<(), (StatusCode, Json<ApiError>)> {
        if project_id != &self.project_id {
            return Err(forbidden("job token project mismatch"));
        }
        Ok(())
    }

    pub(crate) fn subject_context(&self) -> RequestContext {
        RequestContext {
            user_id: Some(self.subject_user_id),
            is_service_role: self.subject_is_service,
            scoped_claims: None,
        }
    }

    /// Read access may cross public conversations for history lookup. Private
    /// content is restricted to the active conversation's root tree so a
    /// model running in a public chat cannot pull unrelated private history
    /// into that chat.
    pub(crate) async fn ensure_conversation_read(
        &self,
        transaction: &Transaction<'_>,
        conversation: &ConversationRecord,
    ) -> Result<(), (StatusCode, Json<ApiError>)> {
        self.ensure_conversation_project(conversation)?;
        if conversation.visibility.eq_ignore_ascii_case("private")
            && conversation_root_id(conversation) != self.root_conversation_id
        {
            return Err(forbidden(
                "job token cannot read an unrelated private conversation",
            ));
        }
        ensure_conversation_access(transaction, conversation, &self.subject_context()).await
    }

    /// Collaboration writes are limited to the active root tree. This permits
    /// linked worker threads while preventing a leased job from dispatching
    /// work into arbitrary project conversations.
    pub(crate) async fn ensure_conversation_write(
        &self,
        transaction: &Transaction<'_>,
        conversation: &ConversationRecord,
    ) -> Result<(), (StatusCode, Json<ApiError>)> {
        self.ensure_conversation_project(conversation)?;
        if !self.can_write_conversation(conversation) {
            return Err(forbidden(
                "job token can only modify confidentiality-safe root-linked conversations",
            ));
        }
        ensure_conversation_access(transaction, conversation, &self.subject_context()).await
    }

    pub(crate) fn requires_private_child(&self, parent: &ConversationRecord) -> bool {
        self.conversation_is_private || parent.visibility.eq_ignore_ascii_case("private")
    }

    /// Project-scoped context is visible to later conversations, so only a
    /// job running in a public conversation may promote a context card there.
    pub(crate) fn can_write_project_context(&self) -> bool {
        !self.conversation_is_private
    }

    pub(crate) fn can_list_conversation(&self, conversation: &ConversationRecord) -> bool {
        conversation.project_id == self.project_id
            && (!conversation.visibility.eq_ignore_ascii_case("private")
                || conversation_root_id(conversation) == self.root_conversation_id)
    }

    fn can_write_conversation(&self, conversation: &ConversationRecord) -> bool {
        conversation.project_id == self.project_id
            && conversation_root_id(conversation) == self.root_conversation_id
            && (!self.conversation_is_private
                || conversation.visibility.eq_ignore_ascii_case("private"))
    }

    pub(crate) fn ensure_plan_group(
        &self,
        requested_group_id: &Uuid,
    ) -> Result<(), (StatusCode, Json<ApiError>)> {
        if self.plan_group_id != Some(*requested_group_id) {
            return Err(forbidden("job token can only access its active plan group"));
        }
        Ok(())
    }

    pub(crate) fn ensure_cancel_target(
        &self,
        target_job_id: &Uuid,
        target_project_id: &Uuid,
        target_conversation_id: Option<Uuid>,
        target_plan_group_id: Option<Uuid>,
    ) -> Result<(), (StatusCode, Json<ApiError>)> {
        if target_project_id != &self.project_id {
            return Err(forbidden("job token project mismatch"));
        }
        if target_conversation_id != Some(self.conversation_id) {
            return Err(forbidden(
                "job token can only cancel jobs in its active conversation",
            ));
        }
        if target_job_id == &self.job_id {
            return Ok(());
        }
        let Some(group_id) = self.plan_group_id else {
            return Err(forbidden(
                "job token can only cancel itself outside a plan group",
            ));
        };
        if target_plan_group_id != Some(group_id) {
            return Err(forbidden(
                "job token can only cancel sibling jobs in its active plan group",
            ));
        }
        Ok(())
    }

    fn ensure_conversation_project(
        &self,
        conversation: &ConversationRecord,
    ) -> Result<(), (StatusCode, Json<ApiError>)> {
        if conversation.project_id != self.project_id {
            return Err(forbidden("job token conversation project mismatch"));
        }
        Ok(())
    }
}

/// Resolve a scoped prompt token to its still-active leased job.
///
/// Human and service requests return `Ok(None)` and continue through their
/// existing authorization path. Scoped credentials other than the exact
/// prompt token are rejected rather than being upgraded to a user context.
pub(crate) async fn authorize_active_job_if_scoped(
    transaction: &Transaction<'_>,
    state: &AppState,
    context: &RequestContext,
    required_access: ActiveJobProjectAccess,
) -> Result<Option<ActiveJobAuthorization>, (StatusCode, Json<ApiError>)> {
    let Some(claims) = context.scoped_claims.as_ref() else {
        return Ok(None);
    };
    if !claims_have_scopes(claims, &[ACTIVE_JOB_CONTROLLER_SCOPE]) {
        return Err(unauthorized("insufficient active job token scopes"));
    }

    let project_id = parse_claim_uuid(&claims.project_id, "project")?;
    let runtime_id = claims
        .runtime_id
        .as_deref()
        .ok_or_else(|| unauthorized("job token is missing its runtime scope"))
        .and_then(|value| parse_claim_uuid(value, "runtime"))?;
    let run_id = claims
        .run_id
        .as_deref()
        .ok_or_else(|| unauthorized("job token is missing its run scope"))
        .and_then(|value| parse_claim_uuid(value, "run"))?;
    let subject_user_id = parse_claim_uuid(&claims.sub, "subject")?;
    let token_runtime_lease_id = claims
        .lease_id
        .as_deref()
        .map(|value| parse_claim_uuid(value, "runtime lease"))
        .transpose()?;
    let token_runtime_generation = claims
        .runtime_generation
        .as_deref()
        .map(|value| parse_claim_uuid(value, "runtime generation"))
        .transpose()?;
    if claims.aud != runtime_id.to_string() {
        return Err(unauthorized("job token audience mismatch"));
    }

    let row = transaction
        .query_opt(
            "select j.id,
                    j.project_id,
                    j.run_id,
                    j.conversation_id,
                    j.payload,
                    j.plan_group_id,
                    r.provider,
                    r.capabilities,
                    r.active_lease_id,
                    rl.project_id as runtime_lease_project_id,
                    rl.runtime_id as runtime_lease_runtime_id,
                    rl.status as runtime_lease_status,
                    rl.released_at as runtime_lease_released_at
             from agent_jobs j
             join runtimes r
               on r.id = j.leased_by_runtime_id
              and r.project_id = j.project_id
             left join runtime_leases rl on rl.id = r.active_lease_id
             where j.project_id = $1
               and j.run_id = $2
               and j.leased_by_runtime_id = $3
               and j.status = 'leased'
               and j.lease_expires_at > now()
               and r.status in ('ready', 'running', 'draining')
             order by j.leased_at desc nulls last
             limit 1",
            &[&project_id, &run_id, &runtime_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to validate active job: {error}")))?
        .ok_or_else(|| unauthorized("job token is no longer active"))?;

    let active_runtime_lease_id: Option<Uuid> = row.get("active_lease_id");
    let generation_marked = claims
        .scopes
        .iter()
        .any(|scope| scope == crate::origins::JOB_TOKEN_SEPARATED_SCOPE);
    if !runtime_generation_matches_token(
        token_runtime_lease_id,
        active_runtime_lease_id,
        generation_marked,
    ) {
        return Err(unauthorized(
            "job token runtime lease scope is no longer active",
        ));
    }
    let provider: String = row.get("provider");
    let capabilities: JsonValue = row.get("capabilities");
    let private_self_hosted =
        crate::runtime::runtime_is_private_self_hosted(state, &provider, &capabilities);
    let provider_managed = !private_self_hosted;
    if private_self_hosted {
        crate::runtime::ensure_bound_runtime_generation_matches(
            &capabilities,
            token_runtime_generation,
        )?;
        if crate::runtime::self_hosted_owner_user_id(&capabilities) != Some(subject_user_id) {
            return Err(unauthorized(
                "job token subject does not own the private self-hosted runtime",
            ));
        }
    }
    if provider_managed && active_runtime_lease_id.is_none() {
        return Err(unauthorized(
            "provider-managed job token is missing its runtime lease scope",
        ));
    }
    if active_runtime_lease_id.is_some()
        && (row.get::<_, Option<Uuid>>("runtime_lease_project_id") != Some(project_id)
            || row.get::<_, Option<Uuid>>("runtime_lease_runtime_id") != Some(runtime_id)
            || row
                .get::<_, Option<DateTime<Utc>>>("runtime_lease_released_at")
                .is_some()
            || row
                .get::<_, Option<String>>("runtime_lease_status")
                .as_deref()
                != Some("active"))
    {
        return Err(unauthorized(
            "job token runtime lease scope is no longer active",
        ));
    }

    let payload: JsonValue = row.get("payload");
    let payload_user_id = payload_uuid(&payload, "user_id");
    let expected_subject = payload_user_id.or(state.config.service_runtime_user_id);
    if expected_subject != Some(subject_user_id) {
        return Err(unauthorized(
            "job token subject does not match the active job",
        ));
    }
    let subject_is_service =
        payload_user_id.is_none() && state.config.service_runtime_user_id == Some(subject_user_id);
    let subject_context = RequestContext {
        user_id: Some(subject_user_id),
        is_service_role: subject_is_service,
        scoped_claims: None,
    };

    let project = load_project_record(transaction, &project_id).await?;
    match required_access {
        ActiveJobProjectAccess::Read => {
            ensure_project_read_access(transaction, &project, &subject_context, None).await?;
        }
        ActiveJobProjectAccess::Write => {
            ensure_project_write_access(transaction, &project, &subject_context, None).await?;
        }
    }

    let conversation_id = row
        .get::<_, Option<Uuid>>("conversation_id")
        .or_else(|| payload_uuid(&payload, "conversation_id"))
        .ok_or_else(|| unauthorized("active job is not bound to a conversation"))?;
    let conversation = load_conversation_record(transaction, &conversation_id).await?;
    if conversation.project_id != project_id {
        return Err(unauthorized("active job conversation project mismatch"));
    }
    ensure_conversation_access(transaction, &conversation, &subject_context).await?;

    let plan_group_id = row
        .get::<_, Option<Uuid>>("plan_group_id")
        .or_else(|| payload_plan_group_id(&payload));

    Ok(Some(ActiveJobAuthorization {
        job_id: row.get("id"),
        project_id,
        subject_user_id,
        conversation_id,
        root_conversation_id: conversation_root_id(&conversation),
        plan_group_id,
        conversation_is_private: conversation.visibility.eq_ignore_ascii_case("private"),
        subject_is_service,
    }))
}

pub(crate) fn conversation_root_id(conversation: &ConversationRecord) -> Uuid {
    conversation.root_conversation_id.unwrap_or(conversation.id)
}

pub(crate) fn payload_plan_group_id(payload: &JsonValue) -> Option<Uuid> {
    let metadata = payload.get("metadata")?;
    let plan = metadata
        .get("multiAgentPlan")
        .or_else(|| metadata.get("multi_agent_plan"))?;
    plan.get("groupId")
        .or_else(|| plan.get("group_id"))
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
}

/// Tokens issued before runtime-generation binding did not carry `lease_id`.
/// Keep those already-running jobs alive across the controller rollout, but
/// never apply that compatibility to a marked token or to a token that names
/// a (possibly stale) generation.
fn runtime_generation_matches_token(
    token_lease_id: Option<Uuid>,
    active_lease_id: Option<Uuid>,
    generation_marked: bool,
) -> bool {
    if token_lease_id.is_some() || generation_marked {
        return token_lease_id == active_lease_id;
    }
    true
}

fn payload_uuid(payload: &JsonValue, key: &str) -> Option<Uuid> {
    payload
        .get(key)
        .and_then(JsonValue::as_str)
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
}

fn parse_claim_uuid(raw: &str, label: &str) -> Result<Uuid, (StatusCode, Json<ApiError>)> {
    Uuid::parse_str(raw.trim())
        .map_err(|_| unauthorized(format!("job token {label} scope is invalid")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conversation(
        project_id: Uuid,
        id: Uuid,
        root: Uuid,
        visibility: &str,
    ) -> ConversationRecord {
        ConversationRecord {
            id,
            project_id,
            session_id: None,
            created_by: None,
            metadata: None,
            visibility: visibility.to_string(),
            parent_conversation_id: None,
            root_conversation_id: Some(root),
            thread_kind: None,
            last_message_id: None,
            last_message_at: None,
            last_message_preview: None,
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn authorization(
        project_id: Uuid,
        conversation_id: Uuid,
        root: Uuid,
    ) -> ActiveJobAuthorization {
        ActiveJobAuthorization {
            job_id: Uuid::new_v4(),
            project_id,
            subject_user_id: Uuid::new_v4(),
            conversation_id,
            root_conversation_id: root,
            plan_group_id: None,
            conversation_is_private: false,
            subject_is_service: false,
        }
    }

    #[test]
    fn scoped_lists_allow_public_history_but_only_root_linked_private_history() {
        let project_id = Uuid::new_v4();
        let root = Uuid::new_v4();
        let auth = authorization(project_id, root, root);
        assert!(auth.can_list_conversation(&conversation(
            project_id,
            Uuid::new_v4(),
            Uuid::new_v4(),
            "public",
        )));
        assert!(auth.can_list_conversation(&conversation(
            project_id,
            Uuid::new_v4(),
            root,
            "private",
        )));
        assert!(!auth.can_list_conversation(&conversation(
            project_id,
            Uuid::new_v4(),
            Uuid::new_v4(),
            "private",
        )));
    }

    #[test]
    fn cancellation_is_limited_to_self_or_same_group_siblings() {
        let project_id = Uuid::new_v4();
        let conversation_id = Uuid::new_v4();
        let mut auth = authorization(project_id, conversation_id, conversation_id);
        assert!(auth
            .ensure_cancel_target(&auth.job_id, &project_id, Some(conversation_id), None,)
            .is_ok());

        let sibling = Uuid::new_v4();
        assert!(auth
            .ensure_cancel_target(&sibling, &project_id, Some(conversation_id), None)
            .is_err());

        let group_id = Uuid::new_v4();
        auth.plan_group_id = Some(group_id);
        assert!(auth
            .ensure_cancel_target(&sibling, &project_id, Some(conversation_id), Some(group_id),)
            .is_ok());
        assert!(auth
            .ensure_cancel_target(
                &sibling,
                &project_id,
                Some(conversation_id),
                Some(Uuid::new_v4()),
            )
            .is_err());
    }

    #[test]
    fn private_job_writes_cannot_flow_into_public_root_siblings() {
        let project_id = Uuid::new_v4();
        let root = Uuid::new_v4();
        let mut auth = authorization(project_id, Uuid::new_v4(), root);
        auth.conversation_is_private = true;

        assert!(auth.can_write_conversation(&conversation(
            project_id,
            Uuid::new_v4(),
            root,
            "private",
        )));
        assert!(!auth.can_write_conversation(&conversation(
            project_id,
            Uuid::new_v4(),
            root,
            "public",
        )));
    }

    #[test]
    fn project_context_writes_are_only_allowed_from_public_jobs() {
        let project_id = Uuid::new_v4();
        let root = Uuid::new_v4();
        let mut auth = authorization(project_id, root, root);

        assert!(auth.can_write_project_context());
        auth.conversation_is_private = true;
        assert!(!auth.can_write_project_context());
    }

    #[test]
    fn plan_group_id_supports_legacy_payload_spellings() {
        let group_id = Uuid::new_v4();
        assert_eq!(
            payload_plan_group_id(&serde_json::json!({
                "metadata": { "multiAgentPlan": { "groupId": group_id } }
            })),
            Some(group_id)
        );
        assert_eq!(
            payload_plan_group_id(&serde_json::json!({
                "metadata": { "multi_agent_plan": { "group_id": group_id } }
            })),
            Some(group_id)
        );
    }

    #[test]
    fn runtime_generation_compatibility_is_only_for_unmarked_lease_less_tokens() {
        let current = Uuid::new_v4();
        let stale = Uuid::new_v4();

        assert!(runtime_generation_matches_token(None, Some(current), false));
        assert!(!runtime_generation_matches_token(None, Some(current), true));
        assert!(runtime_generation_matches_token(
            Some(current),
            Some(current),
            false,
        ));
        assert!(runtime_generation_matches_token(
            Some(current),
            Some(current),
            true,
        ));
        assert!(!runtime_generation_matches_token(
            Some(stale),
            Some(current),
            false,
        ));
        assert!(!runtime_generation_matches_token(Some(stale), None, false));
        assert!(runtime_generation_matches_token(None, None, true));
    }
}
