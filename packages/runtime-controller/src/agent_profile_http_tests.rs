//! Public bot biographies never expose runtime instructions or cross project access.
use super::*;

struct AgentProfileCase {
    pool: PgPool,
    app: axum::Router,
    project: Uuid,
    other_project: Uuid,
    org: Uuid,
    manager: Uuid,
    owner: Uuid,
    viewer: Uuid,
    org_viewer: Uuid,
    outsider: Uuid,
    tokens: HashMap<Uuid, String>,
}

impl AgentProfileCase {
    async fn create() -> anyhow::Result<Self> {
        let pool =
            require_origin_test_pool("agent biography persistence and project authorization")
                .await?;
        let [manager, owner, viewer, org_viewer, outsider] = [(); 5].map(|_| Uuid::new_v4());
        let users = [manager, owner, viewer, org_viewer, outsider];
        for user in users {
            ensure_test_user(&pool, &user).await?;
        }
        let project = Uuid::new_v4();
        let other_project = Uuid::new_v4();
        let org = Uuid::new_v4();
        let db = pool.get().await?;
        db.execute(
            "insert into organizations(id,slug,name) values($1,$2,'Bot profile team')",
            &[&org, &format!("bot-profile-{org}")],
        )
        .await?;
        for (user, role) in [(manager, "owner"), (org_viewer, "viewer")] {
            db.execute(
                "insert into org_memberships(org_id,user_id,role) values($1,$2,$3)",
                &[&org, &user, &role],
            )
            .await?;
        }
        db.execute("insert into projects(id,org_id,owner_user_id,project_type,status) values($1,$2,$3,'customer','active')", &[&project, &org, &manager]).await?;
        db.execute("insert into projects(id,owner_user_id,project_type,status) values($1,$2,'customer','active')", &[&other_project, &viewer]).await?;
        for user in [owner, viewer] {
            db.execute(
                "insert into project_memberships(project_id,user_id,role) values($1,$2,'viewer')",
                &[&project, &user],
            )
            .await?;
        }
        drop(db);
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "agent-profile-test",
        );
        let mut tokens = HashMap::new();
        for user in users {
            let token = crate::auth::issue_controller_token(&config, &user)
                .map_err(|error| controller_error("issue agent profile test token", error))?
                .token;
            tokens.insert(user, token);
        }
        let app = crate::ai_agents::router().with_state(build_test_state(pool.clone(), config));
        Ok(Self {
            pool,
            app,
            project,
            other_project,
            org,
            manager,
            owner,
            viewer,
            org_viewer,
            outsider,
            tokens,
        })
    }

    async fn request(
        &self,
        user: Option<Uuid>,
        method: &str,
        path: &str,
        payload: Option<serde_json::Value>,
    ) -> anyhow::Result<(StatusCode, serde_json::Value)> {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(user) = user {
            request = request.header("authorization", format!("Bearer {}", self.tokens[&user]));
        }
        let body = if let Some(payload) = payload {
            request = request.header("content-type", "application/json");
            Body::from(payload.to_string())
        } else {
            Body::empty()
        };
        let response = self.app.clone().oneshot(request.body(body)?).await?;
        let status = response.status();
        let body = to_bytes(response.into_body(), 1024 * 1024).await?;
        Ok((status, serde_json::from_slice(&body)?))
    }

    async fn create_agent(&self, bio: &str) -> anyhow::Result<serde_json::Value> {
        let (status, agent) = self
            .request(
                Some(self.owner),
                "POST",
                "/me/agents",
                Some(json!({
                    "handle": "build-bot", "displayName": "Build bot", "bio": bio,
                    "description": "Private runtime style guidance", "avatarSeed": "robot"
                })),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{agent}");
        Ok(agent)
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        cleanup_origin_project(&self.pool, &self.project).await?;
        cleanup_origin_project(&self.pool, &self.other_project).await?;
        cleanup_org(&self.pool, &self.org).await?;
        for user in [
            self.manager,
            self.owner,
            self.viewer,
            self.org_viewer,
            self.outsider,
        ] {
            cleanup_test_user(&self.pool, &user).await?;
        }
        Ok(())
    }
}

#[tokio::test]
async fn agent_profile_bio_round_trips_preserves_omission_and_clears_without_changing_instructions(
) -> anyhow::Result<()> {
    let case = AgentProfileCase::create().await?;
    let bio = "🤖".repeat(500);
    let created = case.create_agent(&bio).await?;
    assert_eq!(created["bio"], bio);
    let id = created["id"].as_str().unwrap();
    let path = format!("/me/agents/{id}");
    for (payload, expected) in [
        (json!({"displayName": "Renamed bot"}), Some(bio.as_str())),
        (json!({"bio": "  Build helper\n"}), Some("Build helper")),
        (json!({"bio": null}), None),
    ] {
        let (status, updated) = case
            .request(Some(case.owner), "PATCH", &path, Some(payload))
            .await?;
        assert_eq!(status, StatusCode::OK, "{updated}");
        assert_eq!(updated["bio"].as_str(), expected);
        assert_eq!(updated["description"], "Private runtime style guidance");
    }
    let (status, listed) = case
        .request(Some(case.owner), "GET", "/me/agents", None)
        .await?;
    assert_eq!(status, StatusCode::OK, "{listed}");
    assert!(listed
        .as_array()
        .unwrap()
        .iter()
        .all(|agent| agent["bio"].is_null()));
    for (method, path, payload) in [
        ("PATCH", path.as_str(), json!({"bio": "🤖".repeat(501)})),
        (
            "POST",
            "/me/agents",
            json!({"handle": "too-long", "bio": "x".repeat(501)}),
        ),
    ] {
        let (status, _) = case
            .request(Some(case.owner), method, path, Some(payload))
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    let (status, _) = case
        .request(
            Some(case.viewer),
            "PATCH",
            &path,
            Some(json!({"bio": "Tampered"})),
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let db = case.pool.get().await?;
    let invalid = db
        .execute(
            "update user_agents set bio=$2 where id=$1",
            &[&Uuid::parse_str(id)?, &"x".repeat(501)],
        )
        .await
        .unwrap_err();
    assert_eq!(
        invalid.code(),
        Some(&tokio_postgres::error::SqlState::CHECK_VIOLATION)
    );
    drop(db);
    case.cleanup().await
}

#[tokio::test]
async fn agent_profile_bio_is_saved_when_a_credential_generates_the_handle() -> anyhow::Result<()> {
    let case = AgentProfileCase::create().await?;
    let credential = Uuid::new_v4();
    case.pool.get().await?.execute(
        "insert into user_credentials(id,user_id,kind,label,nonce_b64,ciphertext_b64) values($1,$2,'openai_api_key','Build helper','fixture','fixture')",
        &[&credential, &case.owner],
    ).await?;
    let (status, agent) = case.request(Some(case.owner), "POST", "/me/agents", Some(json!({
        "credentialId": credential, "bio": "I support the team.", "description": "Keep tests focused."
    }))).await?;
    assert_eq!(status, StatusCode::OK, "{agent}");
    assert_eq!(agent["bio"], "I support the team.");
    assert_eq!(agent["description"], "Keep tests focused.");
    case.cleanup().await
}

#[tokio::test]
async fn agent_profile_public_read_requires_both_current_project_grants_and_excludes_private_fields(
) -> anyhow::Result<()> {
    let case = AgentProfileCase::create().await?;
    let agent = case.create_agent("I help this team with builds.").await?;
    let id = agent["id"].as_str().unwrap();
    let path = format!("/projects/{}/agents/{id}/profile", case.project);
    for user in [case.owner, case.viewer, case.manager, case.org_viewer] {
        let (status, public) = case.request(Some(user), "GET", &path, None).await?;
        assert_eq!(status, StatusCode::OK, "{public}");
        assert_eq!(
            public,
            json!({"id": id, "handle": "build-bot", "displayName": "Build bot", "avatarSeed": "robot", "bio": "I help this team with builds."})
        );
    }
    let (status, _) = case.request(None, "GET", &path, None).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = case
        .request(Some(case.outsider), "GET", &path, None)
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = case
        .request(
            Some(case.viewer),
            "GET",
            &format!("/projects/{}/agents/{id}/profile", case.other_project),
            None,
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);

    case.pool
        .get()
        .await?
        .execute(
            "delete from project_memberships where project_id=$1 and user_id=$2",
            &[&case.project, &case.viewer],
        )
        .await?;
    let (status, _) = case.request(Some(case.viewer), "GET", &path, None).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    case.pool
        .get()
        .await?
        .execute(
            "delete from project_memberships where project_id=$1 and user_id=$2",
            &[&case.project, &case.owner],
        )
        .await?;
    let (status, _) = case.request(Some(case.manager), "GET", &path, None).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    case.pool
        .get()
        .await?
        .execute(
            "update user_agents set deleted_at=now() where id=$1",
            &[&Uuid::parse_str(id)?],
        )
        .await?;
    let (status, _) = case.request(Some(case.manager), "GET", &path, None).await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    case.cleanup().await
}
