use super::*;
use crate::tests::{
    build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
    test_origin_private_key, test_origin_public_key,
};
use crate::tokens::{mint_scoped_token, ScopedTokenRequest};
use axum::body::{to_bytes, Body};
use axum::http::Request;
use chrono::{Datelike, Timelike};
use tower::ServiceExt;

struct Fixture {
    state: AppState,
    app: Router,
    user: Uuid,
    project: Uuid,
    token: String,
}

fn api<T>(result: Result<T, (StatusCode, Json<ApiError>)>) -> anyhow::Result<T> {
    result.map_err(|(_, e)| anyhow::anyhow!(e.0.message))
}

impl Fixture {
    async fn new() -> anyhow::Result<Self> {
        let pool = require_origin_test_pool("automation cadence").await?;
        let user = Uuid::new_v4();
        let project = Uuid::new_v4();
        ensure_test_user(&pool, &user).await?;
        pool.get().await?.execute("insert into projects(id,owner_user_id,name,project_type,status) values($1,$2,'Cadence fixture','customer','active')", &[&project,&user]).await?;
        let config = build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "automation-cadence",
        );
        let token = api(crate::auth::issue_controller_token(&config, &user))?.token;
        let state = build_test_state(pool, config);
        let app = router().with_state(state.clone());
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
        token: &str,
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
                    .header("authorization", format!("Bearer {token}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))?,
            )
            .await?;
        let status = response.status();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await?;
        Ok((status, serde_json::from_slice(&bytes)?))
    }

    async fn create(&self, mode: &str) -> anyhow::Result<AutomationRecord> {
        let (status, body) = self
            .request(
                &self.token,
                "POST",
                &format!("/projects/{}/automations", self.project),
                json!({
                    "name":"Check in", "mode":mode, "scheduleKind":"hourly", "intervalHours":24,
                    "timezone":"Europe/Vienna", "runtimeMode":"existing"
                }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        self.record(Uuid::parse_str(body["id"].as_str().unwrap())?)
            .await
    }

    async fn record(&self, id: Uuid) -> anyhow::Result<AutomationRecord> {
        let row = self
            .state
            .pool
            .get()
            .await?
            .query_one("select * from automations where id=$1", &[&id])
            .await?;
        Ok(row_to_record(&row))
    }

    async fn job(&self) -> anyhow::Result<(Uuid, String)> {
        let runtime = Uuid::new_v4();
        let lease = Uuid::new_v4();
        let chat = Uuid::new_v4();
        let run = Uuid::new_v4();
        let job = Uuid::new_v4();
        let db = self.state.pool.get().await?;
        db.execute(
            "insert into runtimes(id,project_id,provider,status) values($1,$2,'default','running')",
            &[&runtime, &self.project],
        )
        .await?;
        db.execute("insert into runtime_leases(id,project_id,runtime_id,status,launched_at) values($1,$2,$3,'active',now())", &[&lease,&self.project,&runtime]).await?;
        db.execute(
            "update runtimes set active_lease_id=$2 where id=$1",
            &[&runtime, &lease],
        )
        .await?;
        db.execute("insert into conversations(id,project_id,created_by,metadata,visibility) values($1,$2,$3,'{}','public')", &[&chat,&self.project,&self.user]).await?;
        db.execute("insert into runs(id,project_id,conversation_id,run_type,status) values($1,$2,$3,'prompt','in_progress')", &[&run,&self.project,&chat]).await?;
        db.execute("insert into agent_jobs(id,project_id,run_id,conversation_id,status,payload,leased_by_runtime_id,leased_at,lease_expires_at) values($1,$2,$3,$4,'leased',$5,$6,now(),now()+interval '5 minutes')", &[&job,&self.project,&run,&chat,&PgJson(json!({"user_id":self.user,"metadata":{}})),&runtime]).await?;
        let token = api(mint_scoped_token(
            &self.state.config,
            ScopedTokenRequest {
                audience: runtime.to_string(),
                subject: self.user.to_string(),
                project_id: self.project.to_string(),
                origin_id: None,
                runtime_id: Some(runtime.to_string()),
                protocol: None,
                scopes: vec![
                    "prompt.execute".into(),
                    "job.token.workspace-separated".into(),
                ],
                lease_id: Some(lease.to_string()),
                run_id: Some(run.to_string()),
                prefer_runtime: None,
                ttl_seconds: Some(300),
            },
        ))?
        .token;
        Ok((job, token))
    }

    async fn cleanup(self) -> anyhow::Result<()> {
        let db = self.state.pool.get().await?;
        db.execute("delete from runs where project_id=$1", &[&self.project])
            .await?;
        db.execute("delete from projects where id=$1", &[&self.project])
            .await?;
        db.execute("delete from auth.users where id=$1", &[&self.user])
            .await?;
        Ok(())
    }
}

#[tokio::test]
async fn automation_cadence_live_owner_job_can_reschedule_but_cannot_rewrite_review(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let review = f.create("space_review").await?;
    let path = format!("/automations/{}", review.id);
    let (job, token) = f.job().await?;
    let (status, weekly) = f.request(&token,"PATCH",&path,json!({
        "scheduleKind":"weekly", "byDay":["sa","su"], "byHour":10, "byMinute":30, "timezone":"Europe/Vienna"
    })).await?;
    assert_eq!(status, StatusCode::OK, "{weekly}");
    assert_eq!(weekly["id"], review.id.to_string());
    assert_eq!(
        weekly["conversationId"],
        review.conversation_id.unwrap().to_string()
    );
    assert_eq!(weekly["promptText"], SPACE_REVIEW_PROMPT);
    assert_eq!(weekly["resultVisibility"], "private");
    assert_eq!(weekly["silentWhenNothingToReport"], true);
    let next = DateTime::parse_from_rfc3339(weekly["nextRunAt"].as_str().unwrap())?
        .with_timezone(&chrono_tz::Europe::Vienna);
    assert!(matches!(
        next.weekday(),
        chrono::Weekday::Sat | chrono::Weekday::Sun
    ));
    assert_eq!((next.hour(), next.minute()), (10, 30));

    let once_at = (Utc::now() + ChronoDuration::hours(6)).to_rfc3339();
    for patch in [
        json!({"scheduleKind":"once","runAt":once_at}),
        json!({"scheduleKind":"hourly","intervalHours":72}),
        json!({"status":"paused"}),
        json!({"status":"active"}),
    ] {
        let (status, body) = f.request(&token, "PATCH", &path, patch).await?;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    for patch in [
        json!({"name":"Different job"}),
        json!({"promptText":"Other work"}),
        json!({"metadata":{}}),
        json!({"runtimeMode":"hosted"}),
        json!({"runtimeProvider":"other"}),
        json!({"silentWhenNothingToReport":false}),
        json!({"resultVisibility":"team"}),
        json!({"mode":"space_review"}),
    ] {
        assert_eq!(
            f.request(&token, "PATCH", &path, patch).await?.0,
            StatusCode::FORBIDDEN
        );
    }
    for patch in [
        json!({"scheduleKind":"invalid"}),
        json!({"timezone":"Mars/Phobos"}),
        json!({"scheduleKind":"weekly","byDay":["sa"],"byHour":24,"byMinute":0}),
    ] {
        assert_eq!(
            f.request(&token, "PATCH", &path, patch).await?.0,
            StatusCode::BAD_REQUEST
        );
    }

    // This is actual persisted controller provenance, not request metadata.
    f.state.pool.get().await?.execute("update agent_jobs set payload=jsonb_set(payload,'{metadata}', $2) where id=$1", &[&job,&PgJson(json!({"spaceReview":{"automationId":review.id,"enforcedBy":"runtime-controller"}}))]).await?;
    for patch in [json!({"intervalHours":96}), json!({"status":"paused"})] {
        assert_eq!(
            f.request(&token, "PATCH", &path, patch).await?.0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(f.record(review.id).await?.interval_hours, Some(72));
    assert_eq!(f.record(review.id).await?.status, "active");
    f.cleanup().await
}

#[tokio::test]
async fn automation_cadence_jobs_remain_bound_to_owner_project_and_live_lease() -> anyhow::Result<()>
{
    let f = Fixture::new().await?;
    let other = Fixture::new().await?;
    let own = f.create("prompt").await?;
    let foreign = other.create("prompt").await?;
    let (job, token) = f.job().await?;
    let own_path = format!("/automations/{}", own.id);
    let foreign_path = format!("/automations/{}", foreign.id);
    assert_eq!(
        f.request(&token, "PATCH", &foreign_path, json!({"intervalHours":48}))
            .await?
            .0,
        StatusCode::FORBIDDEN
    );

    // An automation in the caller's space remains private to its different owner.
    f.state
        .pool
        .get()
        .await?
        .execute(
            "update automations set user_id=$2 where id=$1",
            &[&own.id, &other.user],
        )
        .await?;
    assert_eq!(
        f.request(&token, "PATCH", &own_path, json!({"intervalHours":48}))
            .await?
            .0,
        StatusCode::FORBIDDEN
    );
    f.state
        .pool
        .get()
        .await?
        .execute(
            "update automations set user_id=$2 where id=$1",
            &[&own.id, &f.user],
        )
        .await?;
    f.state
        .pool
        .get()
        .await?
        .execute(
            "update agent_jobs set lease_expires_at=now()-interval '1 second' where id=$1",
            &[&job],
        )
        .await?;
    assert_eq!(
        f.request(&token, "PATCH", &own_path, json!({"intervalHours":48}))
            .await?
            .0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(f.record(own.id).await?.interval_hours, Some(24));
    f.cleanup().await?;
    other.cleanup().await
}

#[tokio::test]
async fn automation_cadence_one_shot_changes_reject_past_and_ambiguous_times_without_mutation(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let initial = f.create("prompt").await?;
    let path = format!("/automations/{}", initial.id);
    let create_path = format!("/projects/{}/automations", f.project);
    let (_, token) = f.job().await?;
    let unchanged = serde_json::to_value(record_to_payload(f.record(initial.id).await?))?;
    for run_at in [
        "2000-01-10T20:00:00",
        "2099-03-29T02:30:00", // Europe/Vienna spring gap.
        "2099-10-25T02:30:00", // Europe/Vienna autumn overlap.
    ] {
        for actor in [&f.token, &token] {
            let (status, result) = f
                .request(
                    actor,
                    "PATCH",
                    &path,
                    json!({"scheduleKind":"once","runAt":run_at,"timezone":"Europe/Vienna"}),
                )
                .await?;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{run_at}: {result}");
            assert_eq!(
                serde_json::to_value(record_to_payload(f.record(initial.id).await?))?,
                unchanged,
                "a rejected date must preserve the schedule and its pending run"
            );
            let (status, result) = f
                .request(
                    actor,
                    "POST",
                    &create_path,
                    json!({"name":"Reminder","promptText":"Remind me to review the draft.","scheduleKind":"once","runAt":run_at,"timezone":"Europe/Vienna"}),
                )
                .await?;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{run_at}: {result}");
        }
    }
    let db = f.state.pool.get().await?;
    assert_eq!(
        db.query_one(
            "select count(*) from automations where project_id=$1",
            &[&f.project]
        )
        .await?
        .get::<_, i64>(0),
        1
    );
    drop(db);

    let mut overlap_times = Vec::new();
    for (run_at, expected) in [
        ("2099-10-25T02:30:00+02:00", "2099-10-25T00:30:00Z"),
        ("2099-10-25T02:30:00+01:00", "2099-10-25T01:30:00Z"),
        // Preserve the existing API's local datetime with a space separator.
        ("2099-01-10 20:00", "2099-01-10T19:00:00Z"),
    ] {
        let (status, result) = f
            .request(
                &token,
                "PATCH",
                &path,
                json!({"scheduleKind":"once","runAt":run_at,"timezone":"Europe/Vienna"}),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{result}");
        let saved = f.record(initial.id).await?;
        assert_eq!(saved.run_at, Some(expected.parse::<DateTime<Utc>>()?));
        assert_eq!(saved.next_run_at, saved.run_at);
        overlap_times.push(saved.run_at.unwrap());
    }
    assert_eq!((overlap_times[1] - overlap_times[0]).num_hours(), 1);

    // Resuming an existing elapsed one-shot without supplying a new date keeps
    // its established behavior. Only an explicitly changed runAt is rejected.
    f.state.pool.get().await?.execute(
        "update automations set status='paused',run_at=now()-interval '1 hour',next_run_at=now()-interval '1 hour' where id=$1",
        &[&initial.id],
    ).await?;
    let before_resume = Utc::now();
    let (status, result) = f
        .request(&token, "PATCH", &path, json!({"status":"active"}))
        .await?;
    assert_eq!(status, StatusCode::OK, "{result}");
    let resumed = f.record(initial.id).await?;
    assert_eq!(resumed.status, "active");
    assert!(resumed.run_at.unwrap() < before_resume);
    assert!(resumed.next_run_at.unwrap() >= before_resume);
    f.cleanup().await
}

#[tokio::test]
async fn automation_cadence_manual_run_finalizes_the_dispatched_schedule_snapshot(
) -> anyhow::Result<()> {
    let mut f = Fixture::new().await?;
    // Exercise the real run route and asynchronous finalization without any
    // external model credentials or managed-AI provisioning.
    f.state.config.managed_ai_enabled = false;
    f.app = router().with_state(f.state.clone());
    let initial = f.create("prompt").await?;
    let path = format!("/automations/{}", initial.id);
    for once in [false, true] {
        if once {
            let (status, body) = f.request(&f.token, "PATCH", &path, json!({
                "scheduleKind":"once", "runAt":(Utc::now()+ChronoDuration::hours(6)).to_rfc3339(), "status":"paused"
            })).await?;
            assert_eq!(status, StatusCode::OK, "{body}");
        }
        let (status, body) = f
            .request(&f.token, "POST", &format!("{path}/run"), JsonValue::Null)
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let finalized = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let record = f.record(initial.id).await?;
                if record.locked_until.is_none() && record.last_run_at.is_some() {
                    break Ok::<_, anyhow::Error>(record);
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await??;
        assert!(finalized.last_error.is_some(), "the fixture has no AI credentials, so this proves the launch-failure finalization path");
        if once {
            assert_eq!(finalized.status, "paused");
            assert!(
                finalized.next_run_at.is_none(),
                "the completed manual one-shot must not become due again"
            );
        } else {
            assert_eq!(finalized.status, "active");
            assert!(
                finalized.next_run_at.unwrap() > Utc::now() + ChronoDuration::hours(23),
                "the manual recurring run must advance past the just-claimed instant"
            );
        }
    }
    f.cleanup().await
}

#[tokio::test]
async fn automation_cadence_stale_finalizer_cannot_unlock_or_report_for_a_newer_claim(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let initial = f.create("space_review").await?;
    let conversation = initial.conversation_id.unwrap();
    f.state
        .pool
        .get()
        .await?
        .execute(
            "update automations set next_run_at=now()-interval '1 minute' where id=$1",
            &[&initial.id],
        )
        .await?;
    let first = claim_due_automations(&f.state)
        .await?
        .into_iter()
        .find(|record| record.id == initial.id)
        .expect("due automation is claimed");
    assert!(first.locked_until.is_some());
    assert_eq!(first.locked_until, f.record(initial.id).await?.locked_until);

    // Simulate expiry and a new scheduler claim while the first launch is slow.
    f.state
        .pool
        .get()
        .await?
        .execute(
            "update automations set locked_until=now()-interval '1 second' where id=$1",
            &[&initial.id],
        )
        .await?;
    let second = claim_due_automations(&f.state)
        .await?
        .into_iter()
        .find(|record| record.id == initial.id)
        .expect("expired automation is reclaimed");
    assert_ne!(first.locked_until, second.locked_until);
    let before: PgJson<JsonValue> = f
        .state
        .pool
        .get()
        .await?
        .query_one(
            "select to_jsonb(automations) from automations where id=$1",
            &[&initial.id],
        )
        .await?
        .get(0);
    let mut events = f.state.events.subscribe();
    finalize_automation_attempt(
        &f.state,
        &first,
        Utc::now(),
        None,
        Some("paused"),
        Some(AutomationLaunchFailure::minted(
            "Stale launch failed",
            CODE_CONTROLLER_UNAVAILABLE,
        )),
    )
    .await?;
    let db = f.state.pool.get().await?;
    let after: PgJson<JsonValue> = db
        .query_one(
            "select to_jsonb(automations) from automations where id=$1",
            &[&initial.id],
        )
        .await?
        .get(0);
    assert_eq!(
        after.0, before.0,
        "a stale attempt must not alter any newer claim state"
    );
    assert_eq!(
        db.query_one(
            "select count(*) from conversation_messages where conversation_id=$1",
            &[&conversation]
        )
        .await?
        .get::<_, i64>(0),
        0,
        "a stale attempt must not publish a misleading launch-failure notice"
    );
    drop(db);
    assert!(events.try_recv().is_err());
    assert!(
        claim_due_automations(&f.state)
            .await?
            .iter()
            .all(|record| record.id != initial.id),
        "the newer claim stays locked against another scheduler dispatch"
    );

    let next = Some(Utc::now() + ChronoDuration::hours(24));
    finalize_automation_attempt(&f.state, &second, Utc::now(), next, None, None).await?;
    let finished = f.record(initial.id).await?;
    assert!(finished.locked_until.is_none());
    assert!(finished.last_run_at.is_some());
    assert_eq!(
        finished.next_run_at.map(|time| time.timestamp_micros()),
        next.map(|time| time.timestamp_micros())
    );
    assert!(claim_due_automations(&f.state)
        .await?
        .iter()
        .all(|record| record.id != initial.id));
    f.cleanup().await
}

#[tokio::test]
async fn automation_cadence_launch_finalization_preserves_newer_schedule_and_pause(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let initial = f.create("space_review").await?;
    let path = format!("/automations/{}", initial.id);
    let attempted_at = Utc::now();
    let stale_next = Some(attempted_at + ChronoDuration::hours(24));
    let (status, _) = f
        .request(&f.token, "PATCH", &path, json!({"intervalHours":72}))
        .await?;
    assert_eq!(status, StatusCode::OK);
    let edited = f.record(initial.id).await?;
    finalize_automation_attempt(&f.state, &initial, attempted_at, stale_next, None, None).await?;
    let finalized = f.record(initial.id).await?;
    assert_eq!(finalized.next_run_at, edited.next_run_at);
    assert!(finalized.last_run_at.is_some());

    // A once launch previously unconditionally set status='paused', even after
    // the person had replaced it with a new active recurring schedule.
    let (status, _) = f.request(&f.token,"PATCH",&path,json!({"scheduleKind":"once","runAt":(Utc::now()+ChronoDuration::hours(1)).to_rfc3339()})).await?;
    assert_eq!(status, StatusCode::OK);
    let once = f.record(initial.id).await?;
    let (status, _) = f
        .request(
            &f.token,
            "PATCH",
            &path,
            json!({"scheduleKind":"hourly","intervalHours":48}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let recurring = f.record(initial.id).await?;
    finalize_automation_attempt(&f.state, &once, attempted_at, None, Some("paused"), None).await?;
    let after = f.record(initial.id).await?;
    assert_eq!(after.status, "active");
    assert_eq!(after.next_run_at, recurring.next_run_at);

    f.request(&f.token, "PATCH", &path, json!({"status":"paused"}))
        .await?;
    let paused = f.record(initial.id).await?;
    finalize_automation_attempt(&f.state, &after, attempted_at, stale_next, None, None).await?;
    let after_pause = f.record(initial.id).await?;
    assert_eq!(after_pause.status, "paused");
    assert_eq!(after_pause.next_run_at, paused.next_run_at);

    // A name-only edit is not a schedule change: normal finalization still
    // advances the next run instead of repeatedly launching the old due run.
    f.request(&f.token, "PATCH", &path, json!({"status":"active"}))
        .await?;
    let before_name = f.record(initial.id).await?;
    f.request(&f.token, "PATCH", &path, json!({"name":"Gentler check-in"}))
        .await?;
    let advanced = Some(Utc::now() + ChronoDuration::hours(48));
    finalize_automation_attempt(&f.state, &before_name, attempted_at, advanced, None, None).await?;
    let after_name = f.record(initial.id).await?;
    assert_eq!(after_name.name, "Gentler check-in");
    // Postgres stores microseconds while chrono's timestamp includes nanoseconds.
    assert_eq!(
        after_name.next_run_at.map(|t| t.timestamp_micros()),
        advanced.map(|t| t.timestamp_micros())
    );
    f.cleanup().await
}
