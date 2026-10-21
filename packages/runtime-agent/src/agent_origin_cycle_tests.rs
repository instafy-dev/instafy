use super::*;
use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{StatusCode, Uri},
};

use crate::config::OriginSettings;

/// How long the stand-in controller holds an origin registration before it
/// answers, so a beat sent before the registration lands shows up first.
const REGISTER_DELAY: Duration = Duration::from_millis(300);

/// The controller's refusal of a deleted space's runtime.
const SPACE_DELETED_BODY: &str = r#"{"message":"This space was deleted.","code":"space_deleted"}"#;

/// A stand-in controller. It records, in order, each origin registration
/// (when it arrives and when it is answered), each presence beat with its
/// status, each lease and every other call, and refuses every lease with
/// 401. For a deleted space it refuses runtime registrations and leases with
/// the controller's 410 instead.
#[derive(Clone, Default)]
struct StandIn {
    events: Arc<std::sync::Mutex<Vec<String>>>,
    space_deleted: bool,
}

impl StandIn {
    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }

    fn push(&self, event: String) {
        self.events.lock().unwrap().push(event);
    }
}

async fn stand_in_controller(
    State(stand_in): State<StandIn>,
    uri: Uri,
    body: Bytes,
) -> (StatusCode, String) {
    let path = uri.path().trim_start_matches('/').to_string();
    if path.ends_with("origin/register") {
        stand_in.push("register".into());
        tokio::time::sleep(REGISTER_DELAY).await;
        stand_in.push("registered".into());
        return (StatusCode::OK, "{}".into());
    }
    if path.ends_with("origin/presence/beat") {
        let status = serde_json::from_slice::<serde_json::Value>(&body)
            .ok()
            .and_then(|value| value["status"].as_str().map(str::to_string))
            .unwrap_or_default();
        stand_in.push(format!("beat:{status}"));
        return (StatusCode::OK, "{}".into());
    }
    if path.ends_with("agent/lease") {
        stand_in.push("lease".into());
        if stand_in.space_deleted {
            return (StatusCode::GONE, SPACE_DELETED_BODY.into());
        }
        return (
            StatusCode::UNAUTHORIZED,
            r#"{"message":"agent token expired"}"#.into(),
        );
    }
    if path == "runtime/register" && stand_in.space_deleted {
        stand_in.push("register runtime".into());
        return (StatusCode::GONE, SPACE_DELETED_BODY.into());
    }
    stand_in.push(format!("other:{path}"));
    (StatusCode::NOT_FOUND, "{}".into())
}

struct Fixture {
    stand_in: StandIn,
    config: Arc<Config>,
    registration: Registration,
    server: JoinHandle<()>,
    _workspace: tempfile::TempDir,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Fixture {
    async fn new() -> Self {
        Self::start(StandIn::default()).await
    }

    async fn for_deleted_space() -> Self {
        Self::start(StandIn {
            space_deleted: true,
            ..StandIn::default()
        })
        .await
    }

    async fn start(stand_in: StandIn) -> Self {
        let app = Router::new()
            .fallback(stand_in_controller)
            .with_state(stand_in.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base_url: reqwest::Url = format!("http://{}", listener.local_addr().unwrap())
            .parse()
            .unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let workspace = tempfile::tempdir().unwrap();
        let origin = OriginSettings {
            origin_id: Uuid::new_v4(),
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            git_remote_url: None,
            git_branch: "main".into(),
            git_remote_name: "origin".into(),
            git_author_name: "Instafy".into(),
            git_author_email: "instafy@example.invalid".into(),
            rathole_bin: "rathole".into(),
            rathole_state_dir: workspace.path().join("rathole"),
            rathole_use_subcommands: false,
            tunnel_refresh_margin: Duration::from_secs(60),
            controller_internal_token: Some("inert-test-origin-token".into()),
            skip_auth: true,
            enable_presence_heartbeat: true,
            presence_interval: Duration::from_secs(30),
            jwks_url: base_url.join("/.well-known/jwks.json").unwrap(),
            max_archive_bytes: 1024 * 1024,
            staging_root: None,
            endpoint: None,
            protocols: vec!["http".into()],
            region: None,
            device_id: None,
            metadata: None,
            mode: "desktop".into(),
            tunnel_enabled: false,
            tunnel_provider: None,
            tunnel_hostname: None,
            tunnel_url: None,
            tunnel_id: None,
            tunnel_status: None,
            tunnel_expires_at: None,
            tunnel_last_rotation_at: None,
        };
        let config = Config {
            controller_base_url: base_url.clone(),
            controller_jwks_url: base_url.join("/.well-known/jwks.json").unwrap(),
            project_id: Uuid::new_v4(),
            runtime_id: None,
            runtime_lease_id: None,
            provider: "test-runtime".into(),
            runtime_version: "0.0.1".into(),
            capabilities: json!({}),
            metadata: json!({}),
            lease_scope: None,
            workspace_manifest: None,
            tenant_projects: Vec::new(),
            parent_lease_id: None,
            poll_interval: Duration::from_millis(10),
            lease_wait: Duration::ZERO,
            lease_max_jobs: 1,
            lease_seconds: 120,
            heartbeat_seconds: 60,
            workspace_root: workspace.path().to_path_buf(),
            project_workspace_override: None,
            strict_mode: false,
            dev_isolation_mode: true,
            display_name: None,
            origin: Some(origin),
            codex_bin: None,
            require_codex_bin: false,
            runtime_access_token: Some("inert-test-runtime-token".into()),
            parent_dispositions_runtime_on_shutdown: false,
        };
        let registration = Registration {
            runtime_id: Uuid::new_v4(),
            agent_token: "inert-test-agent-token".into(),
            runtime_token: None,
            lease_url: base_url.join("/agent/lease").unwrap(),
            heartbeat_url: base_url.join("/agent/heartbeat").unwrap(),
            stop_url: None,
            lease_id: None,
            proxy: None,
            lease_scope: None,
            tenant_projects: Vec::new(),
            workspace_manifest: None,
            parent_lease_id: None,
            agent_token_scopes: Vec::new(),
            agent_token_issued_at: None,
            agent_token_expires_at: None,
            agent_token_ttl: None,
        };
        Self {
            stand_in,
            config: Arc::new(config),
            registration,
            server,
            _workspace: workspace,
        }
    }

    async fn wait_for(&self, event: &str) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self.stand_in.events().iter().any(|seen| seen == event) {
            assert!(
                Instant::now() < deadline,
                "no {event} reached the stand-in controller: {:?}",
                self.stand_in.events()
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

/// The controller refuses a beat for an origin it has not registered yet with
/// 401, which the origin server takes for a lapsed credential: it has this
/// agent renew its registration, and the renewal restarts the origin and its
/// tunnel. So the origin beats only once its registration has been answered.
#[tokio::test]
async fn the_origin_beats_only_after_its_registration_lands() {
    let fixture = Fixture::new().await;
    let mut service = OriginService::try_start(
        fixture.config.clone(),
        Some(OriginLaunchOverrides {
            tunnel: None,
            controller_token: None,
            controller_token_source: None,
        }),
    )
    .await
    .expect("origin starts")
    .expect("origin configured");
    fixture.wait_for("beat:online").await;

    let events = fixture.stand_in.events();
    let registered = events.iter().position(|event| event == "registered");
    let first_beat = events.iter().position(|event| event.starts_with("beat:"));
    assert!(
        registered.is_some() && first_beat > registered,
        "a beat reached the controller before the origin was registered: {events:?}"
    );
    service.shutdown().await;
}

/// A lease refused with 401 ends the cycle with an error. The tunnel and
/// origin still go down properly on the way out, so the controller hears the
/// origin's offline beat instead of expiring it later.
#[tokio::test]
async fn a_rejected_lease_takes_the_origin_offline_before_the_cycle_ends() {
    let fixture = Fixture::new().await;
    let executor = Arc::new(AgentExecutor::new(fixture.config.clone()));
    let client = Arc::new(ControllerClient::new(&fixture.config).unwrap());
    // Boxed: the whole cycle is a large future for a test thread's stack.
    let outcome = Box::pin(RuntimeAgent::register_and_process(
        fixture.config.clone(),
        client,
        executor,
        ShutdownSignal::new(),
        Arc::new(Mutex::new(HashSet::new())),
        Some(fixture.registration.clone()),
    ))
    .await;
    assert!(outcome.is_err(), "a rejected lease is an error");

    let events = fixture.stand_in.events();
    let lease = events.iter().position(|event| event == "lease");
    let offline = events.iter().position(|event| event == "beat:offline");
    assert!(
        lease.is_some() && offline > lease,
        "the origin went away without its offline beat: {events:?}"
    );
}

/// A lease refused because the space was deleted ends the cycle for good.
/// The origin still goes offline properly, and the runtime the delete
/// stopped is not stopped again.
#[tokio::test]
async fn a_deleted_space_ends_the_cycle_without_stopping_the_runtime() {
    let fixture = Fixture::for_deleted_space().await;
    let executor = Arc::new(AgentExecutor::new(fixture.config.clone()));
    let client = Arc::new(ControllerClient::new(&fixture.config).unwrap());
    let mut registration = fixture.registration.clone();
    registration.stop_url = Some(
        fixture
            .config
            .controller_base_url
            .join("/agent/stop")
            .unwrap(),
    );
    let outcome = Box::pin(RuntimeAgent::register_and_process(
        fixture.config.clone(),
        client,
        executor,
        ShutdownSignal::new(),
        Arc::new(Mutex::new(HashSet::new())),
        Some(registration),
    ))
    .await;
    assert!(
        matches!(outcome, Ok(RegistrationOutcome::SpaceDeleted)),
        "a deleted space ends the cycle for good"
    );

    let events = fixture.stand_in.events();
    let lease = events.iter().position(|event| event == "lease");
    let offline = events.iter().position(|event| event == "beat:offline");
    assert!(
        lease.is_some() && offline > lease,
        "the origin went away without its offline beat: {events:?}"
    );
    assert_eq!(
        events.iter().filter(|event| *event == "lease").count(),
        1,
        "a refused lease is not retried: {events:?}"
    );
    assert!(
        !events.iter().any(|event| event == "other:agent/stop"),
        "the deleted space's runtime was stopped again: {events:?}"
    );
}

/// A registration refused because the space was deleted ends the agent at
/// once instead of retrying every five seconds.
#[tokio::test]
async fn a_registration_refused_for_a_deleted_space_ends_the_agent() {
    let fixture = Fixture::for_deleted_space().await;
    let executor = Arc::new(AgentExecutor::new(fixture.config.clone()));
    let client = Arc::new(ControllerClient::new(&fixture.config).unwrap());
    let exit = tokio::time::timeout(
        Duration::from_secs(4),
        Box::pin(RuntimeAgent::run_registration_loop(
            fixture.config.clone(),
            client,
            executor,
            ShutdownSignal::new(),
            Arc::new(Mutex::new(HashSet::new())),
        )),
    )
    .await
    .expect("the agent ends without waiting to register again")
    .expect("the agent ends cleanly");
    assert_eq!(exit, AgentExit::SpaceDeleted);
    assert_eq!(
        fixture.stand_in.events(),
        vec!["register runtime".to_string()]
    );
}

/// Only a runtime its provider launched for a lease waits for the provider
/// to release it; everything else exits.
#[tokio::test]
async fn only_a_runtime_without_a_provider_lease_exits_for_a_deleted_space() {
    let fixture = Fixture::new().await;
    assert!(exits_when_space_deleted(&fixture.config));
    let mut leased = (*fixture.config).clone();
    leased.runtime_lease_id = Some(Uuid::new_v4());
    assert!(!exits_when_space_deleted(&leased));
}

/// Instafy's browser on the space's own machine belongs to the process, not
/// to one registration: a cycle that ends for a renewal leaves it running.
#[cfg(unix)]
#[tokio::test]
async fn a_renewal_keeps_the_browser_host_running() {
    use crate::browser_host::test_support::{Fake, wait_for_state};
    use origin_http_server::browser_host::BrowserHostState;

    let fake = Fake::new("ready");
    let host = fake.spawn();
    let _installed = crate::browser_host::install_host_for_tests(host.clone());
    host.request_start("user").unwrap();
    let ready = wait_for_state(&host, BrowserHostState::Ready).await;

    let fixture = Fixture::new().await;
    let executor = Arc::new(AgentExecutor::new(fixture.config.clone()));
    let client = Arc::new(ControllerClient::new(&fixture.config).unwrap());
    let outcome = Box::pin(RuntimeAgent::register_and_process(
        fixture.config.clone(),
        client,
        executor,
        ShutdownSignal::new(),
        Arc::new(Mutex::new(HashSet::new())),
        Some(fixture.registration.clone()),
    ))
    .await;
    assert!(
        outcome.is_err(),
        "a rejected lease ends the cycle for a renewal"
    );

    let after = host.snapshot();
    assert_eq!(after.state, BrowserHostState::Ready);
    assert_eq!(after.generation, ready.generation);
    assert_eq!(fake.starts(), 1);
    host.stop("test").await;
}

/// The runtime's shutdown stops the browser host after origin went down.
#[cfg(unix)]
#[tokio::test]
async fn a_shutdown_stops_the_browser_host() {
    use crate::browser_host::test_support::{Fake, eventually, process_alive, wait_for_state};
    use origin_http_server::browser_host::BrowserHostState;

    let fake = Fake::new("ready");
    let host = fake.spawn();
    let _installed = crate::browser_host::install_host_for_tests(host.clone());
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;
    let browser = fake.child_pid();

    let fixture = Fixture::new().await;
    let executor = Arc::new(AgentExecutor::new(fixture.config.clone()));
    let client = Arc::new(ControllerClient::new(&fixture.config).unwrap());
    let shutdown = ShutdownSignal::new();
    shutdown.cancel();
    let outcome = Box::pin(RuntimeAgent::register_and_process(
        fixture.config.clone(),
        client,
        executor,
        shutdown,
        Arc::new(Mutex::new(HashSet::new())),
        Some(fixture.registration.clone()),
    ))
    .await;
    assert!(matches!(outcome, Ok(RegistrationOutcome::Shutdown)));
    assert_eq!(host.snapshot().state, BrowserHostState::Idle);
    eventually("the browser to end", Duration::from_secs(15), || {
        !process_alive(browser)
    })
    .await;
    assert!(
        host.request_start("user").is_err(),
        "no start after shutdown"
    );
}

/// A deleted space kills the browser host at once, without a save.
#[cfg(unix)]
#[tokio::test]
async fn a_deleted_space_kills_the_browser_host() {
    use crate::browser_host::test_support::{Fake, eventually, process_alive, wait_for_state};
    use origin_http_server::browser_host::BrowserHostState;

    let fake = Fake::new("ready");
    let host = fake.spawn();
    let _installed = crate::browser_host::install_host_for_tests(host.clone());
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;
    let browser = fake.child_pid();

    let fixture = Fixture::for_deleted_space().await;
    let executor = Arc::new(AgentExecutor::new(fixture.config.clone()));
    let client = Arc::new(ControllerClient::new(&fixture.config).unwrap());
    let outcome = Box::pin(RuntimeAgent::register_and_process(
        fixture.config.clone(),
        client,
        executor,
        ShutdownSignal::new(),
        Arc::new(Mutex::new(HashSet::new())),
        Some(fixture.registration.clone()),
    ))
    .await;
    assert!(matches!(outcome, Ok(RegistrationOutcome::SpaceDeleted)));
    eventually(
        "the browser host to be killed",
        Duration::from_secs(15),
        || !process_alive(browser) && host.snapshot().state == BrowserHostState::Failed,
    )
    .await;
}

/// A shutdown that arrives while the agent waits to retry a failed
/// registration stops the browser host too: no lease cycle is running then.
#[cfg(unix)]
#[tokio::test]
async fn a_shutdown_during_the_registration_retry_stops_the_browser_host() {
    use crate::browser_host::test_support::{Fake, eventually, process_alive, wait_for_state};
    use origin_http_server::browser_host::BrowserHostState;

    let fake = Fake::new("ready");
    let host = fake.spawn();
    let _installed = crate::browser_host::install_host_for_tests(host.clone());
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;
    let browser = fake.child_pid();

    // The stand-in answers a runtime registration with 404, so the loop
    // fails the cycle and waits five seconds before it retries.
    let fixture = Fixture::new().await;
    let executor = Arc::new(AgentExecutor::new(fixture.config.clone()));
    let client = Arc::new(ControllerClient::new(&fixture.config).unwrap());
    let shutdown = ShutdownSignal::new();
    let run = Box::pin(RuntimeAgent::run_registration_loop(
        fixture.config.clone(),
        client,
        executor,
        shutdown.clone(),
        Arc::new(Mutex::new(HashSet::new())),
    ));
    let cancel = async {
        eventually(
            "the registration to be refused",
            Duration::from_secs(15),
            || {
                fixture
                    .stand_in
                    .events()
                    .iter()
                    .any(|event| event.starts_with("other:"))
            },
        )
        .await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(
            host.snapshot().state,
            BrowserHostState::Ready,
            "a failed registration leaves the host"
        );
        shutdown.cancel();
    };
    let (exit, ()) = tokio::join!(run, cancel);
    assert!(matches!(exit, Ok(AgentExit::Stopped)));
    assert_eq!(host.snapshot().state, BrowserHostState::Idle);
    eventually("the browser to end", Duration::from_secs(15), || {
        !process_alive(browser)
    })
    .await;
    assert!(
        host.request_start("user").is_err(),
        "no start after shutdown"
    );
}

/// The runtime's shutdown saves the browser host's profile before it stops
/// the runtime, so the next machine restores the sign-ins.
#[cfg(unix)]
#[tokio::test]
async fn a_shutdown_saves_the_browser_profile_before_the_runtime_stops() {
    use crate::browser_host::persistence::testing::FakeStore;
    use crate::browser_host::test_support::{Fake, wait_for_state};
    use origin_http_server::browser_host::BrowserHostState;

    let fixture = Fixture::new().await;
    let store = FakeStore::logging_to(fixture.stand_in.events.clone());
    let fake = Fake::new("ready");
    let host = fake.spawn_persisting(store.clone(), Duration::from_secs(3600));
    let _installed = crate::browser_host::install_host_for_tests(host.clone());
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;
    let cookies = fake.profile().join("Default/Network/Cookies");
    std::fs::create_dir_all(cookies.parent().unwrap()).unwrap();
    std::fs::write(&cookies, b"signed in").unwrap();

    let mut registration = fixture.registration.clone();
    registration.stop_url = Some(registration.lease_url.join("/runtimes/stop").unwrap());
    let executor = Arc::new(AgentExecutor::new(fixture.config.clone()));
    let client = Arc::new(ControllerClient::new(&fixture.config).unwrap());
    let shutdown = ShutdownSignal::new();
    shutdown.cancel();
    let outcome = Box::pin(RuntimeAgent::register_and_process(
        fixture.config.clone(),
        client,
        executor,
        shutdown,
        Arc::new(Mutex::new(HashSet::new())),
        Some(registration),
    ))
    .await;
    assert!(matches!(outcome, Ok(RegistrationOutcome::Shutdown)));
    assert_eq!(store.stored().0, 1);
    let events = fixture.stand_in.events();
    let saved = events.iter().position(|event| event == "profile-put");
    let stopped = events
        .iter()
        .position(|event| event == "other:runtimes/stop");
    assert!(
        saved.is_some() && stopped.is_some() && saved < stopped,
        "the save comes before the runtime stops: {events:?}"
    );
}

/// A deleted space kills the browser host without saving its profile.
#[cfg(unix)]
#[tokio::test]
async fn a_deleted_space_never_saves_the_browser_profile() {
    use crate::browser_host::persistence::testing::FakeStore;
    use crate::browser_host::test_support::{Fake, eventually, wait_for_state};
    use origin_http_server::browser_host::BrowserHostState;

    let store = FakeStore::new();
    let fake = Fake::new("ready");
    let host = fake.spawn_persisting(store.clone(), Duration::from_millis(100));
    let _installed = crate::browser_host::install_host_for_tests(host.clone());
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;

    let fixture = Fixture::for_deleted_space().await;
    let executor = Arc::new(AgentExecutor::new(fixture.config.clone()));
    let client = Arc::new(ControllerClient::new(&fixture.config).unwrap());
    let outcome = Box::pin(RuntimeAgent::register_and_process(
        fixture.config.clone(),
        client,
        executor,
        ShutdownSignal::new(),
        Arc::new(Mutex::new(HashSet::new())),
        Some(fixture.registration.clone()),
    ))
    .await;
    assert!(matches!(outcome, Ok(RegistrationOutcome::SpaceDeleted)));
    let cookies = fake.profile().join("Default/Network/Cookies");
    std::fs::create_dir_all(cookies.parent().unwrap()).unwrap();
    std::fs::write(&cookies, b"signed in").unwrap();
    eventually(
        "the browser host to be killed",
        Duration::from_secs(15),
        || host.snapshot().state == BrowserHostState::Failed,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(store.uploads_started(), 0);
}
