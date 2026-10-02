//! The agent lease route's chat attachment downloads, on the migrated
//! database: which runtimes receive signed URLs, for which objects, and that
//! a job row cannot supply URLs of its own.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use httpmock::Method::POST;
use httpmock::MockServer;
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::{PgPool, RuntimeProviderConfig};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::{agent, AppState};

const HOSTED_PROVIDER: &str = "instafy-cloud";
const SERVICE_ROLE_KEY: &str = "chat-attachment-lease-test-key";

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
async fn lease_signs_own_space_attachments_only_for_runtimes_that_download_them(
) -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("lease_signs_own_space_attachments_only_for_runtimes").await?;
    let space = Space {
        org_id: Uuid::new_v4(),
        project_id: Uuid::new_v4(),
        owner_user_id: Uuid::new_v4(),
        conversation_id: Uuid::new_v4(),
    };
    let own = format!(
        "{}/6a000000-0000-4000-8000-000000000001.png",
        space.project_id
    );
    let foreign = format!(
        "{}/6a000000-0000-4000-8000-000000000002.png",
        Uuid::new_v4()
    );
    let attachments = json!([
        { "kind": "image", "storagePath": own, "fileName": "photo.png",
          "mimeType": "image/png", "sizeBytes": 2048 },
        { "kind": "image", "storagePath": foreign, "fileName": "elsewhere.png" },
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

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "chat-attachment-lease",
    );
    config.strict_mode = false;
    config._supabase_project_url = storage.base_url();
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
    let state = build_test_state(pool.clone(), config);

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

        // A runtime that downloads attachments gets a URL for its own space's
        // object, signed in one request, and nothing for the other space.
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
