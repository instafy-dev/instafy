//! A turn's controller calls take one round trip to the database per statement.
//!
//! The controller runs a cross-region hop away from its database. A send runs a
//! few dozen statements while its job is still invisible to every runtime, and
//! the runtime calls in again and again before its model runs: a heartbeat
//! before each step, its secrets, the space's lease. An untyped statement is
//! prepared on its own first and waits for the server's answer before it runs,
//! which doubles its share of every one of those waits (`crate::typed_sql`).
//! These tests count, on the wire, the statements a repeat call still prepares
//! on its own.

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::header::{AUTHORIZATION, CONTENT_TYPE};
use axum::http::{Request, StatusCode};
use bb8_postgres::PostgresConnectionManager;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_postgres::config::{Host, SslMode};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::{PgPool, RuntimeProviderConfig};
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key,
};
use crate::AppState;

/// What a client sent through the counting hop since it was last reset.
#[derive(Default)]
pub(crate) struct Tally {
    /// Statements prepared on their own: Parse messages that name their
    /// statement. A typed statement parses the unnamed statement in the same
    /// message that runs it.
    named_parses: AtomicUsize,
    /// Simple queries that change the schema (`create`, `alter`, `revoke`, ...).
    schema_queries: AtomicUsize,
}

impl Tally {
    pub(crate) fn reset(&self) {
        self.named_parses.store(0, Ordering::SeqCst);
        self.schema_queries.store(0, Ordering::SeqCst);
    }

    pub(crate) fn named_parses(&self) -> usize {
        self.named_parses.load(Ordering::SeqCst)
    }

    pub(crate) fn schema_queries(&self) -> usize {
        self.schema_queries.load(Ordering::SeqCst)
    }
}

/// Reads the client's side of a Postgres connection, message by message.
#[derive(Default)]
struct ClientMessages {
    pending: Vec<u8>,
    started: bool,
}

impl ClientMessages {
    const SSL_REQUEST: u32 = 80_877_103;
    const GSSENC_REQUEST: u32 = 80_877_104;
    const SCHEMA_VERBS: [&'static str; 6] =
        ["create", "alter", "drop", "revoke", "grant", "comment"];

    fn read(&mut self, bytes: &[u8], tally: &Tally) {
        self.pending.extend_from_slice(bytes);
        loop {
            // The startup message, and any request for encryption before it,
            // carries no type byte.
            let length_at = usize::from(self.started);
            if self.pending.len() < length_at + 4 {
                return;
            }
            let length = u32::from_be_bytes(
                self.pending[length_at..length_at + 4]
                    .try_into()
                    .expect("four length bytes"),
            ) as usize;
            let total = length_at + length;
            if length < 4 || self.pending.len() < total {
                return;
            }
            if self.started {
                let body = &self.pending[5..total];
                match self.pending[0] {
                    b'P' if body.first().is_some_and(|byte| *byte != 0) => {
                        tally.named_parses.fetch_add(1, Ordering::SeqCst);
                    }
                    b'Q' if Self::changes_schema(body) => {
                        tally.schema_queries.fetch_add(1, Ordering::SeqCst);
                    }
                    _ => {}
                }
            } else {
                let code =
                    u32::from_be_bytes(self.pending[4..8].try_into().expect("four code bytes"));
                self.started = code != Self::SSL_REQUEST && code != Self::GSSENC_REQUEST;
            }
            self.pending.drain(..total);
        }
    }

    fn changes_schema(query: &[u8]) -> bool {
        let text = String::from_utf8_lossy(query);
        let first = text
            .trim_start()
            .split(|c: char| c.is_whitespace() || c == ';')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        Self::SCHEMA_VERBS.contains(&first.as_str())
    }
}

/// A local hop in front of the test database that tallies, across every
/// connection through it, what its clients send.
pub(crate) async fn counting_hop(
    upstream: SocketAddr,
    tally: Arc<Tally>,
) -> anyhow::Result<SocketAddr> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let tally = tally.clone();
            tokio::spawn(async move {
                let Ok(server) = TcpStream::connect(upstream).await else {
                    return;
                };
                let (mut from_client, mut to_client) = client.into_split();
                let (mut from_server, mut to_server) = server.into_split();
                let answers = tokio::io::copy(&mut from_server, &mut to_client);
                let requests = async move {
                    let mut messages = ClientMessages::default();
                    let mut buffer = vec![0_u8; 16 * 1024];
                    loop {
                        let read = from_client.read(&mut buffer).await?;
                        if read == 0 {
                            return to_server.shutdown().await;
                        }
                        messages.read(&buffer[..read], &tally);
                        to_server.write_all(&buffer[..read]).await?;
                    }
                };
                let _ = tokio::join!(answers, requests);
            });
        }
    });
    Ok(address)
}

fn test_database_config() -> anyhow::Result<tokio_postgres::Config> {
    let url = std::env::var("TEST_DATABASE_URL")
        .map_err(|_| anyhow::anyhow!("send round-trip tests require TEST_DATABASE_URL"))?;
    Ok(url.parse()?)
}

pub(crate) async fn test_database_address() -> anyhow::Result<SocketAddr> {
    let config = test_database_config()?;
    let Some(Host::Tcp(host)) = config.get_hosts().first() else {
        anyhow::bail!("TEST_DATABASE_URL names no TCP host");
    };
    let port = config.get_ports().first().copied().unwrap_or(5432);
    let mut addresses = tokio::net::lookup_host((host.as_str(), port)).await?;
    addresses
        .next()
        .ok_or_else(|| anyhow::anyhow!("the test database's host does not resolve"))
}

/// A one-connection pool to the test database through `hop`, in plain text so
/// the hop can read what the controller sends.
pub(crate) async fn pool_through(hop: SocketAddr) -> anyhow::Result<PgPool> {
    let database = test_database_config()?;
    let mut config = tokio_postgres::Config::new();
    if let Some(user) = database.get_user() {
        config.user(user);
    }
    if let Some(password) = database.get_password() {
        config.password(password);
    }
    if let Some(dbname) = database.get_dbname() {
        config.dbname(dbname);
    }
    config
        .host(&hop.ip().to_string())
        .port(hop.port())
        .ssl_mode(SslMode::Disable);
    let manager = PostgresConnectionManager::new(config, crate::config::database_tls());
    Ok(bb8::Pool::builder().max_size(1).build(manager).await?)
}

fn controller_error(
    context: &str,
    error: (StatusCode, axum::Json<crate::ApiError>),
) -> anyhow::Error {
    let (status, axum::Json(body)) = error;
    anyhow::anyhow!(
        "{context} failed with status {} and message {}",
        status.as_u16(),
        body.message
    )
}

async fn send_hello(
    state: &AppState,
    token: &str,
    conversation_id: Uuid,
    runtime_id: Uuid,
) -> anyhow::Result<()> {
    let response = crate::conversations::router()
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/conversations/{conversation_id}/messages"))
                .header(CONTENT_TYPE, "application/json")
                .header(AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(
                    json!({
                        "promptText": "hello",
                        "intent": "question",
                        "metadata": {
                            "agentSelection": {"active": ["octo"], "mentions": ["octo"]}
                        },
                        "runtimeId": runtime_id,
                        "preferRuntime": true
                    })
                    .to_string(),
                ))?,
        )
        .await?;
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await?;
    anyhow::ensure!(
        status == StatusCode::OK,
        "the send failed with status {status}: {}",
        String::from_utf8_lossy(&body)
    );
    let payload: serde_json::Value = serde_json::from_slice(&body)?;
    anyhow::ensure!(
        payload["jobId"].is_string(),
        "the send queued no job: {payload}"
    );
    Ok(())
}

#[test]
fn only_named_parses_and_schema_queries_are_counted() {
    let tally = Tally::default();
    let mut messages = ClientMessages::default();
    // An SSL request, then a startup message: neither has a type byte.
    let mut wire = Vec::new();
    wire.extend_from_slice(&8_u32.to_be_bytes());
    wire.extend_from_slice(&ClientMessages::SSL_REQUEST.to_be_bytes());
    let startup = b"\0\x03\0\0user\0postgres\0\0";
    wire.extend_from_slice(&((startup.len() + 4) as u32).to_be_bytes());
    wire.extend_from_slice(startup);
    let message = |kind: u8, body: &[u8]| {
        let mut message = vec![kind];
        message.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
        message.extend_from_slice(body);
        message
    };
    let parse = |name: &str| {
        let mut body = name.as_bytes().to_vec();
        body.push(0);
        body.extend_from_slice(b"select 1\0\0\0");
        message(b'P', &body)
    };
    wire.extend(parse("s1"));
    wire.extend(parse(""));
    wire.extend(message(b'S', b""));
    wire.extend(message(
        b'Q',
        b"\n  create table if not exists t (id uuid);\0",
    ));
    wire.extend(message(b'Q', b"START TRANSACTION\0"));
    wire.extend(message(b'Q', b"\0"));
    wire.extend(parse("s2"));

    // Split anywhere, the stream still reads as the same messages.
    let (head, tail) = wire.split_at(23);
    messages.read(head, &tally);
    messages.read(tail, &tally);
    assert_eq!(tally.named_parses(), 2);
    assert_eq!(tally.schema_queries(), 1);
}

#[tokio::test]
async fn a_repeat_send_prepares_no_statement_on_its_own() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("a_repeat_send_prepares_no_statement_on_its_own").await?;

    let user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let first_conversation_id = Uuid::new_v4();
    let second_conversation_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    ensure_test_user(&pool, &user_id).await?;
    let mut capabilities = json!({"agent": true, "origin": true});
    crate::runtime::set_self_hosted_access_attestation(
        capabilities
            .as_object_mut()
            .expect("runtime capabilities are an object"),
        user_id,
    );
    {
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO organizations (id, slug, name)
                 VALUES ($1, $2, 'Send round trips')",
                &[&org_id, &format!("send-round-trips-{org_id}")],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO org_memberships (org_id, user_id, role)
                 VALUES ($1, $2, 'owner')",
                &[&org_id, &user_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO projects (id, org_id, owner_user_id, project_type, status)
                 VALUES ($1, $2, $3, 'customer', 'active')",
                &[&project_id, &org_id, &user_id],
            )
            .await?;
        for conversation_id in [first_conversation_id, second_conversation_id] {
            connection
                .execute(
                    "INSERT INTO conversations (id, project_id, created_by, metadata)
                     VALUES ($1, $2, $3, '{}'::jsonb)",
                    &[&conversation_id, &project_id, &user_id],
                )
                .await?;
        }
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities, updated_at
                 ) VALUES (
                     $1, $2, 'self-hosted', 'ready', 'http://desktop.invalid',
                     $3, 600, now(), $4, now()
                 )",
                &[
                    &runtime_id,
                    &project_id,
                    &format!("send-round-trips-{runtime_id}"),
                    &PgJson(capabilities),
                ],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO user_credentials (
                     id, user_id, kind, label, nonce_b64, ciphertext_b64,
                     metadata, is_default
                 ) VALUES (
                     $1, $2, 'openai_api_key', 'Send round trips',
                     'test-nonce', 'test-ciphertext', '{}'::jsonb, true
                 )",
                &[&Uuid::new_v4(), &user_id],
            )
            .await?;
    }

    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "send-round-trips",
    );
    config.runtime_providers = vec![RuntimeProviderConfig {
        id: "instafy-cloud".to_string(),
        display_name: "Instafy Cloud".to_string(),
        kind: "noop".to_string(),
        owner_org_id: None,
        allowed_org_ids: vec![],
        endpoint: None,
        auth_token: None,
        metadata: None,
    }];
    let token = crate::auth::issue_controller_token(&config, &user_id)
        .map_err(|error| controller_error("issue the sender's controller token", error))?
        .token;

    let tally = Arc::new(Tally::default());
    let hop = counting_hop(test_database_address().await?, tally.clone()).await?;
    let state = build_test_state(pool_through(hop).await?, config);

    // The first send also sets up what an org and its person get once: a
    // subscription, a default Octo.
    send_hello(&state, &token, first_conversation_id, runtime_id).await?;
    tally.reset();
    send_hello(&state, &token, second_conversation_id, runtime_id).await?;

    let prepared_alone = tally.named_parses();
    assert_eq!(
        prepared_alone, 0,
        "a repeat send prepared {prepared_alone} statement(s) on their own; each waits an extra \
         round trip to the database. Run them with the typed calls (crate::typed_sql)."
    );
    Ok(())
}

/// A runtime with one job leased to it, as a turn's runtime calls find it.
struct LeasedJob {
    project_id: Uuid,
    runtime_id: Uuid,
    job_id: Uuid,
    generation: Uuid,
}

impl LeasedJob {
    async fn seed(pool: &PgPool, label: &str) -> anyhow::Result<Self> {
        let job = Self {
            project_id: Uuid::new_v4(),
            runtime_id: Uuid::new_v4(),
            job_id: Uuid::new_v4(),
            generation: Uuid::new_v4(),
        };
        let mut capabilities = json!({"agent": true});
        crate::runtime::set_runtime_generation_capability(&mut capabilities, job.generation);
        crate::runtime::set_self_hosted_access_attestation(
            capabilities
                .as_object_mut()
                .expect("runtime capabilities are an object"),
            Uuid::new_v4(),
        );
        let connection = pool.get().await?;
        connection
            .execute(
                "INSERT INTO projects (id, project_type, status)
                 VALUES ($1, 'customer', 'active')",
                &[&job.project_id],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO runtimes (
                     id, project_id, provider, status, endpoint_url, task_ref,
                     idle_ttl_seconds, last_seen_at, capabilities
                 ) VALUES (
                     $1, $2, 'self-hosted', 'ready', 'http://desktop.invalid',
                     $3, 600, now(), $4
                 )",
                &[
                    &job.runtime_id,
                    &job.project_id,
                    &format!("{label}-{}", job.runtime_id),
                    &capabilities,
                ],
            )
            .await?;
        connection
            .execute(
                "INSERT INTO agent_jobs (
                     id, project_id, status, payload, priority,
                     leased_by_runtime_id, leased_at, lease_expires_at
                 ) VALUES (
                     $1, $2, 'leased', $3, 10, $4, now(), now() + interval '2 minutes'
                 )",
                &[
                    &job.job_id,
                    &job.project_id,
                    &PgJson(json!({"prompt_text": "hello"})),
                    &job.runtime_id,
                ],
            )
            .await?;
        Ok(job)
    }

    /// The runtime's own token, as runtime-agent holds it, for one scope.
    fn agent_token(&self, config: &crate::config::AppConfig, scope: &str) -> String {
        crate::tokens::mint_scoped_token_with_runtime_generation(
            config,
            crate::tokens::ScopedTokenRequest {
                audience: self.runtime_id.to_string(),
                subject: "runtime.test".to_string(),
                project_id: self.project_id.to_string(),
                origin_id: None,
                runtime_id: Some(self.runtime_id.to_string()),
                protocol: None,
                scopes: vec![scope.to_string()],
                lease_id: None,
                run_id: None,
                prefer_runtime: None,
                ttl_seconds: Some(120),
            },
            Some(self.generation),
        )
        .expect("mint the runtime's token")
        .token
    }
}

async fn agent_call(
    state: &AppState,
    router: axum::Router<AppState>,
    token: &str,
    path: &str,
    body: serde_json::Value,
) -> anyhow::Result<()> {
    let response = router
        .with_state(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(path)
                .header(CONTENT_TYPE, "application/json")
                .header(AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(body.to_string()))?,
        )
        .await?;
    let status = response.status();
    let body = to_bytes(response.into_body(), usize::MAX).await?;
    anyhow::ensure!(
        status == StatusCode::OK,
        "{path} failed with status {status}: {}",
        String::from_utf8_lossy(&body)
    );
    Ok(())
}

/// Calls `path` twice through a counting hop and returns what the second call
/// sent.
async fn repeat_call(
    config: crate::config::AppConfig,
    router: fn() -> axum::Router<AppState>,
    token: &str,
    path: &str,
    body: serde_json::Value,
) -> anyhow::Result<Arc<Tally>> {
    let tally = Arc::new(Tally::default());
    let hop = counting_hop(test_database_address().await?, tally.clone()).await?;
    let state = build_test_state(pool_through(hop).await?, config);
    agent_call(&state, router(), token, path, body.clone()).await?;
    tally.reset();
    agent_call(&state, router(), token, path, body).await?;
    Ok(tally)
}

#[tokio::test]
async fn a_repeat_heartbeat_prepares_no_statement_on_its_own() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("a_repeat_heartbeat_prepares_no_statement_on_its_own").await?;
    let job = LeasedJob::seed(&pool, "heartbeat-round-trips").await?;
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "heartbeat-round-trips",
    );
    let token = job.agent_token(&config, "agent.heartbeat");

    let tally = repeat_call(
        config,
        crate::agent::router,
        &token,
        "/agent/heartbeat",
        json!({"job_id": job.job_id.to_string(), "extend_seconds": 120}),
    )
    .await?;
    let prepared_alone = tally.named_parses();
    assert_eq!(
        prepared_alone, 0,
        "a repeat heartbeat prepared {prepared_alone} statement(s) on their own; each waits an \
         extra round trip to the database. Run them with the typed calls (crate::typed_sql)."
    );
    Ok(())
}

#[tokio::test]
async fn a_repeat_secrets_call_prepares_no_statement_on_its_own() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("a_repeat_secrets_call_prepares_no_statement_on_its_own").await?;
    let job = LeasedJob::seed(&pool, "secrets-round-trips").await?;
    let mut config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "secrets-round-trips",
    );
    config.credential_keys =
        Some(crate::config::CredentialEncryptionKey::for_test("secrets-round-trips").into());
    let token = job.agent_token(&config, "agent.secrets");

    let tally = repeat_call(
        config,
        crate::secrets::router,
        &token,
        "/agent/secrets",
        json!({"job_id": job.job_id.to_string()}),
    )
    .await?;
    let prepared_alone = tally.named_parses();
    assert_eq!(
        prepared_alone, 0,
        "a repeat secrets call prepared {prepared_alone} statement(s) on their own; each waits an \
         extra round trip to the database. Run them with the typed calls (crate::typed_sql)."
    );
    // The secret tables are created and hardened once per process, not on
    // every job's request for its secrets.
    assert_eq!(
        tally.schema_queries(),
        0,
        "a repeat secrets call changed the schema again"
    );
    Ok(())
}
