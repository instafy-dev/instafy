//! Restore and save around the host's starts and stops, against a fake
//! `runtime-entrypoint start-browser-host`, a fake CDP close helper and an
//! in-memory profile store, on real time.

use super::*;
use crate::browser_host::persistence::testing::{FakeStore, UploadMode};
use crate::browser_host::test_support::{Fake, eventually, wait_for_state};

const COOKIES: &str = "Default/Network/Cookies";
/// Long enough that no periodic save runs unless a test wants one.
const NO_PERIODIC: Duration = Duration::from_secs(3600);
const PERIODIC: Duration = Duration::from_millis(100);

fn write_cookies(fake: &Fake, contents: &[u8]) {
    let path = fake.profile().join(COOKIES);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

fn read_cookies(fake: &Fake) -> Option<Vec<u8>> {
    std::fs::read(fake.profile().join(COOKIES)).ok()
}

/// The stored archive's cookie database.
fn stored_cookies(store: &FakeStore) -> Option<Vec<u8>> {
    let archive = store.stored().1?;
    let staging = tempfile::tempdir().unwrap();
    crate::browser_profile::restore_profile_baseline(
        crate::controller::BrowserProfileSnapshot {
            version: 1,
            archive: Some(archive),
        },
        &staging.path().join("profile"),
    )
    .unwrap();
    std::fs::read(staging.path().join("profile").join(COOKIES)).ok()
}

async fn start_ready(host: &BrowserHost) {
    host.request_start("user").unwrap();
    wait_for_state(host, BrowserHostState::Ready).await;
}

#[tokio::test]
async fn a_start_restores_the_stored_profile_before_the_host_runs() {
    let fake = Fake::new("ready");
    let store = FakeStore::new();
    // A planted file in the local profile, and a stored sign-in.
    write_cookies(&fake, b"planted");
    let staging = tempfile::tempdir().unwrap();
    let stored = staging.path().join(COOKIES);
    std::fs::create_dir_all(stored.parent().unwrap()).unwrap();
    std::fs::write(&stored, b"stored sign-in").unwrap();
    store.set_stored(
        2,
        Some(crate::browser_profile::pack_profile(staging.path()).unwrap()),
    );

    let host = fake.spawn_persisting(store.clone(), NO_PERIODIC);
    start_ready(&host).await;
    assert_eq!(read_cookies(&fake).as_deref(), Some(&b"stored sign-in"[..]));
    assert_eq!(store.fetches(), 1);
    host.stop("test").await;
}

#[tokio::test]
async fn a_host_stop_closes_the_browser_then_saves_and_later_starts_save_again() {
    let fake = Fake::new("ready");
    let store = FakeStore::new();
    let host = fake.spawn_persisting(store.clone(), NO_PERIODIC);
    start_ready(&host).await;
    write_cookies(&fake, b"signed in");

    host.stop("test").await;
    let stopped = host.snapshot();
    assert_eq!(stopped.state, BrowserHostState::Idle);
    assert_eq!(stopped.failure, None);
    assert_eq!(fake.closes(), 1, "closed over CDP before the save");
    assert_eq!(store.stored().0, 1);
    assert_eq!(stored_cookies(&store).as_deref(), Some(&b"signed in"[..]));

    // The next start keeps the local profile and saves again at its stop.
    start_ready(&host).await;
    assert_eq!(read_cookies(&fake).as_deref(), Some(&b"signed in"[..]));
    write_cookies(&fake, b"signed in again");
    host.stop("test").await;
    assert_eq!(store.stored().0, 2);
    assert_eq!(
        stored_cookies(&store).as_deref(),
        Some(&b"signed in again"[..])
    );
}

#[tokio::test]
async fn the_idle_stop_saves_too() {
    let fake = Fake::new("ready");
    let store = FakeStore::new();
    let mut config = fake.persisting_config(store.clone(), NO_PERIODIC);
    config.idle_stop_after = Duration::from_millis(400);
    let host = BrowserHost::spawn(config);
    start_ready(&host).await;
    write_cookies(&fake, b"signed in");
    wait_for_state(&host, BrowserHostState::Idle).await;
    eventually("the idle stop's save", Duration::from_secs(10), || {
        store.stored().0 == 1
    })
    .await;
    assert_eq!(fake.closes(), 1);
}

#[tokio::test]
async fn periodic_saves_run_only_while_ready() {
    let fake = Fake::new("gated");
    let store = FakeStore::new();
    let host = fake.spawn_persisting(store.clone(), PERIODIC);
    host.request_start("user").unwrap();
    // The host is spawned (after the restore) but not Ready yet.
    eventually("the host to spawn", Duration::from_secs(10), || {
        fake.starts() == 1
    })
    .await;
    write_cookies(&fake, b"while starting");
    tokio::time::sleep(PERIODIC * 5).await;
    assert_eq!(host.snapshot().state, BrowserHostState::Starting);
    assert_eq!(store.uploads_started(), 0, "no save before Ready");

    fake.touch("go");
    wait_for_state(&host, BrowserHostState::Ready).await;
    eventually("a periodic save", Duration::from_secs(10), || {
        store.stored().0 == 1
    })
    .await;
    write_cookies(&fake, b"later");
    eventually("another periodic save", Duration::from_secs(10), || {
        store.stored().0 == 2
    })
    .await;

    // Once stopped, nothing saves any more.
    host.stop("test").await;
    let after_stop = store.uploads_started();
    write_cookies(&fake, b"after the stop");
    tokio::time::sleep(PERIODIC * 5).await;
    assert_eq!(store.uploads_started(), after_stop);
}

#[tokio::test]
async fn a_stop_waits_for_an_upload_in_flight_instead_of_aborting_it() {
    let fake = Fake::new("ready");
    let store = FakeStore::new();
    let host = fake.spawn_persisting(store.clone(), PERIODIC);
    start_ready(&host).await;
    store.set_open(false);
    write_cookies(&fake, b"signed in");
    eventually(
        "a periodic upload to begin",
        Duration::from_secs(10),
        || store.uploads_started() == 1,
    )
    .await;

    let stopping = tokio::spawn({
        let host = host.clone();
        async move { host.stop("test").await }
    });
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!stopping.is_finished(), "the stop waits for the upload");
    assert_eq!(fake.closes(), 0, "the browser is closed only afterwards");

    store.set_open(true);
    tokio::time::timeout(Duration::from_secs(20), stopping)
        .await
        .expect("the stop finishes")
        .unwrap();
    assert_eq!(store.uploads_finished(), 1, "the upload was not aborted");
    assert_eq!(store.stored().0, 1);
    assert_eq!(
        store.uploads_started(),
        1,
        "the stop's own save had nothing new to send"
    );
    assert_eq!(host.snapshot().state, BrowserHostState::Idle);
}

#[tokio::test]
async fn a_close_that_cannot_be_confirmed_never_packs() {
    // The close helper fails.
    let fake = Fake::new("ready");
    let store = FakeStore::new();
    let host = fake.spawn_persisting(store.clone(), NO_PERIODIC);
    start_ready(&host).await;
    write_cookies(&fake, b"signed in");
    fake.touch("close-fails");
    host.stop("test").await;
    assert_eq!(fake.closes(), 1);
    assert_eq!(host.snapshot().state, BrowserHostState::Idle);
    assert_eq!(store.uploads_started(), 0);

    // The close is sent, but the browser does not exit.
    let fake = Fake::new("ignoreclose");
    let store = FakeStore::new();
    let host = fake.spawn_persisting(store.clone(), NO_PERIODIC);
    start_ready(&host).await;
    write_cookies(&fake, b"signed in");
    host.stop("test").await;
    assert_eq!(fake.closes(), 1);
    assert_eq!(host.snapshot().state, BrowserHostState::Idle);
    assert_eq!(store.uploads_started(), 0);
}

#[tokio::test]
async fn a_host_exit_without_an_exited_chromium_line_never_packs() {
    // A different child is reported first, or the host is killed with no
    // line at all: Chromium may not have flushed its cookies.
    for mode in ["closeother", "closekilled"] {
        let fake = Fake::new(mode);
        let store = FakeStore::new();
        let host = fake.spawn_persisting(store.clone(), NO_PERIODIC);
        start_ready(&host).await;
        write_cookies(&fake, b"not flushed");
        host.stop("test").await;
        assert_eq!(fake.closes(), 1, "{mode}");
        assert_eq!(host.snapshot().state, BrowserHostState::Idle, "{mode}");
        assert_eq!(store.uploads_started(), 0, "{mode}");
    }
}

#[tokio::test]
async fn poison_and_kill_never_save() {
    let fake = Fake::new("ready");
    let store = FakeStore::new();
    let host = fake.spawn_persisting(store.clone(), PERIODIC);
    start_ready(&host).await;
    host.poison();
    write_cookies(&fake, b"after poison");
    tokio::time::sleep(PERIODIC * 5).await;
    host.stop("test").await;
    assert_eq!(host.snapshot().state, BrowserHostState::Poisoned);
    assert_eq!(store.uploads_started(), 0);
    assert_eq!(fake.closes(), 0);

    let fake = Fake::new("ready");
    let store = FakeStore::new();
    let host = fake.spawn_persisting(store.clone(), PERIODIC);
    start_ready(&host).await;
    host.kill_now();
    write_cookies(&fake, b"after the kill");
    tokio::time::sleep(PERIODIC * 5).await;
    assert_eq!(store.uploads_started(), 0);
}

#[tokio::test]
async fn the_runtime_shutdown_saves_once_and_nothing_after() {
    let fake = Fake::new("ready");
    let store = FakeStore::new();
    let host = fake.spawn_persisting(store.clone(), PERIODIC);
    start_ready(&host).await;
    write_cookies(&fake, b"signed in");
    // Before the first periodic tick.
    host.shutdown(Duration::from_secs(10)).await;
    assert_eq!(host.snapshot().state, BrowserHostState::Idle);
    assert_eq!(store.stored().0, 1);
    assert_eq!(stored_cookies(&store).as_deref(), Some(&b"signed in"[..]));
    write_cookies(&fake, b"after shutdown");
    tokio::time::sleep(PERIODIC * 5).await;
    assert_eq!(store.uploads_started(), 1);
}

#[tokio::test]
async fn the_runtime_shutdown_respects_its_budget() {
    let fake = Fake::new("ready");
    let store = FakeStore::new();
    let host = fake.spawn_persisting(store.clone(), NO_PERIODIC);
    start_ready(&host).await;
    write_cookies(&fake, b"signed in");
    store.set_open(false);
    let started = std::time::Instant::now();
    host.shutdown(Duration::from_secs(3)).await;
    assert!(
        started.elapsed() < Duration::from_millis(3500),
        "took {:?}",
        started.elapsed()
    );
    assert_eq!(store.uploads_started(), 1, "the final save was attempted");
    assert_eq!(store.stored().0, 0);
}

#[tokio::test]
async fn the_runtime_shutdown_saves_a_closed_profile_whose_stop_save_failed() {
    let fake = Fake::new("ready");
    let store = FakeStore::new();
    let host = fake.spawn_persisting(store.clone(), NO_PERIODIC);
    start_ready(&host).await;
    write_cookies(&fake, b"signed in");
    store.set_mode(UploadMode::UncertainBeforeCommit);
    host.stop("idle").await;
    assert_eq!(store.uploads_started(), 1);
    assert_eq!(store.stored().0, 0);

    store.set_mode(UploadMode::Normal);
    host.shutdown(Duration::from_secs(10)).await;
    assert_eq!(store.stored().0, 1);
    assert_eq!(stored_cookies(&store).as_deref(), Some(&b"signed in"[..]));
    assert_eq!(fake.starts(), 1, "saved without starting the browser");
}

#[tokio::test]
async fn the_runtime_shutdown_never_saves_a_profile_whose_close_was_not_confirmed() {
    let fake = Fake::new("ready");
    let store = FakeStore::new();
    let host = fake.spawn_persisting(store.clone(), NO_PERIODIC);
    start_ready(&host).await;
    write_cookies(&fake, b"signed in");
    fake.touch("close-fails");
    host.stop("idle").await;
    host.shutdown(Duration::from_secs(10)).await;
    assert_eq!(store.uploads_started(), 0);
}
