//! End-to-end checks of the shard's push policy. Each test starts the real
//! `git-shard` binary on a private port and talks to it with a git client
//! over Smart HTTP, the same way Git Edge forwards traffic.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use runtime_contracts::{
    GIT_SALVAGE_SCOPE, GIT_SALVAGE_TOKEN_SUBJECT, GIT_SALVAGE_TOKEN_TTL_SECONDS,
};
use serde_json::{json, Value};

const SHARD_BIN: &str = env!("CARGO_BIN_EXE_git-shard");

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Self {
        // Tests run in parallel and the clock may not tick between two calls,
        // so a counter keeps every directory distinct.
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "instafy-shard-{label}-{}-{nanos}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).expect("create a fresh temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn real_git() -> String {
    let output = Command::new("sh")
        .args(["-c", "command -v git"])
        .output()
        .expect("locate git");
    let path = String::from_utf8(output.stdout).expect("utf-8 git path");
    let path = path.trim();
    assert!(!path.is_empty(), "git is not on PATH");
    path.to_string()
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .expect("reserve a local port")
}

/// Waits until this shard process answers its own `/healthz`. Any listener
/// accepts a TCP connect, so only the shard's `ok` body proves the port is its.
fn wait_until_serving(child: &mut Child, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().unwrap() {
            return Err(format!("git-shard exited early with {status}"));
        }
        if shard_answers_health(port) && child.try_wait().unwrap().is_none() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err("git-shard did not answer /healthz".to_string())
}

fn shard_answers_health(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(b"GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") && response.ends_with("ok")
}

fn write_executable(path: &Path, contents: &str) {
    std::fs::write(path, contents).expect("write script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
            .expect("mark script executable");
    }
}

/// A running `git-shard` with one project repository.
struct Shard {
    child: Child,
    port: u16,
    project_id: String,
    spawn_log: PathBuf,
    root: TempDir,
}

impl Shard {
    fn start(label: &str, extra_env: &[(&str, &str)]) -> Self {
        let root = TempDir::new(label);
        let bin_dir = root.path().join("bin");
        let home = root.path().join("home");
        std::fs::create_dir_all(&bin_dir).unwrap();
        std::fs::create_dir_all(&home).unwrap();

        // Every `git` the shard process starts itself goes through this
        // wrapper, which records the arguments with the parent's pid.
        let spawn_log = root.path().join("git-spawns.log");
        write_executable(
            &bin_dir.join("git"),
            &format!(
                "#!/bin/sh\nprintf '%s %s\\n' \"$PPID\" \"$*\" >> '{}'\nexec '{}' \"$@\"\n",
                spawn_log.display(),
                real_git()
            ),
        );

        // The port is free only until the shard binds it, so shards in this
        // test process start one at a time.
        static STARTING: Mutex<()> = Mutex::new(());
        let _starting = STARTING.lock().unwrap_or_else(|error| error.into_inner());
        // Another listener in this test process can take the reserved port before
        // the shard binds it, so a start only counts once the shard itself answers
        // /healthz while still running, and a lost race starts again on a new port.
        let mut last_failure = String::new();
        for _ in 0..5 {
            let port = free_port();
            let log = std::fs::File::create(root.path().join("shard.log")).unwrap();
            let mut command = Command::new(SHARD_BIN);
            command
                .env_clear()
                .env(
                    "PATH",
                    format!(
                        "{}:{}",
                        bin_dir.display(),
                        std::env::var("PATH").unwrap_or_default()
                    ),
                )
                .env("HOME", &home)
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("RUST_LOG", "warn")
                .env("GIT_SHARD_BIND_HOST", "127.0.0.1")
                .env("GIT_SHARD_BIND_PORT", port.to_string())
                .env("GIT_REPO_ROOT", root.path().join("repos"))
                .env("GIT_AUTO_INIT", "1")
                .env("GIT_DEFAULT_BRANCH", "main")
                .env("GIT_JWKS_URL", "http://127.0.0.1:9/jwks")
                // Neither may reach a hook: the first would replace the shared
                // hooks directory, the second would unlock salvage refs.
                .env("GIT_CONFIG_PARAMETERS", "'core.hookspath'='/nonexistent'")
                .env("INSTAFY_GIT_SALVAGE_PUSH", "1");
            for (key, value) in extra_env {
                command.env(key, value);
            }
            let mut child = command
                .stdin(Stdio::null())
                .stdout(log.try_clone().unwrap())
                .stderr(log)
                .spawn()
                .expect("start git-shard");
            match wait_until_serving(&mut child, port) {
                Ok(()) => {
                    return Self {
                        child,
                        port,
                        project_id: uuid::Uuid::new_v4().to_string(),
                        spawn_log,
                        root,
                    };
                }
                Err(failure) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    last_failure = format!(
                        "{failure}: {}",
                        std::fs::read_to_string(root.path().join("shard.log")).unwrap_or_default()
                    );
                }
            }
        }
        panic!("git-shard did not start serving: {last_failure}");
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/{}.git", self.port, self.project_id)
    }

    fn repo(&self) -> PathBuf {
        self.root
            .path()
            .join("repos")
            .join(format!("{}.git", self.project_id))
    }

    fn shared_hooks_dir(&self) -> PathBuf {
        self.root.path().join("repos").join(".instafy-hooks")
    }

    fn push_reports_dir(&self) -> PathBuf {
        self.root.path().join("repos").join(".instafy-push-reports")
    }

    /// Run git directly against the shard's bare repository.
    fn repo_git(&self, args: &[&str]) -> Output {
        Command::new("git")
            .arg("--git-dir")
            .arg(self.repo())
            .args(args)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .output()
            .expect("run git on the shard repo")
    }

    fn repo_rev(&self, refname: &str) -> Option<String> {
        let output = self.repo_git(&["rev-parse", "--verify", "--quiet", refname]);
        output
            .status
            .success()
            .then(|| String::from_utf8(output.stdout).unwrap().trim().to_string())
    }

    fn has_object(&self, oid: &str) -> bool {
        self.repo_git(&["cat-file", "-e", oid]).status.success()
    }

    /// `git` commands this shard process started itself since the last clear.
    fn spawns(&self) -> Vec<String> {
        let pid = self.child.id().to_string();
        std::fs::read_to_string(&self.spawn_log)
            .unwrap_or_default()
            .lines()
            .filter_map(|line| line.split_once(' '))
            .filter(|(parent, _)| *parent == pid)
            .map(|(_, args)| args.to_string())
            .collect()
    }

    fn clear_spawns(&self) {
        let _ = std::fs::remove_file(&self.spawn_log);
    }
}

impl Drop for Shard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// A git working copy cloned from a shard.
struct Client {
    dir: PathBuf,
    home: PathBuf,
    _root: TempDir,
}

impl Client {
    fn clone_from(shard: &Shard) -> Self {
        let root = TempDir::new("client");
        let home = root.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        let dir = root.path().join("work");
        let client = Self {
            dir: root.path().to_path_buf(),
            home,
            _root: root,
        };
        client.git_ok(&["clone", "-q", &shard.url(), "work"]);
        Self { dir, ..client }
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new("git");
        command
            .args(args)
            .current_dir(&self.dir)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .env_remove("GIT_CONFIG_PARAMETERS")
            .env_remove("GIT_CONFIG_COUNT")
            .env("HOME", &self.home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_AUTHOR_NAME", "Test Author")
            .env("GIT_AUTHOR_EMAIL", "author@example.test")
            .env("GIT_COMMITTER_NAME", "Test Author")
            .env("GIT_COMMITTER_EMAIL", "author@example.test");
        command
    }

    fn git(&self, args: &[&str]) -> Output {
        self.command(args).output().expect("run git")
    }

    fn git_ok(&self, args: &[&str]) -> String {
        let output = self.git(args);
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn git_with_stdin(&self, args: &[&str], stdin: &[u8]) -> String {
        let mut child = self
            .command(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("run git");
        child.stdin.take().unwrap().write_all(stdin).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_string()
    }

    fn head(&self) -> String {
        self.git_ok(&["rev-parse", "HEAD"])
    }

    fn commit_file(&self, path: &str, contents: &[u8], message: &str) -> String {
        let file = self.dir.join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, contents).unwrap();
        self.git_ok(&["add", "--", path]);
        self.git_ok(&["commit", "-q", "-m", message]);
        self.head()
    }

    fn push(&self, refspec: &str) -> Output {
        self.git(&["push", "origin", refspec])
    }

    fn push_ok(&self, refspec: &str) {
        let output = self.push(refspec);
        assert!(
            output.status.success(),
            "push {refspec} was refused: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    /// Push and return stderr, asserting the shard refused it.
    fn push_refused(&self, refspec: &str) -> String {
        let output = self.push(refspec);
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        assert!(
            !output.status.success(),
            "push {refspec} was accepted: {stderr}"
        );
        stderr
    }

    /// Push with `token` as the bearer credential, as Git Edge forwards it.
    fn push_as(&self, token: &str, refspecs: &[&str]) -> Output {
        let header = format!("http.extraHeader=Authorization: Bearer {token}");
        let mut args = vec!["-c", header.as_str(), "push", "origin"];
        args.extend_from_slice(refspecs);
        self.git(&args)
    }

    fn push_as_ok(&self, token: &str, refspecs: &[&str]) {
        let output = self.push_as(token, refspecs);
        assert!(
            output.status.success(),
            "push {refspecs:?} was refused: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn push_as_refused(&self, token: &str, refspecs: &[&str]) -> String {
        let output = self.push_as(token, refspecs);
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        assert!(
            !output.status.success(),
            "push {refspecs:?} was accepted: {stderr}"
        );
        stderr
    }
}

/// Deterministic bytes that zlib cannot compress much.
fn noise(len: usize) -> Vec<u8> {
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            (state >> 24) as u8
        })
        .collect()
}

fn dir_entries(dir: &Path) -> Vec<String> {
    let mut entries = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .collect::<Vec<_>>();
    entries.sort();
    entries
}

fn hook_files(shard: &Shard) -> Vec<(String, Vec<u8>, SystemTime)> {
    dir_entries(&shard.shared_hooks_dir())
        .into_iter()
        .map(|name| {
            let path = shard.shared_hooks_dir().join(&name);
            let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
            (name, std::fs::read(&path).unwrap(), modified)
        })
        .collect()
}

#[test]
fn requests_never_write_hook_files_or_run_git_config() {
    // Push events are on, so the event path is counted too.
    let sink = WebhookSink::start();
    let webhook = sink.url();
    let shard = Shard::start("spawns", &[("GIT_EVENTS_WEBHOOK_URL", webhook.as_str())]);
    let client = Client::clone_from(&shard);
    let repo = shard.repo();

    let hooks_before = hook_files(&shard);
    assert_eq!(
        hooks_before
            .iter()
            .map(|(name, _, _)| name.as_str())
            .collect::<Vec<_>>(),
        ["post-receive", "update"]
    );
    let config_before = std::fs::read(repo.join("config")).unwrap();
    // No request may recreate a per-repository hooks directory.
    std::fs::remove_dir_all(repo.join("hooks")).unwrap();
    shard.clear_spawns();

    client.commit_file("notes/one.txt", b"one\n", "one");
    client.push_ok("main");
    client.git_ok(&["fetch", "-q", "origin"]);
    client.git_ok(&["ls-remote", "origin"]);
    client.commit_file("notes/two.txt", b"two\n", "two");
    client.push_ok("main");
    sink.wait_for(2);

    let spawns = shard.spawns();
    assert!(
        spawns.len() >= 4,
        "expected one git http-backend per request, got {spawns:?}"
    );
    for spawn in &spawns {
        assert_eq!(spawn, "http-backend", "a request ran more than the backend");
    }
    assert!(!repo.join("hooks").exists());
    assert_eq!(std::fs::read(repo.join("config")).unwrap(), config_before);
    assert_eq!(hook_files(&shard), hooks_before);
    // Each push's report file is removed once its event is built.
    assert!(dir_entries(&shard.push_reports_dir()).is_empty());
}

#[test]
fn repository_without_hooks_dir_still_gets_the_shared_policy() {
    let shard = Shard::start("no-hooks-dir", &[]);
    let client = Client::clone_from(&shard);
    let initial = shard.repo_rev("refs/heads/main").unwrap();
    std::fs::remove_dir_all(shard.repo().join("hooks")).unwrap();

    client.commit_file("node_modules/pkg/index.js", b"x\n", "vendor");
    let stderr = client.push_refused("main");
    assert!(
        stderr.contains("instafy: blocked path 'node_modules/pkg/index.js'"),
        "{stderr}"
    );
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), initial);

    client.git_ok(&["reset", "-q", "--hard", &initial]);
    let accepted = client.commit_file("src/app.txt", b"ok\n", "app");
    client.push_ok("main");
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), accepted);
}

#[test]
fn per_repository_hooks_and_hooks_path_are_ignored() {
    let shard = Shard::start("old-hooks", &[]);
    let client = Client::clone_from(&shard);
    let initial = shard.repo_rev("refs/heads/main").unwrap();

    // Hooks an older shard left in the repository would refuse everything.
    let repo_hooks = shard.repo().join("hooks");
    std::fs::create_dir_all(&repo_hooks).unwrap();
    for name in ["update", "pre-receive"] {
        write_executable(&repo_hooks.join(name), "#!/bin/sh\nexit 1\n");
    }
    // A repository-level hooksPath would allow everything.
    let permissive = shard.root.path().join("permissive-hooks");
    std::fs::create_dir_all(&permissive).unwrap();
    write_executable(&permissive.join("update"), "#!/bin/sh\nexit 0\n");
    let configured = shard.repo_git(&["config", "core.hooksPath", permissive.to_str().unwrap()]);
    assert!(configured.status.success());

    let accepted = client.commit_file("src/app.txt", b"ok\n", "app");
    client.push_ok("main");
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), accepted);

    client.commit_file("dist/app.js", b"built\n", "build output");
    let stderr = client.push_refused("main");
    assert!(
        stderr.contains("instafy: blocked path 'dist/app.js'"),
        "{stderr}"
    );
    assert_ne!(shard.repo_rev("refs/heads/main").unwrap(), initial);
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), accepted);
}

/// Collects `git.push.received` webhooks on a local port.
struct WebhookSink {
    port: u16,
    events: Arc<(Mutex<Vec<Value>>, Condvar)>,
}

impl WebhookSink {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let events = Arc::new((Mutex::new(Vec::new()), Condvar::new()));
        let sink = Arc::clone(&events);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                if let Some(event) = read_json_request(stream) {
                    let (lock, ready) = &*sink;
                    lock.lock().unwrap().push(event);
                    ready.notify_all();
                }
            }
        });
        Self { port, events }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/git/hooks/events", self.port)
    }

    fn wait_for(&self, count: usize) -> Vec<Value> {
        let (lock, ready) = &*self.events;
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut events = lock.lock().unwrap();
        while events.len() < count {
            let left = deadline.saturating_duration_since(Instant::now());
            assert!(!left.is_zero(), "expected {count} events, got {events:?}");
            events = ready.wait_timeout(events, left).unwrap().0;
        }
        events.clone()
    }
}

fn read_json_request(mut stream: TcpStream) -> Option<Value> {
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut content_length = 0usize;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.trim().parse().ok()?;
            }
        }
    }
    let mut body = vec![0; content_length];
    reader.read_exact(&mut body).ok()?;
    let _ = stream.write_all(
        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
    );
    serde_json::from_slice(&body).ok()
}

fn updates(event: &Value) -> &Value {
    assert_eq!(event["kind"], "git.push.received");
    &event["updates"]
}

#[test]
fn push_events_carry_each_refs_old_and_new_revision() {
    let sink = WebhookSink::start();
    let webhook = sink.url();
    let shard = Shard::start("events", &[("GIT_EVENTS_WEBHOOK_URL", webhook.as_str())]);
    let client = Client::clone_from(&shard);
    let initial = client.head();

    // Fast-forward of the default branch.
    let first = client.commit_file("a.txt", b"a\n", "a");
    client.push_ok("main");
    let events = sink.wait_for(1);
    assert_eq!(events[0]["projectId"], json!(shard.project_id));
    assert_eq!(
        updates(&events[0]),
        &json!([{
            "refName": "refs/heads/main",
            "oldRev": initial,
            "newRev": first,
            "deleted": false,
        }])
    );

    // A new branch has no old revision.
    client.git_ok(&["checkout", "-q", "-b", "feature"]);
    let feature_one = client.commit_file("feature.txt", b"1\n", "feature 1");
    client.push_ok("feature");
    let events = sink.wait_for(2);
    assert_eq!(
        updates(&events[1]),
        &json!([{
            "refName": "refs/heads/feature",
            "newRev": feature_one,
            "deleted": false,
        }])
    );

    // An update of a branch other than main.
    let feature_two = client.commit_file("feature.txt", b"2\n", "feature 2");
    client.push_ok("feature");
    let events = sink.wait_for(3);
    assert_eq!(
        updates(&events[2]),
        &json!([{
            "refName": "refs/heads/feature",
            "oldRev": feature_one,
            "newRev": feature_two,
            "deleted": false,
        }])
    );

    // A refused push changes no ref and sends no event; the next one is exact.
    client.git_ok(&["checkout", "-q", "main"]);
    client.commit_file("build/out.js", b"x\n", "build output");
    client.push_refused("main");
    client.git_ok(&["reset", "-q", "--hard", &first]);
    let second = client.commit_file("b.txt", b"b\n", "b");
    client.git_ok(&["tag", "v1"]);
    client.push_ok("main");
    let output = client.git(&["push", "origin", "refs/tags/v1", ":refs/heads/feature"]);
    assert!(output.status.success());
    // Refs outside branches and tags are not reported.
    let third = client.commit_file("c.txt", b"c\n", "c");
    let recovery = format!(
        "refs/instafy/recovery/{}/20261002T120000Z-unpublished",
        uuid::Uuid::new_v4()
    );
    let output = client.git(&["push", "origin", "main", &format!("HEAD:{recovery}")]);
    assert!(output.status.success());
    let events = sink.wait_for(6);
    assert_eq!(
        updates(&events[3]),
        &json!([{
            "refName": "refs/heads/main",
            "oldRev": first,
            "newRev": second,
            "deleted": false,
        }])
    );
    assert_eq!(
        updates(&events[4]),
        &json!([
            {
                "refName": "refs/heads/feature",
                "oldRev": feature_two,
                "deleted": true,
            },
            {
                "refName": "refs/tags/v1",
                "newRev": second,
                "deleted": false,
            },
        ])
    );
    assert_eq!(
        updates(&events[5]),
        &json!([{
            "refName": "refs/heads/main",
            "oldRev": second,
            "newRev": third,
            "deleted": false,
        }])
    );
    assert_eq!(shard.repo_rev(&recovery).unwrap(), third);
}

#[test]
fn merges_and_multi_commit_branches_get_path_and_size_checks() {
    let shard = Shard::start("merges", &[("GIT_MAX_BLOB_BYTES", "4096")]);
    let client = Client::clone_from(&shard);
    let initial = client.head();

    // A merge whose second parent adds a denied path.
    client.git_ok(&["checkout", "-q", "-b", "side"]);
    client.commit_file("node_modules/left-pad/index.js", b"x\n", "vendor");
    client.git_ok(&["checkout", "-q", "main"]);
    client.commit_file("README.md", b"readme\n", "readme");
    client.git_ok(&["merge", "-q", "--no-ff", "--no-edit", "side"]);
    let merge = client.head();
    for target in ["refs/heads/feature", "refs/heads/main"] {
        let stderr = client.push_refused(&format!("{merge}:{target}"));
        assert!(
            stderr.contains("instafy: blocked path 'node_modules/left-pad/index.js'"),
            "{target}: {stderr}"
        );
    }
    assert!(shard.repo_rev("refs/heads/feature").is_none());
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), initial);

    // A merge whose second parent adds a blob over the size limit.
    client.git_ok(&["checkout", "-q", "-B", "big-side", &initial]);
    client.commit_file("assets/big.bin", &noise(8192), "big");
    client.git_ok(&["checkout", "-q", "-B", "main", &initial]);
    client.commit_file("README.md", b"readme 2\n", "readme 2");
    client.git_ok(&["merge", "-q", "--no-ff", "--no-edit", "big-side"]);
    let big_merge = client.head();
    let stderr = client.push_refused(&format!("{big_merge}:refs/heads/big"));
    assert!(
        stderr.contains("instafy: file too large 'assets/big.bin' (8192 bytes > 4096)"),
        "{stderr}"
    );

    // A new branch whose last commit changes only a clean path, while an
    // earlier new commit added a denied path that the tip still contains.
    client.git_ok(&["checkout", "-q", "-B", "chain", &initial]);
    client.commit_file("coverage/report.html", b"x\n", "coverage");
    let chain_tip = client.commit_file("notes.txt", b"later\n", "later");
    let stderr = client.push_refused(&format!("{chain_tip}:refs/heads/chain"));
    assert!(
        stderr.contains("instafy: blocked path 'coverage/report.html'"),
        "{stderr}"
    );

    // A clean merge is accepted as a new branch and as main.
    client.git_ok(&["checkout", "-q", "-B", "clean-side", &initial]);
    client.commit_file("docs/a.md", b"a\n", "a");
    client.git_ok(&["checkout", "-q", "-B", "main", &initial]);
    client.commit_file("docs/b.md", b"b\n", "b");
    client.git_ok(&["merge", "-q", "--no-ff", "--no-edit", "clean-side"]);
    let clean_merge = client.head();
    client.push_ok(&format!("{clean_merge}:refs/heads/clean"));
    client.push_ok(&format!("{clean_merge}:refs/heads/main"));
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), clean_merge);
}

#[test]
fn unusual_file_names_are_checked_as_stored() {
    let shard = Shard::start("names", &[("GIT_MAX_BLOB_BYTES", "4096")]);
    let client = Client::clone_from(&shard);
    let initial = client.head();

    for path in [
        "node_modules/caf\u{e9}.js",
        "node_modules/\"quoted\".js",
        "app/node_modules/tab\there.js",
    ] {
        client.git_ok(&["reset", "-q", "--hard", &initial]);
        client.commit_file(path, b"x\n", "vendor");
        let stderr = client.push_refused("main");
        assert!(stderr.contains("instafy: blocked path"), "{path}: {stderr}");
    }

    client.git_ok(&["reset", "-q", "--hard", &initial]);
    client.commit_file("assets/caf\u{e9} \"big\".bin", &noise(8192), "big");
    let stderr = client.push_refused("main");
    assert!(stderr.contains("instafy: file too large"), "{stderr}");
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), initial);
}

#[test]
fn refs_must_point_to_commits() {
    let shard = Shard::start("ref-types", &[("GIT_MAX_BLOB_BYTES", "4096")]);
    let client = Client::clone_from(&shard);

    let blob = client.git_with_stdin(&["hash-object", "-w", "--stdin"], &noise(8192));
    let stderr = client.push_refused(&format!("{blob}:refs/tags/raw-blob"));
    assert!(
        stderr.contains("instafy: 'refs/tags/raw-blob' must point to a commit"),
        "{stderr}"
    );
    let tree = client.git_ok(&["rev-parse", "HEAD^{tree}"]);
    let stderr = client.push_refused(&format!("{tree}:refs/tags/raw-tree"));
    assert!(stderr.contains("must point to a commit"), "{stderr}");
    assert!(shard.repo_rev("refs/tags/raw-blob").is_none());

    client.git_ok(&["tag", "-a", "-m", "release", "v1"]);
    client.push_ok("refs/tags/v1");
    assert!(shard.repo_rev("refs/tags/v1").is_some());
}

#[test]
fn salvage_refs_cannot_be_changed_by_a_push() {
    // The salvage check runs before GIT_POLICY_DISABLED, and the shard drops
    // the INSTAFY_GIT_SALVAGE_PUSH it was started with.
    let shard = Shard::start("salvage", &[("GIT_POLICY_DISABLED", "1")]);
    let client = Client::clone_from(&shard);
    let initial = client.head();
    let work = client.commit_file("work.txt", b"work\n", "work");

    for target in [
        "refs/instafy/salvage/gateway/node-1-abcdef12",
        "refs/instafy/salvage",
    ] {
        let stderr = client.push_refused(&format!("{work}:{target}"));
        assert!(
            stderr.contains(&format!(
                "instafy: '{target}' holds salvaged work and cannot be changed by a push"
            )),
            "{stderr}"
        );
        assert!(shard.repo_rev(target).is_none());
    }

    // Letter-case variants are refused by name, whatever the filesystem.
    for target in [
        "refs/instafy/SALVAGE/gateway/node-1-abcdef12",
        "refs/INSTAFY/salvage/gateway/node-1-abcdef12",
    ] {
        let stderr = client.push_refused(&format!("{work}:{target}"));
        assert!(
            stderr.contains(&format!(
                "instafy: '{target}' holds salvaged work and cannot be changed by a push"
            )),
            "{stderr}"
        );
    }

    let existing = "refs/instafy/salvage/gateway/node-2-12345678";
    assert!(shard
        .repo_git(&["update-ref", existing, &initial])
        .status
        .success());
    client.push_refused(&format!(":{existing}"));
    client.push_refused(&format!("+{work}:{existing}"));
    assert_eq!(shard.repo_rev(existing).unwrap(), initial);

    // Recovery refs stay writable and deletable for git.write holders.
    let recovery = format!(
        "refs/instafy/recovery/{}/20261002T120000Z-unpublished-{}",
        uuid::Uuid::new_v4(),
        &work[..8]
    );
    client.push_ok(&format!("{work}:{recovery}"));
    assert_eq!(shard.repo_rev(&recovery).unwrap(), work);
    client.push_ok(&format!(":{recovery}"));
    assert!(shard.repo_rev(&recovery).is_none());

    // The policy switch itself is on for this shard.
    client.commit_file("node_modules/x.js", b"x\n", "vendor");
    client.push_ok("main");
}

#[test]
fn refs_instafy_holds_only_recovery_refs_and_main_has_no_aliases() {
    let shard = Shard::start("ref-names", &[]);
    let client = Client::clone_from(&shard);
    let initial = client.head();
    let work = client.commit_file("work.txt", b"work\n", "work");

    // A name that differs from main only in letter case is the same file on a
    // case-insensitive filesystem. The hook refuses it by name everywhere.
    for target in ["refs/heads/MAIN", "refs/Heads/main"] {
        let stderr = client.push_refused(&format!("+{work}:{target}"));
        assert!(
            stderr.contains(&format!(
                "instafy: '{target}' differs from refs/heads/main only in letter case"
            )),
            "{stderr}"
        );
    }
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), initial);

    // A leaf at refs/instafy/recovery would block every recovery ref.
    let origin = uuid::Uuid::new_v4();
    for target in [
        "refs/instafy/recovery".to_string(),
        format!("refs/instafy/recovery/{origin}"),
        "refs/instafy/notes/x".to_string(),
    ] {
        let stderr = client.push_refused(&format!("{work}:{target}"));
        assert!(
            stderr.contains(&format!("instafy: '{target}' is not a recovery ref")),
            "{stderr}"
        );
        assert!(shard.repo_rev(&target).is_none());
    }
    let recovery = format!("refs/instafy/recovery/{origin}/20261002T120000Z-unpublished");
    client.push_ok(&format!("{work}:{recovery}"));
    assert_eq!(shard.repo_rev(&recovery).unwrap(), work);
    client.push_ok(&format!(":{recovery}"));
    assert!(shard.repo_rev(&recovery).is_none());
}

/// Publishes an Ed25519 JWKS on a local port, the way the controller does,
/// and signs tokens with the matching key.
struct TokenIssuer {
    port: u16,
    pkcs8: Vec<u8>,
}

const TEST_KEY_ID: &str = "salvage-test-key";

impl TokenIssuer {
    fn start() -> Self {
        let pkcs8 = new_ed25519_pkcs8();
        let x = URL_SAFE_NO_PAD.encode(ed25519_public_key(&pkcs8));
        let jwks = json!({
            "keys": [{
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "use": "sig",
                "kid": TEST_KEY_ID,
                "x": x,
            }]
        })
        .to_string();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let Ok(reader) = stream.try_clone() else {
                    continue;
                };
                let mut reader = BufReader::new(reader);
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim_end().is_empty() {
                        break;
                    }
                }
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{jwks}",
                        jwks.len()
                    )
                    .as_bytes(),
                );
            }
        });
        Self { port, pkcs8 }
    }

    fn jwks_url(&self) -> String {
        format!("http://127.0.0.1:{}/.well-known/jwks.json", self.port)
    }

    fn sign(&self, claims: &Value) -> String {
        sign_with(&self.pkcs8, claims)
    }
}

fn new_ed25519_pkcs8() -> Vec<u8> {
    let rng = ring::rand::SystemRandom::new();
    ring::signature::Ed25519KeyPair::generate_pkcs8(&rng)
        .expect("generate an Ed25519 key")
        .as_ref()
        .to_vec()
}

fn ed25519_public_key(pkcs8: &[u8]) -> Vec<u8> {
    use ring::signature::KeyPair as _;
    ring::signature::Ed25519KeyPair::from_pkcs8(pkcs8)
        .expect("parse the Ed25519 key")
        .public_key()
        .as_ref()
        .to_vec()
}

fn sign_with(pkcs8: &[u8], claims: &Value) -> String {
    let mut header = jsonwebtoken::Header::new(jsonwebtoken::Algorithm::EdDSA);
    header.kid = Some(TEST_KEY_ID.to_string());
    jsonwebtoken::encode(
        &header,
        claims,
        &jsonwebtoken::EncodingKey::from_ed_der(pkcs8),
    )
    .expect("sign a test token")
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

/// The exact claims the controller mints for `git.salvage`.
fn salvage_claims(project_id: &str) -> Value {
    let issued_at = now_seconds();
    json!({
        "aud": "git",
        "sub": GIT_SALVAGE_TOKEN_SUBJECT,
        "project_id": project_id,
        "protocol": "git",
        "scopes": [GIT_SALVAGE_SCOPE],
        "iat": issued_at,
        "exp": issued_at + GIT_SALVAGE_TOKEN_TTL_SECONDS,
        "jti": uuid::Uuid::new_v4().to_string(),
    })
}

fn salvage_ref(commit: &str) -> String {
    format!("refs/instafy/salvage/gateway/node-1.a_b-{}", &commit[..8])
}

#[test]
fn salvage_credential_may_only_create_salvage_refs() {
    let issuer = TokenIssuer::start();
    let jwks = issuer.jwks_url();
    let shard = Shard::start(
        "salvage-credential",
        &[
            ("GIT_JWKS_URL", jwks.as_str()),
            ("GIT_MAX_BLOB_BYTES", "4096"),
        ],
    );
    let client = Client::clone_from(&shard);
    let initial = client.head();
    let token = issuer.sign(&salvage_claims(&shard.project_id));

    let work = client.commit_file("notes/kept.md", b"kept\n", "kept");
    let salvage = salvage_ref(&work);

    // Without the credential salvage refs stay closed.
    let stderr = client.push_refused(&format!("{work}:{salvage}"));
    assert!(
        stderr.contains(&format!(
            "instafy: '{salvage}' holds salvaged work and cannot be changed by a push"
        )),
        "{stderr}"
    );
    assert!(shard.repo_rev(&salvage).is_none());

    // With it the ref is created, and only created: never moved or deleted.
    client.push_as_ok(&token, &[&format!("{work}:{salvage}")]);
    assert_eq!(shard.repo_rev(&salvage).unwrap(), work);
    let later = client.commit_file("notes/later.md", b"later\n", "later");
    for refspec in [format!("+{later}:{salvage}"), format!(":{salvage}")] {
        let stderr = client.push_as_refused(&token, &[&refspec]);
        assert!(
            stderr.contains(&format!(
                "instafy: salvage push refused: '{salvage}' holds salvaged work and may only be created"
            )),
            "{refspec}: {stderr}"
        );
    }
    assert_eq!(shard.repo_rev(&salvage).unwrap(), work);

    // Every other ref in a salvage push is refused, even ones a git.write
    // push may change; the salvage ref next to them is still created.
    let recovery = format!(
        "refs/instafy/recovery/{}/20261002T120000Z-unpublished",
        uuid::Uuid::new_v4()
    );
    let next = salvage_ref(&later);
    let stderr = client.push_as_refused(
        &token,
        &[
            &format!("{later}:refs/heads/main"),
            &format!("{later}:refs/heads/feature"),
            &format!("{later}:{recovery}"),
            &format!("{later}:{next}"),
        ],
    );
    for refname in ["refs/heads/main", "refs/heads/feature", recovery.as_str()] {
        assert!(
            stderr.contains(&format!(
                "instafy: salvage push refused: only refs/instafy/salvage/gateway/<name> refs may be created, not '{refname}'"
            )),
            "{refname}: {stderr}"
        );
    }
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), initial);
    assert!(shard.repo_rev("refs/heads/feature").is_none());
    assert!(shard.repo_rev(&recovery).is_none());
    assert_eq!(shard.repo_rev(&next).unwrap(), later);

    // A name too long for a ref file is refused by the hook with a clear,
    // permanent message, not by a failure to lock the ref.
    let too_long = format!(
        "refs/instafy/salvage/gateway/{}-{}",
        "n".repeat(300),
        &later[..8]
    );
    let stderr = client.push_as_refused(&token, &[&format!("{later}:{too_long}")]);
    assert!(
        stderr.contains(&format!(
            "instafy: salvage push refused: '{too_long}' is not a valid salvage ref name"
        )),
        "{stderr}"
    );
    assert!(shard.repo_rev(&too_long).is_none());

    // Path, size and object checks still apply.
    client.git_ok(&["reset", "-q", "--hard", &initial]);
    let vendored = client.commit_file("node_modules/pkg/index.js", b"x\n", "vendor");
    let stderr =
        client.push_as_refused(&token, &[&format!("{vendored}:{}", salvage_ref(&vendored))]);
    assert!(
        stderr.contains("instafy: blocked path 'node_modules/pkg/index.js'"),
        "{stderr}"
    );
    assert!(shard.repo_rev(&salvage_ref(&vendored)).is_none());

    client.git_ok(&["reset", "-q", "--hard", &initial]);
    let big = client.commit_file("assets/big.bin", &noise(8192), "big");
    let stderr = client.push_as_refused(&token, &[&format!("{big}:{}", salvage_ref(&big))]);
    assert!(
        stderr.contains("instafy: file too large 'assets/big.bin' (8192 bytes > 4096)"),
        "{stderr}"
    );

    let blob = client.git_with_stdin(&["hash-object", "-w", "--stdin"], b"payload\n");
    let tree = literal_tree(&client, &[("100644", b"..", &blob)]);
    let bad = client.git_ok(&["commit-tree", "-p", &initial, "-m", "entry", &tree]);
    let stderr = client.push_as_refused(&token, &[&format!("{bad}:{}", salvage_ref(&bad))]);
    assert!(stderr.contains("fsck error in packed object"), "{stderr}");
    assert!(!shard.has_object(&bad));
    assert!(shard.repo_rev(&salvage_ref(&bad)).is_none());
}

#[test]
fn the_shard_checks_the_salvage_credential_itself() {
    let issuer = TokenIssuer::start();
    let jwks = issuer.jwks_url();
    let shard = Shard::start("salvage-claims", &[("GIT_JWKS_URL", jwks.as_str())]);
    let client = Client::clone_from(&shard);
    let initial = client.head();
    let work = client.commit_file("notes/kept.md", b"kept\n", "kept");
    let salvage = salvage_ref(&work);
    let exact = salvage_claims(&shard.project_id);

    let reshaped = |change: &dyn Fn(&mut Value)| {
        let mut claims = exact.clone();
        change(&mut claims);
        issuer.sign(&claims)
    };
    let other_key = new_ed25519_pkcs8();
    let refused_tokens = [
        ("another signing key", sign_with(&other_key, &exact)),
        (
            "another project",
            issuer.sign(&salvage_claims(&uuid::Uuid::new_v4().to_string())),
        ),
        (
            "another audience",
            reshaped(&|claims| claims["aud"] = json!("runtime")),
        ),
        (
            "another subject",
            reshaped(&|claims| claims["sub"] = json!(uuid::Uuid::new_v4().to_string())),
        ),
        (
            "an extra scope",
            reshaped(&|claims| claims["scopes"] = json!([GIT_SALVAGE_SCOPE, "git.write"])),
        ),
        (
            "a longer lifetime",
            reshaped(&|claims| claims["exp"] = json!(claims["exp"].as_i64().unwrap() + 60)),
        ),
        (
            "a runtime binding",
            reshaped(&|claims| claims["runtime_id"] = json!(uuid::Uuid::new_v4().to_string())),
        ),
        (
            "an expired token",
            reshaped(&|claims| {
                let issued_at = now_seconds() - 600;
                claims["iat"] = json!(issued_at);
                claims["exp"] = json!(issued_at + GIT_SALVAGE_TOKEN_TTL_SECONDS);
            }),
        ),
    ];
    for (label, token) in &refused_tokens {
        // The shard refuses the whole request (401 or 403), so a token that
        // names git.salvage never pushes as an ordinary write either: the
        // fast-forward of main below would otherwise be accepted.
        for refspec in [
            format!("{work}:{salvage}"),
            format!("{work}:refs/heads/main"),
        ] {
            let stderr = client.push_as_refused(token, &[&refspec]);
            assert!(
                !stderr.contains("instafy:"),
                "{label} {refspec} reached the hook: {stderr}"
            );
        }
    }
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), initial);
    assert!(shard.repo_rev(&salvage).is_none());

    // An ordinary signed git.write token is left to Git Edge as before: it
    // pushes main, and salvage refs stay closed to it.
    let mut write = exact.clone();
    write["sub"] = json!(uuid::Uuid::new_v4().to_string());
    write["scopes"] = json!(["git.read", "git.write"]);
    let write = issuer.sign(&write);
    let stderr = client.push_as_refused(&write, &[&format!("{work}:{salvage}")]);
    assert!(
        stderr.contains(&format!(
            "instafy: '{salvage}' holds salvaged work and cannot be changed by a push"
        )),
        "{stderr}"
    );
    client.push_as_ok(&write, &[&format!("{work}:refs/heads/main")]);
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), work);
    assert!(shard.repo_rev(&salvage).is_none());
}

fn hex_to_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&hex[index..index + 2], 16).unwrap())
        .collect()
}

/// Write a tree object with exactly the given entries, bypassing the checks
/// `git mktree` and `git hash-object` would apply.
fn literal_tree(client: &Client, entries: &[(&str, &[u8], &str)]) -> String {
    let mut bytes = Vec::new();
    for (mode, name, oid) in entries {
        bytes.extend_from_slice(mode.as_bytes());
        bytes.push(b' ');
        bytes.extend_from_slice(name);
        bytes.push(0);
        bytes.extend_from_slice(&hex_to_bytes(oid));
    }
    client.git_with_stdin(
        &["hash-object", "-w", "-t", "tree", "--literally", "--stdin"],
        &bytes,
    )
}

#[test]
fn object_checks_refuse_trees_with_dot_dot_or_dot_git_entries() {
    let shard = Shard::start("fsck", &[]);
    let client = Client::clone_from(&shard);
    let initial = client.head();
    let blob = client.git_with_stdin(&["hash-object", "-w", "--stdin"], b"payload\n");
    let config_tree = literal_tree(&client, &[("100644", b"config", &blob)]);

    let cases: [(&str, &[u8], &str); 5] = [
        ("100644", b"..", &blob),
        ("40000", b".GIT", &config_tree),
        ("40000", b"git~1", &config_tree),
        ("40000", ".git\u{200c}".as_bytes(), &config_tree),
        ("120000", b".gitmodules", &blob),
    ];
    for (mode, name, oid) in cases {
        let label = String::from_utf8_lossy(name).to_string();
        let tree = literal_tree(&client, &[(mode, name, oid)]);
        let commit = client.git_ok(&["commit-tree", "-p", &initial, "-m", "entry", &tree]);
        for target in ["refs/heads/main", "refs/heads/candidate"] {
            let stderr = client.push_refused(&format!("{commit}:{target}"));
            assert!(
                stderr.contains("fsck error in packed object"),
                "{label}: {stderr}"
            );
        }
        assert!(!shard.has_object(&commit), "{label}: commit was stored");
        assert!(!shard.has_object(&tree), "{label}: tree was stored");
    }
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), initial);
    assert!(shard.repo_rev("refs/heads/candidate").is_none());

    // A normal commit still goes through after the refusals.
    client.git_ok(&["reset", "-q", "--hard", &initial]);
    let accepted = client.commit_file("ok.txt", b"ok\n", "ok");
    client.push_ok("main");
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), accepted);
}

#[test]
fn push_size_is_bounded() {
    let shard = Shard::start("push-size", &[("GIT_MAX_PUSH_BYTES", "16384")]);
    let client = Client::clone_from(&shard);
    let initial = client.head();

    client.commit_file("data.bin", &noise(64 * 1024), "data");
    let stderr = client.push_refused("main");
    assert!(
        stderr.contains("pack exceeds maximum allowed size"),
        "{stderr}"
    );
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), initial);

    client.git_ok(&["reset", "-q", "--hard", &initial]);
    let accepted = client.commit_file("small.txt", b"small\n", "small");
    client.push_ok("main");
    assert_eq!(shard.repo_rev("refs/heads/main").unwrap(), accepted);
}

#[test]
fn a_foreign_listener_on_the_port_is_never_taken_for_the_shard() {
    // Another test's webhook sink can hold a reserved port; answering a connect
    // (or even HTTP 200) must not make a start look ready.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            let mut request = [0u8; 512];
            let _ = stream.read(&mut request);
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}",
            );
        }
    });
    assert!(!shard_answers_health(port));
    server.join().unwrap();
    assert!(
        !shard_answers_health(port),
        "a closed port is not a shard either"
    );
}
