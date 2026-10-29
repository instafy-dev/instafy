//! Database tests for the Credits panel's ledger (crate::credits
//! `credit_ledger`): the rows of an Instafy AI turn name the chat it was sent
//! in, for a viewer who may open that chat, so the panel can show one row per
//! turn as the person knows it. They run against the migrated test database
//! (`pnpm test:controller`).

use super::*;
use axum::body::{to_bytes, Body};
use axum::http::Request;
use tower::ServiceExt;

struct Ledger {
    state: AppState,
    config: AppConfig,
    project_id: Uuid,
}

impl Ledger {
    /// The chat names the ledger gives `user`, by turn (`promptId`), and the
    /// rows that name none.
    async fn chat_names(&self, user: &Uuid) -> anyhow::Result<Vec<(String, Option<String>)>> {
        let token = crate::auth::issue_controller_token(&self.config, user)
            .map(|issued| issued.token)
            .map_err(|(_, error)| anyhow::anyhow!(error.0.message))?;
        let response = crate::credits::router()
            .with_state(self.state.clone())
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri(format!(
                        "/credits/ledger?projectId={}&limit=100",
                        self.project_id
                    ))
                    .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await?)?;
        let mut names: Vec<(String, Option<String>)> = body["entries"]
            .as_array()
            .context("entries")?
            .iter()
            .map(|entry| {
                let turn = entry["metadata"]["promptId"]
                    .as_str()
                    .map(|prompt| format!("{}:{prompt}", entry["reason"].as_str().unwrap_or("")))
                    .unwrap_or_else(|| entry["reason"].as_str().unwrap_or("").to_string());
                (turn, entry["chatName"].as_str().map(str::to_string))
            })
            .collect();
        names.sort();
        Ok(names)
    }
}

/// Local drive 4: each turn was two rows, "AI usage" and "AI adjustment", and
/// no row named the chat. Now each Instafy AI turn's rows name its chat, by
/// Home's rule: only a chat the viewer may open. A teammate's private chat,
/// or a chat in a space the viewer is not in, stays unnamed; so does every
/// row that is not a turn's.
#[tokio::test]
async fn a_turns_rows_name_its_chat_for_whoever_may_open_it() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("credit ledger chat names").await?;
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "credit-ledger-chat-names",
    );
    let org_id = Uuid::new_v4();
    let other_project = Uuid::new_v4();
    let (owner, teammate, guest) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
    let ledger = Ledger {
        state: build_test_state(pool.clone(), config.clone()),
        config,
        project_id: Uuid::new_v4(),
    };
    for user in [&owner, &teammate, &guest] {
        ensure_test_user(&pool, user).await?;
    }
    let result = with_shared_db_fixture(
        SharedDbFixture {
            organizations: vec![org_id],
            projects: vec![ledger.project_id, other_project],
        },
        async {
            seed_group_participation_project(
                &pool,
                &org_id,
                &ledger.project_id,
                &owner,
                &teammate,
                "credit-ledger-chat-names",
            )
            .await?;
            let connection = pool.get().await?;
            // Another space of the team, and a guest of the first space only.
            connection
                .execute(
                    "insert into projects (id, org_id, name, owner_user_id, project_type, status)
                     values ($1, $2, 'Second space', $3, 'customer', 'active')",
                    &[&other_project, &org_id, &owner],
                )
                .await?;
            connection
                .execute(
                    "insert into project_memberships (project_id, user_id, role)
                     values ($1, $2, 'viewer')",
                    &[&ledger.project_id, &guest],
                )
                .await?;
            let mut turns = Vec::new();
            for (project, author, visibility, title) in [
                (ledger.project_id, owner, "public", "Plan 3 days in Lisbon"),
                (ledger.project_id, teammate, "private", "A teammate's private plan"),
                (other_project, owner, "public", "Budget for next year"),
                (ledger.project_id, owner, "public", " "),
            ] {
                let (chat, prompt) = (Uuid::new_v4(), Uuid::new_v4());
                connection
                    .execute(
                        "insert into conversations (id, project_id, created_by, visibility, metadata)
                         values ($1, $2, $3, $4, $5)",
                        &[&chat, &project, &author, &visibility, &PgJson(json!({ "title": title }))],
                    )
                    .await?;
                connection
                    .execute(
                        "insert into prompts (id, project_id, conversation_id, user_id, prompt_text)
                         values ($1, $2, $3, $4, 'A request')",
                        &[&prompt, &project, &chat, &author],
                    )
                    .await?;
                turns.push((project, prompt));
            }
            connection
                .execute(
                    "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                     values ($1, $2, 100, 'test_seed', '{}'::jsonb),
                            ($1, $2, 1, 'auto_refill_daily', '{\"creditLimit\": 800}'::jsonb)",
                    &[&org_id, &ledger.project_id],
                )
                .await?;
            for (index, (project, prompt)) in turns.iter().enumerate() {
                let metadata = PgJson(json!({ "promptId": prompt, "managedAiLabel": "Instafy AI" }));
                connection
                    .execute(
                        "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                         values ($1, $2, -1, 'managed_ai_prompt', $3)",
                        &[&org_id, project, &metadata],
                    )
                    .await?;
                if index == 0 {
                    connection
                        .execute(
                            "insert into org_credit_ledger (org_id, project_id, delta, reason, metadata)
                             values ($1, $2, -13, 'managed_ai_adjustment', $3)",
                            &[&org_id, project, &metadata],
                        )
                        .await?;
                }
            }
            drop(connection);
            let turn = |reason: &str, index: usize| format!("{reason}:{}", turns[index].1);
            let lisbon = Some("Plan 3 days in Lisbon".to_string());
            let private = Some("A teammate's private plan".to_string());
            let budget = Some("Budget for next year".to_string());
            let expect = |names: [Option<String>; 3]| {
                let mut rows = vec![
                    ("auto_refill_daily".to_string(), None),
                    (turn("managed_ai_adjustment", 0), lisbon.clone()),
                    (turn("managed_ai_prompt", 0), lisbon.clone()),
                    (turn("managed_ai_prompt", 1), names[0].clone()),
                    (turn("managed_ai_prompt", 2), names[1].clone()),
                    // An untitled chat has no name to give.
                    (turn("managed_ai_prompt", 3), names[2].clone()),
                    ("test_seed".to_string(), None),
                ];
                rows.sort();
                rows
            };
            assert_eq!(
                ledger.chat_names(&owner).await?,
                expect([None, budget.clone(), None])
            );
            assert_eq!(
                ledger.chat_names(&teammate).await?,
                expect([private.clone(), budget.clone(), None])
            );
            assert_eq!(ledger.chat_names(&guest).await?, expect([None, None, None]));
            Ok(())
        },
    )
    .await;
    for user in [&owner, &teammate, &guest] {
        cleanup_test_user(&pool, user).await?;
    }
    result
}
