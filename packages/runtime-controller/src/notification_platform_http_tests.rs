//! Real router + PostgreSQL checks; use an isolated, fully migrated database.
use super::*;

struct SimulatedTransport {
    outcomes:
        std::sync::Mutex<std::collections::VecDeque<crate::notifications::DeliveryDisposition>>,
    envelopes: std::sync::Mutex<Vec<serde_json::Value>>,
    refresh_on_expiry: AtomicBool,
}

#[async_trait]
impl crate::notification_platform::NotificationTransport for SimulatedTransport {
    async fn deliver(
        &self,
        state: &AppState,
        _channel: &str,
        endpoint: Uuid,
        _user: Uuid,
        _lease_token: Uuid,
        payload: &crate::notifications::PushNotificationPayload,
    ) -> crate::notifications::DeliveryResult {
        self.envelopes
            .lock()
            .unwrap()
            .push(serde_json::to_value(payload).unwrap());
        let disposition = self
            .outcomes
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected transport request");
        if disposition == crate::notifications::DeliveryDisposition::Expired
            && self.refresh_on_expiry.swap(false, Ordering::SeqCst)
        {
            state
                .pool
                .get()
                .await
                .unwrap()
                .execute(
                    "update web_push_subscriptions set updated_at=updated_at where id=$1",
                    &[&endpoint],
                )
                .await
                .unwrap();
        }
        crate::notifications::DeliveryResult {
            disposition,
            code: "simulated_provider",
        }
    }
}

#[tokio::test]
async fn durable_notification_worker_retries_with_stable_identity_and_safe_payload(
) -> anyhow::Result<()> {
    use crate::notifications::DeliveryDisposition::{Expired, Success, Transient};
    let pool = require_origin_test_pool("durable notification delivery worker").await?;
    let user = Uuid::new_v4();
    let report = Uuid::new_v4();
    let endpoint = Uuid::new_v4();
    ensure_test_user(&pool, &user).await?;
    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "notification-worker",
        ),
    );
    {
        let connection = pool.get().await?;
        connection.execute("insert into web_push_subscriptions(id,user_id,endpoint,p256dh,auth) values($1,$2,$3,'fixture','fixture')", &[&endpoint, &user, &format!("https://push.example.invalid/{endpoint}")]).await?;
        connection.execute("insert into bug_reports(id,user_id,message) values($1,$2,'secret diagnostic report')", &[&report, &user]).await?;
        connection.execute("insert into bug_report_messages(id,bug_report_id,author_type,body) values($1,$2,'support','secret customer-visible reply')", &[&Uuid::new_v4(), &report]).await?;
    }
    let mock = SimulatedTransport {
        outcomes: std::sync::Mutex::new([Transient, Success, Expired, Expired].into()),
        envelopes: std::sync::Mutex::new(Vec::new()),
        refresh_on_expiry: AtomicBool::new(true),
    };
    crate::notification_platform::dispatch_batch_with_transport(&state, &mock).await?;
    {
        let connection = pool.get().await?;
        let job = connection.query_one("select status,attempt_count,last_code,next_attempt_at>clock_timestamp() from notification_delivery_jobs where user_id=$1", &[&user]).await?;
        assert_eq!(job.get::<_, String>(0), "pending");
        assert_eq!(job.get::<_, i32>(1), 1);
        assert!(job.get::<_, bool>(3));
        assert_eq!(connection.query_one("select a.status from notification_delivery_attempts a join notification_delivery_jobs j on j.id=a.job_id where j.user_id=$1", &[&user]).await?.get::<_, String>(0), "retry");
        connection.execute("update notification_delivery_jobs set next_attempt_at=clock_timestamp()-interval '1 second' where user_id=$1", &[&user]).await?;
    }
    crate::notification_platform::dispatch_batch_with_transport(&state, &mock).await?;
    {
        let sent = mock.envelopes.lock().unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(sent[0]["eventId"], sent[1]["eventId"]);
        assert_eq!(sent[0]["accountId"], user.to_string());
        assert_eq!(sent[0]["title"], "Instafy");
        assert_eq!(sent[0]["body"], "You have a new notification.");
        assert_eq!(sent[0]["url"], format!("/studio?supportReportId={report}"));
        assert!(!sent[0].to_string().contains("secret"));
    }
    {
        let connection = pool.get().await?;
        assert_eq!(
            connection
                .query_one(
                    "select status from notification_delivery_jobs where user_id=$1",
                    &[&user]
                )
                .await?
                .get::<_, String>(0),
            "succeeded"
        );
        connection.execute("update bug_reports set status='resolved',resolved_at=clock_timestamp() where id=$1", &[&report]).await?;
    }
    crate::notification_platform::dispatch_batch_with_transport(&state, &mock).await?;
    {
        let connection = pool.get().await?;
        assert_eq!(
            connection
                .query_one(
                    "select count(*) from web_push_subscriptions where id=$1",
                    &[&endpoint]
                )
                .await?
                .get::<_, i64>(0),
            1,
            "a re-registered endpoint must survive an old expiry response"
        );
        connection.execute("insert into bug_report_messages(id,bug_report_id,author_type,body) values($1,$2,'support','Another safe fixture')", &[&Uuid::new_v4(), &report]).await?;
    }
    crate::notification_platform::dispatch_batch_with_transport(&state, &mock).await?;
    {
        let connection = pool.get().await?;
        assert_eq!(
            connection
                .query_one(
                    "select count(*) from web_push_subscriptions where id=$1",
                    &[&endpoint]
                )
                .await?
                .get::<_, i64>(0),
            0
        );
        assert_eq!(connection.query_one("select count(*) from notification_delivery_jobs where user_id=$1 and status='failed'", &[&user]).await?.get::<_, i64>(0), 2);
        assert_eq!(connection.query_one("select count(*) from notification_delivery_attempts a join notification_delivery_jobs j on j.id=a.job_id where j.user_id=$1", &[&user]).await?.get::<_, i64>(0), 4);
        connection
            .execute(
                "delete from notification_events where resource_id=$1",
                &[&report],
            )
            .await?;
        connection
            .execute("delete from bug_reports where id=$1", &[&report])
            .await?;
    }
    cleanup_test_user(&pool, &user).await?;
    Ok(())
}

async fn request(
    app: &axum::Router,
    method: &str,
    path: &str,
    token: &str,
    body: serde_json::Value,
) -> anyhow::Result<(StatusCode, serde_json::Value)> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(if method == "GET" {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })?,
        )
        .await?;
    assert_eq!(response.headers()["cache-control"], "no-store");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
    Ok((
        status,
        serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
    ))
}

#[tokio::test]
async fn durable_notifications_http_support_lifecycle_and_account_isolation() -> anyhow::Result<()>
{
    let pool = require_origin_test_pool("durable notification HTTP lifecycle").await?;
    let owner = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    let report = Uuid::new_v4();
    ensure_test_user(&pool, &owner).await?;
    ensure_test_user(&pool, &outsider).await?;
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "durable-notification-http",
    );
    let owner_token = crate::auth::issue_controller_token(&config, &owner)
        .map_err(|e| controller_error("issue owner token", e))?
        .token;
    let outsider_token = crate::auth::issue_controller_token(&config, &outsider)
        .map_err(|e| controller_error("issue outsider token", e))?
        .token;
    let state = build_test_state(pool.clone(), config);
    let app = crate::notification_platform::router().with_state(state.clone());
    {
        let connection = pool.get().await?;
        connection.execute("insert into bug_reports(id,user_id,message,status) values($1,$2,'Private diagnostic fixture','open')", &[&report, &owner]).await?;
        connection.execute("insert into bug_report_messages(id,bug_report_id,author_type,body) values($1,$2,'support','Sensitive reply must never be projected')", &[&Uuid::new_v4(), &report]).await?;
    }
    let (status, page) = request(
        &app,
        "GET",
        "/me/notifications?view=unread&limit=1",
        &owner_token,
        json!({}),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(page["unreadCount"], 1);
    assert_eq!(page["items"][0]["eventName"], "support.reply");
    assert_eq!(
        page["items"][0]["url"],
        format!("/studio?supportReportId={report}")
    );
    assert!(!page.to_string().contains("Sensitive"));
    assert!(!page.to_string().contains("diagnostic"));
    let event = page["items"][0]["id"].clone();
    let (_, other_page) =
        request(&app, "GET", "/me/notifications", &outsider_token, json!({})).await?;
    assert_eq!(other_page["unreadCount"], 0);
    assert_eq!(
        request(
            &app,
            "POST",
            "/me/notifications/state",
            &outsider_token,
            json!({"id": event,"action":"read"})
        )
        .await?
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/me/notifications/state",
            &owner_token,
            json!({"id": event,"action":"read"})
        )
        .await?
        .0,
        StatusCode::OK
    );
    let (_, read_page) = request(&app, "GET", "/me/notifications", &owner_token, json!({})).await?;
    assert_eq!(read_page["unreadCount"], 0);
    assert!(read_page["items"][0]["readAt"].is_string());
    assert_eq!(
        pool.get()
            .await?
            .query_one(
                "select customer_last_seen_support_at is null from bug_reports where id=$1",
                &[&report]
            )
            .await?
            .get::<_, bool>(0),
        true
    );

    // Disable all external delivery: the durable center must still get resolutions.
    let (_, preferences) = request(&app, "POST", "/me/notifications/preferences", &owner_token,
        json!({"hidePreviews":true,"preferences":[{"category":"support","channel":"web_push","enabled":false},{"category":"support","channel":"apns","enabled":false}]})).await?;
    assert_eq!(preferences["hidePreviews"], true);
    let (_, other_preferences) = request(
        &app,
        "GET",
        "/me/notifications/preferences",
        &outsider_token,
        json!({}),
    )
    .await?;
    assert!(other_preferences["preferences"]
        .as_array()
        .unwrap()
        .iter()
        .all(|preference| preference["enabled"] == true));
    {
        let connection = pool.get().await?;
        connection.execute("update bug_reports set status='resolved',resolved_at=clock_timestamp() where id=$1", &[&report]).await?;
        connection
            .execute(
                "update bug_reports set status='resolved' where id=$1",
                &[&report],
            )
            .await?;
    }
    let (_, resolved) = request(
        &app,
        "GET",
        "/me/notifications?limit=1",
        &owner_token,
        json!({}),
    )
    .await?;
    assert_eq!(resolved["unreadCount"], 1);
    assert_eq!(resolved["items"][0]["eventName"], "support.resolved");
    let cursor = resolved["nextCursor"].as_str().expect("second page");
    let (_, next) = request(
        &app,
        "GET",
        &format!("/me/notifications?limit=1&before={cursor}"),
        &owner_token,
        json!({}),
    )
    .await?;
    assert_eq!(next["items"][0]["id"], event);
    // An old mark-all watermark must leave a newer resolution unread.
    request(
        &app,
        "POST",
        "/me/notifications/read-all",
        &owner_token,
        json!({"before":page["asOf"]}),
    )
    .await?;
    let (_, remaining) = request(
        &app,
        "GET",
        "/me/notifications?view=unread",
        &owner_token,
        json!({}),
    )
    .await?;
    assert_eq!(remaining["unreadCount"], 1);
    {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        transaction
            .execute(
                "update bug_reports set status='open',resolved_at=null where id=$1",
                &[&report],
            )
            .await?;
        transaction.execute("update bug_reports set status='resolved',resolved_at=clock_timestamp() where id=$1", &[&report]).await?;
        transaction.commit().await?;
    }
    let (_, rereso) = request(
        &app,
        "GET",
        "/me/notifications?view=unread",
        &owner_token,
        json!({}),
    )
    .await?;
    assert_eq!(rereso["unreadCount"], 2);
    assert_ne!(rereso["items"][0]["id"], rereso["items"][1]["id"]);
    request(
        &app,
        "POST",
        "/me/notifications/state",
        &owner_token,
        json!({"id":rereso["items"][0]["id"],"action":"archive"}),
    )
    .await?;
    let (_, archived) = request(&app, "GET", "/me/notifications", &owner_token, json!({})).await?;
    assert_eq!(archived["unreadCount"], 1);
    assert_eq!(archived["items"].as_array().unwrap().len(), 2);
    assert_eq!(
        request(
            &app,
            "GET",
            "/me/notifications?before=invalid",
            &owner_token,
            json!({})
        )
        .await?
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/me/notifications/preferences",
            &owner_token,
            json!({"preferences":[{"category":"internal","channel":"email","enabled":true}]})
        )
        .await?
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &app,
            "POST",
            "/me/notifications/preferences",
            &owner_token,
            json!({"unexpected":"x".repeat(9000)})
        )
        .await?
        .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );

    // Ownership revocation hides history immediately, including previously read rows.
    pool.get()
        .await?
        .execute(
            "update bug_reports set user_id=$2 where id=$1",
            &[&report, &outsider],
        )
        .await?;
    let (_, revoked) = request(&app, "GET", "/me/notifications", &owner_token, json!({})).await?;
    assert_eq!(revoked["items"], json!([]));
    let connection = pool.get().await?;
    connection
        .execute(
            "delete from notification_events where resource_id=$1",
            &[&report],
        )
        .await?;
    connection
        .execute("delete from bug_reports where id=$1", &[&report])
        .await?;
    drop(connection);
    cleanup_test_user(&pool, &owner).await?;
    cleanup_test_user(&pool, &outsider).await?;
    Ok(())
}
