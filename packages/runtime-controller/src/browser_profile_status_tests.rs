//! Authenticated metadata-only HTTP checks against an isolated PostgreSQL DB.
//! Missing TEST_DATABASE_URL is a failure, not a skipped or passing fixture.

use super::*;
use axum::body::to_bytes;
use axum::http::Request;
use serde_json::{json, Value};
use tower::ServiceExt;

struct Fixture {
    pool: PgPool,
    config: crate::config::AppConfig,
    project_id: Uuid,
    unrelated_project_id: Uuid,
    users: [Uuid; 3],
    tokens: [String; 3],
}

impl Fixture {
    async fn new(enabled: bool) -> anyhow::Result<Self> {
        let pool =
            crate::tests::require_origin_test_pool("browser profile status HTTP tests").await?;
        ensure_browser_profiles_table(&pool).await?;
        let users = std::array::from_fn(|_| Uuid::new_v4());
        for user in &users {
            crate::tests::ensure_test_user(&pool, user).await?;
        }
        let project_id = Uuid::new_v4();
        let unrelated_project_id = Uuid::new_v4();
        {
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into projects (id, owner_user_id, name, project_type, status)
                     values ($1, $2, 'Status fixture', 'customer', 'active'),
                            ($3, $4, 'Unrelated status fixture', 'customer', 'active')",
                    &[&project_id, &users[0], &unrelated_project_id, &users[2]],
                )
                .await?;
            connection
                .execute(
                    "insert into project_memberships (project_id, user_id, role)
                     values ($1, $2, 'viewer')",
                    &[&project_id, &users[1]],
                )
                .await?;
        }
        let mut config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            "browser-profile-status-test",
        );
        if enabled {
            config.browser_profile_persist_project_ids.push(project_id);
        }
        let mut tokens = std::array::from_fn(|_| String::new());
        for (index, user) in users.iter().enumerate() {
            tokens[index] = crate::auth::issue_controller_token(&config, user)
                .map_err(|(status, _)| anyhow::anyhow!("fixture token issuance failed: {status}"))?
                .token;
        }
        Ok(Self {
            pool,
            config,
            project_id,
            unrelated_project_id,
            users,
            tokens,
        })
    }

    async fn request(
        &self,
        project: &str,
        token: Option<&str>,
    ) -> anyhow::Result<(StatusCode, HeaderMap, Value)> {
        let app = router().with_state(crate::tests::build_test_state(
            self.pool.clone(),
            self.config.clone(),
        ));
        let mut request =
            Request::builder().uri(format!("/projects/{project}/browser-profile/status"));
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = app.oneshot(request.body(Body::empty())?).await?;
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = to_bytes(response.into_body(), 16 * 1024).await?;
        Ok((status, headers, serde_json::from_slice(&bytes)?))
    }

    async fn save_metadata(&self, runtime_id: Option<Uuid>) -> anyhow::Result<()> {
        // Deliberately not decryptable, and the fixture has no encryption key.
        // A metadata read must succeed without loading usable login material.
        self.pool
            .get()
            .await?
            .execute(
                "insert into project_browser_profiles
                (id, project_id, scope, version, nonce_b64, ciphertext_b64, bytes,
                 updated_by_runtime, updated_at)
             values ($1, $2, 'project', 1, 'inert-invalid-nonce', 'inert-invalid-archive', 0,
                     $3, '2026-01-02T03:04:05Z')",
                &[&Uuid::new_v4(), &self.project_id, &runtime_id],
            )
            .await?;
        Ok(())
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        let connection = self.pool.get().await?;
        for project in [self.project_id, self.unrelated_project_id] {
            connection
                .execute("delete from projects where id = $1", &[&project])
                .await?;
        }
        for user in self.users {
            connection
                .execute("delete from auth.users where id = $1", &[&user])
                .await?;
        }
        Ok(())
    }
}

#[tokio::test]
async fn browser_profile_status_enabled_empty_store_reports_no_save() -> anyhow::Result<()> {
    let fixture = Fixture::new(true).await?;
    let (status, headers, body) = fixture
        .request(&fixture.project_id.to_string(), Some(&fixture.tokens[0]))
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "no-store");
    assert_eq!(
        body,
        json!({"enabled": true, "lastSavedAt": null, "savedByRuntimeId": null})
    );
    fixture.cleanup().await
}

#[tokio::test]
async fn browser_profile_status_viewer_reads_only_saved_metadata() -> anyhow::Result<()> {
    let fixture = Fixture::new(true).await?;
    let runtime_id = Uuid::new_v4();
    fixture.save_metadata(Some(runtime_id)).await?;
    let (status, headers, body) = fixture
        .request(&fixture.project_id.to_string(), Some(&fixture.tokens[1]))
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "no-store");
    assert_eq!(
        body,
        json!({"enabled": true, "lastSavedAt": "2026-01-02T03:04:05+00:00", "savedByRuntimeId": runtime_id})
    );
    fixture.cleanup().await
}

#[tokio::test]
async fn browser_profile_status_disabled_policy_preserves_honest_save_metadata(
) -> anyhow::Result<()> {
    let fixture = Fixture::new(false).await?;
    fixture.save_metadata(None).await?;
    let (status, headers, body) = fixture
        .request(&fixture.project_id.to_string(), Some(&fixture.tokens[0]))
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "no-store");
    assert_eq!(
        body,
        json!({"enabled": false, "lastSavedAt": "2026-01-02T03:04:05+00:00", "savedByRuntimeId": null})
    );
    fixture.cleanup().await
}

#[tokio::test]
async fn browser_profile_status_rejects_nonmembers_and_noninteractive_tokens() -> anyhow::Result<()>
{
    let mut fixture = Fixture::new(true).await?;
    fixture.save_metadata(Some(Uuid::new_v4())).await?;
    let project = fixture.project_id.to_string();
    for token in [
        None,
        Some("invalid-token"),
        Some("internal"),
        Some("service-role-token"),
    ] {
        let (status, _, body) = fixture.request(&project, token).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(body.get("lastSavedAt").is_none());
    }
    let (status, _, body) = fixture.request(&project, Some(&fixture.tokens[2])).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.get("lastSavedAt").is_none());
    let (status, _, _) = fixture
        .request(
            &fixture.unrelated_project_id.to_string(),
            Some(&fixture.tokens[0]),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Even a runtime capability attributed to the project owner is not an
    // interactive user session and cannot inspect this human-facing endpoint.
    fixture.config.service_runtime_user_id = Some(fixture.users[0]);
    let agent_token = crate::auth::issue_agent_token_with_browser_profile_scope_for_test(
        &fixture.config,
        &fixture.project_id,
        &Uuid::new_v4(),
        None,
        None,
    )
    .map_err(|(status, _)| anyhow::anyhow!("fixture agent token issuance failed: {status}"))?
    .token;
    let (status, _, body) = fixture.request(&project, Some(&agent_token)).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body.get("lastSavedAt").is_none());
    fixture.cleanup().await
}

#[tokio::test]
async fn browser_profile_status_rejects_unknown_deleted_and_invalid_projects() -> anyhow::Result<()>
{
    let fixture = Fixture::new(true).await?;
    let token = Some(fixture.tokens[0].as_str());
    let (status, _, _) = fixture.request(&Uuid::new_v4().to_string(), token).await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = fixture.request("not-a-uuid", token).await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    fixture.save_metadata(Some(Uuid::new_v4())).await?;
    fixture
        .pool
        .get()
        .await?
        .execute(
            "update projects set status = 'deleted' where id = $1",
            &[&fixture.project_id],
        )
        .await?;
    let (status, _, body) = fixture
        .request(&fixture.project_id.to_string(), token)
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body.get("lastSavedAt").is_none());
    fixture.cleanup().await
}
