// What Octo reads about the themed starters: the bound-sites skill builds on the starter's check button and trust line
// instead of re-describing them, and the cheat sheet's worked example has one check per row and one primary button.
// Byte budgets are the prompt budgets.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SKILLS = new URL("../../runtime-agent/assets/instafy/.agents/skills/", import.meta.url);
const read = (rel) => fs.readFileSync(new URL(rel, SKILLS), "utf8");
const BOUND = read("instafy-bound-sites/SKILL.md");
const SHEET = read("instafy-bound-sites/references/cheatsheet.md");
const flat = (s) => s.replace(/\s+/g, " ");

test("the bound-sites skill scaffolds from the compare or ranked starter and keeps its check button and trust line", () => {
  assert.ok(Buffer.byteLength(BOUND) < 12000, `bound-sites skill is ${Buffer.byteLength(BOUND)} bytes`);
  const bound = flat(BOUND);
  assert.match(bound, /`instafy bind init <dir> --starter compare` \(options side by side\) or `--starter ranked`/);
  assert.match(bound, /`site\.checkAll`/);
  assert.match(bound, /`site\.trust`/);
  // one action per row, said quietly; a blocked store's reason once; values stay while a check runs
  assert.match(bound, /"Check price" only without "Check all prices"/);
  assert.match(bound, /the reason is said once, under the list/);
  assert.match(bound, /a value stays with "Checking…" while a check runs, rows keep their order/);
  // product and price rules live in the cheat sheet, so the skill routes on what it is, not on shopping words
  const sheet = flat(SHEET);
  assert.match(sheet, /A review site's price is its list price \(`"list": true`, its date in `asof`: "\$900 · list price on BabyGearLab ↗ · seen 5 Aug"\)/, "a review's list price says so on the row, with the one date word, 'seen'");
  assert.doesNotMatch(bound + sheet, /as of 5 Aug/);
  assert.doesNotMatch(bound + sheet, /instafy web|web cite|handoff\//, "no commands that do not exist");
  assert.match(bound, /Keep them; render new values with them\./);
  assert.match(bound, /the starter's "Open <store> ↗"/, "the store link names the store");
  assert.doesNotMatch(bound, /each cell has ↻/);
  assert.doesNotMatch(bound, /data\/items\.json/, "seed data lives in the starter's data.json");
});

test("the cheat sheet: one check per row, one primary button, starters own the follow recipe, restyle only on request", () => {
  const sheet = flat(SHEET);
  const example = sheet.slice(sheet.indexOf("## Worked example"));
  assert.match(example, /"Check all prices" as the page's one primary button and no button per row/);
  // the content rules the starters cannot enforce by themselves
  const content = sheet.slice(sheet.indexOf("## Writing the content"), sheet.indexOf("## Worked example"));
  assert.match(content, /Lede: the verdict, plus the biggest unknown/);
  assert.match(content, /add `asof` when the source dates the fact itself \(shown instead: "seen 5 Aug"; a price over 30 days old also says "may have changed"\)/);
  assert.match(content, /A store known to block checks gets `"readable": false` from the start/);
  assert.match(content, /otherwise rows keep the order in `items`/);
  assert.match(content, /"Our pick" only for your own pick, with the reason in `why`/);
  assert.match(content, /An estimate you made .* names its basis/);
  assert.match(content, /compare shows "Sort by" only with 5\+ options/);
  assert.match(content, /"Whose list is this\?"/);
  // review v4: the footer never repeats the page and speaks to the reader; a source's award is a badge, not "Details"
  assert.match(content, /The footer \("Still to confirm"\) holds only what the page\s+does not already say/);
  assert.match(content, /each as something the reader can do/);
  assert.match(content, /a source's pick or award says whose .* and is the row's\s+badge, not something behind "Details"/);
  assert.match(content, /Plain words over\s+brand names for features/);
  assert.doesNotMatch(example, /↻|🐙/);
  assert.match(example, /instafy bind init shoes --starter compare/);
  const follow = sheet.slice(sheet.indexOf("## Follow mode"), sheet.indexOf("## Commands"));
  assert.match(follow, /The starters already do this/);
  const restyle = sheet.slice(sheet.indexOf("## Restyle on request"), sheet.indexOf("## Worked example"));
  assert.match(restyle, /Only when the person asks\. Tokens first/);
  assert.match(restyle, /Edit `theme\.css` itself only for a whole new look/);
  assert.match(restyle, /Never a second parallel theme, a webfont, a gradient or pill buttons unless asked/);
  assert.match(restyle, /<html data-theme="dark" data-theme-fixed>/);
  assert.match(sheet, /instafy bind init <dir> \[--starter <name>\]/);
  assert.doesNotMatch(sheet, /data\/items\.json/);
});

test("the bound-sites skill teaches Ask Octo as the clicker's own message, never a binder on someone's login", () => {
  const bound = flat(BOUND);
  assert.match(bound, /the page hands it to Instafy, which sends it as the clicker's own chat message \(billed like typing it\)/);
  assert.match(bound, /someone who may not send messages there sees it disabled with the reason/);
  assert.match(bound, /The binder holds no Instafy login and never runs Ask Octo itself \(`agent executor: host`\)/);
  assert.doesNotMatch(bound, /their own login|own Instafy login|--space <space id>|INSTAFY_CONVERSATION_ID/);
  assert.match(flat(SHEET), /`--agent-executor` is the owner's own option, never yours/);
  assert.doesNotMatch(SHEET, /--space <id>|--agent-budget/);
});
