//! Limits on the AI-connection actions every signed-in person can repeat:
//! saving a new connection, testing one, and starting a ChatGPT device login.
//!
//! Each is counted in PostgreSQL under an advisory lock with the database
//! clock, so more controller instances or a restart cannot widen an
//! allowance. The allowances are per account: each account has its own, and
//! only ChatGPT-login starts also have caps across everyone. New connections
//! are counted from `user_credentials.created_at`, revoked ones included,
//! which holds because only the controller writes that table. Tests and
//! ChatGPT-login starts leave receipts in `ai_connection_attempts`.
//!
//! A person's actions serialize on their person lock. ChatGPT-login starts
//! also take one global lock, always after the person lock, so no two
//! requests wait on each other's locks in opposite orders, and a start that
//! waits for its person, whose save may wait on the database, holds up no one
//! else's start. Neither lock, nor a pooled connection, is held across a call
//! to a provider or to OpenAI. A request the counts already refuse is refused
//! before it waits for a lock, so a flood of refused requests cannot queue on
//! one while each holds a pooled connection. The same counts, taken again
//! under the lock, decide the requests that get that far.
//!
//! Windows end at `statement_timestamp()`. Each count is a statement of its
//! own, so a count taken under a lock reads the time after any wait for it.
//! `now()` is the start of the transaction, before that wait, and
//! `clock_timestamp()` changes while a statement runs, which turns an index
//! condition into a filter over every row.

use anyhow::Context;
use axum::http::StatusCode;
use axum::Json;
use serde_json::json;
use tokio_postgres::types::ToSql;
use tokio_postgres::Transaction;
use uuid::Uuid;

use crate::config::PgPool;
use crate::errors::{describe_db_error, internal_error, ApiError};

/// How many AI-connection actions a person, or everyone together, may take.
/// Windows are rolling.
#[derive(Clone, Copy, Debug)]
pub(crate) struct AiConnectionLimits {
    /// New connections a person saves in an hour, revoked ones included.
    pub(crate) new_connections_per_hour: i64,
    /// Connection tests a person runs in an hour.
    pub(crate) tests_per_hour: i64,
    /// ChatGPT logins a person starts in an hour.
    pub(crate) codex_starts_per_hour: i64,
    /// ChatGPT logins everyone together starts in a minute.
    pub(crate) codex_starts_per_minute: i64,
    /// ChatGPT logins pending at once, across everyone. A person has at most
    /// one: a new start replaces the older one.
    pub(crate) codex_pending: i64,
}

impl AiConnectionLimits {
    /// The limits for every person, in every mode. The connect flow saves a
    /// key, tests it and revokes it when the test is refused, so each mistyped
    /// key costs a new connection and a test: tests stay several times new
    /// connections.
    pub(crate) const FOR_EVERYONE: Self = Self {
        new_connections_per_hour: 20,
        tests_per_hour: 60,
        codex_starts_per_hour: 10,
        codex_starts_per_minute: 60,
        codex_pending: 256,
    };
}

/// How long a ChatGPT login's code lasts, and with it its poller.
pub(crate) const CODEX_DEVICE_AUTH_LIFETIME_SECONDS: i64 = 15 * 60;

/// How a ChatGPT login ends when the same person starts a newer one.
pub(crate) const CODEX_DEVICE_AUTH_REPLACED_MESSAGE: &str =
    "A newer ChatGPT login replaced this one.";

const HOUR_SECONDS: i64 = 60 * 60;
const MINUTE_SECONDS: i64 = 60;
const ACTION_CREDENTIAL_TEST: &str = "credential_test";
const ACTION_CODEX_DEVICE_AUTH: &str = "codex_device_auth";
const CODEX_DEVICE_AUTH_LOCK_KEY: &str = "ai-connections:codex-device-auth";
/// Receipts are kept a day, well past the longest window counted here.
const RECEIPT_RETENTION_SECONDS: i64 = 24 * 60 * 60;
const PRUNE_BATCH_SIZE: i64 = 1000;
const PRUNE_MAX_BATCHES_PER_RUN: u32 = 20;

/// A person's receipts of one kind in the window: $3 the person, $4 the action.
const PERSON_ATTEMPTS: &str = "select created_at
       from public.ai_connection_attempts
      where user_id = $3
        and action = $4
        and created_at > statement_timestamp() - $2::bigint * interval '1 second'";
/// Everyone's receipts of one kind in the window: $3 the action.
const EVERYONE_ATTEMPTS: &str = "select created_at
       from public.ai_connection_attempts
      where action = $3
        and created_at > statement_timestamp() - $2::bigint * interval '1 second'";
/// The connections a person saved in the window, revoked ones included, since
/// revoking keeps the row: $3 the person.
const PERSON_NEW_CONNECTIONS: &str = "select created_at
       from public.user_credentials
      where user_id = $3
        and created_at > statement_timestamp() - $2::bigint * interval '1 second'";

/// A per-person limit, as its refusal names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PersonLimit {
    NewConnections,
    Tests,
    CodexStarts,
}

impl PersonLimit {
    fn code(self) -> &'static str {
        match self {
            Self::NewConnections => "credential_create_rate_limited",
            Self::Tests => "credential_test_rate_limited",
            Self::CodexStarts => "codex_device_auth_rate_limited",
        }
    }

    fn counted(self) -> &'static str {
        match self {
            Self::NewConnections => "new AI connections",
            Self::Tests => "connection tests",
            Self::CodexStarts => "ChatGPT login attempts",
        }
    }
}

/// HTTP 429 for a per-person limit, with how long until one more fits.
fn rate_limited(
    limit_kind: PersonLimit,
    retry_after_seconds: i64,
    limit: i64,
    window_seconds: i64,
) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::TOO_MANY_REQUESTS,
        Json(ApiError::with_details(
            format!(
                "Too many {}. Try again in {}.",
                limit_kind.counted(),
                wait_text(retry_after_seconds)
            ),
            limit_kind.code(),
            json!({
                "retryable": true,
                "retryAfterSeconds": retry_after_seconds,
                "limit": limit,
                "windowSeconds": window_seconds,
            }),
        )),
    )
}

/// HTTP 503 for a cap on everyone's ChatGPT logins, as GitHub's caps answer.
fn codex_capacity_reached(retry_after_seconds: i64) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ApiError::with_details(
            format!(
                "ChatGPT login capacity is temporarily full. Try again in {}.",
                wait_text(retry_after_seconds)
            ),
            "codex_device_auth_capacity_reached",
            json!({
                "retryable": true,
                "retryAfterSeconds": retry_after_seconds,
            }),
        )),
    )
}

/// A wait in seconds up to two minutes, and past that in minutes, rounded up.
fn wait_text(seconds: i64) -> String {
    let seconds = seconds.max(1);
    if seconds <= 120 {
        format!("{seconds}s")
    } else {
        format!("{} min", (seconds + 59) / 60)
    }
}

fn database_error(context: &str, error: tokio_postgres::Error) -> (StatusCode, Json<ApiError>) {
    internal_error(format!("{context}: {}", describe_db_error(&error)))
}

async fn advisory_lock(
    transaction: &Transaction<'_>,
    key: &str,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&key],
        )
        .await
        .map_err(|error| database_error("failed to serialize AI connection limits", error))?;
    Ok(())
}

/// Serializes one person's AI-connection actions until the transaction ends.
async fn lock_person(
    transaction: &Transaction<'_>,
    user_id: Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    advisory_lock(transaction, &format!("ai-connections:user:{user_id}")).await
}

/// Takes the locks a ChatGPT-login start takes, in its order, so a test can
/// hold them while other requests of the same person arrive.
#[cfg(test)]
pub(crate) async fn take_codex_start_locks(
    transaction: &Transaction<'_>,
    user_id: Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    lock_person(transaction, user_id).await?;
    advisory_lock(transaction, CODEX_DEVICE_AUTH_LOCK_KEY).await
}

struct WindowCount {
    used: i64,
    /// Seconds until one more fits under the limit, once `used` reached it.
    retry_after_seconds: i64,
}

/// Counts the rows `recent` selects in a rolling window, and the wait until
/// one more fits under `limit`: until the limit-th newest leaves the window,
/// which stays exact after a limit is lowered below what was already counted.
/// `recent` selects `created_at` with the window in seconds as $2, and takes
/// `scope` as its own parameters from $3.
async fn count_window(
    transaction: &Transaction<'_>,
    recent: &str,
    limit: i64,
    window_seconds: i64,
    scope: &[&(dyn ToSql + Sync)],
) -> Result<WindowCount, (StatusCode, Json<ApiError>)> {
    let query = format!(
        "with recent as ({recent})
         select count(*)::bigint as used,
                greatest(1, ceil(extract(epoch from (
                  (select created_at from recent
                    order by created_at desc
                    offset greatest($1::bigint - 1, 0) limit 1)
                  + $2::bigint * interval '1 second' - statement_timestamp()
                ))))::bigint as retry_after_seconds
           from recent"
    );
    let mut params: Vec<&(dyn ToSql + Sync)> = vec![&limit, &window_seconds];
    params.extend_from_slice(scope);
    let row = transaction
        .query_one(&query, &params)
        .await
        .map_err(|error| database_error("failed to count AI connection attempts", error))?;
    Ok(WindowCount {
        used: row.get("used"),
        retry_after_seconds: row.get("retry_after_seconds"),
    })
}

async fn refuse_new_connection_over_limit(
    transaction: &Transaction<'_>,
    user_id: Uuid,
    limits: &AiConnectionLimits,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let saved = count_window(
        transaction,
        PERSON_NEW_CONNECTIONS,
        limits.new_connections_per_hour,
        HOUR_SECONDS,
        &[&user_id],
    )
    .await?;
    if saved.used >= limits.new_connections_per_hour {
        return Err(rate_limited(
            PersonLimit::NewConnections,
            saved.retry_after_seconds,
            limits.new_connections_per_hour,
            HOUR_SECONDS,
        ));
    }
    Ok(())
}

/// Refuses a new connection once the person saved `new_connections_per_hour`
/// in the last hour. Called in the transaction that inserts the connection,
/// which holds the person lock until it commits, so two saves cannot both
/// take the last slot. A person already at the limit is refused before the
/// lock.
pub(crate) async fn check_new_connection(
    transaction: &Transaction<'_>,
    user_id: Uuid,
    limits: &AiConnectionLimits,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    refuse_new_connection_over_limit(transaction, user_id, limits).await?;
    lock_person(transaction, user_id).await?;
    refuse_new_connection_over_limit(transaction, user_id, limits).await
}

async fn refuse_test_over_limit(
    transaction: &Transaction<'_>,
    user_id: Uuid,
    limits: &AiConnectionLimits,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let tests = count_window(
        transaction,
        PERSON_ATTEMPTS,
        limits.tests_per_hour,
        HOUR_SECONDS,
        &[&user_id, &ACTION_CREDENTIAL_TEST],
    )
    .await?;
    if tests.used >= limits.tests_per_hour {
        return Err(rate_limited(
            PersonLimit::Tests,
            tests.retry_after_seconds,
            limits.tests_per_hour,
            HOUR_SECONDS,
        ));
    }
    Ok(())
}

/// Records a test of `credential_id` before it reaches the provider, or
/// refuses it once the person ran `tests_per_hour` tests in the last hour.
/// The caller commits right after, so the person lock is released before the
/// probe. A person already at the limit is refused before the lock.
pub(crate) async fn record_credential_test(
    transaction: &Transaction<'_>,
    user_id: Uuid,
    credential_id: Uuid,
    limits: &AiConnectionLimits,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    refuse_test_over_limit(transaction, user_id, limits).await?;
    lock_person(transaction, user_id).await?;
    refuse_test_over_limit(transaction, user_id, limits).await?;
    transaction
        .execute(
            "insert into public.ai_connection_attempts (user_id, action, credential_id)
             values ($1, $2, $3)",
            &[&user_id, &ACTION_CREDENTIAL_TEST, &credential_id],
        )
        .await
        .map_err(|error| database_error("failed to record a connection test", error))?;
    Ok(())
}

/// Refuses a ChatGPT-login start once the person started
/// `codex_starts_per_hour` logins in the last hour, when the connection a
/// login ends in could not be saved under the new-connection limit, or when
/// everyone's starts in the last minute or pending logins reached their caps.
async fn refuse_codex_start_over_limits(
    transaction: &Transaction<'_>,
    user_id: Uuid,
    limits: &AiConnectionLimits,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let starts = count_window(
        transaction,
        PERSON_ATTEMPTS,
        limits.codex_starts_per_hour,
        HOUR_SECONDS,
        &[&user_id, &ACTION_CODEX_DEVICE_AUTH],
    )
    .await?;
    if starts.used >= limits.codex_starts_per_hour {
        return Err(rate_limited(
            PersonLimit::CodexStarts,
            starts.retry_after_seconds,
            limits.codex_starts_per_hour,
            HOUR_SECONDS,
        ));
    }
    // A login is saved as a new connection when it completes. Refuse one that
    // could not be saved before anyone is shown a code.
    refuse_new_connection_over_limit(transaction, user_id, limits).await?;
    let everyone_starts = count_window(
        transaction,
        EVERYONE_ATTEMPTS,
        limits.codex_starts_per_minute,
        MINUTE_SECONDS,
        &[&ACTION_CODEX_DEVICE_AUTH],
    )
    .await?;
    if everyone_starts.used >= limits.codex_starts_per_minute {
        return Err(codex_capacity_reached(everyone_starts.retry_after_seconds));
    }
    // Everyone else's pending logins: the person's own are replaced by this
    // start, so they take no place. The wait is until enough pending logins
    // expire for one more; one that completes or is cancelled frees its place
    // sooner.
    let pending = transaction
        .query_one(
            "with pending as (
               select expires_at
                 from public.ai_connection_attempts
                where action = $2
                  and completed_at is null
                  and expires_at > statement_timestamp()
                  and user_id <> $3
             )
             select count(*)::bigint as used,
                    greatest(1, ceil(extract(epoch from (
                      (select expires_at from pending
                        order by expires_at desc
                        offset greatest($1::bigint - 1, 0) limit 1)
                      - statement_timestamp()
                    ))))::bigint as retry_after_seconds
               from pending",
            &[&limits.codex_pending, &ACTION_CODEX_DEVICE_AUTH, &user_id],
        )
        .await
        .map_err(|error| database_error("failed to count pending ChatGPT logins", error))?;
    if pending.get::<_, i64>("used") >= limits.codex_pending {
        return Err(codex_capacity_reached(pending.get("retry_after_seconds")));
    }
    Ok(())
}

/// Counts a ChatGPT-login start, before OpenAI is asked for a code, and makes
/// it the person's one pending login. Refuses, leaving nothing behind, when a
/// limit is reached (see `refuse_codex_start_over_limits`). Gives the ids of
/// the person's logins it replaced.
pub(crate) async fn reserve_codex_device_auth(
    pool: &PgPool,
    user_id: Uuid,
    session_id: Uuid,
    limits: &AiConnectionLimits,
) -> Result<Vec<Uuid>, (StatusCode, Json<ApiError>)> {
    let mut connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let transaction = connection
        .transaction()
        .await
        .map_err(|error| internal_error(format!("failed to start transaction: {error}")))?;
    // Every start waits for the global lock, so one the counts already refuse
    // is refused before it joins that queue. It waits for its person first:
    // a save by the same person that waits on the database then holds up only
    // that person's requests, not everyone's starts.
    refuse_codex_start_over_limits(&transaction, user_id, limits).await?;
    lock_person(&transaction, user_id).await?;
    advisory_lock(&transaction, CODEX_DEVICE_AUTH_LOCK_KEY).await?;
    refuse_codex_start_over_limits(&transaction, user_id, limits).await?;

    // One pending login per person: this start ends the older ones, whose
    // pollers stop when they find their receipt closed.
    let replaced = transaction
        .query(
            "update public.ai_connection_attempts
                set completed_at = clock_timestamp()
              where user_id = $1
                and action = $2
                and completed_at is null
            returning id",
            &[&user_id, &ACTION_CODEX_DEVICE_AUTH],
        )
        .await
        .map_err(|error| database_error("failed to replace pending ChatGPT logins", error))?
        .iter()
        .map(|row| row.get::<_, Uuid>("id"))
        .collect::<Vec<_>>();

    transaction
        .execute(
            "insert into public.ai_connection_attempts (id, user_id, action, expires_at)
             values ($1, $2, $3, clock_timestamp() + $4::bigint * interval '1 second')",
            &[
                &session_id,
                &user_id,
                &ACTION_CODEX_DEVICE_AUTH,
                &CODEX_DEVICE_AUTH_LIFETIME_SECONDS,
            ],
        )
        .await
        .map_err(|error| database_error("failed to record a ChatGPT login start", error))?;
    transaction
        .commit()
        .await
        .map_err(|error| database_error("failed to commit a ChatGPT login start", error))?;
    Ok(replaced)
}

/// Whether a ChatGPT login's receipt is still open. A newer start by the same
/// person closes it, on whichever controller that start reached.
pub(crate) async fn codex_device_auth_is_open(
    pool: &PgPool,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<bool, (StatusCode, Json<ApiError>)> {
    let connection = pool
        .get()
        .await
        .map_err(|error| internal_error(format!("failed to get connection: {error}")))?;
    let row = connection
        .query_opt(
            "select 1
               from public.ai_connection_attempts
              where id = $1
                and user_id = $2
                and action = $3
                and completed_at is null",
            &[&session_id, &user_id, &ACTION_CODEX_DEVICE_AUTH],
        )
        .await
        .map_err(|error| database_error("failed to load a ChatGPT login receipt", error))?;
    Ok(row.is_some())
}

/// Closes a ChatGPT login's receipt in the transaction that saves its
/// connection, after `check_new_connection` took the person lock. Refuses the
/// save, which then rolls back, when the receipt is already closed: a newer
/// start replaced the login or it was cancelled, perhaps while its poller
/// still waited on OpenAI.
pub(crate) async fn close_codex_device_auth_for_save(
    transaction: &Transaction<'_>,
    user_id: Uuid,
    session_id: Uuid,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let closed = transaction
        .query_opt(
            "update public.ai_connection_attempts
                set completed_at = clock_timestamp()
              where id = $1
                and user_id = $2
                and action = $3
                and completed_at is null
            returning id",
            &[&session_id, &user_id, &ACTION_CODEX_DEVICE_AUTH],
        )
        .await
        .map_err(|error| database_error("failed to close a ChatGPT login receipt", error))?;
    if closed.is_none() {
        return Err((
            StatusCode::CONFLICT,
            Json(ApiError::new(CODEX_DEVICE_AUTH_REPLACED_MESSAGE)),
        ));
    }
    Ok(())
}

/// Closes a ChatGPT login's receipt, so it no longer counts as pending and
/// can no longer save its connection; its start still counts. A failure is
/// logged: the receipt stops counting as pending anyway when its code expires.
pub(crate) async fn finish_codex_device_auth(pool: &PgPool, user_id: Uuid, session_id: Uuid) {
    let finished = async {
        let connection = pool
            .get()
            .await
            .map_err(|error| anyhow::anyhow!("failed to get connection: {error}"))?;
        connection
            .execute(
                "update public.ai_connection_attempts
                    set completed_at = clock_timestamp()
                  where id = $1
                    and user_id = $2
                    and action = $3
                    and completed_at is null",
                &[&session_id, &user_id, &ACTION_CODEX_DEVICE_AUTH],
            )
            .await
            .map_err(|error| anyhow::anyhow!(describe_db_error(&error)))?;
        anyhow::Ok(())
    }
    .await;
    if let Err(error) = finished {
        tracing::warn!(
            %error,
            session_id = %session_id,
            user_id = %user_id,
            "failed to close a ChatGPT login receipt"
        );
    }
}

/// Deletes receipts older than a day, in bounded batches per action so each
/// one is a short range of the (action, created_at) index.
pub(crate) async fn prune_ai_connection_attempts(pool: &PgPool) -> anyhow::Result<u64> {
    let connection = pool
        .get()
        .await
        .context("failed to acquire connection for ai_connection_attempts pruning")?;
    let mut total_deleted: u64 = 0;
    for action in [ACTION_CREDENTIAL_TEST, ACTION_CODEX_DEVICE_AUTH] {
        for _ in 0..PRUNE_MAX_BATCHES_PER_RUN {
            let deleted = connection
                .execute(
                    "delete from public.ai_connection_attempts
                      where ctid in (
                        select ctid
                          from public.ai_connection_attempts
                         where action = $1
                           and created_at < now() - $2::bigint * interval '1 second'
                         limit $3
                      )",
                    &[&action, &RECEIPT_RETENTION_SECONDS, &PRUNE_BATCH_SIZE],
                )
                .await
                .context("failed to prune ai_connection_attempts")?;
            total_deleted += deleted;
            if deleted < PRUNE_BATCH_SIZE as u64 {
                break;
            }
        }
    }
    if total_deleted > 0 {
        tracing::info!(deleted = total_deleted, "pruned old ai_connection_attempts");
    }
    Ok(total_deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refusal_json(error: (StatusCode, Json<ApiError>)) -> (StatusCode, serde_json::Value) {
        let (status, Json(body)) = error;
        (
            status,
            serde_json::to_value(body).expect("ApiError serializes"),
        )
    }

    #[test]
    fn waits_read_in_seconds_up_to_two_minutes_then_in_minutes() {
        assert_eq!(wait_text(0), "1s");
        assert_eq!(wait_text(1), "1s");
        assert_eq!(wait_text(45), "45s");
        assert_eq!(wait_text(120), "120s");
        assert_eq!(wait_text(121), "3 min");
        assert_eq!(wait_text(812), "14 min");
        assert_eq!(wait_text(3600), "60 min");
    }

    #[test]
    fn per_person_refusals_are_429_with_their_code_limit_and_window() {
        for (limit_kind, code, message) in [
            (
                PersonLimit::NewConnections,
                "credential_create_rate_limited",
                "Too many new AI connections. Try again in 14 min.",
            ),
            (
                PersonLimit::Tests,
                "credential_test_rate_limited",
                "Too many connection tests. Try again in 14 min.",
            ),
            (
                PersonLimit::CodexStarts,
                "codex_device_auth_rate_limited",
                "Too many ChatGPT login attempts. Try again in 14 min.",
            ),
        ] {
            let (status, body) = refusal_json(rate_limited(limit_kind, 812, 60, HOUR_SECONDS));
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
            assert_eq!(
                body,
                json!({
                    "message": message,
                    "code": code,
                    "details": {
                        "retryable": true,
                        "retryAfterSeconds": 812,
                        "limit": 60,
                        "windowSeconds": 3600,
                    },
                })
            );
        }
        let (_, body) = refusal_json(rate_limited(PersonLimit::Tests, 42, 60, HOUR_SECONDS));
        assert_eq!(
            body["message"],
            json!("Too many connection tests. Try again in 42s.")
        );
    }

    #[test]
    fn everyone_caps_are_503_with_when_to_retry() {
        let (status, body) = refusal_json(codex_capacity_reached(37));
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body,
            json!({
                "message": "ChatGPT login capacity is temporarily full. Try again in 37s.",
                "code": "codex_device_auth_capacity_reached",
                "details": { "retryable": true, "retryAfterSeconds": 37 },
            })
        );
    }

    #[test]
    fn the_limits_for_everyone_keep_tests_well_above_new_connections() {
        let limits = AiConnectionLimits::FOR_EVERYONE;
        assert_eq!(limits.new_connections_per_hour, 20);
        assert_eq!(limits.tests_per_hour, 60);
        assert_eq!(limits.codex_starts_per_hour, 10);
        assert_eq!(limits.codex_starts_per_minute, 60);
        assert_eq!(limits.codex_pending, 256);
        // A refused test makes the connect flow revoke the key it just saved.
        assert!(limits.tests_per_hour >= 3 * limits.new_connections_per_hour);
    }
}
