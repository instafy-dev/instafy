//! The space's save lock (its workspace lease) after a Stop, on the migrated
//! database.
//!
//! A turn's save takes the space's lease, and a Stop can end the job while
//! that save holds it. The stopped job may still release its own lease, since
//! releasing grants nothing, and its token does nothing else; a save or an
//! Undo that meets a lease whose job has ended ends it at once instead of
//! waiting for it to run out.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::{AppConfig, PgPool, RuntimeProviderConfig};
use crate::origins::{acquire_lease, LeaseAcquireOutcome};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};
use crate::AppState;

/// The hosted provider the machine runs on.
const HOSTED_PROVIDER: &str = "instafy-cloud";

fn test_config(label: &str) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: HOSTED_PROVIDER.to_string(),
        display_name: "Instafy Cloud".to_string(),
        kind: "noop".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: None,
        auth_token: None,
        metadata: None,
    }];
    config
}

fn controller_error(
    context: &str,
    error: (StatusCode, axum::Json<crate::ApiError>),
) -> anyhow::Error {
    let (status, axum::Json(body)) = error;
    anyhow::anyhow!(
        "{context} failed with status {} and message {}",
        status.as_u16(),
        body.message
    )
}

/// An org with one person and one space, and the space's running machine.
struct Space {
    org_id: Uuid,
    project_id: Uuid,
    owner_user_id: Uuid,
    runtime_id: Uuid,
    runtime_lease_id: Uuid,
}

/// One turn of a chat that may write the space: its run and job.
struct Turn {
    conversation_id: Uuid,
    run_id: Uuid,
    job_id: Uuid,
}

impl Space {
    async fn seed(pool: &PgPool, label: &str) -> anyhow::Result<Self> {
        let space = Self {
            org_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            owner_user_id: Uuid::new_v4(),
            runtime_id: Uuid::new_v4(),
            runtime_lease_id: Uuid::new_v4(),
        };
        ensure_test_user(pool, &space.owner_user_id).await?;
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, $3)",
                &[&space.org_id, &format!("{label}-{}", space.org_id), &label],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
                &[&space.org_id, &space.owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, $3, $4, 'customer', 'active')",
                &[
                    &space.project_id,
                    &space.org_id,
                    &label,
                    &space.owner_user_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities
                 ) values ($1, $2, $3, 'ready', 'http://runtime.invalid', $4, 600, now(), $5)",
                &[
                    &space.runtime_id,
                    &space.project_id,
                    &HOSTED_PROVIDER,
                    &format!("lease-after-stop-{}", space.runtime_id),
                    &PgJson(json!({ "agent": true, "origin": true })),
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases (
                     id, project_id, runtime_id, status, requested_at, launched_at
                 ) values ($1, $2, $3, 'active', now(), now())",
                &[
                    &space.runtime_lease_id,
                    &space.project_id,
                    &space.runtime_id,
                ],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&space.runtime_id, &space.runtime_lease_id],
            )
            .await?;
        Ok(space)
    }

    /// A turn of a new chat, running on the space's machine, that may write
    /// the space.
    async fn running_turn(&self, pool: &PgPool) -> anyhow::Result<Turn> {
        let turn = Turn {
            conversation_id: Uuid::new_v4(),
            run_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
        };
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into conversations (id, project_id, created_by, visibility)
                 values ($1, $2, $3, 'private')",
                &[&turn.conversation_id, &self.project_id, &self.owner_user_id],
            )
            .await?;
        connection
            .execute(
                "insert into runs (id, project_id, conversation_id, run_type, status, metadata)
                 values ($1, $2, $3, 'prompt', 'in_progress', $4)",
                &[
                    &turn.run_id,
                    &self.project_id,
                    &turn.conversation_id,
                    &PgJson(json!({ "initiatingUserId": self.owner_user_id })),
                ],
            )
            .await?;
        connection
            .execute(
                "insert into agent_jobs (
                     id, project_id, conversation_id, run_id, status, payload,
                     lease_attempts, leased_at, lease_expires_at, leased_by_runtime_id
                 ) values (
                     $1, $2, $3, $4, 'leased', $5, 1, now(), now() + interval '2 minutes', $6
                 )",
                &[
                    &turn.job_id,
                    &self.project_id,
                    &turn.conversation_id,
                    &turn.run_id,
                    &PgJson(json!({
                        "user_id": self.owner_user_id,
                        "conversation_id": turn.conversation_id,
                        "prompt_text": "Add a short section to the page.",
                        "writeIntent": true,
                        "metadata": { "agent": { "handle": "octo" } },
                    })),
                    &self.runtime_id,
                ],
            )
            .await?;
        Ok(turn)
    }

    /// The person's Stop of `turn`, as `/conversations/:id/stop` makes it.
    async fn stop(&self, state: &AppState, turn: &Turn) -> anyhow::Result<()> {
        let mut connection = state.pool.get().await?;
        let transaction = connection.transaction().await?;
        crate::conversations::cancel_jobs_with_notice(
            &state.config,
            &transaction,
            &self.project_id,
            &turn.conversation_id,
            None,
            &[(turn.job_id, Some(turn.run_id))],
            "Stopped",
            None,
        )
        .await
        .map_err(|error| controller_error("stop the turn", error))?;
        transaction.commit().await?;
        Ok(())
    }

    /// The workspace token the controller gives `turn`'s job at lease
    /// (`mint_job_workspace_token`).
    fn job_token(&self, config: &AppConfig, turn: &Turn) -> anyhow::Result<String> {
        Ok(mint_scoped_token(
            config,
            ScopedTokenRequest {
                audience: self.runtime_id.to_string(),
                subject: self.owner_user_id.to_string(),
                project_id: self.project_id.to_string(),
                origin_id: None,
                runtime_id: Some(self.runtime_id.to_string()),
                protocol: None,
                scopes: vec![
                    crate::origins::JOB_WORKSPACE_LEASE_WRITE_SCOPE.to_string(),
                    crate::origins::JOB_ORIGIN_TOKEN_MINT_SCOPE.to_string(),
                ],
                lease_id: Some(self.runtime_lease_id.to_string()),
                run_id: Some(turn.run_id.to_string()),
                prefer_runtime: None,
                ttl_seconds: Some(3600),
            },
        )
        .map_err(|error| controller_error("mint the job's workspace token", error))?
        .token)
    }

    /// The body of a lease call by `turn`'s job, as the runtime sends it
    /// (`workspace_commit.rs`).
    fn job_lease_body(&self, turn: &Turn, lease_id: Option<&str>) -> JsonValue {
        let mut body = json!({
            "projectId": self.project_id,
            "runtimeId": self.runtime_id,
            "leaseSeconds": 120,
            "metadata": {
                "source": "runtime-agent",
                "jobId": turn.job_id,
                "runId": turn.run_id,
                "runtimeId": self.runtime_id,
            },
        });
        if let Some(lease_id) = lease_id {
            body["leaseId"] = json!(lease_id);
            body["status"] = json!("released");
        }
        body
    }
}

async fn post(
    state: &AppState,
    token: &str,
    uri: &str,
    body: JsonValue,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let response = crate::origins::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(uri)
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(body.to_string()))?,
        )
        .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    let body = serde_json::from_slice(&bytes).unwrap_or(JsonValue::Null);
    Ok((status, body))
}

async fn lease_status(pool: &PgPool, lease_id: &str) -> anyhow::Result<String> {
    let lease_id = Uuid::parse_str(lease_id)?;
    Ok(pool
        .get()
        .await?
        .query_one(
            "select status from workspace_leases where id = $1",
            &[&lease_id],
        )
        .await?
        .get(0))
}

fn lease_id_of(body: &JsonValue) -> anyhow::Result<String> {
    body["leaseId"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("no lease id in {body}"))
}

#[tokio::test]
async fn a_stopped_job_releases_its_own_save_lock_and_nothing_else() -> anyhow::Result<()> {
    let label = "lease-after-stop-release";
    let pool = require_origin_test_pool(label).await?;
    let space = Space::seed(&pool, label).await?;
    let fixture = SharedDbFixture {
        organizations: vec![space.org_id],
        projects: vec![space.project_id],
    };
    let body_pool = pool.clone();
    with_shared_db_fixture(fixture, async move {
        let pool = body_pool;
        let config = test_config(label);
        let state = build_test_state(pool.clone(), config.clone());
        let turn = space.running_turn(&pool).await?;
        let token = space.job_token(&config, &turn)?;

        // The turn's save takes the space's lease.
        let (status, body) = post(
            &state,
            &token,
            "/lease/acquire",
            space.job_lease_body(&turn, None),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let lease_id = lease_id_of(&body)?;

        // The Stop lands during that save.
        space.stop(&state, &turn).await?;

        // The ended job's token takes, renews and mints nothing.
        let (status, body) = post(
            &state,
            &token,
            "/lease/acquire",
            space.job_lease_body(&turn, None),
        )
        .await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body["message"], "job token is no longer active");
        let mut renew = space.job_lease_body(&turn, Some(&lease_id));
        renew.as_object_mut().expect("body").remove("status");
        let (status, body) = post(&state, &token, "/lease/renew", renew).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        let (status, body) = post(
            &state,
            &token,
            "/access_token",
            json!({
                "projectId": space.project_id,
                "protocol": "http",
                "scopes": ["fs.write"],
                "leaseId": lease_id,
                "preferRuntime": space.runtime_id,
            }),
        )
        .await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(lease_status(&pool, &lease_id).await?, "active");

        // It releases the lease its save took.
        let (status, body) = post(
            &state,
            &token,
            "/lease/release",
            space.job_lease_body(&turn, Some(&lease_id)),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(lease_status(&pool, &lease_id).await?, "released");

        // But no other: not another chat's turn's, still saving on the same
        // machine, whichever job the release claims to be,
        let running = space.running_turn(&pool).await?;
        let running_token = space.job_token(&config, &running)?;
        let (status, body) = post(
            &state,
            &running_token,
            "/lease/acquire",
            space.job_lease_body(&running, None),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let running_lease = lease_id_of(&body)?;
        for claimed in [&turn, &running] {
            let (status, body) = post(
                &state,
                &token,
                "/lease/release",
                space.job_lease_body(claimed, Some(&running_lease)),
            )
            .await?;
            assert!(
                matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN),
                "{status} {body}"
            );
        }
        assert_eq!(lease_status(&pool, &running_lease).await?, "active");
        let (status, body) = post(
            &state,
            &running_token,
            "/lease/release",
            space.job_lease_body(&running, Some(&running_lease)),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");

        // and not a person's.
        let person_lease = match acquire_lease(
            &pool,
            &space.project_id,
            Some(&space.owner_user_id),
            Some(&space.runtime_id),
            90,
            None,
        )
        .await?
        {
            LeaseAcquireOutcome::Granted(lease) => lease.id.to_string(),
            other => anyhow::bail!("expected the person's lease, got {other:?}"),
        };
        let (status, body) = post(
            &state,
            &token,
            "/lease/release",
            space.job_lease_body(&turn, Some(&person_lease)),
        )
        .await?;
        assert!(
            matches!(status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN),
            "{status} {body}"
        );
        assert_eq!(lease_status(&pool, &person_lease).await?, "active");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_save_or_an_undo_that_meets_an_ended_jobs_lock_goes_ahead_at_once() -> anyhow::Result<()>
{
    let label = "lease-after-stop-takeover";
    let pool = require_origin_test_pool(label).await?;
    let space = Space::seed(&pool, label).await?;
    let fixture = SharedDbFixture {
        organizations: vec![space.org_id],
        projects: vec![space.project_id],
    };
    let body_pool = pool.clone();
    with_shared_db_fixture(fixture, async move {
        let pool = body_pool;
        let config = test_config(label);
        let state = build_test_state(pool.clone(), config.clone());

        // A running turn's save lock still keeps a person's Undo waiting.
        let saving = space.running_turn(&pool).await?;
        let saving_token = space.job_token(&config, &saving)?;
        let (status, body) = post(
            &state,
            &saving_token,
            "/lease/acquire",
            space.job_lease_body(&saving, None),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let saving_lease = lease_id_of(&body)?;
        let undo = acquire_lease(
            &pool,
            &space.project_id,
            Some(&space.owner_user_id),
            None,
            90,
            None,
        )
        .await?;
        assert!(
            matches!(undo, LeaseAcquireOutcome::Conflict { .. }),
            "{undo:?}"
        );

        // Once a Stop ended that turn, its lock is nobody's: the Undo takes
        // the lease at once and the old lock is ended.
        space.stop(&state, &saving).await?;
        let undo = acquire_lease(
            &pool,
            &space.project_id,
            Some(&space.owner_user_id),
            None,
            90,
            None,
        )
        .await?;
        let undo_lease = match undo {
            LeaseAcquireOutcome::Granted(lease) => lease.id.to_string(),
            other => anyhow::bail!("an ended job's lock kept the Undo waiting: {other:?}"),
        };
        assert_eq!(lease_status(&pool, &saving_lease).await?, "released");
        crate::origins::release_lease(
            &pool,
            &Uuid::parse_str(&undo_lease)?,
            &space.project_id,
            Some(&space.owner_user_id),
            None,
            "released",
        )
        .await?;

        // So does another turn's save that meets a stopped turn's lock.
        let stopped = space.running_turn(&pool).await?;
        let stopped_token = space.job_token(&config, &stopped)?;
        let (status, body) = post(
            &state,
            &stopped_token,
            "/lease/acquire",
            space.job_lease_body(&stopped, None),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let stopped_lease = lease_id_of(&body)?;
        space.stop(&state, &stopped).await?;
        let next = space.running_turn(&pool).await?;
        let next_token = space.job_token(&config, &next)?;
        let (status, body) = post(
            &state,
            &next_token,
            "/lease/acquire",
            space.job_lease_body(&next, None),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(lease_status(&pool, &stopped_lease).await?, "released");
        Ok(())
    })
    .await
}

/// A running turn's save lock is that turn's alone. The person's own Studio
/// on the same machine (an Undo bringing the machine's folder to the saved
/// version, say) used to take it over as a renewal of "their" lease, and
/// release it when done, under the save; another of their turns did the
/// same. Now each waits for it, as anyone else does, and only that turn
/// renews it.
#[tokio::test]
async fn a_running_turns_save_lock_is_never_taken_over_by_the_same_person() -> anyhow::Result<()> {
    let label = "lease-no-takeover";
    let pool = require_origin_test_pool(label).await?;
    let space = Space::seed(&pool, label).await?;
    let fixture = SharedDbFixture {
        organizations: vec![space.org_id],
        projects: vec![space.project_id],
    };
    let body_pool = pool.clone();
    with_shared_db_fixture(fixture, async move {
        let pool = body_pool;
        let config = test_config(label);
        let state = build_test_state(pool.clone(), config.clone());
        let saving = space.running_turn(&pool).await?;
        let saving_token = space.job_token(&config, &saving)?;
        let (status, body) = post(
            &state,
            &saving_token,
            "/lease/acquire",
            space.job_lease_body(&saving, None),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let saving_lease = lease_id_of(&body)?;

        // The person, on the same machine, waits.
        let person = acquire_lease(
            &pool,
            &space.project_id,
            Some(&space.owner_user_id),
            Some(&space.runtime_id),
            90,
            None,
        )
        .await?;
        match person {
            LeaseAcquireOutcome::Conflict { holder } => {
                assert_eq!(holder.id.to_string(), saving_lease)
            }
            other => anyhow::bail!("the person took over a running save's lock: {other:?}"),
        }

        // So does another of their turns on that machine.
        let other = space.running_turn(&pool).await?;
        let other_token = space.job_token(&config, &other)?;
        let (status, body) = post(
            &state,
            &other_token,
            "/lease/acquire",
            space.job_lease_body(&other, None),
        )
        .await?;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");

        // The saving turn's own next save renews its lock, which is still its own.
        let (status, body) = post(
            &state,
            &saving_token,
            "/lease/acquire",
            space.job_lease_body(&saving, None),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(lease_id_of(&body)?, saving_lease);
        assert_eq!(lease_status(&pool, &saving_lease).await?, "active");
        let metadata: JsonValue = pool
            .get()
            .await?
            .query_one(
                "select metadata from workspace_leases where id = $1",
                &[&Uuid::parse_str(&saving_lease)?],
            )
            .await?
            .get(0);
        assert_eq!(metadata["jobId"], json!(saving.job_id));
        let (status, body) = post(
            &state,
            &saving_token,
            "/lease/release",
            space.job_lease_body(&saving, Some(&saving_lease)),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");

        // A person's own lease is still theirs to renew, and no turn of theirs
        // takes it over either.
        let person_lease = match acquire_lease(
            &pool,
            &space.project_id,
            Some(&space.owner_user_id),
            Some(&space.runtime_id),
            90,
            None,
        )
        .await?
        {
            LeaseAcquireOutcome::Granted(lease) => lease.id,
            other => anyhow::bail!("expected the person's lease, got {other:?}"),
        };
        match acquire_lease(
            &pool,
            &space.project_id,
            Some(&space.owner_user_id),
            Some(&space.runtime_id),
            90,
            None,
        )
        .await?
        {
            LeaseAcquireOutcome::Renewed(lease) => assert_eq!(lease.id, person_lease),
            other => anyhow::bail!("expected the person to renew their lease, got {other:?}"),
        }
        let (status, body) = post(
            &state,
            &other_token,
            "/lease/acquire",
            space.job_lease_body(&other, None),
        )
        .await?;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(
            lease_status(&pool, &person_lease.to_string()).await?,
            "active"
        );
        Ok(())
    })
    .await
}
