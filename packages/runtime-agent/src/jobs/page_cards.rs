//! A page a building turn made gets its card before the reply.
//!
//! A page someone asked for ends with its card: a check that passes (`instafy bind check`) posts
//! it, and a turn posts any other site's with `instafy preview open`. A turn that skips that step
//! leaves a page nobody can open. In a local test (Nov 9) a turn wrote a comparison by hand in
//! `sites/framework-13-vs-16/` and ran no card command, and the next turn filled it from the
//! maker's pages: no card, no server, and the row under each reply named the folder. Nothing at a
//! turn's end noticed a page folder with no card.
//!
//! So at a building turn's end, once its change is saved, the runtime takes that step for each
//! page the turn left without a card, before the reply: a folder under `sites/` whose `index.html`
//! the turn made (new in this turn's change) and that still holds it, whose card was never opened
//! (the space's record of its pages, [`space_pages::PAGES_RECORD`], has no row for it, in this
//! chat or another) and that no preview of the space on this machine shows (the CLI's record of
//! its previews). It runs the binder's card step from the workspace, `instafy bind card
//! ./<folder> --json`: the step a check that passes takes, titled from the page as that check
//! titles it, which runs `instafy preview open --title "<title>" --serve-cmd "instafy bind serve .
//! --port {port} --preview" --start` in the folder. That serves the page so it outlives the turn,
//! posts its card to the turn's chat with the turn's own credential, as the turn's own command
//! would, and writes the page in the record for this chat, so the row under the reply names the
//! page by its title.
//!
//! Never for a page the record holds (another chat's page, whose folder is that chat's to change,
//! or this chat's, whose card is in the chat), one a preview shows, a turn that may not write, a
//! turn that was stopped (its lease is gone, or a Stop comes while the card is posted), or a turn
//! that made no page; a turn that failed, or whose save failed, never gets here. A page that was
//! there before the turn is left as it was, changed or not: with no row, nothing says which chat
//! made it or whether its card was opened (before the record began, say), and a card from this
//! turn would be a second one, or would give another chat's page to this chat. A site an
//! installed skill serves its own way (a map's host) says nothing in its folder of how it is
//! served, so the runtime cannot read that skill's command there: a folder that a command of an
//! installed skill named in the turn is left as it was, and that skill's own steps post its card.
//!
//! The reply waits for the cards at most [`CARD_TIMEOUT`] in all, and says nothing of a card
//! either way: a card that could not be posted is logged, never shown.

use std::ffi::OsString;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value as JsonValue;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::Instant;
use tracing::{info, warn};
use uuid::Uuid;

use super::preview_pictures::{PREVIEW_STATE_RELATIVE_PATH, changed_paths, reap_group};
use super::space_pages;
use super::{CodexFileDescriptor, FileChangeKind};
use crate::browser_host::process::group;
use crate::job_cancel::JobCancelSignal;
use crate::model_environment::{
    PAGE_CARD_ENV_KEYS, PREVIEW_CHECK_ENV_KEYS, allowlisted_environment,
};

/// Where a space's pages are made: each in a folder of its own, `sites/<name>/`.
const PAGES_FOLDER: &str = "sites";
/// A page's own file: a turn that made or changed it made or changed the page.
const PAGE_FILE: &str = "index.html";
/// At most this many cards are posted at one turn's end.
const MAX_CARDS: usize = 3;
/// How long the reply waits for the turn's cards, in all. Serving a page and posting its card
/// takes a few seconds, its picture included.
const CARD_TIMEOUT: Duration = Duration::from_secs(60);
/// What the card's command prints (its answer, as JSON) is small.
const MAX_ANSWER_BYTES: u64 = 64 * 1024;
/// The most of the command's own words about a card it could not post that go into the log.
const MAX_ERROR_CHARS: usize = 300;

/// Posts the card of each page the turn left without one ([`pages_without_a_card`]), before the
/// reply. `files` are the turn's files as its save lists them, `events` its Codex events, from
/// each of its passes. One page at a time, at most [`MAX_CARDS`], for at most [`CARD_TIMEOUT`] in
/// all; a Stop ends it.
pub(super) async fn post_missing_cards(
    workspace_dir: &Path,
    project_id: &Uuid,
    read_only: bool,
    files: &[CodexFileDescriptor],
    events: &[&[JsonValue]],
    cancel: Option<&JobCancelSignal>,
) {
    post_missing_cards_within(
        workspace_dir,
        project_id,
        read_only,
        files,
        events,
        cancel,
        CARD_TIMEOUT,
    )
    .await;
}

async fn post_missing_cards_within(
    workspace_dir: &Path,
    project_id: &Uuid,
    read_only: bool,
    files: &[CodexFileDescriptor],
    events: &[&[JsonValue]],
    cancel: Option<&JobCancelSignal>,
    timeout: Duration,
) {
    if read_only {
        return;
    }
    let pages = pages_made(workspace_dir, files);
    if pages.is_empty() {
        return;
    }
    let state = match std::env::var_os("HOME") {
        Some(home) => tokio::fs::read_to_string(Path::new(&home).join(PREVIEW_STATE_RELATIVE_PATH))
            .await
            .ok()
            .and_then(|text| serde_json::from_str::<JsonValue>(&text).ok()),
        None => None,
    };
    let unopened = pages_without_a_card(
        &pages,
        &space_pages::recorded_page_folders(workspace_dir),
        state.as_ref(),
        project_id,
    );
    // A site an installed skill serves its own way, which its folder doesn't say: left as it was.
    let skills =
        named_by_installed_skills(events, &space_pages::installed_page_commands(), &unopened);
    for folder in &skills {
        info!(
            folder = %folder,
            "a page an installed skill's command made has no card; that skill posts it"
        );
    }
    let folders: Vec<String> = unopened
        .into_iter()
        .filter(|folder| !skills.contains(folder))
        .collect();
    if folders.is_empty() {
        return;
    }
    // A Stop that reached the controller once the turn's change was saved: the turn is stopped.
    if let Some(cancel) = cancel
        && !cancel.lease_held().await
    {
        info!("the turn was stopped: no card for the page it left without one");
        return;
    }
    let environment = card_environment();
    let deadline = Instant::now() + timeout;
    for folder in folders.iter().take(MAX_CARDS) {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            warn!(folder = %folder, "no time left to post the card of a page the turn left without one");
            break;
        }
        if post_card(workspace_dir, folder, &environment, left, cancel).await == Posted::Stopped {
            break;
        }
    }
}

/// The page folders (`sites/<name>`) whose `index.html` the turn made (`files`, as its save lists
/// them: one it created), each once, that are still folders holding it.
fn pages_made(workspace_dir: &Path, files: &[CodexFileDescriptor]) -> Vec<String> {
    let made: Vec<CodexFileDescriptor> = files
        .iter()
        .filter(|file| {
            file.change
                .as_ref()
                .is_some_and(|change| change.kind == FileChangeKind::Created)
        })
        .cloned()
        .collect();
    let mut folders: Vec<String> = Vec::new();
    for path in &changed_paths(&made) {
        let parts: Vec<&str> = path.split('/').collect();
        let [top, name, file] = parts.as_slice() else {
            continue;
        };
        if *top != PAGES_FOLDER || *file != PAGE_FILE || name.is_empty() || name.starts_with('.') {
            continue;
        }
        let folder = format!("{PAGES_FOLDER}/{name}");
        let is_page = std::fs::symlink_metadata(workspace_dir.join(&folder))
            .is_ok_and(|metadata| metadata.is_dir())
            && std::fs::symlink_metadata(workspace_dir.join(&folder).join(PAGE_FILE))
                .is_ok_and(|metadata| metadata.is_file());
        if is_page && !folders.contains(&folder) {
            folders.push(folder);
        }
    }
    folders
}

/// The `pages` with no card: the record holds no row for them (`recorded`, every folder it holds,
/// whichever chat's), and no preview of `project_id` in the CLI's record of its previews (`state`)
/// shows them.
fn pages_without_a_card(
    pages: &[String],
    recorded: &[String],
    state: Option<&JsonValue>,
    project_id: &Uuid,
) -> Vec<String> {
    pages
        .iter()
        .filter(|folder| !recorded.contains(folder))
        .filter(|folder| !state.is_some_and(|state| preview_shows(state, project_id, folder)))
        .cloned()
        .collect()
}

/// Whether a preview of `project_id` that the CLI recorded (`state`) shows `folder`: one whose site
/// is served from that folder, or the page at that folder of a site served from a folder above it.
fn preview_shows(state: &JsonValue, project_id: &Uuid, folder: &str) -> bool {
    let project = project_id.to_string();
    let Some(previews) = state.get("previews").and_then(JsonValue::as_array) else {
        return false;
    };
    previews
        .iter()
        .filter(|entry| {
            entry.get("projectId").and_then(JsonValue::as_str) == Some(project.as_str())
        })
        .any(|entry| {
            let Some(site_dir) = entry.get("siteDir").and_then(JsonValue::as_str) else {
                return false;
            };
            let site = site_dir
                .trim()
                .trim_start_matches("./")
                .trim_end_matches('/');
            let page = entry
                .get("path")
                .and_then(JsonValue::as_str)
                .unwrap_or("")
                .trim_matches('/');
            let shown = match (site, page) {
                ("" | ".", page) => page.to_string(),
                (site, "") => site.to_string(),
                (site, page) => format!("{site}/{page}"),
            };
            shown == folder
        })
}

/// The folders among `folders` that a command of an installed skill (`commands`, the commands
/// installed skill packs put on PATH) named in the turn's `events`: that skill serves its site its
/// own way.
fn named_by_installed_skills(
    events: &[&[JsonValue]],
    commands: &[String],
    folders: &[String],
) -> Vec<String> {
    let mut named: Vec<String> = Vec::new();
    if commands.is_empty() || folders.is_empty() {
        return named;
    }
    for item in events
        .iter()
        .flat_map(|events| events.iter())
        .filter_map(command_item)
    {
        let words = command_words(item);
        let runs_a_skill = words.iter().any(|word| {
            commands
                .iter()
                .any(|command| word == command || word.ends_with(&format!("/{command}")))
        });
        if !runs_a_skill {
            continue;
        }
        for folder in folders {
            if !named.contains(folder) && words.iter().any(|word| names_folder(word, folder)) {
                named.push(folder.clone());
            }
        }
    }
    named
}

/// A command the turn ran: the item of a `command_execution` event.
fn command_item(event: &JsonValue) -> Option<&JsonValue> {
    let item = event.get("item")?;
    (item.get("type").and_then(JsonValue::as_str) == Some("command_execution")).then_some(item)
}

/// The words of a command, as far as naming a program or a folder goes: its argv, a shell's script
/// split on spaces, quotes and the shell's operators.
fn command_words(item: &JsonValue) -> Vec<String> {
    let argv: Vec<&str> = item
        .get("command_argv")
        .and_then(JsonValue::as_array)
        .map(|words| words.iter().filter_map(JsonValue::as_str).collect())
        .unwrap_or_default();
    let text = match argv.as_slice() {
        [shell, flag, script, ..]
            if matches!(
                Path::new(shell).file_name().and_then(|name| name.to_str()),
                Some("bash" | "sh" | "zsh" | "dash")
            ) && flag.starts_with('-')
                && flag.contains('c') =>
        {
            (*script).to_string()
        }
        [] => item
            .get("command")
            .and_then(JsonValue::as_str)
            .unwrap_or_default()
            .to_string(),
        words => words.join(" "),
    };
    text.split(|c: char| c.is_whitespace() || "'\"`;&|()<>{}=$".contains(c))
        .filter(|word| !word.is_empty())
        .map(str::to_string)
        .collect()
}

/// Whether a command's word names `folder` (`sites/<name>`): the folder or a path in it, from the
/// workspace or from anywhere above it.
fn names_folder(word: &str, folder: &str) -> bool {
    let word = word.trim_start_matches("./").trim_end_matches('/');
    word == folder
        || word.starts_with(&format!("{folder}/"))
        || word.ends_with(&format!("/{folder}"))
        || word.contains(&format!("/{folder}/"))
}

/// What the card's command may have of this process's environment: the persistent helper
/// baseline, the settings the card's picture reads (as a check's), and what posting the card to
/// the turn's chat reads, the turn's own credential among them ([`PAGE_CARD_ENV_KEYS`]). Never
/// another credential: not the turn's granted secrets, nor Instafy's, a model's or this runtime's
/// own.
fn card_environment() -> Vec<(OsString, OsString)> {
    let keys: Vec<&str> = PREVIEW_CHECK_ENV_KEYS
        .iter()
        .chain(PAGE_CARD_ENV_KEYS)
        .copied()
        .collect();
    allowlisted_environment(&keys)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Posted {
    Yes,
    No,
    Stopped,
}

/// Runs `instafy bind card ./<folder> --json` from the workspace, for at most `left`, and logs what
/// it answered. It leads a process group of its own, and what is left of the group goes with it;
/// the site the card serves and the card's tunnel run in their own sessions and stay.
async fn post_card(
    workspace_dir: &Path,
    folder: &str,
    environment: &[(OsString, OsString)],
    left: Duration,
    cancel: Option<&JobCancelSignal>,
) -> Posted {
    let mut command = Command::new("instafy");
    command
        .args(["bind", "card"])
        .arg(format!("./{folder}"))
        .arg("--json")
        .current_dir(workspace_dir)
        .env_clear()
        .envs(environment.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            warn!(folder, %error, "could not post the card of a page the turn left without one");
            return Posted::No;
        }
    };
    let mut leader = child.id().and_then(|pid| i32::try_from(pid).ok());
    let mut stdout = child.stdout.take();
    let ended = {
        let answered = async {
            let mut printed = Vec::new();
            if let Some(stdout) = stdout.as_mut() {
                let _ = stdout
                    .take(MAX_ANSWER_BYTES)
                    .read_to_end(&mut printed)
                    .await;
            }
            (child.wait().await, printed)
        };
        let stopped = async {
            match cancel {
                Some(cancel) => cancel.cancelled().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            (status, printed) = answered => Some((status, printed)),
            () = tokio::time::sleep(left) => {
                warn!(folder, "posting the card of a page the turn left without one ran out of time");
                None
            }
            () = stopped => {
                info!(folder, "the turn was stopped while the card of its page was posted");
                let pgid = leader.take().filter(|pgid| *pgid > 0);
                if let Some(pgid) = pgid {
                    group::kill(pgid);
                }
                let _ = child.start_kill();
                let _ = child.wait().await;
                if let Some(pgid) = pgid {
                    reap_group(pgid).await;
                }
                return Posted::Stopped;
            }
        }
    };
    // What is left of the command's group: all of it when it ran out of time.
    if let Some(pgid) = leader.filter(|pgid| *pgid > 0) {
        group::kill(pgid);
        let _ = child.start_kill();
        let _ = child.wait().await;
        reap_group(pgid).await;
    }
    let Some((status, printed)) = ended else {
        return Posted::No;
    };
    let answer = serde_json::from_slice::<JsonValue>(&printed).unwrap_or(JsonValue::Null);
    match status {
        Ok(status) if status.success() && answer.get("posted") == Some(&JsonValue::Bool(true)) => {
            info!(
                folder,
                "posted the card of a page the turn left without one"
            );
            Posted::Yes
        }
        Ok(status) => {
            let said = answer
                .get("reason")
                .or_else(|| answer.get("error"))
                .and_then(JsonValue::as_str)
                .unwrap_or("no answer")
                .chars()
                .take(MAX_ERROR_CHARS)
                .collect::<String>();
            if status.code() == Some(2) {
                info!(folder, said = %said, "no card to post for a page the turn left without one");
            } else {
                warn!(
                    folder,
                    exit_code = ?status.code(),
                    said = %said,
                    "the card of a page the turn left without one was not posted"
                );
            }
            Posted::No
        }
        Err(error) => {
            warn!(folder, %error, "could not post the card of a page the turn left without one");
            Posted::No
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{FileChangeDescriptor, FileChangeKind};
    use super::*;
    use serde_json::json;

    fn file(path: &str, kind: FileChangeKind) -> CodexFileDescriptor {
        CodexFileDescriptor {
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
        }
    }

    fn write(dir: &Path, path: &str) {
        let path = dir.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "<title>A page</title>\n").unwrap();
    }

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn command(argv: &[&str]) -> JsonValue {
        json!({"type": "item.completed", "item": {
            "type": "command_execution", "command": argv.join(" "), "command_argv": argv, "status": "completed",
        }})
    }

    // A page is a folder of `sites/` whose own page the turn made, still there: not a file it only
    // read, another file of the page, a page further down, one it removed, or one that was there
    // before the turn, whatever the turn changed in it.
    #[test]
    fn a_page_is_a_sites_folder_whose_index_the_turn_made() {
        let workspace = tempfile::tempdir().unwrap();
        for path in [
            "sites/framework-13-vs-16/index.html",
            "sites/porto/index.html",
            "sites/porto/data.json",
            "sites/read/index.html",
            "sites/gallery/a/index.html",
            "sites/index.html",
            "notes/index.html",
        ] {
            write(workspace.path(), path);
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(
            workspace.path().join("sites/porto"),
            workspace.path().join("sites/linked"),
        )
        .unwrap();
        let files = [
            file(
                "sites/framework-13-vs-16/index.html",
                FileChangeKind::Created,
            ),
            file("sites/porto/data.json", FileChangeKind::Changed),
            file("sites/read/index.html", FileChangeKind::Read),
            file("sites/gallery/a/index.html", FileChangeKind::Created),
            file("sites/index.html", FileChangeKind::Changed),
            file("notes/index.html", FileChangeKind::Created),
            file("sites/gone/index.html", FileChangeKind::Deleted),
            file("sites/linked/index.html", FileChangeKind::Changed),
            file(
                "./sites/framework-13-vs-16/index.html",
                FileChangeKind::Changed,
            ),
        ];
        assert_eq!(
            pages_made(workspace.path(), &files),
            strings(&["sites/framework-13-vs-16"])
        );
        // A page that was there before the turn, which the turn changed: its card may be in a chat
        // already (opened before the space's record of its pages began), or the page may be
        // another chat's whose card was never posted. Either way it is not this turn's to card.
        let changed = [
            file("sites/porto/index.html", FileChangeKind::Changed),
            file("sites/porto/data.json", FileChangeKind::Created),
        ];
        assert!(pages_made(workspace.path(), &changed).is_empty());
        let made = [file("./sites/porto/index.html", FileChangeKind::Created)];
        assert_eq!(
            pages_made(workspace.path(), &made),
            strings(&["sites/porto"])
        );
    }

    // No card for a page whose card was opened before (the record holds it, in this chat or
    // another), or one a preview of this space shows.
    #[test]
    fn a_page_with_a_card_or_another_chats_gets_none() {
        let project = Uuid::new_v4();
        let pages = strings(&[
            "sites/new",
            "sites/mine",
            "sites/theirs",
            "sites/shown",
            "sites/gallery-page",
            "sites/elsewhere",
        ]);
        let state = json!({ "previews": [
            { "projectId": project.to_string(), "siteDir": "./sites/shown/", "path": "/" },
            { "projectId": project.to_string(), "siteDir": "sites", "path": "/gallery-page/" },
            { "projectId": Uuid::new_v4().to_string(), "siteDir": "sites/elsewhere", "path": "/" },
            { "projectId": project.to_string(), "siteDir": ".", "path": "/" },
            { "projectId": project.to_string(), "path": "/" },
        ]});
        assert_eq!(
            pages_without_a_card(
                &pages,
                &strings(&["sites/mine", "sites/theirs"]),
                Some(&state),
                &project,
            ),
            strings(&["sites/new", "sites/elsewhere"])
        );
        // with no record of previews, only the space's record counts
        assert_eq!(pages_without_a_card(&pages, &[], None, &project), pages);
        // a page served from the workspace's own site, at its folder's address
        let root = json!({ "previews": [
            { "projectId": project.to_string(), "siteDir": ".", "path": "/sites/new/" },
        ]});
        assert!(preview_shows(&root, &project, "sites/new"));
        assert!(!preview_shows(&root, &project, "sites/news"));
    }

    // A site an installed skill serves its own way: a command that runs that skill's program and
    // names the folder, however the turn wrote it. A folder only a plain command named, or another
    // folder the skill's command named, is not that skill's.
    #[test]
    fn a_folder_an_installed_skills_command_named_is_that_skills() {
        let folders = strings(&["sites/seville", "sites/framework-13-vs-16", "sites/porto"]);
        let commands = strings(&["uw"]);
        let first = [
            command(&[
                "/bin/bash",
                "-lc",
                "uw new sites/seville --title \"Three days in Seville\" && (cd sites/seville && instafy preview open --title \"Three days in Seville\" --serve-cmd \"uw host . --port {port}\" --start --json)",
            ]),
            command(&[
                "bash",
                "-lc",
                "mkdir -p sites/framework-13-vs-16 && printf '%s' '<title>13 vs 16</title>' > sites/framework-13-vs-16/index.html",
            ]),
        ];
        let second = [
            json!({"type": "item.started", "item": {
                "type": "command_execution", "command": "/opt/skills/interactive-map/bin/uw fit /workspace/space/sites/porto/",
            }}),
            json!({"type": "item.completed", "item": { "type": "agent_message", "text": "uw sites/framework-13-vs-16" }}),
        ];
        assert_eq!(
            named_by_installed_skills(&[&first, &second], &commands, &folders),
            strings(&["sites/seville", "sites/porto"])
        );
        assert!(named_by_installed_skills(&[&first, &second], &[], &folders).is_empty());
        assert_eq!(
            command_words(&json!({"command_argv": ["uw", "validate", "./sites/seville/"]})),
            strings(&["uw", "validate", "./sites/seville/"])
        );
        assert!(names_folder(
            "./sites/seville/data/places.json",
            "sites/seville"
        ));
        assert!(!names_folder("sites/seville-2", "sites/seville"));
    }

    /// Whether a process is gone within two seconds: a zombie counts as gone.
    #[cfg(unix)]
    fn gone(pid: &str) -> bool {
        (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            let state = std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", pid])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&state.stdout);
            let state = state.trim();
            state.is_empty() || state.starts_with('Z')
        })
    }

    /// A stand-in `instafy`: it notes what ran it, where, and which of the settings and credentials
    /// it was given; `bind card` for `sites/fails` fails, for `sites/hangs` starts a helper in its
    /// group and hangs, for `sites/none` answers that there is no card to post, and for any other
    /// folder answers that it posted the card.
    #[cfg(unix)]
    fn stand_in(bin: &Path, seen: &Path) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(
            bin.join("instafy"),
            format!(
                r#"#!/bin/sh
seen='{seen}'
echo "ran $* | cwd=$(pwd -P) | job=${{CONTROLLER_ACCESS_TOKEN:-}} | chat=${{INSTAFY_CONVERSATION_ID:-}} | space=${{SPACE_ID:-}} | url=${{CONTROLLER_BASE_URL:-}} | runtime=${{RUNTIME_ID:-}} | machine=${{RUNTIME_ACCESS_TOKEN:-}} | model=${{CODEX_API_KEY:-}} | secret=${{BOOKING_PARTNER:-}} | github=${{GITHUB_TOKEN:-}}" >> "$seen"
case "$3" in
  ./sites/fails) echo '{{"posted":false,"error":"the preview could not start"}}'; exit 1 ;;
  ./sites/hangs) sleep 300 & echo "helper=$!" >> "$seen"; sleep 300 ;;
  ./sites/none) echo '{{"posted":false,"reason":"a preview shows it"}}'; exit 2 ;;
esac
echo '{{"posted":true,"title":"A page","command":"instafy preview open","answer":{{"status":"live"}}}}'
"#,
                seen = seen.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(bin.join("instafy"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
    }

    // The card step runs the binder's card command from the workspace for each page the turn left
    // without a card, with the turn's credential and chat and nothing else secret, one page at a
    // time; a command that fails or runs out of time ends with nothing left of its group, and a
    // Stop ends the step, before it starts or while a card is posted.
    #[cfg(unix)]
    #[test]
    fn the_card_step_runs_the_binders_card_command_for_each_page_with_the_turns_credential() {
        const CHILD_MARKER: &str = "INSTAFY_PAGE_CARDS_TEST_CHILD";
        const TEST_NAME: &str = "jobs::page_cards::tests::the_card_step_runs_the_binders_card_command_for_each_page_with_the_turns_credential";
        // HOME, PATH and the credentials are process-wide: run in a test process of its own.
        if std::env::var_os(CHILD_MARKER).is_none() {
            let sandbox = tempfile::tempdir().unwrap();
            let bin = sandbox.path().join("bin");
            let home = sandbox.path().join("home");
            std::fs::create_dir_all(&bin).unwrap();
            std::fs::create_dir_all(home.join(".instafy")).unwrap();
            stand_in(&bin, &sandbox.path().join("seen"));
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
                .env(
                    "INSTAFY_CONVERSATION_ID",
                    "8c1f6f8e-3c2b-4a43-9a9e-2f2f5e0d1b7a",
                )
                .env("SPACE_ID", "space-1")
                .env("CONTROLLER_BASE_URL", "http://controller.test")
                .env("RUNTIME_ID", "runtime-1")
                .env("RUNTIME_ACCESS_TOKEN", "machine-token")
                .env("CODEX_API_KEY", "model-key")
                // the turn's granted secrets
                .env("BOOKING_PARTNER", "plain-named-secret")
                .env("GITHUB_TOKEN", "space-secret")
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
        for page in ["new", "fails", "none", "hangs", "later", "mine"] {
            write(&workspace, &format!("sites/{page}/index.html"));
        }
        std::fs::create_dir_all(workspace.join(".instafy/pages")).unwrap();
        std::fs::write(
            workspace.join(space_pages::PAGES_RECORD),
            json!({"version": 1, "pages": [{"folder": "sites/mine", "title": "Mine", "server": ["instafy", "bind"]}]})
                .to_string(),
        )
        .unwrap();
        let project = Uuid::new_v4();
        let made = |pages: &[&str]| -> Vec<CodexFileDescriptor> {
            pages
                .iter()
                .map(|page| file(&format!("sites/{page}/index.html"), FileChangeKind::Created))
                .collect()
        };
        let seen = || -> Vec<String> {
            std::fs::read_to_string(&seen_file)
                .unwrap_or_default()
                .lines()
                .map(str::to_string)
                .collect()
        };
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let run = |files: Vec<CodexFileDescriptor>,
                   read_only: bool,
                   cancel: Option<JobCancelSignal>,
                   timeout: Duration| {
            runtime.block_on(post_missing_cards_within(
                &workspace,
                &project,
                read_only,
                &files,
                &[],
                cancel.as_ref(),
                timeout,
            ))
        };
        let workspace_real = workspace.canonicalize().unwrap();

        // A page the turn made, one whose card fails, one with none to post, and this chat's page:
        // the card command for each of the first three, one at a time, from the workspace, with
        // the turn's credential, chat and space, and none of the other credentials or secrets.
        run(
            made(&["new", "fails", "none", "mine"]),
            false,
            None,
            Duration::from_secs(30),
        );
        let lines = seen();
        let expected = |page: &str| {
            format!(
                "ran bind card ./sites/{page} --json | cwd={} | job=job-token | chat=8c1f6f8e-3c2b-4a43-9a9e-2f2f5e0d1b7a | space=space-1 | url=http://controller.test | runtime=runtime-1 | machine= | model= | secret= | github=",
                workspace_real.display()
            )
        };
        assert_eq!(
            lines,
            vec![expected("fails"), expected("new"), expected("none")]
        );

        // A turn that may not write, or that changed no page: nothing runs.
        run(made(&["later"]), true, None, Duration::from_secs(30));
        run(Vec::new(), false, None, Duration::from_secs(30));
        assert_eq!(seen().len(), 3);

        // A stopped turn: nothing runs.
        let stopped = JobCancelSignal::new();
        stopped.cancel();
        run(
            made(&["later"]),
            false,
            Some(stopped),
            Duration::from_secs(30),
        );
        assert_eq!(seen().len(), 3);

        // A command that hangs is stopped when the time is up, with the helper it started; the
        // pages after it get no time.
        let started = std::time::Instant::now();
        run(
            made(&["hangs", "later"]),
            false,
            None,
            Duration::from_secs(2),
        );
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{:?}",
            started.elapsed()
        );
        let lines = seen();
        assert_eq!(lines.len(), 5, "{lines:#?}");
        assert_eq!(lines[3], expected("hangs"));
        let helper = lines[4].trim_start_matches("helper=");
        assert!(gone(helper), "the hung command's helper {helper} is gone");

        // A Stop while a card is posted ends the step at once, with what the command started.
        let stop = JobCancelSignal::new();
        let stopping = stop.clone();
        let started = std::time::Instant::now();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(500));
            stopping.cancel();
        });
        run(
            made(&["hangs", "later"]),
            false,
            Some(stop),
            Duration::from_secs(30),
        );
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "{:?}",
            started.elapsed()
        );
        let lines = seen();
        assert_eq!(lines.len(), 7, "{lines:#?}");
        assert_eq!(lines[5], expected("hangs"));
        let helper = lines[6].trim_start_matches("helper=");
        assert!(
            gone(helper),
            "the stopped command's helper {helper} is gone"
        );
    }
}
