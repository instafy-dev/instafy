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

#[tokio::test]
async fn report_creation_idempotency_is_user_scoped_and_compares_normalized_payloads(
) -> anyhow::Result<()> {
    let state = test_state("support-report-create-idempotency").await?;
    let user_id = Uuid::new_v4();
    let other_user_id = Uuid::new_v4();
    let user_token = token(&state, user_id);
    let other_user_token = token(&state, other_user_id);
    let client_request_id = Uuid::new_v4();
    let png = BASE64.decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    )?;
    let request = json!({
        "message": "  An idempotent customer report  ",
        "details": "  normalized details  ",
        "clientRequestId": client_request_id,
        "metadata": {
            "authorization": "Bearer first-secret",
            "stable": true
        },
        "logs": [{ "password": "first-secret", "event": "failed" }],
        "screenshots": [{
            "fileName": " evidence.png ",
            "mediaType": " image/png ",
            "dataBase64": base64::engine::general_purpose::STANDARD.encode(&png),
            "byteLength": png.len()
        }]
    });
    let created = submit(
        state.clone(),
        &user_token,
        "/support/reports",
        &request.to_string(),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let created_payload = response_json(created).await;

    // Whitespace and values removed by the authoritative redactor normalize to
    // the same persisted request, so a retry returns the original report.
    let mut replay_request = request.clone();
    replay_request["message"] = json!("An idempotent customer report");
    replay_request["details"] = json!("normalized details");
    replay_request["metadata"]["authorization"] = json!("Bearer second-secret");
    replay_request["logs"][0]["password"] = json!("second-secret");
    let replay = submit(
        state.clone(),
        &user_token,
        "/bug-reports",
        &replay_request.to_string(),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(response_json(replay).await, created_payload);

    let mut conflicting_request = request.clone();
    conflicting_request["message"] = json!("Different report content");
    let conflict = submit(
        state.clone(),
        &user_token,
        "/support/reports",
        &conflicting_request.to_string(),
    )
    .await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);

    let other_user = submit(
        state.clone(),
        &other_user_token,
        "/support/reports",
        &request.to_string(),
    )
    .await;
    assert_eq!(other_user.status(), StatusCode::CREATED);
    assert_ne!(response_json(other_user).await["id"], created_payload["id"]);

    let stored_count: i64 = state
        .pool
        .get()
        .await?
        .query_one(
            "select count(*)::bigint from bug_reports where user_id = $1",
            &[&user_id],
        )
        .await?
        .get(0);
    assert_eq!(stored_count, 1);

    let created_report_id = Uuid::parse_str(created_payload["id"].as_str().unwrap())?;
    state
        .pool
        .get()
        .await?
        .execute(
            "insert into bug_report_attachments (
                id, bug_report_id, file_name, media_type, byte_size, content, created_at
             ) values ($1, $2, 'seeded-quota.png', 'image/png', $3, ''::bytea, clock_timestamp())",
            &[
                &Uuid::new_v4(),
                &created_report_id,
                &MAX_CUSTOMER_ATTACHMENT_BYTES_PER_24_HOURS,
            ],
        )
        .await?;

    // A lost successful response can be retried even after another request has
    // consumed the attachment allowance, because replay is checked first.
    let replay_after_quota = submit(
        state.clone(),
        &user_token,
        "/support/reports",
        &replay_request.to_string(),
    )
    .await;
    assert_eq!(replay_after_quota.status(), StatusCode::OK);
    assert_eq!(response_json(replay_after_quota).await, created_payload);

    let mut quota_request = request.clone();
    quota_request["clientRequestId"] = json!(Uuid::new_v4());
    quota_request["message"] = json!("Another report with an attachment");
    let quota_limited = submit(
        state.clone(),
        &user_token,
        "/support/reports",
        &quota_request.to_string(),
    )
    .await;
    assert_eq!(quota_limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response_json(quota_limited).await["message"],
        format!(
            "Support report attachments are limited to {MAX_CUSTOMER_ATTACHMENT_BYTES_PER_24_HOURS} bytes per 24 hours."
        )
    );

    let invalid_id = submit(
        state.clone(),
        &other_user_token,
        "/support/reports",
        r#"{"message":"invalid id","clientRequestId":"not-a-uuid"}"#,
    )
    .await;
    assert_eq!(invalid_id.status(), StatusCode::BAD_REQUEST);

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

#[test]
fn retry_seconds_round_up_instead_of_inviting_an_early_retry() {
    assert_eq!(retry_after_seconds(Duration::ZERO), 1);
    assert_eq!(retry_after_seconds(Duration::from_millis(1)), 1);
    assert_eq!(retry_after_seconds(Duration::from_millis(9_001)), 10);
    assert_eq!(retry_after_seconds(Duration::from_secs(10)), 10);
}

#[tokio::test]
async fn reports_hit_the_durable_twenty_five_per_day_ceiling() -> anyhow::Result<()> {
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

    state.pool.get().await?.execute(
        "update bug_reports set created_at = created_at - interval '10 seconds' where user_id = $1",
        &[&user_id],
    ).await?;
    let limited = submit(
        crate::tests::build_test_state(state.pool.clone(), state.config.clone()),
        &user_token,
        "/support/reports",
        REPORT,
    )
    .await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response_json(limited).await["message"],
        "Support reports are limited to 25 per 24 hours."
    );

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
async fn customer_messages_hit_the_durable_daily_ceiling_but_replays_remain_idempotent(
) -> anyhow::Result<()> {
    let state = test_state("customer-message-daily-limit").await?;
    let user_id = Uuid::new_v4();
    let report_id = Uuid::new_v4();
    let user_token = token(&state, user_id);
    state
        .pool
        .get()
        .await?
        .execute(
            "insert into bug_reports (
                id, user_id, message, status, metadata, logs, customer_last_message_at
             ) values ($1, $2, 'Daily message cap', 'open', '{}'::jsonb, '[]'::jsonb, clock_timestamp())",
            &[&report_id, &user_id],
        )
        .await?;
    state
        .pool
        .get()
        .await?
        .execute(
            "insert into bug_report_messages (
                id, bug_report_id, author_type, author_user_id, body, created_at
             )
             select gen_random_uuid(), $1, 'customer', $2,
                    'seeded customer follow-up ' || ordinal,
                    clock_timestamp() - interval '1 hour'
               from generate_series(1, $3::integer) ordinal",
            &[
                &report_id,
                &user_id,
                &((MAX_CUSTOMER_MESSAGES_PER_24_HOURS - 1) as i32),
            ],
        )
        .await?;

    let client_request_id = Uuid::new_v4();
    let final_allowed = json!({
        "body": "the final message inside the daily allowance",
        "clientRequestId": client_request_id,
    })
    .to_string();
    assert_eq!(
        submit(
            state.clone(),
            &user_token,
            &format!("/support/reports/{report_id}/messages"),
            &final_allowed,
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        submit(
            state.clone(),
            &user_token,
            &format!("/support/reports/{report_id}/messages"),
            &final_allowed,
        )
        .await
        .status(),
        StatusCode::OK
    );

    let first_page = router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!("/support/reports/{report_id}/messages"))
                .header("authorization", format!("Bearer {user_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(first_page.status(), StatusCode::OK);
    let first_page = response_json(first_page).await;
    assert_eq!(first_page["messages"].as_array().map(Vec::len), Some(100));
    assert_eq!(first_page["hasMore"], true);
    let first_cursor = &first_page["nextCursor"];
    let second_page = router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/support/reports/{report_id}/messages?before_created_at={}&before_message_id={}",
                    urlencoding::encode(
                        first_cursor["createdAt"]
                            .as_str()
                            .expect("message cursor createdAt")
                    ),
                    first_cursor["id"].as_str().expect("message cursor id")
                ))
                .header("authorization", format!("Bearer {user_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(second_page.status(), StatusCode::OK);
    let second_page = response_json(second_page).await;
    assert_eq!(second_page["messages"].as_array().map(Vec::len), Some(100));
    assert_eq!(second_page["hasMore"], true);
    let second_cursor = &second_page["nextCursor"];
    let oldest_page = router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/support/reports/{report_id}/messages?before_created_at={}&before_message_id={}",
                    urlencoding::encode(
                        second_cursor["createdAt"]
                            .as_str()
                            .expect("message cursor createdAt")
                    ),
                    second_cursor["id"].as_str().expect("message cursor id")
                ))
                .header("authorization", format!("Bearer {user_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(oldest_page.status(), StatusCode::OK);
    let oldest_page = response_json(oldest_page).await;
    assert_eq!(oldest_page["messages"].as_array().map(Vec::len), Some(50));
    assert_eq!(oldest_page["hasMore"], false);
    assert!(oldest_page["nextCursor"].is_null());

    let incomplete_cursor = router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/support/reports/{report_id}/messages?before_message_id={client_request_id}"
                ))
                .header("authorization", format!("Bearer {user_token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(incomplete_cursor.status(), StatusCode::BAD_REQUEST);

    let limited = submit(
        state.clone(),
        &user_token,
        &format!("/support/reports/{report_id}/messages"),
        r#"{"body":"one message too many"}"#,
    )
    .await;
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        response_json(limited).await["message"],
        "Customer support messages are limited to 250 per 24 hours."
    );

    state
        .pool
        .get()
        .await?
        .execute("delete from bug_reports where id = $1", &[&report_id])
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
