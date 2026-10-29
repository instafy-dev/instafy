use anyhow::Context;
use axum::{http::StatusCode, Router};
use bb8_postgres::PostgresConnectionManager;
use futures_util::FutureExt;
use serde_json::json;
use uuid::Uuid;

use crate::config::{CredentialEncryptionKey, PgPool};
use crate::tests::{build_test_state, call_router, eventually};

struct Fixture {
    pool: PgPool,
    app: Router,
    owner: String,
    outsider: String,
    path: String,
}

/// No public search path: missing secret tables cannot fall through to the
/// developer's real tables. Cleanup only drops this test's random schema.
async fn with_fresh_secrets<F, Fut>(body: F) -> anyhow::Result<()>
where
    F: FnOnce(Fixture) -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<()>>,
{
    let url = std::env::var("TEST_DATABASE_URL").context(
        "secret initialization tests require TEST_DATABASE_URL; run pnpm test:controller",
    )?;
    let (admin, driver) = tokio_postgres::connect(&url, tokio_postgres::NoTls).await?;
    let driver = tokio::spawn(driver);
    let schema = format!("secrets_initialization_{}", Uuid::new_v4().simple());
    admin
        .batch_execute(&format!("create schema {schema}"))
        .await?;
    let outcome = std::panic::AssertUnwindSafe(async {
        let mut config: tokio_postgres::Config = url.parse()?;
        config.options(&format!(
            "-c search_path={schema} -c statement_timeout=10000"
        ));
        let pool = bb8::Pool::builder()
            .max_size(3)
            .build(PostgresConnectionManager::new(
                config,
                crate::config::database_tls(),
            ))
            .await?;
        let project_id = Uuid::new_v4();
        let owner_id = Uuid::new_v4();
        pool.get()
            .await?
            .batch_execute(
                "create table projects (
                id uuid primary key, org_id uuid, name text, sandbox_session_id uuid,
                project_type text, owner_user_id uuid, status text
             );
             create table project_memberships (project_id uuid, user_id uuid, role text);
             create table user_agents (
                id uuid primary key, user_id uuid, handle text, deleted_at timestamptz
             );",
            )
            .await?;
        pool.get()
            .await?
            .execute(
                "insert into projects (id, owner_user_id, project_type, status)
             values ($1, $2, 'customer', 'active')",
                &[&project_id, &owner_id],
            )
            .await?;
        let mut config = super::security_tests::test_config();
        config.strict_mode = true;
        config.credential_keys =
            Some(CredentialEncryptionKey::for_test("secret initialization").into());
        let token = |id| {
            crate::auth::issue_controller_token(&config, &id)
                .map(|token| format!("Bearer {}", token.token))
                .map_err(|(status, error)| anyhow::anyhow!("{status}: {}", error.0.message))
        };
        let owner = token(owner_id)?;
        let outsider = token(Uuid::new_v4())?;
        let app = super::router().with_state(build_test_state(pool.clone(), config));
        body(Fixture {
            pool,
            app,
            owner,
            outsider,
            path: format!("/projects/{project_id}/secrets"),
        })
        .await
    })
    .catch_unwind()
    .await;
    let cleanup = admin
        .batch_execute(&format!("drop schema {schema} cascade"))
        .await;
    drop(admin);
    let _ = driver.await;
    match outcome {
        Ok(result) => result.and(cleanup.map_err(anyhow::Error::from)),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

async fn assert_private_tables(pool: &PgPool) -> anyhow::Result<()> {
    let db = pool.get().await?;
    for table in [
        "project_secrets",
        "project_secret_agent_grants",
        "project_secret_agent_handle_grants",
    ] {
        let row = db.query_one(
            "select relrowsecurity,
                has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE') as anon_access,
                has_table_privilege('authenticated', oid, 'SELECT,INSERT,UPDATE,DELETE') as user_access
             from pg_class where oid = to_regclass($1)", &[&table],
        ).await?;
        anyhow::ensure!(row.get::<_, bool>("relrowsecurity"), "{table} requires RLS");
        anyhow::ensure!(
            !row.get::<_, bool>("anon_access") && !row.get::<_, bool>("user_access"),
            "{table} must remain controller-only"
        );
    }
    Ok(())
}

#[tokio::test]
async fn first_list_initializes_missing_secret_tables() -> anyhow::Result<()> {
    with_fresh_secrets(|f| async move {
        let (status, body) =
            call_router(&f.app, Some(&f.owner), "GET", f.path.clone(), None).await?;
        anyhow::ensure!(status == StatusCode::OK, "first list: {status}: {body}");
        assert_eq!(body, json!([]));
        assert_private_tables(&f.pool).await?;
        let (status, body) = call_router(&f.app, Some(&f.owner), "GET", f.path, None).await?;
        anyhow::ensure!(status == StatusCode::OK && body == json!([]));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn first_create_initializes_missing_secret_tables_and_preserves_crud() -> anyhow::Result<()> {
    with_fresh_secrets(|f| async move {
        let payload =
            json!({"name":"FIRST_SECRET", "value":"test-only-secret", "agentHandles":["writer"]});
        let (status, body) = call_router(
            &f.app,
            Some(&f.owner),
            "POST",
            f.path.clone(),
            Some(payload.clone()),
        )
        .await?;
        anyhow::ensure!(status == StatusCode::OK, "first create: {status}: {body}");
        let id = body["id"].as_str().context("created secret id")?;
        assert_private_tables(&f.pool).await?;
        let (status, _) = call_router(
            &f.app,
            Some(&f.owner),
            "POST",
            f.path.clone(),
            Some(payload),
        )
        .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let secret_path = format!("{}/{id}", f.path);
        let (status, body) = call_router(
            &f.app,
            Some(&f.owner),
            "PATCH",
            secret_path.clone(),
            Some(json!({"description":"updated", "agentHandles":["reviewer"]})),
        )
        .await?;
        anyhow::ensure!(status == StatusCode::OK, "update: {status}: {body}");
        assert_eq!(body["agentHandles"], json!(["reviewer"]));
        let (status, body) =
            call_router(&f.app, Some(&f.owner), "GET", f.path.clone(), None).await?;
        anyhow::ensure!(status == StatusCode::OK, "list: {status}: {body}");
        assert_eq!(body[0]["description"], "updated");
        anyhow::ensure!(!body.to_string().contains("test-only-secret"));
        let (status, _) = call_router(&f.app, Some(&f.owner), "DELETE", secret_path, None).await?;
        assert_eq!(status, StatusCode::OK);
        let (_, body) = call_router(&f.app, Some(&f.owner), "GET", f.path, None).await?;
        assert_eq!(body, json!([]));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn secret_initialization_requires_project_access() -> anyhow::Result<()> {
    with_fresh_secrets(|f| async move {
        for auth in [None, Some(f.outsider.as_str())] {
            let (status, _) = call_router(&f.app, auth, "GET", f.path.clone(), None).await?;
            assert_eq!(
                status,
                if auth.is_none() {
                    StatusCode::UNAUTHORIZED
                } else {
                    StatusCode::FORBIDDEN
                }
            );
        }
        let absent: bool = f
            .pool
            .get()
            .await?
            .query_one("select to_regclass('project_secrets') is null", &[])
            .await?
            .get(0);
        anyhow::ensure!(absent, "unauthorized requests must not create tables");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn first_list_repairs_missing_grant_tables() -> anyhow::Result<()> {
    with_fresh_secrets(|f| async move {
        super::ensure_project_secrets_table(&*f.pool.get().await?).await?;
        // A legacy installation can have the secret table before either grants table.
        f.pool.get().await?.execute(
            "insert into project_secrets (id, project_id, user_id, name, nonce_b64, ciphertext_b64)
             select $1, id, owner_user_id, 'LEGACY_SECRET', 'test-nonce', 'test-cipher' from projects",
            &[&Uuid::new_v4()],
        ).await?;
        let (status, body) = call_router(&f.app, Some(&f.owner), "GET", f.path, None).await?;
        anyhow::ensure!(status == StatusCode::OK, "partial schema list: {status}: {body}");
        assert_eq!(body[0]["name"], "LEGACY_SECRET");
        assert_eq!(body[0]["agentHandles"], json!([]));
        assert_private_tables(&f.pool).await
    }).await
}

#[tokio::test]
async fn concurrent_first_requests_initialize_secret_tables_once() -> anyhow::Result<()> {
    with_fresh_secrets(|f| async move {
        let requests = (0..6).map(|index| {
            call_router(
                &f.app,
                Some(&f.owner),
                "POST",
                f.path.clone(),
                Some(json!({
                    "name": format!("CONCURRENT_SECRET_{index}"),
                    "value": "test-only-secret",
                    "agentHandles": ["writer"]
                })),
            )
        });
        for result in futures_util::future::join_all(requests).await {
            let (status, body) = result?;
            anyhow::ensure!(
                status == StatusCode::OK,
                "concurrent create: {status}: {body}"
            );
        }
        let (status, body) = call_router(&f.app, Some(&f.owner), "GET", f.path, None).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body.as_array().map(Vec::len), Some(6));
        assert_private_tables(&f.pool).await
    })
    .await
}

#[tokio::test]
async fn waiting_initializer_observes_tables_committed_after_its_negative_probe(
) -> anyhow::Result<()> {
    with_fresh_secrets(|f| async move {
        let mut waiting_connection = f.pool.get().await?;
        let waiting = waiting_connection.transaction().await?;
        let waiting_pid: i32 = waiting
            .query_one("select pg_backend_pid()", &[])
            .await?
            .get(0);
        assert!(!super::secret_tables_exist(&waiting).await?);

        let mut creating_connection = f.pool.get().await?;
        let creating = creating_connection.transaction().await?;
        super::lock_secret_table_initialization(&creating).await?;
        super::create_secret_tables(&creating).await?;

        let (waited, committed) = tokio::join!(
            async {
                super::lock_secret_table_initialization(&waiting).await?;
                anyhow::ensure!(
                    super::secret_tables_exist(&waiting).await?,
                    "the post-lock probe must observe the committed schema"
                );
                Ok::<_, anyhow::Error>(())
            },
            async {
                eventually("initializer waiting on the schema lock", || async {
                    let blocked: bool = creating
                        .query_one(
                            "select exists (select 1 from pg_locks where locktype = 'advisory'
                         and pid = $1 and not granted)",
                            &[&waiting_pid],
                        )
                        .await?
                        .get(0);
                    Ok(blocked.then_some(()))
                })
                .await?;
                creating.commit().await?;
                Ok::<_, anyhow::Error>(())
            },
        );
        committed?;
        waited?;
        waiting.commit().await?;
        Ok(())
    })
    .await
}

#[tokio::test]
async fn explicit_secret_schema_hardening_does_not_deadlock_an_active_writer() -> anyhow::Result<()>
{
    with_fresh_secrets(|f| async move {
        super::ensure_secret_tables(&f.pool).await?;
        // Explicit initialization must still repair legacy access protections.
        f.pool.get().await?.batch_execute(
            "alter table project_secrets disable row level security;
             grant select on project_secrets to anon, authenticated;",
        ).await?;
        let mut connection = f.pool.get().await?;
        let writer = connection.transaction().await?;
        writer.query("select id from project_secrets", &[]).await?;
        let (initialized, written) = tokio::join!(
            super::ensure_secret_tables(&f.pool),
            async {
                eventually("initializer waiting for the active secret reader", || async {
                    let blocked: bool = writer.query_one(
                        "select exists (select 1 from pg_locks
                         where relation = 'project_secrets'::regclass
                           and mode = 'AccessExclusiveLock' and not granted)", &[],
                    ).await?.get(0);
                    Ok(blocked.then_some(()))
                }).await?;
                writer.execute(
                    "insert into project_secrets (id, project_id, user_id, name, nonce_b64, ciphertext_b64)
                     select $1, id, owner_user_id, 'OVERLAP_SECRET', 'test-nonce', 'test-cipher' from projects",
                    &[&Uuid::new_v4()],
                ).await?;
                writer.commit().await?;
                Ok::<_, anyhow::Error>(())
            },
        );
        written?;
        initialized?;
        assert_private_tables(&f.pool).await
    }).await
}
