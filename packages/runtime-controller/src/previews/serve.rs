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
}
