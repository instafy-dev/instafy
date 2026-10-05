//! The gateway's HTTP routes. Browser and flush routes are never mounted:
//! the gateway has no browser and no working copy to flush.

use std::sync::Arc;

use axum::extract::DefaultBodyLimit;
use axum::http::Method;
use axum::routing::get;
use axum::Router;
use tower_http::cors::{Any, CorsLayer};

use super::cache::MirrorCache;
use super::config::HostedGatewayConfig;
use crate::route_auth::RouteAuth;

/// Everything a gateway request needs.
#[derive(Clone)]
// The read and write routes that use these land next.
#[allow(dead_code)]
pub(crate) struct HostedState {
    pub(crate) auth: RouteAuth,
    pub(crate) hosted: Arc<HostedGatewayConfig>,
    pub(crate) cache: Arc<MirrorCache>,
}

pub(crate) fn router(state: HostedState) -> Router {
    let cors_layer = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);

    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .layer(DefaultBodyLimit::disable())
        .layer(cors_layer)
        .with_state(state)
}
