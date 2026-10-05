//! Gateway tests against real git: a bare canonical repository per space
//! (reached through a `file://` base URL), the gateway's own mirror cache,
//! and a plain clone standing in for the runtimes that push to canonical.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use uuid::Uuid;

use super::cache::{plan_eviction, Freshness, MirrorCache, MirrorStat, EVICT_IDLE_AFTER};
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
            git_author_email: "origin@instafy.dev".into(),
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
        self.sync_work();
        for (path, content) in files {
            let target = self.work.join(path);
            match content {
                Some(bytes) => {
                    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                    std::fs::write(&target, bytes).unwrap();
                    git_in(&self.work, &["add", "--", path]);
                }
                None => {
                    git_in(&self.work, &["rm", "-q", "--", path]);
                }
            }
        }
        self.commit_and_push(message)
    }

    fn sync_work(&self) {
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
    std::fs::rename(&moved, &sc.canonical).unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_mirror_that_is_not_a_folder_is_made_again() {
    let sc = HostedScenario::new();
    let cache = Arc::new(sc.open_cache());
    std::fs::write(sc.mirror(), b"not a repository").unwrap();
    let lease = cache.lease(sc.project);
    let dir = cache.ensure_mirror(&lease).unwrap();
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
