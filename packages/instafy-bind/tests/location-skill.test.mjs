// What Octo reads about location: the hub skill's rule (and its size budget) and the cheat sheet's plain-page
// snippet, run here against a fake Studio so the snippet Octo copies actually works.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const SKILLS = new URL("../../runtime-agent/assets/instafy/.agents/skills/", import.meta.url);
const CHEATSHEET = fs.readFileSync(new URL("instafy-bound-sites/references/cheatsheet.md", SKILLS), "utf8");
const STUDIO = "https://studio.example";

function snippet() {
  const section = CHEATSHEET.slice(CHEATSHEET.indexOf('## Location ("near me")'));
  const blocks = [...section.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1]);
  const raw = blocks.find((b) => b.includes("location-request"));
  assert.ok(raw, "the cheat sheet has a raw location-request snippet");
  assert.ok(raw.trim().split("\n").length <= 6, "the snippet stays at six lines");
  return raw;
}

function run({ embedded = true } = {}) {
  const listeners = [];
  const sent = [];
  const shown = [];
  const parent = { postMessage(msg, origin) { sent.push({ msg: JSON.parse(JSON.stringify(msg)), origin }); } };
  const context = {
    addEventListener: (type, fn) => { if (type === "message") listeners.push(fn); },
    navigator: { geolocation: { getCurrentPosition: (ok) => ok({ coords: { latitude: 1, longitude: 2 } }) } },
    showNear: (coords) => shown.push(["near", JSON.parse(JSON.stringify(coords))]),
    showOff: (code) => shown.push(["off", code]),
  };
  context.parent = embedded ? parent : context;
  vm.runInNewContext(`${snippet()}\nthis.locate = locate;`, context);
  const deliver = (data, origin = STUDIO, source = parent) => listeners.forEach((fn) => fn({ data, origin, source }));
  return { sent, shown, deliver, locate: () => context.locate() };
}

test("the plain-page snippet asks Studio at Studio's origin and shows the answer", () => {
  const page = run();
  page.deliver({ source: "instafy-host", v: 1, type: "layout", caps: { geolocation: true, location: "host" } });
  page.locate();
  assert.deepEqual(page.sent, [{ msg: { source: "instafy-site", v: 1, type: "location-request", payload: { id: "loc1" } }, origin: STUDIO }]);
  page.deliver({ source: "instafy-host", v: 1, type: "location", payload: { id: "loc1", coords: { latitude: 9, longitude: 8 } } }, "https://evil.example");
  page.deliver({ source: "instafy-host", v: 1, type: "location", payload: { id: "loc1", coords: { latitude: 5, longitude: 6 } } });
  page.deliver({ source: "instafy-host", v: 1, type: "location-error", payload: { id: "loc1", code: "stopped" } });
  assert.deepEqual(page.shown, [["near", { latitude: 5, longitude: 6 }], ["off", "stopped"]]);
});

test("the plain-page snippet asks the browser when no host offers location", () => {
  const page = run({ embedded: false });
  page.locate();
  assert.deepEqual(page.sent, []);
  assert.deepEqual(page.shown, [["near", { latitude: 1, longitude: 2 }]]);
  const older = run();
  older.deliver({ source: "instafy-host", v: 1, type: "layout", caps: { geolocation: true } });
  older.locate();
  assert.deepEqual(older.sent, []);
  assert.deepEqual(older.shown, [["near", { latitude: 1, longitude: 2 }]]);
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
