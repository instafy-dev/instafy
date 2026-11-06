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
// 2. The radio button, box, radio link and list option the page shows chosen
//    say so, and only those: a suggestion the keys reach in a field's list
//    does not.
// 3. A control the page turned off is listed as disabled, and a step on it is
//    refused at once: nothing is sent and nothing is asked. A page full of
//    taken seats still lists the free ones and its button, and a text area is
//    never named by what it holds.
// 4. A frame is named by its site where it shows, and a canvas as a picture
//    with no text; a tracking frame and an icon are nothing, and no word of a
//    frame's page is read. A frame's site is no page text: a random-looking
//    one under a title with a credential word makes no secret screen.
// 5. A page longer than the reading says where its text is cut and how far to
//    scroll, and scrolling reads all of it, within the reading's size, past a
//    skip link and a pinned header, in a long paragraph and on a plain-text
//    page; one too long to reach where it is scrolled says so. Past the
//    control limit the controls scrolled past are left out, so scrolling
//    reaches the page's last link past hundreds of others, a closed list's
//    options never crowd out a form's fields, and the ones left out are
//    counted.
// 6. Password, card and one-time-code fields inside a frame or a shadow root
//    never reach the reading with what they hold, a key in a shadow root's
//    read-only field still makes the page a secret screen, as does a key in a
//    control's name the list leaves out, and a code drawn in boxes of their
//    own is masked.
// 7. A click acts on the control itself: a section a page marks open is no
//    control, and a click whose middle lands on a form's button or a frame
//    inside the control is refused, sending and asking nothing.
// 8. A cookie banner is the browser's: once a page settles, the browser
//    presses the banner's own reject button itself, never its accept or its
//    settings, and the step says so; never one with no reject button, one in a
//    frame, or one on a page with a sign-in field. A click that something
//    outside its control covers is refused at once, in words (a cookie notice
//    with no reject button says so), with no wait and no call log, and a cover
//    that goes within a moment is waited for.
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
const RECOVERY_CODES = ["4821 7730", "9912 0045"].join(" ");
// A random-looking site, as an ad server's frames often have.
const AD_SITE = `${["5f3c2a1b9e8d7c6b", "5a4f3e2d1c0b9a8f"].join("")}.ads.test`;

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
<ul id="stations" role="listbox"><li role="option">Aliados</li><li role="option" aria-selected="true">Bolhao</li><li role="option">Campanha</li></ul>
<ul role="listbox" aria-label="Line"><li role="option" aria-selected="true">Blue line</li><li role="option">Red line</li></ul>`;
// A journey planner whose second list and button wait for the first field.
const PLANNER = `<h1>Journey Planner</h1>
<form action="/route" method="post">
<label for="from">From</label><input id="from" name="from">
<label for="to">To</label><select id="to" name="to" disabled><option>Choose a start first</option></select>
<button id="plan" disabled>Plan Your Journey</button>
<button type="button" aria-disabled="true">Next week</button>
</form>`;
// A sign-in form whose password field waits for the account first.
const SIGN_IN_OFF = `<h1>Sign in</h1><form action="/session" method="post">
<label>Email <input type="email" name="email"></label><label>Password <input type="password" name="password" disabled></label>
<button>Sign in</button></form>`;
// The first 170 seats taken (turned off), then 80 free ones and the page's
// button, more controls than the list holds.
const SEATS = `<h1>Seats</h1>${Array.from({ length: 250 }, (_, index) =>
  `<button${index < 170 ? " disabled" : ""}>Seat ${index + 1}</button>`).join("")}<button>Continue</button>`;
// Text areas with no name of their own, holding codes.
const TEXT_AREAS = `<h1>Account</h1><p>Your recovery codes</p><textarea disabled>${RECOVERY_CODES}</textarea>
<textarea readonly>${RECOVERY_CODES.split(" ").reverse().join(" ")}</textarea>`;
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
const GARDEN = `<h1>The Secret Garden</h1><p>Tickets on sale now.</p>
<iframe src="http://${AD_SITE}/ad" title="Ad" width="300" height="250"></iframe>`;
const LONG_SECTIONS = 40;
// A skip link a person never sees, which scrolls away, and a header pinned in
// view as the page scrolls, before a long review.
const LONG = `<style>.skip{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(1px,1px,1px,1px)}</style>
<a class="skip" href="#review">Skip to content</a><header style="position:sticky;top:0;background:#fff">Home Laptops</header>
<h1 id="review">Review</h1>${Array.from({ length: LONG_SECTIONS }, (_, index) =>
  `<p>Section ${index + 1}. ${"The review goes on about battery life and the keyboard. ".repeat(18)}End of section ${index + 1}.</p>`).join("")}
<p>The verdict: worth it.</p>`;
// The same review as a plain-text file, and one paragraph longer than a reading.
const PLAIN = `${Array.from({ length: LONG_SECTIONS }, (_, index) =>
  `Section ${index + 1}.\n${"The review goes on about battery life and the keyboard. ".repeat(18)}\nEnd of section ${index + 1}.\n`).join("\n")}\nThe verdict: worth it.\n`;
const SENTENCES = 400;
const ESSAY = `<h1>Essay</h1><p>${Array.from({ length: SENTENCES }, (_, index) =>
  `Sentence ${index + 1} of the very long paragraph.`).join(" ")}</p><p>After the long paragraph.</p>`;
// Far more text than a reading walks: the part in view is out of reach.
const ARCHIVE = Array.from({ length: 30_000 }, (_, index) => `<p>Entry ${index + 1} of the archive, with a few more words.</p>`).join("");
// More links than a reading judges at first, and a closed list's options
// ahead of a form's fields.
const STOPS = 700;
const ORDER = `<h1>Order</h1><form action="/order" method="post">
<label for="city">City</label><input id="city" role="combobox" aria-expanded="false" aria-controls="cities">
<div id="cities" role="listbox" style="display:none">${Array.from({ length: 650 }, (_, index) => `<div role="option">City ${index + 1}</div>`).join("")}</div>
<label>Email <input name="email"></label><label>Notes <textarea name="notes"></textarea></label><button type="submit">Place order</button></form>`;
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
// A key that only a copy button's name holds, near the page's top, above
// more links than the list holds.
const KEY_NAME = `<h1>Deploy settings</h1><p>Project alpha</p><button aria-label="Copy ${KEY_LIKE}">Copy</button>
${Array.from({ length: 250 }, (_, index) => `<p><a href="/deploy/${index + 1}">Deploy ${index + 1}</a></p>`).join("")}`;
const CODE_BOXES = `<h1>Sign in</h1><p>Your sign-in code</p>
<div style="display:flex;gap:8px"><span>${CODE.slice(0, 3)}</span><span>${CODE.slice(3)}</span></div><p>It expires in 10 minutes.</p>`;
// A section a page marks open as its toggle is, a control around a form's
// button that fills it, and one around another site's frame.
const SECTIONS = `<h1>Account</h1>
<a href="#digest" aria-expanded="true" aria-controls="digest">Weekly digest</a>
<div id="digest" class="collapse in" aria-expanded="true"><form method="post" action="/account/digest"><input type="hidden" name="on" value="1">
<button type="submit" aria-label="Turn on" style="display:block;width:100%;height:120px"></button></form></div>
<div tabindex="0" aria-expanded="true" id="alerts"><form method="post" action="/account/alerts"><input type="hidden" name="on" value="1">
<button type="submit" style="display:block;width:100%;height:120px"><svg width="16" height="16"><circle cx="8" cy="8" r="6"/></svg></button></form></div>
<div tabindex="0" id="player" style="width:320px"><iframe src="{frame}/booking" title="Booking" width="300" height="160"></iframe></div>
<button type="button" onclick="this.textContent = 'More shown'">Show more</button>`;
const SHADOW_KEY = `<h1>Settings</h1>
<key-card></key-card>
<script>
customElements.define("key-card", class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<h2>API keys</h2><label>Deploy <input readonly value='${KEY_LIKE}'></label><button>Copy</button>"; }
});
</script>`;

// A bookshop's page under a cookie banner with a refusal, settings and an
// accept. The page records which the banner was answered with, and the
// banner stays away once answered, as a consent cookie keeps it. `{name}`
// names the cookie, so each page asks afresh.
const bannerScript = (name) => `<script>
const notice = document.getElementById("cookie-notice");
const answer = (choice) => { window.consentAnswer = choice; document.cookie = "${name}=" + choice + "; path=/"; notice.remove(); };
document.getElementById("reject").onclick = () => answer("rejected");
document.getElementById("accept").onclick = () => answer("accepted");
document.getElementById("customize").onclick = () => { window.consentAnswer = "settings"; };
if (document.cookie.includes("${name}=")) notice.remove();
</script>`;
const BANNER = (name, extra = "") => `<h1>Bookshop</h1><p>Open daily, 9:00 AM to 7:30 PM.</p>
<p><a href="/reading/visit">Plan your visit</a></p>${extra}
<div id="cookie-notice" role="dialog" aria-label="Cookie consent" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff;border-top:1px solid #94a3b8">
<p>We use cookies to understand how the shop is used.</p>
<button type="button" id="customize">Customize</button> <button type="button" id="reject">Reject all</button> <button type="button" id="accept">Accept all</button>
</div>${bannerScript(name)}`;
// A tourism site's consent notice over the whole page, with an accept and its
// settings and no reject button, and a cover that is no notice (a loading
// screen). `live.hideOnScroll()` makes the cover go 300 ms after the page
// scrolls, as a toast that fades once the page moves does.
const NOTICE = `<h1>Visit the city</h1><p style="margin-top:1200px"><a href="/reading/visit" id="attractions">Attractions</a></p>
<div id="consent-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><div role="dialog" aria-label="Your privacy" style="margin:80px auto;width:320px;padding:16px;background:#fff">
<p>We and our partners store and read data on your device.</p>
<button type="button" onclick="window.consentAnswer = 'settings'">Learn more</button> <button type="button" onclick="window.consentAnswer = 'accepted'">Agree and close</button>
</div></div>`;
const COVERED = `<h1>Timetable</h1><p style="margin-top:1200px"><a href="/reading/visit" id="lines">All lines</a></p>
<div id="loading" style="position:fixed;inset:0;background:rgba(255,255,255,.8)"><p>Loading departures</p></div>
<script>
window.live = { hideOnScroll() { addEventListener("scroll", () => setTimeout(() => document.getElementById("loading").remove(), 300), { once: true }); } };
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
      "site.test /reading/sign-in-off": page("Sign in", SIGN_IN_OFF),
      "site.test /reading/seats": page("Seats", SEATS),
      "site.test /reading/text-areas": page("Account", TEXT_AREAS),
      "site.test /reading/garden": page("The Secret Garden - tickets", GARDEN),
      "site.test /reading/long": page("Review", LONG),
      "site.test /reading/plain.txt": { type: "text/plain; charset=utf-8", body: PLAIN },
      "site.test /reading/essay": page("Essay", ESSAY),
      "site.test /reading/archive": page("Archive", ARCHIVE),
      "site.test /reading/links": page("Stops", LINKS),
      "site.test /reading/order": page("Order", ORDER),
      "site.test /reading/secrets": page("Checkout", SECRETS),
      "site.test /reading/shadow-key": page("Settings", SHADOW_KEY),
      "site.test /reading/key-name": page("API keys", KEY_NAME),
      "site.test /reading/code-boxes": page("Sign in", CODE_BOXES),
      "site.test /reading/sections": page("Account", SECTIONS),
      "site.test /reading/banner": page("Bookshop", BANNER("bookshop_consent")),
      "site.test /reading/banner-look": page("Bookshop", BANNER("bookshop_look_consent")),
      "site.test /reading/banner-sign-in": page("Bookshop", BANNER("bookshop_sign_in_consent", `<form method="post" action="/session"><label>Email <input type="email" name="email" autocomplete="username"></label>
<label>Password <input type="password" name="password" autocomplete="current-password"></label><button>Sign in</button></form>`)),
      "site.test /reading/banner-frame": page("Bookshop", `<h1>Bookshop</h1><iframe src="{frame}/banner" title="Cookie consent" width="500" height="160"></iframe>`),
      "site.test /reading/notice": page("Visit the city", NOTICE),
      "site.test /reading/covered": page("Timetable", COVERED),
      "site.test /reading/visit": page("Visit", "<h1>Plan your visit</h1>"),
      "frame.test /banner": page("Cookies", BANNER("frame_consent")),
      "frame.test /booking": page("Booking", "<h2>Booking engine</h2><label>Check-in <input type=\"date\"></label><button>Search rooms</button><p>Rooms from 140 euros</p>"),
      "frame.test /pixel": page("Pixel", "<p>pixel</p>"),
      "frame.test /fields": page("Payment", SECRET_FIELDS),
    };
    server = createServer((request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      requests.push(`${request.method} ${url.origin}${url.pathname}`);
      request.resume();
      const entry = pages[`${url.hostname} ${url.pathname}`];
      if (entry === undefined) {
        response.writeHead(404, { "content-type": "text/html; charset=utf-8" }).end(page("Not found", "<p>Not found</p>"));
        return;
      }
      const { type, body } = typeof entry === "string" ? { type: "text/html; charset=utf-8", body: entry } : entry;
      response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
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
    // A list of its own says which option it holds; the field's suggestions
    // say nothing of the one the keys reach.
    assert.deepEqual(onLabels(reading, "selected"), ["Blue line"]);
    assert.equal(control(reading, "Bolhao").selected, undefined, "A field's highlighted suggestion read as chosen");
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
    // Nor is the person asked to fill a field the page turned off.
    const paused = await runTool("POST", "/v1/request-human-input", { indices: [control(reading, "To").index], snapshotId: reading.snapshotId });
    assert.equal(paused.code, 1, `A pause on a field turned off ran: ${paused.stdout}`);
    assert.match(paused.stderr, /"To" is turned off on the page right now/);
    assert.deepEqual(requests, [], "A step on a control turned off sent something");
    assert.equal(prompts.length, promptsBeforeOff, "A step on a control turned off asked");
    reading = await read("/reading/sign-in-off");
    assert.equal(control(reading, "Password").disabled, true);
    assert.deepEqual(reading.signIn?.fields, [control(reading, "Email").index], "A sign-in pause names a field turned off");
    // More controls than the list holds: the taken seats make room for the
    // free ones and the page's button, and are counted.
    reading = await read("/reading/seats");
    assert.equal(onLabels(reading, "disabled").length, 0);
    assert.equal(reading.interactiveElements.filter((entry) => /^Seat \d+$/.test(entry.label)).length, 80, "Free seats were left out");
    assert.equal(control(reading, "Continue").disabled, undefined);
    assert.equal(reading.omittedControls, 170);
    // A text area is named by its label or what is beside it, never by what it holds.
    reading = await read("/reading/text-areas");
    const areas = reading.interactiveElements.filter((entry) => entry.tag === "textarea");
    assert.equal(areas.length, 2);
    assert.ok([reading.visibleText, ...areas.map((entry) => entry.label)].every((text) => !/\d{4}/.test(text)),
      `A text area's text reached the reading: ${areas.map((entry) => entry.label)}`);

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
    // A frame's site is an address, never page text: under a title with a
    // credential word, a random-looking one makes no secret screen.
    reading = await read("/reading/garden");
    assert.equal(reading.secretScreen, false, "A frame's site made a secret screen");
    assert.equal(reading.visibleText, `The Secret Garden\nTickets on sale now.\n[frame not read: ${AD_SITE}]`);

    // 5. A long page, read to its end by scrolling.
    const sizes = [];
    const readToEnd = async (first) => {
      const parts = [first];
      for (let step = 0; step < 12; step += 1) {
        const current = parts.at(-1);
        sizes.push(current.visibleText.length);
        assert.ok(current.visibleText.length <= TEXT_CAP, `The reading's text is over its cap: ${current.visibleText.length}`);
        const scrollBy = /\[Text cut here: about [\d,]+ more characters\. Scroll down \(y: (\d+)\) to read on\.\]$/.exec(current.visibleText);
        if (!scrollBy) break;
        parts.push(await ok("POST", "/v1/scroll", { y: Number(scrollBy[1]) }));
      }
      return parts;
    };
    const numbersRead = (parts, pattern) => new Set(parts.flatMap((entry) => Array.from(entry.visibleText.matchAll(pattern), (match) => Number(match[1]))));
    const missing = (found, count) => Array.from({ length: count }, (_, index) => index + 1).filter((index) => !found.has(index));
    const windows = await readToEnd(await read("/reading/long"));
    assert.ok(windows.length >= 3, `A long page read in ${windows.length} parts`);
    assert.ok(windows[0].visibleText.startsWith("Skip to content\nHome Laptops\nReview\nSection 1."));
    // The skip link scrolls away and the header stays pinned: the text goes
    // on from where the page is scrolled to.
    for (const later of windows.slice(1)) {
      assert.match(later.visibleText, /^\[Text above not shown: about [\d,]+ characters\. Scroll up to read it\.\]\nSection \d+\./);
    }
    assert.ok(windows.at(-1).visibleText.endsWith("The verdict: worth it."), "Scrolling did not reach the page's end");
    let sectionsRead = numbersRead(windows, /End of section (\d+)\./g);
    assert.equal(sectionsRead.size, LONG_SECTIONS, `Sections never read: ${missing(sectionsRead, LONG_SECTIONS)}`);
    measurements.longPageParts = windows.length;
    measurements.longPageTextChars = sizes.slice();
    measurements.longPageReadingBytes = windows.map((entry) => JSON.stringify(entry).length);
    const back = await ok("POST", "/v1/scroll", { y: -10_000 });
    assert.ok(back.visibleText.startsWith("Skip to content\nHome Laptops\nReview\nSection 1."), "Scrolling back up did not read the page's top");
    // A plain-text page, one block of text, and one paragraph longer than a reading.
    const plain = await readToEnd(await read("/reading/plain.txt"));
    sectionsRead = numbersRead(plain, /End of section (\d+)\./g);
    assert.equal(sectionsRead.size, LONG_SECTIONS, `Plain-text sections never read: ${missing(sectionsRead, LONG_SECTIONS)}`);
    assert.ok(plain.at(-1).visibleText.endsWith("The verdict: worth it."));
    const essay = await readToEnd(await read("/reading/essay"));
    assert.ok(essay[0].visibleText.length > TEXT_CAP / 2, `The first part of a long paragraph read ${essay[0].visibleText.length} characters`);
    const sentencesRead = numbersRead(essay, /Sentence (\d+) of/g);
    assert.equal(sentencesRead.size, SENTENCES, `Sentences never read: ${missing(sentencesRead, SENTENCES)}`);
    assert.ok(essay.at(-1).visibleText.endsWith("After the long paragraph."));
    // A page whose part in view is further down than a reading walks says so.
    await runPage.goto(`${sites().site}/reading/archive`);
    await runPage.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    reading = await ok("GET", "/v1/snapshot");
    assert.ok(reading.visibleText.length <= TEXT_CAP);
    assert.ok(
      reading.visibleText.endsWith("[Text cut here: the part of the page in view is further down than a reading reaches.]"),
      `The reading did not say its view is out of reach: ${reading.visibleText.slice(-120)}`,
    );
    // More controls than the list holds: those scrolled past are left out,
    // however many the page has.
    reading = await read("/reading/links");
    assert.equal(reading.interactiveElements.length, 200);
    assert.equal(reading.omittedControls, STOPS + 1 - 200, "The controls past the list's end were not counted");
    assert.ok(!reading.interactiveElements.some((entry) => entry.label === "Next page"));
    await runPage.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const bottom = await ok("GET", "/v1/snapshot");
    assert.equal(bottom.interactiveElements.at(-1).label, "Next page", "Scrolling down did not reach the page's last link");
    assert.ok(bottom.interactiveElements.every((entry) => entry.label === "Next page" || Number(/^Stop (\d+)$/.exec(entry.label)?.[1]) > 600),
      `Controls scrolled past were listed: ${bottom.interactiveElements[0].label}`);
    assert.equal(bottom.omittedControls, STOPS + 1 - bottom.interactiveElements.length);
    // A closed list's options never crowd a form's fields out of the list.
    reading = await read("/reading/order");
    assert.deepEqual(reading.interactiveElements.map((entry) => entry.label), ["City", "Email", "Notes", "Place order"]);
    assert.equal(reading.omittedControls, 650);

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
    // A key only a control's name holds, first read with that control
    // scrolled past and left out of the list, still makes a secret screen.
    await runPage.goto(`${sites().site}/reading/key-name`);
    await runPage.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    reading = await ok("GET", "/v1/snapshot");
    assert.equal(reading.secretScreen, true, "A key in a name the list left out made no secret screen");
    assert.equal(reading.visibleText, "");
    assert.ok(!JSON.stringify(reading).includes(KEY_LIKE), "The key reached the reading");
    // A code drawn in boxes of its own reads with a line break between its
    // groups, and is masked as one.
    reading = await read("/reading/code-boxes");
    assert.ok(reading.visibleText.includes("Your sign-in code\n[redacted secret]\nIt expires"), reading.visibleText);
    assert.ok(!reading.visibleText.includes(CODE.slice(0, 3)), "A code in boxes of its own was read");

    // 7. A click acts on the control itself.
    reading = await read("/reading/sections");
    assert.deepEqual(
      reading.interactiveElements.map((entry) => entry.tag),
      ["a", "button", "div", "button", "div", "button"],
      "A section marked open was listed as a control",
    );
    requests.length = 0;
    const promptsBeforeClick = prompts.length;
    for (const ordinal of [0, 1]) {
      const index = reading.interactiveElements.map((entry, place) => [entry.tag, place]).filter(([tag]) => tag === "div")[ordinal][1];
      const landed = await runTool("POST", "/v1/click", { index, snapshotId: reading.snapshotId });
      assert.equal(landed.code, 1, `A click that lands on a form's button or a frame inside the control ran: ${landed.stdout}`);
      assert.match(landed.stderr, /would land on something else inside it \(another control, or a frame\), so nothing was done/);
    }
    assert.deepEqual(requests, [], "A click that landed on another control sent something");
    assert.equal(prompts.length, promptsBeforeClick, "A click that landed on another control asked");
    const shown = await ok("POST", "/v1/click", { index: control(reading, "Show more").index, snapshotId: reading.snapshotId });
    assert.ok(shown.interactiveElements.some((entry) => entry.label === "More shown"), "A click on a plain button did nothing");

    // 8. A cookie banner is the browser's, and a covered click is refused in words.
    const labels = (observed) => observed.interactiveElements.map((entry) => entry.label);
    const consentAnswer = () => runPage.evaluate(() => window.consentAnswer ?? null);
    const actionsBefore = fs.readFileSync(actionsPath, "utf8").length;
    let promptsBeforeBanner = prompts.length;
    // a. A step that opens the page declines its banner before Octo reads it:
    // the reading is the page under it, and the step says so.
    const declinedOpen = await ok("POST", "/v1/navigate", { url: `${sites().site}/reading/banner` });
    assert.equal(await consentAnswer(), "rejected", "the banner's refusal was not the one pressed");
    assert.equal(declinedOpen.activity.declined, "cookies");
    for (const label of ["Reject all", "Accept all", "Customize"]) {
      assert.ok(!labels(declinedOpen).includes(label), `${label} is still on the page Octo read`);
    }
    assert.ok(labels(declinedOpen).includes("Plan your visit"));
    assert.match(fs.readFileSync(actionsPath, "utf8").slice(actionsBefore), /"type":"click","label":"Decline cookies"/u);
    assert.equal(prompts.length, promptsBeforeBanner, "declining asked");
    // b. A look at the page declines one too.
    await runPage.goto(`${sites().site}/reading/banner-look`);
    const looked = await ok("GET", "/v1/snapshot");
    assert.equal(await consentAnswer(), "rejected");
    assert.equal(looked.activity.declined, "cookies");
    // c. A banner on a page with a sign-in field, one in a frame, and a notice
    // with no reject button: nothing is pressed, and the step says nothing.
    reading = await read("/reading/banner-sign-in");
    assert.equal(await consentAnswer(), null, "a banner on a sign-in page was answered");
    assert.ok(labels(reading).includes("Reject all"));
    assert.equal(reading.activity.declined, undefined);
    reading = await read("/reading/banner-frame");
    const frame = runPage.frames().find((candidate) => candidate.url().includes("frame.test"));
    assert.ok(frame, "the banner's frame loaded");
    assert.equal(await frame.evaluate(() => window.consentAnswer ?? null), null, "a banner in a frame was answered");
    assert.equal(reading.activity.declined, undefined);
    reading = await read("/reading/notice");
    assert.equal(await consentAnswer(), null, "a notice with no reject button was answered");
    assert.equal(reading.activity.declined, undefined);
    // d. A click under that notice is refused at once in words, with no wait
    // and no call log; the notice is left up, and nothing is opened.
    requests.length = 0;
    promptsBeforeBanner = prompts.length;
    let clickStarted = Date.now();
    const underNotice = await runTool("POST", "/v1/click", { index: control(reading, "Attractions").index, snapshotId: reading.snapshotId });
    measurements.coveredClickMs = Date.now() - clickStarted;
    assert.equal(underNotice.code, 1, underNotice.stdout);
    assert.match(underNotice.stderr, /A cookie notice covers this page and has no reject button: read on under it, or open the place's own site\./u);
    assert.doesNotMatch(underNotice.stderr, /Call log|Timeout|intercepts pointer events/u);
    assert.ok(measurements.coveredClickMs < 8_000, `the covered click waited ${measurements.coveredClickMs} ms`);
    assert.equal(await consentAnswer(), null);
    assert.equal(new URL(runPage.url()).pathname, "/reading/notice");
    assert.deepEqual(requests, [], "the covered click opened something");
    assert.equal(prompts.length, promptsBeforeBanner);
    // e. Any other cover says what to do, in words of its own.
    reading = await read("/reading/covered");
    const underCover = await runTool("POST", "/v1/click", { index: control(reading, "All lines").index, snapshotId: reading.snapshotId });
    assert.equal(underCover.code, 1, underCover.stdout);
    assert.match(underCover.stderr, /Something else on the page covers "All lines", so nothing was clicked\. Take a fresh snapshot, and read on without it if it is still covered\./u);
    assert.doesNotMatch(underCover.stderr, /Call log|Timeout/u);
    // f. A cover that goes a moment after the page moves is waited for, and
    // the click is done.
    reading = await read("/reading/covered");
    await runPage.evaluate(() => window.live.hideOnScroll());
    clickStarted = Date.now();
    const afterCover = await ok("POST", "/v1/click", { index: control(reading, "All lines").index, snapshotId: reading.snapshotId });
    measurements.coverWaitedClickMs = Date.now() - clickStarted;
    assert.equal(new URL(afterCover.url).pathname, "/reading/visit", "the click under a cover that went was not done");

    const result = {
      status: "passed", fixtureVersion: 1, browserVersion: context.browser()?.version() ?? "unknown",
      platform: process.platform, architecture: process.arch, nodeVersion: process.version,
      measurements,
      assertions: [
        "a details' summary is listed with whether it is open, and opening it reads its section; a tab out of the tab order is listed, and the tab shown says it is selected",
        "the radio button, box, radio link and list option shown chosen say so, and nothing else does: not a field's highlighted suggestion",
        "a control turned off is listed as disabled, and a click or a choice on it is refused at once, sending and asking nothing; taken seats make room for the free ones; a text area is never named by what it holds",
        "a frame is named by its site and a canvas as a picture with no text, where they show; a tracking frame and an icon are nothing; no word of a frame is read; a frame's site makes no secret screen",
        "a long page's text says where it is cut and how far to scroll, and scrolling reads all of it within the reading's cap, past a skip link and a pinned header, on a plain-text page and in a long paragraph; a view out of reach says so; past 200 controls those scrolled past are left out and counted, past 600 matches too, and a closed list's options never crowd out a form",
        "password, card and code fields in a frame or a shadow root carry no value into the reading, a frame's fields are never listed, a key in a shadow root's read-only field or in a control's name the list leaves out still makes a secret screen, and a code in boxes of its own is masked",
        "a section marked open is no control, and a click whose middle lands on a form's button or a frame inside the control is refused, sending and asking nothing",
        "once a page settles the browser presses a cookie banner's own reject button itself, never its accept or settings, and the step says so; never a banner with no reject button, one in a frame, or one on a page with a sign-in field; a click a cookie notice or another cover keeps from its control is refused at once in words with no call log, and a cover that goes within a moment is waited for",
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
