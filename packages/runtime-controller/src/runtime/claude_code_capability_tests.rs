//! The `claudeCode` capability on the migrated database
//! (docs/Local-Engine-Turns.md 2.10, and section 8's "Capability"):
//! - the runtime token endpoint issues `claude_code.turns` only for
//!   `localEngine: "claude-code"`, with the switch on, to a person's own
//!   session, and never to the service role, even for a covered subject;
//! - registration keeps a runtime's `claudeCode` only for a private runtime
//!   that its person registered with that scope, rebuilt from the known
//!   fields, and its renewal carries the scope forward; it drops it for hosted,
//!   service-owned and unscoped runtimes;
//! - the status route shows `claudeCode` only to the runtime's owner while the
//!   switch covers them, and `claudeCodeLane` only to a viewer it covers.
//!
//! Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use std::future::Future;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use serde_json::{json, Value as JsonValue};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::{AppConfig, ClaudeCodeLaneUsers, DeviceGrantUsers, PgPool};
use crate::runtime::token::{default_runtime_token_scopes, CLAUDE_CODE_TURNS_SCOPE};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use crate::tokens::{decode_scoped_token, mint_scoped_token, ScopedTokenRequest};
use crate::AppState;

const SERVICE_ROLE: &str = "service-role-token";

/// What runtime-agent reports for a ready lane, with a key it must never
/// store: a path, which would reveal the OS user name.
fn ready_report() -> JsonValue {
    json!({
        "version": 1,
        "ready": true,
        "cli": "2.1.314",
        "verified": true,
        "planSignIn": true,
        "partialMessages": true,
        "path": "/Users/someone/.local/bin/claude",
    })
}

/// [`ready_report`] as registration attests it.
fn ready_attested() -> JsonValue {
    json!({
        "version": 1,
        "ready": true,
        "cli": "2.1.314",
        "verified": true,
        "planSignIn": true,
        "partialMessages": true,
    })
}

#[derive(Clone, Copy)]
struct People {
    /// Owns the space.
    owner: Uuid,
    /// A builder in the space.
    teammate: Uuid,
    /// The controller's service runtime user.
    service: Uuid,
}

struct Space {
    pool: PgPool,
    state: AppState,
    config: AppConfig,
    app: Router,
    project_id: Uuid,
    people: People,
}

impl Space {
    fn person_token(&self, user: Uuid) -> anyhow::Result<String> {
        Ok(crate::auth::issue_controller_token(&self.config, &user)
            .map_err(|error| anyhow::anyhow!("failed to issue a session token: {error:?}"))?
            .token)
    }

    async fn call(
        &self,
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
        let response = self.app.clone().oneshot(request).await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await?;
        Ok((
            status,
            serde_json::from_slice(&bytes).unwrap_or(JsonValue::Null),
        ))
    }

    /// `POST /projects/:id/runtime/token` with `body`.
    async fn mint(&self, bearer: &str, body: JsonValue) -> anyhow::Result<(StatusCode, JsonValue)> {
        self.call(
            "POST",
            &format!("/projects/{}/runtime/token", self.project_id),
            bearer,
            Some(body),
        )
        .await
    }

    /// The scopes a runtime token signs.
    fn signed_scopes(&self, token: &str) -> anyhow::Result<Vec<String>> {
        Ok(self.claims(token)?.scopes)
    }

    fn claims(&self, token: &str) -> anyhow::Result<runtime_contracts::AccessTokenClaims> {
        decode_scoped_token(&self.config, token, "runtime token")
            .map_err(|error| anyhow::anyhow!("invalid runtime token: {error:?}"))
    }

    /// A runtime token the controller signs directly, for registrations no
    /// person's session can start.
    fn signed_runtime_token(&self, subject: Uuid, runtime_id: Uuid) -> anyhow::Result<String> {
        let mut scopes = default_runtime_token_scopes();
        scopes.push(CLAUDE_CODE_TURNS_SCOPE.to_string());
        Ok(mint_scoped_token(
            &self.config,
            ScopedTokenRequest {
                audience: runtime_id.to_string(),
                subject: subject.to_string(),
                project_id: self.project_id.to_string(),
                origin_id: None,
                runtime_id: Some(runtime_id.to_string()),
                protocol: None,
                scopes,
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: None,
            },
        )
        .map_err(|error| anyhow::anyhow!("failed to sign a runtime token: {error:?}"))?
        .token)
    }

    /// `POST /runtime/register` for `runtime_id` on `provider`, reporting
    /// `claude_code` beside an agent and an origin. Gives the stored
    /// capabilities and the renewed runtime token.
    async fn register(
        &self,
        token: &str,
        runtime_id: Uuid,
        provider: &str,
        claude_code: JsonValue,
    ) -> anyhow::Result<(JsonValue, String)> {
        let (status, body) = self
            .call(
                "POST",
                "/runtime/register",
                token,
                Some(json!({
                    "projectId": self.project_id,
                    "runtimeId": runtime_id,
                    "provider": provider,
                    "capabilities": {
                        "agent": true,
                        "origin": true,
                        "claudeCode": claude_code,
                        "claude_code": { "version": 1, "ready": true },
                    },
                })),
            )
            .await?;
        anyhow::ensure!(
            status == StatusCode::OK,
            "registration answered {status}: {body}"
        );
        let renewed = body["runtime_token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("registration renewed no runtime token: {body}"))?
            .to_string();
        let stored: JsonValue = self
            .pool
            .get()
            .await?
            .query_one(
                "select capabilities from runtimes where project_id = $1 and id = $2",
                &[&self.project_id, &runtime_id],
            )
            .await?
            .get(0);
        Ok((stored, renewed))
    }

    /// `GET /projects/:id/runtime/status` as `bearer`.
    async fn status(&self, bearer: &str) -> anyhow::Result<JsonValue> {
        let (status, body) = self
            .call(
                "GET",
                &format!("/projects/{}/runtime/status", self.project_id),
                bearer,
                None,
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "status answered {status}: {body}");
        Ok(body)
    }

    async fn insert_runtime(
        &self,
        runtime_id: Uuid,
        provider: &str,
        capabilities: JsonValue,
    ) -> anyhow::Result<()> {
        self.pool
            .get()
            .await?
            .execute(
                "insert into runtimes (
                     id, project_id, provider, status, endpoint_url,
                     idle_ttl_seconds, last_seen_at, capabilities, display_name
                 ) values ($1, $2, $3, 'ready', 'http://127.0.0.1:8787', 600, now(), $4, 'Desk')",
                &[
                    &runtime_id,
                    &self.project_id,
                    &provider,
                    &PgJson(capabilities),
                ],
            )
            .await?;
        Ok(())
    }
}

/// Runs `body` on a fresh space whose config `configure` may change (the
/// lane switch is empty unless it sets one), then deletes it.
async fn with_space<C, F, Fut>(label: &str, configure: C, body: F) -> anyhow::Result<()>
where
    C: FnOnce(&mut AppConfig, People),
    F: FnOnce(Space) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    let pool = require_origin_test_pool(label).await?;
    let people = People {
        owner: Uuid::new_v4(),
        teammate: Uuid::new_v4(),
        service: Uuid::new_v4(),
    };
    let project_id = Uuid::new_v4();
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), label);
    config.service_runtime_user_id = Some(people.service);
    configure(&mut config, people);
    for user in [people.owner, people.teammate] {
        ensure_test_user(&pool, &user).await?;
    }
    let state = build_test_state(pool.clone(), config.clone());
    let space = Space {
        pool: pool.clone(),
        app: crate::runtime::router().with_state(state.clone()),
        state,
        config,
        project_id,
        people,
    };
    let fixture = SharedDbFixture {
        organizations: Vec::new(),
        projects: vec![project_id],
    };
    let result = with_shared_db_fixture(fixture, async move {
        let connection = space.pool.get().await?;
        connection
            .execute(
                "insert into projects (id, owner_user_id, project_type, status)
                 values ($1, $2, 'customer', 'active')",
                &[&project_id, &people.owner],
            )
            .await?;
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

fn holds_lane_scope(scopes: &[String]) -> bool {
    scopes.iter().any(|scope| scope == CLAUDE_CODE_TURNS_SCOPE)
}

fn answered_scopes(body: &JsonValue) -> Vec<String> {
    body["scopes"]
        .as_array()
        .map(|scopes| {
            scopes
                .iter()
                .filter_map(|scope| scope.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The token scope goes only with `localEngine`, with the switch on, to a
/// person's own session: never to the service role, even when it names a
/// subject the switch covers.
#[tokio::test]
async fn the_lane_scope_goes_only_to_a_covered_persons_own_session() -> anyhow::Result<()> {
    with_space(
        "claude-code-token-scope",
        |config, people| {
            config.claude_code_lane =
                ClaudeCodeLaneUsers(DeviceGrantUsers::Only(vec![people.owner]));
        },
        |space| async move {
            let owner = space.person_token(space.people.owner)?;
            let teammate = space.person_token(space.people.teammate)?;

            let (status, minted) = space
                .mint(&owner, json!({ "localEngine": "claude-code" }))
                .await?;
            assert_eq!(status, StatusCode::OK, "{minted}");
            assert!(holds_lane_scope(&answered_scopes(&minted)), "{minted}");
            let token = minted["token"].as_str().expect("token");
            let claims = space.claims(token)?;
            assert!(holds_lane_scope(&claims.scopes));
            assert_eq!(claims.sub, space.people.owner.to_string());
            for scope in default_runtime_token_scopes() {
                assert!(claims.scopes.contains(&scope), "{scope}");
            }

            // The same person without the flag, or naming another engine.
            for body in [
                json!({}),
                json!({ "localEngine": null }),
                json!({ "localEngine": "codex" }),
                json!({ "local_engine": "Claude-Code" }),
                json!({ "personalBrowser": false }),
            ] {
                let (status, minted) = space.mint(&owner, body.clone()).await?;
                assert_eq!(status, StatusCode::OK, "{body}: {minted}");
                assert!(!holds_lane_scope(&answered_scopes(&minted)), "{body}");
                let token = minted["token"].as_str().expect("token");
                assert!(!holds_lane_scope(&space.signed_scopes(token)?), "{body}");
            }

            // A builder in the space whom the switch does not cover.
            let (status, minted) = space
                .mint(&teammate, json!({ "localEngine": "claude-code" }))
                .await?;
            assert_eq!(status, StatusCode::OK, "{minted}");
            assert!(!holds_lane_scope(&answered_scopes(&minted)));

            // Asked for by name: never without the flag, nor by a caller
            // that may not have it.
            let mut named = default_runtime_token_scopes();
            named.push(CLAUDE_CODE_TURNS_SCOPE.to_string());
            let (status, _) = space.mint(&owner, json!({ "scopes": named })).await?;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            let (status, _) = space
                .mint(
                    &teammate,
                    json!({ "scopes": named, "localEngine": "claude-code" }),
                )
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN);
            let (status, minted) = space
                .mint(
                    &owner,
                    json!({ "scopes": named, "localEngine": "claude-code" }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{minted}");
            assert!(holds_lane_scope(&answered_scopes(&minted)));

            // The service role, naming the covered owner as the subject.
            let subject = space.people.owner.to_string();
            let (status, minted) = space
                .mint(
                    SERVICE_ROLE,
                    json!({ "localEngine": "claude-code", "subject": subject }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{minted}");
            assert!(!holds_lane_scope(&answered_scopes(&minted)));
            let claims = space.claims(minted["token"].as_str().expect("token"))?;
            assert_eq!(claims.sub, subject);
            assert!(!holds_lane_scope(&claims.scopes));
            let (status, _) = space
                .mint(
                    SERVICE_ROLE,
                    json!({ "localEngine": "claude-code", "subject": subject, "scopes": named }),
                )
                .await?;
            assert_eq!(status, StatusCode::FORBIDDEN);
            Ok(())
        },
    )
    .await
}

/// Registration keeps `claudeCode` only for a private runtime its person
/// registered with the lane scope, rebuilt from the known fields, and the
/// renewed token carries the scope. A hosted, a service-owned and an unscoped
/// registration store none and renew without the scope.
#[tokio::test]
async fn registration_keeps_claude_code_only_for_its_persons_lane_scoped_runtime(
) -> anyhow::Result<()> {
    with_space(
        "claude-code-registration",
        |config, people| {
            config.claude_code_lane =
                ClaudeCodeLaneUsers(DeviceGrantUsers::Only(vec![people.owner]));
        },
        |space| async move {
            let owner = space.person_token(space.people.owner)?;
            let owner_id = space.people.owner.to_string();

            // The owner's Desktop, with the scope.
            let (status, minted) = space
                .mint(&owner, json!({ "localEngine": "claude-code" }))
                .await?;
            assert_eq!(status, StatusCode::OK, "{minted}");
            let desktop: Uuid = minted["runtimeId"]
                .as_str()
                .expect("a machine mint names its runtime")
                .parse()?;
            let token = minted["token"].as_str().expect("token");
            let (stored, renewed) = space
                .register(token, desktop, "self-hosted", ready_report())
                .await?;
            assert_eq!(stored["claudeCode"], ready_attested());
            assert!(stored.get("claude_code").is_none());
            assert_eq!(stored["agent"], json!(true));
            assert_eq!(
                stored["_instafySelfHostedAccess"]["ownerUserId"],
                json!(owner_id)
            );
            let renewed_claims = space.claims(&renewed)?;
            assert!(holds_lane_scope(&renewed_claims.scopes));
            assert_eq!(renewed_claims.sub, owner_id);

            // Its renewal registers again with the scope it carried, and a
            // not-ready report is kept, rebuilt.
            let (stored, renewed_again) = space
                .register(
                    &renewed,
                    desktop,
                    "self-hosted",
                    json!({
                        "version": 1,
                        "ready": false,
                        "reason": "unsupported_version",
                        "cli": "2.1.200",
                        "verified": true,
                        "planSignIn": false,
                        "binary": "/Users/someone/.local/bin/claude",
                    }),
                )
                .await?;
            assert_eq!(
                stored["claudeCode"],
                json!({
                    "version": 1,
                    "ready": false,
                    "reason": "unsupported_version",
                    "cli": "2.1.200",
                    "verified": true,
                    "planSignIn": false,
                })
            );
            assert!(holds_lane_scope(&space.signed_scopes(&renewed_again)?));

            // A malformed report is no capability, even with the scope.
            let (stored, _) = space
                .register(
                    &renewed_again,
                    desktop,
                    "self-hosted",
                    json!({ "version": 2, "ready": true }),
                )
                .await?;
            assert!(stored.get("claudeCode").is_none(), "{stored}");

            // Unscoped: the same person's Desktop, minted without the flag.
            let (status, minted) = space.mint(&owner, json!({})).await?;
            assert_eq!(status, StatusCode::OK, "{minted}");
            let unscoped: Uuid = minted["runtimeId"].as_str().expect("runtime").parse()?;
            let (stored, renewed) = space
                .register(
                    minted["token"].as_str().expect("token"),
                    unscoped,
                    "self-hosted",
                    ready_report(),
                )
                .await?;
            assert!(stored.get("claudeCode").is_none(), "{stored}");
            assert!(stored.get("claude_code").is_none(), "{stored}");
            assert!(!holds_lane_scope(&space.signed_scopes(&renewed)?));

            // Service-owned: a self-hosted runtime whose token's subject is
            // the controller's service runtime user, even holding the scope.
            let service_owned = Uuid::new_v4();
            let token = space.signed_runtime_token(space.people.service, service_owned)?;
            let (stored, renewed) = space
                .register(&token, service_owned, "self-hosted", ready_report())
                .await?;
            assert!(stored.get("claudeCode").is_none(), "{stored}");
            assert_eq!(
                stored["_instafySelfHostedAccess"]["ownerUserId"],
                json!(space.people.service.to_string())
            );
            assert!(!holds_lane_scope(&space.signed_scopes(&renewed)?));

            // Hosted: a provider-managed runtime, even holding the scope.
            let hosted = Uuid::new_v4();
            let token = space.signed_runtime_token(space.people.service, hosted)?;
            let (stored, renewed) = space
                .register(&token, hosted, "default", ready_report())
                .await?;
            assert!(stored.get("claudeCode").is_none(), "{stored}");
            assert!(stored.get("_instafySelfHostedAccess").is_none(), "{stored}");
            assert!(!holds_lane_scope(&space.signed_scopes(&renewed)?));
            Ok(())
        },
    )
    .await
}

fn entry<'a>(status: &'a JsonValue, runtime_id: Uuid) -> Option<&'a JsonValue> {
    status["runtimes"]
        .as_array()?
        .iter()
        .find(|entry| entry["runtimeId"] == json!(runtime_id.to_string()))
}

/// The ids of the runtimes a status answer lists.
fn listed(status: &JsonValue) -> Vec<String> {
    status["runtimes"]
        .as_array()
        .map(|entries| {
            let mut ids: Vec<String> = entries
                .iter()
                .filter_map(|entry| entry["runtimeId"].as_str().map(str::to_string))
                .collect();
            ids.sort();
            ids
        })
        .unwrap_or_default()
}

fn ids(runtimes: &[Uuid]) -> Vec<String> {
    let mut ids: Vec<String> = runtimes.iter().map(Uuid::to_string).collect();
    ids.sort();
    ids
}

fn assert_no_claude_code(status: &JsonValue, what: &str) {
    for entry in status["runtimes"].as_array().into_iter().flatten() {
        assert!(entry.get("claudeCode").is_none(), "{what}: {entry}");
    }
}

/// Seeds the owner's and the teammate's own Desktops, each with an attested
/// `claudeCode`, and a hosted runtime that carries a stale one.
async fn seed_status_runtimes(space: &Space) -> anyhow::Result<(Uuid, Uuid, Uuid)> {
    let (owner_desktop, teammate_desktop, hosted) =
        (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    for (runtime, owner, claude_code) in [
        (owner_desktop, space.people.owner, ready_attested()),
        (
            teammate_desktop,
            space.people.teammate,
            json!({ "version": 1, "ready": false, "reason": "binary_missing" }),
        ),
    ] {
        let mut capabilities = json!({ "agent": true, "origin": true, "claudeCode": claude_code });
        crate::runtime::set_self_hosted_access_attestation(
            capabilities.as_object_mut().expect("capabilities"),
            owner,
        );
        space
            .insert_runtime(runtime, "self-hosted", capabilities)
            .await?;
    }
    space
        .insert_runtime(
            hosted,
            "default",
            json!({ "agent": true, "origin": true, "claudeCode": ready_attested() }),
        )
        .await?;
    Ok((owner_desktop, teammate_desktop, hosted))
}

/// Status shows `claudeCode` only to the runtime's owner, and only with the
/// switch on; `claudeCodeLane` only for a viewer the switch covers. The
/// service role and the operator snapshot see every private row, as before,
/// and no `claudeCode`.
#[tokio::test]
async fn status_shows_claude_code_only_to_its_owner_with_the_switch_on() -> anyhow::Result<()> {
    with_space(
        "claude-code-status",
        |config, people| {
            config.claude_code_lane =
                ClaudeCodeLaneUsers(DeviceGrantUsers::Only(vec![people.owner]));
        },
        |space| async move {
            let (owner_desktop, teammate_desktop, hosted) = seed_status_runtimes(&space).await?;
            let owner = space.person_token(space.people.owner)?;
            let teammate = space.person_token(space.people.teammate)?;

            // The owner, whom the switch covers.
            let status = space.status(&owner).await?;
            assert_eq!(status["claudeCodeLane"], json!(true));
            assert_eq!(listed(&status), ids(&[owner_desktop, hosted]));
            assert_eq!(
                entry(&status, owner_desktop).expect("owner's desktop")["claudeCode"],
                json!({
                    "ready": true,
                    "reason": null,
                    "cli": "2.1.314",
                    "verified": true,
                    "planSignIn": true,
                })
            );
            assert!(entry(&status, hosted)
                .expect("hosted runtime")
                .get("claudeCode")
                .is_none());

            // The teammate, whom it does not cover: their own private row
            // shows, without its `claudeCode`, and no `claudeCodeLane`.
            let status = space.status(&teammate).await?;
            assert!(status.get("claudeCodeLane").is_none(), "{status}");
            assert_eq!(listed(&status), ids(&[teammate_desktop, hosted]));
            assert_no_claude_code(&status, "a viewer the switch does not cover");

            // The service role sees every private row, as before, and no
            // `claudeCode`.
            let status = space.status(SERVICE_ROLE).await?;
            assert!(status.get("claudeCodeLane").is_none(), "{status}");
            assert_eq!(
                listed(&status),
                ids(&[owner_desktop, teammate_desktop, hosted])
            );
            assert_no_claude_code(&status, "the service role");

            // So does the operator snapshot, which has no viewer.
            let mut connection = space.pool.get().await?;
            let transaction = connection.transaction().await?;
            let snapshot = crate::runtime::load_runtime_status_response(
                &space.state,
                &transaction,
                &space.project_id,
            )
            .await
            .map_err(|error| anyhow::anyhow!("operator snapshot failed: {error:?}"))?;
            transaction.rollback().await?;
            let snapshot = serde_json::to_value(snapshot)?;
            assert!(snapshot.get("claudeCodeLane").is_none(), "{snapshot}");
            assert_eq!(
                listed(&snapshot),
                ids(&[owner_desktop, teammate_desktop, hosted])
            );
            assert_no_claude_code(&snapshot, "the operator snapshot");
            Ok(())
        },
    )
    .await?;

    // With the switch on for everyone, the teammate sees their own runtime's
    // `claudeCode`, never the owner's.
    with_space(
        "claude-code-status-everyone",
        |config, _| {
            config.claude_code_lane = ClaudeCodeLaneUsers(DeviceGrantUsers::Everyone);
        },
        |space| async move {
            let (owner_desktop, teammate_desktop, hosted) = seed_status_runtimes(&space).await?;
            let teammate = space.person_token(space.people.teammate)?;
            let status = space.status(&teammate).await?;
            assert_eq!(status["claudeCodeLane"], json!(true));
            assert_eq!(listed(&status), ids(&[teammate_desktop, hosted]));
            assert!(entry(&status, owner_desktop).is_none());
            assert_eq!(
                entry(&status, teammate_desktop).expect("teammate's desktop")["claudeCode"],
                json!({
                    "ready": false,
                    "reason": "binary_missing",
                    "cli": null,
                    "verified": null,
                    "planSignIn": false,
                })
            );
            assert!(entry(&status, hosted)
                .expect("hosted runtime")
                .get("claudeCode")
                .is_none());
            Ok(())
        },
    )
    .await?;

    // With the switch empty, the default, nobody sees either.
    with_space(
        "claude-code-status-nobody",
        |_, _| {},
        |space| async move {
            let (owner_desktop, _, _) = seed_status_runtimes(&space).await?;
            let owner = space.person_token(space.people.owner)?;
            let status = space.status(&owner).await?;
            assert!(status.get("claudeCodeLane").is_none(), "{status}");
            assert!(entry(&status, owner_desktop).is_some());
            assert_no_claude_code(&status, "an empty switch");
            Ok(())
        },
    )
    .await
}
