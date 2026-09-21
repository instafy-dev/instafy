//! Route-level coverage for the managed credential lease. A proxy that
//! received a credential-less (managed lane) token leases the fixed
//! `MANAGED_AI_CREDENTIAL_ID`; the controller answers it from configuration
//! under the proxy lease bearer and never consults `user_credentials`.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::{AppConfig, MANAGED_AI_CREDENTIAL_ID};
use crate::tests::{
    build_app_config, build_test_state, setup_origin_test_pool, test_origin_private_key,
    test_origin_public_key,
};

fn managed_config(key_id: &str) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), key_id);
    // No encryption key on purpose: the managed lease must answer before the
    // BYOC path, which would otherwise fail here with a 500.
    config.credential_encryption_key = None;
    config
}

async fn read_json(response: axum::response::Response) -> anyhow::Result<Value> {
    let body = to_bytes(response.into_body(), 64 * 1024).await?;
    Ok(serde_json::from_slice(&body)?)
}

#[tokio::test]
async fn managed_credential_lease_route_serves_the_platform_key_under_the_lease_bearer(
) -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping managed credential lease route test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let mut config = managed_config("managed-credential-lease");
    config.managed_ai_model_id = "gpt-5.6-luna".to_string();
    config.managed_ai_openai_api_key = Some("sk-managed-test".to_string());
    let app = crate::credentials::router().with_state(build_test_state(pool.clone(), config));

    // Only the dedicated proxy lease bearer may read the platform key.
    for (bearer, expected) in [
        ("internal", StatusCode::UNAUTHORIZED),
        ("service-role-token", StatusCode::UNAUTHORIZED),
        ("credential-lease", StatusCode::OK),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!("/internal/credentials/{MANAGED_AI_CREDENTIAL_ID}"))
                    .header("authorization", format!("Bearer {bearer}"))
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), expected, "bearer {bearer}");
        if expected == StatusCode::OK {
            let lease = read_json(response).await?;
            assert_eq!(lease["credentialId"], json!(MANAGED_AI_CREDENTIAL_ID));
            assert_eq!(lease["kind"], json!("openai_api_key"));
            assert_eq!(lease["openaiApiKey"], json!("sk-managed-test"));
            assert_eq!(lease["provider"], json!("openai"));
            assert_eq!(lease["defaultModel"], json!("gpt-5.6-luna"));
            assert_eq!(lease["renewalAuthority"], json!("controller"));
            assert!(lease["leaseExpiresInSeconds"].as_u64().unwrap_or(0) > 0);
        }
    }

    // A renewal after an upstream rejection returns the same material; there
    // is nothing to refresh for an API key.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!(
                    "/internal/credentials/{MANAGED_AI_CREDENTIAL_ID}?forceRefresh=true"
                ))
                .header("authorization", "Bearer credential-lease")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        read_json(response).await?["openaiApiKey"],
        json!("sk-managed-test")
    );

    // The proxy's fire-and-forget usage report is accepted and dropped.
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!(
                    "/internal/credentials/{MANAGED_AI_CREDENTIAL_ID}/usage"
                ))
                .header("authorization", "Bearer credential-lease")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "planName": "Managed" }).to_string()))?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);

    // Nothing above created or touched a credential row.
    let managed_id = Uuid::parse_str(MANAGED_AI_CREDENTIAL_ID)?;
    let connection = pool.get().await?;
    let row = connection
        .query_one(
            "select count(*)::bigint as count from user_credentials where id = $1",
            &[&managed_id],
        )
        .await?;
    assert_eq!(
        row.get::<_, i64>("count"),
        0,
        "the managed credential must never become a user_credentials row"
    );

    Ok(())
}

#[tokio::test]
async fn managed_credential_lease_route_is_closed_without_the_platform_key() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping managed credential lease closed test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    // Env unset: byte-for-byte today's answer for an unknown id class, minus
    // the "credential not found" prefix the studio maps to reconnecting.
    let config = managed_config("managed-credential-lease-closed");
    assert!(config.managed_ai_openai_api_key.is_none());
    let app = crate::credentials::router().with_state(build_test_state(pool.clone(), config));

    let response = app
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/internal/credentials/{MANAGED_AI_CREDENTIAL_ID}"))
                .header("authorization", "Bearer credential-lease")
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let message = read_json(response).await?["message"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        message.contains("MANAGED_AI_OPENAI_API_KEY"),
        "operators need the variable name; got: {message}"
    );
    assert!(
        !message.starts_with("credential not found"),
        "a missing platform key is not a user reconnect case; got: {message}"
    );

    Ok(())
}
