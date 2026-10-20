//! The host child: its directories, environment, status lines and process
//! group. The host is `runtime-entrypoint start-browser-host`
//! (`docker/runtime/entrypoint.sh`), which prints one status line per outcome.

use std::path::{Path, PathBuf};

use super::mode::{HOST_CDP_PORT, HOST_DISPLAY, HOST_EGRESS_PORT, HOST_VNC_PORT, PINNED_CHROMIUM};
use crate::model_environment::BROWSER_HOST_ENV_KEYS;

pub(crate) const STATUS_PREFIX: &str = "instafy-browser-host:";
pub(crate) const START_SUBCOMMAND: &str = "start-browser-host";
pub(crate) const HOST_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
/// The longest status line read; longer lines are skipped.
const MAX_STATUS_LINE_BYTES: usize = 4096;
const MAX_LOGGED_STDERR_LINES: usize = 64;
const MAX_LOGGED_STDERR_LINE_BYTES: usize = 512;

/// The entrypoint's failure reasons (`failed <reason>`), as reported.
pub(crate) const HOST_FAILURE_REASONS: [&str; 11] = [
    "config_invalid",
    "port_reserved",
    "display_in_use",
    "port_in_use",
    "profile_in_use",
    "host_in_use",
    "stack_missing",
    "egress_unavailable",
    "display_failed",
    "chromium_failed",
    "host_error",
];

/// The agent's own failure tokens.
pub(crate) const EXITED_EGRESS_PROXY: &str = "exited_egress_proxy";
pub(crate) const EXITED_DISPLAY: &str = "exited_display";
pub(crate) const EXITED_CHROMIUM: &str = "exited_chromium";
pub(crate) const EXITED_UNKNOWN: &str = "exited_unknown";
pub(crate) const START_TIMEOUT: &str = "start_timeout";
pub(crate) const SPAWN_FAILED: &str = "spawn_failed";
pub(crate) const UNCONFIRMED_SHUTDOWN: &str = "unconfirmed_shutdown";
pub(crate) const HOST_ERROR: &str = "host_error";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum HostLine {
    /// `ready` with exactly the agent's ports, egress isolation running and
    /// WebRTC off.
    Ready,
    /// `failed <reason>`; an unknown reason reads as `host_error`.
    Failed(&'static str),
    /// `exited <child>`, as a failure token.
    Exited(&'static str),
    Stopped,
}

/// Reads one stdout line of the host. `None` for anything without the
/// status prefix. A `ready` line that does not report the agent's own ports,
/// the egress proxy on its port and WebRTC off is a `host_error`.
pub(crate) fn parse_status_line(line: &str) -> Option<HostLine> {
    let rest = line.trim_end().strip_prefix(STATUS_PREFIX)?;
    let mut words = rest.split_whitespace();
    match words.next()? {
        "ready" => {
            let mut cdp = None;
            let mut vnc = None;
            let mut egress = None;
            let mut webrtc = None;
            let mut display = None;
            for word in words {
                let Some((key, value)) = word.split_once('=') else {
                    continue;
                };
                match key {
                    "cdp" => cdp = Some(value),
                    "vnc" => vnc = Some(value),
                    "egress" => egress = Some(value),
                    "webrtc" => webrtc = Some(value),
                    "display" => display = Some(value),
                    _ => {}
                }
            }
            let cdp_port = HOST_CDP_PORT.to_string();
            let vnc_port = HOST_VNC_PORT.to_string();
            let egress_port = HOST_EGRESS_PORT.to_string();
            if cdp == Some(cdp_port.as_str())
                && vnc == Some(vnc_port.as_str())
                && egress == Some(egress_port.as_str())
                && webrtc == Some("off")
                && display.is_none_or(|display| display == HOST_DISPLAY)
            {
                Some(HostLine::Ready)
            } else {
                Some(HostLine::Failed(HOST_ERROR))
            }
        }
        "failed" => {
            let reason = words.next().unwrap_or_default();
            Some(HostLine::Failed(
                HOST_FAILURE_REASONS
                    .iter()
                    .copied()
                    .find(|known| *known == reason)
                    .unwrap_or(HOST_ERROR),
            ))
        }
        "exited" => Some(HostLine::Exited(match words.next().unwrap_or_default() {
            "egress-proxy" => EXITED_EGRESS_PROXY,
            "display" => EXITED_DISPLAY,
            "chromium" => EXITED_CHROMIUM,
            _ => EXITED_UNKNOWN,
        })),
        "stopped" => Some(HostLine::Stopped),
        _ => None,
    }
}

/// The host's directories under one root.
#[derive(Clone, Debug)]
pub(crate) struct HostDirs {
    pub root: PathBuf,
    pub profile: PathBuf,
    pub home: PathBuf,
    pub state: PathBuf,
}

impl HostDirs {
    pub(crate) fn under(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
            profile: root.join("profile"),
            home: root.join("home"),
            state: root.join("state"),
        }
    }

    fn all(&self) -> [&Path; 4] {
        [&self.root, &self.profile, &self.home, &self.state]
    }
}

/// Creates the root and its `profile`, `home` and `state` with mode 0700,
/// then checks each is a real directory. A symlink at any of them, or at the
/// root's parent (`/var/lib/instafy`), fails closed.
pub(crate) fn prepare_dirs(dirs: &HostDirs) -> std::io::Result<()> {
    if let Some(parent) = dirs.root.parent() {
        match std::fs::symlink_metadata(parent) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(std::io::Error::other(format!(
                    "browser host directory {} must not be a symlink",
                    parent.display()
                )));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    for dir in dirs.all() {
        let mut builder = std::fs::DirBuilder::new();
        builder.recursive(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(dir)?;
    }
    for dir in dirs.all() {
        let metadata = std::fs::symlink_metadata(dir)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(std::io::Error::other(format!(
                "browser host directory {} must be a real directory",
                dir.display()
            )));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

/// The host child's whole environment: [`BROWSER_HOST_ENV_KEYS`] taken from
/// `lookup`, then the agent's own locations, ports and isolation settings.
pub(crate) fn host_environment(
    dirs: &HostDirs,
    chromium: Option<&Path>,
    lookup: impl Fn(&str) -> Option<String>,
) -> Vec<(String, String)> {
    let mut environment: Vec<(String, String)> = BROWSER_HOST_ENV_KEYS
        .iter()
        .filter(|key| **key != "PATH")
        .filter_map(|key| lookup(key).map(|value| ((*key).to_string(), value)))
        .collect();
    let path = |dir: &Path| dir.to_string_lossy().into_owned();
    environment.extend([
        ("PATH".to_string(), HOST_PATH.to_string()),
        ("INSTAFY_BROWSER_HOST_HOME".to_string(), path(&dirs.home)),
        (
            "INSTAFY_BROWSER_HOST_PROFILE_DIR".to_string(),
            path(&dirs.profile),
        ),
        (
            "INSTAFY_BROWSER_HOST_STATE_DIR".to_string(),
            path(&dirs.state),
        ),
        (
            "INSTAFY_BROWSER_HOST_DISPLAY".to_string(),
            HOST_DISPLAY.to_string(),
        ),
        (
            "INSTAFY_BROWSER_HOST_CDP_PORT".to_string(),
            HOST_CDP_PORT.to_string(),
        ),
        (
            "INSTAFY_BROWSER_HOST_VNC_PORT".to_string(),
            HOST_VNC_PORT.to_string(),
        ),
        (
            "INSTAFY_BROWSER_HOST_EGRESS_PORT".to_string(),
            HOST_EGRESS_PORT.to_string(),
        ),
        (
            "INSTAFY_BROWSER_EGRESS_ISOLATION".to_string(),
            "1".to_string(),
        ),
        (
            "INSTAFY_BROWSER_WEBRTC_ENABLED".to_string(),
            "0".to_string(),
        ),
    ]);
    if let Some(chromium) = chromium {
        environment.push(("INSTAFY_BROWSER_HOST_CHROMIUM".to_string(), path(chromium)));
    }
    environment
}

/// The pinned Chromium when it is executable.
pub(crate) fn pinned_chromium() -> Option<PathBuf> {
    let path = Path::new(PINNED_CHROMIUM);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata = std::fs::metadata(path).ok()?;
        (metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
            .then(|| path.to_path_buf())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}

/// Empties the Shared Browser action log, so a new browser never replays an
/// earlier one's cursor. Never follows a symlink, never creates the file,
/// never blocks on a FIFO, and empties only a regular file with one link, so
/// a hard link planted in its place never truncates another file.
pub(crate) fn truncate_actions_file(path: &Path) {
    let mut options = std::fs::OpenOptions::new();
    options.write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let result = options.open(path).and_then(|file| {
        let metadata = file.metadata()?;
        #[cfg(unix)]
        let single_link = {
            use std::os::unix::fs::MetadataExt;
            metadata.nlink() == 1
        };
        #[cfg(not(unix))]
        let single_link = true;
        if !metadata.is_file() || !single_link {
            return Err(std::io::Error::other(
                "the action log is not a regular file with one link",
            ));
        }
        file.set_len(0)
    });
    match result {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(
            %error,
            path = %path.display(),
            "could not empty the Shared Browser action log"
        ),
    }
}

/// Reads status lines from the host's stdout until EOF, sending each one
/// that parses. `exited` and `stopped` come after `ready`, so this never
/// stops early.
pub(crate) async fn read_status_lines(
    stdout: impl tokio::io::AsyncRead + Unpin,
    lines: tokio::sync::mpsc::UnboundedSender<HostLine>,
) {
    read_bounded_lines(stdout, MAX_STATUS_LINE_BYTES, true, |line| {
        if let Some(parsed) = parse_status_line(&String::from_utf8_lossy(line)) {
            let _ = lines.send(parsed);
        }
    })
    .await;
}

/// Drains the host's stderr until EOF, logging only its first lines.
pub(crate) async fn drain_stderr(stderr: impl tokio::io::AsyncRead + Unpin) {
    let mut logged = 0usize;
    read_bounded_lines(stderr, MAX_LOGGED_STDERR_LINE_BYTES, false, |line| {
        if logged < MAX_LOGGED_STDERR_LINES {
            logged += 1;
            tracing::info!(line = %String::from_utf8_lossy(line), "browser host");
        }
    })
    .await;
}

/// Splits `reader` into lines of at most `max_line` bytes until EOF or a read
/// error. An overlong line is skipped with `skip_overlong`, otherwise cut.
async fn read_bounded_lines(
    mut reader: impl tokio::io::AsyncRead + Unpin,
    max_line: usize,
    skip_overlong: bool,
    mut on_line: impl FnMut(&[u8]),
) {
    use tokio::io::AsyncReadExt;
    let mut chunk = [0u8; 4096];
    let mut line = Vec::with_capacity(256);
    let mut overlong = false;
    loop {
        let read = match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        for &byte in &chunk[..read] {
            if byte == b'\n' {
                if !overlong {
                    on_line(&line);
                }
                line.clear();
                overlong = false;
            } else if line.len() < max_line {
                line.push(byte);
            } else if skip_overlong {
                overlong = true;
            }
        }
    }
    if !line.is_empty() && !overlong {
        on_line(&line);
    }
}

/// Process-group operations on the host. The host leads its own group
/// (`process_group(0)`), so its pid is the group id.
#[cfg(unix)]
pub(crate) mod group {
    /// SIGTERM to the host process only; the host stops its own group.
    pub(crate) fn terminate(pid: i32) {
        if pid > 0 {
            // SAFETY: signals a pid this process spawned and has not reaped.
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }

    /// SIGKILL to the whole group; a group that is gone is not an error.
    pub(crate) fn kill(pgid: i32) {
        // Never this process's own group.
        // SAFETY: reads this process's group id.
        if pgid > 0 && pgid != unsafe { libc::getpgrp() } {
            // SAFETY: the host's group, which this process created.
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        }
    }

    /// Reaps this process's own exited children in the group, so zombies
    /// (descendants reparented to a PID 1 agent) do not count as alive. Call
    /// only after the host pid itself has been reaped.
    pub(crate) fn reap(pgid: i32) {
        if pgid <= 0 {
            return;
        }
        loop {
            let mut status = 0;
            // SAFETY: a non-blocking wait for this process's children in the group.
            if unsafe { libc::waitpid(-pgid, &mut status, libc::WNOHANG) } <= 0 {
                break;
            }
        }
    }

    /// Whether any process of the group still exists (EPERM counts as alive).
    pub(crate) fn exists(pgid: i32) -> bool {
        if pgid <= 0 {
            return false;
        }
        // SAFETY: signal 0 only checks for existence and permission.
        if unsafe { libc::killpg(pgid, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
    }
}

/// Off Unix there is no host (lazy mode needs Linux); these keep the
/// supervisor compiling for Desktop's Windows build.
#[cfg(not(unix))]
pub(crate) mod group {
    pub(crate) fn terminate(_pid: i32) {}
    pub(crate) fn kill(_pgid: i32) {}
    pub(crate) fn reap(_pgid: i32) {}
    pub(crate) fn exists(_pgid: i32) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(rest: &str) -> String {
        format!("{STATUS_PREFIX} {rest}")
    }

    #[test]
    fn ready_requires_the_agents_ports_and_webrtc_off() {
        assert_eq!(
            parse_status_line(&line(
                "ready display=:47 cdp=19223 vnc=15900 egress=19226 webrtc=off scale=1 elapsed_ms=812"
            )),
            Some(HostLine::Ready)
        );
        for wrong in [
            "ready display=:47 cdp=9223 vnc=15900 egress=19226 webrtc=off scale=1 elapsed_ms=1",
            "ready display=:47 cdp=19223 vnc=5900 egress=19226 webrtc=off scale=1 elapsed_ms=1",
            "ready display=:47 cdp=19223 vnc=15900 egress=19226 webrtc=19225 scale=1 elapsed_ms=1",
            "ready display=:47 cdp=19223 vnc=15900 egress=19226 webrtc=unavailable scale=1",
            "ready display=:2 cdp=19223 vnc=15900 egress=19226 webrtc=off scale=1",
            "ready display=:47 cdp=19223 vnc=15900 egress=off webrtc=off scale=1",
            "ready display=:47 cdp=19223 vnc=15900 egress=9226 webrtc=off scale=1",
            "ready display=:47 cdp=19223 vnc=15900 webrtc=off scale=1",
            "ready cdp=19223 vnc=15900",
            "ready",
        ] {
            assert_eq!(
                parse_status_line(&line(wrong)),
                Some(HostLine::Failed(HOST_ERROR)),
                "{wrong}"
            );
        }
    }

    #[test]
    fn every_failure_reason_and_exit_is_a_known_token() {
        for reason in HOST_FAILURE_REASONS {
            assert_eq!(
                parse_status_line(&line(&format!("failed {reason}"))),
                Some(HostLine::Failed(reason))
            );
        }
        assert_eq!(
            parse_status_line(&line("failed something_new")),
            Some(HostLine::Failed(HOST_ERROR))
        );
        assert_eq!(
            parse_status_line(&line("failed")),
            Some(HostLine::Failed(HOST_ERROR))
        );
        for (child, token) in [
            ("egress-proxy", EXITED_EGRESS_PROXY),
            ("display", EXITED_DISPLAY),
            ("chromium", EXITED_CHROMIUM),
            ("window-manager", EXITED_UNKNOWN),
            ("unknown", EXITED_UNKNOWN),
        ] {
            assert_eq!(
                parse_status_line(&line(&format!("exited {child}"))),
                Some(HostLine::Exited(token))
            );
        }
        assert_eq!(parse_status_line(&line("stopped")), Some(HostLine::Stopped));
        assert_eq!(
            parse_status_line(&line("stopped\n")),
            Some(HostLine::Stopped)
        );
        assert_eq!(parse_status_line("[instafy] browser host: ready"), None);
        assert_eq!(parse_status_line(&line("listening")), None);
        assert_eq!(parse_status_line("instafy-browser-hostx: stopped"), None);
    }

    #[tokio::test]
    async fn status_lines_are_read_to_eof_and_overlong_lines_skipped() {
        let input = format!(
            "noise\n{}\n{}{}\n{}\n{}",
            line("ready display=:47 cdp=19223 vnc=15900 egress=19226 webrtc=off scale=1"),
            line("failed "),
            "x".repeat(MAX_STATUS_LINE_BYTES * 2),
            line("exited chromium"),
            line("stopped"),
        );
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        read_status_lines(input.as_bytes(), sender).await;
        let mut seen = Vec::new();
        while let Ok(parsed) = receiver.try_recv() {
            seen.push(parsed);
        }
        assert_eq!(
            seen,
            vec![
                HostLine::Ready,
                HostLine::Exited(EXITED_CHROMIUM),
                HostLine::Stopped
            ]
        );
    }

    #[test]
    fn host_environment_is_an_allowlist_with_the_agents_own_settings() {
        let dirs = HostDirs::under(Path::new("/var/lib/instafy/browser-host"));
        let poisoned = |key: &str| -> Option<String> {
            Some(match key {
                "PATH" => "/workspace/bin:/usr/bin".to_string(),
                _ => format!("from-agent-{key}"),
            })
        };
        let environment = host_environment(&dirs, Some(Path::new(PINNED_CHROMIUM)), poisoned);
        let get = |key: &str| {
            environment
                .iter()
                .filter(|(name, _)| name == key)
                .map(|(_, value)| value.as_str())
                .collect::<Vec<_>>()
        };
        assert_eq!(get("PATH"), vec![HOST_PATH]);
        assert_eq!(
            get("INSTAFY_BROWSER_HOST_PROFILE_DIR"),
            vec!["/var/lib/instafy/browser-host/profile"]
        );
        assert_eq!(
            get("INSTAFY_BROWSER_HOST_HOME"),
            vec!["/var/lib/instafy/browser-host/home"]
        );
        assert_eq!(
            get("INSTAFY_BROWSER_HOST_STATE_DIR"),
            vec!["/var/lib/instafy/browser-host/state"]
        );
        assert_eq!(get("INSTAFY_BROWSER_HOST_DISPLAY"), vec![":47"]);
        assert_eq!(get("INSTAFY_BROWSER_HOST_CDP_PORT"), vec!["19223"]);
        assert_eq!(get("INSTAFY_BROWSER_HOST_VNC_PORT"), vec!["15900"]);
        assert_eq!(get("INSTAFY_BROWSER_HOST_EGRESS_PORT"), vec!["19226"]);
        assert_eq!(get("INSTAFY_BROWSER_EGRESS_ISOLATION"), vec!["1"]);
        assert_eq!(get("INSTAFY_BROWSER_WEBRTC_ENABLED"), vec!["0"]);
        assert_eq!(get("INSTAFY_BROWSER_HOST_CHROMIUM"), vec![PINNED_CHROMIUM]);
        assert_eq!(
            get("INSTAFY_BROWSER_RENDER_SCALE"),
            vec!["from-agent-INSTAFY_BROWSER_RENDER_SCALE"]
        );
        assert!(get("HOME").is_empty());
        for (key, _) in &environment {
            assert!(
                !key.starts_with("RUNTIME_")
                    && !key.contains("TOKEN")
                    && !key.contains("ICE_SERVERS")
                    && !key.contains("SECRET")
                    && key != "INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV"
                    && key != "INSTAFY_BROWSER_HOST_RELAUNCHED"
                    && key != "INSTAFY_BROWSER_HOST_WEBRTC_PORT"
                    && key != "INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN"
                    && key != "NODE_PATH"
                    && key != "PLAYWRIGHT_BROWSERS_PATH"
                    && !crate::model_environment::is_model_child_excluded_env_key(key),
                "the host must not inherit {key}"
            );
        }
        let without_chromium = host_environment(&dirs, None, |_| None);
        assert!(
            !without_chromium
                .iter()
                .any(|(key, _)| key == "INSTAFY_BROWSER_HOST_CHROMIUM")
        );
    }

    #[test]
    fn the_host_allowlist_is_the_helper_baseline_without_home() {
        use crate::model_environment::PERSISTENT_HELPER_BASE_ENV_KEYS;
        let baseline: Vec<&str> = PERSISTENT_HELPER_BASE_ENV_KEYS
            .iter()
            .copied()
            .filter(|key| *key != "HOME")
            .collect();
        assert_eq!(
            &BROWSER_HOST_ENV_KEYS[..baseline.len()],
            baseline.as_slice()
        );
        for key in &BROWSER_HOST_ENV_KEYS[baseline.len()..] {
            assert!(
                key.starts_with("INSTAFY_BROWSER_")
                    || key.starts_with("INSTAFY_VNC_")
                    || *key == "INSTAFY_CHROMIUM_CDP_READY_TIMEOUT_SECS",
                "{key}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_profile_is_refused() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("browser-host");
        let dirs = HostDirs::under(&root);
        prepare_dirs(&dirs).expect("fresh directories");
        for dir in [&dirs.root, &dirs.profile, &dirs.home, &dirs.state] {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "{}", dir.display());
        }

        let elsewhere = temp.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::remove_dir(&dirs.profile).unwrap();
        std::os::unix::fs::symlink(&elsewhere, &dirs.profile).unwrap();
        assert!(prepare_dirs(&dirs).is_err());

        let linked_root = temp.path().join("linked-root");
        std::os::unix::fs::symlink(&root, &linked_root).unwrap();
        std::fs::remove_file(&dirs.profile).unwrap();
        assert!(prepare_dirs(&HostDirs::under(&linked_root)).is_err());

        // A symlinked parent (`/var/lib/instafy`) would move the profile.
        let real_parent = temp.path().join("real-parent");
        std::fs::create_dir(&real_parent).unwrap();
        let linked_parent = temp.path().join("linked-parent");
        std::os::unix::fs::symlink(&real_parent, &linked_parent).unwrap();
        assert!(prepare_dirs(&HostDirs::under(&linked_parent.join("browser-host"))).is_err());
        assert!(
            !real_parent.join("browser-host").exists(),
            "nothing is created through a symlinked parent"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_action_log_is_emptied_without_following_a_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let log = temp.path().join("actions.jsonl");
        std::fs::write(&log, b"{\"type\":\"navigate\"}\n").unwrap();
        truncate_actions_file(&log);
        assert_eq!(std::fs::read(&log).unwrap(), b"");

        let target = temp.path().join("target");
        std::fs::write(&target, b"keep").unwrap();
        let linked = temp.path().join("linked.jsonl");
        std::os::unix::fs::symlink(&target, &linked).unwrap();
        truncate_actions_file(&linked);
        assert_eq!(std::fs::read(&target).unwrap(), b"keep");

        truncate_actions_file(&temp.path().join("missing.jsonl"));
        assert!(!temp.path().join("missing.jsonl").exists());

        // A hard link in the log's place never truncates the linked file.
        let shared = temp.path().join("shared");
        std::fs::write(&shared, b"keep").unwrap();
        let hard = temp.path().join("hard.jsonl");
        std::fs::hard_link(&shared, &hard).unwrap();
        truncate_actions_file(&hard);
        assert_eq!(std::fs::read(&shared).unwrap(), b"keep");

        // A FIFO in the log's place neither blocks the start nor changes.
        let fifo = temp.path().join("fifo.jsonl");
        let c_path = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
        // SAFETY: a valid C path in a private temporary directory.
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let (done, finished) = std::sync::mpsc::channel();
        let truncating = fifo.clone();
        std::thread::spawn(move || {
            truncate_actions_file(&truncating);
            let _ = done.send(());
        });
        finished
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("emptying a FIFO action log returns at once");
        use std::os::unix::fs::FileTypeExt;
        assert!(
            std::fs::symlink_metadata(&fifo)
                .unwrap()
                .file_type()
                .is_fifo()
        );
    }

    /// The entrypoint's side of the contract: the prefix, the variables the
    /// agent sets, the failure reasons and the ports it reserves.
    #[test]
    fn the_entrypoint_speaks_this_contract() {
        let entrypoint = include_str!("../../../../docker/runtime/entrypoint.sh");
        assert!(entrypoint.contains(&format!(
            "readonly BROWSER_HOST_STATUS_PREFIX=\"{STATUS_PREFIX}\""
        )));
        assert!(entrypoint.contains(&format!("if [ \"${{1:-}}\" = \"{START_SUBCOMMAND}\" ]")));
        for variable in [
            "INSTAFY_BROWSER_HOST_HOME",
            "INSTAFY_BROWSER_HOST_PROFILE_DIR",
            "INSTAFY_BROWSER_HOST_STATE_DIR",
            "INSTAFY_BROWSER_HOST_DISPLAY",
            "INSTAFY_BROWSER_HOST_CDP_PORT",
            "INSTAFY_BROWSER_HOST_VNC_PORT",
            "INSTAFY_BROWSER_HOST_EGRESS_PORT",
            "INSTAFY_BROWSER_HOST_CHROMIUM",
        ] {
            assert!(
                entrypoint.contains(&format!("${{{variable}")),
                "the entrypoint no longer reads {variable}"
            );
        }
        for reason in HOST_FAILURE_REASONS {
            assert!(
                entrypoint.contains(&format!("browser_host_fail {reason} ")),
                "the entrypoint no longer reports {reason}"
            );
        }
        for child in ["egress-proxy", "display", "chromium"] {
            assert!(
                entrypoint.contains(&format!("browser_host_track_child {child} ")),
                "the entrypoint no longer names the {child} child"
            );
        }
        assert!(entrypoint.contains("browser_host_status \"exited ${exited_name}\""));
        assert!(entrypoint.contains("browser_host_status \"stopped\""));
        assert!(entrypoint.contains(
            "browser_host_status \"ready display=${display} cdp=${cdp_port} vnc=${vnc_port} egress=${egress_status} webrtc=${webrtc_status}"
        ));
        let reserved = entrypoint
            .lines()
            .find(|line| line.starts_with("readonly -a BROWSER_HOST_RESERVED_PORTS="))
            .expect("the entrypoint reserves the boot-time ports");
        for port in [HOST_CDP_PORT, HOST_VNC_PORT, HOST_EGRESS_PORT] {
            assert!(
                !reserved.contains(&port.to_string()),
                "port {port} is reserved for the boot-time browser"
            );
        }
        assert!(
            entrypoint.contains("if [ \"${display_number}\" = \"1\" ]"),
            "display :1 is the boot-time browser's"
        );
        assert_ne!(HOST_DISPLAY, ":1");
    }
}
