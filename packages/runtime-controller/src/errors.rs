use std::fmt::Display;

use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;
use serde_json::Value as JsonValue;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApiError {
    pub(crate) message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) details: Option<JsonValue>,
}

impl ApiError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: None,
            details: None,
        }
    }

    pub(crate) fn with_details(
        message: impl Into<String>,
        code: impl Into<String>,
        details: JsonValue,
    ) -> Self {
        Self {
            message: message.into(),
            code: Some(code.into()),
            details: Some(details),
        }
    }
}

fn is_transient_database_error(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    normalized.contains("timed out in bb8")
        || normalized.contains("failed to get connection:")
        || normalized.contains("failed to acquire connection:")
        || normalized.contains("failed to start transaction: timed out in bb8")
        || normalized.contains("failed to begin transaction: timed out in bb8")
        || (normalized.contains("failed to start ") && normalized.contains("timed out in bb8"))
}

pub(crate) fn internal_error(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    let message = message.into();
    if is_transient_database_error(&message) {
        tracing::warn!(error = %message, "database temporarily unavailable");
        return service_unavailable("Instafy is temporarily unavailable. Please retry.");
    }
    // A 500 used to return in silence: only the transient branch above logged.
    // A create-space failure therefore produced a dead dialog on the client and
    // not one line on the server, which is a long way to walk to find out that
    // a statement failed.
    tracing::error!(error = %message, "request failed");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError::new(message)),
    )
}

/// A database error together with the cause Postgres actually reported.
///
/// `tokio_postgres::Error`'s `Display` is the three words "db error" and
/// nothing else: the SQLSTATE and the message hang off `source()`. Formatting
/// one with `{error}` flattens every distinct failure into the same string, so
/// the reason a statement was rejected never reaches either the log or the
/// client.
pub(crate) fn describe_db_error(error: &(dyn std::error::Error + 'static)) -> String {
    let mut described = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        described.push_str(": ");
        described.push_str(&cause.to_string());
        source = cause.source();
    }
    described
}

pub(crate) fn service_unavailable(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(ApiError::new(message)),
    )
}

pub(crate) fn database_unavailable(
    context: &'static str,
    error: impl Display,
) -> (StatusCode, Json<ApiError>) {
    let error_message = error.to_string();
    tracing::warn!(context, error = %error_message, "database temporarily unavailable");
    service_unavailable(format!(
        "{context} is temporarily unavailable. Please retry."
    ))
}

pub(crate) fn bad_gateway(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (StatusCode::BAD_GATEWAY, Json(ApiError::new(message)))
}

pub(crate) fn bad_request(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (StatusCode::BAD_REQUEST, Json(ApiError::new(message)))
}

pub(crate) fn not_found(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (StatusCode::NOT_FOUND, Json(ApiError::new(message)))
}

pub(crate) fn unauthorized(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (StatusCode::UNAUTHORIZED, Json(ApiError::new(message)))
}

pub(crate) fn forbidden(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (StatusCode::FORBIDDEN, Json(ApiError::new(message)))
}

pub(crate) fn too_many_requests(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (StatusCode::TOO_MANY_REQUESTS, Json(ApiError::new(message)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_error_maps_bb8_timeout_to_service_unavailable() {
        let (status, Json(body)) = internal_error("failed to get connection: Timed out in bb8");
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            body.message,
            "Instafy is temporarily unavailable. Please retry."
        );
    }

    #[test]
    fn internal_error_preserves_non_database_errors() {
        let (status, Json(body)) = internal_error("unexpected panic");
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(body.message, "unexpected panic");
    }
}
