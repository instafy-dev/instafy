//! A turn ends in a burst on one conversation: the agent's last messages
//! (secret cards, token usage, the reply) and `run.completed`, within a
//! second or two, while the turn's own handlers hold pool connections. Every
//! agent message names the runtime it ran on, so each one used to take an
//! access check of its own on every open stream, and a check that could not
//! get a connection dropped the message without a word to the client. These
//! tests drive that burst through `/events`.

use super::controller_event_fanout_tests::next_stream_event;
use super::*;
use crate::conversations::{publish_conversation_message_event, ConversationMessageRow};
use crate::state::publish_controller_event_with_conversation;
use std::time::Duration;

/// A space with one public conversation its owner reads and one hosted
/// runtime the turn ran on.
struct Space {
    org_id: Uuid,
    project_id: Uuid,
    owner_user_id: Uuid,
    conversation_id: Uuid,
    runtime_id: Uuid,
}

async fn insert_space(pool: &PgPool) -> anyhow::Result<Space> {
    let space = Space {
        org_id: Uuid::new_v4(),
        project_id: Uuid::new_v4(),
        owner_user_id: Uuid::new_v4(),
        conversation_id: Uuid::new_v4(),
        runtime_id: Uuid::new_v4(),
    };
    ensure_test_user(pool, &space.owner_user_id).await?;
    let connection = pool.get().await?;
    connection
        .execute(
            "insert into organizations (id, slug, name) values ($1, $2, 'Event burst')",
            &[&space.org_id, &format!("event-burst-{}", space.org_id)],
        )
        .await?;
    connection
        .execute(
            "insert into projects (id, org_id, project_type, owner_user_id, status)
             values ($1, $2, 'customer', $3, 'active')",
            &[&space.project_id, &space.org_id, &space.owner_user_id],
        )
        .await?;
    connection
        .execute(
            "insert into conversations (id, project_id, created_by, metadata, visibility)
             values ($1, $2, $3, '{}'::jsonb, 'public')",
            &[
                &space.conversation_id,
                &space.project_id,
                &space.owner_user_id,
            ],
        )
        .await?;
    connection
        .execute(
            "insert into runtimes
               (id, project_id, provider, status, capabilities, idle_ttl_seconds, last_seen_at)
             values ($1, $2, 'instafy-cloud', 'ready', '{}'::jsonb, 600, now())",
            &[&space.runtime_id, &space.project_id],
        )
        .await?;
    Ok(space)
}

async fn remove_space(pool: &PgPool, space: &Space) -> anyhow::Result<()> {
    cleanup_origin_project(pool, &space.project_id).await?;
    cleanup_org(pool, &space.org_id).await?;
    cleanup_test_user(pool, &space.owner_user_id).await
}

/// A pool of `max_size` connections whose checkout gives up after `wait`,
/// as production's gives up after 10 s.
async fn short_wait_pool(max_size: u32, wait: Duration) -> anyhow::Result<PgPool> {
    let url = std::env::var("TEST_DATABASE_URL")?;
    let manager =
        PostgresConnectionManager::new_from_stringlike(&url, crate::config::database_tls())?;
    Ok(bb8::Pool::builder()
        .max_size(max_size)
        .connection_timeout(wait)
        .build(manager)
        .await?)
}

/// An agent message as `append_job_message` and the job's completion
/// publish it: the runtime it ran on is named three times in its metadata,
/// by the runtime agent (`runtimeId`, `runtime_id`) and by the controller's
/// lease metrics (`leasedByRuntimeId`).
fn publish_agent_message(
    state: &AppState,
    space: &Space,
    run_id: Uuid,
    message_type: &str,
    marker: &str,
) {
    let runtime_id = space.runtime_id.to_string();
    publish_conversation_message_event(
        &state.events,
        &ConversationMessageRow {
            id: Uuid::new_v4(),
            conversation_id: space.conversation_id,
            project_id: space.project_id,
            session_id: None,
            created_by: None,
            prompt_id: None,
            run_id: Some(run_id),
            role: "assistant".to_string(),
            content: marker.to_string(),
            metadata: json!({
                "messageType": message_type,
                "runtimeId": runtime_id,
                "runtime_id": runtime_id,
                "leaseMetrics": { "leasedByRuntimeId": runtime_id, "leaseAttempts": 1 },
            }),
            created_at: Utc::now(),
        },
    );
}

/// The end of a skill-setup turn: two secret cards, token usage, the reply
/// and `run.completed`, as the 2026-10-18 turn published them.
fn publish_turn_end(state: &AppState, space: &Space, run_id: Uuid) {
    publish_agent_message(state, space, run_id, "secret_request", "first-secret-card");
    publish_agent_message(state, space, run_id, "secret_request", "second-secret-card");
    publish_agent_message(state, space, run_id, "token_usage", "turn-token-usage");
    publish_agent_message(state, space, run_id, "assistant", "turn-reply");
    publish_controller_event_with_conversation(
        &state.events,
        "run.completed",
        Some(space.project_id),
        None,
        Some(space.conversation_id),
        Some(run_id),
        Some(Uuid::new_v4()),
        json!({
            "outcome": "success",
            "leaseMetrics": { "leasedByRuntimeId": space.runtime_id.to_string() },
        }),
    );
}

const TURN_END_MARKERS: [&str; 4] = [
    "first-secret-card",
    "second-secret-card",
    "turn-token-usage",
    "turn-reply",
];

/// The message contents among `seen`, in the order they arrived.
fn delivered_messages(seen: &[serde_json::Value]) -> Vec<String> {
    seen.iter()
        .filter(|event| event["kind"] == "conversation.message_created")
        .filter_map(|event| event["data"]["content"].as_str().map(str::to_string))
        .collect()
}

async fn open_stream(
    state: &AppState,
    query: &str,
    user_id: &Uuid,
) -> anyhow::Result<axum::body::BodyDataStream> {
    let token = crate::auth::issue_controller_token(&state.config, user_id)
        .map_err(|error| controller_error("issue event burst token", error))?
        .token;
    let response = crate::events::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(format!("/events?{query}"))
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    Ok(response.into_body().into_data_stream())
}

fn burst_config(key_id: &str) -> AppConfig {
    build_app_config(test_origin_private_key(), test_origin_public_key(), key_id)
}

/// The whole closing burst of a turn takes one access check on a stream,
/// not one per message: the messages and `run.completed` all name the same
/// conversation and the same runtime.
#[tokio::test]
async fn a_closing_turn_takes_one_access_check_per_stream() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping event burst test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_event_test_tables(&pool).await?;
    let space = insert_space(&pool).await?;
    let state = build_test_state(pool.clone(), burst_config("event-burst-checks"));
    let mut body = open_stream(
        &state,
        &format!("projectId={}", space.project_id),
        &space.owner_user_id,
    )
    .await?;

    let checkouts_before = pool_gets(&pool);
    publish_turn_end(&state, &space, Uuid::new_v4());
    let (mut buffer, mut seen) = (String::new(), Vec::new());
    next_stream_event(&mut body, &mut buffer, &mut seen, "run.completed").await?;

    assert_eq!(delivered_messages(&seen), TURN_END_MARKERS);
    assert_eq!(
        pool_gets(&pool) - checkouts_before,
        1,
        "the burst should take one access check"
    );

    remove_space(&pool, &space).await
}

/// The turn's handlers hold the pool while it ends. A stream that checked
/// this conversation and runtime moments ago (for the turn's last tool
/// update) delivers the whole closing burst without waiting for a
/// connection.
#[tokio::test]
async fn a_closing_turn_reaches_the_stream_while_the_pool_is_held() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping event burst test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_event_test_tables(&pool).await?;
    let space = insert_space(&pool).await?;
    let busy_pool = short_wait_pool(1, Duration::from_millis(300)).await?;
    let state = build_test_state(busy_pool.clone(), burst_config("event-burst-held-pool"));
    let mut body = open_stream(
        &state,
        &format!("projectId={}", space.project_id),
        &space.owner_user_id,
    )
    .await?;
    let run_id = Uuid::new_v4();
    let (mut buffer, mut seen) = (String::new(), Vec::new());

    publish_agent_message(&state, &space, run_id, "tool_update", "last-tool-update");
    next_stream_event(
        &mut body,
        &mut buffer,
        &mut seen,
        "conversation.message_created",
    )
    .await?;

    let held = busy_pool.get().await?;
    publish_turn_end(&state, &space, run_id);
    next_stream_event(&mut body, &mut buffer, &mut seen, "run.completed").await?;
    drop(held);

    let mut expected = vec!["last-tool-update"];
    expected.extend(TURN_END_MARKERS);
    assert_eq!(delivered_messages(&seen), expected);

    remove_space(&pool, &space).await
}

/// When a check cannot get a connection even after its retry, the event is
/// still withheld (access is never assumed), but the stream says so: the
/// client gets `events.resync` and re-reads what it missed. The next event
/// is checked again and delivered.
#[tokio::test]
async fn an_event_dropped_for_a_busy_pool_tells_the_stream_to_resync() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping event burst test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_event_test_tables(&pool).await?;
    let space = insert_space(&pool).await?;
    let busy_pool = short_wait_pool(1, Duration::from_millis(200)).await?;
    let state = build_test_state(busy_pool.clone(), burst_config("event-burst-resync"));
    let mut body = open_stream(
        &state,
        &format!("projectId={}", space.project_id),
        &space.owner_user_id,
    )
    .await?;
    let run_id = Uuid::new_v4();
    let (mut buffer, mut seen) = (String::new(), Vec::new());

    let held = busy_pool.get().await?;
    publish_agent_message(&state, &space, run_id, "secret_request", "withheld-card");
    let resync = next_stream_event(&mut body, &mut buffer, &mut seen, "events.resync").await?;
    drop(held);
    assert_eq!(
        resync["data"],
        json!({ "reason": "access_check_unavailable" })
    );
    assert_eq!(resync["project_id"], json!(space.project_id));
    assert!(
        delivered_messages(&seen).is_empty(),
        "an unchecked event must not be delivered: {seen:?}"
    );

    publish_agent_message(&state, &space, run_id, "assistant", "after-the-pool-frees");
    next_stream_event(
        &mut body,
        &mut buffer,
        &mut seen,
        "conversation.message_created",
    )
    .await?;
    assert_eq!(delivered_messages(&seen), ["after-the-pool-frees"]);

    remove_space(&pool, &space).await
}

/// A stream that falls more than the broadcast's capacity behind loses the
/// oldest events; it now says so with `events.resync`. A stream filtered to
/// other kinds is not sent one.
#[tokio::test]
async fn a_lagging_stream_is_told_to_resync() -> anyhow::Result<()> {
    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping event burst test: TEST_DATABASE_URL not set");
        return Ok(());
    };
    ensure_conversation_event_test_tables(&pool).await?;
    let space = insert_space(&pool).await?;
    let state = build_test_state(pool.clone(), burst_config("event-burst-lag"));
    let mut unfiltered = open_stream(
        &state,
        &format!("projectId={}", space.project_id),
        &space.owner_user_id,
    )
    .await?;
    let mut messages_only = open_stream(
        &state,
        &format!(
            "projectId={}&kind=conversation.message_created",
            space.project_id
        ),
        &space.owner_user_id,
    )
    .await?;

    // Other spaces' events, enough to overrun every unread stream on the node.
    let elsewhere = Uuid::new_v4();
    for index in 0..300 {
        publish_controller_event(
            &state.events,
            "project.changed",
            Some(elsewhere),
            None,
            None,
            None,
            json!({ "index": index }),
        );
    }
    publish_agent_message(&state, &space, Uuid::new_v4(), "assistant", "after-the-lag");

    let (mut buffer, mut seen) = (String::new(), Vec::new());
    let resync =
        next_stream_event(&mut unfiltered, &mut buffer, &mut seen, "events.resync").await?;
    assert_eq!(resync["data"], json!({ "reason": "lagged" }));
    next_stream_event(
        &mut unfiltered,
        &mut buffer,
        &mut seen,
        "conversation.message_created",
    )
    .await?;
    assert_eq!(delivered_messages(&seen), ["after-the-lag"]);

    let (mut buffer, mut seen) = (String::new(), Vec::new());
    next_stream_event(
        &mut messages_only,
        &mut buffer,
        &mut seen,
        "conversation.message_created",
    )
    .await?;
    assert_eq!(seen.len(), 1, "only the message: {seen:?}");

    remove_space(&pool, &space).await
}
