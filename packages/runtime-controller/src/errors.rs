use std::cell::RefCell;
use std::fmt::Display;
use std::future::Future;

use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;
use serde_json::Value as JsonValue;
use tokio_postgres::error::SqlState;

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

tokio::task_local! {
    /// What [`note_sql_state`] noted in the [`noting_sql_states`] it runs in.
    static NOTED_SQL_STATES: RefCell<Vec<SqlState>>;
}

/// Runs `body`, and returns its output with the SQLSTATE of each failed
/// statement whose error was noted while it ran ([`note_sql_state`]), first
/// to last.
///
/// A statement's failure reaches its caller as `(StatusCode, Json<ApiError>)`,
/// whose message keeps no SQLSTATE (see [`describe_db_error`]), and a
/// savepoint that gives up on it returns no error at all. A caller that must
/// still tell a lost lock race from a bug reads the codes here: the give-back
/// of a stopped browser turn's reserve
/// (`system_turns::give_back_reserve_of_lost_browser_turn`), whose statements
/// note theirs.
pub(crate) async fn noting_sql_states<T>(body: impl Future<Output = T>) -> (T, Vec<SqlState>) {
    NOTED_SQL_STATES
        .scope(RefCell::new(Vec::new()), async move {
            let output = body.await;
            (output, NOTED_SQL_STATES.with(RefCell::take))
        })
        .await
}

/// Notes the SQLSTATE of `error`, a statement's failure, for the
/// [`noting_sql_states`] that runs the statement. Outside one it does nothing,
/// so a caller that does not read the codes sees no change.
pub(crate) fn note_sql_state(error: &tokio_postgres::Error) {
    if let Some(code) = error.code() {
        let _ = NOTED_SQL_STATES.try_with(|noted| noted.borrow_mut().push(code.clone()));
    }
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
