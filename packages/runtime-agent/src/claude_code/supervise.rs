//! Running and stopping a local-engine turn's `claude` process (docs/Local-Engine-Turns.md, 3.6).
//!
//! - **Spawn.** The command [`super::command::turn_command`] built: a cleared environment holding
//!   only the allowlist, the space's folder as working directory, piped stdio and `kill_on_drop`.
//!   No `process_group(0)`: `claude` stays in runtime-agent's own process group, which Desktop
//!   signals and proves gone as a unit. The prompt goes to stdin, then EOF.
//! - **Tracking.** A [`ProcessTree`] observes `claude`'s descendants every 50 ms and keeps the
//!   reparented ones it has seen. The root is no group leader, so they are killed one by one.
//! - **Bounds.** A stdout line over 8 MiB, or more than 50 lines that do not parse, fails the turn
//!   as `crashed`. stderr keeps its last 16 KiB, for classification and Details only.
//! - **Stop.** SIGTERM to the `claude` pid only (never the group, which holds the runtime), up to
//!   5 s, then `terminate_and_confirm`, which stops and kills every observed process and confirms
//!   they are gone. When that cannot be confirmed, the cleanup latch stops leasing.
//! - **Timeouts.** A wall clock ([`TURN_TIMEOUT_ENV`], 2700 s by default, 60 to 3000 s) and a
//!   15-minute stall with no stream event, both through the stop path.
//! - **End of the turn.** A top-level `result` with no background task live but a command, a
//!   Monitor watch or an ambient one ends the turn ([`super::events`]): the runtime stops `claude`
//!   as for a Stop and ignores what it prints afterwards. Exit 143 after that SIGTERM counts as 0.
//! - **Every exit.** `terminate_and_confirm` runs whatever ended the turn. The outcome counts the
//!   programs the turn left running that it stopped, for the status step that says so.
//! - **Shutdown.** While the runtime's shutdown signal is set, the turn reports nothing.

use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::process::ExitStatus;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, PoisonError};
use std::time::Duration;

use serde_json::Value;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{ChildStdout, Command};
use tokio::task::JoinHandle;
use tokio::time::{Instant, MissedTickBehavior};
use tracing::{debug, info, warn};

use super::FailureCode;
use super::command::write_prompt;
use super::events::{AdapterStatus, EventAdapter, ExitFacts, LaneFailure};
use crate::agent::ShutdownSignal;
use crate::job_cancel::JobCancelSignal;
use crate::process_tree::ProcessTree;

/// The wall clock of one lane turn, in seconds (3.6).
pub const TURN_TIMEOUT_ENV: &str = "INSTAFY_CLAUDE_CODE_TURN_TIMEOUT_SECONDS";
pub const DEFAULT_TURN_TIMEOUT: Duration = Duration::from_secs(2_700);
/// The range [`TURN_TIMEOUT_ENV`] is accepted in. The cap leaves at least 600 s of the job's
/// workspace token, which nothing renews, for the steps before the spawn and for the save.
pub const MIN_TURN_TIMEOUT_SECONDS: u64 = 60;
pub const MAX_TURN_TIMEOUT_SECONDS: u64 = 3_000;
/// How long a turn may go without a stream event (3.6).
pub const STALL_LIMIT: Duration = Duration::from_secs(15 * 60);
/// How long `claude` gets to exit after the runtime's SIGTERM (3.6).
pub const STOP_GRACE: Duration = Duration::from_secs(5);
/// How often the process tree is observed, as the isolated worker polls it.
pub const OBSERVE_EVERY: Duration = Duration::from_millis(50);
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_UNPARSED_LINES: usize = 50;
pub const STDERR_TAIL_BYTES: usize = 16 * 1024;
/// Claude Code's documented exit status on SIGTERM.
pub const EXIT_ON_SIGTERM: i32 = 143;

/// How long the rest of stdout is read once `claude` exited by itself: a process it left
/// behind may hold the pipe open.
const AFTER_EXIT_DRAIN: Duration = Duration::from_secs(2);
/// How long the killed root gets to be reaped.
const REAP_WITHIN: Duration = Duration::from_secs(3);
/// How long the stderr reader gets to finish once `claude` is gone.
const STDERR_WITHIN: Duration = Duration::from_secs(1);
const READ_CHUNK_BYTES: usize = 64 * 1024;

/// The wall clock of a turn from the [`TURN_TIMEOUT_ENV`] setting: its seconds when they are
/// within 60 to 3000, otherwise the default, 2700.
pub fn turn_timeout(setting: Option<&str>) -> Duration {
    let Some(setting) = setting.map(str::trim).filter(|setting| !setting.is_empty()) else {
        return DEFAULT_TURN_TIMEOUT;
    };
    match setting.parse::<u64>() {
        Ok(seconds) if (MIN_TURN_TIMEOUT_SECONDS..=MAX_TURN_TIMEOUT_SECONDS).contains(&seconds) => {
            Duration::from_secs(seconds)
        }
        _ => {
            warn!(
                setting,
                "{TURN_TIMEOUT_ENV} is not a number of seconds from {MIN_TURN_TIMEOUT_SECONDS} to {MAX_TURN_TIMEOUT_SECONDS}; a lane turn gets the default"
            );
            DEFAULT_TURN_TIMEOUT
        }
    }
}

/// The limits of a turn, and the cleanup latch its process tree sets.
#[derive(Clone, Debug)]
pub struct TurnLimits {
    wall_clock: Duration,
    stall: Duration,
    stop_grace: Duration,
    observe_every: Duration,
    max_line_bytes: usize,
    max_unparsed_lines: usize,
    stderr_tail_bytes: usize,
    cleanup_latch: &'static AtomicBool,
    /// For tests of the unconfirmed cleanup: a process of the turn outlives every kill.
    #[cfg(test)]
    unkillable: bool,
}

impl TurnLimits {
    /// The limits of 3.6, with the wall clock as the runtime was launched with it, and the
    /// lane's own cleanup latch ([`super::runtime_reuse_is_safe`]).
    pub fn standard() -> Self {
        Self {
            wall_clock: turn_timeout(super::turn_timeout_setting().as_deref()),
            stall: STALL_LIMIT,
            stop_grace: STOP_GRACE,
            observe_every: OBSERVE_EVERY,
            max_line_bytes: MAX_LINE_BYTES,
            max_unparsed_lines: MAX_UNPARSED_LINES,
            stderr_tail_bytes: STDERR_TAIL_BYTES,
            cleanup_latch: &super::CLEANUP_UNCONFIRMED,
            #[cfg(test)]
            unkillable: false,
        }
    }

    /// For tests of the unconfirmed cleanup: one process of the turn outlives every kill, which
    /// nothing hermetic does otherwise.
    #[cfg(test)]
    pub(crate) fn with_a_process_that_outlives_the_kill(mut self) -> Self {
        self.unkillable = true;
        self
    }

    pub fn wall_clock(&self) -> Duration {
        self.wall_clock
    }

    pub fn stall(&self) -> Duration {
        self.stall
    }

    /// For tests of the limit itself: no test waits 45 minutes.
    pub fn with_wall_clock(mut self, limit: Duration) -> Self {
        self.wall_clock = limit;
        self
    }

    /// For tests of the limit itself.
    pub fn with_stall(mut self, limit: Duration) -> Self {
        self.stall = limit;
        self
    }

    /// For tests of the kill path after a SIGTERM that `claude` ignores.
    pub fn with_stop_grace(mut self, grace: Duration) -> Self {
        self.stop_grace = grace;
        self
    }

    /// For tests of the line bound with a line of a size that is quick to print.
    pub fn with_max_line_bytes(mut self, bytes: usize) -> Self {
        self.max_line_bytes = bytes;
        self
    }

    /// Another latch than the lane's, for tests: a test that set the lane's own would stop every
    /// later turn of its process.
    pub fn with_cleanup_latch(mut self, latch: &'static AtomicBool) -> Self {
        self.cleanup_latch = latch;
        self
    }
}

/// What a turn runs with, besides its command.
pub struct TurnSpec<'a> {
    /// Exactly the person's recorded message (3.5).
    pub prompt: &'a str,
    /// `--resume` was passed, so a missing-session exit before `init` is `session_unavailable`.
    pub resumed: bool,
    /// The job's cancel signal: a Stop (the heartbeat's 409, or a refused message post).
    pub stop: &'a JobCancelSignal,
    /// The runtime's shutdown signal.
    pub shutdown: &'a ShutdownSignal,
}

/// How a turn ended.
#[derive(Debug)]
pub enum TurnEnd {
    /// Exit 0, or 143 after the runtime's own SIGTERM, and a latest top-level `result` that is
    /// no error, after launch checks that passed. The adapter has its reply and usage.
    Succeeded,
    /// Nothing is saved.
    Failed(LaneFailure),
    /// A Stop: there is no completion, and the executor sends the stopped-turn report.
    Stopped,
    /// The runtime is shutting down: the turn reports nothing.
    Shutdown,
}

#[derive(Debug)]
pub struct TurnOutcome {
    pub end: TurnEnd,
    /// `claude`'s exit, once it was reaped.
    pub exit_status: Option<ExitStatus>,
    /// Every process the tracker saw is gone and `claude` was reaped. When not, the cleanup
    /// latch is set and the runtime takes no more work.
    pub cleanup_confirmed: bool,
    /// The last 16 KiB of `claude`'s stderr, redacted: for Details only.
    pub stderr: String,
    /// Lines printed after the turn ended, which the turn ignored.
    pub ignored_lines: usize,
    /// The programs the turn left running, which the kill path stopped once `claude` was done
    /// (3.6): a status step says how many.
    pub programs_stopped: usize,
}

impl TurnOutcome {
    fn before_start(end: TurnEnd) -> Self {
        Self {
            end,
            exit_status: None,
            cleanup_confirmed: true,
            stderr: String::new(),
            ignored_lines: 0,
            programs_stopped: 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum StopReason {
    EndOfTurn,
    Stop,
    Shutdown,
    WallClock,
    Stalled,
    /// A launch check failed; the adapter's status says which.
    Unexpected,
    Crashed(String),
}

struct Stopping {
    reason: StopReason,
    grace_until: Instant,
    /// The runtime sent its SIGTERM while `claude` still ran.
    term_sent: bool,
}

/// A task that is aborted when dropped.
struct OwnedTask<T>(Option<JoinHandle<T>>);

impl<T: Send + 'static> OwnedTask<T> {
    fn spawn(future: impl Future<Output = T> + Send + 'static) -> Self {
        Self(Some(tokio::spawn(future)))
    }

    async fn join_within(mut self, limit: Duration) -> Option<T> {
        let mut handle = self.0.take()?;
        match tokio::time::timeout(limit, &mut handle).await {
            Ok(joined) => joined.ok(),
            Err(_) => {
                handle.abort();
                None
            }
        }
    }
}

impl<T> Drop for OwnedTask<T> {
    fn drop(&mut self) {
        if let Some(handle) = self.0.take() {
            handle.abort();
        }
    }
}

/// stdout, split into lines of at most `max` bytes. A longer line is reported once, and its
/// bytes are dropped up to its end.
struct Lines {
    pending: Vec<u8>,
    max: usize,
    skipping: bool,
}

enum Line {
    Complete(Vec<u8>),
    TooLong,
}

impl Line {
    fn is_blank(&self) -> bool {
        matches!(self, Line::Complete(bytes) if bytes.trim_ascii().is_empty())
    }
}

impl Lines {
    fn new(max: usize) -> Self {
        Self {
            pending: Vec::new(),
            max,
            skipping: false,
        }
    }

    fn push(&mut self, mut bytes: &[u8], lines: &mut Vec<Line>) {
        while !bytes.is_empty() {
            let Some(end) = bytes.iter().position(|byte| *byte == b'\n') else {
                if !self.skipping {
                    if self.pending.len() + bytes.len() > self.max {
                        lines.push(Line::TooLong);
                        self.pending = Vec::new();
                        self.skipping = true;
                    } else {
                        self.pending.extend_from_slice(bytes);
                    }
                }
                return;
            };
            if self.skipping {
                self.skipping = false;
            } else if self.pending.len() + end > self.max {
                lines.push(Line::TooLong);
                self.pending.clear();
            } else {
                self.pending.extend_from_slice(&bytes[..end]);
                lines.push(Line::Complete(std::mem::take(&mut self.pending)));
            }
            bytes = &bytes[end + 1..];
        }
    }

    /// The last line, when stdout ended without a newline.
    fn finish(&mut self) -> Option<Vec<u8>> {
        if self.skipping || self.pending.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.pending))
    }
}

async fn read_some(stdout: &mut Option<ChildStdout>, buffer: &mut [u8]) -> io::Result<usize> {
    match stdout {
        Some(stdout) => stdout.read(buffer).await,
        None => std::future::pending().await,
    }
}

/// The last bytes a stream printed, kept as they are read: a reader stopped before the stream
/// ended, because a process left behind holds it open, still leaves what it read.
#[derive(Clone)]
struct Tail {
    keep: usize,
    kept: Arc<std::sync::Mutex<Kept>>,
}

#[derive(Default)]
struct Kept {
    bytes: VecDeque<u8>,
    /// More was read than is kept.
    cut: bool,
}

impl Tail {
    fn new(keep: usize) -> Self {
        Self {
            keep,
            kept: Arc::default(),
        }
    }

    fn kept(&self) -> std::sync::MutexGuard<'_, Kept> {
        self.kept.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Reads `reader` to its end, keeping its last bytes.
    async fn read(self, mut reader: impl AsyncRead + Unpin) {
        let mut chunk = vec![0u8; 8 * 1024];
        loop {
            match reader.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let mut kept = self.kept();
                    kept.bytes.extend(&chunk[..read]);
                    let excess = kept.bytes.len().saturating_sub(self.keep);
                    kept.cut |= excess > 0;
                    kept.bytes.drain(..excess);
                }
            }
        }
    }

    /// What was read so far, at most the last `keep` bytes. When more was read, the first line
    /// kept is cut short, and is left out: a cut inside a path would leave a part of it that
    /// redaction no longer recognizes.
    fn bytes(&self) -> Vec<u8> {
        let kept = self.kept();
        let mut tail: Vec<u8> = kept.bytes.iter().copied().collect();
        if kept.cut {
            let start = tail
                .iter()
                .position(|byte| *byte == b'\n')
                .or_else(|| tail.iter().position(u8::is_ascii_whitespace))
                .map_or(tail.len(), |at| at + 1);
            tail.drain(..start);
        }
        tail
    }
}

/// SIGTERM to `claude`'s pid only: the group holds runtime-agent itself.
fn send_sigterm(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        // SAFETY: kill has no memory-safety preconditions. `pid` is `claude`'s, which the
        // runtime has not reaped yet, so it names no other process.
        unsafe { libc::kill(pid, libc::SIGTERM) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

/// Whether `claude`'s exit counts as 0 (3.6): it was 0, or 143 after the runtime's own SIGTERM
/// at the end of the turn.
pub fn exit_counts_as_zero(code: Option<i32>, after_own_sigterm: bool) -> bool {
    code == Some(0) || (after_own_sigterm && code == Some(EXIT_ON_SIGTERM))
}

fn exit_signal(status: Option<ExitStatus>) -> Option<i32> {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        status.and_then(|status| status.signal())
    }
    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

/// Reads one line of `claude`'s stdout into the turn: an event for the adapter, whose events go
/// to `on_event`, a line that does not parse, or one over the bound. Returns why the turn must
/// end now, when it must.
fn take_line(
    line: Line,
    adapter: &mut EventAdapter,
    on_event: &mut (dyn FnMut(&Value) + Send),
    unparsed: &mut usize,
    last_event: &mut Instant,
    limits: &TurnLimits,
) -> Option<StopReason> {
    let bytes = match line {
        Line::TooLong => {
            return Some(StopReason::Crashed(format!(
                "Claude Code printed a line longer than {} bytes.",
                limits.max_line_bytes
            )));
        }
        Line::Complete(bytes) => bytes,
    };
    let text = bytes.trim_ascii();
    if text.is_empty() {
        return None;
    }
    let parsed = serde_json::from_slice::<Value>(text)
        .ok()
        .filter(Value::is_object);
    let Some(value) = parsed else {
        *unparsed += 1;
        adapter.note_unparsed(text);
        return (*unparsed > limits.max_unparsed_lines).then(|| {
            StopReason::Crashed(format!(
                "Claude Code printed more than {} lines Instafy could not read.",
                limits.max_unparsed_lines
            ))
        });
    };
    *last_event = Instant::now();
    for event in adapter.feed(&value) {
        on_event(&event);
    }
    match adapter.status() {
        AdapterStatus::Running => None,
        AdapterStatus::EndOfTurn => Some(StopReason::EndOfTurn),
        AdapterStatus::Unexpected(_) => Some(StopReason::Unexpected),
    }
}

/// Whether a turn's cleanup is confirmed: every process the tracker saw is gone (`cleanup`) and
/// `claude` was reaped (`status`). When it is not, `latch` is set and the runtime takes no more
/// work (3.6).
fn settle_cleanup(
    cleanup: &anyhow::Result<()>,
    status: Option<ExitStatus>,
    latch: &AtomicBool,
) -> bool {
    let confirmed = cleanup.is_ok() && status.is_some();
    if !confirmed {
        latch.store(true, Ordering::Release);
        warn!(
            "a Claude Code turn's programs could not be confirmed stopped; this runtime takes no more work"
        );
    }
    confirmed
}

/// A spawn that failed: nothing at the checked path, or a file it may not run.
fn spawn_failure(error: &io::Error) -> LaneFailure {
    let code = match error.kind() {
        io::ErrorKind::NotFound => FailureCode::BinaryMissing,
        io::ErrorKind::PermissionDenied => FailureCode::BinaryUnsafe,
        _ => FailureCode::Crashed,
    };
    LaneFailure::new(code, format!("Claude Code could not be started: {error}"))
}

/// Runs a turn's `claude` from `command` to the end of the turn (3.6), feeding what it prints to
/// `adapter` and each event that makes to `on_event`, and returns how the turn ended. Whatever
/// ends it, the processes the tracker saw are stopped before this returns.
pub async fn supervise(
    mut command: Command,
    spec: TurnSpec<'_>,
    limits: &TurnLimits,
    adapter: &mut EventAdapter,
    on_event: &mut (dyn FnMut(&Value) + Send),
) -> TurnOutcome {
    if limits.cleanup_latch.load(Ordering::Acquire) {
        return TurnOutcome::before_start(TurnEnd::Failed(LaneFailure::new(
            FailureCode::Crashed,
            "An earlier turn's programs could not be confirmed stopped, so this computer takes no more turns until Instafy restarts on it.",
        )));
    }
    if spec.shutdown.is_cancelled() {
        return TurnOutcome::before_start(TurnEnd::Shutdown);
    }
    if spec.stop.is_canceled() {
        return TurnOutcome::before_start(TurnEnd::Stopped);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return TurnOutcome::before_start(TurnEnd::Failed(spawn_failure(&error))),
    };
    let Some(pid) = child.id() else {
        let _ = child.start_kill();
        return TurnOutcome::before_start(TurnEnd::Failed(LaneFailure::new(
            FailureCode::Crashed,
            "Claude Code ended as it started.",
        )));
    };
    let mut tree = ProcessTree::new(pid, limits.cleanup_latch);
    #[cfg(test)]
    if limits.unkillable {
        tree = tree.with_a_survivor(Duration::from_millis(100));
    }
    let prompt_writer = child.stdin.take().map(|stdin| {
        let prompt = spec.prompt.to_owned();
        OwnedTask::spawn(async move {
            if let Err(error) = write_prompt(stdin, &prompt).await {
                debug!(%error, "claude did not read the whole prompt");
            }
        })
    });
    let stderr_tail = Tail::new(limits.stderr_tail_bytes);
    let stderr_reader = child
        .stderr
        .take()
        .map(|stderr| OwnedTask::spawn(stderr_tail.clone().read(stderr)));
    let mut stdout = child.stdout.take();

    let started = Instant::now();
    let wall_deadline = started + limits.wall_clock;
    let mut last_event = started;
    let mut stopping: Option<Stopping> = None;
    let mut exit: Option<io::Result<ExitStatus>> = None;
    let mut drain_until: Option<Instant> = None;
    let mut lines = Lines::new(limits.max_line_bytes);
    let mut found: Vec<Line> = Vec::new();
    let mut unparsed = 0usize;
    let mut ignored = 0usize;
    let mut ticker = tokio::time::interval(limits.observe_every);
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut chunk = vec![0u8; READ_CHUNK_BYTES];

    loop {
        let now = Instant::now();
        if exit.is_some()
            && (stdout.is_none()
                || stopping.is_some()
                || drain_until.is_some_and(|until| now >= until))
        {
            break;
        }
        if exit.is_none()
            && stopping
                .as_ref()
                .is_some_and(|stop| now >= stop.grace_until)
        {
            break;
        }
        // A Stop or a shutdown that came while the loop was not waiting.
        let flagged = if stopping.is_some() {
            None
        } else if spec.shutdown.is_cancelled() {
            Some(StopReason::Shutdown)
        } else if spec.stop.is_canceled() {
            Some(StopReason::Stop)
        } else {
            None
        };
        let reason = match flagged {
            Some(reason) => Some(reason),
            None => tokio::select! {
                biased;
                _ = spec.shutdown.cancelled(), if stopping.is_none() => Some(StopReason::Shutdown),
                _ = spec.stop.cancelled(), if stopping.is_none() => Some(StopReason::Stop),
                _ = ticker.tick() => {
                    tree.observe();
                    let now = Instant::now();
                    if stopping.is_some() || exit.is_some() {
                        None
                    } else if now >= wall_deadline {
                        Some(StopReason::WallClock)
                    } else if now.duration_since(last_event) >= limits.stall {
                        Some(StopReason::Stalled)
                    } else {
                        None
                    }
                }
                status = child.wait(), if exit.is_none() => {
                    exit = Some(status);
                    drain_until = Some(Instant::now() + AFTER_EXIT_DRAIN);
                    None
                }
                read = read_some(&mut stdout, &mut chunk) => {
                    match read {
                        Ok(0) | Err(_) => {
                            if let Some(last) = lines.finish() {
                                found.push(Line::Complete(last));
                            }
                            stdout = None;
                        }
                        Ok(read) => lines.push(&chunk[..read], &mut found),
                    }
                    let mut reason = None;
                    for line in found.drain(..) {
                        if stopping.is_some() || reason.is_some() {
                            // The turn ended: what `claude` prints afterwards is ignored.
                            ignored += usize::from(!line.is_blank());
                            continue;
                        }
                        reason = take_line(
                            line,
                            adapter,
                            on_event,
                            &mut unparsed,
                            &mut last_event,
                            limits,
                        );
                    }
                    reason
                }
            },
        };
        if let Some(reason) = reason {
            // The stop path: SIGTERM to `claude` while it runs, then up to the grace. One more
            // look first, so what `claude` started since the last tick is tracked before the
            // SIGTERM lets it exit and leave that behind.
            info!(reason = ?reason, "ending a Claude Code turn's process");
            tree.observe();
            let term_sent = exit.is_none() && child.id().is_some_and(send_sigterm);
            stopping = Some(Stopping {
                reason,
                grace_until: Instant::now() + limits.stop_grace,
                term_sent,
            });
        }
    }

    // Every exit: what the tracker saw goes with the turn, `claude` too if it is still there.
    let programs_stopped = tree.running_descendants();
    let cleanup = tree.terminate_and_confirm().await;
    let status = match exit {
        Some(Ok(status)) => Some(status),
        Some(Err(error)) => {
            warn!(%error, "could not read how Claude Code exited");
            None
        }
        None => {
            let _ = child.start_kill();
            match tokio::time::timeout(REAP_WITHIN, child.wait()).await {
                Ok(Ok(status)) => Some(status),
                _ => None,
            }
        }
    };
    let cleanup_confirmed = settle_cleanup(&cleanup, status, limits.cleanup_latch);
    drop(prompt_writer);
    if let Some(reader) = stderr_reader {
        // A process left behind may hold stderr open: what was read by then is kept.
        let _ = reader.join_within(STDERR_WITHIN).await;
    }
    // Its end may be cut inside a path: a reader stopped between two parts of a write, or a
    // writer killed in the middle of a line. An end that could be part of the folder's or the
    // home folder's path is left out, as a draft's is, so no part of either is shown.
    let stderr = adapter
        .redactor()
        .draft(String::from_utf8_lossy(&stderr_tail.bytes()).trim());
    adapter.note_ignored(ignored);

    let (reason, term_sent) = match stopping {
        Some(stopping) => (Some(stopping.reason), stopping.term_sent),
        None => (None, false),
    };
    let end = if spec.shutdown.is_cancelled() || reason == Some(StopReason::Shutdown) {
        TurnEnd::Shutdown
    } else if spec.stop.is_canceled() || reason == Some(StopReason::Stop) {
        TurnEnd::Stopped
    } else {
        match reason {
            Some(StopReason::WallClock) => TurnEnd::Failed(LaneFailure::new(
                FailureCode::TurnTimeout,
                format!(
                    "Claude Code worked past the turn's limit of {} seconds.",
                    limits.wall_clock.as_secs()
                ),
            )),
            Some(StopReason::Stalled) => TurnEnd::Failed(LaneFailure::new(
                FailureCode::Stalled,
                format!(
                    "Claude Code printed nothing for {} seconds.",
                    limits.stall.as_secs()
                ),
            )),
            Some(StopReason::Unexpected) => {
                let why = match adapter.status() {
                    AdapterStatus::Unexpected(why) => why.clone(),
                    _ => "Claude Code started with settings Instafy did not ask for.".to_string(),
                };
                TurnEnd::Failed(LaneFailure::new(
                    FailureCode::UnexpectedConfiguration,
                    adapter.redactor().text(&why),
                ))
            }
            Some(StopReason::Crashed(why)) => {
                TurnEnd::Failed(LaneFailure::new(FailureCode::Crashed, why))
            }
            Some(StopReason::EndOfTurn | StopReason::Stop | StopReason::Shutdown) | None => {
                let code = status.and_then(|status| status.code());
                let after_own_sigterm = reason == Some(StopReason::EndOfTurn) && term_sent;
                let exited_ok = exit_counts_as_zero(code, after_own_sigterm);
                if exited_ok && adapter.succeeded() {
                    TurnEnd::Succeeded
                } else {
                    TurnEnd::Failed(adapter.classify_failure(&ExitFacts {
                        resumed: spec.resumed,
                        exit_code: code,
                        signal: exit_signal(status),
                        exited_ok,
                        stderr: &stderr,
                    }))
                }
            }
        }
    };
    TurnOutcome {
        end,
        exit_status: status,
        cleanup_confirmed,
        stderr,
        ignored_lines: ignored,
        programs_stopped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_turn_timeout_is_read_within_its_range() {
        assert_eq!(turn_timeout(None), Duration::from_secs(2_700));
        assert_eq!(turn_timeout(Some("")), Duration::from_secs(2_700));
        assert_eq!(turn_timeout(Some("60")), Duration::from_secs(60));
        assert_eq!(turn_timeout(Some(" 3000 ")), Duration::from_secs(3_000));
        assert_eq!(turn_timeout(Some("1200")), Duration::from_secs(1_200));
        for outside in [
            "59",
            "3001",
            "0",
            "-5",
            "45m",
            "1e3",
            "99999999999999999999",
        ] {
            assert_eq!(
                turn_timeout(Some(outside)),
                DEFAULT_TURN_TIMEOUT,
                "{outside}"
            );
        }
    }

    #[test]
    fn the_standard_limits_are_those_of_3_6() {
        let limits = TurnLimits::standard();
        assert_eq!(limits.stall, Duration::from_secs(900));
        assert_eq!(limits.stop_grace, Duration::from_secs(5));
        assert_eq!(limits.observe_every, Duration::from_millis(50));
        assert_eq!(limits.max_line_bytes, 8 * 1024 * 1024);
        assert_eq!(limits.max_unparsed_lines, 50);
        assert_eq!(limits.stderr_tail_bytes, 16 * 1024);
        assert!(std::ptr::eq(
            limits.cleanup_latch,
            &super::super::CLEANUP_UNCONFIRMED
        ));
    }

    #[test]
    fn exit_143_counts_as_0_only_after_the_runtimes_own_sigterm() {
        assert!(exit_counts_as_zero(Some(0), false));
        assert!(exit_counts_as_zero(Some(0), true));
        assert!(exit_counts_as_zero(Some(143), true));
        assert!(!exit_counts_as_zero(Some(143), false));
        assert!(!exit_counts_as_zero(Some(1), true));
        assert!(!exit_counts_as_zero(None, true));
    }

    fn split(max: usize, pieces: &[&[u8]]) -> Vec<Option<Vec<u8>>> {
        let mut lines = Lines::new(max);
        let mut found = Vec::new();
        for piece in pieces {
            lines.push(piece, &mut found);
        }
        if let Some(last) = lines.finish() {
            found.push(Line::Complete(last));
        }
        found
            .into_iter()
            .map(|line| match line {
                Line::Complete(bytes) => Some(bytes),
                Line::TooLong => None,
            })
            .collect()
    }

    #[test]
    fn lines_are_split_across_reads_and_bounded() {
        assert_eq!(
            split(8, &[b"ab", b"c\nde\n", b"f"]),
            [
                Some(b"abc".to_vec()),
                Some(b"de".to_vec()),
                Some(b"f".to_vec())
            ]
        );
        // A line of exactly the bound passes; a longer one is reported once, in either way it
        // arrives, and the next line is read as usual.
        assert_eq!(split(3, &[b"abc\n"]), [Some(b"abc".to_vec())]);
        assert_eq!(split(3, &[b"abcd\nok\n"]), [None, Some(b"ok".to_vec())]);
        assert_eq!(
            split(3, &[b"ab", b"cd", b"ef", b"\nok"]),
            [None, Some(b"ok".to_vec())]
        );
        assert_eq!(split(3, &[b"abcdef"]), [None]);
        assert_eq!(split(3, &[b"\n\n"]), [Some(Vec::new()), Some(Vec::new())]);
    }

    /// The last `keep` bytes `reader` printed, read to its end.
    async fn tail_of(reader: impl AsyncRead + Unpin, keep: usize) -> Vec<u8> {
        let tail = Tail::new(keep);
        tail.clone().read(reader).await;
        tail.bytes()
    }

    #[tokio::test]
    async fn stderr_keeps_its_tail_from_its_first_whole_line() {
        let lines: Vec<u8> = (0..4_000u32)
            .flat_map(|n| format!("line {n:05} at /home/person/x\n").into_bytes())
            .collect();
        let tail = tail_of(&lines[..], 16 * 1024).await;
        assert!(tail.len() <= 16 * 1024 && tail.len() > 16 * 1024 - 64);
        assert!(lines.ends_with(&tail));
        assert!(tail.starts_with(b"line "), "a whole line first");
        assert!(tail.ends_with(b"line 03999 at /home/person/x\n"));
        // Nothing cut, nothing left out.
        assert_eq!(tail_of(&b"short\nlines"[..], 16).await, b"short\nlines");
        // A cut line keeps only its words after the cut one; with no break at all, nothing.
        let words: Vec<u8> = (0..4_000u32)
            .flat_map(|n| format!("word{n:05} ").into_bytes())
            .collect();
        let tail = tail_of(&words[..], 16 * 1024).await;
        assert!(tail.starts_with(b"word") && words.ends_with(&tail));
        let long: Vec<u8> = (0..40_000u32).map(|n| b'a' + (n % 26) as u8).collect();
        assert!(tail_of(&long[..], 16 * 1024).await.is_empty());
    }

    /// A process left behind holds `claude`'s stderr open, so its reader never sees the end and is
    /// stopped: what it read by then, the crash text that classifies the failure, is kept.
    #[tokio::test]
    async fn stderr_keeps_what_it_read_when_its_stream_never_ends() {
        use tokio::io::AsyncWriteExt;
        let (mut writer, reader) = tokio::io::duplex(64 * 1024);
        writer
            .write_all(
                b"Starting\nTypeError: undefined is not a function\n    at /home/person/.local/share/claude/cli.js:12:34\n",
            )
            .await
            .unwrap();
        let tail = Tail::new(STDERR_TAIL_BYTES);
        let reader = OwnedTask::spawn(tail.clone().read(reader));
        assert!(
            reader
                .join_within(Duration::from_millis(200))
                .await
                .is_none(),
            "the stream is still open"
        );
        let kept = String::from_utf8(tail.bytes()).unwrap();
        assert!(
            kept.contains("TypeError: undefined is not a function")
                && kept.contains("/.local/share/claude/cli.js"),
            "{kept}"
        );
        drop(writer);
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_is_confirmed_only_when_every_process_is_gone_and_claude_was_reaped() {
        use std::os::unix::process::ExitStatusExt;
        static CONFIRMED: AtomicBool = AtomicBool::new(false);
        static SURVIVORS: AtomicBool = AtomicBool::new(false);
        static UNREAPED: AtomicBool = AtomicBool::new(false);
        let exited = Some(ExitStatus::from_raw(0));
        assert!(settle_cleanup(&Ok(()), exited, &CONFIRMED));
        assert!(!CONFIRMED.load(Ordering::Acquire));
        // Processes survived the kill.
        let survivors = Err(anyhow::anyhow!(
            "supervised descendants survived termination"
        ));
        assert!(!settle_cleanup(&survivors, exited, &SURVIVORS));
        assert!(SURVIVORS.load(Ordering::Acquire));
        // Every tracked process is gone, but `claude` itself was never reaped.
        assert!(!settle_cleanup(&Ok(()), None, &UNREAPED));
        assert!(UNREAPED.load(Ordering::Acquire));
    }

    /// A turn whose processes cannot be confirmed gone sets the latch it was given and still
    /// reports how it ended (3.6).
    #[cfg(unix)]
    #[tokio::test]
    async fn a_turn_whose_processes_outlive_the_kill_sets_its_latch_and_still_ends() {
        static LATCH: AtomicBool = AtomicBool::new(false);
        let folder = tempfile::tempdir().unwrap();
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "cat >/dev/null; echo 'TypeError: the turn broke' >&2; exit 1",
            ])
            .current_dir(folder.path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let limits = TurnLimits::standard()
            .with_cleanup_latch(&LATCH)
            .with_a_process_that_outlives_the_kill();
        let stop = JobCancelSignal::new();
        let shutdown = ShutdownSignal::new();
        let mut adapter = EventAdapter::new(folder.path(), None);
        let outcome = supervise(
            command,
            TurnSpec {
                prompt: "Fix the test\n",
                resumed: false,
                stop: &stop,
                shutdown: &shutdown,
            },
            &limits,
            &mut adapter,
            &mut |_| {},
        )
        .await;
        assert!(!outcome.cleanup_confirmed);
        assert!(LATCH.load(Ordering::Acquire));
        assert!(!super::super::CLEANUP_UNCONFIRMED.load(Ordering::Acquire));
        assert_eq!(
            outcome.exit_status.and_then(|status| status.code()),
            Some(1)
        );
        assert!(
            matches!(&outcome.end, TurnEnd::Failed(failure) if failure.code == Some(FailureCode::Crashed)),
            "{:?}",
            outcome.end
        );
        assert!(outcome.stderr.contains("TypeError: the turn broke"));
    }

    /// stderr whose end is cut inside the home folder's path, as when its writer was killed in
    /// the middle of a line, shows no part of that path: the end is left out, and the rest is
    /// redacted (stderr-tail-end-cut-path).
    #[cfg(unix)]
    #[tokio::test]
    async fn stderr_cut_inside_a_path_shows_no_part_of_it() {
        static LATCH: AtomicBool = AtomicBool::new(false);
        let folder = tempfile::tempdir().unwrap();
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "cat >/dev/null; printf 'TypeError: x\\n    at (/home/person/a.js:1:2)\\n    at (/home/per' >&2; exit 1",
            ])
            .current_dir(folder.path())
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let stop = JobCancelSignal::new();
        let shutdown = ShutdownSignal::new();
        let mut adapter =
            EventAdapter::new(folder.path(), Some(std::path::Path::new("/home/person")));
        let outcome = supervise(
            command,
            TurnSpec {
                prompt: "Fix the test\n",
                resumed: false,
                stop: &stop,
                shutdown: &shutdown,
            },
            &TurnLimits::standard().with_cleanup_latch(&LATCH),
            &mut adapter,
            &mut |_| {},
        )
        .await;
        assert!(
            outcome.stderr.contains("at (~/a.js:1:2)") && !outcome.stderr.contains("/home/per"),
            "{}",
            outcome.stderr
        );
        let TurnEnd::Failed(failure) = &outcome.end else {
            panic!("{:?}", outcome.end);
        };
        assert!(
            failure.message.contains("~/a.js") && !failure.message.contains("/home/per"),
            "{failure:?}"
        );
    }
}
