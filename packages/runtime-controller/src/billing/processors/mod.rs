use axum::http::StatusCode;
use axum::Json;
use serde::Serialize;
use uuid::Uuid;

use crate::{ApiError, AppConfig};

use super::plans::BillingPlan;

mod dev;
pub(crate) mod stripe;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProcessorKind {
    Dev,
    Stripe,
}

impl ProcessorKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            ProcessorKind::Dev => "dev",
            ProcessorKind::Stripe => "stripe",
        }
    }
}

pub(crate) fn parse_processor(value: &str) -> Option<ProcessorKind> {
    match value.to_ascii_lowercase().as_str() {
        "dev" | "test" => Some(ProcessorKind::Dev),
        "stripe" => Some(ProcessorKind::Stripe),
        _ => None,
    }
}

pub(crate) struct CheckoutInput<'a> {
    pub(crate) plan: &'a BillingPlan,
    pub(crate) org_id: &'a Uuid,
    pub(crate) project_id: &'a Uuid,
    pub(crate) success_url: &'a str,
    pub(crate) cancel_url: &'a str,
    /// Existing Stripe customer for this org, so repeat checkouts do not mint
    /// a new customer per session.
    pub(crate) customer_id: Option<&'a str>,
}

#[derive(Debug)]
pub(crate) struct CheckoutSession {
    pub(crate) processor: ProcessorKind,
    pub(crate) checkout_url: String,
    pub(crate) reference: Option<String>,
    pub(crate) expires_at: Option<String>,
}

#[derive(Debug)]
pub(crate) enum ProcessorError {
    NotImplemented(&'static str),
    MissingConfig(&'static str),
    Upstream { message: String },
}

impl ProcessorError {
    pub(crate) fn into_response(self) -> (StatusCode, Json<ApiError>) {
        match self {
            ProcessorError::NotImplemented(message) => {
                (StatusCode::NOT_IMPLEMENTED, Json(ApiError::new(message)))
            }
            ProcessorError::MissingConfig(message) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ApiError::new(message)),
            ),
            ProcessorError::Upstream { message } => {
                (StatusCode::BAD_GATEWAY, Json(ApiError::new(message)))
            }
        }
    }
}

pub(crate) struct ProcessorContext<'a> {
    pub(crate) config: &'a AppConfig,
    pub(crate) http_client: &'a reqwest::Client,
}

pub(crate) async fn create_checkout_session(
    context: ProcessorContext<'_>,
    kind: ProcessorKind,
    input: CheckoutInput<'_>,
) -> Result<CheckoutSession, ProcessorError> {
    match kind {
        ProcessorKind::Dev => dev::create_session(context, input).await,
        ProcessorKind::Stripe => stripe::create_session(context, input).await,
    }
}

pub(crate) async fn create_portal_session(
    context: ProcessorContext<'_>,
    kind: ProcessorKind,
    external_id: &str,
    return_url: &str,
) -> Result<String, ProcessorError> {
    match kind {
        ProcessorKind::Dev => Err(ProcessorError::NotImplemented(
            "Billing portal is only available for paid plans",
        )),
        ProcessorKind::Stripe => {
            stripe::create_portal_session(context, external_id, return_url).await
        }
    }
}
