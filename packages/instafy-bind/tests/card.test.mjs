// A page someone asked for ends with its card. In a space, `init` names the command that serves the page and posts
// its card as its next step, before the check, and every check ends with it until a preview shows the site. A next
// step that named only `instafy-bind serve` (which posts no card) and a check that named none left a finished page
// nobody could open; so did a failing check chained before the card's command (`check && preview open`).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cardCommand, inSpace, previewShows } from "../src/preview-host.mjs";

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
  const env = { PATH: process.env.PATH, HOME: home, WORKSPACE_DIR: workspace, SPACE_ID: SPACE };
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
    done: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

const lastLine = (text) => text.trimEnd().split("\n").at(-1);

test("in a space, init's next step names the command that posts the page's card, before the check", () => {
  const s = space();
  try {
    const compare = s.run(["init", "sites/laptops", "--starter", "compare"]);
    assert.equal(compare.status, 0, compare.stderr);
    assert.equal(lastLine(compare.stdout),
      `next: put the real content in sites/laptops/data.json, post its card: (cd sites/laptops && ${OPEN}), then check it (\`instafy bind check sites/laptops --expect "<item>,<item>"\`)`);
    // a blank page's content is its app.js, whose words the check reads too
    assert.equal(lastLine(s.run(["init", "sites/visit", "--starter", "blank"]).stdout),
      `next: put the real content in sites/visit/app.js, post its card: (cd sites/visit && ${OPEN}), then check it (\`instafy bind check sites/visit --expect "<item>,<item>"\`)`);
    assert.equal(lastLine(s.run(["init", "sites/hello"]).stdout), `next: post its card: (cd sites/hello && ${OPEN})`);
    // run from inside its folder, the command needs no cd
    fs.mkdirSync(path.join(s.project, "sites", "plan"));
    assert.equal(lastLine(s.run(["init", ".", "--starter", "timeline"], { cwd: path.join(s.project, "sites", "plan") }).stdout),
      `next: put the real content in data.json, post its card: ${OPEN}, then check it (\`instafy bind check . --expect "<item>,<item>"\`)`);
    // outside a space the binder runs on its own: there is no card to post, and serving the site is the next step
    const away = s.run(["init", "sites/away", "--starter", "compare"], { environment: { PATH: process.env.PATH, HOME: s.env.HOME } });
    assert.equal(lastLine(away.stdout), "next: put the real content in sites/away/data.json, then instafy-bind serve sites/away");
  } finally {
    s.done();
  }
});

test("every check ends with the card's command until a preview shows the site: a failing one never holds the card back", () => {
  const s = space();
  try {
    s.run(["init", "sites/laptops", "--starter", "compare"]);
    const expect = ["--expect", "Option A, Option B, Option C"];
    const passed = s.run(["check", "sites/laptops", ...expect]);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.equal(lastLine(passed.stdout), `next: post its card: (cd sites/laptops && ${OPEN})`);
    const json = JSON.parse(s.run(["check", "sites/laptops", ...expect, "--json"]).stdout);
    assert.equal(json.ok, true);
    assert.equal(json.next, `post its card: (cd sites/laptops && ${OPEN})`);

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
    assert.match(out.stdout, /^UNREAD: app\.js draws the page's text in a way the check cannot read/m);
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
    const b = { PATH: process.env.PATH, HOME: s.env.HOME, WORKSPACE_PROJECT_DIR: folder, SPACE_ID: OTHER_SPACE };
    const run = (args) => s.run(args, { cwd: folder, environment: b });
    assert.equal(run(["init", "sites/laptops", "--starter", "compare"]).status, 0);
    const expect = ["--expect", "Option A, Option B, Option C"];
    // the other space's page of the same name has its card
    s.open("sites/laptops");
    const passed = run(["check", "sites/laptops", ...expect]);
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.equal(lastLine(passed.stdout), `next: post its card: (cd sites/laptops && ${OPEN})`);
    assert.equal(JSON.parse(run(["check", "sites/laptops", ...expect, "--json"]).stdout).next, `post its card: (cd sites/laptops && ${OPEN})`);
    // its own preview of the folder is its card
    s.record(s.preview("sites/laptops"), s.preview("sites/laptops", { projectId: OTHER_SPACE, localPort: 24088 }));
    const shown = run(["check", "sites/laptops", ...expect]);
    assert.equal(shown.status, 0, shown.stdout + shown.stderr);
    assert.doesNotMatch(shown.stdout, /preview open/);
  } finally {
    s.done();
  }
});

test("init names the card only while no preview shows the folder: a page shown before needs no new card", () => {
  const s = space();
  try {
    assert.match(lastLine(s.run(["init", "sites/laptops", "--starter", "compare"]).stdout), /, post its card: .*, then check it /);
    s.open("sites/laptops");
    const again = s.run(["init", "sites/laptops", "--starter", "compare"]);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /^kept {2}sites\/laptops\/data\.json/m);
    assert.equal(lastLine(again.stdout),
      'next: put the real content in sites/laptops/data.json, then check it (`instafy bind check sites/laptops --expect "<item>,<item>"`)');
    assert.doesNotMatch(again.stdout, /preview open|instafy-bind serve/);
    s.open("sites/visit");
    const blank = s.run(["init", "sites/visit", "--starter", "blank"]);
    assert.equal(lastLine(blank.stdout), 'next: put the real content in sites/visit/app.js, then check it (`instafy bind check sites/visit --expect "<item>,<item>"`)');
    s.open("sites/hello");
    const plain = s.run(["init", "sites/hello"]);
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, /^next:|preview open|instafy-bind serve/m);
    // a preview of another folder, or another space's of a folder with the same name, is not this page's card
    s.record(s.preview("sites/laptops"), s.preview("sites/plan", { projectId: OTHER_SPACE }));
    assert.match(lastLine(s.run(["init", "sites/plan", "--starter", "timeline"]).stdout), /, post its card: \(cd sites\/plan && .*\), then check it /);
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
    assert.match(lastLine(s.run(["check", "sites/laptops", ...expect]).stdout), /^next: post its card: /);
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
    assert.equal(lastLine(plan.stdout), `next: post its card: (cd sites/plan && ${OPEN})`);
    for (const [dir, expect, why] of [["sites", "Option A", "a folder of sites"], ["notes", "Option A", "a folder with no page"]]) {
      const out = check(dir, expect);
      assert.equal(out.status, 0, `${why}: ${out.stdout}${out.stderr}`);
      assert.doesNotMatch(out.stdout, /preview open/, why);
    }
    const away = check("sites/laptops", "Option A", { PATH: process.env.PATH, HOME: s.env.HOME });
    assert.equal(away.status, 0);
    assert.doesNotMatch(away.stdout, /preview open/, "outside a space");
    assert.equal(inSpace(os.tmpdir(), s.env), false);
    assert.equal(inSpace(s.project, { WORKSPACE_PROJECT_DIR: s.project }), true);
    // a folder the shell would split is quoted; run from inside the folder, the command needs no cd
    assert.equal(cardCommand("my sites/it's"), `(cd 'my sites/it'\\''s' && ${OPEN})`);
    assert.equal(cardCommand("."), OPEN);
  } finally {
    s.done();
  }
});
