use anyhow::Context;
use serde_json::{json, Value};
use tokio_postgres::types::Json as PgJson;

use super::pages::{add_space_pages, space_pages_for, LeasedPages, SPACE_PAGES_PAYLOAD_KEY};
use super::tests::{run, Fixture, Job};
use super::*;

const FOLDER: &str = "sites/framework-laptops";

impl Fixture {
    /// Opens the page in `folder` on `job`'s runtime with its card going to `conversation`, as
    /// the runtime's own token for the space's owner does, saying `page_folder` of the folder
    /// when given, and posts the card: the `page` of the card's answer.
    async fn open_page(
        &self,
        job: &Job,
        conversation: Uuid,
        folder: &str,
        port: i64,
        page_folder: Option<&str>,
    ) -> anyhow::Result<Value> {
        let token = self.machine_token(job, self.users[0])?;
        let mut body = self.open_body(job, port);
        body["conversationId"] = json!(conversation);
        body["title"] = json!("Framework laptops");
        body["serve"] = json!({
            "argv": ["/usr/local/bin/instafy", "bind", "serve", ".", "--port", port.to_string(), "--preview"],
            "cwd": folder,
        });
        if let Some(page_folder) = page_folder {
            body["pageFolder"] = json!(page_folder);
        }
        let (status, created) = self.request(&token, "POST", &self.path(""), body).await?;
        assert_eq!(status, StatusCode::CREATED, "{created}");
        let preview_id = created["previewId"].as_str().context("previewId")?;
        Ok(self.ready(&token, preview_id).await?["page"].clone())
    }

    /// The chat the record holds for `folder`: `Some(None)` for a row with no chat, None for no
    /// row.
    async fn page_chat(&self, folder: &str) -> anyhow::Result<Option<Option<Uuid>>> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_opt(
                "select conversation_id from space_pages where project_id = $1 and folder = $2",
                &[&self.project, &folder],
            )
            .await?
            .map(|row| row.get(0)))
    }

    async fn page_rows(&self) -> anyhow::Result<i64> {
        Ok(self
            .state
            .pool
            .get()
            .await?
            .query_one(
                "select count(*) from space_pages where project_id = $1",
                &[&self.project],
            )
            .await?
            .get(0))
    }

    /// The pages a job leased for `user` is given, by folder.
    async fn leased_pages(&self, user: usize) -> anyhow::Result<Vec<Value>> {
        let db = self.state.pool.get().await?;
        let pages = space_pages_for(&db, &self.project, Some(&self.users[user])).await?;
        Ok(pages["pages"].as_array().cloned().unwrap_or_default())
    }
}

fn chat_of<'a>(pages: &'a [Value], folder: &str) -> Option<&'a Value> {
    pages
        .iter()
        .find(|page| page["folder"] == json!(folder))
        .map(|page| &page["conversationId"])
}

/// The chat a page's first card went to made it, and the record keeps that chat when another
/// chat's card opens the same folder later, on another machine: the space's own file is gone
/// there, and the controller's row is what says who made the page.
#[tokio::test]
async fn the_first_card_gives_a_page_to_its_chat_and_a_later_card_from_another_chat_keeps_it(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let maker = f.conversation;
            let other = f.conversation("public").await?;
            let job = f.job(None).await?;
            let page = f.open_page(&job, maker, FOLDER, 4173, Some("new")).await?;
            assert_eq!(page, json!({ "folder": FOLDER, "conversationId": maker }));

            // a release later: another machine, and another chat opens the folder's card. It
            // says the folder was there before its turn; an older CLI says nothing. Neither
            // takes the page.
            let later = f.job(None).await?;
            let page = f
                .open_page(&later, other, FOLDER, 4173, Some("existing"))
                .await?;
            assert_eq!(page, json!({ "folder": FOLDER, "conversationId": maker }));
            let page = f.open_page(&later, other, FOLDER, 4174, None).await?;
            assert_eq!(page["conversationId"], json!(maker));
            assert_eq!(f.page_chat(FOLDER).await?, Some(Some(maker)));
            assert_eq!(f.page_rows().await?, 1);

            // the row keeps how the page is served and its latest title
            let row = f
                .state
                .pool
                .get()
                .await?
                .query_one(
                    "select title, server from space_pages where project_id = $1 and folder = $2",
                    &[&f.project, &FOLDER],
                )
                .await?;
            assert_eq!(row.get::<_, String>("title"), "Framework laptops");
            assert_eq!(
                row.get::<_, PgJson<Value>>("server").0,
                json!(["instafy", "bind"])
            );
            Ok(())
        })
    })
    .await
}

/// A folder that was there before the opening turn began, and that the record does not hold, is
/// given to no chat, and no later open claims it: nothing says which chat made it. Only a folder
/// made anew goes to the chat that made it.
#[tokio::test]
async fn a_folder_from_before_the_turn_is_given_to_no_chat_until_it_is_made_anew(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let first = f.conversation;
            let second = f.conversation("public").await?;
            let job = f.job(None).await?;
            let page = f
                .open_page(&job, first, FOLDER, 4173, Some("existing"))
                .await?;
            assert_eq!(page, json!({ "folder": FOLDER, "conversationId": null }));
            assert_eq!(f.page_chat(FOLDER).await?, Some(None));
            // another chat, an older CLI: still no chat
            let page = f.open_page(&job, second, FOLDER, 4174, None).await?;
            assert_eq!(page["conversationId"], json!(null));
            assert_eq!(f.page_chat(FOLDER).await?, Some(None));
            // the folder was taken away and a chat makes a page of that name: it is that chat's
            let page = f.open_page(&job, second, FOLDER, 4175, Some("new")).await?;
            assert_eq!(page["conversationId"], json!(second));
            // an older CLI, which can't say whether its turn made the folder, is not taken at
            // its word for a folder the record does not hold
            let page = f.open_page(&job, first, "sites/porto", 4176, None).await?;
            assert_eq!(
                page,
                json!({ "folder": "sites/porto", "conversationId": null })
            );
            Ok(())
        })
    })
    .await
}

/// A job's own open gives the page to the job's chat, and the same run opening it again reads the
/// same row. The person's own site, served from the workspace itself, is no page, and a
/// `pageFolder` that is neither word is refused.
#[tokio::test]
async fn a_jobs_card_gives_the_page_to_the_jobs_chat_and_the_workspace_itself_is_no_page(
) -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let job = f.job(None).await?;
            let mut body = f.open_body(&job, 4173);
            body["serve"] = json!({ "argv": ["instafy", "bind", "serve", "."], "cwd": FOLDER });
            body["pageFolder"] = json!("new");
            let (status, created) = f
                .request(&job.token, "POST", &f.path(""), body.clone())
                .await?;
            assert_eq!(status, StatusCode::CREATED, "{created}");
            let preview_id = created["previewId"]
                .as_str()
                .context("previewId")?
                .to_string();
            let grant = f.grant_metadata(&preview_id).await?;
            assert_eq!(grant["_instafyPreview"]["pageFolder"], json!("new"));
            let first = f.ready(&job.token, &preview_id).await?;
            assert_eq!(
                first["page"],
                json!({ "folder": FOLDER, "conversationId": f.conversation })
            );
            let again = f.ready(&job.token, &preview_id).await?;
            assert_eq!(again["messageId"], first["messageId"]);
            assert_eq!(again["page"], first["page"]);

            let mut own = f.open_body(&job, 4174);
            own["serve"] = json!({ "argv": ["npm", "run", "dev"], "cwd": "." });
            let (status, created) = f.request(&job.token, "POST", &f.path(""), own).await?;
            assert_eq!(status, StatusCode::CREATED, "{created}");
            let own_id = created["previewId"]
                .as_str()
                .context("previewId")?
                .to_string();
            assert!(f.ready(&job.token, &own_id).await?.get("page").is_none());
            assert_eq!(f.page_rows().await?, 1);

            body["port"] = json!(4175);
            body["pageFolder"] = json!("mine");
            let (status, refused) = f.request(&job.token, "POST", &f.path(""), body).await?;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
            Ok(())
        })
    })
    .await
}

/// A leased turn is given the space's pages, each with the chat that made it. A page whose chat
/// is gone for the person the turn runs for reads with no chat, so it is no longer read-only in
/// every chat: the chat no longer exists, that person moved it to Trash (another member who
/// still has it reads it as that chat's), or nobody asks in it (an automation's thread, a bound
/// site's). The row keeps the chat: out of Trash, it has its page again.
#[tokio::test]
async fn a_leased_turn_reads_a_page_whose_chat_is_gone_as_made_in_no_chat() -> anyhow::Result<()> {
    run(|f| {
        Box::pin(async move {
            let kept = f.conversation;
            let trashed = f.conversation("public").await?;
            let deleted = f.conversation("public").await?;
            let automation = f.conversation("public").await?;
            let binder = f.conversation("public").await?;
            let db = f.state.pool.get().await?;
            db.execute(
                "update conversations set thread_kind = 'automation' where id = $1",
                &[&automation],
            )
            .await?;
            db.execute(
                "update conversations set metadata = $2 where id = $1",
                &[
                    &binder,
                    &PgJson(
                        json!({ "source": "instafy-bind", "purpose": "bound-site-agent-thread" }),
                    ),
                ],
            )
            .await?;
            let job = f.job(None).await?;
            for (port, (folder, chat)) in [
                ("sites/kept", kept),
                ("sites/trashed", trashed),
                ("sites/deleted", deleted),
                ("sites/automation", automation),
                ("sites/binder", binder),
            ]
            .into_iter()
            .enumerate()
            {
                f.open_page(&job, chat, folder, 4173 + port as i64, Some("new"))
                    .await?;
            }
            // a card in a thread nobody asks in gives the page to no chat from the start
            assert_eq!(f.page_chat("sites/automation").await?, Some(None));
            assert_eq!(f.page_chat("sites/binder").await?, Some(None));
            assert_eq!(f.page_chat("sites/trashed").await?, Some(Some(trashed)));

            // the owner moves one chat to Trash, and another chat is deleted outright
            let lifecycle = format!("instafy_conversation_lifecycle_v1_{}", f.users[0]);
            db.execute(
                "update conversations set metadata = $2 where id = $1",
                &[
                    &trashed,
                    &PgJson(json!({ lifecycle.clone(): { "status": "deleted" } })),
                ],
            )
            .await?;
            db.execute("delete from conversations where id = $1", &[&deleted])
                .await?;

            let pages = f.leased_pages(0).await?;
            assert_eq!(pages.len(), 5, "{pages:?}");
            assert_eq!(chat_of(&pages, "sites/kept"), Some(&json!(kept)));
            for gone in [
                "sites/trashed",
                "sites/deleted",
                "sites/automation",
                "sites/binder",
            ] {
                assert_eq!(chat_of(&pages, gone), Some(&Value::Null), "{gone}");
            }
            // the most recently opened first, each with its title and how it is served
            assert_eq!(pages[0]["folder"], json!("sites/binder"));
            assert_eq!(pages[4]["folder"], json!("sites/kept"));
            assert_eq!(pages[4]["title"], json!("Framework laptops"));
            assert_eq!(pages[4]["server"], json!(["instafy", "bind"]));
            assert!(pages[4]["openedAt"]
                .as_str()
                .is_some_and(|at| at.ends_with('Z')));
            // a builder who still has the chat reads the page as that chat's
            let builders = f.leased_pages(1).await?;
            assert_eq!(chat_of(&builders, "sites/trashed"), Some(&json!(trashed)));
            // taken out of Trash, the chat has its page again
            db.execute(
                "update conversations set metadata = $2 where id = $1",
                &[&trashed, &PgJson(json!({ lifecycle: "active" }))],
            )
            .await?;
            let pages = f.leased_pages(0).await?;
            assert_eq!(chat_of(&pages, "sites/trashed"), Some(&json!(trashed)));

            // each leased job's payload gets them, for its own space and person
            let elsewhere = Uuid::new_v4();
            let mut payloads = [
                json!({ "user_id": f.users[0], "prompt_text": "hi" }),
                json!({ "user_id": f.users[0] }),
                json!(null),
            ];
            let [mine, other_space, no_payload] = &mut payloads;
            let mut leased = [
                LeasedPages {
                    project_id: f.project,
                    payload: mine,
                },
                LeasedPages {
                    project_id: elsewhere,
                    payload: other_space,
                },
                LeasedPages {
                    project_id: f.project,
                    payload: no_payload,
                },
            ];
            add_space_pages(&db, &mut leased).await;
            assert_eq!(
                payloads[0][SPACE_PAGES_PAYLOAD_KEY]["pages"]
                    .as_array()
                    .map(Vec::len),
                Some(5)
            );
            assert_eq!(payloads[0]["prompt_text"], json!("hi"));
            assert_eq!(payloads[1][SPACE_PAGES_PAYLOAD_KEY], json!({ "pages": [] }));
            assert_eq!(payloads[2], json!(null));
            Ok(())
        })
    })
    .await
}
