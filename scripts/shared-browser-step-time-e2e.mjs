import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
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
// person answers after more than the step's time is never cut short. A step
// whose time runs out still ends as every step ends: a window it opened is
// closed and said, and a hand-off it had not finished is never left behind. A
// load of a site that does not answer in time, opened from a blank tab or from
// a page that had loaded, by a navigation or a link, is stopped once the step
// stops waiting for it and fails as one that opened nothing and names where to
// go next, never as a blank page to navigate again nor as the page the tab
// still shows; the next step reaches the browser at once, and the site's late
// answer never loads. A form sent to such a site has reached it, so its load
// runs on and the step never says nothing was opened. A page with a few
// hundred controls is described in one call to the page each time a step
// reads it, not in one call per control. No model, Studio, controller, account
// or external site is used, and Chromium resolves no other host.
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
// How long a click keeps the page busy after it opened a window: longer than
// a step's time and its late read, so the step answers before the page frees.
const WINDOW_BUSY_MS = 32_000;
// How long a form keeps the page busy once a field is highlighted: longer than
// a step's time, shorter than the step's time and its late read.
const FORM_BUSY_MS = 24_000;

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
// A button that opens another window, then keeps the page busy; once free, the
// page sends that window somewhere else.
const WINDOW = `<button id="open" type="button">Open details</button>`;
const OPENS_WINDOW = `document.getElementById("open").addEventListener("click", () => {
  const opened = window.open("/popup");
  const end = Date.now() + ${WINDOW_BUSY_MS}; while (Date.now() < end) {}
  try { opened.location = "/popup?later=1"; } catch (_) {}
});`;
// A page that keeps changing its own address, as a page's script does when it
// follows what it shows.
const LIVE = `let shown = 0; setInterval(() => history.replaceState(null, "", "?shown=" + (shown += 1)), 200);`;
// A page that has loaded but shows nothing yet: its content stays hidden, as a
// page's does while its script still builds it.
const HIDDEN = `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Opening hours</title><style>body { visibility: hidden; }</style></head>
<body><h1>Opening hours</h1><p>Open daily from 9 to 17.</p><a href="/places/tower">The tower</a></body></html>`;
const BUSY_MESSAGE = "The page is still busy, so it could not be read yet. Take a snapshot in a moment.";
// What a load answers whose site sent nothing back before the step stopped
// waiting for it, from a blank tab and from a page that had loaded: nothing was
// opened, and Octo goes to the next source in the same turn.
const NEXT_SOURCE = "Open the place's own site now (the venue's or the operator's), or another official source if this was it.";
const UNANSWERED_MESSAGE = `The site did not answer in time, so nothing was opened and the page is still blank. ${NEXT_SOURCE}`;
const UNANSWERED_LOADED_MESSAGE = `The site did not answer in time, so nothing was opened and the tab still shows the page it showed before. ${NEXT_SOURCE}`;
// How long a step whose site did not answer may take past its time: stopping
// the load and ending its guards, never a read of the page while it waits.
const UNANSWERED_ANSWER_MS = 5_000;
// How long a click waits for the page it opens (the controller's action
// timeout), which may end before the step's time does.
const CLICK_WAIT_MS = 15_000;
// A form whose script does heavy work once one of its fields is highlighted.
const FORM = `<form><label>Your name <input name="name"></label><label>Your city <input name="city"></label></form>`;
// A transport operator's page: menus of links that open on hover, timetables
// with links and buttons, a footer of links, and the journey planner's two
// lists and its button. Over 500 controls, about 230 of them shown.
const STATIONS = Array.from({ length: 80 }, (_, n) => ["Trindade", "São Bento", "Aliados"][n] ?? `Station ${n + 1}`);
const MENUS = Array.from({ length: 12 }, (_, m) => `<li><button type="button" aria-expanded="false">Menu ${m + 1}</button><ul hidden>${
  Array.from({ length: 25 }, (_, l) => `<li><a href="/pages/${m}/${l}">Page ${m + 1}.${l + 1}</a></li>`).join("")}</ul></li>`).join("");
const PLANNER = `<nav><ul>${MENUS}</ul></nav>
<form action="/route"><label>Start <select name="from">${STATIONS.map((name) => `<option>${name}</option>`).join("")}</select></label>
<label>End <select name="to">${STATIONS.map((name) => `<option>${name}</option>`).join("")}</select></label>
<input type="button" value="Plan journey"></form>
${Array.from({ length: 60 }, (_, n) => `<p>Line ${n + 1}: every 6 minutes. <a href="/lines/${n}">Line ${n + 1}</a> <button type="button">Share line ${n + 1}</button></p>`).join("")}
<footer>${Array.from({ length: 100 }, (_, n) => `<a href="/about/${n}">About ${n + 1}</a>`).join(" ")}</footer>`;
// What carries the controller's control describer to the page: its source.
const DESCRIBER_SOURCE = "function describeInPage(";

// A pass-through to Chromium's DevTools socket that counts the messages that
// carry the describer to the page. It asks for no compression of the socket,
// reads the controller's frames unmasked (RFC 6455 §5.3), and passes every
// byte after the opening request on unchanged.
async function describerCountingSocket(browserSocketUrl) {
  const target = new URL(browserSocketUrl);
  let sent = 0;
  const sockets = new Set();
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port), target.hostname);
    sockets.add(client).add(upstream);
    let pending = Buffer.alloc(0);
    let upgraded = false;
    let parts = [];
    client.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (!upgraded) {
        const end = pending.indexOf("\r\n\r\n");
        if (end < 0) return;
        upgraded = true;
        const request = pending.subarray(0, end + 4).toString("latin1")
          .split("\r\n").filter((line) => !/^sec-websocket-extensions:/iu.test(line)).join("\r\n");
        pending = pending.subarray(end + 4);
        upstream.write(Buffer.from(request, "latin1"));
        upstream.write(pending);
      } else {
        upstream.write(chunk);
      }
      for (;;) {
        if (pending.length < 2) return;
        let length = pending[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (pending.length < 4) return;
          length = pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (pending.length < 10) return;
          length = Number(pending.readBigUInt64BE(2));
          offset = 10;
        }
        const masked = (pending[1] & 0x80) !== 0;
        const mask = offset;
        if (masked) offset += 4;
        if (pending.length < offset + length) return;
        const payload = Buffer.from(pending.subarray(offset, offset + length));
        if (masked) for (let index = 0; index < payload.length; index += 1) payload[index] ^= pending[mask + (index % 4)];
        const final = (pending[0] & 0x80) !== 0;
        const control = (pending[0] & 0x0f) >= 0x8;
        pending = pending.subarray(offset + length);
        if (control) continue;
        parts.push(payload);
        if (final) {
          if (Buffer.concat(parts).toString("utf8").includes(DESCRIBER_SOURCE)) sent += 1;
          parts = [];
        }
      }
    });
    upstream.on("data", (chunk) => client.write(chunk));
    const close = () => { client.destroy(); upstream.destroy(); };
    for (const socket of [client, upstream]) {
      socket.on("close", close);
      socket.on("error", close);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = new URL(browserSocketUrl);
  url.port = String(server.address().port);
  return {
    url: url.toString(),
    sent: () => sent,
    reset: () => { sent = 0; },
    close: () => new Promise((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(resolve);
    }),
  };
}

const BUSY_ON_HIGHLIGHT = `let busy = false;
new MutationObserver(() => {
  if (busy || !document.querySelector("input[style*=outline]")) return;
  busy = true;
  setTimeout(() => { const end = Date.now() + ${FORM_BUSY_MS}; while (Date.now() < end) {} }, 0);
}).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["style"] });`;

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
  // Answers of the site that does not answer in time, held until the case ends.
  const unanswered = [];
  try {
    const requests = [];
    server = createServer((request, response) => {
      const url = new URL(request.url, "http://fixture.invalid");
      requests.push(`${request.method} ${url.pathname}${url.search}`);
      if (url.pathname === "/slow") {
        unanswered.push(response);
        return;
      }
      const body = {
        "/": [page("Places", SEARCH)], "/results": [page("Results", RESULTS, BUSY)], "/places/tower": [page("The tower", "<p>Open daily.</p>")],
        "/window": [page("Details", WINDOW, OPENS_WINDOW)], "/popup": [page("Popup", "<p>Another window.</p>")], "/form": [page("Your details", FORM, BUSY_ON_HIGHLIGHT)],
        "/hidden": [HIDDEN], "/places/live": [page("The tower", "<p>Open daily.</p>", LIVE)], "/planner": [page("Plan a journey", PLANNER)],
        "/visit": [page("Visiting", "<p><a href=\"/slow\">Opening hours</a></p>")],
        "/ask": [page("Ask us", "<form action=\"/slow\" method=\"post\"><label>Your question <input name=\"question\"></label><button>Send question</button></form>")],
      }[url.pathname];
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
    // `cdpUrl`: where the controller reaches the browser, when not its own address.
    async function runTool(method, requestPath, body = null, decisions = [], { answerAfterMs = 0, cdpUrl = null } = {}) {
      const started = performance.now();
      const child = spawn(process.execPath, ["-", method, requestPath, ...(body ? [JSON.stringify(body)] : [])], {
        cwd: temporary,
        env: {
          ...environment,
          INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: playwrightDirectory,
          INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT: path.dirname(playwrightDirectory),
          INSTAFY_SHARED_BROWSER_PAGE_ID: runPageId,
          INSTAFY_PLAYWRIGHT_CDP_URL: cdpUrl ?? `http://127.0.0.1:${port}`,
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
    assert.ok(slow.payload.interactiveElements.some((element) => element.label === "Search places"), "The search box is observed");
    const actions = () => fs.readFileSync(actionsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

    // 1a. A page with a few hundred controls: each read of it describes them
    // in one call to the page. One call per control sent the describer again
    // for every control: a choice on a journey planner took 12 s where a read
    // of the page took 6.5 s, as a choice or a click reads the page twice (its
    // check, then its result). Counted on the browser's own socket.
    await ok("POST", "/v1/navigate", { url: `${origin}/planner` });
    const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const counted = await describerCountingSocket(webSocketDebuggerUrl);
    let planner;
    let chose;
    try {
      planner = await ok("GET", "/v1/snapshot", null, [], { cdpUrl: counted.url });
      assert.equal(planner.payload.interactiveElements.length, 200, "The page's first 200 shown controls are observed");
      assert.ok(planner.payload.omittedControls > 250, `The hidden ones are counted (${planner.payload.omittedControls})`);
      assert.equal(counted.sent(), 1, `One read sent the describer once (${counted.sent()} times)`);
      const from = planner.payload.interactiveElements.find((element) => element.tag === "select" && element.chosen === "Trindade");
      assert.ok(from, "The first list is observed");
      counted.reset();
      chose = await ok("POST", "/v1/choose", { index: from.index, option: "São Bento", snapshotId: planner.payload.snapshotId }, [], { cdpUrl: counted.url });
      assert.equal(chose.payload.interactiveElements.find((element) => element.index === from.index)?.chosen, "São Bento");
      // Its check of the page, the chosen list itself, and its result.
      assert.ok(counted.sent() <= 3, `A choice sent the describer ${counted.sent()} times`);
    } finally {
      await counted.close();
    }
    assert.equal(prompts.length, 1, "Nothing asked on the planner");

    // 1b. A page that has loaded but shows no text and no controls yet: a read
    // of it says the page is still busy, never that the page is empty, and its
    // line says no page was read.
    const opened = await ok("POST", "/v1/navigate", { url: `${origin}/hidden` });
    const hidden = await ok("GET", "/v1/snapshot");
    for (const read of [opened.payload, hidden.payload]) {
      assert.equal(read.url, `${origin}/hidden`);
      assert.equal(read.message, BUSY_MESSAGE);
      assert.equal(read.visibleText, "");
      assert.equal(read.title, "", "A page that read as nothing gives no title to answer from");
      assert.deepEqual(read.interactiveElements, []);
    }
    assert.deepEqual(hidden.payload.activity, { step: "status", url: `${origin}/hidden` });

    // 1c. A navigation from a blank tab to a site that does not answer within
    // the step's time: when the time is up the tab still shows the blank page,
    // as a just-started browser does. A load still waiting for its first answer
    // keeps Instafy's browser from being reached by the next step, and would
    // land after the step ended, so the step stops it: it opened nothing, and
    // it fails (its line reads as a step tried) saying the site did not answer
    // and where to go next, never the blank page's "Call navigate", which sent
    // Octo to load the same site again.
    await runPage.goto("about:blank");
    requests.length = 0;
    const loading = await runTool("POST", "/v1/navigate", { url: `${origin}/slow` });
    assert.deepEqual(requests, ["GET /slow"], "The site was asked once");
    assert.equal(loading.code, 1, `The step fails: ${loading.stdout}`);
    assert.equal(loading.stdout, "", "A failed navigation answers with no page");
    assert.ok(loading.stderr.includes(UNANSWERED_MESSAGE), loading.stderr);
    assert.doesNotMatch(loading.stderr, /The page is blank|Call navigate|still busy|Check what the step did/u);
    // It answered when its time was up, and no later: it stops the load before
    // anything else, so its failure waits on no read of the page while the
    // load is pending.
    assert.ok(loading.wallMs >= STEP_TIME_MS - 1_000, `It answered when its time was up (${Math.round(loading.wallMs)} ms)`);
    assert.ok(loading.wallMs < STEP_TIME_MS + UNANSWERED_ANSWER_MS, `It answered without waiting on the pending load (${Math.round(loading.wallMs)} ms)`);
    assert.equal(prompts.length, 1, "Nothing asked during the navigation");
    // The next step reaches the browser at once, while the site still holds
    // its answer, and finds the blank page.
    const after = await ok("GET", "/v1/snapshot");
    assert.ok(after.wallMs < 5_000, `The next step reached the browser at once (${Math.round(after.wallMs)} ms)`);
    assert.equal(after.payload.url, "about:blank");
    assert.equal(after.payload.blank, true);
    // The site answers at last: nothing of it lands, so nothing was opened.
    for (const response of unanswered.splice(0)) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Opening hours", "<p>Open daily from 09:00 to 19:30.</p>"));
    }
    await delay(1_000);
    assert.equal(runPage.url(), "about:blank", "The late answer never loaded");
    const late = await ok("GET", "/v1/snapshot");
    assert.equal(late.payload.url, "about:blank");
    assert.equal(late.payload.visibleText, "");

    // 1d. The same from a page that had loaded, one that keeps changing its own
    // address as many do: when the time is up the tab still shows that page,
    // and the load waits behind it as it did behind the blank page. The step
    // stops it the same way and fails the same way: it answers with no page,
    // so neither its answer nor its line names the page the tab still shows
    // (Octo read "busy" for that page, then could not reach the browser, and the
    // site's error page landed after the turn). The next step reaches the
    // browser at once and finds that page, and the site's late answer never
    // lands.
    await ok("POST", "/v1/navigate", { url: `${origin}/places/live` });
    requests.length = 0;
    const actionsBefore = actions().length;
    const fromPage = await runTool("POST", "/v1/navigate", { url: `${origin}/slow` });
    assert.deepEqual(requests, ["GET /slow"], "The site was asked once");
    assert.equal(fromPage.code, 1, `The step fails: ${fromPage.stdout}`);
    assert.equal(fromPage.stdout, "", "A failed navigation answers with no page");
    assert.ok(fromPage.stderr.includes(UNANSWERED_LOADED_MESSAGE), fromPage.stderr);
    assert.doesNotMatch(fromPage.stderr, /The tower|places\/live|still busy|Check what the step did/u);
    assert.ok(fromPage.wallMs >= STEP_TIME_MS - 1_000, `It answered when its time was up (${Math.round(fromPage.wallMs)} ms)`);
    assert.ok(fromPage.wallMs < STEP_TIME_MS + UNANSWERED_ANSWER_MS, `It answered without waiting on the pending load (${Math.round(fromPage.wallMs)} ms)`);
    // What the view's line follows shows only the navigation the step started,
    // never the page the tab still shows as its result.
    assert.deepEqual(actions().slice(actionsBefore).map((action) => action.type), ["navigate"]);
    assert.equal(prompts.length, 1, "Nothing asked during the navigation");
    const stayed = await ok("GET", "/v1/snapshot");
    assert.ok(stayed.wallMs < 5_000, `The next step reached the browser at once (${Math.round(stayed.wallMs)} ms)`);
    assert.ok(stayed.payload.url.startsWith(`${origin}/places/live`), stayed.payload.url);
    for (const response of unanswered.splice(0)) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Opening hours", "<p>Open daily from 09:00 to 19:30.</p>"));
    }
    await delay(1_000);
    assert.ok(runPage.url().startsWith(`${origin}/places/live`), `The late answer never loaded: ${runPage.url()}`);

    // 1e. The same load, started by a link the step clicks on a page that had
    // loaded. A click waits for the page it opens for less than the step's time;
    // when that wait gives up with no answer from the site, the load is stopped
    // there and then, and the step fails as one that opened nothing, as a
    // navigation does: never "busy" for the page the tab still shows, nor the
    // click's own timeout. The next step reaches the browser at once, and the
    // site's late answer never lands.
    await ok("POST", "/v1/navigate", { url: `${origin}/visit` });
    const visit = await ok("GET", "/v1/snapshot");
    const hours = visit.payload.interactiveElements.find((element) => element.label === "Opening hours");
    assert.ok(hours, "The link is observed");
    requests.length = 0;
    const clickedFrom = actions().length;
    const followed = await runTool("POST", "/v1/click", { index: hours.index, snapshotId: visit.payload.snapshotId });
    const followedAt = Date.now();
    assert.deepEqual(requests, ["GET /slow"], "The site was asked once");
    assert.equal(followed.code, 1, `The step fails: ${followed.stdout}`);
    assert.equal(followed.stdout, "", "A failed click answers with no page");
    assert.ok(followed.stderr.includes(UNANSWERED_LOADED_MESSAGE), followed.stderr);
    assert.doesNotMatch(followed.stderr, /Visiting|\/visit|still busy|Check what the step did|Timeout|Call log/u);
    const click = actions().slice(clickedFrom);
    assert.deepEqual(click.map((action) => action.type), ["click"], "Only the click is on the log, never the page the tab still shows");
    // It answered once the click's own wait gave up (or the step's time ran
    // out first), without waiting out the step's time on a load already given up.
    assert.ok(followedAt - click[0].ts < CLICK_WAIT_MS + 2_000, `It answered when the click stopped waiting (${followedAt - click[0].ts} ms after the click)`);
    assert.ok(followed.wallMs < STEP_TIME_MS + UNANSWERED_ANSWER_MS, `It answered without waiting on the pending load (${Math.round(followed.wallMs)} ms)`);
    assert.equal(prompts.length, 1, "Nothing asked during the click");
    const remained = await ok("GET", "/v1/snapshot");
    assert.ok(remained.wallMs < 5_000, `The next step reached the browser at once (${Math.round(remained.wallMs)} ms)`);
    assert.equal(remained.payload.url, `${origin}/visit`);
    for (const response of unanswered.splice(0)) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Opening hours", "<p>Open daily from 09:00 to 19:30.</p>"));
    }
    await delay(1_000);
    assert.equal(runPage.url(), `${origin}/visit`, "The late answer never loaded");

    // 1f. A form the step sends to a site that does not answer: the form has
    // reached the site, so its load is left to run, and the step never says
    // nothing was opened. It answers once its time is up, as a step whose page
    // is still busy does, and says to check what the step did; the site's late
    // answer is the form's own, and lands as it did.
    await ok("POST", "/v1/navigate", { url: `${origin}/ask` });
    const ask = await ok("GET", "/v1/snapshot");
    const send = ask.payload.interactiveElements.find((element) => element.label === "Send question");
    assert.ok(send, "The form's button is observed");
    requests.length = 0;
    const promptsBeforeForm = prompts.length;
    const sent = await runTool("POST", "/v1/click", { index: send.index, snapshotId: ask.payload.snapshotId }, ["allow_once"]);
    assert.deepEqual(requests, ["POST /slow"], "The form was sent once");
    assert.equal(sent.code, 0, `The step answers with the page as it is: ${sent.stderr}`);
    assert.equal(sent.payload.stepTimedOut, true);
    assert.match(sent.payload.message, /what the step did before you act again\./u);
    assert.doesNotMatch(`${sent.stdout}${sent.stderr}`, /did not answer|nothing was opened/u);
    assert.equal(prompts.length, promptsBeforeForm + 1, "The form asked once");
    for (const response of unanswered.splice(0)) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page("Question received", "<p>Thank you.</p>"));
    }
    await delay(1_000);
    assert.equal(new URL(runPage.url()).pathname, "/slow", "The form's late answer landed");

    // 2. A click that opens another window and then keeps the page busy: the
    // step's time runs out, and it still ends as a step does. The window is
    // closed before it loads anything and the step says so, and once the page
    // is free it can send that window nowhere.
    await ok("POST", "/v1/navigate", { url: `${origin}/window` });
    const details = await ok("GET", "/v1/snapshot");
    const button = details.payload.interactiveElements.find((element) => element.label === "Open details");
    assert.ok(button, "The button is observed");
    requests.length = 0;
    const clicked = await runTool("POST", "/v1/click", { index: button.index, snapshotId: details.payload.snapshotId });
    const clickedAt = performance.now() - clicked.wallMs;
    assert.equal(clicked.code, 1, `The step fails as it would in its time: ${clicked.stdout}`);
    assert.match(clicked.stderr, /The step opened another window, which Octo never uses, so it was closed before it loaded anything\./);
    assert.ok(clicked.wallMs < STEP_TIME_MS + LATE_READ_MS + 10_000, `It did not wait for the busy page (${Math.round(clicked.wallMs)} ms)`);
    await delay(Math.max(0, clickedAt + WINDOW_BUSY_MS + 3_000 - performance.now()));
    assert.deepEqual(context.pages().map((open) => new URL(open.url()).pathname), ["/window"], "Only the run's page is left");
    assert.deepEqual(requests.filter((request) => request.includes("/popup")), [], "The window never loaded anything, then or later");

    // 3. A hand-off whose fields the page is too busy to highlight in time:
    // the step answers with the page as it is, and no hand-off is left behind
    // for the person once the page is free.
    await ok("POST", "/v1/navigate", { url: `${origin}/form` });
    const form = await ok("GET", "/v1/snapshot");
    const fields = form.payload.interactiveElements.filter((element) => /^Your (name|city)$/.test(element.label)).map((element) => element.index);
    assert.equal(fields.length, 2, "Both fields are observed");
    const handoff = await ok("POST", "/v1/request-human-input", { indices: fields, snapshotId: form.payload.snapshotId });
    assert.equal(handoff.payload.stepTimedOut, true);
    assert.ok(handoff.wallMs >= STEP_TIME_MS - 1_000, `It answered when its time was up (${Math.round(handoff.wallMs)} ms)`);
    await delay(1_000);
    assert.deepEqual(actions().filter((action) => action.type === "human_input"), [], "No hand-off after the step answered");

    // 4. Back to the site's own search.
    await ok("POST", "/v1/navigate", { url: `${origin}/` });
    const start = await ok("GET", "/v1/snapshot");
    const field = start.payload.interactiveElements.find((element) => element.label === "Search places");
    assert.ok(field, "The search box is observed");

    // 5. The site's own search, whose results page then keeps the page busy:
    // the step answers once its time is up, with the page as it is, and says
    // so. It never waits out the busy page.
    requests.length = 0;
    const promptsBeforeSearch = prompts.length;
    const searched = await ok("POST", "/v1/type", { index: field.index, snapshotId: start.payload.snapshotId, text: "tower", submit: true });
    assert.deepEqual(requests, ["GET /results?q=tower"], "The search was sent once, as the form makes it");
    assert.ok(searched.wallMs >= STEP_TIME_MS - 1_000, `It answered when its time was up (${Math.round(searched.wallMs)} ms)`);
    assert.ok(searched.wallMs < STEP_TIME_MS + LATE_READ_MS + 10_000, `It did not wait for the busy page (${Math.round(searched.wallMs)} ms)`);
    assert.equal(searched.payload.stepTimedOut, true);
    assert.equal(searched.payload.url, `${origin}/results?q=tower`, "The page as it is: the results");
    // Nothing could be read, so it is not "the page as it is now": the page is still busy.
    assert.equal(
      searched.payload.message,
      `${BUSY_MESSAGE} This step was still running after 20 seconds, so it stopped where it was. Check what the step did before you act again.`,
    );
    // A page too busy to be read lists no controls, so no action can use it.
    assert.deepEqual(searched.payload.interactiveElements, []);
    assert.equal(searched.payload.visibleText, "");
    // Nothing was read, so its line does not say a page was read: like status,
    // it names the page it is on.
    assert.deepEqual(searched.payload.activity, { step: "status", url: `${origin}/results?q=tower` });
    assert.equal(prompts.length, promptsBeforeSearch, "Nothing asked during the search");

    const result = {
      status: "passed",
      fixtureVersion: 1,
      checks: [
        "a prompt answered after more than a step's time is waited for, and the step then reads the page as usual",
        "a page with a few hundred controls is described in one call to the page each time a step reads it: once for a read, at most three times for a choice (its check, the list, its result)",
        "a loaded page that shows no text and no controls reads as still busy, not as an empty page, and its line says no page was read",
        "a navigation from a blank tab to a site that does not answer in time is stopped once the step's time is up and fails as one that opened nothing, naming where to go next, never as a blank page to navigate again; the next step reaches the browser at once, and the site's late answer never loads",
        "a navigation from a page that had loaded, and keeps changing its own address, to a site that does not answer in time is stopped and fails the same way, never naming the page the tab still shows; the next step reaches the browser at once and finds that page, and the site's late answer never lands",
        "a link clicked on a page that had loaded, to a site that does not answer, is stopped once the click stops waiting for it and fails the same way, never as the page the tab still shows nor as the click's own timeout; the next step reaches the browser at once, and the site's late answer never lands",
        "a form sent to a site that does not answer is not stopped and never reads as nothing opened: the step answers once its time is up and says to check what it did, and the form's late answer lands",
        "a click that opens a window and keeps the page busy fails once the step's time is up, as it would in its time: the window is closed and never loads anything, then or later",
        "a hand-off whose fields the page is too busy to highlight in time answers with the page as it is and leaves no hand-off behind",
        "a search whose results page keeps the page busy answers once the step's time is up, with the page's address and a note that it is still busy, never waiting out the page; its line says no page was read",
      ],
      timings: { slowAnswerMs: Math.round(slow.wallMs), manyControlsReadMs: Math.round(planner.wallMs), manyControlsChoiceMs: Math.round(chose.wallMs), busyWindowMs: Math.round(clicked.wallMs), busyHandoffMs: Math.round(handoff.wallMs), busySearchMs: Math.round(searched.wallMs), unansweredLoadMs: Math.round(loading.wallMs), unansweredLoadFromPageMs: Math.round(fromPage.wallMs), unansweredClickMs: Math.round(followed.wallMs), unansweredFormMs: Math.round(sent.wallMs) },
      limitations: ["No model, Studio UI, origin or runtime shutdown guard; those are unit-tested."],
    };
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    for (const response of unanswered) response.destroy();
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
