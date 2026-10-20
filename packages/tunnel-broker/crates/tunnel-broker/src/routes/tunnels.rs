use axum::{
    extract::{Path, State},
    Json,
};
use chrono::{DateTime, Duration, Utc};
use tunnel_broker_types::{CreateTunnelRequest, LabelMap, TunnelResponse, TunnelStatus};
use uuid::Uuid;

use crate::{
    config::BrokerConfig,
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
    ensure_visibility_supported(state.config(), body.labels.as_ref())?;
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
            &create_acl_request(&body, idempotency_key),
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
    let expires_at = resolve_expires_at(
        state.config(),
        body.labels.as_ref(),
        requested_expires_at,
        token_expires_at,
        now,
    );

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

fn labels_to_metadata(labels: Option<LabelMap>) -> Option<serde_json::Value> {
    labels.map(|map| serde_json::json!({ "labels": map }))
}

/// The ACL hook sees the same `{labels}` metadata the tunnel row stores, so the controller can
/// tell a private preview from a public tunnel before it burns credits.
fn create_acl_request(body: &CreateTunnelRequest, idempotency_key: Option<&str>) -> AclRequest {
    AclRequest {
        intent: "create_tunnel".to_string(),
        project_id: body.project_id,
        org_id: body.org_id,
        runtime_id: body.runtime_id,
        lease_id: body.lease_id,
        idempotency_key: idempotency_key.map(|value| value.to_string()),
        metadata: labels_to_metadata(body.labels.clone()),
    }
}

/// A private tunnel only has a capability router, so without preview routing and its auth
/// hook it could never be opened; refuse it up front instead.
fn ensure_visibility_supported(cfg: &BrokerConfig, labels: Option<&LabelMap>) -> AppResult<()> {
    let private = labels
        .and_then(|labels| labels.get("visibility"))
        .is_some_and(|visibility| db::visibility_is_private(visibility));
    if private && !cfg.private_previews_enabled() {
        return Err(AppError::bad_request(
            "private tunnels require PREVIEW_DOMAIN, PREVIEW_AUTH_ADDRESS and PREVIEW_AUTH_HOOK_URL",
        ));
    }
    Ok(())
}

/// Preview tunnels live as long as the caller asks, up to `PREVIEW_MAX_TTL_SECONDS`; everything
/// else stays capped at the token TTL.
fn resolve_expires_at(
    cfg: &BrokerConfig,
    labels: Option<&LabelMap>,
    requested: Option<DateTime<Utc>>,
    token_expires_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> DateTime<Utc> {
    let preview = labels
        .and_then(|labels| labels.get("kind"))
        .is_some_and(|kind| kind == "preview");
    match requested {
        Some(requested) if preview => std::cmp::min(
            requested,
            now + Duration::seconds(cfg.preview_max_ttl_seconds),
        ),
        _ => tokens::resolve_tunnel_expiry(requested, token_expires_at),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::test_broker_config;
    use axum::http::StatusCode;

    fn labels(pairs: &[(&str, &str)]) -> LabelMap {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    fn create_body(labels: Option<LabelMap>) -> CreateTunnelRequest {
        CreateTunnelRequest {
            project_id: Uuid::new_v4(),
            org_id: None,
            runtime_id: Some(Uuid::new_v4()),
            lease_id: Some(Uuid::new_v4()),
            idempotency_key: Some("preview:rt:lease:4173".into()),
            expires_in_seconds: Some(43_200),
            labels,
        }
    }

    #[test]
    fn preview_tunnels_get_up_to_twelve_hours() {
        let cfg = test_broker_config();
        let now = Utc::now();
        let token_expiry = now + Duration::seconds(cfg.token_ttl_seconds);
        let preview = labels(&[("kind", "preview"), ("visibility", "private")]);

        let twelve_hours = now + Duration::seconds(43_200);
        assert_eq!(
            resolve_expires_at(&cfg, Some(&preview), Some(twelve_hours), token_expiry, now),
            twelve_hours
        );
        let a_day = now + Duration::seconds(86_400);
        assert_eq!(
            resolve_expires_at(&cfg, Some(&preview), Some(a_day), token_expiry, now),
            twelve_hours
        );
        let ten_minutes = now + Duration::seconds(600);
        assert_eq!(
            resolve_expires_at(&cfg, Some(&preview), Some(ten_minutes), token_expiry, now),
            ten_minutes
        );
        assert_eq!(
            resolve_expires_at(&cfg, Some(&preview), None, token_expiry, now),
            token_expiry
        );
    }

    #[test]
    fn other_tunnels_stay_capped_at_the_token_ttl() {
        let cfg = test_broker_config();
        let now = Utc::now();
        let token_expiry = now + Duration::seconds(cfg.token_ttl_seconds);
        let twelve_hours = now + Duration::seconds(43_200);
        for tunnel_labels in [
            None,
            Some(labels(&[("source", "cli")])),
            Some(labels(&[("kind", "tunnel"), ("visibility", "public")])),
            Some(labels(&[("kind", "Preview")])),
        ] {
            assert_eq!(
                resolve_expires_at(
                    &cfg,
                    tunnel_labels.as_ref(),
                    Some(twelve_hours),
                    token_expiry,
                    now
                ),
                token_expiry
            );
        }
    }

    #[tokio::test]
    async fn private_tunnels_without_preview_config_are_rejected() {
        for strip in [
            |cfg: &mut BrokerConfig| cfg.preview = None,
            |cfg: &mut BrokerConfig| cfg.preview_auth_hook = None,
        ] {
            let mut cfg = test_broker_config();
            strip(&mut cfg);
            let state = AppState::for_tests(cfg);
            // Rejected before the handler touches Postgres (the test pool never connects).
            let body = create_body(Some(labels(&[
                ("kind", "preview"),
                ("visibility", "private"),
            ])));
            let error = create(State(state), Json(body)).await.unwrap_err();
            assert_eq!(error.status, StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn visibility_check_allows_public_and_configured_private() {
        let configured = test_broker_config();
        let mut bare = test_broker_config();
        bare.preview = None;
        let private = labels(&[("visibility", "private")]);
        let public = labels(&[("visibility", "public")]);
        let other = labels(&[("visibility", "members")]);

        assert!(ensure_visibility_supported(&configured, Some(&private)).is_ok());
        assert!(ensure_visibility_supported(&bare, None).is_ok());
        assert!(ensure_visibility_supported(&bare, Some(&public)).is_ok());
        assert!(ensure_visibility_supported(&bare, Some(&labels(&[("kind", "preview")]))).is_ok());
        assert!(ensure_visibility_supported(&bare, Some(&private)).is_err());
        assert!(ensure_visibility_supported(&bare, Some(&other)).is_err());
    }

    #[test]
    fn labels_reach_acl_metadata() {
        let body = create_body(Some(labels(&[
            ("kind", "preview"),
            ("visibility", "private"),
        ])));
        let request = create_acl_request(&body, Some("preview:rt:lease:4173"));
        assert_eq!(
            serde_json::to_value(&request).unwrap()["metadata"],
            serde_json::json!({"labels": {"kind": "preview", "visibility": "private"}})
        );

        let unlabeled = create_acl_request(&create_body(None), None);
        assert!(serde_json::to_value(&unlabeled)
            .unwrap()
            .get("metadata")
            .is_none());
    }

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
