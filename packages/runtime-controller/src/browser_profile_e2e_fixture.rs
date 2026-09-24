//! Test-only controller fixture for the secret-free Linux profile lifecycle lane.
//! No fixture routes are compiled into the production controller.

use super::*;
use axum::extract::Path;
use axum::http::HeaderMap;
use axum::routing::post;

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires scripts/browser-profile-e2e.mjs and disposable migrated loopback Postgres"]
async fn shared_profile_browser_runtime_lifecycle_e2e() -> anyhow::Result<()> {
    anyhow::ensure!(
        cfg!(target_os = "linux"),
        "this browser fixture requires Linux"
    );
    anyhow::ensure!(
        std::env::var("INSTAFY_PROFILE_E2E").as_deref() == Ok("1"),
        "run scripts/browser-profile-e2e.mjs"
    );
    let database = reqwest::Url::parse(&std::env::var("TEST_DATABASE_URL")?)?;
    anyhow::ensure!(
        database.host_str() == Some("127.0.0.1"),
        "fixture database must use literal loopback"
    );
    let agent_binary = std::env::var("INSTAFY_PROFILE_E2E_AGENT_BINARY")?;
    let pool = setup_origin_test_pool()
        .await?
        .context("explicit fixture database required")?;
    let applied = pool
        .get()
        .await?
        .query(
            "select version from supabase_migrations.schema_migrations",
            &[],
        )
        .await?
        .iter()
        .map(|row| row.get::<_, String>(0))
        .collect::<std::collections::HashSet<_>>();
    let migrations =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../supabase/migrations");
    let mut checked_migrations = 0;
    for entry in std::fs::read_dir(migrations)? {
        let name = entry?.file_name();
        let name = name.to_string_lossy();
        if name.ends_with(".sql") {
            let version = name
                .split('_')
                .next()
                .context("invalid migration filename")?;
            anyhow::ensure!(
                applied.contains(version),
                "fixture is missing a committed public migration"
            );
            checked_migrations += 1;
        }
    }
    anyhow::ensure!(
        checked_migrations > 0,
        "committed migration inventory must not be empty"
    );
    crate::browser_profile::ensure_browser_profiles_table(&pool).await?;
    let project_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;
    let runtime_ids = [
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    ];
    let lease_ids = [
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    ];
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
            &[&project_id],
        )
        .await?;
    connection.execute("insert into project_memberships (project_id, user_id, role) values ($1, $2, 'builder')", &[&project_id, &user_id]).await?;
    for (runtime_id, lease_id) in runtime_ids.iter().zip(&lease_ids) {
        connection.execute("insert into runtimes (id, project_id, provider, status, task_ref, idle_ttl_seconds, last_seen_at, capabilities) values ($1, $2, 'instafy-cloud', 'ready', $3, 600, now(), '{\"agent\":true}')", &[runtime_id, &project_id, &format!("disposable-profile-fixture-{runtime_id}")]).await?;
        connection.execute("insert into runtime_leases (id, project_id, runtime_id, status, requested_at, launched_at) values ($1, $2, $3, 'active', now(), now())", &[lease_id, &project_id, runtime_id]).await?;
        connection
            .execute(
                "update runtimes set active_lease_id = $2 where id = $1",
                &[runtime_id, lease_id],
            )
            .await?;
    }
    drop(connection);
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "disposable-browser-profile-e2e",
    );
    config.browser_profile_persist_project_ids.push(project_id);
    config.credential_keys = Some(
        crate::config::CredentialEncryptionKey::for_test("disposable-browser-profile-e2e").into(),
    );
    let runtimes = runtime_ids
        .iter()
        .zip(&lease_ids)
        .map(|(id, lease_id)| {
            let token = crate::auth::issue_agent_token_for_runtime(
                &config,
                &project_id,
                id,
                Some(lease_id),
                None,
                "instafy-cloud",
                &json!({"agent": true}),
            )
            .map_err(|(status, _)| {
                anyhow::anyhow!("fixture agent token issuance failed: {status}")
            })?
            .token;
            Ok(json!({"id": id, "lease_id": lease_id, "token": token}))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let user_token = crate::auth::issue_controller_token(&config, &user_id)
        .map_err(|_| anyhow::anyhow!("fixture user token issuance failed"))?
        .token;
    let control = Uuid::new_v4().to_string();
    let expected_control = control.clone();
    let control_pool = pool.clone();
    let stale_upload_conflicts = Arc::new(AtomicUsize::new(0));
    let control_conflicts = stale_upload_conflicts.clone();
    let stale_authorization = format!(
        "Bearer {}",
        runtimes[1]["token"]
            .as_str()
            .context("stale fixture token missing")?
    );
    // Only the fixture orchestrator can disposition its own fake provider rows.
    // Browser processes have already been confirmed stopped by runtime-agent.
    // Reset itself still uses the actual authorized DELETE controller handler.
    let app = crate::browser_profile::router().route("/__fixture/:action", post(move |Path(action): Path<String>, headers: HeaderMap| {
        let pool = control_pool.clone();
        let expected = expected_control.clone();
        let conflicts = control_conflicts.clone();
        async move {
            if headers.get("x-fixture-control").and_then(|value| value.to_str().ok()) != Some(expected.as_str()) {
                return StatusCode::FORBIDDEN;
            }
            let result = async {
                let connection = pool.get().await?;
                match action.as_str() {
                    "assert-stale-conflict" => {
                        anyhow::ensure!(conflicts.load(Ordering::SeqCst) >= 1, "runtime shutdown must actually attempt and receive a conflicting write");
                    }
                    "assert-encryption" => {
                        let row = connection.query_one("select nonce_b64, ciphertext_b64 from project_browser_profiles where project_id = $1", &[&project_id]).await?;
                        let nonce: String = row.get(0);
                        let ciphertext: String = row.get(1);
                        anyhow::ensure!(STANDARD.decode(&nonce)?.len() == 12, "AES-GCM nonce must be stored");
                        let keys = crate::credential_keys::CredentialKeyRing::from(crate::config::CredentialEncryptionKey::for_test("disposable-browser-profile-e2e"));
                        let plaintext = keys.open(&nonce, &ciphertext)?;
                        let mut encrypted = STANDARD.decode(ciphertext)?;
                        anyhow::ensure!(plaintext.starts_with(b"PK") && encrypted != plaintext && encrypted.len() > 16, "database must contain an encrypted ZIP archive");
                        encrypted[0] ^= 1;
                        anyhow::ensure!(keys.open(&nonce, &STANDARD.encode(encrypted)).is_err(), "tampered ciphertext must fail authentication");
                    }
                    "release" => {
                        connection.execute("update runtimes set status = 'stopped', active_lease_id = null where project_id = $1", &[&project_id]).await?;
                        connection.execute("update runtime_leases set status = 'released', released_at = now() where project_id = $1", &[&project_id]).await?;
                    }
                    "activate-final" => {
                        connection.execute("update runtimes set status = 'ready', active_lease_id = $3 where id = $1 and project_id = $2", &[&runtime_ids[4], &project_id, &lease_ids[4]]).await?;
                        connection.execute("update runtime_leases set status = 'active', released_at = null where id = $1 and project_id = $2", &[&lease_ids[4], &project_id]).await?;
                    }
                    _ => anyhow::bail!("unknown fixture action"),
                }
                Ok::<_, anyhow::Error>(())
            }.await;
            if result.is_ok() { StatusCode::NO_CONTENT } else { StatusCode::INTERNAL_SERVER_ERROR }
        }
    })).with_state(build_test_state(pool.clone(), config)).layer(axum::middleware::from_fn(move |request: Request<Body>, next: axum::middleware::Next| {
        let conflicts = stale_upload_conflicts.clone();
        let stale = request.method() == axum::http::Method::PUT
            && request.uri().path() == "/agent/browser-profile/v2"
            && request.headers().get("authorization").and_then(|value| value.to_str().ok()) == Some(stale_authorization.as_str());
        async move {
            let response = next.run(request).await;
            if stale && response.status() == StatusCode::CONFLICT {
                conflicts.fetch_add(1, Ordering::SeqCst);
            }
            response
        }
    }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let base = format!("http://{}", listener.local_addr()?);
    let server = tokio::spawn(async move { axum::serve(listener, app).await });
    let mut fixture = tempfile::NamedTempFile::new_in(std::env::var("INSTAFY_PROFILE_E2E_ROOT")?)?;
    serde_json::to_writer(
        fixture.as_file_mut(),
        &json!({"base": base, "project_id": project_id, "runtimes": runtimes, "user_token": user_token, "control": control}),
    )?;
    let fixture_path = fixture.path().to_owned();
    let status = tokio::task::spawn_blocking(move || {
        std::process::Command::new(agent_binary)
            .args([
                "shared_profile_runtime_lifecycle",
                "--exact",
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env("INSTAFY_PROFILE_E2E_FIXTURE", fixture_path)
            .status()
    })
    .await?;
    server.abort();
    let _ = server.await;
    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_test_user(&pool, &user_id).await?;
    anyhow::ensure!(
        status?.success(),
        "real browser profile lifecycle worker failed"
    );
    println!(
        "PROFILE_E2E_CONTROLLER_OK: actual authorization, encrypted storage, CAS and reset routes"
    );
    Ok(())
}
