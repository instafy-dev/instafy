//! A fake `runtime-entrypoint start-browser-host` for supervisor and agent
//! tests. It reads its behaviour from a `mode` file and keeps one `sleep`
//! child in its group, as Chromium would be. A fake CDP close helper asks it
//! to end the way Chromium's `Browser.close` ends the real host.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use origin_http_server::browser_host::{BrowserHostSnapshot, BrowserHostState};

use super::persistence::{CloseCommand, HostPersistence, ProfileStore};
use super::process::{self, HostDirs};
use super::supervisor::{BrowserHost, HostConfig};

const FAKE_HOST: &str = r#"#!/bin/bash
[ "$1" = "start-browser-host" ] || exit 64
dir="$FAKE_HOST_DIR"
echo "$$" >> "$dir/starts"
env > "$dir/env.$$"
mode="$(cat "$dir/mode" 2>/dev/null || echo ready)"
child=""
on_term() {
  if [ "$mode" != "orphan" ] && [ -n "$child" ]; then
    kill -KILL "$child" 2>/dev/null
  fi
  echo "instafy-browser-host: stopped"
  exit 0
}
trap on_term TERM
case "$mode" in
  fail) echo "instafy-browser-host: failed port_in_use"; exit 66 ;;
  gated) while [ ! -f "$dir/go" ]; do sleep 0.05; done ;;
esac
if [ "$mode" = "orphan" ]; then
  (trap '' TERM; exec sleep 300) &
else
  sleep 300 &
fi
child=$!
echo "$child" > "$dir/child"
case "$mode" in
  hang) ;;
  badready) echo "instafy-browser-host: ready display=:47 cdp=9223 vnc=15900 egress=19226 webrtc=off scale=1 elapsed_ms=1" ;;
  *) echo "instafy-browser-host: ready display=:47 cdp=19223 vnc=15900 egress=19226 webrtc=off scale=1 elapsed_ms=5" ;;
esac
if [ "$mode" = "ignoreterm" ]; then
  trap '' TERM
fi
while true; do
  if [ -f "$dir/vanish" ]; then
    # Exits on its own and leaves its child (holding stdout) to the agent.
    rm -f "$dir/vanish"
    exit 72
  fi
  if [ -f "$dir/crash" ]; then
    rm -f "$dir/crash"
    kill -KILL "$child"
    echo "instafy-browser-host: exited chromium"
    exit 71
  fi
  if [ -f "$dir/close" ] && [ "$mode" != "ignoreclose" ]; then
    # Chromium closed over CDP: the host stops its group and reports it.
    rm -f "$dir/close"
    kill -KILL "$child"
    echo "instafy-browser-host: exited chromium"
    exit 71
  fi
  sleep 0.05
done
"#;

/// The CDP close helper: records the call, then asks the fake host to close
/// unless `close-fails` exists.
const FAKE_CLOSE: &str = r#"#!/bin/bash
dir="$1"
echo "$$" >> "$dir/closes"
[ -f "$dir/close-fails" ] && exit 1
: > "$dir/close"
exit 0
"#;

pub(crate) struct Fake {
    temp: tempfile::TempDir,
}

impl Fake {
    pub(crate) fn new(mode: &str) -> Self {
        let temp = tempfile::tempdir().expect("fake host directory");
        use std::os::unix::fs::PermissionsExt;
        for (name, script) in [
            ("runtime-entrypoint", FAKE_HOST),
            ("fake-close", FAKE_CLOSE),
        ] {
            let path = temp.path().join(name);
            std::fs::write(&path, script).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let fake = Self { temp };
        fake.set_mode(mode);
        fake
    }

    pub(crate) fn dir(&self) -> &Path {
        self.temp.path()
    }

    pub(crate) fn set_mode(&self, mode: &str) {
        std::fs::write(self.dir().join("mode"), mode).unwrap();
    }

    pub(crate) fn touch(&self, name: &str) {
        std::fs::write(self.dir().join(name), b"").unwrap();
    }

    pub(crate) fn starts(&self) -> usize {
        std::fs::read_to_string(self.dir().join("starts"))
            .map(|starts| starts.lines().count())
            .unwrap_or(0)
    }

    pub(crate) fn closes(&self) -> usize {
        std::fs::read_to_string(self.dir().join("closes"))
            .map(|closes| closes.lines().count())
            .unwrap_or(0)
    }

    /// The host's profile directory.
    pub(crate) fn profile(&self) -> std::path::PathBuf {
        self.dir().join("browser-host").join("profile")
    }

    pub(crate) fn child_pid(&self) -> i32 {
        std::fs::read_to_string(self.dir().join("child"))
            .expect("the fake host started its child")
            .trim()
            .parse()
            .unwrap()
    }

    pub(crate) fn config(&self) -> HostConfig {
        let dirs = HostDirs::under(&self.dir().join("browser-host"));
        let mut environment = process::host_environment(&dirs, None, |_| None);
        environment.push((
            "FAKE_HOST_DIR".to_string(),
            self.dir().to_string_lossy().into_owned(),
        ));
        HostConfig {
            entrypoint: self.dir().join("runtime-entrypoint"),
            dirs,
            actions_file: Some(self.dir().join("actions.jsonl")),
            environment,
            start_budget: Duration::from_secs(15),
            stop_grace: Duration::from_secs(2),
            idle_stop_after: Duration::from_secs(3600),
            idle_tick: Duration::from_millis(50),
            presence_grace: Duration::from_millis(300),
            group_confirm: Duration::from_secs(10),
            persistence: None,
            close: Some(CloseCommand {
                program: self.dir().join("fake-close"),
                args: vec![self.dir().to_string_lossy().into_owned()],
            }),
        }
    }

    pub(crate) fn spawn(&self) -> Arc<BrowserHost> {
        BrowserHost::spawn(self.config())
    }

    /// [`Fake::config`] for a host that restores from and saves to `store`,
    /// periodically every `interval`.
    pub(crate) fn persisting_config(
        &self,
        store: Arc<dyn ProfileStore>,
        interval: Duration,
    ) -> HostConfig {
        let mut config = self.config();
        config.persistence = Some(Arc::new(HostPersistence::new(store, interval)));
        config
    }

    pub(crate) fn spawn_persisting(
        &self,
        store: Arc<dyn ProfileStore>,
        interval: Duration,
    ) -> Arc<BrowserHost> {
        BrowserHost::spawn(self.persisting_config(store, interval))
    }
}

pub(crate) fn process_alive(pid: i32) -> bool {
    // SAFETY: signal 0 only checks for existence.
    unsafe { libc::kill(pid, 0) == 0 }
}

pub(crate) async fn eventually(what: &str, within: Duration, check: impl Fn() -> bool) {
    let deadline = Instant::now() + within;
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

pub(crate) async fn wait_for_state(
    host: &BrowserHost,
    state: BrowserHostState,
) -> BrowserHostSnapshot {
    eventually(
        &format!("{state:?}, last {:?}", host.snapshot()),
        // Generous: these run on real time, on loaded CI machines too.
        Duration::from_secs(20),
        || host.snapshot().state == state,
    )
    .await;
    host.snapshot()
}
