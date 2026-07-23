use axum::{
    extract::{Path, State},
    Json,
};
use chrono::{Duration, Utc};
use tunnel_broker_types::{CreateTunnelRequest, TunnelResponse, TunnelStatus};
use uuid::Uuid;

use crate::{
    db::{self, TunnelInsert},
    error::{AppError, AppResult},
    hooks::{check_acl, emit_event, AclRequest, EventPayload},
    state::AppState,
    tokens,
};

fn should_return_existing_tunnel(
    status: &str,
    expires_at: Option<chrono::DateTime<Utc>>,
    now: chrono::DateTime<Utc>,
) -> bool {
    if status.trim().eq_ignore_ascii_case("revoked") {
        return false;
    }
    match expires_at {
        Some(value) => value > now,
        None => true,
    }
}

pub async fn create(
    State(state): State<AppState>,
    Json(body): Json<CreateTunnelRequest>,
) -> AppResult<Json<TunnelResponse>> {
    let now = Utc::now();
    let idempotency_key = body
        .idempotency_key
        .as_deref()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty());

    let mut refresh_existing = None;
    if let Some(key) = idempotency_key {
        if let Some(existing) =
            db::get_tunnel_by_idempotency_key(state.pool(), body.project_id, key).await?
        {
            if should_return_existing_tunnel(&existing.status, existing.expires_at, now) {
                let ingress = db::get_ingress(state.pool(), existing.ingress_id)
                    .await?
                    .ok_or_else(|| AppError::internal("ingress not found for tunnel"))?;
                db::ensure_tunnel_dns_records(
                    state.pool(),
                    state.config(),
                    &ingress,
                    &existing.hostname,
                    state.config().default_ttl_seconds,
                )
                .await
                .map_err(|error| {
                    AppError::internal(format!(
                        "failed to refresh dns records for existing tunnel: {error}"
                    ))
                })?;
                let descriptor = existing.into_descriptor(state.config(), &ingress);
                return Ok(Json(TunnelResponse {
                    tunnel: descriptor,
                    credit: None,
                }));
            }

            refresh_existing = Some(existing);
        }
    }

    let requested_expires_at = match body.expires_in_seconds {
        Some(seconds) if seconds <= 0 => {
            return Err(AppError::bad_request(
                "expires_in_seconds must be positive when provided",
            ))
        }
        Some(seconds) => Some(now + Duration::seconds(seconds)),
        None => None,
    };
    if let Some(acl) = state.config().acl_hook.as_ref() {
        let allowed = check_acl(
            state.http(),
            acl,
            &AclRequest {
                intent: "create_tunnel".to_string(),
                project_id: body.project_id,
                org_id: body.org_id,
                runtime_id: body.runtime_id,
                lease_id: body.lease_id,
                idempotency_key: idempotency_key.map(|value| value.to_string()),
                metadata: None,
            },
        )
        .await
        .map_err(|error| AppError::internal(format!("acl check failed: {error}")))?;
        if !allowed {
            return Err(AppError::not_found("tunnel creation not allowed"));
        }
    }

    let tunnel_id = refresh_existing
        .as_ref()
        .map(|existing| existing.id)
        .unwrap_or_else(Uuid::new_v4);
    let hostname = refresh_existing
        .as_ref()
        .map(|existing| existing.hostname.clone())
        .unwrap_or_else(|| state.config().hostname_for(&tunnel_id));
    let ingress = db::pick_ingress(state.pool())
        .await
        .map_err(|err| AppError::internal(err.to_string()))?;
    let (signed_token, token_expires_at) = tokens::sign_tunnel_token(
        state.config(),
        tunnel_id,
        body.project_id,
        body.runtime_id,
        body.lease_id,
        &hostname,
    )?;
    let token = state
        .config()
        .rathole_shared_token
        .clone()
        .unwrap_or(signed_token);
    let url = Some(state.config().tunnel_url(&hostname));
    let expires_at = tokens::resolve_tunnel_expiry(requested_expires_at, token_expires_at);

    let insert = TunnelInsert {
        id: tunnel_id,
        project_id: body.project_id,
        org_id: body.org_id,
        runtime_id: body.runtime_id,
        lease_id: body.lease_id,
        idempotency_key: body.idempotency_key.clone(),
        ingress_id: ingress.id,
        hostname,
        rathole_service: None,
        rathole_port: None,
        url,
        status: TunnelStatus::Requested,
        token,
        token_expires_at: Some(token_expires_at),
        expires_at: Some(expires_at),
        metadata: labels_to_metadata(body.labels),
        ttl_seconds: state.config().default_ttl_seconds,
    };

    let record = match refresh_existing.as_ref() {
        Some(existing) => {
            db::refresh_tunnel(
                state.pool(),
                state.config(),
                &ingress,
                existing,
                body.org_id,
                body.runtime_id,
                body.lease_id,
                insert.token,
                insert.token_expires_at,
                insert.url,
                insert.expires_at,
                insert.metadata,
            )
            .await?
        }
        None => db::create_tunnel(state.pool(), state.config(), &ingress, insert).await?,
    };
    let descriptor = record.into_descriptor(state.config(), &ingress);

    if let Some(event) = state.config().event_hook.as_ref() {
        emit_event(
            state.http(),
            event,
            &EventPayload {
                kind: "tunnel.created",
                project_id: body.project_id,
                org_id: body.org_id,
                runtime_id: body.runtime_id,
                lease_id: body.lease_id,
                data: serde_json::to_value(&descriptor).unwrap_or_default(),
            },
        )
        .await;
    }

    Ok(Json(TunnelResponse {
        tunnel: descriptor,
        credit: None,
    }))
}

pub async fn get(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<TunnelResponse>> {
    let Some(record) = db::get_tunnel(state.pool(), id).await? else {
        return Err(db::not_found(id));
    };
    let ingress = db::get_ingress(state.pool(), record.ingress_id)
        .await?
        .ok_or_else(|| AppError::internal("ingress not found for tunnel"))?;
    let tunnel = record.into_descriptor(state.config(), &ingress);
    Ok(Json(TunnelResponse {
        tunnel,
        credit: None,
    }))
}

pub async fn revoke(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
) -> AppResult<Json<TunnelResponse>> {
    let Some(record) = db::revoke_tunnel(state.pool(), state.config(), id).await? else {
        return Err(db::not_found(id));
    };
    let project_id = record.project_id;
    let org_id = record.org_id;
    let runtime_id = record.runtime_id;
    let lease_id = record.lease_id;
    let ingress = db::get_ingress(state.pool(), record.ingress_id)
        .await?
        .ok_or_else(|| AppError::internal("ingress not found for tunnel"))?;
    let descriptor = record.into_descriptor(state.config(), &ingress);

    if let Some(event) = state.config().event_hook.as_ref() {
        emit_event(
            state.http(),
            event,
            &EventPayload {
                kind: "tunnel.revoked",
                project_id,
                org_id,
                runtime_id,
                lease_id,
                data: serde_json::to_value(&descriptor).unwrap_or_default(),
            },
        )
        .await;
    }

    Ok(Json(TunnelResponse {
        tunnel: descriptor,
        credit: None,
    }))
}

fn labels_to_metadata(
    labels: Option<std::collections::HashMap<String, String>>,
) -> Option<serde_json::Value> {
    labels.map(|map| serde_json::json!({ "labels": map }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_existing_for_active_and_unexpired() {
        let now = Utc::now();
        assert!(should_return_existing_tunnel(
            "active",
            Some(now + Duration::seconds(10)),
            now
        ));
    }

    #[test]
    fn does_not_return_existing_for_revoked() {
        let now = Utc::now();
        assert!(!should_return_existing_tunnel(
            "revoked",
            Some(now + Duration::seconds(10)),
            now
        ));
    }

    #[test]
    fn does_not_return_existing_for_expired() {
        let now = Utc::now();
        assert!(!should_return_existing_tunnel(
            "active",
            Some(now - Duration::seconds(1)),
            now
        ));
    }

    #[test]
    fn returns_existing_when_no_expiry_is_set() {
        let now = Utc::now();
        assert!(should_return_existing_tunnel("active", None, now));
    }
}
