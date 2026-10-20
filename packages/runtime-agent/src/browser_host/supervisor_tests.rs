//! The supervisor against a fake `runtime-entrypoint start-browser-host`
//! (`test_support`), on real time with short budgets.

use super::*;
use crate::browser_host::mode::{LazyMode, force_lazy_mode_for_tests};
use crate::browser_host::test_support::{Fake, eventually, process_alive, wait_for_state};

#[tokio::test]
async fn start_is_single_flight_and_reaches_ready() {
    let fake = Fake::new("ready");
    let host = fake.spawn();
    assert_eq!(host.snapshot().state, BrowserHostState::Idle);
    assert_eq!(host.snapshot().generation, None);

    let first = host.request_start("user-a").expect("start");
    let second = host.request_start("user-b").expect("joins the same start");
    assert_eq!(first.state, BrowserHostState::Starting);
    assert!(first.generation.is_some());
    assert_eq!(second.generation, first.generation);

    let ready = wait_for_state(&host, BrowserHostState::Ready).await;
    assert_eq!(ready.generation, first.generation);
    assert_eq!(ready.failure, None);
    assert_eq!(fake.starts(), 1, "two requests started one host");
    assert!(host.is_ready());
    assert!(host.caller_facts("user-a").started_by_caller);
    assert!(!host.caller_facts("user-b").started_by_caller);
    assert_eq!(
        host.request_start("user-b").unwrap().generation,
        first.generation
    );

    let environment =
        std::fs::read_to_string(fake.dir().join(format!("env.{}", host.host_pgid()))).unwrap();
    assert!(!environment.lines().any(|line| line.starts_with("HOME=")));
    assert!(environment.contains("INSTAFY_BROWSER_HOST_CDP_PORT=19223"));
    assert!(environment.contains("INSTAFY_BROWSER_WEBRTC_ENABLED=0"));

    host.stop("test").await;
    assert_eq!(host.snapshot().state, BrowserHostState::Idle);
}

#[tokio::test]
async fn failures_carry_the_hosts_reason_or_the_agents_own() {
    let fake = Fake::new("fail");
    let host = fake.spawn();
    host.request_start("user").unwrap();
    let failed = wait_for_state(&host, BrowserHostState::Failed).await;
    assert_eq!(failed.failure, Some("port_in_use"));

    // A ready line with other ports is a host error, and that host is ended.
    fake.set_mode("badready");
    host.request_start("user").unwrap();
    let failed = wait_for_state(&host, BrowserHostState::Failed).await;
    assert_eq!(failed.failure, Some(HOST_ERROR));
    let child = fake.child_pid();
    eventually(
        "the bad host's group to end",
        Duration::from_secs(15),
        || !process_alive(child),
    )
    .await;

    // No ready line within the start budget.
    let fake = Fake::new("hang");
    let mut config = fake.config();
    config.start_budget = Duration::from_secs(2);
    let host = BrowserHost::spawn(config);
    host.request_start("user").unwrap();
    let failed = wait_for_state(&host, BrowserHostState::Failed).await;
    assert_eq!(failed.failure, Some(START_TIMEOUT));
    // On a loaded machine the budget can end before the fake started its child.
    if let Ok(child) = std::fs::read_to_string(fake.dir().join("child")) {
        let child: i32 = child.trim().parse().unwrap();
        eventually(
            "the timed-out host's group to end",
            Duration::from_secs(15),
            || !process_alive(child),
        )
        .await;
    }
}

#[tokio::test]
async fn a_crash_fails_and_the_next_start_runs_a_new_generation() {
    let fake = Fake::new("ready");
    let host = fake.spawn();
    let first = host.request_start("user").unwrap().generation;
    wait_for_state(&host, BrowserHostState::Ready).await;

    fake.touch("crash");
    let failed = wait_for_state(&host, BrowserHostState::Failed).await;
    assert_eq!(failed.failure, Some("exited_chromium"));
    assert_eq!(failed.generation, first);
    assert!(!host.caller_facts("user").started_by_caller);

    let second = host.request_start("user").unwrap().generation;
    assert_ne!(second, first);
    let ready = wait_for_state(&host, BrowserHostState::Ready).await;
    assert_eq!(ready.generation, second);
    assert_eq!(ready.failure, None);
    assert_eq!(fake.starts(), 2);
    host.stop("test").await;
}

#[tokio::test]
async fn stop_ends_idle_with_the_group_gone() {
    let fake = Fake::new("ready");
    let host = fake.spawn();
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;
    let child = fake.child_pid();

    host.stop("test").await;
    let idle = host.snapshot();
    assert_eq!(idle.state, BrowserHostState::Idle);
    assert_eq!(idle.generation, None);
    assert_eq!(idle.failure, None);
    assert_eq!(host.host_pgid(), 0);
    eventually("the browser child to end", Duration::from_secs(15), || {
        !process_alive(child)
    })
    .await;
}

#[tokio::test]
async fn a_host_that_leaves_its_group_behind_is_cleaned_up_by_group() {
    let fake = Fake::new("orphan");
    let host = fake.spawn();
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;
    let orphan = fake.child_pid();

    host.stop("test").await;
    assert_eq!(host.snapshot().state, BrowserHostState::Idle);
    eventually("the orphaned child to end", Duration::from_secs(15), || {
        !process_alive(orphan)
    })
    .await;
}

#[tokio::test]
async fn poison_kills_refuses_starts_and_stays() {
    let fake = Fake::new("ready");
    let host = fake.spawn();
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;
    let child = fake.child_pid();

    host.poison();
    let poisoned = host.snapshot();
    assert_eq!(poisoned.state, BrowserHostState::Poisoned);
    assert_eq!(poisoned.failure, Some(UNCONFIRMED_SHUTDOWN));
    let refusal = host.request_start("user").unwrap_err();
    assert_eq!(refusal.code, REFUSAL_POISONED);
    eventually(
        "the poisoned host's group to end",
        Duration::from_secs(15),
        || !process_alive(child) && host.host_pgid() == 0,
    )
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(host.snapshot().state, BrowserHostState::Poisoned);
    assert_eq!(
        host.request_start("user").unwrap_err().code,
        REFUSAL_POISONED
    );
    assert_eq!(fake.starts(), 1);
}

#[tokio::test]
async fn the_group_is_known_before_the_host_is_ready() {
    let fake = Fake::new("gated");
    let host = fake.spawn();
    host.request_start("user").unwrap();
    eventually(
        "the host's group to be stored",
        Duration::from_secs(15),
        || host.host_pgid() != 0,
    )
    .await;
    let pgid = host.host_pgid();
    assert_eq!(host.snapshot().state, BrowserHostState::Starting);
    assert!(group::exists(pgid));

    // Poison while Starting reaches the host through the stored group.
    host.poison();
    eventually("the gated host to end", Duration::from_secs(15), || {
        !group::exists(pgid)
    })
    .await;
    fake.touch("go");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(host.snapshot().state, BrowserHostState::Poisoned);
}

#[tokio::test]
async fn a_stop_racing_a_crash_settles_once() {
    let fake = Fake::new("ready");
    let host = fake.spawn();
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;

    fake.touch("crash");
    host.stop("test").await;
    let settled = host.snapshot();
    assert!(
        matches!(
            settled.state,
            BrowserHostState::Idle | BrowserHostState::Failed
        ),
        "{settled:?}"
    );
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        host.snapshot().state,
        settled.state,
        "the state moved again"
    );

    // A stop that won the race leaves the crash request unread.
    let _ = std::fs::remove_file(fake.dir().join("crash"));
    let next = host.request_start("user").unwrap().generation;
    let ready = wait_for_state(&host, BrowserHostState::Ready).await;
    assert_eq!(ready.generation, next);
    host.stop("test").await;
}

#[tokio::test]
async fn a_start_during_a_stop_is_refused_as_stopping() {
    let fake = Fake::new("ignoreterm");
    let mut config = fake.config();
    config.stop_grace = Duration::from_millis(800);
    let host = BrowserHost::spawn(config);
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;

    let stopping = {
        let host = host.clone();
        tokio::spawn(async move { host.stop("test").await })
    };
    wait_for_state(&host, BrowserHostState::Stopping).await;
    assert_eq!(
        host.request_start("user").unwrap_err().code,
        REFUSAL_STOPPING
    );
    stopping.await.unwrap();
    assert_eq!(host.snapshot().state, BrowserHostState::Idle);
}

#[tokio::test]
async fn shutdown_stops_the_host_and_refuses_later_starts() {
    let fake = Fake::new("ready");
    let host = fake.spawn();
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;
    let child = fake.child_pid();

    host.shutdown(Duration::from_secs(5)).await;
    assert_eq!(host.snapshot().state, BrowserHostState::Idle);
    assert_eq!(
        host.request_start("user").unwrap_err().code,
        REFUSAL_STOPPING
    );
    eventually("the browser child to end", Duration::from_secs(15), || {
        !process_alive(child)
    })
    .await;
}

#[test]
fn the_idle_stop_needs_ready_quiet_and_no_jobs() {
    let now = Instant::now();
    let after = Duration::from_secs(900);
    let quiet = now - Duration::from_secs(901);
    let recent = now - Duration::from_secs(60);
    assert!(should_idle_stop(
        BrowserHostState::Ready,
        quiet,
        now,
        0,
        after
    ));
    assert!(!should_idle_stop(
        BrowserHostState::Ready,
        quiet,
        now,
        1,
        after
    ));
    assert!(!should_idle_stop(
        BrowserHostState::Ready,
        recent,
        now,
        0,
        after
    ));
    for state in [
        BrowserHostState::Idle,
        BrowserHostState::Starting,
        BrowserHostState::Stopping,
        BrowserHostState::Failed,
        BrowserHostState::Poisoned,
    ] {
        assert!(!should_idle_stop(state, quiet, now, 0, after), "{state:?}");
    }
}

#[tokio::test]
async fn an_idle_host_stops_but_not_under_a_job() {
    let fake = Fake::new("ready");
    let mut config = fake.config();
    config.idle_stop_after = Duration::from_millis(1500);
    let host = BrowserHost::spawn(config);
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;

    let job = host.job_activity();
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert_eq!(
        host.snapshot().state,
        BrowserHostState::Ready,
        "a running job keeps the host"
    );
    drop(job);
    assert_eq!(host.active_jobs(), 0);
    // Dropping the job counts as activity, so the full idle time runs again.
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(host.snapshot().state, BrowserHostState::Ready);
    wait_for_state(&host, BrowserHostState::Idle).await;
}

#[tokio::test]
async fn presence_is_caller_relative_and_expires() {
    let fake = Fake::new("ready");
    let host = fake.spawn();
    host.note_seen("me");
    assert!(!host.caller_facts("me").other_seen_recently);
    host.note_seen("teammate");
    assert!(host.caller_facts("me").other_seen_recently);
    assert!(host.caller_facts("teammate").other_seen_recently);
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(!host.caller_facts("me").other_seen_recently);
}

#[tokio::test]
async fn the_action_log_is_emptied_only_without_a_running_job() {
    let fake = Fake::new("ready");
    let host = fake.spawn();
    let log = fake.dir().join("actions.jsonl");
    std::fs::write(&log, b"{\"type\":\"click\"}\n").unwrap();

    let job = host.job_activity();
    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;
    assert_eq!(std::fs::read(&log).unwrap(), b"{\"type\":\"click\"}\n");
    host.stop("test").await;
    drop(job);

    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;
    assert_eq!(std::fs::read(&log).unwrap(), b"");
    host.stop("test").await;
}

#[tokio::test]
async fn a_symlinked_profile_fails_the_start_closed() {
    let fake = Fake::new("ready");
    let config = fake.config();
    std::fs::create_dir_all(&config.dirs.root).unwrap();
    let elsewhere = fake.dir().join("elsewhere");
    std::fs::create_dir(&elsewhere).unwrap();
    std::os::unix::fs::symlink(&elsewhere, &config.dirs.profile).unwrap();
    let host = BrowserHost::spawn(config);
    host.request_start("user").unwrap();
    let failed = wait_for_state(&host, BrowserHostState::Failed).await;
    assert_eq!(failed.failure, Some(SPAWN_FAILED));
    assert_eq!(fake.starts(), 0, "no host ran on a redirected profile");
}

#[tokio::test]
async fn the_job_gate_holds_its_guard_and_admits_only_a_ready_host() {
    let _lazy = force_lazy_mode_for_tests(Some(LazyMode { persist: false }));
    let fake = Fake::new("ready");
    let host = fake.spawn();
    let _installed = crate::browser_host::install_host_for_tests(host.clone());

    let error = crate::browser_host::admit_shared_browser_job(true, false).unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("Instafy's browser is not open")
    );
    assert_eq!(host.active_jobs(), 0, "a refused job releases its guard");

    host.request_start("user").unwrap();
    wait_for_state(&host, BrowserHostState::Ready).await;
    let guard = crate::browser_host::admit_shared_browser_job(true, false)
        .expect("a Ready host admits the job")
        .expect("the job holds the host");
    assert_eq!(host.active_jobs(), 1);
    assert!(
        crate::browser_host::admit_shared_browser_job(false, false)
            .unwrap()
            .is_none(),
        "an ordinary turn takes no guard"
    );
    drop(guard);
    assert_eq!(host.active_jobs(), 0);
    host.stop("test").await;
}

#[tokio::test]
async fn origin_sees_the_host_through_its_handle() {
    let fake = Fake::new("ready");
    let host = fake.spawn();
    let _installed = crate::browser_host::install_host_for_tests(host.clone());
    let handle = crate::browser_host::origin_handle().expect("a handle with a host");
    assert_eq!(handle.snapshot().state, BrowserHostState::Idle);
    let started = handle.request_start("user").unwrap();
    assert_eq!(started.state, BrowserHostState::Starting);
    handle.note_seen("teammate");
    assert!(handle.caller_facts("user").other_seen_recently);
    assert!(handle.caller_facts("user").started_by_caller);
    wait_for_state(&host, BrowserHostState::Ready).await;
    assert_eq!(handle.snapshot().generation, started.generation);
    host.stop("test").await;
}
