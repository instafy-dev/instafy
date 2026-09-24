import assert from "node:assert/strict";
import test from "node:test";
import {
  BrowserTabExplore,
  exploreViewport,
} from "../dist/browserTabExplore.js";
function fixture() {
  const views = new BrowserTabExplore();
  let valid = true;
  const pages = [];
  const create = (viewport) => {
    const page = {
      viewport,
      closed: false,
      inputs: [],
      frame: async () => new Uint8Array([255, 216, 255, 217]),
      resize: async (next) => {
        page.viewport = next;
      },
      input: async (input) => {
        page.inputs.push(input);
      },
      navigate: async () => {},
      close: () => {
        page.closed = true;
      },
    };
    pages.push(page);
    return page;
  };
  const open = () =>
    views.open(create, () => valid, { width: 390, height: 650, dpr: 2 });
  return {
    views,
    pages,
    open,
    invalidate: () => {
      valid = false;
    },
  };
}
test("Explore views keep separate input and metrics, bound capacity and expire without renewal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  const a = f.open(),
    b = f.open();
  await f.views.resize(a, { width: 700, height: 300, dpr: 2 });
  await f.views.input(a, { type: "text", text: "only a" });
  assert.equal(f.pages[1].viewport.width, 390);
  assert.deepEqual(f.pages[1].inputs, []);
  f.open();
  f.open();
  assert.throws(() => f.open(), /Close an Explore/);
  t.mock.timers.tick(4000);
  assert.ok(f.pages.every((p) => p.closed));
  assert.equal(f.views.renew(a), false);
  await assert.rejects(
    f.views.input(b, { type: "text", text: "late" }),
    /ended/,
  );
});
test("closing Explore fences queued input and in-flight pixels; stale source cannot renew", async () => {
  const f = fixture(),
    id = f.open();
  let finishFrame;
  f.pages[0].frame = () =>
    new Promise((r) => {
      finishFrame = r;
    });
  const frame = f.views.frame(id);
  let finishInput;
  f.pages[0].input = async () =>
    new Promise((r) => {
      finishInput = r;
    });
  const first = f.views.input(id, { type: "text", text: "first" });
  await Promise.resolve();
  const queued = f.views.input(id, { type: "text", text: "late" });
  const rejection = assert.rejects(queued, /ended/);
  f.views.close(id);
  finishInput();
  finishFrame(new Uint8Array([1]));
  await first;
  await rejection;
  await assert.rejects(frame, /ended/);
  const next = f.open();
  f.invalidate();
  assert.equal(f.views.renew(next), false);
  assert.equal(f.pages[1].closed, true);
});
test("Explore viewport and input remain bounded", async () => {
  assert.throws(() => exploreViewport({ width: 1, height: 600, dpr: 2 }));
  assert.throws(() =>
    exploreViewport({ width: 400, height: 600, dpr: Infinity }),
  );
  assert.ok(exploreViewport({ width: 1000, height: 1000, dpr: 3 }).dpr < 2);
  const f = fixture(),
    id = f.open();
  assert.throws(() =>
    f.views.input(id, { type: "eval", expression: "secret" }),
  );
  assert.throws(() => f.views.navigate(id, "https://other.test"));
  f.views.closeAll();
});
