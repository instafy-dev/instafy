//! Chat attachments through the controller's routes, on the migrated
//! database: which runtimes the agent lease route gives signed URLs, for which
//! objects (only the leased conversation's), that a job row cannot supply URLs
//! of its own, that the route returns its pool slot before it waits on Storage,
//! and that deleting a space, or the team with all its spaces, purges their
//! prefixes, every conversation's folder included.

use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use httpmock::Method::POST;
use httpmock::MockServer;
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::chat_attachments::fake_storage::FakeBucket;
use crate::config::{AppConfig, PgPool, RuntimeProviderConfig};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    require_origin_test_pool_with_max_size, spawn_aborting, test_origin_private_key,
    test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::{agent, AppState};

const HOSTED_PROVIDER: &str = "instafy-cloud";
const SERVICE_ROLE_KEY: &str = "chat-attachment-lease-test-key";

#[derive(Clone, Copy)]
struct Space {
    org_id: Uuid,
    project_id: Uuid,
    owner_user_id: Uuid,
    conversation_id: Uuid,
}

async fn seed_space(pool: &PgPool, space: &Space, attachments: JsonValue) -> anyhow::Result<()> {
    ensure_test_user(pool, &space.owner_user_id).await?;
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into organizations (id, slug, name) values ($1, $2, 'chat attachments')",
            &[&space.org_id, &format!("chat-attachments-{}", space.org_id)],
        )
        .await?;
    connection
        .execute(
            "insert into projects (id, org_id, name, owner_user_id, project_type, status)
             values ($1, $2, 'chat attachments', $3, 'customer', 'active')",
            &[&space.project_id, &space.org_id, &space.owner_user_id],
        )
        .await?;
    connection
        .execute(
            "insert into conversations (id, project_id, created_by, visibility)
             values ($1, $2, $3, 'private')",
            &[
                &space.conversation_id,
                &space.project_id,
                &space.owner_user_id,
            ],
        )
        .await?;
    connection
        .execute(
            "insert into conversation_messages
             (id, conversation_id, project_id, role, content, created_by, metadata)
             values ($1, $2, $3, 'user', 'what is in this picture?', $4, $5)",
            &[
                &Uuid::new_v4(),
                &space.conversation_id,
                &space.project_id,
                &space.owner_user_id,
                &PgJson(json!({ "attachments": attachments })),
            ],
        )
        .await?;
    Ok(())
}

async fn add_runtime(
    pool: &PgPool,
    space: &Space,
    capabilities: JsonValue,
) -> anyhow::Result<Uuid> {
    let runtime_id = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "insert into runtimes (
                 id, project_id, provider, status, endpoint_url, task_ref,
                 idle_ttl_seconds, last_seen_at, capabilities
             ) values ($1, $2, $3, 'ready', 'http://runtime.invalid', $4, 600, now(), $5)",
            &[
                &runtime_id,
                &space.project_id,
                &HOSTED_PROVIDER,
                &format!("chat-attachments-{runtime_id}"),
                &PgJson(capabilities),
            ],
        )
        .await?;
    Ok(runtime_id)
}

/// A queued job pinned to `runtime_id`, with a BYO-shaped credential so the
/// platform lane plays no part.
async fn queue_job(
    pool: &PgPool,
    space: &Space,
    runtime_id: &Uuid,
    payload: JsonValue,
) -> anyhow::Result<Uuid> {
    let credential_id = Uuid::new_v4();
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into user_credentials (
                 id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata
             ) values ($1, $2, 'openai_api_key', 'Chat attachments', 'test-nonce',
                 'test-ciphertext', '{}'::jsonb)",
            &[&credential_id, &space.owner_user_id],
        )
        .await?;
    let job_id = Uuid::new_v4();
    connection
        .execute(
            "insert into agent_jobs (
                 id, project_id, conversation_id, status, payload, credential_id,
                 target_runtime_id
             ) values ($1, $2, $3, 'queued', $4, $5, $6)",
            &[
                &job_id,
                &space.project_id,
                &space.conversation_id,
                &PgJson(payload),
                &credential_id,
                runtime_id,
            ],
        )
        .await?;
    Ok(job_id)
}

/// A controller that signs with `SERVICE_ROLE_KEY` on the Storage at
/// `storage_url` and runs hosted runtimes, which may lease every job.
fn hosted_lease_config(key_id: &str, storage_url: String) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), key_id);
    config.strict_mode = false;
    config._supabase_project_url = storage_url;
    config.supabase_service_role_key = Some(SERVICE_ROLE_KEY.to_string());
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: HOSTED_PROVIDER.to_string(),
        display_name: "Instafy Cloud".to_string(),
        kind: "noop".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: None,
        auth_token: None,
        metadata: None,
    }];
    config
}

async fn lease(state: &AppState, space: &Space, runtime_id: &Uuid) -> anyhow::Result<JsonValue> {
    let token =
        crate::auth::issue_agent_token(&state.config, &space.project_id, runtime_id, None, None)
            .map_err(|(status, error)| {
                anyhow::anyhow!("issue agent token: {status} {}", error.0.message)
            })?
            .token;
    let response = agent::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent/lease")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(
                    json!({ "max": 1, "lease_seconds": 120 }).to_string(),
                ))?,
        )
        .await?;
    let status = response.status();
    let body: JsonValue =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
    anyhow::ensure!(status == StatusCode::OK, "lease returned {status}: {body}");
    Ok(body)
}

#[tokio::test]
async fn lease_signs_own_conversation_attachments_only_for_runtimes_that_download_them(
) -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("lease_signs_own_conversation_attachments_only_for_runtimes")
            .await?;
    let space = Space {
        org_id: Uuid::new_v4(),
        project_id: Uuid::new_v4(),
        owner_user_id: Uuid::new_v4(),
        conversation_id: Uuid::new_v4(),
    };
    let own = format!(
        "{}/{}/6a000000-0000-4000-8000-000000000001.png",
        space.project_id, space.conversation_id
    );
    let foreign = format!(
        "{}/{}/6a000000-0000-4000-8000-000000000002.png",
        Uuid::new_v4(),
        space.conversation_id
    );
    // The same space, but a conversation the job does not belong to: its
    // participants may differ, so it is never signed for this one.
    let other_conversation = format!(
        "{}/{}/6a000000-0000-4000-8000-000000000003.png",
        space.project_id,
        Uuid::new_v4()
    );
    let attachments = json!([
        { "kind": "image", "storagePath": own, "fileName": "photo.png",
          "mimeType": "image/png", "sizeBytes": 2048 },
        { "kind": "image", "storagePath": foreign, "fileName": "elsewhere.png" },
        { "kind": "image", "storagePath": other_conversation, "fileName": "aside.png" },
    ]);

    let storage = MockServer::start_async().await;
    let sign = storage
        .mock_async(|when, then| {
            when.method(POST)
                .path("/storage/v1/object/sign/chat-attachments")
                .header("apikey", SERVICE_ROLE_KEY)
                .json_body(json!({ "expiresIn": 600, "paths": [own.clone()] }));
            then.status(200).json_body(json!([{
                "error": null,
                "path": own,
                "signedURL": format!("/object/sign/chat-attachments/{own}?token=signed"),
            }]));
        })
        .await;

    let state = build_test_state(
        pool.clone(),
        hosted_lease_config("chat-attachment-lease", storage.base_url()),
    );

    let fixture = SharedDbFixture {
        organizations: vec![space.org_id],
        projects: vec![space.project_id],
    };
    let body_pool = pool.clone();
    let result = with_shared_db_fixture(fixture, async {
        let pool = body_pool;
        seed_space(&pool, &space, attachments.clone()).await?;
        let job_payload = json!({
            "user_id": space.owner_user_id,
            "prompt_text": "what is in this picture?",
            "metadata": { "attachments": attachments },
            // Only the lease route writes this key; a row's own is dropped.
            "attachment_downloads": [
                { "name": "6a000000-0000-4000-8000-000000000009.png",
                  "url": "http://169.254.169.254/latest/meta-data" }
            ],
        });

        // A runtime that downloads attachments gets a URL for its own
        // conversation's object, signed in one request, and nothing for the
        // other space or the other conversation.
        let downloader = add_runtime(
            &pool,
            &space,
            json!({ "agent": true, "attachmentDownloads": true }),
        )
        .await?;
        queue_job(&pool, &space, &downloader, job_payload.clone()).await?;
        let leased = lease(&state, &space, &downloader).await?;
        let payload = &leased["jobs"][0]["payload"];
        sign.assert_hits_async(1).await;
        anyhow::ensure!(
            payload["attachment_downloads"]
                == json!([{
                    "name": "6a000000-0000-4000-8000-000000000001.png",
                    "url": format!(
                        "{}/storage/v1/object/sign/chat-attachments/{own}?token=signed",
                        storage.base_url()
                    ),
                    "sizeBytes": 2048,
                }]),
            "unexpected downloads: {payload}"
        );
        // The history names the attachments without a path or URL.
        let history = payload["conversation_history"].to_string();
        anyhow::ensure!(history.contains("User attached file(s) stored with this conversation"));
        anyhow::ensure!(!history.contains("token=signed"));

        // A runtime that does not download them gets no URLs at all, not even
        // the ones its job row carried.
        let older = add_runtime(&pool, &space, json!({ "agent": true })).await?;
        queue_job(&pool, &space, &older, job_payload).await?;
        let leased = lease(&state, &space, &older).await?;
        let payload = &leased["jobs"][0]["payload"];
        anyhow::ensure!(
            payload.get("attachment_downloads").is_none(),
            "a runtime without attachmentDownloads received downloads: {payload}"
        );
        sign.assert_hits_async(1).await;
        Ok(())
    })
    .await;
    let user_cleanup = pool
        .get()
        .await?
        .execute(
            "delete from auth.users where id = $1",
            &[&space.owner_user_id],
        )
        .await;
    result.and(user_cleanup.map(|_| ()).map_err(anyhow::Error::from))
}

/// Storage that is slow to sign must not hold a database connection: on a pool
/// of one, the lease route has to give its slot back before it asks Storage,
/// or every other request waits behind the signing.
#[tokio::test]
async fn lease_returns_its_pool_slot_before_storage_signs() -> anyhow::Result<()> {
    let pool = require_origin_test_pool_with_max_size(
        "lease_returns_its_pool_slot_before_storage_signs",
        1,
    )
    .await?;
    let space = Space {
        org_id: Uuid::new_v4(),
        project_id: Uuid::new_v4(),
        owner_user_id: Uuid::new_v4(),
        conversation_id: Uuid::new_v4(),
    };
    let own = format!(
        "{}/{}/6a000000-0000-4000-8000-000000000001.png",
        space.project_id, space.conversation_id
    );
    let attachments = json!([
        { "kind": "image", "storagePath": own, "fileName": "photo.png",
          "mimeType": "image/png", "sizeBytes": 2048 },
    ]);

    // Storage that answers a sign request only when the test lets it.
    #[derive(Clone)]
    struct SlowSigner {
        reached: Arc<tokio::sync::Notify>,
        respond: Arc<tokio::sync::Notify>,
    }
    async fn sign(
        axum::extract::State(signer): axum::extract::State<SlowSigner>,
        axum::Json(body): axum::Json<JsonValue>,
    ) -> axum::Json<JsonValue> {
        signer.reached.notify_one();
        signer.respond.notified().await;
        let path = body["paths"][0].as_str().unwrap_or_default().to_string();
        axum::Json(json!([{
            "error": null,
            "path": path,
            "signedURL": format!("/object/sign/chat-attachments/{path}?token=signed"),
        }]))
    }
    let signer = SlowSigner {
        reached: Arc::new(tokio::sync::Notify::new()),
        respond: Arc::new(tokio::sync::Notify::new()),
    };
    let storage_app = axum::Router::new()
        .route(
            "/storage/v1/object/sign/chat-attachments",
            axum::routing::post(sign),
        )
        .with_state(signer.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let storage_url = format!("http://{}", listener.local_addr()?);
    let _storage_server = spawn_aborting(async move {
        axum::serve(listener, storage_app)
            .await
            .expect("serve slow Storage");
    });

    let state = build_test_state(
        pool.clone(),
        hosted_lease_config("chat-attachment-lease-pool", storage_url.clone()),
    );
    let fixture = SharedDbFixture {
        organizations: vec![space.org_id],
        projects: vec![space.project_id],
    };
    let body_pool = pool.clone();
    let result = with_shared_db_fixture(fixture, async {
        let pool = body_pool;
        seed_space(&pool, &space, attachments.clone()).await?;
        let runtime_id = add_runtime(
            &pool,
            &space,
            json!({ "agent": true, "attachmentDownloads": true }),
        )
        .await?;
        queue_job(
            &pool,
            &space,
            &runtime_id,
            json!({
                "user_id": space.owner_user_id,
                "prompt_text": "what is in this picture?",
                "metadata": { "attachments": attachments },
            }),
        )
        .await?;

        let leasing = spawn_aborting({
            let state = state.clone();
            async move { lease(&state, &space, &runtime_id).await }
        });
        tokio::time::timeout(Duration::from_secs(10), signer.reached.notified())
            .await
            .expect("the lease never asked Storage to sign");

        let probe = tokio::time::timeout(Duration::from_secs(2), pool.get())
            .await
            .expect("the lease kept its pool connection checked out while Storage signed")?;
        probe.query_one("select 1", &[]).await?;
        drop(probe);

        signer.respond.notify_one();
        let leased = tokio::time::timeout(Duration::from_secs(10), leasing)
            .await
            .expect("the lease did not finish after Storage signed")??;
        let payload = &leased["jobs"][0]["payload"];
        anyhow::ensure!(
            payload["attachment_downloads"]
                == json!([{
                    "name": "6a000000-0000-4000-8000-000000000001.png",
                    "url": format!(
                        "{storage_url}/storage/v1/object/sign/chat-attachments/{own}?token=signed"
                    ),
                    "sizeBytes": 2048,
                }]),
            "unexpected downloads: {payload}"
        );
        Ok(())
    })
    .await;
    let user_cleanup = pool
        .get()
        .await?
        .execute(
            "delete from auth.users where id = $1",
            &[&space.owner_user_id],
        )
        .await;
    result.and(user_cleanup.map(|_| ()).map_err(anyhow::Error::from))
}

#[tokio::test]
async fn delete_project_purges_the_space_prefix_after_the_delete_commits() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("delete_project_purges_the_space_prefix").await?;
    let space = Space {
        org_id: Uuid::new_v4(),
        project_id: Uuid::new_v4(),
        owner_user_id: Uuid::new_v4(),
        conversation_id: Uuid::new_v4(),
    };
    let second_conversation = Uuid::new_v4();
    let object = |conversation_id: &Uuid, n: u32| {
        format!(
            "{}/{conversation_id}/6a000000-0000-4000-8000-{n:012}.png",
            space.project_id
        )
    };
    let other_space = format!(
        "{}/{}/6a000000-0000-4000-8000-000000000009.png",
        Uuid::new_v4(),
        space.conversation_id
    );
    let bucket = FakeBucket::new(
        SERVICE_ROLE_KEY,
        vec![
            object(&space.conversation_id, 1),
            other_space.clone(),
            object(&space.conversation_id, 2),
            object(&second_conversation, 4),
            object(&space.conversation_id, 3),
        ],
    );
    let (storage_url, storage_server) = bucket.serve().await;

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "chat-attachment-purge",
    );
    config._supabase_project_url = storage_url;
    config.supabase_service_role_key = Some(SERVICE_ROLE_KEY.to_string());
    let state = build_test_state(pool.clone(), config);

    let fixture = SharedDbFixture {
        organizations: vec![space.org_id],
        projects: vec![space.project_id],
    };
    let body_pool = pool.clone();
    let result = with_shared_db_fixture(fixture, async {
        let pool = body_pool;
        seed_space(&pool, &space, json!([])).await?;
        let response = crate::projects::router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/projects/{}", space.project_id))
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {SERVICE_ROLE_KEY}"),
                    )
                    .body(Body::empty())?,
            )
            .await?;
        anyhow::ensure!(
            response.status() == StatusCode::NO_CONTENT,
            "delete returned {}",
            response.status()
        );
        let status: String = pool
            .get()
            .await?
            .query_one(
                "select status from projects where id = $1",
                &[&space.project_id],
            )
            .await?
            .get(0);
        anyhow::ensure!(status == "deleted", "the space is {status}");

        // The purge runs in the background after the response.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while bucket.objects() != vec![other_space.clone()] {
            anyhow::ensure!(
                std::time::Instant::now() < deadline,
                "the space's attachments were not purged: {:?}",
                bucket.objects()
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        // The space's list shows both conversations as folders, and each is
        // emptied a page of two at a time.
        let space_prefix = format!("{}/", space.project_id);
        let folder = |conversation_id: &Uuid| format!("{space_prefix}{conversation_id}/");
        let expected = vec![
            space_prefix.clone(),
            folder(&space.conversation_id),
            folder(&space.conversation_id),
            folder(&space.conversation_id),
            folder(&second_conversation),
            folder(&second_conversation),
            space_prefix.clone(),
        ];
        anyhow::ensure!(
            bucket.listed_prefixes() == expected,
            "listed prefixes: {:?}",
            bucket.listed_prefixes()
        );
        anyhow::ensure!(bucket.deletes() == 3, "deletes: {}", bucket.deletes());
        Ok(())
    })
    .await;
    storage_server.abort();
    let user_cleanup = pool
        .get()
        .await?
        .execute(
            "delete from auth.users where id = $1",
            &[&space.owner_user_id],
        )
        .await;
    result.and(user_cleanup.map(|_| ()).map_err(anyhow::Error::from))
}

/// Deleting a team removes its spaces through the projects foreign key, so the
/// route collects them first and purges each prefix once the delete commits.
#[tokio::test]
async fn delete_organization_purges_every_space_prefix_after_the_delete_commits(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("delete_organization_purges_every_space_prefix").await?;
    let space = Space {
        org_id: Uuid::new_v4(),
        project_id: Uuid::new_v4(),
        owner_user_id: Uuid::new_v4(),
        conversation_id: Uuid::new_v4(),
    };
    let second_project_id = Uuid::new_v4();
    let object = |project_id: &Uuid, n: u32| {
        format!(
            "{project_id}/{}/6a000000-0000-4000-8000-{n:012}.png",
            space.conversation_id
        )
    };
    let other_space = object(&Uuid::new_v4(), 9);
    let bucket = FakeBucket::new(
        SERVICE_ROLE_KEY,
        vec![
            object(&space.project_id, 1),
            other_space.clone(),
            object(&second_project_id, 2),
            object(&space.project_id, 3),
            object(&second_project_id, 4),
        ],
    );
    let (storage_url, storage_server) = bucket.serve().await;

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "chat-attachment-org-purge",
    );
    config._supabase_project_url = storage_url;
    config.supabase_service_role_key = Some(SERVICE_ROLE_KEY.to_string());
    let state = build_test_state(pool.clone(), config);

    let fixture = SharedDbFixture {
        organizations: vec![space.org_id],
        projects: vec![space.project_id, second_project_id],
    };
    let body_pool = pool.clone();
    let result = with_shared_db_fixture(fixture, async {
        let pool = body_pool;
        seed_space(&pool, &space, json!([])).await?;
        pool.get()
            .await?
            .execute(
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, 'chat attachments two', $3, 'customer', 'active')",
                &[&second_project_id, &space.org_id, &space.owner_user_id],
            )
            .await?;
        let response = crate::projects::router()
            .with_state(state.clone())
            .oneshot(
                Request::builder()
                    .method("DELETE")
                    .uri(format!("/orgs/{}", space.org_id))
                    .header(
                        axum::http::header::AUTHORIZATION,
                        format!("Bearer {SERVICE_ROLE_KEY}"),
                    )
                    .body(Body::empty())?,
            )
            .await?;
        anyhow::ensure!(
            response.status() == StatusCode::NO_CONTENT,
            "delete returned {}",
            response.status()
        );
        let remaining: i64 = pool
            .get()
            .await?
            .query_one(
                "select count(*) from projects where id = any($1)",
                &[&vec![space.project_id, second_project_id]],
            )
            .await?
            .get(0);
        anyhow::ensure!(remaining == 0, "{remaining} spaces outlived their team");

        // The purge runs in the background after the response.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while bucket.objects() != vec![other_space.clone()] {
            anyhow::ensure!(
                std::time::Instant::now() < deadline,
                "the team's attachments were not purged: {:?}",
                bucket.objects()
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let mut listed = bucket.listed_prefixes();
        listed.sort();
        listed.dedup();
        let mut expected = vec![
            format!("{}/", space.project_id),
            format!("{}/{}/", space.project_id, space.conversation_id),
            format!("{second_project_id}/"),
            format!("{second_project_id}/{}/", space.conversation_id),
        ];
        expected.sort();
        anyhow::ensure!(listed == expected, "listed prefixes: {listed:?}");
        anyhow::ensure!(bucket.deletes() == 2, "deletes: {}", bucket.deletes());
        Ok(())
    })
    .await;
    storage_server.abort();
    let user_cleanup = pool
        .get()
        .await?
        .execute(
            "delete from auth.users where id = $1",
            &[&space.owner_user_id],
        )
        .await;
    result.and(user_cleanup.map(|_| ()).map_err(anyhow::Error::from))
}
