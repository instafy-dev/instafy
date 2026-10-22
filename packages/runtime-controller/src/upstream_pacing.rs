//! Team plan agents of every space start in step with what their AI upstream can take.
//!
//! The lanes of all teams on one upstream (a person's own credential, or the platform's model
//! proxy) share its rate limit. When several teams start at once, some twenty lanes send their
//! first and largest request within seconds; half of them stopped on a short upstream rate limit,
//! and of those started again after the stated wait a third stopped on it again (four itinerary
//! teams at once, run r7-ltb). Rather than retry harder, the controller paces when plan agents
//! start, per upstream:
//!
//! - **Cooldown.** A run that stops on the provider rate-limit kind
//!   (`agent::is_provider_rate_limited_failure`) states a wait ("try again in 24.5s"). Until it
//!   has passed, no plan agent of that upstream starts. Any job's rate limit sets it.
//! - **Ceiling.** A plan agent's rate limit also sets how many plan agents of that upstream may
//!   run at once: half of those running then (at least one), lowered at most once per congestion
//!   event. The rate limit of a lead or an ordinary turn never lowers it: those are not paced, and
//!   one of them stopping says nothing about how many lanes fit. Each plan agent that ends without
//!   a rate limit raises the ceiling by one over the ceiling (so by one per ceiling's worth of
//!   agents: additive increase, multiplicative decrease). Of the ceiling, at most half (at least
//!   one) may start within [`START_WINDOW`], so a queue that opens is spread out too.
//! - **Memory.** What is learned holds for [`MEMORY`] after the last rate limit; then the upstream
//!   is open again. A deployment whose upstream is small (a personal plan) can set a fixed ceiling,
//!   `INSTAFY_UPSTREAM_PLAN_WORKER_CEILING`, that holds from the first burst on.
//!
//! What a rate limit says is read from the error a job's runtime reported, so on the platform's
//! shared upstream one space has a bounded say: its reports pace its own plan agents
//! (`platform:project:<id>`), and they pace every space's (`platform`) only when another space
//! reported a rate limit within [`CORROBORATION_WINDOW`]. A person's own credential is paced by
//! its own jobs alone.
//!
//! A held agent stays queued: its group stays open, the lead is not woken, and a runtime polling
//! for work leases it as soon as the upstream has room. Only plan agents are held (a team's lanes,
//! its follow-on agent, their continuations and retries); a lead or an ordinary turn always
//! starts, so coordination never waits behind its own lanes. Admission is serialized per upstream
//! across spaces and controller processes by an advisory lock, taken only by a lease that has a
//! plan agent to consider on an upstream something was learned about.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use tokio_postgres::Transaction;
use tracing::{info, warn};
use uuid::Uuid;

use crate::config::PgPool;
use crate::{internal_error, ApiError};

/// The upstream of a job row: its own credential, else the platform's model proxy. Used as
/// `upstream_key_sql("aj")`.
pub(crate) fn upstream_key_sql(alias: &str) -> String {
    format!("coalesce('credential:' || {alias}.credential_id::text, 'platform')")
}

/// The platform upstream's key.
const PLATFORM_KEY: &str = "platform";

/// What one space's own reports taught about the platform's upstream: it paces that space's plan
/// agents only.
pub(crate) fn platform_project_key(project_id: &Uuid) -> String {
    format!("platform:project:{project_id}")
}

/// A job row (alias `aj`) that is a plan agent the pacing may hold: a team's lane or follow-on
/// agent, never a lead.
const PLAN_AGENT_SQL: &str =
    "coalesce(aj.agent_role, aj.payload #>> '{metadata,multiAgentPlan,role}', '') = 'worker'";

/// How long what was learned about an upstream holds after its last rate limit.
pub(crate) const MEMORY: Duration = Duration::from_secs(60 * 60);
/// Starts counted against half the ceiling.
pub(crate) const START_WINDOW: Duration = Duration::from_secs(10);
/// One rate limit lowers the ceiling at most once in this long: the lanes of one burst that stop
/// together are one congestion event.
const DECREASE_GAP: Duration = Duration::from_secs(30);
/// A platform rate limit one space reports paces every space only when another space reported one
/// this recently.
pub(crate) const CORROBORATION_WINDOW: Duration = Duration::from_secs(60);
/// A stated wait is kept to this; a rate limit that names none waits [`DEFAULT_COOLDOWN`].
const MAX_COOLDOWN: Duration = Duration::from_secs(60);
const DEFAULT_COOLDOWN: Duration = Duration::from_secs(10);
/// The ceiling never grows past this (it then binds nothing anyway); an upstream only a lead's or
/// an ordinary turn's rate limit was learned from has it.
const MAX_CEILING: f64 = 1_000.0;
const FIXED_CEILING_ENV: &str = "INSTAFY_UPSTREAM_PLAN_WORKER_CEILING";

/// The fixed ceiling a deployment set, if any.
fn fixed_ceiling() -> Option<i32> {
    parse_fixed_ceiling(std::env::var(FIXED_CEILING_ENV).ok().as_deref())
}

fn parse_fixed_ceiling(value: Option<&str>) -> Option<i32> {
    value?
        .trim()
        .parse::<i32>()
        .ok()
        .filter(|ceiling| *ceiling > 0)
}

/// Whether a controller that runs before the `upstream_pacing` migration has said so once.
static TABLE_MISSING_LOGGED: AtomicBool = AtomicBool::new(false);

/// The upstreams (`upstream_key_sql`) whose plan agents of this space may not start now. Empty,
/// and no lock taken, when the space has no plan agent waiting or nothing was learned about their
/// upstreams; empty too, with a warning, before the `upstream_pacing` migration. Call it inside the
/// lease transaction: the advisory locks it takes hold until that transaction ends, so two leases
/// cannot both take the last place.
pub(crate) async fn closed_upstreams(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
) -> Result<Vec<String>, (StatusCode, Json<ApiError>)> {
    let waiting = transaction
        .query_one(
            &format!(
                "select coalesce(array_agg(distinct {key}), '{{}}'::text[]) as keys,
                        to_regclass('upstream_pacing') is not null as migrated
                 from agent_jobs aj
                 where aj.project_id = $1 and aj.status = 'queued' and {PLAN_AGENT_SQL}",
                key = upstream_key_sql("aj"),
            ),
            &[project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to look for waiting plan agents: {error:?}"))
        })?;
    let mut keys: Vec<String> = waiting.get("keys");
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    if !waiting.get::<_, bool>("migrated") {
        if !TABLE_MISSING_LOGGED.swap(true, Ordering::Relaxed) {
            warn!("upstream_pacing is not migrated yet: plan agents start unpaced");
        }
        return Ok(Vec::new());
    }
    let project_key = platform_project_key(project_id);
    let fixed = fixed_ceiling();
    if fixed.is_none() {
        let mut rows = keys.clone();
        rows.push(project_key.clone());
        let learned: bool = transaction
            .query_one(
                "select exists (
                     select 1 from upstream_pacing
                     where upstream_key = any($1)
                       and last_rate_limited_at > statement_timestamp() - $2::double precision * interval '1 second'
                 )",
                &[&rows, &MEMORY.as_secs_f64()],
            )
            .await
            .map_err(|error| internal_error(format!("failed to read upstream pacing: {error:?}")))?
            .get(0);
        if !learned {
            return Ok(Vec::new());
        }
    }
    // One lock per upstream, always taken in the same order.
    keys.sort();
    for key in &keys {
        transaction
            .query_one(
                "select pg_advisory_xact_lock(hashtextextended($1, 0))",
                &[&format!("upstream-pacing-admission:{key}")],
            )
            .await
            .map_err(|error| {
                internal_error(format!("failed to lock upstream pacing: {error:?}"))
            })?;
    }
    let rows = transaction
        .query(
            &format!(
                "with scopes (job_key, row_key, project_scoped) as (
                     select key, key, false from unnest($1::text[]) as key
                     union all
                     select '{PLATFORM_KEY}', $2::text, true where '{PLATFORM_KEY}' = any($1::text[])
                 ), counts as (
                     select scopes.job_key, scopes.row_key, scopes.project_scoped,
                            count(aj.id) as running,
                            count(aj.id) filter (
                                where aj.leased_at > statement_timestamp() - $5::double precision * interval '1 second'
                            ) as starting
                     from scopes
                     left join agent_jobs aj
                       on aj.status = 'leased'
                      and aj.lease_expires_at > statement_timestamp()
                      and {PLAN_AGENT_SQL}
                      and {key} = scopes.job_key
                      and (not scopes.project_scoped or aj.project_id = $3)
                     group by scopes.job_key, scopes.row_key, scopes.project_scoped
                 )
                 select distinct counts.job_key
                 from counts
                 left join upstream_pacing learned
                   on learned.upstream_key = counts.row_key
                  and learned.last_rate_limited_at > statement_timestamp() - $4::double precision * interval '1 second'
                 cross join lateral (
                     select case when counts.project_scoped then floor(learned.ceiling)::int
                                 else least(floor(learned.ceiling)::int, $6::int) end as ceiling
                 ) limit_now
                 where coalesce(learned.cooldown_until > statement_timestamp(), false)
                    or (
                        limit_now.ceiling is not null
                        and (counts.running >= limit_now.ceiling
                             or counts.starting >= greatest(1, (limit_now.ceiling + 1) / 2))
                    )",
                key = upstream_key_sql("aj"),
            ),
            &[
                &keys,
                &project_key,
                project_id,
                &MEMORY.as_secs_f64(),
                &START_WINDOW.as_secs_f64(),
                &fixed,
            ],
        )
        .await
        .map_err(|error| internal_error(format!("failed to read upstream pacing: {error:?}")))?;
    Ok(rows.iter().map(|row| row.get::<_, String>(0)).collect())
}

/// What the controller knows about one upstream.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Learned {
    pub(crate) cooldown_until: Option<DateTime<Utc>>,
    pub(crate) ceiling: f64,
    pub(crate) last_rate_limited_at: DateTime<Utc>,
    pub(crate) decreased_at: DateTime<Utc>,
}

fn gap(duration: Duration) -> chrono::Duration {
    chrono::Duration::from_std(duration).unwrap_or_default()
}

/// The cooldown after a rate limit that states `wait`: the longest wait still running holds.
fn cooldown_after(
    remembered: Option<&Learned>,
    now: DateTime<Utc>,
    wait: Duration,
) -> Option<DateTime<Utc>> {
    let until = now + gap(wait.min(MAX_COOLDOWN));
    Some(
        remembered
            .and_then(|learned| learned.cooldown_until)
            .map_or(until, |earlier| earlier.max(until)),
    )
}

/// After a plan agent of this upstream stopped on a rate limit that states `wait`, while `running`
/// of its plan agents still run: no start before the wait has passed, and half as many at once
/// (once per congestion event; what was forgotten starts again from those running).
pub(crate) fn after_rate_limit(
    previous: Option<&Learned>,
    now: DateTime<Utc>,
    wait: Duration,
    running: i64,
) -> Learned {
    let remembered = previous.filter(|learned| remembered(learned, now));
    // The plan agent that stopped was one of them.
    let concurrent = (running.max(0) + 1) as f64;
    let (ceiling, decreased_at) = match remembered {
        Some(learned) if now - learned.decreased_at < gap(DECREASE_GAP) => {
            (learned.ceiling, learned.decreased_at)
        }
        Some(learned) => (
            (learned.ceiling.min(concurrent) / 2.0).floor().max(1.0),
            now,
        ),
        None => ((concurrent / 2.0).floor().max(1.0), now),
    };
    Learned {
        cooldown_until: cooldown_after(remembered, now, wait),
        ceiling,
        last_rate_limited_at: now,
        decreased_at,
    }
}

/// After a lead or an ordinary turn of this upstream stopped on a rate limit that states `wait`:
/// no plan agent starts before the wait has passed, and the ceiling stays what it was (none, when
/// nothing was learned).
pub(crate) fn after_other_rate_limit(
    previous: Option<&Learned>,
    now: DateTime<Utc>,
    wait: Duration,
) -> Learned {
    let remembered = previous.filter(|learned| remembered(learned, now));
    Learned {
        cooldown_until: cooldown_after(remembered, now, wait),
        ceiling: remembered.map_or(MAX_CEILING, |learned| learned.ceiling),
        last_rate_limited_at: now,
        // a plan agent's rate limit right after this one still lowers the ceiling
        decreased_at: remembered.map_or(now - gap(DECREASE_GAP), |learned| learned.decreased_at),
    }
}

/// After a plan agent of this upstream ended without a rate limit: one more over the ceiling.
/// Nothing once what was learned is forgotten.
pub(crate) fn after_success(learned: &Learned, now: DateTime<Utc>) -> Option<Learned> {
    if !remembered(learned, now) {
        return None;
    }
    Some(Learned {
        ceiling: (learned.ceiling + 1.0 / learned.ceiling).min(MAX_CEILING),
        ..learned.clone()
    })
}

fn remembered(learned: &Learned, now: DateTime<Utc>) -> bool {
    now - learned.last_rate_limited_at < gap(MEMORY)
}

/// The wait a provider rate limit states ("try again in 24.535s"), kept to [`MAX_COOLDOWN`]; a
/// rate limit that states none waits [`DEFAULT_COOLDOWN`]. None when `error` is not the provider
/// rate-limit kind (a spent plan or quota, auth, any other failure).
pub(crate) fn rate_limit_cooldown(error: &str) -> Option<Duration> {
    if !crate::agent::is_provider_rate_limited_failure(error) {
        return None;
    }
    let stated = crate::multi_agent_plan::stated_rate_limit_wait(error)
        .filter(|wait| !wait.is_zero())
        .unwrap_or(DEFAULT_COOLDOWN);
    Some(stated.min(MAX_COOLDOWN))
}

/// How a job's end teaches the pacing.
#[derive(Debug, Clone, Copy, PartialEq)]
enum JobEnd {
    RateLimited {
        wait: Duration,
        plan_agent: bool,
    },
    /// A plan agent that ended without a rate limit.
    Succeeded,
}

/// Teach the pacing how a job that just ended went: a rate limit of its upstream (any job), or a
/// plan agent that ended without one. Errors are logged, never returned: a completion does not
/// fail on its pacing.
pub(crate) async fn record_job_end(pool: &PgPool, job_id: Uuid) {
    if let Err(error) = record_job_end_inner(pool, job_id).await {
        warn!(%job_id, %error, "could not record the job's end for upstream pacing");
    }
}

async fn record_job_end_inner(pool: &PgPool, job_id: Uuid) -> anyhow::Result<()> {
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let Some(job) = transaction
        .query_opt(
            &format!(
                "select {key} as upstream_key, aj.project_id, aj.status, aj.error_message,
                        {PLAN_AGENT_SQL} as plan_agent
                 from agent_jobs aj where aj.id = $1",
                key = upstream_key_sql("aj"),
            ),
            &[&job_id],
        )
        .await?
    else {
        return Ok(());
    };
    let upstream_key: String = job.get("upstream_key");
    let project_id: Uuid = job.get("project_id");
    let status: String = job.get("status");
    let plan_agent: bool = job.get("plan_agent");
    let cooldown = (status == "failed")
        .then(|| job.get::<_, Option<String>>("error_message"))
        .flatten()
        .and_then(|error| rate_limit_cooldown(&error));
    let end = match cooldown {
        Some(wait) => JobEnd::RateLimited { wait, plan_agent },
        None if plan_agent && status == "completed" => JobEnd::Succeeded,
        None => return Ok(()),
    };
    // The rows this end teaches, each with the plan agents it counts: a credential's own, or on
    // the platform's upstream this space's and, when vouched for, every space's.
    let mut scopes: Vec<(String, Option<Uuid>)> = Vec::new();
    if upstream_key == PLATFORM_KEY {
        scopes.push((platform_project_key(&project_id), Some(project_id)));
        let shared = match end {
            JobEnd::Succeeded => true,
            JobEnd::RateLimited { .. } => {
                let vouched: bool = transaction
                    .query_one(
                        "select exists (
                             select 1 from upstream_pacing
                             where upstream_key like 'platform:project:%'
                               and upstream_key <> $1
                               and last_rate_limited_at > now() - $2::double precision * interval '1 second'
                         )",
                        &[
                            &platform_project_key(&project_id),
                            &CORROBORATION_WINDOW.as_secs_f64(),
                        ],
                    )
                    .await?
                    .get(0);
                if !vouched {
                    info!(
                        %job_id,
                        %project_id,
                        "a platform rate limit paces this space's plan agents; no other space reported one"
                    );
                }
                vouched
            }
        };
        if shared {
            scopes.push((PLATFORM_KEY.to_string(), None));
        }
    } else {
        scopes.push((upstream_key.clone(), None));
    }
    let now: DateTime<Utc> = transaction.query_one("select now()", &[]).await?.get(0);
    for (row_key, only_project) in scopes {
        transaction
            .query_one(
                "select pg_advisory_xact_lock(hashtextextended($1, 0))",
                &[&format!("upstream-pacing:{row_key}")],
            )
            .await?;
        let previous = transaction
            .query_opt(
                "select cooldown_until, ceiling, last_rate_limited_at, decreased_at
                 from upstream_pacing where upstream_key = $1",
                &[&row_key],
            )
            .await?
            .map(|row| Learned {
                cooldown_until: row.get("cooldown_until"),
                ceiling: row.get("ceiling"),
                last_rate_limited_at: row.get("last_rate_limited_at"),
                decreased_at: row.get("decreased_at"),
            });
        let next = match end {
            JobEnd::RateLimited {
                wait,
                plan_agent: true,
            } => {
                let running: i64 = transaction
                    .query_one(
                        &format!(
                            "select count(*) from agent_jobs aj
                             where aj.status = 'leased' and aj.lease_expires_at > now()
                               and {PLAN_AGENT_SQL} and {key} = $1
                               and ($2::uuid is null or aj.project_id = $2)",
                            key = upstream_key_sql("aj"),
                        ),
                        &[&upstream_key, &only_project],
                    )
                    .await?
                    .get(0);
                let next = after_rate_limit(previous.as_ref(), now, wait, running);
                info!(
                    %job_id,
                    %project_id,
                    upstream = %row_key,
                    wait_ms = wait.as_millis() as u64,
                    running,
                    ceiling = next.ceiling,
                    "a plan agent's upstream rate limit paces its upstream's plan agents"
                );
                next
            }
            JobEnd::RateLimited {
                wait,
                plan_agent: false,
            } => {
                info!(
                    %job_id,
                    %project_id,
                    upstream = %row_key,
                    wait_ms = wait.as_millis() as u64,
                    "an upstream rate limit holds its plan agents for the stated wait"
                );
                after_other_rate_limit(previous.as_ref(), now, wait)
            }
            JobEnd::Succeeded => match previous
                .as_ref()
                .and_then(|learned| after_success(learned, now))
            {
                Some(next) => next,
                None => continue,
            },
        };
        transaction
            .execute(
                "insert into upstream_pacing
                     (upstream_key, cooldown_until, ceiling, last_rate_limited_at, decreased_at, updated_at)
                 values ($1, $2, $3, $4, $5, now())
                 on conflict (upstream_key) do update set
                     cooldown_until = excluded.cooldown_until,
                     ceiling = excluded.ceiling,
                     last_rate_limited_at = excluded.last_rate_limited_at,
                     decreased_at = excluded.decreased_at,
                     updated_at = now()",
                &[
                    &row_key,
                    &next.cooldown_until,
                    &next.ceiling,
                    &next.last_rate_limited_at,
                    &next.decreased_at,
                ],
            )
            .await?;
    }
    transaction.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE_LIMITED: &str = "rate limit exceeded: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 24.535s.";

    fn at(seconds: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000 + seconds, 0).expect("time")
    }

    #[test]
    fn a_rate_limit_states_the_cooldown_and_other_failures_none() {
        assert_eq!(
            rate_limit_cooldown(RATE_LIMITED),
            Some(Duration::from_millis(24_535))
        );
        assert_eq!(
            rate_limit_cooldown("exceeded retry limit, last status: 429 Too Many Requests"),
            Some(DEFAULT_COOLDOWN),
            "a rate limit that names no wait"
        );
        assert_eq!(
            rate_limit_cooldown(
                "rate limit exceeded: The upstream provider rate limit was reached (upstream_rate_limit, 429). Please try again in 169s."
            ),
            Some(MAX_COOLDOWN)
        );
        for other in [
            "You\u{2019}ve hit your usage limit for GPT-5. Upgrade to Pro, or try again in 3 days 2 hours.",
            "rate limit exceeded: insufficient_quota (upstream_rate_limit, 429). Please try again in 7s.",
            "unexpected status 401 Unauthorized: Please try again in 7s.",
            "Codex run timed out",
        ] {
            assert_eq!(rate_limit_cooldown(other), None, "{other}");
        }
    }

    #[test]
    fn one_burst_halves_the_ceiling_once_and_waits_out_the_longest_stated_wait() {
        // 22 lanes of four teams started together; the first of them stops with 21 still running
        let first = after_rate_limit(None, at(0), Duration::from_secs(24), 21);
        assert_eq!(first.ceiling, 11.0);
        assert_eq!(first.cooldown_until, Some(at(24)));
        // ten more stop within the same seconds: one congestion event
        let mut learned = first.clone();
        for (offset, running) in (1..=10).zip((11..21).rev()) {
            learned = after_rate_limit(Some(&learned), at(offset), Duration::from_secs(2), running);
        }
        assert_eq!(learned.ceiling, 11.0, "lowered once per event");
        assert_eq!(
            learned.cooldown_until,
            Some(at(24)),
            "the longest wait holds"
        );
        assert_eq!(learned.decreased_at, at(0));
        // a stop well after the event lowers it again, from what still runs
        let later = after_rate_limit(Some(&learned), at(120), Duration::from_secs(5), 7);
        assert_eq!(later.ceiling, 4.0);
        assert_eq!(later.cooldown_until, Some(at(125)));
        // never below one
        let alone = after_rate_limit(Some(&later), at(400), Duration::from_secs(5), 0);
        assert_eq!(alone.ceiling, 1.0);
    }

    #[test]
    fn agents_that_end_without_a_rate_limit_raise_the_ceiling_by_one_per_ceiling() {
        let learned = after_rate_limit(None, at(0), Duration::from_secs(5), 9);
        assert_eq!(learned.ceiling, 5.0);
        let mut grown = learned.clone();
        for _ in 0..5 {
            grown = after_success(&grown, at(60)).expect("remembered");
        }
        assert!((5.9..6.1).contains(&grown.ceiling), "{}", grown.ceiling);
        // forgotten an hour after the last rate limit: nothing to raise, and the next rate limit
        // starts again from those running
        assert_eq!(after_success(&grown, at(3_600)), None);
        let fresh = after_rate_limit(Some(&grown), at(3_601), Duration::from_secs(5), 30);
        assert_eq!(fresh.ceiling, 15.0);
        assert_eq!(fresh.cooldown_until, Some(at(3_606)));
    }

    #[test]
    fn a_leads_or_an_ordinary_turns_rate_limit_holds_for_its_wait_and_never_lowers_the_ceiling() {
        // nothing learned yet: the wait, and no ceiling to speak of
        let first = after_other_rate_limit(None, at(0), Duration::from_secs(24));
        assert_eq!(first.cooldown_until, Some(at(24)));
        assert_eq!(first.ceiling, MAX_CEILING);
        // a ceiling learned from lanes stays as it was
        let lanes = after_rate_limit(None, at(0), Duration::from_secs(5), 9);
        assert_eq!(lanes.ceiling, 5.0);
        let held = after_other_rate_limit(Some(&lanes), at(100), Duration::from_secs(5));
        assert_eq!(held.ceiling, 5.0);
        assert_eq!(held.decreased_at, at(0));
        assert_eq!(held.cooldown_until, Some(at(105)));
        // a lane's rate limit right after an ordinary turn's still lowers it, from those running
        let lane = after_rate_limit(Some(&first), at(2), Duration::from_secs(5), 7);
        assert_eq!(lane.ceiling, 4.0);
        assert_eq!(lane.cooldown_until, Some(at(24)), "the longer wait holds");
    }

    #[test]
    fn a_fixed_ceiling_is_a_positive_number() {
        assert_eq!(parse_fixed_ceiling(Some(" 8 ")), Some(8));
        assert_eq!(parse_fixed_ceiling(Some("0")), None);
        assert_eq!(parse_fixed_ceiling(Some("-2")), None);
        assert_eq!(parse_fixed_ceiling(Some("many")), None);
        assert_eq!(parse_fixed_ceiling(None), None);
    }
}
