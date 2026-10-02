//! Chat attachments: images and text files sent with a message. They live in
//! the private `chat-attachments` Supabase Storage bucket as
//! `<projectId>/<uuid>.<ext>` (supabase/migrations/20261002140000_chat_attachments.sql)
//! and never in a space's git history.
//!
//! Browsers upload and read them with the user's own session. The controller
//! holds the service role, so it signs short-lived downloads for the runtime
//! that leases a turn and purges a deleted space's prefix. A signed URL is a
//! bearer credential for one object: it goes only into the leased payload of a
//! runtime that advertises `attachmentDownloads`, and never into history text,
//! events or logs.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tracing::{info, warn};
use uuid::Uuid;

use crate::config::AppConfig;

pub(crate) const BUCKET: &str = "chat-attachments";
/// The leased payload key the runtime downloads from. Only the lease route
/// writes it; anything a job row carries under it is dropped first.
pub(crate) const DOWNLOADS_PAYLOAD_KEY: &str = "attachment_downloads";
/// The runtime capability that asks for `attachment_downloads`.
pub(crate) const RUNTIME_CAPABILITY: &str = "attachmentDownloads";
const EXTENSIONS: [&str; 6] = ["png", "jpg", "webp", "gif", "txt", "md"];
/// Long enough for a runtime to download right after the lease, short enough
/// that a URL copied out of a payload is soon useless.
const SIGNED_URL_TTL_SECONDS: u64 = 600;
/// The turns whose attachments a runtime may still be asked about.
const HISTORY_USER_MESSAGES: usize = 10;
const MAX_DOWNLOADS_PER_JOB: usize = 20;
const STORAGE_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const STORAGE_PROBE_TIMEOUT: Duration = Duration::from_secs(3);
/// How long a bucket probe's answer stands before the next page load checks
/// again in the background: long after the bucket answered, short otherwise.
const STORAGE_PRESENT_CACHE: Duration = Duration::from_secs(600);
const STORAGE_ABSENT_CACHE: Duration = Duration::from_secs(60);
/// After the bucket last answered, how long an unreachable Storage (a 5xx, a
/// 429, a timeout or a transport error) still counts as present. Longer than
/// that, it is an outage and uploads would fail anyway.
const STORAGE_OUTAGE_GRACE: Duration = Duration::from_secs(900);
const PURGE_PAGE_SIZE: usize = 1000;
const PURGE_MAX_PAGES: usize = 100;
const MAX_DESCRIBED_NAME_CHARS: usize = 120;

/// `<uuid>.<ext>`: 36 characters of lowercase hex and hyphens, then one of the
/// bucket's extensions. The object name's second segment and the runtime's
/// file name under `.instafy/attachments/`.
pub(crate) fn file_name_is_valid(name: &str) -> bool {
    let Some((stem, extension)) = name.split_once('.') else {
        return false;
    };
    is_uuid_shaped(stem) && EXTENSIONS.contains(&extension)
}

/// `^[0-9a-f-]{36}/[0-9a-f-]{36}\.(png|jpg|webp|gif|txt|md)$`, the shape the
/// Storage policies accept.
pub(crate) fn object_name_is_valid(name: &str) -> bool {
    name.split_once('/')
        .is_some_and(|(space, file)| is_uuid_shaped(space) && file_name_is_valid(file))
}

/// The file name of an object in `project_id`'s prefix, or `None` for a name
/// of another shape or space.
pub(crate) fn object_file_name<'a>(object_name: &'a str, project_id: &Uuid) -> Option<&'a str> {
    if !object_name_is_valid(object_name) {
        return None;
    }
    let (space, file) = object_name.split_once('/')?;
    (space == project_id.to_string()).then_some(file)
}

fn is_uuid_shaped(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
}

/// One Storage attachment of a message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct StoredAttachment {
    pub(crate) storage_path: String,
    pub(crate) file_name: Option<String>,
    pub(crate) mime_type: Option<String>,
    pub(crate) size_bytes: Option<u64>,
    pub(crate) is_image: bool,
}

/// The Storage attachments of one message's metadata, read from the same
/// places as the legacy `workspacePath` ones: `attachments` and the prompt
/// metadata's `attachments`. Entries are images or text files with a
/// `storagePath`; anything else is skipped.
pub(crate) fn stored_attachments(metadata: &JsonValue) -> Vec<StoredAttachment> {
    let Some(metadata) = metadata.as_object() else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut attachments = Vec::new();
    for source in ["attachments", "prompt_metadata", "promptMetadata"]
        .iter()
        .filter_map(|key| metadata.get(*key))
    {
        let entries = match source {
            JsonValue::Array(entries) => Some(entries),
            JsonValue::Object(map) => map.get("attachments").and_then(JsonValue::as_array),
            _ => None,
        };
        for entry in entries.into_iter().flatten() {
            let Some(entry) = entry.as_object() else {
                continue;
            };
            let kind = text_field(entry, &["kind"]).map(str::to_ascii_lowercase);
            let is_image = match kind.as_deref() {
                Some("image") => true,
                Some("file") => false,
                _ => continue,
            };
            let Some(storage_path) = text_field(entry, &["storagePath", "storage_path"]) else {
                continue;
            };
            if !seen.insert(storage_path.to_string()) {
                continue;
            }
            attachments.push(StoredAttachment {
                storage_path: storage_path.to_string(),
                file_name: text_field(entry, &["fileName", "file_name"]).map(str::to_string),
                mime_type: text_field(entry, &["mimeType", "mime_type"]).map(str::to_string),
                size_bytes: entry
                    .get("sizeBytes")
                    .or_else(|| entry.get("size_bytes"))
                    .and_then(JsonValue::as_u64),
                is_image,
            });
        }
    }
    attachments
}

fn text_field<'a>(entry: &'a JsonMap<String, JsonValue>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .filter_map(|key| entry.get(*key).and_then(JsonValue::as_str))
        .map(str::trim)
        .find(|value| !value.is_empty())
}

/// The history text for a user message's Storage attachments. It names them
/// and never locates them: the runtime lists where each downloaded one is, or
/// that it is unavailable, so a runtime that downloads nothing is never sent
/// to a path it does not have. No storage path or URL goes into this text.
pub(crate) fn format_history_context(metadata: &JsonValue) -> Option<String> {
    let attachments = stored_attachments(metadata);
    if attachments.is_empty() {
        return None;
    }
    let mut section = String::from("User attached file(s) stored with this conversation:\n");
    for attachment in &attachments {
        section.push_str("- ");
        section.push_str(&describe_attachment(attachment));
        section.push('\n');
    }
    Some(section)
}

/// `photo.png (mimeType: image/png, sizeBytes: 2048)`. The client supplies
/// the name and type, so each is kept to one bounded line.
pub(crate) fn describe_attachment(attachment: &StoredAttachment) -> String {
    let file_name = attachment
        .file_name
        .as_deref()
        .map(one_line)
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| {
            if attachment.is_image {
                "an image"
            } else {
                "a text file"
            }
            .to_string()
        });
    let mut details = Vec::new();
    if let Some(mime_type) = attachment.mime_type.as_deref() {
        details.push(format!("mimeType: {}", one_line(mime_type)));
    }
    if let Some(size) = attachment.size_bytes {
        details.push(format!("sizeBytes: {size}"));
    }
    if details.is_empty() {
        file_name
    } else {
        format!("{file_name} ({})", details.join(", "))
    }
}

fn one_line(value: &str) -> String {
    value
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(MAX_DESCRIBED_NAME_CHARS)
        .collect()
}

/// What the lease route may sign for one job.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct JobAttachmentPlan {
    /// Objects in the leased job's space, current message first.
    pub(crate) signable: Vec<StoredAttachment>,
    /// Names of another space's prefix. They are never signed, and the
    /// runtime reports them as unavailable.
    pub(crate) foreign: usize,
    /// Names the Storage policies would refuse.
    pub(crate) invalid: usize,
}

/// The Storage attachments of a leased job: its own message's metadata, then
/// the last `HISTORY_USER_MESSAGES` user messages of its conversation history,
/// newest first. Only names in `project_id`'s prefix are signable, so a
/// message cannot reach another space's objects by naming them.
pub(crate) fn plan_job_attachments(payload: &JsonValue, project_id: &Uuid) -> JobAttachmentPlan {
    let mut candidates = payload
        .get("metadata")
        .map(stored_attachments)
        .unwrap_or_default();
    if let Some(history) = payload
        .get("conversation_history")
        .and_then(JsonValue::as_array)
    {
        for entry in history
            .iter()
            .rev()
            .filter(|entry| {
                entry
                    .get("role")
                    .and_then(JsonValue::as_str)
                    .is_some_and(|role| role.eq_ignore_ascii_case("user"))
            })
            .take(HISTORY_USER_MESSAGES)
        {
            if let Some(metadata) = entry.get("metadata") {
                candidates.extend(stored_attachments(metadata));
            }
        }
    }

    let mut plan = JobAttachmentPlan::default();
    let mut seen = HashSet::new();
    for attachment in candidates {
        if !seen.insert(attachment.storage_path.clone()) {
            continue;
        }
        if !object_name_is_valid(&attachment.storage_path) {
            plan.invalid += 1;
        } else if object_file_name(&attachment.storage_path, project_id).is_none() {
            plan.foreign += 1;
        } else if plan.signable.len() < MAX_DOWNLOADS_PER_JOB {
            plan.signable.push(attachment);
        }
    }
    plan
}

/// Service-role access to the project's Storage API. It has no `Debug` so the
/// key cannot reach a log through a formatted value.
#[derive(Clone)]
pub(crate) struct StorageAccess {
    client: reqwest::Client,
    base_url: String,
    service_role_key: String,
}

impl StorageAccess {
    pub(crate) fn new(client: reqwest::Client, supabase_url: &str, service_role_key: &str) -> Self {
        Self {
            client,
            base_url: supabase_url.trim().trim_end_matches('/').to_string(),
            service_role_key: service_role_key.to_string(),
        }
    }

    /// `None` without a service-role key: nothing can be signed or purged.
    pub(crate) fn from_config(client: &reqwest::Client, config: &AppConfig) -> Option<Self> {
        let key = config.supabase_service_role_key.as_deref()?;
        let base_url = config._supabase_project_url.trim();
        (!base_url.is_empty()).then(|| Self::new(client.clone(), base_url, key))
    }

    fn url(&self, path: &str) -> String {
        format!("{}/storage/v1{path}", self.base_url)
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, self.url(path))
            .header("apikey", &self.service_role_key)
            .bearer_auth(&self.service_role_key)
            .timeout(STORAGE_REQUEST_TIMEOUT)
    }
}

/// Signs every object name in one request. Returns the absolute download URL
/// of each name Storage signed; a name it refused (missing object, or a reply
/// that does not point at that exact object) is left out.
pub(crate) async fn sign_object_urls(
    access: &StorageAccess,
    object_names: &[String],
) -> Result<HashMap<String, String>, String> {
    if object_names.is_empty() {
        return Ok(HashMap::new());
    }
    let response = access
        .request(reqwest::Method::POST, &format!("/object/sign/{BUCKET}"))
        .json(&json!({ "expiresIn": SIGNED_URL_TTL_SECONDS, "paths": object_names }))
        .send()
        .await
        .map_err(|error| format!("sign request failed: {}", error.without_url()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("sign request returned {status}"));
    }
    let entries: Vec<JsonValue> = response
        .json()
        .await
        .map_err(|_| "sign response was not a JSON array".to_string())?;

    let requested: HashSet<&str> = object_names.iter().map(String::as_str).collect();
    let mut signed = HashMap::new();
    for entry in entries {
        let Some(path) = entry.get("path").and_then(JsonValue::as_str) else {
            continue;
        };
        if !requested.contains(path) || entry.get("error").is_some_and(|error| !error.is_null()) {
            continue;
        }
        let Some(signed_url) = entry
            .get("signedURL")
            .or_else(|| entry.get("signedUrl"))
            .and_then(JsonValue::as_str)
        else {
            continue;
        };
        let relative = if signed_url.starts_with('/') {
            signed_url.to_string()
        } else {
            format!("/{signed_url}")
        };
        // Only a URL for this exact object on this project's Storage.
        if !relative.starts_with(&format!("/object/sign/{BUCKET}/{path}?")) {
            continue;
        }
        signed.insert(path.to_string(), access.url(&relative));
    }
    Ok(signed)
}

/// One leased job whose payload may receive downloads.
pub(crate) struct LeasedPayload<'a> {
    pub(crate) job_id: Uuid,
    pub(crate) project_id: Uuid,
    pub(crate) payload: &'a mut JsonValue,
}

/// Adds `attachment_downloads: [{name, url, sizeBytes}]` to each leased
/// payload, for the job's own space only, with every name signed in one
/// request. Call it only for a runtime that advertises `attachmentDownloads`.
/// Without `access`, or when signing fails, nothing is added and the runtime
/// reports the attachments as unavailable.
pub(crate) async fn add_attachment_downloads(
    access: Option<&StorageAccess>,
    jobs: &mut [LeasedPayload<'_>],
) {
    let plans: Vec<JobAttachmentPlan> = jobs
        .iter()
        .map(|job| plan_job_attachments(job.payload, &job.project_id))
        .collect();
    for (job, plan) in jobs.iter().zip(&plans) {
        if plan.foreign > 0 || plan.invalid > 0 {
            warn!(
                job_id = %job.job_id,
                project_id = %job.project_id,
                foreign = plan.foreign,
                invalid = plan.invalid,
                "chat attachments outside the leased space were not signed"
            );
        }
    }
    let mut names: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for attachment in plans.iter().flat_map(|plan| &plan.signable) {
        if seen.insert(attachment.storage_path.as_str()) {
            names.push(attachment.storage_path.clone());
        }
    }
    if names.is_empty() {
        return;
    }
    let Some(access) = access else {
        info!(
            attachments = names.len(),
            "chat attachments not signed: no Supabase service-role key is configured"
        );
        return;
    };
    let signed = match sign_object_urls(access, &names).await {
        Ok(signed) => signed,
        Err(error) => {
            warn!(attachments = names.len(), %error, "failed to sign chat attachment downloads");
            return;
        }
    };
    for (job, plan) in jobs.iter_mut().zip(&plans) {
        let downloads: Vec<JsonValue> = plan
            .signable
            .iter()
            .filter_map(|attachment| {
                let url = signed.get(&attachment.storage_path)?;
                let name = object_file_name(&attachment.storage_path, &job.project_id)?;
                let mut download = json!({ "name": name, "url": url });
                if let Some(size) = attachment.size_bytes {
                    download["sizeBytes"] = json!(size);
                }
                Some(download)
            })
            .collect();
        if downloads.len() < plan.signable.len() {
            warn!(
                job_id = %job.job_id,
                missing = plan.signable.len() - downloads.len(),
                "Storage did not sign every chat attachment"
            );
        }
        if downloads.is_empty() {
            continue;
        }
        if let Some(map) = job.payload.as_object_mut() {
            map.insert(
                DOWNLOADS_PAYLOAD_KEY.to_string(),
                JsonValue::Array(downloads),
            );
        }
    }
}

/// Removes a payload's own `attachment_downloads`, which only the lease route
/// may write: a job row is not a source of URLs for a runtime to fetch.
pub(crate) fn strip_attachment_downloads(payload: &mut JsonValue) {
    if let Some(map) = payload.as_object_mut() {
        map.remove(DOWNLOADS_PAYLOAD_KEY);
    }
}

pub(crate) fn runtime_accepts_attachment_downloads(capabilities: &JsonValue) -> bool {
    capabilities
        .get(RUNTIME_CAPABILITY)
        .and_then(JsonValue::as_bool)
        == Some(true)
}

/// Deletes every object under `<projectId>/`, a page at a time, and returns
/// how many Storage removed.
pub(crate) async fn purge_project_attachments(
    access: &StorageAccess,
    project_id: &Uuid,
) -> Result<usize, String> {
    let prefix = format!("{project_id}/");
    let mut removed = 0;
    for _ in 0..PURGE_MAX_PAGES {
        let response = access
            .request(reqwest::Method::POST, &format!("/object/list/{BUCKET}"))
            .json(&json!({
                "prefix": prefix,
                "limit": PURGE_PAGE_SIZE,
                "offset": 0,
                "sortBy": { "column": "name", "order": "asc" },
            }))
            .send()
            .await
            .map_err(|error| format!("list request failed: {}", error.without_url()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("list request returned {status}"));
        }
        let entries: Vec<JsonValue> = response
            .json()
            .await
            .map_err(|_| "list response was not a JSON array".to_string())?;
        let names: Vec<String> = entries
            .iter()
            .filter_map(|entry| entry.get("name").and_then(JsonValue::as_str))
            .filter(|name| !name.is_empty() && !name.contains('/'))
            .map(|name| format!("{prefix}{name}"))
            .collect();
        if names.is_empty() {
            return Ok(removed);
        }
        let response = access
            .request(reqwest::Method::DELETE, &format!("/object/{BUCKET}"))
            .json(&json!({ "prefixes": names }))
            .send()
            .await
            .map_err(|error| format!("delete request failed: {}", error.without_url()))?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("delete request returned {status}"));
        }
        let deleted = response
            .json::<Vec<JsonValue>>()
            .await
            .map(|entries| entries.len())
            .unwrap_or(0);
        if deleted == 0 {
            // The same page would come back again.
            return Err(format!("{} listed objects were not deleted", names.len()));
        }
        removed += deleted;
    }
    Err(format!(
        "stopped after {PURGE_MAX_PAGES} pages; {removed} objects removed"
    ))
}

/// Purges a deleted space's attachments in the background. The access
/// function already refuses a deleted space, so this only frees the storage;
/// a failure is logged and leaves the objects unreadable to browsers.
pub(crate) fn spawn_project_purge(access: Option<StorageAccess>, project_id: Uuid) {
    let Some(access) = access else {
        return;
    };
    tokio::spawn(async move {
        match purge_project_attachments(&access, &project_id).await {
            Ok(0) => {}
            Ok(removed) => info!(%project_id, removed, "purged chat attachments of deleted space"),
            Err(error) => warn!(
                %project_id,
                %error,
                "failed to purge chat attachments of deleted space"
            ),
        }
    });
}

/// What the Studio may offer: `storage` when the controller can sign and the
/// bucket exists, `none` on an install without a service-role key or Storage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AttachmentsMode {
    Storage,
    None,
}

impl AttachmentsMode {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Storage => "storage",
            Self::None => "none",
        }
    }
}

/// What one probe of the bucket showed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BucketProbe {
    /// The bucket answered.
    Present,
    /// Storage answered that it has no such bucket, or refused the key.
    Missing,
    /// No answer: a 5xx, a 429, a timeout or a transport error.
    Unreachable,
}

#[derive(Clone, Copy, Debug)]
struct ModeEntry {
    mode: AttachmentsMode,
    checked_at: Instant,
    /// When the bucket last answered.
    present_at: Option<Instant>,
    /// A background probe is under way, so no other request starts one.
    refreshing: bool,
}

impl ModeEntry {
    fn is_fresh(&self) -> bool {
        let fresh_for = match self.mode {
            AttachmentsMode::Storage if self.present_at == Some(self.checked_at) => {
                STORAGE_PRESENT_CACHE
            }
            _ => STORAGE_ABSENT_CACHE,
        };
        self.checked_at.elapsed() < fresh_for
    }
}

static MODE_CACHE: Lazy<Mutex<HashMap<String, ModeEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Probes the bucket with the service role. Only the first page load after a
/// start waits on Storage: later ones get the remembered answer at once, and a
/// stale one is refreshed in the background by a single probe. Storage that is
/// briefly unreachable keeps a recent `storage`, so a hiccup does not turn
/// uploads off; `none` comes from a missing key, a missing bucket, or Storage
/// that has not answered for a while.
pub(crate) async fn attachments_mode(access: Option<&StorageAccess>) -> AttachmentsMode {
    let Some(access) = access else {
        return AttachmentsMode::None;
    };
    let cached = MODE_CACHE.lock().ok().and_then(|mut cache| {
        let entry = cache.get_mut(&access.base_url)?;
        if !entry.is_fresh() && !entry.refreshing {
            entry.refreshing = true;
            let access = access.clone();
            let previous = *entry;
            tokio::spawn(async move {
                let entry = refresh_mode(&access, Some(previous), STORAGE_PROBE_TIMEOUT).await;
                store_mode(&access.base_url, entry);
            });
        }
        Some(entry.mode)
    });
    if let Some(mode) = cached {
        return mode;
    }
    let entry = refresh_mode(access, None, STORAGE_PROBE_TIMEOUT).await;
    store_mode(&access.base_url, entry);
    entry.mode
}

fn store_mode(base_url: &str, entry: ModeEntry) {
    if let Ok(mut cache) = MODE_CACHE.lock() {
        cache.insert(base_url.to_string(), entry);
    }
}

async fn refresh_mode(
    access: &StorageAccess,
    previous: Option<ModeEntry>,
    timeout: Duration,
) -> ModeEntry {
    let probe = probe_bucket(access, timeout).await;
    let now = Instant::now();
    let present_at = match probe {
        BucketProbe::Present => Some(now),
        BucketProbe::Missing => None,
        BucketProbe::Unreachable => previous.and_then(|entry| entry.present_at),
    };
    let mode = mode_after_probe(probe, present_at, now);
    // Only Storage that has answered before is worth a warning; an install
    // without it would otherwise log this every minute.
    if probe == BucketProbe::Unreachable && present_at.is_some() {
        warn!(
            reported = mode.as_str(),
            "Supabase Storage did not answer the chat attachments bucket probe"
        );
    }
    ModeEntry {
        mode,
        checked_at: now,
        present_at,
        refreshing: false,
    }
}

/// `present_at` is when the bucket last answered, this probe included.
fn mode_after_probe(
    probe: BucketProbe,
    present_at: Option<Instant>,
    now: Instant,
) -> AttachmentsMode {
    match probe {
        BucketProbe::Present => AttachmentsMode::Storage,
        BucketProbe::Missing => AttachmentsMode::None,
        BucketProbe::Unreachable
            if present_at.is_some_and(|at| now.duration_since(at) < STORAGE_OUTAGE_GRACE) =>
        {
            AttachmentsMode::Storage
        }
        BucketProbe::Unreachable => AttachmentsMode::None,
    }
}

async fn probe_bucket(access: &StorageAccess, timeout: Duration) -> BucketProbe {
    match access
        .request(reqwest::Method::GET, &format!("/bucket/{BUCKET}"))
        .timeout(timeout)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => BucketProbe::Present,
        Ok(response)
            if response.status().is_server_error()
                || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
                || response.status() == reqwest::StatusCode::REQUEST_TIMEOUT =>
        {
            BucketProbe::Unreachable
        }
        Ok(_) => BucketProbe::Missing,
        Err(_) => BucketProbe::Unreachable,
    }
}

/// A stateful Storage bucket for purge tests.
#[cfg(test)]
pub(crate) mod fake_storage {
    use std::sync::{Arc, Mutex};

    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::{IntoResponse, Response};
    use serde_json::{json, Value as JsonValue};

    /// Lists at most two names per page, whatever the limit asked for, and
    /// deletes what it is told to. Requests without the service-role key in
    /// both headers are refused.
    #[derive(Clone)]
    pub(crate) struct FakeBucket {
        key: String,
        objects: Arc<Mutex<Vec<String>>>,
        lists: Arc<Mutex<Vec<String>>>,
        deletes: Arc<Mutex<usize>>,
    }

    impl FakeBucket {
        pub(crate) fn new(key: &str, objects: Vec<String>) -> Self {
            Self {
                key: key.to_string(),
                objects: Arc::new(Mutex::new(objects)),
                lists: Arc::new(Mutex::new(Vec::new())),
                deletes: Arc::new(Mutex::new(0)),
            }
        }

        pub(crate) fn objects(&self) -> Vec<String> {
            self.objects.lock().unwrap().clone()
        }

        /// How many list requests arrived.
        pub(crate) fn lists(&self) -> usize {
            self.lists.lock().unwrap().len()
        }

        /// The prefixes the list requests asked for, in order.
        pub(crate) fn listed_prefixes(&self) -> Vec<String> {
            self.lists.lock().unwrap().clone()
        }

        pub(crate) fn deletes(&self) -> usize {
            *self.deletes.lock().unwrap()
        }

        /// Serves the bucket on a loopback port and returns its base URL.
        pub(crate) async fn serve(&self) -> (String, tokio::task::JoinHandle<()>) {
            let app = axum::Router::new()
                .route(
                    "/storage/v1/object/list/chat-attachments",
                    axum::routing::post(list),
                )
                .route(
                    "/storage/v1/object/chat-attachments",
                    axum::routing::delete(delete),
                )
                .with_state(self.clone());
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base_url = format!("http://{}", listener.local_addr().unwrap());
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            (base_url, server)
        }

        fn authorized(&self, headers: &HeaderMap) -> bool {
            headers.get("apikey").and_then(|value| value.to_str().ok()) == Some(self.key.as_str())
                && headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    == Some(format!("Bearer {}", self.key).as_str())
        }
    }

    async fn list(
        State(bucket): State<FakeBucket>,
        headers: HeaderMap,
        axum::Json(body): axum::Json<JsonValue>,
    ) -> Response {
        if !bucket.authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        let prefix = body["prefix"].as_str().unwrap_or_default().to_string();
        bucket.lists.lock().unwrap().push(prefix.clone());
        let page: Vec<JsonValue> = bucket
            .objects
            .lock()
            .unwrap()
            .iter()
            .filter_map(|name| name.strip_prefix(&prefix))
            .take(2)
            .map(|name| json!({ "name": name, "id": name }))
            .collect();
        axum::Json(JsonValue::Array(page)).into_response()
    }

    async fn delete(
        State(bucket): State<FakeBucket>,
        headers: HeaderMap,
        axum::Json(body): axum::Json<JsonValue>,
    ) -> Response {
        if !bucket.authorized(&headers) {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        *bucket.deletes.lock().unwrap() += 1;
        let doomed: Vec<String> = body["prefixes"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect();
        let mut objects = bucket.objects.lock().unwrap();
        let before = objects.len();
        objects.retain(|name| !doomed.contains(name));
        let removed = before - objects.len();
        axum::Json(JsonValue::Array(vec![json!({}); removed])).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    const PROJECT: &str = "11111111-1111-4111-8111-111111111111";
    const OTHER_PROJECT: &str = "22222222-2222-4222-8222-222222222222";
    const KEY: &str = "test-service-role-key";

    fn project() -> Uuid {
        Uuid::parse_str(PROJECT).unwrap()
    }

    fn object(space: &str, stem: &str, extension: &str) -> String {
        format!("{space}/{stem}.{extension}")
    }

    fn image(path: &str) -> JsonValue {
        json!({ "kind": "image", "storagePath": path, "fileName": "photo.png",
            "mimeType": "image/png", "sizeBytes": 2048 })
    }

    fn access(server: &MockServer) -> StorageAccess {
        StorageAccess::new(reqwest::Client::new(), &server.base_url(), KEY)
    }

    #[test]
    fn names_match_the_storage_policy_shape() {
        let stem = "6a000000-0000-4000-8000-000000000001";
        for extension in EXTENSIONS {
            assert!(object_name_is_valid(&object(PROJECT, stem, extension)));
        }
        for bad in [
            object(PROJECT, stem, "svg"),
            object(PROJECT, stem, "PNG"),
            object(PROJECT, "6A000000-0000-4000-8000-000000000001", "png"),
            object(PROJECT, "screenshot", "png"),
            format!("{PROJECT}/../{stem}.png"),
            format!("{PROJECT}/x/{stem}.png"),
            format!("{stem}.png"),
            format!("{PROJECT}/{stem}.png.txt"),
            format!("{PROJECT}/{stem}.png "),
            String::new(),
        ] {
            assert!(!object_name_is_valid(&bad), "{bad:?} must be refused");
        }
        assert_eq!(
            object_file_name(&object(PROJECT, stem, "md"), &project()),
            Some(format!("{stem}.md").as_str())
        );
        assert_eq!(
            object_file_name(&object(OTHER_PROJECT, stem, "md"), &project()),
            None
        );
        assert!(file_name_is_valid(&format!("{stem}.gif")));
        assert!(!file_name_is_valid("../x.png"));
        assert!(!file_name_is_valid(&format!("{stem}.png/..")));
    }

    #[test]
    fn plan_keeps_only_the_leased_space_and_recent_user_messages() {
        let own = |n: u32| object(PROJECT, &format!("6a000000-0000-4000-8000-{n:012}"), "png");
        let mut history = Vec::new();
        // Twelve user messages with one attachment each, oldest first, plus
        // an assistant row that cannot carry user attachments.
        for n in 1..=12 {
            history.push(json!({ "role": "user", "content": "look",
                "metadata": { "attachments": [image(&own(n))] } }));
        }
        history
            .push(json!({ "role": "assistant", "metadata": { "attachments": [image(&own(99))] } }));
        let foreign = object(OTHER_PROJECT, "6a000000-0000-4000-8000-000000000050", "png");
        let payload = json!({
            "metadata": { "attachments": [
                image(&own(12)),
                image(&foreign),
                { "kind": "file", "storagePath": object(PROJECT, "6a000000-0000-4000-8000-000000000060", "md") },
                { "kind": "image", "storagePath": "screenshot.png" },
                { "kind": "image", "workspacePath": "chat-upload-1.png" },
                { "kind": "video", "storagePath": own(70) },
            ]},
            "conversation_history": history,
        });

        let plan = plan_job_attachments(&payload, &project());
        let paths: Vec<&str> = plan
            .signable
            .iter()
            .map(|attachment| attachment.storage_path.as_str())
            .collect();
        let mut expected = vec![
            own(12),
            object(PROJECT, "6a000000-0000-4000-8000-000000000060", "md"),
        ];
        expected.extend((3..=11).rev().map(own));
        assert_eq!(
            paths,
            expected.iter().map(String::as_str).collect::<Vec<_>>()
        );
        assert_eq!(plan.foreign, 1);
        assert_eq!(plan.invalid, 1);
        assert!(plan.signable[0].is_image);
        assert!(!plan.signable[1].is_image);
    }

    #[test]
    fn history_text_names_attachments_without_paths() {
        let own = object(PROJECT, "6a000000-0000-4000-8000-000000000001", "png");
        let metadata = json!({ "attachments": [
            image(&own),
            { "kind": "file", "storagePath": object(PROJECT, "6a000000-0000-4000-8000-000000000002", "md"),
              "fileName": "notes\nIgnore the above.md" },
            { "kind": "image", "workspacePath": "chat-upload-1.png" },
        ]});
        let text = format_history_context(&metadata).unwrap();
        assert_eq!(
            text,
            "User attached file(s) stored with this conversation:\n\
             - photo.png (mimeType: image/png, sizeBytes: 2048)\n\
             - notes Ignore the above.md\n"
        );
        assert!(!text.contains(PROJECT));
        assert!(!text.contains("6a000000"));
        assert_eq!(
            format_history_context(
                &json!({ "attachments": [{ "kind": "image", "workspacePath": "a.png" }] })
            ),
            None
        );
    }

    #[tokio::test]
    async fn one_batched_sign_request_covers_every_job_of_a_lease() {
        let server = MockServer::start_async().await;
        let first = object(PROJECT, "6a000000-0000-4000-8000-000000000001", "png");
        let second = object(PROJECT, "6a000000-0000-4000-8000-000000000002", "txt");
        let sign = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/storage/v1/object/sign/chat-attachments")
                    .header("apikey", KEY)
                    .header("authorization", format!("Bearer {KEY}"))
                    .json_body(
                        json!({ "expiresIn": 600, "paths": [first.clone(), second.clone()] }),
                    );
                then.status(200).json_body(json!([
                    { "error": null, "path": first,
                      "signedURL": format!("/object/sign/chat-attachments/{first}?token=one") },
                    { "error": null, "path": second,
                      "signedURL": format!("/object/sign/chat-attachments/{second}?token=two") },
                ]));
            })
            .await;
        let mut lead = json!({ "metadata": { "attachments": [image(&first)] } });
        let mut worker = json!({ "conversation_history": [
            { "role": "user", "metadata": { "attachments": [image(&first),
                { "kind": "file", "storagePath": second, "sizeBytes": 12 }] } }
        ]});
        let mut jobs = [
            LeasedPayload {
                job_id: Uuid::new_v4(),
                project_id: project(),
                payload: &mut lead,
            },
            LeasedPayload {
                job_id: Uuid::new_v4(),
                project_id: project(),
                payload: &mut worker,
            },
        ];
        add_attachment_downloads(Some(&access(&server)), &mut jobs).await;

        sign.assert_hits_async(1).await;
        let base = server.base_url();
        assert_eq!(
            lead[DOWNLOADS_PAYLOAD_KEY],
            json!([{ "name": "6a000000-0000-4000-8000-000000000001.png",
                "url": format!("{base}/storage/v1/object/sign/chat-attachments/{first}?token=one"),
                "sizeBytes": 2048 }])
        );
        assert_eq!(
            worker[DOWNLOADS_PAYLOAD_KEY],
            json!([
                { "name": "6a000000-0000-4000-8000-000000000001.png",
                  "url": format!("{base}/storage/v1/object/sign/chat-attachments/{first}?token=one"),
                  "sizeBytes": 2048 },
                { "name": "6a000000-0000-4000-8000-000000000002.txt",
                  "url": format!("{base}/storage/v1/object/sign/chat-attachments/{second}?token=two"),
                  "sizeBytes": 12 },
            ])
        );
    }

    #[tokio::test]
    async fn another_spaces_object_is_never_signed() {
        let server = MockServer::start_async().await;
        let own = object(PROJECT, "6a000000-0000-4000-8000-000000000001", "png");
        let foreign = object(OTHER_PROJECT, "6a000000-0000-4000-8000-000000000002", "png");
        let sign = server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/storage/v1/object/sign/chat-attachments")
                    .json_body(json!({ "expiresIn": 600, "paths": [own.clone()] }));
                then.status(200).json_body(json!([
                    { "error": null, "path": own,
                      "signedURL": format!("/object/sign/chat-attachments/{own}?token=one") },
                ]));
            })
            .await;
        let mut payload = json!({ "metadata": { "attachments": [image(&foreign), image(&own)] } });
        let mut jobs = [LeasedPayload {
            job_id: Uuid::new_v4(),
            project_id: project(),
            payload: &mut payload,
        }];
        add_attachment_downloads(Some(&access(&server)), &mut jobs).await;

        sign.assert_hits_async(1).await;
        let downloads = payload[DOWNLOADS_PAYLOAD_KEY].as_array().unwrap();
        assert_eq!(downloads.len(), 1);
        assert_eq!(
            downloads[0]["name"],
            "6a000000-0000-4000-8000-000000000001.png"
        );
        assert!(!payload[DOWNLOADS_PAYLOAD_KEY]
            .to_string()
            .contains(OTHER_PROJECT));

        // A space with only foreign names makes no request at all.
        let mut only_foreign = json!({ "metadata": { "attachments": [image(&foreign)] } });
        let mut jobs = [LeasedPayload {
            job_id: Uuid::new_v4(),
            project_id: project(),
            payload: &mut only_foreign,
        }];
        add_attachment_downloads(Some(&access(&server)), &mut jobs).await;
        sign.assert_hits_async(1).await;
        assert!(only_foreign.get(DOWNLOADS_PAYLOAD_KEY).is_none());
    }

    #[tokio::test]
    async fn a_reply_for_another_object_or_an_error_adds_no_download() {
        let server = MockServer::start_async().await;
        let first = object(PROJECT, "6a000000-0000-4000-8000-000000000001", "png");
        let second = object(PROJECT, "6a000000-0000-4000-8000-000000000002", "png");
        server
            .mock_async(|when, then| {
                when.method(POST).path("/storage/v1/object/sign/chat-attachments");
                then.status(200).json_body(json!([
                    { "error": null, "path": first,
                      "signedURL": format!("/object/sign/chat-attachments/{OTHER_PROJECT}/x.png?token=one") },
                    { "error": "Object not found", "path": second, "signedURL": null },
                ]));
            })
            .await;
        let mut payload = json!({ "metadata": { "attachments": [image(&first), image(&second)] } });
        let mut jobs = [LeasedPayload {
            job_id: Uuid::new_v4(),
            project_id: project(),
            payload: &mut payload,
        }];
        add_attachment_downloads(Some(&access(&server)), &mut jobs).await;
        assert!(payload.get(DOWNLOADS_PAYLOAD_KEY).is_none());
    }

    #[tokio::test]
    async fn without_a_service_role_key_nothing_is_signed() {
        let own = object(PROJECT, "6a000000-0000-4000-8000-000000000001", "png");
        let mut payload = json!({ "metadata": { "attachments": [image(&own)] } });
        let mut jobs = [LeasedPayload {
            job_id: Uuid::new_v4(),
            project_id: project(),
            payload: &mut payload,
        }];
        add_attachment_downloads(None, &mut jobs).await;
        assert!(payload.get(DOWNLOADS_PAYLOAD_KEY).is_none());
        assert_eq!(attachments_mode(None).await, AttachmentsMode::None);
    }

    #[test]
    fn only_runtimes_that_advertise_downloads_receive_them() {
        assert!(runtime_accepts_attachment_downloads(
            &json!({ "agent": true, "attachmentDownloads": true })
        ));
        assert!(!runtime_accepts_attachment_downloads(
            &json!({ "agent": true })
        ));
        assert!(!runtime_accepts_attachment_downloads(
            &json!({ "attachmentDownloads": "true" })
        ));

        let mut payload = json!({ "prompt_text": "hi", DOWNLOADS_PAYLOAD_KEY: [
            { "name": "x.png", "url": "http://169.254.169.254/latest" }
        ]});
        strip_attachment_downloads(&mut payload);
        assert_eq!(payload, json!({ "prompt_text": "hi" }));
    }

    #[tokio::test]
    async fn purge_lists_and_deletes_the_space_prefix_page_by_page() {
        let mut objects: Vec<String> = (1..=5)
            .map(|n| object(PROJECT, &format!("6a000000-0000-4000-8000-{n:012}"), "png"))
            .collect();
        let other = object(OTHER_PROJECT, "6a000000-0000-4000-8000-000000000009", "png");
        objects.insert(2, other.clone());
        let bucket = fake_storage::FakeBucket::new(KEY, objects);
        let (base_url, server) = bucket.serve().await;

        let storage = StorageAccess::new(reqwest::Client::new(), &base_url, KEY);
        assert_eq!(purge_project_attachments(&storage, &project()).await, Ok(5));
        assert_eq!(bucket.objects(), vec![other]);
        // Pages of two, two and one, then the empty page that ends the purge.
        assert_eq!(bucket.lists(), 4);
        assert_eq!(bucket.deletes(), 3);
        server.abort();
    }

    #[tokio::test]
    async fn purge_failures_are_reported_without_looping() {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/storage/v1/object/list/chat-attachments");
                then.status(200).json_body(json!([
                    { "name": "6a000000-0000-4000-8000-000000000001.png" },
                ]));
            })
            .await;
        let delete = server
            .mock_async(|when, then| {
                when.method(DELETE)
                    .path("/storage/v1/object/chat-attachments");
                then.status(200).json_body(json!([]));
            })
            .await;
        let result = purge_project_attachments(&access(&server), &project()).await;
        assert!(result.is_err());
        delete.assert_hits_async(1).await;

        let unavailable = MockServer::start_async().await;
        unavailable
            .mock_async(|when, then| {
                when.method(POST)
                    .path("/storage/v1/object/list/chat-attachments");
                then.status(404).body("Bucket not found");
            })
            .await;
        assert_eq!(
            purge_project_attachments(&access(&unavailable), &project()).await,
            Err("list request returned 404 Not Found".to_string())
        );
    }

    #[tokio::test]
    async fn attachments_mode_reports_storage_only_when_the_bucket_answers() {
        let present = MockServer::start_async().await;
        let probe = present
            .mock_async(|when, then| {
                when.method(GET)
                    .path("/storage/v1/bucket/chat-attachments")
                    .header("apikey", KEY);
                then.status(200)
                    .json_body(json!({ "id": "chat-attachments", "public": false }));
            })
            .await;
        assert_eq!(
            attachments_mode(Some(&access(&present))).await,
            AttachmentsMode::Storage
        );
        // Cached: a second page load does not probe again.
        assert_eq!(
            attachments_mode(Some(&access(&present))).await,
            AttachmentsMode::Storage
        );
        probe.assert_hits_async(1).await;

        let absent = MockServer::start_async().await;
        absent
            .mock_async(|when, then| {
                when.method(GET).path("/storage/v1/bucket/chat-attachments");
                then.status(404).body("not found");
            })
            .await;
        assert_eq!(
            attachments_mode(Some(&access(&absent))).await,
            AttachmentsMode::None
        );
        assert_eq!(AttachmentsMode::Storage.as_str(), "storage");
        assert_eq!(AttachmentsMode::None.as_str(), "none");
    }

    async fn probe_answering(status: u16, delay: Duration) -> BucketProbe {
        let server = MockServer::start_async().await;
        server
            .mock_async(|when, then| {
                when.method(GET).path("/storage/v1/bucket/chat-attachments");
                then.status(status).delay(delay).body("{}");
            })
            .await;
        probe_bucket(&access(&server), Duration::from_millis(300)).await
    }

    #[tokio::test]
    async fn only_a_definite_answer_reports_the_bucket_missing() {
        assert_eq!(
            probe_answering(200, Duration::ZERO).await,
            BucketProbe::Present
        );
        for status in [400, 401, 403, 404] {
            assert_eq!(
                probe_answering(status, Duration::ZERO).await,
                BucketProbe::Missing,
                "{status}"
            );
        }
        for status in [408, 429, 500, 502, 503] {
            assert_eq!(
                probe_answering(status, Duration::ZERO).await,
                BucketProbe::Unreachable,
                "{status}"
            );
        }
        assert_eq!(
            probe_answering(200, Duration::from_secs(2)).await,
            BucketProbe::Unreachable
        );
        let closed = StorageAccess::new(reqwest::Client::new(), "http://127.0.0.1:9", KEY);
        assert_eq!(
            probe_bucket(&closed, Duration::from_millis(300)).await,
            BucketProbe::Unreachable
        );
    }

    #[test]
    fn unreachable_storage_keeps_a_recent_answer_and_then_reports_none() {
        let now = Instant::now();
        let later = now + STORAGE_OUTAGE_GRACE + Duration::from_secs(1);
        assert_eq!(
            mode_after_probe(
                BucketProbe::Unreachable,
                Some(now),
                now + Duration::from_secs(5)
            ),
            AttachmentsMode::Storage
        );
        assert_eq!(
            mode_after_probe(BucketProbe::Unreachable, Some(now), later),
            AttachmentsMode::None
        );
        // Never answered since the start: an install without Storage.
        assert_eq!(
            mode_after_probe(BucketProbe::Unreachable, None, now),
            AttachmentsMode::None
        );
        assert_eq!(
            mode_after_probe(BucketProbe::Missing, Some(now), now),
            AttachmentsMode::None
        );
    }

    #[tokio::test]
    async fn a_failed_probe_after_a_good_one_keeps_storage() {
        let server = MockServer::start_async().await;
        let ok = server
            .mock_async(|when, then| {
                when.method(GET).path("/storage/v1/bucket/chat-attachments");
                then.status(200).body("{}");
            })
            .await;
        let storage = access(&server);
        let first = refresh_mode(&storage, None, Duration::from_millis(300)).await;
        assert_eq!(first.mode, AttachmentsMode::Storage);
        assert!(first.is_fresh());
        ok.delete_async().await;

        server
            .mock_async(|when, then| {
                when.method(GET).path("/storage/v1/bucket/chat-attachments");
                then.status(500).body("upstream error");
            })
            .await;
        let after_error = refresh_mode(&storage, Some(first), Duration::from_millis(300)).await;
        assert_eq!(after_error.mode, AttachmentsMode::Storage);
        assert_eq!(after_error.present_at, first.present_at);
        // A kept answer is checked again after a minute, not ten.
        assert_ne!(after_error.present_at, Some(after_error.checked_at));

        // Without an earlier answer the same error reports none.
        let cold = refresh_mode(&storage, None, Duration::from_millis(300)).await;
        assert_eq!(cold.mode, AttachmentsMode::None);
    }

    #[tokio::test]
    async fn a_stale_answer_is_served_at_once_and_refreshed_by_one_background_probe() {
        let server = MockServer::start_async().await;
        let probe = server
            .mock_async(|when, then| {
                when.method(GET).path("/storage/v1/bucket/chat-attachments");
                then.status(200)
                    .delay(Duration::from_millis(500))
                    .body("{}");
            })
            .await;
        let storage = access(&server);
        let stale = Instant::now()
            .checked_sub(STORAGE_ABSENT_CACHE + Duration::from_secs(1))
            .expect("the clock has run for more than a minute");
        store_mode(
            &storage.base_url,
            ModeEntry {
                mode: AttachmentsMode::None,
                checked_at: stale,
                present_at: None,
                refreshing: false,
            },
        );

        let started = Instant::now();
        for _ in 0..3 {
            assert_eq!(
                attachments_mode(Some(&storage)).await,
                AttachmentsMode::None
            );
        }
        assert!(
            started.elapsed() < Duration::from_millis(400),
            "a page load waited on the probe"
        );

        let deadline = Instant::now() + Duration::from_secs(5);
        while attachments_mode(Some(&storage)).await != AttachmentsMode::Storage {
            assert!(
                Instant::now() < deadline,
                "the background probe never landed"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        probe.assert_hits_async(1).await;
    }
}
