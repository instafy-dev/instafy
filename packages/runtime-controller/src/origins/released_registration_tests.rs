use super::*;
use axum::http::HeaderMap;

struct PrivateOriginFixture {
    state: AppState,
    project_id: Uuid,
    runtime_id: Uuid,
    owner_id: Uuid,
    generation: Uuid,
    lease_id: Option<Uuid>,
}

impl PrivateOriginFixture {
    async fn new(pool: &PgPool) -> anyhow::Result<Self> {
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let owner_id = Uuid::new_v4();
        let generation = Uuid::new_v4();
        let mut capabilities = json!({
            "_instafySelfHostedAccess": { "mode": "private", "ownerUserId": owner_id }
        });
        runtime::set_runtime_generation_capability(&mut capabilities, generation);
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
                &[&project_id],
            )
            .await?;
        connection.execute(
            "insert into runtimes (id, project_id, provider, status, capabilities, last_seen_at)
             values ($1, $2, 'self-hosted', 'ready', $3, now())",
            &[&runtime_id, &project_id, &capabilities],
        ).await?;
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "released-origin-recovery",
        );
        Ok(Self {
            state: build_test_state(pool.clone(), config),
            project_id,
            runtime_id,
            owner_id,
            generation,
            lease_id: None,
        })
    }

    fn headers(&self, owner: Uuid, generation: Uuid) -> HeaderMap {
        let token = crate::tokens::mint_scoped_token_with_runtime_generation(
            &self.state.config,
            ScopedTokenRequest {
                audience: self.runtime_id.to_string(),
                subject: owner.to_string(),
                project_id: self.project_id.to_string(),
                origin_id: Some(self.runtime_id.to_string()),
                runtime_id: Some(self.runtime_id.to_string()),
                protocol: None,
                scopes: vec!["origin.register".to_string(), "origin.presence".to_string()],
                lease_id: self.lease_id.map(|id| id.to_string()),
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: None,
            },
            Some(generation),
        )
        .expect("mint generation-bound origin token");
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", token.token)).unwrap(),
        );
        headers
    }

    fn request(&self, endpoint: &str) -> OriginRegisterBody {
        OriginRegisterBody {
            project_id: self.project_id.to_string(),
            origin_id: self.runtime_id.to_string(),
            mode: Some("desktop".to_string()),
            endpoint: endpoint.to_string(),
            protocols: Some(vec!["http".to_string()]),
            region: None,
            device_id: None,
            metadata: None,
        }
    }

    async fn register_and_release(&self) -> anyhow::Result<()> {
        post_origin_register(
            axum::extract::State(self.state.clone()),
            self.headers(self.owner_id, self.generation),
            AxumJson(self.request("http://127.0.0.1:54332")),
        )
        .await
        .map_err(|error| controller_error("initial private origin registration", error))?;
        let mut connection = self.state.pool.get().await?;
        let transaction = connection.transaction().await?;
        runtime::release_origin_instances_for_runtime(&transaction, &self.runtime_id)
            .await
            .map_err(|error| controller_error("release private origin", error))?;
        transaction.commit().await?;
        self.assert_released().await
    }

    async fn assert_released(&self) -> anyhow::Result<()> {
        let row = self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select status, required, endpoint from origin_instances where origin_id = $1",
                &[&self.runtime_id],
            )
            .await?;
        assert_eq!(row.get::<_, String>("status"), "released");
        assert!(!row.get::<_, bool>("required"));
        assert_eq!(row.get::<_, Option<String>>("endpoint"), None);
        Ok(())
    }
}

#[tokio::test]
async fn released_private_origin_reactivates_only_for_current_owner_generation(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool(
        "released_private_origin_reactivates_only_for_current_owner_generation",
    )
    .await?;
    let fixture = PrivateOriginFixture::new(&pool).await?;
    fixture.register_and_release().await?;
    pool.get()
        .await?
        .execute(
            "update runtimes set status = 'stopped' where id = $1",
            &[&fixture.runtime_id],
        )
        .await?;
    let stopped = post_origin_register(
        axum::extract::State(fixture.state.clone()),
        fixture.headers(fixture.owner_id, fixture.generation),
        AxumJson(fixture.request("http://127.0.0.1:54333")),
    )
    .await
    .expect_err("a stopped runtime cannot reactivate its released origin");
    assert_eq!(stopped.0, StatusCode::FORBIDDEN);
    fixture.assert_released().await?;

    // Model the owner-authorized successor registration: the same immutable
    // runtime owner and ID, a new persisted generation, and a live runtime.
    let successor = Uuid::new_v4();
    let mut capabilities = json!({
        "_instafySelfHostedAccess": { "mode": "private", "ownerUserId": fixture.owner_id }
    });
    runtime::set_runtime_generation_capability(&mut capabilities, successor);
    pool.get()
        .await?
        .execute(
            "update runtimes set status = 'ready', capabilities = $2 where id = $1",
            &[&fixture.runtime_id, &capabilities],
        )
        .await?;
    for (owner, generation) in [
        (fixture.owner_id, fixture.generation),
        (Uuid::new_v4(), successor),
    ] {
        let rejected = post_origin_register(
            axum::extract::State(fixture.state.clone()),
            fixture.headers(owner, generation),
            AxumJson(fixture.request("http://127.0.0.1:54333")),
        )
        .await
        .expect_err("stale generation or wrong owner cannot revive the binding");
        assert_eq!(rejected.0, StatusCode::UNAUTHORIZED);
        fixture.assert_released().await?;
    }

    let response = post_origin_register(
        axum::extract::State(fixture.state.clone()),
        fixture.headers(fixture.owner_id, successor),
        AxumJson(fixture.request("http://127.0.0.1:54333")),
    )
    .await
    .map_err(|error| controller_error("reactivate canonical private origin", error))?;
    assert_eq!(response.origin_id, fixture.runtime_id);
    let rows = pool
        .get()
        .await?
        .query(
            "select id, project_id, runtime_id, lease_id, origin_id, status, required, endpoint
         from origin_instances where runtime_id = $1",
            &[&fixture.runtime_id],
        )
        .await?;
    assert_eq!(
        rows.len(),
        1,
        "restart must reuse its binding, not create another identity"
    );
    let row = &rows[0];
    assert_eq!(row.get::<_, Uuid>("id"), fixture.runtime_id);
    assert_eq!(row.get::<_, Uuid>("project_id"), fixture.project_id);
    assert_eq!(
        row.get::<_, Option<Uuid>>("runtime_id"),
        Some(fixture.runtime_id)
    );
    assert_eq!(
        row.get::<_, Option<Uuid>>("origin_id"),
        Some(fixture.runtime_id)
    );
    assert_eq!(row.get::<_, Option<Uuid>>("lease_id"), None);
    assert_eq!(row.get::<_, String>("status"), "online");
    assert!(row.get::<_, bool>("required"));
    assert_eq!(
        row.get::<_, Option<String>>("endpoint").as_deref(),
        Some("http://127.0.0.1:54333")
    );

    let headers = fixture.headers(fixture.owner_id, successor);
    let presence = origins::router()
        .with_state(fixture.state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/projects/{}/origin/presence/beat",
                    fixture.project_id
                ))
                .header("content-type", "application/json")
                .header("authorization", headers.get("authorization").unwrap())
                .body(Body::from(
                    json!({ "originId": fixture.runtime_id, "status": "online" }).to_string(),
                ))?,
        )
        .await?;
    assert_eq!(presence.status(), StatusCode::OK);
    cleanup_origin_project(&pool, &fixture.project_id).await?;
    Ok(())
}

#[tokio::test]
async fn released_origin_reactivation_preserves_identity_and_allocation_boundaries(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool(
        "released_origin_reactivation_preserves_identity_and_allocation_boundaries",
    )
    .await?;
    for scenario in [
        "foreign-runtime",
        "foreign-project",
        "unbound",
        "noncanonical-instance",
        "active-preallocation",
        "managed-lease",
        "private-lease",
    ] {
        let mut fixture = PrivateOriginFixture::new(&pool).await?;
        let other = PrivateOriginFixture::new(&pool).await?;
        fixture.register_and_release().await?;
        {
            let connection = pool.get().await?;
            match scenario {
                "foreign-runtime" => {
                    connection
                        .execute(
                            "update origin_instances set runtime_id = $2 where id = $1",
                            &[&fixture.runtime_id, &other.runtime_id],
                        )
                        .await?;
                }
                "foreign-project" => {
                    connection
                        .execute(
                            "update origin_instances set project_id = $2 where id = $1",
                            &[&fixture.runtime_id, &other.project_id],
                        )
                        .await?;
                }
                "unbound" => {
                    connection
                        .execute(
                            "update origin_instances set origin_id = null where id = $1",
                            &[&fixture.runtime_id],
                        )
                        .await?;
                }
                "noncanonical-instance" => {
                    connection
                        .execute(
                            "update origin_instances set id = $2 where id = $1",
                            &[&fixture.runtime_id, &Uuid::new_v4()],
                        )
                        .await?;
                }
                "active-preallocation" => {
                    connection
                        .execute(
                            "insert into origin_instances
                         (id, project_id, runtime_id, required, mode, status, protocols, updated_at)
                         values ($1, $2, $3, true, 'desktop', 'requested', ARRAY['http']::text[],
                                 now() - interval '1 day')",
                            &[&Uuid::new_v4(), &fixture.project_id, &fixture.runtime_id],
                        )
                        .await?;
                }
                "managed-lease" | "private-lease" => {
                    let lease_id = Uuid::new_v4();
                    connection.execute(
                        "insert into runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
                         values ($1, $2, $3, 'active', now(), now())",
                        &[&lease_id, &fixture.project_id, &fixture.runtime_id],
                    ).await?;
                    let provider = if scenario == "managed-lease" {
                        "instafy-cloud"
                    } else {
                        "self-hosted"
                    };
                    connection
                        .execute(
                            "update runtimes set provider = $2, active_lease_id = $3 where id = $1",
                            &[&fixture.runtime_id, &provider, &lease_id],
                        )
                        .await?;
                    if scenario == "managed-lease" {
                        connection
                            .execute(
                                "update runtimes set capabilities = '{}'::jsonb where id = $1",
                                &[&fixture.runtime_id],
                            )
                            .await?;
                    }
                    connection
                        .execute(
                            "update origin_instances set lease_id = $2 where id = $1",
                            &[&fixture.runtime_id, &lease_id],
                        )
                        .await?;
                    fixture.lease_id = Some(lease_id);
                }
                _ => unreachable!(),
            }
        }
        let before: serde_json::Value = pool
            .get()
            .await?
            .query_one(
                "select to_jsonb(i) from origin_instances i where id = $1 or origin_id = $1",
                &[&fixture.runtime_id],
            )
            .await?
            .get(0);
        let rejected = post_origin_register(
            axum::extract::State(fixture.state.clone()),
            fixture.headers(fixture.owner_id, fixture.generation),
            AxumJson(fixture.request("http://127.0.0.1:54333")),
        )
        .await
        .expect_err(scenario);
        assert_eq!(rejected.0, StatusCode::FORBIDDEN, "{scenario}");
        if scenario == "managed-lease" {
            assert_eq!(
                rejected.1.message,
                "provider-managed runtime is missing its preallocated origin instance"
            );
        }
        let after: serde_json::Value = pool
            .get()
            .await?
            .query_one(
                "select to_jsonb(i) from origin_instances i where id = $1 or origin_id = $1",
                &[&fixture.runtime_id],
            )
            .await?
            .get(0);
        assert_eq!(
            after, before,
            "{scenario}: rejected recovery must not mutate the binding"
        );
        cleanup_origin_project(&pool, &fixture.project_id).await?;
        cleanup_origin_project(&pool, &other.project_id).await?;
    }
    Ok(())
}
