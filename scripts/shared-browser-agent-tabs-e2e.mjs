import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureEnvironment, policyScriptNames } from "./shared-browser-cobrowsing-e2e.mjs";

// Real-browser proof of Octo's own tabs in the Shared Browser: the production
// controller script, composed as runtime-agent composes it, drives a real
// Chromium over CDP against two loopback fixture sites. Every page, identity,
// approval and profile is disposable; no model, Studio, controller, account
// or external site is used, and Chromium resolves no other host.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendRequire = createRequire(path.join(repositoryRoot, "packages/frontend/package.json"));
const playwrightRequire = createRequire(frontendRequire.resolve("@playwright/test"));
const { chromium } = playwrightRequire("playwright");
const playwrightDirectory = fs.realpathSync(path.dirname(playwrightRequire.resolve("playwright/package.json")));
const executablePath = chromium.executablePath();
// Retained with the co-browsing fixture's results, whose CI step runs this one.
const resultDirectory = path.join(repositoryRoot, "packages/frontend/test-results/browser-ci/shared-cobrowsing");
const resultFile = path.join(resultDirectory, "agent-tabs-result.json");
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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeProtectedJson(destination, value) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, destination);
}

const page = (title, body) => `<!doctype html><html lang="en"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${title}</title><body><h1>${title}</h1>${body}</body></html>`;

// One fixture site. It records every request, so a refused step can be shown
// to have sent nothing.
async function listenSite(name, routes) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const route = routes[request.url];
    if (!route) {
      response.writeHead(404).end();
      return;
    }
    if (route.redirect) {
      response.writeHead(302, { location: route.redirect, "cache-control": "no-store" }).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(page(route.title, route.body));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { name, server, origin, requests };
}

export async function runSharedBrowserAgentTabsFixture() {
  assert.ok(fs.existsSync(executablePath), "Locked Playwright Chromium is missing; run pnpm --filter @instafy/frontend exec playwright install chromium");
  fs.mkdirSync(resultDirectory, { recursive: true });
  fs.rmSync(resultFile, { force: true });
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instafy-agent-tabs-e2e-")));
  const profileDirectory = path.join(temporary, "profile");
  const approvalDirectory = path.join(temporary, "approvals");
  const markerPath = path.join(temporary, "agent-control.json");
  const actionsPath = path.join(temporary, "actions.jsonl");
  fs.mkdirSync(approvalDirectory, { mode: 0o700 });
  const environment = fixtureEnvironment(process.env, temporary);
  const children = new Set();
  const servers = [];
  let context;
  try {
    const research = await listenSite("research", {
      "/": { title: "Trip notes", body: "<p>The person's own page.</p>" },
    });
    servers.push(research.server);
    const sources = await listenSite("sources", {
      "/timetable": { title: "Timetable", body: "<p>Trains leave every 20 minutes.</p><form method=\"post\" action=\"/order\"><button>Place order</button></form>" },
      "/hours": { title: "Opening hours", body: "<p>Open daily 9 to 17.</p>" },
      "/prices": { title: "Prices", body: "<p>Entry 12 EUR.</p>" },
      "/to-link-only": { redirect: "https://www.booking.com/hotel/fixture.html" },
    });
    servers.push(sources.server);

    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath,
      headless: true,
      viewport: { width: 1000, height: 800 },
      env: environment,
      // No host but the loopback fixtures resolves, so nothing leaves the machine.
      args: [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
    });
    const runPage = context.pages()[0];
    await runPage.goto(`${research.origin}/`);
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
      initiatorUserId: "00000000-0000-4000-8000-000000000003",
      browserPageId: runPageId, displayName: "Fixture assistant", expiresAtMs: Date.now() + 300_000,
    };
    writeProtectedJson(markerPath, authority);

    const prompts = [];
    async function runTool(method, requestPath, body = null, decisions = []) {
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
          INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS: "5000",
          INSTAFY_BROWSER_ACTIONS_FILE: actionsPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
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
          assert.ok(decision, `Unexpected prompt during ${requestPath}: ${request.display.label}`);
          writeProtectedJson(path.join(approvalDirectory, "decision.json"), {
            version: 1, approvalId: request.approvalId, requestFingerprint: request.requestFingerprint,
            decision, decidedByUserId: authority.initiatorUserId,
            decidedAtMs: Date.now(), expiresAtMs: request.expiresAtMs,
          });
        } catch (error) {
          if (error.code === "ENOENT" || error instanceof SyntaxError) return;
          failure = error;
          child.kill("SIGKILL");
        }
      }, 10);
      const timeout = setTimeout(() => {
        failure = new Error(`Fixture tool timed out: ${requestPath}`);
        child.kill("SIGKILL");
      }, 30_000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        if (failure) throw failure;
        return { code, stdout, stderr, payload: code === 0 ? JSON.parse(stdout) : null };
      } finally {
        clearInterval(answering);
        clearTimeout(timeout);
        children.delete(child);
      }
    }
    const ok = async (...args) => {
      const result = await runTool(...args);
      assert.equal(result.code, 0, `${args[1]} failed: ${result.stderr}`);
      return result.payload;
    };
    const refused = async (pattern, ...args) => {
      const result = await runTool(...args);
      assert.equal(result.code, 1, `${args[1]} should have been refused: ${result.stdout}`);
      assert.match(result.stderr, pattern);
      return result.stderr;
    };
    const tabsRecord = () => JSON.parse(fs.readFileSync(path.join(approvalDirectory, "tabs.json"), "utf8"));
    const state = () => JSON.parse(fs.readFileSync(path.join(approvalDirectory, "state.json"), "utf8"));
    const browserPages = () => context.pages().filter((entry) => !entry.isClosed());
    const pageWithUrl = (url) => browserPages().find((entry) => entry.url() === url);

    // 1. Octo opens a visible tab. In Ask, the site is approved in that tab
    // and the step is bound to it; the prompts name the tab.
    const opened = await ok("POST", "/v1/tabs/open", { url: `${sources.origin}/timetable` }, ["allow_origin", "allow_once"]);
    const firstTab = opened.tabId;
    assert.equal(opened.openedTab, true);
    assert.equal(opened.browserPageId, runPageId);
    assert.match(opened.visibleText, /Trains leave every 20 minutes/);
    assert.deepEqual(prompts.map((prompt) => [prompt.kind, prompt.display.label]), [
      ["origin", "Octo's tab 1: Allow the assistant to open this site in a new tab for this run"],
      ["action", "Octo's tab 1: Open a new tab"],
    ]);
    assert.ok(prompts.every((prompt) => prompt.browserPageId === runPageId));
    const timetable = pageWithUrl(`${sources.origin}/timetable`);
    assert.ok(timetable, "The tab is an ordinary page of the shared browser, where every viewer sees it");
    assert.equal(browserPages().length, 2);
    // The origin shows viewers the focused page as the active one.
    assert.equal(await timetable.evaluate(() => document.hasFocus()), true, "Octo's tab is in front");
    assert.equal(await runPage.evaluate(() => document.hasFocus()), false);
    assert.deepEqual(tabsRecord().tabs, [{ tabId: firstTab, approvedOrigins: [sources.origin] }]);
    assert.deepEqual(state().approvedOrigins, [], "The tab's site approval is the tab's only");
    const listed = await ok("GET", "/v1/tabs");
    assert.deepEqual(listed.tabs.map((tab) => [tab.openedBy, tab.current, tab.originApproved]), [
      ["person", false, false],
      ["octo", true, true],
    ]);
    const navigation = fs.readFileSync(actionsPath, "utf8").trim().split("\n").map(JSON.parse)
      .filter((action) => action.type === "navigate");
    assert.equal(navigation.at(-1).pageId, firstTab, "The action feed shows the step in Octo's tab");

    // 2. Octo's tabs are for reading: a form submission is refused before
    // any prompt, and the site never receives it.
    const before = prompts.length;
    const snapshot = await ok("GET", "/v1/snapshot");
    const order = snapshot.interactiveElements.find((element) => element.label === "Place order");
    assert.ok(order, "The order button is observed");
    await refused(/for reading/, "POST", "/v1/click", { index: order.index, snapshotId: snapshot.snapshotId }, ["allow_once"]);
    assert.equal(prompts.length, before, "A refused step shows no prompt");
    assert.ok(!sources.requests.some((request) => request.startsWith("POST")), "The site received no submission");

    // 3. A link-only site is never opened by Octo: not as a new tab, and not
    // through a redirect, which the tab's guard stops before it leaves.
    await refused(/Booking\.com is link-only/, "POST", "/v1/tabs/open", { url: "https://www.booking.com/" });
    assert.equal(browserPages().length, 2, "No tab was opened for a link-only site");
    await refused(/led to Booking\.com, which is link-only/, "POST", "/v1/navigate", { url: `${sources.origin}/to-link-only` }, ["allow_once"]);
    assert.ok(!browserPages().some((entry) => entry.url().includes("booking")), "No tab shows the link-only site");
    // The blocked load left an error page; Octo goes back to its source.
    await ok("POST", "/v1/navigate", { url: `${sources.origin}/timetable` }, ["allow_once"]);

    // 4. At most three tabs of Octo's own.
    const second = await ok("POST", "/v1/tabs/open", { url: `${sources.origin}/hours` }, ["allow_origin", "allow_once"]);
    const third = await ok("POST", "/v1/tabs/open", { url: `${sources.origin}/prices` }, ["allow_origin", "allow_once"]);
    assert.equal(prompts.at(-2).display.label, "Octo's tab 3: Allow the assistant to open this site in a new tab for this run");
    await refused(/already has 3 tabs open/, "POST", "/v1/tabs/open", { url: `${sources.origin}/hours` });
    assert.equal(browserPages().length, 4);

    // 5. snapshot may name its tab; the run's page reads as the person's.
    const inFirst = await ok("POST", "/v1/snapshot", { tabId: firstTab });
    assert.equal(inFirst.tabId, firstTab);
    assert.match(inFirst.visibleText, /Trains leave/);
    assert.equal(await timetable.evaluate(() => document.hasFocus()), true);

    // 6. Octo closes a tab it is done with; it cannot close the person's.
    await refused(/close only the tabs it opened/, "POST", "/v1/tabs/close", { tabId: runPageId });
    await ok("POST", "/v1/tabs/close", { tabId: second.tabId });
    assert.ok(!pageWithUrl(`${sources.origin}/hours`), "The closed tab is gone from the browser");

    // 7. The person closes the tab Octo works in: nothing more happens in it.
    await ok("POST", "/v1/tabs/select", { tabId: third.tabId });
    await pageWithUrl(`${sources.origin}/prices`).close();
    await refused(/was closed, so nothing was done/, "GET", "/v1/snapshot");
    const afterClose = await ok("GET", "/v1/tabs");
    assert.deepEqual(afterClose.tabs.map((tab) => tab.tabId), [runPageId, firstTab]);

    // 8. The end of the run closes Octo's remaining tabs with the request
    // runtime-agent sends (GET /json/close/<id> on the loopback DevTools port).
    const closing = await fetch(`http://127.0.0.1:${port}/json/close/${firstTab}`);
    assert.equal(closing.status, 200);
    for (let attempt = 0; attempt < 50 && pageWithUrl(`${sources.origin}/timetable`); attempt += 1) await delay(20);
    assert.ok(!pageWithUrl(`${sources.origin}/timetable`), "Octo's tab closed at the end of the run");
    assert.equal(browserPages().length, 1, "Only the person's page is left");
    assert.equal(runPage.url(), `${research.origin}/`, "The person's page was never touched");

    const actionLog = fs.readFileSync(actionsPath, "utf8");
    assert.ok(!actionLog.includes("booking.com/hotel"), "The link-only address never reached the action feed as a step");
    const result = {
      status: "passed",
      fixtureVersion: 1,
      prompts: prompts.length,
      checks: [
        "visible agent tab in the run's browser context, brought to front",
        "per-tab site approval and tab-bound step approval",
        "form submission refused in an agent tab before any prompt",
        "link-only site refused as a new tab and through a redirect",
        "three agent tabs at most",
        "close_tab, and a tab the person closed",
        "turn-end close through the DevTools HTTP endpoint",
      ],
      limitations: [
        "No model, Studio UI, origin keep endpoint or runtime shutdown guard; those are unit-tested.",
      ],
    };
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    for (const child of children) child.kill("SIGKILL");
    await context?.close().catch(() => {});
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/shared-browser-agent-tabs-e2e.mjs (no filters or skips)");
  runSharedBrowserAgentTabsFixture().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    fs.mkdirSync(resultDirectory, { recursive: true });
    fs.writeFileSync(resultFile, `${JSON.stringify({ status: "failed", fixtureVersion: 1 })}\n`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
