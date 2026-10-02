//! Time bounds for git commands that talk to a remote.
//!
//! The origin server runs these commands while holding per-project locks, so a
//! transfer that stops making progress has to fail instead of waiting forever.
//! Two layers apply:
//!
//! * curl's low-speed check (`http.lowSpeedLimit` / `http.lowSpeedTime`) fails a
//!   transfer whose rate stays under a floor for a whole window. It covers a
//!   server that accepts the connection and never answers, one that sends
//!   headers and then goes quiet, and a half-open connection mid-transfer.
//! * A process deadline is the backstop for what that check does not police,
//!   and stops the command together with every process it started. curl does
//!   not apply the check while it is still connecting, so an unanswered connect
//!   lasts until curl's 300 second connect timeout (or the OS SYN retry limit,
//!   if sooner), and a peer that keeps trickling bytes above the floor never
//!   trips it.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, ExitStatus, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};

/// How long a stopped command gets to remove its lock and temporary files
/// after SIGTERM before the rest of its process group is killed.
const TERMINATION_GRACE: Duration = Duration::from_secs(2);
const MAX_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NetworkGitLimits {
    /// Transfer rate, in bytes per second, below which curl counts an HTTP
    /// transfer as stalled.
    pub low_speed_bytes_per_second: u32,
    /// Seconds a transfer may stay below that rate before curl aborts it.
    pub low_speed_seconds: u32,
    /// Upper bound on one network git command, including connection setup.
    pub deadline: Duration,
}

impl NetworkGitLimits {
    /// Production bounds.
    ///
    /// The floor only has to separate "moving" from "stopped": curl compares a
    /// few-second moving average with it, and a healthy transfer across a
    /// private network moves megabytes per second, three orders of magnitude
    /// above 1000 B/s. The quiet phases of a healthy exchange are server
    /// compute time (building the pack before its first byte, indexing a
    /// pushed pack before the reply), during which the server sends at most a
    /// few bytes of keep-alive every few seconds. Building a full pack of a
    /// 142 MB, 122k-object repository takes about one second before the first
    /// byte, so a 60 second window leaves wide headroom.
    ///
    /// The deadline sits above curl's 300 second connect timeout plus the
    /// low-speed window, so it never cuts short a command that curl would end
    /// on its own, and at 10 MB/s it still allows a 6 GB transfer.
    pub(crate) const DEFAULT: Self = Self {
        low_speed_bytes_per_second: 1_000,
        low_speed_seconds: 60,
        deadline: Duration::from_secs(10 * 60),
    };
}

#[cfg(test)]
thread_local! {
    static LIMITS_OVERRIDE: std::cell::Cell<Option<NetworkGitLimits>> =
        const { std::cell::Cell::new(None) };
}

pub(crate) fn network_git_limits() -> NetworkGitLimits {
    #[cfg(test)]
    if let Some(limits) = LIMITS_OVERRIDE.with(std::cell::Cell::get) {
        return limits;
    }
    NetworkGitLimits::DEFAULT
}

/// Replaces the limits for git commands built on the current thread until the
/// guard is dropped, so stall tests can use second-scale bounds.
#[cfg(test)]
pub(crate) struct NetworkGitLimitsOverride {
    previous: Option<NetworkGitLimits>,
}

#[cfg(test)]
impl NetworkGitLimitsOverride {
    pub(crate) fn set(limits: NetworkGitLimits) -> Self {
        let previous = LIMITS_OVERRIDE.with(|cell| cell.replace(Some(limits)));
        Self { previous }
    }
}

#[cfg(test)]
impl Drop for NetworkGitLimitsOverride {
    fn drop(&mut self) {
        LIMITS_OVERRIDE.with(|cell| cell.set(self.previous));
    }
}

/// Apply the low-speed bound to every git command the server builds.
///
/// Only the HTTP transport reads these settings, so local commands are
/// unaffected. Git lets `GIT_HTTP_LOW_SPEED_*` override every config source,
/// so the environment is pinned to the same values; otherwise an inherited
/// value (for example a limit of 0) would silently remove the bound.
pub(crate) fn bound_http_transfer_speed(command: &mut Command, limits: NetworkGitLimits) {
    let bytes_per_second = limits.low_speed_bytes_per_second.to_string();
    let seconds = limits.low_speed_seconds.to_string();
    command
        .env("GIT_HTTP_LOW_SPEED_LIMIT", &bytes_per_second)
        .env("GIT_HTTP_LOW_SPEED_TIME", &seconds)
        .arg("-c")
        .arg(format!("http.lowSpeedLimit={bytes_per_second}"))
        .arg("-c")
        .arg(format!("http.lowSpeedTime={seconds}"));
}

/// Run a git command that talks to a remote and collect its output like
/// [`Command::output`], stopping it and every process it started if it is
/// still running after `deadline`.
///
/// The command runs in its own process group because git delegates the
/// transfer to a transport helper (`git-remote-http`): stopping only the
/// top-level process would leave the helper holding the stalled connection.
/// Output goes to temporary files rather than pipes so that a descendant
/// keeping an inherited descriptor open cannot block collection.
///
/// A stopped command is reported as a failed `Output` whose stderr explains
/// the deadline, so callers handle it like any other git failure.
pub(crate) fn output_within_deadline(
    command: &mut Command,
    operation: &str,
    deadline: Duration,
) -> Result<Output> {
    let mut stdout = tempfile::tempfile().context("failed to create git stdout buffer")?;
    let mut stderr = tempfile::tempfile().context("failed to create git stderr buffer")?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::from(
            stdout
                .try_clone()
                .context("failed to clone git stdout buffer")?,
        ))
        .stderr(Stdio::from(
            stderr
                .try_clone()
                .context("failed to clone git stderr buffer")?,
        ));
    #[cfg(unix)]
    command.process_group(0);

    let mut child = command.spawn().context("failed to start git")?;
    let started = Instant::now();
    let mut pause = Duration::from_millis(1);
    let (status, stopped) = loop {
        if let Some(status) = child.try_wait().context("failed to wait for git")? {
            break (status, false);
        }
        let elapsed = started.elapsed();
        if elapsed >= deadline {
            tracing::warn!(
                operation,
                ?deadline,
                "network git command exceeded its deadline; stopping it"
            );
            let status = stop_process_group(&mut child).context("failed to stop git")?;
            break (status, true);
        }
        thread::sleep(pause.min(deadline - elapsed));
        pause = (pause * 2).min(MAX_POLL_INTERVAL);
    };

    let stdout = read_captured(&mut stdout).context("failed to read git stdout")?;
    let mut stderr = read_captured(&mut stderr).context("failed to read git stderr")?;
    if stopped && !status.success() {
        stderr.extend_from_slice(
            format!(
                "\nerror: git {operation} did not finish within {deadline:?} and was stopped\n"
            )
            .as_bytes(),
        );
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

#[cfg(unix)]
fn stop_process_group(child: &mut Child) -> std::io::Result<ExitStatus> {
    use rustix::process::{kill_process_group, waitid, Pid, Signal, WaitId, WaitIdOptions};

    // The leader is reaped only by the final `wait`, so its pid, which is also
    // the process group id, cannot be reused while the group is signalled.
    let group = Pid::from_child(child);
    // SIGTERM first: git removes its lock and temporary files on SIGTERM, so
    // the next command on this workspace does not trip over a stale lock.
    let _ = kill_process_group(group, Signal::TERM);
    let grace_deadline = Instant::now() + TERMINATION_GRACE;
    while Instant::now() < grace_deadline {
        let leader_exited = waitid(
            WaitId::Pid(group),
            WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
        )?
        .is_some();
        if leader_exited {
            break;
        }
        thread::sleep(MAX_POLL_INTERVAL);
    }
    // Sweep whatever is left, including a helper whose parent already exited.
    let _ = kill_process_group(group, Signal::KILL);
    child.wait()
}

#[cfg(not(unix))]
fn stop_process_group(child: &mut Child) -> std::io::Result<ExitStatus> {
    let _ = child.kill();
    child.wait()
}

fn read_captured(file: &mut File) -> std::io::Result<Vec<u8>> {
    file.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn deadline_kills_a_process_group_that_ignores_sigterm() -> Result<()> {
        let mut command = Command::new("sh");
        // The shell and its child both ignore SIGTERM, so only the SIGKILL
        // sweep after the grace period can end them.
        command.args(["-c", "trap '' TERM; echo started; sleep 30 & wait"]);
        let started = Instant::now();
        let output = output_within_deadline(&mut command, "fetch", Duration::from_millis(100))?;
        let elapsed = started.elapsed();

        assert!(!output.status.success());
        assert!(
            elapsed >= TERMINATION_GRACE && elapsed < TERMINATION_GRACE + Duration::from_secs(5),
            "stop took {elapsed:?}"
        );
        assert_eq!(String::from_utf8_lossy(&output.stdout), "started\n");
        assert!(String::from_utf8_lossy(&output.stderr)
            .contains("git fetch did not finish within 100ms and was stopped"));
        Ok(())
    }

    #[test]
    fn commands_that_finish_in_time_match_command_output() -> Result<()> {
        let mut bounded = Command::new("sh");
        bounded.args(["-c", "printf out; printf err >&2; exit 3"]);
        let output = output_within_deadline(&mut bounded, "fetch", Duration::from_secs(30))?;

        let expected = Command::new("sh")
            .args(["-c", "printf out; printf err >&2; exit 3"])
            .output()?;
        assert_eq!(output.status.code(), expected.status.code());
        assert_eq!(output.stdout, expected.stdout);
        assert_eq!(output.stderr, expected.stderr);
        Ok(())
    }
}
