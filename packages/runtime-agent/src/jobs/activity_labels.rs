//! The plain-language label of a step in a chat turn (docs/Chat-Activity.md).
//!
//! Every command, tool call, web search, file edit and runtime status a turn streams gets an
//! `activity` in its message metadata when the runtime knows what the step is: "Looking up
//! places" while it runs, "looked up 14 places" once the turn is done. The controller checks it
//! and lifts it to the message's top level, and Studio aggregates a turn's labels into one line.
//!
//! Labels come from trusted data only, in this order:
//! 1. a command an installed skill pack declares in `bin`, labelled in its `activity`
//!    (`skill_packs::activity`);
//! 2. Instafy's own CLI (`instafy web read`, `instafy preview open`, ...);
//! 3. a few common tools (installs, tests, builds, `git clone`);
//! 4. anything else gets no label, and Studio counts it ("Ran 3 commands").
//!
//! Only a command's argv is read: never its output, its exit text or the workspace. A script is
//! parsed with tree-sitter-bash (the parser Codex's own command checks use); a script that does
//! not parse cleanly, or is over [`MAX_SCRIPT_BYTES`], gets no label. Command and process
//! substitutions, `eval`-like text and here-documents are never looked inside, and a `case`
//! body is skipped. A label is never built from anything but a count.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use runtime_contracts::chat_activity::{ACTIVITY_VERSION, MAX_ALSO, check_activity};
use serde_json::{Value as JsonValue, json};
use tree_sitter::Node;

use crate::skill_packs::activity::{
    ActivityLabel, ActivityRole, DoneLabel, PackActivity, installed_pack_activities,
};

/// Scripts longer than this get no label.
pub const MAX_SCRIPT_BYTES: usize = 16 * 1024;
/// How deep `bash -c '<script>'` inside a script is followed.
const MAX_NESTED_SHELLS: usize = 2;
const SHELLS: &[&str] = &["bash", "sh", "zsh", "dash"];
const SHELL_SCRIPT_FLAGS: &[&str] = &["-c", "-lc", "-cl"];
const BROWSER_MCP_SERVERS: &[&str] = &[
    "instafy_shared_browser",
    "instafy_personal_browser",
    "instafy_local_browser",
];

/// A label from the runtime's own tables.
struct BuiltinLabel {
    key: &'static str,
    role: ActivityRole,
    live: &'static str,
    done: Option<BuiltinDone>,
}

enum BuiltinDone {
    Single(&'static str),
    Counted {
        one: &'static str,
        other: &'static str,
        some: &'static str,
    },
}

const fn counted(
    one: &'static str,
    other: &'static str,
    some: &'static str,
) -> Option<BuiltinDone> {
    Some(BuiltinDone::Counted { one, other, some })
}

const fn single(text: &'static str) -> Option<BuiltinDone> {
    Some(BuiltinDone::Single(text))
}

const WEB_READ: BuiltinLabel = BuiltinLabel {
    key: "instafy/web-read",
    role: ActivityRole::Content,
    live: "Reading pages",
    done: counted("read a page", "read {n} pages", "read pages"),
};
// The preview card already says the preview opened.
const PREVIEW_OPEN: BuiltinLabel = BuiltinLabel {
    key: "instafy/preview-open",
    role: ActivityRole::Quiet,
    live: "Opening the preview",
    done: None,
};
const PREVIEW_CHECK: BuiltinLabel = BuiltinLabel {
    key: "instafy/preview-check",
    role: ActivityRole::Quiet,
    live: "Checking the page",
    done: None,
};
const BIND: BuiltinLabel = BuiltinLabel {
    key: "instafy/bind",
    role: ActivityRole::Content,
    live: "Setting up the site",
    done: single("set up the site"),
};
const TUNNEL: BuiltinLabel = BuiltinLabel {
    key: "instafy/tunnel",
    role: ActivityRole::Content,
    live: "Making a public link",
    done: single("made a public link"),
};
const CONVERSATION_SEARCH: BuiltinLabel = BuiltinLabel {
    key: "instafy/conversation-search",
    role: ActivityRole::Content,
    live: "Searching earlier chats",
    done: single("searched earlier chats"),
};
const SAVED_SETTINGS: BuiltinLabel = BuiltinLabel {
    key: "instafy/settings",
    role: ActivityRole::Quiet,
    live: "Checking saved settings",
    done: None,
};
const INSTALL: BuiltinLabel = BuiltinLabel {
    key: "builtin/install",
    role: ActivityRole::Content,
    live: "Installing packages",
    done: single("installed packages"),
};
const TESTS: BuiltinLabel = BuiltinLabel {
    key: "builtin/test",
    role: ActivityRole::Content,
    live: "Running tests",
    done: single("ran tests"),
};
const BUILD: BuiltinLabel = BuiltinLabel {
    key: "builtin/build",
    role: ActivityRole::Content,
    live: "Building",
    done: single("built the project"),
};
const CLONE: BuiltinLabel = BuiltinLabel {
    key: "builtin/clone",
    role: ActivityRole::Content,
    live: "Copying a repository",
    done: single("copied a repository"),
};
const WEB_SEARCH: BuiltinLabel = BuiltinLabel {
    key: "builtin/web-search",
    role: ActivityRole::Content,
    live: "Searching the web",
    done: counted(
        "searched the web",
        "searched the web {n} times",
        "searched the web",
    ),
};
const FILE_EDIT: BuiltinLabel = BuiltinLabel {
    key: "builtin/edit",
    role: ActivityRole::Content,
    live: "Editing files",
    done: counted("edited a file", "edited {n} files", "edited files"),
};
const BROWSER: BuiltinLabel = BuiltinLabel {
    key: "browser/use",
    role: ActivityRole::Content,
    live: "Using the browser",
    done: single("used the browser"),
};
// A Shared Browser step that names its site (shared_browser_activity): "Searching
// visitlisboa.com", then "searched visitlisboa.com". Studio groups them by key and host, and
// counts distinct `pageKey`s for pages read.
const BROWSER_OPEN: BuiltinLabel = BuiltinLabel {
    key: "browser/open",
    role: ActivityRole::Content,
    live: "Opening {host}",
    done: counted(
        "opened {host}",
        "opened {n} pages on {host}",
        "opened pages on {host}",
    ),
};
const BROWSER_READ: BuiltinLabel = BuiltinLabel {
    key: "browser/read",
    role: ActivityRole::Content,
    live: "Reading {host}",
    done: counted(
        "read a page on {host}",
        "read {n} pages on {host}",
        "read pages on {host}",
    ),
};
const BROWSER_SEARCH: BuiltinLabel = BuiltinLabel {
    key: "browser/search",
    role: ActivityRole::Content,
    live: "Searching {host}",
    done: counted(
        "searched {host}",
        "searched {host} {n} times",
        "searched {host}",
    ),
};
// Clicks, other keys, typing, sending a form that is not a search, scrolling, tabs and status:
// the line names the pages and searches they lead to, not each step.
const BROWSER_BROWSE: BuiltinLabel = BuiltinLabel {
    key: "browser/browse",
    role: ActivityRole::Quiet,
    live: "Browsing {host}",
    done: None,
};
const TOOL: BuiltinLabel = BuiltinLabel {
    key: "tool/use",
    role: ActivityRole::Content,
    live: "Using a tool",
    done: counted("used a tool", "used {n} tools", "used tools"),
};
const SAVING: BuiltinLabel = BuiltinLabel {
    key: "runtime/save",
    role: ActivityRole::Quiet,
    live: "Saving your changes",
    done: None,
};
const RETRYING: BuiltinLabel = BuiltinLabel {
    key: "runtime/retry",
    role: ActivityRole::Quiet,
    live: "Retrying",
    done: None,
};

/// A label found for a step, from a pack or from the runtime's tables.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Found {
    key: String,
    role: ActivityRole,
    live: String,
    done: Option<JsonValue>,
    success_only: bool,
    /// How many times it ran; `None` when that is not known (inside a loop).
    count: Option<u64>,
}

impl Found {
    fn builtin(label: &BuiltinLabel, count: Option<u64>) -> Self {
        let done = label.done.as_ref().map(|done| match done {
            BuiltinDone::Single(text) => JsonValue::from(*text),
            BuiltinDone::Counted { one, other, some } => {
                json!({ "one": one, "other": other, "some": some })
            }
        });
        Self {
            key: label.key.to_string(),
            role: label.role,
            live: label.live.to_string(),
            done,
            success_only: false,
            count,
        }
    }

    fn pack(pack: &PackActivity, bin: &str, subcommand: &str, label: &ActivityLabel) -> Self {
        Self {
            key: format!("pack/{}/{bin}/{subcommand}", pack.pack),
            role: label.role,
            live: label.live.clone(),
            done: label.done.as_ref().map(DoneLabel::to_json),
            success_only: label.success_only,
            count: Some(1),
        }
    }

    fn entry_json(&self) -> serde_json::Map<String, JsonValue> {
        let mut entry = serde_json::Map::new();
        entry.insert("key".into(), JsonValue::from(self.key.as_str()));
        entry.insert("role".into(), JsonValue::from(self.role.as_str()));
        entry.insert("live".into(), JsonValue::from(self.live.as_str()));
        if let Some(done) = &self.done {
            entry.insert("done".into(), done.clone());
        }
        entry.insert(
            "count".into(),
            self.count.map_or(JsonValue::Null, JsonValue::from),
        );
        if self.success_only {
            entry.insert("when".into(), JsonValue::from("success"));
        }
        entry
    }
}

/// The step's `activity`: the first label and up to [`MAX_ALSO`] further distinct ones, each
/// counted. `None` when nothing is labelled or the result breaks a label rule.
fn activity_json(found: Vec<Found>) -> Option<JsonValue> {
    let mut merged: Vec<Found> = Vec::new();
    for item in found {
        match merged.iter_mut().find(|existing| existing.key == item.key) {
            Some(existing) => {
                existing.count = match (existing.count, item.count) {
                    (Some(a), Some(b)) => Some(a.saturating_add(b)),
                    _ => None,
                }
            }
            None => merged.push(item),
        }
    }
    let mut items = merged.into_iter();
    let first = items.next()?;
    let mut activity = serde_json::Map::new();
    activity.insert("v".into(), JsonValue::from(ACTIVITY_VERSION));
    activity.extend(first.entry_json());
    let also: Vec<JsonValue> = items
        .take(MAX_ALSO)
        .map(|item| JsonValue::Object(item.entry_json()))
        .collect();
    activity.insert("also".into(), JsonValue::Array(also));
    check_activity(&JsonValue::Object(activity))
}

/// A shell word as the script spells it.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Word {
    /// The word with quotes removed and any `$NAME` / `${NAME}` left as written.
    text: String,
    /// Contains a parameter expansion: its value is only known when the shell runs it.
    dynamic: bool,
    /// Contains a command or process substitution, or a construct that is never looked inside.
    opaque: bool,
    /// Where the literal text after the last expansion starts in `text`.
    literal_tail: usize,
}

impl Word {
    fn literal(text: &str) -> Self {
        Self {
            text: text.to_string(),
            dynamic: false,
            opaque: false,
            literal_tail: 0,
        }
    }

    /// The word's exact value, when it has one.
    fn exact(&self) -> Option<&str> {
        (!self.dynamic && !self.opaque).then_some(self.text.as_str())
    }

    /// The literal end of the word (all of it when it has no expansion).
    fn tail(&self) -> Option<&str> {
        (!self.opaque).then(|| &self.text[self.literal_tail..])
    }
}

fn node_text<'s>(node: Node<'_>, src: &'s str) -> &'s str {
    node.utf8_text(src.as_bytes()).unwrap_or_default()
}

/// Characters that make a bare word mean something other than its spelling.
fn bare_word_is_literal(text: &str) -> bool {
    !text.starts_with('=')
        && !text.contains(['{', '}', '*', '?', '[', ']', '\\', '~', '^', '#', '$', '`'])
}

fn shell_word(node: Node<'_>, src: &str) -> Word {
    let opaque = || Word {
        text: node_text(node, src).to_string(),
        dynamic: true,
        opaque: true,
        literal_tail: 0,
    };
    match node.kind() {
        "word" | "number" => {
            let text = node_text(node, src);
            let mut cursor = node.walk();
            if node.named_children(&mut cursor).next().is_some() || !bare_word_is_literal(text) {
                return opaque();
            }
            Word::literal(text)
        }
        "raw_string" => {
            let text = node_text(node, src);
            match text
                .strip_prefix('\'')
                .and_then(|text| text.strip_suffix('\''))
            {
                Some(inner) => Word::literal(inner),
                None => opaque(),
            }
        }
        "simple_expansion" | "expansion" => {
            let text = node_text(node, src).to_string();
            let tail = text.len();
            Word {
                text,
                dynamic: true,
                opaque: false,
                literal_tail: tail,
            }
        }
        "string" => {
            let mut word = Word::literal("");
            let mut cursor = node.walk();
            for part in node.named_children(&mut cursor) {
                let part_word = match part.kind() {
                    "string_content" => {
                        let text = node_text(part, src);
                        if text.contains(['\\', '`', '$']) {
                            return opaque();
                        }
                        Word::literal(text)
                    }
                    "simple_expansion" | "expansion" => shell_word(part, src),
                    _ => return opaque(),
                };
                append_word(&mut word, part_word);
            }
            word
        }
        "concatenation" => {
            let mut word = Word::literal("");
            let mut cursor = node.walk();
            for part in node.named_children(&mut cursor) {
                let part_word = shell_word(part, src);
                if part_word.opaque {
                    return opaque();
                }
                append_word(&mut word, part_word);
            }
            word
        }
        _ => opaque(),
    }
}

fn append_word(word: &mut Word, part: Word) {
    let offset = word.text.len();
    word.text.push_str(&part.text);
    if part.dynamic {
        word.dynamic = true;
        word.literal_tail = offset + part.literal_tail;
    }
    word.opaque |= part.opaque;
}

fn basename(program: &str) -> &str {
    program.rsplit('/').next().unwrap_or(program)
}

/// Whether `path` ends in `suffix` at a path boundary.
fn ends_with_path(path: &str, suffix: &str) -> bool {
    path.strip_suffix(suffix)
        .is_some_and(|before| before.is_empty() || before.ends_with('/'))
}

/// The first argument that is not an option, from `start`.
fn first_operand(words: &[Word], start: usize) -> Option<(usize, &Word)> {
    words
        .iter()
        .enumerate()
        .skip(start)
        .find(|(_, word)| !word.text.starts_with('-'))
}

fn is_http_url(text: &str) -> bool {
    reqwest::Url::parse(text).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.host_str().is_some_and(|host| !host.is_empty())
    })
}

/// What the labels are matched against: the installed packs' commands.
struct Matcher<'a> {
    packs: &'a [PackActivity],
    /// Shell functions the script defines that run a pack command: name to (pack index, bin).
    aliases: HashMap<String, (usize, String)>,
    /// Other shell functions the script defines: a call runs the function, not a command.
    shadowed: HashSet<String>,
}

impl<'a> Matcher<'a> {
    fn new(packs: &'a [PackActivity]) -> Self {
        Self {
            packs,
            aliases: HashMap::new(),
            shadowed: HashSet::new(),
        }
    }

    fn bin_by_name(&self, name: &str) -> Option<(usize, String)> {
        if let Some(alias) = self.aliases.get(name) {
            return Some(alias.clone());
        }
        if self.shadowed.contains(name) {
            return None;
        }
        self.packs
            .iter()
            .enumerate()
            .find(|(_, pack)| pack.bins.contains_key(name))
            .map(|(index, _)| (index, name.to_string()))
    }

    /// A path that ends in `<pack>/<entry>` of an installed pack, or in the space launcher
    /// `.agents/skills/<pack>/<space_path>`.
    fn bin_by_path(&self, word: &Word) -> Option<(usize, String)> {
        let tail = word.tail()?;
        for (index, pack) in self.packs.iter().enumerate() {
            for (bin, entry) in &pack.bins {
                if ends_with_path(tail, &format!("{}/{entry}", pack.pack)) {
                    return Some((index, bin.clone()));
                }
            }
            if let Some((space_path, bin)) = &pack.launcher {
                if ends_with_path(tail, &format!(".agents/skills/{}/{space_path}", pack.pack)) {
                    return Some((index, bin.clone()));
                }
            }
        }
        None
    }

    /// The pack command `words` runs and where its arguments start: `uw …`, an alias,
    /// `<path to the entry> …` or `node [options] <path to the entry> …`.
    fn pack_command(&self, words: &[Word]) -> Option<(usize, String, usize)> {
        let program = words.first()?;
        if let Some(name) = program.exact() {
            if let Some((pack, bin)) = self.bin_by_name(basename(name)) {
                return Some((pack, bin, 1));
            }
            if matches!(basename(name), "node" | "nodejs") {
                let mut index = 1;
                while let Some(option) = words.get(index).and_then(Word::exact) {
                    if !option.starts_with('-') {
                        break;
                    }
                    // Inline code or stdin is never a pack command.
                    if matches!(option, "-" | "-e" | "-p" | "--eval" | "--print")
                        || option.starts_with("--eval=")
                        || option.starts_with("--print=")
                    {
                        return None;
                    }
                    let takes_value = matches!(
                        option,
                        "-r" | "--require"
                            | "--import"
                            | "--loader"
                            | "--experimental-loader"
                            | "-C"
                            | "--conditions"
                    );
                    index += if takes_value { 2 } else { 1 };
                }
                let script = words.get(index)?;
                let (pack, bin) = self.bin_by_path(script)?;
                return Some((pack, bin, index + 1));
            }
        }
        let (pack, bin) = self.bin_by_path(program)?;
        Some((pack, bin, 1))
    }

    fn pack_label(&self, words: &[Word]) -> Option<Found> {
        let (pack_index, bin, rest) = self.pack_command(words)?;
        let pack = &self.packs[pack_index];
        let labels = pack.labels.get(&bin)?;
        let subcommand = first_operand(words, rest).and_then(|(_, word)| word.exact());
        let (key, label) = subcommand
            .and_then(|subcommand| labels.get_key_value(subcommand))
            .or_else(|| labels.get_key_value("*"))?;
        Some(Found::pack(pack, &bin, key, label))
    }

    fn instafy_label(words: &[Word]) -> Option<Found> {
        let program = words.first()?.exact()?;
        if basename(program) != "instafy" {
            return None;
        }
        let (first_index, first) = first_operand(words, 1)?;
        let first = first.exact()?;
        let second = first_operand(words, first_index + 1);
        let second_text = second.and_then(|(_, word)| word.exact());
        let label = match (first, second_text) {
            ("web", Some("read")) => {
                let start = second.map_or(words.len(), |(index, _)| index + 1);
                let urls = words[start..]
                    .iter()
                    .filter_map(Word::exact)
                    .filter(|text| is_http_url(text))
                    .count() as u64;
                return Some(Found::builtin(&WEB_READ, (urls > 0).then_some(urls)));
            }
            ("preview", Some("open")) => &PREVIEW_OPEN,
            ("preview", Some("check")) => &PREVIEW_CHECK,
            ("bind", Some("init" | "serve")) => &BIND,
            ("tunnel", Some("start")) => &TUNNEL,
            ("conversation", Some("search" | "grep" | "show")) => &CONVERSATION_SEARCH,
            ("secrets", _) | ("agents", Some("context")) => &SAVED_SETTINGS,
            _ => return None,
        };
        Some(Found::builtin(label, Some(1)))
    }

    fn generic_label(words: &[Word]) -> Option<Found> {
        let program = basename(words.first()?.exact()?);
        // A package manager's subcommand, past options that take a value.
        let subcommand = |value_options: &[&str]| -> Option<(usize, &str)> {
            let mut index = 1;
            while let Some(word) = words.get(index) {
                let text = word.exact()?;
                if !text.starts_with('-') {
                    return Some((index, text));
                }
                index += if value_options.contains(&text) { 2 } else { 1 };
            }
            None
        };
        let label = match program {
            "pnpm" | "npm" | "yarn" => {
                let value_options: &[&str] = &[
                    "--filter",
                    "-F",
                    "-C",
                    "--dir",
                    "--prefix",
                    "--cwd",
                    "-w",
                    "--workspace",
                ];
                let Some((index, sub)) = subcommand(value_options) else {
                    // `yarn` alone installs.
                    return (program == "yarn" && words.len() == 1)
                        .then(|| Found::builtin(&INSTALL, Some(1)));
                };
                let script = || {
                    words
                        .get(index + 1)
                        .and_then(Word::exact)
                        .filter(|_| matches!(sub, "run" | "run-script"))
                };
                match sub {
                    "install" | "i" | "add" => &INSTALL,
                    "ci" if program == "npm" => &INSTALL,
                    "test" => &TESTS,
                    "vitest" if program == "pnpm" => &TESTS,
                    "exec" if program == "pnpm" => match words.get(index + 1).and_then(Word::exact)
                    {
                        Some("vitest") => &TESTS,
                        _ => return None,
                    },
                    "build" if program != "npm" => &BUILD,
                    "run" | "run-script" => match script() {
                        Some("test") => &TESTS,
                        Some("build") => &BUILD,
                        _ => return None,
                    },
                    _ => return None,
                }
            }
            "cargo" => match subcommand(&["--manifest-path", "-Z", "--config"]) {
                Some((_, "test")) => &TESTS,
                Some((_, "build")) => &BUILD,
                _ => return None,
            },
            "pytest" | "vitest" => &TESTS,
            "python" | "python3" => match (words.get(1)?.exact()?, words.get(2)?.exact()?) {
                ("-m", "pytest") => &TESTS,
                _ => return None,
            },
            "npx" => match words.get(1)?.exact()? {
                "vitest" | "pytest" => &TESTS,
                _ => return None,
            },
            "git" => match subcommand(&["-C", "-c", "--git-dir", "--work-tree"]) {
                Some((_, "clone")) => &CLONE,
                _ => return None,
            },
            _ => return None,
        };
        Some(Found::builtin(label, Some(1)))
    }

    /// Drops what runs before the program: `NAME=value`, `env`, `command`, `exec`, `time`,
    /// `nohup` and `timeout <duration>`, with their options.
    fn strip_prefixes(mut words: &[Word]) -> &[Word] {
        loop {
            let Some(first) = words.first() else {
                return words;
            };
            let Some(text) = first.exact() else {
                return words;
            };
            let skip = match text {
                "env" => {
                    let mut index = 1;
                    while let Some(word) = words.get(index) {
                        let Some(arg) = word.exact() else { break };
                        if arg == "-u" || arg == "--unset" || arg == "-C" || arg == "--chdir" {
                            index += 2;
                        } else if arg.starts_with('-') || is_assignment(arg) {
                            index += 1;
                        } else {
                            break;
                        }
                    }
                    index
                }
                "command" | "exec" | "time" | "nohup" => {
                    let mut index = 1;
                    while words
                        .get(index)
                        .and_then(Word::exact)
                        .is_some_and(|arg| arg.starts_with('-'))
                    {
                        index += 1;
                    }
                    index
                }
                "timeout" => {
                    let mut index = 1;
                    while let Some(arg) = words.get(index).and_then(Word::exact) {
                        if matches!(arg, "-s" | "--signal" | "-k" | "--kill-after") {
                            index += 2;
                        } else if arg.starts_with('-') {
                            index += 1;
                        } else {
                            break;
                        }
                    }
                    // the duration
                    index + 1
                }
                _ => return words,
            };
            words = words.get(skip..).unwrap_or_default();
        }
    }

    /// The label of one simple command, in precedence order.
    fn label_words(&self, words: &[Word], in_loop: bool, depth: usize, found: &mut Vec<Found>) {
        let words = Self::strip_prefixes(words);
        let Some(program) = words.first() else {
            return;
        };
        // `bash -lc '<script>'` inside a script.
        if let Some(name) = program.exact() {
            if SHELLS.contains(&basename(name))
                && words
                    .get(1)
                    .and_then(Word::exact)
                    .is_some_and(|flag| SHELL_SCRIPT_FLAGS.contains(&flag))
            {
                if let Some(script) = words.get(2).and_then(Word::exact) {
                    if depth < MAX_NESTED_SHELLS {
                        self.label_script(script, in_loop, depth + 1, found);
                    }
                }
                return;
            }
        }
        let label = self
            .pack_label(words)
            .or_else(|| Self::instafy_label(words))
            .or_else(|| Self::generic_label(words));
        if let Some(mut label) = label {
            if in_loop {
                label.count = None;
            }
            found.push(label);
        }
    }

    fn label_script(&self, script: &str, in_loop: bool, depth: usize, found: &mut Vec<Found>) {
        if script.len() > MAX_SCRIPT_BYTES {
            return;
        }
        let Some(tree) = codex_shell_command::bash::try_parse_shell(script) else {
            return;
        };
        let root = tree.root_node();
        if root.has_error() {
            return;
        }
        // Function definitions first, so a call before its definition in the text still
        // resolves the way the shell does once it has been defined.
        let mut nested = Matcher {
            packs: self.packs,
            aliases: self.aliases.clone(),
            shadowed: self.shadowed.clone(),
        };
        nested.collect_aliases(root, script);
        nested.visit(root, script, in_loop, depth, found);
    }

    fn collect_aliases(&mut self, node: Node<'_>, src: &str) {
        if node.kind() == "function_definition" {
            match self.alias_of(node, src) {
                Some((name, target)) => {
                    self.shadowed.remove(&name);
                    self.aliases.insert(name, target);
                }
                None => {
                    if let Some(name) = node.child_by_field_name("name") {
                        let name = node_text(name, src).to_string();
                        self.aliases.remove(&name);
                        self.shadowed.insert(name);
                    }
                }
            }
            return;
        }
        let mut cursor = node.walk();
        let children: Vec<Node<'_>> = node.named_children(&mut cursor).collect();
        for child in children {
            self.collect_aliases(child, src);
        }
    }

    /// `name() { <pack command> "$@"; }`: a function whose body only runs a pack command with
    /// the function's own arguments.
    fn alias_of(&self, node: Node<'_>, src: &str) -> Option<(String, (usize, String))> {
        let name = node.child_by_field_name("name")?;
        let name = node_text(name, src).to_string();
        let body = node.child_by_field_name("body")?;
        if body.kind() != "compound_statement" {
            return None;
        }
        let mut cursor = body.walk();
        let statements: Vec<Node<'_>> = body
            .named_children(&mut cursor)
            .filter(|child| child.kind() != "comment")
            .collect();
        let [command] = statements.as_slice() else {
            return None;
        };
        if command.kind() != "command" {
            return None;
        }
        let words = command_words(*command, src)?;
        let words = Self::strip_prefixes(&words);
        let (pack, bin, rest) = self.pack_command(words)?;
        let forwards_arguments = words[rest..]
            .iter()
            .all(|word| matches!(word.text.as_str(), "$@" | "${@}"));
        (forwards_arguments && is_shell_name(&name)).then_some((name, (pack, bin)))
    }

    fn visit(
        &self,
        node: Node<'_>,
        src: &str,
        in_loop: bool,
        depth: usize,
        found: &mut Vec<Found>,
    ) {
        match node.kind() {
            "command" => {
                if let Some(words) = command_words(node, src) {
                    self.label_words(&words, in_loop, depth, found);
                }
            }
            "redirected_statement" => {
                if let Some(body) = node.child_by_field_name("body") {
                    self.visit(body, src, in_loop, depth, found);
                }
            }
            "for_statement" | "c_style_for_statement" => {
                if let Some(body) = node.child_by_field_name("body") {
                    self.visit(body, src, true, depth, found);
                }
            }
            "while_statement" => {
                for field in ["condition", "body"] {
                    let mut cursor = node.walk();
                    let parts: Vec<Node<'_>> =
                        node.children_by_field_name(field, &mut cursor).collect();
                    for part in parts {
                        self.visit(part, src, true, depth, found);
                    }
                }
            }
            "program" | "list" | "pipeline" | "compound_statement" | "subshell"
            | "negated_command" | "do_group" | "if_statement" | "elif_clause" | "else_clause" => {
                let mut cursor = node.walk();
                let children: Vec<Node<'_>> = node.named_children(&mut cursor).collect();
                for child in children {
                    self.visit(child, src, in_loop, depth, found);
                }
            }
            // A function body runs only when called; `case` bodies, tests, declarations and
            // anything else are not followed.
            _ => {}
        }
    }
}

fn is_shell_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn is_assignment(text: &str) -> bool {
    text.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty()
            && !name.as_bytes()[0].is_ascii_digit()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    })
}

/// The words of a simple command: its name and arguments, without assignments before it and
/// without redirections.
fn command_words(node: Node<'_>, src: &str) -> Option<Vec<Word>> {
    let mut words = Vec::new();
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        match child.kind() {
            "variable_assignment"
            | "file_redirect"
            | "herestring_redirect"
            | "heredoc_redirect"
            | "comment" => {}
            "command_name" => words.push(shell_word(child.named_child(0)?, src)),
            _ => {
                if words.is_empty() {
                    // An argument before the command name is not a shape this reads.
                    return None;
                }
                words.push(shell_word(child, src));
            }
        }
    }
    (!words.is_empty()).then_some(words)
}

fn label_command_with(
    packs: &[PackActivity],
    argv: Option<&JsonValue>,
    command: &str,
) -> Option<JsonValue> {
    let matcher = Matcher::new(packs);
    let mut found = Vec::new();
    let argv: Option<Vec<&str>> = argv
        .and_then(JsonValue::as_array)
        .and_then(|items| items.iter().map(JsonValue::as_str).collect());
    match argv {
        Some(argv) if !argv.is_empty() => {
            let words: Vec<Word> = argv.iter().map(|word| Word::literal(word)).collect();
            matcher.label_words(&words, false, 0, &mut found);
        }
        _ => matcher.label_script(command, false, 0, &mut found),
    }
    activity_json(found)
}

/// The `activity` of a command, from its argv (`command_argv`), else its command line.
pub fn command_activity(argv: Option<&JsonValue>, command: &str) -> Option<JsonValue> {
    // A turn's messages are rebuilt from its events as they stream, so the same command is
    // labelled many times; the label only depends on the argv and the installed packs.
    static CACHE: OnceLock<Mutex<HashMap<String, Option<JsonValue>>>> = OnceLock::new();
    const MAX_CACHED: usize = 256;
    let cache_key = match argv {
        Some(argv) => argv.to_string(),
        None => command.to_string(),
    };
    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(hit) = cache
        .lock()
        .ok()
        .and_then(|cache| cache.get(&cache_key).cloned())
    {
        return hit;
    }
    let activity = label_command_with(installed_pack_activities(), argv, command);
    if let Ok(mut cache) = cache.lock() {
        if cache.len() >= MAX_CACHED {
            cache.clear();
        }
        cache.insert(cache_key, activity.clone());
    }
    activity
}

/// A web search: "Searching the web", then "searched the web".
pub fn web_search_activity() -> Option<JsonValue> {
    activity_json(vec![Found::builtin(&WEB_SEARCH, Some(1))])
}

/// A file edit touching `paths` distinct files.
pub fn file_change_activity(paths: usize) -> Option<JsonValue> {
    let count = u64::try_from(paths).ok().filter(|count| *count > 0);
    activity_json(vec![Found::builtin(&FILE_EDIT, count.or(Some(1)))])
}

/// A tool call: the browser's own tools say so; any other tool is "a tool".
pub fn mcp_tool_activity(server: &str) -> Option<JsonValue> {
    let label = if BROWSER_MCP_SERVERS.contains(&server) {
        &BROWSER
    } else {
        &TOOL
    };
    activity_json(vec![Found::builtin(label, Some(1))])
}

/// A Shared Browser step, from the facts runtime-agent kept of the browser's own result
/// (`shared_browser_activity::browser_step_facts`): its kind, the host it names, a key of the
/// page and how it was allowed. A step that names no host yet is "Using the browser".
pub fn browser_step_activity(step: &JsonValue) -> Option<JsonValue> {
    let facts = step.as_object()?;
    let kind = facts.get("step")?.as_str()?;
    let host = facts.get("host").and_then(JsonValue::as_str);
    let label = match (kind, host) {
        (_, None) => &BROWSER,
        ("navigate" | "open_tab", Some(_)) => &BROWSER_OPEN,
        ("snapshot", Some(_)) => &BROWSER_READ,
        ("search", Some(_)) => &BROWSER_SEARCH,
        (_, Some(_)) => &BROWSER_BROWSE,
    };
    let mut activity = serde_json::Map::new();
    activity.insert("v".into(), JsonValue::from(ACTIVITY_VERSION));
    activity.extend(Found::builtin(label, Some(1)).entry_json());
    for field in ["host", "pageKey", "step", "approval"] {
        if let Some(value) = facts.get(field) {
            activity.insert(field.into(), value.clone());
        }
    }
    activity.insert("also".into(), JsonValue::Array(Vec::new()));
    check_activity(&JsonValue::Object(activity))
}

/// A status message the runtime writes itself (never one the model wrote): saving the turn's
/// changes and retrying a request.
pub fn runtime_status_activity(kind: &str) -> Option<JsonValue> {
    let label = match kind {
        "workspace_commit" => &SAVING,
        "codex_retry" | "codex_stream_retry" => &RETRYING,
        _ => return None,
    };
    activity_json(vec![Found::builtin(label, Some(1))])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skill_packs::activity::pack_activities;
    use crate::skill_packs::activity::tests::{make_labelled_pack, map_activity};
    use crate::skill_packs::list_packs;
    use std::path::Path;

    /// The maps pack as an installed pack named `interactive-map` with a `uw` command.
    fn map_packs(root: &Path) -> Vec<PackActivity> {
        make_labelled_pack(root, "interactive-map", "uw", map_activity());
        let packs = pack_activities(&list_packs(root));
        assert_eq!(packs.len(), 1);
        packs
    }

    fn label(packs: &[PackActivity], script: &str) -> Option<JsonValue> {
        label_command_with(packs, Some(&json!(["bash", "-lc", script])), "")
    }

    fn key_and_count(activity: &JsonValue) -> (String, JsonValue) {
        (
            activity["key"].as_str().expect("key").to_string(),
            activity["count"].clone(),
        )
    }

    fn keys(activity: &JsonValue) -> Vec<(String, JsonValue)> {
        let mut keys = vec![key_and_count(activity)];
        keys.extend(
            activity["also"]
                .as_array()
                .expect("also")
                .iter()
                .map(key_and_count),
        );
        keys
    }

    #[test]
    fn labels_a_pack_subcommand_from_the_installed_manifest() {
        let root = tempfile::tempdir().expect("tmp");
        let packs = map_packs(root.path());
        let activity =
            label(&packs, "uw add-point --json '{\"name\":\"Belém Tower\"}'").expect("label");
        assert_eq!(activity["v"], json!(1));
        assert_eq!(activity["key"], json!("pack/interactive-map/uw/add-point"));
        assert_eq!(activity["role"], json!("content"));
        assert_eq!(activity["live"], json!("Looking up places"));
        assert_eq!(activity["done"]["other"], json!("looked up {n} places"));
        assert_eq!(activity["count"], json!(1));
        // The same command as argv, without a shell.
        let argv =
            label_command_with(&packs, Some(&json!(["uw", "add-point", "x"])), "").expect("argv");
        assert_eq!(argv, activity);
        // Options before the subcommand, an unlabelled subcommand and validate's outcome.
        assert_eq!(
            label(&packs, "uw --json cite --source a").unwrap()["key"],
            json!("pack/interactive-map/uw/cite")
        );
        let other = label(&packs, "uw snapshot out.png").unwrap();
        assert_eq!(other["key"], json!("pack/interactive-map/uw/*"));
        assert_eq!(other["role"], json!("quiet"));
        let validate = label(&packs, "uw validate").unwrap();
        assert_eq!(validate["role"], json!("outcome"));
        assert_eq!(validate["when"], json!("success"));
        // The full path to the entry, through node, and the space launcher.
        for script in [
            "node /opt/instafy/skill-packs/interactive-map/scripts/run.mjs add-point x",
            "node .agents/skills/interactive-map/scripts/run.mjs add-point x",
            "node \"$INSTAFY_SKILL_PACKS_DIR/interactive-map/scripts/run.mjs\" add-point x",
            "cd map && UW_X=1 timeout 60 node --enable-source-maps ./.agents/skills/interactive-map/scripts/run.mjs add-point x",
        ] {
            assert_eq!(
                label(&packs, script).map(|activity| activity["key"].clone()),
                Some(json!("pack/interactive-map/uw/add-point")),
                "{script}"
            );
        }
        // A file that only looks like it, or inline code, is not the pack.
        for script in [
            "node /tmp/xinteractive-map/scripts/run.mjs add-point",
            "node scripts/run.mjs add-point",
            "node -e 'require(\"./.agents/skills/interactive-map/scripts/run.mjs\")' add-point",
        ] {
            assert_eq!(label(&packs, script), None, "{script}");
        }
    }

    #[test]
    fn octos_alias_then_loop_script_is_add_point_without_a_number() {
        let root = tempfile::tempdir().expect("tmp");
        let packs = map_packs(root.path());
        let script = "uw() { node .agents/skills/interactive-map/scripts/run.mjs \"$@\"; }\n\
            for spec in \\\n  '{\"name\":\"Belém Tower\",\"lat\":38.69,\"lon\":-9.21}' \\\n  '{\"name\":\"Jerónimos\"}'; do\n\
              uw add-point --json \"$spec\" || exit 1\n\
            done\n\
            uw validate && uw fit";
        let activity = label(&packs, script).expect("label");
        assert_eq!(
            keys(&activity),
            vec![
                (
                    "pack/interactive-map/uw/add-point".to_string(),
                    JsonValue::Null
                ),
                ("pack/interactive-map/uw/validate".to_string(), json!(1)),
                ("pack/interactive-map/uw/fit".to_string(), json!(1)),
            ]
        );
        // The function body itself is not a step, and a function of the same name that runs
        // something else shadows the pack's command.
        let not_alias = "uw() { echo hi; }\nuw add-point x";
        assert_eq!(label(&packs, not_alias), None);
        let other_function =
            "go() { node .agents/skills/interactive-map/scripts/run.mjs add-point; }\ngo";
        assert_eq!(label(&packs, other_function), None);
        // Counts add up outside a loop.
        let twice = label(&packs, "uw add-point a && uw add-point b; uw cite c").unwrap();
        assert_eq!(
            keys(&twice),
            vec![
                ("pack/interactive-map/uw/add-point".to_string(), json!(2)),
                ("pack/interactive-map/uw/cite".to_string(), json!(1)),
            ]
        );
        // `while` loops too.
        let while_loop = label(
            &packs,
            "while read -r spec; do uw add-point \"$spec\"; done < specs.txt",
        )
        .unwrap();
        assert_eq!(while_loop["count"], JsonValue::Null);
    }

    #[test]
    fn instafy_web_read_counts_its_urls() {
        let activity = label(
            &[],
            "instafy web read https://www.visitlisboa.com/en/places/belem-tower https://en.wikipedia.org/wiki/Bel%C3%A9m_Tower --max-chars 4000 notes.md \"$URL\"",
        )
        .expect("label");
        assert_eq!(activity["key"], json!("instafy/web-read"));
        assert_eq!(activity["live"], json!("Reading pages"));
        assert_eq!(activity["count"], json!(2));
        let none = label(&[], "instafy web read \"$URL\"").unwrap();
        assert_eq!(none["count"], JsonValue::Null);
        let looped = label(
            &[],
            "for u in a b c; do instafy web read \"https://example.com/$u\"; done",
        )
        .unwrap();
        assert_eq!(looped["count"], JsonValue::Null);
        let summed = label(&[], "instafy web read https://a.example/ && instafy web read https://b.example/ https://c.example/").unwrap();
        assert_eq!(summed["count"], json!(3));
    }

    #[test]
    fn preview_open_is_quiet() {
        let activity = label(
            &[],
            "instafy preview open --port 4173 --title 'Lisbon weekend'",
        )
        .expect("label");
        assert_eq!(activity["key"], json!("instafy/preview-open"));
        assert_eq!(activity["role"], json!("quiet"));
        assert_eq!(activity["live"], json!("Opening the preview"));
        assert!(activity.get("done").is_none());
        let check = label(&[], "instafy preview check --port 4173").unwrap();
        assert_eq!(check["role"], json!("quiet"));
    }

    #[test]
    fn common_tools_have_built_in_labels() {
        for (script, key) in [
            ("pnpm install", "builtin/install"),
            ("npm i left-pad", "builtin/install"),
            ("pnpm --filter @instafy/frontend add zod", "builtin/install"),
            ("yarn", "builtin/install"),
            ("pnpm test", "builtin/test"),
            ("npm run test", "builtin/test"),
            ("cargo test -p runtime-agent", "builtin/test"),
            ("pytest -q", "builtin/test"),
            ("python3 -m pytest", "builtin/test"),
            ("npx vitest run", "builtin/test"),
            ("pnpm build", "builtin/build"),
            ("npm run build", "builtin/build"),
            ("cargo build --release", "builtin/build"),
            ("git clone https://github.com/a/b.git", "builtin/clone"),
            ("git -C repo clone x", "builtin/clone"),
            ("instafy bind init", "instafy/bind"),
            ("instafy tunnel start --port 3000", "instafy/tunnel"),
            (
                "instafy conversation search lisbon",
                "instafy/conversation-search",
            ),
            ("instafy secrets list", "instafy/settings"),
            ("instafy agents context list --json", "instafy/settings"),
        ] {
            assert_eq!(
                label(&[], script).map(|activity| activity["key"].clone()),
                Some(json!(key)),
                "{script}"
            );
        }
        // Plumbing and other git or instafy subcommands are silent.
        for script in [
            "ls -la",
            "cat map.config.json | head -20",
            "git status && git diff",
            "instafy whoami",
            "npm build",
            "pnpm run lint",
            "rg -n uw .",
        ] {
            assert_eq!(label(&[], script), None, "{script}");
        }
    }

    #[test]
    fn unknown_program_is_other() {
        let root = tempfile::tempdir().expect("tmp");
        let packs = map_packs(root.path());
        for script in [
            "python3 build_map.py",
            "./run.sh add-point",
            "curl -s https://example.com",
            "uwx add-point",
        ] {
            assert_eq!(label(&packs, script), None, "{script}");
        }
        // The first labelled step leads, whatever unlabelled ones come first.
        let mixed = label(&packs, "python3 prep.py && uw add-point x").unwrap();
        assert_eq!(mixed["key"], json!("pack/interactive-map/uw/add-point"));
    }

    #[test]
    fn output_never_changes_the_label() {
        let root = tempfile::tempdir().expect("tmp");
        let packs = map_packs(root.path());
        let argv = json!(["bash", "-lc", "uw add-point x"]);
        let first = label_command_with(&packs, Some(&argv), "uw add-point x");
        // The command line is only read when there is no argv; output is never an input.
        let second = label_command_with(
            &packs,
            Some(&argv),
            "Serving map at http://localhost:4173/ on your network: http://172.19.0.3:4173/",
        );
        assert!(first.is_some());
        assert_eq!(first, second);
        // The public entry point takes no output at all.
        let _: fn(Option<&JsonValue>, &str) -> Option<JsonValue> = command_activity;
    }

    #[test]
    fn opaque_substitutions_are_not_matched() {
        let root = tempfile::tempdir().expect("tmp");
        let packs = map_packs(root.path());
        for script in [
            "$(echo uw) add-point x",
            "`echo uw` add-point x",
            "node $(find . -name run.mjs) add-point x",
            "\"$TOOL\" add-point x",
            "eval 'uw add-point x'",
            "echo \"$(uw add-point x)\"",
            "cat <<'EOF'\nuw add-point x\nEOF",
            "case \"$1\" in a) uw add-point x ;; esac",
            "uw() { node x.mjs \"$@\"; }; uw add-point",
            "f() { uw add-point x; }",
            "uw add-point 'unterminated",
        ] {
            assert_eq!(label(&packs, script), None, "{script}");
        }
        // A dynamic subcommand still names the pack, through its `*` label.
        let star = label(&packs, "uw \"$cmd\" x").unwrap();
        assert_eq!(star["key"], json!("pack/interactive-map/uw/*"));
        // A here-document's body is not a command, but the command that reads it is.
        let heredoc = label(
            &packs,
            "uw add-point --json - <<'EOF'\n{\"name\": \"x\"}\nuw cite y\nEOF",
        )
        .unwrap();
        assert_eq!(
            keys(&heredoc),
            vec![("pack/interactive-map/uw/add-point".to_string(), json!(1))]
        );
    }

    #[test]
    fn a_space_imported_pack_supplies_no_labels() {
        // A space's own copy of a pack lives under `.agents/skills/` in the workspace; only the
        // packs installed with the runtime are ever read for labels.
        let workspace = tempfile::tempdir().expect("tmp");
        let skills = workspace.path().join(".agents/skills");
        make_labelled_pack(
            &skills,
            "imported",
            "imp",
            json!({
                "imp": { "*": { "live": "Doing a thing", "done": "did a thing" } }
            }),
        );
        let installed = tempfile::tempdir().expect("tmp");
        let packs = map_packs(installed.path());
        for script in ["imp go", "node .agents/skills/imported/scripts/run.mjs go"] {
            assert_eq!(label(&packs, script), None, "{script}");
        }
        assert!(
            installed_pack_activities()
                .iter()
                .all(|pack| pack.pack != "imported")
        );
    }

    #[test]
    fn nested_shells_are_followed_once_or_twice() {
        let root = tempfile::tempdir().expect("tmp");
        let packs = map_packs(root.path());
        let nested = label_command_with(&packs, None, "bash -lc 'uw add-point x'").unwrap();
        assert_eq!(nested["key"], json!("pack/interactive-map/uw/add-point"));
        let deep = "bash -c \"sh -c 'bash -c \\\"uw add-point x\\\"'\"";
        assert_eq!(label(&packs, deep), None);
        assert_eq!(
            label(&packs, &"uw add-point x; ".repeat(2000)),
            None,
            "over the size cap"
        );
    }

    #[test]
    fn built_in_labels_follow_the_label_rules() {
        for label in [
            &WEB_READ,
            &PREVIEW_OPEN,
            &PREVIEW_CHECK,
            &BIND,
            &TUNNEL,
            &CONVERSATION_SEARCH,
            &SAVED_SETTINGS,
            &INSTALL,
            &TESTS,
            &BUILD,
            &CLONE,
            &WEB_SEARCH,
            &FILE_EDIT,
            &BROWSER,
            &TOOL,
            &SAVING,
            &RETRYING,
        ] {
            assert!(
                activity_json(vec![Found::builtin(label, Some(1))]).is_some(),
                "{}",
                label.key
            );
        }
        assert_eq!(
            web_search_activity().unwrap()["key"],
            json!("builtin/web-search")
        );
        assert_eq!(file_change_activity(3).unwrap()["count"], json!(3));
        assert_eq!(
            mcp_tool_activity("instafy_shared_browser").unwrap()["live"],
            json!("Using the browser")
        );
        assert_eq!(
            mcp_tool_activity("github").unwrap()["done"]["one"],
            json!("used a tool")
        );
        assert_eq!(
            runtime_status_activity("workspace_commit").unwrap()["live"],
            json!("Saving your changes")
        );
        assert_eq!(
            runtime_status_activity("codex_stream_retry").unwrap()["live"],
            json!("Retrying")
        );
        assert_eq!(runtime_status_activity("agent_message"), None);
    }

    // Browser steps name their site from the browser's own state; pages are told apart by
    // `pageKey`, never by their address.
    #[test]
    fn browser_steps_name_their_site_and_how_they_were_allowed() {
        let step = |facts: JsonValue| browser_step_activity(&facts).expect("labelled");
        let search = step(json!({
            "step": "search", "host": "visitlisboa.com", "pageKey": "aaaaaaaaaaaaaaaa",
            "approval": "free",
        }));
        assert_eq!(search["key"], json!("browser/search"));
        assert_eq!(search["live"], json!("Searching {host}"));
        assert_eq!(search["done"]["one"], json!("searched {host}"));
        assert_eq!(search["host"], json!("visitlisboa.com"));
        assert_eq!(search["approval"], json!("free"));
        assert_eq!(search["step"], json!("search"));
        assert_eq!(search["count"], json!(1));
        for (kind, key, role) in [
            ("navigate", "browser/open", "content"),
            ("open_tab", "browser/open", "content"),
            ("snapshot", "browser/read", "content"),
            ("click", "browser/browse", "quiet"),
            ("type", "browser/browse", "quiet"),
            ("submit", "browser/browse", "quiet"),
            ("press", "browser/browse", "quiet"),
            ("scroll", "browser/browse", "quiet"),
            ("tabs", "browser/browse", "quiet"),
            ("status", "browser/browse", "quiet"),
        ] {
            let activity = step(json!({"step": kind, "host": "visitlisboa.com"}));
            assert_eq!(activity["key"], json!(key), "{kind}");
            assert_eq!(activity["role"], json!(role), "{kind}");
        }
        // No host known yet: "Using the browser", with how the step was allowed.
        let unnamed = step(json!({"step": "type", "approval": "denied"}));
        assert_eq!(unnamed["key"], json!("browser/use"));
        assert_eq!(unnamed["live"], json!("Using the browser"));
        assert_eq!(unnamed["approval"], json!("denied"));
        // Anything that breaks the contract is dropped, never shown.
        for facts in [
            json!({"step": "search", "host": "evil.example/path"}),
            json!({"step": "search", "host": "www.visitlisboa.com"}),
            json!({"step": "search", "host": "visitlisboa.com", "approval": "always"}),
            json!({"step": "Call 555", "host": "visitlisboa.com"}),
            json!({"step": "search", "host": "visitlisboa.com", "pageKey": "not-a-key"}),
            json!("search"),
        ] {
            assert_eq!(browser_step_activity(&facts), None, "{facts}");
        }
    }

    #[test]
    fn distinct_pages_count_by_page_key() {
        let read = |page_key: &str| {
            browser_step_activity(&json!({
                "step": "snapshot", "host": "visitlisboa.com", "pageKey": page_key,
            }))
            .expect("labelled")
        };
        let first = read("aaaaaaaaaaaaaaaa");
        let again = read("aaaaaaaaaaaaaaaa");
        let other = read("bbbbbbbbbbbbbbbb");
        // One step reads one page; Studio counts the distinct keys of a group.
        for activity in [&first, &again, &other] {
            assert_eq!(activity["key"], json!("browser/read"));
            assert_eq!(activity["count"], json!(1));
            assert_eq!(
                activity["done"],
                json!({
                    "one": "read a page on {host}",
                    "other": "read {n} pages on {host}",
                    "some": "read pages on {host}",
                })
            );
        }
        assert_eq!(first["pageKey"], again["pageKey"]);
        assert_ne!(first["pageKey"], other["pageKey"]);
        for label in [
            &BROWSER_OPEN,
            &BROWSER_READ,
            &BROWSER_SEARCH,
            &BROWSER_BROWSE,
        ] {
            let mut activity = Found::builtin(label, Some(1)).entry_json();
            activity.insert("v".into(), JsonValue::from(ACTIVITY_VERSION));
            activity.insert("host".into(), JsonValue::from("visitlisboa.com"));
            assert!(
                check_activity(&JsonValue::Object(activity)).is_some(),
                "{}",
                label.key
            );
        }
    }
}
