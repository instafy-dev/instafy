//! Database-backed tests of deleting a team: its hosted machines are released
//! through their provider while their rows still exist, a team whose release
//! is not confirmed stays until the delete is repeated, and Stripe is asked
//! while the delete holds no connection. Requires `TEST_DATABASE_URL` like the
//! tests in `tests.rs`.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use serde_json::{json, Value as JsonValue};
use tokio::sync::broadcast::Receiver;
use tokio::sync::{watch, Notify};
use tokio::time::timeout;
use tower::ServiceExt as _;
use uuid::Uuid;

use crate::config::{PgPool, RuntimeProviderConfig, StripeConfig};
use crate::state::ControllerEvent;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    require_origin_test_pool_with_max_size, spawn_aborting, test_origin_private_key,
    test_origin_public_key, with_shared_db_fixture, AbortingTask, SharedDbFixture,
};
use crate::AppState;

const PROVIDER_ID: &str = "organization_delete_test";
const SERVICE_ROLE: &str = "service-role-token";

/// A stand-in runtime provider and Stripe on one local server.
struct StandIns {
    endpoint: String,
    /// The runtime each release was for, and whether that runtime's row
    /// still existed when the provider was asked.
    releases: Arc<Mutex<Vec<(Uuid, bool)>>>,
    release_answer: Arc<Mutex<StatusCode>>,
    /// A space `(id, team, owner)` the next release adds before it answers.
    add_space_on_release: Arc<Mutex<Option<(Uuid, Uuid, Uuid)>>>,
    /// The subscription of each Stripe cancel.
    cancels: Arc<Mutex<Vec<String>>>,
    /// While `false`, every Stripe cancel waits.
    stripe_open: watch::Sender<bool>,
    /// Told when Stripe is asked to cancel.
    stripe_asked: Arc<Notify>,
    _server: AbortingTask<()>,
}

impl StandIns {
    async fn serve(pool: PgPool) -> anyhow::Result<Self> {
        let releases = Arc::new(Mutex::new(Vec::new()));
        let release_answer = Arc::new(Mutex::new(StatusCode::NO_CONTENT));
        let add_space_on_release = Arc::new(Mutex::new(None));
        let cancels = Arc::new(Mutex::new(Vec::new()));
        let (stripe_open, open) = watch::channel(true);
        let stripe_asked = Arc::new(Notify::new());
        let app = axum::Router::new()
            .route(
                "/runtime/release",
                axum::routing::post({
                    let releases = releases.clone();
                    let release_answer = release_answer.clone();
                    let add_space_on_release = add_space_on_release.clone();
                    move |body: axum::body::Bytes| {
                        let releases = releases.clone();
                        let release_answer = release_answer.clone();
                        let add_space = add_space_on_release.lock().unwrap().take();
                        let pool = pool.clone();
                        async move {
                            let runtime_id = serde_json::from_slice::<JsonValue>(&body)
                                .ok()
                                .and_then(|body| {
                                    body["runtime_id"]
                                        .as_str()
                                        .and_then(|value| Uuid::parse_str(value).ok())
                                });
                            if let Some(runtime_id) = runtime_id {
                                let row_present = match pool.get().await {
                                    Ok(connection) => connection
                                        .query_one(
                                            "select exists(select 1 from runtimes where id = $1)",
                                            &[&runtime_id],
                                        )
                                        .await
                                        .map(|row| row.get::<_, bool>(0))
                                        .unwrap_or(false),
                                    Err(_) => false,
                                };
                                releases.lock().unwrap().push((runtime_id, row_present));
                            }
                            if let Some((project_id, org_id, owner)) = add_space {
                                insert_space(&pool, project_id, org_id, owner, "active")
                                    .await
                                    .expect("add a space while the release runs");
                            }
                            let answer = *release_answer.lock().unwrap();
                            answer
                        }
                    }
                }),
            )
            .route(
                "/v1/subscriptions/:subscription_id",
                axum::routing::delete({
                    let cancels = cancels.clone();
                    let stripe_asked = stripe_asked.clone();
                    move |axum::extract::Path(subscription_id): axum::extract::Path<String>| {
                        let cancels = cancels.clone();
                        let stripe_asked = stripe_asked.clone();
                        let mut open = open.clone();
                        async move {
                            cancels.lock().unwrap().push(subscription_id.clone());
                            stripe_asked.notify_one();
                            let _ = open.wait_for(|open| *open).await;
                            axum::Json(json!({
                                "id": subscription_id,
                                "object": "subscription",
                                "status": "canceled",
                            }))
                        }
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let endpoint = format!("http://{}", listener.local_addr()?);
        let server = spawn_aborting(async move {
            axum::serve(listener, app)
                .await
                .expect("serve stand-in provider and Stripe");
        });
        Ok(Self {
            endpoint,
            releases,
            release_answer,
            add_space_on_release,
            cancels,
            stripe_open,
            stripe_asked,
            _server: server,
        })
    }

    fn state(&self, pool: &PgPool, name: &str) -> AppState {
        let mut config =
            build_app_config(test_origin_private_key(), test_origin_public_key(), name);
        config.runtime_providers = vec![RuntimeProviderConfig {
            id: PROVIDER_ID.to_string(),
            display_name: "Stand-in provider".to_string(),
            kind: "test".to_string(),
            owner_org_id: None,
            allowed_org_ids: vec![],
            endpoint: Some(self.endpoint.clone()),
            auth_token: None,
            metadata: None,
        }];
        config.stripe = Some(StripeConfig {
            secret_key: "sk_test_team_delete".to_string(),
            api_base_url: self.endpoint.clone(),
            price_lookup: HashMap::new(),
            webhook_secret: None,
            portal_configuration_id: None,
            webhook_tolerance_seconds: 300,
            checkout_tos_consent: false,
        });
        build_test_state(pool.clone(), config)
    }

    /// For each release of `runtime_id` so far, whether its row still existed.
    fn releases_of(&self, runtime_id: Uuid) -> Vec<bool> {
        self.releases
            .lock()
            .unwrap()
            .iter()
            .filter(|(released, _)| *released == runtime_id)
            .map(|(_, row_present)| *row_present)
            .collect()
    }

    fn answer_releases_with(&self, answer: StatusCode) {
        *self.release_answer.lock().unwrap() = answer;
    }

    fn cancels(&self) -> Vec<String> {
        self.cancels.lock().unwrap().clone()
    }
}

/// A team owned by `owner`, with `member` as a builder.
async fn insert_team(
    pool: &PgPool,
    org_id: Uuid,
    owner: Uuid,
    member: Option<Uuid>,
) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into organizations (id, slug, name) values ($1, $2, 'Team delete')",
            &[&org_id, &format!("team-delete-{org_id}")],
        )
        .await?;
    connection
        .execute(
            "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
            &[&org_id, &owner],
        )
        .await?;
    if let Some(member) = member {
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'builder')",
                &[&org_id, &member],
            )
            .await?;
    }
    Ok(())
}

async fn insert_space(
    pool: &PgPool,
    project_id: Uuid,
    org_id: Uuid,
    owner: Uuid,
    status: &str,
) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "insert into projects (id, org_id, name, owner_user_id, project_type, status)
             values ($1, $2, 'Team delete space', $3, 'customer', $4)",
            &[&project_id, &org_id, &owner, &status],
        )
        .await?;
    Ok(())
}

/// A ready runtime of the stand-in provider on an active lease generation.
async fn insert_hosted_runtime(pool: &PgPool, project_id: Uuid) -> anyhow::Result<(Uuid, Uuid)> {
    let runtime_id = Uuid::new_v4();
    let lease_id = Uuid::new_v4();
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into runtimes
                (id, project_id, provider, status, endpoint_url, idle_ttl_seconds, last_seen_at)
             values ($1, $2, $3, 'ready', 'http://runtime.test', 600, now())",
            &[&runtime_id, &project_id, &PROVIDER_ID],
        )
        .await?;
    connection
        .execute(
            "insert into runtime_leases
                (id, project_id, runtime_id, status, requested_at, launched_at)
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
    Ok((runtime_id, lease_id))
}

fn token(state: &AppState, user_id: Uuid) -> anyhow::Result<String> {
    Ok(crate::auth::issue_controller_token(&state.config, &user_id)
        .map_err(|(status, axum::Json(error))| {
            anyhow::anyhow!("issue token: {status} {}", error.message)
        })?
        .token)
}

/// `DELETE /orgs/:id` with `bearer`: the status and the JSON body, if any.
async fn delete_team(
    state: AppState,
    org_id: Uuid,
    bearer: String,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let response = crate::projects::router()
        .with_state(state)
        .oneshot(
            Request::builder()
                .method("DELETE")
                .uri(format!("/orgs/{org_id}"))
                .header(header::AUTHORIZATION, format!("Bearer {bearer}"))
                .body(Body::empty())?,
        )
        .await?;
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await?;
    Ok((
        status,
        serde_json::from_slice(&body).unwrap_or(JsonValue::Null),
    ))
}

fn drain(events: &mut Receiver<ControllerEvent>) -> Vec<ControllerEvent> {
    let mut drained = Vec::new();
    while let Ok(event) = events.try_recv() {
        drained.push(event);
    }
    drained
}

/// The `(reason, deleted space or team, user told)` of each deletion event,
/// in the order they were published.
fn deletions(events: &[ControllerEvent]) -> Vec<(String, Uuid, Uuid)> {
    events
        .iter()
        .filter(|event| event.kind == "project.access_changed")
        .filter_map(|event| {
            let reason = event.data["reason"].as_str()?.to_string();
            let id = event.data["projectId"]
                .as_str()
                .or_else(|| event.data["orgId"].as_str())
                .and_then(|id| Uuid::parse_str(id).ok())?;
            Some((reason, id, event.target_user_id?))
        })
        .collect()
}

/// The users told of `reason` about `id`.
fn told(deletions: &[(String, Uuid, Uuid)], reason: &str, id: Uuid) -> BTreeSet<Uuid> {
    deletions
        .iter()
        .filter(|(told_reason, told_id, _)| told_reason == reason && *told_id == id)
        .map(|(_, _, user_id)| *user_id)
        .collect()
}

async fn count(pool: &PgPool, table: &str, ids: &[Uuid]) -> anyhow::Result<i64> {
    Ok(pool
        .get()
        .await?
        .query_one(
            &format!("select count(*) from {table} where id = any($1)"),
            &[&ids.to_vec()],
        )
        .await?
        .get(0))
}

async fn delete_users(pool: &PgPool, users: &[Uuid]) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "delete from auth.users where id = any($1)",
            &[&users.to_vec()],
        )
        .await?;
    Ok(())
}

/// Deleting a team releases every hosted machine of its spaces through the
/// provider, each while its runtime's row still exists, before the team's
/// row and everything that cascades from it go. That includes a machine of
/// a space deleted on its own before. Each space the delete marked deleted
/// is announced to everyone who could see it, then the team's deletion to
/// everyone who could see the team or one of its spaces. No
/// `runtime.stopped` goes out.
#[tokio::test]
async fn deleting_a_team_releases_its_hosted_machines_before_their_rows_go() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("team delete machine release test").await?;
    let org_id = Uuid::new_v4();
    let (owner, member, guest) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let (first, second, deleted_before) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let fixture = SharedDbFixture {
        organizations: vec![org_id],
        projects: vec![first, second, deleted_before],
    };
    let result = with_shared_db_fixture(fixture, async {
        for user_id in [owner, member, guest] {
            ensure_test_user(&pool, &user_id).await?;
        }
        insert_team(&pool, org_id, owner, Some(member)).await?;
        insert_space(&pool, first, org_id, owner, "active").await?;
        insert_space(&pool, second, org_id, owner, "active").await?;
        insert_space(&pool, deleted_before, org_id, owner, "deleted").await?;
        pool.get()
            .await?
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&first, &guest],
            )
            .await?;
        let (first_runtime, _) = insert_hosted_runtime(&pool, first).await?;
        let (second_runtime, _) = insert_hosted_runtime(&pool, second).await?;
        let (earlier_runtime, _) = insert_hosted_runtime(&pool, deleted_before).await?;
        let stand_ins = StandIns::serve(pool.clone()).await?;
        let state = stand_ins.state(&pool, "team-delete-release");
        let mut events = state.events.subscribe();

        let (status, body) = delete_team(state.clone(), org_id, token(&state, owner)?).await?;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

        for runtime_id in [first_runtime, second_runtime, earlier_runtime] {
            assert_eq!(
                stand_ins.releases_of(runtime_id),
                vec![true],
                "runtime {runtime_id} was released once, while its row still existed"
            );
        }
        assert_eq!(count(&pool, "organizations", &[org_id]).await?, 0);
        assert_eq!(
            count(&pool, "projects", &[first, second, deleted_before]).await?,
            0
        );
        assert_eq!(
            count(
                &pool,
                "runtimes",
                &[first_runtime, second_runtime, earlier_runtime]
            )
            .await?,
            0
        );

        let published = drain(&mut events);
        assert!(
            !published
                .iter()
                .any(|event| event.kind == "runtime.stopped"),
            "{published:?}"
        );
        let deletions = deletions(&published);
        assert_eq!(
            told(&deletions, "space_deleted", first),
            BTreeSet::from([owner, member, guest])
        );
        assert_eq!(
            told(&deletions, "space_deleted", second),
            BTreeSet::from([owner, member])
        );
        assert!(
            told(&deletions, "space_deleted", deleted_before).is_empty(),
            "a space deleted before was announced by its own delete"
        );
        assert_eq!(
            told(&deletions, "team_deleted", org_id),
            BTreeSet::from([owner, member, guest])
        );
        assert_eq!(deletions.len(), 3 + 2 + 3, "{deletions:?}");
        let first_team_event = deletions
            .iter()
            .position(|(reason, _, _)| reason == "team_deleted")
            .expect("team deletion published");
        assert!(
            deletions[..first_team_event]
                .iter()
                .all(|(reason, _, _)| reason == "space_deleted")
                && deletions[first_team_event..]
                    .iter()
                    .all(|(reason, _, _)| reason == "team_deleted"),
            "every space's deletion goes out before the team's: {deletions:?}"
        );
        Ok(())
    })
    .await;
    result.and(delete_users(&pool, &[owner, member, guest]).await)
}

/// A team whose machine the provider did not release stays, with its spaces
/// deleted and announced, and the delete answers 409 for a repeat to finish.
/// A repeat while the failed release may still be in flight leaves the
/// machine alone; once that grace is over, a repeat releases it and deletes
/// the team. Stripe, canceled by the first delete, is not asked again. A
/// service-role repeat after the team is gone still answers 204.
#[tokio::test]
async fn a_team_whose_machine_is_not_released_stays_until_the_delete_is_repeated(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("team delete refused release test").await?;
    let org_id = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let subscription_id = format!("sub_team_delete_{}", Uuid::new_v4().simple());
    let fixture = SharedDbFixture {
        organizations: vec![org_id],
        projects: vec![project_id],
    };
    let result = with_shared_db_fixture(fixture, async {
        ensure_test_user(&pool, &owner).await?;
        insert_team(&pool, org_id, owner, None).await?;
        insert_space(&pool, project_id, org_id, owner, "active").await?;
        let (runtime_id, lease_id) = insert_hosted_runtime(&pool, project_id).await?;
        pool.get()
            .await?
            .execute(
                "insert into org_subscriptions
                     (id, org_id, processor, external_id, status, currency, credit_limit, billing_cycle)
                 values ($1, $2, 'stripe', $3, 'active', 'usd', 1000, 'pro')",
                &[&Uuid::new_v4(), &org_id, &subscription_id],
            )
            .await?;
        let stand_ins = StandIns::serve(pool.clone()).await?;
        stand_ins.answer_releases_with(StatusCode::INTERNAL_SERVER_ERROR);
        let state = stand_ins.state(&pool, "team-delete-refused-release");
        let mut events = state.events.subscribe();

        let (status, body) = delete_team(state.clone(), org_id, SERVICE_ROLE.to_string()).await?;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], "team_delete_incomplete");
        assert_eq!(stand_ins.releases_of(runtime_id), vec![true]);
        assert_eq!(stand_ins.cancels(), vec![subscription_id.clone()]);
        let connection = pool.get().await?;
        let space_status: String = connection
            .query_one("select status from projects where id = $1", &[&project_id])
            .await?
            .get(0);
        assert_eq!(space_status, "deleted");
        let (active_lease_id, lease_status): (Option<Uuid>, String) = {
            let row = connection
                .query_one(
                    "select r.active_lease_id, l.status
                     from runtimes r, runtime_leases l
                     where r.id = $1 and l.id = $2",
                    &[&runtime_id, &lease_id],
                )
                .await?;
            (row.get(0), row.get(1))
        };
        assert_eq!(active_lease_id, Some(lease_id));
        assert_eq!(lease_status, "cleanup_pending");
        let subscription_status: String = connection
            .query_one(
                "select status from org_subscriptions where external_id = $1",
                &[&subscription_id],
            )
            .await?
            .get(0);
        assert_eq!(subscription_status, "canceled");
        drop(connection);
        assert_eq!(count(&pool, "organizations", &[org_id]).await?, 1);
        let deletions = deletions(&drain(&mut events));
        assert_eq!(
            deletions,
            vec![("space_deleted".to_string(), project_id, owner)],
            "the space's deletion goes out even though the team stays"
        );

        let (status, _) = delete_team(state.clone(), org_id, SERVICE_ROLE.to_string()).await?;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            stand_ins.releases_of(runtime_id),
            vec![true],
            "the failed release may still be in flight"
        );

        pool.get()
            .await?
            .execute(
                "update runtime_events set created_at = now() - interval '10 minutes'
                 where runtime_id = $1 and kind = 'provider_release_cleanup_pending'",
                &[&runtime_id],
            )
            .await?;
        stand_ins.answer_releases_with(StatusCode::NO_CONTENT);
        let (status, body) = delete_team(state.clone(), org_id, SERVICE_ROLE.to_string()).await?;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
        assert_eq!(stand_ins.releases_of(runtime_id), vec![true, true]);
        assert_eq!(
            stand_ins.cancels(),
            vec![subscription_id.clone()],
            "the cancel the first delete recorded is not repeated"
        );
        assert_eq!(count(&pool, "organizations", &[org_id]).await?, 0);
        assert_eq!(count(&pool, "runtimes", &[runtime_id]).await?, 0);
        assert_eq!(
            deletions_of(&mut events),
            vec![("team_deleted".to_string(), org_id, owner)]
        );

        let (status, _) = delete_team(state.clone(), org_id, SERVICE_ROLE.to_string()).await?;
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(deletions_of(&mut events).is_empty());
        Ok(())
    })
    .await;
    result.and(delete_users(&pool, &[owner]).await)
}

fn deletions_of(events: &mut Receiver<ControllerEvent>) -> Vec<(String, Uuid, Uuid)> {
    deletions(&drain(events))
}

/// Stripe can take a while to answer, and the delete must not hold a
/// database connection meanwhile: on a pool of one, the only slot is free
/// while Stripe holds the cancel.
#[tokio::test]
async fn a_team_delete_asks_stripe_holding_no_connection() -> anyhow::Result<()> {
    let pool = require_origin_test_pool_with_max_size(
        "a_team_delete_asks_stripe_holding_no_connection",
        1,
    )
    .await?;
    let org_id = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let subscription_id = format!("sub_team_delete_{}", Uuid::new_v4().simple());
    let fixture = SharedDbFixture {
        organizations: vec![org_id],
        projects: vec![project_id],
    };
    let body_pool = pool.clone();
    let result = with_shared_db_fixture(fixture, async {
        let pool = body_pool;
        ensure_test_user(&pool, &owner).await?;
        insert_team(&pool, org_id, owner, None).await?;
        insert_space(&pool, project_id, org_id, owner, "active").await?;
        pool.get()
            .await?
            .execute(
                "insert into org_subscriptions
                     (id, org_id, processor, external_id, status, currency, credit_limit, billing_cycle)
                 values ($1, $2, 'stripe', $3, 'active', 'usd', 1000, 'pro')",
                &[&Uuid::new_v4(), &org_id, &subscription_id],
            )
            .await?;
        let stand_ins = StandIns::serve(pool.clone()).await?;
        stand_ins.stripe_open.send_replace(false);
        let state = stand_ins.state(&pool, "team-delete-stripe-pool");

        let deleting = spawn_aborting(delete_team(state.clone(), org_id, token(&state, owner)?));
        timeout(Duration::from_secs(10), stand_ins.stripe_asked.notified())
            .await
            .map_err(|_| anyhow::anyhow!("Stripe was never asked to cancel"))?;
        let free = timeout(Duration::from_secs(2), pool.get()).await;
        assert!(
            matches!(free, Ok(Ok(_))),
            "the delete held the only connection while Stripe answered"
        );
        drop(free);
        stand_ins.stripe_open.send_replace(true);

        let (status, body) = timeout(Duration::from_secs(20), deleting).await???;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
        assert_eq!(stand_ins.cancels(), vec![subscription_id.clone()]);
        assert_eq!(count(&pool, "organizations", &[org_id]).await?, 0);
        Ok(())
    })
    .await;
    result.and(delete_users(&pool, &[owner]).await)
}

/// A space added to the team while its machines are released, after its
/// spaces were marked deleted, keeps the team: deleting the team would take
/// the new space, and any machine it started, with it unannounced. The delete
/// answers 409, and a repeat marks the new space deleted, announces it and
/// deletes the team.
#[tokio::test]
async fn a_space_added_while_the_machines_are_released_keeps_the_team() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("team delete added space test").await?;
    let org_id = Uuid::new_v4();
    let owner = Uuid::new_v4();
    let (project_id, added_id) = (Uuid::new_v4(), Uuid::new_v4());
    let fixture = SharedDbFixture {
        organizations: vec![org_id],
        projects: vec![project_id, added_id],
    };
    let result = with_shared_db_fixture(fixture, async {
        ensure_test_user(&pool, &owner).await?;
        insert_team(&pool, org_id, owner, None).await?;
        insert_space(&pool, project_id, org_id, owner, "active").await?;
        let (runtime_id, _) = insert_hosted_runtime(&pool, project_id).await?;
        let stand_ins = StandIns::serve(pool.clone()).await?;
        *stand_ins.add_space_on_release.lock().unwrap() = Some((added_id, org_id, owner));
        let state = stand_ins.state(&pool, "team-delete-added-space");
        let mut events = state.events.subscribe();

        let (status, body) = delete_team(state.clone(), org_id, token(&state, owner)?).await?;
        assert_eq!(status, StatusCode::CONFLICT, "{body}");
        assert_eq!(body["code"], "team_delete_incomplete");
        assert_eq!(stand_ins.releases_of(runtime_id), vec![true]);
        assert_eq!(count(&pool, "organizations", &[org_id]).await?, 1);
        assert_eq!(
            deletions_of(&mut events),
            vec![("space_deleted".to_string(), project_id, owner)]
        );

        let (status, body) = delete_team(state.clone(), org_id, token(&state, owner)?).await?;
        assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
        assert_eq!(count(&pool, "organizations", &[org_id]).await?, 0);
        assert_eq!(count(&pool, "projects", &[project_id, added_id]).await?, 0);
        assert_eq!(
            deletions_of(&mut events),
            vec![
                ("space_deleted".to_string(), added_id, owner),
                ("team_deleted".to_string(), org_id, owner),
            ]
        );
        Ok(())
    })
    .await;
    result.and(delete_users(&pool, &[owner]).await)
}
