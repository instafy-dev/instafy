//! The salvage against real git: a bare canonical repository with the
//! shard's own update hook (in salvage mode where a test says so), parked
//! working copies under `.legacy/`, and stub controller services.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value as JsonValue;
use uuid::Uuid;

use super::options::Settings;
use super::services::{interpret_export, ExportOutcome, ExportedTo, Services};
use super::{entry_project, run, Summary};
use crate::test_support::{
    git_in, git_output, ig, init_workspace_repo, install_shard_hook, GitWrapper,
};
use crate::workspace_git::GitIdentity;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDRchat";
const NODE: &str = "node-1";

/// The controller, as the salvage sees it.
#[derive(Default)]
struct Stub {
    read_mints: Cell<usize>,
    salvage_mints: Cell<usize>,
    exports: RefCell<Vec<(String, Vec<u8>)>>,
    /// The controller's answer to each export (status and body), read the
    /// way the salvage reads it; `None` exports to one conversation.
    export_answer: RefCell<Option<(u16, JsonValue)>>,
    /// Runs before each `git.read` mint.
    on_read_mint: RefCell<Option<Box<dyn FnMut()>>>,
}

impl Services for Stub {
    fn mint_read(&self, _project: &Uuid) -> anyhow::Result<Option<String>> {
        self.read_mints.set(self.read_mints.get() + 1);
        if let Some(hook) = self.on_read_mint.borrow_mut().as_mut() {
            hook();
        }
        // A local remote ignores the header; tests that log git's arguments
        // see which credential each command carried.
        Ok(Some(format!("read-{}", self.read_mints.get())))
    }

    fn mint_salvage(&self, _project: &Uuid) -> anyhow::Result<String> {
        self.salvage_mints.set(self.salvage_mints.get() + 1);
        Ok("salvage-1".to_string())
    }

    fn export_attachment(&self, project: &Uuid, path: &str, bytes: Vec<u8>) -> ExportOutcome {
        self.exports.borrow_mut().push((path.to_string(), bytes));
        if let Some((status, body)) = self.export_answer.borrow().as_ref() {
            return interpret_export(*status, body);
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
        exclude_own_repository(&entry);
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
            // The tests' disk may be nearly full; one test sets a floor.
            min_free_bytes: 0,
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

/// git 2.34 (the oldest the origin supports) takes the layout's own
/// `.instafy` repository as an embedded repository on `add -A` once HEAD
/// has a commit, and records it as a gitlink; newer git leaves it out. The
/// fixtures' local commits must hold the same paths on both.
fn exclude_own_repository(entry: &Path) {
    use std::io::Write as _;
    let mut exclude = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(entry.join(".instafy/.git/info/exclude"))
        .unwrap();
    exclude.write_all(b"/.instafy/\n").unwrap();
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

    assert_eq!(stub.salvage_mints.get(), 0);
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
    // .env, debug.log, and the local commit's .env.production.
    assert_eq!(
        report["privateArchiveBytes"],
        "SECRET=1\n".len() + "log\n".len() + "API_KEY=leaked\n".len()
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
    assert_eq!(stub.salvage_mints.get(), 1);

    // A rerun: the same ref, found and verified, with nothing pushed or
    // archived twice.
    let (_, again) = salvage(&gateway.settings(true, false, &[]), &stub);
    assert!(again[0]["error"].is_null(), "{:#}", again[0]);
    assert_eq!(again[0]["salvageRef"], reference.as_str());
    assert_eq!(again[0]["salvageRev"], salvaged.as_str());
    assert_eq!(again[0]["canonicalVerified"], true);
    assert_eq!(stub.salvage_mints.get(), 1);
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
    // The bundle stays (canonical has the filtered commit, not the local
    // history), and so do the private archive and the ref.
    assert_eq!(removed[0]["bundleRemoved"], false);
    assert!(bundle.exists());
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
    assert_eq!(stub.salvage_mints.get(), 0);
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
    assert_eq!(stub.read_mints.get(), 0);
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
    assert_eq!(stub.salvage_mints.get(), 0);
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
    assert_eq!(stub.read_mints.get(), 0);
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

    // Nor one whose replacement refs would make the history checks read
    // other objects than a push sends.
    let replaced = Gateway::new();
    let c1 = replaced.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = replaced.park_checkout_at(&c1);
    write(&entry.join(".env.local"), b"KEY=1\n");
    ig(&entry, &["add", "-f", ".env.local"]);
    let settings_commit = entry_commit(&entry, "settings");
    let blob = ig(&entry, &["rev-parse", "HEAD:.env.local"]);
    let harmless = ig(&entry, &["hash-object", "-w", "--stdin"]);
    ig(&entry, &["replace", &blob, &harmless]);
    ig(&entry, &["pack-refs", "--all"]);
    // Only in packed-refs now, so the packed form is what is checked.
    let _ = std::fs::remove_dir(entry.join(".instafy/.git/refs/replace"));
    assert!(!entry.join(".instafy/.git/refs/replace").exists());
    let (_, lines) = salvage(&replaced.settings(true, false, &[]), &stub);
    assert_eq!(lines[0]["noRepository"], true, "{:#}", lines[0]);
    assert!(lines[0]["notes"][0]
        .as_str()
        .unwrap()
        .contains("replacement refs"));
    assert!(replaced.salvage_refs().is_empty());
    assert!(settings_commit.len() == 40);
}

/// `git --version` as (major, minor).
fn git_version() -> (u32, u32) {
    let text = git_in(Path::new("."), &["--version"]);
    let mut numbers = text
        .split_whitespace()
        .nth(2)
        .unwrap_or_default()
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0));
    (numbers.next().unwrap_or(0), numbers.next().unwrap_or(0))
}

/// The salvage's git handle reads the objects a push sends: a replacement
/// ref, wherever the ref storage keeps it, changes nothing it reads.
#[test]
fn the_salvage_handle_reads_the_objects_a_push_sends() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    init_workspace_repo(&root);
    write(&root.join(".env.local"), b"KEY=1\n");
    let blob = ig(&root, &["hash-object", "-w", ".env.local"]);
    let harmless = git_output(
        &root,
        &["--git-dir", ".instafy/.git", "hash-object", "-w", "--stdin"],
        Some(b"nothing\n"),
    );
    let harmless = String::from_utf8_lossy(&harmless.stdout).trim().to_string();
    ig(&root, &["replace", &blob, &harmless]);
    // Plain git reads the replacement.
    assert_eq!(ig(&root, &["cat-file", "-p", &blob]), "nothing");
    let git = super::repository::entry_git(&root, None);
    assert_eq!(git.stdout(&["cat-file", "-p", &blob]).unwrap(), "KEY=1");
}

/// Every git handle the salvage makes comes from `entry_git`, so none reads
/// replaced objects.
#[test]
fn every_salvage_git_handle_ignores_replacement_refs() {
    for (name, source) in [
        ("salvage.rs", include_str!("../salvage.rs")),
        ("canonical.rs", include_str!("canonical.rs")),
        ("classify.rs", include_str!("classify.rs")),
        ("journal.rs", include_str!("journal.rs")),
        ("options.rs", include_str!("options.rs")),
        ("outputs.rs", include_str!("outputs.rs")),
        ("repository.rs", include_str!("repository.rs")),
        ("services.rs", include_str!("services.rs")),
        ("work.rs", include_str!("work.rs")),
    ] {
        let expected = usize::from(name == "repository.rs");
        assert_eq!(
            source.matches("WorkspaceGit::new(").count(),
            expected,
            "{name} must make its git handles with entry_git"
        );
    }
}

/// A replacement ref that only reftable storage holds (no `refs/replace`
/// folder, no `packed-refs`) never hides a local commit's credential from
/// the history check: the checks read the commit a push sends.
#[test]
fn replacement_refs_in_reftable_storage_never_hide_history() {
    let version = git_version();
    if version < (2, 45) {
        // reftable storage came with git 2.45; the handle test above covers
        // every git.
        eprintln!("git {version:?} has no reftable storage; nothing to check here");
        return;
    }
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = gateway.entry();
    std::fs::create_dir_all(entry.join(".instafy")).unwrap();
    git_in(
        &entry,
        &[
            "--git-dir",
            ".instafy/.git",
            "--work-tree",
            ".",
            "init",
            "-q",
            "-b",
            "main",
            "--ref-format=reftable",
        ],
    );
    ig(&entry, &["config", "user.name", "Fixture"]);
    ig(&entry, &["config", "user.email", "fixture@instafy.dev"]);
    std::fs::create_dir_all(entry.join(".instafy/.git/info")).unwrap();
    exclude_own_repository(&entry);
    ig(
        &entry,
        &[
            "fetch",
            "-q",
            &gateway.url(),
            "+refs/heads/main:refs/remotes/origin/main",
        ],
    );
    ig(&entry, &["reset", "-q", "--hard", &c1]);
    write(&entry.join("app.js"), b"app\n");
    write(&entry.join(".env.production"), b"SECRET=hunter2\n");
    ig(&entry, &["add", "-A"]);
    let leaking = entry_commit(&entry, "Add the app");
    let env_blob = ig(&entry, &["hash-object", ".env.production"]);
    // The same commit without the credential, as a replacement.
    let listing = ig(&entry, &["ls-tree", &leaking]);
    let kept: String = listing
        .lines()
        .filter(|line| !line.ends_with("\t.env.production"))
        .map(|line| format!("{line}\n"))
        .collect();
    let tree = git_output(
        &entry,
        &["--git-dir", ".instafy/.git", "mktree"],
        Some(kept.as_bytes()),
    );
    let tree = String::from_utf8_lossy(&tree.stdout).trim().to_string();
    let replacement = ig(
        &entry,
        &["commit-tree", &tree, "-p", &c1, "-m", "Add the app"],
    );
    ig(&entry, &["replace", &leaking, &replacement]);
    let git_dir = entry.join(".instafy/.git");
    assert!(git_dir.join("reftable").is_dir());
    assert!(!git_dir.join("refs/replace").exists());
    assert!(!git_dir.join("packed-refs").exists());
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (_, lines) = salvage(&gateway.settings(true, false, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(report["noRepository"], false, "{report:#}");
    assert_eq!(report["historyFiltered"], true, "{report:#}");
    assert_eq!(report["canonicalVerified"], true, "{report:#}");
    let canonical = gateway.canonical();
    let salvaged = report["salvageRev"].as_str().unwrap();
    let listed = git_in(&canonical, &["ls-tree", "-r", "--name-only", salvaged]);
    assert!(listed.lines().any(|path| path == "app.js"), "{listed}");
    assert!(
        !listed.lines().any(|path| path == ".env.production"),
        "{listed}"
    );
    for object in [&env_blob, &leaking] {
        assert!(
            !git_output(&canonical, &["cat-file", "-e", object], None)
                .status
                .success(),
            "{object} reached canonical"
        );
    }
    let archive = PathBuf::from(report["privateArchive"].as_str().unwrap());
    assert_eq!(
        tar_listing(&archive),
        vec![format!("history/{leaking}/.env.production")]
    );
}

/// A writer whose reader went away: every write fails as a closed pipe's
/// does (the operator's `docker exec` session ended, or `| head` stopped
/// reading).
struct ClosedPipe;

impl std::io::Write for ClosedPipe {
    fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
        Err(std::io::ErrorKind::BrokenPipe.into())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Err(std::io::ErrorKind::BrokenPipe.into())
    }
}

/// Each entry's line goes to stdout and to `report.jsonl`, whatever the
/// other does: when either cannot take it, the other still has it, and the
/// run stops before the next entry with an error naming the entry. A
/// journal that cannot be opened for appending stops the run before the
/// first entry.
#[test]
fn a_report_line_is_never_lost_when_one_of_its_sinks_fails() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("README.md"), b"edited\n");
    let second = gateway
        .root
        .join(".legacy")
        .join(format!("{}-20261005T000000Z", gateway.project));
    write(&second.join("notes.md"), b"draft\n");
    gateway.salvage_mode_hook(&[]);
    let journal = gateway.root.join(".salvage/report.jsonl");
    let stub = Stub::default();
    let broken = journal.clone();
    *stub.on_read_mint.borrow_mut() = Some(Box::new(move || {
        // The disk fills while the first entry is handled.
        let _ = std::fs::remove_file(&broken);
        let _ = std::fs::create_dir_all(&broken);
    }));

    let mut out = Vec::new();
    let error = run(&gateway.settings(true, true, &[]), &stub, &mut out)
        .unwrap_err()
        .to_string();
    let lines: Vec<JsonValue> = String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), 1, "{error}");
    assert_eq!(lines[0]["entry"], gateway.project.to_string());
    assert_eq!(lines[0]["removed"], true, "{:#}", lines[0]);
    assert!(error.contains("report.jsonl"), "{error}");
    assert!(error.contains(&gateway.project.to_string()), "{error}");
    assert!(!entry.exists());
    assert_eq!(gateway.salvage_refs().len(), 1);
    // The next entry was never touched.
    assert!(second.join("notes.md").is_file());
    assert!(!gateway
        .root
        .join(".salvage")
        .join(format!("{}-20261005T000000Z.private.tar", gateway.project))
        .exists());

    // Stdout closes while the first entry is handled: its line still
    // reaches the journal, and the run stops before the next entry.
    let closed = Gateway::new();
    let c1 = closed.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = closed.park_checkout_at(&c1);
    write(&entry.join("README.md"), b"edited\n");
    let second = closed
        .root
        .join(".legacy")
        .join(format!("{}-20261005T000000Z", closed.project));
    write(&second.join("notes.md"), b"draft\n");
    closed.salvage_mode_hook(&[]);
    let stub = Stub::default();
    let error = run(&closed.settings(true, true, &[]), &stub, &mut ClosedPipe)
        .unwrap_err()
        .to_string();
    let journaled: Vec<JsonValue> =
        std::fs::read_to_string(closed.root.join(".salvage/report.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
    assert_eq!(journaled.len(), 1, "{error}");
    assert_eq!(journaled[0]["entry"], closed.project.to_string());
    assert_eq!(journaled[0]["removed"], true, "{:#}", journaled[0]);
    let refs = closed.salvage_refs();
    assert_eq!(refs.len(), 1);
    assert!(refs.contains_key(journaled[0]["salvageRef"].as_str().unwrap()));
    assert!(error.contains("stdout"), "{error}");
    assert!(error.contains(&closed.project.to_string()), "{error}");
    assert!(!entry.exists());
    assert!(second.join("notes.md").is_file());

    // A journal that cannot be opened for appending stops the run before
    // any entry: a read-only one, and a link to a folder that does not
    // exist (which the read of earlier refs takes as no journal yet).
    for broken in ["read-only", "dangling link"] {
        let other = Gateway::new();
        let c1 = other.publish(&[("README.md", Some("one\n"))], "c1");
        let entry = other.park_checkout_at(&c1);
        write(&entry.join("README.md"), b"edited\n");
        other.salvage_mode_hook(&[]);
        let journal = other.root.join(".salvage/report.jsonl");
        std::fs::create_dir_all(journal.parent().unwrap()).unwrap();
        if broken == "read-only" {
            use std::os::unix::fs::PermissionsExt as _;
            std::fs::write(&journal, b"").unwrap();
            std::fs::set_permissions(&journal, std::fs::Permissions::from_mode(0o400)).unwrap();
            if std::fs::OpenOptions::new()
                .append(true)
                .open(&journal)
                .is_ok()
            {
                eprintln!("skipped the read-only journal: this user may write any file");
                continue;
            }
        } else {
            std::os::unix::fs::symlink(other.root.join("missing/report.jsonl"), &journal).unwrap();
        }
        let stub = Stub::default();
        let mut out = Vec::new();
        let error = run(&other.settings(true, true, &[]), &stub, &mut out)
            .unwrap_err()
            .to_string();
        assert!(error.contains("report.jsonl"), "{broken}: {error}");
        assert!(out.is_empty(), "{broken}");
        assert_eq!(stub.read_mints.get(), 0, "{broken}");
        assert!(entry.join("README.md").is_file(), "{broken}");
        assert!(other.salvage_refs().is_empty(), "{broken}");
    }
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
    assert_eq!(stub.salvage_mints.get(), 0);
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

    // Its ref is not verified, so no acknowledgement removes it.
    let entry_name = gateway.project.to_string();
    let (_, lines) = salvage(&gateway.settings(true, true, &[&entry_name]), &stub);
    assert!(lines[0]["error"].is_string(), "{:#}", lines[0]);
    assert_eq!(lines[0]["removed"], false, "{:#}", lines[0]);
    assert!(entry.join(".env").is_file());
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
    assert_eq!(stub.salvage_mints.get(), 1);
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
    // W reached canonical only as a rebuilt commit.
    assert_eq!(report["historyFiltered"], true);
    assert_eq!(stub.salvage_mints.get(), 2);
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

    // A later dry run reports the ref that was made, with the path the
    // shard refused, and a later run with --apply pushes nothing.
    let (_, dry) = salvage(&gateway.settings(false, false, &[]), &stub);
    assert_eq!(dry[0]["salvageRef"], report["salvageRef"], "{:#}", dry[0]);
    assert_eq!(dry[0]["canonicalVerified"], true);
    assert_eq!(dry[0]["historyFiltered"], true);
    assert!(dry[0]["skippedPaths"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["path"] == "export.zip" && item["reason"] == "policy"));
    let (_, again) = salvage(&gateway.settings(true, false, &[]), &stub);
    assert_eq!(
        again[0]["salvageRef"], report["salvageRef"],
        "{:#}",
        again[0]
    );
    assert_eq!(again[0]["canonicalVerified"], true);
    assert_eq!(stub.salvage_mints.get(), 2);
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
    *stub.export_answer.borrow_mut() = Some((
        200,
        serde_json::json!({ "exported": [], "unreferenced": true }),
    ));

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
    // The controller's final answer: nothing to retry.
    assert_eq!(report["exportFailed"], serde_json::json!([]));
}

/// An export that may succeed later (Storage off, the route not deployed
/// yet, a timeout or a server error) keeps the image privately, fails the
/// run, and holds up `--remove` until a rerun exports it or the entry is
/// acknowledged: once the entry is gone nothing can export it.
#[test]
fn an_export_that_may_succeed_later_holds_up_removal() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("chat-upload-1-b.png"), PNG);
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();
    for (status, body) in [
        (
            409,
            serde_json::json!({ "code": "attachments_unavailable" }),
        ),
        (404, JsonValue::Null),
        (502, serde_json::json!({ "code": "storage_upload_failed" })),
    ] {
        *stub.export_answer.borrow_mut() = Some((status, body));
        let (summary, lines) = salvage(&gateway.settings(true, true, &[]), &stub);
        let report = &lines[0];
        assert!(report["error"].is_null(), "{report:#}");
        assert_eq!(report["clean"], true, "{report:#}");
        assert_eq!(report["removed"], false, "{status} {report:#}");
        assert!(entry.join("chat-upload-1-b.png").is_file());
        assert_eq!(summary.exit_code(), 1, "{status}");
        assert!(
            report["removeRefused"]
                .as_str()
                .unwrap_or_default()
                .contains("not exported"),
            "{status} {report:#}"
        );
        assert_eq!(
            report["exportFailed"],
            serde_json::json!(["chat-upload-1-b.png"]),
            "{status} {report:#}"
        );
        let archive = PathBuf::from(report["privateArchive"].as_str().unwrap());
        assert_eq!(
            tar_listing(&archive),
            vec!["worktree/chat-upload-1-b.png".to_string()]
        );
    }

    // The rerun exports it, and the entry goes.
    *stub.export_answer.borrow_mut() = None;
    let (summary, lines) = salvage(&gateway.settings(true, true, &[]), &stub);
    let report = &lines[0];
    assert_eq!(report["exportFailed"], serde_json::json!([]), "{report:#}");
    assert_eq!(report["removed"], true, "{report:#}");
    assert_eq!(summary.exit_code(), 0);
    assert!(!entry.exists());

    // An operator who acknowledges the entry removes it with the image only
    // in the private archive; that is what they acknowledged, so the run
    // succeeds, and the summary still counts the image.
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("chat-upload-2-b.png"), PNG);
    *stub.export_answer.borrow_mut() = Some((
        409,
        serde_json::json!({ "code": "attachments_unavailable" }),
    ));
    let entry_name = gateway.project.to_string();
    let (summary, lines) = salvage(&gateway.settings(true, true, &[&entry_name]), &stub);
    let report = &lines[0];
    assert_eq!(
        report["exportFailed"],
        serde_json::json!(["chat-upload-2-b.png"]),
        "{report:#}"
    );
    assert_eq!(report["removed"], true, "{report:#}");
    assert_eq!(summary.export_failed, 1);
    assert_eq!(summary.exit_code(), 0, "{summary:?}");
    assert!(!entry.exists());
}

/// Every private file carries its size, and the entry and the run their
/// totals, so a dry run says how much room `.salvage/` needs; an entry whose
/// outputs would take the volume below the floor the gateway keeps free
/// stops before writing them.
#[test]
fn private_files_are_sized_and_the_volume_keeps_its_floor() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(
        &[
            ("README.md", Some("one\n")),
            (".gitignore", Some(".venv/\n")),
        ],
        "c1",
    );
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("README.md"), b"edited\n");
    write(&entry.join(".env"), b"SECRET=1\n");
    write(&entry.join(".venv/lib/a.py"), &[b'a'; 1000]);
    write(&entry.join(".venv/bin/python"), &[b'p'; 3000]);
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (summary, lines) = salvage(&gateway.settings(false, false, &[]), &stub);
    let report = &lines[0];
    let mut sizes: Vec<(String, u64)> = report["privateArchivedPaths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["path"].as_str().unwrap().to_string(),
                item["size"].as_u64().unwrap_or(u64::MAX),
            )
        })
        .collect();
    sizes.sort();
    assert_eq!(
        sizes,
        vec![
            (".env".to_string(), 9),
            (".venv/bin/python".to_string(), 3000),
            (".venv/lib/a.py".to_string(), 1000),
        ],
        "{report:#}"
    );
    assert_eq!(report["privateArchiveBytes"], 4009);
    assert_eq!(summary.private_bytes, 4009);

    // No room above the floor: the entry stops before its outputs.
    let mut cramped = gateway.settings(true, false, &[]);
    cramped.min_free_bytes = u64::MAX / 2;
    let (summary, lines) = salvage(&cramped, &stub);
    let report = &lines[0];
    let error = report["error"].as_str().unwrap_or_default();
    assert!(error.contains("free"), "{report:#}");
    assert_eq!(summary.exit_code(), 1);
    assert!(report["privateArchive"].is_null() && report["bundle"].is_null());
    let salvage_dir = gateway.root.join(".salvage");
    let written: Vec<String> = std::fs::read_dir(&salvage_dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".tar") || name.ends_with(".bundle"))
        .collect();
    assert!(written.is_empty(), "{written:?}");

    let (summary, lines) = salvage(&gateway.settings(true, false, &[]), &stub);
    assert!(lines[0]["error"].is_null(), "{:#}", lines[0]);
    assert_eq!(summary.private_bytes, 4009);
    let archive = PathBuf::from(lines[0]["privateArchive"].as_str().unwrap());
    assert!(std::fs::metadata(archive).unwrap().len() >= 4009);
}

/// An entry whose run stopped before everything it keeps was written (here
/// at the free-space floor, after the push) is never removed, even when it
/// is named with `--ack`: its private files and bundle exist nowhere else.
/// Once a run writes them, the acknowledged entry goes.
#[test]
fn an_entry_whose_run_stopped_early_is_never_removed_whatever_the_acks() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(
        &[("README.md", Some("one\n")), (".gitignore", Some(".env\n"))],
        "c1",
    );
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("README.md"), b"edited\n");
    write(&entry.join(".env"), b"SECRET=1\n");
    write(&entry.join("local.md"), b"local\n");
    ig(&entry, &["add", "local.md"]);
    entry_commit(&entry, "Local notes");
    // An entry without a repository: every file is private.
    let files_only = gateway
        .root
        .join(".legacy")
        .join(format!("{}-20261005T000000Z", gateway.project));
    write(&files_only.join("notes.md"), b"draft\n");
    write(&files_only.join(".env"), b"OTHER=1\n");
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();
    let names = [
        gateway.project.to_string(),
        format!("{}-20261005T000000Z", gateway.project),
    ];
    let acks: Vec<&str> = names.iter().map(String::as_str).collect();

    let mut cramped = gateway.settings(true, true, &acks);
    cramped.min_free_bytes = u64::MAX / 2;
    let (summary, lines) = salvage(&cramped, &stub);
    assert_eq!(lines.len(), 2);
    for report in &lines {
        assert!(
            report["error"]
                .as_str()
                .unwrap_or_default()
                .contains("free"),
            "{report:#}"
        );
        assert!(report["privateArchive"].is_null(), "{report:#}");
        assert_eq!(report["removed"], false, "{report:#}");
        let refused = report["removeRefused"].as_str().unwrap_or_default();
        assert!(refused.contains("even with --ack"), "{report:#}");
    }
    assert_eq!(lines[0]["canonicalVerified"], true);
    assert!(lines[0]["bundle"].is_null());
    assert_eq!(lines[1]["noRepository"], true);
    assert_eq!(summary.removed, 0);
    assert_eq!(summary.exit_code(), 1);
    assert_eq!(std::fs::read(entry.join(".env")).unwrap(), b"SECRET=1\n");
    assert_eq!(
        std::fs::read(files_only.join(".env")).unwrap(),
        b"OTHER=1\n"
    );
    let written: Vec<String> = std::fs::read_dir(gateway.root.join(".salvage"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
        .filter(|name| name.ends_with(".tar") || name.ends_with(".bundle"))
        .collect();
    assert!(written.is_empty(), "{written:?}");

    // With room, the outputs are written and the acknowledged entries go.
    let (summary, lines) = salvage(&gateway.settings(true, true, &acks), &stub);
    for report in &lines {
        assert!(report["error"].is_null(), "{report:#}");
        assert_eq!(report["removed"], true, "{report:#}");
        let archive = PathBuf::from(report["privateArchive"].as_str().unwrap());
        assert!(tar_listing(&archive).contains(&"worktree/.env".to_string()));
    }
    assert!(lines[0]["bundle"].is_string(), "{:#}", lines[0]);
    assert_eq!(summary.exit_code(), 0);
    assert!(!entry.exists() && !files_only.exists());
}

/// A path git refuses to add (`cfg/x` while the index holds the file
/// `cfg`) stops a whole `update-index` batch without changing the index; it
/// is reported and left as it was, and the rest of the work tree's changes
/// still go into W.
#[test]
fn a_path_git_refuses_is_left_out_and_the_rest_kept() {
    let gateway = Gateway::new();
    let mut files: Vec<(String, Option<String>)> = (0..40)
        .map(|n| (format!("src/f{n:02}.js"), Some(format!("v0 {n}\n"))))
        .collect();
    files.push(("cfg".to_string(), Some("file\n".to_string())));
    let listed: Vec<(&str, Option<&str>)> = files
        .iter()
        .map(|(path, text)| (path.as_str(), text.as_deref()))
        .collect();
    let c1 = gateway.publish(&listed, "c1");
    let entry = gateway.park_checkout_at(&c1);
    for n in 0..40 {
        write(&entry.join(format!("src/f{n:02}.js")), b"v1\n");
    }
    std::fs::remove_file(entry.join("cfg")).unwrap();
    write(&entry.join("cfg/x"), b"now a folder\n");
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (_, lines) = salvage(&gateway.settings(true, false, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(report["canonicalVerified"], true, "{report:#}");
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
        vec![
            ("cfg/".to_string(), "unsupported".to_string()),
            ("cfg/x".to_string(), "unsupported".to_string()),
        ]
    );
    let salvaged = report["salvageRev"].as_str().unwrap();
    let canonical = gateway.canonical();
    for n in 0..40 {
        assert_eq!(
            git_in(&canonical, &["show", &format!("{salvaged}:src/f{n:02}.js")]),
            "v1"
        );
    }
    assert_eq!(
        git_in(&canonical, &["show", &format!("{salvaged}:cfg")]),
        "file"
    );
}

/// Every read of canonical carries a `git.read` credential minted for it: a
/// long entry (a slow fetch, many exports, a large work tree) can outlast
/// the one minted when it started.
#[test]
fn every_read_of_canonical_is_minted_for_it() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("README.md"), b"edited\n");
    gateway.salvage_mode_hook(&[]);
    let log = gateway.root.parent().unwrap().join("git.log");
    let stub = Stub::default();
    let (_, lines) = {
        let _wrapper = GitWrapper::install(
            gateway.root.parent().unwrap(),
            &format!("printf '%s\\n' \"$*\" >> '{}'", log.display()),
        );
        salvage(&gateway.settings(true, false, &[]), &stub)
    };
    assert_eq!(lines[0]["canonicalVerified"], true, "{:#}", lines[0]);
    let logged = std::fs::read_to_string(&log).unwrap();
    let mut reads = Vec::new();
    for line in logged.lines() {
        let words: Vec<&str> = line.split(' ').collect();
        if !words
            .iter()
            .any(|word| matches!(*word, "fetch" | "ls-remote"))
        {
            continue;
        }
        let bearer = words
            .iter()
            .position(|word| *word == "Bearer")
            .map(|at| words[at + 1].to_string());
        reads.push(bearer.unwrap_or_else(|| panic!("no credential: {line}")));
    }
    // The fetch, the check before the push, and the read back after it.
    assert_eq!(reads.len(), 3, "{logged}");
    let distinct: std::collections::BTreeSet<&String> = reads.iter().collect();
    assert_eq!(distinct.len(), reads.len(), "{reads:?}");
    assert_eq!(stub.read_mints.get(), reads.len());
}

/// A rerun of an entry that still holds the same work reports the salvage
/// ref an earlier run made for it, whatever `main` and the node name did
/// since: restoring that ref, or part of it, during the soak never mints a
/// second one. A dry run reports the recorded ref too.
#[test]
fn a_rerun_reuses_the_ref_recorded_for_the_same_work() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(
        &[
            ("README.md", Some("one\n")),
            ("a.txt", Some("a0\n")),
            ("c.txt", Some("c0\n")),
            ("d.txt", Some("d0\n")),
        ],
        "c1",
    );
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("local.md"), b"local\n");
    ig(&entry, &["add", "local.md"]);
    entry_commit(&entry, "Add local notes");
    write(&entry.join("a.txt"), b"a1\n");
    write(&entry.join("d.txt"), b"d1\n");
    std::fs::remove_file(entry.join("c.txt")).unwrap();
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (_, lines) = salvage(&gateway.settings(true, false, &[]), &stub);
    let first = &lines[0];
    assert!(first["error"].is_null(), "{first:#}");
    assert_eq!(first["canonicalVerified"], true);
    let reference = first["salvageRef"].as_str().unwrap().to_string();
    let salvaged = first["salvageRev"].as_str().unwrap().to_string();
    assert_eq!(stub.salvage_mints.get(), 1);
    // What the ref changes from HEAD.
    let held = git_in(
        &gateway.canonical(),
        &[
            "diff",
            "--name-only",
            first["head"].as_str().unwrap(),
            &salvaged,
        ],
    );
    let held: Vec<String> = held.lines().map(str::to_string).collect();
    assert_eq!(held, ["a.txt", "c.txt", "d.txt"]);
    assert_eq!(paths(&first["archivedPaths"]), held);

    // The person restores the ref in Studio, leaving d.txt out: a new commit
    // on main (not a merge) with local.md, a1, and no c.txt.
    std::fs::remove_file(gateway.canonical().join("hooks/update")).unwrap();
    gateway.publish(
        &[
            ("local.md", Some("local\n")),
            ("a.txt", Some("a1\n")),
            ("c.txt", None),
        ],
        "Restore",
    );
    gateway.salvage_mode_hook(&[]);

    let (_, dry) = salvage(&gateway.settings(false, false, &[]), &stub);
    assert_eq!(dry[0]["salvageRef"], reference.as_str(), "{:#}", dry[0]);
    assert_eq!(dry[0]["salvageRev"], salvaged.as_str());
    assert_eq!(dry[0]["canonicalVerified"], true);
    // The line describes the ref it names, not what a new W would hold now
    // that main has part of it.
    assert_eq!(paths(&dry[0]["archivedPaths"]), held, "{:#}", dry[0]);
    assert_eq!(dry[0]["stalePaths"], serde_json::json!([]), "{:#}", dry[0]);

    // The checklist's removal run, on a gateway that changed its name.
    let mut settings = gateway.settings(true, true, &[]);
    settings.node = "other-node".to_string();
    let (summary, lines) = salvage(&settings, &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(report["salvageRef"], reference.as_str(), "{report:#}");
    assert_eq!(report["salvageRev"], salvaged.as_str());
    assert_eq!(report["canonicalVerified"], true);
    assert_eq!(paths(&report["archivedPaths"]), held, "{report:#}");
    assert_eq!(report["stalePaths"], serde_json::json!([]), "{report:#}");
    assert_eq!(report["removed"], true, "{report:#}");
    assert_eq!(summary.exit_code(), 0);
    assert_eq!(
        gateway.salvage_refs(),
        BTreeMap::from([(reference, salvaged)])
    );
    assert_eq!(stub.salvage_mints.get(), 1);
}

/// A filtered entry's local commits reach canonical only as one commit, so
/// the bundle is the only copy of their versions, messages and authors: the
/// entry is removed only with an acknowledgement, even with nothing
/// skipped, and its bundle stays.
#[test]
fn a_filtered_history_needs_an_ack_and_keeps_its_bundle() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("app.js", Some("v0\n"))], "c1");
    let entry = gateway.park_checkout_at(&c1);
    write(&entry.join("app.js"), b"v1\n");
    ig(&entry, &["add", "-A"]);
    entry_commit(&entry, "First version");
    let v1 = ig(&entry, &["rev-parse", "HEAD:app.js"]);
    write(&entry.join("app.js"), b"v2\n");
    write(&entry.join(".env.production"), b"API_KEY=1\n");
    ig(&entry, &["add", "-A"]);
    entry_commit(&entry, "Second version");
    ig(&entry, &["rm", "-q", ".env.production"]);
    let last = entry_commit(&entry, "Drop the settings");
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (summary, lines) = salvage(&gateway.settings(true, true, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(report["historyFiltered"], true);
    assert_eq!(report["canonicalVerified"], true);
    assert_eq!(report["skippedPaths"], serde_json::json!([]));
    assert_eq!(report["removed"], false, "{report:#}");
    assert!(
        report["removeRefused"]
            .as_str()
            .unwrap_or_default()
            .contains("--ack"),
        "{report:#}"
    );
    assert_eq!(summary.exit_code(), 1);
    assert!(entry.exists());
    // The first version never reached canonical.
    assert!(
        !git_output(&gateway.canonical(), &["cat-file", "-e", &v1], None)
            .status
            .success()
    );

    let entry_name = gateway.project.to_string();
    let (summary, lines) = salvage(&gateway.settings(true, true, &[&entry_name]), &stub);
    let report = &lines[0];
    assert_eq!(report["removed"], true, "{report:#}");
    assert_eq!(report["bundleRemoved"], false, "{report:#}");
    assert_eq!(summary.exit_code(), 0);
    assert!(!entry.exists());
    // The bundle still gives back the raw history and its first version.
    let bundle = report["bundle"].as_str().unwrap();
    let restored = gateway.root.parent().unwrap().join("restored");
    git_in(
        gateway.root.parent().unwrap(),
        &["init", "-q", "--bare", restored.to_str().unwrap()],
    );
    git_in(
        &restored,
        &[
            "fetch",
            "-q",
            &gateway.url(),
            "+refs/heads/main:refs/heads/main",
        ],
    );
    git_in(
        &restored,
        &["fetch", "-q", bundle, "+refs/instafy/*:refs/instafy/*"],
    );
    assert_eq!(
        git_in(&restored, &["rev-parse", "refs/instafy/salvage-local/head"]),
        last
    );
    assert_eq!(git_in(&restored, &["cat-file", "-p", &v1]), "v1");
}

/// A version only a local commit held may not reach canonical (over the
/// size cap, or a gitlink), but the path's version at the tip may: the tip's
/// version goes into the filtered commit, and only the earlier version is
/// reported as left out, with the commit that held it. A path whose version
/// at the tip is itself refused is filtered at once and reported once.
#[test]
fn a_version_only_history_held_never_drops_the_tips_version() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = gateway.park_checkout_at(&c1);
    // An oversized clip, then a small one.
    write(&entry.join("media/clip.bin"), &vec![7u8; 21 * 1024 * 1024]);
    ig(&entry, &["add", "-A"]);
    let big_commit = entry_commit(&entry, "Add the clip");
    let big = ig(&entry, &["rev-parse", "HEAD:media/clip.bin"]);
    write(&entry.join("media/clip.bin"), b"a much smaller clip now\n");
    write(&entry.join("src/app.js"), b"app\n");
    ig(&entry, &["add", "-A"]);
    entry_commit(&entry, "Shrink the clip");
    // An oversized file the tip still holds.
    write(&entry.join("media/still.bin"), &vec![9u8; 21 * 1024 * 1024]);
    ig(&entry, &["add", "-A"]);
    entry_commit(&entry, "Add a still");
    let still = ig(&entry, &["rev-parse", "HEAD:media/still.bin"]);
    // A gitlink, then a folder of files at the same path.
    ig(
        &entry,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{c1},vendor/lib"),
        ],
    );
    let link_commit = entry_commit(&entry, "Add a submodule");
    ig(&entry, &["rm", "-q", "--cached", "vendor/lib"]);
    write(&entry.join("vendor/lib/index.js"), b"vendored\n");
    ig(&entry, &["add", "-A"]);
    entry_commit(&entry, "Vendor the library");
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (_, lines) = salvage(&gateway.settings(true, false, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(report["canonicalVerified"], true, "{report:#}");
    assert_eq!(report["historyFiltered"], true, "{report:#}");
    let canonical = gateway.canonical();
    let salvaged = report["salvageRev"].as_str().unwrap();
    let show = |spec: &str| git_in(&canonical, &["show", spec]);
    assert_eq!(
        show(&format!("{salvaged}:media/clip.bin")),
        "a much smaller clip now"
    );
    assert_eq!(show(&format!("{salvaged}:vendor/lib/index.js")), "vendored");
    assert_eq!(show(&format!("{salvaged}:src/app.js")), "app");
    // Neither the oversized versions nor the commits holding them went.
    for object in [&big, &still, &big_commit, &link_commit] {
        assert!(
            !git_output(&canonical, &["cat-file", "-e", object], None)
                .status
                .success(),
            "{object}"
        );
    }
    assert_eq!(
        report["skippedPaths"],
        serde_json::json!([
            {
                "path": "media/clip.bin",
                "size": 21 * 1024 * 1024,
                "reason": "too_large",
                "commit": big_commit,
            },
            {
                "path": "media/still.bin",
                "size": 21 * 1024 * 1024,
                "reason": "too_large",
            },
            {
                "path": "vendor/lib",
                "size": 0,
                "reason": "unsupported",
                "commit": link_commit,
            },
        ]),
        "{report:#}"
    );
}

/// A credential file `main` itself holds and changed after the shared
/// commit: the filtered commit carries `main`'s version, which is no leak,
/// and the local version stays in the private archive.
#[test]
fn an_npmrc_main_itself_changed_is_filtered_once() {
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
    let local_npmrc = ig(&entry, &["rev-parse", "HEAD:.npmrc"]);
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
        !git_output(&canonical, &["cat-file", "-e", &local_npmrc], None)
            .status
            .success()
    );
    let archive = PathBuf::from(report["privateArchive"].as_str().unwrap());
    assert_eq!(
        tar_listing(&archive),
        vec![format!("history/{local}/.npmrc")]
    );
}

/// An old save whose push failed left its local commit at HEAD, and the next
/// save's reset onto `main` abandoned it. A file `main` added meanwhile looks
/// deleted in the work tree, though neither that commit nor the commit it was
/// made on had it: the absence is a stale copy, never salvaged as a deletion.
/// A file the abandoned commit itself deleted (its base had it) is a real
/// deletion and is kept.
#[test]
fn a_file_main_added_after_an_abandoned_local_commit_is_not_salvaged_as_a_deletion() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(
        &[("README.md", Some("one\n")), ("notes.md", Some("v1\n"))],
        "c1",
    );
    let entry = gateway.park_checkout_at(&c1);
    std::fs::remove_file(entry.join("README.md")).unwrap();
    write(&entry.join("notes.md"), b"local\n");
    ig(&entry, &["add", "-A"]);
    let abandoned = entry_commit(&entry, "Save notes");
    let c2 = gateway.publish(&[("p.txt", Some("runtime\n"))], "c2");
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
    assert_eq!(
        ig(&entry, &["status", "--porcelain", "--untracked-files=no"]),
        " D README.md\n M notes.md\n D p.txt"
    );
    // The abandoned commit is not on main.
    let on_main = git_output(
        &entry,
        &[
            "--git-dir",
            ".instafy/.git",
            "merge-base",
            "--is-ancestor",
            &abandoned,
            &c2,
        ],
        None,
    );
    assert_eq!(on_main.status.code(), Some(1));
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (summary, lines) = salvage(&gateway.settings(true, true, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(paths(&report["stalePaths"]), ["p.txt"], "{report:#}");
    assert_eq!(
        paths(&report["archivedPaths"]),
        ["README.md", "notes.md"],
        "{report:#}"
    );
    assert_eq!(report["canonicalVerified"], true, "{report:#}");
    let salvaged = report["salvageRev"].as_str().unwrap();
    let canonical = gateway.canonical();
    assert_eq!(
        git_in(&canonical, &["diff", "--name-status", &c2, salvaged]),
        "D\tREADME.md\nM\tnotes.md"
    );
    assert_eq!(
        git_in(&canonical, &["show", &format!("{salvaged}:p.txt")]),
        "runtime"
    );
    assert_eq!(report["removed"], true, "{report:#}");
    assert_eq!(summary.exit_code(), 0);
}

/// An old sync reset the copy onto every new `main` it saw. The reset that
/// first hid a file `main` added is older than the newest forty, and its old
/// head is read all the same: the absence is a stale copy, and the entry is
/// clean.
#[test]
fn a_reset_older_than_the_newest_forty_still_marks_a_stale_deletion() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(&[("README.md", Some("one\n"))], "c1");
    let entry = gateway.park_checkout_at(&c1);
    let mut tips = vec![gateway.publish(&[("p.txt", Some("runtime\n"))], "Add p")];
    for n in 0..40 {
        write(
            &gateway.seed.join("counter.txt"),
            format!("{n}\n").as_bytes(),
        );
        tips.push(commit_all(&gateway.seed, &format!("Count {n}")));
    }
    git_in(
        &gateway.seed,
        &[
            "push",
            "-q",
            gateway.canonical().to_str().unwrap(),
            "HEAD:main",
        ],
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
    for tip in &tips {
        ig(&entry, &["update-ref", "refs/remotes/origin/main", tip]);
        ig(&entry, &["reset", "-q", "--mixed", "origin/main"]);
    }
    assert_eq!(
        ig(&entry, &["status", "--porcelain", "--untracked-files=no"]),
        " D counter.txt\n D p.txt"
    );
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (summary, lines) = salvage(&gateway.settings(true, true, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    assert_eq!(
        paths(&report["stalePaths"]),
        ["counter.txt", "p.txt"],
        "{report:#}"
    );
    assert_eq!(report["archivedPaths"], serde_json::json!([]), "{report:#}");
    assert_eq!(report["clean"], true, "{report:#}");
    assert_eq!(report["removed"], true, "{report:#}");
    assert_eq!(summary.exit_code(), 0);
    assert!(gateway.salvage_refs().is_empty());
}

/// A repository inside a folder git reads (one cloned into a tracked folder,
/// or one whose `.git` the old gateway hid while it staged files and never
/// put back): `git status` never shows it, so it is reported as skipped and
/// the entry is removed only with an acknowledgement.
#[test]
fn a_repository_inside_a_tracked_folder_holds_up_removal() {
    let gateway = Gateway::new();
    let c1 = gateway.publish(
        &[
            ("README.md", Some("one\n")),
            (".gitignore", Some("scratch/\n")),
            ("vendor/lib/a.txt", Some("a\n")),
            ("tools/x/b.txt", Some("b\n")),
        ],
        "c1",
    );
    let entry = gateway.park_checkout_at(&c1);
    // In an ignored folder too, which is walked for the private archive.
    write(&entry.join("scratch/notes.txt"), b"notes\n");
    write(
        &entry.join("scratch/repo/.git.instafy-hidden-2/HEAD"),
        b"ref: refs/heads/main\n",
    );
    let nested = entry.join("vendor/lib");
    git_in(&nested, &["init", "-q", "-b", "main"]);
    write(&nested.join("history-only.txt"), b"only in its history\n");
    commit_all(&nested, "Add");
    std::fs::remove_file(nested.join("history-only.txt")).unwrap();
    commit_all(&nested, "Remove");
    write(
        &entry.join("tools/x/.git.instafy-hidden-1/HEAD"),
        b"ref: refs/heads/main\n",
    );
    gateway.salvage_mode_hook(&[]);
    let stub = Stub::default();

    let (summary, lines) = salvage(&gateway.settings(true, true, &[]), &stub);
    let report = &lines[0];
    assert!(report["error"].is_null(), "{report:#}");
    let skipped: BTreeMap<String, (String, u64)> = report["skippedPaths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["path"].as_str().unwrap().to_string(),
                (
                    item["reason"].as_str().unwrap().to_string(),
                    item["size"].as_u64().unwrap(),
                ),
            )
        })
        .collect();
    assert_eq!(
        skipped.keys().cloned().collect::<Vec<_>>(),
        [
            "scratch/repo/.git.instafy-hidden-2/",
            "tools/x/.git.instafy-hidden-1/",
            "vendor/lib/.git/"
        ],
        "{report:#}"
    );
    assert!(skipped
        .values()
        .all(|(reason, size)| reason == "unsupported" && *size > 0));
    assert_eq!(
        paths(&report["privateArchivedPaths"]),
        ["scratch/notes.txt"]
    );
    assert_eq!(report["clean"], false, "{report:#}");
    assert_eq!(report["removed"], false, "{report:#}");
    assert!(report["removeRefused"]
        .as_str()
        .unwrap()
        .contains("outside build output"));
    assert_eq!(summary.exit_code(), 1);
    assert!(nested.join(".git").is_dir());

    let entry_name = gateway.project.to_string();
    let (summary, removed) = salvage(&gateway.settings(true, true, &[&entry_name]), &stub);
    assert_eq!(removed[0]["removed"], true, "{:#}", removed[0]);
    assert_eq!(summary.exit_code(), 0);
    assert!(!entry.exists());
}
