//! Exercise the actual Tokio entrypoint without a database, Docker or user credentials.
//! Each child has an empty environment and private home. Its deliberately invalid
//! database URL stops startup immediately after configuration, before any database IO.

use std::io::Read;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use httpmock::prelude::*;
use httpmock::Mock;
use serde_json::json;

const SERVICE_ID: &str = "00000000-0000-4000-8000-000000000001";
const SERVICE_EMAIL: &str = "controller-startup@example.test";
const SERVICE_KEY: &str = "inert-startup-service-role";
const SERVICE_PASSWORD: &str = "inert-startup-password-override";
// Inert fixtures, never a deployed value. Outside DEV_MODE the controller now
// refuses to start without both.
const USER_TOKEN_SECRET: &str = "inert-startup-user-token-secret-0123456789";
const CREDENTIAL_ENCRYPTION_KEY: &str = "aW5lcnQtc3RhcnR1cC1jcmVkZW50aWFsLWtleS0zMmI=";
const ADMIN_PATH: &str = "/auth/v1/admin/users";
const JWKS_PATH: &str = "/auth/v1/.well-known/jwks.json";
const OUTPUT_LIMIT: u64 = 32 * 1024;
const CHILD_TIMEOUT: Duration = Duration::from_secs(15);

struct OwnedChild {
    child: Child,
    reaped: bool,
}

impl Drop for OwnedChild {
    fn drop(&mut self) {
        if !self.reaped {
            // This exact unreaped child cannot have its PID reused. Never signal
            // a process found by name, a shared group, or a previously reaped PID.
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

struct StartupExit {
    status: ExitStatus,
    output: String,
}

fn capture_output(
    stream: impl Read + Send + 'static,
    oversized: Arc<AtomicBool>,
) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        stream
            .take(OUTPUT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .expect("read bounded owned-child output");
        if bytes.len() as u64 > OUTPUT_LIMIT {
            oversized.store(true, Ordering::SeqCst);
        }
        bytes
    })
}

fn run_controller(server: &MockServer, configure: impl FnOnce(&mut Command)) -> StartupExit {
    let directory = tempfile::tempdir().expect("private startup fixture directory");
    let mut command = Command::new(env!("CARGO_BIN_EXE_runtime-controller"));
    command
        .env_clear()
        .current_dir(directory.path())
        .env("HOME", directory.path())
        .env("WORKSPACE_ROOT", directory.path().join("workspaces"))
        .env("DATABASE_URL", "not-a-database-connection")
        .env("SUPABASE_PROJECT_URL", server.base_url())
        .env("SUPABASE_JWT_SECRET", "inert-startup-hmac-fallback")
        .env("SUPABASE_SERVICE_ROLE_KEY", SERVICE_KEY)
        .env("SERVICE_RUNTIME_USER_EMAIL", SERVICE_EMAIL)
        .env("USER_TOKEN_SECRET", USER_TOKEN_SECRET)
        .env("CREDENTIAL_ENCRYPTION_KEY", CREDENTIAL_ENCRYPTION_KEY)
        .env("MANAGED_AI_ENABLED", "false")
        .env("MANAGED_AI_STARTUP_CHECK", "false")
        .env("RUST_LOG", "info")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure(&mut command);
    let mut owned = OwnedChild {
        child: command.spawn().expect("spawn the owned controller binary"),
        reaped: false,
    };
    let oversized = Arc::new(AtomicBool::new(false));
    let stdout = capture_output(owned.child.stdout.take().unwrap(), oversized.clone());
    let stderr = capture_output(owned.child.stderr.take().unwrap(), oversized.clone());
    let deadline = Instant::now() + CHILD_TIMEOUT;
    let status = loop {
        assert!(
            !oversized.load(Ordering::SeqCst),
            "owned controller output exceeded its limit"
        );
        if let Some(status) = owned.child.try_wait().expect("poll owned controller") {
            owned.reaped = true;
            break status;
        }
        assert!(
            Instant::now() < deadline,
            "owned controller startup timed out"
        );
        thread::sleep(Duration::from_millis(10));
    };
    let mut bytes = stdout.join().expect("join owned stdout reader");
    bytes.extend(stderr.join().expect("join owned stderr reader"));
    assert!(
        !oversized.load(Ordering::SeqCst),
        "owned controller output exceeded its limit"
    );
    let output = String::from_utf8_lossy(&bytes).into_owned();
    // Diagnostics should identify the failure, never print even these inert
    // credentials. Do not include raw child output in assertion messages.
    assert!(!output.contains(SERVICE_KEY));
    assert!(!output.contains(SERVICE_PASSWORD));
    assert!(!output.contains(USER_TOKEN_SECRET));
    assert!(!output.contains(CREDENTIAL_ENCRYPTION_KEY));
    StartupExit { status, output }
}

fn assert_normal_error(result: &StartupExit, diagnostic: &str) {
    assert_eq!(
        result.status.code(),
        Some(1),
        "startup must return a normal configuration error, not panic or signal"
    );
    assert!(
        result.output.contains(diagnostic),
        "expected startup diagnostic"
    );
    assert!(!result.output.contains("panicked at"));
    assert!(!result.output.contains("Cannot drop a runtime"));
}

fn jwks_fixture(server: &MockServer) -> Mock<'_> {
    server.mock(|when, then| {
        when.method(GET).path(JWKS_PATH);
        // Exercise the normal bounded JWKS fetch and documented HMAC fallback.
        then.status(200).json_body(json!({ "keys": [] }));
    })
}

#[test]
fn startup_bootstraps_an_existing_service_user_inside_tokio() {
    let server = MockServer::start();
    let jwks = jwks_fixture(&server);
    let lookup = server.mock(|when, then| {
        when.method(GET)
            .path(ADMIN_PATH)
            .query_param("email", SERVICE_EMAIL)
            .header("apikey", SERVICE_KEY)
            .header("authorization", format!("Bearer {SERVICE_KEY}"));
        then.status(200)
            .json_body(json!({ "users": [{ "id": SERVICE_ID }] }));
    });
    let create = server.mock(|when, then| {
        when.method(POST).path(ADMIN_PATH);
        then.status(500);
    });
    let result = run_controller(&server, |command| {
        command.env(
            "SERVICE_RUNTIME_USER_EMAIL",
            "  CONTROLLER-STARTUP@EXAMPLE.TEST  ",
        );
    });
    assert_normal_error(&result, "failed to parse DATABASE_URL");
    assert!(result
        .output
        .contains("bootstrapped SERVICE_RUNTIME_USER_ID via Supabase admin API"));
    assert!(result.output.contains(SERVICE_ID));
    jwks.assert_hits(1);
    lookup.assert_hits(1);
    create.assert_hits(0);
}

#[test]
fn startup_creates_a_missing_service_user_inside_tokio() {
    let server = MockServer::start();
    let jwks = jwks_fixture(&server);
    let lookup = server.mock(|when, then| {
        when.method(GET)
            .path(ADMIN_PATH)
            .query_param("email", SERVICE_EMAIL);
        then.status(200).json_body(json!({ "users": [] }));
    });
    let create = server.mock(|when, then| {
        when.method(POST)
            .path(ADMIN_PATH)
            .header("apikey", SERVICE_KEY)
            .header("authorization", format!("Bearer {SERVICE_KEY}"))
            .json_body(json!({ "email": SERVICE_EMAIL, "password": SERVICE_PASSWORD, "email_confirm": true }));
        then.status(201).json_body(json!({ "id": SERVICE_ID }));
    });
    let result = run_controller(&server, |command| {
        command.env(
            "SERVICE_RUNTIME_USER_PASSWORD",
            format!("  {SERVICE_PASSWORD}  "),
        );
    });
    assert_normal_error(&result, "failed to parse DATABASE_URL");
    assert!(result
        .output
        .contains("bootstrapped SERVICE_RUNTIME_USER_ID via Supabase admin API"));
    assert!(result.output.contains(SERVICE_ID));
    jwks.assert_hits(1);
    lookup.assert_hits(1);
    create.assert_hits(1);
}

#[test]
fn startup_explicit_uuid_and_base64_id_never_call_the_admin_api() {
    let server = MockServer::start();
    let jwks = jwks_fixture(&server);
    let admin = server.mock(|when, then| {
        when.path(ADMIN_PATH);
        then.status(500);
    });
    for configured in [SERVICE_ID.to_string(), BASE64.encode(SERVICE_ID)] {
        let result = run_controller(&server, |command| {
            command.env("SERVICE_RUNTIME_USER_ID", format!("  {configured}  "));
        });
        assert_normal_error(&result, "failed to parse DATABASE_URL");
        assert!(!result
            .output
            .contains("bootstrapped SERVICE_RUNTIME_USER_ID"));
        assert!(!result
            .output
            .contains("failed to bootstrap SERVICE_RUNTIME_USER_ID"));
    }
    jwks.assert_hits(2);
    admin.assert_hits(0);
}

#[test]
fn startup_without_a_service_key_preserves_the_no_admin_fallback() {
    let server = MockServer::start();
    let jwks = jwks_fixture(&server);
    let admin = server.mock(|when, then| {
        when.path(ADMIN_PATH);
        then.status(500);
    });
    let result = run_controller(&server, |command| {
        command.env_remove("SUPABASE_SERVICE_ROLE_KEY");
    });
    assert_normal_error(&result, "failed to parse DATABASE_URL");
    assert!(result
        .output
        .contains("SUPABASE_SERVICE_ROLE_KEY is unavailable"));
    jwks.assert_hits(1);
    admin.assert_hits(0);
}

#[test]
fn startup_admin_failure_remains_a_warning_not_a_panic() {
    let server = MockServer::start();
    let jwks = jwks_fixture(&server);
    let lookup = server.mock(|when, then| {
        when.method(GET).path(ADMIN_PATH);
        then.status(503)
            .json_body(json!({ "error": "inert fixture failure" }));
    });
    let create = server.mock(|when, then| {
        when.method(POST).path(ADMIN_PATH);
        then.status(503)
            .json_body(json!({ "error": "inert fixture failure" }));
    });
    let result = run_controller(&server, |_| {});
    assert_normal_error(&result, "failed to parse DATABASE_URL");
    assert!(result
        .output
        .contains("failed to bootstrap SERVICE_RUNTIME_USER_ID via Supabase admin API"));
    jwks.assert_hits(1);
    lookup.assert_hits(1);
    create.assert_hits(1);
}

#[test]
fn startup_retries_lookup_after_a_duplicate_create_response() {
    let server = MockServer::start();
    let jwks = jwks_fixture(&server);
    let lookup = server.mock(|when, then| {
        when.method(GET)
            .path(ADMIN_PATH)
            .query_param("email", SERVICE_EMAIL);
        then.status(200).json_body(json!({ "users": [] }));
    });
    let create = server.mock(|when, then| {
        when.method(POST).path(ADMIN_PATH);
        then.status(422)
            .json_body(json!({ "code": "email_exists" }));
    });
    let result = run_controller(&server, |_| {});
    assert_normal_error(&result, "failed to parse DATABASE_URL");
    assert!(result
        .output
        .contains("failed to bootstrap SERVICE_RUNTIME_USER_ID via Supabase admin API"));
    jwks.assert_hits(1);
    lookup.assert_hits(2);
    create.assert_hits(1);
}

#[test]
fn startup_propagates_configuration_errors_before_network_io() {
    let server = MockServer::start();
    let requests = server.mock(|_when, then| {
        then.status(500);
    });
    let result = run_controller(&server, |command| {
        command.env_remove("DATABASE_URL");
    });
    assert_normal_error(&result, "DATABASE_URL must be set");
    requests.assert_hits(0);
}

#[test]
fn startup_refuses_a_missing_published_or_short_signing_secret_before_network_io() {
    // USER_TOKEN_SECRET signs controller session tokens. The published
    // development fallback let anyone who could reach a controller mint a
    // session as any user, so outside DEV_MODE startup must stop here.
    let server = MockServer::start();
    let requests = server.mock(|_when, then| {
        then.status(500);
    });
    let short = "inert-but-short-secret";
    for configured in [None, Some(""), Some("dev-user-token-secret"), Some(short)] {
        let result = run_controller(&server, |command| match configured {
            Some(value) => {
                command.env("USER_TOKEN_SECRET", value);
            }
            None => {
                command.env_remove("USER_TOKEN_SECRET");
            }
        });
        assert_normal_error(&result, "USER_TOKEN_SECRET");
        assert!(!result.output.contains(short));
    }
    requests.assert_hits(0);
}

#[test]
fn startup_refuses_a_missing_credential_encryption_key_before_network_io() {
    // Deriving the key from USER_TOKEN_SECRET made rotating the signing secret
    // silently strand every stored credential.
    let server = MockServer::start();
    let requests = server.mock(|_when, then| {
        then.status(500);
    });
    for configured in [None, Some("  ")] {
        let result = run_controller(&server, |command| match configured {
            Some(value) => {
                command.env("CREDENTIAL_ENCRYPTION_KEY", value);
            }
            None => {
                command.env_remove("CREDENTIAL_ENCRYPTION_KEY");
            }
        });
        assert_normal_error(
            &result,
            "CREDENTIAL_ENCRYPTION_KEY must be set outside DEV_MODE",
        );
    }
    requests.assert_hits(0);
}

#[test]
fn startup_in_dev_mode_keeps_the_development_fallbacks() {
    let server = MockServer::start();
    let jwks = jwks_fixture(&server);
    let result = run_controller(&server, |command| {
        command
            .env("DEV_MODE", "1")
            .env("SERVICE_RUNTIME_USER_ID", SERVICE_ID)
            .env_remove("USER_TOKEN_SECRET")
            .env_remove("CREDENTIAL_ENCRYPTION_KEY");
    });
    // Configuration completed: startup got as far as the database.
    assert_normal_error(&result, "failed to parse DATABASE_URL");
    assert!(result
        .output
        .contains("USER_TOKEN_SECRET is unset, so session tokens are signed with the published"));
    jwks.assert_hits(1);
}

#[test]
fn startup_refuses_the_signing_fallback_when_dev_mode_is_not_enabled() {
    // DEV_MODE unlocks the published signing fallback, so only an explicit
    // enabling value may select it. Setting the variable to a disabling,
    // empty or unrecognised value is production configuration.
    let server = MockServer::start();
    let requests = server.mock(|_when, then| {
        then.status(500);
    });
    for value in ["false", "0", "off", "", "prod"] {
        let result = run_controller(&server, |command| {
            command
                .env("DEV_MODE", value)
                .env_remove("USER_TOKEN_SECRET");
        });
        assert_normal_error(&result, "USER_TOKEN_SECRET must be set outside DEV_MODE");
        assert!(!result.output.contains(
            "USER_TOKEN_SECRET is unset, so session tokens are signed with the published"
        ));
    }
    requests.assert_hits(0);
}

#[test]
fn startup_warns_while_stored_credentials_use_the_published_derived_key() {
    // Controllers that ran without either variable encrypted credentials under
    // a key anyone can derive. It stays accepted so those rows remain readable
    // until they are re-encrypted, but every boot says so. The controller
    // recognises that key by its one-way id; only this test derives the key,
    // because configuring it is the one way to see the operator's warning.
    use sha2::{Digest, Sha256};
    let published = Sha256::new()
        .chain_update(b"instafy:credential-encryption-key:v1:")
        .chain_update(b"dev-user-token-secret")
        .finalize();
    let server = MockServer::start();
    let jwks = jwks_fixture(&server);
    let result = run_controller(&server, |command| {
        command
            .env("SERVICE_RUNTIME_USER_ID", SERVICE_ID)
            .env("CREDENTIAL_ENCRYPTION_KEY", BASE64.encode(published));
    });
    assert_normal_error(&result, "failed to parse DATABASE_URL");
    assert!(result
        .output
        .contains("CREDENTIAL_ENCRYPTION_KEY is the key derived from the published development"));
    jwks.assert_hits(1);
}

#[test]
fn startup_refuses_invalid_previous_credential_keys_before_network_io() {
    // A decrypt-only key that does not parse, or a "previous" key that is
    // still the primary, is a rotation that would silently not happen.
    let server = MockServer::start();
    let requests = server.mock(|_when, then| {
        then.status(500);
    });
    let valid = BASE64.encode([0x5au8; 32]);
    let short = BASE64.encode([0x5bu8; 16]);
    for (configured, diagnostic) in [
        (
            format!("{valid},{short}"),
            "CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS entry 2 must be a base64-encoded 32-byte key",
        ),
        (
            "not*a*key".to_string(),
            "CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS entry 1 must be a base64-encoded 32-byte key",
        ),
        (
            CREDENTIAL_ENCRYPTION_KEY.to_string(),
            "previous credential encryption key 1 is the primary key",
        ),
        (
            format!("{valid},{valid}"),
            "previous credential encryption keys 1 and 2 are the same key",
        ),
    ] {
        let result = run_controller(&server, |command| {
            command.env("CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS", &configured);
        });
        assert_normal_error(&result, diagnostic);
        assert!(!result.output.contains(&valid));
        assert!(!result.output.contains(&short));
        assert!(!result.output.contains("not*a*key"));
    }
    requests.assert_hits(0);
}

#[test]
fn startup_accepts_previous_credential_keys_without_echoing_them() {
    // The rotation state: a fresh primary key and retired keys kept for
    // decryption until the re-encryption pass has moved every row. Random
    // keys, generated here: neither is the published development key.
    let server = MockServer::start();
    let jwks = jwks_fixture(&server);
    let retired = BASE64.encode(rand::random::<[u8; 32]>());
    let older = BASE64.encode(rand::random::<[u8; 32]>());
    let result = run_controller(&server, |command| {
        command.env("SERVICE_RUNTIME_USER_ID", SERVICE_ID).env(
            "CREDENTIAL_ENCRYPTION_PREVIOUS_KEYS",
            format!(" {retired} , {older} ,"),
        );
    });
    // Configuration completed: startup got as far as the database.
    assert_normal_error(&result, "failed to parse DATABASE_URL");
    assert!(result
        .output
        .contains("credential encryption previous keys configured for decryption only"));
    assert!(!result.output.contains("derived from the published"));
    assert!(!result.output.contains(&retired));
    assert!(!result.output.contains(&older));
    jwks.assert_hits(1);
}

#[test]
fn startup_refuses_an_unvalidated_jwks_url_before_network_io() {
    // The JWKS decides which access tokens are accepted: it must come from
    // the Supabase project's own https endpoint (or loopback in development).
    let server = MockServer::start();
    let requests = server.mock(|_when, then| {
        then.status(500);
    });
    let secret = "inert-jwks-url-credential";
    let project_port = server.port();
    for (configured, diagnostic) in [
        (
            "https://169.254.169.254/auth/v1/.well-known/jwks.json".to_string(),
            "SUPABASE_JWKS_URL must be on the host and port of the Supabase project URL",
        ),
        (
            "http://jwks.example.test/auth/v1/.well-known/jwks.json".to_string(),
            "SUPABASE_JWKS_URL must use https",
        ),
        (
            format!("http://127.0.0.1:{project_port}/auth/v1/other.json"),
            "SUPABASE_JWKS_URL must be the Supabase JWKS endpoint",
        ),
        (
            format!("http://user:{secret}@127.0.0.1:{project_port}{JWKS_PATH}"),
            "SUPABASE_JWKS_URL must not contain credentials",
        ),
        (
            format!("http://127.0.0.1:{project_port}{JWKS_PATH}?apikey={secret}"),
            "SUPABASE_JWKS_URL must not have a query string or fragment",
        ),
    ] {
        let result = run_controller(&server, |command| {
            command.env("SUPABASE_JWKS_URL", &configured);
        });
        assert_normal_error(&result, diagnostic);
        assert!(!result.output.contains(secret));
    }
    requests.assert_hits(0);
}

#[test]
fn startup_fetches_a_jwks_url_on_the_project_host() {
    let server = MockServer::start();
    let jwks = jwks_fixture(&server);
    let result = run_controller(&server, |command| {
        command
            .env("SERVICE_RUNTIME_USER_ID", SERVICE_ID)
            .env("SUPABASE_JWKS_URL", server.url(JWKS_PATH));
    });
    assert_normal_error(&result, "failed to parse DATABASE_URL");
    jwks.assert_hits(1);
}

#[test]
fn startup_reads_the_jwks_other_host_opt_in_from_the_environment() {
    // The key set may come from another host only when the operator opts in
    // through SUPABASE_JWKS_URL_ALLOW_OTHER_HOST. Another port on the same
    // address counts as another host.
    let project = MockServer::start();
    let project_requests = project.mock(|_when, then| {
        then.status(500);
    });
    let other = MockServer::start();
    let other_jwks = jwks_fixture(&other);
    let run = |opt_in: Option<&str>| {
        run_controller(&project, |command| {
            command
                .env("SERVICE_RUNTIME_USER_ID", SERVICE_ID)
                .env("SUPABASE_JWKS_URL", other.url(JWKS_PATH));
            if let Some(value) = opt_in {
                command.env("SUPABASE_JWKS_URL_ALLOW_OTHER_HOST", value);
            }
        })
    };
    for refused in [None, Some("0"), Some("off"), Some("")] {
        let result = run(refused);
        assert_normal_error(
            &result,
            "SUPABASE_JWKS_URL must be on the host and port of the Supabase project URL",
        );
    }
    other_jwks.assert_hits(0);
    for (runs, accepted) in ["1", " Yes "].into_iter().enumerate() {
        let result = run(Some(accepted));
        // Configuration completed: startup got as far as the database.
        assert_normal_error(&result, "failed to parse DATABASE_URL");
        other_jwks.assert_hits(runs + 1);
    }
    project_requests.assert_hits(0);
}

#[test]
fn startup_jwks_load_does_not_follow_redirects() {
    // A redirect would take the key set from a URL that was never validated.
    let server = MockServer::start();
    let redirect = server.mock(|when, then| {
        when.method(GET).path(JWKS_PATH);
        then.status(307)
            .header("location", server.url("/elsewhere/jwks.json"));
    });
    let target = server.mock(|when, then| {
        when.path("/elsewhere/jwks.json");
        then.status(200).json_body(json!({ "keys": [] }));
    });
    let result = run_controller(&server, |command| {
        command.env("SERVICE_RUNTIME_USER_ID", SERVICE_ID);
    });
    // The documented HS256 fallback takes over, as for any failed load.
    assert_normal_error(&result, "failed to parse DATABASE_URL");
    assert!(result.output.contains("status=307"));
    redirect.assert_hits(1);
    target.assert_hits(0);
}
