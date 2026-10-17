//! Database-backed tests of stopping what a deleted space still runs or
//! holds: the stop its delete starts, and the idle sweep's step that
//! finishes it. Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::Value as JsonValue;
use tower::ServiceExt as _;
use uuid::Uuid;

use crate::background_loops::TickConnection;
use crate::config::PgPool;
use crate::runtime::run_interruptions::db_tests::{
    drain, RunningTurn, RuntimeShape, PROVIDER_ID as RUNNING_TURN_PROVIDER,
};
use crate::tests::{
    build_app_config, build_test_state, require_origin_test_pool, test_origin_private_key,
    test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::tests_managed_ai_refund::seed_reserved_managed_ai_prompt;
use crate::tunnels::{TunnelAssignment, TunnelBroker, TunnelProvider, TunnelRequestContext};
use crate::AppState;

fn fixture(projects: Vec<Uuid>) -> SharedDbFixture {
    SharedDbFixture {
        projects,
        ..Default::default()
    }
}

/// Mark `project_id` deleted `seconds_ago`, as its delete would have then.
/// The update trigger would stamp the current time, so this update runs
/// without it, in a transaction no other session sees the trigger off in.
pub(crate) async fn tombstone(
    pool: &PgPool,
    project_id: Uuid,
    seconds_ago: i64,
) -> anyhow::Result<()> {
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    transaction
        .batch_execute("alter table projects disable trigger set_projects_updated_at")
        .await?;
    transaction
        .execute(
            "update projects
             set status = 'deleted',
                 updated_at = now() - ($2::bigint * interval '1 second')
             where id = $1",
            &[&project_id, &seconds_ago],
        )
        .await?;
    transaction
        .batch_execute("alter table projects enable trigger set_projects_updated_at")
        .await?;
    transaction.commit().await?;
    Ok(())
}

/// `DELETE /projects/:id` as the service role.
async fn delete_space(state: &AppState, project_id: Uuid) -> anyhow::Result<StatusCode> {
    let response = crate::projects::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/projects/{project_id}"))
                .header("authorization", "Bearer service-role-token")
                .body(Body::empty())?,
        )
        .await?;
    Ok(response.status())
}

/// The runtime's status, its active lease and that lease's status.
async fn runtime_and_lease(
    pool: &PgPool,
    runtime_id: Uuid,
    lease_id: Uuid,
) -> anyhow::Result<(String, Option<Uuid>, String)> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select r.status, r.active_lease_id, l.status as lease_status
             from runtimes r, runtime_leases l
             where r.id = $1 and l.id = $2",
            &[&runtime_id, &lease_id],
        )
        .await?;
    Ok((
        row.get("status"),
        row.get("active_lease_id"),
        row.get("lease_status"),
    ))
}

/// Wait for the delete's own stop, which runs in a task of its own, to take
/// the runtime to `status`.
async fn wait_for_runtime_status(
    pool: &PgPool,
    runtime_id: Uuid,
    status: &str,
) -> anyhow::Result<()> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let current: String = pool
            .get()
            .await?
            .query_one("select status from runtimes where id = $1", &[&runtime_id])
            .await?
            .get(0);
        if current == status {
            return Ok(());
        }
        if tokio::time::Instant::now() > deadline {
            anyhow::bail!("runtime {runtime_id} is still {current}, not {status}");
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn runtime_status(pool: &PgPool, runtime_id: Uuid) -> anyhow::Result<String> {
    Ok(pool
        .get()
        .await?
        .query_one("select status from runtimes where id = $1", &[&runtime_id])
        .await?
        .get(0))
}

/// The status of each `(table, id)` row.
async fn statuses(pool: &PgPool, rows: &[(&str, Uuid)]) -> anyhow::Result<Vec<String>> {
    let connection = pool.get().await?;
    let mut statuses = Vec::new();
    for (table, id) in rows {
        let status: String = connection
            .query_one(&format!("select status from {table} where id = $1"), &[id])
            .await?
            .get(0);
        statuses.push(status);
    }
    Ok(statuses)
}

/// One tick of the idle sweep's deleted-space step.
async fn sweep_deleted_spaces(state: &AppState) -> anyhow::Result<()> {
    super::super::sweeps::stop_runtimes_of_deleted_projects(
        state,
        &mut TickConnection::new(&state.pool),
    )
    .await
}

/// The `(kind, reason, source)` of the runtime's stop events, oldest first.
async fn stop_events(
    pool: &PgPool,
    runtime_id: Uuid,
) -> anyhow::Result<Vec<(String, Option<String>, Option<String>)>> {
    Ok(pool
        .get()
        .await?
        .query(
            "select kind, data ->> 'reason', data ->> 'source'
             from runtime_events
             where runtime_id = $1
               and kind in ('provider_release_cleanup_pending', 'stopped')
             order by id",
            &[&runtime_id],
        )
        .await?
        .iter()
        .map(|row| (row.get(0), row.get(1), row.get(2)))
        .collect())
}

async fn insert_project(pool: &PgPool, project_id: Uuid, status: &str) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "insert into projects (id, project_type, status) values ($1, 'customer', $2)",
            &[&project_id, &status],
        )
        .await?;
    Ok(())
}

/// A runtime of `provider` in `status`, on a new lease of `lease_scope` when
/// one is given.
async fn insert_runtime(
    pool: &PgPool,
    project_id: Uuid,
    provider: &str,
    status: &str,
    lease_scope: Option<&str>,
) -> anyhow::Result<(Uuid, Option<Uuid>)> {
    let runtime_id = Uuid::new_v4();
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds, last_seen_at)
             values ($1, $2, $3, $4, 600, now())",
            &[&runtime_id, &project_id, &provider, &status],
        )
        .await?;
    let Some(scope) = lease_scope else {
        return Ok((runtime_id, None));
    };
    let lease_id = Uuid::new_v4();
    connection
        .execute(
            "insert into runtime_leases
                (id, project_id, runtime_id, status, scope, requested_at, launched_at)
             values ($1, $2, $3, 'active', $4, now(), now())",
            &[&lease_id, &project_id, &runtime_id, &scope],
        )
        .await?;
    connection
        .execute(
            "update runtimes set active_lease_id = $2 where id = $1",
            &[&runtime_id, &lease_id],
        )
        .await?;
    Ok((runtime_id, Some(lease_id)))
}

/// An active tunnel grant of `project_id`, bound to `runtime_id` if given.
async fn insert_grant(
    pool: &PgPool,
    project_id: Uuid,
    runtime_id: Option<Uuid>,
) -> anyhow::Result<Uuid> {
    let grant_id = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "insert into runtime_tunnel_grants
                (id, project_id, runtime_id, tunnel_id, hostname, url, status, expires_at)
             values ($1, $2, $3, $4, 'grant.example.dev', 'https://grant.example.dev',
                     'active', now() + interval '10 minutes')",
            &[
                &grant_id,
                &project_id,
                &runtime_id,
                &format!("tunnel-{grant_id}"),
            ],
        )
        .await?;
    Ok(grant_id)
}

async fn grant_status(pool: &PgPool, grant_id: Uuid) -> anyhow::Result<String> {
    Ok(pool
        .get()
        .await?
        .query_one(
            "select status from runtime_tunnel_grants where id = $1",
            &[&grant_id],
        )
        .await?
        .get(0))
}

/// A tunnel broker that records the tunnels it is asked to revoke, and
/// refuses while `refuse` is set.
#[derive(Default)]
struct CountingBroker {
    refuse: AtomicBool,
    revoked: Mutex<Vec<String>>,
}

impl CountingBroker {
    /// How often the grant's tunnel was revoked (as [`insert_grant`] names
    /// it). Other spaces' grants a sweep takes are not counted.
    fn revokes_of(&self, grant_id: Uuid) -> usize {
        let tunnel_id = format!("tunnel-{grant_id}");
        self.revoked
            .lock()
            .unwrap()
            .iter()
            .filter(|revoked| **revoked == tunnel_id)
            .count()
    }
}

#[async_trait]
impl TunnelBroker for CountingBroker {
    fn provider_kind(&self) -> TunnelProvider {
        TunnelProvider::SelfHosted
    }

    async fn request_tunnel(&self, _ctx: TunnelRequestContext) -> anyhow::Result<TunnelAssignment> {
        anyhow::bail!("these tests issue no tunnels")
    }

    async fn revoke_tunnel(
        &self,
        tunnel_id: &str,
        _metadata: Option<&JsonValue>,
    ) -> anyhow::Result<()> {
        self.revoked.lock().unwrap().push(tunnel_id.to_string());
        if self.refuse.load(Ordering::SeqCst) {
            anyhow::bail!("injected broker revoke failure");
        }
        Ok(())
    }
}

fn state_without_providers(pool: &PgPool, broker: Option<Arc<CountingBroker>>) -> AppState {
    let mut state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "deleted-project-stop",
        ),
    );
    state.tunnel_broker = broker.map(|broker| broker as crate::tunnels::DynTunnelBroker);
    state
}

/// Deleting a space stops its hosted machine without holding up the answer:
/// the delete answers at once, then the machine is quarantined, released
/// through its provider and stopped under `space_deleted`, its turn already
/// canceled by the delete. No `runtime.stopped` goes out, which a tab would
/// take for an unexpected stop and start the machine again on. A repeated
/// delete still answers 204 and finds nothing left to stop.
#[tokio::test]
async fn deleting_a_space_stops_and_releases_its_machine() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("deleted space machine stop test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(vec![project_id]), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        let mut events = turn.state.events.subscribe();

        assert_eq!(
            delete_space(&turn.state, project_id).await?,
            StatusCode::NO_CONTENT
        );
        wait_for_runtime_status(&turn.pool, turn.runtime_id, "stopped").await?;

        assert_eq!(turn.releases_of(turn.runtime_id), 1);
        assert_eq!(
            runtime_and_lease(&turn.pool, turn.runtime_id, turn.runtime_lease_id).await?,
            ("stopped".to_string(), None, "released".to_string())
        );
        let deleted = Some("space_deleted".to_string());
        assert_eq!(
            stop_events(&turn.pool, turn.runtime_id).await?,
            vec![
                (
                    "provider_release_cleanup_pending".to_string(),
                    deleted.clone(),
                    deleted.clone()
                ),
                ("stopped".to_string(), deleted, None),
            ]
        );
        assert_eq!(turn.job(turn.job_id).await?.0, "canceled");
        let published = drain(&mut events);
        assert!(
            !published
                .iter()
                .any(|event| event.kind == "runtime.stopped"),
            "{published:?}"
        );

        assert_eq!(
            delete_space(&turn.state, project_id).await?,
            StatusCode::NO_CONTENT,
            "a repeated delete as the service role still succeeds"
        );
        assert_eq!(
            super::stop_runtimes_of_deleted_project(&turn.state, project_id).await,
            0
        );
        assert_eq!(
            turn.releases_of(turn.runtime_id),
            1,
            "nothing was left to release"
        );
        Ok(())
    })
    .await
}

/// A Desktop or self-hosted runtime of a deleted space has no provider to
/// release it: the delete's stop takes it to `stopped` in the database and
/// releases its lease, and stops one that still runs without a lease too.
#[tokio::test]
async fn a_deleted_spaces_self_hosted_runtimes_stop_without_a_provider() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("deleted space self-hosted stop test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(vec![project_id]), async {
        insert_project(&pool, project_id, "deleted").await?;
        let (leased, lease_id) =
            insert_runtime(&pool, project_id, "self-hosted", "ready", Some("exclusive")).await?;
        let lease_id = lease_id.expect("lease");
        let (unleased, _) = insert_runtime(&pool, project_id, "self-hosted", "ready", None).await?;
        let (already_stopped, _) =
            insert_runtime(&pool, project_id, "self-hosted", "stopped", None).await?;
        let state = state_without_providers(&pool, None);

        assert_eq!(
            super::stop_runtimes_of_deleted_project(&state, project_id).await,
            2
        );

        assert_eq!(
            runtime_and_lease(&pool, leased, lease_id).await?,
            ("stopped".to_string(), None, "released".to_string())
        );
        let deleted = Some("space_deleted".to_string());
        assert_eq!(
            stop_events(&pool, leased).await?,
            vec![("stopped".to_string(), deleted.clone(), None)],
            "a logical stop, with no quarantine for a provider release"
        );
        assert_eq!(
            stop_events(&pool, unleased).await?,
            vec![("stopped".to_string(), deleted, None)]
        );
        assert!(stop_events(&pool, already_stopped).await?.is_empty());
        Ok(())
    })
    .await
}

/// What a deleted space holds besides its runtimes goes with them: its
/// workspace leases; its tenant lease on another space's machine, which keeps
/// running for that space; and every tunnel grant it still has, whether
/// bound to a runtime or not, with no `tunnel.grant_revoked` for anyone to
/// follow. A live space's grant and lease stay.
#[tokio::test]
async fn a_deleted_space_lets_go_of_its_leases_and_tunnel_grants() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("deleted space holds test").await?;
    let deleted_id = Uuid::new_v4();
    let host_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(vec![deleted_id, host_id]), async {
        insert_project(&pool, deleted_id, "deleted").await?;
        insert_project(&pool, host_id, "active").await?;
        let (host_runtime, host_lease) =
            insert_runtime(&pool, host_id, "self-hosted", "ready", Some("shared")).await?;
        let host_lease = host_lease.expect("lease");
        let tenant_lease = Uuid::new_v4();
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into runtime_leases
                    (id, project_id, runtime_id, status, scope, parent_lease_id,
                     requested_at, launched_at)
                 values ($1, $2, $3, 'active', 'tenant', $4, now(), now())",
                &[&tenant_lease, &deleted_id, &host_runtime, &host_lease],
            )
            .await?;
        let mut workspace_leases = Vec::new();
        for project_id in [deleted_id, host_id] {
            let lease_id: Uuid = connection
                .query_one(
                    "insert into workspace_leases (project_id, status, expires_at)
                     values ($1, 'active', now() + interval '5 minutes')
                     returning id",
                    &[&project_id],
                )
                .await?
                .get(0);
            workspace_leases.push(lease_id);
        }
        drop(connection);
        let (stopped_runtime, _) =
            insert_runtime(&pool, deleted_id, "self-hosted", "stopped", None).await?;
        let unbound_grant = insert_grant(&pool, deleted_id, None).await?;
        let stopped_runtime_grant = insert_grant(&pool, deleted_id, Some(stopped_runtime)).await?;
        let host_grant = insert_grant(&pool, host_id, Some(host_runtime)).await?;
        let broker = Arc::new(CountingBroker::default());
        let state = state_without_providers(&pool, Some(broker.clone()));
        let mut events = state.events.subscribe();

        assert_eq!(
            super::stop_runtimes_of_deleted_project(&state, deleted_id).await,
            0
        );

        assert_eq!(grant_status(&pool, unbound_grant).await?, "revoked");
        assert_eq!(grant_status(&pool, stopped_runtime_grant).await?, "revoked");
        assert_eq!(grant_status(&pool, host_grant).await?, "active");
        assert_eq!(broker.revokes_of(unbound_grant), 1);
        assert_eq!(broker.revokes_of(stopped_runtime_grant), 1);
        assert_eq!(broker.revokes_of(host_grant), 0);
        let published = drain(&mut events);
        assert!(
            !published
                .iter()
                .any(|event| event.kind.starts_with("tunnel.")),
            "{published:?}"
        );

        let connection = pool.get().await?;
        let lease_statuses: Vec<String> = connection
            .query(
                "select status from runtime_leases where id = any($1) order by scope",
                &[&vec![host_lease, tenant_lease]],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        assert_eq!(
            lease_statuses,
            vec!["active".to_string(), "released".to_string()],
            "the host's shared lease stays, the deleted space's tenant lease goes"
        );
        let host_runtime_status: String = connection
            .query_one(
                "select status from runtimes where id = $1",
                &[&host_runtime],
            )
            .await?
            .get(0);
        assert_eq!(host_runtime_status, "ready");
        let workspace_statuses: Vec<String> = connection
            .query(
                "select status from workspace_leases where id = any($1) order by project_id = $2",
                &[&workspace_leases, &deleted_id],
            )
            .await?
            .iter()
            .map(|row| row.get(0))
            .collect();
        assert_eq!(
            workspace_statuses,
            vec!["active".to_string(), "released".to_string()]
        );
        Ok(())
    })
    .await
}

/// The idle sweep's step stops a deleted space's machine the delete's own
/// stop left running (here: none ran, as after a restart), once the delete
/// is older than the grace that leaves it to that stop. The turn the stop's
/// quarantine requeues is canceled right after. A space deleted just now and
/// a live space are left alone.
#[tokio::test]
async fn the_sweep_stops_a_deleted_spaces_machine_after_the_grace() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("deleted space sweep test").await?;
    let deleted_id = Uuid::new_v4();
    let live_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(vec![deleted_id, live_id]), async {
        let deleted = RunningTurn::start(
            pool.clone(),
            deleted_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        let live = RunningTurn::start(
            pool.clone(),
            live_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        tombstone(&pool, deleted_id, 0).await?;
        let mut events = deleted.state.events.subscribe();

        super::super::sweeps::stop_runtimes_of_deleted_projects(
            &deleted.state,
            &mut TickConnection::new(&deleted.state.pool),
        )
        .await?;
        assert_eq!(
            deleted.releases_of(deleted.runtime_id),
            0,
            "a delete just now is its own stop's"
        );
        assert_eq!(
            runtime_and_lease(&pool, deleted.runtime_id, deleted.runtime_lease_id)
                .await?
                .0,
            "ready"
        );

        tombstone(&pool, deleted_id, 5 * 60).await?;
        super::super::sweeps::stop_runtimes_of_deleted_projects(
            &deleted.state,
            &mut TickConnection::new(&deleted.state.pool),
        )
        .await?;

        assert_eq!(deleted.releases_of(deleted.runtime_id), 1);
        assert_eq!(
            runtime_and_lease(&pool, deleted.runtime_id, deleted.runtime_lease_id).await?,
            ("stopped".to_string(), None, "released".to_string())
        );
        assert_eq!(deleted.job(deleted.job_id).await?.0, "canceled");
        assert_eq!(deleted.run(deleted.run_id).await?.status, "canceled");
        assert_eq!(live.releases_of(live.runtime_id), 0);
        assert_eq!(
            runtime_and_lease(&pool, live.runtime_id, live.runtime_lease_id).await?,
            (
                "ready".to_string(),
                Some(live.runtime_lease_id),
                "active".to_string()
            )
        );
        let published = drain(&mut events);
        assert!(
            !published
                .iter()
                .any(|event| event.kind == "runtime.stopped"),
            "{published:?}"
        );
        Ok(())
    })
    .await
}

/// A tunnel grant of a deleted space the broker would not revoke stays
/// active, and the sweep revokes it on a later tick, with no runtime left
/// to stop in the space.
#[tokio::test]
async fn the_sweep_retries_a_deleted_spaces_tunnel_grant() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("deleted space tunnel retry test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(vec![project_id]), async {
        insert_project(&pool, project_id, "active").await?;
        let grant = insert_grant(&pool, project_id, None).await?;
        tombstone(&pool, project_id, 5 * 60).await?;
        let broker = Arc::new(CountingBroker::default());
        broker.refuse.store(true, Ordering::SeqCst);
        let state = state_without_providers(&pool, Some(broker.clone()));

        assert_eq!(
            super::stop_runtimes_of_deleted_project(&state, project_id).await,
            0
        );
        assert_eq!(broker.revokes_of(grant), 1);
        assert_eq!(grant_status(&pool, grant).await?, "active");

        broker.refuse.store(false, Ordering::SeqCst);
        super::super::sweeps::stop_runtimes_of_deleted_projects(
            &state,
            &mut TickConnection::new(&state.pool),
        )
        .await?;
        assert_eq!(broker.revokes_of(grant), 2);
        assert_eq!(grant_status(&pool, grant).await?, "revoked");

        super::super::sweeps::stop_runtimes_of_deleted_projects(
            &state,
            &mut TickConnection::new(&state.pool),
        )
        .await?;
        assert_eq!(
            broker.revokes_of(grant),
            2,
            "a revoked grant is not picked up again"
        );
        Ok(())
    })
    .await
}

/// A Desktop or self-hosted runtime of a deleted space that still runs
/// without a lease generation, which the delete's own stop missed, is
/// stopped by the sweep, in the database alone, once the delete is older
/// than the grace. A provider-managed one in that state is left as it was:
/// it has nothing to release, and its stop would be refused.
#[tokio::test]
async fn the_sweep_stops_a_deleted_spaces_unleased_local_runtime() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("deleted space unleased runtime sweep test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(vec![project_id]), async {
        insert_project(&pool, project_id, "active").await?;
        let (local, _) = insert_runtime(&pool, project_id, "self-hosted", "ready", None).await?;
        let (hosted, _) = insert_runtime(&pool, project_id, "instafy_cloud", "ready", None).await?;
        tombstone(&pool, project_id, 0).await?;
        let state = state_without_providers(&pool, None);

        sweep_deleted_spaces(&state).await?;
        assert_eq!(
            runtime_status(&pool, local).await?,
            "ready",
            "a delete just now is its own stop's"
        );

        tombstone(&pool, project_id, 5 * 60).await?;
        sweep_deleted_spaces(&state).await?;
        assert_eq!(runtime_status(&pool, local).await?, "stopped");
        assert_eq!(
            stop_events(&pool, local).await?,
            vec![(
                "stopped".to_string(),
                Some("space_deleted".to_string()),
                None
            )]
        );
        assert_eq!(runtime_status(&pool, hosted).await?, "ready");
        assert!(stop_events(&pool, hosted).await?.is_empty());
        Ok(())
    })
    .await
}

/// A runtime of a deleted space a provider release may still be in flight
/// for (here a person's Stop) is left to that release. The sweep leaves
/// every runtime of the space alone meanwhile, since the delete's own stop
/// goes through them one at a time; that stop checks each runtime just
/// before stopping it. Once a release could no longer be running, the sweep
/// stops what is left, and each machine is released once.
#[tokio::test]
async fn a_release_in_flight_is_left_to_itself() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("deleted space release in flight test").await?;
    let project_id = Uuid::new_v4();
    with_shared_db_fixture(fixture(vec![project_id]), async {
        let turn = RunningTurn::start(
            pool.clone(),
            project_id,
            RuntimeShape::Hosted,
            StatusCode::NO_CONTENT,
        )
        .await?;
        // A second machine of the space, from the same provider.
        let (sibling, sibling_lease) = insert_runtime(
            &pool,
            project_id,
            RUNNING_TURN_PROVIDER,
            "ready",
            Some("exclusive"),
        )
        .await?;
        let sibling_lease = sibling_lease.expect("lease");
        pool.get()
            .await?
            .execute(
                "insert into runtime_events (runtime_id, project_id, kind, data)
                 values ($1, $2, 'provider_release_cleanup_pending',
                         '{\"reason\": \"user_requested\"}'::jsonb)",
                &[&turn.runtime_id, &project_id],
            )
            .await?;
        tombstone(&pool, project_id, 5 * 60).await?;

        sweep_deleted_spaces(&turn.state).await?;
        assert_eq!(turn.releases_of(turn.runtime_id), 0);
        assert_eq!(
            turn.releases_of(sibling),
            0,
            "the delete's own stop may be on its way to the sibling"
        );
        assert_eq!(runtime_status(&pool, sibling).await?, "ready");

        assert_eq!(
            super::stop_runtimes_of_deleted_project(&turn.state, project_id).await,
            1
        );
        assert_eq!(
            turn.releases_of(turn.runtime_id),
            0,
            "the release in flight is left to itself"
        );
        assert_eq!(turn.releases_of(sibling), 1);
        assert_eq!(
            runtime_and_lease(&pool, sibling, sibling_lease).await?,
            ("stopped".to_string(), None, "released".to_string())
        );
        assert_eq!(
            runtime_and_lease(&pool, turn.runtime_id, turn.runtime_lease_id).await?,
            (
                "ready".to_string(),
                Some(turn.runtime_lease_id),
                "active".to_string()
            )
        );

        // Both releases are now older than one could run.
        pool.get()
            .await?
            .execute(
                "update runtime_events
                 set created_at = now() - interval '5 minutes'
                 where runtime_id = any($1)",
                &[&vec![turn.runtime_id, sibling]],
            )
            .await?;
        sweep_deleted_spaces(&turn.state).await?;
        assert_eq!(turn.releases_of(turn.runtime_id), 1);
        assert_eq!(turn.releases_of(sibling), 1);
        assert_eq!(
            runtime_and_lease(&pool, turn.runtime_id, turn.runtime_lease_id).await?,
            ("stopped".to_string(), None, "released".to_string())
        );
        Ok(())
    })
    .await
}

/// Work that reached a deleted space after its delete's last cancel (here a
/// space deleted with no runtime, whose queued turn a dispatch committed
/// after that cancel) is canceled by the sweep once the delete is older than
/// the grace, and the managed-AI reserve of that turn, which no runtime ever
/// held, is refunded. A space deleted just now and a live space keep theirs.
#[tokio::test]
async fn the_sweep_cancels_the_work_a_deleted_space_still_has() -> anyhow::Result<()> {
    let Some(seeded) = seed_reserved_managed_ai_prompt("deleted-space-sweep-work").await? else {
        eprintln!("skipping deleted space work sweep test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    let deleted_id = seeded.project_id;
    let live_id = Uuid::new_v4();
    let outcome = with_shared_db_fixture(
        SharedDbFixture {
            organizations: vec![seeded.org_id],
            projects: Vec::new(),
        },
        async {
            let pool = &seeded.pool;
            let connection = pool.get().await?;
            connection
                .execute(
                    "insert into projects (id, org_id, project_type, status)
                     values ($1, $2, 'customer', 'active')",
                    &[&live_id, &seeded.org_id],
                )
                .await?;
            let live_run = Uuid::new_v4();
            connection
                .execute(
                    "insert into runs (id, project_id, run_type, status)
                     values ($1, $2, 'prompt', 'queued')",
                    &[&live_run, &live_id],
                )
                .await?;
            let live_job = Uuid::new_v4();
            connection
                .execute(
                    "insert into agent_jobs (id, project_id, run_id, status, payload)
                     values ($1, $2, $3, 'queued', '{}'::jsonb)",
                    &[&live_job, &live_id, &live_run],
                )
                .await?;
            drop(connection);
            let work = [
                ("agent_jobs", seeded.job_id),
                ("runs", seeded.run_id),
                ("agent_jobs", live_job),
                ("runs", live_run),
            ];
            let queued = vec!["queued".to_string(); 4];
            assert_eq!(statuses(pool, &work).await?, queued);

            tombstone(pool, deleted_id, 0).await?;
            sweep_deleted_spaces(&seeded.state).await?;
            assert_eq!(
                statuses(pool, &work).await?,
                queued,
                "a delete just now is its own stop's"
            );

            tombstone(pool, deleted_id, 5 * 60).await?;
            sweep_deleted_spaces(&seeded.state).await?;
            assert_eq!(
                statuses(pool, &work).await?,
                vec!["canceled", "canceled", "queued", "queued"]
            );
            let refunds: Vec<Option<String>> = pool
                .get()
                .await?
                .query(
                    "select metadata ->> 'refundReason' from org_credit_ledger
                     where project_id = $1 and reason = $2",
                    &[&deleted_id, &crate::credits::MANAGED_AI_REFUND_REASON],
                )
                .await?
                .iter()
                .map(|row| row.get(0))
                .collect();
            assert_eq!(refunds, vec![Some("space_deleted".to_string())]);
            Ok(())
        },
    )
    .await;
    let cleanup = async {
        seeded
            .pool
            .get()
            .await?
            .execute(
                "delete from runs where project_id = any($1)",
                &[&vec![deleted_id, live_id]],
            )
            .await?;
        seeded.cleanup().await
    }
    .await;
    outcome.and(cleanup)
}
