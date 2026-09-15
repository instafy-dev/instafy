use super::*;

#[tokio::test]
async fn project_identity_round_trips_preserves_name_and_requires_write_access(
) -> anyhow::Result<()> {
    let pool = setup_origin_test_pool().await?.ok_or_else(|| {
        anyhow::anyhow!("TEST_DATABASE_URL is required for project identity integration proof")
    })?;
    let owner_id = Uuid::new_v4();
    let viewer_id = Uuid::new_v4();
    let builder_id = Uuid::new_v4();
    let outsider_id = Uuid::new_v4();
    let project_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    {
        let db = pool.get().await?;
        // Only identity rows are needed. This also works on the pinned fresh
        // Postgres image before the separate GoTrue service upgrades auth.users.
        for user_id in [owner_id, viewer_id, builder_id, outsider_id] {
            db.execute(
                "insert into auth.users (id, email, created_at, updated_at) values ($1, $2, now(), now())",
                &[&user_id, &format!("identity-{user_id}@example.invalid")],
            ).await?;
        }
        db.execute(
            "insert into organizations (id, slug, name) values ($1, $2, 'Identity test team')",
            &[&org_id, &format!("identity-{org_id}")],
        )
        .await?;
        db.execute(
            "insert into org_memberships (org_id, user_id, role) values ($1, $2, 'owner')",
            &[&org_id, &owner_id],
        )
        .await?;
        db.execute("insert into projects (id, org_id, owner_user_id, name, project_type, status) values ($1, $2, $3, 'Identity test space', 'customer', 'active')", &[&project_id, &org_id, &owner_id]).await?;
        db.execute(
            "insert into project_memberships (project_id, user_id, role) values ($1, $2, 'viewer')",
            &[&project_id, &viewer_id],
        )
        .await?;
    }
    {
        let db = pool.get().await?;
        db.execute("insert into project_memberships (project_id, user_id, role) values ($1, $2, 'builder')", &[&project_id, &builder_id]).await?;
    }
    let config = build_app_config(
        test_origin_private_key(),
        test_origin_public_key(),
        "space-identity-test",
    );
    let owner = crate::auth::issue_controller_token(&config, &owner_id)
        .map_err(|e| controller_error("owner token", e))?
        .token;
    let viewer = crate::auth::issue_controller_token(&config, &viewer_id)
        .map_err(|e| controller_error("viewer token", e))?
        .token;
    let builder = crate::auth::issue_controller_token(&config, &builder_id)
        .map_err(|e| controller_error("builder token", e))?
        .token;
    let outsider = crate::auth::issue_controller_token(&config, &outsider_id)
        .map_err(|e| controller_error("outsider token", e))?
        .token;
    let app = projects::router().with_state(build_test_state(pool.clone(), config));
    for (token, payload, expected) in [
        (&viewer, json!({"projectIcon": "🚀"}), StatusCode::FORBIDDEN),
        (
            &viewer,
            json!({"projectAvatarUrl": "https://example.invalid/picture.png"}),
            StatusCode::FORBIDDEN,
        ),
        (
            &outsider,
            json!({"projectAvatarUrl": "https://example.invalid/picture.png"}),
            StatusCode::FORBIDDEN,
        ),
        (
            &owner,
            json!({"projectAvatarUrl": "javascript:alert(1)"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            &owner,
            json!({"projectAvatarUrl": "http://example.invalid/picture.png"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            &owner,
            json!({"projectAvatarUrl": "https://user:password@example.invalid/picture.png"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            &builder,
            json!({"projectAvatarUrl": "https://example.invalid/picture.png"}),
            StatusCode::OK,
        ),
        (
            &owner,
            json!({"projectIcon": "<svg>"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            &owner,
            json!({"projectColor": "#ffffff"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            &owner,
            json!({"projectIcon": "🚀", "projectColor": "blue"}),
            StatusCode::OK,
        ),
        (
            &owner,
            json!({"projectName": "Renamed identity space"}),
            StatusCode::OK,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri(format!("/projects/{project_id}"))
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(payload.to_string()))?,
            )
            .await?;
        assert_eq!(response.status(), expected);
    }
    for uri in [
        format!("/projects/{project_id}"),
        "/projects".to_string(),
        format!("/orgs/{org_id}/projects"),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(&uri)
                    .header("authorization", format!("Bearer {owner}"))
                    .body(Body::empty())?,
            )
            .await?;
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await?)?;
        let summary = if body["projects"].is_array() {
            body["projects"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["projectId"] == project_id.to_string())
                .unwrap()
        } else {
            &body
        };
        assert_eq!(summary["projectIcon"], "🚀");
        assert_eq!(summary["projectColor"], "blue");
        assert_eq!(
            summary["projectAvatarUrl"],
            "https://example.invalid/picture.png"
        );
        assert_eq!(summary["projectName"], "Renamed identity space");
    }
    let response = app
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri(format!("/projects/{project_id}"))
                .header("authorization", format!("Bearer {owner}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"projectIcon": null, "projectColor": null, "projectAvatarUrl": null})
                        .to_string(),
                ))?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::OK);
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 1024 * 1024).await?)?;
    assert!(body["projectIcon"].is_null());
    assert!(body["projectColor"].is_null());
    assert!(body["projectAvatarUrl"].is_null());
    assert_eq!(body["projectName"], "Renamed identity space");
    // The storage policy and controller agree on inherited/explicit write access.
    for (user, space_write, org_write) in [
        (owner_id, true, true),
        (builder_id, true, false),
        (viewer_id, false, false),
        (outsider_id, false, false),
    ] {
        let mut db = pool.get().await?;
        let tx = db.transaction().await?;
        tx.execute(
            "select set_config('request.jwt.claim.sub', $1, true)",
            &[&user.to_string()],
        )
        .await?;
        for (kind, id, allowed) in [
            ("spaces", project_id, space_write),
            ("orgs", org_id, org_write),
        ] {
            let path = format!("{kind}/{id}/{}.png", Uuid::new_v4());
            let row = tx
                .query_one("select public.can_manage_identity_image($1)", &[&path])
                .await?;
            assert_eq!(
                row.get::<_, bool>(0),
                allowed,
                "{kind} permission for {user}"
            );
        }
        let invalid = format!("spaces/{project_id}/../outside.png");
        let row = tx
            .query_one("select public.can_manage_identity_image($1)", &[&invalid])
            .await?;
        assert!(!row.get::<_, bool>(0));
        tx.rollback().await?;
    }
    let db = pool.get().await?;
    assert!(db
        .execute(
            "update projects set icon = 'unsafe' where id = $1",
            &[&project_id]
        )
        .await
        .is_err());
    assert!(db
        .execute(
            "update projects set color = 'unsafe' where id = $1",
            &[&project_id]
        )
        .await
        .is_err());
    drop(db);
    cleanup_origin_project(&pool, &project_id).await?;
    cleanup_org(&pool, &org_id).await?;
    cleanup_test_user(&pool, &owner_id).await?;
    cleanup_test_user(&pool, &viewer_id).await?;
    cleanup_test_user(&pool, &builder_id).await?;
    cleanup_test_user(&pool, &outsider_id).await?;
    Ok(())
}
