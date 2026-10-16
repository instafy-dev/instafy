//! Retain child identities across polls: a shell may create another process group/session.
//! Cooperative Codex shutdown is the primary path; this guard handles failures and dropped runs.

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Result, bail};
use sysinfo::{Pid, ProcessRefreshKind, System};

pub(super) fn prepare_child() -> Result<()> {
    #[cfg(target_os = "linux")]
    {
        // Detached grandchildren reparent to this worker, not init, while it is alive.
        if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
            return Err(std::io::Error::last_os_error().into());
        }
    }
    Ok(())
}

pub(super) struct ProcessTree {
    root: Pid,
    identities: HashMap<Pid, u64>,
    system: System,
    armed: bool,
}

impl ProcessTree {
    pub(super) fn new(pid: u32) -> Self {
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
        }
    }

    pub(super) fn observe(&mut self) {
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

    pub(super) async fn terminate_and_confirm(&mut self) -> Result<()> {
        self.stop_and_kill();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
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
            if !alive {
                self.armed = false;
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                super::mark_cleanup_unconfirmed();
                bail!("isolated worker descendants survived termination");
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
            super::mark_cleanup_unconfirmed();
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
        let mut unrelated = tokio::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30"])
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut other_tree = ProcessTree::new(unrelated.id().unwrap());
        let mut root = tokio::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30 & printf '%s\\n' $!; wait"])
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut tree = ProcessTree::new(root.id().unwrap());
        let mut line = String::new();
        tokio::io::BufReader::new(root.stdout.take().unwrap())
            .read_line(&mut line)
            .await
            .unwrap();
        let descendant = Pid::from_u32(line.trim().parse().unwrap());
        tree.observe();
        assert!(tree.identities.contains_key(&descendant));
        let result = tree.terminate_and_confirm().await;
        let other_alive = unrelated.try_wait().unwrap().is_none();
        let _ = other_tree.terminate_and_confirm().await;
        let _ = root.wait().await;
        let _ = unrelated.wait().await;
        result.unwrap();
        assert!(
            other_alive,
            "termination crossed the worker process boundary"
        );
    }
}
