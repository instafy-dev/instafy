//! Database-backed tests of releasing the provider runtimes of gone spaces,
//! against a stand-in node provider (census and release).

use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::config::RuntimeProviderConfig;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, spawn_aborting, test_origin_private_key,
    test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};

const PROVIDER_ID: &str = "gone_space_test_provider";

fn container(project_id: Uuid, runtime_id: Option<Uuid>, lease_id: Option<Uuid>) -> JsonValue {
    json!({
        "composeProject": format!("instafy-runtime-{}-{}", project_id.simple(), &Uuid::new_v4().simple().to_string()[..8]),
        "projectId": project_id,
        "runtimeId": runtime_id,
        "leaseId": lease_id,
        "running": true,
    })
}

/// The census lists runtimes of a space that was removed from the database,
/// of a deleted space, of a live space, of a deleted space whose live
/// generation the database still tracks, and one with no generation. Only
/// the first two are released, each with the generation its container runs.
#[tokio::test]
async fn runtimes_of_missing_and_deleted_spaces_are_released_by_generation() -> anyhow::Result<()> {
    let pool = crate::tests::require_origin_test_pool("gone space runtime release test").await?;
    let owner = Uuid::new_v4();
    let (deleted, active, tracked) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let (missing, no_generation) = (Uuid::new_v4(), Uuid::new_v4());
    let fixture = SharedDbFixture {
        projects: vec![deleted, active, tracked],
        ..Default::default()
    };
    let result = with_shared_db_fixture(fixture, async {
        let (missing_runtime, missing_lease) = (Uuid::new_v4(), Uuid::new_v4());
        let (deleted_runtime, deleted_lease) = (Uuid::new_v4(), Uuid::new_v4());
        let (active_runtime, active_lease) = (Uuid::new_v4(), Uuid::new_v4());
        let (tracked_runtime, tracked_lease) = (Uuid::new_v4(), Uuid::new_v4());

        ensure_test_user(&pool, &owner).await?;
        let connection = pool.get().await?;
        for (project, status) in [(deleted, "deleted"), (active, "active"), (tracked, "deleted")] {
            connection
                .execute(
                    "insert into projects (id, project_type, status, owner_user_id)
                     values ($1, 'customer', $2, $3)",
                    &[&project, &status, &owner],
                )
                .await?;
        }
        // The deleted space's runtime row says stopped; its container runs on.
        connection
            .execute(
                "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds)
                 values ($1, $2, $3, 'stopped', 600)",
                &[&deleted_runtime, &deleted, &PROVIDER_ID],
            )
            .await?;
        // The tracked space's runtime still runs that generation: the
        // deleted-space stop releases it, with its flush and its events.
        connection
            .execute(
                "insert into runtimes (id, project_id, provider, status, idle_ttl_seconds)
                 values ($1, $2, $3, 'ready', 600)",
                &[&tracked_runtime, &tracked, &PROVIDER_ID],
            )
            .await?;
        connection
            .execute(
                "insert into runtime_leases
                    (id, project_id, runtime_id, status, requested_at, launched_at)
                 values ($1, $2, $3, 'active', now(), now())",
                &[&tracked_lease, &tracked, &tracked_runtime],
            )
            .await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[&tracked_runtime, &tracked_lease],
            )
            .await?;
        drop(connection);

        let census = json!({
            "supported": true,
            "truncated": false,
            "containers": [
                container(missing, Some(missing_runtime), Some(missing_lease)),
                container(deleted, Some(deleted_runtime), Some(deleted_lease)),
                container(active, Some(active_runtime), Some(active_lease)),
                container(tracked, Some(tracked_runtime), Some(tracked_lease)),
                container(no_generation, Some(Uuid::new_v4()), None),
            ],
        });
        let released: Arc<Mutex<Vec<JsonValue>>> = Arc::default();
        let provider_app = {
            let released = released.clone();
            axum::Router::new()
                .route(
                    "/runtime/census",
                    axum::routing::post(move || {
                        let census = census.clone();
                        async move { Json(census) }
                    }),
                )
                .route(
                    "/runtime/release",
                    axum::routing::post(move |Json(body): Json<JsonValue>| {
                        let released = released.clone();
                        async move {
                            released.lock().unwrap().push(body);
                            StatusCode::NO_CONTENT
                        }
                    }),
                )
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let _provider = spawn_aborting(async move {
            axum::serve(listener, provider_app)
                .await
                .expect("serve stand-in provider");
        });

        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "gone-space-runtimes",
        );
        config.runtime_providers = vec![RuntimeProviderConfig {
            id: PROVIDER_ID.to_string(),
            display_name: "Stand-in node".to_string(),
            kind: "test".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: Some(format!("http://{address}")),
            auth_token: None,
            metadata: None,
        }];
        let state = build_test_state(pool.clone(), config);

        let count = super::release_runtimes_of_gone_spaces(&state).await;

        let released = released.lock().unwrap().clone();
        assert_eq!(count, 2, "{released:?}");
        assert_eq!(
            released,
            vec![
                json!({ "project_id": missing, "runtime_id": missing_runtime, "lease_id": missing_lease }),
                json!({ "project_id": deleted, "runtime_id": deleted_runtime, "lease_id": deleted_lease }),
            ]
        );
        Ok(())
    })
    .await;
    result
}
