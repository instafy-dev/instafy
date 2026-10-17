//! Final receipts for planning jobs the controller already terminalized.
use super::*;

pub(super) struct StoredReceipt {
    pub(super) credit_org_id: Option<Uuid>,
}

fn matches_fence(
    marker: &JsonValue,
    claims: &TokenContext,
    runtime: Option<Uuid>,
    attempt: i32,
) -> bool {
    // An unscoped legacy token cannot supplement a terminal job. For scoped
    // tokens, agent_complete has already checked the current runtime lease.
    claims.runtime_id.is_some()
        && claims.runtime_id == runtime
        && marker.get("runtimeId") == Some(&json!(claims.runtime_id))
        && marker.get("leaseAttempt") == Some(&json!(attempt))
        && marker.get("runtimeLeaseId") == Some(&json!(claims.lease_id))
        && marker.get("runtimeGeneration") == Some(&json!(claims.runtime_generation))
        && matches!(
            marker.get("state").and_then(JsonValue::as_str),
            Some("pending" | "received")
        )
}

pub(super) async fn store(
    state: &AppState,
    transaction: &tokio_postgres::Transaction<'_>,
    claims: &TokenContext,
    job_id: Uuid,
    artifacts: &JsonValue,
    stored_artifacts: &JsonValue,
    task_usage: Option<&crate::task_usage::TaskUsageReceipt>,
    proxy_metadata: &Option<JsonValue>,
) -> Result<Option<StoredReceipt>, (StatusCode, Json<ApiError>)> {
    let Some(row) = transaction
        .query_opt(
            "select run_id, prompt_id, payload, leased_by_runtime_id, lease_attempts,
                summary, error_message, planning_receipt_state
         from agent_jobs
         where id = $1 and project_id = $2 and status in ('completed', 'failed')
           and planning_receipt_state is not null
         for update",
            &[&job_id, &claims.project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to load planning receipt fence: {error}"))
        })?
    else {
        return Ok(None);
    };
    let marker: JsonValue = row.get("planning_receipt_state");
    let runtime_id: Option<Uuid> = row.get("leased_by_runtime_id");
    if !matches_fence(&marker, claims, runtime_id, row.get("lease_attempts")) {
        return Err(forbidden(
            "planning receipt must match the original runtime lease",
        ));
    }
    if marker.get("state").and_then(JsonValue::as_str) == Some("received") {
        return Ok(Some(StoredReceipt {
            credit_org_id: None,
        }));
    }

    let run_id: Option<Uuid> = row.get("run_id");
    let payload: JsonValue = row.get("payload");
    let provider = extract_provider_from_metadata(proxy_metadata);
    let credit_snapshot = extract_credit_snapshot(proxy_metadata);
    if let Some(run_id) = run_id {
        let conversation_state = extract_provider_conversation_state(proxy_metadata);
        // The controller's dispatch/refusal result remains authoritative. A
        // successful runtime callback must not erase a refused plan's error.
        persist_run_completion_metadata(
            transaction,
            &run_id,
            &job_id,
            provider.as_deref(),
            conversation_state.as_ref(),
            credit_snapshot.as_ref(),
            row.get::<_, Option<String>>("summary").as_deref(),
            row.get::<_, Option<String>>("error_message").as_deref(),
            artifacts.as_array().map(Vec::len),
            task_usage.map(|receipt| (&job_id, receipt)),
        )
        .await
        .map_err(|error| internal_error(format!("failed to persist planning receipt: {error}")))?;
    }
    let prompt_id = row.get::<_, Option<Uuid>>("prompt_id").or_else(|| {
        payload
            .get("prompt_id")
            .and_then(JsonValue::as_str)
            .and_then(|id| Uuid::parse_str(id).ok())
    });
    let credit_org_id = if let Some(usage) = extract_turn_usage_from_artifacts(artifacts) {
        reconcile_completion_usage(
            state,
            transaction,
            &claims.project_id,
            &payload,
            run_id,
            prompt_id,
            runtime_id,
            provider.as_deref(),
            usage,
        )
        .await?
    } else {
        None
    };
    transaction
        .execute(
            "update agent_jobs set artifacts = $2,
             planning_receipt_state = jsonb_set(planning_receipt_state, '{state}', '\"received\"'),
             updated_at = now()
         where id = $1",
            &[&job_id, &PgJson(stored_artifacts)],
        )
        .await
        .map_err(|error| internal_error(format!("failed to store planning artifacts: {error}")))?;
    Ok(Some(StoredReceipt { credit_org_id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn planning_receipt_fence_requires_the_original_scoped_lease() {
        let runtime = Uuid::new_v4();
        let claims = TokenContext {
            project_id: Uuid::new_v4(),
            runtime_id: Some(runtime),
            lease_id: Some(Uuid::new_v4()),
            runtime_generation: Some(Uuid::new_v4()),
        };
        let marker = json!({"state":"pending", "runtimeId":runtime, "leaseAttempt":2,
            "runtimeLeaseId":claims.lease_id, "runtimeGeneration":claims.runtime_generation});
        assert!(matches_fence(&marker, &claims, Some(runtime), 2));
        for altered in [
            TokenContext {
                runtime_id: None,
                ..claims
            },
            TokenContext {
                runtime_id: Some(Uuid::new_v4()),
                ..claims
            },
            TokenContext {
                lease_id: Some(Uuid::new_v4()),
                ..claims
            },
            TokenContext {
                runtime_generation: Some(Uuid::new_v4()),
                ..claims
            },
        ] {
            assert!(!matches_fence(&marker, &altered, Some(runtime), 2));
        }
        assert!(!matches_fence(&marker, &claims, Some(runtime), 3));
        assert!(!matches_fence(&json!({}), &claims, Some(runtime), 2));
    }
}
