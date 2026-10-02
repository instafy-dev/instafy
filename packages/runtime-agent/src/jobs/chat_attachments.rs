//! Chat attachments kept in Storage rather than in the workspace.
//!
//! A message's Storage attachment is `<projectId>/<uuid>.<ext>` in the private
//! `chat-attachments` bucket. For a runtime that advertises
//! `attachmentDownloads`, the controller signs the ones of the leased space and
//! puts `attachment_downloads: [{name, url, sizeBytes}]` in the job payload.
//! Before the turn each one is downloaded to `.instafy/attachments/<name>`,
//! which is reserved: it is never published, and a `.gitignore` keeps it out
//! of every git status. The prompt then lists only the attachments this lease
//! signed whose file is there, and says the others are unavailable.
//!
//! A signed URL is a bearer credential: it is never logged, and a failure is
//! reported by attachment name only. Writes go through descriptor-relative,
//! no-follow handles, so a symlink planted under `.instafy/` cannot redirect
//! one out of the workspace. Each body streams into a fresh temporary file
//! that is renamed into place only once the whole download is in, so neither
//! a large attachment nor several at once are held in memory, and a partial
//! one never appears under its name.

use std::collections::HashSet;
use std::io::{self, Read};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use origin_http_server::workspace_fs::{WorkspaceDir, WorkspaceEntryKind};
use serde_json::Value as JsonValue;
use tracing::{debug, warn};
use uuid::Uuid;

pub(super) const ATTACHMENTS_DIR: &str = ".instafy/attachments";
const DOWNLOADS_PAYLOAD_KEY: &str = "attachment_downloads";
const EXTENSIONS: [&str; 6] = ["png", "jpg", "webp", "gif", "txt", "md"];
/// The bucket's own limit.
const MAX_ATTACHMENT_BYTES: u64 = 20 * 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_DOWNLOADS: usize = 20;
/// Downloads in flight at once for one job.
const MAX_CONCURRENT_DOWNLOADS: usize = 4;
/// Body chunks queued between a download and its file writer.
const WRITE_QUEUE_CHUNKS: usize = 8;
/// The controller signs the Storage attachments of the turn's message and of
/// the conversation's last this-many user messages. Older ones are not offered
/// to the agent at all.
pub(super) const HISTORY_USER_MESSAGES: usize = 10;

#[derive(Clone, Copy, Debug)]
pub(super) struct DownloadLimits {
    pub(super) max_bytes: u64,
    pub(super) timeout: Duration,
}

impl Default for DownloadLimits {
    fn default() -> Self {
        Self {
            max_bytes: MAX_ATTACHMENT_BYTES,
            timeout: DOWNLOAD_TIMEOUT,
        }
    }
}

/// `<uuid>.<ext>`: 36 characters of lowercase hex and hyphens and one of the
/// bucket's extensions, so the name has no separator, dot segment or
/// unexpected type.
pub(super) fn file_name_is_valid(name: &str) -> bool {
    let Some((stem, extension)) = name.split_once('.') else {
        return false;
    };
    is_uuid_shaped(stem) && EXTENSIONS.contains(&extension)
}

/// The file name of a `storagePath` in this job's space, or `None` for a path
/// of another shape or space. Such an attachment is never downloaded.
pub(super) fn storage_path_file_name<'a>(
    storage_path: &'a str,
    project_id: &Uuid,
) -> Option<&'a str> {
    let (space, file) = storage_path.split_once('/')?;
    (is_uuid_shaped(space) && space == project_id.to_string() && file_name_is_valid(file))
        .then_some(file)
}

fn is_uuid_shaped(value: &str) -> bool {
    value.len() == 36
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
}

fn attachment_relative_path(name: &str) -> String {
    format!("{ATTACHMENTS_DIR}/{name}")
}

/// Whether `.instafy/attachments/<name>` is a regular file, reached without
/// following a symlink.
pub(super) fn attachment_is_available(workspace_dir: &Path, name: &str) -> bool {
    file_name_is_valid(name)
        && WorkspaceDir::open(workspace_dir)
            .and_then(|workspace| workspace.entry_kind(&attachment_relative_path(name)))
            .is_ok_and(|kind| kind == WorkspaceEntryKind::File)
}

/// The attachment names this lease signed. After the pre-turn download, a
/// signed name whose file is on disk is exactly a download that succeeded or
/// a file that was already there. One the controller did not sign this time
/// (deleted by its uploader, outside the recent turns, or no Storage) is
/// unavailable, even when an earlier turn left its file behind.
pub(super) fn leased_attachment_names(payload: &JsonValue) -> HashSet<String> {
    payload
        .get(DOWNLOADS_PAYLOAD_KEY)
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .take(MAX_DOWNLOADS)
        .filter_map(|entry| entry.get("name").and_then(JsonValue::as_str))
        .filter(|name| file_name_is_valid(name))
        .map(str::to_string)
        .collect()
}

/// One signed download. No `Debug`: the URL must not reach a log.
struct SignedDownload {
    name: String,
    url: reqwest::Url,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum DownloadOutcome {
    Downloaded,
    AlreadyPresent,
    Rejected(&'static str),
    Failed(String),
}

/// Downloads the job's `attachment_downloads` into the workspace. Every
/// failure is logged by name and the turn goes on; the prompt then reports
/// that attachment as unavailable.
pub(super) async fn download_job_attachments(
    job_id: Uuid,
    payload: &JsonValue,
    workspace_dir: &Path,
) -> Vec<(String, DownloadOutcome)> {
    let Some(entries) = payload
        .get(DOWNLOADS_PAYLOAD_KEY)
        .and_then(JsonValue::as_array)
    else {
        return Vec::new();
    };
    let outcomes = download_attachments(entries, workspace_dir, DownloadLimits::default()).await;
    for (name, outcome) in &outcomes {
        match outcome {
            DownloadOutcome::Downloaded | DownloadOutcome::AlreadyPresent => {
                debug!(%job_id, attachment = %name, ?outcome, "chat attachment ready");
            }
            DownloadOutcome::Rejected(reason) => {
                warn!(%job_id, attachment = %name, reason, "chat attachment refused");
            }
            DownloadOutcome::Failed(error) => {
                warn!(%job_id, attachment = %name, %error, "chat attachment download failed");
            }
        }
    }
    outcomes
}

pub(super) async fn download_attachments(
    entries: &[JsonValue],
    workspace_dir: &Path,
    limits: DownloadLimits,
) -> Vec<(String, DownloadOutcome)> {
    let mut outcomes = Vec::new();
    let mut downloads = Vec::new();
    for entry in entries.iter().take(MAX_DOWNLOADS) {
        let name = entry
            .get("name")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string();
        if !file_name_is_valid(&name) {
            // The name is untrusted text, so only a bounded, printable form
            // of it is ever logged.
            let shown: String = name
                .chars()
                .filter(|character| !character.is_control())
                .take(64)
                .collect();
            outcomes.push((shown, DownloadOutcome::Rejected("invalid attachment name")));
            continue;
        }
        let url = entry
            .get("url")
            .and_then(JsonValue::as_str)
            .and_then(|url| reqwest::Url::parse(url).ok())
            .filter(|url| matches!(url.scheme(), "https" | "http"));
        let Some(url) = url else {
            outcomes.push((name, DownloadOutcome::Rejected("invalid download URL")));
            continue;
        };
        if downloads
            .iter()
            .any(|download: &SignedDownload| download.name == name)
        {
            continue;
        }
        downloads.push(SignedDownload { name, url });
    }
    if downloads.is_empty() {
        return outcomes;
    }

    let workspace = match prepare_attachments_dir(workspace_dir) {
        Ok(workspace) => workspace,
        Err(error) => {
            let reason = format!("attachments folder unavailable: {error}");
            outcomes.extend(
                downloads
                    .into_iter()
                    .map(|download| (download.name, DownloadOutcome::Failed(reason.clone()))),
            );
            return outcomes;
        }
    };
    // No client-wide timeout: `download_one` gives each download one deadline
    // covering the connection, the headers and the body.
    let client = match reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            let reason = format!("HTTP client unavailable: {}", error.without_url());
            outcomes.extend(
                downloads
                    .into_iter()
                    .map(|download| (download.name, DownloadOutcome::Failed(reason.clone()))),
            );
            return outcomes;
        }
    };

    let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_DOWNLOADS));
    let mut tasks = tokio::task::JoinSet::new();
    for (index, download) in downloads.into_iter().enumerate() {
        let client = client.clone();
        let workspace = workspace.clone();
        let slots = Arc::clone(&slots);
        tasks.spawn(async move {
            // The semaphore is never closed. Each download's deadline starts
            // once it has a slot, not while it waits for one.
            let _slot = slots.acquire_owned().await.ok();
            let outcome = download_one(&client, &workspace, &download, limits).await;
            (index, download.name, outcome)
        });
    }
    let mut finished = Vec::new();
    while let Some(joined) = tasks.join_next().await {
        if let Ok(result) = joined {
            finished.push(result);
        }
    }
    finished.sort_by_key(|(index, _, _)| *index);
    outcomes.extend(
        finished
            .into_iter()
            .map(|(_, name, outcome)| (name, outcome)),
    );
    outcomes
}

/// Creates `.instafy/attachments` without following symlinks, with a
/// `.gitignore` of `*` so no repository lists the downloads.
fn prepare_attachments_dir(workspace_dir: &Path) -> io::Result<WorkspaceDir> {
    let workspace = WorkspaceDir::open(workspace_dir)?;
    workspace.create_dir_all(ATTACHMENTS_DIR)?;
    let ignore = format!("{ATTACHMENTS_DIR}/.gitignore");
    match workspace.entry_kind(&ignore) {
        Ok(WorkspaceEntryKind::File) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            workspace.replace_file(&ignore, &mut b"*\n".as_slice(), false)?;
        }
        Ok(WorkspaceEntryKind::Directory) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "the attachments .gitignore is a directory",
            ));
        }
        Err(error) => return Err(error),
    }
    Ok(workspace)
}

async fn download_one(
    client: &reqwest::Client,
    workspace: &WorkspaceDir,
    download: &SignedDownload,
    limits: DownloadLimits,
) -> DownloadOutcome {
    let relative = attachment_relative_path(&download.name);
    match workspace.entry_kind(&relative) {
        Ok(WorkspaceEntryKind::File) => return DownloadOutcome::AlreadyPresent,
        Ok(WorkspaceEntryKind::Directory) => {
            return DownloadOutcome::Rejected("a directory has the attachment's name");
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        // A symlink or special file in the attachment's place.
        Err(_) => return DownloadOutcome::Rejected("the attachment's path is not a regular file"),
    }

    // One deadline covers the connection, the headers and the whole body.
    let deadline = tokio::time::Instant::now() + limits.timeout;
    let response =
        match tokio::time::timeout_at(deadline, open_download(client, &download.url, limits)).await
        {
            Ok(Ok(response)) => response,
            Ok(Err(outcome)) => return outcome,
            Err(_) => return DownloadOutcome::Failed("timed out".to_string()),
        };

    // `replace_file` writes a fresh no-follow temporary file next to the
    // attachment and renames it into place once its reader reaches the end.
    // The reader is fed from this task, so the body is never held whole.
    let (chunks, receiver) = tokio::sync::mpsc::channel(WRITE_QUEUE_CHUNKS);
    let writer = {
        let workspace = workspace.clone();
        tokio::task::spawn_blocking(move || {
            workspace.replace_file(&relative, &mut BodyReader::new(receiver), false)
        })
    };
    let streamed =
        tokio::time::timeout_at(deadline, stream_body(response, &chunks, limits.max_bytes))
            .await
            .unwrap_or_else(|_| {
                Streamed::Stopped(DownloadOutcome::Failed("timed out".to_string()))
            });
    // Without `End`, the reader fails and `replace_file` removes its
    // temporary file, so nothing partial is left behind.
    drop(chunks);
    let written = writer.await;
    match (streamed, written) {
        (Streamed::Stopped(outcome), _) => outcome,
        (_, Ok(Err(error))) => DownloadOutcome::Failed(format!("write failed: {error}")),
        (_, Err(_)) => DownloadOutcome::Failed("write task failed".to_string()),
        (Streamed::Complete, Ok(Ok(_))) => DownloadOutcome::Downloaded,
        // The writer stopped reading but reported no error.
        (Streamed::WriterStopped, Ok(Ok(_))) => {
            DownloadOutcome::Failed("write stopped early".to_string())
        }
    }
}

async fn open_download(
    client: &reqwest::Client,
    url: &reqwest::Url,
    limits: DownloadLimits,
) -> Result<reqwest::Response, DownloadOutcome> {
    // `without_url` keeps the signed URL out of every error string.
    let response = client
        .get(url.clone())
        .send()
        .await
        .map_err(|error| DownloadOutcome::Failed(error.without_url().to_string()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(DownloadOutcome::Failed(format!(
            "download returned {status}"
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > limits.max_bytes)
    {
        return Err(DownloadOutcome::Rejected(
            "larger than the attachment limit",
        ));
    }
    Ok(response)
}

/// What a download's body did on its way to the file writer.
enum Streamed {
    /// Every chunk and the end marker were handed over.
    Complete,
    /// The writer stopped reading first; its own result says why.
    WriterStopped,
    /// The download failed or broke the cap; the writer is told nothing more.
    Stopped(DownloadOutcome),
}

enum BodyChunk {
    Bytes(Vec<u8>),
    End,
}

async fn stream_body(
    mut response: reqwest::Response,
    chunks: &tokio::sync::mpsc::Sender<BodyChunk>,
    max_bytes: u64,
) -> Streamed {
    let mut received: u64 = 0;
    loop {
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                return Streamed::Stopped(DownloadOutcome::Failed(error.without_url().to_string()));
            }
        };
        received += chunk.len() as u64;
        if received > max_bytes {
            return Streamed::Stopped(DownloadOutcome::Rejected(
                "larger than the attachment limit",
            ));
        }
        if chunks.send(BodyChunk::Bytes(chunk.to_vec())).await.is_err() {
            return Streamed::WriterStopped;
        }
    }
    if chunks.send(BodyChunk::End).await.is_err() {
        return Streamed::WriterStopped;
    }
    Streamed::Complete
}

/// The blocking side of a download: reads the chunks its task sends and ends
/// only at the explicit end marker. A sender dropped without one, after a
/// failure, a breach of the cap or a timeout, is an error, so `replace_file`
/// discards the temporary file instead of renaming a truncated body into
/// place.
struct BodyReader {
    receiver: tokio::sync::mpsc::Receiver<BodyChunk>,
    current: Vec<u8>,
    offset: usize,
    ended: bool,
}

impl BodyReader {
    fn new(receiver: tokio::sync::mpsc::Receiver<BodyChunk>) -> Self {
        Self {
            receiver,
            current: Vec::new(),
            offset: 0,
            ended: false,
        }
    }
}

impl Read for BodyReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.offset < self.current.len() {
                let count = buffer.len().min(self.current.len() - self.offset);
                buffer[..count].copy_from_slice(&self.current[self.offset..self.offset + count]);
                self.offset += count;
                return Ok(count);
            }
            if self.ended {
                return Ok(0);
            }
            match self.receiver.blocking_recv() {
                Some(BodyChunk::Bytes(bytes)) => {
                    self.current = bytes;
                    self.offset = 0;
                }
                Some(BodyChunk::End) => self.ended = true,
                None => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "the download stopped before it completed",
                    ));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Body;
    use axum::extract::Path as AxumPath;
    use axum::http::{StatusCode, header};
    use axum::response::{IntoResponse, Response};
    use axum::routing::get;
    use serde_json::json;

    const STEM: &str = "6a000000-0000-4000-8000-000000000001";
    const PROJECT: &str = "11111111-1111-4111-8111-111111111111";

    fn name(n: u32, extension: &str) -> String {
        format!("6a000000-0000-4000-8000-{n:012}.{extension}")
    }

    async fn serve() -> String {
        async fn object(AxumPath(object): AxumPath<String>) -> Response {
            match object.as_str() {
                "big" => vec![b'x'; 2048].into_response(),
                "chunked-big" => {
                    // No Content-Length: the cap must hold while streaming.
                    let chunks = (0..4).map(|_| Ok::<_, std::io::Error>(vec![b'y'; 1024]));
                    Response::builder()
                        .body(Body::from_stream(futures_util::stream::iter(chunks)))
                        .unwrap()
                }
                "chunked-ok" => {
                    let chunks = (0..3).map(|n| Ok::<_, std::io::Error>(vec![b'a' + n; 300]));
                    Response::builder()
                        .body(Body::from_stream(futures_util::stream::iter(chunks)))
                        .unwrap()
                }
                "stalled" => {
                    // Headers and a first chunk, then nothing until the
                    // download's deadline has passed.
                    let first =
                        futures_util::stream::iter([Ok::<_, std::io::Error>(vec![b'z'; 100])]);
                    let rest = futures_util::stream::once(async {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        Ok::<_, std::io::Error>(vec![b'z'; 100])
                    });
                    Response::builder()
                        .body(Body::from_stream(futures_util::StreamExt::chain(
                            first, rest,
                        )))
                        .unwrap()
                }
                "slow" => {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    "late".into_response()
                }
                "missing" => StatusCode::NOT_FOUND.into_response(),
                "redirect" => (
                    StatusCode::FOUND,
                    [(header::LOCATION, "http://127.0.0.1:9/elsewhere")],
                )
                    .into_response(),
                other => format!("bytes of {other}").into_response(),
            }
        }
        let app = Router::new().route("/object/:object", get(object));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        base
    }

    fn entry(name: &str, base: &str, object: &str) -> JsonValue {
        json!({ "name": name, "url": format!("{base}/object/{object}?token=secret"), "sizeBytes": 10 })
    }

    fn limits() -> DownloadLimits {
        DownloadLimits {
            max_bytes: 1024,
            timeout: Duration::from_millis(500),
        }
    }

    #[test]
    fn names_are_checked_without_the_space_segment() {
        let project = Uuid::parse_str(PROJECT).unwrap();
        assert!(file_name_is_valid(&format!("{STEM}.png")));
        for bad in [
            "../escape.png".to_string(),
            format!("{STEM}.png/../x"),
            format!("{STEM}.svg"),
            format!("{STEM}.PNG"),
            format!("{STEM}.png.txt"),
            ".gitignore".to_string(),
            format!("sub/{STEM}.png"),
            String::new(),
        ] {
            assert!(!file_name_is_valid(&bad), "{bad:?} must be refused");
        }
        assert_eq!(
            storage_path_file_name(&format!("{PROJECT}/{STEM}.md"), &project),
            Some(format!("{STEM}.md").as_str())
        );
        assert_eq!(
            storage_path_file_name(
                &format!("22222222-2222-4222-8222-222222222222/{STEM}.md"),
                &project
            ),
            None
        );
        assert_eq!(
            storage_path_file_name(&format!("{PROJECT}/../{STEM}.md"), &project),
            None
        );
    }

    #[tokio::test]
    async fn downloads_land_at_the_derived_path_and_are_ignored_by_git() {
        let base = serve().await;
        let workspace = tempfile::tempdir().unwrap();
        let entries = vec![
            entry(&name(1, "png"), &base, "first"),
            entry(&name(2, "md"), &base, "second"),
        ];
        let outcomes = download_attachments(&entries, workspace.path(), limits()).await;
        assert_eq!(
            outcomes,
            vec![
                (name(1, "png"), DownloadOutcome::Downloaded),
                (name(2, "md"), DownloadOutcome::Downloaded),
            ]
        );
        let dir = workspace.path().join(ATTACHMENTS_DIR);
        assert_eq!(
            std::fs::read(dir.join(name(1, "png"))).unwrap(),
            b"bytes of first"
        );
        assert_eq!(
            std::fs::read(dir.join(name(2, "md"))).unwrap(),
            b"bytes of second"
        );
        assert_eq!(std::fs::read(dir.join(".gitignore")).unwrap(), b"*\n");
        assert!(attachment_is_available(workspace.path(), &name(1, "png")));
        assert!(!attachment_is_available(workspace.path(), &name(3, "png")));

        // The runtime image always has git; so must this test.
        let git = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(workspace.path())
            .status()
            .expect("git is required for this test");
        assert!(git.success(), "git init failed");
        let status = std::process::Command::new("git")
            .args(["status", "--porcelain", "--untracked-files=all"])
            .current_dir(workspace.path())
            .output()
            .unwrap();
        assert!(status.status.success(), "git status failed");
        assert_eq!(String::from_utf8_lossy(&status.stdout), "");
    }

    /// Only the attachments folder's own `.gitignore` and the named files:
    /// no temporary file of a download that failed.
    fn attachment_dir_entries(workspace: &Path) -> Vec<String> {
        let mut entries: Vec<String> = std::fs::read_dir(workspace.join(ATTACHMENTS_DIR))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        entries.sort();
        entries
    }

    #[tokio::test]
    async fn a_body_in_many_chunks_is_written_whole() {
        let base = serve().await;
        let workspace = tempfile::tempdir().unwrap();
        let outcomes = download_attachments(
            &[entry(&name(1, "txt"), &base, "chunked-ok")],
            workspace.path(),
            limits(),
        )
        .await;
        assert_eq!(
            outcomes,
            vec![(name(1, "txt"), DownloadOutcome::Downloaded)]
        );
        let mut expected = vec![b'a'; 300];
        expected.extend([b'b'; 300]);
        expected.extend([b'c'; 300]);
        assert_eq!(
            std::fs::read(workspace.path().join(ATTACHMENTS_DIR).join(name(1, "txt"))).unwrap(),
            expected
        );
        assert_eq!(
            attachment_dir_entries(workspace.path()),
            vec![".gitignore".to_string(), name(1, "txt")]
        );
    }

    #[tokio::test]
    async fn at_most_four_downloads_run_at_once() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        #[derive(Clone, Default)]
        struct InFlight {
            now: Arc<AtomicUsize>,
            most: Arc<AtomicUsize>,
            served: Arc<AtomicUsize>,
        }
        async fn object(
            axum::extract::State(in_flight): axum::extract::State<InFlight>,
        ) -> &'static str {
            let now = in_flight.now.fetch_add(1, Ordering::SeqCst) + 1;
            in_flight.most.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(Duration::from_millis(150)).await;
            in_flight.now.fetch_sub(1, Ordering::SeqCst);
            in_flight.served.fetch_add(1, Ordering::SeqCst);
            "bytes"
        }
        let in_flight = InFlight::default();
        let app = Router::new()
            .route("/object/:object", get(object))
            .with_state(in_flight.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let workspace = tempfile::tempdir().unwrap();
        let entries: Vec<JsonValue> = (1..=10)
            .map(|n| entry(&name(n, "png"), &base, "counted"))
            .collect();
        let outcomes = download_attachments(
            &entries,
            workspace.path(),
            DownloadLimits {
                max_bytes: 1024,
                timeout: Duration::from_secs(5),
            },
        )
        .await;
        assert!(
            outcomes
                .iter()
                .all(|(_, outcome)| *outcome == DownloadOutcome::Downloaded),
            "{outcomes:?}"
        );
        assert_eq!(in_flight.served.load(Ordering::SeqCst), 10);
        let most = in_flight.most.load(Ordering::SeqCst);
        assert!((2..=4).contains(&most), "{most} downloads ran at once");
    }

    #[tokio::test]
    async fn existing_files_are_kept_and_not_downloaded_again() {
        let base = serve().await;
        let workspace = tempfile::tempdir().unwrap();
        let dir = workspace.path().join(ATTACHMENTS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name(1, "png")), b"kept").unwrap();
        let outcomes = download_attachments(
            &[entry(&name(1, "png"), &base, "first")],
            workspace.path(),
            limits(),
        )
        .await;
        assert_eq!(
            outcomes,
            vec![(name(1, "png"), DownloadOutcome::AlreadyPresent)]
        );
        assert_eq!(std::fs::read(dir.join(name(1, "png"))).unwrap(), b"kept");
    }

    #[tokio::test]
    async fn traversal_odd_names_and_bad_urls_are_refused() {
        let base = serve().await;
        let workspace = tempfile::tempdir().unwrap();
        let entries = vec![
            entry("../../escape.png", &base, "first"),
            entry(&format!("{STEM}.sh"), &base, "first"),
            entry(".gitignore", &base, "first"),
            json!({ "name": name(4, "png"), "url": "file:///etc/passwd" }),
            json!({ "name": name(5, "png") }),
        ];
        let outcomes = download_attachments(&entries, workspace.path(), limits()).await;
        assert_eq!(
            outcomes,
            vec![
                (
                    "../../escape.png".to_string(),
                    DownloadOutcome::Rejected("invalid attachment name")
                ),
                (
                    format!("{STEM}.sh"),
                    DownloadOutcome::Rejected("invalid attachment name")
                ),
                (
                    ".gitignore".to_string(),
                    DownloadOutcome::Rejected("invalid attachment name")
                ),
                (
                    name(4, "png"),
                    DownloadOutcome::Rejected("invalid download URL")
                ),
                (
                    name(5, "png"),
                    DownloadOutcome::Rejected("invalid download URL")
                ),
            ]
        );
        assert!(!workspace.path().join("escape.png").exists());
        assert!(!workspace.path().join(ATTACHMENTS_DIR).exists());
    }

    #[tokio::test]
    async fn the_size_cap_and_timeout_are_enforced() {
        let base = serve().await;
        let workspace = tempfile::tempdir().unwrap();
        let entries = vec![
            entry(&name(1, "png"), &base, "big"),
            entry(&name(2, "png"), &base, "chunked-big"),
            entry(&name(3, "png"), &base, "slow"),
            entry(&name(4, "png"), &base, "missing"),
            entry(&name(5, "png"), &base, "redirect"),
            entry(&name(6, "png"), &base, "stalled"),
        ];
        let outcomes = download_attachments(&entries, workspace.path(), limits()).await;
        assert_eq!(
            outcomes[0].1,
            DownloadOutcome::Rejected("larger than the attachment limit")
        );
        assert_eq!(
            outcomes[1].1,
            DownloadOutcome::Rejected("larger than the attachment limit")
        );
        assert_eq!(
            outcomes[2].1,
            DownloadOutcome::Failed("timed out".to_string())
        );
        assert_eq!(
            outcomes[3].1,
            DownloadOutcome::Failed("download returned 404 Not Found".to_string())
        );
        assert_eq!(
            outcomes[4].1,
            DownloadOutcome::Failed("download returned 302 Found".to_string())
        );
        // The deadline covers the body too, not only the headers.
        assert_eq!(
            outcomes[5].1,
            DownloadOutcome::Failed("timed out".to_string())
        );
        for (_, outcome) in &outcomes {
            if let DownloadOutcome::Failed(error) = outcome {
                assert!(!error.contains("token=secret"), "{error}");
                assert!(!error.contains("/object/"), "{error}");
            }
        }
        for n in 1..=6 {
            assert!(!attachment_is_available(workspace.path(), &name(n, "png")));
        }
        // The body that broke the cap and the one that stalled had started
        // writing; neither left a partial or temporary file behind.
        assert_eq!(
            attachment_dir_entries(workspace.path()),
            vec![".gitignore".to_string()]
        );
    }

    fn prompt_section(
        attachments: JsonValue,
        workspace: &Path,
        leased: &[String],
    ) -> Option<String> {
        super::super::format_image_attachment_section_from_attachments(
            attachments.as_array().unwrap(),
            workspace,
            &Uuid::parse_str(PROJECT).unwrap(),
            &leased.iter().cloned().collect(),
        )
    }

    #[test]
    fn legacy_workspace_images_keep_their_prompt() {
        let workspace = tempfile::tempdir().unwrap();
        let section = prompt_section(
            json!([{ "kind": "image", "workspacePath": "chat-upload-1-photo.png",
                "fileName": "photo.png", "mimeType": "image/png", "sizeBytes": 10 }]),
            workspace.path(),
            &[],
        )
        .unwrap();
        assert_eq!(
            section,
            format!(
                "\nUser attached image(s):\n\
                 - workspacePath: chat-upload-1-photo.png (fileName: photo.png, mimeType: image/png, sizeBytes: 10)\n\
                 \nPaths above are relative to the workspace root \"{}\".\n\
                 Before answering, call the `view_image` tool on the image path(s), then respond to the latest request.\n\
                 When calling `view_image`, use the `workspacePath` value (not the fileName).\n\
                 If you cannot view the image for any reason, do your best using the filename/path context.\n",
                workspace.path().display()
            )
        );
    }

    #[test]
    fn storage_attachments_are_listed_only_once_downloaded() {
        let workspace = tempfile::tempdir().unwrap();
        let dir = workspace.path().join(ATTACHMENTS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name(1, "png")), b"png").unwrap();
        std::fs::write(dir.join(name(2, "md")), b"# notes").unwrap();
        // The same file name under another space: present on disk, but the
        // controller never signs it, so it is not this message's attachment.
        std::fs::write(dir.join(name(3, "png")), b"png").unwrap();
        // Signed, but its download failed: name(4) is not on disk.
        let leased = [name(1, "png"), name(2, "md"), name(4, "png")];
        let section = prompt_section(
            json!([
                { "kind": "image", "storagePath": format!("{PROJECT}/{}", name(1, "png")),
                  "fileName": "photo.png", "mimeType": "image/png", "sizeBytes": 3 },
                { "kind": "file", "storagePath": format!("{PROJECT}/{}", name(2, "md")),
                  "fileName": "notes.md", "mimeType": "text/markdown" },
                { "kind": "image", "storagePath": format!("{PROJECT}/{}", name(4, "png")),
                  "fileName": "missing.png" },
                { "kind": "image",
                  "storagePath": format!("22222222-2222-4222-8222-222222222222/{}", name(3, "png")),
                  "fileName": "other-space.png" },
                { "kind": "file", "storagePath": format!("{PROJECT}/../{}", name(5, "md")) },
            ]),
            workspace.path(),
            &leased,
        )
        .unwrap();
        assert!(
            section.starts_with("\nUser attached file(s):\n"),
            "{section}"
        );
        assert!(section.contains(&format!(
            "- workspacePath: .instafy/attachments/{} (fileName: photo.png, mimeType: image/png, sizeBytes: 3)\n",
            name(1, "png")
        )));
        assert!(section.contains(&format!(
            "- workspacePath: .instafy/attachments/{} (fileName: notes.md, mimeType: text/markdown)\n",
            name(2, "md")
        )));
        assert!(section.contains("call the `view_image` tool"));
        assert!(section.contains("Read the attached text file(s)"));
        assert!(section.contains(
            "not available in this workspace:\n- missing.png\n- other-space.png\n- a text file\n"
        ));
        assert!(!section.contains(&name(3, "png")));
        assert!(!section.contains(&name(4, "png")));
        assert!(!section.contains("22222222"));
    }

    #[test]
    fn a_file_an_earlier_turn_left_is_unavailable_unless_this_lease_signed_it() {
        // The uploader deleted the object, or the controller has no Storage:
        // nothing was signed, so the copy on disk is not offered to the agent.
        let workspace = tempfile::tempdir().unwrap();
        let dir = workspace.path().join(ATTACHMENTS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(name(1, "png")), b"png").unwrap();
        let attachments = json!([{ "kind": "image",
            "storagePath": format!("{PROJECT}/{}", name(1, "png")), "fileName": "deleted.png" }]);

        let section = prompt_section(attachments.clone(), workspace.path(), &[]).unwrap();
        assert!(!section.contains(&name(1, "png")), "{section}");
        assert!(!section.contains("view_image"), "{section}");
        assert!(
            section.contains("not available in this workspace:\n- deleted.png\n"),
            "{section}"
        );

        let section = prompt_section(attachments, workspace.path(), &[name(1, "png")]).unwrap();
        assert!(section.contains(&format!(
            "- workspacePath: .instafy/attachments/{} (fileName: deleted.png)\n",
            name(1, "png")
        )));
    }

    #[test]
    fn leased_names_are_the_valid_names_of_the_payloads_downloads() {
        let payload = json!({ DOWNLOADS_PAYLOAD_KEY: [
            { "name": name(1, "png"), "url": "https://storage.invalid/a" },
            { "name": "../escape.png", "url": "https://storage.invalid/b" },
            { "url": "https://storage.invalid/c" },
            { "name": name(2, "md") },
        ]});
        let mut leased: Vec<String> = leased_attachment_names(&payload).into_iter().collect();
        leased.sort();
        assert_eq!(leased, vec![name(1, "png"), name(2, "md")]);
        assert!(leased_attachment_names(&json!({ "prompt_text": "hi" })).is_empty());
    }

    #[test]
    fn nothing_downloaded_means_no_path_and_no_view_image_instruction() {
        let workspace = tempfile::tempdir().unwrap();
        let section = prompt_section(
            json!([{ "kind": "image", "storagePath": format!("{PROJECT}/{}", name(1, "png")),
                "fileName": "photo.png" }]),
            workspace.path(),
            &[name(1, "png")],
        )
        .unwrap();
        assert_eq!(
            section,
            "\nThe user also attached file(s) that are not available in this workspace:\n\
             - photo.png\n\
             You cannot open these. If the answer depends on one, say that it could not be loaded and ask the user to attach it again.\n"
        );
    }

    #[test]
    fn history_collects_storage_and_legacy_attachments_once() {
        let history = json!([
            { "role": "user", "metadata": { "attachments": [
                { "kind": "image", "workspacePath": "chat-upload-1.png" },
                { "kind": "image", "storagePath": format!("{PROJECT}/{}", name(1, "png")) },
            ]}},
            { "role": "user", "metadata": { "promptMetadata": { "attachments": [
                { "kind": "file", "storagePath": format!("{PROJECT}/{}", name(1, "png")) },
                { "kind": "file", "storagePath": format!("{PROJECT}/{}", name(2, "txt")) },
                { "kind": "video", "storagePath": format!("{PROJECT}/{}", name(3, "png")) },
                { "kind": "file", "workspacePath": "notes.txt" },
            ]}}},
        ]);
        let collected = super::super::collect_image_attachments_from_history(Some(&history));
        let keys: Vec<String> = collected
            .iter()
            .filter_map(|entry| super::super::attachment_identity(entry.as_object().unwrap()))
            .collect();
        assert_eq!(
            keys,
            vec![
                "chat-upload-1.png".to_string(),
                format!("{PROJECT}/{}", name(1, "png")),
                format!("{PROJECT}/{}", name(2, "txt")),
            ]
        );
    }

    #[test]
    fn history_offers_storage_attachments_only_from_the_signed_user_messages() {
        let mut history = vec![json!({ "role": "user", "metadata": { "attachments": [
            { "kind": "image", "workspacePath": "chat-upload-old.png" },
        ]}})];
        // Twelve user messages with a Storage attachment each, oldest first.
        for n in 1..=12 {
            history.push(json!({ "role": "user", "metadata": { "attachments": [
                { "kind": "image", "storagePath": format!("{PROJECT}/{}", name(n, "png")) },
            ]}}));
        }
        // An assistant row is never a user's attachment.
        history.push(json!({ "role": "assistant", "metadata": { "attachments": [
            { "kind": "image", "storagePath": format!("{PROJECT}/{}", name(99, "png")) },
        ]}}));
        let collected =
            super::super::collect_image_attachments_from_history(Some(&JsonValue::Array(history)));
        let keys: Vec<String> = collected
            .iter()
            .filter_map(|entry| super::super::attachment_identity(entry.as_object().unwrap()))
            .collect();
        let mut expected = vec!["chat-upload-old.png".to_string()];
        expected.extend((3..=12).map(|n| format!("{PROJECT}/{}", name(n, "png"))));
        assert_eq!(keys, expected);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn symlinks_are_never_followed() {
        let base = serve().await;
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();

        // `.instafy` itself points outside the workspace.
        std::os::unix::fs::symlink(outside.path(), workspace.path().join(".instafy")).unwrap();
        let outcomes = download_attachments(
            &[entry(&name(1, "png"), &base, "first")],
            workspace.path(),
            limits(),
        )
        .await;
        assert!(matches!(outcomes[0].1, DownloadOutcome::Failed(_)));
        assert_eq!(std::fs::read_dir(outside.path()).unwrap().count(), 0);
        std::fs::remove_file(workspace.path().join(".instafy")).unwrap();

        // A planted link in the attachment's place is refused and left alone.
        let dir = workspace.path().join(ATTACHMENTS_DIR);
        std::fs::create_dir_all(&dir).unwrap();
        let target = outside.path().join("target.png");
        std::fs::write(&target, b"outside").unwrap();
        std::os::unix::fs::symlink(&target, dir.join(name(2, "png"))).unwrap();
        let outcomes = download_attachments(
            &[entry(&name(2, "png"), &base, "second")],
            workspace.path(),
            limits(),
        )
        .await;
        assert_eq!(
            outcomes,
            vec![(
                name(2, "png"),
                DownloadOutcome::Rejected("the attachment's path is not a regular file")
            )]
        );
        assert_eq!(std::fs::read(&target).unwrap(), b"outside");
        assert!(!attachment_is_available(workspace.path(), &name(2, "png")));
    }
}
