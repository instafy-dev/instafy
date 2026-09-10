//! Real-router regression: authorization precedes message search, paging and context.
use super::*;

struct SearchCase {
    pool: PgPool,
    app: axum::Router,
    viewer: Uuid,
    owner: Uuid,
    outsider: Uuid,
    token: String,
    outsider_token: String,
    org: Uuid,
    projects: Vec<Uuid>,
    conversation: Uuid,
    private: Uuid,
    hidden: Uuid,
    private_excluded: Uuid,
    old_messages: Vec<Uuid>,
}

impl SearchCase {
    async fn create() -> anyhow::Result<Self> {
        let pool =
            require_origin_test_pool("message search authorization and exact context").await?;
        let viewer = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let outsider = Uuid::new_v4();
        let org = Uuid::new_v4();
        let projects = (0..5).map(|_| Uuid::new_v4()).collect::<Vec<_>>();
        let conversation = Uuid::new_v4();
        let private = Uuid::new_v4();
        let hidden = Uuid::new_v4();
        let private_excluded = Uuid::new_v4();
        let db = pool.get().await?;
        for user in [viewer, owner, outsider] {
            db.execute(
                "insert into auth.users(id,email,created_at,updated_at) values($1,$2,now(),now())",
                &[&user, &format!("message-search-{user}@example.invalid")],
            )
            .await?;
        }
        db.execute(
            "insert into organizations(id,slug,name) values($1,$2,'Search team')",
            &[&org, &format!("search-{org}")],
        )
        .await?;
        db.execute(
            "insert into org_memberships(org_id,user_id,role) values($1,$2,'viewer')",
            &[&org, &viewer],
        )
        .await?;
        for (index, project) in projects.iter().enumerate() {
            let org_id = (index == 1).then_some(org);
            let project_owner = match index {
                2 | 3 => viewer,
                4 => outsider,
                _ => owner,
            };
            let status = if index == 3 { "deleted" } else { "active" };
            db.execute("insert into projects(id,org_id,owner_user_id,name,project_type,status) values($1,$2,$3,'Search space','customer',$4)", &[project, &org_id, &project_owner, &status]).await?;
        }
        db.execute(
            "insert into project_memberships(project_id,user_id,role) values($1,$2,'viewer')",
            &[&projects[0], &viewer],
        )
        .await?;
        let lifecycle_key = format!("instafy_conversation_lifecycle_v1_{viewer}");
        let create_chat = async |id: Uuid,
                                 project: Uuid,
                                 visibility: &str,
                                 created_by: Uuid,
                                 metadata: serde_json::Value|
               -> anyhow::Result<()> {
            db.execute("insert into conversations(id,project_id,created_by,visibility,metadata) values($1,$2,$3,$4,$5)", &[&id,&project,&created_by,&visibility,&PgJson(metadata)]).await?;
            Ok(())
        };
        create_chat(
            conversation,
            projects[0],
            "public",
            owner,
            json!({"title":"Historical repair"}),
        )
        .await?;
        create_chat(
            private,
            projects[0],
            "private",
            owner,
            json!({"title":"Invited private repair"}),
        )
        .await?;
        create_chat(
            hidden,
            projects[0],
            "public",
            owner,
            json!({lifecycle_key.clone():"\u{feff}\t HIDDEN \u{00a0}"}),
        )
        .await?;
        create_chat(private_excluded, projects[0], "private", owner, json!({})).await?;
        db.execute("insert into conversation_participants(conversation_id,user_id,role,added_by) values($1,$2,'member',$3)", &[&private,&viewer,&owner]).await?;
        let mut old_messages = Vec::new();
        for index in 0..125 {
            let id = Uuid::new_v4();
            old_messages.push(id);
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            db.execute("insert into conversation_messages(id,conversation_id,project_id,role,content,created_at) values($1,$2,$3,$4,$5,'2024-01-01'::timestamptz + ($6::int * interval '1 second'))", &[&id,&conversation,&projects[0],&role,&format!("Old message {index}: 😀 Needle repair <script>"),&index]).await?;
        }
        for (chat, project, metadata, visibility, created_by) in [
            (private, projects[0], None, "private", owner),
            (hidden, projects[0], None, "public", owner),
            (private_excluded, projects[0], None, "private", owner),
            (
                Uuid::new_v4(),
                projects[0],
                Some(json!({lifecycle_key.clone():{"status":"deleted"}})),
                "public",
                owner,
            ),
            (
                Uuid::new_v4(),
                projects[0],
                Some(json!({lifecycle_key.clone():"archived"})),
                "public",
                owner,
            ),
            (
                Uuid::new_v4(),
                projects[0],
                Some(json!({})),
                "private",
                viewer,
            ),
            (
                Uuid::new_v4(),
                projects[1],
                Some(json!({})),
                "public",
                owner,
            ),
            (
                Uuid::new_v4(),
                projects[2],
                Some(json!({})),
                "public",
                viewer,
            ),
            (
                Uuid::new_v4(),
                projects[3],
                Some(json!({})),
                "public",
                viewer,
            ),
            (
                Uuid::new_v4(),
                projects[4],
                Some(json!({})),
                "public",
                outsider,
            ),
        ] {
            if let Some(metadata) = metadata {
                create_chat(chat, project, visibility, created_by, metadata).await?;
            }
            db.execute("insert into conversation_messages(id,conversation_id,project_id,role,content) values($1,$2,$3,'user','Needle fixture')", &[&Uuid::new_v4(),&chat,&project]).await?;
        }
        db.execute("insert into conversation_messages(id,conversation_id,project_id,role,content) values($1,$2,$3,'user','Literal 50%_\\done marker')", &[&Uuid::new_v4(),&conversation,&projects[0]]).await?;
        db.execute("insert into conversation_messages(id,conversation_id,project_id,role,content) values($1,$2,$3,'user','😀 ΟΣ · ος · ΟΣΤ')", &[&Uuid::new_v4(),&conversation,&projects[0]]).await?;
        drop(db);
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "message-search-tests",
        );
        let token = crate::auth::issue_controller_token(&config, &viewer)
            .map_err(|e| controller_error("search viewer token", e))?
            .token;
        let outsider_token = crate::auth::issue_controller_token(&config, &outsider)
            .map_err(|e| controller_error("search outsider token", e))?
            .token;
        let app =
            crate::message_search::router().with_state(build_test_state(pool.clone(), config));
        Ok(Self {
            pool,
            app,
            viewer,
            owner,
            outsider,
            token,
            outsider_token,
            org,
            projects,
            conversation,
            private,
            hidden,
            private_excluded,
            old_messages,
        })
    }

    async fn request(
        &self,
        uri: &str,
        token: Option<&str>,
    ) -> anyhow::Result<(StatusCode, serde_json::Value)> {
        let mut request = Request::builder().uri(uri);
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::empty())?)
            .await?;
        assert_eq!(response.headers()["cache-control"], "no-store");
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
        Ok((
            status,
            serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null),
        ))
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        let db = self.pool.get().await?;
        db.execute("delete from projects where id = any($1)", &[&self.projects])
            .await?;
        db.execute("delete from organizations where id=$1", &[&self.org])
            .await?;
        db.execute(
            "delete from auth.users where id=any($1)",
            &[&vec![self.viewer, self.owner, self.outsider]],
        )
        .await?;
        Ok(())
    }
}

#[tokio::test]
async fn message_search_http_authorization_scopes_literal_snippets_and_stable_pages(
) -> anyhow::Result<()> {
    let case = SearchCase::create().await?;
    let (status, _) = case.request("/search/messages?q=Needle", None).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let mut seen = std::collections::HashSet::new();
    let mut cursor = None;
    loop {
        let uri = format!(
            "/search/messages?q=Needle&limit=17{}",
            cursor
                .as_ref()
                .map(|cursor: &String| format!("&cursor={}", urlencoding::encode(cursor)))
                .unwrap_or_default()
        );
        let (status, page) = case.request(&uri, Some(&case.token)).await?;
        assert_eq!(status, StatusCode::OK, "{page}");
        for row in page["matches"].as_array().unwrap() {
            assert!(seen.insert(row["messageId"].as_str().unwrap().to_string()));
            assert_ne!(row["conversationId"], json!(case.hidden));
            assert_ne!(row["conversationId"], json!(case.private_excluded));
            assert_ne!(row["projectId"], json!(case.projects[3]));
            assert_ne!(row["projectId"], json!(case.projects[4]));
            let snippet = row["snippet"].as_str().unwrap();
            let range = &row["matchRanges"][0];
            let matched: String = snippet
                .encode_utf16()
                .skip(range["start"].as_u64().unwrap() as usize)
                .take((range["end"].as_u64().unwrap() - range["start"].as_u64().unwrap()) as usize)
                .map(|unit| char::from_u32(unit as u32).unwrap())
                .collect();
            assert_eq!(matched.to_ascii_lowercase(), "needle");
        }
        cursor = page["nextCursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            assert_eq!(page["hasMore"], false);
            break;
        }
        assert_eq!(page["hasMore"], true);
    }
    assert_eq!(seen.len(), 130); //125 historical + invited private + archived + own private + team + Personal
    assert!(seen.contains(&case.old_messages[0].to_string()));
    for (scope, expected) in [
        (format!("&orgId={}", case.org), 1),
        ("&personal=true".into(), 129),
        (
            format!("&projectId={}&orgId={}", case.projects[0], case.org),
            0,
        ),
    ] {
        let (_, page) = case
            .request(
                &format!("/search/messages?q=Needle&limit=50{scope}"),
                Some(&case.token),
            )
            .await?;
        assert_eq!(page["matches"].as_array().unwrap().len(), expected.min(50));
    }
    let (_, literal) = case
        .request(
            &format!("/search/messages?q={}", urlencoding::encode("50%_\\done")),
            Some(&case.token),
        )
        .await?;
    assert_eq!(literal["matches"].as_array().unwrap().len(), 1);
    let (status, greek) = case
        .request(
            &format!("/search/messages?q={}", urlencoding::encode("ΟΣ")),
            Some(&case.token),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{greek}");
    assert_eq!(greek["matches"].as_array().unwrap().len(), 1);
    assert_eq!(
        greek["matches"][0]["matchRanges"],
        json!([{ "start": 3, "end": 5 }, { "start": 8, "end": 10 }])
    );
    let (_, first) = case
        .request("/search/messages?q=Needle&limit=1", Some(&case.token))
        .await?;
    let cursor = first["nextCursor"].as_str().unwrap();
    let (status, _) = case
        .request(
            &format!("/search/messages?q=other&cursor={cursor}"),
            Some(&case.token),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = case
        .request(
            &format!("/search/messages?q=Needle&cursor={cursor}"),
            Some(&case.outsider_token),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    case.cleanup().await
}

#[tokio::test]
async fn message_search_http_exact_old_context_and_private_revocation() -> anyhow::Result<()> {
    let case = SearchCase::create().await?;
    let target = case.old_messages[7];
    let uri = format!(
        "/conversations/{}/messages/context?messageId={target}&before=3&after=3",
        case.conversation
    );
    let (status, page) = case.request(&uri, Some(&case.token)).await?;
    assert_eq!(status, StatusCode::OK, "{page}");
    assert_eq!(page["anchorMessageId"], json!(target));
    assert_eq!(
        page["messages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["id"].as_str().unwrap().to_owned())
            .collect::<Vec<_>>(),
        case.old_messages[4..=10]
            .iter()
            .rev()
            .map(Uuid::to_string)
            .collect::<Vec<_>>()
    );
    assert_eq!(page["hasOlder"], true);
    assert_eq!(page["hasNewer"], true);
    let (_, newer) = case
        .request(
            &format!(
                "/conversations/{}/messages/context?messageId={}&before=0&after=3",
                case.conversation,
                page["newerCursor"].as_str().unwrap()
            ),
            Some(&case.token),
        )
        .await?;
    assert_eq!(newer["messages"][0]["id"], json!(case.old_messages[13]));
    let (status, _) = case.request(&uri, Some(&case.outsider_token)).await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = case
        .request(
            &format!(
                "/conversations/{}/messages/context?messageId={target}",
                case.private
            ),
            Some(&case.token),
        )
        .await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let db = case.pool.get().await?;
    db.execute(
        "delete from conversation_participants where conversation_id=$1 and user_id=$2",
        &[&case.private, &case.viewer],
    )
    .await?;
    let message: Uuid = db
        .query_one(
            "select id from conversation_messages where conversation_id=$1 limit 1",
            &[&case.private],
        )
        .await?
        .get(0);
    drop(db);
    let (status, _) = case
        .request(
            &format!(
                "/conversations/{}/messages/context?messageId={message}",
                case.private
            ),
            Some(&case.token),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, page) = case
        .request(
            &format!("/search/messages?q=Needle&projectId={}", case.projects[0]),
            Some(&case.token),
        )
        .await?;
    assert!(page["matches"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["conversationId"] != json!(case.private)));
    case.cleanup().await
}
