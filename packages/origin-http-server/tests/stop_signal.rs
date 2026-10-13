//! The gateway binary stops on SIGTERM, which `docker stop` sends, through
//! its graceful shutdown: it stops taking connections, lets the request in
//! progress finish, and exits 0.
#![cfg(unix)]

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const ORIGIN_BIN: &str = env!("CARGO_BIN_EXE_origin-http-server");

/// The spawned gateway, killed if a test fails before it exits.
struct Gateway(Child);

impl Drop for Gateway {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .expect("reserve a local port")
}

/// Only the gateway's own `ok` proves the port is its.
fn answers_health(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(b"GET /healthz HTTP/1.1\r\nhost: origin\r\nconnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") && response.ends_with("ok")
}

fn wait_until_serving(gateway: &mut Gateway, port: u16) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(status) = gateway.0.try_wait().unwrap() {
            panic!("the gateway exited early with {status}");
        }
        if answers_health(port) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("the gateway did not answer /healthz");
}

fn wait_until_refusing(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        match TcpStream::connect(("127.0.0.1", port)) {
            Err(error) if error.kind() == ErrorKind::ConnectionRefused => return,
            _ => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    panic!("the gateway still takes connections after SIGTERM");
}

fn wait_for_exit(gateway: &mut Gateway, within: Duration) -> ExitStatus {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if let Some(status) = gateway.0.try_wait().unwrap() {
            return status;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("the gateway did not exit within {within:?}");
}

fn send_sigterm(gateway: &Gateway) {
    let status = Command::new("kill")
        .args(["-TERM", &gateway.0.id().to_string()])
        .status()
        .expect("run kill");
    assert!(status.success(), "kill -TERM failed: {status}");
}

#[test]
fn sigterm_finishes_the_request_in_progress_and_exits_zero() {
    let root = tempfile::tempdir().unwrap();
    let port = free_port();
    let mut gateway = Gateway(
        Command::new(ORIGIN_BIN)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", root.path())
            .env("RUST_LOG", "info")
            .env("NO_COLOR", "1")
            .env("ORIGIN_MULTI_TENANT", "true")
            .env("ORIGIN_SKIP_AUTH", "true")
            .env("ORIGIN_BIND_HOST", "127.0.0.1")
            .env("ORIGIN_BIND_PORT", port.to_string())
            .env("ORIGIN_WORKSPACE_ROOT", root.path().join("gateway"))
            .env("ORIGIN_GIT_REMOTE_BASE_URL", "http://127.0.0.1:9")
            .env("ORIGIN_CONTROLLER_URL", "http://127.0.0.1:9")
            .env("ORIGIN_ENABLE_PRESENCE_HEARTBEAT", "false")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start the gateway"),
    );
    wait_until_serving(&mut gateway, port);

    // A request whose body is still arriving when the stop comes.
    let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    client
        .write_all(
            b"POST /apply/status HTTP/1.1\r\nhost: origin\r\n\
              content-type: application/json\r\ncontent-length: 2\r\n\r\n{",
        )
        .unwrap();
    // Let the gateway read the head and start on the request.
    std::thread::sleep(Duration::from_millis(300));

    send_sigterm(&gateway);
    wait_until_refusing(port);
    assert!(
        gateway.0.try_wait().unwrap().is_none(),
        "the gateway exited with a request in progress"
    );

    // The rest of the body: the request completes and gets its answer
    // (`{x` is not JSON) before the gateway closes the connection.
    client.write_all(b"x").unwrap();
    let mut response = String::new();
    client.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 400 "), "{response:?}");

    let status = wait_for_exit(&mut gateway, Duration::from_secs(10));
    assert_eq!(status.code(), Some(0), "{status}");
    let mut log = String::new();
    gateway
        .0
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut log)
        .unwrap();
    assert!(
        log.contains("signal=\"SIGTERM\"") || log.contains("signal=SIGTERM"),
        "{log}"
    );
}
