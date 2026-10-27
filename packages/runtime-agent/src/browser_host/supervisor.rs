//! The browser host supervisor: one process-scoped actor that owns the host
//! child and makes every state transition.
//!
//! Callers (origin's routes, the job pipeline, Drop handlers) only read the
//! state under a std mutex that is never held across an await, and send the
//! actor commands. Every transition the actor makes is a compare-and-set on
//! the host's generation, so a late event from an earlier host never moves a
//! newer one. Poisoned is sticky until the process exits.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use origin_http_server::browser_host::{
    BROWSER_HOST_POISONED_CODE, BROWSER_HOST_STOPPING_CODE, BrowserHostCallerFacts,
    BrowserHostRefusal, BrowserHostSnapshot, BrowserHostState,
};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use super::mode;
use super::persistence::{
    CLOSE_CONFIRM_BUDGET, CLOSE_HELPER_BUDGET, CloseCommand, HostPersistence, SaveKind, Saver,
    remaining,
};
use super::process::{
    self, EXITED_CHROMIUM, EXITED_UNKNOWN, HOST_ERROR, HostDirs, HostLine, SPAWN_FAILED,
    START_SUBCOMMAND, START_TIMEOUT, UNCONFIRMED_SHUTDOWN, group,
};

/// The refusal codes origin documents for a start (409).
pub const REFUSAL_POISONED: &str = BROWSER_HOST_POISONED_CODE;
pub const REFUSAL_STOPPING: &str = BROWSER_HOST_STOPPING_CODE;

/// How long the group may linger after the host exits before the host is
/// poisoned.
const GROUP_CONFIRM: Duration = Duration::from_secs(5);
/// How long status lines printed just before an exit are still read.
const EXIT_LINE_DRAIN: Duration = Duration::from_millis(200);
const GROUP_POLL: Duration = Duration::from_millis(50);
/// Kept back from the runtime's shutdown budget, so the actor's last step
/// (the final save) ends before the caller stops waiting for it.
const SHUTDOWN_MARGIN: Duration = Duration::from_millis(250);

/// Everything the supervisor needs; tests inject a fake entrypoint, a
/// temporary root and short budgets.
#[derive(Clone, Debug)]
pub struct HostConfig {
    pub(crate) entrypoint: PathBuf,
    pub(crate) dirs: HostDirs,
    pub(crate) actions_file: Option<PathBuf>,
    pub(crate) environment: Vec<(String, String)>,
    pub(crate) start_budget: Duration,
    pub(crate) stop_grace: Duration,
    pub(crate) idle_stop_after: Duration,
    pub(crate) idle_tick: Duration,
    pub(crate) presence_grace: Duration,
    pub(crate) group_confirm: Duration,
    /// Restores and saves the profile (`INSTAFY_BROWSER_PROFILE_PERSIST=1`).
    pub(crate) persistence: Option<Arc<HostPersistence>>,
    /// Closes Chromium cleanly before a save.
    pub(crate) close: Option<CloseCommand>,
}

impl HostConfig {
    /// The production host: the image's entrypoint and the fixed root.
    pub(crate) fn for_process(
        entrypoint: PathBuf,
        persistence: Option<Arc<HostPersistence>>,
    ) -> Self {
        let dirs = HostDirs::under(std::path::Path::new(mode::HOST_ROOT));
        let environment =
            process::host_environment(&dirs, process::pinned_chromium().as_deref(), |key| {
                std::env::var(key).ok()
            });
        let actions_file = std::env::var(crate::shared_browser::ACTIONS_FILE_ENV)
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| crate::shared_browser::DEFAULT_ACTIONS_FILE.to_string());
        Self {
            entrypoint,
            dirs,
            actions_file: Some(PathBuf::from(actions_file)),
            environment,
            start_budget: mode::START_BUDGET,
            stop_grace: mode::STOP_GRACE,
            idle_stop_after: mode::IDLE_STOP_AFTER,
            idle_tick: mode::IDLE_TICK,
            presence_grace: mode::PRESENCE_GRACE,
            group_confirm: GROUP_CONFIRM,
            persistence,
            close: Some(CloseCommand::for_host()),
        }
    }

    /// A host under `root` whose entrypoint does not exist: it never runs.
    #[cfg(test)]
    pub(crate) fn inert_for_tests(root: &std::path::Path) -> Self {
        let dirs = HostDirs::under(&root.join("browser-host"));
        Self {
            entrypoint: root.join("missing-entrypoint"),
            environment: process::host_environment(&dirs, None, |_| None),
            dirs,
            actions_file: None,
            start_budget: Duration::from_secs(1),
            stop_grace: Duration::from_secs(1),
            idle_stop_after: Duration::from_secs(3600),
            idle_tick: Duration::from_secs(3600),
            presence_grace: mode::PRESENCE_GRACE,
            group_confirm: Duration::from_secs(1),
            persistence: None,
            close: None,
        }
    }
}

enum Command {
    Start {
        generation: Uuid,
    },
    Stop {
        reason: &'static str,
        reply: oneshot::Sender<()>,
    },
    Shutdown {
        deadline: tokio::time::Instant,
        reply: oneshot::Sender<()>,
    },
}

struct Inner {
    state: BrowserHostState,
    generation: Option<Uuid>,
    failure: Option<&'static str>,
    started_by: Option<String>,
    last_activity: Instant,
    shutting_down: bool,
}

struct Shared {
    state: Mutex<Inner>,
    /// The running host's process group (its pid), 0 when none. Stored
    /// synchronously right after spawn, so `poison` and `kill_now` can always
    /// reach a started host.
    host_pgid: AtomicI32,
    active_jobs: AtomicUsize,
    presence: Mutex<HashMap<String, Instant>>,
    presence_grace: Duration,
    persistence: Option<Arc<HostPersistence>>,
}

impl Shared {
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn touch(&self) {
        self.inner().last_activity = Instant::now();
    }

    fn snapshot(&self) -> BrowserHostSnapshot {
        snapshot_of(&self.inner())
    }

    /// Marks the host Poisoned and kills its group, without a save.
    /// Synchronous; never awaits.
    fn poison(&self, token: &'static str) {
        if let Some(persistence) = &self.persistence {
            persistence.disable();
        }
        {
            let mut inner = self.inner();
            if inner.state != BrowserHostState::Poisoned {
                inner.state = BrowserHostState::Poisoned;
                inner.failure = Some(token);
            }
        }
        let pgid = self.host_pgid.load(Ordering::SeqCst);
        if pgid != 0 {
            group::kill(pgid);
        }
    }

    /// The idle stop's decision and its move to Stopping, in one critical
    /// section. A job takes its guard (a job count and an activity bump under
    /// this lock) before it checks readiness, so either this sees the job or
    /// the job sees Stopping: an idle stop never lands under an admitted job.
    fn begin_idle_stop(&self, generation: Uuid, idle_after: Duration) -> bool {
        let mut inner = self.inner();
        if inner.generation != Some(generation)
            || !should_idle_stop(
                inner.state,
                inner.last_activity,
                Instant::now(),
                self.active_jobs.load(Ordering::SeqCst),
                idle_after,
            )
        {
            return false;
        }
        inner.state = BrowserHostState::Stopping;
        true
    }

    /// A host whose process ended without a requested stop is no longer
    /// Ready (or Starting) while the agent confirms its group is gone; it
    /// settles to Failed afterwards.
    fn mark_exiting(&self, generation: Uuid) {
        let mut inner = self.inner();
        if inner.generation == Some(generation)
            && matches!(
                inner.state,
                BrowserHostState::Starting | BrowserHostState::Ready
            )
        {
            inner.state = BrowserHostState::Stopping;
        }
    }

    /// Whether `generation` is the current host and Ready.
    fn is_ready_generation(&self, generation: Uuid) -> bool {
        let inner = self.inner();
        inner.state == BrowserHostState::Ready && inner.generation == Some(generation)
    }

    /// Moves `generation` to Failed, unless it is no longer current or the
    /// host is Poisoned.
    fn fail(&self, generation: Uuid, token: &'static str) {
        let mut inner = self.inner();
        if inner.state != BrowserHostState::Poisoned && inner.generation == Some(generation) {
            inner.state = BrowserHostState::Failed;
            inner.failure = Some(token);
            inner.started_by = None;
        }
    }
}

fn snapshot_of(inner: &Inner) -> BrowserHostSnapshot {
    BrowserHostSnapshot {
        state: inner.state,
        generation: match inner.state {
            BrowserHostState::Idle => None,
            _ => inner.generation,
        },
        failure: match inner.state {
            BrowserHostState::Failed | BrowserHostState::Poisoned => inner.failure,
            _ => None,
        },
    }
}

/// Whether the idle tick stops the host: Ready, unused for `idle_after`, and
/// no Shared Browser job running.
pub(crate) fn should_idle_stop(
    state: BrowserHostState,
    last_activity: Instant,
    now: Instant,
    active_jobs: usize,
    idle_after: Duration,
) -> bool {
    state == BrowserHostState::Ready
        && active_jobs == 0
        && now.saturating_duration_since(last_activity) >= idle_after
}

/// The browser host of this process.
pub struct BrowserHost {
    shared: Arc<Shared>,
    commands: mpsc::UnboundedSender<Command>,
}

/// Held for a whole Shared Browser job: the idle stop waits for it, and the
/// action log is never emptied under it.
pub struct JobActivityGuard {
    shared: Arc<Shared>,
}

impl std::fmt::Debug for JobActivityGuard {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("JobActivityGuard")
    }
}

impl Drop for JobActivityGuard {
    fn drop(&mut self) {
        self.shared.active_jobs.fetch_sub(1, Ordering::SeqCst);
        self.shared.touch();
    }
}

impl BrowserHost {
    /// Starts the actor on the current Tokio runtime. The host itself starts
    /// only on [`BrowserHost::request_start`].
    pub fn spawn(config: HostConfig) -> Arc<Self> {
        let shared = Arc::new(Shared {
            state: Mutex::new(Inner {
                state: BrowserHostState::Idle,
                generation: None,
                failure: None,
                started_by: None,
                last_activity: Instant::now(),
                shutting_down: false,
            }),
            host_pgid: AtomicI32::new(0),
            active_jobs: AtomicUsize::new(0),
            presence: Mutex::new(HashMap::new()),
            presence_grace: config.presence_grace,
            persistence: config.persistence.clone(),
        });
        let (commands, receiver) = mpsc::unbounded_channel();
        tokio::spawn(run_actor(shared.clone(), config, receiver));
        Arc::new(Self { shared, commands })
    }

    pub fn snapshot(&self) -> BrowserHostSnapshot {
        self.shared.snapshot()
    }

    pub fn is_ready(&self) -> bool {
        self.shared.inner().state == BrowserHostState::Ready
    }

    pub fn caller_facts(&self, subject: &str) -> BrowserHostCallerFacts {
        let started_by_caller = {
            let inner = self.shared.inner();
            matches!(
                inner.state,
                BrowserHostState::Starting | BrowserHostState::Ready
            ) && inner.started_by.as_deref() == Some(subject)
        };
        let now = Instant::now();
        let grace = self.shared.presence_grace;
        let mut presence = self
            .shared
            .presence
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        presence.retain(|_, seen| now.saturating_duration_since(*seen) < grace);
        let other_seen_recently = presence.keys().any(|seen| seen != subject);
        BrowserHostCallerFacts {
            started_by_caller,
            other_seen_recently,
        }
    }

    /// Single-flight: Idle or Failed moves to Starting with a new generation
    /// recorded for `subject`; Starting or Ready returns as is. Never waits.
    pub fn request_start(&self, subject: &str) -> Result<BrowserHostSnapshot, BrowserHostRefusal> {
        let mut inner = self.shared.inner();
        inner.last_activity = Instant::now();
        if inner.state == BrowserHostState::Poisoned {
            return Err(BrowserHostRefusal {
                code: REFUSAL_POISONED,
                message: "Instafy's browser can't start again on this machine until it restarts."
                    .to_string(),
            });
        }
        if inner.state == BrowserHostState::Stopping || inner.shutting_down {
            return Err(BrowserHostRefusal {
                code: REFUSAL_STOPPING,
                message: "Instafy's browser is stopping. Try again in a moment.".to_string(),
            });
        }
        if matches!(
            inner.state,
            BrowserHostState::Idle | BrowserHostState::Failed
        ) {
            let generation = Uuid::new_v4();
            inner.state = BrowserHostState::Starting;
            inner.generation = Some(generation);
            inner.failure = None;
            inner.started_by = Some(subject.to_string());
            if self.commands.send(Command::Start { generation }).is_err() {
                inner.state = BrowserHostState::Failed;
                inner.failure = Some(SPAWN_FAILED);
                inner.started_by = None;
            }
        }
        Ok(snapshot_of(&inner))
    }

    /// The subject used the browser now. Only a clock bump.
    pub fn note_seen(&self, subject: &str) {
        let now = Instant::now();
        self.shared
            .presence
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(subject.to_string(), now);
        self.shared.inner().last_activity = now;
    }

    pub fn job_activity(&self) -> JobActivityGuard {
        self.shared.active_jobs.fetch_add(1, Ordering::SeqCst);
        self.shared.touch();
        JobActivityGuard {
            shared: self.shared.clone(),
        }
    }

    /// Fails closed: Poisoned until the process exits, and the host's group
    /// killed. Synchronous, so a Drop handler can call it.
    pub fn poison(&self) {
        self.shared.poison(UNCONFIRMED_SHUTDOWN);
    }

    /// SIGKILL to the host's group, without a save.
    pub fn kill_now(&self) {
        if let Some(persistence) = &self.shared.persistence {
            persistence.disable();
        }
        let pgid = self.shared.host_pgid.load(Ordering::SeqCst);
        if pgid != 0 {
            group::kill(pgid);
        }
    }

    /// Stops a Starting or Ready host and waits until it is down.
    pub async fn stop(&self, reason: &'static str) {
        let (reply, done) = oneshot::channel();
        if self.commands.send(Command::Stop { reason, reply }).is_ok() {
            let _ = done.await;
        }
    }

    /// Stops the host for good within `budget`, with a final save; later
    /// starts and saves are refused. Past the budget the group is killed.
    pub async fn shutdown(&self, budget: Duration) {
        self.shared.inner().shutting_down = true;
        let deadline = tokio::time::Instant::now() + budget.saturating_sub(SHUTDOWN_MARGIN);
        let (reply, done) = oneshot::channel();
        let sent = self
            .commands
            .send(Command::Shutdown { deadline, reply })
            .is_ok();
        if !sent || tokio::time::timeout(budget, done).await.is_err() {
            self.kill_now();
        }
    }

    #[cfg(test)]
    fn host_pgid(&self) -> i32 {
        self.shared.host_pgid.load(Ordering::SeqCst)
    }

    #[cfg(test)]
    fn active_jobs(&self) -> usize {
        self.shared.active_jobs.load(Ordering::SeqCst)
    }
}

/// The running host child, owned by the actor.
struct Running {
    child: tokio::process::Child,
    pid: i32,
    generation: Uuid,
    lines: mpsc::UnboundedReceiver<HostLine>,
    lines_open: bool,
    ready_deadline: Option<tokio::time::Instant>,
    /// The failure the exit reports, from a status line or the agent.
    failure: Option<&'static str>,
    stop_requested: bool,
    /// Cleared once the group is confirmed gone; while set, dropping this
    /// (the actor ending with the runtime) kills the group.
    armed: bool,
    /// The periodic profile saves, from Ready until the host stops.
    saver: Option<Saver>,
}

impl Drop for Running {
    fn drop(&mut self) {
        if self.armed {
            group::kill(self.pid);
        }
    }
}

enum Event {
    Command(Option<Command>),
    Line(Option<HostLine>),
    Exited,
    ReadyDeadline,
    IdleTick,
}

async fn run_actor(
    shared: Arc<Shared>,
    config: HostConfig,
    mut commands: mpsc::UnboundedReceiver<Command>,
) {
    let mut running: Option<Running> = None;
    // The last host stopped with a confirmed close, and none has started
    // since: the local profile is closed and safe to pack.
    let mut profile_closed = false;
    let mut idle = tokio::time::interval_at(
        tokio::time::Instant::now() + config.idle_tick,
        config.idle_tick,
    );
    idle.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let event = {
            let (child, lines, deadline) = match running.as_mut() {
                Some(host) => (
                    Some(&mut host.child),
                    host.lines_open.then_some(&mut host.lines),
                    host.ready_deadline,
                ),
                None => (None, None, None),
            };
            tokio::select! {
                command = commands.recv() => Event::Command(command),
                line = async {
                    match lines {
                        Some(lines) => lines.recv().await,
                        None => std::future::pending().await,
                    }
                } => Event::Line(line),
                _ = async {
                    match child {
                        Some(child) => {
                            let _ = child.wait().await;
                        }
                        None => std::future::pending::<()>().await,
                    }
                } => Event::Exited,
                _ = async {
                    match deadline {
                        Some(deadline) => tokio::time::sleep_until(deadline).await,
                        None => std::future::pending().await,
                    }
                } => Event::ReadyDeadline,
                _ = idle.tick() => Event::IdleTick,
            }
        };
        match event {
            Event::Command(None) => {
                // The handle is gone: stop the host and end.
                if let Some(mut host) = running.take() {
                    host.stop_requested = true;
                    group::kill(host.pid);
                    finish(&shared, &config, host).await;
                }
                return;
            }
            Event::Command(Some(Command::Start { generation })) => {
                if running.is_some() {
                    tracing::warn!("browser host start ignored: a host is already running");
                    continue;
                }
                let current = {
                    let mut inner = shared.inner();
                    let current = inner.state == BrowserHostState::Starting
                        && inner.generation == Some(generation);
                    if current && inner.shutting_down {
                        // Requested just before the runtime's shutdown: the
                        // host never runs, and the start settles as stopped.
                        inner.state = BrowserHostState::Idle;
                        inner.generation = None;
                        inner.failure = None;
                        inner.started_by = None;
                        false
                    } else {
                        current
                    }
                };
                if current {
                    profile_closed = false;
                    running = start(&shared, &config, generation).await;
                }
            }
            Event::Command(Some(Command::Stop { reason, reply })) => {
                if let Some(host) = running.take() {
                    tracing::info!(reason, "stopping the browser host");
                    profile_closed =
                        stop_running(&shared, &config, host, None, SaveKind::HostStop).await;
                }
                let _ = reply.send(());
            }
            Event::Command(Some(Command::Shutdown { deadline, reply })) => {
                if let Some(host) = running.take() {
                    tracing::info!("stopping the browser host for the runtime's shutdown");
                    stop_running(&shared, &config, host, Some(deadline), SaveKind::Final).await;
                } else if profile_closed && let Some(persistence) = &config.persistence {
                    // The last stop's save may have failed or stayed
                    // uncertain; the closed profile is saved once more
                    // (nothing is sent when it is unchanged).
                    persistence
                        .save(&config.dirs.profile, SaveKind::Final, Some(deadline), None)
                        .await;
                }
                // Nothing saves after the runtime's shutdown, whether or not
                // a host ran.
                if let Some(persistence) = &config.persistence {
                    persistence.disable();
                }
                let _ = reply.send(());
            }
            Event::Line(line) => {
                let Some(host) = running.as_mut() else {
                    continue;
                };
                match line {
                    Some(line) => on_status_line(&shared, &config, host, line),
                    None => {
                        host.lines_open = false;
                        if host.ready_deadline.take().is_some() {
                            // stdout closed before `ready`.
                            host.failure.get_or_insert(HOST_ERROR);
                            group::kill(host.pid);
                        }
                    }
                }
            }
            Event::Exited => {
                if let Some(host) = running.take() {
                    finish(&shared, &config, host).await;
                }
            }
            Event::ReadyDeadline => {
                if let Some(host) = running.as_mut() {
                    host.ready_deadline = None;
                    host.failure.get_or_insert(START_TIMEOUT);
                    group::kill(host.pid);
                }
            }
            Event::IdleTick => {
                let stop = running.as_ref().is_some_and(|host| {
                    shared.begin_idle_stop(host.generation, config.idle_stop_after)
                });
                if stop && let Some(host) = running.take() {
                    tracing::info!("stopping the idle browser host");
                    profile_closed =
                        stop_running(&shared, &config, host, None, SaveKind::HostStop).await;
                }
            }
        }
    }
}

fn on_status_line(shared: &Arc<Shared>, config: &HostConfig, host: &mut Running, line: HostLine) {
    match line {
        HostLine::Ready => {
            let became_ready = {
                let mut inner = shared.inner();
                let current = inner.state == BrowserHostState::Starting
                    && inner.generation == Some(host.generation)
                    && host.ready_deadline.is_some();
                if current {
                    inner.state = BrowserHostState::Ready;
                    host.ready_deadline = None;
                }
                current
            };
            if became_ready {
                // A browser that started has none of an earlier run's tabs of
                // Octo's; the record of them is settled off the executor.
                tokio::task::spawn_blocking(
                    crate::shared_browser::close_leftover_agent_tabs_after_browser_start,
                );
            }
            if became_ready && let Some(persistence) = &config.persistence {
                let shared = shared.clone();
                let generation = host.generation;
                host.saver = persistence.start_saver(
                    config.dirs.profile.clone(),
                    Arc::new(move || shared.is_ready_generation(generation)),
                );
            }
        }
        HostLine::Failed(token) => {
            host.failure.get_or_insert(token);
            host.ready_deadline = None;
            // The host exits after a real failure; a ready line that does not
            // match leaves it running, so end it either way.
            group::kill(host.pid);
        }
        HostLine::Exited(token) => {
            host.failure.get_or_insert(token);
        }
        HostLine::Stopped => {}
    }
}

/// Restores the stored profile while the host is down, then checks the
/// directories again (a restore replaces the profile directory). False when
/// the start must not run.
async fn prepare_for_start(shared: &Shared, config: &HostConfig, generation: Uuid) -> bool {
    let Some(persistence) = &config.persistence else {
        return true;
    };
    match persistence.restore(&config.dirs.profile).await {
        Ok(outcome) => tracing::info!(?outcome, "prepared the browser profile"),
        Err(error) => {
            tracing::error!(%error, "could not empty the browser profile");
            return false;
        }
    }
    if let Err(error) = process::prepare_dirs(&config.dirs) {
        tracing::error!(%error, "the browser host's directories are unusable");
        return false;
    }
    // The restore may take a while: a shutdown requested meanwhile settles
    // the start as stopped, and a poisoned host never starts.
    let mut inner = shared.inner();
    if inner.state != BrowserHostState::Starting || inner.generation != Some(generation) {
        return false;
    }
    if inner.shutting_down {
        inner.state = BrowserHostState::Idle;
        inner.generation = None;
        inner.failure = None;
        inner.started_by = None;
        return false;
    }
    true
}

async fn start(shared: &Shared, config: &HostConfig, generation: Uuid) -> Option<Running> {
    // The directories are checked (no symlinks) before the restore writes
    // under them.
    if let Err(error) = process::prepare_dirs(&config.dirs) {
        tracing::error!(%error, "the browser host's directories are unusable");
        shared.fail(generation, SPAWN_FAILED);
        return None;
    }
    if !prepare_for_start(shared, config, generation).await {
        shared.fail(generation, SPAWN_FAILED);
        return None;
    }
    if shared.active_jobs.load(Ordering::SeqCst) == 0
        && let Some(actions_file) = config.actions_file.as_deref()
    {
        process::truncate_actions_file(actions_file);
    }

    let mut command = tokio::process::Command::new(&config.entrypoint);
    command
        .arg(START_SUBCOMMAND)
        .env_clear()
        .envs(
            config
                .environment
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        )
        .current_dir(&config.dirs.state)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(false);
    // The host leads its own group (pgid == pid), so stopping that group stops
    // the whole browser and never this process.
    #[cfg(unix)]
    command.process_group(0);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            tracing::error!(%error, "could not start the browser host");
            shared.fail(generation, SPAWN_FAILED);
            return None;
        }
    };
    let pid = child
        .id()
        .and_then(|pid| i32::try_from(pid).ok())
        .unwrap_or(0);
    // Before any await, so `poison` and `kill_now` reach this host at once.
    shared.host_pgid.store(pid, Ordering::SeqCst);
    if shared.inner().state == BrowserHostState::Poisoned {
        // Poisoned between the spawn and the store above.
        group::kill(pid);
    }

    let (sender, lines) = mpsc::unbounded_channel();
    let lines_open = match child.stdout.take() {
        Some(stdout) => {
            tokio::spawn(process::read_status_lines(stdout, sender));
            true
        }
        None => false,
    };
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(process::drain_stderr(stderr));
    }
    Some(Running {
        child,
        pid,
        generation,
        lines,
        lines_open,
        ready_deadline: Some(tokio::time::Instant::now() + config.start_budget),
        failure: None,
        stop_requested: false,
        armed: pid != 0,
        saver: None,
    })
}

/// Stops a running host and ends Idle unless it is Poisoned. The idle stop
/// has already moved the host to Stopping.
///
/// Without persistence: SIGTERM to the host (it stops its own group), then
/// SIGKILL to the group after the grace, then [`finish`]. With persistence:
/// the periodic saves stop first (an upload in flight finishes), Chromium is
/// closed over CDP so it flushes its cookies, and only once its exit is
/// confirmed is the profile packed and saved. A close that cannot be
/// confirmed falls back to SIGTERM and never packs a live profile.
/// `deadline` bounds the whole stop for the runtime's shutdown. True when
/// Chromium's close was confirmed and the host's group is gone, so the local
/// profile is closed.
async fn stop_running(
    shared: &Shared,
    config: &HostConfig,
    mut host: Running,
    deadline: Option<tokio::time::Instant>,
    kind: SaveKind,
) -> bool {
    {
        let mut inner = shared.inner();
        if inner.generation == Some(host.generation)
            && matches!(
                inner.state,
                BrowserHostState::Starting | BrowserHostState::Ready
            )
        {
            inner.state = BrowserHostState::Stopping;
        }
    }
    host.stop_requested = true;
    host.ready_deadline = None;
    let closed = match &config.persistence {
        Some(_) => {
            let saver_stopped = match host.saver.take() {
                Some(saver) => saver.stop(deadline).await,
                None => true,
            };
            if !saver_stopped {
                tracing::warn!("a browser profile save outlasted the stop; no final save");
            }
            saver_stopped && close_browser(config, &mut host, deadline).await
        }
        None => false,
    };
    if !closed {
        group::terminate(host.pid);
    }
    if tokio::time::timeout(remaining(config.stop_grace, deadline), host.child.wait())
        .await
        .is_err()
    {
        group::kill(host.pid);
    }
    let confirmed = finish(shared, config, host).await;
    let Some(persistence) = config.persistence.as_ref().filter(|_| closed && confirmed) else {
        return false;
    };
    persistence
        .save(&config.dirs.profile, kind, deadline, None)
        .await;
    true
}

/// Asks Chromium to close over CDP and waits for the host to report that
/// Chromium exited. Confirmed only by an `exited chromium` line that comes
/// before any other final status line; when the host's exit wins the race
/// with that line, its queued lines are read first and it must also have
/// exited with the status the entrypoint uses after that line. A host that
/// reports another child, is killed or prints nothing is never confirmed, so
/// a profile Chromium did not flush is never packed.
async fn close_browser(
    config: &HostConfig,
    host: &mut Running,
    deadline: Option<tokio::time::Instant>,
) -> bool {
    let Some(close) = &config.close else {
        return false;
    };
    if !close.run(remaining(CLOSE_HELPER_BUDGET, deadline)).await {
        tracing::warn!("could not close the browser over CDP; stopping it without a save");
        return false;
    }
    enum Seen {
        Line(Option<HostLine>),
        Exited(Option<i32>),
        Deadline,
    }
    let until = tokio::time::Instant::now() + remaining(CLOSE_CONFIRM_BUDGET, deadline);
    loop {
        let seen = {
            let lines = host.lines_open.then_some(&mut host.lines);
            tokio::select! {
                // Lines first: a status line already queued precedes the exit.
                biased;
                line = async {
                    match lines {
                        Some(lines) => lines.recv().await,
                        None => std::future::pending().await,
                    }
                } => Seen::Line(line),
                status = host.child.wait() => {
                    Seen::Exited(status.ok().and_then(|status| status.code()))
                }
                _ = tokio::time::sleep_until(until) => Seen::Deadline,
            }
        };
        let line = match seen {
            Seen::Line(Some(line)) => line,
            Seen::Line(None) => {
                host.lines_open = false;
                continue;
            }
            Seen::Exited(code) => {
                // The reader task may not have forwarded the host's last line.
                let chromium = loop {
                    if !host.lines_open {
                        break false;
                    }
                    match tokio::time::timeout(EXIT_LINE_DRAIN, host.lines.recv()).await {
                        Ok(Some(line)) => {
                            if let Some(confirmed) = closed_by(host, line) {
                                break confirmed;
                            }
                        }
                        Ok(None) | Err(_) => host.lines_open = false,
                    }
                };
                let confirmed = chromium && code == Some(process::EXITED_STATUS);
                if !confirmed {
                    tracing::warn!("the browser host exited without confirming the close; no save");
                }
                return confirmed;
            }
            Seen::Deadline => {
                tracing::warn!("the browser did not exit after the close; no save");
                return false;
            }
        };
        if let Some(confirmed) = closed_by(host, line) {
            if !confirmed {
                tracing::warn!("another browser host process stopped first; no save");
            }
            return confirmed;
        }
    }
}

/// What a status line says about the close: `Some(true)` for `exited
/// chromium`, `Some(false)` for any other final line (recorded as the host's
/// failure), `None` for a line that is not final.
fn closed_by(host: &mut Running, line: HostLine) -> Option<bool> {
    match line {
        HostLine::Exited(token) if token == EXITED_CHROMIUM => Some(true),
        HostLine::Exited(token) | HostLine::Failed(token) => {
            host.failure.get_or_insert(token);
            Some(false)
        }
        HostLine::Stopped => Some(false),
        HostLine::Ready => None,
    }
}

/// After the host exits: reap it, clear the stored group, read its last
/// status lines, make sure nothing of the group is left, then move to Idle (a
/// requested stop) or Failed. A group that outlives the confirmation window
/// poisons the host. Until then a host that ended on its own reads as
/// Stopping, so no job is admitted to it and no start joins it. True when
/// the group is confirmed gone and the host is not Poisoned.
async fn finish(shared: &Shared, config: &HostConfig, mut host: Running) -> bool {
    shared.mark_exiting(host.generation);
    if let Some(saver) = host.saver.take() {
        // Not Ready any more, so no new save starts; one in flight finishes.
        saver.stop(None).await;
    }
    if tokio::time::timeout(config.group_confirm, host.child.wait())
        .await
        .is_err()
    {
        tracing::error!("the browser host did not exit after SIGKILL");
        shared.poison(UNCONFIRMED_SHUTDOWN);
        return false;
    }
    // The host pid is reaped, so it may be reused: `poison` and `kill_now`
    // stop signalling it. Leftovers of the group are killed below, and by
    // `Running`'s drop while it is armed.
    let _ = shared
        .host_pgid
        .compare_exchange(host.pid, 0, Ordering::SeqCst, Ordering::SeqCst);
    while host.lines_open {
        match tokio::time::timeout(EXIT_LINE_DRAIN, host.lines.recv()).await {
            Ok(Some(HostLine::Failed(token) | HostLine::Exited(token))) => {
                host.failure.get_or_insert(token);
            }
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => host.lines_open = false,
        }
    }

    // The host pid is reaped (above), so waiting on its group reaps only
    // leftovers this process inherited.
    let deadline = Instant::now() + config.group_confirm;
    let confirmed = loop {
        group::reap(host.pid);
        if !group::exists(host.pid) {
            break true;
        }
        group::kill(host.pid);
        if Instant::now() >= deadline {
            break false;
        }
        tokio::time::sleep(GROUP_POLL).await;
    };
    if !confirmed {
        tracing::error!("the browser host's processes outlived it; Instafy's browser stays off");
        shared.poison(UNCONFIRMED_SHUTDOWN);
        return false;
    }
    host.armed = false;

    let mut inner = shared.inner();
    if inner.state == BrowserHostState::Poisoned {
        return false;
    }
    if inner.generation != Some(host.generation) {
        return true;
    }
    if host.stop_requested {
        inner.state = BrowserHostState::Idle;
        inner.generation = None;
        inner.failure = None;
        inner.started_by = None;
    } else {
        let token = host.failure.unwrap_or(EXITED_UNKNOWN);
        tracing::warn!(failure = token, "the browser host stopped");
        inner.state = BrowserHostState::Failed;
        inner.failure = Some(token);
        inner.started_by = None;
    }
    true
}

#[cfg(all(test, unix))]
#[path = "supervisor_tests.rs"]
mod tests;

#[cfg(all(test, unix))]
#[path = "supervisor_persistence_tests.rs"]
mod persistence_tests;
