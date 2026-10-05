use super::*;

// The sweep is global. Keep due fixtures from separate tests from consuming one
// another while still exercising concurrent sweep calls inside a test.
static DUE_SWEEP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn feedback_path(conversation: Uuid) -> String {
    format!("/conversations/{conversation}/recommendation-feedback")
}

fn remind_at(run_at: &str) -> Value {
    json!({"action":"remind","runAt":run_at,"timezone":"Europe/Vienna"})
}

async fn deliver(f: &Fixture, evidence: Uuid) -> anyhow::Result<(Value, Uuid)> {
    let mut body = proposal(evidence);
    body["message"] = json!("The mobile signup check is still open. Shall we pick it up?");
    if evidence == f.public {
        body["evidence"] = json!([{"conversationId":f.public,"messageId":f.message}]);
    }
    let record = f.submit(0, body).await?;
    let chat = Uuid::parse_str(
        record["deliveredConversationId"]
            .as_str()
            .context("delivery conversation")?,
    )?;
    Ok((record, chat))
}

async fn patch_feedback(
    f: &Fixture,
    token: &str,
    chat: Uuid,
    body: Value,
) -> anyhow::Result<Value> {
    let (status, result) = f
        .request(token, "PATCH", &feedback_path(chat), body)
        .await?;
    assert_eq!(status, StatusCode::OK, "{result}");
    Ok(result)
}

async fn make_due(f: &Fixture, record: &Value) -> anyhow::Result<()> {
    let id = Uuid::parse_str(record["id"].as_str().context("recommendation id")?)?;
    f.state
        .pool
        .get()
        .await?
        .execute(
            "update space_recommendations set remind_at=now()-interval '1 minute' where id=$1",
            &[&id],
        )
        .await?;
    Ok(())
}

async fn read_feedback(f: &Fixture, chat: Uuid) -> anyhow::Result<Value> {
    let (status, result) = f
        .request(&f.tokens[0], "GET", &feedback_path(chat), Value::Null)
        .await?;
    assert_eq!(status, StatusCode::OK, "{result}");
    Ok(result)
}

#[tokio::test]
async fn recommendation_feedback_scoped_reply_can_dismiss_without_reading_review_anchor(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let (status, anchor) = f
        .request(
            &f.tokens[0],
            "POST",
            &format!("{}/review-conversation", f.path()),
            Value::Null,
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{anchor}");
    let anchor = Uuid::parse_str(anchor["conversationId"].as_str().context("anchor")?)?;
    let scopes = vec![
        "prompt.execute".to_owned(),
        "job.token.workspace-separated".to_owned(),
    ];
    let (review_token, _) = f.job(anchor, scopes.clone()).await?;
    let mut body = proposal(f.public);
    body["message"] = json!("The mobile check is unfinished. Shall we continue?");
    let (status, submitted) = f
        .request(&review_token, "POST", &f.path(), body.clone())
        .await?;
    assert_eq!(status, StatusCode::OK, "{submitted}");
    assert!(submitted["deliveredConversationId"].is_null());
    let record = f.list(&f.tokens[0]).await?.remove(0);
    let chat = Uuid::parse_str(
        record["deliveredConversationId"]
            .as_str()
            .context("delivered conversation")?,
    )?;
    let (reply_token, _) = f.job(chat, scopes).await?;
    assert!(
        f.list(&reply_token).await?.is_empty(),
        "the reply job must not gain access to the private review anchor"
    );
    let (status, current) = f
        .request(&reply_token, "GET", &feedback_path(chat), Value::Null)
        .await?;
    assert_eq!(status, StatusCode::OK, "{current}");
    assert_eq!(current["recommendationId"], record["id"]);
    assert_eq!(current["conversationId"], json!(chat));
    assert_eq!(current["projectId"], json!(f.project));
    for hidden in ["sourceConversationId", "prompt", "evidence", "reason"] {
        assert!(current.get(hidden).is_none(), "leaked {hidden}");
    }
    let dismissed = patch_feedback(&f, &reply_token, chat, json!({"action":"dismiss"})).await?;
    assert_eq!(dismissed["status"], "dismissed");
    assert!(dismissed["remindAt"].is_null());
    assert_eq!(
        patch_feedback(&f, &reply_token, chat, json!({"action":"dismiss"})).await?,
        dismissed,
        "a retried dismissal is idempotent"
    );
    assert_eq!(f.list(&review_token).await?[0]["status"], "dismissed");
    let (status, retry) = f.request(&review_token, "POST", &f.path(), body).await?;
    assert_eq!(status, StatusCode::OK, "{retry}");
    assert_eq!(retry["status"], "dismissed");
    assert_eq!(retry["id"], record["id"]);
    f.cleanup().await
}

#[tokio::test]
async fn recommendation_feedback_rejects_unrelated_or_inactive_authority() -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let (_, chat) = deliver(&f, f.public).await?;
    let path = feedback_path(chat);
    for token in [&f.tokens[1], &f.tokens[3]] {
        for (method, body) in [("GET", Value::Null), ("PATCH", json!({"action":"dismiss"}))] {
            let (status, result) = f.request(token, method, &path, body).await?;
            assert!(
                matches!(status, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND),
                "another owner must not see or change the recommendation: {status} {result}"
            );
            assert!(result.get("title").is_none());
        }
    }
    let scopes = vec![
        "prompt.execute".to_owned(),
        "job.token.workspace-separated".to_owned(),
    ];
    let (unrelated, _) = f.job(f.public, scopes.clone()).await?;
    let (machine, _) = f.job(chat, vec!["fs.read".to_owned()]).await?;
    let (expired, job_id) = f.job(chat, scopes).await?;
    f.state
        .pool
        .get()
        .await?
        .execute(
            "update agent_jobs set lease_expires_at=now()-interval '1 minute' where id=$1",
            &[&job_id],
        )
        .await?;
    for token in [
        unrelated.as_str(),
        machine.as_str(),
        expired.as_str(),
        "service-role-token",
    ] {
        for (method, body) in [("GET", Value::Null), ("PATCH", json!({"action":"dismiss"}))] {
            let (status, result) = f.request(token, method, &path, body).await?;
            assert!(
                matches!(status, StatusCode::FORBIDDEN | StatusCode::UNAUTHORIZED),
                "only a live job in this exact chat or its owner may change feedback: {status} {result}"
            );
        }
    }
    let (status, _) = f
        .request(&f.tokens[0], "GET", &feedback_path(f.public), Value::Null)
        .await?;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "ordinary chats have no topic feedback"
    );
    assert_eq!(read_feedback(&f, chat).await?["status"], "proposed");
    f.cleanup().await
}

#[tokio::test]
async fn recommendation_feedback_private_sources_allow_reminding_without_expanding_job_reads(
) -> anyhow::Result<()> {
    let mut f = Fixture::new().await?;
    f.app = router()
        .merge(crate::conversations::router())
        .with_state(f.state.clone());
    let (_, chat) = deliver(&f, f.private).await?;
    let source_path = format!("/conversations/{}/messages", f.private);
    let (reply_token, _) = f
        .job(
            chat,
            vec![
                "prompt.execute".into(),
                "job.token.workspace-separated".into(),
            ],
        )
        .await?;
    assert_eq!(
        f.request(&f.tokens[0], "GET", &source_path, Value::Null)
            .await?
            .0,
        StatusCode::OK,
        "the owner can still access the original private evidence"
    );
    assert_eq!(
        f.request(&reply_token, "GET", &source_path, Value::Null)
            .await?
            .0,
        StatusCode::FORBIDDEN,
        "the reply job cannot read another private root"
    );
    let saved = patch_feedback(&f, &reply_token, chat, remind_at("2099-01-10T20:00:00")).await?;
    assert!(saved["remindAt"].is_string());
    for hidden in ["sourceConversationId", "evidence", "reason", "prompt"] {
        assert!(saved.get(hidden).is_none(), "feedback leaked {hidden}");
    }
    assert!(!saved.to_string().contains(&f.private.to_string()));
    assert_eq!(
        f.request(&reply_token, "GET", &source_path, Value::Null)
            .await?
            .0,
        StatusCode::FORBIDDEN,
        "saving feedback must not grant source access"
    );
    assert!(f.list(&reply_token).await?.is_empty());
    f.state
        .pool
        .get()
        .await?
        .execute(
            "delete from conversation_participants where conversation_id=$1 and user_id=$2",
            &[&f.private, &f.users[0]],
        )
        .await?;
    let (status, result) = f
        .request(
            &reply_token,
            "PATCH",
            &feedback_path(chat),
            remind_at("2099-01-17T10:00:00"),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
    assert_eq!(read_feedback(&f, chat).await?, saved);
    let dismissed = patch_feedback(&f, &reply_token, chat, json!({"action":"dismiss"})).await?;
    assert_eq!(dismissed["status"], "dismissed");
    assert!(dismissed["remindAt"].is_null());
    f.cleanup().await
}

#[tokio::test]
async fn recommendation_feedback_can_dismiss_after_source_access_is_revoked() -> anyhow::Result<()>
{
    let f = Fixture::new().await?;
    let (_, chat) = deliver(&f, f.private).await?;
    patch_feedback(&f, &f.tokens[0], chat, remind_at("2099-01-10T20:00:00")).await?;
    f.state
        .pool
        .get()
        .await?
        .execute(
            "delete from conversation_participants where conversation_id=$1 and user_id=$2",
            &[&f.private, &f.users[0]],
        )
        .await?;
    let (status, result) = f
        .request(
            &f.tokens[0],
            "PATCH",
            &feedback_path(chat),
            remind_at("2099-01-17T10:00:00"),
        )
        .await?;
    assert_eq!(status, StatusCode::FORBIDDEN, "{result}");
    let (reply_token, _) = f
        .job(
            chat,
            vec![
                "prompt.execute".into(),
                "job.token.workspace-separated".into(),
            ],
        )
        .await?;
    let dismissed = patch_feedback(&f, &reply_token, chat, json!({"action":"dismiss"})).await?;
    assert_eq!(dismissed["status"], "dismissed");
    assert!(
        dismissed["remindAt"].is_null(),
        "revoked sources must not prevent opting out"
    );
    f.cleanup().await
}

#[tokio::test]
async fn recommendation_feedback_reminders_require_valid_future_times_and_preserve_latest_choice(
) -> anyhow::Result<()> {
    let f = Fixture::new().await?;
    let (record, chat) = deliver(&f, f.public).await?;
    let id = Uuid::parse_str(record["id"].as_str().context("id")?)?;
    for body in [
        json!({"action":"remind","runAt":"2099-01-10T20:00:00"}),
        json!({"action":"remind","runAt":"2099-01-10T20:00:00","timezone":"not/a-timezone"}),
        remind_at("2000-01-10T20:00:00"),
        remind_at("tonight"),
        remind_at("2099-03-29T02:30:00"), // Spring gap in Europe/Vienna.
        remind_at("2099-10-25T02:30:00"), // Autumn overlap needs an explicit offset.
        json!({"action":"dismiss","runAt":"2099-01-10T20:00:00","timezone":"Europe/Vienna"}),
        json!({"action":"remind","runAt":"2099-01-10T20:00:00","timezone":"Europe/Vienna","projectId":f.other_project}),
    ] {
        let (status, result) = f
            .request(&f.tokens[0], "PATCH", &feedback_path(chat), body)
            .await?;
        assert!(
            matches!(
                status,
                StatusCode::BAD_REQUEST | StatusCode::UNPROCESSABLE_ENTITY
            ),
            "invalid preference must fail without saving: {status} {result}"
        );
        assert!(read_feedback(&f, chat).await?["remindAt"].is_null());
    }
    let (status, accepted) = f
        .request(
            &f.tokens[0],
            "PATCH",
            &format!("{}/{id}", f.path()),
            json!({"status":"accepted","acceptedConversationId":chat}),
        )
        .await?;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    let (reply_token, _) = f
        .job(
            chat,
            vec![
                "prompt.execute".into(),
                "job.token.workspace-separated".into(),
            ],
        )
        .await?;
    let tonight = patch_feedback(&f, &reply_token, chat, remind_at("2099-01-10T20:00:00")).await?;
    assert_eq!(tonight["status"], "proposed");
    assert_eq!(tonight["timezone"], "Europe/Vienna");
    let parsed = DateTime::parse_from_rfc3339(tonight["remindAt"].as_str().context("remindAt")?)?;
    assert_eq!(
        parsed.to_utc(),
        "2099-01-10T19:00:00Z".parse::<DateTime<Utc>>()?
    );
    assert_eq!(
        patch_feedback(&f, &reply_token, chat, remind_at("2099-01-10T20:00:00")).await?,
        tonight
    );
    let first_overlap = patch_feedback(
        &f,
        &reply_token,
        chat,
        remind_at("2099-10-25T02:30:00+02:00"),
    )
    .await?;
    let second_overlap = patch_feedback(
        &f,
        &reply_token,
        chat,
        remind_at("2099-10-25T02:30:00+01:00"),
    )
    .await?;
    let first_time = DateTime::parse_from_rfc3339(
        first_overlap["remindAt"]
            .as_str()
            .context("first overlap")?,
    )?;
    let second_time = DateTime::parse_from_rfc3339(
        second_overlap["remindAt"]
            .as_str()
            .context("second overlap")?,
    )?;
    assert_eq!(
        (second_time - first_time).num_hours(),
        1,
        "an explicit offset selects the requested side of a DST overlap"
    );
    let weekend = patch_feedback(&f, &reply_token, chat, remind_at("2099-01-17T10:00:00")).await?;
    assert_ne!(weekend["remindAt"], tonight["remindAt"]);
    assert_eq!(read_feedback(&f, chat).await?, weekend);
    let dismissed = patch_feedback(&f, &reply_token, chat, json!({"action":"dismiss"})).await?;
    assert_eq!(dismissed["status"], "dismissed");
    assert!(dismissed["remindAt"].is_null());
    assert!(dismissed["timezone"].is_null());
    let reopened = patch_feedback(&f, &reply_token, chat, remind_at("2099-01-17T10:00:00")).await?;
    assert_eq!(
        reopened["status"], "proposed",
        "a later explicit request can resume a dismissed topic"
    );
    {
        let db = f.state.pool.get().await?;
        let accepted: Option<Uuid> = db
            .query_one(
                "select accepted_conversation_id from space_recommendations where id=$1",
                &[&id],
            )
            .await?
            .get(0);
        assert!(accepted.is_none());
        assert_eq!(
            db.query_one(
                "select count(*) from conversation_messages where conversation_id=$1",
                &[&chat]
            )
            .await?
            .get::<_, i64>(0),
            1
        );
        assert_eq!(
            db.query_one(
                "select count(*) from automations where project_id=$1",
                &[&f.project]
            )
            .await?
            .get::<_, i64>(0),
            0,
            "deferring one topic does not change the space's automation schedule"
        );
    }
    f.cleanup().await
}

#[tokio::test]
async fn recommendation_feedback_due_reminder_is_once_in_same_chat_without_model_work(
) -> anyhow::Result<()> {
    let _guard = DUE_SWEEP.lock().await;
    let f = Fixture::new().await?;
    let (record, chat) = deliver(&f, f.public).await?;
    patch_feedback(&f, &f.tokens[0], chat, remind_at("2099-01-10T20:00:00")).await?;
    assert_eq!(
        deliver_due_reminders(&f.state).await?,
        0,
        "future reminders must wait"
    );
    make_due(&f, &record).await?;
    let (a, b) = tokio::join!(
        deliver_due_reminders(&f.state),
        deliver_due_reminders(&f.state)
    );
    assert_eq!(
        a? + b?,
        1,
        "concurrent schedulers must claim the reminder once"
    );
    assert_eq!(deliver_due_reminders(&f.state).await?, 0);
    let feedback = read_feedback(&f, chat).await?;
    assert!(feedback["remindAt"].is_null());
    assert!(feedback["lastRemindedAt"].is_string());
    assert_eq!(
        feedback["status"], "proposed",
        "a reminder does not accept or complete the task"
    );
    {
        let db = f.state.pool.get().await?;
        let messages = db.query("select role,content,run_id from conversation_messages where conversation_id=$1 order by created_at,id", &[&chat]).await?;
        assert_eq!(messages.len(), 2);
        for message in &messages {
            assert_eq!(message.get::<_, String>("role"), "assistant");
            assert!(message.get::<_, Option<Uuid>>("run_id").is_none());
        }
        let reminder = messages
            .iter()
            .find(|m| {
                m.get::<_, String>("content")
                    .contains("Check signup on mobile")
            })
            .context("reminder names its topic")?;
        assert!(
            reminder
                .get::<_, String>("content")
                .contains(&format!("[[conversation:{}|", f.public)),
            "reminder keeps a validated source link"
        );
        assert_eq!(
            db.query_one(
                "select count(*) from conversations where project_id=$1",
                &[&f.project]
            )
            .await?
            .get::<_, i64>(0),
            3,
            "reminder must not open another chat"
        );
        assert_eq!(
            db.query_one(
                "select count(*) from agent_jobs where project_id=$1",
                &[&f.project]
            )
            .await?
            .get::<_, i64>(0),
            0,
            "reminding does not start a model or task"
        );
        assert_eq!(
            db.query_one(
                "select count(*) from runs where project_id=$1",
                &[&f.project]
            )
            .await?
            .get::<_, i64>(0),
            0
        );
        assert_eq!(db.query_one("select count(*) from notification_events where conversation_id=$1 and event_name='conversation.reply'", &[&chat]).await?.get::<_,i64>(0),2, "the reminder uses one ordinary reply notification");
    }
    f.cleanup().await
}

#[tokio::test]
async fn recommendation_feedback_rescheduling_and_dismissal_cancel_old_due_delivery(
) -> anyhow::Result<()> {
    let _guard = DUE_SWEEP.lock().await;
    let f = Fixture::new().await?;
    let (record, chat) = deliver(&f, f.public).await?;
    patch_feedback(&f, &f.tokens[0], chat, remind_at("2099-01-10T20:00:00")).await?;
    make_due(&f, &record).await?;
    let later = patch_feedback(&f, &f.tokens[0], chat, remind_at("2099-01-17T10:00:00")).await?;
    assert_eq!(deliver_due_reminders(&f.state).await?, 0);
    assert_eq!(read_feedback(&f, chat).await?, later);
    make_due(&f, &record).await?;
    patch_feedback(&f, &f.tokens[0], chat, json!({"action":"dismiss"})).await?;
    assert_eq!(
        deliver_due_reminders(&f.state).await?,
        0,
        "a dismissed due reminder must never send"
    );
    let db = f.state.pool.get().await?;
    assert_eq!(
        db.query_one(
            "select count(*) from conversation_messages where conversation_id=$1",
            &[&chat]
        )
        .await?
        .get::<_, i64>(0),
        1
    );
    drop(db);
    f.cleanup().await
}

#[tokio::test]
async fn recommendation_feedback_due_reminders_recheck_current_privacy_and_access(
) -> anyhow::Result<()> {
    let _guard = DUE_SWEEP.lock().await;
    for change in [
        "archived",
        "archived_whitespace",
        "hidden_object",
        "deleted",
        "public",
        "participant",
        "project_access",
        "evidence_access",
        "evidence_deleted",
    ] {
        let f = Fixture::new().await?;
        let evidence = if change == "evidence_access" {
            f.private
        } else {
            f.public
        };
        let (record, chat) = deliver(&f, evidence).await?;
        let id = Uuid::parse_str(record["id"].as_str().context("recommendation id")?)?;
        patch_feedback(&f, &f.tokens[0], chat, remind_at("2099-01-10T20:00:00")).await?;
        make_due(&f, &record).await?;
        {
            let db = f.state.pool.get().await?;
            match change {
                "archived" | "archived_whitespace" | "hidden_object" => {
                    let key = format!("instafy_conversation_lifecycle_v1_{}", f.users[0]);
                    let lifecycle = match change {
                        "archived_whitespace" => json!("  ArChIvEd  "),
                        "hidden_object" => json!({"status":"  HiDdEn  "}),
                        _ => json!("archived"),
                    };
                    db.execute("update conversations set metadata=metadata || jsonb_build_object($2::text,$3::jsonb) where id=$1", &[&chat,&key,&PgJson(lifecycle)]).await?;
                }
                "deleted" => {
                    db.execute("delete from conversations where id=$1", &[&chat])
                        .await?;
                }
                "public" => {
                    db.execute(
                        "update conversations set visibility='public' where id=$1",
                        &[&chat],
                    )
                    .await?;
                }
                "participant" => {
                    db.execute("insert into conversation_participants(conversation_id,user_id,role,added_by) values($1,$2,'member',$3)", &[&chat,&f.users[1],&f.users[0]]).await?;
                }
                "project_access" => {
                    db.execute(
                        "update projects set owner_user_id=$2 where id=$1",
                        &[&f.project, &f.users[1]],
                    )
                    .await?;
                }
                "evidence_access" => {
                    db.execute("delete from conversation_participants where conversation_id=$1 and user_id=$2", &[&f.private,&f.users[0]]).await?;
                }
                "evidence_deleted" => {
                    db.execute(
                        "delete from conversation_messages where id=$1",
                        &[&f.message],
                    )
                    .await?;
                }
                _ => unreachable!(),
            }
        }
        if matches!(change, "archived" | "archived_whitespace" | "hidden_object") {
            let (status, result) = f
                .request(
                    &f.tokens[0],
                    "PATCH",
                    &feedback_path(chat),
                    remind_at("2099-01-17T10:00:00"),
                )
                .await?;
            assert_eq!(
                status,
                StatusCode::BAD_REQUEST,
                "cannot reschedule {change}: {result}"
            );
        }
        assert_eq!(
            deliver_due_reminders(&f.state).await?,
            0,
            "unsafe reminder was delivered after {change}"
        );
        let db = f.state.pool.get().await?;
        let row = db
            .query_one(
                "select remind_at,last_reminded_at from space_recommendations where id=$1",
                &[&id],
            )
            .await?;
        assert!(
            row.get::<_, Option<DateTime<Utc>>>("remind_at").is_none(),
            "cancel permanently unavailable reminder after {change}"
        );
        assert!(row
            .get::<_, Option<DateTime<Utc>>>("last_reminded_at")
            .is_none());
        let messages = db
            .query_one(
                "select count(*) from conversation_messages where conversation_id=$1",
                &[&chat],
            )
            .await?
            .get::<_, i64>(0);
        assert_eq!(
            messages,
            if change == "deleted" { 0 } else { 1 },
            "unexpected reminder after {change}"
        );
        assert_eq!(
            db.query_one(
                "select count(*) from agent_jobs where project_id=$1",
                &[&f.project]
            )
            .await?
            .get::<_, i64>(0),
            0
        );
        drop(db);
        f.cleanup().await?;
    }
    Ok(())
}
