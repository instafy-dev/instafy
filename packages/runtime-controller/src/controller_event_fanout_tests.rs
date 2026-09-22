//! `project.members_changed` and `credits.updated`: published per project,
//! only after the mutating transaction commits, and signal-only so a project
//! viewer learns nothing it could not already fetch. Org roster changes reach
//! org members only, `credits.updated` is spaced per org, and a node's
//! broadcast carries signals only for projects one of its streams watches.

use super::*;
use crate::state::{
    publish_project_signal, ControllerEvent, EventHub, ProjectWatch, SignalAdmission,
    SignalCoalescer, CREDITS_UPDATED_INTERVAL,
};
use futures_util::FutureExt;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::task::Poll;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio_postgres::types::ToSql;

const MEMBERS_CHANGED: &str = "project.members_changed";
const CREDITS_UPDATED: &str = "credits.updated";
const SERVICE_ROLE: &str = "service-role-token";

/// Everything published so far, waiting briefly for stragglers. Handlers
/// publish before their response returns, so a short window is enough.
async fn drain(events: &mut broadcast::Receiver<ControllerEvent>) -> Vec<ControllerEvent> {
    let mut drained = Vec::new();
    loop {
        match timeout(Duration::from_millis(250), events.recv()).await {
            Ok(Ok(event)) => drained.push(event),
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(broadcast::error::RecvError::Closed)) | Err(_) => return drained,
        }
    }
}

/// Everything published within `window`, for signals that trail.
async fn collect_for(
    events: &mut broadcast::Receiver<ControllerEvent>,
    window: Duration,
) -> Vec<ControllerEvent> {
    let deadline = tokio::time::Instant::now() + window;
    let mut collected = Vec::new();
    loop {
        match tokio::time::timeout_at(deadline, events.recv()).await {
            Ok(Ok(event)) => collected.push(event),
            Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
            Ok(Err(broadcast::error::RecvError::Closed)) | Err(_) => return collected,
        }
    }
}

/// How many `kind` events each project received, after checking every such
/// event is an untargeted signal whose payload is exactly
/// `{ "reason": reason }`.
fn signal_counts(events: &[ControllerEvent], kind: &str, reason: &str) -> BTreeMap<Uuid, usize> {
    let mut counts = BTreeMap::new();
    for event in events.iter().filter(|event| event.kind == kind) {
        assert_eq!(event.data, json!({ "reason": reason }), "{kind} payload");
        assert_eq!(event.target_user_id, None);
        assert_eq!(event.session_id, None);
        assert_eq!(event.conversation_id, None);
        assert_eq!(event.run_id, None);
        assert_eq!(event.job_id, None);
        assert_eq!(event.channel, None);
        assert!(event.channels.is_empty());
        *counts
            .entry(event.project_id.expect("signals are project scoped"))
            .or_insert(0) += 1;
    }
    counts
}

/// The projects that received `kind` (see `signal_counts`).
fn signalled_projects(events: &[ControllerEvent], kind: &str, reason: &str) -> BTreeSet<Uuid> {
    signal_counts(events, kind, reason).into_keys().collect()
}

fn once_each(ids: &[Uuid]) -> BTreeMap<Uuid, usize> {
    ids.iter().map(|id| (*id, 1)).collect()
}

/// Project signals reach a node's broadcast only for watched projects, as
/// an open `/events` stream would watch them.
fn watch(events: &EventHub, projects: &[Uuid]) -> Vec<ProjectWatch> {
    projects
        .iter()
        .map(|project_id| events.watch_project(*project_id))
        .collect()
}

fn project_set(ids: &[Uuid]) -> BTreeSet<Uuid> {
    ids.iter().copied().collect()
}

fn json_request(
    method: &str,
    uri: &str,
    bearer: &str,
    body: Option<serde_json::Value>,
) -> anyhow::Result<Request<Body>> {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {bearer}"));
    Ok(match body {
        Some(value) => request
            .header("content-type", "application/json")
            .body(Body::from(value.to_string()))?,
        None => request.body(Body::empty())?,
    })
}

async fn send(
    app: &axum::Router,
    method: &str,
    uri: &str,
    bearer: &str,
    body: Option<serde_json::Value>,
) -> anyhow::Result<StatusCode> {
    let request = json_request(method, uri, bearer, body)?;
    Ok(app.clone().oneshot(request).await?.status())
}

/// What to read from the database at the instant a signal is published.
pub(crate) struct PublishProbe {
    pub(crate) events: broadcast::Receiver<ControllerEvent>,
    pub(crate) kind: &'static str,
    pub(crate) project_id: Uuid,
    pub(crate) count_sql: &'static str,
    pub(crate) params: Vec<Uuid>,
}

/// Counts rows from a fresh connection on another thread while this thread
/// (and so every task of this current-thread test runtime, including the
/// handler's own connection driver) stays blocked.
fn count_while_runtime_blocked(sql: &'static str, params: Vec<Uuid>) -> anyhow::Result<i64> {
    let url = std::env::var("TEST_DATABASE_URL")?;
    std::thread::spawn(move || -> anyhow::Result<i64> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        runtime.block_on(async move {
            let (client, connection) = tokio_postgres::connect(&url, NoTls).await?;
            let driver = tokio::spawn(connection);
            let params = params
                .iter()
                .map(|value| value as &(dyn ToSql + Sync))
                .collect::<Vec<_>>();
            let count = client.query_one(sql, &params).await?.get::<_, i64>(0);
            drop(client);
            let _ = driver.await;
            Ok(count)
        })
    })
    .join()
    .map_err(|_| anyhow::anyhow!("probe thread panicked"))?
}

/// Drives `request` one poll at a time and, as soon as the probed signal has
/// been published, counts rows before any other task may run. A handler that
/// published inside its transaction would at that point be parked on a
/// COMMIT its connection driver has not even sent, so the count would still
/// show the pre-change state. A publish from a detached task may land after
/// the response, so the other tasks keep being driven, one yield at a time,
/// for a bounded while. Returns the response and the count at publish.
pub(crate) async fn send_probed(
    app: &axum::Router,
    request: Request<Body>,
    mut probe: PublishProbe,
) -> anyhow::Result<(axum::response::Response, i64)> {
    let mut pending = std::pin::pin!(app.clone().oneshot(request));
    let mut response = None;
    let mut observed = None;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if response.is_none() {
            let poll = std::future::poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx))).await;
            if let Poll::Ready(result) = poll {
                response = Some(result?);
            }
        }
        while observed.is_none() {
            match probe.events.try_recv() {
                Ok(event)
                    if event.kind == probe.kind && event.project_id == Some(probe.project_id) =>
                {
                    observed = Some(count_while_runtime_blocked(
                        probe.count_sql,
                        probe.params.clone(),
                    )?);
                }
                Ok(_) | Err(broadcast::error::TryRecvError::Lagged(_)) => continue,
                Err(_) => break,
            }
        }
        if response.is_some() && (observed.is_some() || tokio::time::Instant::now() >= deadline) {
            break;
        }
        tokio::task::yield_now().await;
    }
    let response = response.expect("the loop ends only after the response");
    let count = observed.ok_or_else(|| anyhow::anyhow!("{} was never published", probe.kind))?;
    Ok((response, count))
}

async fn insert_org(pool: &PgPool, org_id: Uuid, owner: Uuid) -> anyhow::Result<()> {
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into organizations (id, slug, name) values ($1, $2, 'Event fan-out')",
            &[&org_id, &format!("event-fanout-{org_id}")],
        )
        .await?;
    connection
        .execute(
            "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
            &[&org_id, &owner],
        )
        .await?;
    Ok(())
}

async fn insert_project(
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
             values ($1, $2, 'Event fan-out space', $3, 'customer', $4)",
            &[&project_id, &org_id, &owner, &status],
        )
        .await?;
    Ok(())
}

async fn insert_project_member(
    pool: &PgPool,
    project_id: Uuid,
    user_id: Uuid,
    role: &str,
) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "insert into project_memberships (project_id, user_id, role) values ($1, $2, $3)",
            &[&project_id, &user_id, &role],
        )
        .await?;
    Ok(())
}

async fn set_org_balance(pool: &PgPool, org_id: Uuid, balance: i32) -> anyhow::Result<()> {
    pool.get()
        .await?
        .execute(
            "insert into org_credit_balances (org_id, balance, credit_limit) values ($1, $2, 0)
             on conflict (org_id) do update
             set balance = excluded.balance, credit_limit = 0, updated_at = now()",
            &[&org_id, &balance],
        )
        .await?;
    Ok(())
}

fn user_token(config: &AppConfig, user_id: &Uuid) -> anyhow::Result<String> {
    Ok(crate::auth::issue_controller_token(config, user_id)
        .map_err(|error| controller_error("issue event fan-out token", error))?
        .token)
}

fn fanout_config(key_id: &str) -> AppConfig {
    build_app_config(test_origin_private_key(), test_origin_public_key(), key_id)
}

/// Rows a test creates in the shared database, removed even when an
/// assertion fails. Deleting an org cascades to its projects, memberships,
/// balance, ledger and subscription.
#[derive(Default)]
struct Fixtures {
    orgs: Vec<Uuid>,
    users: Vec<Uuid>,
    webhook_events: Vec<String>,
}

async fn with_cleanup(
    pool: &PgPool,
    fixtures: Fixtures,
    body: impl Future<Output = anyhow::Result<()>>,
) -> anyhow::Result<()> {
    let outcome = std::panic::AssertUnwindSafe(body).catch_unwind().await;
    for event_id in &fixtures.webhook_events {
        pool.get()
            .await?
            .execute(
                "delete from billing_webhook_events where event_id = $1",
                &[event_id],
            )
            .await?;
    }
    for org_id in &fixtures.orgs {
        cleanup_org(pool, org_id).await?;
    }
    for user_id in &fixtures.users {
        cleanup_test_user(pool, user_id).await?;
    }
    match outcome {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[test]
fn project_signal_is_one_untargeted_reason_only_event_per_project() {
    let hub = EventHub::new();
    let mut events = hub.subscribe();
    let projects = [Uuid::new_v4(), Uuid::new_v4()];
    let _watches = watch(&hub, &projects);

    publish_project_signal(&hub, MEMBERS_CHANGED, &projects, "org_membership");

    let mut published = Vec::new();
    while let Ok(event) = events.try_recv() {
        published.push(event);
    }
    assert_eq!(published.len(), 2);
    assert_eq!(
        signalled_projects(&published, MEMBERS_CHANGED, "org_membership"),
        project_set(&projects)
    );
}

/// An org-wide fan-out must not flood the broadcast every stream on the node
/// shares: only projects a stream here watches enter it, while the bus to
/// other nodes still carries every project, and they filter the same way.
#[test]
fn project_signals_skip_unwatched_projects_locally_but_not_on_the_bus() {
    let (outbound, mut bus) = tokio::sync::mpsc::channel(16);
    let hub = EventHub::new_with_outbound(outbound);
    let mut events = hub.subscribe();
    let watched = Uuid::new_v4();
    let unwatched = [Uuid::new_v4(), Uuid::new_v4()];
    let mut all = vec![watched];
    all.extend(unwatched);
    let first = hub.watch_project(watched);
    let second = hub.watch_project(watched);

    publish_project_signal(&hub, CREDITS_UPDATED, &all, "ledger");
    let mut local = Vec::new();
    while let Ok(event) = events.try_recv() {
        local.push(event);
    }
    assert_eq!(
        signal_counts(&local, CREDITS_UPDATED, "ledger"),
        once_each(&[watched])
    );
    let mut carried = Vec::new();
    while let Ok(event) = bus.try_recv() {
        carried.push(event);
    }
    assert_eq!(
        signal_counts(&carried, CREDITS_UPDATED, "ledger"),
        once_each(&all)
    );

    // Another node's copy takes the same local check.
    for event in carried {
        hub.publish_local(event);
    }
    let mut relayed = Vec::new();
    while let Ok(event) = events.try_recv() {
        relayed.push(event);
    }
    assert_eq!(
        signal_counts(&relayed, CREDITS_UPDATED, "ledger"),
        once_each(&[watched])
    );

    // Other events are untouched, and the project stays watched until its
    // last stream is gone.
    publish_controller_event(
        &hub,
        "run.queued",
        Some(unwatched[0]),
        None,
        None,
        None,
        json!({}),
    );
    assert_eq!(
        events.try_recv().map(|event| event.kind).ok().as_deref(),
        Some("run.queued")
    );
    drop(first);
    publish_project_signal(&hub, CREDITS_UPDATED, &[watched], "ledger");
    assert!(events.try_recv().is_ok(), "one stream still watches it");
    drop(second);
    publish_project_signal(&hub, CREDITS_UPDATED, &[watched], "ledger");
    assert!(events.try_recv().is_err(), "no stream watches it any more");
}

#[test]
fn credit_signal_coalescer_publishes_first_then_one_trailing_per_interval() {
    let second = Duration::from_secs(1);
    let coalescer = SignalCoalescer::new(2 * second);
    let org = Uuid::new_v4();
    let other_org = Uuid::new_v4();
    let t0 = tokio::time::Instant::now();

    assert_eq!(coalescer.admit(org, "ledger", t0), SignalAdmission::Now);
    assert_eq!(
        coalescer.admit(other_org, "ledger", t0),
        SignalAdmission::Now
    );
    // Inside the interval: one trailing publish at its end, and every later
    // change folds into it instead of publishing or being dropped.
    assert_eq!(
        coalescer.admit(org, "ledger", t0 + second / 2),
        SignalAdmission::Trailing(3 * second / 2)
    );
    assert_eq!(
        coalescer.admit(org, "subscription", t0 + second),
        SignalAdmission::Coalesced
    );
    // The trailing publish carries the newest reason and restarts the interval.
    assert_eq!(
        coalescer.take_trailing(org, t0 + 2 * second),
        Some("subscription")
    );
    assert_eq!(coalescer.take_trailing(org, t0 + 2 * second), None);
    assert_eq!(
        coalescer.admit(org, "ledger", t0 + 3 * second),
        SignalAdmission::Trailing(second)
    );
    assert_eq!(
        coalescer.take_trailing(org, t0 + 4 * second),
        Some("ledger")
    );
    // After a quiet interval the next change publishes at once again.
    assert_eq!(
        coalescer.admit(org, "ledger", t0 + 6 * second),
        SignalAdmission::Now
    );
    assert_eq!(
        coalescer.admit(other_org, "ledger", t0 + 6 * second),
        SignalAdmission::Now
    );
}

#[tokio::test]
async fn project_member_changes_publish_members_changed_after_commit() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("project.members_changed publication").await?;
    let owner = Uuid::new_v4();
    let member = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let sibling_project_id = Uuid::new_v4();
    let fixtures = Fixtures {
        orgs: vec![org_id],
        users: vec![member, owner],
        ..Fixtures::default()
    };
    with_cleanup(&pool, fixtures, async {
        ensure_test_user(&pool, &owner).await?;
        ensure_test_user(&pool, &member).await?;
        insert_org(&pool, org_id, owner).await?;
        insert_project(&pool, project_id, org_id, owner, "active").await?;
        insert_project(&pool, sibling_project_id, org_id, owner, "active").await?;
        insert_project_member(&pool, project_id, member, "builder").await?;

        let config = fanout_config("project-members-changed");
        let owner_token = user_token(&config, &owner)?;
        let state = build_test_state(pool.clone(), config);
        let _watches = watch(&state.events, &[project_id, sibling_project_id]);
        let mut events = state.events.subscribe();
        let app = projects::router().with_state(state.clone());
        let member_uri = format!("/projects/{project_id}/members/{member}");

        // A role change keeps the targeted access invalidation and tells every
        // viewer of this space (not its sibling) that the roster changed.
        let (response, viewers_at_publish) = send_probed(
            &app,
            json_request(
                "PATCH",
                &member_uri,
                &owner_token,
                Some(json!({ "role": "viewer" })),
            )?,
            PublishProbe {
                events: state.events.subscribe(),
                kind: MEMBERS_CHANGED,
                project_id,
                count_sql: "select count(*) from project_memberships
                            where project_id = $1 and user_id = $2 and role = 'viewer'",
                params: vec![project_id, member],
            },
        )
        .await?;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(viewers_at_publish, 1, "published before the role commit");
        let published = drain(&mut events).await;
        assert_eq!(
            signalled_projects(&published, MEMBERS_CHANGED, "project_membership"),
            project_set(&[project_id])
        );
        let access = published
            .iter()
            .find(|event| event.kind == "project.access_changed")
            .expect("targeted access invalidation still published");
        assert_eq!(access.target_user_id, Some(member));
        assert_eq!(access.data, json!({ "reason": "membership_changed" }));

        // A removal that finds nothing rolls back and publishes nothing.
        let missing_uri = format!("/projects/{project_id}/members/{}", Uuid::new_v4());
        let status = send(&app, "DELETE", &missing_uri, &owner_token, None).await?;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let published = drain(&mut events).await;
        assert!(
            published.is_empty(),
            "failed removal published {published:?}"
        );

        let (response, members_at_publish) = send_probed(
            &app,
            json_request("DELETE", &member_uri, &owner_token, None)?,
            PublishProbe {
                events: state.events.subscribe(),
                kind: MEMBERS_CHANGED,
                project_id,
                count_sql: "select count(*) from project_memberships
                            where project_id = $1 and user_id = $2",
                params: vec![project_id, member],
            },
        )
        .await?;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(members_at_publish, 0, "published before the removal commit");
        assert_eq!(
            signalled_projects(
                &drain(&mut events).await,
                MEMBERS_CHANGED,
                "project_membership"
            ),
            project_set(&[project_id])
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn org_member_changes_fan_members_changed_out_to_live_org_projects() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("org project.members_changed fan-out").await?;
    let owner = Uuid::new_v4();
    let newcomer = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let other_org_id = Uuid::new_v4();
    let live_projects = [Uuid::new_v4(), Uuid::new_v4()];
    let fixtures = Fixtures {
        orgs: vec![org_id, other_org_id],
        users: vec![newcomer, owner],
        ..Fixtures::default()
    };
    with_cleanup(&pool, fixtures, async {
        ensure_test_user(&pool, &owner).await?;
        ensure_test_user(&pool, &newcomer).await?;
        insert_org(&pool, org_id, owner).await?;
        insert_org(&pool, other_org_id, owner).await?;
        for project_id in live_projects {
            insert_project(&pool, project_id, org_id, owner, "active").await?;
        }
        // Watched below, so a signal to either would be seen.
        let deleted_project = Uuid::new_v4();
        let foreign_project = Uuid::new_v4();
        insert_project(&pool, deleted_project, org_id, owner, "deleted").await?;
        insert_project(&pool, foreign_project, other_org_id, owner, "active").await?;

        let config = fanout_config("org-members-changed");
        let owner_token = user_token(&config, &owner)?;
        let state = build_test_state(pool.clone(), config);
        let mut watched = live_projects.to_vec();
        watched.extend([deleted_project, foreign_project]);
        let _watches = watch(&state.events, &watched);
        let mut events = state.events.subscribe();
        let app = projects::router().with_state(state.clone());
        let members_uri = format!("/orgs/{org_id}/members");
        let member_uri = format!("/orgs/{org_id}/members/{newcomer}");
        let add = json!({ "userId": newcomer, "role": "builder" });
        let membership_probe = |project_id| PublishProbe {
            events: state.events.subscribe(),
            kind: MEMBERS_CHANGED,
            project_id,
            count_sql: "select count(*) from org_memberships where org_id = $1 and user_id = $2",
            params: vec![org_id, newcomer],
        };

        let (response, members_at_publish) = send_probed(
            &app,
            json_request("POST", &members_uri, &owner_token, Some(add.clone()))?,
            membership_probe(live_projects[0]),
        )
        .await?;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(members_at_publish, 1, "published before the add commit");
        let published = drain(&mut events).await;
        assert_eq!(
            signalled_projects(&published, MEMBERS_CHANGED, "org_membership"),
            project_set(&live_projects),
            "every live project of the org, no deleted or foreign project"
        );
        assert!(published.iter().any(|event| {
            event.kind == "project.access_changed"
                && event.project_id.is_none()
                && event.target_user_id == Some(newcomer)
        }));

        // A duplicate add is rejected inside the transaction: nothing published.
        let status = send(&app, "POST", &members_uri, &owner_token, Some(add)).await?;
        assert_eq!(status, StatusCode::CONFLICT);
        let published = drain(&mut events).await;
        assert!(published.is_empty(), "rejected add published {published:?}");

        let role = Some(json!({ "role": "viewer" }));
        let status = send(&app, "PATCH", &member_uri, &owner_token, role).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            signalled_projects(&drain(&mut events).await, MEMBERS_CHANGED, "org_membership"),
            project_set(&live_projects)
        );

        let (response, members_at_publish) = send_probed(
            &app,
            json_request("DELETE", &member_uri, &owner_token, None)?,
            membership_probe(live_projects[1]),
        )
        .await?;
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(members_at_publish, 0, "published before the removal commit");
        assert_eq!(
            signalled_projects(&drain(&mut events).await, MEMBERS_CHANGED, "org_membership"),
            project_set(&live_projects)
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn credit_ledger_writes_publish_credits_updated_after_commit() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("credits.updated publication").await?;
    let owner = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let other_org_id = Uuid::new_v4();
    let live_projects = [Uuid::new_v4(), Uuid::new_v4()];
    let fixtures = Fixtures {
        orgs: vec![org_id, other_org_id],
        users: vec![owner],
        ..Fixtures::default()
    };
    with_cleanup(&pool, fixtures, async {
        ensure_test_user(&pool, &owner).await?;
        insert_org(&pool, org_id, owner).await?;
        insert_org(&pool, other_org_id, owner).await?;
        for project_id in live_projects {
            insert_project(&pool, project_id, org_id, owner, "active").await?;
        }
        // Watched below, so a signal to either would be seen.
        let deleted_project = Uuid::new_v4();
        let foreign_project = Uuid::new_v4();
        insert_project(&pool, deleted_project, org_id, owner, "deleted").await?;
        insert_project(&pool, foreign_project, other_org_id, owner, "active").await?;
        set_org_balance(&pool, org_id, 50).await?;

        let state = build_test_state(pool.clone(), fanout_config("credits-updated"));
        let mut watched = live_projects.to_vec();
        watched.extend([deleted_project, foreign_project]);
        let _watches = watch(&state.events, &watched);
        let mut events = state.events.subscribe();
        let app = crate::credits::router().with_state(state.clone());
        let credit_event = |action: &str, project_id: Uuid, key: String, amount: i32| {
            json!({
                "action": action,
                "projectId": project_id,
                "requestId": key,
                "amount": amount,
                "reason": "event_fanout_test",
            })
        };
        let burn_key = Uuid::new_v4();
        let burn = credit_event("burn", live_projects[0], format!("burn-{burn_key}"), 5);

        let (response, burns_at_publish) = send_probed(
            &app,
            json_request("POST", "/credits", SERVICE_ROLE, Some(burn.clone()))?,
            PublishProbe {
                events: state.events.subscribe(),
                kind: CREDITS_UPDATED,
                project_id: live_projects[1],
                count_sql: "select count(*) from org_credit_ledger
                            where org_id = $1 and idempotency_key = 'burn-' || $2::uuid::text",
                params: vec![org_id, burn_key],
            },
        )
        .await?;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(burns_at_publish, 1, "published before the burn commit");
        assert_eq!(
            signal_counts(&drain(&mut events).await, CREDITS_UPDATED, "ledger"),
            once_each(&live_projects),
            "every live project of the org, no deleted or foreign project"
        );

        // A second write inside the org's interval is not published at once:
        // it becomes the one trailing publish when the interval ends.
        let refill = credit_event(
            "refill",
            live_projects[1],
            format!("refill-{}", Uuid::new_v4()),
            7,
        );
        let status = send(&app, "POST", "/credits", SERVICE_ROLE, Some(refill)).await?;
        assert_eq!(status, StatusCode::OK);
        let early = drain(&mut events).await;
        assert!(early.is_empty(), "published inside the interval: {early:?}");
        let trailing = collect_for(
            &mut events,
            CREDITS_UPDATED_INTERVAL + Duration::from_secs(1),
        )
        .await;
        assert_eq!(
            signal_counts(&trailing, CREDITS_UPDATED, "ledger"),
            once_each(&live_projects),
            "the trailing publish announces the refill once per project"
        );

        // Replaying the idempotency key writes no row and publishes nothing.
        let status = send(&app, "POST", "/credits", SERVICE_ROLE, Some(burn)).await?;
        assert_eq!(status, StatusCode::OK);
        let published = drain(&mut events).await;
        assert!(published.is_empty(), "deduped burn published {published:?}");

        // A burn the balance cannot cover rolls back: nothing published.
        let overdraw = credit_event(
            "burn",
            live_projects[0],
            format!("overdraw-{}", Uuid::new_v4()),
            1_000_000,
        );
        let status = send(&app, "POST", "/credits", SERVICE_ROLE, Some(overdraw)).await?;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let published = drain(&mut events).await;
        assert!(
            published.is_empty(),
            "rejected burn published {published:?}"
        );
        Ok(())
    })
    .await
}

fn signed_stripe_delivery(secret: &str, payload: &str) -> anyhow::Result<Request<Body>> {
    let timestamp = Utc::now().timestamp();
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())?;
    mac.update(format!("{timestamp}.{payload}").as_bytes());
    let signature = hex::encode(mac.finalize().into_bytes());
    Ok(Request::builder()
        .method("POST")
        .uri("/billing/webhooks/stripe")
        .header("content-type", "application/json")
        .header("Stripe-Signature", format!("t={timestamp},v1={signature}"))
        .body(Body::from(payload.to_string()))?)
}

#[tokio::test]
async fn stripe_checkout_publishes_credits_updated_after_commit() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("credits.updated on subscription change").await?;
    let owner = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let live_projects = [Uuid::new_v4(), Uuid::new_v4()];
    let event_id = format!("evt_event_fanout_{}", Uuid::new_v4().simple());
    let fixtures = Fixtures {
        orgs: vec![org_id],
        users: vec![owner],
        webhook_events: vec![event_id.clone()],
    };
    with_cleanup(&pool, fixtures, async {
        ensure_test_user(&pool, &owner).await?;
        insert_org(&pool, org_id, owner).await?;
        for project_id in live_projects {
            insert_project(&pool, project_id, org_id, owner, "active").await?;
        }

        let webhook_secret = "whsec_event_fanout_test";
        let config = stripe_test_config("credits-updated-webhook", webhook_secret);
        let state = build_test_state(pool.clone(), config);
        let _watches = watch(&state.events, &live_projects);
        let mut events = state.events.subscribe();
        let app = crate::billing::router().with_state(state.clone());
        let payload = json!({
            "id": event_id,
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "payment_status": "paid",
                    "metadata": { "orgId": org_id.to_string(), "planId": "pro" },
                }
            }
        })
        .to_string();

        let (response, plans_at_publish) = send_probed(
            &app,
            signed_stripe_delivery(webhook_secret, &payload)?,
            PublishProbe {
                events: state.events.subscribe(),
                kind: CREDITS_UPDATED,
                project_id: live_projects[0],
                count_sql: "select count(*) from org_subscriptions
                            where org_id = $1 and billing_cycle = 'pro' and status = 'active'",
                params: vec![org_id],
            },
        )
        .await?;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(plans_at_publish, 1, "published before the plan commit");
        assert_eq!(
            signalled_projects(&drain(&mut events).await, CREDITS_UPDATED, "subscription"),
            project_set(&live_projects)
        );

        // A replayed delivery is skipped before any write and publishes nothing.
        let replay = signed_stripe_delivery(webhook_secret, &payload)?;
        assert_eq!(app.clone().oneshot(replay).await?.status(), StatusCode::OK);
        let published = drain(&mut events).await;
        assert!(
            published.is_empty(),
            "webhook replay published {published:?}"
        );
        Ok(())
    })
    .await
}

fn stripe_test_config(key_id: &str, webhook_secret: &str) -> AppConfig {
    let mut config = fanout_config(key_id);
    config.stripe = Some(StripeConfig {
        secret_key: "sk_test_event_fanout".to_string(),
        api_base_url: "https://api.stripe.test".to_string(),
        price_lookup: HashMap::new(),
        webhook_secret: Some(webhook_secret.to_string()),
        portal_configuration_id: None,
        webhook_tolerance_seconds: 300,
        checkout_tos_consent: false,
    });
    config
}

/// A subscription status update persists the renewal date and cancel flag
/// after its transaction; the signal must wait for them, or the refetch it
/// prompts reads the old subscription.
#[tokio::test]
async fn stripe_subscription_update_publishes_credits_updated_after_details_persist(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("credits.updated after subscription details").await?;
    let owner = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let subscription_id = format!("sub_event_fanout_{}", Uuid::new_v4().simple());
    let event_id = format!("evt_event_fanout_{}", Uuid::new_v4().simple());
    let fixtures = Fixtures {
        orgs: vec![org_id],
        users: vec![owner],
        webhook_events: vec![event_id.clone()],
    };
    with_cleanup(&pool, fixtures, async {
        ensure_test_user(&pool, &owner).await?;
        insert_org(&pool, org_id, owner).await?;
        insert_project(&pool, project_id, org_id, owner, "active").await?;
        pool.get()
            .await?
            .execute(
                "insert into org_subscriptions
                     (id, org_id, processor, external_id, status, currency, credit_limit, billing_cycle)
                 values ($1, $2, 'stripe', $3, 'active', 'usd', 1000, 'pro')",
                &[&Uuid::new_v4(), &org_id, &subscription_id],
            )
            .await?;

        let webhook_secret = "whsec_event_fanout_update";
        let state = build_test_state(
            pool.clone(),
            stripe_test_config("credits-updated-subscription", webhook_secret),
        );
        let _watches = watch(&state.events, &[project_id]);
        let mut events = state.events.subscribe();
        let app = crate::billing::router().with_state(state.clone());
        // No price mapping: the status-only path, as for an unmapped price.
        let payload = json!({
            "id": event_id,
            "type": "customer.subscription.updated",
            "data": {
                "object": {
                    "id": subscription_id,
                    "status": "active",
                    "cancel_at_period_end": true,
                    "current_period_end": Utc::now().timestamp() + 86_400,
                }
            }
        })
        .to_string();

        let (response, persisted_at_publish) = send_probed(
            &app,
            signed_stripe_delivery(webhook_secret, &payload)?,
            PublishProbe {
                events: state.events.subscribe(),
                kind: CREDITS_UPDATED,
                project_id,
                count_sql: "select count(*) from org_subscriptions
                            where org_id = $1 and cancel_at_period_end
                              and current_period_end is not null",
                params: vec![org_id],
            },
        )
        .await?;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            persisted_at_publish, 1,
            "published before the renewal date and cancel flag were persisted"
        );
        assert_eq!(
            signal_counts(&drain(&mut events).await, CREDITS_UPDATED, "subscription"),
            once_each(&[project_id])
        );
        Ok(())
    })
    .await
}

/// Free plans and the dev processor apply at checkout itself, with no
/// webhook to follow, so the checkout request signals after its commit.
#[tokio::test]
async fn immediate_checkout_publishes_credits_updated_after_commit() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("credits.updated on immediate checkout").await?;
    let owner = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let fixtures = Fixtures {
        orgs: vec![org_id],
        users: vec![owner],
        ..Fixtures::default()
    };
    with_cleanup(&pool, fixtures, async {
        ensure_test_user(&pool, &owner).await?;
        insert_org(&pool, org_id, owner).await?;
        insert_project(&pool, project_id, org_id, owner, "active").await?;

        let config = fanout_config("credits-updated-checkout");
        let owner_token = user_token(&config, &owner)?;
        let state = build_test_state(pool.clone(), config);
        let _watches = watch(&state.events, &[project_id]);
        let mut events = state.events.subscribe();
        let app = crate::billing::router().with_state(state.clone());
        let checkout = json!({
            "projectId": project_id,
            "action": "checkout",
            "planId": "starter",
            "processor": "dev",
            "successUrl": "https://studio.example.test/billing",
        });

        let (response, plans_at_publish) = send_probed(
            &app,
            json_request("POST", "/billing/checkout", &owner_token, Some(checkout))?,
            PublishProbe {
                events: state.events.subscribe(),
                kind: CREDITS_UPDATED,
                project_id,
                count_sql: "select count(*) from org_subscriptions
                            where org_id = $1 and billing_cycle = 'starter'",
                params: vec![org_id],
            },
        )
        .await?;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(plans_at_publish, 1, "published before the checkout commit");
        assert_eq!(
            signal_counts(&drain(&mut events).await, CREDITS_UPDATED, "subscription"),
            once_each(&[project_id])
        );
        Ok(())
    })
    .await
}

/// Reads SSE frames until one carries `kind`, returning its parsed payload.
/// Every frame read on the way is appended to `seen`.
async fn next_stream_event(
    body: &mut axum::body::BodyDataStream,
    buffer: &mut String,
    seen: &mut Vec<serde_json::Value>,
    kind: &str,
) -> anyhow::Result<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        while let Some(end) = buffer.find("\n\n") {
            let frame: String = buffer.drain(..end + 2).collect();
            let data = frame
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(str::trim_start)
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() {
                continue;
            }
            let event: serde_json::Value = serde_json::from_str(&data)?;
            seen.push(event.clone());
            if event["kind"] == kind {
                return Ok(event);
            }
        }
        let chunk = tokio::time::timeout_at(deadline, body.next())
            .await
            .map_err(|_| anyhow::anyhow!("timed out waiting for {kind} on the stream"))?
            .ok_or_else(|| anyhow::anyhow!("event stream ended before {kind}"))??;
        buffer.push_str(std::str::from_utf8(&chunk)?);
    }
}

/// Opens `/events` for `project_id` as `token` and returns the SSE body.
async fn open_stream(
    events_app: &axum::Router,
    project_id: Uuid,
    token: &str,
) -> anyhow::Result<axum::body::BodyDataStream> {
    let uri = format!("/events?projectId={project_id}");
    let response = events_app
        .clone()
        .oneshot(json_request("GET", &uri, token, None)?)
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    Ok(response.into_body().into_data_stream())
}

/// A project guest (a direct space member outside the org) cannot read the
/// org directory, so it must not learn that or when the org roster changed.
/// It still gets its own space's roster signal and the credit signal; org
/// members get the org roster signal.
#[tokio::test]
async fn org_roster_signal_reaches_org_members_but_not_project_guests() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("roster/credit signals on guest and member streams").await?;
    let owner = Uuid::new_v4();
    let guest = Uuid::new_v4();
    let peer = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    let newcomer = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let fixtures = Fixtures {
        orgs: vec![org_id],
        users: vec![newcomer, outsider, peer, guest, owner],
        ..Fixtures::default()
    };
    with_cleanup(&pool, fixtures, async {
        for user in [owner, guest, peer, outsider, newcomer] {
            ensure_test_user(&pool, &user).await?;
        }
        insert_org(&pool, org_id, owner).await?;
        insert_project(&pool, project_id, org_id, owner, "active").await?;
        // Direct project viewers who are not org members: no billing or
        // directory access through the org.
        insert_project_member(&pool, project_id, guest, "viewer").await?;
        insert_project_member(&pool, project_id, peer, "viewer").await?;
        set_org_balance(&pool, org_id, 40).await?;

        let config = fanout_config("guest-signal-stream");
        let owner_token = user_token(&config, &owner)?;
        let guest_token = user_token(&config, &guest)?;
        let outsider_token = user_token(&config, &outsider)?;
        let state = build_test_state(pool.clone(), config);
        let events_app = crate::events::router().with_state(state.clone());
        let projects_app = projects::router().with_state(state.clone());
        let credits_app = crate::credits::router().with_state(state.clone());

        // Someone without access to the space cannot open its stream at all.
        let stream_uri = format!("/events?projectId={project_id}");
        let status = send(&events_app, "GET", &stream_uri, &outsider_token, None).await?;
        assert!(
            status.is_client_error(),
            "outsider opened the stream: {status}"
        );

        let mut guest_body = open_stream(&events_app, project_id, &guest_token).await?;
        let mut owner_body = open_stream(&events_app, project_id, &owner_token).await?;
        let (mut guest_buffer, mut owner_buffer) = (String::new(), String::new());
        let (mut guest_seen, mut owner_seen) = (Vec::new(), Vec::new());

        let add = Some(json!({ "userId": newcomer, "role": "builder" }));
        let members_uri = format!("/orgs/{org_id}/members");
        let status = send(&projects_app, "POST", &members_uri, &owner_token, add).await?;
        assert_eq!(status, StatusCode::OK);
        let org_roster = next_stream_event(
            &mut owner_body,
            &mut owner_buffer,
            &mut owner_seen,
            MEMBERS_CHANGED,
        )
        .await?;
        assert_eq!(org_roster["project_id"], project_id.to_string());
        assert_eq!(org_roster["data"], json!({ "reason": "org_membership" }));

        let burn = json!({
            "action": "burn",
            "projectId": project_id,
            "requestId": format!("guest-stream-{}", Uuid::new_v4()),
            "amount": 3,
            "reason": "event_fanout_test",
        });
        let status = send(&credits_app, "POST", "/credits", SERVICE_ROLE, Some(burn)).await?;
        assert_eq!(status, StatusCode::OK);
        let credits_updated = next_stream_event(
            &mut guest_body,
            &mut guest_buffer,
            &mut guest_seen,
            CREDITS_UPDATED,
        )
        .await?;
        assert_eq!(credits_updated["project_id"], project_id.to_string());
        assert_eq!(credits_updated["data"], json!({ "reason": "ledger" }));

        let peer_uri = format!("/projects/{project_id}/members/{peer}");
        let role = Some(json!({ "role": "builder" }));
        let status = send(&projects_app, "PATCH", &peer_uri, &owner_token, role).await?;
        assert_eq!(status, StatusCode::OK);
        let space_roster = next_stream_event(
            &mut guest_body,
            &mut guest_buffer,
            &mut guest_seen,
            MEMBERS_CHANGED,
        )
        .await?;
        assert_eq!(
            space_roster["data"],
            json!({ "reason": "project_membership" })
        );

        // In order, the guest saw the credit signal and its space's roster
        // signal, and nothing before: the org roster signal was dropped, and
        // the newcomer's and peer's access invalidations are targeted. No
        // frame carried a balance or a member.
        let kinds = guest_seen
            .iter()
            .map(|event| event["kind"].as_str().unwrap_or_default().to_string())
            .collect::<Vec<_>>();
        assert_eq!(kinds, [CREDITS_UPDATED, MEMBERS_CHANGED], "{guest_seen:?}");
        let frames = serde_json::Value::Array(guest_seen).to_string();
        assert!(!frames.contains("balance"));
        assert!(!frames.contains("org_membership"));
        assert!(!frames.contains(&newcomer.to_string()));
        assert!(!frames.contains(&peer.to_string()));
        Ok(())
    })
    .await
}

/// `/events` counts as watching its project exactly as long as the stream
/// lives; dropping the response stops the count.
#[tokio::test]
async fn event_stream_watches_its_project_until_dropped() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("event stream project watch").await?;
    let owner = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let fixtures = Fixtures {
        orgs: vec![org_id],
        users: vec![owner],
        ..Fixtures::default()
    };
    with_cleanup(&pool, fixtures, async {
        ensure_test_user(&pool, &owner).await?;
        insert_org(&pool, org_id, owner).await?;
        insert_project(&pool, project_id, org_id, owner, "active").await?;
        let config = fanout_config("event-stream-watch");
        let owner_token = user_token(&config, &owner)?;
        let state = build_test_state(pool.clone(), config);
        let events_app = crate::events::router().with_state(state.clone());
        let mut events = state.events.subscribe();

        publish_project_signal(&state.events, CREDITS_UPDATED, &[project_id], "ledger");
        assert!(
            events.try_recv().is_err(),
            "no stream watches the project yet"
        );

        let stream = open_stream(&events_app, project_id, &owner_token).await?;
        publish_project_signal(&state.events, CREDITS_UPDATED, &[project_id], "ledger");
        assert_eq!(
            signal_counts(&[events.try_recv()?], CREDITS_UPDATED, "ledger"),
            once_each(&[project_id])
        );

        drop(stream);
        publish_project_signal(&state.events, CREDITS_UPDATED, &[project_id], "ledger");
        assert!(
            events.try_recv().is_err(),
            "the dropped stream still watches"
        );
        Ok(())
    })
    .await
}
