use std::fs;
use std::process::Command as StdCommand;
use std::sync::Arc;

use anyhow::anyhow;
use axum::{Json, Router, http::StatusCode, routing::post};
use tokio::sync::mpsc;
use uuid::Uuid;

use super::*;
use crate::agent_executor::is_lease_lost;
use crate::config::Config;
use crate::jobs::tests::{test_job_processor, test_lease_job};

fn git(dir: &Path, args: &[&str]) {
    let status = StdCommand::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .status()
        .expect("run git");
    assert!(status.success(), "git {args:?}");
}

/// A checkout whose saved version has the page a turn then edits.
fn checkout(dir: &Path) {
    fs::create_dir_all(dir.join("sites/porto")).unwrap();
    fs::write(dir.join("sites/porto/app.js"), "hours: \"Not checked\"\n").unwrap();
    git(dir, &["init", "--quiet", "--initial-branch=main"]);
    git(dir, &["add", "-A"]);
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

fn changed_paths(error: &anyhow::Error) -> Vec<(String, String)> {
    let changes = error
        .downcast_ref::<StoppedTurnChanges>()
        .expect("the turn's changes go with its error");
    let mut paths: Vec<(String, String)> = changes
        .files
        .iter()
        .map(|file| {
            let entry = super::super::apply_files_entry(file);
            (
                file.workspace_path.clone(),
                entry["changeType"].as_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    paths.sort();
    paths
}

/// A step the model sent before the turn learned of its Stop changed the page,
/// and another added one. The turn's lost lease carries both, and is still a
/// lost lease.
#[tokio::test]
async fn a_turn_that_lost_its_lease_carries_what_it_changed() {
    let workspace = tempfile::tempdir().unwrap();
    checkout(workspace.path());
    // Work the folder held before the turn is not the turn's.
    fs::write(workspace.path().join("notes.md"), "the person's own\n").unwrap();
    let start = TurnStart::default();
    let before = super::super::collect_git_status_porcelain(workspace.path())
        .await
        .unwrap();
    start.record(workspace.path(), &before);

    fs::write(
        workspace.path().join("sites/porto/app.js"),
        "hours: \"Hours not found\"\n",
    )
    .unwrap();
    fs::write(
        workspace.path().join("sites/porto/route.html"),
        "<p>Route</p>\n",
    )
    .unwrap();

    let error = start
        .attach_to_lost_lease(Err(anyhow!("lease lost")))
        .await
        .expect_err("the turn lost its lease");
    assert!(is_lease_lost(&error));
    assert_eq!(
        changed_paths(&error),
        vec![
            ("sites/porto/app.js".to_string(), "changed".to_string()),
            ("sites/porto/route.html".to_string(), "created".to_string()),
        ]
    );
}

/// The report says what the turn left in each file it changed, read as it
/// stopped (the file's blob id, or null for one it removed), and which of
/// them the folder already held changed when the turn began, on the machine
/// that ran it: Undo puts back with no turn only files that still hold what
/// the turn left and that it found as saved.
#[tokio::test]
async fn a_stopped_turns_report_says_what_it_left_in_each_file() {
    let workspace = tempfile::tempdir().unwrap();
    checkout(workspace.path());
    fs::write(
        workspace.path().join("sites/porto/old.html"),
        "<p>Old</p>\n",
    )
    .unwrap();
    git(workspace.path(), &["add", "-A"]);
    git(
        workspace.path(),
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
    // The person's own edit, unsaved, before the turn began.
    fs::write(workspace.path().join("notes.md"), "the person's own\n").unwrap();
    let start = TurnStart::default();
    let before = super::super::collect_git_status_porcelain(workspace.path())
        .await
        .unwrap();
    start.record(workspace.path(), &before);
    fs::write(
        workspace.path().join("sites/porto/app.js"),
        "hours: \"Hours not found\"\n",
    )
    .unwrap();
    fs::remove_file(workspace.path().join("sites/porto/old.html")).unwrap();
    fs::write(
        workspace.path().join("notes.md"),
        "the person's own\nand the turn's\n",
    )
    .unwrap();

    let error = start
        .attach_to_lost_lease(Err(anyhow!("lease lost")))
        .await
        .expect_err("the turn lost its lease");
    let changes = StoppedTurnChanges::of_lost_lease(&error).expect("the turn's changes");
    let runtime_id = Uuid::new_v4();
    let (_, artifacts) = changes.report(&runtime_id);
    let blob = origin_http_server::workspace_git::blob_oid;
    assert_eq!(
        artifacts[0]["metadata"]["undo"],
        json!({
            "runtimeId": runtime_id.to_string(),
            "leftAs": {
                "notes.md": blob(b"the person's own\nand the turn's\n"),
                "sites/porto/app.js": blob(b"hours: \"Hours not found\"\n"),
                "sites/porto/old.html": null,
            },
            "changedBefore": ["notes.md"],
        })
    );

    // A turn whose Stop came once its model was done, whose start is not
    // known here, leaves its files to the agent's Undo.
    let execution = finished_execution(vec![json!({
        "kind": "apply/files",
        "files": [{ "path": "sites/porto/app.js", "workspacePath": "sites/porto/app.js", "changeType": "changed", "change": { "type": "changed" } }],
    })]);
    let finished = StoppedTurnChanges::of_finished_turn(workspace.path().to_path_buf(), &execution)
        .expect("the turn changed a file");
    let (_, artifacts) = finished.report(&runtime_id);
    assert_eq!(artifacts[0]["metadata"]["stoppedBeforeSave"], true);
    assert!(artifacts[0]["metadata"].get("undo").is_none());
}

/// A turn that ended any other way, or lost its lease having changed nothing,
/// carries no changes.
#[tokio::test]
async fn only_a_turn_that_lost_its_lease_after_changing_files_carries_changes() {
    let workspace = tempfile::tempdir().unwrap();
    checkout(workspace.path());
    let recorded = || async {
        let start = TurnStart::default();
        let before = super::super::collect_git_status_porcelain(workspace.path())
            .await
            .unwrap();
        start.record(workspace.path(), &before);
        start
    };

    // Nothing changed.
    let error = recorded()
        .await
        .attach_to_lost_lease(Err(anyhow!("lease lost")))
        .await
        .unwrap_err();
    assert!(error.downcast_ref::<StoppedTurnChanges>().is_none());

    fs::write(workspace.path().join("sites/porto/app.js"), "changed\n").unwrap();
    // Changed, but not stopped: a failure, or a finished turn.
    let start = recorded().await;
    fs::write(
        workspace.path().join("sites/porto/app.js"),
        "changed again\n",
    )
    .unwrap();
    let error = start
        .attach_to_lost_lease(Err(anyhow!("codex exited with status 1")))
        .await
        .unwrap_err();
    assert!(error.downcast_ref::<StoppedTurnChanges>().is_none());
    let start = recorded().await;
    fs::write(workspace.path().join("sites/porto/app.js"), "and again\n").unwrap();
    let finished = start
        .attach_to_lost_lease(Ok(JobExecution {
            summary: "done".to_string(),
            suggested_replies: Vec::new(),
            provider: "test".to_string(),
            artifacts: Vec::new(),
            credit_snapshot: None,
            provider_conversation_state: None,
            messages: Vec::new(),
            messages_streamed: false,
            final_messages: Vec::new(),
        }))
        .await;
    assert_eq!(finished.unwrap().summary, "done");

    // A turn that saves nothing to the workspace records nothing.
    let error = TurnStart::default()
        .attach_to_lost_lease(Err(anyhow!("lease lost")))
        .await
        .unwrap_err();
    assert!(error.downcast_ref::<StoppedTurnChanges>().is_none());
}

/// The report names the edit as the turn's step, with the label a finished
/// turn's edit has and the file by its place in the turn's folder, as the
/// turn's own edit steps name it, and lists the files as a finished turn's
/// reply does: not saved, since a turn that lost its lease never saved.
#[test]
fn the_report_is_the_edit_step_and_the_files_it_changed() {
    let changes = StoppedTurnChanges {
        workspace_dir: PathBuf::from("/workspace/project"),
        files: vec![CodexFileDescriptor {
            path: "sites/porto/app.js".to_string(),
            workspace_path: "sites/porto/app.js".to_string(),
            label: None,
            description: None,
            mime_type: None,
            content: None,
            content_base64: None,
            change: super::super::FileChangeDescriptor::parse(json!({ "type": "changed" })),
        }],
        save: None,
        undo: None,
    };
    let runtime_id = Uuid::new_v4();
    let (step, artifacts) = changes.report(&runtime_id);
    assert_eq!(step.message_type.as_deref(), Some("file_change"));
    assert_eq!(
        step.content,
        "Applied file changes: /workspace/project/sites/porto/app.js"
    );
    let metadata = step.metadata.expect("step metadata");
    assert_eq!(metadata["kind"], "codex_file_change");
    assert_eq!(metadata["status"], "completed");
    assert_eq!(
        metadata["paths"],
        json!(["/workspace/project/sites/porto/app.js"])
    );
    assert_eq!(metadata["runtimeId"], json!(runtime_id.to_string()));
    assert_eq!(
        metadata["activity"],
        super::super::activity_labels::file_change_activity(1).unwrap()
    );
    assert_eq!(artifacts.len(), 1);
    assert_eq!(artifacts[0]["kind"], "apply/files");
    assert_eq!(artifacts[0]["metadata"]["stoppedBeforeSave"], true);
    let files = artifacts[0]["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(files[0]["path"], "sites/porto/app.js");
    assert_eq!(files[0]["workspacePath"], "sites/porto/app.js");
    assert_eq!(files[0]["changeType"], "changed");
}

fn finished_execution(artifacts: Vec<JsonValue>) -> JobExecution {
    JobExecution {
        summary: "I put the hours on the page.".to_string(),
        suggested_replies: Vec::new(),
        provider: "codex-embedded".to_string(),
        artifacts,
        credit_snapshot: None,
        provider_conversation_state: None,
        messages: Vec::new(),
        messages_streamed: true,
        final_messages: Vec::new(),
    }
}

/// A Stop that reached the turn after its model was done: what it changed is
/// what its reply would have listed (not the files it only read), with its
/// save, and never its usage.
#[test]
fn a_finished_turns_changes_are_the_files_its_reply_lists_and_its_save() {
    let save = json!({
        "kind": "origin/apply",
        "metadata": { "gitSyncStatus": "synced", "gitRev": "abc1234", "gitBaseRev": "def5678" },
    });
    let execution = finished_execution(vec![
        json!({ "kind": "codex/run-log", "events": [] }),
        json!({
            "kind": "apply/files",
            "files": [
                { "path": "sites/porto/app.js", "workspacePath": "sites/porto/app.js", "changeType": "changed", "change": { "type": "changed" } },
                { "path": "sites/porto/README.md", "workspacePath": "sites/porto/README.md", "changeType": "read", "change": { "type": "read" } },
                { "path": "./sites/porto/route.html", "workspacePath": "./sites/porto/route.html", "changeType": "created", "change": { "type": "created" } },
                { "path": "../outside.txt", "workspacePath": "../outside.txt", "changeType": "changed", "change": { "type": "changed" } },
            ],
        }),
        save.clone(),
        json!({ "kind": "ai/task-usage", "usage": { "inputTokens": 42 } }),
    ]);
    let changes =
        StoppedTurnChanges::of_finished_turn(PathBuf::from("/workspace/project"), &execution)
            .expect("the turn changed files");
    let (step, artifacts) = changes.report(&Uuid::new_v4());
    assert_eq!(
        step.metadata.unwrap()["paths"],
        json!([
            "/workspace/project/sites/porto/app.js",
            "/workspace/project/sites/porto/route.html"
        ])
    );
    assert_eq!(artifacts.len(), 2, "{artifacts:?}");
    assert_eq!(artifacts[0]["kind"], "apply/files");
    assert!(artifacts[0]["metadata"].get("stoppedBeforeSave").is_none());
    let listed: Vec<&str> = artifacts[0]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|file| file["workspacePath"].as_str().unwrap())
        .collect();
    assert_eq!(listed, ["sites/porto/app.js", "sites/porto/route.html"]);
    assert_eq!(artifacts[1], save);

    // A turn that only read files, or listed none, changed nothing.
    let read_only = finished_execution(vec![json!({
        "kind": "apply/files",
        "files": [{ "path": "a.md", "workspacePath": "a.md", "changeType": "read", "change": { "type": "read" } }],
    })]);
    assert!(
        StoppedTurnChanges::of_finished_turn(PathBuf::from("/workspace/project"), &read_only)
            .is_none()
    );
    assert!(
        StoppedTurnChanges::of_finished_turn(
            PathBuf::from("/workspace/project"),
            &finished_execution(Vec::new())
        )
        .is_none()
    );
}

/// A controller that answers `/agent/stopped` with `status`, and what it was sent.
async fn controller(status: StatusCode) -> (Config, mpsc::UnboundedReceiver<JsonValue>) {
    let (sent, received) = mpsc::unbounded_channel();
    let app = Router::new().route(
        "/agent/stopped",
        post(move |Json(body): Json<JsonValue>| {
            let sent = sent.clone();
            async move {
                sent.send(body).unwrap();
                (status, Json(json!({ "ok": status.is_success() })))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut config = (*test_job_processor(Path::new("/nonexistent")).config).clone();
    config.controller_base_url = reqwest::Url::parse(&base).unwrap();
    (config, received)
}

/// The report goes to the controller as the job's one end report. Recorded,
/// the job has ended here: its record of how its turn began goes. Turned down
/// (a stop of this runtime put the job back in the queue), the record stays
/// for the job's next lease.
#[tokio::test]
async fn the_stopped_turns_report_ends_the_job_here_only_when_recorded() {
    for (status, recorded) in [(StatusCode::OK, true), (StatusCode::CONFLICT, false)] {
        let root = tempfile::tempdir().unwrap();
        let (mut config, mut received) = controller(status).await;
        config.workspace_root = root.path().to_path_buf();
        let processor = JobProcessor::new(Arc::new(config.clone()));
        let job = test_lease_job(Some("feature"), json!({ "prompt_text": "keep going" }));
        let workspace = config.project_workspace_dir(&job.project_id.unwrap());
        fs::create_dir_all(&workspace).unwrap();
        checkout(&workspace);
        let before = super::super::collect_git_status_porcelain(&workspace)
            .await
            .unwrap();
        super::super::turn_baseline::begin(&workspace, job.id, false, None, &before);
        let start = TurnStart::default();
        start.record(&workspace, &before);
        fs::write(workspace.join("sites/porto/app.js"), "hours: \"edited\"\n").unwrap();
        let error = start
            .attach_to_lost_lease(Err(anyhow!("lease lost")))
            .await
            .unwrap_err();

        let registration = crate::jobs::tests::test_registration_with_proxy();
        let client = ControllerClient::new(&config).unwrap();
        let changes = StoppedTurnChanges::of_lost_lease(&error).expect("the turn's changes");
        assert_eq!(
            processor
                .report_stopped_turn(&client, &registration, &job, changes)
                .await,
            recorded
        );

        let body = received.try_recv().expect("one end report");
        assert!(received.try_recv().is_err(), "only one");
        let page = workspace.join("sites/porto/app.js").display().to_string();
        assert_eq!(body["job_id"], json!(job.id.to_string()));
        assert_eq!(body["message_type"], "file_change");
        assert_eq!(body["content"], format!("Applied file changes: {page}"));
        assert_eq!(body["metadata"]["paths"], json!([page]));
        assert_eq!(
            body["artifacts"][0]["files"][0]["workspacePath"],
            "sites/porto/app.js"
        );
        let baseline_kept =
            super::super::turn_baseline::begin(&workspace, job.id, true, None, &HashMap::new())
                .is_some();
        assert_eq!(baseline_kept, !recorded, "{status}");
    }

    // A turn that changed nothing has nothing to report.
    assert!(StoppedTurnChanges::of_lost_lease(&anyhow!("lease lost")).is_none());
}
