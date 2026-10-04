//! Origin I/O of the project-memory bootstrap.
//!
//! The bootstrap reads the managed files, decides what to write and applies
//! it with `autoCommitAfterApply`. Against an origin that reports what it
//! served, the write is conditional:
//!
//! - every read after the one that first reports `X-Instafy-Rev` is pinned to
//!   that revision with `?rev=`, and the apply carries it as `baseRev`;
//! - the apply carries `expected`: for each written path, the
//!   `X-Instafy-Blob` its read returned, or `null` when the read was a 404
//!   (the path must still be absent).
//!
//! A 409 means the space moved since the read: read, plan and write once
//! more; a second 409 reports `workspace-busy`. An origin that reports
//! neither header predates conditional writes: it gets the unconditional
//! manifest it always got (logged once per origin), and never fails for the
//! missing headers.

use std::collections::{BTreeMap, HashSet};
use std::io::{Cursor, Write};
use std::sync::{Mutex, OnceLock};
use std::time::Duration as StdDuration;

use axum::http::StatusCode;
use axum::Json;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::Utc;
use reqwest::multipart::{Form, Part};
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use tokio::time::timeout;
use uuid::Uuid;
use zip::write::{FileOptions, ZipWriter};

use crate::errors::{internal_error, ApiError};

pub(crate) const ORIGIN_APPLY_TIMEOUT_SECS: u64 = 180;
const ORIGIN_READ_TIMEOUT_SECS: u64 = 20;
/// Commit an origin serves reads from (hosted gateway).
pub(crate) const INSTAFY_REV_HEADER: &str = "x-instafy-rev";
/// Git blob id of exactly the bytes a read served.
pub(crate) const INSTAFY_BLOB_HEADER: &str = "x-instafy-blob";
const BOOTSTRAP_COMMIT_MESSAGE: &str = "instafy: bootstrap project memory";
/// One write, and one more after a conflict.
const BOOTSTRAP_WRITE_ATTEMPTS: usize = 2;
/// Bound on the origins remembered for the once-per-origin log line.
const MAX_REMEMBERED_LEGACY_ORIGINS: usize = 4_096;

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

#[derive(Debug, Clone)]
pub(crate) struct ProjectMemoryWriteFile {
    pub(crate) path: String,
    pub(crate) content: String,
}

/// One path as the origin served it: its text (`None` for a 404) and the
/// blob id the origin reported for it, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OriginReadFile {
    pub(crate) content: Option<String>,
    pub(crate) blob: Option<String>,
}

/// The managed files read from one origin, and the revision the reads were
/// pinned to.
#[derive(Debug, Clone, Default)]
pub(crate) struct OriginReadSnapshot {
    pub(crate) rev: Option<String>,
    pub(crate) files: BTreeMap<String, OriginReadFile>,
}

impl OriginReadSnapshot {
    pub(crate) fn content(&self, path: &str) -> Option<&str> {
        self.files
            .get(path)
            .and_then(|file| file.content.as_deref())
    }

    /// Whether the origin reported what it served: a revision, or the blob
    /// of a file it returned. Origins that do neither predate conditional
    /// writes.
    fn reports_read_state(&self) -> bool {
        self.rev.is_some() || self.files.values().any(|file| file.blob.is_some())
    }

    /// The `expected` map for `writes`: the blob each path was read with, or
    /// `None` (must not exist) for a path that was absent. A path served
    /// without a blob id gets no condition. Empty for an origin that reports
    /// nothing, which then receives an unconditional manifest.
    fn expected_for(&self, writes: &[ProjectMemoryWriteFile]) -> BTreeMap<String, Option<String>> {
        if !self.reports_read_state() {
            return BTreeMap::new();
        }
        writes
            .iter()
            .filter_map(|write| {
                let read = self.files.get(&write.path)?;
                match (&read.content, &read.blob) {
                    (Some(_), Some(blob)) => Some((write.path.clone(), Some(blob.clone()))),
                    (None, _) => Some((write.path.clone(), None)),
                    (Some(_), None) => None,
                }
            })
            .collect()
    }
}

/// Where the bootstrap reads and writes.
pub(crate) struct OriginBootstrapTarget<'a> {
    pub(crate) http: &'a reqwest::Client,
    /// Origin base URL without a trailing slash.
    pub(crate) endpoint: &'a str,
    pub(crate) origin_id: Uuid,
    pub(crate) project_id: Uuid,
}

pub(crate) enum BootstrapWriteOutcome {
    Seeded {
        file_count: usize,
        rev: Option<String>,
    },
    /// Nothing to write, or the origin found the content already there.
    AlreadyPresent { rev: Option<String> },
    /// The origin refused both writes as stale.
    WorkspaceBusy,
}

/// Read `paths` in order, pinning every read after the first that reports a
/// revision to that revision.
pub(crate) async fn read_origin_snapshot(
    target: &OriginBootstrapTarget<'_>,
    token: &str,
    paths: &[String],
) -> ApiResult<OriginReadSnapshot> {
    let mut snapshot = OriginReadSnapshot::default();
    for path in paths {
        let read = origin_read_text_file(target, token, path, snapshot.rev.as_deref()).await?;
        if snapshot.rev.is_none() {
            snapshot.rev = read.rev;
        }
        snapshot.files.insert(
            path.clone(),
            OriginReadFile {
                content: read.content,
                blob: read.blob,
            },
        );
    }
    Ok(snapshot)
}

/// Write what `plan` derives from `first`; on a 409, re-read `paths`
/// (unpinned, then pinned to the new revision), re-plan and write once more.
pub(crate) async fn bootstrap_write_via_origin<F>(
    target: &OriginBootstrapTarget<'_>,
    read_token: &str,
    write_token: &str,
    lease_id: Uuid,
    paths: &[String],
    first: OriginReadSnapshot,
    plan: F,
) -> ApiResult<BootstrapWriteOutcome>
where
    F: Fn(&OriginReadSnapshot) -> ApiResult<Vec<ProjectMemoryWriteFile>>,
{
    let mut snapshot = first;
    for attempt in 0..BOOTSTRAP_WRITE_ATTEMPTS {
        if attempt > 0 {
            snapshot = read_origin_snapshot(target, read_token, paths).await?;
        }
        note_unreported_read_state(target, &snapshot);
        let writes = plan(&snapshot)?;
        if writes.is_empty() {
            return Ok(BootstrapWriteOutcome::AlreadyPresent {
                rev: snapshot.rev.clone(),
            });
        }
        match post_bootstrap_apply(target, write_token, lease_id, &snapshot, &writes).await? {
            ApplyAttempt::Applied {
                rev,
                committed: Some(false),
            } => return Ok(BootstrapWriteOutcome::AlreadyPresent { rev }),
            ApplyAttempt::Applied { rev, .. } => {
                return Ok(BootstrapWriteOutcome::Seeded {
                    file_count: writes.len(),
                    rev,
                })
            }
            ApplyAttempt::Conflict => {
                tracing::info!(
                    project_id = %target.project_id,
                    origin_id = %target.origin_id,
                    attempt = attempt + 1,
                    "origin refused a project memory write made from a stale read"
                );
            }
        }
    }
    Ok(BootstrapWriteOutcome::WorkspaceBusy)
}

enum ApplyAttempt {
    Applied {
        rev: Option<String>,
        committed: Option<bool>,
    },
    Conflict,
}

async fn post_bootstrap_apply(
    target: &OriginBootstrapTarget<'_>,
    write_token: &str,
    lease_id: Uuid,
    snapshot: &OriginReadSnapshot,
    writes: &[ProjectMemoryWriteFile],
) -> ApiResult<ApplyAttempt> {
    let (archive, manifest_files) = build_project_memory_archive(writes)
        .map_err(|error| internal_error(format!("failed to build bootstrap archive: {error}")))?;
    let manifest = bootstrap_manifest(
        target.project_id,
        lease_id,
        manifest_files,
        snapshot,
        writes,
    );
    let manifest_json = serde_json::to_vec(&manifest).map_err(|error| {
        internal_error(format!("failed to serialize bootstrap manifest: {error}"))
    })?;

    let form = Form::new()
        .part(
            "manifest",
            Part::bytes(manifest_json)
                .file_name("manifest.json")
                .mime_str("application/json")
                .map_err(|error| {
                    internal_error(format!("failed to build manifest part: {error}"))
                })?,
        )
        .part(
            "archive",
            Part::bytes(archive)
                .file_name("workspace.zip")
                .mime_str("application/zip")
                .map_err(|error| {
                    internal_error(format!("failed to build archive part: {error}"))
                })?,
        );

    let response = timeout(
        StdDuration::from_secs(ORIGIN_APPLY_TIMEOUT_SECS),
        target
            .http
            .post(format!("{}/apply", target.endpoint))
            .bearer_auth(write_token)
            .multipart(form)
            .send(),
    )
    .await
    .map_err(|_| internal_error("origin apply request timed out"))?
    .map_err(|error| internal_error(format!("origin apply request failed: {error}")))?;

    let status = response.status();
    if status == reqwest::StatusCode::CONFLICT {
        return Ok(ApplyAttempt::Conflict);
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(internal_error(format!(
            "origin apply failed ({}): {}",
            status.as_u16(),
            body
        )));
    }

    let payload = response
        .json::<JsonValue>()
        .await
        .map_err(|error| internal_error(format!("origin apply response invalid: {error}")))?;
    let rev = payload
        .get("rev")
        .and_then(JsonValue::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let committed = payload.get("committed").and_then(JsonValue::as_bool);
    Ok(ApplyAttempt::Applied { rev, committed })
}

fn bootstrap_manifest(
    project_id: Uuid,
    lease_id: Uuid,
    manifest_files: Vec<OriginManifestFileEntry>,
    snapshot: &OriginReadSnapshot,
    writes: &[ProjectMemoryWriteFile],
) -> JsonValue {
    let mut manifest = json!({
        "projectId": project_id.to_string(),
        "leaseId": lease_id.to_string(),
        "generatedAt": Utc::now().to_rfc3339(),
        "files": manifest_files,
        "deletes": [],
        // Ensure managed defaults never leave git-canonical workspaces dirty
        // when we introduce new template files (for example new default
        // skills).
        "autoCommitAfterApply": true,
        "commitMessage": BOOTSTRAP_COMMIT_MESSAGE,
    });
    if let Some(rev) = snapshot.rev.as_deref() {
        manifest["baseRev"] = json!(rev);
    }
    let expected = snapshot.expected_for(writes);
    if !expected.is_empty() {
        manifest["expected"] = json!(expected);
    }
    manifest
}

/// Log once per origin (per process) that it reports no read state, so
/// its bootstrap writes stay unconditional.
fn note_unreported_read_state(target: &OriginBootstrapTarget<'_>, snapshot: &OriginReadSnapshot) {
    if snapshot.reports_read_state() || !first_unreported_sighting(target.origin_id) {
        return;
    }
    tracing::info!(
        project_id = %target.project_id,
        origin_id = %target.origin_id,
        "origin reports no read revision or blob ids; project memory writes stay unconditional"
    );
}

fn first_unreported_sighting(origin_id: Uuid) -> bool {
    static SEEN: OnceLock<Mutex<HashSet<Uuid>>> = OnceLock::new();
    let Ok(mut seen) = SEEN.get_or_init(Default::default).lock() else {
        return false;
    };
    if seen.len() >= MAX_REMEMBERED_LEGACY_ORIGINS {
        return false;
    }
    seen.insert(origin_id)
}

struct OriginTextRead {
    content: Option<String>,
    blob: Option<String>,
    rev: Option<String>,
}

async fn origin_read_text_file(
    target: &OriginBootstrapTarget<'_>,
    token: &str,
    path: &str,
    rev: Option<&str>,
) -> ApiResult<OriginTextRead> {
    let encoded = encode_workspace_path(path);
    let mut url = format!("{}/files/{encoded}?encoding=base64", target.endpoint);
    if let Some(rev) = rev {
        // A validated hexadecimal object id: nothing to escape.
        url.push_str("&rev=");
        url.push_str(rev);
    }
    let response = timeout(
        StdDuration::from_secs(ORIGIN_READ_TIMEOUT_SECS),
        target.http.get(url).bearer_auth(token).send(),
    )
    .await
    .map_err(|_| internal_error("origin file lookup timed out"))?
    .map_err(|error| internal_error(format!("origin file lookup failed: {error}")))?;
    let status = response.status();
    let served_rev = header_object_id(response.headers(), INSTAFY_REV_HEADER);

    if status == reqwest::StatusCode::NOT_FOUND {
        let body = response.text().await.unwrap_or_default();
        // A pinned read of a revision the origin no longer serves is not an
        // absent file: never plan writes from it.
        if rev.is_some() && error_code(&body).as_deref() == Some("rev_not_found") {
            return Err(internal_error(
                "origin no longer serves the revision this bootstrap read",
            ));
        }
        return Ok(OriginTextRead {
            content: None,
            blob: None,
            rev: served_rev,
        });
    }

    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(internal_error(format!(
            "origin file lookup failed ({}): {}",
            status.as_u16(),
            text
        )));
    }

    let blob = header_object_id(response.headers(), INSTAFY_BLOB_HEADER);
    let payload = response
        .json::<JsonValue>()
        .await
        .map_err(|error| internal_error(format!("origin file response invalid: {error}")))?;
    let encoded_content = payload
        .get("contentBase64")
        .or_else(|| payload.get("content_base64"))
        .and_then(|value| value.as_str())
        .ok_or_else(|| internal_error("origin file response missing contentBase64"))?;
    let bytes = BASE64_STANDARD.decode(encoded_content).map_err(|error| {
        internal_error(format!(
            "origin file response base64 decode failed: {error}"
        ))
    })?;
    let text = String::from_utf8(bytes)
        .map_err(|error| internal_error(format!("origin file response was not UTF-8: {error}")))?;
    Ok(OriginTextRead {
        content: Some(text),
        blob,
        rev: served_rev,
    })
}

/// A full SHA-1 or SHA-256 object id from a response header, lower-cased.
/// Anything else counts as absent.
fn header_object_id(headers: &reqwest::header::HeaderMap, name: &str) -> Option<String> {
    let value = headers
        .get(name)?
        .to_str()
        .ok()?
        .trim()
        .to_ascii_lowercase();
    (matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(value)
}

fn error_code(body: &str) -> Option<String> {
    serde_json::from_str::<JsonValue>(body)
        .ok()?
        .get("code")?
        .as_str()
        .map(str::to_string)
}

fn encode_workspace_path(path: &str) -> String {
    path.split('/')
        .filter(|segment| !segment.is_empty())
        .map(|segment| urlencoding::encode(segment).into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OriginManifestFileEntry {
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
}

fn build_project_memory_archive(
    files: &[ProjectMemoryWriteFile],
) -> Result<(Vec<u8>, Vec<OriginManifestFileEntry>), String> {
    let out = Cursor::new(Vec::<u8>::new());
    let mut writer = ZipWriter::new(out);
    let options = FileOptions::<()>::default().compression_method(zip::CompressionMethod::Deflated);
    let mut manifest_files: Vec<OriginManifestFileEntry> = Vec::new();

    for file in files {
        writer
            .start_file(file.path.as_str(), options)
            .map_err(|error| format!("zip write failed: {error}"))?;
        writer
            .write_all(file.content.as_bytes())
            .map_err(|error| format!("zip write failed: {error}"))?;
        manifest_files.push(OriginManifestFileEntry {
            path: file.path.to_string(),
            size: Some(file.content.len() as u64),
        });
    }

    let cursor = writer
        .finish()
        .map_err(|error| format!("zip finalize failed: {error}"))?;

    Ok((cursor.into_inner(), manifest_files))
}

/// A stub origin for bootstrap tests: serves `/files/*` from memory with
/// optional `X-Instafy-Rev` / `X-Instafy-Blob`, and records every `/apply`.
#[cfg(test)]
pub(crate) mod test_support {
    use std::collections::{BTreeMap, HashMap};
    use std::io::{Cursor, Read};
    use std::sync::{Arc, Mutex};

    use axum::body::Bytes;
    use axum::extract::{Path, Query, State};
    use axum::http::{HeaderMap, HeaderValue, StatusCode};
    use axum::response::{IntoResponse, Response};
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    use serde_json::{json, Value};
    use sha1::{Digest, Sha1};

    /// Git's blob id of `content`.
    pub(crate) fn blob_oid(content: &str) -> String {
        let mut hasher = Sha1::new();
        hasher.update(format!("blob {}\0", content.len()).as_bytes());
        hasher.update(content.as_bytes());
        hex::encode(hasher.finalize())
    }

    #[derive(Default)]
    pub(crate) struct StubState {
        pub(crate) files: BTreeMap<String, String>,
        /// Served as `X-Instafy-Rev` when set; each write advances it.
        pub(crate) rev: Option<String>,
        /// Serve `X-Instafy-Blob` with every file.
        pub(crate) report_blobs: bool,
        /// Answer this many applies with 409 before honouring any.
        pub(crate) forced_conflicts: usize,
        /// Refuse an apply whose `expected` does not match, like an origin
        /// that honours it.
        pub(crate) check_expected: bool,
        /// Lands just before the first apply is checked: someone else's save
        /// between the bootstrap's read and its write.
        pub(crate) concurrent_write: Option<(String, String)>,
        /// `committed` in apply responses (default true).
        pub(crate) committed: Option<bool>,
        /// Answer pinned reads with 404 `rev_not_found`.
        pub(crate) forget_revisions: bool,
        /// `(path, rev query)` of every read.
        pub(crate) reads: Vec<(String, Option<String>)>,
        /// Every apply manifest, in order.
        pub(crate) applies: Vec<Value>,
        /// The bearer token of every apply.
        pub(crate) apply_tokens: Vec<String>,
        /// Writes so far; each one advances the served revision.
        pub(crate) writes: usize,
    }

    pub(crate) type SharedStub = Arc<Mutex<StubState>>;

    pub(crate) struct StubOrigin {
        pub(crate) endpoint: String,
        pub(crate) state: SharedStub,
        handle: tokio::task::JoinHandle<()>,
    }

    impl Drop for StubOrigin {
        fn drop(&mut self) {
            self.handle.abort();
        }
    }

    pub(crate) async fn start(state: StubState) -> StubOrigin {
        let shared = Arc::new(Mutex::new(state));
        let app = Router::new()
            .route("/files/*path", get(read_file))
            .route("/apply", post(apply))
            .with_state(shared.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind stub origin");
        let address = listener.local_addr().expect("stub origin address");
        let handle = tokio::spawn(async move {
            axum::serve(listener, app).await.expect("serve stub origin");
        });
        StubOrigin {
            endpoint: format!("http://{address}"),
            state: shared,
            handle,
        }
    }

    pub(crate) fn rev_for(counter: usize) -> String {
        blob_oid(&format!("stub revision {counter}"))
    }

    async fn read_file(
        State(stub): State<SharedStub>,
        Path(path): Path<String>,
        Query(query): Query<HashMap<String, String>>,
    ) -> Response {
        let mut stub = stub.lock().expect("stub lock");
        let pinned = query.get("rev").cloned();
        stub.reads.push((path.clone(), pinned.clone()));
        if stub.forget_revisions && pinned.is_some() {
            return (
                StatusCode::NOT_FOUND,
                Json(json!({ "error": "revision not found", "code": "rev_not_found" })),
            )
                .into_response();
        }
        let mut headers = HeaderMap::new();
        if let Some(rev) = stub.rev.as_deref() {
            headers.insert("x-instafy-rev", HeaderValue::from_str(rev).unwrap());
        }
        match stub.files.get(&path) {
            Some(content) => {
                if stub.report_blobs {
                    headers.insert(
                        "x-instafy-blob",
                        HeaderValue::from_str(&blob_oid(content)).unwrap(),
                    );
                }
                (
                    StatusCode::OK,
                    headers,
                    Json(json!({
                        "path": path,
                        "encoding": "base64",
                        "contentBase64": BASE64.encode(content),
                        "size": content.len(),
                    })),
                )
                    .into_response()
            }
            None => (
                StatusCode::NOT_FOUND,
                headers,
                Json(json!({ "error": "file not found" })),
            )
                .into_response(),
        }
    }

    async fn apply(State(stub): State<SharedStub>, headers: HeaderMap, body: Bytes) -> Response {
        let content_type = headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        let parts = multipart_parts(&content_type, &body);
        let manifest: Value =
            serde_json::from_slice(&parts["manifest"]).expect("manifest part is JSON");
        let archive = unzip(&parts["archive"]);
        let token = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or_default()
            .to_string();

        let mut stub = stub.lock().expect("stub lock");
        stub.applies.push(manifest.clone());
        stub.apply_tokens.push(token);
        if let Some((path, content)) = stub.concurrent_write.take() {
            stub.files.insert(path, content);
            advance(&mut stub);
        }
        if stub.forced_conflicts > 0 {
            stub.forced_conflicts -= 1;
            return (
                StatusCode::CONFLICT,
                Json(json!({ "error": "busy", "code": "main_busy" })),
            )
                .into_response();
        }
        if stub.check_expected {
            if let Some(expected) = manifest.get("expected").and_then(Value::as_object) {
                let stale = expected
                    .iter()
                    .filter(|(path, oid)| {
                        stub.files
                            .get(*path)
                            .map(|content| blob_oid(content))
                            .as_deref()
                            != oid.as_str()
                    })
                    .map(|(path, _)| path.clone())
                    .collect::<Vec<_>>();
                if !stale.is_empty() {
                    return (
                        StatusCode::CONFLICT,
                        Json(json!({ "error": "files changed", "code": "head_moved", "paths": stale })),
                    )
                        .into_response();
                }
            }
        }
        let file_count = archive.len();
        let bytes_written = archive.values().map(String::len).sum::<usize>();
        for (path, content) in archive {
            stub.files.insert(path, content);
        }
        let rev = advance(&mut stub);
        let committed = stub.committed.unwrap_or(true);
        (
            StatusCode::OK,
            Json(json!({
                "rev": rev,
                "committed": committed,
                "fileCount": file_count,
                "bytesWritten": bytes_written,
            })),
        )
            .into_response()
    }

    fn advance(stub: &mut StubState) -> String {
        stub.writes += 1;
        let rev = rev_for(stub.writes);
        if stub.rev.is_some() {
            stub.rev = Some(rev.clone());
        }
        rev
    }

    fn multipart_parts(content_type: &str, body: &[u8]) -> HashMap<String, Vec<u8>> {
        let boundary = content_type
            .split("boundary=")
            .nth(1)
            .expect("multipart boundary")
            .trim_matches('"');
        let delimiter = format!("--{boundary}").into_bytes();
        let mut parts = HashMap::new();
        let mut starts = Vec::new();
        let mut index = 0;
        while index + delimiter.len() <= body.len() {
            if body[index..].starts_with(&delimiter) {
                starts.push(index);
                index += delimiter.len();
            } else {
                index += 1;
            }
        }
        for window in starts.windows(2) {
            let piece = &body[window[0] + delimiter.len()..window[1]];
            let piece = piece.strip_prefix(b"\r\n").unwrap_or(piece);
            let piece = piece.strip_suffix(b"\r\n").unwrap_or(piece);
            let split = piece
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .expect("part headers");
            let head = String::from_utf8_lossy(&piece[..split]);
            let name = head
                .split("name=\"")
                .nth(1)
                .and_then(|rest| rest.split('"').next())
                .expect("part name")
                .to_string();
            parts.insert(name, piece[split + 4..].to_vec());
        }
        parts
    }

    fn unzip(bytes: &[u8]) -> BTreeMap<String, String> {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).expect("zip archive");
        let mut files = BTreeMap::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).expect("zip entry");
            let mut content = String::new();
            entry.read_to_string(&mut content).expect("UTF-8 entry");
            files.insert(entry.name().to_string(), content);
        }
        files
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{blob_oid, rev_for, start, StubState};
    use super::*;

    const DESIRED: [(&str, &str); 2] =
        [("AGENTS.md", "agents template"), ("NEW.md", "new template")];

    fn paths() -> Vec<String> {
        DESIRED.iter().map(|(path, _)| path.to_string()).collect()
    }

    /// Make every desired path hold its desired content.
    fn plan(snapshot: &OriginReadSnapshot) -> ApiResult<Vec<ProjectMemoryWriteFile>> {
        Ok(DESIRED
            .iter()
            .filter(|(path, content)| snapshot.content(path) != Some(*content))
            .map(|(path, content)| ProjectMemoryWriteFile {
                path: path.to_string(),
                content: content.to_string(),
            })
            .collect())
    }

    async fn run(
        endpoint: &str,
        origin_id: Uuid,
    ) -> (ApiResult<BootstrapWriteOutcome>, OriginReadSnapshot) {
        let http = reqwest::Client::new();
        let target = OriginBootstrapTarget {
            http: &http,
            endpoint,
            origin_id,
            project_id: Uuid::new_v4(),
        };
        let first = read_origin_snapshot(&target, "read-token", &paths())
            .await
            .expect("first read");
        let outcome = bootstrap_write_via_origin(
            &target,
            "read-token",
            "write-token",
            Uuid::new_v4(),
            &paths(),
            first.clone(),
            plan,
        )
        .await;
        (outcome, first)
    }

    fn stub_files(entries: &[(&str, &str)]) -> std::collections::BTreeMap<String, String> {
        entries
            .iter()
            .map(|(path, content)| (path.to_string(), content.to_string()))
            .collect()
    }

    #[tokio::test]
    async fn reads_are_pinned_to_one_revision_and_the_write_is_conditional() {
        let rev = rev_for(0);
        let origin = start(StubState {
            files: stub_files(&[("AGENTS.md", "older")]),
            rev: Some(rev.clone()),
            report_blobs: true,
            check_expected: true,
            ..StubState::default()
        })
        .await;

        let (outcome, first) = run(&origin.endpoint, Uuid::new_v4()).await;
        assert_eq!(first.rev.as_deref(), Some(rev.as_str()));
        let BootstrapWriteOutcome::Seeded {
            file_count,
            rev: written,
        } = outcome.expect("write")
        else {
            panic!("expected a seeded bootstrap");
        };
        assert_eq!(file_count, 2);
        assert_eq!(written, Some(rev_for(1)));

        let stub = origin.state.lock().unwrap();
        // The first read finds the revision; every later read is pinned to it.
        assert_eq!(
            stub.reads,
            vec![
                ("AGENTS.md".to_string(), None),
                ("NEW.md".to_string(), Some(rev.clone())),
            ]
        );
        assert_eq!(stub.applies.len(), 1);
        let manifest = &stub.applies[0];
        assert_eq!(manifest["baseRev"], rev.as_str());
        assert_eq!(
            manifest["expected"],
            json!({ "AGENTS.md": blob_oid("older"), "NEW.md": null })
        );
        assert_eq!(manifest["autoCommitAfterApply"], true);
        assert_eq!(stub.apply_tokens, vec!["write-token".to_string()]);
        assert_eq!(stub.files["AGENTS.md"], "agents template");
    }

    #[tokio::test]
    async fn a_conflict_is_retried_once_from_a_fresh_read() {
        let rev = rev_for(0);
        let origin = start(StubState {
            rev: Some(rev.clone()),
            report_blobs: true,
            forced_conflicts: 1,
            ..StubState::default()
        })
        .await;

        let (outcome, _) = run(&origin.endpoint, Uuid::new_v4()).await;
        assert!(matches!(
            outcome.expect("write"),
            BootstrapWriteOutcome::Seeded { file_count: 2, .. }
        ));
        let stub = origin.state.lock().unwrap();
        assert_eq!(stub.applies.len(), 2);
        // Two full read passes, each starting unpinned.
        assert_eq!(stub.reads.len(), 4);
        assert_eq!(stub.reads[0].1, None);
        assert_eq!(stub.reads[2].1, None);
        assert_eq!(stub.reads[3].1.as_deref(), Some(rev.as_str()));
    }

    #[tokio::test]
    async fn a_second_conflict_reports_workspace_busy() {
        let origin = start(StubState {
            rev: Some(rev_for(0)),
            report_blobs: true,
            forced_conflicts: 2,
            ..StubState::default()
        })
        .await;

        let (outcome, _) = run(&origin.endpoint, Uuid::new_v4()).await;
        assert!(matches!(
            outcome.expect("write"),
            BootstrapWriteOutcome::WorkspaceBusy
        ));
        let stub = origin.state.lock().unwrap();
        assert_eq!(stub.applies.len(), 2);
        assert!(stub.files.is_empty());
    }

    #[tokio::test]
    async fn the_retry_plans_from_what_the_origin_holds_now() {
        // AGENTS.md is saved after the bootstrap read it as missing. (The
        // real plan keeps a differing save: see the projects.rs test.)
        let origin = start(StubState {
            rev: Some(rev_for(0)),
            report_blobs: true,
            check_expected: true,
            concurrent_write: Some(("AGENTS.md".to_string(), "agents template".to_string())),
            ..StubState::default()
        })
        .await;

        let (outcome, _) = run(&origin.endpoint, Uuid::new_v4()).await;
        assert!(matches!(
            outcome.expect("write"),
            BootstrapWriteOutcome::Seeded { file_count: 1, .. }
        ));
        let stub = origin.state.lock().unwrap();
        assert_eq!(stub.applies.len(), 2);
        assert_eq!(
            stub.applies[0]["expected"],
            json!({ "AGENTS.md": null, "NEW.md": null })
        );
        // The re-read saw the save, so the retry no longer writes that path.
        assert_eq!(stub.applies[1]["expected"], json!({ "NEW.md": null }));
        assert_eq!(stub.applies[1]["files"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn an_origin_without_read_state_gets_the_unconditional_manifest() {
        let origin_id = Uuid::new_v4();
        let origin = start(StubState {
            files: stub_files(&[("AGENTS.md", "older")]),
            ..StubState::default()
        })
        .await;

        let (outcome, first) = run(&origin.endpoint, origin_id).await;
        assert_eq!(first.rev, None);
        assert!(matches!(
            outcome.expect("legacy write"),
            BootstrapWriteOutcome::Seeded { file_count: 2, .. }
        ));
        let stub = origin.state.lock().unwrap();
        assert!(stub.reads.iter().all(|(_, rev)| rev.is_none()));
        let manifest = &stub.applies[0];
        assert!(manifest.get("baseRev").is_none());
        assert!(manifest.get("expected").is_none());
        // Logged once per origin.
        assert!(!first_unreported_sighting(origin_id));
    }

    #[tokio::test]
    async fn blob_ids_without_a_revision_still_make_the_write_conditional() {
        // A Desktop origin reports blob ids but no revision.
        let origin = start(StubState {
            files: stub_files(&[("AGENTS.md", "older")]),
            report_blobs: true,
            check_expected: true,
            ..StubState::default()
        })
        .await;

        let (outcome, _) = run(&origin.endpoint, Uuid::new_v4()).await;
        assert!(matches!(
            outcome.expect("write"),
            BootstrapWriteOutcome::Seeded { .. }
        ));
        let stub = origin.state.lock().unwrap();
        assert!(stub.reads.iter().all(|(_, rev)| rev.is_none()));
        let manifest = &stub.applies[0];
        assert!(manifest.get("baseRev").is_none());
        assert_eq!(
            manifest["expected"],
            json!({ "AGENTS.md": blob_oid("older"), "NEW.md": null })
        );
    }

    #[tokio::test]
    async fn an_uncommitted_write_reports_already_present() {
        let origin = start(StubState {
            rev: Some(rev_for(0)),
            committed: Some(false),
            ..StubState::default()
        })
        .await;
        let (outcome, _) = run(&origin.endpoint, Uuid::new_v4()).await;
        assert!(matches!(
            outcome.expect("write"),
            BootstrapWriteOutcome::AlreadyPresent { rev: Some(_) }
        ));
    }

    #[tokio::test]
    async fn a_pinned_read_of_a_vanished_revision_is_an_error_not_a_missing_file() {
        let origin = start(StubState {
            rev: Some(rev_for(0)),
            forget_revisions: true,
            ..StubState::default()
        })
        .await;
        let http = reqwest::Client::new();
        let target = OriginBootstrapTarget {
            http: &http,
            endpoint: &origin.endpoint,
            origin_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
        };
        assert!(read_origin_snapshot(&target, "read-token", &paths())
            .await
            .is_err());
    }

    #[test]
    fn only_full_object_ids_count_as_reported_state() {
        let mut headers = reqwest::header::HeaderMap::new();
        for (value, expected) in [
            (
                "0123456789ABCDEF0123456789abcdef01234567",
                Some("0123456789abcdef0123456789abcdef01234567"),
            ),
            (
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                Some("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
            ),
            ("0123456789abcdef", None),
            ("../../etc/passwd", None),
            ("0123456789abcdef0123456789abcdef0123456g", None),
        ] {
            headers.insert(INSTAFY_REV_HEADER, value.parse().unwrap());
            assert_eq!(
                header_object_id(&headers, INSTAFY_REV_HEADER).as_deref(),
                expected,
                "{value}"
            );
        }
    }

    #[test]
    fn unreported_origins_are_logged_once() {
        let origin_id = Uuid::new_v4();
        assert!(first_unreported_sighting(origin_id));
        assert!(!first_unreported_sighting(origin_id));
        assert!(first_unreported_sighting(Uuid::new_v4()));
    }
}
