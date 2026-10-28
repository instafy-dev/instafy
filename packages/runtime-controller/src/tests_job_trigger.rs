#![cfg(test)]

// What started an agent job, and a provider device's owner, on the migrated
// database: the message routes, the send queue and automations record a job's
// trigger from the caller's own credential, a message says what made it only
// where device grants are on for its sender, and an owned device answers only
// to its owner. Requires `TEST_DATABASE_URL` like the tests in `tests.rs`.

use axum::http::StatusCode;
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::tests::{eventually, sql, sql_one};
use crate::tests_provider_space::{
    catalog, dispatch_directly, job_of_run, normalized, person, person_with, prompt_metadata, user,
    with_space, Trigger, DEVICE_ID, OTHER_DEVICE_ID,
};

/// Only the message routes, from the caller's own credential, say a person
/// typed a job's prompt or one of their devices relayed it, and every job
/// keeps when the controller received what started it. Nothing a client
/// writes makes a job's own message, an automation's or an unmarked send a
/// person's. Every other case is `job_trigger.rs`'s table.
#[tokio::test]
async fn a_job_records_what_started_it() -> anyhow::Result<()> {
    with_space("job-trigger", true, |harness| async move {
        let space = &harness.space;
        let owner = harness.token(space.owner);

        let before = harness.db_now().await?;
        let job = harness.send(space.owner, space.log, person()).await?;
        let after = harness.db_now().await?;
        assert_eq!(job.trigger.kind.as_deref(), Some("person"));
        let received_at = job.trigger.received_at.expect("received");
        assert!(
            before <= received_at && received_at <= after,
            "{before} <= {received_at} <= {after}"
        );

        // A send whose client says nothing of how it was made, or writes a
        // trigger of its own, and a job's own message, though its token acts
        // there as the person the job is for, say nothing.
        let leased = harness.lease(space.runtime).await?;
        let job_token = leased["controller_token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("no job token: {leased}"))?
            .to_string();
        for (token, extra) in [
            (&owner, json!({})),
            (
                &owner,
                json!({ "trigger": { "kind": "person" }, "triggerKind": "person" }),
            ),
            (&job_token, person()),
        ] {
            let job = harness.send_as(token, space.log, extra.clone()).await?;
            assert_eq!(job.trigger.kind, None, "{extra}");
            assert!(job.trigger.received_at.is_some(), "{extra}");
        }

        // The routes that start a conversation with a prompt, or dispatch one,
        // say the same.
        let (status, started) = harness
            .call(
                "POST",
                format!("/projects/{}/conversations", space.project_id),
                Some(&owner),
                Some(json!({
                    "promptText": "@helper look at the door",
                    "intent": "feature",
                    "metadata": prompt_metadata(person()),
                })),
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "start: {status} {started}");
        let (status, dispatched) = harness
            .call(
                "POST",
                "/dispatch-prompt",
                Some(&owner),
                Some(json!({
                    "projectId": space.project_id,
                    "conversationId": space.log,
                    "promptText": "@helper look at the door",
                    "intent": "feature",
                    "metadata": prompt_metadata(json!({ "input": { "kind": "device", "deviceId": DEVICE_ID } })),
                })),
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "dispatch: {status} {dispatched}");
        for (response, kind) in [(started, "person"), (dispatched, "device")] {
            let job = job_of_run(
                &harness.pool,
                Uuid::parse_str(response["runId"].as_str().unwrap_or_default())?,
            )
            .await?;
            assert_eq!(job.trigger.kind.as_deref(), Some(kind));
        }

        // A message recorded without a turn says what made it too, whatever
        // its client wrote there.
        for (metadata, stamp) in [
            (person(), json!("person")),
            (json!({ "trigger": "person" }), JsonValue::Null),
        ] {
            let (status, recorded) = harness
                .call(
                    "POST",
                    format!("/conversations/{}/messages/record", space.log),
                    Some(&owner),
                    Some(json!({ "content": "noted", "metadata": metadata })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{recorded}");
            assert_eq!(recorded["metadata"]["trigger"], stamp, "{recorded}");
        }

        // A dispatch no route stamped says nothing either.
        let job =
            dispatch_directly(&harness, user(space.owner), normalized(space, space.log)?).await?;
        assert_eq!(job.trigger.kind, None);

        // Nor does an automation's message, recorded in its owner's name.
        let (status, automation) = harness
            .call(
                "POST",
                format!("/projects/{}/automations", space.project_id),
                Some(&owner),
                Some(json!({
                    "name": "Door check",
                    "promptText": "@helper look at the door",
                    "metadata": prompt_metadata(person()),
                    "scheduleKind": "hourly",
                    "intervalHours": 24,
                    "timezone": "UTC",
                    "runtimeMode": "existing",
                })),
            )
            .await?;
        anyhow::ensure!(
            status == StatusCode::OK,
            "automation: {status} {automation}"
        );
        let (status, run) = harness
            .call(
                "POST",
                format!(
                    "/automations/{}/run",
                    automation["id"].as_str().unwrap_or_default()
                ),
                Some(&owner),
                None,
            )
            .await?;
        anyhow::ensure!(status == StatusCode::OK, "run now: {status} {run}");
        // Run now starts it in the background.
        let conversation = Uuid::parse_str(automation["conversationId"].as_str().unwrap_or_default())?;
        let (stamped, received) = eventually("the automation's job", || async {
            Ok(harness
                .pool
                .get()
                .await?
                .query_opt(
                    "select m.metadata ? 'trigger', j.trigger_received_at is not null
                       from agent_jobs j
                       join conversation_messages m on m.run_id = j.run_id and m.role = 'user'
                      where j.conversation_id = $1",
                    &[&conversation],
                )
                .await?
                .map(|row| (row.get::<_, bool>(0), row.get::<_, bool>(1))))
        })
        .await?;
        assert!(!stamped && received);
        Ok(())
    })
    .await
}

/// The queue takes a message from its person's own session, so the drain
/// sends it as theirs, received when it was queued. Send now, which the person
/// presses, sends it as received then.
#[tokio::test]
async fn a_queued_message_is_received_when_queued_or_when_its_person_sends_it_now(
) -> anyhow::Result<()> {
    with_space("job-trigger-queue", true, |harness| async move {
        let space = &harness.space;
        // The owner's agent has a turn in the log, so what they queue waits,
        // once the drain each queueing starts has found it busy.
        let settle = || tokio::time::sleep(std::time::Duration::from_millis(300));
        harness.send(space.owner, space.log, person()).await?;
        let waiting = harness.queue(space.owner, person()).await?;
        let resend = harness
            .queue(
                space.owner,
                person_with(json!({ "retryOfMessageId": Uuid::new_v4().to_string() })),
            )
            .await?;
        settle().await;
        let (status, queued_at, _) = harness.queue_entry(waiting).await?;
        assert_eq!(status, "queued");

        // The drain sends it once that turn is over.
        let job = harness.drain(waiting).await?;
        assert_eq!(
            job.trigger,
            Trigger {
                kind: Some("person".to_string()),
                received_at: Some(queued_at),
            }
        );

        // A queued resend is still no new message of theirs.
        let (_, queued_at, _) = harness.queue_entry(resend).await?;
        let job = harness.drain(resend).await?;
        assert_eq!(
            job.trigger,
            Trigger {
                kind: None,
                received_at: Some(queued_at),
            }
        );

        // Send now, pressed later, is received when pressed.
        let pressed = harness.queue(space.owner, person()).await?;
        settle().await;
        let (_, queued_at, _) = harness.queue_entry(pressed).await?;
        harness.end_turns().await?;
        let before = harness.db_now().await?;
        let (status, body) = harness
            .call(
                "POST",
                format!("/conversations/{}/send-queue/{pressed}/dispatch", space.log),
                Some(&harness.token(space.owner)),
                None,
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let job = job_of_run(
            &harness.pool,
            Uuid::parse_str(body["runId"].as_str().unwrap_or_default())?,
        )
        .await?;
        assert_eq!(job.trigger.kind.as_deref(), Some("person"));
        let received_at = job.trigger.received_at.expect("received");
        assert!(
            received_at >= before && received_at > queued_at,
            "{queued_at} < {before} <= {received_at}"
        );
        Ok(())
    })
    .await
}

/// With device grants off, a job still records when its cause was received,
/// but no message gains a trigger key, and a client's is dropped from the
/// messages a client writes. Nobody takes a device or publishes its catalog,
/// and a device owned from when grants were on still answers only to its
/// owner.
#[tokio::test]
async fn without_the_flag_no_message_says_what_made_it_and_no_device_is_taken() -> anyhow::Result<()>
{
    with_space("grants-flag-off", false, |harness| async move {
        let space = &harness.space;
        let owner = harness.token(space.owner);
        let member = harness.token(space.member);

        let job = harness.send(space.owner, space.log, person()).await?;
        assert!(job.trigger.received_at.is_some());
        assert_eq!(job.trigger.kind, None);
        let job = harness
            .send(space.owner, space.log, json!({ "trigger": "person" }))
            .await?;
        assert_eq!(job.trigger.kind, None);

        let (status, recorded) = harness
            .call(
                "POST",
                format!("/conversations/{}/messages/record", space.log),
                Some(&owner),
                Some(json!({ "content": "noted", "metadata": { "trigger": "person" } })),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{recorded}");
        assert!(recorded["metadata"].get("trigger").is_none(), "{recorded}");

        let stamped: i64 = sql_one(
            &harness.pool,
            "select count(*) from conversation_messages
              where conversation_id = $1 and metadata ? 'trigger'",
            &[&space.log],
        )
        .await?;
        assert_eq!(stamped, 0);

        let (status, body) = harness.heartbeat(&member, DEVICE_ID, json!({})).await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        let (status, body) = harness
            .heartbeat(
                &owner,
                DEVICE_ID,
                json!({ "catalog": catalog(&["device.look"]) }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(harness.device(DEVICE_ID).await?, (None, None));
        // A heartbeat answers as before, with no owner or catalog in it.
        for key in ["ownerUserId", "catalog"] {
            assert!(body.get(key).is_none(), "{key}: {body}");
        }

        harness.own_device(catalog(&["device.look"])).await?;
        let (status, _) = harness.heartbeat(&member, DEVICE_ID, json!({})).await?;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let members = harness.request(space.member, None, None).await?;
        let (status, _) = harness.listed(&member, Some(DEVICE_ID)).await?;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(
            harness.act(&member, members, "claim", DEVICE_ID).await?,
            StatusCode::FORBIDDEN
        );
        let (status, _) = harness.heartbeat(&owner, DEVICE_ID, json!({})).await?;
        assert_eq!(status, StatusCode::OK);
        let owners = harness.request(space.owner, None, None).await?;
        let (status, listed) = harness.listed(&owner, Some(DEVICE_ID)).await?;
        assert_eq!((status, listed), (StatusCode::OK, vec![owners]));
        assert_eq!(
            harness.device(DEVICE_ID).await?.0,
            Some(space.owner),
            "nothing changed its owner"
        );
        Ok(())
    })
    .await
}

/// A device its owner registered from their own session is theirs alone: only
/// they heartbeat it, write its catalog, list its requests, and claim and
/// complete requests as it, and it takes only their requests. A device without
/// an owner keeps the project's rules.
#[tokio::test]
async fn an_owned_device_answers_only_to_its_owner() -> anyhow::Result<()> {
    with_space("device-owner", true, |harness| async move {
        let space = &harness.space;
        let owner = harness.token(space.owner);
        let member = harness.token(space.member);

        // The owner registers the device with its catalog.
        let looks = catalog(&["device.look", "device.move"]);
        let (status, device) = harness
            .heartbeat(&owner, DEVICE_ID, json!({ "catalog": looks }))
            .await?;
        assert_eq!(status, StatusCode::OK, "{device}");
        assert_eq!(
            harness.device(DEVICE_ID).await?,
            (Some(space.owner), Some(looks.clone()))
        );

        // Nobody else heartbeats it, takes it or rewrites its catalog.
        for extra in [json!({}), json!({ "catalog": catalog(&["device.erase"]) })] {
            let (status, body) = harness.heartbeat(&member, DEVICE_ID, extra.clone()).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{extra}: {body}");
        }
        // A heartbeat without a catalog keeps it; a new one replaces it.
        harness.heartbeat(&owner, DEVICE_ID, json!({})).await?;
        assert_eq!(
            harness.device(DEVICE_ID).await?,
            (Some(space.owner), Some(looks))
        );
        let look = catalog(&["device.look"]);
        harness
            .heartbeat(&owner, DEVICE_ID, json!({ "catalog": look }))
            .await?;
        assert_eq!(harness.device(DEVICE_ID).await?.1, Some(look));
        // A catalog must have the MCP shape and fit its limits
        // (provider_devices.rs).
        let (status, body) = harness
            .heartbeat(
                &owner,
                DEVICE_ID,
                json!({ "catalog": { "tools": [{ "name": "device look" }] } }),
            )
            .await?;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

        let owners_own = harness.request(space.owner, Some(DEVICE_ID), None).await?;
        let owners_any = harness.request(space.owner, None, None).await?;
        let members_any = harness.request(space.member, None, None).await?;
        // A request of a running job of the owner's.
        let running = harness.send(space.owner, space.log, person()).await?;
        sql(
            &harness.pool,
            "update agent_jobs set status = 'leased' where id = $1",
            &[&running.id],
        )
        .await?;
        let owners_job = harness.request(space.owner, None, Some(running.id)).await?;

        // The owned device lists only for its owner, and only their requests.
        let (status, _) = harness.listed(&member, Some(DEVICE_ID)).await?;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, listed) = harness.listed(&owner, Some(DEVICE_ID)).await?;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(listed, vec![owners_own, owners_any, owners_job]);
        let (_, listed) = harness.listed(&member, Some(OTHER_DEVICE_ID)).await?;
        assert_eq!(listed, vec![owners_any, members_any]);

        // Nobody else acts as the owned device, even on the owner's own
        // request, and it acts on nobody else's request.
        for request in [owners_own, owners_any, members_any] {
            for action in ["claim", "complete"] {
                assert_eq!(
                    harness.act(&member, request, action, DEVICE_ID).await?,
                    StatusCode::FORBIDDEN,
                    "{action} {request}"
                );
            }
        }
        assert_eq!(
            harness.act(&owner, members_any, "claim", DEVICE_ID).await?,
            StatusCode::FORBIDDEN
        );
        // A device without an owner keeps the project's rules.
        assert_eq!(
            harness
                .act(&member, owners_any, "claim", OTHER_DEVICE_ID)
                .await?,
            StatusCode::OK
        );

        // The owner claims and completes their request as the device.
        assert_eq!(
            harness.act(&owner, owners_own, "claim", DEVICE_ID).await?,
            StatusCode::OK
        );
        assert_eq!(
            harness
                .act(&member, owners_own, "complete", DEVICE_ID)
                .await?,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            harness
                .act(&owner, owners_own, "complete", DEVICE_ID)
                .await?,
            StatusCode::OK
        );

        // A person the allowlist leaves out has no grants and takes no device.
        let guest = harness.token(space.guest);
        let grants = format!("/projects/{}/device-grants", space.project_id);
        let (status, _) = harness.call("GET", grants, Some(&guest), None).await?;
        assert_eq!(status, StatusCode::NOT_FOUND);
        let (status, body) = harness
            .heartbeat(
                &guest,
                OTHER_DEVICE_ID,
                json!({ "catalog": catalog(&["device.look"]) }),
            )
            .await?;
        assert_eq!(status, StatusCode::OK, "{body}");
        assert_eq!(harness.device(OTHER_DEVICE_ID).await?, (None, None));
        Ok(())
    })
    .await
}

/// A device whose owner may no longer write to its space, because they lost
/// write access or left the space, is nobody's: the space's other people use
/// it under the space's rules, and may take it. Until they do, its catalog and
/// context stay its owner's; once they do, it has only the catalog they send.
#[tokio::test]
async fn a_device_whose_owner_lost_the_space_is_nobodys() -> anyhow::Result<()> {
    with_space("device-owner-left", true, |harness| async move {
        let space = &harness.space;
        let owner = harness.token(space.owner);
        let member = harness.token(space.member);
        let members = catalog(&["device.look"]);
        for device in [DEVICE_ID, OTHER_DEVICE_ID] {
            let (status, body) = harness
                .heartbeat(
                    &member,
                    device,
                    json!({ "catalog": members, "context": "lid: open" }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            let (status, _) = harness.heartbeat(&owner, device, json!({})).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{device}");
        }

        for (device, project_change, team_change) in [
            (
                DEVICE_ID,
                "update project_memberships set role = 'viewer'
                  where project_id = $1 and user_id = $2",
                "update org_memberships set role = 'viewer' where org_id = $1 and user_id = $2",
            ),
            (
                OTHER_DEVICE_ID,
                "delete from project_memberships where project_id = $1 and user_id = $2",
                "delete from org_memberships where org_id = $1 and user_id = $2",
            ),
        ] {
            let connection = harness.pool.get().await?;
            connection
                .execute(project_change, &[&space.project_id, &space.member])
                .await?;
            connection
                .execute(team_change, &[&space.org_id, &space.member])
                .await?;
            drop(connection);
            // Its stored owner can no longer heartbeat it, and a heartbeat
            // without a catalog takes it from nobody.
            let (status, _) = harness.heartbeat(&member, device, json!({})).await?;
            assert_eq!(status, StatusCode::FORBIDDEN, "{device}");
            let others = json!({ "context": "lid: shut" });
            let (status, body) = harness.heartbeat(&owner, device, others).await?;
            assert_eq!(status, StatusCode::OK, "{device}: {body}");
            assert_eq!(
                harness.device(device).await?,
                (Some(space.member), Some(members.clone())),
                "{device}"
            );
            assert_eq!(
                harness.device_context(device).await?.as_deref(),
                Some("lid: open")
            );
            let request = harness.request(space.owner, Some(device), None).await?;
            let (status, listed) = harness.listed(&owner, Some(device)).await?;
            assert_eq!(
                (status, listed),
                (StatusCode::OK, vec![request]),
                "{device}"
            );
            assert_eq!(
                harness.act(&owner, request, "claim", device).await?,
                StatusCode::OK,
                "{device}"
            );
            // And the space's owner may take it, with a catalog of theirs.
            let erases = catalog(&["device.erase"]);
            let (status, _) = harness
                .heartbeat(&owner, device, json!({ "catalog": erases }))
                .await?;
            assert_eq!(status, StatusCode::OK, "{device}");
            assert_eq!(
                harness.device(device).await?,
                (Some(space.owner), Some(erases)),
                "{device}"
            );
        }
        Ok(())
    })
    .await
}
