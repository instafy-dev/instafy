use super::*;
use axum::body::Body;
use axum::http::Request;
use tower::ServiceExt;

async fn test_state(name: &str) -> anyhow::Result<AppState> {
    let pool = crate::tests::require_origin_test_pool(name).await?;
    let config = crate::tests::build_app_config(
        crate::tests::test_origin_private_key(),
        crate::tests::test_origin_public_key(),
        name,
    );
    ensure_bug_report_tables(&pool)
        .await
        .map_err(|error| anyhow::anyhow!(error.1 .0.message))?;
    Ok(crate::tests::build_test_state(pool, config))
}

fn token(state: &AppState, user_id: Uuid) -> String {
    crate::auth::issue_controller_token(&state.config, &user_id)
        .expect("issue user session")
        .token
}

async fn submit(state: AppState, token: &str, path: &str, body: &str) -> axum::response::Response {
    router()
        .with_state(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header("content-type", "application/json")
                .header("authorization", format!("Bearer {token}"))
                .body(Body::from(body.to_owned()))
                .expect("report request"),
        )
        .await
        .expect("report response")
}

async fn response_json(response: axum::response::Response) -> JsonValue {
    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap()
}

const REPORT: &str = r#"{"message":"Rate-limit regression report"}"#;

fn assert_short_retry(message: &JsonValue) {
    let seconds = message
        .as_str()
        .unwrap()
        .rsplit_once(" in ")
        .unwrap()
        .1
        .strip_suffix("s.")
        .unwrap()
        .parse::<u64>()
        .unwrap();
    assert!((1..=10).contains(&seconds));
}

#[test]
fn retry_seconds_round_up_instead_of_inviting_an_early_retry() {
    assert_eq!(retry_after_seconds(Duration::ZERO), 1);
    assert_eq!(retry_after_seconds(Duration::from_millis(1)), 1);
    assert_eq!(retry_after_seconds(Duration::from_millis(9_001)), 10);
    assert_eq!(retry_after_seconds(Duration::from_secs(10)), 10);
}

#[tokio::test]
async fn paced_reports_have_no_five_report_or_daily_twenty_report_ceiling() -> anyhow::Result<()> {
    let state = test_state("paced-report-cooldown").await?;
    let user_id = Uuid::new_v4();
    let user_token = token(&state, user_id);

    for ordinal in 0..25 {
        // Advance persisted history by one ten-second interval without making
        // this regression sleep four minutes. Each request has an independent
        // controller limiter; the database remains the acceptance authority.
        state.pool.get().await?.execute(
            "update bug_reports set created_at = created_at - interval '10 seconds' where user_id = $1",
            &[&user_id],
        ).await?;
        let controller = crate::tests::build_test_state(state.pool.clone(), state.config.clone());
        let path = ["/support/reports", "/bug-reports", "/bug-reports?mine=true"][ordinal % 3];
        let response = submit(controller, &user_token, path, REPORT).await;
        assert_eq!(
            response.status(),
            StatusCode::CREATED,
            "paced report {ordinal}: {}",
            response_json(response).await
        );
    }

    let count: i64 = state
        .pool
        .get()
        .await?
        .query_one(
            "select count(*) from bug_reports where user_id = $1",
            &[&user_id],
        )
        .await?
        .get(0);
    assert_eq!(count, 25);
    state
        .pool
        .get()
        .await?
        .execute("delete from bug_reports where user_id = $1", &[&user_id])
        .await?;
    Ok(())
}

#[tokio::test]
async fn same_controller_accepts_more_than_five_paced_legacy_reports() -> anyhow::Result<()> {
    let state = test_state("same-controller-report-cooldown").await?;
    let user_id = Uuid::new_v4();
    let user_token = token(&state, user_id);
    for ordinal in 0..6 {
        state.pool.get().await?.execute(
            "update bug_reports set created_at = created_at - interval '10 seconds' where user_id = $1",
            &[&user_id],
        ).await?;
        let response = submit(state.clone(), &user_token, "/bug-reports", REPORT).await;
        assert_eq!(
            response.status(),
            StatusCode::CREATED,
            "paced legacy report {ordinal}"
        );
    }
    state
        .pool
        .get()
        .await?
        .execute("delete from bug_reports where user_id = $1", &[&user_id])
        .await?;
    Ok(())
}

#[tokio::test]
async fn accepted_cooldown_is_shared_across_endpoints_controllers_and_isolated_per_user(
) -> anyhow::Result<()> {
    let state = test_state("shared-report-cooldown").await?;
    let user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let user_token = token(&state, user_id);
    let other_token = token(&state, other_user_id);
    assert_eq!(
        submit(state.clone(), &user_token, "/support/reports", REPORT)
            .await
            .status(),
        StatusCode::CREATED
    );

    let second_controller =
        crate::tests::build_test_state(state.pool.clone(), state.config.clone());
    let duplicate = submit(
        second_controller.clone(),
        &user_token,
        "/bug-reports",
        REPORT,
    )
    .await;
    assert_eq!(duplicate.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_short_retry(&response_json(duplicate).await["message"]);
    assert_eq!(
        submit(
            second_controller.clone(),
            &other_token,
            "/bug-reports",
            REPORT
        )
        .await
        .status(),
        StatusCode::CREATED
    );

    // Just before expiry, fractional seconds must be rounded up.
    state.pool.get().await?.execute(
        "update bug_reports set created_at = clock_timestamp() - interval '9.1 seconds' where user_id = $1",
        &[&user_id],
    ).await?;
    let early = submit(
        second_controller.clone(),
        &user_token,
        "/support/reports",
        REPORT,
    )
    .await;
    assert_eq!(early.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response_json(early).await["message"],
        "Too many bug reports. Try again in 1s."
    );

    state.pool.get().await?.execute(
        "update bug_reports set created_at = clock_timestamp() - interval '10 seconds' where user_id = $1",
        &[&user_id],
    ).await?;
    assert_eq!(
        submit(second_controller, &user_token, "/bug-reports", REPORT)
            .await
            .status(),
        StatusCode::CREATED
    );
    state
        .pool
        .get()
        .await?
        .execute(
            "delete from bug_reports where user_id = $1 or user_id = $2",
            &[&user_id, &other_user_id],
        )
        .await?;
    Ok(())
}

#[tokio::test]
async fn attempt_budgets_recover_after_ten_seconds_on_both_routes() -> anyhow::Result<()> {
    let state = test_state("report-attempt-cooldown").await?;
    let support_token = token(&state, Uuid::new_v4());
    let legacy_token = token(&state, Uuid::new_v4());
    for (path, user_token, attempts) in [
        ("/support/reports", &support_token, 5),
        ("/bug-reports", &legacy_token, 30),
    ] {
        for _ in 0..attempts {
            assert_eq!(
                submit(state.clone(), user_token, path, r#"{"message":""}"#)
                    .await
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
        let limited = submit(state.clone(), user_token, path, r#"{"message":""}"#).await;
        assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_short_retry(&response_json(limited).await["message"]);
    }
    tokio::time::sleep(Duration::from_millis(10_050)).await;
    for (path, user_token) in [
        ("/support/reports", &support_token),
        ("/bug-reports", &legacy_token),
    ] {
        assert_eq!(
            submit(state.clone(), user_token, path, r#"{"message":""}"#)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    Ok(())
}

#[tokio::test]
async fn concurrent_controllers_only_accept_one_report_after_the_user_lock() -> anyhow::Result<()> {
    let state = test_state("concurrent-report-cooldown").await?;
    let user_id = Uuid::new_v4();
    let user_token = token(&state, user_id);
    let second_state = crate::tests::build_test_state(state.pool.clone(), state.config.clone());
    let mut connection = state.pool.get().await?;
    let blocker = connection.transaction().await?;
    blocker
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1::text, 0))",
            &[&user_id.to_string()],
        )
        .await?;
    let first = tokio::spawn({
        let state = state.clone();
        let token = user_token.clone();
        async move { submit(state, &token, "/support/reports", REPORT).await }
    });
    let second =
        tokio::spawn(
            async move { submit(second_state, &user_token, "/bug-reports", REPORT).await },
        );

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let waiting: i64 = state.pool.get().await?.query_one(
                "select count(*) from pg_stat_activity where datname = current_database() and wait_event = 'advisory'",
                &[],
            ).await?.get(0);
            if waiting >= 2 { break Ok::<_, anyhow::Error>(()); }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await??;
    blocker.commit().await?;
    drop(connection);
    let mut statuses = vec![
        first.await?.status().as_u16(),
        second.await?.status().as_u16(),
    ];
    statuses.sort_unstable();
    assert_eq!(statuses, vec![201, 429]);
    let count: i64 = state
        .pool
        .get()
        .await?
        .query_one(
            "select count(*) from bug_reports where user_id = $1",
            &[&user_id],
        )
        .await?
        .get(0);
    assert_eq!(count, 1);
    state
        .pool
        .get()
        .await?
        .execute("delete from bug_reports where user_id = $1", &[&user_id])
        .await?;
    Ok(())
}
