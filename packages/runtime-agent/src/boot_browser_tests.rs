use std::time::{Duration, Instant};

use origin_http_server::boot_browser::{BootBrowserState, BootBrowserStatus};

use super::*;

fn secs(value: u64) -> Duration {
    Duration::from_secs(value)
}

#[test]
fn restarts_back_off_then_give_up_within_the_window() {
    let policy = RestartPolicy::default();
    let mut history = RestartHistory::default();
    let start = Instant::now();
    let mut decisions = Vec::new();
    // Six exits in a row, each a second after its restart.
    for exit in 0..6u64 {
        decisions.push(history.on_exit(&policy, start + secs(exit * 2), secs(1)));
    }
    assert_eq!(
        decisions,
        [
            Decision::Restart(secs(1)),
            Decision::Restart(secs(5)),
            Decision::Restart(secs(15)),
            Decision::Restart(secs(30)),
            Decision::Restart(secs(60)),
            Decision::GiveUp,
        ]
    );
}

#[test]
fn a_browser_that_ran_long_enough_waits_the_shortest_time_again() {
    let policy = RestartPolicy::default();
    let mut history = RestartHistory::default();
    let start = Instant::now();
    assert_eq!(
        history.on_exit(&policy, start, secs(1)),
        Decision::Restart(secs(1))
    );
    assert_eq!(
        history.on_exit(&policy, start + secs(3), secs(1)),
        Decision::Restart(secs(5))
    );
    // It then ran for three minutes: healthy again.
    assert_eq!(
        history.on_exit(&policy, start + secs(200), secs(180)),
        Decision::Restart(secs(1))
    );
    // Starts older than the window no longer count against the budget.
    let mut history = RestartHistory::default();
    for exit in 0..5u64 {
        assert!(matches!(
            history.on_exit(&policy, start + secs(exit), Duration::ZERO),
            Decision::Restart(_)
        ));
    }
    assert_eq!(
        history.on_exit(&policy, start + secs(30), Duration::ZERO),
        Decision::GiveUp
    );
    assert!(matches!(
        history.on_exit(&policy, start + secs(11 * 60), Duration::ZERO),
        Decision::Restart(_)
    ));
}

#[test]
fn an_exit_names_its_status_or_signal() {
    // Wait statuses as the kernel encodes them: status << 8, or the signal.
    assert_eq!(describe_wait_status(1 << 8), "exited with status 1");
    assert_eq!(
        describe_wait_status(libc::SIGKILL),
        "killed by signal 9 (SIGKILL)"
    );
    assert_eq!(
        describe_wait_status(libc::SIGSEGV),
        format!("killed by signal {} (SIGSEGV)", libc::SIGSEGV)
    );
}

#[test]
fn proc_stat_gives_the_state_and_start_time_after_the_command_name() {
    let stat = "4242 (chrome (renderer) x) S 1 4242 4242 0 -1 4194560 6083 0 0 0 12 4 0 0 20 0 9 0 987654 2147483647 1234";
    assert_eq!(parse_stat(stat), Some(('S', 987654)));
    let zombie = "4242 (chrome) Z 1 4242 4242 0 -1 4194560 6083 0 0 0 12 4 0 0 20 0 1 0 987654 0 0";
    assert_eq!(parse_stat(zombie), Some(('Z', 987654)));
    assert_eq!(parse_stat("4242 (chrome) S 1"), None);
}

// ---------------------------------------------------------------------------
// The watch, against a fake entrypoint whose "Chromium" is a `sleep` this
// test starts and stops itself.

struct Fixture {
    _dir: tempfile::TempDir,
    pid_file: PathBuf,
    warning_file: PathBuf,
    launches: PathBuf,
    entrypoint: PathBuf,
}

impl Fixture {
    /// An entrypoint whose `launch-chromium` starts a browser for its first
    /// `browsers` launches; later launches start nothing, as a launch whose
    /// Chromium never answered removes the pid file.
    fn new(browsers: u32) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("chromium.pid");
        let warning_file = dir.path().join("chromium-warning.txt");
        let launches = dir.path().join("launches");
        let entrypoint = dir.path().join("runtime-entrypoint");
        std::fs::write(
            &entrypoint,
            format!(
                "#!/bin/sh\n\
                 [ \"$1\" = launch-chromium ] || exit 64\n\
                 echo launch >> '{launches}'\n\
                 count=$(wc -l < '{launches}')\n\
                 if [ \"$count\" -le {browsers} ]; then\n\
                 \tsleep 300 >/dev/null 2>&1 &\n\
                 \techo $! > '{pid}'\n\
                 fi\n\
                 exit 0\n",
                launches = launches.display(),
                pid = pid_file.display(),
            ),
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&entrypoint, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            _dir: dir,
            pid_file,
            warning_file,
            launches,
            entrypoint,
        }
    }

    fn config(&self, delays_ms: &[u64], max_restarts: usize) -> WatchConfig {
        WatchConfig {
            pid_file: self.pid_file.clone(),
            warning_file: self.warning_file.clone(),
            entrypoint: self.entrypoint.display().to_string(),
            poll: Duration::from_millis(20),
            policy: RestartPolicy {
                delays: delays_ms
                    .iter()
                    .copied()
                    .map(Duration::from_millis)
                    .collect(),
                max_restarts,
                window: secs(600),
                healthy_after: secs(600),
            },
            command_prefix: None,
        }
    }

    /// Starts the browser the way the entrypoint does at boot.
    fn boot(&self) -> i32 {
        let status = std::process::Command::new(&self.entrypoint)
            .arg("launch-chromium")
            .status()
            .unwrap();
        assert!(status.success());
        read_pid(&self.pid_file).expect("the boot launch wrote a pid")
    }

    fn launches(&self) -> usize {
        std::fs::read_to_string(&self.launches)
            .map(|text| text.lines().count())
            .unwrap_or(0)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        // Only the fake browser this test's entrypoint started.
        if let Some(pid) = read_pid(&self.pid_file) {
            kill(pid);
        }
    }
}

fn kill(pid: i32) {
    // SAFETY: the pid is a `sleep` this test's fake entrypoint started.
    unsafe {
        libc::kill(pid, libc::SIGKILL);
    }
}

async fn until(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + secs(10);
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn running_pid(watch: &BootBrowserWatch) -> Option<i32> {
    let status = watch.status.lock().unwrap();
    (status.state == BootBrowserState::Running)
        .then_some(status.running)
        .flatten()
}

fn alive(pid: i32) -> bool {
    matches!(process_state(pid, None), ProcessState::Running(_))
}

#[tokio::test]
async fn a_chromium_that_exits_is_started_again() {
    let fixture = Fixture::new(10);
    let first = fixture.boot();
    let watch = BootBrowserWatch::new();
    let shutdown = ShutdownSignal::new();
    let task = tokio::spawn(run_watch(
        watch.clone(),
        fixture.config(&[10], 5),
        shutdown.clone(),
    ));

    until("the watch to see the browser", || {
        running_pid(&watch) == Some(first)
    })
    .await;
    assert_eq!(watch.snapshot().state, BootBrowserState::Running);
    kill(first);

    until("a new browser", || {
        running_pid(&watch).is_some_and(|pid| pid != first)
    })
    .await;
    let second = running_pid(&watch).unwrap();
    assert_eq!(read_pid(&fixture.pid_file), Some(second));
    assert!(alive(second));
    assert_eq!(fixture.launches(), 2, "the boot launch and one restart");
    assert!(!fixture.warning_file.exists());

    // It keeps watching the new one.
    kill(second);
    until("a third browser", || {
        running_pid(&watch).is_some_and(|pid| pid != first && pid != second)
    })
    .await;
    assert_eq!(fixture.launches(), 3);

    shutdown.cancel();
    task.await.unwrap();
}

#[tokio::test]
async fn a_chromium_that_does_not_start_again_is_given_up_with_a_clear_status() {
    let fixture = Fixture::new(1);
    let first = fixture.boot();
    let watch = BootBrowserWatch::new();
    let shutdown = ShutdownSignal::new();
    let task = tokio::spawn(run_watch(
        watch.clone(),
        fixture.config(&[5, 10], 2),
        shutdown.clone(),
    ));
    until("the watch to see the browser", || {
        running_pid(&watch) == Some(first)
    })
    .await;
    kill(first);

    until("the watch to give up", || {
        watch.snapshot().state == BootBrowserState::Stopped
    })
    .await;
    assert_eq!(fixture.launches(), 3, "the boot launch and two restarts");
    let warning = std::fs::read_to_string(&fixture.warning_file).unwrap();
    assert!(
        warning.starts_with("Instafy's browser stopped 3 times in 10 minutes and was not started again. Restart this machine to open it."),
        "{warning}"
    );
    assert!(chromium_state_for_log_of(&watch).contains("stopped"));

    // Nothing is started after that.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(fixture.launches(), 3);
    assert_eq!(watch.snapshot().state, BootBrowserState::Stopped);

    shutdown.cancel();
    task.await.unwrap();
}

fn chromium_state_for_log_of(watch: &BootBrowserWatch) -> String {
    watch.describe()
}

#[tokio::test]
async fn a_browser_never_seen_running_is_not_started() {
    let fixture = Fixture::new(10);
    let watch = BootBrowserWatch::new();
    let shutdown = ShutdownSignal::new();
    let task = tokio::spawn(run_watch(
        watch.clone(),
        fixture.config(&[1], 5),
        shutdown.clone(),
    ));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(fixture.launches(), 0);
    // Nothing to report: the transports behave as before.
    assert_eq!(watch.snapshot().state, BootBrowserState::Running);
    assert_eq!(chromium_state_for_log_of(&watch), "not seen running yet");
    shutdown.cancel();
    task.await.unwrap();
}

#[tokio::test]
async fn shutdown_ends_the_watch_before_a_restart() {
    let fixture = Fixture::new(10);
    let first = fixture.boot();
    let watch = BootBrowserWatch::new();
    let shutdown = ShutdownSignal::new();
    let task = tokio::spawn(run_watch(
        watch.clone(),
        fixture.config(&[10_000], 5),
        shutdown.clone(),
    ));
    until("the watch to see the browser", || {
        running_pid(&watch) == Some(first)
    })
    .await;
    kill(first);
    until("the restart to be scheduled", || {
        watch.snapshot().state == BootBrowserState::Restarting
    })
    .await;
    shutdown.cancel();
    tokio::time::timeout(secs(2), task)
        .await
        .expect("the watch ends at shutdown")
        .unwrap();
    assert_eq!(fixture.launches(), 1, "no restart after shutdown");
}

#[tokio::test]
async fn a_browser_started_by_someone_else_is_watched_without_a_restart() {
    let fixture = Fixture::new(10);
    let first = fixture.boot();
    let watch = BootBrowserWatch::new();
    let shutdown = ShutdownSignal::new();
    let task = tokio::spawn(run_watch(
        watch.clone(),
        fixture.config(&[10], 5),
        shutdown.clone(),
    ));
    until("the watch to see the browser", || {
        running_pid(&watch) == Some(first)
    })
    .await;
    // A profile restore after a new registration starts its own browser and
    // stops the old one.
    let second = fixture.boot();
    kill(first);
    until("the watch to follow the new browser", || {
        running_pid(&watch) == Some(second)
    })
    .await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fixture.launches(), 2, "the watch started none of them");
    shutdown.cancel();
    task.await.unwrap();
}

#[test]
fn a_shared_browser_job_is_refused_once_the_watch_gave_up() {
    let watch = BootBrowserWatch::new();
    let _installed = install_watch_for_tests(watch.clone());
    // Running or restarting: the job runs, and its steps meet the browser.
    for state in [BootBrowserState::Running, BootBrowserState::Restarting] {
        watch.set(state, None);
        assert!(crate::browser_host::admit_shared_browser_job(true, true).is_ok());
    }
    watch.set(BootBrowserState::Stopped, None);
    let refused = crate::browser_host::admit_shared_browser_job(true, true)
        .expect_err("refused")
        .to_string();
    assert!(
        refused.starts_with("Instafy's browser stopped on this space's machine"),
        "{refused}"
    );
    // Other jobs are not affected.
    assert!(crate::browser_host::admit_shared_browser_job(false, true).is_ok());
    // Origin reports the same state.
    assert_eq!(
        origin_handle().expect("a handle").snapshot().state,
        BootBrowserState::Stopped
    );
}
