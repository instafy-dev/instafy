use crate::{error::AppError, state::AppState};
use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};

pub async fn require_auth(
    State(state): axum::extract::State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Result<Response, AppError> {
    let Some(header_value) = request.headers().get("authorization") else {
        return unauthorized();
    };

    let auth_header = header_value
        .to_str()
        .map_err(|_| AppError::bad_request("invalid authorization header"))?;
    let Some(token) = auth_header
        .strip_prefix("Bearer ")
        .or_else(|| auth_header.strip_prefix("bearer "))
    else {
        return unauthorized();
    };
    let token = token.trim();

    if state.config().api_tokens.is_empty() {
        return Ok(next.run(request).await);
    }

    let allowed = state
        .config()
        .api_tokens
        .iter()
        .any(|candidate| candidate == token);

    if !allowed {
        return unauthorized();
    }

    Ok(next.run(request).await)
}

fn unauthorized<T>() -> Result<T, AppError> {
    Err(AppError {
        status: StatusCode::UNAUTHORIZED,
        message: "unauthorized".to_string(),
    })
}
