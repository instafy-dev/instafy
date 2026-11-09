//! Which chat made each of a space's pages.
//!
//! A page made for a person belongs to the chat that made it: another chat's turn reads it and
//! never changes it, and the runtime holds it to that (the runtime agent's `jobs/space_pages.rs`).
//! The runtime read which chat made a page from a file in the space's own folder, which
//! `instafy preview open` writes. That file is outside every save, so a hosted space lost it with
//! its machine (a release replaces the node, and an idle checkout is cloned again), and the next
//! chat to open a page's card became its maker. The chat that really made the page then had its
//! edits put back, under a line saying another chat had made it.
//!
//! So the controller keeps the record, in `space_pages`: one row per space and page folder (the
//! folder the site is served from, `serve.cwd`), written when the page's card is posted
//! ([`record_opened_page`]) with the chat the card went to, and kept by every later card for that
//! folder. The card's chat made the page only when the opener says its turn made the folder
//! (`pageFolder: "new"`), and then whatever an old row says: the folder that row named was taken
//! away (an Undo), and this is another page of the same name. Otherwise a folder the record does
//! not hold yet is written down with no chat, because nothing says which chat made it:
//!
//! - The opener said the folder was there before its turn began (`pageFolder: "existing"`): a
//!   page from before this record, or one whose card was never opened. Giving it to the chat that
//!   happened to open it first is how a page changed hands.
//! - The opener said neither (a CLI from before it could tell): it is not taken at its word.
//! - The card went to a thread nobody asks in ([`nobody_asks_in`]): an automation's or a bound
//!   site's own thread.
//!
//! A leased turn is given the space's rows ([`add_space_pages`], `space_pages` in its payload),
//! and its runtime takes them over its own file. A row reads there with no chat when its chat is
//! gone for the person the turn runs for: the chat no longer exists, they moved it to Trash, or
//! nobody asks in it. So such a page is no longer read-only in every chat. The row keeps the
//! chat: taken out of Trash, it has its page again.

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use tracing::warn;
use uuid::Uuid;

use super::serve::PreviewServe;
use crate::conversations::ConversationRecord;

/// In a grant's `_instafyPreview`: what the opener said of the page's folder, [`PageFolder`].
pub(super) const PAGE_FOLDER_KEY: &str = "pageFolder";
/// The job payload's key for the space's pages, as the runtime agent reads it.
pub(crate) const SPACE_PAGES_PAYLOAD_KEY: &str = "space_pages";
/// At most this many pages go to a leased turn, the most recently opened first: more than the
/// runtime's own record keeps.
const MAX_LEASED_PAGES: i64 = 200;
/// The longest title a row keeps (the column's limit).
const MAX_TITLE_CHARS: usize = 200;

/// What the opener says of the page's folder: made in the turn that opens it, or there before
/// that turn began.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PageFolder {
    New,
    Existing,
}

impl PageFolder {
    /// `pageFolder` of an open's body: `new`, `existing`, or not said.
    pub(super) fn parse(raw: Option<&str>) -> Result<Option<Self>, String> {
        match raw.map(str::trim) {
            None | Some("") => Ok(None),
            Some("new") => Ok(Some(Self::New)),
            Some("existing") => Ok(Some(Self::Existing)),
            Some(_) => Err("pageFolder must be \"new\" or \"existing\"".to_string()),
        }
    }

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Existing => "existing",
        }
    }
}

/// The page a card was posted for, as the open's answer carries it: its folder and the chat that
/// made it, when the record says.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OpenedPage {
    pub(super) folder: String,
    pub(super) conversation_id: Option<Uuid>,
}

/// A page's folder as the record keys it: `serve.cwd` (already a clean path relative to the
/// workspace), or None for the workspace itself, which is the person's own site and no page.
pub(super) fn page_folder_of(serve: &PreviewServe) -> Option<String> {
    let folder = serve
        .cwd
        .trim()
        .trim_start_matches("./")
        .trim_end_matches('/');
    (!folder.is_empty() && folder != ".").then(|| folder.to_string())
}

/// How the site is served, as the runtime's record keeps it: the program's name and its first
/// argument (`["instafy", "bind"]`, `["uw", "host"]`).
fn server_of(argv: &[String]) -> Vec<String> {
    let program = argv
        .first()
        .map(|program| {
            std::path::Path::new(program)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(program)
                .to_string()
        })
        .unwrap_or_default();
    std::iter::once(program)
        .chain(argv.get(1).cloned())
        .collect()
}

/// A thread nobody asks in, by what its conversation carries: an automation's own thread, or a
/// bound site's (`instafy bind`). A page whose card went there has no chat to change it in.
pub(super) fn nobody_asks_in(thread_kind: Option<&str>, metadata: Option<&JsonValue>) -> bool {
    let kind = thread_kind.map(|kind| kind.trim().to_ascii_lowercase());
    if matches!(kind.as_deref(), Some("automation" | "bind")) {
        return true;
    }
    let field = |key: &str| metadata.and_then(|metadata| metadata.get(key));
    field("automationId").is_some_and(|id| !id.is_null())
        || field("source")
            .and_then(JsonValue::as_str)
            .is_some_and(|source| source.trim().eq_ignore_ascii_case("instafy-bind"))
}

/// Whether `user_id` moved the conversation to Trash, or hid it: their own state for it, in its
/// metadata (`instafy_conversation_lifecycle_v1_<user>`). An archived chat is still one to ask in.
fn in_trash(lifecycle: Option<&JsonValue>) -> bool {
    let status = lifecycle.and_then(|value| {
        value
            .as_str()
            .or_else(|| value.get("status").and_then(JsonValue::as_str))
    });
    matches!(
        status
            .map(|status| status.trim().to_ascii_lowercase())
            .as_deref(),
        Some("deleted" | "hidden")
    )
}

fn lifecycle_key(user_id: &Uuid) -> String {
    format!("instafy_conversation_lifecycle_v1_{user_id}")
}

/// Writes down the page whose card was just posted to `conversation`: its folder with that chat
/// when the opener `said` its turn made the folder, else with the chat the record holds for the
/// folder, or none when it holds no such folder yet (see the module comment). None for a preview
/// that records no folder, and when the record could not be written: a card never fails over it.
/// The write runs in a savepoint, so a failure leaves the card's transaction as it was.
pub(super) async fn record_opened_page(
    transaction: &mut tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    serve: Option<&PreviewServe>,
    title: &str,
    conversation: &ConversationRecord,
    said: Option<PageFolder>,
) -> Option<OpenedPage> {
    let serve = serve?;
    let folder = page_folder_of(serve)?;
    // The card's chat made the page only when its turn made the folder, and somebody asks in
    // that chat.
    let remade = said == Some(PageFolder::New);
    let maker = (remade
        && !nobody_asks_in(
            conversation.thread_kind.as_deref(),
            conversation.metadata.as_ref(),
        ))
    .then_some(conversation.id);
    let title: String = title.chars().take(MAX_TITLE_CHARS).collect();
    let server = json!(server_of(&serve.argv));
    let savepoint = match transaction.transaction().await {
        Ok(savepoint) => savepoint,
        Err(error) => {
            warn!(%project_id, %error, "could not start writing down an opened page");
            return None;
        }
    };
    let row = savepoint
        .query_one(
            "insert into space_pages (project_id, folder, conversation_id, title, server)
             values ($1, $2, $3, $4, $5)
             on conflict (project_id, folder) do update
               set title = excluded.title,
                   server = excluded.server,
                   opened_at = now(),
                   conversation_id = case when $6 then excluded.conversation_id
                                          else space_pages.conversation_id end
             returning conversation_id",
            &[project_id, &folder, &maker, &title, &server, &remade],
        )
        .await;
    let recorded: Option<Uuid> = match row {
        Ok(row) => row.get("conversation_id"),
        Err(error) => {
            warn!(%project_id, folder, %error, "could not write down an opened page");
            // Dropping the savepoint rolls it back.
            return None;
        }
    };
    if let Err(error) = savepoint.commit().await {
        warn!(%project_id, folder, %error, "could not keep an opened page's row");
        return None;
    }
    Some(OpenedPage {
        folder,
        conversation_id: recorded,
    })
}

/// The page in `serve`'s folder as the record holds it, for an open whose card was posted before
/// (the same run opening the same preview again): None when the record holds no such folder.
pub(super) async fn opened_page(
    transaction: &mut tokio_postgres::Transaction<'_>,
    project_id: &Uuid,
    serve: Option<&PreviewServe>,
) -> Option<OpenedPage> {
    let folder = page_folder_of(serve?)?;
    // Read in a savepoint as well: a failed statement would otherwise end the card's transaction.
    let savepoint = transaction.transaction().await.ok()?;
    let row = savepoint
        .query_opt(
            "select conversation_id from space_pages where project_id = $1 and folder = $2",
            &[project_id, &folder],
        )
        .await
        .ok()??;
    let conversation_id = row.get("conversation_id");
    savepoint.commit().await.ok()?;
    Some(OpenedPage {
        folder,
        conversation_id,
    })
}

/// One leased job whose payload gets the space's pages.
pub(crate) struct LeasedPages<'a> {
    pub(crate) project_id: Uuid,
    pub(crate) payload: &'a mut JsonValue,
}

/// Adds the space's pages to each leased job's payload ([`SPACE_PAGES_PAYLOAD_KEY`]): `{"pages":
/// [{"folder", "title", "server", "openedAt", "conversationId"?}]}`, the most recently opened
/// first, each with the chat that made it unless that chat is gone for the person the job runs
/// for (the payload's `user_id`). A job whose pages could not be read gets no such key, and its
/// runtime reads its own file as before: a lease never fails over this.
pub(crate) async fn add_space_pages(db: &tokio_postgres::Client, jobs: &mut [LeasedPages<'_>]) {
    let mut read: HashMap<(Uuid, Option<Uuid>), Option<JsonValue>> = HashMap::new();
    for job in jobs.iter_mut() {
        if !job.payload.is_object() {
            continue;
        }
        let user_id = job
            .payload
            .get("user_id")
            .and_then(JsonValue::as_str)
            .and_then(|value| Uuid::parse_str(value.trim()).ok());
        let key = (job.project_id, user_id);
        if !read.contains_key(&key) {
            let pages = match space_pages_for(db, &job.project_id, user_id.as_ref()).await {
                Ok(pages) => Some(pages),
                Err(error) => {
                    warn!(project_id = %job.project_id, %error, "could not read the space's pages for a leased job");
                    None
                }
            };
            read.insert(key, pages);
        }
        if let Some(Some(pages)) = read.get(&key) {
            job.payload[SPACE_PAGES_PAYLOAD_KEY] = pages.clone();
        }
    }
}

/// The space's pages as a leased job's payload carries them, for a turn of `user_id`.
pub(super) async fn space_pages_for(
    db: &tokio_postgres::Client,
    project_id: &Uuid,
    user_id: Option<&Uuid>,
) -> Result<JsonValue, tokio_postgres::Error> {
    // No person: every chat reads as not in Trash.
    let lifecycle = user_id.map(lifecycle_key).unwrap_or_default();
    let rows = db
        .query(
            "select p.folder, p.title, p.server, p.opened_at, p.conversation_id,
                    c.id as chat_id, c.thread_kind,
                    c.metadata->'source' as source,
                    c.metadata->'automationId' as automation_id,
                    c.metadata->($2::text) as lifecycle
             from space_pages p
             left join conversations c
               on c.id = p.conversation_id and c.project_id = p.project_id
             where p.project_id = $1
             order by p.opened_at desc, p.folder
             limit $3",
            &[project_id, &lifecycle, &MAX_LEASED_PAGES],
        )
        .await?;
    let pages: Vec<JsonValue> = rows
        .iter()
        .map(|row| {
            let chat: Option<Uuid> = row.get("chat_id");
            let metadata = json!({
                "source": row.get::<_, Option<JsonValue>>("source"),
                "automationId": row.get::<_, Option<JsonValue>>("automation_id"),
            });
            let gone = chat.is_none()
                || nobody_asks_in(
                    row.get::<_, Option<String>>("thread_kind").as_deref(),
                    Some(&metadata),
                )
                || in_trash(row.get::<_, Option<JsonValue>>("lifecycle").as_ref());
            let mut page = json!({
                "folder": row.get::<_, String>("folder"),
                "title": row.get::<_, String>("title"),
                "server": row.get::<_, JsonValue>("server"),
                "openedAt": row
                    .get::<_, chrono::DateTime<chrono::Utc>>("opened_at")
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            });
            if let Some(chat) = chat.filter(|_| !gone) {
                page["conversationId"] = json!(chat);
            }
            page
        })
        .collect();
    Ok(json!({ "pages": pages }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_folder_is_new_existing_or_not_said() {
        assert_eq!(PageFolder::parse(None), Ok(None));
        assert_eq!(PageFolder::parse(Some(" ")), Ok(None));
        assert_eq!(PageFolder::parse(Some("new")), Ok(Some(PageFolder::New)));
        assert_eq!(
            PageFolder::parse(Some(" existing ")),
            Ok(Some(PageFolder::Existing))
        );
        assert!(PageFolder::parse(Some("mine")).is_err());
        assert_eq!(PageFolder::New.as_str(), "new");
        assert_eq!(PageFolder::Existing.as_str(), "existing");
    }

    /// The workspace itself is the person's own site and no page; a folder of it is, keyed as the
    /// runtime's record keys it, with its server's program and first argument.
    #[test]
    fn a_page_is_a_folder_of_the_workspace_with_how_it_is_served() {
        let serve = |cwd: &str| PreviewServe {
            argv: vec![
                "/usr/local/bin/instafy".to_string(),
                "bind".to_string(),
                "serve".to_string(),
            ],
            cwd: cwd.to_string(),
        };
        assert_eq!(page_folder_of(&serve(".")), None);
        assert_eq!(
            page_folder_of(&serve("sites/porto")).as_deref(),
            Some("sites/porto")
        );
        assert_eq!(
            page_folder_of(&serve("./sites/porto/")).as_deref(),
            Some("sites/porto")
        );
        assert_eq!(server_of(&serve(".").argv), ["instafy", "bind"]);
        assert_eq!(server_of(&["uw".to_string()]), ["uw"]);
    }

    /// An automation's thread and a bound site's are threads nobody asks in; a person's chat, a
    /// team thread and a chat a finding started are not.
    #[test]
    fn nobody_asks_in_an_automations_or_a_bound_sites_thread() {
        assert!(nobody_asks_in(Some("automation"), None));
        assert!(nobody_asks_in(Some(" Bind "), None));
        assert!(nobody_asks_in(
            None,
            Some(&json!({ "automationId": Uuid::new_v4() }))
        ));
        assert!(nobody_asks_in(
            None,
            Some(&json!({ "source": "instafy-bind", "purpose": "bound-site-agent-thread" }))
        ));
        assert!(!nobody_asks_in(None, None));
        assert!(!nobody_asks_in(Some("agent"), Some(&json!({}))));
        assert!(!nobody_asks_in(
            None,
            Some(&json!({ "automationId": null, "source": null, "recommendationId": "r1" }))
        ));
    }

    /// Trash and hidden are gone for that person; archived and active are not, in either shape
    /// the state is kept in.
    #[test]
    fn a_chat_in_trash_is_gone_and_an_archived_one_is_not() {
        assert!(in_trash(Some(&json!("deleted"))));
        assert!(in_trash(Some(&json!({ "status": " Hidden " }))));
        assert!(!in_trash(Some(&json!("archived"))));
        assert!(!in_trash(Some(&json!({ "status": "active" }))));
        assert!(!in_trash(Some(&json!(null))));
        assert!(!in_trash(None));
    }
}
