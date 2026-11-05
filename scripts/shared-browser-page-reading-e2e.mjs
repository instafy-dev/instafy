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

// Real-browser proof that a page's reading says what it cannot read, and what
// a person sees chosen or turned off, so Octo never has to guess. The
// production controller script, composed as runtime-agent composes it, reads
// loopback fixture pages in one Chromium:
// 1. A details' summary is a control that says whether its section is open,
//    and opening it reads the section; tabs a page takes out of the tab order
//    are listed, and the one shown says it is selected.
// 2. The radio button, box, radio link and open list's option the page shows
//    chosen say so, and only those.
// 3. A control the page turned off is listed as disabled, and a step on it is
//    refused at once: nothing is sent and nothing is asked.
// 4. A frame is named by its site where it shows, and a canvas as a picture
//    with no text; a tracking frame and an icon are nothing, and no word of a
//    frame's page is read.
// 5. A page longer than the reading says where its text is cut and how far to
//    scroll, and scrolling reads all of it, within the reading's size; past
//    the control limit the controls scrolled past go first, so scrolling
//    reaches the page's last link, and the ones left out are counted.
// 6. Password, card and one-time-code fields inside a frame or a shadow root
//    never reach the reading with what they hold, and a key in a shadow root's
//    read-only field still makes the page a secret screen.
// Every site is a loopback fixture; Chromium resolves no other host.
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendRequire = createRequire(path.join(repositoryRoot, "packages/frontend/package.json"));
const playwrightRequire = createRequire(frontendRequire.resolve("@playwright/test"));
const { chromium } = playwrightRequire("playwright");
const playwrightDirectory = fs.realpathSync(path.dirname(playwrightRequire.resolve("playwright/package.json")));
const executablePath = chromium.executablePath();
// Retained with the co-browsing fixture's results, whose CI step runs this one.
const resultDirectory = path.join(repositoryRoot, "packages/frontend/test-results/browser-ci/shared-cobrowsing");
const resultFile = path.join(resultDirectory, "page-reading-result.json");
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
// The reading's text cap (MAX_VISIBLE_TEXT_CHARS in the controller).
const TEXT_CAP = 12_000;
// Values fields hold, which no reading may carry. Assembled at run time so the
// source holds no key-shaped literal.
const PASSWORD = ["Inert", "Pass", "word", "4471"].join("");
const CARD = ["4111", "1111", "1111", "1111"].join(" ");
const CODE = ["58", "21", "94"].join("");
const KEY_LIKE = ["a8Fk2LmQ", "9zXw7Rt4", "Yb6Nc1Vd"].join("");

function writeProtectedJson(destination, value) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, destination);
}

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title></head><body>${body}</body></html>`;

// A visit page: opening hours behind a closed details, prices in an open one,
// and two tab sets, one of buttons and one of generic elements the page takes
// out of the tab order, each with its other panels hidden.
const COLLAPSED = `<h1>Visit</h1>
<details><summary>Opening hours</summary><p>Monday to Friday 09:00 - 19:00</p></details>
<details open><summary>Prices</summary><p>Adult ticket 10 euros</p></details>
<div role="tablist" aria-label="Product">
<button role="tab" aria-selected="true" aria-controls="overview">Overview</button>
<button role="tab" aria-selected="false" aria-controls="specs" tabindex="-1">Specs</button>
</div>
<div role="tabpanel" id="overview">A light laptop for work.</div>
<div role="tabpanel" id="specs" hidden>Battery: 20 hours.</div>
<div role="tablist" aria-label="Timetable">
<div role="tab" tabindex="0" aria-selected="true" id="weekdays">Weekdays</div>
<div role="tab" tabindex="-1" aria-selected="false" id="weekends">Weekends</div>
</div>
<div role="tabpanel" id="weekdays-panel">Every 10 minutes.</div>
<div role="tabpanel" id="weekends-panel" hidden>Every 20 minutes.</div>
<script>
for (const tab of document.querySelectorAll("[role=tab]")) {
  tab.addEventListener("click", () => {
    for (const other of tab.parentElement.querySelectorAll("[role=tab]")) other.setAttribute("aria-selected", String(other === tab));
    if (tab.id === "weekends") {
      document.getElementById("weekdays-panel").hidden = true;
      document.getElementById("weekends-panel").hidden = false;
    }
  });
}
</script>`;
// An order form with a size chosen, a topping chosen, an edition chosen by a
// radio link, and a station list drawn open with one option selected.
const CHOICES = `<h1>Order</h1>
<fieldset><legend>Size</legend>
<label><input type="radio" name="size" value="s"> Small</label>
<label><input type="radio" name="size" value="m" checked> Medium</label>
<label><input type="radio" name="size" value="l"> Large</label></fieldset>
<fieldset><legend>Toppings</legend>
<label><input type="checkbox" name="t" value="cheese" checked> Cheese</label>
<label><input type="checkbox" name="t" value="onion"> Onion</label></fieldset>
<div role="radiogroup" aria-label="Edition">
<a href="/edition/diy" role="radio" aria-checked="true">DIY Edition</a>
<a href="/edition/prebuilt" role="radio" aria-checked="false">Pre-built</a></div>
<label for="to">To</label><input id="to" role="combobox" aria-expanded="true" aria-controls="stations">
<ul id="stations" role="listbox"><li role="option">Aliados</li><li role="option" aria-selected="true">Bolhao</li><li role="option">Campanha</li></ul>`;
// A journey planner whose second list and button wait for the first field.
const PLANNER = `<h1>Journey Planner</h1>
<form action="/route" method="post">
<label for="from">From</label><input id="from" name="from">
<label for="to">To</label><select id="to" name="to" disabled><option>Choose a start first</option></select>
<button id="plan" disabled>Plan Your Journey</button>
<button type="button" aria-disabled="true">Next week</button>
</form>`;
// What the reading cannot look into: a frame of this site, a booking engine's
// frame, a tracking frame, a map and a chart drawn on canvases, and an icon.
const UNREAD = `<h1>Book your stay</h1>
<p>Choose your dates below.</p>
<iframe src="/reading/widget" title="Prices" width="400" height="120"></iframe>
<iframe src="{frame}/booking" title="Booking" width="500" height="300"></iframe>
<iframe src="{frame}/pixel" width="0" height="0" style="border:0"></iframe>
<canvas width="600" height="300" aria-label="Map of the route"></canvas>
<canvas width="400" height="200"></canvas>
<canvas width="20" height="20"></canvas>
<p>After the frames.</p>`;
const LONG_SECTIONS = 40;
const LONG = `<h1>Review</h1>${Array.from({ length: LONG_SECTIONS }, (_, index) =>
  `<p>Section ${index + 1}. ${"The review goes on about battery life and the keyboard. ".repeat(18)}End of section ${index + 1}.</p>`).join("")}
<p>The verdict: worth it.</p>`;
const STOPS = 260;
const LINKS = `<h1>Stops</h1>${Array.from({ length: STOPS }, (_, index) =>
  `<p><a href="/stop/${index + 1}">Stop ${index + 1}</a></p>`).join("")}<p><a href="/stops?page=2">Next page</a></p>`;
// Sign-in, card and code fields inside another site's frame and inside a
// shadow root, each holding a value; and a page that shows a key in a shadow
// root's read-only field.
const SECRET_FIELDS = `<label>Password <input type="password" name="p" value="${PASSWORD}"></label>
<label>Card number <input name="cc" autocomplete="cc-number" value="${CARD}"></label>
<label>Code <input name="otp" autocomplete="one-time-code" value="${CODE}"></label>`;
const SECRETS = `<h1>Checkout</h1>
<iframe src="{frame}/fields" title="Payment" width="500" height="300"></iframe>
<pay-fields></pay-fields>
<script>
customElements.define("pay-fields", class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(SECRET_FIELDS)}; }
});
</script>`;
const SHADOW_KEY = `<h1>Settings</h1>
<key-card></key-card>
<script>
customElements.define("key-card", class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<h2>API keys</h2><label>Deploy <input readonly value='${KEY_LIKE}'></label><button>Copy</button>"; }
});
</script>`;

export async function runSharedBrowserPageReadingFixture() {
  assert.ok(fs.existsSync(executablePath), "Locked Playwright Chromium is missing; run pnpm --filter @instafy/frontend exec playwright install chromium");
  fs.mkdirSync(resultDirectory, { recursive: true });
  fs.rmSync(resultFile, { force: true });
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instafy-page-reading-e2e-")));
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
    // One server answers for both fixture sites and records each request.
    const requests = [];
    let port = 0;
    const sites = () => ({ site: `http://site.test:${port}`, frame: `http://frame.test:${port}` });
    const pages = {
      "site.test /reading/collapsed": page("Visit", COLLAPSED),
      "site.test /reading/choices": page("Order", CHOICES),
      "site.test /reading/planner": page("Journey Planner", PLANNER),
      "site.test /reading/unread": page("Book your stay", UNREAD),
      "site.test /reading/widget": page("Prices", "<p>Rooms from 120 euros</p><button>Check dates</button>"),
      "site.test /reading/long": page("Review", LONG),
      "site.test /reading/links": page("Stops", LINKS),
      "site.test /reading/secrets": page("Checkout", SECRETS),
      "site.test /reading/shadow-key": page("Settings", SHADOW_KEY),
      "frame.test /booking": page("Booking", "<h2>Booking engine</h2><label>Check-in <input type=\"date\"></label><button>Search rooms</button><p>Rooms from 140 euros</p>"),
      "frame.test /pixel": page("Pixel", "<p>pixel</p>"),
      "frame.test /fields": page("Payment", SECRET_FIELDS),
    };
    server = createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      requests.push(`${request.method} ${url.origin}${url.pathname}`);
      request.resume();
      const body = pages[`${url.hostname} ${url.pathname}`];
      if (body === undefined) {
        response.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end(page("Not found", "<p>Not found</p>"));
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(body.replaceAll("{frame}", sites().frame));
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
        "--host-resolver-rules=MAP site.test 127.0.0.1, MAP frame.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      ],
    });
    const runPage = context.pages()[0];
    await runPage.goto(`${sites().site}/reading/collapsed`);
    const session = await context.newCDPSession(runPage);
    const { targetInfo } = await session.send("Target.getTargetInfo");
    await session.detach();
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
      browserPageId: targetInfo.targetId, displayName: "Fixture assistant", expiresAtMs: Date.now() + 600_000,
    };
    writeProtectedJson(markerPath, authority);

    const prompts = [];
    // Routine browsing is granted for the fixture site on its first prompt;
    // any other prompt fails the step it came in.
    async function runTool(method, requestPath, body = null) {
      const child = spawn(process.execPath, ["-", method, requestPath, ...(body ? [JSON.stringify(body)] : [])], {
        cwd: temporary,
        env: {
          ...environment,
          INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: playwrightDirectory,
          INSTAFY_SHARED_BROWSER_TRUSTED_NODE_MODULES_ROOT: path.dirname(playwrightDirectory),
          INSTAFY_SHARED_BROWSER_PAGE_ID: targetInfo.targetId,
          INSTAFY_PLAYWRIGHT_CDP_URL: `http://127.0.0.1:${cdpPort}`,
          INSTAFY_BROWSER_AGENT_CONTROL_FILE: markerPath,
          INSTAFY_SHARED_BROWSER_APPROVAL_DIR: approvalDirectory,
          INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS: "5000",
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
          assert.equal(request.kind, "origin", `Unexpected prompt during ${requestPath}: ${request.display?.label}`);
          writeProtectedJson(path.join(approvalDirectory, "decision.json"), {
            version: 1, approvalId: request.approvalId, requestFingerprint: request.requestFingerprint,
            decision: "allow_routine", decidedByUserId: authority.initiatorUserId,
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
    const read = async (pathname) => {
      await runPage.goto(`${sites().site}${pathname}`);
      return await ok("GET", "/v1/snapshot");
    };
    const control = (reading, label) => {
      const found = reading.interactiveElements.find((entry) => entry.label === label);
      assert.ok(found, `${label} is listed: ${reading.interactiveElements.map((entry) => entry.label).join(", ")}`);
      return found;
    };
    const onLabels = (reading, field) => reading.interactiveElements.filter((entry) => entry[field] === true).map((entry) => entry.label);
    const measurements = {};

    // 1. Collapsed sections and tabs.
    let reading = await read("/reading/collapsed");
    assert.deepEqual(
      ["Opening hours", "Prices"].map((label) => [control(reading, label).tag, control(reading, label).expanded]),
      [["summary", false], ["summary", true]],
    );
    assert.ok(!reading.visibleText.includes("09:00"), "A closed section's text was read");
    assert.ok(reading.visibleText.includes("Adult ticket 10 euros"));
    assert.deepEqual(onLabels(reading, "selected"), ["Overview", "Weekdays"]);
    assert.equal(control(reading, "Specs").selected, undefined);
    assert.equal(control(reading, "Weekends").role, "tab", "A tab out of the tab order was not listed");
    assert.ok(!reading.visibleText.includes("Battery: 20 hours."), "A hidden tab panel was read");
    // Opening a section and a tab are free reading steps, and their results
    // read what they showed.
    const promptsBefore = prompts.length;
    let opened = await ok("POST", "/v1/click", { index: control(reading, "Opening hours").index, snapshotId: reading.snapshotId });
    assert.equal(control(opened, "Opening hours").expanded, true);
    assert.ok(opened.visibleText.includes("Monday to Friday 09:00 - 19:00"), "The opened section was not read");
    opened = await ok("POST", "/v1/click", { index: control(opened, "Weekends").index, snapshotId: opened.snapshotId });
    assert.deepEqual(onLabels(opened, "selected"), ["Overview", "Weekends"]);
    assert.ok(opened.visibleText.includes("Every 20 minutes."), "The opened tab's panel was not read");
    assert.equal(prompts.length, promptsBefore, "Opening a section or a tab asked");

    // 2. What is chosen.
    reading = await read("/reading/choices");
    assert.deepEqual(onLabels(reading, "checked"), ["Medium", "Cheese", "DIY Edition"]);
    assert.deepEqual(onLabels(reading, "selected"), ["Bolhao"]);
    assert.equal(control(reading, "Aliados").role, "option", "An open list's option was not listed");
    for (const entry of reading.interactiveElements) {
      for (const field of ["checked", "selected", "disabled"]) {
        assert.ok(entry[field] === undefined || entry[field] === true, `${field} is only there when it is true: ${JSON.stringify(entry)}`);
      }
    }

    // 3. Controls the page turned off.
    reading = await read("/reading/planner");
    assert.deepEqual(onLabels(reading, "disabled"), ["To", "Plan Your Journey", "Next week"]);
    assert.equal(control(reading, "From").disabled, undefined);
    requests.length = 0;
    const promptsBeforeOff = prompts.length;
    const refused = await runTool("POST", "/v1/click", { index: control(reading, "Plan Your Journey").index, snapshotId: reading.snapshotId });
    assert.equal(refused.code, 1, `A click on a control turned off ran: ${refused.stdout}`);
    assert.match(refused.stderr, /"Plan Your Journey" is turned off on the page right now, so nothing was done/);
    const chose = await runTool("POST", "/v1/choose", { index: control(reading, "To").index, snapshotId: reading.snapshotId, option: "Choose a start first" });
    assert.equal(chose.code, 1, `A choice in a list turned off ran: ${chose.stdout}`);
    assert.match(chose.stderr, /"To" is turned off on the page right now/);
    assert.deepEqual(requests, [], "A step on a control turned off sent something");
    assert.equal(prompts.length, promptsBeforeOff, "A step on a control turned off asked");

    // 4. Frames and canvases.
    reading = await read("/reading/unread");
    const lines = reading.visibleText.split("\n");
    assert.deepEqual(lines, [
      "Book your stay",
      "Choose your dates below.",
      "[frame not read: site.test]",
      "[frame not read: frame.test]",
      "[picture with no text: Map of the route]",
      "[picture with no text]",
      "After the frames.",
    ]);
    for (const unread of ["Rooms from", "Booking engine", "Search rooms", "Check dates", "pixel"]) {
      assert.ok(!JSON.stringify(reading).includes(unread), `A frame's page was read: ${unread}`);
    }

    // 5. A long page, read to its end by scrolling.
    reading = await read("/reading/long");
    const windows = [reading];
    const sizes = [];
    for (let step = 0; step < 10; step += 1) {
      const current = windows.at(-1);
      sizes.push(current.visibleText.length);
      assert.ok(current.visibleText.length <= TEXT_CAP, `The reading's text is over its cap: ${current.visibleText.length}`);
      const scrollBy = /\[Text cut here: about [\d,]+ more characters\. Scroll down \(y: (\d+)\) to read on\.\]$/.exec(current.visibleText);
      if (!scrollBy) break;
      windows.push(await ok("POST", "/v1/scroll", { y: Number(scrollBy[1]) }));
    }
    assert.ok(windows.length >= 3, `A long page read in ${windows.length} parts`);
    assert.ok(windows[0].visibleText.startsWith("Review\nSection 1."));
    for (const later of windows.slice(1)) {
      assert.match(later.visibleText, /^\[Text above not shown: about [\d,]+ characters\. Scroll up to read it\.\]\nSection \d+\./);
    }
    assert.ok(windows.at(-1).visibleText.endsWith("The verdict: worth it."), "Scrolling did not reach the page's end");
    const sectionsRead = new Set(windows.flatMap((entry) => Array.from(entry.visibleText.matchAll(/End of section (\d+)\./g), (match) => Number(match[1]))));
    assert.equal(sectionsRead.size, LONG_SECTIONS, `Sections never read: ${Array.from({ length: LONG_SECTIONS }, (_, index) => index + 1).filter((index) => !sectionsRead.has(index))}`);
    measurements.longPageParts = windows.length;
    measurements.longPageTextChars = sizes;
    measurements.longPageReadingBytes = windows.map((entry) => JSON.stringify(entry).length);
    const back = await ok("POST", "/v1/scroll", { y: -10_000 });
    assert.ok(back.visibleText.startsWith("Review\nSection 1."), "Scrolling back up did not read the page's top");
    // More controls than the list holds: the ones scrolled past go first.
    reading = await read("/reading/links");
    assert.equal(reading.interactiveElements.length, 200);
    assert.equal(reading.omittedControls, STOPS + 1 - 200, "The controls past the list's end were not counted");
    assert.ok(!reading.interactiveElements.some((entry) => entry.label === "Next page"));
    const bottom = await ok("POST", "/v1/scroll", { y: 10_000 });
    assert.equal(bottom.interactiveElements.length, 200);
    assert.equal(bottom.omittedControls, STOPS + 1 - 200);
    assert.equal(bottom.interactiveElements.at(-1).label, "Next page", "Scrolling down did not reach the page's last link");
    assert.equal(bottom.interactiveElements[0].label, `Stop ${STOPS + 1 - 200 + 1}`, "Controls in view were left out");

    // 6. Secrets in frames and shadow roots.
    reading = await read("/reading/secrets");
    const serialized = JSON.stringify(reading);
    for (const value of [PASSWORD, CARD, CODE, CARD.replaceAll(" ", "")]) {
      assert.ok(!serialized.includes(value), "A field's value reached the reading");
    }
    assert.ok(reading.visibleText.includes("[frame not read: frame.test]"));
    assert.deepEqual(
      reading.interactiveElements.filter((entry) => entry.tag === "input").map((entry) => entry.label),
      ["Password", "Card number", "Code"],
      "Only the shadow root's fields are listed; the frame's never",
    );
    const typed = await runTool("POST", "/v1/type", {
      index: control(reading, "Password").index, snapshotId: reading.snapshotId, text: "guess",
    });
    assert.equal(typed.code, 1, "Typing into a password field in a shadow root ran");
    reading = await read("/reading/shadow-key");
    assert.equal(reading.secretScreen, true, "A key in a shadow root's read-only field is no secret screen");
    assert.equal(reading.visibleText, "");
    assert.ok(!JSON.stringify(reading).includes(KEY_LIKE), "The key reached the reading");

    const result = {
      status: "passed", fixtureVersion: 1, browserVersion: context.browser()?.version() ?? "unknown",
      platform: process.platform, architecture: process.arch, nodeVersion: process.version,
      measurements,
      assertions: [
        "a details' summary is listed with whether it is open, and opening it reads its section; a tab out of the tab order is listed, and the tab shown says it is selected",
        "the radio button, box, radio link and open list's option shown chosen say so, and nothing else does",
        "a control turned off is listed as disabled, and a click or a choice on it is refused at once, sending and asking nothing",
        "a frame is named by its site and a canvas as a picture with no text, where they show; a tracking frame and an icon are nothing; no word of a frame is read",
        "a long page's text says where it is cut and how far to scroll, and scrolling reads every section within the reading's cap; past 200 controls the ones scrolled past go first and the rest are counted",
        "password, card and code fields in a frame or a shadow root carry no value into the reading, a frame's fields are never listed, and a key in a shadow root's read-only field still makes a secret screen",
      ],
      limitations: [
        "No model, Studio UI, origin or runtime shutdown guard; those are unit-tested.",
        "A closed shadow root is read by neither the text nor the controls, and says nothing.",
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
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/shared-browser-page-reading-e2e.mjs (no filters or skips)");
  runSharedBrowserPageReadingFixture().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    fs.mkdirSync(resultDirectory, { recursive: true });
    fs.writeFileSync(resultFile, `${JSON.stringify({ status: "failed", fixtureVersion: 1 })}\n`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
