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
//! `instafy preview open` writes each page there with the chat that made it, the first time that
//! folder's card is opened, and keeps that chat when another one opens the same folder again. It
//! is read from the record, not from the chat's history, so a long chat whose own page has left
//! its history still sees that page as its own.
//!
//! The record is kept with the space's files, under `.instafy/` (never saved, published, listed
//! or copied into a scoped worker's copy), so a stopped space's next machine finds it where the
//! folder itself is kept, though the CLI's own record of its previews, in the home folder, is
//! gone. It does not outlast the folder: no save holds it, so a hosted space starts without it
//! after every release (the node that held the folder is replaced) and whenever an idle checkout
//! is cloned again. The first chat to open a page's card then became its maker, a check that
//! passes in any chat posts that card, and the chat that really made the page had its edits put
//! back under a line that said another chat had made it. So:
//!
//! - The controller keeps which chat made each page, written when the page's card is posted, and
//!   gives a leased turn the space's pages (`space_pages` in the job's payload). They are taken
//!   over the record here before the turn reads it ([`take_the_controllers_pages`]): the record
//!   in the folder is this machine's copy, and the controller's is the one that decides.
//! - A page reads with no chat when its chat is gone for the person the turn runs for (it no
//!   longer exists, they moved it to Trash, or it is a thread nobody asks in): the controller
//!   leaves that chat out, so such a page is not read-only in every chat for good.
//! - An open gives a folder the record does not hold to its own chat only when the turn that
//!   opens it made the folder: as a turn that may write files begins, the folders that are in
//!   the workspace are written down ([`write_down_the_turns_folders`]), and the CLI reads a
//!   folder among them as there before the turn, whose open claims it for no chat.
//!
//! A controller from before it kept the record sends no pages, and the record here stands as it
//! is, with the last rule alone.
//!
//! A page another chat made is read-only here, and the runtime holds it to that ([`HeldPages`]).
//! Told so in words, a new chat's turn still deleted another chat's comparison data and typed it
//! again with a stray character, and that page was broken until a later turn mended it in passing
//! (a local test, Nov 9). So what a turn's own steps change under such a page's folder goes back as
//! it was when the turn began once the turn's model is done, a file the turn returns there is never
//! written, and the reply says which page it didn't change. The person changes that page in the
//! chat that made it, as an artifact belongs to its conversation in other chat apps. An
//! automation's run has no chat to ask in: nothing holds a page for it. Holding can be switched
//! off on a runtime ([`HOLD_PAGES_ENV`]): a turn is then told the same, and nothing is put back
//! or kept from being written.
//!
//! A page whose chat is not recorded is a page from before the record: a wake that starts its site
//! again ([`record_woken_page`]) writes it down with no chat, so no later open claims it. Nothing
//! says which chat made it, so a turn is told just that, and nothing holds it: told it was another
//! chat's, the chat that made it could no longer change it.
//!
//! Only pages made for the person are listed: a site served by Instafy's page server
//! (`instafy bind serve`) or by a command an installed skill provides (a map's host). The person's
//! own app or site, served by its own server from the workspace or from a folder of it (an
//! imported repository), is no such page: it changes as the person asks, from any chat.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::io::Read;
use std::path::{Component, Path};

use origin_http_server::workspace_fs::WorkspaceDir;
use serde_json::{Value as JsonValue, json};
use tracing::{info, warn};
use uuid::Uuid;

use super::{CodexFileDescriptor, GitStatusEntry};

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
/// The job payload's key for the space's pages as the controller holds them (its
/// `previews/pages.rs`): `{"pages": [{"folder", "title", "server", "openedAt", "conversationId"?}]}`.
const CONTROLLERS_PAGES_KEY: &str = "space_pages";
/// The folders that were in the workspace as the turn began, next to the record: the CLI reads a
/// page folder among them as there before the turn (its `space-pages.ts`).
const TURN_FOLDERS_FILE: &str = "turn-folders.json";
/// How many names deep the turn's folders are written down (`sites/porto`), and how many at most:
/// past that the list says it is not whole, and the CLI reads every folder as there before.
const TURN_FOLDERS_DEPTH: usize = 2;
const MAX_TURN_FOLDERS: usize = 5000;
/// The most names read in one folder while looking for the folders in it: a folder of many files
/// is still read whole.
const MAX_NAMES_IN_A_FOLDER: usize = 50_000;
/// The runtime's switch for holding another chat's page: on unless this is `0`, `false`, `off` or
/// `no`. Off, [`HeldPages`] holds nothing: no change is put back and no returned file is left
/// unwritten, so a problem with holding needs no rollback. A turn is still told which chat made
/// each page and that another chat's page is read-only.
pub(crate) const HOLD_PAGES_ENV: &str = "INSTAFY_HOLD_PAGES";

/// Whether this runtime holds another chat's pages ([`HOLD_PAGES_ENV`]).
pub(crate) fn holding_is_on() -> bool {
    holding_reads_on(std::env::var(HOLD_PAGES_ENV).ok().as_deref())
}

fn holding_reads_on(raw: Option<&str>) -> bool {
    !matches!(
        raw.map(|raw| raw.trim().to_ascii_lowercase()).as_deref(),
        Some("0" | "false" | "off" | "no")
    )
}

/// The lines a turn of `conversation_id` that may write files reads after the rule on whose page it
/// changes: the space's pages made for the person, from the record in `workspace_dir`, each still a
/// folder of it, and each made in this chat or in another, read-only here. `page_commands` are the
/// commands installed skills provide, whose sites are pages too. Empty when there is no record or it
/// holds no such page.
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

/// Takes the space's pages as the controller holds them (a leased job's `payload`) over the
/// record in `workspace_dir`, before the turn reads it:
///
/// - A page the record holds gets the chat the controller holds for its folder, or none when the
///   controller holds none for it: a chat that is gone for the person the turn runs for, a page
///   nobody's, or a folder the controller never wrote down (an entry from before it kept the
///   record, which nothing vouches for).
/// - A page the record lacks, whose folder is in the workspace, is written down as the controller
///   holds it: on a machine that began without the record, each page is its maker's again.
///
/// Nothing is taken from a payload with no such pages (a controller from before it kept the
/// record). The record is written only when it is still the one read.
pub(crate) fn take_the_controllers_pages(workspace_dir: &Path, payload: &JsonValue) {
    let Some(theirs) = payload
        .get(CONTROLLERS_PAGES_KEY)
        .and_then(|pages| pages.get("pages"))
        .and_then(JsonValue::as_array)
    else {
        return;
    };
    let chat_of = |page: &JsonValue| {
        page.get("conversationId")
            .and_then(JsonValue::as_str)
            .and_then(|chat| Uuid::parse_str(chat.trim()).ok())
    };
    let mut held: HashMap<String, &JsonValue> = HashMap::new();
    for page in theirs {
        if let Some(folder) = entry_folder(page) {
            held.entry(folder).or_insert(page);
        }
    }
    let record = read_record(workspace_dir);
    let ours = record
        .as_ref()
        .and_then(|record| record.get("pages"))
        .and_then(JsonValue::as_array)
        .cloned()
        .unwrap_or_default();
    let mut next = Vec::with_capacity(ours.len());
    let mut written: HashSet<String> = HashSet::new();
    for mut entry in ours.iter().cloned() {
        if let Some(folder) = entry_folder(&entry) {
            written.insert(folder.clone());
            if let Some(entry) = entry.as_object_mut() {
                match held.get(&folder).and_then(|page| chat_of(page)) {
                    Some(chat) => {
                        entry.insert("conversationId".to_string(), json!(chat.to_string()));
                    }
                    None => {
                        entry.remove("conversationId");
                    }
                }
            }
        }
        next.push(entry);
    }
    for page in theirs {
        let Some(folder) = entry_folder(page) else {
            continue;
        };
        if written.contains(&folder) || !workspace_dir.join(&folder).is_dir() {
            continue;
        }
        let server: Vec<&str> = page
            .get("server")
            .and_then(JsonValue::as_array)
            .map(|words| words.iter().filter_map(JsonValue::as_str).take(2).collect())
            .unwrap_or_default();
        let mut entry = json!({
            "folder": folder,
            "title": plain_title(page.get("title").and_then(JsonValue::as_str).unwrap_or_default()),
            "server": server,
            "openedAt": page.get("openedAt").and_then(JsonValue::as_str).unwrap_or_default(),
        });
        if let Some(chat) = chat_of(page) {
            entry["conversationId"] = json!(chat.to_string());
        }
        written.insert(folder);
        next.push(entry);
    }
    next.truncate(MAX_RECORDED);
    if next == ours {
        return;
    }
    let Ok(text) = serde_json::to_string_pretty(&json!({ "version": 1, "pages": next })) else {
        return;
    };
    let written = (|| -> std::io::Result<()> {
        let dir = WorkspaceDir::open(workspace_dir)?.create_dir_all(PAGES_RECORD_DIR)?;
        if dir.entry_kind(".gitignore").is_err() {
            dir.replace_file(".gitignore", &mut &PAGES_RECORD_IGNORE[..], false)?;
        }
        if read_record(workspace_dir) == record {
            dir.replace_file("pages.json", &mut text.as_bytes(), false)?;
        }
        Ok(())
    })();
    if let Err(error) = written {
        warn!(%error, "could not take the controller's pages over the space's record");
    }
}

/// Writes down the folders that are in `workspace_dir` as the turn of `job_id` begins
/// ([`TURN_FOLDERS_FILE`]), at most [`TURN_FOLDERS_DEPTH`] names deep, leaving out hidden ones
/// and `node_modules`: `{"version": 1, "job", "folders", "complete"}`. The CLI gives a page whose
/// folder the record does not hold to the chat that opens it only when the folder is not among
/// them, so only a page this turn made.
///
/// A turn that takes up an earlier attempt's work keeps that attempt's list, so a page the
/// earlier attempt made and this one opens is still this turn's: the same job leased again after
/// a stop, or the job this one carries on (`continues`).
pub(crate) fn write_down_the_turns_folders(
    workspace_dir: &Path,
    job_id: &Uuid,
    continues: Option<&Uuid>,
) {
    let written = (|| -> std::io::Result<()> {
        let workspace = WorkspaceDir::open(workspace_dir)?;
        let dir = workspace.create_dir_all(PAGES_RECORD_DIR)?;
        if dir.entry_kind(".gitignore").is_err() {
            dir.replace_file(".gitignore", &mut &PAGES_RECORD_IGNORE[..], false)?;
        }
        let earlier = dir.open_file(TURN_FOLDERS_FILE).ok().and_then(|mut file| {
            let mut text = String::new();
            file.read_to_string(&mut text).ok()?;
            serde_json::from_str::<JsonValue>(&text).ok()
        });
        let earlier_job = earlier
            .as_ref()
            .and_then(|list| list.get("job"))
            .and_then(JsonValue::as_str)
            .and_then(|job| Uuid::parse_str(job).ok());
        if earlier_job.as_ref() == Some(job_id) {
            return Ok(());
        }
        let list = match earlier {
            Some(mut list) if earlier_job.is_some() && earlier_job.as_ref() == continues => {
                list["job"] = json!(job_id.to_string());
                list
            }
            _ => {
                let (folders, complete) = folders_in(&workspace);
                json!({
                    "version": 1,
                    "job": job_id.to_string(),
                    "folders": folders,
                    "complete": complete,
                })
            }
        };
        let text = serde_json::to_string(&list)?;
        dir.replace_file(TURN_FOLDERS_FILE, &mut text.as_bytes(), false)?;
        Ok(())
    })();
    if let Err(error) = written {
        warn!(%error, "could not write down the folders the turn began with");
    }
}

/// The real folders in `workspace`, at most [`TURN_FOLDERS_DEPTH`] names deep, sorted, and whether
/// that is all of them: a folder that could not be listed, or more than [`MAX_TURN_FOLDERS`], and
/// the list is not whole. A link is no folder, and is never followed. Hidden folders and
/// `node_modules` are left out, and the CLI reads a page folder under one as there before.
fn folders_in(workspace: &WorkspaceDir) -> (Vec<String>, bool) {
    let mut folders = BTreeSet::new();
    let mut complete = true;
    let mut level = vec![String::new()];
    for _ in 0..TURN_FOLDERS_DEPTH {
        let mut below = Vec::new();
        for parent in &level {
            let dir = if parent.is_empty() {
                Ok(workspace.clone())
            } else {
                workspace.open_dir(parent)
            };
            let Ok((dir, names)) = dir.and_then(|dir| {
                let names = dir.list_names(MAX_NAMES_IN_A_FOLDER)?;
                Ok((dir, names))
            }) else {
                complete = false;
                continue;
            };
            for name in names {
                let Some(name) = name.to_str() else {
                    complete = false;
                    continue;
                };
                if name.starts_with('.') || name == "node_modules" {
                    continue;
                }
                if !matches!(
                    dir.entry_kind(name),
                    Ok(origin_http_server::workspace_fs::WorkspaceEntryKind::Directory)
                ) {
                    continue;
                }
                if folders.len() >= MAX_TURN_FOLDERS {
                    return (folders.into_iter().collect(), false);
                }
                let folder = if parent.is_empty() {
                    name.to_string()
                } else {
                    format!("{parent}/{name}")
                };
                folders.insert(folder.clone());
                below.push(folder);
            }
        }
        level = below;
    }
    (folders.into_iter().collect(), complete)
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

/// A page made for the person, as the record keeps it: its folder, its title, and the chat that
/// made it, when the record says, with its entry and that entry's place in the record.
#[derive(Debug, Clone)]
struct RecordedPage {
    folder: String,
    title: Option<String>,
    chat: Option<Uuid>,
    index: usize,
    entry: JsonValue,
}

impl RecordedPage {
    /// Whether a turn of `conversation_id` holds this page: the record says another chat made it.
    fn held_for(&self, conversation_id: Option<&Uuid>) -> bool {
        self.chat.is_some() && self.chat.as_ref() != conversation_id
    }
}

/// The record's pages made for the person whose folder is still there (`exists`), the most
/// recently opened first, each folder once.
fn recorded_pages(
    record: &JsonValue,
    page_commands: &[String],
    exists: impl Fn(&str) -> bool,
) -> Vec<RecordedPage> {
    let Some(entries) = record.get("pages").and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    let mut pages: Vec<RecordedPage> = Vec::new();
    for (index, entry) in entries.iter().enumerate() {
        let Some(folder) = entry_folder(entry) else {
            continue;
        };
        let server: Vec<&str> = entry
            .get("server")
            .and_then(JsonValue::as_array)
            .map(|words| words.iter().filter_map(JsonValue::as_str).collect())
            .unwrap_or_default();
        if pages.iter().any(|page| page.folder == folder)
            || !is_page_server(&server, page_commands)
            || !exists(&folder)
        {
            continue;
        }
        let chat = entry
            .get("conversationId")
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::parse_str(value.trim()).ok());
        let title = entry
            .get("title")
            .and_then(JsonValue::as_str)
            .map(plain_title)
            .filter(|title| !title.is_empty());
        pages.push(RecordedPage {
            folder,
            title,
            chat,
            index,
            entry: entry.clone(),
        });
    }
    pages
}

/// The record's pages made for the person whose folder is still there (`exists`), each by its
/// title and folder: made in this chat (`conversation_id`), or in another one and read-only here,
/// or with no chat recorded.
fn pages_lines(
    record: &JsonValue,
    conversation_id: Option<&Uuid>,
    page_commands: &[String],
    exists: impl Fn(&str) -> bool,
) -> String {
    let mut lines = String::new();
    for page in recorded_pages(record, page_commands, exists)
        .into_iter()
        .take(MAX_PAGES)
    {
        let folder = &page.folder;
        let named = match &page.title {
            Some(title) => format!("\"{title}\", in `{folder}/`"),
            None => format!("The page in `{folder}/`"),
        };
        let made = if page.held_for(conversation_id) {
            "made in another chat, read-only here"
        } else if page.chat.is_some() {
            "made in this chat"
        } else {
            "which chat made it isn't known"
        };
        lines.push_str(&format!("  - {named}: {made}.\n"));
    }
    if lines.is_empty() {
        lines
    } else {
        format!("- The space's pages:\n{lines}")
    }
}

/// The longest file under a held page whose bytes a turn keeps when it begins with that file not
/// saved, and the most it keeps in all: page files are small, and one past these can't be put back.
const MAX_KEPT_FILE_BYTES: u64 = 1024 * 1024;
const MAX_KEPT_BYTES: u64 = 8 * 1024 * 1024;

/// What a turn's own steps reached, from its run's events: the paths its edit steps named, and the
/// commands it ran that may write. A change under another chat's page is the turn's only when one
/// of these reached it: anything else that changed there while the turn ran (a page's own server
/// saving a viewer's click, say) is someone else's.
#[derive(Debug, Default, Clone)]
pub(crate) struct TurnSteps {
    /// The workspace paths the turn's edit steps (`apply_patch`) named.
    edited: BTreeSet<String>,
    /// Each command the turn ran that may write, and an edit step's path the workspace's own
    /// spelling doesn't hold: what names a place the turn may have written.
    named: Vec<String>,
    /// No record of the run's steps (it failed before any reached the runtime): every change counts
    /// as the turn's.
    unknown: bool,
}

impl TurnSteps {
    /// The steps in a run's `events`, begun or done: its edit steps (`file_change`) and its commands
    /// (`command_execution`), leaving out a command the read-only list holds (`cat`, `ls`, `git
    /// show`).
    pub(super) fn of_events(workspace_dir: &Path, events: &[JsonValue]) -> Self {
        let mut steps = Self::default();
        for item in events.iter().filter_map(|event| event.get("item")) {
            match item.get("type").and_then(JsonValue::as_str) {
                Some("file_change") => {
                    let paths = item.get("paths").and_then(JsonValue::as_array);
                    for raw in paths.into_iter().flatten().filter_map(JsonValue::as_str) {
                        match workspace_path(workspace_dir, raw) {
                            Some(path) => {
                                steps.edited.insert(path);
                            }
                            None => steps.name(raw),
                        }
                    }
                }
                Some("command_execution") => {
                    let argv: Vec<String> = item
                        .get("command_argv")
                        .and_then(JsonValue::as_array)
                        .map(|words| {
                            words
                                .iter()
                                .filter_map(JsonValue::as_str)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    if !argv.is_empty() && super::known_safe_command::is_known_safe_command(&argv) {
                        continue;
                    }
                    if let Some(command) = item.get("command").and_then(JsonValue::as_str) {
                        steps.name(command);
                    }
                }
                _ => {}
            }
        }
        steps
    }

    /// A run that kept no record of its steps.
    pub(super) fn unknown() -> Self {
        Self {
            unknown: true,
            ..Self::default()
        }
    }

    fn name(&mut self, text: &str) {
        if !self.named.iter().any(|named| named == text) {
            self.named.push(text.to_string());
        }
    }

    fn add(&mut self, other: Self) {
        self.edited.extend(other.edited);
        for named in &other.named {
            self.name(named);
        }
        self.unknown |= other.unknown;
    }

    /// Whether a step reached `path`, in the page in `folder`: an edit step named that path, or a
    /// command named the folder.
    fn reached(&self, path: &str, folder: &str) -> bool {
        self.unknown
            || self.edited.contains(path)
            || self.named.iter().any(|named| names_folder(named, folder))
    }
}

/// `raw`, a path an edit step named, as a workspace path, or None outside the workspace.
fn workspace_path(workspace_dir: &Path, raw: &str) -> Option<String> {
    let path = Path::new(raw.trim());
    let relative = if path.is_absolute() {
        match path.strip_prefix(workspace_dir) {
            Ok(relative) => relative.to_path_buf(),
            Err(_) => {
                let root = std::fs::canonicalize(workspace_dir).ok()?;
                path.strip_prefix(root).ok()?.to_path_buf()
            }
        }
    } else {
        path.to_path_buf()
    };
    let mut parts = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => parts.push(part.to_str()?.to_string()),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// Whether `text` names the page in `folder` (`sites/porto`): its workspace path, or its own name,
/// as a whole part of a path.
fn names_folder(text: &str, folder: &str) -> bool {
    let name = folder.rsplit('/').next().unwrap_or(folder);
    let is_name_char = |c: char| c.is_alphanumeric() || matches!(c, '-' | '_' | '.');
    [folder, name].into_iter().any(|needle| {
        !needle.is_empty()
            && text.match_indices(needle).any(|(at, _)| {
                let before = text[..at].chars().next_back();
                let after = text[at + needle.len()..].chars().next();
                !before.is_some_and(is_name_char) && !after.is_some_and(is_name_char)
            })
    })
}

/// The pages another chat made, held for a turn of this chat that may write files: they are
/// read-only here ([`super::PAGE_OF_ITS_OWN_CHAT_RULE`]).
///
/// - Once the turn's model is done, ended well or not, what the turn changed under such a page's
///   folder goes back as it was when the turn began ([`Self::put_back`]): a file that was saved
///   then as the space's latest save holds it, through the space's own repository; one that wasn't
///   to the bytes it held then, which the turn kept as it began.
/// - What the turn changed is what its own steps reached ([`TurnSteps`]): a path one of its edit
///   steps named, or anything in a page's folder that one of its commands named. Nothing else
///   there is touched: a page's own server saving a viewer's click while the turn ran, or work
///   another turn left there unsaved. A runtime runs one turn at a time, so no other chat's turn
///   changes a page while this one runs.
/// - A file the turn returns for the runtime to write there is never written
///   ([`Self::leave_out_returned`]), and no path under such a page goes in the turn's files, its
///   save or its card ([`Self::holds`]).
/// - A turn's card writes the space's record of its pages again, without a page whose folder was
///   gone at that moment, and the record is outside every save: each held page's entry goes back
///   as the turn began.
/// - The turn's artifacts record a change put back as a blocked write, and its reply says which
///   page it didn't change ([`Self::reply`]).
///
/// A page is held by its own folder: a path in the folder of a page this chat made, or one whose
/// chat isn't recorded, within another chat's page's folder stays this turn's.
#[derive(Debug, Default)]
pub(crate) struct HeldPages {
    /// The space's pages, each with whether this turn holds it.
    pages: Vec<(RecordedPage, bool)>,
    /// Each held path that wasn't saved when the turn began, as it was then, or None when it was
    /// gone then. One left out had no bytes the turn could keep (a large file, or no plain file).
    unsaved: HashMap<String, Option<KeptFile>>,
    /// What the turn's own steps reached.
    steps: TurnSteps,
    /// The paths under a held page the turn changed, and those put back.
    changed: BTreeSet<String>,
    restored: BTreeSet<String>,
    /// The files under a held page the turn returned with their contents, never written.
    returned: BTreeSet<String>,
}

impl HeldPages {
    /// The pages a turn of `conversation_id` in `workspace_dir` holds, from the space's record, with
    /// the bytes of each file under them that `start`, the folder's status as the turn begins, shows
    /// not saved.
    pub(super) fn of_turn(
        workspace_dir: &Path,
        conversation_id: Option<&Uuid>,
        page_commands: &[String],
        start: Option<&HashMap<String, GitStatusEntry>>,
    ) -> Self {
        Self::of_turn_when(
            holding_is_on(),
            workspace_dir,
            conversation_id,
            page_commands,
            start,
        )
    }

    /// [`Self::of_turn`] on a runtime that holds pages (`holding`), and nothing held on one that
    /// has holding switched off ([`HOLD_PAGES_ENV`]).
    fn of_turn_when(
        holding: bool,
        workspace_dir: &Path,
        conversation_id: Option<&Uuid>,
        page_commands: &[String],
        start: Option<&HashMap<String, GitStatusEntry>>,
    ) -> Self {
        if !holding {
            return Self::default();
        }
        let pages = read_record(workspace_dir)
            .map(|record| {
                recorded_pages(&record, page_commands, |folder| {
                    workspace_dir.join(folder).is_dir()
                })
            })
            .unwrap_or_default()
            .into_iter()
            .map(|page| {
                let held = page.held_for(conversation_id);
                (page, held)
            })
            .collect();
        let mut held = Self {
            pages,
            ..Self::default()
        };
        let mut paths: Vec<&String> = start
            .into_iter()
            .flat_map(|status| status.keys())
            .filter(|path| held.holds(path))
            .collect();
        paths.sort();
        let mut budget = MAX_KEPT_BYTES;
        for path in paths {
            if let Some(kept) = keep_unsaved(workspace_dir, path, &mut budget) {
                held.unsaved.insert(path.clone(), kept);
            }
        }
        held
    }

    fn holds_any(&self) -> bool {
        self.pages.iter().any(|(_, held)| *held)
    }

    /// The held page a workspace path is in: the page with the deepest folder that holds it, when
    /// another chat made that page. Never a path the runtime owns (`.bind`, `.git`).
    fn page_of(&self, path: &str) -> Option<&RecordedPage> {
        if super::is_runtime_owned_workspace_path(path) {
            return None;
        }
        self.pages
            .iter()
            .filter(|(page, _)| {
                path.strip_prefix(page.folder.as_str())
                    .is_some_and(|rest| rest.starts_with('/'))
            })
            .max_by_key(|(page, _)| page.folder.len())
            .and_then(|(page, held)| held.then_some(page))
    }

    /// Whether a workspace path is under a page another chat made: never in this turn's files, save
    /// or card.
    pub(super) fn holds(&self, path: &str) -> bool {
        self.page_of(path).is_some()
    }

    /// Leaves out of `files` each one under a held page.
    pub(super) fn leave_out_held(&self, files: &mut Vec<CodexFileDescriptor>) {
        if !self.holds_any() {
            return;
        }
        files.retain(|file| {
            ![&file.workspace_path, &file.path].into_iter().any(|raw| {
                super::sanitize_relative_workspace_path(raw)
                    .is_some_and(|path| self.holds(&path.to_string_lossy().replace('\\', "/")))
            })
        });
    }

    /// Puts back what the turn changed under a held page since `start`, the folder's status as the
    /// turn began, with `steps` the steps of the run just done: each path one of the turn's steps
    /// reached goes back as it was then.
    pub(super) async fn put_back(
        &mut self,
        workspace_dir: &Path,
        start: Option<&HashMap<String, GitStatusEntry>>,
        steps: TurnSteps,
    ) {
        if !self.holds_any() {
            return;
        }
        self.steps.add(steps);
        self.keep_rows(workspace_dir);
        let Some(start) = start else {
            return;
        };
        let Some(now) = super::collect_git_status_porcelain(workspace_dir).await else {
            return;
        };
        let held = |status: &HashMap<String, GitStatusEntry>| -> HashMap<String, GitStatusEntry> {
            status
                .iter()
                .filter(|(path, _)| self.holds(path))
                .map(|(path, entry)| (path.clone(), entry.clone()))
                .collect()
        };
        let (start, now) = (held(start), held(&now));
        // What changed there: a path whose status isn't what it was, or one not saved then and as
        // saved now.
        let mut changed: BTreeSet<String> = super::git_status_delta_paths(&start, &now)
            .into_iter()
            .collect();
        changed.extend(
            start
                .keys()
                .filter(|path| !now.contains_key(*path))
                .cloned(),
        );
        let (theirs, others): (BTreeSet<String>, BTreeSet<String>) =
            changed.into_iter().partition(|path| {
                self.page_of(path)
                    .is_some_and(|page| self.steps.reached(path, &page.folder))
            });
        if !others.is_empty() {
            info!(paths = ?others, "left a change under another chat's page that no step of this turn reached");
        }
        if theirs.is_empty() {
            return;
        }
        // Saved when the turn began: back as the latest save holds it.
        let saved: HashMap<String, GitStatusEntry> = now
            .iter()
            .filter(|(path, _)| theirs.contains(*path) && !start.contains_key(*path))
            .map(|(path, entry)| (path.clone(), entry.clone()))
            .collect();
        let mut restored = super::restore_clean_baseline_git_status_delta_excluding(
            workspace_dir,
            &start,
            &saved,
            &HashSet::new(),
        )
        .await;
        // Not saved then: back to the bytes it held then.
        for path in theirs.iter().filter(|path| start.contains_key(*path)) {
            if let Some(kept) = self.unsaved.get(path)
                && put_unsaved_back(workspace_dir, path, kept.as_ref())
            {
                restored.push(path.clone());
            }
        }
        let left: Vec<&String> = theirs
            .iter()
            .filter(|path| !restored.contains(*path))
            .collect();
        if !left.is_empty() {
            warn!(paths = ?left, "a change under a page another chat made was not put back");
        }
        self.changed.extend(theirs);
        self.restored.extend(restored);
    }

    /// Puts back each held page's entry in the space's record as the turn began, when the turn took
    /// it out or changed it: a turn's card writes the record again without a page whose folder was
    /// gone at that moment, and another title on a page it opens, and nothing else brings an entry
    /// back. The record is written only when it is still the one read.
    fn keep_rows(&self, workspace_dir: &Path) {
        let record = read_record(workspace_dir);
        let mut entries = record
            .as_ref()
            .and_then(|record| record.get("pages"))
            .and_then(JsonValue::as_array)
            .cloned()
            .unwrap_or_default();
        let mut changed = false;
        for (page, _) in self.pages.iter().filter(|(_, held)| *held) {
            match entries
                .iter()
                .position(|entry| entry_folder(entry).as_deref() == Some(page.folder.as_str()))
            {
                Some(at) if entries[at] == page.entry => {}
                Some(at) => {
                    entries[at] = page.entry.clone();
                    changed = true;
                }
                None => {
                    entries.insert(page.index.min(entries.len()), page.entry.clone());
                    changed = true;
                }
            }
        }
        if !changed {
            return;
        }
        let Ok(text) = serde_json::to_string_pretty(&json!({ "version": 1, "pages": entries }))
        else {
            return;
        };
        let Ok(dir) =
            WorkspaceDir::open(workspace_dir).and_then(|w| w.create_dir_all(PAGES_RECORD_DIR))
        else {
            return;
        };
        if dir.entry_kind(".gitignore").is_err() {
            let _ = dir.replace_file(".gitignore", &mut &PAGES_RECORD_IGNORE[..], false);
        }
        if read_record(workspace_dir) == record {
            let _ = dir.replace_file("pages.json", &mut text.as_bytes(), false);
        }
    }

    /// Leaves out of a turn's returned `files` each one under a held page, so the runtime never
    /// writes it. One returned with its contents counts as a change the turn made there.
    pub(super) fn leave_out_returned(
        &mut self,
        workspace_dir: &Path,
        files: &mut Vec<CodexFileDescriptor>,
    ) {
        if !self.holds_any() {
            return;
        }
        let mut returned = Vec::new();
        files.retain(|file| {
            let Some(path) = [&file.workspace_path, &file.path]
                .into_iter()
                .find_map(|raw| super::sanitize_codex_workspace_path(workspace_dir, raw))
                .map(|path| path.to_string_lossy().replace('\\', "/"))
            else {
                return true;
            };
            if !self.holds(&path) {
                return true;
            }
            if file.content.is_some() || file.content_base64.is_some() {
                returned.push(path);
            }
            false
        });
        self.returned.extend(returned);
    }

    /// Whether the turn changed a held page: what it changed there went back or was never written.
    pub(super) fn put_a_change_back(&self) -> bool {
        !self.restored.is_empty() || !self.returned.is_empty()
    }

    /// The blocked write a turn's artifacts record when it changed a held page.
    pub(super) fn artifact(&self) -> Option<JsonValue> {
        if self.changed.is_empty() && self.returned.is_empty() {
            return None;
        }
        let mut artifact = super::build_read_only_write_blocked_artifact(
            self.returned.iter().cloned().collect(),
            self.changed.iter().cloned().collect(),
            self.restored.iter().cloned().collect(),
            HashSet::new(),
        );
        artifact["metadata"]["readOnlyPaths"] = self
            .pages
            .iter()
            .filter(|(_, held)| *held)
            .map(|(page, _)| format!("{}/", page.folder))
            .collect();
        Some(artifact)
    }

    /// The reply's last line when the turn changed a held page: "I didn't change “<title>”: it was
    /// made in another chat." The record keeps no chat's name, so the line can't say which.
    pub(super) fn reply_line(&self) -> Option<String> {
        let mut pages: Vec<&RecordedPage> = Vec::new();
        for path in self.restored.iter().chain(&self.returned) {
            if let Some(page) = self.page_of(path)
                && !pages.iter().any(|seen| seen.folder == page.folder)
            {
                pages.push(page);
            }
        }
        let names: Vec<String> = pages
            .iter()
            .map(|page| match &page.title {
                Some(title) => format!("“{title}”"),
                None => "a page".to_string(),
            })
            .collect();
        match names.as_slice() {
            [] => None,
            [name] => Some(format!(
                "I didn't change {name}: it was made in another chat."
            )),
            [first @ .., last] => Some(format!(
                "I didn't change {} or {last}: each was made in another chat.",
                first.join(", ")
            )),
        }
    }

    /// Ends a turn's reply on [`Self::reply_line`] when the turn changed a held page. When that was
    /// the turn's only change (`files`, its own, hold none), the line is the reply: the model's
    /// words would tell of a change no one can see.
    pub(super) fn reply(&self, summary: &mut String, files: &[CodexFileDescriptor]) {
        let Some(line) = self.reply_line() else {
            return;
        };
        if files.iter().any(|file| !file.is_read_reference()) {
            super::save_report::append_not_saved(summary, &[line]);
        } else {
            *summary = line;
        }
    }
}

/// A file under a held page as a turn found it, not saved: its bytes, whether it runs as a
/// program, and when it was last written, so that once it is back the folder's status reads as the
/// turn found it.
#[derive(Debug)]
struct KeptFile {
    bytes: Vec<u8>,
    executable: bool,
    modified: Option<std::time::SystemTime>,
}

/// A held `path` not saved as the turn begins: `Some(None)` when it is gone, None when it can't be
/// kept (no plain file, or past the limits).
#[allow(clippy::option_option)]
fn keep_unsaved(workspace_dir: &Path, path: &str, budget: &mut u64) -> Option<Option<KeptFile>> {
    let file = match WorkspaceDir::open(workspace_dir).and_then(|w| w.open_file(path)) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(None),
        Err(_) => return None,
    };
    let metadata = file.metadata().ok()?;
    if metadata.len() > MAX_KEPT_FILE_BYTES || metadata.len() > *budget {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_KEPT_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_KEPT_FILE_BYTES {
        return None;
    }
    *budget -= bytes.len() as u64;
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    Some(Some(KeptFile {
        bytes,
        executable,
        modified: metadata.modified().ok(),
    }))
}

/// Writes a held `path` back as the turn kept it when it began, or takes it away when it was gone
/// then; true when it is back.
fn put_unsaved_back(workspace_dir: &Path, path: &str, kept: Option<&KeptFile>) -> bool {
    let Ok(workspace) = WorkspaceDir::open(workspace_dir) else {
        return false;
    };
    let Some(kept) = kept else {
        return match workspace.remove_file(path) {
            Ok(()) => true,
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        };
    };
    if workspace
        .replace_file(path, &mut kept.bytes.as_slice(), kept.executable)
        .is_err()
    {
        return false;
    }
    if let Some(modified) = kept.modified
        && let Ok(file) = workspace.open_file(path)
    {
        let _ = file.set_modified(modified);
    }
    true
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

    /// Each page by its title and folder, made in this chat or in another and read-only here: the
    /// chat recorded on the page, newest first, each folder once. Every page with a chat recorded is
    /// another chat's for a turn of no chat. A page with no chat recorded says so.
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
             \x20 - \"Framework laptops\", in `sites/framework-laptops/`: made in another chat, read-only here.\n\
             \x20 - \"Seville in 3 days\", in `seville-3-days/`: which chat made it isn't known.\n"
        );
        let other_chat = pages_lines(&record, Some(&other), &commands, |_| true);
        assert!(
            other_chat.contains(
                "\"Framework Laptop 13 vs 16\", in `sites/framework-13-16/`: made in another chat, read-only here."
            ) && other_chat.contains(
                "\"Framework laptops\", in `sites/framework-laptops/`: made in this chat."
            ),
            "{other_chat}"
        );
        let no_chat = pages_lines(&record, None, &commands, |_| true);
        assert_eq!(
            no_chat
                .matches("made in another chat, read-only here.")
                .count(),
            2,
            "{no_chat}"
        );
        assert!(
            no_chat.contains("which chat made it isn't known."),
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
            "- The space's pages:\n  - \"Kept\", in `sites/kept/`: made in another chat, read-only here.\n"
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
                "\"Framework laptops\", in `sites/framework-laptops/`: which chat made it isn't known."
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

    /// A wake writes down a page the record does not hold, with no chat and its server, so no
    /// chat claims it and every chat is told so; a page the record holds keeps its chat.
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
             \x20 - \"Porto\", in `sites/porto/`: which chat made it isn't known.\n\
             \x20 - \"Framework laptops\", in `sites/framework-laptops/`: made in this chat.\n"
        );
        assert!(
            space_pages_lines(workspace.path(), Some(&other), &[]).contains(
                "\"Framework laptops\", in `sites/framework-laptops/`: made in another chat, read-only here."
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
            "- The space's pages:\n  - \"Porto\", in `sites/porto/`: which chat made it isn't known.\n"
        );
    }

    /// A leased job's payload with the space's pages as the controller holds them.
    fn leased_with(pages: Vec<JsonValue>) -> JsonValue {
        json!({ "prompt_text": "hi", "space_pages": { "pages": pages } })
    }

    fn record_folders(workspace: &Path) -> Vec<(String, Option<String>)> {
        read_record(workspace).unwrap()["pages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|page| {
                (
                    page["folder"].as_str().unwrap().to_string(),
                    page["conversationId"].as_str().map(str::to_string),
                )
            })
            .collect()
    }

    /// A release replaced the machine and the workspace was cloned again: the record in the
    /// folder is gone. The controller's pages are taken over it before the turn reads it, so the
    /// page another chat made is still that chat's, read-only to this chat's turn and held, and
    /// its own chat still changes it. A page the controller holds for no chat is nobody's, and one
    /// whose folder is not in the workspace is not written down.
    #[test]
    fn a_lost_record_is_filled_in_from_the_controllers_pages() {
        let (maker, other) = (Uuid::new_v4(), Uuid::new_v4());
        let workspace = tempfile::tempdir().unwrap();
        let ws = workspace.path();
        for folder in ["sites/framework-laptops", "sites/porto"] {
            std::fs::create_dir_all(ws.join(folder)).unwrap();
        }
        let leased = leased_with(vec![
            page("sites/porto", "Porto", None, &PAGE_SERVER),
            page(
                "sites/framework-laptops",
                "Framework laptops",
                Some(&maker),
                &["instafy", "bind", "serve"],
            ),
            page("sites/gone", "Gone", Some(&maker), &PAGE_SERVER),
            page("../outside", "Outside", Some(&maker), &PAGE_SERVER),
        ]);
        assert_eq!(space_pages_lines(ws, Some(&other), &[]), "");
        take_the_controllers_pages(ws, &leased);
        assert_eq!(
            record_folders(ws),
            [
                ("sites/porto".to_string(), None),
                (
                    "sites/framework-laptops".to_string(),
                    Some(maker.to_string())
                ),
            ]
        );
        assert_eq!(
            space_pages_lines(ws, Some(&other), &[]),
            "- The space's pages:\n\
             \x20 - \"Porto\", in `sites/porto/`: which chat made it isn't known.\n\
             \x20 - \"Framework laptops\", in `sites/framework-laptops/`: made in another chat, read-only here.\n"
        );
        assert!(
            HeldPages::of_turn_when(true, ws, Some(&other), &[], None)
                .holds("sites/framework-laptops/data.json")
        );
        assert!(
            !HeldPages::of_turn_when(true, ws, Some(&maker), &[], None)
                .holds("sites/framework-laptops/data.json")
        );
        assert_eq!(
            std::fs::read(ws.join(PAGES_RECORD_DIR).join(".gitignore")).unwrap(),
            PAGES_RECORD_IGNORE
        );
        // taken again, nothing changes
        let before = std::fs::read(ws.join(PAGES_RECORD)).unwrap();
        take_the_controllers_pages(ws, &leased);
        assert_eq!(std::fs::read(ws.join(PAGES_RECORD)).unwrap(), before);
    }

    /// The record names a chat that is gone for the person the turn runs for: it no longer
    /// exists, they moved it to Trash, or nobody asks in it. The controller leaves that chat out
    /// of the page it gives the turn, so the page reads with no chat and nothing holds it: it is
    /// not read-only in every chat for good. So does a page the controller holds no row for. The
    /// controller's chat for a page replaces the record's, and a controller that sends no pages
    /// leaves the record as it is.
    #[test]
    fn a_page_whose_chat_is_gone_reads_as_made_in_no_chat() {
        let (gone, kept, this) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let workspace = tempfile::tempdir().unwrap();
        let ws = workspace.path();
        for folder in [
            "sites/trashed",
            "sites/kept",
            "sites/unlisted",
            "sites/moved",
        ] {
            std::fs::create_dir_all(ws.join(folder)).unwrap();
        }
        let recorded = vec![
            page("sites/trashed", "Trashed", Some(&gone), &PAGE_SERVER),
            page("sites/kept", "Kept", Some(&kept), &PAGE_SERVER),
            page("sites/unlisted", "Unlisted", Some(&gone), &PAGE_SERVER),
            page("sites/moved", "Moved", Some(&gone), &PAGE_SERVER),
        ];
        write_record(ws, recorded.clone());
        let held = |ws: &Path| HeldPages::of_turn_when(true, ws, Some(&this), &[], None);
        assert!(held(ws).holds("sites/trashed/data.json"));

        // a controller from before it kept the record: nothing is taken
        take_the_controllers_pages(ws, &json!({ "prompt_text": "hi" }));
        take_the_controllers_pages(ws, &json!({ "space_pages": null }));
        assert_eq!(read_record(ws).unwrap()["pages"], json!(recorded));

        take_the_controllers_pages(
            ws,
            &leased_with(vec![
                page("sites/trashed", "Trashed", None, &PAGE_SERVER),
                page("sites/kept", "Kept", Some(&kept), &PAGE_SERVER),
                page("sites/moved", "Moved", Some(&this), &PAGE_SERVER),
            ]),
        );
        assert_eq!(
            record_folders(ws),
            [
                ("sites/trashed".to_string(), None),
                ("sites/kept".to_string(), Some(kept.to_string())),
                ("sites/unlisted".to_string(), None),
                ("sites/moved".to_string(), Some(this.to_string())),
            ]
        );
        let lines = space_pages_lines(ws, Some(&this), &[]);
        assert_eq!(
            lines,
            "- The space's pages:\n\
             \x20 - \"Trashed\", in `sites/trashed/`: which chat made it isn't known.\n\
             \x20 - \"Kept\", in `sites/kept/`: made in another chat, read-only here.\n\
             \x20 - \"Unlisted\", in `sites/unlisted/`: which chat made it isn't known.\n\
             \x20 - \"Moved\", in `sites/moved/`: made in this chat.\n"
        );
        let held = held(ws);
        assert!(!held.holds("sites/trashed/data.json"));
        assert!(!held.holds("sites/unlisted/data.json"));
        assert!(!held.holds("sites/moved/data.json"));
        assert!(held.holds("sites/kept/data.json"));
    }

    /// As a turn that may write files begins, the folders that are in the workspace are written
    /// down, two names deep: real folders only, no hidden one and no `node_modules`. The CLI
    /// gives a page to the chat that opens it only when its folder is not among them. A turn that
    /// takes up an earlier attempt keeps that attempt's list: the same job leased again, or the
    /// job it carries on.
    #[test]
    fn the_folders_a_turn_began_with_are_written_down() {
        let workspace = tempfile::tempdir().unwrap();
        let ws = workspace.path();
        for folder in [
            "sites/porto/data",
            "trip",
            ".hidden/inside",
            "node_modules/pkg",
            "sites/.bind",
        ] {
            std::fs::create_dir_all(ws.join(folder)).unwrap();
        }
        std::fs::write(ws.join("notes.md"), "notes\n").unwrap();
        std::os::unix::fs::symlink(ws.join("trip"), ws.join("sites/link")).unwrap();
        let list = |ws: &Path| -> JsonValue {
            serde_json::from_str(
                &std::fs::read_to_string(ws.join(PAGES_RECORD_DIR).join(TURN_FOLDERS_FILE))
                    .unwrap(),
            )
            .unwrap()
        };
        let (first, carried_on, later) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        write_down_the_turns_folders(ws, &first, None);
        assert_eq!(
            list(ws),
            json!({
                "version": 1,
                "job": first.to_string(),
                "folders": ["sites", "sites/porto", "trip"],
                "complete": true,
            })
        );
        assert_eq!(
            std::fs::read(ws.join(PAGES_RECORD_DIR).join(".gitignore")).unwrap(),
            PAGES_RECORD_IGNORE
        );
        // the turn makes a page; leased again after a stop, its list is the one it began with
        std::fs::create_dir_all(ws.join("sites/framework-laptops")).unwrap();
        write_down_the_turns_folders(ws, &first, None);
        assert_eq!(list(ws)["folders"], json!(["sites", "sites/porto", "trip"]));
        // so is the list of a job that carries that one on, under its own name
        write_down_the_turns_folders(ws, &carried_on, Some(&first));
        assert_eq!(
            list(ws),
            json!({
                "version": 1,
                "job": carried_on.to_string(),
                "folders": ["sites", "sites/porto", "trip"],
                "complete": true,
            })
        );
        // another turn begins with the page there
        write_down_the_turns_folders(ws, &later, Some(&first));
        assert_eq!(
            list(ws),
            json!({
                "version": 1,
                "job": later.to_string(),
                "folders": ["sites", "sites/framework-laptops", "sites/porto", "trip"],
                "complete": true,
            })
        );
    }

    /// Holding is on unless the runtime's setting switches it off. Off, a turn holds nothing: a
    /// change to another chat's page stays, a file returned for it is written, and the reply is
    /// the model's. The turn is still told which chat made each page.
    #[tokio::test]
    async fn with_holding_switched_off_nothing_is_held_or_put_back() {
        for on in [
            None,
            Some(""),
            Some("1"),
            Some("true"),
            Some("on"),
            Some("anything"),
        ] {
            assert!(holding_reads_on(on), "{on:?}");
        }
        for off in ["0", "false", "off", "no", " OFF ", "False"] {
            assert!(!holding_reads_on(Some(off)), "{off}");
        }
        let (this, other) = (Uuid::new_v4(), Uuid::new_v4());
        let workspace = space_with_two_pages(&this, &other);
        let ws = workspace.path();
        let start = super::super::collect_git_status_porcelain(ws)
            .await
            .unwrap();
        let their_data = ws.join("sites/framework-laptops/data.json");

        let mut off = HeldPages::of_turn_when(false, ws, Some(&this), &[], Some(&start));
        assert!(!off.holds("sites/framework-laptops/data.json"));
        std::fs::write(&their_data, "{\"items\":[]}\n").unwrap();
        off.put_back(
            ws,
            Some(&start),
            TurnSteps::of_events(ws, &[edit_step("sites/framework-laptops/data.json")]),
        )
        .await;
        assert_eq!(
            std::fs::read_to_string(&their_data).unwrap(),
            "{\"items\":[]}\n"
        );
        let mut files = vec![returned_file(
            "sites/framework-laptops/data.json",
            Some("{}\n"),
        )];
        off.leave_out_returned(ws, &mut files);
        off.leave_out_held(&mut files);
        assert_eq!(files.len(), 1);
        assert!(!off.put_a_change_back());
        assert_eq!(off.reply_line(), None);
        assert_eq!(off.artifact(), None);
        let mut reply = "I emptied the comparison.".to_string();
        off.reply(&mut reply, &files);
        assert_eq!(reply, "I emptied the comparison.");
        assert!(space_pages_lines(ws, Some(&this), &[]).contains(
            "\"Framework Laptop 12, 13 and 16\", in `sites/framework-laptops/`: made in another chat, read-only here."
        ));

        // switched on, the same change goes back
        let mut on = HeldPages::of_turn_when(true, ws, Some(&this), &[], Some(&start));
        on.put_back(
            ws,
            Some(&start),
            TurnSteps::of_events(ws, &[edit_step("sites/framework-laptops/data.json")]),
        )
        .await;
        assert_eq!(std::fs::read_to_string(&their_data).unwrap(), THEIRS);
        assert_eq!(on.reply_line().as_deref(), Some(NOT_CHANGED));
    }

    fn returned_file(path: &str, content: Option<&str>) -> CodexFileDescriptor {
        CodexFileDescriptor {
            path: path.to_string(),
            workspace_path: path.to_string(),
            label: None,
            description: None,
            mime_type: None,
            content: content.map(str::to_string),
            content_base64: None,
            change: None,
        }
    }

    /// A turn holds each page the record gives to another chat, by that page's own folder: not a
    /// page this chat made, nor one whose chat isn't recorded, nor a folder that only starts with
    /// the same name, nor what the runtime keeps in a folder. A file the turn returns for a held page
    /// is never written, and the reply names that page.
    #[test]
    fn a_turn_holds_the_pages_another_chat_made_by_their_folders() {
        let (this, other) = (Uuid::new_v4(), Uuid::new_v4());
        let workspace = tempfile::tempdir().unwrap();
        for folder in [
            "sites/framework-laptops/notes",
            "sites/framework-13-16",
            "seville-3-days",
        ] {
            std::fs::create_dir_all(workspace.path().join(folder)).unwrap();
        }
        write_record(
            workspace.path(),
            vec![
                page(
                    "sites/framework-laptops",
                    "Framework Laptop 12, 13 and 16",
                    Some(&other),
                    &PAGE_SERVER,
                ),
                page(
                    "sites/framework-laptops/notes",
                    "Notes",
                    Some(&this),
                    &PAGE_SERVER,
                ),
                page(
                    "sites/framework-13-16",
                    "Framework Laptop 13 vs 16",
                    Some(&this),
                    &PAGE_SERVER,
                ),
                page("seville-3-days", "Seville in 3 days", None, &PAGE_SERVER),
            ],
        );
        let mut held = HeldPages::of_turn(workspace.path(), Some(&this), &[], None);
        let held_in = |path: &str| held.page_of(path).map(|page| page.folder.clone());
        assert_eq!(
            held_in("sites/framework-laptops/data.json").as_deref(),
            Some("sites/framework-laptops")
        );
        for free in [
            "sites/framework-laptops/notes/today.md",
            "sites/framework-13-16/data.json",
            "seville-3-days/index.html",
            "sites/framework-laptops-2/data.json",
            "sites/framework-laptops/.bind/server.json",
            "sites/framework-laptops",
        ] {
            assert_eq!(held_in(free), None, "{free}");
        }
        assert!(
            HeldPages::of_turn(workspace.path(), Some(&other), &[], None)
                .page_of("sites/framework-laptops/data.json")
                .is_none()
        );

        let mut files = vec![
            returned_file(
                "sites/framework-laptops/data.json",
                Some("{\"title\":\"\"}\n"),
            ),
            returned_file("./sites/framework-laptops/app.js", None),
            returned_file("sites/framework-13-16/data.json", Some("{}\n")),
        ];
        held.leave_out_returned(workspace.path(), &mut files);
        let kept: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(kept, ["sites/framework-13-16/data.json"]);
        assert!(held.put_a_change_back());
        assert_eq!(
            held.reply_line().as_deref(),
            Some("I didn't change “Framework Laptop 12, 13 and 16”: it was made in another chat.")
        );
        let artifact = held.artifact().unwrap();
        assert_eq!(artifact["kind"], "write-scope/read-only-blocked");
        assert_eq!(
            artifact["metadata"]["reportedFiles"],
            json!(["sites/framework-laptops/data.json"])
        );
        assert_eq!(
            artifact["metadata"]["readOnlyPaths"],
            json!(["sites/framework-laptops/"])
        );

        // nothing returned for a held page: nothing to say
        let mut quiet = HeldPages::of_turn(workspace.path(), Some(&this), &[], None);
        let mut own = vec![returned_file(
            "sites/framework-13-16/data.json",
            Some("{}\n"),
        )];
        quiet.leave_out_returned(workspace.path(), &mut own);
        assert_eq!(own.len(), 1);
        assert!(!quiet.put_a_change_back());
        assert_eq!(quiet.reply_line(), None);
        assert_eq!(quiet.artifact(), None);
    }

    fn canonical_git(workspace: &Path, args: &[&str]) {
        let git_dir = workspace.join(".instafy/.git");
        let output = std::process::Command::new("git")
            .arg("--git-dir")
            .arg(&git_dir)
            .arg("--work-tree")
            .arg(workspace)
            .args(args)
            .current_dir(workspace)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// A space whose repository is its `.instafy/.git`, as a hosted space's is: another chat's
    /// comparison and this chat's page, both saved, and the record of which chat made each.
    fn space_with_two_pages(this: &Uuid, other: &Uuid) -> tempfile::TempDir {
        let workspace = tempfile::tempdir().unwrap();
        let ws = workspace.path();
        std::fs::create_dir_all(ws.join(".instafy")).unwrap();
        canonical_git(ws, &["init", "-q", "-b", "main"]);
        for (path, text) in [
            ("sites/framework-laptops/data.json", THEIRS),
            ("sites/framework-laptops/notes.md", "saved notes\n"),
            (
                "sites/framework-laptops/data/records/read_offer.json",
                "[]\n",
            ),
            ("sites/framework-13-16/data.json", "{}\n"),
        ] {
            std::fs::create_dir_all(ws.join(path).parent().unwrap()).unwrap();
            std::fs::write(ws.join(path), text).unwrap();
        }
        canonical_git(ws, &["add", "--", "sites"]);
        canonical_git(
            ws,
            &[
                "-c",
                "user.name=Instafy Test",
                "-c",
                "user.email=test@instafy.invalid",
                "commit",
                "-q",
                "-m",
                "saved",
            ],
        );
        write_record(
            ws,
            vec![
                page(
                    "sites/framework-laptops",
                    "Framework Laptop 12, 13 and 16",
                    Some(other),
                    &PAGE_SERVER,
                ),
                page(
                    "sites/framework-13-16",
                    "Framework Laptop 13 vs 16",
                    Some(this),
                    &PAGE_SERVER,
                ),
            ],
        );
        workspace
    }

    const THEIRS: &str = "{\"items\":[\"Laptop 12\",\"Laptop 13\",\"Laptop 16\"]}\n";
    const NOT_CHANGED: &str =
        "I didn't change “Framework Laptop 12, 13 and 16”: it was made in another chat.";

    /// An edit step of a run, as the run's events carry it.
    fn edit_step(path: &str) -> JsonValue {
        json!({"type": "item.completed", "item": {
            "id": "patch", "type": "file_change", "paths": [path], "status": "completed",
        }})
    }

    /// A command of a run, as the run's events carry it.
    fn command_step(command: &str) -> JsonValue {
        json!({"type": "item.completed", "item": {
            "id": "command", "type": "command_execution", "command": command,
            "command_argv": ["bash", "-lc", command], "status": "completed",
        }})
    }

    /// Once the turn's model is done, what its own steps changed in another chat's page goes back
    /// as the space's latest save holds it, in a space whose repository is its `.instafy/.git`: a
    /// file an edit step deleted and typed again. What else changed there while the turn ran, which
    /// no step of the turn reached, stays: the page's own server saving a viewer's click. So does
    /// work another turn left there unsaved, and what the turn changed in its own page.
    #[tokio::test]
    async fn a_turn_puts_back_only_what_its_own_steps_changed_in_another_chats_page() {
        let (this, other) = (Uuid::new_v4(), Uuid::new_v4());
        let workspace = space_with_two_pages(&this, &other);
        let ws = workspace.path();
        // the other chat's work, not saved yet when this turn begins
        std::fs::write(ws.join("sites/framework-laptops/weights.json"), "{}\n").unwrap();
        let start = super::super::collect_git_status_porcelain(ws)
            .await
            .unwrap();
        let mut held = HeldPages::of_turn(ws, Some(&this), &[], Some(&start));

        // the turn deletes the other chat's data and types it again with a stray character, and
        // changes its own page; meanwhile a viewer's click on the other chat's page is written
        let their_data = ws.join("sites/framework-laptops/data.json");
        std::fs::remove_file(&their_data).unwrap();
        std::fs::write(
            &their_data,
            "{\"items\":[\"Laptop 12\",\n+  \"Laptop 16\"]}\n",
        )
        .unwrap();
        std::fs::write(
            ws.join("sites/framework-13-16/data.json"),
            "{\"from\":\"memory\"}\n",
        )
        .unwrap();
        let click = "[{\"ref\":\"laptop:12\",\"price\":\"999\"}]\n";
        std::fs::write(
            ws.join("sites/framework-laptops/data/records/read_offer.json"),
            click,
        )
        .unwrap();
        let steps = TurnSteps::of_events(
            ws,
            &[
                edit_step(&their_data.display().to_string()),
                edit_step("sites/framework-13-16/data.json"),
                command_step("cat sites/framework-laptops/data.json"),
            ],
        );
        held.put_back(ws, Some(&start), steps).await;

        assert_eq!(std::fs::read_to_string(&their_data).unwrap(), THEIRS);
        assert_eq!(
            std::fs::read_to_string(
                ws.join("sites/framework-laptops/data/records/read_offer.json")
            )
            .unwrap(),
            click
        );
        assert_eq!(
            std::fs::read_to_string(ws.join("sites/framework-laptops/weights.json")).unwrap(),
            "{}\n"
        );
        assert_eq!(
            std::fs::read_to_string(ws.join("sites/framework-13-16/data.json")).unwrap(),
            "{\"from\":\"memory\"}\n"
        );
        assert_eq!(
            held.restored,
            BTreeSet::from(["sites/framework-laptops/data.json".to_string()])
        );
        assert_eq!(held.reply_line().as_deref(), Some(NOT_CHANGED));
        let artifact = held.artifact().unwrap();
        assert_eq!(artifact["kind"], "write-scope/read-only-blocked");
        assert_eq!(
            artifact["metadata"]["changedPaths"],
            json!(["sites/framework-laptops/data.json"])
        );
        assert_eq!(
            artifact["metadata"]["restoredPaths"],
            json!(["sites/framework-laptops/data.json"])
        );
        // no path under the other chat's page goes in the turn's files or its save
        let mut files = vec![
            returned_file("sites/framework-laptops/data/records/read_offer.json", None),
            returned_file("./sites/framework-laptops/weights.json", None),
            returned_file("sites/framework-13-16/data.json", None),
        ];
        held.leave_out_held(&mut files);
        let kept: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(kept, ["sites/framework-13-16/data.json"]);
        // nothing more to put back: the page is as it was
        held.put_back(ws, Some(&start), TurnSteps::default()).await;
        assert_eq!(held.restored.len(), 1);
    }

    /// A command that names another chat's page reached all of it: what changed there goes back as
    /// it was when the turn began. A file saved then comes back as the latest save holds it, one
    /// the turn added goes, and one that wasn't saved then gets back the bytes it held then (a
    /// stopped turn's edit, kept unsaved): putting it back as saved would undo that work, and
    /// leaving it would save the turn's change under its message.
    #[tokio::test]
    async fn a_file_not_saved_when_the_turn_began_goes_back_to_its_bytes_then() {
        let (this, other) = (Uuid::new_v4(), Uuid::new_v4());
        let workspace = space_with_two_pages(&this, &other);
        let ws = workspace.path();
        let notes = ws.join("sites/framework-laptops/notes.md");
        let weights = ws.join("sites/framework-laptops/weights.json");
        std::fs::write(&notes, "an edit not saved yet\n").unwrap();
        std::fs::write(&weights, "{\"Laptop 12\":\"1.3 kg\"}\n").unwrap();
        let start = super::super::collect_git_status_porcelain(ws)
            .await
            .unwrap();
        let mut held = HeldPages::of_turn(ws, Some(&this), &[], Some(&start));

        let command = "cd sites && rm -f framework-laptops/weights.json && printf 'mine\\n' > framework-laptops/notes.md && mkdir -p framework-laptops/v2 && echo '<p>new</p>' > framework-laptops/v2/index.html && printf '{}' > framework-laptops/data.json";
        std::fs::remove_file(&weights).unwrap();
        std::fs::write(&notes, "mine\n").unwrap();
        std::fs::create_dir_all(ws.join("sites/framework-laptops/v2")).unwrap();
        std::fs::write(
            ws.join("sites/framework-laptops/v2/index.html"),
            "<p>new</p>\n",
        )
        .unwrap();
        std::fs::write(ws.join("sites/framework-laptops/data.json"), "{}").unwrap();
        held.put_back(
            ws,
            Some(&start),
            TurnSteps::of_events(ws, &[command_step(command)]),
        )
        .await;

        assert_eq!(
            std::fs::read_to_string(&notes).unwrap(),
            "an edit not saved yet\n"
        );
        assert_eq!(
            std::fs::read_to_string(&weights).unwrap(),
            "{\"Laptop 12\":\"1.3 kg\"}\n"
        );
        assert_eq!(
            std::fs::read_to_string(ws.join("sites/framework-laptops/data.json")).unwrap(),
            THEIRS
        );
        assert!(!ws.join("sites/framework-laptops/v2/index.html").exists());
        assert_eq!(held.restored.len(), 4, "{:?}", held.restored);
        assert_eq!(held.reply_line().as_deref(), Some(NOT_CHANGED));
        // the folder's status is as the turn found it, so its save holds nothing of the page
        let now = super::super::collect_git_status_porcelain(ws)
            .await
            .unwrap();
        assert!(
            super::super::git_status_delta_paths(&start, &now).is_empty(),
            "{now:?}"
        );
    }

    /// A turn's card writes the space's record again without a page whose folder was gone at that
    /// moment (the turn had moved it), and a turn can write the record itself: each held page's
    /// entry goes back as the turn began, so the next turn still holds that page and its own chat
    /// still reads it as its own.
    #[tokio::test]
    async fn a_held_pages_entry_goes_back_into_the_record() {
        let (this, other) = (Uuid::new_v4(), Uuid::new_v4());
        let workspace = space_with_two_pages(&this, &other);
        let ws = workspace.path();
        let start = super::super::collect_git_status_porcelain(ws)
            .await
            .unwrap();
        let mut held = HeldPages::of_turn(ws, Some(&this), &[], Some(&start));

        // the turn moves the other chat's page to a folder of its own and opens its card there:
        // the record keeps only folders that exist at that moment
        std::fs::rename(
            ws.join("sites/framework-laptops"),
            ws.join("sites/framework-13-vs-16"),
        )
        .unwrap();
        write_record(
            ws,
            vec![
                page(
                    "sites/framework-13-vs-16",
                    "13 vs 16",
                    Some(&this),
                    &PAGE_SERVER,
                ),
                page(
                    "sites/framework-13-16",
                    "Framework Laptop 13 vs 16",
                    Some(&this),
                    &PAGE_SERVER,
                ),
            ],
        );
        let command = "mv sites/framework-laptops sites/framework-13-vs-16";
        held.put_back(
            ws,
            Some(&start),
            TurnSteps::of_events(ws, &[command_step(command)]),
        )
        .await;

        assert_eq!(
            std::fs::read_to_string(ws.join("sites/framework-laptops/data.json")).unwrap(),
            THEIRS
        );
        assert!(space_pages_lines(ws, Some(&other), &[]).contains(
            "\"Framework Laptop 12, 13 and 16\", in `sites/framework-laptops/`: made in this chat."
        ));
        assert!(
            space_pages_lines(ws, Some(&this), &[]).contains(
                "\"Framework Laptop 12, 13 and 16\", in `sites/framework-laptops/`: made in another chat, read-only here."
            )
        );
        // a turn that wrote the record to claim the page: the entry goes back too
        write_record(
            ws,
            vec![page(
                "sites/framework-laptops",
                "Mine now",
                Some(&this),
                &PAGE_SERVER,
            )],
        );
        held.put_back(ws, Some(&start), TurnSteps::default()).await;
        assert!(space_pages_lines(ws, Some(&other), &[]).contains(
            "\"Framework Laptop 12, 13 and 16\", in `sites/framework-laptops/`: made in this chat."
        ));
    }

    /// The steps a run's events carry: the paths its edit steps named, as workspace paths, and the
    /// commands that may write. A read-only command names nothing the turn changed. A command names
    /// a page by its folder or its own name as a whole part of a path, never a longer name that
    /// starts the same.
    #[test]
    fn a_turns_steps_reach_what_they_name() {
        let workspace = tempfile::tempdir().unwrap();
        let ws = workspace.path();
        let steps = TurnSteps::of_events(
            ws,
            &[
                edit_step(&ws.join("sites/porto/data.json").display().to_string()),
                edit_step("./sites/seville/index.html"),
                command_step("cat sites/lisbon/data.json"),
                command_step("rg -n price sites/faro"),
                json!({"type": "item.started", "item": {
                    "id": "c2", "type": "command_execution",
                    "command": "printf x > sites/madrid-2/data.json",
                    "command_argv": ["bash", "-lc", "printf x > sites/madrid-2/data.json"],
                }}),
                command_step("cd sites && rm -rf braga"),
            ],
        );
        assert!(steps.reached("sites/porto/data.json", "sites/porto"));
        assert!(!steps.reached("sites/porto/app.js", "sites/porto"));
        assert!(steps.reached("sites/seville/index.html", "sites/seville"));
        assert!(!steps.reached("sites/lisbon/data.json", "sites/lisbon"));
        assert!(!steps.reached("sites/faro/data.json", "sites/faro"));
        assert!(steps.reached("sites/madrid-2/data.json", "sites/madrid-2"));
        assert!(!steps.reached("sites/madrid/data.json", "sites/madrid"));
        assert!(steps.reached("sites/braga/index.html", "sites/braga"));
        assert!(TurnSteps::unknown().reached("sites/any/file", "sites/any"));
        assert!(names_folder("/workspace/sites/porto/x", "sites/porto"));
        assert!(names_folder("'sites/porto'", "sites/porto"));
        assert!(!names_folder("sites/porto-2/x", "sites/porto"));
        assert!(!names_folder("porto.pt", "sites/porto"));
        assert!(!names_folder("transporto", "sites/porto"));
    }

    /// When the turn's change to another chat's page was all it changed, the runtime's line is its
    /// reply: the model's words would tell of a change no one can see. With a change of its own,
    /// the line ends the reply.
    #[test]
    fn the_line_is_the_reply_when_that_change_was_all_the_turn_made() {
        let (this, other) = (Uuid::new_v4(), Uuid::new_v4());
        let workspace = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(workspace.path().join("sites/framework-laptops")).unwrap();
        write_record(
            workspace.path(),
            vec![page(
                "sites/framework-laptops",
                "Framework Laptop 12, 13 and 16",
                Some(&other),
                &PAGE_SERVER,
            )],
        );
        let mut held = HeldPages::of_turn(workspace.path(), Some(&this), &[], None);
        let mut files = vec![returned_file(
            "sites/framework-laptops/data.json",
            Some("{}\n"),
        )];
        held.leave_out_returned(workspace.path(), &mut files);
        let mut reply = "I added each one's weight to the comparison.".to_string();
        held.reply(&mut reply, &files);
        assert_eq!(reply, NOT_CHANGED);
        let mut reply = "I made a page of my own.".to_string();
        held.reply(
            &mut reply,
            &[returned_file("sites/framework-13-16/index.html", None)],
        );
        assert_eq!(reply, format!("I made a page of my own.\n\n{NOT_CHANGED}"));
        // nothing held back: the reply is the model's
        let quiet = HeldPages::of_turn(workspace.path(), Some(&other), &[], None);
        let mut reply = "I added each one's weight.".to_string();
        quiet.reply(&mut reply, &[]);
        assert_eq!(reply, "I added each one's weight.");
    }
}
