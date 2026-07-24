//! Live round-trip of the runtime-agent browser-profile client against a RUNNING
//! controller. Gated behind env vars so it is a no-op in normal `cargo test`:
//! set LIVE_BROWSER_PROFILE_URL (e.g. http://127.0.0.1:8788) and
//! LIVE_BROWSER_PROFILE_TOKEN (an agent.browser_profile-scoped token) to run it.
//!
//! This exercises the ACTUAL `ControllerClient::{put,get}_browser_profile`
//! wire code — bearer auth, octet-stream body, 404->None, byte round-trip —
//! against the real endpoint + encrypted Postgres.

use std::path::PathBuf;
use std::time::Duration;

use runtime_agent::config::Config;
use runtime_agent::controller::{ControllerClient, Registration};
use uuid::Uuid;

fn config_for(base: &str) -> Config {
    Config {
        controller_base_url: base.parse().expect("base url"),
        controller_jwks_url: format!("{}/.well-known/jwks.json", base.trim_end_matches('/'))
            .parse()
            .expect("jwks url"),
        project_id: Uuid::nil(),
        runtime_id: None,
        runtime_lease_id: None,
        provider: "self_hosted".into(),
        runtime_version: "live-test".into(),
        capabilities: serde_json::json!({}),
        metadata: serde_json::json!({}),
        lease_scope: None,
        workspace_manifest: None,
        tenant_projects: Vec::new(),
        parent_lease_id: None,
        poll_interval: Duration::from_millis(10),
        lease_max_jobs: 1,
        lease_seconds: 120,
        heartbeat_seconds: 60,
        workspace_root: PathBuf::from("/tmp"),
        project_workspace_override: None,
        strict_mode: false,
        dev_isolation_mode: true,
        display_name: None,
        origin: None,
        codex_bin: None,
        require_codex_bin: false,
        runtime_access_token: None,
        parent_dispositions_runtime_on_shutdown: false,
    }
}

fn registration_with(token: String, base: &str) -> Registration {
    let url: reqwest::Url = base.parse().expect("url");
    Registration {
        runtime_id: Uuid::new_v4(),
        agent_token: token,
        runtime_token: None,
        lease_url: url.clone(),
        heartbeat_url: url,
        stop_url: None,
        lease_id: None,
        proxy: None,
        lease_scope: None,
        tenant_projects: Vec::new(),
        workspace_manifest: None,
        parent_lease_id: None,
        agent_token_scopes: vec!["agent.browser_profile".into()],
        agent_token_issued_at: None,
        agent_token_expires_at: None,
        agent_token_ttl: None,
    }
}

#[tokio::test]
async fn runtime_client_round_trips_browser_profile_against_live_controller() {
    let (Ok(base), Ok(token)) = (
        std::env::var("LIVE_BROWSER_PROFILE_URL"),
        std::env::var("LIVE_BROWSER_PROFILE_TOKEN"),
    ) else {
        eprintln!("skipping: set LIVE_BROWSER_PROFILE_URL + LIVE_BROWSER_PROFILE_TOKEN to run");
        return;
    };

    let client = ControllerClient::new(&config_for(&base)).expect("build client");
    let reg = registration_with(token, &base);

    // Distinctive payload; the client PUTs raw bytes and must GET them back.
    let payload: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();

    client
        .put_browser_profile(&reg, payload.clone())
        .await
        .expect("put_browser_profile");

    let got = client
        .get_browser_profile(&reg)
        .await
        .expect("get_browser_profile");

    assert_eq!(
        got.as_deref(),
        Some(payload.as_slice()),
        "client round-trip bytes must be identical"
    );
    eprintln!(
        "LIVE OK: runtime client put {} bytes and read them back identically",
        payload.len()
    );
}
