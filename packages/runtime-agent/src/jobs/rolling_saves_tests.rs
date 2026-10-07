//! Rolling saves against stand-ins: a controller that grants (or refuses)
//! the `workspace.persist` grant and an origin that answers saves.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode as AxumStatusCode};
use axum::routing::post;
use origin_http_server::working_state::WorkingState;
use reqwest::Url;
use serde_json::{Value as JsonValue, json};
use uuid::Uuid;

use super::*;
use crate::jobs::{JobExecution, JobFailureWithArtifacts};
use crate::origin::{LocalOriginSync, ReadOnlyRefresh, WorkingStateProbe};

/// What the stand-ins saw, in order: `grant`, `tick`, `turn_end`, `lease`.
#[derive(Clone, Default)]
struct Seen {
    events: Arc<Mutex<Vec<String>>>,
    grants: Arc<AtomicUsize>,
}

impl Seen {
    fn push(&self, event: &str) {
        self.events.lock().unwrap().push(event.to_string());
    }

    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }

    fn saves(&self) -> Vec<String> {
        self.events()
            .into_iter()
            .filter(|event| event == "tick" || event == "turn_end")
            .collect()
    }
}

#[derive(Clone)]
struct ControllerStub {
    seen: Seen,
    origin_id: Uuid,
    /// `None` grants; `Some((status, body))` refuses.
    refusal: Option<(u16, JsonValue)>,
}

async fn serve(app: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    address
}

/// A controller that grants a rolling save for `origin_id` (or refuses it),
/// and refuses every workspace lease, as when someone else holds it.
async fn controller(seen: &Seen, origin_id: Uuid, refusal: Option<(u16, JsonValue)>) -> Url {
    async fn mint_grant(
        State(stub): State<ControllerStub>,
        headers: HeaderMap,
        axum::Json(body): axum::Json<JsonValue>,
    ) -> (AxumStatusCode, String) {
        stub.seen.grants.fetch_add(1, Ordering::SeqCst);
        stub.seen.push("grant");
        assert_eq!(
            headers.get("authorization").unwrap(),
            "Bearer job-workspace-bearer"
        );
        assert_eq!(body["scopes"], json!(["workspace.persist"]));
        assert!(body["jobId"].is_string(), "{body}");
        match stub.refusal {
            Some((status, body)) => (AxumStatusCode::from_u16(status).unwrap(), body.to_string()),
            None => (
                AxumStatusCode::OK,
                json!({
                    "originId": stub.origin_id,
                    "endpoint": "https://elsewhere.example",
                    "mode": "hosted",
                    "token": "rolling-save-grant",
                })
                .to_string(),
            ),
        }
    }
    async fn lease(State(stub): State<ControllerStub>) -> (AxumStatusCode, &'static str) {
        stub.seen.push("lease");
        (AxumStatusCode::CONFLICT, r#"{"message":"held"}"#)
    }
    let app = Router::new()
        .route("/access_token", post(mint_grant))
        .route("/lease/acquire", post(lease))
        .with_state(ControllerStub {
            seen: seen.clone(),
            origin_id,
            refusal,
        });
    Url::parse(&format!("http://{}", serve(app).await)).unwrap()
}

/// An origin whose saves answer `answer` (status, body).
async fn origin(seen: &Seen, answer: (u16, JsonValue)) -> String {
    #[derive(Clone)]
    struct OriginStub {
        seen: Seen,
        answer: (u16, JsonValue),
    }
    async fn persist(
        State(stub): State<OriginStub>,
        headers: HeaderMap,
        axum::Json(body): axum::Json<JsonValue>,
    ) -> (AxumStatusCode, String) {
        assert_eq!(
            headers.get("authorization").unwrap(),
            "Bearer rolling-save-grant"
        );
        stub.seen.push(body["reason"].as_str().unwrap_or("?"));
        (
            AxumStatusCode::from_u16(stub.answer.0).unwrap(),
            stub.answer.1.to_string(),
        )
    }
    let app = Router::new()
        .route("/workspace/persist", post(persist))
        .with_state(OriginStub {
            seen: seen.clone(),
            answer,
        });
    format!("http://{}", serve(app).await)
}

fn durable() -> JsonValue {
    json!({
        "unsaved": 1,
        "localOnly": 0,
        "persistedAt": "2026-10-07T12:00:00Z",
        "durable": true,
        "changed": false,
    })
}

fn probe(changed: bool, local_only: u32, reads: Arc<AtomicUsize>) -> WorkingStateProbe {
    WorkingStateProbe::new(move || {
        let reads = reads.clone();
        async move {
            reads.fetch_add(1, Ordering::SeqCst);
            Ok(WorkingState {
                unsaved: 1,
                local_only,
                changed,
                ..WorkingState::default()
            })
        }
    })
}

fn local_origin(
    origin_id: Uuid,
    endpoint: &str,
    probe: Option<WorkingStateProbe>,
) -> LocalOriginSync {
    LocalOriginSync {
        origin_id,
        endpoint: endpoint.to_string(),
        read_only_refresh: None,
        working_state: probe,
    }
}

fn gate<'a>(controller: &'a Url, origin: LocalOriginSync) -> Gate<'a> {
    Gate {
        hosted_checkout: true,
        has_git_remote: true,
        read_only_job: false,
        workspace_token: Some("job-workspace-bearer".to_string()),
        local_origin: Some(origin),
        controller_base_url: controller,
        project_id: Uuid::new_v4(),
        job_id: Uuid::new_v4(),
    }
}

fn execution() -> JobExecution {
    JobExecution {
        summary: "ran a command".to_string(),
        suggested_replies: Vec::new(),
        provider: "terminal".to_string(),
        artifacts: Vec::new(),
        credit_snapshot: None,
        provider_conversation_state: None,
        messages: Vec::new(),
        messages_streamed: false,
        final_messages: Vec::new(),
    }
}

async fn wait_for(mut done: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while !done() {
        assert!(std::time::Instant::now() < deadline, "timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// The first tick comes one interval after the job starts, then one every
/// interval; a tick runs to its end before the next, and a tick missed
/// meanwhile is skipped rather than run late.
#[tokio::test(start_paused = true)]
async fn the_cadence_holds_under_paused_time() {
    let started = tokio::time::Instant::now();
    let ticks = Arc::new(Mutex::new(Vec::<(Duration, Duration)>::new()));
    let recorded = ticks.clone();
    let ticker = spawn_ticker(TICK_INTERVAL, move || {
        let recorded = recorded.clone();
        async move {
            let at = started.elapsed();
            // The second tick is slow: it covers two later slots.
            let slow = recorded.lock().unwrap().len() == 1;
            if slow {
                tokio::time::sleep(Duration::from_secs(300)).await;
            }
            recorded.lock().unwrap().push((at, started.elapsed()));
            true
        }
    });
    let at = |seconds: u64| Duration::from_secs(seconds);
    tokio::time::sleep(at(119)).await;
    assert!(
        ticks.lock().unwrap().is_empty(),
        "nothing before one interval"
    );
    tokio::time::sleep(at(2)).await;
    assert_eq!(ticks.lock().unwrap().len(), 1);
    assert_eq!(ticks.lock().unwrap()[0].0, at(120));

    tokio::time::sleep(at(600)).await;
    let seen = ticks.lock().unwrap().clone();
    let starts: Vec<Duration> = seen.iter().map(|(start, _)| *start).collect();
    // 240 ran for 300 s; 360 and 480 fell inside it and were dropped, not
    // run late.
    assert_eq!(starts, vec![at(120), at(240), at(600), at(720)], "{seen:?}");
    for pair in seen.windows(2) {
        assert!(pair[0].1 <= pair[1].0, "ticks never overlap: {seen:?}");
    }
    ticker.stop().await;
}

/// An unchanged folder (and nothing only this machine holds) asks the
/// controller for nothing; a changed one, or local-only work, saves.
#[tokio::test]
async fn an_unchanged_folder_makes_no_controller_call() {
    let seen = Seen::default();
    let origin_id = Uuid::new_v4();
    let controller = controller(&seen, origin_id, None).await;
    let endpoint = origin(&seen, (200, durable())).await;
    let reads = Arc::new(AtomicUsize::new(0));

    let unchanged = RollingSaves::from_gate(gate(
        &controller,
        local_origin(origin_id, &endpoint, Some(probe(false, 0, reads.clone()))),
    ))
    .unwrap();
    assert_eq!(unchanged.tick().await, SaveOutcome::Unchanged);
    assert_eq!(reads.load(Ordering::SeqCst), 1);
    assert_eq!(seen.grants.load(Ordering::SeqCst), 0);
    assert!(seen.events().is_empty());

    for (changed, local_only) in [(true, 0), (false, 1)] {
        let saves = RollingSaves::from_gate(gate(
            &controller,
            local_origin(
                origin_id,
                &endpoint,
                Some(probe(changed, local_only, reads.clone())),
            ),
        ))
        .unwrap();
        assert!(matches!(saves.tick().await, SaveOutcome::Saved(state) if state.durable));
    }
    assert_eq!(seen.grants.load(Ordering::SeqCst), 2);
    assert_eq!(seen.saves(), vec!["tick", "tick"]);
}

/// The ticker does not depend on the turn's workspace lease: after the
/// pre-turn refresh fell back to the read-only refresh, ticks still save.
#[tokio::test]
async fn the_ticker_runs_after_a_read_only_refresh_fallback() {
    let seen = Seen::default();
    let origin_id = Uuid::new_v4();
    let controller = controller(&seen, origin_id, None).await;
    let endpoint = origin(&seen, (200, durable())).await;
    let reads = Arc::new(AtomicUsize::new(0));
    let mut local = local_origin(origin_id, &endpoint, Some(probe(true, 0, reads)));
    local.read_only_refresh = Some(ReadOnlyRefresh::new(|| async {
        Ok(json!({ "checkoutMoved": false }))
    }));
    let saves = RollingSaves::from_gate(gate(&controller, local.clone())).unwrap();
    let ticker = saves.start_ticker_every(Duration::from_millis(50));

    let refresh = super::super::workspace_commit::refresh_before_turn(
        super::super::workspace_commit::PreTurnRefresh {
            controller_base_url: &controller,
            workspace_token: Some("job-workspace-bearer"),
            project_id: Uuid::new_v4(),
            runtime_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            run_id: None,
            local_origin: Some(local),
            has_git_remote: true,
        },
    )
    .await;
    assert_eq!(refresh.mode, "read_only", "{refresh:?}");
    wait_for(|| !seen.saves().is_empty()).await;
    ticker.stop().await;
    assert!(seen.events().contains(&"lease".to_string()));
    assert_eq!(seen.saves()[0], "tick");
}

/// When the job's body returns, the ticker stops for good before the job's
/// own save runs.
#[tokio::test]
async fn the_ticker_stops_before_the_turn_end_save() {
    let seen = Seen::default();
    let origin_id = Uuid::new_v4();
    let controller = controller(&seen, origin_id, None).await;
    let endpoint = origin(&seen, (200, durable())).await;
    let reads = Arc::new(AtomicUsize::new(0));
    let saves = RollingSaves::from_gate(gate(
        &controller,
        local_origin(origin_id, &endpoint, Some(probe(true, 0, reads))),
    ))
    .unwrap();
    let ticker = saves.start_ticker_every(Duration::from_millis(20));
    wait_for(|| seen.saves().len() >= 2).await;

    let mut result = Ok(execution());
    finish_job(&saves, Some(ticker), &mut result).await;
    let at_end = seen.saves();
    assert_eq!(
        at_end.last().map(String::as_str),
        Some("turn_end"),
        "{at_end:?}"
    );
    assert_eq!(
        at_end.iter().filter(|reason| *reason == "turn_end").count(),
        1
    );
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(seen.saves(), at_end, "no tick after the job ended");
    assert!(
        result.unwrap().artifacts.is_empty(),
        "a save that landed records nothing"
    );
}

/// The job's own save runs whatever its body was and however it ended: a
/// terminal command, a turn that changed no file, a failure. A save that
/// did not land is recorded as a `working-state` artifact.
#[tokio::test]
async fn the_turn_end_save_runs_for_every_write_job_and_records_a_failure() {
    let origin_id = Uuid::new_v4();
    let reads = Arc::new(AtomicUsize::new(0));

    // A terminal command and a file-less turn: saved, nothing recorded.
    let seen = Seen::default();
    let controller_url = controller(&seen, origin_id, None).await;
    let endpoint = origin(&seen, (200, durable())).await;
    let saves = RollingSaves::from_gate(gate(
        &controller_url,
        local_origin(origin_id, &endpoint, Some(probe(false, 0, reads.clone()))),
    ))
    .unwrap();
    let mut terminal = Ok(execution());
    finish_job(&saves, None, &mut terminal).await;
    let mut file_less = Ok(JobExecution {
        provider: "codex".to_string(),
        ..execution()
    });
    finish_job(&saves, None, &mut file_less).await;
    assert_eq!(seen.saves(), vec!["turn_end", "turn_end"]);
    assert!(terminal.unwrap().artifacts.is_empty());

    // The save answered but canonical does not hold the folder's work.
    let seen = Seen::default();
    let controller_url = controller(&seen, origin_id, None).await;
    let endpoint = origin(
        &seen,
        (
            200,
            json!({
                "unsaved": 2,
                "localOnly": 0,
                "persistedAt": "2026-10-07T11:58:00Z",
                "durable": false,
                "changed": true,
                "error": "push_ambiguous",
            }),
        ),
    )
    .await;
    let saves = RollingSaves::from_gate(gate(
        &controller_url,
        local_origin(origin_id, &endpoint, Some(probe(true, 0, reads.clone()))),
    ))
    .unwrap();
    let mut done = Ok(execution());
    finish_job(&saves, None, &mut done).await;
    assert_eq!(
        done.unwrap().artifacts,
        vec![json!({
            "kind": "working-state",
            "durable": false,
            "error": "push_ambiguous",
            "persistedAt": "2026-10-07T11:58:00Z",
        })]
    );

    // A failed job with artifacts of its own, and an origin that refused.
    let seen = Seen::default();
    let controller_url = controller(&seen, origin_id, None).await;
    let endpoint = origin(&seen, (500, json!({ "error": "boom" }))).await;
    let saves = RollingSaves::from_gate(gate(
        &controller_url,
        local_origin(origin_id, &endpoint, Some(probe(true, 0, reads))),
    ))
    .unwrap();
    let mut failed: Result<JobExecution> = Err(anyhow::Error::new(JobFailureWithArtifacts {
        message: "the turn failed".to_string(),
        artifacts: vec![json!({ "kind": "turn" })],
    }));
    finish_job(&saves, None, &mut failed).await;
    assert_eq!(seen.saves(), vec!["turn_end"]);
    let error = failed.unwrap_err();
    let artifacts = &error
        .downcast_ref::<JobFailureWithArtifacts>()
        .unwrap()
        .artifacts;
    assert_eq!(artifacts.len(), 2);
    assert_eq!(artifacts[1]["kind"], "working-state");
    assert_eq!(artifacts[1]["error"], "origin_refused:500");
}

/// A 403 `rolling_saves_off` ends the job's ticks; so does any other refusal
/// for this job. Neither is recorded as a failed save.
#[tokio::test]
async fn a_refusal_stops_the_ticker() {
    for (body, expected) in [
        (
            json!({ "message": "off", "code": "rolling_saves_off" }),
            SaveOutcome::Off,
        ),
        (
            json!({ "message": "this job is not allowed to write the workspace" }),
            SaveOutcome::Refused("forbidden".to_string()),
        ),
    ] {
        let seen = Seen::default();
        let origin_id = Uuid::new_v4();
        let controller_url = controller(&seen, origin_id, Some((403, body))).await;
        let endpoint = origin(&seen, (200, durable())).await;
        let reads = Arc::new(AtomicUsize::new(0));
        let saves = RollingSaves::from_gate(gate(
            &controller_url,
            local_origin(origin_id, &endpoint, Some(probe(true, 0, reads))),
        ))
        .unwrap();
        assert_eq!(saves.tick().await, expected);
        assert_eq!(turn_end_artifact(&expected), None);

        let ticker = saves.start_ticker_every(Duration::from_millis(20));
        wait_for(|| ticker.is_finished()).await;
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(seen.grants.load(Ordering::SeqCst), 2, "one tick, then none");
        assert!(seen.saves().is_empty());
        ticker.stop().await;
    }
}

/// The job's workspace token expired (the controller answers 401): no later
/// grant can succeed, so the ticks end, and the job's own save records why
/// it did not land.
#[tokio::test]
async fn a_401_from_the_controller_ends_the_ticks_and_is_recorded() {
    let seen = Seen::default();
    let origin_id = Uuid::new_v4();
    let controller_url = controller(
        &seen,
        origin_id,
        Some((401, json!({ "message": "token expired" }))),
    )
    .await;
    let endpoint = origin(&seen, (200, durable())).await;
    let reads = Arc::new(AtomicUsize::new(0));
    let saves = RollingSaves::from_gate(gate(
        &controller_url,
        local_origin(origin_id, &endpoint, Some(probe(true, 0, reads))),
    ))
    .unwrap();

    let ticker = saves.start_ticker_every(Duration::from_millis(20));
    wait_for(|| ticker.is_finished()).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(seen.grants.load(Ordering::SeqCst), 1, "one tick, then none");
    ticker.stop().await;

    let artifact = saves.save_at_turn_end().await.expect("recorded");
    assert_eq!(artifact["kind"], "working-state");
    assert_eq!(artifact["error"], "workspace_token_expired");
    assert!(seen.saves().is_empty());
}

/// A grant naming any origin but this runtime's own is never used.
#[tokio::test]
async fn a_grant_for_another_origin_is_not_used() {
    let seen = Seen::default();
    let controller_url = controller(&seen, Uuid::new_v4(), None).await;
    let endpoint = origin(&seen, (200, durable())).await;
    let reads = Arc::new(AtomicUsize::new(0));
    let saves = RollingSaves::from_gate(gate(
        &controller_url,
        local_origin(Uuid::new_v4(), &endpoint, Some(probe(true, 0, reads))),
    ))
    .unwrap();
    assert_eq!(saves.tick().await, SaveOutcome::Skipped("origin_not_local"));
    assert!(seen.saves().is_empty());
}

/// Only a write job on a hosted checkout with a canonical remote, an origin
/// in this process and a workspace token takes rolling saves.
#[test]
fn desktop_folders_and_read_only_jobs_never_tick() {
    let controller = Url::parse("http://127.0.0.1:9").unwrap();
    let reads = Arc::new(AtomicUsize::new(0));
    let origin = local_origin(
        Uuid::new_v4(),
        "http://127.0.0.1:9",
        Some(probe(true, 0, reads)),
    );
    assert!(RollingSaves::from_gate(gate(&controller, origin.clone())).is_some());

    let mut desktop = gate(&controller, origin.clone());
    desktop.hosted_checkout = false;
    assert!(RollingSaves::from_gate(desktop).is_none());

    let mut read_only = gate(&controller, origin.clone());
    read_only.read_only_job = true;
    assert!(RollingSaves::from_gate(read_only).is_none());

    let mut no_remote = gate(&controller, origin.clone());
    no_remote.has_git_remote = false;
    assert!(RollingSaves::from_gate(no_remote).is_none());

    let mut no_bearer = gate(&controller, origin.clone());
    no_bearer.workspace_token = None;
    assert!(RollingSaves::from_gate(no_bearer).is_none());

    // An origin that cannot say what its folder holds: a Desktop folder's.
    let mut no_probe = gate(&controller, origin.clone());
    no_probe.local_origin = Some(LocalOriginSync {
        working_state: None,
        ..origin
    });
    assert!(RollingSaves::from_gate(no_probe).is_none());
}
