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

// Real-browser proof of a sign-in that a task goes on past ("sign in, then
// star the repository"): the production controller script, composed as
// runtime-agent composes it, drives a real Chromium over CDP against a
// loopback fixture site. The turn's steps are played as the browser policy
// and the tool results say: the signed-out repository page's result names its
// "Sign in" link; the sign-in page's result names its fields and says to
// pause there; Octo cannot type into them; the pause highlights them and ends
// the turn; the person signs in on the page; the next turn (what "Let Octo
// continue" starts) carries on and stars the repository, asking before the
// form post. The sign-in page draws more buttons under its form after it has
// loaded (a passkey, as a code host's does), after the step that opened it
// read it: the pause on its fields still goes through in that turn. No model,
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
const resultFile = path.join(resultDirectory, "sign-in-result.json");
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

// Inert values the person types; they must never reach a tool's output or
// the action feed.
const PERSON_LOGIN = "fixture-person";
const PERSON_PASSWORD = ["INERT", "FIXTURE", "PASSWORD", "0123"].join("-");

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeProtectedJson(destination, value) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, destination);
}

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'${body.script ? "; script-src 'unsafe-inline'; connect-src 'self'" : ""}">
<title>${title}</title><style>body{font:16px system-ui;margin:0}header{display:flex;gap:16px;padding:12px 16px;background:#24292f}
header a{color:#fff}main{padding:16px}label{display:block;margin:12px 0}input{display:block;padding:6px;margin-top:4px}</style></head>
<body><header><a href="/">Example code host</a>${body.header ?? ""}</header><main><h1>${title}</h1>${body.main}</main>${body.script ? `<script>${body.script}</script>` : ""}</body></html>`;

// The sign-in page's script draws the rest of the page once its own request
// answers, as a code host's sign-in page adds its passkey button after it has
// loaded: under the form, after the fields.
const DRAWS_MORE_CONTROLS = `fetch("/login/more").then((answer) => answer.ok && answer.text()).then((drawn) => {
  if (!drawn) return;
  const more = document.createElement("p");
  for (const label of ["Sign in with a passkey", "Use a security key"]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    more.append(button);
  }
  document.querySelector("main").append(more);
});`;

// What a code host's signed-out pages carry besides the task: a product card
// whose heading names a secret, and a live feed of project names that look
// random. Neither shows a key, so the page reads as a page and names its Sign
// in link; read as a secret screen, it named none and the task stopped there.
const SIGNED_OUT_EXTRAS = '<section><h3>Secret scanning</h3><p>Catch leaked secrets before they ship.</p>' +
  '<a href="/features/secret-scanning">Explore Secret scanning</a></section>' +
  "<h2>Live activity</h2><ul><li>push to kestrel7/orbit-notes-2026</li>" +
  "<li>pull request on mapleworks9/route-planner-v2</li><li>star on dune88/shoreline-survey-kit</li></ul>";

// A code host: a repository page whose Star needs a sign-in, and its sign-in
// page. The person's session is a cookie the sign-in sets.
function fixtureSite(requests, heldControls) {
  let starred = false;
  return createServer((request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    requests.push(`${request.method} ${url.pathname}`);
    const signedIn = /(?:^|;\s*)session=signed-in(?:;|$)/u.test(request.headers.cookie || "");
    const send = (html) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(html);
    };
    const redirect = (location, headers = {}) => {
      response.writeHead(303, { location, ...headers });
      response.end();
    };
    if (request.method === "GET" && url.pathname === "/fixture/repository") {
      send(page("fixture/repository", signedIn
        ? {
          header: "<span>Signed in</span>",
          main: `<p>An inert repository.</p><form method="post" action="/fixture/repository/star"><button type="submit">${starred ? "Unstar" : "Star"}</button></form>`
            + `<p id="stars">${starred ? "Starred" : "Not starred"}</p>`,
        }
        : {
          header: '<a href="/login">Sign in</a>',
          main: `<p>An inert repository.</p><p>Sign in to star this repository.</p>${SIGNED_OUT_EXTRAS}`,
        }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/login") {
      send(page("Sign in to Example code host", {
        main: `<form method="post" action="/session">
<label>Username or email address<input type="text" name="login" autocomplete="username"></label>
<label>Password<input type="password" name="password" autocomplete="current-password"></label>
<button type="submit">Sign in</button></form>`,
        script: DRAWS_MORE_CONTROLS,
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/login/more") {
      // Held until the test lets the page draw the rest of itself.
      heldControls.push(response);
      return;
    }
    if (request.method === "POST" && url.pathname === "/session") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        const form = new URLSearchParams(body);
        if (form.get("login") === PERSON_LOGIN && form.get("password") === PERSON_PASSWORD) {
          redirect("/fixture/repository", { "set-cookie": "session=signed-in; Path=/; HttpOnly; SameSite=Lax" });
        } else {
          redirect("/login");
        }
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/fixture/repository/star" && signedIn) {
      request.resume();
      request.on("end", () => {
        starred = !starred;
        redirect("/fixture/repository");
      });
      return;
    }
    // A planner whose fields are marked against autofill only, as some sites
    // mark a planner's stops: a start that opens its list as a person types,
    // and a destination that says nothing of a list.
    if (request.method === "GET" && url.pathname === "/planner") {
      send(page("Journey planner", {
        main: `<form method="get" action="/planner/journey">
<label>Start <input name="start" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="start-stops" autocomplete="one-time-code"></label>
<ul id="start-stops" role="listbox"></ul>
<label>Destination <input name="destination" autocomplete="one-time-code"></label>
<button type="submit">Find a connection</button></form>`,
      }));
      return;
    }
    // A sign-in's second step, with no password field in its form: a numeric
    // "Code" field, one that holds 6 characters and one that takes digits,
    // each marked as a one-time code.
    if (request.method === "GET" && url.pathname === "/two-factor") {
      send(page("Two-factor authentication", {
        main: `<form method="post" action="/two-factor">
<label>Code <input type="text" name="code" inputmode="numeric" autocomplete="one-time-code"></label>
<label>Enter what we sent you <input type="text" name="sent" maxlength="6" autocomplete="one-time-code"></label>
<label>Enter the number from your app <input type="text" name="app" inputmode="numeric" autocomplete="one-time-code"></label>
<button type="submit">Verify</button></form>`,
      }));
      return;
    }
    // A code's step labelled in a language whose words for a code the rules
    // do not know, taking letters and holding any number of them: the only
    // field of its form a person sees (beside one placed off the page, which
    // forms keep for bots), under the site's search in a form of its own.
    if (request.method === "GET" && url.pathname === "/kod") {
      send(page("Weryfikacja dwuetapowa", {
        main: `<form method="get" action="/szukaj" role="search"><label>Szukaj <input type="search" name="q"></label></form>
<form method="post" action="/kod">
<label>Kod weryfikacyjny <input type="text" name="k" autocomplete="one-time-code"></label>
<input type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" style="position:absolute;left:-9999px">
<label><input type="checkbox" name="trust"> Zaufaj temu urządzeniu</label>
<button type="submit">Zweryfikuj</button></form>`,
      }));
      return;
    }
    // Code fields that name a list: one a list of hints (no list a person
    // picks from), and one that says it opens a list, takes digits and holds
    // 6 characters. A code's own signs count whatever its field names.
    if (request.method === "GET" && url.pathname === "/code-hints") {
      send(page("Check your phone", {
        main: `<form method="post" action="/code-hints">
<label>Enter what we sent you <input type="text" name="sent" aria-controls="sent-hints" autocomplete="one-time-code"></label>
<ul id="sent-hints"><li>We sent it to your phone.</li><li>It is valid for 10 minutes.</li></ul></form>
<form method="post" action="/code-hints">
<label>Enter the number from your app <input type="text" name="app" role="combobox" aria-controls="app-numbers" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></label>
<ul id="app-numbers" role="listbox"></ul>
<label>Device name <input type="text" name="device"></label>
<button type="submit">Verify</button></form>`,
      }));
      return;
    }
    if (request.method === "GET" && url.pathname === "/") {
      send(page("Example code host", { main: '<p><a href="/fixture/repository">fixture/repository</a></p>' }));
      return;
    }
    response.writeHead(404).end();
  });
}

export async function runSharedBrowserSignInFixture() {
  assert.ok(fs.existsSync(executablePath), "Locked Playwright Chromium is missing; run pnpm --filter @instafy/frontend exec playwright install chromium");
  fs.mkdirSync(resultDirectory, { recursive: true });
  fs.rmSync(resultFile, { force: true });
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instafy-sign-in-e2e-")));
  const profileDirectory = path.join(temporary, "profile");
  const approvalDirectory = path.join(temporary, "approvals");
  const markerPath = path.join(temporary, "agent-control.json");
  const actionsPath = path.join(temporary, "actions.jsonl");
  fs.mkdirSync(approvalDirectory, { mode: 0o700 });
  const environment = fixtureEnvironment(process.env, temporary);
  const children = new Set();
  const outputs = [];
  let server;
  let context;
  // The sign-in page's late requests, answered when the test says so.
  const heldControls = [];
  const drawMoreControls = () => {
    for (const response of heldControls.splice(0)) {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("drawn");
    }
  };
  try {
    const requests = [];
    server = fixtureSite(requests, heldControls);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    // A public name, as on a real code host.
    const origin = `http://code.test:${server.address().port}`;

    context = await chromium.launchPersistentContext(profileDirectory, {
      executablePath,
      headless: true,
      viewport: { width: 1000, height: 800 },
      env: environment,
      // No host but the loopback fixture resolves, so nothing leaves the machine.
      args: ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0", "--host-resolver-rules=MAP code.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
    });
    // The page the person chose for the run; the Playwright side of it is
    // the person's own hands in the visible browser.
    const personPage = context.pages()[0];
    const session = await context.newCDPSession(personPage);
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
    let authority;
    // A turn of its own: the run the card starts, then the one "Let Octo
    // continue" starts on the same page.
    function freshTurn() {
      assert.equal(children.size, 0, "A fresh turn starts after the previous tool exited");
      for (const name of ["request.json", "decision.json", "state.json", "withhold-next.json", "observed-fields.json"]) {
        fs.rmSync(path.join(approvalDirectory, name), { force: true });
      }
      authority = {
        version: 2, ownerId: randomUUID(), runId: randomUUID(),
        initiatorUserId: "00000000-0000-4000-8000-000000000006",
        browserPageId: runPageId, displayName: "Fixture assistant", expiresAtMs: Date.now() + 600_000,
      };
      writeProtectedJson(markerPath, authority);
    }

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
          INSTAFY_SHARED_BROWSER_APPROVAL_TIMEOUT_MS: "10000",
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
      }, 40_000);
      try {
        const code = await new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", resolve);
        });
        if (failure) throw failure;
        outputs.push(stdout, stderr);
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
    const control = (observed, label) => {
      const found = observed.interactiveElements.find((element) => element.label === label);
      assert.ok(found, `${label} is observed: ${observed.interactiveElements.map((element) => element.label)}`);
      return { index: found.index, snapshotId: observed.snapshotId };
    };
    const actions = () => fs.readFileSync(actionsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const outline = (selector) => personPage.locator(selector).evaluate((element) => getComputedStyle(element).outlineWidth);

    // Turn 1, the card's browser turn: "Sign in to the code host, then star
    // fixture/repository." The repository page asks for a sign-in; it has no
    // sign-in fields, so its result names the header's Sign in link instead.
    freshTurn();
    let observed = await ok("POST", "/v1/navigate", { url: `${origin}/fixture/repository` }, ["allow_routine"]);
    assert.equal(prompts.length, 1, "The site asked once");
    assert.equal(observed.secretScreen, false, "A product card that names a secret is not a secret screen");
    assert.match(observed.visibleText, /Sign in to star this repository\./u);
    assert.ok(observed.signIn, `The repository page names what opens the sign-in page: ${JSON.stringify(observed)}`);
    assert.equal(observed.signIn.fields, undefined, "A page with no sign-in fields names none");
    assert.deepEqual(observed.signIn.open, control(observed, "Sign in").index);
    assert.match(observed.signIn.next, /If the person asked to sign in, or a step they asked for needs it, click it, then pause on the sign-in page's fields with request_human_input/u);
    // The link the result names is free, so Octo reaches the sign-in page.
    observed = await ok("POST", "/v1/click", { index: observed.signIn.open, snapshotId: observed.snapshotId });
    assert.equal(prompts.length, 1, "Opening the sign-in page asked nothing");
    assert.equal(observed.url, `${origin}/login`);
    // The sign-in page's result names its fields and says to pause on them.
    assert.ok(observed.signIn, `The sign-in page names its fields: ${JSON.stringify(observed)}`);
    const fieldLabels = observed.signIn.fields.map((index) => observed.interactiveElements.find((element) => element.index === index)?.label);
    assert.deepEqual(fieldLabels, ["Username or email address", "Password"]);
    assert.match(observed.signIn.next, /call request_human_input with this snapshotId and these fields' indices, then end the turn/u);
    assert.match(observed.signIn.next, /choose Let Octo continue/u);
    assert.match(observed.signIn.next, /Otherwise never sign in: use what the page shows without it and go on with the task/u);
    // Octo still cannot type into them, before any prompt.
    const typed = await runTool("POST", "/v1/type", { ...control(observed, "Username or email address"), text: "someone" });
    assert.equal(typed.code, 1, "Typing into the sign-in fields is refused");
    assert.match(typed.stderr, /step_refused_sign_in|refuses to type authentication/u);
    assert.equal(await personPage.locator('input[name="login"]').inputValue(), "");
    // Now the page draws the rest of itself: buttons under its form, after the
    // step that opened it read it. That read no longer matches the page, yet the
    // fields it named are as they were.
    assert.ok(!observed.interactiveElements.some((element) => element.label === "Sign in with a passkey"), "The click read the page before it drew the rest");
    drawMoreControls();
    await personPage.getByRole("button", { name: "Sign in with a passkey" }).waitFor();
    // The pause on the named fields highlights them and ends the turn, with
    // the result the step that opened the page returned.
    const paused = await runTool("POST", "/v1/request-human-input", { indices: observed.signIn.fields, snapshotId: observed.snapshotId });
    assert.equal(paused.code, 1, "The pause ends the tool turn");
    assert.doesNotMatch(paused.stderr, /The page changed/u, "Buttons drawn under the form do not stop the pause");
    assert.match(paused.stderr, /\[human_input_required_non_retryable\]/u);
    const pauses = actions().filter((action) => action.type === "human_input");
    assert.equal(pauses.length, 1);
    assert.equal(pauses[0].humanInputRequest.runId, authority.runId);
    assert.equal(pauses[0].humanInputRequest.initiatorUserId, authority.initiatorUserId);
    assert.deepEqual(pauses[0].humanInputRequest.fields, [{ label: "Highlighted field 1" }, { label: "Highlighted field 2" }]);
    for (const selector of ['input[name="login"]', 'input[name="password"]']) {
      assert.equal(await outline(selector), "3px", `${selector} is highlighted for the person`);
    }
    assert.equal(prompts.length, 1, "The pause asked for no approval");
    assert.ok(!requests.includes("POST /session"), "Nothing was sent for the person");

    // The person signs in on the page.
    await personPage.locator('input[name="login"]').fill(PERSON_LOGIN);
    await personPage.locator('input[name="password"]').fill(PERSON_PASSWORD);
    await personPage.getByRole("button", { name: "Sign in", exact: true }).click();
    await personPage.waitForURL(`${origin}/fixture/repository`);
    assert.equal(requests.filter((entry) => entry === "POST /session").length, 1, "The person's own sign-in");

    // Turn 2, "Let Octo continue": a fresh run on the same page goes on with
    // the task. The run asks for the site again, and the form post asks once.
    freshTurn();
    observed = await ok("GET", "/v1/snapshot", null, ["allow_routine"]);
    assert.equal(observed.url, `${origin}/fixture/repository`);
    assert.equal(observed.signIn, undefined, "Signed in, nothing to pause on");
    observed = await ok("POST", "/v1/click", control(observed, "Star"), ["allow_once"]);
    const starPrompt = prompts.at(-1);
    assert.equal(starPrompt.kind, "action", "The form post asked before it was sent");
    assert.equal(starPrompt.operation, "click");
    assert.ok(requests.includes("POST /fixture/repository/star"), "The repository was starred");
    assert.match(observed.visibleText, /Starred/u);
    assert.equal(await personPage.locator("#stars").textContent(), "Starred");
    assert.equal(prompts.length, 3, "One site prompt per run and one for the form post");

    // A field a site marks against autofill alone (autocomplete="one-time-code")
    // is no secret: a planner's start that opens its list as a person types, and
    // its destination, are typed into, digits too into the start, and the page
    // names no sign-in. A code's field stays the person's: digits, or a word
    // of letters and digits, typed into the destination, a numeric "Code"
    // field, one that holds 6 characters and
    // one that takes digits are refused before any prompt, and the code page
    // names its fields as a sign-in's, for the pause.
    observed = await ok("POST", "/v1/navigate", { url: `${origin}/planner` });
    assert.equal(observed.signIn, undefined, `A planner's fields are no sign-in: ${JSON.stringify(observed.signIn)}`);
    for (const [label, text] of [["Start", "Central Station"], ["Start", "20500"], ["Destination", "Old Town"]]) {
      observed = await ok("POST", "/v1/type", { ...control(observed, label), text });
      assert.match(observed.done, new RegExp(`^Typed ${Array.from(text).length} characters into "${label}"`, "u"), observed.done);
    }
    assert.deepEqual(
      [await personPage.locator('input[name="start"]').inputValue(), await personPage.locator('input[name="destination"]').inputValue()],
      ["20500", "Old Town"],
    );
    for (const text of ["20500", "K7X2QP"]) {
      const code = await runTool("POST", "/v1/type", { ...control(observed, "Destination"), text });
      assert.equal(code.code, 1, `${text}: digits alone, or a word of letters and digits, in a field marked as a one-time code are a code`);
      assert.match(code.stderr, /refuses to type authentication, payment, or identity secrets/u);
    }
    assert.equal(await personPage.locator('input[name="destination"]').inputValue(), "Old Town");
    // A code's step keeps its pause however it is labelled or built: the
    // only field of its form, labelled in words the rules do not know and
    // taking letters; a field that names a list of hints; and one that says
    // it opens a list while it takes digits and holds 6 characters. Each is
    // named as a sign-in's and refuses letters and digits alike.
    for (const [pathname, codeFields, names] of [
      ["/two-factor", ["Code", "Enter what we sent you", "Enter the number from your app"], ["code", "sent", "app"]],
      ["/kod", ["Kod weryfikacyjny"], ["k"]],
      ["/code-hints", ["Enter what we sent you", "Enter the number from your app"], ["sent", "app"]],
    ]) {
      observed = await ok("POST", "/v1/navigate", { url: `${origin}${pathname}` });
      assert.ok(observed.signIn, `${pathname}: the code page names its fields: ${JSON.stringify(observed.interactiveElements)}`);
      assert.deepEqual(
        observed.signIn.fields.map((index) => observed.interactiveElements.find((element) => element.index === index)?.label),
        codeFields,
        pathname,
      );
      for (const label of codeFields) {
        for (const text of ["AB12CD", "482910"]) {
          const refused = await runTool("POST", "/v1/type", { ...control(observed, label), text });
          assert.equal(refused.code, 1, `${pathname} ${label}: typing into a code's field is refused`);
          assert.match(refused.stderr, /refuses to type authentication, payment, or identity secrets/u, `${pathname} ${label}`);
        }
      }
      for (const name of names) {
        assert.equal(await personPage.locator(`input[name="${name}"]`).inputValue(), "", `${pathname}: ${name} holds nothing`);
      }
    }
    assert.equal(prompts.length, 3, "The planner and the code pages asked nothing");
    assert.ok(
      !requests.some((entry) => entry.includes("/planner/journey") || /^POST \/(?:two-factor|kod|code-hints)$/u.test(entry)),
      "Nothing was sent",
    );

    // The person's values never reached a tool or the action feed.
    const feed = fs.readFileSync(actionsPath, "utf8");
    for (const value of [PERSON_LOGIN, PERSON_PASSWORD]) {
      assert.ok(!outputs.some((output) => output.includes(value)), `${value} reached a tool's output`);
      assert.ok(!feed.includes(value), `${value} reached the action feed`);
    }

    const result = {
      status: "passed",
      fixtureVersion: 5,
      checks: [
        "a signed-out page with no sign-in fields names its Sign in link, which opens the sign-in page without a prompt",
        "a product card whose heading names a secret, beside project names that look random, does not make that page a secret screen",
        "the sign-in page's result names its username and password fields and says to pause there with request_human_input",
        "typing into those fields is refused before any prompt",
        "the pause highlights exactly those fields, asks the run's person and ends the turn, with nothing sent",
        "buttons the sign-in page draws under its form after the step that opened it read it do not stop the pause on its fields in that turn",
        "after the person signs in, the next run on the same page goes on with the task: the form post asks once, then stars the repository",
        "a planner's fields a site marks against autofill alone are typed into, a start that opens its list as a person types with digits too, and the page names no sign-in; digits, or a word of letters and digits, typed into its destination, a numeric Code field, one that holds 6 characters and one that takes digits are refused before any prompt, and the code page names them as a sign-in's; so are the only field of a form labelled in words the rules do not know, a code field that names a list of hints and one that says it opens a list while it takes digits",
        "the person's values never reach a tool's output or the action feed",
      ],
      limitations: ["No model, Studio UI, origin or runtime shutdown guard; the turn's steps are played as the result says, and Studio's part is unit-tested."],
    };
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    for (const child of children) child.kill("SIGKILL");
    drawMoreControls();
    await context?.close().catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/shared-browser-sign-in-e2e.mjs (no filters or skips)");
  runSharedBrowserSignInFixture().then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    fs.mkdirSync(resultDirectory, { recursive: true });
    fs.writeFileSync(resultFile, `${JSON.stringify({ status: "failed", fixtureVersion: 5 })}\n`);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
