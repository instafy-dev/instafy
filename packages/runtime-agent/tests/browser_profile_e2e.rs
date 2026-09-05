//! Real Linux Chromium + production runtime profile lifecycle + controller wire
//! integration. The companion controller test provisions only disposable state.
//! Run scripts/browser-profile-e2e.mjs; missing dependencies fail, never skip.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use runtime_agent::browser_profile::{maybe_restore_and_launch, maybe_snapshot};
use runtime_agent::config::Config;
use runtime_agent::controller::{ControllerClient, Registration};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
struct Fixture {
    base: String,
    project_id: Uuid,
    runtimes: Vec<Runtime>,
    user_token: String,
    control: String,
}

#[derive(Deserialize)]
struct Runtime {
    id: Uuid,
    lease_id: Uuid,
    token: String,
}

fn client(fixture: &Fixture, index: usize) -> Result<(ControllerClient, Registration)> {
    let runtime = &fixture.runtimes[index];
    let base: reqwest::Url = fixture.base.parse()?;
    let client = ControllerClient::new(&Config {
        controller_base_url: base.clone(),
        controller_jwks_url: base.join("/.well-known/jwks.json")?,
        project_id: fixture.project_id,
        runtime_id: Some(runtime.id),
        runtime_lease_id: Some(runtime.lease_id),
        provider: "instafy-cloud".into(),
        runtime_version: "disposable-profile-e2e".into(),
        capabilities: serde_json::json!({"agent": true}),
        metadata: serde_json::json!({}),
        lease_scope: None,
        workspace_manifest: None,
        tenant_projects: vec![],
        parent_lease_id: None,
        poll_interval: Duration::from_secs(1),
        lease_max_jobs: 1,
        lease_seconds: 120,
        heartbeat_seconds: 60,
        workspace_root: std::env::var("WORKSPACE_DIR")?.into(),
        project_workspace_override: None,
        strict_mode: false,
        dev_isolation_mode: false,
        display_name: None,
        origin: None,
        codex_bin: None,
        require_codex_bin: false,
        runtime_access_token: None,
        parent_dispositions_runtime_on_shutdown: false,
    })?;
    Ok((
        client,
        Registration {
            runtime_id: runtime.id,
            agent_token: runtime.token.clone(),
            runtime_token: None,
            lease_url: base.clone(),
            heartbeat_url: base,
            stop_url: None,
            lease_id: Some(runtime.lease_id),
            proxy: None,
            lease_scope: None,
            tenant_projects: vec![],
            workspace_manifest: None,
            parent_lease_id: None,
            agent_token_scopes: vec!["agent.browser_profile".into()],
            agent_token_issued_at: None,
            agent_token_expires_at: None,
            agent_token_ttl: None,
        },
    ))
}

async fn browser(mode: &str, value: &str) -> Result<()> {
    let mut command = tokio::process::Command::new("node");
    command
        .args([
            &std::env::var("INSTAFY_PROFILE_E2E_SCRIPT")?,
            "browser",
            mode,
            value,
        ])
        .kill_on_drop(true);
    let status = tokio::time::timeout(Duration::from_secs(30), command.status()).await??;
    ensure!(status.success(), "browser fixture {mode} failed");
    Ok(())
}

async fn launch(client: &ControllerClient, registration: &Registration, dir: &Path) -> Result<()> {
    // Dedicated --exact single-test process. No persistence worker is running
    // while its profile env changes; each launcher receives an owned copy.
    unsafe {
        std::env::set_var("INSTAFY_PLAYWRIGHT_PROFILE_DIR", dir);
    }
    maybe_restore_and_launch(client, registration).await;
    browser("ready", "").await
}

async fn stop_without_saving() -> Result<()> {
    browser("close", "").await?;
    let pid = tokio::fs::read_to_string("/tmp/instafy/playwright/chromium.pid").await?;
    let pid = pid.trim().parse::<u32>()?;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match tokio::fs::read_to_string(format!("/proc/{pid}/stat")).await {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok::<_, anyhow::Error>(());
                }
                Ok(stat)
                    if stat
                        .rsplit_once(')')
                        .is_some_and(|(_, rest)| rest.trim_start().starts_with('Z')) =>
                {
                    return Ok(());
                }
                Err(error) => return Err(error.into()),
                _ => tokio::time::sleep(Duration::from_millis(50)).await,
            }
        }
    })
    .await??;
    Ok(())
}

async fn scenario(fixture: Fixture) -> Result<()> {
    let root = tempfile::tempdir_in(std::env::var("INSTAFY_PROFILE_E2E_ROOT")?)?;
    let http = reqwest::Client::new();
    ensure!(
        http.get(format!("{}/agent/browser-profile", fixture.base))
            .send()
            .await?
            .status()
            == reqwest::StatusCode::UNAUTHORIZED,
        "anonymous profile access must fail"
    );
    let (seed, seed_registration) = client(&fixture, 0)?;
    launch(&seed, &seed_registration, &root.path().join("seed")).await?;
    browser("seed", "alpha").await?;
    maybe_snapshot(&seed, &seed_registration).await;
    let stored = seed.get_browser_profile(&seed_registration).await?;
    ensure!(
        stored.version == 1 && stored.archive.is_some(),
        "graceful save must create version 1"
    );
    http.post(format!("{}/__fixture/assert-encryption", fixture.base))
        .header("x-fixture-control", &fixture.control)
        .send()
        .await?
        .error_for_status()?;

    // Distinct managed runtimes restore the same version. Suspend A's browser
    // without a save, preserving its actual runtime writer and local directory.
    let (stale, stale_registration) = client(&fixture, 1)?;
    let stale_dir = root.path().join("stale");
    launch(&stale, &stale_registration, &stale_dir).await?;
    browser("check", "alpha").await?;
    stop_without_saving().await?;

    let (winner, winner_registration) = client(&fixture, 2)?;
    launch(&winner, &winner_registration, &root.path().join("winner")).await?;
    browser("check", "alpha").await?;
    browser("seed", "beta").await?;
    maybe_snapshot(&winner, &winner_registration).await;
    let winning_snapshot = winner.get_browser_profile(&winner_registration).await?;
    ensure!(
        winning_snapshot.version == 2,
        "changed replacement runtime must write version 2"
    );

    launch(&stale, &stale_registration, &stale_dir).await?;
    browser("check", "alpha").await?;
    browser("seed", "stale-must-not-win").await?;
    maybe_snapshot(&stale, &stale_registration).await;
    let after_conflict = winner.get_browser_profile(&winner_registration).await?;
    ensure!(
        after_conflict.version == 2 && after_conflict.archive == winning_snapshot.archive,
        "stale runtime shutdown must preserve winning archive/version"
    );
    // Recorded by test-only middleware around the real controller handler;
    // unchanged bytes alone must not pass if runtime shutdown never sent PUT.
    http.post(format!("{}/__fixture/assert-stale-conflict", fixture.base))
        .header("x-fixture-control", &fixture.control)
        .send()
        .await?
        .error_for_status()?;
    // Confirm the actual wire precondition also rejects a stale request.
    let conflict = http
        .put(format!(
            "{}/agent/browser-profile/v2?version=1",
            fixture.base
        ))
        .bearer_auth(&stale_registration.agent_token)
        .body(winning_snapshot.archive.clone().unwrap())
        .send()
        .await?;
    ensure!(
        conflict.status() == reqwest::StatusCode::CONFLICT,
        "stale profile must return 409"
    );

    let (replacement, replacement_registration) = client(&fixture, 3)?;
    launch(
        &replacement,
        &replacement_registration,
        &root.path().join("replacement"),
    )
    .await?;
    browser("check", "beta").await?;
    maybe_snapshot(&replacement, &replacement_registration).await;

    // Disposition only the fixture's already-stopped browser runtime rows, then
    // clear through the real builder-authorized reset API (no provider calls).
    http.post(format!("{}/__fixture/release", fixture.base))
        .header("x-fixture-control", &fixture.control)
        .send()
        .await?
        .error_for_status()?;
    let reset = http
        .delete(format!(
            "{}/projects/{}/browser-profile",
            fixture.base, fixture.project_id
        ))
        .bearer_auth(&fixture.user_token)
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;
    ensure!(
        reset["cleared"] == true && reset["stoppedRuntimeIds"] == serde_json::json!([]),
        "reset must clear the profile after fixture release"
    );
    let resurrection = http
        .put(format!(
            "{}/agent/browser-profile/v2?version=0",
            fixture.base
        ))
        .bearer_auth(&stale_registration.agent_token)
        .body(winning_snapshot.archive.unwrap())
        .send()
        .await?;
    ensure!(
        matches!(resurrection.status().as_u16(), 401 | 403),
        "released runtime must not resurrect a cleared profile"
    );
    http.post(format!("{}/__fixture/activate-final", fixture.base))
        .header("x-fixture-control", &fixture.control)
        .send()
        .await?
        .error_for_status()?;
    let (cleared, cleared_registration) = client(&fixture, 4)?;
    ensure!(
        cleared
            .get_browser_profile(&cleared_registration)
            .await?
            .version
            == 0,
        "reset must remove durable baseline"
    );
    launch(
        &cleared,
        &cleared_registration,
        &root.path().join("cleared"),
    )
    .await?;
    browser("empty", "").await?;
    stop_without_saving().await?;
    ensure!(
        cleared
            .get_browser_profile(&cleared_registration)
            .await?
            .version
            == 0,
        "old snapshot must not reappear"
    );
    println!(
        "PROFILE_E2E_RUNTIME_OK: HttpOnly/JS cookies, server echo, localStorage, replacement, CAS conflict and clear/no-resurrection"
    );
    Ok(())
}

#[tokio::test]
#[ignore = "requires the explicit disposable Linux browser/controller fixture"]
async fn shared_profile_runtime_lifecycle() -> Result<()> {
    ensure!(
        cfg!(target_os = "linux"),
        "this profile lifecycle requires Linux"
    );
    ensure!(
        std::env::var("INSTAFY_PROFILE_E2E").as_deref() == Ok("1"),
        "run scripts/browser-profile-e2e.mjs"
    );
    let path = PathBuf::from(
        std::env::var("INSTAFY_PROFILE_E2E_FIXTURE").context("controller fixture required")?,
    );
    let fixture: Fixture = serde_json::from_slice(&tokio::fs::read(path).await?)?;
    ensure!(
        fixture.runtimes.len() == 5,
        "exact fixture runtime identities required"
    );
    ensure!(
        reqwest::Url::parse(&fixture.base)?.host_str() == Some("127.0.0.1"),
        "controller fixture must use literal loopback"
    );
    tokio::time::timeout(Duration::from_secs(180), scenario(fixture)).await??;
    Ok(())
}
