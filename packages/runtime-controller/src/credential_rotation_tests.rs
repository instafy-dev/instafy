//! Credential key rotation against the local shared test database.
//!
//! Every key here is derived from a fresh UUID, so only rows these tests seal
//! open under them: rows other suites leave in the shared tables count as
//! undecryptable and are never written. Counts for these keys are therefore
//! exact even while other tests run.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use bb8_postgres::PostgresConnectionManager;
use chrono::{DateTime, Duration, Utc};
use futures_util::FutureExt;
use serde_json::{json, Value};
use std::panic::AssertUnwindSafe;
use tower::ServiceExt;
use uuid::Uuid;

use super::SEALED_TABLES;
use crate::config::{AppConfig, CredentialEncryptionKey, PgPool};
use crate::credential_keys::CredentialKeyRing;
use crate::device_auth::{
    load_user_oauth_access_token, resolve_github_device_auth_session,
    GithubDeviceAuthSessionResolution,
};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key,
};
use crate::AppState;

const SERVICE_ROLE: &str = "service-role-token";
const CREDENTIAL_LEASE: &str = "credential-lease";

fn random_key(label: &str) -> CredentialEncryptionKey {
    CredentialEncryptionKey::for_test(&format!("{label}-{}", Uuid::new_v4()))
}

fn config_with(keys: Option<CredentialKeyRing>) -> AppConfig {
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "credential-rotation-test",
    );
    config.credential_keys = keys;
    config
}

fn state_with(pool: &PgPool, keys: CredentialKeyRing) -> AppState {
    build_test_state(pool.clone(), config_with(Some(keys)))
}

fn app(state: AppState) -> Router {
    super::router()
        .merge(crate::credentials::router())
        .with_state(state)
}

async fn call(
    app: &Router,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
) -> anyhow::Result<(StatusCode, String)> {
    let mut request = Request::builder().method(method).uri(uri);
    if let Some(bearer) = bearer {
        request = request.header("Authorization", format!("Bearer {bearer}"));
    }
    let response = app.clone().oneshot(request.body(Body::empty())?).await?;
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await?;
    Ok((status, String::from_utf8(body.to_vec())?))
}

async fn call_json(
    app: &Router,
    method: &str,
    uri: &str,
    bearer: Option<&str>,
) -> anyhow::Result<Value> {
    let (status, body) = call(app, method, uri, bearer).await?;
    anyhow::ensure!(status == StatusCode::OK, "{method} {uri}: {status}: {body}");
    Ok(serde_json::from_str(&body)?)
}

fn table<'a>(report: &'a Value, name: &str) -> &'a Value {
    report["tables"]
        .as_array()
        .and_then(|tables| tables.iter().find(|table| table["table"] == name))
        .unwrap_or(&Value::Null)
}

/// One sealed row in each table under `old`, a second credential already
/// under `new`, and a third under a key no ring in these tests holds.
struct Fixture {
    user_id: Uuid,
    project_id: Uuid,
    credential_id: Uuid,
    primary_credential_id: Uuid,
    foreign_credential_id: Uuid,
    secret_id: Uuid,
    oauth_provider: String,
    profile_id: Uuid,
    session_id: Uuid,
    marker: String,
    assertion_expires_at: DateTime<Utc>,
}

impl Fixture {
    fn new() -> Self {
        let user_id = Uuid::new_v4();
        Self {
            user_id,
            project_id: Uuid::new_v4(),
            credential_id: Uuid::new_v4(),
            primary_credential_id: Uuid::new_v4(),
            foreign_credential_id: Uuid::new_v4(),
            secret_id: Uuid::new_v4(),
            oauth_provider: format!("rotation-test-{}", Uuid::new_v4().simple()),
            profile_id: Uuid::new_v4(),
            session_id: Uuid::new_v4(),
            marker: format!("rotation-marker-{}", Uuid::new_v4().simple()),
            assertion_expires_at: Utc::now() + Duration::minutes(20),
        }
    }

    fn credential_plaintext(&self, which: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({ "OPENAI_API_KEY": format!("sk-{which}-{}", self.marker) }))
            .unwrap()
    }

    fn oauth_plaintext(&self, session: Option<Uuid>) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "access_token": format!("gho-{}", self.marker),
            "scope": "repo",
            "device_auth_session_id": session.map(|id| id.to_string()),
            "device_auth_session_expires_at": session.map(|_| self.assertion_expires_at.to_rfc3339()),
        }))
        .unwrap()
    }

    fn secret_plaintext(&self) -> Vec<u8> {
        format!("secret-{}", self.marker).into_bytes()
    }

    fn profile_plaintext(&self) -> Vec<u8> {
        let mut profile = b"PK\x03\x04".to_vec();
        profile.extend(format!("profile-{}", self.marker).into_bytes());
        profile
    }

    async fn seed(
        &self,
        pool: &PgPool,
        old: &CredentialEncryptionKey,
        new: &CredentialEncryptionKey,
        foreign: &CredentialEncryptionKey,
    ) -> anyhow::Result<()> {
        ensure_test_user(pool, &self.user_id).await?;
        crate::secrets::ensure_secret_tables(pool).await?;
        crate::browser_profile::ensure_browser_profiles_table(pool).await?;
        let old = CredentialKeyRing::from(old.clone());
        let new = CredentialKeyRing::from(new.clone());
        let foreign = CredentialKeyRing::from(foreign.clone());
        let connection = pool.get().await?;
        connection
            .execute(
                "insert into projects (id, project_type, status) values ($1, 'customer', 'active')",
                &[&self.project_id],
            )
            .await?;
        for (id, ring, which) in [
            (self.credential_id, &old, "old"),
            (self.primary_credential_id, &new, "new"),
            (self.foreign_credential_id, &foreign, "foreign"),
        ] {
            let (nonce, ciphertext) = ring.seal(&self.credential_plaintext(which))?;
            connection
                .execute(
                    "insert into user_credentials (id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata)
                     values ($1, $2, 'openai_api_key', 'rotation test', $3, $4, '{}'::jsonb)",
                    &[&id, &self.user_id, &nonce, &ciphertext],
                )
                .await?;
        }
        let (nonce, ciphertext) = old.seal(&self.secret_plaintext())?;
        connection
            .execute(
                "insert into project_secrets (id, project_id, user_id, name, nonce_b64, ciphertext_b64)
                 values ($1, $2, $3, 'ROTATION_TEST_SECRET', $4, $5)",
                &[&self.secret_id, &self.project_id, &self.user_id, &nonce, &ciphertext],
            )
            .await?;
        let (nonce, ciphertext) = old.seal(&self.oauth_plaintext(None))?;
        connection
            .execute(
                "insert into user_oauth_tokens (user_id, provider, nonce_b64, ciphertext_b64, scope)
                 values ($1, $2, $3, $4, 'repo')",
                &[&self.user_id, &self.oauth_provider, &nonce, &ciphertext],
            )
            .await?;
        let profile = self.profile_plaintext();
        let (nonce, ciphertext) = old.seal(&profile)?;
        connection
            .execute(
                "insert into project_browser_profiles (id, project_id, scope, version, nonce_b64, ciphertext_b64, bytes)
                 values ($1, $2, 'project', 3, $3, $4, $5)",
                &[&self.profile_id, &self.project_id, &nonce, &ciphertext, &(profile.len() as i64)],
            )
            .await?;
        let (nonce, ciphertext) = old.seal(&self.oauth_plaintext(Some(self.session_id)))?;
        let now = Utc::now();
        connection
            .execute(
                "insert into github_device_auth_sessions (
                   session_id, user_id, status, verification_url, user_code, poll_interval_seconds,
                   device_expires_at, completed_at, assertion_expires_at,
                   token_nonce_b64, token_ciphertext_b64, token_scope
                 ) values ($1, $2, 'completed', 'https://github.com/login/device', 'ROTA-TEST', 5,
                           $3, $4, $5, $6, $7, 'repo')",
                &[
                    &self.session_id,
                    &self.user_id,
                    &(now + Duration::minutes(15)),
                    &now,
                    &self.assertion_expires_at,
                    &nonce,
                    &ciphertext,
                ],
            )
            .await?;
        Ok(())
    }

    /// Every sealed value this fixture owns, keyed by a label, in a fixed order.
    async fn sealed(&self, pool: &PgPool) -> anyhow::Result<Vec<(String, String, String)>> {
        let connection = pool.get().await?;
        let mut sealed = Vec::new();
        for (label, id) in [
            ("credential", self.credential_id),
            ("primary credential", self.primary_credential_id),
            ("foreign credential", self.foreign_credential_id),
        ] {
            let row = connection
                .query_one(
                    "select nonce_b64, ciphertext_b64 from user_credentials where id = $1",
                    &[&id],
                )
                .await?;
            sealed.push((label.to_string(), row.get(0), row.get(1)));
        }
        let row = connection
            .query_one(
                "select nonce_b64, ciphertext_b64 from project_secrets where id = $1",
                &[&self.secret_id],
            )
            .await?;
        sealed.push(("secret".to_string(), row.get(0), row.get(1)));
        let row = connection
            .query_one(
                "select nonce_b64, ciphertext_b64 from user_oauth_tokens where user_id = $1 and provider = $2",
                &[&self.user_id, &self.oauth_provider],
            )
            .await?;
        sealed.push(("oauth".to_string(), row.get(0), row.get(1)));
        let row = connection
            .query_one(
                "select nonce_b64, ciphertext_b64 from project_browser_profiles where id = $1",
                &[&self.profile_id],
            )
            .await?;
        sealed.push(("profile".to_string(), row.get(0), row.get(1)));
        let row = connection
            .query_one(
                "select token_nonce_b64, token_ciphertext_b64 from github_device_auth_sessions where session_id = $1",
                &[&self.session_id],
            )
            .await?;
        sealed.push(("device session".to_string(), row.get(0), row.get(1)));
        Ok(sealed)
    }

    fn expected_plaintext(&self, label: &str) -> Vec<u8> {
        match label {
            "credential" => self.credential_plaintext("old"),
            "primary credential" => self.credential_plaintext("new"),
            "foreign credential" => self.credential_plaintext("foreign"),
            "secret" => self.secret_plaintext(),
            "oauth" => self.oauth_plaintext(None),
            "profile" => self.profile_plaintext(),
            "device session" => self.oauth_plaintext(Some(self.session_id)),
            other => panic!("unknown fixture row {other}"),
        }
    }

    /// Reads through the controller's own handlers, not the key ring directly.
    async fn assert_readable(&self, state: &AppState) -> anyhow::Result<()> {
        let (status, body) = call(
            &app(state.clone()),
            "GET",
            &format!("/internal/credentials/{}", self.credential_id),
            Some(CREDENTIAL_LEASE),
        )
        .await?;
        anyhow::ensure!(
            status == StatusCode::OK,
            "credential lease: {status}: {body}"
        );
        anyhow::ensure!(body.contains(&format!("sk-old-{}", self.marker)));

        let token = load_user_oauth_access_token(state, self.user_id, &self.oauth_provider)
            .await
            .map_err(|(status, error)| {
                anyhow::anyhow!("oauth token: {status}: {}", error.0.message)
            })?;
        anyhow::ensure!(token == Some(format!("gho-{}", self.marker)));

        match resolve_github_device_auth_session(state, self.user_id, self.session_id)
            .await
            .map_err(|(status, error)| {
                anyhow::anyhow!("device session: {status}: {}", error.0.message)
            })? {
            GithubDeviceAuthSessionResolution::Completed { access_token } => {
                anyhow::ensure!(access_token == format!("gho-{}", self.marker));
            }
            _ => anyhow::bail!("device session did not resolve as completed"),
        }
        Ok(())
    }

    async fn cleanup(&self, pool: &PgPool) -> anyhow::Result<()> {
        let connection = pool.get().await?;
        connection
            .execute(
                "delete from user_oauth_tokens where user_id = $1",
                &[&self.user_id],
            )
            .await?;
        connection
            .execute(
                "delete from project_secrets where id = $1",
                &[&self.secret_id],
            )
            .await?;
        // Cascades to project_browser_profiles.
        connection
            .execute("delete from projects where id = $1", &[&self.project_id])
            .await?;
        // Cascades to user_credentials and github_device_auth_sessions.
        connection
            .execute("delete from auth.users where id = $1", &[&self.user_id])
            .await?;
        Ok(())
    }
}

fn assert_no_secret_material(body: &str, fixture: &Fixture, keys: &[&CredentialEncryptionKey]) {
    use base64::Engine;
    assert!(
        !body.contains(&fixture.marker),
        "report exposed a plaintext"
    );
    for key in keys {
        let encoded = base64::engine::general_purpose::STANDARD.encode(key.as_bytes());
        assert!(!body.contains(&encoded), "report exposed a key");
        assert!(
            !body.contains(&hex::encode(key.as_bytes())),
            "report exposed a key"
        );
    }
}

#[tokio::test]
async fn rotation_keeps_old_rows_readable_then_moves_every_table_to_the_primary(
) -> anyhow::Result<()> {
    let pool = require_origin_test_pool("credential key rotation").await?;
    let old = random_key("rotation-old");
    let new = random_key("rotation-new");
    let foreign = random_key("rotation-foreign");
    let fixture = Fixture::new();

    // Assertions panic; catch the unwind so the fixture is removed either way.
    let result: Result<anyhow::Result<()>, _> = AssertUnwindSafe(async {
        fixture.seed(&pool, &old, &new, &foreign).await?;
        let seeded = fixture.sealed(&pool).await?;
        let rotating = CredentialKeyRing::new(new.clone(), vec![old.clone()])?;
        let state = state_with(&pool, rotating);
        let routes = app(state.clone());

        // With the old key listed as previous, the controller's own read
        // paths still open rows sealed before the rotation.
        fixture.assert_readable(&state).await?;
        // Without it they fail cleanly, never with garbage.
        let primary_only = state_with(&pool, CredentialKeyRing::from(new.clone()));
        let (status, error) =
            load_user_oauth_access_token(&primary_only, fixture.user_id, &fixture.oauth_provider)
                .await
                .expect_err("the primary key alone cannot open rows sealed under the old key");
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(
            error.0.message.contains("does not authenticate"),
            "{}",
            error.0.message
        );
        assert!(!error.0.message.contains(&fixture.marker));

        let census = call_json(
            &routes,
            "GET",
            "/operator/credential-encryption/census",
            Some(SERVICE_ROLE),
        )
        .await?;
        assert_no_secret_material(&census.to_string(), &fixture, &[&old, &new, &foreign]);
        assert_eq!(census["totals"]["primary"], 1, "{census}");
        assert_eq!(census["totals"]["previous"], json!([5]), "{census}");
        assert!(
            census["totals"]["undecryptable"].as_u64() >= Some(1),
            "{census}"
        );
        assert_eq!(census["previousKeys"][0]["entry"], 1);
        assert_eq!(census["previousKeys"][0]["publishedDevelopmentKey"], false);
        assert_eq!(
            census["primaryKey"]["keyId"],
            crate::credential_keys::credential_key_id(&new)
        );
        for sealed in SEALED_TABLES {
            let counts = table(&census, sealed.name);
            assert_eq!(counts["present"], true, "{}", sealed.name);
            assert_eq!(counts["previous"], json!([1]), "{}: {counts}", sealed.name);
        }
        assert_eq!(table(&census, "user_credentials")["primary"], 1);

        // Bounded first pass: stops after two rewrites and says so.
        let partial = call_json(
            &routes,
            "POST",
            "/operator/credential-encryption/reencrypt?batchSize=1&maxRows=2",
            Some(SERVICE_ROLE),
        )
        .await?;
        assert_eq!(partial["complete"], false, "{partial}");
        assert_eq!(partial["totals"]["reencrypted"], 2, "{partial}");
        // Rows rewritten so far remain readable mid-rotation.
        fixture.assert_readable(&state).await?;

        // Small pages exercise the keyset cursor, including the composite key.
        let finished = call_json(
            &routes,
            "POST",
            "/operator/credential-encryption/reencrypt?batchSize=2",
            Some(SERVICE_ROLE),
        )
        .await?;
        assert_no_secret_material(&finished.to_string(), &fixture, &[&old, &new, &foreign]);
        assert_eq!(finished["complete"], true, "{finished}");
        assert_eq!(finished["totals"]["reencrypted"], 3, "{finished}");
        assert_eq!(finished["totals"]["alreadyPrimary"], 3, "{finished}");
        assert_eq!(
            finished["tables"].as_array().map(Vec::len),
            Some(SEALED_TABLES.len())
        );

        // Every row now opens under the primary key alone, to the same plaintext.
        let rotated = fixture.sealed(&pool).await?;
        let primary = CredentialKeyRing::from(new.clone());
        for ((label, before_nonce, before_ciphertext), (_, nonce, ciphertext)) in
            seeded.iter().zip(&rotated)
        {
            match label.as_str() {
                "foreign credential" => {
                    // No configured key opens it, so it is never written.
                    assert_eq!((before_nonce, before_ciphertext), (nonce, ciphertext));
                }
                "primary credential" => {
                    // Already under the primary key: left exactly as it was.
                    assert_eq!((before_nonce, before_ciphertext), (nonce, ciphertext));
                    assert_eq!(
                        primary.open(nonce, ciphertext)?,
                        fixture.expected_plaintext(label)
                    );
                }
                _ => {
                    assert_ne!(before_nonce, nonce, "{label} was not rewritten");
                    assert_eq!(
                        primary.open(nonce, ciphertext)?,
                        fixture.expected_plaintext(label),
                        "{label}"
                    );
                    assert!(CredentialKeyRing::from(old.clone())
                        .open(nonce, ciphertext)
                        .is_err());
                }
            }
        }
        let connection = pool.get().await?;
        let profile = connection
            .query_one(
                "select version, bytes from project_browser_profiles where id = $1",
                &[&fixture.profile_id],
            )
            .await?;
        assert_eq!(
            profile.get::<_, i64>("version"),
            3,
            "re-encryption must not bump the CAS version"
        );
        assert_eq!(
            profile.get::<_, i64>("bytes"),
            fixture.profile_plaintext().len() as i64
        );
        let session = connection
            .query_one(
                "select status from github_device_auth_sessions where session_id = $1",
                &[&fixture.session_id],
            )
            .await?;
        assert_eq!(session.get::<_, String>("status"), "completed");
        drop(connection);

        // The previous key is no longer needed by any of these rows.
        fixture.assert_readable(&primary_only).await?;

        // Idempotent: a second complete pass rewrites nothing.
        let again = call_json(
            &routes,
            "POST",
            "/operator/credential-encryption/reencrypt",
            Some(SERVICE_ROLE),
        )
        .await?;
        assert_eq!(again["complete"], true);
        assert_eq!(again["totals"]["reencrypted"], 0, "{again}");
        assert_eq!(again["totals"]["alreadyPrimary"], 6, "{again}");
        assert_eq!(fixture.sealed(&pool).await?, rotated);

        let census = call_json(
            &routes,
            "GET",
            "/operator/credential-encryption/census?batchSize=3",
            Some(SERVICE_ROLE),
        )
        .await?;
        assert_eq!(census["totals"]["primary"], 6, "{census}");
        assert_eq!(census["totals"]["previous"], json!([0]), "{census}");
        Ok(())
    })
    .catch_unwind()
    .await;

    fixture.cleanup(&pool).await?;
    result.unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

#[tokio::test]
async fn a_wrong_previous_key_never_rewrites_or_corrupts_rows() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("credential key rotation with a wrong previous key").await?;
    let old = random_key("wrong-old");
    let new = random_key("wrong-new");
    let wrong = random_key("wrong-previous");
    let foreign = random_key("wrong-foreign");
    let fixture = Fixture::new();

    // Assertions panic; catch the unwind so the fixture is removed either way.
    let result: Result<anyhow::Result<()>, _> = AssertUnwindSafe(async {
        fixture.seed(&pool, &old, &new, &foreign).await?;
        let seeded = fixture.sealed(&pool).await?;
        let misconfigured = CredentialKeyRing::new(new.clone(), vec![wrong.clone()])?;
        let state = state_with(&pool, misconfigured);
        let routes = app(state.clone());

        let census = call_json(
            &routes,
            "GET",
            "/operator/credential-encryption/census",
            Some(SERVICE_ROLE),
        )
        .await?;
        assert_eq!(census["totals"]["primary"], 1, "{census}");
        assert_eq!(census["totals"]["previous"], json!([0]), "{census}");
        assert!(
            census["totals"]["undecryptable"].as_u64() >= Some(6),
            "{census}"
        );

        let pass = call_json(
            &routes,
            "POST",
            "/operator/credential-encryption/reencrypt?batchSize=1",
            Some(SERVICE_ROLE),
        )
        .await?;
        assert_eq!(pass["complete"], true);
        assert_eq!(pass["totals"]["reencrypted"], 0, "{pass}");
        assert!(
            pass["totals"]["undecryptable"].as_u64() >= Some(6),
            "{pass}"
        );
        assert_eq!(
            fixture.sealed(&pool).await?,
            seeded,
            "undecryptable rows must never be written"
        );

        // Reads fail with an error rather than returning garbage...
        let (status, body) = call(
            &routes,
            "GET",
            &format!("/internal/credentials/{}", fixture.credential_id),
            Some(CREDENTIAL_LEASE),
        )
        .await?;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{body}");
        assert!(body.contains("does not authenticate"), "{body}");
        assert!(!body.contains(&fixture.marker));

        // ...and nothing was damaged: the right previous key still opens every row.
        let corrected = state_with(
            &pool,
            CredentialKeyRing::new(new.clone(), vec![old.clone()])?,
        );
        fixture.assert_readable(&corrected).await?;
        let ring = CredentialKeyRing::new(new.clone(), vec![old.clone(), foreign.clone()])?;
        for (label, nonce, ciphertext) in &seeded {
            assert_eq!(
                ring.open(nonce, ciphertext)?,
                fixture.expected_plaintext(label),
                "{label}"
            );
        }
        Ok(())
    })
    .catch_unwind()
    .await;

    fixture.cleanup(&pool).await?;
    result.unwrap_or_else(|panic| std::panic::resume_unwind(panic))
}

#[tokio::test]
async fn rotation_routes_are_service_role_only_and_checked_before_database_access(
) -> anyhow::Result<()> {
    // Nothing listens on port 1: a route that reached the database would fail
    // with a 5xx instead of the refusal each case expects.
    let manager = PostgresConnectionManager::new_from_stringlike(
        "postgresql://postgres:postgres@127.0.0.1:1/postgres",
        crate::config::database_tls(),
    )?;
    let pool = bb8::Pool::builder().max_size(1).build_unchecked(manager);
    let keys = CredentialKeyRing::from(random_key("routes"));
    let config = config_with(Some(keys));
    let user_token = crate::auth::issue_controller_token(&config, &Uuid::new_v4())
        .map_err(|_| anyhow::anyhow!("user token issuance failed"))?
        .token;
    let routes = app(build_test_state(pool.clone(), config));
    let unconfigured = app(build_test_state(pool, config_with(None)));

    for (method, path) in [
        ("GET", "/operator/credential-encryption/census"),
        ("POST", "/operator/credential-encryption/reencrypt"),
    ] {
        let (status, body) = call(&routes, method, path, None).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}: {body}");
        let (status, body) = call(&routes, method, path, Some(&user_token)).await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {body}");
        let (status, body) = call(&routes, method, path, Some(CREDENTIAL_LEASE)).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}: {body}");
        let (status, body) = call(
            &routes,
            method,
            &format!("{path}?batchSize=0"),
            Some(SERVICE_ROLE),
        )
        .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{method} {path}: {body}");
        let (status, body) = call(&unconfigured, method, path, Some(SERVICE_ROLE)).await?;
        assert_eq!(
            status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{method} {path}: {body}"
        );
    }
    let (status, _) = call(
        &routes,
        "POST",
        "/operator/credential-encryption/reencrypt?maxRows=0",
        Some(SERVICE_ROLE),
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call(
        &routes,
        "GET",
        "/operator/credential-encryption/census?maxRows=5",
        Some(SERVICE_ROLE),
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    Ok(())
}

/// A table that stores a sealed value but is missing from `SEALED_TABLES`
/// would keep rows under a previous key after every pass, and removing that
/// key would strand them. Scan the schema sources for sealed columns.
#[test]
fn every_table_with_a_sealed_column_is_rotated() {
    fn collect(directory: &std::path::Path, sources: &mut Vec<String>) {
        for entry in std::fs::read_dir(directory).expect("schema source directory") {
            let path = entry.expect("directory entry").path();
            if path.is_dir() {
                collect(&path, sources);
            } else if matches!(
                path.extension().and_then(|ext| ext.to_str()),
                Some("sql" | "rs")
            ) && !path.ends_with("credential_rotation_tests.rs")
            {
                sources.push(std::fs::read_to_string(&path).expect("readable schema source"));
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut sources = Vec::new();
    collect(&root.join("../../supabase/migrations"), &mut sources);
    collect(&root.join("src"), &mut sources);
    collect(&root.join("migrations"), &mut sources);
    let mut sealed_tables = std::collections::BTreeSet::new();
    for source in &sources {
        let lower = source.to_ascii_lowercase();
        for statement in lower.split("create table").skip(1) {
            let statement = statement.split(';').next().unwrap_or_default();
            if !statement.contains("ciphertext") {
                continue;
            }
            let name = statement
                .trim_start()
                .trim_start_matches("if not exists")
                .trim_start()
                .split(|c: char| c.is_whitespace() || c == '(')
                .next()
                .unwrap_or_default()
                .trim_start_matches("public.")
                .to_string();
            sealed_tables.insert(name);
        }
        for statement in lower.split("alter table").skip(1) {
            let statement = statement.split(';').next().unwrap_or_default();
            if statement.contains("add column") && statement.contains("ciphertext") {
                let name = statement
                    .trim_start()
                    .trim_start_matches("if exists")
                    .trim_start()
                    .split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .trim_start_matches("public.")
                    .to_string();
                sealed_tables.insert(name);
            }
        }
    }
    let rotated: std::collections::BTreeSet<String> = SEALED_TABLES
        .iter()
        .map(|table| table.name.to_string())
        .collect();
    assert!(
        sealed_tables.len() >= SEALED_TABLES.len(),
        "the scan found only {sealed_tables:?}"
    );
    assert_eq!(sealed_tables, rotated);
}
