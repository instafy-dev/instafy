//! A turn that changed the site behind an open preview ends with a new
//! picture on the preview's card.
//!
//! Octo checks a site after it changes it (`instafy preview check`), and that
//! check takes the card's picture again. A turn that stops before its check
//! leaves the card with the picture from before the change: a map opened
//! early keeps its blank starter, with none of the places added after it.
//! So while a turn's changes are saved, each preview this machine has open
//! for the space whose site the turn changed after it was last pictured is
//! checked once more, at the size its picture comes from (`instafy preview
//! check --desktop`). The reply does not wait for it: the check goes on after
//! the reply is posted, and the card's picture changes in place once it is
//! sent (the controller announces `preview.thumbnail_updated`). The check
//! keeps the picture in a file (`--picture-to`), and this runtime sends it with
//! its own credential, which still works once the turn has ended (the turn's
//! own ends with it). The check is given no credential at all: it goes on
//! while the next turn may run, another member's with other granted secrets,
//! and any process here can read another's environment, so it gets only what
//! a helper that outlives a turn may have and the settings it reads
//! ([`PREVIEW_CHECK_ENV_KEYS`]). A picture is not sent once a newer one was
//! taken (the next turn's own check records its time before it sends), and a
//! turn that is stopped, or whose changes could not be saved, stops it.
//!
//! `instafy preview open` records each preview in the CLI's state file
//! (`~/.instafy/cli-preview-state.json`): its id, port and path, the folder its
//! site's server runs from (`siteDir`), when the site was last pictured for
//! the card (`pictureAt`, milliseconds since the epoch, whether or not a
//! picture came of it) and whether it was opened with `--no-thumbnail`. A
//! preview without a recorded folder, or opened with `--no-thumbnail`, is
//! left alone; one without a picture time counts every change as newer.

use std::ffi::OsString;
use std::future::Future;
use std::path::{Component, Path};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde_json::Value as JsonValue;
use tokio::process::Command;
use tokio::task::JoinHandle;
use tracing::{info, warn};
use uuid::Uuid;

use super::CodexFileDescriptor;
use crate::browser_host::process::group;
use crate::job_cancel::JobCancelSignal;
use crate::model_environment::{PREVIEW_CHECK_ENV_KEYS, allowlisted_environment};

/// The CLI's record of the previews it opened on this machine, under `HOME`.
const PREVIEW_STATE_RELATIVE_PATH: &str = ".instafy/cli-preview-state.json";
/// At most this many previews are checked when one turn ends.
const MAX_CHECKS: usize = 3;
/// The page load limit each check gets (the CLI's own default is 30 s).
const CHECK_PAGE_LOAD_TIMEOUT_MS: &str = "10000";
/// How long the checks of one turn's end may take in all, pictures sent
/// included. The reply does not wait for them.
const CHECKS_TIMEOUT: Duration = Duration::from_secs(30);
/// A check starts only with this much of `CHECKS_TIMEOUT` left: one that
/// could not finish would take no picture.
const CHECK_MIN_TIME: Duration = Duration::from_secs(15);
/// How long sending one picture may take.
const SEND_TIMEOUT: Duration = Duration::from_secs(15);
/// The name of the picture a check keeps in its folder; what the card needs
/// beside it is in the same name with `.json` added.
const PICTURE_FILE: &str = "card.jpg";
/// The largest picture a card takes, as the controller keeps it.
const MAX_PICTURE_BYTES: u64 = 512 * 1024;
/// What the check writes beside the picture is small.
const MAX_PICTURE_FACTS_BYTES: u64 = 16 * 1024;

/// One open preview whose card's picture is older than a change this turn
/// made to its site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StalePicture {
    pub(super) preview_id: String,
    pub(super) port: u16,
    pub(super) path: String,
}

/// A picture for a preview's card, as a check took it: a JPEG, and the page's
/// own description, which the card's facts line may show.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CardPicture {
    pub(crate) image: Vec<u8>,
    pub(crate) description: Option<String>,
}

/// Whether a picture is still the newest of its preview: false once a newer
/// one was taken, so it is not sent (again).
pub(crate) type StillNewest<'a> = &'a (dyn Fn() -> bool + Send + Sync);

/// Sends a picture to its preview's card with this runtime's own credential
/// (the controller takes a preview's picture only from the runtime that
/// serves it), while `still_newest` says it is the newest: a send tried again
/// after a credential renewal asks once more. [`crate::controller::ControllerClient`]
/// is the one in use.
pub(crate) trait PictureSender: Send + Sync {
    fn send<'a>(
        &'a self,
        project_id: Uuid,
        preview_id: &'a str,
        picture: &'a CardPicture,
        still_newest: StillNewest<'a>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>>;
}

impl PictureSender for crate::controller::ControllerClient {
    fn send<'a>(
        &'a self,
        project_id: Uuid,
        preview_id: &'a str,
        picture: &'a CardPicture,
        still_newest: StillNewest<'a>,
    ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>> {
        Box::pin(self.upload_preview_picture(
            project_id,
            preview_id,
            &picture.image,
            picture.description.as_deref(),
            still_newest,
        ))
    }
}

/// A preview id as the CLI records it, safe to put in an address: letters,
/// digits, `-` and `_`, at most 128 of them.
pub(crate) fn is_preview_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// The workspace paths a turn changed (created, changed or removed), not the
/// files it only read.
pub(super) fn changed_paths(files: &[CodexFileDescriptor]) -> Vec<String> {
    let mut paths: Vec<String> = files
        .iter()
        .filter(|file| !file.is_read_reference())
        .map(|file| {
            if file.workspace_path.trim().is_empty() {
                file.path.clone()
            } else {
                file.workspace_path.clone()
            }
        })
        .map(|path| path.trim().trim_start_matches("./").to_string())
        .filter(|path| {
            !path.is_empty()
                && Path::new(path)
                    .components()
                    .all(|component| matches!(component, Component::Normal(_)))
        })
        .collect();
    paths.sort();
    paths.dedup();
    paths
}

/// The previews in `state` (the CLI's state file) that this machine has open
/// for `project_id`, with a tunnel client still running and a picture on
/// their card, whose site folder holds a path in `changed` that changed
/// after the site was last pictured. A changed path is a site's when no other
/// site of the space has a folder inside that site's that holds it: a site
/// served from the workspace itself (a server started there that serves a
/// folder of it) is not pictured again for a change in the folder of another
/// open preview, though any other change in the workspace still counts for it.
pub(super) fn stale_pictures(
    state: &JsonValue,
    project_id: &Uuid,
    workspace_dir: &Path,
    changed: &[String],
    client_runs: impl Fn(i64) -> bool,
) -> Vec<StalePicture> {
    if changed.is_empty() {
        return Vec::new();
    }
    let Some(previews) = state.get("previews").and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    let project = project_id.to_string();
    let site_dirs: Vec<&str> = previews
        .iter()
        .filter(|entry| {
            entry.get("projectId").and_then(JsonValue::as_str) == Some(project.as_str())
        })
        .filter_map(|entry| entry.get("siteDir").and_then(JsonValue::as_str))
        .collect();
    let mut stale: Vec<StalePicture> = Vec::new();
    for entry in previews {
        if entry.get("projectId").and_then(JsonValue::as_str) != Some(project.as_str()) {
            continue;
        }
        // Opened with `--no-thumbnail`: its card has no picture of the site.
        if entry.get("noThumbnail").and_then(JsonValue::as_bool) == Some(true) {
            continue;
        }
        // Without its folder, any change in the workspace could be the
        // site's: every turn that changed a file would hold up its reply.
        let Some(site_dir) = entry.get("siteDir").and_then(JsonValue::as_str) else {
            continue;
        };
        let Some(pid) = entry.get("pid").and_then(JsonValue::as_i64) else {
            continue;
        };
        let Some(port) = entry
            .get("localPort")
            .and_then(JsonValue::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port > 0)
        else {
            continue;
        };
        // The picture is sent to the card by the preview's id.
        let Some(preview_id) = entry
            .get("previewId")
            .and_then(JsonValue::as_str)
            .filter(|id| is_preview_id(id))
        else {
            continue;
        };
        let path = entry
            .get("path")
            .and_then(JsonValue::as_str)
            .filter(|path| path.starts_with('/'))
            .unwrap_or("/")
            .to_string();
        if stale
            .iter()
            .any(|seen| seen.port == port && seen.path == path)
        {
            continue;
        }
        let picture_at = entry.get("pictureAt").and_then(JsonValue::as_f64);
        let site_changed = changed
            .iter()
            .filter(|changed| {
                in_site(changed, site_dir) && !in_site_inside(changed, site_dir, &site_dirs)
            })
            .any(|changed| changed_after(workspace_dir, changed, picture_at));
        // Only a preview whose tunnel still runs can take a new picture.
        if site_changed && client_runs(pid) {
            stale.push(StalePicture {
                preview_id: preview_id.to_string(),
                port,
                path,
            });
        }
        if stale.len() == MAX_CHECKS {
            break;
        }
    }
    stale
}

/// A site's folder as the workspace path it names: `.` for the workspace.
fn site_folder(site_dir: &str) -> &str {
    let site = site_dir
        .trim()
        .trim_start_matches("./")
        .trim_end_matches('/');
    if site.is_empty() { "." } else { site }
}

/// Whether `inner` is the workspace path `outer` or a path under it. Every
/// path is under the workspace itself (`.`).
fn path_under(outer: &str, inner: &str) -> bool {
    outer == "."
        || inner == outer
        || inner
            .strip_prefix(outer)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Whether a changed workspace path is in a site's folder: the folder itself,
/// a path under it, or a folder that holds it. Every path is when the folder
/// is the whole workspace.
fn in_site(changed: &str, site_dir: &str) -> bool {
    let site = site_folder(site_dir);
    let changed = changed.trim_end_matches('/');
    path_under(site, changed) || (site != "." && path_under(changed, site))
}

/// Whether a changed path is in the folder of another site that is inside
/// this site's folder (one of `site_dirs`, every site folder of the space):
/// then it is that site's change, not this one's.
fn in_site_inside(changed: &str, site_dir: &str, site_dirs: &[&str]) -> bool {
    let site = site_folder(site_dir);
    let changed = changed.trim_end_matches('/');
    site_dirs
        .iter()
        .map(|other| site_folder(other))
        .any(|other| other != site && path_under(site, other) && path_under(other, changed))
}

/// Whether a changed path changed after the site was last pictured: it was
/// written at or after that time, it is gone (a removal), it is a folder, or
/// there is no picture time.
fn changed_after(workspace_dir: &Path, changed: &str, picture_at: Option<f64>) -> bool {
    let Some(picture_at) = picture_at else {
        return true;
    };
    let Ok(metadata) = std::fs::symlink_metadata(workspace_dir.join(changed)) else {
        return true;
    };
    if metadata.is_dir() {
        return true;
    }
    let Some(modified_ms) = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|since| since.as_millis() as f64)
    else {
        return true;
    };
    modified_ms >= picture_at.floor()
}

#[cfg(unix)]
fn client_runs(pid: i64) -> bool {
    if pid <= 0 || pid > i64::from(i32::MAX) {
        return false;
    }
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn client_runs(_pid: i64) -> bool {
    true
}

/// How long the checks of one turn's end may take in all, and how much of it
/// must be left for another check to start.
#[derive(Debug, Clone, Copy)]
struct Budget {
    total: Duration,
    min_left: Duration,
}

const BUDGET: Budget = Budget {
    total: CHECKS_TIMEOUT,
    min_left: CHECK_MIN_TIME,
};

/// The checks that take new pictures for the previews a turn changed. They
/// start while the turn's changes are saved, and go on after its reply
/// ([`PictureRetake::detach`]); dropping the retake before that (a save that
/// failed, a lease that was lost) stops them, with everything they started.
pub(super) struct PictureRetake {
    task: Option<JoinHandle<()>>,
}

impl PictureRetake {
    /// Starts checking each open preview whose site the turn changed (`files`,
    /// as the turn's save lists them) after it was last pictured. A read-only
    /// turn changed nothing, and starts nothing; nor does one with nothing to
    /// send the pictures with (`sender`).
    pub(super) fn start(
        workspace_dir: &Path,
        project_id: Uuid,
        read_only: bool,
        files: &[CodexFileDescriptor],
        cancel: Option<JobCancelSignal>,
        sender: Option<Arc<dyn PictureSender>>,
    ) -> Self {
        let changed = if read_only {
            Vec::new()
        } else {
            changed_paths(files)
        };
        let Some(sender) = sender.filter(|_| !changed.is_empty()) else {
            return Self { task: None };
        };
        let workspace_dir = workspace_dir.to_path_buf();
        // The checks get the environment of the turn whose changes they
        // picture, whenever they start.
        let environment = check_environment();
        Self {
            task: Some(tokio::spawn(async move {
                retake_stale_pictures(
                    &workspace_dir,
                    &project_id,
                    &changed,
                    cancel,
                    BUDGET,
                    &environment,
                    sender.as_ref(),
                )
                .await;
            })),
        }
    }

    /// Lets the checks go on after the turn's reply, within their own time
    /// (`CHECKS_TIMEOUT`); each picture is sent once it is taken.
    pub(super) fn detach(mut self) {
        drop(self.task.take());
    }

    /// Waits for the checks: at most `CHECKS_TIMEOUT`, less when the turn is
    /// stopped.
    #[cfg(test)]
    pub(super) async fn finish(mut self) {
        if let Some(task) = self.task.take()
            && let Err(error) = task.await
        {
            warn!(%error, "the end-of-turn check of an open preview did not finish");
        }
    }
}

impl Drop for PictureRetake {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// What a check may have of this process's environment: what a helper that
/// outlives a turn may have, and the settings the check reads. Never a
/// credential: not the turn's granted secrets, which this process's
/// environment holds while the turn runs, nor Instafy's, a model's or this
/// runtime's own.
fn check_environment() -> Vec<(OsString, OsString)> {
    allowlisted_environment(PREVIEW_CHECK_ENV_KEYS)
}

/// Checks each open preview whose site this turn changed after it was last
/// pictured, which takes the card's picture again, and sends each picture
/// taken. It runs the same `instafy preview check` a turn runs, at the desktop
/// size only, from the workspace; a check that fails, runs out of time or is
/// stopped leaves the card's picture as it was.
async fn retake_stale_pictures(
    workspace_dir: &Path,
    project_id: &Uuid,
    changed: &[String],
    cancel: Option<JobCancelSignal>,
    budget: Budget,
    environment: &[(OsString, OsString)],
    sender: &dyn PictureSender,
) {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let state_file = Path::new(&home).join(PREVIEW_STATE_RELATIVE_PATH);
    let Some(state) = read_state(&state_file).await else {
        return;
    };
    let deadline = Instant::now() + budget.total;
    for preview in stale_pictures(&state, project_id, workspace_dir, changed, client_runs) {
        let left = deadline.saturating_duration_since(Instant::now());
        if left < budget.min_left || cancel.as_ref().is_some_and(JobCancelSignal::is_canceled) {
            break;
        }
        let Some(taken) =
            check_preview(workspace_dir, &preview, left, cancel.as_ref(), environment).await
        else {
            continue;
        };
        // A picture taken since (the next turn's own check, which records its
        // time before it sends) is newer: this one is not sent, nor sent
        // again after a credential renewal.
        let still_newest =
            || !newer_picture_taken(&state_file, &preview.preview_id, taken.taken_at);
        if !still_newest() {
            info!(
                port = preview.port,
                "a newer picture of an open preview was taken; this one is not sent"
            );
            continue;
        }
        match tokio::time::timeout(
            SEND_TIMEOUT,
            sender.send(
                *project_id,
                &preview.preview_id,
                &taken.picture,
                &still_newest,
            ),
        )
        .await
        {
            Ok(Ok(())) => info!(
                port = preview.port,
                path = %preview.path,
                "sent the new picture of an open preview whose site the turn changed"
            ),
            Ok(Err(error)) => warn!(
                port = preview.port,
                %error,
                "could not send the new picture of an open preview; its card keeps its picture"
            ),
            Err(_) => warn!(
                port = preview.port,
                "sending the new picture of an open preview ran out of time; its card keeps its picture"
            ),
        }
    }
}

async fn read_state(state_file: &Path) -> Option<JsonValue> {
    let text = tokio::fs::read_to_string(state_file).await.ok()?;
    serde_json::from_str::<JsonValue>(&text).ok()
}

/// When the CLI last pictured a preview (ms since the epoch).
fn picture_at(state: &JsonValue, preview_id: &str) -> Option<f64> {
    state
        .get("previews")?
        .as_array()?
        .iter()
        .find(|entry| entry.get("previewId").and_then(JsonValue::as_str) == Some(preview_id))?
        .get("pictureAt")?
        .as_f64()
}

/// Whether the CLI's state file (`state_file`) says a picture of the preview
/// newer than `taken_at` was taken. Read as it is now: it is small.
fn newer_picture_taken(state_file: &Path, preview_id: &str, taken_at: f64) -> bool {
    std::fs::read_to_string(state_file)
        .ok()
        .and_then(|text| serde_json::from_str::<JsonValue>(&text).ok())
        .and_then(|state| picture_at(&state, preview_id))
        .is_some_and(|at| at > taken_at)
}

/// A picture a check took, and when it began loading the page it shows.
#[derive(Debug)]
struct TakenPicture {
    picture: CardPicture,
    taken_at: f64,
}

/// Runs one `instafy preview check` for a preview's picture, for at most
/// `left`, or until the turn is stopped, and reads the picture it kept.
async fn check_preview(
    workspace_dir: &Path,
    preview: &StalePicture,
    left: Duration,
    cancel: Option<&JobCancelSignal>,
    environment: &[(OsString, OsString)],
) -> Option<TakenPicture> {
    // The check's screenshots and the picture it keeps go to a folder of
    // their own, removed with it.
    let screenshots = match tempfile::Builder::new()
        .prefix("instafy-preview-picture-")
        .tempdir()
    {
        Ok(dir) => dir,
        Err(error) => {
            warn!(%error, "no folder for an open preview's end-of-turn check; its card keeps its picture");
            return None;
        }
    };
    let picture_file = screenshots.path().join(PICTURE_FILE);
    let mut command = Command::new("instafy");
    command
        .args([
            "preview",
            "check",
            "--port",
            &preview.port.to_string(),
            "--path",
            &preview.path,
            "--desktop",
            "--timeout",
            CHECK_PAGE_LOAD_TIMEOUT_MS,
            "--out",
        ])
        .arg(screenshots.path())
        .arg("--picture-to")
        .arg(&picture_file)
        .arg("--json")
        .current_dir(workspace_dir)
        .env_clear()
        .envs(environment.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // The check leads a process group of its own, so the helpers it starts
    // (its egress proxy) go with it when it is stopped.
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            warn!(port = preview.port, %error, "could not check an open preview after the turn; its card keeps its picture");
            return None;
        }
    };
    let mut check = CheckGroup(child.id().and_then(|pid| i32::try_from(pid).ok()));
    let stopped = async {
        match cancel {
            Some(cancel) => cancel.cancelled().await,
            None => std::future::pending().await,
        }
    };
    let finished = tokio::select! {
        status = child.wait() => match status {
            Ok(status) => {
                info!(
                    port = preview.port,
                    path = %preview.path,
                    exit_code = ?status.code(),
                    "checked an open preview whose site the turn changed, for its card's picture"
                );
                true
            }
            Err(error) => {
                warn!(
                    port = preview.port,
                    %error,
                    "could not check an open preview after the turn; its card keeps its picture"
                );
                false
            }
        },
        () = tokio::time::sleep(left) => {
            warn!(
                port = preview.port,
                "checking an open preview after the turn ran out of time; its card keeps its picture"
            );
            false
        }
        () = stopped => {
            info!(
                port = preview.port,
                "the turn was stopped while its open preview was checked; its card keeps its picture"
            );
            false
        }
    };
    let stopped = check.stop();
    // The check itself goes even if its group could not be signalled, and is
    // reaped: its process is gone before its folder is.
    let _ = child.start_kill();
    let _ = child.wait().await;
    if let Some(pgid) = stopped {
        reap_group(pgid).await;
    }
    if !finished {
        return None;
    }
    read_kept_picture(&picture_file, &preview.preview_id).await
}

/// The picture a check kept for `preview_id`, with what it wrote beside it:
/// the preview it is for, the page's description, and when it began loading
/// the page. None when it kept none, kept it for another preview, or either
/// file is too big.
async fn read_kept_picture(picture_file: &Path, preview_id: &str) -> Option<TakenPicture> {
    let mut facts_file = picture_file.as_os_str().to_owned();
    facts_file.push(".json");
    let facts = read_small(Path::new(&facts_file), MAX_PICTURE_FACTS_BYTES).await?;
    let facts: JsonValue = serde_json::from_slice(&facts).ok()?;
    if facts.get("previewId").and_then(JsonValue::as_str) != Some(preview_id) {
        return None;
    }
    let taken_at = facts.get("takenAt").and_then(JsonValue::as_f64)?;
    let description = facts
        .get("description")
        .and_then(JsonValue::as_str)
        .map(str::to_string);
    let image = read_small(picture_file, MAX_PICTURE_BYTES).await?;
    // A card takes a JPEG from a check.
    if !image.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return None;
    }
    Some(TakenPicture {
        picture: CardPicture { image, description },
        taken_at,
    })
}

/// A regular file's bytes, when it has at most `max` of them.
async fn read_small(file: &Path, max: u64) -> Option<Vec<u8>> {
    let metadata = tokio::fs::symlink_metadata(file).await.ok()?;
    if !metadata.is_file() || metadata.len() > max {
        return None;
    }
    let bytes = tokio::fs::read(file).await.ok()?;
    (bytes.len() as u64 <= max).then_some(bytes)
}

/// The process group an end-of-turn check leads: the CLI and the helpers it
/// started. Chromium follows the CLI on its own: it closes when its pipe to
/// the CLI does.
struct CheckGroup(Option<i32>);

impl CheckGroup {
    /// Stops whatever is left of the group, once: all of it when the check
    /// was cut short, a helper it left behind otherwise.
    fn stop(&mut self) -> Option<i32> {
        let pgid = self.0.take().filter(|pgid| *pgid > 0)?;
        group::kill(pgid);
        Some(pgid)
    }
}

impl Drop for CheckGroup {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Reaps, briefly, what a stopped group left to this process (it inherits
/// orphans when it runs as a container's first process).
async fn reap_group(pgid: i32) {
    let until = Instant::now() + Duration::from_secs(1);
    while group::exists(pgid) && Instant::now() < until {
        group::reap(pgid);
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::{FileChangeDescriptor, FileChangeKind};
    use super::*;
    use serde_json::json;
    use std::time::SystemTime;

    fn now_ms() -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as f64
    }

    fn workspace() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("sites/seville/data")).unwrap();
        std::fs::create_dir_all(dir.path().join("notes")).unwrap();
        for file in [
            "sites/seville/index.html",
            "sites/seville/data/places.json",
            "notes/todo.md",
        ] {
            std::fs::write(dir.path().join(file), "x").unwrap();
        }
        dir
    }

    fn entry(project: &Uuid, extra: JsonValue) -> JsonValue {
        let mut entry = json!({
            "previewId": "preview-1",
            "projectId": project.to_string(),
            "title": "3 days in Seville",
            "localPort": 4173,
            "path": "/",
            "pid": 4242,
            "siteDir": "sites/seville",
        });
        entry
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        entry
    }

    fn stale(
        state: JsonValue,
        project: &Uuid,
        workspace: &Path,
        changed: &[&str],
    ) -> Vec<StalePicture> {
        let changed: Vec<String> = changed.iter().map(|path| path.to_string()).collect();
        stale_pictures(&state, project, workspace, &changed, |pid| pid == 4242)
    }

    // A local test: a map opened early kept its blank starter on the card,
    // because the turn replied before its check, after adding the places.
    #[test]
    fn a_site_changed_after_its_picture_is_checked_again() {
        let dir = workspace();
        let project = Uuid::new_v4();
        let picture_before = now_ms() - 60_000.0;
        let state = json!({ "version": 1, "previews": [
            entry(&project, json!({ "pictureAt": picture_before })),
        ]});
        assert_eq!(
            stale(
                state,
                &project,
                dir.path(),
                &["sites/seville/data/places.json"]
            ),
            vec![StalePicture {
                preview_id: "preview-1".to_string(),
                port: 4173,
                path: "/".to_string()
            }]
        );
    }

    // The picture is sent to the card by the preview's id, which goes into
    // an address: an entry without a plain one is left alone.
    #[test]
    fn a_preview_without_a_plain_id_is_left_alone() {
        let dir = workspace();
        let project = Uuid::new_v4();
        let mut no_id = entry(&project, json!({ "pictureAt": now_ms() - 60_000.0 }));
        no_id.as_object_mut().unwrap().remove("previewId");
        let state = json!({ "version": 1, "previews": [
            no_id,
            entry(&project, json!({ "localPort": 4174, "previewId": "../agent/complete" })),
            entry(&project, json!({ "localPort": 4175, "previewId": "" })),
        ]});
        assert!(stale(state, &project, dir.path(), &["sites/seville/index.html"]).is_empty());
        assert!(is_preview_id("tun_01J9Z-abc"));
        for id in ["", "a/b", "a b", "a?b", &"x".repeat(129)] {
            assert!(!is_preview_id(id), "{id}");
        }
    }

    #[test]
    fn a_picture_taken_or_tried_after_the_change_stays() {
        let dir = workspace();
        let project = Uuid::new_v4();
        // The turn's own check ran after its last change.
        let picture_after = now_ms() + 60_000.0;
        let state = json!({ "version": 1, "previews": [
            entry(&project, json!({ "pictureAt": picture_after })),
        ]});
        assert!(stale(state, &project, dir.path(), &["sites/seville/index.html"]).is_empty());
    }

    #[test]
    fn only_a_change_to_the_previews_own_site_counts() {
        let dir = workspace();
        let project = Uuid::new_v4();
        let state = json!({ "version": 1, "previews": [
            entry(&project, json!({ "pictureAt": now_ms() - 60_000.0 })),
        ]});
        assert!(stale(state.clone(), &project, dir.path(), &["notes/todo.md"]).is_empty());
        assert!(
            stale(
                state.clone(),
                &project,
                dir.path(),
                &["sites/sevilla/index.html"]
            )
            .is_empty()
        );
        assert!(stale(state.clone(), &project, dir.path(), &[]).is_empty());
        // A removed file and a new folder that holds the site count.
        assert_eq!(
            stale(
                state.clone(),
                &project,
                dir.path(),
                &["sites/seville/old.json"]
            )
            .len(),
            1
        );
        assert_eq!(stale(state, &project, dir.path(), &["sites/"]).len(), 1);
    }

    #[test]
    fn a_site_served_from_the_workspace_or_with_no_picture_time_counts_every_change() {
        let dir = workspace();
        let project = Uuid::new_v4();
        let whole_workspace = json!({ "version": 1, "previews": [
            entry(&project, json!({ "siteDir": ".", "pictureAt": now_ms() - 60_000.0 })),
        ]});
        assert_eq!(
            stale(whole_workspace, &project, dir.path(), &["notes/todo.md"]).len(),
            1
        );
        let no_picture_time = json!({ "version": 1, "previews": [entry(&project, json!({}))]});
        assert_eq!(
            stale(
                no_picture_time,
                &project,
                dir.path(),
                &["sites/seville/index.html"]
            )
            .len(),
            1
        );
    }

    // A local test: a comparison's preview, started from the workspace itself
    // (its server serves a folder of it), took a new picture after a turn that
    // made another site in its own folder and never touched the comparison.
    #[test]
    fn a_change_in_another_sites_folder_is_not_a_change_to_a_site_served_from_the_workspace() {
        let dir = workspace();
        std::fs::create_dir_all(dir.path().join("sites/lello")).unwrap();
        std::fs::write(dir.path().join("sites/lello/index.html"), "x").unwrap();
        let project = Uuid::new_v4();
        let before = now_ms() - 60_000.0;
        let root = entry(
            &project,
            json!({ "previewId": "preview-root", "localPort": 20549, "siteDir": ".", "pictureAt": before }),
        );
        let seville = entry(&project, json!({ "pictureAt": before }));
        let lello = entry(
            &project,
            json!({ "previewId": "preview-lello", "localPort": 22658, "siteDir": "sites/lello/", "pictureAt": before }),
        );
        let state = json!({ "version": 1, "previews": [root, seville, lello] });
        let ids = |changed: &[&str]| {
            stale(state.clone(), &project, dir.path(), changed)
                .into_iter()
                .map(|picture| picture.preview_id)
                .collect::<Vec<_>>()
        };
        // The turn that made the bookshop's page changed that site alone.
        assert_eq!(ids(&["sites/lello/index.html"]), ["preview-lello"]);
        assert_eq!(ids(&["sites/seville/data/places.json"]), ["preview-1"]);
        // A change no other site's folder holds may be the workspace site's.
        assert_eq!(ids(&["notes/todo.md"]), ["preview-root"]);
        assert_eq!(ids(&["sites/lisbon/index.html"]), ["preview-root"]);
        // A folder that holds a site is that site's change, and the workspace's.
        assert_eq!(
            ids(&["sites/"]),
            ["preview-root", "preview-1", "preview-lello"]
        );
        // Another space's preview inside the folder takes nothing from it.
        let other_space = json!({ "version": 1, "previews": [
            entry(&project, json!({ "previewId": "preview-root", "localPort": 20549, "siteDir": ".", "pictureAt": before })),
            entry(&Uuid::new_v4(), json!({ "pictureAt": before })),
        ]});
        assert_eq!(
            stale(
                other_space,
                &project,
                dir.path(),
                &["sites/seville/index.html"]
            )
            .into_iter()
            .map(|picture| picture.preview_id)
            .collect::<Vec<_>>(),
            ["preview-root"]
        );
    }

    // Review: a preview whose folder was not read counted every change in the
    // workspace, so every turn that changed any file held up its reply for a
    // check; and one opened with `--no-thumbnail` got a picture on its card.
    #[test]
    fn a_preview_with_no_folder_or_opened_without_a_picture_is_left_alone() {
        let dir = workspace();
        let project = Uuid::new_v4();
        let mut no_folder = entry(&project, json!({ "pictureAt": now_ms() - 60_000.0 }));
        no_folder.as_object_mut().unwrap().remove("siteDir");
        let state = json!({ "version": 1, "previews": [
            no_folder,
            entry(&project, json!({ "localPort": 4174, "noThumbnail": true })),
        ]});
        assert!(
            stale(
                state,
                &project,
                dir.path(),
                &["notes/todo.md", "sites/seville/index.html"]
            )
            .is_empty()
        );
    }

    #[test]
    fn another_spaces_preview_or_a_stopped_tunnel_is_left_alone() {
        let dir = workspace();
        let project = Uuid::new_v4();
        let other = Uuid::new_v4();
        let state = json!({ "version": 1, "previews": [
            entry(&other, json!({})),
            entry(&project, json!({ "pid": 7 })),
            entry(&project, json!({ "localPort": 0 })),
            "not a preview",
        ]});
        assert!(stale(state, &project, dir.path(), &["sites/seville/index.html"]).is_empty());
        assert!(
            stale(
                json!({}),
                &project,
                dir.path(),
                &["sites/seville/index.html"]
            )
            .is_empty()
        );
    }

    #[test]
    fn each_port_and_path_is_checked_once_and_a_few_at_most() {
        let dir = workspace();
        let project = Uuid::new_v4();
        let previews: Vec<JsonValue> = (0..6)
            .map(|index| {
                entry(
                    &project,
                    json!({ "localPort": 4173 + (index / 2), "path": "/" }),
                )
            })
            .collect();
        let state = json!({ "version": 1, "previews": previews });
        let checked = stale(state, &project, dir.path(), &["sites/seville/index.html"]);
        assert_eq!(
            checked
                .iter()
                .map(|preview| preview.port)
                .collect::<Vec<_>>(),
            vec![4173, 4174, 4175]
        );
    }

    #[test]
    fn changed_paths_leave_out_files_only_read() {
        let file = |path: &str, kind: FileChangeKind| CodexFileDescriptor {
            path: path.to_string(),
            workspace_path: path.to_string(),
            label: None,
            description: None,
            mime_type: None,
            content: None,
            content_base64: None,
            change: Some(FileChangeDescriptor {
                kind,
                lines: Vec::new(),
                raw: json!({}),
            }),
        };
        let files = vec![
            file("sites/seville/data/places.json", FileChangeKind::Changed),
            file("sites/seville/README.md", FileChangeKind::Read),
            file("./sites/seville/index.html", FileChangeKind::Created),
            file("sites/seville/data/places.json", FileChangeKind::Changed),
            file("../outside.txt", FileChangeKind::Changed),
        ];
        assert_eq!(
            changed_paths(&files),
            vec!["sites/seville/data/places.json", "sites/seville/index.html"]
        );
    }

    // The check gets no environment but what it reads: each setting the CLI
    // reads to find Playwright and Chromium, the skill packs' link-only lists
    // and the ports a preview may not be reaches it, so a setting the CLI
    // starts reading is not silently lost.
    #[test]
    fn the_check_keeps_every_setting_the_cli_reads_for_it() {
        // Of the web helpers, the check uses only where skills are found.
        let web = include_str!("../../../instafy-cli/src/web-shared.ts");
        let skill_roots = web
            .find("export function homeDir")
            .and_then(|start| {
                let end = web[start..].find("\n/** One skill's copy")?;
                Some(&web[start..start + end])
            })
            .expect("the CLI finds skills with homeDir and defaultSkillRoots");
        let sources = [
            include_str!("../../../instafy-cli/src/local-site.ts"),
            include_str!("../../../instafy-cli/src/site-check.ts"),
            skill_roots,
        ];
        let named = |text: &str, before: &str| -> Vec<String> {
            text.match_indices(before)
                .filter_map(|(at, _)| {
                    let rest = &text[at + before.len()..];
                    let name: String = rest
                        .chars()
                        .take_while(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == '_')
                        .collect();
                    (!name.is_empty()).then_some(name)
                })
                .collect()
        };
        let mut read = Vec::new();
        for source in sources {
            // `env.NODE_PATH`, `{ env: "INSTAFY_VNC_PORT", … }` and
            // `export const …_ENV = "INSTAFY_PREVIEW_DENY_PORTS"`.
            read.extend(named(source, "env."));
            read.extend(named(source, "env: \""));
            read.extend(named(source, "_ENV = \""));
        }
        for expected in [
            "INSTAFY_VNC_PORT",
            "INSTAFY_PREVIEW_DENY_PORTS",
            "PLAYWRIGHT_BROWSERS_PATH",
            "INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH",
            "INSTAFY_SKILL_PACKS_DIR",
        ] {
            assert!(
                read.iter().any(|name| name == expected),
                "{expected} in {read:?}"
            );
        }
        let kept: Vec<String> = crate::model_environment::PERSISTENT_HELPER_BASE_ENV_KEYS
            .iter()
            .chain(PREVIEW_CHECK_ENV_KEYS)
            .map(|key| key.to_string())
            .collect();
        for name in read {
            assert!(kept.contains(&name), "the check does not get {name}");
        }
    }

    /// Whether a process is still running: gone, or a zombie, is not.
    #[cfg(unix)]
    fn running(pid: &str) -> bool {
        let state = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", pid])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&state.stdout);
        let state = state.trim();
        !state.is_empty() && !state.starts_with('Z')
    }

    /// The pictures a retake sent, as this runtime's controller client would.
    /// With `newer_while_sending`, a newer picture of the preview is recorded
    /// in the CLI's state file (at that path) while one is sent, and what
    /// `still_newest` then says is kept.
    #[derive(Default)]
    struct SentPictures {
        sent: std::sync::Mutex<Vec<(Uuid, String, CardPicture)>>,
        newer_while_sending: std::sync::Mutex<Option<std::path::PathBuf>>,
        still_newest_after: std::sync::Mutex<Vec<bool>>,
    }

    impl PictureSender for SentPictures {
        fn send<'a>(
            &'a self,
            project_id: Uuid,
            preview_id: &'a str,
            picture: &'a CardPicture,
            still_newest: StillNewest<'a>,
        ) -> Pin<Box<dyn Future<Output = anyhow::Result<()>> + Send + 'a>> {
            if let Some(state_file) = self.newer_while_sending.lock().unwrap().clone() {
                let mut state: JsonValue =
                    serde_json::from_str(&std::fs::read_to_string(&state_file).unwrap()).unwrap();
                for entry in state["previews"].as_array_mut().unwrap() {
                    if entry["previewId"] == preview_id {
                        entry["pictureAt"] = json!(now_ms() + 60_000.0);
                    }
                }
                std::fs::write(&state_file, state.to_string()).unwrap();
                self.still_newest_after.lock().unwrap().push(still_newest());
            }
            self.sent
                .lock()
                .unwrap()
                .push((project_id, preview_id.to_string(), picture.clone()));
            Box::pin(async { Ok(()) })
        }
    }

    impl SentPictures {
        fn take(&self) -> Vec<(Uuid, String, CardPicture)> {
            std::mem::take(&mut *self.sent.lock().unwrap())
        }
    }

    // The end of a turn runs `instafy preview check` for a stale picture, at
    // the desktop size, from the workspace, with no credential (never the
    // turn's granted secrets, Instafy's, the machine's or a model's) but the
    // settings it reads, keeps the picture in a file, sends it with the
    // runtime's own credential, and removes the check's folder after it. A
    // read-only turn checks nothing. A check that runs out of time, or a turn
    // that is stopped, ends the check and every helper it started, and sends
    // nothing. The reply does not wait: a retake let go on after it still
    // sends its picture once the check took it, and it is not sent again once
    // a newer picture was taken.
    #[cfg(unix)]
    #[test]
    fn the_turns_own_check_runs_for_a_stale_picture_and_leaves_nothing_behind() {
        use std::os::unix::fs::PermissionsExt;
        const CHILD_MARKER: &str = "INSTAFY_PREVIEW_PICTURES_TEST_CHILD";
        const TEST_NAME: &str = "jobs::preview_pictures::tests::the_turns_own_check_runs_for_a_stale_picture_and_leaves_nothing_behind";

        // HOME and PATH are process-wide: run in a test process of its own.
        if std::env::var_os(CHILD_MARKER).is_none() {
            let sandbox = tempfile::tempdir().unwrap();
            let bin = sandbox.path().join("bin");
            let home = sandbox.path().join("home");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::create_dir_all(home.join(".instafy")).unwrap();
            let seen = sandbox.path().join("seen");
            // A stand-in `instafy`: it keeps its picture where `--picture-to`
            // says, with the preview and the page's description beside it.
            // On 4175 it starts a helper in its group and hangs; on 4176 it
            // takes a second first; on 4177 its picture is older than the
            // card's; on 4178 it keeps the picture for another preview.
            std::fs::write(
                bin.join("instafy"),
                format!(
                    r#"#!/bin/sh
seen='{seen}'
{{ echo "args=$*"; echo "cwd=$(pwd -P)"; echo "job=${{CONTROLLER_ACCESS_TOKEN:-}}"; echo "machine=${{RUNTIME_ACCESS_TOKEN:-}}"; echo "model=${{CODEX_API_KEY:-}}"; echo "github=${{GITHUB_TOKEN:-}}"; echo "research=${{INSTAFY_RESEARCH_ACCESS_TOKEN:-}}"; echo "secret=${{BOOKING_PARTNER:-}}"; echo "settings=${{NODE_PATH:-}} ${{INSTAFY_SKILL_PACKS_DIR:-}} ${{INSTAFY_PREVIEW_DENY_PORTS:-}}"; }} >> "$seen"
port=; out=; picture=
while [ $# -gt 0 ]; do
  case "$1" in
    --port) port=$2; shift ;;
    --out) out=$2; shift ;;
    --picture-to) picture=$2; shift ;;
  esac
  shift
done
echo "out=$out" >> "$seen"
if [ "$port" = 4175 ]; then
  sleep 300 &
  echo "helper=$!" >> "$seen"
  sleep 300
fi
[ "$port" = 4176 ] && sleep 1
taken="$(date +%s)000"
[ "$port" = 4177 ] && taken=1
preview=preview-1
[ "$port" = 4178 ] && preview=preview-2
echo picture > "$out/desktop.png"
printf '\377\330\377\340card' > "$picture"
printf '{{"previewId":"%s","description":"Trip · 3 days","takenAt":%s}}' "$preview" "$taken" > "$picture.json"
echo "sent-by-check=no" >> "$seen"
"#,
                    seen = seen.display()
                ),
            )
            .unwrap();
            std::fs::set_permissions(bin.join("instafy"), std::fs::Permissions::from_mode(0o755))
                .unwrap();
            let path = format!(
                "{}:{}",
                bin.display(),
                std::env::var("PATH").unwrap_or_default()
            );
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", TEST_NAME, "--nocapture"])
                .env(CHILD_MARKER, sandbox.path())
                .env("HOME", &home)
                .env("PATH", path)
                .env("CONTROLLER_ACCESS_TOKEN", "job-token")
                .env("RUNTIME_ACCESS_TOKEN", "machine-token")
                .env("CODEX_API_KEY", "model-key")
                // The turn's granted secrets: the check goes on after the
                // turn, while the next one runs.
                .env("GITHUB_TOKEN", "space-secret")
                .env("INSTAFY_RESEARCH_ACCESS_TOKEN", "research-token")
                .env("BOOKING_PARTNER", "plain-named-secret")
                // The settings the check reads.
                .env("NODE_PATH", "/opt/node/lib")
                .env("INSTAFY_SKILL_PACKS_DIR", "/opt/instafy/skill-packs")
                .env("INSTAFY_PREVIEW_DENY_PORTS", "6000")
                .output()
                .unwrap();
            assert!(
                output.status.success()
                    && String::from_utf8_lossy(&output.stdout)
                        .contains("test result: ok. 1 passed"),
                "stdout:\n{}\nstderr:\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        let sandbox = std::path::PathBuf::from(std::env::var_os(CHILD_MARKER).unwrap());
        let seen_file = sandbox.join("seen");
        let workspace = sandbox.join("workspace");
        for site in ["seville", "porto", "lisbon", "faro", "braga"] {
            std::fs::create_dir_all(workspace.join("sites").join(site)).unwrap();
            std::fs::write(workspace.join("sites").join(site).join("index.html"), "x").unwrap();
        }
        let project = Uuid::new_v4();
        let home = std::path::PathBuf::from(std::env::var_os("HOME").unwrap());
        let picture_before = now_ms() - 60_000.0;
        let preview = |port: u16, site: &str, extra: JsonValue| {
            let mut fields = json!({
                "localPort": port,
                "pid": std::process::id(),
                "siteDir": format!("sites/{site}"),
                "pictureAt": picture_before,
            });
            fields
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            entry(&project, fields)
        };
        let state = json!({ "version": 1, "previews": [
            preview(4173, "seville", json!({ "path": "/map" })),
            // Its site did not change.
            preview(4174, "sintra", json!({})),
            // Its check hangs.
            preview(4175, "porto", json!({})),
            // Its check takes a second.
            preview(4176, "lisbon", json!({})),
            // Its check's picture is older than the card's.
            preview(4177, "faro", json!({})),
            // Its check keeps the picture for another preview.
            preview(4178, "braga", json!({})),
        ]});
        std::fs::write(home.join(PREVIEW_STATE_RELATIVE_PATH), state.to_string()).unwrap();
        let changed = |path: &str| CodexFileDescriptor {
            path: path.to_string(),
            workspace_path: path.to_string(),
            label: None,
            description: None,
            mime_type: None,
            content: None,
            content_base64: None,
            change: Some(FileChangeDescriptor {
                kind: FileChangeKind::Changed,
                lines: Vec::new(),
                raw: json!({}),
            }),
        };
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap();
        let take_seen = || {
            let seen = std::fs::read_to_string(&seen_file).unwrap_or_default();
            let _ = std::fs::remove_file(&seen_file);
            seen
        };
        let sent = Arc::new(SentPictures::default());
        let sender = || Some(sent.clone() as Arc<dyn PictureSender>);
        let retake = |site: &str, cancel: Option<JobCancelSignal>| {
            PictureRetake::start(
                &workspace,
                project,
                false,
                &[changed(&format!("sites/{site}/index.html"))],
                cancel,
                sender(),
            )
        };

        // A read-only turn changed nothing: nothing runs.
        runtime.block_on(async {
            PictureRetake::start(
                &workspace,
                project,
                true,
                &[changed("sites/seville/index.html")],
                None,
                sender(),
            )
            .finish()
            .await;
        });
        assert_eq!(take_seen(), "");
        assert!(sent.take().is_empty());

        // A turn that changed the map's site checks it, and only it, with no
        // credential, and the runtime sends the picture the check kept.
        runtime.block_on(async { retake("seville", None).finish().await });
        let seen = take_seen();
        let lines: Vec<&str> = seen.lines().collect();
        let out = lines
            .iter()
            .find_map(|line| line.strip_prefix("out="))
            .expect("the check gets a folder for its screenshots")
            .to_string();
        let workspace_real = workspace.canonicalize().unwrap();
        assert_eq!(
            lines,
            vec![
                format!("args=preview check --port 4173 --path /map --desktop --timeout 10000 --out {out} --picture-to {out}/card.jpg --json").as_str(),
                format!("cwd={}", workspace_real.display()).as_str(),
                "job=",
                "machine=",
                "model=",
                "github=",
                "research=",
                "secret=",
                "settings=/opt/node/lib /opt/instafy/skill-packs 6000",
                format!("out={out}").as_str(),
                "sent-by-check=no",
            ]
        );
        assert!(
            !Path::new(&out).exists(),
            "the check's screenshots are removed"
        );
        assert_eq!(
            sent.take(),
            vec![(
                project,
                "preview-1".to_string(),
                CardPicture {
                    image: b"\xFF\xD8\xFF\xE0card".to_vec(),
                    description: Some("Trip · 3 days".to_string()),
                }
            )]
        );

        // The reply does not wait: a retake let go on after it sends its
        // picture once its check took it.
        let started = Instant::now();
        runtime.block_on(async { retake("lisbon", None).detach() });
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "letting the retake go on waited {:?}",
            started.elapsed()
        );
        let until = Instant::now() + Duration::from_secs(10);
        let mut late = Vec::new();
        while late.is_empty() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
            late = sent.take();
        }
        assert_eq!(
            late.iter()
                .map(|(_, id, picture)| (id.as_str(), picture.description.as_deref()))
                .collect::<Vec<_>>(),
            vec![("preview-1", Some("Trip · 3 days"))]
        );
        // The check that goes on after the turn has none of its secrets.
        let seen = take_seen();
        for line in ["job=", "github=", "research=", "secret="] {
            assert!(seen.lines().any(|seen| seen == line), "{line} in {seen}");
        }

        // A picture older than the card's, or kept for another preview, is
        // not sent.
        runtime.block_on(async { retake("faro", None).finish().await });
        runtime.block_on(async { retake("braga", None).finish().await });
        assert!(take_seen().contains("sent-by-check=no"));
        assert!(sent.take().is_empty());

        // A check that runs out of time ends with every helper it started,
        // and nothing is sent.
        let started = Instant::now();
        runtime.block_on(retake_stale_pictures(
            &workspace,
            &project,
            &["sites/porto/index.html".to_string()],
            None,
            Budget {
                total: Duration::from_secs(2),
                min_left: Duration::from_secs(1),
            },
            &check_environment(),
            sent.as_ref(),
        ));
        assert!(started.elapsed() < Duration::from_secs(10));
        let seen = take_seen();
        let helper = seen
            .lines()
            .find_map(|line| line.strip_prefix("helper="))
            .expect("the hanging check started its helper")
            .to_string();
        let out = seen
            .lines()
            .find_map(|line| line.strip_prefix("out="))
            .unwrap()
            .to_string();
        assert!(!running(&helper), "the helper is stopped with its check");
        assert!(!Path::new(&out).exists());
        assert!(sent.take().is_empty());

        // A stopped turn ends its check at once.
        let cancel = JobCancelSignal::new();
        let started = Instant::now();
        runtime.block_on(async {
            let retake = retake("porto", Some(cancel.clone()));
            tokio::time::sleep(Duration::from_millis(500)).await;
            cancel.cancel();
            retake.finish().await;
        });
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "the check waited {:?} after the turn was stopped",
            started.elapsed()
        );
        let seen = take_seen();
        let helper = seen
            .lines()
            .find_map(|line| line.strip_prefix("helper="))
            .expect("the check had started")
            .to_string();
        assert!(!running(&helper), "the helper is stopped with its check");

        // A turn whose save failed drops its checks, and they stop.
        runtime.block_on(async {
            let retake = retake("porto", None);
            tokio::time::sleep(Duration::from_millis(500)).await;
            drop(retake);
            tokio::time::sleep(Duration::from_millis(500)).await;
        });
        let seen = take_seen();
        let helper = seen
            .lines()
            .find_map(|line| line.strip_prefix("helper="))
            .expect("the check had started")
            .to_string();
        let until = Instant::now() + Duration::from_secs(5);
        while running(&helper) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(!running(&helper), "the helper is stopped with its check");
        assert!(sent.take().is_empty());

        // A newer picture taken while one is sent (the next turn's own check
        // records its time before it sends) stops a send tried again after a
        // credential renewal.
        *sent.newer_while_sending.lock().unwrap() = Some(home.join(PREVIEW_STATE_RELATIVE_PATH));
        runtime.block_on(async { retake("seville", None).finish().await });
        assert_eq!(*sent.still_newest_after.lock().unwrap(), vec![false]);
        assert_eq!(sent.take().len(), 1);
        take_seen();

        // With nothing to send a picture with, nothing is checked.
        runtime.block_on(async {
            PictureRetake::start(
                &workspace,
                project,
                false,
                &[changed("sites/seville/index.html")],
                None,
                None,
            )
            .finish()
            .await;
        });
        assert_eq!(take_seen(), "");
    }
}
