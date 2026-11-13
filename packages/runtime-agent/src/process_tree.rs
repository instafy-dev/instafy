//! Retain child identities across polls: a shell may create another process group/session.
//! Cooperative shutdown of the supervised program is the primary path; this guard handles
//! failures and dropped runs.
//!
//! Each supervisor passes its own cleanup latch: the isolated tool worker's, or the local-engine
//! lane's (`claude_code`). A tree whose descendants cannot be confirmed gone sets that latch,
//! and the lease loop stops taking work while any latch is set (`agent::runtime_reuse_is_safe`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Result, bail};
use sysinfo::{Pid, ProcessRefreshKind, System};

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

pub(crate) struct ProcessTree {
    root: Pid,
    identities: HashMap<Pid, u64>,
    system: System,
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
        let mut system = System::new();
        system.refresh_processes_specifics(ProcessRefreshKind::new());
        let root = Pid::from_u32(pid);
        let identities = system
            .process(root)
            .map(|process| HashMap::from([(root, process.start_time())]))
            .unwrap_or_default();
        Self {
            root,
            identities,
            system,
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
        self.system
            .refresh_processes_specifics(ProcessRefreshKind::new());
        loop {
            let new = self
                .system
                .processes()
                .iter()
                .filter_map(|(pid, process)| {
                    if self.identities.contains_key(pid) {
                        return None;
                    }
                    let parent = process.parent()?;
                    let known = self.identities.get(&parent)?;
                    let actual = self.system.process(parent)?;
                    (actual.start_time() == *known).then_some((*pid, process.start_time()))
                })
                .collect::<Vec<_>>();
            if new.is_empty() {
                break;
            }
            self.identities.extend(new);
        }
    }

    fn matching(&self, pid: Pid, start: u64) -> bool {
        self.system
            .process(pid)
            .is_some_and(|process| process.start_time() == start)
    }

    fn stop_and_kill(&mut self) {
        // Stop writers before walking again, so a still-running shell cannot fork between
        // discovery and termination. Retained identities also cover observed reparented tools.
        for _ in 0..8 {
            self.observe();
            let before = self.identities.len();
            #[cfg(unix)]
            for (pid, start) in &self.identities {
                if self.matching(*pid, *start) {
                    unsafe { libc::kill(pid.as_u32() as i32, libc::SIGSTOP) };
                }
            }
            self.observe();
            if self.identities.len() == before {
                break;
            }
        }
        // Stop every observed descendant before its parent; Windows additionally has the
        // worker's KILL_ON_JOB_CLOSE Job Object, installed before its CLI dispatch.
        #[cfg(unix)]
        if self
            .identities
            .get(&self.root)
            .is_some_and(|start| self.matching(self.root, *start))
        {
            let root = self.root.as_u32() as i32;
            // The supervisor created this distinct group. This also catches a not-yet-observed
            // fork that still belongs to it; tools that create new groups are tracked above.
            if unsafe { libc::getpgid(root) == root && libc::getpgrp() != root } {
                unsafe { libc::killpg(root, libc::SIGKILL) };
            }
        }
        for (pid, start) in &self.identities {
            if *pid != self.root
                && self.matching(*pid, *start)
                && let Some(process) = self.system.process(*pid)
            {
                process.kill();
            }
        }
        if let Some(start) = self.identities.get(&self.root)
            && self.matching(self.root, *start)
            && let Some(process) = self.system.process(self.root)
        {
            process.kill();
        }
    }

    /// How many observed descendants still run, the root left out: what the kill path is about
    /// to stop. It signals nothing. Fresh process records, as `terminate_and_confirm` reads
    /// them, so an exited child that waits to be reaped does not count.
    pub(crate) fn running_descendants(&mut self) -> usize {
        self.observe();
        let mut fresh = System::new();
        fresh.refresh_processes_specifics(ProcessRefreshKind::new());
        self.identities
            .iter()
            .filter(|(pid, start)| {
                **pid != self.root
                    && fresh.process(**pid).is_some_and(|process| {
                        process.start_time() == **start
                            && process.status() != sysinfo::ProcessStatus::Zombie
                    })
            })
            .count()
    }

    pub(crate) async fn terminate_and_confirm(&mut self) -> Result<()> {
        self.stop_and_kill();
        let deadline = tokio::time::Instant::now() + self.confirm_within;
        loop {
            // sysinfo 0.30's macOS refresh retains the initial BSD process status. A killed,
            // unreaped child can otherwise remain "Running" until its parent reaps it.
            // Fresh records distinguish inert zombies from live descendants on every platform.
            self.system = System::new();
            self.system
                .refresh_processes_specifics(ProcessRefreshKind::new());
            let alive = self.identities.iter().any(|(pid, start)| {
                self.matching(*pid, *start)
                    && self.system.process(*pid).is_some_and(|process| {
                        // On macOS sysinfo also maps an uninterruptible *thread* to Dead.
                        // Only an actual zombie is safe to disregard before parent reaping.
                        process.status() != sysinfo::ProcessStatus::Zombie
                    })
            });
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;

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

    /// Phase 4's measurement of what tracking costs (docs/Local-Engine-Turns.md 3.6): one tree
    /// observing every 50 ms, as a local-engine turn's does for as long as the turn runs, over
    /// `INSTAFY_PROCESS_TREE_MEASURE_SECONDS` (60 by default). It prints the CPU time it used.
    /// Run it by hand, alone, on the machine being measured:
    /// `cargo test --lib process_tree::tests::what_observing_every_50_ms_costs -- --ignored --nocapture`
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
