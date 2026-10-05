//! The salvage against real git: a bare canonical repository with the
//! shard's own update hook (in salvage mode where a test says so), parked
//! working copies under `.legacy/`, and stub controller services.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value as JsonValue;
use uuid::Uuid;

use super::options::Settings;
use super::services::{ExportOutcome, ExportedTo, Services};
use super::{entry_project, run, Summary};
use crate::test_support::{git_in, git_output, ig, init_workspace_repo, install_shard_hook};
use crate::workspace_git::GitIdentity;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDRchat";
const NODE: &str = "node-1";

/// The controller, as the salvage sees it.
#[derive(Default)]
struct Stub {
    read_tokens: Cell<usize>,
    salvage_tokens: Cell<usize>,
    exports: RefCell<Vec<(String, Vec<u8>)>>,
    keep_exports: Cell<bool>,
}

impl Services for Stub {
    fn read_token(&self, _project: &Uuid) -> anyhow::Result<Option<String>> {
        self.read_tokens.set(self.read_tokens.get() + 1);
        Ok(None)
    }

    fn salvage_token(&self, _project: &Uuid) -> anyhow::Result<String> {
        self.salvage_tokens.set(self.salvage_tokens.get() + 1);
        Ok("salvage-token".to_string())
    }

    fn export_attachment(&self, project: &Uuid, path: &str, bytes: Vec<u8>) -> ExportOutcome {
        self.exports.borrow_mut().push((path.to_string(), bytes));
        if self.keep_exports.get() {
            return ExportOutcome::Kept(
                "the controller answered 409 (attachments_unavailable)".into(),
            );
        }
        let conversation = Uuid::new_v4();
        ExportOutcome::Exported(vec![ExportedTo {
            conversation_id: conversation,
            storage_path: format!(
                "{project}/{conversation}/6a000000-0000-4000-8000-000000000001.png"
            ),
            messages: 1,
        }])
    }
}

/// A gateway root, canonical repositories, and a seed clone that writes
/// canonical `main`.
struct Gateway {
    _dir: tempfile::TempDir,
    base: PathBuf,
    root: PathBuf,
    seed: PathBuf,
    project: Uuid,
}

impl Gateway {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let top = dir.path().canonicalize().unwrap();
        let base = top.join("canonical");
        let root = top.join("root");
        let seed = top.join("seed");
        std::fs::create_dir_all(&base).unwrap();
        std::fs::create_dir_all(root.join(".legacy")).unwrap();
        let gateway = Self {
            _dir: dir,
            base,
            root,
            seed,
            project: Uuid::new_v4(),
        };
        git_in(
            &gateway.base,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                gateway.canonical().to_str().unwrap(),
            ],
        );
        git_in(
            gateway.seed.parent().unwrap(),
            &["init", "-q", "-b", "main", gateway.seed.to_str().unwrap()],
        );
        gateway
    }

    fn canonical(&self) -> PathBuf {
        self.base.join(format!("{}.git", self.project))
    }

    fn url(&self) -> String {
        format!("file://{}", self.canonical().display())
    }

    fn entry(&self) -> PathBuf {
        self.root.join(".legacy").join(self.project.to_string())
    }

    /// Commit `files` in the seed and push them to canonical `main`.
    fn publish(&self, files: &[(&str, Option<&str>)], message: &str) -> String {
        for (path, content) in files {
            let path = self.seed.join(path);
            match content {
                Some(text) => {
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    std::fs::write(path, text).unwrap();
                }
                None => std::fs::remove_file(path).unwrap(),
            }
        }
        let commit = commit_all(&self.seed, message);
        git_in(
            &self.seed,
            &[
                "push",
                "-q",
                self.canonical().to_str().unwrap(),
                "HEAD:main",
            ],
        );
        commit
    }

    /// A parked working copy of the stateful gateway at canonical `commit`.
    fn park_checkout_at(&self, commit: &str) -> PathBuf {
        let entry = self.entry();
        std::fs::create_dir_all(&entry).unwrap();
        init_workspace_repo(&entry);
        ig(
            &entry,
            &[
                "fetch",
                "-q",
                &self.url(),
                "+refs/heads/main:refs/remotes/origin/main",
            ],
        );
        ig(&entry, &["reset", "-q", "--hard", commit]);
        entry
    }

    fn salvage_mode_hook(&self, extra: &[(&str, &str)]) {
        let mut env = vec![("INSTAFY_GIT_SALVAGE_PUSH", "1")];
        env.extend_from_slice(extra);
        install_shard_hook(&self.canonical(), &env);
    }

    fn settings(&self, apply: bool, remove: bool, acks: &[&str]) -> Settings {
        Settings {
            root: self.root.clone(),
            node: NODE.to_string(),
            apply,
            remove,
            projects: Vec::new(),
            acks: acks.iter().map(|ack| ack.to_string()).collect(),
            remote_base: format!("file://{}", self.base.display()),
            identity: GitIdentity::new("instafy-origin", "gateway@instafy.dev"),
        }
    }

    fn salvage_refs(&self) -> BTreeMap<String, String> {
        git_in(
            &self.canonical(),
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/instafy/salvage",
            ],
        )
        .lines()
        .filter_map(|line| line.split_once(' '))
        .map(|(name, id)| (name.to_string(), id.to_string()))
        .collect()
    }
}

fn commit_all(dir: &Path, message: &str) -> String {
    git_in(dir, &["add", "-A"]);
    git_in(
        dir,
        &[
            "-c",
            "user.name=Seed",
            "-c",
            "user.email=seed@example.com",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            message,
        ],
    );
    git_in(dir, &["rev-parse", "HEAD"])
}

fn entry_commit(entry: &Path, message: &str) -> String {
    ig(
        entry,
        &[
            "-c",
            "user.name=Old gateway",
            "-c",
            "user.email=origin@instafy.dev",
            "commit",
            "-q",
            "-m",
            message,
        ],
    );
    ig(entry, &["rev-parse", "HEAD"])
}

fn write(path: &Path, content: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, content).unwrap();
}

fn salvage(settings: &Settings, stub: &Stub) -> (Summary, Vec<JsonValue>) {
    let mut out = Vec::new();
    let summary = run(settings, stub, &mut out).unwrap();
    let lines = String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    (summary, lines)
}

/// Every file below `dir` (links as their targets), the entry's own
/// repository left out.
fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(folder) = pending.pop() {
        for entry in std::fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            let relative = path
                .strip_prefix(dir)
                .unwrap()
                .to_string_lossy()
                .to_string();
            if relative == ".instafy/.git" {
                continue;
            }
            let metadata = std::fs::symlink_metadata(&path).unwrap();
            if metadata.file_type().is_symlink() {
                let target = std::fs::read_link(&path).unwrap();
                files.insert(relative, target.to_string_lossy().as_bytes().to_vec());
            } else if metadata.is_dir() {
                pending.push(path);
            } else {
                files.insert(relative, std::fs::read(&path).unwrap());
            }
        }
    }
    files
}

fn tar_listing(archive: &Path) -> Vec<String> {
    let output = std::process::Command::new("tar")
        .arg("-tf")
        .arg(archive)
        .output()
        .unwrap();
    assert!(output.status.success());
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::to_string)
        .collect()
}

fn paths(value: &JsonValue) -> Vec<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| match item {
            JsonValue::String(path) => path.clone(),
            other => other["path"].as_str().unwrap().to_string(),
        })
        .collect()
}

struct Diverged {
    c1: String,
    c3: String,
    leaked: String,
    local_commits: Vec<String>,
}

/// The gateway's checkout diverged from canonical: an old sync reset it
/// from C1 onto C2 without its files (so notes.md holds C1's version and
/// data.txt looks deleted), three local commits followed (one adds a
/// credential file, the next removes it), canonical moved on to C3, and the
/// work tree holds unsaved edits of every kind.
fn diverged_checkout(gateway: &Gateway) -> Diverged {
    let c1 = gateway.publish(
        &[
            ("README.md", Some("one\n")),
            ("notes.md", Some("v1\n")),
            (".gitignore", Some(".env\n*.log\n")),
        ],
        "c1",
    );
    let entry = gateway.park_checkout_at(&c1);
    gateway.publish(
        &[("notes.md", Some("v2\n")), ("data.txt", Some("data\n"))],
        "c2",
    );
    ig(
        &entry,
        &[
            "fetch",
            "-q",
            &gateway.url(),
            "+refs/heads/main:refs/remotes/origin/main",
        ],
    );
    ig(&entry, &["reset", "-q", "--mixed", "origin/main"]);

    write(&entry.join("local.md"), b"local work\n");
    ig(&entry, &["add", "local.md"]);
    let l1 = entry_commit(&entry, "Add local notes");
    write(&entry.join(".env.production"), b"API_KEY=leaked\n");
    ig(&entry, &["add", ".env.production"]);
    let l2 = entry_commit(&entry, "Add production settings");
    let leaked = ig(&entry, &["rev-parse", "HEAD:.env.production"]);
    ig(&entry, &["rm", "-q", ".env.production"]);
    let l3 = entry_commit(&entry, "Remove production settings");

    let c3 = gateway.publish(&[("README.md", Some("three\n"))], "c3");

    write(&entry.join("README.md"), b"edited\n");
    write(&entry.join("new.txt"), b"new\n");
    write(&entry.join(".env"), b"SECRET=1\n");
    write(&entry.join("debug.log"), b"log\n");
    write(&entry.join("tmp/big"), b"scratch\n");
    write(&entry.join("node_modules/pkg/index.js"), b"module\n");
    write(&entry.join("video.bin"), &vec![7u8; 25 * 1024 * 1024]);
    write(&entry.join("chat-upload-1700000000000-a.png"), PNG);
    Diverged {
        c1,
        c3,
        leaked,
        local_commits: vec![l1, l2, l3],
    }
}

#[test]
fn entry_names_are_the_parked_names() {
    let id = "0b7c2f10-58a4-4e6b-9f0e-2d1c3b4a5f60";
    let parsed = Uuid::parse_str(id).unwrap();
    assert_eq!(entry_project(id), Some(parsed));
    assert_eq!(
        entry_project(&format!("{id}-20261005T101500Z")),
        Some(parsed)
    );
    assert_eq!(
        entry_project(&format!("{id}-20261005T101500Z-2")),
        Some(parsed)
    );
    for other in [
        "",
        "notes",
        &id.to_uppercase(),
        &format!("{id}-"),
        &format!("{id}x"),
        &format!("{id}-a/b"),
        &format!("{id}-a b"),
    ] {
        assert_eq!(entry_project(other), None, "{other:?}");
    }
}

/// A dry run classifies and reports, and changes nothing anywhere: no push,
/// no credential for writing, no export, nothing under `.salvage/`, and not
/// one file of the entry's work tree.
#[test]
fn a_dry_run_reports_and_writes_nothing() {
    let gateway = Gateway::new();
    let diverged = diverged_checkout(&gateway);
    gateway.salvage_mode_hook(&[]);
    let before = snapshot(&gateway.entry());
    let stub = Stub::default();

    let (summary, lines) = salvage(&gateway.settings(false, false, &[]), &stub);

    assert_eq!(summary.entries, 1);
    assert!(summary.dry_run);
    assert_eq!(summary.exit_code(), 0);
    let report = &lines[0];
    assert_eq!(report["dryRun"], true);
    assert_eq!(report["inspected"], true);
    assert_eq!(report["clean"], false);
    assert_eq!(report["localOnlyCommits"], 3);
    assert_eq!(
        report["subjects"],
        serde_json::json!([
            "Remove production settings",
            "Add production settings",
            "Add local notes"
        ])
    );
    assert_eq!(paths(&report["stalePaths"]), ["data.txt", "notes.md"]);
    assert_eq!(paths(&report["archivedPaths"]), ["README.md", "new.txt"]);
    assert_eq!(report["historyFiltered"], true);
    assert_eq!(
        paths(&report["attachmentsToExport"]),
        ["chat-upload-1700000000000-a.png"]
    );
    assert!(report["salvageRef"]
        .as_str()
        .unwrap()
        .starts_with("refs/instafy/salvage/gateway/node-1-"));
    assert_eq!(report["canonicalVerified"], false);
    assert!(report["bundle"].is_null() && report["privateArchive"].is_null());

    assert_eq!(stub.salvage_tokens.get(), 0);
    assert!(stub.exports.borrow().is_empty());
    assert!(gateway.salvage_refs().is_empty());
    assert!(!gateway.root.join(".salvage").exists());
    assert_eq!(snapshot(&gateway.entry()), before);
    // The leaked blob stays local.
    assert!(!git_output(
        &gateway.canonical(),
        &["cat-file", "-e", &diverged.leaked],
        None
    )
    .status
    .success());
}

/// The full salvage of a diverged checkout: one filtered commit on the last
/// shared commit reaches canonical, under the node's create-only ref; the
/// credential file a local commit added and the next removed never does;
/// stale copies stay out; private files, the bundle and the report are
/// written; the chat image is exported. A rerun changes nothing, and removal
/// needs an acknowledgement because paths outside build output were skipped.
#[test]
fn a_diverged_checkout_is_salvaged_once_and_kept_private_where_it_must() {
    let gateway = Gateway::new();
    let diverged = diverged_checkout(&gateway);
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (summary, lines) = salvage(&gateway.settings(true, false, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(summary.verified, 1, "{report:#}");
    assert_eq!(report["canonicalVerified"], true);
    assert_eq!(report["historyFiltered"], true);
    assert_eq!(report["clean"], false);

    // The ref: create-only, named by node and commit, at a filtered commit.
    let reference = report["salvageRef"].as_str().unwrap().to_string();
    let salvaged = report["salvageRev"].as_str().unwrap().to_string();
    assert_eq!(
        reference,
        format!("refs/instafy/salvage/gateway/{NODE}-{}", &salvaged[..8])
    );
    assert_eq!(
        gateway.salvage_refs(),
        BTreeMap::from([(reference.clone(), salvaged.clone())])
    );
    let canonical = gateway.canonical();
    let show = |spec: &str| git_in(&canonical, &["show", spec]);
    assert_eq!(show(&format!("{salvaged}:README.md")), "edited");
    assert_eq!(show(&format!("{salvaged}:new.txt")), "new");
    assert_eq!(show(&format!("{salvaged}:local.md")), "local work");
    // Stale copies keep HEAD's versions.
    assert_eq!(show(&format!("{salvaged}:notes.md")), "v2");
    assert_eq!(show(&format!("{salvaged}:data.txt")), "data");
    // One commit on the last shared commit (C2), by the gateway, at HEAD's
    // commit date.
    let parents = git_in(&canonical, &["rev-list", "--parents", "-n", "1", &salvaged]);
    let parent = parents.split(' ').nth(1).unwrap().to_string();
    assert_eq!(
        parent,
        git_in(&canonical, &["rev-parse", &format!("{}~1", diverged.c3)])
    );
    let tree_paths = git_in(&canonical, &["ls-tree", "-r", "--name-only", &salvaged]);
    for absent in [
        ".env",
        ".env.production",
        "debug.log",
        "tmp/big",
        "video.bin",
        "node_modules/pkg/index.js",
        "chat-upload-1700000000000-a.png",
    ] {
        assert!(!tree_paths.lines().any(|path| path == absent), "{absent}");
    }
    let message = git_in(&canonical, &["log", "-1", "--format=%B", &salvaged]);
    assert!(message.starts_with("Keep unsaved edits from the retired file gateway"));
    for line in [
        "Instafy-Recovery-Kind: salvage",
        "Instafy-Path: README.md",
        "Instafy-Path: local.md",
        "Instafy-Path: new.txt",
        "Instafy-Private-Path: secret .env",
        "Instafy-Private-Path: ignored debug.log",
    ] {
        assert!(
            message.lines().any(|text| text == line),
            "{line}: {message}"
        );
    }
    assert_eq!(
        git_in(
            &canonical,
            &["log", "-1", "--format=%an <%ae> %cn <%ce>", &salvaged]
        ),
        "instafy-origin <gateway@instafy.dev> instafy-origin <gateway@instafy.dev>"
    );
    assert_eq!(
        git_in(&canonical, &["log", "-1", "--format=%ct", &salvaged]),
        ig(
            &gateway.entry(),
            &["log", "-1", "--format=%ct", &diverged.local_commits[2]]
        )
    );
    // Neither the credential nor the local commits that held it reached
    // canonical.
    for object in [&diverged.leaked, &diverged.local_commits[1]] {
        assert!(
            !git_output(&canonical, &["cat-file", "-e", object], None)
                .status
                .success(),
            "{object}"
        );
    }

    // Skipped and private paths.
    let skipped: BTreeMap<String, String> = report["skippedPaths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["path"].as_str().unwrap().to_string(),
                item["reason"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        skipped,
        BTreeMap::from([
            (
                "node_modules/pkg/index.js".to_string(),
                "excluded".to_string()
            ),
            ("tmp/big".to_string(), "excluded".to_string()),
            ("video.bin".to_string(), "too_large".to_string()),
        ])
    );
    let video = report["skippedPaths"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["path"] == "video.bin")
        .unwrap();
    assert_eq!(video["size"], 25 * 1024 * 1024);
    let private: Vec<(String, String, Option<String>)> = report["privateArchivedPaths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["path"].as_str().unwrap().to_string(),
                item["reason"].as_str().unwrap().to_string(),
                item["commit"].as_str().map(str::to_string),
            )
        })
        .collect();
    assert_eq!(
        private,
        vec![
            (".env".to_string(), "secret".to_string(), None),
            ("debug.log".to_string(), "ignored".to_string(), None),
            (
                ".env.production".to_string(),
                "secret".to_string(),
                Some(diverged.local_commits[1].clone())
            ),
        ]
    );
    let archive = PathBuf::from(report["privateArchive"].as_str().unwrap());
    assert_eq!(
        archive,
        gateway
            .root
            .join(".salvage")
            .join(format!("{}.private.tar", gateway.project))
    );
    assert_eq!(
        tar_listing(&archive),
        vec![
            "worktree/.env".to_string(),
            "worktree/debug.log".to_string(),
            format!("history/{}/.env.production", diverged.local_commits[1]),
        ]
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        for path in [&archive, &gateway.root.join(".salvage")] {
            let mode = std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert!(mode == 0o600 || mode == 0o700, "{path:?} {mode:o}");
        }
    }

    // The chat image went to the controller as it is.
    assert_eq!(
        *stub.exports.borrow(),
        vec![("chat-upload-1700000000000-a.png".to_string(), PNG.to_vec())]
    );
    assert_eq!(
        report["exportedAttachments"][0]["path"],
        "chat-upload-1700000000000-a.png"
    );

    // The bundle holds the local history, the unfiltered one included.
    let bundle = PathBuf::from(report["bundle"].as_str().unwrap());
    let heads = git_in(
        &gateway.entry(),
        &["bundle", "list-heads", bundle.to_str().unwrap()],
    );
    assert!(
        heads.contains(&format!("{salvaged} {reference}")),
        "{heads}"
    );
    assert!(heads.contains("refs/instafy/salvage-local/head"), "{heads}");
    assert!(heads.contains("refs/instafy/salvage-local/work"), "{heads}");

    let journal = std::fs::read_to_string(gateway.root.join(".salvage/report.jsonl")).unwrap();
    assert_eq!(journal.lines().count(), 1);
    assert_eq!(stub.salvage_tokens.get(), 1);

    // A rerun: the same ref, found and verified, with nothing pushed or
    // archived twice.
    let (_, again) = salvage(&gateway.settings(true, false, &[]), &stub);
    assert!(again[0]["error"].is_null(), "{:#}", again[0]);
    assert_eq!(again[0]["salvageRef"], reference.as_str());
    assert_eq!(again[0]["salvageRev"], salvaged.as_str());
    assert_eq!(again[0]["canonicalVerified"], true);
    assert_eq!(stub.salvage_tokens.get(), 1);
    assert_eq!(gateway.salvage_refs().len(), 1);
    assert_eq!(again[0]["privateArchive"], archive.to_str().unwrap());
    let kept: Vec<String> = std::fs::read_dir(gateway.root.join(".salvage"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".tar"))
        .collect();
    assert_eq!(kept.len(), 1, "{kept:?}");

    // Removing needs an acknowledgement: paths outside build output were
    // left out.
    let (summary, refused) = salvage(&gateway.settings(true, true, &[]), &stub);
    assert_eq!(summary.exit_code(), 1);
    assert!(refused[0]["removeRefused"]
        .as_str()
        .unwrap()
        .contains("outside build output"));
    assert!(gateway.entry().exists());

    let entry_name = gateway.project.to_string();
    let (summary, removed) = salvage(&gateway.settings(true, true, &[&entry_name]), &stub);
    assert_eq!(summary.exit_code(), 0, "{:#}", removed[0]);
    assert_eq!(removed[0]["removed"], true);
    assert!(!gateway.entry().exists());
    // The bundle goes once the ref is verified; the private archive and the
    // ref stay.
    assert_eq!(removed[0]["bundleRemoved"], true);
    assert!(!bundle.exists());
    assert!(archive.exists());
    assert_eq!(gateway.salvage_refs().len(), 1);
    assert!(diverged.c1.len() == 40);
}

/// A checkout with nothing canonical lacks is clean: no ref, its ignored
/// files in the private archive, and it is removed without an
/// acknowledgement.
#[test]
fn a_clean_checkout_keeps_its_ignored_files_and_is_removed() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(
        &[("README.md", Some("one\n")), (".gitignore", Some(".env\n"))],
        "c1",
    );
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join(".env"), b"SECRET=1\n");
    write(&entry.join("dist/app.js"), b"built\n");
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (summary, lines) = salvage(&gateway.settings(true, true, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(report["clean"], true, "{report:#}");
    assert_eq!(report["removed"], true);
    assert_eq!(summary.exit_code(), 0);
    assert!(report["salvageRef"].is_null());
    assert!(report["bundle"].is_null());
    assert_eq!(stub.salvage_tokens.get(), 0);
    assert!(gateway.salvage_refs().is_empty());
    let archive = PathBuf::from(report["privateArchive"].as_str().unwrap());
    assert_eq!(tar_listing(&archive), vec!["worktree/.env".to_string()]);
    // Build output is reported but never holds a removal up.
    assert_eq!(
        report["skippedPaths"],
        serde_json::json!([{ "path": "dist/app.js", "size": 6, "reason": "excluded" }])
    );
    assert!(!entry.exists());
}

/// One run at a time: a run with --apply stops while another holds the lock.
#[test]
fn a_second_salvage_does_not_run_while_one_holds_the_lock() {
    use fs2::FileExt as _;
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    gateway.park_checkout_at(&c1);
    std::fs::create_dir(gateway.root.join(".salvage")).unwrap();
    let held = std::fs::File::create(gateway.root.join(".salvage/.lock")).unwrap();
    held.lock_exclusive().unwrap();
    let stub = Stub::default();
    let mut out = Vec::new();
    let error = run(&gateway.settings(true, false, &[]), &stub, &mut out)
        .unwrap_err()
        .to_string();
    assert!(error.contains("another salvage"), "{error}");
    assert!(out.is_empty());
    assert_eq!(stub.read_tokens.get(), 0);
    // A dry run takes no lock.
    let (summary, _) = salvage(&gateway.settings(false, false, &[]), &stub);
    assert_eq!(summary.entries, 1);
    held.unlock().unwrap();
}

/// Without a canonical repository nothing is pushed; the bundle holds the
/// whole history, and removal needs an acknowledgement.
#[test]
fn a_space_without_a_canonical_repository_gets_a_full_bundle() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("README.md"), b"edited\n");
    std::fs::remove_dir_all(gateway.canonical()).unwrap();
    let stub = Stub::default();

    let (summary, lines) = salvage(&gateway.settings(true, true, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(report["canonicalMissing"], true);
    assert_eq!(report["clean"], false);
    assert!(report["salvageRef"].is_null());
    assert!(report["removeRefused"]
        .as_str()
        .unwrap()
        .contains("no canonical repository"));
    assert_eq!(summary.exit_code(), 1);
    assert_eq!(stub.salvage_tokens.get(), 0);
    let bundle = report["bundle"].as_str().unwrap();
    let heads = git_in(&entry, &["bundle", "list-heads", bundle]);
    assert!(
        heads.contains(&format!("{c1} refs/instafy/salvage-local/head")),
        "{heads}"
    );
    assert!(heads.contains("refs/instafy/salvage-local/work"), "{heads}");
    // A full bundle: an empty repository can read it.
    let empty = gateway.root.parent().unwrap().join("empty");
    git_in(
        gateway.root.parent().unwrap(),
        &["init", "-q", empty.to_str().unwrap()],
    );
    let verify = git_output(&empty, &["bundle", "verify", bundle], None);
    assert!(
        verify.status.success(),
        "{}",
        String::from_utf8_lossy(&verify.stderr)
    );
    assert!(entry.exists());
}

/// An old layout's `.git` is moved inside the entry only with `--apply`.
#[test]
fn a_plain_git_layout_is_moved_inside_the_entry_with_apply_only() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = gateway.entry();
    git_in(
        entry.parent().unwrap(),
        &["clone", "-q", &gateway.url(), entry.to_str().unwrap()],
    );
    write(&entry.join("README.md"), b"edited\n");
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (_, lines) = salvage(&gateway.settings(false, false, &[]), &stub);
    assert_eq!(lines[0]["legacyLayout"], true);
    assert_eq!(lines[0]["inspected"], false);
    assert!(entry.join(".git").is_dir());
    assert!(!entry.join(".instafy").exists());

    let (_, lines) = salvage(&gateway.settings(true, false, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(report["legacyLayout"], true);
    assert_eq!(report["canonicalVerified"], true);
    assert_eq!(report["head"], c1.as_str());
    assert!(!entry.join(".git").exists());
    assert!(entry.join(".instafy/.git/HEAD").is_file());
    let salvaged = report["salvageRev"].as_str().unwrap();
    assert_eq!(
        git_in(
            &gateway.canonical(),
            &["show", &format!("{salvaged}:README.md")]
        ),
        "edited"
    );
}

/// A parked link is never followed, read or written through, and only an
/// acknowledgement removes it (the link, never its target).
#[cfg(unix)]
#[test]
fn a_parked_link_is_never_followed() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    // A real checkout elsewhere, which the link names.
    let elsewhere = gateway.root.parent().unwrap().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    init_workspace_repo(&elsewhere);
    ig(
        &elsewhere,
        &[
            "fetch",
            "-q",
            &gateway.url(),
            "+refs/heads/main:refs/remotes/origin/main",
        ],
    );
    ig(&elsewhere, &["reset", "-q", "--hard", &c1]);
    write(&elsewhere.join("README.md"), b"edited elsewhere\n");
    std::os::unix::fs::symlink(&elsewhere, gateway.entry()).unwrap();
    let before = snapshot(&elsewhere);
    let git_before = snapshot(&elsewhere.join(".instafy/.git"));
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (summary, lines) = salvage(&gateway.settings(true, true, &[]), &stub);
    let report = &lines[0];
    assert_eq!(report["linkEntry"], elsewhere.to_str().unwrap());
    assert_eq!(report["inspected"], false);
    assert!(report["removeRefused"].as_str().unwrap().contains("link"));
    assert_eq!(summary.exit_code(), 1);
    assert_eq!(stub.read_tokens.get(), 0);
    assert!(gateway.salvage_refs().is_empty());
    assert_eq!(snapshot(&elsewhere), before);
    assert_eq!(snapshot(&elsewhere.join(".instafy/.git")), git_before);

    let entry_name = gateway.project.to_string();
    let (_, lines) = salvage(&gateway.settings(true, true, &[&entry_name]), &stub);
    assert_eq!(lines[0]["removed"], true);
    assert!(std::fs::symlink_metadata(gateway.entry()).is_err());
    assert_eq!(snapshot(&elsewhere), before);
}

/// Without a usable repository every file goes to the private archive,
/// links as links; a repository that points git at other objects counts as
/// unusable.
#[cfg(unix)]
#[test]
fn files_without_a_usable_repository_go_to_the_private_archive() {
    let gateway = Gateway::new();
    let entry = gateway.entry();
    write(&entry.join("notes.md"), b"draft\n");
    write(&entry.join("sub/deep.txt"), b"deep\n");
    std::os::unix::fs::symlink("/etc/passwd", entry.join("sub/link")).unwrap();
    let stub = Stub::default();

    let (_, lines) = salvage(&gateway.settings(true, true, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(report["noRepository"], true);
    assert!(report["removeRefused"]
        .as_str()
        .unwrap()
        .contains("no usable repository"));
    let archive = PathBuf::from(report["privateArchive"].as_str().unwrap());
    let mut listing = tar_listing(&archive);
    listing.sort();
    assert_eq!(
        listing,
        vec![
            "worktree/notes.md".to_string(),
            "worktree/sub/deep.txt".to_string(),
            "worktree/sub/link".to_string(),
        ]
    );
    // The link was stored as a link: the archive holds its target's name,
    // not the file it names.
    let verbose = std::process::Command::new("tar")
        .arg("-tvf")
        .arg(&archive)
        .output()
        .unwrap();
    let verbose = String::from_utf8_lossy(&verbose.stdout);
    assert!(verbose.contains("sub/link -> /etc/passwd"), "{verbose}");

    // A repository with an alternates file is never run.
    let other = Gateway::new();
    let c1 = other.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = other.park_checkout_at(&c1);
    write(&entry.join("README.md"), b"edited\n");
    write(
        &entry.join(".instafy/.git/objects/info/alternates"),
        b"/somewhere/else/objects\n",
    );
    let (_, lines) = salvage(&other.settings(true, false, &[]), &stub);
    assert_eq!(lines[0]["noRepository"], true, "{:#}", lines[0]);
    assert!(lines[0]["notes"][0]
        .as_str()
        .unwrap()
        .contains("objects/info/alternates"));
    assert!(other.salvage_refs().is_empty());
}

/// An existing salvage ref with another tip stops the entry before any
/// push; the bundle and private archive are still written.
#[test]
fn a_salvage_ref_with_another_tip_stops_the_entry() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(
        &[("README.md", Some("one\n")), (".gitignore", Some(".env\n"))],
        "c1",
    );
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("README.md"), b"edited\n");
    write(&entry.join(".env"), b"SECRET=1\n");
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();
    let (_, dry) = salvage(&gateway.settings(false, false, &[]), &stub);
    let reference = dry[0]["salvageRef"].as_str().unwrap().to_string();
    git_in(&gateway.canonical(), &["update-ref", &reference, &c1]);

    let (summary, lines) = salvage(&gateway.settings(true, false, &[]), &stub);
    let report = &lines[0];
    let error = report["error"].as_str().unwrap();
    assert!(
        error.contains("already names") && error.contains(&c1),
        "{error}"
    );
    assert_eq!(summary.errors, 1);
    assert_eq!(stub.salvage_tokens.get(), 0);
    assert_eq!(gateway.salvage_refs()[&reference], c1);
    assert!(gateway
        .root
        .join(".salvage")
        .join(format!("{}.bundle", gateway.project))
        .is_file());
    assert!(gateway
        .root
        .join(".salvage")
        .join(format!("{}.private.tar", gateway.project))
        .is_file());
}

/// A refusal the hook marks as a salvage refusal is final: one push, no
/// retry, the error reported.
#[test]
fn a_salvage_refusal_is_never_retried() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("README.md"), b"edited\n");
    // The shard's hook without the salvage credential refuses every change
    // to a salvage ref.
    install_shard_hook(&gateway.canonical(), &[]);
    let stub = Stub::default();

    let (summary, lines) = salvage(&gateway.settings(true, false, &[]), &stub);
    let error = lines[0]["error"].as_str().unwrap();
    assert!(error.contains("refused"), "{error}");
    assert_eq!(summary.errors, 1);
    assert_eq!(stub.salvage_tokens.get(), 1);
    assert!(gateway.salvage_refs().is_empty());
}

/// A path the shard's own deny list refuses is left as `main` has it and the
/// push is tried again; the path is reported.
#[test]
fn a_path_the_shard_refuses_is_left_out_and_the_push_retried() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("README.md"), b"edited\n");
    write(&entry.join("export.zip"), b"zip\n");
    gateway.salvage_mode_hook(&[("GIT_DENY_PATHS", "*.zip")]);
    let stub = Stub::default();

    let (_, lines) = salvage(&gateway.settings(true, false, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(report["canonicalVerified"], true);
    assert_eq!(stub.salvage_tokens.get(), 2);
    let skipped: Vec<(String, String)> = report["skippedPaths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["path"].as_str().unwrap().to_string(),
                item["reason"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(
        skipped,
        vec![("export.zip".to_string(), "policy".to_string())]
    );
    let salvaged = report["salvageRev"].as_str().unwrap();
    let listed = git_in(
        &gateway.canonical(),
        &["ls-tree", "-r", "--name-only", salvaged],
    );
    assert!(listed.lines().any(|path| path == "README.md"));
    assert!(!listed.lines().any(|path| path == "export.zip"));
    assert_eq!(gateway.salvage_refs().len(), 1);
}

/// A chat image the controller cannot take stays in the private archive;
/// work only the project-memory bootstrap wrote is marked as such.
#[test]
fn unexported_images_are_archived_and_bootstrap_work_is_marked() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("AGENTS.md"), b"agents\n");
    write(
        &entry.join(".agents/skills/instafy-secrets/SKILL.md"),
        b"skill\n",
    );
    ig(&entry, &["add", "-A"]);
    entry_commit(&entry, "instafy: bootstrap project memory");
    write(&entry.join("chat-upload-1-b.png"), PNG);
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();
    stub.keep_exports.set(true);

    let (_, lines) = salvage(&gateway.settings(true, false, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(report["bootstrapOnly"], true);
    assert_eq!(report["canonicalVerified"], true);
    assert_eq!(stub.exports.borrow().len(), 1);
    assert!(report["exportedAttachments"].as_array().unwrap().is_empty());
    let archive = PathBuf::from(report["privateArchive"].as_str().unwrap());
    assert_eq!(
        tar_listing(&archive),
        vec!["worktree/chat-upload-1-b.png".to_string()]
    );
    assert!(report["notes"][0]
        .as_str()
        .unwrap()
        .contains("chat-upload-1-b.png was not exported"));
}

/// A credential file `main` itself holds and changed after the shared
/// commit: the filtered commit carries `main`'s version, which is no leak,
/// and the local version stays in the private archive.
#[test]
fn a_credential_main_itself_changed_is_filtered_once() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(
        &[("README.md", Some("one\n")), (".npmrc", Some("v1\n"))],
        "c1",
    );
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join(".npmrc"), b"local-secret\n");
    write(&entry.join("notes.md"), b"notes\n");
    ig(&entry, &["add", "-A"]);
    let local = entry_commit(&entry, "Local settings");
    let local_secret = ig(&entry, &["rev-parse", "HEAD:.npmrc"]);
    let c2 = gateway.publish(&[(".npmrc", Some("v2\n"))], "c2");
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (_, lines) = salvage(&gateway.settings(true, false, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(report["historyFiltered"], true);
    assert_eq!(report["canonicalVerified"], true);
    let salvaged = report["salvageRev"].as_str().unwrap();
    let canonical = gateway.canonical();
    assert_eq!(
        git_in(&canonical, &["show", &format!("{salvaged}:.npmrc")]),
        git_in(&canonical, &["show", &format!("{c2}:.npmrc")])
    );
    assert_eq!(
        git_in(&canonical, &["show", &format!("{salvaged}:notes.md")]),
        "notes"
    );
    assert!(
        !git_output(&canonical, &["cat-file", "-e", &local_secret], None)
            .status
            .success()
    );
    let archive = PathBuf::from(report["privateArchive"].as_str().unwrap());
    assert_eq!(
        tar_listing(&archive),
        vec![format!("history/{local}/.npmrc")]
    );
}
