//! Saved conversation context follows the conversation's current access boundary.
use super::*;

struct ContextCase {
    pool: PgPool,
    app: axum::Router,
    project: Uuid,
    other_project: Uuid,
    private: Uuid,
    public: Uuid,
    foreign: Uuid,
    owner: Uuid,
    member: Uuid,
    tokens: HashMap<Uuid, String>,
}

impl ContextCase {
    async fn new() -> anyhow::Result<Self> {
        let pool = require_origin_test_pool("saved context conversation authorization").await?;
        let [project, other_project, private, public, foreign, owner, member] =
            [(); 7].map(|_| Uuid::new_v4());
        for user in [owner, member] {
            ensure_test_user(&pool, &user).await?;
        }
        let db = pool.get().await?;
        for id in [project, other_project] {
            db.execute(
                "insert into projects(id,owner_user_id,project_type,status)
                 values($1,$2,'customer','active')",
                &[&id, &owner],
            )
            .await?;
            db.execute(
                "insert into project_memberships(project_id,user_id,role) values($1,$2,'builder')",
                &[&id, &member],
            )
            .await?;
        }
        for (id, scope, visibility) in [
            (private, project, "private"),
            (public, project, "public"),
            (foreign, other_project, "public"),
        ] {
            db.execute(
                "insert into conversations(id,project_id,created_by,visibility,metadata)
                 values($1,$2,$3,$4,'{}')",
                &[&id, &scope, &owner, &visibility],
            )
            .await?;
        }
        db.execute(
            "insert into conversation_participants(conversation_id,user_id) values($1,$2)",
            &[&private, &member],
        )
        .await?;
        drop(db);
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "context-access-test",
        );
        let mut tokens = HashMap::new();
        for user in [owner, member] {
            tokens.insert(
                user,
                crate::auth::issue_controller_token(&config, &user)
                    .map_err(|e| controller_error("issue context test token", e))?
                    .token,
            );
        }
        let app =
            crate::agent_contexts::router().with_state(build_test_state(pool.clone(), config));
        Ok(Self {
            pool,
            app,
            project,
            other_project,
            private,
            public,
            foreign,
            owner,
            member,
            tokens,
        })
    }

    async fn request(
        &self,
        user: Uuid,
        query: &str,
        body: Option<serde_json::Value>,
    ) -> anyhow::Result<(StatusCode, serde_json::Value)> {
        let request = Request::builder()
            .method(if body.is_some() { "POST" } else { "GET" })
            .uri(format!("/projects/{}/agent-contexts{query}", self.project))
            .header("authorization", format!("Bearer {}", self.tokens[&user]))
            .header("content-type", "application/json")
            .body(
                body.map(|v| Body::from(v.to_string()))
                    .unwrap_or_else(Body::empty),
            )?;
        let response = self.app.clone().oneshot(request).await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
        Ok((status, serde_json::from_slice(&bytes)?))
    }

    async fn create(
        &self,
        user: Uuid,
        kind: &str,
        id: impl ToString,
        text: &str,
    ) -> anyhow::Result<serde_json::Value> {
        let (status, card) = self
            .request(
                user,
                "",
                Some(json!({
                    "agent": "@octo", "scopeKind": kind, "scopeId": id.to_string(), "context": text,
                })),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{card}");
        Ok(card)
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        for project in [self.project, self.other_project] {
            cleanup_origin_project(&self.pool, &project).await?;
        }
        for user in [self.owner, self.member] {
            cleanup_test_user(&self.pool, &user).await?;
        }
        Ok(())
    }
}

#[tokio::test]
async fn saved_context_revocation_filters_before_limit_and_blocks_updates() -> anyhow::Result<()> {
    let case = ContextCase::new().await?;
    let shared = case
        .create(
            case.member,
            "conversation",
            case.public.to_string().to_uppercase(),
            "Public note",
        )
        .await?;
    assert_eq!(shared["scopeId"], case.public.to_string());
    let (status, by_uppercase) = case
        .request(
            case.member,
            &format!(
                "?scopeKind=conversation&scopeId={}",
                case.public.to_string().to_uppercase()
            ),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(by_uppercase[0]["id"], shared["id"]);
    case.create(case.member, "person", "someone", "Personal note")
        .await?;
    let private = case
        .create(case.member, "conversation", case.private, "Private witness")
        .await?;
    // Older controllers stored the caller's UUID casing. Updating that card
    // must preserve its identity and not leave a duplicate stale summary.
    sql(
        &case.pool,
        "update agent_context_cards set scope_id=upper(scope_id) where id=$1",
        &[&Uuid::parse_str(private["id"].as_str().unwrap())?],
    )
    .await?;
    let updated = case
        .create(
            case.member,
            "conversation",
            case.private.to_string().to_uppercase(),
            "Private witness",
        )
        .await?;
    assert_eq!(updated["id"], private["id"]);
    case.create(
        case.owner,
        "conversation",
        case.private,
        "Other user's note",
    )
    .await?;
    let (_, before) = case.request(case.member, "", None).await?;
    assert_eq!(
        before.as_array().unwrap().len(),
        3,
        "only the caller's cards"
    );
    sql(
        &case.pool,
        "update agent_context_cards set updated_at=now()+interval '1 hour' where id=$1",
        &[&Uuid::parse_str(private["id"].as_str().unwrap())?],
    )
    .await?;
    sql(
        &case.pool,
        "delete from conversation_participants where conversation_id=$1",
        &[&case.private],
    )
    .await?;

    let (status, after) = case.request(case.member, "", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after.as_array().unwrap().len(), 2);
    assert!(after
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["id"] == shared["id"]));
    for query in [
        format!("?scopeKind=conversation&scopeId={}", case.private),
        "?q=Private".into(),
    ] {
        let (status, cards) = case.request(case.member, &query, None).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(cards, json!([]));
    }
    let (_, limited) = case.request(case.member, "?limit=1", None).await?;
    assert_eq!(
        limited.as_array().unwrap().len(),
        1,
        "hidden cards must not consume the limit"
    );
    assert_ne!(limited[0]["id"], private["id"]);
    let (status, _) = case
        .request(
            case.member,
            "",
            Some(json!({
                "agent": "@octo", "scopeKind": "conversation", "scopeId": case.private,
                "context": "Denied replacement",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // Creator access survives removal of participation rows, but never exposes another user's card.
    let (_, owner_cards) = case.request(case.owner, "", None).await?;
    assert_eq!(owner_cards.as_array().unwrap().len(), 1);
    assert_eq!(owner_cards[0]["context"], "Other user's note");
    sql(
        &case.pool,
        "insert into conversation_participants(conversation_id,user_id) values($1,$2)",
        &[&case.private, &case.member],
    )
    .await?;
    let (_, restored) = case
        .request(
            case.member,
            &format!("?scopeKind=conversation&scopeId={}", case.private),
            None,
        )
        .await?;
    assert_eq!(restored[0]["id"], private["id"]);
    assert_eq!(
        restored[0]["context"], "Private witness",
        "denied update must not modify stored memory"
    );
    case.cleanup().await
}

#[tokio::test]
async fn saved_context_rejects_invalid_targets_and_hides_legacy_cards() -> anyhow::Result<()> {
    let case = ContextCase::new().await?;
    let valid = case
        .create(case.member, "project", case.project, "Project note")
        .await?;
    let agent = Uuid::parse_str(valid["agentId"].as_str().unwrap())?;
    for (scope, expected) in [
        (case.foreign.to_string(), StatusCode::FORBIDDEN),
        (Uuid::new_v4().to_string(), StatusCode::NOT_FOUND),
        ("not-a-conversation".into(), StatusCode::BAD_REQUEST),
    ] {
        let (status, _) = case.request(case.member, "", Some(json!({
            "agent": "@octo", "scopeKind": "conversation", "scopeId": scope, "context": "Rejected note",
        }))).await?;
        assert_eq!(status, expected, "scope {scope}");
        // Rows from old controllers must be filtered without casting malformed scope IDs.
        sql(&case.pool,
            "insert into agent_context_cards(user_id,project_id,agent_id,scope_kind,scope_id,context)
             values($1,$2,$3,'conversation',$4,'Legacy note')",
            &[&case.member, &case.project, &agent, &scope],
        ).await?;
    }
    let (status, listed) = case.request(case.member, "", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], valid["id"]);
    sql(
        &case.pool,
        "delete from project_memberships where project_id=$1 and user_id=$2",
        &[&case.project, &case.member],
    )
    .await?;
    let (status, _) = case.request(case.member, "", None).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    case.cleanup().await
}
