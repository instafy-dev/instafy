//! The legacy chat image export route on the migrated database: only the
//! controller's own credential may call it; it stores the image once per
//! conversation whose messages name it, in that conversation's folder, records
//! the object in every such entry (both metadata shapes) while keeping the
//! `workspacePath`, leaves other spaces and other names alone, changes nothing
//! when called again, answers `unreferenced` for a name no message holds, and
//! refuses a non-image or a server without Storage.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use httpmock::Method::{GET, POST};
use httpmock::MockServer;
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::chat_attachments;
use crate::config::{AppConfig, PgPool};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::AppState;

const SERVICE_ROLE_KEY: &str = "legacy-export-test-key";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDRlegacy";

fn export_config(storage_url: Option<String>) -> AppConfig {
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "legacy-export",
    );
    config.strict_mode = false;
    match storage_url {
        Some(url) => {
            config._supabase_project_url = url;
            config.supabase_service_role_key = Some(SERVICE_ROLE_KEY.to_string());
        }
        None => config.supabase_service_role_key = None,
    }
    config
}

async fn export(
    state: &AppState,
    project_id: &Uuid,
    workspace_path: &str,
    bearer: Option<&str>,
    body: &'static [u8],
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let mut request = Request::builder().method("POST").uri(format!(
        "/internal/projects/{project_id}/chat-attachments/legacy?workspacePath={}",
        workspace_path.replace(' ', "%20")
    ));
    if let Some(bearer) = bearer {
        request = request.header(
            axum::http::header::AUTHORIZATION,
            format!("Bearer {bearer}"),
        );
    }
    let response = chat_attachments::router()
        .with_state(state.clone())
        .oneshot(
            request
                .header(axum::http::header::CONTENT_TYPE, "application/octet-stream")
                .body(Body::from(body))?,
        )
        .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    let body = serde_json::from_slice(&bytes).unwrap_or(JsonValue::Null);
    Ok((status, body))
}

async fn insert_message(
    pool: &PgPool,
    project_id: &Uuid,
    conversation_id: &Uuid,
    user_id: &Uuid,
    metadata: JsonValue,
) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "insert into conversation_messages
             (id, conversation_id, project_id, role, content, created_by, metadata)
             values ($1, $2, $3, 'user', 'look at this', $4, $5)",
            &[&id, conversation_id, project_id, user_id, &PgJson(metadata)],
        )
        .await?;
    Ok(id)
}

async fn metadata_of(pool: &PgPool, message_id: &Uuid) -> anyhow::Result<JsonValue> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select metadata from conversation_messages where id = $1",
            &[message_id],
        )
        .await?;
    Ok(row.get::<_, PgJson<JsonValue>>(0).0)
}

#[tokio::test]
async fn legacy_chat_images_are_stored_once_per_conversation_and_recorded() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("legacy_chat_images_are_stored_once_per_conversation").await?;
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let other_project = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let (first, second, third, elsewhere) = (
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    );
    let path = "chat-upload-1700000000000-abc-photo.png";
    let kept = format!("{project_id}/{third}/6a000000-0000-4000-8000-000000000001.png");

    let storage = MockServer::start_async().await;
    let bucket = storage
        .mock_async(|when, then| {
            when.method(GET)
                .path("/storage/v1/bucket/chat-attachments")
                .header("apikey", SERVICE_ROLE_KEY);
            then.status(200)
                .json_body(json!({ "id": "chat-attachments" }));
        })
        .await;
    let first_upload = storage
        .mock_async(|when, then| {
            when.method(POST)
                .path_contains(format!(
                    "/storage/v1/object/chat-attachments/{project_id}/{first}/"
                ))
                .header("apikey", SERVICE_ROLE_KEY)
                .header("content-type", "image/png")
                .header("x-upsert", "false");
            then.status(200).json_body(json!({ "Key": "x" }));
        })
        .await;
    let second_upload = storage
        .mock_async(|when, then| {
            when.method(POST).path_contains(format!(
                "/storage/v1/object/chat-attachments/{project_id}/{second}/"
            ));
            then.status(200).json_body(json!({ "Key": "x" }));
        })
        .await;
    // Any other upload finds no mock (404), so the route answers 502 and the
    // test fails.

    let state = build_test_state(pool.clone(), export_config(Some(storage.base_url())));
    let fixture = SharedDbFixture {
        organizations: vec![org_id],
        projects: vec![project_id, other_project],
    };
    let body_pool = pool.clone();
    let result = with_shared_db_fixture(fixture, async {
        let pool = body_pool;
        ensure_test_user(&pool, &owner).await?;
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, 'legacy export')",
                &[&org_id, &format!("legacy-export-{org_id}")],
            )
            .await?;
        for project in [project_id, other_project] {
            connection
                .execute(
                    "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                     values ($1, $2, 'legacy export', $3, 'customer', 'active')",
                    &[&project, &org_id, &owner],
                )
                .await?;
        }
        for (conversation, project) in [
            (first, project_id),
            (second, project_id),
            (third, project_id),
            (elsewhere, other_project),
        ] {
            connection
                .execute(
                    "insert into conversations (id, project_id, created_by, visibility)
                     values ($1, $2, $3, 'private')",
                    &[&conversation, &project, &owner],
                )
                .await?;
        }
        drop(connection);

        let a = insert_message(
            &pool,
            &project_id,
            &first,
            &owner,
            json!({ "attachments": [
                { "kind": "image", "workspacePath": path, "fileName": "photo.png",
                  "mimeType": "image/png" },
            ] }),
        )
        .await?;
        let b = insert_message(
            &pool,
            &project_id,
            &first,
            &owner,
            json!({ "prompt_metadata": { "attachments": [
                { "kind": "image", "workspace_path": path },
            ] } }),
        )
        .await?;
        let c = insert_message(
            &pool,
            &project_id,
            &second,
            &owner,
            json!({ "promptMetadata": [
                { "kind": "image", "workspacePath": path },
                { "kind": "image", "workspacePath": "chat-upload-other.png" },
            ] }),
        )
        .await?;
        let d = insert_message(
            &pool,
            &project_id,
            &third,
            &owner,
            json!({ "attachments": [
                { "kind": "image", "workspacePath": path, "storagePath": kept },
            ] }),
        )
        .await?;
        let foreign = json!({ "attachments": [{ "kind": "image", "workspacePath": path }] });
        let e = insert_message(&pool, &other_project, &elsewhere, &owner, foreign.clone()).await?;

        // Only the controller's own credential.
        for bearer in [None, Some("not-a-token")] {
            let (status, _) = export(&state, &project_id, path, bearer, PNG).await?;
            anyhow::ensure!(
                matches!(status, StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED),
                "{bearer:?} got {status}"
            );
        }
        // Not an image, not a chat upload name.
        let (status, body) = export(&state, &project_id, path, Some("internal"), b"<svg/>").await?;
        anyhow::ensure!(
            status == StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "{status} {body}"
        );
        anyhow::ensure!(body["code"] == "unsupported_image", "{body}");
        let (status, body) =
            export(&state, &project_id, "photo.png", Some("internal"), PNG).await?;
        anyhow::ensure!(status == StatusCode::BAD_REQUEST, "{status} {body}");
        anyhow::ensure!(body["code"] == "invalid_workspace_path", "{body}");

        let (status, body) = export(&state, &project_id, path, Some("internal"), PNG).await?;
        anyhow::ensure!(status == StatusCode::OK, "{status} {body}");
        anyhow::ensure!(body["unreferenced"] == false, "{body}");
        first_upload.assert_hits_async(1).await;
        second_upload.assert_hits_async(1).await;
        bucket.assert_hits_async(1).await;

        let exported = body["exported"].as_array().cloned().unwrap_or_default();
        anyhow::ensure!(exported.len() == 3, "{body}");
        let by_conversation = |conversation: &Uuid| {
            exported
                .iter()
                .find(|entry| entry["conversationId"] == conversation.to_string())
                .cloned()
                .unwrap_or(JsonValue::Null)
        };
        let first_entry = by_conversation(&first);
        let first_path = first_entry["storagePath"].as_str().unwrap_or_default();
        anyhow::ensure!(
            first_path.starts_with(&format!("{project_id}/{first}/"))
                && first_path.ends_with(".png")
                && first_entry["messages"] == 2,
            "{first_entry}"
        );
        let second_entry = by_conversation(&second);
        let second_path = second_entry["storagePath"].as_str().unwrap_or_default();
        anyhow::ensure!(
            second_path.starts_with(&format!("{project_id}/{second}/"))
                && second_entry["messages"] == 1,
            "{second_entry}"
        );
        anyhow::ensure!(
            by_conversation(&third)
                == json!({
                    "conversationId": third, "storagePath": kept, "messages": 0
                }),
            "{body}"
        );

        let size = PNG.len();
        anyhow::ensure!(
            metadata_of(&pool, &a).await?
                == json!({ "attachments": [
                    { "kind": "image", "workspacePath": path, "fileName": "photo.png",
                      "mimeType": "image/png", "storagePath": first_path, "sizeBytes": size },
                ] }),
            "message a"
        );
        anyhow::ensure!(
            metadata_of(&pool, &b).await?
                == json!({ "prompt_metadata": { "attachments": [
                    { "kind": "image", "workspace_path": path, "storagePath": first_path,
                      "mimeType": "image/png", "sizeBytes": size },
                ] } }),
            "message b"
        );
        anyhow::ensure!(
            metadata_of(&pool, &c).await?
                == json!({ "promptMetadata": [
                    { "kind": "image", "workspacePath": path, "storagePath": second_path,
                      "mimeType": "image/png", "sizeBytes": size },
                    { "kind": "image", "workspacePath": "chat-upload-other.png" },
                ] }),
            "message c"
        );
        anyhow::ensure!(
            metadata_of(&pool, &d).await?
                == json!({ "attachments": [
                    { "kind": "image", "workspacePath": path, "storagePath": kept },
                ] }),
            "message d"
        );
        anyhow::ensure!(metadata_of(&pool, &e).await? == foreign, "another space");

        // Again: nothing to store or change.
        let (status, again) = export(&state, &project_id, path, Some("internal"), PNG).await?;
        anyhow::ensure!(status == StatusCode::OK, "{status} {again}");
        first_upload.assert_hits_async(1).await;
        second_upload.assert_hits_async(1).await;
        anyhow::ensure!(
            again["exported"]
                .as_array()
                .is_some_and(|entries| entries.len() == 3
                    && entries.iter().all(|entry| entry["messages"] == 0)),
            "{again}"
        );

        // A name no message holds.
        let (status, unreferenced) = export(
            &state,
            &project_id,
            "chat-upload-nobody.png",
            Some("internal"),
            PNG,
        )
        .await?;
        anyhow::ensure!(status == StatusCode::OK, "{status} {unreferenced}");
        anyhow::ensure!(
            unreferenced == json!({ "exported": [], "unreferenced": true }),
            "{unreferenced}"
        );

        // A deleted space exports nothing.
        pool.get()
            .await?
            .execute(
                "update projects set status = 'deleted' where id = $1",
                &[&other_project],
            )
            .await?;
        let (status, body) = export(&state, &other_project, path, Some("internal"), PNG).await?;
        anyhow::ensure!(status == StatusCode::NOT_FOUND, "{status} {body}");
        anyhow::ensure!(body["code"] == "project_not_found", "{body}");
        anyhow::ensure!(metadata_of(&pool, &e).await? == foreign, "deleted space");

        // Without Storage the salvage keeps the file itself.
        let without = build_test_state(pool.clone(), export_config(None));
        let (status, body) = export(&without, &project_id, path, Some("internal"), PNG).await?;
        anyhow::ensure!(status == StatusCode::CONFLICT, "{status} {body}");
        anyhow::ensure!(body["code"] == "attachments_unavailable", "{body}");
        Ok(())
    })
    .await;
    let user_cleanup = pool
        .get()
        .await?
        .execute("delete from auth.users where id = $1", &[&owner])
        .await;
    result.and(user_cleanup.map(|_| ()).map_err(anyhow::Error::from))
}
