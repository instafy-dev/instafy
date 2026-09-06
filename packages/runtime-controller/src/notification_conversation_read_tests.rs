//! Exact-message acknowledgement through the real router and a migrated database.
use super::*;

struct ConversationReadCase {
    pool: PgPool,
    app: axum::Router,
    project: Uuid,
    conversation: Uuid,
    other_conversation: Uuid,
    report: Uuid,
    sender: Uuid,
    reader: Uuid,
    peer: Uuid,
    outsider: Uuid,
    reader_token: String,
    outsider_token: String,
}

impl ConversationReadCase {
    async fn create() -> anyhow::Result<Self> {
        let pool = require_origin_test_pool("exact conversation notification reads").await?;
        let sender = Uuid::new_v4();
        let reader = Uuid::new_v4();
        let peer = Uuid::new_v4();
        let outsider = Uuid::new_v4();
        for user in [sender, reader, peer, outsider] {
            ensure_test_user(&pool, &user).await?;
        }
        let project = Uuid::new_v4();
        let conversation = Uuid::new_v4();
        let other_conversation = Uuid::new_v4();
        let report = Uuid::new_v4();
        let endpoint = Uuid::new_v4();
        let connection = pool.get().await?;
        connection.execute(
            "insert into projects(id,owner_user_id,project_type,status) values($1,$2,'customer','active')",
            &[&project, &sender],
        ).await?;
        for user in [reader, peer] {
            connection.execute(
                "insert into project_memberships(project_id,user_id,role) values($1,$2,'builder')",
                &[&project, &user],
            ).await?;
        }
        for id in [conversation, other_conversation] {
            connection.execute(
                "insert into conversations(id,project_id,created_by,visibility) values($1,$2,$3,'private')",
                &[&id, &project, &sender],
            ).await?;
            for user in [reader, peer] {
                connection.execute(
                    "insert into conversation_participants(conversation_id,user_id,role,added_by)
                     values($1,$2,'member',$3)",
                    &[&id, &user, &sender],
                ).await?;
            }
        }
        connection
            .execute(
                "insert into web_push_subscriptions(id,user_id,endpoint,p256dh,auth)
             values($1,$2,$3,'fixture','fixture')",
                &[
                    &endpoint,
                    &reader,
                    &format!("https://push.example.invalid/{endpoint}"),
                ],
            )
            .await?;
        connection.execute(
            "insert into bug_reports(id,user_id,message,status,resolved_at,support_last_message_at)
             values($1,$2,'Independent support cursor','resolved',now(),now())",
            &[&report, &reader],
        ).await?;
        drop(connection);
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "exact-conversation-reads",
        );
        let reader_token = crate::auth::issue_controller_token(&config, &reader)
            .map_err(|error| controller_error("issue reader token", error))?
            .token;
        let outsider_token = crate::auth::issue_controller_token(&config, &outsider)
            .map_err(|error| controller_error("issue outsider token", error))?
            .token;
        let app = crate::notification_platform::router()
            .with_state(build_test_state(pool.clone(), config));
        Ok(Self {
            pool,
            app,
            project,
            conversation,
            other_conversation,
            report,
            sender,
            reader,
            peer,
            outsider,
            reader_token,
            outsider_token,
        })
    }

    async fn message(&self, conversation: Uuid, offset_seconds: f64) -> anyhow::Result<Uuid> {
        let id = Uuid::new_v4();
        self.pool.get().await?.execute(
            "insert into conversation_messages(id,project_id,conversation_id,created_by,role,content,created_at)
             values($1,$2,$3,$4,'user','A visible human message',clock_timestamp()+make_interval(secs=>$5))",
            &[&id, &self.project, &conversation, &self.sender, &offset_seconds],
        ).await?;
        Ok(id)
    }

    fn body(&self, messages: &[Uuid]) -> serde_json::Value {
        json!({ "conversationId": self.conversation, "messageIds": messages,
            "expectedUserId": self.reader })
    }

    async fn request(
        &self,
        token: Option<&str>,
        body: serde_json::Value,
    ) -> anyhow::Result<(StatusCode, serde_json::Value)> {
        let mut request = Request::builder()
            .method("POST")
            .uri("/me/notifications/conversation-read")
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(body.to_string()))?)
            .await?;
        assert_eq!(response.headers()["cache-control"], "no-store");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
        Ok((
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        ))
    }

    async fn read_state(
        &self,
        message: Uuid,
        user: Uuid,
    ) -> anyhow::Result<(Option<chrono::DateTime<Utc>>, Option<chrono::DateTime<Utc>>)> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select r.seen_at,r.read_at from notification_recipients r
             join notification_events e on e.id=r.event_id
             where e.producer_key='conversation.reply:'||$1::uuid::text and r.user_id=$2",
                &[&message, &user],
            )
            .await?;
        Ok((row.get(0), row.get(1)))
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        let connection = self.pool.get().await?;
        connection
            .execute("delete from projects where id=$1", &[&self.project])
            .await?;
        connection.execute("delete from notification_events where resource_type='support_report' and resource_id=$1", &[&self.report]).await?;
        connection
            .execute("delete from bug_reports where id=$1", &[&self.report])
            .await?;
        drop(connection);
        for user in [self.sender, self.reader, self.peer, self.outsider] {
            cleanup_test_user(&self.pool, &user).await?;
        }
        Ok(())
    }
}

#[tokio::test]
async fn notification_conversation_read_marks_only_loaded_ids_and_preserves_other_state(
) -> anyhow::Result<()> {
    let case = ConversationReadCase::create().await?;
    let loaded = case.message(case.conversation, 0.0).await?;
    let newer = case.message(case.conversation, 1.0).await?;
    // Simulates a late transaction whose message timestamp precedes the UI snapshot.
    let backdated = case.message(case.conversation, -3600.0).await?;
    let elsewhere = case.message(case.other_conversation, 0.0).await?;
    case.pool
        .get()
        .await?
        .execute(
            "insert into bug_report_messages(id,bug_report_id,author_type,body)
         values($1,$2,'support','Support is independent')",
            &[&Uuid::new_v4(), &case.report],
        )
        .await?;
    let body = case.body(&[loaded, loaded, elsewhere, Uuid::new_v4()]);
    let (ack, concurrent) = tokio::join!(
        case.request(Some(&case.reader_token), body.clone()),
        case.message(case.conversation, 0.0),
    );
    assert_eq!(ack?, (StatusCode::OK, json!({ "ok": true })));
    let concurrent = concurrent?;
    let initial_state = case.read_state(loaded, case.reader).await?;
    assert!(initial_state.0.is_some() && initial_state.1.is_some());
    assert_eq!(
        case.request(Some(&case.reader_token), body).await?.0,
        StatusCode::OK
    );
    assert_eq!(
        case.read_state(loaded, case.reader).await?,
        initial_state,
        "retrying must preserve the original monotonic read timestamp"
    );
    for message in [newer, backdated, elsewhere, concurrent] {
        assert_eq!(
            case.read_state(message, case.reader).await?,
            (None, None),
            "a source message outside the loaded snapshot was acknowledged"
        );
    }
    assert_eq!(case.read_state(loaded, case.peer).await?, (None, None));
    let connection = case.pool.get().await?;
    let jobs = connection.query(
        "select e.producer_key,notification_delivery_authorized(j.id) from notification_delivery_jobs j
         join notification_events e on e.id=j.event_id where j.user_id=$1 and e.category='conversations'",
        &[&case.reader],
    ).await?;
    assert_eq!(jobs.len(), 5);
    for job in jobs {
        assert_eq!(
            job.get::<_, bool>(1),
            job.get::<_, String>(0) != format!("conversation.reply:{loaded}")
        );
    }
    let support = connection
        .query_one(
            "select customer_last_seen_support_at,customer_last_notified_resolution_at
         from bug_reports where id=$1",
            &[&case.report],
        )
        .await?;
    assert!(support.get::<_, Option<chrono::DateTime<Utc>>>(0).is_none());
    assert!(support.get::<_, Option<chrono::DateTime<Utc>>>(1).is_none());
    let support_recipient = connection.query_one(
        "select r.seen_at,r.read_at from notification_recipients r join notification_events e on e.id=r.event_id
         where e.resource_id=$1 and e.event_name='support.reply' and r.user_id=$2",
        &[&case.report, &case.reader],
    ).await?;
    assert!(support_recipient
        .get::<_, Option<chrono::DateTime<Utc>>>(0)
        .is_none());
    assert!(support_recipient
        .get::<_, Option<chrono::DateTime<Utc>>>(1)
        .is_none());
    drop(connection);
    case.cleanup().await
}

#[tokio::test]
async fn notification_conversation_read_enforces_identity_and_current_access() -> anyhow::Result<()>
{
    let case = ConversationReadCase::create().await?;
    let message = case.message(case.conversation, 0.0).await?;
    assert_eq!(
        case.request(None, case.body(&[message])).await?.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        case.request(Some("service-role-token"), case.body(&[message]))
            .await?
            .0,
        StatusCode::UNAUTHORIZED
    );
    let mut wrong_pin = case.body(&[message]);
    wrong_pin["expectedUserId"] = json!(case.outsider);
    assert_eq!(
        case.request(Some(&case.reader_token), wrong_pin.clone())
            .await?
            .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        case.request(Some(&case.outsider_token), wrong_pin).await?.0,
        StatusCode::NOT_FOUND
    );
    let mut missing = case.body(&[message]);
    missing["conversationId"] = json!(Uuid::new_v4());
    assert_eq!(
        case.request(Some(&case.reader_token), missing).await?.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(case.read_state(message, case.reader).await?, (None, None));

    case.pool
        .get()
        .await?
        .execute(
            "delete from conversation_participants where conversation_id=$1 and user_id=$2",
            &[&case.conversation, &case.reader],
        )
        .await?;
    assert_eq!(
        case.request(Some(&case.reader_token), case.body(&[message]))
            .await?
            .0,
        StatusCode::NOT_FOUND
    );
    case.pool.get().await?.execute(
        "insert into conversation_participants(conversation_id,user_id,role) values($1,$2,'member')",
        &[&case.conversation, &case.reader],
    ).await?;
    case.pool
        .get()
        .await?
        .execute(
            "delete from project_memberships where project_id=$1 and user_id=$2",
            &[&case.project, &case.reader],
        )
        .await?;
    assert_eq!(
        case.request(Some(&case.reader_token), case.body(&[message]))
            .await?
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(case.read_state(message, case.reader).await?, (None, None));
    case.cleanup().await
}

#[tokio::test]
async fn notification_conversation_read_bounds_and_validates_the_message_set() -> anyhow::Result<()>
{
    let case = ConversationReadCase::create().await?;
    let message = case.message(case.conversation, 0.0).await?;
    let mut invalid = case.body(&[message]);
    invalid["messageIds"] = json!(["not-a-uuid"]);
    assert_eq!(
        case.request(Some(&case.reader_token), invalid).await?.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        case.request(Some(&case.reader_token), case.body(&vec![message; 101]))
            .await?
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        case.request(Some(&case.reader_token), case.body(&vec![message; 300]))
            .await?
            .0,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let mut missing_pin = case.body(&[message]);
    missing_pin
        .as_object_mut()
        .unwrap()
        .remove("expectedUserId");
    assert_eq!(
        case.request(Some(&case.reader_token), missing_pin).await?.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(case.read_state(message, case.reader).await?, (None, None));
    assert_eq!(
        case.request(Some(&case.reader_token), case.body(&[]))
            .await?,
        (StatusCode::OK, json!({ "ok": true }))
    );
    assert_eq!(
        case.request(Some(&case.reader_token), case.body(&vec![message; 100]))
            .await?
            .0,
        StatusCode::OK
    );
    assert!(case.read_state(message, case.reader).await?.1.is_some());
    case.cleanup().await
}
