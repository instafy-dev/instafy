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
use crate::test_support::{git_in, git_output, ig};
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

fn install_shard_hook(remote: &Path, env: &[(&str, &str)]) {
    use std::os::unix::fs::PermissionsExt as _;
    let hooks = remote.join("hooks");
    fs::create_dir_all(&hooks).unwrap();
    let real = hooks.join("update.shard");
    fs::write(
        &real,
        git_service::policy::render_update_hook("main").unwrap(),
    )
    .unwrap();
    fs::set_permissions(&real, fs::Permissions::from_mode(0o755)).unwrap();
    let mut wrapper = String::from("#!/bin/sh\n");
    for (key, value) in env {
        wrapper.push_str(&format!("export {key}='{value}'\n"));
    }
    wrapper.push_str(&format!("exec '{}' \"$@\"\n", real.display()));
    let update = hooks.join("update");
    fs::write(&update, wrapper).unwrap();
    fs::set_permissions(&update, fs::Permissions::from_mode(0o755)).unwrap();
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

/// 14: on Desktop, everything saved with a user token is authored by that
/// user, and a stop keeps the folder as it is.
#[tokio::test]
async fn n14_desktop_saves_are_authored_by_the_user_and_never_flushed() {
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

/// The production code of a module: its test module and comments removed.
fn production_source(source: &str) -> String {
    let source = match source.find("#[cfg(test)]\nmod tests") {
        Some(index) => &source[..index],
        None => source,
    };
    source
        .lines()
        .filter(|line| !line.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

const PUBLISH_MODULES: &[(&str, &str)] = &[
    ("publish.rs", include_str!("publish.rs")),
    ("push.rs", include_str!("push.rs")),
    ("recovery.rs", include_str!("recovery.rs")),
    ("stale_align.rs", include_str!("stale_align.rs")),
    ("tree_merge.rs", include_str!("tree_merge.rs")),
    ("publish_policy.rs", include_str!("publish_policy.rs")),
    ("workspace_git.rs", include_str!("workspace_git.rs")),
];

/// Every git process in the publish modules is built by
/// `server_git_command` (through `WorkspaceGit`), never spawned directly.
#[test]
fn publish_modules_spawn_git_only_through_server_git_command() {
    for (name, source) in PUBLISH_MODULES {
        let code = production_source(source);
        for forbidden in [
            "Command::new",
            "process::Command",
            "std::process::Command",
            "Command::from",
        ] {
            assert!(
                !code.contains(forbidden),
                "{name} builds a process with {forbidden}"
            );
        }
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
        let code = production_source(source);
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
            assert!(!code.contains(forbidden), "{name} uses {forbidden}");
        }
        // The only lease form is create-only (`<ref>:` with no value) or
        // pinned to an exact listed id when deleting a recovery ref.
        for (index, _) in code.match_indices("--force-with-lease=") {
            let tail = &code[index..code.len().min(index + 60)];
            assert!(
                tail.starts_with("--force-with-lease={reference}:\"")
                    || tail.starts_with("--force-with-lease={destination}:{rev}\""),
                "{name}: unexpected lease form {tail}"
            );
        }
    }
}

// ---------------------------------------------------------------------------
// The HTTP routes on a single-tenant origin.
// ---------------------------------------------------------------------------

async fn serve(sc: &Scenario) -> (String, tokio::task::JoinHandle<()>) {
    let client = reqwest::Client::new();
    let config = std::sync::Arc::new(sc.config.clone());
    let validator = crate::auth::TokenValidator::new(client.clone(), config.jwks_url.clone());
    let state = crate::routes::AppState::new(config, validator, client, sc.ws.clone(), None)
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
