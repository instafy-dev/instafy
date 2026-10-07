use super::*;

fn review_body() -> JsonValue {
    json!({
        "name":"Friday check-in", "mode":"space_review", "scheduleKind":"weekly",
        "byDay":["fr"], "byHour":9, "byMinute":0, "timezone":"Europe/Vienna",
        "runtimeMode":"existing"
    })
}

async fn review_count(f: &Fixture) -> anyhow::Result<i64> {
    Ok(f.state
        .pool
        .get()
        .await?
        .query_one(
            "select count(*) from automations where project_id=$1 and mode='space_review'",
            &[&f.project],
        )
        .await?
        .get(0))
}

#[tokio::test]
async fn automation_review_creation_live_user_job_keeps_managed_private_schedule(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let (_, token) = f.job().await?;
    let path = format!("/projects/{}/automations", f.project);
    let mut body = review_body();
    body["promptText"] = json!("A client cannot replace the managed review prompt.");
    body["silentWhenNothingToReport"] = json!(false);
    let (status, created) = f.request(&token, "POST", &path, body).await?;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(created["mode"], "space_review");
    assert_eq!(created["promptText"], SPACE_REVIEW_PROMPT);
    assert_eq!(created["resultVisibility"], "private");
    assert_eq!(created["silentWhenNothingToReport"], true);
    let record = f
        .record(Uuid::parse_str(created["id"].as_str().unwrap())?)
        .await?;
    assert_eq!(record.user_id, f.user);
    let next = record
        .next_run_at
        .unwrap()
        .with_timezone(&chrono_tz::Europe::Vienna);
    assert_eq!(next.weekday(), chrono::Weekday::Fri);
    assert_eq!((next.hour(), next.minute()), (9, 0));
    let db = f.state.pool.get().await?;
    let anchor = db
        .query_one(
            "select created_by,visibility,internal_purpose from conversations where id=$1",
            &[&record.conversation_id],
        )
        .await?;
    assert_eq!(anchor.get::<_, Uuid>("created_by"), f.user);
    assert_eq!(anchor.get::<_, String>("visibility"), "private");
    assert_eq!(anchor.get::<_, String>("internal_purpose"), "space_review");
    assert_eq!(
        db.query_one(
            "select count(*) from agent_jobs where project_id=$1",
            &[&f.project]
        )
        .await?
        .get::<_, i64>(0),
        1,
        "creating a schedule must not dispatch another job"
    );
    drop(db);
    let (status, duplicate) = f.request(&token, "POST", &path, review_body()).await?;
    assert_eq!(status, StatusCode::CONFLICT, "{duplicate}");
    assert_eq!(review_count(&f).await?, 1);

    // Creation does not turn this job into a private-anchor reader.
    let app = crate::conversations::router().with_state(f.state.clone());
    let response = app
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/conversations/{}/messages",
                    record.conversation_id.unwrap()
                ))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())?,
        )
        .await?;
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    f.cleanup().await
}

#[tokio::test]
async fn automation_review_creation_write_member_owns_their_own_review() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let project_owner = Uuid::new_v4();
    ensure_test_user(&f.state.pool, &project_owner).await?;
    let db = f.state.pool.get().await?;
    db.execute(
        "update projects set owner_user_id=$2 where id=$1",
        &[&f.project, &project_owner],
    )
    .await?;
    db.execute(
        "insert into project_memberships(project_id,user_id,role) values($1,$2,'builder')",
        &[&f.project, &f.user],
    )
    .await?;
    drop(db);
    let (_, token) = f.job().await?;
    let (status, created) = f
        .request(
            &token,
            "POST",
            &format!("/projects/{}/automations", f.project),
            review_body(),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{created}");
    assert_eq!(
        f.record(Uuid::parse_str(created["id"].as_str().unwrap())?)
            .await?
            .user_id,
        f.user
    );
    f.state
        .pool
        .get()
        .await?
        .execute(
            "update projects set owner_user_id=$2 where id=$1",
            &[&f.project, &f.user],
        )
        .await?;
    f.state
        .pool
        .get()
        .await?
        .execute("delete from auth.users where id=$1", &[&project_owner])
        .await?;
    f.cleanup().await
}

#[tokio::test]
async fn automation_review_creation_rejects_background_provenance_without_mutation(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let (job, token) = f.job().await?;
    let path = format!("/projects/{}/automations", f.project);
    for metadata in [
        json!({"spaceReview":{"enforcedBy":"runtime-controller"}}),
        json!({"automation":{"id":Uuid::new_v4()}}),
    ] {
        f.state
            .pool
            .get()
            .await?
            .execute(
                "update agent_jobs set payload=jsonb_set(payload,'{metadata}',$2) where id=$1",
                &[&job, &PgJson(metadata)],
            )
            .await?;
        let (status, body) = f.request(&token, "POST", &path, review_body()).await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    }
    let db = f.state.pool.get().await?;
    db.execute(
        "update agent_jobs set payload=jsonb_set(payload,'{metadata}','{}') where id=$1",
        &[&job],
    )
    .await?;
    let chat: Uuid = db
        .query_one(
            "select conversation_id from agent_jobs where id=$1",
            &[&job],
        )
        .await?
        .get(0);
    // Conversation provenance still refuses a job without the metadata marker.
    for (kind, purpose) in [(Some("automation"), None), (None, Some("space_review"))] {
        db.execute(
            "update conversations set thread_kind=$2,internal_purpose=$3 where id=$1",
            &[&chat, &kind, &purpose],
        )
        .await?;
        let (status, body) = f.request(&token, "POST", &path, review_body()).await?;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    }
    db.execute(
        "update conversations set thread_kind=null,internal_purpose=null where id=$1",
        &[&chat],
    )
    .await?;
    let root = Uuid::new_v4();
    db.execute("insert into conversations(id,project_id,created_by,thread_kind,visibility) values($1,$2,$3,'automation','public')", &[&root,&f.project,&f.user]).await?;
    db.execute(
        "update conversations set parent_conversation_id=$2,root_conversation_id=$2 where id=$1",
        &[&chat, &root],
    )
    .await?;
    drop(db);
    let (status, body) = f.request(&token, "POST", &path, review_body()).await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(review_count(&f).await?, 0);
    f.cleanup().await
}

#[tokio::test]
async fn automation_review_creation_requires_exact_live_user_project_authority(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let other = Fixture::new().await?;
    let (job, token) = f.job().await?;
    let path = format!("/projects/{}/automations", f.project);
    let (status, body) = f
        .request(
            &token,
            "POST",
            &format!("/projects/{}/automations", other.project),
            review_body(),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let mut team = review_body();
    team["resultVisibility"] = json!("team");
    assert_eq!(
        f.request(&token, "POST", &path, team).await?.0,
        StatusCode::BAD_REQUEST
    );

    let db = f.state.pool.get().await?;
    db.execute(
        "update projects set owner_user_id=$2 where id=$1",
        &[&f.project, &other.user],
    )
    .await?;
    let (status, body) = f.request(&token, "POST", &path, review_body()).await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    db.execute(
        "update projects set owner_user_id=$2 where id=$1",
        &[&f.project, &f.user],
    )
    .await?;
    for sql in [
        "update agent_jobs set lease_expires_at=now()-interval '1 second' where id=$1",
        "update agent_jobs set lease_expires_at=now()+interval '5 minutes',status='succeeded' where id=$1",
    ] {
        db.execute(sql,&[&job]).await?;
        let (status, body) = f.request(&token,"POST",&path,review_body()).await?;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    }
    db.execute("update agent_jobs set status='leased' where id=$1", &[&job])
        .await?;
    db.execute("update runtime_leases set status='released',released_at=now() where id=(select active_lease_id from runtimes where id=(select leased_by_runtime_id from agent_jobs where id=$1))", &[&job]).await?;
    let (status, body) = f.request(&token, "POST", &path, review_body()).await?;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    drop(db);
    assert_eq!(review_count(&f).await?, 0);
    assert_eq!(review_count(&other).await?, 0);
    f.cleanup().await?;
    other.cleanup().await
}

#[tokio::test]
async fn automation_review_creation_does_not_upgrade_service_jobs() -> anyhow::Result<()> {
    let mut f = Fixture::new().await?;
    let (job, token) = f.job().await?;
    f.state.config.service_runtime_user_id = Some(f.user);
    f.app = router().with_state(f.state.clone());
    f.state
        .pool
        .get()
        .await?
        .execute(
            "update agent_jobs set payload=payload-'user_id' where id=$1",
            &[&job],
        )
        .await?;
    let (status, body) = f
        .request(
            &token,
            "POST",
            &format!("/projects/{}/automations", f.project),
            review_body(),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(review_count(&f).await?, 0);
    f.cleanup().await
}
