//! Restore and save against an in-memory store with the controller's
//! versioned writes.

use super::testing::{FakeStore, UploadMode};
use super::*;
use reqwest::StatusCode;

const COOKIES: &str = "Default/Network/Cookies";

fn write(profile: &Path, relative: &str, contents: &[u8]) {
    let path = profile.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

fn read(profile: &Path, relative: &str) -> Option<Vec<u8>> {
    std::fs::read(profile.join(relative)).ok()
}

/// A stored archive holding `cookies` as the cookie database.
fn archive_with_cookies(cookies: &[u8]) -> Vec<u8> {
    let staging = tempfile::tempdir().unwrap();
    write(staging.path(), COOKIES, cookies);
    write(staging.path(), "Local State", b"{}");
    pack_profile(staging.path()).unwrap()
}

struct Setup {
    _root: tempfile::TempDir,
    profile: PathBuf,
    store: Arc<FakeStore>,
    persistence: Arc<HostPersistence>,
}

fn setup() -> Setup {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("browser-host").join("profile");
    std::fs::create_dir_all(&profile).unwrap();
    let store = FakeStore::new();
    let persistence = Arc::new(
        HostPersistence::new(store.clone(), Duration::from_secs(3600))
            .with_restore_budget(Duration::from_secs(5)),
    );
    Setup {
        _root: root,
        profile,
        store,
        persistence,
    }
}

impl Setup {
    async fn save(&self, kind: SaveKind) -> SaveOutcome {
        self.persistence.save(&self.profile, kind, None, None).await
    }

    async fn restore(&self) -> RestoreOutcome {
        self.persistence.restore(&self.profile).await.unwrap()
    }
}

#[tokio::test]
async fn the_first_start_installs_the_stored_profile_exactly() {
    let setup = setup();
    setup
        .store
        .set_stored(3, Some(archive_with_cookies(b"stored sign-in")));
    write(&setup.profile, COOKIES, b"stale local cookies");
    write(&setup.profile, "Default/Network/Cookies-journal", b"stale");

    assert_eq!(setup.restore().await, RestoreOutcome::Installed);
    assert_eq!(
        read(&setup.profile, COOKIES).as_deref(),
        Some(&b"stored sign-in"[..])
    );
    assert_eq!(
        read(&setup.profile, "Default/Network/Cookies-journal"),
        None,
        "an exact baseline, not an overlay"
    );
    // Unchanged since the restore: nothing to send.
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Unchanged);
    assert_eq!(setup.store.uploads_started(), 0);
}

#[tokio::test]
async fn a_matching_version_and_hash_keeps_the_local_profile() {
    let setup = setup();
    assert_eq!(setup.restore().await, RestoreOutcome::Installed);
    write(&setup.profile, COOKIES, b"signed in");
    assert_eq!(setup.save(SaveKind::HostStop).await, SaveOutcome::Saved(1));

    // Local state that is not packed survives the next start.
    write(&setup.profile, "Default/Preferences", b"{}");
    assert_eq!(setup.restore().await, RestoreOutcome::KeptLocal);
    assert!(read(&setup.profile, "Default/Preferences").is_some());
    assert_eq!(
        read(&setup.profile, COOKIES).as_deref(),
        Some(&b"signed in"[..])
    );
}

#[tokio::test]
async fn after_a_conflict_the_next_start_installs_the_stored_copy() {
    let setup = setup();
    setup.restore().await;
    write(&setup.profile, COOKIES, b"mine");
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Saved(1));

    // Another runtime saved meanwhile.
    setup
        .store
        .set_stored(2, Some(archive_with_cookies(b"theirs")));
    write(&setup.profile, COOKIES, b"mine, changed");
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Conflict);
    // Saves stop until the stored copy is installed.
    write(&setup.profile, COOKIES, b"mine, changed again");
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Skipped);
    assert_eq!(setup.store.stored().0, 2);

    assert_eq!(setup.restore().await, RestoreOutcome::Installed);
    assert_eq!(
        read(&setup.profile, COOKIES).as_deref(),
        Some(&b"theirs"[..])
    );
    write(&setup.profile, COOKIES, b"mine on theirs");
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Saved(3));
}

#[tokio::test]
async fn an_uncertain_upload_that_committed_is_resolved_at_the_next_start() {
    let setup = setup();
    setup.restore().await;
    write(&setup.profile, COOKIES, b"signed in");
    setup.store.set_mode(UploadMode::UncertainAfterCommit);
    assert_eq!(setup.save(SaveKind::HostStop).await, SaveOutcome::Uncertain);
    assert_eq!(setup.store.stored().0, 1);

    setup.store.set_mode(UploadMode::Normal);
    write(&setup.profile, "Default/Preferences", b"{}");
    assert_eq!(setup.restore().await, RestoreOutcome::KeptLocal);
    assert!(
        read(&setup.profile, "Default/Preferences").is_some(),
        "kept local"
    );
    // The committed copy is the writer's now: nothing new to send.
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Unchanged);
    write(&setup.profile, COOKIES, b"signed in, later");
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Saved(2));
}

#[tokio::test]
async fn an_uncertain_upload_that_never_landed_is_sent_again() {
    let setup = setup();
    setup.restore().await;
    write(&setup.profile, COOKIES, b"signed in");
    setup.store.set_mode(UploadMode::UncertainBeforeCommit);
    assert_eq!(setup.save(SaveKind::HostStop).await, SaveOutcome::Uncertain);
    assert_eq!(setup.store.stored().0, 0);

    setup.store.set_mode(UploadMode::Normal);
    assert_eq!(setup.restore().await, RestoreOutcome::KeptLocal);
    assert_eq!(
        read(&setup.profile, COOKIES).as_deref(),
        Some(&b"signed in"[..])
    );
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Saved(1));
}

#[tokio::test]
async fn an_uncertain_upload_is_resolved_by_the_next_tick_while_running() {
    // Committed: the tick adopts it and has nothing new to send.
    let setup = setup();
    setup.restore().await;
    write(&setup.profile, COOKIES, b"signed in");
    setup.store.set_mode(UploadMode::UncertainAfterCommit);
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Uncertain);
    setup.store.set_mode(UploadMode::Normal);
    let fetches = setup.store.fetches();
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Unchanged);
    assert_eq!(setup.store.fetches(), fetches + 1, "one read-only fetch");
    assert_eq!(setup.store.uploads_started(), 1);

    // Not landed: the tick sends it again.
    let setup = self::setup();
    setup.restore().await;
    write(&setup.profile, COOKIES, b"signed in");
    setup.store.set_mode(UploadMode::UncertainBeforeCommit);
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Uncertain);
    setup.store.set_mode(UploadMode::Normal);
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Saved(1));

    // An unreachable store keeps it pending; neither copy stored means
    // another writer won.
    let setup = self::setup();
    setup.restore().await;
    write(&setup.profile, COOKIES, b"signed in");
    setup.store.set_mode(UploadMode::UncertainBeforeCommit);
    setup.save(SaveKind::Periodic).await;
    setup.store.set_mode(UploadMode::Normal);
    setup.store.set_fetch_fails(true);
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Skipped);
    setup.store.set_fetch_fails(false);
    setup
        .store
        .set_stored(5, Some(archive_with_cookies(b"theirs")));
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Conflict);
    assert_eq!(
        read(&setup.profile, COOKIES).as_deref(),
        Some(&b"signed in"[..])
    );
    assert_eq!(setup.restore().await, RestoreOutcome::Installed);
}

#[tokio::test]
async fn an_unreadable_store_without_a_baseline_starts_empty() {
    let setup = setup();
    write(&setup.profile, COOKIES, b"planted");
    write(&setup.profile, "Default/Preferences", b"{}");
    setup.store.set_fetch_fails(true);
    assert_eq!(setup.restore().await, RestoreOutcome::StartedEmpty);
    assert!(
        !setup.profile.exists() || std::fs::read_dir(&setup.profile).unwrap().next().is_none(),
        "nothing planted survives"
    );
    // Saves stay off: nothing may overwrite the store from an unknown base.
    std::fs::create_dir_all(&setup.profile).unwrap();
    write(&setup.profile, COOKIES, b"new");
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Skipped);
    assert_eq!(setup.store.uploads_started(), 0);
}

#[cfg(unix)]
#[tokio::test]
async fn emptying_the_profile_never_follows_a_symlink() {
    let setup = setup();
    let outside = tempfile::tempdir().unwrap();
    write(outside.path(), "keep", b"outside");
    std::fs::remove_dir_all(&setup.profile).unwrap();
    std::os::unix::fs::symlink(outside.path(), &setup.profile).unwrap();
    setup.store.set_fetch_fails(true);
    assert_eq!(setup.restore().await, RestoreOutcome::StartedEmpty);
    assert!(std::fs::symlink_metadata(&setup.profile).is_err());
    assert!(outside.path().join("keep").exists());
}

#[tokio::test]
async fn an_unreadable_store_keeps_a_local_profile_this_process_restored() {
    // With a writer: keep local and keep saving.
    let setup = setup();
    setup.restore().await;
    write(&setup.profile, COOKIES, b"signed in");
    setup.store.set_fetch_fails(true);
    assert_eq!(setup.restore().await, RestoreOutcome::KeptLocal);
    setup.store.set_fetch_fails(false);
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Saved(1));

    // Without a writer (after a conflict): keep local, saves off.
    setup
        .store
        .set_stored(4, Some(archive_with_cookies(b"theirs")));
    write(&setup.profile, COOKIES, b"changed");
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Conflict);
    setup.store.set_fetch_fails(true);
    assert_eq!(setup.restore().await, RestoreOutcome::KeptLocalSavesOff);
    assert_eq!(
        read(&setup.profile, COOKIES).as_deref(),
        Some(&b"changed"[..])
    );
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Skipped);
}

#[tokio::test]
async fn a_rejected_copy_keeps_the_writer_and_is_not_sent_again() {
    let setup = setup();
    setup.restore().await;
    write(&setup.profile, COOKIES, b"too large");
    setup
        .store
        .set_mode(UploadMode::Reject(StatusCode::PAYLOAD_TOO_LARGE));
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Rejected);
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Unchanged);
    assert_eq!(setup.store.uploads_started(), 1, "the same copy is skipped");

    setup.store.set_mode(UploadMode::Normal);
    write(&setup.profile, COOKIES, b"smaller");
    assert_eq!(
        setup.save(SaveKind::Periodic).await,
        SaveOutcome::Saved(1),
        "the kept writer still owns version 0"
    );
}

#[tokio::test]
async fn a_host_stop_save_does_not_latch_but_the_final_save_does() {
    let setup = setup();
    setup.restore().await;
    write(&setup.profile, COOKIES, b"one");
    assert_eq!(setup.save(SaveKind::HostStop).await, SaveOutcome::Saved(1));
    write(&setup.profile, COOKIES, b"two");
    assert_eq!(setup.save(SaveKind::HostStop).await, SaveOutcome::Saved(2));
    write(&setup.profile, COOKIES, b"three");
    assert_eq!(setup.save(SaveKind::Final).await, SaveOutcome::Saved(3));
    write(&setup.profile, COOKIES, b"four");
    assert_eq!(setup.save(SaveKind::Periodic).await, SaveOutcome::Skipped);
    assert_eq!(setup.store.stored().0, 3);
}

#[tokio::test]
async fn a_save_respects_its_deadline_and_reads_as_uncertain() {
    let setup = setup();
    setup.restore().await;
    write(&setup.profile, COOKIES, b"signed in");
    setup.store.set_open(false);
    let started = std::time::Instant::now();
    let deadline = Instant::now() + Duration::from_millis(300);
    assert_eq!(
        setup
            .persistence
            .save(&setup.profile, SaveKind::Final, Some(deadline), None)
            .await,
        SaveOutcome::Uncertain
    );
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn disabled_persistence_and_a_browser_that_is_not_ready_never_save() {
    let setup = setup();
    setup.restore().await;
    write(&setup.profile, COOKIES, b"signed in");
    let not_ready = || false;
    assert_eq!(
        setup
            .persistence
            .save(&setup.profile, SaveKind::Periodic, None, Some(&not_ready))
            .await,
        SaveOutcome::Skipped
    );
    setup.persistence.disable();
    assert_eq!(setup.save(SaveKind::HostStop).await, SaveOutcome::Skipped);
    assert_eq!(setup.store.uploads_started(), 0);
}

#[test]
fn the_snapshot_interval_comes_from_the_launch_environment() {
    assert_eq!(parse_snapshot_interval(Some("30")), Duration::from_secs(30));
    assert_eq!(parse_snapshot_interval(Some("0")), Duration::ZERO);
    assert_eq!(
        parse_snapshot_interval(Some("soon")),
        DEFAULT_SNAPSHOT_INTERVAL
    );
    assert_eq!(parse_snapshot_interval(None), DEFAULT_SNAPSHOT_INTERVAL);
}

#[test]
fn the_close_helper_uses_the_private_node_and_playwright_on_the_hosts_port() {
    let close = CloseCommand::for_host();
    assert_eq!(close.program, Path::new(HOST_NODE_BINARY));
    assert!(close.args[1].contains(&format!(
        "require('{}')",
        super::super::mode::HOST_PLAYWRIGHT_PATH
    )));
    assert!(close.args[1].contains("Browser.close"));
    assert_eq!(close.args[2], "http://127.0.0.1:19223");
}

/// The host writes the session-restore preference on every start, after the
/// download block and before Chromium launches, and never on the boot path.
#[test]
fn the_entrypoint_keeps_the_browser_session_on_every_host_start() {
    let entrypoint = include_str!("../../../../docker/runtime/entrypoint.sh");
    assert!(entrypoint.contains("preferences.session.restore_on_startup = 1;"));
    let host = entrypoint
        .split_once("start_browser_host() {")
        .expect("the host's start function")
        .1;
    let block = host
        .find("block_browser_downloads \"${profile_dir}\"")
        .expect("the host blocks downloads");
    let keep = host
        .find("keep_browser_session_on_restart \"${profile_dir}\"")
        .expect("the host keeps the session");
    let launch = host
        .find("build_chromium_launch_flags")
        .expect("the host launches Chromium");
    assert!(block < keep && keep < launch);
    assert_eq!(
        entrypoint
            .matches("keep_browser_session_on_restart \"")
            .count(),
        1,
        "only the host path sets session restore"
    );
}

/// The image smoke closes Chromium with this exact helper, so the published
/// image proves the agent's close keeps sign-ins.
#[test]
fn the_image_smoke_closes_the_browser_with_the_agents_helper() {
    let smoke = include_str!("../../../../scripts/runtime-image-browser-smoke.sh");
    assert!(smoke.contains(&format!("\n{CLOSE_SCRIPT}\n")));
}
