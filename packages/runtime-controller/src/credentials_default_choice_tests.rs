//! Which AI a person's spaces use after they connect their own. A live test
//! found a brand-new space running on "Codex on this computer" while the
//! included Instafy AI sat unused: the first connection a person saves used
//! to become their default on its own, and the default answers for every
//! space. Instafy AI now stays the default while it can run their turns,
//! unless they ask for the connection (`makeDefault`, or "Make default"
//! later). The requirements response also says Instafy AI is available to
//! someone whose default is their own AI, instead of "unavailable".

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use httpmock::Method::GET;
use httpmock::MockServer;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, setup_origin_test_pool,
    test_origin_private_key, test_origin_public_key,
};

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

fn codex_login(label: &str, make_default: Option<bool>) -> Value {
    let mut body = json!({
        "authJson": {
            "tokens": { "access_token": "fixture-access-token", "account_id": "acct_fixture" }
        },
        "label": label,
    });
    if let Some(make_default) = make_default {
        body["makeDefault"] = json!(make_default);
    }
    body
}

#[tokio::test]
async fn connecting_own_ai_keeps_instafy_ai_the_default_unless_asked() -> anyhow::Result<()> {
    use futures_util::FutureExt;

    let Some(pool) = setup_origin_test_pool().await? else {
        eprintln!("skipping default choice route test: TEST_DATABASE_URL not set");
        return Ok(());
    };

    let proxy = MockServer::start_async().await;
    proxy
        .mock_async(|when, then| {
            when.method(GET).path("/healthz");
            then.status(200)
                .json_body(json!({ "backend": "codex", "requiresCredential": false }));
        })
        .await;
    let app_for = |managed_ai_enabled: bool| {
        let mut config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "default-choice",
        );
        config.proxy_base_url = Some(proxy.base_url());
        config.managed_ai_enabled = managed_ai_enabled;
        config.credential_keys = Some(
            crate::config::CredentialEncryptionKey::for_test("default-choice-test-key").into(),
        );
        let app = crate::credentials::router().with_state(build_test_state(pool.clone(), config));
        app
    };
    let token_for = |user_id: &Uuid| {
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "default-choice",
        );
        crate::auth::issue_controller_token(&config, user_id)
            .map(|issued| issued.token)
            .map_err(|(_, error)| anyhow::anyhow!(error.0.message))
    };

    let included_user = Uuid::new_v4();
    let own_ai_only_user = Uuid::new_v4();
    let users = vec![included_user, own_ai_only_user];

    let outcome = std::panic::AssertUnwindSafe(async {
        ensure_test_user(&pool, &included_user).await?;
        ensure_test_user(&pool, &own_ai_only_user).await?;

        // Instafy AI is on and can serve: connecting Codex leaves it the
        // default, so a new space still runs on the included AI.
        let app = app_for(true);
        let token = token_for(&included_user)?;
        let (status, created) = send(
            &app,
            &token,
            "POST",
            "/me/credentials/codex",
            Some(codex_login("Codex on this computer", None)),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert_eq!(created["isDefault"], json!(false), "{created}");
        let (_, requirements) =
            send(&app, &token, "GET", "/me/credentials/requirements", None).await?;
        assert_eq!(
            requirements["hasDefaultCredential"],
            json!(false),
            "{requirements}"
        );
        assert_eq!(requirements["requiresUserCredentials"], json!(false));
        assert_eq!(requirements["managedAi"]["available"], json!(true));

        // Asking for it is an explicit choice, and it wins.
        let (status, created) = send(
            &app,
            &token,
            "POST",
            "/me/credentials/codex",
            Some(codex_login("Codex, chosen", Some(true))),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert_eq!(created["isDefault"], json!(true), "{created}");

        // Their own AI is the default now, and Instafy AI is still available
        // to switch back to: not "unavailable" next to a full allowance.
        let (_, requirements) =
            send(&app, &token, "GET", "/me/credentials/requirements", None).await?;
        assert_eq!(
            requirements["hasDefaultCredential"],
            json!(true),
            "{requirements}"
        );
        let managed_ai = &requirements["managedAi"];
        assert_eq!(managed_ai["available"], json!(true), "{managed_ai}");
        assert_eq!(managed_ai["remainingPrompts"], json!(20));
        assert!(
            managed_ai.get("unavailableReason").is_none(),
            "{managed_ai}"
        );

        // Without Instafy AI there is nothing else to run on, so the first
        // connection still becomes the default by itself.
        let app = app_for(false);
        let token = token_for(&own_ai_only_user)?;
        let (status, created) = send(
            &app,
            &token,
            "POST",
            "/me/credentials/codex",
            Some(codex_login("Codex on this computer", None)),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{created}");
        assert_eq!(created["isDefault"], json!(true), "{created}");
        let (_, requirements) =
            send(&app, &token, "GET", "/me/credentials/requirements", None).await?;
        assert_eq!(requirements["managedAi"]["available"], json!(false));
        assert_eq!(
            requirements["managedAi"]["unavailableReason"],
            json!("disabled")
        );
        Ok::<(), anyhow::Error>(())
    })
    .catch_unwind()
    .await;

    let cleanup = pool.get().await?;
    cleanup
        .execute("delete from user_agents where user_id = any($1)", &[&users])
        .await?;
    cleanup
        .execute(
            "delete from user_credentials where user_id = any($1)",
            &[&users],
        )
        .await?;
    cleanup
        .execute("delete from auth.users where id = any($1)", &[&users])
        .await?;
    match outcome {
        Ok(result) => result,
        Err(panic) => std::panic::resume_unwind(panic),
    }
}
