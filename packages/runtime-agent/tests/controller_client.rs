use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::http::HeaderMap;
use axum::{Json, Router, extract::State, http::StatusCode, routing::get, routing::post};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use chrono::{Duration as ChronoDuration, Utc};
use jsonwebtoken::{EncodingKey, Header as JwtHeader};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use runtime_agent::config::{Config, OriginSettings};
use runtime_agent::controller::ControllerClient;
use runtime_agent::tunnels::request_tunnel_assignment;
use runtime_contracts::{AccessTokenClaims, ProxyEnvelopePayload};
use serde_json::Value;
use std::sync::OnceLock;
use tokio::net::TcpListener;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

#[derive(Clone, Debug)]
struct RecordedRequest {
    headers: Vec<(String, String)>,
    body: Value,
}

impl RecordedRequest {
    fn new(headers: &HeaderMap, body: Value) -> Self {
        let headers = headers
            .iter()
            .map(|(name, value)| {
                let value = value.to_str().unwrap_or_default().to_string();
                (name.to_string(), value)
            })
            .collect();
        Self { headers, body }
    }
}

#[derive(Default)]
struct ReceivedRequests {
    register: Vec<RecordedRequest>,
    login: Vec<RecordedRequest>,
    lease: Vec<RecordedRequest>,
    heartbeat: Vec<RecordedRequest>,
    tunnel: Vec<RecordedRequest>,
    secrets: Vec<RecordedRequest>,
}

type Shared = Arc<Mutex<ReceivedRequests>>;

#[derive(Clone)]
struct ControllerState {
    requests: Shared,
    private_key_pem: Arc<String>,
    jwks_body: Arc<Value>,
    key_id: String,
    project_id: Uuid,
    /// When set, `/runtime/register` rejects any other bearer with the
    /// production-observed 401 body, so tests can exercise the stale-token
    /// recovery path.
    register_requires_bearer: Option<String>,
}

async fn agent_login_handler(
    State(state): State<ControllerState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> (StatusCode, Json<Value>) {
    state
        .requests
        .lock()
        .unwrap()
        .login
        .push(RecordedRequest::new(&headers, payload));

    let runtime_id = Uuid::new_v4();
    let issued_at = Utc::now();
    let expires_at = issued_at + ChronoDuration::seconds(600);
    let scopes: Vec<String> = REQUIRED_AGENT_SCOPES
        .iter()
        .map(|s| s.to_string())
        .collect();

    let claims = AccessTokenClaims {
        aud: runtime_id.to_string(),
        sub: format!("agent:{}", state.project_id),
        project_id: state.project_id.to_string(),
        origin_id: None,
        runtime_id: Some(runtime_id.to_string()),
        protocol: None,
        scopes: scopes.clone(),
        lease_id: None,
        runtime_generation: None,
        run_id: None,
        iat: issued_at.timestamp(),
        exp: expires_at.timestamp(),
        jti: Uuid::new_v4().to_string(),
        prefer_runtime: None,
        actor_label: None,
        browser_session_id: None,
    };

    let mut header = JwtHeader::new(jsonwebtoken::Algorithm::EdDSA);
    header.kid = Some(state.key_id.clone());
    let encoding_key =
        EncodingKey::from_ed_pem(state.private_key_pem.as_bytes()).expect("encoding key from pem");
    let agent_token =
        jsonwebtoken::encode(&header, &claims, &encoding_key).expect("encode agent token");

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "runtime_id": runtime_id,
            "agent_token": agent_token,
            "agent_token_scopes": scopes,
            "agent_token_issued_at": issued_at.to_rfc3339(),
            "agent_token_expires_at": expires_at.to_rfc3339(),
            "agent_token_ttl": 600,
            "lease_url": "/agent/lease",
            "heartbeat_url": "/agent/heartbeat",
            "stop_url": "/agent/stop",
            "proxy": {
                "url": "https://proxy.example.com",
                "token": "proxy-token",
                "expires_at": "2025-01-01T00:00:00Z"
            }
        })),
    )
}

async fn runtime_register_handler(
    State(state): State<ControllerState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> (StatusCode, Json<Value>) {
    state
        .requests
        .lock()
        .unwrap()
        .register
        .push(RecordedRequest::new(&headers, payload));

    if let Some(required) = state.register_requires_bearer.as_deref() {
        let expected = format!("Bearer {required}");
        let presented = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok());
        if presented != Some(expected.as_str()) {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"message": "access token expired"})),
            );
        }
    }

    let runtime_id = Uuid::new_v4();
    let issued_at = Utc::now();
    let expires_at = issued_at + ChronoDuration::seconds(600);
    let scopes: Vec<String> = REQUIRED_AGENT_SCOPES
        .iter()
        .map(|s| s.to_string())
        .collect();

    let claims = AccessTokenClaims {
        aud: runtime_id.to_string(),
        sub: format!("agent:{}", state.project_id),
        project_id: state.project_id.to_string(),
        origin_id: None,
        runtime_id: Some(runtime_id.to_string()),
        protocol: None,
        scopes: scopes.clone(),
        lease_id: None,
        runtime_generation: None,
        run_id: None,
        iat: issued_at.timestamp(),
        exp: expires_at.timestamp(),
        jti: Uuid::new_v4().to_string(),
        prefer_runtime: None,
        actor_label: None,
        browser_session_id: None,
    };

    let mut header = JwtHeader::new(jsonwebtoken::Algorithm::EdDSA);
    header.kid = Some(state.key_id.clone());
    let encoding_key =
        EncodingKey::from_ed_pem(state.private_key_pem.as_bytes()).expect("encoding key from pem");
    let agent_token =
        jsonwebtoken::encode(&header, &claims, &encoding_key).expect("encode agent token");

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "runtime_id": runtime_id,
            "agent_token": agent_token,
            "agent_token_scopes": scopes,
            "agent_token_issued_at": issued_at.to_rfc3339(),
            "agent_token_expires_at": expires_at.to_rfc3339(),
            "agent_token_ttl": 600,
            "runtime_token": "fresh-runtime-token",
            "lease_url": "/agent/lease",
            "heartbeat_url": "/agent/heartbeat",
            "stop_url": "/agent/stop",
            "leaseId": Uuid::new_v4()
        })),
    )
}

async fn lease_handler(
    State(state): State<ControllerState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> (StatusCode, Json<Value>) {
    state
        .requests
        .lock()
        .unwrap()
        .lease
        .push(RecordedRequest::new(&headers, payload));
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "jobs": [{
                "id": Uuid::new_v4(),
                "intent": "apply",
                "project_id": Uuid::new_v4(),
                "run_id": Uuid::new_v4(),
                "payload": {
                    "prompt_text": "Build a homepage"
                },
                "proxy": {
                    "url": "https://proxy.example.com",
                    "token": "proxy-token",
                    "expires_at": "2025-01-01T00:00:00Z"
                },
                "workspace_token": "workspace-token",
                "workspace_token_scopes": [
                    "workspace.lease.write",
                    "origin.token.mint"
                ],
                "workspace_token_expires_at": "2025-01-01T00:10:00Z"
            }]
        })),
    )
}

async fn heartbeat_handler(
    State(state): State<ControllerState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> StatusCode {
    state
        .requests
        .lock()
        .unwrap()
        .heartbeat
        .push(RecordedRequest::new(&headers, payload));
    StatusCode::OK
}

async fn tunnel_request_handler(
    State(state): State<ControllerState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> (StatusCode, Json<Value>) {
    state
        .requests
        .lock()
        .unwrap()
        .tunnel
        .push(RecordedRequest::new(&headers, payload));

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "id": Uuid::new_v4().to_string(),
            "projectId": state.project_id.to_string(),
            "runtimeId": Uuid::new_v4().to_string(),
            "runtimeLeaseId": Uuid::new_v4().to_string(),
            "provider": "rathole",
            "tunnelId": "test-tunnel",
            "hostname": "test-tunnel.example.invalid",
            "url": "https://test-tunnel.example.invalid",
            "status": "issued",
            "expiresAt": (Utc::now() + ChronoDuration::minutes(5)).to_rfc3339(),
            "credentials": {
                "server": "127.0.0.1:2333",
                "token": "tunnel-secret"
            }
        })),
    )
}

async fn agent_secrets_handler(
    State(state): State<ControllerState>,
    headers: HeaderMap,
    Json(payload): Json<Value>,
) -> Json<Value> {
    state
        .requests
        .lock()
        .unwrap()
        .secrets
        .push(RecordedRequest::new(&headers, payload));
    Json(serde_json::json!({ "env": {}, "inventory": [] }))
}

async fn jwks_handler(State(state): State<ControllerState>) -> Json<Value> {
    Json((*state.jwks_body).clone())
}

async fn spawn_controller(state: ControllerState) -> SocketAddr {
    let router = Router::new()
        .route("/runtime/register", post(runtime_register_handler))
        .route("/agent/login", post(agent_login_handler))
        .route("/agent/lease", post(lease_handler))
        .route("/agent/heartbeat", post(heartbeat_handler))
        .route("/agent/secrets", post(agent_secrets_handler))
        .route(
            "/projects/:project_id/tunnels/request",
            post(tunnel_request_handler),
        )
        .route("/.well-known/jwks.json", get(jwks_handler))
        .with_state(state);

    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock controller");
    let addr = listener.local_addr().expect("local addr");

    tokio::spawn(async move {
        axum::serve(listener, router)
            .await
            .expect("serve controller");
    });

    addr
}

fn test_config(addr: SocketAddr, project_id: Uuid, workspace_root: &Path) -> Config {
    Config {
        controller_base_url: format!("http://{}", addr).parse().expect("parse base url"),
        controller_jwks_url: format!("http://{}/.well-known/jwks.json", addr)
            .parse()
            .expect("parse jwks url"),
        project_id,
        runtime_id: None,
        runtime_lease_id: None,
        provider: "test-runtime".into(),
        runtime_version: "0.0.1".into(),
        capabilities: serde_json::json!({"fs": true}),
        metadata: serde_json::json!({"test": true}),
        lease_scope: None,
        workspace_manifest: None,
        tenant_projects: Vec::new(),
        parent_lease_id: None,
        poll_interval: Duration::from_millis(10),
        lease_max_jobs: 3,
        lease_seconds: 120,
        heartbeat_seconds: 60,
        runtime_access_token: Some("test-runtime-token".into()),
        workspace_root: workspace_root.to_path_buf(),
        project_workspace_override: None,
        strict_mode: false,
        dev_isolation_mode: true,
        display_name: None,
        origin: None,
        codex_bin: None,
        require_codex_bin: false,
        parent_dispositions_runtime_on_shutdown: false,
    }
}

#[tokio::test]
async fn controller_client_registers_and_leases() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env())
        .try_init();

    let shared = Arc::new(Mutex::new(ReceivedRequests::default()));
    let project_id = Uuid::new_v4();
    let key_id = "test-agent-key".to_string();
    let jwks = build_jwks(test_origin_public_key(), &key_id);
    let state = ControllerState {
        requests: shared.clone(),
        private_key_pem: Arc::new(test_origin_private_key().to_string()),
        jwks_body: Arc::new(jwks),
        key_id,
        project_id,
        register_requires_bearer: None,
    };
    let addr = spawn_controller(state).await;

    let workspace_root = tempfile::tempdir().expect("temp workspace root");
    let config = test_config(addr, project_id, workspace_root.path());

    let client = ControllerClient::new(&config).expect("client init");
    let registration = client
        .register_runtime(&config)
        .await
        .expect("register runtime");

    assert!(
        registration
            .agent_token_scopes
            .iter()
            .all(|scope| { REQUIRED_AGENT_SCOPES.contains(&scope.as_str()) })
    );
    assert_eq!(
        registration.runtime_token.as_deref(),
        Some("fresh-runtime-token")
    );

    let jobs = client.lease_once(&registration).await.expect("lease once");
    assert_eq!(jobs.len(), 1);
    let job = &jobs[0];
    assert_eq!(job.intent.as_deref(), Some("apply"));
    assert_eq!(
        job.payload["prompt_text"].as_str(),
        Some("Build a homepage")
    );
    assert!(job.project_id.is_some());
    assert!(job.run_id.is_some());
    assert_eq!(
        job.proxy,
        Some(ProxyEnvelopePayload {
            url: "https://proxy.example.com".into(),
            token: "proxy-token".into(),
            expires_at: Some("2025-01-01T00:00:00Z".into()),
        })
    );
    assert_eq!(job.workspace_token.as_deref(), Some("workspace-token"));
    assert_eq!(
        job.workspace_token_scopes,
        Some(vec![
            "workspace.lease.write".to_string(),
            "origin.token.mint".to_string(),
        ])
    );
    assert_eq!(
        job.workspace_token_expires_at.as_deref(),
        Some("2025-01-01T00:10:00Z")
    );

    client
        .heartbeat(&registration, jobs[0].id)
        .await
        .expect("heartbeat");

    tokio::time::sleep(Duration::from_millis(50)).await;

    let captured = shared.lock().unwrap();
    assert_eq!(captured.register.len(), 1);
    assert_eq!(captured.lease.len(), 1);
    assert_eq!(captured.heartbeat.len(), 1);

    let register_request = &captured.register[0];
    assert_eq!(
        register_request.body["projectId"].as_str(),
        Some(project_id.to_string().as_str())
    );
    assert_eq!(
        register_request.body["provider"].as_str(),
        Some("test-runtime")
    );
    assert_eq!(register_request.body["version"].as_str(), Some("0.0.1"));
    assert_eq!(
        register_request.body["capabilities"],
        serde_json::json!({"fs": true})
    );
    assert_eq!(
        register_request.body["metadata"],
        serde_json::json!({"test": true})
    );

    let lease_request = &captured.lease[0];
    assert!(
        lease_request
            .headers
            .iter()
            .any(|(name, value)| name.eq_ignore_ascii_case("authorization")
                && value.starts_with("Bearer "))
    );
    assert_eq!(
        lease_request.body["runtime_id"].as_str(),
        Some(registration.runtime_id.to_string().as_str())
    );
    assert_eq!(
        lease_request.body["max"].as_u64(),
        Some(config.lease_max_jobs as u64)
    );
    assert_eq!(
        lease_request.body["lease_seconds"].as_u64(),
        Some(config.lease_seconds as u64)
    );
    assert_eq!(
        lease_request.body["supports_workspace_token"].as_bool(),
        Some(true)
    );

    let heartbeat_request = &captured.heartbeat[0];
    assert_eq!(
        heartbeat_request.body["job_id"].as_str(),
        Some(jobs[0].id.to_string().as_str())
    );
}

#[tokio::test]
async fn renewal_register_presents_the_renewed_runtime_token() {
    let shared = Arc::new(Mutex::new(ReceivedRequests::default()));
    let project_id = Uuid::new_v4();
    let key_id = "test-agent-key".to_string();
    let jwks = build_jwks(test_origin_public_key(), &key_id);
    let state = ControllerState {
        requests: shared.clone(),
        private_key_pem: Arc::new(test_origin_private_key().to_string()),
        jwks_body: Arc::new(jwks),
        key_id,
        project_id,
        register_requires_bearer: None,
    };
    let addr = spawn_controller(state).await;
    let workspace_root = tempfile::tempdir().expect("temp workspace root");
    let config = test_config(addr, project_id, workspace_root.path());

    let client = ControllerClient::new(&config).expect("client init");
    let initial = client
        .register_runtime(&config)
        .await
        .expect("initial register");
    // The renewal scheduler needs to know when the agent token lapses.
    let expires_at = initial
        .agent_token_expires_at
        .as_deref()
        .expect("register surfaces agent token expiry");
    let expires_at = chrono::DateTime::parse_from_rfc3339(expires_at).expect("rfc3339 expiry");
    assert!(expires_at > Utc::now());

    // A proactive renewal re-registers with the same client: it must carry the
    // runtime token minted by the previous register, not the bootstrap token.
    client
        .register_runtime(&config)
        .await
        .expect("renewal register");

    let captured = shared.lock().unwrap();
    assert_eq!(captured.register.len(), 2);
    let bearer = |request: &RecordedRequest| {
        request
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .map(|(_, value)| value.clone())
    };
    assert_eq!(
        bearer(&captured.register[0]).as_deref(),
        Some("Bearer test-runtime-token")
    );
    assert_eq!(
        bearer(&captured.register[1]).as_deref(),
        Some("Bearer fresh-runtime-token")
    );
}

/// Reproduces instafy-dev/instafy#104: the agent keeps presenting a stale
/// spawn-time token after another process rotated the shared CLI session.
/// Registration must self-heal by re-reading the persisted session, and keep
/// the plain retry behavior when the file token is no better. The scenarios
/// share one test because they contend on the INSTAFY_CLI_CONFIG env var.
#[tokio::test]
async fn register_recovers_by_rereading_the_persisted_cli_session() {
    let shared = Arc::new(Mutex::new(ReceivedRequests::default()));
    let project_id = Uuid::new_v4();
    let key_id = "test-agent-key".to_string();
    let jwks = build_jwks(test_origin_public_key(), &key_id);
    let state = ControllerState {
        requests: shared.clone(),
        private_key_pem: Arc::new(test_origin_private_key().to_string()),
        jwks_body: Arc::new(jwks),
        key_id,
        project_id,
        register_requires_bearer: Some("rotated-session-token".to_string()),
    };
    let addr = spawn_controller(state).await;

    let session_dir = tempfile::tempdir().expect("session dir");
    let session_path = session_dir.path().join("config.json");
    std::fs::write(
        &session_path,
        r#"{"accessToken":"rotated-session-token","refreshToken":"rotated-refresh-token"}"#,
    )
    .expect("write session fixture");
    unsafe { std::env::set_var("INSTAFY_CLI_CONFIG", &session_path) };

    let workspace_root = tempfile::tempdir().expect("temp workspace root");

    // Scenario 1: the spawn-time token is expired but the persisted session
    // holds a rotated, valid token — registration recovers without a restart.
    let mut config = test_config(addr, project_id, workspace_root.path());
    config.runtime_access_token = Some("expired-user-token".into());
    let client = ControllerClient::new(&config).expect("client init");
    let registration = client
        .register_runtime(&config)
        .await
        .expect("register recovers with the re-read session token");
    assert_eq!(
        registration.runtime_token.as_deref(),
        Some("fresh-runtime-token")
    );

    // Scenario 2: the persisted token is also expired — the error surfaces so
    // the existing registration retry loop keeps its cadence.
    std::fs::write(&session_path, r#"{"accessToken":"still-stale-token"}"#)
        .expect("rewrite session fixture");
    let mut config = test_config(addr, project_id, workspace_root.path());
    config.runtime_access_token = Some("expired-user-token-2".into());
    let client = ControllerClient::new(&config).expect("client init");
    let error = client
        .register_runtime(&config)
        .await
        .expect_err("register still fails when the file token is stale too");
    assert!(
        format!("{error:#}").contains("access token expired"),
        "unexpected error: {error:#}"
    );

    // Scenario 3: the persisted token matches the one already rejected — no
    // pointless extra register call is made.
    std::fs::write(&session_path, r#"{"accessToken":"expired-user-token-3"}"#)
        .expect("rewrite session fixture");
    let mut config = test_config(addr, project_id, workspace_root.path());
    config.runtime_access_token = Some("expired-user-token-3".into());
    let client = ControllerClient::new(&config).expect("client init");
    client
        .register_runtime(&config)
        .await
        .expect_err("register fails without retrying an already-rejected token");

    unsafe { std::env::remove_var("INSTAFY_CLI_CONFIG") };

    let captured = shared.lock().unwrap();
    let bearer = |request: &RecordedRequest| {
        request
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .map(|(_, value)| value.clone())
    };
    let bearers: Vec<Option<String>> = captured.register.iter().map(bearer).collect();
    assert_eq!(
        bearers,
        vec![
            // Scenario 1: stale spawn-time token, then the re-read session token.
            Some("Bearer expired-user-token".to_string()),
            Some("Bearer rotated-session-token".to_string()),
            // Scenario 2: stale spawn-time token, then the (also stale) file token.
            Some("Bearer expired-user-token-2".to_string()),
            Some("Bearer still-stale-token".to_string()),
            // Scenario 3: the file token was already tried, so no second call.
            Some("Bearer expired-user-token-3".to_string()),
        ]
    );
}

#[tokio::test]
async fn tunnel_request_prefers_fresh_runtime_token() {
    let shared = Arc::new(Mutex::new(ReceivedRequests::default()));
    let project_id = Uuid::new_v4();
    let key_id = "test-agent-key".to_string();
    let jwks = build_jwks(test_origin_public_key(), &key_id);
    let state = ControllerState {
        requests: shared.clone(),
        private_key_pem: Arc::new(test_origin_private_key().to_string()),
        jwks_body: Arc::new(jwks),
        key_id,
        project_id,
        register_requires_bearer: None,
    };
    let addr = spawn_controller(state).await;
    let workspace_root = tempfile::tempdir().expect("temp workspace root");
    let mut config = test_config(addr, project_id, workspace_root.path());
    config.origin = Some(OriginSettings {
        origin_id: Uuid::new_v4(),
        bind_host: "127.0.0.1".to_string(),
        bind_port: 0,
        git_remote_url: None,
        git_branch: "main".to_string(),
        git_remote_name: "origin".to_string(),
        git_author_name: "Instafy".to_string(),
        git_author_email: "instafy@example.invalid".to_string(),
        rathole_bin: "rathole".to_string(),
        rathole_state_dir: workspace_root.path().join("rathole"),
        rathole_use_subcommands: true,
        tunnel_refresh_margin: Duration::from_secs(60),
        controller_internal_token: Some("expired-origin-token".to_string()),
        skip_auth: false,
        enable_presence_heartbeat: false,
        presence_interval: Duration::from_secs(30),
        jwks_url: config.controller_jwks_url.clone(),
        max_archive_bytes: 1024 * 1024,
        staging_root: None,
        endpoint: None,
        protocols: Vec::new(),
        region: None,
        device_id: None,
        metadata: None,
        mode: "desktop".to_string(),
        tunnel_enabled: true,
        tunnel_provider: None,
        tunnel_hostname: None,
        tunnel_url: None,
        tunnel_id: None,
        tunnel_status: None,
        tunnel_expires_at: None,
        tunnel_last_rotation_at: None,
    });

    let client = ControllerClient::new(&config).expect("client init");
    let registration = client
        .register_runtime(&config)
        .await
        .expect("register runtime");

    request_tunnel_assignment(&config, &registration)
        .await
        .expect("request tunnel assignment")
        .expect("tunnel assignment");

    let captured = shared.lock().unwrap();
    let tunnel_request = captured.tunnel.first().expect("tunnel request recorded");
    assert_eq!(
        tunnel_request
            .headers
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
            .map(|(_, value)| value.as_str()),
        Some("Bearer fresh-runtime-token")
    );
}

struct TestOriginKeyPair {
    private_pem: String,
    public_pem: String,
}

static TEST_ORIGIN_KEY_PAIR: OnceLock<TestOriginKeyPair> = OnceLock::new();

const ED25519_PUBLIC_KEY_SPKI_PREFIX: &[u8] = &[
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

fn test_origin_private_key() -> &'static str {
    &test_origin_key_pair().private_pem
}

fn test_origin_public_key() -> &'static str {
    &test_origin_key_pair().public_pem
}

fn test_origin_key_pair() -> &'static TestOriginKeyPair {
    TEST_ORIGIN_KEY_PAIR.get_or_init(|| {
        let rng = SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).expect("generate test origin keypair");
        let key_pair =
            Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).expect("parse test origin keypair");

        let mut public_der = ED25519_PUBLIC_KEY_SPKI_PREFIX.to_vec();
        public_der.extend_from_slice(key_pair.public_key().as_ref());

        TestOriginKeyPair {
            private_pem: format_pem_block("PRIVATE KEY", pkcs8.as_ref()),
            public_pem: format_pem_block("PUBLIC KEY", &public_der),
        }
    })
}

fn format_pem_block(label: &str, der: &[u8]) -> String {
    let body = STANDARD.encode(der);
    let mut pem = format!("-----BEGIN {label}-----\n");
    for chunk in body.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).expect("base64 chunk utf8"));
        pem.push('\n');
    }
    pem.push_str(&format!("-----END {label}-----"));
    pem
}
const REQUIRED_AGENT_SCOPES: &[&str] = &[
    "agent.lease",
    "agent.heartbeat",
    "agent.message",
    "agent.complete",
    "agent.secrets",
    "agent.stop",
];

fn build_jwks(public_pem: &str, key_id: &str) -> Value {
    let body: String = public_pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    let der = STANDARD
        .decode(body.as_bytes())
        .expect("decode public key body");
    let raw_key = der
        .get(der.len().saturating_sub(32)..)
        .expect("raw key slice");
    let x = URL_SAFE_NO_PAD.encode(raw_key);
    serde_json::json!({
        "keys": [
            {
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "use": "sig",
                "kid": key_id,
                "x": x,
            }
        ]
    })
}

/// Reproduces instafy-dev/instafy#144: per-job tasks clone `Registration` at
/// spawn, so after a proactive renewal the secrets-refresh loop kept
/// presenting the register-time agent token until it expired (401 loop).
/// Requests must resolve their bearer from the client's freshest token.
#[tokio::test]
async fn job_secrets_present_the_renewed_agent_token() {
    let shared = Arc::new(Mutex::new(ReceivedRequests::default()));
    let project_id = Uuid::new_v4();
    let key_id = "test-agent-key".to_string();
    let jwks = build_jwks(test_origin_public_key(), &key_id);
    let state = ControllerState {
        requests: shared.clone(),
        private_key_pem: Arc::new(test_origin_private_key().to_string()),
        jwks_body: Arc::new(jwks),
        key_id,
        project_id,
        register_requires_bearer: None,
    };
    let addr = spawn_controller(state).await;
    let workspace_root = tempfile::tempdir().expect("temp workspace root");
    let config = test_config(addr, project_id, workspace_root.path());

    let client = ControllerClient::new(&config).expect("client init");
    let initial = client
        .register_runtime(&config)
        .await
        .expect("initial register");
    let renewed = client
        .register_runtime(&config)
        .await
        .expect("renewal register");
    assert_ne!(
        initial.agent_token, renewed.agent_token,
        "mock mints a distinct agent token per registration"
    );

    // The stale spawn-time snapshot: what a long-lived SecretsRefreshTask holds.
    client
        .fetch_job_secrets(&initial, Uuid::new_v4(), false)
        .await
        .expect("fetch job secrets");

    let captured = shared.lock().unwrap();
    assert_eq!(captured.secrets.len(), 1);
    let bearer = captured.secrets[0]
        .headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .map(|(_, value)| value.clone());
    assert_eq!(
        bearer.as_deref(),
        Some(format!("Bearer {}", renewed.agent_token).as_str()),
        "secrets refresh must present the renewed agent token, not the spawn-time snapshot"
    );
}
