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
use crate::site_intent::{
    charge_site_ask, verified_site_intent, SITE_ASKS_PER_WINDOW, SITE_INTENT_REFUSED,
};

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

            let verified = verified_site_intent(
                &f.state,
                &f.project,
                &owner,
                &claim(&preview_id, "int_a_0001"),
            )
            .await
            .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?
            .context("the owner's ask from an open preview is kept")?;
            charge_site_ask(&f.state, &verified)
                .await
                .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?;
            let kept = verified.json;
            assert_eq!(kept["previewId"], json!(preview_id));
            assert_eq!(kept["askId"], json!("int_a_0001"));
            assert_eq!(kept["intent"], json!("check_size"));
            assert_eq!(
                kept["params"],
                json!({ "ref": "shoes:karhu-ikoni-3", "size": "10" })
            );
            // The site is named by the grant, never by the page.
            assert_eq!(
                kept["site"],
                json!({ "title": "Site preview", "port": 4173 })
            );
            assert_eq!(kept["verified"], json!(true));

            let check = |context: RequestContext, project: Uuid, value: Value| {
                let f = f.clone();
                async move {
                    verified_site_intent(&f.state, &project, &context, &value)
                        .await
                        .map(|verified| verified.map(|verified| verified.json))
                        .map_err(|(_, e)| anyhow::anyhow!(e.0.message))
                }
            };
            assert_eq!(
                check(
                    person(f.users[3]),
                    f.project,
                    claim(&preview_id, "int_a_0002")
                )
                .await?,
                None,
                "an outsider"
            );
            assert_eq!(
                check(
                    person(f.users[0]),
                    f.project,
                    claim(&Uuid::new_v4().to_string(), "int_a_0003")
                )
                .await?,
                None,
                "no such preview"
            );
            assert_eq!(
                check(
                    person(f.users[0]),
                    Uuid::new_v4(),
                    claim(&preview_id, "int_a_0004")
                )
                .await?,
                None,
                "another space"
            );
            let anonymous = RequestContext {
                user_id: None,
                is_service_role: true,
                scoped_claims: None,
            };
            assert_eq!(
                check(anonymous, f.project, claim(&preview_id, "int_a_0005")).await?,
                None,
                "nobody to have clicked"
            );
            let mut malformed = claim(&preview_id, "int_a_0006");
            malformed["params"] = json!("size=10");
            assert_eq!(
                check(person(f.users[0]), f.project, malformed).await?,
                None,
                "malformed"
            );

            // Six asks per person and site in ten minutes (one already counted above).
            let ask = |user: Uuid, ask_id: String| {
                let f = f.clone();
                let preview_id = preview_id.clone();
                async move {
                    let verified = verified_site_intent(
                        &f.state,
                        &f.project,
                        &person(user),
                        &claim(&preview_id, &ask_id),
                    )
                    .await?
                    .ok_or_else(|| crate::bad_request("not verified"))?;
                    charge_site_ask(&f.state, &verified).await
                }
            };
            for index in 1..SITE_ASKS_PER_WINDOW {
                ask(f.users[0], format!("int_b_{index:04}"))
                    .await
                    .map_err(|(_, e)| anyhow::anyhow!(e.0.message))
                    .context("within the cap")?;
            }
            let refused = ask(f.users[0], "int_c_0001".to_string())
                .await
                .err()
                .context("the seventh ask in ten minutes is refused")?;
            assert_eq!(refused.0, StatusCode::TOO_MANY_REQUESTS);
            assert!(
                refused
                    .1
                     .0
                    .message
                    .starts_with("You asked from this site 6 times in 10 minutes."),
                "{}",
                refused.1 .0.message
            );
            // Another person is not held up by it.
            ask(f.users[1], "int_c_0002".to_string())
                .await
                .map_err(|(_, e)| anyhow::anyhow!(e.0.message))
                .context("the builder's own cap")?;

            // A closed preview takes no more asks.
            let (status, body) = f
                .request(
                    &f.tokens[0],
                    "POST",
                    &f.path(&format!("/{preview_id}/close")),
                    json!({}),
                )
                .await?;
            assert!(status.is_success(), "{status} {body}");
            assert_eq!(
                check(
                    person(f.users[0]),
                    f.project,
                    claim(&preview_id, "int_d_0001")
                )
                .await?,
                None,
                "closed"
            );
            Ok(())
        })
    })
    .await
}

fn ask_request(
    f: &Fixture,
    metadata: Value,
) -> anyhow::Result<crate::dispatch::DispatchPromptNormalized> {
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
async fn a_dispatched_ask_keeps_the_checked_site_intent_and_refuses_a_forged_one(
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

            // The message's copy, which everyone in the conversation reads, leaves out a rounded position.
            let mut located = claim(&preview_id, "int_e_0003");
            located["params"]["near"] = json!("52.370, 4.895");
            located["coarsened"] = json!(["near"]);
            let response = process_dispatch_prompt(
                &f.state,
                &owner,
                ask_request(&f, json!({
                    "clientMessageId": Uuid::new_v4().to_string(),
                    "agentSelection": agent,
                    "siteIntent": located,
                }))?,
            )
            .await
            .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?;
            let run_id = response.run_id.context("a run")?;
            let (message, run_metadata) = message_and_run_metadata(&f, run_id).await?;
            assert_eq!(run_metadata["siteIntent"]["params"]["near"], json!("52.370, 4.895"));
            for metadata in [&message, &message["prompt_metadata"]] {
                assert!(metadata["siteIntent"]["params"].get("near").is_none(), "{metadata}");
                assert_eq!(metadata["siteIntent"]["params"]["size"], json!("10"));
            }

            // A message that names a preview this space does not have is refused, not sent without its site.
            let before = runs_in(&f).await?;
            let refused = process_dispatch_prompt(
                &f.state,
                &owner,
                ask_request(&f, json!({
                    "clientMessageId": Uuid::new_v4().to_string(),
                    "agentSelection": agent,
                    "siteIntent": claim(&Uuid::new_v4().to_string(), "int_e_0002"),
                }))?,
            )
            .await
            .err()
            .context("a forged site intent is refused")?;
            assert_eq!(refused.0, StatusCode::BAD_REQUEST);
            assert_eq!(refused.1 .0.message, SITE_INTENT_REFUSED);
            assert_eq!(runs_in(&f).await?, before, "nothing was dispatched");
            Ok(())
        })
    })
    .await
}

async fn runs_in(f: &Fixture) -> anyhow::Result<i64> {
    Ok(f.state
        .pool
        .get()
        .await?
        .query_one(
            "select count(*) from runs where project_id = $1",
            &[&f.project],
        )
        .await?
        .get(0))
}

#[tokio::test]
async fn a_queued_ask_is_checked_and_counted_when_it_is_queued() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let preview_id = f.open(&job).await?;
            let owner = person(f.users[0]);
            let queued = |ask_id: String, preview: String| {
                let f = f.clone();
                let owner = owner.clone();
                async move {
                    crate::send_queue::enqueue_prompt_with_context(
                        &f.state,
                        &owner,
                        f.conversation,
                        &format!("send-{ask_id}"),
                        json!({
                            "promptText": "Is size 10 in stock for Karhu ikoni 3? · via Site preview",
                            "metadata": {
                                "agentSelection": { "active": ["octo"], "mentions": ["octo"] },
                                "siteIntent": claim(&preview, &ask_id),
                            },
                        }),
                    )
                    .await
                }
            };
            let first = queued("int_q_0000".to_string(), preview_id.clone())
                .await
                .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?;
            // Only the checked copy is stored.
            let stored: Value = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select request from conversation_send_queue where id = $1",
                    &[&Uuid::parse_str(first.entry["id"].as_str().context("entry id")?)?],
                )
                .await?
                .get::<_, PgJson<Value>>(0)
                .0;
            assert_eq!(stored["metadata"]["siteIntent"]["verified"], json!(true), "{stored}");
            assert_eq!(stored["metadata"]["siteIntent"]["site"]["port"], json!(4173));
            // A retry of the same entry is not a second ask.
            let retry = queued("int_q_0000".to_string(), preview_id.clone())
                .await
                .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?;
            assert!(retry.deduplicated);
            for index in 1..SITE_ASKS_PER_WINDOW {
                queued(format!("int_q_{index:04}"), preview_id.clone())
                    .await
                    .map_err(|(_, e)| anyhow::anyhow!(e.0.message))
                    .context("within the cap")?;
            }
            let refused = queued("int_q_0099".to_string(), preview_id.clone())
                .await
                .err()
                .context("the seventh queued ask in ten minutes is refused")?;
            assert_eq!(refused.0, StatusCode::TOO_MANY_REQUESTS);
            // A forged one is refused before it is queued.
            let forged = queued("int_q_0100".to_string(), Uuid::new_v4().to_string())
                .await
                .err()
                .context("a forged queued ask is refused")?;
            assert_eq!(forged.0, StatusCode::BAD_REQUEST);
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
            assert!(
                status.is_success(),
                "{status} {}",
                String::from_utf8_lossy(&bytes)
            );
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
            assert!(
                stored["prompt_metadata"].get("site_intent").is_none(),
                "{stored}"
            );
            Ok(())
        })
    })
    .await
}
