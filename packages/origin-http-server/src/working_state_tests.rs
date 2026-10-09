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

    /// The seed the folder's working-set id is made from.
    fn working_set_seed(&self) -> Option<String> {
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

/// Let the files written so far grow older than [`RACY_MARGIN`], so the
/// next save takes the content it reads as theirs and confirms the state
/// as unchanged.
fn age_files() {
    std::thread::sleep(RACY_MARGIN + Duration::from_millis(50));
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

/// Report every push to the slot as lost without running it: canonical
/// never sees it.
fn drop_slot_pushes() -> PushHookGuard {
    with_push_hook(|specs| {
        if specs.iter().any(|spec| spec.ends_with("/working")) {
            PushHookAction::DropRequest
        } else {
            PushHookAction::Proceed
        }
    })
}

impl Fixture {
    /// Fail every `ls-remote` on this thread until the guard is dropped.
    fn blind_ls_remote(&self) -> GitWrapper {
        GitWrapper::install(
            &self.root,
            "case \" $* \" in *\" ls-remote \"*) exit 128 ;; esac",
        )
    }
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
    let seed = fx.working_set_seed().expect("a working-set seed");
    let id = working_set_id_for(&seed);
    assert_ne!(id, seed, "the slot never names the seed");
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
    assert_eq!(fx.working_set_seed().as_deref(), Some(seed.as_str()));
    // Content-addressed recovery refs are the only other kind; none exist.
    assert_eq!(fx.remote_recovery_refs(), vec![slot]);
}

#[test]
fn an_unchanged_folder_pushes_nothing_and_needs_no_write_access() {
    let fx = Fixture::new();
    fx.write("notes.md", b"new\n");
    age_files();
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

/// A publish that moves only `main` (it fast-forwards to the folder's own
/// commits, as Studio's save of an agent's commits does) is a change: HEAD
/// and the files are the same, but the slot holds work `main` now has, and
/// the next save deletes it.
#[test]
fn a_publish_that_moves_only_main_is_a_change() {
    let fx = Fixture::new();
    fx.write("notes.md", b"agent work\n");
    ig(&fx.ws, &["add", "notes.md"]);
    ig(
        &fx.ws,
        &[
            "-c",
            "user.name=Agent",
            "-c",
            "user.email=agent@instafy.dev",
            "commit",
            "-q",
            "-m",
            "agent work",
        ],
    );
    let state = fx.save(PersistReason::Tick);
    assert!(state.durable && state.error.is_none(), "{state:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("agent work\n"));
    assert!(!fx.state().changed);

    ig(&fx.ws, &["push", "-q", "origin", "HEAD:main"]);
    ig(&fx.ws, &["fetch", "-q", "origin"]);
    let state = fx.state();
    assert!(state.changed, "{state:?}");
    let state = fx.save(PersistReason::Tick);
    assert!(state.durable && state.error.is_none(), "{state:?}");
    assert_eq!(state.unsaved, 0);
    assert_eq!(fx.slot(), None);
    assert!(!fx.state().changed);
}

/// Older git (2.34) takes the checkout's `.instafy` folder, which holds its
/// repository, for a nested one: an agent's `git add -A` there commits it
/// as a gitlink, which the shard refuses. A save never sends it (one push,
/// never refused): it keeps the parent's entry (none), and the commit's
/// other work is saved. The entry is made directly here, so every git sees
/// it.
#[test]
fn a_committed_instafy_entry_never_reaches_the_slot() {
    let fx = Fixture::new();
    fx.write("notes.md", b"agent work\n");
    let head = ig(&fx.ws, &["rev-parse", "HEAD"]);
    ig(&fx.ws, &["add", "notes.md"]);
    ig(
        &fx.ws,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            &format!("160000,{head},.instafy"),
        ],
    );
    ig(
        &fx.ws,
        &[
            "-c",
            "user.name=Agent",
            "-c",
            "user.email=agent@instafy.dev",
            "commit",
            "-q",
            "-m",
            "agent work",
        ],
    );
    assert!(
        ig(&fx.ws, &["ls-tree", "HEAD", ".instafy"]).starts_with("160000 commit "),
        "the commit holds the gitlink"
    );

    let pushes = std::rc::Rc::new(std::cell::Cell::new(0usize));
    let counted = pushes.clone();
    let _counting = with_push_hook(move |specs| {
        if specs.iter().any(|spec| spec.ends_with("/working")) {
            counted.set(counted.get() + 1);
        }
        PushHookAction::Proceed
    });
    for (reason, doc) in [
        (PersistReason::Tick, "ticked\n"),
        (PersistReason::TurnEnd, "ended\n"),
    ] {
        fx.write("doc.md", doc.as_bytes());
        pushes.set(0);
        let state = fx.save(reason);
        assert_eq!(state.error, None, "{reason:?}: {state:?}");
        assert_eq!(pushes.get(), 1, "{reason:?}: the shard never saw it");
        assert_eq!(fx.slot_file("notes.md").as_deref(), Some("agent work\n"));
        assert_eq!(fx.slot_file("doc.md").as_deref(), Some(doc));
        let (_, slot) = fx.slot().unwrap();
        assert_eq!(git_in(&fx.remote, &["ls-tree", &slot, ".instafy"]), "");
    }
}

/// `tar -x`, `unzip`, `cp -p` and `rsync -a` put a file's mtime back after
/// rewriting it, and npm gives every tarball entry the same fixed time. A
/// rewrite of the same size is still a change: a job's end skips its save
/// on this check.
#[test]
fn a_same_size_rewrite_that_puts_the_mtime_back_is_a_change() {
    const PATH: &str = "vendor/pkg/package.json";
    let fx = Fixture::new();
    let extract = |content: &str| {
        fx.write(PATH, content.as_bytes());
        let fixed = std::time::UNIX_EPOCH + Duration::from_secs(499_162_500);
        fs::File::options()
            .write(true)
            .open(fx.ws.join(PATH))
            .unwrap()
            .set_modified(fixed)
            .unwrap();
    };
    extract(r#"{"name":"pkg","version":"1.2.3"}"#);
    age_files();
    let state = fx.save(PersistReason::TurnEnd);
    assert!(state.durable && state.error.is_none(), "{state:?}");
    assert!(!fx.state().changed);

    extract(r#"{"name":"pkg","version":"1.2.4"}"#);
    let state = fx.state();
    assert!(state.changed && !state.durable, "{state:?}");
    let state = fx.save(PersistReason::Tick);
    assert!(state.durable && state.error.is_none(), "{state:?}");
    assert_eq!(
        fx.slot_file(PATH).as_deref(),
        Some(r#"{"name":"pkg","version":"1.2.4"}"#)
    );
}

/// On a filesystem whose clock ticks coarsely, a rewrite of the same size
/// right after a save read a file can leave the timestamps the save saw.
/// A save therefore never takes a file changed that recently as read: the
/// next check saves again, and the rewrite reaches the slot. The clock is
/// frozen here, so the write, the save and the rewrite always fall in one
/// tick of it, and the rewrite leaves everything the check reads as it was.
#[test]
fn a_same_size_rewrite_in_the_same_timestamp_tick_is_saved() {
    struct Thawed;
    impl Drop for Thawed {
        fn drop(&mut self) {
            FROZEN_CLOCK.set(None);
        }
    }
    let fx = Fixture::new();
    FROZEN_CLOCK.set(Some(std::time::SystemTime::now()));
    let _thawed = Thawed;
    let identity = |fx: &Fixture| {
        let metadata = fs::symlink_metadata(fx.ws.join("notes.md")).unwrap();
        #[cfg(unix)]
        let inode = std::os::unix::fs::MetadataExt::ino(&metadata);
        #[cfg(not(unix))]
        let inode = 0u64;
        (stamps(&metadata), metadata.len(), inode)
    };
    fx.write("notes.md", b"version 1\n");
    let before = identity(&fx);
    let state = fx.save(PersistReason::TurnEnd);
    assert!(state.durable && state.error.is_none(), "{state:?}");
    fx.write("notes.md", b"version 2\n");
    assert_eq!(
        identity(&fx),
        before,
        "the rewrite shows only in its content"
    );
    let state = fx.state();
    assert!(state.changed && !state.durable, "{state:?}");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("version 2\n"));
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

/// A rolling save's git token (`git.persist`) pushes only what a rolling
/// save changes: the shard then lets a push create recovery refs and replace
/// or delete a working slot, nothing else. Every step of a save works under
/// that: the slot is created and replaced, a local recovery ref goes out
/// first, the slot is read back and deleted. A push to `main` is refused.
#[test]
fn every_step_of_a_save_works_with_a_save_only_push() {
    let fx = Fixture::new();
    install_shard_hook(&fx.remote, &[(git_service::policy::PERSIST_PUSH_ENV, "1")]);

    fx.write("notes.md", b"one\n");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("one\n"));
    fx.write("notes.md", b"two\n");
    let state = fx.save(PersistReason::TurnEnd);
    assert_eq!(state.error, None, "{state:?}");
    assert!(state.durable, "{state:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("two\n"));
    assert_eq!(fx.record(), fx.slot().map(|(_, rev)| rev));

    // A local recovery ref goes out first; then nothing is unsaved and the
    // slot is deleted.
    let git = WorkspaceGit::new(&fx.ws, None);
    let main = fx.main();
    let listing = format!(
        "{}\n100644 blob {}\tconflicted.md\n",
        ig(&fx.ws, &["ls-tree", &main]),
        String::from_utf8_lossy(
            &git_output(
                &fx.ws,
                &["--git-dir", ".instafy/.git", "hash-object", "-w", "--stdin"],
                Some(b"mine\n"),
            )
            .stdout
        )
        .trim()
    );
    let made = git_output(
        &fx.ws,
        &["--git-dir", ".instafy/.git", "mktree"],
        Some(listing.as_bytes()),
    );
    let stored = crate::recovery::store(
        &git,
        RecoverySpec {
            kind: RecoveryKind::Conflict,
            tree: String::from_utf8_lossy(&made.stdout).trim().to_string(),
            parent: Some(main.clone()),
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
    fs::remove_file(fx.ws.join("notes.md")).unwrap();
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(state.local_only, 0, "{state:?}");
    assert!(state.durable, "{state:?}");
    assert!(fx
        .remote_recovery_refs()
        .iter()
        .any(|name| name.ends_with(&stored.name)));
    assert!(fx.slot().is_none());

    // The same remote refuses a push to main.
    let seed = fx.root.join("seed");
    git_in(&seed, &["commit", "-q", "--allow-empty", "-m", "published"]);
    let pushed = git_output(&seed, &["push", fx.remote.to_str().unwrap(), "main"], None);
    assert!(!pushed.status.success());
    assert!(
        String::from_utf8_lossy(&pushed.stderr)
            .contains("a rolling save may not change 'refs/heads/main'"),
        "{}",
        String::from_utf8_lossy(&pushed.stderr)
    );
    assert_eq!(fx.main(), main);
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
    age_files();
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

/// A tick sends a bounded amount of new content: small edits go first, and
/// what does not fit waits for the next tick, which goes on even though
/// nothing changed in between.
#[test]
fn a_tick_sends_small_edits_first_and_the_rest_over_later_ticks() {
    let fx = Fixture::new();
    let size = 2 * 1024 * 1024 - 1024;
    let count = 12usize;
    for index in 0..count {
        fx.write(
            &format!("assets/{index:02}.bin"),
            &vec![index as u8 + 1; size],
        );
    }
    fx.write("src/small.rs", b"fn small() {}\n");
    // Old enough that neither tick reads them as changed that moment: only
    // the budget makes the first one leave work for the next.
    age_files();
    let saved = |fx: &Fixture| {
        (0..count)
            .filter(|index| fx.slot_file(&format!("assets/{index:02}.bin")).is_some())
            .count()
    };

    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert!(!state.durable, "{state:?}");
    assert_eq!(
        fx.slot_file("src/small.rs").as_deref(),
        Some("fn small() {}\n")
    );
    let first = saved(&fx);
    assert!(
        first > 0 && first < count,
        "{first} of {count} files in one tick"
    );
    let budget = usize::try_from(TICK_MAX_NEW_BYTES).unwrap();
    assert!(first * size <= budget, "{first} files over the budget");
    assert!(fx.state().changed, "the next tick goes on");

    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(saved(&fx), count);
    assert!(state.durable, "{state:?}");
    assert!(!fx.state().changed);
}

/// A deferred file keeps the earlier save's entry only where that save
/// changed it. Otherwise it keeps the current parent's: a save on a newer
/// `main` never carries an older `main`'s version of a file (which a
/// Restore would then apply over someone else's published one).
#[test]
fn a_deferred_file_the_earlier_save_never_changed_keeps_the_new_mains_version() {
    let fx = Fixture::new();
    let big = |fill: u8| vec![fill; 3 * 1024 * 1024];
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
    let publish = |bytes: &[u8], message: &str| {
        write(&other, "data/big.bin", bytes);
        git_in(&other, &["add", "-A"]);
        git_in(
            &other,
            &[
                "-c",
                "user.name=Other",
                "-c",
                "user.email=other@example.com",
                "commit",
                "-q",
                "-m",
                message,
            ],
        );
        git_in(&other, &["push", "-q", "origin", "main"]);
    };
    let follow_main = || {
        ig(&fx.ws, &["fetch", "-q", "origin"]);
        ig(&fx.ws, &["merge", "-q", "--ff-only", "origin/main"]);
    };
    publish(&big(1), "v1");
    follow_main();

    // An earlier save on that main, which never touched the big file.
    fx.write("a.md", b"edited\n");
    assert_eq!(fx.save(PersistReason::Tick).error, None);

    // Someone publishes a new version; the checkout follows it, and the
    // agent rewrites the file, which a tick leaves for later.
    publish(&big(2), "v2");
    follow_main();
    let main = fx.main();
    fx.write("data/big.bin", &big(3));
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    let (_, slot) = fx.slot().unwrap();
    assert_eq!(fx.slot_parent(), main);
    let blob = |rev: &str| git_in(&fx.remote, &["rev-parse", &format!("{rev}:data/big.bin")]);
    assert_eq!(blob(&slot), blob(&main), "the slot kept main's version");
    let changed = git_in(&fx.remote, &["diff", "--name-only", &main, &slot]);
    assert_eq!(changed, "a.md");
}

/// A deferred file the earlier save did change still keeps the new main's
/// version where main changed it since that save: the folder published a
/// newer version and its checkout followed main, and no save landed after
/// that (one failed, or a copy was still waiting on a local ref). The
/// earlier save's version would read as a change on the new main, and a
/// Restore would put it back over the published one.
#[test]
fn a_deferred_file_main_changed_since_the_last_save_keeps_mains_version() {
    let fx = Fixture::new();
    fx.write("data/big.bin", b"v1\n");
    assert_eq!(fx.save(PersistReason::Tick).error, None);
    assert_eq!(fx.slot_file("data/big.bin").as_deref(), Some("v1\n"));

    // The folder's own publish: v2 goes to main and the checkout is on it.
    fx.write("data/big.bin", b"v2\n");
    ig(&fx.ws, &["add", "data/big.bin"]);
    ig(
        &fx.ws,
        &[
            "-c",
            "user.name=Agent",
            "-c",
            "user.email=agent@instafy.dev",
            "commit",
            "-q",
            "-m",
            "v2",
        ],
    );
    ig(&fx.ws, &["push", "-q", "origin", "HEAD:main"]);
    ig(&fx.ws, &["fetch", "-q", "origin"]);
    let main = fx.main();

    // The agent rewrites the file past what a tick sends, and edits another.
    fx.write("data/big.bin", &vec![3; 3 * 1024 * 1024]);
    fx.write("a.md", b"edited\n");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert!(!state.durable, "{state:?}");
    let (slot_ref, slot) = fx.slot().unwrap();
    assert_eq!(fx.slot_parent(), main);
    let blob = |rev: &str| git_in(&fx.remote, &["rev-parse", &format!("{rev}:data/big.bin")]);
    assert_eq!(blob(&slot), blob(&main), "the slot kept main's version");
    let changed = git_in(&fx.remote, &["diff", "--name-only", &main, &slot]);
    assert_eq!(changed, "a.md");

    // Restored from another folder, the save brings back only the edit.
    let other_ws = fx.root.join("other-ws");
    fs::create_dir_all(&other_ws).unwrap();
    let mut other_config = config_for(&other_ws, &fx.remote);
    other_config.project_id = fx.config.project_id;
    ensure_git_checkout(&other_config, None).unwrap();
    let restored = crate::publish::restore(
        &PublishContext {
            config: &other_config,
            workspace_root: &other_ws,
            token: None,
            can_write: true,
        },
        crate::publish::RestoreRequest {
            reference: slot_ref,
            rev: Some(slot),
            keep: Vec::new(),
            author: None,
        },
    )
    .unwrap();
    assert!(restored.committed);
    assert!(restored.not_restored.is_empty());
    assert_eq!(blob("main"), blob(&main), "main kept its published version");
    assert_eq!(
        git_in(&fx.remote, &["show", "main:a.md"]),
        "edited",
        "the edit came back"
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

/// A path the shard starts to deny after the slot saved it leaves the slot
/// with the next save, and saving goes on: the shard (whose deny list the
/// origin never sees) refuses the slot that keeps it, and accepts the one
/// that drops it.
#[test]
fn a_path_denied_after_it_was_saved_leaves_the_slot() {
    let fx = Fixture::new();
    fx.write("assets/a.zip", b"zip\n");
    assert_eq!(fx.save(PersistReason::Tick).error, None);
    assert!(fx.slot_file("assets/a.zip").is_some());

    install_shard_hook(&fx.remote, &[("GIT_DENY_PATHS", "*.zip")]);
    fx.write("notes.md", b"later\n");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("later\n"));
    assert!(fx.slot_file("assets/a.zip").is_none());
    assert_eq!(fx.record(), fx.slot().map(|(_, rev)| rev));
}

/// More paths than one save may be refused for, denied by the shard after
/// they were saved, do not wedge the slot: the shard names every path it
/// refuses in one refusal, and the save puts them all back at once. So does
/// a folder that writes them with the deny already in place.
#[test]
fn many_paths_the_shard_denies_leave_the_slot_in_one_save() {
    let fx = Fixture::new();
    for index in 0..9 {
        fx.write(&format!("assets/a{index}.zip"), b"zip\n");
    }
    assert_eq!(fx.save(PersistReason::Tick).error, None);
    assert!(fx.slot_file("assets/a8.zip").is_some());

    install_shard_hook(&fx.remote, &[("GIT_DENY_PATHS", "*.zip")]);
    let pushes = std::rc::Rc::new(std::cell::Cell::new(0usize));
    let counted = pushes.clone();
    let _counting = with_push_hook(move |specs| {
        if specs.iter().any(|spec| spec.ends_with("/working")) {
            counted.set(counted.get() + 1);
        }
        PushHookAction::Proceed
    });
    fx.write("notes.md", b"later\n");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("later\n"));
    for index in 0..9 {
        assert!(fx.slot_file(&format!("assets/a{index}.zip")).is_none());
    }
    assert_eq!(pushes.get(), 2, "one refusal named every path");

    pushes.set(0);
    for index in 9..30 {
        fx.write(&format!("assets/a{index}.zip"), b"zip\n");
    }
    fx.write("notes.md", b"latest\n");
    let state = fx.save(PersistReason::TurnEnd);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("latest\n"));
    for index in 0..30 {
        assert!(fx.slot_file(&format!("assets/a{index}.zip")).is_none());
    }
    assert_eq!(pushes.get(), 2, "one refusal named every path");
}

/// A path main holds that the shard starts to deny after a save changed it
/// goes back to main's version in the slot, and saving goes on: the shard
/// refuses the slot's own version and accepts the parent's.
#[test]
fn a_denied_path_main_holds_goes_back_to_mains_version_in_the_slot() {
    let fx = Fixture::new();
    fx.write("doc.md", b"alpha\nbeta\nedited\n");
    assert_eq!(fx.save(PersistReason::Tick).error, None);
    assert_eq!(
        fx.slot_file("doc.md").as_deref(),
        Some("alpha\nbeta\nedited\n")
    );

    install_shard_hook(&fx.remote, &[("GIT_DENY_PATHS", "doc.md")]);
    fx.write("notes.md", b"later\n");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_parent(), fx.main());
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("later\n"));
    assert_eq!(fx.slot_file("doc.md").as_deref(), Some("alpha\nbeta\n"));
    assert_eq!(fx.record(), fx.slot().map(|(_, rev)| rev));
}

/// A first save on an older main, where main changed a path since that the
/// shard now denies: the slot keeps its parent's version, which the shard
/// accepts, although it differs from main's.
#[test]
fn a_new_slot_on_an_older_main_keeps_its_parents_version_of_a_denied_path() {
    let fx = Fixture::new();
    let parent = fx.main();
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
    write(&other, "doc.md", b"alpha\nbeta\npublished\n");
    git_in(
        &other,
        &[
            "-c",
            "user.name=Other",
            "-c",
            "user.email=other@example.com",
            "commit",
            "-q",
            "-a",
            "-m",
            "publish",
        ],
    );
    git_in(&other, &["push", "-q", "origin", "main"]);
    assert_ne!(fx.main(), parent);

    install_shard_hook(&fx.remote, &[("GIT_DENY_PATHS", "doc.md")]);
    fx.write("notes.md", b"draft\n");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_parent(), parent);
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("draft\n"));
    assert_eq!(fx.slot_file("doc.md").as_deref(), Some("alpha\nbeta\n"));
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

/// A checkout whose history is unrelated to `main` (`own.md` committed on
/// an orphan branch), in the middle of a turn.
fn unrelated_turn(fx: &Fixture) {
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
}

impl Fixture {
    /// Whether any ref on canonical holds `path` with `content`.
    fn canonical_holds(&self, path: &str, content: &str) -> bool {
        git_in(&self.remote, &["for-each-ref", "--format=%(refname)"])
            .lines()
            .any(|reference| {
                let output = git_output(
                    &self.remote,
                    &["show", &format!("{reference}:{path}")],
                    None,
                );
                output.status.success() && String::from_utf8_lossy(&output.stdout) == content
            })
    }
}

/// A stop during a turn on a history unrelated to `main` marks the turn's
/// commits as handled, so later saves of the folder leave them out: the
/// stop keeps them on a recovery ref of their own, never only in the slot,
/// with or without an earlier rolling save, and with or without the
/// controller's flag.
#[test]
fn a_stop_during_a_turn_on_an_unrelated_history_keeps_its_commits() {
    for (ticked, flagged) in [(true, true), (false, true), (true, false)] {
        let case = format!("ticked {ticked}, flagged {flagged}");
        let mut fx = Fixture::new();
        unrelated_turn(&fx);
        if ticked {
            assert_eq!(fx.save(PersistReason::Tick).error, None, "{case}");
            assert!(fx.canonical_holds("own.md", "own history\n"), "{case}");
        }
        if flagged {
            let report =
                flush_saving(&fx.ctx(), true, Duration::from_secs(18), Some(&fx.memory)).unwrap();
            let working = report.working_state.clone().expect("workingState");
            assert_eq!(report.unpushed_refs, 0, "{case}: {report:?}");
            assert!(working.durable, "{case}: {working:?}");
        } else {
            // A shutdown: no credential, nothing pushed.
            let ctx = PublishContext {
                can_write: false,
                ..fx.ctx()
            };
            crate::publish::flush_at_shutdown(&ctx, true).unwrap();
        }
        assert!(
            fx.canonical_holds("own.md", "own history\n")
                || !fx.local_refs(LOCAL_RECOVERY_ROOT).is_empty(),
            "{case}: the turn's commits are kept"
        );

        // The next runtime on this folder saves again.
        fx.config.origin_id = Uuid::new_v4();
        fx.memory = WorkingMemory::default();
        fx.write("later.md", b"later\n");
        let state = fx.save(PersistReason::Tick);
        assert_eq!(state.error, None, "{case}: {state:?}");
        assert!(
            fx.canonical_holds("own.md", "own history\n"),
            "{case}: canonical lost the turn's commits"
        );
    }
}

/// A push whose answer was lost is checked against the slot right away:
/// one that landed is confirmed and recorded, one that never reached
/// canonical records nothing.
#[test]
fn a_lost_answer_is_checked_against_the_slot() {
    let fx = Fixture::new();
    fx.write("notes.md", b"one\n");
    let first = fx.save(PersistReason::Tick);
    let persisted = first.persisted_at;
    assert!(persisted.is_some());

    // Landed: the slot shows the push, so it is recorded.
    fx.write("notes.md", b"two\n");
    let lost = lose_slot_pushes();
    let state = fx.save(PersistReason::Tick);
    drop(lost);
    assert_eq!(state.error, None, "{state:?}");
    assert!(state.durable, "{state:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("two\n"));
    assert_eq!(fx.record(), fx.slot().map(|(_, rev)| rev));
    let landed = state.persisted_at;
    assert!(landed.is_some());

    // Never reached canonical: nothing is recorded.
    fx.write("notes.md", b"three\n");
    let record = fx.record();
    let dropped = drop_slot_pushes();
    let state = fx.save(PersistReason::Tick);
    drop(dropped);
    assert_eq!(state.error.as_deref(), Some("push_ambiguous"), "{state:?}");
    assert!(!state.durable);
    assert_eq!(fx.record(), record, "the record did not move");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("two\n"));
    assert_eq!(state.persisted_at, landed);
    assert_eq!(fx.state().persisted_at, landed);
    assert!(fx.state().changed, "the next tick tries again");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("three\n"));
}

/// A push that landed while its answer, or the `ls-remote` that confirms
/// it, never came back leaves the record behind the slot. The next save
/// finds this folder's own commit there and goes on from it, on the first
/// save of a folder as on any later one.
#[test]
fn a_push_that_landed_unconfirmed_never_stops_later_saves() {
    for (first_save, lose_answer) in [(false, true), (false, false), (true, true)] {
        let case = format!("first save {first_save}, answer lost {lose_answer}");
        let fx = Fixture::new();
        if !first_save {
            fx.write("notes.md", b"one\n");
            assert_eq!(fx.save(PersistReason::Tick).error, None, "{case}");
        }
        fx.write("notes.md", b"two\n");
        let blind = fx.blind_ls_remote();
        let lost = lose_answer.then(lose_slot_pushes);
        let state = fx.save(PersistReason::Tick);
        drop(lost);
        drop(blind);
        assert!(state.error.is_some() && !state.durable, "{case}: {state:?}");
        assert_eq!(
            fx.slot_file("notes.md").as_deref(),
            Some("two\n"),
            "{case}: the push landed"
        );
        assert!(
            !fx.state().durable,
            "{case}: not durable before it is confirmed"
        );

        for round in ["three", "four"] {
            fx.write("notes.md", format!("{round}\n").as_bytes());
            let state = fx.save(PersistReason::Tick);
            assert_eq!(state.error, None, "{case}, {round}: {state:?}");
            assert!(state.durable, "{case}, {round}: {state:?}");
            assert_eq!(
                fx.slot_file("notes.md"),
                Some(format!("{round}\n")),
                "{case}"
            );
        }
        fx.write("notes.md", b"five\n");
        let state = fx.save(PersistReason::TurnEnd);
        assert_eq!(state.error, None, "{case}: {state:?}");
        assert_eq!(
            fx.slot_file("notes.md").as_deref(),
            Some("five\n"),
            "{case}"
        );
        assert_eq!(fx.record(), fx.slot().map(|(_, rev)| rev), "{case}");
    }
}

/// A save that finds the slot on a newer save of the folder's own than its
/// record names (an earlier push's answer never came, or the push landed
/// only after the folder looked) goes on from that save: a file this tick
/// leaves for later keeps the version that save holds, so canonical never
/// loses it, whether the tick replaces the slot, keeps it or would have
/// deleted it.
#[test]
fn a_tick_that_finds_a_newer_save_of_its_folder_keeps_the_files_it_defers() {
    let big = |fill: u8| vec![fill; 3 * 1024 * 1024];
    let model = |fx: &Fixture| {
        fx.slot()
            .map(|(_, rev)| git_in(&fx.remote, &["rev-parse", &format!("{rev}:model.bin")]))
    };
    // Every slot push is reported lost without reaching canonical; the
    // test lands it afterwards, as a push that arrives late does.
    let late_slot_push = || {
        let specs = std::rc::Rc::new(std::cell::RefCell::new(Vec::<String>::new()));
        let seen = specs.clone();
        let guard = with_push_hook(move |pushed| {
            if pushed.iter().any(|spec| spec.ends_with("/working")) {
                seen.borrow_mut().extend(pushed.iter().cloned());
                PushHookAction::DropRequest
            } else {
                PushHookAction::Proceed
            }
        });
        (guard, specs)
    };
    let land =
        |fx: &Fixture, spec: &str| ig(&fx.ws, &["push", "-q", "origin", &format!("+{spec}")]);

    // The job's end pushes the file; neither the push's answer nor the
    // look that confirms it comes back. The next job's first tick, with
    // nothing else unsaved, finds that save on the slot.
    let fx = Fixture::new();
    fx.write("model.bin", &big(1));
    let blind = fx.blind_ls_remote();
    let lost = lose_slot_pushes();
    let state = fx.save(PersistReason::TurnEnd);
    drop(lost);
    drop(blind);
    assert!(state.error.is_some(), "{state:?}");
    let pushed = model(&fx).expect("the push landed");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert!(!state.durable, "{state:?}");
    assert_eq!(model(&fx), Some(pushed), "unanswered push, then a tick");
    assert_eq!(fx.record(), fx.slot().map(|(_, rev)| rev));

    // A newer version lands late, after an earlier save that held the old
    // one. A tick with another edit replaces the slot, keeping the newer.
    let fx = Fixture::new();
    fx.write("model.bin", &big(1));
    assert_eq!(fx.save(PersistReason::TurnEnd).error, None);
    fx.write("model.bin", &big(2));
    let (guard, specs) = late_slot_push();
    let state = fx.save(PersistReason::TurnEnd);
    drop(guard);
    assert_eq!(state.error.as_deref(), Some("push_ambiguous"), "{state:?}");
    let spec = specs.borrow().first().cloned().expect("a slot push");
    land(&fx, &spec);
    let newer = model(&fx).expect("the late push landed");
    fx.write("notes.md", b"edited\n");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("edited\n"));
    assert_eq!(
        model(&fx),
        Some(newer),
        "late push, then a tick that pushes"
    );

    // The same with nothing else unsaved: the earlier save's other file is
    // gone, so the tick would delete the slot.
    let fx = Fixture::new();
    fx.write("notes.md", b"saved once\n");
    assert_eq!(fx.save(PersistReason::Tick).error, None);
    fs::remove_file(fx.ws.join("notes.md")).unwrap();
    fx.write("model.bin", &big(3));
    let (guard, specs) = late_slot_push();
    let state = fx.save(PersistReason::TurnEnd);
    drop(guard);
    assert_eq!(state.error.as_deref(), Some("push_ambiguous"), "{state:?}");
    let spec = specs.borrow().first().cloned().expect("a slot push");
    land(&fx, &spec);
    let newer = model(&fx).expect("the late push landed");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(
        model(&fx),
        Some(newer),
        "late push, then a tick that deletes"
    );
    assert_eq!(fx.record(), fx.slot().map(|(_, rev)| rev));
}

/// A delete of the slot that landed without an answer: until the folder
/// knows what canonical holds, nothing reads as saved. Bringing the same
/// files back saves them again, and the gone slot is never taken for a
/// person's Remove.
#[test]
fn a_delete_that_landed_unconfirmed_is_neither_durable_nor_a_removal() {
    // The same files come back: they are saved again, not taken as held.
    let fx = Fixture::new();
    fx.write("notes.md", b"kept\n");
    assert_eq!(fx.save(PersistReason::Tick).error, None);
    fs::remove_file(fx.ws.join("notes.md")).unwrap();
    let blind = fx.blind_ls_remote();
    let lost = lose_slot_pushes();
    let state = fx.save(PersistReason::Tick);
    drop(lost);
    drop(blind);
    assert!(state.error.is_some(), "{state:?}");
    assert!(fx.slot().is_none(), "the delete landed");
    fx.write("notes.md", b"kept\n");
    assert!(!fx.state().durable);
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert!(state.durable, "{state:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("kept\n"));
    let report = flush_saving(&fx.ctx(), false, Duration::from_secs(18), Some(&fx.memory)).unwrap();
    let working = report.working_state.clone().expect("workingState");
    assert!(working.durable, "{working:?}");
    assert_eq!(fx.slot_file("notes.md").as_deref(), Some("kept\n"));
    assert!(fx.local_refs(DISMISSED_REF).is_empty());

    // Other files come back: an unchanged one is not taken as removed.
    let fx = Fixture::new();
    fx.write("a.md", b"same\n");
    fx.write("b.md", b"first\n");
    assert_eq!(fx.save(PersistReason::Tick).error, None);
    fs::remove_file(fx.ws.join("a.md")).unwrap();
    fs::remove_file(fx.ws.join("b.md")).unwrap();
    let blind = fx.blind_ls_remote();
    let lost = lose_slot_pushes();
    fx.save(PersistReason::Tick);
    drop(lost);
    drop(blind);
    assert!(fx.slot().is_none());
    fx.write("a.md", b"same\n");
    fx.write("b.md", b"second\n");
    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(fx.slot_file("a.md").as_deref(), Some("same\n"));
    assert_eq!(fx.slot_file("b.md").as_deref(), Some("second\n"));
    assert!(fx.local_refs(DISMISSED_REF).is_empty());
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
fn the_stop_flag_is_up_while_any_stop_holds_it() {
    let stop = StopFlag::default();
    let first = stop.raise();
    let second = stop.clone().raise();
    drop(first);
    assert!(stop.is_raised(), "one stop lowered it under another");
    drop(second);
    assert!(!stop.is_raised());
}

#[test]
fn a_tick_gives_up_once_a_stop_raises_its_flag() {
    let fx = Fixture::new();
    fx.write("notes.md", b"new\n");
    let stop = StopFlag::default();
    let raised = stop.raise();
    let state = fx.save_stopping(PersistReason::Tick, &stop);
    assert_eq!(state.error.as_deref(), Some("stopping"), "{state:?}");
    assert!(fx.slot().is_none());

    // Raised while the tick lists the folder: it stops before staging.
    drop(raised);
    assert!(!stop.is_raised());
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
            let raised = stop.raise();
            fs::write(release, b"").unwrap();
            raised
        })
    };
    let state = fx.save_stopping(PersistReason::Tick, &stop);
    let _raised = raiser.join().unwrap();
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
    let lost = drop_slot_pushes();
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
    assert!(fx.working_set_seed().is_none());
    fx.write("notes.md", b"new\n");
    fx.save(PersistReason::Tick);
    let id = fx.working_set_seed().expect("made by the first save");
    assert!(is_working_set_id(&id));
    fx.write("notes.md", b"newer\n");
    fx.save(PersistReason::Tick);
    assert_eq!(fx.working_set_seed().as_deref(), Some(id.as_str()));
    // Every git command reduces the config to data-only settings; the seed
    // stays.
    ig(&fx.ws, &["status", "--porcelain"]);
    WorkspaceGit::new(&fx.ws, None).commit_id("HEAD").unwrap();
    assert_eq!(fx.working_set_seed().as_deref(), Some(id.as_str()));

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
    let other_id = read_working_set_seed(&WorkspaceGit::new(&other_ws, None))
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

/// Another working folder of the same space, saved once: its slot is the
/// only copy of `only-copy.md`. Returns `(slot ref, slot commit)`.
fn another_folders_save(fx: &Fixture) -> (String, String) {
    let other_ws = fx.root.join("other-ws");
    fs::create_dir_all(&other_ws).unwrap();
    let mut other_config = config_for(&other_ws, &fx.remote);
    other_config.project_id = fx.config.project_id;
    ensure_git_checkout(&other_config, None).unwrap();
    write(&other_ws, "only-copy.md", b"only here\n");
    let memory = WorkingMemory::default();
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
        &memory,
        &StopFlag::default(),
    ) else {
        panic!("the other folder has work to save");
    };
    let state = other.execute_working_save(plan, &memory, None).state;
    assert_eq!(state.error, None, "{state:?}");
    fx.slot().expect("the other folder's slot")
}

/// What a turn in this folder can do to its own repository: name the slot
/// of another folder it sees (a fetch mirrors canonical's recovery refs) as
/// its working set, and that slot's commit as its record.
fn point_at(fx: &Fixture, slot: &str) {
    ig(
        &fx.ws,
        &[
            "fetch",
            "-q",
            "origin",
            "+refs/instafy/recovery/*:refs/instafy/recovery/*",
        ],
    );
    let visible = slot.split('/').nth(3).expect("the slot's working-set id");
    ig(&fx.ws, &["config", WORKING_SET_CONFIG_KEY, visible]);
    ig(&fx.ws, &["update-ref", RECORD_REF, slot]);
}

fn remote_rev(fx: &Fixture, reference: &str) -> Option<String> {
    let output = git_output(
        &fx.remote,
        &["rev-parse", "--verify", "-q", reference],
        None,
    );
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// A turn that points this folder's working set and record at another
/// folder's slot cannot make a save delete it: its slot name is not
/// something the folder's repository can choose.
#[test]
fn a_turn_cannot_make_a_save_delete_another_folders_slot() {
    let fx = Fixture::new();
    let (slot, tip) = another_folders_save(&fx);
    point_at(&fx, &slot);

    let state = fx.save(PersistReason::TurnEnd);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(remote_rev(&fx, &slot).as_deref(), Some(tip.as_str()));
    // Nor does a stop.
    flush_saving(&fx.ctx(), false, Duration::from_secs(18), Some(&fx.memory)).unwrap();
    assert_eq!(remote_rev(&fx, &slot).as_deref(), Some(tip.as_str()));
}

/// Nor replace it with this folder's own work.
#[test]
fn a_turn_cannot_make_a_save_replace_another_folders_slot() {
    let fx = Fixture::new();
    let (slot, tip) = another_folders_save(&fx);
    point_at(&fx, &slot);
    fx.write("junk.md", b"junk\n");

    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(remote_rev(&fx, &slot).as_deref(), Some(tip.as_str()));
    let held = git_in(&fx.remote, &["show", &format!("{slot}:only-copy.md")]);
    assert_eq!(held, "only here");
    // This folder's own work went to a slot of its own.
    let own: Vec<String> = fx
        .remote_recovery_refs()
        .into_iter()
        .filter(|name| name.ends_with("/working") && *name != slot)
        .collect();
    assert_eq!(own.len(), 1, "{own:?}");
    let junk = git_in(&fx.remote, &["show", &format!("{}:junk.md", own[0])]);
    assert_eq!(junk, "junk");
    assert!(
        git_output(
            &fx.remote,
            &["show", &format!("{}:only-copy.md", own[0])],
            None
        )
        .status
        .code()
            != Some(0),
        "this folder's save took nothing from the other one"
    );
}

/// A turn plants a local recovery ref named like a slot, whose commit builds
/// on another folder's slot tip and names that folder in its trailers. No
/// save or stop pushes it: it is not a name a recovery store makes, so it is
/// not this folder's work, and the other folder's slot stays where it was.
#[test]
fn a_planted_local_ref_never_reaches_another_folders_slot() {
    let fx = Fixture::new();
    let (slot, tip) = another_folders_save(&fx);
    ig(
        &fx.ws,
        &[
            "fetch",
            "-q",
            "origin",
            "+refs/instafy/recovery/*:refs/instafy/recovery/*",
        ],
    );
    let other = slot.split('/').nth(3).expect("the slot's working-set id");
    let message = format!(
        "x\n\nInstafy-Recovery-Kind: unsaved\nInstafy-Origin: {other}\nInstafy-Working-Set: {other}\n"
    );
    let planted = ig(
        &fx.ws,
        &[
            "-c",
            "user.name=Turn",
            "-c",
            "user.email=turn@example.com",
            "commit-tree",
            &format!("{}^{{tree}}", fx.main()),
            "-p",
            &tip,
            "-m",
            &message,
        ],
    );
    ig(
        &fx.ws,
        &[
            "update-ref",
            &format!(
                "{LOCAL_RECOVERY_ROOT}/{}",
                git_service::policy::WORKING_SLOT_NAME
            ),
            &planted,
        ],
    );

    let state = fx.save(PersistReason::Tick);
    assert_eq!(state.error, None, "{state:?}");
    assert_eq!(state.local_only, 0, "{state:?}");
    assert_eq!(remote_rev(&fx, &slot).as_deref(), Some(tip.as_str()));
    // Nor does a stop's flush, which pushes every pending ref it has.
    flush_saving(&fx.ctx(), false, Duration::from_secs(18), Some(&fx.memory)).unwrap();
    assert_eq!(remote_rev(&fx, &slot).as_deref(), Some(tip.as_str()));
    assert!(
        !git_output(&fx.remote, &["cat-file", "-e", &planted], None)
            .status
            .success(),
        "the planted commit reached canonical"
    );
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

/// A clean folder whose HEAD canonical `main` holds stops durably although
/// its process never saved, as with rolling saves off, so eviction may take
/// it. A commit `main` does not hold is never durable.
#[tokio::test(flavor = "multi_thread")]
async fn a_clean_folder_stops_durably_without_ever_saving() {
    let marker = |fx: &Fixture| fs::read(fx.ws.join(crate::server::CLEAN_STOP_MARKER)).ok();

    // Started and stopped with nothing changed and no save.
    let fx = Fixture::new();
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    server.start().await.unwrap();
    server.stop_flushing_workspace().await.unwrap();
    assert_eq!(marker(&fx).as_deref(), Some(DURABLE_MARKER));

    // Saves off: the stop's flush carries no flag, then the shutdown.
    let fx = Fixture::new();
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    server.start().await.unwrap();
    let report = flush_within(&fx.ctx(), false, Duration::from_secs(18)).unwrap();
    assert!(report.working_state.is_none());
    server.stop_flushing_workspace().await.unwrap();
    assert_eq!(marker(&fx).as_deref(), Some(DURABLE_MARKER));

    // A finished commit canonical does not hold: not durable.
    let fx = Fixture::new();
    assert!(fx.state().durable);
    fx.write("notes.md", b"committed, not published\n");
    ig(&fx.ws, &["add", "notes.md"]);
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
            "local only",
        ],
    );
    let state = fx.state();
    assert_eq!(state.unsaved, 0, "{state:?}");
    assert!(!state.durable, "{state:?}");
}

/// A dirty folder whose stop pushed its `unsaved` copy holds nothing only
/// this node has, so the shutdown after that stop leaves the durable-stop
/// marker although no save of the folder's own ever landed: with rolling
/// saves off (the stop's flush carries no flag), and when the stop's own
/// save failed and its held-back copy went out instead.
#[tokio::test(flavor = "multi_thread")]
async fn a_stop_that_pushed_its_unsaved_copy_is_durable_without_a_save() {
    let marker = |fx: &Fixture| fs::read(fx.ws.join(crate::server::CLEAN_STOP_MARKER)).ok();
    let unsaved_on_canonical = |fx: &Fixture| {
        fx.remote_recovery_refs()
            .into_iter()
            .filter(|name| name.contains("-unsaved-"))
            .count()
    };

    // Saves off.
    let fx = Fixture::new();
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    server.start().await.unwrap();
    fx.write("doc.md", b"alpha\nbeta\nedited with saves off\n");
    let report = flush_within(&fx.ctx(), false, Duration::from_secs(18)).unwrap();
    assert!(report.working_state.is_none());
    assert_eq!(report.unpushed_refs, 0, "{report:?}");
    assert_eq!(unsaved_on_canonical(&fx), 1);
    server.stop_flushing_workspace().await.unwrap();
    assert_eq!(marker(&fx).as_deref(), Some(DURABLE_MARKER));
    assert!(fx.local_refs(LOCAL_RECOVERY_ROOT).is_empty());
    assert_eq!(unsaved_on_canonical(&fx), 1);

    // Saves on, and the stop's own save never reaches canonical.
    let fx = Fixture::new();
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    server.start().await.unwrap();
    let memory = server.app_state().unwrap().working_memory;
    fx.write("doc.md", b"alpha\nbeta\nedited when the save fails\n");
    let lost = drop_slot_pushes();
    let report = flush_saving(&fx.ctx(), false, Duration::from_secs(18), Some(&memory)).unwrap();
    drop(lost);
    let working = report.working_state.clone().expect("workingState");
    assert!(!working.durable, "{working:?}");
    assert_eq!(report.unpushed_refs, 0, "{report:?}");
    assert_eq!(unsaved_on_canonical(&fx), 1);
    server.stop_flushing_workspace().await.unwrap();
    assert_eq!(marker(&fx).as_deref(), Some(DURABLE_MARKER));
    assert!(fx.local_refs(LOCAL_RECOVERY_ROOT).is_empty());
}

/// Work a person removed from the slot is not stored again by the stop that
/// finds the removal, nor by the shutdown after it, so the stop is durable
/// and the next start brings nothing back. With rolling saves off the stop's
/// flush pushes the folder's copy whole, removed work included, as it did
/// before rolling saves.
#[tokio::test(flavor = "multi_thread")]
async fn a_removed_slot_does_not_come_back_at_the_stop() {
    let marker = |fx: &Fixture| fs::read(fx.ws.join(crate::server::CLEAN_STOP_MARKER)).ok();
    let unsaved_on_canonical = |fx: &Fixture| -> Vec<String> {
        fx.remote_recovery_refs()
            .into_iter()
            .filter(|name| name.contains("-unsaved-"))
            .collect()
    };
    let saved_then_removed = |fx: &Fixture| {
        fx.write("removed.md", b"removed\n");
        assert_eq!(fx.save(PersistReason::Tick).error, None);
        let (slot, _) = fx.slot().unwrap();
        git_in(&fx.remote, &["update-ref", "-d", &slot]);
    };

    // Nothing else unsaved; the next runtime on the folder stops.
    let mut fx = Fixture::new();
    saved_then_removed(&fx);
    fx.config.origin_id = Uuid::new_v4();
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    server.start().await.unwrap();
    let memory = server.app_state().unwrap().working_memory;
    let report = flush_saving(&fx.ctx(), false, Duration::from_secs(18), Some(&memory)).unwrap();
    let working = report.working_state.clone().expect("workingState");
    assert!(working.durable, "{working:?}");
    assert!(!fx.local_refs(DISMISSED_REF).is_empty(), "the stop saw it");
    server.stop_flushing_workspace().await.unwrap();
    assert!(
        fx.local_refs(LOCAL_RECOVERY_ROOT).is_empty(),
        "the shutdown kept the removed work again"
    );
    assert_eq!(marker(&fx).as_deref(), Some(DURABLE_MARKER));
    fx.config.origin_id = Uuid::new_v4();
    fx.memory = WorkingMemory::default();
    assert_eq!(fx.save(PersistReason::TurnEnd).error, None);
    assert!(unsaved_on_canonical(&fx).is_empty());
    assert!(fx.slot().is_none());

    // Another edit too: the slot takes only that.
    let fx = Fixture::new();
    saved_then_removed(&fx);
    fx.write("kept.md", b"kept\n");
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    server.start().await.unwrap();
    let memory = server.app_state().unwrap().working_memory;
    let report = flush_saving(&fx.ctx(), false, Duration::from_secs(18), Some(&memory)).unwrap();
    let working = report.working_state.clone().expect("workingState");
    assert!(working.durable, "{working:?}");
    assert_eq!(fx.slot_file("kept.md").as_deref(), Some("kept\n"));
    assert!(fx.slot_file("removed.md").is_none());
    server.stop_flushing_workspace().await.unwrap();
    assert!(
        fx.local_refs(LOCAL_RECOVERY_ROOT).is_empty(),
        "the shutdown kept the removed work again"
    );
    assert_eq!(marker(&fx).as_deref(), Some(DURABLE_MARKER));
    assert!(unsaved_on_canonical(&fx).is_empty());

    // Saves off after a save found the removal: the stop's flush carries no
    // flag and pushes the whole copy.
    let fx = Fixture::new();
    saved_then_removed(&fx);
    fx.write("kept.md", b"kept\n");
    assert_eq!(fx.save(PersistReason::Tick).error, None);
    assert!(!fx.local_refs(DISMISSED_REF).is_empty());
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    server.start().await.unwrap();
    let report = flush_within(&fx.ctx(), false, Duration::from_secs(18)).unwrap();
    assert!(report.working_state.is_none());
    assert_eq!(report.unpushed_refs, 0, "{report:?}");
    let copies = unsaved_on_canonical(&fx);
    assert_eq!(copies.len(), 1, "{copies:?}");
    for (path, content) in [("removed.md", "removed"), ("kept.md", "kept")] {
        let held = git_in(&fx.remote, &["show", &format!("{}:{path}", copies[0])]);
        assert_eq!(held, content);
    }
    server.stop_flushing_workspace().await.unwrap();
    assert!(fx.local_refs(LOCAL_RECOVERY_ROOT).is_empty());
    assert_eq!(marker(&fx).as_deref(), Some(DURABLE_MARKER));
    assert_eq!(unsaved_on_canonical(&fx).len(), 1);
}

/// Every shutdown decides the durable-stop marker on its own: one left by
/// a sibling runtime's durable stop, or written by the workspace itself,
/// never survives a shutdown that is not durable, whether its flush kept
/// the work locally or could not run at all.
#[tokio::test(flavor = "multi_thread")]
async fn every_shutdown_decides_the_durable_stop_marker() {
    let marker = |fx: &Fixture| fs::read(fx.ws.join(crate::server::CLEAN_STOP_MARKER)).ok();

    // Two runtimes share the folder; the first stops durably.
    let fx = Fixture::new();
    let mut first = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    first.start().await.unwrap();
    let mut second_config = fx.config.clone();
    second_config.origin_id = Uuid::new_v4();
    let mut second = crate::server::OriginHttpServer::new(second_config).unwrap();
    second.start().await.unwrap();
    let state = first.app_state().unwrap();
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
    first.stop_flushing_workspace().await.unwrap();
    assert_eq!(marker(&fx).as_deref(), Some(DURABLE_MARKER));
    // The second keeps working, then stops with work only this node has.
    fx.write("sibling.md", b"sibling\n");
    second.stop_flushing_workspace().await.unwrap();
    assert_eq!(marker(&fx), None, "a non-durable stop leaves no marker");
    assert!(!fx.local_refs(LOCAL_RECOVERY_ROOT).is_empty());

    // The workspace writes the marker itself during a turn.
    let fx = Fixture::new();
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    server.start().await.unwrap();
    fs::write(fx.ws.join(crate::server::CLEAN_STOP_MARKER), DURABLE_MARKER).unwrap();
    fx.write("notes.md", b"never saved\n");
    server.stop_flushing_workspace().await.unwrap();
    assert_eq!(marker(&fx), None, "a planted marker is not kept");
    assert_eq!(fx.local_refs(LOCAL_RECOVERY_ROOT).len(), 1);

    // ... and the shutdown's flush cannot run at all.
    let fx = Fixture::new();
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    server.start().await.unwrap();
    fs::write(fx.ws.join(crate::server::CLEAN_STOP_MARKER), DURABLE_MARKER).unwrap();
    fx.write("notes.md", b"never saved\n");
    let holder = crate::workspace_lock::try_acquire_workspace_apply_lock(&fx.ws)
        .unwrap()
        .expect("the lock");
    server.stop_flushing_workspace().await.unwrap();
    drop(holder);
    assert_eq!(marker(&fx), None, "a skipped flush keeps no marker");
}

/// A sibling runtime that goes on working after another's durable stop
/// clears that stop's marker as soon as it takes the workspace, so when it
/// then dies without a shutdown of its own, eviction finds no marker.
#[tokio::test(flavor = "multi_thread")]
async fn a_sibling_that_keeps_working_clears_a_durable_stop_marker() {
    let marker = |fx: &Fixture| fs::read(fx.ws.join(crate::server::CLEAN_STOP_MARKER)).ok();
    let fx = Fixture::new();
    let mut first = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    first.start().await.unwrap();
    let mut second_config = fx.config.clone();
    second_config.origin_id = Uuid::new_v4();
    let mut second = crate::server::OriginHttpServer::new(second_config).unwrap();
    let second_address = second.start().await.unwrap().address;
    let state = first.app_state().unwrap();
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
    first.stop_flushing_workspace().await.unwrap();
    assert_eq!(marker(&fx).as_deref(), Some(DURABLE_MARKER));

    // The sibling keeps working and saves through its own route.
    fx.write("sibling.md", b"sibling\n");
    let response = reqwest::Client::new()
        .post(format!("http://{second_address}/workspace/persist"))
        .json(&serde_json::json!({ "reason": "tick" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    // Then it dies: no shutdown flush decides the marker again.
    fx.write("sibling.md", b"sibling, later\n");
    second.stop().await.unwrap();
    assert_eq!(
        marker(&fx),
        None,
        "the earlier stop's verdict outlived the sibling"
    );
}

/// Another runtime on the same folder holding the workspace for its save
/// makes an apply and a sync wait for it instead of failing with 409.
#[tokio::test(flavor = "multi_thread")]
async fn an_apply_and_a_sync_wait_for_another_runtimes_save() {
    use base64::Engine as _;
    use std::io::Write as _;

    let fx = Fixture::new();
    let mut server = crate::server::OriginHttpServer::new(fx.config.clone()).unwrap();
    let address = server.start().await.unwrap().address;
    let client = reqwest::Client::new();
    // The other runtime's save: the same workspace lock, from another
    // open of the lock file, let go after a moment.
    let hold = |ws: &Path| {
        let holder = crate::workspace_lock::try_acquire_workspace_apply_lock(ws)
            .unwrap()
            .expect("the lock");
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            drop(holder);
        })
    };

    let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    archive
        .start_file("applied.md", zip::write::FileOptions::<()>::default())
        .unwrap();
    archive.write_all(b"applied\n").unwrap();
    let archive = archive.finish().unwrap().into_inner();
    let released = hold(&fx.ws);
    let started = Instant::now();
    let response = client
        .post(format!("http://{address}/apply-json"))
        .json(&serde_json::json!({
            "manifest": {
                "projectId": fx.config.project_id,
                "files": [{ "path": "applied.md", "size": 8 }],
                "deletes": [],
            },
            "archiveBase64": base64::engine::general_purpose::STANDARD.encode(archive),
        }))
        .send()
        .await
        .unwrap();
    released.join().unwrap();
    let status = response.status();
    assert!(
        status.is_success(),
        "{status}: {}",
        response.text().await.unwrap()
    );
    assert!(started.elapsed() >= Duration::from_millis(1400));
    assert_eq!(
        fs::read_to_string(fx.ws.join("applied.md")).unwrap(),
        "applied\n"
    );

    let released = hold(&fx.ws);
    let started = Instant::now();
    let response = client
        .post(format!("http://{address}/git/sync"))
        .json(&serde_json::json!({ "paths": ["applied.md"] }))
        .send()
        .await
        .unwrap();
    released.join().unwrap();
    let status = response.status();
    assert!(
        status.is_success(),
        "{status}: {}",
        response.text().await.unwrap()
    );
    assert!(started.elapsed() >= Duration::from_millis(1400));
    assert_eq!(git_in(&fx.remote, &["show", "main:applied.md"]), "applied");
    server.stop().await.unwrap();
}

/// A route-level save lets the workspace go while it asks for write
/// access; a plan taken before another save moved the slot is taken again.
#[test]
fn a_plan_older_than_the_last_save_is_not_executed() {
    let fx = Fixture::new();
    fx.write("notes.md", b"first\n");
    let ctx = fx.ctx();
    let mut waiting = publisher(&ctx, TICK_BUDGET);
    let plan = waiting
        .plan_working_save(PersistReason::Tick, None)
        .unwrap();
    assert!(waiting.plan_still_current(&plan).unwrap());
    fx.write("notes.md", b"second\n");
    assert_eq!(fx.save(PersistReason::Tick).error, None);
    assert!(!waiting.plan_still_current(&plan).unwrap());
}

/// A plan taken before the turn published what it holds (while the save
/// asked for write access) is taken again, so the slot never gets work
/// `main` already has.
#[test]
fn a_plan_taken_before_the_turn_published_is_not_executed() {
    let fx = Fixture::new();
    fx.write("notes.md", b"published by the turn\n");
    let ctx = fx.ctx();
    let mut waiting = publisher(&ctx, TICK_BUDGET);
    let plan = waiting
        .plan_working_save(PersistReason::Tick, None)
        .unwrap();
    assert!(waiting.plan_still_current(&plan).unwrap());
    // The turn's own publish: HEAD and canonical `main` move, the folder is
    // clean, the record is untouched.
    ig(&fx.ws, &["add", "notes.md"]);
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
            "the turn",
        ],
    );
    ig(&fx.ws, &["push", "-q", "origin", "HEAD:main"]);
    ig(&fx.ws, &["fetch", "-q", "origin"]);
    assert!(!waiting.plan_still_current(&plan).unwrap());
    // Taken again, the save has nothing to send.
    assert_eq!(fx.save(PersistReason::Tick).error, None);
    assert_eq!(fx.slot(), None);
}

/// The agent's own commit (`git add -A && git commit`) can land while a
/// save takes its snapshot: before the save lists the folder, or after.
/// Either way the snapshot holds the committed work, so a save never
/// deletes or shrinks the slot, or confirms a state, that lacks it: with no
/// slot yet, with one holding earlier work, and with the commit between the
/// listing and the read of HEAD.
#[test]
fn a_commit_that_lands_while_a_save_looks_stays_saved() {
    for (slot_first, after_listing) in [(false, false), (true, false), (true, true)] {
        let case = format!("slot first: {slot_first}, after the listing: {after_listing}");
        let fx = Fixture::new();
        if slot_first {
            fx.write("notes.md", b"saved\n");
            assert_eq!(fx.save(PersistReason::Tick).error, None, "{case}");
            assert_eq!(fx.slot_file("notes.md").as_deref(), Some("saved\n"));
        }
        fx.write("other.md", b"committed by the agent\n");
        let committed = fx.root.join("committed");
        let listing = fx.root.join("listing");
        let commit = format!(
            "(unset $(env | sed -n 's/^\\(GIT_[A-Z_]*\\)=.*/\\1/p'); \
             export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1; cd '{ws}' && \
             git --git-dir .instafy/.git --work-tree . add -A && \
             git --git-dir .instafy/.git --work-tree . -c user.name=Agent \
             -c user.email=agent@instafy.dev commit -q -m agent) || exit 1",
            ws = fx.ws.display()
        );
        let prelude = if after_listing {
            format!(
                "case \" $* \" in *\" status \"*) if [ ! -e '{committed}' ]; then : > '{committed}'; \
                 git \"$@\" > '{listing}'; listed=$?; {commit}; cat '{listing}'; exit $listed; fi ;; esac",
                committed = committed.display(),
                listing = listing.display(),
            )
        } else {
            format!(
                "case \" $* \" in *\" status \"*) if [ ! -e '{committed}' ]; then : > '{committed}'; \
                 {commit}; fi ;; esac",
                committed = committed.display(),
            )
        };
        let wrapper = GitWrapper::install(&fx.root, &prelude);
        let state = fx.save(PersistReason::Tick);
        drop(wrapper);
        assert!(committed.exists(), "{case}: the save listed the folder");
        assert_eq!(ig(&fx.ws, &["log", "-1", "--format=%s"]), "agent", "{case}");
        assert_eq!(state.error, None, "{case}: {state:?}");
        assert_eq!(
            fx.slot_file("other.md").as_deref(),
            Some("committed by the agent\n"),
            "{case}: {state:?}"
        );
        if slot_first {
            assert_eq!(
                fx.slot_file("notes.md").as_deref(),
                Some("saved\n"),
                "{case}: {state:?}"
            );
        }
        assert_eq!(fx.record(), fx.slot().map(|(_, rev)| rev), "{case}");
    }
}

/// What one save costs in git processes, the same for 20 dirty files as for
/// 200: the config of the checkout is checked before every git command but
/// parsed only when it changed, and each save reads what it needs once.
#[test]
fn a_save_runs_a_bounded_number_of_git_processes() {
    let fx = Fixture::new();
    let log = fx.root.join("git.log");
    let _wrapper = GitWrapper::install(&fx.root, &format!("echo \"$*\" >> '{}'", log.display()));
    let counted = || {
        let text = fs::read_to_string(&log).unwrap_or_default();
        let _ = fs::remove_file(&log);
        let parses = text
            .lines()
            .filter(|line| line.contains("config --file .instafy/.git/config"))
            .count();
        (text.lines().count(), parses)
    };
    for index in 0..20 {
        fx.write(&format!("f{index}.md"), b"x\n");
    }
    let _ = fx.state();
    let (state, _) = counted();
    fx.save(PersistReason::Tick);
    let (first, first_parses) = counted();
    fx.write("f0.md", b"y\n");
    fx.save(PersistReason::Tick);
    let (replacing, replacing_parses) = counted();
    fx.save(PersistReason::TurnEnd);
    let (turn_end, turn_end_parses) = counted();
    let costs = format!(
        "state {state}, first tick {first} ({first_parses} config parses), replacing tick \
         {replacing} ({replacing_parses}), turn end with nothing new {turn_end} \
         ({turn_end_parses})"
    );
    assert!(state <= 6, "{costs}");
    assert!(first <= 40 && replacing <= 40, "{costs}");
    assert!(turn_end <= 25, "{costs}");
    // Only the first save writes the config (its working-set seed).
    assert!(
        first_parses <= 1 && replacing_parses == 0 && turn_end_parses == 0,
        "{costs}"
    );
}
