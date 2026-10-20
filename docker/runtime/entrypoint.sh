#!/usr/bin/env bash
set -euo pipefail

export WORKSPACE_DIR="${WORKSPACE_DIR:-/workspace}"
export CODEX_HOME="${CODEX_HOME:-${WORKSPACE_DIR}/.codex}"

mkdir -p "${WORKSPACE_DIR}" "${CODEX_HOME}"

# Playwright is installed globally in the runtime image. Node does not resolve global modules
# by default, so set NODE_PATH to avoid per-run `npm i playwright` loops.
# The bounded Shared Browser controller receives the package by this exact absolute path rather
# than resolving a bare module name from a tenant-controlled workspace.
unset INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH
unset INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT
# The on-demand browser host (`start-browser-host`) uses neither, so it skips
# the probe and does not add two Node start-ups to every start.
if [ "${1:-}" != "start-browser-host" ] && command -v npm >/dev/null 2>&1; then
  global_node_modules="$(npm root -g 2>/dev/null || true)"
  if [ -n "${global_node_modules}" ]; then
    if [ -n "${NODE_PATH:-}" ]; then
      export NODE_PATH="${NODE_PATH}:${global_node_modules}"
    else
      export NODE_PATH="${global_node_modules}"
    fi
    export INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT="${global_node_modules}"
    export INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH="${global_node_modules}/playwright"
  fi
fi

export INSTAFY_PLAYWRIGHT_PROFILE_DIR="${INSTAFY_PLAYWRIGHT_PROFILE_DIR:-/tmp/instafy/playwright/profile}"
export INSTAFY_PLAYWRIGHT_CDP_PORT="${INSTAFY_PLAYWRIGHT_CDP_PORT:-9223}"
export INSTAFY_BROWSER_EGRESS_ISOLATION="${INSTAFY_BROWSER_EGRESS_ISOLATION:-1}"
export INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV="${INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV:-0}"
export INSTAFY_BROWSER_EGRESS_PROXY_BIND="${INSTAFY_BROWSER_EGRESS_PROXY_BIND:-127.0.0.1:9226}"
export INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS="${INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS:-80,443}"
export INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS="${INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS:-128}"
# Append-only log of browser actions the agent emits (navigate/click/type/scroll),
# tailed by origin-http-server's /browser/actions so the UI can draw the AI cursor
# and an action ticker. Same fixed OS path convention as the profile/CDP resources.
export INSTAFY_BROWSER_ACTIONS_FILE="${INSTAFY_BROWSER_ACTIONS_FILE:-/tmp/instafy/playwright/actions.jsonl}"

# Long-lived browser helpers share the runtime's PID namespace with model tools.
# Give each helper a positive environment allowlist so arbitrary values from a
# provider or env_file (database URLs, cloud keys, model tokens, and service
# credentials) never become readable through /proc/<pid>/environ. Keep the
# feature-specific additions at each spawn site deliberately small.
readonly -a MODEL_SAFE_BASE_ENV_KEYS=(
  PATH HOME USER LOGNAME SHELL LANG LANGUAGE LC_ALL LC_CTYPE TZ
  TMPDIR TMP TEMP TERM COLORTERM SSL_CERT_FILE SSL_CERT_DIR
)
MODEL_SAFE_ENV=()

build_model_safe_env() {
  MODEL_SAFE_ENV=()
  local key
  for key in "$@"; do
    if declare -p "$key" >/dev/null 2>&1; then
      MODEL_SAFE_ENV+=("${key}=${!key}")
    fi
  done
}

chromium_pid_file() {
  printf '%s' "/tmp/instafy/playwright/chromium.pid"
}

chromium_log_file() {
  printf '%s' "/tmp/instafy/playwright/chromium.log"
}

chromium_warning_file() {
  printf '%s' "/tmp/instafy/playwright/chromium-warning.txt"
}

browser_egress_proxy_pid_file() {
  printf '%s' "/tmp/instafy/playwright/browser-egress-proxy.pid"
}

browser_egress_proxy_url() {
  printf 'http://%s' "${INSTAFY_BROWSER_EGRESS_PROXY_BIND}"
}

browser_egress_isolation_active() {
  [ "${INSTAFY_BROWSER_EGRESS_ISOLATION}" = "1" ]
}

browser_egress_proxy_healthy() {
  local health_url
  health_url="$(browser_egress_proxy_url)/healthz"
  curl --noproxy '*' -fsS --max-time 1 "${health_url}" 2>/dev/null \
    | grep -q '"policy":"public-http-only"'
}

ensure_browser_egress_proxy() {
  if ! browser_egress_isolation_active; then
    if [ "${INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV}" = "1" ]; then
      echo "[instafy] WARNING: Shared Browser egress isolation disabled by dev-only override" >&2
      return 0
    fi
    echo "[instafy] refusing to launch Shared Browser without egress isolation; set INSTAFY_BROWSER_EGRESS_ISOLATION=1" >&2
    return 1
  fi

  if ! command -v browser-egress-proxy >/dev/null 2>&1; then
    echo "[instafy] Shared Browser egress isolation enabled, but browser-egress-proxy is missing" >&2
    return 1
  fi

  mkdir -p /tmp/instafy/playwright
  local pid_file
  pid_file="$(browser_egress_proxy_pid_file)"
  if [ -f "${pid_file}" ] && kill -0 "$(cat "${pid_file}")" >/dev/null 2>&1; then
    if browser_egress_proxy_healthy; then
      return 0
    fi
    kill "$(cat "${pid_file}")" >/dev/null 2>&1 || true
  fi
  rm -f "${pid_file}"

  build_model_safe_env \
    "${MODEL_SAFE_BASE_ENV_KEYS[@]}" \
    INSTAFY_BROWSER_EGRESS_PROXY_BIND \
    INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS \
    INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS
  env -i "${MODEL_SAFE_ENV[@]}" browser-egress-proxy \
    >>/tmp/instafy/browser-egress-proxy.log 2>&1 &
  echo "$!" > "${pid_file}"
  for _ in $(seq 1 50); do
    if ! kill -0 "$(cat "${pid_file}")" >/dev/null 2>&1; then
      break
    fi
    if browser_egress_proxy_healthy; then
      echo "[instafy] Shared Browser egress isolation ready on ${INSTAFY_BROWSER_EGRESS_PROXY_BIND}" >&2
      return 0
    fi
    sleep 0.1
  done

  if [ -f "${pid_file}" ]; then
    kill "$(cat "${pid_file}")" >/dev/null 2>&1 || true
    rm -f "${pid_file}"
  fi
  echo "[instafy] Shared Browser egress proxy failed its readiness check" >&2
  return 1
}

browser_webrtc_pid_file() {
  printf '%s' "/tmp/instafy/playwright/browser-webrtc-sender.pid"
}

start_browser_webrtc_sender_daemon() {
  if [ "${INSTAFY_BROWSER_WEBRTC_ENABLED:-0}" != "1" ]; then
    return
  fi
  if ! command -v browser-webrtc-sender >/dev/null 2>&1; then
    echo "[instafy] WebRTC browser transport enabled, but browser-webrtc-sender is missing" >&2
    return
  fi
  if ! command -v ffmpeg >/dev/null 2>&1; then
    echo "[instafy] WebRTC browser transport enabled, but ffmpeg is missing" >&2
    return
  fi

  local pid_file
  pid_file="$(browser_webrtc_pid_file)"
  if [ -f "${pid_file}" ] && kill -0 "$(cat "${pid_file}")" >/dev/null 2>&1; then
    return
  fi
  rm -f "${pid_file}"

  export INSTAFY_BROWSER_WEBRTC_GEOMETRY="${INSTAFY_BROWSER_WEBRTC_GEOMETRY:-$(scaled_browser_geometry)}"
  build_model_safe_env \
    "${MODEL_SAFE_BASE_ENV_KEYS[@]}" \
    DISPLAY \
    INSTAFY_BROWSER_WEBRTC_BIND \
    INSTAFY_BROWSER_WEBRTC_GEOMETRY \
    INSTAFY_BROWSER_WEBRTC_FPS \
    INSTAFY_BROWSER_WEBRTC_BITRATE_KBPS \
    INSTAFY_BROWSER_WEBRTC_FFMPEG \
    INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON \
    INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN \
    INSTAFY_VNC_GEOMETRY
  # Do not retain a dumpable bash restart loop around TURN credentials. The
  # sender hardens itself before parsing this minimal environment; a failed
  # sender stays down until the runtime is restarted.
  env -i "${MODEL_SAFE_ENV[@]}" browser-webrtc-sender \
    >>/tmp/instafy/browser-webrtc-sender.log 2>&1 &
  echo "$!" > "${pid_file}"
  echo "[instafy] Shared Browser WebRTC sender enabled" >&2
}

resolve_chromium_executable_path() {
  # Playwright's Chromium builds unpack to chrome-linux64/ (the Chrome for
  # Testing layout, as in the pinned Playwright 1.61 webdev base) or, in older
  # builds, chrome-linux/. The Playwright base image sets PLAYWRIGHT_BROWSERS_PATH.
  local browsers_path="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
  if [ "${browsers_path}" = "0" ]; then
    browsers_path=/ms-playwright
  fi
  for candidate in \
    "${browsers_path}"/chromium-*/chrome-linux64/chrome \
    "${browsers_path}"/chromium-*/chrome-linux/chrome \
    /root/.cache/ms-playwright/chromium-*/chrome-linux64/chrome \
    /root/.cache/ms-playwright/chromium-*/chrome-linux/chrome \
    /usr/bin/chromium \
    /usr/bin/chromium-browser \
    /usr/bin/google-chrome \
    /usr/bin/google-chrome-stable
  do
    if [ -x "${candidate}" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  printf '%s' ""
}

cleanup_chromium_profile_locks() {
  local profile_dir="${INSTAFY_PLAYWRIGHT_PROFILE_DIR}"
  rm -f "${profile_dir}/SingletonLock" \
    "${profile_dir}/SingletonSocket" \
    "${profile_dir}/SingletonCookie"
}

chromium_cdp_ready_timeout_secs() {
  # How long a launched Chromium may take to answer on its CDP port. The first
  # headed launch on a cold machine is the slow one: on hosted CI it took 3.8 s
  # at the median, 9.7 s at p99 and up to 11.3 s, which a fixed 60-poll budget
  # (about 12.4 s) cut off. 30 s is about 2.7x the slowest healthy start, and it
  # keeps the persisted-profile relaunch, which runs after registration and
  # before the first heartbeat, inside the controller's 60 s heartbeat window
  # for queued-job recovery. Overrides are whole seconds clamped to 1..300; 300 s
  # is the controller's stalled-launch window, so a longer wait cannot help.
  awk -v raw="${INSTAFY_CHROMIUM_CDP_READY_TIMEOUT_SECS:-30}" 'BEGIN {
    if (raw !~ /^[0-9]+$/) raw = 30;
    if (raw < 1) raw = 1;
    if (raw > 300) raw = 300;
    printf "%d", raw;
  }'
}

chromium_ready_clock_ms() {
  # bash 5 exposes microseconds in EPOCHREALTIME; older shells fall back to
  # whole SECONDS, so their readiness times are only accurate to a second.
  local now="${EPOCHREALTIME:-}"
  now="${now//[!0-9]/}"
  if [ -n "${now}" ]; then
    printf '%s' "$(( 10#${now} / 1000 ))"
  else
    printf '%s' "$(( SECONDS * 1000 ))"
  fi
}

check_chromium_cdp_ready() {
  # Poll until the Chromium launched as PID $1 answers on CDP (0), that process
  # exits (2), or more than $2 seconds have passed while it still runs (1).
  local pid="$1"
  local timeout_secs="$2"
  local endpoint="http://127.0.0.1:${INSTAFY_PLAYWRIGHT_CDP_PORT}/json/version"
  local now_ms deadline_ms version
  now_ms="$(chromium_ready_clock_ms)"
  deadline_ms=$(( now_ms + timeout_secs * 1000 ))
  while :; do
    # A refused connection is the normal state while Chromium starts, so the
    # probe stays quiet. --max-time bounds a connection that is accepted but
    # never answered, and the loopback endpoint never goes through a proxy.
    version="$(curl --noproxy '*' -fsS --max-time 1 "${endpoint}" 2>/dev/null)" || version=""
    if [[ "${version}" == *'"Browser"'* ]]; then
      return 0
    fi
    if ! kill -0 "${pid}" 2>/dev/null; then
      return 2
    fi
    now_ms="$(chromium_ready_clock_ms)"
    if [ "${now_ms}" -gt "${deadline_ms}" ]; then
      return 1
    fi
    sleep 0.2
  done
}

await_chromium_cdp_ready() {
  # Wait for the Chromium launched as PID $1 and record the outcome. The
  # launch-chromium subcommand runs this under `set -e`, so no line here may
  # return non-zero: no bare `wait`, and no `(( ))` that can evaluate to 0.
  # Messages are fixed text; Chromium's own output stays in its log file.
  local chromium_pid="$1"
  local timeout_secs started_ms finished_ms elapsed_ms elapsed ready_rc=0
  timeout_secs="$(chromium_cdp_ready_timeout_secs)"
  started_ms="$(chromium_ready_clock_ms)"
  check_chromium_cdp_ready "${chromium_pid}" "${timeout_secs}" || ready_rc=$?
  finished_ms="$(chromium_ready_clock_ms)"
  elapsed_ms=$(( finished_ms - started_ms ))
  if [ "${elapsed_ms}" -lt 0 ]; then
    elapsed_ms=0
  fi
  elapsed="$(printf '%d.%02d' "$(( elapsed_ms / 1000 ))" "$(( elapsed_ms % 1000 / 10 ))")"

  if [ "${ready_rc}" = "0" ]; then
    echo "[instafy] Headed Chromium ready (CDP) on 127.0.0.1:${INSTAFY_PLAYWRIGHT_CDP_PORT} after ${elapsed}s" >&2
    return 0
  fi

  local warning_text
  if [ "${ready_rc}" = "2" ]; then
    local exit_status=0
    wait "${chromium_pid}" 2>/dev/null || exit_status=$?
    warning_text="Headed Chromium did not become ready on CDP port ${INSTAFY_PLAYWRIGHT_CDP_PORT} (Chromium exited with status ${exit_status} after ${elapsed}s). Check $(chromium_log_file) and restart runtime."
  else
    kill "${chromium_pid}" >/dev/null 2>&1 || true
    warning_text="Headed Chromium did not become ready on CDP port ${INSTAFY_PLAYWRIGHT_CDP_PORT} within ${timeout_secs}s; Chromium was still running and was stopped. Check $(chromium_log_file) and restart runtime."
  fi
  rm -f "$(chromium_pid_file)"
  printf '%s\n' "${warning_text}" > "$(chromium_warning_file)"
  echo "[instafy] ${warning_text}" >&2
}

browser_render_scale() {
  # Chromium and the RFB client must use one fixed device scale for the whole
  # runtime. Keep the accepted range deliberately small: it bounds encoder/X11
  # work while still covering ordinary and Retina-class displays.
  awk -v raw="${INSTAFY_BROWSER_RENDER_SCALE:-1}" 'BEGIN {
    if (raw !~ /^[0-9]+([.][0-9]+)?$/) raw = 1;
    if (raw < 1) raw = 1;
    if (raw > 2) raw = 2;
    printf "%.2f", raw;
  }'
}

browser_max_framebuffer_pixels() {
  awk -v raw="${INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS:-8294400}" 'BEGIN {
    if (raw !~ /^[0-9]+$/) raw = 8294400;
    if (raw < 921600) raw = 921600;
    if (raw > 16777216) raw = 16777216;
    printf "%d", raw;
  }'
}

scaled_browser_geometry() {
  local logical_geometry="${INSTAFY_VNC_GEOMETRY:-1280x720}"
  local logical_width="${logical_geometry%x*}"
  local logical_height="${logical_geometry#*x}"
  local scale
  scale="$(browser_render_scale)"
  local pixel_budget
  pixel_budget="$(browser_max_framebuffer_pixels)"
  if [[ ! "${logical_width}" =~ ^[0-9]+$ ]] || [[ ! "${logical_height}" =~ ^[0-9]+$ ]]; then
    logical_width=1280
    logical_height=720
  fi
  awk -v width="${logical_width}" -v height="${logical_height}" -v scale="${scale}" -v budget="${pixel_budget}" 'BEGIN {
    physical_width = int(width * scale + 0.5);
    physical_height = int(height * scale + 0.5);
    pixels = physical_width * physical_height;
    if (pixels > budget) {
      cap_scale = sqrt(budget / pixels);
      physical_width = int(physical_width * cap_scale);
      physical_height = int(physical_height * cap_scale);
    }
    if (physical_width < 1) physical_width = 1;
    if (physical_height < 1) physical_height = 1;
    printf "%dx%d", physical_width, physical_height;
  }'
}

browser_display_dpi() {
  local scale
  scale="$(browser_render_scale)"
  awk -v scale="${scale}" 'BEGIN { printf "%d", int(96 * scale + 0.5); }'
}

# Blocks every download in the Shared Browser profile before Chromium starts.
# This is the profile preference behind Chromium's DownloadRestrictions policy
# (3 blocks all downloads). The Shared Browser controller also denies downloads
# over CDP, but that override ends when its connection closes, and viewers
# drive the page between agent steps. The profile preference holds across
# reconnects, viewer input and a restored profile. The hosted browser has no
# copy-out, so a download would only land where an ordinary turn could read it.
# Chromium must not be running while this writes.
block_browser_downloads() {
  local profile_dir="$1"
  local node_binary=/usr/bin/node
  if [ ! -x "${node_binary}" ]; then
    node_binary="$(command -v node 2>/dev/null || true)"
  fi
  if [ -z "${node_binary}" ] || [ -z "${profile_dir}" ]; then
    return 1
  fi
  "${node_binary}" -e '
    const fs = require("fs");
    const path = require("path");
    const directory = path.join(process.argv[1], "Default");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "Preferences");
    let preferences = {};
    try {
      preferences = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      // Missing or unreadable preferences start empty; Chromium resets a corrupt file too.
      preferences = {};
    }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
      preferences = {};
    }
    preferences.download_restrictions = 3;
    const temporary = `${file}.instafy-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(preferences), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  ' "${profile_dir}"
}

# Makes Chromium continue the last session at its next start in the on-demand
# browser host's profile (session.restore_on_startup 1). Chromium then keeps
# cookies that have no expiry across a clean close (Browser.close), so a
# sign-in that uses one survives the host's idle stop. Preferences are never
# packed into the durable profile, so this is written on every start and
# tabs reopen only within one container. Chromium must not be running while
# this writes.
keep_browser_session_on_restart() {
  local profile_dir="$1"
  local node_binary=/usr/bin/node
  if [ ! -x "${node_binary}" ]; then
    node_binary="$(command -v node 2>/dev/null || true)"
  fi
  if [ -z "${node_binary}" ] || [ -z "${profile_dir}" ]; then
    return 1
  fi
  "${node_binary}" -e '
    const fs = require("fs");
    const path = require("path");
    const directory = path.join(process.argv[1], "Default");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, "Preferences");
    let preferences = {};
    try {
      preferences = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      preferences = {};
    }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) {
      preferences = {};
    }
    if (!preferences.session || typeof preferences.session !== "object" || Array.isArray(preferences.session)) {
      preferences.session = {};
    }
    preferences.session.restore_on_startup = 1;
    const temporary = `${file}.instafy-${process.pid}`;
    fs.writeFileSync(temporary, JSON.stringify(preferences), { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  ' "${profile_dir}"
}

# Chromium's command line for the Shared Browser, shared by the boot-time
# launch and the on-demand browser host. It reads the profile directory, CDP
# port, egress proxy address, render scale and view settings from the
# environment and leaves the flags in CHROMIUM_LAUNCH_FLAGS.
CHROMIUM_LAUNCH_FLAGS=()

build_chromium_launch_flags() {
  local window_flags=()
  local render_scale
  render_scale="$(browser_render_scale)"
  local vnc_geometry
  vnc_geometry="$(scaled_browser_geometry)"
  local vnc_width="${vnc_geometry%x*}"
  local vnc_height="${vnc_geometry#*x}"
  if [[ "${vnc_width}" =~ ^[0-9]+$ ]] && [[ "${vnc_height}" =~ ^[0-9]+$ ]]; then
    # Without a WM (or with a minimal one) Chromium can open at a smaller default size,
    # leaving black desktop padding in the VNC stream. Make it match the VNC canvas.
    window_flags+=(--window-position=0,0 --window-size="${vnc_width},${vnc_height}" --start-maximized)
  fi

  local viewport_flags=()
  if [ "${INSTAFY_BROWSER_VIEWPORT_ONLY:-0}" = "1" ]; then
    # Studio owns the address/history controls in viewport-only mode. Kiosk
    # removes Chromium's duplicate tab/address chrome from the VNC surface so
    # only page pixels are streamed. Keep this opt-in so existing runtimes use
    # the proven headed-window launch unchanged.
    viewport_flags+=(
      --kiosk
      --start-fullscreen
      --noerrdialogs
      --disable-session-crashed-bubble
      --disable-pinch
      --overscroll-history-navigation=0
    )
  fi

  local egress_flags=()
  if browser_egress_isolation_active; then
    egress_flags+=(
      --proxy-server="$(browser_egress_proxy_url)"
      '--proxy-bypass-list=<-loopback>'
      --disable-quic
      --force-webrtc-ip-handling-policy=disable_non_proxied_udp
    )
  fi

  local extension_flags=()
  if [ "${INSTAFY_BROWSER_ADBLOCK:-1}" = "1" ]; then
    local ublock_root="/opt/instafy/extensions/ublock"
    local ublock_dir=""

    if [ -f "${ublock_root}/manifest.json" ]; then
      ublock_dir="${ublock_root}"
    elif [ -d "${ublock_root}" ]; then
      # Zip releases often unzip into a single subfolder (e.g. uBlock0.chromium/manifest.json).
      # Chromium needs the directory containing manifest.json.
      local manifest_path=""
      manifest_path="$(find "${ublock_root}" -maxdepth 2 -type f -name manifest.json -print -quit 2>/dev/null || true)"
      if [ -n "${manifest_path}" ]; then
        ublock_dir="$(dirname "${manifest_path}")"
      fi
    fi

    if [ -n "${ublock_dir}" ] && [ -d "${ublock_dir}" ]; then
      extension_flags+=(--disable-extensions-except="${ublock_dir}" --load-extension="${ublock_dir}")
    fi
  fi

  CHROMIUM_LAUNCH_FLAGS=(
    --no-first-run
    --no-default-browser-check
    --disable-component-update
    --disable-infobars
    --disable-features=TranslateUI
    --high-dpi-support=1
    --force-device-scale-factor="${render_scale}"
    --disable-dev-shm-usage
    --remote-debugging-address=127.0.0.1
    --remote-debugging-port="${INSTAFY_PLAYWRIGHT_CDP_PORT}"
    --user-data-dir="${INSTAFY_PLAYWRIGHT_PROFILE_DIR}"
    --no-sandbox
    "${egress_flags[@]}"
    "${extension_flags[@]}"
    "${window_flags[@]}"
    "${viewport_flags[@]}"
  )
}

start_headed_chromium_daemon() {
  if [ "${INSTAFY_ENABLE_BROWSER_SESSION:-0}" != "1" ]; then
    return
  fi

  if ! ensure_browser_egress_proxy; then
    local warning_text
    warning_text="Shared Browser egress isolation is unavailable; Chromium was not launched."
    printf '%s\n' "${warning_text}" > "$(chromium_warning_file)"
    echo "[instafy] ${warning_text}" >&2
    return 1
  fi

  mkdir -p /tmp/instafy/playwright "${INSTAFY_PLAYWRIGHT_PROFILE_DIR}"
  rm -f "$(chromium_warning_file)"
  # Start each browser session with a clean action log so the UI never replays
  # a prior session's cursor/ticker events.
  : > "${INSTAFY_BROWSER_ACTIONS_FILE}" 2>/dev/null || true

  build_chromium_launch_flags

  local pid_file
  pid_file="$(chromium_pid_file)"
  if [ -f "${pid_file}" ]; then
    if kill -0 "$(cat "${pid_file}")" >/dev/null 2>&1; then
      return
    fi
    rm -f "${pid_file}"
  fi

  local chrome_path
  chrome_path="$(resolve_chromium_executable_path)"
  if [ -z "${chrome_path}" ]; then
    local warning_text
    warning_text="Browser session enabled, but no Chromium executable found on PATH. Use the runtime-webdev image target."
    printf '%s\n' "${warning_text}" > "$(chromium_warning_file)"
    echo "[instafy] ${warning_text}" >&2
    return
  fi

  if ! block_browser_downloads "${INSTAFY_PLAYWRIGHT_PROFILE_DIR}"; then
    local warning_text
    warning_text="Shared Browser downloads could not be blocked; Chromium was not launched."
    printf '%s\n' "${warning_text}" > "$(chromium_warning_file)"
    echo "[instafy] ${warning_text}" >&2
    return 1
  fi

  cleanup_chromium_profile_locks

  build_model_safe_env \
    "${MODEL_SAFE_BASE_ENV_KEYS[@]}" \
    DISPLAY XAUTHORITY XDG_RUNTIME_DIR NODE_PATH
  env -i "${MODEL_SAFE_ENV[@]}" "${chrome_path}" \
    "${CHROMIUM_LAUNCH_FLAGS[@]}" \
    about:blank \
    >"$(chromium_log_file)" 2>&1 &
  local chromium_pid=$!
  echo "${chromium_pid}" > "${pid_file}"

  await_chromium_cdp_ready "${chromium_pid}"
}

start_browser_session() {
  if [ "${INSTAFY_ENABLE_BROWSER_SESSION:-0}" != "1" ]; then
    return
  fi

  # Normalize once and export it so Chromium, the origin capability response,
  # and a later profile-persistence relaunch all advertise/use the same scale.
  export INSTAFY_BROWSER_RENDER_SCALE="$(browser_render_scale)"
  export INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS="$(browser_max_framebuffer_pixels)"

  # A browser without the policy proxy can reach container/control-plane and
  # cloud metadata addresses. Start and verify the loopback proxy before X or
  # Chromium; on failure the agent runtime remains usable but no browser starts.
  if ! ensure_browser_egress_proxy; then
    local warning_text
    warning_text="Shared Browser egress isolation is unavailable; browser session startup was blocked."
    printf '%s\n' "${warning_text}" > "$(chromium_warning_file)"
    echo "[instafy] ${warning_text}" >&2
    return 0
  fi

  # Hosted runtimes normally omit the origin server entirely (ORIGIN_ID unset) because git-canonical
  # uses origin-gateway for filesystem access. For an interactive browser session we need a runtime-
  # local websocket endpoint that can broker VNC access, so we opportunistically enable the origin
  # HTTP server and key it off the runtime id. This origin is used explicitly by the Studio browser
  # session modal, not as the default filesystem origin.
  export ORIGIN_ENABLED="${ORIGIN_ENABLED:-1}"
  if [ -z "${ORIGIN_ID:-}" ]; then
    if [ -n "${RUNTIME_ID:-}" ]; then
      export ORIGIN_ID="${RUNTIME_ID}"
    elif command -v uuidgen >/dev/null 2>&1; then
      export ORIGIN_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    else
      echo "[instafy] browser session enabled, but ORIGIN_ID and RUNTIME_ID are missing" >&2
      return
    fi
  fi
  if [ "${ORIGIN_MODE:-desktop}" = "desktop" ]; then
    export ORIGIN_MODE="hosted"
  fi

  # The base image carries X/VNC and Chromium only for the on-demand browser
  # host below. Its boot path keeps its earlier effect: the egress proxy may
  # start, but no display or browser does until something calls the host.
  if [ "${INSTAFY_RUNTIME_FLAVOR:-}" = "base" ]; then
    echo "[instafy] browser session enabled, but the base image starts its browser only on demand (use runtime-webdev image target)" >&2
    return
  fi

  if ! command -v Xtigervnc >/dev/null 2>&1; then
    echo "[instafy] browser session enabled, but Xtigervnc is not installed (use runtime-webdev image target)" >&2
    return
  fi

  export DISPLAY="${INSTAFY_BROWSER_DISPLAY:-:1}"
  local vnc_port="${INSTAFY_VNC_PORT:-5900}"
  local geometry
  geometry="$(scaled_browser_geometry)"
  local depth="${INSTAFY_VNC_DEPTH:-24}"
  local display_dpi
  display_dpi="$(browser_display_dpi)"

  mkdir -p /tmp/instafy

  local display_number="${DISPLAY#:}"
  local x_lock_file="/tmp/.X${display_number}-lock"
  local x_socket_file="/tmp/.X11-unix/X${display_number}"

  start_vnc_server() {
    build_model_safe_env \
      "${MODEL_SAFE_BASE_ENV_KEYS[@]}" \
      DISPLAY XAUTHORITY XDG_RUNTIME_DIR
    env -i "${MODEL_SAFE_ENV[@]}" Xtigervnc "${DISPLAY}" \
      -rfbport "${vnc_port}" \
      -geometry "${geometry}" \
      -depth "${depth}" \
      -dpi "${display_dpi}" \
      -localhost \
      -SecurityTypes None \
      -AlwaysShared \
      >/tmp/instafy/vnc.log 2>&1 &

    if command -v xdpyinfo >/dev/null 2>&1; then
      for _ in $(seq 1 60); do
        if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
          return 0
        fi
        sleep 0.1
      done
      return 1
    fi

    sleep 0.5
    return 0
  }

  # Headed Playwright needs a real X server. Xtigervnc provides both X + VNC.
  # We bind to localhost and rely on the origin server to broker access.
  if ! start_vnc_server; then
    if grep -q "Server is already active for display" /tmp/instafy/vnc.log 2>/dev/null \
      || [ -f "${x_lock_file}" ] \
      || [ -e "${x_socket_file}" ]; then
      rm -f "${x_lock_file}" "${x_socket_file}"
      pkill -x Xtigervnc >/dev/null 2>&1 || true
      sleep 0.2
      start_vnc_server || echo "[instafy] failed to start Xtigervnc after stale lock cleanup" >&2
    else
      echo "[instafy] failed to start Xtigervnc for display ${DISPLAY}" >&2
    fi
  fi

  # When browser-profile persistence is enabled, runtime-agent restores the
  # saved profile and launches Chromium itself (so the browser boots with the
  # restored cookies). Start the window manager here regardless, but defer the
  # Chromium launch to runtime-agent in that mode.
  local defer_chromium_launch=0
  if [ "${INSTAFY_BROWSER_PROFILE_PERSIST:-0}" = "1" ]; then
    defer_chromium_launch=1
  fi

  if command -v fluxbox >/dev/null 2>&1; then
    # Avoid Fluxbox's default fbsetbg warning popup in minimal containers.
    mkdir -p /root/.fluxbox
    cat > /tmp/instafy/fluxbox-style <<'EOF'
background: flat
background.color: #101010
background.colorTo: #101010
EOF
    if [ -f /root/.fluxbox/init ]; then
      grep -v '^session\.screen0\.rootCommand:' /root/.fluxbox/init \
        | grep -v '^session\.styleFile:' \
        | grep -v '^session\.screen0\.toolbar\.visible:' \
        > /tmp/instafy/fluxbox-init.tmp || true
      mv /tmp/instafy/fluxbox-init.tmp /root/.fluxbox/init
    fi
    printf '%s\n' 'session.screen0.rootCommand: /bin/true' >> /root/.fluxbox/init
    printf '%s\n' 'session.styleFile: /tmp/instafy/fluxbox-style' >> /root/.fluxbox/init
    printf '%s\n' 'session.screen0.toolbar.visible: false' >> /root/.fluxbox/init
    pkill -f '^xmessage -default okay -center fbsetbg:' >/dev/null 2>&1 || true
    build_model_safe_env \
      "${MODEL_SAFE_BASE_ENV_KEYS[@]}" \
      DISPLAY XAUTHORITY XDG_RUNTIME_DIR
    env -i "${MODEL_SAFE_ENV[@]}" fluxbox >/tmp/instafy/fluxbox.log 2>&1 &
  fi

  if [ "${defer_chromium_launch}" = "1" ]; then
    echo "[instafy] browser profile persistence enabled; deferring Chromium launch to runtime-agent" >&2
  else
    if ! start_headed_chromium_daemon; then
      return 0
    fi
  fi

  start_browser_webrtc_sender_daemon
}

# On-demand browser host: `runtime-entrypoint start-browser-host`.
#
# Starts one Shared Browser stack (egress proxy, X/VNC, window manager,
# Chromium and, when enabled, the WebRTC sender) when a caller asks for it,
# instead of at boot. Nothing here runs unless the subcommand is called, and
# the boot path above is unchanged.
#
# The caller owns every location and port, passed in the environment:
#
#   INSTAFY_BROWSER_HOST_HOME         HOME for the browser processes (absolute)
#   INSTAFY_BROWSER_HOST_PROFILE_DIR  Chromium user-data-dir (absolute). It is
#                                     used as given and never wiped, so a
#                                     persisted profile keeps its sign-ins.
#   INSTAFY_BROWSER_HOST_STATE_DIR    logs, window-manager style and the
#                                     host's lock (absolute). One host runs
#                                     per state directory at a time.
#   INSTAFY_BROWSER_HOST_DISPLAY      X display, :N
#   INSTAFY_BROWSER_HOST_CDP_PORT     loopback CDP port
#   INSTAFY_BROWSER_HOST_VNC_PORT     loopback RFB port
#   INSTAFY_BROWSER_HOST_EGRESS_PORT  loopback egress proxy port
#   INSTAFY_BROWSER_HOST_WEBRTC_PORT  loopback WebRTC sender port, required
#                                     only with INSTAFY_BROWSER_WEBRTC_ENABLED=1
#   INSTAFY_BROWSER_HOST_CHROMIUM     optional Chromium executable
#   INSTAFY_BROWSER_HOST_DISK_CACHE_MB optional HTTP cache cap, 8-512 (64)
#
# The display and ports must differ from the boot-time defaults (:1, 5900,
# 9223, 9225, 9226) and from each other. The host starts fresh children every
# time: it never reuses pid files, deletes X locks or kills processes it did
# not start, and it reports a display or port that is already taken instead of
# taking it over. It leads its own process group, so signalling that group
# stops the whole browser, and it lowers its priority to nice 10 and raises
# its OOM score to 1000 so the workspace keeps priority over the browser.
#
# stdout carries exactly one status line per outcome:
#
#   instafy-browser-host: ready display=:N cdp=P vnc=P egress=P|off webrtc=P|off|unavailable scale=S elapsed_ms=MS
#   instafy-browser-host: failed <reason>   (exit status below)
#   instafy-browser-host: exited <child>    (a required child stopped; exit 71)
#   instafy-browser-host: stopped           (SIGTERM, SIGINT or SIGHUP; exit 0)
#
# Failure reasons and exit statuses: config_invalid 64, port_reserved 65,
# display_in_use, port_in_use, profile_in_use and host_in_use 66,
# stack_missing 67, egress_unavailable 68, display_failed 69,
# chromium_failed 70, host_error 72 (any other failure, such as a write that
# fails on a full disk).
# Diagnostics go to stderr and to the logs in the state directory.

readonly BROWSER_HOST_STATUS_PREFIX="instafy-browser-host:"
readonly -a BROWSER_HOST_RESERVED_PORTS=(5900 9223 9225 9226)
BROWSER_HOST_CHILD_NAMES=()
BROWSER_HOST_CHILD_PIDS=()
BROWSER_HOST_REQUIRED_PIDS=()
# Set once a final status line (failed, exited or stopped) is printed.
BROWSER_HOST_ENDED=0

browser_host_status() {
  case "$*" in
    failed* | exited* | stopped*) BROWSER_HOST_ENDED=1 ;;
  esac
  printf '%s %s\n' "${BROWSER_HOST_STATUS_PREFIX}" "$*"
}

browser_host_track_child() {
  # $1 name, $2 pid, $3 "required" when the host must stop with this child.
  BROWSER_HOST_CHILD_NAMES+=("$1")
  BROWSER_HOST_CHILD_PIDS+=("$2")
  if [ "${3:-}" = "required" ]; then
    BROWSER_HOST_REQUIRED_PIDS+=("$2")
  fi
}

# Set once the host leads its own process group (Linux with setsid). Every
# child, and everything a child starts, such as Chromium's zygote, renderers
# and crash handler, then shares that group, so a caller can stop the whole
# browser by signalling the group and the host can find what remains.
BROWSER_HOST_GROUP_LEADER=0
BROWSER_HOST_GROUP_MEMBERS=()

browser_host_process_group() {
  # Prints the process group of process $1 from /proc, or nothing.
  local stat="" rest pgrp=""
  read -r stat 2>/dev/null < "/proc/$1/stat" || return 0
  rest="${stat##*) }"
  read -r _ _ pgrp _ <<< "${rest}"
  printf '%s' "${pgrp}"
}

browser_host_collect_group_members() {
  # Fills BROWSER_HOST_GROUP_MEMBERS with the live processes in the host's
  # group other than the host itself. Reads /proc with builtins only, so the
  # scan adds no process of its own to the group.
  BROWSER_HOST_GROUP_MEMBERS=()
  local stat_file pid stat rest state pgrp
  for stat_file in /proc/[0-9]*/stat; do
    pid="${stat_file#/proc/}"
    pid="${pid%/stat}"
    if [ "${pid}" = "$$" ] || [ "${pid}" = "${BASHPID}" ]; then
      continue
    fi
    stat=""
    read -r stat 2>/dev/null < "${stat_file}" || continue
    rest="${stat##*) }"
    read -r state _ pgrp _ <<< "${rest}"
    # A zombie has already exited; it stays only until its parent reaps it.
    if [ "${pgrp}" = "$$" ] && [ "${state}" != "Z" ]; then
      BROWSER_HOST_GROUP_MEMBERS+=("${pid}")
    fi
  done
}

browser_host_stop_children() {
  # Stop what this host started, then reap it. As the group leader the host
  # signals its whole group (ignoring the signal itself), so the browser's
  # own descendants stop too; otherwise it signals its direct children.
  local index pid alive
  if [ "${BROWSER_HOST_GROUP_LEADER}" = "1" ]; then
    trap '' TERM
    kill -TERM -- "-$$" >/dev/null 2>&1 || true
    for _ in $(seq 1 50); do
      browser_host_collect_group_members
      if [ "${#BROWSER_HOST_GROUP_MEMBERS[@]}" = "0" ]; then
        break
      fi
      sleep 0.1
    done
    browser_host_collect_group_members
    for pid in "${BROWSER_HOST_GROUP_MEMBERS[@]}"; do
      kill -KILL "${pid}" >/dev/null 2>&1 || true
    done
  else
    for (( index=${#BROWSER_HOST_CHILD_PIDS[@]} - 1; index >= 0; index-- )); do
      kill -TERM "${BROWSER_HOST_CHILD_PIDS[index]}" >/dev/null 2>&1 || true
    done
    for _ in $(seq 1 50); do
      alive=0
      for pid in "${BROWSER_HOST_CHILD_PIDS[@]}"; do
        if kill -0 "${pid}" >/dev/null 2>&1; then
          alive=1
          break
        fi
      done
      if [ "${alive}" = "0" ]; then
        break
      fi
      sleep 0.1
    done
  fi
  for pid in "${BROWSER_HOST_CHILD_PIDS[@]}"; do
    kill -KILL "${pid}" >/dev/null 2>&1 || true
    wait "${pid}" >/dev/null 2>&1 || true
  done
  BROWSER_HOST_CHILD_NAMES=()
  BROWSER_HOST_CHILD_PIDS=()
  BROWSER_HOST_REQUIRED_PIDS=()
}

browser_host_fail() {
  # $1 reason, $2 exit status, $3 diagnostic (fixed text plus caller values).
  echo "[instafy] browser host: $3" >&2
  browser_host_stop_children
  trap - EXIT
  browser_host_status "failed $1"
  exit "$2"
}

browser_host_child_name() {
  local index
  for index in "${!BROWSER_HOST_CHILD_PIDS[@]}"; do
    if [ "${BROWSER_HOST_CHILD_PIDS[index]}" = "$1" ]; then
      printf '%s' "${BROWSER_HOST_CHILD_NAMES[index]}"
      return 0
    fi
  done
  printf '%s' "unknown"
}

browser_host_require_dir() {
  # $1 variable name: an absolute path without `..` segments or control
  # characters. Runs in the host's own shell so a failure ends the host.
  local name="$1"
  local value="${!name:-}"
  if [[ ! "${value}" =~ ^/[^[:cntrl:]]*$ ]] || [[ "/${value}/" == *"/../"* ]]; then
    browser_host_fail config_invalid 64 "${name} must be an absolute directory path"
  fi
}

browser_host_require_port() {
  # $1 variable name: a loopback port this host may use, 1024-65535 and not
  # one the boot-time browser owns.
  local name="$1"
  local value="${!name:-}"
  if [[ ! "${value}" =~ ^[1-9][0-9]{3,4}$ ]] || [ "${value}" -lt 1024 ] || [ "${value}" -gt 65535 ]; then
    browser_host_fail config_invalid 64 "${name} must be a port from 1024 to 65535"
  fi
  local reserved
  for reserved in "${BROWSER_HOST_RESERVED_PORTS[@]}"; do
    if [ "${value}" = "${reserved}" ]; then
      browser_host_fail port_reserved 65 "${name}=${value} belongs to the boot-time browser"
    fi
  done
}

browser_host_port_open() {
  # True when something already accepts connections on loopback port $1.
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}

browser_host_display_owner_alive() {
  # True when display $1 (a number) has a lock file naming a live process.
  # A stale lock is left for the X server, which replaces it itself.
  local lock_file="/tmp/.X$1-lock"
  local owner=""
  if [ ! -f "${lock_file}" ]; then
    return 1
  fi
  owner="$(tr -d '[:space:]' < "${lock_file}" 2>/dev/null || true)"
  [[ "${owner}" =~ ^[0-9]+$ ]] && kill -0 "${owner}" >/dev/null 2>&1
}

browser_host_release_profile_lock() {
  # A persisted profile can carry Chromium's singleton lock from the machine
  # that saved it. Refuse a profile a live Chromium on this machine still
  # holds; otherwise the lock is stale and is removed so Chromium starts.
  local profile_dir="$1"
  local lock="${profile_dir}/SingletonLock"
  if [ -L "${lock}" ] || [ -e "${lock}" ]; then
    local target owner_host owner_pid owner_command=""
    target="$(readlink "${lock}" 2>/dev/null || true)"
    owner_host="${target%-*}"
    owner_pid="${target##*-}"
    if [ "${owner_host}" = "${HOSTNAME:-}" ] && [[ "${owner_pid}" =~ ^[0-9]+$ ]] \
      && kill -0 "${owner_pid}" >/dev/null 2>&1; then
      owner_command="$(cat "/proc/${owner_pid}/comm" 2>/dev/null || true)"
      case "${owner_command}" in
        chrom*)
          return 1
          ;;
      esac
    fi
  fi
  rm -f "${profile_dir}/SingletonLock" \
    "${profile_dir}/SingletonSocket" \
    "${profile_dir}/SingletonCookie"
}

browser_host_disk_cache_bytes() {
  awk -v raw="${INSTAFY_BROWSER_HOST_DISK_CACHE_MB:-64}" 'BEGIN {
    if (raw !~ /^[0-9]+$/) raw = 64;
    if (raw < 8) raw = 8;
    if (raw > 512) raw = 512;
    printf "%d", raw * 1048576;
  }'
}

resolve_browser_host_chromium() {
  # An explicit executable wins. Otherwise prefer Playwright's Chromium (the
  # webdev image), then Debian's real binary over its /usr/bin/chromium shell
  # wrapper, which reads flags from /etc/chromium.d.
  if [ -n "${INSTAFY_BROWSER_HOST_CHROMIUM:-}" ]; then
    if [ -x "${INSTAFY_BROWSER_HOST_CHROMIUM}" ]; then
      printf '%s' "${INSTAFY_BROWSER_HOST_CHROMIUM}"
    fi
    return 0
  fi
  local resolved
  resolved="$(resolve_chromium_executable_path)"
  if [ "${resolved}" = "/usr/bin/chromium" ] && [ -x /usr/lib/chromium/chromium ]; then
    resolved=/usr/lib/chromium/chromium
  fi
  printf '%s' "${resolved}"
}

browser_host_prepare_process() {
  # Re-exec once, keeping this pid, as the leader of a new process group
  # (setsid does not fork for a process that does not lead a group) and at
  # nice 10 relative to the caller. Then raise the OOM score. Children inherit
  # the group, the niceness and the OOM score.
  #
  # The TURN credentials never stay in this process's own environment: unset
  # changes only the shell's variables, not /proc/<pid>/environ, so a host
  # started with INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON re-execs without it.
  local pgrp current relaunch=()
  pgrp="$(browser_host_process_group "$$")"
  if [ -n "${INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON+set}" ]; then
    relaunch+=(env -u INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON)
  fi
  if [ -z "${INSTAFY_BROWSER_HOST_RELAUNCHED:-}" ]; then
    if [ -n "${pgrp}" ] && [ "${pgrp}" != "$$" ] && command -v setsid >/dev/null 2>&1; then
      relaunch+=(setsid)
    fi
    current="$(nice 2>/dev/null || true)"
    if [[ "${current}" =~ ^-?[0-9]+$ ]] && [ "${current}" -lt 10 ]; then
      relaunch+=(nice -n "$(( 10 - current ))")
    fi
  fi
  if [ "${#relaunch[@]}" -gt 0 ]; then
    export INSTAFY_BROWSER_HOST_RELAUNCHED=1
    exec "${relaunch[@]}" bash "$0" start-browser-host
  fi
  if [ -n "${pgrp}" ] && [ "${pgrp}" = "$$" ]; then
    BROWSER_HOST_GROUP_LEADER=1
  fi
  { printf '1000\n' > "/proc/$$/oom_score_adj"; } 2>/dev/null || true
}

browser_host_on_exit() {
  # Any exit without a final status line, such as a write that fails under
  # `set -e`, still stops the children and reports one.
  trap - EXIT
  browser_host_stop_children
  if [ "${BROWSER_HOST_ENDED}" != "1" ]; then
    browser_host_status "failed host_error"
    exit 72
  fi
}

browser_host_on_signal() {
  trap - EXIT TERM INT HUP
  browser_host_stop_children
  browser_host_status "stopped"
  exit 0
}

start_browser_host() {
  browser_host_prepare_process
  trap 'browser_host_on_exit' EXIT
  trap 'browser_host_on_signal' TERM INT HUP

  local started_ms
  started_ms="$(chromium_ready_clock_ms)"

  # The sender takes ICE servers from each offer in this mode, so the host
  # has no use for TURN credentials (browser_host_prepare_process already
  # re-executed without them).
  unset INSTAFY_BROWSER_WEBRTC_ICE_SERVERS_JSON

  browser_host_require_dir INSTAFY_BROWSER_HOST_HOME
  browser_host_require_dir INSTAFY_BROWSER_HOST_PROFILE_DIR
  browser_host_require_dir INSTAFY_BROWSER_HOST_STATE_DIR
  local home_dir="${INSTAFY_BROWSER_HOST_HOME}"
  local profile_dir="${INSTAFY_BROWSER_HOST_PROFILE_DIR}"
  local state_dir="${INSTAFY_BROWSER_HOST_STATE_DIR}"
  local display="${INSTAFY_BROWSER_HOST_DISPLAY:-}"
  if [[ ! "${display}" =~ ^:[0-9]{1,4}$ ]]; then
    browser_host_fail config_invalid 64 "INSTAFY_BROWSER_HOST_DISPLAY must be :N"
  fi
  local display_number="${display#:}"
  display_number="$(( 10#${display_number} ))"
  display=":${display_number}"
  if [ "${display_number}" = "1" ]; then
    browser_host_fail port_reserved 65 "display :1 belongs to the boot-time browser"
  fi

  browser_host_require_port INSTAFY_BROWSER_HOST_CDP_PORT
  browser_host_require_port INSTAFY_BROWSER_HOST_VNC_PORT
  browser_host_require_port INSTAFY_BROWSER_HOST_EGRESS_PORT
  local cdp_port="${INSTAFY_BROWSER_HOST_CDP_PORT}"
  local vnc_port="${INSTAFY_BROWSER_HOST_VNC_PORT}"
  local egress_port="${INSTAFY_BROWSER_HOST_EGRESS_PORT}"
  local webrtc_enabled=0 webrtc_port=""
  local ports=("${cdp_port}" "${vnc_port}" "${egress_port}")
  if [ "${INSTAFY_BROWSER_WEBRTC_ENABLED:-0}" = "1" ]; then
    browser_host_require_port INSTAFY_BROWSER_HOST_WEBRTC_PORT
    webrtc_enabled=1
    webrtc_port="${INSTAFY_BROWSER_HOST_WEBRTC_PORT}"
    ports+=("${webrtc_port}")
  fi
  local index other
  for index in "${!ports[@]}"; do
    for other in "${ports[@]:index+1}"; do
      if [ "${ports[index]}" = "${other}" ]; then
        browser_host_fail config_invalid 64 "the browser host ports must be distinct"
      fi
    done
  done

  if ! command -v Xtigervnc >/dev/null 2>&1 || ! command -v xdpyinfo >/dev/null 2>&1; then
    browser_host_fail stack_missing 67 "Xtigervnc and xdpyinfo are required"
  fi
  local chrome_path
  chrome_path="$(resolve_browser_host_chromium)"
  if [ -z "${chrome_path}" ]; then
    browser_host_fail stack_missing 67 "no Chromium executable found"
  fi

  # Only the directories are created; an existing profile is used as is.
  if ! mkdir -p "${home_dir}" "${profile_dir}" "${state_dir}" 2>/dev/null \
    || ! chmod 700 "${home_dir}" "${profile_dir}" "${state_dir}" 2>/dev/null; then
    browser_host_fail config_invalid 64 "cannot create the host's home, profile or state directory"
  fi

  # One host per state directory: a second start for the same caller fails
  # here instead of racing the first one's port and readiness checks. The
  # lock is held on fd 9 for the host's life; no child inherits it.
  if ! command -v flock >/dev/null 2>&1; then
    browser_host_fail stack_missing 67 "flock is required"
  fi
  if ! { exec 9>>"${state_dir}/host.lock"; } 2>/dev/null; then
    browser_host_fail config_invalid 64 "cannot open ${state_dir}/host.lock"
  fi
  if ! flock -n 9; then
    browser_host_fail host_in_use 66 "another browser host is using ${state_dir}"
  fi

  if browser_host_display_owner_alive "${display_number}"; then
    browser_host_fail display_in_use 66 "display ${display} is already in use"
  fi
  local port
  for port in "${ports[@]}"; do
    if browser_host_port_open "${port}"; then
      browser_host_fail port_in_use 66 "loopback port ${port} is already in use"
    fi
  done

  if ! browser_host_release_profile_lock "${profile_dir}"; then
    browser_host_fail profile_in_use 66 "a running Chromium holds the profile"
  fi
  if ! block_browser_downloads "${profile_dir}"; then
    browser_host_fail host_error 72 "cannot block downloads in the profile"
  fi
  # Sign-ins that use cookies without an expiry are kept only when Chromium
  # continues its last session. Without it the browser still works.
  if ! keep_browser_session_on_restart "${profile_dir}"; then
    echo "[instafy] browser host: could not set session restore in the profile" >&2
  fi

  export HOME="${home_dir}"
  export DISPLAY="${display}"
  export INSTAFY_PLAYWRIGHT_PROFILE_DIR="${profile_dir}"
  export INSTAFY_PLAYWRIGHT_CDP_PORT="${cdp_port}"
  export INSTAFY_BROWSER_EGRESS_PROXY_BIND="127.0.0.1:${egress_port}"
  export INSTAFY_BROWSER_RENDER_SCALE="$(browser_render_scale)"
  export INSTAFY_BROWSER_MAX_FRAMEBUFFER_PIXELS="$(browser_max_framebuffer_pixels)"

  # Egress isolation first: a browser without the policy proxy can reach
  # container, control-plane and cloud metadata addresses.
  local egress_status="off"
  if browser_egress_isolation_active; then
    if ! command -v browser-egress-proxy >/dev/null 2>&1; then
      browser_host_fail stack_missing 67 "browser-egress-proxy is missing"
    fi
    build_model_safe_env \
      "${MODEL_SAFE_BASE_ENV_KEYS[@]}" \
      INSTAFY_BROWSER_EGRESS_PROXY_BIND \
      INSTAFY_BROWSER_EGRESS_ALLOWED_PORTS \
      INSTAFY_BROWSER_EGRESS_MAX_CONNECTIONS
    env -i "${MODEL_SAFE_ENV[@]}" browser-egress-proxy \
      >>"${state_dir}/browser-egress-proxy.log" 2>&1 9>&- &
    local egress_pid=$!
    browser_host_track_child egress-proxy "${egress_pid}" required
    local egress_ready=0
    for _ in $(seq 1 50); do
      if ! kill -0 "${egress_pid}" >/dev/null 2>&1; then
        break
      fi
      if browser_egress_proxy_healthy; then
        egress_ready=1
        break
      fi
      sleep 0.1
    done
    if [ "${egress_ready}" != "1" ]; then
      browser_host_fail egress_unavailable 68 "the egress proxy failed its readiness check"
    fi
    egress_status="${egress_port}"
  elif [ "${INSTAFY_BROWSER_EGRESS_ALLOW_UNSAFE_DEV}" = "1" ]; then
    echo "[instafy] WARNING: browser host egress isolation disabled by dev-only override" >&2
  else
    browser_host_fail egress_unavailable 68 "egress isolation is required; set INSTAFY_BROWSER_EGRESS_ISOLATION=1"
  fi

  local geometry depth display_dpi
  geometry="$(scaled_browser_geometry)"
  depth="${INSTAFY_VNC_DEPTH:-24}"
  if [[ ! "${depth}" =~ ^(16|24|32)$ ]]; then
    depth=24
  fi
  display_dpi="$(browser_display_dpi)"
  build_model_safe_env \
    "${MODEL_SAFE_BASE_ENV_KEYS[@]}" \
    DISPLAY XAUTHORITY XDG_RUNTIME_DIR
  env -i "${MODEL_SAFE_ENV[@]}" Xtigervnc "${DISPLAY}" \
    -rfbport "${vnc_port}" \
    -geometry "${geometry}" \
    -depth "${depth}" \
    -dpi "${display_dpi}" \
    -localhost \
    -SecurityTypes None \
    -AlwaysShared \
    >"${state_dir}/vnc.log" 2>&1 9>&- &
  local display_pid=$!
  browser_host_track_child display "${display_pid}" required
  local display_ready=0
  for _ in $(seq 1 60); do
    if ! kill -0 "${display_pid}" >/dev/null 2>&1; then
      break
    fi
    if xdpyinfo -display "${DISPLAY}" >/dev/null 2>&1; then
      display_ready=1
      break
    fi
    sleep 0.1
  done
  if [ "${display_ready}" != "1" ]; then
    browser_host_fail display_failed 69 "Xtigervnc did not start on display ${display}"
  fi

  if command -v fluxbox >/dev/null 2>&1; then
    # The window manager's settings live under this host's HOME, never /root.
    mkdir -p "${HOME}/.fluxbox"
    printf '%s\n' \
      'background: flat' \
      'background.color: #101010' \
      'background.colorTo: #101010' \
      > "${state_dir}/fluxbox-style"
    printf '%s\n' \
      'session.screen0.rootCommand: /bin/true' \
      "session.styleFile: ${state_dir}/fluxbox-style" \
      'session.screen0.toolbar.visible: false' \
      > "${HOME}/.fluxbox/init"
    build_model_safe_env \
      "${MODEL_SAFE_BASE_ENV_KEYS[@]}" \
      DISPLAY XAUTHORITY XDG_RUNTIME_DIR
    env -i "${MODEL_SAFE_ENV[@]}" fluxbox >"${state_dir}/fluxbox.log" 2>&1 9>&- &
    browser_host_track_child window-manager "$!"
  fi

  build_chromium_launch_flags
  build_model_safe_env \
    "${MODEL_SAFE_BASE_ENV_KEYS[@]}" \
    DISPLAY XAUTHORITY XDG_RUNTIME_DIR
  env -i "${MODEL_SAFE_ENV[@]}" "${chrome_path}" \
    "${CHROMIUM_LAUNCH_FLAGS[@]}" \
    --disk-cache-size="$(browser_host_disk_cache_bytes)" \
    --password-store=basic \
    about:blank \
    >"${state_dir}/chromium.log" 2>&1 9>&- &
  local chromium_pid=$!
  browser_host_track_child chromium "${chromium_pid}" required
  local ready_rc=0
  check_chromium_cdp_ready "${chromium_pid}" "$(chromium_cdp_ready_timeout_secs)" || ready_rc=$?
  if [ "${ready_rc}" = "2" ]; then
    browser_host_fail chromium_failed 70 "Chromium exited before answering on CDP port ${cdp_port}; see ${state_dir}/chromium.log"
  elif [ "${ready_rc}" != "0" ]; then
    browser_host_fail chromium_failed 70 "Chromium did not answer on CDP port ${cdp_port} in time; see ${state_dir}/chromium.log"
  fi

  # The WebRTC sender is optional: Studio falls back to CDP screencast or RFB.
  local webrtc_status="off"
  if [ "${webrtc_enabled}" = "1" ]; then
    webrtc_status="unavailable"
    if command -v browser-webrtc-sender >/dev/null 2>&1 && command -v ffmpeg >/dev/null 2>&1; then
      export INSTAFY_BROWSER_WEBRTC_BIND="127.0.0.1:${webrtc_port}"
      export INSTAFY_BROWSER_WEBRTC_GEOMETRY="${INSTAFY_BROWSER_WEBRTC_GEOMETRY:-${geometry}}"
      build_model_safe_env \
        "${MODEL_SAFE_BASE_ENV_KEYS[@]}" \
        DISPLAY \
        INSTAFY_BROWSER_WEBRTC_BIND \
        INSTAFY_BROWSER_WEBRTC_GEOMETRY \
        INSTAFY_BROWSER_WEBRTC_FPS \
        INSTAFY_BROWSER_WEBRTC_BITRATE_KBPS \
        INSTAFY_BROWSER_WEBRTC_FFMPEG \
        INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN \
        INSTAFY_VNC_GEOMETRY
      env -i "${MODEL_SAFE_ENV[@]}" browser-webrtc-sender \
        >>"${state_dir}/browser-webrtc-sender.log" 2>&1 9>&- &
      local webrtc_pid=$!
      browser_host_track_child webrtc-sender "${webrtc_pid}"
      for _ in $(seq 1 50); do
        if ! kill -0 "${webrtc_pid}" >/dev/null 2>&1; then
          break
        fi
        if curl --noproxy '*' -fsS --max-time 1 "http://127.0.0.1:${webrtc_port}/healthz" >/dev/null 2>&1; then
          webrtc_status="${webrtc_port}"
          break
        fi
        sleep 0.1
      done
    fi
    if [ "${webrtc_status}" = "unavailable" ]; then
      echo "[instafy] browser host: the WebRTC sender is unavailable; see ${state_dir}/browser-webrtc-sender.log" >&2
    fi
  fi

  local elapsed_ms
  elapsed_ms="$(( $(chromium_ready_clock_ms) - started_ms ))"
  if [ "${elapsed_ms}" -lt 0 ]; then
    elapsed_ms=0
  fi
  browser_host_status "ready display=${display} cdp=${cdp_port} vnc=${vnc_port} egress=${egress_status} webrtc=${webrtc_status} scale=${INSTAFY_BROWSER_RENDER_SCALE} elapsed_ms=${elapsed_ms}"

  # Stay in the foreground as the parent of every child. The caller stops the
  # host with SIGTERM (or by killing its process group); a required child that
  # stops on its own ends the host so the caller sees the failure.
  local exited_pid="" wait_status=0
  wait -n -p exited_pid "${BROWSER_HOST_REQUIRED_PIDS[@]}" || wait_status=$?
  local exited_name
  exited_name="$(browser_host_child_name "${exited_pid}")"
  echo "[instafy] browser host: ${exited_name} stopped (status ${wait_status})" >&2
  browser_host_stop_children
  trap - EXIT
  browser_host_status "exited ${exited_name}"
  exit 71
}

if [ "${1:-}" = "start-browser-host" ]; then
  start_browser_host
fi

# Subcommand: `runtime-entrypoint launch-chromium` only (re)launches the headed
# Chromium daemon against the already-seeded profile dir. runtime-agent invokes
# this after restoring a persisted profile, once VNC/X/fluxbox are already up
# from the boot path (whose DISPLAY/profile env this process inherits via exec).
if [ "${1:-}" = "launch-chromium" ]; then
  start_headed_chromium_daemon
  exit 0
fi

start_browser_session

exec /usr/local/bin/runtime-agent
