use super::*;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, eventually, require_origin_test_pool,
    sql_one, test_origin_private_key, test_origin_public_key,
};
use axum::body::{to_bytes, Body};
use axum::http::Request;
use futures_util::FutureExt;
use std::panic::{resume_unwind, AssertUnwindSafe};
use tower::ServiceExt;

fn test_config() -> AppConfig {
    build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "dispatch-security",
    )
}

fn request_body(project_id: Uuid, session_id: Uuid) -> JsonValue {
    json!({
        "projectId": project_id,
        "sessionId": session_id,
        "promptText": "echo dispatch-security",
        "intent": "terminal_command",
        "metadata": { "project_type": "sandbox" },
    })
}

fn normalized_request(project_id: Uuid, session_id: Uuid) -> DispatchPromptNormalized {
    normalize_dispatch_request(
        serde_json::from_value(request_body(project_id, session_id)).expect("dispatch request"),
    )
    .expect("normalize dispatch request")
}

#[tokio::test]
async fn dispatch_security_rejects_untrusted_project_bootstrap_without_side_effects(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("dispatch bootstrap security regression").await?;
    let user_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;
    let mut project_ids = Vec::new();
    let result = AssertUnwindSafe(async {
        let config = test_config();
        let user_token = crate::auth::issue_controller_token(&config, &user_id)
            .expect("issue user token")
            .token;

        for dev_mode in [false, true] {
            let mut config = config.clone();
            config.dev_mode = dev_mode;
            let app = router().with_state(build_test_state(pool.clone(), config.clone()));
            for caller in ["anonymous", "user", "scoped"] {
                let project_id = Uuid::new_v4();
                project_ids.push(project_id);
                let token = match caller {
                    "user" => Some(user_token.clone()),
                    "scoped" => Some(
                        crate::tokens::mint_scoped_token(
                            &config,
                            crate::tokens::ScopedTokenRequest {
                                audience: "runtime-controller".to_string(),
                                subject: user_id.to_string(),
                                project_id: project_id.to_string(),
                                origin_id: None,
                                runtime_id: None,
                                protocol: None,
                                scopes: vec!["agent.lease".to_string()],
                                lease_id: None,
                                run_id: None,
                                prefer_runtime: None,
                                ttl_seconds: Some(300),
                            },
                        )
                        .expect("issue scoped token")
                        .token,
                    ),
                    _ => None,
                };
                let mut request = Request::builder()
                    .method("POST")
                    .uri("/dispatch-prompt")
                    .header("content-type", "application/json");
                if let Some(token) = token {
                    request = request.header("authorization", format!("Bearer {token}"));
                }
                let response = app
                    .clone()
                    .oneshot(request.body(Body::from(
                        request_body(project_id, Uuid::new_v4()).to_string(),
                    ))?)
                    .await?;
                let status = response.status();
                let body: JsonValue =
                    serde_json::from_slice(&to_bytes(response.into_body(), 16_384).await?)?;
                assert_eq!(status, StatusCode::FORBIDDEN, "{caller}: {body}");
                assert_eq!(
                    body["message"],
                    "Only service-role requests can create projects during dispatch",
                    "{caller}, dev_mode={dev_mode}"
                );

                let connection = pool.get().await?;
                let side_effects: i64 = connection
                    .query_one(
                        "select
                       (select count(*) from projects where id = $1) +
                       (select count(*) from organizations where slug = $2) +
                       (select count(*) from conversations where project_id = $1) +
                       (select count(*) from prompts where project_id = $1) +
                       (select count(*) from runs where project_id = $1) +
                       (select count(*) from agent_jobs where project_id = $1) +
                       (select count(*) from runtimes where project_id = $1) +
                       (select count(*) from runtime_leases where project_id = $1) +
                       (select count(*) from org_credit_ledger where project_id = $1)
                     as side_effects",
                        &[&project_id, &format!("project-{project_id}")],
                    )
                    .await?
                    .get("side_effects");
                assert_eq!(side_effects, 0, "{caller}, dev_mode={dev_mode}");
            }
        }

        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let connection = pool.get().await?;
    for project_id in project_ids {
        connection
            .execute("delete from projects where id = $1", &[&project_id])
            .await?;
        connection
            .execute(
                "delete from organizations where slug = $1",
                &[&format!("project-{project_id}")],
            )
            .await?;
    }
    connection
        .execute("delete from auth.users where id = $1", &[&user_id])
        .await?;
    match result {
        Ok(result) => result,
        Err(panic) => resume_unwind(panic),
    }
}

#[tokio::test]
async fn dispatch_security_authorizes_existing_projects_before_initialization() -> anyhow::Result<()>
{
    let pool = require_origin_test_pool("dispatch existing-project security regression").await?;
    let config = test_config();
    let project_id = Uuid::new_v4();
    let session_id = Uuid::new_v4();
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    transaction
        .execute(
            "insert into projects (id, project_type, status, sandbox_session_id)
             values ($1, 'sandbox', 'active', $2)",
            &[&project_id, &session_id],
        )
        .await?;
    let anonymous = RequestContext {
        user_id: None,
        is_service_role: false,
        scoped_claims: None,
    };
    let denied = ensure_project_record_for_dispatch(
        &transaction,
        &config,
        &normalized_request(project_id, Uuid::new_v4()),
        &anonymous,
    )
    .await
    .err()
    .expect("a different sandbox session must be denied");
    assert_eq!(denied.0, StatusCode::UNAUTHORIZED);
    // Inspect the same transaction, so rollback cannot hide writes that ran
    // before authorization failed.
    let org_id: Option<Uuid> = transaction
        .query_one("select org_id from projects where id = $1", &[&project_id])
        .await?
        .get("org_id");
    assert!(
        org_id.is_none(),
        "denied callers must not initialize billing"
    );
    let created_org: bool = transaction
        .query_one(
            "select exists(select 1 from organizations where slug = $1)",
            &[&format!("project-{project_id}")],
        )
        .await?
        .get(0);
    assert!(!created_org);

    // Default subscription setup can supply starter credits. Give this
    // transaction's fresh sandbox an empty balance so dispatch must exercise
    // its positive seed path instead of correctly skipping a funded org.
    let project = crate::projects::load_project_record(&transaction, &project_id)
        .await
        .expect("load sandbox fixture");
    let project = ensure_project_org(&transaction, &project)
        .await
        .expect("initialize sandbox subscription fixture");
    transaction
        .execute(
            "insert into org_credit_balances (org_id, balance) values ($1, 0)
             on conflict (org_id) do update set balance = 0",
            &[&project.org_id.expect("fixture organization")],
        )
        .await?;

    let request = normalized_request(project_id, session_id);
    let allowed = ensure_project_record_for_dispatch(&transaction, &config, &request, &anonymous)
        .await
        .expect("a provisioned sandbox's exact session retains dispatch access");
    assert!(allowed.org_id.is_some());
    ensure_project_record_for_dispatch(&transaction, &config, &request, &anonymous)
        .await
        .expect("repeat authorized initialization");
    let seeds: i64 = transaction
        .query_one(
            "select count(*) from org_credit_ledger
             where project_id = $1 and reason = 'sandbox_seed'",
            &[&project_id],
        )
        .await?
        .get(0);
    assert_eq!(seeds, 1, "an existing sandbox receives at most one seed");
    transaction.rollback().await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_security_preserves_service_bootstrap_and_existing_user_dispatch(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("dispatch authorized-caller regression").await?;
    let config = test_config();
    let project_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;
    let result = AssertUnwindSafe(async {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        let request = normalized_request(project_id, Uuid::new_v4());
        let service = RequestContext {
            user_id: None,
            is_service_role: true,
            scoped_claims: None,
        };
        let project = ensure_project_record_for_dispatch(&transaction, &config, &request, &service)
            .await
            .expect("trusted service bootstrap remains supported");
        assert_eq!(project.id, project_id);
        assert!(project.org_id.is_some());

        // A regular customer project still permits its authenticated Builder.
        transaction
            .execute(
                "update projects set project_type = 'customer', sandbox_session_id = null
             where id = $1",
                &[&project_id],
            )
            .await?;
        transaction
            .execute(
                "insert into project_memberships (project_id, user_id, role)
             values ($1, $2, 'builder')",
                &[&project_id, &user_id],
            )
            .await?;
        let builder = RequestContext {
            user_id: Some(user_id),
            is_service_role: false,
            scoped_claims: None,
        };
        ensure_project_record_for_dispatch(&transaction, &config, &request, &builder)
            .await
            .expect("existing project Builder keeps dispatch access");
        transaction.rollback().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;
    pool.get()
        .await?
        .execute("delete from auth.users where id = $1", &[&user_id])
        .await?;
    match result {
        Ok(result) => result,
        Err(panic) => resume_unwind(panic),
    }
}

#[tokio::test]
async fn dispatch_security_agents_never_target_the_reserved_credential_id() -> anyhow::Result<()> {
    use crate::credentials::reserved_id_tests::{
        api_error, insert_user_credential_row, reserved_id, seed_reserved_credential_row,
    };

    let pool = require_origin_test_pool("dispatch reserved credential id targets").await?;
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let user_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    seed_reserved_credential_row(&transaction, &user_id, false).await?;
    transaction
        .execute(
            "insert into user_agents (id, user_id, credential_id, provider, handle, avatar_seed)
             values ($1, $2, $3, 'openai', 'reservedpin', 'reservedpin')",
            &[&Uuid::new_v4(), &user_id, &reserved_id()],
        )
        .await?;

    // An agent pinned to the reserved row has no credential of its own: with
    // no default it runs on the managed lane (credential_id None, so the
    // managed AI gate and credit reserve apply) ...
    let targets = resolve_agent_targets(
        &transaction,
        &project_id,
        Some(user_id),
        vec!["reservedpin".to_string()],
        None,
    )
    .await
    .map_err(api_error)?;
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].credential_id, None);

    // ... and a reserved id handed in as the default never becomes a target.
    for handles in [
        vec!["reservedpin".to_string()],
        vec!["octo".to_string()],
        vec![],
    ] {
        let targets = resolve_agent_targets(
            &transaction,
            &project_id,
            Some(user_id),
            handles,
            Some(reserved_id()),
        )
        .await
        .map_err(api_error)?;
        assert!(targets.iter().all(|target| target.credential_id.is_none()));
    }

    // With an ordinary default, the agent falls back to it.
    let own = insert_user_credential_row(&transaction, &user_id, true).await?;
    let default_credential_id =
        credentials::load_default_credential_id(&transaction, Some(user_id))
            .await
            .map_err(api_error)?;
    assert_eq!(default_credential_id, Some(own));
    let targets = resolve_agent_targets(
        &transaction,
        &project_id,
        Some(user_id),
        vec!["reservedpin".to_string()],
        default_credential_id,
    )
    .await
    .map_err(api_error)?;
    assert_eq!(targets[0].credential_id, Some(own));

    transaction.rollback().await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_security_jobs_never_pin_the_reserved_credential_id() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("dispatch reserved credential id jobs").await?;
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let user_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let project = ProjectRecord {
        id: project_id,
        org_id: None,
        name: None,
        sandbox_session_id: None,
        project_type: None,
        owner_user_id: Some(user_id),
        _status: None,
    };
    let context = RequestContext {
        user_id: Some(user_id),
        is_service_role: false,
        scoped_claims: None,
    };
    let request = normalized_request(project_id, Uuid::new_v4());

    let error = agent::enqueue_agent_job_record(
        &transaction,
        &project,
        &context,
        &request,
        &Uuid::new_v4(),
        &Uuid::new_v4(),
        None,
        Some(crate::config::managed_ai_credential_id()),
        None,
        None,
    )
    .await
    .expect_err("a job never pins the reserved id");
    assert_eq!(error.0, StatusCode::NOT_FOUND);
    let jobs: i64 = transaction
        .query_one(
            "select count(*)::bigint as count from agent_jobs where project_id = $1",
            &[&project_id],
        )
        .await?
        .get("count");
    assert_eq!(jobs, 0);

    transaction.rollback().await?;
    Ok(())
}

/// Gives `user_id` an agent `handle` pinned to `credential_id`.
async fn insert_agent_pin(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
    handle: &str,
    credential_id: &Uuid,
) -> anyhow::Result<()> {
    transaction
        .execute(
            "insert into user_agents (id, user_id, credential_id, provider, handle, avatar_seed)
             values ($1, $2, $3, 'openai', $4, $4)",
            &[&Uuid::new_v4(), user_id, credential_id, &handle],
        )
        .await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_security_agents_only_use_credentials_their_owner_holds() -> anyhow::Result<()> {
    use crate::credentials::reserved_id_tests::{
        api_error, insert_test_user, insert_user_credential_row,
    };

    let pool = require_origin_test_pool("dispatch agent credential owner").await?;
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    // Model pins stored before user_agents_credential_owner existed: disable
    // it inside this transaction only, as its first lock, and roll back, so
    // nothing persists and no other session sees the change.
    transaction
        .batch_execute(
            "set local lock_timeout = '5s';
             alter table user_agents disable trigger user_agents_credential_owner;",
        )
        .await?;
    let owner = Uuid::new_v4();
    let other = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    insert_test_user(&transaction, &owner).await?;
    insert_test_user(&transaction, &other).await?;
    let others_credential = insert_user_credential_row(&transaction, &other, true).await?;
    insert_agent_pin(&transaction, &owner, "pinned", &others_credential).await?;

    // A stored pin to a credential the owner does not hold is no pin: with no
    // default of its own the agent runs on the managed lane.
    let targets = resolve_agent_targets(
        &transaction,
        &project_id,
        Some(owner),
        vec!["pinned".to_string()],
        None,
    )
    .await
    .map_err(api_error)?;
    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].credential_id, None);

    // With a default of its own, the agent falls back to it, and an agent
    // pinned to a credential its owner holds keeps that credential.
    let own_default = insert_user_credential_row(&transaction, &owner, true).await?;
    let own_pinned = insert_user_credential_row(&transaction, &owner, false).await?;
    insert_agent_pin(&transaction, &owner, "ownpin", &own_pinned).await?;
    let default_credential_id = credentials::load_default_credential_id(&transaction, Some(owner))
        .await
        .map_err(api_error)?;
    assert_eq!(default_credential_id, Some(own_default));
    let targets = resolve_agent_targets(
        &transaction,
        &project_id,
        Some(owner),
        vec!["pinned".to_string(), "ownpin".to_string()],
        default_credential_id,
    )
    .await
    .map_err(api_error)?;
    assert_eq!(targets.len(), 2);
    assert_eq!(targets[0].credential_id, Some(own_default));
    assert_eq!(targets[1].credential_id, Some(own_pinned));

    transaction.rollback().await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_security_schema_refuses_an_agent_pin_its_owner_does_not_hold(
) -> anyhow::Result<()> {
    use crate::credentials::reserved_id_tests::{insert_test_user, insert_user_credential_row};
    use tokio_postgres::error::SqlState;

    let pool = require_origin_test_pool("agent credential owner schema check").await?;
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let owner = Uuid::new_v4();
    let other = Uuid::new_v4();
    insert_test_user(&transaction, &owner).await?;
    insert_test_user(&transaction, &other).await?;
    let own = insert_user_credential_row(&transaction, &owner, true).await?;
    let others_credential = insert_user_credential_row(&transaction, &other, true).await?;

    insert_agent_pin(&transaction, &owner, "ownpin", &own).await?;
    let error = insert_agent_pin(&transaction, &owner, "otherpin", &others_credential)
        .await
        .expect_err("an agent cannot pin a credential its owner does not hold");
    let db_error = error
        .downcast_ref::<tokio_postgres::Error>()
        .and_then(tokio_postgres::Error::as_db_error)
        .expect("database error");
    assert_eq!(db_error.code(), &SqlState::FOREIGN_KEY_VIOLATION);
    // The transaction is aborted and is rolled back on drop.
    Ok(())
}

#[tokio::test]
async fn dispatch_security_credential_seeded_agents_take_the_agent_id_as_avatar_seed(
) -> anyhow::Result<()> {
    use crate::credentials::reserved_id_tests::{
        api_error, insert_test_user, insert_user_credential_row,
    };

    let pool = require_origin_test_pool("credential-seeded agent avatar seed").await?;
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let owner = Uuid::new_v4();
    insert_test_user(&transaction, &owner).await?;
    let credential_id = insert_user_credential_row(&transaction, &owner, true).await?;

    let (agent_id, _handle) = ai_agents::create_default_agent_for_credential(
        &transaction,
        owner,
        credential_id,
        Some("Seeded"),
        None,
        None,
        None,
        "openai",
    )
    .await
    .map_err(api_error)?;
    let row = transaction
        .query_one(
            "select avatar_seed, credential_id from user_agents where id = $1",
            &[&agent_id],
        )
        .await?;
    assert_eq!(row.get::<_, String>("avatar_seed"), agent_id.to_string());
    assert_eq!(
        row.get::<_, Option<Uuid>>("credential_id"),
        Some(credential_id)
    );

    transaction.rollback().await?;
    Ok(())
}

#[tokio::test]
async fn dispatch_security_owned_sandbox_sessions_grant_nothing() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("owned sandbox session regression").await?;
    let owner_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_id).await?;
    let result = AssertUnwindSafe(async {
        let config = test_config();
        let project_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        // A person's sandbox, as clients could create before only the service
        // role could.
        transaction
            .execute(
                "insert into projects (id, project_type, status, sandbox_session_id, owner_user_id)
                 values ($1, 'sandbox', 'active', $2, $3)",
                &[&project_id, &session_id, &owner_id],
            )
            .await?;
        let anonymous = RequestContext {
            user_id: None,
            is_service_role: false,
            scoped_claims: None,
        };
        let denied = ensure_project_record_for_dispatch(
            &transaction,
            &config,
            &normalized_request(project_id, session_id),
            &anonymous,
        )
        .await
        .err()
        .expect("an owned sandbox's session must not grant access");
        assert_eq!(denied.0, StatusCode::UNAUTHORIZED);
        transaction.rollback().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    pool.get()
        .await?
        .execute("delete from auth.users where id = $1", &[&owner_id])
        .await?;
    match result {
        Ok(result) => result,
        Err(panic) => resume_unwind(panic),
    }
}

#[tokio::test]
async fn dispatch_security_only_the_service_role_creates_sandbox_projects() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("sandbox creation regression").await?;
    let user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, 'Sandbox test team')",
                &[&org_id, &format!("sandbox-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
                &[&org_id, &user_id],
            )
            .await?;
    }
    let result = AssertUnwindSafe(async {
        let config = test_config();
        let token = crate::auth::issue_controller_token(&config, &user_id)
            .expect("issue user token")
            .token;
        let app = crate::projects::router().with_state(build_test_state(pool.clone(), config));
        for body in [
            json!({ "projectType": "sandbox", "sandboxSessionId": Uuid::new_v4() }),
            json!({ "projectType": " Sandbox " }),
            json!({ "sandboxSessionId": Uuid::new_v4() }),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/orgs/{org_id}/projects"))
                        .header("authorization", format!("Bearer {token}"))
                        .header("content-type", "application/json")
                        .body(Body::from(body.to_string()))?,
                )
                .await?;
            let status = response.status();
            let reply: JsonValue =
                serde_json::from_slice(&to_bytes(response.into_body(), 16_384).await?)?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}: {reply}");
            assert_eq!(
                reply["message"], "Only service-role requests can create sandbox projects",
                "{body}"
            );
        }
        let created: i64 = pool
            .get()
            .await?
            .query_one(
                "select count(*) from projects where org_id = $1",
                &[&org_id],
            )
            .await?
            .get(0);
        assert_eq!(created, 0, "refused requests create no space");
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let connection = pool.get().await?;
    connection
        .execute("delete from projects where org_id = $1", &[&org_id])
        .await?;
    connection
        .execute("delete from organizations where id = $1", &[&org_id])
        .await?;
    connection
        .execute("delete from auth.users where id = $1", &[&user_id])
        .await?;
    match result {
        Ok(result) => result,
        Err(panic) => resume_unwind(panic),
    }
}

/// The one-time sandbox credit seed follows the stored project, never the
/// request: only a sandbox the controller provisioned (stored `sandbox`, no
/// owner) is seeded. A client's `metadata.project_type`, a person's own
/// "sandbox" space, a session id stored on a customer space and a userless
/// caller on an ownerless customer space grant nothing. The seed's ledger row
/// never records the space's session id, which is the way into a provisioned
/// sandbox and which every reader of the team's ledger would see.
#[tokio::test]
async fn dispatch_security_sandbox_seed_follows_the_stored_project() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("sandbox seed regression").await?;
    let owner_id = Uuid::new_v4();
    ensure_test_user(&pool, &owner_id).await?;
    let result = AssertUnwindSafe(async {
        let config = test_config();
        let person = RequestContext {
            user_id: Some(owner_id),
            is_service_role: false,
            scoped_claims: None,
        };
        let service = RequestContext {
            user_id: None,
            is_service_role: true,
            scoped_claims: None,
        };
        // (stored type, owned, stored session id, caller, metadata.project_type, seeded)
        let cases: [(&str, bool, bool, &RequestContext, Option<&str>, bool); 7] = [
            ("customer", true, false, &person, Some("sandbox"), false),
            ("customer", true, false, &person, Some(" Demo "), false),
            ("customer", true, true, &person, None, false),
            ("sandbox", true, true, &person, Some("sandbox"), false),
            ("customer", false, false, &service, None, false),
            ("sandbox", false, true, &service, Some("customer"), true),
            ("sandbox", false, false, &service, None, true),
        ];
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        for (index, (project_type, owned, with_session, caller, claimed, seeded)) in
            cases.into_iter().enumerate()
        {
            let org_id = Uuid::new_v4();
            let project_id = Uuid::new_v4();
            let stored_session = with_session.then(Uuid::new_v4);
            let owner_user_id = owned.then_some(owner_id);
            transaction
                .execute(
                    "insert into organizations (id, slug, name) values ($1, $2, 'Seed test team')",
                    &[&org_id, &format!("seed-{org_id}")],
                )
                .await?;
            transaction
                .execute(
                    "insert into projects
                       (id, org_id, project_type, status, sandbox_session_id, owner_user_id)
                     values ($1, $2, $3, 'active', $4, $5)",
                    &[
                        &project_id,
                        &org_id,
                        &project_type,
                        &stored_session,
                        &owner_user_id,
                    ],
                )
                .await?;
            // As on any dispatch, the team's subscription comes first; then its
            // balance and refill limit are emptied, when a seed would be granted.
            let project = crate::projects::load_project_record(&transaction, &project_id)
                .await
                .expect("load seed fixture");
            ensure_project_org(&transaction, &project)
                .await
                .expect("set up the team's subscription");
            transaction
                .execute(
                    "insert into org_credit_balances (org_id, balance, credit_limit) values ($1, 0, 0)
                     on conflict (org_id) do update set balance = 0, credit_limit = 0",
                    &[&org_id],
                )
                .await?;
            let mut body = json!({
                "projectId": project_id,
                "promptText": "echo sandbox-seed",
                "intent": "terminal_command",
            });
            if let Some(claimed) = claimed {
                body["metadata"] = json!({ "project_type": claimed });
            }
            let request = normalize_dispatch_request(serde_json::from_value(body)?)
                .expect("normalize seed request");
            let _project =
                ensure_project_record_for_dispatch(&transaction, &config, &request, caller)
                    .await
                    .unwrap_or_else(|error| panic!("case {index}: {error:?}"));
            let row = transaction
                .query_one(
                    "select balance, credit_limit,
                            (select count(*) from org_credit_ledger
                              where org_id = $1 and reason = 'sandbox_seed') as seeds,
                            (select count(*) from org_credit_ledger
                              where org_id = $1 and metadata ? 'sandbox_session_id') as sessions
                       from org_credit_balances where org_id = $1",
                    &[&org_id],
                )
                .await?;
            let observed: (i64, i32, i32) =
                (row.get("seeds"), row.get("balance"), row.get("credit_limit"));
            let expected = if seeded {
                (
                    1,
                    config.sandbox_credit_seed_amount,
                    config.sandbox_credit_seed_limit,
                )
            } else {
                (0, 0, 0)
            };
            assert_eq!(
                observed, expected,
                "case {index}: {project_type}, owned={owned}"
            );
            assert_eq!(
                row.get::<_, i64>("sessions"),
                0,
                "case {index}: the ledger must not record the session id"
            );
        }
        transaction.rollback().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    pool.get()
        .await?
        .execute("delete from auth.users where id = $1", &[&owner_id])
        .await?;
    match result {
        Ok(result) => result,
        Err(panic) => resume_unwind(panic),
    }
}

/// A service-role bootstrap stores only a type the row can hold: a named
/// `sandbox` or `customer`, else a customer space for a caller with a user and
/// a sandbox for one without. A `demo` falls back to that default instead of
/// failing the insert.
#[tokio::test]
async fn dispatch_security_service_bootstrap_stores_a_storable_type() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("service bootstrap type regression").await?;
    let user_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;
    let result = AssertUnwindSafe(async {
        let config = test_config();
        let userless = RequestContext {
            user_id: None,
            is_service_role: true,
            scoped_claims: None,
        };
        let for_user = RequestContext {
            user_id: Some(user_id),
            is_service_role: true,
            scoped_claims: None,
        };
        // (caller, metadata.project_type, stored type)
        let cases: [(&RequestContext, Option<&str>, &str); 4] = [
            (&userless, None, "sandbox"),
            (&userless, Some("demo"), "sandbox"),
            (&userless, Some(" Customer "), "customer"),
            (&for_user, Some("demo"), "customer"),
        ];
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        for (index, (caller, named, expected)) in cases.into_iter().enumerate() {
            let project_id = Uuid::new_v4();
            let mut body = json!({
                "projectId": project_id,
                "promptText": "echo service-bootstrap",
                "intent": "terminal_command",
            });
            if let Some(named) = named {
                body["metadata"] = json!({ "project_type": named });
            }
            let request = normalize_dispatch_request(serde_json::from_value(body)?)
                .expect("normalize bootstrap request");
            ensure_project_record_for_dispatch(&transaction, &config, &request, caller)
                .await
                .unwrap_or_else(|error| panic!("case {index}: {error:?}"));
            let row = transaction
                .query_one(
                    "select project_type, owner_user_id from projects where id = $1",
                    &[&project_id],
                )
                .await?;
            assert_eq!(
                row.get::<_, String>("project_type"),
                expected,
                "case {index}: {named:?}"
            );
            assert_eq!(
                row.get::<_, Option<Uuid>>("owner_user_id"),
                caller.user_id,
                "case {index}"
            );
        }
        transaction.rollback().await?;
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    pool.get()
        .await?
        .execute("delete from auth.users where id = $1", &[&user_id])
        .await?;
    match result {
        Ok(result) => result,
        Err(panic) => resume_unwind(panic),
    }
}

/// Concurrent dispatches to a provisioned sandbox seed its team once. Each
/// used to find no seed and an empty balance before the other committed, and
/// each granted one; the second now waits on the team's balance row and then
/// finds the first one's seed.
#[tokio::test]
async fn dispatch_security_concurrent_dispatches_seed_a_sandbox_once() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("concurrent sandbox seed regression").await?;
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    // Both dispatches must see the sandbox, so it is committed, with its
    // team's subscription and then an empty balance and refill limit.
    {
        let mut connection = pool.get().await?;
        let transaction = connection.transaction().await?;
        transaction
            .execute(
                "insert into organizations (id, slug, name) values ($1, $2, 'Seed race team')",
                &[&org_id, &format!("seed-race-{org_id}")],
            )
            .await?;
        transaction
            .execute(
                "insert into projects (id, org_id, project_type, status, sandbox_session_id)
                 values ($1, $2, 'sandbox', 'active', $3)",
                &[&project_id, &org_id, &Uuid::new_v4()],
            )
            .await?;
        let project = crate::projects::load_project_record(&transaction, &project_id)
            .await
            .expect("load seed race fixture");
        ensure_project_org(&transaction, &project)
            .await
            .expect("set up the team's subscription");
        transaction
            .execute(
                "insert into org_credit_balances (org_id, balance, credit_limit) values ($1, 0, 0)
                 on conflict (org_id) do update set balance = 0, credit_limit = 0",
                &[&org_id],
            )
            .await?;
        transaction.commit().await?;
    }
    let result = AssertUnwindSafe(async {
        let config = test_config();
        let service = RequestContext {
            user_id: None,
            is_service_role: true,
            scoped_claims: None,
        };
        let request = normalize_dispatch_request(serde_json::from_value(json!({
            "projectId": project_id,
            "promptText": "echo sandbox-seed-race",
            "intent": "terminal_command",
        }))?)
        .expect("normalize seed race request");
        let mut first_connection = pool.get().await?;
        let mut second_connection = pool.get().await?;
        let first_pid: i32 = first_connection
            .query_one("select pg_backend_pid()", &[])
            .await?
            .get(0);
        let second_pid: i32 = second_connection
            .query_one("select pg_backend_pid()", &[])
            .await?
            .get(0);
        let first = first_connection.transaction().await?;
        ensure_project_record_for_dispatch(&first, &config, &request, &service)
            .await
            .expect("the first dispatch seeds the team");
        let second = second_connection.transaction().await?;
        let (second_dispatch, first_commit) = tokio::join!(
            async {
                ensure_project_record_for_dispatch(&second, &config, &request, &service)
                    .await
                    .expect("the second dispatch is admitted");
                second.commit().await
            },
            async {
                // The first commits only once the second waits on it, so the
                // second has looked at the team before the first seed shows.
                eventually("the second dispatch to wait on the first", || async {
                    let waiting: bool = sql_one(
                        &pool,
                        "select $2 = any(pg_blocking_pids($1))",
                        &[&second_pid, &first_pid],
                    )
                    .await?;
                    Ok(waiting.then_some(()))
                })
                .await?;
                first.commit().await?;
                Ok::<_, anyhow::Error>(())
            }
        );
        first_commit?;
        second_dispatch?;
        let row = pool
            .get()
            .await?
            .query_one(
                "select balance, credit_limit,
                        (select count(*) from org_credit_ledger
                          where org_id = $1 and reason = 'sandbox_seed') as seeds
                   from org_credit_balances where org_id = $1",
                &[&org_id],
            )
            .await?;
        let observed: (i64, i32, i32) = (
            row.get("seeds"),
            row.get("balance"),
            row.get("credit_limit"),
        );
        assert_eq!(
            observed,
            (
                1,
                config.sandbox_credit_seed_amount,
                config.sandbox_credit_seed_limit,
            )
        );
        Ok::<_, anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    pool.get()
        .await?
        .execute("delete from organizations where id = $1", &[&org_id])
        .await?;
    match result {
        Ok(result) => result,
        Err(panic) => resume_unwind(panic),
    }
}
