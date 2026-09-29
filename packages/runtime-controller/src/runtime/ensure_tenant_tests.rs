use super::*;

use axum::body::{to_bytes, Body};
use axum::http::Request;
use futures_util::FutureExt;
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;

/// Open to every organization. The tenant request names it, and the host
/// runtime runs on it unless a test moves it to [`HOST_ORG_PROVIDER`].
const OPEN_PROVIDER: &str = "tenant-attach-open";
/// Available to the host organization only.
const HOST_ORG_PROVIDER: &str = "tenant-attach-host-org";
const SERVICE_ROLE_TOKEN: &str = "service-role-token";

fn test_provider(id: &str, owner_org_id: Option<Uuid>) -> crate::config::RuntimeProviderConfig {
    crate::config::RuntimeProviderConfig {
        id: id.to_string(),
        display_name: id.to_string(),
        kind: "noop".to_string(),
        owner_org_id,
        allowed_org_ids: vec![],
        endpoint: None,
        auth_token: None,
        metadata: None,
    }
}

/// A host project in one organization whose runtime holds an active shared
/// lease and an online origin, plus candidate tenant projects in the host's
/// organization and in another one.
struct TenantAttachFixture {
    pool: crate::config::PgPool,
    state: AppState,
    host_org_id: Uuid,
    other_org_id: Uuid,
    host_project_id: Uuid,
    /// In the host organization.
    same_org_tenant_project_id: Uuid,
    /// In the host organization; attached by the service role.
    service_tenant_project_id: Uuid,
    /// In the other organization.
    other_org_project_id: Uuid,
    runtime_id: Uuid,
    shared_lease_id: Uuid,
    /// Owner of the host organization.
    host_writer: Uuid,
    /// Owner of the other organization only.
    outsider: Uuid,
    /// Owner of the other organization and a viewer of the host project.
    host_viewer: Uuid,
    /// Owner of the other organization and a builder of the host project.
    cross_org_writer: Uuid,
}

impl TenantAttachFixture {
    async fn setup(label: &str) -> anyhow::Result<Self> {
        let pool = crate::tests::require_origin_test_pool(label).await?;
        let mut config = crate::tests::build_app_config(
            crate::tests::test_origin_private_key(),
            crate::tests::test_origin_public_key(),
            label,
        );
        let host_org_id = Uuid::new_v4();
        config.runtime_providers = vec![
            test_provider(OPEN_PROVIDER, None),
            test_provider(HOST_ORG_PROVIDER, Some(host_org_id)),
        ];
        let state = crate::tests::build_test_state(pool.clone(), config);

        let fixture = Self {
            pool,
            state,
            host_org_id,
            other_org_id: Uuid::new_v4(),
            host_project_id: Uuid::new_v4(),
            same_org_tenant_project_id: Uuid::new_v4(),
            service_tenant_project_id: Uuid::new_v4(),
            other_org_project_id: Uuid::new_v4(),
            runtime_id: Uuid::new_v4(),
            shared_lease_id: Uuid::new_v4(),
            host_writer: Uuid::new_v4(),
            outsider: Uuid::new_v4(),
            host_viewer: Uuid::new_v4(),
            cross_org_writer: Uuid::new_v4(),
        };
        for user_id in fixture.users() {
            crate::tests::ensure_test_user(&fixture.pool, &user_id).await?;
        }
        let connection = fixture.pool.get().await?;
        for org_id in [fixture.host_org_id, fixture.other_org_id] {
            connection
                .execute(
                    "insert into organizations (id, slug, name) values ($1, $2, $3)",
                    &[&org_id, &format!("{label}-{org_id}"), &label],
                )
                .await?;
        }
        connection
            .execute(
                "insert into projects (id, org_id, project_type, status)
                 values ($1, $4, 'customer', 'active'),
                        ($2, $4, 'customer', 'active'),
                        ($3, $4, 'customer', 'active'),
                        ($5, $6, 'customer', 'active')",
                &[
                    &fixture.host_project_id,
                    &fixture.same_org_tenant_project_id,
                    &fixture.service_tenant_project_id,
                    &fixture.host_org_id,
                    &fixture.other_org_project_id,
                    &fixture.other_org_id,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role)
                 values ($1, $2, 'owner'), ($3, $4, 'owner'), ($3, $5, 'owner'), ($3, $6, 'owner')",
                &[
                    &fixture.host_org_id,
                    &fixture.host_writer,
                    &fixture.other_org_id,
                    &fixture.outsider,
                    &fixture.host_viewer,
                    &fixture.cross_org_writer,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'viewer'), ($1, $3, 'builder')",
                &[
                    &fixture.host_project_id,
                    &fixture.host_viewer,
                    &fixture.cross_org_writer,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtimes
                    (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
                 values ($1, $2, $3, 'ready', 600, now())",
                &[
                    &fixture.runtime_id,
                    &fixture.host_project_id,
                    &OPEN_PROVIDER,
                ],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases
                    (id, project_id, runtime_id, status, scope, metadata,
                     requested_at, launched_at)
                 values ($1, $2, $3, 'active', 'shared', $4,
                         now() - interval '1 hour', now() - interval '1 hour')",
                &[
                    &fixture.shared_lease_id,
                    &fixture.host_project_id,
                    &fixture.runtime_id,
                    &PgJson(json!({ "source": "host", "sizeId": "standard" })),
                ],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&fixture.runtime_id, &fixture.shared_lease_id],
            )
            .await?;
        connection
            .execute(
                "insert into origin_instances
                    (project_id, runtime_id, lease_id, required, mode, protocols,
                     metadata, status, endpoint)
                 values ($1, $2, $3, true, 'hosted', array['http'], $4, 'online',
                         'https://origin.test')",
                &[
                    &fixture.host_project_id,
                    &fixture.runtime_id,
                    &fixture.shared_lease_id,
                    &PgJson(json!({ "owner": "host" })),
                ],
            )
            .await?;
        drop(connection);
        Ok(fixture)
    }

    fn users(&self) -> [Uuid; 4] {
        [
            self.host_writer,
            self.outsider,
            self.host_viewer,
            self.cross_org_writer,
        ]
    }

    fn shared_db_fixture(&self) -> crate::tests::SharedDbFixture {
        crate::tests::SharedDbFixture {
            organizations: vec![self.host_org_id, self.other_org_id],
            projects: vec![
                self.host_project_id,
                self.same_org_tenant_project_id,
                self.service_tenant_project_id,
                self.other_org_project_id,
            ],
        }
    }

    fn user_token(&self, user_id: Uuid) -> anyhow::Result<String> {
        crate::auth::issue_controller_token(&self.state.config, &user_id)
            .map(|token| token.token)
            .map_err(|(status, Json(error))| anyhow::anyhow!("{status}: {}", error.message))
    }

    /// `POST /runtime/ensure` asking to attach `tenant_project_id` to
    /// `runtime_id` as a tenant.
    async fn attach(
        &self,
        bearer: &str,
        tenant_project_id: Uuid,
        runtime_id: Uuid,
        metadata: JsonValue,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        let response = crate::runtime::router()
            .with_state(self.state.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/runtime/ensure")
                    .header("authorization", format!("Bearer {bearer}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "project_id": tenant_project_id.to_string(),
                            "provider": OPEN_PROVIDER,
                            "scope": "tenant",
                            "runtimeId": runtime_id.to_string(),
                            "metadata": metadata,
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        let status = response.status();
        let body: JsonValue =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
        Ok((status, body))
    }

    async fn tenant_leases(&self) -> anyhow::Result<Vec<(Uuid, Uuid, Option<Uuid>)>> {
        let rows = self
            .pool
            .get()
            .await?
            .query(
                "select id, project_id, parent_lease_id
                 from runtime_leases
                 where runtime_id = $1 and scope = 'tenant'
                 order by requested_at",
                &[&self.runtime_id],
            )
            .await?;
        Ok(rows
            .into_iter()
            .map(|row| {
                (
                    row.get("id"),
                    row.get("project_id"),
                    row.get("parent_lease_id"),
                )
            })
            .collect())
    }

    async fn lease_metadata(&self, lease_id: Uuid) -> anyhow::Result<Option<JsonValue>> {
        Ok(self
            .pool
            .get()
            .await?
            .query_one(
                "select metadata from runtime_leases where id = $1",
                &[&lease_id],
            )
            .await?
            .get("metadata"))
    }

    async fn set_runtime_provider(&self, provider: &str) -> anyhow::Result<()> {
        self.pool
            .get()
            .await?
            .execute(
                "update runtimes set provider = $2 where id = $1",
                &[&self.runtime_id, &provider],
            )
            .await?;
        Ok(())
    }

    /// The host's origin row, as the fields a tenant upsert would rewrite.
    async fn host_origin(&self) -> anyhow::Result<JsonValue> {
        let row = self
            .pool
            .get()
            .await?
            .query_one(
                "select project_id, mode, protocols, metadata, status, endpoint, updated_at
                 from origin_instances
                 where lease_id = $1",
                &[&self.shared_lease_id],
            )
            .await?;
        Ok(json!({
            "projectId": row.get::<_, Uuid>("project_id"),
            "mode": row.get::<_, Option<String>>("mode"),
            "protocols": row.get::<_, Vec<String>>("protocols"),
            "metadata": row.get::<_, Option<JsonValue>>("metadata"),
            "status": row.get::<_, String>("status"),
            "endpoint": row.get::<_, Option<String>>("endpoint"),
            "updatedAt": row.get::<_, chrono::DateTime<Utc>>("updated_at").to_rfc3339(),
        }))
    }

    /// Run a test body, then delete the fixture's rows and users however it
    /// ends.
    async fn run(
        &self,
        body: impl std::future::Future<Output = anyhow::Result<()>>,
    ) -> anyhow::Result<()> {
        let outcome = std::panic::AssertUnwindSafe(crate::tests::with_shared_db_fixture(
            self.shared_db_fixture(),
            body,
        ))
        .catch_unwind()
        .await;
        let cleanup = async {
            self.pool
                .get()
                .await?
                .execute(
                    "delete from auth.users where id = any($1)",
                    &[&self.users().to_vec()],
                )
                .await?;
            anyhow::Ok(())
        }
        .await;
        match outcome {
            Ok(result) => result.and(cleanup),
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }
}

/// A tenant attach names a runtime of another project. Writing to the tenant
/// project is not enough: the caller must also be able to write to the
/// runtime's own project. A caller who cannot is answered exactly as for a
/// runtime id that does not exist, and nothing on the host changes.
#[tokio::test]
async fn tenant_attach_requires_write_access_to_the_host_runtimes_project() -> anyhow::Result<()> {
    let fixture = TenantAttachFixture::setup("tenant-attach-authorization").await?;
    fixture
        .run(async {
            let fixture = &fixture;
            let host_origin_before = fixture.host_origin().await?;
            let metadata = json!({ "source": "tenant-attach-test" });

            let (missing_status, missing_body) = fixture
                .attach(
                    &fixture.user_token(fixture.outsider)?,
                    fixture.other_org_project_id,
                    Uuid::new_v4(),
                    metadata.clone(),
                )
                .await?;
            assert_eq!(missing_status, StatusCode::NOT_FOUND, "{missing_body}");
            assert_eq!(
                missing_body["code"],
                json!(TENANT_RUNTIME_NOT_FOUND_CODE),
                "{missing_body}"
            );

            for (case, user_id) in [
                ("writer of the tenant project only", fixture.outsider),
                ("viewer of the host project", fixture.host_viewer),
            ] {
                let (status, body) = fixture
                    .attach(
                        &fixture.user_token(user_id)?,
                        fixture.other_org_project_id,
                        fixture.runtime_id,
                        metadata.clone(),
                    )
                    .await?;
                assert_eq!(status, missing_status, "{case}: {body}");
                assert_eq!(
                    body, missing_body,
                    "{case}: the same answer as a missing runtime"
                );
            }

            // Allowed to write both projects, but the tenant project's
            // organization may not use the host runtime's provider.
            fixture.set_runtime_provider(HOST_ORG_PROVIDER).await?;
            let (status, body) = fixture
                .attach(
                    &fixture.user_token(fixture.cross_org_writer)?,
                    fixture.other_org_project_id,
                    fixture.runtime_id,
                    metadata.clone(),
                )
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            fixture.set_runtime_provider(OPEN_PROVIDER).await?;

            // The attach checks the authorized host again under its row lock.
            let (status, Json(error)) = ensure_runtime_tenant(
                &fixture.state,
                fixture.same_org_tenant_project_id,
                fixture.runtime_id,
                fixture.other_org_project_id,
                Some(metadata.clone()),
                OriginEnsureOptions::new(None, None, None),
            )
            .await
            .expect_err("a runtime outside the authorized host project is refused");
            assert_eq!(status, StatusCode::NOT_FOUND);
            assert_eq!(error.code.as_deref(), Some(TENANT_RUNTIME_NOT_FOUND_CODE));

            assert!(
                fixture.tenant_leases().await?.is_empty(),
                "a refused attach creates no lease"
            );
            assert_eq!(
                fixture.host_origin().await?,
                host_origin_before,
                "a refused attach leaves the host's origin alone"
            );

            for (case, bearer, tenant_project_id) in [
                (
                    "writer of both projects",
                    fixture.user_token(fixture.host_writer)?,
                    fixture.same_org_tenant_project_id,
                ),
                (
                    "service role",
                    SERVICE_ROLE_TOKEN.to_string(),
                    fixture.service_tenant_project_id,
                ),
            ] {
                let (status, body) = fixture
                    .attach(
                        &bearer,
                        tenant_project_id,
                        fixture.runtime_id,
                        metadata.clone(),
                    )
                    .await?;
                assert_eq!(status, StatusCode::OK, "{case}: {body}");
                assert_eq!(body["scope"], json!("tenant"), "{case}: {body}");
                assert_eq!(
                    body["runtime_id"],
                    json!(fixture.runtime_id.to_string()),
                    "{case}: {body}"
                );
                assert_eq!(
                    body["parentLeaseId"],
                    json!(fixture.shared_lease_id.to_string()),
                    "{case}: {body}"
                );
            }
            let leases = fixture.tenant_leases().await?;
            assert_eq!(leases.len(), 2, "{leases:?}");
            for (tenant_project_id, (_, lease_project_id, parent_lease_id)) in [
                fixture.same_org_tenant_project_id,
                fixture.service_tenant_project_id,
            ]
            .into_iter()
            .zip(leases)
            {
                assert_eq!(lease_project_id, tenant_project_id);
                assert_eq!(parent_lease_id, Some(fixture.shared_lease_id));
            }
            Ok(())
        })
        .await
}

/// A tenant lease's metadata is the caller's description of the attachment:
/// only its `source` and `label` strings are stored. Controller-owned keys,
/// such as a launch attestation, and launch settings, such as a runtime image,
/// are removed on the first attach and again on a re-attach, even when the
/// attestation names the tenant lease's own id. A re-attach without metadata
/// keeps what is stored.
#[tokio::test]
async fn tenant_lease_metadata_keeps_only_descriptive_strings_on_attach_and_reattach(
) -> anyhow::Result<()> {
    let fixture = TenantAttachFixture::setup("tenant-attach-metadata").await?;
    fixture
        .run(async {
            let fixture = &fixture;
            let token = fixture.user_token(fixture.host_writer)?;

            let (status, body) = fixture
                .attach(
                    &token,
                    fixture.same_org_tenant_project_id,
                    fixture.runtime_id,
                    json!({
                        "source": "tenant-attach-test",
                        "label": "first",
                        "runtimeFlavor": "webdev",
                        "runtimeAgentImage": "acme/runtime:one",
                        "runtime_agent_image": "acme/runtime:one",
                        "sizeId": "boost",
                        "env": { "INSTAFY_ENABLE_BROWSER_SESSION": "1" },
                        "_instafyManagedRuntimeLaunch": {
                            "version": 1,
                            "flavor": "webdev",
                            "generation": Uuid::new_v4().to_string(),
                        },
                    }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            let lease_id = body["leaseId"]
                .as_str()
                .and_then(|value| Uuid::parse_str(value).ok())
                .ok_or_else(|| anyhow::anyhow!("no tenant lease id: {body}"))?;
            assert_eq!(
                fixture.lease_metadata(lease_id).await?,
                Some(json!({ "source": "tenant-attach-test", "label": "first" })),
                "first attach"
            );

            let (status, body) = fixture
                .attach(
                    &token,
                    fixture.same_org_tenant_project_id,
                    fixture.runtime_id,
                    json!({
                        "label": "second",
                        "sizeId": "boost",
                        "_instafyManagedRuntimeLaunch": {
                            "version": 1,
                            "flavor": "webdev",
                            "generation": lease_id.to_string(),
                        },
                    }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(
                body["leaseId"],
                json!(lease_id.to_string()),
                "a re-attach reuses the tenant lease: {body}"
            );
            assert_eq!(
                fixture.lease_metadata(lease_id).await?,
                Some(json!({ "label": "second" })),
                "re-attach"
            );

            let (status, body) = fixture
                .attach(
                    &token,
                    fixture.same_org_tenant_project_id,
                    fixture.runtime_id,
                    JsonValue::Null,
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["leaseId"], json!(lease_id.to_string()), "{body}");
            assert_eq!(
                fixture.lease_metadata(lease_id).await?,
                Some(json!({ "label": "second" })),
                "a re-attach without metadata keeps the stored metadata"
            );
            Ok(())
        })
        .await
}

/// A requeue relaunch of a runtime with no live lease copies the metadata of
/// the runtime's newest own launch. Tenant leases on the runtime are newer
/// but launched nothing: neither another project's nor one that attached the
/// runtime's own project, whose parent lease is gone.
#[tokio::test]
async fn requeue_metadata_ignores_newer_tenant_leases() -> anyhow::Result<()> {
    let fixture = TenantAttachFixture::setup("tenant-requeue-metadata").await?;
    fixture
        .run(async {
            let fixture = &fixture;
            let connection = fixture.pool.get().await?;
            connection
                .execute(
                    "update runtime_leases
                     set status = 'released', released_at = now() - interval '30 minutes'
                     where id = $1",
                    &[&fixture.shared_lease_id],
                )
                .await?;
            connection
                .execute(
                    "update runtimes set active_lease_id = null, status = 'stopped' where id = $1",
                    &[&fixture.runtime_id],
                )
                .await?;
            for (tenant_project_id, parent_lease_id, minutes_ago) in [
                (
                    fixture.same_org_tenant_project_id,
                    Some(fixture.shared_lease_id),
                    10,
                ),
                (fixture.host_project_id, None, 5),
            ] {
                connection
                    .execute(
                        "insert into runtime_leases
                            (project_id, runtime_id, status, scope, parent_lease_id, metadata,
                             requested_at)
                         values ($1, $2, 'active', 'tenant', $3, $4,
                                 now() - ($5::integer * interval '1 minute'))",
                        &[
                            &tenant_project_id,
                            &fixture.runtime_id,
                            &parent_lease_id,
                            &PgJson(json!({ "source": "tenant", "sizeId": "boost" })),
                            &minutes_ago,
                        ],
                    )
                    .await?;
            }

            let runtime = {
                let mut connection = fixture.pool.get().await?;
                let transaction = connection.transaction().await?;
                let runtime = fetch_runtime_for_update(&transaction, &fixture.runtime_id)
                    .await
                    .map_err(|(_, Json(error))| anyhow::anyhow!(error.message))?;
                transaction.rollback().await?;
                runtime
            };
            let metadata = load_runtime_requeue_metadata(&fixture.state, &runtime)
                .await
                .map_err(|(_, Json(error))| anyhow::anyhow!(error.message))?;
            assert_eq!(
                metadata,
                Some(json!({ "source": "host", "sizeId": "standard" })),
                "the runtime's own launch, not a tenant's"
            );
            Ok(())
        })
        .await
}
