use anyhow::{Context, Result};
use std::env;
use std::path::PathBuf;
use std::time::Duration;

use sqlx::postgres::PgListener;
use tokio::process::Command;
use tokio::time::interval;
use tracing::{info, warn};

use tunnel_broker::config::BrokerConfig;
use tunnel_broker::db::{
    connect_pool, ensure_ingress, list_active_rathole_bindings_for_ingress,
    revoke_expired_tunnels_for_ingress, run_migrations,
};
use tunnel_broker::hooks::{emit_event, EventPayload};
use tunnel_broker::ingress::{render_rathole_server_config, render_traefik_dynamic_config};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cfg = BrokerConfig::from_env()?;
    let pool = connect_pool(&cfg.database_url, cfg.database_pool_size).await?;
    run_migrations(&pool).await?;

    let output_path = env::var("RATHOLE_CONFIG_OUTPUT")
        .unwrap_or_else(|_| "/etc/rathole/server.toml".to_string());
    let output_path = PathBuf::from(output_path.trim());

    let traefik_output_path = env::var("TRAEFIK_CONFIG_OUTPUT")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);

    let refresh_seconds = env::var("RATHOLE_CONFIG_REFRESH_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(10)
        .max(1);

    let reload_command = env::var("RATHOLE_RELOAD_COMMAND")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let pid_file = env::var("RATHOLE_PID_FILE")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    info!(
        path = %output_path.display(),
        refresh_seconds,
        "starting rathole ingress sidecar"
    );

    let mut ticker = interval(Duration::from_secs(refresh_seconds));
    let mut listener = connect_refresh_listener(&cfg).await;
    loop {
        if let Some(active_listener) = listener.as_mut() {
            tokio::select! {
                _ = ticker.tick() => {
                    if let Err(error) = sync_once(&pool, &cfg, &output_path, traefik_output_path.as_ref(), reload_command.as_deref(), pid_file.as_deref()).await {
                        warn!(?error, "failed to sync rathole config");
                    }
                }
                notification = active_listener.recv() => {
                    match notification {
                        Ok(notification) => {
                            let payload = notification.payload();
                            info!(
                                channel = notification.channel(),
                                payload,
                                "received ingress refresh notification"
                            );
                            if let Err(error) = sync_once(&pool, &cfg, &output_path, traefik_output_path.as_ref(), reload_command.as_deref(), pid_file.as_deref()).await {
                                warn!(?error, "failed to sync rathole config");
                            }
                        }
                        Err(error) => {
                            warn!(?error, "lost ingress refresh listener; falling back to periodic polling");
                            listener = None;
                        }
                    }
                }
                _ = tokio::signal::ctrl_c() => {
                    info!("sidecar received shutdown signal");
                    break;
                }
            }
        } else {
            tokio::select! {
                _ = ticker.tick() => {
                    listener = connect_refresh_listener(&cfg).await;
                    if let Err(error) = sync_once(&pool, &cfg, &output_path, traefik_output_path.as_ref(), reload_command.as_deref(), pid_file.as_deref()).await {
                        warn!(?error, "failed to sync rathole config");
                    }
                }
                _ = tokio::signal::ctrl_c() => {
                    info!("sidecar received shutdown signal");
                    break;
                }
            }
        }
    }

    Ok(())
}

async fn connect_refresh_listener(cfg: &BrokerConfig) -> Option<PgListener> {
    let channel = cfg.rathole_config_notify_channel.trim();
    if channel.is_empty() {
        return None;
    }

    let mut listener = match PgListener::connect(&cfg.database_url).await {
        Ok(listener) => listener,
        Err(error) => {
            warn!(
                ?error,
                channel, "failed to connect ingress refresh listener"
            );
            return None;
        }
    };

    if let Err(error) = listener.listen(channel).await {
        warn!(
            ?error,
            channel, "failed to subscribe to ingress refresh notifications"
        );
        return None;
    }

    info!(channel, "listening for ingress refresh notifications");
    Some(listener)
}

async fn sync_once(
    pool: &sqlx::PgPool,
    cfg: &BrokerConfig,
    output_path: &PathBuf,
    traefik_output_path: Option<&PathBuf>,
    reload_command: Option<&str>,
    pid_file: Option<&str>,
) -> Result<()> {
    let ingress = ensure_ingress(pool, cfg).await?;
    let revoked = revoke_expired_tunnels_for_ingress(pool, cfg, ingress.id)
        .await
        .unwrap_or_default();
    if !revoked.is_empty() {
        info!(revoked = revoked.len(), "revoked expired tunnels");

        if let Some(event) = cfg.event_hook.as_ref() {
            let client = reqwest::Client::new();
            for record in revoked {
                let project_id = record.project_id;
                let org_id = record.org_id;
                let runtime_id = record.runtime_id;
                let lease_id = record.lease_id;
                let descriptor = record.into_descriptor(cfg, &ingress);
                emit_event(
                    &client,
                    event,
                    &EventPayload {
                        kind: "tunnel.expired",
                        project_id,
                        org_id,
                        runtime_id,
                        lease_id,
                        data: serde_json::to_value(&descriptor).unwrap_or_default(),
                    },
                )
                .await;
            }
        }
    }
    let bindings = list_active_rathole_bindings_for_ingress(pool, ingress.id).await?;
    let rendered = render_rathole_server_config(cfg, &bindings);

    let rathole_changed = match tokio::fs::read_to_string(output_path).await {
        Ok(existing) => existing != rendered,
        Err(_) => true,
    };

    if rathole_changed {
        if let Some(parent) = output_path.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        tokio::fs::write(output_path, rendered.as_bytes())
            .await
            .with_context(|| {
                format!(
                    "failed to write rathole config to {}",
                    output_path.display()
                )
            })?;

        info!(path = %output_path.display(), "rathole config updated");

        if let Some(cmd) = reload_command {
            let status = Command::new("sh").arg("-c").arg(cmd).status().await?;
            if status.success() {
                info!(command = cmd, "rathole reload command executed");
            } else {
                warn!(command = cmd, ?status, "rathole reload command failed");
            }
        } else if let Some(pid_path) = pid_file {
            if let Ok(raw_pid) = tokio::fs::read_to_string(pid_path).await {
                if let Ok(pid) = raw_pid.trim().parse::<i32>() {
                    let status = Command::new("kill")
                        .arg("-HUP")
                        .arg(pid.to_string())
                        .status()
                        .await?;
                    if status.success() {
                        info!(pid, "sent HUP to rathole");
                    } else {
                        warn!(pid, ?status, "failed to send HUP to rathole");
                    }
                }
            }
        }
    }

    if let Some(path) = traefik_output_path {
        let rendered = render_traefik_dynamic_config(cfg, &bindings);
        let traefik_changed = match tokio::fs::read_to_string(path).await {
            Ok(existing) => existing != rendered,
            Err(_) => true,
        };
        if traefik_changed {
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent).await.ok();
            }
            tokio::fs::write(path, rendered.as_bytes())
                .await
                .with_context(|| format!("failed to write traefik config to {}", path.display()))?;
            info!(path = %path.display(), "traefik dynamic config updated");
        }
    }

    Ok(())
}
