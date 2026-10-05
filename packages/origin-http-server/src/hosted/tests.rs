//! Gateway tests against real git: a bare canonical repository per space
//! (reached through a `file://` base URL), the gateway's own mirror cache,
//! and a plain clone standing in for the runtimes that push to canonical.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use uuid::Uuid;

use super::cache::{
    plan_eviction, plan_space_eviction, Freshness, MirrorCache, MirrorStat, EVICT_IDLE_AFTER,
};
use crate::config::ServerConfig;
use crate::test_support::git_in;

/// A space whose canonical repository is a bare repository on disk.
pub(super) struct HostedScenario {
    _dir: tempfile::TempDir,
    /// The gateway's workspace root.
    pub root: PathBuf,
    /// The folder of canonical repositories (`<id>.git`).
    pub canonical: PathBuf,
    pub project: Uuid,
    /// A clone that pushes to canonical, as a runtime would.
    pub work: PathBuf,
    pub config: ServerConfig,
}

impl HostedScenario {
    /// A space whose canonical repository exists but has no `main` yet.
    pub(super) fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let root = base.join("root");
        let canonical = base.join("canonical");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&canonical).unwrap();
        let project = Uuid::new_v4();
        let remote = canonical.join(format!("{project}.git"));
        git_in(
            &base,
            &[
                "init",
                "--bare",
                "-q",
                "-b",
                "main",
                remote.to_str().unwrap(),
            ],
        );
        let work = base.join("work");
        git_in(&base, &["init", "-q", "-b", "main", work.to_str().unwrap()]);
        git_in(&work, &["config", "user.name", "Runtime"]);
        git_in(&work, &["config", "user.email", "agent@instafy.dev"]);
        let config = ServerConfig {
            project_id: project,
            origin_id: Uuid::nil(),
            workspace_root: root.clone(),
            git_remote_url: None,
            git_remote_base_url: Some(format!("file://{}", canonical.display())),
            git_branch: "main".into(),
            git_remote_name: "origin".into(),
            git_author_name: "instafy-origin".into(),
            git_author_email: "gateway@instafy.dev".into(),
            bind_host: "127.0.0.1".into(),
            bind_port: 0,
            controller_base_url: "http://127.0.0.1:1/".parse().unwrap(),
            controller_internal_token: None,
            controller_token_source: None,
            jwks_url: "http://127.0.0.1:1/jwks".parse().unwrap(),
            skip_auth: true,
            enable_presence_heartbeat: false,
            presence_interval: Duration::from_secs(30),
            max_archive_bytes: 16 * 1024 * 1024,
            staging_base: None,
            multi_tenant: true,
            hosted_checkout: false,
        };
        Self {
            _dir: dir,
            root,
            canonical,
            project,
            work,
            config,
        }
    }

    /// The canonical repository of the space.
    pub(super) fn remote(&self) -> PathBuf {
        self.canonical.join(format!("{}.git", self.project))
    }

    /// Commit `files` (`None` deletes) in the runtime clone on top of
    /// canonical `main` and push it there; returns the commit.
    pub(super) fn push(&self, files: &[(&str, Option<&[u8]>)], message: &str) -> String {
        runtime_push(&self.work, &self.remote(), files, message)
    }

    /// A handle for pushing from outside the scenario (a push hook).
    pub(super) fn runtime(&self) -> (PathBuf, PathBuf) {
        (self.work.clone(), self.remote())
    }
}

/// Commit `files` (`None` deletes) in the runtime clone `work` on top of
/// `remote`'s `main` and push it there; returns the commit.
pub(super) fn runtime_push(
    work: &Path,
    remote: &Path,
    files: &[(&str, Option<&[u8]>)],
    message: &str,
) -> String {
    let remote = remote.to_str().unwrap();
    let heads = git_in(work, &["ls-remote", "--heads", remote, "main"]);
    if !heads.is_empty() {
        git_in(work, &["fetch", "-q", remote, "main"]);
        git_in(work, &["reset", "-q", "--hard", "FETCH_HEAD"]);
    }
    for (path, content) in files {
        let target = work.join(path);
        match content {
            Some(bytes) => {
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(&target, bytes).unwrap();
                git_in(work, &["add", "-f", "--", path]);
            }
            None => {
                git_in(work, &["rm", "-q", "--", path]);
            }
        }
    }
    git_in(work, &["commit", "-q", "--allow-empty", "-m", message]);
    git_in(work, &["push", "-q", remote, "HEAD:refs/heads/main"]);
    git_in(work, &["rev-parse", "HEAD"])
}

impl HostedScenario {
    /// Put `path` in the index of the runtime clone as `mode` naming
    /// `oid` (links and submodules), then commit and push.
    pub(super) fn push_entry(&self, path: &str, mode: &str, oid: &str, message: &str) -> String {
        self.sync_work();
        let info = format!("{mode},{oid},{path}");
        git_in(&self.work, &["update-index", "--add", "--cacheinfo", &info]);
        self.commit_and_push(message)
    }

    /// A blob holding `content` in the runtime clone.
    pub(super) fn blob(&self, content: &str) -> String {
        let output = crate::test_support::git_output(
            &self.work,
            &["hash-object", "-w", "--stdin"],
            Some(content.as_bytes()),
        );
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    pub(super) fn sync_work(&self) {
        let remote = self.remote();
        let remote = remote.to_str().unwrap();
        let heads = git_in(&self.work, &["ls-remote", "--heads", remote, "main"]);
        if !heads.is_empty() {
            git_in(&self.work, &["fetch", "-q", remote, "main"]);
            git_in(&self.work, &["reset", "-q", "--hard", "FETCH_HEAD"]);
        }
    }

    fn commit_and_push(&self, message: &str) -> String {
        git_in(
            &self.work,
            &["commit", "-q", "--allow-empty", "-m", message],
        );
        let remote = self.remote();
        git_in(
            &self.work,
            &[
                "push",
                "-q",
                remote.to_str().unwrap(),
                "HEAD:refs/heads/main",
            ],
        );
        git_in(&self.work, &["rev-parse", "HEAD"])
    }

    /// Point `reference` on canonical at `target` (a commit or tag in the
    /// runtime clone).
    pub(super) fn push_ref(&self, target: &str, reference: &str) {
        let remote = self.remote();
        let spec = format!("{target}:{reference}");
        git_in(&self.work, &["push", "-q", remote.to_str().unwrap(), &spec]);
    }

    /// A commit of `files` on top of canonical `main` that is not pushed
    /// to `main` (unsaved work for a recovery ref), with `message`.
    pub(super) fn side_commit(&self, files: &[(&str, &[u8])], message: &str) -> String {
        self.sync_work();
        for (path, content) in files {
            let target = self.work.join(path);
            std::fs::create_dir_all(target.parent().unwrap()).unwrap();
            std::fs::write(&target, content).unwrap();
            git_in(&self.work, &["add", "--", path]);
        }
        git_in(&self.work, &["commit", "-q", "-m", message]);
        let commit = git_in(&self.work, &["rev-parse", "HEAD"]);
        git_in(&self.work, &["reset", "-q", "--hard", "HEAD~1"]);
        commit
    }

    /// An empty commit on `main` made as `name <email>` (author and
    /// committer) with `message`, pushed.
    pub(super) fn push_as(&self, name: &str, email: &str, message: &str) -> String {
        self.sync_work();
        let name = format!("user.name={name}");
        let email = format!("user.email={email}");
        git_in(
            &self.work,
            &[
                "-c",
                &name,
                "-c",
                &email,
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                message,
            ],
        );
        let remote = self.remote();
        git_in(
            &self.work,
            &[
                "push",
                "-q",
                remote.to_str().unwrap(),
                "HEAD:refs/heads/main",
            ],
        );
        git_in(&self.work, &["rev-parse", "HEAD"])
    }

    /// Canonical `main`, if any.
    pub(super) fn canonical_main(&self) -> Option<String> {
        let output = crate::test_support::git_output(
            &self.remote(),
            &["rev-parse", "--verify", "--quiet", "refs/heads/main"],
            None,
        );
        output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    pub(super) fn open_cache(&self) -> MirrorCache {
        MirrorCache::open(
            &self.root,
            Arc::new(self.config.clone()),
            reqwest::Client::new(),
            u64::MAX,
        )
        .unwrap()
    }

    /// The mirror of this space in the cache.
    pub(super) fn mirror(&self) -> PathBuf {
        self.root
            .join(".git-cache")
            .join(format!("{}.git", self.project))
    }
}

fn set_last_use(mirror: &Path, at: SystemTime) {
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(mirror.join("instafy-last-use"))
        .unwrap();
    file.set_modified(at).unwrap();
}

// ---------------------------------------------------------------------------
// The mirror cache.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn an_empty_space_reads_as_no_main_until_canonical_has_one() {
    let sc = HostedScenario::new();
    let cache = Arc::new(sc.open_cache());
    let lease = cache.lease(sc.project);

    let main = cache
        .resolve_main(&lease, Freshness::Coalesced, None)
        .await
        .unwrap();
    assert_eq!(main, None);
    assert!(sc.mirror().join("HEAD").is_file(), "the mirror exists");

    let pushed = sc.push(&[("README.md", Some(b"one\n"))], "first");
    let main = cache
        .resolve_main(&lease, Freshness::Fresh, None)
        .await
        .unwrap();
    assert_eq!(main.as_deref(), Some(pushed.as_str()));
}

#[tokio::test(flavor = "multi_thread")]
async fn plain_reads_share_a_fetch_and_writes_always_get_a_new_one() {
    let sc = HostedScenario::new();
    let first = sc.push(&[("README.md", Some(b"one\n"))], "first");
    let cache = Arc::new(sc.open_cache());
    let lease = cache.lease(sc.project);

    // Concurrent reads join one fetch.
    let reads = (0..6)
        .map(|_| {
            let cache = cache.clone();
            let project = sc.project;
            tokio::spawn(async move {
                let lease = cache.lease(project);
                cache
                    .resolve_main(&lease, Freshness::Coalesced, None)
                    .await
                    .unwrap()
            })
        })
        .collect::<Vec<_>>();
    for read in reads {
        assert_eq!(read.await.unwrap().as_deref(), Some(first.as_str()));
    }
    assert_eq!(cache.fetches_started(), 1);

    // A read right after reuses that fetch, even though canonical moved.
    let second = sc.push(&[("README.md", Some(b"two\n"))], "second");
    let main = cache
        .resolve_main(&lease, Freshness::Coalesced, None)
        .await
        .unwrap();
    assert_eq!(main.as_deref(), Some(first.as_str()));
    assert_eq!(cache.fetches_started(), 1);

    // A write never does.
    let main = cache
        .resolve_main(&lease, Freshness::Fresh, None)
        .await
        .unwrap();
    assert_eq!(main.as_deref(), Some(second.as_str()));
    assert_eq!(cache.fetches_started(), 2);

    // After the window a read fetches again.
    let third = sc.push(&[("README.md", Some(b"three\n"))], "third");
    tokio::time::sleep(Duration::from_millis(2100)).await;
    let main = cache
        .resolve_main(&lease, Freshness::Coalesced, None)
        .await
        .unwrap();
    assert_eq!(main.as_deref(), Some(third.as_str()));
    assert_eq!(cache.fetches_started(), 3);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_slow_fetch_answers_retry_later_and_finishes_on_its_own() {
    let sc = HostedScenario::new();
    let pushed = sc.push(&[("README.md", Some(b"one\n"))], "first");
    let mut cache = sc
        .open_cache()
        .with_waits(Duration::from_millis(100), Duration::from_millis(100));
    cache.test_fetch_delay = Some(Duration::from_millis(600));
    let cache = Arc::new(cache);

    let lease = cache.lease(sc.project);
    let error = cache
        .resolve_main(&lease, Freshness::Coalesced, None)
        .await
        .unwrap_err();
    let response = axum::response::IntoResponse::into_response(error);
    assert_eq!(
        response.status(),
        axum::http::StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        response
            .headers()
            .get(axum::http::header::RETRY_AFTER)
            .unwrap(),
        "2"
    );
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["code"], "fetch_pending");
    drop(lease);

    // The fetch went on without anyone waiting for it.
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let local = git_in(&sc.mirror(), &["rev-parse", "refs/heads/main"]);
    assert_eq!(local, pushed);
    assert_eq!(cache.fetches_started(), 1);
}

/// No caller waits for a space's first clone longer than its client
/// waits for the answer (the controller's managed-files reads 20 s, its
/// import status checks 30 s, a browser's save): every caller, plain read
/// or write, is told `fetch_pending` within the fetch wait, and the clone
/// goes on in the background.
#[test]
fn a_first_clone_never_outlasts_the_callers_that_wait() {
    assert!(super::cache::FETCH_WAIT <= Duration::from_secs(10));
    assert!(super::cache::FIRST_CLONE_WAIT <= Duration::from_secs(10));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_first_clone_answers_every_caller_early_and_goes_on() {
    let sc = HostedScenario::new();
    let pushed = sc.push(&[("README.md", Some(b"one\n"))], "first");
    let mut cache = sc
        .open_cache()
        .with_waits(Duration::from_millis(100), Duration::from_millis(200));
    cache.test_fetch_delay = Some(Duration::from_millis(1500));
    let cache = Arc::new(cache);

    for freshness in [Freshness::Coalesced, Freshness::Fresh] {
        let lease = cache.lease(sc.project);
        let started = std::time::Instant::now();
        let error = cache
            .resolve_main(&lease, freshness, None)
            .await
            .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(1), "{freshness:?}");
        assert!(super::cache::is_fetch_pending(&error), "{error:?}");
    }
    // The clone went on without anyone waiting for it.
    tokio::time::sleep(Duration::from_millis(3500)).await;
    let lease = cache.lease(sc.project);
    assert_eq!(
        cache
            .resolve_main(&lease, Freshness::Coalesced, None)
            .await
            .unwrap()
            .as_deref(),
        Some(pushed.as_str())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_unreachable_canonical_is_an_error_and_never_old_data() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"one\n"))], "first");
    let cache = Arc::new(sc.open_cache());
    let lease = cache.lease(sc.project);
    cache
        .resolve_main(&lease, Freshness::Coalesced, None)
        .await
        .unwrap();

    // Canonical goes away: the mirror still has main, but a fresh read
    // must not be served from it.
    let moved = sc.canonical.with_extension("moved");
    std::fs::rename(&sc.canonical, &moved).unwrap();
    let error = cache
        .resolve_main(&lease, Freshness::Fresh, None)
        .await
        .unwrap_err();
    let response = axum::response::IntoResponse::into_response(error);
    assert_eq!(response.status(), axum::http::StatusCode::BAD_GATEWAY);
    let body = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(body["code"], "canonical_unreachable");
    // The message names neither the repository nor its address.
    assert!(!body.to_string().contains(".git"), "{body}");
    // Not the mirror's fault: it stays as it was.
    assert!(sc.mirror().join("refs/heads/main").is_file());
    std::fs::rename(&moved, &sc.canonical).unwrap();
}

/// A git killed while it moved a mirror's `main` (out of memory, a stop
/// that ran out of time) leaves `main.lock`, which refuses every later
/// fetch. The mirror is thrown away and fetched again at once; a server
/// that starts clears such locks before anything runs.
#[tokio::test(flavor = "multi_thread")]
async fn a_mirror_broken_on_disk_is_made_again() {
    let sc = HostedScenario::new();
    let first = sc.push(&[("README.md", Some(b"one\n"))], "first");
    let cache = Arc::new(sc.open_cache());
    let lease = cache.lease(sc.project);
    assert_eq!(
        cache
            .resolve_main(&lease, Freshness::Fresh, None)
            .await
            .unwrap()
            .as_deref(),
        Some(first.as_str())
    );
    let lock = sc.mirror().join("refs/heads/main.lock");
    std::fs::write(&lock, format!("{first}\n")).unwrap();
    let second = sc.push(&[("README.md", Some(b"two\n"))], "second");
    assert_eq!(
        cache
            .resolve_main(&lease, Freshness::Fresh, None)
            .await
            .unwrap()
            .as_deref(),
        Some(second.as_str())
    );
    assert!(!lock.exists());
    drop(lease);
    drop(cache);

    // Locks left in a mirror are gone once the server starts again, and
    // nothing else is touched.
    let fetched = sc.mirror().join("refs/instafy/fetched/n1");
    std::fs::create_dir_all(&fetched).unwrap();
    let left = [
        lock.clone(),
        sc.mirror().join("packed-refs.lock"),
        sc.mirror().join("config.lock"),
        fetched.join("x.lock"),
    ];
    for path in &left {
        std::fs::write(path, "x\n").unwrap();
    }
    let cache = Arc::new(sc.open_cache());
    for path in &left {
        assert!(!path.exists(), "{path:?}");
    }
    assert!(fetched.is_dir());
    let lease = cache.lease(sc.project);
    assert_eq!(
        cache
            .resolve_main(&lease, Freshness::Coalesced, None)
            .await
            .unwrap()
            .as_deref(),
        Some(second.as_str())
    );
}

/// The loose object file of `oid` in the mirror at `mirror`.
fn loose_object(mirror: &Path, oid: &str) -> PathBuf {
    mirror.join("objects").join(&oid[..2]).join(&oid[2..])
}

/// Overwrite the loose object `oid` of `mirror` with `bytes`.
fn damage_object(mirror: &Path, oid: &str, bytes: &[u8]) {
    use std::os::unix::fs::PermissionsExt as _;
    let path = loose_object(mirror, oid);
    assert!(path.is_file(), "{oid} is not loose in the mirror");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    std::fs::write(&path, bytes).unwrap();
}

/// Wait until `path` answers `status` (the mirror made again in the
/// background), at most 20 s.
async fn until_status(served: &Served, path: &str, status: u16) -> Answer {
    let started = std::time::Instant::now();
    loop {
        let answer = get(served, path).await;
        if answer.status == status || started.elapsed() > Duration::from_secs(20) {
            return answer;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// An object damaged in a mirror on the gateway's disk (a missing tree, a
/// corrupt or empty blob) is never read as "not there" or as a server
/// failure: the mirror is thrown away and made again in the background,
/// and the read meanwhile is told 503 `mirror_reset`. Canonical is never
/// touched.
#[tokio::test(flavor = "multi_thread")]
async fn a_mirror_with_a_damaged_object_is_made_again_when_read() {
    let sc = HostedScenario::new();
    let head = sc.push(
        &[("a.txt", Some(b"alpha\n")), ("d/x.txt", Some(b"x\n"))],
        "first",
    );
    let blob = git_in(&sc.remote(), &["rev-parse", &format!("{head}:a.txt")]);
    let tree = git_in(&sc.remote(), &["rev-parse", &format!("{head}:d")]);
    let served = serve(&sc).await;
    let canonical_before = git_in(&sc.remote(), &["count-objects", "-v"]);

    for (damage, read) in [
        ("corrupt blob", "/files/a.txt"),
        ("empty blob", "/files/a.txt"),
        ("corrupt blob in a listing", "/entries"),
        ("missing tree", "/entries?path=d"),
        ("missing tree under a file read", "/files/d/x.txt"),
    ] {
        assert_eq!(
            until_status(&served, read, 200).await.status,
            200,
            "{damage}"
        );
        match damage {
            "corrupt blob" | "corrupt blob in a listing" => {
                damage_object(&sc.mirror(), &blob, b"garbage")
            }
            "empty blob" => damage_object(&sc.mirror(), &blob, b""),
            _ => std::fs::remove_file(loose_object(&sc.mirror(), &tree)).unwrap(),
        }
        let answer = get(&served, read).await;
        assert_eq!(
            (answer.status, answer.code().as_str()),
            (503, "mirror_reset"),
            "{damage}: {}",
            String::from_utf8_lossy(&answer.body)
        );
        assert!(answer.header("retry-after").is_some(), "{damage}");
        let answer = until_status(&served, read, 200).await;
        assert_eq!(answer.status, 200, "{damage}: made again");
    }
    let file = get(&served, "/files/a.txt").await;
    assert_eq!(decoded(&file), b"alpha\n");
    let listing = get(&served, "/entries").await.json();
    assert_eq!(listing.as_array().unwrap().len(), 2, "{listing}");
    assert_eq!(
        git_in(&sc.remote(), &["count-objects", "-v"]),
        canonical_before
    );

    // A save that finds the damage while building is told the same, and
    // saves once the mirror is made again.
    std::fs::remove_file(loose_object(&sc.mirror(), &tree)).unwrap();
    let request =
        super::write_tests::manifest(&["d/y.txt"], &[], serde_json::json!({ "baseRev": head }));
    let archive = super::write_tests::zip(&[("d/y.txt", b"y\n")]);
    let save = || super::write_tests::apply(&served, request.clone(), &archive);
    let answer = save().await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (503, "mirror_reset"),
        "{}",
        String::from_utf8_lossy(&answer.body)
    );
    assert_eq!(sc.canonical_main().as_deref(), Some(head.as_str()));
    let started = std::time::Instant::now();
    let saved = loop {
        let answer = save().await;
        if answer.status != 503 || started.elapsed() > Duration::from_secs(20) {
            break answer;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(
        saved.status,
        200,
        "{}",
        String::from_utf8_lossy(&saved.body)
    );
}

/// A fetch whose new objects are deltas against an object damaged in the
/// mirror (a thin pack, which `index-pack` resolves against local objects)
/// fails in a way that also looks like a bad pack from canonical. Fetched
/// again from scratch it shows whose it was: here the mirror's, so the read
/// is served.
#[tokio::test(flavor = "multi_thread")]
async fn a_fetch_that_fails_against_a_damaged_base_is_made_again_from_scratch() {
    let big: String = (0..20_000).map(|n| format!("line {n}\n")).collect();
    for damage in [&b"garbage"[..], &b""[..]] {
        let sc = HostedScenario::new();
        let head = sc.push(&[("big.txt", Some(big.as_bytes()))], "first");
        let base = git_in(&sc.remote(), &["rev-parse", &format!("{head}:big.txt")]);
        let served = serve(&sc).await;
        assert_eq!(get(&served, "/files/big.txt").await.status, 200);
        damage_object(&sc.mirror(), &base, damage);
        // Enough new objects that the fetch goes through index-pack, and a
        // change of the damaged file, sent as a delta against it.
        let mut files: Vec<(String, Vec<u8>)> = (0..150)
            .map(|n| (format!("many/{n}.txt"), format!("{n}\n").into_bytes()))
            .collect();
        files.push((
            "big.txt".to_string(),
            format!("{big}one more\n").into_bytes(),
        ));
        let files: Vec<(&str, Option<&[u8]>)> = files
            .iter()
            .map(|(path, bytes)| (path.as_str(), Some(bytes.as_slice())))
            .collect();
        let latest = sc.push(&files, "many");
        let answer = get(&served, &format!("/files/big.txt?rev={latest}")).await;
        assert_eq!(
            answer.status,
            200,
            "{}",
            String::from_utf8_lossy(&answer.body)
        );
        assert!(decoded(&answer).ends_with(b"one more\n"));
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mirror_that_is_not_a_folder_is_made_again() {
    let sc = HostedScenario::new();
    let cache = Arc::new(sc.open_cache());
    std::fs::write(sc.mirror(), b"not a repository").unwrap();
    let lease = cache.lease(sc.project);
    let dir = cache.ensure_mirror(&lease.mirror()).unwrap();
    assert_eq!(dir, sc.mirror());
    assert!(dir.join("HEAD").is_file());
    let pushed = sc.push(&[("README.md", Some(b"one\n"))], "first");
    assert_eq!(
        cache
            .resolve_main(&lease, Freshness::Fresh, None)
            .await
            .unwrap()
            .as_deref(),
        Some(pushed.as_str())
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_deleted_cache_is_fetched_again() {
    let sc = HostedScenario::new();
    let pushed = sc.push(&[("README.md", Some(b"one\n"))], "first");
    let cache = Arc::new(sc.open_cache());
    {
        let lease = cache.lease(sc.project);
        cache
            .resolve_main(&lease, Freshness::Fresh, None)
            .await
            .unwrap();
    }
    std::fs::remove_dir_all(sc.mirror()).unwrap();
    let lease = cache.lease(sc.project);
    let main = cache
        .resolve_main(&lease, Freshness::Coalesced, None)
        .await
        .unwrap();
    assert_eq!(main.as_deref(), Some(pushed.as_str()));
}

#[test]
fn opening_the_cache_clears_what_requests_left_and_refuses_links() {
    let sc = HostedScenario::new();
    let cache_root = sc.root.join(".git-cache");
    for leftover in [".quarantine/a/objects", ".staging/b", ".trash/c.git"] {
        std::fs::create_dir_all(cache_root.join(leftover)).unwrap();
    }
    std::fs::create_dir_all(cache_root.join(".tmp-x.git")).unwrap();
    std::fs::create_dir_all(cache_root.join(format!("{}.git", sc.project))).unwrap();
    drop(sc.open_cache());
    for folder in [".quarantine", ".staging", ".trash"] {
        assert_eq!(
            std::fs::read_dir(cache_root.join(folder)).unwrap().count(),
            0,
            "{folder}"
        );
    }
    assert!(!cache_root.join(".tmp-x.git").exists());
    assert!(cache_root.join(format!("{}.git", sc.project)).is_dir());

    #[cfg(unix)]
    {
        let other = HostedScenario::new();
        let elsewhere = other.root.join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, other.root.join(".git-cache")).unwrap();
        assert!(MirrorCache::open(
            &other.root,
            Arc::new(other.config.clone()),
            reqwest::Client::new(),
            u64::MAX
        )
        .is_err());
    }
}

#[test]
fn eviction_removes_least_recently_used_idle_mirrors_until_under_the_cap() {
    let now = SystemTime::now();
    let hours = |n: u64| now - Duration::from_secs(n * 3600);
    let ids: Vec<Uuid> = (0..5).map(|n| Uuid::from_u128(n + 1)).collect();
    let stat = |index: usize, bytes: u64, last_use: SystemTime, leases: usize| MirrorStat {
        project: ids[index],
        bytes,
        last_use,
        leases,
    };
    let stats = vec![
        stat(0, 40, hours(5), 0),
        stat(1, 40, hours(3), 0),
        // Oldest, but in use.
        stat(2, 40, hours(9), 1),
        // Used recently.
        stat(3, 40, now - Duration::from_secs(60), 0),
        stat(4, 40, hours(2), 0),
    ];
    // 200 bytes against a cap of 120: the two least recently used idle
    // mirrors go.
    assert_eq!(plan_eviction(&stats, 120, now), vec![ids[0], ids[1]]);
    // Under the cap: nothing.
    assert!(plan_eviction(&stats, 200, now).is_empty());
    // A cap nothing can meet removes every idle mirror and keeps the rest.
    assert_eq!(plan_eviction(&stats, 0, now), vec![ids[0], ids[1], ids[4]]);
    // Exactly one hour is not idle yet.
    let edge = vec![stat(0, 10, now - EVICT_IDLE_AFTER, 0)];
    assert!(plan_eviction(&edge, 0, now).is_empty());
}

/// On a disk short of space, mirrors nobody holds go (least recently used
/// first, however recently used) until enough is freed.
#[test]
fn a_disk_short_of_space_removes_unheld_mirrors_until_enough_is_free() {
    let now = SystemTime::now();
    let ids: Vec<Uuid> = (0..4).map(|n| Uuid::from_u128(n + 1)).collect();
    let stat = |index: usize, bytes: u64, ago: u64, leases: usize| MirrorStat {
        project: ids[index],
        bytes,
        last_use: now - Duration::from_secs(ago),
        leases,
    };
    let stats = vec![
        stat(0, 40, 60, 0),
        stat(1, 40, 120, 0),
        stat(2, 40, 600, 1),
        stat(3, 40, 30, 0),
    ];
    assert_eq!(plan_space_eviction(&stats, 50), vec![ids[1], ids[0]]);
    assert_eq!(plan_space_eviction(&stats, 1), vec![ids[1]]);
    assert!(plan_space_eviction(&stats, 0).is_empty());
    // Not enough to free: every mirror nobody holds, the held one stays.
    assert_eq!(
        plan_space_eviction(&stats, 1_000),
        vec![ids[1], ids[0], ids[3]]
    );
}

/// The sweeper keeps free space on the cache's disk, not only the cap: with
/// the disk short of space, a mirror used a minute ago that nobody holds is
/// removed though the cache is far under its cap; a held one stays.
#[tokio::test(flavor = "multi_thread")]
async fn the_sweeper_keeps_free_space_on_the_disk() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"one\n"))], "one");
    let other = HostedScenario::new();
    let free = Arc::new(std::sync::atomic::AtomicU64::new(u64::MAX));
    let reading = free.clone();
    let cache = Arc::new(sc.open_cache().with_free_space(1024 * 1024, move |_| {
        Some(reading.load(std::sync::atomic::Ordering::SeqCst))
    }));
    let held = cache.lease(sc.project);
    cache
        .resolve_main(&held, Freshness::Fresh, None)
        .await
        .unwrap();
    let released = cache.lease(other.project);
    cache.ensure_mirror(&released.mirror()).unwrap();
    drop(released);
    let other_mirror = sc
        .root
        .join(".git-cache")
        .join(format!("{}.git", other.project));
    assert!(other_mirror.is_dir());
    let sweep = |cache: Arc<MirrorCache>| async move {
        tokio::task::spawn_blocking(move || cache.sweep(SystemTime::now()))
            .await
            .unwrap()
    };

    // Plenty of space: nothing goes.
    assert!(sweep(cache.clone()).await.evicted.is_empty());
    // Short of space: the mirror nobody holds goes at once.
    free.store(10, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(sweep(cache.clone()).await.evicted, vec![other.project]);
    assert!(!other_mirror.exists());
    assert!(sc.mirror().is_dir(), "a held mirror stays");
}

/// A sweep measures only mirrors that changed since the last one: a mirror
/// nothing fetched into keeps its size (bytes written behind the server's
/// back are not seen), and a fetch has it measured again.
#[tokio::test(flavor = "multi_thread")]
async fn sweeps_measure_only_mirrors_that_changed() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"one\n"))], "one");
    let cache = Arc::new(sc.open_cache());
    let lease = cache.lease(sc.project);
    cache
        .resolve_main(&lease, Freshness::Fresh, None)
        .await
        .unwrap();
    let sweep = |cache: Arc<MirrorCache>| async move {
        tokio::task::spawn_blocking(move || cache.sweep(SystemTime::now()))
            .await
            .unwrap()
            .total_bytes
    };
    let first = sweep(cache.clone()).await;
    assert!(first > 0);
    std::fs::write(
        sc.mirror().join("objects/unmeasured"),
        vec![0u8; 1024 * 1024],
    )
    .unwrap();
    assert_eq!(sweep(cache.clone()).await, first, "measured again");
    cache
        .resolve_main(&lease, Freshness::Fresh, None)
        .await
        .unwrap();
    assert!(sweep(cache.clone()).await >= first + 1024 * 1024);
}

/// The packs in a mirror.
fn packs(mirror: &Path) -> usize {
    std::fs::read_dir(mirror.join("objects/pack"))
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| entry.file_name().to_string_lossy().ends_with(".pack"))
                .count()
        })
        .unwrap_or(0)
}

/// A mirror whose own configuration would have git pack it after every
/// fetch (a pack per fetch, a limit of one pack, maintenance in the
/// foreground): fetches leave it alone, and the sweeper packs it once it
/// crosses the limits, without counting that as a use.
#[tokio::test(flavor = "multi_thread")]
async fn only_the_sweeper_packs_mirrors() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"one\n"))], "one");
    let cache = Arc::new(sc.open_cache().with_pack_limits(u64::MAX, 2));
    let lease = cache.lease(sc.project);
    let mirror = cache.ensure_mirror(&lease.mirror()).unwrap();
    for setting in [
        "fetch.unpackLimit=1",
        "gc.auto=1",
        "gc.autoPackLimit=1",
        "gc.autoDetach=false",
        "maintenance.autoDetach=false",
        "maintenance.auto=true",
    ] {
        let (key, value) = setting.split_once('=').unwrap();
        git_in(&mirror, &["config", key, value]);
    }
    let mut fetched = Vec::new();
    for round in 0..3 {
        if round > 0 {
            sc.push(
                &[(&format!("file-{round}.txt"), Some(b"x\n"))],
                &format!("round {round}"),
            );
        }
        fetched.push(
            cache
                .resolve_main(&lease, Freshness::Fresh, None)
                .await
                .unwrap()
                .unwrap(),
        );
    }
    assert_eq!(packs(&mirror), 3, "one pack per fetch, none merged");
    drop(lease);
    let before = std::fs::metadata(mirror.join("instafy-last-use"))
        .unwrap()
        .modified()
        .unwrap();

    let swept = {
        let cache = cache.clone();
        tokio::task::spawn_blocking(move || cache.sweep(SystemTime::now()))
            .await
            .unwrap()
    };
    assert_eq!(swept.packed, vec![sc.project]);
    assert_eq!(packs(&mirror), 1);
    assert_eq!(
        std::fs::metadata(mirror.join("instafy-last-use"))
            .unwrap()
            .modified()
            .unwrap(),
        before,
        "packing is not a use"
    );
    // Everything is still there.
    let lease = cache.lease(sc.project);
    assert_eq!(
        cache
            .resolve_main(&lease, Freshness::Coalesced, None)
            .await
            .unwrap()
            .as_deref(),
        fetched.last().map(String::as_str)
    );
    assert_eq!(
        git_in(
            &mirror,
            &["cat-file", "-p", &format!("{}:file-2.txt", fetched[2])]
        ),
        "x"
    );
    // Under the limits nothing runs.
    let swept = {
        let cache = cache.clone();
        tokio::task::spawn_blocking(move || cache.sweep(SystemTime::now()))
            .await
            .unwrap()
    };
    assert!(swept.packed.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn the_sweeper_keeps_mirrors_in_use_and_removes_idle_ones() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"one\n"))], "first");
    let other = Uuid::new_v4();
    git_in(
        &sc.canonical,
        &[
            "init",
            "--bare",
            "-q",
            "-b",
            "main",
            &format!("{other}.git"),
        ],
    );
    let cache = Arc::new(
        MirrorCache::open(
            &sc.root,
            Arc::new(sc.config.clone()),
            reqwest::Client::new(),
            1,
        )
        .unwrap(),
    );
    for project in [sc.project, other] {
        let lease = cache.lease(project);
        cache
            .resolve_main(&lease, Freshness::Fresh, None)
            .await
            .unwrap();
    }
    let other_mirror = cache.root().join(format!("{other}.git"));
    let two_hours_ago = SystemTime::now() - Duration::from_secs(7200);
    set_last_use(&sc.mirror(), two_hours_ago);
    set_last_use(&other_mirror, two_hours_ago);
    std::fs::create_dir_all(cache.root().join(".staging/old")).unwrap();

    // One request still holds this space's mirror.
    let held = cache.lease(sc.project);
    let swept = {
        let cache = cache.clone();
        tokio::task::spawn_blocking(move || cache.sweep(SystemTime::now()))
            .await
            .unwrap()
    };
    assert_eq!(swept.evicted, vec![other]);
    assert!(swept.total_bytes > 1);
    assert!(sc.mirror().join("HEAD").is_file(), "the held mirror stays");
    assert!(!other_mirror.exists());
    assert_eq!(
        std::fs::read_dir(cache.root().join(".trash"))
            .unwrap()
            .count(),
        0
    );
    // Recent scratch stays.
    assert!(cache.root().join(".staging/old").is_dir());
    drop(held);

    // Released, it was just used: still not idle.
    let swept = {
        let cache = cache.clone();
        tokio::task::spawn_blocking(move || cache.sweep(SystemTime::now()))
            .await
            .unwrap()
    };
    assert!(swept.evicted.is_empty());

    // A removed mirror is fetched again on its next use.
    let lease = cache.lease(other);
    assert_eq!(
        cache
            .resolve_main(&lease, Freshness::Coalesced, None)
            .await
            .unwrap(),
        None
    );
    assert!(other_mirror.join("HEAD").is_file());
}

// ---------------------------------------------------------------------------
// The read routes.
// ---------------------------------------------------------------------------

pub(super) struct Served {
    pub base: String,
    pub cache: Arc<MirrorCache>,
    /// The state the router serves (its semaphores are shared).
    pub state: super::routes::HostedState,
    server: tokio::task::JoinHandle<()>,
}

impl Drop for Served {
    fn drop(&mut self) {
        self.server.abort();
    }
}

pub(super) async fn serve(sc: &HostedScenario) -> Served {
    serve_with(sc, |state| state).await
}

/// [`serve`] with the state `adjust` makes of the usual one.
pub(super) async fn serve_with(
    sc: &HostedScenario,
    adjust: impl FnOnce(super::routes::HostedState) -> super::routes::HostedState,
) -> Served {
    serve_with_cache(sc, |cache| cache, adjust).await
}

/// [`serve_with`] with the cache `cache` makes of the usual one.
pub(super) async fn serve_with_cache(
    sc: &HostedScenario,
    cache: impl FnOnce(MirrorCache) -> MirrorCache,
    adjust: impl FnOnce(super::routes::HostedState) -> super::routes::HostedState,
) -> Served {
    let config = Arc::new(sc.config.clone());
    let http = reqwest::Client::new();
    let cache = Arc::new(cache(
        MirrorCache::open(&sc.root, config.clone(), http.clone(), u64::MAX).unwrap(),
    ));
    let auth = crate::route_auth::RouteAuth {
        token_validator: crate::auth::TokenValidator::new(http.clone(), config.jwks_url.clone()),
        config,
        http_client: http,
    };
    let state = adjust(super::routes::HostedState::new(auth, cache.clone()));
    let app = super::routes::router(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Served {
        base: format!("http://{address}"),
        cache,
        state,
        server,
    }
}

pub(super) struct Answer {
    pub status: u16,
    pub headers: reqwest::header::HeaderMap,
    pub body: Vec<u8>,
}

impl Answer {
    pub(super) fn json(&self) -> serde_json::Value {
        serde_json::from_slice(&self.body)
            .unwrap_or_else(|error| panic!("{error}: {}", String::from_utf8_lossy(&self.body)))
    }

    pub(super) fn header(&self, name: &str) -> Option<String> {
        self.headers
            .get(name)
            .map(|value| value.to_str().unwrap().to_string())
    }

    pub(super) fn rev(&self) -> Option<String> {
        self.header("x-instafy-rev")
    }

    pub(super) fn code(&self) -> String {
        self.json()["code"].as_str().unwrap_or_default().to_string()
    }
}

pub(super) async fn get(served: &Served, path: &str) -> Answer {
    let response = reqwest::get(format!("{}{path}", served.base))
        .await
        .unwrap();
    Answer {
        status: response.status().as_u16(),
        headers: response.headers().clone(),
        body: response.bytes().await.unwrap().to_vec(),
    }
}

pub(super) async fn post(served: &Served, path: &str, body: serde_json::Value) -> Answer {
    let response = reqwest::Client::new()
        .post(format!("{}{path}", served.base))
        .json(&body)
        .send()
        .await
        .unwrap();
    Answer {
        status: response.status().as_u16(),
        headers: response.headers().clone(),
        body: response.bytes().await.unwrap().to_vec(),
    }
}

pub(super) fn decoded(answer: &Answer) -> Vec<u8> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(answer.json()["content_base64"].as_str().unwrap())
        .unwrap()
}

/// A space with files, a folder, an executable, a symlink, a submodule and
/// a reserved path on `main`.
fn layout_fixture(sc: &HostedScenario) -> String {
    sc.push(
        &[
            ("README.md", Some(b"hello\n")),
            ("src/lib.rs", Some(b"pub fn lib() {}\n")),
            ("src/nested/deep.rs", Some(b"deep\n")),
            ("Makefile", Some(b"all:\n")),
            (".instafy/state.json", Some(b"{}\n")),
        ],
        "files",
    );
    let target = sc.blob("README.md");
    sc.push_entry("link", "120000", &target, "a link");
    let any_commit = git_in(&sc.work, &["rev-parse", "HEAD"]);
    sc.push_entry("vendor/sub", "160000", &any_commit, "a submodule")
}

#[tokio::test(flavor = "multi_thread")]
async fn status_answers_stateless_with_no_git_and_no_fetch() {
    let sc = HostedScenario::new();
    // Not even a canonical repository: status must not look.
    std::fs::remove_dir_all(sc.remote()).unwrap();
    let served = serve(&sc).await;

    let answer = get(&served, "/git/status?scope=src&offset=5&limit=1").await;
    assert_eq!(answer.status, 200);
    let body = answer.json();
    assert_eq!(body["supported"], true);
    assert_eq!(body["stateless"], true);
    assert_eq!(body["dirtyCount"], 0);
    assert_eq!(body["dirtyPaths"], serde_json::json!([]));
    assert_eq!(body["dirtyGroups"], serde_json::json!([]));
    assert_eq!(body["pageOffset"], 5);
    assert_eq!(body["pageLimit"], 1);
    assert_eq!(body["hasMoreFiles"], false);
    assert_eq!(served.cache.fetches_started(), 0);
    assert!(!sc.mirror().exists());
}

/// Spec test 13 on one thread: on a current-thread runtime the server's
/// tasks, middleware included, run on the test thread, where every git
/// process is replaced by a script that records it and fails. None runs.
#[tokio::test(flavor = "current_thread")]
async fn status_starts_no_git_process() {
    let sc = HostedScenario::new();
    let log = sc.root.parent().unwrap().join("git-calls.log");
    let _wrapper = crate::test_support::GitWrapper::install(
        sc.root.parent().unwrap(),
        &format!("echo \"$@\" >> '{}'\nexit 1", log.display()),
    );
    let served = serve(&sc).await;
    let answer = get(&served, "/git/status?offset=2&limit=3").await;
    assert_eq!(answer.status, 200);
    let body = answer.json();
    assert_eq!(body["stateless"], true);
    assert_eq!(body["pageOffset"], 2);
    assert_eq!(body["pageLimit"], 3);
    assert!(
        !log.exists(),
        "git ran: {:?}",
        std::fs::read_to_string(&log)
    );
    assert_eq!(served.cache.fetches_started(), 0);
    assert!(!sc.mirror().exists());

    // The wrapper does reach git started on this thread.
    let _ = crate::workspace_git::WorkspaceGit::bare(&sc.root, None).run(&["--version"]);
    assert!(log.exists(), "the recording script never ran");
}

#[tokio::test(flavor = "multi_thread")]
async fn listings_show_files_and_folders_from_main_with_blob_ids() {
    let sc = HostedScenario::new();
    let head = layout_fixture(&sc);
    let served = serve(&sc).await;

    let answer = get(&served, "/entries").await;
    assert_eq!(answer.status, 200);
    assert_eq!(answer.rev().as_deref(), Some(head.as_str()));
    let listed = answer.json();
    let names: Vec<(&str, &str)> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["name"].as_str().unwrap(),
                entry["kind"].as_str().unwrap(),
            )
        })
        .collect();
    // No link, no submodule, no reserved path; sorted by name.
    assert_eq!(
        names,
        vec![
            ("Makefile", "file"),
            ("README.md", "file"),
            ("src", "directory"),
            ("vendor", "directory"),
        ]
    );
    let readme = &listed[1];
    assert_eq!(readme["path"], "README.md");
    assert_eq!(readme["size"], 6);
    assert_eq!(readme["extension"], "md");
    assert_eq!(readme["mimeType"], "text/markdown");
    assert_eq!(readme["modified"], serde_json::Value::Null);
    assert_eq!(
        readme["blobOid"],
        git_in(&sc.work, &["rev-parse", "HEAD:README.md"])
    );
    assert_eq!(listed[2]["hasChildren"], true);
    assert!(listed[2].get("blobOid").is_none());

    // A folder, a file, and the sync parameter old clients send.
    let src = get(&served, "/entries?path=src&sync=blocking").await.json();
    assert_eq!(src[0]["path"], "src/lib.rs");
    assert_eq!(src[1]["path"], "src/nested");
    let file = get(&served, "/entries?path=src/lib.rs").await.json();
    assert_eq!(file.as_array().unwrap().len(), 1);
    assert_eq!(file[0]["name"], "lib.rs");

    // Nothing there, and things reads never show.
    let absent = get(&served, "/entries?path=missing").await;
    assert_eq!((absent.status, absent.code().as_str()), (404, "not_found"));
    assert_eq!(absent.rev().as_deref(), Some(head.as_str()));
    for hidden in ["link", "vendor/sub", ".instafy"] {
        let answer = get(&served, &format!("/entries?path={hidden}")).await;
        assert_eq!(
            (answer.status, answer.code().as_str()),
            (404, "unsupported_entry"),
            "{hidden}"
        );
    }
    let invalid = get(&served, "/entries?path=../x").await;
    assert_eq!(
        (invalid.status, invalid.code().as_str()),
        (400, "invalid_path")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn file_reads_name_the_blob_and_code_every_404() {
    let sc = HostedScenario::new();
    let head = layout_fixture(&sc);
    let served = serve(&sc).await;
    let readme_blob = git_in(&sc.work, &["rev-parse", "HEAD:README.md"]);

    // Old clients add `encoding=base64`; unknown parameters are ignored.
    let answer = get(&served, "/files/README.md?encoding=base64").await;
    assert_eq!(answer.status, 200);
    assert_eq!(decoded(&answer), b"hello\n");
    let body = answer.json();
    assert_eq!(body["path"], "README.md");
    assert_eq!(body["encoding"], "base64");
    assert_eq!(body["size"], 6);
    assert_eq!(body["mime_type"], "text/markdown");
    assert_eq!(body["modified"], serde_json::Value::Null);
    assert_eq!(answer.header("x-instafy-blob"), Some(readme_blob.clone()));
    assert_eq!(answer.rev(), Some(head.clone()));

    let raw = get(&served, "/raw/README.md").await;
    assert_eq!(raw.status, 200);
    assert_eq!(raw.body, b"hello\n");
    assert_eq!(raw.header("x-instafy-blob"), Some(readme_blob));
    assert_eq!(raw.rev(), Some(head.clone()));
    assert_eq!(raw.header("content-type").as_deref(), Some("text/markdown"));
    assert_eq!(
        raw.header("x-content-type-options").as_deref(),
        Some("nosniff")
    );
    assert!(raw
        .header("content-security-policy")
        .unwrap()
        .contains("sandbox"));

    // Only a path the tree lacks is not_found, and it names the commit.
    for (path, code) in [
        ("missing.md", "not_found"),
        ("link/below", "not_found"),
        ("link", "unsupported_entry"),
        ("vendor/sub", "unsupported_entry"),
        ("src", "unsupported_entry"),
        (".instafy/state.json", "unsupported_entry"),
    ] {
        for route in ["files", "raw"] {
            let answer = get(&served, &format!("/{route}/{path}")).await;
            assert_eq!(
                (answer.status, answer.code().as_str()),
                (404, code),
                "{route}/{path}"
            );
            assert_eq!(answer.rev(), Some(head.clone()), "{route}/{path}");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn an_empty_space_lists_nothing_and_names_no_commit() {
    let sc = HostedScenario::new();
    let served = serve(&sc).await;

    let listed = get(&served, "/entries").await;
    assert_eq!(listed.status, 200);
    assert_eq!(listed.json(), serde_json::json!([]));
    assert_eq!(listed.rev(), None);

    let file = get(&served, "/files/README.md").await;
    assert_eq!((file.status, file.code().as_str()), (404, "not_found"));
    assert_eq!(file.rev(), None);

    let history = get(&served, "/git/history").await;
    assert_eq!(history.status, 200);
    let body = history.json();
    assert_eq!(body["entries"], serde_json::json!([]));
    assert_eq!(body["hasMore"], false);
    assert_eq!(body["branch"], "main");
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_at_a_rev_fetch_once_and_never_show_unknown_commits() {
    let sc = HostedScenario::new();
    let first = sc.push(&[("README.md", Some(b"one\n"))], "first");
    let served = serve(&sc).await;
    assert_eq!(get(&served, "/entries").await.rev(), Some(first.clone()));

    // A newer commit the mirror has not fetched yet is fetched for the read.
    let second = sc.push(&[("README.md", Some(b"two\n"))], "second");
    let answer = get(&served, &format!("/files/README.md?rev={second}")).await;
    assert_eq!(answer.status, 200);
    assert_eq!(decoded(&answer), b"two\n");
    assert_eq!(answer.rev(), Some(second.clone()));

    // An older one reads from the mirror.
    let answer = get(&served, &format!("/files/README.md?rev={first}")).await;
    assert_eq!(decoded(&answer), b"one\n");
    assert_eq!(answer.rev(), Some(first.clone()));
    let listed = get(&served, &format!("/entries?rev={}", first.to_uppercase())).await;
    assert_eq!(listed.status, 200);
    assert_eq!(listed.rev(), Some(first.clone()));

    // A commit canonical never had, and bad values.
    let unknown = "0123456789abcdef0123456789abcdef01234567";
    let answer = get(&served, &format!("/files/README.md?rev={unknown}")).await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (404, "rev_not_found")
    );
    assert_eq!(answer.rev(), None);
    let answer = get(&served, "/files/README.md?rev=main").await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (400, "invalid_rev")
    );
    let answer = get(
        &served,
        &format!("/files/README.md?rev={first}&ref=refs/instafy/salvage/gateway/x"),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (400, "invalid_ref")
    );
    // Empty values count as absent.
    let answer = get(&served, "/files/README.md?rev=&ref=").await;
    assert_eq!(answer.status, 200);
    assert_eq!(answer.rev(), Some(second));
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_at_a_ref_show_its_tip_and_never_main() {
    let sc = HostedScenario::new();
    let head = sc.push(&[("README.md", Some(b"saved\n"))], "saved");
    let unsaved = sc.side_commit(
        &[("README.md", b"unsaved\n"), ("notes/new.md", b"new\n")],
        "unsaved work\n\nInstafy-Recovery-Kind: unsaved\nInstafy-Path: README.md\nInstafy-Path: notes/new.md",
    );
    let origin = Uuid::new_v4();
    let reference = format!("refs/instafy/recovery/{origin}/unsaved-1");
    sc.push_ref(&unsaved, &reference);
    // An annotated tag of the same work under a salvage name.
    git_in(&sc.work, &["tag", "-a", "-m", "kept", "kept-tag", &unsaved]);
    let tag = git_in(&sc.work, &["rev-parse", "kept-tag"]);
    let salvage = "refs/instafy/salvage/gateway/node-1-0123abcd";
    sc.push_ref(&tag, salvage);
    let served = serve(&sc).await;

    let answer = get(&served, &format!("/files/README.md?ref={reference}")).await;
    assert_eq!(
        answer.status,
        200,
        "{}",
        String::from_utf8_lossy(&answer.body)
    );
    assert_eq!(decoded(&answer), b"unsaved\n");
    assert_eq!(answer.rev(), Some(unsaved.clone()));
    let listed = get(&served, &format!("/entries?path=notes&ref={reference}")).await;
    assert_eq!(listed.json()[0]["path"], "notes/new.md");
    assert_eq!(listed.rev(), Some(unsaved.clone()));
    let absent = get(&served, &format!("/files/gone.md?ref={reference}")).await;
    assert_eq!((absent.status, absent.code().as_str()), (404, "not_found"));
    assert_eq!(absent.rev(), Some(unsaved.clone()), "never main's commit");

    // The tag's own id is what the listing calls the item's rev.
    let answer = get(&served, &format!("/raw/README.md?ref={salvage}")).await;
    assert_eq!(answer.body, b"unsaved\n");
    assert_eq!(answer.rev(), Some(tag));

    // A recovery commit is read through its ref only: no ref reaches it.
    let answer = get(&served, &format!("/files/README.md?rev={unsaved}")).await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (404, "rev_not_found")
    );

    // A ref canonical does not have, and names outside the namespaces.
    let gone = format!("refs/instafy/recovery/{origin}/gone");
    let answer = get(&served, &format!("/files/README.md?ref={gone}")).await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (404, "rev_not_found")
    );
    assert_eq!(answer.rev(), None);
    for bad in [
        "refs/heads/main",
        "refs/instafy/recovery/not-a-uuid/x",
        "main",
    ] {
        let answer = get(&served, &format!("/files/README.md?ref={bad}")).await;
        assert_eq!(
            (answer.status, answer.code().as_str()),
            (400, "invalid_ref"),
            "{bad}"
        );
    }
    // Main is untouched by all of this.
    assert_eq!(get(&served, "/entries").await.rev(), Some(head));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_file_over_the_read_limit_is_too_large() {
    let sc = HostedScenario::new();
    let big = vec![b'x'; (super::read::MAX_READ_BYTES + 1) as usize];
    let head = sc.push(
        &[("big.bin", Some(&big)), ("small.txt", Some(b"ok\n"))],
        "big",
    );
    let served = serve(&sc).await;
    for route in ["files", "raw"] {
        let answer = get(&served, &format!("/{route}/big.bin")).await;
        assert_eq!((answer.status, answer.code().as_str()), (413, "too_large"));
        assert_eq!(answer.rev(), Some(head.clone()));
    }
    let listed = get(&served, "/entries").await.json();
    assert_eq!(listed[0]["size"], super::read::MAX_READ_BYTES + 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn history_pages_follow_first_parents_with_actors_and_merges() {
    let sc = HostedScenario::new();
    let root = sc.push_as("instafy-origin", "gateway@instafy.dev", "bootstrap");
    let saved = sc.push_as(
        "Ada Lovelace",
        "p1-3ujoyn5txgxsverj7psd@users.noreply.instafy.dev",
        "Update README.md",
    );
    // A merge with a side branch, as a runtime publish makes one.
    git_in(&sc.work, &["checkout", "-q", "-b", "side", &root]);
    std::fs::write(sc.work.join("side.txt"), "side\n").unwrap();
    git_in(&sc.work, &["add", "side.txt"]);
    git_in(&sc.work, &["commit", "-q", "-m", "agent work"]);
    git_in(&sc.work, &["checkout", "-q", "main"]);
    git_in(&sc.work, &["reset", "-q", "--hard", &saved]);
    git_in(
        &sc.work,
        &["merge", "-q", "--no-ff", "side", "-m", "publish"],
    );
    let merge = git_in(&sc.work, &["rev-parse", "HEAD"]);
    let remote = sc.remote();
    git_in(
        &sc.work,
        &[
            "push",
            "-q",
            remote.to_str().unwrap(),
            "HEAD:refs/heads/main",
        ],
    );
    let external = sc.push_as("Someone", "someone@example.com", "from GitHub");
    let served = serve(&sc).await;

    let answer = get(&served, "/git/history?limit=3").await;
    assert_eq!(answer.status, 200);
    assert_eq!(answer.rev(), Some(external.clone()));
    let body = answer.json();
    assert_eq!(body["branch"], "main");
    assert_eq!(body["headRef"], "main");
    assert_eq!(body["hasMore"], true);
    let entries = body["entries"].as_array().unwrap();
    let rows: Vec<(&str, &str, u64)> = entries
        .iter()
        .map(|entry| {
            (
                entry["commit"].as_str().unwrap(),
                entry["actor"].as_str().unwrap(),
                entry["parentCount"].as_u64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (external.as_str(), "external", 1),
            (merge.as_str(), "service", 2),
            (saved.as_str(), "user", 1),
        ]
    );
    assert_eq!(entries[1]["firstParent"], saved.as_str());
    assert_eq!(entries[2]["authorName"], "Ada Lovelace");

    let rest = get(&served, "/git/history?limit=3&skip=3").await.json();
    let rest: Vec<&str> = rest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["commit"].as_str().unwrap())
        .collect();
    // The side commit is not on the first-parent chain.
    assert_eq!(rest, vec![root.as_str()]);
    assert_eq!(
        get(&served, "/git/history?limit=3&skip=3").await.json()["hasMore"],
        false
    );
    let last = get(&served, "/git/history?limit=4").await.json();
    assert_eq!(last["hasMore"], false);
    assert_eq!(last["entries"][3]["parentCount"], 0);
    assert!(last["entries"][3].get("firstParent").is_none());
    // At most 50 a page, at least 1.
    let one = get(&served, "/git/history?limit=0").await.json();
    assert_eq!(one["entries"].as_array().unwrap().len(), 1);
}

/// A page holds at most 50 entries (the shared walk's cap), and `hasMore`
/// looks one past the page, so a page that ends exactly at the root says
/// so.
#[tokio::test(flavor = "multi_thread")]
async fn history_pages_hold_at_most_fifty_and_know_when_more_follow() {
    let sc = HostedScenario::new();
    for index in 0..51 {
        git_in(
            &sc.work,
            &[
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                &format!("save {index}"),
            ],
        );
    }
    let head = git_in(&sc.work, &["rev-parse", "HEAD"]);
    let remote = sc.remote();
    git_in(
        &sc.work,
        &[
            "push",
            "-q",
            remote.to_str().unwrap(),
            "HEAD:refs/heads/main",
        ],
    );
    let served = serve(&sc).await;

    let page = get(&served, "/git/history?limit=500").await.json();
    assert_eq!(page["entries"].as_array().unwrap().len(), 50);
    assert_eq!(page["entries"][0]["commit"], head.as_str());
    assert_eq!(page["hasMore"], true);
    let exact = get(&served, "/git/history?limit=50&skip=1").await.json();
    assert_eq!(exact["entries"].as_array().unwrap().len(), 50);
    assert_eq!(exact["hasMore"], false);
    let last = get(&served, "/git/history?limit=50&skip=50").await.json();
    assert_eq!(last["entries"].as_array().unwrap().len(), 1);
    assert_eq!(last["entries"][0]["subject"], "save 0");
    assert_eq!(last["entries"][0]["parentCount"], 0);
    assert_eq!(last["hasMore"], false);
    let past = get(&served, "/git/history?skip=51").await.json();
    assert_eq!(past["entries"], serde_json::json!([]));
    assert_eq!(past["hasMore"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn review_and_diff_read_objects_only() {
    let sc = HostedScenario::new();
    let first = sc.push(
        &[
            ("README.md", Some(b"one\n")),
            ("old.md", Some(b"old name\nsame\nlines\n")),
            ("tmp/cache.txt", Some(b"x\n")),
        ],
        "first",
    );
    let second = sc.push(
        &[
            ("README.md", Some(b"two\n")),
            ("old.md", None),
            ("new.md", Some(b"old name\nsame\nlines\n")),
        ],
        "second",
    );
    let third = sc.push(&[("other.md", Some(b"other\n"))], "third");
    let served = serve(&sc).await;

    let review = get(&served, &format!("/git/history/review?commit={second}")).await;
    assert_eq!(review.status, 200);
    let body = review.json();
    assert_eq!(body["commit"], second.as_str());
    assert_eq!(body["parentCount"], 1);
    let changed: Vec<(&str, &str)> = body["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| {
            (
                entry["path"].as_str().unwrap(),
                entry["code"].as_str().unwrap(),
            )
        })
        .collect();
    assert_eq!(changed, vec![("README.md", "M"), ("new.md", "R")]);
    // The root commit lists everything it added, except sync-reserved paths.
    let root = get(&served, &format!("/git/history/review?commit={first}"))
        .await
        .json();
    assert_eq!(root["parentCount"], 0);
    let added: Vec<&str> = root["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["path"].as_str().unwrap())
        .collect();
    assert_eq!(added, vec!["README.md", "old.md"]);
    let missing = get(&served, "/git/history/review").await.json();
    assert_eq!(missing["error"], "missing commit");

    let diff = get(
        &served,
        &format!("/git/diff?path=README.md&commit={second}"),
    )
    .await;
    let text = diff.json()["diff"].as_str().unwrap().to_string();
    assert!(text.contains("-one") && text.contains("+two"), "{text}");
    let between = get(
        &served,
        &format!("/git/diff?path=README.md&base={first}&commit={third}"),
    )
    .await
    .json();
    assert!(between["diff"].as_str().unwrap().contains("+two"));
    // Neither: the last change of the path on main.
    let last = get(&served, "/git/diff?path=README.md").await.json();
    assert!(last["diff"].as_str().unwrap().contains("+two"));
    // A root commit diffs against the empty tree.
    let root_diff = get(&served, &format!("/git/diff?path=README.md&commit={first}")).await;
    assert!(root_diff.json()["diff"].as_str().unwrap().contains("+one"));
    let reserved = get(&served, "/git/diff?path=.instafy/x").await;
    assert_eq!(reserved.status, 404);

    // A commit this space does not have (a turn whose save failed, a commit
    // only an earlier gateway's working copy held) is answered in the
    // usual shape with an error: clients read any 404 here as "no version
    // tracking in this space".
    let gone = "0123456789abcdef0123456789abcdef01234567";
    let unknown = get(&served, &format!("/git/diff?path=README.md&commit={gone}")).await;
    assert_eq!(unknown.status, 200, "{}", unknown.json());
    let body = unknown.json();
    assert_eq!(
        (
            body["supported"].clone(),
            body["diff"].clone(),
            body["code"].clone(),
            body["commit"].clone()
        ),
        (
            serde_json::json!(true),
            serde_json::json!(""),
            serde_json::json!("rev_not_found"),
            serde_json::json!(gone)
        )
    );
    assert!(body["error"].is_string());
    let unknown = get(&served, &format!("/git/history/review?commit={gone}")).await;
    assert_eq!(unknown.status, 200, "{}", unknown.json());
    let body = unknown.json();
    assert_eq!(body["supported"], true);
    assert_eq!(body["entries"], serde_json::json!([]));
    assert_eq!(body["code"], "rev_not_found");
    assert!(body["error"].is_string());
    // An unknown base: the commit's own change instead.
    let fallback = get(
        &served,
        &format!("/git/diff?path=README.md&base={gone}&commit={second}"),
    )
    .await;
    assert_eq!(fallback.status, 200, "{}", fallback.json());
    let text = fallback.json()["diff"].as_str().unwrap().to_string();
    assert!(text.contains("-one") && text.contains("+two"), "{text}");
    assert!(fallback.json().get("code").is_none());
    // Malformed ids are still refused.
    let bad = get(&served, "/git/diff?path=README.md&commit=not-a-commit").await;
    assert_eq!(bad.status, 400);
}

/// A chat card asks for the diff of every file of a turn: when the space
/// does not have that commit (or base), the first ask fetches canonical
/// once and the answer is remembered for a short while, so the rest of
/// the card does not fetch again per file. Known commits never fetch.
#[tokio::test(flavor = "multi_thread")]
async fn a_card_of_an_unknown_version_fetches_once_not_per_file() {
    let sc = HostedScenario::new();
    let first = sc.push(&[("a.txt", Some(b"a\n")), ("b.txt", Some(b"b\n"))], "first");
    let second = sc.push(
        &[("a.txt", Some(b"a2\n")), ("b.txt", Some(b"b2\n"))],
        "second",
    );
    let served = serve(&sc).await;
    get(&served, "/entries").await;
    let gone = "0123456789abcdef0123456789abcdef01234567";

    let before = served.cache.fetches_started();
    for path in ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"] {
        let answer = get(&served, &format!("/git/diff?path={path}&commit={gone}")).await;
        assert_eq!(answer.json()["code"], "rev_not_found");
    }
    let review = get(&served, &format!("/git/history/review?commit={gone}")).await;
    assert_eq!(review.json()["code"], "rev_not_found");
    assert_eq!(served.cache.fetches_started() - before, 1);

    let before = served.cache.fetches_started();
    for path in ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"] {
        let answer = get(
            &served,
            &format!("/git/diff?path={path}&commit={second}&base={gone}"),
        )
        .await;
        assert_eq!(answer.status, 200, "{}", answer.json());
        assert!(answer.json()["code"].is_null(), "{}", answer.json());
    }
    assert_eq!(served.cache.fetches_started() - before, 0);

    let before = served.cache.fetches_started();
    for path in ["a.txt", "b.txt"] {
        let answer = get(
            &served,
            &format!("/git/diff?path={path}&commit={second}&base={first}"),
        )
        .await;
        assert!(answer.json()["diff"].as_str().unwrap().contains("+a2") || path == "b.txt");
    }
    assert_eq!(served.cache.fetches_started() - before, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn unsaved_work_is_reviewed_through_its_ref() {
    let sc = HostedScenario::new();
    let head = sc.push(&[("README.md", Some(b"saved\n"))], "saved");
    let unsaved = sc.side_commit(&[("README.md", b"unsaved\n")], "unsaved");
    let reference = format!("refs/instafy/recovery/{}/unsaved-1", Uuid::new_v4());
    sc.push_ref(&unsaved, &reference);
    let served = serve(&sc).await;

    let diff = get(
        &served,
        &format!("/git/diff?path=README.md&commit={unsaved}&base={head}&ref={reference}"),
    )
    .await;
    assert_eq!(diff.status, 200, "{}", String::from_utf8_lossy(&diff.body));
    let text = diff.json()["diff"].as_str().unwrap().to_string();
    assert!(
        text.contains("-saved") && text.contains("+unsaved"),
        "{text}"
    );
    let review = get(
        &served,
        &format!("/git/history/review?commit={unsaved}&ref={reference}"),
    )
    .await;
    assert_eq!(review.json()["entries"][0]["path"], "README.md");

    // The ref moved since the client listed it.
    let moved = get(
        &served,
        &format!("/git/diff?path=README.md&commit={head}&ref={reference}"),
    )
    .await;
    assert_eq!(
        (moved.status, moved.code().as_str()),
        (409, "recovery_ref_moved")
    );
    assert_eq!(moved.json()["rev"], unsaved.as_str());

    // The ref is gone (dismissed meanwhile): the usual shape with an error.
    git_in(&sc.remote(), &["update-ref", "-d", &reference]);
    for route in [
        format!("/git/history/review?commit={unsaved}&ref={reference}"),
        format!("/git/diff?path=README.md&commit={unsaved}&ref={reference}"),
    ] {
        let answer = get(&served, &route).await;
        assert_eq!(answer.status, 200, "{route}: {}", answer.json());
        assert_eq!(answer.json()["code"], "rev_not_found", "{route}");
        assert_eq!(answer.json()["supported"], true, "{route}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn the_recovery_list_marks_work_the_gateway_restored() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"saved\n"))], "saved");
    let origin = Uuid::new_v4();
    let conflict = sc.side_commit(
        &[("README.md", b"theirs\n")],
        "conflicting work\n\nInstafy-Recovery-Kind: conflict\nInstafy-Conflict: README.md",
    );
    let conflict_ref = format!("refs/instafy/recovery/{origin}/conflict-1");
    sc.push_ref(&conflict, &conflict_ref);
    let salvaged = sc.side_commit(
        &[("draft.md", b"draft\n")],
        "kept\n\nInstafy-Recovery-Kind: salvage\nInstafy-Path: draft.md",
    );
    let salvage_ref = "refs/instafy/salvage/gateway/node-1-0123abcd";
    sc.push_ref(&salvaged, salvage_ref);
    // The gateway restored the salvage ref; agents forged a restore of the
    // conflict ref, one under the address hosted runtimes commit under by
    // default (a runtime save keeps its committer when it lands on main).
    let restore = sc.push_as(
        &sc.config.git_author_name,
        &sc.config.git_author_email,
        &format!("Restore unsaved work\n\nInstafy-Restored-From: {salvage_ref}"),
    );
    for forger in [
        "agent@instafy.dev",
        crate::config::DEFAULT_ORIGIN_AUTHOR_EMAIL,
    ] {
        sc.push_as(
            "instafy-origin",
            forger,
            &format!("Restore unsaved work\n\nInstafy-Restored-From: {conflict_ref}"),
        );
    }
    let served = serve(&sc).await;

    let answer = get(&served, "/git/recovery").await;
    assert_eq!(
        answer.status,
        200,
        "{}",
        String::from_utf8_lossy(&answer.body)
    );
    let body = answer.json();
    assert_eq!(body["supported"], true);
    let entries = body["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    let by_ref = |name: &str| {
        entries
            .iter()
            .find(|entry| entry["ref"] == name)
            .unwrap_or_else(|| panic!("{name} listed"))
            .clone()
    };
    let salvage = by_ref(salvage_ref);
    assert_eq!(salvage["kind"], "salvage");
    assert_eq!(salvage["dismissible"], false);
    assert_eq!(salvage["restoredRev"], restore.as_str());
    assert_eq!(salvage["paths"], serde_json::json!(["draft.md"]));
    let conflict_item = by_ref(&conflict_ref);
    assert_eq!(conflict_item["kind"], "conflict");
    assert_eq!(conflict_item["dismissible"], true);
    assert_eq!(conflict_item["paths"], serde_json::json!(["README.md"]));
    assert_eq!(conflict_item["origin"], origin.to_string());
    assert!(
        conflict_item.get("restoredRev").is_none(),
        "only the gateway's own commits count"
    );
    assert!(conflict_item["base"].is_string());

    // No refs at all.
    let empty = HostedScenario::new();
    empty.push(&[("README.md", Some(b"x\n"))], "x");
    let served = serve(&empty).await;
    let answer = get(&served, "/git/recovery").await.json();
    assert_eq!(answer["entries"], serde_json::json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn sync_confirms_a_commit_on_main_and_saves_nothing() {
    let sc = HostedScenario::new();
    let first = sc.push(&[("README.md", Some(b"one\n"))], "first");
    let served = serve(&sc).await;
    let second = sc.push(&[("README.md", Some(b"two\n"))], "second");

    // A write always sees canonical as it is now.
    let answer = post(
        &served,
        "/git/sync",
        serde_json::json!({ "expectedRev": first }),
    )
    .await;
    assert_eq!(answer.status, 200);
    assert_eq!(answer.json()["rev"], second.as_str());
    assert_eq!(answer.json()["baseRev"], second.as_str());

    let unsaved = sc.side_commit(&[("README.md", b"elsewhere\n")], "not on main");
    let answer = post(
        &served,
        "/git/sync",
        serde_json::json!({ "expectedRev": unsaved }),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (409, "rev_not_on_main")
    );
    assert_eq!(answer.json()["head"], second.as_str());

    let answer = post(
        &served,
        "/git/sync",
        serde_json::json!({ "message": "instafy: sync", "paths": ["README.md"] }),
    )
    .await;
    assert_eq!(answer.status, 200);
    assert_eq!(answer.json()["committed"], false);
    assert_eq!(answer.json()["rev"], second.as_str());
    assert_eq!(sc.canonical_main(), Some(second));

    let answer = post(
        &served,
        "/git/sync",
        serde_json::json!({ "mode": "refresh" }),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (400, "not_supported")
    );
    let answer = post(
        &served,
        "/git/sync",
        serde_json::json!({ "expectedRev": "abc" }),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (400, "invalid_rev")
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn working_copy_routes_are_refused() {
    let sc = HostedScenario::new();
    sc.push(&[("README.md", Some(b"one\n"))], "first");
    let served = serve(&sc).await;
    let answer = post(
        &served,
        "/git/revert",
        serde_json::json!({ "paths": ["README.md"] }),
    )
    .await;
    assert_eq!(
        (answer.status, answer.code().as_str()),
        (400, "not_supported")
    );
    for route in ["/git/flush", "/git/flush/resume"] {
        let answer = post(&served, route, serde_json::json!({})).await;
        assert_eq!(answer.status, 404, "{route}");
    }
    assert_eq!(get(&served, "/browser/capabilities").await.status, 404);
    assert_eq!(
        sc.canonical_main(),
        Some(git_in(&sc.work, &["rev-parse", "HEAD"]))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn deleting_the_cache_between_reads_changes_nothing() {
    let sc = HostedScenario::new();
    let first = sc.push(
        &[("README.md", Some(b"one\n")), ("a/b.txt", Some(b"b\n"))],
        "first",
    );
    sc.push(&[("README.md", Some(b"two\n"))], "second");
    let served = serve(&sc).await;
    let reads = [
        "/entries".to_string(),
        "/entries?path=a".to_string(),
        "/files/README.md".to_string(),
        format!("/files/README.md?rev={first}"),
        "/git/history?limit=5".to_string(),
        "/git/diff?path=README.md".to_string(),
        format!("/git/history/review?commit={first}"),
    ];
    let mut before = Vec::new();
    for read in &reads {
        let answer = get(&served, read).await;
        assert_eq!(answer.status, 200, "{read}");
        before.push((answer.body.clone(), answer.rev()));
    }
    std::fs::remove_dir_all(sc.root.join(".git-cache")).unwrap();
    std::fs::create_dir(sc.root.join(".git-cache")).unwrap();
    // Past the two-second window, so the reads fetch again.
    tokio::time::sleep(Duration::from_millis(2100)).await;
    for (read, expected) in reads.iter().zip(before) {
        let answer = get(&served, read).await;
        assert_eq!(answer.status, 200, "{read}");
        assert_eq!((answer.body.clone(), answer.rev()), expected, "{read}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn every_route_but_health_needs_a_token() {
    let mut sc = HostedScenario::new();
    sc.config.skip_auth = false;
    sc.push(&[("README.md", Some(b"one\n"))], "first");
    let served = serve(&sc).await;
    assert_eq!(get(&served, "/healthz").await.status, 200);
    for route in [
        "/entries",
        "/files/README.md",
        "/raw/README.md?token=not-a-token",
        "/git/status",
        "/git/history",
        "/git/history/review?commit=x",
        "/git/diff?path=README.md",
        "/git/recovery",
    ] {
        assert_eq!(get(&served, route).await.status, 401, "{route}");
    }
    for route in [
        "/apply-json",
        "/apply/status",
        "/git/sync",
        "/git/revert",
        "/git/revert-commit",
        "/git/recovery/restore",
        "/git/recovery/dismiss",
    ] {
        let answer = post(&served, route, serde_json::json!({})).await;
        assert_eq!(answer.status, 401, "{route}");
    }
    assert_eq!(served.cache.fetches_started(), 0);
    assert!(!sc.mirror().exists());
}
