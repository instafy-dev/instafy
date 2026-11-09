// A page someone asked for ends with its card. In a space, until a preview shows the site, a check that passes runs
// the command that serves the page and posts its card, and any other check ends with that command; `init`'s next step
// is that check, or, for a folder with nothing to check, the card's command. A next step that named only
// `instafy-bind serve` (which posts no card) and a check that named none left a finished page nobody could open; so
// did a failing check chained before the card's command (`check && preview open`), and a check that passed and named
// the command to a turn that never ran it. An init that named the card as well had it asked for twice.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cardArgs, cardCommand, inSpace, previewShows } from "../src/preview-host.mjs";
import { cardTitle } from "../src/check.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy-bind.mjs");
const SPACE = "33a2c783-570e-49dd-bd51-17d088e21387";
const OTHER_SPACE = "b0f6a1de-2c4e-4d8a-9a51-6f0e3c7d2b19";
const OPEN = "instafy preview open --title '<short title>' --serve-cmd 'instafy bind serve . --port {port} --preview' --start --json";

/** A space as a runtime has it: its workspace (WORKSPACE_DIR/<space>), where turns run, the space's id, and a home for
 *  the CLI's record of the previews it opened. */
function space() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bind-card-"));
  const workspace = path.join(base, "workspace");
  const project = path.join(workspace, SPACE);
  const home = path.join(base, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home);
  // `instafy` on the turn's PATH, for the card's command a passing check runs: it notes where it ran and with what,
  // writes the page in the space's record of its pages the first time its card is opened, and answers, as
  // `instafy preview open --json` does
  const bin = path.join(base, "bin");
  const cardLog = path.join(base, "cards.jsonl");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "card.mjs"), `import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(cardLog)}, JSON.stringify({ cwd: process.cwd(), args }) + "\\n");
const root = fs.realpathSync(process.env.WORKSPACE_PROJECT_DIR || path.join(process.env.WORKSPACE_DIR, process.env.SPACE_ID));
const file = path.join(root, ".instafy", "pages", "pages.json");
let pages = [];
try { pages = JSON.parse(fs.readFileSync(file, "utf8")).pages; } catch {}
const folder = path.relative(root, process.cwd()).split(path.sep).join("/");
if (!pages.some((page) => page.folder === folder)) pages.unshift({ folder, title: args[args.indexOf("--title") + 1], server: ["instafy", "bind"], openedAt: new Date().toISOString() });
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ version: 1, pages }));
process.stdout.write(JSON.stringify({ status: "live", port: 24087 }, null, 2) + "\\n");
`);
  fs.writeFileSync(path.join(bin, "instafy"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(bin, "card.mjs"))} "$@"\n`, { mode: 0o755 });
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: home, WORKSPACE_DIR: workspace, SPACE_ID: SPACE };
  const stateFile = path.join(home, ".instafy", "cli-preview-state.json");
  // what `instafy preview open --start`, run in a site's folder, records for its preview
  const preview = (siteDir, extra = {}) => ({
    previewId: "7b48c75d-3374-4b37-a261-9e9fdaf288a8", projectId: SPACE, title: "A page", localPort: 24087, path: "/",
    controllerUrl: "http://127.0.0.1:8788", pid: 4510, startedAt: "2026-11-02T13:14:07.000Z", hostSuffix: "preview.example.test",
    start: { argv: ["instafy", "bind", "serve", ".", "--port", "{port}", "--preview"], cwd: siteDir }, siteDir, ...extra,
  });
  const record = (...previews) => {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ version: 1, previews }, null, 2));
  };
  return {
    base,
    project,
    env,
    stateFile,
    run: (args, { cwd = project, environment = env } = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: environment, encoding: "utf8" }),
    preview,
    record,
    open: (siteDir, extra = {}) => record(preview(siteDir, extra)),
    // what `instafy preview open` writes in the space's record of its pages, kept with the space's files (`.instafy/`)
    pages: (...folders) => {
      const file = path.join(project, ".instafy", "pages", "pages.json");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 1, pages: folders.map(({ folder, chat }) => ({ folder, title: "A page", ...(chat ? { conversationId: chat } : {}), server: ["instafy", "bind"], openedAt: "2026-11-08T08:15:00.000Z" })) }, null, 2));
    },
    // the card commands a check ran: [{ cwd, args }]
    cards: () => (fs.existsSync(cardLog) ? fs.readFileSync(cardLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []),
    done: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

const lastLine = (text) => text.trimEnd().split("\n").at(-1);

// A turn ran init, whose next step said "post its card", and then `bind check … && preview open --title '<another
// title>'`: the check had posted the card already, the second open was refused, and the reply said the page "wasn't
// opened separately". A starter's next step is its check alone, which posts the card when it passes.
test("in a space, a starter's next step is its check, which posts the card; init asks for the card only with nothing to check", () => {
  const s = space();
  try {
    const compare = s.run(["init", "sites/laptops", "--starter", "compare"]);
    assert.equal(compare.status, 0, compare.stderr);
    assert.equal(lastLine(compare.stdout),
      'next: put the real content in sites/laptops/data.json, then check it (`instafy bind check sites/laptops --expect "<item>,<item>"`)');
    assert.doesNotMatch(compare.stdout, /post its card|preview open/);
    // a blank page's content is its app.js, whose words the check reads too
    assert.equal(lastLine(s.run(["init", "sites/visit", "--starter", "blank"]).stdout),
      'next: put the real content in sites/visit/app.js, then check it (`instafy bind check sites/visit --expect "<item>,<item>"`)');
    // a folder with no starter's content has nothing to check: its card's command is its next step
    assert.equal(lastLine(s.run(["init", "sites/hello"]).stdout), `next: post its card: (cd sites/hello && ${OPEN})`);
    // run from inside its folder, the check names it "."
    fs.mkdirSync(path.join(s.project, "sites", "plan"));
    assert.equal(lastLine(s.run(["init", ".", "--starter", "timeline"], { cwd: path.join(s.project, "sites", "plan") }).stdout),
      'next: put the real content in data.json, then check it (`instafy bind check . --expect "<item>,<item>"`)');
    // outside a space the binder runs on its own: there is no card to post, and serving the site is the next step
    const away = s.run(["init", "sites/away", "--starter", "compare"], { environment: { PATH: process.env.PATH, HOME: s.env.HOME } });
    assert.equal(lastLine(away.stdout), "next: put the real content in sites/away/data.json, then instafy-bind serve sites/away");
  } finally {
    s.done();
  }
});

test("until a preview shows the site, a check that passes posts its card itself, and a failing one never holds it back", () => {
  const s = space();
  try {
    s.run(["init", "sites/laptops", "--starter", "compare"]);
    const expect = ["--expect", "Option A, Option B, Option C"];
    // the check runs the card's command in the site's folder, titled from the page, and says what it answered
    const passed = s.run(["check", "sites/laptops", ...expect]);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    const titled = "(cd sites/laptops && instafy preview open --title 'Compare three options' --serve-cmd 'instafy bind serve . --port {port} --preview' --start --json)";
    assert.ok(passed.stdout.includes(`\nPosted its card: ran ${titled}, which answered:\n{\n  "status": "live",`), passed.stdout);
    assert.equal(lastLine(passed.stdout), "}");
    assert.doesNotMatch(passed.stdout, /^next:/m);
    assert.deepEqual(s.cards(), [{ cwd: fs.realpathSync(path.join(s.project, "sites", "laptops")), args: cardArgs("Compare three options") }]);
    // the card's command wrote the page in the space's record of its pages: no check posts it again, and while this
    // machine shows no preview of it, a check names the command, as before
    const json = JSON.parse(s.run(["check", "sites/laptops", ...expect, "--json"]).stdout);
    assert.equal(json.ok, true);
    assert.equal(json.card, undefined);
    assert.equal(json.next, `post its card: (cd sites/laptops && ${OPEN})`);
    assert.equal(lastLine(s.run(["check", "sites/laptops", ...expect]).stdout), `next: post its card: (cd sites/laptops && ${OPEN})`);
    assert.equal(s.cards().length, 1);

    // a check that fails says what to fix, and still ends with the card's command
    const failed = s.run(["check", "sites/laptops", "--expect", "Option D"]);
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /^MISSING: .*Option D\./m);
    assert.equal(lastLine(failed.stdout), `next: post its card: (cd sites/laptops && ${OPEN})`);
    assert.equal(JSON.parse(s.run(["check", "sites/laptops", "--expect", "Option D", "--json"]).stdout).next, `post its card: (cd sites/laptops && ${OPEN})`);
    // so does a check with nothing to check
    const nothing = s.run(["check", "sites/laptops"]);
    assert.equal(nothing.status, 2);
    assert.equal(lastLine(nothing.stdout), `next: post its card: (cd sites/laptops && ${OPEN})`);

    // `instafy preview open --start`, run in the site's folder, records the preview with that folder: the card is up
    s.open("sites/laptops");
    const shown = s.run(["check", "sites/laptops", ...expect]);
    assert.equal(shown.status, 0, shown.stdout + shown.stderr);
    assert.match(lastLine(shown.stdout), /^Read \d+ file\(s\)/);
    assert.doesNotMatch(shown.stdout, /preview open/);
    const shownJson = JSON.parse(s.run(["check", "sites/laptops", ...expect, "--json"]).stdout);
    assert.deepEqual([shownJson.ok, shownJson.next], [true, undefined]);

    // a preview of another folder is not this site's card
    s.open("sites/other");
    assert.equal(lastLine(s.run(["check", "sites/laptops", ...expect]).stdout), `next: post its card: (cd sites/laptops && ${OPEN})`);
    assert.equal(s.cards().length, 1);
  } finally {
    s.done();
  }
});

// A check that passes posts the card of a new page: one whose card was never opened, so the space's record of its pages
// (where `instafy preview open` writes each page with the chat its card went to) has no row for it. A page with a row
// had its card: another chat's page, a page whose site a person asked to stop, or any page once the space's machine
// started again, when this machine's home folder has no record of its preview. Posting there would send that page's
// card to whichever chat ran the check, or start a site someone stopped: the check names the card's command instead,
// as before.
test("a passing check posts no card for a page the space's record holds: another chat's, a stopped one, or after a restart", () => {
  const s = space();
  try {
    s.run(["init", "sites/laptops", "--starter", "compare"]);
    s.run(["init", "sites/tablets", "--starter", "compare"]);
    s.pages({ folder: "sites/laptops", chat: "6f0e3c7d-2b19-4d8a-9a51-b0f6a1de2c4e" }, { folder: "sites/old-plan" });
    const expect = ["--expect", "Option A, Option B, Option C"];
    const held = s.run(["check", "sites/laptops", ...expect]);
    assert.equal(held.status, 0, held.stdout + held.stderr);
    assert.equal(lastLine(held.stdout), `next: post its card: (cd sites/laptops && ${OPEN})`);
    assert.doesNotMatch(held.stdout, /^Posted its card/m);
    const json = JSON.parse(s.run(["check", "sites/laptops", ...expect, "--json"]).stdout);
    assert.equal(json.next, `post its card: (cd sites/laptops && ${OPEN})`);
    assert.equal(json.card, undefined);
    // run from inside the folder, or with the record's folder written "./sites/laptops/", it is the same page
    assert.doesNotMatch(s.run(["check", ".", ...expect], { cwd: path.join(s.project, "sites", "laptops") }).stdout, /^Posted its card/m);
    s.pages({ folder: "./sites/laptops/" });
    assert.doesNotMatch(s.run(["check", "sites/laptops", ...expect]).stdout, /^Posted its card/m);
    assert.deepEqual(s.cards(), []);
    // a page the record does not hold is new: it gets its card
    assert.match(s.run(["check", "sites/tablets", ...expect]).stdout, /^Posted its card: /m);
    assert.deepEqual(s.cards().map((card) => card.cwd), [fs.realpathSync(path.join(s.project, "sites", "tablets"))]);

    // a space whose workspace is its own folder (WORKSPACE_PROJECT_DIR) keeps the record there
    const folder = path.join(s.base, "folder-b");
    fs.mkdirSync(path.join(folder, ".instafy", "pages"), { recursive: true });
    const b = { PATH: s.env.PATH, HOME: s.env.HOME, WORKSPACE_PROJECT_DIR: folder, SPACE_ID: SPACE };
    assert.equal(s.run(["init", "sites/laptops", "--starter", "compare"], { cwd: folder, environment: b }).status, 0);
    fs.writeFileSync(path.join(folder, ".instafy", "pages", "pages.json"), JSON.stringify({ version: 1, pages: [{ folder: "sites/laptops", title: "A page", server: ["instafy", "bind"], openedAt: "2026-11-08T08:15:00.000Z" }] }));
    const own = s.run(["check", "sites/laptops", ...expect], { cwd: folder, environment: b });
    assert.equal(lastLine(own.stdout), `next: post its card: (cd sites/laptops && ${OPEN})`, own.stdout);
    assert.equal(s.cards().length, 1);
  } finally {
    s.done();
  }
});

/** The files under `dir`, every level. */
const filesIn = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesIn(path.join(dir, e.name)) : [path.join(dir, e.name)]));

// A new chat asked for a comparison "from what you already know" wrote its own folder, but its index.html loaded the
// first chat's page's files ("../framework-laptops/site.js"): it could not be served from its own folder, had no card
// and would change whenever the other page did, and the check passed it with "next: post its card", which the turn
// never ran. The check fails such a page and names the command that gives it its own files; then it posts the card.
test("a page that loads another page's files fails the check with the command that gives it its own, then gets its card", async () => {
  const s = space();
  let server = null;
  try {
    s.run(["init", "sites/framework-laptops", "--starter", "compare"]);
    s.open("sites/framework-laptops");
    const first = path.join(s.project, "sites", "framework-laptops");
    const before = filesIn(first).map((file) => [file, fs.readFileSync(file, "utf8")]);
    const page = path.join(s.project, "sites", "framework-13-vs-16");
    fs.mkdirSync(page);
    const laptop = (name, size) => ({ ref: `laptop:${name.toLowerCase().replace(/\W+/g, "-")}`, name, why: "Modular", facts: { size: { v: size } } });
    fs.writeFileSync(path.join(page, "data.json"), JSON.stringify({ title: "Framework Laptop 13 vs 16", lede: "The 13 is easier to carry.", from: "memory",
      columns: [{ key: "size", label: "Screen and format", type: "text" }], items: [laptop("Framework Laptop 13", "13.5-inch"), laptop("Framework Laptop 16", "16-inch")] }));
    const html = fs.readFileSync(path.join(first, "index.html"), "utf8");
    fs.writeFileSync(path.join(page, "index.html"), html.replace(/(href|src)="(theme\.css|site\.js|app\.js)"/g, '$1="../framework-laptops/$2"'));
    const expect = ["--expect", "Framework Laptop 13, Framework Laptop 16"];

    const failed = s.run(["check", "sites/framework-13-vs-16", ...expect]);
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /^OUTSIDE: index\.html loads \.\.\/framework-laptops\/theme\.css, \.\.\/framework-laptops\/site\.js and \.\.\/framework-laptops\/app\.js, from outside sites\/framework-13-vs-16\. /m);
    assert.match(failed.stdout, /^Give it its own files: `instafy bind init sites\/framework-13-vs-16 --starter compare` adds the starter's files it lacks and keeps yours\. Load each from the page's own folder \(theme\.css, not \.\.\/framework-laptops\/theme\.css\), then check again\.$/m);
    assert.doesNotMatch(failed.stdout, /post its card|preview open/, "a page that can't be served on its own gets no card yet");
    assert.equal(JSON.parse(s.run(["check", "sites/framework-13-vs-16", ...expect, "--json"]).stdout).init, "instafy bind init sites/framework-13-vs-16 --starter compare");
    assert.deepEqual(s.cards(), []);

    // the command it names, then the page loads its own files: the check passes and posts the card
    assert.equal(s.run(["init", "sites/framework-13-vs-16", "--starter", "compare"]).status, 0);
    fs.writeFileSync(path.join(page, "index.html"), fs.readFileSync(path.join(page, "index.html"), "utf8").replaceAll("../framework-laptops/", ""));
    const passed = s.run(["check", "sites/framework-13-vs-16", ...expect]);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.deepEqual(s.cards(), [{ cwd: fs.realpathSync(page), args: cardArgs("Framework Laptop 13 vs 16") }]);
    // once: its next check finds it in the space's record of its pages
    assert.doesNotMatch(s.run(["check", "sites/framework-13-vs-16", ...expect]).stdout, /^Posted its card/m);
    assert.equal(s.cards().length, 1);

    // nothing in its folder reaches above it, and it serves on its own, as its card serves it
    for (const file of filesIn(page)) assert.doesNotMatch(fs.readFileSync(file, "utf8"), /\.\.\//, file);
    server = spawn(process.execPath, [BIN, "serve", ".", "--port", "0", "--preview", "--json"], { cwd: page, env: s.env });
    const url = await new Promise((resolve, reject) => {
      let out = "";
      server.stdout.on("data", (chunk) => {
        out += chunk;
        const line = out.split("\n").find((l) => l.includes('"listening"'));
        if (line) resolve(JSON.parse(line).url);
      });
      server.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
      setTimeout(() => reject(new Error(`serve printed no listening event: ${out}`)), 10_000).unref();
    });
    for (const file of ["", "theme.css", "site.js", "app.js", "data.json"]) {
      const response = await fetch(new URL(file, `${url}/`));
      assert.equal(response.status, 200, `${file || "index.html"}: ${response.status}`);
    }
    // the first page is as it was, byte for byte
    assert.deepEqual(filesIn(first).map((file) => [file, fs.readFileSync(file, "utf8")]), before);
  } finally {
    if (server && server.exitCode === null) {
      const exited = new Promise((resolve) => server.on("exit", resolve));
      server.kill("SIGTERM");
      await exited;
    }
    s.done();
  }
});

// A turn wrote a comparison page by hand (`sites/framework-13-vs-16/index.html`) and posted no card: nobody could open
// the page, and its files' row named the folder, over two turns. The runtime now takes the card's step for a page a turn
// left without one, with `card`: the step a check that passes takes, the same command titled from the page, for a page
// whose card was never opened. Like the check, it posts none for a page the space's record of its pages holds (another
// chat's page, or one a person stopped) or a preview shows, and none outside a space.
test("card posts the card of a page that never had one, titled from the page, and none for a page that had one", () => {
  const s = space();
  try {
    const page = path.join(s.project, "sites", "framework-13-vs-16");
    fs.mkdirSync(page, { recursive: true });
    fs.writeFileSync(path.join(page, "index.html"), "<!doctype html>\n<title>Framework Laptop 13 vs 16</title>\n<h1>Which one to carry</h1>\n");
    const card = (dir, options) => s.run(["card", dir, "--json"], options);
    const posted = card("sites/framework-13-vs-16");
    assert.equal(posted.status, 0, posted.stdout + posted.stderr);
    const opened = "(cd sites/framework-13-vs-16 && instafy preview open --title 'Framework Laptop 13 vs 16' --serve-cmd 'instafy bind serve . --port {port} --preview' --start --json)";
    assert.deepEqual(JSON.parse(posted.stdout), { posted: true, title: "Framework Laptop 13 vs 16", command: opened, answer: { status: "live", port: 24087 } });
    // the command a check that passes runs: in the page's folder, with the title the check gives the page
    assert.equal(cardTitle(page), "Framework Laptop 13 vs 16");
    assert.deepEqual(s.cards(), [{ cwd: fs.realpathSync(page), args: cardArgs("Framework Laptop 13 vs 16") }]);
    // it wrote the page in the space's record of its pages: the card is posted once
    const again = card("sites/framework-13-vs-16");
    assert.equal(again.status, 2, again.stdout + again.stderr);
    assert.deepEqual(JSON.parse(again.stdout), { posted: false, reason: "its card was opened before" });
    // without --json it says the same in words, and the check's own lines when it posts
    assert.equal(s.run(["card", "sites/framework-13-vs-16"]).stdout, "No card to post: its card was opened before.\n");
    fs.mkdirSync(path.join(s.project, "sites", "plan"));
    fs.writeFileSync(path.join(s.project, "sites", "plan", "index.html"), "<title>Three days in Porto</title>\n");
    const words = s.run(["card", "sites/plan"]);
    assert.equal(words.status, 0, words.stdout + words.stderr);
    assert.equal(words.stdout.split("\n")[0], "Posted its card: ran (cd sites/plan && instafy preview open --title 'Three days in Porto' --serve-cmd 'instafy bind serve . --port {port} --preview' --start --json), which answered:");
    assert.equal(s.cards().length, 2);

    // another chat's page, and a page from before the record, are in the record: no card
    for (const folder of ["sites/laptops", "sites/old-plan"]) {
      fs.mkdirSync(path.join(s.project, folder), { recursive: true });
      fs.writeFileSync(path.join(s.project, folder, "index.html"), "<title>A page</title>\n");
    }
    s.pages({ folder: "sites/laptops", chat: "6f0e3c7d-2b19-4d8a-9a51-b0f6a1de2c4e" }, { folder: "sites/old-plan" });
    for (const folder of ["sites/laptops", "sites/old-plan"]) {
      const held = card(folder);
      assert.equal(held.status, 2, `${folder}: ${held.stdout}${held.stderr}`);
      assert.deepEqual(JSON.parse(held.stdout), { posted: false, reason: "its card was opened before" });
    }
    // a page a preview on this machine shows has its card
    fs.mkdirSync(path.join(s.project, "sites", "shown"));
    fs.writeFileSync(path.join(s.project, "sites", "shown", "index.html"), "<title>Shown</title>\n");
    s.open("sites/shown");
    assert.deepEqual(JSON.parse(card("sites/shown").stdout), { posted: false, reason: "a preview shows it" });
    // a folder of pages is no one page; outside a space nothing serves a card
    assert.deepEqual(JSON.parse(card("sites").stdout), { posted: false, reason: "the binder serves no one page from this folder" });
    fs.mkdirSync(path.join(s.project, "sites", "away"));
    fs.writeFileSync(path.join(s.project, "sites", "away", "index.html"), "<title>Away</title>\n");
    const away = card("sites/away", { environment: { PATH: s.env.PATH, HOME: s.env.HOME } });
    assert.equal(away.status, 2);
    assert.deepEqual(JSON.parse(away.stdout), { posted: false, reason: "the folder is not in a space" });
    assert.equal(s.cards().length, 2);

    // a card's command that fails says why, and posts nothing (exit 1)
    const failed = card("sites/away", { environment: { ...s.env, PATH: path.dirname(process.execPath) } });
    assert.equal(failed.status, 1, failed.stdout + failed.stderr);
    const said = JSON.parse(failed.stdout);
    assert.deepEqual([said.posted, said.title, said.error], [false, "Away", "the instafy command was not found"]);
    assert.equal(s.cards().length, 2);
    assert.match(s.run(["card"]).stderr, /usage: instafy-bind card <dir> \[--json\]/);
  } finally {
    s.done();
  }
});

// A page written by hand that loads another page's files ("../framework-laptops/site.js") can't be served from its own
// folder, so the check holds its card back and names the command that gives it its own files. The card step without
// the check holds it back too: its card would open a page whose files don't load, and the space's record would then
// hold it as carded. Once the page loads its own files, the card step posts its card.
test("card posts no card for a page that loads files from outside its folder, as the check posts none", () => {
  const s = space();
  try {
    s.run(["init", "sites/framework-laptops", "--starter", "compare"]);
    s.open("sites/framework-laptops");
    const page = path.join(s.project, "sites", "framework-13-vs-16");
    fs.mkdirSync(page);
    const html = fs.readFileSync(path.join(s.project, "sites", "framework-laptops", "index.html"), "utf8");
    fs.writeFileSync(path.join(page, "index.html"), html.replace(/(href|src)="(theme\.css|site\.js|app\.js)"/g, '$1="../framework-laptops/$2"'));
    assert.match(s.run(["check", "sites/framework-13-vs-16", "--expect", "Framework Laptop 13"]).stdout, /^OUTSIDE: /m);

    const held = s.run(["card", "sites/framework-13-vs-16", "--json"]);
    assert.equal(held.status, 2, held.stdout + held.stderr);
    assert.deepEqual(JSON.parse(held.stdout), { posted: false, reason: "it loads files from outside its folder" });
    assert.equal(s.run(["card", "sites/framework-13-vs-16"]).stdout, "No card to post: it loads files from outside its folder.\n");
    assert.deepEqual(s.cards(), []);

    // with its own files, its card is posted
    assert.equal(s.run(["init", "sites/framework-13-vs-16", "--starter", "compare"]).status, 0);
    fs.writeFileSync(path.join(page, "index.html"), fs.readFileSync(path.join(page, "index.html"), "utf8").replaceAll("../framework-laptops/", ""));
    const posted = s.run(["card", "sites/framework-13-vs-16", "--json"]);
    assert.equal(posted.status, 0, posted.stdout + posted.stderr);
    assert.equal(JSON.parse(posted.stdout).posted, true);
    assert.deepEqual(s.cards().map((card) => card.cwd), [fs.realpathSync(page)]);
  } finally {
    s.done();
  }
});

test("a card's command that fails leaves the check passed, and names the command to run again", () => {
  const s = space();
  try {
    s.run(["init", "sites/laptops", "--starter", "compare"]);
    // no `instafy` here: the card is not posted, and the check says why and what to run
    const environment = { ...s.env, PATH: path.dirname(process.execPath) };
    const out = s.run(["check", "sites/laptops", "--expect", "Option A, Option B, Option C"], { environment });
    assert.equal(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /^The card was not posted: the instafy command was not found\.$/m);
    assert.equal(lastLine(out.stdout), "next: post its card: (cd sites/laptops && instafy preview open --title 'Compare three options' --serve-cmd 'instafy bind serve . --port {port} --preview' --start --json)");
  } finally {
    s.done();
  }
});

test("a page whose text the check cannot read gets the card's command, never MISSING (exit 2)", () => {
  const s = space();
  try {
    s.run(["init", "sites/visit", "--starter", "blank"]);
    fs.writeFileSync(path.join(s.project, "sites", "visit", "app.js"), 'document.getElementById("list").innerHTML = "<h2>Opening hours</h2>";\n');
    const out = s.run(["check", "sites/visit", "--expect", "Opening hours"]);
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.doesNotMatch(out.stdout, /MISSING/);
    assert.match(out.stdout, /^UNREAD: app\.js may draw .*, so the check cannot tell whether the page shows: Opening hours\.$/m);
    assert.equal(lastLine(out.stdout), `next: post its card: (cd sites/visit && ${OPEN})`);
    const json = JSON.parse(s.run(["check", "sites/visit", "--expect", "Opening hours", "--json"]).stdout);
    assert.deepEqual([json.unknown, json.next], [["Opening hours"], `post its card: (cd sites/visit && ${OPEN})`]);
  } finally {
    s.done();
  }
});

test("a preview shows a folder when the CLI recorded it as the folder its site is served from", () => {
  const s = space();
  try {
    const site = path.join(s.project, "sites", "laptops");
    fs.mkdirSync(site, { recursive: true });
    const shows = (env = s.env) => previewShows(site, { env, file: s.stateFile });
    assert.equal(shows(), false, "no preview recorded");
    fs.mkdirSync(path.dirname(s.stateFile), { recursive: true });
    fs.writeFileSync(s.stateFile, "{ not json");
    assert.equal(shows(), false, "an unreadable record shows nothing");
    s.open("sites/laptops/");
    assert.equal(shows(), true, "the folder, written with a slash at the end");
    assert.equal(shows({ PATH: process.env.PATH, HOME: s.env.HOME }), false, "without the space's workspace the folder cannot be placed");
    s.open("sites/laptops", { projectId: "another-space" });
    assert.equal(shows(), false, "another space's folder of the same name");
    s.open("sites/laptops", { projectId: "../another-space" });
    assert.equal(shows(), false, "a space that is not one name");
    s.open(".");
    assert.equal(shows(), false, "a site served from the workspace itself");
    assert.equal(previewShows(s.project, { env: s.env, file: s.stateFile }), true);
    // without the space's id, each preview's folder is placed in its own space's workspace (WORKSPACE_DIR/<space>)
    const { SPACE_ID, ...unnamed } = s.env;
    s.open("sites/laptops");
    assert.equal(shows(unnamed), true);
    s.open("sites/laptops", { projectId: "another-space" });
    assert.equal(shows(unnamed), false);

    // a space with a folder of its own (WORKSPACE_PROJECT_DIR): only its own previews are placed in it
    const pinned = { ...s.env, WORKSPACE_PROJECT_DIR: s.project };
    s.open("sites/laptops", { projectId: OTHER_SPACE });
    assert.equal(shows(pinned), false, "another space's preview of a folder with the same name");
    s.record(s.preview("sites/laptops", { projectId: OTHER_SPACE }), s.preview("sites/laptops"));
    assert.equal(shows(pinned), true, "its own preview of the folder");
    assert.equal(shows({ ...unnamed, WORKSPACE_PROJECT_DIR: s.project }), false, "without its id, no preview is known to be its own");
    assert.equal(shows({ ...unnamed, WORKSPACE_PROJECT_DIR: s.project, CONTROLLER_SPACE_ID: SPACE }), true, "the id as the CLI also reads it");
  } finally {
    s.done();
  }
});

test("another space's preview is not this site's card, though their folders have the same name", () => {
  // One machine runs several spaces as one user (a desktop runtime, each space with a folder of its own): they share the
  // CLI's record of the previews it opened.
  const s = space();
  try {
    const folder = path.join(s.base, "folder-b");
    fs.mkdirSync(folder);
    const b = { PATH: s.env.PATH, HOME: s.env.HOME, WORKSPACE_PROJECT_DIR: folder, SPACE_ID: OTHER_SPACE };
    const run = (args) => s.run(args, { cwd: folder, environment: b });
    assert.equal(run(["init", "sites/laptops", "--starter", "compare"]).status, 0);
    const expect = ["--expect", "Option A, Option B, Option C"];
    // the other space's page of the same name has its card: this one gets its own
    s.open("sites/laptops");
    const passed = run(["check", "sites/laptops", ...expect]);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /^Posted its card: ran \(cd sites\/laptops && instafy preview open /m);
    assert.deepEqual(s.cards().map((card) => card.cwd), [fs.realpathSync(path.join(folder, "sites", "laptops"))]);
    // written in its own space's record of its pages, it is posted once
    assert.equal(JSON.parse(run(["check", "sites/laptops", ...expect, "--json"]).stdout).next, `post its card: (cd sites/laptops && ${OPEN})`);
    assert.equal(s.cards().length, 1);
    // its own preview of the folder is its card
    s.record(s.preview("sites/laptops"), s.preview("sites/laptops", { projectId: OTHER_SPACE, localPort: 24088 }));
    const shown = run(["check", "sites/laptops", ...expect]);
    assert.equal(shown.status, 0, shown.stdout + shown.stderr);
    assert.doesNotMatch(shown.stdout, /preview open/);
  } finally {
    s.done();
  }
});

test("init names the card only for a folder with nothing to check, and only while no preview shows it", () => {
  const s = space();
  try {
    assert.equal(lastLine(s.run(["init", "sites/hello"]).stdout), `next: post its card: (cd sites/hello && ${OPEN})`);
    s.open("sites/hello");
    const plain = s.run(["init", "sites/hello"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, /^next:|preview open|instafy-bind serve/m);
    // a preview of another folder, or another space's of a folder with the same name, is not this page's card
    s.record(s.preview("sites/hello"), s.preview("sites/plan", { projectId: OTHER_SPACE }));
    assert.equal(lastLine(s.run(["init", "sites/plan"]).stdout), `next: post its card: (cd sites/plan && ${OPEN})`);
    // a page shown before keeps its content and is checked again: no new card
    s.run(["init", "sites/laptops", "--starter", "compare"]);
    s.open("sites/laptops");
    const again = s.run(["init", "sites/laptops", "--starter", "compare"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^kept {2}sites\/laptops\/data\.json/m);
    assert.equal(lastLine(again.stdout),
      'next: put the real content in sites/laptops/data.json, then check it (`instafy bind check sites/laptops --expect "<item>,<item>"`)');
    assert.doesNotMatch(again.stdout, /preview open|instafy-bind serve/);
  } finally {
    s.done();
  }
});

test("in a space, serve --preview names its card from the folder it serves, so the preview records that folder", async () => {
  const s = space();
  const serve = (args, cwd = s.project) => {
    const child = spawn(process.execPath, [BIN, "serve", ...args, "--port", "0", "--preview", "--json"], { cwd, env: s.env });
    let out = "";
    const listening = new Promise((resolve, reject) => {
      child.stdout.on("data", (chunk) => {
        out += chunk;
        const line = out.split("\n").find((l) => l.includes('"listening"'));
        if (line) resolve(JSON.parse(line));
      });
      child.on("exit", (code) => reject(new Error(`serve exited ${code}: ${out}`)));
      setTimeout(() => reject(new Error(`serve printed no listening event: ${out}`)), 10_000).unref();
    });
    const stop = () => {
      child.kill("SIGTERM");
      return new Promise((resolve) => (child.exitCode !== null ? resolve() : child.on("exit", resolve)));
    };
    return { listening, stop };
  };
  try {
    s.run(["init", "sites/laptops", "--starter", "compare"]);
    s.run(["init", "gallery/a"]);
    s.run(["init", "gallery/b"]);
    for (const [args, cwd, dir, at] of [
      // a binder started by hand from the workspace: the card's command runs where the site is
      [["sites/laptops"], s.project, "(cd sites/laptops && ", ""],
      // the binder `instafy preview open --start` runs in the site's folder
      [["."], path.join(s.project, "sites", "laptops"), "", ""],
      // a folder of sites is served, and started again, from that folder
      [["gallery"], s.project, "(cd gallery && ", " --path /a/"],
    ]) {
      const binder = serve(args, cwd);
      try {
        const listening = await binder.listening;
        const port = new URL(listening.url).port;
        const title = at ? "Bound site starter" : "Compare three options";
        assert.equal(listening.sites[0].preview_command,
          `${dir}instafy preview open --port ${port}${at} --title "${title}" --serve-cmd 'instafy bind serve . --port ${port} --preview'${dir ? ")" : ""}`);
      } finally {
        await binder.stop();
      }
    }
    // Run there, with --serve-cmd, the CLI records the folder it runs in as the site's: the check then names no card.
    // The line without them, run from the workspace, recorded the folder the binder runs in: the workspace itself.
    const expect = ["--expect", "Option A, Option B, Option C"];
    s.open(".");
    assert.match(s.run(["check", "sites/laptops", ...expect]).stdout, /^Posted its card: /m);
    s.open("sites/laptops", { start: undefined });
    assert.doesNotMatch(s.run(["check", "sites/laptops", ...expect]).stdout, /preview open/);
  } finally {
    s.done();
  }
});

test("only a page in a space's workspace gets the card's command", () => {
  const s = space();
  try {
    s.run(["init", "sites/laptops", "--starter", "compare"]);
    s.run(["init", "sites/plan", "--starter", "timeline"]);
    fs.mkdirSync(path.join(s.project, "notes"));
    fs.writeFileSync(path.join(s.project, "notes", "data.json"), JSON.stringify({ items: [{ name: "Option A" }] }));
    const check = (dir, expect, environment = s.env) => s.run(["check", dir, "--expect", expect], { environment });
    // a page without a bound.json is served all the same
    const plan = check("sites/plan", "Set up the room");
    assert.equal(plan.status, 0, plan.stdout + plan.stderr);
    assert.deepEqual(s.cards(), [{ cwd: fs.realpathSync(path.join(s.project, "sites", "plan")), args: cardArgs("A three-day plan") }]);
    // not a folder of sites, nor a folder with no page
    for (const [dir, expect, why] of [["sites", "Option A", "a folder of sites"], ["notes", "Option A", "a folder with no page"]]) {
      const out = check(dir, expect);
      assert.equal(out.status, 0, `${why}: ${out.stdout}${out.stderr}`);
      assert.doesNotMatch(out.stdout, /preview open/, why);
    }
    const away = check("sites/laptops", "Option A", { PATH: s.env.PATH, HOME: s.env.HOME });
    assert.equal(away.status, 0);
    assert.doesNotMatch(away.stdout, /preview open/, "outside a space");
    assert.equal(s.cards().length, 1);
    assert.equal(inSpace(os.tmpdir(), s.env), false);
    assert.equal(inSpace(s.project, { WORKSPACE_PROJECT_DIR: s.project }), true);
    // a folder the shell would split is quoted; run from inside the folder, the command needs no cd
    assert.equal(cardCommand("my sites/it's"), `(cd 'my sites/it'\\''s' && ${OPEN})`);
    assert.equal(cardCommand("."), OPEN);
  } finally {
    s.done();
  }
});
