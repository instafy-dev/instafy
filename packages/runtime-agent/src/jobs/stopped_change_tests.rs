use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::anyhow;
use axum::{Json, Router, http::StatusCode, routing::post};
use tokio::sync::mpsc;

use super::*;
use crate::codex::ThreadLane;
use crate::jobs::conversation_context::build_prompt_conversation_context;
use crate::jobs::save_report::{SaveReport, append_not_saved};
use crate::jobs::tests::{test_job_processor, test_lease_job, test_registration_with_proxy};
use crate::origin::UnsavedPutBack;

/// The page's data file, as the saved version has it, as the stopped turn
/// left it (a column added, never saved), and with the next turn's change.
const PAGE: &str = "sites/compare/data.json";
const SAVED: &str = "{ \"columns\": [\"Price\"] }\n";
const STOPPED: &str = "{ \"columns\": [\"Price\", \"Warranty\"] }\n";
const NEXT: &str = "{ \"columns\": [\"Price\", \"Battery\"] }\n";
const STOPPED_REQUEST: &str = "Add a warranty column to the comparison.";
const REPORT: &str = "message-stopped-report";

/// Git in a space's checkout, whose repository is its `.instafy/.git`.
fn git(dir: &Path, args: &[&str]) -> String {
    let output = crate::git_env::git_command()
        .arg("--git-dir")
        .arg(dir.join(".instafy/.git"))
        .arg("--work-tree")
        .arg(dir)
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("run git");
    assert!(output.status.success(), "git {args:?}: {output:?}");
    String::from_utf8_lossy(&output.stdout).trim().to_string()
}

/// A space's checkout whose saved version has the page.
fn checkout(dir: &Path) {
    fs::create_dir_all(dir.join("sites/compare")).unwrap();
    fs::create_dir_all(dir.join(".instafy")).unwrap();
    fs::write(dir.join(PAGE), SAVED).unwrap();
    git(dir, &["init", "--quiet", "--initial-branch=main"]);
    fs::write(dir.join(".instafy/.git/info/exclude"), "/.instafy/\n").unwrap();
    git(dir, &["add", "sites"]);
    git(
        dir,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "--quiet",
            "-m",
            "saved",
        ],
    );
}

fn blob(content: &str) -> String {
    origin_http_server::workspace_git::blob_oid(content.as_bytes())
}

/// The stopped turn's report, as the chat's history carries it: what it left
/// in the page on the machine `runtime_id`.
fn report(runtime_id: &Uuid, undo: JsonValue) -> JsonValue {
    let mut undo = undo;
    undo["runtimeId"] = json!(runtime_id.to_string());
    json!({
        "id": REPORT, "role": "assistant", "runId": "run-1",
        "createdAt": "2026-11-20T02:12:14Z",
        "content": format!("Applied file changes: /workspace/space/{PAGE}"),
        "metadata": {
            "source": "agent", "kind": "update", "outcome": "canceled",
            "messageType": "file_change", "jobId": "job-1",
            "details": { "paths": [format!("/workspace/space/{PAGE}")] },
            "artifacts": [{
                "kind": "apply/files",
                "files": [{ "path": PAGE, "workspacePath": PAGE, "changeType": "changed" }],
                "metadata": { "provider": "codex-embedded", "stoppedBeforeSave": true, "undo": undo },
            }],
        },
    })
}

/// A chat where the person stopped a change before it was saved, then sent
/// another change to the same page; `between` are the entries in between.
fn chat(runtime_id: &Uuid, undo: JsonValue, between: Vec<JsonValue>, next: JsonValue) -> JsonValue {
    let mut entries = vec![
        json!({
            "id": "message-1", "role": "user", "runId": "run-1",
            "createdAt": "2026-11-20T02:11:40Z", "content": STOPPED_REQUEST,
        }),
        json!({
            "id": "message-stop", "role": "assistant", "runId": "run-1",
            "createdAt": "2026-11-20T02:12:13Z", "content": "Stopped this run.",
            "metadata": { "source": "controller", "kind": "run_cancellation", "details": {
                "reason": "Stopped", "runIds": ["run-1"], "jobIds": ["job-1"],
                "stopRequested": true, "actorUserId": "person-1", "agentHandles": ["octo"],
            }},
        }),
        report(runtime_id, undo),
    ];
    entries.extend(between);
    entries.push(next);
    json!(entries)
}

fn next_message() -> JsonValue {
    json!({
        "id": "message-2", "role": "user", "runId": "run-2",
        "createdAt": "2026-11-20T02:13:40Z", "content": "Add a battery column to the comparison.",
    })
}

fn left_as_stopped() -> JsonValue {
    json!({ "leftAs": { PAGE: blob(STOPPED) }, "changedBefore": [] })
}

/// The line the controller records for a change put back, as the chat's
/// history carries it.
fn put_back_line() -> JsonValue {
    json!({
        "id": "message-put-back", "role": "assistant",
        "createdAt": "2026-11-20T02:13:41Z",
        "content": format!("The change from “{STOPPED_REQUEST}” was stopped before it was saved, so it was taken back before the next change"),
        "metadata": {
            "source": "controller", "kind": "change_undone", "presentation": { "hidden": true },
            "undoneMessageId": REPORT, "undoneRunId": "run-1", "undonePaths": [PAGE],
        },
    })
}

#[test]
fn only_a_change_the_folder_may_still_hold_is_read_from_the_chat() {
    let runtime_id = Uuid::new_v4();
    let read = |history: &JsonValue| unsaved_changes(Some(history), &runtime_id);

    // Stopped, never saved, not asked for again: the change, in the person's words.
    let stopped = read(&chat(
        &runtime_id,
        left_as_stopped(),
        vec![],
        next_message(),
    ));
    assert_eq!(
        stopped,
        vec![UnsavedChange {
            message_id: REPORT.to_string(),
            stopped: true,
            request: Some(STOPPED_REQUEST.to_string()),
            left_as: BTreeMap::from([(PAGE.to_string(), Some(blob(STOPPED)))]),
            changed_before: false,
        }]
    );

    // A file the turn found already changed.
    let found_changed = read(&chat(
        &runtime_id,
        json!({ "leftAs": { PAGE: blob(STOPPED) }, "changedBefore": [PAGE] }),
        vec![],
        next_message(),
    ));
    assert!(found_changed[0].changed_before);

    // A file the turn removed.
    let removed = read(&chat(
        &runtime_id,
        json!({ "leftAs": { PAGE: null }, "changedBefore": [] }),
        vec![],
        next_message(),
    ));
    assert_eq!(
        removed[0].left_as,
        BTreeMap::from([(PAGE.to_string(), None)])
    );

    // The person asked to go on with it (Continue under the Stop): theirs to keep.
    let mut go_on = next_message();
    go_on["metadata"] = json!({ "continuedRunIds": ["run-1"] });
    let continued = read(&chat(&runtime_id, left_as_stopped(), vec![], go_on));
    assert_eq!(continued.len(), 1);
    assert!(!continued[0].stopped);
    assert_eq!(continued[0].request, None);

    // Undone already, by the person or by an earlier turn: nothing to put back.
    assert!(
        read(&chat(
            &runtime_id,
            left_as_stopped(),
            vec![put_back_line()],
            next_message()
        ))
        .is_empty()
    );

    // Another machine's folder holds it, not this one.
    assert!(
        unsaved_changes(
            Some(&chat(
                &runtime_id,
                left_as_stopped(),
                vec![],
                next_message()
            )),
            &Uuid::new_v4()
        )
        .is_empty()
    );

    // A stopped turn whose report says nothing of what it left (its Stop came
    // once its model was done), and a chat with no stopped turn.
    let mut unknown = chat(&runtime_id, left_as_stopped(), vec![], next_message());
    unknown[2]["metadata"]["artifacts"][0]["metadata"]
        .as_object_mut()
        .unwrap()
        .remove("undo");
    assert!(read(&unknown).is_empty());
    assert!(read(&json!([next_message()])).is_empty());
    assert!(unsaved_changes(None, &runtime_id).is_empty());
}

/// The origin's own put-back of a change no save took, on `workspace`.
fn origin_put_back(workspace: PathBuf) -> UnsavedPutBack {
    let origin_id = Uuid::new_v4();
    UnsavedPutBack::new(move |expected| {
        let workspace = workspace.clone();
        async move {
            let summary = origin_http_server::git::put_back_kept(
                &workspace,
                &expected,
                origin_http_server::workspace_git::GitIdentity::new(
                    "Fixture",
                    "fixture@example.test",
                ),
                origin_id,
            )
            .map_err(|error| anyhow!("{error}"))?;
            Ok(summary
                .reverted
                .into_iter()
                .chain(summary.removed)
                .collect())
        }
    })
}

/// A controller that records a change put back, and what it was sent.
async fn controller(
    processor_root: &Path,
) -> (crate::config::Config, mpsc::UnboundedReceiver<JsonValue>) {
    let (sent, received) = mpsc::unbounded_channel();
    let app = Router::new().route(
        "/agent/stopped/put-back",
        post(move |Json(body): Json<JsonValue>| {
            let sent = sent.clone();
            async move {
                sent.send(body).unwrap();
                (
                    StatusCode::OK,
                    Json(json!({ "ok": true, "line": put_back_line() })),
                )
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut config = (*test_job_processor(processor_root).config).clone();
    config.controller_base_url = reqwest::Url::parse(&base).unwrap();
    (config, received)
}

/// A save of `paths` that reached the saved version.
fn saved(paths: &[&str]) -> CommitToOriginResult {
    CommitToOriginResult {
        origin_id: Uuid::new_v4(),
        origin_endpoint: "http://127.0.0.1:1".to_string(),
        origin_mode: "hosted".to_string(),
        lease_id: Uuid::new_v4(),
        apply_rev: None,
        apply_base_rev: None,
        git_rev: Some("a".repeat(40)),
        git_base_rev: None,
        git_sync_attempted: true,
        git_sync_error: None,
        save: SaveReport::default(),
        paths: paths.iter().map(|path| path.to_string()).collect(),
    }
}

/// The person stops a change midway (a column added, not saved), then sends
/// another change to the same page. The next turn puts the stopped change
/// back before it changes anything, as that change's own Undo does: the page
/// it then saves holds only its own change, what the stopped turn left is
/// kept as unsaved work, the controller is told so the stopped row reads as
/// undone, and the turn reads that the files no longer hold the change. The
/// stopped row's own Undo, pressed afterwards, finds nothing left to take
/// back and takes nothing of the next turn's.
#[tokio::test]
async fn the_next_turn_puts_a_stopped_unsaved_change_back_before_it_changes_anything() {
    let root = tempfile::tempdir().unwrap();
    let (config, mut told) = controller(root.path()).await;
    let processor = JobProcessor::new(Arc::new(config.clone()));
    let workspace = config.project_workspace_dir(&config.project_id);
    fs::create_dir_all(&workspace).unwrap();
    checkout(&workspace);
    processor.set_unsaved_put_back(Some(origin_put_back(workspace.clone())));
    let registration = test_registration_with_proxy();

    // The stopped turn's change, in the folder and never saved.
    fs::write(workspace.join(PAGE), STOPPED).unwrap();
    let history = chat(
        &registration.runtime_id,
        left_as_stopped(),
        vec![],
        next_message(),
    );
    let job = test_lease_job(
        Some("feature"),
        json!({ "prompt_text": "Add a battery column to the comparison.", "conversation_history": history }),
    );

    let (with_lines, standing) = processor
        .put_back_stopped_changes(&registration, &job, config.project_id, None)
        .await
        .unwrap();

    // The page is as the saved version has it, and nothing is left changed.
    assert_eq!(fs::read_to_string(workspace.join(PAGE)).unwrap(), SAVED);
    let before = super::super::collect_git_status_porcelain(&workspace)
        .await
        .unwrap();
    assert!(!before.contains_key(PAGE), "{before:?}");
    // What the stopped turn left is kept as unsaved work.
    let kept = git(
        &workspace,
        &["for-each-ref", "--format=%(refname)", "refs/instafy/"],
    );
    assert!(kept.contains("-undone-"), "{kept}");
    assert_eq!(kept.lines().count(), 1, "{kept}");
    assert_eq!(
        git(&workspace, &["show", &format!("{kept}:{PAGE}")]),
        STOPPED.trim()
    );
    // The controller was told which row's change went back, once.
    let report = told.try_recv().expect("the put-back is recorded");
    assert!(told.try_recv().is_err(), "only once");
    assert_eq!(
        report,
        json!({ "job_id": job.id, "message_id": REPORT, "paths": [PAGE] })
    );
    // Nothing of it stays, so the turn's save has nothing of it to say.
    assert!(standing.0.is_empty(), "{standing:?}");

    // This turn reads the line the controller recorded, before its own message.
    let job = with_lines.expect("the turn's history gains the line");
    let entries = job.payload["conversation_history"].as_array().unwrap();
    assert_eq!(entries.len(), 5);
    assert_eq!(entries[3], put_back_line());
    assert_eq!(entries[4], next_message());
    let context = build_prompt_conversation_context(
        job.payload.get("conversation_history"),
        None,
        ThreadLane::Building,
    );
    assert!(
        context.section_text.contains(
            "was stopped before it was saved, so it was taken back before the next change"
        ),
        "{}",
        context.section_text
    );
    // And a later turn, whose history holds that line, puts nothing back.
    assert!(
        unsaved_changes(
            job.payload.get("conversation_history"),
            &registration.runtime_id
        )
        .is_empty()
    );

    // The turn's own change, saved: the page holds it and nothing of the
    // stopped one, and the save says nothing of a stopped change.
    fs::write(workspace.join(PAGE), NEXT).unwrap();
    let (mut artifacts, mut sentences) = (Vec::new(), Vec::new());
    standing.saved_with(
        &saved(&[PAGE]),
        Some(&before),
        &mut artifacts,
        &mut sentences,
    );
    assert!(artifacts.is_empty() && sentences.is_empty());
    let page = fs::read_to_string(workspace.join(PAGE)).unwrap();
    assert!(
        page.contains("Battery") && !page.contains("Warranty"),
        "{page}"
    );

    // The stopped row's Undo, pressed now (the same put-back, with what the
    // turn left): nothing holds that change any more, and nothing moves.
    let again = origin_put_back(workspace.clone())
        .run(BTreeMap::from([(PAGE.to_string(), Some(blob(STOPPED)))]))
        .await;
    assert!(
        matches!(&again, Err(error) if error.to_string().contains("changed since")),
        "the next turn's unsaved change is not this row's to take back: {again:?}"
    );
    assert_eq!(fs::read_to_string(workspace.join(PAGE)).unwrap(), NEXT);
    // Once the next turn's change is saved, that Undo has nothing to do.
    git(&workspace, &["add", "sites"]);
    git(
        &workspace,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.test",
            "commit",
            "--quiet",
            "-m",
            "the next turn",
        ],
    );
    let again = origin_put_back(workspace.clone())
        .run(BTreeMap::from([(PAGE.to_string(), Some(blob(STOPPED)))]))
        .await
        .expect("nothing left to undo");
    assert!(again.is_empty(), "{again:?}");
    assert_eq!(fs::read_to_string(workspace.join(PAGE)).unwrap(), NEXT);
    // What the stopped turn left is still kept, to review or restore.
    assert_eq!(
        git(&workspace, &["show", &format!("{kept}:{PAGE}")]),
        STOPPED.trim()
    );
}

/// The person changed the file after the Stop: the stopped change can't be
/// put back without taking their edit too, so it stays, nothing is recorded
/// as put back, and when the next turn's save takes the file its reply says
/// the stopped change was saved too, and names the stopped row for Studio.
#[tokio::test]
async fn a_change_that_cannot_be_put_back_stays_and_the_reply_says_it_was_saved_too() {
    let root = tempfile::tempdir().unwrap();
    let (config, mut told) = controller(root.path()).await;
    let processor = JobProcessor::new(Arc::new(config.clone()));
    let workspace = config.project_workspace_dir(&config.project_id);
    fs::create_dir_all(&workspace).unwrap();
    checkout(&workspace);
    processor.set_unsaved_put_back(Some(origin_put_back(workspace.clone())));
    let registration = test_registration_with_proxy();

    // The stopped turn's change, then the person's own edit of the same file.
    let edited = format!("{STOPPED}// my own note\n");
    fs::write(workspace.join(PAGE), &edited).unwrap();
    let history = chat(
        &registration.runtime_id,
        left_as_stopped(),
        vec![],
        next_message(),
    );
    let job = test_lease_job(
        Some("feature"),
        json!({ "prompt_text": "Add a battery column to the comparison.", "conversation_history": history }),
    );

    let (with_lines, standing) = processor
        .put_back_stopped_changes(&registration, &job, config.project_id, None)
        .await
        .unwrap();
    assert!(with_lines.is_none());
    assert!(told.try_recv().is_err(), "nothing was put back");
    assert_eq!(fs::read_to_string(workspace.join(PAGE)).unwrap(), edited);
    assert!(
        git(
            &workspace,
            &["for-each-ref", "--format=%(refname)", "refs/instafy/"]
        )
        .is_empty()
    );
    let before = super::super::collect_git_status_porcelain(&workspace)
        .await
        .unwrap();
    assert!(before.contains_key(PAGE));

    // A save that leaves the file out says nothing.
    let (mut artifacts, mut sentences) = (Vec::new(), Vec::new());
    standing.saved_with(
        &saved(&["sites/compare/app.js"]),
        Some(&before),
        &mut artifacts,
        &mut sentences,
    );
    let mut conflicted = saved(&[PAGE]);
    conflicted.save.conflicted_paths = vec![PAGE.to_string()];
    standing.saved_with(&conflicted, Some(&before), &mut artifacts, &mut sentences);
    let mut failed = saved(&[PAGE]);
    failed.git_sync_error = Some("the space could not be reached".to_string());
    standing.saved_with(&failed, Some(&before), &mut artifacts, &mut sentences);
    assert!(artifacts.is_empty() && sentences.is_empty());

    // The save that takes the file: the reply says so, and names the row.
    standing.saved_with(
        &saved(&[PAGE]),
        Some(&before),
        &mut artifacts,
        &mut sentences,
    );
    assert_eq!(
        artifacts,
        vec![json!({
            "kind": "stopped-turn/saved-later",
            "metadata": { "changes": [{ "messageId": REPORT, "paths": [PAGE] }] },
        })]
    );
    let mut reply = "Added the battery column.".to_string();
    append_not_saved(&mut reply, &sentences);
    assert_eq!(
        reply,
        format!(
            "Added the battery column.\n\nThis also saved the change that was stopped earlier (“{STOPPED_REQUEST}”)."
        )
    );
}

/// Every other change that stays: one whose file the turn found already
/// changed, one no origin in this process can put back, one in another
/// space's folder, and one the person asked to go on with, which the reply
/// has no word to add about.
#[tokio::test]
async fn a_change_stays_where_its_own_undo_would_leave_it() {
    let root = tempfile::tempdir().unwrap();
    let (config, mut told) = controller(root.path()).await;
    let workspace = config.project_workspace_dir(&config.project_id);
    fs::create_dir_all(&workspace).unwrap();
    checkout(&workspace);
    fs::write(workspace.join(PAGE), STOPPED).unwrap();
    let registration = test_registration_with_proxy();
    let job_of = |history: JsonValue| {
        test_lease_job(
            Some("feature"),
            json!({ "prompt_text": "Add a battery column.", "conversation_history": history }),
        )
    };
    let before = super::super::collect_git_status_porcelain(&workspace)
        .await
        .unwrap();
    let stays = |standing: &StandingChanges| {
        let (mut artifacts, mut sentences) = (Vec::new(), Vec::new());
        standing.saved_with(
            &saved(&[PAGE]),
            Some(&before),
            &mut artifacts,
            &mut sentences,
        );
        assert_eq!(fs::read_to_string(workspace.join(PAGE)).unwrap(), STOPPED);
        (artifacts.len(), sentences)
    };
    let said = vec![format!(
        "This also saved the change that was stopped earlier (“{STOPPED_REQUEST}”)"
    )];
    let stopped_chat = || {
        chat(
            &registration.runtime_id,
            left_as_stopped(),
            vec![],
            next_message(),
        )
    };

    // No origin in this process.
    let processor = JobProcessor::new(Arc::new(config.clone()));
    let (with_lines, standing) = processor
        .put_back_stopped_changes(
            &registration,
            &job_of(stopped_chat()),
            config.project_id,
            None,
        )
        .await
        .unwrap();
    assert!(with_lines.is_none());
    assert_eq!(stays(&standing), (1, said.clone()));

    processor.set_unsaved_put_back(Some(origin_put_back(workspace.clone())));
    // Another space's folder: this process's origin does not serve it.
    let (_, standing) = processor
        .put_back_stopped_changes(&registration, &job_of(stopped_chat()), Uuid::new_v4(), None)
        .await
        .unwrap();
    assert_eq!(stays(&standing), (1, said.clone()));

    // The turn found the file already changed.
    let found_changed = chat(
        &registration.runtime_id,
        json!({ "leftAs": { PAGE: blob(STOPPED) }, "changedBefore": [PAGE] }),
        vec![],
        next_message(),
    );
    let (_, standing) = processor
        .put_back_stopped_changes(
            &registration,
            &job_of(found_changed),
            config.project_id,
            None,
        )
        .await
        .unwrap();
    assert_eq!(stays(&standing), (1, said));

    // The person asked to go on with it: it is this turn's to save, and the
    // stopped row is still told it was saved.
    let mut go_on = next_message();
    go_on["metadata"] = json!({ "continuedRunIds": ["run-1"] });
    let continued = chat(&registration.runtime_id, left_as_stopped(), vec![], go_on);
    let (_, standing) = processor
        .put_back_stopped_changes(&registration, &job_of(continued), config.project_id, None)
        .await
        .unwrap();
    assert_eq!(stays(&standing), (1, Vec::new()));

    assert!(told.try_recv().is_err(), "nothing was put back");
    assert!(
        git(
            &workspace,
            &["for-each-ref", "--format=%(refname)", "refs/instafy/"]
        )
        .is_empty()
    );
}

/// The change is already back when the controller is told, and its row reads
/// as undone only once the line is recorded: a report that failed at the
/// controller is made again, and one it refuses is not.
#[tokio::test]
async fn a_put_back_the_controller_missed_is_reported_again() {
    let root = tempfile::tempdir().unwrap();
    for (answers, tries, recorded) in [
        (
            vec![StatusCode::SERVICE_UNAVAILABLE, StatusCode::OK],
            2,
            true,
        ),
        (
            vec![
                StatusCode::SERVICE_UNAVAILABLE,
                StatusCode::SERVICE_UNAVAILABLE,
                StatusCode::SERVICE_UNAVAILABLE,
            ],
            3,
            false,
        ),
        (vec![StatusCode::CONFLICT, StatusCode::OK], 1, false),
    ] {
        let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = asked.clone();
        let app = Router::new().route(
            "/agent/stopped/put-back",
            post(move || {
                let at = counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let status = answers[at.min(answers.len() - 1)];
                async move { (status, Json(json!({ "ok": true, "line": put_back_line() }))) }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let mut config = (*test_job_processor(root.path()).config).clone();
        config.controller_base_url = reqwest::Url::parse(&base).unwrap();
        let processor = JobProcessor::new(Arc::new(config));
        let job = test_lease_job(
            Some("feature"),
            json!({ "prompt_text": "Add a battery column." }),
        );

        let line = processor
            .record_put_back(
                &test_registration_with_proxy(),
                &job,
                REPORT,
                &[PAGE.to_string()],
                &[Duration::ZERO, Duration::ZERO],
            )
            .await;
        assert_eq!(line.is_some(), recorded);
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), tries);
    }
}

/// A whole building job in a chat that holds a stopped turn's unsaved change:
/// the job puts the change back, and the controller records it, before its
/// turn is written or any request reaches its model. Here the job is a
/// hand-back, which builds what the person asked next; it loses its lease
/// right after, so it ends before its model would run, and everything its
/// model would be sent goes to an endpoint that records it.
#[test]
fn a_building_job_puts_the_stopped_change_back_before_its_model_runs() {
    // `run_apply_job` needs a runtime-sized stack, as in production.
    const STACK_SIZE: usize = 32 * 1024 * 1024;
    std::thread::Builder::new()
        .stack_size(STACK_SIZE)
        .spawn(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .thread_stack_size(STACK_SIZE)
                .build()
                .unwrap()
                .block_on(building_job_in_a_chat_with_a_stopped_change())
        })
        .unwrap()
        .join()
        .unwrap();
}

async fn building_job_in_a_chat_with_a_stopped_change() {
    use axum::extract::OriginalUri;
    use std::sync::Mutex as StdMutex;

    // The controller: it records a change put back, and anything else it is
    // asked (the model's requests would come here) is recorded and refused.
    let put_backs = Arc::new(StdMutex::new(Vec::<JsonValue>::new()));
    let others = Arc::new(StdMutex::new(Vec::<String>::new()));
    let app = Router::new()
        .route(
            "/agent/stopped/put-back",
            post({
                let put_backs = put_backs.clone();
                move |Json(body): Json<JsonValue>| {
                    put_backs.lock().unwrap().push(body);
                    async move { Json(json!({ "ok": true, "line": put_back_line() })) }
                }
            }),
        )
        .fallback({
            let others = others.clone();
            move |OriginalUri(uri): OriginalUri| {
                others.lock().unwrap().push(uri.path().to_string());
                async move {
                    (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({ "error": { "message": "nothing answers here" } })),
                    )
                }
            }
        });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = reqwest::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let root = tempfile::tempdir().unwrap();
    let mut config = (*test_job_processor(root.path()).config).clone();
    config.controller_base_url = url.clone();
    config.controller_jwks_url = url.join("/.well-known/jwks.json").unwrap();
    let processor = JobProcessor::new(Arc::new(config.clone()));
    let workspace = config.project_workspace_dir(&config.project_id);
    fs::create_dir_all(&workspace).unwrap();
    checkout(&workspace);
    fs::write(workspace.join(PAGE), STOPPED).unwrap();
    processor.set_unsaved_put_back(Some(origin_put_back(workspace.clone())));

    let mut registration = test_registration_with_proxy();
    registration.proxy = Some(runtime_contracts::ProxyEnvelopePayload {
        url: url.as_str().trim_end_matches('/').to_string(),
        token: "inert-model-token".to_string(),
        expires_at: None,
    });
    let request = "Add a battery column to the comparison.";
    let mut job = test_lease_job(
        Some("feature"),
        json!({
            "prompt_text": "Continue building with what the browser turn found.",
            "conversation_history": chat(
                &registration.runtime_id,
                left_as_stopped(),
                vec![],
                next_message(),
            ),
            "metadata": {
                "writeIntent": true,
                "browserHandBack": {
                    "version": 1,
                    "verified": true,
                    "buildRequest": true,
                    "browserJobId": Uuid::new_v4(),
                    "cardJobId": Uuid::new_v4(),
                    "viewer": "Instafy's browser in the workspace",
                    "request": request,
                    "personRequest": request,
                    "reply": "",
                    "findings": [],
                },
            },
        }),
    );
    job.project_id = Some(config.project_id);
    job.run_id = Some(Uuid::new_v4());
    job.conversation_id = Some(Uuid::new_v4());

    // The job holds its lease until its change is put back and recorded, and
    // has lost it the next time it asks: what the page held then is kept.
    let page_when_the_lease_was_lost = Arc::new(StdMutex::new(None::<String>));
    let cancel = JobCancelSignal::new();
    cancel.check_lease_with(Arc::new({
        let put_backs = put_backs.clone();
        let seen = page_when_the_lease_was_lost.clone();
        let page = workspace.join(PAGE);
        move || {
            let held = put_backs.lock().unwrap().is_empty();
            if !held {
                *seen.lock().unwrap() = fs::read_to_string(&page).ok();
            }
            Box::pin(async move { held })
        }
    }));

    let error = tokio::time::timeout(
        Duration::from_secs(60),
        processor.run_apply_job(&registration, &job, true, None, Some(cancel), None),
    )
    .await
    .expect("the job ends")
    .expect_err("the job lost its lease before its model ran");

    assert!(
        crate::agent_executor::is_lease_lost(&error),
        "the job ends on its lost lease: {error:#}"
    );
    // The change went back, and was recorded for the stopped row, before then.
    assert_eq!(
        *put_backs.lock().unwrap(),
        vec![json!({ "job_id": job.id, "message_id": REPORT, "paths": [PAGE] })]
    );
    assert_eq!(
        page_when_the_lease_was_lost.lock().unwrap().as_deref(),
        Some(SAVED)
    );
    assert_eq!(fs::read_to_string(workspace.join(PAGE)).unwrap(), SAVED);
    let kept = git(
        &workspace,
        &["for-each-ref", "--format=%(refname)", "refs/instafy/"],
    );
    assert!(kept.contains("-undone-"), "{kept}");
    assert_eq!(
        *others.lock().unwrap(),
        Vec::<String>::new(),
        "nothing reached the model"
    );
}
