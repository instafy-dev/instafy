import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
//    frame's page is read. Nor is a control in it, in a frame of the page's
//    own site too: none is listed or counted, so no step or pause reaches it,
//    and the frame's place in the text is what says where it is. A frame's
//    site is no page text: a random-looking one under a title with a
//    credential word makes no secret screen.
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
//    presses the banner's own reject button itself, in a banner that speaks of
//    cookies, never its accept or its settings, and the step says so once the
//    banner is gone; never one with no reject button, one in a frame, one on
//    a page with a sign-in field or a frame holding card fields, or a dialog
//    about a privacy policy that never speaks of cookies. A click that
//    something outside its control covers is refused at once, in words (a
//    cookie notice the browser could not decline says so, and any other cover
//    is named by its role and label, or the first words a person sees on it
//    when it has no role or says it has none),
//    with no wait and no call log, and a cover that goes within a moment is
//    waited for. A plain link under a cookie notice is no click to refuse: its
//    address opens in the same tab, as a navigate step to it does, and the
//    step says so. A link to the page itself is refused as a button is.
// 9. A cookie notice is never the person's step. A notice's accept is never
//    listed, as a button, a link, an "Allow all" or an "Agree and close": a
//    reading counts it among the controls it leaves out, so no step can press
//    it, while a limited accept, a notice's settings and a button a page
//    dresses up beside it stay listed; the action policy's refusal of an
//    accept keeps its words. A click under a notice the browser could not
//    decline never pauses on it (a plain link's address opens instead), and a
//    pause on a notice's buttons is refused as one on anything
//    but fields is, in the chat's own tab and in Octo's own: nothing is
//    outlined or pressed. Under a bar whose only button accepts, which covers
//    nothing, the planner's own button works with no prompt.
// 10. A step's reading waits for what it draws: a click whose result the page
//    draws in place a moment later reads it, whatever the click changed
//    first (a hidden field, a tip on hover, a suggestion dropped as a field
//    loses focus, the address), one whose result comes 5 seconds on reads it
//    too, one whose page still reads as before 6 seconds on says so and that
//    its reading is the page as it is now, and a click that changes the page,
//    shows a part of it (a section, a menu, a drawer, a carousel's next item)
//    or turns a switch on, opens a page or loads the same one again, a type
//    step and a choice answer at once. A search typed and not sent says
//    nothing was searched yet, and a field that is no search that nothing was
//    sent yet. A type step types as a person does, ending on a key press (one
//    a US keyboard has no key for too), and names the first options of the
//    list its field opens then, sending nothing: its own list whole once it
//    changed, never another list on the page nor a row turned off. A page that
//    moves the focus, opens a field of its own or replaces the field as text
//    goes in keeps the whole text, in order. A click on a plain link the page
//    does not take in time opens the link's address in the tab.
// 11. A field's own suggestion is chosen by a click, whatever its list does
//    as the click comes: the click leaves the focus in the field, so a list
//    that closes as the field loses it is still there, and a stop the list
//    drew anew under the pointer is found again by the reading's record of
//    it and clicked once. A stop the list no longer shows is not clicked, and
//    the step answers with the field's suggestions as they read now.
// 12. A ticket shop's controls that have no name of their own are named by
//    the row or card they sit in ("+ beside “Adult”"), so they read apart and
//    the person's step can be highlighted by its name; the same rows in a
//    frame are named by the frame's site, and none of them is listed or
//    counted.
// 13. A row's words only tell its controls apart where they are named: a
//    reading step in a row whose words a step's checks ask about ("delete",
//    "Book", "Save") goes without a prompt, in Octo's own tab too; a pause on
//    a booking's icon button in a part that speaks of cookies is the
//    person's step; a key beside an icon button, which the page's text
//    masks, names no control, whole or in part; a withheld page's controls
//    are named without their rows' words, in its reading and in a step's
//    words. A stop drawn anew under the pointer, for a field that names no
//    list of its own beside a "Sort by" list, is not clicked, and no other
//    list's options are named as its suggestions.
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
// The action policy both browsers judge steps by: the Personal Browser's
// refusals are its words.
const actionPolicyModule = createRequire(import.meta.url)(path.join(repositoryRoot, "packages/browser-action-policy/actionPolicy.js"));
// What a cookie notice the browser could not decline tells Octo when a click
// under it was kept from its control: a button's, as a plain link's address
// opens instead (COVERED_LINK_WORDS).
const NOTICE_WORDS = 'A cookie notice covers this page, and the browser could not decline it, so nothing was clicked. A site\'s home page, its address with no path, always opens. Go on in this turn as "Finding a page" says.';
const COVERED_LINK_WORDS = (label) => `A cookie notice covers "${label}", so its address was opened in this tab instead.`;
// What the action policy answers a press of a notice's accept a step still
// reaches: the Personal Browser's policy gives the same.
const ACCEPT_WORDS = "Octo never accepts cookies, so nothing was pressed. Carry on under the notice from a fresh snapshot. If it covers what you need, open that link by its address, or another official source.";
// What a step's result says when its page still reads as it did before it,
// once the step has looked for 6 seconds (UNCHANGED_LOOK_MS).
const UNCHANGED_WORDS = "The page still reads as it did before this step, 6 seconds after it: this result is the page as it is now.";
// What a click on a plain link the page did not take in time says.
const NOT_TAKEN_LINK_WORDS = (label) => `"${label}" did not take the click in time, so its address was opened in this tab instead.`;
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
// names the cookie, so each page asks afresh. `late` gives the banner's
// buttons their script 8 s after the page loads, as a consent manager still
// loading does, so a press before that does nothing.
const bannerScript = (name, { notice = "cookie-notice", late = false } = {}) => `<script>
const notice = document.getElementById("${notice}");
const answer = (choice) => { window.consentAnswer = choice; document.cookie = "${name}=" + choice + "; path=/"; notice.remove(); };
const listen = () => {
  document.getElementById("reject").onclick = () => answer("rejected");
  document.getElementById("accept").onclick = () => answer("accepted");
  const customize = document.getElementById("customize");
  if (customize) customize.onclick = () => { window.consentAnswer = "settings"; };
};
${late ? "setTimeout(listen, 8000);" : "listen();"}
if (document.cookie.includes("${name}=")) notice.remove();
</script>`;
const BANNER = (name, extra = "", options = {}) => `<h1>Bookshop</h1><p>Open daily, 9:00 AM to 7:30 PM.</p>
<p><a href="/reading/visit">Plan your visit</a></p>${extra}
<div id="cookie-notice" role="dialog" aria-label="Cookie consent" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff;border-top:1px solid #94a3b8">
<p>We use cookies to understand how the shop is used.</p>
<button type="button" id="customize">Customize</button> <button type="button" id="reject">${options.reject ?? "Reject all"}</button> <button type="button" id="accept">${options.accept ?? "Accept all"}</button>
</div>${bannerScript(name, options)}`;
// A bar whose own names say nothing of cookies, whose text does, with a
// plain "Reject" and "Accept" in a row of their own.
const BANNER_IN_TEXT = `<h1>Bookshop</h1><p><a href="/reading/visit">Plan your visit</a></p>
<div id="notice-bar" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff">
<p>This shop uses cookies to remember your basket.</p>
<div class="choices"><button type="button" id="reject">Reject</button> <button type="button" id="accept">Accept</button></div>
</div>${bannerScript("bookshop_text_consent", { notice: "notice-bar" })}`;
// The person's own account page, signed in, under a dialog about a privacy
// policy that never speaks of cookies, whose "Decline" would close the
// account: its buttons are judged as a consent banner's, and it is no cookie
// banner.
const POLICY = `<h1>Your account</h1><p>Signed in as Ana.</p><p><a href="/reading/visit">Orders</a></p>
<div role="dialog" aria-label="Updated privacy policy" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff">
<p>Accept it to keep using your account, or decline and we will close it.</p>
<button type="button" onclick="window.consentAnswer = 'declined policy'">Decline</button> <button type="button" onclick="window.consentAnswer = 'accepted policy'">Accept</button>
</div>`;
// A checkout whose card fields sit in a payment provider's frame, which a
// reading never reads, under a cookie banner.
const CHECKOUT = `<p>Total 140 euros</p><form method="post" action="/pay">
<iframe src="{frame}/card" title="Secure card payment input frame" width="420" height="60"></iframe><button>Pay</button></form>`;
// A tourism site's consent notice over the whole page, with an accept and its
// settings and no reject button, over a link and a button of the page's own
// and a link to the page itself that only runs its script (`href="#"`), and a
// cover that is no notice (a loading screen). `live.hideOnScroll()` makes the
// cover go 300 ms after the page scrolls, as a toast that fades once the page
// moves does.
const NOTICE = `<h1>Visit the city</h1><p style="margin-top:1200px"><a href="/reading/visit" id="attractions">Attractions</a>
<button type="button" onclick="window.pressed = 'map'">Show the map</button>
<a href="#" onclick="window.pressed = 'hours'; document.getElementById('hours').hidden = false; return false;">Opening hours</a></p>
<p id="hours" hidden>Open daily from 10:00 to 19:00.</p>
<div id="consent-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><div role="dialog" aria-label="Your privacy" style="margin:80px auto;width:320px;padding:16px;background:#fff">
<p>We and our partners store and read data on your device.</p>
<button type="button" onclick="window.consentAnswer = 'settings'">Learn more</button> <button type="button" onclick="window.consentAnswer = 'accepted'">Agree and close</button>
</div></div>`;
// A transport operator's cookie notice over its whole page, with a link to
// its cookie settings page and an accept, and no reject button; and a notice
// whose "Delete my account" sits beside its accept, as a page could dress up
// another control as a notice's.
const COOKIE_NOTICE = `<h1>Metro</h1><p style="margin-top:1200px"><a href="/reading/visit" id="planner">Plan a journey</a></p>
<div id="consent-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><div class="cookie-bar" style="margin:80px auto;width:320px;padding:16px;background:#fff">
<p>This site uses cookies to work and to measure how it is used.</p>
<a href="/reading/cookie-settings" role="button">Customize cookies</a> <button type="button" onclick="window.consentAnswer = 'accepted'; document.getElementById('consent-backdrop').remove()">Accept all cookies</button>
</div></div>`;
// Small pages held in one wrapper, whose text speaks of cookies all over: a
// menu and a footer of links outside the notice, and a notice named after
// cookies; and one whose notice is named nowhere.
const WRAPPED_NOTICE = `<div id="app"><nav>${["Lines", "Fares", "Tickets", "Maps", "News", "Help", "About"]
  .map((name) => `<a href="/reading/visit">${name}</a>`).join(" ")}</nav>
<main><h1>Metro</h1><p><a href="/reading/visit">Plan a journey</a></p></main>
<div class="cookie-bar"><a href="/reading/cookie-settings" role="button">Customize cookies</a> <button type="button" onclick="window.consentAnswer = 'accepted'">Accept all cookies</button></div>
<footer><a href="/reading/visit">Privacy</a> · <a href="/reading/visit">Cookies</a> · <a href="/reading/visit">Contact</a></footer></div>`;
const UNNAMED_NOTICE = `<div id="root"><nav><a href="/reading/visit">Lines</a> <a href="/reading/visit">Fares</a></nav>
<main><h1>Journey planner</h1><p>Plan a trip.</p></main>
<div class="notice-box"><p>We use cookies to improve the site.</p><a href="/reading/cookie-settings" role="button">Cookie settings</a> <button type="button" onclick="window.consentAnswer = 'accepted'">Accept all cookies</button></div></div>`;
const DRESSED_NOTICE = `<h1>Your account</h1><p><a href="/reading/visit">Orders</a></p>
<div class="cookie-bar" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff">
<p>We use cookies.</p>
<button type="button" onclick="window.consentAnswer = 'deleted'">Delete my account</button> <button type="button" onclick="window.consentAnswer = 'accepted'">Accept all cookies</button>
</div>`;
// A notice whose accept allows ("Allow all"), beside an accept limited to the
// necessary cookies and a link to its settings, with no reject; and a
// sign-in a page dresses up as a notice: a password field, its "Sign in" and
// a "Book now" beside the notice's accept.
const ALLOW_NOTICE = `<h1>Museum</h1><p><a href="/reading/visit">Tickets</a></p>
<div class="cookie-banner" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff">
<p>We use cookies to run this site.</p>
<a href="/reading/cookie-settings">Cookie settings</a> <button type="button" onclick="window.consentAnswer = 'necessary'">Accept only necessary</button> <button type="button" onclick="window.consentAnswer = 'accepted'">Allow all</button>
</div>`;
// A transport operator's journey planner under a bar whose only button
// accepts cookies, which covers nothing of the planner: its fields and its
// button stay in reach, and the button shows the route.
const ACCEPT_ONLY_BAR = `<h1>Journey planner</h1>
<form onsubmit="return false"><label>From <input name="from" value="São Bento"></label> <label>To <input name="to" value="Trindade"></label>
<button type="button" onclick="document.getElementById('route').textContent = 'Route: Line D towards Hospital São João, 2 stops'">Plan journey</button></form>
<p id="route"></p>
<div class="cookie-bar" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff">
<p>This site uses cookies to improve your experience on this website.</p>
<button type="button" onclick="window.consentAnswer = 'accepted'; this.parentElement.remove()">aceitar e continuar</button>
</div>`;
// The same bar with a link to the site's cookie policy beside its accept, and
// a wall over the whole page whose only other control is a "Learn more" link
// to that policy: a link to another page is no way out of a notice, unless its
// words name the notice's settings.
const ACCEPT_POLICY_LINK = `<h1>Journey planner</h1><p><a href="/reading/visit">Plan a journey</a></p>
<div class="cookie-bar" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff">
<p>This site uses cookies to improve your experience on this website.</p>
<a href="/reading/visit">Política de cookies</a> <button type="button" onclick="window.consentAnswer = 'accepted'">aceitar e continuar</button>
</div>`;
const LEARN_MORE_WALL = `<h1>Museum</h1><p style="margin-top:1200px"><a href="/reading/visit" id="tickets">Tickets</a></p>
<div id="consent-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.4)"><div role="dialog" aria-label="Cookies" style="margin:80px auto;width:320px;padding:16px;background:#fff">
<p>We use cookies to run this site.</p>
<a href="/reading/visit">Learn more</a> <button type="button" onclick="window.consentAnswer = 'accepted'">Accept and continue</button>
</div></div>`;
// Notices with a way out the person can take: a link to the notice's settings
// page, and a refusal on the notice itself in words no list knows.
const SETTINGS_LINK_NOTICE = `<h1>Museum</h1><p><a href="/reading/visit">Tickets</a></p>
<div class="cookie-banner" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff">
<p>We use cookies to run this site.</p>
<a href="/reading/cookie-settings">Manage preferences</a> <button type="button" onclick="window.consentAnswer = 'accepted'">Accept all cookies</button>
</div>`;
const DISAGREE_NOTICE = `<h1>Visit the city</h1><p><a href="/reading/visit">Attractions</a></p>
<div role="dialog" aria-label="Your privacy" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff">
<p>We and our partners store and read data on your device.</p>
<button type="button" onclick="window.consentAnswer = 'disagreed'">Disagree and close</button> <button type="button" onclick="window.consentAnswer = 'accepted'">Agree and close</button>
</div>`;
// A booking's final button far down its page, in small print that speaks of
// cookies: a step of the person's, never a cookie notice's choice.
const BOOK_BELOW = `<h1>Book a table</h1><p>Friday, 19:00, 2 people.</p>
<p style="margin-top:1600px">By booking you agree to our terms and our cookie policy.
<button type="button" onclick="window.consentAnswer = 'booked'">Book now</button></p>`;
const DRESSED_SIGN_IN = `<h1>Your account</h1>
<div class="cookie-bar" style="position:fixed;left:0;right:0;bottom:0;padding:16px;background:#fff">
<p>We use cookies.</p>
<input type="password" aria-label="Password"> <button type="button" onclick="window.consentAnswer = 'signed in'">Sign in</button> <button type="button" onclick="window.consentAnswer = 'booked'">Book now</button> <button type="button" onclick="window.consentAnswer = 'accepted'">Accept all cookies</button>
</div>`;
// A journey planner that draws its route in place, without a new document:
// 1.5 s after its button, 5 s after a slow one, and at once for its fares;
// a button that changes nothing; a button that only scrolls to its end; a
// link to another page and one to itself; a search box with no form, a field
// and a list.
const DRAWS = `<h1>Journey planner</h1>
<p><input aria-label="From" name="from" value="São Bento"> <select aria-label="Day"><option>Monday</option><option>Tuesday</option></select></p>
<p><input type="search" aria-label="Search stops"></p>
<p><button type="button" onclick="setTimeout(() => { document.getElementById('route').textContent = 'Route: Line D towards Hospital São João, 2 stops'; }, 1500)">Plan journey</button>
<button type="button" onclick="setTimeout(() => { document.getElementById('route').textContent = 'Route: Line A towards Senhor de Matosinhos, 5 stops'; }, 5000)">Plan the slow way</button>
<button type="button" onclick="document.getElementById('route').textContent = 'Fares: Z2 1.40 euros'">Show fares</button>
<button type="button">Check for delays</button>
<button type="button" onclick="window.scrollTo(0, document.body.scrollHeight)">Go to the end</button>
<a href="/reading/visit">Plan your visit</a> <a href="/reading/draws">Start over</a></p>
<p id="route"></p><div style="height:3000px"></div><p>End of the planner</p>`;
// A short page with a link to a part of it that is in view, so a click on it
// moves nothing but the address. The page draws that part's words 1.2 s after
// the address names it, as a strip of tabs that loads each one when it is
// asked for does.
const PARTS = `<h1>Timetable</h1>
<p><a href="#weekend">Weekend times</a></p>
<h2 id="weekend">Weekend</h2><p id="times"></p>
<script>
addEventListener("hashchange", () => {
  if (location.hash === "#weekend") setTimeout(() => { document.getElementById("times").textContent = "Every 12 minutes."; }, 1200);
});
</script>`;
// What a step shows in place without changing the page's text, as a person
// sees it: a section that slides open, a menu that fades in, a drawer and a
// carousel that move into view, a switch and a toggle button. A planner that
// keeps the place it found in a hidden field, one with a tip shown on hover,
// one whose field shows a suggestion until it loses focus, and one that puts
// its search in its address: each draws its route 1.5 s after its button.
const REVEALS = `<style>#specs{max-height:0;overflow:hidden}#specs.open{max-height:500px}
#menu{opacity:0}#menu.open{opacity:1}
#drawer{position:fixed;left:0;top:200px;width:300px;background:#eee;transform:translateX(-110%)}#drawer.open{transform:none}
#view{width:300px;overflow:hidden}#track{display:flex;width:900px}#track>p{width:300px;flex:none;margin:0}#track.second{transform:translateX(-300px)}</style>
<h1>Laptop</h1>
<p><button type="button" onclick="document.getElementById('specs').classList.add('open')">Show specs</button>
<button type="button" onclick="document.getElementById('menu').classList.add('open')">Menu</button>
<button type="button" onclick="document.getElementById('drawer').classList.add('open')">Open filters</button>
<button type="button" onclick="document.getElementById('track').classList.add('second')">More reviews</button>
<button type="button" role="switch" aria-checked="false" onclick="this.setAttribute('aria-checked', 'true')">Step-free routes</button>
<button type="button" aria-pressed="false" onclick="this.setAttribute('aria-pressed', 'true')">Large text</button></p>
<div id="specs"><p>Battery 61 Wh, warranty one year</p></div>
<div id="menu"><p>Laptops, desktops and monitors</p></div>
<div id="drawer"><p>Price under 1000 euros</p></div>
<div id="view"><div id="track"><p>Review one: a great keyboard</p><p>Review two: the battery lasts long</p><p>Review three: loud fans</p></div></div>`;
const DRAW_ROUTE = "setTimeout(() => { document.getElementById('route').textContent = 'Route: Line D towards Hospital São João, 2 stops'; }, 1500)";
// A planner whose fields open their stop lists only as keys are pressed, as a
// person types, never on a value set alone, and send nothing until its button
// is pressed: "From" is a combobox that names its list and fills it 1.2 s
// after the key (a site's answer); "To" names none, and its options show
// 0.3 s after the key, under it.
const KEY_LISTS = `<h1>Journey planner</h1>
<form action="/reading/journey" method="get">
<p><label for="from">From</label><input id="from" name="from" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="from-stops" autocomplete="off"></p>
<ul id="from-stops" role="listbox" hidden></ul>
<p><label for="to">To</label><input id="to" name="to" autocomplete="off"></p>
<div id="to-stops"></div>
<p><button>Plan journey</button></p></form>
<script>
const STOPS = ["Central Station", "Central Square", "Old Central Park", "Harbour", "Harbour (Metro)", "Old Town"];
const matching = (text) => STOPS.filter((stop) => stop.toLowerCase().includes(text.toLowerCase().slice(0, 4)));
const from = document.getElementById("from");
const fromStops = document.getElementById("from-stops");
from.addEventListener("keyup", () => {
  const text = from.value;
  setTimeout(() => {
    fromStops.innerHTML = matching(text).map((stop) => '<li role="option">' + stop + '</li>').join("");
    fromStops.hidden = false;
    from.setAttribute("aria-expanded", "true");
  }, 1200);
});
const to = document.getElementById("to");
to.addEventListener("keyup", () => {
  const text = to.value;
  setTimeout(() => {
    document.getElementById("to-stops").innerHTML = matching(text).map((stop) => '<button type="button" role="option">' + stop + '</button>').join(" ");
  }, 300);
});
</script>`;
// A stop list a planner draws under its field as a person types, which keeps
// the focus in the field while a stop is pressed and chooses it on the click,
// as such lists do: one that closes as the field loses the focus, one that
// draws its stops anew the first time the pointer reaches them, and one that
// shows other stops then. `window.chosen` counts the stops chosen.
const SUGGESTION_LIST = (more) => `<h1>Journey planner</h1>
<p><label for="from">From</label><input id="from" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="from-stops" autocomplete="off"></p>
<ul id="from-stops" role="listbox"></ul>
<p id="chosen"></p>
<script>
const field = document.getElementById("from");
const list = document.getElementById("from-stops");
window.chosen = 0;
const draw = (stops) => {
  list.innerHTML = stops.map((stop) => '<li role="option">' + stop + '</li>').join("");
  field.setAttribute("aria-expanded", stops.length ? "true" : "false");
};
field.addEventListener("input", () => draw(field.value ? ["Central Station", "Central Square"] : []));
list.addEventListener("mousedown", (event) => event.preventDefault());
list.addEventListener("click", (event) => {
  const option = event.target.closest("[role=option]");
  if (!option) return;
  window.chosen += 1;
  field.value = option.textContent;
  document.getElementById("chosen").textContent = "From: " + option.textContent;
  draw([]);
});
${more}
</script>`;
// A ticket shop's rows and card, whose buttons have no name of their own: a
// row's "−" and "+", a row's two buttons drawn by icons alone (one marked as
// a plus), and the card's arrow. The same rows sit in a frame of another
// site too.
const TICKET_ROWS = `<h2>Tickets</h2>
<div><p><span>Adult</span> <span>22.50 euros</span></p>
<p><button type="button">\u2212</button> <span>0</span> <button type="button">+</button></p></div>
<div><p><span>Child</span> <span>Free</span></p>
<p><button type="button"><svg width="16" height="16"><path d="M2 8h12"/></svg></button> <span>0</span>
<button type="button" class="icon-plus"><svg width="16" height="16"><path d="M2 8h12M8 2v12"/></svg></button></p></div>
<article><h3>Museum entrance</h3><p>The permanent collection</p><div><button type="button"><svg width="16" height="16"><path d="M4 8h8"/></svg></button></div></article>`;
// Controls named only by marks, or by nothing, in rows whose first words
// hold words a step's checks ask about ("delete", "Book", "Save"): an
// answer's "+", a tour's "−" and "+", an offer's "×" and a card's arrow,
// each a reading step.
const ROW_WORDS = `<h1>Help</h1>
<div><h3>How do I delete my account?</h3><button type="button" aria-expanded="false" onclick="this.setAttribute('aria-expanded', 'true'); document.getElementById('answer').hidden = false">+</button><p id="answer" hidden>Open Settings, then Account.</p></div>
<div><p><span>Book a guided tour</span> <span>12 euros</span></p><p><button type="button">\u2212</button> <span id="tours">0</span> <button type="button" onclick="document.getElementById('tours').textContent = String(Number(document.getElementById('tours').textContent) + 1)">+</button></p></div>
<div id="offer"><button type="button" onclick="document.getElementById('offer').remove()">\u00d7</button><h2>Save 10% on your first order</h2></div>
<article><h3>Book a guided tour</h3><p>Two hours with a guide</p><div><button type="button" onclick="document.getElementById('tour-card').textContent = 'Meet at the main entrance.'"><svg width="16" height="16"><path d="M4 8h8"/></svg></button></div><p id="tour-card"></p></article>`;
// A booking's icon button under a line that speaks of cookies: a step of the
// person's, never a cookie notice's choice.
const BOOKING_COOKIE_ROW = `<h1>Your booking</h1><p>Friday, 19:00, 2 people.</p>
<div><p>Cookies keep your booking while you finish it here today.</p><div><button type="button" onclick="window.consentAnswer = 'booked'"><svg width="16" height="16"><path d="M4 8h8"/></svg></button></div></div>`;
// Keys beside icon buttons, which the page's text masks by the words above
// them: as a row's first words and as the text right beside a button. The
// keys are made when the fixture runs, so the source holds none.
const ICON_BUTTON = '<button type="button"><svg width="16" height="16"><path d="M4 8h8"/></svg></button>';
const ROW_KEYS = (keys) => `<h1>Developer settings</h1>${keys.slice(0, -1).map((key) =>
  `<h2>Deploy key</h2><div><p><code>${key}</code></p><p>${ICON_BUTTON}</p></div>`).join("")}
<h2>Deploy key</h2><div><code>${keys.at(-1)}</code>${ICON_BUTTON}</div>`;
// A page that shows a key, so its reading is withheld, with a row's
// controls: an edit icon and a "+".
const WITHHELD_ROWS = (key) => `<h1>Backup codes</h1><p>Each code works once.</p><pre><code>${key}</code></pre>
<div><p><span>river stone</span></p><p><button type="button" class="icon-pencil"><svg width="16" height="16"><path d="M4 8h8"/></svg></button>
<button type="button">+</button></p></div>`;
// A planner whose field says it opens a list and names none, beside a "Sort
// by" list: it draws its stops as a person types and other stops as the
// pointer comes to them.
const UNNAMED_LIST = SUGGESTION_LIST('list.addEventListener("mouseover", () => draw(["Harbour", "Harbour (Metro)"]), { once: true });')
  .replace('<p><label for="from">', '<div role="listbox" aria-label="Sort by"><div role="option" aria-selected="true">Fastest</div><div role="option">Fewest changes</div></div>\n<p><label for="from">')
  .replace(' role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="from-stops"', ' aria-autocomplete="list"')
  .replace('<ul id="from-stops" role="listbox"></ul>', '<ul id="from-stops"></ul>')
  .replace('  field.setAttribute("aria-expanded", stops.length ? "true" : "false");\n', "");
// 250 links, more than a reading holds with the planner's own controls.
const LINES = (count) => Array.from({ length: count }, (_, index) => `<a href="/reading/line-${index + 1}">Line ${index + 1}</a>`).join(" ");
const MANY_LINES = LINES(250);
// A planner whose stops fall past a reading's cap: a field at the top that
// names its list, 250 links under it, and its list drawn under the field but
// put at the end of the page, as such lists are put. A reading holds 200
// controls, so the stops came after them, and the type step named none.
const CAPPED_LIST = `<h1>Journey planner</h1>
<p><label for="from">From</label><input id="from" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="from-stops" autocomplete="off"></p>
<nav>${MANY_LINES}</nav>
<ul id="from-stops" role="listbox" style="position:absolute;margin:0;padding:0;list-style:none;background:#fff"></ul>
<script>
const field = document.getElementById("from");
const list = document.getElementById("from-stops");
window.chosen = 0;
field.addEventListener("input", () => {
  const box = field.getBoundingClientRect();
  list.style.top = (box.bottom + scrollY) + "px";
  list.style.left = (box.left + scrollX) + "px";
  list.innerHTML = field.value ? ["Central Station", "Central Square"].map((stop) => '<li role="option">' + stop + '</li>').join("") : "";
  field.setAttribute("aria-expanded", field.value ? "true" : "false");
});
list.addEventListener("mousedown", (event) => event.preventDefault());
list.addEventListener("click", (event) => {
  const option = event.target.closest("[role=option]");
  if (!option) return;
  window.chosen += 1;
  field.value = option.textContent;
  list.innerHTML = "";
});
</script>`;
// A planner whose field says nothing of a list (no role, no aria), marked
// against autofill as some sites mark a planner's stops
// (autocomplete="one-time-code"), and whose stops come as plain rows of a list
// put at the end of the page and drawn under the field, each a stop and its
// town: no option, link or button, as an older planner draws them. The list
// keeps the focus in the field while a row is pressed and closes as the field
// loses it. A day field beside it opens a calendar under it, which is no list
// of its stops; 250 links sit between them and the lists.
const PLAIN_ROWS = `<h1>Journey planner</h1>
<form action="/reading/journey" method="get">
<p><label for="origin">Origin</label><input id="origin" name="origin" autocomplete="one-time-code"></p>
<p><label for="day">Day</label><input id="day" name="day" autocomplete="off"></p>
<p><button>Plan journey</button></p></form>
<nav>${MANY_LINES}</nav>
<ul id="menu" style="position:absolute;display:none;margin:0;padding:0;list-style:none;background:#fff;border:1px solid #888"></ul>
<table id="calendar" style="position:absolute;display:none;background:#fff">${[1, 8, 15, 22].map((first) =>
  `<tr>${Array.from({ length: 7 }, (_, day) => `<td>${first + day}</td>`).join("")}</tr>`).join("")}</table>
<script>
const origin = document.getElementById("origin");
const menu = document.getElementById("menu");
window.chosen = 0;
const under = (element, field) => {
  const box = field.getBoundingClientRect();
  element.style.top = (box.bottom + scrollY) + "px";
  element.style.left = (box.left + scrollX) + "px";
  element.style.width = box.width + "px";
};
origin.addEventListener("input", () => {
  const stops = origin.value ? ["Südpark", "Südpark (Tram)", "Südpark Nord", "Südpark West"] : [];
  menu.innerHTML = stops.map((stop) => '<li><div tabindex="-1"><b>' + stop + '</b> <small>Neustadt</small></div></li>').join("");
  under(menu, origin);
  menu.style.display = stops.length ? "block" : "none";
});
origin.addEventListener("blur", () => { menu.style.display = "none"; });
menu.addEventListener("mousedown", (event) => event.preventDefault());
menu.addEventListener("click", (event) => {
  const row = event.target.closest("li");
  if (!row) return;
  window.chosen += 1;
  origin.value = row.querySelector("b").textContent;
  menu.style.display = "none";
});
const day = document.getElementById("day");
const calendar = document.getElementById("calendar");
day.addEventListener("focus", () => { under(calendar, day); calendar.style.display = "table"; });
day.addEventListener("blur", () => { calendar.style.display = "none"; });
</script>`;
// A planner whose field says nothing of a list, and whose stops come as rows
// of a list drawn under it that each hold two controls: a button that saves
// the stop, then the stop's link. The type step said such stops came but that
// the reading did not list them, while it listed both controls of every row.
const ROW_CONTROLS = `<h1>Journey planner</h1>
<p><label for="from">From</label><input id="from" name="from" autocomplete="off"></p>
<p><button type="button">Plan journey</button></p>
<ul id="menu" style="position:absolute;display:none;margin:0;padding:0;list-style:none;background:#fff;border:1px solid #888"></ul>
<script>
const field = document.getElementById("from");
const menu = document.getElementById("menu");
window.chosen = 0;
window.saved = 0;
field.addEventListener("input", () => {
  const box = field.getBoundingClientRect();
  menu.style.top = (box.bottom + scrollY) + "px";
  menu.style.left = (box.left + scrollX) + "px";
  menu.innerHTML = field.value ? ["Central Station", "Central Square"].map((stop) =>
    '<li><button type="button">Save</button> <a href="#stop">' + stop + '</a></li>').join("") : "";
  menu.style.display = field.value ? "block" : "none";
});
menu.addEventListener("mousedown", (event) => event.preventDefault());
menu.addEventListener("click", (event) => {
  event.preventDefault();
  if (event.target.closest("button")) { window.saved += 1; return; }
  const stop = event.target.closest("a");
  if (!stop) return;
  window.chosen += 1;
  field.value = stop.textContent;
  menu.style.display = "none";
});
</script>`;
// A day field that names the calendar it opens as a person types
// (aria-controls), drawn under it: weeks of plain cells. Its weeks were
// listed as controls and named as the field's suggestions, and a click on one
// picked a day nobody asked for.
const NAMED_CALENDAR = `<h1>Journey planner</h1>
<p><label for="day">Day</label><input id="day" role="combobox" aria-haspopup="dialog" aria-expanded="false" aria-controls="calendar" autocomplete="off"></p>
<p><button type="button">Plan journey</button></p>
<div id="calendar" role="dialog" aria-label="Choose a day" style="position:absolute;display:none;background:#fff;border:1px solid #888"><table role="grid">${[2, 9, 16, 23].map((first) =>
  `<tr>${Array.from({ length: 7 }, (_, day) => `<td>${first + day}</td>`).join("")}</tr>`).join("")}</table></div>
<script>
const day = document.getElementById("day");
const calendar = document.getElementById("calendar");
day.addEventListener("input", () => {
  const box = day.getBoundingClientRect();
  calendar.style.top = (box.bottom + scrollY) + "px";
  calendar.style.left = (box.left + scrollX) + "px";
  calendar.style.display = "block";
  day.setAttribute("aria-expanded", "true");
});
calendar.addEventListener("mousedown", (event) => event.preventDefault());
</script>`;
// A box that names the list it filters (aria-controls), 50 rows of plain
// text, over 170 links and a form. Once the box was ticked and kept the
// focus, every reading listed the rows as controls, first, and left the
// form's field and button out.
const TICKED_LIST = `<h1>Stops</h1>
<p><label><input type="checkbox" id="step-free" aria-controls="stops"> Step-free stops only</label></p>
<ul id="stops">${Array.from({ length: 50 }, (_, index) => `<li>Stop ${index + 1}</li>`).join("")}</ul>
<nav>${LINES(170)}</nav>
<form method="get" action="/reading/visit"><label>From <input name="from"></label><button>Show times</button></form>`;
// A search box that names the list of the page's own it filters
// (aria-controls): plain rows in the page's flow, which the page only shows
// or hides. They were named as the box's suggestions to click.
const FILTERED_LIST = `<h1>Stations</h1>
<p><label>Filter stations <input type="search" id="filter" aria-controls="stations"></label></p>
<ul id="stations"><li>Central Station</li><li>Central Square</li><li>Harbour</li><li>Old Town</li></ul>
<script>
const filter = document.getElementById("filter");
filter.addEventListener("input", () => {
  for (const row of document.querySelectorAll("#stations li")) row.hidden = !row.textContent.toLowerCase().includes(filter.value.toLowerCase());
});
</script>`;
// A link that keeps moving, which the page never lets a click take, to a
// page that loads at once.
const MOVING_LINK = `<style>@keyframes sway { from { transform: translateX(0); } to { transform: translateX(24px); } }
#hours { display: inline-block; animation: sway 0.3s infinite alternate; }</style>
<h1>Museum</h1><p><a id="hours" href="/reading/visit">Opening hours</a></p>`;
// A stop search whose combobox fills its list only on a key, counting them:
// a row turned off says it is searching at once, the matching stops come a
// second after the last key, and a row turned off says when none match.
const KEY_ONLY_LIST = `<h1>Find a stop</h1>
<form action="/reading/journey" method="get">
<p><label for="stop">Stop</label><input id="stop" name="stop" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="stop-list" autocomplete="off"></p>
<ul id="stop-list" role="listbox"></ul>
<p><button>Find</button></p></form>
<script>
const NAMES = ["Market Café", "Museum Café", "Harbour Market"];
const stop = document.getElementById("stop");
const list = document.getElementById("stop-list");
let answer;
window.keys = 0;
stop.addEventListener("keyup", () => {
  window.keys += 1;
  const text = stop.value.toLowerCase();
  list.innerHTML = '<li role="option" aria-disabled="true">Searching…</li>';
  stop.setAttribute("aria-expanded", "true");
  clearTimeout(answer);
  answer = setTimeout(() => {
    const found = NAMES.filter((name) => name.toLowerCase().includes(text));
    list.innerHTML = found.length
      ? found.map((name) => '<li role="option">' + name + '</li>').join("")
      : '<li role="option" aria-disabled="true">No matching stops</li>';
  }, 1000);
});
</script>`;
// A search that says it opens a list and never does, beside a list of its
// own the page always shows.
const SORTED_SEARCH = `<h1>Museums</h1>
<p><input aria-label="Search museums" aria-haspopup="listbox" aria-expanded="false" autocomplete="off"></p>
<div role="listbox" aria-label="Sort by"><div role="option" aria-selected="true">Most visited</div><div role="option">Newest</div></div>`;
// Fields whose page moves on as text goes in: one moves the focus to its
// first suggestion, one opens a search field of its own with the words and
// moves the focus there, and one is replaced by a new field holding the
// words.
const MOVING_FIELDS = `<h1>Find a place</h1>
<p><label for="place">Place</label><input id="place" autocomplete="off"></p>
<div id="places"></div>
<p><label for="start">Start</label><input id="start" autocomplete="off"></p>
<p id="panel" hidden><label for="panel-search">Search stops</label><input id="panel-search" autocomplete="off"></p>
<p><label for="find">Find</label><input id="find" autocomplete="off"></p>
<script>
const place = document.getElementById("place");
place.addEventListener("input", () => {
  document.getElementById("places").innerHTML = '<button type="button" role="option">' + place.value + ' (area)</button>';
  document.querySelector("#places button").focus();
});
const start = document.getElementById("start");
start.addEventListener("input", () => {
  document.getElementById("panel").hidden = false;
  const search = document.getElementById("panel-search");
  search.value = start.value;
  search.focus();
});
const find = document.getElementById("find");
find.addEventListener("input", () => {
  const field = document.createElement("input");
  field.id = "find";
  field.autocomplete = "off";
  field.value = find.value;
  find.replaceWith(field);
  field.focus();
}, { once: true });
</script>`;
const HIDDEN_FIELD =`<h1>Journey planner</h1><input type="hidden" id="place">
<p><button type="button" onclick="document.getElementById('place').value = '41.15,-8.61'; ${DRAW_ROUTE}">Plan journey</button></p><p id="route"></p>`;
const HOVER_TIP = `<style>#tip{display:none}button:hover + #tip{display:inline}</style><h1>Journey planner</h1>
<p><button type="button" onclick="${DRAW_ROUTE}">Plan journey</button><span id="tip">Plans the fastest trip</span></p><p id="route"></p>`;
const BLUR_SUGGESTION = `<h1>Journey planner</h1>
<p><input aria-label="From" oninput="document.getElementById('suggestion').textContent = this.value ? 'Did you mean ' + this.value + ' station?' : ''" onblur="document.getElementById('suggestion').textContent = ''"></p>
<p id="suggestion"></p><p><button type="button" onclick="${DRAW_ROUTE}">Plan journey</button></p><p id="route"></p>`;
const ADDRESS_SEARCH = `<h1>Journey planner</h1>
<p><button type="button" onclick="history.pushState(null, '', '/reading/address-search?to=trindade'); ${DRAW_ROUTE}">Plan journey</button></p><p id="route"></p>`;
const COVERED = `<h1>Timetable</h1><p style="margin-top:1200px"><a href="/reading/visit" id="lines">All lines</a></p>
<div id="loading" style="position:fixed;inset:0;background:rgba(255,255,255,.8)"><p>Loading departures</p></div>
<script>
window.live = { hideOnScroll() { addEventListener("scroll", () => setTimeout(() => document.getElementById("loading").remove(), 300), { once: true }); } };
</script>`;

// A loading screen that says it has no role, over the timetable's link.
const PRESENTATION_COVER = `<h1>Timetable</h1><p><a href="/reading/visit">All lines</a></p>
<div role="presentation" style="position:fixed;inset:0"><div aria-hidden="true" style="position:absolute;inset:0;background:rgba(0,0,0,.3)">Backdrop</div>
<div style="position:absolute;top:30%;left:30%;background:#fff;padding:20px">Choose your ticket type</div></div>`;

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
    // Key-shaped values for ROW_KEYS and WITHHELD_ROWS, made here so the
    // source holds none: random-looking ones longer and shorter than a name
    // holds, a long hex one and one of a known format.
    const digest = (seed, encoding) => createHash("sha256").update(seed).digest(encoding);
    const rowKeys = [
      digest("a deploy key", "base64url"),
      digest("a signing key", "hex"),
      `${"github_pa"}t_${digest("a fine-grained key", "base64url").replace(/[^A-Za-z0-9]/g, "")}_${digest("its second half", "hex")}`,
      digest("an access key", "base64url").slice(0, 32),
      digest("a key beside its button", "base64url").slice(0, 32),
    ];
    const withheldKey = digest("a recovery key", "base64url");
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
      "site.test /reading/banner-in-text": page("Bookshop", BANNER_IN_TEXT),
      // A banner whose refusal turns down only the optional cookies, as a
      // maker's German page and an English one word it.
      "site.test /reading/banner-optional-de": page("Bookshop", BANNER("bookshop_optional_de_consent", "", { reject: "Optionale Cookies ablehnen", accept: "Alle akzeptieren" })),
      "site.test /reading/banner-optional-en": page("Bookshop", BANNER("bookshop_optional_en_consent", "", { reject: "Reject optional cookies", accept: "Accept all cookies" })),
      "site.test /reading/banner-late": page("Bookshop", BANNER("bookshop_late_consent", "", { late: true })),
      "site.test /reading/policy": page("Your account", POLICY),
      "site.test /reading/checkout": page("Checkout", BANNER("checkout_consent", CHECKOUT)),
      "site.test /reading/notice": page("Visit the city", NOTICE),
      "site.test /reading/cookie-notice": page("Metro", COOKIE_NOTICE),
      "site.test /reading/dressed-notice": page("Your account", DRESSED_NOTICE),
      "site.test /reading/allow-notice": page("Museum", ALLOW_NOTICE),
      "site.test /reading/wrapped-notice": page("Metro", WRAPPED_NOTICE),
      "site.test /reading/unnamed-notice": page("Journey planner", UNNAMED_NOTICE),
      "site.test /reading/dressed-sign-in": page("Your account", DRESSED_SIGN_IN),
      "site.test /reading/accept-only": page("Journey planner", ACCEPT_ONLY_BAR),
      "site.test /reading/accept-policy-link": page("Journey planner", ACCEPT_POLICY_LINK),
      "site.test /reading/learn-more-wall": page("Museum", LEARN_MORE_WALL),
      "site.test /reading/settings-link": page("Museum", SETTINGS_LINK_NOTICE),
      "site.test /reading/disagree-notice": page("Visit the city", DISAGREE_NOTICE),
      "site.test /reading/book-below": page("Book a table", BOOK_BELOW),
      "site.test /reading/covered": page("Timetable", COVERED),
      "site.test /reading/draws": page("Journey planner", DRAWS),
      "site.test /reading/parts": page("Timetable", PARTS),
      "site.test /reading/reveals": page("Laptop", REVEALS),
      "site.test /reading/hidden-field": page("Journey planner", HIDDEN_FIELD),
      "site.test /reading/hover-tip": page("Journey planner", HOVER_TIP),
      "site.test /reading/blur-suggestion": page("Journey planner", BLUR_SUGGESTION),
      "site.test /reading/address-search": page("Journey planner", ADDRESS_SEARCH),
      "site.test /reading/key-lists": page("Journey planner", KEY_LISTS),
      "site.test /reading/capped-list": page("Journey planner", CAPPED_LIST),
      "site.test /reading/plain-rows": page("Journey planner", PLAIN_ROWS),
      "site.test /reading/row-controls": page("Journey planner", ROW_CONTROLS),
      "site.test /reading/named-calendar": page("Journey planner", NAMED_CALENDAR),
      "site.test /reading/ticked-list": page("Stops", TICKED_LIST),
      "site.test /reading/filtered-list": page("Stations", FILTERED_LIST),
      "site.test /reading/moving-link": page("Museum", MOVING_LINK),
      "site.test /reading/key-only-list": page("Find a stop", KEY_ONLY_LIST),
      "site.test /reading/sorted-search": page("Museums", SORTED_SEARCH),
      "site.test /reading/moving-fields": page("Find a place", MOVING_FIELDS),
      "site.test /reading/presentation-cover": page("Timetable", PRESENTATION_COVER),
      "site.test /reading/blur-list": page("Journey planner", SUGGESTION_LIST('field.addEventListener("blur", () => draw([]));')),
      "site.test /reading/redraw-list": page("Journey planner", SUGGESTION_LIST('list.addEventListener("mouseover", () => draw(["Central Station", "Central Square"]), { once: true });')),
      "site.test /reading/moving-list": page("Journey planner", SUGGESTION_LIST('list.addEventListener("mouseover", () => draw(["Harbour", "Harbour (Metro)"]), { once: true });')),
      "site.test /reading/tickets": page("Tickets", TICKET_ROWS),
      "site.test /reading/tickets-framed": page("Tickets", '<h1>Book your visit</h1><iframe src="{frame}/tickets" title="Tickets" width="600" height="400"></iframe>'),
      "site.test /reading/row-words": page("Help", ROW_WORDS),
      "site.test /reading/booking-cookie-row": page("Your booking", BOOKING_COOKIE_ROW),
      "site.test /reading/row-keys": page("Developer settings", ROW_KEYS(rowKeys)),
      "site.test /reading/withheld-rows": page("Backup codes", WITHHELD_ROWS(withheldKey)),
      "site.test /reading/unnamed-list": page("Journey planner", UNNAMED_LIST),
      "site.test /reading/visit": page("Visit", "<h1>Plan your visit</h1>"),
      "frame.test /banner": page("Cookies", BANNER("frame_consent")),
      "frame.test /card": page("Card", '<label>Card number <input autocomplete="cc-number"></label><label>CVC <input autocomplete="cc-csc"></label>'),
      "frame.test /booking": page("Booking", "<h2>Booking engine</h2><label>Check-in <input type=\"date\"></label><button>Search rooms</button><p>Rooms from 140 euros</p>"),
      "frame.test /pixel": page("Pixel", "<p>pixel</p>"),
      "frame.test /fields": page("Payment", SECRET_FIELDS),
      "frame.test /tickets": page("Tickets", TICKET_ROWS),
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
    // The button in the frame of the page's own site, and the booking engine's
    // field and button, are no controls of the reading: none is listed or
    // counted, so no step or pause can reach one. Their frames' places in the
    // text, between the lines around them, say where they are.
    assert.deepEqual(reading.interactiveElements, [], "A frame's control was listed");
    assert.equal(reading.omittedControls, undefined, "A frame's control was counted");
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
    // A banner whose own names say nothing of cookies is one when its text
    // speaks of them, and a plain "Reject" is its refusal.
    reading = await read("/reading/banner-in-text");
    assert.equal(await consentAnswer(), "rejected", "a banner that speaks of cookies in its text was left up");
    assert.equal(reading.activity.declined, "cookies");
    // A refusal of the optional cookies is a refusal too: a maker's "Optionale
    // Cookies ablehnen" was left up.
    for (const [where, label] of [["/reading/banner-optional-de", "Optionale Cookies ablehnen"], ["/reading/banner-optional-en", "Reject optional cookies"]]) {
      reading = await read(where);
      assert.equal(await consentAnswer(), "rejected", `"${label}" was not pressed`);
      assert.equal(reading.activity.declined, "cookies", label);
      assert.ok(!labels(reading).includes(label), `${label} is still on the page Octo read`);
    }
    // c. A banner on a page with a sign-in field, one in a frame, a notice
    // with no reject button, a dialog about a privacy policy on the person's
    // signed-in account page that never speaks of cookies, and a banner on a
    // checkout whose card fields sit in a frame: nothing is pressed, and the
    // step says nothing.
    reading = await read("/reading/policy");
    assert.equal(await consentAnswer(), null, "a privacy policy's Decline was pressed");
    assert.ok(labels(reading).includes("Decline"));
    assert.equal(reading.activity.declined, undefined);
    reading = await read("/reading/checkout");
    assert.equal(await consentAnswer(), null, "a banner on a checkout with a card frame was answered");
    assert.ok(labels(reading).includes("Reject all"));
    assert.equal(reading.activity.declined, undefined);
    reading = await read("/reading/banner-sign-in");
    assert.equal(await consentAnswer(), null, "a banner on a sign-in page was answered");
    assert.ok(labels(reading).includes("Reject all"));
    assert.equal(reading.activity.declined, undefined);
    reading = await read("/reading/banner-frame");
    const frame = runPage.frames().find((candidate) => candidate.url().includes("frame.test"));
    assert.ok(frame, "the banner's frame loaded");
    assert.equal(await frame.evaluate(() => window.consentAnswer ?? null), null, "a banner in a frame was answered");
    assert.equal(reading.activity.declined, undefined);
    // A banner whose button takes no press yet (its script still loading) is
    // pressed and stays up: the step does not say it was declined.
    const actionsBeforeLate = fs.readFileSync(actionsPath, "utf8").length;
    reading = await read("/reading/banner-late");
    assert.match(fs.readFileSync(actionsPath, "utf8").slice(actionsBeforeLate), /"type":"click","label":"Decline cookies"/u);
    assert.equal(await consentAnswer(), null);
    assert.ok(labels(reading).includes("Reject all"), "the banner that took no press is not in the reading");
    assert.equal(reading.activity.declined, undefined);
    reading = await read("/reading/notice");
    assert.equal(await consentAnswer(), null, "a notice with no reject button was answered");
    assert.equal(reading.activity.declined, undefined);
    // d. A click on a button under that notice is refused at once in words,
    // with no wait and no call log; the notice is left up, and nothing is
    // opened or pressed.
    requests.length = 0;
    promptsBeforeBanner = prompts.length;
    let clickStarted = Date.now();
    const underNotice = await runTool("POST", "/v1/click", { index: control(reading, "Show the map").index, snapshotId: reading.snapshotId });
    measurements.coveredClickMs = Date.now() - clickStarted;
    assert.equal(underNotice.code, 1, underNotice.stdout);
    assert.ok(underNotice.stderr.includes(NOTICE_WORDS), underNotice.stderr);
    assert.doesNotMatch(underNotice.stderr, /read on under|pause on|request_human_input/u);
    assert.doesNotMatch(underNotice.stderr, /Call log|Timeout|intercepts pointer events/u);
    assert.ok(measurements.coveredClickMs < 8_000, `the covered click waited ${measurements.coveredClickMs} ms`);
    assert.equal(await consentAnswer(), null);
    assert.equal(await runPage.evaluate(() => window.pressed ?? null), null, "the button under the notice was pressed");
    assert.equal(new URL(runPage.url()).pathname, "/reading/notice");
    assert.deepEqual(requests, [], "the covered click opened something");
    assert.equal(prompts.length, promptsBeforeBanner);
    // So is a link to the page itself (an "Opening hours" whose `href="#"`
    // only runs the page's script): it has no address of its own to open.
    // Opened as one, it moved within the page, ran nothing, showed no hours,
    // and the step said its address was opened.
    const selfLink = await runTool("POST", "/v1/click", { index: control(reading, "Opening hours").index, snapshotId: reading.snapshotId });
    assert.equal(selfLink.code, 1, selfLink.stdout);
    assert.ok(selfLink.stderr.includes(NOTICE_WORDS), selfLink.stderr);
    assert.doesNotMatch(selfLink.stderr, /address was opened/u);
    assert.deepEqual(
      await runPage.evaluate(() => [window.pressed ?? null, document.getElementById("hours").hidden]),
      [null, true],
      "the link to the page itself ran or showed something",
    );
    assert.equal(runPage.url(), `${sites().site}/reading/notice`, "the link to the page itself moved the tab");
    assert.deepEqual(requests, [], "the link to the page itself opened something");
    assert.equal(prompts.length, promptsBeforeBanner);
    // A plain link under it is no click to refuse: its address opens in the
    // same tab, as a navigate step to it does, at once and with no prompt
    // under routine browsing, and the result says so. Told to open such a
    // link by its address, a turn wrote that address into its own "stopped"
    // line and never opened it. The notice is never answered.
    const actionsBeforeLink = fs.readFileSync(actionsPath, "utf8").length;
    clickStarted = Date.now();
    const linkUnderNotice = await ok("POST", "/v1/click", { index: control(reading, "Attractions").index, snapshotId: reading.snapshotId });
    measurements.coveredLinkMs = Date.now() - clickStarted;
    assert.equal(new URL(linkUnderNotice.url).pathname, "/reading/visit", "the covered link's address did not open");
    assert.equal(new URL(runPage.url()).pathname, "/reading/visit", "the covered link's address opened elsewhere than its tab");
    assert.equal(linkUnderNotice.done, COVERED_LINK_WORDS("Attractions"));
    assert.equal(linkUnderNotice.activity.step, "navigate");
    assert.match(linkUnderNotice.visibleText, /Plan your visit/u);
    assert.deepEqual(requests, [`GET ${sites().site}/reading/visit`], "the covered link opened something else");
    assert.match(fs.readFileSync(actionsPath, "utf8").slice(actionsBeforeLink), /"type":"navigate","label":"Go to [^"]*\/reading\/visit"/u);
    assert.equal(prompts.length, promptsBeforeBanner, "the covered link's address asked");
    assert.ok(measurements.coveredLinkMs < 8_000, `the covered link waited ${measurements.coveredLinkMs} ms`);
    // e. Any other cover says what to do, in words of its own.
    reading = await read("/reading/covered");
    const underCover = await runTool("POST", "/v1/click", { index: control(reading, "All lines").index, snapshotId: reading.snapshotId });
    assert.equal(underCover.code, 1, underCover.stdout);
    // It names the cover by its tag and, as a loading screen has no role or
    // label, by the first words a person sees on it, and says to try once
    // more, never to read on without it. A bare tag named nothing: a click
    // refused under an unnamed "<ol>" was never tried again.
    assert.ok(
      underCover.stderr.includes('Something else on the page covers "All lines" (<div> named "Loading departures"), so nothing was clicked. Take a fresh snapshot and try once more.'),
      underCover.stderr,
    );
    assert.doesNotMatch(underCover.stderr, /read on without it/u);
    assert.doesNotMatch(underCover.stderr, /Call log|Timeout/u);
    // One whose role says it has none is named by its words too, never by
    // its backdrop, which it hides from people.
    reading = await read("/reading/presentation-cover");
    const underNoRole = await runTool("POST", "/v1/click", { index: control(reading, "All lines").index, snapshotId: reading.snapshotId });
    assert.equal(underNoRole.code, 1, underNoRole.stdout);
    assert.ok(
      underNoRole.stderr.includes('Something else on the page covers "All lines" (<div role="presentation"> named "Choose your ticket type"), so nothing was clicked.'),
      underNoRole.stderr,
    );
    // f. A cover that goes a moment after the page moves is waited for, and
    // the click is done.
    reading = await read("/reading/covered");
    await runPage.evaluate(() => window.live.hideOnScroll());
    clickStarted = Date.now();
    const afterCover = await ok("POST", "/v1/click", { index: control(reading, "All lines").index, snapshotId: reading.snapshotId });
    measurements.coverWaitedClickMs = Date.now() - clickStarted;
    assert.equal(new URL(afterCover.url).pathname, "/reading/visit", "the click under a cover that went was not done");

    // 9. A cookie notice is never Octo's step: the browser declines it, and only the person answers it.
    // a. A notice's accept is never listed, so no step can press it: a
    // reading counts it among the controls it leaves out. Its settings, a
    // limited accept, a refusal in words no list knows and a button a page
    // dresses up beside it stay listed, and nothing is pressed. A turn that
    // saw a bar's accept listed pressed it and stopped there. The action
    // policy's refusal of an accept a step still reaches keeps its words.
    assert.equal(actionPolicyModule.refusalFor("consent").message, ACCEPT_WORDS);
    const ACCEPTS = /^(?:Accept all|Accept all cookies|aceitar e continuar|Accept and continue|Allow all|Agree and close)$/u;
    for (const [address, listed] of [
      ["/reading/cookie-notice", ["Customize cookies", "Plan a journey"]],
      ["/reading/accept-only", ["From", "To", "Plan journey"]],
      ["/reading/accept-policy-link", ["Política de cookies", "Plan a journey"]],
      ["/reading/learn-more-wall", ["Learn more"]],
      ["/reading/allow-notice", ["Cookie settings", "Accept only necessary"]],
      ["/reading/settings-link", ["Manage preferences"]],
      ["/reading/disagree-notice", ["Disagree and close"]],
      ["/reading/notice", ["Learn more"]],
      ["/reading/wrapped-notice", ["Customize cookies", "Plan a journey"]],
      ["/reading/unnamed-notice", ["Cookie settings"]],
      ["/reading/dressed-notice", ["Delete my account"]],
      ["/reading/dressed-sign-in", ["Sign in", "Book now"]],
    ]) {
      reading = await read(address);
      assert.deepEqual(labels(reading).filter((label) => ACCEPTS.test(label)), [], `${address}: an accept is listed`);
      for (const label of listed) assert.ok(labels(reading).includes(label), `${address}: "${label}" is not listed`);
      assert.ok(reading.omittedControls >= 1, `${address}: the accept left out is not counted`);
      assert.equal(await consentAnswer(), null, `${address}: the notice was answered`);
    }
    // b. A click under a notice the browser could not decline never pauses on
    // it: a plain link's address opens instead, and nothing of the notice is
    // pressed or opened.
    reading = await read("/reading/cookie-notice");
    requests.length = 0;
    const covered = await ok("POST", "/v1/click", { index: control(reading, "Plan a journey").index, snapshotId: reading.snapshotId });
    assert.equal(new URL(covered.url).pathname, "/reading/visit");
    assert.equal(covered.done, COVERED_LINK_WORDS("Plan a journey"));
    assert.doesNotMatch(JSON.stringify(covered), /pause on|request_human_input/u);
    assert.deepEqual(requests, [`GET ${sites().site}/reading/visit`], "the notice's settings or accept were opened");
    // c. A pause on a notice's own choices (its settings, a limited accept)
    // hands them to the person as theirs to make, with the cookie notice's
    // words; its accept is never listed, so never among them. A refusal in
    // words no list knows, and a booking's button in small print that speaks
    // of cookies, are steps of the person's, never named a cookie notice; the
    // booking's button, far down its page, is scrolled into view. Each is
    // outlined and published with fixed labels, and nothing is pressed or
    // answered. A control a page dressed as a notice that deletes the
    // person's account is a step the browser asks about first: nothing is
    // outlined or published. In Octo's own tab nothing is: its words never
    // send the turn to move the person's page for one.
    const humanInputsSince = (length) => fs.readFileSync(actionsPath, "utf8").slice(length).trim().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line)).filter((event) => event.type === "human_input");
    const outlined = () => runPage.evaluate(() => Array.from(document.querySelectorAll("a, button, input")).filter((element) => element.style.outlineStyle).length);
    const inView = (label) => runPage.evaluate((text) => {
      const box = Array.from(document.querySelectorAll("button")).find((element) => element.textContent === text).getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    }, label);
    for (const [address, named, code, kind] of [
      ["/reading/cookie-notice", ["Customize cookies"], "cookie_notice_required", "cookies"],
      ["/reading/allow-notice", ["Cookie settings", "Accept only necessary"], "cookie_notice_required", "cookies"],
      ["/reading/disagree-notice", ["Disagree and close"], "human_step_required", undefined],
      ["/reading/book-below", ["Book now"], "human_step_required", undefined],
    ]) {
      reading = await read(address);
      if (address === "/reading/book-below") assert.equal(await inView("Book now"), false, "the booking's button starts out of view");
      const actionsBeforePause = fs.readFileSync(actionsPath, "utf8").length;
      const paused = await runTool("POST", "/v1/request-human-input", { indices: named.map((label) => control(reading, label).index), snapshotId: reading.snapshotId });
      assert.equal(paused.code, 1, paused.stdout);
      assert.ok(paused.stderr.includes(`[${code}_non_retryable]`), `${address}: ${paused.stderr}`);
      const published = humanInputsSince(actionsBeforePause);
      assert.equal(published.length, 1, `${address}: one pause is published`);
      assert.equal(published[0].humanInputRequest.kind, kind, address);
      assert.deepEqual(
        published[0].humanInputRequest.fields,
        named.map((_, index) => ({ label: `Highlighted button ${index + 1}` })),
        `${address}: fixed labels`,
      );
      assert.equal(await outlined(), named.length, `${address}: what was outlined`);
      if (address === "/reading/book-below") assert.equal(await inView("Book now"), true, "the booking's button was not scrolled into view");
      assert.equal(await consentAnswer(), null, `${address}: the notice was answered`);
    }
    reading = await read("/reading/dressed-notice");
    const actionsBeforeDressed = fs.readFileSync(actionsPath, "utf8").length;
    const dressed = await runTool("POST", "/v1/request-human-input", { indices: [control(reading, "Delete my account").index], snapshotId: reading.snapshotId });
    assert.equal(dressed.code, 1, dressed.stdout);
    assert.ok(dressed.stderr.includes("is a step Octo takes only with the person's yes"), dressed.stderr);
    assert.doesNotMatch(dressed.stderr, /cookie|_non_retryable/u);
    assert.deepEqual(humanInputsSince(actionsBeforeDressed), [], "a pause on an account's deletion was published");
    assert.equal(await outlined(), 0, "an account's deletion was outlined");
    assert.equal(await consentAnswer(), null, "the dressed notice was answered");
    const ownTab = await ok("POST", "/v1/tabs/open", { url: `${sites().site}/reading/cookie-notice` });
    assert.ok(ownTab.tabId, `the page opened in a tab of Octo's own: ${JSON.stringify(ownTab).slice(0, 300)}`);
    reading = await ok("GET", "/v1/snapshot");
    assert.equal(reading.tabId, ownTab.tabId, "read in Octo's own tab");
    assert.deepEqual(labels(reading).filter((label) => ACCEPTS.test(label)), [], "an accept is listed in Octo's own tab");
    const actionsBeforeOwnTab = fs.readFileSync(actionsPath, "utf8").length;
    const ownTabPause = await runTool("POST", "/v1/request-human-input", { indices: [control(reading, "Customize cookies").index], snapshotId: reading.snapshotId });
    assert.equal(ownTabPause.code, 1, ownTabPause.stdout);
    assert.ok(ownTabPause.stderr.includes("Octo's own tabs are for reading, so nothing was highlighted. Stop at a sign-in or form and tell the person."), ownTabPause.stderr);
    assert.doesNotMatch(ownTabPause.stderr, /cookie|select_tab|_non_retryable/u);
    assert.deepEqual(humanInputsSince(actionsBeforeOwnTab), [], "a pause was published in Octo's own tab");
    await ok("POST", "/v1/tabs/close", { tabId: ownTab.tabId });
    // d. Under a bar whose only button accepts, which covers nothing of the
    // planner, every index points at the planner and the bar's accept is
    // counted as left out: the planner's own button works with no prompt,
    // and the bar is never answered.
    reading = await read("/reading/accept-only");
    assert.deepEqual(labels(reading), ["From", "To", "Plan journey"]);
    assert.equal(reading.omittedControls, 1);
    const promptsBeforePlanner = prompts.length;
    const planned = await ok("POST", "/v1/click", { index: control(reading, "Plan journey").index, snapshotId: reading.snapshotId });
    assert.match(planned.visibleText, /Route: Line D towards Hospital São João, 2 stops/u, "the planner under the bar did not answer");
    assert.equal(prompts.length, promptsBeforePlanner, "the planner's button asked");
    assert.match(planned.visibleText, /This site uses cookies/u, "the bar went away");
    assert.equal(await consentAnswer(), null, "the bar was answered");

    // 10. A step's reading waits for what it draws.
    // a. A click whose route the page draws in place 1.5 s later reads it: a
    // click read a planner before its route was drawn, and the turn said the
    // planner showed none.
    reading = await read("/reading/draws");
    let started = Date.now();
    const drawn = await ok("POST", "/v1/click", { index: control(reading, "Plan journey").index, snapshotId: reading.snapshotId });
    measurements.drawnLaterClickMs = Date.now() - started;
    assert.match(drawn.visibleText, /Route: Line D towards Hospital São João, 2 stops/u, "the click read the page before its route was drawn");
    assert.equal(drawn.done, undefined, drawn.done);
    // b. One whose route comes 5 s after it reads that route itself: its
    // step looks for as long as the snapshot it once left to the turn, which
    // turns never took. One whose page still reads as it did 6 s on says so,
    // and that its reading is the page as it is now: no snapshot is left to
    // take.
    reading = await read("/reading/draws");
    started = Date.now();
    const slow = await ok("POST", "/v1/click", { index: control(reading, "Plan the slow way").index, snapshotId: reading.snapshotId });
    measurements.slowClickMs = Date.now() - started;
    assert.match(slow.visibleText, /Route: Line A towards Senhor de Matosinhos, 5 stops/u, "the step's reading was not the page as it came");
    assert.equal(slow.done, undefined, slow.done);
    reading = await read("/reading/draws");
    started = Date.now();
    const unchangedClick = await ok("POST", "/v1/click", { index: control(reading, "Check for delays").index, snapshotId: reading.snapshotId });
    measurements.unchangedClickMs = Date.now() - started;
    assert.equal(unchangedClick.done, `Clicked "Check for delays". ${UNCHANGED_WORDS}`);
    assert.doesNotMatch(unchangedClick.done, /snapshot/u);
    // c. A click that changes the page, in place, by scrolling it or by
    // opening another, answers at once.
    reading = await read("/reading/draws");
    started = Date.now();
    const fares = await ok("POST", "/v1/click", { index: control(reading, "Show fares").index, snapshotId: reading.snapshotId });
    measurements.changedClickMs = Date.now() - started;
    assert.match(fares.visibleText, /Fares: Z2 1\.40 euros/u);
    assert.equal(fares.done, undefined, fares.done);
    reading = await read("/reading/draws");
    started = Date.now();
    const scrolled = await ok("POST", "/v1/click", { index: control(reading, "Go to the end").index, snapshotId: reading.snapshotId });
    measurements.scrolledClickMs = Date.now() - started;
    assert.equal(scrolled.done, undefined, scrolled.done);
    reading = await read("/reading/draws");
    started = Date.now();
    const visit = await ok("POST", "/v1/click", { index: control(reading, "Plan your visit").index, snapshotId: reading.snapshotId });
    measurements.openedClickMs = Date.now() - started;
    assert.equal(new URL(visit.url).pathname, "/reading/visit");
    assert.equal(visit.done, undefined, visit.done);
    // A link to the page it is on loads it again, which reads as it did: that
    // new page is what the click asked for, so it answers at once too.
    reading = await read("/reading/draws");
    started = Date.now();
    const again = await ok("POST", "/v1/click", { index: control(reading, "Start over").index, snapshotId: reading.snapshotId });
    measurements.reloadedClickMs = Date.now() - started;
    assert.equal(again.done, undefined, again.done);
    // A link to a part of the page it is on is a click like any other. One
    // whose part is in view moves nothing but the address, so the step looks
    // again and reads the words the page draws for that part 1.2 s later:
    // answered as soon as the address named the part, the click read the
    // page without them.
    reading = await read("/reading/parts");
    const part = await ok("POST", "/v1/click", { index: control(reading, "Weekend times").index, snapshotId: reading.snapshotId });
    assert.equal(new URL(part.url).hash, "#weekend");
    assert.match(part.visibleText, /Every 12 minutes\./u, "the click read the page before its part was drawn");
    assert.equal(part.done, undefined, part.done);
    // d. A type step answers at once and says nothing was searched, or for a
    // field that is no search sent, yet: a turn typed into a site's search,
    // never sent it, and wrote that it returned no results. A choice that
    // changes only its list answers at once too.
    reading = await read("/reading/draws");
    started = Date.now();
    const searchTyped = await ok("POST", "/v1/type", { index: control(reading, "Search stops").index, snapshotId: reading.snapshotId, text: "Trindade" });
    measurements.typeMs = Date.now() - started;
    assert.equal(searchTyped.done, `Typed 8 characters into "Search stops". A page's reading never shows typed text. Nothing was searched yet.`);
    const typedFrom = await ok("POST", "/v1/type", { index: control(searchTyped, "From").index, snapshotId: searchTyped.snapshotId, text: "Aliados" });
    assert.equal(typedFrom.done, `Typed 7 characters into "From". A page's reading never shows typed text. Nothing was sent yet.`);
    started = Date.now();
    const chosen = await ok("POST", "/v1/choose", { index: control(typedFrom, "Day").index, snapshotId: typedFrom.snapshotId, option: "Tuesday" });
    measurements.chooseMs = Date.now() - started;
    assert.equal(chosen.done, "Chose \"Tuesday\" in \"Day\".", "A list in no form says only what was chosen");
    // The option the list already holds changes nothing: it says so at once,
    // with no look for a page that reads as before.
    started = Date.now();
    const chosenAgain = await ok("POST", "/v1/choose", { index: control(chosen, "Day").index, snapshotId: chosen.snapshotId, option: "Tuesday" });
    measurements.chooseAgainMs = Date.now() - started;
    assert.equal(chosenAgain.done, "\"Tuesday\" was already chosen.");
    assert.equal(control(chosenAgain, "Day").chosen, "Tuesday");
    // e. What a click shows in place counts as the page answering, as the
    // reading shows it, though the page's text was there all along: a section
    // that slides open, a menu that fades in, a drawer and a carousel that
    // move into view, and a switch or a toggle button the click turned on.
    // Each answers at once: compared with the page's whole text, each waited
    // and said the page read as before, beside a reading that showed it.
    for (const [label, shown] of [
      ["Show specs", /Battery 61 Wh, warranty one year/u],
      ["Menu", /Laptops, desktops and monitors/u],
      ["Open filters", /Price under 1000 euros/u],
      ["More reviews", /Review two: the battery lasts long/u],
      ["Step-free routes", null],
      ["Large text", null],
    ]) {
      reading = await read("/reading/reveals");
      if (shown) assert.doesNotMatch(reading.visibleText, shown, `${label} showed before its click`);
      started = Date.now();
      const revealed = await ok("POST", "/v1/click", { index: control(reading, label).index, snapshotId: reading.snapshotId });
      measurements[`revealed ${label}`] = Date.now() - started;
      if (shown) assert.match(revealed.visibleText, shown, `${label} did not show`);
      assert.doesNotMatch(String(revealed.done || ""), /reads as it did before/u, `${label}: ${revealed.done}`);
      assert.ok(measurements[`revealed ${label}`] < measurements.unchangedClickMs - 1_500,
        `${label} waited ${measurements[`revealed ${label}`]} ms, against ${measurements.unchangedClickMs} ms for a page that read as before`);
    }
    // f. A route drawn 1.5 s after the click is read whatever else the click
    // changed first: a field nobody sees, a tip the pointer shows over the
    // button, a suggestion a field drops as it loses focus, or an address the
    // page writes its search into. Each of these returned the planner without
    // its route, and said nothing of it.
    for (const [pathname, prepare] of [
      ["/reading/hidden-field", null],
      ["/reading/hover-tip", null],
      ["/reading/blur-suggestion", async (planner) =>
        await ok("POST", "/v1/type", { index: control(planner, "From").index, snapshotId: planner.snapshotId, text: "Sao Bento" })],
      ["/reading/address-search", null],
    ]) {
      reading = await read(pathname);
      await runPage.mouse.move(1, 1);
      if (prepare) reading = await prepare(reading);
      const routed = await ok("POST", "/v1/click", { index: control(reading, "Plan journey").index, snapshotId: reading.snapshotId });
      assert.match(routed.visibleText, /Route: Line D towards Hospital São João, 2 stops/u, `${pathname}: the click read the page before its route was drawn`);
      assert.equal(routed.done, undefined, `${pathname}: ${routed.done}`);
    }
    // g. A type step types as a person does, ending on a key press, and names
    // the first options of the list its field opens then: a planner's stop
    // lists opened only as keys were pressed, the step set the value alone,
    // and turns pressed Tab or the wrong button and said the planner gave no
    // route. A field that names its list (a combobox) is waited for as long as
    // its site takes; one that names none, for a moment. Typing sends nothing:
    // the planner's form goes only with its button.
    reading = await read("/reading/key-lists");
    requests.length = 0;
    started = Date.now();
    const typedFromStop = await ok("POST", "/v1/type", { index: control(reading, "From").index, snapshotId: reading.snapshotId, text: "Central" });
    measurements.typeListMs = Date.now() - started;
    const fromStops = typedFromStop.interactiveElements.filter((entry) => entry.role === "option");
    assert.deepEqual(fromStops.map((entry) => entry.label), ["Central Station", "Central Square", "Old Central Park"], "the list the field opens as keys are pressed never opened");
    assert.equal(
      typedFromStop.done,
      `Typed 7 characters into "From". A page's reading never shows typed text. 3 suggestions under "From": ${fromStops.map((entry) => `"${entry.label}" (index ${entry.index})`).join(", ")}. Click one. Nothing was sent yet.`,
    );
    // Typed into again, the field's own list it narrows is named whole: an
    // option it showed before the step is still one of its suggestions.
    const typedRefined = await ok("POST", "/v1/type", { index: control(typedFromStop, "From").index, snapshotId: typedFromStop.snapshotId, text: "Old" });
    const refinedStops = typedRefined.interactiveElements.filter((entry) => entry.role === "option");
    assert.deepEqual(refinedStops.map((entry) => entry.label), ["Old Central Park", "Old Town"]);
    assert.equal(
      typedRefined.done,
      `Typed 3 characters into "From". A page's reading never shows typed text. 2 suggestions under "From": ${refinedStops.map((entry) => `"${entry.label}" (index ${entry.index})`).join(", ")}. Click one. Nothing was sent yet.`,
      "a list the field narrowed was named in part",
    );
    const typedToStop = await ok("POST", "/v1/type", { index: control(typedRefined, "To").index, snapshotId: typedRefined.snapshotId, text: "Harbour" });
    const toStops = typedToStop.interactiveElements.filter((entry) => entry.role === "option" && entry.tag === "button");
    assert.deepEqual(toStops.map((entry) => entry.label), ["Harbour", "Harbour (Metro)"]);
    assert.equal(
      typedToStop.done,
      `Typed 7 characters into "To". A page's reading never shows typed text. 2 suggestions under "To": ${toStops.map((entry) => `"${entry.label}" (index ${entry.index})`).join(", ")}. Click one. Nothing was sent yet.`,
      "a field that names no list did not name the options that came under it",
    );
    // A text that ends on a key of its own (a new line) is set, never typed:
    // its Enter would send the form.
    const typedNewLine = await ok("POST", "/v1/type", { index: control(typedToStop, "To").index, snapshotId: typedToStop.snapshotId, text: "Harbour\n" });
    assert.match(typedNewLine.done, /^Typed 8 characters into "To", and the field holds 7 characters now\./u, typedNewLine.done);
    // A field whose own list shows nothing names nothing, though another
    // field's list still shows: those are not its suggestions.
    const typedNoStop = await ok("POST", "/v1/type", { index: control(typedNewLine, "From").index, snapshotId: typedNewLine.snapshotId, text: "Zzzz" });
    assert.equal(
      typedNoStop.done,
      `Typed 4 characters into "From". A page's reading never shows typed text. Nothing was sent yet.`,
      "another field's options were named as this field's suggestions",
    );
    assert.equal(new URL(runPage.url()).pathname, "/reading/key-lists", "typing sent the planner's form");
    assert.deepEqual(requests, [], "typing sent something");
    // A field whose list fills only on a key opens it for a text that ends on
    // a letter a US keyboard has no key for. A row turned off (a list's
    // "Searching…", or its "No matching stops") is never a suggestion: the
    // step waits past it for the stops, and names nothing when only it shows.
    reading = await read("/reading/key-only-list");
    requests.length = 0;
    const typedAccent = await ok("POST", "/v1/type", { index: control(reading, "Stop").index, snapshotId: reading.snapshotId, text: "Café" });
    assert.equal(await runPage.evaluate(() => window.keys), 1, "the text's last letter went in with no key");
    const accentStops = typedAccent.interactiveElements.filter((entry) => entry.role === "option");
    assert.deepEqual(accentStops.map((entry) => entry.label), ["Market Café", "Museum Café"], "the list a key opens never opened");
    assert.equal(
      typedAccent.done,
      `Typed 4 characters into "Stop". A page's reading never shows typed text. 2 suggestions under "Stop": ${accentStops.map((entry) => `"${entry.label}" (index ${entry.index})`).join(", ")}. Click one. Nothing was sent yet.`,
    );
    const typedLoading = await ok("POST", "/v1/type", { index: control(typedAccent, "Stop").index, snapshotId: typedAccent.snapshotId, text: "Harbour" });
    const loadedStops = typedLoading.interactiveElements.filter((entry) => entry.role === "option");
    assert.deepEqual(loadedStops.map((entry) => entry.label), ["Harbour Market"], "the step answered before the stops came");
    assert.equal(
      typedLoading.done,
      `Typed 7 characters into "Stop". A page's reading never shows typed text. 1 suggestion under "Stop": "Harbour Market" (index ${loadedStops[0].index}). Click one. Nothing was sent yet.`,
    );
    const typedUnmatched = await ok("POST", "/v1/type", { index: control(typedLoading, "Stop").index, snapshotId: typedLoading.snapshotId, text: "Zzzz" });
    assert.equal(
      typedUnmatched.done,
      `Typed 4 characters into "Stop". A page's reading never shows typed text. Nothing was sent yet.`,
      "a row turned off was named as a suggestion",
    );
    assert.deepEqual(requests, [], "typing sent something");
    // A field that says it opens a list and opens none names nothing: a list
    // the page always shows beside it is not its suggestions.
    reading = await read("/reading/sorted-search");
    const typedSorted = await ok("POST", "/v1/type", { index: control(reading, "Search museums").index, snapshotId: reading.snapshotId, text: "modern art" });
    assert.match(typedSorted.done, /^Typed 10 characters into "Search museums"\. /u, typedSorted.done);
    assert.doesNotMatch(typedSorted.done, /suggestion/u, "a list the field never opened was named as its suggestions");
    // A page that moves the focus to a suggestion, opens a search field of its
    // own with the words, or replaces the field as text goes in keeps the
    // whole text, in order, as setting it left it: no key goes in before the
    // text, and the step does not fail half-typed.
    reading = await read("/reading/moving-fields");
    const typedPlace = await ok("POST", "/v1/type", { index: control(reading, "Place").index, snapshotId: reading.snapshotId, text: "Riverside" });
    assert.equal(await runPage.evaluate(() => document.getElementById("place").value), "Riverside", "the last key went in before the text");
    assert.match(typedPlace.done, /^Typed 9 characters into "Place"\. /u, typedPlace.done);
    const typedStart = await ok("POST", "/v1/type", { index: control(typedPlace, "Start").index, snapshotId: typedPlace.snapshotId, text: "Central" });
    assert.deepEqual(
      await runPage.evaluate(() => ["start", "panel-search"].map((id) => document.getElementById(id).value)),
      ["Central", "Central"],
      "the last key went in before the text",
    );
    assert.match(typedStart.done, /^Typed 7 characters into "Start"\. /u, typedStart.done);
    const typedFind = await ok("POST", "/v1/type", { index: control(typedStart, "Find").index, snapshotId: typedStart.snapshotId, text: "Old Town" });
    assert.equal(await runPage.evaluate(() => document.getElementById("find").value), "Old Town", "the field the page put in was left short");
    assert.match(typedFind.done, /^Typed 8 characters into "Find"\. /u, typedFind.done);
    // A field's options a reading's cap would leave out, and stops drawn as
    // plain rows. A planner's stops showed only in a page's text: the reading
    // listed 40 controls and left out 1,211, the type step named no stop, and
    // the turn clicked a map and said it had chosen one. The options the
    // field opened are listed first under the cap, its plain rows too, and
    // the type step names them with the indices the next click takes.
    for (const [pathname, label, text, stops] of [
      ["/reading/capped-list", "From", "Central", ["Central Station", "Central Square"]],
      // Typed without its umlaut, as a person without the key types it.
      ["/reading/plain-rows", "Origin", "Suedpark",
        ["Südpark Neustadt", "Südpark (Tram) Neustadt", "Südpark Nord Neustadt", "Südpark West Neustadt"]],
    ]) {
      await runPage.mouse.move(1, 1);
      reading = await read(pathname);
      assert.ok(reading.omittedControls > 0, `${pathname}: the page holds more controls than a reading: ${reading.omittedControls}`);
      requests.length = 0;
      // The field the site marks against autofill alone is typed into.
      const typedStops = await ok("POST", "/v1/type", { index: control(reading, label).index, snapshotId: reading.snapshotId, text });
      const listed = stops.map((stop) => control(typedStops, stop));
      assert.equal(typedStops.interactiveElements.length, 200, `${pathname}: the reading holds its 200 controls`);
      assert.match(
        typedStops.done,
        new RegExp(`^Typed ${Array.from(text).length} characters into "${label}"\\. A page's reading never shows typed text\\. `, "u"),
        typedStops.done,
      );
      assert.ok(
        typedStops.done.includes(`${stops.length} suggestions under "${label}": ${listed.slice(0, 4).map(({ index }, at) => `"${stops[at]}" (index ${index})`).join(", ")}. Click one.`),
        `${pathname}: the type step did not name the field's options: ${typedStops.done}`,
      );
      // The index it names is the one the click takes: the stop is chosen
      // once, with the focus left in the field.
      const chosen = await runTool("POST", "/v1/click", { index: listed[1].index, snapshotId: typedStops.snapshotId });
      assert.equal(chosen.code, 0, `${pathname}: the click on a suggestion failed: ${chosen.stderr}`);
      assert.equal(await runPage.evaluate(() => window.chosen), 1, `${pathname}: the stop was not chosen once`);
      assert.equal(
        await runPage.evaluate((id) => document.getElementById(id).value, pathname === "/reading/capped-list" ? "from" : "origin"),
        stops[1].replace(/ Neustadt$/u, ""),
        `${pathname}: another stop was chosen`,
      );
      assert.deepEqual(requests, [], `${pathname}: choosing a stop sent something`);
    }
    // A calendar a day field opens under it is no list of its stops: the
    // type step names none of its rows.
    reading = await read("/reading/plain-rows");
    const typedDay = await ok("POST", "/v1/type", { index: control(reading, "Day").index, snapshotId: reading.snapshotId, text: "20.11.2026" });
    assert.equal(await runPage.evaluate(() => getComputedStyle(document.getElementById("calendar")).display), "table", "the calendar never opened");
    assert.doesNotMatch(typedDay.done, /suggestion/u, `a calendar's rows were named as the field's suggestions: ${typedDay.done}`);
    // Neither is a calendar the day field names as its own (aria-controls):
    // none of its weeks is listed as a control or named.
    reading = await read("/reading/named-calendar");
    const typedNamedDay = await ok("POST", "/v1/type", { index: control(reading, "Day").index, snapshotId: reading.snapshotId, text: "20.11.2026" });
    assert.equal(await runPage.evaluate(() => getComputedStyle(document.getElementById("calendar")).display), "block", "the named calendar never opened");
    assert.doesNotMatch(typedNamedDay.done, /suggestion/u, `a named calendar's weeks were named as the field's suggestions: ${typedNamedDay.done}`);
    assert.deepEqual(
      typedNamedDay.interactiveElements.map((entry) => entry.label), ["Day", "Plan journey"],
      "a named calendar's weeks were listed as controls",
    );
    // A stop's row that holds two controls is named by the one that draws
    // the stop, not the "Save" before it, with the index a click takes: the
    // stop is chosen once, with the focus left in the field, and nothing is
    // saved.
    reading = await read("/reading/row-controls");
    const typedRows = await ok("POST", "/v1/type", { index: control(reading, "From").index, snapshotId: reading.snapshotId, text: "Central" });
    const stopLinks = ["Central Station", "Central Square"].map((stop) => control(typedRows, stop));
    assert.deepEqual(stopLinks.map(({ tag }) => tag), ["a", "a"]);
    assert.ok(
      typedRows.done.includes(`2 suggestions under "From": "Central Station" (index ${stopLinks[0].index}), "Central Square" (index ${stopLinks[1].index}). Click one.`),
      `the type step did not name the stops by their links: ${typedRows.done}`,
    );
    assert.doesNotMatch(typedRows.done, /doesn't list them/u, typedRows.done);
    const chosenRow = await runTool("POST", "/v1/click", { index: stopLinks[1].index, snapshotId: typedRows.snapshotId });
    assert.equal(chosenRow.code, 0, `the click on a stop's link failed: ${chosenRow.stderr}`);
    assert.deepEqual(
      await runPage.evaluate(() => [window.chosen, window.saved, document.getElementById("from").value, document.activeElement?.id]),
      [1, 0, "Central Square", "from"],
    );
    // A box that names a list is no field a person types into: once it is
    // ticked, with the focus on it, the reading lists what it listed before,
    // the form's field and button too, and none of the list's rows.
    reading = await read("/reading/ticked-list");
    const beforeTick = reading.interactiveElements.map((entry) => entry.label);
    assert.ok(["From", "Show times"].every((label) => beforeTick.includes(label)), beforeTick.join(", "));
    await ok("POST", "/v1/click", { index: control(reading, "Step-free stops only").index, snapshotId: reading.snapshotId });
    assert.equal(await runPage.evaluate(() => document.activeElement?.id), "step-free", "the box did not keep the focus");
    const afterTick = await ok("GET", "/v1/snapshot");
    assert.deepEqual(afterTick.interactiveElements.map((entry) => entry.label), beforeTick, "a ticked box's list changed what the reading lists");
    assert.equal(afterTick.omittedControls ?? 0, reading.omittedControls ?? 0);
    // A search box that names the list of the page's own it filters gets no
    // suggestions: its rows are the page's text, not a list it opened.
    reading = await read("/reading/filtered-list");
    const typedFilter = await ok("POST", "/v1/type", { index: control(reading, "Filter stations").index, snapshotId: reading.snapshotId, text: "Central" });
    assert.deepEqual(await runPage.evaluate(() => Array.from(document.querySelectorAll("#stations li")).filter((row) => !row.hidden).length), 2);
    assert.doesNotMatch(typedFilter.done, /suggestion/u, `a filtered list's rows were named as suggestions: ${typedFilter.done}`);
    assert.deepEqual(typedFilter.interactiveElements.map((entry) => entry.label), ["Filter stations"], "a filtered list's rows were listed as controls");
    // h. A click on a plain link the page does not take in time (one that
    // keeps moving) opens the link's address in the tab, as a link under a
    // cookie notice does: a museum's hours link timed out, and the turn said
    // its page did not finish loading.
    reading = await read("/reading/moving-link");
    requests.length = 0;
    started = Date.now();
    const movingLink = await ok("POST", "/v1/click", { index: control(reading, "Opening hours").index, snapshotId: reading.snapshotId });
    measurements.movingLinkMs = Date.now() - started;
    assert.equal(movingLink.done, NOT_TAKEN_LINK_WORDS("Opening hours"));
    assert.equal(new URL(movingLink.url).pathname, "/reading/visit", "the link's address did not open");
    assert.equal(new URL(runPage.url()).pathname, "/reading/visit", "the link's address opened elsewhere than its tab");
    assert.deepEqual(requests, [`GET ${sites().site}/reading/visit`], "the link's address was not opened once");
    assert.ok(measurements.movingLinkMs < 12_000, `the moving link waited ${measurements.movingLinkMs} ms`);

    // 11. A field's own suggestion, chosen by a click. Every click on a
    // planner's named stop failed on an option no longer in the page: the
    // focus the click took out of the field first closed its list. The turn
    // went on with arrow keys and Enter, which sent the planner's form with no
    // stop chosen.
    for (const pathname of ["/reading/blur-list", "/reading/redraw-list"]) {
      // The pointer is away from the list as it opens, and comes to the stop
      // from elsewhere, as a person's does.
      await runPage.mouse.move(1, 1);
      reading = await read(pathname);
      const typedStops = await ok("POST", "/v1/type", { index: control(reading, "From").index, snapshotId: reading.snapshotId, text: "Central" });
      const clickedStop = await runTool("POST", "/v1/click", { index: control(typedStops, "Central Station").index, snapshotId: typedStops.snapshotId });
      assert.equal(clickedStop.code, 0, `${pathname}: the click on a suggestion failed: ${clickedStop.stderr}`);
      assert.match(clickedStop.payload.visibleText, /From: Central Station/u, `${pathname}: the stop was not chosen`);
      assert.equal(clickedStop.payload.activity.step, "click", pathname);
      assert.equal(await runPage.evaluate(() => window.chosen), 1, `${pathname}: the stop was not chosen once`);
    }
    // A stop the list no longer shows is not clicked: the step answers with
    // the field's suggestions as the page reads now.
    await runPage.mouse.move(1, 1);
    reading = await read("/reading/moving-list");
    const typedMoving = await ok("POST", "/v1/type", { index: control(reading, "From").index, snapshotId: reading.snapshotId, text: "Central" });
    const goneStop = await runTool("POST", "/v1/click", { index: control(typedMoving, "Central Station").index, snapshotId: typedMoving.snapshotId });
    assert.equal(goneStop.code, 0, `the click on a stop the list redrew failed: ${goneStop.stderr}`);
    const stopsNow = goneStop.payload.interactiveElements.filter((entry) => entry.role === "option");
    assert.deepEqual(stopsNow.map((entry) => entry.label), ["Harbour", "Harbour (Metro)"]);
    assert.equal(
      goneStop.payload.done,
      `"Central Station" was no longer in the list under "From" when the click came, so nothing was clicked. 2 suggestions under "From": ${stopsNow.map((entry) => `"${entry.label}" (index ${entry.index})`).join(", ")}. If the one wanted is among them, click it; otherwise type into "From" again.`,
    );
    assert.equal(goneStop.payload.activity.step, "snapshot", "a click that clicked nothing was listed as one");
    assert.equal(await runPage.evaluate(() => window.chosen), 0, "a stop the list no longer showed was chosen");

    // 12. A ticket shop's controls with no name of their own. A reading
    // listed a ticket page's buttons as "unnamed button", none told apart,
    // and named no ticket's control: whether such controls sit in a frame or
    // in the page itself is what the reading's frame marks and its count of
    // the controls it leaves out say. In the page, each is named by its row
    // or card, and none is left out; in a frame, the frame's site is named
    // where it shows, and none is listed or counted.
    reading = await read("/reading/tickets");
    assert.deepEqual(labels(reading), [
      "\u2212 beside \u201cAdult\u201d",
      "+ beside \u201cAdult\u201d",
      "button beside \u201cChild\u201d",
      "add button beside \u201cChild\u201d",
      "button beside \u201cMuseum entrance\u201d",
    ]);
    assert.equal(reading.omittedControls, undefined, "a ticket's control was left out");
    assert.doesNotMatch(reading.visibleText, /\[frame not read/u);
    const framedTickets = await read("/reading/tickets-framed");
    assert.equal(framedTickets.visibleText, "Book your visit\n[frame not read: frame.test]");
    assert.deepEqual(framedTickets.interactiveElements, [], "a frame's ticket control was listed");
    assert.equal(framedTickets.omittedControls, undefined, "a frame's ticket control was counted");
    // The person's step on a row's control is highlighted by its name, as
    // any of the page's own controls is.
    reading = await read("/reading/tickets");
    const actionsBeforeTickets = fs.readFileSync(actionsPath, "utf8").length;
    const ticketPause = await runTool("POST", "/v1/request-human-input", { indices: [control(reading, "+ beside \u201cAdult\u201d").index], snapshotId: reading.snapshotId });
    assert.equal(ticketPause.code, 1, ticketPause.stdout);
    assert.ok(ticketPause.stderr.includes("[human_step_required_non_retryable]"), ticketPause.stderr);
    const ticketPauses = humanInputsSince(actionsBeforeTickets);
    assert.equal(ticketPauses.length, 1, "the row's control was not highlighted");
    assert.deepEqual(ticketPauses[0].humanInputRequest.fields, [{ label: "Highlighted button 1" }]);
    assert.equal(await outlined(), 1, "the row's control was not outlined");

    // 13. A row's words only tell its controls apart where they are named.
    // When a step's checks read them, a "+" beside "How do I delete my
    // account?" and a "×" over "Save 10%" asked under routine browsing and
    // were refused in Octo's own tab, a booking's icon button under a line
    // that speaks of cookies was paused on as a cookie notice's, a key the
    // page's text masked named the button beside it by its first 40
    // characters, and a withheld page's rows named its controls. And a stop
    // drawn anew, for a field that names no list of its own, answered with
    // every option on the page as its suggestions, and said to click one.
    // Each case runs on its own, and every one that fails is reported.
    const rowProblems = [];
    const rowCase = async (what, check) => {
      try {
        await check();
      } catch (error) {
        rowProblems.push(`${what}: ${error.message}`);
        // A prompt the fixture did not answer stays behind for the next step.
        fs.rmSync(path.join(approvalDirectory, "request.json"), { force: true });
      }
    };
    const ROW_WORDS_LABELS = [
      "+ beside \u201cHow do I delete my account?\u201d",
      "\u2212 beside \u201cBook a guided tour\u201d",
      "+ beside \u201cBook a guided tour\u201d",
      "\u00d7 beside \u201cSave 10% on your first order\u201d",
      "button beside \u201cBook a guided tour\u201d",
    ];
    await rowCase("reading steps in rows whose words a step's checks ask about", async () => {
      reading = await read("/reading/row-words");
      const promptsBeforeRows = prompts.length;
      // By their places in the reading: an answer's "+", then a tour's.
      const answered = await ok("POST", "/v1/click", { index: reading.interactiveElements[0].index, snapshotId: reading.snapshotId });
      assert.match(answered.visibleText, /Open Settings, then Account\./u);
      await ok("POST", "/v1/click", { index: answered.interactiveElements[2].index, snapshotId: answered.snapshotId });
      assert.equal(await runPage.evaluate(() => document.getElementById("tours").textContent), "1");
      assert.equal(prompts.length, promptsBeforeRows, "a reading step in a row asked");
      assert.deepEqual(labels(reading), ROW_WORDS_LABELS);
    });
    await rowCase("the same steps in Octo's own tab", async () => {
      const ownRows = await ok("POST", "/v1/tabs/open", { url: `${sites().site}/reading/row-words` });
      try {
        let ownReading = await ok("GET", "/v1/snapshot");
        assert.equal(ownReading.tabId, ownRows.tabId, "read in Octo's own tab");
        // A card's arrow, then an offer's "×".
        ownReading = await ok("POST", "/v1/click", { index: ownReading.interactiveElements[4].index, snapshotId: ownReading.snapshotId });
        assert.match(ownReading.visibleText, /Meet at the main entrance\./u);
        ownReading = await ok("POST", "/v1/click", { index: ownReading.interactiveElements[3].index, snapshotId: ownReading.snapshotId });
        assert.doesNotMatch(ownReading.visibleText, /Save 10%/u);
      } finally {
        await runTool("POST", "/v1/tabs/close", { tabId: ownRows.tabId });
      }
    });
    await rowCase("a pause on a booking's icon button in a part that speaks of cookies", async () => {
      reading = await read("/reading/booking-cookie-row");
      const actionsBeforeRowPause = fs.readFileSync(actionsPath, "utf8").length;
      const paused = await runTool("POST", "/v1/request-human-input", { indices: [control(reading, "button beside \u201cCookies keep your booking while you\u201d").index], snapshotId: reading.snapshotId });
      assert.equal(paused.code, 1, paused.stdout);
      assert.ok(paused.stderr.includes("[human_step_required_non_retryable]"), paused.stderr);
      const published = humanInputsSince(actionsBeforeRowPause);
      assert.equal(published.length, 1, "one pause is published");
      assert.equal(published[0].humanInputRequest.kind, undefined);
      assert.equal(await consentAnswer(), null, "the booking's button was pressed");
    });
    await rowCase("keys beside icon buttons", async () => {
      reading = await read("/reading/row-keys");
      assert.equal(reading.secretScreen, false, "the page was withheld");
      assert.equal(reading.interactiveElements.length, rowKeys.length);
      const said = JSON.stringify(reading);
      for (const key of rowKeys) {
        for (let at = 0; at + 10 <= key.length; at += 1) {
          assert.ok(!said.includes(key.slice(at, at + 10)), `part of a key was read: ${labels(reading).join(", ")}`);
        }
      }
    });
    await rowCase("a withheld page's controls", async () => {
      reading = await read("/reading/withheld-rows");
      assert.equal(reading.secretScreen, true, "the page was not withheld");
      assert.doesNotMatch(JSON.stringify(reading), /river stone/u);
      const added = reading.interactiveElements.find((entry) => entry.label === "+");
      assert.ok(added, labels(reading).join(", "));
      // A step's own words name it as the reading does: a pause on it, which
      // never hands over a withheld page's control, names it so.
      const paused = await runTool("POST", "/v1/request-human-input", { indices: [added.index], snapshotId: reading.snapshotId });
      assert.equal(paused.code, 1, paused.stdout);
      assert.ok(paused.stderr.includes('"+" may show or change a secret, so nothing was highlighted.'), paused.stderr);
      assert.doesNotMatch(paused.stderr, /river stone/u);
    });
    await rowCase("a stop drawn anew for a field that names no list of its own", async () => {
      await runPage.mouse.move(1, 1);
      reading = await read("/reading/unnamed-list");
      const typedUnnamed = await ok("POST", "/v1/type", { index: control(reading, "From").index, snapshotId: reading.snapshotId, text: "Central" });
      assert.match(typedUnnamed.done, /2 suggestions under "From": "Central Station" \(index \d+\), "Central Square" \(index \d+\)\. Click one\./u);
      const gone = await runTool("POST", "/v1/click", { index: control(typedUnnamed, "Central Station").index, snapshotId: typedUnnamed.snapshotId });
      assert.equal(gone.code, 0, gone.stderr);
      assert.equal(
        gone.payload.done,
        '"Central Station" was no longer in its list when the click came, so nothing was clicked. Type into "From" again to see its suggestions.',
      );
      assert.equal(await runPage.evaluate(() => window.chosen), 0, "a stop was chosen");
    });
    assert.deepEqual(rowProblems, [], rowProblems.join("\n"));

    for (const [name, ms] of [
      ["a click that changed the page", measurements.changedClickMs],
      ["a click that scrolled the page", measurements.scrolledClickMs],
      ["a click that opened a page", measurements.openedClickMs],
      ["a click that opened the page it was on", measurements.reloadedClickMs],
      ["a type step", measurements.typeMs],
      ["a choice", measurements.chooseMs],
      ["a choice of the option already chosen", measurements.chooseAgainMs],
    ]) {
      assert.ok(ms < measurements.unchangedClickMs - 1_500, `${name} waited: ${ms} ms, against ${measurements.unchangedClickMs} ms for a page that read as before`);
    }

    const result = {
      status: "passed", fixtureVersion: 1, browserVersion: context.browser()?.version() ?? "unknown",
      platform: process.platform, architecture: process.arch, nodeVersion: process.version,
      measurements,
      assertions: [
        "a details' summary is listed with whether it is open, and opening it reads its section; a tab out of the tab order is listed, and the tab shown says it is selected",
        "the radio button, box, radio link and list option shown chosen say so, and nothing else does: not a field's highlighted suggestion",
        "a control turned off is listed as disabled, and a click or a choice on it is refused at once, sending and asking nothing; taken seats make room for the free ones; a text area is never named by what it holds",
        "a frame is named by its site and a canvas as a picture with no text, where they show; a tracking frame and an icon are nothing; no word of a frame is read, and no control in one, of the page's own site too, is listed or counted; a frame's site makes no secret screen",
        "a long page's text says where it is cut and how far to scroll, and scrolling reads all of it within the reading's cap, past a skip link and a pinned header, on a plain-text page and in a long paragraph; a view out of reach says so; past 200 controls those scrolled past are left out and counted, past 600 matches too, and a closed list's options never crowd out a form",
        "password, card and code fields in a frame or a shadow root carry no value into the reading, a frame's fields are never listed, a key in a shadow root's read-only field or in a control's name the list leaves out still makes a secret screen, and a code in boxes of its own is masked",
        "a section marked open is no control, and a click whose middle lands on a form's button or a frame inside the control is refused, sending and asking nothing",
        "once a page settles the browser presses a cookie banner's own reject button itself, in a banner that speaks of cookies in its names or its text, never its accept or settings, and the step says so once the banner is gone; never a banner with no reject button, one in a frame, one on a page with a sign-in field or a frame holding card fields, or a dialog about a privacy policy that never speaks of cookies; a click a cookie notice or another cover keeps from its control is refused at once in words with no call log, while a plain link under a cookie notice opens its address in the same tab and says so (a link to the page itself is refused as a button is), a cover with no role, or one that says it has none, named by the first words a person sees on it, and a cover that goes within a moment is waited for",
        "a cookie notice is never Octo's step: its accept is never listed, as a button, a link, an Allow all or an Agree and close, and is counted among the controls left out, while its settings, a limited accept, a refusal no list knows and a button dressed up beside it stay listed, and the policy's refusal of an accept keeps its words; a click under a notice the browser could not decline never pauses on it: a plain link's address opens instead; a pause on a notice's settings or limited accept is a cookie notice's pause, while one on a refusal no list knows or a booking's button in small print that speaks of cookies is a step of the person's, the booking's button scrolled into view, each outlined and published with fixed labels and nothing pressed; a pause on an account's deletion dressed up as a notice is refused, outlining and publishing nothing, as is any pause in Octo's own tab; under a bar whose only button accepts the planner's own button works with no prompt",
        "a click whose result the page draws in place 1.5 s later reads it, after a hidden field, a tip on hover, a suggestion a field drops as it loses focus or the address changed first, and one whose result comes 5 s later reads it too; one whose page still reads as before 6 s on says so and that its reading is the page as it is now, leaving no snapshot to take; a click that changes the page, scrolls it, shows a section, menu, drawer or carousel item in place, turns a switch or toggle on, opens another page or loads the same one again, a type step, a choice and a choice of the option already chosen answer at once, while a link to a part of the page already in view is read with the words the page draws for it 1.2 s later; a search typed and not sent says nothing was searched yet, and another field that nothing was sent yet",
        "a type step types as a person does, ending on a key press, so a field whose list opens only as keys are pressed opens it, for a text ending on a letter a US keyboard has no key for too, and names its first options with their indices, for a combobox the site fills 1.2 s on, a list the text narrowed (whole) and a field that names no list, sending nothing; it names no other field's list, no list a field that opens none sits beside and no row turned off, waiting past a \"Searching…\" row for the stops; a field the page moves the focus from, opens a field of its own for or replaces keeps the whole text, in order; on a page with more controls than a reading holds, the options a field opened, and the plain rows of a list drawn under a field that names none (marked against autofill alone), are listed first and named with the indices a click then takes to choose one, a row that holds two controls by the one that draws the stop, while a calendar under a day field, one the field names, a list a ticked box names and a list of the page's own a search box filters are no list of its stops; a click on a plain link that keeps moving opens the link's address in the tab, once",
        "a field's own suggestion is chosen by a click that leaves the focus in the field, from a list that closes as the field loses it and from one that draws its stops anew under the pointer, found again by the reading's record and clicked once; a stop the list no longer shows is not clicked, and the step answers with the field's suggestions as they read now",
        "a ticket shop's controls with no name of their own are named by their row or card (\"+ beside “Adult”\"), listed and highlighted by that name, while the same rows in a frame are named by the frame's site and none is listed or counted",
        "a row's words only tell its controls apart where they are named: reading steps in rows that speak of deleting, booking or saving go without a prompt, in Octo's own tab too, a pause on a booking's icon button under a line about cookies is the person's step, a key beside an icon button names no control, whole or in part, a withheld page's controls are named without their rows' words in its reading and a step's words, and a stop drawn anew for a field that names no list of its own names no other list's options",
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
