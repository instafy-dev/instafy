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
        "/lease/acquire" => Json(json!({ "leaseId": Uuid::new_v4() })).into_response(),
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

impl Space {
    async fn new(latch: &'static AtomicBool) -> Self {
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
            origin: None,
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
        assert!(
            !steps
                .iter()
                .any(|step| step.to_string().contains("sk-ant-api03"))
        );

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

/// A Stop: SIGTERM, then the kill path. The turn sends no completion, and its stopped-turn report
/// names what it changed by folder-relative paths, without Claude Code's own files.
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
        })
        .await;
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
        // Nothing was saved, and what the turn wrote stays in the folder.
        assert!(space.origin_requests.lock().is_empty());
        assert!(space.read(".claude/settings.local.json").is_some());
        assert!(space.read("CLAUDE.local.md").is_some());
        eventually("the helper the turn started is gone", || !alive(child)).await;
        assert!(!LATCH.load(Ordering::SeqCst));
    });
}

/// While the runtime shuts down, a running turn reports nothing: no completion, no report.
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
        eventually("the turn edited README.md", || {
            space.read("README.md").as_deref() == Some("# Demo, half renamed\n")
        })
        .await;
        shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(60), running)
            .await
            .expect("the turn ended")
            .unwrap();
        assert!(space.requests_to("/agent/complete").is_empty());
        assert!(space.requests_to("/agent/stopped").is_empty());
        assert!(!LATCH.load(Ordering::SeqCst));
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
        let registered = space.claims(space.registration.runtime_id, &AGENT_SCOPES, None);
        let mut registered = registered;
        registered.exp = chrono::Utc::now().timestamp() + 7 * 24 * 3_600;
        let agent_token = space.sign(&registered);
        *space.stand_in.registered.lock() = json!({
            "runtime_id": space.registration.runtime_id,
            "agent_token": agent_token,
            "lease_url": "/agent/lease",
            "heartbeat_url": "/agent/heartbeat",
            "agent_token_expires_at": (chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339(),
        });
        // Registered as ready: the startup probe.
        assert!(space.lane.probe_and_publish().await.readiness.is_ready());
        let mut registration = space.registration.clone();
        registration.agent_token_expires_at =
            Some((chrono::Utc::now() + chrono::Duration::days(7)).to_rfc3339());
        let (renewed_sender, mut renewed) = watch::channel::<Option<Registration>>(None);
        let renewal = RegistrationRenewalTask::spawn(
            space.config.clone(),
            space.client.clone(),
            registration,
            ShutdownSignal::new(),
            renewed_sender,
            Some(space.lane),
        );
        let registered_capability = |space: &Space| {
            space.requests_to("/runtime/register").last().unwrap()["capabilities"]["claudeCode"]
                .clone()
        };

        // A turn's probe disagrees: Claude Code was replaced by an older one.
        space.set("FAKE_CLAUDE_VERSION", "old");
        let probe = space.lane.probe_and_publish().await;
        assert!(probe.capability_changed);
        tokio::time::timeout(Duration::from_secs(30), renewed.changed())
            .await
            .expect("registered again")
            .unwrap();
        assert_eq!(
            registered_capability(&space),
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
        let capability = registered_capability(&space);
        assert_eq!(capability["ready"], true, "{capability}");
        assert_eq!(capability["cli"], "2.1.314");
        reprobe.abort();
        renewal.abort().await;
        assert_eq!(space.requests_to("/runtime/register").len(), 2);
    });
}
