use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    Json,
};
use chrono::Utc;
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    config::BrokerConfig,
    db::{self, TunnelRecord},
    error::{AppError, AppResult},
    listening::{probe_http, recorded_listening, ProbeResponse},
    state::AppState,
};

const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PROBE_PATH_LEN: usize = 2048;

#[derive(Debug, Deserialize)]
pub struct ProbeQuery {
    #[serde(default)]
    path: Option<String>,
}

/// `GET /tunnels/:id/probe?path=/`: is the site behind this tunnel answering HTTP right now?
pub async fn probe(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    Query(query): Query<ProbeQuery>,
) -> AppResult<Json<ProbeResponse>> {
    let path = probe_path(query.path.as_deref())?;
    let Some(record) = db::get_tunnel(state.pool(), id).await? else {
        return Err(db::not_found(id));
    };
    let cfg = state.config();
    Ok(Json(match probe_source(cfg, &record) {
        ProbeSource::Down => ProbeResponse::DOWN,
        ProbeSource::Dial(port) => {
            probe_http(&cfg.rathole_upstream_host, port, &path, PROBE_TIMEOUT).await
        }
        ProbeSource::Recorded => recorded_listening(&record, cfg.listening_max_age(), Utc::now()),
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeSource {
    /// Revoked, or never bound to a rathole port.
    Down,
    /// On this broker's own ingress, whose rathole is `RATHOLE_UPSTREAM_HOST`: dial the port.
    Dial(u16),
    /// On another ingress. Ports are allocated per ingress, so this broker's rathole may give
    /// the same port to a different site; answer from what that ingress's sidecar recorded.
    Recorded,
}

fn probe_source(cfg: &BrokerConfig, record: &TunnelRecord) -> ProbeSource {
    let port = record
        .rathole_port
        .and_then(|port| u16::try_from(port).ok());
    match port {
        None => ProbeSource::Down,
        Some(_) if record.status.trim().eq_ignore_ascii_case("revoked") => ProbeSource::Down,
        Some(port) if record.ingress_id == cfg.ingress_id() => ProbeSource::Dial(port),
        Some(_) => ProbeSource::Recorded,
    }
}

/// The path goes straight into a request line, so only visible ASCII is accepted.
fn probe_path(raw: Option<&str>) -> AppResult<String> {
    let path = raw
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .unwrap_or("/");
    let valid = path.starts_with('/')
        && path.len() <= MAX_PROBE_PATH_LEN
        && path.bytes().all(|b| b.is_ascii_graphic());
    if !valid {
        return Err(AppError::bad_request(
            "path must be an absolute request path",
        ));
    }
    Ok(path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dials_live_tunnels_on_this_ingress_and_reads_the_record_for_others() {
        let cfg = crate::config::test_broker_config();
        let here = TunnelRecord {
            ingress_id: cfg.ingress_id(),
            ..db::test_tunnel_record()
        };
        assert_eq!(probe_source(&cfg, &here), ProbeSource::Dial(20000));

        // Another ingress allocates the same port numbers for other sites, so its sidecar's
        // record answers instead of a dial here.
        let elsewhere = db::test_tunnel_record();
        assert_ne!(elsewhere.ingress_id, cfg.ingress_id());
        assert_eq!(probe_source(&cfg, &elsewhere), ProbeSource::Recorded);

        for record in [here, elsewhere] {
            let revoked = TunnelRecord {
                status: "revoked".into(),
                ..record.clone()
            };
            assert_eq!(probe_source(&cfg, &revoked), ProbeSource::Down);
            let unbound = TunnelRecord {
                rathole_port: None,
                ..record
            };
            assert_eq!(probe_source(&cfg, &unbound), ProbeSource::Down);
        }
    }

    #[test]
    fn validates_probe_paths() {
        assert_eq!(probe_path(None).unwrap(), "/");
        assert_eq!(probe_path(Some("")).unwrap(), "/");
        assert_eq!(probe_path(Some("/site/?q=1")).unwrap(), "/site/?q=1");
        assert!(probe_path(Some("site")).is_err());
        assert!(probe_path(Some("/a b")).is_err());
        assert!(probe_path(Some("/a\r\nHost: evil")).is_err());
        assert!(probe_path(Some(&format!("/{}", "a".repeat(MAX_PROBE_PATH_LEN)))).is_err());
    }

    /// The production split: the broker API on one node, rathole and its ingress sidecar on
    /// another. Runs against a disposable Postgres, like the create tests:
    /// `TUNNEL_BROKER_TEST_DATABASE_URL=postgres://… cargo test -- --ignored`.
    mod with_postgres {
        use super::*;
        use crate::db::{ListeningObservation, TunnelInsert};
        use crate::listening::probe_and_record;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tunnel_broker_types::TunnelStatus;

        const DATABASE_ENV: &str = "TUNNEL_BROKER_TEST_DATABASE_URL";

        fn database_url() -> String {
            std::env::var(DATABASE_ENV)
                .unwrap_or_else(|_| panic!("{DATABASE_ENV} must name a disposable database"))
        }

        /// A site behind rathole that answers every request with 200.
        async fn site() -> u16 {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let port = listener.local_addr().unwrap().port();
            tokio::spawn(async move {
                loop {
                    let Ok((mut socket, _)) = listener.accept().await else {
                        return;
                    };
                    let mut buf = [0u8; 512];
                    let _ = socket.read(&mut buf).await;
                    let _ = socket.write_all(b"HTTP/1.1 200 OK\r\n\r\n").await;
                }
            });
            port
        }

        fn closed_port() -> u16 {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        }

        async fn tunnel_on(
            state: &AppState,
            ingress: &db::IngressRecord,
            sidecar: &BrokerConfig,
            port: u16,
        ) -> Uuid {
            let id = Uuid::new_v4();
            let record = db::create_tunnel(
                state.pool(),
                sidecar,
                ingress,
                TunnelInsert {
                    id,
                    project_id: Uuid::new_v4(),
                    org_id: None,
                    runtime_id: None,
                    lease_id: None,
                    idempotency_key: None,
                    ingress_id: ingress.id,
                    hostname: sidecar.hostname_for(&id),
                    rathole_service: None,
                    rathole_port: None,
                    url: None,
                    status: TunnelStatus::Requested,
                    token: "tok".into(),
                    token_expires_at: None,
                    expires_at: Some(Utc::now() + chrono::Duration::minutes(10)),
                    metadata: None,
                    ttl_seconds: 60,
                },
            )
            .await
            .expect("create");
            // Point the binding at a local port standing in for rathole's.
            sqlx::query("update tunnels set rathole_port = $2 where id = $1")
                .bind(record.id)
                .bind(i32::from(port))
                .execute(state.pool())
                .await
                .unwrap();
            record.id
        }

        async fn row(state: &AppState, id: Uuid) -> TunnelRecord {
            db::get_tunnel(state.pool(), id)
                .await
                .unwrap()
                .expect("row")
        }

        async fn probe_as_broker(state: &AppState, id: Uuid) -> ProbeResponse {
            let Json(answer) = probe(
                State(state.clone()),
                Path(id),
                Query(ProbeQuery {
                    path: Some("/app/".into()),
                }),
            )
            .await
            .expect("probe");
            answer
        }

        #[tokio::test]
        #[ignore = "needs TUNNEL_BROKER_TEST_DATABASE_URL"]
        async fn a_broker_on_another_node_answers_from_what_the_sidecar_recorded() {
            let url = database_url();
            let pool = db::connect_pool(&url, 4).await.expect("connect");
            db::run_migrations(&pool).await.expect("migrate");

            // The sidecar beside rathole registers its ingress; the broker API runs on a node
            // without INGRESS_HOST, so its own ingress id names no row.
            let mut sidecar = crate::config::test_broker_config();
            sidecar.database_url = url.clone();
            sidecar.ingress_host = format!("ingress-{}.listening.test", Uuid::new_v4().simple());
            sidecar.ingress_ipv4 = Some("127.0.0.1".parse().unwrap());
            sidecar.rathole_upstream_host = "127.0.0.1".into();
            let mut broker = sidecar.clone();
            broker.ingress_host = "ingress.listening.test".into();
            broker.ingress_ipv4 = None;
            assert_ne!(broker.ingress_id(), sidecar.ingress_id());
            db::ensure_pdns_domain(&pool, &sidecar).await.expect("zone");
            let ingress = db::ensure_ingress(&pool, &sidecar).await.expect("ingress");
            let state = AppState::new(pool, broker);

            let answering = tunnel_on(&state, &ingress, &sidecar, site().await).await;
            let silent = tunnel_on(&state, &ingress, &sidecar, closed_port()).await;
            let revoked = tunnel_on(&state, &ingress, &sidecar, site().await).await;
            db::revoke_tunnel(state.pool(), &sidecar, revoked)
                .await
                .unwrap();

            // Before the sidecar has looked, the broker cannot tell.
            assert_eq!(
                probe_as_broker(&state, answering).await,
                ProbeResponse::DOWN
            );

            let bindings: Vec<_> =
                db::list_active_rathole_bindings_for_ingress(state.pool(), ingress.id)
                    .await
                    .unwrap()
                    .into_iter()
                    .filter(|binding| [answering, silent].contains(&binding.tunnel_id))
                    .collect();
            assert_eq!(bindings.len(), 2);
            let active = probe_and_record(state.pool(), "127.0.0.1", ingress.id, &bindings)
                .await
                .unwrap();
            assert_eq!(active, vec![answering]);

            let answered = row(&state, answering).await;
            assert_eq!(answered.status, "active", "the broker's own status is true");
            assert_eq!(answered.listening_status, Some(200));
            assert!(answered.listening_checked_at.is_some());
            let quiet = row(&state, silent).await;
            assert_eq!(quiet.status, "requested");
            assert_eq!(quiet.listening_status, None);
            assert!(quiet.listening_checked_at.is_some());

            assert_eq!(
                probe_as_broker(&state, answering).await,
                ProbeResponse {
                    listening: true,
                    status: Some(200)
                }
            );
            assert_eq!(probe_as_broker(&state, silent).await, ProbeResponse::DOWN);
            assert_eq!(probe_as_broker(&state, revoked).await, ProbeResponse::DOWN);

            // A later round finds it still answering; it was already active.
            let again = probe_and_record(state.pool(), "127.0.0.1", ingress.id, &bindings)
                .await
                .unwrap();
            assert!(again.is_empty());

            // A revoked row, a row on another ingress and a row whose port moved since the
            // probe are left alone.
            let checked_before = row(&state, silent).await.listening_checked_at;
            let stale_port = db::record_tunnel_listening(
                state.pool(),
                ingress.id,
                &[
                    ListeningObservation {
                        tunnel_id: silent,
                        rathole_port: quiet.rathole_port.unwrap() + 1,
                        status: Some(200),
                    },
                    ListeningObservation {
                        tunnel_id: revoked,
                        rathole_port: row(&state, revoked).await.rathole_port.unwrap(),
                        status: Some(200),
                    },
                ],
            )
            .await
            .unwrap();
            assert!(stale_port.is_empty());
            let elsewhere = db::record_tunnel_listening(
                state.pool(),
                Uuid::new_v4(),
                &[ListeningObservation {
                    tunnel_id: silent,
                    rathole_port: quiet.rathole_port.unwrap(),
                    status: Some(200),
                }],
            )
            .await
            .unwrap();
            assert!(elsewhere.is_empty());
            let untouched = row(&state, silent).await;
            assert_eq!(untouched.status, "requested");
            assert_eq!(untouched.listening_checked_at, checked_before);
            let still_revoked = row(&state, revoked).await;
            assert_eq!(still_revoked.status, "revoked");
            assert_eq!(still_revoked.listening_checked_at, None);

            // A sidecar that stopped recording no longer vouches for the site.
            sqlx::query(
                "update tunnels set listening_checked_at = now() - interval '1 hour' where id = $1",
            )
            .bind(answering)
            .execute(state.pool())
            .await
            .unwrap();
            assert_eq!(
                probe_as_broker(&state, answering).await,
                ProbeResponse::DOWN
            );
        }
    }
}
