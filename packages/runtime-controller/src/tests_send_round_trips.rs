//! A send's statements each take one round trip to the database.
//!
//! The controller runs a cross-region hop away from its database, and a send
//! runs a few dozen statements while its job is still invisible to every
//! runtime. An untyped statement is prepared on its own first and waits for the
//! server's answer before it runs, which doubles its share of that wait
//! (`crate::typed_sql`). These tests count, on the wire, the statements a send
//! still prepares on their own.

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

/// Reads the client's side of a Postgres connection and counts the statements
/// it prepared on their own: Parse messages that name their statement. A typed
/// statement parses the unnamed statement in the same message that runs it.
#[derive(Default)]
struct ClientMessages {
    pending: Vec<u8>,
    started: bool,
}

impl ClientMessages {
    const SSL_REQUEST: u32 = 80_877_103;
    const GSSENC_REQUEST: u32 = 80_877_104;

    fn named_parses(&mut self, bytes: &[u8]) -> usize {
        self.pending.extend_from_slice(bytes);
        let mut named = 0;
        loop {
            // The startup message, and any request for encryption before it,
            // carries no type byte.
            let length_at = usize::from(self.started);
            if self.pending.len() < length_at + 4 {
                return named;
            }
            let length = u32::from_be_bytes(
                self.pending[length_at..length_at + 4]
                    .try_into()
                    .expect("four length bytes"),
            ) as usize;
            let total = length_at + length;
            if length < 4 || self.pending.len() < total {
                return named;
            }
            if self.started {
                if self.pending[0] == b'P' && self.pending.get(5).is_some_and(|byte| *byte != 0) {
                    named += 1;
                }
            } else {
                let code =
                    u32::from_be_bytes(self.pending[4..8].try_into().expect("four code bytes"));
                self.started = code != Self::SSL_REQUEST && code != Self::GSSENC_REQUEST;
            }
            self.pending.drain(..total);
        }
    }
}

/// A local hop in front of the test database that counts, across every
/// connection through it, the statements prepared on their own.
async fn counting_hop(upstream: SocketAddr, named: Arc<AtomicUsize>) -> anyhow::Result<SocketAddr> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    tokio::spawn(async move {
        while let Ok((client, _)) = listener.accept().await {
            let named = named.clone();
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
                        named.fetch_add(messages.named_parses(&buffer[..read]), Ordering::SeqCst);
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

async fn test_database_address() -> anyhow::Result<SocketAddr> {
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
async fn pool_through(hop: SocketAddr) -> anyhow::Result<PgPool> {
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
fn only_a_parse_that_names_its_statement_is_counted() {
    let mut messages = ClientMessages::default();
    // An SSL request, then a startup message: neither has a type byte.
    let mut wire = Vec::new();
    wire.extend_from_slice(&8_u32.to_be_bytes());
    wire.extend_from_slice(&ClientMessages::SSL_REQUEST.to_be_bytes());
    let startup = b"\0\x03\0\0user\0postgres\0\0";
    wire.extend_from_slice(&((startup.len() + 4) as u32).to_be_bytes());
    wire.extend_from_slice(startup);
    let parse = |name: &str| {
        let mut body = Vec::new();
        body.extend_from_slice(name.as_bytes());
        body.push(0);
        body.extend_from_slice(b"select 1\0\0\0");
        let mut message = vec![b'P'];
        message.extend_from_slice(&((body.len() + 4) as u32).to_be_bytes());
        message.extend_from_slice(&body);
        message
    };
    wire.extend(parse("s1"));
    wire.extend(parse(""));
    wire.extend_from_slice(b"S\0\0\0\x04");
    wire.extend(parse("s2"));

    // Split anywhere, the stream still reads as the same messages.
    let (head, tail) = wire.split_at(23);
    let counted = messages.named_parses(head) + messages.named_parses(tail);
    assert_eq!(counted, 2);
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

    let named = Arc::new(AtomicUsize::new(0));
    let hop = counting_hop(test_database_address().await?, named.clone()).await?;
    let state = build_test_state(pool_through(hop).await?, config);

    // The first send also sets up what an org and its person get once: a
    // subscription, a default Octo.
    send_hello(&state, &token, first_conversation_id, runtime_id).await?;
    named.store(0, Ordering::SeqCst);
    send_hello(&state, &token, second_conversation_id, runtime_id).await?;

    let prepared_alone = named.load(Ordering::SeqCst);
    assert_eq!(
        prepared_alone, 0,
        "a repeat send prepared {prepared_alone} statement(s) on their own; each waits an extra \
         round trip to the database. Run them with the typed calls (crate::typed_sql)."
    );
    Ok(())
}
