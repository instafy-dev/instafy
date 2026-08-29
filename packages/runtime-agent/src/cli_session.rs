//! Read-only access to the persisted Instafy CLI session.
//!
//! The CLI (and other local processes sharing the login) refresh and rotate
//! the Supabase session in `~/.instafy/config.json`. A long-running runtime
//! agent that was handed a user-derived access token at spawn time can find
//! that token expired while a freshly rotated one already sits in the config
//! file. This module lets the registration path re-read that file so the
//! agent can self-heal instead of retrying forever with a stale token.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Environment variable that overrides the persisted CLI config location.
pub const CONFIG_PATH_ENV: &str = "INSTAFY_CLI_CONFIG";

/// Resolve the persisted CLI config path from the current environment:
/// `INSTAFY_CLI_CONFIG` when set (and non-blank), otherwise
/// `$HOME/.instafy/config.json`.
pub fn config_path() -> Option<PathBuf> {
    resolve_config_path(std::env::var_os(CONFIG_PATH_ENV), home_dir())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| std::env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

/// Pure form of [`config_path`] for tests: an explicit override wins, a blank
/// override falls through to `<home>/.instafy/config.json`.
pub fn resolve_config_path(
    override_value: Option<OsString>,
    home: Option<PathBuf>,
) -> Option<PathBuf> {
    if let Some(value) = override_value {
        let trimmed = value.to_string_lossy().trim().to_string();
        if !trimmed.is_empty() {
            return Some(PathBuf::from(trimmed));
        }
    }
    home.map(|home| home.join(".instafy").join("config.json"))
}

/// Read the persisted session's access token from `path`. Returns `None`
/// when the file is missing, unreadable, not valid JSON, or holds no usable
/// `accessToken` value.
pub fn read_access_token(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    parse_access_token(&raw)
}

/// Extract `accessToken` from the CLI config JSON. Mirrors the CLI's own
/// normalization: trims whitespace and treats empty / "null" / "undefined"
/// strings as absent.
pub fn parse_access_token(raw: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let token = value.as_object()?.get("accessToken")?.as_str()?.trim();
    if token.is_empty()
        || token.eq_ignore_ascii_case("null")
        || token.eq_ignore_ascii_case("undefined")
    {
        return None;
    }
    Some(token.to_string())
}

/// The re-read access token, but only when it is actually new information:
/// a token that was already presented (and rejected) is not worth retrying.
pub fn access_token_if_untried<'a, I>(reloaded: Option<String>, tried: I) -> Option<String>
where
    I: IntoIterator<Item = &'a str>,
{
    let reloaded = reloaded?;
    if tried.into_iter().any(|token| token == reloaded) {
        return None;
    }
    Some(reloaded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn resolve_config_path_prefers_explicit_override() {
        let resolved = resolve_config_path(
            Some(OsString::from("/etc/instafy/session.json")),
            Some(PathBuf::from("/home/user")),
        );
        assert_eq!(resolved, Some(PathBuf::from("/etc/instafy/session.json")));
    }

    #[test]
    fn resolve_config_path_blank_override_falls_back_to_home_default() {
        let resolved = resolve_config_path(
            Some(OsString::from("   ")),
            Some(PathBuf::from("/home/user")),
        );
        assert_eq!(
            resolved,
            Some(PathBuf::from("/home/user/.instafy/config.json"))
        );
    }

    #[test]
    fn resolve_config_path_without_override_or_home_is_none() {
        assert_eq!(resolve_config_path(None, None), None);
    }

    #[test]
    fn parse_access_token_reads_the_cli_session_shape() {
        let raw = r#"{
            "controllerUrl": "https://controller.instafy.dev",
            "accessToken": "  fresh-user-token  ",
            "refreshToken": "refresh-token",
            "updatedAt": "2026-08-28T00:00:00.000Z"
        }"#;
        assert_eq!(
            parse_access_token(raw),
            Some("fresh-user-token".to_string())
        );
    }

    #[test]
    fn parse_access_token_treats_placeholder_values_as_absent() {
        for raw in [
            r#"{"accessToken": ""}"#,
            r#"{"accessToken": "   "}"#,
            r#"{"accessToken": "null"}"#,
            r#"{"accessToken": "UNDEFINED"}"#,
            r#"{"accessToken": null}"#,
            r#"{"accessToken": 42}"#,
            r#"{"refreshToken": "only-refresh"}"#,
            "[]",
            "not json",
        ] {
            assert_eq!(parse_access_token(raw), None, "raw: {raw}");
        }
    }

    #[test]
    fn read_access_token_reads_a_config_file_fixture() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.json");
        let mut file = std::fs::File::create(&path).expect("create fixture");
        write!(
            file,
            r#"{{"accessToken":"rotated-token","refreshToken":"rotated-refresh"}}"#
        )
        .expect("write fixture");
        assert_eq!(read_access_token(&path), Some("rotated-token".to_string()));
    }

    #[test]
    fn read_access_token_missing_file_is_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(read_access_token(&dir.path().join("missing.json")), None);
    }

    #[test]
    fn access_token_if_untried_skips_tokens_already_presented() {
        assert_eq!(
            access_token_if_untried(Some("stale".to_string()), ["stale", "other"]),
            None
        );
        assert_eq!(
            access_token_if_untried(Some("fresh".to_string()), ["stale", "other"]),
            Some("fresh".to_string())
        );
        assert_eq!(access_token_if_untried(None, ["stale"]), None);
    }
}
