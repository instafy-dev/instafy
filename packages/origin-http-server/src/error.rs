use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: String,
    /// A stable code for clients, where the error has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<&'static str>,
}

/// The code of a 404 for something that is not there at all. A read
/// answers it only when the path is absent; see [`UNSUPPORTED_ENTRY_CODE`].
pub const NOT_FOUND_CODE: &str = "not_found";

/// The code of a 404 for a path that holds something a read never serves:
/// a symlink, a submodule or nested repository, a folder where a file was
/// asked for, or a special file. Clients must never take it for a missing
/// path (and so never turn it into a delete).
pub const UNSUPPORTED_ENTRY_CODE: &str = "unsupported_entry";

#[derive(Debug, Error)]
pub enum OriginError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Internal(String),
    /// A conflict about particular paths, with a stable code for clients.
    #[error("{message}")]
    ConflictPaths {
        code: &'static str,
        message: String,
        paths: Vec<String>,
    },
    /// A failure that carries a structured report (for example a publish
    /// that kept the work on a recovery ref instead of saving it).
    #[error("{message}")]
    WithReport {
        status: StatusCode,
        code: &'static str,
        message: String,
        report: serde_json::Value,
    },
}

impl OriginError {
    pub fn bad_request<T: Into<String>>(message: T) -> Self {
        Self::BadRequest(message.into())
    }

    pub fn unauthorized<T: Into<String>>(message: T) -> Self {
        Self::Unauthorized(message.into())
    }

    pub fn not_found<T: Into<String>>(message: T) -> Self {
        Self::NotFound(message.into())
    }

    /// 404 `unsupported_entry` (see [`UNSUPPORTED_ENTRY_CODE`]).
    pub fn unsupported_entry<T: Into<String>>(message: T) -> Self {
        Self::with_report(
            StatusCode::NOT_FOUND,
            UNSUPPORTED_ENTRY_CODE,
            message,
            serde_json::json!({}),
        )
    }

    pub fn conflict<T: Into<String>>(message: T) -> Self {
        Self::Conflict(message.into())
    }

    pub fn unavailable<T: Into<String>>(message: T) -> Self {
        Self::Unavailable(message.into())
    }

    pub fn internal<T: Into<String>>(message: T) -> Self {
        Self::Internal(message.into())
    }

    pub fn conflict_paths<T: Into<String>>(
        code: &'static str,
        message: T,
        paths: Vec<String>,
    ) -> Self {
        Self::ConflictPaths {
            code,
            message: message.into(),
            paths,
        }
    }

    pub fn with_report<T: Into<String>>(
        status: StatusCode,
        code: &'static str,
        message: T,
        report: serde_json::Value,
    ) -> Self {
        Self::WithReport {
            status,
            code,
            message: message.into(),
            report,
        }
    }

    fn status_code(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::ConflictPaths { .. } => StatusCode::CONFLICT,
            Self::WithReport { status, .. } => *status,
        }
    }
}

impl IntoResponse for OriginError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        match self {
            Self::ConflictPaths {
                code,
                message,
                paths,
            } => (
                status,
                Json(serde_json::json!({
                    "error": message,
                    "code": code,
                    "paths": paths,
                })),
            )
                .into_response(),
            Self::WithReport {
                code,
                message,
                report,
                ..
            } => {
                let mut body = match report {
                    serde_json::Value::Object(map) => map,
                    _ => serde_json::Map::new(),
                };
                body.insert("error".to_string(), serde_json::Value::String(message));
                body.insert(
                    "code".to_string(),
                    serde_json::Value::String(code.to_string()),
                );
                (status, Json(serde_json::Value::Object(body))).into_response()
            }
            other => {
                let code = matches!(other, Self::NotFound(_)).then_some(NOT_FOUND_CODE);
                let body = Json(ErrorBody {
                    error: other.to_string(),
                    code,
                });
                (status, body).into_response()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn body(error: OriginError) -> (StatusCode, serde_json::Value) {
        let response = error.into_response();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    #[tokio::test]
    async fn not_found_answers_carry_a_code_that_tells_absent_from_unsupported() {
        assert_eq!(
            body(OriginError::not_found("file not found")).await,
            (
                StatusCode::NOT_FOUND,
                serde_json::json!({ "error": "file not found", "code": "not_found" })
            )
        );
        assert_eq!(
            body(OriginError::unsupported_entry("a symlink is at this path")).await,
            (
                StatusCode::NOT_FOUND,
                serde_json::json!({
                    "error": "a symlink is at this path",
                    "code": "unsupported_entry"
                })
            )
        );
        // Other plain errors keep their body.
        assert_eq!(
            body(OriginError::bad_request("invalid path")).await,
            (
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "error": "invalid path" })
            )
        );
    }
}
