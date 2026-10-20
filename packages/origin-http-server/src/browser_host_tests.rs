use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::Router;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use futures_util::{SinkExt, StreamExt};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use reqwest::StatusCode;
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message as WsMessage;
use uuid::Uuid;

use super::*;
use crate::auth::TokenValidator;
use crate::browser_collaboration::BrowserCollaborationHub;
use crate::config::ServerConfig;

// ---------------------------------------------------------------------------
// A fake host: what runtime-agent implements, with counters.

struct FakeInner {
    snapshot: BrowserHostSnapshot,
    refusal: Option<BrowserHostRefusal>,
    starter: Option<String>,
    other_seen_recently: bool,
    seen: Vec<String>,
    start_calls: usize,
}

struct FakeHost(Mutex<FakeInner>);

impl FakeHost {
    fn new(state: BrowserHostState) -> Arc<Self> {
        let generation = (state != BrowserHostState::Idle).then(Uuid::new_v4);
        Arc::new(Self(Mutex::new(FakeInner {
            snapshot: BrowserHostSnapshot {
                state,
                generation,
                failure: None,
            },
            refusal: None,
            starter: None,
            other_seen_recently: false,
            seen: Vec::new(),
            start_calls: 0,
        })))
    }

    fn inner(&self) -> std::sync::MutexGuard<'_, FakeInner> {
        self.0.lock().unwrap()
    }

    fn seen_by(&self, subject: &str) -> usize {
        self.inner()
            .seen
            .iter()
            .filter(|seen| *seen == subject)
            .count()
    }

    fn handle(self: &Arc<Self>) -> BrowserHostHandle {
        self.clone()
    }
}

impl BrowserHostControl for FakeHost {
    fn snapshot(&self) -> BrowserHostSnapshot {
        self.inner().snapshot.clone()
    }

    fn caller_facts(&self, subject: &str) -> BrowserHostCallerFacts {
        let inner = self.inner();
        BrowserHostCallerFacts {
            started_by_caller: matches!(
                inner.snapshot.state,
                BrowserHostState::Starting | BrowserHostState::Ready
            ) && inner.starter.as_deref() == Some(subject),
            other_seen_recently: inner.other_seen_recently,
        }
    }

    fn request_start(&self, subject: &str) -> Result<BrowserHostSnapshot, BrowserHostRefusal> {
        let mut inner = self.inner();
        if let Some(refusal) = inner.refusal.clone() {
            return Err(refusal);
        }
        inner.start_calls += 1;
        if matches!(
            inner.snapshot.state,
            BrowserHostState::Idle | BrowserHostState::Failed
        ) {
            inner.snapshot = BrowserHostSnapshot {
                state: BrowserHostState::Starting,
                generation: Some(Uuid::new_v4()),
                failure: None,
            };
            inner.starter = Some(subject.to_string());
        }
        Ok(inner.snapshot.clone())
    }

    fn note_seen(&self, subject: &str) {
        self.inner().seen.push(subject.to_string());
    }
}

// ---------------------------------------------------------------------------
// Origin state and signed tokens.

fn config(
    project_id: Uuid,
    origin_id: Uuid,
    root: &std::path::Path,
    controller: &str,
) -> ServerConfig {
    ServerConfig {
        project_id,
        origin_id,
        workspace_root: root.to_path_buf(),
        git_remote_url: None,
        git_remote_base_url: None,
        git_branch: "main".to_string(),
        git_remote_name: "origin".to_string(),
        git_author_name: "Instafy Test".to_string(),
        git_author_email: "test@instafy.dev".to_string(),
        bind_host: "127.0.0.1".to_string(),
        bind_port: 0,
        controller_base_url: controller.parse().expect("controller url"),
        controller_internal_token: None,
        controller_token_source: None,
        jwks_url: format!("{controller}/jwks").parse().expect("jwks url"),
        skip_auth: false,
        enable_presence_heartbeat: false,
        presence_interval: Duration::from_secs(30),
        max_archive_bytes: 1024 * 1024,
        staging_base: None,
        multi_tenant: false,
        hosted_checkout: false,
    }
}

/// An origin state whose agent-control marker lives at `marker`, with
/// `handle` as its browser host.
fn state_with(
    workspace: &TempDir,
    controller: &str,
    project_id: Uuid,
    origin_id: Uuid,
    marker: &std::path::Path,
    handle: Option<BrowserHostHandle>,
) -> AppState {
    let config = Arc::new(config(project_id, origin_id, workspace.path(), controller));
    let client = reqwest::Client::new();
    let validator = TokenValidator::new(client.clone(), config.jwks_url.clone());
    let mut state = AppState::new(
        config,
        validator,
        client,
        workspace.path().to_path_buf(),
        None,
    )
    .expect("open workspace root");
    state.browser_collaboration =
        BrowserCollaborationHub::new_with_agent_control_path(marker.to_path_buf());
    state.browser_host = handle;
    state
}

fn claims_for(subject: &str, session_id: &str, can_control: bool) -> OriginClaims {
    let mut scopes = vec!["browser.view".to_string()];
    if can_control {
        scopes.push("browser.control".to_string());
    }
    serde_json::from_value(json!({
        "aud": Uuid::new_v4().to_string(),
        "sub": subject,
        "project_id": Uuid::nil().to_string(),
        "protocol": "http",
        "scopes": scopes,
        "exp": unix_seconds() + 600,
        "browser_session_id": session_id,
    }))
    .expect("claims")
}

fn unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

fn write_marker(path: &std::path::Path, initiator: &str) {
    let marker = json!({
        "version": 2,
        "ownerId": Uuid::new_v4(),
        "runId": Uuid::new_v4(),
        "initiatorUserId": initiator,
        "browserPageId": "PAGE1",
        "displayName": "Octo",
        "expiresAtMs": (unix_seconds() as u64 + 60) * 1000,
    });
    std::fs::write(path, serde_json::to_vec(&marker).unwrap()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

async fn view_for(state: &AppState, subject: &str) -> Value {
    let handle = state.browser_host.clone().expect("a host");
    let snapshot = handle.snapshot();
    serde_json::to_value(host_view(state, handle.as_ref(), snapshot, subject).await).unwrap()
}

/// A JWKS server, a signing key and an origin serving `state`'s router.
struct Served {
    base: String,
    key_der: Vec<u8>,
    project_id: Uuid,
    origin_id: Uuid,
    servers: Vec<tokio::task::JoinHandle<()>>,
}

impl Drop for Served {
    fn drop(&mut self) {
        for server in &self.servers {
            server.abort();
        }
    }
}

impl Served {
    fn token(&self, subject: &str, session_id: &str, scopes: &[&str]) -> String {
        let now = unix_seconds();
        let claims = json!({
            "aud": self.origin_id.to_string(),
            "sub": subject,
            "project_id": self.project_id.to_string(),
            "origin_id": self.origin_id.to_string(),
            "protocol": "http",
            "scopes": scopes,
            "iat": now,
            "exp": now + 600,
            "jti": Uuid::new_v4().to_string(),
            "browser_session_id": session_id,
        });
        let header = Header {
            kid: Some("browser-host-test".to_string()),
            alg: Algorithm::EdDSA,
            ..Header::default()
        };
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            base64::engine::general_purpose::STANDARD.encode(&self.key_der)
        );
        let key = EncodingKey::from_ed_pem(pem.as_bytes()).unwrap();
        jsonwebtoken::encode(&header, &claims, &key).unwrap()
    }
}

/// Serves an origin per `handle` (one origin each), all trusting one key.
async fn serve(
    workspace: &TempDir,
    marker: &std::path::Path,
    handles: Vec<Option<BrowserHostHandle>>,
) -> (Served, Vec<AppState>, Vec<String>) {
    let key_der = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
        .unwrap()
        .as_ref()
        .to_vec();
    let key_pair = Ed25519KeyPair::from_pkcs8(&key_der).unwrap();
    let jwks = json!({
        "keys": [{
            "kty": "OKP",
            "crv": "Ed25519",
            "alg": "EdDSA",
            "use": "sig",
            "kid": "browser-host-test",
            "x": URL_SAFE_NO_PAD.encode(key_pair.public_key().as_ref()),
        }]
    });
    let jwks_app = Router::new().route(
        "/jwks",
        axum::routing::get(move || {
            let jwks = jwks.clone();
            async move { axum::Json(jwks) }
        }),
    );
    let jwks_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let controller = format!("http://{}", jwks_listener.local_addr().unwrap());
    let mut servers = vec![tokio::spawn(async move {
        axum::serve(jwks_listener, jwks_app).await.unwrap();
    })];

    let project_id = Uuid::new_v4();
    let origin_id = Uuid::new_v4();
    let mut states = Vec::new();
    let mut bases = Vec::new();
    for handle in handles {
        let state = state_with(
            workspace,
            &controller,
            project_id,
            origin_id,
            marker,
            handle,
        );
        let app = crate::routes::router(state.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        bases.push(format!("http://{}", listener.local_addr().unwrap()));
        servers.push(tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        }));
        states.push(state);
    }
    let served = Served {
        base: bases[0].clone(),
        key_der,
        project_id,
        origin_id,
        servers,
    };
    (served, states, bases)
}

fn marker_path(directory: &TempDir) -> std::path::PathBuf {
    directory.path().join("agent-control.json")
}

async fn body(response: reqwest::Response) -> Value {
    response.json::<Value>().await.unwrap()
}

// ---------------------------------------------------------------------------
// Routes and scopes.

#[tokio::test]
async fn host_routes_follow_the_browser_scopes_and_need_a_host() {
    let workspace = TempDir::new().unwrap();
    let markers = TempDir::new().unwrap();
    let host = FakeHost::new(BrowserHostState::Idle);
    let (served, _, bases) = serve(
        &workspace,
        &marker_path(&markers),
        vec![Some(host.handle()), None],
    )
    .await;
    let (with_host, without_host) = (&bases[0], &bases[1]);
    let client = reqwest::Client::new();
    let user = Uuid::new_v4().to_string();
    let fs_read = served.token(&user, "s1", &["fs.read"]);
    let view = served.token(&user, "s1", &["browser.view"]);
    let control = served.token(&user, "s1", &["browser.control"]);

    let status = |response: reqwest::Response| response.status();
    assert_eq!(
        status(
            client
                .get(format!("{with_host}/browser/host"))
                .bearer_auth(&fs_read)
                .send()
                .await
                .unwrap()
        ),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status(
            client
                .get(format!("{with_host}/browser/host"))
                .bearer_auth(&control)
                .send()
                .await
                .unwrap()
        ),
        StatusCode::UNAUTHORIZED,
        "reading the host needs browser.view"
    );
    let response = client
        .get(format!("{with_host}/browser/host"))
        .bearer_auth(&view)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get(reqwest::header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("no-store")));
    assert_eq!(
        body(response).await,
        json!({
            "version": 1,
            "mode": "lazy",
            "state": "idle",
            "generation": null,
            "failure": null,
            "startedByYou": false,
            "othersPresent": false,
            "controlledByOther": false,
            "agentRunActive": false,
            "agentRunStartedByYou": false,
        })
    );
    let missing = client
        .get(format!("{without_host}/browser/host"))
        .bearer_auth(&view)
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    assert_eq!(body(missing).await["code"], "not_found");

    let start = |base: &str, token: &str| {
        client
            .post(format!("{base}/browser/host/start"))
            .bearer_auth(token)
            .json(&json!({ "version": 1 }))
            .send()
    };
    assert_eq!(
        status(start(with_host, &fs_read).await.unwrap()),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        status(start(with_host, &view).await.unwrap()),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(host.inner().start_calls, 0);
    assert_eq!(
        status(start(without_host, &control).await.unwrap()),
        StatusCode::NOT_FOUND
    );

    let started = start(with_host, &control).await.unwrap();
    assert_eq!(started.status(), StatusCode::ACCEPTED);
    let started = body(started).await;
    assert_eq!(started["state"], "starting");
    assert_eq!(started["startedByYou"], true);
    assert!(Uuid::parse_str(started["generation"].as_str().unwrap()).is_ok());
    assert_eq!(host.inner().start_calls, 1);
    assert_eq!(host.seen_by(&user), 1, "a start counts as a use");

    host.inner().snapshot.state = BrowserHostState::Ready;
    let ready = start(with_host, &control).await.unwrap();
    assert_eq!(
        ready.status(),
        StatusCode::OK,
        "an already-ready host answers 200"
    );
    assert_eq!(body(ready).await["state"], "ready");
}

#[tokio::test]
async fn the_start_body_is_exactly_version_one() {
    let workspace = TempDir::new().unwrap();
    let markers = TempDir::new().unwrap();
    let host = FakeHost::new(BrowserHostState::Idle);
    let (served, states, _) = serve(
        &workspace,
        &marker_path(&markers),
        vec![Some(host.handle())],
    )
    .await;
    let client = reqwest::Client::new();
    let control = served.token(&Uuid::new_v4().to_string(), "s1", &["browser.control"]);
    let post = |payload: Vec<u8>| {
        client
            .post(format!("{}/browser/host/start", served.base))
            .bearer_auth(&control)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(payload)
            .send()
    };

    for (payload, why) in [
        (
            json!({ "version": 1, "renderScale": 2 }),
            "renderScale is not part of the contract",
        ),
        (
            json!({ "version": 1, "extra": true }),
            "unknown fields are refused",
        ),
        (json!({}), "the version is required"),
        (json!({ "version": 2 }), "only version 1 is served"),
        (json!({ "version": "1" }), "the version is a number"),
        (json!([1]), "the body is an object"),
    ] {
        let response = post(serde_json::to_vec(&payload).unwrap()).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{why}");
    }
    assert_eq!(
        post(b"not json".to_vec()).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        post(Vec::new()).await.unwrap().status(),
        StatusCode::BAD_REQUEST
    );
    let mut oversized = br#"{"version":1}"#.to_vec();
    oversized.extend(std::iter::repeat(b' ').take(1024));
    assert_eq!(
        post(oversized).await.unwrap().status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert_eq!(
        host.inner().start_calls,
        0,
        "no refused body reaches the host"
    );

    // A pre-stop flush's fence refuses starts.
    states[0].stopping.raise();
    let stopping = post(br#"{"version":1}"#.to_vec()).await.unwrap();
    assert_eq!(stopping.status(), StatusCode::CONFLICT);
    assert_eq!(body(stopping).await["code"], "machine_stopping");
    assert_eq!(host.inner().start_calls, 0);
    states[0].stopping.lift();

    // The host's own refusals are 409 with their code and a fixed message;
    // the host's message and any undocumented code never reach the client.
    for (given, code) in [
        (BROWSER_HOST_POISONED_CODE, BROWSER_HOST_POISONED_CODE),
        (BROWSER_HOST_STOPPING_CODE, BROWSER_HOST_STOPPING_CODE),
        ("disk_full_at_/home/someone", BROWSER_HOST_STOPPING_CODE),
    ] {
        host.inner().refusal = Some(BrowserHostRefusal {
            code: given,
            message: "failed at /home/someone/secret".to_string(),
        });
        let refused = post(br#"{"version":1}"#.to_vec()).await.unwrap();
        assert_eq!(refused.status(), StatusCode::CONFLICT);
        let refused = body(refused).await;
        assert_eq!(refused["code"], code);
        let message = refused["error"].as_str().expect("a message");
        assert!(!message.contains("someone"), "{message}");
        assert_eq!(
            refused.as_object().unwrap().len(),
            2,
            "only error and code: {refused}"
        );
    }
    host.inner().refusal = None;
    assert_eq!(
        post(br#"{"version":1}"#.to_vec()).await.unwrap().status(),
        StatusCode::ACCEPTED
    );
}

// ---------------------------------------------------------------------------
// The readiness guard.

async fn ws_status(url: String, token: &str) -> u16 {
    let mut request = url.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {token}").parse().unwrap());
    match tokio_tungstenite::connect_async(request).await {
        Ok(_) => 101,
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            assert_eq!(
                response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok()),
                Some("1")
            );
            let body: Value = serde_json::from_slice(response.body().as_deref().unwrap()).unwrap();
            assert_eq!(body["code"], "browser_host_not_ready");
            response.status().as_u16()
        }
        Err(error) => panic!("unexpected websocket error: {error}"),
    }
}

#[tokio::test]
async fn browser_transports_wait_for_a_ready_host() {
    let workspace = TempDir::new().unwrap();
    let markers = TempDir::new().unwrap();
    let host = FakeHost::new(BrowserHostState::Starting);
    let (served, _, _) = serve(
        &workspace,
        &marker_path(&markers),
        vec![Some(host.handle())],
    )
    .await;
    let client = reqwest::Client::new();
    let user = Uuid::new_v4().to_string();
    let view = served.token(&user, "s1", &["browser.view"]);
    let control = served.token(&user, "s1", &["browser.control"]);
    let both = served.token(&user, "s1", &["browser.view", "browser.control"]);
    let base = &served.base;

    for state in [
        BrowserHostState::Idle,
        BrowserHostState::Starting,
        BrowserHostState::Stopping,
        BrowserHostState::Failed,
        BrowserHostState::Poisoned,
    ] {
        host.inner().snapshot.state = state;
        let requests = [
            client
                .get(format!("{base}/browser/pages"))
                .bearer_auth(&view),
            client
                .post(format!("{base}/browser/pages/PAGE1/focus"))
                .bearer_auth(&control),
            client
                .post(format!("{base}/browser/pages/PAGE1/command"))
                .bearer_auth(&control)
                .json(&json!({ "action": "reload" })),
        ];
        for request in requests {
            let response = request.send().await.unwrap();
            assert_eq!(
                response.status(),
                StatusCode::SERVICE_UNAVAILABLE,
                "{state:?}"
            );
            assert_eq!(
                response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|value| value.to_str().ok()),
                Some("1")
            );
            assert_eq!(
                body(response).await,
                json!({
                    "error": "Instafy's browser is not running",
                    "code": "browser_host_not_ready",
                })
            );
        }
        let ws = base.replace("http://", "ws://");
        assert_eq!(
            ws_status(format!("{ws}/browser/screencast"), &both).await,
            503
        );
        assert_eq!(
            ws_status(format!("{ws}/browser/input"), &control).await,
            503
        );
        assert_eq!(ws_status(format!("{ws}/browser/vnc"), &both).await, 503);
    }

    // Metadata stays readable while the host is down.
    host.inner().snapshot.state = BrowserHostState::Idle;
    for path in ["/browser/capabilities", "/browser/actions"] {
        let response = client
            .get(format!("{base}{path}"))
            .bearer_auth(&view)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{path}");
    }

    // Once ready, the guard steps aside: an upgrade-less request reaches the
    // websocket extractor (400) rather than the guard.
    host.inner().snapshot.state = BrowserHostState::Ready;
    let past_guard = client
        .get(format!("{base}/browser/vnc"))
        .bearer_auth(&both)
        .send()
        .await
        .unwrap();
    assert_ne!(past_guard.status(), StatusCode::SERVICE_UNAVAILABLE);
}

// ---------------------------------------------------------------------------
// Caller-relative flags.

#[tokio::test]
async fn presence_and_control_flags_are_relative_to_the_caller() {
    let workspace = TempDir::new().unwrap();
    let markers = TempDir::new().unwrap();
    let marker = marker_path(&markers);
    let host = FakeHost::new(BrowserHostState::Ready);
    let state = state_with(
        &workspace,
        "http://127.0.0.1:1",
        Uuid::new_v4(),
        Uuid::new_v4(),
        &marker,
        Some(host.handle()),
    );
    let hub = &state.browser_collaboration;
    let me = Uuid::new_v4().to_string();
    let teammate = Uuid::new_v4().to_string();

    // The same person on two sessions is still "you", and holds control.
    hub.join_for_test(&claims_for(&me, "mine-1", true), "mine-1")
        .await
        .unwrap();
    hub.join_for_test(&claims_for(&me, "mine-2", true), "mine-2")
        .await
        .unwrap();
    let view = view_for(&state, &me).await;
    assert_eq!(view["othersPresent"], false);
    assert_eq!(view["controlledByOther"], false);

    // Another person present, not in control.
    hub.join_for_test(&claims_for(&teammate, "theirs", true), "theirs")
        .await
        .unwrap();
    let view = view_for(&state, &me).await;
    assert_eq!(view["othersPresent"], true);
    assert_eq!(view["controlledByOther"], false);
    // From the teammate's side, someone else holds control.
    let theirs = view_for(&state, &teammate).await;
    assert_eq!(theirs["othersPresent"], true);
    assert_eq!(theirs["controlledByOther"], true);

    // The agent's recent sighting of another person counts as presence,
    // even with nobody in the hub (an origin restarted since).
    let fresh = state_with(
        &workspace,
        "http://127.0.0.1:1",
        Uuid::new_v4(),
        Uuid::new_v4(),
        &marker,
        Some(host.handle()),
    );
    assert_eq!(view_for(&fresh, &me).await["othersPresent"], false);
    host.inner().other_seen_recently = true;
    assert_eq!(view_for(&fresh, &me).await["othersPresent"], true);

    // Who started this generation.
    host.inner().starter = Some(me.clone());
    assert_eq!(view_for(&fresh, &me).await["startedByYou"], true);
    assert_eq!(view_for(&fresh, &teammate).await["startedByYou"], false);
}

#[tokio::test]
async fn agent_run_flags_follow_the_marker_and_fail_closed() {
    let workspace = TempDir::new().unwrap();
    let markers = TempDir::new().unwrap();
    let marker = marker_path(&markers);
    let host = FakeHost::new(BrowserHostState::Ready);
    let state = state_with(
        &workspace,
        "http://127.0.0.1:1",
        Uuid::new_v4(),
        Uuid::new_v4(),
        &marker,
        Some(host.handle()),
    );
    let me = Uuid::new_v4().to_string();
    let flags = |view: Value| {
        (
            view["agentRunActive"].clone(),
            view["agentRunStartedByYou"].clone(),
        )
    };

    assert_eq!(
        flags(view_for(&state, &me).await),
        (json!(false), json!(false))
    );

    write_marker(&marker, &me);
    assert_eq!(
        flags(view_for(&state, &me).await),
        (json!(true), json!(true))
    );

    write_marker(&marker, &Uuid::new_v4().to_string());
    assert_eq!(
        flags(view_for(&state, &me).await),
        (json!(true), json!(false))
    );

    // Unreadable: a run may hold the browser, and it is not the caller's.
    std::fs::write(&marker, b"{not-json").unwrap();
    assert_eq!(
        flags(view_for(&state, &me).await),
        (json!(true), json!(false))
    );

    std::fs::remove_file(&marker).unwrap();
    assert_eq!(
        flags(view_for(&state, &me).await),
        (json!(false), json!(false))
    );
}

#[tokio::test]
async fn the_view_names_nobody_and_reports_only_known_failures() {
    let workspace = TempDir::new().unwrap();
    let markers = TempDir::new().unwrap();
    let marker = marker_path(&markers);
    let host = FakeHost::new(BrowserHostState::Ready);
    let state = state_with(
        &workspace,
        "http://127.0.0.1:1",
        Uuid::new_v4(),
        Uuid::new_v4(),
        &marker,
        Some(host.handle()),
    );
    let me = Uuid::new_v4().to_string();
    let teammate = Uuid::new_v4().to_string();
    state
        .browser_collaboration
        .join_for_test(&claims_for(&teammate, "theirs", true), "theirs")
        .await
        .unwrap();
    state
        .browser_collaboration
        .join_for_test(&claims_for(&me, "mine", true), "mine")
        .await
        .unwrap();
    write_marker(&marker, &teammate);
    host.inner().starter = Some(teammate.clone());

    let view = view_for(&state, &me).await;
    let text = view.to_string();
    for identifier in [me.as_str(), teammate.as_str(), "theirs", "mine"] {
        assert!(!text.contains(identifier), "{identifier} leaked: {text}");
    }
    let object = view.as_object().unwrap();
    for (key, value) in object {
        if let Some(text) = value.as_str() {
            assert!(
                key == "generation" || Uuid::parse_str(text).is_err(),
                "{key} carries an id"
            );
        }
    }
    assert_eq!(
        object
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>(),
        [
            "version",
            "mode",
            "state",
            "generation",
            "failure",
            "startedByYou",
            "othersPresent",
            "controlledByOther",
            "agentRunActive",
            "agentRunStartedByYou",
        ]
        .into_iter()
        .map(str::to_string)
        .collect()
    );

    // A failure is reported only in Failed or Poisoned, and only as a known
    // token.
    host.inner().snapshot.failure = Some("chromium_failed");
    assert_eq!(view_for(&state, &me).await["failure"], Value::Null);
    host.inner().snapshot.state = BrowserHostState::Failed;
    assert_eq!(view_for(&state, &me).await["failure"], "chromium_failed");
    host.inner().snapshot.state = BrowserHostState::Poisoned;
    host.inner().snapshot.failure = Some("unconfirmed_shutdown");
    let view = view_for(&state, &me).await;
    assert_eq!(view["state"], "poisoned");
    assert_eq!(view["failure"], "unconfirmed_shutdown");
    host.inner().snapshot.failure = Some("/home/someone/secret");
    assert_eq!(view_for(&state, &me).await["failure"], "host_error");
}

#[tokio::test]
async fn presence_survives_an_origin_restart_through_the_host() {
    let workspace = TempDir::new().unwrap();
    let markers = TempDir::new().unwrap();
    let host = FakeHost::new(BrowserHostState::Ready);
    host.inner().other_seen_recently = true;
    let (served, _, bases) = serve(
        &workspace,
        &marker_path(&markers),
        vec![Some(host.handle()), Some(host.handle())],
    )
    .await;
    let client = reqwest::Client::new();
    let view = served.token(&Uuid::new_v4().to_string(), "s1", &["browser.view"]);
    for base in &bases {
        let response = client
            .get(format!("{base}/browser/host"))
            .bearer_auth(&view)
            .send()
            .await
            .unwrap();
        assert_eq!(body(response).await["othersPresent"], true, "{base}");
    }
    host.inner().other_seen_recently = false;
    let response = client
        .get(format!("{}/browser/host", bases[1]))
        .bearer_auth(&view)
        .send()
        .await
        .unwrap();
    assert_eq!(body(response).await["othersPresent"], false);
}

// ---------------------------------------------------------------------------
// Where `note_seen` comes from.

#[tokio::test]
async fn uses_of_the_browser_reach_the_host() {
    let workspace = TempDir::new().unwrap();
    let markers = TempDir::new().unwrap();
    let host = FakeHost::new(BrowserHostState::Idle);
    let (served, _, _) = serve(
        &workspace,
        &marker_path(&markers),
        vec![Some(host.handle())],
    )
    .await;
    let client = reqwest::Client::new();
    let user = Uuid::new_v4().to_string();
    let view = served.token(&user, "session-1", &["browser.view"]);
    let control = served.token(&user, "session-1", &["browser.control"]);
    let base = &served.base;

    // Reading the host's state is not a use.
    client
        .get(format!("{base}/browser/host"))
        .bearer_auth(&view)
        .send()
        .await
        .unwrap();
    assert_eq!(host.seen_by(&user), 0);

    // Joining the collaboration socket, then each accepted frame.
    let ws = base.replace("http://", "ws://");
    let mut request = format!("{ws}/browser/collaboration")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {view}").parse().unwrap());
    let (mut socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    socket
        .send(WsMessage::Text(
            json!({ "type": "join", "sessionId": "session-1", "pageId": null }).to_string(),
        ))
        .await
        .unwrap();
    let welcome = tokio::time::timeout(Duration::from_secs(5), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(welcome.to_text().unwrap().contains("welcome"));
    assert_eq!(host.seen_by(&user), 1, "the join");

    socket
        .send(WsMessage::Text(
            json!({ "type": "heartbeat", "pageId": null }).to_string(),
        ))
        .await
        .unwrap();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while host.seen_by(&user) < 2 {
        assert!(tokio::time::Instant::now() < deadline, "the heartbeat");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    socket.close(None).await.ok();

    // Pages and page commands, even while the host is not ready.
    client
        .get(format!("{base}/browser/pages"))
        .bearer_auth(&view)
        .send()
        .await
        .unwrap();
    assert_eq!(host.seen_by(&user), 3, "pages");
    client
        .post(format!("{base}/browser/pages/PAGE1/focus"))
        .bearer_auth(&control)
        .send()
        .await
        .unwrap();
    assert_eq!(host.seen_by(&user), 4, "focus");
    client
        .post(format!("{base}/browser/pages/PAGE1/command"))
        .bearer_auth(&control)
        .json(&json!({ "action": "reload" }))
        .send()
        .await
        .unwrap();
    assert_eq!(host.seen_by(&user), 5, "command");
}

// ---------------------------------------------------------------------------
// The server API runtime-agent calls.

/// `set_browser_host` before `start` is how runtime-agent installs its host:
/// the single-tenant server must hand it to the routes it serves.
#[tokio::test]
async fn a_started_single_tenant_server_serves_the_host_it_was_given() {
    let workspace = tempfile::tempdir().unwrap();
    let mut config = config(
        Uuid::new_v4(),
        Uuid::new_v4(),
        workspace.path(),
        "http://127.0.0.1:1",
    );
    // Synthetic claims for subject `origin-test-user` with the route's scopes.
    config.skip_auth = true;

    let host = FakeHost::new(BrowserHostState::Idle);
    let mut server = crate::server::OriginHttpServer::new(config).unwrap();
    server.set_browser_host(host.handle());
    let start = server.start().await.unwrap();
    let base = format!("http://{}", start.address);
    let client = reqwest::Client::new();

    let view = client
        .get(format!("{base}/browser/host"))
        .send()
        .await
        .unwrap();
    assert_eq!(view.status(), StatusCode::OK);
    assert_eq!(body(view).await["state"], "idle");

    let started = client
        .post(format!("{base}/browser/host/start"))
        .header("content-type", "application/json")
        .body(r#"{"version":1}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(started.status(), StatusCode::ACCEPTED);
    assert_eq!(body(started).await["startedByYou"], true);
    assert_eq!(host.inner().start_calls, 1);
    assert_eq!(host.seen_by("origin-test-user"), 1);

    // The guard is live too: the host is starting, not ready.
    let pages = client
        .get(format!("{base}/browser/pages"))
        .send()
        .await
        .unwrap();
    assert_eq!(pages.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(body(pages).await["code"], BROWSER_HOST_NOT_READY_CODE);

    server.stop().await.unwrap();
}
