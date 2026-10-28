//! Keeps the boot-time Shared Browser's Chromium running.
//!
//! On a browser session machine (`INSTAFY_ENABLE_BROWSER_SESSION=1` without a
//! lazy browser host) `docker/runtime/entrypoint.sh` launches Chromium once at
//! boot, or this process launches it after restoring a saved profile
//! (`browser_profile`). Before this module nothing started it again: once it
//! exited, the machine stayed up with no browser, and Studio said "Instafy's
//! browser did not open" on every try.
//!
//! The watch here checks Chromium every few seconds once it has seen it run,
//! and when it exits starts it again through the same
//! `runtime-entrypoint launch-chromium` the profile restore uses:
//!
//! - after 1, 5, 15, 30 and then 60 seconds for exits in a row (a browser that
//!   ran for two minutes counts as healthy again, so the next exit waits 1 s);
//! - at most 5 starts in any 10 minutes. Past that it gives up: it writes the
//!   reason to the browser's warning file, logs it, and starts nothing more
//!   until the machine restarts (a browser something else starts is watched
//!   again).
//!
//! Origin reports the state on the browser transports
//! (`origin_http_server::boot_browser`), and a Shared Browser job is refused
//! with that reason once the watch has given up.
//!
//! Every exit is logged with `event = "chromium_exited"`: the process's exit
//! status or signal when this process can reap it, how long it ran, whether
//! the machine's memory cgroup counted an OOM kill since the watch began, and
//! whether a Shared Browser run held the browser. A runtime that exits because
//! a turn's end could not confirm its browser tools stopped logs
//! `event = "runtime_exit"` instead (`shared_browser`), so the two causes of a
//! browser that "did not open" read apart in the machine's logs.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use origin_http_server::boot_browser::{
    BootBrowserHandle, BootBrowserSnapshot, BootBrowserState, BootBrowserStatus,
};
use tracing::{error, info, warn};

use crate::agent::ShutdownSignal;

const BROWSER_SESSION_ENV: &str = "INSTAFY_ENABLE_BROWSER_SESSION";
const RUNTIME_FLAVOR_ENV: &str = "INSTAFY_RUNTIME_FLAVOR";
/// Written by `start_headed_chromium_daemon` in the entrypoint.
const CHROMIUM_PID_FILE: &str = "/tmp/instafy/playwright/chromium.pid";
/// The entrypoint's own warning file; Chromium's output stays in its log.
const CHROMIUM_WARNING_FILE: &str = "/tmp/instafy/playwright/chromium-warning.txt";
const CHROMIUM_LOG_FILE: &str = "/tmp/instafy/playwright/chromium.log";
const POLL_INTERVAL: Duration = Duration::from_secs(2);

/// How often, and how soon, an exited Chromium is started again.
#[derive(Clone, Debug)]
pub(crate) struct RestartPolicy {
    /// The wait before each start of a run of exits in a row; the last one
    /// repeats.
    pub(crate) delays: Vec<Duration>,
    /// At most this many starts within [`RestartPolicy::window`].
    pub(crate) max_restarts: usize,
    pub(crate) window: Duration,
    /// A browser that ran this long before it exited starts a new run of
    /// exits.
    pub(crate) healthy_after: Duration,
}

impl Default for RestartPolicy {
    fn default() -> Self {
        Self {
            delays: [1, 5, 15, 30, 60].map(Duration::from_secs).to_vec(),
            max_restarts: 5,
            window: Duration::from_secs(10 * 60),
            healthy_after: Duration::from_secs(2 * 60),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    /// Start it again after this wait.
    Restart(Duration),
    /// The budget is used: start nothing more.
    GiveUp,
}

/// The starts the watch made, for [`RestartPolicy`].
#[derive(Debug, Default)]
pub(crate) struct RestartHistory {
    starts: VecDeque<Instant>,
    in_a_row: usize,
}

impl RestartHistory {
    /// What to do about a browser that exited (or did not start) at `now`
    /// after running for `ran_for`. A restart is counted as made.
    pub(crate) fn on_exit(
        &mut self,
        policy: &RestartPolicy,
        now: Instant,
        ran_for: Duration,
    ) -> Decision {
        if ran_for >= policy.healthy_after {
            self.in_a_row = 0;
        }
        while self
            .starts
            .front()
            .is_some_and(|start| now.saturating_duration_since(*start) >= policy.window)
        {
            self.starts.pop_front();
        }
        if self.starts.len() >= policy.max_restarts || policy.delays.is_empty() {
            return Decision::GiveUp;
        }
        let delay = policy.delays[self.in_a_row.min(policy.delays.len() - 1)];
        self.in_a_row += 1;
        self.starts.push_back(now);
        Decision::Restart(delay)
    }

    /// Starts made within the policy's window, as of the last decision.
    pub(crate) fn recent(&self) -> usize {
        self.starts.len()
    }
}

/// One Chromium process, told apart from a later one with the same pid by
/// its start time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChromiumId {
    pid: i32,
    /// `starttime` from `/proc/<pid>/stat`; 0 where there is no `/proc`.
    started: u64,
}

/// One process as `/proc` (or, without it, a signal 0) shows it.
#[derive(Debug, PartialEq, Eq)]
enum ProcessState {
    Running(ChromiumId),
    /// Exited, waiting for its parent to reap it.
    Zombie(ChromiumId),
    Gone,
}

/// `/proc/<pid>/stat` after the command name: the state, then field 22
/// (`starttime`).
fn parse_stat(stat: &str) -> Option<(char, u64)> {
    let (_, rest) = stat.rsplit_once(')')?;
    let mut fields = rest.split_whitespace();
    let state = fields.next()?.chars().next()?;
    // After the state come fields 4 to 21, then starttime.
    let started = fields.nth(18)?.parse().ok()?;
    Some((state, started))
}

fn read_pid(pid_file: &Path) -> Option<i32> {
    std::fs::read_to_string(pid_file)
        .ok()?
        .trim()
        .parse::<i32>()
        .ok()
        .filter(|pid| *pid > 1)
}

/// The state of `pid`. With `/proc`, a process whose command name does not
/// start with `command_prefix` is not the browser (its pid was reused).
fn process_state(pid: i32, command_prefix: Option<&str>) -> ProcessState {
    match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => {
            let named = command_prefix.is_none_or(|prefix| {
                std::fs::read_to_string(format!("/proc/{pid}/comm"))
                    .is_ok_and(|comm| comm.trim_start().starts_with(prefix))
            });
            match parse_stat(&stat) {
                _ if !named => ProcessState::Gone,
                Some(('Z' | 'X', started)) => ProcessState::Zombie(ChromiumId { pid, started }),
                Some((_, started)) => ProcessState::Running(ChromiumId { pid, started }),
                None => ProcessState::Gone,
            }
        }
        Err(_) if Path::new("/proc/self/stat").exists() => ProcessState::Gone,
        // No /proc (a developer's Mac): a signal 0 answers whether it runs.
        Err(_) => {
            // SAFETY: signal 0 only checks that the process exists.
            if unsafe { libc::kill(pid, 0) } == 0 {
                ProcessState::Running(ChromiumId { pid, started: 0 })
            } else {
                ProcessState::Gone
            }
        }
    }
}

/// The running browser the pid file names, if any.
fn running_from_pid_file(pid_file: &Path, command_prefix: Option<&str>) -> Option<ChromiumId> {
    match process_state(read_pid(pid_file)?, command_prefix) {
        ProcessState::Running(id) => Some(id),
        _ => None,
    }
}

/// How an exited Chromium ended, when this process is its parent (the
/// entrypoint's shell becomes runtime-agent, so the boot-time Chromium is its
/// child). Only a zombie with the start time the watch saw is reaped, so no
/// other child of this process can be.
fn reap(pid: i32) -> String {
    let mut status = 0;
    // SAFETY: WNOHANG never blocks; the pid is the zombie the watch saw.
    let reaped = unsafe { libc::waitpid(pid, &mut status, libc::WNOHANG) };
    if reaped != pid {
        return "exit status unavailable (not this process's child)".to_string();
    }
    describe_wait_status(status)
}

pub(crate) fn describe_wait_status(status: i32) -> String {
    if libc::WIFEXITED(status) {
        format!("exited with status {}", libc::WEXITSTATUS(status))
    } else if libc::WIFSIGNALED(status) {
        let signal = libc::WTERMSIG(status);
        let name = match signal {
            libc::SIGKILL => " (SIGKILL)",
            libc::SIGTERM => " (SIGTERM)",
            libc::SIGSEGV => " (SIGSEGV)",
            libc::SIGABRT => " (SIGABRT)",
            libc::SIGBUS => " (SIGBUS)",
            libc::SIGTRAP => " (SIGTRAP)",
            libc::SIGILL => " (SIGILL)",
            _ => "",
        };
        format!("killed by signal {signal}{name}")
    } else {
        format!("ended with wait status {status}")
    }
}

/// The OOM kills the machine's memory cgroup has counted (cgroup v2, then v1).
fn cgroup_oom_kills() -> Option<u64> {
    for path in [
        "/sys/fs/cgroup/memory.events",
        "/sys/fs/cgroup/memory/memory.oom_control",
    ] {
        if let Ok(text) = std::fs::read_to_string(path)
            && let Some(count) = text.lines().find_map(|line| {
                line.strip_prefix("oom_kill ")
                    .and_then(|value| value.trim().parse().ok())
            })
        {
            return Some(count);
        }
    }
    None
}

#[derive(Clone)]
pub(crate) struct WatchConfig {
    pub(crate) pid_file: PathBuf,
    pub(crate) warning_file: PathBuf,
    pub(crate) entrypoint: String,
    pub(crate) poll: Duration,
    pub(crate) policy: RestartPolicy,
    /// The start of the browser's command name (`/proc/<pid>/comm`), so a
    /// reused pid is not taken for it.
    pub(crate) command_prefix: Option<&'static str>,
}

impl WatchConfig {
    fn for_process() -> Self {
        Self {
            pid_file: PathBuf::from(CHROMIUM_PID_FILE),
            warning_file: PathBuf::from(CHROMIUM_WARNING_FILE),
            entrypoint: crate::browser_profile::entrypoint_path(),
            poll: POLL_INTERVAL,
            policy: RestartPolicy::default(),
            // Playwright's "chrome", Debian's "chromium".
            command_prefix: Some("chrom"),
        }
    }
}

#[derive(Debug)]
struct WatchStatus {
    state: BootBrowserState,
    /// The Chromium the watch saw last, while it runs.
    running: Option<i32>,
}

/// The watch's state, read by origin and by the Shared Browser job gate.
pub struct BootBrowserWatch {
    status: Mutex<WatchStatus>,
}

impl BootBrowserWatch {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            status: Mutex::new(WatchStatus {
                state: BootBrowserState::Running,
                running: None,
            }),
        })
    }

    fn set(&self, state: BootBrowserState, running: Option<i32>) {
        if let Ok(mut status) = self.status.lock() {
            status.state = state;
            status.running = running;
        }
    }

    fn state(&self) -> BootBrowserState {
        self.status
            .lock()
            .map(|status| status.state)
            .unwrap_or(BootBrowserState::Running)
    }

    /// A short fixed description for a log line.
    fn describe(&self) -> String {
        match self.status.lock() {
            Ok(status) => match (status.state, status.running) {
                (BootBrowserState::Running, Some(pid)) => format!("running (pid {pid})"),
                (BootBrowserState::Running, None) => "not seen running yet".to_string(),
                (BootBrowserState::Restarting, _) => "restarting".to_string(),
                (BootBrowserState::Stopped, _) => "stopped (no longer restarted)".to_string(),
            },
            Err(_) => "unknown".to_string(),
        }
    }
}

impl BootBrowserStatus for BootBrowserWatch {
    fn snapshot(&self) -> BootBrowserSnapshot {
        BootBrowserSnapshot {
            state: self.state(),
        }
    }
}

static WATCH: OnceLock<Arc<BootBrowserWatch>> = OnceLock::new();

#[cfg(test)]
thread_local! {
    static TEST_WATCH: std::cell::RefCell<Option<Arc<BootBrowserWatch>>> =
        const { std::cell::RefCell::new(None) };
}

/// The process's watch, when this process runs one.
fn current() -> Option<Arc<BootBrowserWatch>> {
    #[cfg(test)]
    if let Some(watch) = TEST_WATCH.with(|watch| watch.borrow().clone()) {
        return Some(watch);
    }
    WATCH.get().cloned()
}

/// Makes `watch` this thread's process watch until the guard drops.
#[cfg(test)]
pub(crate) fn install_watch_for_tests(watch: Arc<BootBrowserWatch>) -> TestWatchGuard {
    let previous = TEST_WATCH.with(|slot| slot.replace(Some(watch)));
    TestWatchGuard { previous }
}

#[cfg(test)]
pub(crate) struct TestWatchGuard {
    previous: Option<Arc<BootBrowserWatch>>,
}

#[cfg(test)]
impl Drop for TestWatchGuard {
    fn drop(&mut self) {
        let previous = self.previous.take();
        TEST_WATCH.with(|slot| *slot.borrow_mut() = previous);
    }
}

/// Whether this process keeps a boot-time Chromium running: a browser
/// session machine without a lazy host, on an image that starts a browser at
/// boot.
fn supervises_boot_browser() -> bool {
    let session = std::env::var(BROWSER_SESSION_ENV)
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "yes" | "on"));
    let base_image = std::env::var(RUNTIME_FLAVOR_ENV)
        .ok()
        .is_some_and(|flavor| flavor.trim() == "base");
    session && !base_image && !crate::browser_host::lazy_mode()
}

/// Starts the process's watch once, on a browser session machine; nothing
/// otherwise. Call it inside the Tokio runtime.
pub fn install(shutdown: ShutdownSignal) {
    if !supervises_boot_browser() || WATCH.get().is_some() {
        return;
    }
    let watch = BootBrowserWatch::new();
    if WATCH.set(watch.clone()).is_err() {
        return;
    }
    tokio::spawn(run_watch(watch, WatchConfig::for_process(), shutdown));
}

/// What origin's browser transports read; `None` without a watch.
pub fn origin_handle() -> Option<BootBrowserHandle> {
    current().map(|watch| watch as BootBrowserHandle)
}

/// Why a Shared Browser job cannot run here, once the watch has given up.
pub(crate) fn unavailable_reason() -> Option<&'static str> {
    current()
        .filter(|watch| watch.state() == BootBrowserState::Stopped)
        .map(|_| {
            "Instafy's browser stopped on this space's machine and was not started again. Restart the machine, then try again."
        })
}

/// The watch's view of Chromium, for another module's log line.
pub(crate) fn chromium_state_for_log() -> String {
    current()
        .map(|watch| watch.describe())
        .unwrap_or_else(|| "not supervised".to_string())
}

struct Watched {
    id: ChromiumId,
    since: Instant,
}

/// Starts Chromium again through the entrypoint and reports the process it
/// started, if one runs.
async fn start_again(config: &WatchConfig) -> Option<ChromiumId> {
    if let Err(error) =
        crate::browser_profile::launch_chromium_unless_running(&config.entrypoint, &config.pid_file)
            .await
    {
        warn!(
            event = "chromium_restart_failed",
            ?error,
            "Shared Browser: the Chromium launcher failed"
        );
    }
    running_from_pid_file(&config.pid_file, config.command_prefix)
}

/// Sleeps `delay` unless shutdown comes first; false on shutdown.
async fn wait_or_shutdown(delay: Duration, shutdown: &ShutdownSignal) -> bool {
    tokio::select! {
        biased;
        _ = shutdown.cancelled() => false,
        _ = tokio::time::sleep(delay) => !shutdown.is_cancelled(),
    }
}

pub(crate) async fn run_watch(
    watch: Arc<BootBrowserWatch>,
    config: WatchConfig,
    shutdown: ShutdownSignal,
) {
    let oom_at_start = cgroup_oom_kills();
    let mut history = RestartHistory::default();
    let mut watched: Option<Watched> = None;
    loop {
        if !wait_or_shutdown(config.poll, &shutdown).await {
            return;
        }
        let named = running_from_pid_file(&config.pid_file, config.command_prefix);
        let Some(current) = watched.as_ref() else {
            // Nothing seen running yet: nothing to keep running until it is.
            if let Some(id) = named {
                watched = Some(Watched {
                    id,
                    since: Instant::now(),
                });
                watch.set(BootBrowserState::Running, Some(id.pid));
            }
            continue;
        };
        let (id, since) = (current.id, current.since);
        // The process itself is checked, not only the pid file, which a
        // launcher rewrites.
        let state = process_state(id.pid, config.command_prefix);
        let exited = match state {
            ProcessState::Running(now) => now != id,
            ProcessState::Zombie(_) | ProcessState::Gone => true,
        };
        match named {
            // Started by someone else (a profile restore after a new
            // registration): watch that one, without a restart.
            Some(other) if other != id => {
                info!(
                    event = "chromium_replaced",
                    pid = other.pid,
                    "Shared Browser: watching the Chromium started by the profile restore"
                );
                watched = Some(Watched {
                    id: other,
                    since: Instant::now(),
                });
                watch.set(BootBrowserState::Running, Some(other.pid));
                continue;
            }
            _ if !exited => continue,
            _ => {}
        }
        let status = match state {
            ProcessState::Zombie(zombie) if zombie == id => reap(zombie.pid),
            _ => "exit status unavailable (already reaped)".to_string(),
        };
        let mut ran_for = since.elapsed();
        warn!(
            event = "chromium_exited",
            pid = id.pid,
            status = %status,
            uptime_secs = ran_for.as_secs(),
            oom_kills_since_watch_start = oom_at_start
                .zip(cgroup_oom_kills())
                .map(|(start, now)| now.saturating_sub(start)),
            agent_run_active = crate::shared_browser::agent_control_marker_present(),
            "Shared Browser: Chromium exited; see {CHROMIUM_LOG_FILE}"
        );
        watched = None;
        loop {
            match history.on_exit(&config.policy, Instant::now(), ran_for) {
                Decision::GiveUp => {
                    let message = format!(
                        "Instafy's browser stopped {} times in {} minutes and was not started again. Restart this machine to open it. See {CHROMIUM_LOG_FILE}.",
                        config.policy.max_restarts + 1,
                        config.policy.window.as_secs() / 60,
                    );
                    if let Some(parent) = config.warning_file.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    let _ = std::fs::write(&config.warning_file, format!("{message}\n"));
                    watch.set(BootBrowserState::Stopped, None);
                    error!(
                        event = "chromium_restart_gave_up",
                        restarts = config.policy.max_restarts,
                        window_secs = config.policy.window.as_secs(),
                        "Shared Browser: {message}"
                    );
                    break;
                }
                Decision::Restart(delay) => {
                    watch.set(BootBrowserState::Restarting, None);
                    info!(
                        event = "chromium_restart_scheduled",
                        delay_ms = delay.as_millis() as u64,
                        restarts_in_window = history.recent(),
                        "Shared Browser: starting Chromium again"
                    );
                    if !wait_or_shutdown(delay, &shutdown).await {
                        return;
                    }
                    if let Some(started) = start_again(&config).await {
                        watched = Some(Watched {
                            id: started,
                            since: Instant::now(),
                        });
                        watch.set(BootBrowserState::Running, Some(started.pid));
                        info!(
                            event = "chromium_restarted",
                            pid = started.pid,
                            restarts_in_window = history.recent(),
                            "Shared Browser: Chromium started again"
                        );
                        // A browser that started again has none of Octo's
                        // earlier tabs; the record of them is settled now.
                        let _ = tokio::task::spawn_blocking(
                            crate::shared_browser::close_leftover_agent_tabs_after_browser_start,
                        )
                        .await;
                        break;
                    }
                    warn!(
                        event = "chromium_restart_failed",
                        "Shared Browser: Chromium did not start again; see {CHROMIUM_LOG_FILE}"
                    );
                    ran_for = Duration::ZERO;
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "boot_browser_tests.rs"]
mod tests;
