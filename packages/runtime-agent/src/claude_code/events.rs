//! The event adapter of a local-engine turn (docs/Local-Engine-Turns.md, 3.7).
//!
//! It reads the lines `claude --print --output-format stream-json` prints and turns them into
//! the Codex-exec-shaped events the existing consumers read: `extract_codex_messages` makes the
//! turn's steps of them, and `ReplyDraftStream` its reply draft. It also keeps what the end of
//! the turn needs: the session and model of `system/init` once the launch checks passed (3.6),
//! the live background tasks the end-of-turn rule reads (3.6), the latest top-level `result`
//! (the reply, success and usage), the permission denials, what classifies a failure (2.6), and
//! a bounded run log.
//!
//! | Claude Code stream-json | Synthesized event |
//! |---|---|
//! | `system` / `init` | none: records `session_id` and `model`, and runs the launch checks |
//! | `system` / `task_started`, `task_notification`, `background_tasks_changed` | none: they update the live background tasks |
//! | top-level `stream_event` text delta | `item.updated` `agent_message` `{id: "<message id>:<block index>", text, phase: "final_answer"}` |
//! | a text block that a `tool_use` follows in the same message | `item.completed` `agent_message` with `phase: "commentary"`, then [`DRAFT_RESET_EVENT`] when the text was drafted |
//! | `Bash` or `Monitor`, then its result | `item.started`, `item.completed` `command_execution` |
//! | `Edit`, `Write`, `NotebookEdit` | `item.completed` `file_change` with paths relative to the folder |
//! | `WebSearch` | `item.completed` `web_search` `{query}` |
//! | `TodoWrite`, or `TaskCreate` and `TaskUpdate` | `item.updated` `todo_list` with the whole list |
//! | any other tool | `item.started`, `item.completed` `mcp_tool_call` `{server: "claude-code", tool, engine: "claude-code"}` |
//! | events of Claude Code's subagents (`parent_tool_use_id`) | the same mapping, but never a draft |
//! | thinking | ignored, and not logged |
//! | top-level `result` | none: the reply, success and usage; 3.6 says when it ends the turn |
//! | anything else | ignored, but kept in the run log |
//!
//! Every string an event carries is redacted ([`Redactor`]): `sk-ant-` tokens, the folder's
//! absolute prefix made relative and the home folder's made `~`. A step's path outside the
//! folder shows as [`OUTSIDE_THIS_SPACE`]. Nothing here labels a step: labels come only from the
//! runtime's own tables (`jobs::activity_labels`, `claude_code_tool_activity` for tool steps).

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::path::{Component, Path, PathBuf};

use serde_json::{Value, json};
use uuid::Uuid;

use super::job::ENGINE;
use super::{FailureCode, LaunchGrant};
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
/// The missing-session error of `--resume`, which Phase 0 item 7 records (2.7).
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

/// What every string the lane sends goes through (3.6): `sk-ant-` tokens are replaced, the
/// absolute folder prefix becomes relative and the home folder's prefix `~`, since both name the
/// OS user.
#[derive(Clone, Debug, Default)]
pub struct Redactor {
    folders: Vec<String>,
    homes: Vec<String>,
}

impl Redactor {
    pub fn new(folder: &Path, home: Option<&Path>) -> Self {
        Self {
            folders: path_spellings(folder),
            homes: home.map(path_spellings).unwrap_or_default(),
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
    /// home folder's path is held back until it has, so the draft never shows a part of either.
    pub fn draft(&self, text: &str) -> String {
        let held = self.held_back(text);
        self.text(&text[..text.len() - held])
    }

    fn held_back(&self, text: &str) -> usize {
        let mut held = 0;
        for spelling in self.folders.iter().chain(&self.homes) {
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
/// mismatch: the session id is a UUID, `cwd` is the folder, the mode is `acceptEdits` and no MCP
/// server loaded. The error says which, in plain words.
pub fn check_init(init: &Value, folder: &Path) -> Result<InitFacts, String> {
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
    if !is_the_folder(Path::new(cwd), folder) {
        return Err("Claude Code started in another folder than this space's.".to_string());
    }
    let model = field("model")?
        .as_str()
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .ok_or_else(|| "Claude Code reported no model.".to_string())?;
    let mode = field("permissionMode")?
        .as_str()
        .ok_or_else(|| "Claude Code reported no permission mode.".to_string())?;
    if mode != "acceptEdits" {
        return Err(format!(
            "Claude Code started with permission mode {}, not acceptEdits.",
            bounded(mode, 40)
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
    Ok(InitFacts {
        session_id,
        model: bounded(model, 200),
    })
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

/// The live background tasks of a turn, from `system/task_started`, `task_notification` and
/// `background_tasks_changed` (3.6). Ambient tasks are left out.
///
/// Only an event that says a task ended (or is ambient) removes it. A list that leaves a task out,
/// a notification with no status that says it ended, and a listed task with no id this reads keep
/// the turn open: ending a turn too early stops a background subagent mid-work and saves its
/// half-done edits, while a turn kept open ends when `claude` exits once its work is done.
#[derive(Clone, Debug, Default)]
pub struct BackgroundTasks {
    /// Each live task's id and its `task_type`, when it said.
    live: BTreeMap<String, Option<String>>,
    /// The live tasks, background commands left out, that the latest `background_tasks_changed`
    /// listed with no id this reads: they keep the turn open until a list no longer has them.
    unidentified: usize,
}

const TASK_ID_KEYS: [&str; 3] = ["task_id", "taskId", "id"];
/// A line's `type` is its own (`system`), so a task's type is read from these only.
const TASK_TYPE_KEYS: [&str; 2] = ["task_type", "taskType"];
/// A listed task is no line of its own, so its `type` may be its task type.
const ENTRY_TYPE_KEYS: [&str; 3] = ["task_type", "taskType", "type"];

impl BackgroundTasks {
    pub fn observe(&mut self, line: &Value) {
        match str_field(line, "subtype") {
            Some("task_started") => {
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
                // A notification that says the task ended (`completed`, `failed`, `stopped`)
                // removes it. Any other status, or none, says nothing this can rely on.
                if has_ended(line)
                    && let Some(id) = id_field(line, &TASK_ID_KEYS)
                {
                    self.live.remove(&id);
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
    /// A top-level `result` arrived with no task live that keeps the turn open (3.6). The
    /// runtime stops `claude` and ignores what it prints afterwards.
    EndOfTurn,
    /// A launch check failed (3.6): the turn ends as `unexpected_configuration`.
    Unexpected(String),
}

/// The latest top-level `result`.
#[derive(Clone, Debug, Default)]
pub struct ResultFacts {
    /// `is_error`, or an `error_*` subtype.
    pub is_error: bool,
    pub subtype: Option<String>,
    /// `result`: the reply, redacted and with the folder prefix made relative (3.7).
    pub text: Option<String>,
    /// `errors`, redacted.
    pub errors: Vec<String>,
    /// The input, cache-creation, cache-read and output tokens. Never `total_cost_usd`, an API
    /// price estimate that is not what a plan costs (2.6).
    pub usage: Option<Value>,
    /// The tool names of `permission_denials`, when the field is there.
    pub denials: Option<Vec<String>>,
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
        let denials = line
            .get("permission_denials")
            .and_then(Value::as_array)
            .map(|denials| {
                denials
                    .iter()
                    .take(MAX_DENIALS)
                    .map(|denial| {
                        str_field(denial, "tool_name")
                            .map(|name| bounded(&redactor.text(name), 100))
                            .unwrap_or_else(|| "tool".to_string())
                    })
                    .collect()
            });
        Self {
            is_error,
            subtype,
            text: str_field(line, "result").map(|text| redactor.text(text)),
            errors,
            usage: line.get("usage").map(usage_counts),
            denials,
        }
    }
}

fn usage_counts(usage: &Value) -> Value {
    let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    json!({
        "input_tokens": count("input_tokens"),
        "cache_creation_input_tokens": count("cache_creation_input_tokens"),
        "cache_read_input_tokens": count("cache_read_input_tokens"),
        "output_tokens": count("output_tokens"),
    })
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
    /// `--resume` was passed.
    pub resumed: bool,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    /// The exit counts as 0: it was 0, or 143 after the runtime's own SIGTERM (3.6).
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
    status: AdapterStatus,
    init: Option<InitFacts>,
    tasks: BackgroundTasks,
    /// The top-level message streaming now.
    streaming: Option<String>,
    messages: VecDeque<MessageBlocks>,
    pending: HashMap<String, PendingTool>,
    seen_tools: HashSet<String>,
    task_list: Vec<Task>,
    latest_result: Option<ResultFacts>,
    results: usize,
    auth_failed: bool,
    rejection: Option<RateLimitRejection>,
    assistant_errors: Vec<AssistantError>,
    denied: Vec<String>,
    unparsed_lines: usize,
    unparsed_text: String,
    run_log: RunLog,
}

impl EventAdapter {
    /// The adapter of a turn in `folder`, whose steps show `home` as `~`.
    pub fn new(folder: &Path, home: Option<&Path>) -> Self {
        Self {
            redactor: Redactor::new(folder, home),
            folder: folder.to_path_buf(),
            status: AdapterStatus::Running,
            init: None,
            tasks: BackgroundTasks::default(),
            streaming: None,
            messages: VecDeque::new(),
            pending: HashMap::new(),
            seen_tools: HashSet::new(),
            task_list: Vec::new(),
            latest_result: None,
            results: 0,
            auth_failed: false,
            rejection: None,
            assistant_errors: Vec::new(),
            denied: Vec::new(),
            unparsed_lines: 0,
            unparsed_text: String::new(),
            run_log: RunLog::default(),
        }
    }

    /// The adapter of a turn of `grant`'s person in `folder`: the launch `HOME` shows as `~`.
    pub fn for_turn(grant: &LaunchGrant, folder: &Path) -> Self {
        Self::new(folder, grant.snapshot().home())
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

    /// The latest top-level `result` read, which gives the reply and success (3.6).
    pub fn latest_result(&self) -> Option<&ResultFacts> {
        self.latest_result.as_ref()
    }

    /// How many top-level `result`s were read.
    pub fn results(&self) -> usize {
        self.results
    }

    /// The reply: the latest top-level `result.result`, redacted and with the folder prefix
    /// made relative. Instafy appends nothing to it (3.7).
    pub fn reply(&self) -> Option<&str> {
        self.latest_result.as_ref()?.text.as_deref()
    }

    /// The launch checks passed, and the latest top-level `result` is no error. With an exit
    /// that counts as 0, the turn succeeded (3.6, 3.8).
    pub fn succeeded(&self) -> bool {
        !matches!(self.status, AdapterStatus::Unexpected(_))
            && self.init.is_some()
            && self
                .latest_result
                .as_ref()
                .is_some_and(|result| !result.is_error)
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
            Some("init") => match check_init(line, &self.folder) {
                Ok(facts) => self.init = Some(facts),
                Err(why) => self.status = AdapterStatus::Unexpected(why),
            },
            Some("task_started" | "task_notification" | "background_tasks_changed") => {
                self.tasks.observe(line)
            }
            _ => {}
        }
    }

    fn on_result(&mut self, line: &Value) {
        if !is_top_level(line) {
            return;
        }
        self.latest_result = Some(ResultFacts::read(line, &self.redactor));
        self.results += 1;
        if !self.tasks.keeps_the_turn_open() {
            self.status = AdapterStatus::EndOfTurn;
        }
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
        if kind == Some("result")
            && let Some(result) = entry.as_object_mut()
        {
            // An API-price estimate, not what a plan costs: never kept (2.6).
            result.remove("total_cost_usd");
            result.remove("modelUsage");
        }
        self.redactor.json(&mut entry);
        Some(entry)
    }

    /// The permission denials of the turn (3.7): `result.permission_denials` when the latest
    /// result has it, otherwise the tool results that reported a denial. The tool names.
    pub fn permission_denials(&self) -> Vec<String> {
        match self
            .latest_result
            .as_ref()
            .and_then(|result| result.denials.clone())
        {
            Some(denials) => denials,
            None => self.denied.clone(),
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

    /// The `claude-code/usage` artifact (2.6): the model from `init` and the latest result's
    /// token counts. Never a cost.
    pub fn usage_artifact(&self) -> Option<Value> {
        let usage = self.latest_result.as_ref()?.usage.clone()?;
        let mut artifact = json!({
            "kind": "claude-code/usage",
            "model": self.init.as_ref().map(|init| init.model.clone()),
            "usage": usage,
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

    /// The reset shape a `session_unavailable` failure saves (2.7): the person's next lane
    /// message starts a new session.
    pub fn reset_conversation_state() -> Value {
        json!({ "provider": PROVIDER, "version": 1, "reset": true })
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
            .latest_result
            .as_ref()
            .is_some_and(|result| result.is_error);
        let (code, resets_at) = if let Some(rejection) = &self.rejection {
            (Some(FailureCode::PlanLimit), rejection.resets_at)
        } else if self.auth_failed {
            (Some(FailureCode::NotSignedIn), None)
        } else if exit.resumed
            && self.init.is_none()
            && exit.exit_code.is_some_and(|code| code != 0)
            && mentions(&RESUME_MISS_PHRASES)
        {
            (Some(FailureCode::SessionUnavailable), None)
        } else if mentions(&SIGN_IN_PHRASES) {
            (Some(FailureCode::NotSignedIn), None)
        } else if mentions(&PLAN_LIMIT_PHRASES) {
            (
                Some(FailureCode::PlanLimit),
                texts.iter().find_map(|text| reset_epoch_in(text)),
            )
        } else if self.init.is_none() && self.latest_result.is_some() && !result_is_error {
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

    /// The texts a failure can be read from, most specific first, all redacted.
    fn failure_texts(&self, stderr: &str) -> Vec<String> {
        let mut texts: Vec<String> = self
            .assistant_errors
            .iter()
            .map(|error| error.text.clone())
            .collect();
        if let Some(result) = &self.latest_result {
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
    fn the_launch_checks_read_every_documented_init_field() {
        let temp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(temp.path()).unwrap();
        let good = init(&folder);
        let facts = check_init(&good, &folder).unwrap();
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
            assert!(check_init(&through_link, &folder.join("real")).is_ok());
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
            assert!(check_init(&case, &folder).is_err(), "{field}: {case}");
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
        assert!(adapter.latest_result().is_none());
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

        adapter.feed(&assistant("m3", json!([{"type": "tool_use", "id": "t_s", "name": "WebSearch", "input": {"query": "vitest config"}}]), None));
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

    fn result(text: &str, is_error: bool) -> Value {
        json!({
            "type": "result",
            "subtype": "success",
            "is_error": is_error,
            "result": text,
            "total_cost_usd": 0.42,
            "modelUsage": {"claude-sonnet-4-5": {"costUSD": 0.42}},
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
        assert!(adapter.latest_result().is_none());
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
        assert!(!log.contains("cost") && !log.contains("0.42"), "{log}");
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
        assert_eq!(
            EventAdapter::reset_conversation_state(),
            json!({"provider": "claude-code", "version": 1, "reset": true})
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

    #[test]
    fn a_resume_miss_before_init_is_session_unavailable_only_after_a_resume() {
        let temp = tempfile::tempdir().unwrap();
        let folder = std::fs::canonicalize(temp.path()).unwrap();
        let adapter = EventAdapter::new(&folder, None);
        let stderr = "No conversation found with session ID: 5d2a8c4e-1f3b-4c6d-9e7a-0b1c2d3e4f50";
        let missed = ExitFacts {
            resumed: true,
            stderr,
            ..exit(1)
        };
        assert_eq!(
            adapter.classify_failure(&missed).code,
            Some(FailureCode::SessionUnavailable)
        );
        assert!(
            adapter
                .classify_failure(&missed)
                .message
                .starts_with("No conversation found")
        );
        let fresh = ExitFacts {
            resumed: false,
            stderr,
            ..exit(1)
        };
        assert_eq!(
            adapter.classify_failure(&fresh).code,
            Some(FailureCode::Crashed)
        );
        // Another startup exit after a resume keeps its own code.
        let other = ExitFacts {
            resumed: true,
            stderr: "managed MCP configuration refuses --mcp-config",
            ..exit(1)
        };
        assert_eq!(
            adapter.classify_failure(&other).code,
            Some(FailureCode::Crashed)
        );
        // A run that reported a result but never its settings.
        let mut no_init = EventAdapter::new(&folder, None);
        no_init.feed(&result("Done.", false));
        assert_eq!(
            no_init.classify_failure(&exit(0)).code,
            Some(FailureCode::UnexpectedConfiguration)
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
