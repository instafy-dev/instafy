//! The limits on inline completions and conversation titles, the side calls
//! that run on a person's own AI connection outside any job, on the migrated
//! database (`ai_connection_limits`). Each kind counts per person in a rolling
//! minute and hour, across controller instances, before the provider is
//! called. A call that reaches no provider counts nothing, a call already over
//! a limit is refused without waiting for a lock, and a call gives its pooled
//! connection back before the provider answers.

use std::future::Future;
use std::time::Duration;

use axum::http::StatusCode;
use futures_util::FutureExt;
use httpmock::Method::POST;
use httpmock::MockServer;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::ai_connection_limits::{
    prune_ai_connection_attempts, take_side_call_lock, AiConnectionLimits, SideCall,
};
use crate::config::PgPool;
use crate::tests::{
    build_test_state, require_origin_test_pool, require_origin_test_pool_with_max_size,
    spawn_aborting, sql, sql_one,
};
use crate::tests_ai_connection_limits::{
    api_error, assert_limited, config, receipts, send, user_token, warm_pool, with_users, SlowProxy,
};

const MINUTE_SECONDS: i64 = 60;
const HOUR_SECONDS: i64 = 60 * 60;

/// One kind of side call, as a test sends it and as its limits refuse it.
struct Kind {
    call: SideCall,
    action: &'static str,
    code: &'static str,
    per_minute: i64,
    per_hour: i64,
}

impl Kind {
    fn all() -> [Self; 2] {
        let limits = AiConnectionLimits::FOR_EVERYONE;
        [
            Self {
                call: SideCall::EditorCompletion,
                action: "editor_completion",
                code: "editor_completion_rate_limited",
                per_minute: limits.completions_per_minute,
                per_hour: limits.completions_per_hour,
            },
            Self {
                call: SideCall::ConversationTitle,
                action: "conversation_title",
                code: "conversation_title_rate_limited",
                per_minute: limits.titles_per_minute,
                per_hour: limits.titles_per_hour,
            },
        ]
    }

    /// The route of this kind in `project_id`, and a request body that
    /// reaches the provider.
    fn request(&self, project_id: Uuid) -> (String, Value) {
        match self.call {
            SideCall::EditorCompletion => (
                format!("/projects/{project_id}/editor/completions"),
                json!({
                    "path": "src/report.ts",
                    "prefix": "const title = ",
                    "suffix": "",
                    "language": "typescript",
                }),
            ),
            SideCall::ConversationTitle => (
                format!("/projects/{project_id}/conversation/title"),
                json!({ "message": "Plan the quarterly report" }),
            ),
        }
    }

    /// The field of the answer that holds the provider's text.
    fn answer_field(&self) -> &'static str {
        match self.call {
            SideCall::EditorCompletion => "completion",
            SideCall::ConversationTitle => "title",
        }
    }
}

/// What the provider says, through the proxy, to every side call: an
/// assistant message, the only output the controller reads text from.
fn provider_answer() -> Value {
    json!({
        "output": [{
            "type": "message",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "Quarterly report" }],
        }],
    })
}

/// A space its owner can write to, and the owner's default connection.
#[derive(Clone, Copy)]
struct Space {
    org_id: Uuid,
    project_id: Uuid,
    owner: Uuid,
    connection_id: Uuid,
}

/// Makes `people`, a space the first of them owns with a default connection
/// of their own, runs `body`, then deletes the space and the people, with
/// their connections and receipts, whether `body` passed, failed or panicked.
async fn with_space<F, Fut>(pool: &PgPool, people: &[Uuid], body: F) -> anyhow::Result<()>
where
    F: FnOnce(Space) -> Fut,
    Fut: Future<Output = anyhow::Result<()>>,
{
    with_users(pool, people, async {
        let owner = people[0];
        let org_id = Uuid::new_v4();
        let project_id = Uuid::new_v4();
        sql(
            pool,
            "insert into organizations (id, slug, name) values ($1, $2, 'Side call limits')",
            &[&org_id, &format!("side-call-limits-{org_id}")],
        )
        .await?;
        let outcome = std::panic::AssertUnwindSafe(async {
            sql(
                pool,
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
                &[&org_id, &owner],
            )
            .await?;
            sql(
                pool,
                "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                 values ($1, $2, 'Side call limits', $3, 'customer', 'active')",
                &[&project_id, &org_id, &owner],
            )
            .await?;
            let connection_id: Uuid = sql_one(
                pool,
                "insert into user_credentials
                   (user_id, kind, label, nonce_b64, ciphertext_b64, is_default)
                 values ($1, 'openai_api_key', 'Own key', 'fixture', 'fixture', true)
                 returning id",
                &[&owner],
            )
            .await?;
            body(Space {
                org_id,
                project_id,
                owner,
                connection_id,
            })
            .await
        })
        .catch_unwind()
        .await;
        sql(pool, "delete from projects where id = $1", &[&project_id]).await?;
        sql(pool, "delete from organizations where id = $1", &[&org_id]).await?;
        match outcome {
            Ok(result) => result,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    })
    .await
}

/// `count` side calls of `action` that `user_id` made `seconds_ago`, closed
/// as the controller writes them.
async fn seed_side_calls(
    pool: &PgPool,
    user_id: Uuid,
    action: &str,
    count: i64,
    seconds_ago: i64,
) -> anyhow::Result<()> {
    sql(
        pool,
        "insert into ai_connection_attempts
           (user_id, action, credential_id, created_at, completed_at)
         select $1, $2, gen_random_uuid(),
                now() - $4::bigint * interval '1 second',
                now() - $4::bigint * interval '1 second'
           from generate_series(1, $3::bigint)",
        &[&user_id, &action, &count, &seconds_ago],
    )
    .await?;
    Ok(())
}

/// Each kind of side call reaches the provider until its minute, or its hour,
/// holds its limit, and then answers 429 with that window before the provider
/// is called. The call that got through is counted on the connection it ran
/// on, closed, and marks that connection used.
#[tokio::test]
async fn side_calls_count_in_their_minute_and_hour_before_the_provider() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("side_calls_count_in_their_minute_and_hour_before_the_provider")
            .await?;
    let proxy = MockServer::start_async().await;
    let answers = proxy
        .mock_async(|when, then| {
            when.method(POST).path("/v1/responses");
            then.status(200).json_body(provider_answer());
        })
        .await;
    let config = config("ai-side-call-limits", Some(proxy.base_url()));
    let app =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));

    let mut answered_calls = 0;
    for kind in Kind::all() {
        // Seeded a few seconds ago, the calls fill the minute; ten minutes
        // ago, only the hour.
        for (limit, window_seconds, seconds_ago) in [
            (kind.per_minute, MINUTE_SECONDS, 5),
            (kind.per_hour, HOUR_SECONDS, 10 * 60),
        ] {
            let owner = Uuid::new_v4();
            with_space(&pool, &[owner], |space| {
                let (app, pool, config, kind) = (&app, &pool, &config, &kind);
                async move {
                    let token = user_token(config, space.owner);
                    let (uri, body) = kind.request(space.project_id);
                    seed_side_calls(pool, space.owner, kind.action, limit - 1, seconds_ago).await?;

                    let (status, answered) =
                        send(app, &token, "POST", &uri, Some(body.clone())).await?;
                    assert_eq!(status, StatusCode::OK, "{answered}");
                    assert_eq!(
                        answered[kind.answer_field()],
                        json!("Quarterly report"),
                        "{answered}"
                    );
                    assert_eq!(
                        answered["credentialId"],
                        json!(space.connection_id.to_string())
                    );
                    let (on_connection, closed): (i64, i64) = {
                        let row = pool
                            .get()
                            .await?
                            .query_one(
                                "select count(*) filter (where credential_id = $3)::bigint,
                                        count(*) filter (where completed_at is not null)::bigint
                                   from ai_connection_attempts
                                  where user_id = $1 and action = $2",
                                &[&space.owner, &kind.action, &space.connection_id],
                            )
                            .await?;
                        (row.get(0), row.get(1))
                    };
                    assert_eq!(on_connection, 1, "the call counts on its connection");
                    assert_eq!(closed, limit, "a side call's receipt is closed");
                    let last_used: Option<chrono::DateTime<chrono::Utc>> = sql_one(
                        pool,
                        "select last_used_at from user_credentials where id = $1",
                        &[&space.connection_id],
                    )
                    .await?;
                    assert!(
                        last_used.is_some(),
                        "an answered call marks its connection used"
                    );

                    let (status, refused) = send(app, &token, "POST", &uri, Some(body)).await?;
                    assert_limited(status, &refused, kind.code, limit, window_seconds);
                    assert_eq!(receipts(pool, space.owner, kind.action).await?, limit);
                    Ok(())
                }
            })
            .await?;
            answered_calls += 1;
            assert_eq!(
                answers.hits_async().await,
                answered_calls,
                "a refused {} reached the provider",
                kind.action
            );
        }
    }
    Ok(())
}

/// A call that reaches no provider counts nothing: one from a person without
/// a connection of their own, one naming a connection that is not theirs,
/// one with nothing to complete or title, and one from a person who cannot
/// write to the space.
#[tokio::test]
async fn side_calls_that_reach_no_provider_count_nothing() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("side_calls_that_reach_no_provider_count_nothing").await?;
    let proxy = MockServer::start_async().await;
    let answers = proxy
        .mock_async(|when, then| {
            when.method(POST).path("/v1/responses");
            then.status(200).json_body(provider_answer());
        })
        .await;
    let config = config("ai-side-call-limits", Some(proxy.base_url()));
    let app =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let owner = Uuid::new_v4();
    let member = Uuid::new_v4();
    let stranger = Uuid::new_v4();

    with_space(&pool, &[owner, member, stranger], |space| {
        let (app, pool, config) = (&app, &pool, &config);
        async move {
            // A member who can write to the space but saved no connection.
            sql(
                pool,
                "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
                &[&space.org_id, &member],
            )
            .await?;
            let stranger_connection: Uuid = sql_one(
                pool,
                "insert into user_credentials
                   (user_id, kind, label, nonce_b64, ciphertext_b64, is_default)
                 values ($1, 'openai_api_key', 'Stranger key', 'fixture', 'fixture', true)
                 returning id",
                &[&stranger],
            )
            .await?;

            for kind in Kind::all() {
                let (uri, body) = kind.request(space.project_id);
                let empty = match kind.call {
                    SideCall::EditorCompletion => {
                        json!({ "path": "src/report.ts", "prefix": " \n", "suffix": "" })
                    }
                    SideCall::ConversationTitle => json!({ "message": "   " }),
                };
                let mut naming_another = body.clone();
                naming_another["credentialId"] = json!(stranger_connection.to_string());

                for (who, request) in [
                    (member, body.clone()),
                    (space.owner, naming_another),
                    (space.owner, empty),
                ] {
                    let token = user_token(config, who);
                    let (status, answered) = send(app, &token, "POST", &uri, Some(request)).await?;
                    assert_eq!(status, StatusCode::OK, "{answered}");
                    assert_eq!(answered[kind.answer_field()], Value::Null, "{answered}");
                    assert_eq!(answered["credentialId"], Value::Null, "{answered}");
                }
                let token = user_token(config, stranger);
                let (status, refused) = send(app, &token, "POST", &uri, Some(body)).await?;
                assert_eq!(status, StatusCode::FORBIDDEN, "{refused}");

                for who in [space.owner, member, stranger] {
                    assert_eq!(receipts(pool, who, kind.action).await?, 0);
                }
            }
            assert_eq!(answers.hits_async().await, 0);
            Ok(())
        }
    })
    .await
}

/// Two calls of the minute's last slot reach two controllers at once: the
/// lock of that kind lets one reach the provider and refuses the other.
#[tokio::test]
async fn concurrent_side_calls_cannot_share_the_last_slot() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("concurrent_side_calls_cannot_share_the_last_slot").await?;
    let proxy = MockServer::start_async().await;
    let answers = proxy
        .mock_async(|when, then| {
            when.method(POST).path("/v1/responses");
            then.status(200).json_body(provider_answer());
        })
        .await;
    let config = config("ai-side-call-limits", Some(proxy.base_url()));
    let first =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let second =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));

    let mut answered_calls = 0;
    for kind in Kind::all() {
        let owner = Uuid::new_v4();
        with_space(&pool, &[owner], |space| {
            let (first, second, pool, config, kind) = (&first, &second, &pool, &config, &kind);
            async move {
                let token = user_token(config, space.owner);
                let (uri, body) = kind.request(space.project_id);
                seed_side_calls(pool, space.owner, kind.action, kind.per_minute - 1, 5).await?;
                warm_pool(pool, 3).await?;
                let (a, b) = tokio::join!(
                    send(first, &token, "POST", &uri, Some(body.clone())),
                    send(second, &token, "POST", &uri, Some(body)),
                );
                let answers = [a?, b?];
                let passed = answers
                    .iter()
                    .filter(|(status, _)| *status == StatusCode::OK)
                    .count();
                assert_eq!(passed, 1, "{answers:?}");
                for (status, body) in answers
                    .iter()
                    .filter(|(status, _)| *status != StatusCode::OK)
                {
                    assert_limited(*status, body, kind.code, kind.per_minute, MINUTE_SECONDS);
                }
                assert_eq!(
                    receipts(pool, space.owner, kind.action).await?,
                    kind.per_minute
                );
                Ok(())
            }
        })
        .await?;
        answered_calls += 1;
        assert_eq!(answers.hits_async().await, answered_calls);
    }
    Ok(())
}

/// A call the counts already refuse is answered at once, even while another
/// request holds the lock it would otherwise wait for, so a flood of refused
/// calls cannot queue on it with a pooled connection each.
#[tokio::test]
async fn refused_side_calls_do_not_wait_for_a_lock() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("refused_side_calls_do_not_wait_for_a_lock").await?;
    let proxy = MockServer::start_async().await;
    let answers = proxy
        .mock_async(|when, then| {
            when.method(POST).path("/v1/responses");
            then.status(200).json_body(provider_answer());
        })
        .await;
    let config = config("ai-side-call-limits", Some(proxy.base_url()));
    let app =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let owner = Uuid::new_v4();

    with_space(&pool, &[owner], |space| {
        let (app, pool, config) = (&app, &pool, &config);
        async move {
            // Each kind's hour is used, and another request holds both locks.
            for kind in Kind::all() {
                seed_side_calls(pool, space.owner, kind.action, kind.per_hour, 10 * 60).await?;
            }
            let mut holder = pool.get().await?;
            let holding = holder.transaction().await?;
            for kind in Kind::all() {
                take_side_call_lock(&holding, space.owner, kind.call)
                    .await
                    .map_err(api_error)?;
            }

            let token = user_token(config, space.owner);
            let calls = Kind::all().map(|kind| {
                let (uri, body) = kind.request(space.project_id);
                let (app, token) = (app.clone(), token.clone());
                (
                    kind,
                    spawn_aborting(
                        async move { send(&app, &token, "POST", &uri, Some(body)).await },
                    ),
                )
            });
            let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
            while calls.iter().any(|(_, call)| !call.is_finished())
                && tokio::time::Instant::now() < deadline
            {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let waiting = calls
                .iter()
                .filter(|(_, call)| !call.is_finished())
                .map(|(kind, _)| kind.action)
                .collect::<Vec<_>>();
            holding.commit().await?;
            assert!(
                waiting.is_empty(),
                "refused side calls waited for a lock: {waiting:?}"
            );

            for (kind, call) in calls {
                let (status, body) = call.await??;
                assert_limited(status, &body, kind.code, kind.per_hour, HOUR_SECONDS);
            }
            assert_eq!(answers.hits_async().await, 0);
            Ok(())
        }
    })
    .await
}

/// A provider that is slow to answer must not hold a database connection: on
/// a pool of one, a side call gives its slot back before the provider is
/// called, or every other request waits behind the provider. The call is
/// counted by then.
#[tokio::test]
async fn a_side_call_returns_its_pool_slot_before_the_provider() -> anyhow::Result<()> {
    let pool = require_origin_test_pool_with_max_size(
        "a_side_call_returns_its_pool_slot_before_the_provider",
        1,
    )
    .await?;
    let proxy = SlowProxy::start().await?;
    let config = config("ai-side-call-limits", Some(proxy.url.clone()));
    let app =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));

    for kind in Kind::all() {
        let owner = Uuid::new_v4();
        with_space(&pool, &[owner], |space| {
            let (app, pool, config, proxy, kind) = (&app, &pool, &config, &proxy, &kind);
            async move {
                let (uri, body) = kind.request(space.project_id);
                let calling = spawn_aborting({
                    let app = app.clone();
                    let token = user_token(config, space.owner);
                    async move { send(&app, &token, "POST", &uri, Some(body)).await }
                });
                tokio::time::timeout(Duration::from_secs(10), proxy.reached.notified())
                    .await
                    .expect("the side call never reached the proxy");

                let other_request = tokio::time::timeout(Duration::from_secs(2), pool.get())
                    .await
                    .expect("the side call kept its pool connection while the provider answered")?;
                let counted: i64 = other_request
                    .query_one(
                        "select count(*)::bigint from ai_connection_attempts
                          where user_id = $1 and action = $2",
                        &[&space.owner, &kind.action],
                    )
                    .await?
                    .get(0);
                drop(other_request);
                assert_eq!(
                    counted, 1,
                    "the side call was not counted before the provider"
                );

                proxy.respond.notify_one();
                let (status, answered) = tokio::time::timeout(Duration::from_secs(10), calling)
                    .await
                    .expect("the side call did not finish after the provider answered")??;
                assert_eq!(status, StatusCode::OK, "{answered}");
                Ok(())
            }
        })
        .await?;
    }
    Ok(())
}

/// Side-call receipts are kept two hours, past the hour that counts them;
/// tests and ChatGPT-login starts are still kept a day.
#[tokio::test]
async fn retention_prune_keeps_side_calls_two_hours() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("retention_prune_keeps_side_calls_two_hours").await?;
    let person = Uuid::new_v4();
    with_users(&pool, &[person], async {
        for kind in Kind::all() {
            seed_side_calls(&pool, person, kind.action, 3, 3 * HOUR_SECONDS).await?;
            seed_side_calls(&pool, person, kind.action, 2, HOUR_SECONDS + 30 * 60).await?;
        }
        sql(
            &pool,
            "insert into ai_connection_attempts (user_id, action, credential_id, created_at)
             values ($1, 'credential_test', gen_random_uuid(), now() - interval '3 hours')",
            &[&person],
        )
        .await?;

        let deleted = prune_ai_connection_attempts(&pool).await?;
        assert!(deleted >= 6, "deleted {deleted}");
        for kind in Kind::all() {
            assert_eq!(receipts(&pool, person, kind.action).await?, 2);
        }
        assert_eq!(receipts(&pool, person, "credential_test").await?, 1);
        Ok(())
    })
    .await
}

/// The table takes receipts of both side calls, and still nothing else.
#[tokio::test]
async fn ai_connection_attempts_take_side_call_receipts() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("ai_connection_attempts_take_side_call_receipts").await?;
    let person = Uuid::new_v4();
    with_users(&pool, &[person], async {
        for action in ["editor_completion", "conversation_title"] {
            sql(
                &pool,
                "insert into ai_connection_attempts (user_id, action, credential_id, completed_at)
                 values ($1, $2, gen_random_uuid(), clock_timestamp())",
                &[&person, &action],
            )
            .await?;
        }
        let refused = sql(
            &pool,
            "insert into ai_connection_attempts (user_id, action) values ($1, 'agent_turn')",
            &[&person],
        )
        .await
        .expect_err("an unknown action is refused");
        let code = refused
            .chain()
            .find_map(|cause| cause.downcast_ref::<tokio_postgres::Error>())
            .and_then(tokio_postgres::Error::code)
            .cloned();
        assert_eq!(
            code,
            Some(tokio_postgres::error::SqlState::CHECK_VIOLATION),
            "{refused:#}"
        );
        assert_eq!(receipts(&pool, person, "editor_completion").await?, 1);
        assert_eq!(receipts(&pool, person, "conversation_title").await?, 1);
        Ok(())
    })
    .await
}
