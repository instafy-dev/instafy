//! The `git-edge` binary stops on SIGTERM, which `docker stop` sends: it
//! stops taking connections, lets the request it is proxying finish, and
//! exits 0. The shard here is a loopback stand-in that holds its answer
//! until the test lets it go.
#![cfg(unix)]

use std::io::{ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const EDGE_BIN: &str = env!("CARGO_BIN_EXE_git-edge");

/// The spawned edge, killed if a test fails before it exits.
struct Edge(Child);

impl Drop for Edge {
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

/// Only the edge's own `ok` proves the port is its.
fn answers_health(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(b"GET /healthz HTTP/1.1\r\nhost: edge\r\nconnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
    response.starts_with("HTTP/1.1 200") && response.ends_with("ok")
}

fn wait_until_serving(edge: &mut Edge, port: u16) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(status) = edge.0.try_wait().unwrap() {
            panic!("git-edge exited early with {status}");
        }
        if answers_health(port) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("git-edge did not answer /healthz");
}

fn wait_until_refusing(port: u16) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        match TcpStream::connect(("127.0.0.1", port)) {
            Err(error) if error.kind() == ErrorKind::ConnectionRefused => return,
            _ => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    panic!("git-edge still takes connections after SIGTERM");
}

fn wait_for_exit(edge: &mut Edge, within: Duration) -> ExitStatus {
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if let Some(status) = edge.0.try_wait().unwrap() {
            return status;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    panic!("git-edge did not exit within {within:?}");
}

fn send_sigterm(edge: &Edge) {
    let status = Command::new("kill")
        .args(["-TERM", &edge.0.id().to_string()])
        .status()
        .expect("run kill");
    assert!(status.success(), "kill -TERM failed: {status}");
}

#[test]
fn sigterm_finishes_the_proxied_request_and_exits_zero() {
    // A shard that reports each request head and answers only when told.
    let shard = TcpListener::bind("127.0.0.1:0").unwrap();
    let shard_url = format!("http://{}/", shard.local_addr().unwrap());
    let (received_tx, received) = mpsc::channel::<String>();
    let (release, release_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let (mut stream, _) = shard.accept().unwrap();
        let mut head = Vec::new();
        let mut buffer = [0u8; 4096];
        while !head.windows(4).any(|window| window == b"\r\n\r\n") {
            let read = stream.read(&mut buffer).unwrap();
            if read == 0 {
                return;
            }
            head.extend_from_slice(&buffer[..read]);
        }
        let _ = received_tx.send(String::from_utf8_lossy(&head).into_owned());
        if release_rx.recv().is_ok() {
            let _ = stream.write_all(
                b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\
                  content-length: 5\r\nconnection: close\r\n\r\nhello",
            );
        }
    });

    let port = free_port();
    let mut edge = Edge(
        Command::new(EDGE_BIN)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("RUST_LOG", "info")
            .env("NO_COLOR", "1")
            .env("GIT_EDGE_BIND_HOST", "127.0.0.1")
            .env("GIT_EDGE_BIND_PORT", port.to_string())
            .env("GIT_EDGE_SKIP_AUTH", "1")
            .env("GIT_SHARDS", &shard_url)
            .env("GIT_JWKS_URL", "http://127.0.0.1:9/jwks")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start git-edge"),
    );
    wait_until_serving(&mut edge, port);

    // A clone's first request, held at the shard when the stop comes.
    let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(20)))
        .unwrap();
    client
        .write_all(
            b"GET /demo.git/info/refs?service=git-upload-pack HTTP/1.1\r\nhost: edge\r\n\r\n",
        )
        .unwrap();
    let head = received
        .recv_timeout(Duration::from_secs(20))
        .expect("the edge forwarded the request");
    assert!(
        head.starts_with("GET /demo.git/info/refs?service=git-upload-pack "),
        "{head}"
    );

    send_sigterm(&edge);
    wait_until_refusing(port);
    assert!(
        edge.0.try_wait().unwrap().is_none(),
        "git-edge exited with a request in progress"
    );

    // The shard answers; the client gets all of it.
    release.send(()).unwrap();
    let mut response = String::new();
    client.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 "), "{response:?}");
    assert!(response.ends_with("\r\n\r\nhello"), "{response:?}");

    let status = wait_for_exit(&mut edge, Duration::from_secs(10));
    assert_eq!(status.code(), Some(0), "{status}");
    let mut log = String::new();
    edge.0
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
