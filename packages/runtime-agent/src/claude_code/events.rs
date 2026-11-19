//! The event adapter of a local-engine turn (docs/Local-Engine-Turns.md, 3.7).
//!
//! It reads the lines `claude --print --output-format stream-json` prints and turns them into
//! the Codex-exec-shaped events the existing consumers read: `extract_codex_messages` makes the
//! turn's steps of them, and `ReplyDraftStream` its reply draft. It also keeps what the end of
//! the turn needs: the session and model of `system/init` once the launch checks passed (3.6),
//! the top-level `init`s and `result`s and the background tasks the end-of-turn rule reads
//! (3.6), the latest top-level `result` that can be the reply (the reply and success), the usage
//! and the permission denials of all the turn's top-level `result`s, what classifies a failure
//! (2.6) or says that `--resume` named a session Claude Code does not have (11.9), and a bounded
//! run log.
//!
//! | Claude Code stream-json | Synthesized event |
//! |---|---|
//! | `system` / `init` | none: records `session_id` and `model`, runs the launch checks (a later turn's by its `cwd` and the folder it started in), and counts a top-level one |
//! | `system` / `task_started`, `task_notification`, `background_tasks_changed` | none: they update the live background tasks and the tasks the turn started |
//! | `system` / `permission_denied` | none: a permission denial (3.7) |
//! | top-level `stream_event` text delta | `item.updated` `agent_message` `{id: "<message id>:<block index>", text, phase: "final_answer"}` |
//! | a text block that a `tool_use` follows in the same message | `item.completed` `agent_message` with `phase: "commentary"`, then [`DRAFT_RESET_EVENT`] when the text was drafted |
//! | `Bash` or `Monitor`, then its result | `item.started`, `item.completed` `command_execution` |
//! | `Edit`, `Write`, `NotebookEdit` | `item.completed` `file_change` with paths relative to the folder |
//! | `WebSearch`, then its result | `item.started`, `item.completed` `web_search` `{query}` |
//! | `TodoWrite`, or `TaskCreate` and `TaskUpdate` | `item.updated` `todo_list` with the whole list |
//! | any other tool | `item.started`, `item.completed` `mcp_tool_call` `{server: "claude-code", tool, engine: "claude-code"}` |
//! | events of Claude Code's subagents (`parent_tool_use_id`) | the same mapping, but never a draft |
//! | thinking | ignored, and not logged |
//! | top-level `result` | none: its usage and denials count toward the turn's; it gives the reply and success when it has no `origin` (the person's own turn) or a `task-notification` one that names a run other than a background command's (a subagent's follow-up), or names no run while no task event named a run id; never for a peer message's turn, an `origin` this adapter does not know or a held turn (a `task-notification` one with `num_turns` 0 and an empty `result`), unless it is the first `result` after held ones that is not held, which answers their notifications and gives the reply when one of them could have; it ends the turn only once the person's own `result` was read, as 3.6 says |
//! | anything else | ignored, but kept in the run log, less what it never keeps (below) |
//!
//! Every string an event carries is redacted ([`Redactor`]): `sk-ant-` tokens, the folder's
//! absolute prefix made relative and the home folder's made `~`, and Claude Code's own names for
//! both, slugs of their paths, made [`THIS_SPACE_NAME`] and [`HOME_NAME`]. A step's path outside
//! the folder shows as [`OUTSIDE_THIS_SPACE`]. Nothing here labels a step: labels come only from
//! the runtime's own tables (`jobs::activity_labels`, `claude_code_tool_activity` for tool steps).
//!
//! The run log never keeps a cost or the sign-in's expiry (2.6): of any line, no key that names a
//! cost or a credential at any depth (`total_cost_usd`, `costUSD`, `costBasis`,
//! `credential_expires_at`); of a `result`, neither per-model usage map (`modelUsage`,
//! `model_usage_since_last_result`); of a `rate_limit_event`, only `rate_limit_info`'s `status`
//! and `resetsAt`, not the plan's utilization or overage state (3.6).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};
use uuid::Uuid;

use super::job::ENGINE;
use super::{ExecutionMode, FailureCode, LaunchGrant};
use crate::jobs::JobMessage;

/// The tool server a lane turn's tool steps name (`mcp_tool_call`, 3.7). Those steps also carry
/// `engine: "claude-code"`, which no Codex item does: a step's label comes from the lane's own
/// table only with that mark, so a Codex turn's MCP server of the same name keeps its own label.
pub const TOOL_SERVER: &str = "claude-code";
/// What a step shows for a path outside the space's folder (3.7).
pub const OUTSIDE_THIS_SPACE: &str = "outside this space";
/// The synthesized event that clears the reply draft: the text it showed turned out to be
/// commentary, a text block a tool call followed in the same message. `ReplyDraftStream`
/// restarts on it as on `stream.retry`. Codex never sends it.
pub const DRAFT_RESET_EVENT: &str = "draft.reset";
/// What replaces an `sk-ant-` token in every string the lane sends (3.6).
pub const REDACTED: &str = "[redacted]";
/// What Claude Code's name for the space's folder becomes in every string the lane sends (3.6):
/// it names the folder by a slug of its absolute path, which names the OS user.
pub const THIS_SPACE_NAME: &str = "[this space]";
/// What the start of Claude Code's name for the home folder, or for another folder under it,
/// becomes in every string the lane sends (3.6).
pub const HOME_NAME: &str = "[home]";
/// The most of a command's output its step keeps (3.7).
pub const MAX_COMMAND_OUTPUT_CHARS: usize = 4_000;
/// Claude Code's task type of a background command or a Monitor watch: the background tasks
/// that never keep a turn open after its `result` (3.6).
pub const BACKGROUND_COMMAND_TASK: &str = "local_bash";
/// Claude Code's task type of an ambient task, which the end-of-turn rule leaves out (3.6).
pub const AMBIENT_TASK: &str = "ambient";
/// The `provider` of a lane turn's conversation state and artifacts (2.6).
pub const PROVIDER: &str = "claude-code";
/// Where Studio shows a note of the turn, such as its changes staying on this computer: under the
/// reply, once the turn is done, whether Details is open or not. A status step carries it as
/// `presentation.placement`, which the controller keeps with the step's other metadata.
pub const REPLY_NOTE_PLACEMENT: &str = "reply_note";

/// The `presentation` of a status step that is a note of the turn ([`REPLY_NOTE_PLACEMENT`]).
pub fn reply_note() -> Value {
    json!({ "placement": REPLY_NOTE_PLACEMENT })
}

const COMMAND_OUTPUT_TRUNCATED: &str = "[command output truncated; keeping tail]\n";
/// A text block stops drafting here; the draft itself stops growing at 128 KiB.
const MAX_DRAFT_TEXT_BYTES: usize = 256 * 1024;
/// A command step's command, at most: a longer script gets no label anyway.
const MAX_COMMAND_CHARS: usize = 16 * 1024;
const MAX_COMMENTARY_CHARS: usize = 16 * 1024;
const MAX_FIELD_CHARS: usize = 1_000;
const MAX_PLAN_ITEMS: usize = 256;
/// The messages whose blocks the adapter remembers, to tell commentary from a reply.
const REMEMBERED_MESSAGES: usize = 64;
const MAX_TEXTS_PER_MESSAGE: usize = 64;
const MAX_PENDING_TOOLS: usize = 4_096;
const MAX_SEEN_TOOLS: usize = 16_384;
const MAX_LIVE_TASKS: usize = 1_024;
/// The tasks a turn started that it keeps by their run id, for their follow-up turns.
const MAX_TASK_RUNS: usize = 1_024;
const MAX_KEPT_ERRORS: usize = 8;
const MAX_DENIALS: usize = 1_024;
/// The longest text a failure keeps for its Details.
const MAX_FAILURE_TEXT_CHARS: usize = 4_000;
/// What the adapter keeps of lines that do not parse, for classifying a failure.
const MAX_UNPARSED_TEXT_CHARS: usize = 4_000;
const UNPARSED_PREVIEW_CHARS: usize = 200;

/// Claude Code's sign-in failures, read from text only when no structured field says (2.6).
const SIGN_IN_PHRASES: [&str; 5] = [
    "please run /login",
    "not logged in",
    "invalid api key",
    "oauth token has expired",
    "authentication_error",
];
/// A Claude plan's usage limit, read from text only when no `rate_limit_event` says (2.6). A
/// rate limit an API key or cloud account hit reads differently, and is no plan limit.
const PLAN_LIMIT_PHRASES: [&str; 4] = [
    "usage limit reached",
    "hit your limit",
    "-hour limit reached",
    "weekly limit reached",
];
/// The missing-session error of `--resume`, which Phase 0 item 7 records (2.7, 11.9).
const RESUME_MISS_PHRASES: [&str; 1] = ["no conversation found with session id"];
/// What a tool result says when Claude Code declined a step that needs the person's OK (3.7).
const DENIAL_PHRASES: [&str; 3] = [
    "requested permissions to",
    "haven't granted it yet",
    "have not granted it yet",
];

fn str_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// A string or a number, as Claude Code writes ids.
fn id_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| match value.get(*key)? {
        Value::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    })
}

/// A line of the main conversation, not of a subagent: no `parent_tool_use_id`.
fn is_top_level(line: &Value) -> bool {
    parent_tool_use_id(line).is_none()
}

fn parent_tool_use_id(line: &Value) -> Option<&str> {
    str_field(line, "parent_tool_use_id").filter(|id| !id.is_empty())
}

/// At most `max_chars` characters of `text`, with an ellipsis when it was longer.
fn bounded(text: &str, max_chars: usize) -> String {
    match text.char_indices().nth(max_chars) {
        Some((end, _)) => format!("{}…", &text[..end]),
        None => text.to_string(),
    }
}

/// The last `max_chars` characters of `text`.
fn tail_chars(text: &str, max_chars: usize) -> &str {
    let count = text.chars().count();
    if count <= max_chars {
        return text;
    }
    let start = text
        .char_indices()
        .nth(count - max_chars)
        .map_or(text.len(), |(index, _)| index);
    &text[start..]
}

/// Replaces every `sk-ant-` token (`sk-ant-` in any letter case, then at least one of
/// `[A-Za-z0-9_-]`) with [`REDACTED`]. A bare mention of the prefix stays.
pub fn redact_tokens(text: &str) -> String {
    const PREFIX: &[u8] = b"sk-ant-";
    let bytes = text.as_bytes();
    let is_token_byte = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-';
    let mut redacted = String::new();
    let mut copied = 0;
    let mut at = 0;
    while at + PREFIX.len() <= bytes.len() {
        // A match starts at an ASCII byte, so `at` and the token's end are char boundaries.
        if bytes[at..at + PREFIX.len()].eq_ignore_ascii_case(PREFIX) {
            let start = at + PREFIX.len();
            let end = bytes[start..]
                .iter()
                .position(|byte| !is_token_byte(*byte))
                .map_or(bytes.len(), |length| start + length);
            if end > start {
                redacted.push_str(&text[copied..at]);
                redacted.push_str(REDACTED);
                copied = end;
                at = end;
                continue;
            }
        }
        at += 1;
    }
    if copied == 0 {
        return text.to_string();
    }
    redacted.push_str(&text[copied..]);
    redacted
}

#[derive(Clone, Copy)]
enum PathPrefix {
    /// The space's folder: a path in it becomes relative to it.
    Folder,
    /// The home folder: it becomes `~`.
    Home,
}

enum Boundary {
    /// The text ends right after the prefix.
    Ends,
    /// A `/` follows: a path inside it.
    Slash,
    /// Punctuation or white space follows: the prefix is a whole path.
    Delimiter,
    /// The prefix is only the start of another name (`space-2`, `space.bak`).
    Continues,
}

fn continues_a_name(character: char) -> bool {
    character.is_alphanumeric()
        || matches!(character, '_' | '-' | '.' | '+' | '@' | '~' | '%' | '#')
}

fn boundary_after(after: &str) -> Boundary {
    let mut characters = after.chars();
    match characters.next() {
        None => Boundary::Ends,
        Some('/') => Boundary::Slash,
        // A sentence's full stop ends a path; `space.bak` is another name.
        Some('.') => match characters.next() {
            Some(next) if next.is_alphanumeric() || matches!(next, '_' | '-') => {
                Boundary::Continues
            }
            _ => Boundary::Delimiter,
        },
        Some(character) if continues_a_name(character) => Boundary::Continues,
        Some(_) => Boundary::Delimiter,
    }
}

fn replace_path_prefix(text: &str, prefix: &str, kind: PathPrefix) -> String {
    if prefix.is_empty() || !text.contains(prefix) {
        return text.to_string();
    }
    let mut replaced = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(found) = rest.find(prefix) {
        replaced.push_str(&rest[..found]);
        let after = &rest[found + prefix.len()..];
        let mut next = after;
        match (boundary_after(after), kind) {
            (Boundary::Continues, _) => replaced.push_str(prefix),
            (_, PathPrefix::Home) => replaced.push('~'),
            (Boundary::Ends | Boundary::Delimiter, PathPrefix::Folder) => replaced.push('.'),
            (Boundary::Slash, PathPrefix::Folder) => {
                if after[1..].chars().next().is_some_and(continues_a_name) {
                    next = &after[1..];
                } else {
                    replaced.push('.');
                }
            }
        }
        rest = next;
    }
    replaced.push_str(rest);
    replaced
}

/// The absolute spellings of `path` to look for: as given and resolved, without a trailing
/// slash, longest first. A root or relative path has none.
fn path_spellings(path: &Path) -> Vec<String> {
    let mut spellings: Vec<String> = Vec::new();
    for candidate in [Some(path.to_path_buf()), std::fs::canonicalize(path).ok()]
        .into_iter()
        .flatten()
    {
        let Some(text) = candidate.to_str() else {
            continue;
        };
        let text = text.trim_end_matches('/');
        if text.len() > 1 && text.starts_with('/') && !spellings.iter().any(|known| known == text) {
            spellings.push(text.to_string());
        }
    }
    spellings.sort_by_key(|spelling| std::cmp::Reverse(spelling.len()));
    spellings
}

/// Claude Code's name for the folder at the absolute `path` in its own per-folder directories,
/// such as `~/.claude/projects/<name>/memory/`, which every `init` names as `memory_paths.auto`,
/// and a background command's output file under `$TMPDIR/claude-<uid>/<name>/` (Phase 0, B.2):
/// the path with every character but an ASCII letter or digit made `-`, one for each UTF-16
/// unit of a JavaScript string. `/home/person/.instafy/workspace/w1` is
/// `-home-person--instafy-workspace-w1`.
fn claude_folder_name(path: &str) -> String {
    let mut name = String::with_capacity(path.len());
    for character in path.chars() {
        if character.is_ascii_alphanumeric() {
            name.push(character);
        } else {
            name.extend(std::iter::repeat_n('-', character.len_utf16()));
        }
    }
    name
}

/// Claude Code's names for the folder spellings `spellings`, longest first.
fn claude_folder_names(spellings: &[String]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for spelling in spellings {
        let name = claude_folder_name(spelling);
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names.sort_by_key(|name| std::cmp::Reverse(name.len()));
    names
}

#[derive(Clone, Copy)]
enum FolderName {
    /// The space's folder: its whole name becomes [`THIS_SPACE_NAME`].
    Space,
    /// The home folder: its name, or the start of another folder's name under it, becomes
    /// [`HOME_NAME`].
    Home,
}

/// Whether `character` can be part of one of Claude Code's folder names.
fn in_a_folder_name(character: char) -> bool {
    character.is_ascii_alphanumeric() || character == '-'
}

/// `text` with Claude Code's folder `name` replaced as `kind` says. A name counts only where one
/// starts: after no letter, digit or `-`. The space's must also end there, so a folder whose
/// name only starts like it (`<name>-2`) is left to the home folder's pass. The home folder's
/// may go on with a `-`, as the name of every folder under it does, but not with a letter or
/// digit (`-home-personal` is another folder's).
fn replace_folder_name(text: &str, name: &str, kind: FolderName) -> String {
    if name.is_empty() || !text.contains(name) {
        return text.to_string();
    }
    let mut replaced = String::with_capacity(text.len());
    let mut copied = 0;
    let mut from = 0;
    while let Some(found) = text[from..].find(name) {
        let start = from + found;
        let end = start + name.len();
        let starts = !text[..start]
            .chars()
            .next_back()
            .is_some_and(in_a_folder_name);
        let ends = match (text[end..].chars().next(), kind) {
            (None, _) => true,
            (Some(next), FolderName::Space) => !in_a_folder_name(next),
            (Some(next), FolderName::Home) => !next.is_ascii_alphanumeric(),
        };
        if starts && ends {
            replaced.push_str(&text[copied..start]);
            replaced.push_str(match kind {
                FolderName::Space => THIS_SPACE_NAME,
                FolderName::Home => HOME_NAME,
            });
            copied = end;
            from = end;
        } else {
            // A name is ASCII, so the byte after its first starts a character.
            from = start + 1;
        }
    }
    replaced.push_str(&text[copied..]);
    replaced
}

/// What every string the lane sends goes through (3.6): `sk-ant-` tokens are replaced, the
/// absolute folder prefix becomes relative and the home folder's prefix `~`, since both name the
/// OS user. So does Claude Code's own name for each of them, a slug of its absolute path
/// ([`claude_folder_name`]): the folder's becomes [`THIS_SPACE_NAME`], and the home folder's, at
/// the start of another folder's name too, [`HOME_NAME`].
#[derive(Clone, Debug, Default)]
pub struct Redactor {
    folders: Vec<String>,
    homes: Vec<String>,
    /// Claude Code's names for the folder and for the home folder, longest first.
    folder_names: Vec<String>,
    home_names: Vec<String>,
}

impl Redactor {
    pub fn new(folder: &Path, home: Option<&Path>) -> Self {
        let folders = path_spellings(folder);
        let homes = home.map(path_spellings).unwrap_or_default();
        Self {
            folder_names: claude_folder_names(&folders),
            home_names: claude_folder_names(&homes),
            folders,
            homes,
        }
    }

    pub fn text(&self, text: &str) -> String {
        let mut redacted = redact_tokens(text);
        for folder in &self.folders {
            redacted = replace_path_prefix(&redacted, folder, PathPrefix::Folder);
        }
        for home in &self.homes {
            redacted = replace_path_prefix(&redacted, home, PathPrefix::Home);
        }
        for name in &self.folder_names {
            redacted = replace_folder_name(&redacted, name, FolderName::Space);
        }
        for name in &self.home_names {
            redacted = replace_folder_name(&redacted, name, FolderName::Home);
        }
        redacted
    }

    /// At most `max_chars` of `text`, redacted before it is cut, so no cut leaves a part of a
    /// path or token that redaction would no longer recognize.
    pub fn bounded(&self, text: &str, max_chars: usize) -> String {
        bounded(&self.text(text), max_chars)
    }

    /// Redacts every string in `value`.
    pub fn json(&self, value: &mut Value) {
        match value {
            Value::String(text) => {
                let redacted = self.text(text);
                if redacted != *text {
                    *text = redacted;
                }
            }
            Value::Array(items) => items.iter_mut().for_each(|item| self.json(item)),
            Value::Object(map) => map.values_mut().for_each(|item| self.json(item)),
            _ => {}
        }
    }

    /// A draft's text so far, redacted. An end that could still grow into the folder's or the
    /// home folder's path, or into Claude Code's name for either, is held back until it has, so
    /// the draft never shows a part of one.
    pub fn draft(&self, text: &str) -> String {
        let held = self.held_back(text);
        self.text(&text[..text.len() - held])
    }

    fn held_back(&self, text: &str) -> usize {
        let mut held = 0;
        for spelling in self
            .folders
            .iter()
            .chain(&self.homes)
            .chain(&self.folder_names)
            .chain(&self.home_names)
        {
            let pattern = format!("{spelling}/");
            // Prefixes of two characters or more, up to the whole pattern.
            let ends = pattern
                .char_indices()
                .map(|(index, _)| index)
                .skip(2)
                .chain(std::iter::once(pattern.len()));
            for end in ends {
                if end > held && text.ends_with(&pattern[..end]) {
                    held = end;
                }
            }
        }
        held
    }

    /// A step's path (3.7): relative to the folder, or [`OUTSIDE_THIS_SPACE`].
    pub fn step_path(&self, raw: &str) -> String {
        let raw = raw.trim();
        if raw.is_empty() || raw.starts_with('~') {
            return OUTSIDE_THIS_SPACE.to_string();
        }
        let path = Path::new(raw);
        let inside = if path.is_absolute() {
            match self
                .folders
                .iter()
                .find_map(|folder| path.strip_prefix(folder).ok())
            {
                Some(inside) => inside,
                None => return OUTSIDE_THIS_SPACE.to_string(),
            }
        } else {
            // Claude Code runs in the folder: a relative path is read against it.
            path
        };
        let mut parts: Vec<&str> = Vec::new();
        for component in inside.components() {
            match component {
                Component::Normal(part) => match part.to_str() {
                    Some(part) => parts.push(part),
                    None => return OUTSIDE_THIS_SPACE.to_string(),
                },
                Component::CurDir => {}
                Component::ParentDir => {
                    if parts.pop().is_none() {
                        return OUTSIDE_THIS_SPACE.to_string();
                    }
                }
                Component::RootDir | Component::Prefix(_) => {
                    return OUTSIDE_THIS_SPACE.to_string();
                }
            }
        }
        if parts.is_empty() {
            return ".".to_string();
        }
        redact_tokens(&parts.join("/"))
    }
}

/// What `system/init` reported, once the launch checks passed (3.6).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InitFacts {
    pub session_id: Uuid,
    pub model: String,
}

/// The launch checks of 3.6 on a `system/init` event. Claude Code documents `session_id`, `cwd`,
/// `model`, `permissionMode` and `mcp_servers` as always present, so a missing one fails like a
/// mismatch: the session id is a UUID, `cwd` is the folder, the permission mode is the one the
/// turn's `mode` passed (`acceptEdits` to apply, `plan` to plan only, 11.12) and no MCP server
/// loaded. The error says which, in plain words.
pub fn check_init(init: &Value, folder: &Path, mode: ExecutionMode) -> Result<InitFacts, String> {
    check_init_in(init, folder, mode, InitTurn::First)
}

/// The launch checks of 3.6 on a later top-level `system/init` of the same `claude`: a follow-up
/// turn's, or a peer message's turn's. As [`check_init`], but for the folder. Claude Code 2.1.325
/// builds each `init`'s `cwd` from the shell's current folder, which a `cd` inside the folder
/// moves for the rest of the session, and names the folder it started in as `original_cwd`, which
/// does not follow the shell. So `cwd` must canonicalize to the folder or to a folder inside it,
/// and `original_cwd`, when present and not `null`, must also canonicalize to the folder itself.
/// A `cwd` that no longer exists, such as a folder deleted after a `cd` into it, is read by its
/// longest ancestor that does: that ancestor canonicalized, and the plain names after it joined.
pub fn check_later_init(
    init: &Value,
    folder: &Path,
    mode: ExecutionMode,
) -> Result<InitFacts, String> {
    check_init_in(init, folder, mode, InitTurn::Later)
}

/// Which of a `claude` process's top-level `init`s the launch checks read.
#[derive(Clone, Copy, PartialEq, Eq)]
enum InitTurn {
    /// The first: the launch itself, whose `cwd` must be the folder.
    First,
    /// A later one, whose shell may have moved inside the folder.
    Later,
}

fn check_init_in(
    init: &Value,
    folder: &Path,
    mode: ExecutionMode,
    turn: InitTurn,
) -> Result<InitFacts, String> {
    let field = |name: &str| {
        init.get(name)
            .filter(|value| !value.is_null())
            .ok_or_else(|| format!("Claude Code's init event has no {name}."))
    };
    let session_id = field("session_id")?
        .as_str()
        .and_then(parse_session_id)
        .ok_or_else(|| "Claude Code's session id is not a UUID.".to_string())?;
    let cwd = field("cwd")?
        .as_str()
        .ok_or_else(|| "Claude Code reported no folder.".to_string())?;
    let in_the_folder = match turn {
        InitTurn::First => is_the_folder(Path::new(cwd), folder),
        // The shell's folder, wherever a `cd` moved it, and the folder `claude` started in.
        InitTurn::Later => {
            is_in_the_folder(Path::new(cwd), folder)
                && init
                    .get("original_cwd")
                    .filter(|value| !value.is_null())
                    .is_none_or(|original| {
                        original
                            .as_str()
                            .is_some_and(|original| is_the_folder(Path::new(original), folder))
                    })
        }
    };
    if !in_the_folder {
        return Err(match turn {
            InitTurn::First => "Claude Code started in another folder than this space's.",
            InitTurn::Later => {
                "Claude Code started a later turn in another folder than this space's."
            }
        }
        .to_string());
    }
    let model = field("model")?
        .as_str()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .ok_or_else(|| "Claude Code reported no model.".to_string())?;
    let permission_mode = field("permissionMode")?
        .as_str()
        .ok_or_else(|| "Claude Code reported no permission mode.".to_string())?;
    if permission_mode != mode.permission_mode() {
        return Err(format!(
            "Claude Code started with permission mode {}, not {}.",
            bounded(permission_mode, 40),
            mode.permission_mode()
        ));
    }
    let servers = field("mcp_servers")?
        .as_array()
        .ok_or_else(|| "Claude Code reported no MCP server list.".to_string())?;
    if !servers.is_empty() {
        return Err(format!(
            "Claude Code started with {} MCP server{}, where Instafy asked for none.",
            servers.len(),
            if servers.len() == 1 { "" } else { "s" }
        ));
    }
    if let Some(loaded) = space_configuration_named(init, folder) {
        return Err(loaded);
    }
    Ok(InitFacts {
        session_id,
        model: bounded(model, 200),
    })
}

/// The space's own Claude Code configuration, read from what `init` says loaded (3.6, D6). The
/// lane's flags keep it out of the turn, so an `init` that names it shows a flag that stopped
/// working: the output style the space defines or selects, or every skill, agent and command the
/// space defines at its root, when it defines at least two. One name alone proves nothing, since
/// the person's own configuration can define the same name. The space's hooks run before `init`,
/// so this stops the turn after them, not before.
fn space_configuration_named(init: &Value, folder: &Path) -> Option<String> {
    let space = SpaceConfiguration::read(folder);
    if let Some(style) = init.get("output_style").and_then(Value::as_str)
        && style != "default"
        && space.styles.contains(style)
    {
        return Some(format!(
            "Claude Code started with this space's own output style, {}, which Instafy keeps out.",
            bounded(style, 80)
        ));
    }
    if space.definitions.len() < 2 {
        return None;
    }
    let listed: HashSet<&str> = ["skills", "agents", "slash_commands"]
        .iter()
        .filter_map(|key| init.get(*key).and_then(Value::as_array))
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if !space
        .definitions
        .iter()
        .all(|name| listed.contains(name.as_str()))
    {
        return None;
    }
    let mut names: Vec<String> = space
        .definitions
        .iter()
        .take(5)
        .map(|name| bounded(name, 60))
        .collect();
    if space.definitions.len() > names.len() {
        names.push(format!("{} more", space.definitions.len() - names.len()));
    }
    Some(format!(
        "Claude Code started with this space's own skills, agents and commands ({}), which Instafy keeps out.",
        names.join(", ")
    ))
}

/// At most this many entries of each folder under the space's `.claude` are read for names.
const SPACE_CONFIGURATION_ENTRIES: usize = 256;
/// At most this many bytes of a file are read: a name sits in the frontmatter at its top.
const SPACE_CONFIGURATION_HEAD: usize = 4096;
/// A settings file larger than this is not read for its `outputStyle`.
const SPACE_SETTINGS_BYTES: u64 = 1024 * 1024;

/// What the space's root `.claude` folder defines, under the names Claude Code lists them by.
#[derive(Debug, Default)]
struct SpaceConfiguration {
    /// The output styles it defines, and the `outputStyle` its settings select.
    styles: BTreeSet<String>,
    /// The skills, agents and commands it defines.
    definitions: BTreeSet<String>,
}

impl SpaceConfiguration {
    /// Reads the space's root `.claude` folder. What cannot be read names nothing, so it can
    /// only make the check miss, never stop a turn.
    fn read(folder: &Path) -> Self {
        let claude = folder.join(".claude");
        let mut space = Self::default();
        for skill in folder_entries(&claude.join("skills")) {
            let file = skill.join("SKILL.md");
            if file.is_file() {
                space
                    .definitions
                    .insert(frontmatter_name(&file).unwrap_or_else(|| file_name(&skill)));
            }
        }
        for agent in markdown_files(&claude.join("agents")) {
            space
                .definitions
                .insert(frontmatter_name(&agent).unwrap_or_else(|| file_stem(&agent)));
        }
        for command in markdown_files(&claude.join("commands")) {
            space.definitions.insert(file_stem(&command));
        }
        for style in markdown_files(&claude.join("output-styles")) {
            space
                .styles
                .insert(frontmatter_name(&style).unwrap_or_else(|| file_stem(&style)));
        }
        for settings in ["settings.json", "settings.local.json"] {
            if let Some(style) = selected_output_style(&claude.join(settings)) {
                space.styles.insert(style);
            }
        }
        space.definitions.retain(|name| !name.is_empty());
        space.styles.retain(|name| !name.is_empty());
        space
    }
}

/// The entries of `dir`, sorted, at most [`SPACE_CONFIGURATION_ENTRIES`].
fn folder_entries(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<PathBuf> = read
        .filter_map(Result::ok)
        .take(SPACE_CONFIGURATION_ENTRIES)
        .map(|entry| entry.path())
        .collect();
    entries.sort();
    entries
}

/// The `.md` files directly in `dir`.
fn markdown_files(dir: &Path) -> Vec<PathBuf> {
    folder_entries(dir)
        .into_iter()
        .filter(|path| {
            path.extension()
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
                && path.is_file()
        })
        .collect()
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn file_stem(path: &Path) -> String {
    path.file_stem()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// The `name:` of a file's YAML frontmatter, read from its first bytes.
fn frontmatter_name(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut head = Vec::with_capacity(SPACE_CONFIGURATION_HEAD);
    std::fs::File::open(path)
        .ok()?
        .take(SPACE_CONFIGURATION_HEAD as u64)
        .read_to_end(&mut head)
        .ok()?;
    let text = String::from_utf8_lossy(&head);
    let mut lines = text.lines();
    if lines.next()?.trim_end() != "---" {
        return None;
    }
    for line in lines {
        let line = line.trim_end();
        if line == "---" {
            return None;
        }
        if let Some(value) = line.strip_prefix("name:") {
            let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
            return (!value.is_empty()).then(|| value.to_string());
        }
    }
    None
}

/// The `outputStyle` a settings file selects.
fn selected_output_style(path: &Path) -> Option<String> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() > SPACE_SETTINGS_BYTES {
        return None;
    }
    let settings: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    settings
        .get("outputStyle")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// A session id in the UUID form `--resume` takes.
fn parse_session_id(value: &str) -> Option<Uuid> {
    (value.len() == 36)
        .then(|| Uuid::parse_str(value).ok())
        .flatten()
}

/// Whether `reported` canonicalizes to `folder`: the same path once resolved, or the same
/// directory under another spelling.
fn is_the_folder(reported: &Path, folder: &Path) -> bool {
    if !reported.is_absolute() {
        return false;
    }
    let (Ok(reported), Ok(folder)) = (
        std::fs::canonicalize(reported),
        std::fs::canonicalize(folder),
    ) else {
        return false;
    };
    if reported == folder {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if let (Ok(left), Ok(right)) = (std::fs::metadata(&reported), std::fs::metadata(&folder)) {
            return left.dev() == right.dev() && left.ino() == right.ino();
        }
    }
    false
}

/// Whether `reported` canonicalizes to `folder` or to a folder inside it. Both are resolved
/// first, so neither `..` nor a link inside the folder that leads out of it passes. A `reported`
/// that does not exist, such as a folder deleted after a `cd` into it, resolves through its
/// longest ancestor that does ([`resolve_through_an_ancestor`]).
fn is_in_the_folder(reported: &Path, folder: &Path) -> bool {
    if is_the_folder(reported, folder) {
        return true;
    }
    if !reported.is_absolute() {
        return false;
    }
    match (
        resolve_through_an_ancestor(reported),
        std::fs::canonicalize(folder),
    ) {
        (Some(reported), Ok(folder)) => reported.starts_with(&folder),
        _ => false,
    }
}

/// `path` resolved: canonicalized when it exists, and otherwise its longest ancestor that
/// canonicalizes with the components after it joined to it. Each of those must be a plain name
/// (no `..`, root or prefix; [`Path::components`] drops a `.` already), and the first of them
/// must not exist: a link whose target is gone, or a name this cannot read, resolves to nothing.
fn resolve_through_an_ancestor(path: &Path) -> Option<PathBuf> {
    let components: Vec<Component<'_>> = path.components().collect();
    for kept in (1..=components.len()).rev() {
        let ancestor: PathBuf = components[..kept].iter().collect();
        let Ok(mut resolved) = std::fs::canonicalize(&ancestor) else {
            continue;
        };
        for (index, component) in components[kept..].iter().enumerate() {
            let Component::Normal(name) = component else {
                return None;
            };
            resolved.push(name);
            if index == 0
                && !std::fs::symlink_metadata(&resolved)
                    .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                return None;
            }
        }
        return Some(resolved);
    }
    None
}

/// The background tasks of a turn, from `system/task_started`, `task_notification` and
/// `background_tasks_changed` (3.6): the live ones, ambient tasks left out, and the ones the turn
/// started that named a run id, for their follow-up turns.
///
/// Only an event that says a task ended (or is ambient) removes it. A list that leaves a task out,
/// a notification with no status that says it ended, and a listed task with no id this reads keep
/// the turn open: ending a turn too early stops a background subagent mid-work and saves its
/// half-done edits, while a turn kept open ends when `claude` exits once its work is done.
///
/// On Claude Code 2.1.325, a background task's notification makes `claude` run a follow-up turn,
/// with a top-level `init` and `result` of its own, whose `origin` names the task's `run_id`. A
/// subagent that finished before the turn's `result` was printed has its follow-up run first, and
/// both `result`s are printed back to back (Phase 0, item 5). So a task the turn started in the
/// background, other than a background command, a Monitor watch or an ambient task, also keeps it
/// open until that follow-up's `result` arrived ([`Self::awaits_a_follow_up`]), whether the main
/// conversation or one of its subagents started it. A task that names no run id, the shape of the
/// fixtures written before Phase 0, keeps it open only while it is live.
///
/// A task that ended may still get no follow-up turn of the main conversation's, by a reading of
/// 2.1.325's code (Phase 0's runs showed neither case): the main conversation can fold a
/// notification that waits for it into its running turn, and prints nothing of its own when it
/// does; and a task a subagent started notifies that subagent while the subagent still runs. No
/// line tells either apart from a follow-up turn yet to start, so such a task stays awaited. Once
/// nothing else holds the turn, it gets only the runtime's follow-up wait
/// ([`EventAdapter::waits_only_for_a_follow_up`]), unless `claude` exits first, as it does right
/// after its last `result` when nothing else runs.
///
/// A held turn's `result`, a `task-notification` one with `num_turns` 0 and an empty `result`
/// (3.6), names a run whose notification the next turn answers: that run awaits its follow-up
/// turn until the next `result` that is not held, which follows it up.
#[derive(Clone, Debug, Default)]
pub struct BackgroundTasks {
    /// Each live task's id and its `task_type`, when it said.
    live: BTreeMap<String, Option<String>>,
    /// The live tasks, background commands left out, that the latest `background_tasks_changed`
    /// listed with no id this reads: they keep the turn open until a list no longer has them.
    unidentified: usize,
    /// The tasks the turn started that named a run id, by that run id.
    runs: BTreeMap<String, TaskRun>,
    /// A task that waits for its follow-up turn was not kept, past `MAX_TASK_RUNS`: no `result`
    /// can say its follow-up ended, so the turn ends when `claude` exits by itself.
    untracked_runs: bool,
    /// A task event named a run id, as every one did in Phase 0's runs on 2.1.325.
    named_run_ids: bool,
    /// The kept runs that held turns' `result`s named since the last `result` that was not held:
    /// a subset of `runs`, so no larger than `MAX_TASK_RUNS`.
    held: BTreeSet<String>,
}

/// A task the turn started, kept by its run id.
#[derive(Clone, Debug, Default)]
struct TaskRun {
    /// Its task id, when it said.
    task: Option<String>,
    /// Its `task_type`, when it said.
    kind: Option<String>,
    /// Whether it runs in the background: `is_backgrounded`, or `true` once a
    /// `background_tasks_changed` list named it. `None` when nothing said.
    backgrounded: Option<bool>,
    ambient: bool,
    /// An event said it ended.
    ended: bool,
    /// A top-level `result` whose `origin` names this run arrived: its follow-up turn ended.
    followed_up: bool,
}

impl TaskRun {
    /// Whether the turn waits for this task's follow-up turn: it is no background command,
    /// Monitor watch or ambient task, it did not say it runs in the foreground (a foreground
    /// task's outcome is its tool result, and starts no follow-up turn), and no `result` of its
    /// follow-up arrived yet. A task a subagent started waits too, and so does a task that did
    /// not say its type, or where it runs.
    fn awaits_its_follow_up(&self) -> bool {
        !self.followed_up
            && !self.ambient
            && self.backgrounded != Some(false)
            && !matches!(
                self.kind.as_deref(),
                Some(BACKGROUND_COMMAND_TASK | AMBIENT_TASK)
            )
    }
}

const TASK_ID_KEYS: [&str; 3] = ["task_id", "taskId", "id"];
/// A task's run id, which a follow-up turn's `result.origin` names as `runId`.
const RUN_ID_KEYS: [&str; 2] = ["run_id", "runId"];
const BACKGROUNDED_KEYS: [&str; 2] = ["is_backgrounded", "isBackgrounded"];
/// A line's `type` is its own (`system`), so a task's type is read from these only.
const TASK_TYPE_KEYS: [&str; 2] = ["task_type", "taskType"];
/// A listed task is no line of its own, so its `type` may be its task type.
const ENTRY_TYPE_KEYS: [&str; 3] = ["task_type", "taskType", "type"];

impl BackgroundTasks {
    pub fn observe(&mut self, line: &Value) {
        match str_field(line, "subtype") {
            Some("task_started") => {
                let backgrounded = BACKGROUNDED_KEYS
                    .iter()
                    .find_map(|key| line.get(*key).and_then(Value::as_bool));
                self.record_run(line, &TASK_TYPE_KEYS, backgrounded);
                let Some(id) = id_field(line, &TASK_ID_KEYS) else {
                    return;
                };
                if is_ambient(line, &TASK_TYPE_KEYS) || has_ended(line) {
                    self.live.remove(&id);
                    return;
                }
                self.insert(id, task_type(line, &TASK_TYPE_KEYS));
            }
            Some("task_notification") => {
                let run = id_field(line, &RUN_ID_KEYS);
                self.named_run_ids |= run.is_some();
                // A notification that says the task ended (`completed`, `failed`, `stopped`)
                // removes it. Any other status, or none, says nothing this can rely on.
                if !has_ended(line) {
                    return;
                }
                let id = id_field(line, &TASK_ID_KEYS);
                if let Some(id) = &id {
                    self.live.remove(id);
                }
                // Its run ended: by the run id it names, or else by the task id it started with.
                let ended = match run {
                    Some(run) => self.runs.get_mut(&run),
                    None => id.and_then(|id| {
                        self.runs
                            .values_mut()
                            .find(|kept| kept.task.as_deref() == Some(id.as_str()))
                    }),
                };
                if let Some(kept) = ended {
                    kept.ended = true;
                }
            }
            Some("background_tasks_changed") => {
                // The tasks that run now, when the event carries a list. Its shape is a guess, so
                // the list only adds what it names and removes what it says ended.
                let Some(tasks) = ["tasks", "background_tasks", "backgroundTasks"]
                    .iter()
                    .find_map(|key| line.get(*key).and_then(Value::as_array))
                else {
                    return;
                };
                let mut unidentified = 0;
                for task in tasks {
                    // A listed task runs in the background.
                    self.record_run(task, &ENTRY_TYPE_KEYS, Some(true));
                    let gone = is_ambient(task, &ENTRY_TYPE_KEYS) || has_ended(task);
                    let kind = task_type(task, &ENTRY_TYPE_KEYS);
                    match id_field(task, &TASK_ID_KEYS) {
                        Some(id) if gone => {
                            self.live.remove(&id);
                        }
                        Some(id) => {
                            // A listed task that does not say its type keeps the type it started
                            // with.
                            let kind = kind.or_else(|| self.live.get(&id).cloned().flatten());
                            self.insert(id, kind);
                        }
                        None if !gone && kind.as_deref() != Some(BACKGROUND_COMMAND_TASK) => {
                            unidentified += 1;
                        }
                        None => {}
                    }
                }
                self.unidentified = unidentified;
            }
            _ => {}
        }
    }

    fn insert(&mut self, id: String, kind: Option<String>) {
        if self.live.len() < MAX_LIVE_TASKS || self.live.contains_key(&id) {
            self.live.insert(id, kind);
        }
    }

    /// Keeps a task the turn started by its run id, when it names one. What a later event says
    /// adds to what an earlier one said: the first task id and type it said stay, and once
    /// anything said it runs in the background, or that it ended, it does.
    fn record_run(&mut self, task: &Value, type_keys: &[&str], backgrounded: Option<bool>) {
        let Some(run) = id_field(task, &RUN_ID_KEYS) else {
            return;
        };
        self.named_run_ids = true;
        let said = TaskRun {
            task: id_field(task, &TASK_ID_KEYS),
            kind: task_type(task, type_keys),
            backgrounded,
            ambient: is_ambient(task, type_keys),
            ended: has_ended(task),
            ..TaskRun::default()
        };
        if self.runs.len() >= MAX_TASK_RUNS && !self.runs.contains_key(&run) {
            self.untracked_runs |= said.awaits_its_follow_up();
            return;
        }
        let kept = self.runs.entry(run).or_default();
        kept.task = kept.task.take().or(said.task);
        kept.kind = kept.kind.take().or(said.kind);
        kept.ambient |= said.ambient;
        kept.ended |= said.ended;
        kept.backgrounded = if kept.backgrounded == Some(true) || said.backgrounded == Some(true) {
            Some(true)
        } else {
            kept.backgrounded.or(said.backgrounded)
        };
    }

    /// The run ids of the tasks that await their follow-up turn, which the runtime's follow-up
    /// wait waits for (3.6).
    pub fn awaited_runs(&self) -> Vec<String> {
        self.runs
            .iter()
            .filter(|(_, kept)| kept.awaits_its_follow_up())
            .map(|(run, _)| run.clone())
            .collect()
    }

    /// Whether the task with run id `run` awaits its follow-up turn: a `result` that follows it
    /// up, or a later event that says it starts none, ends that.
    pub fn awaits_the_follow_up_of(&self, run: &str) -> bool {
        self.runs
            .get(run)
            .is_some_and(TaskRun::awaits_its_follow_up)
    }

    /// Whether a top-level `result` must not end the turn yet because a task the turn started in
    /// the background, other than a background command, Monitor watch or ambient task, has had
    /// no follow-up turn: no top-level `result` whose `origin` is a `task-notification` naming
    /// its run id arrived yet (3.6). Only a task that named a run id can wait: when no task event
    /// names one, the turn ends by the live tasks alone.
    pub fn awaits_a_follow_up(&self) -> bool {
        self.untracked_runs || self.runs.values().any(TaskRun::awaits_its_follow_up)
    }

    /// Whether some task awaits its follow-up turn, and every one that does has ended: only a
    /// follow-up turn that has yet to start holds the turn, not a task that may still run.
    fn awaits_only_ended_follow_ups(&self) -> bool {
        let mut awaiting = self
            .runs
            .values()
            .filter(|kept| kept.awaits_its_follow_up())
            .peekable();
        !self.untracked_runs && awaiting.peek().is_some() && awaiting.all(|kept| kept.ended)
    }

    /// How many tasks await their follow-up turn.
    fn awaiting(&self) -> usize {
        self.runs
            .values()
            .filter(|kept| kept.awaits_its_follow_up())
            .count()
    }

    /// The follow-up turn of the task with run id `run` printed its `result`.
    fn followed_up(&mut self, run: &str) {
        if let Some(task) = self.runs.get_mut(run) {
            task.followed_up = true;
        }
    }

    /// A held turn's `result` named the task with run id `run` ([`ends_a_held_turn`]): the next
    /// turn that is not held answers its notification, so it awaits its follow-up turn until
    /// that turn's `result`, and is followed up there ([`Self::follow_up_the_held`]). Only a run
    /// this keeps can be held: another one awaits nothing.
    fn hold(&mut self, run: &str) {
        if self.runs.contains_key(run) {
            self.held.insert(run.to_string());
        }
    }

    /// A top-level `result` that is not held was read: its turn answered the notifications of
    /// the held turns before it, so each run they named is followed up.
    fn follow_up_the_held(&mut self) {
        for run in std::mem::take(&mut self.held) {
            self.followed_up(&run);
        }
    }

    /// Whether a task event named a run id, as every one did in Phase 0's runs on 2.1.325. Then a
    /// follow-up turn's `result` names the run it follows up, and a `task-notification` `origin`
    /// that names none is another event's turn, such as a Monitor watch's (3.6).
    pub fn names_run_ids(&self) -> bool {
        self.named_run_ids
    }

    /// Whether `run` is the run id of a background command or Monitor watch the turn started.
    pub fn is_a_background_command(&self, run: &str) -> bool {
        self.runs
            .get(run)
            .is_some_and(|task| task.kind.as_deref() == Some(BACKGROUND_COMMAND_TASK))
    }

    /// Whether a top-level `result` must not end the turn yet: a live task is something other
    /// than a background command or Monitor watch, such as a background subagent or workflow. A
    /// task that did not say its type counts as such, and so does a listed task with no id.
    pub fn keeps_the_turn_open(&self) -> bool {
        self.unidentified > 0
            || self
                .live
                .values()
                .any(|kind| kind.as_deref() != Some(BACKGROUND_COMMAND_TASK))
    }

    /// The live tasks it knows by their id.
    pub fn live(&self) -> usize {
        self.live.len()
    }
}

fn task_type(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| str_field(value, key))
        .map(|kind| bounded(kind, 64))
}

fn is_ambient(value: &Value, type_keys: &[&str]) -> bool {
    task_type(value, type_keys).as_deref() == Some(AMBIENT_TASK)
        || ["ambient", "is_ambient", "isAmbient"]
            .iter()
            .any(|key| value.get(*key).and_then(Value::as_bool) == Some(true))
}

fn has_ended(value: &Value) -> bool {
    str_field(value, "status").is_some_and(|status| {
        matches!(
            status,
            "completed" | "failed" | "stopped" | "killed" | "cancelled" | "canceled" | "error"
        )
    })
}

/// Whether the turn goes on, and why it cannot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AdapterStatus {
    /// Reading on.
    Running,
    /// A top-level `result` ended the turn (3.6): every top-level `init` has its `result`, no
    /// task that keeps the turn open is live, and no task awaits its follow-up turn. Or, when only
    /// the follow-up turns of tasks that ended were awaited, the runtime's follow-up wait ended
    /// it ([`EventAdapter::end_without_follow_up`]). The runtime stops `claude` and ignores what
    /// it prints afterwards.
    EndOfTurn,
    /// A launch check failed (3.6): the turn ends as `unexpected_configuration`.
    Unexpected(String),
}

/// How the runtime's follow-up wait ended a turn that waited only for follow-up turns (3.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FollowUpWaitEnd {
    /// Its grace ran out, or it used every restart it has.
    RanOut,
    /// `claude` exited by itself while the turn waited, with 0, or with 1 after a last `result`
    /// that was an error ([`EventAdapter::last_result_failed`]).
    ClaudeExited,
}

/// A top-level `result`: the one that gives the reply and success is the latest that can be the
/// reply ([`EventAdapter::reply_result`]).
#[derive(Clone, Debug, Default)]
pub struct ResultFacts {
    /// `is_error`, or an `error_*` subtype.
    pub is_error: bool,
    pub subtype: Option<String>,
    /// `result`: the reply, redacted and with the folder prefix made relative (3.7).
    pub text: Option<String>,
    /// `errors`, redacted.
    pub errors: Vec<String>,
}

impl ResultFacts {
    fn read(line: &Value, redactor: &Redactor) -> Self {
        let subtype = str_field(line, "subtype").map(|subtype| bounded(subtype, 64));
        let is_error = line.get("is_error").and_then(Value::as_bool) == Some(true)
            || subtype
                .as_deref()
                .is_some_and(|subtype| subtype.starts_with("error"));
        let errors = line
            .get("errors")
            .and_then(Value::as_array)
            .map(|errors| {
                errors
                    .iter()
                    .filter_map(Value::as_str)
                    .take(MAX_KEPT_ERRORS)
                    .map(|error| bounded(&redactor.text(error), MAX_FAILURE_TEXT_CHARS))
                    .collect()
            })
            .unwrap_or_default();
        Self {
            is_error,
            subtype,
            text: str_field(line, "result").map(|text| redactor.text(text)),
            errors,
        }
    }
}

/// What started the turn a top-level `result` ends, as its `origin` says (3.6). Claude Code
/// 2.1.325 gives the person's own turn no `origin`, and a turn that a background task's
/// notification started `{"kind": "task-notification", "runId": <the task's run_id>}`.
#[derive(Clone, Debug, PartialEq, Eq)]
enum ResultOrigin {
    /// No `origin`, or `null`: the person's own message.
    Person,
    /// A background task's notification, with the task's run id when it names one. One that
    /// names none, by a reading of 2.1.325's code, is a Monitor watch's event, whose notification
    /// carries no task id.
    TaskNotification(Option<String>),
    /// Anything else: a peer message (`kind: "peer"`), which another program can queue through
    /// the messaging socket every `init` names, or a kind or shape this adapter does not know.
    Other,
}

impl ResultOrigin {
    fn of(result: &Value) -> Self {
        match result.get("origin") {
            None | Some(Value::Null) => Self::Person,
            Some(origin) => match str_field(origin, "kind") {
                Some("task-notification") => Self::TaskNotification(id_field(origin, &RUN_ID_KEYS)),
                _ => Self::Other,
            },
        }
    }
}

/// Whether a top-level `result` ends a held turn (3.6): its `origin` is a `task-notification`,
/// with or without a `runId`, its `num_turns` is the integer 0, its `result` is the empty
/// string, and it is no error.
///
/// By a reading of 2.1.325's code, when a task's notification is next to run and another one it
/// can be coalesced with is queued behind it, `-p` runs the first as a turn that adds the
/// notification to the conversation and makes no model request: it prints that turn's `init` and
/// such a `result`, and leaves the notification to the next turn, which answers it with its own.
/// That is the notification queued behind it, or, when no other message is queued by then, a
/// turn with no `origin` that Claude Code then owes the held notification. Several turns can be
/// held in a row, each for the next. So a held turn's `result` never gives the reply, and the
/// run its `origin` names awaits its follow-up turn until the next `result` that is not held
/// ([`EventAdapter::reply_result`]). Other turns with no model request print the same `result`
/// and are read the same way, though no later turn answers them: a notification that only
/// repeats a usage limit already reached ([`EventAdapter::succeeded`]), and on a resumed session
/// the notices of an earlier turn's background tasks that left no record of their end.
fn ends_a_held_turn(line: &Value, origin: &ResultOrigin, facts: &ResultFacts) -> bool {
    matches!(origin, ResultOrigin::TaskNotification(_))
        && !facts.is_error
        && line.get("num_turns").and_then(Value::as_u64) == Some(0)
        && str_field(line, "result") == Some("")
}

/// The input, cache-creation, cache-read and output tokens of a `result`'s `usage`. Never a
/// cost: `total_cost_usd` and `costUSD` are API price estimates, not what a plan costs (2.6).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct TokenCounts {
    input: u64,
    cache_creation: u64,
    cache_read: u64,
    output: u64,
}

impl TokenCounts {
    fn read(usage: &Value) -> Self {
        let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
        Self {
            input: count("input_tokens"),
            cache_creation: count("cache_creation_input_tokens"),
            cache_read: count("cache_read_input_tokens"),
            output: count("output_tokens"),
        }
    }

    fn plus(self, other: Self) -> Self {
        Self {
            input: self.input.saturating_add(other.input),
            cache_creation: self.cache_creation.saturating_add(other.cache_creation),
            cache_read: self.cache_read.saturating_add(other.cache_read),
            output: self.output.saturating_add(other.output),
        }
    }

    fn json(self) -> Value {
        json!({
            "input_tokens": self.input,
            "cache_creation_input_tokens": self.cache_creation,
            "cache_read_input_tokens": self.cache_read,
            "output_tokens": self.output,
        })
    }
}

/// The permission denials Claude Code reported for a turn (3.7): each top-level `result`'s
/// `permission_denials` and each `system/permission_denied` line, a tool call once.
#[derive(Clone, Debug, Default)]
struct ReportedDenials {
    /// A report was read, an empty `permission_denials` included.
    reported: bool,
    /// The denied tools' names, in the order they were first reported.
    tools: Vec<String>,
    /// The tool calls already counted, by `tool_use_id`.
    calls: HashSet<String>,
}

impl ReportedDenials {
    fn add(&mut self, denial: &Value, redactor: &Redactor) {
        if self.tools.len() >= MAX_DENIALS {
            return;
        }
        // A tool call reported twice, by a line of its own and in a `result`, or by two
        // `result`s, counts once. A denial with no `tool_use_id` counts each time.
        if let Some(call) = id_field(denial, &["tool_use_id", "toolUseId"])
            && !self.calls.insert(call)
        {
            return;
        }
        self.tools.push(
            str_field(denial, "tool_name")
                .map(|name| bounded(&redactor.text(name), 100))
                .unwrap_or_else(|| "tool".to_string()),
        );
    }
}

/// A failed lane turn: its code, the raw text Details keeps, and when a plan limit resets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaneFailure {
    /// `None` for 5.5's "anything else".
    pub code: Option<FailureCode>,
    /// Redacted, bounded; it starts with the error's own first line where there is one.
    pub message: String,
    /// A plan limit's reset time, in seconds since the epoch.
    pub resets_at: Option<i64>,
}

impl LaneFailure {
    pub fn new(code: FailureCode, message: impl Into<String>) -> Self {
        Self {
            code: Some(code),
            message: message.into(),
            resets_at: None,
        }
    }

    /// The `claude-code/failure` artifact (2.6), for a failure with a code.
    pub fn artifact(&self) -> Option<Value> {
        let code = self.code?;
        Some(json!({ "kind": "claude-code/failure", "code": code.as_str() }))
    }
}

/// How `claude` ended, as the supervisor saw it, for [`EventAdapter::classify_failure`].
#[derive(Clone, Copy, Debug)]
pub struct ExitFacts<'a> {
    /// `--resume` was passed: a missing-session error before `init` is a resume miss (11.9).
    pub resumed: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    /// The exit counts as 0 (3.6): it was 0, or 143 after the runtime's own SIGTERM, or 1 after
    /// a last `result` that was an error while the turn waited only for follow-up turns.
    pub exited_ok: bool,
    /// The tail of `claude`'s stderr, redacted.
    pub stderr: &'a str,
}

impl ExitFacts<'_> {
    fn describe(&self) -> String {
        match (self.exit_code, self.signal) {
            (Some(code), _) => format!("Claude Code exited with status {code}."),
            (None, Some(signal)) => format!("Claude Code was ended by signal {signal}."),
            (None, None) => "Claude Code ended.".to_string(),
        }
    }
}

#[derive(Clone, Debug)]
struct RateLimitRejection {
    resets_at: Option<i64>,
}

#[derive(Clone, Debug)]
struct AssistantError {
    text: String,
}

/// A tool call waiting for its result.
#[derive(Clone, Debug)]
struct PendingTool {
    name: String,
    parent: Option<String>,
    kind: ToolKind,
}

#[derive(Clone, Debug)]
enum ToolKind {
    Command { command: String },
    FileChange { paths: Vec<String> },
    WebSearch { query: String },
    TodoWrite { items: Vec<PlanItem> },
    TaskCreate { subject: String },
    TaskUpdate { update: TaskUpdate },
    Other,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PlanItem {
    text: String,
    completed: bool,
}

#[derive(Clone, Debug)]
struct TaskUpdate {
    task_id: Option<String>,
    status: Option<String>,
    subject: Option<String>,
}

#[derive(Clone, Debug)]
struct Task {
    id: String,
    text: String,
    status: String,
}

/// What the adapter remembers of one message, by its id.
#[derive(Debug, Default)]
struct MessageBlocks {
    id: String,
    /// Text blocks streamed so far, by block index (top-level messages only).
    streamed: BTreeMap<u64, String>,
    /// A streamed text block reached the draft.
    drafted: bool,
    /// Blocks the message's `assistant` lines brought so far.
    blocks_seen: u64,
    /// Its text blocks that no tool call has followed yet, with their index.
    texts: Vec<(u64, String)>,
    /// Texts already sent as commentary.
    commentary: HashSet<String>,
}

/// Turns a turn's stream-json lines into steps and drafts, and keeps what its end needs (3.7).
#[derive(Debug)]
pub struct EventAdapter {
    redactor: Redactor,
    folder: PathBuf,
    /// The turn's mode, whose permission mode every `init` must report (3.6, 11.12).
    mode: ExecutionMode,
    status: AdapterStatus,
    init: Option<InitFacts>,
    tasks: BackgroundTasks,
    /// The top-level message streaming now.
    streaming: Option<String>,
    messages: VecDeque<MessageBlocks>,
    pending: HashMap<String, PendingTool>,
    seen_tools: HashSet<String>,
    task_list: Vec<Task>,
    /// The top-level `system/init`s that passed the launch checks: every turn `claude` runs
    /// prints one, the follow-up turns of background tasks and peer messages included.
    inits: usize,
    /// The latest top-level `result` that can be the reply (3.6).
    reply_result: Option<ResultFacts>,
    /// A held turn's `result` read since the last `result` that was not held could have been the
    /// reply by its `origin` ([`ends_a_held_turn`]): the next `result` that is not held answers
    /// its notification, and can be the reply for it.
    held_could_reply: bool,
    /// The run the latest top-level `result` named, when that `result` was a held turn's.
    held_run: Option<String>,
    /// The latest top-level `result` read was an error, a held turn's included.
    last_result_failed: bool,
    /// A top-level `result` with no `origin` was read: the person's own turn's, which comes
    /// before any follow-up of a task it started (3.6).
    persons_result_read: bool,
    /// The top-level `result`s read: each ends one of those turns.
    results: usize,
    /// The token counts of every top-level `result` read, summed.
    usage: Option<TokenCounts>,
    /// The permission denials Claude Code reported.
    denials: ReportedDenials,
    auth_failed: bool,
    rejection: Option<RateLimitRejection>,
    assistant_errors: Vec<AssistantError>,
    /// The tools of tool results that reported a denial, for a turn Claude Code reported none of.
    denied: Vec<String>,
    unparsed_lines: usize,
    unparsed_text: String,
    run_log: RunLog,
}

impl EventAdapter {
    /// The adapter of a turn in `folder` that applies its changes, whose steps show `home` as
    /// `~`.
    pub fn new(folder: &Path, home: Option<&Path>) -> Self {
        Self::with_redactor(
            Redactor::new(folder, home),
            folder.to_path_buf(),
            ExecutionMode::Apply,
        )
    }

    fn with_redactor(redactor: Redactor, folder: PathBuf, mode: ExecutionMode) -> Self {
        Self {
            redactor,
            folder,
            mode,
            status: AdapterStatus::Running,
            init: None,
            tasks: BackgroundTasks::default(),
            streaming: None,
            messages: VecDeque::new(),
            pending: HashMap::new(),
            seen_tools: HashSet::new(),
            task_list: Vec::new(),
            inits: 0,
            reply_result: None,
            held_could_reply: false,
            held_run: None,
            last_result_failed: false,
            persons_result_read: false,
            results: 0,
            usage: None,
            denials: ReportedDenials::default(),
            auth_failed: false,
            rejection: None,
            assistant_errors: Vec::new(),
            denied: Vec::new(),
            unparsed_lines: 0,
            unparsed_text: String::new(),
            run_log: RunLog::default(),
        }
    }

    /// The adapter of a turn of `grant`'s person in `folder`, in `mode`: the launch `HOME` shows
    /// as `~`.
    pub fn for_turn(grant: &LaunchGrant, folder: &Path, mode: ExecutionMode) -> Self {
        Self::new(folder, grant.snapshot().home()).in_mode(mode)
    }

    /// This adapter, for a turn in `mode`: its `init`s must report that mode's permission mode.
    pub fn in_mode(mut self, mode: ExecutionMode) -> Self {
        self.mode = mode;
        self
    }

    /// Starts over for a second `claude` of the same turn, which the runtime starts without
    /// `--resume` after the first reported its session missing before any `init` (11.9): what
    /// the first one printed counts for nothing, but its lines stay in the run log, followed by
    /// a line that says the turn started again in a new session.
    pub fn start_again(&mut self) {
        let mut fresh = Self::with_redactor(self.redactor.clone(), self.folder.clone(), self.mode);
        fresh.run_log = std::mem::take(&mut self.run_log);
        fresh
            .run_log
            .push(json!({ "type": "instafy.started_without_the_missing_session" }));
        *self = fresh;
    }

    pub fn redactor(&self) -> &Redactor {
        &self.redactor
    }

    pub fn status(&self) -> &AdapterStatus {
        &self.status
    }

    /// `system/init`, once its launch checks passed.
    pub fn init(&self) -> Option<&InitFacts> {
        self.init.as_ref()
    }

    pub fn background_tasks(&self) -> &BackgroundTasks {
        &self.tasks
    }

    /// The latest top-level `result` that can be the reply, which gives the reply and success
    /// (3.6): one with no `origin`, the person's own turn's, or one whose `origin` is a
    /// `task-notification` that names a run other than a background command's or Monitor
    /// watch's the turn started, the follow-up turn of a background subagent or workflow. A
    /// background command's follow-up only says the command ended, and a peer message, or an
    /// `origin` this adapter does not know, started a turn that is not the person's: neither is
    /// the reply, but for the exception below. Nor is a `task-notification` that names no run once
    /// the turn's task events name run ids, such as a Monitor watch's event turn; while none does,
    /// it can be.
    ///
    /// A held turn's `result`, a `task-notification` one with `num_turns` 0 and an empty
    /// `result`, is never the reply (3.6). The next `result` that is not held answers the held
    /// notifications too, so it can be the reply when its own `origin` lets it or a held
    /// `result`'s `origin` would have let that one: a background command's follow-up that
    /// answers a subagent's held notification gives the reply.
    pub fn reply_result(&self) -> Option<&ResultFacts> {
        self.reply_result.as_ref()
    }

    /// How many top-level `system/init`s passed the launch checks.
    pub fn inits(&self) -> usize {
        self.inits
    }

    /// How many top-level `result`s were read.
    pub fn results(&self) -> usize {
        self.results
    }

    /// Whether the latest top-level `result` read was an error, whatever its `origin`, a held
    /// turn's included: `is_error`, or an `error_*` subtype ([`ResultFacts::is_error`]).
    pub fn last_result_failed(&self) -> bool {
        self.last_result_failed
    }

    /// The run that the latest top-level `result` named, when that `result` was a held turn's
    /// ([`ends_a_held_turn`]): by a reading of 2.1.325's code, the next turn is the one that
    /// answers that run's notification (3.6).
    pub fn held_run(&self) -> Option<&str> {
        self.held_run.as_deref()
    }

    /// The reply: the `result` text of [`Self::reply_result`], redacted and with the folder
    /// prefix made relative. Instafy appends nothing to it (3.7).
    pub fn reply(&self) -> Option<&str> {
        self.reply_result.as_ref()?.text.as_deref()
    }

    /// The launch checks passed, and the `result` that gives the reply is no error. With an exit
    /// that counts as 0, the turn succeeded (3.6, 3.8).
    ///
    /// Except when Claude Code refused a request for the plan's limit (a `rate_limit_event`
    /// whose status is `rejected`) and a held turn that could have given the reply is still
    /// unanswered: by a reading of 2.1.325's code, a subagent's notification that only repeats a
    /// usage limit already reached prints a held turn's `result` that no later turn answers, so
    /// the work that turn stood for was stopped by the limit, and the turn fails as `plan_limit`.
    pub fn succeeded(&self) -> bool {
        !matches!(self.status, AdapterStatus::Unexpected(_))
            && self.init.is_some()
            && self
                .reply_result
                .as_ref()
                .is_some_and(|result| !result.is_error)
            && !(self.rejection.is_some() && self.held_could_reply)
    }

    /// Lines that did not parse as stream-json events.
    pub fn unparsed_lines(&self) -> usize {
        self.unparsed_lines
    }

    pub fn run_log(&self) -> &RunLog {
        &self.run_log
    }

    /// Reads one stream-json line, and returns the events it makes, in order. Once the turn
    /// ended or a launch check failed, it reads nothing more.
    pub fn feed(&mut self, line: &Value) -> Vec<Value> {
        let mut events = Vec::new();
        if self.status != AdapterStatus::Running {
            return events;
        }
        if let Some(entry) = self.log_entry(line) {
            self.run_log.push(entry);
        }
        match str_field(line, "type") {
            Some("system") => self.on_system(line),
            Some("stream_event") => {
                if self.started("its output") {
                    self.on_stream_event(line, &mut events);
                }
            }
            Some("assistant") => {
                if line.get("error").is_some_and(|error| !error.is_null()) {
                    self.on_assistant_error(line);
                } else if self.started("a message") {
                    self.on_assistant(line, &mut events);
                }
            }
            Some("user") => {
                if self.started("a tool result") {
                    self.on_user(line, &mut events);
                }
            }
            Some("result") => self.on_result(line),
            Some("rate_limit_event") => self.on_rate_limit(line),
            _ => {}
        }
        events
    }

    /// A line that did not parse: counted, and kept, bounded and redacted, for classifying a
    /// failure and for the run log.
    pub fn note_unparsed(&mut self, line: &[u8]) {
        self.unparsed_lines += 1;
        let text = String::from_utf8_lossy(line);
        let preview = self.redactor.bounded(text.trim(), UNPARSED_PREVIEW_CHARS);
        self.run_log.push(json!({
            "type": "instafy.unparsed_line",
            "bytes": line.len(),
            "preview": &preview,
        }));
        if !self.unparsed_text.is_empty() {
            self.unparsed_text.push('\n');
        }
        self.unparsed_text.push_str(&preview);
        if self.unparsed_text.chars().count() > MAX_UNPARSED_TEXT_CHARS {
            self.unparsed_text =
                tail_chars(&self.unparsed_text, MAX_UNPARSED_TEXT_CHARS).to_string();
        }
    }

    /// Lines `claude` printed after the turn ended, which the runtime ignored (3.6).
    pub fn note_ignored(&mut self, lines: usize) {
        if lines > 0 {
            self.run_log.push(json!({
                "type": "instafy.ignored_after_turn",
                "lines": lines,
            }));
        }
    }

    /// Work arrived before `system/init`: the launch checks could not run first.
    fn started(&mut self, what: &str) -> bool {
        if self.init.is_some() {
            return true;
        }
        if self.status == AdapterStatus::Running {
            self.status = AdapterStatus::Unexpected(format!(
                "Claude Code sent {what} before it reported its settings."
            ));
        }
        false
    }

    fn on_system(&mut self, line: &Value) {
        match str_field(line, "subtype") {
            Some("init") => {
                // Every check on the launch's top-level `init`. A later turn's, whose shell a
                // `cd` may have moved inside the folder, is checked by the folder it started in
                // (3.6).
                let checked = if self.inits == 0 {
                    check_init(line, &self.folder, self.mode)
                } else {
                    check_later_init(line, &self.folder, self.mode)
                };
                match checked {
                    Ok(facts) => {
                        self.init = Some(facts);
                        // Each turn of the conversation, a follow-up included, prints a
                        // top-level `init` and, once it ends, a top-level `result`.
                        if is_top_level(line) {
                            self.inits += 1;
                        }
                    }
                    Err(why) => self.status = AdapterStatus::Unexpected(why),
                }
            }
            Some("task_started" | "task_notification" | "background_tasks_changed") => {
                self.tasks.observe(line)
            }
            Some("permission_denied") => {
                self.denials.reported = true;
                self.denials.add(line, &self.redactor);
            }
            _ => {}
        }
    }

    /// A top-level `result` ends the turn (3.6) once:
    /// - the person's own turn's `result`, which has no `origin`, was read: on a resumed session
    ///   2.1.325 can run a turn for each background task of an earlier turn that left no record
    ///   of its end before the person's, and such a turn prints a held turn's `result`;
    /// - every top-level `init` read has its top-level `result`: a follow-up turn that started
    ///   before the person's turn printed its `result` prints its own after it;
    /// - no task that keeps the turn open is live ([`BackgroundTasks::keeps_the_turn_open`]);
    /// - no task the turn started awaits its follow-up turn
    ///   ([`BackgroundTasks::awaits_a_follow_up`]).
    ///
    /// Every top-level `result` counts toward the usage and the denials, and the latest one that
    /// can be the reply gives the reply and success ([`Self::reply_result`]). A held turn's
    /// `result` ([`ends_a_held_turn`]) follows up no run: the run it names is followed up at the
    /// next `result` that is not held, whose turn answers its notification.
    fn on_result(&mut self, line: &Value) {
        if !is_top_level(line) {
            return;
        }
        self.results += 1;
        if let Some(usage) = line.get("usage") {
            let counts = TokenCounts::read(usage);
            self.usage = Some(self.usage.unwrap_or_default().plus(counts));
        }
        if let Some(denials) = line.get("permission_denials").and_then(Value::as_array) {
            self.denials.reported = true;
            for denial in denials {
                self.denials.add(denial, &self.redactor);
            }
        }
        let facts = ResultFacts::read(line, &self.redactor);
        self.last_result_failed = facts.is_error;
        let origin = ResultOrigin::of(line);
        let held = ends_a_held_turn(line, &origin, &facts);
        self.held_run = None;
        if !held {
            // This turn also answered the notifications the held turns before it took.
            self.tasks.follow_up_the_held();
        }
        let can_reply = match origin {
            ResultOrigin::Person => {
                self.persons_result_read = true;
                true
            }
            ResultOrigin::TaskNotification(Some(run)) => {
                if held {
                    self.tasks.hold(&run);
                    self.held_run = Some(run.clone());
                } else {
                    self.tasks.followed_up(&run);
                }
                !self.tasks.is_a_background_command(&run)
            }
            // Once the task events name run ids, every follow-up names its run: one that names
            // none is another event's turn, such as a Monitor watch's.
            ResultOrigin::TaskNotification(None) => !self.tasks.names_run_ids(),
            ResultOrigin::Other => false,
        };
        if held {
            // Never the reply: the next `result` that is not held answers for it.
            self.held_could_reply |= can_reply;
        } else if std::mem::take(&mut self.held_could_reply) || can_reply {
            self.reply_result = Some(facts);
        }
        if self.persons_result_read
            && self.results >= self.inits
            && !self.tasks.keeps_the_turn_open()
            && !self.tasks.awaits_a_follow_up()
        {
            self.status = AdapterStatus::EndOfTurn;
        }
    }

    /// Whether the turn now waits only for the follow-up turn of a background task that already
    /// ended (3.6): a top-level `result` was read and every top-level `init` has its own, no
    /// task that keeps the turn open is live, and each task that awaits its follow-up turn has
    /// ended. Such a follow-up turn may never come: Claude Code 2.1.325 can fold the task's
    /// notification into the running turn, which prints nothing of its own, or deliver it to the
    /// subagent that started the task while that subagent runs. So the runtime gives `claude` a
    /// grace to start one, a new top-level `init`, and then ends the turn
    /// (`supervise::FollowUpWait`, [`Self::end_without_follow_up`]). Never while a task that keeps
    /// the turn open runs, while a turn whose `init` was read has yet to print its `result`, or
    /// before the person's own turn's `result`.
    pub fn waits_only_for_a_follow_up(&self) -> bool {
        self.status == AdapterStatus::Running
            && self.persons_result_read
            && self.results >= self.inits
            && !self.tasks.keeps_the_turn_open()
            && self.tasks.awaits_only_ended_follow_ups()
    }

    /// Ends the turn at the `result`s read when it still waits only for a follow-up turn
    /// ([`Self::waits_only_for_a_follow_up`]) and the runtime's follow-up wait ended it (3.6):
    /// `claude` started none within `grace`, or within the grace that the wait last restarted
    /// after `restarts` restarts, or the wait used every restart it has, or `claude` exited by
    /// itself meanwhile with an exit that says nothing of the reply ([`FollowUpWaitEnd`]). The
    /// reply and success come from [`Self::reply_result`], as at any end of the turn: a follow-up
    /// that never came fails nothing. The run log says so. Returns whether it ended the turn.
    pub fn end_without_follow_up(
        &mut self,
        grace: std::time::Duration,
        restarts: usize,
        by: FollowUpWaitEnd,
    ) -> bool {
        if !self.waits_only_for_a_follow_up() {
            return false;
        }
        self.run_log.push(json!({
            "type": "instafy.ended_without_follow_up",
            "runs": self.tasks.awaiting(),
            "grace_ms": u64::try_from(grace.as_millis()).unwrap_or(u64::MAX),
            "restarts": restarts,
            "claude_exited": by == FollowUpWaitEnd::ClaudeExited,
        }));
        self.status = AdapterStatus::EndOfTurn;
        true
    }

    fn on_rate_limit(&mut self, line: &Value) {
        let Some(info) = line.get("rate_limit_info") else {
            return;
        };
        if str_field(info, "status") != Some("rejected") {
            return;
        }
        let resets_at = info.get("resetsAt").and_then(|value| match value {
            Value::Number(number) => number.as_i64(),
            Value::String(text) => text.trim().parse().ok(),
            _ => None,
        });
        self.rejection = Some(RateLimitRejection { resets_at });
    }

    fn on_assistant_error(&mut self, line: &Value) {
        let kind = match line.get("error") {
            Some(Value::String(kind)) => Some(kind.as_str()),
            Some(error) => str_field(error, "type").or_else(|| str_field(error, "error")),
            None => None,
        };
        if kind == Some("authentication_failed") {
            self.auth_failed = true;
        }
        if self.assistant_errors.len() < MAX_KEPT_ERRORS {
            let text = line.get("message").map(message_text).unwrap_or_default();
            self.assistant_errors.push(AssistantError {
                text: bounded(&self.redactor.text(text.trim()), MAX_FAILURE_TEXT_CHARS),
            });
        }
    }

    fn message(&mut self, id: &str) -> &mut MessageBlocks {
        if let Some(index) = self.messages.iter().position(|message| message.id == id) {
            return &mut self.messages[index];
        }
        if self.messages.len() >= REMEMBERED_MESSAGES {
            self.messages.pop_front();
        }
        self.messages.push_back(MessageBlocks {
            id: id.to_string(),
            ..MessageBlocks::default()
        });
        self.messages
            .back_mut()
            .expect("a message was just remembered")
    }

    fn streaming_id(&self) -> String {
        self.streaming.clone().unwrap_or_default()
    }

    fn on_stream_event(&mut self, line: &Value, events: &mut Vec<Value>) {
        // A subagent's output never drafts; its steps come from its `assistant` lines.
        if !is_top_level(line) {
            return;
        }
        let Some(event) = line.get("event") else {
            return;
        };
        match str_field(event, "type") {
            Some("message_start") => {
                let id = event
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                self.message(&id);
                self.streaming = Some(id);
            }
            Some("content_block_start") => {
                let Some(index) = event.get("index").and_then(Value::as_u64) else {
                    return;
                };
                let block = event.get("content_block").unwrap_or(&Value::Null);
                match str_field(block, "type") {
                    Some("text") => {
                        let id = self.streaming_id();
                        self.message(&id).streamed.entry(index).or_default();
                        if let Some(text) = str_field(block, "text").filter(|text| !text.is_empty())
                        {
                            self.stream_text(index, text, events);
                        }
                    }
                    Some("tool_use" | "server_tool_use") => {
                        // The text blocks before it in this message were commentary.
                        let id = self.streaming_id();
                        let texts: Vec<(u64, String)> = self
                            .message(&id)
                            .streamed
                            .range(..index)
                            .map(|(index, text)| (*index, text.clone()))
                            .collect();
                        self.commentary(&id, texts, true, events);
                    }
                    _ => {}
                }
            }
            Some("content_block_delta") => {
                let Some(index) = event.get("index").and_then(Value::as_u64) else {
                    return;
                };
                let Some(delta) = event.get("delta") else {
                    return;
                };
                // Thinking and a tool call's input never draft.
                if str_field(delta, "type") != Some("text_delta") {
                    return;
                }
                if let Some(text) = str_field(delta, "text") {
                    self.stream_text(index, text, events);
                }
            }
            _ => {}
        }
    }

    fn stream_text(&mut self, index: u64, piece: &str, events: &mut Vec<Value>) {
        let id = self.streaming_id();
        let message = self.message(&id);
        let text = message.streamed.entry(index).or_default();
        if text.len() >= MAX_DRAFT_TEXT_BYTES {
            return;
        }
        text.push_str(piece);
        let cumulative = text.clone();
        message.drafted = true;
        events.push(json!({
            "type": "item.updated",
            "item": {
                "id": self.redactor.text(&format!("{id}:{index}")),
                "type": "agent_message",
                "text": self.redactor.draft(&cumulative),
                "phase": "final_answer",
                "status": "in_progress",
            }
        }));
    }

    /// Sends `texts` of a message as commentary, each once, and clears the draft when one of
    /// them was drafted. Only a top-level message drafts.
    fn commentary(
        &mut self,
        message_id: &str,
        texts: Vec<(u64, String)>,
        top_level: bool,
        events: &mut Vec<Value>,
    ) {
        let mut reset = false;
        for (index, text) in texts {
            if text.trim().is_empty() {
                continue;
            }
            let message = self.message(message_id);
            if !message.commentary.insert(text.clone()) {
                continue;
            }
            reset |= message.drafted;
            let mut event = json!({
                "type": "item.completed",
                "item": {
                    "id": format!("{message_id}:{index}"),
                    "type": "agent_message",
                    "text": self.redactor.bounded(&text, MAX_COMMENTARY_CHARS),
                    "phase": "commentary",
                }
            });
            self.redactor.json(&mut event);
            events.push(event);
        }
        if top_level && reset {
            events.push(json!({ "type": DRAFT_RESET_EVENT }));
        }
    }

    fn on_assistant(&mut self, line: &Value, events: &mut Vec<Value>) {
        let top_level = is_top_level(line);
        let Some(message) = line.get("message") else {
            return;
        };
        let id = str_field(message, "id").unwrap_or_default().to_string();
        let Some(blocks) = message.get("content").and_then(Value::as_array) else {
            return;
        };
        for block in blocks {
            let index = {
                let message = self.message(&id);
                message.blocks_seen += 1;
                message.blocks_seen - 1
            };
            match str_field(block, "type") {
                Some("text") => {
                    let text = str_field(block, "text").unwrap_or_default();
                    let message = self.message(&id);
                    if message.texts.len() < MAX_TEXTS_PER_MESSAGE {
                        message.texts.push((index, text.to_string()));
                    }
                }
                Some("tool_use") => {
                    let texts = std::mem::take(&mut self.message(&id).texts);
                    self.commentary(&id, texts, top_level, events);
                    self.on_tool_use(block, parent_tool_use_id(line), events);
                }
                // Thinking is ignored, and every other block too.
                _ => {}
            }
        }
    }

    fn on_tool_use(&mut self, block: &Value, parent: Option<&str>, events: &mut Vec<Value>) {
        let Some(id) = str_field(block, "id").filter(|id| !id.is_empty()) else {
            return;
        };
        if self.seen_tools.len() >= MAX_SEEN_TOOLS {
            self.seen_tools.clear();
        }
        if !self.seen_tools.insert(id.to_string()) {
            return;
        }
        let name = self
            .redactor
            .bounded(str_field(block, "name").unwrap_or("tool"), 100);
        let input = block.get("input").unwrap_or(&Value::Null);
        let kind = match name.as_str() {
            "Bash" | "Monitor" => ToolKind::Command {
                command: command_text(&name, input, &self.redactor),
            },
            "Edit" | "Write" | "NotebookEdit" | "MultiEdit" => ToolKind::FileChange {
                paths: ["file_path", "notebook_path"]
                    .iter()
                    .find_map(|key| str_field(input, key))
                    .map(|path| vec![self.redactor.step_path(path)])
                    .unwrap_or_default(),
            },
            "WebSearch" => ToolKind::WebSearch {
                query: self.redactor.bounded(
                    str_field(input, "query").unwrap_or_default(),
                    MAX_FIELD_CHARS,
                ),
            },
            "TodoWrite" => ToolKind::TodoWrite {
                items: todo_items(input, &self.redactor),
            },
            "TaskCreate" => ToolKind::TaskCreate {
                subject: self.redactor.bounded(
                    str_field(input, "subject")
                        .or_else(|| str_field(input, "description"))
                        .unwrap_or_default(),
                    MAX_FIELD_CHARS,
                ),
            },
            "TaskUpdate" => ToolKind::TaskUpdate {
                update: TaskUpdate {
                    task_id: id_field(input, &["taskId", "task_id", "id"]),
                    status: str_field(input, "status").map(|status| bounded(status, 40)),
                    subject: str_field(input, "subject")
                        .map(|subject| self.redactor.bounded(subject, MAX_FIELD_CHARS)),
                },
            },
            _ => ToolKind::Other,
        };
        let started = match &kind {
            ToolKind::Command { command } => Some(json!({
                "type": "item.started",
                "item": {
                    "id": id,
                    "type": "command_execution",
                    "command": command,
                    "aggregated_output": "",
                    "exit_code": null,
                    "status": "in_progress",
                }
            })),
            ToolKind::Other => Some(json!({
                "type": "item.started",
                "item": {
                    "id": id,
                    "type": "mcp_tool_call",
                    "server": TOOL_SERVER,
                    "tool": name,
                    "status": "in_progress",
                    "engine": ENGINE,
                }
            })),
            // A search's step shows while it runs; its end names the words, as a Codex search's.
            ToolKind::WebSearch { query } if !query.trim().is_empty() => Some(json!({
                "type": "item.started",
                "item": { "id": id, "type": "web_search", "status": "in_progress" }
            })),
            _ => None,
        };
        if let Some(mut event) = started {
            self.redactor.json(&mut event);
            events.push(event);
        }
        if self.pending.len() < MAX_PENDING_TOOLS {
            self.pending.insert(
                id.to_string(),
                PendingTool {
                    name,
                    parent: parent.map(str::to_string),
                    kind,
                },
            );
        }
    }

    fn on_user(&mut self, line: &Value, events: &mut Vec<Value>) {
        let Some(blocks) = line.pointer("/message/content").and_then(Value::as_array) else {
            return;
        };
        let results: Vec<&Value> = blocks
            .iter()
            .filter(|block| str_field(block, "type") == Some("tool_result"))
            .collect();
        // The line's structured result belongs to its tool result when it carries only one.
        let structured = line.get("tool_use_result").filter(|_| results.len() == 1);
        for block in results {
            let Some(id) = str_field(block, "tool_use_id") else {
                continue;
            };
            let Some(tool) = self.pending.remove(id) else {
                continue;
            };
            let is_error = block.get("is_error").and_then(Value::as_bool) == Some(true);
            let text = result_text(block.get("content"));
            if is_error && reports_a_denial(&text) && self.denied.len() < MAX_DENIALS {
                self.denied.push(tool.name.clone());
            }
            self.complete_tool(id, tool, is_error, &text, structured, events);
        }
    }

    fn complete_tool(
        &mut self,
        id: &str,
        tool: PendingTool,
        is_error: bool,
        text: &str,
        structured: Option<&Value>,
        events: &mut Vec<Value>,
    ) {
        let status = if is_error { "failed" } else { "completed" };
        let event = match tool.kind {
            ToolKind::Command { command } => Some(json!({
                "type": "item.completed",
                "item": {
                    "id": id,
                    "type": "command_execution",
                    "command": command,
                    // Redacted before it is cut, so no cut leaves a part of a path or token.
                    "aggregated_output": command_output(&self.redactor.text(text)),
                    "exit_code": null,
                    "status": status,
                }
            })),
            ToolKind::FileChange { paths } => (!paths.is_empty()).then(|| {
                json!({
                    "type": "item.completed",
                    "item": { "id": id, "type": "file_change", "paths": paths, "status": status }
                })
            }),
            ToolKind::WebSearch { query } => (!query.trim().is_empty()).then(|| {
                json!({
                    "type": "item.completed",
                    "item": { "id": id, "type": "web_search", "query": query, "status": status }
                })
            }),
            ToolKind::TodoWrite { items } => (!is_error).then(|| {
                let plan = match &tool.parent {
                    Some(parent) => format!("plan:{parent}"),
                    None => "plan".to_string(),
                };
                plan_event(&plan, &items)
            }),
            ToolKind::TaskCreate { subject } => (!is_error).then(|| {
                let task_id = structured
                    .and_then(|result| result.get("task"))
                    .and_then(|task| id_field(task, &["id", "taskId"]))
                    .or_else(|| number_after_hash(text))
                    .unwrap_or_else(|| (self.task_list.len() + 1).to_string());
                if self.task_list.len() < MAX_PLAN_ITEMS {
                    self.task_list.push(Task {
                        id: task_id,
                        text: subject,
                        status: "pending".to_string(),
                    });
                }
                self.tasks_event()
            }),
            ToolKind::TaskUpdate { update } => (!is_error).then(|| {
                if let Some(task_id) = &update.task_id
                    && let Some(position) =
                        self.task_list.iter().position(|task| &task.id == task_id)
                {
                    if update.status.as_deref() == Some("deleted") {
                        self.task_list.remove(position);
                    } else {
                        let task = &mut self.task_list[position];
                        if let Some(subject) = update.subject {
                            task.text = subject;
                        }
                        if let Some(status) = update.status {
                            task.status = status;
                        }
                    }
                }
                self.tasks_event()
            }),
            ToolKind::Other => Some(json!({
                "type": "item.completed",
                "item": {
                    "id": id,
                    "type": "mcp_tool_call",
                    "server": TOOL_SERVER,
                    "tool": tool.name,
                    "status": status,
                    "engine": ENGINE,
                }
            })),
        };
        if let Some(mut event) = event {
            self.redactor.json(&mut event);
            events.push(event);
        }
    }

    /// The whole list `TaskCreate` and `TaskUpdate` built, sent each time either runs.
    fn tasks_event(&self) -> Value {
        let items: Vec<PlanItem> = self
            .task_list
            .iter()
            .map(|task| PlanItem {
                text: task.text.clone(),
                completed: task.status == "completed",
            })
            .collect();
        plan_event("tasks", &items)
    }

    fn log_entry(&self, line: &Value) -> Option<Value> {
        let kind = str_field(line, "type");
        // Partial output repeats what the `assistant` lines bring whole.
        if kind == Some("stream_event") {
            return None;
        }
        let mut entry = line.clone();
        if kind == Some("assistant")
            && let Some(content) = entry
                .pointer_mut("/message/content")
                .and_then(Value::as_array_mut)
        {
            let before = content.len();
            // Thinking is ignored, and not logged.
            content.retain(|block| {
                !matches!(
                    str_field(block, "type"),
                    Some("thinking" | "redacted_thinking")
                )
            });
            if before > 0 && content.is_empty() {
                return None;
            }
        }
        match kind {
            Some("result") => {
                // Claude Code 2.1.325 puts a second API-price estimate in each `result`'s
                // `model_usage_since_last_result` (Phase 0, B.2): neither per-model map is kept.
                if let Some(result) = entry.as_object_mut() {
                    result.remove("modelUsage");
                    result.remove("model_usage_since_last_result");
                }
            }
            Some("rate_limit_event") => entry = rate_limit_entry(line),
            _ => {}
        }
        // API-price estimates are not what a plan costs, and the sign-in is the person's: never
        // kept, from any line (2.6). 2.1.325 puts them in a `result` (`total_cost_usd`,
        // `costUSD`, `credential_expires_at`); a later version may put them anywhere.
        drop_costs_and_credentials(&mut entry);
        self.redactor.json(&mut entry);
        Some(entry)
    }

    /// The permission denials of the turn (3.7), by tool name: what Claude Code reported in the
    /// `permission_denials` of every top-level `result` and in `system/permission_denied` lines,
    /// a tool call once, since 2.1.325 reports each turn's own in its `result`. When it reported
    /// neither, the tool results that reported a denial.
    pub fn permission_denials(&self) -> Vec<String> {
        if self.denials.reported {
            self.denials.tools.clone()
        } else {
            self.denied.clone()
        }
    }

    /// The status step the permission denials make, with the tool names in Details. The turn
    /// still succeeds.
    pub fn permission_denials_step(&self) -> Option<JobMessage> {
        let denials = self.permission_denials();
        if denials.is_empty() {
            return None;
        }
        let mut tools: Vec<&str> = Vec::new();
        for name in &denials {
            if !tools.contains(&name.as_str()) {
                tools.push(name);
            }
        }
        let count = denials.len();
        let content = if count == 1 {
            "Claude Code skipped 1 step that needs your OK, since nobody can give it here. You can allow it in your own Claude Code settings.".to_string()
        } else {
            format!(
                "Claude Code skipped {count} steps that need your OK, since nobody can give it here. You can allow them in your own Claude Code settings."
            )
        };
        Some(JobMessage {
            content,
            message_type: Some("status".to_string()),
            metadata: Some(json!({
                "kind": "claude_code_permission_denials",
                "count": count,
                "tools": tools,
                "presentation": reply_note(),
            })),
        })
    }

    /// The `claude-code/usage` artifact (2.6): the model from `init` and the token counts of
    /// every top-level `result` read, summed, since Claude Code reports each turn's own usage
    /// and a follow-up turn is a turn of its own. Never a cost, and never `modelUsage`, a running
    /// total that a resumed session carries over from its earlier turns.
    pub fn usage_artifact(&self) -> Option<Value> {
        let usage = self.usage?;
        let mut artifact = json!({
            "kind": "claude-code/usage",
            "model": self.init.as_ref().map(|init| init.model.clone()),
            "usage": usage.json(),
        });
        self.redactor.json(&mut artifact);
        Some(artifact)
    }

    /// The lane's conversation state after a turn that reported its session (2.6, 2.7).
    pub fn conversation_state(&self, runtime_id: Uuid) -> Option<Value> {
        let init = self.init.as_ref()?;
        Some(json!({
            "provider": PROVIDER,
            "version": 1,
            "sessionId": init.session_id.to_string(),
            "runtimeId": runtime_id.to_string(),
        }))
    }

    /// Why the turn failed (2.6): from Claude Code's structured fields first, then from its text
    /// only as a fallback.
    pub fn classify_failure(&self, exit: &ExitFacts<'_>) -> LaneFailure {
        let texts = self.failure_texts(exit.stderr);
        let mentions = |phrases: &[&str]| {
            texts.iter().any(|text| {
                let text = text.to_lowercase();
                phrases.iter().any(|phrase| text.contains(phrase))
            })
        };
        let result_is_error = self
            .reply_result
            .as_ref()
            .is_some_and(|result| result.is_error);
        let (code, resets_at) = if let Some(rejection) = &self.rejection {
            (Some(FailureCode::PlanLimit), rejection.resets_at)
        } else if self.auth_failed {
            (Some(FailureCode::NotSignedIn), None)
        } else if mentions(&SIGN_IN_PHRASES) {
            (Some(FailureCode::NotSignedIn), None)
        } else if mentions(&PLAN_LIMIT_PHRASES) {
            (
                Some(FailureCode::PlanLimit),
                texts.iter().find_map(|text| reset_epoch_in(text)),
            )
        } else if self.init.is_none() && self.reply_result.is_some() && !result_is_error {
            // It ran, but never reported the settings the launch checks read.
            (Some(FailureCode::UnexpectedConfiguration), None)
        } else if result_is_error || !self.assistant_errors.is_empty() {
            // 5.5's "anything else": the error's own words, which are no plan's.
            (None, None)
        } else {
            (Some(FailureCode::Crashed), None)
        };
        let mut parts: Vec<String> = Vec::new();
        for text in texts {
            let text = text.trim();
            if !text.is_empty() && !parts.iter().any(|part| part == text) {
                parts.push(text.to_string());
            }
        }
        if code == Some(FailureCode::UnexpectedConfiguration) {
            parts.insert(
                0,
                "Claude Code finished without reporting its settings.".to_string(),
            );
        }
        if parts.is_empty() || code == Some(FailureCode::Crashed) {
            parts.push(exit.describe());
        }
        if let Some(resets_at) = resets_at
            && let Some(time) = chrono::DateTime::from_timestamp(resets_at, 0)
        {
            parts.push(format!(
                "The limit resets at {}.",
                time.format("%Y-%m-%d %H:%M UTC")
            ));
        }
        LaneFailure {
            code,
            message: bounded(&parts.join("\n"), MAX_FAILURE_TEXT_CHARS),
            resets_at,
        }
    }

    /// Whether `claude`, started with `--resume`, reported the session missing before its first
    /// `init` (2.7, 11.9): it ran nothing, and the runtime starts it once more in the same turn,
    /// without `--resume`, in a new session. That is an error `result` before any `init` whose
    /// structured `errors` name the missing session, as Claude Code 2.1.325 prints it on stdout
    /// before it exits 1 (Phase 0, item 7), whatever the exit: that `result` ends the turn, so
    /// the runtime's own SIGTERM races the exit, which can then be 143, 0 or a kill after the
    /// grace. Without such a `result`, as from a version that says it on stderr only, the miss is
    /// read from the text, and only after an exit that is not 0.
    pub fn missed_the_session(&self, exit: &ExitFacts<'_>) -> bool {
        if !exit.resumed || self.init.is_some() {
            return false;
        }
        self.reported_a_resume_miss()
            || (exit.exit_code.is_some_and(|code| code != 0)
                && self.failure_texts(exit.stderr).iter().any(|text| {
                    let text = text.to_lowercase();
                    RESUME_MISS_PHRASES
                        .iter()
                        .any(|phrase| text.contains(phrase))
                }))
    }

    /// Whether an error `result` before any `init` said in its structured `errors` that the
    /// session `--resume` named does not exist ([`Self::missed_the_session`]).
    fn reported_a_resume_miss(&self) -> bool {
        self.init.is_none()
            && self.reply_result.as_ref().is_some_and(|result| {
                result.is_error
                    && result.errors.iter().any(|error| {
                        let error = error.to_lowercase();
                        RESUME_MISS_PHRASES
                            .iter()
                            .any(|phrase| error.contains(phrase))
                    })
            })
    }

    /// The texts a failure can be read from, most specific first, all redacted.
    fn failure_texts(&self, stderr: &str) -> Vec<String> {
        let mut texts: Vec<String> = self
            .assistant_errors
            .iter()
            .map(|error| error.text.clone())
            .collect();
        if let Some(result) = &self.reply_result {
            if result.is_error
                && let Some(text) = &result.text
            {
                texts.push(bounded(text, MAX_FAILURE_TEXT_CHARS));
            }
            texts.extend(result.errors.iter().cloned());
        }
        if !self.unparsed_text.is_empty() {
            texts.push(self.unparsed_text.clone());
        }
        let stderr = stderr.trim();
        if !stderr.is_empty() {
            texts.push(tail_chars(stderr, MAX_FAILURE_TEXT_CHARS).to_string());
        }
        texts
    }
}

fn message_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| str_field(block, "type") == Some("text"))
            .filter_map(|block| str_field(block, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| str_field(block, "type") == Some("text"))
            .filter_map(|block| str_field(block, "text"))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn reports_a_denial(text: &str) -> bool {
    let start = bounded(text, 2_000).to_lowercase();
    DENIAL_PHRASES.iter().any(|phrase| start.contains(phrase))
        || (start.contains("permission to use") && start.contains("denied"))
}

/// A Bash command, or what a Monitor watch runs.
fn command_text(tool: &str, input: &Value, redactor: &Redactor) -> String {
    let text = str_field(input, "command")
        .or_else(|| {
            (tool == "Monitor")
                .then(|| str_field(input, "description"))
                .flatten()
        })
        .unwrap_or(tool);
    redactor.bounded(text, MAX_COMMAND_CHARS)
}

/// At most [`MAX_COMMAND_OUTPUT_CHARS`] of a command's output: its tail, as Codex keeps it.
fn command_output(output: &str) -> String {
    if output.chars().count() <= MAX_COMMAND_OUTPUT_CHARS {
        return output.to_string();
    }
    let keep = MAX_COMMAND_OUTPUT_CHARS - COMMAND_OUTPUT_TRUNCATED.chars().count();
    format!("{COMMAND_OUTPUT_TRUNCATED}{}", tail_chars(output, keep))
}

fn todo_items(input: &Value, redactor: &Redactor) -> Vec<PlanItem> {
    input
        .get("todos")
        .and_then(Value::as_array)
        .map(|todos| {
            todos
                .iter()
                .take(MAX_PLAN_ITEMS)
                .filter_map(|todo| {
                    let text = str_field(todo, "content").or_else(|| str_field(todo, "subject"))?;
                    Some(PlanItem {
                        text: redactor.bounded(text, MAX_FIELD_CHARS),
                        completed: str_field(todo, "status") == Some("completed"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `item.updated` `todo_list` with the item shape the plan step and Studio read (3.7).
fn plan_event(id: &str, items: &[PlanItem]) -> Value {
    json!({
        "type": "item.updated",
        "item": {
            "id": id,
            "type": "todo_list",
            "items": items
                .iter()
                .map(|item| json!({ "text": item.text, "completed": item.completed }))
                .collect::<Vec<_>>(),
        }
    })
}

/// The number in "Task #3 created successfully".
fn number_after_hash(text: &str) -> Option<String> {
    let after = &text[text.find('#')? + 1..];
    let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
    (!digits.is_empty()).then_some(digits)
}

/// A reset time in a plan limit's text: the seconds after `limit reached|`, as Claude Code
/// printed it.
fn reset_epoch_in(text: &str) -> Option<i64> {
    let lower = text.to_lowercase();
    let at = lower.find("limit reached|")? + "limit reached|".len();
    let digits: String = lower[at..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok().filter(|seconds: &i64| *seconds > 0)
}

/// Whether a key names a cost (`total_cost_usd`, `costUSD`, `costBasis`) or a credential
/// (`credential_expires_at`), in any letter case: no line keeps one in the run log.
fn names_a_cost_or_a_credential(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    key.contains("cost") || key.contains("credential")
}

/// Removes every key that names a cost or a credential from `value`, at any depth.
fn drop_costs_and_credentials(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.retain(|key, _| !names_a_cost_or_a_credential(key));
            map.values_mut().for_each(drop_costs_and_credentials);
        }
        Value::Array(items) => items.iter_mut().for_each(drop_costs_and_credentials),
        _ => {}
    }
}

/// What the run log keeps of a `rate_limit_event`: its own `type`, `uuid` and `session_id`, and
/// of its `rate_limit_info` only `status` and `resetsAt`, which classify a plan limit (2.6). The
/// rest is the person's plan's, not the turn's: on 2.1.325 its utilization, windows and
/// threshold, and its overage state and setting (Phase 0, B.2).
fn rate_limit_entry(line: &Value) -> Value {
    let mut entry = serde_json::Map::new();
    for key in ["type", "uuid", "session_id"] {
        if let Some(value) = line.get(key) {
            entry.insert(key.to_string(), value.clone());
        }
    }
    if let Some(info) = line.get("rate_limit_info").and_then(Value::as_object) {
        let kept: serde_json::Map<String, Value> = ["status", "resetsAt"]
            .into_iter()
            .filter_map(|key| {
                let value = info
                    .get(key)
                    .filter(|value| !value.is_object() && !value.is_array())?;
                Some((key.to_string(), value.clone()))
            })
            .collect();
        entry.insert("rate_limit_info".to_string(), Value::Object(kept));
    }
    Value::Object(entry)
}

fn truncate_strings(value: &mut Value, max_chars: usize) {
    match value {
        Value::String(text) => {
            let count = text.chars().count();
            if count > max_chars {
                let mut truncated: String = text.chars().take(max_chars).collect();
                truncated.push_str(&format!("\n[truncated {} chars]", count - max_chars));
                *text = truncated;
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|item| truncate_strings(item, max_chars)),
        Value::Object(map) => map
            .values_mut()
            .for_each(|item| truncate_strings(item, max_chars)),
        _ => {}
    }
}

fn serialized_len(value: &Value) -> usize {
    serde_json::to_vec(value).map_or(0, |bytes| bytes.len())
}

/// The turn's run log, bounded as the Codex run log is: its first and its last lines, strings
/// cut short, and a marker for what was left out between them. Lines are redacted before they
/// are cut, and thinking and partial output are never kept.
#[derive(Clone, Debug, Default)]
pub struct RunLog {
    head: Vec<Value>,
    tail: VecDeque<Value>,
    omitted: usize,
}

impl RunLog {
    pub const HEAD_EVENTS: usize = 24;
    /// Head, the compaction marker and tail fit the completion payload's list limit.
    pub const TAIL_EVENTS: usize = 55;
    const COMPACT_TAIL_EVENTS: usize = 48;
    pub const STRING_MAX_CHARS: usize = 8_000;
    const COMPACT_STRING_MAX_CHARS: usize = 2_000;
    pub const MAX_BYTES: usize = 750_000;
    /// One line, at most, as kept.
    const MAX_EVENT_BYTES: usize = 64 * 1024;

    pub fn push(&mut self, mut event: Value) {
        truncate_strings(&mut event, Self::STRING_MAX_CHARS);
        if serialized_len(&event) > Self::MAX_EVENT_BYTES {
            truncate_strings(&mut event, UNPARSED_PREVIEW_CHARS);
            if serialized_len(&event) > Self::MAX_EVENT_BYTES {
                event = json!({
                    "type": event.get("type").cloned().unwrap_or(Value::Null),
                    "subtype": event.get("subtype").cloned().unwrap_or(Value::Null),
                    "omitted": "a line too large to keep",
                });
            }
        }
        if self.head.len() < Self::HEAD_EVENTS {
            self.head.push(event);
            return;
        }
        self.tail.push_back(event);
        if self.tail.len() > Self::TAIL_EVENTS {
            self.tail.pop_front();
            self.omitted += 1;
        }
    }

    /// Every line the log was given.
    pub fn total(&self) -> usize {
        self.head.len() + self.tail.len() + self.omitted
    }

    fn assemble(&self, tail_events: usize, max_chars: Option<usize>) -> Vec<Value> {
        let skipped = self.tail.len().saturating_sub(tail_events);
        let omitted = self.omitted + skipped;
        let mut events = self.head.clone();
        if omitted > 0 {
            events.push(json!({
                "type": "instafy.run_log.compacted",
                "__instafyOriginalEventCount": self.total(),
                "omittedEventCount": omitted,
            }));
        }
        events.extend(self.tail.iter().skip(skipped).cloned());
        if let Some(max_chars) = max_chars {
            events
                .iter_mut()
                .for_each(|event| truncate_strings(event, max_chars));
        }
        events
    }

    /// The log, within [`Self::MAX_BYTES`].
    pub fn events(&self) -> Vec<Value> {
        let fits = |events: &Vec<Value>| {
            events.iter().map(serialized_len).sum::<usize>() <= Self::MAX_BYTES
        };
        let events = self.assemble(Self::TAIL_EVENTS, None);
        if fits(&events) {
            return events;
        }
        let events = self.assemble(
            Self::COMPACT_TAIL_EVENTS,
            Some(Self::COMPACT_STRING_MAX_CHARS),
        );
        if fits(&events) {
            return events;
        }
        events
            .iter()
            .map(|event| {
                json!({
                    "type": event.get("type").cloned().unwrap_or(Value::Null),
                    "subtype": event.get("subtype").cloned().unwrap_or(Value::Null),
                })
            })
            .collect()
    }

    /// The `claude-code/run-log` artifact (3.8). Never a `codex/run-log`.
    pub fn artifact(&self) -> Value {
        let events = self.events();
        json!({
            "kind": "claude-code/run-log",
            "metadata": {
                "provider": PROVIDER,
                "originalEventCount": self.total(),
                "retainedEventCount": events.len(),
            },
            "events": events,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FOLDER: &str = "/home/person/Instafy/space";
    const HOME: &str = "/home/person";

    fn redactor() -> Redactor {
        Redactor::new(Path::new(FOLDER), Some(Path::new(HOME)))
    }

    #[test]
    fn tokens_are_redacted_in_any_case_and_a_bare_prefix_stays() {
        assert_eq!(
            redact_tokens("key sk-ant-oat01-AbC_d-9 and SK-ANT-api03-x."),
            "key [redacted] and [redacted]."
        );
        assert_eq!(redact_tokens("risk-ant-xyz"), "ri[redacted]");
        for text in [
            "sk-ant-",
            "starts with `sk-ant-`",
            "sk-ant-.",
            "naïve sk-an",
        ] {
            assert_eq!(redact_tokens(text), text);
        }
        assert_eq!(redact_tokens("é sk-ant-a é"), "é [redacted] é");
    }

    #[test]
    fn the_folder_becomes_relative_and_the_home_folder_tilde() {
        let redactor = redactor();
        for (text, redacted) in [
            (
                "edited /home/person/Instafy/space/src/a.ts",
                "edited src/a.ts",
            ),
            ("cd /home/person/Instafy/space && ls", "cd . && ls"),
            ("in /home/person/Instafy/space, then", "in ., then"),
            ("in /home/person/Instafy/space.", "in .."),
            ("/home/person/Instafy/space/ is it", "./ is it"),
            ("/home/person/Instafy/space/.git", ".git"),
            ("/home/person/Instafy/space-2/x", "~/Instafy/space-2/x"),
            ("/home/person/Instafy/space.bak", "~/Instafy/space.bak"),
            ("read /home/person/.npmrc", "read ~/.npmrc"),
            ("home is /home/person", "home is ~"),
            ("/home/personal/x", "/home/personal/x"),
            ("/home/other/x", "/home/other/x"),
            (
                "token sk-ant-api03-abc in /home/person/.config",
                "token [redacted] in ~/.config",
            ),
        ] {
            assert_eq!(redactor.text(text), redacted, "{text}");
        }
        let mut value = json!({"a": ["/home/person/x", {"b": "sk-ant-x"}], "n": 3});
        redactor.json(&mut value);
        assert_eq!(value, json!({"a": ["~/x", {"b": "[redacted]"}], "n": 3}));
        // A bound cuts after redaction, so a cut never leaves a part of a path or token.
        assert_eq!(redactor.bounded("x /home/person/y", 12), "x ~/y");
        assert_eq!(redactor.bounded("x sk-ant-abcdef", 4), "x [r…");
        assert_eq!(bounded("x /home/person/y", 12), "x /home/pers…");
    }

    /// Claude Code names its own per-folder directories by a slug of the folder's absolute path,
    /// which names the OS user (Phase 0, B.2): in `init`'s `memory_paths.auto`, in a command that
    /// reads the memory index, and in a background command's output file. Placeholder names.
    #[test]
    fn claude_codes_names_for_the_folder_and_the_home_folder_are_replaced() {
        let folder = "/home/person/.instafy/workspace/9a1f3c2e-7b4d-4e8a-a6c5-1d2e3f4a5b6c";
        let name = "-home-person--instafy-workspace-9a1f3c2e-7b4d-4e8a-a6c5-1d2e3f4a5b6c";
        assert_eq!(claude_folder_name(folder), name);
        assert_eq!(
            claude_folder_name("/home/john.doe/a_b c"),
            "-home-john-doe-a-b-c"
        );
        // One `-` per UTF-16 unit, as JavaScript replaces them.
        assert_eq!(claude_folder_name("/home/zoë/🦀"), "-home-zo----");
        let redactor = Redactor::new(Path::new(folder), Some(Path::new("/home/person")));
        for (text, redacted) in [
            (
                format!("{{\"auto\":\"/home/person/.claude/projects/{name}/memory/\"}}"),
                "{\"auto\":\"~/.claude/projects/[this space]/memory/\"}",
            ),
            (
                format!("cat \"/home/person/.claude/projects/{name}/memory/MEMORY.md\""),
                "cat \"~/.claude/projects/[this space]/memory/MEMORY.md\"",
            ),
            (
                format!(
                    "Command running in background with ID: b1. Output is being written to: /private/tmp/claude-1000/{name}/5d2a8c4e-1f3b-4c6d-9e7a-0b1c2d3e4f50/tasks/b1.output"
                ),
                "Command running in background with ID: b1. Output is being written to: /private/tmp/claude-1000/[this space]/5d2a8c4e-1f3b-4c6d-9e7a-0b1c2d3e4f50/tasks/b1.output",
            ),
            (
                format!("{name} and {name}."),
                "[this space] and [this space].",
            ),
            // Another folder under the home folder, and the home folder itself.
            (
                "/private/tmp/claude-1000/-home-person--instafy-workspace-0b2c/s/tasks/x.output"
                    .to_string(),
                "/private/tmp/claude-1000/[home]--instafy-workspace-0b2c/s/tasks/x.output",
            ),
            (
                "/home/person/.claude/projects/-home-person/memory/".to_string(),
                "~/.claude/projects/[home]/memory/",
            ),
            // A folder whose name only starts like the space's is another one.
            (
                format!("projects/{name}-2/memory"),
                "projects/[home]--instafy-workspace-9a1f3c2e-7b4d-4e8a-a6c5-1d2e3f4a5b6c-2/memory",
            ),
            // Wherever a name starts, outside a path too.
            (
                "run with -home-person-flags".to_string(),
                "run with [home]-flags",
            ),
            // Not the home folder's name: another user's, or one inside a longer name.
            (
                "projects/-home-personal--app/memory".to_string(),
                "projects/-home-personal--app/memory",
            ),
            (
                "projects/-Volumes-x-home-person-app".to_string(),
                "projects/-Volumes-x-home-person-app",
            ),
        ] {
            assert_eq!(redactor.text(&text), redacted, "{text}");
        }
        // A home folder whose name has a character Claude Code makes `-`.
        let dotted = Redactor::new(
            Path::new("/home/john.doe/.instafy/workspace/w1"),
            Some(Path::new("/home/john.doe")),
        );
        assert_eq!(
            dotted.text(
                "/private/tmp/claude-1000/-home-john-doe--instafy-workspace-w1/s and -home-john-doe--instafy-workspace-w2/s"
            ),
            "/private/tmp/claude-1000/[this space]/s and [home]--instafy-workspace-w2/s"
        );
        // A draft holds back an end that could still grow into either name.
        for (text, draft) in [
            (
                "Wrote ~/.claude/projects/-home-pers",
                "Wrote ~/.claude/projects/",
            ),
            (
                "Wrote ~/.claude/projects/-home-person",
                "Wrote ~/.claude/projects/",
            ),
            (
                "Wrote ~/.claude/projects/-home-person--instafy-work",
                "Wrote ~/.claude/projects/",
            ),
            (
                "Wrote ~/.claude/projects/-home-person--instafy-workspace-0b2c",
                "Wrote ~/.claude/projects/[home]--instafy-workspace-0b2c",
            ),
        ] {
            assert_eq!(redactor.draft(text), draft, "{text}");
        }
    }

    /// The names reach steps, the reply and the run log as Phase 0 saw them, for a folder under
    /// the home folder as Desktop's are: none of them names the OS user.
    #[test]
    fn no_step_reply_or_run_log_line_names_the_user_through_claude_codes_folder_names() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let home = root.join("Users/person");
        let folder = home.join(".instafy/workspace/9a1f3c2e");
        std::fs::create_dir_all(&folder).unwrap();
        let name = claude_folder_name(folder.to_str().unwrap());
        let projects = home.join(".claude/projects").join(&name);
        let output = format!("/private/tmp/claude-1000/{name}/5d2a8c4e/tasks/b1.output");
        let mut adapter = EventAdapter::new(&folder, Some(&home));
        let mut with_memory = init(&folder);
        with_memory["memory_paths"] = json!({"auto": format!("{}/memory/", projects.display())});
        let mut events = adapter.feed(&with_memory);
        for line in [
            assistant(
                "m1",
                json!([{"type": "tool_use", "id": "b1", "name": "Bash", "input": {"command": format!("cat \"{}/memory/MEMORY.md\"", projects.display())}}]),
                None,
            ),
            tool_result("b1", json!("- [Notes](notes.md)"), false),
            assistant(
                "m2",
                json!([{"type": "tool_use", "id": "b2", "name": "Bash", "input": {"command": "npm run dev", "run_in_background": true}}]),
                None,
            ),
            tool_result(
                "b2",
                json!(format!(
                    "Command running in background with ID: bfake2. Output is being written to: {output}"
                )),
                false,
            ),
            stream(
                json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": format!("Its log is {output}")}}),
            ),
            result(&format!("The dev server writes to {output}."), false),
        ] {
            events.extend(adapter.feed(&line));
        }
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        let steps = serde_json::to_string(&events).unwrap();
        let log = serde_json::to_string(&adapter.run_log().artifact()).unwrap();
        let reply = adapter.reply().unwrap_or_default().to_string();
        assert!(
            reply.contains("/private/tmp/claude-1000/[this space]/5d2a8c4e/tasks/b1.output"),
            "{reply}"
        );
        assert!(
            steps.contains("cat \\\"~/.claude/projects/[this space]/memory/MEMORY.md\\\""),
            "{steps}"
        );
        assert!(
            log.contains("~/.claude/projects/[this space]/memory/"),
            "{log}"
        );
        for text in [&steps, &log, &reply] {
            assert!(!text.contains("person"), "{text}");
            assert!(!text.contains(&name), "{text}");
        }
    }

    #[test]
    fn a_draft_holds_back_an_end_that_could_grow_into_a_named_path() {
        let redactor = redactor();
        for (text, draft) in [
            ("Edited /home/pers", "Edited "),
            ("Edited /home/person/Instafy/sp", "Edited "),
            ("Edited /home/person/Instafy/space", "Edited "),
            ("Edited /home/person/Instafy/space/", "Edited "),
            ("Edited /home/person/Instafy/space/sr", "Edited sr"),
            ("Edited /home/person/Desk", "Edited ~/Desk"),
            ("A path /", "A path /"),
            ("The tests", "The tests"),
            ("key sk-ant-a", "key [redacted]"),
        ] {
            assert_eq!(redactor.draft(text), draft, "{text}");
        }
    }

    #[test]
    fn step_paths_are_relative_or_outside_this_space() {
        let redactor = redactor();
        for (raw, path) in [
            ("/home/person/Instafy/space/src/a.ts", "src/a.ts"),
            ("/home/person/Instafy/space", "."),
            ("src/./b.ts", "src/b.ts"),
            ("src/../c.ts", "c.ts"),
            ("../outside.ts", OUTSIDE_THIS_SPACE),
            (
                "/home/person/Instafy/space/../other/a.ts",
                OUTSIDE_THIS_SPACE,
            ),
            ("/etc/hosts", OUTSIDE_THIS_SPACE),
            ("/home/person/.claude/settings.json", OUTSIDE_THIS_SPACE),
            ("~/notes.md", OUTSIDE_THIS_SPACE),
            ("", OUTSIDE_THIS_SPACE),
            ("keys/sk-ant-abc.txt", "keys/[redacted].txt"),
        ] {
            assert_eq!(redactor.step_path(raw), path, "{raw}");
        }
    }

    fn init(folder: &Path) -> Value {
        json!({
            "type": "system",
            "subtype": "init",
            "session_id": "5d2a8c4e-1f3b-4c6d-9e7a-0b1c2d3e4f50",
            "cwd": folder,
            "model": "claude-sonnet-4-5",
            "permissionMode": "acceptEdits",
            "mcp_servers": [],
        })
    }

    #[test]
    fn an_init_that_names_the_space_s_own_configuration_fails_the_launch_checks() {
        let temp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(temp.path()).unwrap();
        let write = |path: &str, text: &str| {
            let path = folder.join(path);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write(
            ".claude/output-styles/terse.md",
            "---\nname: team-terse\ndescription: d\n---\nBe brief.\n",
        );
        write(".claude/settings.json", r#"{"outputStyle": "team-terse"}"#);
        write(
            ".claude/skills/review/SKILL.md",
            "---\nname: team-review\ndescription: d\n---\nbody\n",
        );
        write(
            ".claude/agents/helper.md",
            "---\nname: team-helper\ndescription: d\n---\nbody\n",
        );
        write(".claude/commands/ship.md", "Ship it.\n");
        // The lane's flags kept it all out.
        let mut kept_out = init(&folder);
        kept_out["output_style"] = json!("default");
        kept_out["skills"] = json!(["deep-research"]);
        kept_out["agents"] = json!(["claude"]);
        kept_out["slash_commands"] = json!(["deep-research", "review"]);
        assert!(check_init(&kept_out, &folder).is_ok());
        // The space's output style took effect.
        let mut styled = kept_out.clone();
        styled["output_style"] = json!("team-terse");
        let error = check_init(&styled, &folder).unwrap_err();
        assert!(error.contains("output style, team-terse"), "{error}");
        assert!(check_later_init(&styled, &folder).is_err());
        // Every skill, agent and command it defines loaded.
        let mut loaded = kept_out.clone();
        loaded["skills"] = json!(["deep-research", "team-review"]);
        loaded["agents"] = json!(["claude", "team-helper"]);
        loaded["slash_commands"] = json!(["deep-research", "team-review", "ship"]);
        let error = check_init(&loaded, &folder).unwrap_err();
        assert!(
            error.contains("(ship, team-helper, team-review)"),
            "{error}"
        );
        // One of them alone may be the person's own of the same name.
        let mut one = kept_out.clone();
        one["slash_commands"] = json!(["deep-research", "ship"]);
        assert!(check_init(&one, &folder).is_ok());
    }

    #[test]
    fn a_space_that_defines_one_name_is_never_read_as_loaded() {
        let temp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(temp.path()).unwrap();
        std::fs::create_dir_all(folder.join(".claude/commands")).unwrap();
        std::fs::write(folder.join(".claude/commands/ship.md"), "Ship it.\n").unwrap();
        let mut listed = init(&folder);
        listed["slash_commands"] = json!(["ship"]);
        assert!(check_init(&listed, &folder).is_ok());
        // A space with no .claude folder names nothing.
        std::fs::remove_dir_all(folder.join(".claude")).unwrap();
        listed["output_style"] = json!("anything");
        assert!(check_init(&listed, &folder).is_ok());
    }

    #[test]
    fn the_launch_checks_read_every_documented_init_field() {
        let temp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(temp.path()).unwrap();
        let good = init(&folder);
        let facts = check_init(&good, &folder, ExecutionMode::Apply).unwrap();
        assert_eq!(
            facts.session_id.to_string(),
            "5d2a8c4e-1f3b-4c6d-9e7a-0b1c2d3e4f50"
        );
        assert_eq!(facts.model, "claude-sonnet-4-5");

        // The same folder under another spelling passes.
        let link = folder.join("link");
        std::fs::create_dir(folder.join("real")).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(folder.join("real"), &link).unwrap();
            let mut through_link = good.clone();
            through_link["cwd"] = json!(link);
            assert!(check_init(&through_link, &folder.join("real"), ExecutionMode::Apply).is_ok());
        }

        let mut cases: Vec<(&str, Value)> = Vec::new();
        for field in [
            "session_id",
            "cwd",
            "model",
            "permissionMode",
            "mcp_servers",
        ] {
            let mut missing = good.clone();
            missing.as_object_mut().unwrap().remove(field);
            cases.push((field, missing.clone()));
            missing[field] = Value::Null;
            cases.push((field, missing));
        }
        for (field, value) in [
            ("session_id", json!("not-a-uuid")),
            ("session_id", json!("5d2a8c4e1f3b4c6d9e7a0b1c2d3e4f50")),
            ("cwd", json!("/")),
            ("cwd", json!("relative/space")),
            ("cwd", json!(folder.join("real"))),
            ("model", json!("  ")),
            ("permissionMode", json!("bypassPermissions")),
            ("permissionMode", json!("default")),
            (
                "mcp_servers",
                json!([{"name": "instafy", "status": "connected"}]),
            ),
            ("mcp_servers", json!({})),
        ] {
            let mut changed = good.clone();
            changed[field] = value;
            cases.push((field, changed));
        }
        for (field, case) in cases {
            assert!(
                check_init(&case, &folder, ExecutionMode::Apply).is_err(),
                "{field}: {case}"
            );
        }
    }

    /// The permission mode every `init` must report is the turn's own (3.6, 11.12): `acceptEdits`
    /// for a turn that applies its changes, Claude Code's `plan` for a `plan_only` turn. Either
    /// one fails the other's turn, a later turn's `init` too.
    #[test]
    fn the_launch_checks_expect_the_permission_mode_of_the_turns_own_mode() {
        let temp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(temp.path()).unwrap();
        let applies = init(&folder);
        let mut plans = init(&folder);
        plans["permissionMode"] = json!("plan");
        assert!(check_init(&applies, &folder, ExecutionMode::Apply).is_ok());
        assert!(check_init(&plans, &folder, ExecutionMode::PlanOnly).is_ok());
        assert!(check_later_init(&plans, &folder, ExecutionMode::PlanOnly).is_ok());
        assert_eq!(
            check_init(&applies, &folder, ExecutionMode::PlanOnly).unwrap_err(),
            "Claude Code started with permission mode acceptEdits, not plan."
        );
        assert_eq!(
            check_init(&plans, &folder, ExecutionMode::Apply).unwrap_err(),
            "Claude Code started with permission mode plan, not acceptEdits."
        );
        assert!(check_later_init(&applies, &folder, ExecutionMode::PlanOnly).is_err());
        for other in ["bypassPermissions", "dontAsk", "auto", "default", "Plan"] {
            let mut case = init(&folder);
            case["permissionMode"] = json!(other);
            for mode in [ExecutionMode::Apply, ExecutionMode::PlanOnly] {
                assert!(
                    check_init(&case, &folder, mode).is_err(),
                    "{other} {mode:?}"
                );
            }
        }

        // The adapter of a turn checks every `init` it reads by the turn's mode.
        let mut planning = EventAdapter::new(&folder, None).in_mode(ExecutionMode::PlanOnly);
        planning.feed(&plans);
        assert!(planning.init().is_some());
        planning.feed(&result("Here is the plan.", false));
        assert!(planning.succeeded());
        let mut mismatched = EventAdapter::new(&folder, None).in_mode(ExecutionMode::PlanOnly);
        mismatched.feed(&applies);
        assert!(
            matches!(mismatched.status(), AdapterStatus::Unexpected(why) if why.ends_with("not plan."))
        );
        let mut applying = EventAdapter::new(&folder, None);
        applying.feed(&plans);
        assert!(matches!(applying.status(), AdapterStatus::Unexpected(_)));
    }

    /// A later turn's `init` (a follow-up's or a peer message's) reports the shell's folder as
    /// `cwd`, which a `cd` inside the folder moves, and the folder `claude` started in as
    /// `original_cwd` (Claude Code 2.1.325). Its `cwd` must be the folder or inside it, and its
    /// `original_cwd`, when present, the folder itself; the other checks stay. The launch's own
    /// `init` must still report the folder itself.
    #[test]
    fn a_later_turns_init_is_checked_by_the_folder_it_started_in() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let folder = root.join("space");
        let inside = folder.join("packages/app");
        let sibling = root.join("space-2");
        for path in [&inside, &sibling] {
            std::fs::create_dir_all(path).unwrap();
        }
        let later = |cwd: Value, original: Option<Value>| {
            let mut line = init(&folder);
            line["cwd"] = cwd;
            if let Some(original) = original {
                line["original_cwd"] = original;
            }
            line
        };
        let moved = later(json!(inside), Some(json!(folder)));
        assert!(check_later_init(&moved, &folder, ExecutionMode::Apply).is_ok());
        assert!(
            check_init(&moved, &folder, ExecutionMode::Apply).is_err(),
            "the launch's own init reports the folder itself"
        );
        // With `original_cwd` the folder, the shell's folder must still be in the folder or
        // inside it: `original_cwd` alone never decides.
        for cwd in [json!(folder), json!(inside)] {
            assert!(
                check_later_init(
                    &later(cwd.clone(), Some(json!(folder))),
                    &folder,
                    ExecutionMode::Apply
                )
                .is_ok(),
                "{cwd}"
            );
        }
        for cwd in [
            json!(root),
            json!(sibling),
            json!("/"),
            json!("packages/app"),
        ] {
            let case = later(cwd.clone(), Some(json!(folder)));
            assert!(
                matches!(check_later_init(&case, &folder, ExecutionMode::Apply), Err(why) if why.contains("later turn")),
                "{cwd}"
            );
        }
        for original in [
            json!(inside),
            json!(sibling),
            json!(root),
            json!("/"),
            json!("space"),
            json!(3),
        ] {
            let case = later(json!(folder), Some(original.clone()));
            assert!(
                check_later_init(&case, &folder, ExecutionMode::Apply).is_err(),
                "{original}"
            );
        }
        // Without it, a `cwd` in the folder or inside it; never one outside it, nor one that
        // only leads out of it.
        assert!(
            check_later_init(&later(json!(inside), None), &folder, ExecutionMode::Apply).is_ok()
        );
        assert!(
            check_later_init(
                &later(json!(folder), Some(Value::Null)),
                &folder,
                ExecutionMode::Apply
            )
            .is_ok()
        );
        let mut outside = vec![
            json!(sibling),
            json!(root),
            json!("/"),
            json!("packages/app"),
            json!(format!(
                "{}/packages/app/../../../space-2",
                folder.display()
            )),
        ];
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&sibling, folder.join("out")).unwrap();
            outside.push(json!(folder.join("out")));
        }
        for cwd in outside {
            assert!(
                check_later_init(&later(cwd.clone(), None), &folder, ExecutionMode::Apply).is_err(),
                "{cwd}"
            );
        }
        // The session id, permission mode, model and MCP servers are checked as at launch.
        for (field, value) in [
            ("session_id", json!("not-a-uuid")),
            ("session_id", Value::Null),
            ("model", json!("")),
            ("permissionMode", json!("bypassPermissions")),
            (
                "mcp_servers",
                json!([{"name": "instafy", "status": "connected"}]),
            ),
            ("cwd", Value::Null),
        ] {
            let mut case = moved.clone();
            case[field] = value;
            assert!(
                check_later_init(&case, &folder, ExecutionMode::Apply).is_err(),
                "{field}: {case}"
            );
        }
    }

    /// A later turn's `cwd` that no longer exists, such as a folder deleted after a `cd` into it,
    /// is read by its longest ancestor that does: that ancestor resolved, and the plain names after
    /// it joined. One whose ancestor is outside the folder, or is a link that leads out of it, or
    /// whose names after it climb with `..`, fails the launch checks as any other folder outside
    /// would; so does one through a link whose target is gone. `original_cwd` must still be the
    /// folder itself, and the launch's own `init` the folder too.
    #[test]
    fn a_later_turns_cwd_that_no_longer_exists_is_read_by_its_existing_ancestor() {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        let folder = root.join("space");
        let sibling = root.join("space-2");
        let deleted = folder.join("packages/app");
        for path in [&deleted, &sibling] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::remove_dir(&deleted).unwrap();
        let later = |cwd: &Path| {
            let mut line = init(&folder);
            line["cwd"] = json!(cwd);
            line["original_cwd"] = json!(folder);
            line
        };
        for cwd in [
            deleted.clone(),
            deleted.join("src/lib"),
            folder.join("gone"),
        ] {
            assert!(
                check_later_init(&later(&cwd), &folder, ExecutionMode::Apply).is_ok(),
                "{}",
                cwd.display()
            );
        }
        let mut outside = vec![
            deleted.join(".."),
            deleted.join("../.."),
            deleted.join("../../../space-2"),
            sibling.join("gone"),
            root.join("gone/space"),
        ];
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&sibling, folder.join("out")).unwrap();
            outside.push(folder.join("out/gone"));
            std::os::unix::fs::symlink(root.join("missing"), folder.join("dangling")).unwrap();
            outside.push(folder.join("dangling"));
            outside.push(folder.join("dangling/gone"));
        }
        for cwd in outside {
            assert_eq!(
                check_later_init(&later(&cwd), &folder, ExecutionMode::Apply).unwrap_err(),
                "Claude Code started a later turn in another folder than this space's.",
                "{}",
                cwd.display()
            );
        }
        let mut started_there = later(&deleted);
        started_there["original_cwd"] = json!(deleted);
        assert!(check_later_init(&started_there, &folder, ExecutionMode::Apply).is_err());
        assert!(check_init(&later(&deleted), &folder, ExecutionMode::Apply).is_err());
    }

    /// Through the adapter: a turn whose shell moved inside the folder before a background
    /// subagent's follow-up turn started goes on to the follow-up's `result`, in Phase 0's order
    /// (the follow-up first) and with the notification before the turn's `result` and the
    /// follow-up after it. A later `init` that started in another folder fails the launch checks.
    #[test]
    fn a_follow_up_turn_after_a_cd_inside_the_folder_passes_the_launch_checks() {
        let (_temp, folder, _) = adapter();
        let inside = folder.join("packages/app");
        std::fs::create_dir_all(&inside).unwrap();
        let mut moved = init(&folder);
        moved["cwd"] = json!(inside);
        moved["original_cwd"] = json!(folder);
        let cd = |adapter: &mut EventAdapter| {
            adapter.feed(&init(&folder));
            adapter.feed(&started_in_the_background("a1", "run-a", "local_agent"));
            adapter.feed(&assistant(
                "m1",
                json!([{"type": "tool_use", "id": "t_cd", "name": "Bash", "input": {"command": "cd packages/app && npm test"}}]),
                None,
            ));
            adapter.feed(&tool_result("t_cd", json!("3 tests passed"), false));
            adapter.feed(&ended("a1", "run-a"));
        };
        let follow_up = turn_result(
            "The helper checked the changelog.",
            1,
            Some(follow_up_of("run-a")),
            [1, 0, 0, 1],
        );

        let mut first = EventAdapter::new(&folder, None);
        cd(&mut first);
        first.feed(&moved);
        first.feed(&turn_result("The tests pass.", 0, None, [1, 0, 0, 1]));
        assert_eq!(first.status(), &AdapterStatus::Running);
        first.feed(&follow_up);
        assert_eq!(first.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(first.reply(), Some("The helper checked the changelog."));
        assert!(first.succeeded());

        let mut after = EventAdapter::new(&folder, None);
        cd(&mut after);
        after.feed(&turn_result("The tests pass.", 0, None, [1, 0, 0, 1]));
        assert_eq!(after.status(), &AdapterStatus::Running);
        after.feed(&moved);
        assert_eq!(after.status(), &AdapterStatus::Running);
        after.feed(&follow_up);
        assert_eq!(after.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(after.reply(), Some("The helper checked the changelog."));
        assert!(after.succeeded());

        let mut elsewhere = EventAdapter::new(&folder, None);
        cd(&mut elsewhere);
        let mut other = moved.clone();
        other["original_cwd"] = json!(folder.parent().unwrap());
        elsewhere.feed(&other);
        assert!(
            matches!(elsewhere.status(), AdapterStatus::Unexpected(why) if why.contains("another folder")),
            "{:?}",
            elsewhere.status()
        );
        assert!(!elsewhere.succeeded());

        // Nor does one whose shell left the folder pass because it started in the folder.
        for cwd in [json!(folder.parent().unwrap()), json!("/")] {
            let mut outside = EventAdapter::new(&folder, None);
            cd(&mut outside);
            let mut left = moved.clone();
            left["cwd"] = cwd.clone();
            outside.feed(&left);
            assert!(
                matches!(outside.status(), AdapterStatus::Unexpected(why) if why.contains("later turn")),
                "{cwd}: {:?}",
                outside.status()
            );
            assert_eq!(outside.inits(), 1);
            assert!(!outside.succeeded());
        }
    }

    fn task(subtype: &str, id: &str, extra: Value) -> Value {
        let mut line = json!({"type": "system", "subtype": subtype, "task_id": id});
        for (key, value) in extra.as_object().unwrap() {
            line[key] = value.clone();
        }
        line
    }

    #[test]
    fn only_a_live_task_other_than_a_command_or_ambient_one_keeps_a_turn_open() {
        let mut tasks = BackgroundTasks::default();
        assert!(!tasks.keeps_the_turn_open());
        tasks.observe(&task(
            "task_started",
            "b1",
            json!({"task_type": "local_bash"}),
        ));
        tasks.observe(&task("task_started", "a1", json!({"task_type": "ambient"})));
        tasks.observe(&task(
            "task_started",
            "a2",
            json!({"task_type": "local_agent", "ambient": true}),
        ));
        assert_eq!(tasks.live(), 1);
        assert!(!tasks.keeps_the_turn_open());
        tasks.observe(&task(
            "task_started",
            "s1",
            json!({"task_type": "local_agent"}),
        ));
        assert!(tasks.keeps_the_turn_open());
        tasks.observe(&task(
            "task_notification",
            "s1",
            json!({"status": "running"}),
        ));
        assert!(tasks.keeps_the_turn_open());
        tasks.observe(&task(
            "task_notification",
            "s1",
            json!({"status": "completed"}),
        ));
        assert!(!tasks.keeps_the_turn_open());
        // A task that does not say its type counts as one that keeps the turn open.
        tasks.observe(&task("task_started", "w1", json!({})));
        assert!(tasks.keeps_the_turn_open());
        // A list adds what it names and removes what it says ended or is ambient; a live task it
        // leaves out stays live.
        tasks.observe(&json!({
            "type": "system",
            "subtype": "background_tasks_changed",
            "tasks": [
                {"task_id": "b2", "task_type": "local_bash"},
                {"id": "w2", "type": "local_workflow", "status": "completed"},
                {"task_id": "x", "task_type": "ambient"},
            ],
        }));
        assert_eq!(tasks.live(), 3, "b1, w1 and b2");
        assert!(tasks.keeps_the_turn_open(), "w1 is not in the list");
        tasks.observe(&task(
            "task_notification",
            "w1",
            json!({"status": "completed"}),
        ));
        assert!(!tasks.keeps_the_turn_open());
        tasks.observe(&json!({
            "type": "system",
            "subtype": "background_tasks_changed",
            "tasks": [{"task_id": "w3", "task_type": "local_workflow"}],
        }));
        assert!(tasks.keeps_the_turn_open());
        // An event without a list changes nothing.
        tasks.observe(&json!({"type": "system", "subtype": "background_tasks_changed"}));
        assert!(tasks.keeps_the_turn_open());
    }

    /// The end-of-turn rule fails closed on a shape it does not know (3.6): a result while a
    /// background subagent may still run never ends the turn.
    #[test]
    fn only_an_event_that_says_a_task_ended_lets_a_result_end_the_turn() {
        let changed = |tasks: Value| json!({"type": "system", "subtype": "background_tasks_changed", "tasks": tasks});

        // A list that leaves out a live subagent, or lists only background commands.
        let mut tasks = BackgroundTasks::default();
        tasks.observe(&task(
            "task_started",
            "a1",
            json!({"task_type": "local_agent"}),
        ));
        tasks.observe(&changed(json!([{"id": "bash_1", "type": "local_bash"}])));
        tasks.observe(&changed(json!([])));
        assert!(tasks.keeps_the_turn_open());
        // A listed entry that does not say its type keeps the one it started with.
        tasks.observe(&task(
            "task_started",
            "b1",
            json!({"task_type": "local_bash"}),
        ));
        tasks.observe(&changed(json!([{"task_id": "b1"}])));
        tasks.observe(&task(
            "task_notification",
            "a1",
            json!({"status": "completed"}),
        ));
        assert!(!tasks.keeps_the_turn_open());

        // A notification with no status, or one that does not say the task ended.
        let mut tasks = BackgroundTasks::default();
        tasks.observe(&task(
            "task_started",
            "a2",
            json!({"task_type": "local_agent"}),
        ));
        for notification in [
            json!({}),
            json!({"status": "progress"}),
            json!({"status": "running"}),
            json!({"status": 3}),
        ] {
            tasks.observe(&task("task_notification", "a2", notification.clone()));
            assert!(tasks.keeps_the_turn_open(), "{notification}");
        }
        tasks.observe(&task(
            "task_notification",
            "a2",
            json!({"status": "failed"}),
        ));
        assert!(!tasks.keeps_the_turn_open());

        // A listed task with no id this reads: the turn stays open until a list no longer has
        // it. A background command with no id does not keep it open.
        let mut tasks = BackgroundTasks::default();
        tasks.observe(&changed(json!([
            {"agent_id": "a3", "task_type": "local_agent"},
            {"tool_use_id": "toolu_2", "type": "local_bash"},
        ])));
        assert_eq!(tasks.live(), 0);
        assert!(tasks.keeps_the_turn_open());
        tasks.observe(&changed(json!([
            {"agent_id": "a3", "task_type": "local_agent", "status": "completed"},
            {"tool_use_id": "toolu_2", "type": "local_bash"},
        ])));
        assert!(!tasks.keeps_the_turn_open());
        tasks.observe(&changed(json!([{"agent_id": "a4"}])));
        assert!(tasks.keeps_the_turn_open());
        tasks.observe(&changed(json!([])));
        assert!(!tasks.keeps_the_turn_open());
    }

    fn adapter() -> (tempfile::TempDir, PathBuf, EventAdapter) {
        let temp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(temp.path()).unwrap();
        let adapter = EventAdapter::new(&folder, Some(Path::new(HOME)));
        (temp, folder, adapter)
    }

    fn stream(event: Value) -> Value {
        json!({"type": "stream_event", "event": event, "parent_tool_use_id": null})
    }

    fn assistant(id: &str, blocks: Value, parent: Option<&str>) -> Value {
        json!({"type": "assistant", "message": {"id": id, "content": blocks}, "parent_tool_use_id": parent})
    }

    fn tool_result(id: &str, content: Value, is_error: bool) -> Value {
        json!({
            "type": "user",
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": id, "content": content, "is_error": is_error}
            ]},
            "parent_tool_use_id": null,
        })
    }

    #[test]
    fn work_before_init_fails_the_launch_checks() {
        let (_temp, _folder, mut adapter) = adapter();
        let events = adapter.feed(&assistant(
            "m",
            json!([{"type": "text", "text": "Hi"}]),
            None,
        ));
        assert!(events.is_empty());
        assert!(matches!(adapter.status(), AdapterStatus::Unexpected(_)));
        // Nothing more is read.
        assert!(
            adapter
                .feed(&json!({"type": "result", "result": "x"}))
                .is_empty()
        );
        assert!(adapter.reply_result().is_none());
    }

    #[test]
    fn streamed_text_drafts_and_turns_into_commentary_when_a_tool_call_follows() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        adapter.feed(&stream(
            json!({"type": "message_start", "message": {"id": "msg_1"}}),
        ));
        adapter.feed(&stream(json!({"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": ""}})));
        assert!(adapter.feed(&stream(json!({"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "private"}}))).is_empty());
        adapter.feed(&stream(json!({"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}})));
        let first = adapter.feed(&stream(json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "Looking at "}})));
        let path = format!("{}/src/a.ts", folder.display());
        let second = adapter.feed(&stream(json!({"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": path}})));
        assert_eq!(
            first,
            [
                json!({"type": "item.updated", "item": {"id": "msg_1:1", "type": "agent_message", "text": "Looking at ", "phase": "final_answer", "status": "in_progress"}})
            ]
        );
        assert_eq!(second[0]["item"]["text"], json!("Looking at src/a.ts"));
        // A tool call starts in the same message: the text was commentary.
        let events = adapter.feed(&stream(json!({"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {}}})));
        assert_eq!(
            events,
            [
                json!({"type": "item.completed", "item": {"id": "msg_1:1", "type": "agent_message", "text": "Looking at src/a.ts", "phase": "commentary"}}),
                json!({"type": DRAFT_RESET_EVENT}),
            ]
        );
        // The whole lines repeat it: no second commentary, and the tool call starts.
        assert!(
            adapter
                .feed(&assistant(
                    "msg_1",
                    json!([{"type": "thinking", "thinking": "private"}]),
                    None
                ))
                .is_empty()
        );
        assert!(
            adapter
                .feed(&assistant(
                    "msg_1",
                    json!([{"type": "text", "text": format!("Looking at {path}")}]),
                    None
                ))
                .is_empty()
        );
        let events = adapter.feed(&assistant("msg_1", json!([{"type": "tool_use", "id": "toolu_1", "name": "Read", "input": {"file_path": path}}]), None));
        assert_eq!(
            events,
            [
                json!({"type": "item.started", "item": {"id": "toolu_1", "type": "mcp_tool_call", "server": "claude-code", "tool": "Read", "status": "in_progress", "engine": "claude-code"}})
            ]
        );
        // A message's text with no tool call after it is no step.
        assert!(
            adapter
                .feed(&assistant(
                    "msg_2",
                    json!([{"type": "text", "text": "Done."}]),
                    None
                ))
                .is_empty()
        );
        // Thinking reached neither the steps nor the run log.
        assert!(
            !serde_json::to_string(&adapter.run_log().events())
                .unwrap()
                .contains("private")
        );
    }

    #[test]
    fn a_subagent_never_drafts_but_its_commentary_and_tools_are_steps() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        let mut delta = stream(
            json!({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Searching"}}),
        );
        delta["parent_tool_use_id"] = json!("toolu_agent");
        assert!(adapter.feed(&delta).is_empty());
        assert!(
            adapter
                .feed(&assistant(
                    "msg_sub",
                    json!([{"type": "text", "text": "Searching for usages."}]),
                    Some("toolu_agent")
                ))
                .is_empty()
        );
        let events = adapter.feed(&assistant("msg_sub", json!([{"type": "tool_use", "id": "toolu_grep", "name": "Grep", "input": {"pattern": "x"}}]), Some("toolu_agent")));
        assert_eq!(
            events,
            [
                json!({"type": "item.completed", "item": {"id": "msg_sub:0", "type": "agent_message", "text": "Searching for usages.", "phase": "commentary"}}),
                json!({"type": "item.started", "item": {"id": "toolu_grep", "type": "mcp_tool_call", "server": "claude-code", "tool": "Grep", "status": "in_progress", "engine": "claude-code"}}),
            ]
        );
    }

    #[test]
    fn tools_map_onto_codex_shaped_steps() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        let inside = |path: &str| format!("{}/{path}", folder.display());

        let started = adapter.feed(&assistant("m1", json!([{"type": "tool_use", "id": "t_bash", "name": "Bash", "input": {"command": "npm test"}}]), None));
        assert_eq!(started[0]["item"]["command"], json!("npm test"));
        let output = format!(
            "ok in {} with sk-ant-api03-SECRET from {HOME}/.npmrc",
            inside("test")
        );
        let done = adapter.feed(&tool_result("t_bash", json!(output), false));
        assert_eq!(
            done,
            [
                json!({"type": "item.completed", "item": {"id": "t_bash", "type": "command_execution", "command": "npm test", "aggregated_output": "ok in test with [redacted] from ~/.npmrc", "exit_code": null, "status": "completed"}})
            ]
        );

        // A Monitor watch is a command step too.
        adapter.feed(&assistant("m1", json!([{"type": "tool_use", "id": "t_mon", "name": "Monitor", "input": {"command": "tail -f log.txt"}}]), None));
        let done = adapter.feed(&tool_result(
            "t_mon",
            json!([{"type": "text", "text": "x".repeat(5_000)}]),
            true,
        ));
        let item = &done[0]["item"];
        assert_eq!(item["status"], json!("failed"));
        let kept = item["aggregated_output"].as_str().unwrap();
        assert!(kept.starts_with("[command output truncated; keeping tail]\n"));
        assert_eq!(kept.chars().count(), MAX_COMMAND_OUTPUT_CHARS);

        // Edits: paths relative to the folder, or outside this space.
        for (id, name, key, path) in [
            ("t_edit", "Edit", "file_path", inside("src/a.ts")),
            ("t_nb", "NotebookEdit", "notebook_path", inside("nb.ipynb")),
            ("t_out", "Write", "file_path", "/etc/hosts".to_string()),
        ] {
            assert!(
                adapter
                    .feed(&assistant(
                        "m2",
                        json!([{"type": "tool_use", "id": id, "name": name, "input": {key: path}}]),
                        None
                    ))
                    .is_empty()
            );
        }
        let edited: Vec<Value> = ["t_edit", "t_nb", "t_out"]
            .iter()
            .flat_map(|id| adapter.feed(&tool_result(id, json!("ok"), *id == "t_out")))
            .map(|event| event["item"].clone())
            .collect();
        assert_eq!(
            edited,
            [
                json!({"id": "t_edit", "type": "file_change", "paths": ["src/a.ts"], "status": "completed"}),
                json!({"id": "t_nb", "type": "file_change", "paths": ["nb.ipynb"], "status": "completed"}),
                json!({"id": "t_out", "type": "file_change", "paths": [OUTSIDE_THIS_SPACE], "status": "failed"}),
            ]
        );

        assert_eq!(
            adapter.feed(&assistant("m3", json!([{"type": "tool_use", "id": "t_s", "name": "WebSearch", "input": {"query": "vitest config"}}]), None)),
            [json!({"type": "item.started", "item": {"id": "t_s", "type": "web_search", "status": "in_progress"}})]
        );
        assert_eq!(
            adapter.feed(&tool_result("t_s", json!("3 results"), false)),
            [
                json!({"type": "item.completed", "item": {"id": "t_s", "type": "web_search", "query": "vitest config", "status": "completed"}})
            ]
        );

        // Every other tool is a tool step, whatever its name.
        for name in [
            "Read",
            "Grep",
            "Glob",
            "WebFetch",
            "Agent",
            "Task",
            "SomeFutureTool",
        ] {
            let id = format!("t_{name}");
            let started = adapter.feed(&assistant(
                "m4",
                json!([{"type": "tool_use", "id": id, "name": name, "input": {}}]),
                None,
            ));
            assert_eq!(started[0]["item"]["type"], json!("mcp_tool_call"), "{name}");
            assert_eq!(started[0]["item"]["server"], json!("claude-code"));
            assert_eq!(started[0]["item"]["tool"], json!(name));
            // The lane's mark, which no Codex item carries.
            assert_eq!(started[0]["item"]["engine"], json!("claude-code"));
            let done = adapter.feed(&tool_result(&id, json!("ok"), false));
            assert_eq!(done[0]["type"], json!("item.completed"));
            assert_eq!(done[0]["item"]["status"], json!("completed"));
            assert_eq!(done[0]["item"]["engine"], json!("claude-code"));
        }
        // A result for no known call, or a second result, makes nothing.
        assert!(
            adapter
                .feed(&tool_result("t_Read", json!("ok"), false))
                .is_empty()
        );
        assert!(
            adapter
                .feed(&tool_result("unknown", json!("ok"), false))
                .is_empty()
        );
    }

    #[test]
    fn the_plan_step_carries_the_whole_list_each_time() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        adapter.feed(&assistant(
            "m",
            json!([{"type": "tool_use", "id": "todo", "name": "TodoWrite", "input": {"todos": [
                {"content": "Read README", "status": "completed", "activeForm": "Reading README"},
                {"content": "Rename", "status": "in_progress", "activeForm": "Renaming"},
            ]}}]),
            None,
        ));
        assert_eq!(
            adapter.feed(&tool_result("todo", json!("ok"), false)),
            [
                json!({"type": "item.updated", "item": {"id": "plan", "type": "todo_list", "items": [
                    {"text": "Read README", "completed": true},
                    {"text": "Rename", "completed": false},
                ]}})
            ]
        );

        let mut lists = Vec::new();
        for (id, name, input, result) in [
            (
                "c1",
                "TaskCreate",
                json!({"subject": "Check links"}),
                json!("Task #1 created successfully: Check links"),
            ),
            (
                "c2",
                "TaskCreate",
                json!({"subject": "Update docs"}),
                json!("Task #2 created successfully: Update docs"),
            ),
            (
                "c3",
                "TaskCreate",
                json!({"description": "Tidy"}),
                json!("created"),
            ),
            (
                "u1",
                "TaskUpdate",
                json!({"taskId": "1", "status": "completed"}),
                json!("Updated task #1 status"),
            ),
            (
                "u2",
                "TaskUpdate",
                json!({"taskId": 2, "subject": "Update the docs"}),
                json!("Updated task #2"),
            ),
            (
                "u3",
                "TaskUpdate",
                json!({"taskId": "3", "status": "deleted"}),
                json!("Deleted task #3"),
            ),
            (
                "u4",
                "TaskUpdate",
                json!({"taskId": "9", "status": "completed"}),
                json!("Task #9 not found"),
            ),
        ] {
            adapter.feed(&assistant(
                "m",
                json!([{"type": "tool_use", "id": id, "name": name, "input": input}]),
                None,
            ));
            let events = adapter.feed(&tool_result(id, result, false));
            assert_eq!(events.len(), 1, "{id}");
            assert_eq!(events[0]["item"]["id"], json!("tasks"));
            lists.push(events[0]["item"]["items"].clone());
        }
        assert_eq!(
            lists[0],
            json!([{"text": "Check links", "completed": false}])
        );
        assert_eq!(lists[2].as_array().unwrap().len(), 3);
        assert_eq!(
            lists[5],
            json!([
                {"text": "Check links", "completed": true},
                {"text": "Update the docs", "completed": false},
            ])
        );
        assert_eq!(lists[6], lists[5]);
        // A task tool that failed changes nothing and sends nothing.
        adapter.feed(&assistant("m", json!([{"type": "tool_use", "id": "c9", "name": "TaskCreate", "input": {"subject": "x"}}]), None));
        assert!(
            adapter
                .feed(&tool_result("c9", json!("error"), true))
                .is_empty()
        );
    }

    /// A top-level `result`, with the API-price estimates and the sign-in's expiry Claude Code
    /// 2.1.325 puts in one (made-up figures).
    fn result(text: &str, is_error: bool) -> Value {
        json!({
            "type": "result",
            "subtype": "success",
            "is_error": is_error,
            "result": text,
            "total_cost_usd": 0.42,
            "modelUsage": {"claude-sonnet-4-5": {"costUSD": 0.42}},
            "model_usage_since_last_result": {"claude-sonnet-4-5": {"inputTokens": 10, "outputTokens": 4, "costUSD": 0.42, "canonicalModel": "claude-sonnet-4-5", "provider": "firstParty", "costBasis": "list"}},
            "credential_expires_at": "2030-01-02T03:04:05.000Z",
            "usage": {"input_tokens": 10, "cache_creation_input_tokens": 2, "cache_read_input_tokens": 30, "output_tokens": 4, "server_tool_use": {"web_search_requests": 1}},
        })
    }

    #[test]
    fn the_latest_top_level_result_gives_the_reply_success_and_usage() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        let mut nested = result("a subagent's", false);
        nested["parent_tool_use_id"] = json!("toolu_agent");
        adapter.feed(&nested);
        assert!(adapter.reply_result().is_none());
        adapter.feed(&result(
            &format!(
                "Renamed {}/README.md. The key sk-ant-oat01-abc stays in {HOME}/.env.",
                folder.display()
            ),
            false,
        ));
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(
            adapter.reply(),
            Some("Renamed README.md. The key [redacted] stays in ~/.env.")
        );
        assert!(adapter.succeeded());
        assert_eq!(
            adapter.usage_artifact(),
            Some(json!({
                "kind": "claude-code/usage",
                "model": "claude-sonnet-4-5",
                "usage": {"input_tokens": 10, "cache_creation_input_tokens": 2, "cache_read_input_tokens": 30, "output_tokens": 4},
            }))
        );
        let log = serde_json::to_string(&adapter.run_log().events()).unwrap();
        for kept_out in ["cost", "0.42", "credential", "2030-01-02", "firstParty"] {
            assert!(!log.contains(kept_out), "{kept_out} in {log}");
        }
        let runtime = Uuid::new_v4();
        assert_eq!(
            adapter.conversation_state(runtime),
            Some(json!({
                "provider": "claude-code",
                "version": 1,
                "sessionId": "5d2a8c4e-1f3b-4c6d-9e7a-0b1c2d3e4f50",
                "runtimeId": runtime.to_string(),
            }))
        );
    }

    #[test]
    fn a_result_while_a_subagent_runs_does_not_end_the_turn() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        adapter.feed(&task(
            "task_started",
            "s1",
            json!({"task_type": "local_agent"}),
        ));
        adapter.feed(&result("A helper is looking.", false));
        assert_eq!(adapter.status(), &AdapterStatus::Running);
        adapter.feed(&task(
            "task_notification",
            "s1",
            json!({"status": "completed"}),
        ));
        adapter.feed(&result("The helper found it.", false));
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(adapter.reply(), Some("The helper found it."));
        assert_eq!(adapter.results(), 2);
    }

    /// A top-level `result` in Claude Code 2.1.325's shape: its `result_index`, its `origin` when
    /// something other than the person's message started its turn, its own `usage`, and
    /// `modelUsage`, a running total nothing may add up. Costs are zero.
    fn turn_result(text: &str, index: u64, origin: Option<Value>, tokens: [u64; 4]) -> Value {
        let [input, cache_creation, cache_read, output] = tokens;
        let mut line = json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "num_turns": 1,
            "result": text,
            "stop_reason": "end_turn",
            "total_cost_usd": 0,
            "usage": {"input_tokens": input, "cache_creation_input_tokens": cache_creation, "cache_read_input_tokens": cache_read, "output_tokens": output, "server_tool_use": {"web_search_requests": 0}},
            "modelUsage": {"claude-sonnet-4-5": {"inputTokens": 9_000, "outputTokens": 9_000, "cacheReadInputTokens": 9_000, "cacheCreationInputTokens": 9_000, "costUSD": 0}},
            "permission_denials": [],
            "result_index": index,
        });
        if let Some(origin) = origin {
            line["origin"] = origin;
        }
        line
    }

    /// The `origin` of a follow-up turn a background task's notification started.
    fn follow_up_of(run: &str) -> Value {
        json!({"kind": "task-notification", "producer": "session-task", "runId": run})
    }

    fn listed(tasks: Value) -> Value {
        json!({"type": "system", "subtype": "background_tasks_changed", "tasks": tasks})
    }

    fn started_in_the_background(id: &str, run: &str, kind: &str) -> Value {
        task(
            "task_started",
            id,
            json!({"run_id": run, "task_type": kind, "is_backgrounded": true}),
        )
    }

    fn ended(id: &str, run: &str) -> Value {
        task(
            "task_notification",
            id,
            json!({"run_id": run, "status": "completed"}),
        )
    }

    fn usage_of(adapter: &EventAdapter) -> Value {
        adapter.usage_artifact().expect("a usage artifact")["usage"].clone()
    }

    /// Claude Code 2.1.325 (Phase 0, item 5): a background subagent that finished before the
    /// turn's `result` was printed makes `claude` run a follow-up turn first, with a second
    /// top-level `init`, and print both turns' `result`s back to back. The turn ends at the
    /// follow-up's, the subagent's answer, which is the reply; the usage is both turns'.
    #[test]
    fn a_subagents_follow_up_turn_that_ran_first_gives_the_reply() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        adapter.feed(&listed(json!([
            {"task_id": "a1", "run_id": "run-a", "task_type": "local_agent", "subagent_type": "general-purpose"},
        ])));
        adapter.feed(&started_in_the_background("a1", "run-a", "local_agent"));
        adapter.feed(&task(
            "task_updated",
            "a1",
            json!({"run_id": "run-a", "patch": {"status": "completed"}}),
        ));
        adapter.feed(&ended("a1", "run-a"));
        adapter.feed(&listed(json!([])));
        adapter.feed(&init(&folder));
        adapter.feed(&turn_result(
            "A helper is working on it.",
            0,
            None,
            [3, 800, 3_000, 150],
        ));
        assert_eq!(
            adapter.status(),
            &AdapterStatus::Running,
            "the follow-up's result is still to come"
        );
        adapter.feed(&turn_result(
            "The helper answered: PONG.",
            1,
            Some(follow_up_of("run-a")),
            [4, 50, 2_000, 12],
        ));
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(adapter.reply(), Some("The helper answered: PONG."));
        assert!(adapter.succeeded());
        assert_eq!((adapter.inits(), adapter.results()), (2, 2));
        // Each result's own usage, summed, and never `modelUsage`.
        assert_eq!(
            usage_of(&adapter),
            json!({"input_tokens": 7, "cache_creation_input_tokens": 850, "cache_read_input_tokens": 5_000, "output_tokens": 162})
        );
    }

    /// The subagent's notification comes before the turn's `result`, and its follow-up `init`
    /// only after it: the task's run id holds the turn until a `result` whose `origin` names it.
    #[test]
    fn a_finished_background_subagent_holds_the_turn_until_its_follow_up_result() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        adapter.feed(&started_in_the_background("a1", "run-a", "local_agent"));
        adapter.feed(&ended("a1", "run-a"));
        assert!(!adapter.background_tasks().keeps_the_turn_open());
        adapter.feed(&turn_result("A helper is on it.", 0, None, [1, 0, 0, 1]));
        assert_eq!(adapter.status(), &AdapterStatus::Running);
        assert!(adapter.background_tasks().awaits_a_follow_up());
        // Another run's follow-up is not its.
        adapter.feed(&init(&folder));
        adapter.feed(&turn_result(
            "Another task ended.",
            1,
            Some(follow_up_of("run-z")),
            [1, 0, 0, 1],
        ));
        assert_eq!(adapter.status(), &AdapterStatus::Running);
        adapter.feed(&init(&folder));
        adapter.feed(&turn_result(
            "The helper found it in parser.ts.",
            2,
            Some(follow_up_of("run-a")),
            [1, 0, 0, 1],
        ));
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(adapter.reply(), Some("The helper found it in parser.ts."));
        assert_eq!(adapter.results(), 3);
    }

    /// A background command's follow-up turn only says the command ended (3.6). In Phase 0's
    /// bash-wait order it comes after the turn's `result`, which ends the turn. When it ran
    /// first, the turn reads on to its `result`, whose usage counts, but the reply stays the
    /// turn's own.
    #[test]
    fn a_background_commands_follow_up_never_gives_the_reply() {
        {
            let (_temp, folder, mut adapter) = adapter();
            adapter.feed(&init(&folder));
            // A command in the foreground, then one in the background that still runs.
            adapter.feed(&task(
                "task_started",
                "b1",
                json!({"run_id": "run-b1", "task_type": "local_bash", "is_backgrounded": false}),
            ));
            adapter.feed(&ended("b1", "run-b1"));
            adapter.feed(&listed(json!([
                {"task_id": "b2", "run_id": "run-b2", "task_type": "local_bash"},
            ])));
            adapter.feed(&started_in_the_background("b2", "run-b2", "local_bash"));
            adapter.feed(&turn_result("STARTED", 0, None, [6, 0, 0, 20]));
            assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
            assert_eq!(adapter.reply(), Some("STARTED"));
            assert_eq!(adapter.results(), 1);
        }
        {
            let (_temp, folder, mut adapter) = adapter();
            adapter.feed(&init(&folder));
            adapter.feed(&started_in_the_background("b3", "run-b3", "local_bash"));
            adapter.feed(&ended("b3", "run-b3"));
            adapter.feed(&init(&folder));
            adapter.feed(&turn_result(
                "The build runs in the background.",
                0,
                None,
                [2, 100, 1_000, 50],
            ));
            assert_eq!(adapter.status(), &AdapterStatus::Running);
            adapter.feed(&turn_result(
                "The background build finished with exit code 0.",
                1,
                Some(follow_up_of("run-b3")),
                [3, 20, 900, 30],
            ));
            assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
            assert_eq!(adapter.reply(), Some("The build runs in the background."));
            assert!(adapter.succeeded());
            assert_eq!(
                usage_of(&adapter),
                json!({"input_tokens": 5, "cache_creation_input_tokens": 120, "cache_read_input_tokens": 1_900, "output_tokens": 80})
            );
        }
    }

    /// A subagent and a background command that both ended before the turn's `result`: the turn
    /// ends at the last follow-up's `result`, and the reply is the subagent's follow-up, never
    /// the command's.
    #[test]
    fn with_a_subagent_and_a_command_the_reply_is_the_subagents_follow_up() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        adapter.feed(&started_in_the_background("a1", "run-a", "local_agent"));
        adapter.feed(&started_in_the_background("b1", "run-b", "local_bash"));
        adapter.feed(&ended("a1", "run-a"));
        adapter.feed(&init(&folder));
        adapter.feed(&ended("b1", "run-b"));
        adapter.feed(&init(&folder));
        for (index, text, origin) in [
            (0, "Both are running.", None),
            (
                1,
                "The helper found it in parser.ts.",
                Some(follow_up_of("run-a")),
            ),
        ] {
            adapter.feed(&turn_result(text, index, origin, [1, 0, 0, 1]));
            assert_eq!(adapter.status(), &AdapterStatus::Running, "{text}");
        }
        adapter.feed(&turn_result(
            "The background command finished.",
            2,
            Some(follow_up_of("run-b")),
            [1, 0, 0, 1],
        ));
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(adapter.reply(), Some("The helper found it in parser.ts."));
        assert_eq!(adapter.results(), 3);
    }

    /// A turn a peer message started, which another program can queue through the messaging
    /// socket every `init` names, closes its own `init` but never gives the reply or success, and
    /// nor does a turn whose `origin` this adapter does not know. Nor does such a `result` end the
    /// turn before the person's own `result`, which has no `origin`, was read.
    #[test]
    fn a_peer_messages_turn_never_gives_the_reply() {
        let only = |origin: Value| {
            let (_temp, folder, mut adapter) = adapter();
            adapter.feed(&init(&folder));
            adapter.feed(&turn_result(
                "Not the person's.",
                0,
                Some(origin),
                [1, 0, 0, 1],
            ));
            (
                adapter.status().clone(),
                adapter.reply().map(str::to_string),
                adapter.succeeded(),
            )
        };
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        adapter.feed(&init(&folder));
        adapter.feed(&turn_result("Renamed the project.", 0, None, [1, 0, 0, 1]));
        assert_eq!(adapter.status(), &AdapterStatus::Running);
        adapter.feed(&turn_result(
            "Hello from another session.",
            1,
            Some(json!({"kind": "peer", "from": "unknown", "selfSent": false})),
            [2, 0, 0, 2],
        ));
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(adapter.reply(), Some("Renamed the project."));
        assert!(adapter.succeeded());
        assert_eq!(usage_of(&adapter)["output_tokens"], json!(3));

        for origin in [
            json!({"kind": "peer"}),
            json!({"kind": "channel"}),
            json!({}),
            json!("person"),
        ] {
            assert_eq!(
                only(origin.clone()),
                (AdapterStatus::Running, None, false),
                "{origin}"
            );
        }
        // An `origin` of `null` is none.
        assert_eq!(
            only(Value::Null),
            (
                AdapterStatus::EndOfTurn,
                Some("Not the person's.".to_string()),
                true
            )
        );
    }

    /// Only a task the turn started in the background waits for its follow-up turn: a task that
    /// said it runs in the foreground starts none, nor does an ambient task or a background
    /// command. One that did not say where it runs or what it is waits. A task with no run id,
    /// the shape of the fixtures written before Phase 0, keeps the turn open only while it is
    /// live.
    #[test]
    fn only_a_task_started_in_the_background_waits_for_its_follow_up() {
        let mut tasks = BackgroundTasks::default();
        tasks.observe(&task(
            "task_started",
            "f1",
            json!({"run_id": "run-f", "task_type": "local_agent", "is_backgrounded": false}),
        ));
        tasks.observe(&ended("f1", "run-f"));
        tasks.observe(&task(
            "task_started",
            "x1",
            json!({"run_id": "run-x1", "task_type": "ambient"}),
        ));
        tasks.observe(&task(
            "task_started",
            "x2",
            json!({"run_id": "run-x2", "task_type": "local_agent", "ambient": true}),
        ));
        tasks.observe(&started_in_the_background("c1", "run-c", "local_bash"));
        assert!(!tasks.awaits_a_follow_up());
        assert!(!tasks.keeps_the_turn_open());
        assert!(tasks.is_a_background_command("run-c"));
        assert!(!tasks.is_a_background_command("run-f"));
        assert!(!tasks.is_a_background_command("run-unknown"));

        tasks.observe(&task(
            "task_started",
            "o1",
            json!({"task_type": "local_agent"}),
        ));
        tasks.observe(&task(
            "task_notification",
            "o1",
            json!({"status": "completed"}),
        ));
        assert!(!tasks.awaits_a_follow_up());

        tasks.observe(&task("task_started", "u1", json!({"run_id": "run-u"})));
        assert!(tasks.awaits_a_follow_up());
        tasks.followed_up("run-u");
        assert!(!tasks.awaits_a_follow_up());

        // A background list names it: it runs in the background, whatever its start said.
        tasks.observe(&listed(json!([
            {"task_id": "w1", "run_id": "run-w", "task_type": "local_workflow"},
        ])));
        tasks.observe(&task(
            "task_started",
            "w1",
            json!({"run_id": "run-w", "task_type": "local_workflow", "is_backgrounded": false}),
        ));
        assert!(tasks.awaits_a_follow_up());
    }

    /// The tasks the runtime's follow-up wait waits for are those that await their follow-up turn
    /// (3.6): a task in the background that is no background command, from the list or the
    /// start that first names it, until a `result` follows it up. A task in the foreground, a
    /// background command's start, end and follow-up, a Monitor watch's event turn, a peer
    /// message's turn and the follow-up of a run the turn never started change nothing.
    #[test]
    fn the_awaited_runs_are_the_tasks_that_await_their_follow_up() {
        let (_temp, folder, mut adapter) = adapter();
        let expect = |adapter: &mut EventAdapter, line: Value, awaited: &[&str]| {
            adapter.feed(&line);
            assert_eq!(
                adapter.background_tasks().awaited_runs(),
                awaited.to_vec(),
                "{line}"
            );
            for run in ["run-a", "run-b", "run-f", "run-z"] {
                assert_eq!(
                    adapter.background_tasks().awaits_the_follow_up_of(run),
                    awaited.contains(&run),
                    "{run} after {line}"
                );
            }
        };
        let a1 = json!({"task_id": "a1", "run_id": "run-a", "task_type": "local_agent"});
        let b1 = json!({"task_id": "b1", "run_id": "run-b", "task_type": "local_bash"});
        expect(&mut adapter, init(&folder), &[]);
        expect(
            &mut adapter,
            started_in_the_background("b1", "run-b", "local_bash"),
            &[],
        );
        expect(
            &mut adapter,
            task(
                "task_started",
                "f1",
                json!({"run_id": "run-f", "task_type": "local_agent", "is_backgrounded": false}),
            ),
            &[],
        );
        expect(&mut adapter, ended("f1", "run-f"), &[]);
        expect(&mut adapter, listed(json!([a1.clone()])), &["run-a"]);
        expect(
            &mut adapter,
            started_in_the_background("a1", "run-a", "local_agent"),
            &["run-a"],
        );
        expect(&mut adapter, listed(json!([a1, b1])), &["run-a"]);
        expect(&mut adapter, ended("b1", "run-b"), &["run-a"]);
        expect(&mut adapter, ended("a1", "run-a"), &["run-a"]);
        expect(
            &mut adapter,
            turn_result("A helper is on it.", 0, None, [1, 0, 0, 1]),
            &["run-a"],
        );
        for origin in [
            json!({"kind": "task-notification", "producer": "session-task"}),
            follow_up_of("run-b"),
            follow_up_of("run-f"),
            follow_up_of("run-z"),
            json!({"kind": "peer"}),
        ] {
            expect(&mut adapter, init(&folder), &["run-a"]);
            expect(
                &mut adapter,
                turn_result("Another turn.", 1, Some(origin), [1, 0, 0, 1]),
                &["run-a"],
            );
        }
        assert_eq!(adapter.status(), &AdapterStatus::Running);
        expect(&mut adapter, init(&folder), &["run-a"]);
        expect(
            &mut adapter,
            turn_result(
                "The helper found it.",
                2,
                Some(follow_up_of("run-a")),
                [1, 0, 0, 1],
            ),
            &[],
        );
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(adapter.reply(), Some("The helper found it."));
    }

    /// A task a subagent started (`parent_task_id`, or `owned_by_subagent: true`, on its
    /// `task_started` or in a task list) is awaited as any other: by a reading of Claude Code
    /// 2.1.325's code, under `-p` a background subagent or workflow that a subagent started
    /// notifies that subagent only while it runs, and otherwise the main conversation, whose
    /// follow-up turn names the task's run (a command or Monitor watch it started always notifies
    /// that subagent, and is awaited by no one). Here a subagent in the
    /// foreground started one in the background and returned before it ended: the turn ends at
    /// that task's follow-up, which gives the reply.
    #[test]
    fn a_task_a_subagent_started_is_awaited_until_its_follow_up() {
        let mut tasks = BackgroundTasks::default();
        tasks.observe(&task(
            "task_started",
            "n1",
            json!({"run_id": "run-n1", "task_type": "local_agent", "is_backgrounded": true, "parent_task_id": "a1"}),
        ));
        tasks.observe(&task(
            "task_started",
            "n2",
            json!({"run_id": "run-n2", "task_type": "local_agent", "is_backgrounded": true, "owned_by_subagent": true}),
        ));
        tasks.observe(&listed(json!([
            {"task_id": "n3", "run_id": "run-n3", "task_type": "local_workflow", "parent_task_id": "a1"},
        ])));
        for id in ["n1", "n2", "n3"] {
            tasks.observe(&ended(id, &format!("run-{id}")));
        }
        assert_eq!(tasks.awaiting(), 3);
        assert!(tasks.awaits_only_ended_follow_ups());
        for id in ["n1", "n2", "n3"] {
            tasks.followed_up(&format!("run-{id}"));
        }
        assert!(!tasks.awaits_a_follow_up());

        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        adapter.feed(&assistant(
            "m1",
            json!([{"type": "tool_use", "id": "t_agent", "name": "Agent", "input": {"prompt": "Check the parser; start a helper for the tests."}}]),
            None,
        ));
        adapter.feed(&task(
            "task_started",
            "a1",
            json!({"run_id": "run-a", "task_type": "local_agent", "is_backgrounded": false}),
        ));
        adapter.feed(&task(
            "task_started",
            "n1",
            json!({"run_id": "run-n", "task_type": "local_agent", "is_backgrounded": true, "owned_by_subagent": true, "parent_task_id": "a1"}),
        ));
        adapter.feed(&ended("a1", "run-a"));
        adapter.feed(&tool_result(
            "t_agent",
            json!("Parser checked; a helper is running the tests."),
            false,
        ));
        adapter.feed(&stream(
            json!({"type": "message_start", "message": {"id": "m2"}}),
        ));
        adapter.feed(&ended("n1", "run-n"));
        adapter.feed(&turn_result(
            "The parser looks fine; a helper is still running the tests.",
            0,
            None,
            [1, 0, 0, 1],
        ));
        assert_eq!(adapter.status(), &AdapterStatus::Running);
        assert!(adapter.waits_only_for_a_follow_up());
        adapter.feed(&init(&folder));
        adapter.feed(&turn_result(
            "The helper reports two failing tests in parser.ts.",
            1,
            Some(follow_up_of("run-n")),
            [1, 0, 0, 1],
        ));
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(
            adapter.reply(),
            Some("The helper reports two failing tests in parser.ts.")
        );
    }

    /// A subagent's task whose notification went to that subagent, while it still ran, has no
    /// follow-up turn of the main conversation's: once it ended and nothing else holds the turn,
    /// the turn waits only for that follow-up, and ends after the grace at the `result`s read.
    #[test]
    fn a_subagents_task_whose_follow_up_never_comes_is_waited_for_only_a_grace() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        adapter.feed(&started_in_the_background("a1", "run-a", "local_agent"));
        adapter.feed(&task(
            "task_started",
            "n1",
            json!({"run_id": "run-n", "task_type": "local_agent", "is_backgrounded": true, "parent_task_id": "a1"}),
        ));
        adapter.feed(&ended("n1", "run-n"));
        adapter.feed(&ended("a1", "run-a"));
        adapter.feed(&init(&folder));
        adapter.feed(&turn_result("A helper is on it.", 0, None, [1, 0, 0, 1]));
        assert_eq!(adapter.status(), &AdapterStatus::Running);
        assert!(
            !adapter.waits_only_for_a_follow_up(),
            "the follow-up turn that started has yet to end"
        );
        adapter.feed(&turn_result(
            "The helpers found it in parser.ts.",
            1,
            Some(follow_up_of("run-a")),
            [1, 0, 0, 1],
        ));
        assert_eq!(
            adapter.status(),
            &AdapterStatus::Running,
            "the helper's own follow-up may still come"
        );
        assert!(adapter.waits_only_for_a_follow_up());
        assert!(adapter.end_without_follow_up(
            std::time::Duration::from_secs(15),
            2,
            FollowUpWaitEnd::RanOut
        ));
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(adapter.reply(), Some("The helpers found it in parser.ts."));
        assert!(adapter.succeeded());
        let ended_without = adapter
            .run_log()
            .events()
            .into_iter()
            .find(|event| event["type"] == "instafy.ended_without_follow_up")
            .expect("the run log says the turn ended without a follow-up");
        assert_eq!(
            ended_without,
            json!({"type": "instafy.ended_without_follow_up", "runs": 1, "grace_ms": 15_000, "restarts": 2, "claude_exited": false})
        );
    }

    /// A task that ended without a follow-up turn stays awaited, however the lines around its
    /// notification read: here the main conversation ran a tool step after it and went on to its
    /// next model request, which may have folded the notification in (Claude Code 2.1.325 prints
    /// nothing of its own when it does). Once the turn waits only for that follow-up, the
    /// runtime's follow-up wait ends it at the `result`s read, as a success. A follow-up `init`
    /// takes the turn out of that wait, and nothing ends it while a task may still run.
    #[test]
    fn a_follow_up_that_never_comes_ends_the_turn_after_the_grace() {
        let grace = std::time::Duration::from_secs(15);
        let waiting = || {
            let (temp, folder, mut adapter) = adapter();
            adapter.feed(&init(&folder));
            adapter.feed(&started_in_the_background("a1", "run-a", "local_agent"));
            adapter.feed(&started_in_the_background("b1", "run-b", "local_bash"));
            adapter.feed(&assistant(
                "m1",
                json!([{"type": "tool_use", "id": "t_read", "name": "Read", "input": {"file_path": "README.md"}}]),
                None,
            ));
            adapter.feed(&ended("a1", "run-a"));
            adapter.feed(&tool_result("t_read", json!("# Demo"), false));
            adapter.feed(&stream(
                json!({"type": "message_start", "message": {"id": "m2"}}),
            ));
            assert!(adapter.background_tasks().awaits_a_follow_up());
            adapter.feed(&turn_result(
                "The dev server runs, and the helper found the bug.",
                0,
                None,
                [1, 0, 0, 1],
            ));
            assert_eq!(adapter.status(), &AdapterStatus::Running);
            assert!(adapter.waits_only_for_a_follow_up());
            (temp, folder, adapter)
        };

        let (_temp, _folder, mut never) = waiting();
        assert!(never.end_without_follow_up(grace, 0, FollowUpWaitEnd::RanOut));
        assert_eq!(never.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(
            never.reply(),
            Some("The dev server runs, and the helper found the bug.")
        );
        assert!(never.succeeded());
        let log = serde_json::to_string(&never.run_log().events()).unwrap();
        assert!(
            log.contains(r#""type":"instafy.ended_without_follow_up""#),
            "{log}"
        );

        // A follow-up that starts within the grace is read to its `result`, which is the reply.
        let (_temp, folder, mut late) = waiting();
        late.feed(&init(&folder));
        assert!(!late.waits_only_for_a_follow_up());
        assert!(!late.end_without_follow_up(grace, 0, FollowUpWaitEnd::RanOut));
        assert_eq!(late.status(), &AdapterStatus::Running);
        late.feed(&turn_result(
            "The helper found the bug in parser.ts.",
            1,
            Some(follow_up_of("run-a")),
            [1, 0, 0, 1],
        ));
        assert_eq!(late.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(late.reply(), Some("The helper found the bug in parser.ts."));

        // Never while a task that may still run is live, or one that awaits its follow-up never
        // said it ended.
        let (_temp, folder, mut live) = adapter();
        live.feed(&init(&folder));
        live.feed(&started_in_the_background("a1", "run-a", "local_agent"));
        live.feed(&turn_result("A helper is on it.", 0, None, [1, 0, 0, 1]));
        assert!(!live.waits_only_for_a_follow_up());
        assert!(!live.end_without_follow_up(grace, 0, FollowUpWaitEnd::RanOut));
        let (_temp, folder, mut unknown) = adapter();
        unknown.feed(&init(&folder));
        unknown.feed(&json!({"type": "system", "subtype": "task_started", "run_id": "run-u", "task_type": "local_agent", "is_backgrounded": true}));
        unknown.feed(&turn_result("A helper is on it.", 0, None, [1, 0, 0, 1]));
        assert!(unknown.background_tasks().awaits_a_follow_up());
        assert!(!unknown.waits_only_for_a_follow_up());
        // Nor when nothing awaits a follow-up: that `result` ended the turn already.
        let (_temp, folder, mut done) = adapter();
        done.feed(&init(&folder));
        done.feed(&turn_result("Done.", 0, None, [1, 0, 0, 1]));
        assert_eq!(done.status(), &AdapterStatus::EndOfTurn);
        assert!(!done.waits_only_for_a_follow_up());
    }

    /// A Monitor watch's event runs a turn whose `origin` is a `task-notification` that names no
    /// run (by a reading of Claude Code 2.1.325's code). Once the turn's task events name run ids,
    /// such a turn's `result` never gives the reply, though it counts toward the tally, the usage
    /// and the denials. While no task event names one, as in the fixtures written before Phase
    /// 0, a follow-up names no run either, and such a `result` can be the reply.
    #[test]
    fn a_monitor_events_turn_never_gives_the_reply_once_task_events_name_run_ids() {
        let event_origin = json!({"kind": "task-notification", "producer": "session-task"});
        let (_temp, folder, mut watched) = adapter();
        watched.feed(&init(&folder));
        watched.feed(&started_in_the_background("m1", "run-m", "local_bash"));
        // The event's turn ran first, and its `result` came after the person's.
        watched.feed(&init(&folder));
        watched.feed(&turn_result(
            "The dev server is up, and I'm watching its log.",
            0,
            None,
            [1, 0, 0, 1],
        ));
        assert_eq!(watched.status(), &AdapterStatus::Running);
        let mut event = turn_result(
            "The log shows another request.",
            1,
            Some(event_origin.clone()),
            [2, 0, 0, 2],
        );
        event["permission_denials"] = json!([{"tool_name": "Bash", "tool_use_id": "toolu_m"}]);
        watched.feed(&event);
        assert_eq!(watched.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(
            watched.reply(),
            Some("The dev server is up, and I'm watching its log.")
        );
        assert!(watched.succeeded());
        assert_eq!(watched.results(), 2);
        assert_eq!(usage_of(&watched)["output_tokens"], json!(3));
        assert_eq!(watched.permission_denials(), ["Bash"]);

        // No task event named a run id: such a follow-up can still be the reply. Here it ran
        // before the person's `result` was printed, as in Phase 0's background-agent order.
        let (_temp, folder, mut older) = adapter();
        older.feed(&init(&folder));
        older.feed(&task(
            "task_started",
            "s1",
            json!({"task_type": "local_agent"}),
        ));
        older.feed(&task(
            "task_notification",
            "s1",
            json!({"status": "completed"}),
        ));
        older.feed(&init(&folder));
        older.feed(&turn_result("A helper is on it.", 0, None, [1, 0, 0, 1]));
        assert_eq!(older.status(), &AdapterStatus::Running);
        older.feed(&turn_result(
            "The helper found it.",
            1,
            Some(event_origin),
            [1, 0, 0, 1],
        ));
        assert_eq!(older.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(older.reply(), Some("The helper found it."));
    }

    /// A held turn's `result` in Claude Code 2.1.325's shape, by a reading of its code: its
    /// `origin` names the notification the turn took, no model request ran (`num_turns` 0), and
    /// its `result` is empty.
    fn held_result(index: u64, origin: Value) -> Value {
        let mut line = turn_result("", index, Some(origin), [0, 0, 0, 0]);
        line["num_turns"] = json!(0);
        line["duration_api_ms"] = json!(0);
        line["stop_reason"] = Value::Null;
        line
    }

    /// The person's subagent and a background command end together, and 2.1.325 runs the
    /// subagent's notification as a turn held for the command's (3.6). The held turn's `result`
    /// is never the reply, and the subagent awaits its follow-up until the command's follow-up
    /// turn, which answers both. That `result` ends the turn and gives the reply, though a
    /// background command's follow-up alone never would: the held one could have. Both count
    /// toward the tally, the usage and the denials.
    #[test]
    fn the_turn_after_a_held_one_answers_its_notification_and_can_give_the_reply() {
        let (_temp, folder, mut coalesced) = adapter();
        coalesced.feed(&init(&folder));
        coalesced.feed(&started_in_the_background("a1", "run-a", "local_agent"));
        coalesced.feed(&started_in_the_background("b1", "run-b", "local_bash"));
        coalesced.feed(&ended("a1", "run-a"));
        coalesced.feed(&ended("b1", "run-b"));
        coalesced.feed(&init(&folder));
        coalesced.feed(&turn_result(
            "A helper is fixing the parser, and the tests run.",
            0,
            None,
            [1, 0, 0, 1],
        ));
        let mut held = held_result(1, follow_up_of("run-a"));
        held["permission_denials"] = json!([{"tool_name": "Bash", "tool_use_id": "toolu_h"}]);
        coalesced.feed(&held);
        assert_eq!(coalesced.status(), &AdapterStatus::Running);
        assert_eq!(
            coalesced.reply(),
            Some("A helper is fixing the parser, and the tests run.")
        );
        assert_eq!(coalesced.background_tasks().awaited_runs(), ["run-a"]);
        assert!(coalesced.waits_only_for_a_follow_up());
        coalesced.feed(&init(&folder));
        coalesced.feed(&turn_result(
            "The helper fixed the parser, and the tests pass.",
            2,
            Some(follow_up_of("run-b")),
            [2, 0, 0, 2],
        ));
        assert_eq!(coalesced.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(
            coalesced.reply(),
            Some("The helper fixed the parser, and the tests pass.")
        );
        assert!(coalesced.succeeded());
        assert!(coalesced.background_tasks().awaited_runs().is_empty());
        assert_eq!((coalesced.inits(), coalesced.results()), (3, 3));
        assert_eq!(usage_of(&coalesced)["output_tokens"], json!(3));
        assert_eq!(coalesced.permission_denials(), ["Bash"]);

        // The same without the hold: a background command's follow-up never gives the reply.
        let (_temp, folder, mut plain) = adapter();
        plain.feed(&init(&folder));
        plain.feed(&started_in_the_background("b1", "run-b", "local_bash"));
        plain.feed(&ended("b1", "run-b"));
        plain.feed(&init(&folder));
        plain.feed(&turn_result("The tests run.", 0, None, [1, 0, 0, 1]));
        plain.feed(&turn_result(
            "The tests pass.",
            1,
            Some(follow_up_of("run-b")),
            [1, 0, 0, 1],
        ));
        assert_eq!(plain.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(plain.reply(), Some("The tests run."));
    }

    /// Several turns can be held in a row, each for the next (3.6): every run they named awaits
    /// its follow-up until the next `result` that is not held, which follows them all up, and
    /// gives the reply when any held one could have. Held turns that named only a background
    /// command's run, or no run once task events name run ids, could not have: a command's
    /// follow-up after them leaves the reply as it was.
    #[test]
    fn held_turns_in_a_row_are_all_answered_by_the_next_turn() {
        let (_temp, folder, mut in_a_row) = adapter();
        in_a_row.feed(&init(&folder));
        for (id, run, kind) in [
            ("a1", "run-a", "local_agent"),
            ("a2", "run-a2", "local_agent"),
            ("b1", "run-b", "local_bash"),
        ] {
            in_a_row.feed(&started_in_the_background(id, run, kind));
        }
        in_a_row.feed(&turn_result(
            "Two helpers are on it, and the tests run.",
            0,
            None,
            [1, 0, 0, 1],
        ));
        for (id, run) in [("a1", "run-a"), ("a2", "run-a2"), ("b1", "run-b")] {
            in_a_row.feed(&ended(id, run));
        }
        for (index, run) in [(1, "run-a"), (2, "run-a2")] {
            in_a_row.feed(&init(&folder));
            in_a_row.feed(&held_result(index, follow_up_of(run)));
            assert_eq!(in_a_row.status(), &AdapterStatus::Running, "{run}");
            assert_eq!(
                in_a_row.reply(),
                Some("Two helpers are on it, and the tests run."),
                "{run}"
            );
        }
        assert_eq!(
            in_a_row.background_tasks().awaited_runs(),
            ["run-a", "run-a2"]
        );
        in_a_row.feed(&init(&folder));
        in_a_row.feed(&turn_result(
            "Both helpers are done, and the tests pass.",
            3,
            Some(follow_up_of("run-b")),
            [1, 0, 0, 1],
        ));
        assert_eq!(in_a_row.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(
            in_a_row.reply(),
            Some("Both helpers are done, and the tests pass.")
        );
        assert!(in_a_row.background_tasks().awaited_runs().is_empty());

        // Held for a command's notification and for one that names no run, while the person's
        // subagent still runs.
        let (_temp, folder, mut commands) = adapter();
        commands.feed(&init(&folder));
        for (id, run, kind) in [
            ("a1", "run-a", "local_agent"),
            ("b1", "run-b", "local_bash"),
            ("b2", "run-b2", "local_bash"),
        ] {
            commands.feed(&started_in_the_background(id, run, kind));
        }
        commands.feed(&turn_result(
            "A helper is on it, and two builds run.",
            0,
            None,
            [1, 0, 0, 1],
        ));
        commands.feed(&ended("b1", "run-b"));
        commands.feed(&ended("b2", "run-b2"));
        for (index, origin) in [
            (1, follow_up_of("run-b")),
            (
                2,
                json!({"kind": "task-notification", "producer": "session-task"}),
            ),
        ] {
            commands.feed(&init(&folder));
            commands.feed(&held_result(index, origin));
        }
        commands.feed(&init(&folder));
        commands.feed(&turn_result(
            "Both builds passed.",
            3,
            Some(follow_up_of("run-b2")),
            [1, 0, 0, 1],
        ));
        assert_eq!(commands.status(), &AdapterStatus::Running);
        assert_eq!(
            commands.reply(),
            Some("A helper is on it, and two builds run.")
        );
        commands.feed(&ended("a1", "run-a"));
        commands.feed(&init(&folder));
        commands.feed(&turn_result(
            "The helper found the bug.",
            4,
            Some(follow_up_of("run-a")),
            [1, 0, 0, 1],
        ));
        assert_eq!(commands.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(commands.reply(), Some("The helper found the bug."));
    }

    /// A held turn's `result` with nothing else awaited does not end the turn: the run it names
    /// awaits the turn that answers its notification, here one with no `origin` that 2.1.325
    /// owes the held notification when the one queued behind it does not run next (3.6). That
    /// turn's `result` follows the run up, ends the turn and gives the reply. Should none come,
    /// the follow-up wait ends the turn with the reply it had, never the held turn's.
    #[test]
    fn a_held_turn_with_nothing_else_awaited_does_not_end_the_turn() {
        let held = || {
            let (temp, folder, mut adapter) = adapter();
            adapter.feed(&init(&folder));
            adapter.feed(&started_in_the_background("a1", "run-a", "local_agent"));
            adapter.feed(&started_in_the_background("b1", "run-b", "local_bash"));
            adapter.feed(&ended("a1", "run-a"));
            adapter.feed(&ended("b1", "run-b"));
            adapter.feed(&init(&folder));
            adapter.feed(&turn_result("A helper is on it.", 0, None, [1, 0, 0, 1]));
            adapter.feed(&held_result(1, follow_up_of("run-a")));
            assert_eq!(adapter.status(), &AdapterStatus::Running);
            assert_eq!((adapter.inits(), adapter.results()), (2, 2));
            assert!(adapter.background_tasks().awaits_the_follow_up_of("run-a"));
            assert!(adapter.waits_only_for_a_follow_up());
            (temp, folder, adapter)
        };

        let (_temp, folder, mut owed) = held();
        owed.feed(&init(&folder));
        assert!(!owed.waits_only_for_a_follow_up());
        owed.feed(&turn_result(
            "The helper found the bug in parser.ts.",
            2,
            None,
            [1, 0, 0, 1],
        ));
        assert_eq!(owed.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(owed.reply(), Some("The helper found the bug in parser.ts."));
        assert!(!owed.background_tasks().awaits_the_follow_up_of("run-a"));

        let (_temp, _folder, mut never) = held();
        assert!(never.end_without_follow_up(
            std::time::Duration::from_secs(15),
            0,
            FollowUpWaitEnd::RanOut
        ));
        assert_eq!(never.reply(), Some("A helper is on it."));
        assert!(never.succeeded());

        // A `result` that is not held: one with text, one that ran a model request, or one that
        // failed, follows its run up and can be the reply, as any follow-up.
        for (text, turns, is_error) in [
            ("The helper found it.", 0, false),
            ("", 1, false),
            ("", 0, true),
        ] {
            let (_temp, folder, mut plain) = adapter();
            plain.feed(&init(&folder));
            plain.feed(&started_in_the_background("a1", "run-a", "local_agent"));
            plain.feed(&ended("a1", "run-a"));
            plain.feed(&init(&folder));
            plain.feed(&turn_result("A helper is on it.", 0, None, [1, 0, 0, 1]));
            let mut line = held_result(1, follow_up_of("run-a"));
            line["result"] = json!(text);
            line["num_turns"] = json!(turns);
            line["is_error"] = json!(is_error);
            plain.feed(&line);
            assert_eq!(plain.status(), &AdapterStatus::EndOfTurn, "{line}");
            assert_eq!(plain.reply(), Some(text), "{line}");
            assert_eq!(plain.succeeded(), !is_error, "{line}");
        }
    }

    /// On a resumed session, by a reading of 2.1.325's code, Claude Code runs a turn with no model
    /// request for each background task of an earlier turn that left no record of its end, before
    /// the person's own turn (3.6). Each prints a held turn's `result` whose `origin` names no run.
    /// Nothing ends the turn, or starts the follow-up wait, before the person's `result`, which
    /// has no `origin` and gives the reply.
    #[test]
    fn notices_before_the_persons_turn_never_end_it() {
        let notice = || held_result(0, json!({"kind": "task-notification"}));
        let (_temp, folder, mut resumed) = adapter();
        for index in 0..2 {
            resumed.feed(&init(&folder));
            let mut line = notice();
            line["result_index"] = json!(index);
            resumed.feed(&line);
            assert_eq!(resumed.status(), &AdapterStatus::Running);
            assert!(!resumed.waits_only_for_a_follow_up());
            assert!(!resumed.end_without_follow_up(
                std::time::Duration::from_secs(15),
                0,
                FollowUpWaitEnd::ClaudeExited
            ));
        }
        assert_eq!(resumed.reply(), None);
        resumed.feed(&init(&folder));
        resumed.feed(&turn_result("The homepage loads.", 2, None, [1, 0, 0, 1]));
        assert_eq!(resumed.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(resumed.reply(), Some("The homepage loads."));
        assert!(resumed.succeeded());
        assert_eq!((resumed.inits(), resumed.results()), (3, 3));

        // A `result` with no `origin` before any `init`, a resume miss's, still ends the turn.
        let (_temp, _folder, mut missed) = adapter();
        let mut miss = turn_result("No conversation found.", 0, None, [0, 0, 0, 0]);
        miss["is_error"] = json!(true);
        missed.feed(&miss);
        assert_eq!(missed.status(), &AdapterStatus::EndOfTurn);
    }

    /// A held turn's `result` that nothing answers, while Claude Code reported a refused request
    /// for the plan's limit, fails the turn as `plan_limit` (3.6): by a reading of 2.1.325's code,
    /// a subagent's notification that only repeats a usage limit already reached runs as such a
    /// turn. Without the refusal, or once a later `result` answered it, it fails nothing.
    #[test]
    fn a_held_turn_that_nothing_answers_after_a_refusal_fails_as_plan_limit() {
        let limited = |refused: bool| {
            let (temp, folder, mut adapter) = adapter();
            adapter.feed(&init(&folder));
            adapter.feed(&started_in_the_background("a1", "run-a", "local_agent"));
            if refused {
                adapter.feed(&json!({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": 1900000000}}));
            }
            adapter.feed(&task(
                "task_notification",
                "a1",
                json!({"run_id": "run-a", "status": "failed"}),
            ));
            adapter.feed(&init(&folder));
            adapter.feed(&turn_result("A helper is on it.", 0, None, [1, 0, 0, 1]));
            adapter.feed(&held_result(1, follow_up_of("run-a")));
            assert_eq!(adapter.held_run(), Some("run-a"));
            assert!(adapter.waits_only_for_a_follow_up());
            (temp, folder, adapter)
        };

        let (_temp, _folder, mut repeat) = limited(true);
        assert!(repeat.end_without_follow_up(
            std::time::Duration::from_secs(15),
            0,
            FollowUpWaitEnd::ClaudeExited
        ));
        assert_eq!(repeat.reply(), Some("A helper is on it."));
        assert!(!repeat.succeeded());
        let failure = repeat.classify_failure(&ExitFacts {
            resumed: false,
            exit_code: Some(0),
            signal: None,
            exited_ok: true,
            stderr: "",
        });
        assert_eq!(failure.code, Some(FailureCode::PlanLimit));
        assert_eq!(failure.resets_at, Some(1_900_000_000));

        let (_temp, _folder, mut plain) = limited(false);
        assert!(plain.end_without_follow_up(
            std::time::Duration::from_secs(15),
            0,
            FollowUpWaitEnd::RanOut
        ));
        assert!(plain.succeeded());

        // Answered by the next turn, which then gives the reply: its own `result` decides.
        let (_temp, folder, mut answered) = limited(true);
        answered.feed(&init(&folder));
        answered.feed(&turn_result("The helper finished.", 2, None, [1, 0, 0, 1]));
        assert_eq!(answered.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(answered.held_run(), None);
        assert!(answered.succeeded());
    }

    /// Whether the latest top-level `result` read was an error, whatever its `origin`, which is
    /// what `claude`'s exit status follows by a reading of 2.1.325's code (3.6): `is_error`, or
    /// an `error_*` subtype. A subagent's own `result` is not read, and a held turn's is never
    /// an error.
    #[test]
    fn the_last_result_read_says_whether_it_failed() {
        let (_temp, folder, mut turn) = adapter();
        assert!(!turn.last_result_failed());
        turn.feed(&init(&folder));
        turn.feed(&started_in_the_background("a1", "run-a", "local_agent"));
        turn.feed(&started_in_the_background("b1", "run-b", "local_bash"));
        turn.feed(&turn_result("A helper is on it.", 0, None, [1, 0, 0, 1]));
        assert!(!turn.last_result_failed());
        // A background command's follow-up that failed is never the reply, but read last.
        turn.feed(&ended("b1", "run-b"));
        turn.feed(&init(&folder));
        let mut failed = turn_result(
            "The request failed.",
            1,
            Some(follow_up_of("run-b")),
            [1, 0, 0, 0],
        );
        failed["subtype"] = json!("error_during_execution");
        failed["is_error"] = json!(true);
        turn.feed(&failed);
        assert!(turn.last_result_failed());
        assert!(turn.succeeded());
        let mut nested = turn_result("A subagent's.", 0, None, [0, 0, 0, 0]);
        nested["parent_tool_use_id"] = json!("toolu_agent");
        turn.feed(&nested);
        assert!(turn.last_result_failed());
        turn.feed(&ended("a1", "run-a"));
        turn.feed(&init(&folder));
        turn.feed(&held_result(2, follow_up_of("run-a")));
        assert!(!turn.last_result_failed());
        assert_eq!(turn.status(), &AdapterStatus::Running);

        let (_temp, folder, mut limited) = adapter();
        limited.feed(&init(&folder));
        let mut subtype_only = turn_result("", 0, None, [1, 0, 0, 1]);
        subtype_only["subtype"] = json!("error_max_turns");
        limited.feed(&subtype_only);
        assert!(limited.last_result_failed());
        assert!(!limited.succeeded());
    }

    /// A top-level `init` with no `result` yet keeps the turn open: it then ends when `claude`
    /// exits by itself, with the reply it has, or at the turn's limits (3.6). A subagent's own
    /// `init` or `result` counts for neither.
    #[test]
    fn an_init_without_its_result_keeps_the_turn_open() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        let mut nested_init = init(&folder);
        nested_init["parent_tool_use_id"] = json!("toolu_agent");
        adapter.feed(&nested_init);
        adapter.feed(&init(&folder));
        let mut nested_result = turn_result("A subagent's.", 0, None, [1, 1, 1, 1]);
        nested_result["parent_tool_use_id"] = json!("toolu_agent");
        adapter.feed(&nested_result);
        adapter.feed(&turn_result("Done.", 0, None, [1, 0, 0, 1]));
        assert_eq!((adapter.inits(), adapter.results()), (2, 1));
        assert_eq!(adapter.status(), &AdapterStatus::Running);
        assert_eq!(adapter.reply(), Some("Done."));
        assert!(adapter.succeeded(), "an exit that counts as 0 succeeds");
        assert_eq!(
            usage_of(&adapter),
            json!({"input_tokens": 1, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 1})
        );
    }

    /// Claude Code 2.1.325 reports usage and permission denials per `result`, and a denial also
    /// on a `system/permission_denied` line of its own: the turn's are those of all its top-level
    /// `result`s, a tool call once (3.7).
    #[test]
    fn usage_and_denials_add_up_over_the_turns_results() {
        let (_temp, folder, mut adapter) = adapter();
        let denied = |tool: &str, call: &str| json!({"type": "system", "subtype": "permission_denied", "tool_name": tool, "tool_use_id": call, "decision_reason_type": "asyncAgent", "decision_reason": "No one can approve it.", "message": "Permission for this tool use was denied."});
        let report = |tool: &str, call: &str| json!({"tool_name": tool, "tool_use_id": call, "tool_input": {"file_path": "/etc/x"}});
        adapter.feed(&init(&folder));
        adapter.feed(&started_in_the_background("a1", "run-a", "local_agent"));
        adapter.feed(&denied("Write", "toolu_w1"));
        adapter.feed(&ended("a1", "run-a"));
        adapter.feed(&init(&folder));
        adapter.feed(&denied("Edit", "toolu_e1"));
        let mut first = turn_result("I could not write there.", 0, None, [10, 2, 30, 4]);
        first["permission_denials"] =
            json!([report("Write", "toolu_w1"), report("Bash", "toolu_b1")]);
        adapter.feed(&first);
        let mut second = turn_result(
            "The helper could not edit it either.",
            1,
            Some(follow_up_of("run-a")),
            [5, 1, 20, 6],
        );
        second["permission_denials"] =
            json!([report("Edit", "toolu_e1"), {"tool_name": "WebFetch"}]);
        second["total_cost_usd"] = json!(0.5);
        adapter.feed(&second);
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        assert_eq!(
            adapter.permission_denials(),
            ["Write", "Edit", "Bash", "WebFetch"]
        );
        let step = adapter.permission_denials_step().unwrap();
        assert!(
            step.content
                .starts_with("Claude Code skipped 4 steps that need your OK"),
            "{}",
            step.content
        );
        assert_eq!(
            usage_of(&adapter),
            json!({"input_tokens": 15, "cache_creation_input_tokens": 3, "cache_read_input_tokens": 50, "output_tokens": 10})
        );
        let artifact = serde_json::to_string(&adapter.usage_artifact()).unwrap();
        assert!(
            !artifact.contains("cost") && !artifact.contains("0.5"),
            "{artifact}"
        );

        // Lines of their own alone, with a `result` that carries no list.
        let mut alone = EventAdapter::new(&folder, None);
        alone.feed(&init(&folder));
        alone.feed(&denied("Write", "toolu_w9"));
        let mut bare = turn_result("Done.", 0, None, [1, 0, 0, 1]);
        bare.as_object_mut().unwrap().remove("permission_denials");
        alone.feed(&bare);
        assert_eq!(alone.permission_denials(), ["Write"]);
    }

    fn exit(code: i32) -> ExitFacts<'static> {
        ExitFacts {
            resumed: false,
            exit_code: Some(code),
            signal: None,
            exited_ok: code == 0,
            stderr: "",
        }
    }

    #[test]
    fn failures_are_classified_from_structured_fields_first() {
        let classify = |lines: &[Value], exit: ExitFacts<'_>| {
            let (_temp, folder, mut adapter) = adapter();
            adapter.feed(&init(&folder));
            for line in lines {
                adapter.feed(line);
            }
            adapter.classify_failure(&exit)
        };
        let sign_in = classify(
            &[
                json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "Not logged in · Please run /login"}]}, "error": "authentication_failed"}),
                result("Not logged in · Please run /login", true),
            ],
            exit(1),
        );
        assert_eq!(sign_in.code, Some(FailureCode::NotSignedIn));
        assert!(sign_in.message.starts_with("Not logged in"));

        let limit = classify(
            &[
                json!({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": 1763060400, "errorCode": "credits_required"}}),
                json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "Rate limited"}]}, "error": "rate_limit"}),
                result("Rate limited", true),
            ],
            exit(1),
        );
        assert_eq!(limit.code, Some(FailureCode::PlanLimit));
        assert_eq!(limit.resets_at, Some(1763060400));
        assert!(
            limit
                .message
                .contains("The limit resets at 2025-11-13 19:00 UTC."),
            "{}",
            limit.message
        );

        // An allowed rate limit event is no failure, and a `rate_limit` error without a
        // rejected event may be an API key's: 5.5's "anything else".
        let api_rate_limit = classify(
            &[
                json!({"type": "rate_limit_event", "rate_limit_info": {"status": "allowed_warning"}}),
                json!({"type": "assistant", "message": {"content": [{"type": "text", "text": "API Error: 429 rate_limit_error"}]}, "error": "rate_limit"}),
                result("API Error: 429 rate_limit_error", true),
            ],
            exit(1),
        );
        assert_eq!(api_rate_limit.code, None);
        assert!(api_rate_limit.message.starts_with("API Error: 429"));

        // Text, only as a fallback.
        let text_sign_in = classify(
            &[result("Invalid API key · Please run /login", true)],
            exit(1),
        );
        assert_eq!(text_sign_in.code, Some(FailureCode::NotSignedIn));
        let text_limit = classify(
            &[result("Claude AI usage limit reached|1763064000", true)],
            exit(1),
        );
        assert_eq!(text_limit.code, Some(FailureCode::PlanLimit));
        assert_eq!(text_limit.resets_at, Some(1763064000));

        let other = classify(
            &[result("API Error: 500 Internal server error", true)],
            exit(1),
        );
        assert_eq!(other.code, None);
        let no_result = classify(&[], exit(1));
        assert_eq!(no_result.code, Some(FailureCode::Crashed));
        assert!(no_result.message.contains("exited with status 1"));
        let success_then_failure = classify(&[result("Done.", false)], exit(2));
        assert_eq!(success_then_failure.code, Some(FailureCode::Crashed));
        let killed = classify(
            &[],
            ExitFacts {
                exit_code: None,
                signal: Some(9),
                ..exit(1)
            },
        );
        assert!(killed.message.contains("signal 9"));
    }

    /// A resume miss is read only after `--resume`, and only before any `init`: the runtime then
    /// starts `claude` once more without it (11.9). On stderr alone, as a version that says it
    /// only there would, it needs an exit that is not 0. Read as a failure, the same exit has no
    /// code of its own: `session_unavailable` is gone.
    #[test]
    fn a_resume_miss_before_init_is_read_only_after_a_resume() {
        let temp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(temp.path()).unwrap();
        let adapter = EventAdapter::new(&folder, None);
        let stderr = "No conversation found with session ID: 5d2a8c4e-1f3b-4c6d-9e7a-0b1c2d3e4f50";
        let missed = ExitFacts {
            resumed: true,
            stderr,
            ..exit(1)
        };
        assert!(adapter.missed_the_session(&missed));
        let failure = adapter.classify_failure(&missed);
        assert_eq!(failure.code, Some(FailureCode::Crashed));
        assert!(failure.message.starts_with("No conversation found"));
        // Without `--resume`, or after an exit 0, it is no miss.
        for exit in [
            ExitFacts {
                resumed: false,
                stderr,
                ..exit(1)
            },
            ExitFacts {
                resumed: true,
                stderr,
                ..exit(0)
            },
        ] {
            assert!(!adapter.missed_the_session(&exit), "{exit:?}");
        }
        // Another startup exit after a resume is no miss, and keeps its own code.
        let other = ExitFacts {
            resumed: true,
            stderr: "managed MCP configuration refuses --mcp-config",
            ..exit(1)
        };
        assert!(!adapter.missed_the_session(&other));
        assert_eq!(
            adapter.classify_failure(&other).code,
            Some(FailureCode::Crashed)
        );
        // Once an `init` passed its checks, the session ran: nothing is a miss.
        let mut started = EventAdapter::new(&folder, None);
        started.feed(&init(&folder));
        assert!(!started.missed_the_session(&missed));
        // A run that reported a result but never its settings.
        let mut no_init = EventAdapter::new(&folder, None);
        no_init.feed(&result("Done.", false));
        assert_eq!(
            no_init.classify_failure(&exit(0)).code,
            Some(FailureCode::UnexpectedConfiguration)
        );
    }

    /// Claude Code 2.1.325's resume miss (Phase 0, item 7), with a made-up session: a `result` on
    /// stdout before any `init`, with no `result` text and the missing session in `errors`.
    fn resume_miss_result() -> Value {
        json!({
            "type": "result",
            "subtype": "error_during_execution",
            "duration_ms": 0,
            "duration_api_ms": 0,
            "is_error": true,
            "num_turns": 0,
            "stop_reason": null,
            "session_id": "0d9c8b7a-6f5e-4d3c-8b2a-19f8e7d6c5b4",
            "total_cost_usd": 0,
            "usage": {"input_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 0},
            "modelUsage": {},
            "permission_denials": [],
            "uuid": "c0ffee00-0000-4000-8000-0000000000ac",
            "errors": ["No conversation found with session ID: 5d2a8c4e-1f3b-4c6d-9e7a-0b1c2d3e4f50"],
            "result_index": 0,
        })
    }

    /// That `result` ends the turn, so the runtime's own SIGTERM races `claude`'s exit 1: the exit
    /// can be 1, 143, 0 or a kill after the grace. After `--resume`, the structured `errors` say
    /// it is a resume miss whatever the exit.
    #[test]
    fn a_resume_miss_result_before_init_is_a_miss_whatever_the_exit() {
        let temp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(temp.path()).unwrap();
        let mut adapter = EventAdapter::new(&folder, None);
        adapter.feed(&resume_miss_result());
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        assert!(adapter.init().is_none() && !adapter.succeeded());
        for (exit_code, signal) in [
            (Some(1), None),
            (Some(143), None),
            (Some(0), None),
            (None, Some(9)),
        ] {
            let missed = ExitFacts {
                resumed: true,
                exit_code,
                signal,
                exited_ok: matches!(exit_code, Some(0 | 143)),
                stderr: "",
            };
            assert!(
                adapter.missed_the_session(&missed),
                "{exit_code:?} {signal:?}"
            );
        }
        // Without `--resume`, the same line is no miss: 5.5's "anything else", with its own
        // words.
        assert!(!adapter.missed_the_session(&exit(1)));
        let fresh = adapter.classify_failure(&exit(1));
        assert_eq!(fresh.code, None);
        assert!(fresh.message.starts_with("No conversation found"));
        // Another error before `init` after a resume is no miss, nor is the phrase in a `result`
        // after `init` or in one that is no error.
        let missed = |init_first: bool, line: Value| {
            let mut adapter = EventAdapter::new(&folder, None);
            if init_first {
                adapter.feed(&init(&folder));
            }
            adapter.feed(&line);
            adapter.missed_the_session(&ExitFacts {
                resumed: true,
                ..exit(0)
            })
        };
        assert!(missed(false, resume_miss_result()));
        let mut other = resume_miss_result();
        other["errors"] = json!(["managed MCP configuration refuses --mcp-config"]);
        assert!(!missed(false, other));
        assert!(!missed(true, resume_miss_result()));
        let mut no_error = resume_miss_result();
        no_error["is_error"] = json!(false);
        no_error["subtype"] = json!("success");
        assert!(!missed(false, no_error));
    }

    /// After a resume miss, the adapter starts over for the second `claude` of the turn: the
    /// miss's `result` counts for nothing, so the new session's own turn ends and replies as any
    /// turn does, in the turn's mode. The run log keeps the miss, then says the turn started
    /// again (11.9).
    #[test]
    fn after_a_resume_miss_the_adapter_starts_over_and_keeps_the_miss_in_its_run_log() {
        let temp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(temp.path()).unwrap();
        let mut adapter = EventAdapter::new(&folder, None).in_mode(ExecutionMode::PlanOnly);
        adapter.feed(&resume_miss_result());
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        adapter.start_again();
        assert_eq!(adapter.status(), &AdapterStatus::Running);
        assert_eq!((adapter.inits(), adapter.results()), (0, 0));
        assert!(adapter.reply_result().is_none());
        let mut plans = init(&folder);
        plans["permissionMode"] = json!("plan");
        plans["session_id"] = json!("0d9c8b7a-6f5e-4d3c-8b2a-19f8e7d6c5b4");
        adapter.feed(&plans);
        adapter.feed(&result("Here is the plan.", false));
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        assert!(adapter.succeeded());
        assert_eq!(adapter.reply(), Some("Here is the plan."));
        let runtime = Uuid::new_v4();
        assert_eq!(
            adapter.conversation_state(runtime).unwrap()["sessionId"],
            "0d9c8b7a-6f5e-4d3c-8b2a-19f8e7d6c5b4"
        );
        let log: Vec<String> = adapter
            .run_log()
            .events()
            .iter()
            .map(|event| event["type"].as_str().unwrap_or_default().to_string())
            .collect();
        assert_eq!(
            log,
            [
                "result",
                "instafy.started_without_the_missing_session",
                "system",
                "result"
            ]
        );
        // The usage counts only the new session's turn.
        assert_eq!(
            adapter.usage_artifact().unwrap()["usage"]["output_tokens"],
            4
        );
    }

    #[test]
    fn permission_denials_come_from_the_result_and_otherwise_from_tool_results() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        for (id, name) in [("w", "Write"), ("b", "Bash")] {
            adapter.feed(&assistant("m", json!([{"type": "tool_use", "id": id, "name": name, "input": {"command": "rm -rf build", "file_path": "/etc/x"}}]), None));
            adapter.feed(&tool_result(
                id,
                json!(format!(
                    "Claude requested permissions to use {name}, but you haven't granted it yet."
                )),
                true,
            ));
        }
        // A command that failed by itself is no denial.
        adapter.feed(&assistant(
            "m",
            json!([{"type": "tool_use", "id": "f", "name": "Bash", "input": {"command": "./run"}}]),
            None,
        ));
        adapter.feed(&tool_result(
            "f",
            json!("bash: ./run: Permission denied"),
            true,
        ));
        assert_eq!(adapter.permission_denials(), ["Write", "Bash"]);
        let step = adapter.permission_denials_step().unwrap();
        assert_eq!(step.message_type.as_deref(), Some("status"));
        assert!(
            step.content
                .starts_with("Claude Code skipped 2 steps that need your OK")
        );
        // A note of the turn: Studio shows it under the reply, Details closed or not.
        assert_eq!(
            step.metadata,
            Some(json!({
                "kind": "claude_code_permission_denials",
                "count": 2,
                "tools": ["Write", "Bash"],
                "presentation": { "placement": "reply_note" },
            }))
        );
        // The result's own list wins when it has one.
        let mut with_list = result("Done.", false);
        with_list["permission_denials"] =
            json!([{"tool_name": "Edit", "tool_use_id": "e", "tool_input": {}}]);
        adapter.feed(&with_list);
        assert_eq!(adapter.permission_denials(), ["Edit"]);
        assert!(
            adapter
                .permission_denials_step()
                .unwrap()
                .content
                .starts_with("Claude Code skipped 1 step that needs your OK")
        );
        assert!(adapter.succeeded());
    }

    #[test]
    fn the_run_log_keeps_its_first_and_last_lines_within_its_bounds() {
        let mut log = RunLog::default();
        for index in 0..200 {
            log.push(json!({"type": "system", "subtype": "status", "n": index, "text": "x".repeat(10_000)}));
        }
        let events = log.events();
        assert_eq!(events.len(), RunLog::HEAD_EVENTS + 1 + RunLog::TAIL_EVENTS);
        assert_eq!(events[0]["n"], json!(0));
        assert_eq!(
            events[RunLog::HEAD_EVENTS]["type"],
            json!("instafy.run_log.compacted")
        );
        assert_eq!(
            events[RunLog::HEAD_EVENTS]["omittedEventCount"],
            json!(200 - 24 - 55)
        );
        assert_eq!(events.last().unwrap()["n"], json!(199));
        assert!(
            events[0]["text"]
                .as_str()
                .unwrap()
                .ends_with("[truncated 2000 chars]")
        );
        let size: usize = events.iter().map(serialized_len).sum();
        assert!(size <= RunLog::MAX_BYTES, "{size}");
        // A line too large to keep whole keeps its kind.
        let mut log = RunLog::default();
        let huge: Vec<String> = (0..2_000)
            .map(|n| format!("{n}{}", "y".repeat(100)))
            .collect();
        log.push(json!({"type": "user", "content": huge}));
        assert!(serialized_len(&log.events()[0]) <= 64 * 1024);
        assert_eq!(log.artifact()["kind"], json!("claude-code/run-log"));
    }

    /// A `rate_limit_event` and a `result` in Claude Code 2.1.325's shapes (Phase 0, B.2), with
    /// made-up figures: the run log keeps no cost, no sign-in expiry and no plan usage, and still
    /// what classifies a plan limit and what the turn's own `result` says.
    #[test]
    fn the_run_log_keeps_no_cost_credential_or_plan_usage() {
        let (_temp, folder, mut adapter) = adapter();
        adapter.feed(&init(&folder));
        let session = "5d2a8c4e-1f3b-4c6d-9e7a-0b1c2d3e4f50";
        adapter.feed(&json!({
            "type": "rate_limit_event",
            "rate_limit_info": {
                "status": "allowed",
                "resetsAt": 1_900_000_000,
                "rateLimitType": "five_hour",
                "utilization": 0.37,
                "overageStatus": "allowed",
                "overageResetsAt": 1_900_100_000,
                "isUsingOverage": true,
                "surpassedThreshold": 0.25,
                "unifiedWindows": {"five_hour": {"utilization": 0.37, "resetsAt": 1_900_000_000, "status": "allowed", "surpassedThreshold": 0.25}},
                "overageEnabled": true,
            },
            "uuid": "c0ffee00-0000-4000-8000-0000000000aa",
            "session_id": session,
        }));
        let per_model = json!({"claude-sonnet-4-5": {
            "inputTokens": 7, "outputTokens": 11, "cacheReadInputTokens": 13, "cacheCreationInputTokens": 17,
            "webSearchRequests": 0, "costUSD": 0.4242, "contextWindow": 200_000, "maxOutputTokens": 32_000,
            "thinkingTokens": 0, "canonicalModel": "claude-sonnet-4-5", "provider": "firstParty", "costBasis": "list",
        }});
        adapter.feed(&json!({
            "type": "result",
            "subtype": "success",
            "is_error": false,
            "api_error_status": null,
            "duration_ms": 4_000,
            "duration_api_ms": 3_000,
            "num_turns": 1,
            "result": "Renamed the project.",
            "stop_reason": "end_turn",
            "session_id": session,
            "total_cost_usd": 0.4242,
            "usage": {"input_tokens": 7, "cache_creation_input_tokens": 17, "cache_read_input_tokens": 13, "output_tokens": 11, "server_tool_use": {"web_search_requests": 0, "web_fetch_requests": 0}, "service_tier": "standard", "fallback_credit": null},
            "modelUsage": per_model,
            "permission_denials": [],
            "terminal_reason": "completed",
            "fast_mode_state": "off",
            "subagent_stats": {"spawned": 0, "completed": 0, "failed": 0},
            "queued_turn_count": 0,
            "uuid": "c0ffee00-0000-4000-8000-0000000000ab",
            "result_index": 0,
            "model_usage_since_last_result": per_model,
            "credential_expires_at": "2030-01-02T03:04:05.000Z",
        }));
        assert_eq!(adapter.status(), &AdapterStatus::EndOfTurn);
        let events = adapter.run_log().events();
        let log = serde_json::to_string(&events).unwrap();
        for kept_out in [
            "cost",
            "0.4242",
            "credential",
            "2030-01-02",
            "utilization",
            "0.37",
            "overage",
            "1900100000",
            "threshold",
            "unifiedWindows",
            "five_hour",
            "firstParty",
            "modelUsage",
            "model_usage_since_last_result",
        ] {
            assert!(
                !log.to_lowercase().contains(&kept_out.to_lowercase()),
                "{kept_out} in {log}"
            );
        }
        let rate_limit = events
            .iter()
            .find(|event| event["type"] == "rate_limit_event")
            .expect("the rate limit line is logged");
        assert_eq!(
            rate_limit,
            &json!({
                "type": "rate_limit_event",
                "rate_limit_info": {"status": "allowed", "resetsAt": 1_900_000_000},
                "uuid": "c0ffee00-0000-4000-8000-0000000000aa",
                "session_id": session,
            })
        );
        let logged = events
            .iter()
            .find(|event| event["type"] == "result")
            .expect("the result is logged");
        assert_eq!(logged["result"], json!("Renamed the project."));
        assert_eq!(logged["result_index"], json!(0));
        assert_eq!(logged["usage"]["output_tokens"], json!(11));
        assert_eq!(logged["subagent_stats"]["spawned"], json!(0));
        // What classifies a plan limit is read from the line itself, not from the log.
        let mut rejected = EventAdapter::new(&folder, None);
        rejected.feed(&init(&folder));
        rejected.feed(&json!({"type": "rate_limit_event", "rate_limit_info": {"status": "rejected", "resetsAt": 1_900_000_000, "rateLimitType": "five_hour", "utilization": 1.0, "errorCode": "credits_required"}}));
        rejected.feed(&result("Rate limited", true));
        let limit = rejected.classify_failure(&exit(1));
        assert_eq!(limit.code, Some(FailureCode::PlanLimit));
        assert_eq!(limit.resets_at, Some(1_900_000_000));
    }

    /// No line keeps a cost or a credential in the run log, not only a `result`: a later Claude
    /// Code version may add one to a task's notification or to any other line (made-up figures).
    /// The rest of the line stays.
    #[test]
    fn no_line_keeps_a_cost_or_a_credential_in_the_run_log() {
        let (_temp, folder, mut adapter) = adapter();
        let mut with_init = init(&folder);
        with_init["credentialSource"] = json!("keychain");
        adapter.feed(&with_init);
        adapter.feed(&task(
            "task_notification",
            "a1",
            json!({
                "status": "completed",
                "summary": "Found the bug",
                "usage": {"total_tokens": 1_234, "tool_uses": 3, "duration_ms": 900, "costUSD": 0.4242, "costBasis": "list"},
                "credential_expires_at": "2030-01-02T03:04:05.000Z",
            }),
        ));
        adapter.feed(&json!({"type": "system", "subtype": "status", "status": "requesting", "session_cost": {"total_cost_usd": 0.4242}}));
        let mut message = assistant("m1", json!([{"type": "text", "text": "Done."}]), None);
        message["message"]["usage"] = json!({"output_tokens": 5, "costUSD": 0.4242});
        adapter.feed(&message);
        let events = adapter.run_log().events();
        let log = serde_json::to_string(&events).unwrap();
        for kept_out in ["cost", "0.4242", "credential", "2030-01-02", "keychain"] {
            assert!(
                !log.to_lowercase().contains(kept_out),
                "{kept_out} in {log}"
            );
        }
        let notification = events
            .iter()
            .find(|event| event["subtype"] == "task_notification")
            .expect("the notification is logged");
        assert_eq!(notification["summary"], json!("Found the bug"));
        assert_eq!(
            notification["usage"],
            json!({"total_tokens": 1_234, "tool_uses": 3, "duration_ms": 900})
        );
        let status = events
            .iter()
            .find(|event| event["subtype"] == "status")
            .expect("the status line is logged");
        assert_eq!(status["status"], json!("requesting"));
        let logged = events
            .iter()
            .find(|event| event["type"] == "assistant")
            .expect("the message is logged");
        assert_eq!(logged["message"]["usage"], json!({"output_tokens": 5}));
        assert!(events.iter().any(|event| event["subtype"] == "init"));
    }

    #[test]
    fn unparsed_lines_are_counted_redacted_and_logged() {
        let (_temp, _folder, mut adapter) = adapter();
        adapter.note_unparsed(b"Error at /home/person/.local/bin/claude sk-ant-oat01-x");
        assert_eq!(adapter.unparsed_lines(), 1);
        let log = serde_json::to_string(&adapter.run_log().events()).unwrap();
        assert!(log.contains("~/.local/bin/claude") && log.contains("[redacted]"));
        assert!(!log.contains("/home/person") && !log.contains("sk-ant-oat"));
        let failure = adapter.classify_failure(&exit(1));
        assert!(
            failure.message.contains("~/.local/bin/claude [redacted]"),
            "{}",
            failure.message
        );
    }
}
