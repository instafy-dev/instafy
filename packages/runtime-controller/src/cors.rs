use std::time::Duration;

use tower_http::cors::CorsLayer;

/// How long a browser may reuse a preflight answer. Studio calls the
/// controller cross-origin with an `Authorization` header, so every request
/// that is not cached this way costs an OPTIONS round trip first: a poll every
/// 400 ms (a pending browser approval) was two requests every 400 ms.
/// Chromium caps the value at two hours and Firefox at a day; ten minutes keeps
/// a changed policy from lingering.
pub(crate) const PREFLIGHT_MAX_AGE: Duration = Duration::from_secs(600);

/// The controller's CORS policy: permissive (bearer tokens, not cookies,
/// authorize every route), with preflight answers cached.
pub(crate) fn controller_cors_layer() -> CorsLayer {
    CorsLayer::permissive().max_age(PREFLIGHT_MAX_AGE)
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{header, Method, Request, StatusCode};
    use axum::routing::get;
    use axum::Router;
    use tower::ServiceExt;

    use super::*;

    #[tokio::test]
    async fn a_preflight_answer_is_cached_for_ten_minutes() {
        let app = Router::new()
            .route(
                "/origin/:origin_id/browser/approval/pending",
                get(|| async { "null" }),
            )
            .layer(controller_cors_layer());
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::OPTIONS)
                    .uri("/origin/origin-1/browser/approval/pending")
                    .header(header::ORIGIN, "http://localhost:5174")
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                    .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "authorization")
                    .body(Body::empty())
                    .expect("preflight request"),
            )
            .await
            .expect("preflight response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_MAX_AGE),
            Some(&header::HeaderValue::from_static("600"))
        );
        // Still permissive: any origin, the requested headers.
        assert_eq!(
            response.headers().get(header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&header::HeaderValue::from_static("*"))
        );
        assert!(response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_HEADERS)
            .is_some());
    }
}
