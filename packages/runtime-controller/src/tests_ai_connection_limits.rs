//! The limits on new AI connections, connection tests and ChatGPT-login
//! starts, on the migrated database (`ai_connection_limits`). They count per
//! person across controller instances, give the last slot to one request,
//! refuse before any call to a provider or to OpenAI, and refuse a request
//! the counts already rule out without waiting for a lock, and a person's
//! stalled save holds up only that person. They keep one pending ChatGPT
//! login per person, pending for as long as its code is not entered, and cap
//! everyone's, a replaced, cancelled or expired login saves nothing, and a
//! cancel during a save waits for it, for a while.
//! Global counts are read as a baseline first, at a moment none of them is
//! about to change, because the test database is shared by the whole suite.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Json;
use futures_util::FutureExt;
use httpmock::Method::POST;
use httpmock::MockServer;
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Notify};
use tower::ServiceExt;
use uuid::Uuid;

use crate::ai_connection_limits::{
    codex_device_auth_is_open, prune_ai_connection_attempts, reserve_codex_device_auth,
    take_codex_start_locks, AiConnectionLimits, CODEX_DEVICE_AUTH_REPLACED_MESSAGE,
};
use crate::config::PgPool;
use crate::tests::config_env_tests::EnvVarGuard;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    require_origin_test_pool_with_max_size, spawn_aborting, sql, sql_one, test_origin_private_key,
    test_origin_public_key, AbortingTask,
};
use crate::{ApiError, AppConfig, AppState};

const HOUR_SECONDS: i64 = 60 * 60;
const CODEX_ISSUER_ENV: &str = "CODEX_DEVICE_AUTH_ISSUER";

fn config(key_id: &str, proxy_base_url: Option<String>) -> AppConfig {
    let mut config = build_app_config(test_origin_private_key(), test_origin_public_key(), key_id);
    config.proxy_base_url = proxy_base_url;
    config.credential_keys = Some(
        crate::config::CredentialEncryptionKey::for_test("ai-connection-limits-test-key").into(),
    );
    config
}

fn user_token(config: &AppConfig, user_id: Uuid) -> String {
    crate::auth::issue_controller_token(config, &user_id)
        .expect("issue user session")
        .token
}

fn api_error(error: (StatusCode, Json<ApiError>)) -> anyhow::Error {
    let (status, Json(body)) = error;
    anyhow::anyhow!("status {}: {}", status.as_u16(), body.message)
}

async fn send(
    app: &axum::Router,
    token: &str,
    method: &str,
    uri: &str,
    body: Option<Value>,
) -> anyhow::Result<(StatusCode, Value)> {
    let request = Request::builder()
        .method(method)
        .uri(uri)
        .header("authorization", format!("Bearer {token}"))
        .header("content-type", "application/json")
        .body(match body {
            Some(body) => Body::from(serde_json::to_vec(&body)?),
            None => Body::empty(),
        })?;
    let response = app.clone().oneshot(request).await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 64 * 1024).await?;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice::<Value>(&bytes)?
    };
    Ok((status, value))
}

fn codex_login(label: &str) -> Value {
    json!({
        "authJson": {
            "tokens": { "access_token": "fixture-access-token", "account_id": "acct_fixture" }
        },
        "label": label,
    })
}

/// Makes `users`, runs `body`, then deletes the users, and with them their
/// connections, agents and receipts, whether `body` passed, failed or
/// panicked.
async fn with_users(
    pool: &PgPool,
    users: &[Uuid],
    body: impl Future<Output = anyhow::Result<()>>,
) -> anyhow::Result<()> {
    for user_id in users {
        ensure_test_user(pool, user_id).await?;
    }
    let outcome = std::panic::AssertUnwindSafe(body).catch_unwind().await;
    let users = users.to_vec();
    sql(pool, "delete from auth.users where id = any($1)", &[&users]).await?;
    match outcome {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

/// Connections saved `minutes_ago`, as the controller stores them.
async fn seed_connections(
    pool: &PgPool,
    user_id: Uuid,
    count: i64,
    minutes_ago: i64,
) -> anyhow::Result<Vec<Uuid>> {
    let rows = pool
        .get()
        .await?
        .query(
            "insert into user_credentials (user_id, kind, label, nonce_b64, ciphertext_b64, created_at)
             select $1, 'openai_api_key', 'Seeded ' || n, 'fixture', 'fixture',
                    now() - $3::bigint * interval '1 minute'
               from generate_series(1, $2::bigint) as n
             returning id",
            &[&user_id, &count, &minutes_ago],
        )
        .await?;
    Ok(rows.iter().map(|row| row.get("id")).collect())
}

/// ChatGPT-login starts `minutes_ago` that already ended.
async fn seed_finished_codex_starts(
    pool: &PgPool,
    user_id: Uuid,
    count: i64,
    minutes_ago: i64,
) -> anyhow::Result<()> {
    sql(
        pool,
        "insert into ai_connection_attempts (user_id, action, created_at, expires_at, completed_at)
         select $1, 'codex_device_auth',
                now() - $3::bigint * interval '1 minute',
                now() - $3::bigint * interval '1 minute' + interval '15 minutes',
                now() - $3::bigint * interval '1 minute' + interval '1 minute'
           from generate_series(1, $2::bigint)",
        &[&user_id, &count, &minutes_ago],
    )
    .await?;
    Ok(())
}

/// Tests of `credential_id` that ran ten minutes ago.
async fn seed_credential_tests(
    pool: &PgPool,
    user_id: Uuid,
    credential_id: Uuid,
    count: i64,
) -> anyhow::Result<()> {
    sql(
        pool,
        "insert into ai_connection_attempts (user_id, action, credential_id, created_at)
         select $1, 'credential_test', $2, now() - interval '10 minutes'
           from generate_series(1, $3::bigint)",
        &[&user_id, &credential_id, &count],
    )
    .await?;
    Ok(())
}

/// Opens `connections` pooled connections at once and leaves them idle, so
/// requests sent together start together, instead of one opening a
/// connection while the other runs to its end.
async fn warm_pool(pool: &PgPool, connections: usize) -> anyhow::Result<()> {
    let opened = futures_util::future::try_join_all((0..connections).map(|_| pool.get())).await?;
    drop(opened);
    Ok(())
}

/// A pool of one connection on the test database whose checkouts give up
/// after `connection_timeout`, as production's give up after ten seconds.
async fn single_connection_pool(connection_timeout: Duration) -> anyhow::Result<PgPool> {
    let url = std::env::var("TEST_DATABASE_URL")?;
    let manager = bb8_postgres::PostgresConnectionManager::new_from_stringlike(
        &url,
        crate::config::database_tls(),
    )?;
    Ok(bb8::Pool::builder()
        .max_size(1)
        .connection_timeout(connection_timeout)
        .build(manager)
        .await?)
}

/// Everyone's ChatGPT-login starts in the last minute and pending logins, read
/// at a moment neither count is about to change by itself. A start leaving
/// the minute, or a login expiring, between this read and a test's own starts
/// would move the cap the test sets from it.
async fn settled_codex_counts(pool: &PgPool) -> anyhow::Result<(i64, i64)> {
    loop {
        let row = pool
            .get()
            .await?
            .query_one(
                "with starts as (
                   select created_at from ai_connection_attempts
                    where action = 'codex_device_auth'
                      and created_at > clock_timestamp() - interval '1 minute'
                 ), pending as (
                   select expires_at from ai_connection_attempts
                    where action = 'codex_device_auth'
                      and completed_at is null
                      and expires_at > clock_timestamp()
                 )
                 select (select count(*) from starts) as recent_starts,
                        (select count(*) from pending) as pending,
                        extract(epoch from least(
                          (select min(created_at) from starts) + interval '1 minute',
                          (select min(expires_at) from pending)
                        ) - clock_timestamp())::float8 as next_change_seconds",
                &[],
            )
            .await?;
        match row.get::<_, Option<f64>>("next_change_seconds") {
            Some(seconds) if seconds <= 2.0 => {
                tokio::time::sleep(Duration::from_secs_f64(seconds.max(0.0) + 0.05)).await;
            }
            _ => return Ok((row.get("recent_starts"), row.get("pending"))),
        }
    }
}

/// A proxy that answers a probe only when the test lets it.
struct SlowProxy {
    url: String,
    reached: Arc<Notify>,
    respond: Arc<Notify>,
    _server: AbortingTask<()>,
}

impl SlowProxy {
    async fn start() -> anyhow::Result<Self> {
        async fn answer(
            axum::extract::State((reached, respond)): axum::extract::State<(
                Arc<Notify>,
                Arc<Notify>,
            )>,
        ) -> axum::Json<Value> {
            reached.notify_one();
            respond.notified().await;
            axum::Json(json!({ "output": [] }))
        }
        let reached = Arc::new(Notify::new());
        let respond = Arc::new(Notify::new());
        let app = axum::Router::new()
            .route("/v1/responses", axum::routing::post(answer))
            .with_state((reached.clone(), respond.clone()));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let server = spawn_aborting(async move {
            axum::serve(listener, app).await.expect("serve slow proxy");
        });
        Ok(Self {
            url,
            reached,
            respond,
            _server: server,
        })
    }
}

/// An OpenAI issuer that approves every ChatGPT login on its first poll and
/// holds each code exchange until the test releases it. A login held there
/// has looked at its receipt and waits to save its connection.
struct ApprovingIssuer {
    url: String,
    exchanges: mpsc::UnboundedReceiver<oneshot::Sender<()>>,
    _server: AbortingTask<()>,
}

impl ApprovingIssuer {
    async fn start() -> anyhow::Result<Self> {
        async fn user_code() -> axum::Json<Value> {
            axum::Json(json!({
                "device_auth_id": "device-auth-fixture",
                "user_code": "ABCD-EFGH",
                "interval": 1,
            }))
        }
        async fn approve() -> axum::Json<Value> {
            axum::Json(json!({
                "authorization_code": "authorization-code-fixture",
                "code_verifier": "code-verifier-fixture",
            }))
        }
        async fn exchange(
            axum::extract::State(exchanges): axum::extract::State<
                mpsc::UnboundedSender<oneshot::Sender<()>>,
            >,
        ) -> axum::Json<Value> {
            let (release, released) = oneshot::channel();
            if exchanges.send(release).is_ok() {
                // A dropped release lets the exchange answer too.
                let _ = released.await;
            }
            axum::Json(json!({
                "id_token": "header.payload.signature",
                "access_token": "access-token-fixture",
                "refresh_token": "refresh-token-fixture",
            }))
        }
        let (held, exchanges) = mpsc::unbounded_channel();
        let app = axum::Router::new()
            .route(
                "/api/accounts/deviceauth/usercode",
                axum::routing::post(user_code),
            )
            .route(
                "/api/accounts/deviceauth/token",
                axum::routing::post(approve),
            )
            .route("/oauth/token", axum::routing::post(exchange))
            .with_state(held);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let server = spawn_aborting(async move {
            axum::serve(listener, app).await.expect("serve the issuer");
        });
        Ok(Self {
            url,
            exchanges,
            _server: server,
        })
    }

    /// Waits until the next login asks for its tokens, and gives what lets
    /// that exchange answer.
    async fn next_exchange(&mut self) -> anyhow::Result<oneshot::Sender<()>> {
        tokio::time::timeout(Duration::from_secs(30), self.exchanges.recv())
            .await
            .map_err(|_| anyhow::anyhow!("no ChatGPT login asked for its tokens"))?
            .ok_or_else(|| anyhow::anyhow!("the issuer stopped"))
    }
}

/// Lets a held request to the issuer answer. It must still be waiting: a
/// start gives up on its user code after 8 seconds, and a poller on an
/// exchange after 12.
fn release(held: oneshot::Sender<()>) -> anyhow::Result<()> {
    held.send(())
        .map_err(|_| anyhow::anyhow!("the held request ended before it was released"))
}

/// An OpenAI issuer that holds each request for a user code until the test
/// releases it, and never approves a login. A start held there has counted
/// and replaced the person's older login.
struct CodeHoldingIssuer {
    url: String,
    user_codes: mpsc::UnboundedReceiver<oneshot::Sender<()>>,
    _server: AbortingTask<()>,
}

impl CodeHoldingIssuer {
    async fn start() -> anyhow::Result<Self> {
        async fn user_code(
            axum::extract::State(user_codes): axum::extract::State<
                mpsc::UnboundedSender<oneshot::Sender<()>>,
            >,
        ) -> axum::Json<Value> {
            let (release, released) = oneshot::channel();
            if user_codes.send(release).is_ok() {
                // A dropped release lets the request answer too.
                let _ = released.await;
            }
            axum::Json(json!({
                "device_auth_id": "device-auth-fixture",
                "user_code": "ABCD-EFGH",
                "interval": 1,
            }))
        }
        let (held, user_codes) = mpsc::unbounded_channel();
        let app = axum::Router::new()
            .route(
                "/api/accounts/deviceauth/usercode",
                axum::routing::post(user_code),
            )
            .route(
                "/api/accounts/deviceauth/token",
                axum::routing::post(|| async { StatusCode::NOT_FOUND }),
            )
            .with_state(held);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let server = spawn_aborting(async move {
            axum::serve(listener, app).await.expect("serve the issuer");
        });
        Ok(Self {
            url,
            user_codes,
            _server: server,
        })
    }

    /// Waits until the next start asks for its user code, and gives what lets
    /// that request answer.
    async fn next_user_code(&mut self) -> anyhow::Result<oneshot::Sender<()>> {
        tokio::time::timeout(Duration::from_secs(30), self.user_codes.recv())
            .await
            .map_err(|_| anyhow::anyhow!("no ChatGPT login start asked for its code"))?
            .ok_or_else(|| anyhow::anyhow!("the issuer stopped"))
    }
}

/// Waits until the ChatGPT pollers that `state` started have ended: each
/// holds a copy of the controller state until it ends. `idle` is how many
/// copies there are while none runs.
async fn wait_for_pollers_to_end(state: &AppState, idle: usize) -> anyhow::Result<()> {
    wait_until("the ChatGPT pollers to end", || async {
        Ok(state.device_auth_sessions.copies() == idle)
    })
    .await
}

/// How many sessions wait for a lock that the session `pid` holds.
async fn waiting_on(pool: &PgPool, pid: i32) -> anyhow::Result<i64> {
    sql_one(
        pool,
        "select count(*)::bigint from pg_stat_activity
          where $1 = any(pg_blocking_pids(pid))",
        &[&pid],
    )
    .await
}

/// Starts a ChatGPT login through `app`, and gives its session id.
async fn start_codex_login(app: &axum::Router, token: &str) -> anyhow::Result<Uuid> {
    let (status, started) = send(app, token, "POST", "/me/auth/device/codex/start", None).await?;
    anyhow::ensure!(
        status == StatusCode::OK,
        "start answered {status}: {started}"
    );
    Ok(Uuid::parse_str(
        started["sessionId"].as_str().unwrap_or_default(),
    )?)
}

/// A ChatGPT login's status, as `app` answers it.
async fn codex_login_status(
    app: &axum::Router,
    token: &str,
    session_id: Uuid,
) -> anyhow::Result<Value> {
    let (status, login) = send(
        app,
        token,
        "GET",
        &format!("/me/auth/device/{session_id}"),
        None,
    )
    .await?;
    anyhow::ensure!(
        status == StatusCode::OK,
        "status answered {status}: {login}"
    );
    Ok(login)
}

/// Waits until a ChatGPT login is no longer pending, and gives its status.
async fn wait_for_codex_login_to_end(
    app: &axum::Router,
    token: &str,
    session_id: Uuid,
) -> anyhow::Result<Value> {
    wait_until("the ChatGPT login to end", || async {
        Ok(codex_login_status(app, token, session_id).await?["status"] != json!("pending"))
    })
    .await?;
    codex_login_status(app, token, session_id).await
}

/// The connections `user_id` saved, and the connection each of their agents
/// runs on.
async fn connections_and_agents(
    pool: &PgPool,
    user_id: Uuid,
) -> anyhow::Result<(Vec<Uuid>, Vec<Option<Uuid>>)> {
    let connection = pool.get().await?;
    let connections: Vec<Uuid> = connection
        .query(
            "select id from user_credentials where user_id = $1 order by created_at",
            &[&user_id],
        )
        .await?
        .iter()
        .map(|row| row.get("id"))
        .collect();
    let agents: Vec<Option<Uuid>> = connection
        .query(
            "select credential_id from user_agents where user_id = $1 order by created_at",
            &[&user_id],
        )
        .await?
        .iter()
        .map(|row| row.get("credential_id"))
        .collect();
    Ok((connections, agents))
}

async fn receipts(pool: &PgPool, user_id: Uuid, action: &str) -> anyhow::Result<i64> {
    sql_one(
        pool,
        "select count(*)::bigint from ai_connection_attempts where user_id = $1 and action = $2",
        &[&user_id, &action],
    )
    .await
}

async fn is_open(pool: &PgPool, user_id: Uuid, session_id: Uuid) -> anyhow::Result<bool> {
    codex_device_auth_is_open(pool, user_id, session_id)
        .await
        .map_err(api_error)
}

/// Polls `check` every 100 ms for up to 30 s. A ChatGPT poller looks at its
/// login a poll interval after it starts, then every ten seconds.
async fn wait_until<F, Fut>(what: &str, mut check: F) -> anyhow::Result<()>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<bool>>,
{
    for _ in 0..300 {
        if check().await? {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    anyhow::bail!("timed out waiting for {what}")
}

fn assert_limited(status: StatusCode, body: &Value, code: &str, limit: i64, window_seconds: i64) {
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["code"], json!(code), "{body}");
    let details = &body["details"];
    assert_eq!(details["retryable"], json!(true), "{body}");
    assert_eq!(details["limit"], json!(limit), "{body}");
    assert_eq!(details["windowSeconds"], json!(window_seconds), "{body}");
    let retry_after = details["retryAfterSeconds"].as_i64().unwrap_or_default();
    assert!((1..=window_seconds).contains(&retry_after), "{body}");
    let message = body["message"].as_str().unwrap_or_default();
    assert!(
        message.starts_with("Too many ") && message.contains(". Try again in "),
        "{body}"
    );
}

fn assert_capacity_reached(
    error: (StatusCode, Json<ApiError>),
    longest_wait_seconds: i64,
) -> anyhow::Result<()> {
    let (status, Json(body)) = error;
    let body = serde_json::to_value(body)?;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{body}");
    assert_eq!(
        body["code"],
        json!("codex_device_auth_capacity_reached"),
        "{body}"
    );
    assert_eq!(body["details"]["retryable"], json!(true), "{body}");
    let retry_after = body["details"]["retryAfterSeconds"]
        .as_i64()
        .unwrap_or_default();
    assert!((1..=longest_wait_seconds).contains(&retry_after), "{body}");
    Ok(())
}

#[tokio::test]
async fn new_connections_are_counted_across_controller_instances() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("new_connections_are_counted_across_controller_instances").await?;
    let config = config("ai-connection-limits", None);
    // Two controllers over one database, each with its own process state.
    let first =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let second =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();
    let other = Uuid::new_v4();
    let limit = AiConnectionLimits::FOR_EVERYONE.new_connections_per_hour;

    with_users(&pool, &[person, other], async {
        let token = user_token(&config, person);
        let mut saved = Vec::new();
        for n in 0..limit {
            let app = if n % 2 == 0 { &first } else { &second };
            let (status, created) = send(
                app,
                &token,
                "POST",
                "/me/credentials/codex",
                Some(codex_login(&format!("Codex {n}"))),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "connection {n}: {created}");
            saved.push(
                created["credentialId"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string(),
            );
        }

        let (status, refused) = send(
            &first,
            &token,
            "POST",
            "/me/credentials/codex",
            Some(codex_login("One too many")),
        )
        .await?;
        assert_limited(
            status,
            &refused,
            "credential_create_rate_limited",
            limit,
            HOUR_SECONDS,
        );

        // Revoking keeps the row, so it frees nothing.
        let (status, revoked) = send(
            &second,
            &token,
            "DELETE",
            &format!("/me/credentials/{}", saved[0]),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{revoked}");
        let (status, refused) = send(
            &second,
            &token,
            "POST",
            "/me/credentials/codex",
            Some(codex_login("After a revoke")),
        )
        .await?;
        assert_limited(
            status,
            &refused,
            "credential_create_rate_limited",
            limit,
            HOUR_SECONDS,
        );

        // Another person has an allowance of their own.
        let (status, created) = send(
            &first,
            &user_token(&config, other),
            "POST",
            "/me/credentials/codex",
            Some(codex_login("Someone else")),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{created}");

        // When the oldest connection leaves the hour, exactly one slot frees.
        let oldest = Uuid::parse_str(&saved[0])?;
        sql(
            &pool,
            "update user_credentials set created_at = created_at - interval '61 minutes'
             where id = $1",
            &[&oldest],
        )
        .await?;
        let (status, created) = send(
            &second,
            &token,
            "POST",
            "/me/credentials/codex",
            Some(codex_login("Freed slot")),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{created}");
        let (status, refused) = send(
            &first,
            &token,
            "POST",
            "/me/credentials/codex",
            Some(codex_login("Full again")),
        )
        .await?;
        assert_limited(
            status,
            &refused,
            "credential_create_rate_limited",
            limit,
            HOUR_SECONDS,
        );

        let stored: i64 = sql_one(
            &pool,
            "select count(*)::bigint from user_credentials where user_id = $1",
            &[&person],
        )
        .await?;
        assert_eq!(stored, limit + 1);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn concurrent_new_connections_cannot_share_the_last_slot() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("concurrent_new_connections_cannot_share_the_last_slot").await?;
    let config = config("ai-connection-limits", None);
    let first =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let second =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();
    let limit = AiConnectionLimits::FOR_EVERYONE.new_connections_per_hour;

    with_users(&pool, &[person], async {
        seed_connections(&pool, person, limit - 1, 5).await?;
        let token = user_token(&config, person);
        warm_pool(&pool, 4).await?;
        let (a, b, c) = tokio::join!(
            send(
                &first,
                &token,
                "POST",
                "/me/credentials/codex",
                Some(codex_login("A"))
            ),
            send(
                &second,
                &token,
                "POST",
                "/me/credentials/codex",
                Some(codex_login("B"))
            ),
            send(
                &first,
                &token,
                "POST",
                "/me/credentials/codex",
                Some(codex_login("C"))
            ),
        );
        let answers = [a?, b?, c?];
        let saved = answers
            .iter()
            .filter(|(status, _)| *status == StatusCode::OK)
            .count();
        assert_eq!(saved, 1, "{answers:?}");
        for (status, body) in answers
            .iter()
            .filter(|(status, _)| *status != StatusCode::OK)
        {
            assert_limited(
                *status,
                body,
                "credential_create_rate_limited",
                limit,
                HOUR_SECONDS,
            );
        }
        let stored: i64 = sql_one(
            &pool,
            "select count(*)::bigint from user_credentials where user_id = $1",
            &[&person],
        )
        .await?;
        assert_eq!(stored, limit);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn connection_tests_stop_before_the_provider() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("connection_tests_stop_before_the_provider").await?;
    let proxy = MockServer::start_async().await;
    let probes = proxy
        .mock_async(|when, then| {
            when.method(POST).path("/v1/responses");
            then.status(200).json_body(json!({
                "output": [{
                    "type": "message",
                    "content": [{ "type": "output_text", "text": "OK" }],
                }],
            }));
        })
        .await;
    let config = config("ai-connection-limits", Some(proxy.base_url()));
    let app =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();
    let other = Uuid::new_v4();
    let limit = AiConnectionLimits::FOR_EVERYONE.tests_per_hour;

    with_users(&pool, &[person, other], async {
        let token = user_token(&config, person);
        let own = seed_connections(&pool, person, 1, 1).await?[0];
        let revoked = seed_connections(&pool, person, 1, 1).await?[0];
        sql(
            &pool,
            "update user_credentials set revoked_at = now() where id = $1",
            &[&revoked],
        )
        .await?;
        let foreign = seed_connections(&pool, other, 1, 1).await?[0];

        // An unknown, a revoked and another person's connection: not found,
        // and nothing is counted or sent.
        for credential_id in [Uuid::new_v4(), revoked, foreign] {
            let (status, body) = send(
                &app,
                &token,
                "POST",
                &format!("/me/credentials/{credential_id}/test"),
                None,
            )
            .await?;
            assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
        }
        assert_eq!(receipts(&pool, person, "credential_test").await?, 0);
        assert_eq!(receipts(&pool, other, "credential_test").await?, 0);
        assert_eq!(probes.hits_async().await, 0);

        seed_credential_tests(&pool, person, own, limit - 1).await?;
        let (status, tested) = send(
            &app,
            &token,
            "POST",
            &format!("/me/credentials/{own}/test"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{tested}");
        assert_eq!(tested["ok"], json!(true), "{tested}");
        let last_used: Option<chrono::DateTime<chrono::Utc>> = sql_one(
            &pool,
            "select last_used_at from user_credentials where id = $1",
            &[&own],
        )
        .await?;
        assert!(
            last_used.is_some(),
            "a passed test marks the connection used"
        );

        let (status, refused) = send(
            &app,
            &token,
            "POST",
            &format!("/me/credentials/{own}/test"),
            None,
        )
        .await?;
        assert_limited(
            status,
            &refused,
            "credential_test_rate_limited",
            limit,
            HOUR_SECONDS,
        );
        assert_eq!(probes.hits_async().await, 1);
        assert_eq!(receipts(&pool, person, "credential_test").await?, limit);
        Ok(())
    })
    .await
}

/// A provider that is slow to answer a test must not hold a database
/// connection: on a pool of one, the test route gives its slot back before
/// the probe, or every other request waits behind the provider. The test is
/// counted by then.
#[tokio::test]
async fn connection_test_returns_its_pool_slot_before_the_probe() -> anyhow::Result<()> {
    let pool = require_origin_test_pool_with_max_size(
        "connection_test_returns_its_pool_slot_before_the_probe",
        1,
    )
    .await?;
    let proxy = SlowProxy::start().await?;
    let config = config("ai-connection-limits", Some(proxy.url.clone()));
    let app =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();
    with_users(&pool, &[person], async {
        let own = seed_connections(&pool, person, 1, 1).await?[0];
        let testing = spawn_aborting({
            let app = app.clone();
            let token = user_token(&config, person);
            async move {
                send(
                    &app,
                    &token,
                    "POST",
                    &format!("/me/credentials/{own}/test"),
                    None,
                )
                .await
            }
        });
        tokio::time::timeout(Duration::from_secs(10), proxy.reached.notified())
            .await
            .expect("the test never reached the proxy");

        let other_request = tokio::time::timeout(Duration::from_secs(2), pool.get())
            .await
            .expect("the test kept its pool connection while the provider answered")?;
        let counted: i64 = other_request
            .query_one(
                "select count(*)::bigint from ai_connection_attempts
                  where user_id = $1 and action = 'credential_test'",
                &[&person],
            )
            .await?
            .get(0);
        drop(other_request);
        assert_eq!(counted, 1, "the test was not counted before the probe");

        proxy.respond.notify_one();
        let (status, tested) = tokio::time::timeout(Duration::from_secs(10), testing)
            .await
            .expect("the test did not finish after the provider answered")??;
        assert_eq!(status, StatusCode::OK, "{tested}");
        assert_eq!(receipts(&pool, person, "credential_test").await?, 1);
        Ok(())
    })
    .await
}

/// Two tests of the hour's last slot reach two controllers at once: the person
/// lock lets one reach the provider and refuses the other.
#[tokio::test]
async fn concurrent_connection_tests_cannot_share_the_last_slot() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("concurrent_connection_tests_cannot_share_the_last_slot").await?;
    let proxy = MockServer::start_async().await;
    let probes = proxy
        .mock_async(|when, then| {
            when.method(POST).path("/v1/responses");
            then.status(200).json_body(json!({ "output": [] }));
        })
        .await;
    let config = config("ai-connection-limits", Some(proxy.base_url()));
    let first =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let second =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();
    let limit = AiConnectionLimits::FOR_EVERYONE.tests_per_hour;

    with_users(&pool, &[person], async {
        let token = user_token(&config, person);
        let own = seed_connections(&pool, person, 1, 1).await?[0];
        seed_credential_tests(&pool, person, own, limit - 1).await?;
        warm_pool(&pool, 3).await?;
        let uri = format!("/me/credentials/{own}/test");
        let (a, b) = tokio::join!(
            send(&first, &token, "POST", &uri, None),
            send(&second, &token, "POST", &uri, None),
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
            assert_limited(
                *status,
                body,
                "credential_test_rate_limited",
                limit,
                HOUR_SECONDS,
            );
        }
        assert_eq!(probes.hits_async().await, 1);
        assert_eq!(receipts(&pool, person, "credential_test").await?, limit);
        Ok(())
    })
    .await
}

/// Once the provider answered, marking the connection used is best effort:
/// with every database connection busy, the test still reports what the
/// provider said. The connect flow revokes a connection whose test fails, so
/// an error here would revoke a working key.
#[tokio::test]
async fn a_passed_test_is_not_failed_by_a_busy_pool_after_the_probe() -> anyhow::Result<()> {
    let setup =
        require_origin_test_pool("a_passed_test_is_not_failed_by_a_busy_pool_after_the_probe")
            .await?;
    let pool = single_connection_pool(Duration::from_secs(1)).await?;
    let proxy = SlowProxy::start().await?;
    let config = config("ai-connection-limits", Some(proxy.url.clone()));
    let app =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();
    with_users(&setup, &[person], async {
        let own = seed_connections(&setup, person, 1, 1).await?[0];
        let testing = spawn_aborting({
            let app = app.clone();
            let token = user_token(&config, person);
            async move {
                send(
                    &app,
                    &token,
                    "POST",
                    &format!("/me/credentials/{own}/test"),
                    None,
                )
                .await
            }
        });
        tokio::time::timeout(Duration::from_secs(10), proxy.reached.notified())
            .await
            .expect("the test never reached the proxy");

        // Other work holds the only connection when the provider answers.
        let busy = pool.get().await?;
        proxy.respond.notify_one();
        let answered = tokio::time::timeout(Duration::from_secs(10), testing).await;
        drop(busy);
        let (status, tested) = answered.expect("the test did not answer")??;
        assert_eq!(status, StatusCode::OK, "{tested}");
        assert_eq!(tested["ok"], json!(true), "{tested}");
        assert_eq!(receipts(&setup, person, "credential_test").await?, 1);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn codex_starts_replace_the_pending_login() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("codex_starts_replace_the_pending_login").await?;
    let limits = AiConnectionLimits {
        codex_starts_per_hour: 3,
        codex_starts_per_minute: i64::from(i32::MAX),
        codex_pending: i64::from(i32::MAX),
        ..AiConnectionLimits::FOR_EVERYONE
    };
    let person = Uuid::new_v4();
    let saturated = Uuid::new_v4();

    with_users(&pool, &[person, saturated], async {
        let first = Uuid::new_v4();
        let replaced = reserve_codex_device_auth(&pool, person, first, &limits)
            .await
            .map_err(api_error)?;
        assert!(replaced.is_empty(), "{replaced:?}");
        assert!(is_open(&pool, person, first).await?);

        // Each start ends the one before: one pending login per person.
        let second = Uuid::new_v4();
        let replaced = reserve_codex_device_auth(&pool, person, second, &limits)
            .await
            .map_err(api_error)?;
        assert_eq!(replaced, vec![first]);
        assert!(!is_open(&pool, person, first).await?);
        assert!(is_open(&pool, person, second).await?);
        let third = Uuid::new_v4();
        let replaced = reserve_codex_device_auth(&pool, person, third, &limits)
            .await
            .map_err(api_error)?;
        assert_eq!(replaced, vec![second]);

        // A fourth start in the hour is refused and leaves the pending login
        // alone.
        let fourth = Uuid::new_v4();
        let (status, Json(refused)) = reserve_codex_device_auth(&pool, person, fourth, &limits)
            .await
            .expect_err("a fourth start in the hour is over the limit");
        assert_limited(
            status,
            &serde_json::to_value(refused)?,
            "codex_device_auth_rate_limited",
            limits.codex_starts_per_hour,
            HOUR_SECONDS,
        );
        assert!(is_open(&pool, person, third).await?);
        assert_eq!(receipts(&pool, person, "codex_device_auth").await?, 3);

        // Once the first start leaves the hour, one more fits.
        sql(
            &pool,
            "update ai_connection_attempts set created_at = created_at - interval '61 minutes'
             where id = $1",
            &[&first],
        )
        .await?;
        let fifth = Uuid::new_v4();
        let replaced = reserve_codex_device_auth(&pool, person, fifth, &limits)
            .await
            .map_err(api_error)?;
        assert_eq!(replaced, vec![third]);
        assert!(is_open(&pool, person, fifth).await?);

        // No login starts for someone whose connection could not be saved.
        seed_connections(&pool, saturated, limits.new_connections_per_hour, 10).await?;
        let (status, Json(refused)) =
            reserve_codex_device_auth(&pool, saturated, Uuid::new_v4(), &limits)
                .await
                .expect_err("the hour's new connections are used up");
        assert_limited(
            status,
            &serde_json::to_value(refused)?,
            "credential_create_rate_limited",
            limits.new_connections_per_hour,
            HOUR_SECONDS,
        );
        assert_eq!(receipts(&pool, saturated, "codex_device_auth").await?, 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn codex_global_caps_hold_across_people() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("codex_global_caps_hold_across_people").await?;
    let people: Vec<Uuid> = (0..5).map(|_| Uuid::new_v4()).collect();
    let [a, b, c, d, e] = [people[0], people[1], people[2], people[3], people[4]];

    with_users(&pool, &people, async {
        // Everyone's starts in the last minute: two more fit, the third waits.
        let (recent_starts, _) = settled_codex_counts(&pool).await?;
        let limits = AiConnectionLimits {
            codex_starts_per_minute: recent_starts + 2,
            codex_pending: i64::from(i32::MAX),
            ..AiConnectionLimits::FOR_EVERYONE
        };
        for person in [a, b] {
            reserve_codex_device_auth(&pool, person, Uuid::new_v4(), &limits)
                .await
                .map_err(api_error)?;
        }
        let refused = reserve_codex_device_auth(&pool, c, Uuid::new_v4(), &limits)
            .await
            .expect_err("everyone's starts in the minute are used up");
        assert_capacity_reached(refused, 60)?;
        assert_eq!(receipts(&pool, c, "codex_device_auth").await?, 0);

        // Everyone's pending logins: one more fits, then the cap holds.
        let (_, pending) = settled_codex_counts(&pool).await?;
        let limits = AiConnectionLimits {
            codex_starts_per_minute: i64::from(i32::MAX),
            codex_pending: pending + 1,
            ..AiConnectionLimits::FOR_EVERYONE
        };
        let d_login = Uuid::new_v4();
        reserve_codex_device_auth(&pool, d, d_login, &limits)
            .await
            .map_err(api_error)?;
        let refused = reserve_codex_device_auth(&pool, e, Uuid::new_v4(), &limits)
            .await
            .expect_err("everyone's pending logins are at the cap");
        assert_capacity_reached(refused, 15 * 60)?;
        assert_eq!(receipts(&pool, e, "codex_device_auth").await?, 0);

        // A person who replaces their own pending login takes no new place.
        reserve_codex_device_auth(&pool, a, Uuid::new_v4(), &limits)
            .await
            .map_err(api_error)?;
        // A login whose code expired no longer counts as pending.
        sql(
            &pool,
            "update ai_connection_attempts set expires_at = clock_timestamp() - interval '1 second'
             where id = $1",
            &[&d_login],
        )
        .await?;
        reserve_codex_device_auth(&pool, e, Uuid::new_v4(), &limits)
            .await
            .map_err(api_error)?;
        Ok(())
    })
    .await
}

/// Two people start the minute's last ChatGPT login at once: the global lock
/// admits one, and the other finds the cap reached.
#[tokio::test]
async fn concurrent_codex_starts_cannot_share_the_last_global_slot() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("concurrent_codex_starts_cannot_share_the_last_global_slot")
            .await?;
    let people = [Uuid::new_v4(), Uuid::new_v4()];

    with_users(&pool, &people, async {
        let (recent_starts, _) = settled_codex_counts(&pool).await?;
        let limits = AiConnectionLimits {
            codex_starts_per_minute: recent_starts + 1,
            codex_pending: i64::from(i32::MAX),
            ..AiConnectionLimits::FOR_EVERYONE
        };
        warm_pool(&pool, 3).await?;
        let (first, second) = tokio::join!(
            reserve_codex_device_auth(&pool, people[0], Uuid::new_v4(), &limits),
            reserve_codex_device_auth(&pool, people[1], Uuid::new_v4(), &limits),
        );
        let admitted = usize::from(first.is_ok()) + usize::from(second.is_ok());
        assert_eq!(admitted, 1, "{admitted} starts took the minute's last slot");
        let refused = first.err().or(second.err()).expect("one start was refused");
        assert_capacity_reached(refused, 60)?;
        Ok(())
    })
    .await
}

/// A request the counts already refuse is answered at once, even while another
/// request holds the locks it would otherwise wait for, so a flood of refused
/// requests cannot queue on a lock with a pooled connection each. Sets
/// CODEX_DEVICE_AUTH_ISSUER.
#[tokio::test]
async fn refused_requests_do_not_wait_for_a_lock() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("refused_requests_do_not_wait_for_a_lock").await?;
    let issuer = MockServer::start_async().await;
    let usercode = issuer
        .mock_async(|when, then| {
            when.method(POST).path("/api/accounts/deviceauth/usercode");
            then.status(500);
        })
        .await;
    let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.base_url());
    let config = config("ai-connection-limits", None);
    let credentials =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let device_auth =
        crate::device_auth::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();
    let limits = AiConnectionLimits::FOR_EVERYONE;

    with_users(&pool, &[person], async {
        // The hour's new connections, tests and ChatGPT-login starts are used.
        let own = seed_connections(&pool, person, limits.new_connections_per_hour, 10).await?[0];
        seed_credential_tests(&pool, person, own, limits.tests_per_hour).await?;
        seed_finished_codex_starts(&pool, person, limits.codex_starts_per_hour, 30).await?;

        // Another request holds the global lock and the person's lock.
        let mut holder = pool.get().await?;
        let holding = holder.transaction().await?;
        take_codex_start_locks(&holding, person)
            .await
            .map_err(api_error)?;

        let token = user_token(&config, person);
        let request = |app: &axum::Router, uri: String, body: Option<Value>| {
            let app = app.clone();
            let token = token.clone();
            spawn_aborting(async move { send(&app, &token, "POST", &uri, body).await })
        };
        let requests = [
            (
                "save",
                request(
                    &credentials,
                    "/me/credentials/codex".to_string(),
                    Some(codex_login("Refused")),
                ),
            ),
            (
                "test",
                request(&credentials, format!("/me/credentials/{own}/test"), None),
            ),
            (
                "start",
                request(
                    &device_auth,
                    "/me/auth/device/codex/start".to_string(),
                    None,
                ),
            ),
        ];
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while requests.iter().any(|(_, request)| !request.is_finished())
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let waiting = requests
            .iter()
            .filter(|(_, request)| !request.is_finished())
            .map(|(name, _)| *name)
            .collect::<Vec<_>>();
        holding.commit().await?;
        assert!(
            waiting.is_empty(),
            "refused requests waited for a lock: {waiting:?}"
        );

        let [(_, save), (_, test), (_, start)] = requests;
        let (status, body) = save.await??;
        assert_limited(
            status,
            &body,
            "credential_create_rate_limited",
            limits.new_connections_per_hour,
            HOUR_SECONDS,
        );
        let (status, body) = test.await??;
        assert_limited(
            status,
            &body,
            "credential_test_rate_limited",
            limits.tests_per_hour,
            HOUR_SECONDS,
        );
        let (status, body) = start.await??;
        assert_limited(
            status,
            &body,
            "codex_device_auth_rate_limited",
            limits.codex_starts_per_hour,
            HOUR_SECONDS,
        );
        assert_eq!(usercode.hits_async().await, 0);
        Ok(())
    })
    .await
}

/// A save that waits on the database holds its person's lock, and that
/// person's next ChatGPT-login start waits for it. The start waits without the
/// global lock, so everyone else's starts go on meanwhile.
#[tokio::test]
async fn a_stalled_save_holds_up_only_its_persons_starts() -> anyhow::Result<()> {
    let pool = require_origin_test_pool_with_max_size(
        "a_stalled_save_holds_up_only_its_persons_starts",
        8,
    )
    .await?;
    let config = config("ai-connection-limits", None);
    let credentials =
        crate::credentials::router().with_state(build_test_state(pool.clone(), config.clone()));
    let stalled = Uuid::new_v4();
    let other = Uuid::new_v4();
    let limits = AiConnectionLimits {
        codex_starts_per_minute: i64::from(i32::MAX),
        codex_pending: i64::from(i32::MAX),
        ..AiConnectionLimits::FOR_EVERYONE
    };

    with_users(&pool, &[stalled, other], async {
        // Holds the save past its person lock, when it writes the connection.
        let mut holder = pool.get().await?;
        let holding = holder.transaction().await?;
        holding
            .batch_execute("lock table public.user_credentials in share mode")
            .await?;
        let holder_pid: i32 = holding
            .query_one("select pg_backend_pid()", &[])
            .await?
            .get(0);
        let token = user_token(&config, stalled);
        let save = spawn_aborting({
            let credentials = credentials.clone();
            async move {
                send(
                    &credentials,
                    &token,
                    "POST",
                    "/me/credentials/codex",
                    Some(codex_login("Stalled")),
                )
                .await
            }
        });
        wait_until("the save to wait to write the connection", || async {
            Ok(waiting_on(&pool, holder_pid).await? > 0)
        })
        .await?;
        let save_pid: i32 = sql_one(
            &pool,
            "select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
            &[&holder_pid],
        )
        .await?;

        // The same person starts a ChatGPT login, which waits for the save.
        let again = spawn_aborting({
            let pool = pool.clone();
            async move { reserve_codex_device_auth(&pool, stalled, Uuid::new_v4(), &limits).await }
        });
        wait_until("the start to wait for the save", || async {
            Ok(waiting_on(&pool, save_pid).await? > 0)
        })
        .await?;

        let started = tokio::time::timeout(
            Duration::from_secs(5),
            reserve_codex_device_auth(&pool, other, Uuid::new_v4(), &limits),
        )
        .await;
        holding.commit().await?;
        drop(holder);
        started
            .map_err(|_| anyhow::anyhow!("another person's start waited for the stalled save"))?
            .map_err(api_error)?;

        let (status, saved) = save.await??;
        assert_eq!(status, StatusCode::OK, "{saved}");
        again.await?.map_err(api_error)?;
        Ok(())
    })
    .await
}

/// The ChatGPT start route counts a start before it asks OpenAI for a code:
/// the usercode endpoint is hit only by starts the limits allow. Sets
/// CODEX_DEVICE_AUTH_ISSUER, so it relies on the suite running one test at a
/// time.
#[tokio::test]
async fn codex_start_route_refuses_before_calling_openai() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("codex_start_route_refuses_before_calling_openai").await?;
    let issuer = MockServer::start_async().await;
    let usercode = issuer
        .mock_async(|when, then| {
            when.method(POST).path("/api/accounts/deviceauth/usercode");
            then.status(200).json_body(json!({
                "device_auth_id": "device-auth-fixture",
                "user_code": "ABCD-EFGH",
                "interval": 5,
            }));
        })
        .await;
    issuer
        .mock_async(|when, then| {
            when.method(POST).path("/api/accounts/deviceauth/token");
            then.status(404);
        })
        .await;
    let failing_issuer = MockServer::start_async().await;
    let failing_usercode = failing_issuer
        .mock_async(|when, then| {
            when.method(POST).path("/api/accounts/deviceauth/usercode");
            then.status(500);
        })
        .await;
    let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.base_url());
    let config = config("ai-connection-limits", None);
    let app =
        crate::device_auth::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();
    let saturated = Uuid::new_v4();
    let unlucky = Uuid::new_v4();
    let limit = AiConnectionLimits::FOR_EVERYONE.codex_starts_per_hour;

    with_users(&pool, &[person, saturated, unlucky], async {
        let token = user_token(&config, person);
        seed_finished_codex_starts(&pool, person, limit - 2, 30).await?;

        let (status, first) =
            send(&app, &token, "POST", "/me/auth/device/codex/start", None).await?;
        assert_eq!(status, StatusCode::OK, "{first}");
        assert_eq!(first["userCode"], json!("ABCD-EFGH"), "{first}");
        let first_id = Uuid::parse_str(first["sessionId"].as_str().unwrap_or_default())?;

        // The next start replaces the first, which this process stops polling.
        let (status, second) =
            send(&app, &token, "POST", "/me/auth/device/codex/start", None).await?;
        assert_eq!(status, StatusCode::OK, "{second}");
        let second_id = Uuid::parse_str(second["sessionId"].as_str().unwrap_or_default())?;
        let (_, replaced) = send(
            &app,
            &token,
            "GET",
            &format!("/me/auth/device/{first_id}"),
            None,
        )
        .await?;
        assert_eq!(replaced["status"], json!("cancelled"), "{replaced}");
        assert!(!is_open(&pool, person, first_id).await?);
        assert!(is_open(&pool, person, second_id).await?);

        // The hour's last start is used: refused before OpenAI is asked, and
        // the pending login is left alone.
        let (status, refused) =
            send(&app, &token, "POST", "/me/auth/device/codex/start", None).await?;
        assert_limited(
            status,
            &refused,
            "codex_device_auth_rate_limited",
            limit,
            HOUR_SECONDS,
        );
        assert_eq!(usercode.hits_async().await, 2);
        assert!(is_open(&pool, person, second_id).await?);
        let (_, pending) = send(
            &app,
            &token,
            "GET",
            &format!("/me/auth/device/{second_id}"),
            None,
        )
        .await?;
        assert_eq!(pending["status"], json!("pending"), "{pending}");

        // A start whose code request fails still counts, because OpenAI was
        // asked, but is no longer pending.
        seed_finished_codex_starts(&pool, unlucky, limit - 1, 30).await?;
        let unlucky_token = user_token(&config, unlucky);
        let failing_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &failing_issuer.base_url());
        let (status, failed) = send(
            &app,
            &unlucky_token,
            "POST",
            "/me/auth/device/codex/start",
            None,
        )
        .await?;
        drop(failing_env);
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR, "{failed}");
        assert_eq!(failing_usercode.hits_async().await, 1);
        let open: i64 = sql_one(
            &pool,
            "select count(*)::bigint from ai_connection_attempts
             where user_id = $1 and completed_at is null",
            &[&unlucky],
        )
        .await?;
        assert_eq!(open, 0);
        let (status, refused) = send(
            &app,
            &unlucky_token,
            "POST",
            "/me/auth/device/codex/start",
            None,
        )
        .await?;
        assert_limited(
            status,
            &refused,
            "codex_device_auth_rate_limited",
            limit,
            HOUR_SECONDS,
        );
        assert_eq!(usercode.hits_async().await, 2);

        // Someone who could not save the connection a login ends in is
        // refused before OpenAI is asked too.
        let new_connections = AiConnectionLimits::FOR_EVERYONE.new_connections_per_hour;
        seed_connections(&pool, saturated, new_connections, 10).await?;
        let (status, refused) = send(
            &app,
            &user_token(&config, saturated),
            "POST",
            "/me/auth/device/codex/start",
            None,
        )
        .await?;
        assert_limited(
            status,
            &refused,
            "credential_create_rate_limited",
            new_connections,
            HOUR_SECONDS,
        );
        assert_eq!(usercode.hits_async().await, 2);
        assert_eq!(receipts(&pool, saturated, "codex_device_auth").await?, 0);

        let (status, _) = send(
            &app,
            &token,
            "DELETE",
            &format!("/me/auth/device/{second_id}"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::NO_CONTENT);
        Ok(())
    })
    .await
}

/// A start that reaches another controller replaces a login this one polls:
/// its poller finds the receipt closed and stops. However a poller stops, it
/// closes its receipt. Sets CODEX_DEVICE_AUTH_ISSUER.
#[tokio::test]
async fn codex_pollers_stop_when_another_controller_replaces_their_login() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("codex_pollers_stop_when_another_controller_replaces_their_login")
            .await?;
    let issuer = MockServer::start_async().await;
    issuer
        .mock_async(|when, then| {
            when.method(POST).path("/api/accounts/deviceauth/usercode");
            then.status(200).json_body(json!({
                "device_auth_id": "device-auth-fixture",
                "user_code": "ABCD-EFGH",
                "interval": 1,
            }));
        })
        .await;
    issuer
        .mock_async(|when, then| {
            when.method(POST).path("/api/accounts/deviceauth/token");
            then.status(404);
        })
        .await;
    let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.base_url());
    let config = config("ai-connection-limits", None);
    let first =
        crate::device_auth::router().with_state(build_test_state(pool.clone(), config.clone()));
    let second =
        crate::device_auth::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();

    with_users(&pool, &[person], async {
        let token = user_token(&config, person);
        let start = |app: &axum::Router| {
            let app = app.clone();
            let token = token.clone();
            async move {
                let (status, started) =
                    send(&app, &token, "POST", "/me/auth/device/codex/start", None).await?;
                anyhow::ensure!(
                    status == StatusCode::OK,
                    "start answered {status}: {started}"
                );
                Ok::<Uuid, anyhow::Error>(Uuid::parse_str(
                    started["sessionId"].as_str().unwrap_or_default(),
                )?)
            }
        };

        // Replaced by a start on the other controller, which cannot reach
        // this one's poller: that poller finds its receipt closed.
        let replaced = start(&first).await?;
        let newest = start(&second).await?;
        wait_until("the replaced login to fail", || async {
            let (_, status) = send(
                &first,
                &token,
                "GET",
                &format!("/me/auth/device/{replaced}"),
                None,
            )
            .await?;
            Ok(status["status"] == json!("failed"))
        })
        .await?;
        let (_, status) = send(
            &first,
            &token,
            "GET",
            &format!("/me/auth/device/{replaced}"),
            None,
        )
        .await?;
        assert_eq!(
            status["error"],
            json!(CODEX_DEVICE_AUTH_REPLACED_MESSAGE),
            "{status}"
        );
        let (_, status) = send(
            &second,
            &token,
            "GET",
            &format!("/me/auth/device/{newest}"),
            None,
        )
        .await?;
        assert_eq!(status["status"], json!("pending"), "{status}");
        assert!(is_open(&pool, person, newest).await?);

        // Cancelled: the cancel closes the receipt, and the poller stops on
        // its next look.
        let cancelled = start(&first).await?;
        let (status, _) = send(
            &first,
            &token,
            "DELETE",
            &format!("/me/auth/device/{cancelled}"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::NO_CONTENT);
        wait_until("the cancelled login's receipt to close", || async {
            Ok(!is_open(&pool, person, cancelled).await?)
        })
        .await?;
        Ok(())
    })
    .await
}

/// OpenAI answers a poll for a code nobody has entered yet with 403 or 404.
/// Either way the login stays pending and keeps its place among everyone's
/// pending logins, until it is cancelled or its code expires. Sets
/// CODEX_DEVICE_AUTH_ISSUER.
#[tokio::test]
async fn codex_logins_whose_code_is_not_entered_stay_pending() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("codex_logins_whose_code_is_not_entered_stay_pending").await?;
    for not_entered in [403, 404] {
        let issuer = MockServer::start_async().await;
        issuer
            .mock_async(|when, then| {
                when.method(POST).path("/api/accounts/deviceauth/usercode");
                then.status(200).json_body(json!({
                    "device_auth_id": "device-auth-fixture",
                    "user_code": "ABCD-EFGH",
                    "interval": 1,
                }));
            })
            .await;
        let polls = issuer
            .mock_async(|when, then| {
                when.method(POST).path("/api/accounts/deviceauth/token");
                then.status(not_entered);
            })
            .await;
        let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.base_url());
        let config = config("ai-connection-limits", None);
        let app =
            crate::device_auth::router().with_state(build_test_state(pool.clone(), config.clone()));
        let person = Uuid::new_v4();

        with_users(&pool, &[person], async {
            let token = user_token(&config, person);
            let login = start_codex_login(&app, &token).await?;
            wait_until("the login's first poll", || async {
                Ok(polls.hits_async().await > 0)
            })
            .await?;
            // The poller has OpenAI's answer within moments of the poll.
            for _ in 0..10 {
                tokio::time::sleep(Duration::from_millis(100)).await;
                let status = codex_login_status(&app, &token, login).await?;
                assert_eq!(
                    status["status"],
                    json!("pending"),
                    "{not_entered}: {status}"
                );
            }
            let pending: i64 = sql_one(
                &pool,
                "select count(*)::bigint from ai_connection_attempts
                 where user_id = $1 and action = 'codex_device_auth'
                   and completed_at is null and expires_at > clock_timestamp()",
                &[&person],
            )
            .await?;
            assert_eq!(
                pending, 1,
                "{not_entered}: the login still counts as pending"
            );

            let (status, _) = send(
                &app,
                &token,
                "DELETE",
                &format!("/me/auth/device/{login}"),
                None,
            )
            .await?;
            assert_eq!(status, StatusCode::NO_CONTENT, "{not_entered}");
            wait_until("the cancelled login's receipt to close", || async {
                Ok(!is_open(&pool, person, login).await?)
            })
            .await?;
            Ok(())
        })
        .await?;
    }
    Ok(())
}

/// A poller that cannot read its receipt keeps polling: a database blip must
/// not end a login that may still complete. Sets CODEX_DEVICE_AUTH_ISSUER.
#[tokio::test]
async fn codex_pollers_keep_polling_when_their_receipt_cannot_be_read() -> anyhow::Result<()> {
    let setup =
        require_origin_test_pool("codex_pollers_keep_polling_when_their_receipt_cannot_be_read")
            .await?;
    // The controller's pool: one connection, whose checkouts give up after a
    // second.
    let pool = single_connection_pool(Duration::from_secs(1)).await?;
    let issuer = MockServer::start_async().await;
    issuer
        .mock_async(|when, then| {
            when.method(POST).path("/api/accounts/deviceauth/usercode");
            then.status(200).json_body(json!({
                "device_auth_id": "device-auth-fixture",
                "user_code": "ABCD-EFGH",
                "interval": 1,
            }));
        })
        .await;
    let polls = issuer
        .mock_async(|when, then| {
            when.method(POST).path("/api/accounts/deviceauth/token");
            then.status(404);
        })
        .await;
    let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.base_url());
    let config = config("ai-connection-limits", None);
    let app =
        crate::device_auth::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();

    with_users(&setup, &[person], async {
        let token = user_token(&config, person);
        let (status, started) =
            send(&app, &token, "POST", "/me/auth/device/codex/start", None).await?;
        assert_eq!(status, StatusCode::OK, "{started}");
        let session_id = Uuid::parse_str(started["sessionId"].as_str().unwrap_or_default())?;
        // The first poll found the receipt open; the next comes a second later.
        wait_until("the first poll", || async {
            Ok(polls.hits_async().await >= 1)
        })
        .await?;

        // The only connection is busy when the next poll checks the receipt.
        let busy = pool.get().await?;
        let polled = wait_until("a poll after the receipt could not be read", || async {
            Ok(polls.hits_async().await >= 2)
        })
        .await;
        drop(busy);
        polled?;
        let (_, login) = send(
            &app,
            &token,
            "GET",
            &format!("/me/auth/device/{session_id}"),
            None,
        )
        .await?;
        assert_eq!(login["status"], json!("pending"), "{login}");

        let (status, _) = send(
            &app,
            &token,
            "DELETE",
            &format!("/me/auth/device/{session_id}"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::NO_CONTENT);
        Ok(())
    })
    .await
}

/// A completed ChatGPT login is a new connection: it is saved through the
/// same count, and its receipt closes whether it saved or was refused. Sets
/// CODEX_DEVICE_AUTH_ISSUER.
#[tokio::test]
async fn codex_login_completion_counts_as_a_new_connection() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("codex_login_completion_counts_as_a_new_connection").await?;
    let issuer = MockServer::start_async().await;
    issuer
        .mock_async(|when, then| {
            when.method(POST).path("/api/accounts/deviceauth/usercode");
            then.status(200).json_body(json!({
                "device_auth_id": "device-auth-fixture",
                "user_code": "ABCD-EFGH",
                "interval": 1,
            }));
        })
        .await;
    // Each login is approved on its first poll, two seconds after it starts.
    issuer
        .mock_async(|when, then| {
            when.method(POST).path("/api/accounts/deviceauth/token");
            then.status(200)
                .delay(Duration::from_secs(2))
                .json_body(json!({
                    "authorization_code": "authorization-code-fixture",
                    "code_verifier": "code-verifier-fixture",
                }));
        })
        .await;
    let exchanges = issuer
        .mock_async(|when, then| {
            when.method(POST).path("/oauth/token");
            then.status(200).json_body(json!({
                "id_token": "header.payload.signature",
                "access_token": "access-token-fixture",
                "refresh_token": "refresh-token-fixture",
            }));
        })
        .await;
    let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.base_url());
    let config = config("ai-connection-limits", None);
    let app =
        crate::device_auth::router().with_state(build_test_state(pool.clone(), config.clone()));
    let saturating = Uuid::new_v4();
    let completing = Uuid::new_v4();
    let limit = AiConnectionLimits::FOR_EVERYONE.new_connections_per_hour;

    with_users(&pool, &[saturating, completing], async {
        seed_connections(&pool, saturating, limit - 1, 10).await?;
        let saturating_token = user_token(&config, saturating);
        let completing_token = user_token(&config, completing);
        let (status, started) = send(
            &app,
            &saturating_token,
            "POST",
            "/me/auth/device/codex/start",
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{started}");
        let refused_login = Uuid::parse_str(started["sessionId"].as_str().unwrap_or_default())?;
        // The last slot goes to a connection saved elsewhere while the login
        // waits for approval.
        seed_connections(&pool, saturating, 1, 0).await?;
        let (status, started) = send(
            &app,
            &completing_token,
            "POST",
            "/me/auth/device/codex/start",
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{started}");
        let saved_login = Uuid::parse_str(started["sessionId"].as_str().unwrap_or_default())?;

        let status_of = |token: String, session_id: Uuid| {
            let app = app.clone();
            async move {
                let (_, status) = send(
                    &app,
                    &token,
                    "GET",
                    &format!("/me/auth/device/{session_id}"),
                    None,
                )
                .await?;
                Ok::<Value, anyhow::Error>(status)
            }
        };
        wait_until("both logins to end", || async {
            let refused = status_of(saturating_token.clone(), refused_login).await?;
            let saved = status_of(completing_token.clone(), saved_login).await?;
            Ok(refused["status"] != json!("pending") && saved["status"] != json!("pending"))
        })
        .await?;
        let refused = status_of(saturating_token.clone(), refused_login).await?;
        assert_eq!(refused["status"], json!("failed"), "{refused}");
        assert!(
            refused["error"]
                .as_str()
                .unwrap_or_default()
                .starts_with("Too many new AI connections. Try again in "),
            "{refused}"
        );
        let saved = status_of(completing_token.clone(), saved_login).await?;
        assert_eq!(saved["status"], json!("completed"), "{saved}");
        assert!(saved["credentialId"].is_string(), "{saved}");
        assert_eq!(exchanges.hits_async().await, 2);

        wait_until("both receipts to close", || async {
            Ok(!is_open(&pool, saturating, refused_login).await?
                && !is_open(&pool, completing, saved_login).await?)
        })
        .await?;
        for (user_id, expected) in [(saturating, limit), (completing, 1)] {
            let stored: i64 = sql_one(
                &pool,
                "select count(*)::bigint from user_credentials where user_id = $1",
                &[&user_id],
            )
            .await?;
            assert_eq!(stored, expected);
        }
        Ok(())
    })
    .await
}

/// A ChatGPT login replaced after OpenAI approved it, while its poller waits
/// for its tokens past its look at the receipt, saves nothing. On the
/// controller that took the newer start it is cancelled, which its poller
/// sees before it saves; on any other its save finds the receipt closed, and
/// it fails as replaced. The newer login saves the one connection. Sets
/// CODEX_DEVICE_AUTH_ISSUER.
#[tokio::test]
async fn codex_logins_replaced_after_approval_save_nothing() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("codex_logins_replaced_after_approval_save_nothing").await?;
    let mut issuer = ApprovingIssuer::start().await?;
    let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.url);
    let config = config("ai-connection-limits", None);
    let first_state = build_test_state(pool.clone(), config.clone());
    let first = crate::device_auth::router().with_state(first_state.clone());
    let first_idle = first_state.device_auth_sessions.copies();
    let second =
        crate::device_auth::router().with_state(build_test_state(pool.clone(), config.clone()));
    let here = Uuid::new_v4();
    let elsewhere = Uuid::new_v4();

    with_users(&pool, &[here, elsewhere], async {
        // Replaced by a newer start on the same controller. Once both pollers
        // ended, the one connection is the newer login's.
        let token = user_token(&config, here);
        let replaced = start_codex_login(&first, &token).await?;
        let replaced_exchange = issuer.next_exchange().await?;
        let newest = start_codex_login(&first, &token).await?;
        let newest_exchange = issuer.next_exchange().await?;
        release(replaced_exchange)?;
        release(newest_exchange)?;
        let saved = wait_for_codex_login_to_end(&first, &token, newest).await?;
        assert_eq!(saved["status"], json!("completed"), "{saved}");
        let saved_id = Uuid::parse_str(saved["credentialId"].as_str().unwrap_or_default())?;
        wait_for_pollers_to_end(&first_state, first_idle).await?;
        assert_eq!(
            connections_and_agents(&pool, here).await?,
            (vec![saved_id], vec![Some(saved_id)])
        );
        let login = codex_login_status(&first, &token, replaced).await?;
        assert_eq!(login["status"], json!("cancelled"), "{login}");
        assert!(!is_open(&pool, here, replaced).await?);

        // Replaced by a newer start on another controller, which cannot reach
        // this one's session.
        let token = user_token(&config, elsewhere);
        let replaced = start_codex_login(&first, &token).await?;
        let replaced_exchange = issuer.next_exchange().await?;
        let newest = start_codex_login(&second, &token).await?;
        let newest_exchange = issuer.next_exchange().await?;
        release(replaced_exchange)?;
        let login = wait_for_codex_login_to_end(&first, &token, replaced).await?;
        assert_eq!(login["status"], json!("failed"), "{login}");
        assert_eq!(
            login["error"],
            json!(CODEX_DEVICE_AUTH_REPLACED_MESSAGE),
            "{login}"
        );
        assert_eq!(
            connections_and_agents(&pool, elsewhere).await?,
            (vec![], vec![])
        );

        release(newest_exchange)?;
        let saved = wait_for_codex_login_to_end(&second, &token, newest).await?;
        assert_eq!(saved["status"], json!("completed"), "{saved}");
        let saved_id = Uuid::parse_str(saved["credentialId"].as_str().unwrap_or_default())?;
        assert_eq!(
            connections_and_agents(&pool, elsewhere).await?,
            (vec![saved_id], vec![Some(saved_id)])
        );
        Ok(())
    })
    .await
}

/// A newer start replaces a login whose own start still waits for OpenAI's
/// code. On the controller of both starts, the newer one finds no session to
/// cancel yet: the older start still answers with a code, and its login fails
/// as replaced when its poller first looks. Sets CODEX_DEVICE_AUTH_ISSUER.
#[tokio::test]
async fn codex_logins_replaced_before_their_code_fail_as_replaced() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("codex_logins_replaced_before_their_code_fail_as_replaced")
        .await?;
    let mut issuer = CodeHoldingIssuer::start().await?;
    let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.url);
    let config = config("ai-connection-limits", None);
    let app =
        crate::device_auth::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();

    with_users(&pool, &[person], async {
        let token = user_token(&config, person);
        let start = || {
            let app = app.clone();
            let token = token.clone();
            spawn_aborting(async move { start_codex_login(&app, &token).await })
        };
        let older = start();
        let older_code = issuer.next_user_code().await?;
        let newer = start();
        let newer_code = issuer.next_user_code().await?;
        release(older_code)?;
        let older = older.await??;
        release(newer_code)?;
        let newer = newer.await??;

        let login = wait_for_codex_login_to_end(&app, &token, older).await?;
        assert_eq!(login["status"], json!("failed"), "{login}");
        assert_eq!(
            login["error"],
            json!(CODEX_DEVICE_AUTH_REPLACED_MESSAGE),
            "{login}"
        );
        let login = codex_login_status(&app, &token, newer).await?;
        assert_eq!(login["status"], json!("pending"), "{login}");
        assert!(is_open(&pool, person, newer).await?);

        let (status, _) = send(
            &app,
            &token,
            "DELETE",
            &format!("/me/auth/device/{newer}"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::NO_CONTENT);
        Ok(())
    })
    .await
}

/// A ChatGPT login's save closes its receipt only once it holds the person
/// lock. A newer start that holds that lock meanwhile, on any controller,
/// closes the receipt without waiting on the save, which then saves nothing
/// and fails as replaced. Sets CODEX_DEVICE_AUTH_ISSUER.
#[tokio::test]
async fn codex_saves_close_their_receipt_under_the_person_lock() -> anyhow::Result<()> {
    let pool = require_origin_test_pool_with_max_size(
        "codex_saves_close_their_receipt_under_the_person_lock",
        8,
    )
    .await?;
    let mut issuer = ApprovingIssuer::start().await?;
    let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.url);
    let config = config("ai-connection-limits", None);
    let state = build_test_state(pool.clone(), config.clone());
    let app = crate::device_auth::router().with_state(state.clone());
    let idle = state.device_auth_sessions.copies();
    let person = Uuid::new_v4();

    with_users(&pool, &[person], async {
        let token = user_token(&config, person);
        let login_id = start_codex_login(&app, &token).await?;
        let exchange = issuer.next_exchange().await?;

        // A newer start holds the locks a start takes when the save asks for
        // the person lock.
        let mut holder = pool.get().await?;
        let holding = holder.transaction().await?;
        holding
            .batch_execute("set local lock_timeout = '2s'")
            .await?;
        take_codex_start_locks(&holding, person)
            .await
            .map_err(api_error)?;
        let holder_pid: i32 = holding
            .query_one("select pg_backend_pid()", &[])
            .await?
            .get(0);
        release(exchange)?;
        wait_until("the save to wait for the person lock", || async {
            Ok(waiting_on(&pool, holder_pid).await? > 0)
        })
        .await?;

        // It closes the older receipt, as every start does.
        let replaced: Vec<Uuid> = holding
            .query(
                "update public.ai_connection_attempts
                    set completed_at = clock_timestamp()
                  where user_id = $1
                    and action = 'codex_device_auth'
                    and completed_at is null
                returning id",
                &[&person],
            )
            .await?
            .iter()
            .map(|row| row.get("id"))
            .collect();
        holding.commit().await?;
        drop(holder);
        assert_eq!(replaced, vec![login_id]);

        let login = wait_for_codex_login_to_end(&app, &token, login_id).await?;
        assert_eq!(login["status"], json!("failed"), "{login}");
        assert_eq!(
            login["error"],
            json!(CODEX_DEVICE_AUTH_REPLACED_MESSAGE),
            "{login}"
        );
        wait_for_pollers_to_end(&state, idle).await?;
        assert_eq!(
            connections_and_agents(&pool, person).await?,
            (vec![], vec![])
        );
        Ok(())
    })
    .await
}

/// A ChatGPT login cancelled after OpenAI approved it, while its poller waits
/// for its tokens past its look at the session, saves nothing and stays
/// cancelled: the poller looks at the session again before it saves. The
/// cancel also closes the receipt at once, which frees the login's place and
/// would refuse its save. Sets CODEX_DEVICE_AUTH_ISSUER.
#[tokio::test]
async fn codex_logins_cancelled_after_approval_save_nothing() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("codex_logins_cancelled_after_approval_save_nothing").await?;
    let mut issuer = ApprovingIssuer::start().await?;
    let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.url);
    let config = config("ai-connection-limits", None);
    let state = build_test_state(pool.clone(), config.clone());
    let app = crate::device_auth::router().with_state(state.clone());
    let idle = state.device_auth_sessions.copies();
    let person = Uuid::new_v4();

    with_users(&pool, &[person], async {
        let token = user_token(&config, person);
        let cancelled = start_codex_login(&app, &token).await?;
        let exchange = issuer.next_exchange().await?;
        let (status, _) = send(
            &app,
            &token,
            "DELETE",
            &format!("/me/auth/device/{cancelled}"),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::NO_CONTENT);
        // Closed by the cancel: the poller still waits for its tokens.
        assert!(!is_open(&pool, person, cancelled).await?);

        release(exchange)?;
        wait_for_pollers_to_end(&state, idle).await?;
        assert_eq!(
            connections_and_agents(&pool, person).await?,
            (vec![], vec![])
        );
        let login = codex_login_status(&app, &token, cancelled).await?;
        assert_eq!(login["status"], json!("cancelled"), "{login}");
        Ok(())
    })
    .await
}

/// A ChatGPT login cancelled while its poller waits for its tokens saves
/// nothing even when the cancel cannot reach the database to close its
/// receipt: the poller looks at the session again before it saves. Sets
/// CODEX_DEVICE_AUTH_ISSUER.
#[tokio::test]
async fn codex_logins_cancelled_without_the_database_save_nothing() -> anyhow::Result<()> {
    let setup =
        require_origin_test_pool("codex_logins_cancelled_without_the_database_save_nothing")
            .await?;
    // The controller's pool: one connection, whose checkouts give up after a
    // second.
    let pool = single_connection_pool(Duration::from_secs(1)).await?;
    let mut issuer = ApprovingIssuer::start().await?;
    let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.url);
    let config = config("ai-connection-limits", None);
    let app =
        crate::device_auth::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();

    with_users(&setup, &[person], async {
        let token = user_token(&config, person);
        let cancelled = start_codex_login(&app, &token).await?;
        let exchange = issuer.next_exchange().await?;
        // The only connection is busy while the cancel tries to close the
        // receipt.
        let busy = pool.get().await?;
        let (status, _) = send(
            &app,
            &token,
            "DELETE",
            &format!("/me/auth/device/{cancelled}"),
            None,
        )
        .await?;
        drop(busy);
        assert_eq!(status, StatusCode::NO_CONTENT);
        assert!(is_open(&setup, person, cancelled).await?);

        // The poller closes the receipt when it ends, and a save would close
        // it in the transaction that saves the connection.
        release(exchange)?;
        wait_until("the cancelled login's receipt to close", || async {
            Ok(!is_open(&setup, person, cancelled).await?)
        })
        .await?;
        assert_eq!(
            connections_and_agents(&setup, person).await?,
            (vec![], vec![])
        );
        let login = codex_login_status(&app, &token, cancelled).await?;
        assert_eq!(login["status"], json!("cancelled"), "{login}");
        Ok(())
    })
    .await
}

/// A ChatGPT login whose code expired while its poller waited for its tokens
/// saves nothing and reads timed out, although OpenAI approved it: the poller
/// looks at the expiry before it saves. Sets CODEX_DEVICE_AUTH_ISSUER.
#[tokio::test]
async fn codex_logins_whose_code_expired_save_nothing() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("codex_logins_whose_code_expired_save_nothing").await?;
    let mut issuer = ApprovingIssuer::start().await?;
    let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.url);
    let config = config("ai-connection-limits", None);
    let state = build_test_state(pool.clone(), config.clone());
    let app = crate::device_auth::router().with_state(state.clone());
    let idle = state.device_auth_sessions.copies();
    let person = Uuid::new_v4();

    with_users(&pool, &[person], async {
        let token = user_token(&config, person);
        let login_id = start_codex_login(&app, &token).await?;
        let exchange = issuer.next_exchange().await?;
        state
            .device_auth_sessions
            .set_expires_at(&login_id, chrono::Utc::now() - chrono::Duration::seconds(1))
            .await;

        release(exchange)?;
        wait_for_pollers_to_end(&state, idle).await?;
        assert_eq!(
            connections_and_agents(&pool, person).await?,
            (vec![], vec![])
        );
        let login = codex_login_status(&app, &token, login_id).await?;
        assert_eq!(login["status"], json!("failed"), "{login}");
        assert_eq!(login["error"], json!("Device login timed out."), "{login}");
        assert!(!is_open(&pool, person, login_id).await?);
        Ok(())
    })
    .await
}

/// A cancel that comes while a ChatGPT login saves its connection waits for
/// the save to end, so the login reads completed instead of cancelled over a
/// connection it saved. It waits five seconds at most: a save that outlasts
/// that goes on, and the cancel answers that the login is still saving. Sets
/// CODEX_DEVICE_AUTH_ISSUER.
#[tokio::test]
async fn codex_cancels_wait_for_a_save_in_progress() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("codex_cancels_wait_for_a_save_in_progress").await?;
    let mut issuer = ApprovingIssuer::start().await?;
    let _issuer_env = EnvVarGuard::set(CODEX_ISSUER_ENV, &issuer.url);
    let config = config("ai-connection-limits", None);
    let app =
        crate::device_auth::router().with_state(build_test_state(pool.clone(), config.clone()));
    let person = Uuid::new_v4();

    with_users(&pool, &[person], async {
        let token = user_token(&config, person);
        let login_id = start_codex_login(&app, &token).await?;
        let exchange = issuer.next_exchange().await?;

        // Holds the save past its close of the receipt, when it writes the
        // connection.
        let mut holder = pool.get().await?;
        let holding = holder.transaction().await?;
        holding
            .batch_execute("lock table public.user_credentials in share mode")
            .await?;
        let holder_pid: i32 = holding
            .query_one("select pg_backend_pid()", &[])
            .await?
            .get(0);
        release(exchange)?;
        wait_until("the save to wait to write the connection", || async {
            Ok(waiting_on(&pool, holder_pid).await? > 0)
        })
        .await?;

        let (status, refused) = tokio::time::timeout(
            Duration::from_secs(15),
            send(
                &app,
                &token,
                "DELETE",
                &format!("/me/auth/device/{login_id}"),
                None,
            ),
        )
        .await
        .map_err(|_| anyhow::anyhow!("the cancel waited for the save without a bound"))??;
        assert_eq!(status, StatusCode::CONFLICT, "{refused}");
        assert_eq!(
            refused["code"],
            json!("codex_device_auth_saving"),
            "{refused}"
        );
        let login = codex_login_status(&app, &token, login_id).await?;
        assert_eq!(login["status"], json!("pending"), "{login}");

        let mut cancel = tokio::spawn({
            let app = app.clone();
            let token = token.clone();
            async move {
                send(
                    &app,
                    &token,
                    "DELETE",
                    &format!("/me/auth/device/{login_id}"),
                    None,
                )
                .await
            }
        });
        assert!(
            tokio::time::timeout(Duration::from_secs(1), &mut cancel)
                .await
                .is_err(),
            "the cancel answered while the login was saving"
        );
        holding.commit().await?;
        drop(holder);
        let (status, _) = cancel.await??;
        assert_eq!(status, StatusCode::NO_CONTENT);

        let login = codex_login_status(&app, &token, login_id).await?;
        assert_eq!(login["status"], json!("completed"), "{login}");
        let saved_id = Uuid::parse_str(login["credentialId"].as_str().unwrap_or_default())?;
        assert_eq!(
            connections_and_agents(&pool, person).await?,
            (vec![saved_id], vec![Some(saved_id)])
        );
        assert!(!is_open(&pool, person, login_id).await?);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn retention_prune_keeps_the_last_day() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("retention_prune_keeps_the_last_day").await?;
    let person = Uuid::new_v4();
    with_users(&pool, &[person], async {
        sql(
            &pool,
            "insert into ai_connection_attempts (user_id, action, credential_id, created_at)
             values ($1, 'credential_test', gen_random_uuid(), now() - interval '25 hours'),
                    ($1, 'credential_test', gen_random_uuid(), now() - interval '23 hours')",
            &[&person],
        )
        .await?;
        sql(
            &pool,
            "insert into ai_connection_attempts (user_id, action, created_at, expires_at, completed_at)
             values ($1, 'codex_device_auth', now() - interval '25 hours',
                     now() - interval '24 hours 45 minutes', now() - interval '24 hours 50 minutes'),
                    ($1, 'codex_device_auth', now() - interval '23 hours',
                     now() - interval '22 hours 45 minutes', null)",
            &[&person],
        )
        .await?;

        let deleted = prune_ai_connection_attempts(&pool).await?;
        assert!(deleted >= 2, "deleted {deleted}");
        let left: i64 = sql_one(
            &pool,
            "select count(*)::bigint from ai_connection_attempts
             where user_id = $1 and created_at > now() - interval '24 hours'",
            &[&person],
        )
        .await?;
        assert_eq!(left, 2);
        assert_eq!(receipts(&pool, person, "credential_test").await?, 1);
        assert_eq!(receipts(&pool, person, "codex_device_auth").await?, 1);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn ai_connection_attempts_are_controller_only() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("ai_connection_attempts_are_controller_only").await?;
    let row = pool
        .get()
        .await?
        .query_one(
            "select c.relrowsecurity as row_security,
                    has_table_privilege('anon', c.oid, 'select, insert, update, delete')
                      as anon_access,
                    has_table_privilege('authenticated', c.oid, 'select, insert, update, delete')
                      as authenticated_access,
                    (select count(*) from pg_policies
                      where schemaname = 'public' and tablename = 'ai_connection_attempts')
                      as policies
               from pg_class c
              where c.oid = 'public.ai_connection_attempts'::regclass",
            &[],
        )
        .await?;
    assert!(row.get::<_, bool>("row_security"));
    assert!(!row.get::<_, bool>("anon_access"));
    assert!(!row.get::<_, bool>("authenticated_access"));
    assert_eq!(row.get::<_, i64>("policies"), 0);
    Ok(())
}
