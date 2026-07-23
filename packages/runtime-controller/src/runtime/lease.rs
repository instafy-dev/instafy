use axum::http::StatusCode;
use axum::Json;

use crate::{bad_request, internal_error, ApiError};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RuntimeLeaseScope {
    Exclusive,
    Shared,
    Tenant,
}

impl RuntimeLeaseScope {
    pub(super) fn as_str(&self) -> &'static str {
        match self {
            RuntimeLeaseScope::Exclusive => "exclusive",
            RuntimeLeaseScope::Shared => "shared",
            RuntimeLeaseScope::Tenant => "tenant",
        }
    }

    pub(super) fn from_db(value: &str) -> Result<Self, (StatusCode, Json<ApiError>)> {
        match value {
            "exclusive" => Ok(RuntimeLeaseScope::Exclusive),
            "shared" => Ok(RuntimeLeaseScope::Shared),
            "tenant" => Ok(RuntimeLeaseScope::Tenant),
            other => Err(internal_error(format!(
                "unknown runtime lease scope: {other}"
            ))),
        }
    }
}

pub(super) fn parse_lease_scope(
    raw: Option<&str>,
) -> Result<RuntimeLeaseScope, (StatusCode, Json<ApiError>)> {
    let Some(value) = raw.map(|scope| scope.trim()) else {
        return Ok(RuntimeLeaseScope::Exclusive);
    };
    if value.is_empty() {
        return Ok(RuntimeLeaseScope::Exclusive);
    }
    match value.to_ascii_lowercase().as_str() {
        "exclusive" => Ok(RuntimeLeaseScope::Exclusive),
        "shared" => Ok(RuntimeLeaseScope::Shared),
        "tenant" => Ok(RuntimeLeaseScope::Tenant),
        other => Err(bad_request(format!(
            "unknown runtime lease scope '{other}'"
        ))),
    }
}
