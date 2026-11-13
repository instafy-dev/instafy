//! The credential guard: Claude sign-in material that the controller never
//! accepts, stores, leases, refreshes or delivers (docs/Local-Engine-Turns.md,
//! section 6).
//!
//! A local-engine turn runs the Claude Code a person signed in to on their own
//! computer, under that sign-in. Instafy never holds it, so every path where a
//! credential or a project secret enters or leaves the controller refuses it:
//! - a stored model credential: the Codex upload refuses it before it
//!   classifies the body, `credentials::insert_user_credential` before it seals
//!   one (device login reaches it too), and every lease, refresh and probe of a
//!   row stored earlier fails in `decode_authoritative_credential_payload`;
//! - a project secret: create refuses a reserved name or a Claude value, update
//!   a Claude value or a new value for a reserved name, delivery to a job skips
//!   such a secret, the GitHub import's project-token fallback
//!   (`imports::load_project_secret_value_by_name`) treats one that holds a
//!   Claude value as absent, and the listing marks it `refused`.
//!
//! The guard is narrow (D23). A Claude API key (`sk-ant-api…`) or Admin API key
//! (`sk-ant-admin…`) is not a sign-in and keeps working everywhere, for example
//! as an `ANTHROPIC_API_KEY` project secret.
//!
//! Apart from the controller's error type, this file depends on nothing else in
//! the crate, so the read-only census in `examples/claude-material-census.rs`
//! compiles it unchanged and counts exactly what the guard refuses.

use axum::http::StatusCode;
use axum::Json;
use serde_json::Value as JsonValue;

use crate::ApiError;

/// The error code of the 400 that refuses Claude sign-in material.
pub(crate) const CLAUDE_CREDENTIAL_REFUSED_CODE: &str = "claude_credential_refused";

/// The message of that 400.
pub(crate) const CLAUDE_CREDENTIAL_REFUSED_MESSAGE: &str = "Instafy doesn't store Claude sign-ins. Claude Code turns use the Claude Code signed in on your own computer.";

/// The project secret name the guard reserves, in the form
/// `secrets::normalize_secret_name` gives it.
pub(crate) const RESERVED_SECRET_NAME: &str = "CLAUDE_CODE_OAUTH_TOKEN";

/// How many levels of a JSON value [`json_contains_claude_material`] looks at.
/// The value itself is level 1, and each array element or object member is one
/// level below its parent.
pub(crate) const MAX_JSON_DEPTH: usize = 8;

/// The prefix Anthropic's keys and tokens share.
const TOKEN_PREFIX: &[u8] = b"sk-ant-";

/// What may follow [`TOKEN_PREFIX`] in a value the guard allows: a Claude API
/// key (`sk-ant-api…`) or an Admin API key (`sk-ant-admin…`).
const API_KEY_KINDS: [&[u8]; 2] = [b"api", b"admin"];

/// The key Claude Code keeps its stored sign-in under, as it writes it and in
/// snake case, both lower-cased for a comparison that ignores ASCII case.
const SIGN_IN_KEYS: [&[u8]; 2] = [b"claudeaioauth", b"claude_ai_oauth"];

/// The 400 that refuses Claude sign-in material.
pub(crate) fn claude_credential_refused() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError {
            message: CLAUDE_CREDENTIAL_REFUSED_MESSAGE.to_string(),
            code: Some(CLAUDE_CREDENTIAL_REFUSED_CODE.to_string()),
            details: None,
        }),
    )
}

/// Whether `value` holds Claude sign-in material: it names Claude Code's stored
/// sign-in (`claudeAiOauth` or `claude_ai_oauth`), or it contains `sk-ant-`
/// with no letter or digit directly before it, except where that occurrence
/// starts a Claude API key or an Admin API key. Every comparison ignores ASCII
/// case.
///
/// "Letter or digit" means an ASCII one, so `risk-ant-…` is allowed. Any other
/// character before the prefix, a non-ASCII letter included, counts as a
/// boundary, which errs towards refusing. That this covers Claude's OAuth
/// access, refresh and setup tokens is unverified: Claude Code's documentation
/// does not give their format.
pub(crate) fn is_claude_secret_value(value: &str) -> bool {
    let bytes = value.as_bytes();
    if SIGN_IN_KEYS
        .iter()
        .any(|key| contains_ignore_ascii_case(bytes, key))
    {
        return true;
    }
    bytes
        .windows(TOKEN_PREFIX.len())
        .enumerate()
        .any(|(start, window)| {
            window.eq_ignore_ascii_case(TOKEN_PREFIX)
                && !bytes[..start].last().is_some_and(u8::is_ascii_alphanumeric)
                && !API_KEY_KINDS.iter().any(|kind| {
                    starts_with_ignore_ascii_case(&bytes[start + TOKEN_PREFIX.len()..], kind)
                })
        })
}

/// Whether a JSON value holds Claude sign-in material: an object key or a
/// string for which [`is_claude_secret_value`] holds, `claudeAiOauth` and
/// `claude_ai_oauth` among them. The walk stops [`MAX_JSON_DEPTH`] levels down,
/// and a value nested deeper counts as Claude material, so it fails closed.
pub(crate) fn json_contains_claude_material(value: &JsonValue) -> bool {
    contains_claude_material_at(value, 1)
}

fn contains_claude_material_at(value: &JsonValue, level: usize) -> bool {
    if level > MAX_JSON_DEPTH {
        return true;
    }
    match value {
        JsonValue::String(text) => is_claude_secret_value(text),
        JsonValue::Array(items) => items
            .iter()
            .any(|item| contains_claude_material_at(item, level + 1)),
        JsonValue::Object(members) => members.iter().any(|(key, member)| {
            is_claude_secret_value(key) || contains_claude_material_at(member, level + 1)
        }),
        JsonValue::Null | JsonValue::Bool(_) | JsonValue::Number(_) => false,
    }
}

/// Whether a project secret name is the reserved `CLAUDE_CODE_OAUTH_TOKEN`
/// once `secrets::normalize_secret_name` has trimmed it, turned its spaces and
/// hyphens into `_` and upper-cased it, so `claude-code-oauth-token` is
/// reserved too.
pub(crate) fn is_reserved_secret_name(name: &str) -> bool {
    name.trim().replace([' ', '-'], "_").to_ascii_uppercase() == RESERVED_SECRET_NAME
}

/// Whether the guard refuses a stored project secret: its name is reserved, or
/// its value is Claude sign-in material. A value that could not be read is
/// `None`, and the secret is then judged by its name alone.
pub(crate) fn is_refused_secret(name: &str, value: Option<&str>) -> bool {
    is_reserved_secret_name(name) || value.is_some_and(is_claude_secret_value)
}

fn contains_ignore_ascii_case(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

fn starts_with_ignore_ascii_case(bytes: &[u8], prefix: &[u8]) -> bool {
    bytes
        .get(..prefix.len())
        .is_some_and(|head| head.eq_ignore_ascii_case(prefix))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Inert stand-ins with the shapes the guard reads. None is a real key or token.
    const OAUTH_ACCESS: &str = "sk-ant-oat01-inert-test-access-token";
    const OAUTH_REFRESH: &str = "sk-ant-ort01-inert-test-refresh-token";
    const API_KEY: &str = "sk-ant-api03-inert-test-api-key";
    const ADMIN_KEY: &str = "sk-ant-admin01-inert-test-admin-key";

    fn claude_code_sign_in() -> JsonValue {
        json!({
            "claudeAiOauth": {
                "accessToken": OAUTH_ACCESS,
                "refreshToken": OAUTH_REFRESH,
                "expiresAt": 1_900_000_000_000_u64,
                "scopes": ["user:inference", "user:profile"],
                "subscriptionType": "pro"
            }
        })
    }

    #[test]
    fn claude_oauth_tokens_are_refused_in_any_letter_case() {
        for value in [
            OAUTH_ACCESS,
            OAUTH_REFRESH,
            "SK-ANT-OAT01-INERT",
            "Sk-Ant-Ort01-inert",
            "sK-aNt-oat01-inert",
            "sk-ant-sid01-inert",
            "sk-ant-",
            "token=sk-ant-oat01-inert",
            "\"sk-ant-oat01-inert\"",
            "Bearer sk-ant-oat01-inert",
            "_sk-ant-oat01-inert",
            "export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-inert\n",
            // A non-ASCII letter is not one the exception covers.
            "\u{e9}sk-ant-oat01-inert",
        ] {
            assert!(is_claude_secret_value(value), "{value:?}");
        }
    }

    #[test]
    fn claude_api_and_admin_keys_are_allowed_in_any_letter_case() {
        for value in [
            API_KEY,
            ADMIN_KEY,
            "SK-ANT-API03-INERT",
            "Sk-Ant-Admin01-inert",
            "sk-ant-API03-inert",
            "ANTHROPIC_API_KEY=sk-ant-api03-inert",
            "sk-ant-api03-a sk-ant-admin01-b",
            "Keys start with sk-ant-api or sk-ant-admin.",
        ] {
            assert!(!is_claude_secret_value(value), "{value:?}");
        }
    }

    #[test]
    fn a_letter_or_digit_before_the_prefix_is_not_a_token() {
        for value in [
            "risk-ant-oat01-inert",
            "RISK-ANT-ORT01-inert",
            "whisk-ant-colony",
            "1sk-ant-oat01-inert",
            "Zsk-ant-",
        ] {
            assert!(!is_claude_secret_value(value), "{value:?}");
        }
    }

    #[test]
    fn every_other_occurrence_in_a_value_counts() {
        // An API key does not excuse a token beside it.
        assert!(is_claude_secret_value(&format!("{API_KEY} {OAUTH_ACCESS}")));
        assert!(is_claude_secret_value(&format!(
            "{ADMIN_KEY},{OAUTH_REFRESH}"
        )));
        assert!(is_claude_secret_value("risk-ant-x sk-ant-oat01-inert"));
        assert!(is_claude_secret_value("sk-ant-sk-ant-api03-inert"));
    }

    #[test]
    fn claude_code_sign_in_keys_are_refused_as_text() {
        for value in [
            "claudeAiOauth",
            "CLAUDEAIOAUTH",
            "claude_ai_oauth",
            "CLAUDE_AI_OAUTH",
            r#"{"claudeAiOauth":{"accessToken":"x"}}"#,
        ] {
            assert!(is_claude_secret_value(value), "{value:?}");
        }
        assert!(is_claude_secret_value(&claude_code_sign_in().to_string()));
    }

    #[test]
    fn ordinary_values_are_allowed() {
        for value in [
            "",
            "sk-ant",
            "sk_ant_oat01_inert",
            "ant-sk-oat01",
            "sk-proj-inert-openai-key",
            "claude",
            "oauth",
            "claude-ai-oauth",
            "postgres://user:pass@db.example.test/app",
        ] {
            assert!(!is_claude_secret_value(value), "{value:?}");
        }
    }

    #[test]
    fn json_with_a_claude_sign_in_anywhere_is_claude_material() {
        for value in [
            claude_code_sign_in(),
            json!({ "claude_ai_oauth": {} }),
            json!({ "CLAUDEAIOAUTH": null }),
            json!({ "tokens": { "access_token": OAUTH_ACCESS } }),
            json!({ "tokens": { "access_token": "codex", "refresh_token": OAUTH_REFRESH } }),
            json!({ "OPENAI_API_KEY": "SK-ANT-OAT01-INERT" }),
            json!({ "nested": [{ "deeper": ["ok", OAUTH_ACCESS] }] }),
            json!({ OAUTH_ACCESS: true }),
            json!([OAUTH_REFRESH]),
            json!(OAUTH_ACCESS),
            json!({ "copied": claude_code_sign_in().to_string() }),
        ] {
            assert!(json_contains_claude_material(&value), "{value}");
        }
    }

    #[test]
    fn json_without_a_claude_sign_in_is_not_claude_material() {
        for value in [
            json!({
                "OPENAI_API_KEY": null,
                "tokens": {
                    "id_token": "header.payload.signature",
                    "access_token": "codex-access-token",
                    "refresh_token": "codex-refresh-token",
                    "account_id": "acct_inert"
                },
                "last_refresh": "2026-11-13T00:00:00Z"
            }),
            json!({ "OPENAI_API_KEY": "sk-proj-inert" }),
            json!({ "OPENAI_API_KEY": API_KEY }),
            json!({ "keys": [API_KEY, ADMIN_KEY], "note": "risk-ant-oat01" }),
            json!({ API_KEY: 1 }),
            json!(null),
            json!(42),
            json!(true),
            json!({}),
            json!([]),
        ] {
            assert!(!json_contains_claude_material(&value), "{value}");
        }
    }

    fn nested(levels: usize, leaf: JsonValue) -> JsonValue {
        (1..levels).fold(leaf, |inner, level| {
            if level % 2 == 0 {
                json!([inner])
            } else {
                json!({ "next": inner })
            }
        })
    }

    #[test]
    fn the_walk_reads_eight_levels_and_fails_closed_below_them() {
        // `nested(n, leaf)` puts the leaf at level n.
        for leaf in [json!("ordinary"), json!(null), json!({}), json!(API_KEY)] {
            let at_the_limit = nested(MAX_JSON_DEPTH, leaf.clone());
            assert!(
                !json_contains_claude_material(&at_the_limit),
                "{at_the_limit}"
            );
            let one_deeper = nested(MAX_JSON_DEPTH + 1, leaf);
            assert!(json_contains_claude_material(&one_deeper), "{one_deeper}");
        }
        let token_at_the_limit = nested(MAX_JSON_DEPTH, json!(OAUTH_ACCESS));
        assert!(json_contains_claude_material(&token_at_the_limit));
        let key_at_the_limit = nested(MAX_JSON_DEPTH, json!({ "claudeAiOauth": 1 }));
        assert!(json_contains_claude_material(&key_at_the_limit));
        // An empty container at the limit holds nothing below it.
        assert!(!json_contains_claude_material(&nested(
            MAX_JSON_DEPTH,
            json!([])
        )));
    }

    #[test]
    fn the_reserved_name_is_recognised_as_normalize_secret_name_writes_it() {
        for name in [
            "CLAUDE_CODE_OAUTH_TOKEN",
            "claude_code_oauth_token",
            "claude-code-oauth-token",
            "Claude Code OAuth Token",
            "  claude-code_oauth token  ",
        ] {
            assert!(is_reserved_secret_name(name), "{name:?}");
        }
        for name in [
            "",
            "CLAUDE_CODE_OAUTH_TOKEN_2",
            "MY_CLAUDE_CODE_OAUTH_TOKEN",
            "CLAUDE_CODE_OAUTH",
            "CLAUDECODE_OAUTH_TOKEN",
            "CLAUDE__CODE_OAUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "CLAUDE_CONFIG_DIR",
        ] {
            assert!(!is_reserved_secret_name(name), "{name:?}");
        }
    }

    #[test]
    fn a_secret_is_refused_by_its_name_or_its_value() {
        assert!(is_refused_secret(
            "CLAUDE_CODE_OAUTH_TOKEN",
            Some("anything")
        ));
        assert!(is_refused_secret("claude-code-oauth-token", None));
        assert!(is_refused_secret("DEPLOY_TOKEN", Some(OAUTH_ACCESS)));
        assert!(is_refused_secret(
            "SETTINGS",
            Some(&claude_code_sign_in().to_string())
        ));
        assert!(!is_refused_secret("ANTHROPIC_API_KEY", Some(API_KEY)));
        assert!(!is_refused_secret("ANTHROPIC_ADMIN_KEY", Some(ADMIN_KEY)));
        assert!(!is_refused_secret("DEPLOY_TOKEN", Some("risk-ant-oat01")));
        // A value that could not be read is judged by the name alone.
        assert!(!is_refused_secret("DEPLOY_TOKEN", None));
    }

    #[test]
    fn the_refusal_is_a_400_with_its_code_and_message() {
        let (status, Json(error)) = claude_credential_refused();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(error.code.as_deref(), Some("claude_credential_refused"));
        assert_eq!(
            error.message,
            "Instafy doesn't store Claude sign-ins. Claude Code turns use the Claude Code \
             signed in on your own computer."
        );
        assert!(error.details.is_none());
    }
}
