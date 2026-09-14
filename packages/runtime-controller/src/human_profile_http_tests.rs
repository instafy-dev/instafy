//! Real-router public profile reads must retain both sides of exact-project access.
use super::*;

struct HumanProfileCase {
    pool: PgPool,
    app: axum::Router,
    project: Uuid,
    other_project: Uuid,
    org: Uuid,
    owner: Uuid,
    viewer: Uuid,
    target: Uuid,
    org_viewer: Uuid,
    outsider: Uuid,
    tokens: HashMap<Uuid, String>,
}

impl HumanProfileCase {
    async fn create() -> anyhow::Result<Self> {
        let pool = require_origin_test_pool("project member public profile authorization").await?;
        let owner = Uuid::new_v4();
        let viewer = Uuid::new_v4();
        let target = Uuid::new_v4();
        let org_viewer = Uuid::new_v4();
        let outsider = Uuid::new_v4();
        let users = [owner, viewer, target, org_viewer, outsider];
        for user in users {
            ensure_test_user(&pool, &user).await?;
        }
        let project = Uuid::new_v4();
        let other_project = Uuid::new_v4();
        let org = Uuid::new_v4();
        let db = pool.get().await?;
        db.execute(
            "insert into organizations(id,slug,name) values($1,$2,'Profile test team')",
            &[&org, &format!("profile-{org}")],
        )
        .await?;
        for (user, role) in [(owner, "owner"), (org_viewer, "viewer")] {
            db.execute(
                "insert into org_memberships(org_id,user_id,role) values($1,$2,$3)",
                &[&org, &user, &role],
            )
            .await?;
        }
        db.execute(
            "insert into projects(id,org_id,owner_user_id,name,project_type,status)
             values($1,$2,$3,'Profile test space','customer','active')",
            &[&project, &org, &owner],
        )
        .await?;
        db.execute(
            "insert into projects(id,owner_user_id,project_type,status)
             values($1,$2,'customer','active')",
            &[&other_project, &outsider],
        )
        .await?;
        for user in [viewer, target] {
            db.execute(
                "insert into project_memberships(project_id,user_id,role) values($1,$2,'viewer')",
                &[&project, &user],
            )
            .await?;
        }
        db.execute(
            "update auth.users set raw_user_meta_data=$2 where id=$1",
            &[&target, &json!({"full_name":"OAuth name","avatar_url":"https://example.invalid/oauth.png","email":"private@example.invalid"})],
        ).await?;
        db.execute(
            "insert into profiles(user_id,full_name,avatar_url,bio) values($1,'Saved name','https://example.invalid/saved.png','I build helpful tools.')
             on conflict(user_id) do update set full_name=excluded.full_name,avatar_url=excluded.avatar_url,bio=excluded.bio",
            &[&target],
        ).await?;
        drop(db);
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "human-profile-test",
        );
        let mut tokens = HashMap::new();
        for user in users {
            let token = crate::auth::issue_controller_token(&config, &user)
                .map_err(|error| controller_error("issue profile reader token", error))?
                .token;
            tokens.insert(user, token);
        }
        let app = projects::router().with_state(build_test_state(pool.clone(), config));
        Ok(Self {
            pool,
            app,
            project,
            other_project,
            org,
            owner,
            viewer,
            target,
            org_viewer,
            outsider,
            tokens,
        })
    }

    async fn read(
        &self,
        viewer: Option<Uuid>,
        target: Uuid,
    ) -> anyhow::Result<(StatusCode, serde_json::Value)> {
        let mut request = Request::builder().uri(format!(
            "/projects/{}/members/{target}/profile",
            self.project
        ));
        if let Some(viewer) = viewer {
            request = request.header("authorization", format!("Bearer {}", self.tokens[&viewer]));
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::empty())?)
            .await?;
        let status = response.status();
        let body = to_bytes(response.into_body(), 1024 * 1024).await?;
        Ok((status, serde_json::from_slice(&body)?))
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        cleanup_origin_project(&self.pool, &self.project).await?;
        cleanup_origin_project(&self.pool, &self.other_project).await?;
        cleanup_org(&self.pool, &self.org).await?;
        for user in [
            self.owner,
            self.viewer,
            self.target,
            self.org_viewer,
            self.outsider,
        ] {
            cleanup_test_user(&self.pool, &user).await?;
        }
        Ok(())
    }
}

#[tokio::test]
async fn human_profile_allows_current_project_grants_and_returns_only_public_fields(
) -> anyhow::Result<()> {
    let case = HumanProfileCase::create().await?;
    for viewer in [case.viewer, case.owner, case.org_viewer] {
        let (status, profile) = case.read(Some(viewer), case.target).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            profile,
            json!({
                "userId": case.target,
                "displayName": "Saved name",
                "avatarUrl": "https://example.invalid/saved.png",
                "bio": "I build helpful tools.",
            })
        );
    }
    // The target can hold an inherited organization grant rather than a direct row.
    assert_eq!(
        case.read(Some(case.viewer), case.org_viewer).await?.0,
        StatusCode::OK
    );
    assert_eq!(
        case.read(Some(case.viewer), case.owner).await?.0,
        StatusCode::OK
    );
    assert_eq!(
        case.read(Some(case.viewer), case.viewer).await?.0,
        StatusCode::OK
    );
    case.cleanup().await
}

#[tokio::test]
async fn human_profile_denies_outsiders_and_rechecks_revoked_viewer_and_target_access(
) -> anyhow::Result<()> {
    let case = HumanProfileCase::create().await?;
    assert_eq!(
        case.read(None, case.target).await?.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        case.read(Some(case.outsider), case.target).await?.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        case.read(Some(case.viewer), case.outsider).await?.0,
        StatusCode::FORBIDDEN
    );

    let db = case.pool.get().await?;
    db.execute(
        "delete from project_memberships where project_id=$1 and user_id=$2",
        &[&case.project, &case.target],
    )
    .await?;
    assert_eq!(
        case.read(Some(case.viewer), case.target).await?.0,
        StatusCode::FORBIDDEN
    );
    db.execute(
        "insert into project_memberships(project_id,user_id,role) values($1,$2,'viewer')",
        &[&case.project, &case.target],
    )
    .await?;
    db.execute(
        "delete from project_memberships where project_id=$1 and user_id=$2",
        &[&case.project, &case.viewer],
    )
    .await?;
    assert_eq!(
        case.read(Some(case.viewer), case.target).await?.0,
        StatusCode::FORBIDDEN
    );
    db.execute(
        "delete from org_memberships where org_id=$1 and user_id=$2",
        &[&case.org, &case.org_viewer],
    )
    .await?;
    assert_eq!(
        case.read(Some(case.org_viewer), case.target).await?.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        case.read(Some(case.owner), case.org_viewer).await?.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        case.read(Some(case.owner), case.target).await?.0,
        StatusCode::OK
    );
    db.execute(
        "update projects set status='deleted' where id=$1",
        &[&case.project],
    )
    .await?;
    assert_eq!(
        case.read(Some(case.owner), case.target).await?.0,
        StatusCode::NOT_FOUND
    );
    drop(db);
    case.cleanup().await
}

#[tokio::test]
async fn human_profile_saved_nulls_are_authoritative_and_bio_is_bounded_by_unicode_characters(
) -> anyhow::Result<()> {
    let case = HumanProfileCase::create().await?;
    let db = case.pool.get().await?;
    let bio = "🙂".repeat(500);
    db.execute(
        "update profiles set full_name=null,avatar_url=null,bio=$2 where user_id=$1",
        &[&case.target, &bio],
    )
    .await?;
    let (status, profile) = case.read(Some(case.viewer), case.target).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(profile["displayName"], serde_json::Value::Null);
    assert_eq!(profile["avatarUrl"], serde_json::Value::Null);
    assert_eq!(profile["bio"], bio);
    let error = db
        .execute(
            "update profiles set bio=$2 where user_id=$1",
            &[&case.target, &"🙂".repeat(501)],
        )
        .await
        .unwrap_err();
    assert_eq!(
        error.as_db_error().and_then(|error| error.constraint()),
        Some("profiles_bio_length")
    );
    db.execute(
        "update profiles set bio=null where user_id=$1",
        &[&case.target],
    )
    .await?;
    assert_eq!(
        case.read(Some(case.viewer), case.target).await?.1["bio"],
        serde_json::Value::Null
    );
    db.execute("delete from profiles where user_id=$1", &[&case.target])
        .await?;
    let (_, fallback) = case.read(Some(case.viewer), case.target).await?;
    assert_eq!(
        fallback,
        json!({
            "userId": case.target, "displayName": "OAuth name", "avatarUrl": "https://example.invalid/oauth.png", "bio": null,
        })
    );
    drop(db);
    case.cleanup().await
}

#[tokio::test]
async fn human_profile_missing_row_defaults_skip_private_or_malformed_claims_in_name_order(
) -> anyhow::Result<()> {
    let case = HumanProfileCase::create().await?;
    let db = case.pool.get().await?;
    db.execute("delete from profiles where user_id=$1", &[&case.target])
        .await?;
    let name_keys = [
        "full_name",
        "name",
        "display_name",
        "user_name",
        "preferred_username",
        "username",
    ];
    for (selected, key) in name_keys.iter().enumerate() {
        let mut metadata = json!({
            "email": "private@example.invalid",
            "avatar_url": { "url": "https://example.invalid/invalid.png" },
            "picture": " \t https://example.invalid/picture.png\n\u{feff}",
        });
        for (index, name_key) in name_keys.iter().enumerate() {
            metadata[*name_key] = if index < selected {
                match index % 3 {
                    0 => json!("  private@example.invalid "),
                    1 => json!(42),
                    _ => json!({ "name": "Not a string" }),
                }
            } else if index == selected {
                json!(format!(" \t Person\u{00a0}\n {index}\u{feff} "))
            } else {
                json!("Lower priority name")
            };
        }
        db.execute(
            "update auth.users set raw_user_meta_data=$2 where id=$1",
            &[&case.target, &metadata],
        )
        .await?;
        let (status, profile) = case.read(Some(case.viewer), case.target).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            profile,
            json!({
                "userId": case.target, "displayName": format!("Person {selected}"),
                "avatarUrl": "https://example.invalid/picture.png", "bio": null,
            }),
            "fallback from {key} must match browser defaults"
        );
    }

    for metadata in [
        json!({ "full_name": "private@example.invalid", "name": ["Not a name"], "display_name": true,
                "user_name": "\u{feff}\n", "preferred_username": false, "username": "other@example.invalid",
                "avatar_url": 17, "picture": ["https://example.invalid/not-a-photo.png"] }),
        json!(["Not a metadata object"]),
    ] {
        db.execute(
            "update auth.users set raw_user_meta_data=$2 where id=$1",
            &[&case.target, &metadata],
        )
        .await?;
        assert_eq!(
            case.read(Some(case.viewer), case.target).await?.1,
            json!({
                "userId": case.target, "displayName": null, "avatarUrl": null, "bio": null,
            })
        );
    }
    db.execute("update auth.users set raw_user_meta_data=$2 where id=$1", &[&case.target, &json!({
        "name": "Fallback name", "avatar_url": " \t https://example.invalid/avatar.png\u{feff}",
        "picture": "https://example.invalid/lower-priority.png",
    })]).await?;
    assert_eq!(
        case.read(Some(case.viewer), case.target).await?.1["avatarUrl"],
        "https://example.invalid/avatar.png"
    );

    // Values chosen and saved by the person are not metadata defaults: even an
    // email-shaped chosen name or intentional whitespace remains authoritative.
    db.execute(
        "insert into profiles(user_id,full_name,avatar_url,bio) values($1,$2,$3,null)",
        &[
            &case.target,
            &"  Chosen  person@example.invalid  ",
            &" https://example.invalid/chosen.png ",
        ],
    )
    .await?;
    assert_eq!(
        case.read(Some(case.viewer), case.target).await?.1,
        json!({
            "userId": case.target, "displayName": "  Chosen  person@example.invalid  ",
            "avatarUrl": " https://example.invalid/chosen.png ", "bio": null,
        })
    );
    drop(db);
    case.cleanup().await
}
