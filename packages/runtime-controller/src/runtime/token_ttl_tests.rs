use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use crate::tests::{
    build_app_config, build_test_state, require_origin_test_pool, test_origin_private_key,
    test_origin_public_key,
};

fn token_request(project_id: Uuid, bearer: &str, body: Value) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri(format!("/projects/{project_id}/runtime/token"))
        .header("authorization", format!("Bearer {bearer}"))
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .expect("valid runtime token request")
}

#[tokio::test]
async fn runtime_token_endpoint_rejects_invalid_ttl_before_database_access() -> anyhow::Result<()> {
    let manager = bb8_postgres::PostgresConnectionManager::new_from_stringlike(
        "postgresql://ignored:ignored@127.0.0.1:1/postgres",
        crate::config::database_tls(),
    )?;
    let pool = bb8::Pool::builder()
        .max_size(1)
        .connection_timeout(std::time::Duration::from_millis(100))
        .build_unchecked(manager);
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "runtime-token-ttl",
    );
    let user_token = crate::auth::issue_controller_token(&config, &Uuid::new_v4())
        .map_err(|error| anyhow::anyhow!("failed to issue user token: {error:?}"))?
        .token;
    let app = crate::runtime::router().with_state(build_test_state(pool, config));

    for bearer in ["service-role-token", user_token.as_str()] {
        for ttl in [i64::MIN, -1, 0, 59, 3_601, i64::MAX] {
            let response = app
                .clone()
                .oneshot(token_request(
                    Uuid::new_v4(),
                    bearer,
                    json!({ "ttlSeconds": ttl }),
                ))
                .await?;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "ttl={ttl}");
            let error: Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
            assert_eq!(error["message"], "ttlSeconds must be between 60 and 3600");
        }
    }
    Ok(())
}

#[tokio::test]
async fn runtime_token_endpoint_honors_ttl_bounds_and_uses_bounded_default() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("runtime token TTL mint test").await?;
    let project_id = Uuid::new_v4();
    pool.get()
        .await?
        .execute(
            "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
            &[&project_id],
        )
        .await?;

    let result = async {
        // The origin-token setting is not a runtime-token lifetime override.
        // Neither configuration extreme may reach date arithmetic from this route.
        for configured_origin_ttl in [i64::MIN, 300, i64::MAX] {
            let mut config = build_app_config(
                test_origin_private_key(),
                test_origin_public_key(),
                "runtime-token-ttl",
            );
            config.origin_token_ttl_seconds = configured_origin_ttl;
            let app =
                crate::runtime::router().with_state(build_test_state(pool.clone(), config.clone()));
            for (body, expected_ttl) in [
                (json!({}), 3_600),
                (json!({ "ttlSeconds": null }), 3_600),
                (json!({ "ttlSeconds": 60 }), 60),
                (json!({ "ttlSeconds": 600 }), 600),
                (json!({ "ttlSeconds": 3_600 }), 3_600),
            ] {
                let response = app
                    .clone()
                    .oneshot(token_request(project_id, "service-role-token", body))
                    .await?;
                assert_eq!(response.status(), StatusCode::OK);
                let minted: super::RuntimeTokenResponse =
                    serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
                let claims =
                    crate::tokens::decode_scoped_token(&config, &minted.token, "runtime token")
                        .map_err(|error| {
                            anyhow::anyhow!("invalid minted runtime token: {error:?}")
                        })?;
                assert_eq!(minted.expires_in, expected_ttl);
                assert_eq!(claims.exp - claims.iat, expected_ttl);
                assert_eq!(
                    chrono::DateTime::parse_from_rfc3339(&minted.expires_at)?.timestamp(),
                    claims.exp
                );
            }
        }
        anyhow::Ok(())
    }
    .await;

    pool.get()
        .await?
        .execute("delete from projects where id = $1", &[&project_id])
        .await?;
    result
}
