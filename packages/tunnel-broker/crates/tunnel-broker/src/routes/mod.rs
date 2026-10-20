use axum::{
    middleware,
    routing::{get, post},
    Json, Router,
};

use crate::{auth, error::AppResult, state::AppState};

mod capabilities;
pub(crate) mod preview_auth;
mod probe;
mod tunnels;

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/tunnels", post(tunnels::create))
        .route("/tunnels/:id", get(tunnels::get).delete(tunnels::revoke))
        .route("/tunnels/:id/probe", get(probe::probe))
        .route("/capabilities", get(capabilities::capabilities))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            auth::require_auth,
        ));

    Router::new()
        .route("/healthz", get(health))
        // Called by Traefik for every private preview request; the capability in the
        // forwarded host is the credential, so these sit outside the broker API token.
        .route("/preview-auth", get(preview_auth::preview_auth))
        .route("/preview-error/:status", get(preview_auth::preview_error))
        .merge(protected)
        .with_state(state)
}

async fn health() -> AppResult<Json<&'static str>> {
    Ok(Json("ok"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::test_broker_config;

    async fn serve(state: AppState) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn capabilities_need_the_api_token_and_preview_auth_does_not() {
        let mut config = test_broker_config();
        config.api_tokens = vec!["api-token".into()];
        let base = serve(AppState::for_tests(config)).await;
        let http = reqwest::Client::new();

        let anonymous = http
            .get(format!("{base}/capabilities"))
            .send()
            .await
            .unwrap();
        assert_eq!(anonymous.status(), reqwest::StatusCode::UNAUTHORIZED);

        let authed = http
            .get(format!("{base}/capabilities"))
            .bearer_auth("api-token")
            .send()
            .await
            .unwrap();
        assert_eq!(authed.status(), reqwest::StatusCode::OK);
        let body: serde_json::Value = authed.json().await.unwrap();
        assert_eq!(body["privatePreviews"], true);

        // Traefik calls forwardAuth without the API token; the capability host is the
        // credential, so an unknown host gets the preview's own 401 page.
        let forward = http
            .get(format!("{base}/preview-auth"))
            .header("x-forwarded-host", "example.test")
            .send()
            .await
            .unwrap();
        assert_eq!(forward.status(), reqwest::StatusCode::UNAUTHORIZED);
        assert!(forward.text().await.unwrap().contains("instafy-preview"));
    }
}
