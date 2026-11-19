//! What ends a private self-hosted runtime's machine credentials
//! ([`super`]), on the migrated database:
//! - registration and a machine capability (a Git token mint) refuse a
//!   runtime whose owner can no longer write the space, and work again once
//!   they can; a service-owned runtime is never checked against membership;
//! - a person's stop and a removal rotate the token generation, while the
//!   agent's own stop and the stop the sweeps share do not;
//! - a membership change rotates the machines of the person who lost write
//!   access, only where they lost it, and nobody else's, a runtime terminal
//!   cleanup marked removed included while its tokens may be alive;
//! - a first registration, a mint or an agent login racing a removal waits
//!   for it on the owner lock and is refused, a removal racing an admission
//!   already under way waits for it and rotates what it wrote, and of two
//!   removals racing each other the later fence sees both;
//! - renewal never widens a narrowed mint.
//!
//! Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use std::future::Future;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use serde_json::{json, Value as JsonValue};
use tokio::task::JoinHandle;
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::{AppConfig, PgPool};
use crate::runtime::token::{
    default_runtime_token_scopes, RUNTIME_TOKEN_GENERATION_CAPABILITY,
    RUNTIME_TOKEN_REQUIRED_SCOPES,
};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool_with_max_size,
    sql, sql_one, test_origin_private_key, test_origin_public_key, with_shared_db_fixture,
    SharedDbFixture,
};
use crate::tokens::{decode_scoped_token, mint_scoped_token, ScopedTokenRequest};
use crate::AppState;

use super::{
    fence_runtimes_of_a_lost_writer, runtime_owner_lock_key, share_runtime_owner_lock,
    MembershipChangeScope, RUNTIME_OWNER_ACCESS_REVOKED_CODE,
};

pub(super) const SELF_HOSTED: &str = "self-hosted";
pub(super) const SERVICE_ROLE: &str = "service-role-token";
pub(super) const STALE_GENERATION: &str = "runtime token generation is no longer current";

/// A request running on a task of its own.
pub(super) type PendingCall = JoinHandle<anyhow::Result<(StatusCode, JsonValue)>>;

#[derive(Clone, Copy)]
pub(super) struct People {
    /// Owns both spaces and the team.
    pub(super) owner: Uuid,
    /// A builder of the team, and a direct builder of the first space only.
    pub(super) teammate: Uuid,
    /// The controller's service runtime user.
    pub(super) service: Uuid,
}

/// A runtime its person started: minted with their session, then registered.
pub(super) struct Machine {
    pub(super) project_id: Uuid,
    pub(super) runtime_id: Uuid,
    /// The runtime token the registration renewed.
    pub(super) renewed: String,
    /// The agent token the registration issued.
    pub(super) agent: String,
}

pub(super) struct Space {
    pub(super) pool: PgPool,
    pub(super) config: AppConfig,
    pub(super) state: AppState,
    app: Router,
    pub(super) org_id: Uuid,
    /// The team space the teammate is also a direct builder of.
    pub(super) project_id: Uuid,
    /// A team space the teammate writes only through the team.
    pub(super) team_only_project_id: Uuid,
    pub(super) people: People,
}

impl Space {
    pub(super) fn person_token(&self, user: Uuid) -> anyhow::Result<String> {
        Ok(crate::auth::issue_controller_token(&self.config, &user)
            .map_err(|error| anyhow::anyhow!("failed to issue a session token: {error:?}"))?
            .token)
    }

    pub(super) async fn call(
        &self,
        method: &str,
        uri: &str,
        bearer: &str,
        body: Option<JsonValue>,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        call_app(self.app.clone(), method, uri, bearer, body).await
    }

    /// [`Self::call`] on a task of its own, to race a transaction the test
    /// holds open.
    pub(super) fn spawn_call(
        &self,
        method: &'static str,
        uri: String,
        bearer: String,
        body: Option<JsonValue>,
    ) -> PendingCall {
        let app = self.app.clone();
        tokio::spawn(async move { call_app(app, method, &uri, &bearer, body).await })
    }

    /// `POST /projects/:id/runtime/token` with `user`'s session.
    pub(super) async fn mint(
        &self,
        user: Uuid,
        project_id: Uuid,
        body: JsonValue,
    ) -> anyhow::Result<(String, Uuid)> {
        let bearer = self.person_token(user)?;
        let (status, body) = self
            .call(
                "POST",
                &format!("/projects/{project_id}/runtime/token"),
                &bearer,
                Some(body),
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "mint answered {status}: {body}");
        let token = body["token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("mint answered no token: {body}"))?
            .to_string();
        let runtime_id = body["runtimeId"]
            .as_str()
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or_else(|| anyhow::anyhow!("mint answered no runtime id: {body}"))?;
        Ok((token, runtime_id))
    }

    /// `POST /runtime/register` for a self-hosted runtime.
    pub(super) async fn register(
        &self,
        token: &str,
        project_id: Uuid,
        runtime_id: Uuid,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        self.call(
            "POST",
            "/runtime/register",
            token,
            Some(registration_body(project_id, runtime_id)),
        )
        .await
    }

    /// [`Self::register`], which must succeed.
    pub(super) async fn registered(
        &self,
        token: &str,
        project_id: Uuid,
        runtime_id: Uuid,
    ) -> anyhow::Result<Machine> {
        let (status, body) = self.register(token, project_id, runtime_id).await?;
        anyhow::ensure!(
            status == StatusCode::OK,
            "registration answered {status}: {body}"
        );
        let field = |name: &str| {
            body[name]
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| anyhow::anyhow!("registration answered no {name}: {body}"))
        };
        Ok(Machine {
            project_id,
            runtime_id,
            renewed: field("runtime_token")?,
            agent: field("agent_token")?,
        })
    }

    /// `user` starts a machine in `project_id` the way Desktop does: a mint
    /// with the default scopes and no runtime id, then a registration.
    pub(super) async fn start_machine(
        &self,
        user: Uuid,
        project_id: Uuid,
    ) -> anyhow::Result<Machine> {
        let (token, runtime_id) = self.mint(user, project_id, json!({})).await?;
        self.registered(&token, project_id, runtime_id).await
    }

    /// `POST /projects/:id/git/access_token` for `git.read` with `token`.
    pub(super) async fn git_read(
        &self,
        token: &str,
        project_id: Uuid,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        self.call(
            "POST",
            &format!("/projects/{project_id}/git/access_token"),
            token,
            Some(json!({ "scopes": ["git.read"] })),
        )
        .await
    }

    /// The runtime's stored token generation.
    pub(super) async fn generation(&self, runtime_id: Uuid) -> anyhow::Result<Option<String>> {
        Ok(self
            .pool
            .get()
            .await?
            .query_one(
                "select capabilities ->> $2 from runtimes where id = $1",
                &[&runtime_id, &RUNTIME_TOKEN_GENERATION_CAPABILITY],
            )
            .await?
            .get(0))
    }

    pub(super) async fn status(&self, runtime_id: Uuid) -> anyhow::Result<String> {
        Ok(self
            .pool
            .get()
            .await?
            .query_one("select status from runtimes where id = $1", &[&runtime_id])
            .await?
            .get(0))
    }

    /// Change `user`'s memberships of the first space and of the team
    /// directly, as an edit the controller never sees would; `None` removes
    /// one.
    async fn set_memberships_directly(
        &self,
        user: Uuid,
        project_role: Option<&str>,
        org_role: Option<&str>,
    ) -> anyhow::Result<()> {
        let connection = self.pool.get().await?;
        match project_role {
            Some(role) => {
                connection
                    .execute(
                        "update project_memberships set role = $3
                         where project_id = $1 and user_id = $2",
                        &[&self.project_id, &user, &role],
                    )
                    .await?
            }
            None => {
                connection
                    .execute(
                        "delete from project_memberships where project_id = $1 and user_id = $2",
                        &[&self.project_id, &user],
                    )
                    .await?
            }
        };
        match org_role {
            Some(role) => {
                connection
                    .execute(
                        "update org_memberships set role = $3 where org_id = $1 and user_id = $2",
                        &[&self.org_id, &user, &role],
                    )
                    .await?
            }
            None => {
                connection
                    .execute(
                        "delete from org_memberships where org_id = $1 and user_id = $2",
                        &[&self.org_id, &user],
                    )
                    .await?
            }
        };
        Ok(())
    }

    /// Remove `user` from the first space and from the team in `transaction`,
    /// as a removal does before its fence.
    async fn remove_memberships(
        &self,
        transaction: &tokio_postgres::Transaction<'_>,
        user: Uuid,
    ) -> anyhow::Result<()> {
        transaction
            .execute(
                "delete from project_memberships where project_id = $1 and user_id = $2",
                &[&self.project_id, &user],
            )
            .await?;
        transaction
            .execute(
                "delete from org_memberships where org_id = $1 and user_id = $2",
                &[&self.org_id, &user],
            )
            .await?;
        Ok(())
    }

    /// A runtime token the controller signs for its own service identity.
    pub(super) fn service_runtime_token(&self, runtime_id: Uuid) -> anyhow::Result<String> {
        Ok(mint_scoped_token(
            &self.config,
            ScopedTokenRequest {
                audience: runtime_id.to_string(),
                subject: self.people.service.to_string(),
                project_id: self.project_id.to_string(),
                origin_id: None,
                runtime_id: Some(runtime_id.to_string()),
                protocol: None,
                scopes: default_runtime_token_scopes(),
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: None,
            },
        )
        .map_err(|error| anyhow::anyhow!("failed to sign a runtime token: {error:?}"))?
        .token)
    }
}

pub(super) fn assert_refused(
    status: StatusCode,
    body: &JsonValue,
    expected: StatusCode,
    label: &str,
) {
    assert_eq!(status, expected, "{label}: {body}");
    if expected == StatusCode::FORBIDDEN {
        assert_eq!(
            body["code"],
            json!(RUNTIME_OWNER_ACCESS_REVOKED_CODE),
            "{label}: {body}"
        );
    } else {
        assert_eq!(body["message"], json!(STALE_GENERATION), "{label}: {body}");
    }
}

async fn call_app(
    app: Router,
    method: &str,
    uri: &str,
    bearer: &str,
    body: Option<JsonValue>,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {bearer}"));
    let request = match body {
        Some(body) => request
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))?,
        None => request.body(Body::empty())?,
    };
    let response = app.oneshot(request).await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    Ok((
        status,
        serde_json::from_slice(&bytes).unwrap_or(JsonValue::Null),
    ))
}

fn registration_body(project_id: Uuid, runtime_id: Uuid) -> JsonValue {
    json!({
        "projectId": project_id,
        "runtimeId": runtime_id,
        "provider": SELF_HOSTED,
        "capabilities": { "agent": true, "origin": true },
    })
}

/// How many transactions wait for `owner`'s owner lock. A bigint advisory
/// key shows in `pg_locks` split into `classid` (high half) and `objid`
/// (low half), with `objsubid` 1.
async fn waiting_on_owner_lock(pool: &PgPool, owner: Uuid) -> anyhow::Result<i64> {
    sql_one(
        pool,
        "select count(*) from pg_locks
         where locktype = 'advisory' and not granted and objsubid = 1
           and classid = ((hashtextextended($1, 0) >> 32) & 4294967295)::oid
           and objid = (hashtextextended($1, 0) & 4294967295)::oid",
        &[&runtime_owner_lock_key(owner)],
    )
    .await
}

/// Waits until each of `requests` waits for `owner`'s owner lock or has
/// finished, for at most ten seconds. A request that never waits is left to
/// fail its test's assertions, not this wait.
pub(super) async fn until_waiting_or_done(
    pool: &PgPool,
    owner: Uuid,
    requests: &[&PendingCall],
) -> anyhow::Result<()> {
    for _ in 0..400 {
        let finished = requests
            .iter()
            .filter(|request| request.is_finished())
            .count();
        let waiting = usize::try_from(waiting_on_owner_lock(pool, owner).await?)?;
        if waiting + finished >= requests.len() {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    Ok(())
}

/// Runs `body` on a fresh team with two spaces, then deletes it.
pub(super) async fn with_space<F, Fut>(label: &str, body: F) -> anyhow::Result<()>
where
    F: FnOnce(Space) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    with_configured_space(label, |_| {}, body).await
}

/// [`with_space`], with `configure` applied to the controller's config.
pub(super) async fn with_configured_space<F, Fut>(
    label: &str,
    configure: impl FnOnce(&mut AppConfig),
    body: F,
) -> anyhow::Result<()>
where
    F: FnOnce(Space) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    // Room for a transaction the test holds open and the requests racing it.
    let pool = require_origin_test_pool_with_max_size(label, 8).await?;
    let people = People {
        owner: Uuid::new_v4(),
        teammate: Uuid::new_v4(),
        service: Uuid::new_v4(),
    };
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let team_only_project_id = Uuid::new_v4();
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
    config.service_runtime_user_id = Some(people.service);
    configure(&mut config);
    for user in [people.owner, people.teammate] {
        ensure_test_user(&pool, &user).await?;
    }
    let state = build_test_state(pool.clone(), config.clone());
    let space = Space {
        pool: pool.clone(),
        app: crate::runtime::router()
            .merge(crate::projects::router())
            .merge(crate::origins::router())
            .merge(crate::agent::router())
            .merge(crate::sign_out_everywhere::router())
            .with_state(state.clone()),
        state,
        config,
        org_id,
        project_id,
        team_only_project_id,
        people,
    };
    let fixture = SharedDbFixture {
        organizations: vec![org_id],
        projects: vec![project_id, team_only_project_id],
    };
    let result = with_shared_db_fixture(fixture, async move {
        let connection = space.pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, 'Revocation team')",
                &[&org_id, &format!("revocation-{}", org_id.simple())],
            )
            .await?;
        for (user, role) in [(people.owner, "owner"), (people.teammate, "builder")] {
            connection
                .execute(
                    "insert into org_memberships (org_id, user_id, role) values ($1, $2, $3)",
                    &[&org_id, &user, &role],
                )
                .await?;
        }
        for project in [project_id, team_only_project_id] {
            connection
                .execute(
                    "insert into projects (id, org_id, owner_user_id, project_type, status)
                     values ($1, $2, $3, 'customer', 'active')",
                    &[&project, &org_id, &people.owner],
                )
                .await?;
        }
        connection
            .execute(
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&project_id, &people.teammate],
            )
            .await?;
        drop(connection);
        body(space).await
    })
    .await;
    let users = vec![people.owner, people.teammate];
    let cleanup = pool
        .get()
        .await?
        .execute("delete from auth.users where id = any($1)", &[&users])
        .await;
    result.and(cleanup.map(|_| ()).map_err(anyhow::Error::from))
}

#[tokio::test]
async fn an_owner_who_cannot_write_loses_the_machine_until_they_can_again() -> anyhow::Result<()> {
    with_space(
        "an_owner_who_cannot_write_loses_the_machine_until_they_can_again",
        |space| async move {
            let teammate = space.people.teammate;
            let machine = space.start_machine(teammate, space.project_id).await?;
            let (status, body) = space.git_read(&machine.renewed, space.project_id).await?;
            assert_eq!(status, StatusCode::OK, "a builder's machine reads: {body}");
            let generation = space.generation(machine.runtime_id).await?;

            // Made a viewer behind the controller's back, so nothing rotates:
            // the re-check alone refuses the renewal and the capability.
            space
                .set_memberships_directly(teammate, Some("viewer"), Some("viewer"))
                .await?;
            let (status, body) = space
                .register(&machine.renewed, space.project_id, machine.runtime_id)
                .await?;
            assert_refused(status, &body, StatusCode::FORBIDDEN, "a viewer's renewal");
            let (status, body) = space.git_read(&machine.renewed, space.project_id).await?;
            assert_refused(status, &body, StatusCode::FORBIDDEN, "a viewer's Git read");
            assert_eq!(space.generation(machine.runtime_id).await?, generation);

            // A builder again: the same tokens work.
            space
                .set_memberships_directly(teammate, Some("builder"), Some("viewer"))
                .await?;
            let machine = space
                .registered(&machine.renewed, space.project_id, machine.runtime_id)
                .await?;
            let (status, body) = space.git_read(&machine.renewed, space.project_id).await?;
            assert_eq!(status, StatusCode::OK, "a builder again reads: {body}");

            // Removed from the space and the team.
            space.set_memberships_directly(teammate, None, None).await?;
            let (status, body) = space
                .register(&machine.renewed, space.project_id, machine.runtime_id)
                .await?;
            assert_refused(
                status,
                &body,
                StatusCode::FORBIDDEN,
                "a non-member's renewal",
            );
            let (status, body) = space.git_read(&machine.renewed, space.project_id).await?;
            assert_refused(
                status,
                &body,
                StatusCode::FORBIDDEN,
                "a non-member's Git read",
            );

            // The controller's own runtime is no member of anything and is
            // never re-checked against membership.
            let service_runtime = Uuid::new_v4();
            let token = space.service_runtime_token(service_runtime)?;
            space
                .registered(&token, space.project_id, service_runtime)
                .await?;
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_persons_stop_and_a_removal_rotate_but_the_agents_own_stop_does_not() -> anyhow::Result<()>
{
    with_space(
        "a_persons_stop_and_a_removal_rotate_but_the_agents_own_stop_does_not",
        |space| async move {
            let teammate = space.people.teammate;
            let machine = space.start_machine(teammate, space.project_id).await?;
            let runtime_id = machine.runtime_id;
            let generation = space.generation(runtime_id).await?;
            assert!(
                generation.is_some(),
                "a registered runtime has a generation"
            );
            let stop = |bearer: String, reason: &'static str| {
                let space = &space;
                async move {
                    space
                        .call(
                            "POST",
                            "/runtime/stop",
                            &bearer,
                            Some(json!({ "runtime_id": runtime_id, "reason": reason })),
                        )
                        .await
                }
            };

            // The agent's own stop: a restart on the same token follows it.
            let (status, body) = stop(machine.agent.clone(), "agent_shutdown").await?;
            assert_eq!(status, StatusCode::OK, "the agent's stop: {body}");
            assert_eq!(space.status(runtime_id).await?, "stopped");
            assert_eq!(space.generation(runtime_id).await?, generation);
            let machine = space
                .registered(&machine.renewed, machine.project_id, runtime_id)
                .await?;

            // The stop the idle and heartbeat sweeps share never rotates.
            {
                let mut connection = space.pool.get().await?;
                let transaction = connection.transaction().await?;
                let runtime = crate::runtime::fetch_runtime_for_update(&transaction, &runtime_id)
                    .await
                    .map_err(|error| anyhow::anyhow!("lock the runtime: {error:?}"))?;
                crate::runtime::perform_runtime_stop(
                    &transaction,
                    &runtime,
                    crate::runtime::StopOptions {
                        source: "heartbeat_timeout",
                        reason: Some("heartbeat_timeout".to_string()),
                        skip_if_active_jobs: false,
                        require_idle_timeout: false,
                        allow_cleanup_pending_release: false,
                        expected_identity: None,
                    },
                )
                .await
                .map_err(|error| anyhow::anyhow!("sweep stop: {error:?}"))?;
                transaction.commit().await?;
            }
            assert_eq!(space.status(runtime_id).await?, "stopped");
            assert_eq!(space.generation(runtime_id).await?, generation);
            let machine = space
                .registered(&machine.renewed, machine.project_id, runtime_id)
                .await?;

            // The person's own stop, whatever reason it gives, rotates.
            let (status, body) = stop(
                space.person_token(teammate)?,
                "desktop_runtime_stopped_by_user",
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "the person's stop: {body}");
            let rotated = space.generation(runtime_id).await?;
            assert!(rotated.is_some() && rotated != generation, "{rotated:?}");
            let (status, body) = space
                .register(&machine.renewed, machine.project_id, runtime_id)
                .await?;
            assert_refused(
                status,
                &body,
                StatusCode::UNAUTHORIZED,
                "renewal after a stop",
            );
            assert_eq!(
                space.status(runtime_id).await?,
                "stopped",
                "a refused registration does not revive the runtime"
            );
            let (status, body) = space.git_read(&machine.renewed, machine.project_id).await?;
            assert_refused(
                status,
                &body,
                StatusCode::UNAUTHORIZED,
                "Git read after a stop",
            );

            // The owner gets back in with a fresh mint for the same runtime.
            let (token, minted_for) = space
                .mint(
                    teammate,
                    space.project_id,
                    json!({ "runtimeId": runtime_id }),
                )
                .await?;
            assert_eq!(minted_for, runtime_id);
            let machine = space
                .registered(&token, space.project_id, runtime_id)
                .await?;
            let generation = space.generation(runtime_id).await?;

            // A removal rotates too.
            let (status, body) = space
                .call(
                    "POST",
                    "/runtime/remove",
                    &space.person_token(teammate)?,
                    Some(json!({ "runtimeId": runtime_id })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "the removal: {body}");
            assert_eq!(space.status(runtime_id).await?, "removed");
            let rotated = space.generation(runtime_id).await?;
            assert!(rotated.is_some() && rotated != generation, "{rotated:?}");
            let (status, body) = space
                .register(&machine.renewed, machine.project_id, runtime_id)
                .await?;
            assert_refused(
                status,
                &body,
                StatusCode::UNAUTHORIZED,
                "renewal after a removal",
            );
            assert_eq!(space.status(runtime_id).await?, "removed");
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn membership_changes_rotate_only_the_machines_of_a_lost_writer() -> anyhow::Result<()> {
    with_space(
        "membership_changes_rotate_only_the_machines_of_a_lost_writer",
        |space| async move {
            let People {
                owner, teammate, ..
            } = space.people;
            let direct = space.start_machine(teammate, space.project_id).await?;
            let team_only = space
                .start_machine(teammate, space.team_only_project_id)
                .await?;
            let owners = space.start_machine(owner, space.project_id).await?;
            let direct_generation = space.generation(direct.runtime_id).await?;
            let team_only_generation = space.generation(team_only.runtime_id).await?;
            let owners_generation = space.generation(owners.runtime_id).await?;
            let org_member = format!("/orgs/{}/members/{teammate}", space.org_id);
            let project_member = format!("/projects/{}/members/{teammate}", space.project_id);

            // A team viewer still writes the first space as its direct
            // builder, but no longer the team-only one.
            let (status, body) = space
                .call(
                    "PATCH",
                    &org_member,
                    SERVICE_ROLE,
                    Some(json!({ "role": "viewer" })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "team downgrade: {body}");
            assert_eq!(
                space.generation(direct.runtime_id).await?,
                direct_generation
            );
            assert_ne!(
                space.generation(team_only.runtime_id).await?,
                team_only_generation
            );
            assert_eq!(
                space.generation(owners.runtime_id).await?,
                owners_generation
            );
            let (status, body) = space
                .register(
                    &team_only.renewed,
                    team_only.project_id,
                    team_only.runtime_id,
                )
                .await?;
            assert_refused(status, &body, StatusCode::UNAUTHORIZED, "team-only renewal");
            let direct = space
                .registered(&direct.renewed, direct.project_id, direct.runtime_id)
                .await?;

            // A viewer of the first space as well: its machine rotates.
            let owner_session = space.person_token(owner)?;
            let (status, body) = space
                .call(
                    "PATCH",
                    &project_member,
                    &owner_session,
                    Some(json!({ "role": "viewer" })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "space downgrade: {body}");
            let rotated = space.generation(direct.runtime_id).await?;
            assert_ne!(rotated, direct_generation);
            let (status, body) = space
                .register(&direct.renewed, direct.project_id, direct.runtime_id)
                .await?;
            assert_refused(status, &body, StatusCode::UNAUTHORIZED, "viewer renewal");

            // A builder again rotates nothing.
            let (status, body) = space
                .call(
                    "PATCH",
                    &project_member,
                    &owner_session,
                    Some(json!({ "role": "builder" })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "space upgrade: {body}");
            assert_eq!(space.generation(direct.runtime_id).await?, rotated);

            // Removed from the space while only a team viewer.
            let fresh = space.start_machine(teammate, space.project_id).await?;
            let fresh_generation = space.generation(fresh.runtime_id).await?;
            let (status, body) = space
                .call("DELETE", &project_member, &owner_session, None)
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT, "space removal: {body}");
            assert_ne!(space.generation(fresh.runtime_id).await?, fresh_generation);

            // Removed from the team as a builder of it.
            let (status, body) = space
                .call(
                    "PATCH",
                    &org_member,
                    SERVICE_ROLE,
                    Some(json!({ "role": "builder" })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "team upgrade: {body}");
            let last = space
                .start_machine(teammate, space.team_only_project_id)
                .await?;
            let last_generation = space.generation(last.runtime_id).await?;
            let (status, body) = space
                .call("DELETE", &org_member, SERVICE_ROLE, None)
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT, "team removal: {body}");
            assert_ne!(space.generation(last.runtime_id).await?, last_generation);
            let (status, body) = space
                .register(&last.renewed, last.project_id, last.runtime_id)
                .await?;
            assert_refused(status, &body, StatusCode::UNAUTHORIZED, "removed renewal");

            // The space owner's machine never moved.
            assert_eq!(
                space.generation(owners.runtime_id).await?,
                owners_generation
            );
            space
                .registered(&owners.renewed, owners.project_id, owners.runtime_id)
                .await?;
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn renewal_never_widens_a_narrowed_mint() -> anyhow::Result<()> {
    with_space("renewal_never_widens_a_narrowed_mint", |space| async move {
        let teammate = space.people.teammate;
        let mut required: Vec<String> = RUNTIME_TOKEN_REQUIRED_SCOPES
            .iter()
            .map(|scope| scope.to_string())
            .collect();
        required.sort();
        let scopes_of = |token: &str| -> anyhow::Result<Vec<String>> {
            let mut scopes = decode_scoped_token(&space.config, token, "runtime token")
                .map_err(|error| anyhow::anyhow!("invalid runtime token: {error:?}"))?
                .scopes;
            scopes.sort();
            Ok(scopes)
        };

        let (token, runtime_id) = space
            .mint(teammate, space.project_id, json!({ "scopes": required }))
            .await?;
        assert_eq!(scopes_of(&token)?, required);
        let machine = space
            .registered(&token, space.project_id, runtime_id)
            .await?;
        assert_eq!(scopes_of(&machine.renewed)?, required, "first renewal");
        let machine = space
            .registered(&machine.renewed, space.project_id, runtime_id)
            .await?;
        assert_eq!(scopes_of(&machine.renewed)?, required, "second renewal");
        let (status, body) = space.git_read(&machine.renewed, space.project_id).await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "no Git mint scope: {body}");

        // A default mint still renews to the defaults.
        let mut defaults = default_runtime_token_scopes();
        defaults.sort();
        let machine = space.start_machine(teammate, space.project_id).await?;
        assert_eq!(scopes_of(&machine.renewed)?, defaults);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_removal_fences_a_runtime_cleanup_marked_removed_while_its_tokens_live(
) -> anyhow::Result<()> {
    with_space(
        "a_removal_fences_a_runtime_cleanup_marked_removed_while_its_tokens_live",
        |space| async move {
            let People {
                owner, teammate, ..
            } = space.people;
            let swept = space.start_machine(teammate, space.project_id).await?;
            let long_gone = space.start_machine(teammate, space.project_id).await?;
            // Terminal cleanup marks a runtime offline for ten minutes
            // removed, and registration takes it back. One marked two days
            // ago holds no token that is still alive.
            sql(
                &space.pool,
                "update runtimes set status = 'removed' where id = $1",
                &[&swept.runtime_id],
            )
            .await?;
            {
                // Every update stamps `updated_at`; age this one past that
                // trigger, in a transaction no other session sees it off in.
                let mut connection = space.pool.get().await?;
                let transaction = connection.transaction().await?;
                transaction
                    .batch_execute("alter table runtimes disable trigger set_runtimes_updated_at")
                    .await?;
                transaction
                    .execute(
                        "update runtimes
                         set status = 'removed', updated_at = now() - interval '2 days'
                         where id = $1",
                        &[&long_gone.runtime_id],
                    )
                    .await?;
                transaction
                    .batch_execute("alter table runtimes enable trigger set_runtimes_updated_at")
                    .await?;
                transaction.commit().await?;
            }
            let swept_generation = space.generation(swept.runtime_id).await?;
            let long_gone_generation = space.generation(long_gone.runtime_id).await?;

            // Removed from the team, still a direct builder: nothing moves.
            let (status, body) = space
                .call(
                    "DELETE",
                    &format!("/orgs/{}/members/{teammate}", space.org_id),
                    SERVICE_ROLE,
                    None,
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT, "team removal: {body}");
            assert_eq!(space.generation(swept.runtime_id).await?, swept_generation);

            // Removed from the space as well.
            let (status, body) = space
                .call(
                    "DELETE",
                    &format!("/projects/{}/members/{teammate}", space.project_id),
                    &space.person_token(owner)?,
                    None,
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT, "space removal: {body}");
            let rotated = space.generation(swept.runtime_id).await?;
            assert!(
                rotated.is_some() && rotated != swept_generation,
                "{rotated:?}"
            );
            assert_eq!(
                space.generation(long_gone.runtime_id).await?,
                long_gone_generation
            );

            // A builder again, the swept runtime's old tokens stay ended.
            sql(
                &space.pool,
                "insert into project_memberships (project_id, user_id, role)
                 values ($1, $2, 'builder')",
                &[&space.project_id, &teammate],
            )
            .await?;
            let (status, body) = space
                .register(&swept.renewed, swept.project_id, swept.runtime_id)
                .await?;
            assert_refused(
                status,
                &body,
                StatusCode::UNAUTHORIZED,
                "the swept runtime's renewal",
            );
            assert_eq!(space.status(swept.runtime_id).await?, "removed");
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_first_registration_and_a_removal_never_miss_each_other() -> anyhow::Result<()> {
    with_space(
        "a_first_registration_and_a_removal_never_miss_each_other",
        |space| async move {
            let teammate = space.people.teammate;
            // Minted before the removal; a new runtime has no row yet, so
            // the removal's fence has nothing to rotate.
            let (token, runtime_id) = space.mint(teammate, space.project_id, json!({})).await?;
            let mut connection = space.pool.get().await?;
            let removal = connection.transaction().await?;
            space.remove_memberships(&removal, teammate).await?;
            let rotated = fence_runtimes_of_a_lost_writer(
                &space.state,
                &removal,
                teammate,
                MembershipChangeScope::Project(space.project_id),
            )
            .await
            .map_err(|error| anyhow::anyhow!("fence: {error:?}"))?;
            assert!(rotated.is_empty(), "{rotated:?}");

            // The registration waits for the removal, then sees it.
            let registration = space.spawn_call(
                "POST",
                "/runtime/register".to_string(),
                token,
                Some(registration_body(space.project_id, runtime_id)),
            );
            until_waiting_or_done(&space.pool, teammate, &[&registration]).await?;
            removal.commit().await?;
            drop(connection);
            let (status, body) = registration.await??;
            assert_refused(
                status,
                &body,
                StatusCode::FORBIDDEN,
                "a registration racing a removal",
            );
            let runtimes: i64 = sql_one(
                &space.pool,
                "select count(*) from runtimes where id = $1",
                &[&runtime_id],
            )
            .await?;
            assert_eq!(runtimes, 0, "the refused registration made no runtime");
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_team_and_a_space_removal_never_both_skip_the_fence() -> anyhow::Result<()> {
    with_space(
        "a_team_and_a_space_removal_never_both_skip_the_fence",
        |space| async move {
            let People {
                owner, teammate, ..
            } = space.people;
            let machine = space.start_machine(teammate, space.project_id).await?;
            let generation = space.generation(machine.runtime_id).await?;

            // The team removal, not yet committed, still sees the direct
            // membership, so its own fence keeps the machine.
            let mut connection = space.pool.get().await?;
            let team_removal = connection.transaction().await?;
            team_removal
                .execute(
                    "delete from org_memberships where org_id = $1 and user_id = $2",
                    &[&space.org_id, &teammate],
                )
                .await?;
            let rotated = fence_runtimes_of_a_lost_writer(
                &space.state,
                &team_removal,
                teammate,
                MembershipChangeScope::Org(space.org_id),
            )
            .await
            .map_err(|error| anyhow::anyhow!("fence: {error:?}"))?;
            assert!(rotated.is_empty(), "{rotated:?}");

            // The space removal's fence waits for it, then sees both.
            let space_removal = space.spawn_call(
                "DELETE",
                format!("/projects/{}/members/{teammate}", space.project_id),
                space.person_token(owner)?,
                None,
            );
            until_waiting_or_done(&space.pool, teammate, &[&space_removal]).await?;
            team_removal.commit().await?;
            drop(connection);
            let (status, body) = space_removal.await??;
            assert_eq!(status, StatusCode::NO_CONTENT, "space removal: {body}");
            let rotated = space.generation(machine.runtime_id).await?;
            assert!(rotated.is_some() && rotated != generation, "{rotated:?}");
            let (status, body) = space
                .register(&machine.renewed, machine.project_id, machine.runtime_id)
                .await?;
            assert_refused(
                status,
                &body,
                StatusCode::UNAUTHORIZED,
                "renewal after both removals",
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_mint_and_an_agent_login_racing_a_removal_wait_for_it() -> anyhow::Result<()> {
    with_space(
        "a_mint_and_an_agent_login_racing_a_removal_wait_for_it",
        |space| async move {
            let teammate = space.people.teammate;
            let session = space.person_token(teammate)?;
            let mut connection = space.pool.get().await?;
            let removal = connection.transaction().await?;
            space.remove_memberships(&removal, teammate).await?;
            fence_runtimes_of_a_lost_writer(
                &space.state,
                &removal,
                teammate,
                MembershipChangeScope::Project(space.project_id),
            )
            .await
            .map_err(|error| anyhow::anyhow!("fence: {error:?}"))?;

            let mint = space.spawn_call(
                "POST",
                format!("/projects/{}/runtime/token", space.project_id),
                session.clone(),
                Some(json!({})),
            );
            let login = space.spawn_call(
                "POST",
                "/agent/login".to_string(),
                session,
                Some(json!({ "projectId": space.project_id, "runtimeType": SELF_HOSTED })),
            );
            until_waiting_or_done(&space.pool, teammate, &[&mint, &login]).await?;
            removal.commit().await?;
            drop(connection);
            for (label, request) in [("the mint", mint), ("the agent login", login)] {
                let (status, body) = request.await??;
                assert_eq!(status, StatusCode::FORBIDDEN, "{label}: {body}");
            }
            let runtimes: i64 = sql_one(
                &space.pool,
                "select count(*) from runtimes where project_id = $1",
                &[&space.project_id],
            )
            .await?;
            assert_eq!(runtimes, 0, "the refused login made no runtime");
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_removal_waits_for_an_admission_under_way_and_rotates_what_it_wrote() -> anyhow::Result<()>
{
    with_space(
        "a_removal_waits_for_an_admission_under_way_and_rotates_what_it_wrote",
        |space| async move {
            let People {
                owner, teammate, ..
            } = space.people;
            // A registered machine lends its private capabilities to the
            // runtime the admission below writes.
            let machine = space.start_machine(teammate, space.project_id).await?;
            // The teammate writes the space only as its direct builder now, so
            // the space removal takes their write access.
            sql(
                &space.pool,
                "delete from org_memberships where org_id = $1 and user_id = $2",
                &[&space.org_id, &teammate],
            )
            .await?;

            // An admission under way, as a first registration or an agent
            // login has it: the owner lock held shared and a new runtime
            // written, not yet committed.
            let admitted = Uuid::new_v4();
            let admitted_generation = Uuid::new_v4().to_string();
            let mut connection = space.pool.get().await?;
            let admission = connection.transaction().await?;
            share_runtime_owner_lock(&admission, teammate)
                .await
                .map_err(|error| anyhow::anyhow!("owner lock: {error:?}"))?;
            admission
                .execute(
                    "insert into runtimes
                     select (jsonb_populate_record(r, jsonb_build_object(
                         'id', $2::uuid,
                         'active_lease_id', null,
                         'capabilities', jsonb_set(r.capabilities, array[$3::text], to_jsonb($4::text))
                     ))).*
                     from runtimes r where r.id = $1",
                    &[
                        &machine.runtime_id,
                        &admitted,
                        &RUNTIME_TOKEN_GENERATION_CAPABILITY,
                        &admitted_generation,
                    ],
                )
                .await?;

            // The removal's fence waits for the admission, then sees and
            // rotates the runtime it wrote.
            let removal = space.spawn_call(
                "DELETE",
                format!("/projects/{}/members/{teammate}", space.project_id),
                space.person_token(owner)?,
                None,
            );
            until_waiting_or_done(&space.pool, teammate, &[&removal]).await?;
            admission.commit().await?;
            drop(connection);
            let (status, body) = removal.await??;
            assert_eq!(status, StatusCode::NO_CONTENT, "space removal: {body}");
            let rotated = space.generation(admitted).await?;
            assert!(
                rotated.is_some() && rotated != Some(admitted_generation),
                "{rotated:?}"
            );
            Ok(())
        },
    )
    .await
}
