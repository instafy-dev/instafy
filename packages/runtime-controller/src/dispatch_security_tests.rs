use super::*;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key,
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
