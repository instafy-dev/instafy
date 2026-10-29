import assert from "node:assert/strict";

const count = (source, text) => source.split(text).length - 1;
function replaceExactly(source, from, to) {
  assert.equal(count(source, from), 1, `expected exactly once: ${from.trim().slice(0, 80)}`);
  return source.replace(from, () => to);
}

// The required Browser UI rendering check became an aggregate of two parts,
// each running half of the component cases with Playwright's --shard. These
// builders state the reviewed split as a function of the former single job.
export const BROWSER_UI_PARTS = 2;
const aggregateIf = "    if: ${{ always() && !(github.repository == 'instafy-dev/instafy' && github.event_name == 'push' && github.ref == 'refs/heads/main' && github.ref_protected == true && cancelled()) }}\n";
const cobrowsing = [
  "      - name: Prove isolated co-browsing fixture boundaries",
  "        run: node --test scripts/shared-browser-cobrowsing-e2e.test.mjs",
  "      - name: Exercise routine approval and human-input handoff in real Chromium",
  "        run: node scripts/shared-browser-cobrowsing-e2e.mjs",
  "",
].join("\n");
const cobrowsingResults = "            packages/frontend/test-results/browser-ci/shared-cobrowsing\n";
const browserTools = "for (const tool of ['bash', 'git', 'curl', 'tar', 'unzip', 'sudo', 'apt-get', 'xvfb-run', 'Xvfb', 'xauth'])";
const aggregateTools = "for (const tool of ['bash', 'git'])";
const aggregateSteps = [
  "      - name: Require both Browser UI parts to succeed",
  "        env:",
  "          BROWSER_UI_RESULTS: ${{ toJSON(needs) }}",
  "        shell: bash",
  "        run: |",
  "          node <<'NODE'",
  "          const assert = require('node:assert/strict');",
  "          const expected = ['browser-ui-1', 'browser-ui-2'];",
  "          const results = JSON.parse(process.env.BROWSER_UI_RESULTS);",
  "          assert.ok(results && typeof results === 'object' && !Array.isArray(results));",
  "          assert.deepEqual(Object.keys(results).sort(), expected.sort());",
  "          for (const key of expected) assert.equal(results[key].result, 'success', key + ' must succeed');",
  "          NODE",
  "      - name: Checkout the tested revision",
  "        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
  "        with:",
  "          persist-credentials: false",
  "      - name: Download both parts' results",
  "        uses: actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1",
  "        with:",
  "          pattern: browser-ui-rendering-*",
  "          path: ${{ runner.temp }}/browser-ui-parts",
  "      - name: Require every required case across both parts",
  "        run: node packages/frontend/scripts/required-browser-parts.mjs browser-ui \"$RUNNER_TEMP/browser-ui-parts\"",
  "",
].join("\n");

/** Part `part` of the split, built from the former single Browser UI job. */
export function browserUiPartJob(job, part) {
  let text = replaceExactly(job, "    name: Browser UI rendering\n", `    name: Browser UI rendering (${part} of ${BROWSER_UI_PARTS})\n`);
  // The PR/push route and, before manual routing is removed, the manual route.
  assert.ok(count(text, '-public-browser-ui",') >= 1);
  text = text.replaceAll('-public-browser-ui",', `-public-browser-ui-${part}",`);
  text = replaceExactly(text, "        run: pnpm test:browser:ci browser-ui\n",
    `        run: pnpm test:browser:ci browser-ui --shard=${part}/${BROWSER_UI_PARTS}\n`);
  text = replaceExactly(text, "          name: browser-ui-rendering\n", `          name: browser-ui-rendering-${part}\n`);
  // Only the first part runs the co-browsing protocol fixture and keeps its results.
  if (part !== 1) text = replaceExactly(replaceExactly(text, cobrowsing, ""), cobrowsingResults, "");
  return text;
}

/** The required aggregate, built from the former single Browser UI job. */
export function browserUiAggregateJob(job) {
  const runsOn = job.match(/^    runs-on: >-\n(?:      .*\n)+/mu)?.[0];
  const qualify = job.match(/^      - name: Qualify isolated browser CI runner\n[\s\S]*?^          NODE\n/mu)?.[0];
  assert.ok(runsOn && qualify);
  const needs = Array.from({ length: BROWSER_UI_PARTS }, (_, index) => `      - browser-ui-${index + 1}\n`).join("");
  return `    name: Browser UI rendering\n    needs:\n${needs}${aggregateIf}${runsOn}    timeout-minutes: 5\n    steps:\n`
    + replaceExactly(qualify, browserTools, aggregateTools) + aggregateSteps;
}

// Test-only inverse of the split: proves the aggregate and both parts are
// exactly the builders' output for one former job, then restores that job.
export function withoutBrowserUiParts(file, source) {
  if (file !== "browser-e2e.yml") return source;
  const markers = ["browser-ui", ...Array.from({ length: BROWSER_UI_PARTS }, (_, index) => `browser-ui-${index + 1}`)]
    .map((key) => `\n  ${key}:\n`);
  for (const marker of markers) assert.equal(count(source, marker), 1, `exactly one ${marker.trim()} job must remain`);
  const blocks = [];
  let region = "", cursor = source.slice(source.indexOf(markers[0]));
  for (const marker of markers) {
    assert.ok(cursor.startsWith(marker), "the aggregate and its parts must stay adjacent and in order");
    const body = cursor.slice(marker.length).split(/\n  [\w-]+:\n/u)[0];
    blocks.push(body);
    region += marker + body;
    cursor = cursor.slice(marker.length + body.length);
  }
  let job = replaceExactly(blocks[1], `    name: Browser UI rendering (1 of ${BROWSER_UI_PARTS})\n`, "    name: Browser UI rendering\n");
  job = job.replaceAll('-public-browser-ui-1",', '-public-browser-ui",');
  job = replaceExactly(job, `        run: pnpm test:browser:ci browser-ui --shard=1/${BROWSER_UI_PARTS}\n`, "        run: pnpm test:browser:ci browser-ui\n");
  job = replaceExactly(job, "          name: browser-ui-rendering-1\n", "          name: browser-ui-rendering\n");
  const expected = markers[0] + browserUiAggregateJob(job)
    + markers.slice(1).map((marker, index) => marker + browserUiPartJob(job, index + 1)).join("");
  assert.equal(region, expected, "the Browser UI split must be exactly the reviewed aggregate and its parts");
  return source.replace(region, () => markers[0] + job);
}

// Test-only inverse for historical whole-workflow hashes. Current workflow
// contracts assert the 40-minute job and 30-minute suite budgets directly.
// The later split into two parts is reversed first, exactly.
export function withoutBrowserUiJobBudget(file, source) {
  if (file !== "browser-e2e.yml") return source;
  source = withoutBrowserUiParts(file, source);
  const marker = "\n  browser-ui:\n";
  const parts = source.split(marker);
  assert.equal(parts.length, 2, "exactly one Browser UI job must remain");
  const job = parts[1].split(/\n  [\w-]+:\n/u)[0];
  assert.deepEqual(job.match(/^    timeout-minutes: .*$/gmu),
    ["    timeout-minutes: 40"], "Browser UI must retain its reviewed 40-minute budget");
  return source.replace(marker + job,
    marker + job.replace("    timeout-minutes: 40", "    timeout-minutes: 30"));
}
