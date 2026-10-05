//! End-to-end publish scenarios against real git: a bare canonical remote
//! (optionally running the shard's real update hook, rendered from
//! git-service), a workspace checkout, and a second clone standing in for
//! everyone else who writes to `main`.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use reqwest::Url;
use tempfile::TempDir;
use uuid::Uuid;

use crate::config::ServerConfig;
use crate::git::ensure_git_checkout;
use crate::publish::{
    flush, publish, refresh, revert_commit, PublishContext, PublishReport, PublishRequest,
    Selection, SyncStatus,
};
use crate::publish_policy::RejectReason;
use crate::push::{clear_push_hook, set_push_hook, PushHookAction};
use crate::recovery::{
    LOCAL_RECOVERY_DISMISSED_ROOT, LOCAL_RECOVERY_PUSHED_ROOT, LOCAL_RECOVERY_ROOT,
};
use crate::test_support::{git_in, git_output, ig, install_shard_hook};
use crate::workspace_git::GitIdentity;

const README: &str = "one\ntwo\nthree\nfour\nfive\n";

struct Scenario {
    _dir: TempDir,
    root: PathBuf,
    remote: PathBuf,
    ws: PathBuf,
    other: PathBuf,
    config: ServerConfig,
}

#[derive(Default)]
struct Options {
    /// Run the shard's real update hook on the remote.
    hook: bool,
    /// Environment for the hook (GIT_DENY_PATHS, GIT_MAX_BLOB_BYTES).
    hook_env: Vec<(&'static str, &'static str)>,
    /// A Desktop folder instead of a hosted checkout.
    desktop: bool,
    /// Start from an empty remote.
    empty: bool,
    /// Extra files in the seed commit.
    seed: Vec<(&'static str, Vec<u8>)>,
}

impl Scenario {
    fn new(options: Options) -> Self {
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
        if options.hook {
            install_shard_hook(&remote, &options.hook_env);
        }
        if !options.empty {
            let seed = root.join("seed");
            fs::create_dir_all(&seed).unwrap();
            git_in(&seed, &["init", "-q", "-b", "main"]);
            configure_identity(&seed, "Seed");
            write(&seed, "README.md", README.as_bytes());
            write(&seed, "doc.md", b"alpha\nbeta\ngamma\ndelta\n");
            write(&seed, "logo.bin", &[0u8, 159, 146, 150, 0, 1, 2, 3]);
            for (path, bytes) in &options.seed {
                write(&seed, path, bytes);
            }
            git_in(&seed, &["add", "-A"]);
            git_in(&seed, &["commit", "-q", "-m", "init"]);
            git_in(&seed, &["push", "-q", remote.to_str().unwrap(), "main"]);
        }
        let ws = root.join("ws");
        fs::create_dir_all(&ws).unwrap();
        let config = ServerConfig {
            project_id: Uuid::new_v4(),
            origin_id: Uuid::new_v4(),
            workspace_root: ws.clone(),
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
            hosted_checkout: !options.desktop,
        };
        ensure_git_checkout(&config, None).expect("initial checkout");
        let other = root.join("other");
        if options.empty {
            fs::create_dir_all(&other).unwrap();
            git_in(&other, &["init", "-q", "-b", "main"]);
            git_in(
                &other,
                &["remote", "add", "origin", remote.to_str().unwrap()],
            );
        } else {
            git_in(
                &root,
                &[
                    "clone",
                    "-q",
                    "--branch",
                    "main",
                    remote.to_str().unwrap(),
                    other.to_str().unwrap(),
                ],
            );
        }
        configure_identity(&other, "Studio User");
        Scenario {
            _dir: dir,
            root,
            remote,
            ws,
            other,
            config,
        }
    }

    fn ctx(&self, can_write: bool) -> PublishContext<'_> {
        PublishContext {
            config: &self.config,
            workspace_root: &self.ws,
            token: None,
            can_write,
        }
    }

    fn publish(&self, selection: Selection) -> PublishReport {
        publish(
            &self.ctx(true),
            PublishRequest {
                selection,
                message: "instafy: agent sync".to_string(),
                author: None,
                budget: Duration::from_secs(30),
            },
        )
        .expect("publish")
    }

    fn publish_paths(&self, paths: &[&str]) -> PublishReport {
        self.publish(Selection::Paths(
            paths.iter().map(|p| p.to_string()).collect(),
        ))
    }

    fn write(&self, path: &str, bytes: &[u8]) {
        write(&self.ws, path, bytes);
    }

    /// Commit in the workspace as the agent would, with its own identity.
    fn agent_commit(&self, paths: &[&str], message: &str) -> String {
        let mut args = vec!["add", "-A", "--"];
        args.extend_from_slice(paths);
        ig(&self.ws, &args);
        ig(
            &self.ws,
            &[
                "-c",
                "user.name=Ada Agent",
                "-c",
                "user.email=ada@example.com",
                "commit",
                "-q",
                "--no-gpg-sign",
                "-m",
                message,
            ],
        );
        ig(&self.ws, &["rev-parse", "HEAD"])
    }

    /// Someone else saves `files` to canonical main (None deletes).
    fn push_other(&self, files: &[(&str, Option<&[u8]>)], message: &str) -> String {
        let _ = git_output(
            &self.other,
            &["pull", "-q", "--ff-only", "origin", "main"],
            None,
        );
        for (path, contents) in files {
            match contents {
                Some(bytes) => write(&self.other, path, bytes),
                None => fs::remove_file(self.other.join(path)).unwrap(),
            }
        }
        git_in(&self.other, &["add", "-A"]);
        git_in(&self.other, &["commit", "-q", "-m", message]);
        git_in(&self.other, &["push", "-q", "origin", "main"]);
        git_in(&self.other, &["rev-parse", "HEAD"])
    }

    fn main(&self) -> String {
        git_in(&self.remote, &["rev-parse", "main"])
    }

    fn remote_file(&self, path: &str) -> Option<String> {
        let output = git_output(&self.remote, &["show", &format!("main:{path}")], None);
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).to_string())
    }

    fn remote_log(&self) -> String {
        git_in(&self.remote, &["log", "--format=%H %an <%ae> | %s", "main"])
    }

    /// Whether any commit on any remote ref has a file containing `needle`.
    fn anywhere_on_remote(&self, needle: &str) -> bool {
        let revs = git_in(&self.remote, &["rev-list", "--all"]);
        revs.lines().any(|rev| {
            git_output(&self.remote, &["grep", "-q", "-F", needle, rev], None)
                .status
                .success()
        })
    }

    /// Whether `path` exists in any commit on any remote ref.
    fn path_anywhere_on_remote(&self, path: &str) -> bool {
        let revs = git_in(&self.remote, &["rev-list", "--all"]);
        revs.lines().any(|rev| {
            git_output(
                &self.remote,
                &["cat-file", "-e", &format!("{rev}:{path}")],
                None,
            )
            .status
            .success()
        })
    }

    fn remote_refs(&self, prefix: &str) -> Vec<(String, String)> {
        git_in(
            &self.remote,
            &["for-each-ref", "--format=%(refname) %(objectname)", prefix],
        )
        .lines()
        .filter_map(|line| {
            let (name, rev) = line.split_once(' ')?;
            Some((name.to_string(), rev.to_string()))
        })
        .collect()
    }

    fn local_refs(&self, prefix: &str) -> Vec<(String, String)> {
        ig(
            &self.ws,
            &["for-each-ref", "--format=%(refname) %(objectname)", prefix],
        )
        .lines()
        .filter_map(|line| {
            let (name, rev) = line.split_once(' ')?;
            Some((name.to_string(), rev.to_string()))
        })
        .collect()
    }

    fn disk(&self, path: &str) -> Option<String> {
        fs::read_to_string(self.ws.join(path)).ok()
    }

    fn head(&self) -> String {
        ig(&self.ws, &["rev-parse", "HEAD"])
    }

    /// `git status`, without the `.instafy/` metadata folder that git 2.34
    /// lists as untracked (newer git skips its own repository directory).
    fn status(&self) -> String {
        ig(
            &self.ws,
            &["status", "--porcelain", "--untracked-files=all"],
        )
        .lines()
        .filter(|line| !line.contains(" .instafy/"))
        .collect::<Vec<_>>()
        .join("\n")
    }

    /// The file at `path` in the commit a remote recovery ref names.
    fn recovery_file(&self, reference: &str, path: &str) -> Option<String> {
        let output = git_output(
            &self.remote,
            &["show", &format!("{reference}:{path}")],
            None,
        );
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).to_string())
    }
}

fn configure_identity(dir: &Path, name: &str) {
    git_in(dir, &["config", "user.name", name]);
    git_in(
        dir,
        &[
            "config",
            "user.email",
            &format!("{}@instafy.dev", name.replace(' ', ".")),
        ],
    );
}

fn write(dir: &Path, path: &str, bytes: &[u8]) {
    let target = dir.join(path);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(target, bytes).unwrap();
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

// ---------------------------------------------------------------------------
// Ported from the round-3 verification probes.
// ---------------------------------------------------------------------------

/// r3a: an overlapping edit keeps main's line and parks the agent's version
/// on a conflict ref; the agent's other new file reaches main.
#[test]
fn r3a_overlap_publishes_the_rest_and_parks_the_conflict() {
    let sc = Scenario::new(Options {
        hook: true,
        ..Options::default()
    });
    sc.write("README.md", b"one\nTWO BY AGENT\nthree\nfour\nfive\n");
    sc.write("feature.rs", b"fn agent_feature() {}\n");
    sc.push_other(
        &[("README.md", Some(b"one\ntwo by user\nthree\nfour\nfive\n"))],
        "Save version: README.md",
    );

    let report = sc.publish_paths(&["README.md", "feature.rs"]);
    assert_eq!(report.git_sync_status, SyncStatus::Partial);
    assert_eq!(report.conflicted_paths, vec!["README.md".to_string()]);
    assert_eq!(
        sc.remote_file("feature.rs").as_deref(),
        Some("fn agent_feature() {}\n")
    );
    assert!(sc.remote_file("README.md").unwrap().contains("two by user"));
    let reference = report.recovery_ref.clone().expect("conflict ref");
    assert!(reference.starts_with(&format!("refs/instafy/recovery/{}/", sc.config.origin_id)));
    assert!(reference.contains("-conflict-"));
    assert!(sc
        .recovery_file(&reference, "README.md")
        .unwrap()
        .contains("TWO BY AGENT"));
    // The hosted checkout follows main; the agent reads its version from the ref.
    assert!(report.checkout_moved);
    assert!(sc.disk("README.md").unwrap().contains("two by user"));
    assert_eq!(
        ig(&sc.ws, &["show", &format!("{reference}:README.md")]),
        "one\nTWO BY AGENT\nthree\nfour\nfive"
    );
    // A stop afterwards finds nothing left to keep.
    let flushed = flush(&sc.ctx(true), false).unwrap();
    assert!(flushed.recovery_refs.is_empty(), "{flushed:?}");
}

/// r3a2: after one overlapping turn, the next turn's new file publishes.
#[test]
fn r3a2_later_checkpoints_still_publish_after_an_overlap() {
    let sc = Scenario::new(Options::default());
    sc.write("README.md", b"one\nTWO BY AGENT\nthree\nfour\nfive\n");
    sc.push_other(
        &[("README.md", Some(b"one\ntwo by user\nthree\nfour\nfive\n"))],
        "Save version: README.md",
    );
    let first = sc.publish_paths(&["README.md"]);
    assert_eq!(first.conflicted_paths, vec!["README.md".to_string()]);
    sc.write("src/turn2.rs", b"fn turn_two() {}\n");
    let second = sc.publish_paths(&["src/turn2.rs"]);
    assert_eq!(second.git_sync_status, SyncStatus::Published);
    assert_eq!(
        sc.remote_file("src/turn2.rs").as_deref(),
        Some("fn turn_two() {}\n")
    );
    assert!(sc.remote_file("README.md").unwrap().contains("two by user"));
}

/// r3b: the agent's own commit reaches main unchanged (id, author, message)
/// under one merge.
#[test]
fn r3b_agent_commit_keeps_its_id_author_and_message() {
    let sc = Scenario::new(Options {
        hook: true,
        ..Options::default()
    });
    sc.write("login.html", b"<form>login</form>\n");
    let agent_commit = sc.agent_commit(&["login.html"], "feat: add login page");
    sc.push_other(
        &[("notes/plan.md", Some(b"plan\n"))],
        "Save version: notes/plan.md",
    );
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nepsilon\n");

    let report = sc.publish_paths(&["doc.md"]);
    assert_eq!(report.git_sync_status, SyncStatus::Published);
    let log = sc.remote_log();
    assert!(
        log.contains(&format!(
            "{agent_commit} Ada Agent <ada@example.com> | feat: add login page"
        )),
        "{log}"
    );
    assert_eq!(
        sc.remote_file("login.html").as_deref(),
        Some("<form>login</form>\n")
    );
    assert!(sc.remote_file("doc.md").unwrap().contains("epsilon"));
    assert_eq!(sc.remote_file("notes/plan.md").as_deref(), Some("plan\n"));
    // One merge commit, with both parents.
    let parents = git_in(&sc.remote, &["rev-list", "--parents", "-n", "1", "main"]);
    assert_eq!(parents.split(' ').count(), 3, "{parents}");
}

/// r3b2: a stop publishes a finished agent commit by merge, but never the
/// dirty edit next to it; that goes to an unsaved-work ref.
#[test]
fn r3b2_flush_publishes_finished_commits_and_parks_dirty_edits() {
    let sc = Scenario::new(Options {
        hook: true,
        ..Options::default()
    });
    sc.write("login.html", b"<form>login</form>\n");
    let agent_commit = sc.agent_commit(&["login.html"], "feat: add login page");
    sc.push_other(
        &[("notes/plan.md", Some(b"plan\n"))],
        "Save version: notes/plan.md",
    );
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nepsilon\n");

    let report = flush(&sc.ctx(true), false).unwrap();
    let log = sc.remote_log();
    assert!(
        log.contains(&format!(
            "{agent_commit} Ada Agent <ada@example.com> | feat: add login page"
        )),
        "{log}"
    );
    assert_eq!(
        sc.remote_file("doc.md").as_deref(),
        Some("alpha\nbeta\ngamma\ndelta\n"),
        "a dirty edit reached main from a flush"
    );
    assert_eq!(report.recovery_refs.len(), 1, "{report:?}");
    let parked = &report.recovery_refs[0];
    assert!(parked.pushed && parked.name.contains("-unsaved-"));
    assert!(sc
        .recovery_file(&parked.reference, "doc.md")
        .unwrap()
        .contains("epsilon"));
    assert_eq!(report.unpushed_refs, 0);
}

/// r3c: nothing depends on `merge-tree --write-tree` (git 2.38+): a git
/// that rejects it still publishes a diverged checkout.
#[test]
fn r3c_publish_works_without_merge_tree_write_tree() {
    use std::os::unix::fs::PermissionsExt as _;
    let sc = Scenario::new(Options::default());
    let real_git = git_in(&sc.root, &["--exec-path"]);
    let real_git = Path::new(&real_git).join("git");
    let wrapper = sc.root.join("old-git");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = merge-tree ]; then\n    echo 'usage: git merge-tree <base-tree> <branch1> <branch2>' >&2\n    exit 129\n  fi\ndone\nexec '{}' \"$@\"\n",
            real_git.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    crate::git::GIT_PROGRAM_OVERRIDE.with(|program| *program.borrow_mut() = Some(wrapper));

    sc.write("feature.rs", b"fn agent_feature() {}\n");
    sc.push_other(
        &[("notes/plan.md", Some(b"plan\n"))],
        "Save version: notes/plan.md",
    );
    let report = sc.publish_paths(&["feature.rs"]);
    crate::git::GIT_PROGRAM_OVERRIDE.with(|program| *program.borrow_mut() = None);
    assert_eq!(report.git_sync_status, SyncStatus::Published);
    assert!(sc.remote_file("feature.rs").is_some());
    assert!(sc.remote_file("notes/plan.md").is_some());
}

/// r3d + new 11: a root commit made on an empty remote is replayed onto the
/// first commit someone else pushed, never pushed as a second root, and a
/// later publish does not replay it again.
#[test]
fn r3d_unborn_race_replays_onto_the_winner_once() {
    let sc = Scenario::new(Options {
        hook: true,
        empty: true,
        ..Options::default()
    });
    sc.write("AGENTS.md", b"runtime template\n");
    sc.agent_commit(&["AGENTS.md"], "instafy: bootstrap workspace memory");
    write(&sc.other, "README.md", b"first\n");
    git_in(&sc.other, &["add", "-A"]);
    git_in(&sc.other, &["commit", "-q", "-m", "first"]);
    git_in(&sc.other, &["push", "-q", "origin", "main"]);

    sc.write("feature.rs", b"fn agent_feature() {}\n");
    let report = sc.publish_paths(&["feature.rs"]);
    assert_eq!(report.git_sync_status, SyncStatus::Published, "{report:?}");
    let roots = git_in(&sc.remote, &["rev-list", "--max-parents=0", "main"]);
    assert_eq!(roots.lines().count(), 1, "{roots}");
    assert_eq!(sc.remote_file("README.md").as_deref(), Some("first\n"));
    assert_eq!(
        sc.remote_file("AGENTS.md").as_deref(),
        Some("runtime template\n")
    );
    assert_eq!(
        sc.remote_file("feature.rs").as_deref(),
        Some("fn agent_feature() {}\n")
    );
    let log = sc.remote_log();
    assert!(
        log.contains("Ada Agent <ada@example.com> | instafy: bootstrap workspace memory"),
        "{log}"
    );

    // A later publish neither replays the old commits nor duplicates them.
    let before = git_in(&sc.remote, &["rev-list", "--count", "main"]);
    sc.write("more.rs", b"fn more() {}\n");
    let again = sc.publish_paths(&["more.rs"]);
    assert_eq!(again.git_sync_status, SyncStatus::Published);
    let after = git_in(&sc.remote, &["rev-list", "--count", "main"]);
    assert_eq!(
        after.parse::<usize>().unwrap(),
        before.parse::<usize>().unwrap() + 1,
        "{}",
        sc.remote_log()
    );
}

/// r3f: a permanent refusal keeps everything (main unchanged, files on
/// disk, work on a local ref); once allowed, a save publishes all of it and
/// the parked copy is retired.
#[test]
fn r3f_refused_save_keeps_everything_and_succeeds_later() {
    use std::os::unix::fs::PermissionsExt as _;
    let sc = Scenario::new(Options::default());
    sc.write("README.md", b"one\ntwo\nthree\nfour\nfive\nuser line\n");
    sc.write("draft.md", b"unsaved draft\n");
    sc.push_other(
        &[
            ("notes/p.md", Some(b"persistence check\n")),
            ("doc.md", Some(b"alpha\nbeta\ngamma\ndelta\nruntime line\n")),
        ],
        "runtime work",
    );
    let hook = sc.remote.join("hooks").join("pre-receive");
    fs::write(&hook, "#!/bin/sh\necho 'policy says no' >&2\nexit 1\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    let tip = sc.main();

    let refused = sc.publish_paths(&["README.md"]);
    assert_eq!(refused.git_sync_status, SyncStatus::Unpublished);
    assert!(!refused.retryable);
    assert_eq!(sc.main(), tip);
    assert!(sc.disk("README.md").unwrap().contains("user line"));
    assert_eq!(sc.disk("draft.md").as_deref(), Some("unsaved draft\n"));
    assert_eq!(sc.local_refs(LOCAL_RECOVERY_ROOT).len(), 1);
    assert_eq!(refused.unpushed_refs, 1);

    fs::remove_file(&hook).unwrap();
    let saved = sc.publish(Selection::AllDirty);
    assert_eq!(saved.git_sync_status, SyncStatus::Published, "{saved:?}");
    assert!(sc.remote_file("README.md").unwrap().contains("user line"));
    assert_eq!(
        sc.remote_file("notes/p.md").as_deref(),
        Some("persistence check\n")
    );
    assert!(sc.remote_file("doc.md").unwrap().contains("runtime line"));
    assert_eq!(
        sc.remote_file("draft.md").as_deref(),
        Some("unsaved draft\n")
    );
    // The parked copy was pushed first, then retired once its commits landed.
    assert!(sc.local_refs("refs/instafy/local-recovery").is_empty());
    assert!(sc.remote_refs("refs/instafy/recovery/").is_empty());
}

/// r3g: another writer pushes between the fetch and the push; the publish
/// fetches again and merges.
#[test]
fn r3g_publish_retries_after_losing_a_race() {
    let sc = Scenario::new(Options::default());
    sc.write("README.md", b"one\ntwo\nthree\nfour\nfive\nuser line\n");
    sc.push_other(
        &[("notes/p.md", Some(b"first runtime push\n"))],
        "runtime 1",
    );
    write(
        &sc.other,
        "doc.md",
        b"alpha\nbeta\ngamma\ndelta\nracing runtime line\n",
    );
    write(&sc.other, "notes/q.md", b"racing runtime file\n");
    git_in(&sc.other, &["add", "-A"]);
    git_in(&sc.other, &["commit", "-q", "-m", "runtime 2 (racing)"]);
    let other = sc.other.clone();
    let mut raced = false;
    let _guard = with_push_hook(move |specs| {
        if !raced && specs.iter().any(|spec| spec.ends_with(":refs/heads/main")) {
            raced = true;
            git_in(&other, &["push", "-q", "origin", "main"]);
        }
        PushHookAction::Proceed
    });

    let report = sc.publish_paths(&["README.md"]);
    assert_eq!(report.git_sync_status, SyncStatus::Published, "{report:?}");
    assert!(sc.remote_file("README.md").unwrap().contains("user line"));
    assert!(sc
        .remote_file("doc.md")
        .unwrap()
        .contains("racing runtime line"));
    assert_eq!(
        sc.remote_file("notes/q.md").as_deref(),
        Some("racing runtime file\n")
    );
    assert_eq!(
        sc.remote_file("notes/p.md").as_deref(),
        Some("first runtime push\n")
    );
}

/// r3h: the push lands but its response is lost; the ancestor check sees it
/// and nothing is pushed twice.
#[test]
fn r3h_lost_push_response_is_detected_without_duplicates() {
    let sc = Scenario::new(Options::default());
    sc.write("README.md", b"one\ntwo\nthree\nfour\nfive\nuser line\n");
    sc.push_other(&[("notes/p.md", Some(b"runtime push\n"))], "runtime 1");
    let mut lost = false;
    let _guard = with_push_hook(move |specs| {
        if !lost && specs.iter().any(|spec| spec.ends_with(":refs/heads/main")) {
            lost = true;
            return PushHookAction::LoseResponse;
        }
        PushHookAction::Proceed
    });
    let report = sc.publish_paths(&["README.md"]);
    assert_eq!(report.git_sync_status, SyncStatus::Published, "{report:?}");
    assert_eq!(report.rev.as_deref(), Some(sc.main().as_str()));
    let merges = git_in(&sc.remote, &["rev-list", "--merges", "--count", "main"]);
    assert_eq!(merges, "1", "{}", sc.remote_log());

    sc.push_other(&[("notes/q.md", Some(b"runtime push 2\n"))], "runtime 2");
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nagain\n");
    let again = sc.publish(Selection::AllDirty);
    assert_eq!(again.git_sync_status, SyncStatus::Published);
    assert!(sc.status().is_empty(), "{}", sc.status());
    assert!(sc.remote_file("README.md").unwrap().contains("user line"));
    assert_eq!(
        sc.remote_file("notes/q.md").as_deref(),
        Some("runtime push 2\n")
    );
}

/// r3i: an untracked copy nobody reported never replaces what a person saved.
#[test]
fn r3i_checkpoint_of_another_file_keeps_the_saved_agents_md() {
    let sc = Scenario::new(Options::default());
    sc.write("AGENTS.md", b"runtime copy\n");
    sc.push_other(
        &[(
            "AGENTS.md",
            Some(b"# Team rules\nDeploy only on Fridays.\n"),
        )],
        "Save version: AGENTS.md",
    );
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nagent\n");
    let report = sc.publish_paths(&["doc.md"]);
    assert_eq!(report.git_sync_status, SyncStatus::Published);
    assert_eq!(
        sc.remote_file("AGENTS.md").as_deref(),
        Some("# Team rules\nDeploy only on Fridays.\n")
    );
}

/// r3i2: the same, followed by a stop: the runtime copy is parked, not saved.
#[test]
fn r3i2_checkpoint_then_flush_keeps_the_saved_agents_md() {
    let sc = Scenario::new(Options::default());
    sc.write("AGENTS.md", b"runtime copy\n");
    sc.push_other(
        &[(
            "AGENTS.md",
            Some(b"# Team rules\nDeploy only on Fridays.\n"),
        )],
        "Save version: AGENTS.md",
    );
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nagent\n");
    sc.publish_paths(&["doc.md"]);
    let report = flush(&sc.ctx(true), false).unwrap();
    assert_eq!(
        sc.remote_file("AGENTS.md").as_deref(),
        Some("# Team rules\nDeploy only on Fridays.\n")
    );
    assert_eq!(report.recovery_refs.len(), 1, "{report:?}");
    assert_eq!(
        sc.recovery_file(&report.recovery_refs[0].reference, "AGENTS.md")
            .as_deref(),
        Some("runtime copy\n")
    );
}

// ---------------------------------------------------------------------------
// New cases.
// ---------------------------------------------------------------------------

/// 1: a publish that could not move the checkout (an unsaved edit overlaps
/// main) is never re-sent: a person's revert on main stays reverted.
#[test]
fn n01_revert_after_a_stuck_publish_stays_reverted() {
    let sc = Scenario::new(Options::default());
    sc.push_other(
        &[("doc.md", Some(b"alpha\nbeta\ngamma\ndelta\nremote\n"))],
        "remote doc",
    );
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nlocal unsaved\n");
    sc.write("README.md", b"one\ntwo\nthree\nfour\nfive\nagent line\n");
    let report = sc.publish_paths(&["README.md"]);
    assert_eq!(report.git_sync_status, SyncStatus::Published);
    assert!(
        !report.checkout_moved,
        "the overlapping edit must block the move"
    );
    assert!(sc.remote_file("README.md").unwrap().contains("agent line"));

    // A person reverts the README change on main.
    sc.push_other(&[("README.md", Some(README.as_bytes()))], "Revert README");
    let refreshed = refresh(&sc.ctx(true)).unwrap();
    assert_ne!(refreshed.git_sync_status, SyncStatus::Unpublished);
    sc.write("other.rs", b"fn other() {}\n");
    sc.publish_paths(&["other.rs"]);
    assert_eq!(sc.remote_file("README.md").as_deref(), Some(README));
    assert_eq!(
        sc.remote_file("other.rs").as_deref(),
        Some("fn other() {}\n")
    );
}

/// 2: the same for a deleted file.
#[test]
fn n02_restored_file_stays_after_a_stuck_publish_deleted_it() {
    let sc = Scenario::new(Options::default());
    sc.push_other(
        &[("doc.md", Some(b"alpha\nbeta\ngamma\ndelta\nremote\n"))],
        "remote doc",
    );
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nlocal unsaved\n");
    fs::remove_file(sc.ws.join("logo.bin")).unwrap();
    let report = sc.publish_paths(&["logo.bin"]);
    assert_eq!(report.git_sync_status, SyncStatus::Published);
    assert!(!report.checkout_moved);
    assert!(sc.remote_file("logo.bin").is_none());
    sc.push_other(
        &[("logo.bin", Some(&[0u8, 159, 146, 150, 0, 1, 2, 3]))],
        "Restore logo",
    );
    refresh(&sc.ctx(true)).unwrap();
    sc.write("other.rs", b"fn other() {}\n");
    sc.publish_paths(&["other.rs"]);
    assert!(
        sc.remote_file("logo.bin").is_some(),
        "the old deletion came back"
    );
}

/// 3: hundreds of local commits publish with one merge, quickly.
#[test]
fn n03_three_hundred_local_commits_publish_with_one_merge() {
    let sc = Scenario::new(Options::default());
    let base = sc.head();
    let mut parent = base.clone();
    for index in 0..300 {
        let blob = git_output(
            &sc.ws,
            &["--git-dir", ".instafy/.git", "hash-object", "-w", "--stdin"],
            Some(format!("{index}\n").as_bytes()),
        );
        let blob = String::from_utf8_lossy(&blob.stdout).trim().to_string();
        let index_file = sc.ws.join(".instafy/.git/n03-index");
        let env_index = index_file.to_string_lossy().to_string();
        let run = |args: &[&str], stdin: Option<&[u8]>| {
            let mut command = std::process::Command::new("git");
            command
                .current_dir(&sc.ws)
                .env("GIT_INDEX_FILE", &env_index)
                .env("GIT_AUTHOR_NAME", "Ada Agent")
                .env("GIT_AUTHOR_EMAIL", "ada@example.com")
                .env("GIT_COMMITTER_NAME", "Ada Agent")
                .env("GIT_COMMITTER_EMAIL", "ada@example.com")
                .args(["--git-dir", ".instafy/.git"])
                .args(args)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped());
            let mut child = command.spawn().unwrap();
            if let Some(input) = stdin {
                use std::io::Write as _;
                child.stdin.take().unwrap().write_all(input).unwrap();
            } else {
                drop(child.stdin.take());
            }
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        run(&["read-tree", &parent], None);
        run(
            &[
                "update-index",
                "--add",
                "--cacheinfo",
                &format!("100644,{blob},gen/{index}.txt"),
            ],
            None,
        );
        let tree = run(&["write-tree"], None);
        parent = run(
            &["commit-tree", &tree, "-p", &parent],
            Some(format!("agent step {index}\n").as_bytes()),
        );
    }
    ig(&sc.ws, &["update-ref", "HEAD", &parent]);
    ig(&sc.ws, &["reset", "-q", "--", "."]);
    ig(&sc.ws, &["checkout", "-q", "--", "."]);
    sc.push_other(&[("notes/plan.md", Some(b"plan\n"))], "remote moved");

    let started = Instant::now();
    let report = sc.publish(Selection::None);
    let elapsed = started.elapsed();
    assert_eq!(report.git_sync_status, SyncStatus::Published, "{report:?}");
    assert!(elapsed < Duration::from_secs(15), "took {elapsed:?}");
    assert!(git_output(
        &sc.remote,
        &["merge-base", "--is-ancestor", &parent, "main"],
        None
    )
    .status
    .success());
    let merges = git_in(&sc.remote, &["rev-list", "--merges", "--count", "main"]);
    assert_eq!(merges, "1");
    assert_eq!(sc.remote_file("gen/299.txt").as_deref(), Some("299\n"));
}

/// 4: a side-branch merge in local history reaches main unchanged.
#[test]
fn n04_side_branch_merge_is_preserved() {
    let sc = Scenario::new(Options::default());
    let base = sc.head();
    sc.write("a.txt", b"a\n");
    let first = sc.agent_commit(&["a.txt"], "local a");
    ig(&sc.ws, &["checkout", "-q", "-b", "side", &base]);
    sc.write("b.txt", b"b\n");
    let side = sc.agent_commit(&["b.txt"], "side b");
    ig(&sc.ws, &["checkout", "-q", "main"]);
    ig(
        &sc.ws,
        &[
            "-c",
            "user.name=Ada Agent",
            "-c",
            "user.email=ada@example.com",
            "merge",
            "-q",
            "--no-ff",
            "--no-edit",
            "side",
        ],
    );
    let local_merge = sc.head();
    sc.push_other(&[("notes/plan.md", Some(b"plan\n"))], "remote moved");
    let report = sc.publish(Selection::None);
    assert_eq!(report.git_sync_status, SyncStatus::Published);
    for commit in [&first, &side, &local_merge] {
        assert!(
            git_output(
                &sc.remote,
                &["merge-base", "--is-ancestor", commit, "main"],
                None
            )
            .status
            .success(),
            "{commit} is not on main"
        );
    }
    assert_eq!(sc.remote_file("b.txt").as_deref(), Some("b\n"));
}

/// 5: a local commit that added dependencies and a 25 MiB file is rewritten
/// locally; main gets the rest; the files stay on disk.
#[test]
fn n05_unpublishable_paths_in_local_commits_are_sanitised() {
    let sc = Scenario::new(Options {
        hook: true,
        ..Options::default()
    });
    sc.write("node_modules/x/index.js", b"module.exports = 1;\n");
    sc.write("big.bin", &vec![7u8; 25 * 1024 * 1024]);
    sc.write("src/app.rs", b"fn app() {}\n");
    ig(
        &sc.ws,
        &[
            "add",
            "-f",
            "node_modules/x/index.js",
            "big.bin",
            "src/app.rs",
        ],
    );
    ig(
        &sc.ws,
        &[
            "-c",
            "user.name=Ada Agent",
            "-c",
            "user.email=ada@example.com",
            "commit",
            "-q",
            "-m",
            "add app",
        ],
    );
    let original = sc.head();
    sc.push_other(&[("notes/plan.md", Some(b"plan\n"))], "remote moved");

    let report = sc.publish(Selection::None);
    assert_eq!(report.git_sync_status, SyncStatus::Partial, "{report:?}");
    assert_eq!(
        sc.remote_file("src/app.rs").as_deref(),
        Some("fn app() {}\n")
    );
    assert!(!sc.path_anywhere_on_remote("node_modules/x/index.js"));
    assert!(!sc.path_anywhere_on_remote("big.bin"));
    let rejected: Vec<(&str, RejectReason)> = report
        .rejected_paths
        .iter()
        .map(|entry| (entry.path.as_str(), entry.reason))
        .collect();
    assert!(
        rejected.contains(&("big.bin", RejectReason::TooLarge)),
        "{rejected:?}"
    );
    assert!(
        rejected.contains(&("node_modules/x/index.js", RejectReason::Excluded)),
        "{rejected:?}"
    );
    assert!(sc.ws.join("big.bin").exists());
    assert!(sc.ws.join("node_modules/x/index.js").exists());
    // The rewritten commit keeps the agent's message and authorship.
    let log = sc.remote_log();
    assert!(
        log.contains("Ada Agent <ada@example.com> | add app"),
        "{log}"
    );
    assert!(
        !log.contains(&original),
        "the unsanitised commit was published"
    );
}

/// 6: the shard's runtime deny list names a path; the publish drops it and
/// publishes the rest; the conflict ref leaves it out too.
#[test]
fn n06_policy_rejected_path_is_dropped_and_the_rest_published() {
    let sc = Scenario::new(Options {
        hook: true,
        hook_env: vec![("GIT_DENY_PATHS", "*.zip")],
        ..Options::default()
    });
    sc.write("foo.zip", b"PK fake archive\n");
    sc.write("bar.txt", b"bar\n");
    sc.write("README.md", b"one\nTWO BY AGENT\nthree\nfour\nfive\n");
    sc.agent_commit(&["foo.zip", "bar.txt", "README.md"], "agent work");
    sc.push_other(
        &[("README.md", Some(b"one\ntwo by user\nthree\nfour\nfive\n"))],
        "user README",
    );
    let report = sc.publish(Selection::None);
    assert_eq!(report.git_sync_status, SyncStatus::Partial, "{report:?}");
    assert_eq!(sc.remote_file("bar.txt").as_deref(), Some("bar\n"));
    assert!(!sc.path_anywhere_on_remote("foo.zip"));
    assert!(report
        .rejected_paths
        .iter()
        .any(|entry| entry.path == "foo.zip" && entry.reason == RejectReason::Policy));
    let reference = report.recovery_ref.clone().expect("conflict ref");
    assert!(sc
        .recovery_file(&reference, "README.md")
        .unwrap()
        .contains("TWO BY AGENT"));
    assert!(sc.recovery_file(&reference, "foo.zip").is_none());
    assert!(sc.ws.join("foo.zip").exists());
}

/// 7: a stop with a clean tree publishes finished commits (with write
/// access), or parks the commits of an unfinished turn and leaves the
/// branch so no later publish sends them.
#[test]
fn n07_flush_publishes_finished_commits_and_parks_an_unfinished_turn() {
    let sc = Scenario::new(Options::default());
    sc.write("done.rs", b"fn done() {}\n");
    let finished = sc.agent_commit(&["done.rs"], "finished work");
    let report = flush(&sc.ctx(true), false).unwrap();
    assert!(report.publish.is_some());
    assert!(git_output(
        &sc.remote,
        &["merge-base", "--is-ancestor", &finished, "main"],
        None
    )
    .status
    .success());

    sc.write("half.rs", b"fn half() {\n");
    let half = sc.agent_commit(&["half.rs"], "half done");
    sc.write("notes.md", b"scratch\n");
    let report = flush(&sc.ctx(true), true).unwrap();
    assert_eq!(report.parked_commits, 1);
    assert_eq!(report.recovery_refs.len(), 1);
    let parked = &report.recovery_refs[0];
    assert!(parked.pushed);
    assert_eq!(
        sc.recovery_file(&parked.reference, "half.rs").as_deref(),
        Some("fn half() {\n")
    );
    assert_eq!(
        sc.recovery_file(&parked.reference, "notes.md").as_deref(),
        Some("scratch\n")
    );
    assert!(sc.remote_file("half.rs").is_none());
    assert_ne!(
        sc.head(),
        half,
        "the unfinished commit is still on the branch"
    );
    assert_eq!(
        sc.disk("half.rs").as_deref(),
        Some("fn half() {\n"),
        "files stay on disk"
    );
    // A refresh afterwards publishes nothing of it.
    refresh(&sc.ctx(true)).unwrap();
    assert!(sc.remote_file("half.rs").is_none());
    assert!(!git_output(
        &sc.remote,
        &["merge-base", "--is-ancestor", &half, "main"],
        None
    )
    .status
    .success());
}

/// 8 (r4.1): a stop without write access keeps everything locally; the next
/// refresh pushes it to canonical.
#[test]
fn n08_flush_without_a_token_then_refresh_reaches_canonical() {
    let sc = Scenario::new(Options::default());
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nleft over\n");
    let report = flush(&sc.ctx(false), false).unwrap();
    assert_eq!(report.recovery_refs.len(), 1);
    assert!(!report.recovery_refs[0].pushed);
    assert_eq!(report.unpushed_refs, 1);
    assert!(sc.remote_refs("refs/instafy/").is_empty());
    let name = report.recovery_refs[0].name.clone();

    let refreshed = refresh(&sc.ctx(true)).unwrap();
    assert_eq!(refreshed.unpushed_refs, 0);
    let canonical = format!("refs/instafy/recovery/{}/{name}", sc.config.origin_id);
    assert_eq!(sc.remote_refs(&canonical).len(), 1);
    assert!(sc
        .recovery_file(&canonical, "doc.md")
        .unwrap()
        .contains("left over"));
    assert_eq!(
        sc.local_refs(&format!("{LOCAL_RECOVERY_PUSHED_ROOT}/{name}"))
            .len(),
        1
    );
    assert!(sc.local_refs(LOCAL_RECOVERY_ROOT).is_empty());
}

/// 9: the same work is stored and pushed once; different work gets a
/// different name.
#[test]
fn n09_recovery_refs_are_idempotent_and_content_named() {
    let sc = Scenario::new(Options::default());
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nfirst\n");
    let one = flush(&sc.ctx(true), false).unwrap();
    let two = flush(&sc.ctx(true), false).unwrap();
    assert_eq!(one.recovery_refs[0].name, two.recovery_refs[0].name);
    assert!(!two.recovery_refs[0].created);
    assert_eq!(sc.remote_refs("refs/instafy/recovery/").len(), 1);
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nsecond\n");
    let three = flush(&sc.ctx(true), false).unwrap();
    assert_ne!(one.recovery_refs[0].name, three.recovery_refs[0].name);
    assert_eq!(sc.remote_refs("refs/instafy/recovery/").len(), 2);
}

/// 10: a later successful publish retires superseded unpublished refs but
/// keeps conflict refs.
#[test]
fn n10_publish_retires_superseded_unpublished_refs_but_keeps_conflicts() {
    use std::os::unix::fs::PermissionsExt as _;
    let sc = Scenario::new(Options::default());
    // A conflict ref.
    sc.write("README.md", b"one\nTWO BY AGENT\nthree\nfour\nfive\n");
    sc.push_other(
        &[("README.md", Some(b"one\ntwo by user\nthree\nfour\nfive\n"))],
        "user",
    );
    let conflict = sc.publish_paths(&["README.md"]);
    let conflict_ref = conflict.recovery_ref.clone().unwrap();
    // An unpublished ref, pushed but its publish refused (only main is refused).
    let hook = sc.remote.join("hooks").join("update");
    fs::write(
        &hook,
        "#!/bin/sh\nif [ \"$1\" = refs/heads/main ]; then echo 'main is closed' >&2; exit 1; fi\nexit 0\n",
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    sc.write("x.rs", b"fn x() {}\n");
    let refused = sc.publish_paths(&["x.rs"]);
    assert_eq!(refused.git_sync_status, SyncStatus::Unpublished);
    let unpublished = refused.recovery_ref.clone().unwrap();
    assert!(
        unpublished.contains("-unpublished-") && unpublished.starts_with("refs/instafy/recovery/")
    );
    assert_eq!(sc.remote_refs(&unpublished).len(), 1);

    fs::remove_file(&hook).unwrap();
    let saved = sc.publish(Selection::None);
    assert_eq!(saved.git_sync_status, SyncStatus::Published, "{saved:?}");
    assert!(
        sc.remote_refs(&unpublished).is_empty(),
        "superseded ref kept"
    );
    assert_eq!(
        sc.remote_refs(&conflict_ref).len(),
        1,
        "conflict ref removed"
    );
}

/// 13: R..P is exactly this publish's commits.
#[test]
fn n13_published_range_covers_only_this_publish() {
    let sc = Scenario::new(Options::default());
    sc.write("a.rs", b"fn a() {}\n");
    let local = sc.agent_commit(&["a.rs"], "agent a");
    sc.push_other(&[("notes/plan.md", Some(b"plan\n"))], "remote moved");
    let report = sc.publish(Selection::None);
    let base = report.base_rev.clone().unwrap();
    let rev = report.rev.clone().unwrap();
    let range = git_in(&sc.remote, &["rev-list", &format!("{base}..{rev}")]);
    let mut listed: Vec<&str> = range.lines().collect();
    listed.sort();
    let mut expected = vec![local.as_str(), rev.as_str()];
    expected.sort();
    assert_eq!(listed, expected);
}

/// 14: on Desktop, a save carries the author its caller gives (the routes
/// give the origin's identity until the author pseudonym exists, see
/// `user_saves_never_write_a_user_id_into_history`), and a stop keeps the
/// folder as it is.
#[tokio::test]
async fn n14_desktop_saves_keep_their_author_and_are_never_flushed() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nfrom the user\n");
    let report = publish(
        &sc.ctx(true),
        PublishRequest {
            selection: Selection::AllDirty,
            message: "Save version".to_string(),
            author: Some(GitIdentity::new("Grace", "grace@users.noreply.instafy.dev")),
            budget: Duration::from_secs(30),
        },
    )
    .unwrap();
    assert_eq!(report.git_sync_status, SyncStatus::Published);
    let author = git_in(
        &sc.remote,
        &["log", "-1", "--format=%an <%ae> | %cn", "main"],
    );
    assert_eq!(
        author,
        "Grace <grace@users.noreply.instafy.dev> | Instafy Origin"
    );

    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nunsaved\n");
    let mut server = crate::server::OriginHttpServer::new(sc.config.clone()).unwrap();
    server.stop_flushing_workspace().await.unwrap();
    assert!(
        sc.local_refs("refs/instafy/").is_empty(),
        "{:?}",
        sc.local_refs("refs/instafy/")
    );
    assert_eq!(
        sc.disk("doc.md").as_deref(),
        Some("alpha\nbeta\ngamma\ndelta\nunsaved\n")
    );
}

/// Starting the origin removes fetch namespaces that a recovery read which
/// died left in the checkout, and keeps a recent one a running call may own.
#[tokio::test(flavor = "multi_thread")]
async fn starting_removes_stale_recovery_fetch_refs() {
    let sc = Scenario::new(Options::default());
    let head = ig(&sc.ws, &["rev-parse", "HEAD"]);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    let stale = "refs/instafy/fetched/1000-0123456789abcdef0123456789abcdef/0".to_string();
    let live = format!("refs/instafy/fetched/{now}-fedcba9876543210fedcba9876543210/0");
    for name in [&stale, &live] {
        ig(&sc.ws, &["update-ref", name, &head]);
    }
    let mut server = crate::server::OriginHttpServer::new(sc.config.clone()).unwrap();
    server.start().await.unwrap();
    // The sweep runs in the background, so the listener never waits on it.
    let deadline = Instant::now() + Duration::from_secs(30);
    let left = loop {
        let left: Vec<String> = sc
            .local_refs("refs/instafy/fetched/")
            .into_iter()
            .map(|(name, _)| name)
            .collect();
        if left.len() == 1 || Instant::now() > deadline {
            break left;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    server.stop().await.unwrap();
    assert_eq!(left, vec![live]);
}

/// 14b: a hosted stop without a write credential parks unsaved work locally.
#[tokio::test]
async fn n14b_hosted_shutdown_parks_unsaved_work_locally() {
    let sc = Scenario::new(Options::default());
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nunsaved\n");
    let mut server = crate::server::OriginHttpServer::new(sc.config.clone()).unwrap();
    server.stop_flushing_workspace().await.unwrap();
    assert_eq!(sc.local_refs(LOCAL_RECOVERY_ROOT).len(), 1);
    assert!(sc.remote_refs("refs/instafy/").is_empty());
    assert_eq!(
        sc.remote_file("doc.md").as_deref(),
        Some("alpha\nbeta\ngamma\ndelta\n")
    );
}

/// 15: chat images the web app used to write into the workspace root are
/// never published, by selection, by "save everything", or in a commit.
#[test]
fn n15_root_chat_uploads_are_never_published() {
    let sc = Scenario::new(Options::default());
    sc.write("chat-upload-1700000000000-abc-photo.png", b"\x89PNG fake\n");
    sc.write(
        "chat-upload-1700000000001-def-shot.png",
        b"\x89PNG fake 2\n",
    );
    sc.write("src/ok.rs", b"fn ok() {}\n");
    let report = sc.publish_paths(&["chat-upload-1700000000000-abc-photo.png", "src/ok.rs"]);
    assert_eq!(report.git_sync_status, SyncStatus::Partial);
    let all = sc.publish(Selection::AllDirty);
    assert_ne!(all.git_sync_status, SyncStatus::Unpublished);
    ig(
        &sc.ws,
        &["add", "-f", "chat-upload-1700000000001-def-shot.png"],
    );
    ig(&sc.ws, &["commit", "-q", "-m", "agent added an upload"]);
    sc.publish(Selection::None);
    assert!(!sc.path_anywhere_on_remote("chat-upload-1700000000000-abc-photo.png"));
    assert!(!sc.path_anywhere_on_remote("chat-upload-1700000000001-def-shot.png"));
    assert_eq!(sc.remote_file("src/ok.rs").as_deref(), Some("fn ok() {}\n"));
}

// ---------------------------------------------------------------------------
// r4.1 cases.
// ---------------------------------------------------------------------------

/// An agent grows a tracked file past 20 MiB and commits it; main keeps the
/// old file instead of losing it.
#[test]
fn grown_tracked_file_over_the_cap_keeps_the_saved_version() {
    let sc = Scenario::new(Options {
        hook: true,
        seed: vec![("data/export.csv", b"small,csv\n".to_vec())],
        ..Options::default()
    });
    sc.write("data/export.csv", &vec![b'x'; 21 * 1024 * 1024]);
    sc.write("src/a.rs", b"fn a() {}\n");
    ig(&sc.ws, &["commit", "-q", "-am", "regenerate export"]);
    sc.agent_commit(&["src/a.rs"], "add a");
    let report = sc.publish(Selection::None);
    assert_ne!(
        report.git_sync_status,
        SyncStatus::Unpublished,
        "{report:?}"
    );
    assert_eq!(
        sc.remote_file("data/export.csv").as_deref(),
        Some("small,csv\n")
    );
    assert_eq!(sc.remote_file("src/a.rs").as_deref(), Some("fn a() {}\n"));
    let entry = report
        .rejected_paths
        .iter()
        .find(|entry| entry.path == "data/export.csv")
        .expect("reported");
    assert_eq!(entry.reason, RejectReason::TooLarge);
    assert!(entry.kept_saved_version);
}

/// A modified file the shard's smaller size cap refuses is dropped; main
/// keeps the old version.
#[test]
fn modified_file_over_the_shard_cap_keeps_the_saved_version() {
    let sc = Scenario::new(Options {
        hook: true,
        hook_env: vec![("GIT_MAX_BLOB_BYTES", "1000")],
        seed: vec![("data.csv", b"a,b\n".to_vec())],
        ..Options::default()
    });
    sc.write("data.csv", &vec![b'y'; 2000]);
    sc.write("ok.txt", b"fine\n");
    let report = sc.publish_paths(&["data.csv", "ok.txt"]);
    assert_eq!(report.git_sync_status, SyncStatus::Partial, "{report:?}");
    assert_eq!(sc.remote_file("data.csv").as_deref(), Some("a,b\n"));
    assert_eq!(sc.remote_file("ok.txt").as_deref(), Some("fine\n"));
    let entry = report
        .rejected_paths
        .iter()
        .find(|entry| entry.path == "data.csv")
        .expect("reported");
    assert_eq!(entry.reason, RejectReason::TooLarge);
    assert!(entry.kept_saved_version);
    assert_eq!(
        sc.disk("data.csv").unwrap().len(),
        2000,
        "the file stays on disk"
    );
}

/// Restoring a conflict ref never removes a legacy chat upload that is
/// already on canonical, even when the agent's commits changed it.
#[test]
fn restoring_a_recovery_commit_keeps_a_legacy_chat_upload() {
    let sc = Scenario::new(Options {
        seed: vec![("chat-upload-1-old.png", b"legacy image\n".to_vec())],
        ..Options::default()
    });
    sc.write("chat-upload-1-old.png", b"agent changed it\n");
    sc.write("README.md", b"one\nTWO BY AGENT\nthree\nfour\nfive\n");
    ig(&sc.ws, &["commit", "-q", "-am", "agent work"]);
    sc.push_other(
        &[("README.md", Some(b"one\ntwo by user\nthree\nfour\nfive\n"))],
        "user",
    );
    let report = sc.publish(Selection::None);
    let reference = report.recovery_ref.clone().expect("conflict ref");
    assert_eq!(
        sc.recovery_file(&reference, "chat-upload-1-old.png")
            .as_deref(),
        Some("legacy image\n")
    );
    // What a Restore computes: three_way(Q^1, main, Q).
    let git = crate::workspace_git::WorkspaceGit::new(&sc.ws, None);
    let q = ig(&sc.ws, &["rev-parse", &reference]);
    let restored =
        crate::tree_merge::three_way(&git, Some(&format!("{q}^")), &sc.main(), &q).unwrap();
    let listing = ig(&sc.ws, &["ls-tree", "-r", "--name-only", &restored.tree]);
    assert!(
        listing.lines().any(|line| line == "chat-upload-1-old.png"),
        "{listing}"
    );
    assert_eq!(
        sc.remote_file("chat-upload-1-old.png").as_deref(),
        Some("legacy image\n")
    );
}

/// The old sync's `reset --mixed` left stale copies; a stop and a Desktop
/// "Save as version" never publish them as reverts.
#[test]
fn stale_copies_from_the_old_align_are_never_published_as_reverts() {
    for desktop in [false, true] {
        let sc = Scenario::new(Options {
            desktop,
            ..Options::default()
        });
        // Remote moves: README edited, a file imported, logo deleted.
        sc.push_other(
            &[
                (
                    "README.md",
                    Some(b"one\ntwo\nthree\nfour\nfive\nv2 from studio\n"),
                ),
                ("imported/lib.rs", Some(b"fn imported() {}\n")),
                ("logo.bin", None),
            ],
            "Studio work",
        );
        // The old align: fetch, then reset --mixed onto the remote tip.
        ig(&sc.ws, &["fetch", "-q", "origin"]);
        ig(&sc.ws, &["reset", "-q", "--mixed", "origin/main"]);
        // And a genuine edit after it.
        sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\ngenuine\n");

        if desktop {
            let report = sc.publish(Selection::AllDirty);
            assert_ne!(
                report.git_sync_status,
                SyncStatus::Unpublished,
                "{report:?}"
            );
            assert!(sc.remote_file("doc.md").unwrap().contains("genuine"));
        } else {
            flush(&sc.ctx(true), false).unwrap();
            refresh(&sc.ctx(true)).unwrap();
        }
        assert!(
            sc.remote_file("README.md")
                .unwrap()
                .contains("v2 from studio"),
            "desktop={desktop}: README reverted"
        );
        assert_eq!(
            sc.remote_file("imported/lib.rs").as_deref(),
            Some("fn imported() {}\n"),
            "desktop={desktop}: import deleted"
        );
        assert!(
            sc.remote_file("logo.bin").is_none(),
            "desktop={desktop}: deletion undone"
        );
        assert!(sc.disk("README.md").unwrap().contains("v2 from studio"));
        assert!(sc.ws.join("imported/lib.rs").exists());
    }
}

/// A Desktop save that conflicts keeps the user's bytes in their folder.
#[test]
fn desktop_conflict_leaves_the_users_file_unchanged() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let mine = "one\nmy desktop line\nthree\nfour\nfive\n";
    sc.write("README.md", mine.as_bytes());
    sc.push_other(
        &[(
            "README.md",
            Some(b"one\ncollaborator line\nthree\nfour\nfive\n"),
        )],
        "collab",
    );
    let report = sc.publish_paths(&["README.md"]);
    assert_eq!(report.conflicted_paths, vec!["README.md".to_string()]);
    assert_eq!(report.git_sync_status, SyncStatus::Partial);
    assert!(sc
        .remote_file("README.md")
        .unwrap()
        .contains("collaborator line"));
    assert_eq!(sc.disk("README.md").as_deref(), Some(mine));
    assert!(sc.status().contains(" M README.md"), "{}", sc.status());
}

/// Secret files never reach any canonical ref, however they are selected.
#[test]
fn secret_files_are_never_published() {
    let sc = Scenario::new(Options {
        hook: true,
        ..Options::default()
    });
    for path in [
        ".env",
        "config/.env.production",
        "id_rsa",
        "certs/server.pem",
        ".npmrc",
    ] {
        sc.write(path, format!("SECRET-{path}\n").as_bytes());
    }
    sc.write(".env.example", b"EXAMPLE=1\n");
    let named = sc.publish_paths(&[".env", "id_rsa", ".env.example"]);
    assert!(named
        .rejected_paths
        .iter()
        .any(|entry| entry.path == ".env" && entry.reason == RejectReason::Secret));
    sc.publish(Selection::AllDirty);
    ig(&sc.ws, &["add", "-f", "certs/server.pem", ".npmrc"]);
    ig(&sc.ws, &["commit", "-q", "-m", "agent commits secrets"]);
    sc.write("README.md", b"conflict\n");
    sc.push_other(&[("README.md", Some(b"other\n"))], "conflict");
    sc.publish_paths(&["README.md"]);
    flush(&sc.ctx(true), false).unwrap();
    assert!(
        !sc.anywhere_on_remote("SECRET-"),
        "a secret reached canonical"
    );
    assert_eq!(
        sc.remote_file(".env.example").as_deref(),
        Some("EXAMPLE=1\n")
    );
}

/// Push state is explicit: a dismissed (deleted on canonical) pushed ref is
/// retired locally and never pushed again, and an unpublished commit that
/// was dismissed leaves the branch.
#[test]
fn dismissed_recovery_work_is_never_published_again() {
    let sc = Scenario::new(Options::default());
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nleft over\n");
    let parked = flush(&sc.ctx(true), false).unwrap();
    let reference = parked.recovery_refs[0].reference.clone();
    let name = parked.recovery_refs[0].name.clone();
    // A person dismisses it.
    git_in(&sc.remote, &["update-ref", "-d", &reference]);
    refresh(&sc.ctx(true)).unwrap();
    assert_eq!(
        sc.local_refs(&format!("{LOCAL_RECOVERY_DISMISSED_ROOT}/{name}"))
            .len(),
        1
    );
    assert!(sc.local_refs(LOCAL_RECOVERY_PUSHED_ROOT).is_empty());
    // The same leftovers are not parked again.
    let again = flush(&sc.ctx(true), false).unwrap();
    assert!(again.recovery_refs.is_empty(), "{again:?}");
    assert!(sc.remote_refs("refs/instafy/").is_empty());
}

/// A single-tenant revert applies the inverse to the index and files it
/// touches, refuses when one of them has unsaved edits, and stays reverted
/// through a later "save everything".
#[test]
fn single_tenant_revert_goes_through_the_index_and_stays_reverted() {
    let sc = Scenario::new(Options::default());
    sc.write("README.md", b"one\ntwo\nthree\nfour\nfive\nadded\n");
    let saved = sc.publish_paths(&["README.md"]);
    let commit = saved.rev.clone().unwrap();

    sc.write(
        "README.md",
        b"one\ntwo\nthree\nfour\nfive\nadded\nunsaved\n",
    );
    let refused = revert_commit(&sc.ctx(true), &commit, None, None).unwrap_err();
    assert!(matches!(
        refused,
        crate::error::OriginError::ConflictPaths {
            code: "dirty_paths",
            ..
        }
    ));
    sc.write("README.md", b"one\ntwo\nthree\nfour\nfive\nadded\n");

    sc.write("unrelated.txt", b"dirty but unrelated\n");
    let reverted = revert_commit(&sc.ctx(true), &commit, None, None).unwrap();
    assert_eq!(reverted.git_sync_status, SyncStatus::Published);
    assert_eq!(sc.remote_file("README.md").as_deref(), Some(README));
    assert_eq!(sc.disk("README.md").as_deref(), Some(README));
    sc.publish(Selection::AllDirty);
    assert_eq!(sc.remote_file("README.md").as_deref(), Some(README));
    assert_eq!(
        sc.remote_file("unrelated.txt").as_deref(),
        Some("dirty but unrelated\n")
    );
}

/// Ignored paths in a selection are reported and the rest is published.
#[test]
fn ignored_selected_paths_are_reported_and_the_rest_published() {
    let sc = Scenario::new(Options {
        seed: vec![(".gitignore", b"*.log\n".to_vec())],
        ..Options::default()
    });
    sc.write("debug.log", b"noise\n");
    sc.write("src/a.rs", b"fn a() {}\n");
    let report = sc.publish_paths(&["src/a.rs", "debug.log"]);
    assert_eq!(report.git_sync_status, SyncStatus::Partial);
    assert!(report
        .rejected_paths
        .iter()
        .any(|entry| entry.path == "debug.log" && entry.reason == RejectReason::Ignored));
    assert_eq!(sc.remote_file("src/a.rs").as_deref(), Some("fn a() {}\n"));
    assert!(sc.remote_file("debug.log").is_none());
}

/// The publish commit never takes along what the agent staged for other
/// paths; that stays staged.
#[test]
fn a_selection_leaves_other_staged_changes_alone() {
    let sc = Scenario::new(Options::default());
    sc.write("staged.txt", b"staged by the agent\n");
    ig(&sc.ws, &["add", "staged.txt"]);
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nselected\n");
    sc.publish_paths(&["doc.md"]);
    assert!(sc.remote_file("staged.txt").is_none());
    assert!(sc.status().contains("A  staged.txt"), "{}", sc.status());
    assert!(!sc.status().contains("doc.md"), "{}", sc.status());
}

// ---------------------------------------------------------------------------
// Static rules for the publish modules.
// ---------------------------------------------------------------------------

/// The production code of a module: its comments removed, then every
/// `#[cfg(test)]` module (inline, or declared with `;`, behind any further
/// attributes such as `#[path]`) wherever it sits in the file. The rest of
/// the file is kept, string literals included.
fn production_source(source: &str) -> String {
    test_modules(source).0
}

/// `source` without its comments and its `#[cfg(test)]` modules, and each
/// removed module's name with its `#[path]` (if any). The marker counts only
/// in code: not in a comment or a string or character literal.
fn test_modules(source: &str) -> (String, Vec<(String, Option<String>)>) {
    const MARKER: &str = "#[cfg(test)]";
    let (uncommented, masked) = mask_source(source);
    let mut kept = String::new();
    let mut modules = Vec::new();
    let mut position = 0;
    while let Some(found) = masked[position..].find(MARKER) {
        let start = position + found;
        let after = start + MARKER.len();
        kept.push_str(&uncommented[position..start]);
        match test_module_item(&masked[after..], &uncommented[after..]) {
            Some((end, name, path)) => {
                modules.push((name, path));
                position = after + end;
            }
            None => {
                kept.push_str(MARKER);
                position = after;
            }
        }
    }
    kept.push_str(&uncommented[position..]);
    (kept, modules)
}

/// `source` with every comment blanked, and a copy that also has the
/// contents of every string and character literal blanked. Blanking keeps
/// each byte's offset (each blanked byte becomes a space, newlines stay),
/// so an offset in one is the same place in the other.
fn mask_source(source: &str) -> (String, String) {
    let bytes = source.as_bytes();
    let mut uncommented = bytes.to_vec();
    let mut masked = bytes.to_vec();
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for byte in &mut out[from..to] {
            if *byte != b'\n' {
                *byte = b' ';
            }
        }
    };
    let is_ident = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        if byte == b'/' && next == Some(b'/') {
            let end = index + source[index..].find('\n').unwrap_or(bytes.len() - index);
            blank(&mut uncommented, index, end);
            blank(&mut masked, index, end);
            index = end;
            continue;
        }
        if byte == b'/' && next == Some(b'*') {
            let mut depth = 0usize;
            let mut end = index;
            while end < bytes.len() {
                if bytes[end] == b'/' && bytes.get(end + 1) == Some(&b'*') {
                    depth += 1;
                    end += 2;
                } else if bytes[end] == b'*' && bytes.get(end + 1) == Some(&b'/') {
                    depth -= 1;
                    end += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    end += 1;
                }
            }
            blank(&mut uncommented, index, end);
            blank(&mut masked, index, end);
            index = end;
            continue;
        }
        let raw_start = byte == b'r'
            && (index == 0
                || !is_ident(bytes[index - 1])
                || (bytes[index - 1] == b'b' && (index < 2 || !is_ident(bytes[index - 2]))));
        if raw_start && matches!(next, Some(b'"') | Some(b'#')) {
            let hashes = bytes[index + 1..]
                .iter()
                .take_while(|byte| **byte == b'#')
                .count();
            if bytes.get(index + 1 + hashes) == Some(&b'"') {
                let terminator = format!("\"{}", "#".repeat(hashes));
                let body = index + 2 + hashes;
                let close = body
                    + source[body..]
                        .find(&terminator)
                        .unwrap_or(bytes.len() - body);
                blank(&mut masked, body, close);
                index = (close + terminator.len()).min(bytes.len());
                continue;
            }
        }
        if byte == b'"' {
            let mut end = index + 1;
            while end < bytes.len() && bytes[end] != b'"' {
                end += if bytes[end] == b'\\' { 2 } else { 1 };
            }
            let end = end.min(bytes.len());
            blank(&mut masked, index + 1, end);
            index = end + 1;
            continue;
        }
        if byte == b'\'' {
            let close = if next == Some(b'\\') {
                source[index + 2..]
                    .find('\'')
                    .map(|offset| index + 2 + offset)
            } else {
                source[index + 1..].chars().next().and_then(|character| {
                    let after = index + 1 + character.len_utf8();
                    (bytes.get(after) == Some(&b'\'')).then_some(after)
                })
            };
            if let Some(close) = close {
                blank(&mut masked, index + 1, close);
                index = close + 1;
                continue;
            }
        }
        index += 1;
    }
    (
        String::from_utf8(uncommented).expect("blanking keeps UTF-8"),
        String::from_utf8(masked).expect("blanking keeps UTF-8"),
    )
}

/// When `text` (code after a `#[cfg(test)]`, with comments and literals
/// blanked) is, after whitespace and further attributes,
/// `[pub[(…)]] mod <name>;` or `… mod <name> { … }`: the offset just past
/// that item, the module's name and its `#[path]` (read from `original`,
/// the same text with its literals).
fn test_module_item(text: &str, original: &str) -> Option<(usize, String, Option<String>)> {
    let skip_space = |index: usize| {
        index
            + text[index..]
                .find(|c: char| !c.is_whitespace())
                .unwrap_or(text.len() - index)
    };
    let mut index = skip_space(0);
    let mut path = None;
    while text[index..].starts_with("#[") {
        let end = matching_close(text, index + 1)?;
        let attribute = original[index + 2..end - 1].trim();
        if let Some(value) = attribute.strip_prefix("path") {
            path = Some(
                value
                    .trim()
                    .trim_start_matches('=')
                    .trim()
                    .trim_matches('"')
                    .to_string(),
            );
        }
        index = skip_space(end);
    }
    if text[index..].starts_with("pub") {
        index = skip_space(index + 3);
        if text[index..].starts_with('(') {
            index = skip_space(index + text[index..].find(')')? + 1);
        }
    }
    let after_mod = text[index..].strip_prefix("mod")?;
    if !after_mod.starts_with(char::is_whitespace) {
        return None;
    }
    index = skip_space(index + 3);
    let name_length = text[index..]
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(text.len() - index);
    if name_length == 0 {
        return None;
    }
    let name = text[index..index + name_length].to_string();
    index = skip_space(index + name_length);
    let end = match text.as_bytes().get(index)? {
        b';' => index + 1,
        b'{' => matching_close(text, index)?,
        _ => return None,
    };
    Some((end, name, path))
}

/// The offset just past the bracket that closes the `{` or `[` at `open`,
/// skipping comments and string and character literals.
fn matching_close(text: &str, open: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    let (opening, closing) = match bytes.get(open)? {
        b'{' => (b'{', b'}'),
        b'[' => (b'[', b']'),
        _ => return None,
    };
    let is_ident = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let mut depth = 0usize;
    let mut index = open;
    while index < bytes.len() {
        let byte = bytes[index];
        let next = bytes.get(index + 1).copied();
        if byte == b'/' && next == Some(b'/') {
            index += text[index..].find('\n').unwrap_or(text.len() - index);
            continue;
        }
        if byte == b'/' && next == Some(b'*') {
            index += 2 + text[index + 2..].find("*/")? + 2;
            continue;
        }
        let raw_start = byte == b'r'
            && (index == 0
                || !is_ident(bytes[index - 1])
                || (bytes[index - 1] == b'b' && (index < 2 || !is_ident(bytes[index - 2]))));
        if raw_start && matches!(next, Some(b'"') | Some(b'#')) {
            let hashes = bytes[index + 1..]
                .iter()
                .take_while(|byte| **byte == b'#')
                .count();
            if bytes.get(index + 1 + hashes) == Some(&b'"') {
                let terminator = format!("\"{}", "#".repeat(hashes));
                let body = index + 2 + hashes;
                index = body + text[body..].find(&terminator)? + terminator.len();
                continue;
            }
        }
        if byte == b'"' {
            index += 1;
            while *bytes.get(index)? != b'"' {
                index += if bytes[index] == b'\\' { 2 } else { 1 };
            }
            index += 1;
            continue;
        }
        if byte == b'\'' {
            if next == Some(b'\\') {
                index += 2 + text[index + 2..].find('\'')? + 1;
                continue;
            }
            let character = text[index + 1..].chars().next()?;
            let after = index + 1 + character.len_utf8();
            if bytes.get(after) == Some(&b'\'') {
                index = after + 1;
                continue;
            }
            // A lifetime.
            index += 1;
            continue;
        }
        if byte == opening {
            depth += 1;
        } else if byte == closing {
            depth -= 1;
            if depth == 0 {
                return Some(index + 1);
            }
        }
        index += 1;
    }
    None
}

const PUBLISH_MODULES: &[(&str, &str)] = &[
    ("publish.rs", include_str!("publish.rs")),
    ("push.rs", include_str!("push.rs")),
    ("recovery.rs", include_str!("recovery.rs")),
    ("recovery_view.rs", include_str!("recovery_view.rs")),
    ("stale_align.rs", include_str!("stale_align.rs")),
    ("tree_merge.rs", include_str!("tree_merge.rs")),
    ("publish_policy.rs", include_str!("publish_policy.rs")),
    ("workspace_git.rs", include_str!("workspace_git.rs")),
];

/// Modules under `src/` written before these rules: the command builder
/// itself, other process spawners, HTTP plumbing and test harnesses. Every
/// other module, including any added later in any folder, must follow the
/// rules.
const MODULES_BEFORE_THE_RULES: &[&str] = &[
    "apply.rs",
    "apply_idempotency.rs",
    "auth.rs",
    "browser.rs",
    "browser_approval.rs",
    "browser_approval_tests.rs",
    "browser_collaboration.rs",
    "browser_screencast.rs",
    "browser_screencast/input.rs",
    "browser_screencast/protocol.rs",
    "browser_screencast/stream.rs",
    "browser_screencast/transport.rs",
    "browser_webrtc.rs",
    "config.rs",
    "error.rs",
    "git.rs",
    "git_tokens.rs",
    "jwks.rs",
    "lib.rs",
    "main.rs",
    "paths.rs",
    "publish_tests.rs",
    "routes.rs",
    "safe_fs.rs",
    "server.rs",
    "test_support.rs",
    "untrusted_git.rs",
    "workspace_fs.rs",
    "workspace_lock.rs",
];

/// The one module that builds git commands from `server_git_command`.
const COMMAND_BUILDER: &str = "workspace_git.rs";

/// Ways the production code of module `name` could start a process other
/// than through `WorkspaceGit`: naming a `Command` type at all (however it
/// is imported or renamed), any `process::` item other than a spawned
/// process's results, its handle and the signals that stop it at a
/// deadline, calling `server_git_command` itself (only `WorkspaceGit` does,
/// once), or naming the git program.
fn spawn_rule_violations(name: &str, source: &str) -> Vec<String> {
    // Results of a git that was spawned, its handle, and the signals that stop
    // it at a deadline (`rustix::process`); none of them can start a process.
    const PROCESS_ITEMS: &[&str] = &[
        "Output",
        "ExitStatus",
        "Stdio",
        "ExitStatusExt",
        "Child",
        "kill_process",
        "Pid",
        "Signal",
    ];
    let code = production_source(source);
    let mut violations = Vec::new();
    for identifier in code
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .filter(|word| !word.is_empty())
    {
        if matches!(identifier, "Command" | "CommandExt") {
            violations.push(format!("{name} names a process type ({identifier})"));
        }
    }
    for (index, _) in code.match_indices("process::") {
        let rest = &code[index + "process::".len()..];
        let items: Vec<&str> = match rest.strip_prefix('{') {
            Some(group) => group[..group.find('}').unwrap_or(group.len())]
                .split(',')
                .map(|item| item.trim().split(' ').next().unwrap_or_default())
                .filter(|item| !item.is_empty())
                .collect(),
            None => vec![rest
                .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                .next()
                .unwrap_or_default()],
        };
        for item in items {
            if !PROCESS_ITEMS.contains(&item) {
                violations.push(format!("{name} uses std::process::{item}"));
            }
        }
    }
    if name == COMMAND_BUILDER {
        let calls = code.matches("server_git_command(").count();
        if calls != 1 {
            violations.push(format!(
                "{name} calls server_git_command {calls} times instead of once"
            ));
        }
    } else if code.contains("server_git_command") {
        violations.push(format!("{name} uses server_git_command directly"));
    }
    if code.contains("\"git\"") {
        violations.push(format!("{name} names the git program"));
    }
    violations
}

/// Uses of git newer than 2.34, of a forced update of a remote ref, or of a
/// reset onto one, in the production code of module `name`.
fn force_rule_violations(name: &str, source: &str) -> Vec<String> {
    let code = production_source(source);
    let mut violations = Vec::new();
    for forbidden in [
        "\"merge-tree\"",
        "--write-tree",
        "--object-id",
        "--empty=",
        "\"rebase\"",
        "\"--force\"",
        "\"-f\"",
        "\"--hard\"",
        "\"--mixed\"",
        "\"--force-if-includes\"",
        "\"--mirror\"",
    ] {
        if code.contains(forbidden) {
            violations.push(format!("{name} uses {forbidden}"));
        }
    }
    // The only lease form is create-only (`<ref>:` with no value) or
    // pinned to an exact listed id when deleting a recovery ref.
    for (index, _) in code.match_indices("--force-with-lease=") {
        let tail = &code[index..code.len().min(index + 60)];
        if !(tail.starts_with("--force-with-lease={reference}:\"")
            || tail.starts_with("--force-with-lease={destination}:{rev}\""))
        {
            violations.push(format!("{name}: unexpected lease form {tail}"));
        }
    }
    violations
}

/// Every git process in the publish modules is built by
/// `server_git_command` through `WorkspaceGit`, never spawned directly.
#[test]
fn publish_modules_spawn_git_only_through_server_git_command() {
    for (name, source) in PUBLISH_MODULES {
        let violations = spawn_rule_violations(name, source);
        assert!(violations.is_empty(), "{violations:#?}");
    }
    let workspace_git = production_source(include_str!("workspace_git.rs"));
    assert_eq!(
        workspace_git.matches("server_git_command()").count(),
        1,
        "WorkspaceGit must build its one command from server_git_command"
    );
}

/// Nothing in the publish modules needs git newer than 2.34, rewrites a
/// remote ref, or resets onto one.
#[test]
fn publish_modules_use_only_git_2_34_and_never_force() {
    for (name, source) in PUBLISH_MODULES {
        let violations = force_rule_violations(name, source);
        assert!(violations.is_empty(), "{violations:#?}");
    }
}

/// The same rules hold for every module under `src/` that is not listed in
/// [`MODULES_BEFORE_THE_RULES`], so a new module is checked without anyone
/// remembering to list it. Test modules (`tests.rs`, `*_tests.rs`) are not
/// production code.
#[test]
fn every_module_written_after_the_rules_follows_them() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut modules = Vec::new();
    let mut folders = vec![src.clone()];
    while let Some(folder) = folders.pop() {
        for entry in fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                folders.push(path);
            } else if path.extension().is_some_and(|extension| extension == "rs") {
                let relative = path.strip_prefix(&src).unwrap();
                let name = relative
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                modules.push((name, path));
            }
        }
    }
    let names: Vec<&str> = modules.iter().map(|(name, _)| name.as_str()).collect();
    for (name, _) in PUBLISH_MODULES {
        assert!(names.contains(name), "{name} was not found under src/");
    }
    for name in MODULES_BEFORE_THE_RULES {
        assert!(
            names.contains(name),
            "{name} no longer exists: remove it from MODULES_BEFORE_THE_RULES"
        );
    }

    // Every module a parent declares under `#[cfg(test)]`, as the file it
    // names: `<dir>/<name>.rs` (or `<dir>/<name>/mod.rs`), or its `#[path]`.
    let mut test_files = Vec::new();
    for (name, path) in &modules {
        let file = name.rsplit('/').next().unwrap_or_default();
        let folder = &name[..name.len() - file.len()];
        let children = match file {
            "lib.rs" | "main.rs" | "mod.rs" => folder.to_string(),
            _ => format!("{folder}{}/", file.trim_end_matches(".rs")),
        };
        for (module, attribute) in test_modules(&fs::read_to_string(path).unwrap()).1 {
            match attribute {
                Some(target) => test_files.push(format!("{folder}{target}")),
                None => {
                    test_files.push(format!("{children}{module}.rs"));
                    test_files.push(format!("{children}{module}/mod.rs"));
                }
            }
        }
    }

    let mut checked = 0;
    for (name, path) in &modules {
        let file = name.rsplit('/').next().unwrap_or_default();
        if file == "tests.rs" || file.ends_with("_tests.rs") {
            // Skipped as test code only when a parent compiles it for
            // tests alone.
            assert!(
                test_files.contains(name),
                "{name} is named as test code but no parent declares it under #[cfg(test)]"
            );
            continue;
        }
        if MODULES_BEFORE_THE_RULES.contains(&name.as_str()) {
            continue;
        }
        let source = fs::read_to_string(path).unwrap();
        let mut violations = spawn_rule_violations(name, &source);
        violations.extend(force_rule_violations(name, &source));
        assert!(violations.is_empty(), "{violations:#?}");
        checked += 1;
    }
    assert!(
        checked >= PUBLISH_MODULES.len(),
        "checked {checked} modules"
    );
}

/// The rules catch a module that starts git itself, in each way the
/// checks look for.
#[test]
fn the_spawn_rule_catches_a_module_that_runs_git_itself() {
    for source in [
        "fn run() { let _ = std::process::Command::new(\"git\").arg(\"status\").output(); }\n",
        "use std::process::Command as Git;\nfn run() { let _ = Git::new(PROGRAM).output(); }\n",
        "use std::process::{Child, Command};\n",
        "use std::process::*;\nfn run() { let _ = Builder::new(PROGRAM); }\n",
        "fn run() { let _ = tokio::process::Command::new(PROGRAM); }\n",
        "use std::os::unix::process::CommandExt;\n",
        "fn run() { let _ = std::process::exit(1); }\n",
        "fn run() { let _ = crate::git::server_git_command().arg(\"status\").output(); }\n",
        "fn run() { let _ = crate::git::GitProcess::new(\"git\"); }\n",
        // An aliased process module: only the `Command` name gives it away.
        "use std::process as p;\nfn run() { let _ = p::Command::new(PROGRAM).output(); }\n",
        "use tokio::process as tp;\nfn run() { let _ = tp::Command::new(PROGRAM); }\n",
        // Production code after a test module declared near the top, the
        // way a `mod.rs` lists its submodules.
        "mod cache;\n#[cfg(test)]\nmod tests;\nfn run() { let _ = std::process::Command::new(PROGRAM); }\n",
        "#[cfg(test)]\n#[path = \"cache_tests.rs\"]\nmod tests;\nfn run() { let _ = Command::new(PROGRAM); }\n",
        // A comment or a literal that ends with the marker hides nothing.
        "/// Kept apart from the code built under #[cfg(test)]\nmod wire {\n    pub fn run() { let _ = std::process::Command::new(\"git\"); }\n}\n",
        "fn f() {} // #[cfg(test)]\nmod wire { pub fn run() { let _ = Command::new(PROGRAM); } }\n",
        "/* #[cfg(test)] */\nmod wire { pub fn run() { let _ = Command::new(PROGRAM); } }\n",
        "const NOTE: &str = r#\"x #[cfg(test)]\nmod fake {\"#;\nmod wire { pub fn run() { let _ = Command::new(PROGRAM); } }\n",
        // A string holding the marker and the start of a module, closed
        // by a later string: only masking strings keeps `wire` checked.
        "const A: &str = \"#[cfg(test)] mod fake {\";\nmod wire { pub fn run() { let _ = Command::new(PROGRAM); } }\nconst B: &str = \"}\";\n",
        // Production code after an inline test module whose literals hold
        // braces.
        "#[cfg(test)]\nmod tests {\n    fn t() { let _ = \"}\"; let _ = '{'; let _ = r#\"}\"#; }\n}\nfn run() { let _ = Command::new(PROGRAM); }\n",
    ] {
        assert!(
            !spawn_rule_violations("new_module.rs", source).is_empty(),
            "not caught: {source}"
        );
    }
    for source in [
        "fn run(git: &WorkspaceGit<'_>) { let _ = git.run(&[\"status\"]); }\n",
        "use std::process::{Output, Stdio};\n",
        "// std::process::Command::new(\"git\") is never used here.\n",
        "fn run() {}\n#[cfg(test)]\nmod tests {\n    use std::process::Command;\n}\n",
        "#[cfg(test)]\nmod tests {\n    mod inner { fn t() { let _ = std::process::Command::new(\"git\"); } }\n    fn u<'a>(x: &'a str) -> char { let _ = x; '}' }\n}\nfn run(git: &WorkspaceGit<'_>) { let _ = git.run(&[\"status\"]); }\n",
        "mod cache;\n#[cfg(test)]\nmod tests;\nfn run(git: &WorkspaceGit<'_>) { let _ = git.run(&[\"status\"]); }\n",
    ] {
        assert_eq!(
            spawn_rule_violations("new_module.rs", source),
            Vec::<String>::new(),
            "{source}"
        );
    }
    // Only the command builder may call server_git_command, and only once.
    let builder = "fn spawn() { let command = server_git_command(); }\n";
    assert!(spawn_rule_violations(COMMAND_BUILDER, builder).is_empty());
    assert!(!spawn_rule_violations(COMMAND_BUILDER, &builder.repeat(2)).is_empty());
    assert!(!spawn_rule_violations(COMMAND_BUILDER, "fn spawn() {}\n").is_empty());

    assert!(!force_rule_violations(
        "new_module.rs",
        "fn push() { let _ = [\"push\", \"--force\"]; }\n"
    )
    .is_empty());
    assert!(!force_rule_violations(
        "hosted/mod.rs",
        "mod cache;\n#[cfg(test)]\nmod tests;\npub fn f() { let _ = [\"fetch\", \"--force\"]; }\n"
    )
    .is_empty());
    assert!(!force_rule_violations(
        "new_module.rs",
        "fn push(r: &str) { let _ = format!(\"--force-with-lease={r}\"); }\n"
    )
    .is_empty());
}

// ---------------------------------------------------------------------------
// The HTTP routes on a single-tenant origin.
// ---------------------------------------------------------------------------

async fn serve(sc: &Scenario) -> (String, tokio::task::JoinHandle<()>) {
    serve_config(sc.config.clone(), sc.ws.clone()).await
}

async fn serve_config(
    config: ServerConfig,
    workspace: PathBuf,
) -> (String, tokio::task::JoinHandle<()>) {
    let client = reqwest::Client::new();
    let config = std::sync::Arc::new(config);
    let validator = crate::auth::TokenValidator::new(client.clone(), config.jwks_url.clone());
    let state = crate::routes::AppState::new(config, validator, client, workspace, None)
        .expect("app state");
    let app = crate::routes::router(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{address}"), handle)
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_route_reports_conflicts_refusals_and_refresh() {
    use std::os::unix::fs::PermissionsExt as _;
    let sc = Scenario::new(Options::default());
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();

    sc.write("README.md", b"one\nTWO BY AGENT\nthree\nfour\nfive\n");
    sc.write("feature.rs", b"fn feature() {}\n");
    sc.push_other(
        &[("README.md", Some(b"one\ntwo by user\nthree\nfour\nfive\n"))],
        "user",
    );
    let response = client
        .post(format!("{base}/git/sync"))
        .json(&serde_json::json!({ "paths": ["README.md", "feature.rs"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["gitSyncStatus"], "partial");
    assert_eq!(body["conflictedPaths"], serde_json::json!(["README.md"]));
    assert!(body["recoveryRef"].as_str().unwrap().contains("-conflict-"));
    assert_eq!(body["rev"].as_str(), Some(sc.main().as_str()));
    assert!(body["baseRev"].is_string());

    let hook = sc.remote.join("hooks").join("pre-receive");
    fs::write(&hook, "#!/bin/sh\necho 'closed' >&2\nexit 1\n").unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    sc.write("x.rs", b"fn x() {}\n");
    let response = client
        .post(format!("{base}/git/sync"))
        .json(&serde_json::json!({ "paths": ["x.rs"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["code"], "not_saved");
    assert_eq!(body["gitSyncStatus"], "unpublished");
    assert!(body["error"].as_str().unwrap().starts_with("Not saved"));
    assert!(body["recoveryRef"]
        .as_str()
        .unwrap()
        .contains("-unpublished-"));
    fs::remove_file(&hook).unwrap();

    let response = client
        .post(format!("{base}/git/sync"))
        .json(&serde_json::json!({ "mode": "refresh" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["gitSyncStatus"], "published", "{body}");
    assert_eq!(sc.remote_file("x.rs").as_deref(), Some("fn x() {}\n"));

    let response = client
        .post(format!("{base}/git/sync"))
        .json(&serde_json::json!({ "mode": "refresh", "paths": ["x.rs"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);

    sc.write("left.txt", b"left over\n");
    let response = client
        .post(format!("{base}/git/flush"))
        .json(&serde_json::json!({ "turnActive": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["unpushedRefs"], 0, "{body}");
    assert_eq!(body["recoveryRefs"].as_array().unwrap().len(), 1, "{body}");
    assert!(sc.remote_file("left.txt").is_none());
    server.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn revert_route_reverts_through_the_publish() {
    let sc = Scenario::new(Options::default());
    sc.write("README.md", b"one\ntwo\nthree\nfour\nfive\nadded\n");
    let saved = sc.publish_paths(&["README.md"]);
    let commit = saved.rev.unwrap();
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let response = client
        .post(format!("{base}/git/revert-commit"))
        .json(&serde_json::json!({ "commit": commit }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["gitSyncStatus"], "published", "{body}");
    assert_eq!(sc.remote_file("README.md").as_deref(), Some(README));
    server.abort();
}

/// Desktop History pages: `skip`, up to 50 rows, `hasMore`, each row's
/// first parent and parent count, and who made it (a person's pseudonym,
/// Instafy, or someone else), in the checkout's `git log` order.
#[tokio::test(flavor = "multi_thread")]
async fn history_route_pages_a_checkout_with_parents_and_actors() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let seed = sc.head();
    sc.write("a.md", b"a\n");
    sc.agent_commit(&["a.md"], "agent work");
    sc.write("b.md", b"b\n");
    let report = publish(
        &sc.ctx(true),
        PublishRequest {
            selection: Selection::Paths(vec!["b.md".to_string()]),
            message: "Save version".to_string(),
            author: Some(GitIdentity::new("Ada Lovelace", PSEUDONYM)),
            budget: Duration::from_secs(30),
        },
    )
    .expect("publish");
    assert_eq!(report.git_sync_status, SyncStatus::Published);
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let get = |query: &str| {
        let url = format!("{base}/git/history{query}");
        let client = client.clone();
        async move {
            let response = client.get(url).send().await.unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            response.json::<serde_json::Value>().await.unwrap()
        }
    };

    let page = get("?limit=2").await;
    assert_eq!(page["hasMore"], true, "{page}");
    let entries = page["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0]["subject"], "Save version");
    assert_eq!(entries[0]["authorEmail"], PSEUDONYM);
    assert_eq!(entries[0]["actor"], "user");
    assert_eq!(entries[0]["parentCount"], 1);
    assert_eq!(entries[0]["firstParent"], entries[1]["commit"]);
    assert_eq!(entries[1]["subject"], "agent work");
    assert_eq!(entries[1]["actor"], "external");

    let rest = get("?limit=2&skip=2").await;
    assert_eq!(rest["hasMore"], false, "{rest}");
    let rest = rest["entries"].as_array().unwrap();
    assert_eq!(rest.len(), 1);
    assert_eq!(rest[0]["commit"], seed.as_str());
    assert_eq!(rest[0]["parentCount"], 0);
    assert!(rest[0].get("firstParent").is_none(), "{rest:?}");
    // The seed commit's identity is an `@instafy.dev` service address.
    assert_eq!(rest[0]["actor"], "service");

    // The default page is 8 rows and a page is never longer than 50.
    for _ in 0..60 {
        sc.push_other(
            &[("count.md", Some(Uuid::new_v4().to_string().as_bytes()))],
            "more",
        );
    }
    sc.publish(Selection::None);
    assert_eq!(get("").await["entries"].as_array().unwrap().len(), 8);
    let capped = get("?limit=500").await;
    assert_eq!(capped["entries"].as_array().unwrap().len(), 50);
    assert_eq!(capped["hasMore"], true);
    server.abort();
}

/// The review of a saved version says whether it is a merge.
#[tokio::test(flavor = "multi_thread")]
async fn history_review_counts_the_parents_of_a_version() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    sc.write("mine.md", b"mine\n");
    sc.agent_commit(&["mine.md"], "local work");
    sc.push_other(&[("theirs.md", Some(b"theirs\n"))], "saved elsewhere");
    let report = sc.publish(Selection::None);
    let merge = report.rev.expect("a merge was published");
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    for (commit, parents) in [(merge.clone(), 2), (format!("{merge}^2"), 1)] {
        let body: serde_json::Value = client
            .get(format!("{base}/git/history/review"))
            .query(&[("commit", commit.as_str())])
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(body["parentCount"], parents, "{commit}: {body}");
    }
    server.abort();
}

/// Commit `files` (None deletes) and `links` (symlinks) on top of canonical
/// `main` in the other clone and push the commit to `reference` only.
fn push_to_ref(
    sc: &Scenario,
    files: &[(&str, Option<&[u8]>)],
    links: &[(&str, &str)],
    message: &str,
    reference: &str,
) -> String {
    git_in(&sc.other, &["fetch", "-q", "origin", "main"]);
    git_in(&sc.other, &["checkout", "-q", "--detach", "origin/main"]);
    for (path, contents) in files {
        match contents {
            Some(bytes) => write(&sc.other, path, bytes),
            None => fs::remove_file(sc.other.join(path)).unwrap(),
        }
    }
    for (path, target) in links {
        std::os::unix::fs::symlink(target, sc.other.join(path)).unwrap();
    }
    // Ignored files too: work kept elsewhere may hold them.
    git_in(&sc.other, &["add", "-A", "-f"]);
    git_in(&sc.other, &["commit", "-q", "-m", message]);
    git_in(
        &sc.other,
        &["push", "-q", "origin", &format!("HEAD:{reference}")],
    );
    let commit = git_in(&sc.other, &["rev-parse", "HEAD"]);
    git_in(&sc.other, &["checkout", "-q", "-f", "main"]);
    git_in(&sc.other, &["clean", "-q", "-fd"]);
    commit
}

fn recovery_ref_name(sc: &Scenario, name: &str) -> String {
    format!(
        "refs/instafy/recovery/{}/{name}",
        sc.config.origin_id.as_hyphenated()
    )
}

/// A reserved path that a version holds (pushed by another client) is never
/// served, and never reported absent: 404 `unsupported_entry`, as on the
/// hosted gateway. One the version does not hold is 404 `not_found`.
#[tokio::test(flavor = "multi_thread")]
async fn a_reserved_path_a_version_holds_is_an_unsupported_entry() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let reference = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    let commit = push_to_ref(
        &sc,
        &[
            (".instafy/x", Some(b"metadata\n")),
            ("notes.md", Some(b"notes\n")),
        ],
        &[],
        "Unsaved edits",
        &reference,
    );
    assert_eq!(
        sc.recovery_file(&reference, ".instafy/x").as_deref(),
        Some("metadata\n")
    );
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    for (route, path, code) in [
        ("files", ".instafy/x", "unsupported_entry"),
        ("raw", ".instafy/x", "unsupported_entry"),
        ("files", ".instafy", "unsupported_entry"),
        ("files", ".instafy/absent", "not_found"),
    ] {
        let response = client
            .get(format!("{base}/{route}/{path}"))
            .query(&[("ref", reference.as_str())])
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::NOT_FOUND,
            "{route} {path}"
        );
        assert_eq!(
            response
                .headers()
                .get("x-instafy-rev")
                .and_then(|value| value.to_str().ok()),
            Some(commit.as_str()),
            "{route} {path}"
        );
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["code"], code, "{route} {path}: {body}");
    }
    server.abort();
}

/// `?ref=` reads serve exactly what the recovery or salvage ref's commit
/// holds (never the folder), report the ref's tip in `X-Instafy-Rev` (also
/// on a 404) and the blob in `X-Instafy-Blob`; `?rev=` reads serve a commit
/// the checkout or canonical `main` holds, never one only a recovery ref
/// reaches.
#[tokio::test(flavor = "multi_thread")]
async fn reads_at_a_ref_or_rev_serve_the_commit_not_the_folder() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let seed = sc.head();
    let unsaved = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    let kept = push_to_ref(
        &sc,
        &[
            ("README.md", Some(b"kept readme\n")),
            ("kept.md", Some(b"kept\n")),
            ("dir/a.txt", Some(b"a\n")),
        ],
        &[("link", "README.md")],
        "unsaved work",
        &unsaved,
    );
    let tagged = recovery_ref_name(&sc, "20261005T120000Z-unsaved-tagged");
    git_in(&sc.other, &["tag", "-a", "-m", "note", "kept-tag", &kept]);
    git_in(
        &sc.other,
        &[
            "push",
            "-q",
            "origin",
            &format!("refs/tags/kept-tag:{tagged}"),
        ],
    );
    let tag = git_in(&sc.other, &["rev-parse", "kept-tag"]);
    let salvage = "refs/instafy/salvage/gateway/node-1-0123abcd";
    push_to_ref(
        &sc,
        &[("salvaged.md", Some(b"salvaged\n"))],
        &[],
        "salvage",
        salvage,
    );
    // The folder has its own edit; reads at a version never show it.
    sc.write("README.md", b"edited in the folder\n");

    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let get = |path: &str, query: Vec<(&str, String)>| {
        let request = client.get(format!("{base}{path}")).query(&query);
        async move { request.send().await.unwrap() }
    };
    let header = |response: &reqwest::Response, name: &str| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };

    let response = get("/files/README.md", vec![("ref", unsaved.clone())]).await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        header(&response, "x-instafy-rev").as_deref(),
        Some(kept.as_str())
    );
    assert_eq!(
        header(&response, "x-instafy-blob"),
        Some(crate::workspace_git::blob_oid(b"kept readme\n"))
    );
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["content_base64"], "a2VwdCByZWFkbWUK");
    assert!(body["modified"].is_null());

    let response = get("/raw/kept.md", vec![("ref", unsaved.clone())]).await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        header(&response, "x-instafy-rev").as_deref(),
        Some(kept.as_str())
    );
    assert!(header(&response, "content-security-policy").is_some());
    assert_eq!(response.bytes().await.unwrap().as_ref(), b"kept\n");

    let response = get("/entries", vec![("ref", unsaved.clone())]).await;
    assert_eq!(
        header(&response, "x-instafy-rev").as_deref(),
        Some(kept.as_str())
    );
    let listing: serde_json::Value = response.json().await.unwrap();
    let names: Vec<&str> = listing
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        names,
        vec!["dir", "doc.md", "kept.md", "logo.bin", "README.md"]
    );
    let dir = &listing[0];
    assert_eq!(dir["kind"], "directory");
    assert_eq!(dir["hasChildren"], true);
    let readme = listing
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "README.md")
        .unwrap();
    assert_eq!(
        readme["blobOid"].as_str(),
        Some(crate::workspace_git::blob_oid(b"kept readme\n").as_str())
    );
    let nested: serde_json::Value = get(
        "/entries",
        vec![("path", "dir".to_string()), ("ref", unsaved.clone())],
    )
    .await
    .json()
    .await
    .unwrap();
    assert_eq!(nested[0]["path"], "dir/a.txt");

    // Coded 404s, each naming the commit it looked at.
    for (path, code) in [
        ("/files/missing.md", "not_found"),
        ("/raw/dir/missing.txt", "not_found"),
        ("/files/link", "unsupported_entry"),
        ("/files/dir", "unsupported_entry"),
        ("/files/.instafy/x", "not_found"),
    ] {
        let response = get(path, vec![("ref", unsaved.clone())]).await;
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND, "{path}");
        assert_eq!(
            header(&response, "x-instafy-rev").as_deref(),
            Some(kept.as_str()),
            "{path}"
        );
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["code"], code, "{path}: {body}");
    }
    let response = get(
        "/entries",
        vec![("path", "link".to_string()), ("ref", unsaved.clone())],
    )
    .await;
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["code"],
        "unsupported_entry"
    );

    // An annotated tag ref reports its own id, which the list shows.
    let response = get("/files/kept.md", vec![("ref", tagged.clone())]).await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        header(&response, "x-instafy-rev").as_deref(),
        Some(tag.as_str())
    );
    // Salvage refs read the same way.
    let response = get("/files/salvaged.md", vec![("ref", salvage.to_string())]).await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);

    // A ref that does not resolve, or that is not a recovery or salvage
    // ref, or a read naming both: no version was read.
    for (query, status, code) in [
        (
            vec![(
                "ref",
                recovery_ref_name(&sc, "20261005T120000Z-unsaved-gone"),
            )],
            404,
            "rev_not_found",
        ),
        (
            vec![("ref", "refs/heads/main".to_string())],
            400,
            "invalid_ref",
        ),
        (
            vec![("ref", unsaved.clone()), ("rev", seed.clone())],
            400,
            "invalid_ref",
        ),
        (vec![("rev", "main".to_string())], 400, "invalid_rev"),
        (vec![("rev", "0".repeat(40))], 404, "rev_not_found"),
        // A recovery commit is read through its ref only.
        (vec![("rev", kept.clone())], 404, "rev_not_found"),
    ] {
        let response = get("/files/README.md", query.clone()).await;
        assert_eq!(response.status().as_u16(), status, "{query:?}");
        assert!(header(&response, "x-instafy-rev").is_none(), "{query:?}");
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["code"], code, "{query:?}: {body}");
    }

    // `?rev=`: a commit on the checkout's branch, and a newer canonical
    // commit the branch has not moved to yet (canonical `main` is fetched).
    let response = get("/files/README.md", vec![("rev", seed.clone())]).await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        header(&response, "x-instafy-rev").as_deref(),
        Some(seed.as_str())
    );
    let newer = sc.push_other(
        &[("README.md", Some(b"saved elsewhere\n"))],
        "saved elsewhere",
    );
    let response = get("/files/README.md", vec![("rev", newer.clone())]).await;
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["content_base64"], "c2F2ZWQgZWxzZXdoZXJlCg==");
    assert_eq!(sc.head(), seed, "the folder's branch did not move");
    assert_eq!(
        sc.disk("README.md").as_deref(),
        Some("edited in the folder\n")
    );
    // No fetch ref is left behind, and no local ref is named after a
    // recovery or salvage ref.
    assert!(sc.local_refs("refs/instafy/fetched").is_empty());
    assert!(sc.local_refs("refs/instafy/recovery").is_empty());
    assert!(sc.local_refs("refs/instafy/salvage").is_empty());

    // Without `rev` or `ref`, reads show the folder as before.
    let body: serde_json::Value = get("/files/README.md", vec![]).await.json().await.unwrap();
    assert_eq!(body["content_base64"], "ZWRpdGVkIGluIHRoZSBmb2xkZXIK");
    server.abort();
}

/// A diff or review of unsaved work (`ref=`) fetches the ref first, so the
/// commits it compares need not be here yet.
#[tokio::test(flavor = "multi_thread")]
async fn diffs_and_reviews_of_unsaved_work_fetch_the_ref() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let seed = sc.head();
    let reference = recovery_ref_name(&sc, "20261005T130000Z-conflict-0123456789ab");
    let kept = push_to_ref(
        &sc,
        &[("kept.md", Some(b"kept line\n"))],
        &[],
        "conflicting work",
        &reference,
    );
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let diff: serde_json::Value = client
        .get(format!("{base}/git/diff"))
        .query(&[
            ("path", "kept.md"),
            ("commit", kept.as_str()),
            ("base", seed.as_str()),
            ("ref", reference.as_str()),
        ])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(diff["error"].is_null(), "{diff}");
    assert!(
        diff["diff"].as_str().unwrap().contains("+kept line"),
        "{diff}"
    );

    let review: serde_json::Value = client
        .get(format!("{base}/git/history/review"))
        .query(&[("commit", kept.as_str()), ("ref", reference.as_str())])
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(review["error"].is_null(), "{review}");
    assert_eq!(review["entries"][0]["path"], "kept.md", "{review}");
    assert_eq!(review["parentCount"], 1);

    let gone = recovery_ref_name(&sc, "20261005T130000Z-conflict-gone");
    let response = client
        .get(format!("{base}/git/diff"))
        .query(&[("path", "kept.md"), ("ref", gone.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    assert_eq!(
        response.json::<serde_json::Value>().await.unwrap()["code"],
        "rev_not_found"
    );
    server.abort();
}

async fn post_json(
    client: &reqwest::Client,
    url: String,
    body: serde_json::Value,
) -> (reqwest::StatusCode, serde_json::Value) {
    let response = client.post(url).json(&body).send().await.unwrap();
    let status = response.status();
    (
        status,
        response.json().await.unwrap_or(serde_json::Value::Null),
    )
}

/// The unsaved-work list on a Desktop checkout: every recovery and salvage
/// ref of canonical, with its kind, paths, merge base with the folder's
/// branch and whether it may be removed; a restored salvage ref names the
/// restore commit.
#[tokio::test(flavor = "multi_thread")]
async fn recovery_list_describes_unsaved_work_and_restored_salvage() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let seed = sc.head();
    let unsaved = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    let unsaved_commit = push_to_ref(
        &sc,
        &[("notes.md", Some(b"notes\n"))],
        &[],
        "Unsaved edits\n\nInstafy-Recovery-Kind: unsaved\nInstafy-Path: notes.md",
        &unsaved,
    );
    let salvage = "refs/instafy/salvage/gateway/node-1-0123abcd";
    let salvage_commit = push_to_ref(
        &sc,
        &[("salvaged.md", Some(b"salvaged\n"))],
        &[],
        "Keep unsaved edits\n\nInstafy-Recovery-Kind: salvage\nInstafy-Path: salvaged.md",
        salvage,
    );
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let list = || {
        let client = client.clone();
        let url = format!("{base}/git/recovery");
        async move {
            let response = client.get(url).send().await.unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            response.json::<serde_json::Value>().await.unwrap()["entries"]
                .as_array()
                .unwrap()
                .clone()
        }
    };
    let entries = list().await;
    assert_eq!(entries.len(), 2, "{entries:?}");
    let by_ref = |entries: &[serde_json::Value], reference: &str| {
        entries
            .iter()
            .find(|entry| entry["ref"] == reference)
            .cloned()
            .unwrap_or_else(|| panic!("{reference} not listed in {entries:?}"))
    };
    let item = by_ref(&entries, &unsaved);
    assert_eq!(item["rev"], unsaved_commit.as_str());
    assert_eq!(item["kind"], "unsaved");
    assert_eq!(item["paths"], serde_json::json!(["notes.md"]));
    assert_eq!(item["base"], seed.as_str());
    assert_eq!(item["dismissible"], true);
    assert_eq!(item["origin"], sc.config.origin_id.to_string());
    assert!(item.get("restoredRev").is_none(), "{item}");
    let item = by_ref(&entries, salvage);
    assert_eq!(item["kind"], "salvage");
    assert_eq!(item["dismissible"], false);
    assert!(item["origin"].is_null());

    // Restoring the salvage ref keeps it, and the list now says it was
    // restored; a second restore has nothing left to do.
    let (status, body) = post_json(
        &client,
        format!("{base}/git/recovery/restore"),
        serde_json::json!({ "ref": salvage, "rev": salvage_commit }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], true, "{body}");
    assert_eq!(body["refDeleted"], false, "{body}");
    let restored = body["rev"].as_str().unwrap().to_string();
    assert_eq!(restored, sc.main());
    assert_eq!(sc.remote_file("salvaged.md").as_deref(), Some("salvaged\n"));
    assert_eq!(sc.remote_refs(salvage).len(), 1);
    let item = by_ref(&list().await, salvage);
    assert_eq!(item["restoredRev"], restored.as_str(), "{item}");
    let (status, body) = post_json(
        &client,
        format!("{base}/git/recovery/restore"),
        serde_json::json!({ "ref": salvage }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], false, "{body}");
    assert_eq!(body["marked"], false, "{body}");
    assert_eq!(body["rev"], restored.as_str());

    // A trailer naming the ref in a commit the origin did not make is not
    // a restore.
    sc.push_other(
        &[("x.md", Some(b"x\n"))],
        &format!("Claim\n\nInstafy-Restored-From: {unsaved}"),
    );
    sc.publish(Selection::None);
    assert!(by_ref(&list().await, &unsaved).get("restoredRev").is_none());
    server.abort();
}

/// Only a restore marks unsaved work restored. The origin commits every
/// save as itself, so a trailer in a save's message, the restore message
/// sent as a save, or a commit with the restore subject and more text never
/// counts: saves drop the trailer, and only the exact restore message does.
#[tokio::test(flavor = "multi_thread")]
async fn a_save_message_never_marks_unsaved_work_restored() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let salvage = "refs/instafy/salvage/gateway/node-1-0123abcd";
    let salvage_commit = push_to_ref(
        &sc,
        &[("salvaged.md", Some(b"salvaged\n"))],
        &[],
        "Keep unsaved edits\n\nInstafy-Recovery-Kind: salvage\nInstafy-Path: salvaged.md",
        salvage,
    );
    let unsaved = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    push_to_ref(
        &sc,
        &[("notes.md", Some(b"notes\n"))],
        &[],
        "Unsaved edits",
        &unsaved,
    );
    let other = recovery_ref_name(&sc, "20261005T121500Z-unsaved-0123456789ac");
    push_to_ref(
        &sc,
        &[("other.md", Some(b"other\n"))],
        &[],
        "Unsaved edits",
        &other,
    );
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let list = || {
        let client = client.clone();
        let url = format!("{base}/git/recovery");
        async move {
            let response = client.get(url).send().await.unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            response.json::<serde_json::Value>().await.unwrap()["entries"]
                .as_array()
                .unwrap()
                .clone()
        }
    };
    let restored_rev = |entries: &[serde_json::Value], reference: &str| {
        entries
            .iter()
            .find(|entry| entry["ref"] == reference)
            .unwrap_or_else(|| panic!("{reference} not listed in {entries:?}"))
            .get("restoredRev")
            .cloned()
    };

    // A save whose message carries the trailer.
    sc.write("unrelated.md", b"tidy\n");
    let (status, body) = post_json(
        &client,
        format!("{base}/git/sync"),
        serde_json::json!({
            "paths": ["unrelated.md"],
            "message": format!(
                "Tidy\n\nInstafy-Resolved-By: assistant\nInstafy-Restored-From: {salvage}"
            ),
        }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    let saved = git_in(&sc.remote, &["log", "-1", "--format=%B", "main"]);
    assert!(!saved.contains("Restored-From"), "{saved}");
    assert!(saved.contains("Instafy-Resolved-By: assistant"), "{saved}");
    // Saves whose whole message is the restore message, in any letter case.
    sc.write("another.md", b"another\n");
    let (status, body) = post_json(
        &client,
        format!("{base}/git/sync"),
        serde_json::json!({
            "message": format!("Restore unsaved work\n\ninstafy-restored-from: {unsaved}\n"),
        }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    sc.write("unrelated.md", b"tidy again\n");
    let (status, body) = post_json(
        &client,
        format!("{base}/git/sync"),
        serde_json::json!({
            "paths": ["unrelated.md"],
            "message": format!("Restore unsaved work\n\nInstafy-Restored-From: {unsaved}\n"),
        }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    // Prose that only starts with `Instafy-` is not a trailer: it stays.
    sc.write("unrelated.md", b"tidy with prose\n");
    let prose = "Instafy-style buttons on the landing page\n\nInstafy-hosted docs are linked now";
    let (status, body) = post_json(
        &client,
        format!("{base}/git/sync"),
        serde_json::json!({ "paths": ["unrelated.md"], "message": prose }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    let saved = git_in(&sc.remote, &["log", "-1", "--format=%B", "main"]);
    assert_eq!(saved.trim_end(), prose);
    // Trailers the origin or the gateway trusts, hidden behind control
    // characters or in another letter case, through a save and an apply.
    sc.write("unrelated.md", b"tidy a third time\n");
    let hidden = format!(
        "Tidy\n\n\u{1}Instafy-Restored-From: {salvage}\n\
         \t\u{1b}INSTAFY-APPLY-KEY: imp:forged\nInstafy-Apply-Fingerprint: abc\n\
         Instafy-Resolved-By: assistant\n"
    );
    let (status, body) = post_json(
        &client,
        format!("{base}/git/sync"),
        serde_json::json!({ "paths": ["unrelated.md"], "message": hidden }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    let saved = git_in(&sc.remote, &["log", "-1", "--format=%B", "main"]);
    assert_eq!(saved.trim_end(), "Tidy\n\nInstafy-Resolved-By: assistant");
    let response = client
        .post(format!("{base}/apply-json"))
        .json(&serde_json::json!({
            "manifest": {
                "projectId": sc.config.project_id,
                "files": [{ "path": "applied.md", "size": 8 }],
                "deletes": [],
                "autoCommitAfterApply": true,
                "commitMessage": hidden,
            },
            "archiveBase64": apply_archive("applied.md", b"applied\n"),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let applied = ig(&sc.ws, &["log", "-1", "--format=%B", "HEAD"]);
    assert_eq!(applied.trim_end(), "Tidy\n\nInstafy-Resolved-By: assistant");
    let (status, body) =
        post_json(&client, format!("{base}/git/sync"), serde_json::json!({})).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    let messages = git_in(&sc.remote, &["log", "--format=%B", "main"]);
    let lowered = messages.to_ascii_lowercase();
    for trailer in ["restored-from", "apply-key", "apply-fingerprint"] {
        assert!(!lowered.contains(trailer), "{trailer}: {messages}");
    }
    // A commit by the origin's own identity with the restore subject and
    // more than the one trailer.
    git_in(&sc.other, &["pull", "-q", "--ff-only", "origin", "main"]);
    git_in(
        &sc.other,
        &[
            "-c",
            "user.name=Instafy Origin",
            "-c",
            "user.email=origin@instafy.dev",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            &format!(
                "Restore unsaved work\n\nInstafy-Restored-From: {other}\nInstafy-Resolved-By: assistant"
            ),
        ],
    );
    git_in(&sc.other, &["push", "-q", "origin", "main"]);
    sc.publish(Selection::None);

    let entries = list().await;
    for reference in [salvage, unsaved.as_str(), other.as_str()] {
        assert_eq!(restored_rev(&entries, reference), None, "{reference}");
    }
    assert!(sc.remote_file("salvaged.md").is_none());
    assert!(sc.remote_file("notes.md").is_none());

    // A real restore still counts.
    let (status, body) = post_json(
        &client,
        format!("{base}/git/recovery/restore"),
        serde_json::json!({ "ref": salvage, "rev": salvage_commit }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], true, "{body}");
    let entries = list().await;
    assert_eq!(
        restored_rev(&entries, salvage),
        Some(serde_json::Value::String(sc.main()))
    );
    server.abort();
}

/// A multi-tenant `/git/sync` commits with `git commit` in the project's
/// checkout, not through the publish, so only the route drops the trailers
/// the origin or the gateway trusts from the caller's message; the rest of
/// the message stays.
#[tokio::test(flavor = "multi_thread")]
async fn multi_tenant_saves_drop_origin_trailers_at_the_route() {
    let sc = Scenario::new(Options::default());
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let mut config = sc.config.clone();
    config.multi_tenant = true;
    config.hosted_checkout = false;
    config.workspace_root = root.clone();
    let workspace = config.workspace_root_for_project(config.project_id);
    fs::create_dir_all(&workspace).unwrap();
    let project = ServerConfig {
        workspace_root: workspace.clone(),
        ..config.clone()
    };
    ensure_git_checkout(&project, None).expect("project checkout");
    write(&workspace, "notes.md", b"notes\n");
    let (base, server) = serve_config(config, root).await;

    let salvage = "refs/instafy/salvage/gateway/node-1-0123abcd";
    let (status, body) = post_json(
        &reqwest::Client::new(),
        format!("{base}/git/sync"),
        serde_json::json!({
            "paths": ["notes.md"],
            "message": format!(
                "Tidy\n\nInstafy-Resolved-By: assistant\nInstafy-Restored-From: {salvage}\n\
                 \u{1}INSTAFY-APPLY-KEY: imp:forged"
            ),
        }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(sc.remote_file("notes.md").as_deref(), Some("notes\n"));
    let saved = git_in(&sc.remote, &["log", "-1", "--format=%B", "main"]);
    assert_eq!(saved, "Tidy\n\nInstafy-Resolved-By: assistant");
    server.abort();
}

/// The publish drops the same trailers from its own message, whoever calls
/// it: a Desktop save never relies on the route alone.
#[test]
fn a_publish_drops_origin_trailers_from_its_message() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let salvage = "refs/instafy/salvage/gateway/node-1-0123abcd";
    sc.write("notes.md", b"notes\n");
    let report = publish(
        &sc.ctx(true),
        PublishRequest {
            selection: Selection::Paths(vec!["notes.md".to_string()]),
            message: format!("Restore unsaved work\n\nInstafy-Restored-From: {salvage}\n"),
            author: None,
            budget: Duration::from_secs(30),
        },
    )
    .expect("publish");
    assert_eq!(report.git_sync_status, SyncStatus::Published, "{report:?}");
    let saved = git_in(&sc.remote, &["log", "-1", "--format=%B", "main"]);
    assert_eq!(saved, "Restore unsaved work");
}

/// Restore on a Desktop checkout: the work lands on `main` as one commit
/// committed by the origin with an `Instafy-Restored-From` trailer, the
/// recovery ref is removed once all of it is restored or kept on request
/// (so it cannot be restored twice), a ref whose work could not all come
/// back stays, and a moved ref, a conflict or an unsaved edit in the way
/// refuses it.
#[tokio::test(flavor = "multi_thread")]
async fn restore_route_restores_unsaved_work_once() {
    let sc = Scenario::new(Options {
        desktop: true,
        seed: vec![(".gitignore", b"*.log\n".to_vec())],
        ..Options::default()
    });
    let unsaved = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    let unsaved_commit = push_to_ref(
        &sc,
        &[("notes.md", Some(b"notes\n"))],
        &[],
        "Unsaved edits",
        &unsaved,
    );
    let refused = recovery_ref_name(&sc, "20261005T121500Z-unsaved-0123456789ac");
    let refused_commit = push_to_ref(
        &sc,
        &[
            ("kept.md", Some(b"kept\n")),
            (".env", Some(b"TOKEN=1\n")),
            ("debug.log", Some(b"log\n")),
        ],
        &[],
        "Unsaved edits with a secret",
        &refused,
    );
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let restore =
        |body: serde_json::Value| post_json(&client, format!("{base}/git/recovery/restore"), body);

    // A ref that moved since the list was read is refused.
    let (status, body) = restore(serde_json::json!({ "ref": unsaved, "rev": sc.main() })).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "recovery_ref_moved");
    assert_eq!(body["rev"], unsaved_commit.as_str());

    // Work that cannot all come back (a secret, an ignored file) is
    // restored as far as it can be, and its ref stays for the person to
    // review or remove: nothing they did not choose to leave out is lost.
    let (status, body) =
        restore(serde_json::json!({ "ref": refused, "rev": refused_commit })).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], true, "{body}");
    assert_eq!(body["marked"], false, "{body}");
    assert_eq!(body["refDeleted"], false, "{body}");
    assert_eq!(body["gitSyncStatus"], "published");
    assert_eq!(
        body["notRestored"],
        serde_json::json!([".env", "debug.log"])
    );
    assert_eq!(sc.remote_file("kept.md").as_deref(), Some("kept\n"));
    assert!(sc.remote_file(".env").is_none());
    assert!(sc.remote_file("debug.log").is_none());
    assert_eq!(sc.remote_refs(&refused).len(), 1);
    // Restoring it again finds nothing more to bring back, adds no version
    // (its restore commit is on `main`), and keeps it.
    let main = sc.main();
    let (status, body) =
        restore(serde_json::json!({ "ref": refused, "rev": refused_commit })).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], false, "{body}");
    assert_eq!(body["marked"], false, "{body}");
    assert_eq!(body["refDeleted"], false, "{body}");
    assert_eq!(sc.main(), main);
    assert_eq!(sc.remote_refs(&refused).len(), 1);

    let (status, body) =
        restore(serde_json::json!({ "ref": unsaved, "rev": unsaved_commit })).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], true);
    assert_eq!(body["refDeleted"], true);
    assert_eq!(body["gitSyncStatus"], "published");
    assert_eq!(body["notRestored"], serde_json::json!([]));
    assert_eq!(sc.remote_file("notes.md").as_deref(), Some("notes\n"));
    assert_eq!(sc.disk("notes.md").as_deref(), Some("notes\n"));
    assert!(sc.remote_refs(&unsaved).is_empty());
    let head = git_in(&sc.remote, &["log", "-1", "--format=%cn <%ce>%n%B", "main"]);
    assert!(
        head.starts_with("Instafy Origin <origin@instafy.dev>\nRestore unsaved work\n"),
        "{head}"
    );
    assert!(
        head.contains(&format!("Instafy-Restored-From: {unsaved}")),
        "{head}"
    );

    // It cannot be restored twice.
    let (status, body) =
        restore(serde_json::json!({ "ref": unsaved, "rev": unsaved_commit })).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "recovery_ref_moved");
    let (status, body) = restore(serde_json::json!({ "ref": unsaved })).await;
    assert_eq!(status, reqwest::StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["code"], "rev_not_found");

    // Work that changed a line the saved version changed too.
    let conflicted = recovery_ref_name(&sc, "20261005T130000Z-conflict-0123456789ab");
    let conflict_commit = push_to_ref(
        &sc,
        &[
            (
                "README.md",
                Some(b"one\ntwo by the agent\nthree\nfour\nfive\n"),
            ),
            ("other.md", Some(b"other\n")),
        ],
        &[],
        "agent work",
        &conflicted,
    );
    sc.push_other(
        &[(
            "README.md",
            Some(b"one\ntwo by a person\nthree\nfour\nfive\n"),
        )],
        "saved",
    );
    sc.publish(Selection::None);
    let (status, body) = restore(serde_json::json!({ "ref": conflicted })).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "restore_conflict");
    assert_eq!(body["paths"], serde_json::json!(["README.md"]));
    assert_eq!(body["head"], sc.head().as_str());
    // Keeping the saved version of the conflicted file restores the rest.
    let (status, body) = restore(serde_json::json!({
        "ref": conflicted,
        "rev": conflict_commit,
        "keep": ["README.md"],
    }))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], true);
    assert_eq!(body["notRestored"], serde_json::json!(["README.md"]));
    // Everything left out was left out on request: the ref goes.
    assert_eq!(body["refDeleted"], true, "{body}");
    assert!(sc.remote_refs(&conflicted).is_empty());
    assert_eq!(sc.remote_file("other.md").as_deref(), Some("other\n"));
    assert!(sc
        .remote_file("README.md")
        .unwrap()
        .contains("two by a person"));

    // An unsaved edit of a file the restore changes stays, and refuses it.
    let edits = recovery_ref_name(&sc, "20261005T140000Z-unsaved-fedcba987654");
    push_to_ref(
        &sc,
        &[("doc.md", Some(b"restored doc\n"))],
        &[],
        "doc",
        &edits,
    );
    sc.write("doc.md", b"typed in the folder\n");
    let (status, body) = restore(serde_json::json!({ "ref": edits })).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "dirty_paths");
    assert_eq!(body["paths"], serde_json::json!(["doc.md"]));
    assert_eq!(sc.disk("doc.md").as_deref(), Some("typed in the folder\n"));
    assert_eq!(sc.remote_refs(&edits).len(), 1);

    let (status, body) = restore(serde_json::json!({ "ref": "refs/heads/main" })).await;
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(body["code"], "invalid_ref");
    server.abort();
}

/// Every restore that lands leaves a restore commit naming its ref. With
/// nothing left to bring back (after "Use this version" saved the
/// conflicted file, after "Keep current" for everything, or when all that
/// is left is a secret or a file `main` now ignores), it is an empty one,
/// the answer is `marked` (not `committed`), and the list shows the entry
/// restored for good: later saves of the same files do not bring it back
/// as pending. A second restore adds nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_restore_with_nothing_left_to_bring_back_is_recorded_for_good() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let salvage = "refs/instafy/salvage/gateway/node-1-0123abcd";
    let salvage_commit = push_to_ref(
        &sc,
        &[("salvaged.md", Some(b"salvaged\n"))],
        &[],
        "Keep unsaved edits\n\nInstafy-Recovery-Kind: salvage\nInstafy-Path: salvaged.md",
        salvage,
    );
    let kept = "refs/instafy/salvage/gateway/node-1-0123abce";
    let kept_commit = push_to_ref(
        &sc,
        &[("other.md", Some(b"salvaged other\n"))],
        &[],
        "Keep unsaved edits\n\nInstafy-Recovery-Kind: salvage\nInstafy-Path: other.md",
        kept,
    );
    // Holds a `.env` file, which a restore always refuses.
    let refused = "refs/instafy/salvage/gateway/node-1-0123abcf";
    push_to_ref(
        &sc,
        &[("held.md", Some(b"held\n")), (".env", Some(b"TOKEN=1\n"))],
        &[],
        "Keep unsaved edits\n\nInstafy-Recovery-Kind: salvage",
        refused,
    );
    let ignored = "refs/instafy/salvage/gateway/node-1-0123abd0";
    push_to_ref(
        &sc,
        &[
            ("held.md", Some(b"held\n")),
            ("notes/plan.md", Some(b"the plan\n")),
        ],
        &[],
        "Keep unsaved edits\n\nInstafy-Recovery-Kind: salvage",
        ignored,
    );
    sc.push_other(
        &[
            ("salvaged.md", Some(b"saved since\n")),
            ("other.md", Some(b"other saved since\n")),
            ("held.md", Some(b"held\n")),
            (".gitignore", Some(b"notes/\n")),
        ],
        "saved since",
    );
    sc.publish(Selection::None);
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let list = || {
        let client = client.clone();
        let url = format!("{base}/git/recovery");
        async move {
            let response = client.get(url).send().await.unwrap();
            assert_eq!(response.status(), reqwest::StatusCode::OK);
            response.json::<serde_json::Value>().await.unwrap()["entries"]
                .as_array()
                .unwrap()
                .clone()
        }
    };
    let restored_rev = |entries: &[serde_json::Value], reference: &str| {
        entries
            .iter()
            .find(|entry| entry["ref"] == reference)
            .unwrap_or_else(|| panic!("{reference} not listed in {entries:?}"))
            .get("restoredRev")
            .and_then(|rev| rev.as_str().map(str::to_string))
    };
    let restore =
        |body: serde_json::Value| post_json(&client, format!("{base}/git/recovery/restore"), body);
    // A marker: the restore message, committed by the origin, with its
    // parent's tree.
    let is_marker = |commit: &str, reference: &str| {
        let message = git_in(&sc.remote, &["log", "-1", "--format=%ce%n%B", commit]);
        let tree = git_in(&sc.remote, &["rev-parse", &format!("{commit}^{{tree}}")]);
        let parent = git_in(&sc.remote, &["rev-parse", &format!("{commit}^^{{tree}}")]);
        message.trim_end()
            == format!(
                "origin@instafy.dev\nRestore unsaved work\n\nInstafy-Restored-From: {reference}"
            )
            && tree == parent
    };

    let entries = list().await;
    for reference in [salvage, kept, refused, ignored] {
        assert_eq!(restored_rev(&entries, reference), None, "{reference}");
    }

    // "Use this version", then the restore of the rest.
    let (status, body) = restore(serde_json::json!({ "ref": salvage })).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["paths"], serde_json::json!(["salvaged.md"]));
    sc.write("salvaged.md", b"salvaged\n");
    let (status, body) = post_json(
        &client,
        format!("{base}/git/sync"),
        serde_json::json!({ "paths": ["salvaged.md"] }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    let (status, body) =
        restore(serde_json::json!({ "ref": salvage, "rev": salvage_commit })).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], false, "{body}");
    assert_eq!(body["refDeleted"], false, "{body}");
    let marker = sc.main();
    assert_eq!(body["rev"], marker.as_str(), "{body}");
    assert!(is_marker(&marker, salvage), "{marker}");
    assert_eq!(body["marked"], true, "{body}");
    assert_eq!(restored_rev(&list().await, salvage), Some(marker.clone()));
    // Saving the same file again does not bring the entry back.
    sc.write("salvaged.md", b"edited after the restore\n");
    let (status, body) = post_json(
        &client,
        format!("{base}/git/sync"),
        serde_json::json!({ "paths": ["salvaged.md"] }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_ne!(sc.main(), marker);
    assert_eq!(restored_rev(&list().await, salvage), Some(marker.clone()));
    assert_eq!(sc.remote_refs(salvage).len(), 1);

    // "Keep current" for everything, after `main` moved while an unsaved
    // file in the folder keeps the branch where it was: the marker is
    // merged in as a second parent, and found there.
    sc.push_other(&[("unrelated.md", Some(b"unrelated\n"))], "unrelated");
    sc.write("unrelated.md", b"typed in the folder\n");
    let (status, body) = restore(serde_json::json!({
        "ref": kept,
        "rev": kept_commit,
        "keep": ["other.md"],
    }))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], false, "{body}");
    assert_eq!(body["marked"], true, "{body}");
    let kept_marker = body["localRev"].as_str().unwrap().to_string();
    assert_ne!(kept_marker, sc.main());
    assert!(on_main(&sc, &kept_marker));
    assert!(is_marker(&kept_marker, kept), "{kept_marker}");
    assert_eq!(restored_rev(&list().await, kept), Some(kept_marker));
    fs::remove_file(sc.ws.join("unrelated.md")).unwrap();

    // What is left is a secret, or a file `main` now ignores.
    for (reference, left_out) in [(refused, ".env"), (ignored, "notes/plan.md")] {
        let (status, body) = restore(serde_json::json!({ "ref": reference })).await;
        assert_eq!(status, reqwest::StatusCode::OK, "{reference}: {body}");
        assert_eq!(body["committed"], false, "{reference}: {body}");
        assert_eq!(body["marked"], true, "{reference}: {body}");
        assert_eq!(body["notRestored"], serde_json::json!([left_out]));
        let marker = body["localRev"].as_str().unwrap().to_string();
        assert!(on_main(&sc, &marker), "{reference}");
        assert!(is_marker(&marker, reference), "{reference}");
        assert_eq!(restored_rev(&list().await, reference), Some(marker.clone()));
        // A second restore adds nothing.
        let main = sc.main();
        let (status, body) = restore(serde_json::json!({ "ref": reference })).await;
        assert_eq!(status, reqwest::StatusCode::OK, "{reference}: {body}");
        assert_eq!(body["committed"], false, "{reference}: {body}");
        assert_eq!(body["marked"], false, "{reference}: {body}");
        assert_eq!(body["rev"], main.as_str(), "{reference}: {body}");
        assert_eq!(sc.main(), main);
    }
    let (status, body) =
        restore(serde_json::json!({ "ref": salvage, "rev": salvage_commit })).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(restored_rev(&list().await, salvage), Some(marker));
    server.abort();
}

/// A marker whose publish failed is not a restore yet; the retry that
/// publishes it is `marked`.
#[tokio::test(flavor = "multi_thread")]
async fn a_marker_that_did_not_reach_main_goes_out_with_the_retry() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let salvage = "refs/instafy/salvage/gateway/node-1-0123abcd";
    push_to_ref(
        &sc,
        &[("held.md", Some(b"held\n"))],
        &[],
        "Keep unsaved edits\n\nInstafy-Recovery-Kind: salvage",
        salvage,
    );
    sc.push_other(&[("held.md", Some(b"held\n"))], "saved the same");
    sc.publish(Selection::None);
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let restore = || {
        post_json(
            &client,
            format!("{base}/git/recovery/restore"),
            serde_json::json!({ "ref": salvage }),
        )
    };
    let restored_rev = || {
        let client = client.clone();
        let url = format!("{base}/git/recovery");
        async move {
            let listed: serde_json::Value =
                client.get(url).send().await.unwrap().json().await.unwrap();
            listed["entries"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["ref"] == salvage)
                .unwrap_or_else(|| panic!("{salvage} not listed in {listed}"))
                .get("restoredRev")
                .cloned()
        }
    };

    let hook = close_main(&sc);
    let main_before = sc.main();
    let (status, body) = restore().await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "not_saved", "{body}");
    assert_eq!(body["committed"], false, "{body}");
    assert_eq!(body["marked"], true, "{body}");
    assert_eq!(sc.main(), main_before);
    assert_eq!(restored_rev().await, None);

    fs::remove_file(hook).unwrap();
    let (status, body) = restore().await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], false, "{body}");
    assert_eq!(body["marked"], true, "{body}");
    assert_ne!(sc.main(), main_before);
    assert_eq!(body["rev"], sc.main().as_str());
    assert_eq!(
        git_in(
            &sc.remote,
            &["rev-list", "--count", &format!("{main_before}..main")]
        ),
        "1"
    );
    assert_eq!(
        restored_rev().await,
        Some(serde_json::Value::String(sc.main()))
    );
    server.abort();
}

/// The first publish of a checkout whose history is unrelated to `main`
/// replays its commits onto `main`, leaving out those that change nothing
/// there. A salvage restore's empty marker is replayed all the same, so
/// the first restore is recorded on `main`, and a second one adds nothing.
#[tokio::test(flavor = "multi_thread")]
async fn a_salvage_marker_survives_the_first_publish_of_an_unrelated_history() {
    let sc = Scenario::new(Options {
        desktop: true,
        empty: true,
        ..Options::default()
    });
    sc.write("LICENSE", b"license\n");
    sc.agent_commit(&["LICENSE"], "agent bootstrap");
    write(&sc.other, "LICENSE", b"license\n");
    git_in(&sc.other, &["add", "-A"]);
    git_in(&sc.other, &["commit", "-q", "-m", "first"]);
    git_in(&sc.other, &["push", "-q", "origin", "main"]);
    let salvage = "refs/instafy/salvage/gateway/node-1-0123abcd";
    push_to_ref(
        &sc,
        &[(".env", Some(b"TOKEN=1\n"))],
        &[],
        "Keep unsaved edits\n\nInstafy-Recovery-Kind: salvage",
        salvage,
    );
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let restore = || {
        post_json(
            &client,
            format!("{base}/git/recovery/restore"),
            serde_json::json!({ "ref": salvage }),
        )
    };
    let main_before = sc.main();

    let (status, body) = restore().await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["notRestored"], serde_json::json!([".env"]), "{body}");
    assert_eq!(body["refDeleted"], false, "{body}");
    let marker = sc.main();
    assert_ne!(marker, main_before, "{body}");
    assert_eq!(body["rev"], marker.as_str(), "{body}");
    assert_eq!(
        git_in(
            &sc.remote,
            &["rev-list", "--count", &format!("{main_before}..main")]
        ),
        "1"
    );
    assert_eq!(
        git_in(&sc.remote, &["log", "-1", "--format=%ce%n%B", "main"]),
        format!("origin@instafy.dev\nRestore unsaved work\n\nInstafy-Restored-From: {salvage}")
    );
    assert_eq!(
        git_in(&sc.remote, &["rev-parse", "main^{tree}"]),
        git_in(
            &sc.remote,
            &["rev-parse", &format!("{main_before}^{{tree}}")]
        )
    );
    let listed: serde_json::Value = client
        .get(format!("{base}/git/recovery"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let entry = listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["ref"] == salvage)
        .cloned()
        .unwrap_or_else(|| panic!("{salvage} not listed in {listed}"));
    assert_eq!(entry["restoredRev"], marker.as_str(), "{entry}");

    let (status, body) = restore().await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], false, "{body}");
    assert_eq!(body["marked"], false, "{body}");
    assert_eq!(sc.main(), marker);
    server.abort();
}

/// A restore that reaches `main` only in part (the repository policy
/// refused one of its files) keeps the recovery ref: what was refused is
/// still only there. (A restore that does not reach `main` at all keeps it
/// too; see `a_restore_counts_only_once_main_has_it`.)
#[tokio::test(flavor = "multi_thread")]
async fn a_partly_published_restore_keeps_its_ref() {
    let sc = Scenario::new(Options {
        desktop: true,
        hook: true,
        hook_env: vec![("GIT_DENY_PATHS", "*.zip")],
        ..Options::default()
    });
    // Stored on canonical without the hook, as an older client could have.
    let reference = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    git_in(&sc.other, &["fetch", "-q", "origin", "main"]);
    git_in(&sc.other, &["checkout", "-q", "--detach", "origin/main"]);
    write(&sc.other, "ok.md", b"ok\n");
    write(&sc.other, "data.zip", b"PK fake archive\n");
    git_in(&sc.other, &["add", "-A"]);
    git_in(&sc.other, &["commit", "-q", "-m", "Unsaved edits"]);
    let commit = git_in(&sc.other, &["rev-parse", "HEAD"]);
    git_in(
        &sc.remote,
        &[
            "fetch",
            "-q",
            sc.other.to_str().unwrap(),
            &format!("{commit}:{reference}"),
        ],
    );
    git_in(&sc.other, &["checkout", "-q", "-f", "main"]);
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();

    let (status, body) = post_json(
        &client,
        format!("{base}/git/recovery/restore"),
        serde_json::json!({ "ref": reference, "rev": commit }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["gitSyncStatus"], "partial", "{body}");
    assert_eq!(body["committed"], true, "{body}");
    assert_eq!(body["refDeleted"], false, "{body}");
    assert_eq!(sc.remote_file("ok.md").as_deref(), Some("ok\n"));
    assert!(sc.remote_file("data.zip").is_none());
    assert_eq!(sc.remote_refs(&reference).len(), 1);
    assert_eq!(
        sc.recovery_file(&reference, "data.zip").as_deref(),
        Some("PK fake archive\n")
    );
    server.abort();
}

/// A restore whose publish did not reach `main` is not restored yet: the
/// ref stays, the list shows no `restoredRev` until canonical `main` has
/// the restore commit, and the retry that publishes it reports
/// `committed: true` (it made the new version reach `main`).
#[tokio::test(flavor = "multi_thread")]
async fn a_restore_counts_only_once_main_has_it() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let reference = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    let commit = push_to_ref(
        &sc,
        &[("notes.md", Some(b"notes\n"))],
        &[],
        "Unsaved edits",
        &reference,
    );
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let restore = || {
        post_json(
            &client,
            format!("{base}/git/recovery/restore"),
            serde_json::json!({ "ref": reference, "rev": commit }),
        )
    };

    let hook = close_main(&sc);
    let main_before = sc.main();
    let (status, body) = restore().await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "not_saved", "{body}");
    assert_eq!(body["committed"], true, "{body}");
    assert_eq!(body["marked"], false, "{body}");
    assert_eq!(body["refDeleted"], false, "{body}");
    assert_eq!(sc.main(), main_before);
    assert_eq!(sc.remote_refs(&reference).len(), 1);

    let listed: serde_json::Value = client
        .get(format!("{base}/git/recovery"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let entry = listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["ref"] == reference.as_str())
        .cloned()
        .unwrap_or_else(|| panic!("{reference} not listed in {listed}"));
    assert!(entry.get("restoredRev").is_none(), "{entry}");

    // Once `main` takes pushes again, the retry publishes the restore.
    fs::remove_file(hook).unwrap();
    let (status, body) = restore().await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["gitSyncStatus"], "published", "{body}");
    assert_eq!(body["committed"], true, "{body}");
    assert_eq!(body["marked"], false, "{body}");
    assert_eq!(body["refDeleted"], true, "{body}");
    assert_eq!(body["rev"], sc.main().as_str());
    assert_eq!(sc.remote_file("notes.md").as_deref(), Some("notes\n"));
    let head = git_in(&sc.remote, &["log", "-1", "--format=%B", "main"]);
    assert!(head.starts_with("Restore unsaved work\n"), "{head}");
    // The retry published the first call's commit; it wrote no second one.
    assert_eq!(
        git_in(
            &sc.remote,
            &["rev-list", "--count", &format!("{main_before}..main")]
        ),
        "1"
    );
    server.abort();
}

/// Restoring the `unpublished` entry of this checkout's own save that
/// could not reach `main` publishes that save: `main` takes the work, so
/// the answer is `committed: true` (a new version), and the ref, which the
/// publish retired because its commits are on `main` now, is reported as
/// removed. The save itself is the new version: no empty restore commit
/// lands on top of it.
#[tokio::test(flavor = "multi_thread")]
async fn restoring_this_checkouts_own_unpublished_save_reports_the_new_version() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let hook = close_main(&sc);
    let main_before = sc.main();
    sc.write("draft.md", b"draft\n");
    let (status, body) = post_json(
        &client,
        format!("{base}/git/sync"),
        serde_json::json!({ "paths": ["draft.md"] }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "not_saved", "{body}");
    fs::remove_file(hook).unwrap();

    let listed: serde_json::Value = client
        .get(format!("{base}/git/recovery"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let entries = listed["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1, "{listed}");
    assert_eq!(entries[0]["kind"], "unpublished", "{listed}");
    let reference = entries[0]["ref"].as_str().unwrap().to_string();
    let rev = entries[0]["rev"].as_str().unwrap().to_string();

    let (status, body) = post_json(
        &client,
        format!("{base}/git/recovery/restore"),
        serde_json::json!({ "ref": reference, "rev": rev }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["gitSyncStatus"], "published", "{body}");
    assert_eq!(body["committed"], true, "{body}");
    assert_eq!(body["marked"], false, "{body}");
    assert_eq!(body["refDeleted"], true, "{body}");
    assert_eq!(body["rev"], sc.main().as_str(), "{body}");
    assert_ne!(sc.main(), main_before);
    assert_eq!(
        git_in(
            &sc.remote,
            &["log", "--format=%s", &format!("{main_before}..main")]
        ),
        "Save workspace changes"
    );
    assert_eq!(sc.remote_file("draft.md").as_deref(), Some("draft\n"));
    assert!(sc.remote_refs("refs/instafy/recovery").is_empty());
    let listed: serde_json::Value = client
        .get(format!("{base}/git/recovery"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(listed["entries"], serde_json::json!([]), "{listed}");
    server.abort();
}

/// A restore's `keep` list is bounded: past the bound the request is
/// refused before anything is fetched or restored, so no list can hold the
/// project's apply lock for long. Within it, entries are matched by path.
#[tokio::test(flavor = "multi_thread")]
async fn a_restore_keep_list_is_bounded() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let reference = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    let commit = push_to_ref(
        &sc,
        &[("docs/a.md", Some(b"a\n")), ("docs2/b.md", Some(b"b\n"))],
        &[],
        "Unsaved edits",
        &reference,
    );
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let too_many: Vec<String> = (0..=crate::publish::MAX_RESTORE_KEEP_PATHS)
        .map(|index| format!("kept/{index}.md"))
        .collect();
    let (status, body) = post_json(
        &client,
        format!("{base}/git/recovery/restore"),
        serde_json::json!({ "ref": reference, "rev": commit, "keep": too_many }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(sc.remote_refs(&reference).len(), 1);
    assert!(sc.remote_file("docs/a.md").is_none());

    // At the bound it goes ahead; `docs` keeps `docs/a.md`, not `docs2/`.
    let mut keep: Vec<String> = (1..crate::publish::MAX_RESTORE_KEEP_PATHS)
        .map(|index| format!("kept/{index}.md"))
        .collect();
    keep.push("docs".to_string());
    let (status, body) = post_json(
        &client,
        format!("{base}/git/recovery/restore"),
        serde_json::json!({ "ref": reference, "rev": commit, "keep": keep }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["notRestored"], serde_json::json!(["docs/a.md"]));
    assert_eq!(sc.remote_file("docs2/b.md").as_deref(), Some("b\n"));
    assert!(sc.remote_file("docs/a.md").is_none());
    server.abort();
}

/// Work that adds a folder where `main` now has a file conflicts on both
/// paths. Keeping the saved version of either side, or of both, clears
/// the clash and restores the rest; keeping only part of the folder does
/// not, because the rest of it would still be dropped silently.
#[tokio::test(flavor = "multi_thread")]
async fn keep_clears_a_file_and_folder_conflict() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let mut refs = Vec::new();
    for (index, files) in [
        vec!["docs/readme.md", "other-0.md"],
        vec!["docs/readme.md", "other-1.md"],
        vec!["docs/readme.md", "other-2.md"],
        vec!["docs/readme.md", "docs/extra.md", "other-3.md"],
    ]
    .into_iter()
    .enumerate()
    {
        let reference =
            recovery_ref_name(&sc, &format!("20261005T12000{index}Z-unsaved-0123456789ab"));
        let contents: Vec<(&str, Option<&[u8]>)> = files
            .iter()
            .map(|path| (*path, Some(b"work\n".as_slice())))
            .collect();
        let commit = push_to_ref(&sc, &contents, &[], "Unsaved edits", &reference);
        refs.push((reference, commit));
    }
    sc.push_other(&[("docs", Some(b"a file now\n"))], "docs is a file");
    sc.publish(Selection::None);
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let restore =
        |body: serde_json::Value| post_json(&client, format!("{base}/git/recovery/restore"), body);

    let (status, body) = restore(serde_json::json!({ "ref": refs[0].0 })).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "restore_conflict");
    assert_eq!(body["paths"], serde_json::json!(["docs", "docs/readme.md"]));

    for (index, keep) in [
        serde_json::json!(["docs", "docs/readme.md"]),
        serde_json::json!(["docs"]),
        serde_json::json!(["docs/readme.md"]),
    ]
    .into_iter()
    .enumerate()
    {
        let (reference, commit) = &refs[index];
        let (status, body) =
            restore(serde_json::json!({ "ref": reference, "rev": commit, "keep": keep })).await;
        assert_eq!(status, reqwest::StatusCode::OK, "{keep}: {body}");
        assert_eq!(body["committed"], true, "{keep}: {body}");
        assert_eq!(
            body["notRestored"],
            serde_json::json!(["docs/readme.md"]),
            "{keep}: {body}"
        );
        assert_eq!(body["refDeleted"], true, "{keep}: {body}");
        assert_eq!(
            sc.remote_file(&format!("other-{index}.md")).as_deref(),
            Some("work\n")
        );
        assert_eq!(sc.remote_file("docs").as_deref(), Some("a file now\n"));
    }

    // Keeping one file of the folder leaves the other in the clash.
    let (reference, commit) = &refs[3];
    let (status, body) = restore(serde_json::json!({
        "ref": reference,
        "rev": commit,
        "keep": ["docs/readme.md"],
    }))
    .await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "restore_conflict");
    assert_eq!(body["paths"], serde_json::json!(["docs", "docs/extra.md"]));
    assert!(sc.remote_file("other-3.md").is_none());
    server.abort();
}

/// Keeping a folder settles its clash, but a file below it that can never
/// come back here (a secret, which the conflict never showed) is still
/// refused, not kept on request: the ref stays, so that work is not
/// removed on the person's behalf.
#[tokio::test(flavor = "multi_thread")]
async fn a_kept_folder_never_lets_refused_work_below_it_go() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let reference = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    let commit = push_to_ref(
        &sc,
        &[
            ("docs/readme.md", Some(b"work\n")),
            ("docs/.env", Some(b"TOKEN=1\n")),
            ("other.md", Some(b"other\n")),
        ],
        &[],
        "Unsaved edits",
        &reference,
    );
    sc.push_other(&[("docs", Some(b"a file now\n"))], "docs is a file");
    sc.publish(Selection::None);
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let restore =
        |body: serde_json::Value| post_json(&client, format!("{base}/git/recovery/restore"), body);

    let (status, body) = restore(serde_json::json!({ "ref": reference, "rev": commit })).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["paths"], serde_json::json!(["docs", "docs/readme.md"]));

    let (status, body) = restore(serde_json::json!({
        "ref": reference,
        "rev": commit,
        "keep": ["docs", "docs/readme.md"],
    }))
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], true, "{body}");
    assert_eq!(
        body["notRestored"],
        serde_json::json!(["docs/.env", "docs/readme.md"])
    );
    assert_eq!(body["refDeleted"], false, "{body}");
    assert_eq!(sc.remote_refs(&reference).len(), 1);
    assert_eq!(
        sc.recovery_file(&reference, "docs/.env").as_deref(),
        Some("TOKEN=1\n")
    );
    assert_eq!(sc.remote_file("other.md").as_deref(), Some("other\n"));
    assert_eq!(sc.remote_file("docs").as_deref(), Some("a file now\n"));
    server.abort();
}

/// Work that `main` started to ignore after it was kept cannot be restored
/// here. The restore says so and keeps the ref, the only copy of that work
/// on canonical, so the person can still review or remove it. A recovery
/// ref gets no empty restore commit (only a salvage ref, which can never be
/// removed, does): `main` stays where it was and the entry stays pending.
#[tokio::test(flavor = "multi_thread")]
async fn restoring_work_main_now_ignores_keeps_its_ref() {
    let sc = Scenario::new(Options {
        desktop: true,
        hook: true,
        ..Options::default()
    });
    let reference = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    let commit = push_to_ref(
        &sc,
        &[("notes/plan.md", Some(b"the plan\n"))],
        &[],
        "Unsaved edits\n\nInstafy-Recovery-Kind: unsaved\nInstafy-Path: notes/plan.md",
        &reference,
    );
    sc.push_other(&[(".gitignore", Some(b"notes/\n"))], "ignore notes");
    sc.publish(Selection::None);
    assert_eq!(sc.disk(".gitignore").as_deref(), Some("notes/\n"));
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let main_before = sc.main();

    let (status, body) = post_json(
        &client,
        format!("{base}/git/recovery/restore"),
        serde_json::json!({ "ref": reference, "rev": commit }),
    )
    .await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(body["committed"], false, "{body}");
    assert_eq!(body["marked"], false, "{body}");
    assert_eq!(body["notRestored"], serde_json::json!(["notes/plan.md"]));
    assert_eq!(body["refDeleted"], false, "{body}");
    assert_eq!(body["rev"], main_before.as_str(), "{body}");
    assert_eq!(sc.main(), main_before);
    assert_eq!(sc.remote_refs(&reference).len(), 1);
    assert!(sc.remote_file("notes/plan.md").is_none());

    // Still listed (pending, and dismissible), and still readable at the
    // ref.
    let listed: serde_json::Value = client
        .get(format!("{base}/git/recovery"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let entry = listed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["ref"] == reference.as_str())
        .cloned()
        .unwrap_or_else(|| panic!("{reference} not listed in {listed}"));
    assert!(entry.get("restoredRev").is_none(), "{entry}");
    assert_eq!(entry["dismissible"], true, "{entry}");
    let response = client
        .get(format!("{base}/files/notes/plan.md"))
        .query(&[("ref", reference.as_str())])
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    server.abort();
}

/// Dismiss removes a recovery ref for everyone only while it still names
/// what the person saw; salvage refs stay.
#[tokio::test(flavor = "multi_thread")]
async fn dismiss_route_removes_unsaved_work_under_a_lease() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let reference = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    let commit = push_to_ref(
        &sc,
        &[("notes.md", Some(b"notes\n"))],
        &[],
        "edits",
        &reference,
    );
    let salvage = "refs/instafy/salvage/gateway/node-1-0123abcd";
    let salvage_commit = push_to_ref(&sc, &[("s.md", Some(b"s\n"))], &[], "salvage", salvage);
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    let dismiss =
        |body: serde_json::Value| post_json(&client, format!("{base}/git/recovery/dismiss"), body);

    let (status, body) = dismiss(serde_json::json!({ "ref": reference, "rev": sc.main() })).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "recovery_ref_moved");
    assert_eq!(sc.remote_refs(&reference).len(), 1);

    let (status, body) = dismiss(serde_json::json!({ "ref": reference, "rev": commit })).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(
        body,
        serde_json::json!({ "dismissed": true, "missing": false })
    );
    assert!(sc.remote_refs(&reference).is_empty());

    let (status, body) = dismiss(serde_json::json!({ "ref": reference, "rev": commit })).await;
    assert_eq!(status, reqwest::StatusCode::OK, "{body}");
    assert_eq!(
        body,
        serde_json::json!({ "dismissed": false, "missing": true })
    );

    let (status, body) =
        dismiss(serde_json::json!({ "ref": salvage, "rev": salvage_commit })).await;
    assert_eq!(status, reqwest::StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "salvage_ref_kept");
    assert_eq!(sc.remote_refs(salvage).len(), 1);

    for (body, code) in [
        (
            serde_json::json!({ "ref": "refs/heads/main", "rev": commit }),
            "invalid_ref",
        ),
        (serde_json::json!({ "ref": reference }), "invalid_rev"),
        (
            serde_json::json!({ "ref": reference, "rev": "main" }),
            "invalid_rev",
        ),
    ] {
        let (status, answer) = dismiss(body.clone()).await;
        assert_eq!(status, reqwest::StatusCode::BAD_REQUEST, "{body}: {answer}");
        assert_eq!(answer["code"], code, "{body}: {answer}");
    }
    server.abort();
}

/// Without a canonical repository there is no unsaved work to list: the
/// list answers 404, which clients read as "not supported here", like an
/// origin without the route.
#[tokio::test(flavor = "multi_thread")]
async fn unsaved_work_without_a_canonical_repository_is_unsupported() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let mut config = sc.config.clone();
    config.git_remote_url = None;
    config.git_remote_base_url = None;
    let (base, server) = serve_config(config, sc.ws.clone()).await;
    let response = reqwest::Client::new()
        .get(format!("{base}/git/recovery"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["code"], "not_supported", "{body}");
    assert!(body.get("entries").is_none(), "{body}");
    server.abort();
}

/// A multi-tenant origin serves no recovery routes.
#[tokio::test(flavor = "multi_thread")]
async fn a_multi_tenant_origin_mounts_no_recovery_routes() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let mut config = Scenario::new(Options::default()).config;
    config.workspace_root = root.clone();
    config.git_remote_url = None;
    config.multi_tenant = true;
    let (base, server) = serve_config(config, root).await;
    let client = reqwest::Client::new();
    let response = client
        .get(format!("{base}/git/recovery"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND);
    for path in ["/git/recovery/restore", "/git/recovery/dismiss"] {
        let response = client
            .post(format!("{base}{path}"))
            .json(&serde_json::json!({}))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::NOT_FOUND, "{path}");
    }
    server.abort();
}

/// A path the shard refuses never keeps the rest of a stop's work local:
/// the recovery commit is pushed without it, so a drain sees nothing
/// unpushed.
#[test]
fn policy_refused_path_in_parked_work_is_left_out_and_the_rest_pushed() {
    let sc = Scenario::new(Options {
        hook: true,
        hook_env: vec![("GIT_DENY_PATHS", "*.zip")],
        ..Options::default()
    });
    sc.write("bundle.zip", b"PK fake archive\n");
    sc.write("notes.md", b"keep me\n");
    let report = flush(&sc.ctx(true), false).unwrap();
    assert_eq!(report.unpushed_refs, 0, "{report:?}");
    let pushed = sc.remote_refs("refs/instafy/recovery/");
    assert_eq!(pushed.len(), 1, "{pushed:?}");
    assert_eq!(
        sc.recovery_file(&pushed[0].0, "notes.md").as_deref(),
        Some("keep me\n")
    );
    assert!(sc.recovery_file(&pushed[0].0, "bundle.zip").is_none());
    assert_eq!(
        sc.local_refs(crate::recovery::LOCAL_RECOVERY_REJECTED_ROOT)
            .len(),
        1,
        "the refused copy stays local"
    );
    assert!(sc.ws.join("bundle.zip").exists());
}

/// r4.1: a flush with a clean tree still pushes every never-pushed local
/// recovery ref, here the one a stop without network left behind.
#[test]
fn flush_with_a_clean_tree_pushes_a_never_pushed_local_ref() {
    let sc = Scenario::new(Options::default());
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nleft over\n");
    let offline = flush(&sc.ctx(false), false).unwrap();
    assert_eq!(offline.unpushed_refs, 1, "{offline:?}");
    let name = offline.recovery_refs[0].name.clone();
    assert_eq!(offline.unpushed_ref_names, vec![name.clone()]);

    ig(&sc.ws, &["checkout", "--", "doc.md"]);
    assert!(sc.status().is_empty(), "{}", sc.status());
    let report = flush(&sc.ctx(true), false).unwrap();
    assert!(report.recovery_refs.is_empty(), "{report:?}");
    assert!(report.publish.is_none(), "{report:?}");
    assert_eq!(report.unpushed_refs, 0);
    assert!(report.unpushed_ref_names.is_empty());
    let canonical = format!("refs/instafy/recovery/{}/{name}", sc.config.origin_id);
    assert_eq!(sc.remote_refs(&canonical).len(), 1);
    assert!(sc
        .recovery_file(&canonical, "doc.md")
        .unwrap()
        .contains("left over"));
    assert_eq!(
        sc.remote_file("doc.md").as_deref(),
        Some("alpha\nbeta\ngamma\ndelta\n"),
        "parked work never reaches main"
    );
}

/// A Desktop folder belongs to the user: the flush route refuses it and
/// leaves the folder exactly as it is.
#[tokio::test(flavor = "multi_thread")]
async fn flush_route_refuses_a_desktop_folder() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nunsaved\n");
    let (base, server) = serve(&sc).await;
    let response = reqwest::Client::new()
        .post(format!("{base}/git/flush"))
        .json(&serde_json::json!({ "turnActive": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::BAD_REQUEST);
    assert!(sc.local_refs("refs/instafy/").is_empty());
    assert!(sc.remote_refs("refs/instafy/").is_empty());
    assert_eq!(
        sc.disk("doc.md").as_deref(),
        Some("alpha\nbeta\ngamma\ndelta\nunsaved\n")
    );
    server.abort();
}

/// What the stand-in controller saw from the origin.
#[derive(Default)]
struct ControllerCalls {
    /// (bearer, requested scopes) of every git token request.
    git_tokens: Vec<(String, Vec<String>)>,
    lease_checks: Vec<String>,
}

struct StubController {
    base: String,
    calls: std::sync::Arc<std::sync::Mutex<ControllerCalls>>,
    refuse_git_write: std::sync::Arc<std::sync::atomic::AtomicBool>,
    encoding_key: jsonwebtoken::EncodingKey,
    server: tokio::task::JoinHandle<()>,
}

const MACHINE_TOKEN: &str = "runtime-machine-token";

impl StubController {
    /// A controller that publishes a JWKS, answers the origin's workspace
    /// lease check for `lease`, and mints git.write only for the exact
    /// fs.write bearer `bearer()` returns; a machine credential never gets
    /// git.write, as on the real controller.
    async fn start(project_id: Uuid, lease_id: Uuid, user_id: Uuid, runtime_id: Uuid) -> Self {
        use axum::extract::{Json as AxumJson, State};
        use axum::http::{HeaderMap, StatusCode};
        use axum::routing::{get, post};
        use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
        use base64::Engine as _;
        use ring::rand::SystemRandom;
        use ring::signature::{Ed25519KeyPair, KeyPair as _};

        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let key_pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let jwks = serde_json::json!({
            "keys": [{
                "kty": "OKP",
                "crv": "Ed25519",
                "alg": "EdDSA",
                "use": "sig",
                "kid": "stub-key",
                "x": URL_SAFE_NO_PAD.encode(key_pair.public_key().as_ref()),
            }]
        });
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(pkcs8.as_ref())
        );
        let encoding_key = jsonwebtoken::EncodingKey::from_ed_pem(pem.as_bytes()).unwrap();

        #[derive(Clone)]
        struct Stub {
            jwks: serde_json::Value,
            lease: serde_json::Value,
            calls: std::sync::Arc<std::sync::Mutex<ControllerCalls>>,
            refuse_git_write: std::sync::Arc<std::sync::atomic::AtomicBool>,
        }
        fn bearer(headers: &HeaderMap) -> String {
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
                .unwrap_or_default()
                .to_string()
        }

        let calls = std::sync::Arc::new(std::sync::Mutex::new(ControllerCalls::default()));
        let refuse_git_write = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stub = Stub {
            jwks,
            lease: serde_json::json!({
                "lease": {
                    "leaseId": lease_id,
                    "projectId": project_id,
                    "userId": user_id,
                    "runtimeId": runtime_id,
                    "expiresAt": (chrono::Utc::now() + chrono::Duration::minutes(5)).to_rfc3339(),
                }
            }),
            calls: calls.clone(),
            refuse_git_write: refuse_git_write.clone(),
        };
        let app = axum::Router::new()
            .route(
                "/.well-known/jwks.json",
                get(|State(stub): State<Stub>| async move { AxumJson(stub.jwks) }),
            )
            .route(
                "/projects/:project_id/lease",
                get(|State(stub): State<Stub>, headers: HeaderMap| async move {
                    let bearer = bearer(&headers);
                    stub.calls.lock().unwrap().lease_checks.push(bearer.clone());
                    if bearer == MACHINE_TOKEN || bearer.is_empty() {
                        return Err(StatusCode::UNAUTHORIZED);
                    }
                    Ok(AxumJson(stub.lease))
                }),
            )
            .route(
                "/projects/:project_id/git/access_token",
                post(
                    |State(stub): State<Stub>,
                     headers: HeaderMap,
                     AxumJson(body): AxumJson<serde_json::Value>| async move {
                        let bearer = bearer(&headers);
                        let scopes: Vec<String> = body["scopes"]
                            .as_array()
                            .map(|scopes| {
                                scopes
                                    .iter()
                                    .filter_map(|scope| scope.as_str().map(str::to_string))
                                    .collect()
                            })
                            .unwrap_or_default();
                        let write = scopes.iter().any(|scope| scope == "git.write");
                        stub.calls
                            .lock()
                            .unwrap()
                            .git_tokens
                            .push((bearer.clone(), scopes));
                        if write && bearer == MACHINE_TOKEN {
                            return Err(StatusCode::FORBIDDEN);
                        }
                        if write
                            && stub
                                .refuse_git_write
                                .load(std::sync::atomic::Ordering::SeqCst)
                        {
                            return Err(StatusCode::UNAUTHORIZED);
                        }
                        Ok(AxumJson(serde_json::json!({
                            "token": "minted-git-token",
                            "expiresIn": 60,
                        })))
                    },
                ),
            )
            .with_state(stub);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        StubController {
            base,
            calls,
            refuse_git_write,
            encoding_key,
            server,
        }
    }

    /// The save-only permission the controller's own stop path issues when
    /// nobody holds a workspace lease: scope `workspace.flush`, bound to the
    /// runtime generation (`lease_id` is the runtime lease), in the space
    /// owner's name.
    fn save_grant_token(
        &self,
        config: &ServerConfig,
        owner: Uuid,
        runtime_id: Uuid,
        runtime_lease_id: Uuid,
    ) -> String {
        let now = chrono::Utc::now().timestamp();
        let header = jsonwebtoken::Header {
            kid: Some("stub-key".to_string()),
            ..jsonwebtoken::Header::new(jsonwebtoken::Algorithm::EdDSA)
        };
        jsonwebtoken::encode(
            &header,
            &serde_json::json!({
                "aud": config.origin_id.to_string(),
                "sub": owner.to_string(),
                "project_id": config.project_id.to_string(),
                "origin_id": config.origin_id.to_string(),
                "runtime_id": runtime_id.to_string(),
                "protocol": "http",
                "scopes": [crate::routes::PRE_STOP_SAVE_SCOPE],
                "lease_id": runtime_lease_id.to_string(),
                "iat": now,
                "exp": now + 60,
            }),
            &self.encoding_key,
        )
        .unwrap()
    }

    /// The short-lived fs.write origin token the controller mints for the
    /// workspace lease holder before a stop.
    fn origin_token(
        &self,
        config: &ServerConfig,
        lease_id: Uuid,
        user_id: Uuid,
        runtime_id: Uuid,
    ) -> String {
        self.origin_token_with(config, lease_id, user_id, runtime_id, serde_json::json!({}))
    }

    /// [`Self::origin_token`] with `extra` claims added (an author, a run).
    fn origin_token_with(
        &self,
        config: &ServerConfig,
        lease_id: Uuid,
        user_id: Uuid,
        runtime_id: Uuid,
        extra: serde_json::Value,
    ) -> String {
        let now = chrono::Utc::now().timestamp();
        let header = jsonwebtoken::Header {
            kid: Some("stub-key".to_string()),
            ..jsonwebtoken::Header::new(jsonwebtoken::Algorithm::EdDSA)
        };
        let mut claims = serde_json::json!({
            "aud": config.origin_id.to_string(),
            "sub": user_id.to_string(),
            "project_id": config.project_id.to_string(),
            "origin_id": config.origin_id.to_string(),
            "runtime_id": runtime_id.to_string(),
            "protocol": "http",
            "scopes": ["fs.write"],
            "lease_id": lease_id.to_string(),
            "iat": now,
            "exp": now + 60,
        });
        for (key, value) in extra.as_object().expect("extra claims are an object") {
            claims[key] = value.clone();
        }
        jsonwebtoken::encode(&header, &claims, &self.encoding_key).unwrap()
    }
}

/// r3 test 8 in its r4.1 form: the controller's pre-stop flush through the
/// origin's real mint path. The origin checks the caller's workspace lease,
/// exchanges that exact fs.write token for git.write (its machine credential
/// is never offered, and the controller would refuse it), parks the
/// unfinished turn instead of publishing it, and pushes the parked ref. When
/// the controller refuses git.write, the work stays on a local ref that the
/// next refresh pushes.
#[tokio::test(flavor = "multi_thread")]
async fn flush_route_gets_git_write_only_through_the_callers_token() {
    let sc = Scenario::new(Options::default());
    let lease_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let controller =
        StubController::start(sc.config.project_id, lease_id, user_id, runtime_id).await;
    let mut config = sc.config.clone();
    config.skip_auth = false;
    config.controller_base_url = Url::parse(&controller.base).unwrap();
    config.jwks_url = Url::parse(&format!("{}/.well-known/jwks.json", controller.base)).unwrap();
    config.controller_internal_token = Some(MACHINE_TOKEN.to_string());
    let token = controller.origin_token(&config, lease_id, user_id, runtime_id);
    let (base, server) = serve_config(config, sc.ws.clone()).await;
    let client = reqwest::Client::new();

    let unauthenticated = client
        .post(format!("{base}/git/flush"))
        .json(&serde_json::json!({ "turnActive": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthenticated.status(), reqwest::StatusCode::UNAUTHORIZED);
    let machine = client
        .post(format!("{base}/git/flush"))
        .bearer_auth(MACHINE_TOKEN)
        .json(&serde_json::json!({ "turnActive": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(machine.status(), reqwest::StatusCode::UNAUTHORIZED);
    assert!(sc.local_refs("refs/instafy/").is_empty());

    // Mid-turn: the turn's commit and its unsaved edit go to a recovery ref.
    sc.write("half.rs", b"fn half() {\n");
    let half = sc.agent_commit(&["half.rs"], "half done");
    sc.write("notes.md", b"scratch\n");
    let main_before = sc.main();
    let response = client
        .post(format!("{base}/git/flush"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "turnActive": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["unpushedRefs"], 0, "{body}");
    assert_eq!(body["unpushedRefNames"], serde_json::json!([]), "{body}");
    assert_eq!(body["parkedCommits"], 1, "{body}");
    assert_eq!(sc.main(), main_before, "nothing of the turn reached main");
    assert!(!git_output(
        &sc.remote,
        &["merge-base", "--is-ancestor", &half, "main"],
        None
    )
    .status
    .success());
    let parked = body["recoveryRefs"][0]["reference"].as_str().unwrap();
    assert!(parked.starts_with(&format!("refs/instafy/recovery/{}/", sc.config.origin_id)));
    assert_eq!(
        sc.recovery_file(parked, "half.rs").as_deref(),
        Some("fn half() {\n")
    );
    assert_eq!(
        sc.recovery_file(parked, "notes.md").as_deref(),
        Some("scratch\n")
    );
    {
        let calls = controller.calls.lock().unwrap();
        assert!(calls.lease_checks.iter().all(|bearer| bearer == &token));
        let writes: Vec<&String> = calls
            .git_tokens
            .iter()
            .filter(|(_, scopes)| scopes.iter().any(|scope| scope == "git.write"))
            .map(|(bearer, _)| bearer)
            .collect();
        assert_eq!(
            writes,
            vec![&token],
            "git.write is minted only with the caller's token"
        );
    }

    // The controller refuses git.write (the holder lost access): the work
    // stays on a local ref, and the next refresh with access pushes it.
    controller
        .refuse_git_write
        .store(true, std::sync::atomic::Ordering::SeqCst);
    sc.write("later.md", b"written after the turn\n");
    let response = client
        .post(format!("{base}/git/flush"))
        .bearer_auth(&token)
        .json(&serde_json::json!({ "turnActive": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["unpushedRefs"], 1, "{body}");
    let name = body["unpushedRefNames"][0].as_str().unwrap().to_string();
    let canonical = format!("refs/instafy/recovery/{}/{name}", sc.config.origin_id);
    assert!(sc.remote_refs(&canonical).is_empty());
    assert_eq!(
        sc.local_refs(&format!("{LOCAL_RECOVERY_ROOT}/{name}"))
            .len(),
        1
    );
    let refreshed = refresh(&sc.ctx(true)).unwrap();
    assert_eq!(refreshed.unpushed_refs, 0, "{refreshed:?}");
    assert_eq!(sc.remote_refs(&canonical).len(), 1);
    assert_eq!(
        sc.recovery_file(&canonical, "later.md").as_deref(),
        Some("written after the turn\n")
    );
    assert!(sc.remote_file("later.md").is_none());
    {
        let calls = controller.calls.lock().unwrap();
        assert!(
            calls
                .git_tokens
                .iter()
                .all(|(bearer, scopes)| bearer != MACHINE_TOKEN
                    || !scopes.iter().any(|scope| scope == "git.write")),
            "the machine credential was offered for git.write"
        );
    }
    server.abort();
    controller.server.abort();
}

/// The read-only refresh a runtime runs before a turn it could not lease:
/// the checkout follows `main` while it holds nothing unpublished, keeps
/// unsaved edits, and never pushes.
#[test]
fn read_only_refresh_follows_main_and_never_pushes() {
    let sc = Scenario::new(Options::default());
    sc.push_other(
        &[("doc.md", Some(b"alpha\nbeta\ngamma\ndelta\nweb\n"))],
        "web edit",
    );
    sc.write("notes.md", b"unsaved\n");

    let report = refresh(&sc.ctx(false)).unwrap();
    assert_eq!(
        report.rev.as_deref(),
        Some(sc.main().as_str()),
        "{report:?}"
    );
    assert!(report.checkout_moved, "{report:?}");
    assert_eq!(sc.head(), sc.main());
    assert_eq!(
        sc.disk("doc.md").as_deref(),
        Some("alpha\nbeta\ngamma\ndelta\nweb\n")
    );
    assert_eq!(sc.disk("notes.md").as_deref(), Some("unsaved\n"));
    assert!(sc.remote_file("notes.md").is_none());

    // A local commit that is not on main stays put, and nothing is pushed.
    let before = sc.main();
    sc.agent_commit(&["notes.md"], "agent: notes");
    let local = sc.head();
    sc.push_other(&[("README.md", Some(b"web readme\n"))], "web readme");
    let report = refresh(&sc.ctx(false)).unwrap();
    assert_eq!(
        report.git_sync_status,
        SyncStatus::Unpublished,
        "{report:?}"
    );
    assert!(!report.checkout_moved);
    assert_eq!(sc.head(), local);
    assert_ne!(sc.main(), before);
    assert!(sc.remote_file("notes.md").is_none());
    assert!(sc.remote_refs("refs/instafy/").is_empty());
}

// ---------------------------------------------------------------------------
// Review fixes: a stop keeps everything locally first, dismissals hold
// whatever the branch did since, refs follow the origin that made them, and
// nothing that may not be published reaches any canonical ref.
// ---------------------------------------------------------------------------

/// An update hook on the remote that refuses only `main`, so recovery refs
/// still push. Returns the hook's path.
fn close_main(sc: &Scenario) -> PathBuf {
    use std::os::unix::fs::PermissionsExt as _;
    let hook = sc.remote.join("hooks").join("update");
    fs::write(
        &hook,
        "#!/bin/sh\nif [ \"$1\" = refs/heads/main ]; then echo 'main is closed' >&2; exit 1; fi\nexit 0\n",
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    hook
}

fn on_main(sc: &Scenario, commit: &str) -> bool {
    git_output(
        &sc.remote,
        &["merge-base", "--is-ancestor", commit, "main"],
        None,
    )
    .status
    .success()
}

/// Make the remote unreachable for the length of `body`.
fn without_remote<T>(sc: &Scenario, body: impl FnOnce() -> T) -> T {
    let away = sc.root.join("remote-away.git");
    fs::rename(&sc.remote, &away).unwrap();
    let result = body();
    fs::rename(&away, &sc.remote).unwrap();
    result
}

/// Saves `x.rs` while `main` refuses every push: its commit L is parked on
/// an `unpublished` ref that reaches canonical. Returns (L, canonical ref);
/// `main` accepts pushes again afterwards.
fn parked_and_pushed(sc: &Scenario) -> (String, String) {
    let hook = close_main(sc);
    sc.write("x.rs", b"fn x() {}\n");
    let refused = sc.publish_paths(&["x.rs"]);
    assert_eq!(
        refused.git_sync_status,
        SyncStatus::Unpublished,
        "{refused:?}"
    );
    let reference = refused.recovery_ref.clone().expect("parked");
    assert!(
        reference.starts_with("refs/instafy/recovery/") && reference.contains("-unpublished-"),
        "{reference}"
    );
    fs::remove_file(hook).unwrap();
    (sc.head(), reference)
}

/// A stop without write access keeps a finished commit that is not on
/// `main` on a local ref, before anything else; the next refresh publishes
/// the commit and retires the copy.
#[test]
fn flush_without_a_token_parks_finished_commits_locally() {
    let sc = Scenario::new(Options::default());
    sc.write("done.rs", b"fn done() {}\n");
    let commit = sc.agent_commit(&["done.rs"], "finished work");
    let report = flush(&sc.ctx(false), false).unwrap();
    assert_eq!(report.unpushed_refs, 1, "{report:?}");
    let pending = sc.local_refs(LOCAL_RECOVERY_ROOT);
    assert_eq!(pending.len(), 1, "{pending:?}");
    assert!(pending[0].0.contains("-unpublished-"), "{pending:?}");
    assert_eq!(sc.head(), commit, "the commit stays on the branch");
    assert!(sc.remote_refs("refs/instafy/").is_empty());

    let refreshed = refresh(&sc.ctx(true)).unwrap();
    assert_eq!(
        refreshed.git_sync_status,
        SyncStatus::Published,
        "{refreshed:?}"
    );
    assert!(on_main(&sc, &commit));
    assert_eq!(refreshed.unpushed_refs, 0);
    assert!(sc.local_refs(LOCAL_RECOVERY_ROOT).is_empty());
    assert!(
        sc.remote_refs("refs/instafy/recovery/").is_empty(),
        "the copy is retired once its commits are on main"
    );
}

/// A stop whose remote is unreachable keeps the finished commit and the
/// unsaved edit on local refs; a later refresh puts both on canonical.
#[test]
fn flush_without_network_keeps_finished_commits_and_edits_locally() {
    let sc = Scenario::new(Options::default());
    sc.write("done.rs", b"fn done() {}\n");
    let commit = sc.agent_commit(&["done.rs"], "finished work");
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nunsaved\n");
    let report = without_remote(&sc, || flush(&sc.ctx(true), false).unwrap());
    assert_eq!(report.unpushed_refs, 2, "{report:?}");
    let names: Vec<String> = sc
        .local_refs(LOCAL_RECOVERY_ROOT)
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    assert!(
        names.iter().any(|name| name.contains("-unpublished-")),
        "{names:?}"
    );
    assert!(
        names.iter().any(|name| name.contains("-unsaved-")),
        "{names:?}"
    );

    refresh(&sc.ctx(true)).unwrap();
    assert!(on_main(&sc, &commit));
    assert_eq!(
        sc.remote_file("doc.md").as_deref(),
        Some("alpha\nbeta\ngamma\ndelta\n"),
        "an unsaved edit reached main"
    );
    let unsaved: Vec<(String, String)> = sc
        .remote_refs("refs/instafy/recovery/")
        .into_iter()
        .filter(|(name, _)| name.contains("-unsaved-"))
        .collect();
    assert_eq!(unsaved.len(), 1, "{unsaved:?}");
    assert!(sc
        .recovery_file(&unsaved[0].0, "doc.md")
        .unwrap()
        .contains("unsaved"));
}

/// The process shutdown flush (no write access) keeps a finished commit on a
/// local ref, so eviction keeps the checkout, and records the clean stop.
#[tokio::test]
async fn hosted_shutdown_parks_finished_commits_and_records_a_clean_stop() {
    let sc = Scenario::new(Options::default());
    sc.write("done.rs", b"fn done() {}\n");
    sc.agent_commit(&["done.rs"], "finished work");
    let mut server = crate::server::OriginHttpServer::new(sc.config.clone()).unwrap();
    server.stop_flushing_workspace().await.unwrap();
    let pending = sc.local_refs(LOCAL_RECOVERY_ROOT);
    assert_eq!(pending.len(), 1, "{pending:?}");
    assert!(pending[0].0.contains("-unpublished-"));
    assert!(sc.ws.join(crate::server::CLEAN_STOP_MARKER).exists());
}

/// A shutdown that interrupted a turn sets the turn's commits aside: the
/// next refresh does not publish them.
#[tokio::test]
async fn shutdown_during_a_turn_keeps_its_commits_off_main() {
    let sc = Scenario::new(Options::default());
    sc.write("half.rs", b"fn half() {\n");
    let half = sc.agent_commit(&["half.rs"], "half done");
    let mut server = crate::server::OriginHttpServer::new(sc.config.clone()).unwrap();
    server
        .stop_flushing_workspace_during_turn(true)
        .await
        .unwrap();
    let pending = sc.local_refs(LOCAL_RECOVERY_ROOT);
    assert_eq!(pending.len(), 1, "{pending:?}");
    assert!(pending[0].0.contains("-unsaved-"));
    assert_ne!(sc.head(), half);
    assert_eq!(sc.disk("half.rs").as_deref(), Some("fn half() {\n"));
    refresh(&sc.ctx(true)).unwrap();
    assert!(!on_main(&sc, &half));
    assert!(sc.remote_file("half.rs").is_none());
}

/// When publishing the finished commits fails, the stop still keeps them
/// and the unsaved edit, and pushes both copies.
#[test]
fn flush_keeps_everything_when_publishing_fails() {
    use std::os::unix::fs::PermissionsExt as _;
    let sc = Scenario::new(Options::default());
    sc.write("done.rs", b"fn done() {}\n");
    let commit = sc.agent_commit(&["done.rs"], "finished work");
    sc.push_other(&[("notes/plan.md", Some(b"plan\n"))], "remote moved");
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nunsaved\n");
    // A git whose three-way merge fails, so the publish errors after the
    // local copies exist.
    let real_git = git_in(&sc.root, &["--exec-path"]);
    let real_git = Path::new(&real_git).join("git");
    let wrapper = sc.root.join("broken-merge-git");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = --aggressive ]; then\n    echo 'merge broke' >&2\n    exit 1\n  fi\ndone\nexec '{}' \"$@\"\n",
            real_git.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    crate::git::GIT_PROGRAM_OVERRIDE.with(|program| *program.borrow_mut() = Some(wrapper));
    let report = flush(&sc.ctx(true), false);
    crate::git::GIT_PROGRAM_OVERRIDE.with(|program| *program.borrow_mut() = None);
    let report = report.unwrap();
    assert!(report.publish_error.is_some(), "{report:?}");
    assert!(!on_main(&sc, &commit));
    assert_eq!(report.unpushed_refs, 0, "{report:?}");
    let names: Vec<String> = sc
        .remote_refs("refs/instafy/recovery/")
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    assert!(
        names.iter().any(|name| name.contains("-unpublished-")),
        "{names:?}"
    );
    assert!(
        names.iter().any(|name| name.contains("-unsaved-")),
        "{names:?}"
    );
}

/// The shard names one refused path per push; refusing more paths than
/// there are race retries still publishes the rest and reports every one.
#[test]
fn many_paths_the_policy_refuses_never_block_the_rest() {
    let sc = Scenario::new(Options {
        hook: true,
        hook_env: vec![("GIT_DENY_PATHS", "*.zip")],
        ..Options::default()
    });
    for index in 0..6 {
        sc.write(&format!("bundle-{index}.zip"), b"PK fake archive\n");
    }
    sc.write("ok.txt", b"fine\n");
    let report = sc.publish(Selection::AllDirty);
    assert_eq!(report.git_sync_status, SyncStatus::Partial, "{report:?}");
    assert!(!report.retryable, "{report:?}");
    assert_eq!(sc.remote_file("ok.txt").as_deref(), Some("fine\n"));
    for index in 0..6 {
        let path = format!("bundle-{index}.zip");
        assert!(
            report
                .rejected_paths
                .iter()
                .any(|entry| entry.path == path && entry.reason == RejectReason::Policy),
            "{path} not reported: {report:?}"
        );
        assert!(!sc.path_anywhere_on_remote(&path));
        assert!(sc.ws.join(&path).exists());
    }
}

/// A dismissed `unpublished` ref whose commit is still the branch tip: the
/// commit leaves the branch and is never published.
#[test]
fn a_dismissed_unpublished_tip_is_never_published() {
    let sc = Scenario::new(Options::default());
    let (local, reference) = parked_and_pushed(&sc);
    git_in(&sc.remote, &["update-ref", "-d", &reference]);
    refresh(&sc.ctx(true)).unwrap();
    assert!(!on_main(&sc, &local));
    assert!(sc.remote_file("x.rs").is_none());
    assert!(
        sc.disk("x.rs").is_none(),
        "the dismissed file left the checkout"
    );
    assert!(sc.remote_refs("refs/instafy/").is_empty());
    sc.write("y.rs", b"fn y() {}\n");
    sc.publish_paths(&["y.rs"]);
    assert!(sc.remote_file("x.rs").is_none());
    assert!(!on_main(&sc, &local));
}

/// Later commits on top of dismissed ones are published without them.
#[test]
fn later_commits_publish_without_the_dismissed_ones_below_them() {
    let sc = Scenario::new(Options::default());
    let (local, reference) = parked_and_pushed(&sc);
    sc.write("later.rs", b"fn later() {}\n");
    sc.agent_commit(&["later.rs"], "later work");
    git_in(&sc.remote, &["update-ref", "-d", &reference]);
    let report = sc.publish(Selection::None);
    assert_eq!(report.git_sync_status, SyncStatus::Published, "{report:?}");
    assert_eq!(
        sc.remote_file("later.rs").as_deref(),
        Some("fn later() {}\n")
    );
    assert!(sc.remote_file("x.rs").is_none());
    assert!(!on_main(&sc, &local));
    assert!(!sc.anywhere_on_remote("fn x()"));
    assert!(sc
        .remote_log()
        .contains("Ada Agent <ada@example.com> | later work"));
}

/// Later commits that cannot be separated from dismissed ones are set aside
/// with them for a person to decide; neither reaches main.
#[test]
fn later_commits_tangled_with_dismissed_ones_are_set_aside() {
    let sc = Scenario::new(Options::default());
    let (local, reference) = parked_and_pushed(&sc);
    sc.write("x.rs", b"fn x() { later(); }\n");
    let later = sc.agent_commit(&["x.rs"], "later work on x");
    git_in(&sc.remote, &["update-ref", "-d", &reference]);
    sc.publish(Selection::None);
    assert!(!on_main(&sc, &local));
    assert!(!on_main(&sc, &later));
    assert!(sc.remote_file("x.rs").is_none());
    let kept: Vec<(String, String)> = sc
        .remote_refs("refs/instafy/recovery/")
        .into_iter()
        .filter(|(name, _)| name.contains("-unpublished-"))
        .collect();
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(
        sc.recovery_file(&kept[0].0, "x.rs").as_deref(),
        Some("fn x() { later(); }\n")
    );
}

/// A stop after a dismissal never publishes the dismissed work.
#[test]
fn a_stop_never_publishes_dismissed_work() {
    let sc = Scenario::new(Options::default());
    let (local, reference) = parked_and_pushed(&sc);
    git_in(&sc.remote, &["update-ref", "-d", &reference]);
    let report = flush(&sc.ctx(true), false).unwrap();
    assert!(!on_main(&sc, &local), "{report:?}");
    assert!(sc.remote_file("x.rs").is_none());
    assert!(
        sc.remote_refs("refs/instafy/").is_empty(),
        "{:?}",
        sc.remote_refs("refs/instafy/")
    );
}

/// A later runtime on the same checkout runs with a new origin id: the refs
/// an earlier runtime pushed stay where they are, are not taken for
/// dismissed, and are retired under that earlier origin once saved.
#[test]
fn a_new_runtime_on_the_same_checkout_keeps_earlier_recovery_refs() {
    let sc = Scenario::new(Options::default());
    let hook = close_main(&sc);
    sc.write("x.rs", b"fn x() {}\n");
    let refused = sc.publish_paths(&["x.rs"]);
    assert_eq!(refused.git_sync_status, SyncStatus::Unpublished);
    let local = sc.head();
    sc.write("notes.md", b"unsaved\n");
    flush(&sc.ctx(true), false).unwrap();
    let first = format!("refs/instafy/recovery/{}/", sc.config.origin_id);
    assert_eq!(
        sc.remote_refs(&first).len(),
        2,
        "{:?}",
        sc.remote_refs(&first)
    );

    let mut next = sc.config.clone();
    next.origin_id = Uuid::new_v4();
    let ctx = PublishContext {
        config: &next,
        workspace_root: &sc.ws,
        token: None,
        can_write: true,
    };
    let refreshed = refresh(&ctx).unwrap();
    assert_eq!(refreshed.git_sync_status, SyncStatus::Unpublished);
    assert!(
        sc.local_refs(LOCAL_RECOVERY_DISMISSED_ROOT).is_empty(),
        "{:?}",
        sc.local_refs(LOCAL_RECOVERY_DISMISSED_ROOT)
    );
    assert_eq!(sc.head(), local, "the parked commit stays on the branch");
    assert_eq!(sc.disk("x.rs").as_deref(), Some("fn x() {}\n"));
    assert_eq!(sc.remote_refs(&first).len(), 2);
    assert!(sc
        .remote_refs(&format!("refs/instafy/recovery/{}/", next.origin_id))
        .is_empty());

    fs::remove_file(hook).unwrap();
    let saved = refresh(&ctx).unwrap();
    assert_eq!(saved.git_sync_status, SyncStatus::Published, "{saved:?}");
    assert!(on_main(&sc, &local));
    let left = sc.remote_refs(&first);
    assert_eq!(left.len(), 1, "{left:?}");
    assert!(left[0].0.contains("-unsaved-"), "{left:?}");
}

/// A secret the agent committed never reaches a canonical ref through a stop
/// without write access followed by a refresh.
#[test]
fn committed_secrets_never_reach_canonical_after_an_offline_stop() {
    let sc = Scenario::new(Options {
        hook: true,
        ..Options::default()
    });
    sc.write(".env", b"SECRET-ENV=1\n");
    sc.write("src/app.rs", b"fn app() {}\n");
    ig(&sc.ws, &["add", "-f", ".env", "src/app.rs"]);
    ig(&sc.ws, &["commit", "-q", "-m", "agent commits a secret"]);
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nunsaved\n");
    flush(&sc.ctx(false), false).unwrap();
    refresh(&sc.ctx(true)).unwrap();
    assert!(
        !sc.anywhere_on_remote("SECRET-"),
        "a secret reached canonical"
    );
    assert_eq!(
        sc.remote_file("src/app.rs").as_deref(),
        Some("fn app() {}\n")
    );
    assert_eq!(sc.disk(".env").as_deref(), Some("SECRET-ENV=1\n"));
    assert_eq!(sc.remote_refs("refs/instafy/recovery/").len(), 1);
}

/// The same through a save while the remote is unreachable.
#[test]
fn committed_secrets_never_reach_canonical_after_an_offline_save() {
    let sc = Scenario::new(Options {
        hook: true,
        ..Options::default()
    });
    sc.write(".env", b"SECRET-ENV=1\n");
    sc.write("src/b.rs", b"fn b() {}\n");
    ig(&sc.ws, &["add", "-f", ".env", "src/b.rs"]);
    ig(&sc.ws, &["commit", "-q", "-m", "agent commits a secret"]);
    let offline = without_remote(&sc, || sc.publish(Selection::None));
    assert_eq!(
        offline.git_sync_status,
        SyncStatus::Unpublished,
        "{offline:?}"
    );
    refresh(&sc.ctx(true)).unwrap();
    assert!(
        !sc.anywhere_on_remote("SECRET-"),
        "a secret reached canonical"
    );
    assert_eq!(sc.remote_file("src/b.rs").as_deref(), Some("fn b() {}\n"));
    assert!(
        sc.remote_refs("refs/instafy/recovery/").is_empty(),
        "the parked copy is retired once saved"
    );
}

/// A parked copy that an older version built on top of a committed secret
/// is rebuilt on a published parent before it is pushed.
#[test]
fn a_parked_copy_on_top_of_a_secret_is_rebuilt_before_it_is_pushed() {
    let sc = Scenario::new(Options {
        hook: true,
        ..Options::default()
    });
    sc.write(".env", b"SECRET-OLD=1\n");
    ig(&sc.ws, &["add", "-f", ".env"]);
    ig(&sc.ws, &["commit", "-q", "-m", "agent commits a secret"]);
    let head = sc.head();
    sc.write("notes.md", b"keep me\n");
    ig(&sc.ws, &["add", "notes.md"]);
    let tree = ig(&sc.ws, &["write-tree"]);
    ig(&sc.ws, &["reset", "-q", "notes.md"]);
    let git = crate::workspace_git::WorkspaceGit::new(&sc.ws, None);
    crate::recovery::store(
        &git,
        crate::recovery::RecoverySpec {
            kind: crate::recovery::RecoveryKind::Unsaved,
            tree,
            parent: Some(head.clone()),
            source: None,
            date: None,
            paths: vec!["notes.md".to_string()],
            commits: Vec::new(),
            identity: GitIdentity::new("Instafy Origin", "origin@instafy.dev"),
            origin_id: sc.config.origin_id,
        },
    )
    .unwrap()
    .expect("stored");
    // Take the secret commit off the branch so only the parked copy holds it.
    ig(&sc.ws, &["reset", "-q", "--keep", "HEAD~1"]);
    refresh(&sc.ctx(true)).unwrap();
    assert!(
        !sc.anywhere_on_remote("SECRET-"),
        "a secret reached canonical"
    );
    let pushed = sc.remote_refs("refs/instafy/recovery/");
    assert_eq!(pushed.len(), 1, "{pushed:?}");
    assert_eq!(
        sc.recovery_file(&pushed[0].0, "notes.md").as_deref(),
        Some("keep me\n")
    );
    assert_eq!(
        sc.local_refs(crate::recovery::LOCAL_RECOVERY_REJECTED_ROOT)
            .len(),
        1,
        "the original stays only as a local backup"
    );
}

/// The old sync's reset left a local commit's files as if they were unsaved
/// edits: the one-time repair keeps them (and a stop or a Desktop save keeps
/// or publishes them), whether or not the remote had moved.
#[test]
fn the_repair_never_drops_a_local_commit_the_old_reset_abandoned() {
    for (desktop, remote_moved) in [(false, false), (false, true), (true, false), (true, true)] {
        let sc = Scenario::new(Options {
            desktop,
            ..Options::default()
        });
        sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nlocal edit\n");
        sc.write("feature.md", b"new feature\n");
        sc.agent_commit(&["doc.md", "feature.md"], "local work");
        if remote_moved {
            sc.push_other(&[("README.md", Some(b"remote readme\n"))], "remote");
        }
        // The old sync: fetch, then reset --mixed onto the remote tip.
        ig(&sc.ws, &["fetch", "-q", "origin"]);
        ig(&sc.ws, &["reset", "-q", "--mixed", "origin/main"]);
        let case = format!("desktop={desktop} remote_moved={remote_moved}");

        if desktop {
            let report = sc.publish(Selection::AllDirty);
            assert_ne!(
                report.git_sync_status,
                SyncStatus::Unpublished,
                "{case}: {report:?}"
            );
            assert!(
                sc.remote_file("doc.md").unwrap().contains("local edit"),
                "{case}"
            );
            assert_eq!(
                sc.remote_file("feature.md").as_deref(),
                Some("new feature\n"),
                "{case}"
            );
        } else {
            let report = flush(&sc.ctx(true), false).unwrap();
            let unsaved: Vec<_> = report
                .recovery_refs
                .iter()
                .filter(|entry| entry.name.contains("-unsaved-"))
                .collect();
            assert_eq!(unsaved.len(), 1, "{case}: {report:?}");
            assert_eq!(
                sc.recovery_file(&unsaved[0].reference, "feature.md")
                    .as_deref(),
                Some("new feature\n"),
                "{case}"
            );
            assert!(
                sc.recovery_file(&unsaved[0].reference, "doc.md")
                    .unwrap()
                    .contains("local edit"),
                "{case}"
            );
        }
        assert!(sc.disk("doc.md").unwrap().contains("local edit"), "{case}");
        assert_eq!(
            sc.disk("feature.md").as_deref(),
            Some("new feature\n"),
            "{case}"
        );
        if remote_moved {
            assert_eq!(
                sc.disk("README.md").as_deref(),
                Some("remote readme\n"),
                "{case}: the leftover README was not repaired"
            );
            assert_eq!(
                sc.remote_file("README.md").as_deref(),
                Some("remote readme\n"),
                "{case}"
            );
            assert_eq!(
                sc.local_refs(crate::stale_align::BACKUP_REF).len(),
                1,
                "{case}: the replaced copy is kept locally"
            );
        }
        assert!(
            sc.remote_refs(crate::stale_align::BACKUP_REF).is_empty(),
            "{case}"
        );
    }
}

/// A tracked secret the repair would park stays on disk only.
#[test]
fn the_repair_never_parks_a_secret() {
    let sc = Scenario::new(Options {
        seed: vec![(".env", b"A=1\nB=2\nC=3\n".to_vec())],
        ..Options::default()
    });
    sc.push_other(&[(".env", Some(b"A=1\nB=main\nC=3\n"))], "main changes B");
    ig(&sc.ws, &["fetch", "-q", "origin"]);
    ig(&sc.ws, &["reset", "-q", "--mixed", "origin/main"]);
    sc.write(".env", b"A=1\nB=SECRET-XYZ\nC=3\n");
    flush(&sc.ctx(true), false).unwrap();
    assert!(
        !sc.anywhere_on_remote("SECRET-XYZ"),
        "a secret reached canonical"
    );
    assert_eq!(sc.disk(".env").as_deref(), Some("A=1\nB=SECRET-XYZ\nC=3\n"));
}

/// The hook compares a new recovery ref with `main`: a file `main` deleted
/// since the copy's parent (here one over the shard's size cap) is refused
/// although the copy never changed it. The copy takes `main`'s entry and is
/// pushed, instead of being rebuilt under the same name forever.
#[test]
fn a_copy_refused_for_a_path_only_main_changed_is_still_pushed() {
    let sc = Scenario::new(Options {
        seed: vec![("big.bin", vec![b'z'; 300])],
        ..Options::default()
    });
    sc.push_other(&[("big.bin", None)], "main drops the big file");
    install_shard_hook(&sc.remote, &[("GIT_MAX_BLOB_BYTES", "100")]);
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nunsaved\n");
    let report = flush(&sc.ctx(true), false).unwrap();
    assert_eq!(report.unpushed_refs, 0, "{report:?}");
    let pushed = sc.remote_refs("refs/instafy/recovery/");
    assert_eq!(pushed.len(), 1, "{pushed:?}");
    assert!(sc
        .recovery_file(&pushed[0].0, "doc.md")
        .unwrap()
        .contains("unsaved"));
    assert!(sc.recovery_file(&pushed[0].0, "big.bin").is_none());
    let refreshed = refresh(&sc.ctx(true)).unwrap();
    assert_eq!(refreshed.unpushed_refs, 0, "{refreshed:?}");
}

/// For unrelated histories, a conflict copy holds `main` plus the local
/// version of the conflicted paths: it never reads as deleting what only
/// `main` holds.
#[test]
fn unrelated_conflict_copies_never_delete_what_main_holds() {
    let sc = Scenario::new(Options {
        empty: true,
        ..Options::default()
    });
    sc.write("AGENTS.md", b"agents\n");
    sc.write("README.md", b"agent readme\n");
    sc.agent_commit(&["AGENTS.md", "README.md"], "agent bootstrap");
    write(&sc.other, "README.md", b"main readme\n");
    write(&sc.other, "LICENSE", b"license\n");
    git_in(&sc.other, &["add", "-A"]);
    git_in(&sc.other, &["commit", "-q", "-m", "first"]);
    git_in(&sc.other, &["push", "-q", "origin", "main"]);

    let report = sc.publish(Selection::None);
    assert_eq!(
        report.conflicted_paths,
        vec!["README.md".to_string()],
        "{report:?}"
    );
    let reference = report.recovery_ref.clone().expect("conflict ref");
    let deleted = git_in(
        &sc.remote,
        &[
            "diff-tree",
            "-r",
            "--name-only",
            "--diff-filter=D",
            &format!("{reference}^"),
            &reference,
        ],
    );
    assert!(deleted.is_empty(), "{deleted}");
    assert_eq!(
        sc.recovery_file(&reference, "README.md").as_deref(),
        Some("agent readme\n")
    );
    assert_eq!(
        sc.recovery_file(&reference, "LICENSE").as_deref(),
        Some("license\n")
    );
    assert_eq!(sc.remote_file("AGENTS.md").as_deref(), Some("agents\n"));
}

/// The same for parked work of an unrelated history.
#[test]
fn unrelated_parked_copies_never_delete_what_main_holds() {
    let sc = Scenario::new(Options {
        empty: true,
        ..Options::default()
    });
    sc.write("AGENTS.md", b"agents\n");
    sc.agent_commit(&["AGENTS.md"], "agent bootstrap");
    write(&sc.other, "LICENSE", b"license\n");
    git_in(&sc.other, &["add", "-A"]);
    git_in(&sc.other, &["commit", "-q", "-m", "first"]);
    git_in(&sc.other, &["push", "-q", "origin", "main"]);
    let _hook = close_main(&sc);
    let report = sc.publish(Selection::None);
    assert_eq!(
        report.git_sync_status,
        SyncStatus::Unpublished,
        "{report:?}"
    );
    let reference = report.recovery_ref.clone().expect("parked");
    let deleted = git_in(
        &sc.remote,
        &[
            "diff-tree",
            "-r",
            "--name-only",
            "--diff-filter=D",
            &format!("{reference}^"),
            &reference,
        ],
    );
    assert!(deleted.is_empty(), "{deleted}");
    assert_eq!(
        sc.recovery_file(&reference, "AGENTS.md").as_deref(),
        Some("agents\n")
    );
}

/// A Desktop save whose new folder meets a collaborator's file of the same
/// name keeps the user's file in their folder.
#[test]
fn a_desktop_folder_meeting_a_file_keeps_the_users_bytes() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    sc.write("a/b", b"my bytes\n");
    sc.push_other(
        &[("a", Some(b"collaborator file\n"))],
        "collaborator adds a",
    );
    let report = sc.publish_paths(&["a/b"]);
    assert!(
        report.conflicted_paths.contains(&"a/b".to_string()),
        "{report:?}"
    );
    assert_eq!(sc.disk("a/b").as_deref(), Some("my bytes\n"));
    assert_eq!(sc.remote_file("a").as_deref(), Some("collaborator file\n"));
}

/// A push the remote reports as accepted but that did not land (here a
/// hook removes recovery refs right after accepting them) keeps the ref
/// local; it is pushed for real once the remote keeps it.
#[test]
fn a_recovery_push_counts_only_when_the_remote_shows_it() {
    use std::os::unix::fs::PermissionsExt as _;
    let sc = Scenario::new(Options::default());
    let hook = sc.remote.join("hooks").join("post-receive");
    fs::write(
        &hook,
        "#!/bin/sh\nwhile read old new ref; do\n  case \"$ref\" in\n    refs/instafy/recovery/*) git update-ref -d \"$ref\" ;;\n  esac\ndone\nexit 0\n",
    )
    .unwrap();
    fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nleft over\n");
    let report = flush(&sc.ctx(true), false).unwrap();
    assert_eq!(report.unpushed_refs, 1, "{report:?}");
    assert_eq!(sc.local_refs(LOCAL_RECOVERY_ROOT).len(), 1);
    assert!(sc.local_refs(LOCAL_RECOVERY_PUSHED_ROOT).is_empty());

    fs::remove_file(&hook).unwrap();
    let refreshed = refresh(&sc.ctx(true)).unwrap();
    assert_eq!(refreshed.unpushed_refs, 0, "{refreshed:?}");
    assert_eq!(sc.remote_refs("refs/instafy/recovery/").len(), 1);
    assert_eq!(sc.local_refs(LOCAL_RECOVERY_PUSHED_ROOT).len(), 1);
}

/// `/git/sync` with the remote unreachable keeps the work on a local ref
/// and says where (503 not_saved), instead of failing the request.
#[tokio::test(flavor = "multi_thread")]
async fn sync_route_without_the_remote_keeps_the_work_and_says_where() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let (base, server) = serve(&sc).await;
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\noffline\n");
    let away = sc.root.join("remote-away.git");
    fs::rename(&sc.remote, &away).unwrap();
    let response = reqwest::Client::new()
        .post(format!("{base}/git/sync"))
        .json(&serde_json::json!({ "paths": ["doc.md"] }))
        .send()
        .await
        .unwrap();
    fs::rename(&away, &sc.remote).unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["code"], "not_saved", "{body}");
    assert!(
        body["recoveryRef"]
            .as_str()
            .unwrap_or_default()
            .contains("-unpublished-"),
        "{body}"
    );
    assert_eq!(
        sc.disk("doc.md").as_deref(),
        Some("alpha\nbeta\ngamma\ndelta\noffline\n")
    );
    server.abort();
}

/// After a pre-stop flush, a save is refused until a refresh, so the same
/// work never lands on main next to its recovery copy.
#[tokio::test(flavor = "multi_thread")]
async fn saves_after_a_flush_wait_for_the_next_refresh() {
    let sc = Scenario::new(Options::default());
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nturn work\n");
    let flushed = client
        .post(format!("{base}/git/flush"))
        .json(&serde_json::json!({ "turnActive": true }))
        .send()
        .await
        .unwrap();
    assert_eq!(flushed.status(), reqwest::StatusCode::OK);
    let refused = client
        .post(format!("{base}/git/sync"))
        .json(&serde_json::json!({ "paths": ["doc.md"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    let body: serde_json::Value = refused.json().await.unwrap();
    assert_eq!(
        body["code"],
        crate::routes::WORKSPACE_STOPPING_CODE,
        "{body}"
    );
    assert_eq!(body["retryable"], true, "{body}");
    assert_eq!(
        sc.remote_file("doc.md").as_deref(),
        Some("alpha\nbeta\ngamma\ndelta\n")
    );
    let refreshed = client
        .post(format!("{base}/git/sync"))
        .json(&serde_json::json!({ "mode": "refresh" }))
        .send()
        .await
        .unwrap();
    assert_eq!(refreshed.status(), reqwest::StatusCode::OK);
    let saved = client
        .post(format!("{base}/git/sync"))
        .json(&serde_json::json!({ "paths": ["doc.md"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), reqwest::StatusCode::OK);
    assert!(sc.remote_file("doc.md").unwrap().contains("turn work"));
    server.abort();
}

fn apply_archive(path: &str, content: &[u8]) -> String {
    use base64::Engine as _;
    use std::io::Write as _;
    let mut writer = zip::write::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file(path, zip::write::FileOptions::<()>::default())
        .unwrap();
    writer.write_all(content).unwrap();
    let archive = writer.finish().unwrap().into_inner();
    base64::engine::general_purpose::STANDARD.encode(archive)
}

/// A Desktop `/apply` whose `expected` blob id is stale (the agent edited
/// the file since the client read it) is refused with the path, and the
/// agent's edit stays.
#[tokio::test(flavor = "multi_thread")]
async fn apply_route_refuses_a_stale_expected_blob_and_keeps_the_edit() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let read = crate::workspace_git::blob_oid(README.as_bytes());
    let edit = "one\ntwo\nthree\nfour\nfive\nagent edit\n";
    sc.write("README.md", edit.as_bytes());
    let (base, server) = serve(&sc).await;
    let response = reqwest::Client::new()
        .post(format!("{base}/apply-json"))
        .json(&serde_json::json!({
            "manifest": {
                "projectId": sc.config.project_id,
                "files": [{ "path": "README.md", "size": 12 }],
                "deletes": [],
                "expected": { "README.md": read },
            },
            "archiveBase64": apply_archive("README.md", b"from editor\n"),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::CONFLICT);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["code"], "head_moved", "{body}");
    assert_eq!(body["paths"], serde_json::json!(["README.md"]), "{body}");
    assert_eq!(sc.disk("README.md").as_deref(), Some(edit));

    // With the id the agent's edit has, the same apply goes through.
    let current = crate::workspace_git::blob_oid(edit.as_bytes());
    let response = reqwest::Client::new()
        .post(format!("{base}/apply-json"))
        .json(&serde_json::json!({
            "manifest": {
                "projectId": sc.config.project_id,
                "files": [{ "path": "README.md", "size": 12 }],
                "deletes": [],
                "expected": { "README.md": current },
            },
            "archiveBase64": apply_archive("README.md", b"from editor\n"),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(sc.disk("README.md").as_deref(), Some("from editor\n"));
    server.abort();
}

/// The gateway's conditional writes come later: a multi-tenant origin
/// ignores `expected`.
#[tokio::test(flavor = "multi_thread")]
async fn multi_tenant_apply_ignores_expected() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().canonicalize().unwrap();
    let project_id = Uuid::new_v4();
    let workspace = root.join(project_id.to_string());
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join("README.md"), b"agent edit\n").unwrap();
    let config = ServerConfig {
        project_id,
        origin_id: Uuid::new_v4(),
        workspace_root: root.clone(),
        git_remote_url: None,
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
        multi_tenant: true,
        hosted_checkout: false,
    };
    let (base, server) = serve_config(config, root.clone()).await;
    let stale = crate::workspace_git::blob_oid(b"what the client read\n");
    let response = reqwest::Client::new()
        .post(format!("{base}/apply-json"))
        .json(&serde_json::json!({
            "manifest": {
                "projectId": project_id,
                "files": [{ "path": "README.md", "size": 12 }],
                "deletes": [],
                "expected": { "README.md": stale },
            },
            "archiveBase64": apply_archive("README.md", b"from editor\n"),
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        fs::read_to_string(workspace.join("README.md")).unwrap(),
        "from editor\n"
    );
    server.abort();
}

/// Restore and dismiss change canonical for everyone, so they take the
/// workspace lease holder's `fs.write` token: an `fs.read` token, or an
/// `fs.write` token of a lease that is no longer the live one, is refused
/// before anything is minted or removed. Listing takes `fs.read`.
#[tokio::test(flavor = "multi_thread")]
async fn recovery_writes_need_the_live_lease_holders_write_token() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let reference = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    let commit = push_to_ref(
        &sc,
        &[("notes.md", Some(b"notes\n"))],
        &[],
        "Unsaved edits",
        &reference,
    );
    let lease_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let controller =
        StubController::start(sc.config.project_id, lease_id, user_id, runtime_id).await;
    let mut config = sc.config.clone();
    config.skip_auth = false;
    config.controller_base_url = Url::parse(&controller.base).unwrap();
    config.jwks_url = Url::parse(&format!("{}/.well-known/jwks.json", controller.base)).unwrap();
    config.controller_internal_token = Some(MACHINE_TOKEN.to_string());
    let reader = controller.origin_token_with(
        &config,
        lease_id,
        user_id,
        runtime_id,
        serde_json::json!({ "scopes": ["fs.read"] }),
    );
    let stale_writer = controller.origin_token(&config, Uuid::new_v4(), user_id, runtime_id);
    let writer = controller.origin_token(&config, lease_id, user_id, runtime_id);
    let (base, server) = serve_config(config, sc.ws.clone()).await;
    let client = reqwest::Client::new();
    let body = serde_json::json!({ "ref": reference, "rev": commit });

    for token in [&reader, &stale_writer] {
        for route in ["restore", "dismiss"] {
            let response = client
                .post(format!("{base}/git/recovery/{route}"))
                .bearer_auth(token)
                .json(&body)
                .send()
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                reqwest::StatusCode::UNAUTHORIZED,
                "{route}"
            );
        }
    }
    assert_eq!(sc.remote_refs(&reference).len(), 1);
    assert!(sc.remote_file("notes.md").is_none());
    {
        let calls = controller.calls.lock().unwrap();
        assert!(
            calls
                .git_tokens
                .iter()
                .all(|(bearer, _)| bearer != &reader && bearer != &stale_writer),
            "a refused caller's token was exchanged"
        );
    }

    // Listing takes fs.read; the live lease holder may remove the work.
    let response = client
        .get(format!("{base}/git/recovery"))
        .bearer_auth(&reader)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let response = client
        .post(format!("{base}/git/recovery/dismiss"))
        .bearer_auth(&writer)
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert!(sc.remote_refs(&reference).is_empty());
    server.abort();
    controller.server.abort();
}

/// The pseudonym the controller issues for one person in one space.
const PSEUDONYM: &str = "p1-3ujoyn5txgxsverj7psd@users.noreply.instafy.dev";

/// A Desktop "save everything" or revert with a person's token is authored
/// by the per-space pseudonym and display name from the token, committed by
/// the origin; a job's token, or one from a controller without pseudonyms,
/// commits as the origin. No user id ever reaches permanent history.
#[tokio::test(flavor = "multi_thread")]
async fn user_saves_never_write_a_user_id_into_history() {
    let sc = Scenario::new(Options {
        desktop: true,
        ..Options::default()
    });
    let lease_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let controller =
        StubController::start(sc.config.project_id, lease_id, user_id, runtime_id).await;
    let mut config = sc.config.clone();
    config.skip_auth = false;
    config.controller_base_url = Url::parse(&controller.base).unwrap();
    config.jwks_url = Url::parse(&format!("{}/.well-known/jwks.json", controller.base)).unwrap();
    config.controller_internal_token = Some(MACHINE_TOKEN.to_string());
    let person = controller.origin_token_with(
        &config,
        lease_id,
        user_id,
        runtime_id,
        serde_json::json!({ "author_name": "Ada Lovelace", "author_email": PSEUDONYM }),
    );
    let job = controller.origin_token_with(
        &config,
        lease_id,
        user_id,
        runtime_id,
        serde_json::json!({
            "author_name": "Ada Lovelace",
            "author_email": PSEUDONYM,
            "run_id": Uuid::new_v4().to_string(),
        }),
    );
    let older_controller = controller.origin_token(&config, lease_id, user_id, runtime_id);
    let (base, server) = serve_config(config, sc.ws.clone()).await;
    let client = reqwest::Client::new();
    let head = |format: &str| {
        git_in(
            &sc.remote,
            &["log", "-1", &format!("--format={format}"), "main"],
        )
    };

    // A person's save: the pseudonym authors it, the origin commits it.
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nfrom the user\n");
    let response = client
        .post(format!("{base}/git/sync"))
        .bearer_auth(&person)
        .json(&serde_json::json!({ "message": "Save version" }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert!(sc.remote_file("doc.md").unwrap().contains("from the user"));
    let saved = head("%H");
    assert_eq!(
        head("%an <%ae> | %cn <%ce> | %s"),
        format!("Ada Lovelace <{PSEUDONYM}> | Instafy Origin <origin@instafy.dev> | Save version")
    );

    // A person's revert is theirs too.
    let response = client
        .post(format!("{base}/git/revert-commit"))
        .bearer_auth(&person)
        .json(&serde_json::json!({ "commit": saved }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        head("%an <%ae> | %cn <%ce>"),
        format!("Ada Lovelace <{PSEUDONYM}> | Instafy Origin <origin@instafy.dev>")
    );

    // A job's save and a save with an older controller's token: the origin.
    for (token, line) in [
        (&job, "from a job"),
        (&older_controller, "from an older token"),
    ] {
        sc.write("doc.md", format!("alpha\n{line}\n").as_bytes());
        let response = client
            .post(format!("{base}/git/sync"))
            .bearer_auth(token)
            .json(&serde_json::json!({ "message": "Save version" }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), reqwest::StatusCode::OK);
        assert_eq!(
            head("%an <%ae> | %cn <%ce> | %s"),
            "Instafy Origin <origin@instafy.dev> | Instafy Origin <origin@instafy.dev> | Save version"
        );
    }

    // A person's restore of unsaved work is theirs too.
    let reference = recovery_ref_name(&sc, "20261005T120000Z-unsaved-0123456789ab");
    push_to_ref(
        &sc,
        &[("notes.md", Some(b"notes\n"))],
        &[],
        "edits",
        &reference,
    );
    let response = client
        .post(format!("{base}/git/recovery/restore"))
        .bearer_auth(&person)
        .json(&serde_json::json!({ "ref": reference }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    assert_eq!(
        head("%an <%ae> | %cn <%ce> | %s"),
        format!(
            "Ada Lovelace <{PSEUDONYM}> | Instafy Origin <origin@instafy.dev> | Restore unsaved work"
        )
    );

    let log = git_in(
        &sc.remote,
        &["log", "--format=%an <%ae> | %cn <%ce> | %B", "main"],
    );
    assert!(!log.contains(&user_id.to_string()), "{log}");
    server.abort();
    controller.server.abort();
}

/// The provider's checkout eviction reads the marker a clean shutdown flush
/// writes; both name the same file.
#[test]
fn the_clean_stop_marker_is_the_one_eviction_reads() {
    let provider = include_str!("../../runtime-provider-core/src/allocator/checkout_eviction.rs");
    assert!(
        provider.contains(&format!(
            "CLEAN_STOP_MARKER: &str = \"{}\";",
            crate::server::CLEAN_STOP_MARKER
        )),
        "the provider's CLEAN_STOP_MARKER differs from the origin's"
    );
}

/// The conflict copy is stored before the merge that keeps `main`'s version
/// is pushed, so a push never lands without it (a crash right after the
/// push keeps it on a local ref for the next push).
#[test]
fn the_conflict_copy_exists_before_the_merge_is_pushed() {
    let sc = Scenario::new(Options::default());
    sc.write("README.md", b"one\nTWO BY AGENT\nthree\nfour\nfive\n");
    sc.push_other(
        &[("README.md", Some(b"one\ntwo by user\nthree\nfour\nfive\n"))],
        "user",
    );
    let ws = sc.ws.clone();
    let seen = std::rc::Rc::new(std::cell::RefCell::new(None::<bool>));
    let seen_in_hook = seen.clone();
    let _guard = with_push_hook(move |specs| {
        if specs.iter().any(|spec| spec.ends_with(":refs/heads/main")) {
            let refs = ig(
                &ws,
                &[
                    "for-each-ref",
                    "--format=%(refname)",
                    "refs/instafy/local-recovery/",
                ],
            );
            *seen_in_hook.borrow_mut() = Some(refs.contains("-conflict-"));
        }
        PushHookAction::Proceed
    });
    let report = sc.publish_paths(&["README.md"]);
    assert_eq!(*seen.borrow(), Some(true), "{report:?}");
    assert!(report
        .recovery_ref
        .as_deref()
        .is_some_and(|reference| reference.contains("-conflict-")));
    assert_eq!(report.unpushed_refs, 0);
}

/// Two dismissed `unpublished` refs from the same chain: the later one's
/// commits include the earlier one's. Neither ref's work reaches main, in
/// whatever order the markers are found.
#[test]
fn two_dismissals_on_one_chain_publish_neither() {
    let sc = Scenario::new(Options::default());
    let main_before = sc.main();
    let hook = close_main(&sc);
    sc.write("x.rs", b"fn x() {}\n");
    let first = sc.publish_paths(&["x.rs"]);
    assert_eq!(first.git_sync_status, SyncStatus::Unpublished, "{first:?}");
    let first_ref = first.recovery_ref.clone().expect("parked");
    sc.write("later.rs", b"fn later() {}\n");
    let second = sc.publish_paths(&["later.rs"]);
    assert_eq!(
        second.git_sync_status,
        SyncStatus::Unpublished,
        "{second:?}"
    );
    let second_ref = second.recovery_ref.clone().expect("parked");
    assert_ne!(first_ref, second_ref);
    for reference in [&first_ref, &second_ref] {
        assert!(
            reference.starts_with("refs/instafy/recovery/"),
            "{reference}"
        );
    }
    assert!(
        sc.recovery_file(&second_ref, "x.rs").is_some(),
        "the later copy carries the earlier work too"
    );
    fs::remove_file(hook).unwrap();

    git_in(&sc.remote, &["update-ref", "-d", &first_ref]);
    git_in(&sc.remote, &["update-ref", "-d", &second_ref]);
    let report = refresh(&sc.ctx(true)).unwrap();
    assert_eq!(sc.main(), main_before, "{report:?}");
    assert!(sc.remote_file("x.rs").is_none());
    assert!(sc.remote_file("later.rs").is_none());
    assert!(!sc.anywhere_on_remote("fn later()"));
    assert!(sc.disk("later.rs").is_none());
    assert!(sc.disk("x.rs").is_none());
    assert!(sc.local_refs(LOCAL_RECOVERY_PUSHED_ROOT).is_empty());
    assert_eq!(sc.local_refs(LOCAL_RECOVERY_DISMISSED_ROOT).len(), 2);

    // A later save publishes only itself.
    sc.write("y.rs", b"fn y() {}\n");
    let saved = sc.publish_paths(&["y.rs"]);
    assert_eq!(saved.git_sync_status, SyncStatus::Published, "{saved:?}");
    assert!(sc.remote_file("later.rs").is_none());
    assert!(sc.remote_file("x.rs").is_none());
}

/// A git whose branch moves fail, so a dismissal cannot be applied.
fn with_branch_moves_failing<T>(sc: &Scenario, body: impl FnOnce() -> T) -> T {
    use std::os::unix::fs::PermissionsExt as _;
    let real_git = git_in(&sc.root, &["--exec-path"]);
    let real_git = Path::new(&real_git).join("git");
    let wrapper = sc.root.join("stuck-branch-git");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nupdate=0\nhead=0\nfor arg in \"$@\"; do\n  case \"$arg\" in\n    reset) echo 'reset broke' >&2; exit 1 ;;\n    update-ref) update=1 ;;\n    HEAD) head=1 ;;\n  esac\ndone\nif [ $update = 1 ] && [ $head = 1 ]; then echo 'branch move broke' >&2; exit 1; fi\nexec '{}' \"$@\"\n",
            real_git.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    crate::git::GIT_PROGRAM_OVERRIDE.with(|program| *program.borrow_mut() = Some(wrapper));
    let result = body();
    crate::git::GIT_PROGRAM_OVERRIDE.with(|program| *program.borrow_mut() = None);
    result
}

/// A dismissal that cannot be applied is not lost: its marker stays, the
/// stop publishes nothing, and the next publish applies it.
#[test]
fn a_dismissal_that_cannot_be_applied_is_retried_and_never_published() {
    let sc = Scenario::new(Options::default());
    let (local, reference) = parked_and_pushed(&sc);
    git_in(&sc.remote, &["update-ref", "-d", &reference]);
    let main_before = sc.main();

    let report = with_branch_moves_failing(&sc, || flush(&sc.ctx(true), false)).unwrap();
    assert!(report.publish.is_none(), "{report:?}");
    assert_eq!(sc.main(), main_before);
    assert!(!on_main(&sc, &local));
    assert_eq!(
        sc.local_refs(LOCAL_RECOVERY_PUSHED_ROOT).len(),
        1,
        "the marker waits for the dismissal to be applied"
    );
    assert!(sc.local_refs(LOCAL_RECOVERY_DISMISSED_ROOT).is_empty());

    // A save hits the same failure: it fails instead of sending the work.
    sc.write("y.rs", b"fn y() {}\n");
    let failed = with_branch_moves_failing(&sc, || {
        publish(
            &sc.ctx(true),
            PublishRequest {
                selection: Selection::Paths(vec!["y.rs".to_string()]),
                message: "instafy: agent sync".to_string(),
                author: None,
                budget: Duration::from_secs(30),
            },
        )
    });
    match failed {
        Err(crate::error::OriginError::WithReport { status, code, .. }) => {
            assert_eq!(status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(code, crate::publish::DISMISSAL_NOT_APPLIED_CODE);
        }
        other => panic!("expected the dismissal's own error, got {other:?}"),
    }
    assert!(!on_main(&sc, &local));

    let refreshed = refresh(&sc.ctx(true)).unwrap();
    assert!(!on_main(&sc, &local), "{refreshed:?}");
    assert!(sc.remote_file("x.rs").is_none());
    assert!(sc.local_refs(LOCAL_RECOVERY_PUSHED_ROOT).is_empty());
    assert_eq!(sc.local_refs(LOCAL_RECOVERY_DISMISSED_ROOT).len(), 1);
}

/// A remote that accepts the connection and never answers: the stop's
/// fetch and push are stopped at its budget, and everything stays parked
/// locally for the next publish.
#[test]
fn a_hanging_remote_never_holds_a_flush_past_its_budget() {
    let sc = Scenario::new(Options::default());
    sc.write("done.rs", b"fn done() {}\n");
    sc.agent_commit(&["done.rs"], "finished work");
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nunsaved\n");
    // The kernel completes the handshake; nothing ever answers.
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/remote.git", silent.local_addr().unwrap());
    let real = ig(&sc.ws, &["remote", "get-url", "origin"]);
    ig(&sc.ws, &["remote", "set-url", "origin", &url]);

    let started = Instant::now();
    let report =
        crate::publish::flush_within(&sc.ctx(true), false, Duration::from_secs(2)).unwrap();
    let elapsed = started.elapsed();
    ig(&sc.ws, &["remote", "set-url", "origin", &real]);
    drop(silent);

    assert!(elapsed < Duration::from_secs(5), "took {elapsed:?}");
    assert_eq!(report.unpushed_refs, 2, "{report:?}");
    assert!(report.publish.is_none(), "{report:?}");
    let refreshed = refresh(&sc.ctx(true)).unwrap();
    assert_eq!(refreshed.unpushed_refs, 0, "{refreshed:?}");
    assert_eq!(sc.remote_file("done.rs").as_deref(), Some("fn done() {}\n"));
}

/// The controller's save-only permission (no workspace lease) opens
/// `/git/flush` (and its resume) and nothing else, and is the credential the
/// origin exchanges for git.write.
#[tokio::test(flavor = "multi_thread")]
async fn a_save_only_permission_opens_the_flush_and_nothing_else() {
    let sc = Scenario::new(Options::default());
    let owner = Uuid::new_v4();
    let runtime_id = Uuid::new_v4();
    let runtime_lease_id = Uuid::new_v4();
    // The stand-in's workspace lease belongs to someone else, as when a
    // collaborator holds it on another runtime.
    let controller = StubController::start(
        sc.config.project_id,
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
    )
    .await;
    let mut config = sc.config.clone();
    config.skip_auth = false;
    config.controller_base_url = Url::parse(&controller.base).unwrap();
    config.jwks_url = Url::parse(&format!("{}/.well-known/jwks.json", controller.base)).unwrap();
    config.controller_internal_token = Some(MACHINE_TOKEN.to_string());
    let grant = controller.save_grant_token(&config, owner, runtime_id, runtime_lease_id);
    let mut other_origin = config.clone();
    other_origin.origin_id = Uuid::new_v4();
    let foreign = controller.save_grant_token(&other_origin, owner, runtime_id, runtime_lease_id);
    let (base, server) = serve_config(config, sc.ws.clone()).await;
    let client = reqwest::Client::new();
    sc.write("notes.md", b"left behind\n");

    for (method, path, body) in [
        (
            "POST",
            "/git/sync",
            serde_json::json!({ "paths": ["notes.md"] }),
        ),
        (
            "POST",
            "/git/revert",
            serde_json::json!({ "paths": ["notes.md"] }),
        ),
        ("POST", "/apply-json", serde_json::json!({})),
        ("GET", "/entries", serde_json::Value::Null),
        ("GET", "/git/status", serde_json::Value::Null),
    ] {
        let request = match method {
            "GET" => client.get(format!("{base}{path}")),
            _ => client.post(format!("{base}{path}")).json(&body),
        };
        let response = request.bearer_auth(&grant).send().await.unwrap();
        assert_eq!(
            response.status(),
            reqwest::StatusCode::UNAUTHORIZED,
            "{method} {path} accepted the save-only permission"
        );
    }
    let response = client
        .post(format!("{base}/git/flush"))
        .bearer_auth(&foreign)
        .json(&serde_json::json!({ "turnActive": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED,
        "a permission for another origin"
    );
    assert!(sc.local_refs("refs/instafy/").is_empty());

    let response = client
        .post(format!("{base}/git/flush"))
        .bearer_auth(&grant)
        .json(&serde_json::json!({ "turnActive": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = response.json().await.unwrap();
    assert_eq!(body["unpushedRefs"], 0, "{body}");
    let parked = body["recoveryRefs"][0]["reference"].as_str().unwrap();
    assert_eq!(
        sc.recovery_file(parked, "notes.md").as_deref(),
        Some("left behind\n")
    );
    assert!(sc.remote_file("notes.md").is_none());
    {
        let calls = controller.calls.lock().unwrap();
        assert!(
            !calls.lease_checks.contains(&grant),
            "the permission needs no workspace lease check"
        );
        let writes: Vec<&String> = calls
            .git_tokens
            .iter()
            .filter(|(_, scopes)| scopes.iter().any(|scope| scope == "git.write"))
            .map(|(bearer, _)| bearer)
            .collect();
        assert_eq!(writes, vec![&grant]);
    }
    let resumed = client
        .post(format!("{base}/git/flush/resume"))
        .bearer_auth(&grant)
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(resumed.status(), reqwest::StatusCode::OK);
    let resumed: serde_json::Value = resumed.json().await.unwrap();
    assert_eq!(resumed["resumed"], true, "{resumed}");
    server.abort();
    controller.server.abort();
}

/// Whether `commit` is an ancestor of any recovery ref on the remote.
fn under_a_remote_recovery_ref(sc: &Scenario, commit: &str) -> bool {
    sc.remote_refs("refs/instafy/").iter().any(|(_, rev)| {
        git_output(
            &sc.remote,
            &["merge-base", "--is-ancestor", commit, rev],
            None,
        )
        .status
        .success()
    })
}

/// A stop that applies a dismissal also parks the unsaved edits it found.
/// The copy parked before the dismissal was seen sits on the dismissed
/// commit; it is never pushed as it is. Whatever reaches canonical holds
/// the edits without the dismissed files or commits, with one dismissal or
/// two on one chain under a later commit.
#[test]
fn a_stop_that_applies_a_dismissal_pushes_no_copy_of_it() {
    for dismissals in [1, 2] {
        let sc = Scenario::new(Options::default());
        let hook = close_main(&sc);
        sc.write("x.rs", b"fn x() {}\n");
        let first = sc.publish_paths(&["x.rs"]);
        let mut dismissed = vec![(sc.head(), first.recovery_ref.clone().expect("parked"))];
        if dismissals == 2 {
            sc.write("later.rs", b"fn later() {}\n");
            let second = sc.publish_paths(&["later.rs"]);
            dismissed.push((sc.head(), second.recovery_ref.clone().expect("parked")));
        }
        fs::remove_file(hook).unwrap();
        if dismissals == 2 {
            sc.write("z.rs", b"fn z() {}\n");
            sc.agent_commit(&["z.rs"], "work after the dismissed commits");
        }
        sc.write("dirty.md", b"unsaved edit\n");
        for (_, reference) in &dismissed {
            git_in(&sc.remote, &["update-ref", "-d", reference]);
        }

        let report = flush(&sc.ctx(true), false).unwrap();
        assert_eq!(report.unpushed_refs, 0, "{dismissals}: {report:?}");
        assert!(!sc.path_anywhere_on_remote("x.rs"), "{dismissals}");
        assert!(!sc.path_anywhere_on_remote("later.rs"), "{dismissals}");
        for (commit, _) in &dismissed {
            assert!(!on_main(&sc, commit), "{dismissals}");
            assert!(
                !under_a_remote_recovery_ref(&sc, commit),
                "{dismissals}: a pushed recovery ref builds on a dismissed commit"
            );
        }
        let unsaved: Vec<(String, String)> = sc
            .remote_refs("refs/instafy/recovery/")
            .into_iter()
            .filter(|(name, _)| name.contains("-unsaved-"))
            .collect();
        assert_eq!(unsaved.len(), 1, "{dismissals}: {unsaved:?}");
        assert_eq!(
            sc.recovery_file(&unsaved[0].0, "dirty.md").as_deref(),
            Some("unsaved edit\n"),
            "{dismissals}"
        );
        if dismissals == 2 {
            assert_eq!(sc.remote_file("z.rs").as_deref(), Some("fn z() {}\n"));
        }
        // The report names no dismissed ref as kept.
        for (_, reference) in &dismissed {
            let name = reference.rsplit('/').next().unwrap();
            assert!(
                report.recovery_refs.iter().all(|entry| entry.name != name),
                "{dismissals}: {report:?}"
            );
        }
        assert_eq!(sc.disk("dirty.md").as_deref(), Some("unsaved edit\n"));
    }
}

/// Copies parked before a dismissal is applied (a stop whose dismissal
/// cannot be applied, or a stop without write access that never saw it)
/// carry the dismissed commit under a later one. They are never pushed as
/// they are: what is pushed is the later work without the dismissed file,
/// and once the later commit is saved nothing of it is left on a recovery
/// ref.
#[test]
fn copies_parked_before_a_dismissal_never_push_the_dismissed_work() {
    for case in ["dismissal_fails_in_the_stop", "stop_without_write_access"] {
        let sc = Scenario::new(Options::default());
        let (local, reference) = parked_and_pushed(&sc);
        sc.write("later.rs", b"fn later() {}\n");
        let later = sc.agent_commit(&["later.rs"], "later work");
        sc.write("dirty.md", b"unsaved edit\n");
        git_in(&sc.remote, &["update-ref", "-d", &reference]);

        if case == "dismissal_fails_in_the_stop" {
            let report = with_branch_moves_failing(&sc, || flush(&sc.ctx(true), false)).unwrap();
            assert!(report.publish.is_none(), "{case}: {report:?}");
            assert_eq!(report.unpushed_refs, 0, "{case}: {report:?}");
            assert!(!sc.path_anywhere_on_remote("x.rs"), "{case}");
            assert!(!under_a_remote_recovery_ref(&sc, &local), "{case}");
            let kept: Vec<(String, String)> = sc.remote_refs("refs/instafy/recovery/");
            assert!(
                kept.iter()
                    .any(|(name, _)| sc.recovery_file(name, "later.rs").as_deref()
                        == Some("fn later() {}\n")),
                "{case}: the later work is kept: {kept:?}"
            );
            assert!(
                kept.iter()
                    .any(|(name, _)| sc.recovery_file(name, "dirty.md").as_deref()
                        == Some("unsaved edit\n")),
                "{case}: the unsaved edit is kept: {kept:?}"
            );
        } else {
            let report = flush(&sc.ctx(false), false).unwrap();
            assert!(report.unpushed_refs >= 1, "{case}: {report:?}");
            assert!(sc.remote_refs("refs/instafy/").is_empty(), "{case}");
        }

        // The next start applies the dismissal and saves the later commit.
        let refreshed = refresh(&sc.ctx(true)).unwrap();
        assert_eq!(refreshed.unpushed_refs, 0, "{case}: {refreshed:?}");
        assert_eq!(
            sc.remote_file("later.rs").as_deref(),
            Some("fn later() {}\n"),
            "{case}"
        );
        assert!(sc.remote_file("x.rs").is_none(), "{case}");
        assert!(!on_main(&sc, &local), "{case}");
        assert!(!on_main(&sc, &later), "{case}: replayed, not the original");
        assert!(!sc.path_anywhere_on_remote("x.rs"), "{case}");
        assert!(!under_a_remote_recovery_ref(&sc, &local), "{case}");
        let left: Vec<(String, String)> = sc
            .remote_refs("refs/instafy/recovery/")
            .into_iter()
            .filter(|(name, _)| {
                sc.recovery_file(name, "later.rs").is_some() && !name.contains("-unsaved-")
            })
            .collect();
        assert!(
            left.is_empty(),
            "{case}: saved later work stays on a recovery ref: {left:?}"
        );
        assert_eq!(sc.disk("dirty.md").as_deref(), Some("unsaved edit\n"));
    }
}

/// A stop that did not happen (the controller skipped it after the flush)
/// lifts the save fence with the flush's own credential; saves go through
/// again without waiting for the next turn's refresh.
#[tokio::test(flavor = "multi_thread")]
async fn a_resume_after_a_skipped_stop_lets_saves_through() {
    let sc = Scenario::new(Options::default());
    let (base, server) = serve(&sc).await;
    let client = reqwest::Client::new();
    sc.write("doc.md", b"alpha\nbeta\ngamma\ndelta\nkept\n");
    let flushed = client
        .post(format!("{base}/git/flush"))
        .json(&serde_json::json!({ "turnActive": false }))
        .send()
        .await
        .unwrap();
    assert_eq!(flushed.status(), reqwest::StatusCode::OK);
    let refused = client
        .post(format!("{base}/git/sync"))
        .json(&serde_json::json!({ "paths": ["doc.md"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status(), reqwest::StatusCode::SERVICE_UNAVAILABLE);
    let resumed = client
        .post(format!("{base}/git/flush/resume"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap();
    assert_eq!(resumed.status(), reqwest::StatusCode::OK);
    let body: serde_json::Value = resumed.json().await.unwrap();
    assert_eq!(body["resumed"], true, "{body}");
    let saved = client
        .post(format!("{base}/git/sync"))
        .json(&serde_json::json!({ "paths": ["doc.md"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(saved.status(), reqwest::StatusCode::OK);
    assert!(sc.remote_file("doc.md").unwrap().contains("kept"));
    // A second resume finds no fence.
    let again: serde_json::Value = client
        .post(format!("{base}/git/flush/resume"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(again["resumed"], false, "{again}");
    server.abort();
}

/// A stop's network call that runs out of time gets SIGTERM first, so git
/// can remove the lock files it holds before it exits.
#[test]
fn a_network_call_out_of_time_is_asked_to_stop_first() {
    use std::os::unix::fs::PermissionsExt as _;
    let sc = Scenario::new(Options::default());
    sc.write("done.rs", b"fn done() {}\n");
    sc.agent_commit(&["done.rs"], "finished work");
    let real_git = git_in(&sc.root, &["--exec-path"]);
    let real_git = Path::new(&real_git).join("git");
    let marker = sc.root.join("asked-to-stop");
    let wrapper = sc.root.join("slow-fetch-git");
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = fetch ]; then\n    sleep 30 &\n    pid=$!\n    trap 'touch \"{}\"; kill $pid; exit 143' TERM\n    wait $pid\n    exit 1\n  fi\ndone\nexec '{}' \"$@\"\n",
            marker.display(),
            real_git.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o755)).unwrap();
    crate::git::GIT_PROGRAM_OVERRIDE.with(|program| *program.borrow_mut() = Some(wrapper));
    let started = Instant::now();
    let report = crate::publish::flush_within(&sc.ctx(true), false, Duration::from_secs(3));
    crate::git::GIT_PROGRAM_OVERRIDE.with(|program| *program.borrow_mut() = None);
    let report = report.unwrap();
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    assert!(marker.exists(), "the fetch was killed without SIGTERM");
    assert_eq!(report.unpushed_refs, 1, "{report:?}");
}
