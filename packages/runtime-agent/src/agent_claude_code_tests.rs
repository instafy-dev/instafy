//! Local-engine turns in the job loop (docs/Local-Engine-Turns.md 3.1, 3.2, 3.6, 3.8 and 3.9;
//! section 8: "Branch", "Refusals", "Results", the Stop of "Supervision", and registering again
//! when a probe changes the capability), end to end against a stand-in controller and origin, with
//! the `--print` scenarios of tests/fixtures/fake-claude.
//!
//! Hermetic: temporary folders, loopback stand-ins, and the fake started through a wrapper each
//! space writes, as the lane starts the person's own `claude`: from the checked target the probe
//! found, with the exact command and environment of 3.3 and 3.4. Each test passes a cleanup latch
//! of its own, so one that sets it stops no other.

use super::*;
use crate::claude_code::supervise::TurnLimits;
use crate::claude_code::{
    Confinement, Lane, LaunchEnvSnapshot, LaunchGrant, RawLaunchGrant, Trust,
};
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode as AxumStatusCode, Uri};
use axum::response::IntoResponse as _;
use axum::{Json, Router};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use ring::rand::SystemRandom;
use ring::signature::{Ed25519KeyPair, KeyPair};
use runtime_contracts::{AccessTokenClaims, ProxyEnvelopePayload};
use serde_json::Value;
use std::path::{Path, PathBuf};

const FAKE_CLAUDE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/fake-claude");
const FIXTURES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/tests/fixtures/fake-claude-fixtures"
);
/// The session id the scenarios print.
const SESSION: &str = "5d2a8c4e-1f3b-4c6d-9e7a-0b1c2d3e4f50";
/// The person's recorded message, with the spaces and line end it was typed with.
const PROMPT: &str = "  Rename the project in README.md\n";
const KEY_ID: &str = "claude-code-lane-tests";
/// A page another chat made: a turn of this chat puts back what it changes there.
const HELD_PAGE: &str = "sites/other/index.html";
const HELD_PAGE_TEXT: &str = "<h1>Another chat's page</h1>\n";
const AGENT_SCOPES: [&str; 7] = [
    "agent.lease",
    "agent.heartbeat",
    "agent.message",
    "agent.complete",
    "agent.secrets",
    "agent.stop",
    "agent.input",
];

/// Runs `work` on a thread with the production worker's stack, as a leased job runs.
fn on_a_worker_stack<F: std::future::Future<Output = ()> + Send + 'static>(work: F) {
    const WORKER_STACK: usize = 16 * 1024 * 1024;
    std::thread::Builder::new()
        .stack_size(WORKER_STACK)
        .spawn(move || {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(WORKER_STACK)
                .build()
                .unwrap()
                .block_on(work)
        })
        .unwrap()
        .join()
        .unwrap();
}

fn folder(path: &Path, mode: u32) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
    path.to_path_buf()
}

fn quote(value: impl AsRef<std::ffi::OsStr>) -> String {
    let value = value.as_ref().to_str().expect("test paths are UTF-8");
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn write(folder: &Path, path: &str, text: &str) {
    let path = folder.join(path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn git(folder: &Path, home: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=Instafy Test",
            "-c",
            "user.email=test@instafy.invalid",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "core.hooksPath=/dev/null",
        ])
        .args(args)
        .current_dir(folder)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("HOME", home)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

/// The stand-in controller: it records every request, signs nothing itself, and answers as the
/// controller does for the routes a lane turn uses.
#[derive(Clone, Default)]
struct StandIn {
    jwks: Arc<Mutex<Value>>,
    origin: Arc<Mutex<String>>,
    /// Every request, as its path and its JSON body (null when it had none), in order.
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    /// The job was stopped: its heartbeat is refused, as the controller refuses a cancelled job's.
    stopped: Arc<AtomicBool>,
    /// What `/runtime/register` answers.
    registered: Arc<Mutex<Value>>,
    /// What `/lease/acquire` answers instead of a lease: a status and its body.
    lease_refusal: Arc<Mutex<Option<(u16, String)>>>,
}

async fn controller(
    State(stand_in): State<StandIn>,
    uri: Uri,
    body: Bytes,
) -> axum::response::Response {
    let path = uri.path().to_string();
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    stand_in.requests.lock().push((path.clone(), body));
    match path.as_str() {
        "/.well-known/jwks.json" => Json(stand_in.jwks.lock().clone()).into_response(),
        "/agent/heartbeat" if stand_in.stopped.load(Ordering::SeqCst) => {
            (AxumStatusCode::CONFLICT, "job lease no longer held").into_response()
        }
        "/lease/acquire" => match stand_in.lease_refusal.lock().clone() {
            Some((status, body)) => {
                (AxumStatusCode::from_u16(status).unwrap(), body).into_response()
            }
            None => Json(json!({ "leaseId": Uuid::new_v4() })).into_response(),
        },
        "/access_token" => Json(json!({
            "originId": Uuid::new_v4(),
            "endpoint": stand_in.origin.lock().clone(),
            "mode": "hosted",
            "token": "origin-token",
        }))
        .into_response(),
        "/runtime/register" => Json(stand_in.registered.lock().clone()).into_response(),
        "/agent/secrets" => Json(json!({ "env": {}, "inventory": [] })).into_response(),
        _ => Json(json!({ "ok": true })).into_response(),
    }
}

/// The stand-in origin: every save is taken.
async fn origin(State(requests): State<Arc<Mutex<Vec<String>>>>, uri: Uri) -> Json<Value> {
    requests.lock().push(uri.path().to_string());
    Json(json!({ "rev": "applied", "baseRev": "base" }))
}

async fn serve(app: Router) -> (reqwest::Url, JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap())
        .parse()
        .unwrap();
    let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, task)
}

/// A space on a temporary computer: a granted `claude` (a wrapper that sets the fake's settings
/// and execs it), the space's folder as a git repository with the seeded files and another chat's
/// page, the stand-ins, and a job loop whose turns run on this computer's lane.
struct Space {
    _temp: tempfile::TempDir,
    root: PathBuf,
    folder: PathBuf,
    person: Uuid,
    stand_in: StandIn,
    origin_requests: Arc<Mutex<Vec<String>>>,
    config: Arc<Config>,
    client: Arc<ControllerClient>,
    executor: Arc<AgentExecutor>,
    registration: Registration,
    lane: &'static Lane,
    pkcs8: Vec<u8>,
    settings: Mutex<Vec<(String, String)>>,
    servers: Vec<JoinHandle<()>>,
}

impl Drop for Space {
    fn drop(&mut self) {
        for server in &self.servers {
            server.abort();
        }
    }
}

/// The origin settings of a Desktop runtime whose space has a canonical remote: its turns refresh
/// the folder before they run. Nothing listens at the remote.
fn desktop_origin_with_a_remote() -> crate::config::OriginSettings {
    crate::config::OriginSettings {
        origin_id: Uuid::new_v4(),
        bind_host: "127.0.0.1".to_string(),
        bind_port: 0,
        git_remote_url: Some("http://127.0.0.1:9/space.git".to_string()),
        git_branch: "main".to_string(),
        git_remote_name: "origin".to_string(),
        git_author_name: "Instafy Origin".to_string(),
        git_author_email: "origin@instafy.invalid".to_string(),
        rathole_bin: "rathole".to_string(),
        rathole_state_dir: PathBuf::from("/nonexistent"),
        rathole_use_subcommands: false,
        tunnel_refresh_margin: Duration::from_secs(60),
        controller_internal_token: None,
        skip_auth: false,
        enable_presence_heartbeat: false,
        presence_interval: Duration::from_secs(60),
        jwks_url: reqwest::Url::parse("http://127.0.0.1:9/.well-known/jwks.json").unwrap(),
        max_archive_bytes: 1024,
        staging_root: None,
        endpoint: None,
        protocols: vec!["http".to_string()],
        region: None,
        device_id: None,
        metadata: None,
        mode: "desktop".to_string(),
        tunnel_enabled: false,
        tunnel_provider: None,
        tunnel_hostname: None,
        tunnel_url: None,
        tunnel_id: None,
        tunnel_status: None,
        tunnel_expires_at: None,
        tunnel_last_rotation_at: None,
    }
}

impl Space {
    async fn new(latch: &'static AtomicBool) -> Self {
        Self::with_origin(latch, None).await
    }

    /// A space whose runtime has `origin_settings`.
    async fn with_origin(
        latch: &'static AtomicBool,
        origin_settings: Option<crate::config::OriginSettings>,
    ) -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(temp.path()).unwrap();
        for (name, mode) in [
            ("bin", 0o755),
            ("home", 0o700),
            ("tmp", 0o700),
            ("record", 0o700),
            ("workspace", 0o755),
        ] {
            folder(&root.join(name), mode);
        }
        let wrapper = root.join("bin/claude");
        std::fs::write(
            &wrapper,
            format!(
                "#!/bin/sh\nset -a\n. {}\nset +a\nexec {} \"$@\"\n",
                quote(root.join("fake-claude.env")),
                quote(FAKE_CLAUDE)
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let person = Uuid::new_v4();
        let home = root.join("home");
        let tmp = root.join("tmp");
        let snapshot = LaunchEnvSnapshot::from_lookup(|key| {
            Some(match key {
                "HOME" => home.clone().into_os_string(),
                "USER" | "LOGNAME" => "person".into(),
                "SHELL" => "/bin/zsh".into(),
                "TMPDIR" => tmp.clone().into_os_string(),
                "LANG" => "en_US.UTF-8".into(),
                "PATH" => "/usr/bin:/bin".into(),
                _ => return None,
            })
        });
        let grant = LaunchGrant::parse(
            RawLaunchGrant {
                bin: Some(wrapper.into_os_string()),
                path: None,
                user_id: Some(person.to_string().into()),
                env_json: None,
            },
            snapshot,
            Confinement::new([root.join("workspace")]),
            Trust::current(),
        )
        .unwrap()
        .expect("a grant");
        // A machine busy with many process tests at once can outlast the probe's own limit.
        let lane: &'static Lane = Box::leak(Box::new(
            Lane::new(grant).with_probe_timeout(Duration::from_secs(60)),
        ));

        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
            .unwrap()
            .as_ref()
            .to_vec();
        let pair = Ed25519KeyPair::from_pkcs8(&pkcs8).unwrap();
        let stand_in = StandIn::default();
        *stand_in.jwks.lock() = json!({ "keys": [{
            "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig",
            "kid": KEY_ID, "x": URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()),
        }] });
        let origin_requests: Arc<Mutex<Vec<String>>> = Arc::default();
        let (origin_url, origin_server) = serve(
            Router::new()
                .fallback(origin)
                .with_state(origin_requests.clone()),
        )
        .await;
        *stand_in.origin.lock() = origin_url.as_str().trim_end_matches('/').to_string();
        let (base_url, controller_server) = serve(
            Router::new()
                .fallback(controller)
                .with_state(stand_in.clone()),
        )
        .await;

        let project_id = Uuid::new_v4();
        let config = Arc::new(Config {
            controller_base_url: base_url.clone(),
            controller_jwks_url: base_url.join("/.well-known/jwks.json").unwrap(),
            project_id,
            runtime_id: None,
            runtime_lease_id: None,
            provider: "test-runtime".into(),
            runtime_version: "0.0.1".into(),
            capabilities: json!({ "agent": true }),
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
            workspace_root: root.join("workspace"),
            project_workspace_override: None,
            strict_mode: false,
            dev_isolation_mode: true,
            display_name: None,
            origin: origin_settings,
            codex_bin: None,
            require_codex_bin: false,
            runtime_access_token: Some("inert-test-runtime-token".into()),
            parent_dispositions_runtime_on_shutdown: false,
        });
        let client = Arc::new(ControllerClient::new(&config).unwrap());
        let executor = Arc::new(AgentExecutor::new(config.clone()));
        executor
            .processor()
            .use_claude_code_lane(lane, TurnLimits::standard().with_cleanup_latch(latch));

        // The space's folder: its own repository, with the seeded files and another chat's page.
        let space_folder = config.project_workspace_dir(&project_id);
        std::fs::create_dir_all(&space_folder).unwrap();
        write(&space_folder, "CLAUDE.md", "@AGENTS.md\n");
        write(&space_folder, "AGENTS.md", "# Rules\nShort sentences.\n");
        write(&space_folder, "README.md", "# Demo\n");
        write(&space_folder, HELD_PAGE, HELD_PAGE_TEXT);
        git(&space_folder, &home, &["init", "-q", "-b", "main"]);
        git(&space_folder, &home, &["add", "."]);
        git(&space_folder, &home, &["commit", "-q", "-m", "seed"]);
        write(&space_folder, ".instafy/pages/.gitignore", "*\n");
        write(
            &space_folder,
            ".instafy/pages/pages.json",
            &json!({ "version": 1, "pages": [{
                "folder": "sites/other",
                "title": "Other page",
                "server": ["instafy", "bind", "serve"],
                "openedAt": "2026-11-13T09:00:00Z",
                "conversationId": Uuid::new_v4().to_string(),
            }] })
            .to_string(),
        );

        // Every registration on a controller that can sign one carries an envelope, and a token
        // that may take a turn's input: neither may reach a lane job.
        let registration = Registration {
            runtime_id: Uuid::new_v4(),
            agent_token: "inert-test-agent-token".into(),
            runtime_token: None,
            lease_url: base_url.join("/agent/lease").unwrap(),
            heartbeat_url: base_url.join("/agent/heartbeat").unwrap(),
            stop_url: None,
            lease_id: None,
            proxy: Some(ProxyEnvelopePayload {
                url: "http://127.0.0.1:9/v1".into(),
                token: "inert-proxy-token".into(),
                expires_at: None,
            }),
            lease_scope: None,
            tenant_projects: Vec::new(),
            workspace_manifest: None,
            parent_lease_id: None,
            agent_token_scopes: AGENT_SCOPES.iter().map(|scope| scope.to_string()).collect(),
            agent_token_issued_at: None,
            agent_token_expires_at: None,
            agent_token_ttl: None,
        };
        let space = Self {
            _temp: temp,
            root,
            folder: space_folder,
            person,
            stand_in,
            origin_requests,
            config,
            client,
            executor,
            registration,
            lane,
            pkcs8,
            settings: Mutex::new(Vec::new()),
            servers: vec![origin_server, controller_server],
        };
        space.write_settings();
        space
    }

    fn write_settings(&self) {
        let mut text = format!(
            "FAKE_CLAUDE_RECORD_DIR={}\nFAKE_CLAUDE_FIXTURES={}\nFAKE_CLAUDE_SESSION={}\n",
            quote(self.root.join("record")),
            quote(FIXTURES),
            SESSION
        );
        for (key, value) in self.settings.lock().iter() {
            text.push_str(&format!("{key}={}\n", quote(value)));
        }
        let next = self.root.join("fake-claude.env.next");
        std::fs::write(&next, text).unwrap();
        std::fs::rename(&next, self.root.join("fake-claude.env")).unwrap();
    }

    /// A setting of the fake, for the calls from now on.
    fn set(&self, key: &str, value: &str) {
        {
            let mut settings = self.settings.lock();
            settings.retain(|(existing, _)| existing != key);
            settings.push((key.to_string(), value.to_string()));
        }
        self.write_settings();
    }

    fn scenario(&self, name: &str) {
        self.set("FAKE_CLAUDE_SCENARIO", name);
    }

    fn sign(&self, claims: &AccessTokenClaims) -> String {
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(KEY_ID.to_string());
        jsonwebtoken::encode(&header, claims, &EncodingKey::from_ed_der(&self.pkcs8)).unwrap()
    }

    fn claims(&self, runtime_id: Uuid, scopes: &[&str], run_id: Option<Uuid>) -> AccessTokenClaims {
        let issued_at = chrono::Utc::now().timestamp();
        AccessTokenClaims {
            aud: runtime_id.to_string(),
            sub: "job:claude-code-lane".to_string(),
            project_id: self.config.project_id.to_string(),
            origin_id: None,
            runtime_id: Some(runtime_id.to_string()),
            protocol: None,
            scopes: scopes.iter().map(|scope| scope.to_string()).collect(),
            lease_id: None,
            runtime_generation: None,
            run_id: run_id.map(|run| run.to_string()),
            iat: issued_at,
            exp: issued_at + 3_600,
            jti: Uuid::new_v4().to_string(),
            prefer_runtime: None,
            actor_label: None,
            browser_session_id: None,
        }
    }

    /// The job the controller leases for the person's message: a lane job as 2.5 says it is.
    fn job(&self) -> LeaseJob {
        let run_id = Uuid::new_v4();
        let token = self.sign(&self.claims(
            self.registration.runtime_id,
            &["workspace.lease.write", "origin.token.mint"],
            Some(run_id),
        ));
        serde_json::from_value(json!({
            "id": Uuid::new_v4(),
            "intent": "feature",
            "project_id": self.config.project_id,
            "run_id": run_id,
            "conversation_id": Uuid::new_v4(),
            "engine": "claude-code",
            "lease_attempts": 1,
            "workspace_token": token,
            "workspace_token_scopes": ["workspace.lease.write", "origin.token.mint"],
            "payload": {
                "user_id": self.person.to_string(),
                "prompt_text": PROMPT,
                // As the controller writes it on every write job: the workspace mode.
                "executionMode": "shared_write",
                "metadata": {
                    "agent": { "handle": "octo" },
                    "writeScope": { "mode": "unscoped" },
                    "claudeCode": { "version": 1 },
                    "aiAccessMode": "claude-code",
                    "managedAiUsed": false,
                    "input": { "kind": "person" },
                    "writeIntent": true,
                },
            },
        }))
        .unwrap()
    }

    /// The job loop's handling of `job`, as the lease loop runs it.
    async fn handle(&self, job: LeaseJob, heartbeat_seconds: u32) {
        RuntimeAgent::handle_job(
            self.client.clone(),
            self.executor.clone(),
            &self.registration,
            job,
            heartbeat_seconds,
            Arc::new(Mutex::new(HashSet::new())),
        )
        .await
        .unwrap();
    }

    fn requests_to(&self, path: &str) -> Vec<Value> {
        self.stand_in
            .requests
            .lock()
            .iter()
            .filter(|(seen, _)| seen == path)
            .map(|(_, body)| body.clone())
            .collect()
    }

    fn paths_requested(&self) -> Vec<String> {
        self.stand_in
            .requests
            .lock()
            .iter()
            .map(|(path, _)| path.clone())
            .collect()
    }

    /// The completion (or failure) of `job_id`.
    fn completion(&self, job_id: Uuid) -> Value {
        let completions: Vec<Value> = self
            .requests_to("/agent/complete")
            .into_iter()
            .filter(|body| body["job_id"] == json!(job_id))
            .collect();
        assert_eq!(completions.len(), 1, "{completions:#?}");
        completions[0].clone()
    }

    /// Every call of the fake, by its argv: the probe's and the turns'.
    fn calls(&self) -> Vec<(Vec<String>, Vec<u8>)> {
        let mut calls = Vec::new();
        for n in 0.. {
            let call = self.root.join(format!("record/call-{n}"));
            if !call.join("done").exists() {
                break;
            }
            let argv: Vec<String> = std::fs::read(call.join("argv"))
                .unwrap()
                .split(|byte| *byte == 0)
                .filter(|arg| !arg.is_empty())
                .map(|arg| String::from_utf8(arg.to_vec()).unwrap())
                .collect();
            calls.push((argv, std::fs::read(call.join("stdin")).unwrap()));
        }
        calls
    }

    /// The turns' calls: `claude --print …`.
    fn print_calls(&self) -> Vec<(Vec<String>, Vec<u8>)> {
        self.calls()
            .into_iter()
            .filter(|(argv, _)| argv.first().map(String::as_str) == Some("--print"))
            .collect()
    }

    /// The pid a scenario step recorded as `name`, in any call.
    fn pid(&self, name: &str) -> Option<i32> {
        std::fs::read_dir(self.root.join("record"))
            .ok()?
            .filter_map(Result::ok)
            .find_map(|call| std::fs::read_to_string(call.path().join(format!("{name}.pid"))).ok())
            .and_then(|pid| pid.trim().parse().ok())
    }

    fn read(&self, path: &str) -> Option<String> {
        std::fs::read_to_string(self.folder.join(path)).ok()
    }

    /// The stand-in answers `/runtime/register` for this runtime with an agent token that lasts a
    /// week: a renewal task then registers again only when the lane's capability changes.
    fn answer_registrations(&self) {
        let mut claims = self.claims(self.registration.runtime_id, &AGENT_SCOPES, None);
        claims.exp = chrono::Utc::now().timestamp() + 7 * 24 * 3_600;
        *self.stand_in.registered.lock() = json!({
            "runtime_id": self.registration.runtime_id,
            "agent_token": self.sign(&claims),
            "lease_url": "/agent/lease",
            "heartbeat_url": "/agent/heartbeat",
            "agent_token_expires_at": (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339(),
        });
    }

    /// The `claudeCode` capability the last `/runtime/register` carried.
    fn registered_capability(&self) -> Value {
        self.requests_to("/runtime/register")
            .last()
            .expect("a registration")["capabilities"]["claudeCode"]
            .clone()
    }

    /// The renewal task of a cycle that starts from `registered`, and what it publishes.
    fn renewal_task(
        &self,
        registered: Registered,
    ) -> (RegistrationRenewalTask, watch::Receiver<Option<Registered>>) {
        let (sender, receiver) = watch::channel::<Option<Registered>>(None);
        let task = RegistrationRenewalTask::spawn(
            self.config.clone(),
            self.client.clone(),
            registered,
            ShutdownSignal::new(),
            sender,
            Some(self.lane),
        );
        (task, receiver)
    }
}

fn artifact<'a>(completion: &'a Value, kind: &str) -> Option<&'a Value> {
    completion["artifacts"]
        .as_array()?
        .iter()
        .find(|artifact| artifact["kind"] == kind)
}

fn failure_code(completion: &Value) -> Option<&str> {
    artifact(completion, "claude-code/failure").and_then(|failure| failure["code"].as_str())
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks whether the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn eventually(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !condition() {
        assert!(Instant::now() < deadline, "never: {what}");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

/// A lane job runs on the person's own Claude Code and on nothing of the embedded engine's: no
/// secrets, no input task, no proxy grant (the registration carries an envelope, which would fail
/// a job without one), no Codex run. Its success saves the turn's files without Claude Code's own
/// files and files that hold a Claude key, names each of those in a not-saved step, saves a deeper
/// `.mcp.json` and a file that only names the key prefix, and leaves another chat's page as it was.
#[test]
fn a_lane_turn_runs_on_the_persons_claude_code_and_saves_through_the_lane_filter() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::new(&LATCH).await;
        space.scenario("saves");
        let job = space.job();
        space.handle(job.clone(), 60).await;

        // The branch: nothing of the embedded engine's lane.
        let paths = space.paths_requested();
        assert!(
            !paths.iter().any(|path| path == "/agent/secrets"),
            "{paths:?}"
        );
        assert!(
            !paths.iter().any(|path| path.contains("/inputs")),
            "{paths:?}"
        );
        let completion = space.completion(job.id);
        assert_eq!(completion["outcome"], "succeeded", "{completion:#}");
        assert_eq!(completion["proxy_metadata"]["provider"], "claude-code");
        assert_eq!(
            completion["proxy_metadata"]["conversation"],
            json!({
                "provider": "claude-code",
                "version": 1,
                "sessionId": SESSION,
                "runtimeId": space.registration.runtime_id.to_string(),
            })
        );
        // The reply is Claude Code's, with the folder's prefix made relative.
        assert_eq!(completion["summary"], "Renamed the project in README.md.");
        assert!(artifact(&completion, "codex/run-log").is_none());
        let run_log = artifact(&completion, "claude-code/run-log").expect("a run log");
        assert_eq!(run_log["metadata"]["provider"], "claude-code");
        let usage = artifact(&completion, "claude-code/usage").expect("usage");
        assert_eq!(usage["model"], "claude-sonnet-4-5");
        assert_eq!(usage["usage"]["output_tokens"], 40);
        assert!(!completion.to_string().contains("total_cost_usd"));

        // One run of the person's own `claude`, with the message exactly as typed, and no
        // session to resume.
        let print_calls = space.print_calls();
        assert_eq!(print_calls.len(), 1);
        let (argv, stdin) = &print_calls[0];
        assert_eq!(stdin.as_slice(), PROMPT.as_bytes());
        assert!(!argv.iter().any(|arg| arg == "--resume"), "{argv:?}");

        // What was saved, and what stayed on this computer.
        let saved: Vec<&str> =
            artifact(&completion, "origin/apply").expect("a save")["metadata"]["paths"]
                .as_array()
                .unwrap()
                .iter()
                .map(|path| path.as_str().unwrap())
                .collect();
        assert_eq!(
            saved,
            ["README.md", "notes/prefix.md", "plugins/tool/.mcp.json"]
        );
        let files = artifact(&completion, "apply/files").expect("the turn's files");
        assert_eq!(files["metadata"]["provider"], "claude-code");
        let listed: Vec<&str> = files["files"]
            .as_array()
            .unwrap()
            .iter()
            .map(|file| file["workspacePath"].as_str().unwrap())
            .collect();
        assert_eq!(listed, saved);
        assert!(
            space
                .origin_requests
                .lock()
                .iter()
                .any(|path| path == "/apply")
        );
        let steps = space.requests_to("/agent/message");
        let not_saved = steps
            .iter()
            .find(|step| step["metadata"]["kind"] == "claude_code_not_saved")
            .expect("a not-saved step");
        let content = not_saved["content"].as_str().unwrap();
        for kept in [
            ".claude/settings.json",
            "app/.Claude/agents/helper.md",
            "CLAUDE.local.md",
            "docs/claude.local.md",
            ".mcp.json",
            "notes/token.txt",
        ] {
            assert!(content.contains(kept), "{kept} in {content}");
            assert!(space.read(kept).is_some(), "{kept} stays on this computer");
        }
        assert!(!content.contains("plugins/tool/.mcp.json"), "{content}");
        assert!(!content.contains("notes/prefix.md"), "{content}");
        // A file whose name holds a key stays on this computer, and only its redacted name is
        // sent.
        assert!(content.contains("cache/[redacted].json"), "{content}");
        assert!(
            space
                .read("cache/sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV.json")
                .is_some()
        );
        assert!(
            !steps
                .iter()
                .any(|step| step.to_string().contains("sk-ant-api03"))
        );
        assert!(
            !completion.to_string().contains("sk-ant-api03"),
            "{completion:#}"
        );
        // Every note of the turn is shown under its reply, Details closed or not.
        let notes: Vec<&Value> = steps
            .iter()
            .filter(|step| {
                step["metadata"]["kind"]
                    .as_str()
                    .is_some_and(|kind| kind.starts_with("claude_code_"))
            })
            .collect();
        assert!(notes.len() >= 2, "{steps:#?}");
        for note in notes {
            assert_eq!(note["message_type"], "status", "{note:#}");
            assert_eq!(
                note["metadata"]["presentation"],
                json!({ "placement": "reply_note" }),
                "{note:#}"
            );
        }

        // Another chat's page is as it was, and not saved; a note says so.
        assert_eq!(space.read(HELD_PAGE).as_deref(), Some(HELD_PAGE_TEXT));
        assert!(!saved.contains(&HELD_PAGE));
        assert!(
            steps
                .iter()
                .any(|step| step["metadata"]["kind"] == "claude_code_held_pages"
                    && step["content"]
                        .as_str()
                        .is_some_and(|text| text.contains("Other page"))),
            "{steps:#?}"
        );

        // The turn's steps were streamed as it ran, with paths relative to the folder.
        assert!(
            steps
                .iter()
                .any(|step| step["message_type"] == "file_change"
                    && step["metadata"]["paths"] == json!(["README.md"])),
            "{steps:#?}"
        );
        assert!(!LATCH.load(Ordering::SeqCst));
    });
}

/// A failure saves nothing: its changes stay in the folder, and the job fails with its code.
#[test]
fn a_failed_turn_saves_nothing_and_reports_its_code() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::new(&LATCH).await;
        for (scenario, code) in [
            ("edit-then-plan-limit", "plan_limit"),
            ("not-signed-in", "not_signed_in"),
        ] {
            space.scenario(scenario);
            let job = space.job();
            space.handle(job.clone(), 0).await;
            let completion = space.completion(job.id);
            assert_eq!(completion["outcome"], "failed", "{completion:#}");
            assert_eq!(failure_code(&completion), Some(code), "{completion:#}");
            assert!(artifact(&completion, "claude-code/run-log").is_some());
            assert!(artifact(&completion, "codex/run-log").is_none());
            // No session to keep, and nothing saved.
            assert!(
                completion["proxy_metadata"]["conversation"].is_null(),
                "{completion:#}"
            );
        }
        assert!(space.requests_to("/lease/acquire").is_empty());
        assert!(space.origin_requests.lock().is_empty());
        assert_eq!(
            space.read("README.md").as_deref(),
            Some("# Demo, half renamed\n")
        );
        assert_eq!(space.print_calls().len(), 2);
    });
}

/// `--resume` is passed only with a session that this runtime's own registration started, and a
/// resume miss fails as `session_unavailable` with the reset state, starting no second process.
#[test]
fn only_this_runtimes_session_is_resumed_and_a_miss_resets_it() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::new(&LATCH).await;
        let state = |runtime_id: Uuid| {
            json!({
                "provider": "claude-code",
                "version": 1,
                "sessionId": SESSION,
                "runtimeId": runtime_id.to_string(),
            })
        };
        space.scenario("success");
        let mut resumed = space.job();
        resumed.payload["provider_conversation_state"] = state(space.registration.runtime_id);
        space.handle(resumed.clone(), 0).await;
        assert_eq!(space.completion(resumed.id)["outcome"], "succeeded");
        let calls = space.print_calls();
        let argv = &calls.last().unwrap().0;
        let at = argv
            .iter()
            .position(|arg| arg == "--resume")
            .expect("resumed");
        assert_eq!(argv[at + 1], SESSION);

        let mut elsewhere = space.job();
        elsewhere.payload["provider_conversation_state"] = state(Uuid::new_v4());
        space.handle(elsewhere.clone(), 0).await;
        assert_eq!(space.completion(elsewhere.id)["outcome"], "succeeded");
        let calls = space.print_calls();
        assert!(!calls.last().unwrap().0.iter().any(|arg| arg == "--resume"));

        space.scenario("resume-miss");
        let before = space.print_calls().len();
        let mut missed = space.job();
        missed.payload["provider_conversation_state"] = state(space.registration.runtime_id);
        space.handle(missed.clone(), 0).await;
        let completion = space.completion(missed.id);
        assert_eq!(completion["outcome"], "failed", "{completion:#}");
        assert_eq!(failure_code(&completion), Some("session_unavailable"));
        assert_eq!(
            completion["proxy_metadata"]["conversation"],
            json!({ "provider": "claude-code", "version": 1, "reset": true })
        );
        assert_eq!(space.print_calls().len(), before + 1, "no second run");
    });
}

/// Whether the step that names the turn's edit of another chat's page reached the stand-in: the
/// turn has read that edit, so it is the turn's to put back.
fn held_page_edit_streamed(space: &Space) -> bool {
    space.requests_to("/agent/message").iter().any(|step| {
        step["message_type"] == "file_change" && step["metadata"]["paths"] == json!([HELD_PAGE])
    })
}

/// A Stop: SIGTERM, then the kill path. The turn sends no completion, and its stopped-turn report
/// names what it changed by folder-relative paths, without Claude Code's own files. Another chat's
/// page it changed is put back first.
#[test]
fn a_stopped_turn_sends_its_report_without_claude_codes_files_and_no_completion() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Arc::new(Space::new(&LATCH).await);
        space.scenario("stop-after-edits");
        let job = space.job();
        let running = tokio::spawn({
            let space = space.clone();
            let job = job.clone();
            async move { space.handle(job, 60).await }
        });
        eventually("the turn edited README.md and started a helper", || {
            space.read("README.md").as_deref() == Some("# Demo, half renamed\n")
                && space.pid("child").is_some()
                && held_page_edit_streamed(&space)
        })
        .await;
        assert_ne!(space.read(HELD_PAGE).as_deref(), Some(HELD_PAGE_TEXT));
        let child = space.pid("child").unwrap();
        // The person presses Stop: the next heartbeat hears of it.
        space.stand_in.stopped.store(true, Ordering::SeqCst);
        tokio::time::timeout(Duration::from_secs(60), running)
            .await
            .expect("the turn stopped")
            .unwrap();

        assert!(
            space.requests_to("/agent/complete").is_empty(),
            "no completion"
        );
        let reports = space.requests_to("/agent/stopped");
        assert_eq!(reports.len(), 1, "{reports:#?}");
        let report = &reports[0];
        assert_eq!(
            report["metadata"]["paths"],
            json!(["README.md"]),
            "{report:#}"
        );
        assert_eq!(report["content"], "Applied file changes: README.md");
        assert_eq!(report["artifacts"][0]["kind"], "apply/files");
        assert_eq!(
            report["artifacts"][0]["metadata"]["provider"],
            "claude-code"
        );
        // Nothing was saved, and what the turn wrote stays in the folder, apart from another
        // chat's page, which is as it was.
        assert!(space.origin_requests.lock().is_empty());
        assert!(space.read(".claude/settings.local.json").is_some());
        assert!(space.read("CLAUDE.local.md").is_some());
        assert_eq!(space.read(HELD_PAGE).as_deref(), Some(HELD_PAGE_TEXT));
        eventually("the helper the turn started is gone", || !alive(child)).await;
        assert!(!LATCH.load(Ordering::SeqCst));
    });
}

/// While the runtime shuts down, a running turn reports nothing: no completion, no report. It
/// still puts back what it changed under another chat's page, on this computer (turn-1).
#[test]
fn a_turn_the_runtime_shutdown_ends_reports_nothing() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Arc::new(Space::new(&LATCH).await);
        let shutdown = ShutdownSignal::new();
        space
            .executor
            .processor()
            .set_shutdown_signal(shutdown.clone());
        space.scenario("stop-after-edits");
        let job = space.job();
        let running = tokio::spawn({
            let space = space.clone();
            let job = job.clone();
            async move { space.handle(job, 0).await }
        });
        eventually("the turn edited README.md and another chat's page", || {
            space.read("README.md").as_deref() == Some("# Demo, half renamed\n")
                && held_page_edit_streamed(&space)
        })
        .await;
        assert_ne!(space.read(HELD_PAGE).as_deref(), Some(HELD_PAGE_TEXT));
        shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(60), running)
            .await
            .expect("the turn ended")
            .unwrap();
        assert!(space.requests_to("/agent/complete").is_empty());
        assert!(space.requests_to("/agent/stopped").is_empty());
        assert_eq!(space.read(HELD_PAGE).as_deref(), Some(HELD_PAGE_TEXT));
        assert!(!LATCH.load(Ordering::SeqCst));
    });
}

/// When the controller refuses the pre-turn refresh the workspace lease (403), it would refuse the
/// turn's save too: the turn ends before anything of Claude Code runs, not even the probe, with
/// the refresh's record (3.1, step 3).
#[test]
fn a_turn_whose_save_the_refresh_refuses_starts_no_claude() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::with_origin(&LATCH, Some(desktop_origin_with_a_remote())).await;
        space
            .executor
            .set_local_origin_sync(Some(crate::origin::LocalOriginSync {
                origin_id: Uuid::new_v4(),
                endpoint: space.stand_in.origin.lock().clone(),
                read_only_refresh: None,
                working_state: None,
            }));
        *space.stand_in.lease_refusal.lock() =
            Some((403, "this job may not write the space".to_string()));
        space.scenario("success");
        let job = space.job();
        space.handle(job.clone(), 0).await;

        let completion = space.completion(job.id);
        assert_eq!(completion["outcome"], "failed", "{completion:#}");
        assert_eq!(
            completion["error_message"],
            "Octo can't save changes in this space right now, so it didn't start making them.",
            "{completion:#}"
        );
        let refresh = artifact(&completion, "origin/refresh").expect("the refresh's record");
        assert_eq!(refresh["metadata"]["mode"], "skipped", "{refresh:#}");
        assert_eq!(space.requests_to("/lease/acquire").len(), 1);
        assert!(space.calls().is_empty(), "not even a probe");
        assert!(space.origin_requests.lock().is_empty());
        assert_eq!(space.read("README.md").as_deref(), Some("# Demo\n"));
    });
}

/// A Stop that reaches the turn after its probe, before `claude` starts: the last check before the
/// spawn asks the controller, and nothing starts. The turn sends no completion, and no report,
/// since it changed nothing (3.1, step 6).
#[test]
fn a_stop_before_the_spawn_starts_no_claude() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::new(&LATCH).await;
        space.scenario("success");
        // No heartbeat runs: only the check right before the spawn hears of the Stop.
        space.stand_in.stopped.store(true, Ordering::SeqCst);
        let job = space.job();
        space.handle(job.clone(), 0).await;

        assert!(!space.calls().is_empty(), "the probe ran");
        assert!(space.print_calls().is_empty(), "claude never started");
        assert!(
            !space.requests_to("/agent/heartbeat").is_empty(),
            "the check before the spawn asked"
        );
        assert!(space.requests_to("/agent/complete").is_empty());
        assert!(space.requests_to("/agent/stopped").is_empty());
        assert!(space.origin_requests.lock().is_empty());
    });
}

/// A Stop while the pre-flight runs ends the turn at once, as a Stop before the spawn does: no
/// completion, no report, nothing of Claude Code, and the job's locks are released, so the next
/// turn runs (3.9, preflight-parser-cost-unbudgeted). Here the pre-flight's git waits to open an
/// index that is a named pipe, which no one writes.
#[test]
fn a_stop_during_the_preflight_ends_the_turn_and_the_next_one_runs() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Arc::new(Space::new(&LATCH).await);
        space.scenario("success");
        let index = space.folder.join(".git/index");
        let kept = space.folder.join(".git/index.kept");
        std::fs::rename(&index, &kept).unwrap();
        let made = std::process::Command::new("mkfifo")
            .arg(&index)
            .status()
            .unwrap();
        assert!(made.success());
        let job = space.job();
        let running = tokio::spawn({
            let space = space.clone();
            let job = job.clone();
            async move { space.handle(job, 60).await }
        });
        // The turn checks the workspace token after its first lease check, then readies the
        // folder and starts the pre-flight.
        eventually("the turn verified its workspace token", || {
            !space.requests_to("/.well-known/jwks.json").is_empty()
        })
        .await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        space.stand_in.stopped.store(true, Ordering::SeqCst);
        // The heartbeat hears of the Stop within about a second; git would wait 30 seconds.
        tokio::time::timeout(Duration::from_secs(15), running)
            .await
            .expect("the turn ended at the Stop")
            .unwrap();
        assert!(space.requests_to("/agent/complete").is_empty());
        assert!(space.requests_to("/agent/stopped").is_empty());
        assert!(space.calls().is_empty(), "not even a probe");

        std::fs::remove_file(&index).unwrap();
        std::fs::rename(&kept, &index).unwrap();
        space.stand_in.stopped.store(false, Ordering::SeqCst);
        let next = space.job();
        tokio::time::timeout(Duration::from_secs(120), space.handle(next.clone(), 0))
            .await
            .expect("the next turn ran");
        let completion = space.completion(next.id);
        assert_eq!(completion["outcome"], "succeeded", "{completion:#}");
        assert!(!LATCH.load(Ordering::SeqCst));
    });
}

/// The pre-flight's text names no absolute path: git's own words about a broken repository go
/// through the turn's redactor, as every string the lane sends does (3.6,
/// preflight-git-error-names-os-user).
#[test]
fn a_preflight_failure_names_the_folder_only_relative_to_itself() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::new(&LATCH).await;
        space.scenario("success");
        std::fs::rename(space.folder.join(".git"), space.folder.join("git-away")).unwrap();
        let missing = space.folder.join("missing");
        write(
            &space.folder,
            ".git",
            &format!("gitdir: {}\n", missing.display()),
        );
        let job = space.job();
        space.handle(job.clone(), 0).await;

        let completion = space.completion(job.id);
        assert_eq!(
            failure_code(&completion),
            Some("preflight_failed"),
            "{completion:#}"
        );
        let message = completion["error_message"].as_str().unwrap();
        assert!(
            message.starts_with("git couldn't list this space's files")
                && message.contains("missing"),
            "{message}"
        );
        assert!(
            !message.contains(&space.root.display().to_string()),
            "{message}"
        );
        assert!(space.print_calls().is_empty(), "no turn started");
    });
}

/// A run that went well whose folder's `git status` cannot be read at its end saves nothing: its
/// reply is delivered, with a note under it that its changes stayed on this computer (3.8,
/// step 1).
#[test]
fn a_turn_whose_changes_cannot_be_read_saves_nothing_and_says_so() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::new(&LATCH).await;
        space.scenario("status-unreadable");
        let job = space.job();
        space.handle(job.clone(), 0).await;

        let completion = space.completion(job.id);
        assert_eq!(completion["outcome"], "succeeded", "{completion:#}");
        assert_eq!(completion["summary"], "Renamed the project in README.md.");
        let files = artifact(&completion, "apply/files").expect("the turn's files");
        assert_eq!(files["files"], json!([]), "{files:#}");
        assert!(artifact(&completion, "origin/apply").is_none());
        assert!(space.origin_requests.lock().is_empty());
        assert!(space.requests_to("/lease/acquire").is_empty());
        let steps = space.requests_to("/agent/message");
        let note = steps
            .iter()
            .find(|step| step["metadata"]["kind"] == "claude_code_changes_not_saved")
            .expect("a note that the changes stayed on this computer");
        assert_eq!(note["metadata"]["reason"], "status_unreadable");
        assert_eq!(
            note["metadata"]["presentation"],
            json!({ "placement": "reply_note" })
        );
        assert!(
            note["content"]
                .as_str()
                .unwrap()
                .starts_with("Claude Code's changes stayed on this computer"),
            "{note:#}"
        );
        assert_eq!(
            space.read("README.md").as_deref(),
            Some("# Demo, renamed\n")
        );
    });
}

/// A save that fails after a run that went well fails nothing (D-C/D-V): the reply is delivered
/// with a note that the changes stayed on this computer, Details has the error, redacted, and the
/// turn's files list nothing, since nothing was saved.
#[test]
fn a_save_that_fails_after_a_good_run_delivers_the_reply_with_a_note() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::new(&LATCH).await;
        space.scenario("success");
        let folder = space.folder.display().to_string();
        *space.stand_in.lease_refusal.lock() = Some((
            500,
            format!("the store under {folder} is down (sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX)"),
        ));
        let job = space.job();
        space.handle(job.clone(), 60).await;

        let completion = space.completion(job.id);
        assert_eq!(completion["outcome"], "succeeded", "{completion:#}");
        assert_eq!(
            completion["summary"],
            "Renamed the project in README.md and wrote docs/notes.md."
        );
        assert!(failure_code(&completion).is_none(), "{completion:#}");
        let files = artifact(&completion, "apply/files").expect("the turn's files");
        assert_eq!(files["files"], json!([]), "{files:#}");
        assert!(artifact(&completion, "origin/apply").is_none());
        let error = artifact(&completion, "origin/apply-error").expect("the save's error")
            ["metadata"]["error"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(error.contains("500"), "{error}");
        assert!(error.contains("[redacted]"), "{error}");
        assert!(!error.contains("sk-ant-api03"), "{error}");
        assert!(!error.contains(&folder), "{error}");
        assert!(space.origin_requests.lock().is_empty());

        let steps = space.requests_to("/agent/message");
        let note = steps
            .iter()
            .find(|step| step["metadata"]["kind"] == "claude_code_changes_not_saved")
            .expect("a note that the changes stayed on this computer");
        assert_eq!(
            note["content"],
            "Claude Code's changes stayed on this computer and weren't saved to the space."
        );
        assert_eq!(note["message_type"], "status");
        assert_eq!(note["metadata"]["reason"], "save_failed");
        assert_eq!(
            note["metadata"]["paths"],
            json!(["README.md", "docs/notes.md"])
        );
        assert_eq!(
            note["metadata"]["presentation"],
            json!({ "placement": "reply_note" })
        );
        // The changes are in the folder on this computer.
        assert_eq!(
            space.read("README.md").as_deref(),
            Some("# Demo, renamed\n")
        );
        assert!(space.read("docs/notes.md").is_some());
        assert!(space.requests_to("/agent/stopped").is_empty());
    });
}

/// The refusals before spawning: a job the job loop refuses runs nothing at all (no heartbeat,
/// no secrets, no probe), and one the turn refuses starts no `claude -p`.
#[test]
fn a_refused_turn_starts_no_claude() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::new(&LATCH).await;
        space.scenario("success");

        // In the job loop, before anything of the job runs.
        let mut someone_else = space.job();
        someone_else.payload["user_id"] = json!(Uuid::new_v4().to_string());
        let mut unknown = space.job();
        unknown.engine = Some("another-engine".into());
        let mut again = space.job();
        again.lease_attempts = 2;
        let mut typed_by_nobody = space.job();
        typed_by_nobody.payload["metadata"]["automation"] = json!({ "id": "nightly" });
        let mut command = space.job();
        command.payload["prompt_text"] = json!("/terminal ls");
        for job in [&someone_else, &unknown, &again, &typed_by_nobody, &command] {
            space.handle(job.clone(), 60).await;
            let completion = space.completion(job.id);
            assert_eq!(completion["outcome"], "failed", "{completion:#}");
            assert!(failure_code(&completion).is_none(), "{completion:#}");
        }
        assert!(
            space.requests_to("/agent/complete")[1]["error_message"]
                .as_str()
                .unwrap()
                .contains("another-engine")
        );
        assert!(space.requests_to("/agent/heartbeat").is_empty());
        assert!(space.requests_to("/agent/secrets").is_empty());
        assert!(space.calls().is_empty(), "not even a probe");

        // A workspace token that does not verify (another key signed it).
        let mut forged = space.job();
        let other_key = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let mut header = Header::new(Algorithm::EdDSA);
        header.kid = Some(KEY_ID.to_string());
        forged.workspace_token = Some(
            jsonwebtoken::encode(
                &header,
                &space.claims(
                    space.registration.runtime_id,
                    &["workspace.lease.write", "origin.token.mint"],
                    forged.run_id,
                ),
                &EncodingKey::from_ed_der(other_key.as_ref()),
            )
            .unwrap(),
        );
        space.handle(forged.clone(), 0).await;
        assert_eq!(space.completion(forged.id)["outcome"], "failed");

        // The pre-flight: a folder with no repository, where nothing could say what a turn
        // changed (D-A).
        std::fs::rename(space.folder.join(".git"), space.folder.join("git-away")).unwrap();
        let unrecorded = space.job();
        space.handle(unrecorded.clone(), 0).await;
        let completion = space.completion(unrecorded.id);
        assert_eq!(failure_code(&completion), Some("preflight_failed"));
        assert_eq!(
            completion["error_message"].as_str().unwrap().lines().next(),
            Some(
                "This space's folder on this computer has no git repository, so Instafy couldn't tell what a turn changes."
            ),
            "{completion:#}"
        );
        std::fs::rename(space.folder.join("git-away"), space.folder.join(".git")).unwrap();

        // The pre-flight: the person's own settings at the folder's root.
        write(&space.folder, ".claude/settings.local.json", "{}");
        let configured = space.job();
        space.handle(configured.clone(), 0).await;
        let completion = space.completion(configured.id);
        assert_eq!(failure_code(&completion), Some("project_config"));
        assert!(
            completion["error_message"]
                .as_str()
                .unwrap()
                .contains(".claude/settings.local.json"),
            "{completion:#}"
        );
        std::fs::remove_dir_all(space.folder.join(".claude")).unwrap();

        // The per-turn probe decides: a `claude` that is too old now fails the turn.
        space.set("FAKE_CLAUDE_VERSION", "old");
        let outdated = space.job();
        space.handle(outdated.clone(), 0).await;
        assert_eq!(
            failure_code(&space.completion(outdated.id)),
            Some("unsupported_version")
        );
        assert_eq!(
            space.lane.capability().unwrap()["reason"],
            "unsupported_version"
        );

        assert!(space.print_calls().is_empty(), "no turn started");
        assert!(space.requests_to("/agent/secrets").is_empty());
    });
}

/// A runtime whose process captured no grant (as here: nothing ran the capture) runs a leased lane
/// job on nothing: the job fails as `binary_missing` before any heartbeat, secrets fetch or probe.
#[test]
fn a_lane_job_on_a_runtime_without_a_lane_fails_as_binary_missing() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::new(&LATCH).await;
        space.scenario("success");
        // The job loop of this runtime, without the test lane `Space` gives its own.
        let executor = Arc::new(AgentExecutor::new(space.config.clone()));
        let job = space.job();
        RuntimeAgent::handle_job(
            space.client.clone(),
            executor,
            &space.registration,
            job.clone(),
            60,
            Arc::new(Mutex::new(HashSet::new())),
        )
        .await
        .unwrap();
        let completion = space.completion(job.id);
        assert_eq!(completion["outcome"], "failed", "{completion:#}");
        assert_eq!(failure_code(&completion), Some("binary_missing"));
        assert!(space.requests_to("/agent/heartbeat").is_empty());
        assert!(space.requests_to("/agent/secrets").is_empty());
        assert!(space.calls().is_empty(), "not even a probe");
    });
}

/// A lane job leased together with another job fails, and the other runs as before.
#[test]
fn a_lane_job_in_a_batch_fails_and_the_rest_go_on() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::new(&LATCH).await;
        space.scenario("success");
        let lane_job = space.job();
        let mut other: LeaseJob = serde_json::from_value(json!({
            "id": Uuid::new_v4(),
            "project_id": space.config.project_id,
            "payload": { "metadata": { "execution_mode": "plan_only" } },
            "lease_attempts": 1,
        }))
        .unwrap();
        other.lease_attempts = 1;
        RuntimeAgent::handle_job_batch(
            space.client.clone(),
            space.executor.clone(),
            &space.registration,
            vec![lane_job.clone(), other.clone()],
            0,
            Arc::new(Mutex::new(HashSet::new())),
        )
        .await
        .unwrap();
        let refused = space.completion(lane_job.id);
        assert_eq!(refused["outcome"], "failed");
        assert!(
            refused["error_message"]
                .as_str()
                .unwrap()
                .contains("together with other work"),
            "{refused:#}"
        );
        let ran = space.completion(other.id);
        assert!(
            ran["error_message"].as_str().unwrap().contains("plan_only"),
            "{ran:#}"
        );
        assert!(space.calls().is_empty());
    });
}

/// A probe that changes the capability registers again with the new value: the per-turn probe
/// that disagrees with it, and the timed probe while it says not ready, once the person fixed
/// Claude Code (3.2).
#[test]
fn a_probe_that_changes_the_capability_registers_again() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::new(&LATCH).await;
        space.answer_registrations();
        // Registered as ready: the startup probe.
        assert!(space.lane.probe_and_publish().await.readiness.is_ready());
        let mut registration = space.registration.clone();
        registration.agent_token_expires_at =
            Some((chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339());
        let (renewal, mut renewed) = space.renewal_task(Registered {
            registration,
            claude_code: space.lane.capability(),
        });

        // A turn's probe disagrees: Claude Code was replaced by an older one.
        space.set("FAKE_CLAUDE_VERSION", "old");
        let probe = space.lane.probe_and_publish().await;
        assert!(probe.capability_changed);
        tokio::time::timeout(Duration::from_secs(30), renewed.changed())
            .await
            .expect("registered again")
            .unwrap();
        assert_eq!(
            space.registered_capability(),
            json!({ "version": 1, "ready": false, "reason": "unsupported_version" })
        );
        assert_eq!(
            space.requests_to("/runtime/register").last().unwrap()["capabilities"]["agent"],
            true
        );

        // While it says not ready, a timed probe notices that the person updated Claude Code.
        let reprobe = tokio::spawn(
            space
                .lane
                .reprobe_while_not_ready(Duration::from_millis(100)),
        );
        space.set("FAKE_CLAUDE_VERSION", "supported");
        tokio::time::timeout(Duration::from_secs(30), renewed.changed())
            .await
            .expect("registered again")
            .unwrap();
        let capability = space.registered_capability();
        assert_eq!(capability["ready"], true, "{capability}");
        assert_eq!(capability["cli"], "2.1.314");
        reprobe.abort();
        renewal.abort().await;
        assert_eq!(space.requests_to("/runtime/register").len(), 2);
    });
}

/// A capability a probe publishes after a registration read it, and before the renewal task of
/// that registration subscribed, registers again: the subscription counts it as seen, and nothing
/// publishes it again (3.2). Right after a fresh registration, and after a renewal that the next
/// cycle adopts while it restarts its origin and tunnel. A task that starts from the value the lane
/// still publishes registers nothing.
#[test]
fn a_capability_published_before_the_renewal_task_starts_registers_again() {
    static LATCH: AtomicBool = AtomicBool::new(false);
    on_a_worker_stack(async {
        let space = Space::new(&LATCH).await;
        space.answer_registrations();
        let not_ready = json!({ "version": 1, "ready": false, "reason": "unsupported_version" });

        // A cycle registers as ready.
        assert!(space.lane.probe_and_publish().await.readiness.is_ready());
        let ready = space.lane.capability().expect("published");
        let registered = Registered::register(&space.client, &space.config, Some(space.lane))
            .await
            .unwrap();
        assert_eq!(registered.claude_code.as_ref(), Some(&ready));
        assert_eq!(space.registered_capability(), ready);

        // While it starts its origin and tunnel, a probe finds an older Claude Code.
        space.set("FAKE_CLAUDE_VERSION", "old");
        assert!(space.lane.probe_and_publish().await.capability_changed);
        let (renewal, mut renewed) = space.renewal_task(registered);
        tokio::time::timeout(Duration::from_secs(30), renewed.changed())
            .await
            .expect("registered again")
            .unwrap();
        assert_eq!(space.registered_capability(), not_ready);
        let adopted = renewed.borrow_and_update().clone().expect("a renewal");
        assert_eq!(adopted.claude_code.as_ref(), Some(&not_ready));
        renewal.abort().await;

        // The next cycle adopts that renewal; before its task starts, the person updates Claude Code.
        space.set("FAKE_CLAUDE_VERSION", "supported");
        assert!(space.lane.probe_and_publish().await.capability_changed);
        let (renewal, mut renewed) = space.renewal_task(adopted);
        tokio::time::timeout(Duration::from_secs(30), renewed.changed())
            .await
            .expect("registered again")
            .unwrap();
        assert_eq!(space.registered_capability(), ready);
        let adopted = renewed.borrow_and_update().clone().expect("a renewal");
        assert_eq!(adopted.claude_code.as_ref(), Some(&ready));
        renewal.abort().await;

        // Nothing changed since: the next cycle's task registers nothing.
        let registrations = space.requests_to("/runtime/register").len();
        assert_eq!(registrations, 3);
        let (renewal, renewed) = space.renewal_task(adopted);
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!renewed.has_changed().unwrap());
        renewal.abort().await;
        assert_eq!(space.requests_to("/runtime/register").len(), registrations);
    });
}
