//! Whose page each of the space's pages is, for a turn that may write files.
//!
//! In a new chat, "Make a simple comparison page of the Framework Laptop 13 and 16 from what you
//! already know, without browsing." listed the space's pages, read another chat's comparison in
//! `sites/framework-laptops`, deleted its data and wrote its own there, so that chat's card showed
//! the new page. The rule the turn read left it to judge whether the person named that page, and
//! nothing told it which chat made the folder. So the turn is told, page by page, whether this chat
//! made it or another one did: a fact in place of that judgement.
//!
//! The fact is the space's record of its pages, [`PAGES_RECORD`] in the space's own folder:
//! `instafy preview open` writes each page there with the chat its card went to, the first time
//! that folder's card is opened, and keeps that chat when another one opens the same folder again.
//! It is kept with the space's files, under `.instafy/` (never saved, published, listed or copied
//! into a scoped worker's copy), so it outlasts the machine: a stopped space's next machine starts
//! with a new home folder, where the CLI's own record of the previews it opened is gone. It is read
//! from the record, not from the chat's history, so a long chat whose own page has left its
//! history still sees that page as its own.
//!
//! A page whose chat is not recorded reads as another chat's: told so wrongly, a turn starts a new
//! folder, or changes the page once the person points at it; told the other way, it could replace
//! another chat's page. That is a page from before the record: a wake that starts its site again
//! ([`record_woken_page`]) writes it down with no chat, so no later open claims it.
//!
//! Only pages made for the person are listed: a site served by Instafy's page server
//! (`instafy bind serve`) or by a command an installed skill provides (a map's host). The person's
//! own app or site, served by its own server from the workspace or from a folder of it (an
//! imported repository), is no such page: it changes as the person asks, from any chat.

use std::io::Read;
use std::path::{Component, Path};

use origin_http_server::workspace_fs::WorkspaceDir;
use serde_json::{Value as JsonValue, json};
use uuid::Uuid;

/// The space's record of its pages, relative to its workspace. `instafy preview open` writes it
/// (the CLI's `space-pages.ts`), and so does a wake ([`record_woken_page`]).
pub(crate) const PAGES_RECORD: &str = ".instafy/pages/pages.json";
const PAGES_RECORD_DIR: &str = ".instafy/pages";
/// The record's folder holds nothing a save, a status or a person's own git should see.
const PAGES_RECORD_IGNORE: &[u8] = b"*\n";
/// At most this many pages are listed, the most recently opened first.
const MAX_PAGES: usize = 12;
/// At most this many pages are kept in the record.
const MAX_RECORDED: usize = 100;
/// The longest title the CLI records (its `MAX_TITLE_LENGTH`).
const MAX_TITLE_CHARS: usize = 120;

/// The lines a turn of `conversation_id` that may write files reads after the rule on whose page it
/// changes: the space's pages made for the person, from the record in `workspace_dir`, each still a
/// folder of it. `page_commands` are the commands installed skills provide, whose sites are pages
/// too. Empty when there is no record or it holds no such page.
pub(crate) fn space_pages_lines(
    workspace_dir: &Path,
    conversation_id: Option<&Uuid>,
    page_commands: &[String],
) -> String {
    let Some(record) = read_record(workspace_dir) else {
        return String::new();
    };
    forget_gone_pages(workspace_dir, &record);
    pages_lines(&record, conversation_id, page_commands, |folder| {
        workspace_dir.join(folder).is_dir()
    })
}

/// A page whose folder is gone (an Undo took away the turn that made it) leaves the record, so a
/// page made later in a folder of the same name is written down with the chat that makes it, never
/// with the chat that made the old one. A turn that may write reads the record before it starts,
/// so before any page of its own is there. The record is written only when it is still the one
/// read: an open of another chat writing it meanwhile is never undone.
fn forget_gone_pages(workspace_dir: &Path, record: &JsonValue) {
    let Some(pages) = record.get("pages").and_then(JsonValue::as_array) else {
        return;
    };
    let kept: Vec<&JsonValue> = pages
        .iter()
        .filter(|page| entry_folder(page).is_some_and(|folder| workspace_dir.join(folder).is_dir()))
        .collect();
    if kept.len() == pages.len() {
        return;
    }
    let Ok(dir) = WorkspaceDir::open(workspace_dir).and_then(|w| w.open_dir(PAGES_RECORD_DIR))
    else {
        return;
    };
    let Ok(text) = serde_json::to_string_pretty(&json!({ "version": 1, "pages": kept })) else {
        return;
    };
    if read_record(workspace_dir).as_ref() == Some(record) {
        let _ = dir.replace_file("pages.json", &mut text.as_bytes(), false);
    }
}

/// The commands installed skills provide on this runtime: a site one of them serves is a page.
pub(crate) fn installed_page_commands() -> Vec<String> {
    let mut commands = Vec::new();
    for pack in crate::skill_packs::installed_packs() {
        commands.extend(pack.bin.iter().map(|bin| bin.name.clone()));
        if let Some(name) = pack
            .cli
            .as_ref()
            .and_then(|cli| Path::new(&cli.space_path).file_name())
            .and_then(|name| name.to_str())
        {
            commands.push(name.to_string());
        }
    }
    commands
}

/// Writes down the page in `folder` (`serve.cwd`) a wake started again, when the record does not
/// hold it: with its title and server and no chat, as a page from before the record. A page the
/// record holds keeps the chat it records.
pub(crate) fn record_woken_page(
    workspace_dir: &Path,
    folder: &str,
    title: &str,
    argv: &[String],
) -> std::io::Result<()> {
    let Some(folder) = page_folder(folder) else {
        return Ok(());
    };
    let record = read_record(workspace_dir).unwrap_or_else(|| json!({ "version": 1 }));
    let mut pages = record
        .get("pages")
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    if pages
        .iter()
        .any(|page| entry_folder(page).as_deref() == Some(folder.as_str()))
    {
        return Ok(());
    }
    pages.insert(
        0,
        json!({
            "folder": folder,
            "title": plain_title(title),
            "server": server_of(argv),
            "openedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        }),
    );
    pages.truncate(MAX_RECORDED);
    let workspace = WorkspaceDir::open(workspace_dir)?;
    let dir = workspace.create_dir_all(PAGES_RECORD_DIR)?;
    if dir.entry_kind(".gitignore").is_err() {
        dir.replace_file(".gitignore", &mut &PAGES_RECORD_IGNORE[..], false)?;
    }
    let text = serde_json::to_string_pretty(&json!({ "version": 1, "pages": pages }))?;
    dir.replace_file("pages.json", &mut text.as_bytes(), false)?;
    Ok(())
}

/// The record in `workspace_dir`, read without following a link.
fn read_record(workspace_dir: &Path) -> Option<JsonValue> {
    let mut text = String::new();
    WorkspaceDir::open(workspace_dir)
        .ok()?
        .open_file(PAGES_RECORD)
        .ok()?
        .read_to_string(&mut text)
        .ok()?;
    serde_json::from_str(&text).ok()
}

/// Every page folder the record in `workspace_dir` holds, whichever chat made it: a page whose card
/// was opened before (`jobs::page_cards` posts a card only for a page with none).
pub(crate) fn recorded_page_folders(workspace_dir: &Path) -> Vec<String> {
    let Some(record) = read_record(workspace_dir) else {
        return Vec::new();
    };
    record
        .get("pages")
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(entry_folder)
        .collect()
}

/// How a site is served, as the record keeps it: its program's name and first argument
/// (`["instafy", "bind"]`, `["uw", "host"]`, `["npm", "run"]`).
fn server_of(argv: &[String]) -> Vec<String> {
    let program = argv
        .first()
        .map(|program| {
            Path::new(program)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(program)
                .to_string()
        })
        .unwrap_or_default();
    std::iter::once(program)
        .chain(argv.get(1).cloned())
        .collect()
}

/// A site Instafy's page server serves (`instafy bind serve`), or a command an installed skill
/// provides: a page made for the person, not the person's own app.
fn is_page_server(server: &[&str], page_commands: &[String]) -> bool {
    match server {
        ["instafy", "bind", ..] => true,
        [program, ..] => !program.is_empty() && page_commands.iter().any(|name| name == program),
        [] => false,
    }
}

fn entry_folder(entry: &JsonValue) -> Option<String> {
    entry
        .get("folder")
        .and_then(JsonValue::as_str)
        .and_then(page_folder)
}

/// The record's pages made for the person whose folder is still there (`exists`), each by its
/// title and folder, made in this chat (`conversation_id`) or in another one; one with no chat
/// recorded counts as another chat's.
fn pages_lines(
    record: &JsonValue,
    conversation_id: Option<&Uuid>,
    page_commands: &[String],
    exists: impl Fn(&str) -> bool,
) -> String {
    let Some(pages) = record.get("pages").and_then(JsonValue::as_array) else {
        return String::new();
    };
    let mut folders: Vec<String> = Vec::new();
    let mut lines = String::new();
    for entry in pages {
        let Some(folder) = entry_folder(entry) else {
            continue;
        };
        let server: Vec<&str> = entry
            .get("server")
            .and_then(JsonValue::as_array)
            .map(|words| words.iter().filter_map(JsonValue::as_str).collect())
            .unwrap_or_default();
        if folders.contains(&folder) || !is_page_server(&server, page_commands) || !exists(&folder)
        {
            continue;
        }
        let made_here = conversation_id.is_some()
            && entry
                .get("conversationId")
                .and_then(JsonValue::as_str)
                .and_then(|value| Uuid::parse_str(value.trim()).ok())
                .as_ref()
                == conversation_id;
        let title = entry
            .get("title")
            .and_then(JsonValue::as_str)
            .map(plain_title)
            .filter(|title| !title.is_empty());
        let page = match title {
            Some(title) => format!("\"{title}\", in `{folder}/`"),
            None => format!("The page in `{folder}/`"),
        };
        let made = if made_here {
            "made in this chat"
        } else {
            "made in another chat"
        };
        lines.push_str(&format!("  - {page}: {made}.\n"));
        folders.push(folder);
        if folders.len() == MAX_PAGES {
            break;
        }
    }
    if lines.is_empty() {
        lines
    } else {
        format!("- The space's pages:\n{lines}")
    }
}

/// A page's folder as a workspace path (`sites/porto`), or None for the workspace itself and for a
/// folder outside it.
fn page_folder(site_dir: &str) -> Option<String> {
    let folder = site_dir
        .trim()
        .trim_start_matches("./")
        .trim_end_matches('/');
    let inside = !folder.is_empty()
        && folder != "."
        && Path::new(folder)
            .components()
            .all(|component| matches!(component, Component::Normal(_)));
    inside.then(|| folder.to_string())
}

/// A title on one line: no control characters, single spaces, at most the CLI's length.
fn plain_title(title: &str) -> String {
    title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(MAX_TITLE_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE_SERVER: [&str; 2] = ["instafy", "bind"];

    fn page(folder: &str, title: &str, chat: Option<&Uuid>, server: &[&str]) -> JsonValue {
        let mut page = json!({
            "folder": folder,
            "title": title,
            "server": server,
            "openedAt": "2026-11-08T00:00:00.000Z",
        });
        if let Some(chat) = chat {
            page["conversationId"] = json!(chat.to_string());
        }
        page
    }

    fn write_record(workspace: &Path, pages: Vec<JsonValue>) {
        std::fs::create_dir_all(workspace.join(PAGES_RECORD_DIR)).unwrap();
        std::fs::write(
            workspace.join(PAGES_RECORD),
            json!({ "version": 1, "pages": pages }).to_string(),
        )
        .unwrap();
    }

    /// Each page by its title and folder, made in this chat or in another: the chat recorded on the
    /// page, newest first, each folder once. A page with no chat recorded is another chat's, and so
    /// is every page for a turn of no chat.
    #[test]
    fn each_page_says_which_chat_made_it() {
        let (this, other) = (Uuid::new_v4(), Uuid::new_v4());
        let record = json!({ "version": 1, "pages": [
            page("sites/framework-13-16", "Framework Laptop 13 vs 16", Some(&this), &PAGE_SERVER),
            page("sites/framework-laptops", "Framework laptops", Some(&other), &PAGE_SERVER),
            // the same folder again: listed once
            page("./sites/framework-laptops/", "Framework laptops", Some(&this), &PAGE_SERVER),
            // from before chats were recorded
            page("seville-3-days", "Seville\tin 3\n days", None, &["uw", "host"]),
        ]});
        let commands = vec!["uw".to_string()];
        assert_eq!(
            pages_lines(&record, Some(&this), &commands, |_| true),
            "- The space's pages:\n\
             \x20 - \"Framework Laptop 13 vs 16\", in `sites/framework-13-16/`: made in this chat.\n\
             \x20 - \"Framework laptops\", in `sites/framework-laptops/`: made in another chat.\n\
             \x20 - \"Seville in 3 days\", in `seville-3-days/`: made in another chat.\n"
        );
        let other_chat = pages_lines(&record, Some(&other), &commands, |_| true);
        assert!(
            other_chat.contains(
                "\"Framework Laptop 13 vs 16\", in `sites/framework-13-16/`: made in another chat."
            ) && other_chat.contains(
                "\"Framework laptops\", in `sites/framework-laptops/`: made in this chat."
            ),
            "{other_chat}"
        );
        let no_chat = pages_lines(&record, None, &commands, |_| true);
        assert_eq!(
            no_chat.matches("made in another chat").count(),
            3,
            "{no_chat}"
        );
        assert!(!no_chat.contains("made in this chat"), "{no_chat}");
    }

    /// Only pages made for the person: a site Instafy's page server or an installed skill's command
    /// serves. The person's own app, in a folder of its own (an imported repository) or served from
    /// the workspace itself, is not listed, nor is a folder outside the workspace or a page with no
    /// server; with none left there is no line at all.
    #[test]
    fn only_pages_made_for_the_person_are_listed() {
        let chat = Uuid::new_v4();
        let mut no_folder = page("sites/x", "No folder", Some(&chat), &PAGE_SERVER);
        no_folder.as_object_mut().unwrap().remove("folder");
        let mut no_server = page("sites/y", "No server", Some(&chat), &PAGE_SERVER);
        no_server.as_object_mut().unwrap().remove("server");
        let record = json!({ "pages": [
            page("repos/acme-shop", "Acme shop", Some(&chat), &["npm", "run"]),
            page("web", "My app", Some(&chat), &["python3", "-m"]),
            page(".", "The space's own app", Some(&chat), &PAGE_SERVER),
            page("./", "The space's own app again", Some(&chat), &PAGE_SERVER),
            page("../elsewhere", "Outside", Some(&chat), &PAGE_SERVER),
            page("/tmp/site", "Absolute", Some(&chat), &PAGE_SERVER),
            page("trip", "A map", Some(&chat), &["uw", "host"]),
            no_folder,
            no_server,
        ]});
        assert_eq!(pages_lines(&record, Some(&chat), &[], |_| true), "");
        assert_eq!(pages_lines(&json!({}), Some(&chat), &[], |_| true), "");
        // a map's host is a page server where the skill that provides it is installed
        assert_eq!(
            pages_lines(&record, Some(&chat), &["uw".to_string()], |_| true),
            "- The space's pages:\n  - \"A map\", in `trip/`: made in this chat.\n"
        );
        let nowhere = Path::new("/nonexistent");
        assert_eq!(space_pages_lines(nowhere, Some(&chat), &[]), "");
    }

    /// The record is read from the space's own folder, so it is there on a new machine: a page
    /// whose folder is gone from the workspace is no page of the space, and a link in place of the
    /// record is not followed.
    #[test]
    fn the_record_is_read_from_the_spaces_folder() {
        let chat = Uuid::new_v4();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("sites/kept")).unwrap();
        write_record(
            workspace.path(),
            vec![
                page("sites/gone", "Gone", Some(&chat), &PAGE_SERVER),
                page("sites/kept", "Kept", Some(&chat), &PAGE_SERVER),
            ],
        );
        assert_eq!(
            space_pages_lines(workspace.path(), Some(&chat), &[]),
            "- The space's pages:\n  - \"Kept\", in `sites/kept/`: made in this chat.\n"
        );
        let elsewhere = tempfile::tempdir().unwrap();
        let target = elsewhere.path().join("pages.json");
        std::fs::rename(workspace.path().join(PAGES_RECORD), &target).unwrap();
        std::os::unix::fs::symlink(&target, workspace.path().join(PAGES_RECORD)).unwrap();
        assert_eq!(space_pages_lines(workspace.path(), Some(&chat), &[]), "");
    }

    /// An Undo took away the turn that made a page, folder and all. The record forgets that page
    /// when a writing turn next reads it, so a page another chat then makes in a folder of the same
    /// name is written down with that chat, not with the chat whose page was undone.
    #[test]
    fn a_page_whose_folder_is_gone_leaves_the_record() {
        let (undone, later) = (Uuid::new_v4(), Uuid::new_v4());
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("sites/kept")).unwrap();
        write_record(
            workspace.path(),
            vec![
                page(
                    "sites/framework-laptops",
                    "Undone",
                    Some(&undone),
                    &PAGE_SERVER,
                ),
                page("sites/kept", "Kept", Some(&undone), &PAGE_SERVER),
            ],
        );
        assert_eq!(
            space_pages_lines(workspace.path(), Some(&later), &[]),
            "- The space's pages:\n  - \"Kept\", in `sites/kept/`: made in another chat.\n"
        );
        let record = read_record(workspace.path()).unwrap();
        let folders: Vec<_> = record["pages"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(entry_folder)
            .collect();
        assert_eq!(folders, ["sites/kept"]);
        // the same folder made again, and woken before any open: no chat, never the undone one's
        std::fs::create_dir_all(workspace.path().join("sites/framework-laptops")).unwrap();
        record_woken_page(
            workspace.path(),
            "sites/framework-laptops",
            "Framework laptops",
            &["instafy".to_string(), "bind".to_string()],
        )
        .unwrap();
        assert!(
            space_pages_lines(workspace.path(), Some(&undone), &[]).contains(
                "\"Framework laptops\", in `sites/framework-laptops/`: made in another chat."
            )
        );
    }

    /// At most `MAX_PAGES` pages, and a title is one plain line of at most the CLI's length.
    #[test]
    fn a_few_pages_at_most_each_on_one_line() {
        let chat = Uuid::new_v4();
        let long = "A".repeat(300);
        let pages: Vec<JsonValue> = (0..20)
            .map(|n| page(&format!("sites/page-{n}"), &long, Some(&chat), &PAGE_SERVER))
            .collect();
        let lines = pages_lines(&json!({ "pages": pages }), Some(&chat), &[], |_| true);
        assert_eq!(lines.lines().count(), 1 + MAX_PAGES, "{lines}");
        assert!(lines.contains(&format!("\"{}\"", "A".repeat(MAX_TITLE_CHARS))));
        assert!(!lines.contains(&"A".repeat(MAX_TITLE_CHARS + 1)));
    }

    /// A wake writes down a page the record does not hold, with no chat and its server, so it
    /// reads as another chat's and no later open claims it; a page the record holds keeps its chat.
    /// The record's folder keeps it out of every git status.
    #[test]
    fn a_wake_writes_down_a_page_with_no_chat_and_keeps_a_recorded_one() {
        let (maker, other) = (Uuid::new_v4(), Uuid::new_v4());
        let workspace = tempfile::tempdir().unwrap();
        for folder in ["sites/framework-laptops", "sites/porto"] {
            std::fs::create_dir_all(workspace.path().join(folder)).unwrap();
        }
        write_record(
            workspace.path(),
            vec![page(
                "sites/framework-laptops",
                "Framework laptops",
                Some(&maker),
                &PAGE_SERVER,
            )],
        );
        let argv = |words: &[&str]| words.iter().map(|w| w.to_string()).collect::<Vec<_>>();
        let bind = argv(&[
            "/usr/local/bin/instafy",
            "bind",
            "serve",
            ".",
            "--port",
            "20001",
        ]);
        record_woken_page(
            workspace.path(),
            "sites/framework-laptops",
            "Renamed",
            &bind,
        )
        .unwrap();
        record_woken_page(workspace.path(), "./sites/porto/", "Porto", &bind).unwrap();
        record_woken_page(workspace.path(), ".", "The app", &bind).unwrap();
        let lines = space_pages_lines(workspace.path(), Some(&maker), &[]);
        assert_eq!(
            lines,
            "- The space's pages:\n\
             \x20 - \"Porto\", in `sites/porto/`: made in another chat.\n\
             \x20 - \"Framework laptops\", in `sites/framework-laptops/`: made in this chat.\n"
        );
        assert!(
            space_pages_lines(workspace.path(), Some(&other), &[]).contains(
                "\"Framework laptops\", in `sites/framework-laptops/`: made in another chat."
            )
        );
        assert_eq!(
            std::fs::read(workspace.path().join(PAGES_RECORD_DIR).join(".gitignore")).unwrap(),
            PAGES_RECORD_IGNORE
        );
        // a wake with no record at all starts one
        let fresh = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(fresh.path().join("sites/porto")).unwrap();
        record_woken_page(fresh.path(), "sites/porto", "Porto", &bind).unwrap();
        assert_eq!(
            space_pages_lines(fresh.path(), Some(&maker), &[]),
            "- The space's pages:\n  - \"Porto\", in `sites/porto/`: made in another chat.\n"
        );
    }
}
