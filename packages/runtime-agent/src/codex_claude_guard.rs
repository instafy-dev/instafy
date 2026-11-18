//! The command hook that keeps Codex from starting `claude` in the forms its exec-policy rule
//! cannot see (docs/Local-Engine-Turns.md, D22 and phase 8).
//!
//! [`crate::codex`] puts this hook into the managed requirements it gives every Codex session on a
//! Unix runtime, beside the `prefix_rule` that refuses `claude` as a command of its own. Codex runs
//! it as `runtime-agent --codex-claude-guard` ([`HOOK_FLAG`]) before each `exec_command`, a code-mode
//! cell's included, with the command's script in its PreToolUse input on stdin. The hook reads the
//! script with the bash grammar Codex's own splitter uses and refuses it when it would start
//! `claude`:
//! - as any command of the script: in a pipeline, a list, a redirection, a subshell, a group, a
//!   function, a loop or a condition, and inside a command or process substitution, including one
//!   in a variable assignment or an unquoted here-document;
//! - by any spelling of the name: in any letter case, quoted or escaped in whole or in part, split
//!   by a line continuation (`c\` and `laude` on the next line), after variable assignments, as zsh's `=claude`, as the last part of a path whatever its folders are
//!   written with (`~`, `$HOME`, a glob), as a glob the name matches, or as braces that expand to it
//!   (`{claude,x}`, `cl{a..a}ude`);
//! - by a name only the running shell knows whose text names `claude` as a word, such as
//!   `$(which claude)` or `${CLAUDE_BIN:-claude}`;
//! - behind a command that runs the next one: `exec`, `command` (not `command -v`), `builtin`,
//!   `time`, `nohup`, `nice`, `timeout`, `env`, `sudo`, `doas`, `xargs`, `caffeinate`, `stdbuf`,
//!   `setsid`, `arch`, `coproc`, `unbuffer` and zsh's `noglob` and `nocorrect`, nested in any order;
//!   as the program of `find -exec`, `-execdir`, `-ok` or `-okdir`; and as the package
//!   `@anthropic-ai/claude-code` or `claude` of `npx`, `bunx`, `pnpx`, `npm exec`, `pnpm dlx` and
//!   the like, and the `claude` a bare `pnpm`, `yarn` or `bun` runs; and as the program, or the
//!   shell command, that `screen` or `tmux` runs;
//! - in a script that a script hands on: to a shell with `-c` (`sh -c`, `bash -lc`, `zsh -c` and the
//!   rest of [`SHELLS`]), as a here-document or here-string a shell reads, as what an `echo` or a
//!   `printf` prints into a shell's pipe, through `eval`, `trap`, `alias`, `env -S`, `watch`,
//!   `script -c` or `tmux -c`, nested up to [`MAX_DEPTH`] deep.
//!
//! It also refuses a shell that would read its commands from the session's own input, such as a
//! bare `bash`, `zsh -l` or `exec sh`, and `script`, `screen` or `tmux` with no command and not
//! detached, since text written into such a session later (`write_stdin`) passes no hook. A shell
//! that reads a here-document, a here-string, a file, a script file or another command's output is
//! not refused for that.
//!
//! A script the grammar reads with errors, one nested deeper than [`MAX_DEPTH`] and one longer than
//! [`MAX_SCRIPT_BYTES`] are refused when their text names `claude` as a word or, read as plain
//! words, holds one that would start it (`[c]laude`, which the grammar misreads), as is hook input
//! that is not the JSON Codex sends. Codex lets a command run when its hook fails or takes longer
//! than its timeout, so the hook fails closed itself: a check that does not finish within
//! [`CHECK_DEADLINE`], which the grammar can be made to miss with a few kilobytes, or that panics,
//! is refused.
//!
//! What it cannot see stays the gap D22 accepts: a program that starts `claude` itself (`node
//! cli.js`, a Python or Node script, `osascript`), a script file a command runs, another name for
//! the same file (a link, the person's own alias or function), a name built from values the script
//! does not hold (`$CMD`, `cla$X`), a script another program prints into a shell (`cat task.sh |
//! sh`, `bash <(curl …)`), text another program types into a shell (`tmux send-keys`, `expect`), a
//! shell another program starts (`ssh localhost`, `python -c 'pty.spawn(…)'`), and the starts
//! Codex's own configuration makes (an MCP server's `command`, `notify`, other hooks).

use std::io::{Read, Write};

use serde_json::Value;
use tree_sitter::Node;

/// The flag Codex's hook starts runtime-agent's own executable with, which runs [`run_hook`].
pub const HOOK_FLAG: &str = "--codex-claude-guard";

/// What the model is told when the hook refuses a command that would start `claude`. Codex shows
/// it as "Command blocked by PreToolUse hook: <this>. Command: <the command>", so it has no full
/// stop of its own. It says what the exec-policy rule's refusal says.
pub const CLAUDE_REFUSAL: &str = "This runtime does not let an agent start Claude Code. Do the work without it, and do not try another way to start it";

/// What the model is told when the hook refuses a shell that would read commands from the
/// session's input.
pub const SHELL_REFUSAL: &str = "This runtime does not let an agent type commands into a shell it starts. Run each command with its own exec_command call instead";

/// What the model is told when the hook cannot read a command whose text names `claude`.
pub const UNREADABLE_REFUSAL: &str = "This runtime could not read this command, which names Claude Code, and it does not let an agent start Claude Code. Write the command in plain shell syntax, and do the work without Claude Code";

/// What the model is told when the hook could not finish checking a command in time.
pub const UNCHECKED_REFUSAL: &str = "This runtime could not check this command in time, so it did not run it. Run a shorter, plainer command instead";

/// How long the hook spends checking one command before it refuses it ([`refusal_within`]), well
/// within the 30 s Codex gives a hook. An ordinary command takes milliseconds.
pub const CHECK_DEADLINE: std::time::Duration = std::time::Duration::from_secs(5);

/// The longest script the hook parses. A longer one is refused when it names `claude` as a word.
pub const MAX_SCRIPT_BYTES: usize = 256 * 1024;

/// How deep the hook follows scripts that scripts hand on (`sh -c "bash -c '…'"`). A deeper one is
/// refused when it names `claude` as a word.
pub const MAX_DEPTH: usize = 8;

/// The most hook input read. Codex's input is the command and a few fields, far below it.
const MAX_INPUT_BYTES: u64 = 8 * 1024 * 1024;

/// Shells whose `-c` argument is a script and which, with neither `-c` nor a script file, read
/// their commands from standard input.
pub const SHELLS: &[&str] = &[
    "sh", "bash", "zsh", "dash", "ksh", "ksh93", "mksh", "oksh", "pdksh", "yash", "posh", "ash",
    "fish", "csh", "tcsh", "rbash",
];

/// Stands for a value only the running shell knows, such as an expansion's, in a [`Word`]'s text.
const UNKNOWN: char = '\u{0}';

/// Runs the hook: reads Codex's PreToolUse input from stdin and, when its command would start
/// `claude` or type into a shell ([`refusal_for_hook_input`]), writes the reason to stderr and
/// returns 2, which Codex reads as a refusal with that reason. Any other command returns 0 and
/// writes nothing. Exit status 2 and stderr, rather than JSON on stdout, keep the refusal intact
/// when the shell Codex starts the hook with prints something of its own (a `.zshenv`, say).
/// Input it cannot read, and a check that does not finish within [`CHECK_DEADLINE`], are refused,
/// never let through.
pub fn run_hook() -> i32 {
    let mut input = Vec::new();
    let refusal = match std::io::stdin()
        .lock()
        .take(MAX_INPUT_BYTES)
        .read_to_end(&mut input)
    {
        Ok(_) => refusal_within(input, CHECK_DEADLINE),
        Err(_) => Some(UNREADABLE_REFUSAL),
    };
    match refusal {
        Some(reason) => {
            let _ = writeln!(std::io::stderr(), "{reason}");
            2
        }
        None => 0,
    }
}

/// [`refusal_for_hook_input`] on a thread of its own, or [`UNCHECKED_REFUSAL`] when it does not
/// answer within `deadline` or fails. Codex lets a command run when its hook takes longer than the
/// hook's timeout, and the bash grammar can spend minutes on a few kilobytes written to be slow
/// (16 KiB of `${` takes it five seconds, 64 KiB more than a minute), so the hook answers first.
/// The thread that is still parsing ends with the hook's process.
pub fn refusal_within(input: Vec<u8>, deadline: std::time::Duration) -> Option<&'static str> {
    let (sender, receiver) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("codex-claude-guard".to_string())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || {
            let _ = sender.send(refusal_for_hook_input(&input));
        });
    if spawned.is_err() {
        return Some(UNCHECKED_REFUSAL);
    }
    // A check that panicked drops its sender, which reads as a refusal too.
    receiver
        .recv_timeout(deadline)
        .unwrap_or(Some(UNCHECKED_REFUSAL))
}

/// The refusal for one PreToolUse input, if its command would start `claude` or type into a shell.
/// Input with no command, such as another tool's, is let through; input that is not JSON, or
/// whose command is neither a script nor a list of words, is refused when it names `claude`.
pub fn refusal_for_hook_input(input: &[u8]) -> Option<&'static str> {
    let Ok(value) = serde_json::from_slice::<Value>(input) else {
        return unreadable(&String::from_utf8_lossy(input));
    };
    match value.pointer("/tool_input/command") {
        None | Some(Value::Null) => None,
        Some(Value::String(script)) => refusal_for_script(script),
        Some(Value::Array(argv)) => match argv
            .iter()
            .map(|word| word.as_str().map(Word::literal))
            .collect::<Option<Vec<_>>>()
        {
            Some(words) => check_words(&words, &Stdin::Session, 0),
            None => unreadable(&Value::Array(argv.clone()).to_string()),
        },
        Some(other) => unreadable(&other.to_string()),
    }
}

/// The refusal for a script that Codex would run as `<shell> -c <script>`, if it would start
/// `claude` or type into a shell.
pub fn refusal_for_script(script: &str) -> Option<&'static str> {
    check_script(script, 0)
}

fn check_script(script: &str, depth: usize) -> Option<&'static str> {
    if depth > MAX_DEPTH || script.len() > MAX_SCRIPT_BYTES {
        return unreadable(script);
    }
    let Some(tree) = codex_shell_command::bash::try_parse_shell(script) else {
        return unreadable(script);
    };
    let root = tree.root_node();
    let walk = Walk { src: script, depth };
    if let Some(refusal) = walk.every_command(root) {
        return Some(refusal);
    }
    // The grammar recovered from an error, and may have split a word it misread (it reads
    // `[c]laude` as a test and a command `laude`): what it read is checked above, and the rest is
    // read as plain words.
    if root.has_error() {
        return unreadable(script);
    }
    None
}

/// The refusal for text the grammar cannot read: [`UNREADABLE_REFUSAL`] when the text names
/// `claude` as a word, or holds a word that would start `claude` as a program (`[c]laude`).
fn unreadable(text: &str) -> Option<&'static str> {
    // A plain word may be any argument, so braces the hook does not expand do not count here.
    (names_claude_as_a_word(text)
        || plain_words(text)
            .iter()
            .any(|word| names_claude_program(word, false)))
    .then_some(UNREADABLE_REFUSAL)
}

/// Whether `text` holds `claude`, in any letter case, as a word of its own: between characters
/// that are not ASCII letters or digits, or the text's ends. `claude`, `$(which claude)`,
/// `~/.local/bin/claude` and `CLAUDE_BIN` do; `claudette` and `fake_claude2` do not.
pub fn names_claude_as_a_word(text: &str) -> bool {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .any(|word| word.eq_ignore_ascii_case("claude"))
}

/// The words of a shell text read without its grammar: split at unquoted white space and the
/// operators `; & | ( ) < >`, with quotes and backslashes removed.
fn plain_words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match (quote, c) {
            (Some(open), c) if c == open => quote = None,
            // A backslash escapes the next character; before a line break, it joins the lines.
            (Some('"'), '\\') | (None, '\\') => match chars.next() {
                Some('\n') | None => {}
                Some(escaped) => word.push(escaped),
            },
            (Some(_), c) => word.push(c),
            (None, '\'' | '"') => quote = Some(c),
            (None, c) if c.is_whitespace() || ";&|()<>".contains(c) => {
                if !word.is_empty() {
                    words.push(std::mem::take(&mut word));
                }
            }
            (None, c) => word.push(c),
        }
    }
    if !word.is_empty() {
        words.push(word);
    }
    words
}

/// One walk over a parsed script.
struct Walk<'s> {
    src: &'s str,
    depth: usize,
}

impl Walk<'_> {
    /// Checks every simple command in the tree, wherever it sits: substitutions, here-documents and
    /// the nodes of error recovery included, and the backquoted commands of unquoted here-documents,
    /// which the grammar leaves as text.
    fn every_command(&self, root: Node<'_>) -> Option<&'static str> {
        let mut stack = vec![root];
        while let Some(node) = stack.pop() {
            let refusal = match node.kind() {
                "command" => self.command(node),
                "heredoc_redirect" => self.heredoc_backquotes(node),
                _ => None,
            };
            if refusal.is_some() {
                return refusal;
            }
            let mut cursor = node.walk();
            stack.extend(node.children(&mut cursor));
        }
        None
    }

    fn command(&self, node: Node<'_>) -> Option<&'static str> {
        let words = command_words(node, self.src);
        if words.is_empty() {
            return None;
        }
        check_words(&words, &Stdin::of(node, self.src), self.depth)
    }

    /// An unquoted here-document's backquoted commands run when the shell reads it, whoever reads
    /// it; the grammar parses its `$(…)` but leaves `` `…` `` as text.
    fn heredoc_backquotes(&self, node: Node<'_>) -> Option<&'static str> {
        let mut cursor = node.walk();
        let children: Vec<Node<'_>> = node.named_children(&mut cursor).collect();
        let quoted = children
            .iter()
            .find(|child| child.kind() == "heredoc_start")
            .is_some_and(|start| text(*start, self.src).contains(['\'', '"', '\\']));
        if quoted {
            return None;
        }
        children
            .iter()
            .filter(|child| child.kind() == "heredoc_body")
            .flat_map(|body| backquoted(text(*body, self.src)))
            .find_map(|script| check_script(&script, self.depth + 1))
    }
}

/// A simple command's words, the program first: its variable assignments and redirections left
/// out. Two parts with only a backslash and a line break between them are one word, as the shell
/// reads them: `c\` and then `laude` on the next line is `claude`, though the grammar reads two.
fn command_words(node: Node<'_>, src: &str) -> Vec<Word> {
    let mut words: Vec<Word> = Vec::new();
    let mut named = false;
    let mut last_end = None;
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        let part = match child.kind() {
            "command_name" => {
                named = true;
                child.named_child(0)
            }
            "variable_assignment"
            | "file_redirect"
            | "herestring_redirect"
            | "heredoc_redirect"
            | "comment" => None,
            _ if named => Some(child),
            _ => None,
        };
        let Some(part) = part else {
            last_end = None;
            continue;
        };
        let word = Word::of(part, src);
        let joined = last_end.is_some_and(|end| {
            src.get(end..part.start_byte())
                .is_some_and(|gap| gap == "\\\n" || gap == "\\\r\n")
        });
        match (joined, words.last_mut()) {
            (true, Some(previous)) => previous.join(word),
            _ => words.push(word),
        }
        last_end = Some(part.end_byte());
    }
    words
}

/// What a statement prints, when it is an `echo` or a `printf` whose words the script holds: the
/// script a shell after it in a pipeline reads. `echo`'s words are joined with spaces, as it
/// prints them; `printf`'s are taken a line each, its format with them.
fn printed_script(statement: Node<'_>, src: &str) -> Option<String> {
    let command = match statement.kind() {
        "redirected_statement" => statement.child_by_field_name("body")?,
        _ => statement,
    };
    if command.kind() != "command" {
        return None;
    }
    let words = command_words(command, src);
    let (program, args) = words.split_first()?;
    match program_name(program)?.as_str() {
        "echo" => Some(
            args.iter()
                .filter(|word| !matches!(word.known(), Some("-n" | "-e" | "-E" | "-ne" | "-en")))
                .map(|word| word.script.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        ),
        "printf" => Some(
            args.iter()
                .map(|word| word.script.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => None,
    }
}

/// The text of a node.
fn text<'s>(node: Node<'_>, src: &'s str) -> &'s str {
    node.utf8_text(src.as_bytes()).unwrap_or_default()
}

/// The commands between unescaped backquotes.
fn backquoted(text: &str) -> Vec<String> {
    let mut scripts = Vec::new();
    let mut current: Option<String> = None;
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let escaped = chars.next();
                if let (Some(script), Some(escaped)) = (current.as_mut(), escaped) {
                    script.push(escaped);
                }
            }
            '`' => match current.take() {
                Some(script) => scripts.push(script),
                None => current = Some(String::new()),
            },
            c => {
                if let Some(script) = current.as_mut() {
                    script.push(c);
                }
            }
        }
    }
    scripts.extend(current);
    scripts
}

/// One word of a command as the shell would see it before it runs anything, in two readings.
#[derive(Clone, Debug)]
struct Word {
    /// Quotes and escapes removed, and each expansion or substitution replaced by [`UNKNOWN`]: the
    /// reading for a program's name or an option.
    text: String,
    /// Quotes and escapes removed, and each expansion or substitution kept as written: the reading
    /// for a script the word hands on, where those are again expansions.
    script: String,
    /// The word as written.
    raw: String,
}

impl Word {
    fn of(node: Node<'_>, src: &str) -> Self {
        let mut word = Self {
            text: String::new(),
            script: String::new(),
            raw: text(node, src).to_string(),
        };
        word.append(node, src);
        word
    }

    fn literal(value: &str) -> Self {
        Self {
            text: value.to_string(),
            script: value.to_string(),
            raw: value.to_string(),
        }
    }

    fn append(&mut self, node: Node<'_>, src: &str) {
        match node.kind() {
            "word" | "number" => self.push(&unescape_unquoted(text(node, src))),
            "raw_string" => {
                let raw = text(node, src);
                self.push(
                    raw.strip_prefix('\'')
                        .and_then(|raw| raw.strip_suffix('\''))
                        .unwrap_or(raw),
                );
            }
            "ansi_c_string" => self.push(&decode_ansi_c(text(node, src))),
            "string" => {
                // Read the text between the quotes by byte range, so that what the grammar's
                // `string_content` pieces leave out, such as line breaks, stays in the value.
                let (start, end) = (node.start_byte(), node.end_byte());
                let quoted = text(node, src);
                let (mut at, end) =
                    if quoted.len() >= 2 && quoted.starts_with('"') && quoted.ends_with('"') {
                        (start + 1, end - 1)
                    } else {
                        (start, end)
                    };
                let mut cursor = node.walk();
                for part in node.named_children(&mut cursor) {
                    if part.kind() == "string_content" || part.start_byte() < at {
                        continue;
                    }
                    self.push(&unescape_double_quoted(
                        src.get(at..part.start_byte()).unwrap_or_default(),
                    ));
                    self.unknown(text(part, src));
                    at = part.end_byte().min(end);
                }
                self.push(&unescape_double_quoted(
                    src.get(at..end).unwrap_or_default(),
                ));
            }
            "concatenation" | "translated_string" => {
                let mut cursor = node.walk();
                for part in node.named_children(&mut cursor) {
                    self.append(part, src);
                }
            }
            _ => self.unknown(text(node, src)),
        }
    }

    fn push(&mut self, value: &str) {
        self.text.push_str(value);
        self.script.push_str(value);
    }

    /// The next part of the same word, which a line continuation split from this one.
    fn join(&mut self, next: Word) {
        self.text.push_str(&next.text);
        self.script.push_str(&next.script);
        self.raw.push_str("\\\n");
        self.raw.push_str(&next.raw);
    }

    fn unknown(&mut self, written: &str) {
        self.text.push(UNKNOWN);
        self.script.push_str(written);
    }

    /// The word's value, when the script alone decides it.
    fn known(&self) -> Option<&str> {
        (!self.text.contains(UNKNOWN)).then_some(self.text.as_str())
    }
}

/// An unquoted word's value: each backslash escapes the next character, and a backslash before a
/// line break joins the lines.
fn unescape_unquoted(word: &str) -> String {
    let mut value = String::with_capacity(word.len());
    let mut chars = word.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            value.push(c);
            continue;
        }
        match chars.next() {
            Some('\n') | None => {}
            Some(escaped) => value.push(escaped),
        }
    }
    value
}

/// The value of a double-quoted part: a backslash escapes only `$`, `` ` ``, `"`, `\` and a line
/// break, and stays before anything else.
fn unescape_double_quoted(content: &str) -> String {
    let mut value = String::with_capacity(content.len());
    let mut chars = content.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && let Some(&next) = chars.peek()
            && matches!(next, '$' | '`' | '"' | '\\' | '\n')
        {
            chars.next();
            if next != '\n' {
                value.push(next);
            }
            continue;
        }
        value.push(c);
    }
    value
}

/// The value of a `$'…'` word, with its backslash escapes decoded.
fn decode_ansi_c(word: &str) -> String {
    let body = word
        .strip_prefix("$'")
        .and_then(|body| body.strip_suffix('\''))
        .unwrap_or(word);
    fn digits(
        chars: &mut std::iter::Peekable<std::str::Chars<'_>>,
        radix: u32,
        most: usize,
    ) -> Option<u32> {
        let mut number = 0u32;
        let mut read = 0;
        while read < most {
            let Some(digit) = chars.peek().and_then(|c| c.to_digit(radix)) else {
                break;
            };
            number = number.saturating_mul(radix).saturating_add(digit);
            chars.next();
            read += 1;
        }
        (read > 0).then_some(number)
    }
    let mut value = String::with_capacity(body.len());
    let mut chars = body.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\\' {
            value.push(c);
            continue;
        }
        let Some(escape) = chars.next() else {
            value.push('\\');
            break;
        };
        let decoded = match escape {
            'a' => Some('\u{7}'),
            'b' => Some('\u{8}'),
            'e' | 'E' => Some('\u{1b}'),
            'f' => Some('\u{c}'),
            'n' => Some('\n'),
            'r' => Some('\r'),
            't' => Some('\t'),
            'v' => Some('\u{b}'),
            '\\' | '\'' | '"' | '?' => Some(escape),
            'x' => digits(&mut chars, 16, 2).and_then(char::from_u32),
            'u' => digits(&mut chars, 16, 4).and_then(char::from_u32),
            'U' => digits(&mut chars, 16, 8).and_then(char::from_u32),
            'c' => chars.next().map(|c| char::from((c as u8) & 0x1f)),
            '0'..='7' => {
                let mut number = escape.to_digit(8).unwrap_or_default();
                for _ in 0..2 {
                    match chars.peek().and_then(|c| c.to_digit(8)) {
                        Some(digit) => {
                            number = number * 8 + digit;
                            chars.next();
                        }
                        None => break,
                    }
                }
                char::from_u32(number)
            }
            other => {
                value.push('\\');
                Some(other)
            }
        };
        value.extend(decoded);
    }
    value
}

/// Where a command's standard input comes from, as far as the script says.
enum Stdin {
    /// The input the script itself has: for Codex's command, the session's, which `write_stdin`
    /// writes to.
    Session,
    /// A file, another command's output, or anything else the script names.
    Elsewhere,
    /// A here-document's or here-string's text.
    Text(String),
}

impl Stdin {
    fn of(command: Node<'_>, src: &str) -> Self {
        let statement = command
            .parent()
            .filter(|parent| parent.kind() == "redirected_statement")
            .unwrap_or(command);
        let mut redirects = Vec::new();
        for node in [command, statement] {
            let mut cursor = node.walk();
            redirects.extend(node.named_children(&mut cursor).filter(|child| {
                matches!(
                    child.kind(),
                    "file_redirect" | "herestring_redirect" | "heredoc_redirect"
                )
            }));
            if statement == command {
                break;
            }
        }
        for redirect in redirects {
            match redirect.kind() {
                "herestring_redirect" if reads_stdin(redirect, src) => {
                    let mut cursor = redirect.walk();
                    let value = redirect
                        .named_children(&mut cursor)
                        .filter(|child| child.kind() != "file_descriptor")
                        .last()
                        .map(|value| Word::of(value, src).script)
                        .unwrap_or_default();
                    return Self::Text(value);
                }
                "heredoc_redirect" => {
                    let mut cursor = redirect.walk();
                    let body = redirect
                        .named_children(&mut cursor)
                        .find(|child| child.kind() == "heredoc_body")
                        .map(|body| text(body, src).to_string())
                        .unwrap_or_default();
                    return Self::Text(body);
                }
                "file_redirect" if reads_stdin(redirect, src) => return Self::Elsewhere,
                _ => {}
            }
        }
        let Some(pipeline) = statement
            .parent()
            .filter(|parent| parent.kind() == "pipeline")
        else {
            return Self::Session;
        };
        if let Some(previous) = statement.prev_named_sibling() {
            // `echo 'claude -p …' | bash`: a shell reads what the command before it prints.
            return printed_script(previous, src).map_or(Self::Elsewhere, Self::Text);
        }
        // `cat <<EOF | bash`: the grammar puts the pipeline inside the here-document's redirect,
        // so the first command after the `|` reads what the here-document's command prints, read
        // here as the here-document itself.
        match pipeline
            .parent()
            .filter(|parent| parent.kind() == "heredoc_redirect")
        {
            Some(redirect) => {
                let mut cursor = redirect.walk();
                let body = redirect
                    .named_children(&mut cursor)
                    .find(|child| child.kind() == "heredoc_body")
                    .map(|body| text(body, src).to_string())
                    .unwrap_or_default();
                Self::Text(body)
            }
            None => Self::Session,
        }
    }
}

/// Whether a redirection sets standard input: an input operator (`<`, `<&`, `<>`, `<<<`) on no
/// descriptor or on descriptor 0.
fn reads_stdin(redirect: Node<'_>, src: &str) -> bool {
    let mut cursor = redirect.walk();
    let mut descriptor = None;
    let mut input = false;
    for child in redirect.children(&mut cursor) {
        if child.kind() == "file_descriptor" {
            descriptor = Some(text(child, src).to_string());
        } else if !child.is_named() {
            let operator = child.kind();
            if operator.starts_with('<') && !operator.starts_with("<<") || operator == "<<<" {
                input = true;
            }
            if operator.contains('<') || operator.contains('>') {
                break;
            }
        }
    }
    input && descriptor.is_none_or(|descriptor| descriptor == "0")
}

/// Checks one simple command, given as its words, the program first, and where its input comes
/// from. A command that runs another one hands the next round that program.
fn check_words(words: &[Word], stdin: &Stdin, depth: usize) -> Option<&'static str> {
    let mut index = 0;
    while let Some(program) = words.get(index) {
        if starts_claude(program) {
            return Some(CLAUDE_REFUSAL);
        }
        let name = program_name(program)?;
        let args = &words[index + 1..];
        match wrapped(&name, args) {
            Some(Wrapped::Program(offset)) => {
                index += 1 + offset;
                continue;
            }
            Some(Wrapped::Script(script)) => return check_script(&script, depth + 1),
            Some(Wrapped::Shell) => return check_shell_input(stdin, depth),
            Some(Wrapped::Nothing) => return None,
            None => {}
        }
        return match name.as_str() {
            "eval" => check_script(&join_scripts(args), depth + 1),
            "alias" => args.iter().find_map(|word| {
                word.script
                    .split_once('=')
                    .and_then(|(_, value)| check_script(value, depth + 1))
            }),
            "trap" => trap_action(args).and_then(|action| check_script(&action, depth + 1)),
            "find" => check_find(args, depth),
            "npx" | "bunx" | "pnpx" => check_package_runner(args, depth),
            "npm" | "pnpm" | "yarn" | "bun" => {
                let command = args
                    .iter()
                    .position(|word| !word.known().is_some_and(|arg| arg.starts_with('-')))?;
                match args[command].known() {
                    Some("exec" | "x" | "dlx") => check_package_runner(&args[command + 1..], depth),
                    // `pnpm claude`, `yarn claude` and `bun claude` run a package's own `claude`.
                    _ if name != "npm"
                        && (starts_claude(&args[command])
                            || args[command].known().is_some_and(is_claude_package)) =>
                    {
                        Some(CLAUDE_REFUSAL)
                    }
                    _ => None,
                }
            }
            "busybox"
                if args
                    .first()
                    .and_then(program_name)
                    .is_some_and(|shell| SHELLS.contains(&shell.as_str())) =>
            {
                check_shell(&args[1..], stdin, depth)
            }
            shell if SHELLS.contains(&shell) => check_shell(args, stdin, depth),
            _ => None,
        };
    }
    None
}

/// Whether running this word as a program starts `claude` ([`file_name_is_claude`]), or, for a
/// name only the shell knows, whether its text names `claude` as a word.
fn starts_claude(word: &Word) -> bool {
    let value = word.text.strip_prefix('=').unwrap_or(&word.text);
    let file_name = value.rsplit(['/', '\\']).next().unwrap_or(value);
    if file_name.contains(UNKNOWN) {
        return names_claude_as_a_word(&word.raw);
    }
    // A program's name whose braces the hook does not expand is refused.
    names_claude_program(value, true)
}

/// Whether `program` names `claude` ([`file_name_is_claude`]), after brace expansion: a shell runs
/// the first non-empty word its braces make, and passes the others to it as arguments, so
/// `cl{a,}ude` and `{,claude}` start `claude` and `{x,claude}` starts `x`. `too_many` answers for a
/// word whose braces the hook does not expand: one longer than [`MAX_BRACE_TEXT`], one nested
/// deeper than 64 levels, or one whose every word is empty.
fn names_claude_program(program: &str, too_many: bool) -> bool {
    if program.contains('{') && program.contains('}') {
        if program.len() > MAX_BRACE_TEXT {
            return too_many;
        }
        return match brace_words(program, true)
            .and_then(|words| words.into_iter().find(|word| !word.is_empty()))
        {
            Some(first) => file_name_is_claude(&first),
            None => too_many,
        };
    }
    file_name_is_claude(program)
}

/// The most words the hook expands a brace expression to.
const MAX_BRACE_WORDS: usize = 1024;

/// The longest word whose braces the hook expands. A program's name is far shorter.
const MAX_BRACE_TEXT: usize = 4096;

/// The words a shell's brace expansion makes of `text`, in the shell's order: `{a,b}` and `{a..e}`
/// or `{1..9..2}`, nested and side by side; `text` itself when it has none. With `first`, it stops
/// at the first non-empty word. `None` past [`MAX_BRACE_WORDS`] words or 64 nested expansions.
fn brace_words(text: &str, first: bool) -> Option<Vec<String>> {
    fn expand(chars: &[char], depth: usize, first: bool, words: &mut Vec<String>) -> Option<()> {
        if depth > 64 {
            return None;
        }
        for open in 0..chars.len() {
            if chars[open] != '{' {
                continue;
            }
            let mut level = 0usize;
            let mut close = None;
            let mut commas = Vec::new();
            for (at, c) in chars.iter().enumerate().skip(open) {
                match c {
                    '{' => level += 1,
                    '}' => {
                        level -= 1;
                        if level == 0 {
                            close = Some(at);
                            break;
                        }
                    }
                    ',' if level == 1 => commas.push(at),
                    _ => {}
                }
            }
            let Some(close) = close else { continue };
            let alternatives: Vec<Vec<char>> = if commas.is_empty() {
                let inner: String = chars[open + 1..close].iter().collect();
                match sequence(&inner)? {
                    Some(sequence) => sequence,
                    None => continue,
                }
            } else {
                let mut bounds = vec![open];
                bounds.extend(&commas);
                bounds.push(close);
                bounds
                    .windows(2)
                    .map(|pair| chars[pair[0] + 1..pair[1]].to_vec())
                    .collect()
            };
            for alternative in alternatives {
                let mut word = chars[..open].to_vec();
                word.extend(alternative);
                word.extend_from_slice(&chars[close + 1..]);
                expand(&word, depth + 1, first, words)?;
                if first && words.iter().any(|word| !word.is_empty()) {
                    break;
                }
            }
            return Some(());
        }
        words.push(chars.iter().collect());
        (words.len() <= MAX_BRACE_WORDS).then_some(())
    }
    /// `x..y` or `x..y..step` of integers or single letters: `Some(None)` when `inner` is no
    /// sequence, `None` when it has too many words.
    fn sequence(inner: &str) -> Option<Option<Vec<Vec<char>>>> {
        let parts: Vec<&str> = inner.split("..").collect();
        let step = match parts.len() {
            2 => 1,
            3 => match parts[2].parse::<i64>() {
                Ok(step) => step.unsigned_abs().max(1),
                Err(_) => return Some(None),
            },
            _ => return Some(None),
        };
        let words: Vec<String> = match (parts[0].parse::<i64>(), parts[1].parse::<i64>()) {
            (Ok(from), Ok(to)) => {
                if from.abs_diff(to) / step >= MAX_BRACE_WORDS as u64 {
                    return None;
                }
                let mut words = Vec::new();
                let mut at = from;
                loop {
                    words.push(at.to_string());
                    if at == to || at.abs_diff(to) < step {
                        break;
                    }
                    at = if to > from {
                        at + step as i64
                    } else {
                        at - step as i64
                    };
                }
                words
            }
            _ => {
                let (mut from, mut to) = (parts[0].chars(), parts[1].chars());
                let (Some(from), None, Some(to), None) =
                    (from.next(), from.next(), to.next(), to.next())
                else {
                    return Some(None);
                };
                if !from.is_ascii_alphabetic() || !to.is_ascii_alphabetic() {
                    return Some(None);
                }
                let (low, high) = if from <= to { (from, to) } else { (to, from) };
                (low..=high)
                    .step_by(step as usize)
                    .map(String::from)
                    .collect()
            }
        };
        Some(Some(
            words
                .into_iter()
                .map(|word| word.chars().collect())
                .collect(),
        ))
    }
    let mut words = Vec::new();
    expand(&text.chars().collect::<Vec<_>>(), 0, first, &mut words)?;
    Some(words)
}

/// Whether the program `program` names is `claude`: its file name, the last part of a path, is
/// `claude` in any letter case, also with a Windows program extension, or is a glob with a letter
/// of its own that matches it; zsh runs `=claude` as the program `claude` names.
fn file_name_is_claude(program: &str) -> bool {
    let program = program.strip_prefix('=').unwrap_or(program);
    let file_name = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let file_name = without_program_extension(file_name);
    if file_name.contains(['*', '?', '[']) {
        file_name.contains(|c: char| c.is_ascii_alphabetic()) && glob_matches_claude(file_name)
    } else {
        file_name.eq_ignore_ascii_case("claude")
    }
}

/// A known program's file name, in lower case and without a Windows program extension.
fn program_name(word: &Word) -> Option<String> {
    let value = word.known()?;
    let value = value.strip_prefix('=').unwrap_or(value);
    let file_name = value.rsplit(['/', '\\']).next().unwrap_or(value);
    Some(without_program_extension(file_name).to_ascii_lowercase())
}

fn without_program_extension(file_name: &str) -> &str {
    for extension in [".exe", ".cmd", ".bat", ".com", ".ps1"] {
        if file_name.len() > extension.len()
            && file_name.is_char_boundary(file_name.len() - extension.len())
            && file_name[file_name.len() - extension.len()..].eq_ignore_ascii_case(extension)
        {
            return &file_name[..file_name.len() - extension.len()];
        }
    }
    file_name
}

/// Whether a glob (`*`, `?`, `[…]`) matches `claude`, ignoring letter case, as macOS folders do.
/// The pattern is read into tokens first, with each run of `*` as one, so that matching takes a
/// few steps whatever the pattern's length: one with more single-character tokens than `claude`
/// has characters matches nothing.
fn glob_matches_claude(pattern: &str) -> bool {
    enum Token {
        Any,
        One,
        Set { negated: bool, set: Vec<char> },
        Char(char),
    }
    fn set_holds(negated: bool, set: &[char], c: char) -> bool {
        let mut found = false;
        let mut at = 0;
        while at < set.len() {
            if at + 2 < set.len() && set[at + 1] == '-' {
                let (low, high) = (
                    set[at].to_ascii_lowercase(),
                    set[at + 2].to_ascii_lowercase(),
                );
                found |= (low..=high).contains(&c);
                at += 3;
            } else {
                found |= set[at].to_ascii_lowercase() == c;
                at += 1;
            }
        }
        found != negated
    }
    fn matches(tokens: &[Token], name: &[char]) -> bool {
        match tokens.split_first() {
            None => name.is_empty(),
            Some((Token::Any, rest)) => (0..=name.len()).any(|skip| matches(rest, &name[skip..])),
            Some((Token::One, rest)) => !name.is_empty() && matches(rest, &name[1..]),
            Some((Token::Set { negated, set }, rest)) => name
                .first()
                .is_some_and(|c| set_holds(*negated, set, *c) && matches(rest, &name[1..])),
            Some((Token::Char(c), rest)) => {
                name.first() == Some(&c.to_ascii_lowercase()) && matches(rest, &name[1..])
            }
        }
    }
    const NAME: &str = "claude";
    let chars: Vec<char> = pattern.chars().collect();
    let mut tokens = Vec::new();
    let mut single = 0;
    let mut at = 0;
    while at < chars.len() {
        let token = match chars[at] {
            '*' => {
                at += 1;
                if !matches!(tokens.last(), Some(Token::Any)) {
                    tokens.push(Token::Any);
                }
                continue;
            }
            '?' => Token::One,
            '[' => match chars[at + 1..]
                .iter()
                .skip(1)
                .position(|c| *c == ']')
                .map(|close| at + 2 + close)
            {
                Some(close) => {
                    let (negated, from) = match chars.get(at + 1) {
                        Some('!' | '^') => (true, at + 2),
                        _ => (false, at + 1),
                    };
                    let set = chars[from.min(close)..close].to_vec();
                    at = close;
                    Token::Set { negated, set }
                }
                None => Token::Char('['),
            },
            c => Token::Char(c),
        };
        at += 1;
        single += 1;
        if single > NAME.len() {
            return false;
        }
        tokens.push(token);
    }
    matches(&tokens, &NAME.chars().collect::<Vec<_>>())
}

/// What a command that runs another one runs.
enum Wrapped {
    /// The program at this offset of its arguments, with the arguments after it.
    Program(usize),
    /// A script.
    Script(String),
    /// A shell that reads the command's input.
    Shell,
    /// Nothing: it only looks a program up, or was given none.
    Nothing,
}

/// How a command that runs another one reads its options before that program.
struct Options {
    /// Short options that take a value, in the same word (`-uUSER`) or the next (`-u USER`).
    values: &'static str,
    /// Long options that take the next word as their value when written without `=`.
    long_values: &'static [&'static str],
    /// Operands before the program, such as `timeout`'s duration.
    operands: usize,
    /// Whether `NAME=VALUE` words before the program set its environment.
    assignments: bool,
}

impl Options {
    const NONE: Self = Self {
        values: "",
        long_values: &[],
        operands: 0,
        assignments: false,
    };

    fn program(&self, args: &[Word]) -> Wrapped {
        let mut index = 0;
        let mut operands = self.operands;
        while let Some(arg) = args.get(index).and_then(Word::known) {
            if arg == "--" {
                index += 1;
                break;
            }
            if let Some(long) = arg.strip_prefix("--") {
                index += 1 + usize::from(!long.contains('=') && self.long_values.contains(&long));
                continue;
            }
            if arg.len() > 1 && arg.starts_with('-') {
                index += 1 + usize::from(takes_next_word(&arg[1..], self.values));
                continue;
            }
            if self.assignments && is_assignment(arg) {
                index += 1;
                continue;
            }
            if operands > 0 {
                operands -= 1;
                index += 1;
                continue;
            }
            break;
        }
        if index < args.len() {
            Wrapped::Program(index)
        } else {
            Wrapped::Nothing
        }
    }
}

/// Whether a cluster of short flags ends in one that takes a value, which is then the next word.
fn takes_next_word(flags: &str, values: &str) -> bool {
    flags
        .char_indices()
        .find(|(_, flag)| values.contains(*flag))
        .is_some_and(|(at, flag)| at + flag.len_utf8() == flags.len())
}

fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        !name.is_empty()
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && !name.starts_with(|c: char| c.is_ascii_digit())
    })
}

/// What a command that runs another one runs, for the commands this hook knows as such.
fn wrapped(name: &str, args: &[Word]) -> Option<Wrapped> {
    let options = match name {
        "exec" => Options {
            values: "a",
            ..Options::NONE
        },
        "command" => return Some(command_program(args)),
        "builtin" | "nohup" | "noglob" | "nocorrect" | "coproc" | "unbuffer" | "setsid" | "-" => {
            Options::NONE
        }
        "time" => Options {
            values: "of",
            ..Options::NONE
        },
        "nice" => Options {
            values: "n",
            long_values: &["adjustment"],
            ..Options::NONE
        },
        "timeout" | "gtimeout" => Options {
            values: "sk",
            long_values: &["signal", "kill-after"],
            operands: 1,
            ..Options::NONE
        },
        "env" => return Some(env_program(args)),
        "sudo" => Options {
            values: "CDghpRrtTUuc",
            long_values: &[
                "close-from",
                "chdir",
                "group",
                "host",
                "prompt",
                "chroot",
                "role",
                "type",
                "command-timeout",
                "other-user",
                "user",
                "login-class",
            ],
            assignments: true,
            ..Options::NONE
        },
        "doas" => Options {
            values: "uC",
            ..Options::NONE
        },
        "xargs" => Options {
            values: "IELnPsdaJRS",
            long_values: &[
                "arg-file",
                "delimiter",
                "eof",
                "replace",
                "max-lines",
                "max-args",
                "max-procs",
                "max-chars",
                "process-slot-var",
            ],
            ..Options::NONE
        },
        "caffeinate" => Options {
            values: "tw",
            ..Options::NONE
        },
        "stdbuf" => Options {
            values: "ioe",
            long_values: &["input", "output", "error"],
            ..Options::NONE
        },
        "arch" => return Some(arch_program(args)),
        "watch" => return Some(watch_script(args)),
        "script" => return Some(script_program(args)),
        "screen" => return Some(screen_program(args)),
        "tmux" => return Some(tmux_program(args)),
        _ => return None,
    };
    Some(options.program(args))
}

/// `screen [options] [program …]`: the program runs in the screen, attached or detached. With no
/// program it starts the person's shell on the session's input, or attaches to one (`-r`, `-R`,
/// `-x`), unless `-d` keeps it detached; `-ls`, `-wipe`, `-X` and the like start nothing.
fn screen_program(args: &[Word]) -> Wrapped {
    let mut index = 0;
    let mut attaches = false;
    let mut detaches = false;
    while let Some(arg) = args.get(index).and_then(Word::known) {
        if arg == "--" {
            index += 1;
            break;
        }
        if !(arg.len() > 1 && arg.starts_with('-')) {
            break;
        }
        if matches!(
            arg,
            "-ls" | "-list" | "-wipe" | "-v" | "-X" | "-Q" | "-help" | "--help" | "--version"
        ) {
            return Wrapped::Nothing;
        }
        let flags = &arg[1..];
        attaches |= flags.contains(['r', 'R', 'x']);
        detaches |= flags.contains('d');
        index += 1;
        if takes_next_word(flags, "SceptTsh") {
            index += 1;
        } else if flags.ends_with(['r', 'R', 'x', 'd', 'D'])
            && args
                .get(index)
                .and_then(Word::known)
                .is_some_and(|next| !next.starts_with('-'))
            && attaches
        {
            // The session to attach to.
            index += 1;
        }
    }
    if index < args.len() {
        Wrapped::Program(index)
    } else if attaches || !detaches {
        Wrapped::Shell
    } else {
        Wrapped::Nothing
    }
}

/// `tmux [-c command] [options] [command …]`: `-c` is a script; with no command, a new session
/// attaches a shell to the session's input, as `new-session` without `-d` and `attach-session`
/// do; a new session's, window's or pane's shell command is a script; other commands start
/// nothing the hook can see (`send-keys` types into a shell, the gap D22 accepts).
fn tmux_program(args: &[Word]) -> Wrapped {
    let mut index = 0;
    while let Some(word) = args.get(index) {
        let Some(arg) = word.known() else {
            return Wrapped::Nothing;
        };
        if arg == "--" {
            index += 1;
            break;
        }
        if !(arg.len() > 1 && arg.starts_with('-')) {
            break;
        }
        let flags = &arg[1..];
        if let Some(at) = flags.find('c') {
            let line = &flags[at + 1..];
            return if line.is_empty() {
                args.get(index + 1).map_or(Wrapped::Nothing, |line| {
                    Wrapped::Script(line.script.clone())
                })
            } else {
                Wrapped::Script(line.to_string())
            };
        }
        index += 1 + usize::from(takes_next_word(flags, "fLST"));
    }
    let Some(command) = args.get(index) else {
        return Wrapped::Shell;
    };
    let Some(command) = command.known() else {
        return Wrapped::Nothing;
    };
    let new_session = matches!(command, "new-session" | "new");
    let attach = matches!(command, "attach-session" | "attach" | "a" | "at");
    let shell_command = matches!(
        command,
        "new-window"
            | "neww"
            | "split-window"
            | "splitw"
            | "respawn-pane"
            | "respawnp"
            | "respawn-window"
            | "respawnw"
    );
    if !(new_session || attach || shell_command) {
        return Wrapped::Nothing;
    }
    let rest = &args[index + 1..];
    let mut at = 0;
    let mut detached = false;
    while let Some(arg) = rest.get(at).and_then(Word::known) {
        if arg == "--" {
            at += 1;
            break;
        }
        if !(arg.len() > 1 && arg.starts_with('-')) {
            break;
        }
        let flags = &arg[1..];
        detached |= flags.contains('d');
        at += 1 + usize::from(takes_next_word(flags, "cefFlnpstxyX"));
    }
    if at < rest.len() && !attach {
        return Wrapped::Script(join_scripts(&rest[at..]));
    }
    if attach || (new_session && !detached) {
        Wrapped::Shell
    } else {
        Wrapped::Nothing
    }
}

/// `command [-pVv] program …`: `-v` and `-V` only look the program up.
fn command_program(args: &[Word]) -> Wrapped {
    let mut index = 0;
    while let Some(arg) = args.get(index).and_then(Word::known) {
        if arg == "--" {
            index += 1;
            break;
        }
        if arg.len() > 1 && arg.starts_with('-') {
            if arg[1..].contains(['v', 'V']) {
                return Wrapped::Nothing;
            }
            index += 1;
            continue;
        }
        break;
    }
    if index < args.len() {
        Wrapped::Program(index)
    } else {
        Wrapped::Nothing
    }
}

/// `env [options] [NAME=VALUE …] [program …]`, where `-S` and `--split-string` take a command
/// line, read here as a script.
fn env_program(args: &[Word]) -> Wrapped {
    let mut index = 0;
    while let Some(word) = args.get(index) {
        let Some(arg) = word.known() else { break };
        if arg == "--" {
            index += 1;
            break;
        }
        if arg == "-" {
            index += 1;
            continue;
        }
        if let Some(long) = arg.strip_prefix("--") {
            if let Some(line) = long.strip_prefix("split-string=") {
                return Wrapped::Script(line.to_string());
            }
            if long == "split-string" {
                return args.get(index + 1).map_or(Wrapped::Nothing, |line| {
                    Wrapped::Script(line.script.clone())
                });
            }
            index += 1 + usize::from(matches!(long, "unset" | "chdir" | "argv0"));
            continue;
        }
        if arg.len() > 1 && arg.starts_with('-') {
            let flags = &arg[1..];
            if let Some(at) = flags.find('S') {
                let line = &flags[at + 1..];
                return if line.is_empty() {
                    args.get(index + 1).map_or(Wrapped::Nothing, |line| {
                        Wrapped::Script(line.script.clone())
                    })
                } else {
                    Wrapped::Script(line.to_string())
                };
            }
            index += 1 + usize::from(takes_next_word(flags, "uCPLUa"));
            continue;
        }
        if is_assignment(arg) {
            index += 1;
            continue;
        }
        break;
    }
    if index < args.len() {
        Wrapped::Program(index)
    } else {
        Wrapped::Nothing
    }
}

/// `arch [-x86_64 | -arm64 | -arch NAME | -d NAME | -e NAME=VALUE …] program …`.
fn arch_program(args: &[Word]) -> Wrapped {
    let mut index = 0;
    while let Some(arg) = args.get(index).and_then(Word::known) {
        if arg.len() > 1 && arg.starts_with('-') {
            index += 1 + usize::from(matches!(arg, "-arch" | "-d" | "-e"));
            continue;
        }
        break;
    }
    if index < args.len() {
        Wrapped::Program(index)
    } else {
        Wrapped::Nothing
    }
}

/// `watch [options] command …`, which runs its words as `sh -c "<words>"`, or with `-x` as the
/// program itself: either way a script whose first word is the program.
fn watch_script(args: &[Word]) -> Wrapped {
    let options = Options {
        values: "n",
        long_values: &["interval"],
        ..Options::NONE
    };
    match options.program(args) {
        Wrapped::Program(index) => Wrapped::Script(join_scripts(&args[index..])),
        other => other,
    }
}

/// `script`: util-linux's `-c` and `--command` take a command line; BSD's operands are a file and
/// then the program. With neither, it starts the person's shell on the session's input.
fn script_program(args: &[Word]) -> Wrapped {
    let mut index = 0;
    while let Some(word) = args.get(index) {
        let Some(arg) = word.known() else { break };
        if arg == "--" {
            index += 1;
            break;
        }
        if let Some(long) = arg.strip_prefix("--") {
            if let Some(line) = long.strip_prefix("command=") {
                return Wrapped::Script(line.to_string());
            }
            if long == "command" {
                return args.get(index + 1).map_or(Wrapped::Nothing, |line| {
                    Wrapped::Script(line.script.clone())
                });
            }
            index += 1 + usize::from(matches!(
                long,
                "echo"
                    | "log-in"
                    | "log-out"
                    | "log-io"
                    | "log-timing"
                    | "logging-format"
                    | "output-limit"
            ));
            continue;
        }
        if arg.len() > 1 && arg.starts_with('-') {
            let flags = &arg[1..];
            if let Some(at) = flags.find('c') {
                let line = &flags[at + 1..];
                return if line.is_empty() {
                    args.get(index + 1).map_or(Wrapped::Nothing, |line| {
                        Wrapped::Script(line.script.clone())
                    })
                } else {
                    Wrapped::Script(line.to_string())
                };
            }
            index += 1 + usize::from(takes_next_word(flags, "tEIOBTom"));
            continue;
        }
        break;
    }
    // The first operand is the file the session is written to.
    if index + 1 < args.len() {
        Wrapped::Program(index + 1)
    } else {
        Wrapped::Shell
    }
}

/// The scripts of `eval`'s words, joined with spaces as `eval` joins them.
fn join_scripts(words: &[Word]) -> String {
    words
        .iter()
        .map(|word| word.script.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

/// `trap [-lp] [action signal …]`: the action, unless it only resets (`-`).
fn trap_action(args: &[Word]) -> Option<String> {
    let mut index = 0;
    while let Some(word) = args.get(index) {
        match word.known() {
            Some("--") => {
                index += 1;
                break;
            }
            Some(arg) if arg.len() > 1 && arg.starts_with('-') => index += 1,
            _ => break,
        }
    }
    let action = args.get(index)?;
    (action.known() != Some("-")).then(|| action.script.clone())
}

/// `find`'s `-exec`, `-execdir`, `-ok` and `-okdir` run the words up to `;` or `+`.
fn check_find(args: &[Word], depth: usize) -> Option<&'static str> {
    let mut index = 0;
    while index < args.len() {
        if matches!(
            args[index].known(),
            Some("-exec" | "-execdir" | "-ok" | "-okdir")
        ) {
            let start = index + 1;
            let end = args[start..]
                .iter()
                .position(|word| matches!(word.known(), Some(";" | "+")))
                .map_or(args.len(), |at| start + at);
            if let Some(refusal) = check_words(&args[start..end], &Stdin::Elsewhere, depth + 1) {
                return Some(refusal);
            }
            index = end + 1;
            continue;
        }
        index += 1;
    }
    None
}

/// `npx`, `bunx`, `pnpx` and `npm exec`, `pnpm dlx` and the like: the package they run, from
/// `--package` or the first operand, and `--call`'s command line.
fn check_package_runner(args: &[Word], depth: usize) -> Option<&'static str> {
    let mut index = 0;
    while let Some(word) = args.get(index) {
        let arg = word.known()?;
        if arg == "--" {
            index += 1;
            break;
        }
        let (option, value) = match arg.strip_prefix("--") {
            Some(long) => match long.split_once('=') {
                Some((name, value)) => (name, Some(value.to_string())),
                None => (long, None),
            },
            None if arg.len() > 1 && arg.starts_with('-') => (&arg[1..], None),
            None => break,
        };
        let takes_value = matches!(
            option,
            "p" | "package"
                | "c"
                | "call"
                | "prefix"
                | "userconfig"
                | "cache"
                | "registry"
                | "workspace"
                | "w"
        );
        let value = match (value, takes_value) {
            (Some(value), _) => Some(value),
            (None, true) => {
                index += 1;
                args.get(index).map(|value| value.script.clone())
            }
            (None, false) => None,
        };
        index += 1;
        match (option, value) {
            ("p" | "package", Some(package)) if is_claude_package(&package) => {
                return Some(CLAUDE_REFUSAL);
            }
            ("c" | "call", Some(line)) => return check_script(&line, depth + 1),
            _ => {}
        }
    }
    let package = args.get(index)?;
    if starts_claude(package) || package.known().is_some_and(is_claude_package) {
        return Some(CLAUDE_REFUSAL);
    }
    None
}

/// Whether a package names Claude Code: `@anthropic-ai/claude-code` or `claude`, with or without a
/// version.
fn is_claude_package(package: &str) -> bool {
    let package = package.to_ascii_lowercase();
    let name = match package.strip_prefix('@') {
        Some(scoped) => scoped
            .split_once('@')
            .map_or(package.as_str(), |(name, _)| &package[..name.len() + 1]),
        None => package.split('@').next().unwrap_or_default(),
    };
    matches!(name, "@anthropic-ai/claude-code" | "claude")
}

/// A shell's arguments: with `-c`, its first operand is a script; with neither `-c` nor a script
/// file, or with `-s`, it reads its commands from its input.
fn check_shell(args: &[Word], stdin: &Stdin, depth: usize) -> Option<&'static str> {
    let mut command = false;
    let mut from_input = false;
    let mut index = 0;
    while let Some(word) = args.get(index) {
        let Some(arg) = word.known() else { break };
        if arg == "--" || arg == "-" {
            index += 1;
            break;
        }
        if let Some(long) = arg.strip_prefix("--") {
            if let Some(script) = long.strip_prefix("command=") {
                return check_script(script, depth + 1);
            }
            if long == "command" {
                return args
                    .get(index + 1)
                    .and_then(|script| check_script(&script.script, depth + 1));
            }
            if matches!(long, "version" | "help") {
                // It prints and exits, reading nothing.
                return None;
            }
            index += 1 + usize::from(matches!(long, "rcfile" | "init-file" | "emulate"));
            continue;
        }
        if arg.len() > 1 && (arg.starts_with('-') || arg.starts_with('+')) {
            let mut values = 0;
            for flag in arg[1..].chars() {
                match flag {
                    'c' => command = true,
                    's' => from_input = true,
                    'o' | 'O' => values += 1,
                    _ => {}
                }
            }
            index += 1 + values;
            continue;
        }
        break;
    }
    if command {
        return args
            .get(index)
            .and_then(|script| check_script(&script.script, depth + 1));
    }
    if index < args.len() && !from_input {
        // A script file: what it holds is the gap D22 accepts.
        return None;
    }
    check_shell_input(stdin, depth)
}

/// A shell reading its commands from the command's input.
fn check_shell_input(stdin: &Stdin, depth: usize) -> Option<&'static str> {
    match stdin {
        Stdin::Session => Some(SHELL_REFUSAL),
        Stdin::Text(script) => check_script(script, depth + 1),
        Stdin::Elsewhere => None,
    }
}

#[cfg(test)]
#[path = "codex_claude_guard_tests.rs"]
mod tests;
