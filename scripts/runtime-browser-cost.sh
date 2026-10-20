#!/usr/bin/env bash
# Measures what the on-demand browser host costs a runtime machine, comparing
# an image without the browser host stack (before) with one that has it
# (after):
#
#   scripts/runtime-browser-cost.sh <before-image> <after-image>
#
# It records image size and a cold pull for both, boot time to the entrypoint's
# final exec line and memory after 60 s idle with the browser never started for
# both, and, for the after image only: start-to-CDP-ready latency over 20 host
# starts on one persisted profile, memory at about:blank and after fixture
# pages, container CPU during 60 s of CDP screencast, and /tmp growth.
# scripts/runtime-browser-cost.mjs turns the measurements into the report,
# checks the gates and rewrites the section in docs/Runtime-Image-Builds.md.
#
# Output goes to COST_OUTPUT_DIR (default ./runtime-browser-cost): the raw
# measurements.json, report.md and the updated Runtime-Image-Builds.md. The
# script needs only Docker and the two images: no registry login and no
# secrets. It exits non-zero when a gate fails.
set -euo pipefail

before_image="${1:?usage: runtime-browser-cost.sh <before-image> <after-image>}"
after_image="${2:?usage: runtime-browser-cost.sh <before-image> <after-image>}"
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output_dir="${COST_OUTPUT_DIR:-$PWD/runtime-browser-cost}"
boot_runs="${COST_BOOT_RUNS:-5}"
start_runs="${COST_START_RUNS:-20}"
idle_seconds="${COST_IDLE_SECONDS:-60}"
screencast_seconds="${COST_SCREENCAST_SECONDS:-60}"
skip_pull="${COST_SKIP_PULL:-0}"
# Optional entrypoint file mounted into the after image, to check the script
# against an image built before the browser host existed. Measurements taken
# that way do not describe a release.
after_entrypoint="${COST_AFTER_ENTRYPOINT:-}"
prefix="instafy-browser-cost-${RANDOM}-$$"
mkdir -p "$output_dir"
measurements="$output_dir/measurements.json"

containers=()
cleanup() {
  local container
  for container in ${containers[@]+"${containers[@]}"}; do
    docker rm -f "$container" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

now_ms() {
  local now="${EPOCHREALTIME/./}"
  printf '%s' "$(( 10#${now} / 1000 ))"
}

# Everything before the final runtime-agent exec, then hold the container. The
# boot time is measured inside the container from the first line to the line
# that would exec runtime-agent; the browser stays off, as on a hosted machine.
hold='set -euo pipefail
t0="$(date +%s%N)"
entrypoint=/usr/local/bin/runtime-entrypoint
if [ "$(sed -n "\$p" "$entrypoint")" != "exec /usr/local/bin/runtime-agent" ]; then
  echo "[browser-cost] the entrypoint no longer ends with exec /usr/local/bin/runtime-agent" >&2
  exit 90
fi
sed "\$d" "$entrypoint" > /tmp/browser-cost-entrypoint.sh
echo "echo \$(( (\$(date +%s%N) - INSTAFY_COST_T0) / 1000000 )) > /tmp/browser-cost-boot-ms" >> /tmp/browser-cost-entrypoint.sh
echo "exec sleep infinity" >> /tmp/browser-cost-entrypoint.sh
export INSTAFY_COST_T0="$t0"
exec bash /tmp/browser-cost-entrypoint.sh'

boot_container() {
  # $1 image, $2 container name. Waits until the entrypoint reached its exec
  # line and prints the boot time in milliseconds. It runs in a command
  # substitution, so the caller records the container for cleanup.
  local image="$1" container="$2" deadline boot_ms mount=()
  if [[ -n "$after_entrypoint" && "$image" == "$after_image" && "$container" == *-after-* ]]; then
    mount=(-v "$(cd "$(dirname "$after_entrypoint")" && pwd)/$(basename "$after_entrypoint"):/usr/local/bin/runtime-entrypoint:ro")
  fi
  docker run -d --name "$container" ${mount[@]+"${mount[@]}"} --entrypoint bash \
    -e RUNTIME_ID=00000000-0000-4000-8000-00000000c057 \
    -e ORIGIN_MODE=hosted \
    "$image" -c "$hold" >/dev/null
  deadline=$((SECONDS + 120))
  until boot_ms="$(docker exec "$container" cat /tmp/browser-cost-boot-ms 2>/dev/null)"; do
    if (( SECONDS >= deadline )) || [[ "$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null)" != "true" ]]; then
      docker logs "$container" 2>&1 | tail -n 20 >&2 || true
      echo "::error::$image did not finish booting." >&2
      exit 1
    fi
    sleep 0.2
  done
  printf '%s' "$boot_ms"
}

container_memory() {
  # Current memory of the container's cgroup, in bytes (cgroup v2).
  docker exec "$1" cat /sys/fs/cgroup/memory.current
}

json_array() {
  local IFS=,
  printf '[%s]' "$*"
}

echo "::group::Image size and cold pull"
declare -A size pull_ms
# Each pull starts with neither image present, so the second pull cannot
# reuse layers the first one fetched. The before image is pulled again,
# untimed, for the measurements below.
if [[ "$skip_pull" != "1" ]]; then
  docker image rm -f "$before_image" "$after_image" >/dev/null 2>&1 || true
fi
for side in before after; do
  image="$before_image"
  [[ "$side" == "after" ]] && image="$after_image"
  pull_ms[$side]=null
  if [[ "$skip_pull" != "1" ]]; then
    started="$(now_ms)"
    docker pull --quiet "$image" >/dev/null
    pull_ms[$side]="$(( $(now_ms) - started ))"
  fi
  size[$side]="$(docker image inspect -f '{{.Size}}' "$image")"
  echo "$side: ${size[$side]} bytes, pull ${pull_ms[$side]} ms"
  if [[ "$skip_pull" != "1" && "$side" == "before" ]]; then
    docker image rm -f "$before_image" >/dev/null
  fi
done
if [[ "$skip_pull" != "1" ]]; then
  docker pull --quiet "$before_image" >/dev/null
fi
echo "::endgroup::"

echo "::group::Boot time and idle memory"
declare -A boot_runs_ms idle_bytes
for side in before after; do
  image="$before_image"
  [[ "$side" == "after" ]] && image="$after_image"
  runs=()
  for run in $(seq 1 "$boot_runs"); do
    container="${prefix}-${side}-boot-${run}"
    containers+=("$container")
    runs+=("$(boot_container "$image" "$container")")
    if (( run < boot_runs )); then
      docker rm -f "$container" >/dev/null
    fi
  done
  boot_runs_ms[$side]="$(json_array "${runs[@]}")"
  echo "$side boot ms: ${boot_runs_ms[$side]}"
done
# The last boot container of each image idles side by side.
sleep "$idle_seconds"
for side in before after; do
  idle_bytes[$side]="$(container_memory "${prefix}-${side}-boot-${boot_runs}")"
  echo "$side idle memory: ${idle_bytes[$side]} bytes"
done
host_container="${prefix}-after-boot-${boot_runs}"
if processes="$(docker exec "$host_container" sh -c "ps -eo stat=,comm= | awk '\$1 !~ /^Z/ && \$2 ~ /^(Xtigervnc|fluxbox|chrom|ffmpeg|browser-)/'")" && [[ -n "$processes" ]]; then
  echo "::error::The after image runs browser processes at boot: ${processes//$'\n'/; }"
  exit 1
fi
echo "::endgroup::"

echo "::group::Browser host start latency"
# Inside the idle after-image container: start the host, wait for its status
# line, stop it, $start_runs times on one persisted profile.
tmp_before_kib="$(docker exec "$host_container" du -sk /tmp | cut -f1)"
# shellcheck disable=SC2016 # Expanded inside the container.
host_script='set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
host_env=(
  PATH="$PATH"
  INSTAFY_BROWSER_HOST_HOME=/var/lib/instafy-browser-cost/home
  INSTAFY_BROWSER_HOST_PROFILE_DIR=/var/lib/instafy-browser-cost/profile
  INSTAFY_BROWSER_HOST_STATE_DIR=/tmp/instafy-browser-cost/state
  INSTAFY_BROWSER_HOST_DISPLAY=:47
  INSTAFY_BROWSER_HOST_CDP_PORT=19223
  INSTAFY_BROWSER_HOST_VNC_PORT=15900
  INSTAFY_BROWSER_HOST_EGRESS_PORT=19226
  INSTAFY_BROWSER_HOST_WEBRTC_PORT=19225
  INSTAFY_BROWSER_WEBRTC_ENABLED=1
  INSTAFY_BROWSER_WEBRTC_REQUIRE_TURN=1
  INSTAFY_BROWSER_VIEWPORT_ONLY=1
  INSTAFY_VNC_GEOMETRY=1280x720
  INSTAFY_BROWSER_RENDER_SCALE=2
)
now_ms() { local now="${EPOCHREALTIME/./}"; printf "%s" "$(( 10#${now} / 1000 ))"; }
start_host() {
  : > /tmp/browser-cost-host.out
  env -i "${host_env[@]}" bash /usr/local/bin/runtime-entrypoint start-browser-host \
    >/tmp/browser-cost-host.out 2>>/tmp/browser-cost-host.err &
  host_pid=$!
}
await_status() {
  local line=""
  for _ in $(seq 1 1200); do
    line="$(grep -m1 "^instafy-browser-host: " /tmp/browser-cost-host.out 2>/dev/null || true)"
    if [ -n "$line" ]; then printf "%s" "$line"; return 0; fi
    sleep 0.05
  done
  printf "%s" "timeout"
}
stop_host() {
  kill -TERM "$host_pid" 2>/dev/null || true
  wait "$host_pid" 2>/dev/null || true
}
for run in $(seq 1 "$1"); do
  started="$(now_ms)"
  start_host
  status="$(await_status)"
  elapsed="$(( $(now_ms) - started ))"
  case "$status" in
    "instafy-browser-host: ready "*) echo "run $run $elapsed" ;;
    *) echo "fail $run $status"; tail -n 20 /tmp/browser-cost-host.err >&2; stop_host; exit 1 ;;
  esac
  if [ "$run" -lt "$1" ] || [ "${2:-stop}" = "stop" ]; then stop_host; fi
done
if [ "${2:-stop}" = "keep" ]; then
  echo "$host_pid" > /tmp/browser-cost-host.pid
  disown "$host_pid" 2>/dev/null || true
fi'
start_output="$(docker exec "$host_container" bash -c "$host_script" bash "$start_runs" stop)"
echo "$start_output"
if grep -q '^fail ' <<<"$start_output"; then
  echo "::error::The browser host failed to start during the latency runs."
  exit 1
fi
mapfile -t start_ms < <(awk '$1 == "run" { print $3 }' <<<"$start_output")
start_runs_json="$(json_array "${start_ms[@]}")"
echo "::endgroup::"

echo "::group::Memory with the browser open"
# One more start that stays up for the memory, fixture and screencast checks.
docker exec -d "$host_container" bash -c "$host_script" bash 1 keep
deadline=$((SECONDS + 120))
until docker exec "$host_container" test -s /tmp/browser-cost-host.pid 2>/dev/null; do
  (( SECONDS < deadline )) || { echo "::error::The browser host did not start for the memory checks."; exit 1; }
  sleep 0.5
done
sleep 5
blank_bytes="$(container_memory "$host_container")"
echo "about:blank: $blank_bytes bytes"

# Pages from data: URLs, so nothing depends on the network: a dense
# 5,000-row table like an accounting list, and an animated canvas that also
# drives the screencast. The markup avoids "%" and "#", which a data: URL would
# read as an escape or a fragment.
table_page='data:text/html,<!doctype html><title>table</title><style>body{font:12px sans-serif}td{padding:2px 6px;border-bottom:1px solid rgb(221,221,221)}</style><table id=t></table><script>const t=document.getElementById("t");for(let r=0;r<5000;r++){const row=t.insertRow();for(let c=0;c<8;c++){const v=r*31+c*17;row.insertCell().textContent=c===0?"INV-"+(100000+r):String((v-Math.floor(v/9973)*9973)/100);}}</script>'
canvas_page='data:text/html,<!doctype html><title>canvas</title><style>html,body{margin:0;height:100vh}</style><canvas id=c></canvas><script>const c=document.getElementById("c");const x=c.getContext("2d");const m=(a,b)=>a-Math.floor(a/b)*b;function f(t){c.width=innerWidth;c.height=innerHeight;for(let i=0;i<200;i++){x.fillStyle="rgb("+m(i*7+t/10,256)+","+m(i*13,256)+","+m(t/3,256)+")";x.fillRect(m(i*53+t/5,c.width),m(i*37+t/7,c.height),40,40);}requestAnimationFrame(f);}requestAnimationFrame(f);</script>'
open_page() {
  local encoded
  encoded="$(node -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$1")"
  docker exec "$host_container" curl --noproxy '*' -fsS --max-time 10 -X PUT \
    "http://127.0.0.1:19223/json/new?${encoded}" >/dev/null
}
open_page "$table_page"
sleep 10
table_bytes="$(container_memory "$host_container")"
echo "dense table: $table_bytes bytes"
open_page "$canvas_page"
sleep 10
canvas_bytes="$(container_memory "$host_container")"
echo "canvas: $canvas_bytes bytes"
echo "::endgroup::"

echo "::group::CPU during CDP screencast"
# The browser host's own Node and Playwright attach over CDP and acknowledge
# every frame of the canvas page, as Studio's screencast viewer does. The
# container's CPU includes that client.
# shellcheck disable=SC2016 # Evaluated by Node inside the container.
screencast_script='
const fs = require("node:fs");
const root = fs.existsSync("/opt/instafy/browser-host/node_modules/playwright")
  ? "/opt/instafy/browser-host/node_modules/playwright"
  : require("node:child_process").execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim() + "/playwright";
const { chromium } = require(root);
const seconds = Number(process.argv[1]);
(async () => {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:19223");
  let page;
  for (const candidate of browser.contexts()[0].pages()) {
    if ((await candidate.title()) === "canvas") page = candidate;
  }
  if (!page) throw new Error("canvas page not found");
  const session = await page.context().newCDPSession(page);
  let frames = 0;
  session.on("Page.screencastFrame", (frame) => {
    frames += 1;
    session.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
  });
  await session.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 720 });
  const cpu = () => Number(/usage_usec (\d+)/.exec(fs.readFileSync("/sys/fs/cgroup/cpu.stat", "utf8"))[1]);
  const startCpu = cpu();
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  const cores = (cpu() - startCpu) / ((Date.now() - started) * 1000);
  await session.send("Page.stopScreencast");
  console.log(JSON.stringify({ cores, frames, seconds }));
  await browser.close().catch(() => {});
  process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
'
node_binary=/opt/instafy/browser-host/bin/node
docker exec "$host_container" test -x "$node_binary" || node_binary=node
screencast_json="$(docker exec "$host_container" "$node_binary" -e "$screencast_script" "$screencast_seconds" | tail -n 1)"
echo "$screencast_json"
echo "::endgroup::"

docker exec "$host_container" sh -c 'kill -TERM "$(cat /tmp/browser-cost-host.pid)"' || true
sleep 5
tmp_after_kib="$(docker exec "$host_container" du -sk /tmp | cut -f1)"
profile_kib="$(docker exec "$host_container" du -sk /var/lib/instafy-browser-cost/profile | cut -f1)"

cat > "$measurements" <<JSON
{
  "schemaVersion": 1,
  "beforeImage": $(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$before_image"),
  "afterImage": $(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$after_image"),
  "imageBytes": { "before": ${size[before]}, "after": ${size[after]} },
  "coldPullMs": { "before": ${pull_ms[before]}, "after": ${pull_ms[after]} },
  "bootMs": { "before": ${boot_runs_ms[before]}, "after": ${boot_runs_ms[after]} },
  "idleSeconds": ${idle_seconds},
  "idleMemoryBytes": { "before": ${idle_bytes[before]}, "after": ${idle_bytes[after]} },
  "hostStartMs": ${start_runs_json},
  "memoryBytes": { "aboutBlank": ${blank_bytes}, "denseTable": ${table_bytes}, "canvas": ${canvas_bytes} },
  "screencast": ${screencast_json},
  "tmpKib": { "before": ${tmp_before_kib}, "after": ${tmp_after_kib} },
  "profileKib": ${profile_kib}
}
JSON

node "$repository_root/scripts/runtime-browser-cost.mjs" "$measurements" \
  "$repository_root/docs/Runtime-Image-Builds.md" "$output_dir"
