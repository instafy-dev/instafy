//! The working folder's rolling save against real git: a bare canonical
//! remote running the shard's own update hook, a hosted checkout, and a
//! second clone standing in for everyone else.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use reqwest::Url;
use tempfile::TempDir;
use uuid::Uuid;

use super::*;
use crate::config::ServerConfig;
use crate::git::ensure_git_checkout;
use crate::publish::{flush_saving, flush_within, PublishContext};
use crate::push::{clear_push_hook, set_push_hook, PushHookAction};
use crate::recovery::{RecoveryKind, RecoverySpec, LOCAL_RECOVERY_ROOT};
use crate::test_support::{git_in, git_output, ig, install_shard_hook, GitWrapper};
use crate::workspace_git::GitIdentity;

const README: &str = "one\ntwo\nthree\n";

struct Fixture {
    _dir: TempDir,
    root: PathBuf,
    remote: PathBuf,
    ws: PathBuf,
    config: ServerConfig,
    memory: WorkingMemory,
}

fn write(dir: &Path, path: &str, bytes: &[u8]) {
    let target = dir.join(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(target, bytes).unwrap();
}

fn config_for(ws: &Path, remote: &Path) -> ServerConfig {
    ServerConfig {
        project_id: Uuid::new_v4(),
        origin_id: Uuid::new_v4(),
        workspace_root: ws.to_path_buf(),
        git_remote_url: Some(format!("file://{}", remote.display())),
        git_remote_base_url: None,
        git_branch: "main".to_string(),
        git_remote_name: "origin".to_string(),
        git_author_name: "Instafy Origin".to_string(),
        git_author_email: "origin@instafy.dev".to_string(),
        bind_host: "127.0.0.1".to_string(),
        bind_port: 0,
        controller_base_url: Url::parse("http://127.0.0.1:9").unwrap(),
        controller_internal_token: None,
        controller_token_source: None,
        jwks_url: Url::parse("http://127.0.0.1:9/.well-known/jwks.json").unwrap(),
        skip_auth: true,
        enable_presence_heartbeat: false,
        presence_interval: Duration::from_secs(60),
        max_archive_bytes: 1024 * 1024,
        staging_base: None,
        multi_tenant: false,
        hosted_checkout: true,
    }
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let remote = root.join("remote.git");
        git_in(
            &root,
            &[
                "init",
                "-q",
                "--bare",
                "-b",
                "main",
                remote.to_str().unwrap(),
            ],
        );
        install_shard_hook(&remote, &[]);
        let seed = root.join("seed");
        fs::create_dir_all(&seed).unwrap();
        git_in(&seed, &["init", "-q", "-b", "main"]);
        git_in(&seed, &["config", "user.name", "Seed"]);
        git_in(&seed, &["config", "user.email", "seed@instafy.dev"]);
        write(&seed, "README.md", README.as_bytes());
        write(&seed, "doc.md", b"alpha\nbeta\n");
        git_in(&seed, &["add", "-A"]);
        git_in(&seed, &["commit", "-q", "-m", "init"]);
        git_in(&seed, &["push", "-q", remote.to_str().unwrap(), "main"]);
        let ws = root.join("ws");
        fs::create_dir_all(&ws).unwrap();
        let config = config_for(&ws, &remote);
        ensure_git_checkout(&config, None).expect("initial checkout");
        Fixture {
            _dir: dir,
            root,
            remote,
            ws,
            config,
            memory: WorkingMemory::default(),
        }
    }

    fn ctx(&self) -> PublishContext<'_> {
        PublishContext {
            config: &self.config,
            workspace_root: &self.ws,
            token: None,
            can_write: true,
        }
    }

    /// One save as the route runs it, with this fixture's memory.
    fn save(&self, reason: PersistReason) -> WorkingState {
        self.save_stopping(reason, &StopFlag::default())
    }

    fn save_stopping(&self, reason: PersistReason, stop: &StopFlag) -> WorkingState {
        let ctx = self.ctx();
        let mut publisher = publisher(&ctx, budget(reason));
        match plan_route_save(&mut publisher, reason, &self.memory, stop) {
            Planned::Network(plan) => {
                publisher
                    .execute_working_save(plan, &self.memory, Some(stop))
                    .state
            }
            Planned::Answered(state) => state,
        }
    }

    fn state(&self) -> WorkingState {
        local_state(&self.ctx(), &self.memory).unwrap()
    }

    fn write(&self, path: &str, bytes: &[u8]) {
        write(&self.ws, path, bytes);
    }

    fn main(&self) -> String {
        git_in(&self.remote, &["rev-parse", "main"])
    }

    /// The slot on canonical: `(ref, commit)`.
    fn slot(&self) -> Option<(String, String)> {
        let listed = git_in(
            &self.remote,
            &[
                "for-each-ref",
                "--format=%(refname) %(objectname)",
                "refs/instafy/recovery/",
            ],
        );
        listed
            .lines()
            .filter_map(|line| line.split_once(' '))
            .find(|(name, _)| name.ends_with("/working"))
            .map(|(name, rev)| (name.to_string(), rev.to_string()))
    }

    fn remote_recovery_refs(&self) -> Vec<String> {
        git_in(
            &self.remote,
            &["for-each-ref", "--format=%(refname)", "refs/instafy/"],
        )
        .lines()
        .map(str::to_string)
        .collect()
    }

    fn slot_file(&self, path: &str) -> Option<String> {
        let (_, rev) = self.slot()?;
        let output = git_output(&self.remote, &["show", &format!("{rev}:{path}")], None);
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).to_string())
    }

    fn slot_message(&self) -> String {
        let (_, rev) = self.slot().expect("a slot");
        git_in(&self.remote, &["log", "-1", "--format=%B", &rev])
    }

    fn slot_parent(&self) -> String {
        let (_, rev) = self.slot().expect("a slot");
        git_in(&self.remote, &["rev-parse", &format!("{rev}^")])
    }

    fn record(&self) -> Option<String> {
        let output = git_output(
            &self.ws,
            &[
                "--git-dir",
                ".instafy/.git",
                "rev-parse",
                "--verify",
                "-q",
                RECORD_REF,
            ],
            None,
        );
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn local_refs(&self, prefix: &str) -> Vec<String> {
        ig(&self.ws, &["for-each-ref", "--format=%(refname)", prefix])
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn working_set_id(&self) -> Option<String> {
        let output = git_output(
            &self.ws,
            &[
                "--git-dir",
                ".instafy/.git",
                "config",
                "--get",
                WORKING_SET_CONFIG_KEY,
            ],
            None,
        );
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    }
}

struct PushHookGuard;

impl Drop for PushHookGuard {
    fn drop(&mut self) {
        clear_push_hook();
    }
}

fn with_push_hook(hook: impl FnMut(&[String]) -> PushHookAction + 'static) -> PushHookGuard {
    set_push_hook(hook);
    PushHookGuard
}

/// Lose the response of every push to the slot; others run as usual.
fn lose_slot_pushes() -> PushHookGuard {
    with_push_hook(|specs| {
        if specs.iter().any(|spec| spec.ends_with("/working")) {
            PushHookAction::LoseResponse
        } else {
            PushHookAction::Proceed
        }
    })
}

#[test]
fn the_first_save_creates_the_slot_on_main_and_a_second_replaces_it() {
    let fx = Fixture::new();
    fx.write("doc.md", b"alpha\nbeta\nedited\n");
    fx.write("notes.md", b"new\n");

    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert!(state.durable && !state.changed, "{state:?}");
    assert_eq!(state.unsaved, 2);
    assert!(state.persisted_at.is_some());
    let (slot, first) = fx.slot().expect("a slot");
    let id = fx.working_set_id().expect("a working-set id");
    assert_eq!(
        slot,
        format!(
            "refs/instafy/recovery/{id}/{}",
            git_service::policy::WORKING_SLOT_NAME
        )
    );
    assert_eq!(fx.slot_parent(), fx.main());
    let message = fx.slot_message();
    assert!(
        message.starts_with("Keep a workspace's unsaved changes\n"),
        "{message}"
    );
    assert!(
        message.contains("Instafy-Recovery-Kind: unsaved\n"),
        "{message}"
    );
    assert!(
        message.contains(&format!("Instafy-Origin: {}\n", fx.config.origin_id)),
        "{message}"
    );
    assert!(message.contains("Instafy-Path: doc.md\n"), "{message}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("new\n"));
    assert_eq!(fx.record().as_deref(), Some(first.as_str()));

    fx.write("notes.md", b"newer\n");
    assert!(fx.state().changed);
    let state = fx.save(PersistReason::Tick);
    assert!(state.durable, "{state:?}");
    let (same_slot, second) = fx.slot().unwrap();
    assert_eq!(same_slot, slot, "the slot is replaced in place");
    assert_ne!(second, first);
    assert_eq!(fx.slot_parent(), fx.main(), "each save sits on main");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("newer\n"));
    assert_eq!(fx.record().as_deref(), Some(second.as_str()));
    assert_eq!(fx.working_set_id().as_deref(), Some(id.as_str()));
    // Content-addressed recovery refs are the only other kind; none exist.
    assert_eq!(fx.remote_recovery_refs(), vec![slot]);
}

#[test]
fn an_unchanged_folder_pushes_nothing_and_needs_no_write_access() {
    let fx = Fixture::new();
    fx.write("notes.md", b"new\n");
    fx.save(PersistReason::Tick);
    let (_, before) = fx.slot().unwrap();
    let state = fx.state();
    assert!(!state.changed && state.durable, "{state:?}");

    // Same files, so nothing reaches canonical, and no step would need a
    // credential.
    let ctx = fx.ctx();
    let mut publisher = publisher(&ctx, TICK_BUDGET);
    let plan = publisher
        .plan_working_save(PersistReason::Tick, None)
        .unwrap();
    assert!(!plan
        .needs_network(&publisher.git, fx.config.origin_id)
        .unwrap());
    let pushes = std::rc::Rc::new(std::cell::Cell::new(0));
    let counted = pushes.clone();
    let _hook = with_push_hook(move |_| {
        counted.set(counted.get() + 1);
        PushHookAction::Proceed
    });
    let state = fx.save(PersistReason::Tick);
    assert!(state.durable, "{state:?}");
    assert_eq!(pushes.get(), 0);
    assert_eq!(fx.slot().unwrap().1, before);
}

#[test]
fn nothing_unsaved_deletes_the_slot() {
    let fx = Fixture::new();
    fx.write("notes.md", b"new\n");
    fx.save(PersistReason::Tick);
    assert!(fx.slot().is_some());

    fs::remove_file(fx.ws.join("notes.md")).unwrap();
    let state = fx.save(PersistReason::TurnEnd);
    assert!(state.durable, "{state:?}");
    assert_eq!(state.unsaved, 0);
    assert!(fx.slot().is_none());
    assert!(fx.record().is_none());
    // With no slot and nothing unsaved, the next save is local.
    let state = fx.save(PersistReason::Tick);
    assert!(state.durable && state.error.is_none(), "{state:?}");
}

/// A local conflict copy goes out before the slot is decided; while it
/// cannot, the slot is kept (it may be the only copy of that work) and the
/// folder is not durable.
#[test]
fn local_only_work_is_pushed_first_and_keeps_the_slot_while_it_cannot_be() {
    let fx = Fixture::new();
    fx.write("notes.md", b"new\n");
    fx.save(PersistReason::Tick);
    let (_, slot_before) = fx.slot().unwrap();
    fs::remove_file(fx.ws.join("notes.md")).unwrap();

    let git = WorkspaceGit::new(&fx.ws, None);
    let main = fx.main();
    let blob = git_output(
        &fx.ws,
        &["--git-dir", ".instafy/.git", "hash-object", "-w", "--stdin"],
        Some(b"mine\n"),
    );
    let blob = String::from_utf8_lossy(&blob.stdout).trim().to_string();
    let listing = format!(
        "{}\n100644 blob {blob}\tconflicted.md\n",
        ig(&fx.ws, &["ls-tree", &main])
    );
    let made = git_output(
        &fx.ws,
        &["--git-dir", ".instafy/.git", "mktree"],
        Some(listing.as_bytes()),
    );
    let conflict_tree = String::from_utf8_lossy(&made.stdout).trim().to_string();
    let stored = crate::recovery::store(
        &git,
        RecoverySpec {
            kind: RecoveryKind::Conflict,
            tree: conflict_tree,
            parent: Some(main),
            source: None,
            date: None,
            paths: vec!["conflicted.md".to_string()],
            commits: Vec::new(),
            identity: GitIdentity::new("Instafy Origin", "origin@instafy.dev"),
            origin_id: fx.config.origin_id,
        },
    )
    .unwrap()
    .expect("a conflict copy");
    assert_eq!(fx.local_refs(LOCAL_RECOVERY_ROOT).len(), 1);

    // Its push is lost: the copy stays local, so the slot stays.
    let lost = with_push_hook(|specs| {
        if specs.iter().any(|spec| spec.contains("-conflict-")) {
            PushHookAction::LoseResponse
        } else {
            PushHookAction::Proceed
        }
    });
    let state = fx.save(PersistReason::Tick);
    drop(lost);
    assert_eq!(state.local_only, 1, "{state:?}");
    assert!(!state.durable, "{state:?}");
    assert_eq!(fx.slot().unwrap().1, slot_before, "the slot was kept");

    // Pushed now: the copy is canonical and the slot goes.
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.local_only, 0, "{state:?}");
    assert!(state.durable, "{state:?}");
    assert!(fx.local_refs(LOCAL_RECOVERY_ROOT).is_empty());
    assert!(fx
        .remote_recovery_refs()
        .iter()
        .any(|name| name.ends_with(&stored.name)));
    assert!(fx.slot().is_none());
}

#[test]
fn a_tick_never_renames_a_nested_repository_and_keeps_its_earlier_entry() {
    let fx = Fixture::new();
    let nested = fx.ws.join("vendor/lib");
    fs::create_dir_all(&nested).unwrap();
    git_in(&nested, &["init", "-q", "-b", "main"]);
    write(&nested, "a.txt", b"first\n");

    // The turn's end saves it the way a stop does, its `.git` hidden.
    let state = fx.save(PersistReason::TurnEnd);
    assert!(state.durable, "{state:?}");
    assert_eq!(fx.slot_file("vendor/lib/a.txt").as_deref(), Some("first\n"));
    let _ = fs::remove_dir_all(fx.ws.join(".instafy/origin-staging"));

    write(&nested, "a.txt", b"second\n");
    fx.write("doc.md", b"alpha\nbeta\nticked\n");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert!(
        !state.durable,
        "a deferred file is not durable yet: {state:?}"
    );
    assert_eq!(
        fx.slot_file("doc.md").as_deref(),
        Some("alpha\nbeta\nticked\n")
    );
    assert_eq!(
        fx.slot_file("vendor/lib/a.txt").as_deref(),
        Some("first\n"),
        "the tick kept the earlier save's entry"
    );
    assert!(nested.join(".git").is_dir());
    assert!(
        !fx.ws.join(".instafy/origin-staging").exists(),
        "a tick never hides a nested repository"
    );
    // An unchanged folder after a tick is not re-saved by the next tick.
    assert!(!fx.state().changed);

    let state = fx.save(PersistReason::TurnEnd);
    assert!(state.durable, "{state:?}");
    assert_eq!(
        fx.slot_file("vendor/lib/a.txt").as_deref(),
        Some("second\n")
    );
}

#[test]
fn a_tick_defers_a_large_file_to_the_turns_end() {
    let fx = Fixture::new();
    let big = |fill: u8| vec![fill; 3 * 1024 * 1024];
    fx.write("assets/big.bin", &big(1));
    let state = fx.save(PersistReason::TurnEnd);
    assert!(state.durable, "{state:?}");
    let first = fx.slot().unwrap().1;
    let blob = |rev: &str| git_in(&fx.remote, &["rev-parse", &format!("{rev}:assets/big.bin")]);
    let first_blob = blob(&first);

    fx.write("assets/big.bin", &big(2));
    fx.write("notes.md", b"small\n");
    let state = fx.save(PersistReason::Tick);
    assert!(!state.durable, "{state:?}");
    let ticked = fx.slot().unwrap().1;
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("small\n"));
    assert_eq!(blob(&ticked), first_blob, "the tick kept the earlier entry");

    let state = fx.save(PersistReason::TurnEnd);
    assert!(state.durable, "{state:?}");
    let ended = fx.slot().unwrap().1;
    assert_ne!(
        blob(&ended),
        first_blob,
        "the turn's end saved the new version"
    );
}

/// A tick reads the folder and writes only objects and its own refs: HEAD,
/// the real index and what `git status` says are the same afterwards, and
/// it never needs `index.lock`, which another git command may hold.
#[test]
fn a_tick_leaves_head_the_index_and_status_alone() {
    let fx = Fixture::new();
    fx.write("doc.md", b"alpha\nbeta\nedited\n");
    fx.write("notes.md", b"new\n");
    ig(&fx.ws, &["add", "notes.md"]);
    let git_dir = fx.ws.join(".instafy/.git");
    let quiet_status = || {
        let output = std::process::Command::new("git")
            .current_dir(&fx.ws)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .args([
                "--git-dir",
                ".instafy/.git",
                "--work-tree",
                ".",
                "status",
                "--porcelain",
                "--untracked-files=all",
            ])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).to_string()
    };
    let head = ig(&fx.ws, &["rev-parse", "HEAD"]);
    let head_file = fs::read(git_dir.join("HEAD")).unwrap();
    let index = fs::read(git_dir.join("index")).unwrap();
    let status = quiet_status();
    // Another git command holds the index.
    fs::write(git_dir.join("index.lock"), b"held").unwrap();

    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("new\n"));

    assert_eq!(fs::read(git_dir.join("index.lock")).unwrap(), b"held");
    fs::remove_file(git_dir.join("index.lock")).unwrap();
    assert_eq!(fs::read(git_dir.join("index")).unwrap(), index);
    assert_eq!(fs::read(git_dir.join("HEAD")).unwrap(), head_file);
    assert_eq!(ig(&fx.ws, &["rev-parse", "HEAD"]), head);
    assert_eq!(quiet_status(), status);
}

#[test]
fn ignored_private_unpublishable_and_oversized_files_are_never_saved() {
    let fx = Fixture::new();
    fx.write(".gitignore", b"ignored.txt\n");
    fx.write("ignored.txt", b"ignored\n");
    fx.write(".env", b"API_HOST=example.test\n");
    fx.write("keys/server.pem", b"pem\n");
    fx.write("node_modules/pkg/index.js", b"vendored\n");
    fx.write("huge.bin", &vec![3u8; 21 * 1024 * 1024]);
    fx.write("kept.md", b"kept\n");

    for reason in [PersistReason::Tick, PersistReason::TurnEnd] {
        fx.write("kept.md", format!("kept {reason:?}\n").as_bytes());
        let state = fx.save(reason);
        assert_eq!(state.error, None, "{reason:?}: {state:?}");
        assert_eq!(fx.slot_file("kept.md"), Some(format!("kept {reason:?}\n")));
        for never in [
            "ignored.txt",
            ".env",
            "keys/server.pem",
            "node_modules/pkg/index.js",
            "huge.bin",
        ] {
            assert!(fx.slot_file(never).is_none(), "{reason:?} saved {never}");
        }
    }
}

#[test]
fn an_unrelated_history_saves_on_main() {
    let fx = Fixture::new();
    ig(&fx.ws, &["checkout", "-q", "--orphan", "side"]);
    ig(&fx.ws, &["rm", "-q", "-r", "--cached", "."]);
    fx.write("own.md", b"own history\n");
    ig(&fx.ws, &["add", "own.md"]);
    ig(
        &fx.ws,
        &[
            "-c",
            "user.name=Ada",
            "-c",
            "user.email=ada@example.com",
            "commit",
            "-q",
            "-m",
            "own",
        ],
    );
    fx.write("draft.md", b"draft\n");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_parent(), fx.main());
    assert_eq!(fx.slot_file("draft.md").as_deref(), Some("draft\n"));
    // Nothing only main holds reads as deleted.
    assert_eq!(fx.slot_file("README.md").as_deref(), Some(README));
}

#[test]
fn an_ambiguous_push_records_nothing() {
    let fx = Fixture::new();
    fx.write("notes.md", b"one\n");
    let first = fx.save(PersistReason::Tick);
    let record = fx.record();
    let persisted = first.persisted_at;
    assert!(persisted.is_some());

    fx.write("notes.md", b"two\n");
    let lost = lose_slot_pushes();
    let state = fx.save(PersistReason::Tick);
    drop(lost);
    assert_eq!(state.error.as_deref(), Some("push_ambiguous"), "{state:?}");
    assert!(!state.durable);
    assert_eq!(fx.record(), record, "the record did not move");
    assert_eq!(state.persisted_at, persisted);
    assert_eq!(fx.state().persisted_at, persisted);
    assert!(fx.state().changed, "the next tick tries again");
}

/// A slot gone from canonical while the record names it was removed (or
/// restored) by a person: its paths are not saved again until they change.
/// A slot someone else moved is left alone.
#[test]
fn a_removed_slot_sticks_per_path_and_a_moved_one_is_left_alone() {
    let fx = Fixture::new();
    fx.write("removed.md", b"removed\n");
    fx.write("doc.md", b"alpha\nbeta\nremoved too\n");
    fx.save(PersistReason::Tick);
    let (slot, _) = fx.slot().unwrap();
    git_in(&fx.remote, &["update-ref", "-d", &slot]);

    fx.write("later.md", b"later\n");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_file("later.md").as_deref(), Some("later\n"));
    assert!(
        fx.slot_file("removed.md").is_none(),
        "removed work came back"
    );
    assert_eq!(fx.slot_file("doc.md").as_deref(), Some("alpha\nbeta\n"));
    assert!(!fx.local_refs(DISMISSED_REF).is_empty());

    // Edited again: saved again.
    fx.write("removed.md", b"edited again\n");
    fx.save(PersistReason::Tick);
    assert_eq!(
        fx.slot_file("removed.md").as_deref(),
        Some("edited again\n")
    );

    // Someone else moved it: nothing is pushed.
    let (slot, current) = fx.slot().unwrap();
    let elsewhere = git_in(
        &fx.remote,
        &[
            "-c",
            "user.name=Other",
            "-c",
            "user.email=other@example.com",
            "commit-tree",
            &format!("{current}^{{tree}}"),
            "-p",
            &fx.main(),
            "-m",
            "elsewhere",
        ],
    );
    git_in(&fx.remote, &["update-ref", &slot, &elsewhere]);
    fx.write("later.md", b"later still\n");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error.as_deref(), Some("slot_moved"), "{state:?}");
    assert_eq!(fx.slot().unwrap().1, elsewhere);
}

#[test]
fn a_new_origin_on_the_same_folder_rewrites_only_the_trailer() {
    let mut fx = Fixture::new();
    fx.write("notes.md", b"new\n");
    fx.save(PersistReason::Tick);
    let (slot, first) = fx.slot().unwrap();
    let tree = |rev: &str| git_in(&fx.remote, &["rev-parse", &format!("{rev}^{{tree}}")]);
    let first_tree = tree(&first);

    let earlier = fx.config.origin_id;
    fx.config.origin_id = Uuid::new_v4();
    fx.memory = WorkingMemory::default();
    let state = fx.save(PersistReason::Tick);
    assert!(state.durable, "{state:?}");
    let (same, second) = fx.slot().unwrap();
    assert_eq!(same, slot);
    assert_ne!(second, first);
    assert_eq!(tree(&second), first_tree);
    let message = fx.slot_message();
    assert!(message.contains(&format!("Instafy-Origin: {}\n", fx.config.origin_id)));
    assert!(!message.contains(&earlier.to_string()));
}

#[test]
fn a_tick_gives_up_once_a_stop_raises_its_flag() {
    let fx = Fixture::new();
    fx.write("notes.md", b"new\n");
    let stop = StopFlag::default();
    stop.raise();
    let state = fx.save_stopping(PersistReason::Tick, &stop);
    assert_eq!(state.error.as_deref(), Some("stopping"), "{state:?}");
    assert!(fx.slot().is_none());

    // Raised while the tick lists the folder: it stops before staging.
    stop.lower();
    let marker = fx.root.join("listing");
    let release = fx.root.join("release");
    let _wrapper = GitWrapper::install(
        &fx.root,
        &format!(
            "case \" $* \" in *\" status \"*) : > '{}'; while [ ! -e '{}' ]; do sleep 0.02; done ;; esac",
            marker.display(),
            release.display()
        ),
    );
    let raiser = {
        let stop = stop.clone();
        let (marker, release) = (marker.clone(), release.clone());
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(30);
            while !marker.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            stop.raise();
            fs::write(release, b"").unwrap();
        })
    };
    let state = fx.save_stopping(PersistReason::Tick, &stop);
    raiser.join().unwrap();
    assert_eq!(state.error.as_deref(), Some("stopping"), "{state:?}");
    assert!(fx.slot().is_none());
}

/// A stop that asks for the working folder's own save leaves only the slot:
/// the `unsaved` copy it would have pushed is held back and removed.
#[test]
fn a_stop_with_a_save_leaves_only_the_slot() {
    let fx = Fixture::new();
    fx.write("doc.md", b"alpha\nbeta\nticked\n");
    fx.save(PersistReason::Tick);

    // Unchanged since the tick: no copy is even stored.
    let report = flush_saving(&fx.ctx(), false, Duration::from_secs(18), Some(&fx.memory)).unwrap();
    let working = report.working_state.clone().expect("workingState");
    assert!(working.durable, "{working:?}");
    assert!(report.recovery_refs.is_empty(), "{report:?}");
    assert_eq!(report.unpushed_refs, 0);

    // Changed since: the stop's copy is held back, the slot takes the
    // change, and the copy is removed.
    fx.write("doc.md", b"alpha\nbeta\nchanged at the stop\n");
    let report = flush_saving(&fx.ctx(), false, Duration::from_secs(18), Some(&fx.memory)).unwrap();
    let working = report.working_state.clone().expect("workingState");
    assert!(working.durable, "{working:?}");
    assert!(report.recovery_refs.is_empty(), "{report:?}");
    assert!(fx.local_refs(LOCAL_RECOVERY_ROOT).is_empty());
    assert_eq!(
        fx.slot_file("doc.md").as_deref(),
        Some("alpha\nbeta\nchanged at the stop\n")
    );
    assert!(
        !fx.remote_recovery_refs()
            .iter()
            .any(|name| name.contains("-unsaved-")),
        "{:?}",
        fx.remote_recovery_refs()
    );
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["workingState"]["durable"], true, "{json}");
}

#[test]
fn a_stop_whose_save_fails_pushes_its_unsaved_copy() {
    let fx = Fixture::new();
    fx.write("doc.md", b"alpha\nbeta\nat the stop\n");
    let lost = lose_slot_pushes();
    let report = flush_saving(&fx.ctx(), false, Duration::from_secs(18), Some(&fx.memory)).unwrap();
    drop(lost);
    let working = report.working_state.clone().expect("workingState");
    assert!(!working.durable, "{working:?}");
    assert_eq!(working.error.as_deref(), Some("push_ambiguous"));
    let unsaved: Vec<String> = fx
        .remote_recovery_refs()
        .into_iter()
        .filter(|name| name.contains("-unsaved-"))
        .collect();
    assert_eq!(unsaved.len(), 1, "{report:?}");
    assert_eq!(report.unpushed_refs, 0);
}

/// Without the controller's flag a stop is exactly what it was: the
/// `unsaved` copy goes out, and the answer has no `workingState`.
#[test]
fn a_stop_without_the_flag_is_unchanged() {
    let fx = Fixture::new();
    fx.write("notes.md", b"new\n");
    fx.save(PersistReason::Tick);
    let report = flush_within(&fx.ctx(), false, Duration::from_secs(18)).unwrap();
    assert!(report.working_state.is_none());
    let json = serde_json::to_value(&report).unwrap();
    assert!(json.get("workingState").is_none(), "{json}");
    assert_eq!(report.recovery_refs.len(), 1, "{report:?}");
    assert!(fx
        .remote_recovery_refs()
        .iter()
        .any(|name| name.contains("-unsaved-")));
}

#[test]
fn the_working_set_id_is_made_once_and_never_cloned() {
    let fx = Fixture::new();
    assert!(fx.working_set_id().is_none());
    fx.write("notes.md", b"new\n");
    fx.save(PersistReason::Tick);
    let id = fx.working_set_id().expect("made by the first save");
    assert!(is_working_set_id(&id));
    fx.write("notes.md", b"newer\n");
    fx.save(PersistReason::Tick);
    assert_eq!(fx.working_set_id().as_deref(), Some(id.as_str()));
    // Every git command reduces the config to data-only settings; the id
    // stays.
    ig(&fx.ws, &["status", "--porcelain"]);
    WorkspaceGit::new(&fx.ws, None).commit_id("HEAD").unwrap();
    assert_eq!(fx.working_set_id().as_deref(), Some(id.as_str()));

    // Another checkout of the same space is another folder.
    let other_ws = fx.root.join("other-ws");
    fs::create_dir_all(&other_ws).unwrap();
    let mut other_config = config_for(&other_ws, &fx.remote);
    other_config.project_id = fx.config.project_id;
    ensure_git_checkout(&other_config, None).unwrap();
    write(&other_ws, "elsewhere.md", b"elsewhere\n");
    let other_memory = WorkingMemory::default();
    let ctx = PublishContext {
        config: &other_config,
        workspace_root: &other_ws,
        token: None,
        can_write: true,
    };
    let mut other = publisher(&ctx, TICK_BUDGET);
    let Planned::Network(plan) = plan_route_save(
        &mut other,
        PersistReason::Tick,
        &other_memory,
        &StopFlag::default(),
    ) else {
        panic!("the other folder has work to save");
    };
    other.execute_working_save(plan, &other_memory, None);
    let other_id = read_working_set_id(&WorkspaceGit::new(&other_ws, None))
        .unwrap()
        .expect("its own id");
    assert_ne!(other_id, id);
    let slots: Vec<String> = fx
        .remote_recovery_refs()
        .into_iter()
        .filter(|name| name.ends_with("/working"))
        .collect();
    assert_eq!(slots.len(), 2, "{slots:?}");
}

/// The list marks a slot as a rolling save, names its last writer as its
/// origin, and never shows it restored.
#[test]
fn the_list_marks_a_rolling_save_and_never_restores_it() {
    let fx = Fixture::new();
    fx.write("notes.md", b"new\n");
    fx.save(PersistReason::Tick);
    let (slot, _) = fx.slot().unwrap();
    // An ordinary recovery ref, for comparison.
    let main = fx.main();
    let ordinary = format!(
        "refs/instafy/recovery/{}/20261002T120000Z-unsaved-0123456789ab",
        fx.config.origin_id
    );
    git_in(&fx.remote, &["update-ref", &ordinary, &main]);
    // A slot whose commit names no writer keeps the working-set id its name
    // carries, which no live origin has, so Studio never hides it.
    let unnamed_id = Uuid::new_v4();
    let unnamed = format!("refs/instafy/recovery/{unnamed_id}/working");
    git_in(&fx.remote, &["update-ref", &unnamed, &main]);
    // Restore commits of both on main, as an origin makes them.
    let other = fx.root.join("other");
    git_in(
        &fx.root,
        &[
            "clone",
            "-q",
            fx.remote.to_str().unwrap(),
            other.to_str().unwrap(),
        ],
    );
    for reference in [&slot, &ordinary] {
        git_in(
            &other,
            &[
                "-c",
                "user.name=Instafy Origin",
                "-c",
                "user.email=origin@instafy.dev",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                crate::recovery_view::restore_commit_message(reference).trim_end(),
            ],
        );
    }
    git_in(&other, &["push", "-q", "origin", "main"]);
    ig(&fx.ws, &["fetch", "-q", "origin"]);

    let git = WorkspaceGit::new(&fx.ws, None);
    let items = crate::checkout_versions::list_unsaved_work(
        &git,
        fx.config.git_remote_url.as_deref().unwrap(),
        "refs/remotes/origin/main",
        &fx.config.git_author_email,
    )
    .unwrap();
    let slot_item = items
        .iter()
        .find(|item| item.reference == slot)
        .expect("the slot is listed");
    assert!(slot_item.rolling_save);
    assert_eq!(slot_item.origin, fx.config.origin_id);
    assert_eq!(slot_item.restored_rev, None);
    let unnamed_item = items
        .iter()
        .find(|item| item.reference == unnamed)
        .expect("the slot without a writer is listed");
    assert!(unnamed_item.rolling_save);
    assert_eq!(unnamed_item.origin, unnamed_id);
    let ordinary_item = items
        .iter()
        .find(|item| item.reference == ordinary)
        .expect("the ordinary ref is listed");
    assert!(!ordinary_item.rolling_save);
    assert!(ordinary_item.restored_rev.is_some());
    let json = serde_json::to_value(&items).unwrap();
    let listed: Vec<&serde_json::Value> = json.as_array().unwrap().iter().collect();
    for entry in listed {
        let rolling = entry.get("rollingSave");
        if entry["ref"] == slot.as_str() || entry["ref"] == unnamed.as_str() {
            assert_eq!(rolling, Some(&serde_json::Value::Bool(true)));
        } else {
            assert!(rolling.is_none(), "{entry}");
        }
    }
}

/// A shutdown waits for a rolling save to let the workspace go instead of
/// skipping, so an unfinished turn steps back.
#[tokio::test(flavor = "multi_thread")]
async fn a_shutdown_waits_for_a_tick_and_steps_back() {
    let fx = Fixture::new();
    fx.write("half.rs", b"fn half() {\n");
    ig(&fx.ws, &["add", "half.rs"]);
    ig(
        &fx.ws,
        &[
            "-c",
            "user.name=Ada",
            "-c",
            "user.email=ada@example.com",
            "commit",
            "-q",
            "-m",
            "half a turn",
        ],
    );
    let main = fx.main();
    let holder = crate::workspace_lock::try_acquire_workspace_apply_lock(&fx.ws)
        .unwrap()
        .expect("the lock");
    let released = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        drop(holder);
    });
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    let started = Instant::now();
    server
        .stop_flushing_workspace_during_turn(true)
        .await
        .unwrap();
    released.join().unwrap();
    assert!(started.elapsed() >= Duration::from_millis(1400));
    assert_eq!(
        ig(&fx.ws, &["rev-parse", "HEAD"]),
        main,
        "the turn stepped back"
    );
    assert_eq!(
        fs::read_to_string(fx.ws.join("half.rs")).unwrap(),
        "fn half() {\n"
    );
    assert_eq!(fx.local_refs(LOCAL_RECOVERY_ROOT).len(), 1);
}

/// The durable-stop marker: only when the folder's final state is durable,
/// never with unsaved or local-only work, never without a remote.
#[tokio::test(flavor = "multi_thread")]
async fn the_durable_stop_marker_is_written_only_when_durable() {
    let marker = |fx: &Fixture| fs::read(fx.ws.join(crate::server::CLEAN_STOP_MARKER)).ok();

    // Saved at the turn's end, nothing since: durable.
    let fx = Fixture::new();
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    server.start().await.unwrap();
    let state = server.app_state().unwrap();
    fx.write("notes.md", b"saved\n");
    let ctx = fx.ctx();
    let mut publisher = publisher(&ctx, TICK_BUDGET);
    let Planned::Network(plan) = plan_route_save(
        &mut publisher,
        PersistReason::TurnEnd,
        &state.working_memory,
        &state.stop_flag,
    ) else {
        panic!("work to save");
    };
    publisher.execute_working_save(plan, &state.working_memory, None);
    server.stop_flushing_workspace().await.unwrap();
    assert_eq!(marker(&fx).as_deref(), Some(DURABLE_MARKER));
    assert!(fx.local_refs(LOCAL_RECOVERY_ROOT).is_empty());

    // An edit after the last save: not durable, and kept locally.
    let fx = Fixture::new();
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    server.start().await.unwrap();
    fx.write("notes.md", b"never saved\n");
    server.stop_flushing_workspace().await.unwrap();
    assert_eq!(marker(&fx), None);
    assert_eq!(fx.local_refs(LOCAL_RECOVERY_ROOT).len(), 1);

    // Without a remote there is nothing to be durable on.
    let dir = tempfile::tempdir().unwrap();
    let ws = dir.path().canonicalize().unwrap().join("ws");
    fs::create_dir_all(&ws).unwrap();
    let mut config = config_for(&ws, Path::new("/nonexistent"));
    config.git_remote_url = None;
    let mut server = crate::server::OriginHttpServer::new(config).unwrap();
    server.start().await.unwrap();
    server.stop_flushing_workspace().await.unwrap();
    assert!(!ws.join(crate::server::CLEAN_STOP_MARKER).exists());
}
