use super::*;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};
use anyhow::Context;
use axum::body::{to_bytes, Body};
use axum::http::Request;
use serde_json::{json, Value};
use tower::ServiceExt;

fn proposal(conversation_id: Uuid) -> Value {
    json!({
        "key":"check-signup-mobile", "title":"Check signup on mobile",
        "reason":"The source chat records a desktop check but no mobile check.",
        "prompt":"Check the signup flow on mobile and report what you find.",
        "evidence":[{"conversationId":conversation_id}],
    })
}

#[test]
fn recommendations_submission_is_bounded_and_requires_evidence() {
    let base = proposal(Uuid::new_v4());
    let mut valid: SubmitRecommendation = serde_json::from_value(base.clone()).unwrap();
    valid.key = "  Check-Signup-Mobile  ".to_owned();
    valid.title = "  Mobile check  ".to_owned();
    valid.evidence.push(valid.evidence[0].clone());
    let normalized = normalize_submission(valid).unwrap();
    assert_eq!(normalized.key, "check-signup-mobile");
    assert_eq!(normalized.title, "Mobile check");
    assert_eq!(normalized.evidence.len(), 1);
    for (field, value) in [
        ("key", json!("../escape")),
        ("key", json!("é")),
        ("key", json!("-first")),
        ("key", json!("a".repeat(121))),
        ("title", json!("a".repeat(161))),
        ("reason", json!("a".repeat(2001))),
        ("prompt", json!("a".repeat(4001))),
        ("reason", json!("\0")),
        ("evidence", json!([])),
        (
            "evidence",
            json!(vec![json!({"conversationId":Uuid::new_v4()}); 9]),
        ),
    ] {
        let mut invalid = base.clone();
        invalid[field] = value;
        let body = serde_json::from_value(invalid).unwrap();
        assert!(
            normalize_submission(body).is_err(),
            "accepted invalid {field}"
        );
    }
    let mut forged = base;
    forged["status"] = json!("accepted");
    assert!(serde_json::from_value::<SubmitRecommendation>(forged).is_err());
    assert!(serde_json::from_value::<Evidence>(
        json!({"conversationId":Uuid::new_v4(),"url":"https://example.invalid"})
    )
    .is_err());
}

struct Fixture {
    state: AppState,
    app: Router,
    project: Uuid,
    other_project: Uuid,
    users: [Uuid; 4],
    tokens: [String; 4],
    public: Uuid,
    private: Uuid,
    other: Uuid,
    message: Uuid,
}

impl Fixture {
    async fn new() -> anyhow::Result<Self> {
        let pool = require_origin_test_pool("recommendations HTTP tests").await?;
        let users = std::array::from_fn(|_| Uuid::new_v4());
        for user in &users {
            ensure_test_user(&pool, user).await?;
        }
        let project = Uuid::new_v4();
        let other_project = Uuid::new_v4();
        let public = Uuid::new_v4();
        let private = Uuid::new_v4();
        let other = Uuid::new_v4();
        let message = Uuid::new_v4();
        {
            let db = pool.get().await?;
            // The schema must come from the real migration, never a test-only
            // replacement that silently omits RLS, constraints or permissions.
            db.query_one("select count(*) from space_recommendations", &[])
                .await?;
            db.execute("insert into projects(id,owner_user_id,name,project_type,status) values($1,$2,'Review fixture','customer','active'),($3,$4,'Other fixture','customer','active')", &[&project,&users[0],&other_project,&users[3]]).await?;
            db.execute("insert into project_memberships(project_id,user_id,role) values($1,$2,'builder'),($1,$3,'viewer')", &[&project,&users[1],&users[2]]).await?;
            for (id, project_id, owner, visibility) in [
                (public, project, users[0], "public"),
                (private, project, users[1], "private"),
                (other, other_project, users[3], "public"),
            ] {
                db.execute("insert into conversations(id,project_id,created_by,visibility,metadata,root_conversation_id) values($1,$2,$3,$4,'{}'::jsonb,$1)", &[&id,&project_id,&owner,&visibility]).await?;
            }
            db.execute("insert into conversation_participants(conversation_id,user_id,role,added_by) values($1,$2,'member',$3)", &[&private,&users[0],&users[1]]).await?;
            db.execute("insert into conversation_messages(id,conversation_id,project_id,role,content,metadata) values($1,$2,$3,'user','Desktop passed; mobile is untested.','{}'::jsonb)", &[&message,&public,&project]).await?;
        }
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "recommendations-http",
        );
        let mut tokens = std::array::from_fn(|_| String::new());
        for (index, user) in users.iter().enumerate() {
            tokens[index] = crate::auth::issue_controller_token(&config, user)
                .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?
                .token;
        }
        let state = build_test_state(pool, config);
        let app = router().with_state(state.clone());
        Ok(Self {
            state,
            app,
            project,
            other_project,
            users,
            tokens,
            public,
            private,
            other,
            message,
        })
    }

    fn path(&self) -> String {
        format!("/projects/{}/recommendations", self.project)
    }

    async fn request(
        &self,
        token: &str,
        method: &str,
        path: &str,
        body: Value,
    ) -> anyhow::Result<(StatusCode, Value)> {
        let response = self
            .app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(path)
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(if method == "GET" || body.is_null() {
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

    async fn submit(&self, actor: usize, body: Value) -> anyhow::Result<Value> {
        let (status, result) = self
            .request(&self.tokens[actor], "POST", &self.path(), body)
            .await?;
        assert_eq!(status, StatusCode::OK, "{result}");
        Ok(result)
    }

    async fn list(&self, token: &str) -> anyhow::Result<Vec<Value>> {
        let (status, body) = self
            .request(token, "GET", &self.path(), Value::Null)
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        Ok(body["recommendations"]
            .as_array()
            .context("recommendations list")?
            .clone())
    }

    async fn job(
        &self,
        conversation_id: Uuid,
        scopes: Vec<String>,
    ) -> anyhow::Result<(String, Uuid)> {
        let runtime_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let job_id = Uuid::new_v4();
        {
            let db = self.state.pool.get().await?;
            db.execute("insert into runtimes(id,project_id,provider,status) values($1,$2,'default','running')", &[&runtime_id,&self.project]).await?;
            db.execute("insert into runtime_leases(id,project_id,runtime_id,status,launched_at) values($1,$2,$3,'active',now())", &[&lease_id,&self.project,&runtime_id]).await?;
            db.execute(
                "update runtimes set active_lease_id=$2 where id=$1",
                &[&runtime_id, &lease_id],
            )
            .await?;
            db.execute("insert into runs(id,project_id,conversation_id,run_type,status) values($1,$2,$3,'prompt','in_progress')", &[&run_id,&self.project,&conversation_id]).await?;
            db.execute("insert into agent_jobs(id,project_id,run_id,conversation_id,status,payload,leased_by_runtime_id,leased_at,lease_expires_at) values($1,$2,$3,$4,'leased',$5,$6,now(),now()+interval '5 minutes')", &[&job_id,&self.project,&run_id,&conversation_id,&PgJson(json!({"user_id":self.users[0]})),&runtime_id]).await?;
        }
        let token = mint_scoped_token(
            &self.state.config,
            ScopedTokenRequest {
                audience: runtime_id.to_string(),
                subject: self.users[0].to_string(),
                project_id: self.project.to_string(),
                origin_id: None,
                runtime_id: Some(runtime_id.to_string()),
                protocol: None,
                scopes,
                lease_id: Some(lease_id.to_string()),
                run_id: Some(run_id.to_string()),
                prefer_runtime: None,
                ttl_seconds: Some(300),
            },
        )
        .map_err(|(_, e)| anyhow::anyhow!(e.0.message))?
        .token;
        Ok((token, job_id))
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        let db = self.state.pool.get().await?;
        db.execute(
            "delete from projects where id=any($1)",
            &[&vec![self.project, self.other_project]],
        )
        .await?;
        db.execute(
            "delete from auth.users where id=any($1)",
            &[&self.users.to_vec()],
        )
        .await?;
        Ok(())
    }
}

#[tokio::test]
async fn recommendations_http_upserts_keep_decisions_and_owner_scope() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let mut initial = proposal(f.public);
    initial["evidence"] = json!([{"conversationId":f.public,"messageId":f.message}]);
    let first = f.submit(0, initial.clone()).await?;
    let mut changed = initial.clone();
    changed["title"] = json!("A clearer mobile check");
    let refreshed = f.submit(0, changed.clone()).await?;
    assert_eq!(first["id"], refreshed["id"]);
    assert_eq!(refreshed["title"], changed["title"]);
    assert!(f.list(&f.tokens[1]).await?.is_empty());
    let member = f.submit(1, initial.clone()).await?;
    assert_ne!(member["id"], first["id"]);
    let endpoint = format!("{}/{}", f.path(), first["id"].as_str().unwrap());
    assert_eq!(
        f.request(
            &f.tokens[1],
            "PATCH",
            &endpoint,
            json!({"status":"dismissed"})
        )
        .await?
        .0,
        StatusCode::NOT_FOUND
    );
    let (status, accepted) = f
        .request(
            &f.tokens[0],
            "PATCH",
            &endpoint,
            json!({"status":"accepted","acceptedConversationId":f.public}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    assert_eq!(accepted["status"], "accepted");
    changed["title"] = json!("Do not replace accepted work");
    let repeated = f.submit(0, changed).await?;
    assert_eq!(
        repeated, accepted,
        "terminal content and timestamp must remain unchanged"
    );
    assert_eq!(
        f.request(
            &f.tokens[0],
            "PATCH",
            &endpoint,
            json!({"status":"dismissed"})
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        f.request(
            &f.tokens[0],
            "PATCH",
            &endpoint,
            json!({"status":"proposed"})
        )
        .await?
        .0,
        StatusCode::BAD_REQUEST
    );
    let mut second = initial;
    second["key"] = json!("another-finding");
    let second = f.submit(0, second.clone()).await?;
    let second_endpoint = format!("{}/{}", f.path(), second["id"].as_str().unwrap());
    assert_eq!(
        f.request(
            &f.tokens[0],
            "PATCH",
            &second_endpoint,
            json!({"status":"dismissed"})
        )
        .await?
        .0,
        StatusCode::OK
    );
    let mut again = proposal(f.public);
    again["key"] = json!("another-finding");
    assert_eq!(f.submit(0, again).await?["status"], "dismissed");
    assert_eq!(
        f.list(&f.tokens[0]).await?.len(),
        2,
        "decisions remain available to future reviews"
    );
    {
        let db = f.state.pool.get().await?;
        db.execute(
            "delete from project_memberships where project_id=$1 and user_id=$2",
            &[&f.project, &f.users[1]],
        )
        .await?;
    }
    assert_eq!(
        f.request(&f.tokens[1], "GET", &f.path(), Value::Null)
            .await?
            .0,
        StatusCode::FORBIDDEN,
        "owning a finding never replaces current project access"
    );
    f.cleanup().await
}

#[tokio::test]
async fn recommendations_http_evidence_access_and_browser_rls_fail_closed() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    assert_eq!(
        f.request(&f.tokens[2], "POST", &f.path(), proposal(f.public))
            .await?
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request(&f.tokens[3], "GET", &f.path(), Value::Null)
            .await?
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request(&f.tokens[0], "POST", &f.path(), proposal(f.other))
            .await?
            .0,
        StatusCode::NOT_FOUND
    );
    let mut mismatched = proposal(f.private);
    mismatched["evidence"] = json!([{"conversationId":f.private,"messageId":f.message}]);
    assert_eq!(
        f.request(&f.tokens[0], "POST", &f.path(), mismatched)
            .await?
            .0,
        StatusCode::NOT_FOUND
    );
    let private = f.submit(0, proposal(f.private)).await?;
    assert_eq!(f.list(&f.tokens[0]).await?.len(), 1);
    {
        let db = f.state.pool.get().await?;
        db.execute(
            "delete from conversation_participants where conversation_id=$1 and user_id=$2",
            &[&f.private, &f.users[0]],
        )
        .await?;
        for table in ["space_recommendations", "space_review_conversations"] {
            let row = db
                .query_one(
                    "select relrowsecurity from pg_class where oid=$1::text::regclass",
                    &[&format!("public.{table}")],
                )
                .await?;
            assert!(row.get::<_, bool>(0));
            for role in ["anon", "authenticated"] {
                let privilege: bool = db
                    .query_one(
                        "select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE')",
                        &[&role, &format!("public.{table}")],
                    )
                    .await?
                    .get(0);
                assert!(
                    !privilege,
                    "{role} must not bypass the controller via {table}"
                );
            }
        }
    }
    assert!(
        f.list(&f.tokens[0]).await?.is_empty(),
        "revoked evidence hides the entire finding"
    );
    let endpoint = format!("{}/{}", f.path(), private["id"].as_str().unwrap());
    assert_eq!(
        f.request(
            &f.tokens[0],
            "PATCH",
            &endpoint,
            json!({"status":"accepted"})
        )
        .await?
        .0,
        StatusCode::FORBIDDEN
    );
    f.cleanup().await
}

#[tokio::test]
async fn recommendations_http_review_conversation_is_private_and_reused() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let path = format!("{}/review-conversation", f.path());
    let (a, b) = tokio::join!(
        f.request(&f.tokens[0], "POST", &path, Value::Null),
        f.request(&f.tokens[0], "POST", &path, Value::Null)
    );
    let (status, a) = a?;
    let (other_status, b) = b?;
    assert_eq!(status, StatusCode::OK, "{a}");
    assert_eq!(other_status, StatusCode::OK, "{b}");
    assert_eq!(a, b);
    let id = Uuid::parse_str(a["conversationId"].as_str().context("conversationId")?)?;
    assert_eq!(
        f.request(&f.tokens[2], "POST", &path, Value::Null).await?.0,
        StatusCode::FORBIDDEN
    );
    let (_, member) = f.request(&f.tokens[1], "POST", &path, Value::Null).await?;
    assert_ne!(member["conversationId"], a["conversationId"]);
    for lifecycle in [
        json!("archived"),
        json!({"status":"hidden"}),
        json!({"status":"deleted"}),
    ] {
        let key = format!("instafy_conversation_lifecycle_v1_{}", f.users[0]);
        let other_key = format!("instafy_conversation_lifecycle_v1_{}", f.users[1]);
        {
            let db = f.state.pool.get().await?;
            db.execute(
                "update conversations set metadata=metadata || $2 where id=$1",
                &[
                    &id,
                    &PgJson(json!({key.clone():lifecycle,other_key.clone():"hidden"})),
                ],
            )
            .await?;
        }
        assert_eq!(
            f.request(&f.tokens[0], "POST", &path, Value::Null).await?.0,
            StatusCode::OK
        );
        let db = f.state.pool.get().await?;
        let metadata: PgJson<Value> = db
            .query_one("select metadata from conversations where id=$1", &[&id])
            .await?
            .get(0);
        assert_eq!(metadata.0[&key]["status"], "active");
        assert_eq!(
            metadata.0[&other_key], "hidden",
            "other viewers' metadata must survive"
        );
    }
    {
        let db = f.state.pool.get().await?;
        let row=db.query_one("select visibility,created_by,(select count(*) from conversation_participants where conversation_id=$1) as participants from conversations where id=$1", &[&id]).await?;
        assert_eq!(row.get::<_, String>("visibility"), "private");
        assert_eq!(row.get::<_, Uuid>("created_by"), f.users[0]);
        assert_eq!(row.get::<_, i64>("participants"), 1);
        db.execute("insert into conversation_participants(conversation_id,user_id,role,added_by) values($1,$2,'member',$3)", &[&id,&f.users[1],&f.users[0]]).await?;
    }
    assert_eq!(
        f.request(&f.tokens[0], "POST", &path, Value::Null).await?.0,
        StatusCode::CONFLICT
    );
    {
        let db = f.state.pool.get().await?;
        db.execute(
            "delete from conversation_participants where conversation_id=$1 and user_id=$2",
            &[&id, &f.users[1]],
        )
        .await?;
        db.execute(
            "update conversations set root_conversation_id=$2 where id=$1",
            &[&id, &f.public],
        )
        .await?;
    }
    assert_eq!(
        f.request(&f.tokens[0], "POST", &path, Value::Null).await?.0,
        StatusCode::CONFLICT,
        "an anchor must remain its own private root"
    );
    {
        let db = f.state.pool.get().await?;
        db.execute(
            "update conversations set root_conversation_id=id, visibility='public' where id=$1",
            &[&id],
        )
        .await?;
    }
    assert_eq!(
        f.request(&f.tokens[0], "POST", &path, Value::Null).await?.0,
        StatusCode::CONFLICT,
        "a review cannot resume after it was made public"
    );
    f.cleanup().await
}

#[tokio::test]
async fn recommendations_http_active_job_scope_and_human_only_decisions() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let anchor_path = format!("{}/review-conversation", f.path());
    let (_, anchor) = f
        .request(&f.tokens[0], "POST", &anchor_path, Value::Null)
        .await?;
    let review = Uuid::parse_str(
        anchor["conversationId"]
            .as_str()
            .context("review conversation")?,
    )?;
    let (job_token, job_id) = f
        .job(
            review,
            vec![
                "prompt.execute".into(),
                "job.token.workspace-separated".into(),
            ],
        )
        .await?;
    let (public_token, _) = f
        .job(
            f.public,
            vec![
                "prompt.execute".into(),
                "job.token.workspace-separated".into(),
            ],
        )
        .await?;
    let (machine_token, _) = f.job(f.public, vec!["fs.read".into()]).await?;
    let (status, record) = f
        .request(&job_token, "POST", &f.path(), proposal(f.public))
        .await?;
    assert_eq!(status, StatusCode::OK, "{record}");
    assert_eq!(f.list(&job_token).await?.len(), 1);
    assert!(
        f.list(&public_token).await?.is_empty(),
        "public job must not read private-source findings even with public citations"
    );
    assert_eq!(
        f.request(&public_token, "POST", &f.path(), proposal(f.public))
            .await?
            .0,
        StatusCode::FORBIDDEN,
        "same key cannot overwrite private-source data"
    );
    assert_eq!(
        f.request(&job_token, "POST", &f.path(), proposal(f.private))
            .await?
            .0,
        StatusCode::FORBIDDEN,
        "job cannot read another private root even when its user can"
    );
    assert_eq!(
        f.request(
            &job_token,
            "GET",
            &format!("/projects/{}/recommendations", f.other_project),
            Value::Null
        )
        .await?
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request(&machine_token, "GET", &f.path(), Value::Null)
            .await?
            .0,
        StatusCode::UNAUTHORIZED
    );
    let endpoint = format!("{}/{}", f.path(), record["id"].as_str().unwrap());
    assert_eq!(
        f.request(&job_token, "PATCH", &endpoint, json!({"status":"accepted"}))
            .await?
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        f.request(&job_token, "POST", &anchor_path, Value::Null)
            .await?
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (status, accepted) = f
        .request(
            &f.tokens[0],
            "PATCH",
            &endpoint,
            json!({"status":"accepted","acceptedConversationId":f.private}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    let remembered = f.list(&job_token).await?;
    assert_eq!(remembered[0]["status"], "accepted");
    assert!(
        remembered[0]["acceptedConversationId"].is_null(),
        "redact unrelated continuation without losing the decision"
    );
    let db = f.state.pool.get().await?;
    db.execute(
        "delete from conversation_participants where conversation_id=$1 and user_id=$2",
        &[&f.private, &f.users[0]],
    )
    .await?;
    drop(db);
    let (status, retried) = f
        .request(
            &f.tokens[0],
            "PATCH",
            &endpoint,
            json!({"status":"accepted"}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{retried}");
    assert_eq!(retried["status"], "accepted");
    assert!(
        retried["acceptedConversationId"].is_null(),
        "idempotent outcome retries must also redact a revoked continuation"
    );
    let db = f.state.pool.get().await?;
    db.execute(
        "update agent_jobs set lease_expires_at=now()-interval '1 minute' where id=$1",
        &[&job_id],
    )
    .await?;
    drop(db);
    assert_eq!(
        f.request(&job_token, "GET", &f.path(), Value::Null)
            .await?
            .0,
        StatusCode::UNAUTHORIZED
    );
    f.cleanup().await
}

#[tokio::test]
async fn recommendations_http_action_preparation_survives_retries_and_stays_private(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let record = f.submit(0, proposal(f.public)).await?;
    let endpoint = format!("{}/{}", f.path(), record["id"].as_str().unwrap());
    let path = format!("{endpoint}/prepare-conversation");
    assert_eq!(
        f.request(&f.tokens[2], "POST", &path, Value::Null).await?.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        f.request(&f.tokens[1], "POST", &path, Value::Null).await?.0,
        StatusCode::NOT_FOUND
    );
    let (job, _) = f.job(f.public, vec!["prompt.execute".into()]).await?;
    assert_eq!(
        f.request(&job, "POST", &path, Value::Null).await?.0,
        StatusCode::UNAUTHORIZED
    );
    let mut events = f.state.events.subscribe();
    let (a, b) = tokio::join!(
        f.request(&f.tokens[0], "POST", &path, Value::Null),
        f.request(&f.tokens[0], "POST", &path, Value::Null)
    );
    let (status, a) = a?;
    let (other_status, b) = b?;
    assert_eq!(status, StatusCode::OK, "{a}");
    assert_eq!(other_status, StatusCode::OK, "{b}");
    assert_eq!(a, b);
    let id = Uuid::parse_str(
        a["conversationId"]
            .as_str()
            .context("prepared conversation")?,
    )?;
    let event = events.try_recv()?;
    assert_eq!(event.kind, "conversation.created");
    assert_eq!(event.conversation_id, Some(id));
    assert_eq!(event.data["visibility"], "private");
    assert!(
        events.try_recv().is_err(),
        "a retry must not emit a duplicate creation"
    );
    // A rejected outcome leaves the draft recoverable after a client remount.
    assert_eq!(
        f.request(
            &f.tokens[0],
            "PATCH",
            &endpoint,
            json!({"status":"proposed"})
        )
        .await?
        .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        f.request(&f.tokens[0], "POST", &path, Value::Null).await?.1,
        a
    );
    assert_eq!(f.list(&f.tokens[0]).await?[0]["status"], "proposed");
    {
        let db = f.state.pool.get().await?;
        let count: i64 = db
            .query_one(
                "select count(*) from conversations where project_id=$1",
                &[&f.project],
            )
            .await?
            .get(0);
        assert_eq!(count, 3, "one private continuation plus two source chats");
        let row = db.query_one("select visibility,created_by,root_conversation_id,parent_conversation_id,(select count(*) from conversation_participants where conversation_id=$1) as participants from conversations where id=$1", &[&id]).await?;
        assert_eq!(row.get::<_, String>("visibility"), "private");
        assert_eq!(row.get::<_, Uuid>("created_by"), f.users[0]);
        assert_eq!(row.get::<_, Uuid>("root_conversation_id"), id);
        assert!(row
            .get::<_, Option<Uuid>>("parent_conversation_id")
            .is_none());
        assert_eq!(row.get::<_, i64>("participants"), 1);
        db.execute(
            "update conversations set visibility='public' where id=$1",
            &[&id],
        )
        .await?;
    }
    assert_eq!(
        f.request(&f.tokens[0], "POST", &path, Value::Null).await?.0,
        StatusCode::FORBIDDEN
    );
    {
        let db = f.state.pool.get().await?;
        let key = format!("instafy_conversation_lifecycle_v1_{}", f.users[0]);
        db.execute(
            "update conversations set visibility='private',metadata=metadata || $2 where id=$1",
            &[&id, &PgJson(json!({key:{"status":"deleted"}}))],
        )
        .await?;
    }
    assert_eq!(
        f.request(&f.tokens[0], "POST", &path, Value::Null).await?.0,
        StatusCode::FORBIDDEN
    );
    {
        let db = f.state.pool.get().await?;
        db.execute("delete from conversations where id=$1", &[&id])
            .await?;
    }
    assert_eq!(
        f.request(&f.tokens[0], "POST", &path, Value::Null).await?.0,
        StatusCode::FORBIDDEN,
        "deleted continuation identity must not be silently replaced"
    );
    assert_eq!(
        f.request(
            &f.tokens[0],
            "PATCH",
            &endpoint,
            json!({"status":"dismissed"})
        )
        .await?
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.request(&f.tokens[0], "POST", &path, Value::Null).await?.0,
        StatusCode::CONFLICT
    );
    let mut second = proposal(f.public);
    second["key"] = json!("another-check");
    let second = f.submit(0, second).await?;
    let endpoint = format!("{}/{}", f.path(), second["id"].as_str().unwrap());
    assert_eq!(
        f.request(
            &f.tokens[0],
            "PATCH",
            &endpoint,
            json!({"status":"accepted"})
        )
        .await?
        .0,
        StatusCode::OK
    );
    assert_eq!(
        f.request(
            &f.tokens[0],
            "POST",
            &format!("{endpoint}/prepare-conversation"),
            Value::Null
        )
        .await?
        .0,
        StatusCode::CONFLICT
    );
    f.cleanup().await
}
