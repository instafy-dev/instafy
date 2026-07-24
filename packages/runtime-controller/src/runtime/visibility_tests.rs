use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value as JsonValue};
use tokio::time::timeout;
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::tests::{
    build_app_config, build_test_state, setup_origin_test_pool, test_origin_private_key,
    test_origin_public_key,
};

async fn ensure_test_user(pool: &crate::config::PgPool, user_id: Uuid) -> anyhow::Result<()> {
    let instance_id = Uuid::nil();
    let email = format!("runtime-visibility-test+{user_id}@example.com");
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into auth.users (
                instance_id,
                id,
                aud,
                role,
                email,
                encrypted_password,
                email_confirmed_at,
                last_sign_in_at,
                confirmation_token,
                recovery_token,
                email_change_token_new,
                email_change,
                raw_app_meta_data,
                raw_user_meta_data,
                is_super_admin,
                created_at,
                updated_at
            ) values (
                $1,
                $2,
                'authenticated',
                'authenticated',
                $3,
                'test-secret',
                now(),
                now(),
                '',
                '',
                '',
                '',
                '{}'::jsonb,
                '{}'::jsonb,
                false,
                now(),
                now()
            )
            on conflict (id) do nothing",
            &[&instance_id, &user_id, &email],
        )
        .await?;
    Ok(())
}

fn private_runtime_capabilities(owner_user_id: Uuid) -> JsonValue {
    json!({
        "_instafySelfHostedAccess": {
            "mode": "private",
            "ownerUserId": owner_user_id.to_string(),
        }
    })
}

async fn insert_private_runtime(
    pool: &crate::config::PgPool,
    project_id: Uuid,
    runtime_id: Uuid,
    owner_user_id: Uuid,
    last_seen_offset_seconds: i32,
    updated_offset_seconds: i32,
) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into runtimes (
                 id, project_id, provider, status, endpoint_url,
                 idle_ttl_seconds, last_seen_at, updated_at, capabilities, display_name
             ) values (
                 $1, $2, 'self-hosted', 'ready', 'http://127.0.0.1:8787',
                 600,
                 now() + ($4::integer * interval '1 second'),
                 now() + ($5::integer * interval '1 second'),
                 $3,
                 'Private workstation'
             )",
            &[
                &runtime_id,
                &project_id,
                &PgJson(private_runtime_capabilities(owner_user_id)),
                &last_seen_offset_seconds,
                &updated_offset_seconds,
            ],
        )
        .await?;
    Ok(())
}

async fn cleanup_visibility_test(
    pool: &crate::config::PgPool,
    project_id: Uuid,
    user_ids: &[Uuid],
) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .execute("delete from projects where id = $1", &[&project_id])
        .await?;
    for user_id in user_ids {
        connection
            .execute("delete from auth.users where id = $1", &[user_id])
            .await?;
    }
    Ok(())
}

#[tokio::test]
async fn desktop_owner_can_fence_and_resume_exact_private_runtime() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping desktop runtime drain test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let teammate_user_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let job_id = Uuid::new_v4();
    ensure_test_user(&pool, owner_user_id).await?;
    ensure_test_user(&pool, teammate_user_id).await?;

    let connection = pool.get().await?;
    connection
        .execute(
            "insert into projects (id, owner_user_id, project_type, status)
             values ($1, $2, 'customer', 'active')",
            &[&project_id, &owner_user_id],
        )
        .await?;
    connection
        .execute(
            "insert into project_memberships (project_id, user_id, role)
             values ($1, $2, 'builder')",
            &[&project_id, &teammate_user_id],
        )
        .await?;
    insert_private_runtime(&pool, project_id, runtime_id, owner_user_id, 0, 0).await?;
    drop(connection);

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "desktop-runtime-drain",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| anyhow::anyhow!("failed to issue owner token: {error:?}"))?
        .token;
    let teammate_token = crate::auth::issue_controller_token(&config, &teammate_user_id)
        .map_err(|error| anyhow::anyhow!("failed to issue teammate token: {error:?}"))?
        .token;
    let state = build_test_state(pool.clone(), config);
    let app = super::router().with_state(state.clone());
    let drain_path = format!("/projects/{project_id}/runtime/{runtime_id}/drain");

    let unauthorized_response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(&drain_path)
                .header("authorization", format!("Bearer {teammate_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(unauthorized_response.status(), StatusCode::FORBIDDEN);

    // Model the lease endpoint's FOR SHARE runtime fence. If a lease already
    // won the lock, drain must wait for that transaction and then count the
    // newly leased job before answering; it cannot report a false idle state.
    let mut lease_connection = pool.get().await?;
    let lease_transaction = lease_connection.transaction().await?;
    let lease_status: String = lease_transaction
        .query_one(
            "select status from runtimes where id = $1 and project_id = $2 for share",
            &[&runtime_id, &project_id],
        )
        .await?
        .get(0);
    assert_eq!(lease_status, "ready");

    let mut drain_task = tokio::spawn(
        app.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri(&drain_path)
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::empty())?,
        ),
    );
    assert!(
        timeout(std::time::Duration::from_millis(150), &mut drain_task)
            .await
            .is_err(),
        "drain must serialize behind a lease transaction holding the runtime"
    );
    lease_transaction
        .execute(
            "insert into agent_jobs (
                 id, project_id, status, payload, priority,
                 leased_by_runtime_id, leased_at, lease_expires_at
             ) values ($1, $2, 'leased', $3, 10, $4, now(), now() + interval '5 minutes')",
            &[
                &job_id,
                &project_id,
                &PgJson(json!({ "prompt_text": "finish before restart" })),
                &runtime_id,
            ],
        )
        .await?;
    lease_transaction.commit().await?;
    let drain_response = timeout(std::time::Duration::from_secs(2), drain_task).await???;
    assert_eq!(drain_response.status(), StatusCode::OK);
    let body = to_bytes(drain_response.into_body(), usize::MAX).await?;
    let payload: JsonValue = serde_json::from_slice(&body)?;
    assert_eq!(payload["ok"], true);
    assert_eq!(payload["contractVersion"], 1);
    assert_eq!(payload["runtimeId"], runtime_id.to_string());
    assert_eq!(payload["status"], "draining");
    assert_eq!(payload["activeJobCount"], 1);
    assert!(payload["drainExpiresAt"].as_str().is_some());

    let connection = pool.get().await?;
    let status: String = connection
        .query_one("select status from runtimes where id = $1", &[&runtime_id])
        .await?
        .get(0);
    assert_eq!(status, "draining");
    drop(connection);

    let resume_response = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/projects/{project_id}/runtime/{runtime_id}/resume"
                ))
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(resume_response.status(), StatusCode::OK);

    let connection = pool.get().await?;
    let status: String = connection
        .query_one("select status from runtimes where id = $1", &[&runtime_id])
        .await?
        .get(0);
    assert_eq!(status, "ready");
    // A dead runtime whose last heartbeat predates the final drain renewal
    // must not become schedulable merely because the renewable fence expires.
    connection
        .execute(
            "update runtimes
             set status = 'draining',
                 drain_expires_at = now() - interval '1 second',
                 last_seen_at = now() - interval '90 seconds'
             where id = $1",
            &[&runtime_id],
        )
        .await?;
    drop(connection);

    super::sweeps::resume_expired_runtime_drains(&state).await?;
    let connection = pool.get().await?;
    let fenced = connection
        .query_one(
            "select status, drain_expires_at from runtimes where id = $1",
            &[&runtime_id],
        )
        .await?;
    assert_eq!(fenced.get::<_, String>("status"), "draining");
    assert!(fenced
        .get::<_, Option<chrono::DateTime<chrono::Utc>>>("drain_expires_at")
        .is_some());
    connection
        .execute(
            "update runtimes set last_seen_at = now() where id = $1",
            &[&runtime_id],
        )
        .await?;
    drop(connection);

    // Conversely, a detached runtime that kept heartbeating after Electron
    // disappeared should recover automatically once the fence expires.
    super::sweeps::resume_expired_runtime_drains(&state).await?;
    let connection = pool.get().await?;
    let recovered = connection
        .query_one(
            "select status, drain_expires_at from runtimes where id = $1",
            &[&runtime_id],
        )
        .await?;
    assert_eq!(recovered.get::<_, String>("status"), "ready");
    assert!(recovered
        .get::<_, Option<chrono::DateTime<chrono::Utc>>>("drain_expires_at")
        .is_none());
    drop(connection);

    cleanup_visibility_test(&pool, project_id, &[owner_user_id, teammate_user_id]).await?;
    Ok(())
}

#[tokio::test]
async fn runtime_status_filters_private_rows_before_applying_response_cap() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping private runtime status starvation test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let teammate_user_id = Uuid::new_v4();
    let owner_runtime_id = Uuid::new_v4();
    ensure_test_user(&pool, owner_user_id).await?;
    ensure_test_user(&pool, teammate_user_id).await?;

    pool.get()
        .await?
        .execute(
            "insert into projects (id, owner_user_id, project_type, status)
             values ($1, $2, 'customer', 'active')",
            &[&project_id, &owner_user_id],
        )
        .await?;

    // The owner's row is deliberately older than the endpoint's former SQL
    // limit. Twenty-five inaccessible teammate rows must not consume the
    // public 20-row response budget before ownership filtering runs.
    insert_private_runtime(
        &pool,
        project_id,
        owner_runtime_id,
        owner_user_id,
        -30,
        -3_600,
    )
    .await?;
    for offset in 0..25 {
        insert_private_runtime(
            &pool,
            project_id,
            Uuid::new_v4(),
            teammate_user_id,
            offset,
            offset,
        )
        .await?;
    }

    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "private-runtime-status-starvation",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner_user_id)
        .map_err(|error| anyhow::anyhow!("failed to issue owner token: {error:?}"))?
        .token;
    let response = super::router()
        .with_state(build_test_state(pool.clone(), config))
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/projects/{project_id}/runtime/status"))
                .header("authorization", format!("Bearer {owner_token}"))
                .body(Body::empty())?,
        )
        .await?;

    assert_eq!(response.status(), StatusCode::OK);
    let payload: JsonValue =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
    let visible_runtimes = payload["runtimes"]
        .as_array()
        .expect("runtime status returns an array");
    assert_eq!(
        visible_runtimes.len(),
        1,
        "inaccessible private rows must be removed before the response cap"
    );
    assert_eq!(
        visible_runtimes[0]["runtimeId"],
        owner_runtime_id.to_string()
    );
    assert_eq!(visible_runtimes[0]["isPrivateSelfHosted"], true);

    cleanup_visibility_test(&pool, project_id, &[owner_user_id, teammate_user_id]).await?;
    Ok(())
}

#[tokio::test]
async fn runtime_inference_filters_private_rows_before_selecting_candidate() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping private runtime inference starvation test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let project_id = Uuid::new_v4();
    let owner_user_id = Uuid::new_v4();
    let teammate_user_id = Uuid::new_v4();
    let owner_runtime_id = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "insert into projects (id, project_type, status)
             values ($1, 'customer', 'active')",
            &[&project_id],
        )
        .await?;

    insert_private_runtime(
        &pool,
        project_id,
        owner_runtime_id,
        owner_user_id,
        -30,
        -3_600,
    )
    .await?;
    // More rows than the former eight-row inference limit, all newer and all
    // private to a different collaborator.
    for offset in 0..12 {
        insert_private_runtime(
            &pool,
            project_id,
            Uuid::new_v4(),
            teammate_user_id,
            offset,
            offset,
        )
        .await?;
    }

    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "private-runtime-inference",
        ),
    );
    let inferred =
        crate::workspace::infer_runtime_candidate(&state, &project_id, Some(owner_user_id), false)
            .await
            .map_err(|(status, body)| {
                anyhow::anyhow!("runtime inference failed ({status}): {}", body.0.message)
            })?
            .expect("owner's viable private runtime must remain inferable");
    assert_eq!(inferred.id, owner_runtime_id);

    cleanup_visibility_test(&pool, project_id, &[]).await?;
    Ok(())
}
