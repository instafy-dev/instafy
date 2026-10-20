#!/usr/bin/env bash
# Proves a runtime image starts the Shared Browser. By default it boots the
# image's own entrypoint with the browser session enabled and requires headed
# Chromium to answer on its CDP port (webdev images).
#
# With --lazy it proves the on-demand browser host instead, for every image
# flavor: the image boots with the browser off and must run no browser process
# (the base image must run none even with the browser session on), then
# `runtime-entrypoint start-browser-host` must bring Chromium up on the
# caller's own display and ports with a persisted profile, stop cleanly, and
# start again on the same profile with its data intact.
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

  host_root=/var/lib/instafy-browser-smoke
  profile_dir="$host_root/profile"
  state_dir=/tmp/instafy-browser-smoke/state
  host_cdp_port=19223
  host_webrtc_port=19225
  # What a caller passes: an explicit allowlist with the host's own display,
  # ports and a persisted profile directory.
  host_env=(
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
    INSTAFY_BROWSER_HOST_HOME="$host_root/home"
    INSTAFY_BROWSER_HOST_PROFILE_DIR="$profile_dir"
    INSTAFY_BROWSER_HOST_STATE_DIR="$state_dir"
    INSTAFY_BROWSER_HOST_DISPLAY=:47
    INSTAFY_BROWSER_HOST_CDP_PORT="$host_cdp_port"
    INSTAFY_BROWSER_HOST_VNC_PORT=15900
    INSTAFY_BROWSER_HOST_EGRESS_PORT=19226
    INSTAFY_BROWSER_HOST_WEBRTC_PORT="$host_webrtc_port"
    INSTAFY_BROWSER_WEBRTC_ENABLED=1
    INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN=1
    INSTAFY_BROWSER_VIEWPORT_ONLY=1
    INSTAFY_VNC_GEOMETRY=1280x720
    INSTAFY_BROWSER_RENDER_SCALE=2
  )
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
      *" webrtc=${host_webrtc_port} "*) ;;
      *) lazy_fail "The ${label} browser host's WebRTC sender is unavailable: ${status}" ;;
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
  stop_host first

  # The next start reuses the same profile, including its sign-ins.
  start_host
  prove_running_host second
  stop_host second

  echo "Browser host started on demand twice on one persisted profile and left no process behind."
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
    exit 0
  fi
  sleep 2
done

report
echo "::error::Headed Chromium did not answer on CDP port ${cdp_port} within ${timeout_seconds}s."
exit 1
