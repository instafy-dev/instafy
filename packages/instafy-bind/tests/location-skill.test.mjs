// What Octo reads about location in the bound-sites cheat sheet.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const SKILLS = new URL("../../runtime-agent/assets/instafy/.agents/skills/", import.meta.url);
const CHEATSHEET = fs.readFileSync(new URL("instafy-bound-sites/references/cheatsheet.md", SKILLS), "utf8");

test("the cheat sheet says Studio does not broker location yet, and every near-me page takes a typed place too", () => {
  const section = CHEATSHEET.slice(CHEATSHEET.indexOf('## Location ("near me")'), CHEATSHEET.indexOf("## Follow mode"));
  assert.match(section, /is not built yet/);
  assert.match(section, /Location is not available in this preview\s+yet\./);
  assert.match(section, /a typed place too/);
  assert.doesNotMatch(section, /navigator\.geolocation\.getCurrentPosition|postMessage/, "no raw snippet that trusts any parent");
});

test("the cheat sheet keeps a viewer's position out of shared records, and names the menu without its icon", () => {
  const section = CHEATSHEET.slice(CHEATSHEET.indexOf('## Location ("near me")'), CHEATSHEET.indexOf("## Commands"));
  assert.match(section, /never into records/);
  assert.match(section, /compute distances in the page/);
  assert.match(section, /"private_params"/);
  assert.match(section, /turn it on in Studio's menu for this preview/);
  assert.doesNotMatch(section, /▾/);
});

test("the cheat sheet's handler catches a failed fetch and still answers for the item", () => {
  const section = CHEATSHEET.slice(CHEATSHEET.indexOf("## Script handler"), CHEATSHEET.indexOf("## Records"));
  assert.match(section, /try \{ page = await kit\.fetch\(url\); \}/);
  assert.match(section, /every row ends with a value or a reason/);
});
