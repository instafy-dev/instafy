//! Database tests for steering an active browser turn. They run against the
//! migrated test database (`pnpm test:controller`), never a hand-written
//! schema, so the `prompts` join and the access checks are the real ones.

use super::*;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key, with_shared_db_fixture, SharedDbFixture,
};
use axum::body::{to_bytes, Body};
use axum::http::Request;
use tower::ServiceExt;

struct Fixture {
    state: AppState,
    app: Router,
    project: Uuid,
    conversation: Uuid,
    runtime: Uuid,
    owner: Uuid,
    owner_token: String,
    teammate: Uuid,
    teammate_token: String,
}

impl Fixture {
    /// Ids, tokens and state only. The rows are written by [`Fixture::run`],
    /// inside the guarded body, so a failed insert cannot leak them.
    async fn new() -> anyhow::Result<Self> {
        let pool = require_origin_test_pool("browser turn steer").await?;
        let owner = Uuid::new_v4();
        let teammate = Uuid::new_v4();
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "browser-turn-steer",
        );
        let token = |user: &Uuid| {
            crate::auth::issue_controller_token(&config, user)
                .map(|issued| issued.token)
                .map_err(|(_, error)| anyhow::anyhow!(error.0.message))
        };
        let owner_token = token(&owner)?;
        let teammate_token = token(&teammate)?;
        let state = build_test_state(pool, config);
        let app = router().with_state(state.clone());
        Ok(Self {
            state,
            app,
            project: Uuid::new_v4(),
            conversation: Uuid::new_v4(),
            runtime: Uuid::new_v4(),
            owner,
            owner_token,
            teammate,
            teammate_token,
        })
    }

    /// Seed the space, run `body`, then delete the space and both test users
    /// however `body` ends.
    async fn run(
        &self,
        body: impl std::future::Future<Output = anyhow::Result<()>>,
    ) -> anyhow::Result<()> {
        use futures_util::FutureExt;

        let outcome = std::panic::AssertUnwindSafe(with_shared_db_fixture(
            SharedDbFixture {
                projects: vec![self.project],
                ..SharedDbFixture::default()
            },
            async {
                self.seed().await?;
                body.await
            },
        ))
        .catch_unwind()
        .await;
        let users = self.delete_users().await;
        match outcome {
            Ok(result) => result.and(users),
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    async fn seed(&self) -> anyhow::Result<()> {
        ensure_test_user(&self.state.pool, &self.owner).await?;
        ensure_test_user(&self.state.pool, &self.teammate).await?;
        let db = self.state.pool.get().await?;
        db.execute(
            "insert into projects(id,owner_user_id,name,project_type,status)
             values($1,$2,'Browser steer fixture','customer','active')",
            &[&self.project, &self.owner],
        )
        .await?;
        db.execute(
            "insert into project_memberships(project_id,user_id,role) values($1,$2,'builder')",
            &[&self.project, &self.teammate],
        )
        .await?;
        db.execute(
            "insert into conversations(id,project_id,created_by,visibility,metadata,root_conversation_id)
             values($1,$2,$3,'public','{}'::jsonb,$1)",
            &[&self.conversation, &self.project, &self.owner],
        )
        .await?;
        db.execute(
            "insert into runtimes(id,project_id,provider,status,capabilities)
             values($1,$2,'default','ready',$3)",
            &[
                &self.runtime,
                &self.project,
                &PgJson(json!({ "activeTurnInput": true })),
            ],
        )
        .await?;
        Ok(())
    }

    async fn delete_users(&self) -> anyhow::Result<()> {
        self.state
            .pool
            .get()
            .await?
            .execute(
                "delete from auth.users where id = any($1)",
                &[&vec![self.owner, self.teammate]],
            )
            .await?;
        Ok(())
    }

    /// One active, input-ready job whose prompt was written by `author`.
    async fn active_job(&self, author: Option<Uuid>, metadata: JsonValue) -> anyhow::Result<Uuid> {
        let prompt = Uuid::new_v4();
        let run = Uuid::new_v4();
        let job = Uuid::new_v4();
        let db = self.state.pool.get().await?;
        db.execute(
            "insert into prompts(id,project_id,conversation_id,user_id,prompt_text,metadata)
             values($1,$2,$3,$4,'Open the dashboard',$5)",
            &[
                &prompt,
                &self.project,
                &self.conversation,
                &author,
                &PgJson(&metadata),
            ],
        )
        .await?;
        db.execute(
            "insert into runs(id,project_id,conversation_id,run_type,status)
             values($1,$2,$3,'prompt','in_progress')",
            &[&run, &self.project, &self.conversation],
        )
        .await?;
        db.execute(
            "insert into agent_jobs(
                 id,project_id,run_id,prompt_id,conversation_id,status,payload,
                 leased_by_runtime_id,leased_at,lease_expires_at,
                 active_input_ready_runtime_id,active_input_ready_expires_at,
                 active_input_ready_turn_id
             ) values(
                 $1,$2,$3,$4,$5,'leased',$6,
                 $7,now(),now()+interval '5 minutes',
                 $7,now()+interval '5 minutes','turn-1'
             )",
            &[
                &job,
                &self.project,
                &run,
                &prompt,
                &self.conversation,
                // Client metadata may name anyone; the prompt row is the authority.
                &PgJson(json!({
                    "user_id": self.teammate,
                    "metadata": metadata,
                })),
                &self.runtime,
            ],
        )
        .await?;
        Ok(job)
    }

    async fn finish_job(&self, job: Uuid) -> anyhow::Result<()> {
        self.state
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs set status='completed', completed_at=now() where id=$1",
                &[&job],
            )
            .await?;
        Ok(())
    }

    async fn steer(&self, token: &str, job: Uuid) -> anyhow::Result<(StatusCode, JsonValue)> {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/conversations/{}/send-intents", self.conversation))
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "clientSendId": Uuid::new_v4().to_string(),
                            "mode": "steer",
                            "request": { "promptText": "Also open the settings page" },
                            "expectedActiveJobId": job,
                        })
                        .to_string(),
                    ))?,
            )
            .await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
        Ok((status, serde_json::from_slice(&bytes)?))
    }

    async fn job_input_count(&self, job: Uuid) -> anyhow::Result<i64> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select count(*) from agent_job_inputs where job_id=$1",
                &[&job],
            )
            .await?
            .get(0))
    }

    /// Transcript messages and participant rows `user` has in the conversation.
    async fn transcript_rows_by(&self, user: Uuid) -> anyhow::Result<(i64, i64)> {
        let row = self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select
                     (select count(*) from conversation_messages
                      where conversation_id = $1 and created_by = $2),
                     (select count(*) from conversation_participants
                      where conversation_id = $1 and user_id = $2)",
                &[&self.conversation, &user],
            )
            .await?;
        Ok((row.get(0), row.get(1)))
    }
}

#[tokio::test]
async fn only_the_prompt_author_can_steer_an_active_browser_turn() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        for transport in ["desktop-personal", "shared"] {
            let job = f
                .active_job(
                    Some(f.owner),
                    json!({ "browserTransport": transport, "userId": f.teammate }),
                )
                .await?;

            let (status, body) = f.steer(&f.teammate_token, job).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{transport}: {body}");
            assert_eq!(body["code"], json!("browser_turn_steer_forbidden"));
            assert_eq!(f.job_input_count(job).await?, 0, "{transport}");
            assert_eq!(
                f.transcript_rows_by(f.teammate).await?,
                (0, 0),
                "{transport}: a refused steer stores no message or participant"
            );

            let (status, body) = f.steer(&f.owner_token, job).await?;
            assert_eq!(status, StatusCode::OK, "{transport}: {body}");
            assert_eq!(body["appliedMode"], json!("steer"));
            assert_eq!(f.job_input_count(job).await?, 1, "{transport}");

            f.finish_job(job).await?;
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn a_browser_turn_without_a_recorded_author_cannot_be_steered() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        let job = f
            .active_job(
                None,
                json!({ "browserTransport": "desktop-personal", "userId": f.owner }),
            )
            .await?;
        for token in [&f.owner_token, &f.teammate_token] {
            let (status, body) = f.steer(token, job).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            assert_eq!(body["code"], json!("browser_turn_steer_forbidden"));
        }
        assert_eq!(f.job_input_count(job).await?, 0);
        assert_eq!(f.transcript_rows_by(f.teammate).await?.0, 0);
        assert_eq!(f.transcript_rows_by(f.owner).await?.0, 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn teammates_can_still_steer_an_ordinary_turn() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    f.run(async {
        let job = f.active_job(Some(f.owner), json!({})).await?;
        let (status, body) = f.steer(&f.teammate_token, job).await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(f.job_input_count(job).await?, 1);
        assert_eq!(f.transcript_rows_by(f.teammate).await?, (1, 1));
        Ok(())
    })
    .await
}
