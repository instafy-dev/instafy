//! Your computers (docs/Local-Engine-Turns.md 11.23, D54): the computers where
//! Instafy Desktop runs signed in as a person, so their Claude Code turns can
//! reach one of them from any client.
//!
//! A lane turn's path does not change here. Dispatch admits it, queues its
//! unpinned job, and only a runtime the lease clause accepts leases it
//! (`claude_code_lane::lane_turn_runs_on`). This layer does three things
//! beside it:
//! - it tells a person's computer which of their spaces holds a waiting turn
//!   that computer's Claude Code logins could run ([`poll`]);
//! - it lets the computer say it is starting that space, so the person's other
//!   computers leave it alone, or that the start failed ([`claim`]);
//! - it records whether each computer is on, what it runs and why it did not
//!   start a space, so every client of the person's can say so.
//!
//! A row (`user_computers`) holds the ids of the person's Claude Code logins
//! that are ready on the computer, intersected with their own
//! `claude_code_logins`, and never a folder, path, account or sign-in. The
//! runtime it names is kept only when it is a private runtime attested to the
//! person. Nothing reads a row to decide a lease: a forged row can delay its
//! own person's turns or start their own spaces, and nothing else.
//!
//! The routes serve a person's own session only (`require_user_session`),
//! never the service role, a job, runtime or origin token:
//! - `GET /me/computers` lists their computers;
//! - `PATCH /me/computers/:id` renames one or pauses it (`status`), the
//!   person's own stop, from any client;
//! - `DELETE /me/computers/:id` forgets one;
//! - `POST /me/computers/:id/offline` says it is going to sleep or quitting;
//! - `POST /me/computers/poll` is the computer's heartbeat and held wait for
//!   work, and `POST /me/computers/:id/claim` its claim of a space. Both need
//!   the rollout switch to cover the person (403
//!   `claude_code_turn_not_allowed`).
//!
//! Another person's computer is never found (404).

use std::collections::HashSet;
use std::str::FromStr;
use std::time::Duration;

use axum::extract::{Path as AxumPath, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio_postgres::GenericClient;
use tokio_postgres::Row;
use uuid::Uuid;

use crate::auth::{authenticate_request, require_user_session, RequestContext};
use crate::state::{publish_controller_event_to_user, EventHub};
use crate::{bad_request, internal_error, not_found, ApiError, AppState};

type Refusal = (StatusCode, Json<ApiError>);

/// The most computers a person has.
pub(crate) const MAX_COMPUTERS: i64 = 10;
/// A computer is online while its last poll is at most this old, and it has
/// not said it went offline since. A held poll lasts at most
/// [`POLL_WAIT_MAX`], and the next starts at once.
pub(crate) const ONLINE_TTL_SECONDS: i64 = 45;
/// A computer unseen this long is forgotten when its person adds another.
const FORGOTTEN_AFTER_DAYS: i64 = 30;
/// The longest a poll is held.
const POLL_WAIT_MAX: Duration = Duration::from_secs(20);
/// A held poll re-checks this often, so a turn that becomes wanted without an
/// event (an earlier turn ended, a plan limit reset) is found in time.
const POLL_RECHECK: Duration = Duration::from_secs(5);
/// The most waiting spaces a poll answers with, oldest first.
const MAX_WANTED: usize = 5;
/// The most waiting turns a poll reads before it keeps one per space.
const WANTED_CANDIDATES: i64 = 25;
/// The most decisions a computer keeps, one per space.
const MAX_DECISIONS: usize = 20;
/// How long a claim keeps the person's other computers off a space: a cold
/// start takes 10 to 30 s, after which the computer runs the space.
const CLAIM_SECONDS: i64 = 120;
/// How long a failed start keeps a computer off that space.
const FAILURE_COOLDOWN_SECONDS: i64 = 600;
/// The longest label, in characters, once trimmed.
const LABEL_MAX_CHARS: usize = 60;
/// The label of a computer whose Desktop reports none Studio could show.
const DEFAULT_LABEL: &str = "This computer";

/// The event dispatch publishes to a person, with the space, after it queued
/// a Claude Code turn of theirs: it wakes their computers' held polls on every
/// node (`EventHub::computer_waker`) and tells their clients to look again.
pub(crate) const COMPUTERS_WANTED_EVENT: &str = "computers.wanted";

/// The person has [`MAX_COMPUTERS`] computers already.
pub(crate) const LIMIT: &str = "computer_limit";
/// Another online computer of the person's is starting the space.
pub(crate) const CLAIM_TAKEN: &str = "computer_claim_taken";
/// The person paused the computer.
pub(crate) const PAUSED: &str = "computer_paused";
/// A label that is empty once trimmed, too long or holds a control or
/// invisible character.
pub(crate) const LABEL_INVALID: &str = "computer_label_invalid";

/// Why a computer did or did not start a space where a turn of its person's
/// waits, as it reports it and Studio words it (11.23).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
    /// It is starting the space.
    Starting,
    /// It already runs the space.
    RunsHere,
    /// It runs a Claude Code turn already, and runs this one next.
    Busy,
    /// Someone is using Desktop on another space.
    InUse,
    /// It has never opened the space, and starts no space it has no copy of.
    NoWorkingCopy,
    /// The person cannot start the space there.
    NoAccess,
    /// The space has no repository Desktop could sync.
    NoGitRemote,
    /// Its Desktop is too old to start spaces by itself.
    DesktopUpdate,
    /// Its start failed.
    Failed,
}

impl Decision {
    pub(crate) const ALL: [Decision; 9] = [
        Decision::Starting,
        Decision::RunsHere,
        Decision::Busy,
        Decision::InUse,
        Decision::NoWorkingCopy,
        Decision::NoAccess,
        Decision::NoGitRemote,
        Decision::DesktopUpdate,
        Decision::Failed,
    ];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Decision::Starting => "starting",
            Decision::RunsHere => "runs_here",
            Decision::Busy => "busy",
            Decision::InUse => "in_use",
            Decision::NoWorkingCopy => "no_working_copy",
            Decision::NoAccess => "no_access",
            Decision::NoGitRemote => "no_git_remote",
            Decision::DesktopUpdate => "desktop_update",
            Decision::Failed => "failed",
        }
    }

    pub(crate) fn parse(raw: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|decision| decision.as_str() == raw.trim())
    }

    /// A reason a failed start reports in its claim: one that keeps the
    /// computer off the space for a while.
    fn is_failure(self) -> bool {
        matches!(
            self,
            Decision::Failed | Decision::NoAccess | Decision::NoGitRemote | Decision::NoWorkingCopy
        )
    }
}

// `computer_is_online!` spells the time to live as a literal, which a SQL
// fragment built with `concat!` needs; it must stay this constant's value.
const _: () = assert!(ONLINE_TTL_SECONDS == 45);

/// Whether the `user_computers` row `$computer` (an alias) is online: seen
/// within [`ONLINE_TTL_SECONDS`], and not offline since.
macro_rules! computer_is_online {
    ($computer:literal) => {
        concat!(
            "(",
            $computer,
            ".last_seen_at >= now() - interval '45 seconds' and (",
            $computer,
            ".offline_at is null or ",
            $computer,
            ".offline_at < ",
            $computer,
            ".last_seen_at))"
        )
    };
}

/// The columns a computer is read with, by the alias `c`.
macro_rules! computer_columns {
    () => {
        concat!(
            "c.id, c.label, c.platform, c.desktop_version, c.starts_spaces, c.logins,
             c.runtime_id, c.project_id, c.status, c.decisions, c.failed_project_id,
             c.last_seen_at, c.offline_at, c.offline_reason, c.created_at,
             case when c.claimed_until > now() then c.claimed_project_id end
               as claimed_project_id,
             case when c.failed_until > now() then c.failed_project_id end
               as cooling_project_id,
             ",
            computer_is_online!("c"),
            " as online"
        )
    };
}

/// One computer as the routes answer it, to its own person only.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Computer {
    pub(crate) id: Uuid,
    pub(crate) label: String,
    pub(crate) platform: String,
    pub(crate) desktop_version: Option<String>,
    pub(crate) starts_spaces: bool,
    /// Ids of the person's Claude Code logins ready on it.
    pub(crate) logins: Vec<Uuid>,
    /// `available`, or `paused` by the person.
    pub(crate) status: String,
    pub(crate) online: bool,
    pub(crate) last_seen_at: String,
    pub(crate) offline_at: Option<String>,
    /// `quit` or `sleep`, as the computer said when it went offline.
    pub(crate) offline_reason: Option<String>,
    /// The space Desktop runs there now.
    pub(crate) running_project_id: Option<Uuid>,
    /// The space it is starting.
    pub(crate) claimed_project_id: Option<Uuid>,
    /// Why it did or did not start each space where a turn waited.
    pub(crate) decisions: JsonValue,
    pub(crate) created_at: String,
    #[serde(skip)]
    runtime_id: Option<Uuid>,
    #[serde(skip)]
    cooling_project_id: Option<Uuid>,
}

impl Computer {
    fn of(row: &Row) -> Self {
        Self {
            id: row.get("id"),
            label: row.get("label"),
            platform: row.get("platform"),
            desktop_version: row.get("desktop_version"),
            starts_spaces: row.get("starts_spaces"),
            logins: row.get("logins"),
            status: row.get("status"),
            online: row.get("online"),
            last_seen_at: row.get::<_, DateTime<Utc>>("last_seen_at").to_rfc3339(),
            offline_at: row
                .get::<_, Option<DateTime<Utc>>>("offline_at")
                .map(|at| at.to_rfc3339()),
            offline_reason: row.get("offline_reason"),
            running_project_id: row.get("project_id"),
            claimed_project_id: row.get("claimed_project_id"),
            decisions: row.get("decisions"),
            created_at: row.get::<_, DateTime<Utc>>("created_at").to_rfc3339(),
            runtime_id: row.get("runtime_id"),
            cooling_project_id: row.get("cooling_project_id"),
        }
    }

    fn is_paused(&self) -> bool {
        self.status == "paused"
    }
}

#[derive(Debug, Serialize)]
struct Computers {
    computers: Vec<Computer>,
}

/// A space where a turn of the person's waits that this computer could run:
/// ids only, never the turn's words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Wanted {
    pub(crate) project_id: Uuid,
    /// The login the turn takes when a computer leases it now.
    pub(crate) login_id: Uuid,
    pub(crate) waiting_since: String,
}

/// The Claude Code turn this computer's runtime runs now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Running {
    pub(crate) project_id: Uuid,
    pub(crate) login_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PollAnswer {
    computer: Computer,
    wanted: Vec<Wanted>,
    running: Option<Running>,
    /// Set when the poll was held: the answer may have changed, or the wait
    /// ran out, and either way the computer polls again.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    waited: bool,
}

/// A computer's poll: its heartbeat and report, and what it already knows.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PollBody {
    #[serde(default)]
    device_key: String,
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    desktop_version: Option<String>,
    /// Whether this Desktop starts spaces by itself: it can, and the person
    /// said it may.
    #[serde(default)]
    starts_spaces: bool,
    /// Login ids, as strings or `{ "id": … }`. Anything else is dropped.
    #[serde(default)]
    logins: Vec<JsonValue>,
    #[serde(default)]
    runtime_id: Option<String>,
    #[serde(default)]
    decisions: Vec<JsonValue>,
    /// The waiting spaces of its last answer.
    #[serde(default)]
    known: Vec<String>,
    /// The space of the running turn of its last answer.
    #[serde(default)]
    known_running: Option<String>,
    #[serde(default)]
    wait_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimBody {
    #[serde(default)]
    project_id: String,
    /// A failed start's reason: no claim, and the space is left alone for a
    /// while.
    #[serde(default)]
    failed: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OfflineBody {
    #[serde(default)]
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PatchBody {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    status: Option<String>,
}

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/me/computers", get(list_computers))
        .route("/me/computers/poll", post(poll))
        .route(
            "/me/computers/:computer_id",
            patch(change_computer).delete(forget_computer),
        )
        .route("/me/computers/:computer_id/claim", post(claim))
        .route("/me/computers/:computer_id/offline", post(went_offline))
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

fn computer_not_found() -> Refusal {
    not_found("Computer not found")
}

fn limit_reached() -> Refusal {
    (
        StatusCode::CONFLICT,
        Json(ApiError::with_details(
            "You have as many computers as you can. Forget one to add another.",
            LIMIT,
            json!({ "max": MAX_COMPUTERS }),
        )),
    )
}

fn claim_taken() -> Refusal {
    refusal(
        StatusCode::CONFLICT,
        CLAIM_TAKEN,
        "Another of your computers is starting this space.",
    )
}

fn paused() -> Refusal {
    refusal(
        StatusCode::CONFLICT,
        PAUSED,
        "This computer is paused. Resume it to let it start spaces.",
    )
}

fn label_invalid() -> Refusal {
    refusal(
        StatusCode::BAD_REQUEST,
        LABEL_INVALID,
        "A computer's name is 1 to 60 characters on one line, and can't hold invisible \
         characters.",
    )
}

fn parse_id(raw: &str, what: &str) -> Result<Uuid, Refusal> {
    Uuid::from_str(raw.trim()).map_err(|_| bad_request(format!("{what} must be a valid UUID")))
}

fn database_error(what: &str) -> impl Fn(tokio_postgres::Error) -> Refusal + '_ {
    move |error| internal_error(format!("failed to {what}: {error}"))
}

/// A character a computer's name never holds: a control character, a line or
/// paragraph separator, or an invisible format character other than the
/// zero-width joiner and non-joiner.
fn is_label_refused(ch: char) -> bool {
    ch.is_control()
        || matches!(ch, '\u{2028}' | '\u{2029}')
        || crate::author_identity::is_format_character(ch)
}

/// The name a person gives a computer: trimmed, 1 to [`LABEL_MAX_CHARS`]
/// characters, with none of [`is_label_refused`].
fn normalize_label(label: &str) -> Result<String, Refusal> {
    let label = label.trim();
    let chars = label.chars().count();
    if !(1..=LABEL_MAX_CHARS).contains(&chars) || label.chars().any(is_label_refused) {
        return Err(label_invalid());
    }
    Ok(label.to_string())
}

/// The name Desktop reports for a new computer, made one Studio can show:
/// refused characters become spaces, runs of space fold, and it is cut to
/// [`LABEL_MAX_CHARS`]. A report with nothing left names it
/// [`DEFAULT_LABEL`].
fn reported_label(label: Option<&str>) -> String {
    let cleaned: String = label
        .unwrap_or_default()
        .chars()
        .map(|ch| if is_label_refused(ch) { ' ' } else { ch })
        .collect();
    let folded = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cut: String = folded.chars().take(LABEL_MAX_CHARS).collect();
    let cut = cut.trim().to_string();
    if cut.is_empty() {
        DEFAULT_LABEL.to_string()
    } else {
        cut
    }
}

/// Desktop's id for the computer: `desktop-` and a UUID, lowercased.
fn device_key(raw: &str) -> Result<String, Refusal> {
    let raw = raw.trim().to_ascii_lowercase();
    raw.strip_prefix("desktop-")
        .and_then(|rest| Uuid::from_str(rest).ok())
        .filter(|uuid| raw == format!("desktop-{uuid}"))
        .map(|_| raw.clone())
        .ok_or_else(|| bad_request("deviceKey must be Desktop's computer id"))
}

/// A short word of letters, digits and `.+-_`, as a platform or a version is,
/// at most `max` characters; anything else is dropped.
fn short_word(raw: Option<&str>, max: usize) -> Option<String> {
    let word = raw?.trim();
    (!word.is_empty()
        && word.chars().count() <= max
        && word
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '+' | '-' | '_')))
    .then(|| word.to_string())
}

/// The login ids of a poll, as UUIDs: a string, or an object's `id`. Anything
/// else, such as a folder, is dropped here and never stored.
fn reported_logins(logins: &[JsonValue]) -> Vec<Uuid> {
    let mut seen = HashSet::new();
    logins
        .iter()
        .filter_map(|login| login.as_str().or_else(|| login.get("id")?.as_str()))
        .filter_map(|id| Uuid::from_str(id.trim()).ok())
        .filter(|id| seen.insert(*id))
        .take(runtime_contracts::claude_code_lane::MAX_LOGINS)
        .collect()
}

/// A poll's decisions as a row keeps them: `{projectId, reason}` with a known
/// reason, the first for each space, at most [`MAX_DECISIONS`].
fn reported_decisions(decisions: &[JsonValue]) -> JsonValue {
    let mut seen = HashSet::new();
    JsonValue::Array(
        decisions
            .iter()
            .filter_map(|decision| {
                let project = Uuid::from_str(decision.get("projectId")?.as_str()?.trim()).ok()?;
                let reason = Decision::parse(decision.get("reason")?.as_str()?)?;
                seen.insert(project)
                    .then(|| json!({ "projectId": project, "reason": reason.as_str() }))
            })
            .take(MAX_DECISIONS)
            .collect(),
    )
}

/// `decisions` with `project`'s set to `reason`, first, and at most
/// [`MAX_DECISIONS`].
fn with_decision(decisions: &JsonValue, project: Uuid, reason: Decision) -> JsonValue {
    let mut kept = vec![json!({ "projectId": project, "reason": reason.as_str() })];
    kept.extend(
        decisions
            .as_array()
            .into_iter()
            .flatten()
            .filter(|decision| decision.get("projectId") != Some(&json!(project)))
            .cloned(),
    );
    kept.truncate(MAX_DECISIONS);
    JsonValue::Array(kept)
}

fn person_context(person: Uuid) -> RequestContext {
    RequestContext {
        user_id: Some(person),
        is_service_role: false,
        scoped_claims: None,
    }
}

/// Wakes `person`'s computers' held polls on every node, and tells their
/// clients on `project_id`'s streams, if any, to look again. It carries no
/// words, only that something changed.
pub(crate) fn announce(hub: &EventHub, project_id: Option<Uuid>, person: Uuid) {
    publish_controller_event_to_user(hub, COMPUTERS_WANTED_EVENT, project_id, person, json!({}));
}

async fn load_computer(
    client: &impl GenericClient,
    person: Uuid,
    computer_id: Uuid,
) -> Result<Option<Computer>, Refusal> {
    let row = client
        .query_opt(
            concat!(
                "select ",
                computer_columns!(),
                " from user_computers c where c.id = $1 and c.user_id = $2"
            ),
            &[&computer_id, &person],
        )
        .await
        .map_err(database_error("read the computer"))?;
    Ok(row.as_ref().map(Computer::of))
}

async fn list_computers(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Computers>, Refusal> {
    let context = authenticate_request(&state.config, &headers).await?;
    let person = require_user_session(&context)?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let rows = connection
        .query(
            concat!(
                "select ",
                computer_columns!(),
                " from user_computers c where c.user_id = $1 order by c.created_at, c.id"
            ),
            &[&person],
        )
        .await
        .map_err(database_error("list the computers"))?;
    Ok(Json(Computers {
        computers: rows.iter().map(Computer::of).collect(),
    }))
}

/// Renames a computer, or pauses or resumes it: a paused computer is told of
/// no waiting turn, and starts no space. Its person can do it from any client,
/// whether or not the switch covers them.
async fn change_computer(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(computer_id_raw): AxumPath<String>,
    Json(body): Json<PatchBody>,
) -> Result<Json<Computer>, Refusal> {
    let context = authenticate_request(&state.config, &headers).await?;
    let person = require_user_session(&context)?;
    let computer_id = parse_id(&computer_id_raw, "computerId")?;
    let label = body.label.as_deref().map(normalize_label).transpose()?;
    let status = match body.status.as_deref().map(str::trim) {
        None => None,
        Some(status @ ("available" | "paused")) => Some(status.to_string()),
        Some(_) => return Err(bad_request("status must be available or paused")),
    };
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let updated = connection
        .execute(
            "update user_computers
                set label = coalesce($3, label),
                    status = coalesce($4, status),
                    claimed_project_id = case when $4 = 'paused' then null
                                              else claimed_project_id end,
                    claimed_until = case when $4 = 'paused' then null else claimed_until end
              where id = $1 and user_id = $2",
            &[&computer_id, &person, &label, &status],
        )
        .await
        .map_err(database_error("change the computer"))?;
    if updated == 0 {
        return Err(computer_not_found());
    }
    let computer = load_computer(&*connection, person, computer_id)
        .await?
        .ok_or_else(computer_not_found)?;
    if status.is_some() {
        announce(&state.events, None, person);
    }
    Ok(Json(computer))
}

/// Forgets a computer. Its Desktop adds it again with its next poll, if the
/// person is still signed in there.
async fn forget_computer(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(computer_id_raw): AxumPath<String>,
) -> Result<StatusCode, Refusal> {
    let context = authenticate_request(&state.config, &headers).await?;
    let person = require_user_session(&context)?;
    let computer_id = parse_id(&computer_id_raw, "computerId")?;
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let deleted = connection
        .execute(
            "delete from user_computers where id = $1 and user_id = $2",
            &[&computer_id, &person],
        )
        .await
        .map_err(database_error("forget the computer"))?;
    if deleted == 0 {
        return Err(computer_not_found());
    }
    announce(&state.events, None, person);
    Ok(StatusCode::NO_CONTENT)
}

/// The computer says it goes to sleep or quits: it reads offline at once,
/// rather than after [`ONLINE_TTL_SECONDS`], and drops its claim.
async fn went_offline(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(computer_id_raw): AxumPath<String>,
    Json(body): Json<OfflineBody>,
) -> Result<StatusCode, Refusal> {
    let context = authenticate_request(&state.config, &headers).await?;
    let person = require_user_session(&context)?;
    let computer_id = parse_id(&computer_id_raw, "computerId")?;
    let reason = match body.reason.as_deref().map(str::trim) {
        Some(reason @ ("quit" | "sleep")) => reason.to_string(),
        _ => return Err(bad_request("reason must be quit or sleep")),
    };
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let updated = connection
        .execute(
            "update user_computers
                set offline_at = greatest(now(), last_seen_at + interval '1 millisecond'),
                    offline_reason = $3,
                    claimed_project_id = null,
                    claimed_until = null
              where id = $1 and user_id = $2",
            &[&computer_id, &person, &reason],
        )
        .await
        .map_err(database_error("mark the computer offline"))?;
    if updated == 0 {
        return Err(computer_not_found());
    }
    announce(&state.events, None, person);
    Ok(StatusCode::NO_CONTENT)
}

/// A computer's claim of a space it starts, or the report that its start
/// failed. A claim keeps the person's other online computers off the space
/// for [`CLAIM_SECONDS`]; 409 [`CLAIM_TAKEN`] when one of them holds it. A
/// failure keeps this computer off it for [`FAILURE_COOLDOWN_SECONDS`].
async fn claim(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(computer_id_raw): AxumPath<String>,
    Json(body): Json<ClaimBody>,
) -> Result<Json<Computer>, Refusal> {
    let context = authenticate_request(&state.config, &headers).await?;
    let person = require_user_session(&context)?;
    if !state.config.claude_code_lane.allow(person) {
        return Err(crate::claude_code_lane::not_allowed());
    }
    let computer_id = parse_id(&computer_id_raw, "computerId")?;
    let project_id = parse_id(&body.project_id, "projectId")?;
    let failure = match body.failed.as_deref() {
        None => None,
        Some(raw) => Some(
            Decision::parse(raw)
                .filter(|decision| decision.is_failure())
                .ok_or_else(|| {
                    bad_request(
                        "failed must be failed, no_access, no_git_remote or no_working_copy",
                    )
                })?,
        ),
    };
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    lock_person(&transaction, person).await?;
    let computer = load_computer(&transaction, person, computer_id)
        .await?
        .ok_or_else(computer_not_found)?;
    match failure {
        Some(reason) => {
            transaction
                .execute(
                    "update user_computers
                        set failed_project_id = $3,
                            failed_until = now() + ($4::bigint * interval '1 second'),
                            decisions = $5,
                            claimed_project_id = case when claimed_project_id = $3 then null
                                                      else claimed_project_id end,
                            claimed_until = case when claimed_project_id = $3 then null
                                                 else claimed_until end
                      where id = $1 and user_id = $2",
                    &[
                        &computer_id,
                        &person,
                        &project_id,
                        &FAILURE_COOLDOWN_SECONDS,
                        &with_decision(&computer.decisions, project_id, reason),
                    ],
                )
                .await
                .map_err(database_error("record the failed start"))?;
        }
        None => {
            if computer.is_paused() {
                return Err(paused());
            }
            let taken: bool = transaction
                .query_one(
                    concat!(
                        "select exists (
                             select 1 from user_computers c
                              where c.user_id = $1
                                and c.id <> $2
                                and c.claimed_project_id = $3
                                and c.claimed_until > now()
                                and ",
                        computer_is_online!("c"),
                        ")"
                    ),
                    &[&person, &computer_id, &project_id],
                )
                .await
                .map_err(database_error("read the claims"))?
                .get(0);
            if taken {
                return Err(claim_taken());
            }
            transaction
                .execute(
                    "update user_computers
                        set claimed_project_id = $3,
                            claimed_until = now() + ($4::bigint * interval '1 second'),
                            decisions = $5
                      where id = $1 and user_id = $2",
                    &[
                        &computer_id,
                        &person,
                        &project_id,
                        &CLAIM_SECONDS,
                        &with_decision(&computer.decisions, project_id, Decision::Starting),
                    ],
                )
                .await
                .map_err(database_error("claim the space"))?;
        }
    }
    let computer = load_computer(&transaction, person, computer_id)
        .await?
        .ok_or_else(computer_not_found)?;
    transaction
        .commit()
        .await
        .map_err(database_error("commit the claim"))?;
    // A failure frees the space for the person's other computers, and their
    // clients word the claim or the failure.
    announce(&state.events, Some(project_id), person);
    Ok(Json(computer))
}

/// Serializes the writes of one person's computers: a claim and another
/// computer's claim, and an add and the limit.
async fn lock_person(
    transaction: &tokio_postgres::Transaction<'_>,
    person: Uuid,
) -> Result<(), Refusal> {
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&format!("user-computers:{person}")],
        )
        .await
        .map_err(database_error("take the person's computers lock"))?;
    Ok(())
}

/// What a poll reports of the computer, checked: the logins are the
/// person's, and the runtime is a private one attested to them.
struct Report {
    device_key: String,
    label: String,
    platform: String,
    desktop_version: Option<String>,
    starts_spaces: bool,
    logins: Vec<Uuid>,
    runtime_id: Option<Uuid>,
    decisions: JsonValue,
}

/// The runtime `runtime_id` and its space, if it is one this person's
/// computer may report as its own: private self-hosted, attested to the
/// person, and not a Personal Browser runtime.
async fn attested_runtime(
    state: &AppState,
    client: &impl GenericClient,
    person: Uuid,
    runtime_id: Option<Uuid>,
) -> Result<Option<(Uuid, Uuid)>, Refusal> {
    let Some(runtime_id) = runtime_id else {
        return Ok(None);
    };
    let Some(row) = client
        .query_opt(
            "select project_id, provider, capabilities from runtimes where id = $1",
            &[&runtime_id],
        )
        .await
        .map_err(database_error("read the computer's runtime"))?
    else {
        return Ok(None);
    };
    let provider: String = row.get("provider");
    let capabilities: JsonValue = row.get("capabilities");
    let attested = crate::runtime::runtime_is_private_self_hosted(state, &provider, &capabilities)
        && capabilities
            .get("_instafySelfHostedAccess")
            .filter(|access| access.get("mode").and_then(JsonValue::as_str) == Some("private"))
            .and_then(|access| access.get("ownerUserId"))
            .and_then(JsonValue::as_str)
            == Some(person.to_string().as_str())
        && crate::runtime::self_hosted_owner_user_id(&capabilities) == Some(person)
        && capabilities.get("personalBrowser").is_none()
        && capabilities.get("personal_browser").is_none();
    Ok(attested.then(|| (runtime_id, row.get("project_id"))))
}

/// The heartbeat: adds or updates the person's computer with what it
/// reports, as checked, and answers it. A new computer past
/// [`MAX_COMPUTERS`] is refused, after the person's computers unseen for
/// [`FORGOTTEN_AFTER_DAYS`] are forgotten.
async fn record_presence(
    state: &AppState,
    person: Uuid,
    report: &Report,
) -> Result<Computer, Refusal> {
    let mut connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    let logins: Vec<Uuid> = transaction
        .query(
            "select id from claude_code_logins
              where user_id = $1 and id = any($2)
              order by created_at, id",
            &[&person, &report.logins],
        )
        .await
        .map_err(database_error("read the person's Claude Code logins"))?
        .iter()
        .map(|row| row.get(0))
        .collect();
    let runtime = attested_runtime(state, &transaction, person, report.runtime_id).await?;
    let (runtime_id, project_id) = runtime.unzip();
    let existing: Option<Uuid> = transaction
        .query_opt(
            "select id from user_computers where user_id = $1 and device_key = $2",
            &[&person, &report.device_key],
        )
        .await
        .map_err(database_error("read the computer"))?
        .map(|row| row.get(0));
    let computer_id = match existing {
        Some(id) => {
            transaction
                .execute(
                    "update user_computers
                        set platform = $3, desktop_version = $4, starts_spaces = $5,
                            logins = $6, runtime_id = $7, project_id = $8, decisions = $9,
                            last_seen_at = now()
                      where id = $1 and user_id = $2",
                    &[
                        &id,
                        &person,
                        &report.platform,
                        &report.desktop_version,
                        &report.starts_spaces,
                        &logins,
                        &runtime_id,
                        &project_id,
                        &report.decisions,
                    ],
                )
                .await
                .map_err(database_error("record the computer's presence"))?;
            id
        }
        None => {
            lock_person(&transaction, person).await?;
            transaction
                .execute(
                    "delete from user_computers
                      where user_id = $1
                        and last_seen_at < now() - ($2::bigint * interval '1 day')",
                    &[&person, &FORGOTTEN_AFTER_DAYS],
                )
                .await
                .map_err(database_error("forget the person's old computers"))?;
            let count: i64 = transaction
                .query_one(
                    "select count(*) from user_computers where user_id = $1",
                    &[&person],
                )
                .await
                .map_err(database_error("count the computers"))?
                .get(0);
            if count >= MAX_COMPUTERS {
                return Err(limit_reached());
            }
            transaction
                .query_one(
                    "insert into user_computers (
                         user_id, device_key, label, platform, desktop_version,
                         starts_spaces, logins, runtime_id, project_id, decisions
                     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                     on conflict (user_id, device_key) do update
                        set last_seen_at = now()
                     returning id",
                    &[
                        &person,
                        &report.device_key,
                        &report.label,
                        &report.platform,
                        &report.desktop_version,
                        &report.starts_spaces,
                        &logins,
                        &runtime_id,
                        &project_id,
                        &report.decisions,
                    ],
                )
                .await
                .map_err(database_error("add the computer"))?
                .get(0)
        }
    };
    let computer = load_computer(&transaction, person, computer_id)
        .await?
        .ok_or_else(computer_not_found)?;
    transaction
        .commit()
        .await
        .map_err(database_error("record the computer's presence"))?;
    Ok(computer)
}

/// The spaces where a turn of `person`'s waits that `computer` could run now,
/// oldest first, one entry per space, at most [`MAX_WANTED`]: their own
/// queued, never-leased Claude Code turns whose login, as a lease would pick
/// it now (`claude_code_lane::lane_job_login`), is ready on the computer, that
/// wait for no earlier turn, in a space the person may still write to, that
/// none of their other online computers is starting, and that did not just
/// fail to start here. None for a paused computer.
pub(crate) async fn wanted_for(
    client: &impl GenericClient,
    person: Uuid,
    computer: &Computer,
) -> Result<Vec<Wanted>, Refusal> {
    if computer.is_paused() || computer.logins.is_empty() {
        return Ok(Vec::new());
    }
    let rows = client
        .query(
            concat!(
                "select aj.project_id, job_login.lane_login_id, aj.created_at
                   from agent_jobs aj
                   ",
                crate::claude_code_lane::lane_job_login!(),
                "
                  where aj.engine is not null
                    and aj.status = 'queued'
                    and (aj.payload ->> 'user_id') = $1
                    and aj.engine = 'claude-code'
                    and aj.lease_attempts = 0
                    and job_login.lane_login_id = any($2)
                    and not ",
                crate::message_turns::waits_for_an_earlier_turn!("aj"),
                "
                    and aj.project_id is distinct from $4
                    and not exists (
                        select 1 from user_computers c
                         where c.user_id = $5
                           and c.id <> $3
                           and c.claimed_project_id = aj.project_id
                           and c.claimed_until > now()
                           and ",
                computer_is_online!("c"),
                "
                    )
                  order by aj.created_at, aj.id
                  limit $6"
            ),
            &[
                &person.to_string(),
                &computer.logins,
                &computer.id,
                &computer.cooling_project_id,
                &person,
                &WANTED_CANDIDATES,
            ],
        )
        .await
        .map_err(database_error("read the person's waiting turns"))?;
    let context = person_context(person);
    let mut seen = HashSet::new();
    let mut wanted = Vec::new();
    for row in rows {
        let project_id: Uuid = row.get(0);
        if !seen.insert(project_id) {
            continue;
        }
        if !may_write(client, &context, &project_id).await? {
            continue;
        }
        wanted.push(Wanted {
            project_id,
            login_id: row.get(1),
            waiting_since: row.get::<_, DateTime<Utc>>(2).to_rfc3339(),
        });
        if wanted.len() == MAX_WANTED {
            break;
        }
    }
    Ok(wanted)
}

/// Whether the person may still write to the space: a computer starts only
/// spaces whose runtime token it could mint.
async fn may_write(
    client: &impl GenericClient,
    context: &RequestContext,
    project_id: &Uuid,
) -> Result<bool, Refusal> {
    let project = match crate::projects::load_project_record(client, project_id).await {
        Ok(project) => project,
        Err((StatusCode::NOT_FOUND, _)) => return Ok(false),
        Err(error) => return Err(error),
    };
    if project
        ._status
        .as_deref()
        .is_some_and(|status| status.eq_ignore_ascii_case("deleted"))
    {
        return Ok(false);
    }
    match crate::projects::ensure_project_write_access(client, &project, context, None).await {
        Ok(_) => Ok(true),
        Err((status, _)) if status.is_client_error() => Ok(false),
        Err(error) => Err(error),
    }
}

/// The Claude Code turn of the person's that the computer's runtime runs now.
async fn running_on(
    client: &impl GenericClient,
    person: Uuid,
    computer: &Computer,
) -> Result<Option<Running>, Refusal> {
    let Some(runtime_id) = computer.runtime_id else {
        return Ok(None);
    };
    let row = client
        .query_opt(
            "select project_id, claude_code_login_id
               from agent_jobs
              where engine = 'claude-code'
                and status = 'leased'
                and leased_by_runtime_id = $1
                and (payload ->> 'user_id') = $2
              order by leased_at desc nulls last
              limit 1",
            &[&runtime_id, &person.to_string()],
        )
        .await
        .map_err(database_error("read the computer's running turn"))?;
    Ok(row.map(|row| Running {
        project_id: row.get(0),
        login_id: row.get(1),
    }))
}

/// Whether an answer differs from what the computer already knows.
fn differs(
    wanted: &[Wanted],
    running: &Option<Running>,
    known: &HashSet<Uuid>,
    known_running: Option<Uuid>,
) -> bool {
    let wanted: HashSet<Uuid> = wanted.iter().map(|wanted| wanted.project_id).collect();
    wanted != *known || running.as_ref().map(|running| running.project_id) != known_running
}

/// A computer's poll: records its presence and what it reports, then answers
/// with the spaces where a turn of its person's waits that it could run
/// ([`wanted_for`]) and the turn it runs. With `waitMs`, the poll is held,
/// with no pool connection, up to [`POLL_WAIT_MAX`], until the answer differs
/// from what it already `known`: it re-checks every [`POLL_RECHECK`] and
/// whenever dispatch queues a Claude Code turn of the person's, on any node.
async fn poll(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PollBody>,
) -> Result<Json<PollAnswer>, Refusal> {
    let context = authenticate_request(&state.config, &headers).await?;
    let person = require_user_session(&context)?;
    if !state.config.claude_code_lane.allow(person) {
        return Err(crate::claude_code_lane::not_allowed());
    }
    let report = Report {
        device_key: device_key(&body.device_key)?,
        label: reported_label(body.label.as_deref()),
        platform: short_word(body.platform.as_deref(), 16).unwrap_or_else(|| "unknown".into()),
        desktop_version: short_word(body.desktop_version.as_deref(), 32),
        starts_spaces: body.starts_spaces,
        logins: reported_logins(&body.logins),
        runtime_id: body
            .runtime_id
            .as_deref()
            .and_then(|id| Uuid::from_str(id.trim()).ok()),
        decisions: reported_decisions(&body.decisions),
    };
    let known: HashSet<Uuid> = body
        .known
        .iter()
        .filter_map(|id| Uuid::from_str(id.trim()).ok())
        .collect();
    let known_running = body
        .known_running
        .as_deref()
        .and_then(|id| Uuid::from_str(id.trim()).ok());
    let wait = Duration::from_millis(body.wait_ms.unwrap_or(0)).min(POLL_WAIT_MAX);
    // Registered before the first read, so a turn queued between the read
    // and the wait still wakes it.
    let waker = state.events.computer_waker(person);
    let notified = waker.notified();
    tokio::pin!(notified);
    notified.as_mut().enable();

    let mut computer = record_presence(&state, person, &report).await?;
    let (mut wanted, mut running) = answer(&state, person, &computer).await?;
    let mut waited = false;
    if !wait.is_zero() && !differs(&wanted, &running, &known, known_running) {
        waited = true;
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let now = tokio::time::Instant::now();
            if now >= deadline {
                break;
            }
            let recheck = deadline.min(now + POLL_RECHECK);
            if tokio::time::timeout_at(recheck, notified.as_mut())
                .await
                .is_ok()
            {
                notified.set(waker.notified());
                notified.as_mut().enable();
            }
            let connection =
                state.pool.get().await.map_err(|error| {
                    internal_error(format!("failed to get connection: {error}"))
                })?;
            let Some(current) = load_computer(&*connection, person, computer.id).await? else {
                // Forgotten while it waited: its next poll adds it again.
                break;
            };
            drop(connection);
            computer = current;
            (wanted, running) = answer(&state, person, &computer).await?;
            if differs(&wanted, &running, &known, known_running) {
                break;
            }
        }
    }
    Ok(Json(PollAnswer {
        computer,
        wanted,
        running,
        waited,
    }))
}

async fn answer(
    state: &AppState,
    person: Uuid,
    computer: &Computer,
) -> Result<(Vec<Wanted>, Option<Running>), Refusal> {
    let connection = state
        .pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let wanted = wanted_for(&*connection, person, computer).await?;
    let running = running_on(&*connection, person, computer).await?;
    Ok((wanted, running))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn online_reads_the_ttl_and_the_offline_mark() {
        let online = computer_is_online!("c");
        assert!(online.contains(&format!("interval '{ONLINE_TTL_SECONDS} seconds'")));
        assert!(online.contains("c.offline_at < c.last_seen_at"));
    }

    #[test]
    fn a_device_key_is_desktops_computer_id() {
        let id = Uuid::new_v4();
        assert_eq!(
            device_key(&format!(" desktop-{id} ")).expect("key"),
            format!("desktop-{id}")
        );
        assert_eq!(
            device_key(&format!("DESKTOP-{}", id.to_string().to_uppercase())).expect("key"),
            format!("desktop-{id}")
        );
        for raw in [
            String::new(),
            id.to_string(),
            "desktop-".to_string(),
            format!("desktop-{id}-x"),
            format!("laptop-{id}"),
            format!("desktop-{}", id.simple()),
        ] {
            assert_eq!(device_key(&raw).expect_err(&raw).0, StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn a_reported_label_is_made_one_short_line() {
        assert_eq!(reported_label(Some("MacBook Pro")), "MacBook Pro");
        assert_eq!(reported_label(Some("  Mac\nmini\u{202e} ")), "Mac mini");
        assert_eq!(reported_label(Some("\u{200B}")), DEFAULT_LABEL);
        assert_eq!(reported_label(None), DEFAULT_LABEL);
        assert_eq!(
            reported_label(Some(&"é".repeat(80))).chars().count(),
            LABEL_MAX_CHARS
        );
    }

    #[test]
    fn a_label_a_person_gives_is_checked() {
        assert_eq!(
            normalize_label("  Studio Mac ").expect("label"),
            "Studio Mac"
        );
        for raw in ["", "   ", "Mac\nmini", "Mac\u{202e}", &"a".repeat(61)] {
            assert_eq!(
                normalize_label(raw).expect_err(raw).1 .0.code.as_deref(),
                Some(LABEL_INVALID)
            );
        }
    }

    #[test]
    fn reported_logins_are_ids_and_nothing_else() {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        assert_eq!(
            reported_logins(&[
                json!(first.to_string()),
                json!({ "id": second.to_string(), "folder": "/workspace/me/.claude" }),
                json!(first.to_string()),
                json!("not-a-uuid"),
                json!({ "folder": "/workspace/me/.claude" }),
                json!(42),
            ]),
            vec![first, second]
        );
    }

    #[test]
    fn reported_decisions_keep_known_reasons_once_per_space() {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let decisions = reported_decisions(&[
            json!({ "projectId": first.to_string(), "reason": "in_use", "extra": 1 }),
            json!({ "projectId": first.to_string(), "reason": "busy" }),
            json!({ "projectId": second.to_string(), "reason": "made_up" }),
            json!({ "projectId": "nope", "reason": "busy" }),
            json!({ "projectId": second.to_string(), "reason": "no_working_copy" }),
        ]);
        assert_eq!(
            decisions,
            json!([
                { "projectId": first, "reason": "in_use" },
                { "projectId": second, "reason": "no_working_copy" },
            ])
        );
        let many: Vec<JsonValue> = (0..30)
            .map(|_| json!({ "projectId": Uuid::new_v4().to_string(), "reason": "busy" }))
            .collect();
        assert_eq!(
            reported_decisions(&many).as_array().map(Vec::len),
            Some(MAX_DECISIONS)
        );
    }

    #[test]
    fn with_decision_puts_the_space_first_once() {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let decisions = json!([
            { "projectId": first, "reason": "in_use" },
            { "projectId": second, "reason": "busy" },
        ]);
        assert_eq!(
            with_decision(&decisions, second, Decision::Failed),
            json!([
                { "projectId": second, "reason": "failed" },
                { "projectId": first, "reason": "in_use" },
            ])
        );
    }

    #[test]
    fn every_decision_reads_back() {
        for decision in Decision::ALL {
            assert_eq!(Decision::parse(decision.as_str()), Some(decision));
        }
        assert_eq!(Decision::parse("starting "), Some(Decision::Starting));
        assert_eq!(Decision::parse("asleep"), None);
        assert!(Decision::NoGitRemote.is_failure());
        assert!(!Decision::Starting.is_failure());
        assert!(!Decision::InUse.is_failure());
    }

    #[test]
    fn short_words_drop_anything_odd() {
        assert_eq!(short_word(Some("darwin"), 16).as_deref(), Some("darwin"));
        assert_eq!(
            short_word(Some("0.2.25-beta.1"), 32).as_deref(),
            Some("0.2.25-beta.1")
        );
        assert_eq!(short_word(Some("dar win"), 16), None);
        assert_eq!(short_word(Some("/workspace/x"), 32), None);
        assert_eq!(short_word(Some(&"a".repeat(17)), 16), None);
        assert_eq!(short_word(None, 16), None);
    }

    #[test]
    fn an_answer_differs_by_its_spaces_and_its_running_turn() {
        let space = Uuid::new_v4();
        let wanted = vec![Wanted {
            project_id: space,
            login_id: Uuid::new_v4(),
            waiting_since: Utc::now().to_rfc3339(),
        }];
        let known: HashSet<Uuid> = [space].into_iter().collect();
        assert!(!differs(&wanted, &None, &known, None));
        assert!(differs(&wanted, &None, &HashSet::new(), None));
        assert!(differs(&[], &None, &known, None));
        let running = Some(Running {
            project_id: space,
            login_id: None,
        });
        assert!(differs(&wanted, &running, &known, None));
        assert!(!differs(&wanted, &running, &known, Some(space)));
    }

    #[test]
    fn the_refusals_carry_their_codes() {
        assert_eq!(limit_reached().1 .0.code.as_deref(), Some(LIMIT));
        assert_eq!(
            limit_reached().1 .0.details,
            Some(json!({ "max": MAX_COMPUTERS }))
        );
        assert_eq!(claim_taken().0, StatusCode::CONFLICT);
        assert_eq!(claim_taken().1 .0.code.as_deref(), Some(CLAIM_TAKEN));
        assert_eq!(paused().1 .0.code.as_deref(), Some(PAUSED));
        assert_eq!(computer_not_found().0, StatusCode::NOT_FOUND);
    }
}
