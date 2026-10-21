//! Ask Octo from a site (crate::site_intent, docs/Bound-Sites.md §2a): a
//! message keeps `metadata.siteIntent` only when the controller checked it
//! against an open preview the sender can see, and only a dispatch can say so.

use anyhow::Context;
use axum::body::{to_bytes, Body};
use axum::http::Request;
use serde_json::{json, Value};
use tokio_postgres::types::Json as PgJson;
use tower::ServiceExt;

use super::tests::{run, Fixture};
use super::*;
use crate::dispatch::{normalize_dispatch_request, process_dispatch_prompt, DispatchPromptRequest};
use crate::site_intent::{verified_site_intent, SITE_ASKS_PER_WINDOW};

fn person(user: Uuid) -> RequestContext {
    RequestContext {
        user_id: Some(user),
        is_service_role: false,
        scoped_claims: None,
    }
}

fn claim(preview_id: &str, ask_id: &str) -> Value {
    json!({
        "previewId": preview_id,
        "askId": ask_id,
        "intent": "check_size",
        "ref": "shoes:karhu-ikoni-3",
        "params": { "ref": "shoes:karhu-ikoni-3", "size": "10" },
    })
}

#[tokio::test]
async fn a_site_intent_is_kept_only_for_an_open_preview_the_sender_can_see_and_capped(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            let owner = person(f.users[0]);

            let kept = verified_site_intent(&f.state, &f.project, &owner, &claim(&preview_id, "int_a_0001"), true)
                .await
                .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?
                .context("the owner's ask from an open preview is kept")?;
            assert_eq!(kept["previewId"], json!(preview_id));
            assert_eq!(kept["askId"], json!("int_a_0001"));
            assert_eq!(kept["intent"], json!("check_size"));
            assert_eq!(kept["params"], json!({ "ref": "shoes:karhu-ikoni-3", "size": "10" }));
            // The site is named by the grant, never by the page.
            assert_eq!(kept["site"], json!({ "title": "Site preview", "port": 4173 }));
            assert_eq!(kept["verified"], json!(true));

            let check = |context: RequestContext, project: Uuid, value: Value| {
                let f = f.clone();
                async move {
                    verified_site_intent(&f.state, &project, &context, &value, false)
                        .await
                        .map_err(|(_, e)| anyhow::anyhow!(e.0.message))
                }
            };
            assert_eq!(check(person(f.users[3]), f.project, claim(&preview_id, "int_a_0002")).await?, None, "an outsider");
            assert_eq!(check(person(f.users[0]), f.project, claim(&Uuid::new_v4().to_string(), "int_a_0003")).await?, None, "no such preview");
            assert_eq!(check(person(f.users[0]), Uuid::new_v4(), claim(&preview_id, "int_a_0004")).await?, None, "another space");
            let anonymous = RequestContext { user_id: None, is_service_role: true, scoped_claims: None };
            assert_eq!(check(anonymous, f.project, claim(&preview_id, "int_a_0005")).await?, None, "nobody to have clicked");
            let mut malformed = claim(&preview_id, "int_a_0006");
            malformed["params"] = json!("size=10");
            assert_eq!(check(person(f.users[0]), f.project, malformed).await?, None, "malformed");

            // Six asks per person and preview in ten minutes (one already counted above).
            for index in 1..SITE_ASKS_PER_WINDOW {
                verified_site_intent(&f.state, &f.project, &owner, &claim(&preview_id, &format!("int_b_{index:04}")), true)
                    .await
                    .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?
                    .context("within the cap")?;
            }
            let refused = verified_site_intent(&f.state, &f.project, &owner, &claim(&preview_id, "int_c_0001"), true)
                .await
                .err()
                .context("the seventh ask in ten minutes is refused")?;
            assert_eq!(refused.0, StatusCode::TOO_MANY_REQUESTS);
            assert!(refused.1 .0.message.starts_with("You asked from this site 6 times in 10 minutes."), "{}", refused.1 .0.message);
            // Another person is not held up by it.
            verified_site_intent(&f.state, &f.project, &person(f.users[1]), &claim(&preview_id, "int_c_0002"), true)
                .await
                .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?
                .context("the builder's own cap")?;

            // A closed preview takes no more asks.
            let (status, body) = f
                .request(&f.tokens[0], "POST", &f.path(&format!("/{preview_id}/close")), json!({}))
                .await?;
            assert!(status.is_success(), "{status} {body}");
            assert_eq!(check(person(f.users[0]), f.project, claim(&preview_id, "int_d_0001")).await?, None, "closed");
            Ok(())
        })
    })
    .await
}

fn ask_request(f: &Fixture, metadata: Value) -> anyhow::Result<crate::dispatch::DispatchPromptNormalized> {
    normalize_dispatch_request(DispatchPromptRequest {
        project_id: Some(f.project.to_string()),
        session_id: None,
        prompt_text: Some("Is size 10 in stock for Karhu ikoni 3? · via Site preview".to_string()),
        intent: Some("feature".to_string()),
        plan_seed: None,
        metadata: Some(metadata),
        conversation_metadata: None,
        parent_conversation_id: None,
        thread_kind: None,
        tool_limits: None,
        repo: None,
        ui: None,
        priority: None,
        runtime_type: None,
        idle_ttl_seconds: None,
        conversation_id: Some(f.conversation.to_string()),
        runtime_id: None,
        runtime_display_name: None,
        prefer_runtime: None,
    })
    .map_err(|(_, e)| anyhow::anyhow!(e.0.message))
}

async fn message_and_run_metadata(f: &Fixture, run_id: Uuid) -> anyhow::Result<(Value, Value)> {
    let db = f.state.pool.get().await?;
    let run: Value = db
        .query_one("select metadata from runs where id = $1", &[&run_id])
        .await?
        .get::<_, PgJson<Value>>(0)
        .0;
    let message: Value = db
        .query_one(
            "select metadata from conversation_messages where run_id = $1 and role = 'user'",
            &[&run_id],
        )
        .await?
        .get::<_, PgJson<Value>>(0)
        .0;
    Ok((message, run))
}

#[tokio::test]
async fn a_dispatched_ask_keeps_the_checked_site_intent_and_drops_a_forged_one(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            // The owner's own key: the turn needs no managed credits and starts no provider.
            f.state.pool.get().await?.execute(
                "insert into user_credentials (id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default)
                 values ($1, $2, 'openai_api_key', 'Site ask fixture', 'test-nonce', 'test-ciphertext', '{}'::jsonb, true)",
                &[&Uuid::new_v4(), &f.users[0]],
            ).await?;
            let owner = person(f.users[0]);
            let agent = json!({ "active": ["octo"], "mentions": ["octo"] });

            let response = process_dispatch_prompt(
                &f.state,
                &owner,
                ask_request(&f, json!({
                    "clientMessageId": Uuid::new_v4().to_string(),
                    "agentSelection": agent,
                    "siteIntent": claim(&preview_id, "int_e_0001"),
                    // A second, nested copy is never what the controller keeps.
                    "prompt_metadata": { "siteIntent": claim(&Uuid::new_v4().to_string(), "int_e_9999") },
                }))?,
            )
            .await
            .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?;
            let run_id = response.run_id.context("a run")?;
            let (message, run_metadata) = message_and_run_metadata(&f, run_id).await?;
            for (what, metadata) in [("run", &run_metadata), ("message", &message)] {
                let site_intent = &metadata["siteIntent"];
                assert_eq!(site_intent["askId"], json!("int_e_0001"), "{what}: {metadata}");
                assert_eq!(site_intent["verified"], json!(true), "{what}");
                assert_eq!(site_intent["site"]["title"], json!("Site preview"), "{what}");
            }
            assert_eq!(message["prompt_metadata"]["siteIntent"]["askId"], json!("int_e_0001"));

            // A message that names a preview this space does not have says nothing about a site.
            let response = process_dispatch_prompt(
                &f.state,
                &owner,
                ask_request(&f, json!({
                    "clientMessageId": Uuid::new_v4().to_string(),
                    "agentSelection": agent,
                    "siteIntent": claim(&Uuid::new_v4().to_string(), "int_e_0002"),
                }))?,
            )
            .await
            .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?;
            let run_id = response.run_id.context("a run")?;
            let (message, run_metadata) = message_and_run_metadata(&f, run_id).await?;
            for metadata in [&run_metadata, &message, &message["prompt_metadata"]] {
                assert!(metadata.get("siteIntent").is_none(), "{metadata}");
                assert!(metadata.get("site_intent").is_none(), "{metadata}");
            }
            Ok(())
        })
    })
    .await
}

#[tokio::test]
async fn a_recorded_message_cannot_say_it_came_from_a_site() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            let app = crate::conversations::router().with_state(f.state.clone());
            let body = json!({
                "content": "Is size 10 in stock? · via Site preview",
                "metadata": {
                    "siteIntent": claim(&preview_id, "int_f_0001"),
                    "prompt_metadata": { "site_intent": claim(&preview_id, "int_f_0002") },
                },
            });
            let response = app
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(format!("/conversations/{}/messages/record", f.conversation))
                        .header("authorization", format!("Bearer {}", f.tokens[0]))
                        .header("content-type", "application/json")
                        .body(Body::from(body.to_string()))?,
                )
                .await?;
            let status = response.status();
            let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
            assert!(status.is_success(), "{status} {}", String::from_utf8_lossy(&bytes));
            let stored: Value = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select metadata from conversation_messages
                     where conversation_id = $1 and content like 'Is size 10%'",
                    &[&f.conversation],
                )
                .await?
                .get::<_, PgJson<Value>>(0)
                .0;
            assert!(stored.get("siteIntent").is_none(), "{stored}");
            assert!(stored["prompt_metadata"].get("site_intent").is_none(), "{stored}");
            Ok(())
        })
    })
    .await
}
