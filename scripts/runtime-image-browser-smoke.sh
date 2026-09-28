#!/usr/bin/env bash
# Proves a runtime webdev image starts the Shared Browser: it boots the image's
# own entrypoint with the browser session enabled and requires headed Chromium
# to answer on its CDP port.
#
#   scripts/runtime-image-browser-smoke.sh <image> [<entrypoint to mount>]
#
# The entrypoint ends by exec'ing runtime-agent, which needs a controller. The
# smoke runs every line before that one (egress proxy, X/VNC, window manager,
# Chromium resolution and launch) and then holds the container open. With a
# second argument, that entrypoint file replaces the image's, so a change to
# docker/runtime/entrypoint.sh can be checked against a published image.
set -euo pipefail

image="${1:?usage: runtime-image-browser-smoke.sh <image> [<entrypoint>]}"
override="${2:-}"
timeout_seconds="${BROWSER_SMOKE_TIMEOUT_SECONDS:-120}"
cdp_port=9223
name="instafy-browser-smoke-${RANDOM}-$$"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
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
echo "exec sleep infinity" >> /tmp/browser-smoke-entrypoint.sh
exec bash /tmp/browser-smoke-entrypoint.sh'

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
