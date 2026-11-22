//! Backup AIs, and whether a sign-in has room (docs/Local-Engine-Turns.md
//! 11.20).
//!
//! After its first AI, an agent may list up to [`MAX_BACKUP_AIS`] backups, in
//! order, each one of its owner's own sign-ins ([`SignIn`]): a connection, a
//! `user_credentials` row such as a ChatGPT sign-in, or a Claude Code login
//! (`claude_code_logins`, 11.19). They are `user_agents.backup_ais`, a JSON
//! array of `{"credentialId": "<uuid>"}` and `{"claudeCodeLoginId":
//! "<uuid>"}`, which only the agent's owner sets, through their own session
//! (`ai_agents`, [`checked_backup_ais`]). Its first AI must be one of those
//! too ([`FirstAi`]): Instafy AI is no sign-in of the person's, and an agent
//! on the person's default has no AI of its own to back up, so neither has
//! backups.
//!
//! **Room.** A sign-in has room unless the controller knows it is at its
//! plan's limit: a connection while its `limit_resets_at` is ahead, or while
//! the usage its proxy last read (`subscription_usage`) shows a window at 100%
//! that resets later ([`credential_limit`]); a login while its
//! `limit_resets_at` is ahead ([`login_limit`], and [`login_has_room`] for
//! SQL, which the lease reads). Completion records a limit from the turn that
//! reached it, on the turn's own sign-in, and clears it when a turn on the
//! sign-in completes ([`settle_completion`]). This module is the one place the
//! rule is written: dispatch, the lease, completion's next-AI stamp and the
//! goal's check all read it here.
//!
//! **The walk** ([`AgentAis`]): the agent's first AI, then its backups, each
//! passed over when it is not one of its owner's live sign-ins (a connection
//! revoked or another person's, a login deleted), so the owner rule holds at
//! dispatch as it does at write. Dispatch takes the first with room, else the
//! one whose limit resets first, else, with none usable, what it took before
//! backups ([`target_ai`]): the person's default connection, else Instafy AI,
//! or for a Claude Code agent with no login a lane job that waits. A login it
//! takes makes the turn a lane job on the stretch of consecutive logins that
//! holds it, behind the lane's own gates (`claude_code_lane::check_target`)
//! and its lease (`claude_code_lane::lane_job_login`), so a waiting turn moves
//! only among the logins beside the one it was sent to, and never changes
//! engine.
//!
//! **Stamps.** Ids only, and only the controller writes them: `aiSignIn` on a
//! run, its reply and its failure ([`stamp`]), with `"backup": true` when the
//! sign-in is one of the agent's backups, and `aiSignInNext` on a failure
//! after a limit, the agent's next AI with room ([`stamp_next`]). A job on a
//! connection carries the run's `aiSignIn` in its payload too, which its
//! secrets read: a backup of another provider than the agent's first AI runs
//! that backup's own default model, not the agent's model and effort
//! ([`job_backup_credential`], `secrets::agent_secrets`). A client's copy
//! never survives intake ([`CONTROLLER_KEYS`],
//! `claude_code_lane::strip_client_marks`).

use std::collections::HashSet;

use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use tokio_postgres::{GenericClient, Row};
use uuid::Uuid;

use crate::typed_sql::typed;
use crate::{bad_request, internal_error, ApiError};

type Refusal = (StatusCode, Json<ApiError>);

/// The most backups an agent lists (`user_agents_backup_ais_check`).
pub(crate) const MAX_BACKUP_AIS: usize = 8;
/// An entry's key for one of the person's connections.
const CREDENTIAL_KEY: &str = "credentialId";
/// An entry's key for one of the person's Claude Code logins.
const LOGIN_KEY: &str = "claudeCodeLoginId";
/// The stamp of the sign-in a turn runs or ran on: a run's, its reply's and
/// its failure message's.
pub(crate) const STAMP_KEY: &str = "aiSignIn";
/// The stamp of the agent's next AI with room, on a failure message after the
/// turn's sign-in reached its plan's limit.
pub(crate) const NEXT_KEY: &str = "aiSignInNext";
/// [`STAMP_KEY`]'s mark of a sign-in that is one of the agent's backups.
const BACKUP_KEY: &str = "backup";
/// The keys only the controller writes into a message's or a send's metadata,
/// in both spellings: a client's copy is never kept.
pub(crate) const CONTROLLER_KEYS: [&str; 4] =
    [STAMP_KEY, "ai_sign_in", NEXT_KEY, "ai_sign_in_next"];
/// The artifact a Codex turn that fails with its provider's usage-limit error
/// carries: `{"kind": "ai/usage-limit", "resetsAt": <seconds> | null}`.
pub(crate) const USAGE_LIMIT_ARTIFACT_KIND: &str = "ai/usage-limit";
/// The reset time an artifact reports, in seconds since the epoch: the usage
/// limit's, or a `plan_limit` failure's in `claude-code/failure`.
const RESETS_AT_KEY: &str = "resetsAt";
/// The lane's failure code of a turn that hit its Claude plan's limit
/// (`claude_code_lane::RUNTIME_FAILURE_CODES`).
pub(crate) const PLAN_LIMIT: &str = "plan_limit";
/// The latest reset a report is read as, the end of the year 9999, so that
/// no number a runtime sends makes a time Postgres cannot hold; completion
/// caps it at eight days anyway.
const LATEST_RESET_SECONDS: f64 = 253_402_300_799.0;

/// A backup that names none of the caller's live connections and logins.
pub(crate) const BACKUP_AI_UNKNOWN: &str = "backup_ai_unknown";
/// A backup listed twice, or the agent's own first AI.
pub(crate) const BACKUP_AI_REPEATED: &str = "backup_ai_repeated";
/// More than [`MAX_BACKUP_AIS`] backups.
pub(crate) const BACKUP_AI_LIMIT: &str = "backup_ai_limit";
/// Backups for an agent whose first AI is Instafy AI or the person's default.
pub(crate) const BACKUP_AI_NEEDS_OWN_AI: &str = "backup_ai_needs_own_ai";

/// One of a person's own sign-ins: a connection or a Claude Code login.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum SignIn {
    Credential(Uuid),
    Login(Uuid),
}

impl SignIn {
    /// Its entry in a backup list, and in a stamp:
    /// `{"credentialId": "<uuid>"}` or `{"claudeCodeLoginId": "<uuid>"}`.
    pub(crate) fn entry(self) -> JsonValue {
        match self {
            Self::Credential(id) => json!({ CREDENTIAL_KEY: id.to_string() }),
            Self::Login(id) => json!({ LOGIN_KEY: id.to_string() }),
        }
    }

    /// The sign-in a stored entry names: exactly one of the two keys, whose
    /// value is a UUID as Postgres writes one ([`canonical_uuid`]). Anything
    /// else names none, and the walk passes over it.
    pub(crate) fn of_entry(entry: &JsonValue) -> Option<Self> {
        let map = entry.as_object().filter(|map| map.len() == 1)?;
        let (key, value) = map.iter().next()?;
        let id = canonical_uuid(value.as_str()?)?;
        match key.as_str() {
            CREDENTIAL_KEY => Some(Self::Credential(id)),
            LOGIN_KEY => Some(Self::Login(id)),
            _ => None,
        }
    }

    pub(crate) fn login(self) -> Option<Uuid> {
        match self {
            Self::Login(id) => Some(id),
            Self::Credential(_) => None,
        }
    }
}

/// `text` when it is a UUID written hyphenated, in either case, as Postgres
/// writes one: the one form an entry is read in, here and in SQL
/// ([`lists_a_login`]), so both read the same entries.
fn canonical_uuid(text: &str) -> Option<Uuid> {
    let id = Uuid::parse_str(text).ok()?;
    id.hyphenated()
        .to_string()
        .eq_ignore_ascii_case(text)
        .then_some(id)
}

/// Until when a connection is at its plan's limit, or None while it has room
/// (11.20): the latest of its recorded `limit_resets_at` and the reset of
/// each usage window its proxy last read at 100% or more (`subscription_usage`
/// `windows[*].usedPercent`, and `resetAt` in seconds since the epoch), of
/// those still ahead of `now`. A time that has passed holds nothing.
pub(crate) fn credential_limit(
    limit_resets_at: Option<DateTime<Utc>>,
    subscription_usage: Option<&JsonValue>,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    let full_windows = subscription_usage
        .and_then(|usage| usage.get("windows"))
        .and_then(JsonValue::as_array)
        .into_iter()
        .flatten()
        .filter_map(|window| {
            let used = window.get("usedPercent").and_then(JsonValue::as_f64)?;
            let reset = window.get("resetAt").and_then(epoch_seconds)?;
            (used >= 100.0).then_some(reset)
        });
    limit_resets_at
        .into_iter()
        .chain(full_windows)
        .filter(|at| *at > now)
        .max()
}

/// Until when a Claude Code login is at its plan's limit, or None while it
/// has room (11.20): its recorded `limit_resets_at` while that is ahead of
/// `now`. [`login_has_room`] is the same rule in SQL.
pub(crate) fn login_limit(
    limit_resets_at: Option<DateTime<Utc>>,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    limit_resets_at.filter(|at| *at > now)
}

/// [`login_limit`]'s rule in SQL, for the `claude_code_logins` row `$login`:
/// it has room unless its `limit_resets_at` is ahead. The lease reads it
/// (`claude_code_lane::lane_job_login`).
macro_rules! login_has_room {
    ($login:literal) => {
        concat!(
            "(",
            $login,
            ".limit_resets_at is null or ",
            $login,
            ".limit_resets_at <= statement_timestamp())"
        )
    };
}
pub(crate) use login_has_room;

/// Whether the `user_agents` row `$agent`, whose first AI is one of its
/// owner's connections, lists one of its owner's Claude Code logins among its
/// backups: a turn of it then runs on Claude Code once that connection, and
/// every backup before the login, has no room (11.20). An entry is read as
/// [`SignIn::of_entry`] reads it, or more loosely, never less.
macro_rules! lists_a_login {
    ($agent:literal) => {
        concat!(
            "(",
            $agent,
            ".credential_id is not null
              and exists (
                  select 1
                    from jsonb_array_elements(
                             case when jsonb_typeof(",
            $agent,
            ".backup_ais) = 'array'
                                  then ",
            $agent,
            ".backup_ais else '[]'::jsonb end
                         ) as backup(entry)
                    join claude_code_logins backup_login
                      on backup_login.user_id = ",
            $agent,
            ".user_id
                     and backup_login.id::text = lower(backup.entry ->> 'claudeCodeLoginId')
              ))"
        )
    };
}
pub(crate) use lists_a_login;

/// The columns of the `user_agents` row `$agent` that [`AgentAiRow::of`]
/// reads.
macro_rules! agent_ai_columns {
    ($agent:literal) => {
        concat!(
            $agent,
            ".credential_id as ai_credential_id, ",
            $agent,
            ".provider = 'claude-code' and ",
            $agent,
            ".credential_id is null as ai_claude_code, ",
            $agent,
            ".claude_code_login_id as ai_claude_code_login_id, ",
            $agent,
            ".backup_ais as ai_backup_ais"
        )
    };
}
pub(crate) use agent_ai_columns;

/// An agent's AIs as its row stores them ([`agent_ai_columns`]).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct AgentAiRow {
    /// Its connection, as stored, live or not.
    pub(crate) credential_id: Option<Uuid>,
    /// Its AI is Claude Code: the provider `claude-code` with no connection.
    pub(crate) claude_code: bool,
    /// The Claude Code login it names, as stored.
    pub(crate) claude_code_login_id: Option<Uuid>,
    /// `backup_ais` as stored.
    pub(crate) backup_ais: JsonValue,
}

impl AgentAiRow {
    /// The columns [`agent_ai_columns`] selects.
    pub(crate) fn of(row: &Row) -> Self {
        Self {
            credential_id: row.get("ai_credential_id"),
            claude_code: row
                .get::<_, Option<bool>>("ai_claude_code")
                .unwrap_or(false),
            claude_code_login_id: row.get("ai_claude_code_login_id"),
            backup_ais: row
                .get::<_, Option<JsonValue>>("ai_backup_ais")
                .unwrap_or_else(|| json!([])),
        }
    }

    /// The sign-ins its stored backups name, in order, at most
    /// [`MAX_BACKUP_AIS`]; an entry that names none is passed over.
    fn backups(&self) -> impl Iterator<Item = SignIn> + '_ {
        self.backup_ais
            .as_array()
            .into_iter()
            .flatten()
            .take(MAX_BACKUP_AIS)
            .filter_map(SignIn::of_entry)
    }
}

/// One of a person's live connections, with when its plan's limit resets.
#[derive(Clone, Copy, Debug)]
struct CredentialRoom {
    id: Uuid,
    limited_until: Option<DateTime<Utc>>,
}

/// One of a person's Claude Code logins, with when its plan's limit resets.
#[derive(Clone, Copy, Debug)]
struct LoginRoom {
    id: Uuid,
    limited_until: Option<DateTime<Utc>>,
}

/// A person's own sign-ins as the controller knows them, with the room of
/// each: their live connections (never one revoked, nor the managed lane's
/// reserved id) and their Claude Code logins, oldest first. Dispatch, the
/// agent routes and completion read them in one statement, with the
/// database's clock, the one the lease reads room by.
#[derive(Clone, Debug, Default)]
pub(crate) struct OwnerSignIns {
    credentials: Vec<CredentialRoom>,
    logins: Vec<LoginRoom>,
}

impl OwnerSignIns {
    pub(crate) async fn load(
        client: &(impl GenericClient + Sync),
        owner: &Uuid,
    ) -> Result<Self, Refusal> {
        let rows = client
            .query_typed(
                "select 'login' as kind, id, created_at, limit_resets_at,
                        null::jsonb as subscription_usage, statement_timestamp() as now
                   from claude_code_logins
                  where user_id = $1
                 union all
                 select 'credential', id, created_at, limit_resets_at,
                        subscription_usage, statement_timestamp()
                   from user_credentials
                  where user_id = $1 and revoked_at is null
                 order by kind, created_at, id",
                typed![owner],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to read the person's sign-ins: {error}"))
            })?;
        let mut sign_ins = Self::default();
        for row in rows {
            let kind: String = row.get("kind");
            let id: Uuid = row.get("id");
            let now: DateTime<Utc> = row.get("now");
            let limit_resets_at: Option<DateTime<Utc>> = row.get("limit_resets_at");
            if kind == "login" {
                sign_ins.logins.push(LoginRoom {
                    id,
                    limited_until: login_limit(limit_resets_at, now),
                });
            } else if let Some(id) = crate::credentials::usable_user_credential_id(Some(id)) {
                let usage: Option<JsonValue> = row.get("subscription_usage");
                sign_ins.credentials.push(CredentialRoom {
                    id,
                    limited_until: credential_limit(limit_resets_at, usage.as_ref(), now),
                });
            }
        }
        Ok(sign_ins)
    }

    fn credential(&self, id: Uuid) -> Option<&CredentialRoom> {
        self.credentials
            .iter()
            .find(|credential| credential.id == id)
    }

    fn login(&self, id: Uuid) -> Option<&LoginRoom> {
        self.logins.iter().find(|login| login.id == id)
    }

    /// Their first Claude Code login, the oldest: an agent that names none
    /// uses it (11.19).
    fn first_login(&self) -> Option<Uuid> {
        self.logins.first().map(|login| login.id)
    }

    /// `sign_in` is one of theirs and live, with when its limit resets.
    fn room_of(&self, sign_in: SignIn) -> Option<Option<DateTime<Utc>>> {
        match sign_in {
            SignIn::Credential(id) => self
                .credential(id)
                .map(|credential| credential.limited_until),
            SignIn::Login(id) => self.login(id).map(|login| login.limited_until),
        }
    }
}

/// An agent's first AI, as it would be after a create or an update, or as
/// its row holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum FirstAi {
    /// One of the person's connections, live or not.
    Connection(Uuid),
    /// Claude Code, on the login it names while that is its owner's, else on
    /// their first; none when they have no login.
    ClaudeCode(Option<Uuid>),
    /// Instafy AI or the person's default: no AI of its own, so no backups.
    NotOwn,
}

impl FirstAi {
    pub(crate) fn of(
        credential_id: Option<Uuid>,
        claude_code: bool,
        claude_code_login_id: Option<Uuid>,
        owner: &OwnerSignIns,
    ) -> Self {
        match (credential_id, claude_code) {
            (Some(id), _) => Self::Connection(id),
            (None, true) => Self::ClaudeCode(
                claude_code_login_id
                    .filter(|login| owner.login(*login).is_some())
                    .or_else(|| owner.first_login()),
            ),
            (None, false) => Self::NotOwn,
        }
    }

    pub(crate) fn of_row(row: &AgentAiRow, owner: &OwnerSignIns) -> Self {
        Self::of(
            row.credential_id,
            row.claude_code,
            row.claude_code_login_id,
            owner,
        )
    }

    /// The sign-in it is.
    pub(crate) fn sign_in(self) -> Option<SignIn> {
        match self {
            Self::Connection(id) => Some(SignIn::Credential(id)),
            Self::ClaudeCode(login) => login.map(SignIn::Login),
            Self::NotOwn => None,
        }
    }

    /// It is one of the person's sign-ins, so the agent may have backups.
    pub(crate) fn is_own(self) -> bool {
        !matches!(self, Self::NotOwn)
    }
}

/// One usable AI of an agent's, in the order [`AgentAis`] walks them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Ai {
    pub(crate) sign_in: SignIn,
    /// It is the agent's first AI, not one of its backups.
    pub(crate) first: bool,
    /// Until when it is at its plan's limit; None while it has room.
    pub(crate) limited_until: Option<DateTime<Utc>>,
}

/// An agent's usable AIs, in the order dispatch walks them (11.20): its first
/// AI while it is one of its owner's live sign-ins, then each backup that is,
/// in its list's order, and each only once. An entry that is not one of the
/// owner's sign-ins, or no longer is, is passed over: the owner rule holds at
/// dispatch as at write, whoever wrote the row.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentAis {
    pub(crate) first: FirstAi,
    pub(crate) ais: Vec<Ai>,
}

impl AgentAis {
    pub(crate) fn of(row: &AgentAiRow, owner: &OwnerSignIns) -> Self {
        let first = FirstAi::of_row(row, owner);
        let mut ais: Vec<Ai> = Vec::new();
        if !first.is_own() {
            return Self { first, ais };
        }
        if let Some(sign_in) = first.sign_in() {
            if let Some(limited_until) = owner.room_of(sign_in) {
                ais.push(Ai {
                    sign_in,
                    first: true,
                    limited_until,
                });
            }
        }
        for sign_in in row.backups() {
            if first.sign_in() == Some(sign_in) || ais.iter().any(|ai| ai.sign_in == sign_in) {
                continue;
            }
            if let Some(limited_until) = owner.room_of(sign_in) {
                ais.push(Ai {
                    sign_in,
                    first: false,
                    limited_until,
                });
            }
        }
        Self { first, ais }
    }

    /// The AI dispatch takes (11.20): the first with room, else the one whose
    /// limit resets first, the earliest of them on a tie; None when none is
    /// usable.
    pub(crate) fn choose(&self) -> Option<usize> {
        self.ais
            .iter()
            .position(|ai| ai.limited_until.is_none())
            .or_else(|| {
                self.ais
                    .iter()
                    .enumerate()
                    .min_by_key(|(_, ai)| ai.limited_until)
                    .map(|(index, _)| index)
            })
    }

    /// The stretch of consecutive Claude Code logins of the walk that holds
    /// the one at `index`, in order: the logins a lane job on it may run on
    /// (`agent_jobs.claude_code_login_ids`), which its lease picks among by
    /// room. Empty when the AI at `index` is not a login.
    pub(crate) fn stretch(&self, index: usize) -> Vec<Uuid> {
        if self
            .ais
            .get(index)
            .and_then(|ai| ai.sign_in.login())
            .is_none()
        {
            return Vec::new();
        }
        let is_login = |ai: &Ai| ai.sign_in.login().is_some();
        let start = self.ais[..index]
            .iter()
            .rposition(|ai| !is_login(ai))
            .map_or(0, |before| before + 1);
        let end = self.ais[index..]
            .iter()
            .position(|ai| !is_login(ai))
            .map_or(self.ais.len(), |after| index + after);
        self.ais[start..end]
            .iter()
            .filter_map(|ai| ai.sign_in.login())
            .collect()
    }

    /// Its live backups, in order: what the agent list returns.
    pub(crate) fn backups(&self) -> Vec<SignIn> {
        self.ais
            .iter()
            .filter(|ai| !ai.first)
            .map(|ai| ai.sign_in)
            .collect()
    }

    /// The AI dispatch would take now when that one has room.
    pub(crate) fn next_with_room(&self) -> Option<SignIn> {
        self.ais
            .iter()
            .find(|ai| ai.limited_until.is_none())
            .map(|ai| ai.sign_in)
    }

    /// `sign_in` is one of its backups, not its first AI.
    pub(crate) fn is_backup(&self, sign_in: SignIn) -> bool {
        self.ais.iter().any(|ai| !ai.first && ai.sign_in == sign_in)
    }
}

/// What a dispatch target's turn runs on (11.20).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum TargetAi {
    /// A job on one of the person's connections.
    Credential(Uuid),
    /// A lane job: `login` is the login chosen, which its stamps name and its
    /// session is looked for on, and `login_ids` the stretch of consecutive
    /// logins that holds it, in order. A Claude Code agent whose person has
    /// no login has neither, and its turn waits, as before backups.
    ClaudeCode {
        login_ids: Vec<Uuid>,
        login: Option<Uuid>,
    },
    /// None of the agent's own: the person's default connection, else
    /// Instafy AI, as before backups.
    Fallback,
}

/// The sign-in dispatch chose for a target, as its run's stamp names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Chosen {
    pub(crate) sign_in: SignIn,
    /// It is one of the agent's backups.
    pub(crate) backup: bool,
    /// It has room now.
    pub(crate) room: bool,
}

impl Chosen {
    fn of(ai: &Ai) -> Self {
        Self {
            sign_in: ai.sign_in,
            backup: !ai.first,
            room: ai.limited_until.is_none(),
        }
    }

    /// The person's default connection, when a target falls back to it.
    pub(crate) fn default_connection(credential_id: Uuid) -> Self {
        Self {
            sign_in: SignIn::Credential(credential_id),
            backup: false,
            room: true,
        }
    }
}

/// What dispatch runs a target's turn on (11.20), for the agent `row` of
/// `owner`'s: for a turn that runs an AI (`ai_turn`), the AI [`AgentAis`]
/// chooses; for any other turn, such as a terminal command, or when none of
/// its AIs is usable, its first AI as before backups, else the fallback.
pub(crate) fn target_ai(
    row: &AgentAiRow,
    owner: &OwnerSignIns,
    ai_turn: bool,
) -> (TargetAi, Option<Chosen>) {
    let ais = AgentAis::of(row, owner);
    if ai_turn {
        if let Some(index) = ais.choose() {
            let ai = ais.ais[index];
            let target = match ai.sign_in {
                SignIn::Credential(id) => TargetAi::Credential(id),
                SignIn::Login(login) => TargetAi::ClaudeCode {
                    login_ids: ais.stretch(index),
                    login: Some(login),
                },
            };
            return (target, Some(Chosen::of(&ai)));
        }
    }
    let first = ais.ais.first().filter(|ai| ai.first);
    match ais.first {
        FirstAi::ClaudeCode(login) => (
            TargetAi::ClaudeCode {
                login_ids: login.into_iter().collect(),
                login,
            },
            first.map(Chosen::of),
        ),
        FirstAi::Connection(id) if first.is_some() => {
            (TargetAi::Credential(id), first.map(Chosen::of))
        }
        _ => (TargetAi::Fallback, None),
    }
}

/// The agent `agent` of `person`'s, and its usable AIs; None when it is not
/// theirs or is deleted.
pub(crate) async fn load_agent_ais(
    client: &(impl GenericClient + Sync),
    agent: &Uuid,
    person: &Uuid,
) -> Result<Option<AgentAis>, Refusal> {
    let row = client
        .query_typed_opt(
            concat!(
                "select ",
                agent_ai_columns!("ua"),
                " from user_agents ua
                  where ua.id = $1 and ua.user_id = $2 and ua.deleted_at is null"
            ),
            typed![agent, person],
        )
        .await
        .map_err(|error| internal_error(format!("failed to read the agent's AIs: {error}")))?;
    let Some(row) = row else {
        return Ok(None);
    };
    let owner = OwnerSignIns::load(client, person).await?;
    Ok(Some(AgentAis::of(&AgentAiRow::of(&row), &owner)))
}

/// Stamps `map` with `aiSignIn`: the sign-in a turn runs or ran on, marked
/// `"backup": true` when it is one of its agent's backups.
pub(crate) fn stamp(map: &mut JsonMap<String, JsonValue>, sign_in: SignIn, backup: bool) {
    let mut stamp = sign_in.entry();
    if backup {
        stamp[BACKUP_KEY] = JsonValue::Bool(true);
    }
    map.insert(STAMP_KEY.to_string(), stamp);
}

/// The job's own credential when dispatch sent the job there as one of its
/// agent's backups, by the `aiSignIn` its payload's metadata holds, which only
/// dispatch writes ([`stamp`]; a client's copy never survives intake). None
/// for a job on its agent's first AI or the default, and when the stamp names
/// another credential than the job's.
pub(crate) fn job_backup_credential(
    payload: &JsonValue,
    credential_id: Option<Uuid>,
) -> Option<Uuid> {
    let stamp = payload.pointer("/metadata/aiSignIn")?;
    if stamp.get(BACKUP_KEY) != Some(&JsonValue::Bool(true)) {
        return None;
    }
    let id = stamp
        .get(CREDENTIAL_KEY)
        .and_then(JsonValue::as_str)
        .and_then(canonical_uuid)?;
    (Some(id) == credential_id).then_some(id)
}

/// Stamps a failure message with `aiSignInNext`: the agent's next AI with
/// room, which its next turns use.
pub(crate) fn stamp_next(map: &mut JsonMap<String, JsonValue>, sign_in: SignIn) {
    map.insert(NEXT_KEY.to_string(), sign_in.entry());
}

fn refusal(status: StatusCode, code: &str, message: &str) -> Refusal {
    (
        status,
        Json(ApiError::with_details(
            message,
            code,
            json!({ "reason": code }),
        )),
    )
}

fn backup_shape_refused() -> Refusal {
    bad_request(
        "backupAis is a list of {\"credentialId\": \"<id>\"} and {\"claudeCodeLoginId\": \"<id>\"}.",
    )
}

fn backup_unknown() -> Refusal {
    refusal(
        StatusCode::UNPROCESSABLE_ENTITY,
        BACKUP_AI_UNKNOWN,
        "A backup isn't one of your connections or Claude Code logins.",
    )
}

/// The sign-in one entry of a request's `backupAis` names: exactly one of the
/// two keys, a UUID. Any other shape is a 400; a value that is no UUID is
/// unknown, as an unknown one is.
fn requested_backup(entry: &JsonValue) -> Result<SignIn, Refusal> {
    let map = entry
        .as_object()
        .filter(|map| map.len() == 1)
        .ok_or_else(backup_shape_refused)?;
    let Some((key, value)) = map.iter().next() else {
        return Err(backup_shape_refused());
    };
    let text = value.as_str().ok_or_else(backup_shape_refused)?;
    let make: fn(Uuid) -> SignIn = match key.as_str() {
        CREDENTIAL_KEY => SignIn::Credential,
        LOGIN_KEY => SignIn::Login,
        _ => return Err(backup_shape_refused()),
    };
    canonical_uuid(text.trim())
        .map(make)
        .ok_or_else(backup_unknown)
}

/// The backups an agent's create or update sets from its body's `backupAis`
/// (11.20), for an agent whose first AI after the request is `first`, of
/// `owner`'s: a list of at most [`MAX_BACKUP_AIS`] entries (400
/// `backup_ai_limit`), none while the first AI is Instafy AI or the default
/// (400 `backup_ai_needs_own_ai`), a Claude Code login only while the switch
/// covers the owner (`lane_allowed`, 403 `claude_code_turn_not_allowed`), each
/// once and none the first AI (422 `backup_ai_repeated`), and each one of the
/// owner's live connections or logins (422 `backup_ai_unknown`). `[]` clears
/// the list.
pub(crate) fn checked_backup_ais(
    value: &JsonValue,
    first: FirstAi,
    owner: &OwnerSignIns,
    lane_allowed: bool,
) -> Result<Vec<SignIn>, Refusal> {
    let entries = value.as_array().ok_or_else(backup_shape_refused)?;
    if entries.len() > MAX_BACKUP_AIS {
        return Err(refusal(
            StatusCode::BAD_REQUEST,
            BACKUP_AI_LIMIT,
            "An agent has at most 8 backups.",
        ));
    }
    let sign_ins = entries
        .iter()
        .map(requested_backup)
        .collect::<Result<Vec<_>, _>>()?;
    if sign_ins.is_empty() {
        return Ok(sign_ins);
    }
    if !first.is_own() {
        return Err(refusal(
            StatusCode::BAD_REQUEST,
            BACKUP_AI_NEEDS_OWN_AI,
            "Only an agent whose AI is one of your connections or Claude Code has backups.",
        ));
    }
    if !lane_allowed && sign_ins.iter().any(|sign_in| sign_in.login().is_some()) {
        return Err(crate::claude_code_lane::not_allowed());
    }
    let mut seen = HashSet::new();
    for sign_in in &sign_ins {
        if first.sign_in() == Some(*sign_in) || !seen.insert(*sign_in) {
            return Err(refusal(
                StatusCode::UNPROCESSABLE_ENTITY,
                BACKUP_AI_REPEATED,
                "Each backup is listed once, and none is the agent's own AI.",
            ));
        }
    }
    if sign_ins
        .iter()
        .any(|sign_in| owner.room_of(*sign_in).is_none())
    {
        return Err(backup_unknown());
    }
    Ok(sign_ins)
}

/// A backup list as stored.
pub(crate) fn entries(sign_ins: &[SignIn]) -> JsonValue {
    JsonValue::Array(sign_ins.iter().map(|sign_in| sign_in.entry()).collect())
}

/// What a job's completion knows of the sign-in it ran on (11.20).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SignInEnd {
    /// The sign-in it ran on: its credential, or the login its lease took.
    pub(crate) ran_on: SignIn,
    /// That sign-in is one of its agent's backups.
    pub(crate) backup: bool,
    /// The turn reached the sign-in's plan's limit, which completion has just
    /// recorded.
    pub(crate) limit_recorded: bool,
    /// After a recorded limit, the agent's next AI with room, as dispatch
    /// would choose now, when it is another than the one that reached it.
    pub(crate) next: Option<SignIn>,
}

impl SignInEnd {
    /// A goal whose turn this was goes on, on the agent's next AI with room,
    /// rather than stop (11.20, D50).
    pub(crate) fn goes_on_another_ai(&self) -> bool {
        self.limit_recorded && self.next.is_some()
    }
}

/// The last artifact of `kind` in `artifacts`.
fn last_artifact<'a>(artifacts: &'a JsonValue, kind: &str) -> Option<&'a JsonValue> {
    artifacts
        .as_array()?
        .iter()
        .rev()
        .find(|artifact| artifact.get("kind").and_then(JsonValue::as_str) == Some(kind))
}

/// A reset time a runtime reports, in whole seconds since the epoch, held to
/// what Postgres can store.
fn reset_seconds(value: &JsonValue) -> Option<i64> {
    value
        .as_f64()
        .filter(|seconds| seconds.is_finite())
        .map(|seconds| seconds.clamp(0.0, LATEST_RESET_SECONDS).floor() as i64)
}

/// `seconds` since the epoch as a time.
fn epoch_seconds(seconds: &JsonValue) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp(reset_seconds(seconds)?, 0)
}

/// Whether a failed job on `ran_on` reported reaching its plan's limit, and
/// the reset it gave: a lane job on a login, by its last `claude-code/failure`
/// artifact, when that one's code is `plan_limit`; any other job on a
/// connection, by its last `ai/usage-limit` artifact. The artifact's `resetsAt` is the reset, in
/// seconds since the epoch, or none. Never the turn's text.
pub(crate) fn reported_limit(
    ran_on: SignIn,
    lane: bool,
    artifacts: &JsonValue,
) -> Option<Option<i64>> {
    let artifact = match ran_on {
        SignIn::Login(_) if lane => {
            last_artifact(artifacts, crate::claude_code_lane::FAILURE_ARTIFACT_KIND).filter(
                |artifact| artifact.get("code").and_then(JsonValue::as_str) == Some(PLAN_LIMIT),
            )?
        }
        SignIn::Credential(_) if !lane => last_artifact(artifacts, USAGE_LIMIT_ARTIFACT_KIND)?,
        _ => return None,
    };
    Some(artifact.get(RESETS_AT_KEY).and_then(reset_seconds))
}

/// Records that `ran_on`, `person`'s own, reached its plan's limit, until
/// `resets_at` (seconds since the epoch) but at most eight days ahead, or one
/// hour ahead with no reset. A reset that has passed records nothing. Gives
/// whether it recorded one.
async fn record_limit(
    client: &(impl GenericClient + Sync),
    ran_on: SignIn,
    person: &Uuid,
    resets_at: Option<i64>,
) -> Result<bool, Refusal> {
    let (sql, id) = match ran_on {
        SignIn::Credential(id) => (
            "update user_credentials
                set limit_resets_at = case
                        when $3::bigint is null then now() + interval '1 hour'
                        else least(to_timestamp($3::bigint), now() + interval '8 days')
                    end
              where id = $1 and user_id = $2
                and ($3::bigint is null or to_timestamp($3::bigint) > now())",
            id,
        ),
        SignIn::Login(id) => (
            "update claude_code_logins
                set limit_resets_at = case
                        when $3::bigint is null then now() + interval '1 hour'
                        else least(to_timestamp($3::bigint), now() + interval '8 days')
                    end
              where id = $1 and user_id = $2
                and ($3::bigint is null or to_timestamp($3::bigint) > now())",
            id,
        ),
    };
    client
        .execute_typed(sql, typed![&id, person, &resets_at])
        .await
        .map(|updated| updated == 1)
        .map_err(|error| {
            internal_error(format!("failed to record a sign-in's plan limit: {error}"))
        })
}

/// Clears the limit recorded for `ran_on`, `person`'s own, after a turn on it
/// completed.
async fn clear_limit(
    client: &(impl GenericClient + Sync),
    ran_on: SignIn,
    person: &Uuid,
) -> Result<(), Refusal> {
    let (sql, id) = match ran_on {
        SignIn::Credential(id) => (
            "update user_credentials set limit_resets_at = null
              where id = $1 and user_id = $2 and limit_resets_at is not null",
            id,
        ),
        SignIn::Login(id) => (
            "update claude_code_logins set limit_resets_at = null
              where id = $1 and user_id = $2 and limit_resets_at is not null",
            id,
        ),
    };
    client
        .execute_typed(sql, typed![&id, person])
        .await
        .map(|_| ())
        .map_err(|error| internal_error(format!("failed to clear a sign-in's plan limit: {error}")))
}

/// What a job's completion records of its sign-in (11.20), in the completion's
/// transaction, before it writes the reply or the failure message: a failed
/// job that reported reaching its plan's limit ([`reported_limit`]) records
/// it, and a completed one clears it, only for `ran_on`, the job's own
/// credential or the login its lease took, of `person`, the job's own. Only
/// the runtime that leased the job completes it (2.6), so only it reports.
/// Then the job's `agent`, read as dispatch reads it, gives whether `ran_on`
/// is one of its backups and, after a limit, its next AI with room.
pub(crate) async fn settle_completion(
    client: &(impl GenericClient + Sync),
    ran_on: SignIn,
    person: &Uuid,
    agent: Option<&Uuid>,
    job_status: &str,
    lane: bool,
    artifacts: &JsonValue,
) -> Result<SignInEnd, Refusal> {
    let limit_recorded = match job_status {
        "failed" => match reported_limit(ran_on, lane, artifacts) {
            Some(resets_at) => record_limit(client, ran_on, person, resets_at).await?,
            None => false,
        },
        "completed" => {
            clear_limit(client, ran_on, person).await?;
            false
        }
        _ => false,
    };
    let ais = match agent {
        Some(agent) => load_agent_ais(client, agent, person).await?,
        None => None,
    };
    let backup = ais.as_ref().is_some_and(|ais| ais.is_backup(ran_on));
    let next = if limit_recorded {
        ais.as_ref()
            .and_then(AgentAis::next_with_room)
            .filter(|next| *next != ran_on)
    } else {
        None
    };
    Ok(SignInEnd {
        ran_on,
        backup,
        limit_recorded,
        next,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn credential(id: Uuid, limited_until: Option<DateTime<Utc>>) -> CredentialRoom {
        CredentialRoom { id, limited_until }
    }

    fn login(id: Uuid, limited_until: Option<DateTime<Utc>>) -> LoginRoom {
        LoginRoom { id, limited_until }
    }

    fn row(first: FirstRow, backups: &[SignIn]) -> AgentAiRow {
        let (credential_id, claude_code, claude_code_login_id) = match first {
            FirstRow::Connection(id) => (Some(id), false, None),
            FirstRow::ClaudeCode(login) => (None, true, login),
            FirstRow::NotOwn => (None, false, None),
        };
        AgentAiRow {
            credential_id,
            claude_code,
            claude_code_login_id,
            backup_ais: entries(backups),
        }
    }

    #[derive(Clone, Copy)]
    enum FirstRow {
        Connection(Uuid),
        ClaudeCode(Option<Uuid>),
        NotOwn,
    }

    #[test]
    fn a_connection_has_room_unless_a_limit_or_a_full_window_is_ahead() {
        let now = Utc::now();
        let ahead = now + Duration::hours(3);
        let later = now + Duration::days(2);
        let past = now - Duration::minutes(1);
        assert_eq!(credential_limit(None, None, now), None, "nothing known");
        assert_eq!(credential_limit(Some(ahead), None, now), Some(ahead));
        assert_eq!(
            credential_limit(Some(past), None, now),
            None,
            "a limit that has passed"
        );
        let full_window = json!({ "windows": [
            { "kind": "primary", "usedPercent": 100, "windowMinutes": 300, "resetAt": ahead.timestamp() },
            { "kind": "secondary", "usedPercent": 40.5, "windowMinutes": 10080, "resetAt": later.timestamp() },
        ] });
        assert_eq!(
            credential_limit(None, Some(&full_window), now).map(|at| at.timestamp()),
            Some(ahead.timestamp()),
            "a full window resets then"
        );
        // The latest of what holds: a full window that resets after the
        // recorded limit.
        let both_full = json!({ "windows": [
            { "usedPercent": 100, "resetAt": ahead.timestamp() },
            { "usedPercent": 101.2, "resetAt": later.timestamp() as f64 },
        ] });
        assert_eq!(
            credential_limit(Some(ahead), Some(&both_full), now).map(|at| at.timestamp()),
            Some(later.timestamp())
        );
        for (what, usage) in [
            (
                "a full window that reset",
                json!({ "windows": [{ "usedPercent": 100, "resetAt": past.timestamp() }] }),
            ),
            (
                "a window under 100%",
                json!({ "windows": [{ "usedPercent": 99.9, "resetAt": ahead.timestamp() }] }),
            ),
            (
                "a window with no reset",
                json!({ "windows": [{ "usedPercent": 100 }] }),
            ),
            (
                "a reset that is no number",
                json!({ "windows": [{ "usedPercent": 100, "resetAt": "soon" }] }),
            ),
            ("usage of another shape", json!({ "windows": "full" })),
            ("no usage", JsonValue::Null),
        ] {
            assert_eq!(credential_limit(None, Some(&usage), now), None, "{what}");
        }
        // A reset no time could hold is held to one, never a panic.
        let huge = json!({ "windows": [{ "usedPercent": 100, "resetAt": 1e300 }] });
        assert!(credential_limit(None, Some(&huge), now).is_some());
    }

    #[test]
    fn a_login_has_room_unless_its_limit_is_ahead() {
        let now = Utc::now();
        let ahead = now + Duration::hours(1);
        assert_eq!(login_limit(None, now), None);
        assert_eq!(login_limit(Some(ahead), now), Some(ahead));
        assert_eq!(
            login_limit(Some(now), now),
            None,
            "a limit that resets now holds nothing"
        );
        assert_eq!(login_limit(Some(now - Duration::seconds(1)), now), None);
        assert_eq!(
            login_has_room!("lane_login"),
            "(lane_login.limit_resets_at is null or lane_login.limit_resets_at <= statement_timestamp())"
        );
    }

    #[test]
    fn an_entry_names_one_sign_in_by_one_key_and_a_uuid() {
        let id = Uuid::new_v4();
        assert_eq!(
            SignIn::of_entry(&SignIn::Credential(id).entry()),
            Some(SignIn::Credential(id))
        );
        assert_eq!(
            SignIn::of_entry(&SignIn::Login(id).entry()),
            Some(SignIn::Login(id))
        );
        assert_eq!(
            SignIn::of_entry(&json!({ "claudeCodeLoginId": id.to_string().to_uppercase() })),
            Some(SignIn::Login(id)),
            "a UUID in capitals, as Postgres reads it"
        );
        for entry in [
            json!({ "credentialId": id.to_string(), "claudeCodeLoginId": id.to_string() }),
            json!({ "credentialId": id.to_string(), "backup": true }),
            json!({ "credentialId": id.simple().to_string() }),
            json!({ "credentialId": format!("{{{id}}}") }),
            json!({ "credentialId": "not-a-uuid" }),
            json!({ "credential_id": id.to_string() }),
            json!({ "credentialId": 7 }),
            json!(id.to_string()),
            json!({}),
        ] {
            assert_eq!(SignIn::of_entry(&entry), None, "{entry}");
        }
    }

    /// The walk (docs/Local-Engine-Turns.md 11.20): the first AI with room is
    /// taken; one at its limit moves the turn to the first backup with room,
    /// a connection to a connection, a login to the next login as a lane job
    /// on the stretch of logins that holds it, a login to a connection and a
    /// connection to a login; none with room takes the earliest reset; an
    /// entry that is not one of the owner's live sign-ins is passed over; and
    /// with none usable dispatch keeps what it took before backups.
    #[test]
    fn dispatch_takes_the_first_ai_with_room() {
        let now = Utc::now();
        let soon = now + Duration::hours(1);
        let later = now + Duration::hours(5);
        let (chatgpt, chatgpt_2, foreign) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let (first_login, work, home, gone) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let owner =
            |chatgpt_limit, chatgpt_2_limit, first_limit, work_limit, home_limit| OwnerSignIns {
                credentials: vec![
                    credential(chatgpt, chatgpt_limit),
                    credential(chatgpt_2, chatgpt_2_limit),
                ],
                logins: vec![
                    login(first_login, first_limit),
                    login(work, work_limit),
                    login(home, home_limit),
                ],
            };
        let all_room = owner(None, None, None, None, None);
        let on = |chosen: (TargetAi, Option<Chosen>)| chosen;

        // The first AI with room.
        let codex = row(
            FirstRow::Connection(chatgpt),
            &[SignIn::Credential(chatgpt_2), SignIn::Login(work)],
        );
        assert_eq!(
            on(target_ai(&codex, &all_room, true)),
            (
                TargetAi::Credential(chatgpt),
                Some(Chosen {
                    sign_in: SignIn::Credential(chatgpt),
                    backup: false,
                    room: true
                })
            )
        );
        // Connection to connection.
        let limited = owner(Some(soon), None, None, None, None);
        assert_eq!(
            target_ai(&codex, &limited, true),
            (
                TargetAi::Credential(chatgpt_2),
                Some(Chosen {
                    sign_in: SignIn::Credential(chatgpt_2),
                    backup: true,
                    room: true
                })
            )
        );
        // Connection to a login: a lane job on its stretch.
        let both_limited = owner(Some(soon), Some(later), None, None, None);
        assert_eq!(
            target_ai(&codex, &both_limited, true).0,
            TargetAi::ClaudeCode {
                login_ids: vec![work],
                login: Some(work)
            }
        );
        // None with room: the earliest reset.
        let none = owner(Some(later), Some(soon), None, Some(later), None);
        assert_eq!(
            target_ai(&codex, &none, true),
            (
                TargetAi::Credential(chatgpt_2),
                Some(Chosen {
                    sign_in: SignIn::Credential(chatgpt_2),
                    backup: true,
                    room: false
                })
            )
        );

        // A Claude Code agent on its first login, then Work and Home, then
        // ChatGPT.
        let claude = row(
            FirstRow::ClaudeCode(None),
            &[
                SignIn::Login(work),
                SignIn::Login(home),
                SignIn::Credential(chatgpt),
            ],
        );
        assert_eq!(
            target_ai(&claude, &all_room, true),
            (
                TargetAi::ClaudeCode {
                    login_ids: vec![first_login, work, home],
                    login: Some(first_login)
                },
                Some(Chosen {
                    sign_in: SignIn::Login(first_login),
                    backup: false,
                    room: true
                })
            )
        );
        // Login to the next login, with the whole stretch.
        let first_full = owner(None, None, Some(soon), None, None);
        assert_eq!(
            target_ai(&claude, &first_full, true),
            (
                TargetAi::ClaudeCode {
                    login_ids: vec![first_login, work, home],
                    login: Some(work)
                },
                Some(Chosen {
                    sign_in: SignIn::Login(work),
                    backup: true,
                    room: true
                })
            )
        );
        // Every login at its limit: the ChatGPT sign-in after them.
        let logins_full = owner(None, None, Some(soon), Some(soon), Some(later));
        assert_eq!(
            target_ai(&claude, &logins_full, true).0,
            TargetAi::Credential(chatgpt)
        );

        // Passed over: a revoked or another person's connection, a deleted
        // login, an entry that names nothing, a repeat of the first AI.
        let mut stored = row(FirstRow::Connection(chatgpt), &[]);
        stored.backup_ais = json!([
            { "credentialId": foreign.to_string() },
            { "claudeCodeLoginId": gone.to_string() },
            { "credentialId": chatgpt.to_string() },
            { "nonsense": true },
            { "claudeCodeLoginId": home.to_string() },
        ]);
        let ais = AgentAis::of(&stored, &limited);
        assert_eq!(
            ais.ais.iter().map(|ai| ai.sign_in).collect::<Vec<_>>(),
            vec![SignIn::Credential(chatgpt), SignIn::Login(home)]
        );
        assert_eq!(ais.backups(), vec![SignIn::Login(home)]);
        assert_eq!(
            target_ai(&stored, &limited, true).0,
            TargetAi::ClaudeCode {
                login_ids: vec![home],
                login: Some(home)
            }
        );

        // The first AI revoked: the first usable backup, else the fallback.
        let revoked = OwnerSignIns {
            credentials: vec![credential(chatgpt_2, None)],
            logins: vec![],
        };
        assert_eq!(
            target_ai(&codex, &revoked, true),
            (
                TargetAi::Credential(chatgpt_2),
                Some(Chosen {
                    sign_in: SignIn::Credential(chatgpt_2),
                    backup: true,
                    room: true
                })
            )
        );
        let nothing = OwnerSignIns::default();
        assert_eq!(
            target_ai(&codex, &nothing, true),
            (TargetAi::Fallback, None)
        );
        // A Claude Code agent whose person has no login waits, as before.
        assert_eq!(
            target_ai(&claude, &nothing, true),
            (
                TargetAi::ClaudeCode {
                    login_ids: vec![],
                    login: None
                },
                None
            )
        );
        // Instafy AI and the default have no backups, whatever the row says.
        let mut default = row(FirstRow::NotOwn, &[]);
        default.backup_ais = entries(&[SignIn::Credential(chatgpt_2)]);
        assert_eq!(
            target_ai(&default, &all_room, true),
            (TargetAi::Fallback, None)
        );
        assert!(AgentAis::of(&default, &all_room).backups().is_empty());
        // A turn that runs no AI keeps its first AI, whatever its room.
        assert_eq!(
            target_ai(&codex, &limited, false).0,
            TargetAi::Credential(chatgpt)
        );
    }

    #[test]
    fn a_stretch_is_the_run_of_logins_that_holds_the_chosen_one() {
        let ids: Vec<Uuid> = (0..6).map(|_| Uuid::new_v4()).collect();
        let ai = |sign_in| Ai {
            sign_in,
            first: false,
            limited_until: None,
        };
        let ais = AgentAis {
            first: FirstAi::Connection(ids[0]),
            ais: vec![
                ai(SignIn::Credential(ids[0])),
                ai(SignIn::Login(ids[1])),
                ai(SignIn::Login(ids[2])),
                ai(SignIn::Credential(ids[3])),
                ai(SignIn::Login(ids[4])),
                ai(SignIn::Login(ids[5])),
            ],
        };
        assert_eq!(ais.stretch(1), vec![ids[1], ids[2]]);
        assert_eq!(ais.stretch(2), vec![ids[1], ids[2]]);
        assert_eq!(ais.stretch(5), vec![ids[4], ids[5]]);
        assert_eq!(ais.stretch(0), Vec::<Uuid>::new(), "a connection has none");
        assert_eq!(ais.stretch(9), Vec::<Uuid>::new());
    }

    #[test]
    fn a_requests_backups_are_its_owners_live_sign_ins_each_once() {
        let (chatgpt, chatgpt_2, login_id) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        let owner = OwnerSignIns {
            credentials: vec![credential(chatgpt, None), credential(chatgpt_2, None)],
            logins: vec![login(login_id, None)],
        };
        let first = FirstAi::Connection(chatgpt);
        let code = |result: Result<Vec<SignIn>, Refusal>| {
            result.map_err(|(status, Json(error))| (status, error.code.unwrap_or_default()))
        };
        let list = |value: JsonValue| code(checked_backup_ais(&value, first, &owner, true));
        assert_eq!(
            list(json!([{ "claudeCodeLoginId": login_id }, { "credentialId": chatgpt_2 }])),
            Ok(vec![SignIn::Login(login_id), SignIn::Credential(chatgpt_2)])
        );
        assert_eq!(list(json!([])), Ok(vec![]));
        let repeated = (
            StatusCode::UNPROCESSABLE_ENTITY,
            BACKUP_AI_REPEATED.to_string(),
        );
        assert_eq!(
            list(json!([{ "credentialId": chatgpt }])),
            Err(repeated.clone()),
            "the first AI"
        );
        assert_eq!(
            list(
                json!([{ "credentialId": chatgpt_2 }, { "credentialId": chatgpt_2.to_string().to_uppercase() }])
            ),
            Err(repeated)
        );
        let unknown = (
            StatusCode::UNPROCESSABLE_ENTITY,
            BACKUP_AI_UNKNOWN.to_string(),
        );
        assert_eq!(
            list(json!([{ "credentialId": Uuid::new_v4() }])),
            Err(unknown.clone())
        );
        assert_eq!(
            list(json!([{ "claudeCodeLoginId": "not-a-login" }])),
            Err(unknown)
        );
        let nine: Vec<JsonValue> = (0..9)
            .map(|_| json!({ "credentialId": Uuid::new_v4() }))
            .collect();
        assert_eq!(
            list(JsonValue::Array(nine)),
            Err((StatusCode::BAD_REQUEST, BACKUP_AI_LIMIT.to_string()))
        );
        for shape in [
            json!({ "credentialId": chatgpt_2 }),
            json!([{ "credentialId": chatgpt_2, "claudeCodeLoginId": login_id }]),
            json!([{ "id": chatgpt_2 }]),
            json!([chatgpt_2]),
            json!([{ "credentialId": 3 }]),
        ] {
            assert_eq!(
                list(shape.clone()).map_err(|(status, _)| status),
                Err(StatusCode::BAD_REQUEST),
                "{shape}"
            );
        }
        assert_eq!(
            code(checked_backup_ais(
                &json!([{ "credentialId": chatgpt_2 }]),
                FirstAi::NotOwn,
                &owner,
                true
            )),
            Err((StatusCode::BAD_REQUEST, BACKUP_AI_NEEDS_OWN_AI.to_string()))
        );
        assert_eq!(
            code(checked_backup_ais(
                &json!([]),
                FirstAi::NotOwn,
                &owner,
                true
            )),
            Ok(vec![])
        );
        assert_eq!(
            code(checked_backup_ais(
                &json!([{ "claudeCodeLoginId": login_id }]),
                first,
                &owner,
                false
            )),
            Err((
                StatusCode::FORBIDDEN,
                crate::claude_code_lane::TURN_NOT_ALLOWED.to_string()
            ))
        );
        // Claude Code's own login is its first AI.
        assert_eq!(
            code(checked_backup_ais(
                &json!([{ "claudeCodeLoginId": login_id }]),
                FirstAi::ClaudeCode(Some(login_id)),
                &owner,
                true
            ))
            .map_err(|(_, code)| code),
            Err(BACKUP_AI_REPEATED.to_string())
        );
    }

    #[test]
    fn a_limit_is_read_from_the_jobs_own_artifact_only() {
        let (credential_id, login_id) = (
            SignIn::Credential(Uuid::new_v4()),
            SignIn::Login(Uuid::new_v4()),
        );
        let usage_limit = json!([
            { "kind": "codex/run-log", "lines": [] },
            { "kind": "ai/usage-limit", "resetsAt": 1_900_000_000 },
        ]);
        assert_eq!(
            reported_limit(credential_id, false, &usage_limit),
            Some(Some(1_900_000_000))
        );
        assert_eq!(
            reported_limit(
                credential_id,
                false,
                &json!([{ "kind": "ai/usage-limit", "resetsAt": null }])
            ),
            Some(None)
        );
        assert_eq!(
            reported_limit(credential_id, false, &json!([{ "kind": "ai/usage-limit" }])),
            Some(None)
        );
        assert_eq!(reported_limit(credential_id, false, &json!([])), None);
        assert_eq!(
            reported_limit(credential_id, true, &usage_limit),
            None,
            "a lane job's"
        );
        let plan_limit = json!([{ "kind": "claude-code/failure", "code": "plan_limit", "resetsAt": 1_900_000_000 }]);
        assert_eq!(
            reported_limit(login_id, true, &plan_limit),
            Some(Some(1_900_000_000))
        );
        assert_eq!(reported_limit(login_id, false, &plan_limit), None);
        assert_eq!(
            reported_limit(
                login_id,
                true,
                &json!([{ "kind": "claude-code/failure", "code": "not_signed_in" }])
            ),
            None
        );
        assert_eq!(
            reported_limit(
                login_id,
                true,
                &json!([{ "kind": "claude-code/failure", "code": "plan_limit" }])
            ),
            Some(None)
        );
        assert_eq!(
            reported_limit(
                login_id,
                true,
                &json!([
                    { "kind": "claude-code/failure", "code": "plan_limit" },
                    { "kind": "claude-code/failure", "code": "crashed" },
                ])
            ),
            None,
            "the last failure is the one that counts"
        );
        assert_eq!(
            reported_limit(credential_id, false, &json!({ "truncated": true })),
            None
        );
        assert!(crate::claude_code_lane::RUNTIME_FAILURE_CODES.contains(&PLAN_LIMIT));
    }

    #[test]
    fn the_stamps_name_ids_only() {
        let id = Uuid::new_v4();
        let mut map = JsonMap::new();
        stamp(&mut map, SignIn::Login(id), true);
        stamp_next(&mut map, SignIn::Credential(id));
        assert_eq!(
            JsonValue::Object(map),
            json!({
                "aiSignIn": { "claudeCodeLoginId": id.to_string(), "backup": true },
                "aiSignInNext": { "credentialId": id.to_string() },
            })
        );
        let mut map = JsonMap::new();
        stamp(&mut map, SignIn::Credential(id), false);
        assert_eq!(
            JsonValue::Object(map),
            json!({ "aiSignIn": { "credentialId": id.to_string() } })
        );
        assert_eq!(
            agent_ai_columns!("ua"),
            "ua.credential_id as ai_credential_id, ua.provider = 'claude-code' and \
             ua.credential_id is null as ai_claude_code, ua.claude_code_login_id as \
             ai_claude_code_login_id, ua.backup_ais as ai_backup_ais"
        );
        assert_eq!(crate::claude_code_lane::PROVIDER, "claude-code");
    }

    #[test]
    fn a_jobs_backup_is_read_from_its_own_stamp_for_its_own_credential() {
        let (credential, other) = (Uuid::new_v4(), Uuid::new_v4());
        let job = |stamp: JsonValue| json!({ "metadata": { "aiSignIn": stamp } });
        let backup = job(json!({ "credentialId": credential.to_string(), "backup": true }));
        assert_eq!(
            job_backup_credential(&backup, Some(credential)),
            Some(credential)
        );
        for (what, payload, credential_id) in [
            (
                "the first AI",
                job(json!({ "credentialId": credential.to_string() })),
                Some(credential),
            ),
            (
                "another credential than the job's",
                backup.clone(),
                Some(other),
            ),
            ("a job with no credential", backup.clone(), None),
            (
                "a login",
                job(json!({ "claudeCodeLoginId": credential.to_string(), "backup": true })),
                Some(credential),
            ),
            (
                "a backup flag that is not true",
                job(json!({ "credentialId": credential.to_string(), "backup": "yes" })),
                Some(credential),
            ),
            ("no stamp", json!({ "metadata": {} }), Some(credential)),
        ] {
            assert_eq!(
                job_backup_credential(&payload, credential_id),
                None,
                "{what}"
            );
        }
    }
}
