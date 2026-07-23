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
if command -v npm >/dev/null 2>&1; then
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
  for candidate in \
    /ms-playwright/chromium-*/chrome-linux/chrome \
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

check_chromium_cdp_ready() {
  local endpoint="http://127.0.0.1:${INSTAFY_PLAYWRIGHT_CDP_PORT}/json/version"
  for _ in $(seq 1 60); do
    if curl -sS "${endpoint}" | grep -q '"Browser"'; then
      return 0
    fi
    sleep 0.2
  done
  return 1
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

  cleanup_chromium_profile_locks

  build_model_safe_env \
    "${MODEL_SAFE_BASE_ENV_KEYS[@]}" \
    DISPLAY XAUTHORITY XDG_RUNTIME_DIR NODE_PATH
  env -i "${MODEL_SAFE_ENV[@]}" "${chrome_path}" \
    --no-first-run \
    --no-default-browser-check \
    --disable-component-update \
    --disable-infobars \
    --disable-features=TranslateUI \
    --high-dpi-support=1 \
    --force-device-scale-factor="${render_scale}" \
    --disable-dev-shm-usage \
    --remote-debugging-address=127.0.0.1 \
    --remote-debugging-port="${INSTAFY_PLAYWRIGHT_CDP_PORT}" \
    --user-data-dir="${INSTAFY_PLAYWRIGHT_PROFILE_DIR}" \
    --no-sandbox \
    "${egress_flags[@]}" \
    "${extension_flags[@]}" \
    "${window_flags[@]}" \
    "${viewport_flags[@]}" \
    about:blank \
    >"$(chromium_log_file)" 2>&1 &
  echo "$!" > "${pid_file}"

  if check_chromium_cdp_ready; then
    echo "[instafy] Headed Chromium ready (CDP) on 127.0.0.1:${INSTAFY_PLAYWRIGHT_CDP_PORT}" >&2
    return
  fi

  if [ -f "${pid_file}" ]; then
    kill "$(cat "${pid_file}")" >/dev/null 2>&1 || true
    rm -f "${pid_file}"
  fi

  local warning_text
  warning_text="Headed Chromium did not become ready on CDP port ${INSTAFY_PLAYWRIGHT_CDP_PORT}. Check $(chromium_log_file) and restart runtime."
  printf '%s\n' "${warning_text}" > "$(chromium_warning_file)"
  echo "[instafy] ${warning_text}" >&2
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
