import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment, policyScriptNames } from "./shared-browser-cobrowsing-e2e.mjs";

// Real-browser proof that one Shared Browser step has one time limit: the
// production controller script, composed as runtime-agent composes it, drives
// a real Chromium over CDP against a loopback fixture site. A search whose
// results page keeps the page busy for a minute answers once the step's time
// is up, with the page as it is, instead of waiting for the page; a prompt the
// person answers after more than the step's time is never cut short. No model,
// Studio, controller, account or external site is used, and Chromium resolves
// no other host.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendRequire = createRequire(path.join(repositoryRoot, "packages/frontend/package.json"));
const playwrightRequire = createRequire(frontendRequire.resolve("@playwright/test"));
const { chromium } = playwrightRequire("playwright");
const playwrightDirectory = fs.realpathSync(path.dirname(playwrightRequire.resolve("playwright/package.json")));
const executablePath = chromium.executablePath();
// Retained with the co-browsing fixture's results, whose CI step runs this one.
const resultDirectory = path.join(repositoryRoot, "packages/frontend/test-results/browser-ci/shared-cobrowsing");
const resultFile = path.join(resultDirectory, "step-time-result.json");
const policyScript = (name) => `(function (module, require) {\n${
  fs.readFileSync(path.join(repositoryRoot, "packages/browser-action-policy", name), "utf8")
}\n})(undefined, undefined);`;
// The web-research skill's link-only list, embedded the way runtime-agent's
// embedded_link_only_sites() embeds it.
const linkOnlySites = fs.readFileSync(
  path.join(repositoryRoot, "packages/runtime-agent/assets/instafy/.agents/skills/instafy-web-research/references/link-only-sites.json"),
  "utf8",
);
const scriptSource = [
  ...policyScriptNames.map(policyScript),
  `globalThis.__instafyLinkOnlySites = ${linkOnlySites};`,
  ...["shared-browser-approval.js", "shared-browser-cli.js"]
    .map((name) => fs.readFileSync(path.join(repositoryRoot, "packages/runtime-agent/assets", name), "utf8")),
].join("\n");

// The controller's step time (STEP_TIME_MS) and the most its late read of the
// page may add (LATE_READ_MS).
const STEP_TIME_MS = 20_000;
const LATE_READ_MS = 8_000;
// How long the results page keeps its page busy: far longer than a step.
const BUSY_MS = 60_000;
// How long the person takes to answer a prompt: longer than a step's time.
const SLOW_ANSWER_MS = 23_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeProtectedJson(destination, value) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, destination);
}

const page = (title, body, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'${script ? "; script-src 'unsafe-inline'" : ""}">
<title>${title}</title></head><body><h1>${title}</h1>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

// A site's own search, and a results page that, once it has loaded, keeps its
// page busy for BUSY_MS: what a heavy page script does to every read of it.
const SEARCH = `<form action="/results" method="get" role="search"><input type="search" name="q" aria-label="Search places"><button>Search</button></form>`;
const RESULTS = "<p>Results for your search.</p><p><a href=\"/places/tower\">The tower</a></p>";
const BUSY = `setTimeout(() => { const end = Date.now() + ${BUSY_MS}; while (Date.now() < end) {} }, 100);`;

export async function runSharedBrowserStepTimeFixture() {
  assert.ok(fs.existsSync(executablePath), "Locked Playwright Chromium is missing; run pnpm --filter @instafy/frontend exec playwright install chromium");
  fs.mkdirSync(resultDirectory, { recursive: true });
  fs.rmSync(resultFile, { force: true });
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instafy-step-time-e2e-")));
  const profileDirectory = path.join(temporary, "profile");
  const approvalDirectory = path.join(temporary, "approvals");
  const markerPath = path.join(temporary, "agent-control.json");
  const actionsPath = path.join(temporary, "actions.jsonl");
  fs.mkdirSync(approvalDirectory, { mode: 0o700 });
  const environment = fixtureEnvironment(process.env, temporary);
  const children = new Set();
  let server;
  let context;
  try {
    const requests = [];
    server = createServer((request, response) => {
      const url = new URL(request.url, "http://fixture.invalid");
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      const body = { "/": [page("Places", SEARCH)], "/results": [page("Results", RESULTS, BUSY)], "/places/tower": [page("The tower", "<p>Open daily.</p>")] }[url.pathname];
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(body[0]);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    // A public name, as a site's own search is free only on a public site.
    const origin = `http://places.test:${server.address().port}`;

    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath,
      headless: true,
      viewport: { width: 1000, height: 800 },
      env: environment,
      // No host but the loopback fixture resolves, so nothing leaves the machine.
      args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--host-resolver-rules=MAP places.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    const runPage = context.pages()[0];
    await runPage.goto(`${origin}/`);
    const session = await context.newCDPSession(runPage);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    const runPageId = targetInfo.targetId;
    let port;
    for (let attempt = 0; attempt < 200 && !port; attempt += 1) {
      try {
        port = Number(fs.readFileSync(path.join(profileDirectory, "DevToolsActivePort"), "utf8").split("\n")[0]);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await delay(25);
      }
    }
    assert.ok(Number.isInteger(port) && port > 0, "Chromium did not expose its loopback CDP port");
    const authority = {
      version: 2, ownerId: randomUUID(), runId: randomUUID(),
      initiatorUserId: "00000000-0000-4000-8000-000000000005",
      browserPageId: runPageId, displayName: "Fixture assistant", expiresAtMs: Date.now() + 600_000,
    };
    writeProtectedJson(markerPath, authority);

    const prompts = [];
    // `answerAfterMs`: how long the person takes to answer each prompt.
    async function runTool(method, requestPath, body = null, decisions = [], { answerAfterMs = 0 } = {}) {
      const started = performance.now();
      const child = spawn(process.execPath, ["-", method, requestPath, ...(body ? [JSON.stringify(body)] : [])], {
        cwd: temporary,
        env: {
          ...environment,
          INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: playwrightDirectory,
          INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT: path.dirname(playwrightDirectory),
          INSTAFY_SHARED_BROWSER_PAGE_ID: runPageId,
          INSTAFY_PLAYWRIGHT_CDP_URL: `http://127.0.0.1:${port}`,
          INSTAFY_BROWSER_AGENT_CONTROL_FILE: markerPath,
          INSTAFY_SHARED_BROWSER_APPROVAL_DIR: approvalDirectory,
          // Long enough for the slow answer below.
          INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS: "60000",
          INSTAFY_BROWSER_ACTIONS_FILE: actionsPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      child.stdin.on("error", () => {});
      child.stdin.end(scriptSource);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const seen = new Set();
      let failure;
      const answering = setInterval(() => {
        try {
          const request = JSON.parse(fs.readFileSync(path.join(approvalDirectory, "request.json"), "utf8"));
          if (seen.has(request.approvalId)) return;
          seen.add(request.approvalId);
          prompts.push(request);
          const decision = decisions[seen.size - 1];
          assert.ok(decision, `Unexpected prompt during ${requestPath}: ${request.display?.label}`);
          setTimeout(() => {
            try {
              writeProtectedJson(path.join(approvalDirectory, "decision.json"), {
                version: 1, approvalId: request.approvalId, requestFingerprint: request.requestFingerprint,
                decision, decidedByUserId: authority.initiatorUserId,
                decidedAtMs: Date.now(), expiresAtMs: request.expiresAtMs,
              });
            } catch (error) {
              failure = error;
              child.kill("SIGKILL");
            }
          }, answerAfterMs);
        } catch (error) {
          if (error.code === "ENOENT" || error instanceof SyntaxError) return;
          failure = error;
          child.kill("SIGKILL");
        }
      }, 10);
      // Well past one step's time and its late read, and well short of the
      // busy page's minute.
      const timeout = setTimeout(() => {
        failure = new Error(`Fixture tool timed out: ${requestPath}`);
        child.kill("SIGKILL");
      }, Math.max(STEP_TIME_MS + LATE_READ_MS + 12_000, answerAfterMs + STEP_TIME_MS + 10_000));
      try {
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        if (failure) throw failure;
        return { code, stdout, stderr, wallMs: performance.now() - started, payload: code === 0 ? JSON.parse(stdout) : null };
      } finally {
        clearInterval(answering);
        clearTimeout(timeout);
        children.delete(child);
      }
    }
    const ok = async (...args) => {
      const result = await runTool(...args);
      assert.equal(result.code, 0, `${args[1]} failed: ${result.stderr}`);
      return result;
    };

    // 1. A prompt the person answers after more than a step's time: the step
    // waits for the answer, then reads the page as usual. Its time stopped
    // while the prompt waited.
    const slow = await ok("GET", "/v1/snapshot", null, ["allow_routine"], { answerAfterMs: SLOW_ANSWER_MS });
    assert.equal(prompts.length, 1, "The site asked once");
    assert.ok(slow.wallMs >= SLOW_ANSWER_MS, `The step waited for the answer (${Math.round(slow.wallMs)} ms)`);
    assert.equal(slow.payload.stepTimedOut, undefined, "A step waiting for the person is not cut short");
    assert.equal(slow.payload.url, `${origin}/`);
    const field = slow.payload.interactiveElements.find((element) => element.label === "Search places");
    assert.ok(field, "The search box is observed");

    // 2. The site's own search, whose results page then keeps the page busy:
    // the step answers once its time is up, with the page as it is, and says
    // so. It never waits out the busy page.
    requests.length = 0;
    const searched = await ok("POST", "/v1/type", { index: field.index, snapshotId: slow.payload.snapshotId, text: "tower", submit: true });
    assert.deepEqual(requests, ["GET /results?q=tower"], "The search was sent once, as the form makes it");
    assert.ok(searched.wallMs >= STEP_TIME_MS - 1_000, `It answered when its time was up (${Math.round(searched.wallMs)} ms)`);
    assert.ok(searched.wallMs < STEP_TIME_MS + LATE_READ_MS + 10_000, `It did not wait for the busy page (${Math.round(searched.wallMs)} ms)`);
    assert.equal(searched.payload.stepTimedOut, true);
    assert.equal(searched.payload.url, `${origin}/results?q=tower`, "The page as it is: the results");
    assert.match(searched.payload.message, /This step was still running after 20 seconds, so it stopped where it was\. This is the page as it is now: check what the step did before you act again\./);
    // A page too busy to be read lists no controls, so no action can use it.
    assert.deepEqual(searched.payload.interactiveElements, []);
    assert.equal(searched.payload.visibleText, "");
    // Its line says the page was read, not that the step did anything new.
    assert.deepEqual(searched.payload.activity, { step: "snapshot", url: `${origin}/results?q=tower` });
    assert.equal(prompts.length, 1, "Nothing asked during the search");

    const result = {
      status: "passed",
      fixtureVersion: 1,
      checks: [
        "a prompt answered after more than a step's time is waited for, and the step then reads the page as usual",
        "a search whose results page keeps the page busy answers once the step's time is up, with the page's address and a note, never waiting out the page",
      ],
      timings: { slowAnswerMs: Math.round(slow.wallMs), busySearchMs: Math.round(searched.wallMs) },
      limitations: ["No model, Studio UI, origin or runtime shutdown guard; those are unit-tested."],
    };
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await context?.close().catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/shared-browser-step-time-e2e.mjs (no filters or skips)");
  runSharedBrowserStepTimeFixture().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    fs.mkdirSync(resultDirectory, { recursive: true });
    fs.writeFileSync(resultFile, `${JSON.stringify({ status: "failed", fixtureVersion: 1 })}\n`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
