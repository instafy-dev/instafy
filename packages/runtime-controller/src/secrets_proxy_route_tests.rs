//! Project secrets named after the proxy route (`runtime_contracts::proxy_route`):
//! create refuses each of its names, update refuses a new value for a secret
//! stored under one earlier, and delivery skips such a secret by handle and by
//! id, while the listing still shows it. Every other name, an app's own
//! `APP_OPENAI_API_KEY` among them, is saved and delivered as before.
//!
//! The database tests run on the shared test database through the credential
//! guard's `with_space`, which makes a user and a space and deletes them, and
//! their secrets, however a test ends. Every value is an inert stand-in.

use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Duration, Utc};
use runtime_contracts::proxy_route::PROXY_ROUTE_ENV_KEYS;
use serde_json::{json, Value};
use uuid::Uuid;

use super::claude_material_tests::with_space;
use super::security_tests::{request_secrets, test_config};
use super::{
    is_proxy_route_secret_name, normalize_secret_name, proxy_route_name_refused,
    PROXY_ROUTE_NAME_REFUSED_CODE,
};
use crate::tests::{build_test_state, call_router, sql, sql_one};

const CHOSEN_URL: &str = "http://project-chosen.invalid";

fn refusal_message(name: &str) -> String {
    format!(
        "{name} is reserved: Instafy uses it in every turn to send the AI's requests through \
         Instafy. Save your value under another name, such as APP_{name}."
    )
}

fn assert_refused(status: StatusCode, body: &Value, name: &str) {
    assert_eq!(status, StatusCode::BAD_REQUEST, "{name}: {body}");
    assert_eq!(
        body["code"],
        json!(PROXY_ROUTE_NAME_REFUSED_CODE),
        "{name}: {body}"
    );
    let normalized = normalize_secret_name(name).expect("a valid name");
    assert_eq!(
        body["message"],
        json!(refusal_message(&normalized)),
        "{name}"
    );
}

/// A value a project member might have stored under `name`.
fn chosen_value(name: &str) -> String {
    if name.ends_with("_KEY") {
        format!("inert-project-{}", name.to_ascii_lowercase())
    } else {
        format!("{CHOSEN_URL}/{}", name.to_ascii_lowercase())
    }
}

#[test]
fn the_route_names_are_matched_as_normalize_secret_name_writes_them() {
    for name in PROXY_ROUTE_ENV_KEYS {
        for spelling in [
            name.to_string(),
            name.to_ascii_lowercase(),
            name.replace('_', "-"),
            name.to_ascii_lowercase().replace('_', " "),
            format!("  {name}  "),
        ] {
            assert_eq!(
                normalize_secret_name(&spelling).ok().as_deref(),
                Some(name),
                "{spelling:?}"
            );
            assert!(is_proxy_route_secret_name(&spelling), "{spelling:?}");
        }
    }
    for name in [
        "APP_OPENAI_API_KEY",
        "OPENAI_API_KEY_2",
        "OPENAI__API_KEY",
        "OPENAI_ORG_ID",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "DEEPSEEK_API_KEY",
        "ZAI_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "GITHUB_TOKEN",
    ] {
        assert!(!is_proxy_route_secret_name(name), "{name}");
    }
}

#[test]
fn the_refusal_names_the_secret_and_another_name_for_it() {
    let (status, Json(error)) = proxy_route_name_refused(" openai-base url ");
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error.code.as_deref(), Some("proxy_route_name_reserved"));
    assert_eq!(
        error.message,
        "OPENAI_BASE_URL is reserved: Instafy uses it in every turn to send the AI's requests \
         through Instafy. Save your value under another name, such as APP_OPENAI_BASE_URL."
    );
    assert!(error.details.is_none());
    for name in PROXY_ROUTE_ENV_KEYS {
        let suggestion = format!("APP_{name}");
        assert_eq!(
            normalize_secret_name(&suggestion).ok(),
            Some(suggestion.clone()),
            "{suggestion}"
        );
        assert!(!is_proxy_route_secret_name(&suggestion), "{suggestion}");
    }
}

#[tokio::test]
async fn creating_a_secret_refuses_the_proxy_routes_names() -> anyhow::Result<()> {
    with_space("secret create proxy route", |space| async move {
        let spellings = PROXY_ROUTE_ENV_KEYS
            .iter()
            .map(|name| name.to_string())
            .chain(["openai-api-key".to_string(), "Proxy Base Url".to_string()]);
        for name in spellings {
            let (status, body) = space.create(&name, &chosen_value(&name)).await?;
            assert_refused(status, &body, &name);
        }
        assert_eq!(space.stored_count().await?, 0, "a refused secret is stored");

        // An app's own key under another name, and the keys of providers Instafy does not route
        // through these names, are saved as before.
        for name in ["APP_OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"] {
            let (status, body) = space.create(name, "inert-app-key").await?;
            assert_eq!(status, StatusCode::OK, "create {name}: {body}");
        }
        assert_eq!(space.stored_count().await?, 3);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_secret_stored_under_a_route_name_takes_no_new_value() -> anyhow::Result<()> {
    with_space("secret update proxy route", |space| async move {
        let stored = space
            .store_legacy("OPENAI_BASE_URL", &chosen_value("OPENAI_BASE_URL"))
            .await?;
        let sealed = space.sealed_value(stored).await?;
        let (status, body) = space
            .update(stored, json!({ "value": format!("{CHOSEN_URL}/v2") }))
            .await?;
        assert_refused(status, &body, "OPENAI_BASE_URL");
        assert_eq!(space.sealed_value(stored).await?, sealed);

        // Its description and grants can still change, and it can be removed.
        let (status, body) = space
            .update(
                stored,
                json!({ "description": "rename me", "agentHandles": ["octo"] }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(body["name"], json!("OPENAI_BASE_URL"), "{body}");
        assert!(body.get("refused").is_none(), "{body}");
        assert!(!body.to_string().contains(CHOSEN_URL), "{body}");
        assert_eq!(space.sealed_value(stored).await?, sealed);
        let (status, body) = call_router(
            &space.app,
            Some(&space.bearer),
            "DELETE",
            format!("{}/{stored}", space.secrets_path()),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(space.stored_count().await?, 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn delivery_skips_the_proxy_routes_names_and_the_listing_keeps_them() -> anyhow::Result<()> {
    with_space("secret delivery proxy route", |space| async move {
        let agent_id = Uuid::new_v4();
        let runtime_id = Uuid::new_v4();
        let job_id = Uuid::new_v4();
        sql(
            &space.pool,
            "insert into user_agents (id, user_id, provider, handle, avatar_seed)
             values ($1, $2, 'openai', 'route-agent', 'route-agent')",
            &[&agent_id, &space.owner],
        )
        .await?;
        sql(
            &space.pool,
            "insert into runtimes (id, project_id, provider, status, capabilities)
             values ($1, $2, 'instafy-cloud', 'ready', $3)",
            &[&runtime_id, &space.project_id, &json!({ "agent": true })],
        )
        .await?;
        sql(
            &space.pool,
            "insert into agent_jobs (
                 id, project_id, status, intent, leased_by_runtime_id, lease_expires_at, payload
             ) values ($1, $2, 'leased', 'feature', $3, $4, $5)",
            &[
                &job_id,
                &space.project_id,
                &runtime_id,
                &(Utc::now() + Duration::minutes(10)),
                &json!({ "metadata": {
                    "userId": space.owner,
                    "agent": { "id": agent_id, "handle": "route-agent" }
                } }),
            ],
        )
        .await?;

        // Stored as a release before the refusal could have, half granted by handle and half by
        // id, one of them in a spelling the API never wrote.
        let mut skipped = Vec::new();
        let mut delivered = Vec::new();
        let stored = PROXY_ROUTE_ENV_KEYS
            .iter()
            .map(|name| (name.to_string(), chosen_value(name), false))
            .chain([("openai_base_url".to_string(), chosen_value("lower"), false)])
            .chain([
                (
                    "APP_OPENAI_API_KEY".to_string(),
                    "inert-app-key".into(),
                    true,
                ),
                (
                    "DEPLOY_TOKEN".to_string(),
                    "inert-deploy-token".into(),
                    true,
                ),
                ("ID_PLAIN".to_string(), "inert-id-plain".into(), true),
            ]);
        for (index, (name, value, deliverable)) in stored.enumerate() {
            let secret_id = space.store_legacy(&name, &value).await?;
            if index % 2 == 0 {
                sql(
                    &space.pool,
                    "insert into project_secret_agent_handle_grants (secret_id, agent_handle)
                     values ($1, 'route-agent')",
                    &[&secret_id],
                )
                .await?;
            } else {
                sql(
                    &space.pool,
                    "insert into project_secret_agent_grants (secret_id, agent_id)
                     values ($1, $2)",
                    &[&secret_id, &agent_id],
                )
                .await?;
            }
            if deliverable {
                delivered.push((secret_id, name, value));
            } else {
                skipped.push((secret_id, name, value));
            }
        }
        // A route name is skipped before anything is decrypted, so a row no key opens does not
        // fail the job's other secrets, in a spelling the API never wrote either.
        let unreadable = space
            .store_sealed("codex-api-key", "AAAAAAAAAAAAAAAA", "AAAA")
            .await?;
        sql(
            &space.pool,
            "insert into project_secret_agent_handle_grants (secret_id, agent_handle)
             values ($1, 'route-agent')",
            &[&unreadable],
        )
        .await?;

        let mut config = test_config();
        config.credential_keys = Some(space.keys.clone());
        let token =
            crate::auth::issue_agent_token(&config, &space.project_id, &runtime_id, None, None)
                .map(|minted| minted.token)
                .map_err(|(status, error)| anyhow::anyhow!("{status}: {}", error.0.message))?;
        let app = super::router().with_state(build_test_state(space.pool.clone(), config));
        let (status, body) = request_secrets(&app, &token, json!({ "job_id": job_id })).await?;
        // The body carries secret values, so it is never printed.
        assert!(status == StatusCode::OK, "agent secrets answered {status}");

        let env = &body["env"];
        for (_, name, value) in &delivered {
            assert!(
                env[name.as_str()] == json!(value),
                "{name} was not delivered"
            );
        }
        for (_, name, value) in &skipped {
            assert!(env.get(name.as_str()).is_none(), "{name} was delivered");
            assert!(
                !body.to_string().contains(value.as_str()),
                "{name}'s value reached the job"
            );
        }
        for name in PROXY_ROUTE_ENV_KEYS {
            assert!(
                !env.as_object()
                    .is_some_and(|env| env.keys().any(|key| key.eq_ignore_ascii_case(name))),
                "a job got {name}"
            );
        }
        let mut inventory: Vec<&str> = body["inventory"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item["name"].as_str())
                    .collect()
            })
            .unwrap_or_default();
        inventory.sort_unstable();
        let mut expected: Vec<&str> = delivered.iter().map(|(_, name, _)| name.as_str()).collect();
        expected.sort_unstable();
        assert_eq!(inventory, expected);

        // Only what was delivered counts as used.
        for (secret_id, name, _) in delivered.iter().chain(skipped.iter()) {
            let used: Option<DateTime<Utc>> = sql_one(
                &space.pool,
                "select last_used_at from project_secrets where id = $1",
                &[secret_id],
            )
            .await?;
            let deliverable = delivered.iter().any(|(id, _, _)| id == secret_id);
            assert_eq!(used.is_some(), deliverable, "{name}");
        }

        // The listing keeps every secret, with no value and no Claude mark.
        let (status, listing) = call_router(
            &space.app,
            Some(&space.bearer),
            "GET",
            space.secrets_path(),
            None,
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{listing}");
        let listed: Vec<&str> = listing
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item["name"].as_str())
                    .collect()
            })
            .unwrap_or_default();
        for (_, name, _) in delivered.iter().chain(skipped.iter()) {
            assert!(listed.contains(&name.as_str()), "{name} is not listed");
        }
        assert_eq!(listed.len(), delivered.len() + skipped.len() + 1);
        for item in listing.as_array().into_iter().flatten() {
            assert!(item.get("value").is_none(), "{item}");
            assert!(item.get("refused").is_none(), "{item}");
        }
        let text = listing.to_string();
        for (_, name, value) in delivered.iter().chain(skipped.iter()) {
            assert!(
                !text.contains(value.as_str()),
                "the listing returned {name}'s value"
            );
        }
        Ok(())
    })
    .await
}
