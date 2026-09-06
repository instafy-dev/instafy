//! Real controller-router and PostgreSQL regressions for human recipients.
//! Requires an isolated database with all public migrations installed. Provider
//! delivery is intentionally not started: these checks inspect the durable outbox.
use super::*;

struct ConversationNotificationFixture {
    pool: PgPool,
    app: axum::Router,
    project: Uuid,
    other_project: Uuid,
    users: [Uuid; 4],
    tokens: [String; 4],
}

impl ConversationNotificationFixture {
    async fn new() -> anyhow::Result<Self> {
        let pool = require_origin_test_pool("conversation notification HTTP tests").await?;
        let users = std::array::from_fn(|_| Uuid::new_v4());
        for user in &users {
            ensure_test_user(&pool, user).await?;
        }
        let project = Uuid::new_v4();
        let other_project = Uuid::new_v4();
        {
            let db = pool.get().await?;
            db.execute(
                "insert into projects(id,owner_user_id,name,project_type,status)
                 values($1,$2,'Private fixture project','customer','active'),
                       ($3,$4,'Unrelated fixture project','customer','active')",
                &[&project, &users[0], &other_project, &users[3]],
            )
            .await?;
            db.execute(
                "insert into project_memberships(project_id,user_id,role)
                 values($1,$2,'builder'),($1,$3,'viewer')",
                &[&project, &users[1], &users[2]],
            )
            .await?;
            for user in &users {
                let endpoint = Uuid::new_v4();
                db.execute(
                    "insert into web_push_subscriptions(id,user_id,endpoint,p256dh,auth)
                     values($1,$2,$3,'fixture','fixture')",
                    &[
                        &endpoint,
                        user,
                        &format!("https://push.example.invalid/{endpoint}"),
                    ],
                )
                .await?;
            }
        }
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "conversation-notification-http",
        );
        let mut tokens = std::array::from_fn(|_| String::new());
        for (index, user) in users.iter().enumerate() {
            tokens[index] = crate::auth::issue_controller_token(&config, user)
                .map_err(|error| controller_error("issue notification fixture token", error))?
                .token;
        }
        let state = build_test_state(pool.clone(), config);
        let app = crate::conversations::router()
            .merge(crate::notification_platform::router())
            .with_state(state);
        Ok(Self {
            pool,
            app,
            project,
            other_project,
            users,
            tokens,
        })
    }

    async fn request(
        &self,
        actor: usize,
        method: &str,
        path: &str,
        body: serde_json::Value,
    ) -> anyhow::Result<(StatusCode, serde_json::Value)> {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("authorization", format!("Bearer {}", self.tokens[actor]))
                    .header("content-type", "application/json")
                    .body(if method == "GET" {
                        Body::empty()
                    } else {
                        Body::from(body.to_string())
                    })?,
            )
            .await?;
        if path.starts_with("/me/notifications") {
            assert_eq!(response.headers()["cache-control"], "no-store");
        }
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
        Ok((
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        ))
    }

    async fn create(&self, private: bool, initial: &[Uuid]) -> anyhow::Result<Uuid> {
        let (status, body) = self
            .request(
                0,
                "POST",
                &format!("/projects/{}/conversations/blank", self.project),
                json!({
                    "metadata": { "visibility": if private { "private" } else { "public" } },
                    "initialParticipantUserIds": initial,
                }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let mut expected_initial = Vec::new();
        for user in initial {
            if !expected_initial.contains(user) {
                expected_initial.push(*user);
            }
        }
        assert_eq!(
            body["initialParticipantUserIds"],
            json!(expected_initial),
            "the create response must prove which requested participants committed atomically"
        );
        Ok(Uuid::parse_str(
            body["conversationId"].as_str().context("conversationId")?,
        )?)
    }

    async fn send(
        &self,
        actor: usize,
        conversation: Uuid,
        client_message_id: Uuid,
        mentioned: serde_json::Value,
    ) -> anyhow::Result<(StatusCode, serde_json::Value)> {
        self.request(
            actor,
            "POST",
            &format!("/conversations/{conversation}/messages/record"),
            json!({
                "projectId": self.project,
                "role": "user",
                "content": "Private message text must never become a notification preview.",
                "clientMessageId": client_message_id,
                "metadata": { "mentionedUserIds": mentioned },
            }),
        )
        .await
    }

    async fn sent(
        &self,
        actor: usize,
        conversation: Uuid,
        mentioned: &[Uuid],
    ) -> anyhow::Result<Uuid> {
        let (status, body) = self
            .send(actor, conversation, Uuid::new_v4(), json!(mentioned))
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        Ok(Uuid::parse_str(body["id"].as_str().context("message id")?)?)
    }

    async fn recipients(&self, message: Uuid) -> anyhow::Result<Vec<Uuid>> {
        let db = self.pool.get().await?;
        let key = format!("conversation.reply:{message}");
        assert_eq!(
            db.query_one(
                "select count(*) from notification_events where producer_key=$1",
                &[&key]
            )
            .await?
            .get::<_, i64>(0),
            1
        );
        Ok(db.query(
            "select r.user_id from notification_recipients r join notification_events e on e.id=r.event_id
             where e.producer_key=$1 order by r.user_id",
            &[&key],
        ).await?.iter().map(|row| row.get(0)).collect())
    }

    async fn inbox(&self, actor: usize) -> anyhow::Result<serde_json::Value> {
        let (status, body) = self
            .request(
                actor,
                "GET",
                "/me/notifications?view=all&limit=100",
                json!({}),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert!(!body.to_string().contains("Private message text"));
        assert!(!body.to_string().contains("Private fixture project"));
        Ok(body)
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        cleanup_origin_project(&self.pool, &self.project).await?;
        cleanup_origin_project(&self.pool, &self.other_project).await?;
        for user in &self.users {
            self.pool
                .get()
                .await?
                .execute(
                    "delete from web_push_subscriptions where user_id=$1",
                    &[user],
                )
                .await?;
            cleanup_test_user(&self.pool, user).await?;
        }
        Ok(())
    }
}

#[tokio::test]
async fn conversation_notification_http_atomic_private_chat_first_message_and_followup(
) -> anyhow::Result<()> {
    let f = ConversationNotificationFixture::new().await?;
    let conversation = f.create(true, &[f.users[1], f.users[1]]).await?;
    // The first successful create response already grants access to the target;
    // there is no separate invitation request that can race the first message.
    let (status, participants) = f
        .request(
            1,
            "GET",
            &format!("/conversations/{conversation}/participants"),
            json!({}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{participants}");
    assert_eq!(participants["participants"].as_array().unwrap().len(), 2);

    let client_message_id = Uuid::new_v4();
    let (status, first) = f
        .send(0, conversation, client_message_id, json!([]))
        .await?;
    assert_eq!(status, StatusCode::OK, "{first}");
    let first_id = Uuid::parse_str(first["id"].as_str().unwrap())?;
    assert_eq!(f.recipients(first_id).await?, vec![f.users[1]]);
    let (status, replay) = f
        .send(0, conversation, client_message_id, json!([]))
        .await?;
    assert_eq!(status, StatusCode::OK, "{replay}");
    assert_eq!(replay["id"], first["id"]);
    assert_eq!(f.recipients(first_id).await?, vec![f.users[1]]);
    let first_inbox = f.inbox(1).await?;
    assert_eq!(first_inbox["unreadCount"], 1);
    assert_eq!(first_inbox["items"][0]["eventName"], "conversation.reply");
    assert_eq!(
        first_inbox["items"][0]["url"],
        format!(
            "/studio?projectId={}&conversationControllerId={conversation}",
            f.project
        )
    );
    assert_eq!(f.inbox(0).await?["unreadCount"], 0);
    assert_eq!(
        f.pool
            .get()
            .await?
            .query_one(
                "select count(*) from notification_delivery_jobs where event_id=$1",
                &[&Uuid::parse_str(
                    first_inbox["items"][0]["id"].as_str().unwrap()
                )?]
            )
            .await?
            .get::<_, i64>(0),
        1
    );

    let reply = f.sent(1, conversation, &[]).await?;
    assert_eq!(f.recipients(reply).await?, vec![f.users[0]]);
    let followup = f.sent(0, conversation, &[]).await?;
    assert_eq!(f.recipients(followup).await?, vec![f.users[1]]);
    assert_eq!(f.inbox(0).await?["unreadCount"], 1);
    assert_eq!(f.inbox(1).await?["unreadCount"], 2);
    f.cleanup().await
}

#[tokio::test]
async fn conversation_notification_http_shared_mentions_are_scoped_and_deduplicated(
) -> anyhow::Result<()> {
    let f = ConversationNotificationFixture::new().await?;
    let conversation = f.create(false, &[]).await?;
    let first = f
        .sent(
            0,
            conversation,
            &[
                f.users[1],
                f.users[1],
                f.users[0],
                f.users[3],
                Uuid::new_v4(),
            ],
        )
        .await?;
    assert_eq!(f.recipients(first).await?, vec![f.users[1]], "a valid mention reaches a non-participant without notifying the sender or another project's owner");
    assert_eq!(f.inbox(1).await?["unreadCount"], 1);
    assert_eq!(f.inbox(3).await?["unreadCount"], 0);
    assert_eq!(f.pool.get().await?.query_one("select count(*) from conversation_participants where conversation_id=$1 and user_id=$2", &[&conversation, &f.users[1]]).await?.get::<_, i64>(0), 0, "mentioning does not silently subscribe the target to the conversation");
    let unaddressed = f.sent(0, conversation, &[]).await?;
    assert!(f.recipients(unaddressed).await?.is_empty());

    // Once a teammate writes, future conversation replies reach them even when
    // unmentioned; an explicit mention of that same participant does not double it.
    let peer_reply = f.sent(1, conversation, &[]).await?;
    assert_eq!(f.recipients(peer_reply).await?, vec![f.users[0]]);
    let mentioned_participant = f.sent(0, conversation, &[f.users[1], f.users[1]]).await?;
    assert_eq!(f.recipients(mentioned_participant).await?, vec![f.users[1]]);
    let participant_followup = f.sent(0, conversation, &[]).await?;
    assert_eq!(f.recipients(participant_followup).await?, vec![f.users[1]]);
    assert_eq!(f.inbox(1).await?["unreadCount"], 3);

    // Current project-read authorization also permits an explicit viewer mention.
    let viewer_mention = f.sent(0, conversation, &[f.users[2]]).await?;
    let mut expected = vec![f.users[1], f.users[2]];
    expected.sort();
    assert_eq!(f.recipients(viewer_mention).await?, expected);
    assert_eq!(f.inbox(2).await?["unreadCount"], 1);
    f.pool
        .get()
        .await?
        .execute(
            "delete from project_memberships where project_id=$1 and user_id=$2",
            &[&f.project, &f.users[2]],
        )
        .await?;
    assert_eq!(
        f.inbox(2).await?["unreadCount"],
        0,
        "revoked mention targets lose access to existing notification metadata"
    );
    assert!(f.pool.get().await?.query_one(
        "select bool_and(not notification_delivery_authorized(id)) from notification_delivery_jobs where user_id=$1",
        &[&f.users[2]],
    ).await?.get::<_, bool>(0), "a queued mention push must revalidate current project access");
    let revoked_mention = f.sent(0, conversation, &[f.users[2]]).await?;
    assert_eq!(f.recipients(revoked_mention).await?, vec![f.users[1]]);
    f.cleanup().await
}

#[tokio::test]
async fn conversation_notification_http_private_mentions_and_creation_authorization(
) -> anyhow::Result<()> {
    let f = ConversationNotificationFixture::new().await?;
    let create_path = format!("/projects/{}/conversations/blank", f.project);
    let initial_count = f
        .pool
        .get()
        .await?
        .query_one(
            "select count(*) from conversations where project_id=$1",
            &[&f.project],
        )
        .await?
        .get::<_, i64>(0);
    let (status, body) = f
        .request(
            0,
            "POST",
            &create_path,
            json!({
                "metadata": { "visibility": "private" },
                "initialParticipantUserIds": [f.users[1], f.users[3]],
            }),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(
        f.pool
            .get()
            .await?
            .query_one(
                "select count(*) from conversations where project_id=$1",
                &[&f.project]
            )
            .await?
            .get::<_, i64>(0),
        initial_count,
        "one unauthorized initial target rolls back the complete creation"
    );
    let (status, body) = f
        .request(
            0,
            "POST",
            &create_path,
            json!({
                "metadata": { "visibility": "public" },
                "initialParticipantUserIds": [f.users[1]],
            }),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = f
        .request(
            0,
            "POST",
            &create_path,
            json!({
                "metadata": { "visibility": "private" },
                "initialParticipantUserIds": ["not-a-uuid"],
            }),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let conversation = f.create(true, &[f.users[1]]).await?;
    let message = f.sent(0, conversation, &[f.users[2], f.users[3]]).await?;
    assert_eq!(
        f.recipients(message).await?,
        vec![f.users[1]],
        "private mentions cannot grant access to even an otherwise authorized project viewer"
    );
    assert_eq!(f.inbox(2).await?["unreadCount"], 0);
    assert_eq!(f.inbox(3).await?["unreadCount"], 0);
    let participant_path = format!("/conversations/{conversation}/participants");
    let (status, body) = f
        .request(
            0,
            "POST",
            &participant_path,
            json!({"userId": f.users[3], "role": "member"}),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = f
        .request(
            0,
            "POST",
            &participant_path,
            json!({"userId": f.users[2], "role": "member"}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let after_invitation = f.sent(0, conversation, &[f.users[2]]).await?;
    let mut expected = vec![f.users[1], f.users[2]];
    expected.sort();
    assert_eq!(f.recipients(after_invitation).await?, expected);

    let before = f
        .pool
        .get()
        .await?
        .query_one(
            "select count(*) from conversation_messages where conversation_id=$1",
            &[&conversation],
        )
        .await?
        .get::<_, i64>(0);
    let too_many = (0..33)
        .map(|_| Uuid::new_v4().to_string())
        .collect::<Vec<_>>();
    for malformed in [
        json!(["not-a-uuid"]),
        json!([17]),
        json!({"userId": f.users[1]}),
        json!("not-an-array"),
        json!(too_many),
    ] {
        let (status, body) = f
            .send(0, conversation, Uuid::new_v4(), malformed.clone())
            .await?;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "malformed={malformed}, response={body}"
        );
    }
    assert_eq!(
        f.pool
            .get()
            .await?
            .query_one(
                "select count(*) from conversation_messages where conversation_id=$1",
                &[&conversation]
            )
            .await?
            .get::<_, i64>(0),
        before,
        "malformed mentions must not persist a message or trigger notifications"
    );
    f.cleanup().await
}

#[tokio::test]
async fn conversation_notification_http_muted_push_retains_center_and_cross_device_read(
) -> anyhow::Result<()> {
    let f = ConversationNotificationFixture::new().await?;
    let conversation = f.create(true, &[f.users[1]]).await?;
    let (status, body) = f.request(1, "POST", "/me/notifications/preferences", json!({
        "preferences": [{"category":"conversations", "channel":"web_push", "enabled":false}],
    })).await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    let message = f.sent(0, conversation, &[f.users[1]]).await?;
    assert_eq!(f.recipients(message).await?, vec![f.users[1]]);
    let page = f.inbox(1).await?;
    assert_eq!(page["unreadCount"], 1);
    let event = Uuid::parse_str(page["items"][0]["id"].as_str().unwrap())?;
    assert_eq!(
        f.pool
            .get()
            .await?
            .query_one(
                "select count(*) from notification_delivery_jobs where event_id=$1",
                &[&event]
            )
            .await?
            .get::<_, i64>(0),
        0
    );
    let (status, body) = f
        .request(
            1,
            "POST",
            "/me/notifications/state",
            json!({"id":event,"action":"read"}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    // A fresh request from another device using the same authenticated account
    // observes the server state, without depending on any frontend local store.
    let other_device = f.inbox(1).await?;
    assert_eq!(other_device["unreadCount"], 0);
    assert!(other_device["items"][0]["readAt"].is_string());
    assert_eq!(f.inbox(0).await?["unreadCount"], 0);
    f.cleanup().await
}
