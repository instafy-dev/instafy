//! GET /me/credentials/requirements says when a used-up hosted AI allowance
//! frees its next prompt. The allowance counts a rolling 24 hours of the
//! person's own managed prompts, so the answer is the moment the prompt that
//! brings the count back under the limit leaves that window.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use chrono::{DateTime, Duration as ChronoDuration, Timelike, Utc};
use httpmock::Method::GET;
use httpmock::MockServer;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, setup_origin_test_pool,
    test_origin_private_key, test_origin_public_key,
};

async fn insert_prompt(
    pool: &crate::config::PgPool,
    user_id: &Uuid,
    created_at: DateTime<Utc>,
    managed: bool,
) -> anyhow::Result<()> {
    let metadata = if managed {
        json!({ "managedAiUsed": true })
    } else {
        json!({})
    };
    pool.get()
        .await?
        .execute(
            "insert into prompts (id, user_id, prompt_text, metadata, created_at)
             values ($1, $2, 'Allowance fixture', $3, $4)",
            &[
                &Uuid::new_v4(),
                user_id,
                &tokio_postgres::types::Json(metadata),
                &created_at,
            ],
        )
        .await?;
    Ok(())
}

#[tokio::test]
async fn requirements_say_when_a_used_up_allowance_frees_its_next_prompt() -> anyhow::Result<()> {
    use futures_util::FutureExt;

    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping managed AI allowance route test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let proxy = MockServer::start_async().await;
    proxy
        .mock_async(|when, then| {
            when.method(GET).path("/healthz");
            then.status(200)
                .json_body(json!({ "backend": "codex", "requiresCredential": false }));
        })
        .await;
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "managed-ai-allowance",
    );
    config.proxy_base_url = Some(proxy.base_url());
    let limit = config.managed_ai_daily_prompt_limit;
    assert!(limit > 1, "the test config needs a daily limit");
    let user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let token = crate::auth::issue_controller_token(&config, &user_id)
        .map_err(|(_, error)| anyhow::anyhow!(error.0.message))?
        .token;
    let app = crate::credentials::router().with_state(build_test_state(pool.clone(), config));

    let requirements = || async {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/me/credentials/requirements")
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 64 * 1024).await?;
        Ok::<Value, anyhow::Error>(serde_json::from_slice::<Value>(&body)?["managedAi"].clone())
    };

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &user_id).await?;
        ensure_test_user(&pool, &other_user_id).await?;
        // Whole seconds, so the stored microseconds match exactly.
        let now = Utc::now().with_nanosecond(0).expect("whole second");

        // None of these count: one left the window, one is someone else's,
        // one did not use hosted AI.
        insert_prompt(&pool, &user_id, now - ChronoDuration::hours(25), true).await?;
        insert_prompt(&pool, &other_user_id, now - ChronoDuration::hours(23), true).await?;
        insert_prompt(&pool, &user_id, now - ChronoDuration::hours(23), false).await?;

        // One short of the limit: a prompt is left and there is no time.
        let oldest = now - ChronoDuration::hours(22);
        for minute in 0..i64::from(limit - 1) {
            insert_prompt(
                &pool,
                &user_id,
                oldest + ChronoDuration::minutes(minute),
                true,
            )
            .await?;
        }
        let managed_ai = requirements().await?;
        assert_eq!(managed_ai["remainingPrompts"], json!(1));
        assert_eq!(managed_ai["available"], json!(true));
        assert!(managed_ai.get("nextAvailableAt").is_none(), "{managed_ai}");

        // The last one: nothing is left, and the oldest counted prompt frees
        // the next slot once it is 24 hours old.
        insert_prompt(&pool, &user_id, now - ChronoDuration::minutes(1), true).await?;
        let managed_ai = requirements().await?;
        assert_eq!(managed_ai["remainingPrompts"], json!(0));
        assert_eq!(managed_ai["available"], json!(false));
        let next_available_at = managed_ai["nextAvailableAt"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("nextAvailableAt missing: {managed_ai}"))?;
        assert_eq!(
            DateTime::parse_from_rfc3339(next_available_at)?.with_timezone(&Utc),
            oldest + ChronoDuration::hours(24)
        );

        // One over the limit (concurrent sends): two must leave the window,
        // so the second oldest decides.
        insert_prompt(&pool, &user_id, now - ChronoDuration::seconds(30), true).await?;
        let managed_ai = requirements().await?;
        let next_available_at = managed_ai["nextAvailableAt"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("nextAvailableAt missing: {managed_ai}"))?;
        assert_eq!(
            DateTime::parse_from_rfc3339(next_available_at)?.with_timezone(&Utc),
            oldest + ChronoDuration::minutes(1) + ChronoDuration::hours(24)
        );
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let cleanup = pool.get().await?;
    let users = vec![user_id, other_user_id];
    cleanup
        .execute("delete from prompts where user_id = any($1)", &[&users])
        .await?;
    cleanup
        .execute("delete from auth.users where id = any($1)", &[&users])
        .await?;
    match outcome {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
