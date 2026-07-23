use axum::{
    middleware,
    routing::{get, post},
    Json, Router,
};

use crate::{auth, error::AppResult, state::AppState};

mod tunnels;

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/tunnels", post(tunnels::create))
        .route("/tunnels/:id", get(tunnels::get).delete(tunnels::revoke))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    Router::new()
        .route("/healthz", get(health))
        .merge(protected)
        .with_state(state)
}

async fn health() -> AppResult<Json<&'static str>> {
    Ok(Json("ok"))
}
