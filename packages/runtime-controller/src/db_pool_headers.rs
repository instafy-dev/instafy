//! The database pool headers on `/healthz`.
//!
//! All counters come from bb8 and reset when the controller restarts. A get
//! is either direct (an idle connection was free), waited (it queued for
//! one) or timed out. `get-wait-micros` is bb8's total time spent queuing, in
//! microseconds, for waited and timed-out gets (bb8 0.8
//! `Statistics::get_wait_time`), so the average wait is
//! `get-wait-micros / (get-waited + get-timed-out)`.

use axum::http::{HeaderMap, HeaderValue};

/// The pool numbers `/healthz` reports, copied out of bb8's `State`.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct DbPoolSnapshot {
    pub(crate) size: u32,
    pub(crate) connections: u32,
    pub(crate) idle: u32,
    pub(crate) get_direct: u64,
    pub(crate) get_waited: u64,
    pub(crate) get_timed_out: u64,
    pub(crate) get_wait_micros: u64,
}

impl DbPoolSnapshot {
    pub(crate) fn new(size: u32, state: &bb8::State) -> Self {
        let statistics = &state.statistics;
        Self {
            size,
            connections: state.connections,
            idle: state.idle_connections,
            get_direct: statistics.get_direct,
            get_waited: statistics.get_waited,
            get_timed_out: statistics.get_timed_out,
            // bb8 keeps this as a u64 count of microseconds.
            get_wait_micros: u64::try_from(statistics.get_wait_time.as_micros())
                .unwrap_or(u64::MAX),
        }
    }
}

/// Adds the pool headers in their established order; the last two are newer.
pub(crate) fn insert_db_pool_headers(headers: &mut HeaderMap, snapshot: &DbPoolSnapshot) {
    let values: [(&'static str, u64); 7] = [
        ("x-instafy-db-pool-size", snapshot.size.into()),
        ("x-instafy-db-pool-connections", snapshot.connections.into()),
        ("x-instafy-db-pool-idle", snapshot.idle.into()),
        ("x-instafy-db-pool-get-waited", snapshot.get_waited),
        ("x-instafy-db-pool-get-timed-out", snapshot.get_timed_out),
        ("x-instafy-db-pool-get-direct", snapshot.get_direct),
        (
            "x-instafy-db-pool-get-wait-micros",
            snapshot.get_wait_micros,
        ),
    ];
    for (name, value) in values {
        headers.insert(name, HeaderValue::from(value));
    }
}

#[cfg(test)]
mod tests {
    use axum::http::HeaderMap;

    use super::{insert_db_pool_headers, DbPoolSnapshot};

    #[test]
    fn healthz_db_pool_headers_are_decimal_integers() {
        let mut headers = HeaderMap::new();
        insert_db_pool_headers(
            &mut headers,
            &DbPoolSnapshot {
                size: 4,
                connections: 3,
                idle: 1,
                get_direct: 98_765,
                get_waited: 1_524,
                get_timed_out: 0,
                get_wait_micros: u64::MAX,
            },
        );
        let rendered: Vec<(&str, &str)> = headers
            .iter()
            .map(|(name, value)| (name.as_str(), value.to_str().unwrap()))
            .collect();
        assert_eq!(
            rendered,
            [
                ("x-instafy-db-pool-size", "4"),
                ("x-instafy-db-pool-connections", "3"),
                ("x-instafy-db-pool-idle", "1"),
                ("x-instafy-db-pool-get-waited", "1524"),
                ("x-instafy-db-pool-get-timed-out", "0"),
                ("x-instafy-db-pool-get-direct", "98765"),
                ("x-instafy-db-pool-get-wait-micros", "18446744073709551615"),
            ]
        );
    }

    /// The snapshot reads a real pool's state; an unconnected pool reports
    /// zeros without touching a database.
    #[tokio::test]
    async fn healthz_db_pool_snapshot_reads_an_unconnected_pool() -> anyhow::Result<()> {
        let manager = bb8_postgres::PostgresConnectionManager::new_from_stringlike(
            "postgres://postgres:postgres@127.0.0.1:1/postgres",
            crate::config::database_tls(),
        )?;
        let pool = bb8::Pool::builder().max_size(4).build_unchecked(manager);
        let snapshot = DbPoolSnapshot::new(4, &pool.state());
        let mut headers = HeaderMap::new();
        insert_db_pool_headers(&mut headers, &snapshot);
        assert_eq!(headers["x-instafy-db-pool-size"], "4");
        assert_eq!(headers["x-instafy-db-pool-idle"], "0");
        assert_eq!(headers["x-instafy-db-pool-get-direct"], "0");
        assert_eq!(headers["x-instafy-db-pool-get-wait-micros"], "0");
        Ok(())
    }
}
