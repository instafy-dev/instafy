//! Start offsets for the controller's periodic database loops.
//!
//! Every loop below takes a pool connection on each tick. Started with plain
//! `tokio::time::interval`, they all tick at boot and then stay in step for
//! the life of the process, so every 10 s five of them, and every 30 s seven,
//! asked a pool of four at the same instant. Each loop now starts at its own
//! offset from this one table, chosen so that no two loops start a tick in
//! the same second (period 5 s and 10 s loops take a fixed second of every
//! ten; the slower ones use the seconds left over). The bound is on tick
//! starts: a slow tick can still overlap the next loop's. A tick handled more
//! than 5 ms late, or one that overruns its period, re-phases a loop with the
//! `Delay` missed-tick behavior. The table is checked by the tests at the
//! bottom of this file.
//!
//! A new periodic loop that uses the pool must take its schedule from a
//! constant here that is also listed in `DATABASE_LOOPS`; the tests only see
//! that array.
//!
//! A tick that runs several queries in a row can share one checkout between
//! them through [`TickConnection`].

use std::time::Duration;

use anyhow::Context;
use tokio::time::{Instant, Interval};

use crate::config::{PgConnectionManager, PgPool};

/// How often a background loop ticks and how long after boot it first does.
#[derive(Clone, Copy, Debug)]
pub(crate) struct LoopSchedule {
    pub(crate) name: &'static str,
    pub(crate) period: Duration,
    pub(crate) offset: Duration,
}

const fn schedule(name: &'static str, period_secs: u64, offset_secs: u64) -> LoopSchedule {
    LoopSchedule {
        name,
        period: Duration::from_secs(period_secs),
        offset: Duration::from_secs(offset_secs),
    }
}

/// Kept at offset 0: recovery of durable queue work runs right after boot.
pub(crate) const SEND_QUEUE_RECOVERY: LoopSchedule = schedule("send_queue_recovery", 5, 0);
pub(crate) const NOTIFICATION_WORKER: LoopSchedule = schedule("notification_worker", 5, 1);
pub(crate) const IDLE_ACTIVITY_SWEEP: LoopSchedule = schedule("idle_activity_sweep", 10, 2);
pub(crate) const ORIGIN_PRESENCE_SWEEP: LoopSchedule = schedule("origin_presence_sweep", 10, 3);
pub(crate) const RUNTIME_LIMIT_WAIT_SWEEP: LoopSchedule =
    schedule("runtime_limit_wait_sweep", 10, 4);
pub(crate) const RECOMMENDATION_REMINDERS: LoopSchedule =
    schedule("recommendation_reminders", 30, 7);
pub(crate) const AUTOMATION_SCHEDULER: LoopSchedule = schedule("automation_scheduler", 30, 8);
pub(crate) const HOSTED_RUNTIME_CREDIT_SWEEP: LoopSchedule =
    schedule("hosted_runtime_credit_sweep", 60, 9);
pub(crate) const RETENTION_PRUNE: LoopSchedule = schedule("retention_prune", 300, 19);

/// Every periodic loop that uses the database pool. Each schedule constant
/// above must appear here exactly once.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) const DATABASE_LOOPS: [LoopSchedule; 9] = [
    SEND_QUEUE_RECOVERY,
    NOTIFICATION_WORKER,
    IDLE_ACTIVITY_SWEEP,
    ORIGIN_PRESENCE_SWEEP,
    RUNTIME_LIMIT_WAIT_SWEEP,
    RECOMMENDATION_REMINDERS,
    AUTOMATION_SCHEDULER,
    HOSTED_RUNTIME_CREDIT_SWEEP,
    RETENTION_PRUNE,
];

/// An interval that first ticks `schedule.offset` from now and then every
/// `schedule.period`. Callers keep setting their own missed-tick behavior.
pub(crate) fn staggered_interval(schedule: LoopSchedule) -> Interval {
    tracing::debug!(
        background_loop = schedule.name,
        period = ?schedule.period,
        offset = ?schedule.offset,
        "background loop scheduled"
    );
    tokio::time::interval_at(Instant::now() + schedule.offset, schedule.period)
}

/// One pool connection that a loop tick checks out at its first query and
/// keeps for the queries after it, until the tick releases it or ends.
///
/// Every checkout costs a ping (the pool tests a connection before handing it
/// out), so a tick whose steps each took their own connection paid one ping
/// per step even when no step found anything to do. Steps that share this
/// connection pay one per tick.
///
/// The connection must never be held while anything waits for another pool
/// connection: with a pool of one that wait could only end in the checkout
/// timeout, and with any pool it would hold two slots where the steps alone
/// held one. A step therefore calls [`TickConnection::release`] before an
/// action that takes its own connection (a stop, a publish that reads a run,
/// a claimed limit wait's launch), and the next query checks out again. Work
/// a step does only on this connection, such as a transaction it opens on it,
/// needs no release.
pub(crate) struct TickConnection<'p> {
    pool: &'p PgPool,
    held: Option<bb8::PooledConnection<'p, PgConnectionManager>>,
}

impl<'p> TickConnection<'p> {
    /// A tick that has not checked anything out yet.
    pub(crate) fn new(pool: &'p PgPool) -> Self {
        Self { pool, held: None }
    }

    /// The held connection, checked out first if the tick holds none. A
    /// failed checkout carries `context`, which names the step that needed
    /// the connection.
    pub(crate) async fn client(
        &mut self,
        context: &'static str,
    ) -> anyhow::Result<&mut tokio_postgres::Client> {
        if self.held.is_none() {
            self.held = Some(self.pool.get().await.context(context)?);
        }
        Ok(self
            .held
            .as_deref_mut()
            .expect("the connection was checked out above"))
    }

    /// Give the connection back to the pool, if the tick holds one.
    pub(crate) fn release(&mut self) {
        self.held = None;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::time::Duration;

    use super::{staggered_interval, DATABASE_LOOPS};

    const SIMULATED: Duration = Duration::from_secs(300);
    const WINDOW: Duration = Duration::from_secs(1);

    #[test]
    fn database_loop_offsets_are_unique_and_inside_their_period() {
        let mut names = HashSet::new();
        let mut offsets = HashSet::new();
        for schedule in DATABASE_LOOPS {
            assert!(
                names.insert(schedule.name),
                "{} listed twice",
                schedule.name
            );
            assert!(
                offsets.insert(schedule.offset),
                "{} shares its offset",
                schedule.name
            );
            assert!(
                schedule.offset < schedule.period,
                "{} starts after its own period",
                schedule.name
            );
        }
    }

    /// Drives the real intervals on a paused clock for 300 s and checks that
    /// no closed 1 s window holds more than two database loop ticks.
    #[tokio::test(start_paused = true)]
    async fn staggered_database_loops_never_tick_more_than_two_per_second() {
        // Created back to back on a paused clock, so they share one start.
        let start = tokio::time::Instant::now();
        let mut intervals: Vec<_> = DATABASE_LOOPS
            .iter()
            .map(|schedule| (schedule.name, staggered_interval(*schedule)))
            .collect();

        let mut ticks = Vec::new();
        for (name, interval) in &mut intervals {
            loop {
                // The default (burst) behavior returns each scheduled instant.
                let at = interval.tick().await - start;
                if at >= SIMULATED {
                    break;
                }
                ticks.push((at, *name));
            }
        }
        ticks.sort();

        let expected: u64 = DATABASE_LOOPS
            .iter()
            .map(|schedule| {
                (SIMULATED - schedule.offset)
                    .as_secs()
                    .div_ceil(schedule.period.as_secs())
            })
            .sum();
        assert_eq!(ticks.len() as u64, expected);

        let mut worst = 0;
        for (index, (at, _)) in ticks.iter().enumerate() {
            let in_window = ticks[index..]
                .iter()
                .take_while(|(other, _)| *other - *at <= WINDOW)
                .count();
            worst = worst.max(in_window);
            assert!(
                in_window <= 2,
                "{in_window} loops tick within 1 s of {at:?}: {:?}",
                &ticks[index..index + in_window]
            );
        }
        assert_eq!(worst, 2);

        let instants: HashSet<_> = ticks.iter().map(|(at, _)| *at).collect();
        assert_eq!(instants.len(), ticks.len(), "two loops tick at one instant");
    }
}

#[cfg(test)]
mod tick_connection_tests {
    use std::time::Duration;

    use bb8_postgres::PostgresConnectionManager;

    use super::TickConnection;
    use crate::tests::{pool_gets, require_origin_test_pool};

    /// A tick checks out at its first query, keeps that connection for every
    /// query after it, and checks out again only after a release.
    #[tokio::test]
    async fn a_tick_checks_out_once_until_it_releases() -> anyhow::Result<()> {
        let pool = require_origin_test_pool("a_tick_checks_out_once_until_it_releases").await?;
        let start = pool_gets(&pool);
        let all_idle = |pool: &crate::config::PgPool| {
            let state = pool.state();
            state.idle_connections == state.connections
        };

        let mut tick = TickConnection::new(&pool);
        assert_eq!(pool_gets(&pool), start, "no query, no checkout");
        for step in ["first step", "second step", "third step"] {
            tick.client(step).await?.query_one("select 1", &[]).await?;
        }
        assert_eq!(pool_gets(&pool) - start, 1);
        assert!(!all_idle(&pool), "the tick holds its connection");

        tick.release();
        assert!(all_idle(&pool), "a release gives the connection back");
        tick.client("after a release")
            .await?
            .query_one("select 1", &[])
            .await?;
        assert_eq!(pool_gets(&pool) - start, 2);

        drop(tick);
        assert!(
            all_idle(&pool),
            "a tick that ends gives its connection back"
        );
        Ok(())
    }

    /// A failed checkout reports the step that needed the connection, as
    /// each step's own checkout did.
    #[tokio::test]
    async fn a_failed_tick_checkout_names_its_step() -> anyhow::Result<()> {
        drop(require_origin_test_pool("a_failed_tick_checkout_names_its_step").await?);
        let manager = PostgresConnectionManager::new_from_stringlike(
            std::env::var("TEST_DATABASE_URL")?,
            crate::config::database_tls(),
        )?;
        let pool = bb8::Pool::builder()
            .max_size(1)
            .connection_timeout(Duration::from_millis(200))
            .build(manager)
            .await?;
        let held = pool.get().await?;

        let mut tick = TickConnection::new(&pool);
        let error = tick
            .client("failed to acquire connection for the step")
            .await
            .err()
            .expect("the only connection is checked out");
        assert_eq!(
            error.to_string(),
            "failed to acquire connection for the step"
        );
        assert!(
            format!("{error:#}")
                .to_ascii_lowercase()
                .contains("timed out in bb8"),
            "{error:#}"
        );
        drop(held);
        Ok(())
    }
}
