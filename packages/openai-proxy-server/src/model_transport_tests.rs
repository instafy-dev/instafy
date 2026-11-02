//! Offline transport tests. A manually advanced clock exercises minutes of upstream work
//! without waiting minutes in CI; every provider is an inert loopback server.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{Router, body::Body, routing::post};
use futures_util::stream;
use tokio::sync::mpsc;

use super::*;
use crate::model_transport::DEFAULT_MAX_RESPONSE_BYTES;

struct Task(tokio::task::JoinHandle<()>);
impl Drop for Task {
    fn drop(&mut self) {
        self.0.abort();
    }
}

// Paused Tokio time normally jumps to the next timer while socket I/O is pending. Keep a
// runnable task so only this test's explicit `advance` calls move the clock.
fn manual_clock() -> Task {
    Task(tokio::spawn(async {
        loop {
            tokio::task::yield_now().await;
        }
    }))
}

fn event(kind: &str) -> String {
    format!("data: {}\n\n", json!({"type": kind}))
}

async fn upstream(
    first: String,
) -> (
    reqwest::Response,
    Option<UsageAttempt>,
    mpsc::UnboundedSender<String>,
    Arc<Mutex<Vec<Value>>>,
    Task,
) {
    let (sender, receiver) = mpsc::unbounded_channel::<String>();
    sender.send(first).unwrap();
    let receiver = Arc::new(Mutex::new(Some(receiver)));
    let app = Router::new().route(
        "/v1/responses",
        post(move || {
            let receiver = receiver.lock().unwrap().take().expect("one attempt only");
            async move {
                let chunks = stream::unfold(receiver, |mut receiver| async move {
                    receiver
                        .recv()
                        .await
                        .map(|chunk| (Ok::<_, std::io::Error>(chunk), receiver))
                });
                (
                    [("content-type", "text/event-stream")],
                    Body::from_stream(chunks),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1/responses", listener.local_addr().unwrap());
    let server = Task(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap()
    }));
    let (diagnostics, records) = crate::usage_diagnostics::recorder();
    let client = CodexClient::new(Credentials::ApiKey {
        key: "inert-transport-fixture".into(),
        endpoint: Some(endpoint.clone()),
        default_model: None,
    })
    .unwrap()
    .with_usage_diagnostics(Some(diagnostics));
    let (response, attempt) = client
        .send_upstream_request(&endpoint, &HeaderMap::new(), &json!({"stream": true}))
        .await
        .unwrap();
    (response, attempt, sender, records, server)
}

#[tokio::test(start_paused = true)]
async fn active_model_stream_exceeds_two_minutes_and_read_timeout_resets() {
    let _clock = manual_clock();
    let (response, attempt, sender, records, _server) = upstream(event("response.created")).await;
    let mut events = UpstreamEventStream::new(
        response,
        false,
        None,
        None,
        attempt,
        DEFAULT_MAX_RESPONSE_BYTES,
    );
    events.next_event().await.unwrap().unwrap();
    // Each gap is shorter than the default ten-minute inactivity limit, while the total
    // exceeds both the former two-minute deadline and a ten-minute total deadline.
    for _ in 0..3 {
        tokio::time::advance(Duration::from_secs(240)).await;
        sender.send(event("response.output_text.delta")).unwrap();
        assert_eq!(
            events.next_event().await.unwrap().unwrap()["type"],
            "response.output_text.delta"
        );
    }
    sender.send(format!("data: {}\n\n", json!({
        "type": "response.completed", "response": {
            "id": "fixture", "status": "completed", "usage": {"input_tokens": 4, "output_tokens": 7, "total_tokens": 11}
        }
    }))).unwrap();
    assert_eq!(
        events.next_event().await.unwrap().unwrap()["type"],
        "response.completed"
    );
    drop(events);
    let records = records.lock().unwrap();
    assert_eq!(records.last().unwrap()["outcome"], "completed");
    assert_eq!(records.last().unwrap()["terminalObservations"], 1);
    assert_eq!(records[1]["usage"]["fields"]["total_tokens"]["value"], 11);
}

#[tokio::test(start_paused = true)]
async fn stalled_connection_setup_has_its_own_shorter_deadline() {
    let _clock = manual_clock();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("https://{}/v1/responses", listener.local_addr().unwrap());
    let (accepted, connected) = tokio::sync::oneshot::channel();
    let _server = Task(tokio::spawn(async move {
        let (_connection, _) = listener.accept().await.unwrap();
        let _ = accepted.send(());
        // TCP succeeds, but this inert endpoint never completes the TLS handshake.
        std::future::pending::<()>().await;
    }));
    let request = tokio::spawn(async move {
        let client = CodexClient::new(Credentials::ApiKey {
            key: "inert-transport-fixture".into(),
            endpoint: Some(endpoint.clone()),
            default_model: None,
        })
        .unwrap();
        client
            .send_upstream_request(&endpoint, &HeaderMap::new(), &json!({}))
            .await
    });
    connected.await.unwrap();
    tokio::time::advance(Duration::from_secs(31)).await;
    let error = request
        .await
        .unwrap()
        .err()
        .expect("TLS setup must time out before the read limit");
    assert_eq!(upstream_error::classify(&error).code, "upstream_timeout");
}

#[tokio::test(start_paused = true)]
async fn silent_model_stream_times_out_without_fabricating_terminal_usage() {
    let _clock = manual_clock();
    let (response, attempt, _sender, records, _server) = upstream(event("response.created")).await;
    let mut events = UpstreamEventStream::new(
        response,
        false,
        None,
        None,
        attempt,
        DEFAULT_MAX_RESPONSE_BYTES,
    );
    events.next_event().await.unwrap().unwrap();
    let read = tokio::spawn(async move { events.read_until_output().await });
    tokio::task::yield_now().await;
    tokio::time::advance(Duration::from_secs(601)).await;
    let error = read.await.unwrap().unwrap_err();
    let classified = upstream_error::classify(&error);
    assert_eq!(classified.status, StatusCode::GATEWAY_TIMEOUT);
    assert_eq!(classified.code, "upstream_timeout");
    let records = records.lock().unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records.last().unwrap()["outcome"], "interrupted");
    assert_eq!(records.last().unwrap()["terminalObservations"], 0);
}

#[tokio::test]
async fn dropping_model_stream_cancels_upstream_and_records_unknown_usage() {
    let (response, attempt, sender, records, _server) = upstream(event("response.created")).await;
    let mut events = UpstreamEventStream::new(
        response,
        false,
        None,
        None,
        attempt,
        DEFAULT_MAX_RESPONSE_BYTES,
    );
    events.next_event().await.unwrap().unwrap();
    drop(events);
    tokio::time::timeout(Duration::from_secs(5), sender.closed())
        .await
        .expect("dropping the reader must close upstream without waiting for the inactivity limit");
    let records = records.lock().unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records.last().unwrap()["outcome"], "interrupted");
    assert_eq!(records.last().unwrap()["terminalObservations"], 0);
}

#[tokio::test]
async fn aggregate_stream_limit_counts_small_events_and_preserves_unknown_usage() {
    let first = event("response.created");
    let (response, attempt, sender, records, _server) = upstream(first.clone()).await;
    let mut events =
        UpstreamEventStream::new(response, false, None, None, attempt, first.len() * 2);
    events.next_event().await.unwrap().unwrap();
    sender.send(first.clone()).unwrap();
    events.next_event().await.unwrap().unwrap();
    sender.send(first).unwrap();
    let error = events.next_event().await.unwrap_err();
    assert_eq!(
        upstream_error::classify(&error).code,
        "upstream_response_too_large"
    );
    drop(events);
    assert_eq!(
        records.lock().unwrap().last().unwrap()["terminalObservations"],
        0
    );
}

#[tokio::test]
async fn buffered_model_body_has_the_same_aggregate_limit() {
    let (response, mut attempt, _sender, records, _server) = upstream("x".repeat(100)).await;
    let error = read_model_body(response, attempt.as_mut(), 99)
        .await
        .unwrap_err();
    assert_eq!(
        upstream_error::classify(&error).code,
        "upstream_response_too_large"
    );
    drop(attempt);
    assert_eq!(
        records.lock().unwrap().last().unwrap()["terminalObservations"],
        0
    );
}
