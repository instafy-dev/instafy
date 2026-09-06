//! Report-version and notification races exercised through the real router and database.
use super::*;
use chrono::DateTime;

struct SupportCase {
    pool: PgPool,
    app: axum::Router,
    report_id: Uuid,
    owner_id: Uuid,
    operator_id: Uuid,
    owner_token: String,
    operator_token: String,
    activity_at: String,
    updated_at: String,
}

impl SupportCase {
    async fn create(name: &str, resolved: bool) -> anyhow::Result<Self> {
        let pool = require_origin_test_pool(name).await?;
        let owner_id = Uuid::new_v4();
        let operator_id = Uuid::new_v4();
        let report_id = Uuid::new_v4();
        ensure_test_user(&pool, &owner_id).await?;
        ensure_test_user(&pool, &operator_id).await?;
        let row = pool
            .get()
            .await?
            .query_one(
                "insert into bug_reports (
                    id, user_id, message, status, customer_last_message_at,
                    support_last_message_at, resolved_at
                 ) values (
                    $1, $2, 'Disposable support workflow test',
                    case when $3 then 'resolved' else 'open' end,
                    now() - interval '1 hour',
                    case when $3 then now() else null end,
                    case when $3 then now() else null end
                 ) returning updated_at, customer_last_message_at,
                             support_last_message_at",
                &[&report_id, &owner_id, &resolved],
            )
            .await?;
        let activity_at = if resolved {
            row.get::<_, DateTime<Utc>>("support_last_message_at")
        } else {
            row.get::<_, DateTime<Utc>>("customer_last_message_at")
        }
        .to_rfc3339();
        let updated_at = row.get::<_, DateTime<Utc>>("updated_at").to_rfc3339();
        let mut config =
            build_app_config(test_origin_private_key(), test_origin_public_key(), name);
        config.bug_reports_operator_user_ids = vec![operator_id];
        let owner_token = crate::auth::issue_controller_token(&config, &owner_id)
            .map_err(|error| controller_error("issue support owner token", error))?
            .token;
        let operator_token = crate::auth::issue_controller_token(&config, &operator_id)
            .map_err(|error| controller_error("issue support operator token", error))?
            .token;
        let app = crate::bug_reports::router()
            .merge(crate::notification_platform::router())
            .with_state(build_test_state(pool.clone(), config));
        Ok(Self {
            pool,
            app,
            report_id,
            owner_id,
            operator_id,
            owner_token,
            operator_token,
            activity_at,
            updated_at,
        })
    }

    async fn request(
        &self,
        method: &str,
        path: &str,
        token: &str,
        body: serde_json::Value,
    ) -> anyhow::Result<(StatusCode, serde_json::Value)> {
        let response = self
            .app
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
        let body = serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await?)?;
        Ok((status, body))
    }

    async fn claim(&self) -> anyhow::Result<(StatusCode, serde_json::Value)> {
        self.request(
            "POST",
            "/support/resolution-alerts/claim",
            &self.owner_token,
            json!({ "expectedUserId": self.owner_id }),
        )
        .await
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        self.pool
            .get()
            .await?
            .execute("delete from bug_reports where id = $1", &[&self.report_id])
            .await?;
        cleanup_test_user(&self.pool, &self.owner_id).await?;
        cleanup_test_user(&self.pool, &self.operator_id).await?;
        Ok(())
    }
}

#[tokio::test]
async fn guarded_triage_requires_current_report_and_customer_versions() -> anyhow::Result<()> {
    let case = SupportCase::create("guarded support triage", false).await?;
    let path = format!("/bug-reports/{}/triage", case.report_id);
    let forbidden = case
        .request(
            "PATCH",
            &path,
            &case.owner_token,
            json!({ "priority": "high" }),
        )
        .await?;
    assert_eq!(forbidden.0, StatusCode::FORBIDDEN);

    for body in [
        json!({ "priority": "high" }),
        json!({ "priority": "high", "expectedUpdatedAt": null }),
        json!({ "priority": "high", "expectedUpdatedAt": "2000-01-01T00:00:00Z" }),
        json!({ "status": "resolved", "expectedUpdatedAt": case.updated_at }),
        json!({
            "status": "resolved",
            "expectedUpdatedAt": case.updated_at,
            "expectedCustomerLastMessageAt": "2000-01-01T00:00:00Z",
        }),
    ] {
        let rejected = case
            .request("PATCH", &path, &case.operator_token, body)
            .await?;
        assert_eq!(rejected.0, StatusCode::CONFLICT, "{}", rejected.1);
    }
    let resolved = case
        .request(
            "PATCH",
            &path,
            &case.operator_token,
            json!({
                "status": "resolved",
                "expectedUpdatedAt": case.updated_at,
                "expectedCustomerLastMessageAt": case.activity_at,
            }),
        )
        .await?;
    assert_eq!(resolved.0, StatusCode::OK, "{}", resolved.1);
    assert_eq!(resolved.1["status"], "resolved");
    assert_ne!(resolved.1["updatedAt"], case.updated_at);

    let stale_edit = case
        .request(
            "PATCH",
            &path,
            &case.operator_token,
            json!({ "priority": "urgent", "expectedUpdatedAt": case.updated_at }),
        )
        .await?;
    assert_eq!(stale_edit.0, StatusCode::CONFLICT);
    let detail = case
        .request(
            "GET",
            &format!("/bug-reports/{}", case.report_id),
            &case.operator_token,
            json!(null),
        )
        .await?;
    assert_eq!(detail.0, StatusCode::OK);
    assert_eq!(detail.1["priority"], "normal");
    assert_eq!(detail.1["status"], "resolved");
    case.cleanup().await
}

#[tokio::test]
async fn concurrent_resolution_claims_emit_once_and_preserve_unread() -> anyhow::Result<()> {
    // INSERT deliberately models a historical resolution with no durable event.
    // The notification migration must not disable this legacy fallback.
    let case = SupportCase::create("concurrent support claims", true).await?;
    let (first, second) = tokio::join!(case.claim(), case.claim());
    let first = first?;
    let second = second?;
    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(second.0, StatusCode::OK);
    let mut counts = [
        first.1["claimedCount"].as_i64().unwrap(),
        second.1["claimedCount"].as_i64().unwrap(),
    ];
    counts.sort();
    assert_eq!(counts, [0, 1]);
    let (status, inbox) = case
        .request("GET", "/support/reports", &case.owner_token, json!(null))
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(inbox["unreadCount"], 1);
    assert_eq!(inbox["unreadResolutionCount"], 1);
    assert_eq!(inbox["unnotifiedResolutionCount"], 0);
    case.cleanup().await
}

#[tokio::test]
async fn durable_support_resolutions_own_presentation_without_reading_the_report(
) -> anyhow::Result<()> {
    let case = SupportCase::create("durable support presentation ownership", false).await?;
    let endpoint_id = Uuid::new_v4();
    case.pool
        .get()
        .await?
        .execute(
            "insert into web_push_subscriptions(id,user_id,endpoint,p256dh,auth)
         values($1,$2,$3,'fixture','fixture')",
            &[
                &endpoint_id,
                &case.owner_id,
                &format!("https://push.example.invalid/{endpoint_id}"),
            ],
        )
        .await?;
    let triage_path = format!("/bug-reports/{}/triage", case.report_id);
    let mut updated_at = case.updated_at.clone();
    let mut customer_activity = case.activity_at.clone();
    let mut first_event_id = None;

    for resolution_number in 1..=2 {
        let (status, resolved) = case
            .request(
                "PATCH",
                &triage_path,
                &case.operator_token,
                json!({
                    "status": "resolved",
                    "expectedUpdatedAt": updated_at,
                    "expectedCustomerLastMessageAt": customer_activity,
                }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{resolved}");
        assert_eq!(resolved["status"], "resolved");

        let (first_claim, concurrent_claim) = tokio::join!(case.claim(), case.claim());
        for claim in [first_claim?, concurrent_claim?] {
            assert_eq!(claim.0, StatusCode::OK);
            assert_eq!(claim.1["claimedCount"], 0);
            assert!(claim.1["latestReportId"].is_null());
        }
        let (status, support) = case
            .request("GET", "/support/reports", &case.owner_token, json!(null))
            .await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(support["unreadCount"], 1);
        assert_eq!(support["unreadResolutionCount"], 1);
        assert_eq!(support["unnotifiedResolutionCount"], 0);
        assert_eq!(support["reports"][0]["hasUnreadSupportActivity"], true);
        assert_eq!(support["reports"][0]["hasUnreadResolution"], true);

        let (status, notifications) = case
            .request(
                "GET",
                "/me/notifications?view=unread",
                &case.owner_token,
                json!(null),
            )
            .await?;
        assert_eq!(
            status,
            StatusCode::OK,
            "this regression requires the durable notification migration: {notifications}"
        );
        assert_eq!(notifications["unreadCount"], resolution_number);
        let events = notifications["items"].as_array().unwrap();
        assert_eq!(events.len(), resolution_number as usize);
        for event in events {
            assert_eq!(event["eventName"], "support.resolved");
            assert_eq!(
                event["url"],
                format!("/studio?supportReportId={}", case.report_id)
            );
            assert!(event["seenAt"].is_null());
            assert!(event["readAt"].is_null());
            assert!(event["archivedAt"].is_null());
        }
        if resolution_number == 1 {
            first_event_id = Some(events[0]["id"].clone());
        } else {
            assert!(events
                .iter()
                .any(|event| Some(&event["id"]) == first_event_id.as_ref()));
            assert_ne!(events[0]["id"], events[1]["id"]);
        }
        let state = case
            .pool
            .get()
            .await?
            .query_one(
                "select customer_last_notified_resolution_at >= resolved_at as delegated,
                    notification_resolution_sequence
               from bug_reports where id=$1",
                &[&case.report_id],
            )
            .await?;
        assert!(state.get::<_, bool>("delegated"));
        assert_eq!(
            state.get::<_, i64>("notification_resolution_sequence"),
            resolution_number
        );
        let deliveries = case
            .pool
            .get()
            .await?
            .query(
                "select status, notification_delivery_authorized(id) as authorized
               from notification_delivery_jobs where user_id=$1",
                &[&case.owner_id],
            )
            .await?;
        assert_eq!(deliveries.len(), resolution_number as usize);
        for delivery in deliveries {
            assert_eq!(delivery.get::<_, String>("status"), "pending");
            assert!(
                delivery.get::<_, bool>("authorized"),
                "legacy cursor delegation must not suppress durable delivery"
            );
        }

        if resolution_number == 1 {
            let (status, acknowledged) = case
                .request(
                    "POST",
                    &format!("/support/reports/{}/acknowledge", case.report_id),
                    &case.owner_token,
                    json!({ "seenThrough": support["reports"][0]["supportLastMessageAt"] }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(acknowledged["hasUnreadResolution"], false);
            let (status, follow_up) = case
                .request(
                    "POST",
                    &format!("/support/reports/{}/messages", case.report_id),
                    &case.owner_token,
                    json!({ "body": "The issue came back." }),
                )
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{follow_up}");
            let (status, reopened) = case
                .request(
                    "GET",
                    &format!("/bug-reports/{}", case.report_id),
                    &case.operator_token,
                    json!(null),
                )
                .await?;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(reopened["status"], "open");
            updated_at = reopened["updatedAt"].as_str().unwrap().to_owned();
            customer_activity = reopened["customerLastMessageAt"]
                .as_str()
                .unwrap()
                .to_owned();
        }
    }
    case.pool.get().await?.execute(
        "delete from notification_events where resource_type='support_report' and resource_id=$1",
        &[&case.report_id],
    ).await?;
    case.cleanup().await
}

#[tokio::test]
async fn resolution_viewed_before_poll_never_emits_a_late_alert() -> anyhow::Result<()> {
    let case = SupportCase::create("support read before notification", true).await?;
    let (status, acknowledged) = case
        .request(
            "POST",
            &format!("/support/reports/{}/acknowledge", case.report_id),
            &case.owner_token,
            json!({ "seenThrough": case.activity_at }),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(acknowledged["hasUnreadSupportActivity"], false);
    assert_eq!(acknowledged["hasUnreadResolution"], false);
    let (status, inbox) = case
        .request("GET", "/support/reports", &case.owner_token, json!(null))
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(inbox["unreadCount"], 0);
    assert_eq!(inbox["unreadResolutionCount"], 0);
    assert_eq!(inbox["unnotifiedResolutionCount"], 0);
    let (status, claim) = case.claim().await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(claim["claimedCount"], 0);
    case.cleanup().await
}
