//! Follow mode: the relay's routes against the test database, and the hub's
//! timers, limits and cross-node bus without one.

use std::time::Duration;

use anyhow::Context;
use axum::body::{Body, BodyDataStream};
use axum::http::{HeaderMap, Request};
use futures_util::StreamExt;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::follow::{
    EndReason, FollowBusMessage, FollowEnvelope, FollowHub, FollowLimits, FollowPerson,
    FollowReject, FOLLOW_EVENT_KIND, PRESENTATIONS_PER_USER,
};
use super::tests::{run, Fixture};
use super::*;
use crate::state::EventHub;

const WAIT: Duration = Duration::from_secs(5);

async fn send(
    app: &Router,
    token: Option<&str>,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> anyhow::Result<(StatusCode, HeaderMap, Value)> {
    let mut request = Request::builder().method(method).uri(path);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let request = match body {
        Some(body) => request
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))?,
        None => request.body(Body::empty())?,
    };
    let response = app.clone().oneshot(request).await?;
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024).await?;
    Ok((
        status,
        headers,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    ))
}

/// A follow stream as a browser reads it.
struct Stream {
    body: BodyDataStream,
    buffer: String,
}

#[derive(Debug)]
struct Event {
    name: String,
    id: Option<String>,
    data: Value,
}

impl Stream {
    async fn open(
        app: &Router,
        token: &str,
        path: &str,
    ) -> anyhow::Result<Result<Self, StatusCode>> {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .body(Body::empty())?,
            )
            .await?;
        if response.status() != StatusCode::OK {
            return Ok(Err(response.status()));
        }
        assert_eq!(
            response.headers()["content-type"].to_str()?,
            "text/event-stream"
        );
        Ok(Ok(Self {
            body: response.into_body().into_data_stream(),
            buffer: String::new(),
        }))
    }

    /// The next event, skipping keep-alive comments. `None` at the end of
    /// the stream.
    async fn next(&mut self, within: Duration) -> anyhow::Result<Option<Event>> {
        let deadline = tokio::time::Instant::now() + within;
        loop {
            while let Some(end) = self.buffer.find("\n\n") {
                let block: String = self.buffer.drain(..end + 2).collect();
                let mut name = "message".to_string();
                let mut id = None;
                let mut data = String::new();
                for line in block.lines() {
                    if let Some(value) = line.strip_prefix("event:") {
                        name = value.trim().to_string();
                    } else if let Some(value) = line.strip_prefix("id:") {
                        id = Some(value.trim().to_string());
                    } else if let Some(value) = line.strip_prefix("data:") {
                        data.push_str(value.trim_start());
                    }
                }
                if data.is_empty() {
                    continue;
                }
                return Ok(Some(Event {
                    name,
                    id,
                    data: serde_json::from_str(&data)?,
                }));
            }
            let chunk = tokio::time::timeout_at(deadline, self.body.next())
                .await
                .context("no follow event in time")?;
            match chunk {
                Some(bytes) => self.buffer.push_str(std::str::from_utf8(&bytes?)?),
                None => return Ok(None),
            }
        }
    }

    /// The next event called `name`, passing over others.
    async fn next_named(&mut self, name: &str) -> anyhow::Result<Event> {
        loop {
            let event = self.next(WAIT).await?.context("stream ended")?;
            if event.name == name {
                return Ok(event);
            }
        }
    }

    /// Skip events until a `state` event satisfies `check`; return what
    /// was passed over and the matching state.
    async fn until_state(
        &mut self,
        check: impl Fn(&Value) -> bool,
    ) -> anyhow::Result<(Vec<Event>, Value)> {
        let mut passed = Vec::new();
        loop {
            let event = self.next(WAIT).await?.context("stream ended")?;
            if event.name == "state" && check(&event.data) {
                return Ok((passed, event.data));
            }
            passed.push(event);
        }
    }
}

fn follow_path(f: &Fixture, preview_id: &str) -> String {
    f.path(&format!("/{preview_id}/follow"))
}

fn stream_path(f: &Fixture, preview_id: &str) -> String {
    f.path(&format!("/{preview_id}/follow/stream"))
}

async fn present(f: &Fixture, user: usize, preview_id: &str) -> anyhow::Result<Value> {
    let (status, _, body) = send(
        &f.app,
        Some(&f.tokens[user]),
        "POST",
        &follow_path(f, preview_id),
        Some(json!({ "op": "present" })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    Ok(body)
}

async fn post_op(
    f: &Fixture,
    user: usize,
    preview_id: &str,
    body: Value,
) -> anyhow::Result<(StatusCode, HeaderMap, Value)> {
    send(
        &f.app,
        Some(&f.tokens[user]),
        "POST",
        &follow_path(f, preview_id),
        Some(body),
    )
    .await
}

fn presenter_of(state: &Value) -> Option<String> {
    state["presentation"]["presenter"]["id"]
        .as_str()
        .map(str::to_string)
}

fn follower_ids(state: &Value) -> Vec<String> {
    let mut ids: Vec<String> = state["followers"]
        .as_array()
        .map(|followers| {
            followers
                .iter()
                .filter_map(|person| person["id"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids
}

/// A preview on a fresh runtime of the fixture's space.
async fn preview(f: &Fixture) -> anyhow::Result<String> {
    let job = f.job(None).await?;
    f.open(&job).await
}

#[tokio::test]
async fn follow_routes_answer_404_to_non_members_and_to_members_who_cannot_see_the_runtime(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let preview_id = preview(&f).await?;
            // The outsider (3) is not a member.
            for (method, path, body) in [
                ("POST", follow_path(&f, &preview_id), Some(json!({ "op": "present" }))),
                ("GET", follow_path(&f, &preview_id), None),
                ("GET", stream_path(&f, &preview_id), None),
            ] {
                let (status, _, result) =
                    send(&f.app, Some(&f.tokens[3]), method, &path, body).await?;
                assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {result}");
            }
            // Signed out: 401. A runtime token is not a person in Studio: 403.
            let (status, _, _) =
                send(&f.app, None, "GET", &follow_path(&f, &preview_id), None).await?;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            let job = f.job(None).await?;
            let (status, _, _) =
                send(&f.app, Some(&job.token), "GET", &follow_path(&f, &preview_id), None).await?;
            assert_eq!(status, StatusCode::FORBIDDEN);
            // Not a preview id at all: 404, as for a hidden one.
            let (status, _, _) = send(
                &f.app,
                Some(&f.tokens[0]),
                "GET",
                &follow_path(&f, &Uuid::new_v4().to_string()),
                None,
            )
            .await?;
            assert_eq!(status, StatusCode::NOT_FOUND);

            // A private runtime of the builder (1): the owner (0) is a
            // member but cannot see it, so its preview does not exist for her.
            let private_runtime = Uuid::new_v4();
            let private_tunnel = Uuid::new_v4().to_string();
            {
                let db = f.state.pool.get().await?;
                db.execute(
                    "insert into runtimes(id, project_id, provider, status, capabilities)
                     values($1, $2, 'default', 'running', $3)",
                    &[
                        &private_runtime,
                        &f.project,
                        &json!({ "_instafySelfHostedAccess": { "mode": "private", "ownerUserId": f.users[1] } }),
                    ],
                )
                .await?;
                db.execute(
                    "insert into runtime_tunnel_grants
                       (project_id, runtime_id, provider, tunnel_id, hostname, url, status, expires_at, metadata)
                     values($1, $2, 'self_hosted', $3, 'private.rt.localhost', 'https://private.rt.localhost',
                            'active', now() + interval '1 hour', $4)",
                    &[
                        &f.project,
                        &private_runtime,
                        &private_tunnel,
                        &json!({
                            "localPort": 4173,
                            (PREVIEW_TUNNEL_METADATA_KEY): { "visibility": "private", "path": "/", "title": "Mine" },
                        }),
                    ],
                )
                .await?;
            }
            for (method, path, body) in [
                ("POST", follow_path(&f, &private_tunnel), Some(json!({ "op": "present" }))),
                ("GET", follow_path(&f, &private_tunnel), None),
                ("GET", stream_path(&f, &private_tunnel), None),
            ] {
                let (status, _, result) =
                    send(&f.app, Some(&f.tokens[0]), method, &path, body).await?;
                assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {result}");
            }
            assert!(f.state.follow.signal(&private_tunnel).0.presentation.is_none());
            // Its owner may present it.
            present(&f, 1, &private_tunnel).await?;
            let (status, _, _) =
                send(&f.app, Some(&f.tokens[1]), "GET", &follow_path(&f, &private_tunnel), None)
                    .await?;
            assert_eq!(status, StatusCode::OK);
            f.state
                .follow
                .end_preview(&private_tunnel, EndReason::Stopped);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_presenters_views_and_taps_reach_every_other_follower_of_the_preview(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let preview_id = preview(&f).await?;
            let other_preview = preview(&f).await?;
            let mut builder = Stream::open(&f.app, &f.tokens[1], &stream_path(&f, &preview_id))
                .await?
                .expect("builder follows");
            let mut viewer = Stream::open(&f.app, &f.tokens[2], &stream_path(&f, &preview_id))
                .await?
                .expect("viewer follows");
            // Someone following a different preview hears nothing of this one.
            let mut elsewhere =
                Stream::open(&f.app, &f.tokens[0], &stream_path(&f, &other_preview))
                    .await?
                    .expect("owner follows another preview");
            let first = builder.next_named("state").await?;
            assert_eq!(first.data["presentation"], Value::Null);

            let presented = present(&f, 0, &preview_id).await?;
            let presentation_id = presented["presentationId"].as_str().unwrap().to_string();
            assert_eq!(presented["presenter"]["id"], json!(f.users[0]));
            assert!(presented["presenter"]["name"].as_str().is_some_and(|name| !name.is_empty()));
            assert!(presented.get("replaced").is_none());

            let both = {
                let mut ids = vec![f.users[1].to_string(), f.users[2].to_string()];
                ids.sort();
                ids
            };
            for stream in [&mut builder, &mut viewer] {
                let (_, state) = stream
                    .until_state(|state| {
                        presenter_of(state).is_some() && follower_ids(state).len() == 2
                    })
                    .await?;
                assert_eq!(presenter_of(&state), Some(f.users[0].to_string()));
                assert_eq!(state["presentation"]["presentationId"], json!(presentation_id));
                assert_eq!(state["presentation"]["state"], "live");
                assert_eq!(follower_ids(&state), both);
            }

            let view = json!({ "cam": { "bounds": [121.5, 25.0, 121.6, 25.1] }, "tab": "plan", "day": 3 });
            let (status, _, body) = post_op(
                &f,
                0,
                &preview_id,
                json!({ "op": "view", "presentationId": presentation_id, "seq": 7, "payload": view }),
            )
            .await?;
            assert_eq!(status, StatusCode::ACCEPTED, "{body}");
            for stream in [&mut builder, &mut viewer] {
                let event = stream.next_named("view").await?;
                assert_eq!(event.data["seq"], 7);
                assert_eq!(event.data["payload"], view);
                assert_eq!(event.id.as_deref(), Some("7"));
            }

            let tap = json!({ "x": 0.25, "y": 0.75, "at": { "stop": "hotel-3" } });
            let (status, _, _) = post_op(
                &f,
                0,
                &preview_id,
                json!({ "op": "tap", "presentationId": presentation_id, "seq": 8, "payload": tap }),
            )
            .await?;
            assert_eq!(status, StatusCode::ACCEPTED);
            for stream in [&mut builder, &mut viewer] {
                let event = stream.next_named("tap").await?;
                assert_eq!(event.data["payload"], tap);
                assert_eq!(event.data["seq"], 8);
            }

            // A heartbeat keeps the view; an older view never replaces a newer one.
            for body in [
                json!({ "op": "view", "presentationId": presentation_id, "seq": 9 }),
                json!({ "op": "view", "presentationId": presentation_id, "seq": 6, "payload": { "stale": true } }),
            ] {
                let (status, _, _) = post_op(&f, 0, &preview_id, body).await?;
                assert_eq!(status, StatusCode::ACCEPTED);
            }

            // Who joins late gets the latest view straight away.
            let mut late = Stream::open(&f.app, &f.tokens[0], &stream_path(&f, &preview_id))
                .await?
                .expect("the presenter may open a stream too");
            let state = late.next_named("state").await?;
            assert_eq!(state.data["presentation"]["seq"], 7);
            // The presenter is never listed as following.
            assert_eq!(follower_ids(&state.data), both);
            let event = late.next_named("view").await?;
            assert_eq!(event.data["payload"], view);

            let (status, _, snapshot) =
                send(&f.app, Some(&f.tokens[2]), "GET", &follow_path(&f, &preview_id), None).await?;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(snapshot["presentation"]["payload"], view);
            assert_eq!(snapshot["presentation"]["seq"], 7);
            assert_eq!(follower_ids(&snapshot), both);

            // The other preview's follower saw only its own (empty) room.
            let event = elsewhere.next(Duration::from_millis(300)).await?.context("state")?;
            assert_eq!(event.name, "state");
            assert_eq!(event.data["presentation"], Value::Null);
            assert!(elsewhere.next(Duration::from_millis(300)).await.is_err());

            drop(viewer);
            let (_, state) = builder
                .until_state(|state| follower_ids(state).len() == 1)
                .await?;
            assert_eq!(follower_ids(&state), vec![f.users[1].to_string()]);
            f.state.follow.end_preview(&preview_id, EndReason::Stopped);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn views_over_2048_bytes_get_413_and_bad_taps_get_400() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let preview_id = preview(&f).await?;
            let presentation_id = present(&f, 0, &preview_id).await?["presentationId"].clone();
            // A JSON string of n characters is n + 2 bytes.
            let fits = json!("x".repeat(2046));
            let over = json!("x".repeat(2047));
            assert_eq!(serde_json::to_vec(&fits)?.len(), 2048);
            let (status, _, _) = post_op(
                &f,
                0,
                &preview_id,
                json!({ "op": "view", "presentationId": presentation_id, "seq": 1, "payload": fits }),
            )
            .await?;
            assert_eq!(status, StatusCode::ACCEPTED);
            let (status, _, body) = post_op(
                &f,
                0,
                &preview_id,
                json!({ "op": "view", "presentationId": presentation_id, "seq": 2, "payload": over }),
            )
            .await?;
            assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
            let (status, _, _) = post_op(
                &f,
                0,
                &preview_id,
                json!({ "op": "tap", "presentationId": presentation_id, "seq": 3, "payload": { "x": 0.5, "y": "x".repeat(2100) } }),
            )
            .await?;
            assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
            // A body far over the limit is refused before anything else.
            let (status, _, _) = post_op(
                &f,
                3,
                &preview_id,
                json!({ "op": "view", "padding": "x".repeat(9000) }),
            )
            .await?;
            assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
            for payload in [json!({ "x": 1.5, "y": 0.5 }), json!({ "x": 0.5 }), json!([0.5, 0.5])] {
                let (status, _, _) = post_op(
                    &f,
                    0,
                    &preview_id,
                    json!({ "op": "tap", "presentationId": presentation_id, "seq": 4, "payload": payload }),
                )
                .await?;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{payload}");
            }
            let (status, _, _) =
                post_op(&f, 0, &preview_id, json!({ "op": "view", "seq": 5 })).await?;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            let (status, _, _) = post_op(&f, 0, &preview_id, json!({ "op": "dance" })).await?;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            // The stored view is still the one that fit.
            let (signal, frame) = f.state.follow.signal(&preview_id);
            assert!(signal.presentation.is_some());
            assert_eq!(frame.map(|frame| frame.seq), Some(1));
            f.state.follow.end_preview(&preview_id, EndReason::Stopped);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn views_and_taps_beyond_their_buckets_get_429_with_retry_after() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let preview_id = preview(&f).await?;
            // Slow buckets, so the answer does not depend on how fast this
            // machine serves requests; the 40 + 20/s and 5/s defaults are
            // proven on a paused clock below.
            let mut state = f.state.clone();
            state.follow = FollowHub::with_limits(
                state.events.clone(),
                None,
                FollowLimits {
                    views_per_second: 0.25,
                    view_burst: 3.0,
                    taps_per_second: 0.25,
                    tap_burst: 2.0,
                    ..FollowLimits::default()
                },
            );
            let app = router().with_state(state);
            let (status, _, presented) = send(
                &app,
                Some(&f.tokens[0]),
                "POST",
                &follow_path(&f, &preview_id),
                Some(json!({ "op": "present" })),
            )
            .await?;
            assert_eq!(status, StatusCode::OK);
            let presentation_id = presented["presentationId"].clone();
            let path = follow_path(&f, &preview_id);
            let post = |body: Value| send(&app, Some(&f.tokens[0]), "POST", &path, Some(body));
            for seq in 1..=3u64 {
                let (status, _, body) = post(json!({ "op": "view", "presentationId": presentation_id, "seq": seq, "payload": { "n": seq } })).await?;
                assert_eq!(status, StatusCode::ACCEPTED, "{body}");
            }
            let (status, headers, body) = post(json!({ "op": "view", "presentationId": presentation_id, "seq": 4, "payload": { "n": 4 } })).await?;
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
            assert_eq!(body["code"], "follow_rate_limited");
            let retry_after: u64 = headers["retry-after"].to_str()?.parse()?;
            assert!((1..=4).contains(&retry_after), "{retry_after}");
            // A heartbeat counts too.
            let (status, _, _) = post(json!({ "op": "view", "presentationId": presentation_id, "seq": 4 })).await?;
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
            // Taps have their own bucket.
            for _ in 0..2 {
                let (status, _, _) = post(json!({ "op": "tap", "presentationId": presentation_id, "seq": 5, "payload": { "x": 0.1, "y": 0.1 } })).await?;
                assert_eq!(status, StatusCode::ACCEPTED);
            }
            let (status, headers, _) = post(json!({ "op": "tap", "presentationId": presentation_id, "seq": 6, "payload": { "x": 0.1, "y": 0.1 } })).await?;
            assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
            assert!(headers.contains_key("retry-after"));
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_second_presenter_takes_over_and_the_first_gets_409() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let preview_id = preview(&f).await?;
            let mut viewer = Stream::open(&f.app, &f.tokens[2], &stream_path(&f, &preview_id))
                .await?
                .expect("viewer follows");
            let first = present(&f, 0, &preview_id).await?;
            viewer
                .until_state(|state| presenter_of(state) == Some(f.users[0].to_string()))
                .await?;

            let second = present(&f, 1, &preview_id).await?;
            assert_ne!(second["presentationId"], first["presentationId"]);
            assert_eq!(second["replaced"]["id"], json!(f.users[0]));
            let (passed, state) = viewer
                .until_state(|state| presenter_of(state) == Some(f.users[1].to_string()))
                .await?;
            // Followers follow the preview: a takeover is a new state, not an end.
            assert!(passed.iter().all(|event| event.name != "end"), "{passed:?}");
            assert_eq!(state["presentation"]["replaced"]["id"], json!(f.users[0]));
            assert_eq!(state["presentation"]["state"], "live");

            let (status, _, body) = post_op(
                &f,
                0,
                &preview_id,
                json!({ "op": "view", "presentationId": first["presentationId"], "seq": 1, "payload": { "a": 1 } }),
            )
            .await?;
            assert_eq!(status, StatusCode::CONFLICT, "{body}");
            assert_eq!(body["state"], "replaced");
            assert_eq!(body["presenter"]["id"], json!(f.users[1]));
            // Nobody but the presenter sends views for a presentation.
            let (status, _, _) = post_op(
                &f,
                2,
                &preview_id,
                json!({ "op": "view", "presentationId": second["presentationId"], "seq": 1, "payload": { "a": 1 } }),
            )
            .await?;
            assert_eq!(status, StatusCode::FORBIDDEN);
            // The replaced presenter's stop changes nothing.
            let (status, _, body) = post_op(
                &f,
                0,
                &preview_id,
                json!({ "op": "stop", "presentationId": first["presentationId"] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["stopped"], false);
            assert_eq!(
                f.state.follow.signal(&preview_id).0.presentation.map(|(info, _)| info.presenter.id),
                Some(f.users[1])
            );
            f.state.follow.end_preview(&preview_id, EndReason::Stopped);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn stop_and_close_end_the_presentation_for_followers() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let preview_id = preview(&f).await?;
            let mut viewer = Stream::open(&f.app, &f.tokens[2], &stream_path(&f, &preview_id))
                .await?
                .expect("viewer follows");
            let presented = present(&f, 1, &preview_id).await?;
            viewer
                .until_state(|state| presenter_of(state).is_some())
                .await?;
            let (status, _, body) = post_op(
                &f,
                1,
                &preview_id,
                json!({ "op": "stop", "presentationId": presented["presentationId"] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(body["stopped"], true);
            let end = viewer.next_named("end").await?;
            assert_eq!(end.data["reason"], "stopped");
            assert_eq!(end.data["presentationId"], presented["presentationId"]);
            let (_, state) = viewer
                .until_state(|state| state["presentation"].is_null())
                .await?;
            assert_eq!(follower_ids(&state), vec![f.users[2].to_string()]);
            let (status, _, body) = post_op(
                &f,
                1,
                &preview_id,
                json!({ "op": "view", "presentationId": presented["presentationId"], "seq": 1 }),
            )
            .await?;
            assert_eq!(status, StatusCode::CONFLICT);
            assert_eq!(body["state"], "ended");

            // Closing the preview ends whatever is being presented.
            present(&f, 1, &preview_id).await?;
            viewer
                .until_state(|state| presenter_of(state).is_some())
                .await?;
            let (status, _, body) = send(
                &f.app,
                Some(&f.tokens[0]),
                "POST",
                &f.path(&format!("/{preview_id}/close")),
                Some(json!({})),
            )
            .await?;
            assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
            // At once, not at the stream's next access check.
            let signal = f.state.follow.signal(&preview_id).0;
            assert!(signal.presentation.is_none());
            assert_eq!(signal.end.map(|end| end.reason), Some(EndReason::Closed));
            let end = viewer.next_named("end").await?;
            assert_eq!(end.data["reason"], "closed");
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_preview_that_stops_ends_its_presentation_and_cannot_be_presented() -> anyhow::Result<()>
{
    run(|f| {
        Box::pin(async move {
            let preview_id = preview(&f).await?;
            let mut state = f.state.clone();
            state.config.event_access_recheck_after = Duration::from_millis(200);
            let app = router().with_state(state);
            let mut viewer = Stream::open(&app, &f.tokens[2], &stream_path(&f, &preview_id))
                .await?
                .expect("viewer follows");
            let presented = present(&f, 1, &preview_id).await?;
            viewer
                .until_state(|state| presenter_of(state).is_some())
                .await?;
            // The runtime stops: its tunnel grant is revoked, as a stop does.
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "update runtime_tunnel_grants set status = 'revoked' where tunnel_id = $1",
                    &[&preview_id],
                )
                .await?;
            // A follower hears it at the stream's next access check.
            let end = viewer.next_named("end").await?;
            assert_eq!(end.data["reason"], "closed");
            assert_eq!(end.data["presentationId"], presented["presentationId"]);
            assert!(f.state.follow.signal(&preview_id).0.presentation.is_none());
            // The presenter's next view is refused, and nobody presents it again.
            let (status, _, body) = post_op(
                &f,
                1,
                &preview_id,
                json!({ "op": "view", "presentationId": presented["presentationId"], "seq": 1, "payload": { "x": 1 } }),
            )
            .await?;
            assert_eq!(status, StatusCode::CONFLICT, "{body}");
            assert_eq!(body["state"], "ended");
            let (status, _, body) =
                post_op(&f, 0, &preview_id, json!({ "op": "present" })).await?;
            assert_eq!(status, StatusCode::CONFLICT, "{body}");
            assert_eq!(body["state"], "ended");
            assert!(f.state.follow.signal(&preview_id).0.presentation.is_none());
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_follower_whose_membership_is_revoked_gets_end_access() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let preview_id = preview(&f).await?;
            let mut state = f.state.clone();
            state.config.event_access_recheck_after = Duration::from_millis(200);
            let app = router().with_state(state);
            let mut viewer = Stream::open(&app, &f.tokens[2], &stream_path(&f, &preview_id))
                .await?
                .expect("viewer follows");
            viewer.next_named("state").await?;
            // Still a member: rechecks pass and nothing ends.
            assert!(viewer.next(Duration::from_millis(600)).await.is_err());
            f.state
                .pool
                .get()
                .await?
                .execute(
                    "delete from project_memberships where project_id = $1 and user_id = $2",
                    &[&f.project, &f.users[2]],
                )
                .await?;
            let end = viewer.next_named("end").await?;
            assert_eq!(end.data["reason"], "access");
            assert!(viewer.next(WAIT).await?.is_none(), "the stream closes");
            // And the room forgets the follower.
            let deadline = std::time::Instant::now() + WAIT;
            while f
                .state
                .follow
                .signal(&preview_id)
                .0
                .followers
                .iter()
                .any(|p| p.id == f.users[2])
            {
                assert!(std::time::Instant::now() < deadline, "follower not removed");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let (status, _, _) = send(
                &app,
                Some(&f.tokens[2]),
                "GET",
                &follow_path(&f, &preview_id),
                None,
            )
            .await?;
            assert_eq!(status, StatusCode::NOT_FOUND);
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_user_may_hold_two_follow_streams_and_they_do_not_use_event_slots() -> anyhow::Result<()>
{
    run(|f| {
        Box::pin(async move {
            let preview_id = preview(&f).await?;
            let first = Stream::open(&f.app, &f.tokens[2], &stream_path(&f, &preview_id)).await?;
            let second = Stream::open(&f.app, &f.tokens[2], &stream_path(&f, &preview_id)).await?;
            assert!(first.is_ok() && second.is_ok());
            let third = Stream::open(&f.app, &f.tokens[2], &stream_path(&f, &preview_id)).await?;
            assert_eq!(third.err(), Some(StatusCode::TOO_MANY_REQUESTS));
            // The four `/events` slots are untouched.
            let events_permits: Vec<_> = futures_util::future::join_all((0..4).map(|_| {
                f.state
                    .connection_limiter
                    .try_acquire(format!("events:user:{}", f.users[2]), 4)
            }))
            .await;
            assert!(events_permits.iter().all(Option::is_some));
            drop(events_permits);
            // Closing one frees its slot.
            drop(first);
            let deadline = std::time::Instant::now() + WAIT;
            loop {
                match Stream::open(&f.app, &f.tokens[2], &stream_path(&f, &preview_id)).await? {
                    Ok(_) => break,
                    Err(status) => {
                        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
                        assert!(std::time::Instant::now() < deadline, "slot never freed");
                        tokio::time::sleep(Duration::from_millis(20)).await;
                    }
                }
            }
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn the_event_hub_carries_only_presence_and_nothing_is_written() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let preview_id = preview(&f).await?;
            f.view(0, &preview_id).await?;
            let count_rows = || async {
                let row = f
                    .state
                    .pool
                    .get()
                    .await?
                    .query_one(
                        "select
                           (select count(*) from conversation_messages m
                              join conversations c on c.id = m.conversation_id
                              where c.project_id = $1) as messages,
                           (select count(*) from runtime_preview_sessions where project_id = $1) as sessions,
                           (select count(*) from agent_jobs where project_id = $1) as jobs,
                           (select count(*) from runs where project_id = $1) as runs,
                           (select count(*) from runtime_tunnel_grants where project_id = $1) as grants,
                           (select metadata::text from runtime_tunnel_grants where tunnel_id = $2) as metadata,
                           (select last_active_at::text from project_user_activity where project_id = $1) as activity",
                        &[&f.project, &preview_id],
                    )
                    .await?;
                anyhow::Ok((
                    row.get::<_, i64>("messages"),
                    row.get::<_, i64>("sessions"),
                    row.get::<_, i64>("jobs"),
                    row.get::<_, i64>("runs"),
                    row.get::<_, i64>("grants"),
                    row.get::<_, Option<String>>("metadata"),
                    // Presenting and following are not activity: they never
                    // keep a runtime up by themselves.
                    row.get::<_, Option<String>>("activity"),
                ))
            };
            let before = count_rows().await?;
            let mut events = f.state.events.subscribe();

            let mut viewer = Stream::open(&f.app, &f.tokens[2], &stream_path(&f, &preview_id))
                .await?
                .expect("viewer follows");
            let presented = present(&f, 0, &preview_id).await?;
            const MARKER: &str = "secret-view-marker";
            for seq in 1..=10u64 {
                let (status, _, _) = post_op(
                    &f,
                    0,
                    &preview_id,
                    json!({ "op": "view", "presentationId": presented["presentationId"], "seq": seq, "payload": { "m": MARKER, "seq": seq } }),
                )
                .await?;
                assert_eq!(status, StatusCode::ACCEPTED);
            }
            let (status, _, _) = post_op(
                &f,
                0,
                &preview_id,
                json!({ "op": "tap", "presentationId": presented["presentationId"], "seq": 11, "payload": { "x": 0.5, "y": 0.5, "at": MARKER } }),
            )
            .await?;
            assert_eq!(status, StatusCode::ACCEPTED);
            loop {
                let event = viewer.next_named("view").await?;
                if event.data["seq"] == 10 {
                    break;
                }
            }
            post_op(
                &f,
                0,
                &preview_id,
                json!({ "op": "stop", "presentationId": presented["presentationId"] }),
            )
            .await?;
            viewer.next_named("end").await?;

            let mut presence = Vec::new();
            while let Ok(event) = events.try_recv() {
                if event.project_id != Some(f.project) {
                    continue;
                }
                assert_eq!(event.kind, FOLLOW_EVENT_KIND, "{event:?}");
                assert!(!event.data.to_string().contains(MARKER));
                assert_eq!(event.data["previewId"], json!(preview_id));
                presence.push(event);
            }
            let states: Vec<(String, i64)> = presence
                .iter()
                .map(|event| {
                    (
                        event.data["state"].as_str().unwrap_or_default().to_string(),
                        event.data["followers"].as_i64().unwrap_or(-1),
                    )
                })
                .collect();
            assert_eq!(
                states,
                vec![("live".to_string(), 1), ("ended".to_string(), 1)],
                "{presence:?}"
            );
            let first = &presence[0];
            assert_eq!(first.data["presenter"]["id"], json!(f.users[0]));
            assert_eq!(first.data["presenter"].as_object().map(|o| o.len()), Some(2));
            assert_eq!(first.data["presentationId"], presented["presentationId"]);
            // The preview's runtime is named, so private-runtime visibility applies.
            assert!(first.data["runtimeId"].as_str().is_some());
            assert_eq!(
                first.conversation_id.map(|id| id.to_string()),
                f.grant_metadata(&preview_id).await?[PREVIEW_TUNNEL_METADATA_KEY]["conversationId"]
                    .as_str()
                    .map(str::to_string)
            );

            assert_eq!(count_rows().await?, before, "follow mode wrote rows");
            drop(viewer);
            Ok(())
        })
    })
    .await
}

// ---------------------------------------------------------------------------
// The hub alone

fn person(name: &str) -> FollowPerson {
    FollowPerson {
        id: Uuid::new_v4(),
        name: name.to_string(),
        avatar_url: None,
    }
}

fn presence_states(
    events: &mut tokio::sync::broadcast::Receiver<crate::state::ControllerEvent>,
) -> Vec<String> {
    let mut states = Vec::new();
    while let Ok(event) = events.try_recv() {
        assert_eq!(event.kind, FOLLOW_EVENT_KIND);
        let state = event.data["state"].as_str().unwrap_or_default();
        // an ended presentation says why: "ended:timeout"
        states.push(match event.data["reason"].as_str() {
            Some(reason) => format!("{state}:{reason}"),
            None => state.to_string(),
        });
    }
    states
}

#[tokio::test(start_paused = true)]
async fn a_silent_presenter_turns_away_after_15s_and_the_presentation_ends_120s_later() {
    let events = EventHub::new();
    let mut presence = events.subscribe();
    let hub = FollowHub::new(events, None);
    let project = Uuid::new_v4();
    let kim = person("Kim");
    let mut follower = hub.follow("p1", project, person("Lena"));
    let info = hub
        .present("p1", project, None, None, kim.clone())
        .expect("present");
    assert_eq!(presence_states(&mut presence), vec!["live"]);

    tokio::time::sleep(Duration::from_millis(14_900)).await;
    assert_eq!(presence_states(&mut presence), Vec::<String>::new());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(presence_states(&mut presence), vec!["away"]);
    assert_eq!(
        follower
            .signal
            .borrow_and_update()
            .presentation
            .as_ref()
            .map(|(_, away)| *away),
        Some(true)
    );

    // A heartbeat brings the presenter back, and restarts the clock.
    assert!(hub
        .view("p1", info.presentation_id, kim.id, 1, None)
        .is_ok());
    assert_eq!(presence_states(&mut presence), vec!["live"]);
    tokio::time::sleep(Duration::from_millis(15_100)).await;
    assert_eq!(presence_states(&mut presence), vec!["away"]);
    tokio::time::sleep(Duration::from_millis(119_800)).await;
    assert_eq!(presence_states(&mut presence), Vec::<String>::new());
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(presence_states(&mut presence), vec!["ended:timeout"]);
    let signal = follower.signal.borrow_and_update().clone();
    assert!(signal.presentation.is_none());
    let end = signal.end.expect("end notice");
    assert_eq!(end.reason, EndReason::Timeout);
    assert_eq!(end.presentation_id, info.presentation_id);
    assert_eq!(
        hub.view("p1", info.presentation_id, kim.id, 2, None),
        Err(FollowReject::Ended)
    );
}

#[tokio::test(start_paused = true)]
async fn a_presentation_ends_after_four_hours_even_with_heartbeats() {
    let hub = FollowHub::new(EventHub::new(), None);
    let project = Uuid::new_v4();
    let kim = person("Kim");
    let follower = hub.follow("p1", project, person("Lena"));
    let info = hub.present("p1", project, None, None, kim.clone()).unwrap();
    for seq in 0..(4 * 60 * 6 - 1) {
        tokio::time::sleep(Duration::from_secs(10)).await;
        hub.view("p1", info.presentation_id, kim.id, seq, None)
            .expect("still live");
    }
    tokio::time::sleep(Duration::from_secs(11)).await;
    assert!(hub.signal("p1").0.presentation.is_none());
    assert_eq!(
        follower.signal.borrow().end.as_ref().map(|end| end.reason),
        Some(EndReason::Timeout)
    );
}

#[tokio::test(start_paused = true)]
async fn the_view_bucket_allows_a_burst_of_40_then_20_a_second_and_taps_5() {
    let hub = FollowHub::new(EventHub::new(), None);
    let project = Uuid::new_v4();
    let kim = person("Kim");
    let info = hub.present("p1", project, None, None, kim.clone()).unwrap();
    for seq in 0..40 {
        hub.view(
            "p1",
            info.presentation_id,
            kim.id,
            seq,
            Some(json!({ "n": seq })),
        )
        .expect("within the burst");
    }
    match hub.view("p1", info.presentation_id, kim.id, 40, Some(json!({}))) {
        Err(FollowReject::RateLimited(wait)) => assert!(wait <= Duration::from_millis(50)),
        other => panic!("41st view: {other:?}"),
    }
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(hub
        .view("p1", info.presentation_id, kim.id, 41, Some(json!({})))
        .is_ok());
    assert!(hub
        .view("p1", info.presentation_id, kim.id, 42, Some(json!({})))
        .is_err());
    for _ in 0..5 {
        hub.tap(
            "p1",
            info.presentation_id,
            kim.id,
            1,
            json!({ "x": 0, "y": 0 }),
        )
        .expect("tap");
    }
    assert!(matches!(
        hub.tap(
            "p1",
            info.presentation_id,
            kim.id,
            1,
            json!({ "x": 0, "y": 0 })
        ),
        Err(FollowReject::RateLimited(_))
    ));
}

#[tokio::test]
async fn a_user_presents_at_most_three_previews_and_may_present_one_again() {
    let hub = FollowHub::new(EventHub::new(), None);
    let project = Uuid::new_v4();
    let kim = person("Kim");
    for preview in ["a", "b", "c"] {
        hub.present(preview, project, None, None, kim.clone())
            .unwrap();
    }
    assert_eq!(hub.presentations_of(kim.id), PRESENTATIONS_PER_USER);
    assert_eq!(
        hub.present("d", project, None, None, kim.clone()),
        Err(FollowReject::TooManyPresentations)
    );
    // Presenting one of them again replaces her own presentation.
    let again = hub.present("a", project, None, None, kim.clone()).unwrap();
    assert!(again.replaced.is_none());
    // Someone else may present any of them.
    let lena = person("Lena");
    let taken = hub.present("b", project, None, None, lena).unwrap();
    assert_eq!(taken.replaced.map(|person| person.id), Some(kim.id));
    hub.present("d", project, None, None, kim.clone()).unwrap();
}

#[tokio::test]
async fn views_never_go_backwards_and_heartbeats_keep_the_view() {
    let hub = FollowHub::new(EventHub::new(), None);
    let project = Uuid::new_v4();
    let kim = person("Kim");
    let info = hub.present("p1", project, None, None, kim.clone()).unwrap();
    let id = info.presentation_id;
    hub.view("p1", id, kim.id, 5, Some(json!({ "v": 5 })))
        .unwrap();
    hub.view("p1", id, kim.id, 4, Some(json!({ "v": 4 })))
        .unwrap();
    hub.view("p1", id, kim.id, 6, None).unwrap();
    let frame = hub.signal("p1").1.expect("view");
    assert_eq!((frame.seq, frame.payload), (5, json!({ "v": 5 })));
    // A view of another presentation is refused.
    assert!(matches!(
        hub.view("p1", Uuid::new_v4(), kim.id, 7, Some(json!({}))),
        Err(FollowReject::Replaced(_))
    ));
    assert_eq!(
        hub.view("nope", id, kim.id, 7, Some(json!({}))),
        Err(FollowReject::Ended)
    );
}

/// Two nodes joined by an in-memory bus, as Redis joins them.
fn connect(
    a: &FollowHub,
    b: &FollowHub,
    mut a_out: tokio::sync::mpsc::Receiver<FollowEnvelope>,
    mut b_out: tokio::sync::mpsc::Receiver<FollowEnvelope>,
) {
    let (to_b, to_a) = (b.clone(), a.clone());
    tokio::spawn(async move {
        while let Some(envelope) = a_out.recv().await {
            // Through JSON, as on the wire.
            let wire = serde_json::to_string(&envelope).unwrap();
            to_b.receive(serde_json::from_str(&wire).unwrap());
        }
    });
    tokio::spawn(async move {
        while let Some(envelope) = b_out.recv().await {
            let wire = serde_json::to_string(&envelope).unwrap();
            to_a.receive(serde_json::from_str(&wire).unwrap());
        }
    });
}

async fn settle() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    tokio::time::sleep(Duration::from_millis(20)).await;
}

#[tokio::test]
async fn two_hubs_on_a_bus_deliver_presence_views_taps_and_followers_across_nodes() {
    let (a_tx, a_rx) = FollowHub::bus_channel();
    let (b_tx, b_rx) = FollowHub::bus_channel();
    let a_events = EventHub::new();
    let b_events = EventHub::new();
    let mut b_presence = b_events.subscribe();
    let a = FollowHub::new(a_events, Some(a_tx));
    let b = FollowHub::new(b_events, Some(b_tx));
    connect(&a, &b, a_rx, b_rx);
    let project = Uuid::new_v4();
    let kim = person("Kim");
    let lena = person("Lena");

    let mut on_b = b.follow("p1", project, lena.clone());
    settle().await;
    let info = a.present("p1", project, None, None, kim.clone()).unwrap();
    settle().await;
    // B holds the same presentation, and A knows Lena follows on B.
    assert_eq!(
        on_b.signal
            .borrow_and_update()
            .presentation
            .as_ref()
            .map(|(info, _)| info.presentation_id),
        Some(info.presentation_id)
    );
    assert_eq!(
        a.signal("p1")
            .0
            .followers
            .iter()
            .map(|p| p.id)
            .collect::<Vec<_>>(),
        vec![lena.id]
    );
    assert_eq!(presence_states(&mut b_presence), vec!["live"]);

    a.view(
        "p1",
        info.presentation_id,
        kim.id,
        3,
        Some(json!({ "cam": [1, 2] })),
    )
    .unwrap();
    a.tap(
        "p1",
        info.presentation_id,
        kim.id,
        4,
        json!({ "x": 0.5, "y": 0.5 }),
    )
    .unwrap();
    settle().await;
    assert!(on_b.views.has_changed().unwrap());
    let frame = on_b.views.borrow_and_update().clone().expect("view on B");
    assert_eq!((frame.seq, frame.payload), (3, json!({ "cam": [1, 2] })));
    let tap = on_b.taps.try_recv().expect("tap on B");
    assert_eq!(tap.payload, json!({ "x": 0.5, "y": 0.5 }));

    // Kim presents from B too (another tab): last one wins on both nodes.
    let replaced = b.present("p1", project, None, None, lena.clone()).unwrap();
    settle().await;
    assert_eq!(
        a.signal("p1")
            .0
            .presentation
            .map(|(info, _)| info.presentation_id),
        Some(replaced.presentation_id)
    );
    assert!(matches!(
        a.view("p1", info.presentation_id, kim.id, 5, None),
        Err(FollowReject::Replaced(person)) if person.id == lena.id
    ));
    // Lena presents, so she is not listed as following.
    assert!(a.signal("p1").0.followers.is_empty());

    b.stop("p1", replaced.presentation_id, lena.id);
    settle().await;
    let signal = a.signal("p1").0;
    assert!(signal.presentation.is_none());
    assert_eq!(signal.end.map(|end| end.reason), Some(EndReason::Stopped));

    // Lena leaves B; A forgets her, and both rooms are gone.
    drop(on_b);
    settle().await;
    assert_eq!(a.room_count(), 0);
    assert_eq!(b.room_count(), 0);
}

#[tokio::test(start_paused = true)]
async fn another_nodes_followers_are_forgotten_when_it_goes_quiet() {
    let (b_tx, mut b_rx) = FollowHub::bus_channel();
    let a = FollowHub::new(EventHub::new(), None);
    let b = FollowHub::new(EventHub::new(), Some(b_tx));
    let project = Uuid::new_v4();
    let lena = person("Lena");
    let _following = b.follow("p1", project, lena.clone());
    // Deliver B's announcement once, then B goes silent (it died).
    let envelope = b_rx.recv().await.expect("announcement");
    assert!(matches!(
        envelope.message,
        FollowBusMessage::Followers { .. }
    ));
    a.receive(envelope);
    assert_eq!(a.signal("p1").0.followers.len(), 1);
    tokio::time::sleep(Duration::from_secs(89)).await;
    assert_eq!(a.signal("p1").0.followers.len(), 1);
    tokio::time::sleep(Duration::from_secs(2)).await;
    assert!(a.signal("p1").0.followers.is_empty());
    // B meanwhile re-announced every 30 s.
    let mut announcements = 0;
    while let Ok(envelope) = b_rx.try_recv() {
        assert!(matches!(
            envelope.message,
            FollowBusMessage::Followers { .. }
        ));
        announcements += 1;
    }
    assert_eq!(announcements, 3);
}

#[test]
fn the_bus_publisher_drops_only_superseded_views() {
    let view = |preview: &str, seq: u64, payload: Option<Value>| FollowEnvelope {
        source: "n".to_string(),
        message: FollowBusMessage::View {
            preview_id: preview.to_string(),
            presentation_id: Uuid::nil(),
            seq,
            payload,
            at: chrono::Utc::now(),
        },
    };
    let end = FollowEnvelope {
        source: "n".to_string(),
        message: FollowBusMessage::End {
            preview_id: "a".to_string(),
            presentation_id: Uuid::nil(),
            reason: EndReason::Stopped,
        },
    };
    let batch = vec![
        view("a", 1, Some(json!(1))),
        view("b", 1, Some(json!(1))),
        view("a", 2, None),
        view("a", 3, Some(json!(3))),
        view("a", 4, None),
        view("a", 5, None),
        end,
    ];
    let kept: Vec<String> = crate::redis_bus::coalesce_follow_batch(batch)
        .into_iter()
        .map(|envelope| match envelope.message {
            FollowBusMessage::View {
                preview_id, seq, ..
            } => format!("{preview_id}{seq}"),
            FollowBusMessage::End { .. } => "end".to_string(),
            _ => "other".to_string(),
        })
        .collect();
    assert_eq!(kept, vec!["b1", "a3", "a5", "end"]);
}

/// Two hubs through a real Redis, when `FOLLOW_TEST_REDIS_URL` names one.
#[tokio::test]
async fn two_hubs_meet_through_redis_when_one_is_available() -> anyhow::Result<()> {
    let Ok(redis_url) = std::env::var("FOLLOW_TEST_REDIS_URL") else {
        eprintln!("FOLLOW_TEST_REDIS_URL unset; skipping the Redis follow bus test");
        return Ok(());
    };
    let channel = format!("follow-test:{}:controller:follow", Uuid::new_v4());
    let (a_tx, a_rx) = FollowHub::bus_channel();
    let (b_tx, b_rx) = FollowHub::bus_channel();
    let a = FollowHub::new(EventHub::new(), Some(a_tx));
    let b = FollowHub::new(EventHub::new(), Some(b_tx));
    crate::redis_bus::spawn_follow(redis_url.clone(), channel.clone(), a.clone(), a_rx);
    crate::redis_bus::spawn_follow(redis_url, channel, b.clone(), b_rx);
    tokio::time::sleep(Duration::from_millis(500)).await;
    let project = Uuid::new_v4();
    let kim = person("Kim");
    let mut on_b = b.follow("p1", project, person("Lena"));
    let info = a.present("p1", project, None, None, kim.clone()).unwrap();
    a.view(
        "p1",
        info.presentation_id,
        kim.id,
        1,
        Some(json!({ "z": 1 })),
    )
    .unwrap();
    tokio::time::timeout(WAIT, async {
        loop {
            on_b.views.changed().await.unwrap();
            if on_b
                .views
                .borrow_and_update()
                .as_ref()
                .is_some_and(|frame| frame.seq == 1)
            {
                break;
            }
        }
    })
    .await
    .context("view did not cross Redis")?;
    let deadline = std::time::Instant::now() + WAIT;
    while a.signal("p1").0.followers.is_empty() {
        anyhow::ensure!(
            std::time::Instant::now() < deadline,
            "followers did not cross Redis"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}
