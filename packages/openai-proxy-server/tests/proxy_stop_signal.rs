//! The `proxy` binary stops on SIGTERM, which `docker stop` sends: it stops
//! taking connections, lets the request in progress finish, and exits 0.
//! The credential is inert and nothing leaves loopback.
#![cfg(unix)]

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

const PROXY_BIN: &str = env!("CARGO_BIN_EXE_proxy");

/// The spawned proxy, killed if a test fails before it exits.
struct Proxy(Child);

impl Drop for Proxy {
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

/// Only the proxy's own health answer proves the port is its.
fn answers_health(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(b"GET /healthz HTTP/1.1\r\nhost: proxy\r\nconnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") && response.contains("\"status\":\"ok\"")
}

fn wait_until_serving(proxy: &mut Proxy, port: u16) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(status) = proxy.0.try_wait().unwrap() {
            panic!("the proxy exited early with {status}");
        }
        if answers_health(port) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("the proxy did not answer /healthz");
}

fn wait_until_refusing(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        match TcpStream::connect(("127.0.0.1", port)) {
            Err(error) if error.kind() == ErrorKind::ConnectionRefused => return,
            _ => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    panic!("the proxy still takes connections after SIGTERM");
}

fn wait_for_exit(proxy: &mut Proxy, within: Duration) -> ExitStatus {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if let Some(status) = proxy.0.try_wait().unwrap() {
            return status;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("the proxy did not exit within {within:?}");
}

fn send_sigterm(proxy: &Proxy) {
    let status = Command::new("kill")
        .args(["-TERM", &proxy.0.id().to_string()])
        .status()
        .expect("run kill");
    assert!(status.success(), "kill -TERM failed: {status}");
}

#[test]
fn sigterm_finishes_the_request_in_progress_and_exits_zero() {
    let port = free_port();
    // Never created: the inert key means no credential file is read.
    let home = std::env::temp_dir().join(format!("instafy-proxy-stop-{}", std::process::id()));
    let mut proxy = Proxy(
        Command::new(PROXY_BIN)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", &home)
            .env("CODEX_HOME", &home)
            .env("OPENAI_API_KEY", "inert-not-a-key")
            .env("CODEX_PROXY_ADDR", format!("127.0.0.1:{port}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .expect("start the proxy"),
    );
    wait_until_serving(&mut proxy, port);

    // A request whose body is still arriving when the stop comes.
    let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    client
        .write_all(
            b"POST /v1/responses HTTP/1.1\r\nhost: proxy\r\n\
              content-type: application/json\r\ncontent-length: 2\r\n\r\n{",
        )
        .unwrap();
    // Let the proxy read the head and start on the request.
    std::thread::sleep(Duration::from_millis(300));

    send_sigterm(&proxy);
    wait_until_refusing(port);
    assert!(
        proxy.0.try_wait().unwrap().is_none(),
        "the proxy exited with a request in progress"
    );

    // The rest of the body: the request completes and gets its answer
    // (`{x` is not JSON, so nothing goes upstream) before the proxy
    // closes the connection.
    client.write_all(b"x").unwrap();
    let mut response = String::new();
    client.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 400 "), "{response:?}");

    let status = wait_for_exit(&mut proxy, Duration::from_secs(10));
    assert_eq!(status.code(), Some(0), "{status}");
    let mut log = String::new();
    proxy
        .0
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut log)
        .unwrap();
    assert!(log.contains("SIGTERM received"), "{log}");
}
