use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

pub type AppResult<T> = Result<T, AppError>;

#[derive(Debug)]
pub struct AppError {
    pub status: StatusCode,
    pub message: String,
}

impl AppError {
    pub fn bad_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::INTERNAL_SERVER_ERROR,
            message: message.into(),
        }
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let status = self.status;
        let body = Json(ErrorBody {
            error: self.message.clone(),
        });
        (status, body).into_response()
    }
}

impl From<anyhow::Error> for AppError {
    fn from(err: anyhow::Error) -> Self {
        tracing::error!(error = ?err, "internal error");
        AppError::internal(err.to_string())
    }
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        tracing::error!(error = ?err, "database error");
        AppError::internal(err.to_string())
    }
}
