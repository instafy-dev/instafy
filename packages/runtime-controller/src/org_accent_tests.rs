use super::*;

async fn org_accent_request(
    app: &axum::Router,
    token: &str,
    method: &str,
    uri: &str,
    body: serde_json::Value,
) -> anyhow::Result<(StatusCode, serde_json::Value)> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))?,
        )
        .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
    Ok((
        status,
        if bytes.is_empty() {
            serde_json::Value::Null
        } else {
            serde_json::from_slice(&bytes)?
        },
    ))
}

#[tokio::test]
async fn org_accent_round_trips_requires_admin_and_preserves_other_identity() -> anyhow::Result<()>
{
    let pool = require_origin_test_pool("org accent HTTP authorization").await?;
    let users = [
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    ];
    let org = Uuid::new_v4();
    for user in users {
        ensure_test_user(&pool, &user).await?;
    }
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "org-accent-test",
    );
    let tokens = users
        .iter()
        .map(|user| {
            crate::auth::issue_controller_token(&config, user)
                .map(|token| token.token)
                .map_err(|error| controller_error("org accent token", error))
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let app = projects::router().with_state(build_test_state(pool.clone(), config));
    let db = pool.get().await?;
    db.execute("insert into organizations(id,slug,name,avatar_url) values($1,$2,'Accent team','https://example.test/logo.png')", &[&org, &format!("accent-{org}")]).await?;
    for (user, role) in users.iter().zip(["owner", "admin", "builder", "viewer"]) {
        db.execute(
            "insert into org_memberships(org_id,user_id,role) values($1,$2,$3)",
            &[&org, &user, &role],
        )
        .await?;
    }
    let uri = format!("/orgs/{org}");
    for token in &tokens[2..] {
        assert_eq!(
            org_accent_request(&app, token, "PATCH", &uri, json!({"accentColor":"blue"}))
                .await?
                .0,
            StatusCode::FORBIDDEN
        );
    }
    for value in [
        json!("#fff"),
        json!("url(https://example.test)"),
        json!("BLUE"),
        json!(""),
    ] {
        assert_eq!(
            org_accent_request(
                &app,
                &tokens[0],
                "PATCH",
                &uri,
                json!({"accentColor":value})
            )
            .await?
            .0,
            StatusCode::BAD_REQUEST
        );
    }
    for color in [
        "slate", "blue", "violet", "pink", "red", "orange", "green", "teal",
    ] {
        assert_eq!(
            org_accent_request(
                &app,
                &tokens[1],
                "PATCH",
                &uri,
                json!({"accentColor":color})
            )
            .await?
            .0,
            StatusCode::NO_CONTENT
        );
        // Every member sees the same identity, including viewers.
        let (status, result) =
            org_accent_request(&app, &tokens[3], "GET", "/orgs", json!(null)).await?;
        assert_eq!(status, StatusCode::OK);
        let item = result["orgs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["id"] == org.to_string())
            .unwrap();
        assert_eq!(item["accentColor"], color);
        assert_eq!(item["name"], "Accent team");
        assert_eq!(item["avatarUrl"], "https://example.test/logo.png");
    }
    assert_eq!(
        org_accent_request(
            &app,
            &tokens[0],
            "PATCH",
            &uri,
            json!({"name":"Renamed team"})
        )
        .await?
        .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        db.query_one(
            "select accent_color from organizations where id=$1",
            &[&org]
        )
        .await?
        .get::<_, String>(0),
        "teal"
    );
    assert_eq!(
        org_accent_request(&app, &tokens[0], "PATCH", &uri, json!({"accentColor":null}))
            .await?
            .0,
        StatusCode::NO_CONTENT
    );
    let row = db
        .query_one(
            "select name,accent_color from organizations where id=$1",
            &[&org],
        )
        .await?;
    assert_eq!(row.get::<_, String>(0), "Renamed team");
    assert!(row.get::<_, Option<String>>(1).is_none());
    assert!(db
        .execute(
            "update organizations set accent_color='unsafe' where id=$1",
            &[&org]
        )
        .await
        .is_err());
    drop(db);
    cleanup_org(&pool, &org).await?;
    for user in users {
        cleanup_test_user(&pool, &user).await?;
    }
    Ok(())
}

#[tokio::test]
async fn org_accent_create_is_atomic_and_idempotent_retries_preserve_color() -> anyhow::Result<()> {
    let pool = require_origin_test_pool("org accent creation").await?;
    let owner = Uuid::new_v4();
    ensure_test_user(&pool, &owner).await?;
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "org-accent-create",
    );
    let token = crate::auth::issue_controller_token(&config, &owner)
        .map_err(|error| controller_error("org accent token", error))?
        .token;
    let app = projects::router().with_state(build_test_state(pool.clone(), config));
    let slug = format!("accent-{owner}");
    let payload =
        |color: &str| json!({"orgName":"New accent team", "orgSlug":slug, "accentColor":color});
    assert_eq!(
        org_accent_request(&app, &token, "POST", "/orgs", payload("invalid"))
            .await?
            .0,
        StatusCode::BAD_REQUEST
    );
    let (status, created) =
        org_accent_request(&app, &token, "POST", "/orgs", payload("violet")).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(created["accentColor"], "violet");
    let (status, retried) =
        org_accent_request(&app, &token, "POST", "/orgs", payload("orange")).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(retried["orgId"], created["orgId"]);
    assert_eq!(retried["accentColor"], "violet");
    let org = Uuid::parse_str(created["orgId"].as_str().unwrap())?;
    cleanup_org(&pool, &org).await?;
    cleanup_test_user(&pool, &owner).await?;
    Ok(())
}
