use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value as JsonValue};
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
