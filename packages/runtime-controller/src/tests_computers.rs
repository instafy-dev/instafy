// Your computers on the migrated database (docs/Local-Engine-Turns.md 11.23):
// a person's computers poll with their own session (crate::computers), and are
// told of the spaces where a Claude Code turn of their person's waits that
// their logins could run, without the turn's words; one claims a space before
// it starts it; and nothing a computer reports makes a runtime lease a turn.
// A child of the lane tests, whose space and harness it shares: the owner's
// and the member's @claude on Claude Code, their first logins and their
// lane-ready computers.

use std::time::{Duration as StdDuration, Instant};

use super::*;

/// A new computer's Desktop id.
fn device() -> String {
    format!("desktop-{}", Uuid::new_v4())
}

/// What `device` reports in a poll: ready on `logins`, with `extra`.
fn report(device: &str, logins: &[Uuid], extra: JsonValue) -> JsonValue {
    with(
        json!({
            "deviceKey": device,
            "label": "MacBook Pro",
            "platform": "darwin",
            "desktopVersion": "0.2.25",
            "startsSpaces": true,
            "logins": logins.iter().map(Uuid::to_string).collect::<Vec<_>>(),
        }),
        extra,
    )
}

async fn poll_as(
    lane: &Lane,
    token: &str,
    body: JsonValue,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    lane.harness
        .call("POST", "/me/computers/poll", Some(token), Some(body))
        .await
}

/// `token`'s holder's computer polls, answered.
async fn polled_as(lane: &Lane, token: &str, body: JsonValue) -> anyhow::Result<JsonValue> {
    let (status, answer) = poll_as(lane, token, body).await?;
    anyhow::ensure!(status == StatusCode::OK, "poll: {status} {answer}");
    Ok(answer)
}

/// The owner's computer polls, answered.
async fn polled(lane: &Lane, body: JsonValue) -> anyhow::Result<JsonValue> {
    polled_as(lane, &lane.owner(), body).await
}

/// The computer an answer is about.
fn computer_of(answer: &JsonValue) -> anyhow::Result<Uuid> {
    Ok(Uuid::parse_str(
        answer["computer"]["id"].as_str().unwrap_or_default(),
    )?)
}

/// The spaces an answer names, oldest first.
fn spaces_of(answer: &JsonValue) -> Vec<String> {
    answer["wanted"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|wanted| wanted["projectId"].as_str().map(str::to_string))
        .collect()
}

async fn call(
    lane: &Lane,
    method: &str,
    path: String,
    token: &str,
    body: Option<JsonValue>,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    lane.harness.call(method, path, Some(token), body).await
}

/// A Claude Code login of `user`'s, other than their first.
async fn another_login_of(lane: &Lane, user: Uuid, label: &str) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    sql(
        lane.pool(),
        "insert into claude_code_logins (id, user_id, label) values ($1, $2, $3)",
        &[&id, &user, &label],
    )
    .await?;
    Ok(id)
}

#[tokio::test]
async fn computers_answer_only_their_persons_own_session() -> anyhow::Result<()> {
    with_lane(
        "computers-access",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let first = first_login_of(space.owner);
            let body = report(&device(), &[first], json!({}));

            // The service role, and a runtime's token, are no person's session.
            let runtime_token = lane.harness.agent_token(lane.desktop).await?;
            for token in [SERVICE_ROLE.to_string(), runtime_token] {
                let (status, _) =
                    call(&lane, "GET", "/me/computers".to_string(), &token, None).await?;
                assert_eq!(status, StatusCode::UNAUTHORIZED);
                let (status, _) = poll_as(&lane, &token, body.clone()).await?;
                assert_eq!(status, StatusCode::UNAUTHORIZED);
            }

            // The guest is not on the lane list: their computer is not told of
            // turns, and claims nothing.
            let guest = lane.token(space.guest);
            let (status, refused) = poll_as(&lane, &guest, body.clone()).await?;
            assert_eq!(
                (status, refused["code"].as_str()),
                (
                    StatusCode::FORBIDDEN,
                    Some(claude_code_lane::TURN_NOT_ALLOWED)
                ),
                "{refused}"
            );
            let guests_computer: Uuid = sql_one(
                lane.pool(),
                "insert into user_computers (user_id, device_key, label, platform)
                 values ($1, $2, 'Guest Mac', 'darwin') returning id",
                &[&space.guest, &device()],
            )
            .await?;
            let (status, refused) = call(
                &lane,
                "POST",
                format!("/me/computers/{guests_computer}/claim"),
                &guest,
                Some(json!({ "projectId": space.project_id })),
            )
            .await?;
            assert_eq!(
                (status, refused["code"].as_str()),
                (
                    StatusCode::FORBIDDEN,
                    Some(claude_code_lane::TURN_NOT_ALLOWED)
                )
            );
            // Listing needs no switch, and lists only their own.
            let (status, listed) =
                call(&lane, "GET", "/me/computers".to_string(), &guest, None).await?;
            assert_eq!(status, StatusCode::OK);
            assert_eq!(listed["computers"].as_array().map(Vec::len), Some(1));

            // Another person's computer is never found.
            let owners = computer_of(&polled(&lane, body.clone()).await?)?;
            let member = lane.token(space.member);
            for (method, path, body) in [
                (
                    "PATCH",
                    format!("/me/computers/{owners}"),
                    Some(json!({ "status": "paused" })),
                ),
                ("DELETE", format!("/me/computers/{owners}"), None),
                (
                    "POST",
                    format!("/me/computers/{owners}/offline"),
                    Some(json!({ "reason": "sleep" })),
                ),
                (
                    "POST",
                    format!("/me/computers/{owners}/claim"),
                    Some(json!({ "projectId": space.project_id })),
                ),
            ] {
                let (status, answer) = call(&lane, method, path.clone(), &member, body).await?;
                assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {answer}");
            }
            let (_, listed) =
                call(&lane, "GET", "/me/computers".to_string(), &member, None).await?;
            assert_eq!(listed["computers"], json!([]));
            let (_, listed) = call(
                &lane,
                "GET",
                "/me/computers".to_string(),
                &lane.owner(),
                None,
            )
            .await?;
            assert_eq!(listed["computers"][0]["id"], json!(owners));
            assert_eq!(listed["computers"][0]["status"], json!("available"));
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_poll_keeps_the_persons_own_logins_and_attested_runtime() -> anyhow::Result<()> {
    with_lane(
        "computers-report",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let first = first_login_of(space.owner);
            let mac = device();
            let unattested = lane
                .computer("self-hosted", capabilities(None, json!({})), "ready", 600)
                .await?;
            let personal_browser = lane
                .computer(
                    "self-hosted",
                    capabilities(
                        Some(space.owner),
                        json!({ "personalBrowser": {
                            "enabled": true,
                            "ownerUserId": space.owner.to_string(),
                        } }),
                    ),
                    "ready",
                    600,
                )
                .await?;
            let answer = polled(
                &lane,
                report(
                    &mac,
                    &[],
                    json!({
                        "logins": [
                            first.to_string(),
                            first_login_of(space.member).to_string(),
                            Uuid::new_v4().to_string(),
                            "not-a-login",
                            { "id": first.to_string(), "folder": "/workspace/me/.claude-work" },
                        ],
                        "folder": "/workspace/me/.claude-work",
                        "runtimeId": unattested.to_string(),
                    }),
                ),
            )
            .await?;
            let computer = computer_of(&answer)?;
            assert_eq!(answer["computer"]["logins"], json!([first]), "{answer}");
            assert_eq!(answer["computer"]["runningProjectId"], JsonValue::Null);
            assert_eq!(answer["computer"]["label"], json!("MacBook Pro"));
            assert_eq!(answer["computer"]["online"], json!(true));
            let stored: String = sql_one(
                lane.pool(),
                "select row_to_json(c)::text from user_computers c where id = $1",
                &[&computer],
            )
            .await?;
            assert!(!stored.contains("workspace"), "{stored}");
            assert!(!stored.contains("folder"), "{stored}");

            // Only a private runtime attested to the person is kept.
            for runtime in [personal_browser, lane.member_desktop, Uuid::new_v4()] {
                let answer = polled(
                    &lane,
                    report(&mac, &[first], json!({ "runtimeId": runtime.to_string() })),
                )
                .await?;
                assert_eq!(answer["computer"]["runningProjectId"], JsonValue::Null);
            }
            let answer = polled(
                &lane,
                report(
                    &mac,
                    &[first],
                    json!({ "runtimeId": lane.desktop.to_string(), "label": "Other name" }),
                ),
            )
            .await?;
            assert_eq!(
                answer["computer"]["runningProjectId"],
                json!(space.project_id)
            );
            // A report names a new computer; only its person renames it.
            assert_eq!(answer["computer"]["label"], json!("MacBook Pro"));
            let (status, renamed) = call(
                &lane,
                "PATCH",
                format!("/me/computers/{computer}"),
                &lane.owner(),
                Some(json!({ "label": "  Studio Mac " })),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{renamed}");
            assert_eq!(renamed["label"], json!("Studio Mac"));
            let answer = polled(&lane, report(&mac, &[first], json!({}))).await?;
            assert_eq!(answer["computer"]["label"], json!("Studio Mac"));
            let (status, refused) = call(
                &lane,
                "PATCH",
                format!("/me/computers/{computer}"),
                &lane.owner(),
                Some(json!({ "label": "Studio\nMac" })),
            )
            .await?;
            assert_eq!(
                (status, refused["code"].as_str()),
                (
                    StatusCode::BAD_REQUEST,
                    Some(crate::computers::LABEL_INVALID)
                )
            );
            let (status, _) = poll_as(
                &lane,
                &lane.owner(),
                report("not-a-desktop", &[first], json!({})),
            )
            .await?;
            assert_eq!(status, StatusCode::BAD_REQUEST);
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_computer_is_told_only_of_its_persons_turns_its_logins_can_run() -> anyhow::Result<()> {
    with_lane(
        "computers-wanted",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let project = space.project_id.to_string();
            let first = first_login_of(space.owner);
            let work = another_login_of(&lane, space.owner, "Work").await?;
            let mac = device();
            let work_mac = device();
            let members_mac = device();
            let member = lane.token(space.member);
            let mine = |extra: JsonValue| report(&mac, &[first], extra);

            assert!(spaces_of(&polled(&lane, mine(json!({}))).await?).is_empty());

            // The owner's turn takes their first login: their computer with
            // that login is told, without the turn's words; one with only
            // another login is not.
            let (_, job) = lane.lane_turn().await?;
            let answer = polled(&lane, mine(json!({}))).await?;
            assert_eq!(spaces_of(&answer), vec![project.clone()], "{answer}");
            assert_eq!(answer["wanted"][0]["loginId"], json!(first));
            assert!(!answer.to_string().contains(WORDS));
            assert_eq!(answer["running"], JsonValue::Null);
            assert!(
                spaces_of(&polled(&lane, report(&work_mac, &[work], json!({}))).await?).is_empty()
            );

            // A turn that waits for an earlier one is not wanted yet.
            let earlier = lane.queued_job().await?;
            sql(
                lane.pool(),
                "update agent_jobs set after_job_ids = array[$2]::uuid[] where id = $1",
                &[&job, &earlier],
            )
            .await?;
            assert!(spaces_of(&polled(&lane, mine(json!({}))).await?).is_empty());
            lane.end_job(earlier).await?;
            assert_eq!(
                spaces_of(&polled(&lane, mine(json!({}))).await?),
                vec![project.clone()]
            );

            // A login at its plan's limit takes no turn, so none is wanted.
            sql(
                lane.pool(),
                "update claude_code_logins set limit_resets_at = now() + interval '1 hour'
                  where id = $1",
                &[&first],
            )
            .await?;
            assert!(spaces_of(&polled(&lane, mine(json!({}))).await?).is_empty());
            sql(
                lane.pool(),
                "update claude_code_logins set limit_resets_at = null where id = $1",
                &[&first],
            )
            .await?;

            // A paused computer is told of nothing.
            let computer = computer_of(&polled(&lane, mine(json!({}))).await?)?;
            let (status, paused) = call(
                &lane,
                "PATCH",
                format!("/me/computers/{computer}"),
                &lane.owner(),
                Some(json!({ "status": "paused" })),
            )
            .await?;
            assert_eq!(
                (status, &paused["status"]),
                (StatusCode::OK, &json!("paused"))
            );
            assert!(spaces_of(&polled(&lane, mine(json!({}))).await?).is_empty());
            let (status, _) = call(
                &lane,
                "PATCH",
                format!("/me/computers/{computer}"),
                &lane.owner(),
                Some(json!({ "status": "available" })),
            )
            .await?;
            assert_eq!(status, StatusCode::OK);

            // Once a computer leased it, it is no longer wanted, and the
            // computer that runs it is told it runs it.
            lane.lease_one(lane.desktop, job).await?;
            let answer = polled(
                &lane,
                mine(json!({ "runtimeId": lane.desktop.to_string() })),
            )
            .await?;
            assert!(spaces_of(&answer).is_empty(), "{answer}");
            assert_eq!(
                answer["running"],
                json!({ "projectId": space.project_id, "loginId": first })
            );
            lane.end_jobs().await?;

            // Another person's turn is never this person's computer's.
            let chat = lane.chat().await?;
            lane.admitted_as(&member, chat, &lane_send(lane_metadata(json!({}))))
                .await?;
            assert!(spaces_of(&polled(&lane, mine(json!({}))).await?).is_empty());
            let members = report(&members_mac, &[first_login_of(space.member)], json!({}));
            assert_eq!(
                spaces_of(&polled_as(&lane, &member, members.clone()).await?),
                vec![project.clone()]
            );
            // Nor one in a space the person may no longer write to.
            sql(
                lane.pool(),
                "update org_memberships set role = 'viewer' where user_id = $1",
                &[&space.member],
            )
            .await?;
            sql(
                lane.pool(),
                "update project_memberships set role = 'viewer' where user_id = $1",
                &[&space.member],
            )
            .await?;
            assert!(spaces_of(&polled_as(&lane, &member, members).await?).is_empty());
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_held_poll_returns_when_a_turn_is_queued_or_at_its_deadline() -> anyhow::Result<()> {
    with_lane(
        "computers-held-poll",
        |_, _| {},
        |lane| async move {
            let first = first_login_of(lane.space().owner);
            let mac = device();
            let project = lane.space().project_id.to_string();

            // Nothing waits: held until its deadline.
            let started = Instant::now();
            let answer = polled(&lane, report(&mac, &[first], json!({ "waitMs": 1500 }))).await?;
            let held = started.elapsed();
            assert!(held >= StdDuration::from_millis(1400), "{held:?}");
            assert!(held < StdDuration::from_secs(5), "{held:?}");
            assert_eq!(answer["waited"], json!(true));
            assert!(spaces_of(&answer).is_empty());

            // A send wakes it at once.
            let chat = lane.chat().await?;
            let held_poll = async {
                let answer =
                    polled(&lane, report(&mac, &[first], json!({ "waitMs": 20000 }))).await;
                (answer, Instant::now())
            };
            let send = async {
                tokio::time::sleep(StdDuration::from_millis(300)).await;
                let job = lane
                    .admitted(chat, &lane_send(lane_metadata(json!({}))))
                    .await;
                (job, Instant::now())
            };
            let ((answer, answered_at), (job, sent_at)) = tokio::join!(held_poll, send);
            let answer = answer?;
            job?;
            assert_eq!(spaces_of(&answer), vec![project.clone()], "{answer}");
            assert!(
                answered_at.saturating_duration_since(sent_at) < StdDuration::from_secs(1),
                "answered {:?} after the send",
                answered_at.saturating_duration_since(sent_at)
            );

            // What it already knows holds it, until its deadline.
            let started = Instant::now();
            let answer = polled(
                &lane,
                report(
                    &mac,
                    &[first],
                    json!({ "waitMs": 1200, "known": [project.clone()] }),
                ),
            )
            .await?;
            assert!(started.elapsed() >= StdDuration::from_millis(1100));
            assert_eq!(spaces_of(&answer), vec![project]);
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_claim_keeps_the_persons_other_computers_off_the_space() -> anyhow::Result<()> {
    with_lane(
        "computers-claim",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let project = space.project_id.to_string();
            let first = first_login_of(space.owner);
            let (mac, mini) = (device(), device());
            lane.lane_turn().await?;
            let first_mac = computer_of(&polled(&lane, report(&mac, &[first], json!({}))).await?)?;
            let second_mac =
                computer_of(&polled(&lane, report(&mini, &[first], json!({}))).await?)?;
            let owner = lane.owner();
            let claim = |computer: Uuid, body: JsonValue| {
                call(
                    &lane,
                    "POST",
                    format!("/me/computers/{computer}/claim"),
                    &owner,
                    Some(body),
                )
            };

            let (status, claimed) = claim(first_mac, json!({ "projectId": project })).await?;
            assert_eq!(status, StatusCode::OK, "{claimed}");
            assert_eq!(claimed["claimedProjectId"], json!(project));
            assert_eq!(
                claimed["decisions"][0],
                json!({ "projectId": project, "reason": "starting" })
            );
            let (status, taken) = claim(second_mac, json!({ "projectId": project })).await?;
            assert_eq!(
                (status, taken["code"].as_str()),
                (StatusCode::CONFLICT, Some(crate::computers::CLAIM_TAKEN))
            );
            assert!(
                spaces_of(&polled(&lane, report(&mini, &[first], json!({}))).await?).is_empty()
            );
            assert_eq!(
                spaces_of(&polled(&lane, report(&mac, &[first], json!({}))).await?),
                vec![project.clone()]
            );

            // The claiming computer goes to sleep: the other may start it.
            let (status, _) = call(
                &lane,
                "POST",
                format!("/me/computers/{first_mac}/offline"),
                &lane.owner(),
                Some(json!({ "reason": "sleep" })),
            )
            .await?;
            assert_eq!(status, StatusCode::NO_CONTENT);
            assert_eq!(
                spaces_of(&polled(&lane, report(&mini, &[first], json!({}))).await?),
                vec![project.clone()]
            );
            let (status, _) = claim(second_mac, json!({ "projectId": project })).await?;
            assert_eq!(status, StatusCode::OK);

            // Its start fails: that computer leaves the space alone for a
            // while, and the other may take it.
            let (status, failed) = claim(
                second_mac,
                json!({ "projectId": project, "failed": "no_working_copy" }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{failed}");
            assert_eq!(failed["claimedProjectId"], JsonValue::Null);
            assert_eq!(
                failed["decisions"][0],
                json!({ "projectId": project, "reason": "no_working_copy" })
            );
            assert!(
                spaces_of(&polled(&lane, report(&mini, &[first], json!({}))).await?).is_empty()
            );
            assert_eq!(
                spaces_of(&polled(&lane, report(&mac, &[first], json!({}))).await?),
                vec![project.clone()]
            );
            let (status, _) = claim(
                second_mac,
                json!({ "projectId": project, "failed": "busy" }),
            )
            .await?;
            assert_eq!(status, StatusCode::BAD_REQUEST);

            // A paused computer claims nothing.
            call(
                &lane,
                "PATCH",
                format!("/me/computers/{first_mac}"),
                &lane.owner(),
                Some(json!({ "status": "paused" })),
            )
            .await?;
            let (status, refused) = claim(first_mac, json!({ "projectId": project })).await?;
            assert_eq!(
                (status, refused["code"].as_str()),
                (StatusCode::CONFLICT, Some(crate::computers::PAUSED))
            );
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn presence_reads_offline_and_a_person_has_at_most_ten_computers() -> anyhow::Result<()> {
    with_lane(
        "computers-presence",
        |_, _| {},
        |lane| async move {
            let first = first_login_of(lane.space().owner);
            let mac = device();
            let computer = computer_of(&polled(&lane, report(&mac, &[first], json!({}))).await?)?;
            let listed = || async {
                let (status, listed) = call(
                    &lane,
                    "GET",
                    "/me/computers".to_string(),
                    &lane.owner(),
                    None,
                )
                .await?;
                anyhow::ensure!(status == StatusCode::OK, "{listed}");
                anyhow::Ok(listed["computers"].as_array().cloned().unwrap_or_default())
            };
            assert_eq!(listed().await?[0]["online"], json!(true));

            let (status, _) = call(
                &lane,
                "POST",
                format!("/me/computers/{computer}/offline"),
                &lane.owner(),
                Some(json!({ "reason": "quit" })),
            )
            .await?;
            assert_eq!(status, StatusCode::NO_CONTENT);
            let after = listed().await?;
            assert_eq!(
                (&after[0]["online"], &after[0]["offlineReason"]),
                (&json!(false), &json!("quit"))
            );
            polled(&lane, report(&mac, &[first], json!({}))).await?;
            assert_eq!(listed().await?[0]["online"], json!(true));
            // Unseen for longer than its time to live, it reads offline.
            sql(
                lane.pool(),
                "update user_computers set last_seen_at = now() - interval '1 minute'
                  where id = $1",
                &[&computer],
            )
            .await?;
            assert_eq!(listed().await?[0]["online"], json!(false));
            let (status, _) = call(
                &lane,
                "POST",
                format!("/me/computers/{computer}/offline"),
                &lane.owner(),
                Some(json!({ "reason": "lunch" })),
            )
            .await?;
            assert_eq!(status, StatusCode::BAD_REQUEST);

            // Ten computers, and no eleventh, until one unseen for a month is
            // forgotten.
            for _ in 1..crate::computers::MAX_COMPUTERS {
                polled(&lane, report(&device(), &[first], json!({}))).await?;
            }
            assert_eq!(listed().await?.len(), 10);
            let (status, refused) =
                poll_as(&lane, &lane.owner(), report(&device(), &[first], json!({}))).await?;
            assert_eq!(
                (status, refused["code"].as_str()),
                (StatusCode::CONFLICT, Some(crate::computers::LIMIT))
            );
            sql(
                lane.pool(),
                "update user_computers set last_seen_at = now() - interval '31 days'
                  where id = $1",
                &[&computer],
            )
            .await?;
            polled(&lane, report(&device(), &[first], json!({}))).await?;
            let now = listed().await?;
            assert_eq!(now.len(), 10);
            assert!(now.iter().all(|listed| listed["id"] != json!(computer)));

            // Forgotten by its person.
            let forgotten = now[0]["id"].as_str().unwrap_or_default().to_string();
            let (status, _) = call(
                &lane,
                "DELETE",
                format!("/me/computers/{forgotten}"),
                &lane.owner(),
                None,
            )
            .await?;
            assert_eq!(status, StatusCode::NO_CONTENT);
            assert_eq!(listed().await?.len(), 9);
            Ok(())
        },
    )
    .await
}

#[tokio::test]
async fn a_computers_report_makes_no_runtime_lease_a_turn() -> anyhow::Result<()> {
    with_lane(
        "computers-lease-safety",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let first = first_login_of(space.owner);
            let (_, job) = lane.lane_turn().await?;
            // The owner's computer reports the space's plain runtime, attested
            // to them but with no Claude Code, as the one it runs, ready on the
            // turn's login: that runtime still leases nothing.
            let answer = polled(
                &lane,
                report(
                    &device(),
                    &[first],
                    json!({ "runtimeId": space.runtime.to_string() }),
                ),
            )
            .await?;
            assert_eq!(
                answer["computer"]["runningProjectId"],
                json!(space.project_id)
            );
            lane.leases_nothing(space.runtime, "a reported runtime")
                .await?;
            lane.lease_one(lane.desktop, job).await?;
            Ok(())
        },
    )
    .await
}
