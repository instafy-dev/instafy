// A page someone asked for ends with its card. In a space, `init` names the command that serves the page and posts
// its card as its next step, and a check that passes ends with it until a preview shows the site. A next step that
// named only `instafy-bind serve` (which posts no card) and a check that named none left a finished page nobody could
// open.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cardCommand, inSpace, previewShows } from "../src/preview-host.mjs";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "instafy-bind.mjs");
const SPACE = "33a2c783-570e-49dd-bd51-17d088e21387";
const OPEN = "instafy preview open --title '<short title>' --serve-cmd 'instafy bind serve . --port {port} --preview' --start --json";

/** A space as a runtime has it: its workspace (WORKSPACE_DIR/<space>), where turns run, and a home for the CLI's
 *  record of the previews it opened. */
function space() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "bind-card-"));
  const workspace = path.join(base, "workspace");
  const project = path.join(workspace, SPACE);
  const home = path.join(base, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, WORKSPACE_DIR: workspace };
  const stateFile = path.join(home, ".instafy", "cli-preview-state.json");
  return {
    project,
    env,
    stateFile,
    run: (args, { cwd = project, environment = env } = {}) => spawnSync(process.execPath, [BIN, ...args], { cwd, env: environment, encoding: "utf8" }),
    // what `instafy preview open --start`, run in a site's folder, records for its preview
    open(siteDir, extra = {}) {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const entry = {
        previewId: "7b48c75d-3374-4b37-a261-9e9fdaf288a8", projectId: SPACE, title: "A page", localPort: 24087, path: "/",
        controllerUrl: "http://127.0.0.1:8788", pid: 4510, startedAt: "2026-11-02T13:14:07.000Z", hostSuffix: "preview.example.test",
        start: { argv: ["instafy", "bind", "serve", ".", "--port", "{port}", "--preview"], cwd: siteDir }, siteDir, ...extra,
      };
      fs.writeFileSync(stateFile, JSON.stringify({ version: 1, previews: [entry] }, null, 2));
    },
    done: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

const lastLine = (text) => text.trimEnd().split("\n").at(-1);

test("in a space, init's next step ends with the command that posts the page's card", () => {
  const s = space();
  try {
    const compare = s.run(["init", "sites/laptops", "--starter", "compare"]);
    assert.equal(compare.status, 0, compare.stderr);
    assert.equal(lastLine(compare.stdout),
      `next: put the real content in sites/laptops/data.json, check it (\`instafy bind check sites/laptops --expect "<item>,<item>"\`), then post its card: (cd sites/laptops && ${OPEN})`);
    // a blank page's content is its app.js, which the check cannot read
    assert.equal(lastLine(s.run(["init", "sites/visit", "--starter", "blank"]).stdout),
      `next: put the real content in sites/visit/app.js, then post its card: (cd sites/visit && ${OPEN})`);
    assert.equal(lastLine(s.run(["init", "sites/hello"]).stdout), `next: post its card: (cd sites/hello && ${OPEN})`);
    // run from inside its folder, the command needs no cd
    fs.mkdirSync(path.join(s.project, "sites", "plan"));
    assert.equal(lastLine(s.run(["init", ".", "--starter", "timeline"], { cwd: path.join(s.project, "sites", "plan") }).stdout),
      `next: put the real content in data.json, check it (\`instafy bind check . --expect "<item>,<item>"\`), then post its card: ${OPEN}`);
    // outside a space the binder runs on its own: there is no card to post, and serving the site is the next step
    const away = s.run(["init", "sites/away", "--starter", "compare"], { environment: { PATH: process.env.PATH, HOME: s.env.HOME } });
    assert.equal(lastLine(away.stdout), "next: put the real content in sites/away/data.json, then instafy-bind serve sites/away");
  } finally {
    s.done();
  }
});

test("a check that passes ends with the card's command, until a preview shows the site", () => {
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

    // a check that fails says what to fix first
    const failed = s.run(["check", "sites/laptops", "--expect", "Option D"]);
    assert.equal(failed.status, 1);
    assert.doesNotMatch(failed.stdout, /preview open/);
    assert.equal(JSON.parse(s.run(["check", "sites/laptops", "--expect", "Option D", "--json"]).stdout).next, undefined);

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
    // with the workspace pinned to one folder (WORKSPACE_PROJECT_DIR), the CLI places every preview's folder in it
    s.open("sites/laptops", { projectId: "another-space" });
    assert.equal(shows({ ...s.env, WORKSPACE_PROJECT_DIR: s.project }), true);
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
