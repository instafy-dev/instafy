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
//!   switch covers them, and `claudeCodeLane` only to a viewer it covers;
//! - the capability is version 2 (11.19): the program once, and each Claude
//!   Code login of the grant apart, by its id. Registration keeps only that
//!   version, rebuilt from its known fields: a login's key must be a
//!   canonical UUID, it must say whether it is `ready`, its `reason` must be
//!   a known one, at most ten logins are kept, and a login is never ready
//!   while the program is not. A version 1 capability is dropped;
//! - a held login's `resetsAt`, when a Claude plan's limit resets (11.11), is
//!   attested and shown only with `plan_limit`, as an RFC 3339 time at most
//!   eight days ahead, in UTC to the second.
//!
//! Requires `TEST_DATABASE_URL` like the tests in `tests.rs`, apart from the
//! plain `#[test]`s.

use std::future::Future;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use chrono::{Duration, FixedOffset, SecondsFormat, Utc};
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
/// The Claude Code login every report here holds.
const LOGIN: &str = "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01";

/// What runtime-agent reports for a ready lane on [`LOGIN`], with keys it
/// must never store: paths, which would reveal the OS user name.
fn ready_report() -> JsonValue {
    json!({
        "version": 2,
        "ready": true,
        "cli": "2.1.314",
        "verified": true,
        "partialMessages": true,
        "path": "/home/someone/.local/bin/claude",
        "logins": { LOGIN: {
            "ready": true,
            "planSignIn": true,
            "signedIn": true,
            "configDir": "/home/someone/.claude-work",
        } },
    })
}

/// [`ready_report`] as registration attests it.
fn ready_attested() -> JsonValue {
    json!({
        "version": 2,
        "ready": true,
        "cli": "2.1.314",
        "verified": true,
        "partialMessages": true,
        "logins": { LOGIN: { "ready": true, "planSignIn": true, "signedIn": true } },
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
                        "claude_code": { "version": 2, "ready": true },
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
            // not-ready report is kept, rebuilt: its login is not ready
            // either, for the program's reason.
            let (stored, renewed_again) = space
                .register(
                    &renewed,
                    desktop,
                    "self-hosted",
                    json!({
                        "version": 2,
                        "ready": false,
                        "reason": "unsupported_version",
                        "cli": "2.1.200",
                        "verified": true,
                        "binary": "/home/someone/.local/bin/claude",
                        "logins": { LOGIN: { "ready": true, "planSignIn": false } },
                    }),
                )
                .await?;
            assert_eq!(
                stored["claudeCode"],
                json!({
                    "version": 2,
                    "ready": false,
                    "reason": "unsupported_version",
                    "cli": "2.1.200",
                    "verified": true,
                    "logins": { LOGIN: {
                        "ready": false,
                        "reason": "unsupported_version",
                        "planSignIn": false,
                    } },
                })
            );
            assert!(holds_lane_scope(&space.signed_scopes(&renewed_again)?));

            // A malformed report is no capability, even with the scope, and
            // neither is a version 1 one, from a runtime older than the
            // logins.
            for malformed in [
                json!({ "version": 3, "ready": true, "logins": {} }),
                json!({ "version": 1, "ready": true, "cli": "2.1.314", "planSignIn": true }),
            ] {
                let (stored, _) = space
                    .register(&renewed_again, desktop, "self-hosted", malformed.clone())
                    .await?;
                assert!(stored.get("claudeCode").is_none(), "{malformed}: {stored}");
            }

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
            json!({ "version": 2, "ready": false, "reason": "binary_missing", "logins": {} }),
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
                ready_attested()
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
                json!({ "version": 2, "ready": false, "reason": "binary_missing", "logins": {} })
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

/// `logins` as registration attests a version 2 capability that is ready and
/// holds them, or none when it is no capability.
fn attested_logins(logins: JsonValue) -> Option<JsonValue> {
    super::ClaudeCodeCapability::from_reported(&json!({
        "version": 2,
        "ready": true,
        "logins": logins,
    }))
    .map(|capability| capability.to_json()["logins"].clone())
}

/// runtime-contracts' `capability` fixture, a version 2 capability with two
/// logins, one held at its plan's limit, is what registration keeps of it,
/// unchanged (claude_code_lane_fixtures.json).
#[test]
fn the_shared_capability_fixture_is_kept_unchanged() {
    let fixtures: JsonValue = serde_json::from_str(include_str!(
        "../../../runtime-contracts/src/claude_code_lane_fixtures.json"
    ))
    .expect("the fixtures");
    let capability = &fixtures["capability"];
    assert_eq!(
        capability["logins"].as_object().map(|logins| logins.len()),
        Some(2)
    );
    let attested = super::ClaudeCodeCapability::from_reported(capability).expect("a capability");
    assert_eq!(&attested.to_json(), capability);
}

/// A version 1 capability, from a runtime older than the logins, is no
/// capability at all, ready or not: that runtime takes no lane turn.
#[test]
fn a_version_1_capability_is_dropped() {
    for reported in [
        json!({ "version": 1, "ready": true, "cli": "2.1.314", "planSignIn": true }),
        json!({ "version": 1, "ready": false, "reason": "plan_limit",
                "resetsAt": "2026-11-22T18:00:00Z" }),
        json!({ "version": 1, "ready": true, "logins": { LOGIN: { "ready": true } } }),
    ] {
        assert_eq!(
            super::ClaudeCodeCapability::from_reported(&reported),
            None,
            "{reported}"
        );
    }
}

/// A login's key is kept only as a canonical UUID, lowercase and
/// hyphenated, as the controller writes a login's id; anything else is no
/// login, and the rest stay.
#[test]
fn a_login_is_kept_only_under_its_canonical_id() {
    let id = Uuid::parse_str(LOGIN).expect("a UUID");
    let kept = attested_logins(json!({
        LOGIN: { "ready": true },
        LOGIN.to_uppercase(): { "ready": true },
        id.simple().to_string(): { "ready": true },
        format!("{{{LOGIN}}}"): { "ready": true },
        id.urn().to_string(): { "ready": true },
        format!(" {LOGIN}"): { "ready": true },
        "work": { "ready": true },
        "": { "ready": true },
    }))
    .expect("a capability");
    assert_eq!(kept, json!({ LOGIN: { "ready": true } }));
}

/// A login that does not say whether it is ready, with a boolean, is no
/// login; of the rest, only the known fields stay, each when well-formed.
#[test]
fn a_login_says_whether_it_is_ready() {
    let others = [
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    ];
    let kept = attested_logins(json!({
        LOGIN: {
            "ready": true,
            "planSignIn": "yes",
            "signedIn": 0,
            "configDir": "/home/someone/.claude-work",
            "email": "someone@example.com",
        },
        others[0].to_string(): { "ready": "true" },
        others[1].to_string(): { "planSignIn": true },
        others[2].to_string(): true,
        others[3].to_string(): { "ready": false, "signedIn": false },
    }))
    .expect("a capability");
    assert_eq!(
        kept,
        json!({
            LOGIN: { "ready": true },
            others[3].to_string(): { "ready": false, "signedIn": false },
        })
    );
}

/// At most ten logins are kept, as a grant carries at most ten.
#[test]
fn at_most_ten_logins_are_kept() {
    let logins: serde_json::Map<String, JsonValue> = (0..12)
        .map(|_| (Uuid::new_v4().to_string(), json!({ "ready": true })))
        .collect();
    let capability = super::ClaudeCodeCapability::from_reported(&json!({
        "version": 2,
        "ready": true,
        "logins": logins.clone(),
    }))
    .expect("a capability");
    assert_eq!(capability.logins.len(), 10);
    assert_eq!(
        capability.to_json()["logins"]
            .as_object()
            .map(|kept| kept.len()),
        Some(10)
    );
    for (id, _) in &capability.logins {
        assert!(logins.contains_key(&id.to_string()), "{id}");
    }
    // Ten, the most, are all kept.
    let ten: serde_json::Map<String, JsonValue> = logins.into_iter().take(10).collect();
    assert_eq!(
        attested_logins(JsonValue::Object(ten.clone())),
        Some(JsonValue::Object(ten))
    );
}

/// A login's reason is kept only while it is not ready, and only as one of
/// runtime-contracts' reasons; the program's only as one of the program's.
#[test]
fn an_unknown_reason_is_left_off() {
    let other = Uuid::new_v4().to_string();
    assert_eq!(
        attested_logins(json!({
            LOGIN: { "ready": false, "reason": "signed_out" },
            other.clone(): { "ready": true, "reason": "binary_unsafe" },
        })),
        Some(json!({ LOGIN: { "ready": false }, other: { "ready": true } }))
    );
    let program = |reason: &str| {
        super::ClaudeCodeCapability::from_reported(
            &json!({ "version": 2, "ready": false, "reason": reason, "logins": {} }),
        )
        .expect("a capability")
        .to_json()
    };
    assert_eq!(
        program("probe_failed"),
        json!({ "version": 2, "ready": false, "reason": "probe_failed", "logins": {} })
    );
    // A plan's limit belongs to a login, never the program.
    for unknown in ["plan_limit", "not_signed_in", "Binary_Missing"] {
        assert_eq!(
            program(unknown),
            json!({ "version": 2, "ready": false, "logins": {} }),
            "{unknown}"
        );
    }
}

/// A login is never ready while the program is not: it takes the program's
/// reason, and no reset time of its own.
#[test]
fn a_login_is_never_ready_while_the_program_is_not() {
    let in_an_hour = (Utc::now() + Duration::hours(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
    let other = Uuid::new_v4().to_string();
    let attested = |reason: JsonValue| {
        super::ClaudeCodeCapability::from_reported(&json!({
            "version": 2,
            "ready": false,
            "reason": reason,
            "logins": {
                LOGIN: { "ready": true, "planSignIn": true, "signedIn": true },
                other.clone(): {
                    "ready": false,
                    "reason": "plan_limit",
                    "resetsAt": in_an_hour,
                    "signedIn": true,
                },
            },
        }))
        .expect("a capability")
        .to_json()
    };
    assert_eq!(
        attested(json!("binary_missing")),
        json!({
            "version": 2,
            "ready": false,
            "reason": "binary_missing",
            "logins": {
                LOGIN: {
                    "ready": false,
                    "reason": "binary_missing",
                    "planSignIn": true,
                    "signedIn": true,
                },
                other.clone(): { "ready": false, "reason": "binary_missing", "signedIn": true },
            },
        })
    );
    // With no reason the program's list knows, its logins name none either.
    assert_eq!(
        attested(json!("launch_the_rockets")),
        json!({
            "version": 2,
            "ready": false,
            "logins": {
                LOGIN: { "ready": false, "planSignIn": true, "signedIn": true },
                other.clone(): { "ready": false, "signedIn": true },
            },
        })
    );
}

/// A held login's `resetsAt` (docs/Local-Engine-Turns.md 11.11) is kept only
/// with `plan_limit`, and only as an RFC 3339 time at most eight days ahead,
/// written again in UTC to the second; a ready login, or one not ready for
/// another reason, keeps none, and anything else is left off while the rest
/// of the login stays.
#[test]
fn a_reset_time_is_kept_only_with_a_plan_limit_and_at_most_eight_days_ahead() {
    let reset_of = |ready: bool, reason: &str, resets_at: JsonValue| {
        let capability = super::ClaudeCodeCapability::from_reported(&json!({
            "version": 2,
            "ready": true,
            "logins": { LOGIN: { "ready": ready, "reason": reason, "resetsAt": resets_at } },
        }))
        .expect("a capability");
        assert_eq!(capability.logins.len(), 1, "{resets_at}");
        capability.logins[0].1.resets_at.clone()
    };
    let in_two_hours = Utc::now() + Duration::hours(2);
    let utc = in_two_hours.to_rfc3339_opts(SecondsFormat::Secs, true);
    // Written in another offset, to the millisecond, or with spaces around.
    let elsewhere = in_two_hours
        .with_timezone(&FixedOffset::east_opt(5 * 3600 + 1800).expect("an offset"))
        .to_rfc3339_opts(SecondsFormat::Millis, false);
    for written in [elsewhere, utc.clone(), format!(" {utc} ")] {
        assert_eq!(
            reset_of(false, "plan_limit", json!(written)),
            Some(utc.clone()),
            "{written}"
        );
    }
    let in_a_week = (Utc::now() + Duration::days(7) + Duration::hours(23))
        .to_rfc3339_opts(SecondsFormat::Secs, true);
    assert_eq!(
        reset_of(false, "plan_limit", json!(in_a_week)),
        Some(in_a_week.clone())
    );
    // A ready login keeps none, nor one not ready for another reason.
    assert_eq!(reset_of(true, "plan_limit", json!(utc)), None);
    for reason in ["binary_unsafe", "probe_failed", "not_a_reason"] {
        assert_eq!(reset_of(false, reason, json!(utc)), None, "{reason}");
    }
    // Too far ahead, or no RFC 3339 time.
    for resets_at in [
        json!((Utc::now() + Duration::days(8) + Duration::minutes(5)).to_rfc3339()),
        json!("tomorrow"),
        json!("2026-11-20"),
        json!("2026-11-20T10:00:00"),
        json!(1_800_000_000),
        json!({ "at": utc }),
        JsonValue::Null,
    ] {
        assert_eq!(
            reset_of(false, "plan_limit", resets_at.clone()),
            None,
            "{resets_at}"
        );
    }
    let login = attested_logins(json!({ LOGIN: {
        "ready": false,
        "reason": "plan_limit",
        "resetsAt": "tomorrow",
        "planSignIn": true,
    } }))
    .expect("a capability");
    assert_eq!(
        login,
        json!({ LOGIN: { "ready": false, "reason": "plan_limit", "planSignIn": true } })
    );
}

/// Registration attests a held login's `resetsAt` beside its other fields,
/// in UTC to the second, and the owner's status entry shows it
/// (docs/Local-Engine-Turns.md 11.11, 11.19). Once the runtime reports the
/// login ready again, neither keeps one, whatever its report still says.
#[tokio::test]
async fn a_plan_limits_reset_time_is_attested_and_shown_only_while_its_login_is_held(
) -> anyhow::Result<()> {
    with_space(
        "claude-code-resets-at",
        |config, people| {
            config.claude_code_lane =
                ClaudeCodeLaneUsers(DeviceGrantUsers::Only(vec![people.owner]));
        },
        |space| async move {
            let owner = space.person_token(space.people.owner)?;
            let (status, minted) = space
                .mint(&owner, json!({ "localEngine": "claude-code" }))
                .await?;
            assert_eq!(status, StatusCode::OK, "{minted}");
            let desktop: Uuid = minted["runtimeId"]
                .as_str()
                .expect("a machine mint names its runtime")
                .parse()?;
            let reset = Utc::now() + Duration::hours(3);
            let attested_reset = reset.to_rfc3339_opts(SecondsFormat::Secs, true);
            let (stored, renewed) = space
                .register(
                    minted["token"].as_str().expect("token"),
                    desktop,
                    "self-hosted",
                    json!({
                        "version": 2,
                        "ready": true,
                        "cli": "2.1.314",
                        "verified": true,
                        "logins": { LOGIN: {
                            "ready": false,
                            "reason": "plan_limit",
                            "planSignIn": true,
                            "resetsAt": reset
                                .with_timezone(&FixedOffset::west_opt(5 * 3600).expect("an offset"))
                                .to_rfc3339(),
                        } },
                    }),
                )
                .await?;
            let held = json!({
                "version": 2,
                "ready": true,
                "cli": "2.1.314",
                "verified": true,
                "logins": { LOGIN: {
                    "ready": false,
                    "reason": "plan_limit",
                    "resetsAt": attested_reset,
                    "planSignIn": true,
                } },
            });
            assert_eq!(stored["claudeCode"], held);
            let status = space.status(&owner).await?;
            assert_eq!(
                entry(&status, desktop).expect("the owner's desktop")["claudeCode"],
                held
            );

            // Ready again, though its report still names a reset time.
            let mut report = ready_report();
            report["logins"][LOGIN]["resetsAt"] = json!(attested_reset);
            let (stored, _) = space
                .register(&renewed, desktop, "self-hosted", report)
                .await?;
            assert_eq!(stored["claudeCode"], ready_attested());
            let status = space.status(&owner).await?;
            assert_eq!(
                entry(&status, desktop).expect("the owner's desktop")["claudeCode"],
                ready_attested()
            );
            Ok(())
        },
    )
    .await
}
