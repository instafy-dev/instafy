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
//!   has passed, no plan agent of that upstream starts.
//! - **Ceiling.** The same stop sets how many plan agents of that upstream may run at once: half of
//!   those running then (at least one), lowered at most once per congestion event. Each plan agent
//!   that ends without a rate limit raises it by one over the ceiling (so by one per ceiling's
//!   worth of agents: additive increase, multiplicative decrease). Of the ceiling, at most half (at
//!   least one) may start within [`START_WINDOW`], so a queue that opens is spread out too.
//! - **Memory.** What is learned holds for [`MEMORY`] after the last rate limit; then the upstream
//!   is open again. A deployment whose upstream is small (a personal plan) can set a fixed ceiling,
//!   `INSTAFY_UPSTREAM_PLAN_WORKER_CEILING`, that holds from the first burst on.
//!
//! A held agent stays queued: its group stays open, the lead is not woken, and a runtime polling
//! for work leases it as soon as the upstream has room. Only plan agents are held (a team's lanes,
//! its follow-on agent, their continuations and retries); a lead or an ordinary turn always
//! starts, so coordination never waits behind its own lanes, but its rate limits teach the pacing
//! as well. Admission is serialized across spaces and controller processes by one advisory lock,
//! taken only by a lease that has a plan agent to consider.

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
/// A stated wait is kept to this; a rate limit that names none waits [`DEFAULT_COOLDOWN`].
const MAX_COOLDOWN: Duration = Duration::from_secs(60);
const DEFAULT_COOLDOWN: Duration = Duration::from_secs(10);
/// The ceiling never grows past this (it then binds nothing anyway).
const MAX_CEILING: f64 = 1_000.0;
const ADMISSION_LOCK_KEY: &str = "upstream-pacing:admission";
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

/// The upstreams whose plan agents may not start now. Empty, and no lock taken, when the space has
/// no plan agent waiting. Call it inside the lease transaction: the advisory lock it takes holds
/// until that transaction ends, so two leases cannot both take the last place.
pub(crate) async fn closed_upstreams(
    transaction: &Transaction<'_>,
    project_id: &Uuid,
) -> Result<Vec<String>, (StatusCode, Json<ApiError>)> {
    let waiting: bool = transaction
        .query_one(
            &format!(
                "select exists (
                     select 1 from agent_jobs aj
                     where aj.project_id = $1 and aj.status = 'queued' and {PLAN_AGENT_SQL}
                 )"
            ),
            &[project_id],
        )
        .await
        .map_err(|error| {
            internal_error(format!("failed to look for waiting plan agents: {error:?}"))
        })?
        .get(0);
    if !waiting {
        return Ok(Vec::new());
    }
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&ADMISSION_LOCK_KEY],
        )
        .await
        .map_err(|error| internal_error(format!("failed to lock upstream pacing: {error:?}")))?;
    let rows = transaction
        .query(
            &format!(
                "with active as (
                     select {key} as upstream_key,
                            count(*) as running,
                            count(*) filter (
                                where aj.leased_at > statement_timestamp() - $3::double precision * interval '1 second'
                            ) as starting
                     from agent_jobs aj
                     where aj.status = 'leased'
                       and aj.lease_expires_at > statement_timestamp()
                       and {PLAN_AGENT_SQL}
                     group by 1
                 ), learned as (
                     select upstream_key, cooldown_until, floor(ceiling)::int as ceiling
                     from upstream_pacing
                     where last_rate_limited_at > statement_timestamp() - $2::double precision * interval '1 second'
                 ), limits as (
                     select coalesce(learned.upstream_key, active.upstream_key) as upstream_key,
                            learned.cooldown_until,
                            least(learned.ceiling, $1::int) as ceiling,
                            coalesce(active.running, 0) as running,
                            coalesce(active.starting, 0) as starting
                     from learned
                     full join active on active.upstream_key = learned.upstream_key
                 )
                 select upstream_key from limits
                 where coalesce(cooldown_until > statement_timestamp(), false)
                    or (
                        ceiling is not null
                        and (running >= ceiling or starting >= greatest(1, (ceiling + 1) / 2))
                    )",
                key = upstream_key_sql("aj"),
            ),
            &[
                &fixed_ceiling(),
                &MEMORY.as_secs_f64(),
                &START_WINDOW.as_secs_f64(),
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

/// After a run of this upstream stopped on a rate limit that states `wait`, while `running` of its
/// plan agents still run: no start before the wait has passed, and half as many at once (once per
/// congestion event; what was forgotten starts again from those running).
pub(crate) fn after_rate_limit(
    previous: Option<&Learned>,
    now: DateTime<Utc>,
    wait: Duration,
    running: i64,
) -> Learned {
    let wait = chrono::Duration::from_std(wait.min(MAX_COOLDOWN)).unwrap_or_default();
    let remembered = previous.filter(|learned| remembered(learned, now));
    // The run that stopped was one of them.
    let concurrent = (running.max(0) + 1) as f64;
    let (ceiling, decreased_at) = match remembered {
        Some(learned)
            if now - learned.decreased_at
                < chrono::Duration::from_std(DECREASE_GAP).unwrap_or_default() =>
        {
            (learned.ceiling, learned.decreased_at)
        }
        Some(learned) => (
            (learned.ceiling.min(concurrent) / 2.0).floor().max(1.0),
            now,
        ),
        None => ((concurrent / 2.0).floor().max(1.0), now),
    };
    let cooldown_until = now + wait;
    Learned {
        cooldown_until: Some(
            remembered
                .and_then(|learned| learned.cooldown_until)
                .map_or(cooldown_until, |until| until.max(cooldown_until)),
        ),
        ceiling,
        last_rate_limited_at: now,
        decreased_at,
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
    now - learned.last_rate_limited_at < chrono::Duration::from_std(MEMORY).unwrap_or_default()
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
                "select {key} as upstream_key, aj.status, aj.error_message, {PLAN_AGENT_SQL} as plan_agent
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
    let status: String = job.get("status");
    let plan_agent: bool = job.get("plan_agent");
    let cooldown = (status == "failed")
        .then(|| job.get::<_, Option<String>>("error_message"))
        .flatten()
        .and_then(|error| rate_limit_cooldown(&error));
    if cooldown.is_none() && !(plan_agent && status == "completed") {
        return Ok(());
    }
    transaction
        .query_one(
            "select pg_advisory_xact_lock(hashtextextended($1, 0))",
            &[&format!("upstream-pacing:{upstream_key}")],
        )
        .await?;
    let now: DateTime<Utc> = transaction.query_one("select now()", &[]).await?.get(0);
    let previous = transaction
        .query_opt(
            "select cooldown_until, ceiling, last_rate_limited_at, decreased_at
             from upstream_pacing where upstream_key = $1",
            &[&upstream_key],
        )
        .await?
        .map(|row| Learned {
            cooldown_until: row.get("cooldown_until"),
            ceiling: row.get("ceiling"),
            last_rate_limited_at: row.get("last_rate_limited_at"),
            decreased_at: row.get("decreased_at"),
        });
    let next = match cooldown {
        Some(wait) => {
            let running: i64 = transaction
                .query_one(
                    &format!(
                        "select count(*) from agent_jobs aj
                         where aj.status = 'leased' and aj.lease_expires_at > now()
                           and {PLAN_AGENT_SQL} and {key} = $1",
                        key = upstream_key_sql("aj"),
                    ),
                    &[&upstream_key],
                )
                .await?
                .get(0);
            let next = after_rate_limit(previous.as_ref(), now, wait, running);
            info!(
                %job_id,
                upstream = %upstream_key,
                wait_ms = wait.as_millis() as u64,
                running,
                ceiling = next.ceiling,
                "an upstream rate limit paces its team plan agents"
            );
            next
        }
        None => match previous
            .as_ref()
            .and_then(|learned| after_success(learned, now))
        {
            Some(next) => next,
            None => return Ok(()),
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
                &upstream_key,
                &next.cooldown_until,
                &next.ceiling,
                &next.last_rate_limited_at,
                &next.decreased_at,
            ],
        )
        .await?;
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
    fn a_fixed_ceiling_is_a_positive_number() {
        assert_eq!(parse_fixed_ceiling(Some(" 8 ")), Some(8));
        assert_eq!(parse_fixed_ceiling(Some("0")), None);
        assert_eq!(parse_fixed_ceiling(Some("-2")), None);
        assert_eq!(parse_fixed_ceiling(Some("many")), None);
        assert_eq!(parse_fixed_ceiling(None), None);
    }
}
