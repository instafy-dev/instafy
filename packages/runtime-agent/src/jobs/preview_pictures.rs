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
//! check --desktop`), with the turn's own credentials. The reply waits for
//! it a bounded time, as the save itself: the job token the picture is sent
//! with works only while the job runs. A turn that is stopped stops it.
//!
//! `instafy preview open` records each preview in the CLI's state file
//! (`~/.instafy/cli-preview-state.json`): its port and path, the folder its
//! site's server runs from (`siteDir`), when the site was last pictured for
//! the card (`pictureAt`, milliseconds since the epoch, whether or not a
//! picture came of it) and whether it was opened with `--no-thumbnail`. A
//! preview without a recorded folder, or opened with `--no-thumbnail`, is
//! left alone; one without a picture time counts every change as newer.

use std::path::{Component, Path};
use std::process::Stdio;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde_json::Value as JsonValue;
use tokio::process::Command;
use tokio::task::JoinHandle;
use tracing::{info, warn};
use uuid::Uuid;

use super::CodexFileDescriptor;
use crate::browser_host::process::group;
use crate::job_cancel::JobCancelSignal;
use crate::model_environment::is_model_child_excluded_env_key;

/// The CLI's record of the previews it opened on this machine, under `HOME`.
const PREVIEW_STATE_RELATIVE_PATH: &str = ".instafy/cli-preview-state.json";
/// At most this many previews are checked when one turn ends.
const MAX_CHECKS: usize = 3;
/// The page load limit each check gets (the CLI's own default is 30 s).
const CHECK_PAGE_LOAD_TIMEOUT_MS: &str = "10000";
/// How long the end of a turn waits for the checks, pictures sent included.
const CHECKS_TIMEOUT: Duration = Duration::from_secs(30);
/// A check starts only with this much of `CHECKS_TIMEOUT` left: one that
/// could not finish would only hold up the reply.
const CHECK_MIN_TIME: Duration = Duration::from_secs(15);
/// Model credentials a check never needs: it calls no model.
const MODEL_KEYS: &[&str] = &["OPENAI_API_KEY", "CODEX_API_KEY"];

/// One open preview whose card's picture is older than a change this turn
/// made to its site.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StalePicture {
    pub(super) port: u16,
    pub(super) path: String,
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
/// after the site was last pictured.
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
            .filter(|changed| in_site(changed, site_dir))
            .any(|changed| changed_after(workspace_dir, changed, picture_at));
        // Only a preview whose tunnel still runs can take a new picture.
        if site_changed && client_runs(pid) {
            stale.push(StalePicture { port, path });
        }
        if stale.len() == MAX_CHECKS {
            break;
        }
    }
    stale
}

/// Whether a changed workspace path is in a site's folder: the folder itself,
/// a path under it, or a folder that holds it. Every path is when the folder
/// is the whole workspace.
fn in_site(changed: &str, site_dir: &str) -> bool {
    let site = site_dir
        .trim()
        .trim_start_matches("./")
        .trim_end_matches('/');
    if site.is_empty() || site == "." {
        return true;
    }
    let changed = changed.trim_end_matches('/');
    let under = |outer: &str, inner: &str| {
        inner == outer
            || inner
                .strip_prefix(outer)
                .is_some_and(|rest| rest.starts_with('/'))
    };
    under(site, changed) || under(changed, site)
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

/// The checks that take new pictures for the previews a turn changed, running
/// while the turn's changes are saved. [`PictureRetake::finish`] waits for
/// them; dropping it (a save that failed, a lease that was lost) stops them,
/// with everything they started.
pub(super) struct PictureRetake {
    task: Option<JoinHandle<()>>,
}

impl PictureRetake {
    /// Starts checking each open preview whose site the turn changed (`files`,
    /// as the turn's save lists them) after it was last pictured. A read-only
    /// turn changed nothing, and starts nothing.
    pub(super) fn start(
        workspace_dir: &Path,
        project_id: Uuid,
        read_only: bool,
        files: &[CodexFileDescriptor],
        cancel: Option<JobCancelSignal>,
    ) -> Self {
        let changed = if read_only {
            Vec::new()
        } else {
            changed_paths(files)
        };
        if changed.is_empty() {
            return Self { task: None };
        }
        let workspace_dir = workspace_dir.to_path_buf();
        Self {
            task: Some(tokio::spawn(async move {
                retake_stale_pictures(&workspace_dir, &project_id, &changed, cancel, BUDGET).await;
            })),
        }
    }

    /// Waits for the checks: at most `CHECKS_TIMEOUT`, less when the turn is
    /// stopped.
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

/// Checks each open preview whose site this turn changed after it was last
/// pictured, which takes the card's picture again. It runs the same
/// `instafy preview check` a turn runs, at the desktop size only, from the
/// workspace with the turn's own credentials; a check that fails, runs out
/// of time or is stopped leaves the card's picture as it was.
async fn retake_stale_pictures(
    workspace_dir: &Path,
    project_id: &Uuid,
    changed: &[String],
    cancel: Option<JobCancelSignal>,
    budget: Budget,
) {
    let Some(home) = std::env::var_os("HOME") else {
        return;
    };
    let Ok(text) =
        tokio::fs::read_to_string(Path::new(&home).join(PREVIEW_STATE_RELATIVE_PATH)).await
    else {
        return;
    };
    let Ok(state) = serde_json::from_str::<JsonValue>(&text) else {
        return;
    };
    let deadline = Instant::now() + budget.total;
    for preview in stale_pictures(&state, project_id, workspace_dir, changed, client_runs) {
        let left = deadline.saturating_duration_since(Instant::now());
        if left < budget.min_left || cancel.as_ref().is_some_and(JobCancelSignal::is_canceled) {
            break;
        }
        check_preview(workspace_dir, &preview, left, cancel.as_ref()).await;
    }
}

/// Runs one `instafy preview check` for a preview's picture, for at most
/// `left`, or until the turn is stopped.
async fn check_preview(
    workspace_dir: &Path,
    preview: &StalePicture,
    left: Duration,
    cancel: Option<&JobCancelSignal>,
) {
    // The check's screenshots go to a folder of their own, removed with it:
    // only its picture for the card is wanted.
    let screenshots = match tempfile::Builder::new()
        .prefix("instafy-preview-picture-")
        .tempdir()
    {
        Ok(dir) => dir,
        Err(error) => {
            warn!(%error, "no folder for an open preview's end-of-turn check; its card keeps its picture");
            return;
        }
    };
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
        .arg("--json")
        .current_dir(workspace_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // The check leads a process group of its own, so the helpers it starts
    // (its egress proxy) go with it when it is stopped.
    #[cfg(unix)]
    command.process_group(0);
    for (key, _) in std::env::vars_os() {
        let Some(name) = key.to_str() else {
            continue;
        };
        if is_model_child_excluded_env_key(name)
            || MODEL_KEYS
                .iter()
                .any(|model| name.eq_ignore_ascii_case(model))
        {
            command.env_remove(&key);
        }
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            warn!(port = preview.port, %error, "could not check an open preview after the turn; its card keeps its picture");
            return;
        }
    };
    let mut check = CheckGroup(child.id().and_then(|pid| i32::try_from(pid).ok()));
    let stopped = async {
        match cancel {
            Some(cancel) => cancel.cancelled().await,
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        status = child.wait() => match status {
            Ok(status) => info!(
                port = preview.port,
                path = %preview.path,
                exit_code = ?status.code(),
                "checked an open preview whose site the turn changed, for its card's picture"
            ),
            Err(error) => warn!(
                port = preview.port,
                %error,
                "could not check an open preview after the turn; its card keeps its picture"
            ),
        },
        () = tokio::time::sleep(left) => warn!(
            port = preview.port,
            "checking an open preview after the turn ran out of time; its card keeps its picture"
        ),
        () = stopped => info!(
            port = preview.port,
            "the turn was stopped while its open preview was checked; its card keeps its picture"
        ),
    }
    let stopped = check.stop();
    // The check itself goes even if its group could not be signalled, and is
    // reaped: its process is gone before its folder is.
    let _ = child.start_kill();
    let _ = child.wait().await;
    if let Some(pgid) = stopped {
        reap_group(pgid).await;
    }
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
                port: 4173,
                path: "/".to_string()
            }]
        );
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

    // The end of a turn runs `instafy preview check` for a stale picture, at
    // the desktop size, from the workspace, with the turn's own credentials
    // and never the machine's, and removes the check's screenshots after it.
    // A read-only turn checks nothing. A check that runs out of time, or a
    // turn that is stopped, ends the check and every helper it started.
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
            // A stand-in `instafy`: on port 4173 it writes its screenshot and
            // ends; on 4175 it starts a helper in its group and hangs.
            std::fs::write(
                bin.join("instafy"),
                format!(
                    r#"#!/bin/sh
seen='{seen}'
{{ echo "args=$*"; echo "cwd=$(pwd -P)"; echo "job=${{CONTROLLER_ACCESS_TOKEN:-}}"; echo "machine=${{RUNTIME_ACCESS_TOKEN:-}}"; echo "model=${{CODEX_API_KEY:-}}"; }} >> "$seen"
port=; out=
while [ $# -gt 0 ]; do
  case "$1" in
    --port) port=$2; shift ;;
    --out) out=$2; shift ;;
  esac
  shift
done
echo "out=$out" >> "$seen"
if [ "$port" = 4175 ]; then
  sleep 300 &
  echo "helper=$!" >> "$seen"
  sleep 300
fi
echo picture > "$out/desktop.png"
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
        std::fs::create_dir_all(workspace.join("sites/seville")).unwrap();
        std::fs::create_dir_all(workspace.join("sites/porto")).unwrap();
        std::fs::write(workspace.join("sites/seville/index.html"), "x").unwrap();
        std::fs::write(workspace.join("sites/porto/index.html"), "x").unwrap();
        let project = Uuid::new_v4();
        let home = std::path::PathBuf::from(std::env::var_os("HOME").unwrap());
        let picture_before = now_ms() - 60_000.0;
        let state = json!({ "version": 1, "previews": [
            entry(&project, json!({
                "path": "/map",
                "pid": std::process::id(),
                "pictureAt": picture_before,
            })),
            // Its site did not change.
            entry(&project, json!({
                "localPort": 4174,
                "pid": std::process::id(),
                "siteDir": "sites/lisbon",
                "pictureAt": picture_before,
            })),
            // Its check hangs.
            entry(&project, json!({
                "localPort": 4175,
                "pid": std::process::id(),
                "siteDir": "sites/porto",
                "pictureAt": picture_before,
            })),
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

        // A read-only turn changed nothing: nothing runs.
        runtime.block_on(async {
            PictureRetake::start(
                &workspace,
                project,
                true,
                &[changed("sites/seville/index.html")],
                None,
            )
            .finish()
            .await;
        });
        assert_eq!(take_seen(), "");

        // A turn that changed the map's site checks it, and only it.
        runtime.block_on(async {
            PictureRetake::start(
                &workspace,
                project,
                false,
                &[changed("sites/seville/index.html")],
                None,
            )
            .finish()
            .await;
        });
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
                format!("args=preview check --port 4173 --path /map --desktop --timeout 10000 --out {out} --json").as_str(),
                format!("cwd={}", workspace_real.display()).as_str(),
                "job=job-token",
                "machine=",
                "model=",
                format!("out={out}").as_str(),
            ]
        );
        assert!(
            !Path::new(&out).exists(),
            "the check's screenshots are removed"
        );

        // A check that runs out of time ends with every helper it started.
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

        // A stopped turn ends its check at once.
        let cancel = JobCancelSignal::new();
        let started = Instant::now();
        runtime.block_on(async {
            let retake = PictureRetake::start(
                &workspace,
                project,
                false,
                &[changed("sites/porto/index.html")],
                Some(cancel.clone()),
            );
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
            let retake = PictureRetake::start(
                &workspace,
                project,
                false,
                &[changed("sites/porto/index.html")],
                None,
            );
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
    }
}
