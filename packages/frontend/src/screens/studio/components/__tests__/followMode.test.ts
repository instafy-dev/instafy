import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FOLLOW_PAYLOAD_MAX_BYTES,
  INITIAL_FOLLOW_STATE,
  buildApplyTapMessage,
  buildApplyViewMessage,
  buildPresentMessage,
  createCoalescer,
  encodeFollowPayload,
  followLabels,
  interactStopsFollowing,
  payloadHasPosition,
  presentMenuLabel,
  readFollowTap,
  reduceFollow,
  type FollowAction,
  type FollowPresence,
  type FollowState,
} from "../previewHost/followMode";
import {
  applyFollowPresenceEvent,
  followEntry,
  handleFollowPresenceWindowEvent,
  requestFollow,
  resetFollowStoreForTests,
  takeFollowRequest,
} from "../previewHost/followStore";

const kim = { id: "u-kim", name: "Kim" };
const lena = { id: "u-lena", name: "Lena" };
const presence = (overrides: Partial<FollowPresence> = {}): FollowPresence =>
  ({ presentationId: "p-kim", presenter: kim, state: "live", followers: 1, ...overrides });

function run(actions: FollowAction[], start: FollowState = INITIAL_FOLLOW_STATE) {
  return actions.reduce(reduceFollow, start);
}

describe("follow state", () => {
  it("presents: the pane's own presentation, with Stop", () => {
    const state = run([{ type: "presented", presence: presence({ presentationId: "mine", presenter: lena, followers: 0 }), at: 1 }]);
    expect(state).toMatchObject({ role: "presenting", ownPresentationId: "mine" });
    expect(followLabels(state)).toMatchObject({ status: "Presenting", action: "stop-presenting", actionText: "Stop" });
    expect(run([{ type: "stop-presenting" }], state)).toMatchObject({ role: "none", ownPresentationId: null, presence: null });
  });

  it("offers Follow when someone else presents, follows, and an own gesture turns it into Follow again", () => {
    const offered = run([{ type: "presence", presence: presence(), at: 1 }]);
    expect(offered.role).toBe("none");
    expect(followLabels(offered)).toMatchObject({ status: "Kim is presenting", action: "follow", actionText: "Follow" });
    const following = run([{ type: "follow" }], offered);
    expect(followLabels(following)).toMatchObject({ status: "Following Kim", action: "stop-following", actionText: "Stop" });
    const stopped = run([{ type: "interact" }], following);
    expect(stopped.role).toBe("stopped-following");
    expect(followLabels(stopped)).toMatchObject({ status: "Kim is presenting", action: "follow-again", actionText: "Follow again" });
    // Follow again catches up.
    expect(run([{ type: "follow" }], stopped).role).toBe("following");
    // A gesture while not following changes nothing.
    expect(run([{ type: "interact" }], offered)).toBe(offered);
    // Nobody presents: nothing to follow.
    expect(run([{ type: "follow" }]).role).toBe("none");
  });

  it("carries followers along on a takeover, with a short note", () => {
    const following = run([{ type: "presence", presence: presence(), at: 1 }, { type: "follow" }]);
    const taken = run([{ type: "presence", presence: presence({ presentationId: "p-lena", presenter: lena }), at: 2 }], following);
    expect(taken.role).toBe("following");
    expect(followLabels(taken)).toMatchObject({ status: "Following Lena", note: "Lena took over from Kim" });
    expect(run([{ type: "clear-note" }], taken).note).toBeNull();
  });

  it("tells the presenter who took over, and offers Follow", () => {
    const presenting = run([{ type: "presented", presence: presence({ presentationId: "mine", presenter: kim }), at: 1 }]);
    const after = run([{ type: "presence", presence: presence({ presentationId: "p-lena", presenter: lena }), at: 2 }], presenting);
    expect(after).toMatchObject({ role: "none", ownPresentationId: null });
    expect(followLabels(after)).toMatchObject({ status: "Lena is presenting", action: "follow", note: "Lena is presenting now" });
    // A 409 from the relay says the same.
    const replaced = run([{ type: "replaced", by: lena, at: 3 }], presenting);
    expect(replaced).toMatchObject({ role: "none", note: { kind: "replaced", by: "Lena" } });
  });

  it("shows an away presenter, keeping the follower following", () => {
    const following = run([{ type: "presence", presence: presence(), at: 1 }, { type: "follow" }]);
    const away = run([{ type: "presence", presence: presence({ state: "away" }), at: 2 }], following);
    expect(away.role).toBe("following");
    expect(followLabels(away).status).toBe("Kim is away");
  });

  it("ends: 'Kim stopped presenting', and the pill goes back to normal", () => {
    const following = run([{ type: "presence", presence: presence(), at: 1 }, { type: "follow" }]);
    const ended = run([{ type: "ended", at: 2 }], following);
    expect(ended).toMatchObject({ role: "none", presence: null });
    expect(followLabels(ended)).toMatchObject({ status: null, action: null, note: "Kim stopped presenting" });
    const gone = run([{ type: "presence", presence: null, at: 2 }], following);
    expect(followLabels(gone).note).toBe("Kim stopped presenting");
  });

  it("says why it ended: a presenter whose screen went away is not someone who stopped", () => {
    const following = run([{ type: "presence", presence: presence(), at: 1 }, { type: "follow" }]);
    expect(followLabels(run([{ type: "ended", reason: "timeout", at: 2 }], following)).note).toBe("Kim went away, so following stopped");
    expect(followLabels(run([{ type: "presence", presence: null, reason: "timeout", at: 2 }], following)).note).toBe("Kim went away, so following stopped");
    expect(followLabels(run([{ type: "ended", reason: "closed", at: 2 }], following)).note).toBe("Kim's site was closed");
    expect(followLabels(run([{ type: "ended", reason: "stopped", at: 2 }], following)).note).toBe("Kim stopped presenting");
  });

  it("follows a presenter whose screen went away again when they present again within 5 minutes", () => {
    const following = run([{ type: "presence", presence: presence(), at: 1 }, { type: "follow" }]);
    const gone = run([{ type: "ended", reason: "timeout", at: 1_000 }], following);
    expect(gone.role).toBe("none");
    const back = run([{ type: "presence", presence: presence({ presentationId: "p-kim-2" }), at: 61_000 }], gone);
    expect(back.role).toBe("following");
    expect(followLabels(back)).toMatchObject({ status: "Following Kim", note: "Kim is back: following again" });
    // Too late, someone else, or a deliberate stop: Follow is offered, nothing more.
    expect(run([{ type: "presence", presence: presence({ presentationId: "p-kim-2" }), at: 400_000 }], gone).role).toBe("none");
    expect(run([{ type: "presence", presence: presence({ presentationId: "p-lena", presenter: lena }), at: 61_000 }], gone).role).toBe("none");
    const stopped = run([{ type: "ended", reason: "stopped", at: 1_000 }], following);
    expect(run([{ type: "presence", presence: presence({ presentationId: "p-kim-2" }), at: 61_000 }], stopped).role).toBe("none");
    // Someone who had stopped following is not pulled back in.
    const left = run([{ type: "interact" }, { type: "ended", reason: "timeout", at: 1_000 }], following);
    expect(run([{ type: "presence", presence: presence({ presentationId: "p-kim-2" }), at: 61_000 }], left).role).toBe("none");
  });

  it("tells a presenter who comes back that their presentation ended while they were away", () => {
    const presenting = run([{ type: "presented", presence: presence({ presentationId: "mine", presenter: kim }), at: 1 }]);
    const back = run([{ type: "own-ended", at: 200_000 }], presenting);
    expect(back).toMatchObject({ role: "none", presence: null, ownPresentationId: null });
    expect(followLabels(back).note).toBe("Your presentation ended while you were away");
    expect(presentMenuLabel({ supportsView: true, state: back }).text).toBe("Present to the space");
  });

  it("knows the person's own presentation from another screen: Stop it from here, never Follow or 'instead of' themselves", () => {
    const mine = run([{ type: "self", id: "u-kim" }, { type: "presence", presence: presence(), at: 1 }]);
    expect(followLabels(mine)).toMatchObject({ status: "You're presenting on another screen", action: "stop-elsewhere", actionText: "Stop" });
    expect(presentMenuLabel({ supportsView: true, state: mine })).toEqual({ text: "Present from here", disabled: false, detail: "You're presenting on another screen" });
    // It ending (stopped from here, or timed out) is no news to its own presenter.
    expect(run([{ type: "presence", presence: null, reason: "stopped", at: 2 }], mine).note).toBeNull();
    // Someone else's is unchanged.
    const theirs = run([{ type: "self", id: "u-lena" }, { type: "presence", presence: presence(), at: 1 }]);
    expect(followLabels(theirs).action).toBe("follow");
  });

  it("offers Present for sites that share views, Present instead of Kim with a presenter, and greys it out otherwise", () => {
    expect(presentMenuLabel({ supportsView: false, state: INITIAL_FOLLOW_STATE })).toEqual({ text: "Present: this site can't share its view yet", disabled: true, detail: null });
    expect(presentMenuLabel({ supportsView: true, state: INITIAL_FOLLOW_STATE })).toMatchObject({ text: "Present to the space", disabled: false });
    expect(presentMenuLabel({ supportsView: true, state: run([{ type: "presence", presence: presence(), at: 1 }]) }))
      .toMatchObject({ text: "Present instead of Kim", disabled: false });
  });
});

describe("the view coalescer", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("sends at most 10 a second, the latest winning, with a trailing send", () => {
    vi.useFakeTimers();
    const sent: Array<{ value: number; at: number }> = [];
    const coalescer = createCoalescer<number>({ send: value => sent.push({ value, at: Date.now() }) });
    const start = Date.now();
    for (let i = 0; i < 50; i += 1) {
      coalescer.push(i);
      vi.advanceTimersByTime(20);
    }
    vi.advanceTimersByTime(500);
    const times = sent.map(entry => entry.at - start);
    // Never two sends within 100 ms...
    for (let i = 1; i < times.length; i += 1) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(100);
    // ...so at most 10 in any second...
    expect(sent.filter(entry => entry.at - start < 1_000).length).toBeLessThanOrEqual(10);
    // ...the first goes at once, and the last value always arrives (trailing send).
    expect(sent[0]).toEqual({ value: 0, at: start });
    expect(sent.at(-1)!.value).toBe(49);
    // The latest wins: intermediate values are skipped, not queued.
    expect(sent.length).toBeLessThan(15);
  });

  it("waits out a 429 and then sends the latest", () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const coalescer = createCoalescer<number>({ send: value => sent.push(value) });
    coalescer.push(1);
    coalescer.pauseUntil(Date.now() + 1_000);
    vi.advanceTimersByTime(200);
    coalescer.push(2);
    coalescer.push(3);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([1]);
    vi.advanceTimersByTime(400);
    expect(sent).toEqual([1, 3]);
    coalescer.dispose();
    coalescer.push(4);
    vi.advanceTimersByTime(1_000);
    expect(sent).toEqual([1, 3]);
  });
});

describe("what Studio accepts from a site", () => {
  it("drops payloads over 2 KB and anything that is not plain JSON", () => {
    const fits = { s: "x".repeat(FOLLOW_PAYLOAD_MAX_BYTES - 8) };
    expect(JSON.stringify(fits).length).toBe(FOLLOW_PAYLOAD_MAX_BYTES);
    expect(encodeFollowPayload(fits)).toBe(JSON.stringify(fits));
    expect(encodeFollowPayload({ s: "x".repeat(FOLLOW_PAYLOAD_MAX_BYTES - 7) })).toBeNull();
    // Multi-byte characters count as bytes.
    expect(encodeFollowPayload({ s: "é".repeat(1100) })).toBeNull();
    for (const bad of [undefined, new Date(), new Map([["a", 1]]), { n: Number.NaN }, { f: () => 1 }, [new Uint8Array(2)], { d: new Date() }]) {
      expect(encodeFollowPayload(bad)).toBeNull();
    }
    expect(encodeFollowPayload({ cam: { b: [1, 2, 3, 4] }, tab: "plan", day: 3, sel: null })).toBe('{"cam":{"b":[1,2,3,4]},"tab":"plan","day":3,"sel":null}');
  });

  it("reads taps inside the frame only", () => {
    expect(readFollowTap({ x: 0.5, y: 0.25 })).toEqual({ x: 0.5, y: 0.25 });
    expect(readFollowTap({ x: 0.5, y: 0.25, at: { id: "stop-3" } })).toEqual({ x: 0.5, y: 0.25, at: { id: "stop-3" } });
    expect(readFollowTap({ x: 1.2, y: 0.25 })).toBeNull();
    expect(readFollowTap({ x: "0.5", y: 0.25 })).toBeNull();
    expect(readFollowTap({ x: 0.5, y: 0.2, at: new Date() })).toBeNull();
    expect(readFollowTap(null)).toBeNull();
  });

  it("ignores interact within 300 ms of an applied view", () => {
    expect(interactStopsFollowing(1_000, null)).toBe(true);
    expect(interactStopsFollowing(1_299, 1_000)).toBe(false);
    expect(interactStopsFollowing(1_300, 1_000)).toBe(true);
  });

  it("builds the v1 host messages", () => {
    expect(buildPresentMessage(true)).toEqual({ source: "instafy-host", v: 1, type: "present", on: true, share: { location: false } });
    expect(buildPresentMessage(false)).toEqual({ source: "instafy-host", v: 1, type: "present", on: false, share: { location: false } });
    expect(buildApplyViewMessage({ seq: 4, payload: { a: 1 }, from: { id: "u", name: "Kim", avatarUrl: "x" }, smooth: true }))
      .toEqual({ source: "instafy-host", v: 1, type: "apply-view", seq: 4, payload: { a: 1 }, from: { id: "u", name: "Kim" }, smooth: true });
    expect(buildApplyTapMessage({ x: 0.1, y: 0.2 }, kim)).toEqual({ source: "instafy-host", v: 1, type: "apply-tap", payload: { x: 0.1, y: 0.2 }, from: kim });
  });
});

describe("the location guard", () => {
  const here = { latitude: 25.03301, longitude: 121.56497 };

  it("drops a payload holding the person's position to 4 decimals, as numbers or inside text", () => {
    expect(payloadHasPosition({ cam: { lat: 25.0330, lng: 121.5650, z: 14 } }, [here])).toBe(true);
    expect(payloadHasPosition({ hash: "#t=9&cam=25.03301,121.56497,15&tab=plan" }, [here])).toBe(true);
    expect(payloadHasPosition([[121.56501, 25.03299]], [here])).toBe(true);
  });

  it("catches a position the site truncated rather than rounded (both within about 11 m)", () => {
    const fix = { latitude: 25.03349, longitude: 121.56549 };
    expect(payloadHasPosition({ q: "near=25.0335,121.5655" }, [fix])).toBe(true);
    expect(payloadHasPosition({ q: "near=25.0334,121.5654" }, [fix])).toBe(true);
    expect(payloadHasPosition({ q: "near=25.0337,121.5654" }, [fix])).toBe(false);
  });

  it("passes coordinates 0.001° away, a latitude alone, and anything when no position was given", () => {
    expect(payloadHasPosition({ cam: { lat: 25.0340, lng: 121.5660 } }, [here])).toBe(false);
    expect(payloadHasPosition({ cam: { lat: 25.0330, lng: 121.6 } }, [here])).toBe(false);
    expect(payloadHasPosition({ cam: { lat: 25.0330, lng: 121.5650 } }, [])).toBe(false);
  });
});

describe("the follow store", () => {
  afterEach(() => resetFollowStoreForTests());

  it("reads preview.follow events and ignores stale ones", () => {
    const live = { previewId: "pv", presentationId: "p-kim", state: "live", presenter: kim, followers: 2 };
    handleFollowPresenceWindowEvent(new CustomEvent("x", { detail: live }));
    expect(followEntry("pv").presence).toMatchObject({ presentationId: "p-kim", presenter: kim, followers: 2, state: "live" });
    // Lena took over: Kim's "ended", arriving after Lena's "live", changes nothing.
    applyFollowPresenceEvent("pv", "p-lena", presence({ presentationId: "p-lena", presenter: lena }));
    handleFollowPresenceWindowEvent(new CustomEvent("x", { detail: { ...live, state: "ended" } }));
    expect(followEntry("pv").presence?.presenter).toEqual(expect.objectContaining({ id: "u-lena" }));
    // And a late "live" for Kim's ended presentation cannot bring it back.
    handleFollowPresenceWindowEvent(new CustomEvent("x", { detail: live }));
    expect(followEntry("pv").presence?.presentationId).toBe("p-lena");
    handleFollowPresenceWindowEvent(new CustomEvent("x", { detail: { previewId: "pv", presentationId: "p-lena", state: "ended", presenter: lena, reason: "timeout" } }));
    expect(followEntry("pv").presence).toBeNull();
    expect(followEntry("pv").endReason).toBe("timeout");
  });

  it("hands a card's Follow to one pane, once", () => {
    requestFollow("pv");
    expect(takeFollowRequest("pv")).toBe(true);
    expect(takeFollowRequest("pv")).toBe(false);
  });
});
