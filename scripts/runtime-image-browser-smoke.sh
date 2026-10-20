#!/usr/bin/env bash
# Proves a runtime image starts the Shared Browser. By default it boots the
# image's own entrypoint with the browser session enabled and requires headed
# Chromium to answer on its CDP port (webdev images). It then proves the
# profile blocks downloads after a controller connection that denied them has
# closed, which is when viewers drive the page.
#
# With --lazy it proves the on-demand browser host instead, for every image
# flavor: the image boots with the browser off and must run no browser process
# (the base image must run none even with the browser session on), then
# `runtime-entrypoint start-browser-host` must bring Chromium up on the
# runtime agent's display, ports and profile directory, with WebRTC off. It
# sets a persistent cookie and one with no expiry, closes Chromium over CDP
# with the agent's own close helper, and requires both cookies, the
# session-restore and download-block preferences and the rest of the profile
# after the next start on the same profile. It then keeps only the files the
# agent packs (as a later machine restores them) and requires both cookies
# after a third start on that profile.
#
#   scripts/runtime-image-browser-smoke.sh [--lazy] <image> [<entrypoint to mount>]
#
# The entrypoint ends by exec'ing runtime-agent, which needs a controller. The
# smoke runs every line before that one (egress proxy, X/VNC, window manager,
# Chromium resolution and launch) and then holds the container open. With a
# second argument, that entrypoint file replaces the image's, so a change to
# docker/runtime/entrypoint.sh can be checked against a published image.
# It needs only Docker and the image: no registry login and no secrets.
set -euo pipefail

mode=eager
if [[ "${1:-}" == "--lazy" ]]; then
  mode=lazy
  shift
fi
image="${1:?usage: runtime-image-browser-smoke.sh [--lazy] <image> [<entrypoint>]}"
override="${2:-}"
timeout_seconds="${BROWSER_SMOKE_TIMEOUT_SECONDS:-120}"
cdp_port=9223
name="instafy-browser-smoke-${RANDOM}-$$"

cleanup() {
  docker rm -f "$name" "${name}-session" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mount=()
if [[ -n "$override" ]]; then
  if [[ ! -f "$override" ]]; then
    echo "::error::Entrypoint override $override does not exist."
    exit 1
  fi
  mount=(-v "$(cd "$(dirname "$override")" && pwd)/$(basename "$override"):/usr/local/bin/runtime-entrypoint:ro")
fi

# Everything before the final runtime-agent exec, then hold the container.
hold='set -euo pipefail
entrypoint=/usr/local/bin/runtime-entrypoint
if [ "$(sed -n "\$p" "$entrypoint")" != "exec /usr/local/bin/runtime-agent" ]; then
  echo "[browser-smoke] the entrypoint no longer ends with exec /usr/local/bin/runtime-agent" >&2
  exit 90
fi
sed "\$d" "$entrypoint" > /tmp/browser-smoke-entrypoint.sh
echo "touch /tmp/browser-smoke-booted" >> /tmp/browser-smoke-entrypoint.sh
echo "exec sleep infinity" >> /tmp/browser-smoke-entrypoint.sh
exec bash /tmp/browser-smoke-entrypoint.sh'

if [[ "$mode" == "lazy" ]]; then
  # Boot with the browser off. The entrypoint must start no browser process;
  # the host runs only when called.
  docker run -d --name "$name" ${mount[@]+"${mount[@]}"} --entrypoint bash \
    -e RUNTIME_ID=00000000-0000-4000-8000-00000000b5e2 \
    -e ORIGIN_MODE=hosted \
    "$image" -c "$hold" >/dev/null

  # The runtime agent's own root and ports (runtime-agent browser_host).
  host_root=/var/lib/instafy/browser-host
  profile_dir="$host_root/profile"
  state_dir="$host_root/state"
  host_cdp_port=19223
  host_node=/opt/instafy/browser-host/bin/node
  # What the agent passes: an explicit allowlist with the host's own display,
  # ports and persisted profile directory, egress isolation on and WebRTC off.
  host_env=(
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    INSTAFY_BROWSER_HOST_HOME="$host_root/home"
    INSTAFY_BROWSER_HOST_PROFILE_DIR="$profile_dir"
    INSTAFY_BROWSER_HOST_STATE_DIR="$state_dir"
    INSTAFY_BROWSER_HOST_DISPLAY=:47
    INSTAFY_BROWSER_HOST_CDP_PORT="$host_cdp_port"
    INSTAFY_BROWSER_HOST_VNC_PORT=15900
    INSTAFY_BROWSER_HOST_EGRESS_PORT=19226
    INSTAFY_BROWSER_EGRESS_ISOLATION=1
    INSTAFY_BROWSER_WEBRTC_ENABLED=0
    INSTAFY_BROWSER_VIEWPORT_ONLY=1
    INSTAFY_VNC_GEOMETRY=1280x720
    INSTAFY_BROWSER_RENDER_SCALE=1
  )
  # The agent's CDP close helper, byte for byte (runtime-agent
  # browser_host/persistence.rs CLOSE_SCRIPT); it runs with only PATH set.
  close_script="$(cat <<'CLOSE'
const {chromium}=require('/opt/instafy/browser-host/node_modules/playwright');chromium.connectOverCDP(process.argv[1]).then(async b=>{const s=await b.newBrowserCDPSession();try{await s.send('Browser.close')}catch(e){}process.exit(0)}).catch(()=>process.exit(1));
CLOSE
)"
  # Sets (set) or requires (get) a persistent cookie and one with no expiry
  # over CDP, with the host's own Node.
  cookie_probe='
const [mode, port] = process.argv.slice(1);
const names = ["instafy_smoke_persistent", "instafy_smoke_session"];
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = message.id ? this.pending.get(message.id) : null;
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    };
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}
(async () => {
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = await new Cdp(version.webSocketDebuggerUrl).open();
  if (mode === "set") {
    await browser.send("Storage.setCookies", { cookies: [
      { name: names[0], value: "kept", domain: "instafy-smoke.example", path: "/", expires: Math.floor(Date.now() / 1000) + 86400 },
      { name: names[1], value: "kept", domain: "instafy-smoke.example", path: "/" },
    ] });
  }
  const { cookies } = await browser.send("Storage.getCookies", {});
  const missing = names.filter((name) => !cookies.some((cookie) => cookie.name === name && cookie.value === "kept"));
  if (missing.length > 0) throw new Error(`missing cookies: ${missing.join(", ")}`);
  const session = cookies.find((cookie) => cookie.name === names[1]);
  if (!session.session) throw new Error("the cookie without an expiry is not a session cookie");
  console.log(mode === "set" ? "Set a persistent cookie and one with no expiry." : "Both cookies survived a clean close and the next start.");
})().then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); });
'
  # What runtime-agent packs and a later machine restores (browser_profile.rs
  # PROFILE_FILE_ALLOWLIST and PROFILE_DIRECTORY_ALLOWLIST).
  packed_paths=("Local State" "Default/Cookies" "Default/Network/Cookies" "Default/Local Storage" "Default/IndexedDB" "Default/Session Storage")
  # The profile keeps blocking downloads and continues the last session.
  preferences_probe='
const preferences = JSON.parse(require("fs").readFileSync(`${process.argv[1]}/Default/Preferences`, "utf8"));
if (preferences.download_restrictions !== 3) throw new Error("the profile does not block downloads");
if (!preferences.session || preferences.session.restore_on_startup !== 1) throw new Error("the profile does not continue the last session");
'
  # Live browser processes as "pid nice state command". The held container's
  # PID 1 never reaps orphans, so exited processes (state Z) are left out.
  browser_processes='ps -eo pid=,ni=,stat=,comm= | awk '"'"'$3 !~ /^Z/ && $4 ~ /^(Xtigervnc|Xvnc|fluxbox|fbsetbg|xmessage|chrom|ffmpeg|browser-)/'"'"''

  lazy_report() {
    echo "::group::Browser host output"
    docker exec "$name" sh -c '
      cat /tmp/browser-smoke-host.out 2>/dev/null
      tail -n 40 /tmp/browser-smoke-host.err 2>/dev/null' || true
    echo "::endgroup::"
    echo "::group::Browser host logs"
    docker exec "$name" sh -c "
      for log in $state_dir/*.log; do echo \"== \$log\"; tail -n 30 \"\$log\"; done" 2>/dev/null || true
    echo "::endgroup::"
  }

  lazy_fail() {
    lazy_report
    echo "::error::$1"
    exit 1
  }

  await_booted() {
    local container="$1" deadline=$((SECONDS + timeout_seconds))
    until docker exec "$container" test -f /tmp/browser-smoke-booted 2>/dev/null; do
      if [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]]; then
        docker logs "$container" 2>&1 | tail -n 40 || true
        echo "::error::The runtime container exited before it finished booting."
        exit 1
      fi
      if (( SECONDS >= deadline )); then
        echo "::error::The runtime container did not finish booting within ${timeout_seconds}s."
        exit 1
      fi
      sleep 1
    done
  }

  await_booted "$name"
  at_boot="$(docker exec "$name" sh -c "$browser_processes")"
  if [[ -n "$at_boot" ]]; then
    lazy_fail "The image started browser processes at boot: ${at_boot//$'\n'/; }"
  fi

  # The base image carries the browser stack only for the on-demand host.
  # Booted with the browser session on, it must still start no display or
  # browser (only the egress proxy, as before the stack was added).
  if [[ "$(docker exec "$name" printenv INSTAFY_RUNTIME_FLAVOR 2>/dev/null || true)" == "base" ]]; then
    docker run -d --name "${name}-session" ${mount[@]+"${mount[@]}"} --entrypoint bash \
      -e RUNTIME_ID=00000000-0000-4000-8000-00000000b5e3 \
      -e ORIGIN_MODE=hosted \
      -e INSTAFY_ENABLE_BROWSER_SESSION=1 \
      "$image" -c "$hold" >/dev/null
    await_booted "${name}-session"
    with_session="$(docker exec "${name}-session" sh -c "$browser_processes" | awk '$4 !~ /^browser-egress/')"
    docker rm -f "${name}-session" >/dev/null 2>&1 || true
    if [[ -n "$with_session" ]]; then
      lazy_fail "The base image started a browser at boot with INSTAFY_ENABLE_BROWSER_SESSION=1: ${with_session//$'\n'/; }"
    fi
    echo "The base image booted with the browser session on and started no display or browser."
  fi

  # A profile saved by an earlier session: its data must survive every start
  # and stop.
  docker exec "$name" sh -c "mkdir -p '$profile_dir' && echo kept > '$profile_dir/instafy-smoke-marker'"

  start_host() {
    docker exec -d "$name" bash -c '
      echo $$ > /tmp/browser-smoke-host.pid
      exec env -i "$@" bash /usr/local/bin/runtime-entrypoint start-browser-host \
        >/tmp/browser-smoke-host.out 2>/tmp/browser-smoke-host.err' bash "${host_env[@]}"
  }

  host_status() {
    # $1: the status to wait for (ready or stopped); prints the status line.
    local deadline=$((SECONDS + timeout_seconds)) line
    while (( SECONDS < deadline )); do
      line="$(docker exec "$name" sh -c "grep '^instafy-browser-host: ' /tmp/browser-smoke-host.out 2>/dev/null | tail -n 1" || true)"
      case "$line" in
        "instafy-browser-host: $1"*) printf '%s' "$line"; return 0 ;;
        "instafy-browser-host: failed"* | "instafy-browser-host: exited"*) printf '%s' "$line"; return 1 ;;
      esac
      if [[ -z "$line" ]] && ! docker exec "$name" sh -c 'kill -0 "$(cat /tmp/browser-smoke-host.pid)"' 2>/dev/null; then
        printf '%s' "the host exited without a status line"
        return 1
      fi
      sleep 1
    done
    printf '%s' "${line:-no status line}"
    return 1
  }

  prove_running_host() {
    local label="$1" status
    status="$(host_status ready)" || lazy_fail "The ${label} browser host did not start: ${status}"
    echo "${label^} browser host: ${status}"
    case " $status " in
      *" cdp=${host_cdp_port} "*) ;;
      *) lazy_fail "The ${label} browser host reported the wrong CDP port: ${status}" ;;
    esac
    case " $status " in
      *" webrtc=off "*) ;;
      *) lazy_fail "The ${label} browser host did not keep WebRTC off: ${status}" ;;
    esac
    local version
    version="$(docker exec "$name" curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:${host_cdp_port}/json/version")" \
      || lazy_fail "The ${label} browser host reported ready but Chromium does not answer on CDP port ${host_cdp_port}."
    [[ "$version" == *'"Browser"'* ]] || lazy_fail "CDP port ${host_cdp_port} did not answer like Chromium."
    if docker exec "$name" curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:${cdp_port}/json/version" >/dev/null 2>&1; then
      lazy_fail "Something answers on the boot-time CDP port ${cdp_port}; the host must use only its own ports."
    fi
    # Every browser process runs at nice 10 or lower priority, and the host at
    # OOM score 1000.
    local niceness
    niceness="$(docker exec "$name" sh -c "$browser_processes" | awk '$2 < 10 { print $4 "=" $2 }')"
    [[ -z "$niceness" ]] || lazy_fail "Browser processes run above nice 10: ${niceness//$'\n'/ }"
    local oom
    oom="$(docker exec "$name" sh -c 'cat "/proc/$(cat /tmp/browser-smoke-host.pid)/oom_score_adj"')"
    [[ "$oom" == "1000" ]] || lazy_fail "The browser host's OOM score is ${oom}, not 1000."
    docker exec "$name" test -f "$profile_dir/instafy-smoke-marker" \
      || lazy_fail "The ${label} browser host removed data from the persisted profile."
    docker exec "$name" env -i "$host_node" -e "$preferences_probe" "$profile_dir" \
      || lazy_fail "The ${label} browser host started Chromium on a profile without its preferences."
  }

  # The agent's stop: Browser.close over CDP, then the host reports that
  # Chromium exited and stops its group. Only then is the profile saved.
  close_host() {
    local label="$1" status remaining
    docker exec "$name" env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
      "$host_node" -e "$close_script" "http://127.0.0.1:${host_cdp_port}" \
      || lazy_fail "The agent's close helper could not close the ${label} browser over CDP."
    status="$(host_status "exited chromium")" \
      || lazy_fail "The ${label} browser host did not report Chromium's exit after the close: ${status}"
    remaining="$(docker exec "$name" sh -c "$browser_processes")"
    [[ -z "$remaining" ]] || lazy_fail "Browser processes outlived the closed ${label} host: ${remaining//$'\n'/; }"
    docker exec "$name" env -i "$host_node" -e "$preferences_probe" "$profile_dir" \
      || lazy_fail "The closed ${label} browser left a profile without its preferences."
  }

  stop_host() {
    local label="$1" status remaining
    docker exec "$name" sh -c 'kill -TERM "$(cat /tmp/browser-smoke-host.pid)"'
    status="$(host_status stopped)" || lazy_fail "The ${label} browser host did not stop cleanly: ${status}"
    remaining="$(docker exec "$name" sh -c "$browser_processes")"
    [[ -z "$remaining" ]] || lazy_fail "Browser processes outlived the ${label} host: ${remaining//$'\n'/; }"
    docker exec "$name" test -f "$profile_dir/instafy-smoke-marker" \
      || lazy_fail "Stopping the ${label} browser host removed data from the persisted profile."
  }

  start_host
  prove_running_host first
  profile_deadline=$((SECONDS + 30))
  until docker exec "$name" test -d "$profile_dir/Default"; do
    (( SECONDS < profile_deadline )) \
      || lazy_fail "Chromium did not use the persisted profile directory ${profile_dir}."
    sleep 1
  done
  docker exec "$name" env -i "$host_node" -e "$cookie_probe" set "$host_cdp_port" \
    || lazy_fail "Could not set the probe cookies in the first browser host."
  close_host first

  # The next start reuses the same profile, including its sign-ins: Chromium
  # keeps the cookie without an expiry because it continues its last session.
  start_host
  prove_running_host second
  docker exec "$name" env -i "$host_node" -e "$cookie_probe" get "$host_cdp_port" \
    || lazy_fail "The second browser host lost a sign-in cookie across a clean close."
  close_host second

  # A later machine gets only the packed files, with no Preferences or
  # Sessions: the host writes its preferences again, and Chromium must still
  # load both cookies. The smoke's marker is kept for the checks above.
  docker exec "$name" bash -c '
    set -e
    profile="$1"
    shift
    packed="${profile}.packed"
    rm -rf "$packed"
    mkdir -m 0700 "$packed"
    for path in "$@" instafy-smoke-marker; do
      if [ -e "$profile/$path" ]; then
        mkdir -p "$packed/$(dirname "$path")"
        cp -a "$profile/$path" "$packed/$path"
      fi
    done
    rm -rf "$profile"
    mv "$packed" "$profile"' bash "$profile_dir" "${packed_paths[@]}" \
    || lazy_fail "Could not reduce the profile to the files the agent packs."
  start_host
  prove_running_host third
  docker exec "$name" env -i "$host_node" -e "$cookie_probe" get "$host_cdp_port" \
    || lazy_fail "The third browser host lost a sign-in cookie restored from the packed files."
  # A SIGTERM-only stop is not relied on to keep sign-ins: it does not flush
  # Chromium's cookie store, so the agent never saves a profile after one.
  stop_host third

  echo "Browser host started on demand three times, kept both sign-in cookies across a clean close on the same profile and from the packed files alone, and left no process behind."
  exit 0
fi

docker run -d --name "$name" ${mount[@]+"${mount[@]}"} --entrypoint bash \
  -e RUNTIME_ID=00000000-0000-4000-8000-00000000b5e1 \
  -e ORIGIN_MODE=hosted \
  -e INSTAFY_ENABLE_BROWSER_SESSION=1 \
  -e INSTAFY_VNC_PORT=5900 \
  -e INSTAFY_VNC_GEOMETRY=1280x720 \
  -e INSTAFY_BROWSER_VIEWPORT_ONLY=1 \
  -e INSTAFY_BROWSER_DISPLAY=:1 \
  "$image" -c "$hold" >/dev/null

report() {
  echo "::group::Runtime entrypoint messages"
  docker logs "$name" 2>&1 | grep -F -e "[instafy]" -e "[browser-smoke]" | tail -n 40 || true
  echo "::endgroup::"
  echo "::group::Chromium warning and log tail"
  docker exec "$name" sh -c '
    cat /tmp/instafy/playwright/chromium-warning.txt 2>/dev/null
    tail -n 40 /tmp/instafy/playwright/chromium.log 2>/dev/null' || true
  echo "::endgroup::"
}

# Runs inside the container with the image's Node. A control first proves a
# click on the probe link downloads when a CDP session allows it; then, after a
# controller-style session denied downloads and disconnected, the same click
# must not write a file anywhere.
download_probe='
const fs = require("fs");
const { execFileSync } = require("child_process");
const port = process.argv[1];
const profile = process.argv[2];
const controlDirectory = "/tmp/instafy-download-probe";
const name = "instafy-smoke-download";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => { this.socket.onopen = resolve; this.socket.onerror = reject; });
    this.socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = message.id ? this.pending.get(message.id) : null;
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    };
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async close() { this.socket.close(); await delay(500); }
}
const copies = () => execFileSync("find", ["/root", "/tmp", "/home", "-xdev", "-name", `${name}*`, "-not", "-path", `${controlDirectory}/*`], { encoding: "utf8" }).trim();
(async () => {
  const preferences = JSON.parse(fs.readFileSync(`${profile}/Default/Preferences`, "utf8"));
  if (preferences.download_restrictions !== 3) throw new Error("the profile does not block downloads");
  const base = `http://127.0.0.1:${port}`;
  const version = await (await fetch(`${base}/json/version`)).json();
  const page = (await (await fetch(`${base}/json/list`)).json()).find((target) => target.type === "page");
  if (!page) throw new Error("no page target");
  const viewer = await new Cdp(page.webSocketDebuggerUrl).open();
  const link = `<a href="data:text/csv,inert" download="${name}.csv" style="position:fixed;left:20px;top:20px;width:300px;height:80px;display:block">Export</a>`;
  const click = async () => {
    await viewer.send("Page.navigate", { url: `data:text/html,${encodeURIComponent(link)}` });
    await delay(1500);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await viewer.send("Input.dispatchMouseEvent", { type, x: 120, y: 60, button: "left", clickCount: 1 });
    }
    await delay(3000);
  };
  const control = await new Cdp(version.webSocketDebuggerUrl).open();
  await control.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: controlDirectory });
  await click();
  await control.close();
  if (!fs.existsSync(controlDirectory) || fs.readdirSync(controlDirectory).length === 0) {
    throw new Error("the control click did not download, so the probe cannot tell");
  }
  const controller = await new Cdp(version.webSocketDebuggerUrl).open();
  await controller.send("Browser.setDownloadBehavior", { behavior: "deny" });
  await controller.close();
  await click();
  const found = copies();
  if (found) throw new Error(`a download landed after the controller disconnected: ${found}`);
  await viewer.close();
  console.log("Downloads stay blocked after a controller reconnect and a viewer click.");
})().then(() => process.exit(0), (error) => { console.error(error.message); process.exit(1); });
'

deadline=$((SECONDS + timeout_seconds))
while (( SECONDS < deadline )); do
  if [[ "$(docker inspect -f '{{.State.Running}}' "$name" 2>/dev/null)" != "true" ]]; then
    report
    echo "::error::The runtime container exited before the Shared Browser started."
    exit 1
  fi
  if version="$(docker exec "$name" curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:${cdp_port}/json/version" 2>/dev/null)"; then
    browser="$(printf '%s' "$version" | sed -n 's/.*"Browser"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
    echo "Shared Browser started: ${browser:-Chromium} answers on CDP port ${cdp_port}."
    if ! docker exec "$name" /usr/bin/node -e "$download_probe" "$cdp_port" /tmp/instafy/playwright/profile; then
      report
      echo "::error::The Shared Browser profile does not block downloads after a controller reconnect."
      exit 1
    fi
    exit 0
  fi
  sleep 2
done

report
echo "::error::Headed Chromium did not answer on CDP port ${cdp_port} within ${timeout_seconds}s."
exit 1
