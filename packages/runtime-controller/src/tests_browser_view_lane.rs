//! The view-only RFB lane through the origin proxy: a person who may only
//! watch the browser (`browser.view`) reaches `browser/vnc/view`, while the
//! driver's lane `browser/vnc`, which passes input through, still needs
//! `browser.control` too.

use std::net::SocketAddr;

use axum::http::StatusCode;
use tokio_tungstenite::tungstenite::Error as WsError;
use uuid::Uuid;

use crate::config::PgPool;
use crate::origins;
use crate::tests::{
    build_app_config, build_test_state, test_origin_private_key, test_origin_public_key,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};

/// A pool that never connects: the proxy refuses a token before it reads the
/// origin, and reading the origin then fails with a server error.
fn unreachable_pool() -> anyhow::Result<PgPool> {
    let manager = bb8_postgres::PostgresConnectionManager::new_from_stringlike(
        "postgresql://ignored:ignored@127.0.0.1:1/postgres",
        crate::config::database_tls(),
    )?;
    Ok(bb8::Pool::builder()
        .max_size(1)
        .connection_timeout(std::time::Duration::from_millis(200))
        .build_unchecked(manager))
}

async fn upgrade_status(address: SocketAddr, path: &str) -> StatusCode {
    match tokio_tungstenite::connect_async(format!("ws://{address}{path}")).await {
        Ok(_) => StatusCode::SWITCHING_PROTOCOLS,
        Err(WsError::Http(response)) => {
            StatusCode::from_u16(response.status().as_u16()).expect("an HTTP status")
        }
        Err(error) => panic!("unexpected websocket error for {path}: {error}"),
    }
}

#[tokio::test]
async fn a_viewer_reaches_the_view_only_lane_but_not_the_drivers_lane() -> anyhow::Result<()> {
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "view-lane-test",
    );
    let project_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let viewer = mint_scoped_token(
        &config,
        ScopedTokenRequest {
            audience: origin_id.to_string(),
            subject: Uuid::new_v4().to_string(),
            project_id: project_id.to_string(),
            origin_id: Some(origin_id.to_string()),
            runtime_id: None,
            protocol: None,
            scopes: vec!["browser.view".to_string()],
            lease_id: None,
            run_id: None,
            prefer_runtime: None,
            ttl_seconds: Some(300),
        },
    )
    .map_err(|error| anyhow::anyhow!("mint the viewer's token: {error:?}"))?;
    let app = origins::router().with_state(build_test_state(unreachable_pool()?, config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let server = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });

    // The driver's lane refuses a token that may only watch.
    let driver = upgrade_status(
        address,
        &format!("/origin/{origin_id}/browser/vnc?token={}", viewer.token),
    )
    .await;
    assert_eq!(driver, StatusCode::UNAUTHORIZED);
    // The view-only lane takes it: the proxy goes on to read the origin,
    // which this test's database cannot answer.
    let view = upgrade_status(
        address,
        &format!(
            "/origin/{origin_id}/browser/vnc/view?token={}",
            viewer.token
        ),
    )
    .await;
    assert_ne!(
        view,
        StatusCode::UNAUTHORIZED,
        "the viewer's token was refused"
    );
    assert_ne!(
        view,
        StatusCode::NOT_FOUND,
        "the view-only lane is not routed"
    );
    assert_eq!(view, StatusCode::INTERNAL_SERVER_ERROR);
    // Without a token, neither lane opens.
    let anonymous = upgrade_status(address, &format!("/origin/{origin_id}/browser/vnc/view")).await;
    assert_eq!(anonymous, StatusCode::UNAUTHORIZED);

    server.abort();
    Ok(())
}
