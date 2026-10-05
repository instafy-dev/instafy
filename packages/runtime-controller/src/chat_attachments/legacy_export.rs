//! Chat images that only a retired file gateway still held.
//!
//! Before chat attachments moved to Storage, the web app wrote each image into
//! the space's root as `chat-upload-*` and recorded that `workspacePath` in the
//! message. On a hosted space the only copy could sit in the stateful
//! gateway's working copy, which the stateless gateway no longer reads. Its
//! salvage subcommand sends each such image here once:
//!
//! `POST /internal/projects/:project_id/chat-attachments/legacy?workspacePath=<name>`
//! with the file's bytes as the body, authenticated with the controller's
//! internal token or the service-role key itself (never a scoped token).
//!
//! For every conversation of the space with a message that names the file, the
//! image is stored once under `<projectId>/<conversationId>/<uuid>.<ext>` with
//! the service role, and each such attachment entry gains `storagePath`,
//! `mimeType` and `sizeBytes` next to the `workspacePath` it keeps. Entries
//! that already name a Storage object are left as they are, so a second call
//! changes nothing. A file no message names is answered `unreferenced: true`
//! and stored nowhere; the salvage keeps it in its private archive.

use std::collections::BTreeMap;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tracing::info;
use uuid::Uuid;

use super::{attachments_mode, object_file_name, AttachmentsMode, StorageAccess, BUCKET};
use crate::auth::authenticate_request;
use crate::config::PgPool;
use crate::{internal_error, ApiError, AppState};

/// The bucket's own limit for one object.
pub(crate) const MAX_LEGACY_IMAGE_BYTES: usize = 20 * 1024 * 1024;
/// The prefix the web app gave every chat image it wrote into a space.
const LEGACY_PREFIX: &str = "chat-upload-";
const MAX_WORKSPACE_PATH_CHARS: usize = 255;
/// An upload of up to 20 MiB needs longer than the other Storage calls.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(120);

pub(crate) fn router() -> Router<AppState> {
    Router::new().route(
        "/internal/projects/:project_id/chat-attachments/legacy",
        post(export_legacy_image).layer(DefaultBodyLimit::max(MAX_LEGACY_IMAGE_BYTES)),
    )
}

#[derive(Debug, Deserialize)]
struct ExportQuery {
    #[serde(rename = "workspacePath", default)]
    workspace_path: Option<String>,
}

/// One conversation whose messages now name the image in Storage.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportedImage {
    pub(crate) conversation_id: Uuid,
    pub(crate) storage_path: String,
    /// Messages this call updated (0 when every entry already named it).
    pub(crate) messages: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LegacyExportResponse {
    pub(crate) exported: Vec<ExportedImage>,
    /// No message of the space names this file.
    pub(crate) unreferenced: bool,
}

fn refused(status: StatusCode, code: &str, message: &str) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError {
            message: message.to_string(),
            code: Some(code.to_string()),
            details: None,
        }),
    )
}

async fn export_legacy_image(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    Query(query): Query<ExportQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<LegacyExportResponse>, (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, &headers).await?;
    if !crate::origins::has_direct_service_authentication(&state.config, &headers, &context) {
        return Err(refused(
            StatusCode::FORBIDDEN,
            "service_authentication_required",
            "exporting a legacy chat image requires the controller's own credential",
        ));
    }
    let project_id = Uuid::parse_str(project_id.trim())
        .ok()
        .filter(|id| id.as_hyphenated().to_string() == project_id.trim())
        .ok_or_else(|| {
            refused(
                StatusCode::BAD_REQUEST,
                "invalid_project",
                "projectId must be a lower-case uuid",
            )
        })?;
    let workspace_path = query
        .workspace_path
        .as_deref()
        .and_then(legacy_workspace_path)
        .ok_or_else(|| {
            refused(
                StatusCode::BAD_REQUEST,
                "invalid_workspace_path",
                "workspacePath must name a chat-upload file in the space's root",
            )
        })?
        .to_string();
    if body.is_empty() {
        return Err(refused(
            StatusCode::BAD_REQUEST,
            "empty_file",
            "the request body must hold the image",
        ));
    }
    if body.len() > MAX_LEGACY_IMAGE_BYTES {
        return Err(refused(
            StatusCode::PAYLOAD_TOO_LARGE,
            "too_large",
            "the image is larger than 20 MiB",
        ));
    }
    let Some((mime_type, extension)) = sniff_image(&body) else {
        return Err(refused(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "unsupported_image",
            "only PNG, JPEG, WebP and GIF images can be stored",
        ));
    };

    let access = StorageAccess::from_config(&state.http_client, &state.config);
    let access = match access {
        Some(access) if attachments_mode(Some(&access)).await == AttachmentsMode::Storage => access,
        _ => {
            return Err(refused(
                StatusCode::CONFLICT,
                "attachments_unavailable",
                "this server can't store attachments",
            ))
        }
    };

    if !project_is_live(&state.pool, &project_id).await? {
        return Err(refused(
            StatusCode::NOT_FOUND,
            "project_not_found",
            "the space does not exist or was deleted",
        ));
    }

    let rows = load_referencing_messages(&state.pool, &project_id, &workspace_path).await?;
    let plans = plan_conversations(&rows, &project_id, &workspace_path);
    let unreferenced = plans.is_empty();
    let mut exported = Vec::with_capacity(plans.len());
    for (conversation_id, plan) in plans {
        if plan.missing.is_empty() {
            exported.push(ExportedImage {
                conversation_id,
                storage_path: plan.existing.or(plan.elsewhere).unwrap_or_default(),
                messages: 0,
            });
            continue;
        }
        let storage_path = match plan.existing {
            Some(existing) => existing,
            None => {
                let name = format!(
                    "{project_id}/{conversation_id}/{}.{extension}",
                    Uuid::new_v4()
                );
                upload_object(&access, &name, mime_type, body.clone())
                    .await
                    .map_err(|error| {
                        tracing::warn!(%project_id, %conversation_id, %error, "legacy chat image upload failed");
                        refused(
                            StatusCode::BAD_GATEWAY,
                            "storage_upload_failed",
                            "Storage did not take the image",
                        )
                    })?;
                name
            }
        };
        let messages = record_storage_path(
            &state.pool,
            &project_id,
            &plan.missing,
            &workspace_path,
            &StoredImage {
                storage_path: &storage_path,
                mime_type,
                size_bytes: body.len() as u64,
            },
        )
        .await?;
        exported.push(ExportedImage {
            conversation_id,
            storage_path,
            messages,
        });
    }
    info!(
        %project_id,
        conversations = exported.len(),
        messages = exported.iter().map(|image| image.messages).sum::<usize>(),
        unreferenced,
        "exported a legacy chat image"
    );
    Ok(Json(LegacyExportResponse {
        exported,
        unreferenced,
    }))
}

/// `raw` when it names a chat image the web app wrote into a space's root:
/// `chat-upload-*` (any letter case), one path segment, printable, at most
/// 255 characters, and nothing JSON would escape.
pub(crate) fn legacy_workspace_path(raw: &str) -> Option<&str> {
    let path = raw.trim();
    let named = path
        .get(..LEGACY_PREFIX.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(LEGACY_PREFIX))
        && path.len() > LEGACY_PREFIX.len();
    (named
        && path.chars().count() <= MAX_WORKSPACE_PATH_CHARS
        && !path.contains(['/', '\\', '"'])
        && !path.chars().any(char::is_control))
    .then_some(path)
}

/// The content type and Storage extension of an image the bucket takes,
/// read from the bytes themselves.
pub(crate) fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "gif"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else {
        None
    }
}

/// Calls `visit` for each image entry of a message's metadata that names
/// `workspace_path`, in every place the web app recorded attachments:
/// `attachments`, and `prompt_metadata` / `promptMetadata` as a list or as an
/// object with `attachments`.
pub(crate) fn for_each_legacy_entry(
    metadata: &mut JsonValue,
    workspace_path: &str,
    mut visit: impl FnMut(&mut JsonMap<String, JsonValue>),
) {
    let Some(metadata) = metadata.as_object_mut() else {
        return;
    };
    for key in ["attachments", "prompt_metadata", "promptMetadata"] {
        let entries = match metadata.get_mut(key) {
            Some(JsonValue::Array(entries)) => Some(entries),
            Some(JsonValue::Object(map)) => {
                map.get_mut("attachments").and_then(JsonValue::as_array_mut)
            }
            _ => None,
        };
        for entry in entries.into_iter().flatten() {
            let Some(entry) = entry.as_object_mut() else {
                continue;
            };
            if names_legacy_image(entry, workspace_path) {
                visit(entry);
            }
        }
    }
}

fn names_legacy_image(entry: &JsonMap<String, JsonValue>, workspace_path: &str) -> bool {
    let is_image = entry
        .get("kind")
        .and_then(JsonValue::as_str)
        .is_some_and(|kind| kind.trim().eq_ignore_ascii_case("image"));
    is_image && text_field(entry, &["workspacePath", "workspace_path"]) == Some(workspace_path)
}

fn text_field<'a>(entry: &'a JsonMap<String, JsonValue>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .filter_map(|key| entry.get(*key).and_then(JsonValue::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
}

/// A message whose metadata may name the image.
pub(crate) struct ReferencingMessage {
    pub(crate) message_id: Uuid,
    pub(crate) conversation_id: Uuid,
    pub(crate) metadata: JsonValue,
}

/// What one conversation needs.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct ConversationPlan {
    /// A Storage object an entry already names in this conversation's folder.
    pub(crate) existing: Option<String>,
    /// A Storage object an entry names elsewhere (reported, never reused).
    pub(crate) elsewhere: Option<String>,
    /// Messages with an entry that names no Storage object yet.
    pub(crate) missing: Vec<Uuid>,
}

/// Group the messages that name the image by conversation.
pub(crate) fn plan_conversations(
    rows: &[ReferencingMessage],
    project_id: &Uuid,
    workspace_path: &str,
) -> BTreeMap<Uuid, ConversationPlan> {
    let mut plans: BTreeMap<Uuid, ConversationPlan> = BTreeMap::new();
    for row in rows {
        let mut metadata = row.metadata.clone();
        let mut named = false;
        let mut lacking = false;
        let mut stored = Vec::new();
        for_each_legacy_entry(&mut metadata, workspace_path, |entry| {
            named = true;
            match text_field(entry, &["storagePath", "storage_path"]) {
                Some(path) => stored.push(path.to_string()),
                None => lacking = true,
            }
        });
        if !named {
            continue;
        }
        let plan = plans.entry(row.conversation_id).or_default();
        for path in stored {
            if object_file_name(&path, project_id, Some(&row.conversation_id)).is_some() {
                plan.existing.get_or_insert(path);
            } else {
                plan.elsewhere.get_or_insert(path);
            }
        }
        if lacking && !plan.missing.contains(&row.message_id) {
            plan.missing.push(row.message_id);
        }
    }
    plans
}

async fn project_is_live(
    pool: &PgPool,
    project_id: &Uuid,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let row = connection
        .query_opt(
            "select 1 from projects where id = $1 and status <> 'deleted'",
            &[project_id],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load project: {error}")))?;
    Ok(row.is_some())
}

/// Messages of the space whose metadata holds the name as a JSON string
/// anywhere; [`plan_conversations`] then keeps only real attachment entries.
async fn load_referencing_messages(
    pool: &PgPool,
    project_id: &Uuid,
    workspace_path: &str,
) -> Result<Vec<ReferencingMessage>, (StatusCode, Json<ApiError>)> {
    // `legacy_workspace_path` allows nothing JSON escapes, so the quoted name
    // is exactly how `jsonb::text` prints the string.
    let quoted = format!("\"{workspace_path}\"");
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let rows = connection
        .query(
            "select id, conversation_id, metadata from conversation_messages
             where project_id = $1 and metadata is not null
               and position($2::text in metadata::text) > 0
             order by created_at, id",
            &[project_id, &quoted],
        )
        .await
        .map_err(|error| internal_error(format!("failed to load messages: {error}")))?;
    Ok(rows
        .into_iter()
        .map(|row| ReferencingMessage {
            message_id: row.get(0),
            conversation_id: row.get(1),
            metadata: row.get::<_, PgJson<JsonValue>>(2).0,
        })
        .collect())
}

/// The Storage object an exported image became.
pub(crate) struct StoredImage<'a> {
    pub(crate) storage_path: &'a str,
    pub(crate) mime_type: &'a str,
    pub(crate) size_bytes: u64,
}

/// Give every entry that names the image and no Storage object yet the
/// stored object, in one transaction. Returns how many messages changed.
async fn record_storage_path(
    pool: &PgPool,
    project_id: &Uuid,
    message_ids: &[Uuid],
    workspace_path: &str,
    image: &StoredImage<'_>,
) -> Result<usize, (StatusCode, Json<ApiError>)> {
    let mut connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    let mut updated = 0;
    for message_id in message_ids {
        let row = transaction
            .query_opt(
                "select metadata from conversation_messages
                 where id = $1 and project_id = $2 for update",
                &[message_id, project_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to load message: {error}")))?;
        let Some(PgJson(mut metadata)) =
            row.and_then(|row| row.get::<_, Option<PgJson<JsonValue>>>(0))
        else {
            continue;
        };
        if !record_in_metadata(&mut metadata, workspace_path, image) {
            continue;
        }
        transaction
            .execute(
                "update conversation_messages set metadata = $1 where id = $2",
                &[&PgJson(&metadata), message_id],
            )
            .await
            .map_err(|error| internal_error(format!("failed to update message: {error}")))?;
        updated += 1;
    }
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to commit: {error}")))?;
    Ok(updated)
}

/// Add the stored object to each entry of `metadata` that names the image and
/// no Storage object yet. Returns whether anything changed.
pub(crate) fn record_in_metadata(
    metadata: &mut JsonValue,
    workspace_path: &str,
    image: &StoredImage<'_>,
) -> bool {
    let mut changed = false;
    for_each_legacy_entry(metadata, workspace_path, |entry| {
        if text_field(entry, &["storagePath", "storage_path"]).is_some() {
            return;
        }
        entry.insert(
            "storagePath".to_string(),
            JsonValue::String(image.storage_path.to_string()),
        );
        entry.insert(
            "mimeType".to_string(),
            JsonValue::String(image.mime_type.to_string()),
        );
        entry.insert("sizeBytes".to_string(), JsonValue::from(image.size_bytes));
        changed = true;
    });
    changed
}

/// Store one new object with the service role; an existing name is never
/// replaced.
pub(crate) async fn upload_object(
    access: &StorageAccess,
    name: &str,
    content_type: &str,
    body: Bytes,
) -> Result<(), String> {
    if !super::object_name_is_valid(name) {
        return Err("refusing an object name the bucket policies would not accept".to_string());
    }
    let response = access
        .request(reqwest::Method::POST, &format!("/object/{BUCKET}/{name}"))
        .timeout(UPLOAD_TIMEOUT)
        .header(reqwest::header::CONTENT_TYPE, content_type)
        .header("x-upsert", "false")
        .body(body)
        .send()
        .await
        .map_err(|error| format!("upload request failed: {}", error.without_url()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("upload request returned {status}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::Method::POST;
    use httpmock::MockServer;
    use serde_json::json;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR";

    #[test]
    fn only_root_chat_upload_names_are_accepted() {
        for good in [
            "chat-upload-1700000000000-abc-photo.png",
            "Chat-Upload-1-x.JPG",
            "  chat-upload-2-y.webp  ",
            "chat-upload-x y (1).gif",
        ] {
            assert!(legacy_workspace_path(good).is_some(), "{good}");
        }
        assert_eq!(
            legacy_workspace_path(" chat-upload-1.png "),
            Some("chat-upload-1.png")
        );
        for bad in [
            "",
            "chat-upload-",
            "photo.png",
            "images/chat-upload-1.png",
            "chat-upload-1/../x.png",
            "chat-upload-1\\x.png",
            "chat-upload-\"q\".png",
            "chat-upload-1\n.png",
            &format!("chat-upload-{}", "a".repeat(250)),
        ] {
            assert!(legacy_workspace_path(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn images_are_recognised_by_their_bytes() {
        assert_eq!(sniff_image(PNG), Some(("image/png", "png")));
        assert_eq!(
            sniff_image(&[0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
            Some(("image/jpeg", "jpg"))
        );
        assert_eq!(sniff_image(b"GIF89a....."), Some(("image/gif", "gif")));
        assert_eq!(sniff_image(b"GIF87a....."), Some(("image/gif", "gif")));
        assert_eq!(
            sniff_image(b"RIFF\x10\0\0\0WEBPVP8 "),
            Some(("image/webp", "webp"))
        );
        for other in [
            &b""[..],
            b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
            b"RIFF\x10\0\0\0WAVEfmt ",
            b"%PDF-1.7",
            b"\x89PN",
        ] {
            assert_eq!(sniff_image(other), None, "{other:?}");
        }
    }

    fn row(conversation: Uuid, metadata: JsonValue) -> ReferencingMessage {
        ReferencingMessage {
            message_id: Uuid::new_v4(),
            conversation_id: conversation,
            metadata,
        }
    }

    #[test]
    fn entries_are_found_in_every_shape_the_web_app_wrote() {
        let path = "chat-upload-1-a.png";
        let project = Uuid::new_v4();
        let (a, b, c) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let in_folder = format!("{project}/{c}/6a000000-0000-4000-8000-000000000001.png");
        let elsewhere = format!("{project}/{a}/6a000000-0000-4000-8000-000000000002.png");
        let rows = vec![
            row(
                a,
                json!({ "attachments": [{ "kind": "image", "workspacePath": path }] }),
            ),
            row(
                a,
                json!({ "prompt_metadata": { "attachments": [
                    { "kind": "Image", "workspace_path": format!(" {path} ") }
                ] } }),
            ),
            row(
                b,
                json!({ "promptMetadata": [
                    { "kind": "image", "workspacePath": path },
                    { "kind": "image", "workspacePath": "chat-upload-other.png" },
                ] }),
            ),
            // Already in its own conversation's folder, and one in another
            // conversation's folder, which is never reused.
            row(
                c,
                json!({ "attachments": [
                    { "kind": "image", "workspacePath": path, "storagePath": in_folder },
                ] }),
            ),
            row(
                c,
                json!({ "attachments": [
                    { "kind": "image", "workspacePath": path, "storagePath": elsewhere },
                ] }),
            ),
            // Not image entries, or the name only in text.
            row(
                Uuid::new_v4(),
                json!({ "attachments": [{ "kind": "file", "workspacePath": path }],
                        "note": path }),
            ),
            row(
                Uuid::new_v4(),
                json!({ "attachments": [{ "workspacePath": path }] }),
            ),
        ];
        let plans = plan_conversations(&rows, &project, path);
        assert_eq!(plans.len(), 3, "{plans:?}");
        assert_eq!(
            plans[&a].missing,
            vec![rows[0].message_id, rows[1].message_id]
        );
        assert_eq!(plans[&a].existing, None);
        assert_eq!(plans[&b].missing, vec![rows[2].message_id]);
        assert_eq!(
            plans[&c],
            ConversationPlan {
                existing: Some(in_folder),
                elsewhere: Some(elsewhere),
                missing: vec![],
            }
        );
    }

    #[test]
    fn recording_keeps_the_workspace_path_and_never_replaces_a_storage_path() {
        let path = "chat-upload-1-a.png";
        let mut metadata = json!({
            "attachments": [
                { "kind": "image", "workspacePath": path, "fileName": "a.png", "mimeType": "image/x" },
                { "kind": "image", "workspacePath": path, "storagePath": "p/c/kept.png" },
                { "kind": "image", "workspacePath": "chat-upload-other.png" },
            ],
            "prompt_metadata": { "attachments": [{ "kind": "image", "workspace_path": path }] },
        });
        let image = StoredImage {
            storage_path: "p/c/new.png",
            mime_type: "image/png",
            size_bytes: 12,
        };
        assert!(record_in_metadata(&mut metadata, path, &image));
        assert_eq!(
            metadata,
            json!({
                "attachments": [
                    { "kind": "image", "workspacePath": path, "fileName": "a.png",
                      "mimeType": "image/png", "storagePath": "p/c/new.png", "sizeBytes": 12 },
                    { "kind": "image", "workspacePath": path, "storagePath": "p/c/kept.png" },
                    { "kind": "image", "workspacePath": "chat-upload-other.png" },
                ],
                "prompt_metadata": { "attachments": [
                    { "kind": "image", "workspace_path": path, "storagePath": "p/c/new.png",
                      "mimeType": "image/png", "sizeBytes": 12 },
                ] },
            })
        );
        // A second pass finds nothing to add.
        assert!(!record_in_metadata(&mut metadata, path, &image));
    }

    #[tokio::test]
    async fn an_upload_names_one_new_object_with_the_service_role() {
        let storage = MockServer::start_async().await;
        let name = format!(
            "{}/{}/6a000000-0000-4000-8000-000000000001.png",
            Uuid::new_v4(),
            Uuid::new_v4()
        );
        let upload = storage
            .mock_async(|when, then| {
                when.method(POST)
                    .path(format!("/storage/v1/object/chat-attachments/{name}"))
                    .header("apikey", "service-key")
                    .header("authorization", "Bearer service-key")
                    .header("content-type", "image/png")
                    .header("x-upsert", "false")
                    .body(String::from_utf8_lossy(PNG).to_string());
                then.status(200).json_body(json!({ "Key": "x" }));
            })
            .await;
        let access = StorageAccess::new(reqwest::Client::new(), &storage.base_url(), "service-key");
        upload_object(&access, &name, "image/png", Bytes::from_static(PNG))
            .await
            .unwrap();
        upload.assert_hits_async(1).await;

        // A name outside the policy shape is never sent, and a refusal is an
        // error.
        assert!(
            upload_object(&access, "x/y/z.png", "image/png", Bytes::from_static(PNG))
                .await
                .is_err()
        );
        let other = format!(
            "{}/{}/6a000000-0000-4000-8000-000000000002.png",
            Uuid::new_v4(),
            Uuid::new_v4()
        );
        let refused = storage
            .mock_async(|when, then| {
                when.method(POST)
                    .path(format!("/storage/v1/object/chat-attachments/{other}"));
                then.status(409).json_body(json!({ "error": "Duplicate" }));
            })
            .await;
        let error = upload_object(&access, &other, "image/png", Bytes::from_static(PNG))
            .await
            .unwrap_err();
        assert!(error.contains("409"), "{error}");
        refused.assert_hits_async(1).await;
        upload.assert_hits_async(1).await;
    }
}
