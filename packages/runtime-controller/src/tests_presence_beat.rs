//! The origin presence beat route on the migrated database: a beat reads
//! through one pool checkout, records the presence it reports, and refuses
//! exactly what it refused before.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value as JsonValue};
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::{PgPool, RuntimeProviderConfig};
use crate::tests::{
    build_app_config, build_test_state, require_origin_test_pool, test_origin_private_key,
    test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};
use crate::{origins, AppState};

const HOSTED_PROVIDER: &str = "instafy-cloud";

/// A hosted machine: a ready runtime on an active lease, whose origin is
/// registered and assigned to that lease.
struct Machine {
    project_id: Uuid,
    runtime_id: Uuid,
    lease_id: Uuid,
    origin_id: Uuid,
}

fn test_state(pool: &PgPool, key_id: &str) -> AppState {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), key_id);
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: HOSTED_PROVIDER.to_string(),
        display_name: "Instafy Cloud".to_string(),
        kind: "noop".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: None,
        auth_token: None,
        metadata: None,
    }];
    build_test_state(pool.clone(), config)
}

async fn seed_project(pool: &PgPool, project_id: &Uuid) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
            &[project_id],
        )
        .await?;
    Ok(())
}

async fn register_origin(pool: &PgPool, project_id: &Uuid) -> anyhow::Result<Uuid> {
    let origin_id = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "insert into workspace_origins (id, project_id, mode, endpoint, protocols, region)
             values ($1, $2, 'hosted', 'https://machine-origin.invalid', array['http']::text[], 'iad')",
            &[&origin_id, project_id],
        )
        .await?;
    Ok(origin_id)
}

async fn seed_machine(pool: &PgPool, project_id: Uuid) -> anyhow::Result<Machine> {
    seed_project(pool, &project_id).await?;
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let origin_id = register_origin(pool, &project_id).await?;
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into runtimes (
                 id, project_id, provider, status, endpoint_url, task_ref,
                 idle_ttl_seconds, last_seen_at, capabilities
             ) values ($1, $2, $3, 'ready', 'http://runtime.invalid', $4, 600, now(), '{}'::jsonb)",
            &[
                &runtime_id,
                &project_id,
                &HOSTED_PROVIDER,
                &format!("presence-beat-{runtime_id}"),
            ],
        )
        .await?;
    connection
        .execute(
            "insert into runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at)
             values ($1, $2, $3, 'active', now(), now())",
            &[&lease_id, &project_id, &runtime_id],
        )
        .await?;
    connection
        .execute(
            "update runtimes set active_lease_id = $2 where id = $1",
            &[&runtime_id, &lease_id],
        )
        .await?;
    connection
        .execute(
            "insert into origin_instances (
                 project_id, runtime_id, lease_id, origin_id, required, mode, status, protocols
             ) values ($1, $2, $3, $4, true, 'hosted', 'online', array['http']::text[])",
            &[&project_id, &runtime_id, &lease_id, &origin_id],
        )
        .await?;
    Ok(Machine {
        project_id,
        runtime_id,
        lease_id,
        origin_id,
    })
}

/// The runtime bearer an origin server beats with.
fn presence_bearer(state: &AppState, machine: &Machine) -> anyhow::Result<String> {
    Ok(mint_scoped_token(
        &state.config,
        ScopedTokenRequest {
            audience: machine.runtime_id.to_string(),
            subject: "origin.test".to_string(),
            project_id: machine.project_id.to_string(),
            origin_id: None,
            runtime_id: Some(machine.runtime_id.to_string()),
            protocol: None,
            scopes: vec!["origin.presence".to_string()],
            lease_id: Some(machine.lease_id.to_string()),
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: None,
        },
    )
    .map_err(|(status, error)| {
        anyhow::anyhow!("mint the presence bearer: {status} {}", error.0.message)
    })?
    .token)
}

async fn beat(
    state: &AppState,
    machine: &Machine,
    origin_id: &Uuid,
    status: &str,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let bearer = presence_bearer(state, machine)?;
    let response = origins::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/projects/{}/origin/presence/beat",
                    machine.project_id
                ))
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(
                    axum::http::header::AUTHORIZATION,
                    format!("Bearer {bearer}"),
                )
                .body(Body::from(
                    json!({ "originId": origin_id, "status": status, "latencyMs": 12 }).to_string(),
                ))?,
        )
        .await?;
    let status = response.status();
    let body: JsonValue =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
    Ok((status, body))
}

/// Every checkout from `pool` so far.
fn pool_gets(pool: &PgPool) -> u64 {
    let statistics = pool.state().statistics;
    statistics.get_direct + statistics.get_waited + statistics.get_timed_out
}

async fn presence_status(pool: &PgPool, origin_id: &Uuid) -> anyhow::Result<(String, i64)> {
    let row = pool
        .get()
        .await?
        .query_one(
            "select status, extract(epoch from now() - last_heartbeat)::bigint as age
             from origin_presence where origin_id = $1",
            &[origin_id],
        )
        .await?;
    Ok((row.get("status"), row.get("age")))
}

/// A beat checks the runtime, the origin's assignment, the origin and its
/// binding, then records the presence, all through one pool checkout instead
/// of one per read.
#[tokio::test]
async fn a_presence_beat_reads_through_one_pool_checkout() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("a_presence_beat_reads_through_one_pool_checkout").await?;
    let project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        let machine = seed_machine(&pool, project_id).await?;
        let state = test_state(&pool, "presence-beat-checkout");

        for status in ["online", "offline"] {
            let gets_before = pool_gets(&pool);
            let (code, body) = beat(&state, &machine, &machine.origin_id, status).await?;
            let gets = pool_gets(&pool) - gets_before;
            assert_eq!(code, StatusCode::OK, "{status} beat: {body}");
            assert_eq!(body["status"], status);
            assert_eq!(body["latencyMs"], 12);
            assert_eq!(gets, 1, "a {status} beat takes one pool checkout");
            let (recorded, age) = presence_status(&pool, &machine.origin_id).await?;
            assert_eq!(recorded, status);
            assert!(age < 5, "the {status} beat did not refresh last_heartbeat");
        }
        Ok(())
    })
    .await
}

/// Each refusal of a beat, in the order the route checks it.
#[tokio::test]
async fn a_presence_beat_keeps_each_refusal() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("a_presence_beat_keeps_each_refusal").await?;
    let project_id = Uuid::new_v4();
    let other_project_id = Uuid::new_v4();
    let fixture = SharedDbFixture {
        projects: vec![project_id, other_project_id],
        ..SharedDbFixture::default()
    };
    with_shared_db_fixture(fixture, async {
        let machine = seed_machine(&pool, project_id).await?;
        let state = test_state(&pool, "presence-beat-refusals");

        // An origin of the space that no instance of this runtime holds.
        let unassigned = register_origin(&pool, &project_id).await?;
        let (code, body) = beat(&state, &machine, &unassigned, "online").await?;
        assert_eq!(code, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body["message"], "origin is not assigned to token runtime");

        // The runtime's instance names an origin registered to another space.
        seed_project(&pool, &other_project_id).await?;
        let foreign = register_origin(&pool, &other_project_id).await?;
        set_instance_origin(&pool, &machine, &foreign).await?;
        let (code, body) = beat(&state, &machine, &foreign, "online").await?;
        assert_eq!(code, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["message"], "origin/project mismatch");
        set_instance_origin(&pool, &machine, &machine.origin_id).await?;

        // A released instance: an online beat is not this runtime's any more,
        // and an offline one is no longer bound to its generation.
        pool.get()
            .await?
            .execute(
                "update origin_instances set status = 'released' where lease_id = $1",
                &[&machine.lease_id],
            )
            .await?;
        let (code, body) = beat(&state, &machine, &machine.origin_id, "online").await?;
        assert_eq!(code, StatusCode::UNAUTHORIZED, "{body}");
        assert_eq!(body["message"], "origin is not assigned to token runtime");
        let (code, body) = beat(&state, &machine, &machine.origin_id, "offline").await?;
        assert_eq!(code, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(
            body["message"],
            "origin is not bound to this runtime generation"
        );

        // A stopped runtime beats nothing.
        pool.get()
            .await?
            .execute(
                "update runtimes set status = 'stopped' where id = $1",
                &[&machine.runtime_id],
            )
            .await?;
        let (code, body) = beat(&state, &machine, &machine.origin_id, "offline").await?;
        assert_eq!(code, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["message"], "runtime is not active");
        Ok(())
    })
    .await
}

async fn set_instance_origin(
    pool: &PgPool,
    machine: &Machine,
    origin_id: &Uuid,
) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "update origin_instances set origin_id = $2 where lease_id = $1",
            &[&machine.lease_id, origin_id],
        )
        .await?;
    Ok(())
}
