// `instafy bind check` on a page whose text its files don't say. A page to share drew its text with
// document.createElement and its sources as HTML from a string: the check could not read one stop, put the page check in
// the middle of its answer and the card's command last, and the turn ran only the card's command, so nothing ever
// looked at the page. Now the check takes both steps: it posts the new page's card, has the page check
// (`instafy preview check --text`) load the page in headless Chromium where that card serves it, and answers with what
// the page drew. Runs the binder's own check against this checkout's built CLI (`pnpm build` first) and its Playwright;
// the cases skip where there is no Chromium.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { launchChromium, loadPlaywright, locateBrowserEngine } from "../src/site-check.js";
import { reservedPreviewPorts } from "../src/local-site.js";
import { createBinder } from "../../instafy-bind/src/server.mjs";
import { initSite } from "../../instafy-bind/src/init.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliBin = path.resolve(here, "..", "bin", "instafy.js");
const cliBundle = path.resolve(here, "..", "dist", "cli.js");
const bindBin = path.resolve(here, "..", "..", "instafy-bind", "bin", "instafy-bind.mjs");
const SPACE = "33a2c783-570e-49dd-bd51-17d088e21387";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "instafy-bind-drawn-")));
const binders: Array<{ close: () => Promise<void> }> = [];
afterAll(async () => {
  for (const b of binders) await b.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
});

const engine = locateBrowserEngine({ env: {}, globalRoots: [], workspace: true }).engine;
let browserOk = false;
if (engine && fs.existsSync(cliBundle)) {
  try {
    const { browser } = await launchChromium(loadPlaywright(engine));
    await browser.close();
    browserOk = true;
  } catch {
    browserOk = false;
  }
}

// A space as a runtime has it, with `instafy` on the turn's PATH: the card's command answers with the port its site is
// served on (the binder this test runs), and the page check is the real one.
const workspace = path.join(tmp, "workspace");
const project = path.join(workspace, SPACE);
const home = path.join(tmp, "home");
const bin = path.join(tmp, "bin");
const calls = path.join(tmp, "calls.jsonl");
fs.mkdirSync(project, { recursive: true });
fs.mkdirSync(home);
fs.mkdirSync(bin);
fs.writeFileSync(
  path.join(bin, "fake.mjs"),
  `import fs from "node:fs";
import { spawnSync } from "node:child_process";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args[0] === "preview" && args[1] === "open") {
  process.stdout.write(JSON.stringify({ status: "live", port: Number(process.env.FAKE_CARD_PORT) }, null, 2) + "\\n");
  process.exit(0);
}
const run = spawnSync(process.execPath, [${JSON.stringify(cliBin)}, ...args], { stdio: "inherit" });
process.exit(run.status ?? 1);
`,
);
fs.writeFileSync(path.join(bin, "instafy"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, "fake.mjs"))} "$@"\n`, { mode: 0o755 });

/** A blank page in the space, drawn by this app.js, served by the binder as its card serves it; resolves with its port. */
async function page(name: string, app: string): Promise<{ dir: string; port: number }> {
  const dir = path.join(project, "sites", name);
  initSite(dir, { starter: "blank" });
  fs.writeFileSync(path.join(dir, "app.js"), app);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    // 21000-29999: clear of Instafy's ports and Chromium's blocked ("unsafe") ports
    const port = 21000 + Math.floor(Math.random() * 9000);
    if (reservedPreviewPorts({}).has(port)) continue;
    const binder = createBinder({ root: dir, port, preview: true, env: {}, log: () => {} });
    try {
      await binder.listen();
    } catch {
      continue;
    }
    binders.push(binder);
    return { dir, port };
  }
  throw new Error("no free port");
}

/** `instafy bind check` in the space, run as a turn runs it (the test's binder keeps serving meanwhile). */
function check(dir: string, port: number, expectList: string): Promise<{ code: number | null; out: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [bindBin, "check", path.relative(project, dir), "--expect", expectList], {
      cwd: project,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        HOME: home,
        // the page check's screenshots land in this test's folder, which it removes
        TMPDIR: tmp,
        WORKSPACE_DIR: workspace,
        SPACE_ID: SPACE,
        INSTAFY_SHARED_BROWSER_PLAYWRIGHT_PATH: engine?.playwright ?? "",
        FAKE_CARD_PORT: String(port),
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
  });
}

const callsMade = (): string[][] => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

describe("bind check looks at the page as drawn for what its files don't say", () => {
  it.skipIf(!browserOk)(
    "a page drawn with createElement gets one answer from one check: what the page drew, its card, and its HTML lines named",
    async () => {
      fs.rmSync(calls, { force: true });
      const { dir, port } = await page(
        "share",
        `site.start({ data: null, render: function () {
  site.head({ title: "Bookshop hours and metro" });
  var to = "Aliados";
  var p = document.createElement("p");
  p.textContent = "Open daily 9:00 to 19:00. Metro from Sao Bento to " + to + ".";
  var list = document.getElementById("list");
  list.replaceChildren(p);
  var sources = document.createElement("p");
  sources.innerHTML = 'Sources: <a href="https://example.com/hours">example.com</a>';
  list.appendChild(sources);
} });
`,
      );
      const { code, out } = await check(dir, port, "Sao Bento, Aliados, Open daily");
      expect(out).not.toMatch(/UNREAD|MISSING|next:|Look at the page itself/);
      expect(out).toMatch(/^3 of 3 expected item\(s\) shown: Sao Bento, Aliados, Open daily\.$/m);
      expect(out).toMatch(new RegExp(`^Looked at the page as drawn on port ${port} \\(desktop and phone\\) for what its files don't say: Sao Bento, Aliados and Open daily\\. Screenshots: `, "m"));
      expect(out).toMatch(/^NOTE: app\.js:9 sets HTML from a string \(sources\.innerHTML = .*\): draw its text with site\.h, which sets text as text, and each fact with site\.trust\(fact\), which links its page\.$/m);
      expect(out).toMatch(/^Posted its card: ran \(cd sites\/share && instafy preview open --title 'Bookshop hours and metro' /m);
      expect(code, out).toBe(0);
      // the card, then one look at the page where it serves it
      expect(callsMade().map((args) => args.slice(0, 2).join(" "))).toEqual(["preview open", "preview check"]);
      expect(callsMade()[1]).toEqual(["preview", "check", "--port", String(port), "--json", "--text"]);
    },
    180_000,
  );

  it.skipIf(!browserOk)(
    "an item the page as drawn doesn't show fails the check, named",
    async () => {
      fs.rmSync(calls, { force: true });
      const { dir, port } = await page(
        "share-later",
        `site.start({ data: null, render: function () {
  site.head({ title: "Bookshop hours" });
  var later = "Trindade";
  var p = document.createElement("p");
  p.textContent = "Open daily 9:00 to 19:00.";
  document.getElementById("list").replaceChildren(p);
} });
`,
      );
      const { code, out } = await check(dir, port, "Open daily, Trindade");
      expect(out).toMatch(/^MISSING: the request named 1 item\(s\) the page as drawn does not show: Trindade\.$/m);
      expect(out).toMatch(/^1 of 2 expected item\(s\) shown: Open daily\.$/m);
      expect(out).not.toMatch(/sets HTML from a string/);
      expect(code, out).toBe(1);
    },
    180_000,
  );
});
