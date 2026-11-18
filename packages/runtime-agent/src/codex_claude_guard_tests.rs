use super::*;
use serde_json::json;

/// Commands that start `claude`, as a model might write them. The first group is D22's list of
/// direct launches the exec-policy rule misses (docs/Local-Engine-Turns.md, 1.2 and D22); the rest
/// are the other forms this hook refuses.
const STARTS_CLAUDE: &[&str] = &[
    // D22: a redirection.
    "claude -p 'Review the changes' 2>&1 | tail -n 80",
    "claude -p 'Review the changes' > review.md",
    // D22: a command substitution.
    "claude -p \"$(cat task.md)\"",
    // D22: a here-document.
    "claude -p <<'EOF'\nTidy the README\nEOF",
    // D22: a variable set before the name.
    "FOO=1 claude -p hi",
    // D22: a quoted name.
    "\"claude\" -p hi",
    "'claude' -p hi",
    // D22: a word with a glob, `~` or `$`.
    "claude -p fix src/*.rs",
    "~/.local/bin/claude -p hi",
    "$HOME/.local/bin/claude -p hi",
    // D22: `bash -c` nested in a script.
    "cd app && bash -c 'claude -p hi'",
    // Other spellings of the name.
    "c\\laude -p hi",
    // A line continuation inside the name, which the grammar reads as two words.
    "c\\\nlaude -p hi",
    "cl\\\naude",
    "env cl\\\naude -p hi",
    "\"cl\"aude -p hi",
    "$'claude' -p hi",
    "$'\\x63laude' -p hi",
    "${HOME}/.local/bin/claude -p hi",
    "\"$HOME\"/.local/bin/claude -p hi",
    "\"${HOME}/.local/bin/claude\" -p hi",
    "/opt/homebrew/bin/claude -p hi",
    "./claude -p hi",
    "CLAUDE -p hi",
    "ClAuDe --version",
    "=claude -p hi",
    "~/.local/bin/cla*de -p hi",
    "/usr/local/bin/clau?e",
    "~/bin/[c]laude -p hi",
    "D:/tools/npm/claude.cmd -p hi",
    // Any command of the script.
    "echo start; claude",
    "(claude -p hi)",
    "{ claude -p hi; }",
    "if claude -p hi; then echo ok; fi",
    "while true; do claude -p hi; done",
    "for f in *.md; do claude -p \"$f\"; done",
    "case \"$x\" in *) claude ;; esac",
    "! claude -p hi",
    "claude -p hi &",
    "false || claude -p hi",
    "x=$(claude -p hi)",
    "echo \"$(claude -p hi)\"",
    "echo `claude -p hi`",
    "diff <(claude -p a) b",
    "cat <<EOF\n$(claude -p hi)\nEOF",
    "cat <<EOF\n`claude -p hi`\nEOF",
    "f() { claude \"$@\"; }; f -p hi",
    "for f (*.md) claude $f",
    // A name only the shell knows, whose text names `claude`.
    "$(which claude) -p hi",
    "\"$(command -v claude)\" -p hi",
    "${CLAUDE_BIN:-claude} -p hi",
    "`which claude` -p hi",
    // Behind a command that runs the next one.
    "exec claude -p hi",
    "command claude -p hi",
    "builtin command claude",
    "time claude -p hi",
    "time -p claude",
    "nohup claude -p hi &",
    "nice -n 5 claude",
    "nice -10 claude",
    "timeout 600 claude -p hi",
    "timeout -s KILL 10m claude -p hi",
    "timeout --signal=TERM 5 claude",
    "gtimeout 5 claude",
    "env claude",
    "env -i PATH=/usr/bin claude -p hi",
    "env -u FOO claude",
    "env FOO=1 BAR=2 claude",
    "env -S 'claude -p hi'",
    "env --split-string='claude -p hi'",
    "sudo claude",
    "sudo -u person claude -p hi",
    "sudo -E HOME=/tmp claude",
    "doas claude",
    "xargs claude",
    "xargs -I{} claude -p {}",
    "xargs -I {} claude -p {}",
    "xargs -n 1 claude",
    "xargs -0 -P 4 claude -p",
    "caffeinate -i claude -p hi",
    "stdbuf -oL claude -p hi",
    "setsid claude",
    "arch -arm64 claude -p hi",
    "noglob claude",
    "nocorrect claude",
    "coproc claude -p hi",
    "unbuffer claude -p hi",
    "nohup nice -n 5 timeout 60 claude -p hi",
    "watch -n 5 claude -p hi",
    "script -q /dev/null claude -p hi",
    "script -c 'claude -p hi' /dev/null",
    "find . -name '*.md' -exec claude -p {} \\;",
    "find . -execdir sh -c 'claude -p hi' \\;",
    "find . -ok claude {} +",
    // In a script that a script hands on.
    "bash -lc \"claude -p hi\"",
    "sh -c \"bash -c 'claude -p hi'\"",
    "zsh -fc 'claude'",
    "bash -o pipefail -c 'claude -p hi | tail'",
    "bash -euo pipefail -c 'claude -p hi'",
    "dash -c 'cd x && claude'",
    "fish -c 'claude -p hi'",
    "busybox sh -c 'claude'",
    "bash -c \"claude -p $PROMPT\"",
    "bash -c \"$(which claude) -p hi\"",
    "bash -c \"\n  claude -p hi\n\"",
    "bash -c \"echo start\nclaude -p hi\"",
    "eval 'claude -p hi'",
    "eval \"claude -p $ARGS\"",
    "eval claude -p hi",
    "trap 'claude -p hi' EXIT",
    "alias c='claude -p'; c hi",
    "bash <<'EOF'\nclaude -p hi\nEOF",
    "bash <<< 'claude -p hi'",
    "cat <<'EOF' | bash\nclaude -p hi\nEOF",
    "sh -s <<EOF\nclaude\nEOF",
    // A package runner's Claude Code.
    "npx @anthropic-ai/claude-code -p hi",
    "npx --yes @anthropic-ai/claude-code@latest -p hi",
    "npx -y @anthropic-ai/claude-code",
    "npx claude -p hi",
    "npx -p @anthropic-ai/claude-code claude -p hi",
    "npx -c 'claude -p hi'",
    "bunx @anthropic-ai/claude-code",
    "pnpm dlx @anthropic-ai/claude-code -p hi",
    "npm exec -- @anthropic-ai/claude-code -p hi",
    "yarn dlx @anthropic-ai/claude-code",
    "pnpm claude -p hi",
    "pnpm --silent claude",
    "yarn claude",
    "bun claude -p hi",
    // Braces that expand to the name.
    "cl{a,}ude -p hi",
    "cl{a,b}ude -p hi",
    "cl{a..a}ude -p hi",
    "~/.local/bin/{claude,codex} -p hi",
    // A script a shell reads from the command before it.
    "echo 'claude -p hi' | bash",
    "echo claude -p hi | bash -s",
    "printf '%s\\n' 'claude -p hi' | sh",
    // A terminal program's program or shell command.
    "screen claude -p hi",
    "screen -dm claude -p hi",
    "screen -S work claude",
    "tmux new-session -d 'claude -p hi'",
    "tmux new 'claude -p hi'",
    "tmux new-session -d -s work claude",
    "tmux -c 'claude -p hi'",
    "tmux split-window 'claude -p hi'",
];

/// Shells that would read their commands from the session's input, which `write_stdin` writes to.
const TYPES_INTO_A_SHELL: &[&str] = &[
    "bash",
    "zsh -l",
    "sh -i",
    "bash --login",
    "bash -s",
    "bash -",
    "exec zsh",
    "env bash",
    "nohup bash",
    "cd /tmp && zsh",
    "busybox sh",
    "fish",
    "script",
    "script -q /dev/null",
    "screen",
    "screen -S work",
    "screen -r",
    "screen -r work",
    "screen -d -r work",
    "tmux",
    "tmux new -s work",
    "tmux attach",
    "tmux a -t work",
    "tmux attach-session -d -t work",
];

/// Commands that name `claude` without starting it, or start another program, and shells that
/// read their commands from somewhere other than the session's input.
const LETS_THROUGH: &[&str] = &[
    "echo claude",
    "grep -rn claude src",
    "grep -il claude README.md",
    "rg -n 'claude' docs",
    "which claude",
    "command -v claude",
    "command -V claude",
    "type claude",
    "ls ~/.local/bin/claude",
    "test -x ~/.local/bin/claude && echo yes",
    "[ -x ~/.local/bin/claude ]",
    "[[ -x ~/.local/bin/claude ]]",
    "cat claude.md",
    "claudette",
    "/usr/local/bin/claudette --help",
    "./tests/fixtures/fake-claude",
    "not-claude -p hi 2>&1 | tail -n 5",
    "cargo test claude_code",
    "claude_code_lane --help",
    "cd claude && ls",
    "mkdir -p claude",
    "git log --grep claude",
    "xargs grep -l claude",
    "find . -name claude.md",
    "find . -name '*.rs' -exec grep -l claude {} \\;",
    "timeout 5 grep claude README.md",
    "env FOO=claude printenv FOO",
    "nohup echo claude",
    "time grep -c claude README.md",
    "sudo -u person ls claude",
    "CLAUDE_CODE_LANE_USER_IDS= cargo test",
    "export CLAUDE_CONFIG_DIR=~/.claude",
    "FAKE=claude ./run.sh",
    "cat <<'EOF' > notes.md\nclaude -p hi\n$(claude -p hi)\n`claude -p hi`\nEOF",
    "cat <<EOF > notes.md\nclaude -p hi\nEOF",
    "echo 'claude -p hi' > task.txt",
    "printf '%s\\n' 'claude -p hi'",
    "bash script.sh",
    "sh ./install.sh --prefix ~/.local",
    "curl -fsSL https://example.com/install.sh | bash",
    "bash < setup.sh",
    "echo hi | bash -s",
    "cat <<EOF | bash\necho hi\nEOF",
    "bash <<'EOF'\necho hi\nEOF",
    "bash <<< 'echo hi'",
    "source ./env.sh",
    ". ./env.sh",
    "bash -c 'echo claude'",
    "bash -c 'grep -l claude *.md'",
    "eval 'echo claude'",
    "alias ll='ls -l'",
    "trap 'rm -f /tmp/x' EXIT",
    "npx prettier --check .",
    "npm install @anthropic-ai/claude-code",
    "npm view @anthropic-ai/claude-code version",
    "pnpm dlx create-vite app",
    "$CMD -p hi",
    "\"$EDITOR\" README.md",
    "cla$X -p hi",
    "bash --version",
    "zsh --version",
    "exec 3>out.log",
    "env",
    "xargs",
    "watch -n 5 ls",
    "script -q /dev/null ls",
    "echo {a,b}.txt",
    "\"$CLAUDE_CONFIG_DIR/bin/node\" build.js",
    "cargo test \\\n  --lib -- codex",
    "pnpm install",
    "pnpm run build",
    "yarn build",
    "npm test",
    "env {x,claude}",
    "~/bin/{x,claude} -p hi",
    "find . -name '*.log' -exec {} \\;",
    "mkdir -p src/{a,b}",
    "cp file{,.bak}",
    "echo {1..2000}",
    "echo hi | bash",
    "echo 'ls claude' | bash",
    "cat README.md | grep claude | bash",
    "tmux ls",
    "tmux send-keys -t work 'ls' Enter",
    "tmux new-session -d -s work",
    "tmux kill-server",
    "screen -ls",
    "screen -dm",
    "screen -X quit",
    "",
];

#[test]
fn every_form_that_starts_claude_is_refused() {
    for script in STARTS_CLAUDE {
        assert_eq!(
            refusal_for_script(script),
            Some(CLAUDE_REFUSAL),
            "{script:?}"
        );
    }
}

#[test]
fn a_shell_that_would_read_the_sessions_input_is_refused() {
    for script in TYPES_INTO_A_SHELL {
        assert_eq!(
            refusal_for_script(script),
            Some(SHELL_REFUSAL),
            "{script:?}"
        );
    }
}

#[test]
fn commands_that_only_name_claude_run() {
    for script in LETS_THROUGH {
        assert_eq!(refusal_for_script(script), None, "{script:?}");
    }
}

#[test]
fn a_command_the_grammar_cannot_read_is_refused_when_it_names_claude() {
    // zsh's short `for`, which the bash grammar reads with errors.
    assert_eq!(
        refusal_for_script("for f (*.md) grep -l claude $f"),
        Some(UNREADABLE_REFUSAL)
    );
    assert_eq!(refusal_for_script("for f (*.md) grep -l TODO $f"), None);
    assert_eq!(refusal_for_script("for f (*) ls $f"), None);
    // A glob at the start of a command, which the grammar misreads: `[c]laude` as a test and a
    // command `laude`, `cla[u]de` as an array subscript. Read as plain words, each is `claude`.
    for script in ["[c]laude -p hi", "cla[u]de -p hi", "{claude,x} -p hi"] {
        assert_eq!(
            refusal_for_script(script),
            Some(UNREADABLE_REFUSAL),
            "{script}"
        );
    }
    // Deeper than MAX_DEPTH: each `eval` hands its words on as a script.
    let deep = format!("{}claude -p hi", "eval ".repeat(MAX_DEPTH + 2));
    assert_eq!(refusal_for_script(&deep), Some(UNREADABLE_REFUSAL));
    let shallow = format!("{}claude -p hi", "eval ".repeat(MAX_DEPTH - 1));
    assert_eq!(refusal_for_script(&shallow), Some(CLAUDE_REFUSAL));
    // Longer than MAX_SCRIPT_BYTES.
    let long = format!("echo {}; claude -p hi", "x".repeat(MAX_SCRIPT_BYTES));
    assert_eq!(refusal_for_script(&long), Some(UNREADABLE_REFUSAL));
    let long_and_harmless = format!("echo {}", "x".repeat(MAX_SCRIPT_BYTES));
    assert_eq!(refusal_for_script(&long_and_harmless), None);
}

#[test]
fn the_hook_reads_codexs_pre_tool_use_input() {
    let input = |command: Value| {
        serde_json::to_vec(&json!({
            "session_id": "thread",
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
            "tool_use_id": "call_1",
            "tool_input": { "command": command },
        }))
        .expect("hook input")
    };
    assert_eq!(
        refusal_for_hook_input(&input(json!("claude -p hi 2>&1 | tail"))),
        Some(CLAUDE_REFUSAL)
    );
    assert_eq!(
        refusal_for_hook_input(&input(json!("bash"))),
        Some(SHELL_REFUSAL)
    );
    assert_eq!(refusal_for_hook_input(&input(json!("ls -la"))), None);
    // A command given as words.
    assert_eq!(
        refusal_for_hook_input(&input(json!(["/bin/zsh", "-lc", "claude -p hi > out"]))),
        Some(CLAUDE_REFUSAL)
    );
    assert_eq!(
        refusal_for_hook_input(&input(json!(["ls", "claude"]))),
        None
    );
    // Another tool's input has no command.
    assert_eq!(
        refusal_for_hook_input(br#"{"tool_name":"apply_patch","tool_input":{"patch":"claude"}}"#),
        None
    );
    // Input it cannot read is refused when it names `claude`.
    assert_eq!(
        refusal_for_hook_input(b"not json: claude -p hi"),
        Some(UNREADABLE_REFUSAL)
    );
    assert_eq!(refusal_for_hook_input(b"not json"), None);
    assert_eq!(
        refusal_for_hook_input(&input(json!({ "cmd": "claude -p hi" }))),
        Some(UNREADABLE_REFUSAL)
    );
    assert_eq!(
        refusal_for_hook_input(&input(json!(["claude", 1]))),
        Some(UNREADABLE_REFUSAL)
    );
}

#[test]
fn each_refusal_reads_as_codex_shows_it() {
    // "Command blocked by PreToolUse hook: <reason>. Command: …": no full stop of their own.
    for reason in [
        CLAUDE_REFUSAL,
        SHELL_REFUSAL,
        UNREADABLE_REFUSAL,
        UNCHECKED_REFUSAL,
    ] {
        assert!(!reason.ends_with('.'), "{reason}");
        assert!(!reason.contains(['\n', '"', '\\']), "{reason}");
    }
}

#[test]
fn a_word_names_claude_between_non_alphanumeric_characters() {
    for text in [
        "claude",
        "$(which claude)",
        "~/.local/bin/claude",
        "CLAUDE_BIN",
        "Claude.",
    ] {
        assert!(names_claude_as_a_word(text), "{text}");
    }
    for text in ["claudette", "fake_claude2", "anthropic", ""] {
        assert!(!names_claude_as_a_word(text), "{text}");
    }
}

#[test]
fn a_glob_matches_claude_as_a_folder_that_ignores_case_would() {
    for pattern in [
        "cla*",
        "*",
        "c?aude",
        "[a-c]laude",
        "[A-C]LAUDE",
        "claude*",
        "*e",
    ] {
        assert!(glob_matches_claude(pattern), "{pattern}");
    }
    for pattern in ["[!c]laude", "*.sh", "[", "claude?", "x*"] {
        assert!(!glob_matches_claude(pattern), "{pattern}");
    }
}

#[test]
fn claude_codes_package_names_are_known_with_or_without_a_version() {
    for package in [
        "@anthropic-ai/claude-code",
        "@anthropic-ai/claude-code@2.1.325",
        "@Anthropic-AI/Claude-Code@latest",
        "claude",
        "claude@1",
    ] {
        assert!(is_claude_package(package), "{package}");
    }
    for package in [
        "@anthropic-ai/sdk",
        "claude-code",
        "prettier",
        "@scope/claude",
    ] {
        assert!(!is_claude_package(package), "{package}");
    }
}

#[test]
fn ansi_c_words_decode_as_the_shell_reads_them() {
    assert_eq!(decode_ansi_c("$'claude'"), "claude");
    assert_eq!(decode_ansi_c("$'\\x63laude'"), "claude");
    assert_eq!(decode_ansi_c("$'\\143laude'"), "claude");
    assert_eq!(decode_ansi_c("$'\\u0063laude'"), "claude");
    assert_eq!(decode_ansi_c("$'a\\tb\\n'"), "a\tb\n");
    assert_eq!(decode_ansi_c("$'it\\'s'"), "it's");
}

#[test]
fn braces_expand_as_a_shell_expands_them() {
    let words = |text: &str| brace_words(text, false).expect("within the limit");
    assert_eq!(words("plain"), vec!["plain"]);
    assert_eq!(words("{a,b}c"), vec!["ac", "bc"]);
    assert_eq!(words("cl{a,}ude"), vec!["claude", "clude"]);
    assert_eq!(words("cl{a..c}ude"), vec!["claude", "clbude", "clcude"]);
    assert_eq!(words("{1..3}"), vec!["1", "2", "3"]);
    assert_eq!(words("{5..1..2}"), vec!["5", "3", "1"]);
    assert_eq!(words("{a,{b,c}}"), vec!["a", "b", "c"]);
    assert_eq!(words("{x}"), vec!["{x}"]);
    assert_eq!(words("{a..}"), vec!["{a..}"]);
    assert_eq!(words("{}"), vec!["{}"]);
    // The program a shell runs is the first non-empty word; the rest are its arguments.
    assert_eq!(brace_words("{x,claude}", true), Some(vec!["x".to_string()]));
    assert_eq!(
        brace_words("{,claude}", true),
        Some(vec![String::new(), "claude".to_string()])
    );
    assert_eq!(
        brace_words(&"{a,b}".repeat(40), true).map(|words| words.len()),
        Some(1)
    );
    // Past the limit, or nested too deep, the hook does not expand them.
    assert_eq!(brace_words("{1..5000}", false), None);
    assert_eq!(brace_words(&"{a,b}".repeat(11), false), None);
    // Each first alternative holds the next group: `{{{a,b},b},b}`.
    let deep = format!("{}a{}", "{".repeat(70), ",b}".repeat(70));
    assert_eq!(brace_words(&deep, true), None);
    assert_eq!(
        brace_words(&format!("{}a{}", "{".repeat(8), ",b}".repeat(8)), true),
        Some(vec!["a".to_string()])
    );
    // A program's name whose braces the hook does not expand is refused; an argument's is not.
    for name in [
        format!("x{deep}"),
        format!("x{{a,b}}{}", "y".repeat(MAX_BRACE_TEXT)),
    ] {
        assert_eq!(
            refusal_for_script(&format!("{name} -p hi")),
            Some(CLAUDE_REFUSAL)
        );
        assert_eq!(refusal_for_script(&format!("echo {name}")), None);
    }
}

#[test]
fn a_check_that_takes_too_long_is_refused() {
    // The grammar spends seconds on a run of `${`; Codex would let the command run once the hook
    // timed out, so the hook refuses first.
    let slow = serde_json::to_vec(&json!({ "tool_input": { "command": "${".repeat(16 * 1024) } }))
        .expect("hook input");
    let started = std::time::Instant::now();
    assert_eq!(
        refusal_within(slow, std::time::Duration::from_millis(200)),
        Some(UNCHECKED_REFUSAL)
    );
    assert!(started.elapsed() < std::time::Duration::from_secs(3));
    // An ordinary command is checked well within the hook's deadline.
    for (command, refusal) in [
        ("cargo test -p runtime-agent 2>&1 | tail -n 40", None),
        ("claude -p hi 2>&1 | tail", Some(CLAUDE_REFUSAL)),
    ] {
        let input = serde_json::to_vec(&json!({ "tool_input": { "command": command } }))
            .expect("hook input");
        assert_eq!(refusal_within(input, CHECK_DEADLINE), refusal, "{command}");
    }
}
