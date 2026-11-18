//! Retain child identities across polls: a shell may create another process group/session.
//! Cooperative shutdown of the supervised program is the primary path; this guard handles
//! failures and dropped runs.
//!
//! Each supervisor passes its own cleanup latch: the isolated tool worker's, or the local-engine
//! lane's (`claude_code`). A tree whose descendants cannot be confirmed gone sets that latch,
//! and the lease loop stops taking work while any latch is set (`agent::runtime_reuse_is_safe`).
//!
//! An observation reads what [`Processes`] gives. On macOS that is the kernel's record of each
//! tracked process and the list of its children, so an observation costs what the tracked
//! subtree costs; reading every process on the computer cost about half a core every 50 ms
//! (docs/Local-Engine-Turns.md 3.6, D-F). Elsewhere it is a sysinfo snapshot of every process.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Result, bail};
use sysinfo::Pid;

pub(crate) fn prepare_child() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        // Detached grandchildren reparent to this worker, not init, while it is alive.
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}

/// How long `terminate_and_confirm` waits for the killed processes to be gone.
const CONFIRM_WITHIN: Duration = Duration::from_secs(3);

/// How long the stop path waits, once it has stopped every tracked process, before it looks for
/// new ones. A process stopped inside `fork` or `posix_spawn` finishes the call first, so its
/// child appears only after the stop. Reading every process took about this long, so the old
/// tracker waited as much without meaning to; without the wait such a child outlived the kill.
#[cfg(unix)]
const SETTLE_AFTER_STOP: Duration = Duration::from_millis(25);

/// At most this many rounds of stopping and walking again before the stop path kills.
const STOP_ROUNDS: usize = 8;

pub(crate) struct ProcessTree {
    root: Pid,
    /// The processes this tree has seen that still exist, each with the start time that tells it
    /// from a later process given the same pid.
    identities: HashMap<Pid, u64>,
    processes: Processes,
    /// Set once a read the tree depends on failed: the root's record when the tree was made, a
    /// tracked process's children, or the record of a child they listed. Such a tree cannot vouch
    /// for its descendants, so it never confirms their cleanup.
    unread: bool,
    /// The root led a process group of its own, apart from this process's, when the tree was
    /// made. Kept from then, since a root that exits leaves its group to the members that still
    /// run in it.
    #[cfg(unix)]
    root_led_group: bool,
    armed: bool,
    /// Set when this tree's cleanup cannot be confirmed.
    cleanup_unconfirmed: &'static AtomicBool,
    confirm_within: Duration,
    /// For tests of the unconfirmed cleanup: a process that outlives every kill.
    #[cfg(test)]
    survivor: bool,
}

impl ProcessTree {
    pub(crate) fn new(pid: u32, cleanup_unconfirmed: &'static AtomicBool) -> Self {
        let processes = Processes::read();
        let root = Pid::from_u32(pid);
        let mut identities = HashMap::new();
        let mut unread = false;
        match processes.record(root) {
            Read::Found(record) => {
                identities.insert(root, record.start);
            }
            Read::Gone => {}
            Read::Unreadable => unread = true,
        }
        #[cfg(unix)]
        let root_led_group = processes.leads_its_own_group(root);
        Self {
            root,
            identities,
            processes,
            unread,
            #[cfg(unix)]
            root_led_group,
            armed: true,
            cleanup_unconfirmed,
            confirm_within: CONFIRM_WITHIN,
            #[cfg(test)]
            survivor: false,
        }
    }

    /// For tests of the unconfirmed cleanup: no SIGKILL ends some process of this tree, and the
    /// wait for it is `confirm_within`. Nothing hermetic survives SIGKILL otherwise.
    #[cfg(test)]
    pub(crate) fn with_a_survivor(mut self, confirm_within: Duration) -> Self {
        self.survivor = true;
        self.confirm_within = confirm_within;
        self
    }

    fn mark_cleanup_unconfirmed(&self) {
        self.cleanup_unconfirmed.store(true, Ordering::Release);
    }

    pub(crate) fn observe(&mut self) {
        self.discover();
    }

    /// Reads the processes again, forgets the tracked ones that are gone, and tracks each child
    /// of a tracked process, its own children included, returning how many it started tracking.
    /// A child counts only while its parent is the process this tree saw: a later process given
    /// a forgotten pid is tracked only if it descends from the tree. A tracked process stays
    /// tracked after its parent exits and it is reparented. A read that fails marks the tree
    /// `unread`.
    fn discover(&mut self) -> usize {
        self.processes.refresh();
        let processes = &self.processes;
        self.identities
            .retain(|pid, start| !processes.record(*pid).ended(*start));
        let mut parents = self.identities.keys().copied().collect::<Vec<_>>();
        let mut added = 0;
        while let Some(parent) = parents.pop() {
            let Some(children) = self.processes.children(parent) else {
                self.unread = true;
                continue;
            };
            for child in children {
                if self.identities.contains_key(&child) {
                    continue;
                }
                match self.processes.record(child) {
                    Read::Found(record) => {
                        self.identities.insert(child, record.start);
                        parents.push(child);
                        added += 1;
                    }
                    // It exited between the listing and the read.
                    Read::Gone => {}
                    Read::Unreadable => self.unread = true,
                }
            }
        }
        added
    }

    fn matching(&self, pid: Pid, start: u64) -> bool {
        self.processes.record(pid).same(start)
    }

    /// The root's process group, while the root leads one of its own apart from this process's
    /// and its identity still matches, so the group's id, the root's pid, is still its own.
    #[cfg(unix)]
    fn root_group(&self) -> Option<libc::pid_t> {
        let root = libc::pid_t::try_from(self.root.as_u32()).ok()?;
        let matches = self
            .identities
            .get(&self.root)
            .is_some_and(|start| self.matching(self.root, *start));
        // SAFETY: getpgrp takes no pointer.
        let ours = unsafe { libc::getpgrp() } == root;
        (matches && !ours && (self.root_led_group || self.processes.leads_its_own_group(self.root)))
            .then_some(root)
    }

    /// Stops every tracked process, and the root's group with them, so that none can fork while
    /// the tree walks again.
    #[cfg(unix)]
    fn stop_all(&self) {
        if let Some(group) = self.root_group() {
            unsafe { libc::killpg(group, libc::SIGSTOP) };
        }
        for (pid, start) in &self.identities {
            if self.matching(*pid, *start) {
                unsafe { libc::kill(pid.as_u32() as i32, libc::SIGSTOP) };
            }
        }
    }

    /// Kills the root's group, which the supervisor created, so a fork of it the tree has not
    /// seen yet dies too, then every tracked process, the root last. Tools that create new groups
    /// are tracked; Windows additionally has the worker's KILL_ON_JOB_CLOSE Job Object, installed
    /// before its CLI dispatch.
    fn kill_all(&self) {
        #[cfg(unix)]
        if let Some(group) = self.root_group() {
            unsafe { libc::killpg(group, libc::SIGKILL) };
        }
        for (pid, start) in &self.identities {
            if *pid != self.root && self.matching(*pid, *start) {
                self.processes.kill(*pid);
            }
        }
        if let Some(start) = self.identities.get(&self.root)
            && self.matching(self.root, *start)
        {
            self.processes.kill(self.root);
        }
    }

    /// The stop path. It stops writers before walking again, so a still-running shell cannot
    /// fork between discovery and termination, round after round until a walk finds nothing new,
    /// and then kills. Retained identities also cover observed reparented tools. This one blocks
    /// the thread while it waits, for `Drop`, which cannot await.
    fn stop_and_kill(&mut self) {
        for _ in 0..STOP_ROUNDS {
            self.discover();
            #[cfg(unix)]
            {
                self.stop_all();
                std::thread::sleep(SETTLE_AFTER_STOP);
            }
            if self.discover() == 0 {
                break;
            }
        }
        self.kill_all();
    }

    /// The stop path of `stop_and_kill`, awaiting its waits.
    async fn stop_and_kill_awaiting(&mut self) {
        for _ in 0..STOP_ROUNDS {
            self.discover();
            #[cfg(unix)]
            {
                self.stop_all();
                tokio::time::sleep(SETTLE_AFTER_STOP).await;
            }
            if self.discover() == 0 {
                break;
            }
        }
        self.kill_all();
    }

    /// How many observed descendants still run, the root left out: what the kill path is about
    /// to stop. It signals nothing. Fresh process records, as `terminate_and_confirm` reads
    /// them, so an exited child that waits to be reaped does not count, and one that cannot be
    /// read does.
    pub(crate) fn running_descendants(&mut self) -> usize {
        self.observe();
        let fresh = Processes::read();
        self.identities
            .iter()
            .filter(|(pid, start)| **pid != self.root && fresh.record(**pid).may_run(**start))
            .count()
    }

    pub(crate) async fn terminate_and_confirm(&mut self) -> Result<()> {
        self.stop_and_kill_awaiting().await;
        if self.unread {
            self.mark_cleanup_unconfirmed();
            bail!("supervised processes could not be read, so their termination is unconfirmed");
        }
        let deadline = tokio::time::Instant::now() + self.confirm_within;
        loop {
            // Fresh records every time, so a killed child that waits to be reaped reads as the
            // zombie it is: sysinfo 0.30's macOS refresh kept a process's first status.
            self.processes = Processes::read();
            let alive = self
                .identities
                .iter()
                .any(|(pid, start)| self.processes.record(*pid).may_run(*start));
            #[cfg(test)]
            let alive = alive || self.survivor;
            if !alive {
                self.armed = false;
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                self.mark_cleanup_unconfirmed();
                bail!("supervised descendants survived termination");
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        if self.armed {
            // A dropped future cannot await confirmation. Its runtime must retire even if
            // the best-effort kill succeeds, rather than treating the capacity as reusable.
            self.mark_cleanup_unconfirmed();
            self.stop_and_kill();
        }
    }
}

/// What the tracker reads of one process.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Record {
    /// When it started, which tells it from a later process given the same pid: microseconds
    /// since the epoch on macOS, seconds as sysinfo gives them elsewhere.
    start: u64,
    /// It exited and waits for its parent to reap it, so nothing runs in it.
    zombie: bool,
}

/// What reading one process gave.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Read {
    Found(Record),
    /// No process has the pid.
    Gone,
    /// The kernel gave no record the tracker can read. The tracker counts such a process as
    /// running, so it never confirms what it could not read.
    #[cfg_attr(
        not(target_os = "macos"),
        allow(dead_code, reason = "only the macOS reader's reads can fail")
    )]
    Unreadable,
}

impl Read {
    /// It is the process that started at `start`.
    fn same(self, start: u64) -> bool {
        matches!(self, Read::Found(record) if record.start == start)
    }

    /// It is no longer the process that started at `start`: it is gone, or another process has
    /// its pid.
    fn ended(self, start: u64) -> bool {
        match self {
            Read::Found(record) => record.start != start,
            Read::Gone => true,
            Read::Unreadable => false,
        }
    }

    /// The process that started at `start` may still run: it is not a zombie, or it could not
    /// be read.
    fn may_run(self, start: u64) -> bool {
        match self {
            Read::Found(record) => record.start == start && !record.zombie,
            Read::Gone => false,
            Read::Unreadable => true,
        }
    }
}

/// The processes as the kernel has them, read one process at a time and never kept, so there is
/// nothing to refresh. A record comes from `sysctl`'s `KERN_PROC_PID`, which gives one for any
/// user's process and for a zombie, where `proc_pidinfo`, which sysinfo reads, gives neither. A
/// process's children come from `proc_listchildpids`, zombies included.
#[cfg(target_os = "macos")]
struct Processes;

/// `struct kinfo_proc` (<sys/sysctl.h>): its size and the offsets of the fields read, the same
/// on arm64 and x86_64.
#[cfg(target_os = "macos")]
mod kinfo_proc {
    pub(super) const SIZE: usize = 648;
    /// `kp_proc.p_starttime.tv_sec`, an `i64`.
    pub(super) const START_SECONDS: usize = 0;
    /// `kp_proc.p_starttime.tv_usec`, an `i32`.
    pub(super) const START_MICROSECONDS: usize = 8;
    /// `kp_proc.p_stat`, a `char`.
    pub(super) const STATE: usize = 36;
    /// `kp_proc.p_pid`, an `i32`.
    pub(super) const PID: usize = 40;
    /// `kp_eproc.e_pgid`, an `i32`.
    pub(super) const GROUP: usize = 564;
}

/// More children than any one process has: `proc_listchildpids` fills at most the buffer it is
/// given, and a full one is read again into a larger one, up to this.
#[cfg(target_os = "macos")]
const MAX_CHILDREN: usize = 1 << 16;

#[cfg(target_os = "macos")]
impl Processes {
    fn read() -> Self {
        Self
    }

    fn refresh(&mut self) {}

    fn record(&self, pid: Pid) -> Read {
        // No process has a pid past `pid_t`'s range.
        let Ok(pid) = libc::pid_t::try_from(pid.as_u32()) else {
            return Read::Gone;
        };
        let info = match kinfo_proc_of(pid) {
            Ok(Some(info)) => info,
            Ok(None) => return Read::Gone,
            Err(()) => return Read::Unreadable,
        };
        let mut seconds = [0u8; 8];
        seconds.copy_from_slice(&info[kinfo_proc::START_SECONDS..kinfo_proc::START_SECONDS + 8]);
        let start = u64::try_from(i64::from_ne_bytes(seconds))
            .ok()
            .zip(u64::try_from(int_at(&info, kinfo_proc::START_MICROSECONDS)).ok())
            .and_then(|(seconds, microseconds)| {
                seconds.checked_mul(1_000_000)?.checked_add(microseconds)
            });
        match start {
            Some(start) => Read::Found(Record {
                start,
                zombie: u32::from(info[kinfo_proc::STATE]) == libc::SZOMB,
            }),
            None => Read::Unreadable,
        }
    }

    /// The process leads a process group of its own, apart from this process's. The group comes
    /// from its record, which a process that exited and waits to be reaped still has, where
    /// `getpgid` finds no process.
    fn leads_its_own_group(&self, pid: Pid) -> bool {
        let Ok(pid) = libc::pid_t::try_from(pid.as_u32()) else {
            return false;
        };
        // SAFETY: getpgrp takes no pointer.
        matches!(kinfo_proc_of(pid), Ok(Some(info)) if int_at(&info, kinfo_proc::GROUP) == pid)
            && unsafe { libc::getpgrp() } != pid
    }

    /// The children of `parent`, or `None` when the kernel would not list them all.
    fn children(&self, parent: Pid) -> Option<Vec<Pid>> {
        // No process has a pid past `pid_t`'s range, so none has it as its parent.
        let Ok(parent) = libc::pid_t::try_from(parent.as_u32()) else {
            return Some(Vec::new());
        };
        let mut capacity = 64;
        loop {
            let mut pids = vec![0 as libc::pid_t; capacity];
            let size = libc::c_int::try_from(std::mem::size_of_val(pids.as_slice())).ok()?;
            let count = list_children(parent, &mut pids, size)?;
            if count >= capacity {
                // A full buffer may have left some out.
                if capacity >= MAX_CHILDREN {
                    return None;
                }
                capacity *= 4;
                continue;
            }
            pids.truncate(count);
            return Some(
                pids.into_iter()
                    .filter_map(|pid| u32::try_from(pid).ok())
                    .filter(|pid| *pid != 0)
                    .map(Pid::from_u32)
                    .collect(),
            );
        }
    }

    fn kill(&self, pid: Pid) {
        if let Ok(pid) = libc::pid_t::try_from(pid.as_u32()) {
            // SAFETY: `kill` takes any pid and signal.
            unsafe { libc::kill(pid, libc::SIGKILL) };
        }
    }
}

/// The kernel's `kinfo_proc` for `pid`: `Ok(None)` when no process has the pid, and `Err(())`
/// when the kernel gave nothing the tracker can read.
#[cfg(target_os = "macos")]
fn kinfo_proc_of(pid: libc::pid_t) -> Result<Option<[u8; kinfo_proc::SIZE]>, ()> {
    let mut name = [libc::CTL_KERN, libc::KERN_PROC, libc::KERN_PROC_PID, pid];
    let mut info = [0u8; kinfo_proc::SIZE];
    let mut size = info.len();
    // SAFETY: the kernel writes at most `size` bytes into `info` and sets `size` to how many it
    // wrote: none for a pid that no process has.
    let result = unsafe {
        libc::sysctl(
            name.as_mut_ptr(),
            name.len() as libc::c_uint,
            info.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if result != 0 {
        return Err(());
    }
    if size == 0 {
        return Ok(None);
    }
    if size != kinfo_proc::SIZE || int_at(&info, kinfo_proc::PID) != pid {
        return Err(());
    }
    Ok(Some(info))
}

/// The `i32` at `at` in a `kinfo_proc`.
#[cfg(target_os = "macos")]
fn int_at(info: &[u8; kinfo_proc::SIZE], at: usize) -> i32 {
    i32::from_ne_bytes([info[at], info[at + 1], info[at + 2], info[at + 3]])
}

/// Lists `parent`'s children into `pids`, offering the kernel `size` bytes of it, which `pids`
/// must hold: how many pids it wrote, or `None` when it would not list them.
/// `proc_listchildpids` reports a failure as no children with `errno` set, so `errno` is
/// cleared first.
#[cfg(target_os = "macos")]
fn list_children(
    parent: libc::pid_t,
    pids: &mut [libc::pid_t],
    size: libc::c_int,
) -> Option<usize> {
    assert!(usize::try_from(size).is_ok_and(|size| size <= std::mem::size_of_val(pids)));
    // SAFETY: `__error` returns this thread's `errno`.
    unsafe { *libc::__error() = 0 };
    // SAFETY: the kernel writes at most `size` bytes of pids into `pids`, which holds that many.
    let count = unsafe { libc::proc_listchildpids(parent, pids.as_mut_ptr().cast(), size) };
    // SAFETY: as above.
    let error = unsafe { *libc::__error() };
    let count = usize::try_from(count).ok()?;
    if count == 0 && error != 0 {
        return None;
    }
    Some(count)
}

/// The processes as a sysinfo snapshot of every process on the computer, taken again by
/// `refresh`.
#[cfg(not(target_os = "macos"))]
struct Processes {
    system: sysinfo::System,
    /// The children of each process in `system`.
    children: HashMap<Pid, Vec<Pid>>,
}

#[cfg(not(target_os = "macos"))]
impl Processes {
    fn read() -> Self {
        let mut processes = Self {
            system: sysinfo::System::new(),
            children: HashMap::new(),
        };
        processes.refresh();
        processes
    }

    fn refresh(&mut self) {
        self.system
            .refresh_processes_specifics(sysinfo::ProcessRefreshKind::new());
        self.children.clear();
        for (pid, process) in self.system.processes() {
            if let Some(parent) = process.parent() {
                self.children.entry(parent).or_default().push(*pid);
            }
        }
    }

    fn record(&self, pid: Pid) -> Read {
        match self.system.process(pid) {
            Some(process) => Read::Found(Record {
                start: process.start_time(),
                zombie: process.status() == sysinfo::ProcessStatus::Zombie,
            }),
            None => Read::Gone,
        }
    }

    /// The children of `parent` in the snapshot, which always lists them all.
    fn children(&self, parent: Pid) -> Option<Vec<Pid>> {
        Some(self.children.get(&parent).cloned().unwrap_or_default())
    }

    /// The process leads a process group of its own, apart from this process's.
    #[cfg(unix)]
    fn leads_its_own_group(&self, pid: Pid) -> bool {
        let pid = pid.as_u32() as libc::pid_t;
        // SAFETY: neither call takes a pointer.
        unsafe { libc::getpgid(pid) == pid && libc::getpgrp() != pid }
    }

    fn kill(&self, pid: Pid) {
        if let Some(process) = self.system.process(pid) {
            process.kill();
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use sysinfo::{ProcessRefreshKind, System};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn termination_drains_background_descendants_without_stopping_another_worker() {
        static LATCH: AtomicBool = AtomicBool::new(false);
        let mut unrelated = tokio::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut other_tree = ProcessTree::new(unrelated.id().unwrap(), &LATCH);
        let mut root = tokio::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30 & printf '%s\\n' $!; wait"])
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut tree = ProcessTree::new(root.id().unwrap(), &LATCH);
        let mut line = String::new();
        tokio::io::BufReader::new(root.stdout.take().unwrap())
            .read_line(&mut line)
            .await
            .unwrap();
        let descendant = Pid::from_u32(line.trim().parse().unwrap());
        tree.observe();
        assert!(tree.identities.contains_key(&descendant));
        // The background `sleep`, not the shell that started it.
        assert_eq!(tree.running_descendants(), 1);
        let result = tree.terminate_and_confirm().await;
        assert_eq!(tree.running_descendants(), 0);
        let other_alive = unrelated.try_wait().unwrap().is_none();
        let _ = other_tree.terminate_and_confirm().await;
        let _ = root.wait().await;
        let _ = unrelated.wait().await;
        result.unwrap();
        assert!(
            other_alive,
            "termination crossed the worker process boundary"
        );
        assert!(
            !LATCH.load(Ordering::Acquire),
            "a confirmed termination set the cleanup latch"
        );
    }

    #[tokio::test]
    async fn a_dropped_tree_sets_only_the_latch_it_was_given() {
        static CONFIRMED: AtomicBool = AtomicBool::new(false);
        static DROPPED: AtomicBool = AtomicBool::new(false);
        let sleeper = || {
            tokio::process::Command::new("/bin/sh")
                .args(["-c", "sleep 30"])
                .process_group(0)
                .kill_on_drop(true)
                .spawn()
                .unwrap()
        };
        let mut first = sleeper();
        let mut second = sleeper();
        let mut confirmed = ProcessTree::new(first.id().unwrap(), &CONFIRMED);
        confirmed.terminate_and_confirm().await.unwrap();
        drop(confirmed);
        // A tree dropped before its termination was confirmed cannot vouch for its descendants.
        drop(ProcessTree::new(second.id().unwrap(), &DROPPED));
        let _ = first.wait().await;
        let _ = second.wait().await;
        assert!(DROPPED.load(Ordering::Acquire));
        assert!(!CONFIRMED.load(Ordering::Acquire));
    }

    /// A process that outlives the kill: the tree says so once its wait runs out, and sets the
    /// latch it was given and no other.
    #[tokio::test]
    async fn a_process_that_outlives_the_kill_sets_only_the_latch_it_was_given() {
        static GIVEN: AtomicBool = AtomicBool::new(false);
        static OTHER: AtomicBool = AtomicBool::new(false);
        let mut root = tokio::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut tree = ProcessTree::new(root.id().unwrap(), &GIVEN)
            .with_a_survivor(Duration::from_millis(100));
        let started = tokio::time::Instant::now();
        let result = tree.terminate_and_confirm().await;
        let waited = started.elapsed();
        assert!(result.is_err(), "a survivor was confirmed gone");
        assert!(waited >= Duration::from_millis(100), "{waited:?}");
        assert!(waited < CONFIRM_WITHIN, "{waited:?}");
        assert!(GIVEN.load(Ordering::Acquire));
        assert!(!OTHER.load(Ordering::Acquire));
        // The real process was killed all the same.
        assert!(root.wait().await.is_ok());
        drop(tree);
        assert!(!OTHER.load(Ordering::Acquire));
    }

    /// `script` under `/bin/sh` in a process group of its own, as a supervisor starts its
    /// program, with its input and output piped.
    fn shell(script: &str) -> tokio::process::Child {
        tokio::process::Command::new("/bin/sh")
            .args(["-c", script])
            .process_group(0)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    /// The first line `child` prints, read without closing its output.
    async fn first_line(child: &mut tokio::process::Child) -> String {
        let mut reader = tokio::io::BufReader::new(child.stdout.as_mut().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        line
    }

    /// Waits until `done` holds, for at most five seconds.
    async fn until(what: &str, mut done: impl FnMut() -> bool) {
        let started = tokio::time::Instant::now();
        while !done() {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "timed out waiting until {what}"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// One observation tracks every generation: a child, its child, and so on.
    #[tokio::test]
    async fn one_observation_tracks_every_generation() {
        static LATCH: AtomicBool = AtomicBool::new(false);
        let mut root = shell("sh -c 'sleep 30 & echo $!; wait' & wait");
        let mut tree = ProcessTree::new(root.id().unwrap(), &LATCH);
        let grandchild = Pid::from_u32(first_line(&mut root).await.trim().parse().unwrap());
        tree.observe();
        assert!(tree.identities.contains_key(&grandchild));
        // The inner shell and its `sleep`.
        assert_eq!(tree.running_descendants(), 2);
        tree.terminate_and_confirm().await.unwrap();
        let _ = root.wait().await;
        assert!(!LATCH.load(Ordering::Acquire));
    }

    /// A descendant the tree has seen stays tracked after its parent exits and it is
    /// reparented outside the tree, and the kill still reaches it.
    #[tokio::test]
    async fn a_seen_descendant_stays_tracked_after_its_parent_exits() {
        static LATCH: AtomicBool = AtomicBool::new(false);
        let mut root = shell("sh -c 'sleep 30 & echo $! $$; read _'; sleep 30");
        let mut tree = ProcessTree::new(root.id().unwrap(), &LATCH);
        let line = first_line(&mut root).await;
        let mut pids = line
            .split_whitespace()
            .map(|pid| Pid::from_u32(pid.parse().unwrap()));
        let (orphan, parent) = (pids.next().unwrap(), pids.next().unwrap());
        tree.observe();
        assert!(tree.identities.contains_key(&orphan));
        // The parent exits once it reads a line, and the root reaps it.
        root.stdin.take().unwrap().write_all(b"\n").await.unwrap();
        until("the parent is gone", || {
            Processes::read().record(parent) == Read::Gone
        })
        .await;
        tree.observe();
        assert!(
            tree.identities.contains_key(&orphan),
            "a reparented descendant was forgotten"
        );
        assert!(
            tree.identities.keys().all(|pid| {
                tree.processes
                    .children(*pid)
                    .is_some_and(|children| !children.contains(&orphan))
            }),
            "the descendant is still a child of a tracked process"
        );
        tree.terminate_and_confirm().await.unwrap();
        assert!(
            matches!(
                Processes::read().record(orphan),
                Read::Gone | Read::Found(Record { zombie: true, .. })
            ),
            "the reparented descendant survived"
        );
        let _ = root.wait().await;
        assert!(!LATCH.load(Ordering::Acquire));
    }

    /// A child that exited and waits to be reaped is a zombie: still tracked, but nothing runs
    /// in it, so the tree neither counts it nor waits for it.
    #[tokio::test]
    async fn a_zombie_is_tracked_but_not_running() {
        static LATCH: AtomicBool = AtomicBool::new(false);
        // `sleep 2` exits once the shell has become `sleep 30`, which never reaps it.
        let mut root = shell("sleep 2 & echo $!; exec sleep 30");
        let mut tree = ProcessTree::new(root.id().unwrap(), &LATCH);
        let zombie = Pid::from_u32(first_line(&mut root).await.trim().parse().unwrap());
        tree.observe();
        assert!(tree.identities.contains_key(&zombie));
        assert_eq!(tree.running_descendants(), 1);
        until("the child is a zombie", || {
            matches!(
                Processes::read().record(zombie),
                Read::Found(Record { zombie: true, .. })
            )
        })
        .await;
        tree.observe();
        assert!(
            tree.identities.contains_key(&zombie),
            "a zombie was forgotten before it was reaped"
        );
        assert_eq!(tree.running_descendants(), 0);
        tree.terminate_and_confirm().await.unwrap();
        let _ = root.wait().await;
        assert!(!LATCH.load(Ordering::Acquire));
    }

    /// Every child of a parent is read, more of them than the first read on macOS has room for.
    #[tokio::test]
    async fn every_child_of_a_parent_is_read() {
        static LATCH: AtomicBool = AtomicBool::new(false);
        let mut root =
            shell("i=0; while [ $i -lt 70 ]; do sleep 30 & i=$((i+1)); done; echo started; wait");
        let mut tree = ProcessTree::new(root.id().unwrap(), &LATCH);
        assert_eq!(first_line(&mut root).await.trim(), "started");
        tree.observe();
        assert_eq!(tree.running_descendants(), 70);
        tree.terminate_and_confirm().await.unwrap();
        let _ = root.wait().await;
        assert!(!LATCH.load(Ordering::Acquire));
    }

    /// The record read on macOS agrees with `proc_pidinfo` on a process both can read, and tells
    /// a running, a stopped, a zombie and a gone process apart.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_record_reads_the_start_time_and_the_state() {
        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let pid = Pid::from_u32(child.id());
        let processes = Processes::read();
        let Read::Found(record) = processes.record(pid) else {
            panic!("no record of a running child");
        };
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: proc_pidinfo writes at most `size` bytes into `info`.
        let written = unsafe {
            libc::proc_pidinfo(
                pid.as_u32() as libc::c_int,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        assert_eq!(written, size);
        // SAFETY: proc_pidinfo filled it.
        let info = unsafe { info.assume_init() };
        assert_eq!(
            record.start,
            info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec
        );
        assert!(!record.zombie);
        let signal = |signal| unsafe { libc::kill(pid.as_u32() as libc::pid_t, signal) };
        signal(libc::SIGSTOP);
        assert_eq!(
            processes.record(pid),
            Read::Found(record),
            "a stopped process"
        );
        signal(libc::SIGKILL);
        let killed = Read::Found(Record {
            zombie: true,
            ..record
        });
        let started = std::time::Instant::now();
        while processes.record(pid) != killed {
            assert!(
                started.elapsed() < Duration::from_secs(5),
                "the killed child never read as a zombie"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        child.wait().unwrap();
        assert_eq!(processes.record(pid), Read::Gone);
        let Read::Found(own) = processes.record(Pid::from_u32(std::process::id())) else {
            panic!("no record of this process");
        };
        assert!(!own.zombie);
        assert!(own.start < record.start);
    }

    /// The root's group is killed even when the root had exited before the tree was made, so a
    /// fork the tree never saw still dies: the group comes from the root's record, which the
    /// root keeps until it is reaped.
    #[tokio::test]
    async fn the_group_of_a_root_that_exited_is_still_killed() {
        static LATCH: AtomicBool = AtomicBool::new(false);
        // The root starts a `sleep` in its group and exits.
        let mut root = shell("sleep 30 & echo $!");
        let root_pid = Pid::from_u32(root.id().unwrap());
        let unseen = Pid::from_u32(first_line(&mut root).await.trim().parse().unwrap());
        until("the root is a zombie", || {
            matches!(
                Processes::read().record(root_pid),
                Read::Found(Record { zombie: true, .. })
            )
        })
        .await;
        let mut tree = ProcessTree::new(root_pid.as_u32(), &LATCH);
        tree.observe();
        assert!(
            !tree.identities.contains_key(&unseen),
            "the fork is no longer a child of the root"
        );
        tree.terminate_and_confirm().await.unwrap();
        until("the fork the tree never saw is gone", || {
            matches!(
                Processes::read().record(unseen),
                Read::Gone | Read::Found(Record { zombie: true, .. })
            )
        })
        .await;
        let _ = root.wait().await;
        assert!(!LATCH.load(Ordering::Acquire));
    }

    /// A listing the kernel refuses is noticed: `proc_listchildpids` reports one as no children
    /// with `errno` set, here for a buffer too small for a pid.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_child_listing_the_kernel_refuses_is_noticed() {
        let own = std::process::id() as libc::pid_t;
        let mut pids = [0 as libc::pid_t; 4];
        assert_eq!(list_children(own, &mut pids, 2), None);
        let size = std::mem::size_of_val(&pids) as libc::c_int;
        assert!(list_children(own, &mut pids, size).is_some());
    }

    /// Stops and kills a tree that keeps forking, many times, and counts the terminations that
    /// left one of its processes running. A process stopped inside `fork` finishes the call
    /// first, so its child appears only after the stop (`SETTLE_AFTER_STOP`). The forker is
    /// `perl`, whose `fork` is the system call alone, so the stops often land inside one. The
    /// root shares this process's group, as the lane's does, so no group kill hides an escape.
    /// A race, so run it by hand:
    /// `cargo test --lib process_tree::tests::stopping_a_tree_that_keeps_forking_leaves_nothing_running -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "a race: run by hand with --ignored --nocapture"]
    async fn stopping_a_tree_that_keeps_forking_leaves_nothing_running() {
        static LATCH: AtomicBool = AtomicBool::new(false);
        let rounds = 200;
        // An argument no other process has, which every process of the tree carries.
        let marker = format!("instafy-fork-race-{}", std::process::id());
        let forker = "for (1..400) { fork or do { sleep 30; exit } } sleep 30";
        let mut escaped = 0;
        for _ in 0..rounds {
            let mut root = tokio::process::Command::new("perl")
                .args(["-e", forker, &marker])
                .kill_on_drop(true)
                .spawn()
                .expect("perl");
            let mut tree = ProcessTree::new(root.id().unwrap(), &LATCH);
            for _ in 0..3 {
                tokio::time::sleep(Duration::from_millis(5)).await;
                tree.observe();
            }
            let _ = tree.terminate_and_confirm().await;
            let _ = root.wait().await;
            // Time for a child the kill missed to start running.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let left = std::process::Command::new("pgrep")
                .args(["-f", &marker])
                .output()
                .unwrap();
            if !left.stdout.is_empty() {
                escaped += 1;
                let _ = std::process::Command::new("pkill")
                    .args(["-KILL", "-f", &marker])
                    .status();
            }
        }
        println!("{escaped} of {rounds} terminations left a process running");
        assert_eq!(escaped, 0);
    }

    /// A tree that could not read a record it depends on cannot vouch for its descendants: it
    /// never confirms their cleanup, and it sets its latch, though it still kills what it read.
    #[tokio::test]
    async fn a_tree_that_could_not_read_never_confirms_its_cleanup() {
        static LATCH: AtomicBool = AtomicBool::new(false);
        let mut root = tokio::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut tree = ProcessTree::new(root.id().unwrap(), &LATCH);
        tree.unread = true;
        assert!(tree.terminate_and_confirm().await.is_err());
        assert!(LATCH.load(Ordering::Acquire));
        assert!(root.wait().await.is_ok());
    }

    /// A process that could not be read counts as running and as not yet ended, so the tree
    /// neither forgets it nor confirms it gone.
    #[test]
    fn a_process_that_could_not_be_read_may_still_run() {
        let record = Record {
            start: 7,
            zombie: false,
        };
        let zombie = Record {
            zombie: true,
            ..record
        };
        assert!(Read::Found(record).may_run(7));
        assert!(!Read::Found(record).may_run(8));
        assert!(!Read::Found(zombie).may_run(7));
        assert!(!Read::Gone.may_run(7));
        assert!(Read::Unreadable.may_run(7));
        assert!(!Read::Found(record).ended(7));
        assert!(Read::Found(record).ended(8));
        assert!(Read::Gone.ended(7));
        assert!(!Read::Unreadable.ended(7));
        assert!(Read::Found(zombie).same(7));
        assert!(!Read::Unreadable.same(7));
    }

    /// The CPU time this process has used: user, then system.
    fn cpu_time() -> (Duration, Duration) {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::zeroed();
        // SAFETY: getrusage fills the struct it is given.
        let usage = unsafe {
            libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr());
            usage.assume_init()
        };
        let time = |value: libc::timeval| {
            Duration::from_secs(value.tv_sec as u64) + Duration::from_micros(value.tv_usec as u64)
        };
        (time(usage.ru_utime), time(usage.ru_stime))
    }

    /// The measurement of what tracking costs (docs/Local-Engine-Turns.md 3.6, D-F): one tree
    /// observing every 50 ms, as a local-engine turn's does for as long as the turn runs, over
    /// `INSTAFY_PROCESS_TREE_MEASURE_SECONDS` (60 by default). It prints the CPU time it used.
    /// Run it by hand, alone, on the machine being measured, on a release build:
    /// `cargo test --release --lib process_tree::tests::what_observing_every_50_ms_costs -- --ignored --nocapture`
    #[tokio::test]
    #[ignore = "a measurement: run by hand with --ignored --nocapture"]
    async fn what_observing_every_50_ms_costs() {
        static LATCH: AtomicBool = AtomicBool::new(false);
        let seconds = std::env::var("INSTAFY_PROCESS_TREE_MEASURE_SECONDS")
            .ok()
            .and_then(|seconds| seconds.parse().ok())
            .unwrap_or(60u64);
        let mut root = tokio::process::Command::new("/bin/sh")
            .args(["-c", "sleep 3600 & wait"])
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut tree = ProcessTree::new(root.id().unwrap(), &LATCH);
        let mut system = System::new();
        system.refresh_processes_specifics(ProcessRefreshKind::new());
        let processes = system.processes().len();
        let mut ticker = tokio::time::interval(Duration::from_millis(50));
        let before = cpu_time();
        let started = std::time::Instant::now();
        let mut observations = 0u32;
        while started.elapsed() < Duration::from_secs(seconds) {
            ticker.tick().await;
            tree.observe();
            observations += 1;
        }
        let after = cpu_time();
        let (user, system) = (
            after.0.saturating_sub(before.0),
            after.1.saturating_sub(before.1),
        );
        let used = user + system;
        let elapsed = started.elapsed();
        tree.terminate_and_confirm().await.unwrap();
        let _ = root.wait().await;
        println!(
            "{observations} observations in {:.1} s, with {processes} processes on this machine: {} ms of CPU ({} ms user, {} ms system), {:.2}% of one core, {:.2} ms each",
            elapsed.as_secs_f64(),
            used.as_millis(),
            user.as_millis(),
            system.as_millis(),
            100.0 * used.as_secs_f64() / elapsed.as_secs_f64(),
            used.as_secs_f64() * 1000.0 / f64::from(observations.max(1)),
        );
    }
}
