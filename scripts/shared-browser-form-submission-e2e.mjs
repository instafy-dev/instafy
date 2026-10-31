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

// Real-browser proof that a form step in the Shared Browser is judged by the
// submission the browser actually makes. Two parts, one Chromium:
// 1. The form-submission table both browsers run
//    (packages/browser-action-policy/formSubmissionCases.json): for each case
//    the shared in-page rules report the submission, then Chromium takes the
//    step itself and the request it sends (or not) must match.
// 2. The production controller script, composed as runtime-agent composes it,
//    on a page with a hostile default button, a label of a hidden submit
//    button, a form that opens another window and a <base href> to another
//    site: none of them sends a cross-site POST without the confirmation for
//    that site.
// 3. Under routine browsing, Enter in a site's own search box, or typing into
//    it with submit, goes without a prompt when it is a GET of the page's own
//    origin that sends nothing key-like, in the run's page and in Octo's own
//    tabs, and lets no form post leave the tab; every other form step still
//    asks or is refused, and Ask mode asks for each.
// 4. A journey planner: under routine browsing, choosing a start and an end
//    station asks nothing and sends nothing, the planner's own button asks
//    once and the route is read. A list is named by its own label or the
//    option it holds, never by its options; a list the page posts when it
//    changes may post to its own site, never elsewhere; and Ask mode asks for
//    each choice, naming the option and the list.
// 5. Other lists: inside their own labels, with a word of a payment detail
//    among their options, holding several options, long, posting to another
//    site after an Allow or from Octo's own tab, signing in with another
//    account, on a page that may show a secret, and moving their options
//    while Octo chooses.
// Every site is a loopback fixture; Chromium resolves no other host.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendRequire = createRequire(path.join(repositoryRoot, "packages/frontend/package.json"));
const playwrightRequire = createRequire(frontendRequire.resolve("@playwright/test"));
const { chromium } = playwrightRequire("playwright");
const playwrightDirectory = fs.realpathSync(path.dirname(playwrightRequire.resolve("playwright/package.json")));
const executablePath = chromium.executablePath();
// Retained with the co-browsing fixture's results, whose CI step runs this one.
const resultDirectory = path.join(repositoryRoot, "packages/frontend/test-results/browser-ci/shared-cobrowsing");
const resultFile = path.join(resultDirectory, "form-submission-result.json");
const policyDirectory = path.join(repositoryRoot, "packages/browser-action-policy");
const policyScript = (name) => `(function (module, require) {\n${
  fs.readFileSync(path.join(policyDirectory, name), "utf8")
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
const { formSubmissionRulesInPage } = createRequire(import.meta.url)(path.join(policyDirectory, "formSubmission.js"));
const table = JSON.parse(fs.readFileSync(path.join(policyDirectory, "formSubmissionCases.json"), "utf8"));

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A random-looking value the redaction rules mask, assembled at run time so
// the source holds no key-shaped literal.
const KEY_LIKE = ["a8Fk2LmQ", "9zXw7Rt4", "Yb6Nc1Vd"].join("");

function writeProtectedJson(destination, value) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, destination);
}

// No page asks for a favicon, so every request a step causes is the step's.
const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title></head><body>${body}</body></html>`;

// The controller scenarios' page. {other} is the site a hostile form sends to.
const HOSTILE = `<h1>Shop</h1>
<form action="/search" method="get" role="search"><input type="search" name="q" aria-label="Search the shop">
<button formaction="{other}/collect" formmethod="post">Search</button></form>
<form action="/search"><label for="hidden-go" tabindex="0">Read the reviews</label>
<button id="hidden-go" formaction="{other}/collect" formmethod="post" style="display:none">Go</button></form>
<form action="/search"><input type="search" name="q" aria-label="Find in a new window"><button formtarget="_blank">Find</button></form>`;
const BASED = `<base href="{other}/dir/"><h1>Notes</h1>
<form action="notes" method="post"><input name="note" aria-label="Note"><button>Save</button></form>`;
// Forms that send elsewhere than the page describer can tell: a keydown
// handler that moves the search's default button to another site, a submit
// button in a closed shadow tree around a control, a submit button laid over
// a control, a field and a deeply nested control inside a hostile submit
// button.
const STRAY = `<h1>Mall</h1>
<form action="/search" method="get" role="search"><input type="search" name="q" aria-label="Find a product" id="moving"><button>Find</button></form>
<script>
document.getElementById("moving").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const button = event.target.form.querySelector("button");
  button.formAction = "{other}/collect";
  button.formMethod = "post";
});
</script>
<div><template shadowrootmode="closed"><form action="{other}/collect" method="post"><button><slot></slot></button></form></template><span tabindex="0">Reviews</span></div>
<form id="specials" action="/search"></form>
<span tabindex="0" style="position:relative;display:inline-block;padding:8px 24px">Specials<button form="specials" formaction="{other}/collect" formmethod="post" tabindex="-1" style="position:absolute;inset:0;opacity:0"></button></span>
<form action="/search"><button formaction="{other}/collect" formmethod="post"><input name="size" aria-label="Shoe size"></button></form>
<form action="/search"><button formaction="{other}/collect" formmethod="post" aria-label="Search">${"<span>".repeat(70)}<span tabindex="0">Deep reviews</span>${"</span>".repeat(70)}</button></form>`;

// A site's own search box: a GET of the page's own origin.
const SEARCH = `<h1>Places</h1>
<form action="/search" method="get" role="search"><input type="search" name="q" aria-label="Search places"><input type="hidden" name="lang" value="en"><button>Search</button></form>`;
// Search boxes that still ask, or are refused, under routine browsing, and one
// whose page turns the search into a post when Enter is pressed.
const SEARCH_CHECKS = `<h1>Searches</h1>
<form action="/search" method="get"><input type="search" name="q" aria-label="Search, posted"><button formmethod="post">Search</button></form>
<form action="{other}/search"><input type="search" name="q" aria-label="Search another site"><button>Search</button></form>
<form action="{sub}/search"><input type="search" name="q" aria-label="Search a subdomain"><button>Search</button></form>
<form action="/search"><input type="search" name="q" aria-label="Search in a new window"><button formtarget="_blank">Search</button></form>
<form action="/search"><button aria-label="Search"><input name="q" aria-label="Search inside the button"></button></form>
<input type="search" aria-label="Search without a form" id="formless">
<form action="/account/logout"><input type="search" name="q" aria-label="Search, then sign out"><button>Search</button></form>
<form action="https://www.booking.com/searchresults.html"><input type="search" name="ss" aria-label="Search hotels"><button>Search</button></form>
<form action="/search"><input type="search" name="q" aria-label="Search with a key"><input type="hidden" name="k" value="{key}"><button>Search</button></form>
<form action="/search"><input type="search" name="q" aria-label="Search as a table"><input type="hidden" name="format" value="csv"><button>Search</button></form>
<form action="/search"><input type="search" name="q" aria-label="Search with a hidden number"><input type="hidden" name="code" value="482910"><button>Search</button></form>
<form action="/search"><input type="search" name="q" aria-label="Search with a shadowed list"><input type="hidden" name="elements" value="1"><input type="hidden" name="k" value="{key}"><button>Search</button></form>
<form action="/search"><input type="search" aria-label="Search, unnamed"><button>Search</button></form>
<form action="/search" method="get"><input type="search" name="q" aria-label="Search, then posted" id="flip"><button>Search</button></form>
<script>
document.getElementById("formless").addEventListener("keydown", (event) => {
  if (event.key === "Enter") location.assign("/search?q=" + encodeURIComponent(event.target.value));
});
document.getElementById("flip").addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  const button = event.target.form.querySelector("button");
  button.formMethod = "post";
  button.formAction = "/collect";
});
</script>`;

// A transport operator's journey planner: two station lists, departure or
// arrival, a day and a time, and a button that posts the form to the site.
// Beside it, a list of lines with no label, a list the page posts to its own
// site when it changes, and one it posts to another site.
const STATIONS = ["24 Agosto", "Aeroporto", "Aliados", "Bolhão", "Campanhã", "São Bento", "Trindade"];
const stationOptions = STATIONS.map((station) => `<option>${station}</option>`).join("");
const PLANNER = `<h1>Journey Planner</h1>
<form action="/route" method="post">
<label for="start">Start</label><select id="start" name="start">${stationOptions}</select>
<label for="end">End</label><select id="end" name="end">${stationOptions}</select>
<select name="type" aria-label="Type"><option>Departure</option><option>Arrival</option></select>
<label for="day">Day</label><input id="day" type="date" name="day" value="2026-10-31">
<label for="time">Time</label><input id="time" type="time" name="time" value="09:00">
<input type="submit" value="Plan Your Journey">
</form>
<select name="line"><option>All lines</option><option>Line A</option><option>Line D</option></select>
<form action="/lines" method="post"><label for="status">Line status</label>
<select id="status" name="status" onchange="this.form.submit()"><option>Today</option><option>Tomorrow</option></select></form>
<form action="{other}/collect" method="post"><label for="sort">Sort stations</label>
<select id="sort" name="sort" onchange="this.form.submit()"><option>By name</option><option>By line</option></select></form>`;
// Other lists a person meets: lists inside their own labels, a list of cars
// with a "Swift" among them, one that holds several options at once, a long
// list, and a bulk-actions list the page posts to another site when it
// changes.
const AIRPORTS = Array.from({ length: 1_200 }, (_, index) => `Airport ${String(index + 1).padStart(4, "0")}`);
const LISTS = `<h1>Lists</h1>
<form action="/route" method="post">
<label>Start <select name="start">${stationOptions}</select></label>
<label>Action <select name="action"><option>View</option> <option>Delete</option></select></label>
<input type="submit" value="Go">
</form>
<label for="car">Car</label><select id="car" name="car"><option>Fiat Panda</option><option>Suzuki Swift</option></select>
<label for="topics">Topics</label><select id="topics" name="topics" multiple size="3"><option selected>Art</option><option selected>Music</option><option>Sport</option></select>
<label for="airport">Airport</label><select id="airport" name="airport">${AIRPORTS.map((name) => `<option>${name}</option>`).join("")}</select>
<form action="{other}/collect" method="post"><label for="bulk">Bulk actions</label>
<select id="bulk" name="bulk" onchange="this.form.submit()"><option>Select all</option><option>Delete selected</option></select></form>`;
// A list whose option signs in with another account.
const ACCOUNT_LIST = `<h1>Account</h1>
<label for="account">Account</label><select id="account" onchange="location.href = '/oauth/' + this.value"><option value="none">Choose</option><option value="github">Sign in with GitHub</option></select>`;
// A page that shows recovery codes, with a list of them.
const CODES = `<h1>Recovery codes</h1><p>Keep these recovery codes somewhere safe.</p><p><code>{key}</code></p>
<label for="used">Mark as used</label><select id="used"><option>4829 1037</option><option>7731 2284</option></select>`;
// A list whose two stations trade places every two milliseconds while the
// option it holds stays, and which notes the option it holds each time it
// changes.
const FLIP = `<h1>Departures</h1>
<label for="from">From</label><select id="from"><option>Choose a station</option><option label="Sao Bento">first</option><option label="Trindade">second</option></select>
<script>
const from = document.getElementById("from");
window.seen = [];
from.addEventListener("change", () => window.seen.push(from.selectedOptions[0].label));
setInterval(() => {
  const [, first, second] = from.options;
  [first.label, second.label] = [second.label, first.label];
}, 2);
</script>`;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => `&#${character.codePointAt(0)};`);

export async function runSharedBrowserFormSubmissionFixture() {
  assert.ok(fs.existsSync(executablePath), "Locked Playwright Chromium is missing; run pnpm --filter @instafy/frontend exec playwright install chromium");
  fs.mkdirSync(resultDirectory, { recursive: true });
  fs.rmSync(resultFile, { force: true });
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instafy-form-submission-e2e-")));
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
    // One server answers for every fixture site and records each request as
    // "<METHOD> <origin><path>", so a step that sends nothing is seen to.
    const requests = [];
    let port = 0;
    // The same requests with their queries, for the searches that must send
    // exactly what was typed.
    const searches = [];
    // The journeys the planner was asked for, as the form posted them.
    const routes = [];
    const sites = () => ({
      shop: `http://shop.test:${port}`,
      mall: `http://mall.test:${port}`,
      sub: `http://www.mall.test:${port}`,
      other: `http://other.test:${port}`,
      transit: `http://transit.test:${port}`,
    });
    const fill = (html, name = "") => html
      .replaceAll("{shop}", sites().shop)
      .replaceAll("{other}", sites().other)
      .replaceAll("{sub}", sites().sub)
      .replaceAll("{key}", KEY_LIKE)
      .replaceAll("{page}", `${sites().shop}/case/${name}`);
    server = createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      if (url.pathname === "/favicon.ico") {
        response.writeHead(404).end();
        return;
      }
      requests.push(`${request.method} ${url.origin}${url.pathname}`);
      searches.push(`${request.method} ${url.origin}${url.pathname}${url.search}`);
      if (request.method === "POST" && url.pathname === "/route") {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          const journey = Object.fromEntries(new URLSearchParams(body));
          routes.push(journey);
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(page("Your journey", `<h1>Your journey</h1><p>From ${escapeHtml(journey.start)} to ${escapeHtml(journey.end)}: take Line D towards Hospital S. João, 1 stop, about 2 minutes.</p>`));
        });
        return;
      }
      request.resume();
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      const name = url.pathname.startsWith("/case/") ? decodeURIComponent(url.pathname.slice("/case/".length)) : "";
      const entry = table.cases.find((candidate) => candidate.name === name);
      if (entry) {
        response.end(page(entry.name, fill(entry.html, entry.name)));
      } else if (url.pathname === "/scenario/hostile") {
        response.end(page("Shop", fill(HOSTILE)));
      } else if (url.pathname === "/scenario/based") {
        response.end(page("Notes", fill(BASED)));
      } else if (url.pathname === "/scenario/stray") {
        response.end(page("Mall", fill(STRAY)));
      } else if (url.pathname === "/scenario/search") {
        response.end(page("Places", fill(SEARCH)));
      } else if (url.pathname === "/scenario/search-checks") {
        response.end(page("Searches", fill(SEARCH_CHECKS)));
      } else if (url.pathname === "/scenario/planner") {
        response.end(page("Journey Planner", fill(PLANNER)));
      } else if (url.pathname === "/scenario/lists") {
        response.end(page("Lists", fill(LISTS)));
      } else if (url.pathname === "/scenario/account") {
        response.end(page("Account", fill(ACCOUNT_LIST)));
      } else if (url.pathname === "/scenario/codes") {
        response.end(page("Recovery codes", fill(CODES)));
      } else if (url.pathname === "/scenario/flip") {
        response.end(page("Departures", fill(FLIP)));
      } else {
        response.end(page("Fixture", `<p>${request.method} ${url.pathname}</p>`));
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    port = server.address().port;

    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath,
      headless: true,
      viewport: { width: 1000, height: 800 },
      env: environment,
      // No host but the loopback fixtures resolves, so nothing leaves the machine.
      args: [
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        "--host-resolver-rules=MAP shop.test 127.0.0.1, MAP mall.test 127.0.0.1, MAP www.mall.test 127.0.0.1, MAP other.test 127.0.0.1, MAP transit.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
    });
    const runPage = context.pages()[0];
    const openPages = () => context.pages().filter((entry) => !entry.isClosed());

    // 1. The table, in real Chromium.
    const rulesSource = formSubmissionRulesInPage.toString();
    for (const entry of table.cases) {
      const casePage = await context.newPage();
      await casePage.goto(`${sites().shop}/case/${entry.name}`);
      if (entry.setup) await casePage.evaluate(`(() => { ${fill(entry.setup, entry.name)} })()`);
      const reported = await casePage.evaluate(`(() => {
        const element = document.getElementById("step");
        const result = (${rulesSource})().submissionOf(element, element.closest("form"));
        if (!result) return null;
        const { form, ...facts } = result;
        return facts;
      })()`);
      assert.deepEqual(reported, { ...entry.submission, action: fill(entry.submission.action, entry.name) }, entry.name);
      const before = openPages().length;
      requests.length = 0;
      if (entry.step === "click") {
        await casePage.click("#step", { noWaitAfter: true });
      } else {
        await casePage.press("#step", "Enter", { noWaitAfter: true });
      }
      const sends = entry.sends ? [fill(entry.sends, entry.name)] : [];
      for (let attempt = 0; attempt < 100 && requests.length < sends.length; attempt += 1) await delay(20);
      await delay(300);
      assert.deepEqual(requests, sends, `${entry.name}: what Chromium sent`);
      assert.equal(openPages().length, before + (entry.submission.newWindow && entry.submission.submits ? 1 : 0), `${entry.name}: windows`);
      for (const opened of openPages()) {
        if (opened !== runPage) await opened.close();
      }
    }

    // 2. The production controller on the run's page.
    await runPage.goto(`${sites().shop}/scenario/hostile`);
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
    const authority = {
      version: 2, ownerId: randomUUID(), runId: randomUUID(),
      initiatorUserId: "00000000-0000-4000-8000-000000000004",
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
          INSTAFY_PLAYWRIGHT_CDP_URL: `http://127.0.0.1:${cdpPort}`,
          INSTAFY_BROWSER_AGENT_CONTROL_FILE: markerPath,
          INSTAFY_SHARED_BROWSER_APPROVAL_DIR: approvalDirectory,
          INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS: "5000",
          INSTAFY_BROWSER_ACTIONS_FILE: actionsPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.add(child);
      // A child killed for an unexpected prompt may not have read its script.
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
          assert.ok(decision, `Unexpected prompt during ${requestPath}: ${request.kind} ${request.display?.label} (${request.destinationOrigin})`);
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
    const control = (snapshot, label) => {
      const found = snapshot.interactiveElements.find((element) => element.label === label);
      assert.ok(found, `${label} is observed: ${snapshot.interactiveElements.map((element) => element.label).join(", ")}`);
      return found;
    };
    const promptsSince = (start) => prompts.slice(start).map((prompt) => [prompt.kind, prompt.operation, prompt.destinationOrigin]);
    const sentTo = (target) => requests.filter((entry) => entry === target);
    const collect = `POST ${sites().other}/collect`;

    // a. Enter in a search field whose default button posts to another
    // site: Octo is asked for that site first (the prompt names where the
    // form goes), then for the step bound to it, and nothing is sent until
    // both are allowed. A declined site stays closed for the rest of the run
    // without another prompt; the person's next run asks again.
    let snapshot = await ok("GET", "/v1/snapshot", null, ["allow_origin"]);
    let field = control(snapshot, "Search the shop");
    let start = prompts.length;
    requests.length = 0;
    await refused(/\[site_declined\]/, "POST", "/v1/type", { index: field.index, snapshotId: snapshot.snapshotId, text: "boots", submit: true }, ["deny"]);
    assert.deepEqual(promptsSince(start), [["origin", "approve-origin", sites().other]]);
    assert.equal(prompts.at(-1).display.label, `Send this form to ${sites().other}/collect`);
    assert.deepEqual(sentTo(collect), [], "Nothing was sent to the other site");
    snapshot = await ok("GET", "/v1/snapshot");
    field = control(snapshot, "Search the shop");
    start = prompts.length;
    await refused(/\[site_declined\]/, "POST", "/v1/type", { index: field.index, snapshotId: snapshot.snapshotId, text: "boots", submit: true });
    assert.deepEqual(promptsSince(start), [], "A declined site is not asked for again in the run");
    assert.deepEqual(sentTo(collect), [], "Nothing was sent to the declined site");
    // The person's next run starts with no approvals and asks again.
    for (const name of fs.readdirSync(approvalDirectory)) fs.rmSync(path.join(approvalDirectory, name));
    Object.assign(authority, { ownerId: randomUUID(), runId: randomUUID() });
    writeProtectedJson(markerPath, authority);
    snapshot = await ok("GET", "/v1/snapshot", null, ["allow_origin"]);
    field = control(snapshot, "Search the shop");
    start = prompts.length;
    await ok("POST", "/v1/type", { index: field.index, snapshotId: snapshot.snapshotId, text: "boots", submit: true }, ["allow_origin", "allow_once"]);
    assert.deepEqual(promptsSince(start), [["origin", "approve-origin", sites().other], ["action", "form-submit", sites().other]]);
    assert.deepEqual(sentTo(collect), [collect], "The allowed step sent exactly what it was allowed to");

    // b. A form whose submit button opens another window: refused before any
    // prompt; no window opens and nothing is sent.
    await runPage.goto(`${sites().shop}/scenario/hostile`);
    snapshot = await ok("GET", "/v1/snapshot");
    field = control(snapshot, "Find in a new window");
    start = prompts.length;
    const pagesBefore = openPages().length;
    requests.length = 0;
    await refused(/opens another window/, "POST", "/v1/press", { index: field.index, snapshotId: snapshot.snapshotId, key: "Enter" });
    assert.deepEqual(promptsSince(start), [], "Refused before any prompt");
    await delay(300);
    assert.equal(openPages().length, pagesBefore, "No window opened");
    assert.deepEqual(requests, [], "Nothing was sent");

    // c. A <base href> on another site: the form's relative action goes
    // there, and the step's prompt names that site.
    await runPage.goto(`${sites().shop}/scenario/based`);
    snapshot = await ok("GET", "/v1/snapshot");
    const note = control(snapshot, "Note");
    start = prompts.length;
    requests.length = 0;
    await refused(/approval_denied|denied/i, "POST", "/v1/type", { index: note.index, snapshotId: snapshot.snapshotId, text: "hello", submit: true }, ["deny"]);
    assert.deepEqual(promptsSince(start), [["action", "form-submit", sites().other]]);
    assert.deepEqual(requests, [], "Nothing was sent");

    // Ask mode: the person asked to review every step, so a site's own GET
    // search asks too, for the typed search and for Enter alike.
    await runPage.goto(`${sites().shop}/scenario/search`);
    snapshot = await ok("GET", "/v1/snapshot");
    let places = control(snapshot, "Search places");
    start = prompts.length;
    requests.length = 0;
    await refused(/approval_denied|denied/i, "POST", "/v1/type", { index: places.index, snapshotId: snapshot.snapshotId, text: "Belém Tower", submit: true }, ["deny"]);
    await refused(/approval_denied|denied/i, "POST", "/v1/press", { index: places.index, snapshotId: snapshot.snapshotId, key: "Enter" }, ["deny"]);
    assert.deepEqual(promptsSince(start), [["action", "form-submit", sites().shop], ["action", "press-enter", sites().shop]]);
    assert.deepEqual(requests, [], "Nothing was sent in Ask mode");

    // d. Routine browsing (allowed on a third site): a click on a label that
    // clicks a hidden submit button, and Enter in the hostile search field,
    // still ask, bound to the other site, and send nothing when denied.
    await runPage.goto(`${sites().mall}/scenario/hostile`);
    snapshot = await ok("GET", "/v1/snapshot", null, ["allow_routine"]);
    const label = control(snapshot, "Read the reviews");
    start = prompts.length;
    requests.length = 0;
    await refused(/approval_denied|denied/i, "POST", "/v1/click", { index: label.index, snapshotId: snapshot.snapshotId }, ["deny"]);
    assert.deepEqual(promptsSince(start), [["action", "click", sites().other]]);
    snapshot = await ok("GET", "/v1/snapshot");
    field = control(snapshot, "Search the shop");
    start = prompts.length;
    await refused(/approval_denied|denied/i, "POST", "/v1/press", { index: field.index, snapshotId: snapshot.snapshotId, key: "Enter" }, ["deny"]);
    assert.deepEqual(promptsSince(start), [["action", "press-enter", sites().other]]);
    await delay(300);
    assert.deepEqual(sentTo(collect), [], "No cross-site POST without its confirmation");

    // e. Forms the page moves or hides, under routine browsing on the same
    // site. The step's guard stops a form the page posts to a site the step
    // was not approved for, whatever sent it.
    const strayPage = `${sites().mall}/scenario/stray`;
    // A keydown handler moves the default button to another site after the
    // step was judged a free search of the page's own site.
    await runPage.goto(strayPage);
    snapshot = await ok("GET", "/v1/snapshot");
    field = control(snapshot, "Find a product");
    start = prompts.length;
    requests.length = 0;
    await refused(/sent a form to http:\/\/other\.test:\d+\/?, which the step was not approved to send to/, "POST", "/v1/press", { index: field.index, snapshotId: snapshot.snapshotId, key: "Enter" });
    assert.deepEqual(promptsSince(start), [], "A free search of the page's own site asks nothing");
    await delay(300);
    assert.deepEqual(sentTo(collect), [], "The moved form was stopped");
    // A routine click on a control whose click reaches a submit button the
    // describer cannot see: one in a closed shadow tree, one laid over it.
    for (const label of ["Reviews", "Specials"]) {
      await runPage.goto(strayPage);
      snapshot = await ok("GET", "/v1/snapshot");
      const hidden = control(snapshot, label);
      start = prompts.length;
      requests.length = 0;
      await refused(/sent a form to http:\/\/other\.test:\d+/, "POST", "/v1/click", { index: hidden.index, snapshotId: snapshot.snapshotId });
      assert.deepEqual(promptsSince(start), [], `${label}: routine, so nothing asked`);
      await delay(300);
      assert.deepEqual(sentTo(collect), [], `${label}: nothing was sent to the other site`);
    }
    // A field inside a hostile submit button: a click submits through that
    // button, so it is refused before any prompt, as is typing with submit.
    await runPage.goto(strayPage);
    snapshot = await ok("GET", "/v1/snapshot");
    const size = control(snapshot, "Shoe size");
    start = prompts.length;
    requests.length = 0;
    await refused(/sits inside the form's submit button/, "POST", "/v1/click", { index: size.index, snapshotId: snapshot.snapshotId });
    await refused(/sits inside the form's submit button/, "POST", "/v1/type", { index: size.index, snapshotId: snapshot.snapshotId, text: "42", submit: true });
    assert.deepEqual(promptsSince(start), [], "Refused before any prompt");
    // A control deep inside a hostile submit button asks, bound to the other
    // site, and sends nothing when denied.
    const deep = control(snapshot, "Deep reviews");
    assert.equal(deep.tag, "span", "the control deep inside the button, not the button");
    await refused(/approval_denied|denied/i, "POST", "/v1/click", { index: deep.index, snapshotId: snapshot.snapshotId }, ["deny"]);
    assert.deepEqual(promptsSince(start), [["action", "click", sites().other]]);
    await delay(300);
    assert.deepEqual(sentTo(collect), [], "No cross-site POST without its confirmation");

    // 3. Free same-site GET search under routine browsing (still on).
    const searchPage = `${sites().mall}/scenario/search`;
    const sentSearch = (query) => `GET ${sites().mall}/search?${query}`;
    // a. Typing with submit on the run's page sends exactly the GET the form
    // makes, with no prompt, and the result says it went free.
    await runPage.goto(searchPage);
    snapshot = await ok("GET", "/v1/snapshot");
    places = control(snapshot, "Search places");
    start = prompts.length;
    searches.length = 0;
    let searched = await ok("POST", "/v1/type", { index: places.index, snapshotId: snapshot.snapshotId, text: "Belém Tower", submit: true });
    assert.deepEqual(promptsSince(start), [], "A site's own GET search asks nothing under routine browsing");
    assert.deepEqual(searches, [sentSearch("q=Bel%C3%A9m+Tower&lang=en")], "It sent exactly the form's GET");
    assert.deepEqual(searched.activity, { step: "search", url: `${sites().mall}/search?q=Bel%C3%A9m+Tower&lang=en`, approval: "free" });
    // b. Enter in the field, with text typed first, goes the same way.
    await runPage.goto(searchPage);
    snapshot = await ok("GET", "/v1/snapshot");
    places = control(snapshot, "Search places");
    snapshot = await ok("POST", "/v1/type", { index: places.index, snapshotId: snapshot.snapshotId, text: "Jerónimos" });
    places = control(snapshot, "Search places");
    start = prompts.length;
    searches.length = 0;
    searched = await ok("POST", "/v1/press", { index: places.index, snapshotId: snapshot.snapshotId, key: "Enter" });
    assert.deepEqual(promptsSince(start), []);
    assert.deepEqual(searches, [sentSearch("q=Jer%C3%B3nimos&lang=en")]);
    assert.deepEqual(searched.activity, { step: "search", url: `${sites().mall}/search?q=Jer%C3%B3nimos&lang=en`, approval: "free" });
    // c. In one of Octo's own tabs, which refuse every other submission.
    const octoTab = await ok("POST", "/v1/tabs/open", { url: searchPage });
    snapshot = await ok("GET", "/v1/snapshot", { tabId: octoTab.tabId });
    places = control(snapshot, "Search places");
    start = prompts.length;
    searches.length = 0;
    searched = await ok("POST", "/v1/type", { index: places.index, snapshotId: snapshot.snapshotId, text: "Pastéis de Belém", submit: true });
    assert.deepEqual(promptsSince(start), []);
    assert.deepEqual(searches, [sentSearch("q=Past%C3%A9is+de+Bel%C3%A9m&lang=en")]);
    assert.deepEqual(searched.activity, { step: "search", url: `${sites().mall}/search?q=Past%C3%A9is+de+Bel%C3%A9m&lang=en`, approval: "free" });
    await ok("POST", "/v1/tabs/close", { tabId: octoTab.tabId });
    // d. A typed value that looks like a key asks, on the same search box.
    await runPage.goto(searchPage);
    snapshot = await ok("GET", "/v1/snapshot");
    places = control(snapshot, "Search places");
    start = prompts.length;
    requests.length = 0;
    await refused(/approval_denied|denied/i, "POST", "/v1/type", { index: places.index, snapshotId: snapshot.snapshotId, text: KEY_LIKE, submit: true }, ["deny"]);
    assert.deepEqual(promptsSince(start), [["action", "form-submit", sites().mall]]);
    assert.deepEqual(requests, [], "A key-like search was not sent");
    // e. Every other search box still asks, or is refused before any prompt,
    // and sends nothing when the person says no.
    const checksPage = `${sites().mall}/scenario/search-checks`;
    const asks = [
      ["Search, posted", sites().mall],
      ["Search another site", sites().other],
      ["Search a subdomain", sites().sub],
      ["Search without a form", sites().mall],
      ["Search, then sign out", sites().mall],
      ["Search with a key", sites().mall],
      // The browser sends the form's entries as the address's query, so a
      // hidden file format makes the search an export, which a navigation
      // to the same address asks for too.
      ["Search as a table", sites().mall],
      // A one-time code next to its name ("code=482910") looks secret.
      ["Search with a hidden number", sites().mall],
      // A control named "elements" hides the form's list from a page script
      // that reads form.elements; the hidden key is still found.
      ["Search with a shadowed list", sites().mall],
      // A field with no name sends nothing typed, so the box is the page
      // script's, like a search box with no form.
      ["Search, unnamed", sites().mall],
    ];
    for (const [label, destination] of asks) {
      await runPage.goto(checksPage);
      snapshot = await ok("GET", "/v1/snapshot");
      const box = control(snapshot, label);
      start = prompts.length;
      requests.length = 0;
      await refused(/approval_denied|denied/i, "POST", "/v1/type", { index: box.index, snapshotId: snapshot.snapshotId, text: "tower", submit: true }, ["deny"]);
      assert.deepEqual(promptsSince(start), [["action", "form-submit", destination]], `${label}: asks`);
      await delay(200);
      assert.deepEqual(requests, [], `${label}: nothing was sent`);
    }
    const refusals = [
      ["Search in a new window", /opens another window/],
      ["Search inside the button", /sits inside the form's submit button/],
      ["Search hotels", /Booking\.com is link-only/],
    ];
    for (const [label, reason] of refusals) {
      await runPage.goto(checksPage);
      snapshot = await ok("GET", "/v1/snapshot");
      const box = control(snapshot, label);
      start = prompts.length;
      requests.length = 0;
      await refused(reason, "POST", "/v1/type", { index: box.index, snapshotId: snapshot.snapshotId, text: "tower", submit: true });
      assert.deepEqual(promptsSince(start), [], `${label}: refused before any prompt`);
      await delay(200);
      assert.deepEqual(requests, [], `${label}: nothing was sent`);
    }
    // f. A page script that turns the free search into a post, even to the
    // page's own site, is stopped by the step's guard, and the step says so.
    await runPage.goto(checksPage);
    snapshot = await ok("GET", "/v1/snapshot");
    const flipped = control(snapshot, "Search, then posted");
    start = prompts.length;
    requests.length = 0;
    await refused(/sent a form to http:\/\/mall\.test:\d+\/?, which the step was not approved to send to/, "POST", "/v1/type", { index: flipped.index, snapshotId: snapshot.snapshotId, text: "tower", submit: true });
    assert.deepEqual(promptsSince(start), [], "Judged a free search before the page changed it");
    await delay(300);
    assert.deepEqual(sentTo(`POST ${sites().mall}/collect`), [], "The post was stopped before it left the browser");

    // 4. A journey planner, under routine browsing (still on). A list is
    // named by its own label, or by the option it holds when it has none,
    // never by all of its options run together, and says which option it
    // holds.
    const plannerPage = `${sites().transit}/scenario/planner`;
    const list = (observed, label) => {
      const found = control(observed, label);
      assert.equal(found.tag, "select", `${label} is a list`);
      return found;
    };
    await runPage.goto(plannerPage);
    snapshot = await ok("GET", "/v1/snapshot");
    assert.equal(list(snapshot, "Start").chosen, "24 Agosto");
    assert.equal(list(snapshot, "End").chosen, "24 Agosto");
    assert.equal(list(snapshot, "All lines").chosen, "All lines", "a list with no label is named by the option it holds");
    assert.ok(
      !snapshot.interactiveElements.some((element) => /Agosto ?Aeroporto|Line A ?Line D/.test(element.label)),
      "no list is named by its options",
    );
    // a. Choosing a start and an end station asks nothing and sends nothing;
    // a label reads the same with case and accents aside.
    start = prompts.length;
    requests.length = 0;
    let chosen = await ok("POST", "/v1/choose", { index: list(snapshot, "Start").index, snapshotId: snapshot.snapshotId, option: "São Bento" });
    assert.equal(list(chosen, "Start").chosen, "São Bento");
    assert.deepEqual(chosen.activity, { step: "choose", url: plannerPage, approval: "routine" });
    chosen = await ok("POST", "/v1/choose", { index: list(chosen, "End").index, snapshotId: chosen.snapshotId, option: "trindade" });
    assert.equal(list(chosen, "End").chosen, "Trindade");
    assert.equal(list(chosen, "Start").chosen, "São Bento");
    assert.deepEqual(promptsSince(start), [], "Choosing the stations asks nothing");
    assert.deepEqual(requests, [], "Choosing the stations sends nothing");
    assert.match(fs.readFileSync(actionsPath, "utf8"), /"label":"Choose \\"Trindade\\" in \\"End\\""/u);
    // A list with no label of its own is named by neither the option it holds
    // nor its options: its step names the option chosen alone.
    chosen = await ok("POST", "/v1/choose", { index: list(chosen, "All lines").index, snapshotId: chosen.snapshotId, option: "Line D" });
    assert.equal(list(chosen, "Line D").chosen, "Line D");
    assert.match(fs.readFileSync(actionsPath, "utf8").trim().split("\n").at(-1), /"label":"Choose \\"Line D\\"","url"/u);
    // An option the list does not have chooses nothing; the answer lists
    // the options, so the next try names one exactly.
    const missing = await refused(/No option in "Start" is called "Sao Bentoo", so nothing was chosen\. Its options: 24 Agosto, Aeroporto, Aliados, Bolhão, Campanhã, São Bento, Trindade\./u, "POST", "/v1/choose", { index: list(chosen, "Start").index, snapshotId: chosen.snapshotId, option: "Sao Bentoo" });
    assert.ok(!missing.includes("approval_"), missing);
    // A control that is not a list is refused, and nothing is typed.
    await refused(/choose sets a list the page draws as a select/u, "POST", "/v1/choose", { index: control(chosen, "Time").index, snapshotId: chosen.snapshotId, option: "10:00" });
    assert.deepEqual(promptsSince(start), [], "Neither asked");
    // b. The planner's own button asks once, naming the fields it sends and
    // never their values, and the route is read.
    const plan = control(chosen, "Plan Your Journey");
    const planned = await ok("POST", "/v1/click", { index: plan.index, snapshotId: chosen.snapshotId }, ["allow_once"]);
    assert.deepEqual(promptsSince(start), [["action", "click", sites().transit]], "The planner's button asks once");
    assert.equal(prompts.at(-1).display.label, "Change something: Plan Your Journey · Sends: Start, End, Type, Day, Time");
    assert.deepEqual(routes, [{ start: "São Bento", end: "Trindade", type: "Departure", day: "2026-10-31", time: "09:00" }]);
    assert.equal(planned.url, `${sites().transit}/route`);
    assert.match(planned.visibleText, /From São Bento to Trindade: take Line D/u);
    // c. A list the page posts when it changes may post to the page's own
    // site, as typing may, and to nowhere else: the step's guard stops it.
    await runPage.goto(plannerPage);
    snapshot = await ok("GET", "/v1/snapshot");
    start = prompts.length;
    requests.length = 0;
    const statusPosted = await ok("POST", "/v1/choose", { index: list(snapshot, "Line status").index, snapshotId: snapshot.snapshotId, option: "Tomorrow" });
    assert.deepEqual(sentTo(`POST ${sites().transit}/lines`), [`POST ${sites().transit}/lines`], "posted to the page's own site");
    assert.equal(statusPosted.activity.step, "choose");
    await runPage.goto(plannerPage);
    snapshot = await ok("GET", "/v1/snapshot");
    requests.length = 0;
    await refused(/sent a form to http:\/\/other\.test:\d+\/?, which the step was not approved to send to/u, "POST", "/v1/choose", { index: list(snapshot, "Sort stations").index, snapshotId: snapshot.snapshotId, option: "By line" });
    await delay(300);
    assert.deepEqual(sentTo(collect), [], "Nothing was posted to the other site");
    assert.deepEqual(promptsSince(start), [], "Neither asked");

    // d. Ask mode, in the person's next run: each choice asks, naming the
    // option and the list by its own label, and a click on a list names the
    // list, never its options. Nothing is chosen when the person says no.
    for (const name of fs.readdirSync(approvalDirectory)) fs.rmSync(path.join(approvalDirectory, name));
    Object.assign(authority, { ownerId: randomUUID(), runId: randomUUID() });
    writeProtectedJson(markerPath, authority);
    await runPage.goto(plannerPage);
    snapshot = await ok("GET", "/v1/snapshot", null, ["allow_origin"]);
    start = prompts.length;
    await refused(/approval_denied|denied/i, "POST", "/v1/choose", { index: list(snapshot, "Start").index, snapshotId: snapshot.snapshotId, option: "São Bento" }, ["deny"]);
    assert.deepEqual(promptsSince(start), [["action", "choose", null]]);
    assert.equal(prompts.at(-1).display.label, "Change something: São Bento · In: Start");
    assert.equal(prompts.at(-1).destinationOrigin, null);
    snapshot = await ok("GET", "/v1/snapshot");
    assert.equal(list(snapshot, "Start").chosen, "24 Agosto", "Nothing was chosen when the person said no");
    await refused(/approval_denied|denied/i, "POST", "/v1/click", { index: list(snapshot, "Start").index, snapshotId: snapshot.snapshotId }, ["deny"]);
    assert.equal(prompts.at(-1).operation, "click");
    assert.equal(prompts.at(-1).display.label, "Change something: Start");
    // A list with no label of its own: the prompt names the option alone.
    await refused(/approval_denied|denied/i, "POST", "/v1/choose", { index: list(snapshot, "All lines").index, snapshotId: snapshot.snapshotId, option: "Line A" }, ["deny"]);
    assert.equal(prompts.at(-1).operation, "choose");
    assert.equal(prompts.at(-1).display.label, "Change something: Line A");

    // 5. Other lists, under routine browsing in the person's next run.
    for (const name of fs.readdirSync(approvalDirectory)) fs.rmSync(path.join(approvalDirectory, name));
    Object.assign(authority, { ownerId: randomUUID(), runId: randomUUID() });
    writeProtectedJson(markerPath, authority);
    const listsPage = `${sites().transit}/scenario/lists`;
    await runPage.goto(listsPage);
    snapshot = await ok("GET", "/v1/snapshot", null, ["allow_routine"]);
    // a. A list inside its own label is named by the label's own words, never
    // its options, and its other options' words never count: choosing "View"
    // beside "Delete" asks nothing.
    assert.equal(list(snapshot, "Start").chosen, "24 Agosto");
    assert.equal(list(snapshot, "Action").chosen, "View");
    assert.ok(
      !snapshot.interactiveElements.some((element) => /Agosto ?Aeroporto|View ?Delete/.test(element.label)),
      "no list is named by its options",
    );
    start = prompts.length;
    requests.length = 0;
    chosen = await ok("POST", "/v1/choose", { index: list(snapshot, "Start").index, snapshotId: snapshot.snapshotId, option: "Aliados" });
    assert.equal(list(chosen, "Start").chosen, "Aliados");
    assert.match(fs.readFileSync(actionsPath, "utf8").trim().split("\n").at(-1), /"label":"Choose \\"Aliados\\" in \\"Start\\""/u);
    chosen = await ok("POST", "/v1/choose", { index: list(chosen, "Action").index, snapshotId: chosen.snapshotId, option: "View" });
    assert.equal(list(chosen, "Action").chosen, "View");
    // b. A list of cars with a "Swift" among them is no payment field.
    chosen = await ok("POST", "/v1/choose", { index: list(chosen, "Car").index, snapshotId: chosen.snapshotId, option: "Suzuki Swift" });
    assert.equal(list(chosen, "Car").chosen, "Suzuki Swift");
    // c. A list that holds several options at once is left to the person:
    // choose sets one, and would drop the ones it holds.
    await refused(/"Topics" holds several options at once/u, "POST", "/v1/choose", { index: list(chosen, "Topics").index, snapshotId: chosen.snapshotId, option: "Sport" });
    assert.deepEqual(
      await runPage.evaluate(() => Array.from(document.getElementById("topics").selectedOptions, (option) => option.label)),
      ["Art", "Music"],
    );
    // d. An option past the first thousand of a long list is found.
    snapshot = await ok("GET", "/v1/snapshot");
    chosen = await ok("POST", "/v1/choose", { index: list(snapshot, "Airport").index, snapshotId: snapshot.snapshotId, option: "Airport 1100" });
    assert.equal(list(chosen, "Airport").chosen, "Airport 1100");
    assert.deepEqual(promptsSince(start), [], "None of these asked");
    assert.deepEqual(requests, [], "None of these sent anything");
    // e. A risky choice the person allows still sends no form to another
    // site, which its prompt never named.
    start = prompts.length;
    await refused(/sent a form to http:\/\/other\.test:\d+\/?, which the step was not approved to send to/u, "POST", "/v1/choose", { index: list(chosen, "Bulk actions").index, snapshotId: chosen.snapshotId, option: "Delete selected" }, ["allow_once"]);
    assert.deepEqual(promptsSince(start), [["action", "choose", null]]);
    assert.equal(prompts.at(-1).display.label, "Delete, cancel or sign out: Delete selected · In: Bulk actions");
    await delay(300);
    assert.deepEqual(sentTo(collect), [], "Nothing was posted to the other site");
    // f. In one of Octo's own tabs, which are for reading, a list the page
    // posts when it changes sends no form, even to the page's own site.
    const readingTab = await ok("POST", "/v1/tabs/open", { url: plannerPage });
    snapshot = await ok("GET", "/v1/snapshot", { tabId: readingTab.tabId });
    start = prompts.length;
    requests.length = 0;
    await refused(/sent a form to http:\/\/transit\.test:\d+\/?, which the step was not approved to send to/u, "POST", "/v1/choose", { index: list(snapshot, "Line status").index, snapshotId: snapshot.snapshotId, option: "Tomorrow" });
    await delay(300);
    assert.deepEqual(sentTo(`POST ${sites().transit}/lines`), [], "Nothing was posted from Octo's own tab");
    assert.deepEqual(promptsSince(start), []);
    await ok("POST", "/v1/tabs/close", { tabId: readingTab.tabId });
    // g. An option that signs in with another account is the person's step,
    // as a click on the same words is: refused before any prompt.
    await runPage.goto(`${sites().transit}/scenario/account`);
    snapshot = await ok("GET", "/v1/snapshot");
    start = prompts.length;
    requests.length = 0;
    await refused(/\[step_refused_sign_in\]/u, "POST", "/v1/choose", { index: list(snapshot, "Account").index, snapshotId: snapshot.snapshotId, option: "Sign in with GitHub" });
    await delay(200);
    assert.deepEqual(promptsSince(start), []);
    assert.deepEqual(requests, [], "Nothing was opened");
    // h. On a page that may show a secret, an option the list does not have
    // chooses nothing, and the answer names none of the list's options.
    await runPage.goto(`${sites().transit}/scenario/codes`);
    snapshot = await ok("GET", "/v1/snapshot");
    assert.equal(snapshot.secretScreen, true);
    const unlisted = await refused(/No option in "Mark as used" is called "anything", so nothing was chosen\./u, "POST", "/v1/choose", { index: list(snapshot, "Mark as used").index, snapshotId: snapshot.snapshotId, option: "anything" });
    assert.ok(!/4829|7731/u.test(unlisted), unlisted);
    // i. The option chosen is the one named, even on a page that moves its
    // options while Octo chooses: no choice that goes through picks another,
    // and one that cannot be bound to the option chooses nothing.
    let flips = 0;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await runPage.goto(`${sites().transit}/scenario/flip`);
      snapshot = await ok("GET", "/v1/snapshot");
      const tried = await runTool("POST", "/v1/choose", { index: list(snapshot, "From").index, snapshotId: snapshot.snapshotId, option: "Sao Bento" });
      const seen = await runPage.evaluate(() => window.seen);
      if (tried.code !== 0) {
        assert.match(tried.stderr, /The page changed before this step ran/u);
        assert.deepEqual(seen, [], "nothing was chosen");
        continue;
      }
      assert.deepEqual(seen, ["Sao Bento"], "the option chosen is the one named");
      flips += 1;
    }
    assert.ok(flips >= 6, `most choices went through (${flips} of 12)`);

    const result = {
      status: "passed",
      fixtureVersion: 4,
      cases: table.cases.length,
      prompts: prompts.length,
      checks: [
        "every form-submission table case: the shared rules report what Chromium then sends",
        "Enter through a hostile default button asks for the other site, then for the step bound to it",
        "an allowed form step sends exactly what was allowed",
        "a form that opens another window is refused before any prompt and opens nothing",
        "a relative action under <base href> is bound to the base's site",
        "under routine browsing, a label of a hidden submit button and Enter through a hostile default button still ask",
        "a form a keydown handler moves to another site after approval is stopped before it is sent",
        "a routine click that reaches a submit button in a closed shadow tree, or one laid over the control, sends nothing elsewhere",
        "a field inside a submit button is refused before any prompt; a control nested deep inside one asks for the button's site",
        "in Ask mode a site's own GET search asks, typed or by Enter",
        "under routine browsing a GET search of the page's own origin goes without a prompt, sends exactly the form's GET and says approval free, in the run's page and in Octo's own tab",
        "a key-like typed value, a default button that posts, another site, another subdomain, no form, a sign-out address, a hidden key-like value (also behind a control named elements), a hidden one-time code, a hidden file format and an unnamed field still ask; a new window, a field inside a submit button and a link-only destination are refused before any prompt",
        "a page script that turns a free search into a post to its own site is stopped by the step's guard",
        "under routine browsing a journey planner's start and end stations are chosen by label with no prompt and nothing sent, its own button asks once naming the fields it sends, and the route is read",
        "a list is named by its own label or the option it holds, never its options, and a snapshot says which option it holds",
        "an option a list does not have chooses nothing and the answer lists the options; a control that is no list is refused",
        "a list the page posts when it changes may post to its own site, and a post elsewhere is stopped by the step's guard",
        "in Ask mode a choice asks, naming the option and the list, or the option alone for a list with no label, and a click on a list names the list",
        "a list inside its own label is named by the label's own words, and its other options' words never count",
        "a car list with a Swift is no payment field, a list that holds several options is left to the person, and an option past the first thousand is found",
        "a risky choice the person allows, and a choice in Octo's own tab, send no form anywhere the step was not approved to send it",
        "an option that signs in with another account is refused before any prompt, and an answer on a page that may show a secret names no option",
        "a list that moves its options while Octo chooses never gets another option than the one named",
      ],
      limitations: [
        "No model, Studio UI, origin or runtime shutdown guard; those are unit-tested.",
      ],
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
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/shared-browser-form-submission-e2e.mjs (no filters or skips)");
  runSharedBrowserFormSubmissionFixture().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    fs.mkdirSync(resultDirectory, { recursive: true });
    fs.writeFileSync(resultFile, `${JSON.stringify({ status: "failed", fixtureVersion: 4 })}\n`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
