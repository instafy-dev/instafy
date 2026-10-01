//! The managed credential id is reserved for the platform lane. Every path
//! that resolves a user credential id treats a stored row under it as absent,
//! no client can select it, and no proxy token claim carries it.
//!
//! The database tests model a row written before
//! `user_credentials_id_not_reserved` existed: inside one transaction they
//! drop the check, insert the row, run the resolver on that same transaction
//! and roll back, so nothing persists and no other session sees the change.
//! The table stays locked until the rollback, which the serial controller
//! suite (`pnpm test:controller` runs one test at a time) absorbs.

use super::*;
use crate::tests::{build_app_config, require_origin_test_pool};
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use runtime_contracts::ProxyEnvelopePayload;
use tokio_postgres::error::SqlState;

pub(crate) const RESERVED_ID_CHECK: &str = "user_credentials_id_not_reserved";

pub(crate) fn reserved_id() -> Uuid {
    crate::config::managed_ai_credential_id()
}

pub(crate) fn api_error(error: (StatusCode, Json<ApiError>)) -> anyhow::Error {
    let (status, Json(body)) = error;
    anyhow::anyhow!("status {}: {}", status.as_u16(), body.message)
}

/// Makes `user_id` a user in `transaction` and gives it a credential row under
/// the reserved id. Drops the reserving check first, inside the transaction,
/// so the lock it takes is the first one the transaction holds.
pub(crate) async fn seed_reserved_credential_row(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
    is_default: bool,
) -> anyhow::Result<()> {
    transaction
        .batch_execute(&format!(
            "set local lock_timeout = '5s';
             alter table user_credentials drop constraint if exists {RESERVED_ID_CHECK};"
        ))
        .await?;
    insert_test_user(transaction, user_id).await?;
    transaction
        .execute(
            "insert into user_credentials (
                 id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
             ) values ($1, $2, 'openai_api_key', 'Reserved', 'fixture', 'fixture', '{}'::jsonb, $3)",
            &[&reserved_id(), user_id, &is_default],
        )
        .await?;
    Ok(())
}

pub(crate) async fn insert_test_user(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
) -> anyhow::Result<()> {
    transaction
        .execute(
            "insert into auth.users (
                 instance_id, id, aud, role, email, raw_app_meta_data, raw_user_meta_data,
                 created_at, updated_at
             ) values (
                 $1, $2, 'authenticated', 'authenticated', $3, '{}'::jsonb, '{}'::jsonb,
                 now(), now()
             )",
            &[
                &Uuid::nil(),
                user_id,
                &format!("controller-test+{user_id}@example.com"),
            ],
        )
        .await?;
    Ok(())
}

pub(crate) async fn insert_user_credential_row(
    transaction: &Transaction<'_>,
    user_id: &Uuid,
    is_default: bool,
) -> anyhow::Result<Uuid> {
    let credential_id = Uuid::new_v4();
    transaction
        .execute(
            "insert into user_credentials (
                 id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
             ) values ($1, $2, 'openai_api_key', 'Own', 'fixture', 'fixture', '{}'::jsonb, $3)",
            &[&credential_id, user_id, &is_default],
        )
        .await?;
    Ok(credential_id)
}

#[test]
fn a_stored_reserved_id_reads_as_no_user_credential() {
    assert_eq!(usable_user_credential_id(Some(reserved_id())), None);
    let own = Uuid::new_v4();
    assert_eq!(usable_user_credential_id(Some(own)), Some(own));
    assert_eq!(usable_user_credential_id(None), None);
}

#[test]
fn proxy_token_claims_never_carry_the_reserved_id() {
    let mut config = build_app_config("", "", "");
    config.proxy_signing_secret = Some("reserved-credential-signing".to_string());
    config.proxy_base_url = Some("http://proxy.invalid".to_string());
    let project_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let run_id = Uuid::new_v4();
    let issue = |run_id: Option<&Uuid>, credential_id: Option<&Uuid>| {
        crate::auth::issue_proxy_envelope(
            &config,
            &project_id,
            &runtime_id,
            run_id,
            credential_id,
            None,
            Some("octo"),
            Some("Octo"),
            None,
        )
    };
    let claims = |envelope: ProxyEnvelopePayload| -> JsonValue {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.set_audience(&["proxy"]);
        decode::<JsonValue>(
            &envelope.token,
            &DecodingKey::from_secret(b"reserved-credential-signing"),
            &validation,
        )
        .expect("proxy token decodes")
        .claims
    };

    // Nothing is minted for the reserved id, with or without a run: dropping
    // the claim instead would turn a job token into a managed-lane token.
    assert!(issue(Some(&run_id), Some(&reserved_id())).is_none());
    assert!(issue(None, Some(&reserved_id())).is_none());

    let own = Uuid::new_v4();
    let user_lane = claims(issue(Some(&run_id), Some(&own)).expect("user credential token"));
    assert_eq!(user_lane["credential_id"], json!(own.to_string()));
    assert_eq!(user_lane["run_id"], json!(run_id.to_string()));

    let managed_lane = claims(issue(Some(&run_id), None).expect("managed lane token"));
    assert!(managed_lane.get("credential_id").is_none());
    assert_eq!(managed_lane["run_id"], json!(run_id.to_string()));
}

#[tokio::test]
async fn revoking_the_reserved_id_answers_unknown_before_any_database_access() -> anyhow::Result<()>
{
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    // Nothing listens on port 1, so a revoke that reached the database would
    // fail with a 5xx instead of answering like an unknown credential.
    let manager = bb8_postgres::PostgresConnectionManager::new_from_stringlike(
        "postgresql://postgres:postgres@127.0.0.1:1/postgres",
        crate::config::database_tls(),
    )?;
    let pool = bb8::Pool::builder()
        .max_size(1)
        .connection_timeout(std::time::Duration::from_millis(500))
        .build_unchecked(manager);
    let config = build_app_config("", "", "");
    let token = crate::auth::issue_controller_token(&config, &Uuid::new_v4())
        .map_err(api_error)?
        .token;
    let app = router().with_state(crate::tests::build_test_state(pool, config));
    let revoke = |credential_id: Uuid| {
        let app = app.clone();
        let token = token.clone();
        async move {
            let response = app
                .oneshot(
                    Request::builder()
                        .method("DELETE")
                        .uri(format!("/me/credentials/{credential_id}"))
                        .header("authorization", format!("Bearer {token}"))
                        .body(Body::empty())?,
                )
                .await?;
            let status = response.status();
            let body = to_bytes(response.into_body(), 1024 * 1024).await?;
            anyhow::Ok((status, serde_json::from_slice::<JsonValue>(&body)?))
        }
    };

    let (status, payload) = revoke(reserved_id()).await?;
    assert_eq!(status, StatusCode::NOT_FOUND, "{payload}");
    assert_eq!(payload["message"], json!("credential not found"));
    // Any other id goes on to the database.
    let (status, payload) = revoke(Uuid::new_v4()).await?;
    assert!(status.is_server_error(), "{status}: {payload}");
    Ok(())
}

#[tokio::test]
async fn schema_refuses_the_reserved_credential_id() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("reserved credential id schema check").await?;
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let user_id = Uuid::new_v4();
    insert_test_user(&transaction, &user_id).await?;

    // The check ships NOT VALID; validating it is left to a later migration.
    let validated: bool = transaction
        .query_one(
            "select convalidated from pg_constraint
             where conname = $1 and conrelid = 'public.user_credentials'::regclass",
            &[&RESERVED_ID_CHECK],
        )
        .await?
        .get("convalidated");
    assert!(!validated, "{RESERVED_ID_CHECK} must ship NOT VALID");

    insert_user_credential_row(&transaction, &user_id, true).await?;
    let error = transaction
        .execute(
            "insert into user_credentials (id, user_id, kind, nonce_b64, ciphertext_b64)
             values ($1, $2, 'openai_api_key', 'fixture', 'fixture')",
            &[&reserved_id(), &user_id],
        )
        .await
        .expect_err("the reserved id must be refused");
    let db_error = error.as_db_error().expect("database error");
    assert_eq!(db_error.code(), &SqlState::CHECK_VIOLATION);
    assert_eq!(db_error.constraint(), Some(RESERVED_ID_CHECK));
    // The transaction is aborted and is rolled back on drop.
    Ok(())
}

#[tokio::test]
async fn a_reserved_default_row_is_no_default_credential() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("reserved credential id default resolution").await?;
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let user_id = Uuid::new_v4();
    seed_reserved_credential_row(&transaction, &user_id, true).await?;
    let reserved = reserved_id().to_string();

    // Dispatch, the managed AI gate and the credential requirements read the
    // default here: the user has none, so the managed path applies.
    assert_eq!(
        load_default_credential_id(&transaction, Some(user_id))
            .await
            .map_err(api_error)?,
        None
    );
    // Editor completions and conversation titles: neither the default row
    // nor a request naming the reserved id resolves a credential.
    assert!(
        resolve_editor_completion_credential(&transaction, user_id, None)
            .await
            .map_err(api_error)?
            .is_none()
    );
    assert!(
        resolve_editor_completion_credential(&transaction, user_id, Some(&reserved))
            .await
            .map_err(api_error)?
            .is_none()
    );

    // Once the user has an ordinary default, it is the one that resolves.
    transaction
        .execute(
            "update user_credentials set is_default = false where id = $1",
            &[&reserved_id()],
        )
        .await?;
    let own = insert_user_credential_row(&transaction, &user_id, true).await?;
    assert_eq!(
        load_default_credential_id(&transaction, Some(user_id))
            .await
            .map_err(api_error)?,
        Some(own)
    );
    let resolved = resolve_editor_completion_credential(&transaction, user_id, None)
        .await
        .map_err(api_error)?
        .expect("own default resolves");
    assert_eq!(resolved.credential_id, own);
    let requested =
        resolve_editor_completion_credential(&transaction, user_id, Some(&own.to_string()))
            .await
            .map_err(api_error)?
            .expect("own credential resolves by id");
    assert_eq!(requested.credential_id, own);
    assert!(
        resolve_editor_completion_credential(&transaction, user_id, Some(&reserved))
            .await
            .map_err(api_error)?
            .is_none()
    );

    transaction.rollback().await?;
    Ok(())
}

#[tokio::test]
async fn a_reserved_row_is_never_listed_or_selectable() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("reserved credential id selection").await?;
    let mut connection = pool.get().await?;
    let transaction = connection.transaction().await?;
    let user_id = Uuid::new_v4();
    seed_reserved_credential_row(&transaction, &user_id, false).await?;
    let own = insert_user_credential_row(&transaction, &user_id, true).await?;

    // GET /me/credentials lists only the ordinary row.
    let listed: Vec<String> = load_credential_list(&transaction, &user_id)
        .await
        .map_err(api_error)?
        .into_iter()
        .map(|item| item.id)
        .collect();
    assert_eq!(listed, vec![own.to_string()]);

    // Testing a credential, making it the default and pinning it to an agent
    // all select through this lookup; the reserved id reads as unknown.
    assert!(
        load_owned_live_credential(&transaction, &user_id, &reserved_id())
            .await
            .map_err(api_error)?
            .is_none()
    );
    assert!(load_owned_live_credential(&transaction, &user_id, &own)
        .await
        .map_err(api_error)?
        .is_some());
    let error = crate::ai_agents::resolve_agent_provider_for_credential(
        &transaction,
        &user_id,
        &reserved_id(),
    )
    .await
    .expect_err("an agent cannot pin the reserved id");
    assert_eq!(error.0, StatusCode::NOT_FOUND);
    assert_eq!(
        crate::ai_agents::resolve_agent_provider_for_credential(&transaction, &user_id, &own)
            .await
            .map_err(api_error)?,
        "openai"
    );

    transaction.rollback().await?;
    Ok(())
}

#[tokio::test]
async fn credential_routes_answer_the_reserved_id_as_unknown() -> anyhow::Result<()> {
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    let pool = require_origin_test_pool("reserved credential id routes").await?;
    let user_id = Uuid::new_v4();
    crate::tests::ensure_test_user(&pool, &user_id).await?;
    let result = async {
        let own = {
            let mut connection = pool.get().await?;
            let transaction = connection.transaction().await?;
            let own = insert_user_credential_row(&transaction, &user_id, false).await?;
            transaction.commit().await?;
            own
        };
        let config = build_app_config("", "", "");
        let token = crate::auth::issue_controller_token(&config, &user_id)
            .map_err(api_error)?
            .token;
        let app = router()
            .merge(crate::ai_agents::router())
            .with_state(crate::tests::build_test_state(pool.clone(), config));
        let request = |method: &str, path: String, body: Option<JsonValue>| {
            let builder = Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"));
            match body {
                Some(body) => builder
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string())),
                None => builder.body(Body::empty()),
            }
        };
        let send = |request: Request<Body>| {
            let app = app.clone();
            async move {
                let response = app.oneshot(request).await?;
                let status = response.status();
                let body = to_bytes(response.into_body(), 1024 * 1024).await?;
                anyhow::Ok((status, serde_json::from_slice::<JsonValue>(&body)?))
            }
        };
        let reserved = reserved_id();

        for (method, path, body) in [
            ("POST", format!("/me/credentials/{reserved}/default"), None),
            ("POST", format!("/me/credentials/{reserved}/test"), None),
            ("DELETE", format!("/me/credentials/{reserved}"), None),
            (
                "POST",
                "/me/agents".to_string(),
                Some(json!({ "credentialId": reserved })),
            ),
            (
                "POST",
                "/me/agents".to_string(),
                Some(json!({ "handle": "reservedpin", "credentialId": reserved })),
            ),
        ] {
            let (status, payload) = send(request(method, path.clone(), body)?).await?;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {payload}");
            assert_eq!(payload["message"], json!("credential not found"));
        }

        // The ordinary credential still lists, becomes the default and pins
        // to an agent through the same handlers.
        let (status, listed) = send(request("GET", "/me/credentials".to_string(), None)?).await?;
        assert_eq!(status, StatusCode::OK, "{listed}");
        assert_eq!(listed.as_array().map(Vec::len), Some(1), "{listed}");
        assert_eq!(listed[0]["id"], json!(own.to_string()));
        let (status, default) = send(request(
            "POST",
            format!("/me/credentials/{own}/default"),
            None,
        )?)
        .await?;
        assert_eq!(status, StatusCode::OK, "{default}");
        assert_eq!(default["isDefault"], json!(true));
        let (status, agent) = send(request(
            "POST",
            "/me/agents".to_string(),
            Some(json!({ "handle": "ownpin", "credentialId": own })),
        )?)
        .await?;
        assert_eq!(status, StatusCode::OK, "{agent}");
        assert_eq!(agent["credentialId"], json!(own.to_string()));
        anyhow::Ok(())
    }
    .await;
    pool.get()
        .await?
        .execute("delete from auth.users where id = $1", &[&user_id])
        .await?;
    result
}
