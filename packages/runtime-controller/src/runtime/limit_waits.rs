//! Background retry for spaces waiting on their organization's hosted
//! runtime limit.
//!
//! A space whose launch is refused with `runtime_limit_reached` can only get a
//! machine through another ensure: the idle-slot reclaim runs inside one, and
//! nothing else frees the organization's slot for it. Clients ask again only
//! on interaction, and the dispatch path asks once, so a message queued behind
//! a machine that goes idle a minute later used to wait forever even though the
//! studio said it would send once a runtime is free.
//!
//! Every limit refusal of a real ensure is recorded here (one row per space).
//! A controller sweep replays the refused ensure for spaces that still have
//! queued agent work and no live runtime, with per-space exponential backoff,
//! a bounded batch per tick, and a give-up that fails the waiting jobs with a
//! plain reason. The replay is the ordinary ensure path, so the organization
//! limit, the credit precheck and the idle-slot reclaim all apply unchanged: it
//! never launches a machine a user's own ensure could not.
//!
//! Replicas coordinate through the table: a sweep claims due rows with
//! `for update skip locked` and a claim lease (`claimed_until`), so a space is
//! retried by at most one controller at a time and an abandoned claim expires.
//! The lease's expiry doubles as the claim's token: every later claim of a row
//! carries a strictly later expiry (it can only be taken once the previous one
//! has passed), so a controller whose claim lapsed mid-attempt cannot release,
//! finish or back off the claim another controller has taken since. Two
//! replicas retrying different spaces of one organization at once cannot both
//! take its last hosted slot either: the ensure's organization-limit check and
//! lease insert run under a per-organization advisory lock (see `ensure.rs`).
//!
//! Bound per controller and tick: at most `batch_size` spaces, each handled
//! once. Spaces holding a job past the give-up window are claimed before plain
//! retries, so a give-up never waits behind slow launches of other spaces, and
//! within a tick an organization's second space comes after every other
//! organization's first. A retry is one ensure, bounded by the provider launch
//! and release deadlines, so a tick ends in at most `batch_size` of those.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result as AnyResult};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tokio::time::MissedTickBehavior;
use tokio_postgres::types::Json as PgJson;
use tracing::{debug, info, warn};
use uuid::Uuid;

use crate::{publish_controller_event, ApiError, AppState};

use super::lease::RuntimeLeaseScope;

/// Error code of the organization-limit refusal (`hosted_runtime_limit_refusal`).
pub(super) const RUNTIME_LIMIT_REACHED_CODE: &str = "runtime_limit_reached";

const SWEEP_INTERVAL: Duration = Duration::from_secs(10);
/// A recorded request larger than this is stored without its metadata. The
/// frontend's is a few hundred bytes; this only bounds a hostile caller.
const MAX_RECORDED_REQUEST_BYTES: usize = 16 * 1024;
const MAX_RECORDED_ERROR_CHARS: usize = 500;

/// The message a job gets when it waited out the whole window on the limit.
pub(super) const LIMIT_WAIT_EXPIRED_MESSAGE: &str = "This message didn't start: every cloud runtime in this team stayed busy for 30 minutes. Stop a runtime you aren't using, then send it again.";
/// The message when the last retry failed for a reason other than the limit.
pub(super) const LIMIT_WAIT_EXPIRED_OTHER_MESSAGE: &str = "This message didn't start: no cloud runtime could be started for this space within 30 minutes. Send it again to retry.";
/// The message when a retry was refused for a reason waiting cannot fix and
/// the refusal carried no message of its own (or the recorded request could
/// not be replayed at all).
pub(super) const LIMIT_WAIT_REFUSED_FALLBACK_MESSAGE: &str = "This message didn't start: a cloud runtime could not be started for this space. Send it again to retry.";

/// Tuning for the retry sweep. Production uses [`LimitWaitPolicy::default`];
/// tests pass their own to control batch size and timing.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LimitWaitPolicy {
    /// Delay before the first retry after a refusal, doubled per attempt.
    pub(crate) backoff_base: Duration,
    pub(crate) backoff_max: Duration,
    /// Spaces retried (or expired) per sweep tick, per controller.
    pub(crate) batch_size: i64,
    /// A queued job that has waited this long on the limit is failed.
    pub(crate) give_up_after: Duration,
    /// How long a claim protects a space from other replicas. Longer than any
    /// bounded ensure, so it only matters when a controller dies mid-attempt.
    pub(crate) claim_ttl: Duration,
}

impl Default for LimitWaitPolicy {
    fn default() -> Self {
        Self {
            backoff_base: Duration::from_secs(30),
            backoff_max: Duration::from_secs(5 * 60),
            batch_size: 5,
            give_up_after: Duration::from_secs(30 * 60),
            claim_ttl: Duration::from_secs(20 * 60),
        }
    }
}

impl LimitWaitPolicy {
    /// Delay before the next retry once `attempts` retries have been made:
    /// base, 2x, 4x, ... capped at `backoff_max`.
    pub(crate) fn retry_delay(&self, attempts: i32) -> Duration {
        let exponent = attempts.clamp(0, 16) as u32;
        self.backoff_base
            .saturating_mul(2u32.saturating_pow(exponent))
            .min(self.backoff_max)
    }
}

/// Who asked for the refused machine. A user's own request carries their
/// choices (machine size, origin mode); a server-initiated one (dispatch
/// reconnect, requeue recovery, automation) does not, so it never replaces a
/// recorded user request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LimitWaitSource {
    User,
    Server,
}

impl LimitWaitSource {
    fn as_str(self) -> &'static str {
        match self {
            LimitWaitSource::User => "user",
            LimitWaitSource::Server => "server",
        }
    }
}

/// The refused ensure, replayed verbatim by the retry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct LimitWaitEnsureRequest {
    pub(super) provider: String,
    #[serde(default)]
    pub(super) runtime_id: Option<Uuid>,
    pub(super) idle_ttl_seconds: u32,
    #[serde(default)]
    pub(super) display_name: Option<String>,
    #[serde(default)]
    pub(super) metadata: Option<JsonValue>,
    #[serde(default)]
    pub(super) scope: Option<String>,
    #[serde(default)]
    pub(super) origin_mode: Option<String>,
    #[serde(default)]
    pub(super) origin_protocols: Vec<String>,
}

impl LimitWaitEnsureRequest {
    pub(super) fn lease_scope(&self) -> RuntimeLeaseScope {
        match self.scope.as_deref() {
            Some("shared") => RuntimeLeaseScope::Shared,
            _ => RuntimeLeaseScope::Exclusive,
        }
    }

    /// The stored form: metadata passes the managed-runtime request sanitizer
    /// first, exactly as the launch would store it, and an oversized request
    /// drops its metadata rather than failing the record.
    fn to_stored_json(&self) -> JsonValue {
        let mut stored = self.clone();
        stored.metadata = super::managed::sanitize_managed_runtime_request_metadata(
            &stored.provider,
            stored.metadata.take(),
        )
        .ok()
        .flatten();
        let value = serde_json::to_value(&stored).unwrap_or_else(|_| json!({}));
        if value.to_string().len() <= MAX_RECORDED_REQUEST_BYTES {
            return value;
        }
        stored.metadata = None;
        serde_json::to_value(&stored).unwrap_or_else(|_| json!({}))
    }
}

pub(crate) fn is_runtime_limit_refusal(error: &(StatusCode, Json<ApiError>)) -> bool {
    error.0 == StatusCode::PAYMENT_REQUIRED
        && error.1 .0.code.as_deref() == Some(RUNTIME_LIMIT_REACHED_CODE)
}

/// Refusals other than the limit that the retry keeps waiting through: a
/// launch that is still settling (409), throttling, and server-side trouble,
/// including platform capacity (503). Anything else (credits, access, a
/// deleted space, a provider this controller no longer offers) is not
/// something waiting fixes, so the waiting work fails with that refusal's
/// own message instead of sitting queued behind a wait that has ended.
fn refusal_is_worth_retrying(status: StatusCode) -> bool {
    status == StatusCode::CONFLICT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status.is_server_error()
}

static MISSING_TABLE_REPORTED: AtomicBool = AtomicBool::new(false);

/// The table ships in a migration that may land after this controller. Until
/// it does the feature is off: say so once, never fail the caller.
fn table_is_missing(error: &tokio_postgres::Error) -> bool {
    let missing = error
        .as_db_error()
        .is_some_and(|db| db.code() == &tokio_postgres::error::SqlState::UNDEFINED_TABLE);
    if missing && !MISSING_TABLE_REPORTED.swap(true, Ordering::Relaxed) {
        warn!(
            "hosted_runtime_limit_waits is not migrated yet; \
             queued work behind the runtime limit is not retried in the background"
        );
    }
    missing
}

/// Whether the wait `w` has been quiet (no limit refusal and no retry) for
/// longer than the give-up window, bound to parameter `window`. A retry counts
/// as activity: a wait whose retries keep failing for another reason (409,
/// 5xx) is still the same wait, so it must not restart the give-up clock.
fn wait_is_quiet(window: &str) -> String {
    format!(
        "greatest(w.last_refused_at, coalesce(w.last_attempt_at, w.last_refused_at))
           < now() - {window}::double precision * interval '1 second'"
    )
}

/// Remember that `project_id` was refused a hosted machine by the organization
/// limit. Best effort: a failure is logged and the caller's refusal stands.
///
/// A refusal inside an active wait keeps its backoff and its start (the
/// give-up clock); one after the wait went quiet for the whole give-up window
/// starts a new wait.
pub(super) async fn record_hosted_runtime_limit_refusal(
    state: &AppState,
    project_id: Uuid,
    request: &LimitWaitEnsureRequest,
    source: LimitWaitSource,
) {
    let policy = LimitWaitPolicy::default();
    let connection = match state.pool.get().await {
        Ok(connection) => connection,
        Err(error) => {
            warn!(%project_id, %error, "could not record a hosted runtime limit wait");
            return;
        }
    };
    let result = connection
        .execute(
            &format!(
                "insert into hosted_runtime_limit_waits as w
                    (project_id, ensure_request, request_source, first_refused_at,
                     last_refused_at, attempts, next_attempt_at, last_error_code, updated_at)
                 values ($1, $2::jsonb, $3, now(), now(), 0,
                         now() + $4::double precision * interval '1 second',
                         $6, now())
                 on conflict (project_id) do update set
                   first_refused_at = case
                     when {quiet} then now() else w.first_refused_at end,
                   attempts = case
                     when {quiet} then 0 else w.attempts end,
                   next_attempt_at = case
                     when {quiet} then excluded.next_attempt_at else w.next_attempt_at end,
                   last_attempt_at = case
                     when {quiet} then null else w.last_attempt_at end,
                   ensure_request = case
                     when excluded.request_source = 'user'
                       or w.request_source <> 'user'
                       or {quiet}
                       then excluded.ensure_request else w.ensure_request end,
                   request_source = case
                     when excluded.request_source = 'user' or {quiet}
                       then excluded.request_source else w.request_source end,
                   last_refused_at = now(),
                   last_error_code = excluded.last_error_code,
                   last_error = null,
                   updated_at = now()",
                quiet = wait_is_quiet("$5"),
            ),
            &[
                &project_id,
                &PgJson(request.to_stored_json()),
                &source.as_str(),
                &policy.retry_delay(0).as_secs_f64(),
                &policy.give_up_after.as_secs_f64(),
                &RUNTIME_LIMIT_REACHED_CODE,
            ],
        )
        .await;
    match result {
        Ok(_) => {
            debug!(%project_id, source = source.as_str(), "recorded hosted runtime limit wait")
        }
        Err(error) if table_is_missing(&error) => {}
        Err(error) => warn!(%project_id, %error, "could not record a hosted runtime limit wait"),
    }
}

/// Whether the runtime alias `r` is a hosted provider's, matching the
/// organization limit's own filter.
fn hosted_provider(r: &str) -> String {
    format!(
        "({r}.provider = 'instafy_cloud'
          or {r}.provider like 'instafy\\_cloud\\_%'
          or {r}.provider = 'instafy-cloud'
          or {r}.provider like 'instafy-cloud-%')"
    )
}

/// Whether the runtime `r`, joined to its active lease as `rl`, is up or about
/// to be: a generation holding an unreleased lease, or a registered machine
/// that is heartbeating. A `requested` row with no lease, which dispatch
/// leaves behind for a refused space, is not, and neither is a generation
/// quarantined after a failed provider release (`cleanup_pending`): it holds
/// a slot but runs nothing.
fn runtime_is_live(r: &str, rl: &str) -> String {
    format!(
        "{r}.status not in ('stopped', 'offline', 'removed')
         and (
           ({rl}.id is not null
              and {rl}.released_at is null
              and {rl}.status not in ('failed', 'cleanup_pending'))
           or {r}.last_seen_at > now() - interval '90 seconds'
         )"
    )
}

/// Whether the runtime `r` is a private machine (a desktop, a personal
/// browser) that does not lease unpinned work of the job `j`'s user. The same
/// rule `lease_next_agent_job` applies when that machine asks for work.
fn runtime_is_private_to_another_user(r: &str, j: &str) -> String {
    format!(
        "coalesce(
           (lower(replace(replace(btrim({r}.provider), '-', '_'), ' ', '_')) = 'self_hosted'
            or {r}.capabilities ? '_instafySelfHostedAccess'
            or {r}.capabilities ? '_instafy_self_hosted_access'
            or {r}.capabilities ? 'personalBrowser'
            or {r}.capabilities ? 'personal_browser')
           and coalesce(
             {r}.capabilities #>> '{{_instafySelfHostedAccess,ownerUserId}}',
             {r}.capabilities #>> '{{_instafy_self_hosted_access,owner_user_id}}',
             {r}.capabilities #>> '{{personalBrowser,ownerUserId}}',
             {r}.capabilities #>> '{{personal_browser,owner_user_id}}'
           ) is distinct from {j}.payload #>> '{{user_id}}',
           false
         )"
    )
}

/// Whether a live runtime could run the waiting job `j` now: a hosted runtime
/// of its space (what the wait asked for), the machine the job is pinned to,
/// or, for unpinned work, a machine in the space that leases unpinned work for
/// the job's user. Any other heartbeating machine (a desktop that never
/// leases work pinned to the hosted runtime, or one that only runs its owner's
/// work) leaves the job waiting on the limit.
///
/// A runtime preference held in one controller's memory can also keep a
/// machine from leasing unpinned work; the database cannot see it, so such a
/// machine still counts here.
fn job_has_live_runner(j: &str) -> String {
    format!(
        "exists (
           select 1
           from runtimes lr
           left join runtime_leases lrl on lrl.id = lr.active_lease_id
           where lr.project_id = {j}.project_id
             and {live}
             and (
               {hosted}
               or lr.id = {j}.target_runtime_id
               or ({j}.target_runtime_id is null and not {private})
             )
         )",
        live = runtime_is_live("lr", "lrl"),
        hosted = hosted_provider("lr"),
        private = runtime_is_private_to_another_user("lr", j),
    )
}

/// Whether the space `project` (an SQL expression) has a live hosted runtime,
/// which is what its wait asked for.
fn hosted_runtime_is_live_in(project: &str) -> String {
    format!(
        "exists (
           select 1
           from runtimes lr
           left join runtime_leases lrl on lrl.id = lr.active_lease_id
           where lr.project_id = {project}
             and {hosted}
             and {live}
         )",
        hosted = hosted_provider("lr"),
        live = runtime_is_live("lr", "lrl"),
    )
}

/// Queued work in the space `project` that a hosted machine there would pick
/// up: unpinned, or pinned to one of the space's own hosted runtimes. Work
/// pinned to a desktop or another machine is waiting for that machine, not
/// for the limit.
fn waiting_job_predicate(alias: &str, project: &str) -> String {
    format!(
        "{alias}.project_id = {project}
         and {alias}.status = 'queued'
         and (
           {alias}.target_runtime_id is null
           or exists (
             select 1 from runtimes t
             where t.id = {alias}.target_runtime_id
               and t.project_id = {alias}.project_id
               and {hosted}
           )
         )",
        hosted = hosted_provider("t"),
    )
}

/// Waiting work (see [`waiting_job_predicate`]) that no live runtime could
/// run: what the retry, the give-up and the claim are for.
fn unserved_job_predicate(alias: &str, project: &str) -> String {
    format!(
        "{} and not {}",
        waiting_job_predicate(alias, project),
        job_has_live_runner(alias)
    )
}

/// Since when a job has been waiting on the limit: since it was queued (or
/// requeued by a stop), but never before its space's wait began, whose start
/// is the SQL expression `wait_started`. A job that sat behind its own busy
/// machine for an hour and is then refused a new one gets the full window.
fn waiting_on_limit_since(alias: &str, wait_started: &str) -> String {
    format!(
        "greatest(
           coalesce(
             case when {alias}.payload ? 'requeuedAt'
               then ({alias}.payload ->> 'requeuedAt')::timestamptz end,
             {alias}.created_at
           ),
           {wait_started}
         )"
    )
}

/// Queued work in `project_id` that a hosted machine there would run.
pub(super) async fn count_waiting_jobs(state: &AppState, project_id: &Uuid) -> AnyResult<i64> {
    let row = state
        .pool
        .get()
        .await
        .context("failed to acquire connection to count waiting jobs")?
        .query_one(
            &format!(
                "select count(*) as waiting from agent_jobs j where {}",
                waiting_job_predicate("j", "$1")
            ),
            &[project_id],
        )
        .await
        .context("failed to count waiting jobs")?;
    Ok(row.get("waiting"))
}

#[derive(Debug)]
struct ClaimedWait {
    project_id: Uuid,
    org_id: Option<Uuid>,
    ensure_request: JsonValue,
    attempts: i32,
    retry_due: bool,
    last_error_code: Option<String>,
    /// The claim lease's expiry, which is also the claim's token: release,
    /// finish and backoff only touch the row while it still carries it.
    claim_token: DateTime<Utc>,
}

/// What one sweep tick did, for logs and tests.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct LimitWaitSweepReport {
    pub(crate) claimed: usize,
    pub(crate) attempted: usize,
    pub(crate) launched: usize,
    /// Jobs failed because they waited out the give-up window.
    pub(crate) expired_jobs: usize,
    /// Jobs failed because a retry was refused for a reason waiting cannot fix.
    pub(crate) refused_jobs: usize,
    pub(crate) finished_waits: usize,
}

pub(crate) fn spawn_hosted_runtime_limit_wait_sweep(state: AppState) {
    tokio::spawn(async move {
        let policy = LimitWaitPolicy::default();
        let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            match sweep_hosted_runtime_limit_waits(&state, &policy).await {
                Ok(report) if report != LimitWaitSweepReport::default() => {
                    info!(?report, "hosted runtime limit wait sweep")
                }
                Ok(_) => {}
                Err(error) => warn!(?error, "hosted runtime limit wait sweep failed"),
            }
        }
    });
}

/// One sweep tick: drop waits that are over, then handle up to one batch of
/// spaces with waiting work that are due for a retry or hold a job past the
/// give-up age. Spaces are claimed one at a time, right before they are
/// handled, so a claim's lease covers one ensure however slow the rest of the
/// batch is, and a space is handled at most once per tick. Give-ups are
/// claimed first, and organizations take turns (see the module comment).
pub(crate) async fn sweep_hosted_runtime_limit_waits(
    state: &AppState,
    policy: &LimitWaitPolicy,
) -> AnyResult<LimitWaitSweepReport> {
    let mut report = LimitWaitSweepReport::default();
    let pruned = match prune_finished_waits(state, policy).await {
        Ok(pruned) => pruned,
        Err(error) => {
            if error
                .downcast_ref::<tokio_postgres::Error>()
                .is_some_and(table_is_missing)
            {
                return Ok(report);
            }
            return Err(error);
        }
    };
    report.finished_waits += pruned;

    let mut handled: Vec<Uuid> = Vec::new();
    let mut handled_orgs: Vec<Uuid> = Vec::new();
    while (handled.len() as i64) < policy.batch_size {
        let Some(claim) = claim_due_waits(state, policy, 1, &handled, &handled_orgs)
            .await?
            .into_iter()
            .next()
        else {
            break;
        };
        let project_id = claim.project_id;
        let claim_token = claim.claim_token;
        handled.push(project_id);
        if let Some(org_id) = claim.org_id {
            if !handled_orgs.contains(&org_id) {
                handled_orgs.push(org_id);
            }
        }
        report.claimed += 1;
        if let Err(error) = process_claimed_wait(state, policy, claim, &mut report).await {
            warn!(%project_id, ?error, "failed to process a hosted runtime limit wait");
            // Leave the space for a later tick rather than for the claim TTL.
            let _ = release_claim(state, project_id, claim_token).await;
        }
    }
    Ok(report)
}

/// A wait is over once the space has a live hosted runtime (the user's own
/// ensure, a freed slot), once every waiting job has a live machine that would
/// run it (a desktop of the job's user taking unpinned work), or once it has
/// had no waiting work and no refusal for the whole give-up window. A refusal
/// can land a moment before dispatch queues the job it was for, so an empty
/// wait is not dropped straight away.
async fn prune_finished_waits(state: &AppState, policy: &LimitWaitPolicy) -> AnyResult<usize> {
    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for hosted runtime limit waits")?;
    let deleted = connection
        .execute(
            &format!(
                "delete from hosted_runtime_limit_waits w
                 where (w.claimed_until is null or w.claimed_until < now())
                   and (
                     {hosted_live}
                     or (
                       exists (select 1 from agent_jobs j where {waiting})
                       and not exists (select 1 from agent_jobs j where {unserved})
                     )
                     or (
                       {quiet}
                       and not exists (select 1 from agent_jobs j where {waiting})
                     )
                   )",
                hosted_live = hosted_runtime_is_live_in("w.project_id"),
                waiting = waiting_job_predicate("j", "w.project_id"),
                unserved = unserved_job_predicate("j", "w.project_id"),
                quiet = wait_is_quiet("$1"),
            ),
            &[&policy.give_up_after.as_secs_f64()],
        )
        .await?;
    Ok(deleted as usize)
}

/// Claim up to `limit` waits for this controller, skipping the spaces in
/// `exclude` (those this tick already handled). Only spaces with work no live
/// runtime would run are candidates, so waits recorded for spaces nobody sent
/// anything in never crowd out the ones that matter. Spaces holding a job past
/// the give-up window come first, then spaces of organizations not in
/// `handled_orgs`, then the longest-due.
///
/// The claim is the cross-replica single flight: `skip locked` keeps two
/// controllers from claiming the same row at once, and `claimed_until` keeps
/// the row away from every other controller until this one releases it or the
/// lease expires.
async fn claim_due_waits(
    state: &AppState,
    policy: &LimitWaitPolicy,
    limit: i64,
    exclude: &[Uuid],
    handled_orgs: &[Uuid],
) -> AnyResult<Vec<ClaimedWait>> {
    let connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection for hosted runtime limit waits")?;
    let rows = connection
        .query(
            &format!(
                "with candidates as (
                   select w.project_id,
                          p.org_id,
                          exists (
                            select 1 from agent_jobs j
                            where {unserved}
                              and {since} < now() - $2::double precision * interval '1 second'
                          ) as give_up_due
                   from hosted_runtime_limit_waits w
                   left join projects p on p.id = w.project_id
                   where (w.claimed_until is null or w.claimed_until < now())
                     and w.project_id <> all($4::uuid[])
                     and exists (select 1 from agent_jobs j where {unserved})
                     and (
                       w.next_attempt_at <= now()
                       or exists (
                         select 1 from agent_jobs j
                         where {unserved}
                           and {since} < now() - $2::double precision * interval '1 second'
                       )
                     )
                   order by give_up_due desc,
                            coalesce(p.org_id = any($5::uuid[]), false) asc,
                            w.next_attempt_at asc,
                            w.first_refused_at asc
                   limit $1
                   for update of w skip locked
                 )
                 update hosted_runtime_limit_waits w
                 set claimed_until = now() + $3::double precision * interval '1 second',
                     updated_at = now()
                 from candidates c
                 where w.project_id = c.project_id
                 returning w.project_id, c.org_id, w.ensure_request, w.attempts,
                           w.next_attempt_at <= now() as retry_due, w.last_error_code,
                           w.claimed_until",
                unserved = unserved_job_predicate("j", "w.project_id"),
                since = waiting_on_limit_since("j", "w.first_refused_at"),
            ),
            &[
                &limit.max(0),
                &policy.give_up_after.as_secs_f64(),
                &policy.claim_ttl.as_secs_f64(),
                &exclude,
                &handled_orgs,
            ],
        )
        .await
        .context("failed to claim hosted runtime limit waits")?;
    Ok(rows
        .into_iter()
        .map(|row| ClaimedWait {
            project_id: row.get("project_id"),
            org_id: row.get("org_id"),
            ensure_request: row.get::<_, PgJson<JsonValue>>("ensure_request").0,
            attempts: row.get("attempts"),
            retry_due: row.get("retry_due"),
            last_error_code: row.get("last_error_code"),
            claim_token: row.get("claimed_until"),
        })
        .collect())
}

async fn process_claimed_wait(
    state: &AppState,
    policy: &LimitWaitPolicy,
    claim: ClaimedWait,
    report: &mut LimitWaitSweepReport,
) -> AnyResult<()> {
    let project_id = claim.project_id;
    report.expired_jobs +=
        fail_waiting_jobs(state, policy, &claim, WaitingJobsFailure::GaveUp).await?;

    let (hosted_live, has_waiting_jobs, unserved_jobs) = {
        let connection = state
            .pool
            .get()
            .await
            .context("failed to acquire connection for a hosted runtime limit wait")?;
        let row = connection
            .query_one(
                &format!(
                    "select {} as hosted_live,
                            exists (select 1 from agent_jobs j where {}) as has_waiting_jobs,
                            (select count(*) from agent_jobs j where {}) as unserved_jobs",
                    hosted_runtime_is_live_in("$1"),
                    waiting_job_predicate("j", "$1"),
                    unserved_job_predicate("j", "$1"),
                ),
                &[&project_id],
            )
            .await
            .context("failed to inspect a hosted runtime limit wait")?;
        (
            row.get::<_, bool>("hosted_live"),
            row.get::<_, bool>("has_waiting_jobs"),
            row.get::<_, i64>("unserved_jobs"),
        )
    };

    if hosted_live || (has_waiting_jobs && unserved_jobs == 0) {
        // A machine that runs this work exists now (the user's own ensure, a
        // freed slot, a desktop of the job's user): the wait is over.
        finish_wait(state, project_id, claim.claim_token).await?;
        report.finished_waits += 1;
        return Ok(());
    }
    // Nothing left to start (the give-up just failed it, or a machine took
    // it), or not due yet: leave the wait to the prune and later ticks.
    if unserved_jobs == 0 || !claim.retry_due {
        release_claim(state, project_id, claim.claim_token).await?;
        return Ok(());
    }

    let request: LimitWaitEnsureRequest = match serde_json::from_value(claim.ensure_request.clone())
    {
        Ok(request) => request,
        Err(error) => {
            // Nothing can replay it, so nothing will start this work: say so
            // in the conversation rather than leave it queued forever.
            warn!(%project_id, %error, "unreadable hosted runtime limit wait; failing its work");
            report.refused_jobs += fail_waiting_jobs(
                state,
                policy,
                &claim,
                WaitingJobsFailure::Refused {
                    message: LIMIT_WAIT_REFUSED_FALLBACK_MESSAGE,
                },
            )
            .await?;
            finish_wait(state, project_id, claim.claim_token).await?;
            report.finished_waits += 1;
            return Ok(());
        }
    };

    report.attempted += 1;
    match super::ensure::ensure_runtime_for_limit_wait(state, project_id, &request).await {
        Ok(response) => {
            info!(
                %project_id,
                runtime_id = %response.runtime_id,
                lease_id = %response.lease_id,
                attempts = claim.attempts + 1,
                unserved_jobs,
                "started a hosted runtime for work queued behind the runtime limit"
            );
            finish_wait(state, project_id, claim.claim_token).await?;
            report.launched += 1;
            report.finished_waits += 1;
            // Open studios of that space refresh their runtime list now
            // instead of on their next poll.
            publish_controller_event(
                &state.events,
                "runtime.requested",
                Some(project_id),
                None,
                Uuid::parse_str(&response.runtime_id).ok(),
                None,
                json!({
                    "runtimeId": response.runtime_id,
                    "leaseId": response.lease_id,
                    "status": response.status,
                    "provider": response.provider,
                    "source": "runtime_limit_wait",
                }),
            );
        }
        Err(error) => {
            let (status, Json(api_error)) = &error;
            let limit = is_runtime_limit_refusal(&error);
            if !limit && !refusal_is_worth_retrying(*status) {
                // Waiting cannot fix this (credits, access, a deleted space,
                // a provider this controller no longer offers). The studio
                // promised the message would send or fail within the window,
                // so fail it now with the refusal's own reason, exactly as
                // the give-up does, instead of dropping the wait and leaving
                // the work queued with its reserve held.
                info!(
                    %project_id,
                    status = status.as_u16(),
                    code = ?api_error.code,
                    error = %api_error.message,
                    "hosted runtime limit wait ended: the launch was refused for another reason"
                );
                let message = refusal_message(&api_error.message);
                report.refused_jobs += fail_waiting_jobs(
                    state,
                    policy,
                    &claim,
                    WaitingJobsFailure::Refused { message: &message },
                )
                .await?;
                finish_wait(state, project_id, claim.claim_token).await?;
                report.finished_waits += 1;
                return Ok(());
            }
            let delay = policy.retry_delay(claim.attempts + 1);
            debug!(
                %project_id,
                status = status.as_u16(),
                code = ?api_error.code,
                attempts = claim.attempts + 1,
                retry_in_seconds = delay.as_secs(),
                "hosted runtime still unavailable for queued work; backing off"
            );
            let connection =
                state.pool.get().await.context(
                    "failed to acquire connection to back off a hosted runtime limit wait",
                )?;
            let error_code = api_error
                .code
                .clone()
                .unwrap_or_else(|| format!("http_{}", status.as_u16()));
            let error_message: String = api_error
                .message
                .chars()
                .take(MAX_RECORDED_ERROR_CHARS)
                .collect();
            connection
                .execute(
                    "update hosted_runtime_limit_waits
                     set attempts = attempts + 1,
                         next_attempt_at = now() + $2::double precision * interval '1 second',
                         last_attempt_at = now(),
                         last_refused_at = case when $3 then now() else last_refused_at end,
                         last_error_code = $4,
                         last_error = $5,
                         claimed_until = null,
                         updated_at = now()
                     where project_id = $1 and claimed_until = $6",
                    &[
                        &project_id,
                        &delay.as_secs_f64(),
                        &limit,
                        &error_code,
                        &error_message,
                        &claim.claim_token,
                    ],
                )
                .await
                .context("failed to back off a hosted runtime limit wait")?;
        }
    }
    Ok(())
}

/// The conversation reason for a refusal waiting cannot fix: the refusal's own
/// message (the ensure's user-facing text), bounded, or a plain fallback.
fn refusal_message(message: &str) -> String {
    let message: String = message
        .trim()
        .chars()
        .take(MAX_RECORDED_ERROR_CHARS)
        .collect();
    if message.is_empty() {
        LIMIT_WAIT_REFUSED_FALLBACK_MESSAGE.to_string()
    } else {
        message
    }
}

/// Clear this controller's claim, if it still holds it.
async fn release_claim(
    state: &AppState,
    project_id: Uuid,
    claim_token: DateTime<Utc>,
) -> AnyResult<()> {
    state
        .pool
        .get()
        .await
        .context("failed to acquire connection to release a hosted runtime limit wait")?
        .execute(
            "update hosted_runtime_limit_waits
             set claimed_until = null, updated_at = now()
             where project_id = $1 and claimed_until = $2",
            &[&project_id, &claim_token],
        )
        .await
        .context("failed to release a hosted runtime limit wait")?;
    Ok(())
}

/// End the wait this controller has claimed. A claim that lapsed and was
/// taken by another controller is left to that controller.
async fn finish_wait(
    state: &AppState,
    project_id: Uuid,
    claim_token: DateTime<Utc>,
) -> AnyResult<()> {
    state
        .pool
        .get()
        .await
        .context("failed to acquire connection to finish a hosted runtime limit wait")?
        .execute(
            "delete from hosted_runtime_limit_waits
             where project_id = $1 and claimed_until = $2",
            &[&project_id, &claim_token],
        )
        .await
        .context("failed to finish a hosted runtime limit wait")?;
    Ok(())
}

/// Why the sweep fails a space's waiting jobs.
enum WaitingJobsFailure<'a> {
    /// The jobs that waited the whole give-up window on the limit.
    GaveUp,
    /// Every job still waiting, because the replayed launch was refused for a
    /// reason waiting cannot fix; `message` is that refusal's own reason.
    Refused { message: &'a str },
}

/// Fail waiting jobs no live runtime could run, with a reason the person can
/// act on, instead of letting them wait forever: those past the give-up
/// window, or all of them when the launch was refused for good. Their runs
/// fail, an unused managed-AI reserve is refunded, the conversation gets a
/// failure message with a "Try again", and open studios hear about it. A job
/// a live machine would run (one that appeared while this space was claimed)
/// is left alone.
async fn fail_waiting_jobs(
    state: &AppState,
    policy: &LimitWaitPolicy,
    claim: &ClaimedWait,
    failure: WaitingJobsFailure<'_>,
) -> AnyResult<usize> {
    let project_id = claim.project_id;
    let (message, kind, outcome, overdue_after): (&str, &str, &str, Option<f64>) = match failure {
        WaitingJobsFailure::GaveUp => (
            match claim.last_error_code.as_deref() {
                None | Some(RUNTIME_LIMIT_REACHED_CODE) => LIMIT_WAIT_EXPIRED_MESSAGE,
                Some(_) => LIMIT_WAIT_EXPIRED_OTHER_MESSAGE,
            },
            "runtime_limit_wait_expired",
            "expired",
            Some(policy.give_up_after.as_secs_f64()),
        ),
        WaitingJobsFailure::Refused { message } => {
            (message, "runtime_limit_wait_refused", "failed", None)
        }
    };

    let mut connection = state
        .pool
        .get()
        .await
        .context("failed to acquire connection to fail jobs behind the runtime limit")?;
    let mut transaction = connection
        .transaction()
        .await
        .context("failed to start failing jobs behind the runtime limit")?;
    let rows = transaction
        .query(
            &format!(
                "update agent_jobs j
                 set status = 'failed',
                     outcome = $4,
                     error_message = $3,
                     completed_at = now(),
                     active_input_ready_runtime_id = null,
                     active_input_ready_expires_at = null,
                     active_input_ready_turn_id = null,
                     updated_at = now()
                 where {}
                   and ($2::double precision is null
                        or {} < now() - $2::double precision * interval '1 second')
                 returning j.id, j.project_id, j.run_id, j.conversation_id, j.session_id,
                           j.prompt_id, j.payload, j.error_message, j.lease_attempts",
                unserved_job_predicate("j", "$1"),
                // This controller holds the wait's claim, so the row is there;
                // were it gone, nothing would count as overdue.
                waiting_on_limit_since(
                    "j",
                    "coalesce((select w.first_refused_at from hosted_runtime_limit_waits w
                               where w.project_id = $1), now())"
                ),
            ),
            &[&project_id, &overdue_after, &message, &outcome],
        )
        .await
        .context("failed to fail jobs waiting on the runtime limit")?;
    if rows.is_empty() {
        transaction
            .rollback()
            .await
            .context("failed to close an empty runtime limit wait failure")?;
        return Ok(0);
    }

    let settled =
        super::sweeps::settle_expired_queued_jobs(&mut transaction, &rows, "runtime limit").await?;

    let mut conversation_messages = Vec::new();
    for row in &rows {
        let Some(conversation_id) = row.get::<_, Option<Uuid>>("conversation_id") else {
            continue;
        };
        let job_id: Uuid = row.get("id");
        let run_id: Option<Uuid> = row.get("run_id");
        let payload = row.get::<_, PgJson<JsonValue>>("payload").0;
        let metadata = json!({
            "source": "controller",
            "kind": kind,
            "outcome": "failed",
            "messageType": "error",
            "jobId": job_id,
            "runId": run_id,
            "errorMessage": message,
            "agent": payload.pointer("/metadata/agent").cloned(),
        });
        let recorded = crate::conversations::record_controller_assistant_message(
            &transaction,
            &project_id,
            &conversation_id,
            row.get("session_id"),
            row.get("prompt_id"),
            run_id,
            message,
            &metadata,
        )
        .await
        .map_err(|(status, Json(error))| {
            anyhow::anyhow!(
                "failed to record the runtime limit wait failure message ({status}): {}",
                error.message
            )
        })?;
        conversation_messages.push(recorded);
    }

    transaction
        .commit()
        .await
        .context("failed to commit failing jobs behind the runtime limit")?;
    drop(connection);

    crate::send_intents::publish_job_input_state_updates(state, &settled.job_input_state_updates);
    super::sweeps::publish_credits_updated_for_orgs(state, settled.refunded_org_ids).await;
    for message_row in &conversation_messages {
        crate::conversations::publish_conversation_message_event(&state.events, message_row);
        crate::notifications::enqueue_message_push_notifications(
            state.clone(),
            message_row.clone(),
        );
    }

    let mut conversations = std::collections::BTreeSet::new();
    for row in &rows {
        let job_id: Uuid = row.get("id");
        let run_id: Option<Uuid> = row.get("run_id");
        let conversation_id: Option<Uuid> = row.get("conversation_id");
        info!(
            %job_id,
            %project_id,
            kind,
            "failed a job waiting on the hosted runtime limit"
        );
        if let Some(run_id) = run_id {
            publish_failed_run(
                state,
                project_id,
                run_id,
                job_id,
                conversation_id,
                outcome,
                message,
            )
            .await;
        }
        if let Some(conversation_id) = conversation_id {
            conversations.insert(conversation_id);
        }
    }
    // Whatever was queued behind the failed turn may go now.
    for conversation_id in conversations {
        crate::send_queue::spawn_send_queue_drain(state.clone(), conversation_id);
    }
    Ok(rows.len())
}

async fn publish_failed_run(
    state: &AppState,
    project_id: Uuid,
    run_id: Uuid,
    job_id: Uuid,
    conversation_id: Option<Uuid>,
    outcome: &str,
    message: &str,
) {
    let snapshot = match state.pool.get().await {
        Ok(mut connection) => crate::runs::load_run_snapshot(&mut *connection, &run_id)
            .await
            .ok()
            .flatten(),
        Err(_) => None,
    };
    let (session_id, conversation_id, run_payload) = match snapshot.as_ref() {
        Some(snapshot) => (
            snapshot.session_id,
            snapshot.conversation_id.or(conversation_id),
            crate::runs::run_snapshot_to_json(snapshot),
        ),
        None => (None, conversation_id, JsonValue::Null),
    };
    crate::publish_controller_event_with_conversation(
        &state.events,
        "run.completed",
        Some(project_id),
        session_id,
        conversation_id,
        Some(run_id),
        Some(job_id),
        json!({
            "outcome": outcome,
            "finalStatus": "failed",
            "runStatus": "failed",
            "errorMessage": message,
            "run": run_payload,
        }),
    );
}

#[cfg(test)]
#[path = "limit_waits_tests.rs"]
mod db_tests;

#[cfg(test)]
mod policy_tests {
    use super::*;

    #[test]
    fn retry_delay_doubles_from_the_base_and_stops_at_the_cap() {
        let policy = LimitWaitPolicy::default();
        let delays: Vec<u64> = (0..7).map(|n| policy.retry_delay(n).as_secs()).collect();
        assert_eq!(delays, vec![30, 60, 120, 240, 300, 300, 300]);
        assert_eq!(policy.retry_delay(-3).as_secs(), 30);
        assert_eq!(policy.retry_delay(i32::MAX).as_secs(), 300);
    }

    #[test]
    fn only_the_organization_limit_counts_as_a_limit_refusal() {
        let limit = (
            StatusCode::PAYMENT_REQUIRED,
            Json(ApiError::with_details(
                "limit",
                RUNTIME_LIMIT_REACHED_CODE,
                json!({}),
            )),
        );
        let credits = (
            StatusCode::PAYMENT_REQUIRED,
            Json(ApiError::with_details(
                "credits",
                "insufficient_credits",
                json!({}),
            )),
        );
        assert!(is_runtime_limit_refusal(&limit));
        assert!(!is_runtime_limit_refusal(&credits));
    }

    #[test]
    fn stored_request_drops_oversized_metadata() {
        let request = LimitWaitEnsureRequest {
            provider: "instafy_cloud_limit_wait_test".to_string(),
            runtime_id: None,
            idle_ttl_seconds: 600,
            display_name: Some("Hosted Runtime".to_string()),
            metadata: Some(json!({ "blob": "x".repeat(MAX_RECORDED_REQUEST_BYTES * 2) })),
            scope: Some("exclusive".to_string()),
            origin_mode: Some("hosted".to_string()),
            origin_protocols: vec!["http".to_string()],
        };
        let stored = request.to_stored_json();
        assert!(stored.to_string().len() <= MAX_RECORDED_REQUEST_BYTES);
        assert_eq!(stored["metadata"], JsonValue::Null);
        assert_eq!(stored["displayName"], json!("Hosted Runtime"));
    }
}
