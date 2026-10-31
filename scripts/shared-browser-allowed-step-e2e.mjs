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

// Real-browser proof that an Allow runs the step the person allowed: the
// production controller script, composed as runtime-agent composes it, drives
// a real Chromium over CDP against loopback fixture sites. While a prompt
// waits, the page changes the way live pages do by themselves (a carousel
// shows its next slide, a clock in a link ticks, a live count goes up), and
// the allowed step still runs, on the control the person was asked about. A
// control that changed while the prompt waited (swapped for another, its form
// sent elsewhere or given another field) is not used, and the step asks again
// instead of ending the run; so is one that a change leaves looking like
// another, or that a look-alike appeared ahead of. A take-over while the prompt waits still ends the step, and a page
// that left its site after the yes ends the run with the yes listed. No model,
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
const resultFile = path.join(resultDirectory, "allowed-step-result.json");
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

const INITIATOR = "00000000-0000-4000-8000-000000000006";
const CHANGED_AFTER_YES = /The page changed after the person said yes, and the control this step was for is not there as it was, so nothing was done\./u;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeProtectedJson(destination, value) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, destination);
}

const page = (title, body, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'${script ? "; script-src 'unsafe-inline'" : ""}">
<title>${title}</title><style>.slide{display:none}.slide.on{display:block}</style></head><body><h1>${title}</h1>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

// A journey planner with what live pages change by themselves: a carousel of
// news links that shows one slide at a time, a clock in a link and a live
// count in another. Each moves on only when the fixture says, so a change
// lands while a prompt waits and never before it. "?twice=1" has two forms that
// look the same; a hidden field tells which one was sent.
const PLANNER_FORM = (which) => `<form action="/route" method="get"><input type="hidden" name="which" value="${which}">
<p><label>From <input name="from" value="Central"></label></p><p><label>To <input name="to" value="Airport"></label></p>
<p><button>Plan your journey</button></p></form>`;
const planner = (twice) => page("Journey planner", `<section aria-label="News">
<div class="slide on"><a href="/news/1">Line A reopens</a></div><div class="slide"><a href="/news/2">New timetable</a></div><div class="slide"><a href="/news/3">Night service</a></div></section>
<p><a id="departures" href="/departures">Departures, updated 10:42:30</a></p><p><a id="status" href="/status">Line status: 3 delays</a></p>
${PLANNER_FORM(1)}${twice ? PLANNER_FORM(2) : ""}`, `const slides = [...document.querySelectorAll(".slide")];
window.live = {
  slide() {
    const at = slides.findIndex((slide) => slide.classList.contains("on"));
    slides[at].classList.remove("on");
    slides[(at + 1) % slides.length].classList.add("on");
  },
  tick() { document.getElementById("departures").textContent = "Departures, updated 10:42:31"; },
  count() { document.getElementById("status").textContent = "Line status: 4 delays"; },
  // A carousel that names its slide in the page's fragment.
  fragment() { this.slide(); history.replaceState(null, "", "#slide-2"); },
  // A page that moves its own address on its site, its controls all the same.
  address() { history.pushState(null, "", "/journey/updated"); },
};`);

export async function runSharedBrowserAllowedStepFixture() {
  assert.ok(fs.existsSync(executablePath), "Locked Playwright Chromium is missing; run pnpm --filter @instafy/frontend exec playwright install chromium");
  fs.mkdirSync(resultDirectory, { recursive: true });
  fs.rmSync(resultFile, { force: true });
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instafy-allowed-step-e2e-")));
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
    // What reached the sites: "<host> <method> <path>".
    const requests = [];
    server = createServer((request, response) => {
      const url = new URL(request.url, "http://fixture.invalid");
      const host = String(request.headers.host || "").split(":")[0];
      requests.push(`${host} ${request.method} ${url.pathname}${url.search}`);
      const body = url.pathname === "/journey"
        ? planner(url.searchParams.get("twice") === "1")
        : {
            "/route": page("Your route", "<p>Central to Airport: 2 stops, 24 minutes.</p>"),
            "/news/1": page("Line A reopens", "<p>News.</p>"), "/news/2": page("New timetable", "<p>News.</p>"),
            "/news/3": page("Night service", "<p>News.</p>"), "/departures": page("Departures", "<p>Every 6 minutes.</p>"),
            "/status": page("Line status", "<p>3 delays.</p>"), "/elsewhere": page("Another site", "<p>Elsewhere.</p>"),
          }[url.pathname];
      if (!body) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(body);
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    const origin = `http://journeys.test:${port}`;
    const otherOrigin = `http://other.test:${port}`;
    const sent = () => requests.filter((request) => /\/route\b/u.test(request));

    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath,
      headless: true,
      viewport: { width: 1000, height: 800 },
      env: environment,
      // No host but the loopback fixture's two names resolves, so nothing leaves the machine.
      args: [
        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        "--host-resolver-rules=MAP journeys.test 127.0.0.1, MAP other.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
    });
    const runPage = context.pages()[0];
    await runPage.goto(`${origin}/journey`);
    const session = await context.newCDPSession(runPage);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
    const runPageId = targetInfo.targetId;
    let cdpPort;
    for (let attempt = 0; attempt < 200 && !cdpPort; attempt += 1) {
      try {
        cdpPort = Number(fs.readFileSync(path.join(profileDirectory, "DevToolsActivePort"), "utf8").split("\n")[0]);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await delay(25);
      }
    }
    assert.ok(Number.isInteger(cdpPort) && cdpPort > 0, "Chromium did not expose its loopback CDP port");
    let authority;
    // A run of its own: a new owner and run, with nothing approved yet.
    function freshRun() {
      assert.equal(children.size, 0, "A fresh run requires the previous command to have exited");
      for (const name of ["request.json", "decision.json", "state.json", "withhold-next.json"]) {
        fs.rmSync(path.join(approvalDirectory, name), { force: true });
      }
      authority = {
        version: 2, ownerId: randomUUID(), runId: randomUUID(), initiatorUserId: INITIATOR,
        browserPageId: runPageId, displayName: "Fixture assistant", expiresAtMs: Date.now() + 600_000,
      };
      writeProtectedJson(markerPath, authority);
    }

    const prompts = [];
    // Answers each prompt with the next of `decisions`. `whilePromptWaits`
    // runs once a prompt shows and before it is answered: what the page (or
    // the person) does while they read it.
    async function runTool(method, requestPath, body = null, decisions = [], whilePromptWaits = null) {
      const child = spawn(process.execPath, ["-", method, requestPath, ...(body ? [JSON.stringify(body)] : [])], {
        cwd: temporary,
        env: {
          ...environment,
          INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: playwrightDirectory,
          INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT: path.dirname(playwrightDirectory),
          INSTAFY_SHARED_BROWSER_PAGE_ID: runPageId,
          INSTAFY_PLAYWRIGHT_CDP_URL: `http://127.0.0.1:${cdpPort}`,
          INSTAFY_BROWSER_AGENT_CONTROL_FILE: markerPath,
          INSTAFY_SHARED_BROWSER_APPROVAL_DIR: approvalDirectory,
          INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS: "15000",
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
      let answering = Promise.resolve();
      const poll = setInterval(() => {
        let request;
        try {
          request = JSON.parse(fs.readFileSync(path.join(approvalDirectory, "request.json"), "utf8"));
        } catch (error) {
          if (error.code === "ENOENT" || error instanceof SyntaxError) return;
          failure = error;
          child.kill("SIGKILL");
          return;
        }
        if (seen.has(request.approvalId)) return;
        seen.add(request.approvalId);
        prompts.push(request);
        const decision = decisions[seen.size - 1];
        answering = (async () => {
          try {
            assert.ok(decision, `Unexpected prompt during ${requestPath}: ${request.display?.label}`);
            if (whilePromptWaits) await whilePromptWaits(request);
            writeProtectedJson(path.join(approvalDirectory, "decision.json"), {
              version: 1, approvalId: request.approvalId, requestFingerprint: request.requestFingerprint,
              decision, decidedByUserId: INITIATOR, decidedAtMs: Date.now(), expiresAtMs: request.expiresAtMs,
            });
          } catch (error) {
            failure = error;
            child.kill("SIGKILL");
          }
        })();
      }, 10);
      const timeout = setTimeout(() => {
        failure = new Error(`Fixture tool timed out: ${requestPath}`);
        child.kill("SIGKILL");
      }, 40_000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        await answering;
        if (failure) throw failure;
        return { code, stdout, stderr, payload: code === 0 ? JSON.parse(stdout) : null };
      } finally {
        clearInterval(poll);
        clearTimeout(timeout);
        children.delete(child);
      }
    }
    const ok = async (...args) => {
      const result = await runTool(...args);
      assert.equal(result.code, 0, `${args[1]} failed: ${result.stderr}`);
      return result;
    };
    const control = (snapshot, label, nth = 0) => {
      const matches = snapshot.interactiveElements.filter((element) => element.label === label);
      assert.ok(matches[nth], `No control named ${label}: ${snapshot.interactiveElements.map((element) => element.label)}`);
      return { index: matches[nth].index, snapshotId: snapshot.snapshotId };
    };
    // The planner as Octo observes it: navigate's own answer is the snapshot.
    const openPlanner = async (query = "", decisions = []) =>
      (await ok("POST", "/v1/navigate", { url: `${origin}/journey${query}` }, decisions)).payload;
    const live = (what) => () => runPage.evaluate((change) => window.live[change](), what);
    // A step that was not done because its control changed: the run goes on
    // (no terminal code), nothing was sent, and the failed command lists the
    // person's yes.
    const askedAgain = (result, what) => {
      assert.equal(result.code, 1, `${what}: the step ran: ${result.stdout}`);
      assert.match(result.stderr, CHANGED_AFTER_YES, `${what}: ${result.stderr}`);
      assert.match(result.stderr, /it asks the person again/u, what);
      assert.doesNotMatch(result.stderr, /_non_retryable/u, `${what}: the run ended`);
      assert.deepEqual(JSON.parse(result.stdout), { ok: false, activity: { approval: "once" } }, what);
      assert.deepEqual(sent(), [], `${what}: the form was sent`);
    };

    freshRun();
    // The site's prompt, answered with routine browsing: a form's own submit
    // still asks, every time.
    let planned = await openPlanner("", ["allow_routine"]);
    assert.equal(prompts.length, 1);

    // 1. The page changes by itself while the person reads the prompt. The
    // step they allowed runs, on the control they were asked about.
    const runs = {};
    for (const [name, change] of [["carousel", "slide"], ["clock", "tick"], ["live count", "count"], ["carousel in the fragment", "fragment"]]) {
      if (name !== "carousel") planned = await openPlanner();
      requests.length = 0;
      const asked = prompts.length;
      const clicked = await runTool("POST", "/v1/click", control(planned, "Plan your journey"), ["allow_once"], live(change));
      assert.equal(clicked.code, 0, `${name}: the allowed step did not run: ${clicked.stderr}`);
      assert.equal(prompts.length, asked + 1, `${name}: one prompt`);
      assert.match(prompts.at(-1).display.label, /Plan your journey/u);
      assert.deepEqual(sent(), [`journeys.test GET /route?which=1&from=Central&to=Airport`], name);
      assert.equal(new URL(runPage.url()).pathname, "/route", name);
      assert.equal(clicked.payload.activity.approval, "once", name);
      runs[name] = "ran";
    }
    // Typing that sends the form, and Enter in a field, the same way.
    planned = await openPlanner();
    requests.length = 0;
    const typed = await runTool("POST", "/v1/type", { ...control(planned, "To"), text: "Old Town", submit: true }, ["allow_once"], live("tick"));
    assert.equal(typed.code, 0, `typing: ${typed.stderr}`);
    assert.deepEqual(sent(), ["journeys.test GET /route?which=1&from=Central&to=Old+Town"]);
    planned = await openPlanner();
    requests.length = 0;
    const pressed = await runTool("POST", "/v1/press", { ...control(planned, "From"), key: "Enter" }, ["allow_once"], live("slide"));
    assert.equal(pressed.code, 0, `key press: ${pressed.stderr}`);
    assert.deepEqual(sent(), ["journeys.test GET /route?which=1&from=Central&to=Airport"]);

    // 2. The control itself changed while the prompt waited: nothing is done,
    // and the step asks again instead of ending the run.
    planned = await openPlanner();
    requests.length = 0;
    const swapped = await runTool("POST", "/v1/click", control(planned, "Plan your journey"), ["allow_once"], () =>
      runPage.evaluate(() => {
        const plan = document.querySelector("form button");
        const other = document.createElement("button");
        other.type = "button";
        other.textContent = "Buy a day ticket";
        other.addEventListener("click", () => { document.body.dataset.bought = "1"; });
        plan.replaceWith(other);
      }));
    askedAgain(swapped, "a control swapped for another");
    assert.equal(await runPage.evaluate(() => document.body.dataset.bought ?? null), null, "the new control was used");

    planned = await openPlanner();
    requests.length = 0;
    const elsewhere = await runTool("POST", "/v1/click", control(planned, "Plan your journey"), ["allow_once"], () =>
      runPage.evaluate((to) => { document.querySelector("form").action = to; }, `${otherOrigin}/route`));
    askedAgain(elsewhere, "a form sent elsewhere");

    // The same control on another page of the site is asked about again too.
    planned = await openPlanner();
    requests.length = 0;
    const moving = await runTool("POST", "/v1/click", control(planned, "Plan your journey"), ["allow_once"], live("address"));
    askedAgain(moving, "a page whose address moved on its site");

    planned = await openPlanner();
    requests.length = 0;
    const addField = () => runPage.evaluate(() => {
      const field = document.createElement("p");
      field.innerHTML = '<label>Phone <input name="phone" value="555-0100"></label>';
      document.querySelector("form button").parentElement.before(field);
    });
    const widened = await runTool("POST", "/v1/click", control(planned, "Plan your journey"), ["allow_once"], addField);
    askedAgain(widened, "a form given another field");
    // Octo looks at the page again and does the step again: the person is
    // asked again, about the form as it is now, and their yes sends it.
    const askedBefore = prompts.length;
    const looked = await ok("GET", "/v1/snapshot");
    const again = await runTool("POST", "/v1/click", control(looked.payload, "Plan your journey"), ["allow_once"]);
    assert.equal(again.code, 0, `asked again: ${again.stderr}`);
    assert.equal(prompts.length, askedBefore + 1, "the step asked again");
    assert.match(prompts.at(-1).display.label, /Phone/u, "the new prompt names the form's new field");
    assert.deepEqual(sent(), ["journeys.test GET /route?which=1&from=Central&to=Airport&phone=555-0100"]);

    // 3. Two controls alike: once the page changed, neither is taken for the
    // one the person was asked about.
    planned = await openPlanner("?twice=1");
    requests.length = 0;
    const twins = await runTool("POST", "/v1/click", control(planned, "Plan your journey", 1), ["allow_once"], live("slide"));
    askedAgain(twins, "one of two controls alike, after a change");
    // Nor is the twin left once the one the person was asked about went.
    planned = await openPlanner("?twice=1");
    requests.length = 0;
    const orphan = await runTool("POST", "/v1/click", control(planned, "Plan your journey", 0), ["allow_once"], () =>
      runPage.evaluate(() => document.querySelector("form").remove()));
    askedAgain(orphan, "one of two controls alike, after it went");
    // Nor one that a look-alike, appearing ahead of it, could be taken for.
    planned = await openPlanner();
    requests.length = 0;
    const lookAlike = await runTool("POST", "/v1/click", control(planned, "Plan your journey"), ["allow_once"], () =>
      runPage.evaluate(() => {
        const form = document.querySelector("form");
        const copy = form.cloneNode(true);
        copy.querySelector("[name=which]").value = "2";
        form.before(copy);
      }));
    askedAgain(lookAlike, "a control a look-alike appeared ahead of");
    // With the page as it was, the control at its index is the one: the
    // second form, not the first that looks like it.
    planned = await openPlanner("?twice=1");
    requests.length = 0;
    const second = await runTool("POST", "/v1/click", control(planned, "Plan your journey", 1), ["allow_once"]);
    assert.equal(second.code, 0, `the second form: ${second.stderr}`);
    assert.deepEqual(sent(), ["journeys.test GET /route?which=2&from=Central&to=Airport"], "the control at its index was used");

    // 4. A take-over while the prompt waits: the person's run ends and another
    // holds the browser. A yes that comes then does nothing.
    planned = await openPlanner();
    requests.length = 0;
    const takenOver = await runTool("POST", "/v1/click", control(planned, "Plan your journey"), ["allow_once"], async () => {
      writeProtectedJson(markerPath, { ...authority, ownerId: randomUUID(), runId: randomUUID() });
      await delay(150);
    });
    assert.equal(takenOver.code, 1, `the step ran after a take-over: ${takenOver.stdout}`);
    assert.match(takenOver.stderr, /\[approval_authority_revoked_non_retryable\]/u, takenOver.stderr);
    assert.deepEqual(sent(), [], "the form was sent after a take-over");
    assert.equal(new URL(runPage.url()).pathname, "/journey");

    // 5. The page left its site after the person's yes: the run ends there, as
    // their yes was for a step on that site, and the failed command lists it.
    freshRun();
    planned = await openPlanner("", ["allow_routine"]);
    requests.length = 0;
    const moved = await runTool("POST", "/v1/click", control(planned, "Plan your journey"), ["allow_once"], async () => {
      await runPage.goto(`${otherOrigin}/elsewhere`);
    });
    assert.equal(moved.code, 1, `the step ran on another site: ${moved.stdout}`);
    assert.match(moved.stderr, /The page moved to another site after the person said yes, so the step was not done \[approval_stale_non_retryable\]/u, moved.stderr);
    assert.deepEqual(JSON.parse(moved.stdout), { ok: false, activity: { approval: "once" } });
    assert.deepEqual(sent(), []);

    const result = {
      status: "passed",
      fixtureVersion: 1,
      checks: [
        "a carousel that moves to its next slide (also one that names it in the page's fragment), a clock in a link that ticks and a live count that goes up while the prompt waits leave the allowed click to run, once, on the control the person was asked about",
        "typing that sends the form and Enter in a field run the same way while the page changes",
        "a control swapped for another, a form sent elsewhere, the same control on another address of the site and a form given another field while the prompt waits are not used: the step fails without ending the run, says it asks again, and lists the person's yes",
        "asked again, the step's new prompt names the form as it is now, and the yes sends it",
        "one of two controls alike is not used once the page changed, nor its twin once it went, nor a control a look-alike appeared ahead of; with the page unchanged the control at its index is",
        "a take-over while the prompt waits ends the step, and a yes then does nothing",
        "a page that left its site after the yes ends the run with the stale code, and the failed command lists the yes",
      ],
      runs,
      limitations: ["No model, Studio UI, origin or runtime guard; those are unit-tested."],
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
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/shared-browser-allowed-step-e2e.mjs (no filters or skips)");
  runSharedBrowserAllowedStepFixture().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    fs.mkdirSync(resultDirectory, { recursive: true });
    fs.writeFileSync(resultFile, `${JSON.stringify({ status: "failed", fixtureVersion: 1 })}\n`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
