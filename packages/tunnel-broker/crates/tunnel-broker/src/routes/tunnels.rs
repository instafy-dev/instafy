use axum::{
    extract::{Path, State},
    Json,
};
use chrono::{DateTime, Duration, Utc};
use tunnel_broker_types::{CreateTunnelRequest, LabelMap, TunnelResponse, TunnelStatus};
use uuid::Uuid;

use crate::{
    config::{BrokerConfig, HookConfig},
    db::{self, TunnelInsert, TunnelRecord},
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

/// What an idempotent create does with the tunnel its key already names.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reuse {
    /// Live and on the current domain: hand it back unchanged.
    Return,
    /// Expired or revoked but on the current domain: re-issue it in place.
    Refresh,
    /// Minted under a domain the broker no longer serves: retire it and mint a new tunnel, so
    /// an old domain stops being handed out and can be retired.
    Replace,
}

fn reuse_existing_tunnel(cfg: &BrokerConfig, existing: &TunnelRecord, now: DateTime<Utc>) -> Reuse {
    // A hostname this configuration would mint for the row is current by definition, so a
    // `TUNNEL_DOMAIN` the hostname check cannot parse never makes every reuse a replacement.
    let minted_here = existing.hostname == cfg.hostname_for(&existing.id);
    if !minted_here && !cfg.hostname_in_tunnel_domain(&existing.hostname) {
        Reuse::Replace
    } else if should_return_existing_tunnel(&existing.status, existing.expires_at, now) {
        Reuse::Return
    } else {
        Reuse::Refresh
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
    let mut replace_stale = None;
    if let Some(key) = idempotency_key {
        if let Some(existing) =
            db::get_tunnel_by_idempotency_key(state.pool(), body.project_id, key).await?
        {
            ensure_same_visibility(&existing, body.labels.as_ref())?;
            match reuse_existing_tunnel(state.config(), &existing, now) {
                Reuse::Replace => {
                    tracing::info!(
                        tunnel_id = %existing.id,
                        project_id = %existing.project_id,
                        "idempotent tunnel hostname is outside the configured tunnel domain; \
                         replacing it with a new tunnel"
                    );
                    replace_stale = Some(existing);
                }
                Reuse::Return => {
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
                Reuse::Refresh => refresh_existing = Some(existing),
            }
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
    let url = advertised_url(state.config(), body.labels.as_ref(), &hostname);
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
        metadata: labels_to_metadata(body.labels.clone()),
        ttl_seconds: state.config().default_ttl_seconds,
    };

    let mut retired = None;
    let record = match (refresh_existing.as_ref(), replace_stale.as_ref()) {
        (Some(existing), _) => {
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
        (None, Some(stale)) => {
            let (record, replaced) =
                db::replace_tunnel(state.pool(), state.config(), &ingress, stale, insert).await?;
            retired = replaced;
            // A concurrent replacement with the same key may have won the insert.
            ensure_same_visibility(&record, body.labels.as_ref())?;
            record
        }
        (None, None) => {
            let record = db::create_tunnel(state.pool(), state.config(), &ingress, insert).await?;
            // A concurrent create with the same key may have won the insert.
            ensure_same_visibility(&record, body.labels.as_ref())?;
            record
        }
    };
    let descriptor = record.into_descriptor(state.config(), &ingress);

    if let Some(event) = state.config().event_hook.as_ref() {
        if let Some(retired) = retired {
            emit_revoked_event(&state, event, retired).await;
        }
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

/// `tunnel.revoked` for a tunnel retired by a replacement, shaped like the revoke route's.
async fn emit_revoked_event(state: &AppState, event: &HookConfig, retired: TunnelRecord) {
    let ingress = match db::get_ingress(state.pool(), retired.ingress_id).await {
        Ok(Some(ingress)) => ingress,
        Ok(None) | Err(_) => {
            tracing::warn!(
                tunnel_id = %retired.id,
                "ingress of a replaced tunnel not found; skipping its revoked event"
            );
            return;
        }
    };
    let (project_id, org_id, runtime_id, lease_id) = (
        retired.project_id,
        retired.org_id,
        retired.runtime_id,
        retired.lease_id,
    );
    let descriptor = retired.into_descriptor(state.config(), &ingress);
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

/// Whether the request asks for a private tunnel. Unset visibility means public.
fn requests_private(labels: Option<&LabelMap>) -> bool {
    labels
        .and_then(|labels| labels.get("visibility"))
        .is_some_and(|visibility| db::visibility_is_private(visibility))
}

/// Whether a stored tunnel is private, read the way the binding query reads it:
/// `metadata.labels.visibility`, public when unset, and private for anything but `public`.
fn stored_private(metadata: Option<&serde_json::Value>) -> bool {
    match metadata
        .and_then(|metadata| metadata.get("labels"))
        .and_then(|labels| labels.get("visibility"))
    {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::String(visibility)) => db::visibility_is_private(visibility),
        Some(_) => true,
    }
}

/// An idempotency key stays bound to the visibility it was first used with. Returning a public
/// tunnel to a caller that asked for a private one would leave it open to anyone with the URL,
/// so a mismatch is refused instead of resolved.
fn ensure_same_visibility(existing: &TunnelRecord, labels: Option<&LabelMap>) -> AppResult<()> {
    if stored_private(existing.metadata.as_ref()) != requests_private(labels) {
        return Err(AppError::conflict(
            "idempotency key already names a tunnel with a different visibility",
        ));
    }
    Ok(())
}

/// A private tunnel has no router on its tunnel hostname, so it gets no URL; callers build the
/// capability host from their own label and the `previewDomain` in `/capabilities`.
fn advertised_url(cfg: &BrokerConfig, labels: Option<&LabelMap>, hostname: &str) -> Option<String> {
    (!requests_private(labels)).then(|| cfg.tunnel_url(hostname))
}

/// A private tunnel only has a capability router, so without preview routing and its auth
/// hook it could never be opened; refuse it up front instead.
fn ensure_visibility_supported(cfg: &BrokerConfig, labels: Option<&LabelMap>) -> AppResult<()> {
    if requests_private(labels) && !cfg.private_previews_enabled() {
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
            |cfg: &mut BrokerConfig| cfg.preview_auth_hook.as_mut().unwrap().token = None,
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

    fn stored(metadata: Option<serde_json::Value>) -> TunnelRecord {
        TunnelRecord {
            metadata,
            ..db::test_tunnel_record()
        }
    }

    #[test]
    fn idempotent_reuse_never_returns_a_public_tunnel_for_a_private_request() {
        let private = labels(&[("kind", "preview"), ("visibility", "private")]);
        for public_row in [
            stored(None),
            stored(Some(serde_json::json!({}))),
            stored(Some(serde_json::json!({"labels": {"source": "cli"}}))),
            stored(Some(
                serde_json::json!({"labels": {"visibility": "Public"}}),
            )),
        ] {
            let error = ensure_same_visibility(&public_row, Some(&private)).unwrap_err();
            assert_eq!(error.status, StatusCode::CONFLICT);
        }
    }

    #[test]
    fn idempotent_reuse_keeps_matching_visibility() {
        let private_row = stored(Some(
            serde_json::json!({"labels": {"kind": "preview", "visibility": "private"}}),
        ));
        let private = labels(&[("visibility", "private")]);
        let public = labels(&[("visibility", "public")]);
        assert!(ensure_same_visibility(&private_row, Some(&private)).is_ok());
        assert!(ensure_same_visibility(&stored(None), None).is_ok());
        assert!(ensure_same_visibility(&stored(None), Some(&public)).is_ok());
        // The opposite mismatch is refused too, so a key means one thing.
        assert_eq!(
            ensure_same_visibility(&private_row, None)
                .unwrap_err()
                .status,
            StatusCode::CONFLICT
        );
        // Stored values the binding query treats as private count as private here as well.
        for odd in [
            serde_json::json!({"labels": {"visibility": "members"}}),
            serde_json::json!({"labels": {"visibility": 1}}),
        ] {
            assert!(ensure_same_visibility(&stored(Some(odd.clone())), Some(&private)).is_ok());
            assert!(ensure_same_visibility(&stored(Some(odd)), None).is_err());
        }
    }

    #[test]
    fn private_tunnels_advertise_no_url() {
        let cfg = test_broker_config();
        let private = labels(&[("kind", "preview"), ("visibility", "private")]);
        assert_eq!(advertised_url(&cfg, Some(&private), "abc.rt.test"), None);
        assert_eq!(
            advertised_url(&cfg, None, "abc.rt.test"),
            Some(cfg.tunnel_url("abc.rt.test"))
        );
        assert_eq!(
            advertised_url(
                &cfg,
                Some(&labels(&[("visibility", "public")])),
                "abc.rt.test"
            ),
            Some(cfg.tunnel_url("abc.rt.test"))
        );
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

    fn row_on(cfg: &BrokerConfig, status: &str, expires_in: Option<i64>) -> TunnelRecord {
        let base = db::test_tunnel_record();
        TunnelRecord {
            hostname: cfg.hostname_for(&base.id),
            status: status.into(),
            expires_at: expires_in.map(|seconds| Utc::now() + Duration::seconds(seconds)),
            ..base
        }
    }

    #[test]
    fn reuse_is_unchanged_while_the_domain_is_unchanged() {
        let cfg = test_broker_config();
        let now = Utc::now();
        assert_eq!(
            reuse_existing_tunnel(&cfg, &row_on(&cfg, "active", Some(60)), now),
            Reuse::Return
        );
        assert_eq!(
            reuse_existing_tunnel(&cfg, &row_on(&cfg, "active", None), now),
            Reuse::Return
        );
        assert_eq!(
            reuse_existing_tunnel(&cfg, &row_on(&cfg, "active", Some(-1)), now),
            Reuse::Refresh
        );
        assert_eq!(
            reuse_existing_tunnel(&cfg, &row_on(&cfg, "revoked", Some(60)), now),
            Reuse::Refresh
        );
    }

    #[test]
    fn a_tunnel_minted_under_the_current_config_is_never_replaced() {
        let mut cfg = test_broker_config();
        cfg.tunnel_domain = " rt.test".into();
        let row = row_on(&cfg, "active", Some(60));
        assert!(!cfg.hostname_in_tunnel_domain(&row.hostname));
        assert_eq!(reuse_existing_tunnel(&cfg, &row, Utc::now()), Reuse::Return);
    }

    #[test]
    fn tunnels_minted_under_another_domain_are_replaced_in_any_status() {
        let before = test_broker_config();
        let mut after = test_broker_config();
        after.tunnel_domain = "usercontent.test".into();
        let now = Utc::now();
        for (status, expires_in) in [
            ("active", Some(60)),
            ("active", None),
            ("requested", Some(60)),
            ("active", Some(-1)),
            ("revoked", Some(60)),
        ] {
            let row = row_on(&before, status, expires_in);
            assert_eq!(
                reuse_existing_tunnel(&after, &row, now),
                Reuse::Replace,
                "{status} {expires_in:?}"
            );
        }
    }

    /// Runs the create handler against a real, disposable Postgres. CI is database-free, so
    /// these are ignored there; run them with
    /// `TUNNEL_BROKER_TEST_DATABASE_URL=postgres://… cargo test -- --ignored`.
    mod with_postgres {
        use super::*;
        use crate::routes::preview_auth::parse_preview_host;
        use tokio::sync::OnceCell;
        use tunnel_broker_types::TunnelDescriptor;

        const DATABASE_ENV: &str = "TUNNEL_BROKER_TEST_DATABASE_URL";
        static MIGRATED: OnceCell<()> = OnceCell::const_new();
        /// The tests share one ingress, and some expire rows by hand outside the allocation
        /// lock, which another test's allocation must not observe halfway; run them one at a
        /// time (each test's own requests still race each other where it means to).
        static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

        async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
            SERIAL.lock().await
        }

        async fn broker(tunnel_domain: &str, preview_domain: &str) -> AppState {
            let url = std::env::var(DATABASE_ENV)
                .unwrap_or_else(|_| panic!("{DATABASE_ENV} must name a disposable database"));
            MIGRATED
                .get_or_init(|| async {
                    let pool = db::connect_pool(&url, 1).await.expect("connect");
                    db::run_migrations(&pool).await.expect("migrate");
                    pool.close().await;
                })
                .await;
            let mut cfg = test_broker_config();
            cfg.database_url = url;
            cfg.tunnel_domain = tunnel_domain.into();
            cfg.preview.as_mut().unwrap().domain = preview_domain.into();
            cfg.ingress_ipv4 = Some("127.0.0.1".parse().unwrap());
            let pool = db::connect_pool(&cfg.database_url, 16)
                .await
                .expect("connect");
            db::ensure_pdns_domain(&pool, &cfg).await.expect("zone");
            db::ensure_ingress(&pool, &cfg).await.expect("ingress");
            AppState::new(pool, cfg)
        }

        fn request(project_id: Uuid, key: &str, labels: Option<LabelMap>) -> CreateTunnelRequest {
            CreateTunnelRequest {
                project_id,
                org_id: None,
                runtime_id: Some(Uuid::new_v4()),
                lease_id: Some(Uuid::new_v4()),
                idempotency_key: Some(key.into()),
                expires_in_seconds: Some(600),
                labels,
            }
        }

        async fn open(state: &AppState, body: &CreateTunnelRequest) -> TunnelDescriptor {
            let Json(response) = create(State(state.clone()), Json(body.clone()))
                .await
                .expect("create");
            response.tunnel
        }

        async fn row(state: &AppState, id: Uuid) -> TunnelRecord {
            db::get_tunnel(state.pool(), id)
                .await
                .unwrap()
                .expect("row")
        }

        async fn address_records(state: &AppState, hostname: &str) -> i64 {
            sqlx::query_scalar(
                "select count(*) from records where name = $1 and type in ('A','AAAA')",
            )
            .bind(hostname)
            .fetch_one(state.pool())
            .await
            .unwrap()
        }

        async fn assert_retired(state: &AppState, id: Uuid) {
            let retired = row(state, id).await;
            assert_eq!(retired.status, "revoked");
            assert_eq!(retired.token, "");
            assert_eq!(retired.token_expires_at, None);
            assert_eq!(retired.idempotency_key, None, "key released");
            assert_eq!(address_records(state, &retired.hostname).await, 0);
        }

        async fn key_owner(state: &AppState, project_id: Uuid, key: &str) -> Uuid {
            db::get_tunnel_by_idempotency_key(state.pool(), project_id, key)
                .await
                .unwrap()
                .expect("key row")
                .id
        }

        #[tokio::test]
        #[ignore = "needs TUNNEL_BROKER_TEST_DATABASE_URL"]
        async fn an_unchanged_domain_keeps_the_hostname_through_reuse_and_refresh() {
            let _serial = serial().await;
            let state = broker("same-a.test", "same-a-preview.test").await;
            let body = request(Uuid::new_v4(), "tunnel:same", None);
            let first = open(&state, &body).await;
            assert_eq!(
                first.hostname,
                state.config().hostname_for(&first.tunnel_id)
            );

            let reused = open(&state, &body).await;
            assert_eq!(reused.tunnel_id, first.tunnel_id);
            assert_eq!(reused.hostname, first.hostname);

            sqlx::query(
                "update tunnels set expires_at = now() - interval '1 second' where id = $1",
            )
            .bind(first.tunnel_id)
            .execute(state.pool())
            .await
            .unwrap();
            let refreshed = open(&state, &body).await;
            assert_eq!(refreshed.tunnel_id, first.tunnel_id);
            assert_eq!(refreshed.hostname, first.hostname);

            db::revoke_tunnel(state.pool(), state.config(), first.tunnel_id)
                .await
                .unwrap();
            let reissued = open(&state, &body).await;
            assert_eq!(reissued.tunnel_id, first.tunnel_id);
            assert_eq!(reissued.hostname, first.hostname);
            assert_eq!(address_records(&state, &first.hostname).await, 1);
        }

        #[tokio::test]
        #[ignore = "needs TUNNEL_BROKER_TEST_DATABASE_URL"]
        async fn a_domain_change_replaces_a_live_tunnel() {
            let _serial = serial().await;
            let before = broker("live-old.test", "live-old-preview.test").await;
            let after = broker("live-new.test", "live-new-preview.test").await;
            let body = request(Uuid::new_v4(), "tunnel:live", None);
            let old = open(&before, &body).await;
            assert_eq!(address_records(&before, &old.hostname).await, 1);

            let new = open(&after, &body).await;
            assert_ne!(new.tunnel_id, old.tunnel_id);
            assert_eq!(new.hostname, after.config().hostname_for(&new.tunnel_id));
            assert!(after.config().hostname_in_tunnel_domain(&new.hostname));
            assert_eq!(new.url, Some(after.config().tunnel_url(&new.hostname)));
            assert_eq!(new.client.hostname, new.hostname);
            assert_ne!(new.client.service, old.client.service);
            assert_eq!(address_records(&after, &new.hostname).await, 1);
            assert_retired(&after, old.tunnel_id).await;
            assert_eq!(
                key_owner(&after, body.project_id, "tunnel:live").await,
                new.tunnel_id
            );

            // The replacement is now the key's tunnel, reused like any other.
            let again = open(&after, &body).await;
            assert_eq!(again.tunnel_id, new.tunnel_id);
            assert_eq!(again.hostname, new.hostname);
        }

        #[tokio::test]
        #[ignore = "needs TUNNEL_BROKER_TEST_DATABASE_URL"]
        async fn a_domain_change_replaces_instead_of_refreshing() {
            let _serial = serial().await;
            let before = broker("refresh-old.test", "refresh-old-preview.test").await;
            let after = broker("refresh-new.test", "refresh-new-preview.test").await;
            for expire in [true, false] {
                let body = request(Uuid::new_v4(), "tunnel:refresh", None);
                let old = open(&before, &body).await;
                if expire {
                    sqlx::query(
                        "update tunnels set expires_at = now() - interval '1 second' where id = $1",
                    )
                    .bind(old.tunnel_id)
                    .execute(before.pool())
                    .await
                    .unwrap();
                } else {
                    db::revoke_tunnel(before.pool(), before.config(), old.tunnel_id)
                        .await
                        .unwrap();
                }

                let new = open(&after, &body).await;
                assert_ne!(new.tunnel_id, old.tunnel_id, "expire={expire}");
                assert_eq!(new.hostname, after.config().hostname_for(&new.tunnel_id));
                assert_retired(&after, old.tunnel_id).await;
                assert_eq!(
                    key_owner(&after, body.project_id, "tunnel:refresh").await,
                    new.tunnel_id
                );
            }
        }

        #[tokio::test]
        #[ignore = "needs TUNNEL_BROKER_TEST_DATABASE_URL"]
        async fn a_replaced_private_preview_gets_a_fresh_capability_namespace() {
            let _serial = serial().await;
            let before = broker("preview-old.test", "preview-old-content.test").await;
            // One user-content domain for both name shapes after the change.
            let after = broker("preview-new.test", "preview-new.test").await;
            let preview = labels(&[("kind", "preview"), ("visibility", "private")]);
            let body = request(Uuid::new_v4(), "preview:rt:5173", Some(preview));
            let old = open(&before, &body).await;
            assert_eq!(old.url, None);

            let new = open(&after, &body).await;
            assert_ne!(new.tunnel_id, old.tunnel_id);
            assert_eq!(new.url, None);
            assert_eq!(new.hostname, after.config().hostname_for(&new.tunnel_id));
            assert_eq!(
                new.metadata,
                Some(serde_json::json!({"labels": {"kind": "preview", "visibility": "private"}}))
            );
            assert_retired(&after, old.tunnel_id).await;

            // Capability hosts name the tunnel, so every capability minted for the old tunnel
            // names the retired row and none of them reaches the replacement.
            let domain = &after.config().preview.as_ref().unwrap().domain;
            let label = "abcdefghijklmnopqrstuvwxyz";
            let fresh = format!("p-{label}--{}.{domain}", new.tunnel_id.simple());
            let stale = format!("p-{label}--{}.{domain}", old.tunnel_id.simple());
            assert_eq!(
                parse_preview_host(&fresh, domain).unwrap().tunnel_id,
                new.tunnel_id
            );
            assert_eq!(
                parse_preview_host(&stale, domain).unwrap().tunnel_id,
                old.tunnel_id
            );
            assert!(after.config().hostname_in_tunnel_domain(&new.hostname));
            assert!(!after.config().hostname_in_tunnel_domain(&fresh));
        }

        #[tokio::test]
        #[ignore = "needs TUNNEL_BROKER_TEST_DATABASE_URL"]
        async fn concurrent_creates_after_a_domain_change_agree_on_one_replacement() {
            let _serial = serial().await;
            let before = broker("race-old.test", "race-old-preview.test").await;
            let after = broker("race-new.test", "race-new-preview.test").await;
            let body = request(Uuid::new_v4(), "tunnel:race", None);
            let old = open(&before, &body).await;

            let racers: Vec<_> = (0..8)
                .map(|_| {
                    let state = after.clone();
                    let body = body.clone();
                    tokio::spawn(async move { open(&state, &body).await })
                })
                .collect();
            let mut ids = Vec::new();
            for racer in racers {
                ids.push(racer.await.unwrap().tunnel_id);
            }
            let winner = ids[0];
            assert!(ids.iter().all(|id| *id == winner), "{ids:?}");
            assert_ne!(winner, old.tunnel_id);
            assert_retired(&after, old.tunnel_id).await;
            assert_eq!(
                key_owner(&after, body.project_id, "tunnel:race").await,
                winner
            );
            let rows: i64 =
                sqlx::query_scalar("select count(*) from tunnels where project_id = $1")
                    .bind(body.project_id)
                    .fetch_one(after.pool())
                    .await
                    .unwrap();
            assert_eq!(rows, 2, "the retired row and one replacement");
        }

        /// The ingress sidecar revokes expired tunnels on its ingress in one statement, so it
        /// locks them in scan order. A replacement must take those rows in the same order (the
        /// allocation sweep first, the stale row after), or it deadlocks with a sweep that has
        /// locked an earlier expired row and is waiting on the stale one.
        #[tokio::test]
        #[ignore = "needs TUNNEL_BROKER_TEST_DATABASE_URL"]
        async fn replacing_an_expired_tunnel_waits_for_a_concurrent_expiry_sweep() {
            let _serial = serial().await;
            let before = broker("sweep-old.test", "sweep-old-preview.test").await;
            let after = broker("sweep-new.test", "sweep-new-preview.test").await;
            let project_id = Uuid::new_v4();
            let other = open(&before, &request(project_id, "tunnel:other", None)).await;
            let body = request(project_id, "tunnel:sweep", None);
            let stale = open(&before, &body).await;
            for (id, seconds) in [(other.tunnel_id, 2), (stale.tunnel_id, 1)] {
                sqlx::query(
                    "update tunnels set expires_at = now() - make_interval(secs => $2) \
                     where id = $1",
                )
                .bind(id)
                .bind(seconds as f64)
                .execute(after.pool())
                .await
                .unwrap();
            }
            // Store rows in expiry order, so every plan for the sweep reaches `other` first.
            sqlx::query("cluster tunnels using tunnels_expires_at_idx")
                .execute(after.pool())
                .await
                .unwrap();

            // A sweep that has revoked the earlier expired row and not yet the stale one.
            let revoke = "update tunnels set status = 'revoked', token = '', \
                          token_expires_at = null, updated_at = now() where id = $1";
            let mut sweep = after.pool().begin().await.unwrap();
            sqlx::query(revoke)
                .bind(other.tunnel_id)
                .execute(&mut *sweep)
                .await
                .unwrap();
            let replacing = {
                let state = after.clone();
                let body = body.clone();
                tokio::spawn(async move {
                    create(State(state), Json(body))
                        .await
                        .map(|Json(response)| response.tunnel.tunnel_id)
                        .map_err(|error| format!("{error:?}"))
                })
            };
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            sqlx::query(revoke)
                .bind(stale.tunnel_id)
                .execute(&mut *sweep)
                .await
                .expect("the sweep reaches the stale row");
            sweep.commit().await.unwrap();

            let replaced = replacing.await.unwrap().expect("the replacement succeeds");
            assert_ne!(replaced, stale.tunnel_id);
            assert_retired(&after, stale.tunnel_id).await;
            assert_eq!(
                key_owner(&after, project_id, "tunnel:sweep").await,
                replaced
            );
        }
    }
}
