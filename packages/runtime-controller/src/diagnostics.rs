use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};

use crate::auth::{authenticate_request, require_user_session};
use crate::runs::{self, RunResultResponse};
use crate::runtime::{self, RuntimeLogEntry, RuntimeLogsQuery};
use crate::{ApiError, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/diagnostics/projects/:project_id/runtime-events",
            get(customer_runtime_events),
        )
        .route("/diagnostics/runs/:run_id/result", get(customer_run_result))
}

async fn require_customer_session(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let context = authenticate_request(&state.config, headers).await?;
    require_user_session(&context)?;
    Ok(())
}

async fn customer_runtime_events(
    State(state): State<AppState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    Query(query): Query<RuntimeLogsQuery>,
) -> Result<Json<Vec<RuntimeLogEntry>>, (StatusCode, Json<ApiError>)> {
    require_customer_session(&state, &headers).await?;
    runtime::runtime_logs(State(state), Path(project_id), headers, Query(query)).await
}

async fn customer_run_result(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(run_id): Path<String>,
) -> Result<Json<RunResultResponse>, (StatusCode, Json<ApiError>)> {
    require_customer_session(&state, &headers).await?;
    runs::get_run_result(State(state), headers, Path(run_id)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;
    use uuid::Uuid;

    use crate::tests::{
        build_app_config, build_test_state, require_origin_test_pool, test_origin_private_key,
        test_origin_public_key,
    };

    #[tokio::test]
    async fn customer_diagnostics_routes_require_interactive_users() -> anyhow::Result<()> {
        let pool = require_origin_test_pool("customer diagnostics authentication test").await?;
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "test-origin-key",
        );
        let project_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let scoped_token =
            crate::auth::issue_agent_token(&config, &project_id, &runtime_id, None, None)
                .expect("mint scoped runtime token")
                .token;
        let user_token = crate::auth::issue_controller_token(&config, &Uuid::new_v4())
            .expect("mint user controller token")
            .token;
        let app = router().with_state(build_test_state(pool, config));
        let paths = [
            format!("/diagnostics/runs/{}/result", Uuid::new_v4()),
            format!("/diagnostics/projects/{}/runtime-events", Uuid::new_v4()),
        ];

        for path in &paths {
            let response = app
                .clone()
                .oneshot(Request::builder().uri(path).body(Body::empty())?)
                .await?;
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "path={path}");

            for token in ["service-role-token", scoped_token.as_str()] {
                let response = app
                    .clone()
                    .oneshot(
                        Request::builder()
                            .uri(path)
                            .header("authorization", format!("Bearer {token}"))
                            .body(Body::empty())?,
                    )
                    .await?;
                assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "path={path}");
            }

            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .uri(path)
                        .header("authorization", format!("Bearer {user_token}"))
                        .body(Body::empty())?,
                )
                .await?;
            assert_eq!(response.status(), StatusCode::NOT_FOUND, "path={path}");
        }

        Ok(())
    }
}
