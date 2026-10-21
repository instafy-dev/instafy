//! How a preview's site was started, so a wake can start it again.
//!
//! `instafy preview open` records the argv of the process listening on the
//! port and its working directory relative to the space's workspace (or takes
//! `--serve-cmd`). The runtime agent runs it as argv, never through a shell,
//! in that directory under the workspace, with a stripped environment.

use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

pub(super) const SERVE_MAX_ARGS: usize = 64;
pub(super) const SERVE_MAX_ARG_BYTES: usize = 2048;
pub(super) const SERVE_MAX_TOTAL_BYTES: usize = 16 * 1024;
pub(super) const SERVE_MAX_CWD_BYTES: usize = 512;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PreviewServe {
    pub(crate) argv: Vec<String>,
    /// Relative to the space's workspace directory; `.` is its root.
    pub(crate) cwd: String,
}

impl PreviewServe {
    /// A recorded start command, or why it cannot be one.
    pub(crate) fn from_json(value: &JsonValue) -> Result<Self, String> {
        let invalid = |why: &str| format!("serve {why}");
        let object = value
            .as_object()
            .ok_or_else(|| invalid("must be an object with argv and cwd"))?;
        let argv = object
            .get("argv")
            .and_then(JsonValue::as_array)
            .ok_or_else(|| invalid("argv must be a list of strings"))?;
        if argv.is_empty() || argv.len() > SERVE_MAX_ARGS {
            return Err(invalid(&format!(
                "argv must have 1 to {SERVE_MAX_ARGS} arguments"
            )));
        }
        let mut args = Vec::with_capacity(argv.len());
        let mut total = 0usize;
        for arg in argv {
            let arg = arg
                .as_str()
                .ok_or_else(|| invalid("argv must be a list of strings"))?;
            if arg.len() > SERVE_MAX_ARG_BYTES || arg.contains('\0') {
                return Err(invalid(&format!(
                    "arguments must be at most {SERVE_MAX_ARG_BYTES} bytes without NUL"
                )));
            }
            total += arg.len();
            args.push(arg.to_string());
        }
        if total > SERVE_MAX_TOTAL_BYTES {
            return Err(invalid(&format!(
                "argv must be at most {SERVE_MAX_TOTAL_BYTES} bytes"
            )));
        }
        if args[0].trim().is_empty() {
            return Err(invalid("argv[0] must name a program"));
        }
        // Every client checks this before it sends a command; checking again
        // here keeps a secret out of the grant metadata whoever sent it.
        if let Some(what) = secret_in_serve_argv(&args) {
            return Err(invalid(&format!(
                "looks like it carries a secret ({what}), which is not recorded; have the site read it from an env file"
            )));
        }
        let cwd = object
            .get("cwd")
            .and_then(JsonValue::as_str)
            .map(normalize_workspace_relative_cwd)
            .unwrap_or_else(|| Some(".".to_string()))
            .ok_or_else(|| {
                invalid("cwd must be a directory inside the workspace, such as . or site")
            })?;
        Ok(Self { argv: args, cwd })
    }

    pub(crate) fn to_json(&self) -> JsonValue {
        serde_json::json!({ "argv": self.argv, "cwd": self.cwd })
    }
}

/// Whether a flag or variable name names a secret, by the CLI's rule
/// (`secretInServeCommand` in `instafy preview open`), so the two never
/// disagree: token, secret, password, passwd, credential, api/access/private
/// key (with at most one `-` or `_` before `key`) and, for flags only, `auth`
/// not followed by a letter (so `--author` is not one).
fn names_a_secret(name: &str, flag: bool) -> bool {
    let lower = name.to_ascii_lowercase();
    if ["token", "secret", "password", "passwd", "credential"]
        .iter()
        .any(|word| lower.contains(word))
    {
        return true;
    }
    let key_after = |word: &str| {
        lower.match_indices(word).any(|(at, _)| {
            let rest = &lower[at + word.len()..];
            let rest = rest
                .strip_prefix('-')
                .or_else(|| rest.strip_prefix('_'))
                .unwrap_or(rest);
            rest.starts_with("key")
        })
    };
    if ["api", "access", "private"]
        .iter()
        .any(|word| key_after(word))
    {
        return true;
    }
    flag && lower
        .match_indices("auth")
        .any(|(at, _)| !lower[at + 4..].starts_with(|ch: char| ch.is_ascii_alphabetic()))
}

fn is_flag_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '-'))
}

fn is_env_name(name: &str) -> bool {
    name.starts_with(|ch: char| ch.is_ascii_alphabetic() || ch == '_')
        && name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn run_of(text: &str, allowed: impl Fn(char) -> bool) -> usize {
    text.chars().take_while(|ch| allowed(*ch)).count()
}

/// A value in a known key format, or a URL with a password in it.
fn looks_like_a_key(value: &str) -> Option<&'static str> {
    let token_char = |ch: char| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-');
    if let Some((scheme, rest)) = value.split_once("://") {
        let scheme_ok = scheme.starts_with(|ch: char| ch.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-'));
        if scheme_ok {
            if let Some((userinfo, _)) = rest.split_once('@') {
                if userinfo.contains(':')
                    && !userinfo.contains('/')
                    && !userinfo.chars().any(char::is_whitespace)
                {
                    return Some("a URL with a password");
                }
            }
        }
    }
    for prefix in ["sk-", "sk_", "pk-", "pk_", "rk-", "rk_"] {
        if value.starts_with(prefix) && run_of(&value[3..], token_char) >= 12 {
            return Some("a key");
        }
    }
    // GitHub tokens: `gh`, one of `pousr`, `_`, then 20 or more letters and
    // digits.
    if let Some(rest) = value.strip_prefix("gh") {
        let mut chars = rest.chars();
        if chars.next().is_some_and(|kind| "pousr".contains(kind))
            && chars.next() == Some('_')
            && run_of(&rest[2..], |ch| ch.is_ascii_alphanumeric()) >= 20
        {
            return Some("a key");
        }
    }
    if ["xoxa-", "xoxb-", "xoxp-", "xoxo-", "xoxs-", "xoxr-"]
        .iter()
        .any(|prefix| value.starts_with(prefix))
    {
        return Some("a key");
    }
    if value.starts_with("AKIA")
        && run_of(&value[4..], |ch| {
            ch.is_ascii_digit() || ch.is_ascii_uppercase()
        }) >= 12
    {
        return Some("a key");
    }
    if let Some(rest) = value.strip_prefix("eyJ") {
        let run = run_of(rest, token_char);
        if run >= 20 && rest[run..].starts_with('.') {
            return Some("a key");
        }
    }
    None
}

/// What in a start command looks like a secret (`--api-key sk-…`,
/// `--token=…`, `API_KEY=…`, a URL with a password, a known key format), the
/// same rule `instafy preview open` applies. Names what it found, never the
/// value.
pub(crate) fn secret_in_serve_argv(argv: &[String]) -> Option<String> {
    for (index, arg) in argv.iter().enumerate() {
        let eq = arg.find('=').filter(|at| *at > 0);
        if arg.starts_with('-') {
            let flag = eq.map_or(arg.as_str(), |at| &arg[..at]);
            let dashes = flag.len() - flag.trim_start_matches('-').len();
            let name = &flag[dashes..];
            if dashes <= 2
                && !name.to_ascii_lowercase().starts_with("no-")
                && is_flag_name(name)
                && names_a_secret(name, true)
            {
                let value = match eq {
                    Some(at) => Some(&arg[at + 1..]),
                    None => argv.get(index + 1).map(String::as_str),
                };
                if value.is_some_and(|value| !value.is_empty() && !value.starts_with('-')) {
                    return Some(flag.to_string());
                }
            }
        }
        if let Some(at) = eq {
            let name = &arg[..at];
            if is_env_name(name) && names_a_secret(name, false) && at + 1 < arg.len() {
                return Some(name.to_string());
            }
        }
        let bare = match eq {
            Some(at) if arg.starts_with('-') => &arg[at + 1..],
            _ => arg.as_str(),
        };
        if let Some(what) = looks_like_a_key(bare) {
            return Some(what.to_string());
        }
    }
    None
}

/// `site/`, `./site` → `site`; `` and `.` → `.`. Refuses absolute paths, any
/// `..` segment, backslashes and control characters, so the agent can join
/// it onto the workspace without leaving it (it checks again after resolving
/// symlinks).
pub(crate) fn normalize_workspace_relative_cwd(raw: &str) -> Option<String> {
    if raw.len() > SERVE_MAX_CWD_BYTES
        || raw.starts_with('/')
        || raw.contains('\\')
        || raw.chars().any(char::is_control)
    {
        return None;
    }
    let mut segments = Vec::new();
    for segment in raw.split('/') {
        match segment {
            "" | "." => continue,
            ".." => return None,
            other => segments.push(other),
        }
    }
    if segments.is_empty() {
        Some(".".to_string())
    } else {
        Some(segments.join("/"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn serve_keeps_argv_and_a_workspace_relative_cwd() {
        let serve = PreviewServe::from_json(&json!({
            "argv": ["python3", "-m", "http.server", "8000"],
            "cwd": "./site/",
        }))
        .unwrap();
        assert_eq!(serve.argv, ["python3", "-m", "http.server", "8000"]);
        assert_eq!(serve.cwd, "site");
        assert_eq!(
            serve.to_json(),
            json!({ "argv": ["python3", "-m", "http.server", "8000"], "cwd": "site" })
        );
        let root = PreviewServe::from_json(&json!({ "argv": ["node", "server.mjs"] })).unwrap();
        assert_eq!(root.cwd, ".");
        assert_eq!(
            PreviewServe::from_json(&json!({ "argv": ["x"], "cwd": "" }))
                .unwrap()
                .cwd,
            "."
        );
    }

    #[test]
    fn serve_refuses_what_could_leave_the_workspace_or_is_not_argv() {
        for bad in [
            json!(null),
            json!("python3 -m http.server"),
            json!({ "argv": [] }),
            json!({ "argv": "python3 -m http.server" }),
            json!({ "argv": [1, 2] }),
            json!({ "argv": [" "] }),
            json!({ "argv": ["a\u{0}b"] }),
            json!({ "argv": ["x"], "cwd": "/etc" }),
            json!({ "argv": ["x"], "cwd": "../other" }),
            json!({ "argv": ["x"], "cwd": "site/../../x" }),
            json!({ "argv": ["x"], "cwd": "a\\b" }),
            json!({ "argv": ["x"], "cwd": "a\nb" }),
            json!({ "argv": vec!["x"; 65] }),
            json!({ "argv": ["x".repeat(2049)] }),
            json!({ "argv": vec!["y".repeat(2000); 9] }),
        ] {
            assert!(PreviewServe::from_json(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn serve_refuses_a_command_line_that_looks_like_it_carries_a_secret() {
        for argv in [
            json!(["node", "server.js", "--api-key", "sk-live-aaaaaaaaaaaaaaaa"]),
            json!(["node", "server.js", "--token=abc123"]),
            json!(["node", "server.js", "--token", "x"]),
            json!(["env", "API_KEY=hunter2", "node", "server.js"]),
            json!(["env", "OPENAI_API_KEY=sk-x", "node", "server.js"]),
            json!([
                "node",
                "server.js",
                "--db",
                "postgres://app:hunter2@db.internal:5432/app"
            ]),
            json!([
                "node",
                "server.js",
                format!("gh{}_abcdefghijklmnopqrstuvwxyz0123", "p")
            ]),
            json!(["python3", "app.py", "--password", "hunter2"]),
            json!(["node", "server.js", "--auth", "basic"]),
            json!(["node", "server.js", "--key=AKIAAAAAAAAAAAAAAAAA"]),
        ] {
            let error = PreviewServe::from_json(&json!({ "argv": argv, "cwd": "." }))
                .expect_err(&argv.to_string());
            assert!(error.contains("looks like it carries a secret"), "{error}");
            assert!(
                !error.contains("hunter2")
                    && !error.contains("sk-live")
                    && !error.contains("abc123"),
                "{error}"
            );
        }
        for argv in [
            json!(["node", "server.mjs", "--no-token", "site/"]),
            json!([
                "python3",
                "-m",
                "http.server",
                "4174",
                "--directory",
                "sites/x"
            ]),
            json!(["npx", "vite", "--host", "127.0.0.1", "--port", "5173"]),
            json!(["node", "server.js", "--session-dir", "/data"]),
            json!(["node", "server.js", "--author", "kim"]),
            json!(["node", "server.js", "--token"]),
            json!(["node", "server.mjs", "x", "--detach"]),
            json!(["node", "server.js", "--origin", "http://localhost:5173"]),
            // Only flags count `auth`, as in the CLI.
            json!(["env", "OAUTH_MODE=off", "node", "server.js"]),
        ] {
            assert!(
                PreviewServe::from_json(&json!({ "argv": argv, "cwd": "." })).is_ok(),
                "{argv}"
            );
        }
    }
}
