//! Proof that every Shared Browser MCP process is gone before browser authority returns to the
//! human.
//!
//! Upstream Codex (rust-v0.159) reports `ShutdownComplete` after a best-effort MCP shutdown: it
//! sends SIGTERM to each MCP process group and schedules SIGKILL from a detached thread, without
//! waiting for either. A Shared Browser MCP (or the `node` controller it runs, which shares its
//! process group) could therefore still drive the page after runtime-agent released the page to
//! the human. runtime-agent closes that gap itself:
//!
//! 1. Each run creates a registry directory and passes it to the Shared Browser MCP.
//! 2. The MCP, before it serves anything, checks that it leads its own process group (Codex
//!    spawns MCP servers in a new group) and records that group with an exclusive create.
//! 3. After `ShutdownComplete`, runtime-agent seals the registry (an atomic rename, so a late
//!    MCP can no longer register and refuses to serve), sends SIGKILL to every recorded group and
//!    waits until each is gone. Otherwise it fails, and the caller keeps the authority marker and
//!    recycles the runtime.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, Result, bail};

/// Environment variable naming the directory a Shared Browser MCP registers its group in.
pub const REGISTRY_ENV: &str = "INSTAFY_SHARED_BROWSER_PROCESS_GROUP_REGISTRY";

/// How long the recorded groups get to disappear after SIGKILL.
const CONFIRM_TIMEOUT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(20);
const OPEN_DIR: &str = "groups";
const SEALED_DIR: &str = "sealed";

/// One run's registry of Shared Browser MCP process groups.
pub(crate) struct McpProcessGroupRegistry {
    root: tempfile::TempDir,
}

impl McpProcessGroupRegistry {
    pub(crate) fn create() -> Result<Self> {
        let root = tempfile::Builder::new()
            .prefix("instafy-mcp-groups-")
            .tempdir()
            .context("failed to create the Shared Browser MCP process-group registry")?;
        std::fs::create_dir(root.path().join(OPEN_DIR))
            .context("failed to create the Shared Browser MCP process-group registry")?;
        Ok(Self { root })
    }

    /// The directory the MCP registers in; passed to it as `REGISTRY_ENV`.
    pub(crate) fn registration_dir(&self) -> PathBuf {
        self.root.path().join(OPEN_DIR)
    }

    /// Seals the registry, kills every recorded process group and waits until all are gone.
    pub(crate) async fn terminate_and_confirm(self) -> Result<()> {
        let groups = self.seal()?;
        confirm_groups_gone(&SystemProcessGroups, &groups, CONFIRM_TIMEOUT).await
    }

    fn seal(&self) -> Result<Vec<i32>> {
        let sealed = self.root.path().join(SEALED_DIR);
        std::fs::rename(self.registration_dir(), &sealed)
            .context("failed to seal the Shared Browser MCP process-group registry")?;
        let mut groups = Vec::new();
        for entry in std::fs::read_dir(&sealed)
            .context("failed to read the Shared Browser MCP process-group registry")?
        {
            let name = entry?.file_name();
            let group = name
                .to_str()
                .and_then(|name| name.parse::<i32>().ok())
                .filter(|group| *group > 1)
                .with_context(|| {
                    format!(
                        "unexpected entry {name:?} in the Shared Browser MCP process-group registry"
                    )
                })?;
            groups.push(group);
        }
        groups.sort_unstable();
        Ok(groups)
    }
}

/// Records this process's group in the registry named by `REGISTRY_ENV`. The Shared Browser MCP
/// calls it before serving, so a process that cannot be recorded never acts on the browser.
pub fn register_current_process_group() -> Result<()> {
    let directory = std::env::var_os(REGISTRY_ENV)
        .map(PathBuf::from)
        .context("Shared Browser MCP requires the runtime's process-group registry")?;
    register_process_group(&directory, current_process_ids()?)
}

#[derive(Clone, Copy, Debug)]
struct ProcessIds {
    pid: i32,
    group: i32,
    parent_group: i32,
}

#[cfg(unix)]
fn current_process_ids() -> Result<ProcessIds> {
    // SAFETY: these calls only read this process's identifiers.
    let (pid, group, parent) = unsafe { (libc::getpid(), libc::getpgrp(), libc::getppid()) };
    // SAFETY: as above; getpgid only reads the parent's group id.
    let parent_group = unsafe { libc::getpgid(parent) };
    if parent_group < 0 {
        return Err(std::io::Error::last_os_error())
            .context("failed to read the Shared Browser MCP parent's process group");
    }
    Ok(ProcessIds {
        pid,
        group,
        parent_group,
    })
}

#[cfg(not(unix))]
fn current_process_ids() -> Result<ProcessIds> {
    bail!("Shared Browser MCP requires POSIX process groups")
}

fn register_process_group(directory: &Path, ids: ProcessIds) -> Result<()> {
    // Codex starts every MCP server in a new process group. Anything else (an upstream change,
    // or a manual launch) could make the later SIGKILL hit the wrong group, so refuse to start.
    if ids.group != ids.pid || ids.group == ids.parent_group || ids.group <= 1 {
        bail!(
            "Shared Browser MCP must lead its own process group (pid {}, group {}, parent group {})",
            ids.pid,
            ids.group,
            ids.parent_group
        );
    }
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join(ids.group.to_string()))
        .with_context(|| {
            format!(
                "failed to register Shared Browser MCP process group {} (the turn's registry is sealed or already lists it)",
                ids.group
            )
        })?;
    Ok(())
}

/// The process-group operations confirmation needs; a trait so tests can stand in for the OS.
trait ProcessGroups {
    /// This process's own group, which must never be killed.
    fn own_group(&self) -> i32;
    /// SIGKILL the group; a group that is already gone is not an error.
    fn kill(&self, group: i32) -> std::io::Result<()>;
    /// Reap this process's own exited children in the group, so zombies do not count as alive.
    fn reap(&self, group: i32);
    /// Whether any process of the group still exists (EPERM counts as alive).
    fn exists(&self, group: i32) -> std::io::Result<bool>;
}

struct SystemProcessGroups;

#[cfg(unix)]
impl ProcessGroups for SystemProcessGroups {
    fn own_group(&self) -> i32 {
        // SAFETY: reads this process's group id.
        unsafe { libc::getpgrp() }
    }

    fn kill(&self, group: i32) -> std::io::Result<()> {
        // SAFETY: `group` is a recorded MCP group other than our own (checked by the caller).
        if unsafe { libc::killpg(group, libc::SIGKILL) } == 0 {
            return Ok(());
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(error)
    }

    fn reap(&self, group: i32) {
        // runtime-agent is often PID 1 in its container, so killed MCP descendants reparent to it
        // and stay zombies (still members of the group) until it reaps them.
        loop {
            let mut status = 0;
            // SAFETY: non-blocking wait for our own children in `group` only.
            let reaped = unsafe { libc::waitpid(-group, &mut status, libc::WNOHANG) };
            if reaped <= 0 {
                break;
            }
        }
    }

    fn exists(&self, group: i32) -> std::io::Result<bool> {
        // SAFETY: signal 0 only checks for existence and permission.
        if unsafe { libc::killpg(group, 0) } == 0 {
            return Ok(true);
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::ESRCH) => Ok(false),
            Some(libc::EPERM) => Ok(true),
            _ => Err(error),
        }
    }
}

#[cfg(not(unix))]
impl ProcessGroups for SystemProcessGroups {
    fn own_group(&self) -> i32 {
        0
    }

    fn kill(&self, _group: i32) -> std::io::Result<()> {
        Err(std::io::Error::other("process groups are unavailable"))
    }

    fn reap(&self, _group: i32) {}

    fn exists(&self, _group: i32) -> std::io::Result<bool> {
        Err(std::io::Error::other("process groups are unavailable"))
    }
}

async fn confirm_groups_gone(
    system: &impl ProcessGroups,
    groups: &[i32],
    timeout: Duration,
) -> Result<()> {
    let own_group = system.own_group();
    if let Some(group) = groups.iter().find(|group| **group == own_group) {
        bail!("refusing to kill runtime-agent's own process group {group}");
    }
    for group in groups {
        system
            .kill(*group)
            .with_context(|| format!("failed to kill Shared Browser MCP process group {group}"))?;
    }
    let deadline = tokio::time::Instant::now() + timeout;
    let mut remaining = groups.to_vec();
    loop {
        let mut alive = Vec::new();
        for group in remaining {
            system.reap(group);
            if system.exists(group).with_context(|| {
                format!("failed to probe Shared Browser MCP process group {group}")
            })? {
                alive.push(group);
            }
        }
        if alive.is_empty() {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            bail!(
                "Shared Browser MCP process groups {alive:?} survived SIGKILL for {} ms",
                timeout.as_millis()
            );
        }
        remaining = alive;
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::sync::Mutex;

    fn ids(pid: i32, group: i32, parent_group: i32) -> ProcessIds {
        ProcessIds {
            pid,
            group,
            parent_group,
        }
    }

    fn pid_exists(pid: i32) -> bool {
        // SAFETY: signal 0 only checks for existence.
        unsafe { libc::kill(pid, 0) == 0 }
    }

    async fn wait_for_pid_file(path: &Path) -> i32 {
        for _ in 0..200 {
            if let Some(pid) = std::fs::read_to_string(path)
                .ok()
                .and_then(|value| value.trim().parse().ok())
            {
                return pid;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out waiting for {}", path.display());
    }

    #[test]
    fn only_a_group_leader_distinct_from_its_parent_can_register_once() {
        let registry = McpProcessGroupRegistry::create().expect("registry");
        let directory = registry.registration_dir();
        assert!(register_process_group(&directory, ids(4321, 99, 4321)).is_err());
        assert!(register_process_group(&directory, ids(4321, 4321, 4321)).is_err());
        assert!(register_process_group(&directory, ids(1, 1, 0)).is_err());
        register_process_group(&directory, ids(4321, 4321, 1)).expect("group leader registers");
        assert!(
            register_process_group(&directory, ids(4321, 4321, 1)).is_err(),
            "registration is an exclusive create"
        );
        assert_eq!(registry.seal().expect("seal"), vec![4321]);
    }

    #[test]
    fn a_sealed_registry_accepts_no_late_registration() {
        let registry = McpProcessGroupRegistry::create().expect("registry");
        let directory = registry.registration_dir();
        assert_eq!(registry.seal().expect("seal"), Vec::<i32>::new());
        let error = register_process_group(&directory, ids(4321, 4321, 1))
            .expect_err("a late MCP must not register")
            .to_string();
        assert!(error.contains("sealed"), "{error}");
    }

    #[test]
    fn registration_reads_the_registry_from_the_mcp_environment() {
        // The MCP runs as a child process; without the registry it must refuse to serve.
        if std::env::var_os(REGISTRY_ENV).is_none() {
            assert!(
                register_current_process_group()
                    .expect_err("no registry")
                    .to_string()
                    .contains("process-group registry")
            );
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn confirmation_kills_a_term_ignoring_group_and_its_child() {
        let temp = tempfile::tempdir().expect("tempdir");
        let server_pid_file = temp.path().join("server.pid");
        let child_pid_file = temp.path().join("child.pid");
        // Like an MCP server stuck mid-action: it ignores SIGTERM and has a child of its own.
        let script = format!(
            "trap '' TERM; echo $$ > '{}'; sleep 300 & echo $! > '{}'; wait",
            server_pid_file.display(),
            child_pid_file.display()
        );
        let mut command = std::process::Command::new("/bin/sh");
        command.arg("-c").arg(script).process_group(0);
        let server = command.spawn().expect("spawn group leader");
        let server_pid = wait_for_pid_file(&server_pid_file).await;
        let child_pid = wait_for_pid_file(&child_pid_file).await;
        assert_eq!(server_pid, server.id() as i32);
        // What upstream Codex does at shutdown: SIGTERM, which this group ignores.
        // SAFETY: signals the test's own child group.
        unsafe { libc::killpg(server_pid, libc::SIGTERM) };
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(pid_exists(server_pid) && pid_exists(child_pid));

        let registry = McpProcessGroupRegistry::create().expect("registry");
        register_process_group(
            &registry.registration_dir(),
            ids(server_pid, server_pid, SystemProcessGroups.own_group()),
        )
        .expect("register");
        let started = std::time::Instant::now();
        registry
            .terminate_and_confirm()
            .await
            .expect("the group is confirmed gone");
        assert!(started.elapsed() < CONFIRM_TIMEOUT);
        assert!(!pid_exists(server_pid), "MCP server survived");
        assert!(!pid_exists(child_pid), "MCP server's child survived");
    }

    #[tokio::test]
    async fn confirmation_never_kills_runtime_agents_own_group() {
        let own = SystemProcessGroups.own_group();
        let error = confirm_groups_gone(&SystemProcessGroups, &[own], CONFIRM_TIMEOUT)
            .await
            .expect_err("own group")
            .to_string();
        assert!(error.contains("own process group"), "{error}");
    }

    /// A group that never disappears, as with a process stuck in uninterruptible sleep.
    struct StuckGroups {
        killed: Mutex<Vec<i32>>,
    }

    impl ProcessGroups for StuckGroups {
        fn own_group(&self) -> i32 {
            1
        }
        fn kill(&self, group: i32) -> std::io::Result<()> {
            self.killed.lock().unwrap().push(group);
            Ok(())
        }
        fn reap(&self, _group: i32) {}
        fn exists(&self, _group: i32) -> std::io::Result<bool> {
            Ok(true)
        }
    }

    #[tokio::test]
    async fn a_surviving_group_fails_confirmation_so_the_runtime_recycles() {
        let stuck = StuckGroups {
            killed: Mutex::new(Vec::new()),
        };
        let error = confirm_groups_gone(&stuck, &[4321, 4322], Duration::from_millis(60))
            .await
            .expect_err("a surviving group must not be confirmed")
            .to_string();
        assert!(error.contains("[4321, 4322]"), "{error}");
        assert_eq!(*stuck.killed.lock().unwrap(), vec![4321, 4322]);
    }
}
