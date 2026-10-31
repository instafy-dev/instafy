//! A turn that changed the site behind an open preview ends with a new
//! picture on the preview's card.
//!
//! Octo checks a site after it changes it (`instafy preview check`), and that
//! check takes the card's picture again. A turn that stops before its check
//! leaves the card with the picture from before the change: a map opened
//! early keeps its blank starter, with none of the places added after it.
//! So when a turn ends, each preview this machine has open for the space whose
//! site the turn changed after its picture was taken is checked once more, by
//! the same command, with the turn's own credentials.
//!
//! `instafy preview open` records each preview in the CLI's state file
//! (`~/.instafy/cli-preview-state.json`): its port and path, the folder its
//! site's server runs from (`siteDir`) and when its picture was taken
//! (`pictureAt`, milliseconds since the epoch). A preview without a recorded
//! folder counts every change in the workspace, and one without a picture
//! time counts every change as newer.

use std::path::{Component, Path};
use std::process::Stdio;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde_json::Value as JsonValue;
use tokio::process::Command;
use tracing::{info, warn};
use uuid::Uuid;

use super::CodexFileDescriptor;
use crate::model_environment::is_model_child_excluded_env_key;

/// The CLI's record of the previews it opened on this machine, under `HOME`.
const PREVIEW_STATE_RELATIVE_PATH: &str = ".instafy/cli-preview-state.json";
/// At most this many previews are checked when one turn ends.
const MAX_CHECKS: usize = 3;
/// The page load limit each check gets (the CLI's own default is 30 s).
const CHECK_PAGE_LOAD_TIMEOUT_MS: &str = "15000";
/// How long the end of a turn waits for the checks, picture uploads included.
const CHECKS_TIMEOUT: Duration = Duration::from_secs(60);
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
/// for `project_id`, with a tunnel client still running, whose site folder
/// holds a path in `changed` that changed after the card's picture was taken.
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
        let site_dir = entry.get("siteDir").and_then(JsonValue::as_str);
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
/// is the whole workspace or was not recorded.
fn in_site(changed: &str, site_dir: Option<&str>) -> bool {
    let site = site_dir
        .map(|dir| dir.trim().trim_start_matches("./").trim_end_matches('/'))
        .unwrap_or("");
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

/// Whether a changed path changed after the picture was taken: it was written
/// at or after that time, it is gone (a removal), it is a folder, or there is
/// no picture time.
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

/// Checks each open preview whose site this turn changed after its picture
/// was taken, which takes the card's picture again. It runs the same
/// `instafy preview check` a turn runs, from the workspace, with the turn's
/// own credentials, and waits a bounded time in all; a check that fails or
/// runs out of time leaves the card's picture as it was.
pub(super) async fn retake_stale_pictures(
    workspace_dir: &Path,
    project_id: &Uuid,
    changed: &[String],
) {
    if changed.is_empty() {
        return;
    }
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
    let deadline = Instant::now() + CHECKS_TIMEOUT;
    for preview in stale_pictures(&state, project_id, workspace_dir, changed, client_runs) {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        let mut command = Command::new("instafy");
        command
            .args([
                "preview",
                "check",
                "--port",
                &preview.port.to_string(),
                "--path",
                &preview.path,
                "--timeout",
                CHECK_PAGE_LOAD_TIMEOUT_MS,
                "--json",
            ])
            .current_dir(workspace_dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
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
        match tokio::time::timeout(left, command.status()).await {
            Ok(Ok(status)) => info!(
                port = preview.port,
                path = %preview.path,
                exit_code = ?status.code(),
                "checked an open preview whose site the turn changed, for its card's picture"
            ),
            Ok(Err(error)) => warn!(
                port = preview.port,
                %error,
                "could not check an open preview after the turn; its card keeps its picture"
            ),
            Err(_) => warn!(
                port = preview.port,
                "checking an open preview after the turn ran out of time; its card keeps its picture"
            ),
        }
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
            entry(&project, json!({ "siteDir": "sites/seville", "pictureAt": picture_before })),
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
    fn a_picture_taken_after_the_change_stays() {
        let dir = workspace();
        let project = Uuid::new_v4();
        // The turn's own check ran after its last change.
        let picture_after = now_ms() + 60_000.0;
        let state = json!({ "version": 1, "previews": [
            entry(&project, json!({ "siteDir": "sites/seville", "pictureAt": picture_after })),
        ]});
        assert!(stale(state, &project, dir.path(), &["sites/seville/index.html"]).is_empty());
    }

    #[test]
    fn only_a_change_to_the_previews_own_site_counts() {
        let dir = workspace();
        let project = Uuid::new_v4();
        let state = json!({ "version": 1, "previews": [
            entry(&project, json!({ "siteDir": "sites/seville", "pictureAt": now_ms() - 60_000.0 })),
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
    fn a_preview_with_no_folder_or_picture_time_counts_every_change() {
        let dir = workspace();
        let project = Uuid::new_v4();
        let no_folder = json!({ "version": 1, "previews": [
            entry(&project, json!({ "pictureAt": now_ms() - 60_000.0 })),
        ]});
        assert_eq!(
            stale(no_folder, &project, dir.path(), &["notes/todo.md"]).len(),
            1
        );
        let whole_workspace = json!({ "version": 1, "previews": [
            entry(&project, json!({ "siteDir": ".", "pictureAt": now_ms() - 60_000.0 })),
        ]});
        assert_eq!(
            stale(whole_workspace, &project, dir.path(), &["notes/todo.md"]).len(),
            1
        );
        let no_picture_time = json!({ "version": 1, "previews": [
            entry(&project, json!({ "siteDir": "sites/seville" })),
        ]});
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

    #[test]
    fn another_spaces_preview_or_a_stopped_tunnel_is_left_alone() {
        let dir = workspace();
        let project = Uuid::new_v4();
        let other = Uuid::new_v4();
        let state = json!({ "version": 1, "previews": [
            entry(&other, json!({ "siteDir": "sites/seville" })),
            entry(&project, json!({ "siteDir": "sites/seville", "pid": 7 })),
            entry(&project, json!({ "siteDir": "sites/seville", "localPort": 0 })),
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

    // It runs `instafy preview check` for the stale picture, from the
    // workspace, with the turn's own credentials and never the machine's.
    #[cfg(unix)]
    #[test]
    fn the_turns_own_check_runs_for_a_stale_picture() {
        use std::os::unix::fs::PermissionsExt;
        const CHILD_MARKER: &str = "INSTAFY_PREVIEW_PICTURES_TEST_CHILD";
        const TEST_NAME: &str =
            "jobs::preview_pictures::tests::the_turns_own_check_runs_for_a_stale_picture";

        // HOME and PATH are process-wide: run in a test process of its own.
        if std::env::var_os(CHILD_MARKER).is_none() {
            let sandbox = tempfile::tempdir().unwrap();
            let bin = sandbox.path().join("bin");
            let home = sandbox.path().join("home");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::create_dir_all(home.join(".instafy")).unwrap();
            let seen = sandbox.path().join("seen");
            std::fs::write(
                bin.join("instafy"),
                format!(
                    "#!/bin/sh\n{{ echo \"args=$*\"; echo \"cwd=$(pwd -P)\"; echo \"job=${{CONTROLLER_ACCESS_TOKEN:-}}\"; echo \"machine=${{RUNTIME_ACCESS_TOKEN:-}}\"; echo \"model=${{CODEX_API_KEY:-}}\"; }} >> '{}'\n",
                    seen.display()
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
            let seen = std::fs::read_to_string(seen).unwrap();
            let workspace = sandbox.path().join("workspace").canonicalize().unwrap();
            assert_eq!(
                seen.lines().collect::<Vec<_>>(),
                vec![
                    "args=preview check --port 4173 --path /map --timeout 15000 --json".to_string(),
                    format!("cwd={}", workspace.display()),
                    "job=job-token".to_string(),
                    "machine=".to_string(),
                    "model=".to_string(),
                ]
            );
            return;
        }

        let sandbox = std::path::PathBuf::from(std::env::var_os(CHILD_MARKER).unwrap());
        let workspace = sandbox.join("workspace");
        std::fs::create_dir_all(workspace.join("sites/seville")).unwrap();
        std::fs::write(workspace.join("sites/seville/index.html"), "x").unwrap();
        let project = Uuid::new_v4();
        let home = std::path::PathBuf::from(std::env::var_os("HOME").unwrap());
        let state = json!({ "version": 1, "previews": [
            entry(&project, json!({
                "path": "/map",
                "pid": std::process::id(),
                "siteDir": "sites/seville",
                "pictureAt": now_ms() - 60_000.0,
            })),
            // Its site did not change.
            entry(&project, json!({
                "localPort": 4174,
                "pid": std::process::id(),
                "siteDir": "sites/porto",
                "pictureAt": now_ms() - 60_000.0,
            })),
        ]});
        std::fs::write(home.join(PREVIEW_STATE_RELATIVE_PATH), state.to_string()).unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(retake_stale_pictures(
            &workspace,
            &project,
            &["sites/seville/index.html".to_string()],
        ));
    }
}
