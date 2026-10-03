use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub error: String,
}

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
                let body = Json(ErrorBody {
                    error: other.to_string(),
                });
                (status, body).into_response()
            }
        }
    }
}
