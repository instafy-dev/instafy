// Backup AIs on the migrated database (docs/Local-Engine-Turns.md 11.20):
// an agent lists its owner's own sign-ins after its first AI
// (`user_agents.backup_ais`, through `/me/agents` alone), and each turn runs on
// the first of them with room (crate::sign_in_room). A connection at its plan's
// limit sends the turn to the next AI, a Claude Code login to the next login of
// its stretch, as a lane turn behind the lane's own gates and lease; completion
// records a limit from the turn that reached it and clears it when a turn
// completes, and names the sign-in a turn ran on and the agent's next AI with
// room. A child of the lane tests, whose space and harness it shares: the
// owner's default connection, their @helper on it, their @claude on Claude
// Code, their first login and their lane-ready computers.

use chrono::Duration;

use super::*;
use crate::sign_in_room::SignIn;

/// A connection of `user`'s that is not their default, as a second ChatGPT
/// sign-in would be.
async fn connection_of(lane: &Lane, user: Uuid, label: &str) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    sql(
        lane.pool(),
        "insert into user_credentials (
             id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata, is_default
         ) values ($1, $2, 'openai_api_key', $3, 'test-nonce', 'test-ciphertext', '{}'::jsonb,
             false)",
        &[&id, &user, &label],
    )
    .await?;
    Ok(id)
}

/// A Claude Code login of `user`'s, made `minutes` after their first one.
async fn login_of(lane: &Lane, user: Uuid, label: &str, minutes: i64) -> anyhow::Result<Uuid> {
    let id = Uuid::new_v4();
    sql(
        lane.pool(),
        "insert into claude_code_logins (id, user_id, label, created_at)
         values ($1, $2, $3, now() - interval '1 day' + $4::bigint * interval '1 minute')",
        &[&id, &user, &label, &minutes],
    )
    .await?;
    Ok(id)
}

/// Records that `sign_in`'s plan has no room for `minutes` from now (in the
/// past for a negative number), as completion records it; None clears it.
async fn limit(lane: &Lane, sign_in: SignIn, minutes: Option<i64>) -> anyhow::Result<()> {
    let (table, id) = match sign_in {
        SignIn::Credential(id) => ("user_credentials", id),
        SignIn::Login(id) => ("claude_code_logins", id),
    };
    sql(
        lane.pool(),
        &format!(
            "update {table}
                set limit_resets_at = now() + $2::bigint * interval '1 minute'
              where id = $1"
        ),
        &[&id, &minutes],
    )
    .await?;
    Ok(())
}

/// Clears every limit of `user`'s sign-ins and their usage.
async fn all_room(lane: &Lane, user: Uuid) -> anyhow::Result<()> {
    sql(
        lane.pool(),
        "update user_credentials set limit_resets_at = null, subscription_usage = null
          where user_id = $1",
        &[&user],
    )
    .await?;
    sql(
        lane.pool(),
        "update claude_code_logins set limit_resets_at = null where user_id = $1",
        &[&user],
    )
    .await?;
    Ok(())
}

/// When `sign_in`'s recorded limit resets, if one is recorded.
async fn limit_of(lane: &Lane, sign_in: SignIn) -> anyhow::Result<Option<DateTime<Utc>>> {
    let (table, id) = match sign_in {
        SignIn::Credential(id) => ("user_credentials", id),
        SignIn::Login(id) => ("claude_code_logins", id),
    };
    sql_one(
        lane.pool(),
        &format!("select limit_resets_at from {table} where id = $1"),
        &[&id],
    )
    .await
}

/// A send of [`WORDS`] to the sender's own `handle`, naming `runtime`, which a
/// Codex turn is pinned to and a lane turn drops.
fn send_to(handle: &str, runtime: Uuid) -> JsonValue {
    json!({
        "promptText": WORDS,
        "intent": "feature",
        "runtimeId": runtime.to_string(),
        "metadata": metadata_for(&[handle], json!({})),
    })
}

/// The owner sends [`send_to`] `handle` in a new chat: its job.
async fn sent(lane: &Lane, handle: &str) -> anyhow::Result<(Uuid, Job)> {
    let chat = lane.chat().await?;
    let job = lane
        .admitted(chat, &send_to(handle, lane.space().runtime))
        .await?;
    Ok((job, lane.job(job).await?))
}

/// The `aiSignIn` stamp of `job`'s run.
async fn run_sign_in(lane: &Lane, job: &Job) -> anyhow::Result<JsonValue> {
    let run = job.run_id.expect("run");
    Ok(lane
        .metadata_of("select metadata from runs where id = $1", run)
        .await?["aiSignIn"]
        .clone())
}

fn stamp(sign_in: SignIn, backup: bool) -> JsonValue {
    let mut stamp = sign_in.entry();
    if backup {
        stamp["backup"] = json!(true);
    }
    stamp
}

/// `body` with `backupAis` saved on `agent` through its owner's session.
async fn save(
    lane: &Lane,
    agent: Uuid,
    body: JsonValue,
) -> anyhow::Result<(StatusCode, JsonValue)> {
    lane.harness
        .call(
            "PATCH",
            format!("/me/agents/{agent}"),
            Some(&lane.owner()),
            Some(body),
        )
        .await
}

/// `agent` as the owner's agent list returns it.
async fn listed(lane: &Lane, agent: Uuid) -> anyhow::Result<JsonValue> {
    let (status, agents) = lane
        .harness
        .call("GET", "/me/agents", Some(&lane.owner()), None)
        .await?;
    anyhow::ensure!(status == StatusCode::OK, "list: {status} {agents}");
    Ok(agents
        .as_array()
        .and_then(|agents| {
            agents
                .iter()
                .find(|listed| listed["id"] == json!(agent.to_string()))
        })
        .cloned()
        .unwrap_or(JsonValue::Null))
}

/// `agent`'s backups as stored.
async fn stored(lane: &Lane, agent: Uuid) -> anyhow::Result<JsonValue> {
    sql_one(
        lane.pool(),
        "select backup_ais from user_agents where id = $1",
        &[&agent],
    )
    .await
}

fn entries(sign_ins: &[SignIn]) -> JsonValue {
    crate::sign_in_room::entries(sign_ins)
}

/// `/me/agents`'s `backupAis` (docs/Local-Engine-Turns.md 11.20): set when an
/// agent is made, replaced by an update, kept when absent and cleared by `[]`;
/// read back with only the live entries, in order. Each entry is one of the
/// owner's own live connections or logins, once, and not the agent's first
/// AI; none for an agent on Instafy AI or the default, and choosing either
/// clears them; a login only while the switch covers the owner. Another
/// person's connection or login is never one.
#[tokio::test]
async fn an_agents_backups_are_its_owners_own_sign_ins() -> anyhow::Result<()> {
    with_lane(
        "backup-ais-list",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let owner = space.owner;
            let chatgpt = lane.owner_credential;
            let chatgpt_2 = connection_of(&lane, owner, "ChatGPT 2").await?;
            let chatgpt_3 = connection_of(&lane, owner, "ChatGPT 3").await?;
            let first = first_login_of(owner);
            let work = login_of(&lane, owner, "Work", 1).await?;
            let members_connection: Uuid = sql_one(
                lane.pool(),
                "select id from user_credentials where user_id = $1",
                &[&space.member],
            )
            .await?;

            // Made with its backups.
            let (status, made) = lane
                .harness
                .call(
                    "POST",
                    "/me/agents",
                    Some(&lane.owner()),
                    Some(json!({
                        "handle": "reviewer",
                        "credentialId": chatgpt,
                        "backupAis": [
                            { "credentialId": chatgpt_2 },
                            { "claudeCodeLoginId": work },
                        ],
                    })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{made}");
            let both = entries(&[SignIn::Credential(chatgpt_2), SignIn::Login(work)]);
            assert_eq!(made["backupAis"], both, "{made}");
            let reviewer = Uuid::parse_str(made["id"].as_str().expect("an id"))?;
            assert_eq!(stored(&lane, reviewer).await?, both);
            assert_eq!(listed(&lane, reviewer).await?["backupAis"], both);
            // Every other agent has none.
            let (_, agents) = lane
                .harness
                .call("GET", "/me/agents", Some(&lane.owner()), None)
                .await?;
            for agent in agents.as_array().into_iter().flatten() {
                if agent["id"] != json!(reviewer.to_string()) {
                    assert_eq!(agent["backupAis"], json!([]), "{agent}");
                }
            }

            // An update replaces them, absent keeps them, and `[]` clears them.
            let (status, saved) = save(
                &lane,
                reviewer,
                json!({ "backupAis": [{ "claudeCodeLoginId": work }, { "credentialId": chatgpt_3 }] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{saved}");
            let replaced = entries(&[SignIn::Login(work), SignIn::Credential(chatgpt_3)]);
            assert_eq!(saved["backupAis"], replaced);
            let (status, saved) = save(&lane, reviewer, json!({ "displayName": "Reviewer" })).await?;
            assert_eq!(status, StatusCode::OK, "{saved}");
            assert_eq!(saved["backupAis"], replaced, "absent keeps them");
            let (status, saved) = save(&lane, reviewer, json!({ "backupAis": [] })).await?;
            assert_eq!((status, &saved["backupAis"]), (StatusCode::OK, &json!([])));
            assert_eq!(stored(&lane, reviewer).await?, json!([]));
            let (status, _) =
                save(&lane, reviewer, json!({ "backupAis": replaced.clone() })).await?;
            assert_eq!(status, StatusCode::OK);

            // Each refusal leaves the list as it was.
            let nine: Vec<JsonValue> = (0..9)
                .map(|_| json!({ "credentialId": chatgpt_2 }))
                .collect();
            for (what, body, expected) in [
                (
                    "another person's connection",
                    json!({ "backupAis": [{ "credentialId": members_connection }] }),
                    (StatusCode::UNPROCESSABLE_ENTITY, "backup_ai_unknown"),
                ),
                (
                    "another person's login",
                    json!({ "backupAis": [{ "claudeCodeLoginId": first_login_of(space.member) }] }),
                    (StatusCode::UNPROCESSABLE_ENTITY, "backup_ai_unknown"),
                ),
                (
                    "a connection that does not exist",
                    json!({ "backupAis": [{ "credentialId": Uuid::new_v4() }] }),
                    (StatusCode::UNPROCESSABLE_ENTITY, "backup_ai_unknown"),
                ),
                (
                    "no id at all",
                    json!({ "backupAis": [{ "claudeCodeLoginId": "work" }] }),
                    (StatusCode::UNPROCESSABLE_ENTITY, "backup_ai_unknown"),
                ),
                (
                    "twice",
                    json!({ "backupAis": [{ "credentialId": chatgpt_2 }, { "credentialId": chatgpt_2 }] }),
                    (StatusCode::UNPROCESSABLE_ENTITY, "backup_ai_repeated"),
                ),
                (
                    "its own first AI",
                    json!({ "backupAis": [{ "credentialId": chatgpt }] }),
                    (StatusCode::UNPROCESSABLE_ENTITY, "backup_ai_repeated"),
                ),
                (
                    "more than eight",
                    json!({ "backupAis": nine }),
                    (StatusCode::BAD_REQUEST, "backup_ai_limit"),
                ),
                (
                    "on the default",
                    json!({ "credentialId": null, "backupAis": [{ "credentialId": chatgpt_2 }] }),
                    (StatusCode::BAD_REQUEST, "backup_ai_needs_own_ai"),
                ),
                (
                    "on Instafy AI",
                    json!({ "provider": "openai", "credentialId": null, "backupAis": [{ "credentialId": chatgpt_2 }] }),
                    (StatusCode::BAD_REQUEST, "backup_ai_needs_own_ai"),
                ),
            ] {
                let (status, body) = save(&lane, reviewer, body).await?;
                assert_eq!(
                    (status, body["code"].as_str()),
                    (expected.0, Some(expected.1)),
                    "{what}: {body}"
                );
                assert_eq!(stored(&lane, reviewer).await?, replaced, "{what}");
            }
            for shape in [
                json!({ "backupAis": [{ "credentialId": chatgpt_2, "claudeCodeLoginId": work }] }),
                json!({ "backupAis": [chatgpt_2.to_string()] }),
                json!({ "backupAis": { "credentialId": chatgpt_2 } }),
            ] {
                let (status, body) = save(&lane, reviewer, shape.clone()).await?;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{shape}: {body}");
            }
            // @octo, on Instafy AI, has no AI of its own to back up.
            let octo: Uuid = sql_one(
                lane.pool(),
                "select id from user_agents where user_id = $1 and handle = 'octo'",
                &[&owner],
            )
            .await?;
            let (status, body) = save(
                &lane,
                octo,
                json!({ "backupAis": [{ "credentialId": chatgpt_2 }] }),
            )
            .await?;
            assert_eq!(
                (status, body["code"].as_str()),
                (StatusCode::BAD_REQUEST, Some("backup_ai_needs_own_ai")),
                "{body}"
            );
            // A made agent's backups are checked the same way.
            let (status, body) = lane
                .harness
                .call(
                    "POST",
                    "/me/agents",
                    Some(&lane.owner()),
                    Some(json!({
                        "handle": "drafter",
                        "backupAis": [{ "credentialId": chatgpt_2 }],
                    })),
                )
                .await?;
            assert_eq!(
                (status, body["code"].as_str()),
                (StatusCode::BAD_REQUEST, Some("backup_ai_needs_own_ai")),
                "{body}"
            );

            // A Claude Code agent's first AI is its first login, which no
            // backup of its repeats.
            let (status, body) = save(
                &lane,
                lane.owner_claude,
                json!({ "backupAis": [{ "claudeCodeLoginId": first }] }),
            )
            .await?;
            assert_eq!(
                (status, body["code"].as_str()),
                (StatusCode::UNPROCESSABLE_ENTITY, Some("backup_ai_repeated")),
                "{body}"
            );
            let (status, body) = save(
                &lane,
                lane.owner_claude,
                json!({ "backupAis": [{ "claudeCodeLoginId": work }, { "credentialId": chatgpt }] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(
                body["backupAis"],
                entries(&[SignIn::Login(work), SignIn::Credential(chatgpt)])
            );

            // Only live entries are read back: a revoked connection and a
            // deleted login drop out, and the rest keep their order.
            sql(
                lane.pool(),
                "update user_credentials set revoked_at = now() where id = $1",
                &[&chatgpt_3],
            )
            .await?;
            assert_eq!(
                listed(&lane, reviewer).await?["backupAis"],
                entries(&[SignIn::Login(work)])
            );
            let (status, body) = lane
                .harness
                .call(
                    "DELETE",
                    format!("/me/claude-code-logins/{work}"),
                    Some(&lane.owner()),
                    None,
                )
                .await?;
            assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
            assert_eq!(listed(&lane, reviewer).await?["backupAis"], json!([]));
            assert_eq!(
                listed(&lane, lane.owner_claude).await?["backupAis"],
                entries(&[SignIn::Credential(chatgpt)])
            );

            // Choosing the default or Instafy AI clears them.
            let (status, _) = save(
                &lane,
                reviewer,
                json!({ "backupAis": [{ "credentialId": chatgpt_2 }] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK);
            let (status, saved) = save(&lane, reviewer, json!({ "credentialId": null })).await?;
            assert_eq!(status, StatusCode::OK, "{saved}");
            assert_eq!(saved["backupAis"], json!([]));
            assert_eq!(stored(&lane, reviewer).await?, json!([]));
            let (status, _) = save(
                &lane,
                lane.owner_claude,
                json!({ "backupAis": [{ "credentialId": chatgpt_2 }] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK);
            let (status, saved) = save(&lane, lane.owner_claude, json!({ "provider": "openai" })).await?;
            assert_eq!(status, StatusCode::OK, "{saved}");
            assert_eq!(stored(&lane, lane.owner_claude).await?, json!([]));
            // A connection chosen keeps the list, less an entry that has
            // become its first AI.
            let (status, _) = save(
                &lane,
                reviewer,
                json!({
                    "credentialId": chatgpt,
                    "backupAis": [{ "credentialId": chatgpt_2 }, { "claudeCodeLoginId": first }],
                }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK);
            let (status, saved) = save(&lane, reviewer, json!({ "credentialId": chatgpt_2 })).await?;
            assert_eq!(status, StatusCode::OK, "{saved}");
            assert_eq!(saved["backupAis"], entries(&[SignIn::Login(first)]));
            assert_eq!(stored(&lane, reviewer).await?, entries(&[SignIn::Login(first)]));

            // A login among them needs the switch: the guest, whom it does not
            // cover, may list connections only.
            let guest = space.guest;
            let guest_agent: Uuid = sql_one(
                lane.pool(),
                "select id from user_agents where user_id = $1 and handle = 'helper'",
                &[&guest],
            )
            .await?;
            let guest_login = login_of(&lane, guest, "Guest", 1).await?;
            let guest_connection = connection_of(&lane, guest, "Guest 2").await?;
            let guest_save = |body: JsonValue| {
                let lane = &lane;
                async move {
                    lane.harness
                        .call(
                            "PATCH",
                            format!("/me/agents/{guest_agent}"),
                            Some(&lane.token(guest)),
                            Some(body),
                        )
                        .await
                }
            };
            let (status, body) =
                guest_save(json!({ "backupAis": [{ "claudeCodeLoginId": guest_login }] })).await?;
            assert_eq!(
                (status, body["code"].as_str()),
                (StatusCode::FORBIDDEN, Some("claude_code_turn_not_allowed")),
                "{body}"
            );
            let (status, body) =
                guest_save(json!({ "backupAis": [{ "credentialId": guest_connection }] })).await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            // Nor does anyone else's session set them: the guest's own
            // session finds no agent of the owner's, and a job's token is no
            // person's session.
            let (status, _) = lane
                .harness
                .call(
                    "PATCH",
                    format!("/me/agents/{reviewer}"),
                    Some(&lane.token(guest)),
                    Some(json!({ "backupAis": [] })),
                )
                .await?;
            assert_eq!(status, StatusCode::NOT_FOUND);
            assert_eq!(stored(&lane, reviewer).await?, entries(&[SignIn::Login(first)]));
            let (status, _) = lane
                .harness
                .call(
                    "PATCH",
                    format!("/me/agents/{reviewer}"),
                    Some(SERVICE_ROLE),
                    Some(json!({ "backupAis": [] })),
                )
                .await?;
            assert_eq!(status, StatusCode::UNAUTHORIZED);
            Ok(())
        },
    )
    .await
}

/// Dispatch takes the first of an agent's AIs with room
/// (docs/Local-Engine-Turns.md 11.20): a connection at its limit, whether
/// recorded or shown by a full usage window, moves the turn to the next
/// connection, and both at theirs to a Claude Code login, as a lane turn; a
/// Claude Code agent's first login at its limit moves it to the next login,
/// with the stretch of logins, and every login at its limit to a connection;
/// with none with room the earliest reset wins; a revoked connection, a
/// deleted login and another person's are passed over; and with none usable
/// the agent keeps what it took before backups. Each run names the sign-in,
/// and whether it is a backup.
#[tokio::test]
async fn a_turn_runs_on_the_first_of_its_agents_ais_with_room() -> anyhow::Result<()> {
    with_lane(
        "backup-ais-dispatch",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let owner = space.owner;
            let chatgpt = lane.owner_credential;
            let chatgpt_2 = connection_of(&lane, owner, "ChatGPT 2").await?;
            let first = first_login_of(owner);
            let work = login_of(&lane, owner, "Work", 1).await?;
            let home = login_of(&lane, owner, "Home", 2).await?;
            let (status, made) = lane
                .harness
                .call(
                    "POST",
                    "/me/agents",
                    Some(&lane.owner()),
                    Some(json!({
                        "handle": "reviewer",
                        "credentialId": chatgpt,
                        "backupAis": [{ "credentialId": chatgpt_2 }, { "claudeCodeLoginId": work }],
                    })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{made}");
            let reviewer = Uuid::parse_str(made["id"].as_str().expect("an id"))?;
            let (status, body) = save(
                &lane,
                lane.owner_claude,
                json!({ "backupAis": [
                    { "claudeCodeLoginId": work },
                    { "claudeCodeLoginId": home },
                    { "credentialId": chatgpt_2 },
                ] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            let codex_on = |job: &Job, credential: Uuid, what: &str| {
                assert_eq!(job.engine, None, "{what}");
                assert_eq!(job.credential_id, Some(credential), "{what}");
                assert_eq!(job.claude_code_login_ids, None, "{what}");
            };

            // The first AI, with room.
            let (_, job) = sent(&lane, "reviewer").await?;
            codex_on(&job, chatgpt, "the first AI");
            assert_eq!(run_sign_in(&lane, &job).await?, stamp(SignIn::Credential(chatgpt), false));

            // Its limit ahead: the next connection, a backup.
            limit(&lane, SignIn::Credential(chatgpt), Some(60)).await?;
            let (_, job) = sent(&lane, "reviewer").await?;
            codex_on(&job, chatgpt_2, "a recorded limit");
            assert_eq!(run_sign_in(&lane, &job).await?, stamp(SignIn::Credential(chatgpt_2), true));
            // A full usage window ahead holds as a recorded limit does.
            limit(&lane, SignIn::Credential(chatgpt), None).await?;
            let reset_at = (Utc::now() + Duration::hours(2)).timestamp();
            sql(
                lane.pool(),
                "update user_credentials set subscription_usage = $2 where id = $1",
                &[
                    &chatgpt,
                    &PgJson(json!({ "windows": [
                        { "kind": "primary", "usedPercent": 100, "windowMinutes": 300, "resetAt": reset_at },
                        { "kind": "secondary", "usedPercent": 12, "windowMinutes": 10080, "resetAt": reset_at },
                    ] })),
                ],
            )
            .await?;
            let (_, job) = sent(&lane, "reviewer").await?;
            codex_on(&job, chatgpt_2, "a full window");
            // A limit and a full window that have passed hold nothing.
            sql(
                lane.pool(),
                "update user_credentials
                    set limit_resets_at = now() - interval '1 minute',
                        subscription_usage = jsonb_build_object('windows', jsonb_build_array(
                            jsonb_build_object('usedPercent', 100,
                                               'resetAt', extract(epoch from now())::bigint - 60)))
                  where id = $1",
                &[&chatgpt],
            )
            .await?;
            let (_, job) = sent(&lane, "reviewer").await?;
            codex_on(&job, chatgpt, "a limit that passed");

            // Both connections at their limits: the login after them, as a
            // lane turn, unpinned, whatever runtime the send named.
            all_room(&lane, owner).await?;
            limit(&lane, SignIn::Credential(chatgpt), Some(60)).await?;
            limit(&lane, SignIn::Credential(chatgpt_2), Some(30)).await?;
            let (_, job) = sent(&lane, "reviewer").await?;
            assert_eq!(job.engine.as_deref(), Some(claude_code_lane::ENGINE));
            assert_eq!(job.credential_id, None);
            assert_eq!(job.target_runtime_id, None);
            assert_eq!(job.claude_code_login_ids, Some(vec![work]));
            let run = lane
                .metadata_of("select metadata from runs where id = $1", job.run_id.expect("run"))
                .await?;
            assert_lane_stamps(&run, Some(work), "a Codex agent's turn on a login");
            assert_eq!(run["aiSignIn"], stamp(SignIn::Login(work), true));
            assert_lane_stamps(&job.payload["metadata"], None, "its payload");
            // None with room: the one whose limit resets first.
            limit(&lane, SignIn::Login(work), Some(45)).await?;
            let (_, job) = sent(&lane, "reviewer").await?;
            codex_on(&job, chatgpt_2, "the earliest reset");
            assert_eq!(run_sign_in(&lane, &job).await?, stamp(SignIn::Credential(chatgpt_2), true));

            // A Claude Code agent on its first login, with its stretch of
            // logins.
            all_room(&lane, owner).await?;
            let stretch = Some(vec![first, work, home]);
            let (_, job) = sent(&lane, CLAUDE).await?;
            assert_eq!(job.engine.as_deref(), Some(claude_code_lane::ENGINE));
            assert_eq!(job.claude_code_login_ids, stretch);
            let run = lane
                .metadata_of("select metadata from runs where id = $1", job.run_id.expect("run"))
                .await?;
            assert_lane_stamps(&run, Some(first), "its first login");
            assert_eq!(run["aiSignIn"], stamp(SignIn::Login(first), false));
            // Its first login at its limit: the next login.
            limit(&lane, SignIn::Login(first), Some(60)).await?;
            let (_, job) = sent(&lane, CLAUDE).await?;
            assert_eq!(job.claude_code_login_ids, stretch);
            let run = lane
                .metadata_of("select metadata from runs where id = $1", job.run_id.expect("run"))
                .await?;
            assert_lane_stamps(&run, Some(work), "the next login");
            assert_eq!(run["aiSignIn"], stamp(SignIn::Login(work), true));
            // Every login at its limit: the connection after them.
            limit(&lane, SignIn::Login(work), Some(60)).await?;
            limit(&lane, SignIn::Login(home), Some(60)).await?;
            let (_, job) = sent(&lane, CLAUDE).await?;
            codex_on(&job, chatgpt_2, "a Claude Code agent's turn on a connection");
            assert_eq!(job.target_runtime_id, Some(space.runtime));
            assert_eq!(run_sign_in(&lane, &job).await?, stamp(SignIn::Credential(chatgpt_2), true));
            // Every one at its limit: the earliest reset, a login.
            limit(&lane, SignIn::Credential(chatgpt_2), Some(90)).await?;
            limit(&lane, SignIn::Login(home), Some(20)).await?;
            let (_, job) = sent(&lane, CLAUDE).await?;
            assert_eq!(job.claude_code_login_ids, stretch);
            assert_eq!(run_sign_in(&lane, &job).await?, stamp(SignIn::Login(home), true));

            // Passed over: a revoked connection, then a deleted login.
            all_room(&lane, owner).await?;
            limit(&lane, SignIn::Credential(chatgpt), Some(60)).await?;
            sql(
                lane.pool(),
                "update user_credentials set revoked_at = now() where id = $1",
                &[&chatgpt_2],
            )
            .await?;
            let (_, job) = sent(&lane, "reviewer").await?;
            assert_eq!(job.claude_code_login_ids, Some(vec![work]), "the revoked one passed over");
            sql(lane.pool(), "delete from claude_code_logins where id = $1", &[&work]).await?;
            let (_, job) = sent(&lane, "reviewer").await?;
            codex_on(&job, chatgpt, "only its first AI is left, at its limit");
            assert_eq!(run_sign_in(&lane, &job).await?, stamp(SignIn::Credential(chatgpt), false));
            // Another person's connection and login, written into the row by
            // hand, are never used.
            let members_connection: Uuid = sql_one(
                lane.pool(),
                "select id from user_credentials where user_id = $1",
                &[&space.member],
            )
            .await?;
            sql(
                lane.pool(),
                "update user_agents set backup_ais = $2 where id = $1",
                &[
                    &reviewer,
                    &PgJson(entries(&[
                        SignIn::Credential(members_connection),
                        SignIn::Login(first_login_of(space.member)),
                        SignIn::Login(home),
                    ])),
                ],
            )
            .await?;
            let (_, job) = sent(&lane, "reviewer").await?;
            assert_eq!(job.claude_code_login_ids, Some(vec![home]));
            assert_eq!(job.payload["user_id"], json!(owner.to_string()));

            // An agent whose own connection was revoked, with no usable
            // backup, runs on the default as before.
            let solo = Uuid::new_v4();
            sql(
                lane.pool(),
                "insert into user_agents (
                     id, user_id, credential_id, provider, handle, display_name, avatar_seed,
                     backup_ais
                 ) values ($1, $2, $3, 'openai', 'solo', 'Solo', 'hatchling:3', $4)",
                &[
                    &solo,
                    &owner,
                    &chatgpt_2,
                    &PgJson(entries(&[SignIn::Credential(members_connection)])),
                ],
            )
            .await?;
            let (_, job) = sent(&lane, "solo").await?;
            codex_on(&job, chatgpt, "the default");
            assert_eq!(run_sign_in(&lane, &job).await?, stamp(SignIn::Credential(chatgpt), false));
            Ok(())
        },
    )
    .await
}

/// A waiting lane turn moves among the logins of its stretch
/// (docs/Local-Engine-Turns.md 11.20): its lease takes the first of its logins
/// with room, so a turn whose first login reached its limit meanwhile runs on
/// the next; with none of them with room it waits, and its computer's poll
/// idles, until one resets. A login of another person's in its stretch never
/// counts: with none of the stretch its person's, the lease takes their
/// oldest login with room.
#[tokio::test]
async fn a_waiting_lane_turn_moves_to_the_next_login_of_its_stretch() -> anyhow::Result<()> {
    with_lane(
        "backup-ais-lease",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let owner = space.owner;
            let first = first_login_of(owner);
            let work = login_of(&lane, owner, "Work", 1).await?;
            let home = login_of(&lane, owner, "Home", 2).await?;
            let (status, body) = save(
                &lane,
                lane.owner_claude,
                json!({ "backupAis": [{ "claudeCodeLoginId": work }, { "claudeCodeLoginId": home }] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            lane.set_capabilities(
                lane.desktop,
                capabilities(Some(owner), lane_ready_on(&[first, work, home])),
            )
            .await?;

            // Sent while its first login had room; that login reaches its
            // limit before a computer takes the turn.
            let (_, job) = lane.lane_turn().await?;
            assert_eq!(
                lane.job(job).await?.claude_code_login_ids,
                Some(vec![first, work, home])
            );
            limit(&lane, SignIn::Login(first), Some(60)).await?;
            let leased = lane.lease_one(lane.desktop, job).await?;
            assert_eq!(leased["claude_code_login_id"], json!(work.to_string()));
            assert_eq!(lane.job(job).await?.claude_code_login_id, Some(work));
            lane.end_job(job).await?;

            // None of its logins with room: it waits.
            let (_, next) = lane.lane_turn().await?;
            limit(&lane, SignIn::Login(work), Some(60)).await?;
            limit(&lane, SignIn::Login(home), Some(30)).await?;
            lane.leases_nothing(lane.desktop, "no login of its stretch has room")
                .await?;
            lane.idles(lane.desktop, "no login of its stretch has room")
                .await?;
            assert_eq!(lane.job(next).await?.status, "queued");
            // Home's limit resets: the turn runs there.
            limit(&lane, SignIn::Login(home), Some(-1)).await?;
            let leased = lane.lease_one(lane.desktop, next).await?;
            assert_eq!(leased["claude_code_login_id"], json!(home.to_string()));
            lane.end_job(next).await?;

            // A stretch that names another person's login: theirs never
            // counts, and the person's own login in it has no room.
            let (_, foreign) = lane.lane_turn().await?;
            let members_login = first_login_of(space.member);
            sql(
                lane.pool(),
                "update agent_jobs set claude_code_login_ids = $2 where id = $1",
                &[&foreign, &vec![members_login, first]],
            )
            .await?;
            lane.set_capabilities(
                lane.desktop,
                capabilities(Some(owner), lane_ready_on(&[first, work, home, members_login])),
            )
            .await?;
            lane.leases_nothing(lane.desktop, "the member's login never counts")
                .await?;
            // None of it the person's: their oldest login with room, Home.
            sql(
                lane.pool(),
                "update agent_jobs set claude_code_login_ids = $2 where id = $1",
                &[&foreign, &vec![members_login]],
            )
            .await?;
            let leased = lane.lease_one(lane.desktop, foreign).await?;
            assert_eq!(leased["claude_code_login_id"], json!(home.to_string()));
            Ok(())
        },
    )
    .await
}

/// A turn's end, as its leasing runtime reports it (docs/Local-Engine-Turns.md
/// 11.20): a failed Codex turn with an `ai/usage-limit` artifact records its
/// own credential's limit, until the reset it gave but at most eight days, an
/// hour with none, and nothing for a reset that has passed; a failed lane turn
/// that reports `plan_limit` with its reset records the limit of the login
/// its lease took; a completed turn clears its sign-in's limit. The reply and
/// the failure name the sign-in the turn ran on, and whether it is a backup,
/// and a failure at a limit names the agent's next AI with room, when it has
/// one.
#[tokio::test]
async fn a_turns_end_records_its_sign_ins_limit_and_names_the_next_ai() -> anyhow::Result<()> {
    with_lane(
        "backup-ais-completion",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let owner = space.owner;
            let chatgpt = lane.owner_credential;
            let chatgpt_2 = connection_of(&lane, owner, "ChatGPT 2").await?;
            let first = first_login_of(owner);
            let work = login_of(&lane, owner, "Work", 1).await?;
            let (status, made) = lane
                .harness
                .call(
                    "POST",
                    "/me/agents",
                    Some(&lane.owner()),
                    Some(json!({
                        "handle": "reviewer",
                        "credentialId": chatgpt,
                        "backupAis": [{ "credentialId": chatgpt_2 }],
                    })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{made}");
            let (status, body) = save(
                &lane,
                lane.owner_claude,
                json!({ "backupAis": [{ "claudeCodeLoginId": work }] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            let runtime = space.runtime;
            // The owner's turn to @reviewer, failed by its runtime at its
            // usage limit with `resets_at`: its job and run.
            let failed_at_limit = |resets_at: JsonValue| {
                let lane = &lane;
                async move {
                    let (job, sent_job) = sent(lane, "reviewer").await?;
                    lane.lease_one(runtime, job).await?;
                    lane.harness
                        .complete(
                            runtime,
                            job,
                            json!({
                                "outcome": "failed",
                                "error_message": "You've hit your usage limit. Try again later.",
                                "artifacts": [
                                    { "kind": "ai/usage-limit", "resetsAt": resets_at },
                                ],
                            }),
                        )
                        .await?;
                    anyhow::Ok((sent_job, lane.job(job).await?.run_id.expect("run")))
                }
            };
            let near = |at: Option<DateTime<Utc>>, expected: DateTime<Utc>| {
                at.is_some_and(|at| (at - expected).num_seconds().abs() <= 60)
            };

            // Until the reset it gave.
            let reset = Utc::now() + Duration::hours(3);
            let (job, run) = failed_at_limit(json!(reset.timestamp())).await?;
            assert_eq!(job.credential_id, Some(chatgpt));
            assert_eq!(
                limit_of(&lane, SignIn::Credential(chatgpt))
                    .await?
                    .map(|at| at.timestamp()),
                Some(reset.timestamp())
            );
            assert_eq!(limit_of(&lane, SignIn::Credential(chatgpt_2)).await?, None);
            let (_, failure) = lane.failure_message(run).await?;
            assert_eq!(
                failure["aiSignIn"],
                stamp(SignIn::Credential(chatgpt), false)
            );
            assert_eq!(
                failure["aiSignInNext"],
                SignIn::Credential(chatgpt_2).entry()
            );
            // At most eight days ahead.
            all_room(&lane, owner).await?;
            failed_at_limit(json!((Utc::now() + Duration::days(30)).timestamp())).await?;
            assert!(near(
                limit_of(&lane, SignIn::Credential(chatgpt)).await?,
                Utc::now() + Duration::days(8)
            ));
            // An hour without a reset.
            all_room(&lane, owner).await?;
            failed_at_limit(JsonValue::Null).await?;
            assert!(near(
                limit_of(&lane, SignIn::Credential(chatgpt)).await?,
                Utc::now() + Duration::hours(1)
            ));
            // Nothing for a reset that has passed, and no next AI named.
            all_room(&lane, owner).await?;
            let (_, run) =
                failed_at_limit(json!((Utc::now() - Duration::hours(1)).timestamp())).await?;
            assert_eq!(limit_of(&lane, SignIn::Credential(chatgpt)).await?, None);
            let (_, failure) = lane.failure_message(run).await?;
            assert_eq!(
                failure["aiSignIn"],
                stamp(SignIn::Credential(chatgpt), false)
            );
            assert!(failure.get("aiSignInNext").is_none(), "{failure}");
            // A failure that is no usage limit records nothing.
            let (job, _) = sent(&lane, "reviewer").await?;
            lane.lease_one(runtime, job).await?;
            lane.harness
                .complete(
                    runtime,
                    job,
                    json!({ "outcome": "failed", "error_message": "Codex run timed out" }),
                )
                .await?;
            assert_eq!(limit_of(&lane, SignIn::Credential(chatgpt)).await?, None);

            // A completed turn clears the limit of the sign-in it ran on, and
            // its reply names it.
            let (job, _) = sent(&lane, "reviewer").await?;
            lane.lease_one(runtime, job).await?;
            limit(&lane, SignIn::Credential(chatgpt), Some(60)).await?;
            lane.harness
                .complete(
                    runtime,
                    job,
                    json!({ "outcome": "succeeded", "summary": "Reviewed." }),
                )
                .await?;
            assert_eq!(limit_of(&lane, SignIn::Credential(chatgpt)).await?, None);
            let run = lane.job(job).await?.run_id.expect("run");
            let reply = lane
                .metadata_of(
                    "select metadata from conversation_messages
                      where run_id = $1 and role = 'assistant'
                        and metadata ->> 'outcome' = 'succeeded'",
                    run,
                )
                .await?;
            assert_eq!(reply["aiSignIn"], stamp(SignIn::Credential(chatgpt), false));
            // A turn on a backup names it as one, and leaves the first AI's
            // limit as it is.
            limit(&lane, SignIn::Credential(chatgpt), Some(60)).await?;
            let (job, sent_job) = sent(&lane, "reviewer").await?;
            assert_eq!(sent_job.credential_id, Some(chatgpt_2));
            lane.lease_one(runtime, job).await?;
            lane.harness
                .complete(
                    runtime,
                    job,
                    json!({ "outcome": "succeeded", "summary": "Reviewed." }),
                )
                .await?;
            let run = lane.job(job).await?.run_id.expect("run");
            let reply = lane
                .metadata_of(
                    "select metadata from conversation_messages
                      where run_id = $1 and role = 'assistant'
                        and metadata ->> 'outcome' = 'succeeded'",
                    run,
                )
                .await?;
            assert_eq!(
                reply["aiSignIn"],
                stamp(SignIn::Credential(chatgpt_2), true)
            );
            assert!(limit_of(&lane, SignIn::Credential(chatgpt))
                .await?
                .is_some());
            // A backup at its limit too, with no other AI with room: no next
            // AI is named.
            let (job, run) =
                failed_at_limit(json!((Utc::now() + Duration::hours(2)).timestamp())).await?;
            assert_eq!(job.credential_id, Some(chatgpt_2));
            assert!(limit_of(&lane, SignIn::Credential(chatgpt_2))
                .await?
                .is_some());
            let (_, failure) = lane.failure_message(run).await?;
            assert_eq!(
                failure["aiSignIn"],
                stamp(SignIn::Credential(chatgpt_2), true)
            );
            assert!(failure.get("aiSignInNext").is_none(), "{failure}");

            // A lane turn at its Claude plan's limit records the limit of the
            // login its lease took, and names the next login with room. The
            // owner's desktop is set up on both logins.
            lane.set_capabilities(
                lane.desktop,
                capabilities(Some(owner), lane_ready_on(&[first, work])),
            )
            .await?;
            let (_, lane_job) = lane.lane_turn().await?;
            let leased = lane.lease_one(lane.desktop, lane_job).await?;
            assert_eq!(leased["claude_code_login_id"], json!(first.to_string()));
            let reset = Utc::now() + Duration::hours(2);
            lane.harness
                .complete(
                    lane.desktop,
                    lane_job,
                    json!({
                        "outcome": "failed",
                        "error_message": "Claude Code reached its plan's limit.",
                        "artifacts": [{
                            "kind": "claude-code/failure",
                            "code": "plan_limit",
                            "resetsAt": reset.timestamp(),
                        }],
                    }),
                )
                .await?;
            assert_eq!(
                limit_of(&lane, SignIn::Login(first))
                    .await?
                    .map(|at| at.timestamp()),
                Some(reset.timestamp())
            );
            assert_eq!(limit_of(&lane, SignIn::Login(work)).await?, None);
            let run = lane.job(lane_job).await?.run_id.expect("run");
            let (_, failure) = lane.failure_message(run).await?;
            assert_lane_failure(&failure, "plan_limit", Some(first), "a plan's limit");
            assert_eq!(failure["aiSignIn"], stamp(SignIn::Login(first), false));
            assert_eq!(failure["aiSignInNext"], SignIn::Login(work).entry());
            // A usage-limit artifact on a lane turn, or a plan limit on a
            // Codex turn, is no report of either.
            let (_, other) = lane.lane_turn().await?;
            let leased = lane.lease_one(lane.desktop, other).await?;
            assert_eq!(leased["claude_code_login_id"], json!(work.to_string()));
            lane.harness
                .complete(
                    lane.desktop,
                    other,
                    json!({
                        "outcome": "failed",
                        "error_message": "Claude Code stopped.",
                        "artifacts": [{ "kind": "ai/usage-limit", "resetsAt": null }],
                    }),
                )
                .await?;
            assert_eq!(limit_of(&lane, SignIn::Login(work)).await?, None);
            // A completed lane turn clears its login's limit, and its reply
            // names the login, a backup.
            let (_, next) = lane.lane_turn().await?;
            let leased = lane.lease_one(lane.desktop, next).await?;
            assert_eq!(leased["claude_code_login_id"], json!(work.to_string()));
            limit(&lane, SignIn::Login(work), Some(60)).await?;
            lane.harness
                .complete(
                    lane.desktop,
                    next,
                    json!({ "outcome": "succeeded", "summary": "Fixed it." }),
                )
                .await?;
            assert_eq!(limit_of(&lane, SignIn::Login(work)).await?, None);
            assert!(limit_of(&lane, SignIn::Login(first)).await?.is_some());
            let run = lane.job(next).await?.run_id.expect("run");
            let reply = lane
                .metadata_of(
                    "select metadata from conversation_messages
                      where run_id = $1 and role = 'assistant'
                        and metadata ->> 'outcome' = 'succeeded'",
                    run,
                )
                .await?;
            assert_lane_stamps(&reply, Some(work), "the reply");
            assert_eq!(reply["aiSignIn"], stamp(SignIn::Login(work), true));
            Ok(())
        },
    )
    .await
}

/// A goal whose turn fails at a plan's limit goes on, on the agent's next AI
/// with room (docs/Local-Engine-Turns.md 11.20, D50): the completion records
/// the goal's next step as after a finished turn, which its wake-up sends to
/// the AI with room. With no AI with room, the goal is blocked as before.
#[tokio::test]
async fn a_goal_goes_on_on_the_next_ai_with_room_after_a_plans_limit() -> anyhow::Result<()> {
    with_lane(
        "backup-ais-goal",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let owner = space.owner;
            let chatgpt = lane.owner_credential;
            let chatgpt_2 = connection_of(&lane, owner, "ChatGPT 2").await?;
            let (status, made) = lane
                .harness
                .call(
                    "POST",
                    "/me/agents",
                    Some(&lane.owner()),
                    Some(json!({
                        "handle": "reviewer",
                        "credentialId": chatgpt,
                        "backupAis": [{ "credentialId": chatgpt_2 }],
                    })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{made}");
            let runtime = space.runtime;
            // A chat with an active goal, the owner's turn to @reviewer there,
            // bound to it, failed at its sign-in's usage limit.
            let goal_turn_at_limit = || {
                let lane = &lane;
                async move {
                    let chat = lane.chat().await?;
                    sql(
                        lane.pool(),
                        "update conversations set metadata = $2 where id = $1",
                        &[
                            &chat,
                            &PgJson(json!({ "instafyGoal": {
                                "id": Uuid::new_v4().to_string(),
                                "objective": "Ship the reviewed change",
                                "status": "active",
                            } })),
                        ],
                    )
                    .await?;
                    let job = lane.admitted(chat, &send_to("reviewer", runtime)).await?;
                    let sent_job = lane.job(job).await?;
                    anyhow::ensure!(
                        sent_job
                            .payload
                            .pointer("/metadata/_controllerGoal/revision")
                            .is_some(),
                        "the turn is not bound to the goal: {}",
                        sent_job.payload
                    );
                    lane.lease_one(runtime, job).await?;
                    lane.harness
                        .complete(
                            runtime,
                            job,
                            json!({
                                "outcome": "failed",
                                "error_message": "You've hit your usage limit.",
                                "artifacts": [{
                                    "kind": "ai/usage-limit",
                                    "resetsAt": (Utc::now() + Duration::hours(3)).timestamp(),
                                }],
                            }),
                        )
                        .await?;
                    anyhow::Ok((chat, job, sent_job.credential_id))
                }
            };
            let goal_status = |chat: Uuid| {
                let lane = &lane;
                async move {
                    let metadata = lane
                        .metadata_of("select metadata from conversations where id = $1", chat)
                        .await?;
                    anyhow::Ok(metadata["instafyGoal"]["status"].clone())
                }
            };

            // Another AI has room: the goal's next step, on it.
            let (chat, job, ran_on) = goal_turn_at_limit().await?;
            assert_eq!(ran_on, Some(chatgpt));
            assert_eq!(goal_status(chat).await?, json!("active"));
            let next_run: Uuid = eventually("the goal's next step to be sent", || async {
                let row = lane
                    .pool()
                    .get()
                    .await?
                    .query_opt(
                        "select run_id from conversation_goal_continuations
                          where source_job_id = $1 and status = 'dispatched'",
                        &[&job],
                    )
                    .await?;
                anyhow::Ok(row.and_then(|row| row.get::<_, Option<Uuid>>(0)))
            })
            .await?;
            let next: Option<Uuid> = sql_one(
                lane.pool(),
                "select credential_id from agent_jobs where run_id = $1",
                &[&next_run],
            )
            .await?;
            assert_eq!(
                next,
                Some(chatgpt_2),
                "the next step runs on the AI with room"
            );
            assert_eq!(goal_status(chat).await?, json!("active"));
            lane.end_jobs().await?;

            // No AI with room: blocked, as before.
            limit(&lane, SignIn::Credential(chatgpt_2), Some(240)).await?;
            let (chat, job, ran_on) = goal_turn_at_limit().await?;
            assert_eq!(ran_on, Some(chatgpt), "the earliest reset");
            assert_eq!(goal_status(chat).await?, json!("blocked"));
            let continuations: i64 = sql_one(
                lane.pool(),
                "select count(*) from conversation_goal_continuations where source_job_id = $1",
                &[&job],
            )
            .await?;
            assert_eq!(continuations, 0);
            Ok(())
        },
    )
    .await
}

/// Sign in again: a ChatGPT sign-in that takes another's place
/// (`credentials::insert_user_credential`, #1219) moves every backup entry
/// that names the old connection to the new one, where it stood, with the
/// agents' pins, in the transaction that saves it.
#[tokio::test]
async fn sign_in_again_moves_the_backups_on_the_replaced_sign_in() -> anyhow::Result<()> {
    with_lane(
        "backup-ais-sign-in-again",
        |config, _| {
            config.credential_keys =
                Some(crate::config::CredentialEncryptionKey::for_test("backup ais").into());
        },
        |lane| async move {
            let space = lane.space();
            let owner = space.owner;
            let account = format!("account-{}", Uuid::new_v4());
            let device_metadata = json!({
                "provider": "openai",
                "source": "device_login",
                "account_id": account,
            });
            let auth_json = json!({
                "OPENAI_API_KEY": null,
                "tokens": { "account_id": account, "access_token": "access", "refresh_token": "refresh" },
            });
            let signed_in = |replaces: Option<Uuid>| {
                let lane = &lane;
                let metadata = device_metadata.clone();
                let auth_json = auth_json.clone();
                async move {
                    crate::credentials::insert_user_credential(
                        &lane.harness.state,
                        owner,
                        "codex_auth_json".to_string(),
                        metadata,
                        auth_json,
                        crate::credentials::NewCredentialLabel::ChatGptSignIn { replaces },
                        Some(false),
                    )
                    .await
                    .map_err(|(status, error)| anyhow::anyhow!("sign in: {status} {}", error.message))
                }
            };
            let old = signed_in(None).await?.credential_id;
            let other = connection_of(&lane, owner, "Other").await?;
            let first = first_login_of(owner);
            let agent_on = |credential: Uuid, handle: &'static str, backups: Vec<SignIn>| {
                let lane = &lane;
                async move {
                    let id = Uuid::new_v4();
                    sql(
                        lane.pool(),
                        "insert into user_agents (
                             id, user_id, credential_id, provider, handle, display_name,
                             avatar_seed, backup_ais
                         ) values ($1, $2, $3, 'openai', $4, $4, 'hatchling:5', $5)",
                        &[&id, &owner, &credential, &handle, &PgJson(entries(&backups))],
                    )
                    .await?;
                    anyhow::Ok(id)
                }
            };
            let reviewer = agent_on(
                other,
                "reviewer",
                vec![SignIn::Login(first), SignIn::Credential(old)],
            )
            .await?;
            let drafter = agent_on(old, "drafter", vec![SignIn::Credential(other)]).await?;

            let created = signed_in(Some(old)).await?;
            let new = created.credential_id;
            assert_ne!(new, old);
            assert!(
                matches!(
                    created.replacement,
                    Some(crate::device_auth::SignInReplacement::Replaced { id, .. }) if id == old
                ),
                "{:?}",
                created.replacement
            );
            assert_eq!(
                stored(&lane, reviewer).await?,
                entries(&[SignIn::Login(first), SignIn::Credential(new)])
            );
            // The agent pinned to it moves with its own backups as they were.
            assert_eq!(lane.ai_of(drafter).await?.1, Some(new));
            assert_eq!(stored(&lane, drafter).await?, entries(&[SignIn::Credential(other)]));
            // And a revoke, which moves an agent to the default, clears its
            // backups, since the default has none.
            let retired = crate::credentials::retire_user_credential(
                &*lane.pool().get().await?,
                &owner,
                &new,
            )
            .await
            .map_err(|(status, error)| anyhow::anyhow!("revoke: {status} {}", error.message))?;
            assert!(retired);
            assert_eq!(lane.ai_of(drafter).await?.1, None);
            assert_eq!(stored(&lane, drafter).await?, json!([]));
            assert_eq!(listed(&lane, reviewer).await?["backupAis"], entries(&[SignIn::Login(first)]));
            Ok(())
        },
    )
    .await
}

/// Only the controller names the sign-in a turn runs on and the agent's next
/// one (docs/Local-Engine-Turns.md 11.20): a client's `aiSignIn` and
/// `aiSignInNext`, in a send or a recorded message, in either spelling and in
/// a nested copy, never survive intake, and a run and its job keep the one
/// dispatch chose.
#[tokio::test]
async fn a_clients_sign_in_stamps_never_survive_intake() -> anyhow::Result<()> {
    with_lane(
        "backup-ais-intake",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let forged = json!({ "credentialId": Uuid::new_v4().to_string(), "backup": true });
            let claims = json!({
                "aiSignIn": forged,
                "ai_sign_in": forged,
                "aiSignInNext": { "claudeCodeLoginId": Uuid::new_v4().to_string() },
                "ai_sign_in_next": {},
                "prompt_metadata": { "aiSignIn": forged },
            });
            let chat = lane.chat().await?;
            let job = lane
                .admitted(
                    chat,
                    &json!({
                        "promptText": WORDS,
                        "intent": "feature",
                        "runtimeId": space.runtime.to_string(),
                        "metadata": metadata_for(&["helper"], claims.clone()),
                    }),
                )
                .await?;
            let job = lane.job(job).await?;
            assert_eq!(job.credential_id, Some(lane.owner_credential));
            let run = job.run_id.expect("run");
            assert_eq!(
                run_sign_in(&lane, &job).await?,
                stamp(SignIn::Credential(lane.owner_credential), false)
            );
            let message = lane
                .metadata_of(
                    "select metadata from conversation_messages where run_id = $1 and role = 'user'",
                    run,
                )
                .await?;
            assert_never_holds(
                &message,
                &["aiSignIn", "ai_sign_in", "aiSignInNext", "ai_sign_in_next"],
                "the person's message",
            );
            // The job keeps the run's own stamp, which its secrets read, and
            // no copy of the client's.
            assert_eq!(
                job.payload["metadata"]["aiSignIn"],
                stamp(SignIn::Credential(lane.owner_credential), false)
            );
            let mut payload = job.payload.clone();
            if let Some(metadata) = payload["metadata"].as_object_mut() {
                metadata.remove("aiSignIn");
            }
            assert_never_holds(
                &payload,
                &["aiSignIn", "ai_sign_in", "aiSignInNext", "ai_sign_in_next"],
                "the job",
            );
            for token in [lane.token(space.member), SERVICE_ROLE.to_string()] {
                let (status, recorded) = lane
                    .harness
                    .call(
                        "POST",
                        format!("/conversations/{chat}/messages/record"),
                        Some(&token),
                        Some(json!({
                            "role": "assistant",
                            "content": "Ran on your ChatGPT.",
                            "metadata": claims.clone(),
                        })),
                    )
                    .await?;
                assert_eq!(status, StatusCode::OK, "{recorded}");
                let id = Uuid::parse_str(recorded["id"].as_str().unwrap_or_default())?;
                let metadata: JsonValue = sql_one(
                    lane.pool(),
                    "select metadata from conversation_messages where id = $1",
                    &[&id],
                )
                .await?;
                assert_never_holds(
                    &metadata,
                    &["aiSignIn", "ai_sign_in", "aiSignInNext", "ai_sign_in_next"],
                    "a recorded message",
                );
            }
            Ok(())
        },
    )
    .await
}

/// A turn dispatch moves to a backup of another provider runs that backup's
/// own provider and its default model (docs/Local-Engine-Turns.md 11.20), as
/// an agent pinned to it with no model of its own would: the agent's model and
/// reasoning effort belong to its first AI's provider, and go with a job on
/// its first AI, or on a backup of the same provider, only. The job's payload
/// names the sign-in it runs on, which its secrets read.
#[tokio::test]
async fn a_turn_on_a_backup_of_another_provider_runs_that_backups_default_model(
) -> anyhow::Result<()> {
    with_lane(
        "backup-ais-secrets",
        |config, _| {
            config.credential_keys =
                Some(crate::config::CredentialEncryptionKey::for_test("backup ais secrets").into());
        },
        |lane| async move {
            let space = lane.space();
            let owner = space.owner;
            let connection = |kind: &'static str, label: &'static str, metadata: JsonValue| {
                let lane = &lane;
                async move {
                    let id = Uuid::new_v4();
                    sql(
                        lane.pool(),
                        "insert into user_credentials (
                             id, user_id, kind, label, nonce_b64, ciphertext_b64, metadata,
                             is_default
                         ) values ($1, $2, $3, $4, 'test-nonce', 'test-ciphertext', $5, false)",
                        &[&id, &owner, &kind, &label, &PgJson(metadata)],
                    )
                    .await?;
                    anyhow::Ok(id)
                }
            };
            // Two ChatGPT sign-ins and a DeepSeek key.
            let chatgpt = connection("codex_auth_json", "ChatGPT", json!({})).await?;
            let chatgpt_2 = connection("codex_auth_json", "ChatGPT 2", json!({})).await?;
            let deepseek_metadata = json!({ "provider": "deepseek" });
            let deepseek =
                connection("openai_api_key", "DeepSeek", deepseek_metadata.clone()).await?;
            assert_eq!(
                crate::credentials::provider_for_credential("openai_api_key", &deepseek_metadata),
                "deepseek"
            );
            // @coder on the first ChatGPT sign-in, with a model and an effort
            // of its own.
            let model = crate::model_defaults::DEFAULT_OPENAI_MODEL_ID;
            let (status, made) = lane
                .harness
                .call(
                    "POST",
                    "/me/agents",
                    Some(&lane.owner()),
                    Some(json!({
                        "handle": "coder",
                        "credentialId": chatgpt,
                        "model": model,
                        "reasoningEffort": "high",
                        "backupAis": [{ "credentialId": chatgpt_2 }, { "credentialId": deepseek }],
                    })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{made}");
            assert_eq!(made["provider"], json!("openai"), "{made}");
            let agents_model = crate::model_defaults::resolve_agent_model_for_provider(
                "openai",
                Some(model.into()),
            );
            let runtime = space.runtime;
            // The owner's turn to @coder, leased: its job, and its secrets.
            let leased_turn = || {
                let lane = &lane;
                async move {
                    let (job, sent_job) = sent(lane, "coder").await?;
                    lane.lease_one(runtime, job).await?;
                    let (status, secrets) = lane
                        .agent_call(runtime, "/agent/secrets", json!({ "jobId": job }))
                        .await?;
                    anyhow::ensure!(status == StatusCode::OK, "secrets: {status} {secrets}");
                    lane.end_job(job).await?;
                    anyhow::Ok((sent_job, secrets["env"].clone()))
                }
            };

            // On its first AI: its own model and effort.
            let (job, env) = leased_turn().await?;
            assert_eq!(job.credential_id, Some(chatgpt));
            assert_eq!(
                job.payload["metadata"]["aiSignIn"],
                stamp(SignIn::Credential(chatgpt), false)
            );
            assert_eq!(
                env["CODEX_MODEL"].as_str(),
                agents_model.as_deref(),
                "{env}"
            );
            assert_eq!(env["CODEX_AGENT_REASONING_EFFORT"], json!("high"), "{env}");

            // On a backup of the same provider: still its own.
            limit(&lane, SignIn::Credential(chatgpt), Some(60)).await?;
            let (job, env) = leased_turn().await?;
            assert_eq!(job.credential_id, Some(chatgpt_2));
            assert_eq!(
                job.payload["metadata"]["aiSignIn"],
                stamp(SignIn::Credential(chatgpt_2), true)
            );
            assert_eq!(
                env["CODEX_MODEL"].as_str(),
                agents_model.as_deref(),
                "{env}"
            );
            assert_eq!(env["CODEX_AGENT_REASONING_EFFORT"], json!("high"), "{env}");

            // On the DeepSeek key: DeepSeek's default model, and none of the
            // agent's model or effort.
            limit(&lane, SignIn::Credential(chatgpt_2), Some(60)).await?;
            let (job, env) = leased_turn().await?;
            assert_eq!(job.credential_id, Some(deepseek));
            assert_eq!(
                job.payload["metadata"]["aiSignIn"],
                stamp(SignIn::Credential(deepseek), true)
            );
            assert_eq!(
                env["CODEX_MODEL"],
                json!(crate::credentials::credential_default_model(
                    "openai_api_key",
                    &deepseek_metadata
                )),
                "{env}"
            );
            assert_eq!(
                env["CODEX_MODEL"],
                json!(crate::model_defaults::DEFAULT_DEEPSEEK_MODEL_ID),
                "{env}"
            );
            assert!(env.get("CODEX_AGENT_REASONING_EFFORT").is_none(), "{env}");
            Ok(())
        },
    )
    .await
}

/// A new chat of the owner's with an active goal.
async fn goal_chat(lane: &Lane) -> anyhow::Result<Uuid> {
    let chat = lane.chat().await?;
    sql(
        lane.pool(),
        "update conversations set metadata = $2 where id = $1",
        &[
            &chat,
            &PgJson(json!({ "instafyGoal": {
                "id": Uuid::new_v4().to_string(),
                "objective": "Ship the reviewed change",
                "status": "active",
            } })),
        ],
    )
    .await?;
    Ok(chat)
}

/// The job of the goal's next step after `source`, once its wake-up sent it.
async fn goals_next_step(lane: &Lane, source: Uuid) -> anyhow::Result<Uuid> {
    let run: Uuid = eventually("the goal's next step to be sent", || async {
        let row = lane
            .pool()
            .get()
            .await?
            .query_opt(
                "select run_id from conversation_goal_continuations
                  where source_job_id = $1 and status = 'dispatched'",
                &[&source],
            )
            .await?;
        anyhow::Ok(row.and_then(|row| row.get::<_, Option<Uuid>>(0)))
    })
    .await?;
    sql_one(
        lane.pool(),
        "select id from agent_jobs where run_id = $1",
        &[&run],
    )
    .await
}

/// A goal on a Claude Code agent goes on after its turn as after any turn
/// (docs/Local-Engine-Turns.md 11.4, 11.20): the lane job carries the binding
/// to the goal that dispatch wrote, so its completion records the goal's next
/// step, and the wake-up's job, a lane job again, carries the binding and its
/// turn number, which the goal counts its turns by.
#[tokio::test]
async fn a_goal_on_a_claude_code_agent_goes_on_after_its_lane_turn() -> anyhow::Result<()> {
    with_lane(
        "lane-goal",
        |_, _| {},
        |lane| async move {
            let chat = goal_chat(&lane).await?;
            let job = lane
                .admitted(chat, &lane_send(lane_metadata(json!({}))))
                .await?;
            let sent = lane.job(job).await?;
            assert_eq!(sent.engine.as_deref(), Some(claude_code_lane::ENGINE));
            let binding = sent.payload["metadata"]["_controllerGoal"].clone();
            assert!(binding["revision"].is_string(), "{}", sent.payload);
            assert_eq!(binding["userTurn"], json!(true));
            assert!(
                sent.payload["metadata"].get("goalContinuation").is_none(),
                "{}",
                sent.payload
            );
            lane.lease_one(lane.desktop, job).await?;
            lane.harness
                .complete(
                    lane.desktop,
                    job,
                    json!({ "outcome": "succeeded", "summary": "Fixed the build." }),
                )
                .await?;
            let next = lane.job(goals_next_step(&lane, job).await?).await?;
            assert_eq!(next.engine.as_deref(), Some(claude_code_lane::ENGINE));
            assert_eq!(
                next.payload["metadata"]["_controllerGoal"]["revision"],
                binding["revision"]
            );
            assert_eq!(
                next.payload["metadata"]["goalContinuation"]["turn"],
                json!(1),
                "{}",
                next.payload
            );
            let goal = lane
                .metadata_of("select metadata from conversations where id = $1", chat)
                .await?;
            assert_eq!(goal["instafyGoal"]["status"], json!("active"));
            // Each lane job keeps the goal's id, which the goal counts its
            // turns by across revisions, as for a Codex step: a new human
            // turn's revision does not restart the count.
            let goal_id = goal["instafyGoal"]["id"].clone();
            assert_eq!(sent.payload["metadata"]["goal"], json!({ "id": goal_id }));
            assert_eq!(next.payload["metadata"]["goal"], json!({ "id": goal_id }));
            assert_eq!(
                goal_turns(&lane, chat, &goal_id, &Uuid::new_v4().to_string()).await?,
                1
            );
            Ok(())
        },
    )
    .await
}

/// The goal's turn count, as its wake-up reads it
/// (`conversation_goals::prepare_request`), for the goal `goal_id` and the
/// binding `revision`.
async fn goal_turns(
    lane: &Lane,
    chat: Uuid,
    goal_id: &JsonValue,
    revision: &str,
) -> anyhow::Result<i64> {
    sql_one(
        lane.pool(),
        "select coalesce(max(case when jsonb_typeof(j.payload#>'{metadata,goalContinuation,turn}')='number'
                                 then greatest(0,least(100,(j.payload#>>'{metadata,goalContinuation,turn}')::numeric))::bigint
                                 else 0 end),0)::bigint
           from agent_jobs j
          where j.conversation_id = $1
            and (j.payload#>>'{metadata,goal,id}' = $2 or j.payload#>>'{metadata,_controllerGoal,revision}' = $3)",
        &[&chat, &goal_id.as_str().unwrap_or_default(), &revision],
    )
    .await
}

/// The status of the goal of `chat`, once its wake-up is done with `source`'s
/// next step: `dispatched`, `blocked` or `canceled`.
async fn goal_after_step(
    lane: &Lane,
    chat: Uuid,
    source: Uuid,
) -> anyhow::Result<(String, JsonValue)> {
    let step: String = eventually("the goal's next step to be settled", || async {
        let row = lane
            .pool()
            .get()
            .await?
            .query_opt(
                "select status from conversation_goal_continuations
                  where source_job_id = $1 and status in ('dispatched', 'blocked', 'canceled')",
                &[&source],
            )
            .await?;
        anyhow::Ok(row.map(|row| row.get::<_, String>(0)))
    })
    .await?;
    let metadata = lane
        .metadata_of("select metadata from conversations where id = $1", chat)
        .await?;
    Ok((step, metadata["instafyGoal"]["status"].clone()))
}

/// The owner's @reviewer on their ChatGPT connection, with `backups`.
async fn reviewer_with(lane: &Lane, backups: JsonValue) -> anyhow::Result<()> {
    let (status, made) = lane
        .harness
        .call(
            "POST",
            "/me/agents",
            Some(&lane.owner()),
            Some(json!({
                "handle": "reviewer",
                "credentialId": lane.owner_credential,
                "backupAis": backups,
            })),
        )
        .await?;
    anyhow::ensure!(status == StatusCode::OK, "reviewer: {status} {made}");
    Ok(())
}

/// The owner's goal turn to @reviewer, on its ChatGPT connection, failed at
/// its usage limit: its job.
async fn goal_turn_failed_at_its_limit(lane: &Lane, chat: Uuid) -> anyhow::Result<Uuid> {
    let runtime = lane.space().runtime;
    let job = lane.admitted(chat, &send_to("reviewer", runtime)).await?;
    anyhow::ensure!(
        lane.job(job).await?.credential_id == Some(lane.owner_credential),
        "the goal's turn is on the first AI"
    );
    lane.lease_one(runtime, job).await?;
    lane.harness
        .complete(
            runtime,
            job,
            json!({
                "outcome": "failed",
                "error_message": "You've hit your usage limit.",
                "artifacts": [{
                    "kind": "ai/usage-limit",
                    "resetsAt": (Utc::now() + Duration::hours(3)).timestamp(),
                }],
            }),
        )
        .await?;
    Ok(job)
}

/// A goal's next step after a turn that did not run on Claude Code never runs
/// there (docs/Local-Engine-Turns.md 11.5, 11.20): its prompt carries that
/// turn's reply and the goal's checkpoint, an agent's job's words. A Codex
/// turn at its usage limit whose agent's only backup with room is a login
/// blocks the goal rather than run the step there; with a connection after
/// the login, the step runs on the connection.
#[tokio::test]
async fn a_goals_codex_turn_at_its_limit_never_goes_on_on_claude_code() -> anyhow::Result<()> {
    with_lane(
        "backup-ais-goal-login",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let owner = space.owner;
            let first = first_login_of(owner);
            reviewer_with(&lane, json!([{ "claudeCodeLoginId": first }])).await?;
            let chat = goal_chat(&lane).await?;
            let job = goal_turn_failed_at_its_limit(&lane, chat).await?;
            let (step, goal) = goal_after_step(&lane, chat, job).await?;
            assert_eq!((step.as_str(), goal), ("blocked", json!("blocked")));
            let lane_jobs: i64 = sql_one(
                lane.pool(),
                "select count(*) from agent_jobs where conversation_id = $1 and engine is not null",
                &[&chat],
            )
            .await?;
            assert_eq!(lane_jobs, 0, "no step ran on Claude Code");

            // A connection after the login takes the step.
            limit(&lane, SignIn::Credential(lane.owner_credential), None).await?;
            let chatgpt_2 = connection_of(&lane, owner, "ChatGPT 2").await?;
            let reviewer = lane.agent_of(owner, "reviewer").await?;
            let (status, body) = save(
                &lane,
                reviewer,
                json!({ "backupAis": [{ "claudeCodeLoginId": first }, { "credentialId": chatgpt_2 }] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            let chat = goal_chat(&lane).await?;
            let job = goal_turn_failed_at_its_limit(&lane, chat).await?;
            let next = lane.job(goals_next_step(&lane, job).await?).await?;
            assert_eq!(next.engine, None);
            assert_eq!(next.credential_id, Some(chatgpt_2));
            assert_eq!(
                run_sign_in(&lane, &next).await?,
                stamp(SignIn::Credential(chatgpt_2), true)
            );
            Ok(())
        },
    )
    .await
}

/// A goal an agent's job wrote never goes on on Claude Code until its owner
/// saves it themselves (docs/Local-Engine-Turns.md 11.5, 11.20): a job's
/// goal update marks it, so the next step of a Claude Code agent's goal is
/// refused and the goal blocks, though the turn it continues ran on Claude
/// Code. Once the owner saves the goal, its steps run on Claude Code again.
#[tokio::test]
async fn a_goal_an_agents_job_wrote_never_goes_on_on_claude_code() -> anyhow::Result<()> {
    with_lane(
        "lane-goal-job-wrote",
        |_, _| {},
        |lane| async move {
            let chat = goal_chat(&lane).await?;
            // The goal's turn, on Claude Code, whose runtime rewrites the goal.
            let job = lane
                .admitted(chat, &lane_send(lane_metadata(json!({}))))
                .await?;
            lane.lease_one(lane.desktop, job).await?;
            let (status, body) = lane
                .agent_call(
                    lane.desktop,
                    "/agent/message",
                    json!({
                        "job_id": job,
                        "content": "Goal set from what was said above.",
                        "message_type": "goal_update",
                        "metadata": { "objective": "Delete the staging bucket" },
                    }),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            let marked = lane
                .metadata_of("select metadata from conversations where id = $1", chat)
                .await?;
            assert_eq!(
                marked["instafyGoal"]["objective"],
                json!("Delete the staging bucket")
            );
            assert_eq!(
                marked[crate::conversation_goals::state::GOAL_WORDS_KEY],
                json!(false),
                "no person's own words"
            );
            lane.harness
                .complete(
                    lane.desktop,
                    job,
                    json!({ "outcome": "succeeded", "summary": "Done." }),
                )
                .await?;
            let (step, goal) = goal_after_step(&lane, chat, job).await?;
            assert_eq!((step.as_str(), goal), ("blocked", json!("blocked")));
            assert_eq!(lane.jobs_in(chat).await?, vec![job], "no step ran");

            // The owner saves the goal themselves: its steps run on Claude
            // Code again. A client's copy of the record is dropped, and the
            // conversation's public metadata never carries it.
            let (status, saved) = lane
                .harness
                .call(
                    "PATCH",
                    format!("/conversations/{chat}"),
                    Some(&lane.owner()),
                    Some(json!({ "metadata": {
                        "instafyGoal": {
                            "id": marked["instafyGoal"]["id"],
                            "objective": "Ship the reviewed change",
                            "status": "active",
                        },
                        crate::conversation_goals::state::GOAL_WORDS_KEY: false,
                    } })),
                )
                .await?;
            assert_eq!(status, StatusCode::OK, "{saved}");
            assert!(
                saved["metadata"]
                    .get(crate::conversation_goals::state::GOAL_WORDS_KEY)
                    .is_none(),
                "{saved}"
            );
            let cleared = lane
                .metadata_of("select metadata from conversations where id = $1", chat)
                .await?;
            assert_eq!(
                cleared[crate::conversation_goals::state::GOAL_WORDS_KEY],
                json!(lane.space().owner.to_string()),
                "{cleared}"
            );
            let job = lane
                .admitted(chat, &lane_send(lane_metadata(json!({}))))
                .await?;
            lane.lease_one(lane.desktop, job).await?;
            lane.harness
                .complete(
                    lane.desktop,
                    job,
                    json!({ "outcome": "succeeded", "summary": "Shipped half." }),
                )
                .await?;
            let next = lane.job(goals_next_step(&lane, job).await?).await?;
            assert_eq!(next.engine.as_deref(), Some(claude_code_lane::ENGINE));
            Ok(())
        },
    )
    .await
}

/// A goal's next step on Claude Code quotes only its owner's own Claude Code
/// turns (docs/Local-Engine-Turns.md 11.5, 11.20): while the runs its prompt
/// would quote hold a Codex turn's reply, the step keeps off Claude Code, and
/// with no other AI of the agent's with room the goal blocks, though the turn
/// it continues ran on Claude Code.
#[tokio::test]
async fn a_goal_step_that_would_quote_a_codex_reply_never_runs_on_claude_code() -> anyhow::Result<()>
{
    with_lane(
        "backup-ais-goal-quotes",
        |_, _| {},
        |lane| async move {
            let runtime = lane.space().runtime;
            let chat = goal_chat(&lane).await?;
            // The owner's goal turn to @helper, on their ChatGPT connection.
            let codex = lane.admitted(chat, &send_to("helper", runtime)).await?;
            lane.lease_one(runtime, codex).await?;
            lane.harness
                .complete(
                    runtime,
                    codex,
                    json!({ "outcome": "succeeded", "summary": "The build fails in packages/app." }),
                )
                .await?;
            // Its next step, on @helper again, ends without a word.
            let step = goals_next_step(&lane, codex).await?;
            assert_eq!(lane.job(step).await?.engine, None);
            lane.end_job(step).await?;
            // Then the owner's turn to @claude, on Claude Code: its next step
            // would quote both Codex runs.
            let job = lane
                .admitted(chat, &lane_send(lane_metadata(json!({}))))
                .await?;
            lane.lease_one(lane.desktop, job).await?;
            lane.harness
                .complete(
                    lane.desktop,
                    job,
                    json!({ "outcome": "succeeded", "summary": "Fixed the build." }),
                )
                .await?;
            let (step, goal) = goal_after_step(&lane, chat, job).await?;
            assert_eq!((step.as_str(), goal), ("blocked", json!("blocked")));
            let lane_jobs: i64 = sql_one(
                lane.pool(),
                "select count(*) from agent_jobs where conversation_id = $1 and engine is not null",
                &[&chat],
            )
            .await?;
            assert_eq!(lane_jobs, 1, "no step ran on Claude Code");
            Ok(())
        },
    )
    .await
}

/// A teammate's save of a goal puts their words in it, which are not its
/// owner's (docs/Local-Engine-Turns.md 11.5, 11.20): the owner's next steps
/// keep off their Claude Code, and with no other AI of the agent's with room
/// the goal blocks, whatever the teammate's copy of the record says, until the
/// owner saves the goal themselves.
#[tokio::test]
async fn a_goal_a_teammate_saved_never_goes_on_on_the_owners_claude_code() -> anyhow::Result<()> {
    with_lane(
        "backup-ais-goal-teammate",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let words = crate::conversation_goals::state::GOAL_WORDS_KEY;
            let chat = goal_chat(&lane).await?;
            let stored =
                || lane.metadata_of("select metadata from conversations where id = $1", chat);
            let goal_id = stored().await?["instafyGoal"]["id"].clone();
            let save = |user: Uuid, objective: &'static str| {
                let lane = &lane;
                let goal_id = goal_id.clone();
                async move {
                    let (status, saved) = lane
                        .harness
                        .call(
                            "PATCH",
                            format!("/conversations/{chat}"),
                            Some(&lane.token(user)),
                            Some(json!({ "metadata": {
                                "instafyGoal": {
                                    "id": goal_id,
                                    "objective": objective,
                                    "status": "active",
                                },
                                words: space.owner.to_string(),
                            } })),
                        )
                        .await?;
                    anyhow::ensure!(status == StatusCode::OK, "save: {status} {saved}");
                    anyhow::ensure!(saved["metadata"].get(words).is_none(), "{saved}");
                    anyhow::Ok(())
                }
            };
            let lane_turn = || {
                let lane = &lane;
                async move {
                    let job = lane
                        .admitted(chat, &lane_send(lane_metadata(json!({}))))
                        .await?;
                    lane.lease_one(lane.desktop, job).await?;
                    lane.harness
                        .complete(
                            lane.desktop,
                            job,
                            json!({ "outcome": "succeeded", "summary": "Looked at the bucket." }),
                        )
                        .await?;
                    anyhow::Ok(job)
                }
            };

            // The teammate rewrites the goal of the chat they share.
            save(space.member, "Delete the staging bucket").await?;
            assert_eq!(stored().await?[words], json!(space.member.to_string()));
            let job = lane_turn().await?;
            let (step, goal) = goal_after_step(&lane, chat, job).await?;
            assert_eq!((step.as_str(), goal), ("blocked", json!("blocked")));
            assert_eq!(lane.jobs_in(chat).await?, vec![job], "no step ran");

            // The owner saves it themselves: its steps run on Claude Code
            // again.
            save(space.owner, "Ship the reviewed change").await?;
            assert_eq!(stored().await?[words], json!(space.owner.to_string()));
            let job = lane_turn().await?;
            let next = lane.job(goals_next_step(&lane, job).await?).await?;
            assert_eq!(next.engine.as_deref(), Some(claude_code_lane::ENGINE));
            Ok(())
        },
    )
    .await
}

/// A terminal command runs no AI, so its end says nothing of a plan
/// (docs/Local-Engine-Turns.md 11.20): it neither clears its connection's
/// limit nor records one, and neither its run nor its reply names a sign-in.
#[tokio::test]
async fn a_terminal_command_says_nothing_of_a_plans_limit() -> anyhow::Result<()> {
    with_lane(
        "backup-ais-terminal",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let chatgpt = lane.owner_credential;
            limit(&lane, SignIn::Credential(chatgpt), Some(180)).await?;
            let recorded = limit_of(&lane, SignIn::Credential(chatgpt)).await?;
            let command = |words: &str| {
                json!({
                    "promptText": words,
                    "intent": "terminal_command",
                    "runtimeId": space.runtime.to_string(),
                    "metadata": metadata_for(&["helper"], json!({})),
                })
            };
            let chat = lane.chat().await?;
            let job = lane.admitted(chat, &command("ls")).await?;
            let sent = lane.job(job).await?;
            assert_eq!(sent.credential_id, Some(chatgpt));
            assert_eq!(run_sign_in(&lane, &sent).await?, JsonValue::Null);
            lane.lease_one(space.runtime, job).await?;
            lane.harness
                .complete(
                    space.runtime,
                    job,
                    json!({ "outcome": "succeeded", "summary": "total 0" }),
                )
                .await?;
            assert_eq!(
                limit_of(&lane, SignIn::Credential(chatgpt)).await?,
                recorded
            );
            let named = ["aiSignIn", "ai_sign_in", "aiSignInNext", "ai_sign_in_next"];
            assert_never_holds(&sent.payload, &named, "the job");
            assert_never_holds(&messages_of(&lane, chat).await?, &named, "the chat");
            // Nor does a failed one record a limit.
            limit(&lane, SignIn::Credential(chatgpt), None).await?;
            let chat = lane.chat().await?;
            let job = lane.admitted(chat, &command("ls")).await?;
            lane.lease_one(space.runtime, job).await?;
            lane.harness
                .complete(
                    space.runtime,
                    job,
                    json!({
                        "outcome": "failed",
                        "error_message": "ls: not found",
                        "artifacts": [{ "kind": "ai/usage-limit", "resetsAt": null }],
                    }),
                )
                .await?;
            assert_eq!(limit_of(&lane, SignIn::Credential(chatgpt)).await?, None);
            assert_never_holds(&messages_of(&lane, chat).await?, &named, "the chat");
            Ok(())
        },
    )
    .await
}

/// The metadata of every message of `chat`, oldest first.
async fn messages_of(lane: &Lane, chat: Uuid) -> anyhow::Result<JsonValue> {
    sql_one(
        lane.pool(),
        "select coalesce(jsonb_agg(metadata order by created_at), '[]'::jsonb)
           from conversation_messages where conversation_id = $1",
        &[&chat],
    )
    .await
}

/// The latest word on a limit stands (docs/Local-Engine-Turns.md 11.20): a
/// turn leased before a limit was recorded, which completes after, leaves the
/// limit standing, while one leased after it clears it; and a later report of
/// a shorter limit never cuts a longer one short, while a longer one extends
/// it.
#[tokio::test]
async fn the_latest_word_on_a_limit_stands() -> anyhow::Result<()> {
    with_lane(
        "backup-ais-limit-order",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let owner = space.owner;
            let runtime = space.runtime;
            let chatgpt = lane.owner_credential;
            let chatgpt_2 = connection_of(&lane, owner, "ChatGPT 2").await?;
            reviewer_with(&lane, json!([{ "credentialId": chatgpt_2 }])).await?;
            // The owner's turn to @reviewer, sent now, and leased now when
            // `lease` says so: its job.
            let turn = |lease: bool| {
                let lane = &lane;
                async move {
                    let (job, sent) = sent(lane, "reviewer").await?;
                    anyhow::ensure!(sent.credential_id == Some(chatgpt), "on ChatGPT");
                    if lease {
                        let leased = lane.harness.lease(runtime).await?;
                        anyhow::ensure!(leased["id"] == json!(job), "leased {leased}");
                    }
                    anyhow::Ok(job)
                }
            };
            let at_limit = |job: Uuid, at: DateTime<Utc>| {
                let lane = &lane;
                async move {
                    lane.harness
                        .complete(
                            runtime,
                            job,
                            json!({
                                "outcome": "failed",
                                "error_message": "You've hit your usage limit.",
                                "artifacts": [{ "kind": "ai/usage-limit", "resetsAt": at.timestamp() }],
                            }),
                        )
                        .await
                }
            };
            let succeeded = |job: Uuid| {
                let lane = &lane;
                async move {
                    lane.harness
                        .complete(
                            runtime,
                            job,
                            json!({ "outcome": "succeeded", "summary": "Reviewed." }),
                        )
                        .await
                }
            };
            let seconds = |at: Option<DateTime<Utc>>| at.map(|at| at.timestamp());

            // B leased before A reached the limit; C sent before but leased
            // after.
            let b = turn(true).await?;
            let a = turn(true).await?;
            let c = turn(false).await?;
            let reset = Utc::now() + Duration::hours(3);
            at_limit(a, reset).await?;
            assert_eq!(
                seconds(limit_of(&lane, SignIn::Credential(chatgpt)).await?),
                Some(reset.timestamp())
            );
            succeeded(b).await?;
            assert_eq!(
                seconds(limit_of(&lane, SignIn::Credential(chatgpt)).await?),
                Some(reset.timestamp()),
                "a turn leased before the limit leaves it"
            );
            let (_, next) = sent(&lane, "reviewer").await?;
            assert_eq!(next.credential_id, Some(chatgpt_2), "the next turn takes the backup");
            lane.end_jobs().await?;
            sql(
                lane.pool(),
                "update agent_jobs set status = 'queued', completed_at = null where id = $1",
                &[&c],
            )
            .await?;
            let leased = lane.harness.lease(runtime).await?;
            assert_eq!(leased["id"], json!(c));
            succeeded(c).await?;
            assert_eq!(
                limit_of(&lane, SignIn::Credential(chatgpt)).await?,
                None,
                "a turn leased after the limit clears it"
            );

            // A longer limit, then a shorter report: the longer stands.
            let d = turn(true).await?;
            let e = turn(true).await?;
            let long = Utc::now() + Duration::days(5);
            let short = Utc::now() + Duration::minutes(20);
            at_limit(d, long).await?;
            at_limit(e, short).await?;
            assert_eq!(
                seconds(limit_of(&lane, SignIn::Credential(chatgpt)).await?),
                Some(long.timestamp())
            );
            // A shorter limit, then a longer report: the longer one.
            limit(&lane, SignIn::Credential(chatgpt), None).await?;
            let f = turn(true).await?;
            let g = turn(true).await?;
            let longer = Utc::now() + Duration::days(2);
            at_limit(f, short).await?;
            at_limit(g, longer).await?;
            assert_eq!(
                seconds(limit_of(&lane, SignIn::Credential(chatgpt)).await?),
                Some(longer.timestamp())
            );

            // The same holds for a Claude Code login.
            let first = first_login_of(owner);
            let (_, early) = lane.lane_turn().await?;
            lane.lease_one(lane.desktop, early).await?;
            sql(
                lane.pool(),
                "update claude_code_logins
                    set limit_resets_at = now() + interval '1 hour', limit_recorded_at = now()
                  where id = $1",
                &[&first],
            )
            .await?;
            lane.harness
                .complete(lane.desktop, early, json!({ "outcome": "succeeded", "summary": "Done." }))
                .await?;
            assert!(
                limit_of(&lane, SignIn::Login(first)).await?.is_some(),
                "a lane turn leased before the limit leaves it"
            );
            Ok(())
        },
    )
    .await
}

/// Where a turn reaches a Claude Code login only as a backup, a login the
/// lane would refuse the turn on is passed over, and the turn goes on to the
/// next AI (docs/Local-Engine-Turns.md 11.20): here a `/` command, which
/// Claude Code would read as its own. A Claude Code agent with room on its
/// first login refuses such a turn as before backups; once that login is at
/// its limit, the turn goes on to its connection.
#[tokio::test]
async fn a_backup_login_the_lane_would_refuse_is_passed_over() -> anyhow::Result<()> {
    with_lane(
        "backup-ais-refused-login",
        |_, _| {},
        |lane| async move {
            let space = lane.space();
            let owner = space.owner;
            let runtime = space.runtime;
            let chatgpt = lane.owner_credential;
            let chatgpt_2 = connection_of(&lane, owner, "ChatGPT 2").await?;
            let first = first_login_of(owner);
            let work = login_of(&lane, owner, "Work", 1).await?;
            reviewer_with(
                &lane,
                json!([{ "claudeCodeLoginId": work }, { "credentialId": chatgpt_2 }]),
            )
            .await?;
            limit(&lane, SignIn::Credential(chatgpt), Some(60)).await?;
            let command = |handle: &str| {
                json!({
                    "promptText": "/review the failing build",
                    "intent": "feature",
                    "runtimeId": runtime.to_string(),
                    "metadata": metadata_for(&[handle], json!({})),
                })
            };
            let job = lane
                .job(lane.admitted(lane.chat().await?, &command("reviewer")).await?)
                .await?;
            assert_eq!((job.engine.as_deref(), job.credential_id), (None, Some(chatgpt_2)));
            let (_, job) = sent(&lane, "reviewer").await?;
            assert_eq!(job.claude_code_login_ids, Some(vec![work]), "words it can take");
            lane.end_jobs().await?;

            let (status, body) = save(
                &lane,
                lane.owner_claude,
                json!({ "backupAis": [{ "claudeCodeLoginId": work }, { "credentialId": chatgpt_2 }] }),
            )
            .await?;
            assert_eq!(status, StatusCode::OK, "{body}");
            lane.refused(
                &lane.owner(),
                lane.chat().await?,
                command(CLAUDE),
                unsupported("command"),
            )
            .await?;
            limit(&lane, SignIn::Login(first), Some(60)).await?;
            let job = lane
                .job(lane.admitted(lane.chat().await?, &command(CLAUDE)).await?)
                .await?;
            assert_eq!((job.engine.as_deref(), job.credential_id), (None, Some(chatgpt_2)));
            Ok(())
        },
    )
    .await
}

/// A person the switch does not cover takes no turn on Claude Code, and a
/// login among an agent's backups is passed over for them as for any turn the
/// lane refuses (docs/Local-Engine-Turns.md 11.6, 11.20); a Claude Code agent
/// with room on its first login is refused as before.
#[tokio::test]
async fn a_backup_login_is_passed_over_while_the_switch_does_not_cover_its_owner(
) -> anyhow::Result<()> {
    with_lane(
        "backup-ais-switch-off",
        |config, space| {
            config.claude_code_lane =
                ClaudeCodeLaneUsers(DeviceGrantUsers::Only(vec![space.member]));
        },
        |lane| async move {
            let space = lane.space();
            let owner = space.owner;
            let chatgpt = lane.owner_credential;
            let chatgpt_2 = connection_of(&lane, owner, "ChatGPT 2").await?;
            let first = first_login_of(owner);
            reviewer_with(&lane, json!([{ "credentialId": chatgpt_2 }])).await?;
            // Saved while the switch covered them.
            let reviewer = lane.agent_of(owner, "reviewer").await?;
            sql(
                lane.pool(),
                "update user_agents set backup_ais = $2 where id = $1",
                &[
                    &reviewer,
                    &PgJson(entries(&[
                        SignIn::Login(first),
                        SignIn::Credential(chatgpt_2),
                    ])),
                ],
            )
            .await?;
            limit(&lane, SignIn::Credential(chatgpt), Some(60)).await?;
            let (_, job) = sent(&lane, "reviewer").await?;
            assert_eq!(
                (job.engine.as_deref(), job.credential_id),
                (None, Some(chatgpt_2))
            );
            lane.refused(
                &lane.owner(),
                lane.chat().await?,
                lane_send(lane_metadata(json!({}))),
                not_allowed(),
            )
            .await?;
            Ok(())
        },
    )
    .await
}
