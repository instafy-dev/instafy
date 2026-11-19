//! `PROXY_STATIC_PLATFORM_CREDENTIALS` on the `proxy` binary with controller
//! integration configured: unset keeps static credentials for this release
//! and warns, on keeps them quietly, and off never reads them. Every value is
//! inert and nothing leaves loopback: the controller address is a closed local
//! port, which the proxy does not call to start or to answer `/healthz`.
#![cfg(unix)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::Value;

const PROXY_BIN: &str = env!("CARGO_BIN_EXE_proxy");
const STARTUP_WARNING: &str =
    "WARNING: managed runs are served from this proxy's own static credentials";
const LOAD_FAILURE: &str = "unable to load local credentials";

/// The spawned proxy, killed if a test fails before it is stopped.
struct Proxy(Child);

impl Drop for Proxy {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// A private Codex home, removed when the test ends.
struct CodexHome(PathBuf);

impl CodexHome {
    /// Holds an `auth.json` the proxy cannot parse, so any attempt to read
    /// static credentials from it says so on stderr.
    fn with_unreadable_auth_file() -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "instafy-proxy-static-platform-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join("auth.json"), "not json").unwrap();
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for CodexHome {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .expect("reserve a local port")
}

/// The proxy's own `/healthz` answer, once it serves.
fn health(port: u16) -> Option<Value> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    stream
        .write_all(b"GET /healthz HTTP/1.1\r\nhost: proxy\r\nconnection: close\r\n\r\n")
        .ok()?;
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    if !response.starts_with("HTTP/1.1 200") {
        return None;
    }
    serde_json::from_str(response.split_once("\r\n\r\n")?.1).ok()
}

/// Starts the proxy with controller integration, `setting` and an
/// `OPENAI_API_KEY` if given, reads its `/healthz`, stops it, and returns that
/// answer and what it wrote to stderr.
fn start(setting: Option<&str>, openai_api_key: Option<&str>) -> (Value, String) {
    let codex_home = CodexHome::with_unreadable_auth_file();
    let port = free_port();
    let mut command = Command::new(PROXY_BIN);
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", codex_home.path())
        .env("CODEX_HOME", codex_home.path())
        .env("CODEX_PROXY_ADDR", format!("127.0.0.1:{port}"))
        .env(
            "CONTROLLER_BASE_URL",
            format!("http://127.0.0.1:{}", free_port()),
        )
        .env("CONTROLLER_INTERNAL_TOKEN", "inert-internal-token")
        .env("PROXY_CREDENTIAL_LEASE_TOKEN", "inert-lease-token")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if let Some(key) = openai_api_key {
        command.env("OPENAI_API_KEY", key);
    }
    if let Some(setting) = setting {
        command.env("PROXY_STATIC_PLATFORM_CREDENTIALS", setting);
    }
    let mut proxy = Proxy(command.spawn().expect("start the proxy"));
    let deadline = Instant::now() + Duration::from_secs(30);
    let answer = loop {
        if let Some(status) = proxy.0.try_wait().unwrap() {
            let mut stderr = String::new();
            let _ = proxy.0.stderr.take().unwrap().read_to_string(&mut stderr);
            panic!("the proxy exited early with {status}: {stderr}");
        }
        if let Some(answer) = health(port) {
            break answer;
        }
        assert!(
            Instant::now() < deadline,
            "the proxy did not answer /healthz"
        );
        std::thread::sleep(Duration::from_millis(50));
    };
    let _ = proxy.0.kill();
    let _ = proxy.0.wait();
    let mut stderr = String::new();
    proxy
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut stderr)
        .unwrap();
    (answer, stderr)
}

#[test]
fn unset_keeps_static_credentials_for_this_release_and_warns() {
    let (health, stderr) = start(None, Some("inert-not-a-key"));
    assert_eq!(health["backend"], "remote_static");
    assert_eq!(health["platformLane"]["servedBy"], "static");
    assert!(stderr.contains(STARTUP_WARNING), "{stderr}");
    assert!(
        stderr.contains("PROXY_STATIC_PLATFORM_CREDENTIALS=1"),
        "{stderr}"
    );
}

#[test]
fn on_keeps_static_credentials_without_a_warning() {
    let (health, stderr) = start(Some("1"), Some("inert-not-a-key"));
    assert_eq!(health["backend"], "remote_static");
    assert_eq!(health["platformLane"]["servedBy"], "static");
    assert!(!stderr.contains("WARNING"), "{stderr}");
}

#[test]
fn off_never_reads_static_credentials() {
    // An API key in the environment is not used: managed runs lease the
    // controller's managed credential.
    let (health, stderr) = start(Some("0"), Some("inert-not-a-key"));
    assert_eq!(health["backend"], "remote_dynamic");
    assert_eq!(health["platformLane"]["servedBy"], "controller_lease");
    assert!(stderr.contains("uses no static credentials"), "{stderr}");
    assert!(!stderr.contains("WARNING"), "{stderr}");

    // Without a key the proxy would read auth.json, and say it cannot parse
    // this one; switched off, it never opens it.
    let (_, stderr) = start(None, None);
    assert!(stderr.contains(LOAD_FAILURE), "{stderr}");
    let (health, stderr) = start(Some("off"), None);
    assert_eq!(health["backend"], "remote_dynamic");
    assert!(!stderr.contains(LOAD_FAILURE), "{stderr}");
}
