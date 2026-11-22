//! A person's Claude Code logins (docs/Local-Engine-Turns.md 11.19).
//!
//! A login is a Claude Code configuration folder (`CLAUDE_CONFIG_DIR`) on one
//! of the person's computers that they signed in to themselves, with Claude
//! Code's own `/login`. The controller keeps only its id and the name its
//! person gives it (`claude_code_logins`): no folder, path, account or
//! sign-in. Desktop records which folder is which login on each computer, and
//! the runtime attests which of the grant's logins are ready
//! (`runtime::register`). An agent names the login its turns run on
//! (`user_agents.claude_code_login_id`, `ai_agents`), and a lane job the
//! logins it may run on, so one turn runs at a time on each login
//! (`claude_code_lane`).
//!
//! The routes serve a person's own session only (`require_user_session`),
//! never the service role or a job token:
//! - `GET /me/claude-code-logins` lists them, oldest first;
//! - `POST /me/claude-code-logins` adds one, only while the rollout switch
//!   covers the person (403 `claude_code_turn_not_allowed`);
//! - `PATCH /me/claude-code-logins/:id` renames one;
//! - `DELETE /me/claude-code-logins/:id` removes one, and the agents that
//!   named it run on the person's first login from then on (`on delete set
//!   null`).
//!
//! Another person's login is never found (404).

use std::str::FromStr;

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio_postgres::error::SqlState;
use tokio_postgres::Row;
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session};
use crate::{bad_request, internal_error, not_found, ApiError, AppState};

type Refusal = (StatusCode, Json<ApiError>);

/// The most Claude Code logins a person has, as a grant carries and a
/// capability lists at most (runtime-contracts' `MAX_LOGINS`).
const MAX_LOGINS: usize = runtime_contracts::claude_code_lane::MAX_LOGINS;
/// The longest label, in characters (Unicode scalar values, as Postgres's
/// `char_length` counts them), once trimmed.
const LABEL_MAX_CHARS: usize = 60;

/// A label that is empty once trimmed, longer than [`LABEL_MAX_CHARS`], or
/// holds a control character or a second line.
pub(crate) const LABEL_INVALID: &str = "claude_code_login_label_invalid";
/// Another login of the person's has the label, ignoring case.
pub(crate) const LABEL_TAKEN: &str = "claude_code_login_label_taken";
/// The person has [`MAX_LOGINS`] logins already.
pub(crate) const LIMIT: &str = "claude_code_login_limit";
/// The unique index that keeps a person's labels apart ignoring case.
const LABEL_INDEX: &str = "claude_code_logins_user_label_idx";

/// One login as the routes answer it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeCodeLogin {
    id: Uuid,
    label: String,
    created_at: String,
}

impl ClaudeCodeLogin {
    fn of(row: &Row) -> Self {
        Self {
            id: row.get("id"),
            label: row.get("label"),
            created_at: row.get::<_, DateTime<Utc>>("created_at").to_rfc3339(),
        }
    }
}

#[derive(Debug, Serialize)]
struct ClaudeCodeLogins {
    logins: Vec<ClaudeCodeLogin>,
}

/// The body of an add or a rename.
#[derive(Debug, Deserialize)]
struct LoginBody {
    #[serde(default)]
    label: Option<String>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/me/claude-code-logins", get(list_logins).post(add_login))
        .route(
            "/me/claude-code-logins/:login_id",
            patch(rename_login).delete(delete_login),
        )
}

fn refusal(status: StatusCode, code: &str, message: &str) -> Refusal {
    (
        status,
        Json(ApiError {
            message: message.to_string(),
            code: Some(code.to_string()),
            details: None,
        }),
    )
}

fn label_invalid() -> Refusal {
    refusal(
        StatusCode::BAD_REQUEST,
        LABEL_INVALID,
        "A login's name is 1 to 60 characters on one line, and can't hold double quotes or \
         invisible characters.",
    )
}

fn label_taken() -> Refusal {
    refusal(
        StatusCode::CONFLICT,
        LABEL_TAKEN,
        "You already have a Claude Code login with this name.",
    )
}

fn limit_reached() -> Refusal {
    (
        StatusCode::CONFLICT,
        Json(ApiError::with_details(
            "You have as many Claude Code logins as you can. Delete one to add another.",
            LIMIT,
            json!({ "max": MAX_LOGINS }),
        )),
    )
}

fn login_not_found() -> Refusal {
    not_found("Claude Code login not found")
}

/// A character a label never holds, as Desktop refuses it in the name it
/// shows, quoted, in the consent dialog for the login
/// (packages/desktop-app/src/claudeCode/consent.ts): a control character or
/// a line or paragraph separator, which would break the dialog's line; a
/// Unicode format character other than the zero-width joiner and non-joiner,
/// which is invisible, and among which the text-direction marks, embeddings,
/// overrides and isolates can make the dialog's question read as other words
/// (`author_identity::is_format_character`); and a double quote, since the
/// dialog quotes the name. A Rust string holds no surrogate, the one other
/// kind Desktop refuses. A name of any of these could be kept here but set
/// up on no computer.
fn is_label_refused(ch: char) -> bool {
    ch.is_control()
        || matches!(ch, '\u{2028}' | '\u{2029}' | '"')
        || crate::author_identity::is_format_character(ch)
}

/// `label` as a login keeps it: trimmed, 1 to [`LABEL_MAX_CHARS`] characters,
/// on one line, with none of the characters Desktop refuses
/// ([`is_label_refused`], docs/Local-Engine-Turns.md 11.19). The table's own
/// check holds the trim and the length too.
fn normalize_label(label: Option<&str>) -> Result<String, Refusal> {
    let label = label.map(str::trim).unwrap_or_default();
    let chars = label.chars().count();
    if !(1..=LABEL_MAX_CHARS).contains(&chars) || label.chars().any(is_label_refused) {
        return Err(label_invalid());
    }
    Ok(label.to_string())
}

fn parse_login_id(raw: &str) -> Result<Uuid, Refusal> {
    Uuid::from_str(raw.trim()).map_err(|_| bad_request("loginId must be a valid UUID"))
}

/// A write's refusal for a label another login of the person's has, else the
/// internal error `what` failed with.
fn write_refusal(error: tokio_postgres::Error, what: &str) -> Refusal {
    let label_taken_here = error.code() == Some(&SqlState::UNIQUE_VIOLATION)
        && error
            .as_db_error()
            .and_then(|error| error.constraint())
            .is_some_and(|constraint| constraint == LABEL_INDEX);
    if label_taken_here {
        return label_taken();
    }
    internal_error(format!("failed to {what}: {error}"))
}

async fn list_logins(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<ClaudeCodeLogins>, Refusal> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let rows = connection
        .query(
            "select id, label, created_at
               from claude_code_logins
              where user_id = $1
              order by created_at, id",
            &[&user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to list the Claude Code logins: {error}"))
        })?;
    Ok(Json(ClaudeCodeLogins {
        logins: rows.iter().map(ClaudeCodeLogin::of).collect(),
    }))
}

/// Adds a login for the person, only while the rollout switch covers them:
/// the switch that lets their agents use Claude Code at all (L1).
async fn add_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Result<(StatusCode, Json<ClaudeCodeLogin>), Refusal> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    if !state.config.claude_code_lane.allow(user_id) {
        return Err(crate::claude_code_lane::not_allowed());
    }
    let label = normalize_label(body.label.as_deref())?;
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    // Two adds of the person's at once count each other's login: the limit
    // holds however they race.
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&format!("claude-code-logins:{user_id}")],
        )
        .await
        .map_err(|error| {
            internal_error(format!(
                "failed to take the person's Claude Code logins lock: {error}"
            ))
        })?;
    let count: i64 = transaction
        .query_one(
            "select count(*) from claude_code_logins where user_id = $1",
            &[&user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to count the Claude Code logins: {error}"))
        })?
        .get(0);
    if count >= MAX_LOGINS as i64 {
        return Err(limit_reached());
    }
    let row = transaction
        .query_one(
            "insert into claude_code_logins (user_id, label)
             values ($1, $2)
             returning id, label, created_at",
            &[&user_id, &label],
        )
        .await
        .map_err(|error| write_refusal(error, "add the Claude Code login"))?;
    transaction
        .commit()
        .await
        .map_err(|error| internal_error(format!("failed to add the Claude Code login: {error}")))?;
    Ok((StatusCode::CREATED, Json(ClaudeCodeLogin::of(&row))))
}

async fn rename_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(login_id_raw): AxumPath<String>,
    Json(body): Json<LoginBody>,
) -> Result<Json<ClaudeCodeLogin>, Refusal> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    let login_id = parse_login_id(&login_id_raw)?;
    let label = normalize_label(body.label.as_deref())?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let row = connection
        .query_opt(
            "update claude_code_logins
                set label = $3
              where id = $1 and user_id = $2
              returning id, label, created_at",
            &[&login_id, &user_id, &label],
        )
        .await
        .map_err(|error| write_refusal(error, "rename the Claude Code login"))?
        .ok_or_else(login_not_found)?;
    Ok(Json(ClaudeCodeLogin::of(&row)))
}

/// Removes a login of the person's. Their agents that named it lose it, and
/// run on the person's first login from then on; a waiting turn that named
/// it takes their first login when a computer leases it, and a running one
/// runs on.
async fn delete_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(login_id_raw): AxumPath<String>,
) -> Result<StatusCode, Refusal> {
    let context = authenticate_request(&state.config, &headers).await?;
    let user_id = require_user_session(&context)?;
    let login_id = parse_login_id(&login_id_raw)?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let deleted = connection
        .execute(
            "delete from claude_code_logins where id = $1 and user_id = $2",
            &[&login_id, &user_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to delete the Claude Code login: {error}"))
        })?;
    if deleted == 0 {
        return Err(login_not_found());
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code_of(refusal: &Refusal) -> (StatusCode, Option<&str>) {
        (refusal.0, refusal.1 .0.code.as_deref())
    }

    /// A label is kept trimmed, and only when 1 to 60 characters on one line
    /// with no control character, counted as Postgres counts them.
    #[test]
    fn a_label_is_one_short_line() {
        for (raw, kept) in [
            ("Work", "Work"),
            ("  Personal plan \t", "Personal plan"),
            ("Écrire 🚀", "Écrire 🚀"),
            // An emoji joined by a zero-width joiner, and a name a zero-width
            // non-joiner parts, as Persian writes it.
            (
                "Coding \u{1F469}\u{200D}\u{1F4BB}",
                "Coding \u{1F469}\u{200D}\u{1F4BB}",
            ),
            (
                "\u{0645}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}",
                "\u{0645}\u{06CC}\u{200C}\u{062E}\u{0648}\u{0627}\u{0647}\u{0645}",
            ),
            ("Work 'plan'", "Work 'plan'"),
        ] {
            assert_eq!(normalize_label(Some(raw)).expect(raw), kept);
        }
        let sixty = "é".repeat(LABEL_MAX_CHARS);
        assert_eq!(normalize_label(Some(&sixty)).expect("sixty"), sixty);
        for raw in [None, Some(""), Some("   "), Some("\u{3000}\n")]
            .into_iter()
            .map(|raw| raw.map(str::to_string))
            .chain([
                Some("é".repeat(LABEL_MAX_CHARS + 1)),
                Some("Work\nHome".to_string()),
                Some("Work\u{0007}".to_string()),
                Some("Work\u{2028}Home".to_string()),
                Some("Work \u{202e}emoH".to_string()),
                Some("\u{2066}Work\u{2069}".to_string()),
                // What Desktop refuses in the name its consent dialog quotes:
                // a format character other than the joiners, invisible, such
                // as a zero-width space, a soft hyphen or the tags of a
                // subdivision flag, and a double quote.
                Some("Work\u{200B}plan".to_string()),
                Some("Work\u{00AD}plan".to_string()),
                Some("\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}".to_string()),
                Some("Work \"plan\"".to_string()),
                Some("\u{FEFF}Work".to_string()),
                Some("Work\u{2060}".to_string()),
            ])
        {
            let refusal = normalize_label(raw.as_deref()).expect_err("refused");
            assert_eq!(
                code_of(&refusal),
                (StatusCode::BAD_REQUEST, Some(LABEL_INVALID)),
                "{raw:?}"
            );
        }
    }

    /// A label's characters are refused exactly as Desktop's consent dialog
    /// refuses them: every control and format character but the two
    /// joiners, the line and paragraph separators, and the double quote.
    #[test]
    fn a_label_refuses_what_desktop_refuses() {
        for ch in ['\u{0000}', '\u{001F}', '\u{007F}', '\u{0085}', '\u{009F}'] {
            assert!(is_label_refused(ch), "{:04X}", ch as u32);
        }
        for ch in [
            '\u{00AD}',
            '\u{0600}',
            '\u{061C}',
            '\u{06DD}',
            '\u{070F}',
            '\u{180E}',
            '\u{200B}',
            '\u{200E}',
            '\u{200F}',
            '\u{202A}',
            '\u{202E}',
            '\u{2060}',
            '\u{2066}',
            '\u{2069}',
            '\u{206F}',
            '\u{FEFF}',
            '\u{FFF9}',
            '\u{110BD}',
            '\u{13430}',
            '\u{1BCA0}',
            '\u{1D173}',
            '\u{E0001}',
            '\u{E0020}',
            '\u{E007F}',
            '\u{2028}',
            '\u{2029}',
            '"',
        ] {
            assert!(is_label_refused(ch), "{:04X}", ch as u32);
        }
        for ch in [
            '\u{200C}',
            '\u{200D}',
            'a',
            ' ',
            '\'',
            '\u{00A0}',
            '\u{FE0F}',
            '\u{1F3F4}',
            '\u{E0100}',
        ] {
            assert!(!is_label_refused(ch), "{:04X}", ch as u32);
        }
        assert_eq!(
            label_invalid().1 .0.message,
            "A login's name is 1 to 60 characters on one line, and can't hold double quotes or \
             invisible characters."
        );
    }

    #[test]
    fn the_refusals_carry_their_codes() {
        assert_eq!(
            code_of(&label_taken()),
            (StatusCode::CONFLICT, Some(LABEL_TAKEN))
        );
        let limit = limit_reached();
        assert_eq!(code_of(&limit), (StatusCode::CONFLICT, Some(LIMIT)));
        assert_eq!(limit.1 .0.details, Some(json!({ "max": 10 })));
        assert_eq!(login_not_found().0, StatusCode::NOT_FOUND);
    }
}
