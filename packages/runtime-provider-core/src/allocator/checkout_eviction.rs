//! Eviction of hosted workspace checkouts from a node's disk.
//!
//! A hosted runtime's checkout is a bind mount, `<repo base>/<project id>`,
//! that outlives the runtime's containers. Canonical git is the durable copy
//! of its work, so a checkout nobody has used for a while can be deleted and
//! is cloned again on the next start.
//!
//! A checkout is evicted only when all of these hold:
//! - it was last used (started or stopped here) at least the idle TTL ago
//!   (7 days by default), or the node's checkouts exceed their disk budget and
//!   it has been idle for at least an hour, oldest first;
//! - no runtime container of the project exists on this node, running or
//!   stopped, and no start holds its claim;
//! - its durable-stop marker ([`CLEAN_STOP_MARKER`]) reads exactly
//!   [`DURABLE_MARKER`]. The origin's shutdown writes it only when nothing is
//!   left only on this node and canonical holds everything the folder held,
//!   and every origin start removes it. A checkout without it (a crash, a
//!   kill, a stop that could not save, a workspace without a canonical
//!   remote, which never gets one) or with anything else in it (a marker
//!   from before rolling saves says `stopped`) may hold work that exists
//!   nowhere else, and is kept until a later start and durable stop.
//!
//! Stopping a runtime never evicts anything; it only marks the checkout as
//! used, under the same per-project lock as a start, and the sweep reads the
//! last use again once it holds that lock. The sweep reads no git refs and
//! no repository config: the marker is the origin's own answer.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
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
/// Written by the origin's shutdown when the folder's final state is
/// durable, holding [`DURABLE_MARKER`], and removed by every origin start
/// (the origin server's `CLEAN_STOP_MARKER`).
pub(crate) const CLEAN_STOP_MARKER: &str = ".instafy/.git/instafy-stopped-clean";
/// What the marker holds after a durable stop (the origin server's
/// `working_state::DURABLE_MARKER`).
const DURABLE_MARKER: &[u8] = b"durable v1\n";
/// Bound for measuring checkouts.
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
    /// Checkouts kept because their last stop did not record a durable
    /// state: they may hold work that exists nowhere else.
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

/// Whether the runtime that last used `checkout` stopped durably: its marker
/// is a regular file that reads exactly [`DURABLE_MARKER`]. The workspace can
/// write that directory, so the read is bounded and follows no link.
fn stopped_durably(checkout: &Path) -> bool {
    let marker = checkout.join(CLEAN_STOP_MARKER);
    let expected = DURABLE_MARKER.len() as u64;
    if !fs::symlink_metadata(&marker)
        .is_ok_and(|metadata| metadata.is_file() && metadata.len() == expected)
    {
        return false;
    }
    let mut content = Vec::new();
    fs::File::open(&marker)
        .and_then(|file| file.take(expected + 1).read_to_end(&mut content))
        .is_ok_and(|_| content == DURABLE_MARKER)
}

fn last_used(repo_base: &Path, project_id: Uuid) -> Option<SystemTime> {
    fs::metadata(repo_base.join(STAMP_DIR).join(project_id.to_string()))
        .and_then(|metadata| metadata.modified())
        .ok()
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
        match last_used(repo_base, project_id) {
            Some(last_used) => candidates.push(Candidate {
                project_id,
                path: entry.path(),
                last_used,
            }),
            None => {
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

    let eligible = |idle: Duration, total: u64| -> Option<&'static str> {
        if policy.idle_ttl.is_some_and(|ttl| idle >= ttl) {
            Some("idle")
        } else if policy
            .disk_budget_bytes
            .is_some_and(|budget| total > budget)
            && idle >= policy.min_idle_for_budget
        {
            Some("disk_budget")
        } else {
            None
        }
    };
    for candidate in candidates {
        let idle = now
            .duration_since(candidate.last_used)
            .unwrap_or(Duration::ZERO);
        if eligible(idle, total).is_none() {
            continue;
        }
        let project_id = candidate.project_id;
        let Some(_claim) = host.claim(project_id) else {
            report
                .kept
                .push((project_id, "a start or stop is in progress".into()));
            continue;
        };
        // A start or stop may have used the checkout since the scan; it
        // records that under the lock this sweep now holds.
        let idle = last_used(repo_base, project_id)
            .map(|used| now.duration_since(used).unwrap_or(Duration::ZERO))
            .unwrap_or(Duration::ZERO);
        let Some(reason) = eligible(idle, total) else {
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
        if !stopped_durably(&candidate.path) {
            warn!(
                %project_id,
                "keeping a stopped checkout: its last stop did not record that canonical holds all of its work"
            );
            report.kept_unpushed.push(project_id);
            continue;
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
        /// A stop that finishes (and stamps the checkout) right before the
        /// sweep gets the lock.
        stopped_meanwhile: Option<(PathBuf, Uuid)>,
    }

    impl CheckoutHost for FakeHost {
        type Claim = ();
        fn claim(&self, project_id: Uuid) -> Option<()> {
            self.claims.borrow_mut().push(project_id);
            if let Some((base, stopped)) = &self.stopped_meanwhile {
                if *stopped == project_id {
                    touch_checkout(base, project_id);
                }
            }
            (!self.busy.contains(&project_id)).then_some(())
        }
        fn runtime_present(&self, project_id: Uuid) -> anyhow::Result<bool> {
            Ok(self.present.contains(&project_id))
        }
    }

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    /// A checkout whose last stop was durable, with one file of `bytes`
    /// bytes, last used `idle` ago.
    fn checkout(base: &Path, now: SystemTime, idle: Duration, bytes: usize) -> Uuid {
        let project_id = Uuid::new_v4();
        let root = base.join(project_id.to_string());
        fs::create_dir_all(root.join(".instafy/.git")).unwrap();
        fs::write(root.join("file.bin"), vec![7u8; bytes]).unwrap();
        fs::write(root.join(CLEAN_STOP_MARKER), DURABLE_MARKER).unwrap();
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

    fn marker(base: &Path, project_id: Uuid) -> PathBuf {
        base.join(project_id.to_string()).join(CLEAN_STOP_MARKER)
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

    /// Only a marker that reads exactly `durable v1` lets a checkout go: no
    /// marker (a crash, a kill, a stop that could not save, no remote), the
    /// `stopped` marker of an origin from before rolling saves, and anything
    /// else (other content, a directory, a link) keep it.
    #[test]
    fn only_a_durable_marker_lets_an_idle_checkout_go() {
        let base = TempDir::new();
        let now = SystemTime::now();
        let durable = checkout(&base.0, now, 30 * DAY, 10);
        let missing = checkout(&base.0, now, 30 * DAY, 10);
        fs::remove_file(marker(&base.0, missing)).unwrap();
        let mut kept = vec![missing];
        for content in [
            &b"stopped\n"[..],
            b"",
            b"durable v1",
            b"durable v2\n",
            b"durable v1\nstopped\n",
            b"DURABLE V1\n",
        ] {
            let project_id = checkout(&base.0, now, 30 * DAY, 10);
            fs::write(marker(&base.0, project_id), content).unwrap();
            kept.push(project_id);
        }
        let directory = checkout(&base.0, now, 30 * DAY, 10);
        fs::remove_file(marker(&base.0, directory)).unwrap();
        fs::create_dir_all(marker(&base.0, directory)).unwrap();
        kept.push(directory);
        #[cfg(unix)]
        {
            let linked = checkout(&base.0, now, 30 * DAY, 10);
            let elsewhere = base.0.join("elsewhere-marker");
            fs::write(&elsewhere, DURABLE_MARKER).unwrap();
            fs::remove_file(marker(&base.0, linked)).unwrap();
            std::os::unix::fs::symlink(&elsewhere, marker(&base.0, linked)).unwrap();
            kept.push(linked);
        }

        let report = sweep_checkouts(
            &base.0,
            &CheckoutEvictionPolicy::default(),
            now,
            &FakeHost::default(),
        );
        assert_eq!(report.evicted, vec![(durable, "idle")]);
        let mut kept_unpushed = report.kept_unpushed.clone();
        kept_unpushed.sort();
        kept.sort();
        assert_eq!(kept_unpushed, kept);
        for project_id in kept {
            assert!(exists(&base.0, project_id));
        }
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

    /// The budget follows the same rule: a checkout whose last stop was not
    /// durable is kept however far over budget the node is, and the next
    /// durable one goes instead.
    #[test]
    fn the_disk_budget_keeps_a_checkout_without_a_durable_stop() {
        let base = TempDir::new();
        let now = SystemTime::now();
        let pre_rolling_saves = checkout(&base.0, now, 3 * DAY, 400);
        fs::write(marker(&base.0, pre_rolling_saves), b"stopped\n").unwrap();
        let durable = checkout(&base.0, now, 2 * DAY, 400);
        let policy = CheckoutEvictionPolicy {
            idle_ttl: None,
            disk_budget_bytes: Some(1),
            min_idle_for_budget: Duration::from_secs(60 * 60),
        };
        let report = sweep_checkouts(&base.0, &policy, now, &FakeHost::default());
        assert_eq!(report.evicted, vec![(durable, "disk_budget")]);
        assert_eq!(report.kept_unpushed, vec![pre_rolling_saves]);
        assert!(exists(&base.0, pre_rolling_saves));
    }

    #[test]
    fn running_and_starting_checkouts_are_never_evicted() {
        let base = TempDir::new();
        let now = SystemTime::now();
        let running = checkout(&base.0, now, 30 * DAY, 10);
        let stopped_container = checkout(&base.0, now, 30 * DAY, 10);
        let starting = checkout(&base.0, now, 30 * DAY, 10);
        let host = FakeHost {
            present: HashSet::from([running, stopped_container]),
            busy: HashSet::from([starting]),
            ..FakeHost::default()
        };

        let report = sweep_checkouts(&base.0, &CheckoutEvictionPolicy::default(), now, &host);
        assert!(report.evicted.is_empty(), "{report:?}");
        assert_eq!(report.kept.len(), 3, "{report:?}");
        for project_id in [running, stopped_container, starting] {
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

    #[test]
    fn a_stop_that_finishes_before_the_sweep_gets_the_lock_keeps_the_checkout() {
        let base = TempDir::new();
        let now = SystemTime::now();
        let project_id = checkout(&base.0, now, 30 * DAY, 10);
        let host = FakeHost {
            stopped_meanwhile: Some((base.0.clone(), project_id)),
            ..FakeHost::default()
        };
        let report = sweep_checkouts(&base.0, &CheckoutEvictionPolicy::default(), now, &host);
        assert!(report.evicted.is_empty(), "{report:?}");
        assert!(exists(&base.0, project_id));
    }

    /// The origin writes the marker eviction reads: the same bytes.
    #[test]
    fn the_durable_marker_is_the_one_the_origin_writes() {
        let origin = include_str!("../../../origin-http-server/src/working_state.rs");
        let definition = format!(
            "DURABLE_MARKER: &[u8] = b\"{}\";",
            DURABLE_MARKER.escape_ascii()
        );
        assert!(
            origin.contains(&definition),
            "the origin's DURABLE_MARKER differs from {definition}"
        );
    }
}
