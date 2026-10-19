//! Personal team slugs through `POST /orgs`, on the migrated database. A
//! client reuses the team at exactly `user-<its own id>` as its personal team,
//! so another user must not be able to create that slug first: neither by
//! sending it nor through a display name that slugifies to it. The owner and
//! the service role still can, and the derived personal pin still lands there.

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use axum::Router;
use serde_json::{json, Value as JsonValue};
use tower::ServiceExt;
use uuid::Uuid;

use crate::config::PgPool;
use crate::projects;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key,
};

/// Matches `supabase_service_role_key` in `build_app_config`.
const SERVICE_ROLE_TOKEN: &str = "service-role-token";

fn personal_slug(user_id: &Uuid) -> String {
    format!("user-{user_id}")
}

fn orgs_app(pool: &PgPool, key_id: &str) -> (Router, crate::config::AppConfig) {
    let config = build_app_config(test_origin_private_key(), test_origin_public_key(), key_id);
    let app = projects::router().with_state(build_test_state(pool.clone(), config.clone()));
    (app, config)
}

fn user_token(config: &crate::config::AppConfig, user_id: &Uuid) -> anyhow::Result<String> {
    Ok(crate::auth::issue_controller_token(config, user_id)
        .map_err(|(status, body)| anyhow::anyhow!("issue token: {status}: {}", body.0.message))?
        .token)
}

async fn post_org(
    app: &Router,
    token: &str,
    body: JsonValue,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/orgs")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .header(axum::http::header::AUTHORIZATION, format!("Bearer {token}"))
                .body(Body::from(body.to_string()))?,
        )
        .await?;
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await?;
    let payload = serde_json::from_slice(&bytes).unwrap_or(JsonValue::Null);
    Ok((status, payload))
}

fn org_id(payload: &JsonValue) -> anyhow::Result<Uuid> {
    let id = payload["orgId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("org creation response omitted orgId: {payload}"))?;
    Ok(Uuid::parse_str(id)?)
}

/// The (user, role) memberships of the org at `slug`, or None without one.
async fn slug_members(pool: &PgPool, slug: &str) -> anyhow::Result<Option<Vec<(Uuid, String)>>> {
    let connection = pool.get().await?;
    let Some(row) = connection
        .query_opt("select id from organizations where slug = $1", &[&slug])
        .await?
    else {
        return Ok(None);
    };
    let org_id: Uuid = row.get(0);
    let rows = connection
        .query(
            "select user_id, role from org_memberships where org_id = $1 order by role, user_id",
            &[&org_id],
        )
        .await?;
    Ok(Some(
        rows.iter()
            .map(|row| (row.get::<_, Uuid>(0), row.get::<_, String>(1)))
            .collect(),
    ))
}

/// Runs `body`, then deletes the orgs at the users' personal slugs (cascading
/// to memberships and billing rows) and the users, however the body ended.
async fn with_personal_slug_cleanup(
    pool: &PgPool,
    users: &[Uuid],
    body: impl std::future::Future<Output = anyhow::Result<()>>,
) -> anyhow::Result<()> {
    use futures_util::FutureExt;

    let outcome = std::panic::AssertUnwindSafe(body).catch_unwind().await;
    let slugs: Vec<String> = users.iter().map(personal_slug).collect();
    let cleanup = async {
        let connection = pool.get().await?;
        connection
            .execute("delete from organizations where slug = any($1)", &[&slugs])
            .await?;
        connection
            .execute("delete from auth.users where id = any($1)", &[&users])
            .await?;
        anyhow::Ok(())
    }
    .await;
    match outcome {
        Ok(result) => result.and(cleanup),
        Err(panic) => std::panic::resume_unwind(panic),
    }
}

#[test]
fn personal_slug_owner_reads_only_the_user_uuid_namespace() {
    let id = Uuid::new_v4();
    assert_eq!(
        projects::personal_slug_owner(&format!("user-{id}")),
        Some(id)
    );
    assert_eq!(
        projects::personal_slug_owner(&format!("user-{}", id.simple())),
        Some(id),
        "every spelling of the id is the same user's"
    );
    assert_eq!(projects::personal_slug_owner("user-research"), None);
    assert_eq!(
        projects::personal_slug_owner(&format!("user-{id}-team")),
        None
    );
    assert_eq!(projects::personal_slug_owner(&format!("team-{id}")), None);
}

#[tokio::test]
async fn create_organization_refuses_another_users_personal_slug() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("create_organization_refuses_another_users_personal_slug").await?;
    let victim = Uuid::new_v4();
    let squatter = Uuid::new_v4();
    ensure_test_user(&pool, &victim).await?;
    ensure_test_user(&pool, &squatter).await?;

    with_personal_slug_cleanup(&pool, &[victim, squatter], async {
        let (app, config) = orgs_app(&pool, "personal-slug-squat");
        let squatter_token = user_token(&config, &squatter)?;
        let victim_slug = personal_slug(&victim);

        for body in [
            json!({ "orgSlug": victim_slug, "orgName": "Personal team" }),
            // The slug is lowercased before it is stored (the column is citext).
            json!({ "orgSlug": victim_slug.to_ascii_uppercase(), "orgName": "Personal team" }),
            // A display name that slugifies to the victim's slug.
            json!({ "orgName": format!("User {victim}") }),
        ] {
            let (status, payload) = post_org(&app, &squatter_token, body.clone()).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}: {payload}");
            assert_eq!(payload["code"], "org_slug_reserved", "{body}");
        }
        assert_eq!(
            slug_members(&pool, &victim_slug).await?,
            None,
            "a refused squat must not create the victim's personal team"
        );

        // The victim's default team is still theirs alone.
        let victim_token = user_token(&config, &victim)?;
        let (status, payload) =
            post_org(&app, &victim_token, json!({ "orgName": "Personal team" })).await?;
        assert_eq!(status, StatusCode::OK, "{payload}");
        assert_eq!(payload["orgSlug"], victim_slug.as_str());
        assert_eq!(
            slug_members(&pool, &victim_slug).await?,
            Some(vec![(victim, "owner".to_string())])
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn create_organization_lets_a_user_claim_their_own_personal_slug() -> anyhow::Result<()> {
    let pool =
        require_origin_test_pool("create_organization_lets_a_user_claim_their_own_personal_slug")
            .await?;
    let owner = Uuid::new_v4();
    ensure_test_user(&pool, &owner).await?;

    with_personal_slug_cleanup(&pool, &[owner], async {
        let (app, config) = orgs_app(&pool, "personal-slug-own");
        let token = user_token(&config, &owner)?;
        let own_slug = personal_slug(&owner);

        let (status, payload) = post_org(
            &app,
            &token,
            json!({ "orgSlug": own_slug, "orgName": "Personal team" }),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{payload}");
        assert_eq!(payload["orgSlug"], own_slug.as_str());
        let personal_org_id = org_id(&payload)?;

        // The pins derived from the default label and from an empty body
        // resolve the same team, not a second one.
        for body in [json!({ "orgName": "Personal team" }), json!({})] {
            let (status, payload) = post_org(&app, &token, body.clone()).await?;
            assert_eq!(status, StatusCode::OK, "{body}: {payload}");
            assert_eq!(payload["orgSlug"], own_slug.as_str(), "{body}");
            assert_eq!(org_id(&payload)?, personal_org_id, "{body}");
        }
        assert_eq!(
            slug_members(&pool, &own_slug).await?,
            Some(vec![(owner, "owner".to_string())])
        );
        Ok(())
    })
    .await
}

#[tokio::test]
async fn create_organization_lets_the_service_role_provision_a_personal_slug() -> anyhow::Result<()>
{
    let pool = require_origin_test_pool(
        "create_organization_lets_the_service_role_provision_a_personal_slug",
    )
    .await?;
    let owner = Uuid::new_v4();
    ensure_test_user(&pool, &owner).await?;

    with_personal_slug_cleanup(&pool, &[owner], async {
        let (app, config) = orgs_app(&pool, "personal-slug-service");
        let owner_slug = personal_slug(&owner);

        let (status, payload) = post_org(
            &app,
            SERVICE_ROLE_TOKEN,
            json!({
                "orgSlug": owner_slug,
                "orgName": "Personal team",
                "ownerUserId": owner.to_string(),
            }),
        )
        .await?;
        assert_eq!(status, StatusCode::OK, "{payload}");
        assert_eq!(payload["orgSlug"], owner_slug.as_str());
        let provisioned_org_id = org_id(&payload)?;
        assert_eq!(
            slug_members(&pool, &owner_slug).await?,
            Some(vec![(owner, "owner".to_string())])
        );

        // The owner's own default request lands on the provisioned team.
        let token = user_token(&config, &owner)?;
        let (status, payload) =
            post_org(&app, &token, json!({ "orgName": "Personal team" })).await?;
        assert_eq!(status, StatusCode::OK, "{payload}");
        assert_eq!(org_id(&payload)?, provisioned_org_id);
        Ok(())
    })
    .await
}
