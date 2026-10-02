//! Eviction of hosted workspace checkouts from a node's disk.
//!
//! A hosted runtime's checkout is a bind mount, `<repo base>/<project id>`,
//! that outlives the runtime's containers. Canonical `main` and this space's
//! recovery refs are the durable copy of its work, so a checkout nobody has
//! used for a while can be deleted and is cloned again on the next start.
//!
//! A checkout is evicted only when all of these hold:
//! - it was last used (started or stopped here) at least the idle TTL ago
//!   (7 days by default), or the node's checkouts exceed their disk budget and
//!   it has been idle for at least an hour, oldest first;
//! - no runtime container of the project exists on this node, running or
//!   stopped, and no start is in progress for it;
//! - it is a canonical checkout (`.instafy/.git` with a remote) holding no
//!   `refs/instafy/local-recovery/*` ref: that is work no publish has pushed
//!   yet, which the next start pushes. Such a checkout is kept and logged,
//!   and a later sweep evicts it once the refs are gone.
//!
//! Stopping a runtime never evicts anything; it only marks the checkout as
//! used. Refs are read from the files git keeps them in (loose refs and
//! `packed-refs`), without running git: the provider image has no git, and
//! the repository's config is written by the workspace. Anything this code
//! cannot read with certainty (another ref storage, a linked git dir, no
//! remote) keeps the checkout.

use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use tracing::{info, warn};
use uuid::Uuid;

/// Where each checkout's last use is recorded, next to the checkouts (never
/// inside one: a checkout is the workspace itself).
pub(crate) const STAMP_DIR: &str = ".instafy-checkout-stamps";
/// Where an evicted checkout is moved before it is deleted, so a half-deleted
/// tree is never mistaken for a checkout.
pub(crate) const TRASH_DIR: &str = ".instafy-evicted";
/// The local recovery refs that have not been pushed yet.
const LOCAL_RECOVERY_DIR: &str = "refs/instafy/local-recovery";
const LOCAL_RECOVERY_PREFIX: &str = "refs/instafy/local-recovery/";
/// Bounds for reading refs and measuring checkouts.
const MAX_REF_ENTRIES: usize = 10_000;
const MAX_REF_DEPTH: usize = 16;
const MAX_PACKED_REFS_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_SIZE_ENTRIES: usize = 2_000_000;

/// When stopped checkouts are evicted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckoutEvictionPolicy {
    /// Evict checkouts idle this long; `None` turns idle eviction off.
    pub idle_ttl: Option<Duration>,
    /// Evict the oldest idle checkouts while all of them together are larger
    /// than this; `None` turns budget eviction off.
    pub disk_budget_bytes: Option<u64>,
    /// Never evict for the budget a checkout used more recently than this.
    pub min_idle_for_budget: Duration,
}

impl Default for CheckoutEvictionPolicy {
    fn default() -> Self {
        Self {
            idle_ttl: Some(Duration::from_secs(7 * 24 * 60 * 60)),
            disk_budget_bytes: None,
            min_idle_for_budget: Duration::from_secs(60 * 60),
        }
    }
}

impl CheckoutEvictionPolicy {
    pub fn is_enabled(&self) -> bool {
        self.idle_ttl.is_some() || self.disk_budget_bytes.is_some()
    }
}

/// What one sweep did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CheckoutSweepReport {
    /// Evicted checkouts and why (`idle` or `disk_budget`).
    pub evicted: Vec<(Uuid, &'static str)>,
    /// Checkouts kept because they hold work that is not pushed yet.
    pub kept_unpushed: Vec<Uuid>,
    /// Checkouts kept for another reason that blocks eviction.
    pub kept: Vec<(Uuid, String)>,
}

/// What the sweep needs from the node.
pub(crate) trait CheckoutHost {
    type Claim;
    /// Hold `project_id`'s checkout against a concurrent start. `None` while
    /// a start (or another sweep) holds it.
    fn claim(&self, project_id: Uuid) -> Option<Self::Claim>;
    /// Whether any runtime container of the project exists on this node,
    /// running or stopped.
    fn runtime_present(&self, project_id: Uuid) -> anyhow::Result<bool>;
}

/// Record that `project_id`'s checkout was just used (a start or a stop).
pub(crate) fn touch_checkout(repo_base: &Path, project_id: Uuid) {
    let stamps = repo_base.join(STAMP_DIR);
    if let Err(error) = fs::create_dir_all(&stamps)
        .and_then(|_| fs::write(stamps.join(project_id.to_string()), b""))
    {
        warn!(%project_id, %error, "could not record when the checkout was last used");
    }
}

/// The `refs/instafy/local-recovery/*` refs of a checkout, read from disk.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PendingRecovery {
    None,
    Refs(Vec<String>),
    /// The refs cannot be read with certainty; the checkout is kept.
    Unknown(String),
}

pub(crate) fn pending_local_recovery(checkout: &Path) -> PendingRecovery {
    let git_dir = checkout.join(".instafy").join(".git");
    match fs::symlink_metadata(&git_dir) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return PendingRecovery::Unknown("the git directory is not a directory".into()),
        Err(error) if error.kind() == ErrorKind::NotFound => {
            // No canonical repository: the files exist only on this node.
            return PendingRecovery::Unknown("no canonical repository".into());
        }
        Err(error) => return PendingRecovery::Unknown(format!("git directory: {error}")),
    }
    if fs::symlink_metadata(git_dir.join("reftable")).is_ok() {
        return PendingRecovery::Unknown("reftable ref storage".into());
    }
    let config = match read_bounded(&git_dir.join("config"), MAX_CONFIG_BYTES) {
        Ok(Some(config)) => String::from_utf8_lossy(&config).to_ascii_lowercase(),
        Ok(None) => return PendingRecovery::Unknown("no repository config".into()),
        Err(error) => return PendingRecovery::Unknown(format!("repository config: {error}")),
    };
    if config.contains("refstorage") {
        return PendingRecovery::Unknown("another ref storage".into());
    }
    if !config
        .lines()
        .any(|line| line.trim_start().starts_with("[remote "))
    {
        // Nothing canonical to clone back from.
        return PendingRecovery::Unknown("no canonical remote".into());
    }

    let mut refs = Vec::new();
    if let Err(reason) = loose_refs(&git_dir.join(LOCAL_RECOVERY_DIR), &mut refs) {
        return PendingRecovery::Unknown(reason);
    }
    match read_bounded(&git_dir.join("packed-refs"), MAX_PACKED_REFS_BYTES) {
        Ok(Some(packed)) => {
            for line in String::from_utf8_lossy(&packed).lines() {
                if line.starts_with('#') || line.starts_with('^') {
                    continue;
                }
                if let Some((_, name)) = line.split_once(' ') {
                    if name.starts_with(LOCAL_RECOVERY_PREFIX) {
                        refs.push(name.trim().to_string());
                    }
                }
            }
        }
        Ok(None) => {}
        Err(error) => return PendingRecovery::Unknown(format!("packed-refs: {error}")),
    }
    refs.sort();
    refs.dedup();
    if refs.is_empty() {
        PendingRecovery::None
    } else {
        PendingRecovery::Refs(refs)
    }
}

fn loose_refs(root: &Path, refs: &mut Vec<String>) -> Result<(), String> {
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    let mut seen = 0usize;
    while let Some((dir, depth)) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("local recovery refs: {error}")),
        };
        for entry in entries {
            let entry = entry.map_err(|error| format!("local recovery refs: {error}"))?;
            seen += 1;
            if seen > MAX_REF_ENTRIES {
                return Err("too many local recovery refs to read".into());
            }
            let file_type = entry
                .file_type()
                .map_err(|error| format!("local recovery refs: {error}"))?;
            let path = entry.path();
            if file_type.is_dir() {
                if depth >= MAX_REF_DEPTH {
                    return Err("local recovery refs nest too deeply".into());
                }
                stack.push((path, depth + 1));
                continue;
            }
            // A file, or anything else (a link): either way something is
            // there, and it counts as unpushed work.
            let relative = path
                .strip_prefix(root)
                .map(|relative| relative.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            refs.push(format!("{LOCAL_RECOVERY_PREFIX}{relative}"));
        }
    }
    Ok(())
}

fn read_bounded(path: &Path, limit: u64) -> std::io::Result<Option<Vec<u8>>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    if !metadata.is_file() {
        return Err(std::io::Error::other("not a regular file"));
    }
    if metadata.len() > limit {
        return Err(std::io::Error::other("too large to read"));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    Ok(Some(bytes))
}

/// Total size of the files under `root`, without following links. Stops
/// counting (and returns what it counted) after a bounded number of entries.
fn tree_size(root: &Path) -> u64 {
    let mut total = 0u64;
    let mut seen = 0usize;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            seen += 1;
            if seen > MAX_SIZE_ENTRIES {
                return total;
            }
            let Ok(metadata) = fs::symlink_metadata(entry.path()) else {
                continue;
            };
            if metadata.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(metadata.len());
            }
        }
    }
    total
}

struct Candidate {
    project_id: Uuid,
    path: PathBuf,
    last_used: SystemTime,
}

/// Evict the checkouts under `repo_base` that `policy` allows (see the
/// module docs). Blocking; run it off the async runtime.
pub(crate) fn sweep_checkouts<H: CheckoutHost>(
    repo_base: &Path,
    policy: &CheckoutEvictionPolicy,
    now: SystemTime,
    host: &H,
) -> CheckoutSweepReport {
    let mut report = CheckoutSweepReport::default();
    if !policy.is_enabled() {
        return report;
    }
    let trash = repo_base.join(TRASH_DIR);
    if let Ok(entries) = fs::read_dir(&trash) {
        for entry in entries.flatten() {
            let _ = fs::remove_dir_all(entry.path());
        }
    }

    let stamps = repo_base.join(STAMP_DIR);
    let Ok(entries) = fs::read_dir(repo_base) else {
        return report;
    };
    let mut candidates = Vec::new();
    for entry in entries.flatten() {
        let Some(project_id) = entry
            .file_name()
            .to_str()
            .and_then(|name| Uuid::parse_str(name).ok())
        else {
            continue;
        };
        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let stamp = stamps.join(project_id.to_string());
        match fs::metadata(&stamp).and_then(|metadata| metadata.modified()) {
            Ok(last_used) => candidates.push(Candidate {
                project_id,
                path: entry.path(),
                last_used,
            }),
            Err(_) => {
                // First sight of a checkout made before stamps existed:
                // start its clock now rather than evicting it at once.
                touch_checkout(repo_base, project_id);
            }
        }
    }
    candidates.sort_by_key(|candidate| candidate.last_used);

    let sizes: HashMap<Uuid, u64> = if policy.disk_budget_bytes.is_some() {
        candidates
            .iter()
            .map(|candidate| (candidate.project_id, tree_size(&candidate.path)))
            .collect()
    } else {
        HashMap::new()
    };
    let mut total: u64 = sizes.values().sum();

    for candidate in candidates {
        let idle = now
            .duration_since(candidate.last_used)
            .unwrap_or(Duration::ZERO);
        let reason = if policy.idle_ttl.is_some_and(|ttl| idle >= ttl) {
            "idle"
        } else if policy
            .disk_budget_bytes
            .is_some_and(|budget| total > budget)
            && idle >= policy.min_idle_for_budget
        {
            "disk_budget"
        } else {
            continue;
        };
        let project_id = candidate.project_id;
        let Some(_claim) = host.claim(project_id) else {
            report
                .kept
                .push((project_id, "a start is in progress".into()));
            continue;
        };
        match host.runtime_present(project_id) {
            Ok(false) => {}
            Ok(true) => {
                report
                    .kept
                    .push((project_id, "a runtime exists here".into()));
                continue;
            }
            Err(error) => {
                warn!(%project_id, %error, "could not tell whether a runtime uses the checkout; keeping it");
                report
                    .kept
                    .push((project_id, format!("runtime check failed: {error}")));
                continue;
            }
        }
        match pending_local_recovery(&candidate.path) {
            PendingRecovery::None => {}
            PendingRecovery::Refs(refs) => {
                warn!(
                    %project_id,
                    refs = ?refs,
                    "keeping a stopped checkout: it holds work that is not pushed yet; the next start pushes it"
                );
                report.kept_unpushed.push(project_id);
                continue;
            }
            PendingRecovery::Unknown(why) => {
                warn!(%project_id, reason = %why, "keeping a stopped checkout whose saved state cannot be confirmed");
                report.kept.push((project_id, why));
                continue;
            }
        }

        if let Err(error) = fs::create_dir_all(&trash) {
            warn!(%project_id, %error, "could not prepare checkout eviction");
            report
                .kept
                .push((project_id, format!("eviction failed: {error}")));
            continue;
        }
        let parked = trash.join(format!(
            "{project_id}-{}",
            now.duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        if let Err(error) = fs::rename(&candidate.path, &parked) {
            warn!(%project_id, %error, "could not evict the checkout");
            report
                .kept
                .push((project_id, format!("eviction failed: {error}")));
            continue;
        }
        let _ = fs::remove_file(stamps.join(project_id.to_string()));
        if let Err(error) = fs::remove_dir_all(&parked) {
            warn!(%project_id, %error, "evicted checkout was not fully deleted; the next sweep retries");
        }
        total = total.saturating_sub(sizes.get(&project_id).copied().unwrap_or(0));
        info!(%project_id, reason, idle_secs = idle.as_secs(), "evicted a stopped workspace checkout");
        report.evicted.push((project_id, reason));
    }
    report
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::collections::HashSet;
    use std::fs::FileTimes;

    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("checkout-eviction-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[derive(Default)]
    struct FakeHost {
        present: HashSet<Uuid>,
        busy: HashSet<Uuid>,
        claims: RefCell<Vec<Uuid>>,
    }

    impl CheckoutHost for FakeHost {
        type Claim = ();
        fn claim(&self, project_id: Uuid) -> Option<()> {
            self.claims.borrow_mut().push(project_id);
            (!self.busy.contains(&project_id)).then_some(())
        }
        fn runtime_present(&self, project_id: Uuid) -> anyhow::Result<bool> {
            Ok(self.present.contains(&project_id))
        }
    }

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    /// A canonical checkout with a remote and one file of `bytes` bytes,
    /// last used `idle` ago.
    fn checkout(base: &Path, now: SystemTime, idle: Duration, bytes: usize) -> Uuid {
        let project_id = Uuid::new_v4();
        let root = base.join(project_id.to_string());
        let git_dir = root.join(".instafy/.git");
        fs::create_dir_all(git_dir.join("refs/heads")).unwrap();
        fs::write(
            git_dir.join("config"),
            "[core]\n\tbare = false\n[remote \"origin\"]\n\turl = https://git.example/p.git\n",
        )
        .unwrap();
        fs::write(root.join("file.bin"), vec![7u8; bytes]).unwrap();
        touch_checkout(base, project_id);
        let stamp = fs::File::options()
            .write(true)
            .open(base.join(STAMP_DIR).join(project_id.to_string()))
            .unwrap();
        stamp
            .set_times(FileTimes::new().set_modified(now - idle))
            .unwrap();
        project_id
    }

    fn exists(base: &Path, project_id: Uuid) -> bool {
        base.join(project_id.to_string()).exists()
    }

    #[test]
    fn idle_checkouts_are_evicted_after_the_ttl_and_recent_ones_kept() {
        let base = TempDir::new();
        let now = SystemTime::now();
        let old = checkout(&base.0, now, 8 * DAY, 10);
        let recent = checkout(&base.0, now, 6 * DAY, 10);
        let report = sweep_checkouts(
            &base.0,
            &CheckoutEvictionPolicy::default(),
            now,
            &FakeHost::default(),
        );
        assert_eq!(report.evicted, vec![(old, "idle")]);
        assert!(!exists(&base.0, old));
        assert!(exists(&base.0, recent));
        assert!(!base.0.join(STAMP_DIR).join(old.to_string()).exists());
        assert!(
            fs::read_dir(base.0.join(TRASH_DIR))
                .unwrap()
                .next()
                .is_none(),
            "the evicted tree is deleted"
        );
    }

    #[test]
    fn checkouts_holding_unpushed_recovery_refs_are_kept_and_logged() {
        let base = TempDir::new();
        let now = SystemTime::now();
        let loose = checkout(&base.0, now, 30 * DAY, 10);
        let git_dir = base.0.join(loose.to_string()).join(".instafy/.git");
        fs::create_dir_all(git_dir.join("refs/instafy/local-recovery")).unwrap();
        fs::write(
            git_dir.join("refs/instafy/local-recovery/20261002T101010Z-unsaved-abc"),
            "0123456789012345678901234567890123456789\n",
        )
        .unwrap();
        let packed = checkout(&base.0, now, 30 * DAY, 10);
        fs::write(
            base.0.join(packed.to_string()).join(".instafy/.git/packed-refs"),
            "# pack-refs with: peeled fully-peeled sorted\n\
             0123456789012345678901234567890123456789 refs/heads/main\n\
             0123456789012345678901234567890123456789 refs/instafy/local-recovery/20261001T000000Z-conflict-def\n",
        )
        .unwrap();
        // Markers of refs already pushed (or dismissed) do not hold a checkout.
        let pushed = checkout(&base.0, now, 30 * DAY, 10);
        let pushed_git = base.0.join(pushed.to_string()).join(".instafy/.git");
        fs::create_dir_all(pushed_git.join("refs/instafy/local-recovery-pushed")).unwrap();
        fs::write(
            pushed_git.join("refs/instafy/local-recovery-pushed/x"),
            "0123456789012345678901234567890123456789\n",
        )
        .unwrap();
        fs::create_dir_all(pushed_git.join("refs/instafy/local-recovery")).unwrap();

        let report = sweep_checkouts(
            &base.0,
            &CheckoutEvictionPolicy::default(),
            now,
            &FakeHost::default(),
        );
        let mut kept = report.kept_unpushed.clone();
        kept.sort();
        let mut expected = vec![loose, packed];
        expected.sort();
        assert_eq!(kept, expected);
        assert_eq!(report.evicted, vec![(pushed, "idle")]);
        assert!(exists(&base.0, loose) && exists(&base.0, packed));

        // Once the next start has pushed them, a later sweep evicts.
        fs::remove_file(git_dir.join("refs/instafy/local-recovery/20261002T101010Z-unsaved-abc"))
            .unwrap();
        let report = sweep_checkouts(
            &base.0,
            &CheckoutEvictionPolicy::default(),
            now,
            &FakeHost::default(),
        );
        assert_eq!(report.evicted, vec![(loose, "idle")]);
    }

    #[test]
    fn the_disk_budget_evicts_the_oldest_idle_checkouts_first() {
        let base = TempDir::new();
        let now = SystemTime::now();
        let oldest = checkout(&base.0, now, 3 * DAY, 400);
        let older = checkout(&base.0, now, 2 * DAY, 400);
        let newest = checkout(&base.0, now, DAY, 400);
        let just_used = checkout(&base.0, now, Duration::from_secs(60), 400);
        let policy = CheckoutEvictionPolicy {
            idle_ttl: None,
            disk_budget_bytes: Some(1000),
            min_idle_for_budget: Duration::from_secs(60 * 60),
        };
        let report = sweep_checkouts(&base.0, &policy, now, &FakeHost::default());
        // Four checkouts of a little over 400 bytes against 1000: the two
        // oldest go, which brings the rest under budget.
        assert_eq!(
            report.evicted,
            vec![(oldest, "disk_budget"), (older, "disk_budget")]
        );
        assert!(exists(&base.0, newest) && exists(&base.0, just_used));

        // Over budget, but a checkout used minutes ago is never evicted.
        let tight = CheckoutEvictionPolicy {
            disk_budget_bytes: Some(1),
            ..policy
        };
        let report = sweep_checkouts(&base.0, &tight, now, &FakeHost::default());
        assert_eq!(report.evicted, vec![(newest, "disk_budget")]);
        assert!(exists(&base.0, just_used));
    }

    #[test]
    fn running_starting_and_unsaved_checkouts_are_never_evicted() {
        let base = TempDir::new();
        let now = SystemTime::now();
        let running = checkout(&base.0, now, 30 * DAY, 10);
        let starting = checkout(&base.0, now, 30 * DAY, 10);
        let no_remote = checkout(&base.0, now, 30 * DAY, 10);
        fs::write(
            base.0
                .join(no_remote.to_string())
                .join(".instafy/.git/config"),
            "[core]\n\tbare = false\n",
        )
        .unwrap();
        let no_repo = checkout(&base.0, now, 30 * DAY, 10);
        fs::remove_dir_all(base.0.join(no_repo.to_string()).join(".instafy")).unwrap();
        let reftable = checkout(&base.0, now, 30 * DAY, 10);
        fs::create_dir_all(
            base.0
                .join(reftable.to_string())
                .join(".instafy/.git/reftable"),
        )
        .unwrap();
        let host = FakeHost {
            present: HashSet::from([running]),
            busy: HashSet::from([starting]),
            ..FakeHost::default()
        };

        let report = sweep_checkouts(&base.0, &CheckoutEvictionPolicy::default(), now, &host);
        assert!(report.evicted.is_empty(), "{report:?}");
        assert_eq!(report.kept.len(), 5, "{report:?}");
        for project_id in [running, starting, no_remote, no_repo, reftable] {
            assert!(exists(&base.0, project_id));
        }
    }

    #[test]
    fn a_checkout_seen_for_the_first_time_starts_its_clock() {
        let base = TempDir::new();
        let now = SystemTime::now();
        let project_id = checkout(&base.0, now, 30 * DAY, 10);
        fs::remove_file(base.0.join(STAMP_DIR).join(project_id.to_string())).unwrap();
        let report = sweep_checkouts(
            &base.0,
            &CheckoutEvictionPolicy::default(),
            now,
            &FakeHost::default(),
        );
        assert!(report.evicted.is_empty());
        assert!(exists(&base.0, project_id));
        assert!(base.0.join(STAMP_DIR).join(project_id.to_string()).exists());
        // Stamps and trash next to the checkouts are not checkouts.
        assert!(sweep_checkouts(
            &base.0,
            &CheckoutEvictionPolicy {
                idle_ttl: None,
                disk_budget_bytes: None,
                ..CheckoutEvictionPolicy::default()
            },
            now,
            &FakeHost::default()
        )
        .evicted
        .is_empty());
    }
}
