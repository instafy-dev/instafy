//! Whose page each of the space's pages is, for a turn that may write files.
//!
//! In a new chat, "Make a simple comparison page of the Framework Laptop 13 and 16 from what you
//! already know, without browsing." listed the space's pages, read another chat's comparison in
//! `sites/framework-laptops`, deleted its data and wrote its own there, so that chat's card showed
//! the new page. The rule the turn read left it to judge whether the person named that page, and
//! nothing told it which chat made the folder. `instafy preview open` records the chat each page's
//! card went to (`conversationId` in the CLI's state file, beside the page's title and folder), so
//! the turn is told, page by page, whether this chat made it or another one did: a fact in place of
//! that judgement. It is read from the page's record, not from the chat's history, so a long chat
//! whose own page has left its history still sees that page as its own.
//!
//! A page opened before the CLI recorded its chat reads as another chat's: told so wrongly, a turn
//! starts a new folder, or changes the page once the person points at it; told the other way, it
//! could replace another chat's page. The space's own site, served from the workspace itself, is no
//! page a chat made for the person: it changes as the person asks, from any chat, and is not listed.

use std::path::{Component, Path};

use serde_json::Value as JsonValue;
use uuid::Uuid;

/// At most this many pages are listed, the most recently opened first.
const MAX_PAGES: usize = 12;
/// The longest title the CLI records (its `MAX_TITLE_LENGTH`).
const MAX_TITLE_CHARS: usize = 120;

/// The lines a turn of `conversation_id` that may write files reads after the rule on whose page it
/// changes: the space's pages, from the CLI's state file at `state_file`, each still a folder in
/// the space's workspace (`workspace_dir`). Empty when there is no such file or it holds no page of
/// the space in a folder of its own.
pub(super) fn space_pages_lines(
    state_file: Option<&Path>,
    workspace_dir: &Path,
    project_id: &Uuid,
    conversation_id: Option<&Uuid>,
) -> String {
    let Some(state) = state_file
        .and_then(|file| std::fs::read_to_string(file).ok())
        .and_then(|text| serde_json::from_str::<JsonValue>(&text).ok())
    else {
        return String::new();
    };
    pages_lines(&state, project_id, conversation_id, |folder| {
        workspace_dir.join(folder).is_dir()
    })
}

/// The space's pages in the CLI's state (`state`) whose folder is still there (`exists`), each by
/// its title and folder, made in this chat (`conversation_id`) or in another one; one with no chat
/// recorded counts as another chat's.
fn pages_lines(
    state: &JsonValue,
    project_id: &Uuid,
    conversation_id: Option<&Uuid>,
    exists: impl Fn(&str) -> bool,
) -> String {
    let Some(previews) = state.get("previews").and_then(JsonValue::as_array) else {
        return String::new();
    };
    let mut folders: Vec<String> = Vec::new();
    let mut lines = String::new();
    for entry in previews {
        let uuid_of = |key: &str| {
            entry
                .get(key)
                .and_then(JsonValue::as_str)
                .and_then(|value| Uuid::parse_str(value.trim()).ok())
        };
        if uuid_of("projectId").as_ref() != Some(project_id) {
            continue;
        }
        let Some(folder) = entry
            .get("siteDir")
            .and_then(JsonValue::as_str)
            .and_then(page_folder)
        else {
            continue;
        };
        if folders.contains(&folder) || !exists(&folder) {
            continue;
        }
        let made_here =
            conversation_id.is_some() && uuid_of("conversationId").as_ref() == conversation_id;
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
    use serde_json::json;

    fn entry(project: &Uuid, folder: &str, title: &str, chat: Option<&Uuid>) -> JsonValue {
        let mut entry = json!({
            "previewId": format!("preview-{}", folder.replace('/', "-")),
            "projectId": project.to_string(),
            "title": title,
            "localPort": 20_000,
            "path": "/",
            "pid": 1,
            "siteDir": folder,
        });
        if let Some(chat) = chat {
            entry["conversationId"] = json!(chat.to_string());
        }
        entry
    }

    /// Each page by its title and folder, made in this chat or in another: the chat recorded on the
    /// page, newest first, each folder once. A page with no chat recorded is another chat's, and so is
    /// every page for a turn of no chat.
    #[test]
    fn each_page_says_which_chat_made_it() {
        let project = Uuid::new_v4();
        let (this, other) = (Uuid::new_v4(), Uuid::new_v4());
        let state = json!({ "version": 1, "previews": [
            entry(&project, "sites/framework-13-16", "Framework Laptop 13 vs 16", Some(&this)),
            entry(&project, "sites/framework-laptops", "Framework laptops", Some(&other)),
            // the same folder on another port, opened earlier: listed once
            entry(&project, "./sites/framework-laptops/", "Framework laptops", Some(&this)),
            // from before chats were recorded
            entry(&project, "seville-3-days", "Seville\tin 3\n days", None),
        ]});
        assert_eq!(
            pages_lines(&state, &project, Some(&this), |_| true),
            "- The space's pages:\n\
             \x20 - \"Framework Laptop 13 vs 16\", in `sites/framework-13-16/`: made in this chat.\n\
             \x20 - \"Framework laptops\", in `sites/framework-laptops/`: made in another chat.\n\
             \x20 - \"Seville in 3 days\", in `seville-3-days/`: made in another chat.\n"
        );
        let other_chat = pages_lines(&state, &project, Some(&other), |_| true);
        assert!(
            other_chat.contains(
                "\"Framework Laptop 13 vs 16\", in `sites/framework-13-16/`: made in another chat."
            ) && other_chat.contains(
                "\"Framework laptops\", in `sites/framework-laptops/`: made in this chat."
            ),
            "{other_chat}"
        );
        let no_chat = pages_lines(&state, &project, None, |_| true);
        assert_eq!(
            no_chat.matches("made in another chat").count(),
            3,
            "{no_chat}"
        );
        assert!(!no_chat.contains("made in this chat"), "{no_chat}");
    }

    /// Another space's page, the space's own site (the workspace itself), a folder outside the
    /// workspace and a preview with no folder are not listed; with none left there is no line at all.
    #[test]
    fn only_the_spaces_pages_in_folders_of_their_own_are_listed() {
        let project = Uuid::new_v4();
        let chat = Uuid::new_v4();
        let mut no_folder = entry(&project, "sites/x", "No folder", Some(&chat));
        no_folder.as_object_mut().unwrap().remove("siteDir");
        let state = json!({ "previews": [
            entry(&Uuid::new_v4(), "sites/theirs", "Another space's page", Some(&chat)),
            entry(&project, ".", "The space's own app", Some(&chat)),
            entry(&project, "./", "The space's own app again", Some(&chat)),
            entry(&project, "../elsewhere", "Outside", Some(&chat)),
            entry(&project, "/tmp/site", "Absolute", Some(&chat)),
            no_folder,
        ]});
        assert_eq!(pages_lines(&state, &project, Some(&chat), |_| true), "");
        assert_eq!(pages_lines(&json!({}), &project, Some(&chat), |_| true), "");
        let nowhere = Path::new("/nonexistent");
        assert_eq!(
            space_pages_lines(
                Some(&nowhere.join("cli-preview-state.json")),
                nowhere,
                &project,
                Some(&chat)
            ),
            ""
        );
        assert_eq!(space_pages_lines(None, nowhere, &project, Some(&chat)), "");
    }

    /// A page whose folder is gone from the workspace is no page of the space: read from the state
    /// file with the workspace's folders, only the one still there is listed.
    #[test]
    fn a_page_whose_folder_is_gone_is_not_listed() {
        let project = Uuid::new_v4();
        let chat = Uuid::new_v4();
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("sites/kept")).unwrap();
        let home = tempfile::tempdir().unwrap();
        let state_file = home.path().join("cli-preview-state.json");
        std::fs::write(
            &state_file,
            json!({ "version": 1, "previews": [
                entry(&project, "sites/gone", "Gone", Some(&chat)),
                entry(&project, "sites/kept", "Kept", Some(&chat)),
            ]})
            .to_string(),
        )
        .unwrap();
        assert_eq!(
            space_pages_lines(Some(&state_file), workspace.path(), &project, Some(&chat)),
            "- The space's pages:\n  - \"Kept\", in `sites/kept/`: made in this chat.\n"
        );
    }

    /// At most `MAX_PAGES` pages, and a title is one plain line of at most the CLI's length.
    #[test]
    fn a_few_pages_at_most_each_on_one_line() {
        let project = Uuid::new_v4();
        let chat = Uuid::new_v4();
        let long = "A".repeat(300);
        let previews: Vec<JsonValue> = (0..20)
            .map(|n| entry(&project, &format!("sites/page-{n}"), &long, Some(&chat)))
            .collect();
        let lines = pages_lines(
            &json!({ "previews": previews }),
            &project,
            Some(&chat),
            |_| true,
        );
        assert_eq!(lines.lines().count(), 1 + MAX_PAGES, "{lines}");
        assert!(lines.contains(&format!("\"{}\"", "A".repeat(MAX_TITLE_CHARS))));
        assert!(!lines.contains(&"A".repeat(MAX_TITLE_CHARS + 1)));
    }
}
