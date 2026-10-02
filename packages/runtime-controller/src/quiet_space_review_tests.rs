use super::*;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key,
};
use axum::body::{to_bytes, Body};
use axum::http::Request;
use tower::ServiceExt;

struct Fixture {
    state: AppState,
    app: Router,
    user: Uuid,
    project: Uuid,
    token: String,
}
impl Fixture {
    async fn new() -> anyhow::Result<Self> {
        let pool = require_origin_test_pool("quiet space review").await?;
        let user = Uuid::new_v4();
        let project = Uuid::new_v4();
        ensure_test_user(&pool, &user).await?;
        pool.get().await?.execute("insert into projects(id,owner_user_id,name,project_type,status) values($1,$2,'Quiet review fixture','customer','active')", &[&project,&user]).await?;
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "quiet-space-review",
        );
        let token = crate::auth::issue_controller_token(&config, &user)
            .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?
            .token;
        let state = build_test_state(pool, config);
        let app = router()
            .merge(crate::conversations::router())
            .merge(crate::activity::router())
            .merge(crate::notifications::router())
            .merge(crate::message_search::router())
            .merge(crate::dispatch::router())
            .merge(crate::send_queue::router())
            .with_state(state.clone());
        Ok(Self {
            state,
            app,
            user,
            project,
            token,
        })
    }
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: JsonValue,
    ) -> anyhow::Result<(StatusCode, JsonValue)> {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("authorization", format!("Bearer {}", self.token))
                    .header("content-type", "application/json")
                    .body(if body.is_null() {
                        Body::empty()
                    } else {
                        Body::from(body.to_string())
                    })?,
            )
            .await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
        Ok((
            status,
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({"text":String::from_utf8_lossy(&bytes)})),
        ))
    }
    fn create_body(&self, mode: &str) -> JsonValue {
        json!({"name":"Review audit","mode":mode,"scheduleKind":"once","runAt":(Utc::now()+ChronoDuration::hours(1)).to_rfc3339(),"status":"paused","runtimeMode":"existing"})
    }
    async fn create(&self, mode: &str) -> anyhow::Result<JsonValue> {
        let (status, body) = self
            .request(
                "POST",
                &format!("/projects/{}/automations", self.project),
                self.create_body(mode),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        Ok(body)
    }
    async fn cleanup(self) -> anyhow::Result<()> {
        let db = self.state.pool.get().await?;
        db.execute("delete from runs where project_id=$1", &[&self.project])
            .await?;
        db.execute(
            "delete from notification_events where project_id=$1",
            &[&self.project],
        )
        .await?;
        db.execute("delete from projects where id=$1", &[&self.project])
            .await?;
        db.execute("delete from auth.users where id=$1", &[&self.user])
            .await?;
        Ok(())
    }
}
fn id(value: &JsonValue, field: &str) -> Uuid {
    Uuid::parse_str(value[field].as_str().unwrap()).unwrap()
}
fn api<T>(result: Result<T, (StatusCode, Json<ApiError>)>) -> anyhow::Result<T> {
    result.map_err(|(_, e)| anyhow::anyhow!(e.0.message))
}

#[tokio::test]
async fn quiet_space_review_is_opt_in_private_unique_and_immutable() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let ordinary = f.create("prompt").await?;
    let review = f.create("space_review").await?;
    assert_eq!(ordinary["silentWhenNothingToReport"], false);
    assert_eq!(review["silentWhenNothingToReport"], true);
    assert_eq!(review["resultVisibility"], "private");
    assert!(review["promptText"]
        .as_str()
        .unwrap()
        .contains("instafy-space-review"));
    let path = format!("/automations/{}", id(&review, "id"));
    for patch in [
        json!({"mode":"prompt"}),
        json!({"resultVisibility":"team"}),
        json!({"silentWhenNothingToReport":false}),
        json!({"promptText":"Do arbitrary work"}),
    ] {
        assert_eq!(
            f.request("PATCH", &path, patch).await?.0,
            StatusCode::BAD_REQUEST
        );
    }
    let (_, updated) = f
        .request(
            "PATCH",
            &path,
            json!({"scheduleKind":"hourly","intervalHours":8,"name":"Regular review"}),
        )
        .await?;
    assert_eq!(updated["mode"], "space_review");
    assert_eq!(updated["intervalHours"], 8);
    let (status, _) = f
        .request(
            "POST",
            &format!("/projects/{}/automations", f.project),
            f.create_body("space_review"),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    let (_, listed) = f
        .request(
            "GET",
            &format!("/projects/{}/conversations", f.project),
            JsonValue::Null,
        )
        .await?;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(listed[0]["id"], ordinary["conversationId"]);
    let (_, audit) = f
        .request(
            "GET",
            &format!("/projects/{}/automations", f.project),
            JsonValue::Null,
        )
        .await?;
    assert_eq!(audit.as_array().unwrap().len(), 2);
    let db = f.state.pool.get().await?;
    let marker: JsonValue = db
        .query_one(
            "select metadata from conversations where id=$1",
            &[&id(&review, "conversationId")],
        )
        .await?
        .get(0);
    assert_eq!(marker["internalPurpose"], "space_review");
    drop(db);
    // Removing/recreating the schedule retains the privacy boundary and same origin.
    assert_eq!(
        f.request("DELETE", &path, JsonValue::Null).await?.0,
        StatusCode::OK
    );
    let replacement = f.create("space_review").await?;
    assert_eq!(replacement["conversationId"], review["conversationId"]);
    f.cleanup().await
}

#[tokio::test]
async fn quiet_space_review_empty_and_failed_execution_never_enters_delivery_surfaces(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let review = f.create("space_review").await?;
    let anchor = id(&review, "conversationId");
    let mut db = f.state.pool.get().await?;
    // An empty successful run has audit state but no user-facing result. Also
    // exercise the error/streaming producers: neither may create a notification.
    let run = Uuid::new_v4();
    db.execute("insert into runs(id,project_id,conversation_id,run_type,status) values($1,$2,$3,'prompt','in_progress')",&[&run,&f.project,&anchor]).await?;
    db.execute("update runs set status='success' where id=$1", &[&run])
        .await?;
    let transaction = db.transaction().await?;
    let msg = api(crate::agent::record_agent_conversation_message(
        &transaction,
        &f.project,
        &anchor,
        None,
        None,
        None,
        "Private auditneedle only".to_string(),
        json!({}),
    )
    .await)?;
    assert_eq!(msg.metadata["internalPurpose"], "space_review");
    transaction.commit().await?;
    let record = row_to_record(
        &db.query_one(
            "select * from automations where id=$1",
            &[&id(&review, "id")],
        )
        .await?,
    );
    drop(db);
    finalize_automation_attempt(
        &f.state,
        &record,
        Utc::now(),
        None,
        Some("paused"),
        Some(AutomationLaunchFailure::minted(
            "No runtime available",
            CODE_CONTROLLER_UNAVAILABLE,
        )),
    )
    .await?;
    let (_, conversations) = f
        .request(
            "GET",
            &format!("/projects/{}/conversations", f.project),
            JsonValue::Null,
        )
        .await?;
    assert!(conversations.as_array().unwrap().is_empty());
    let (_, activity) = f.request("GET", "/me/activity", JsonValue::Null).await?;
    assert!(
        activity["items"].as_array().unwrap().is_empty(),
        "{activity}"
    );
    let (_, search) = f
        .request(
            "GET",
            &format!("/search/messages?q=auditneedle&projectId={}", f.project),
            JsonValue::Null,
        )
        .await?;
    assert!(search["matches"].as_array().unwrap().is_empty(), "{search}");
    let (status, history) = f
        .request(
            "GET",
            &format!("/conversations/{anchor}/messages"),
            JsonValue::Null,
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert!(history["messages"].as_array().unwrap().len() >= 2);
    let (_, audit) = f
        .request(
            "GET",
            &format!("/automations/{}", record.id),
            JsonValue::Null,
        )
        .await?;
    assert_eq!(audit["lastError"], "No runtime available");
    let db = f.state.pool.get().await?;
    let count: i64 = db
        .query_one(
            "select count(*) from notification_events where project_id=$1",
            &[&f.project],
        )
        .await?
        .get(0);
    assert_eq!(count, 0);
    let count: i64 = db
        .query_one(
            "select count(*) from space_recommendations where project_id=$1",
            &[&f.project],
        )
        .await?
        .get(0);
    assert_eq!(count, 0);
    drop(db);
    f.cleanup().await
}

#[tokio::test]
async fn quiet_space_review_rejects_normal_writes_and_marker_spoofing() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let review = f.create("space_review").await?;
    let anchor = id(&review, "conversationId");
    for (path, body) in [
        (
            format!("/conversations/{anchor}/messages/record"),
            json!({"content":"inject"}),
        ),
        (
            format!("/conversations/{anchor}/messages"),
            json!({"promptText":"inject"}),
        ),
        (
            format!("/conversations/{anchor}/participants"),
            json!({"userId":f.user}),
        ),
        (
            format!("/projects/{}/conversations/blank", f.project),
            json!({"parentConversationId":anchor,"threadKind":"worker"}),
        ),
    ] {
        let (status, body) = f.request("POST", &path, body).await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
    }
    assert_eq!(
        f.request(
            "PATCH",
            &format!("/conversations/{anchor}"),
            json!({"metadata":{"title":"unhide"}})
        )
        .await?
        .0,
        StatusCode::FORBIDDEN
    );
    let (status,created)=f.request("POST",&format!("/projects/{}/conversations/blank",f.project),json!({"metadata":{"title":"Ordinary","visibility":"private","internalPurpose":"space_review","spaceReview":{"enforcedBy":"runtime-controller"}}})).await?;
    assert_eq!(status, StatusCode::OK, "{created}");
    let ordinary = id(&created, "conversationId");
    let (status, _) = f
        .request(
            "PATCH",
            &format!("/conversations/{ordinary}"),
            json!({"metadata":{"title":"Ordinary","internalPurpose":"space_review"}}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let mut db = f.state.pool.get().await?;
    let marker: JsonValue = db
        .query_one(
            "select metadata from conversations where id=$1",
            &[&ordinary],
        )
        .await?
        .get(0);
    assert!(marker.get("internalPurpose").is_none());
    let transaction = db.transaction().await?;
    let msg = api(crate::agent::record_agent_conversation_message(
        &transaction,
        &f.project,
        &ordinary,
        None,
        None,
        None,
        "A useful normal message".to_string(),
        json!({"internalPurpose":"space_review"}),
    )
    .await)?;
    assert!(msg.metadata.get("internalPurpose").is_none());
    transaction.commit().await?;
    let count: i64 = db
        .query_one(
            "select count(*) from notification_events where conversation_id=$1",
            &[&ordinary],
        )
        .await?
        .get(0);
    assert_eq!(count, 1);
    // A leased/queued review cannot be manually dispatched a second time.
    db.execute("insert into agent_jobs(project_id,conversation_id,status,payload) values($1,$2,'queued','{}')",&[&f.project,&anchor]).await?;
    drop(db);
    assert_eq!(
        f.request(
            "POST",
            &format!("/automations/{}/run", id(&review, "id")),
            JsonValue::Null
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    f.cleanup().await
}
