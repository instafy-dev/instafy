import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../../services/runtimeController";
import type { SharedBrowserHostSnapshot } from "../../../../services/runtimeController/browserSession";
import { runtimeEntryIsBooting } from "../../../../runtime/utils/runtimeEntry";
import { resolveBrowserRuntimeSelection } from "../browserSessionRuntimeEnsure";
import {
  SHARED_BROWSER_HOST_COPY,
  SHARED_BROWSER_HOST_MAX_POLL_MS,
  SHARED_BROWSER_HOST_POLL_MS,
  SHARED_BROWSER_HOST_REQUEST_TIMEOUT_MS,
  SPACE_MACHINE_COLD_START_TIMEOUT_MS,
  shouldStartSpaceMachineForBrowser,
  spaceMachineLaunchOnItsWay,
  sharedBrowserHostPollDelay,
  startSpaceMachineForBrowser,
  waitForSharedBrowserHostReady,
  type SharedBrowserHostClient,
} from "../sharedBrowserHostAttach";

function snapshot(state: SharedBrowserHostSnapshot["state"]): SharedBrowserHostSnapshot {
  return {
    version: 1, mode: "lazy", state, generation: null, failure: null, startedByYou: false,
    othersPresent: false, controlledByOther: false, agentRunActive: false, agentRunStartedByYou: false,
  };
}

class Refused extends Error {
  constructor(readonly code: string) { super(code); }
}
class Unavailable extends Error {
  constructor(readonly status: number) { super(String(status)); }
}
/** A 404 that is not the machine's own answer (see fetchSharedBrowserHost). */
class NotFound extends Error {
  readonly status = 404;
  constructor(readonly code: string | null) { super(`browser host not found (404)${code ? `: ${code}` : ""}`); this.name = "SharedBrowserHostNotFoundError"; }
}

/** A clock that only moves when the loop sleeps, or when a test moves it (`advance`). */
function fakeClock() {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: vi.fn(async (ms: number) => { sleeps.push(ms); nowMs += ms; return true; }),
    sleeps,
  };
}
function movableClock() {
  const clock = fakeClock();
  let movedMs = 0;
  return {
    now: () => clock.now() + movedMs,
    sleep: clock.sleep,
    sleeps: clock.sleeps,
    advance: (ms: number) => { movedMs += ms; },
  };
}

function client(answers: Array<SharedBrowserHostSnapshot | null | Error>, startAnswers: Array<SharedBrowserHostSnapshot | null | Error> = []) {
  const fetchHost = vi.fn(async () => {
    const next = answers.length > 1 ? answers.shift()! : answers[0]!;
    if (next instanceof Error) throw next;
    return next;
  });
  const startHost = vi.fn(async () => {
    const next = startAnswers.length > 1 ? startAnswers.shift()! : startAnswers[0] ?? snapshot("starting");
    if (next instanceof Error) throw next;
    return next;
  });
  const value: SharedBrowserHostClient = {
    fetchHost,
    startHost,
    isUnavailableError: (error) => error instanceof Unavailable,
    isHostRefusedError: (error) => error instanceof Refused,
  };
  return { value, fetchHost, startHost };
}

const base = { projectId: "project-1", runtimeId: "space", browserSessionId: "surface-1" };

describe("waitForSharedBrowserHostReady", () => {
  it("proceeds at once when the browser is ready, without starting it", async () => {
    const { value, startHost } = client([snapshot("ready")]);
    const clock = fakeClock();
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...clock }))
      .resolves.toEqual({ kind: "ready", snapshot: snapshot("ready") });
    expect(startHost).not.toHaveBeenCalled();
  });

  it("starts an idle browser for a person who may control it, then polls until ready", async () => {
    const { value, fetchHost, startHost } = client([snapshot("idle"), snapshot("starting"), snapshot("starting"), snapshot("ready")]);
    const clock = fakeClock();
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...clock }))
      .resolves.toMatchObject({ kind: "ready" });
    expect(startHost).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ projectId: "project-1", runtimeId: "space", browserSessionId: "surface-1" }));
    expect(fetchHost).toHaveBeenCalledTimes(4);
    // Quick at first after the start, then less often while it keeps starting.
    expect(clock.sleeps).toEqual([500, 500, 1_000]);
  });

  it.each(["idle", "failed"] as const)("asks a viewer to get a builder when the browser is %s", async (state) => {
    const { value, startHost } = client([snapshot(state)]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: false, client: value, ...fakeClock() }))
      .resolves.toEqual({ kind: "error", errorKind: "blocked", reason: SHARED_BROWSER_HOST_COPY.askBuilder });
    expect(startHost).not.toHaveBeenCalled();
  });

  it("says a poisoned browser needs the machine to restart, and never starts it", async () => {
    const { value, startHost } = client([snapshot("poisoned")]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...fakeClock() }))
      .resolves.toEqual({ kind: "error", errorKind: "blocked", reason: SHARED_BROWSER_HOST_COPY.poisoned });
    expect(startHost).not.toHaveBeenCalled();
  });

  it("polls through an unknown state, stopping, and gateway errors", async () => {
    const { value, startHost } = client([snapshot("unknown"), snapshot("stopping"), new Unavailable(502), snapshot("ready")]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...fakeClock() }))
      .resolves.toMatchObject({ kind: "ready" });
    expect(startHost).not.toHaveBeenCalled();
  });

  it("asks again a second after a start refused while the browser was stopping", async () => {
    const { value, startHost } = client(
      [snapshot("idle"), snapshot("idle"), snapshot("ready")],
      [new Refused("browser_host_stopping"), snapshot("starting")],
    );
    const clock = fakeClock();
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...clock }))
      .resolves.toMatchObject({ kind: "ready" });
    expect(startHost).toHaveBeenCalledTimes(2);
    expect(clock.sleeps[0]).toBe(1_000);
  });

  it("polls a start refused while the machine is stopping as opening, within the start budget", async () => {
    const opened = client(
      [snapshot("idle"), snapshot("idle"), snapshot("ready")],
      [new Refused("machine_stopping"), snapshot("starting")],
    );
    const clock = fakeClock();
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: opened.value, ...clock }))
      .resolves.toMatchObject({ kind: "ready" });
    expect(opened.startHost).toHaveBeenCalledTimes(2);
    expect(clock.sleeps[0]).toBe(1_000);
    // A machine that keeps stopping does not open: three starts, then it says so.
    const stopping = client([snapshot("idle")], [new Refused("machine_stopping")]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: stopping.value, ...fakeClock() }))
      .resolves.toMatchObject({ kind: "error", errorKind: "failed" });
    expect(stopping.startHost).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["browser_host_poisoned", { errorKind: "blocked", reason: SHARED_BROWSER_HOST_COPY.poisoned }],
    ["something_new", { errorKind: "failed", reason: "browser host start refused (something_new)" }],
  ] as const)("ends on a start refused with %s", async (code, outcome) => {
    const { value } = client([snapshot("idle")], [new Refused(code)]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...fakeClock() }))
      .resolves.toEqual({ kind: "error", ...outcome });
  });

  it.each([
    ["idle", "off"],
    ["failed", "failed"],
  ] as const)("never starts a %s browser for an automatic reconnect", async (state, errorKind) => {
    const { value, startHost } = client([snapshot(state)]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, mayStart: false, client: value, ...fakeClock() }))
      .resolves.toMatchObject({ kind: "error", errorKind });
    expect(startHost).not.toHaveBeenCalled();
    // A ready browser is still attached to, and a viewer still asks a builder.
    const ready = client([snapshot("ready")]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, mayStart: false, client: ready.value, ...fakeClock() }))
      .resolves.toMatchObject({ kind: "ready" });
    const viewer = client([snapshot(state)]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: false, mayStart: false, client: viewer.value, ...fakeClock() }))
      .resolves.toEqual({ kind: "error", errorKind: "blocked", reason: SHARED_BROWSER_HOST_COPY.askBuilder });
  });

  it("does not restart a browser that failed after this wait started it", async () => {
    const { value, startHost } = client([snapshot("failed"), snapshot("starting"), snapshot("failed")]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...fakeClock() }))
      .resolves.toMatchObject({ kind: "error", errorKind: "failed" });
    expect(startHost).toHaveBeenCalledTimes(1);
  });

  it("gives up after its cap with a retry hint", async () => {
    const { value } = client([snapshot("starting")]);
    const clock = fakeClock();
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...clock }))
      .resolves.toEqual({ kind: "error", errorKind: "failed", reason: "browser host wait timed out" });
    expect(clock.now()).toBe(120_000);
  });

  // Live test, Oct 27: each press of "Try again" on a browser that never
  // opened read its state every 500 ms for two minutes (240 requests).
  it("reads a browser that keeps starting less and less often, at most every 2 s", async () => {
    const { value, fetchHost } = client([snapshot("starting")]);
    const clock = fakeClock();
    await waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...clock });
    expect(clock.sleeps.slice(0, 6)).toEqual([500, 500, 1_000, 1_000, 2_000, 2_000]);
    expect(Math.max(...clock.sleeps)).toBe(SHARED_BROWSER_HOST_MAX_POLL_MS);
    // 63 reads in the two minutes, where a read every 500 ms made 240.
    expect(fetchHost).toHaveBeenCalledTimes(63);
    expect(sharedBrowserHostPollDelay(1)).toBe(SHARED_BROWSER_HOST_POLL_MS);
    expect(sharedBrowserHostPollDelay(40)).toBe(SHARED_BROWSER_HOST_MAX_POLL_MS);
  });

  it("reports no host (404) as off", async () => {
    const { value } = client([null]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...fakeClock() }))
      .resolves.toMatchObject({ kind: "error", errorKind: "off" });
  });

  it("polls through a 404 from the controller or a proxy, and logs it, until the browser answers", async () => {
    // Dogfood, Oct 24: one such 404 during a reconnect read as "not available"
    // while the browser kept running on the machine.
    const debug: { __INSTAFY_RUNTIME_DEBUG__: Array<{ message: string; data?: unknown }> } = { __INSTAFY_RUNTIME_DEBUG__: [] };
    vi.stubGlobal("window", debug);
    onTestFinished(() => { vi.unstubAllGlobals(); });
    const { value, fetchHost, startHost } = client([new NotFound(null), new NotFound("not_found"), snapshot("ready")]);
    const clock = fakeClock();
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...clock }))
      .resolves.toEqual({ kind: "ready", snapshot: snapshot("ready") });
    expect(fetchHost).toHaveBeenCalledTimes(3);
    expect(startHost).not.toHaveBeenCalled();
    expect(clock.sleeps).toEqual([500, 500]);
    expect(debug.__INSTAFY_RUNTIME_DEBUG__.filter((entry) => entry.message === "browser-session:host-404").map((entry) => entry.data))
      .toEqual([{ status: 404, code: null }, { status: 404, code: "not_found" }]);
  });

  it("keeps a 404 that never ends within its cap", async () => {
    const { value } = client([new NotFound(null)]);
    const clock = fakeClock();
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...clock }))
      .resolves.toEqual({ kind: "error", errorKind: "failed", reason: "browser host wait timed out" });
    expect(clock.now()).toBe(120_000);
  });

  it("ends at once, in plain words, when the space's browser policy is off", async () => {
    const { value, startHost } = client([new NotFound("browser_host_policy_off")]);
    const clock = fakeClock();
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...clock }))
      .resolves.toEqual({ kind: "error", errorKind: "blocked", reason: SHARED_BROWSER_HOST_COPY.policyOff });
    expect(clock.sleeps).toEqual([]);
    expect(startHost).not.toHaveBeenCalled();
    // The same answer to a start ends the wait too; another 404 there is polled.
    const started = client([snapshot("idle")], [new NotFound("browser_host_policy_off")]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: started.value, ...fakeClock() }))
      .resolves.toEqual({ kind: "error", errorKind: "blocked", reason: SHARED_BROWSER_HOST_COPY.policyOff });
    const polled = client([snapshot("idle"), snapshot("ready")], [new NotFound(null)]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: polled.value, ...fakeClock() }))
      .resolves.toMatchObject({ kind: "ready" });
  });

  it("stops quietly once cancelled", async () => {
    const controller = new AbortController();
    const { value } = client([snapshot("starting")]);
    const clock = fakeClock();
    clock.sleep.mockImplementation(async () => { controller.abort(); return false; });
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, signal: controller.signal, ...clock }))
      .resolves.toEqual({ kind: "cancelled" });
  });

  it("gives up a read that never answers after ten seconds and reads again", async () => {
    vi.useFakeTimers();
    try {
      const hanging = vi.fn<SharedBrowserHostClient["fetchHost"]>()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue(snapshot("ready"));
      const value: SharedBrowserHostClient = {
        fetchHost: hanging,
        startHost: vi.fn(async () => snapshot("starting")),
        isUnavailableError: () => false,
        isHostRefusedError: () => false,
      };
      let result: unknown;
      void waitForSharedBrowserHostReady({ ...base, canControl: true, client: value }).then((outcome) => { result = outcome; });
      await vi.advanceTimersByTimeAsync(SHARED_BROWSER_HOST_REQUEST_TIMEOUT_MS - 100);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(700);
      // The timed-out read was aborted and counted like a gateway error, not as a failure.
      expect(hanging.mock.calls[0]![0].signal?.aborted).toBe(true);
      expect(result).toEqual({ kind: "ready", snapshot: snapshot("ready") });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends at its bound even when every read and start hangs", async () => {
    vi.useFakeTimers();
    try {
      const value: SharedBrowserHostClient = {
        fetchHost: vi.fn(() => new Promise<never>(() => {})),
        startHost: vi.fn(() => new Promise<never>(() => {})),
        isUnavailableError: () => false,
        isHostRefusedError: () => false,
      };
      let result: unknown;
      void waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, timeoutMs: 30_000 })
        .then((outcome) => { result = outcome; });
      await vi.advanceTimersByTimeAsync(29_000);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(result).toEqual({ kind: "error", errorKind: "failed", reason: "browser host wait timed out" });
    } finally {
      vi.useRealTimers();
    }
  });
});

const origin = (runtimeId: string) => ({ originId: `origin-${runtimeId}`, endpoint: "https://origin.test", protocols: ["http"] });
function entry(overrides: Partial<ControllerRuntimeStatusEntry>): ControllerRuntimeStatusEntry {
  return {
    runtimeId: "space", status: "ready", provider: "instafy-cloud", idleTtlSeconds: 900, isLocal: false,
    isPreferred: true, health: "online", displayName: "hosted runtime", lastSeenAt: null, origin: origin("space"),
    ...overrides,
  };
}
const host = (overrides: Partial<ControllerRuntimeStatusEntry> = {}) =>
  entry({ sharedBrowserHost: { version: 1, mode: "lazy" }, ...overrides });

describe("shouldStartSpaceMachineForBrowser", () => {
  const decide = (entries: ControllerRuntimeStatusEntry[], exact: string | null, policy: "covered" | "off" | null = "covered") =>
    shouldStartSpaceMachineForBrowser({
      policy, exactRuntimeId: exact, entries, selection: resolveBrowserRuntimeSelection(entries, exact),
    });

  it("starts the space's machine for a press when nothing is open in a covered space", () => {
    expect(decide([], null)).toBe(true);
    expect(decide([entry({ status: "stopped", origin: null })], null)).toBe(true);
  });

  it("starts it for a pin to the space's own machine that stopped or is no longer listed", () => {
    expect(decide([entry({ status: "stopped" })], "space")).toBe(true);
    expect(decide([], "space")).toBe(true);
  });

  it("never starts it for a stopped separate browser session, a live pin, or outside a covered space", () => {
    expect(decide([entry({ runtimeId: "legacy", displayName: "Browser session", status: "stopped" })], "legacy")).toBe(false);
    expect(decide([host()], "space")).toBe(false);
    // An unattested live machine keeps today's path.
    expect(decide([entry({})], "space")).toBe(false);
    expect(decide([], null, "off")).toBe(false);
    expect(decide([], null, null)).toBe(false);
  });
});

describe("startSpaceMachineForBrowser", () => {
  function statusSequence(...answers: ControllerRuntimeStatusEntry[][]) {
    return vi.fn(async () => ({ runtimes: answers.length > 1 ? answers.shift()! : answers[0]!, preferredRuntimeId: null }));
  }

  it("ensures the machine, then attaches once the pinned machine is up with its browser", async () => {
    const ensureSpaceMachine = vi.fn(async () => true);
    const fetchStatus = statusSequence([entry({ status: "starting", origin: null })], [host()]);
    const clock = fakeClock();
    await expect(startSpaceMachineForBrowser({
      projectId: "project-1", pinnedRuntimeId: "space", conversationRuntimeId: null,
      ensureSpaceMachine, fetchStatus, ...clock,
    })).resolves.toEqual({ kind: "attach", candidate: { runtimeId: "space", originId: "origin-space", endpoint: "https://origin.test", mode: "lazy" } });
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([2_000]);
  });

  it("goes back to the legacy path at once when the machine comes up unattested", async () => {
    const fetchStatus = statusSequence([entry({})]);
    const clock = fakeClock();
    await expect(startSpaceMachineForBrowser({
      projectId: "project-1", pinnedRuntimeId: null, conversationRuntimeId: "space",
      ensureSpaceMachine: async () => true, fetchStatus, ...clock,
    })).resolves.toEqual({ kind: "legacy" });
    expect(clock.sleeps).toEqual([]);
  });

  it("follows the conversation's machine, then any live host, when the pin is gone", async () => {
    const other = host({ runtimeId: "other", origin: origin("other") });
    await expect(startSpaceMachineForBrowser({
      projectId: "project-1", pinnedRuntimeId: "gone", conversationRuntimeId: null,
      ensureSpaceMachine: async () => true, fetchStatus: statusSequence([other]), ...fakeClock(),
    })).resolves.toMatchObject({ kind: "attach", candidate: { runtimeId: "other" } });
  });

  it("never waits on the person's own Desktop machine, offline or online", async () => {
    const desktop = (status: string) => entry({
      runtimeId: "desktop", provider: "desktop", isLocal: true, status, health: status === "ready" ? "online" : "offline",
      displayName: "My Mac", origin: null,
    });
    const space = host({ runtimeId: "space-machine", origin: origin("space-machine") });
    for (const status of ["offline", "ready"]) {
      const clock = fakeClock();
      await expect(startSpaceMachineForBrowser({
        projectId: "project-1", pinnedRuntimeId: null, conversationRuntimeId: "desktop",
        ensureSpaceMachine: async () => true,
        fetchStatus: statusSequence([desktop(status), entry({ runtimeId: "space-machine", status: "starting", origin: null })], [desktop(status), space]),
        ...clock,
      })).resolves.toMatchObject({ kind: "attach", candidate: { runtimeId: "space-machine", mode: "lazy" } });
      expect(clock.sleeps).toEqual([2_000]);
    }
  });

  it("never takes a self-hosted or separate browser session machine for the space's own", async () => {
    const privateMachine = entry({ runtimeId: "private", isPrivateSelfHosted: true });
    const session = entry({ runtimeId: "session", displayName: "Browser session", origin: origin("session") });
    const space = host({ runtimeId: "space-machine", origin: origin("space-machine") });
    await expect(startSpaceMachineForBrowser({
      projectId: "project-1", pinnedRuntimeId: "session", conversationRuntimeId: "private",
      ensureSpaceMachine: async () => true, fetchStatus: statusSequence([privateMachine, session, space]), ...fakeClock(),
    })).resolves.toMatchObject({ kind: "attach", candidate: { runtimeId: "space-machine" } });
  });

  /** The space's machine after a press, while its launch comes up: a reused row, never seen on this launch. */
  const launching = (overrides: Partial<ControllerRuntimeStatusEntry> = {}) => entry({
    status: "requested", health: "offline", origin: null, lastSeenAt: null,
    createdAt: "2026-09-02T08:00:00.000Z", launchRequestedAt: "2026-10-24T17:48:31.000Z", ...overrides,
  });
  const stopped = () => entry({ status: "stopped", health: "offline", origin: null, lastSeenAt: null });
  const coldStart = (overrides: Partial<Parameters<typeof startSpaceMachineForBrowser>[0]>) => startSpaceMachineForBrowser({
    projectId: "project-1", pinnedRuntimeId: null, conversationRuntimeId: "space",
    ensureSpaceMachine: async () => true, fetchStatus: statusSequence([]), ...overrides,
  });

  it("waits out a slow first launch on a new node and attaches when it comes up (dogfood, Oct 24)", async () => {
    // The press at t=0: the ensure answered after 53 s, and the machine came
    // up at 4 min 49 s. The wait used to give up at three minutes.
    const clock = movableClock();
    const fetchStatus = vi.fn(async () => ({
      runtimes: [clock.now() >= 289_000 ? host() : launching()], preferredRuntimeId: null,
    }));
    const onSlow = vi.fn();
    await expect(coldStart({
      ensureSpaceMachine: async () => { clock.advance(53_000); return true; },
      fetchStatus, onSlow, now: clock.now, sleep: clock.sleep,
    })).resolves.toMatchObject({ kind: "attach", candidate: { runtimeId: "space", mode: "lazy" } });
    expect(clock.now()).toBeGreaterThanOrEqual(289_000);
    expect(clock.now()).toBeLessThan(300_000);
    expect(onSlow).toHaveBeenCalledTimes(1);
    // runtimeEntryIsBooting reads the reused row's old createdAt as a stale boot.
    expect(runtimeEntryIsBooting(launching(), { nowMs: Date.parse("2026-10-24T17:49:20.000Z") })).toBe(false);
    expect(spaceMachineLaunchOnItsWay(launching())).toBe(true);
  });

  it("reads every 2 s for the first minute after the press, then every 10 s, and says it is slow once", async () => {
    const clock = fakeClock();
    const onSlow = vi.fn();
    const slowAtMs: number[] = [];
    onSlow.mockImplementation(() => { slowAtMs.push(clock.now()); });
    const fetchStatus = vi.fn(async () => ({
      runtimes: [clock.now() >= 100_000 ? host() : launching()], preferredRuntimeId: null,
    }));
    await expect(coldStart({ fetchStatus, onSlow, ...clock })).resolves.toMatchObject({ kind: "attach" });
    expect(clock.sleeps).toEqual([...Array<number>(30).fill(2_000), ...Array<number>(4).fill(10_000)]);
    expect(slowAtMs).toEqual([60_000]);
    expect(fetchStatus).toHaveBeenCalledTimes(35);
  });

  it("keeps waiting when the ensure did not answer while the launch is on its way", async () => {
    // Both 45 s attempts timed out behind the controller's launch lock.
    const clock = movableClock();
    const ensureSpaceMachine = vi.fn(async () => { clock.advance(90_000); return false; });
    const fetchStatus = statusSequence([launching()], [launching()], [host()]);
    await expect(coldStart({ ensureSpaceMachine, fetchStatus, now: clock.now, sleep: clock.sleep }))
      .resolves.toMatchObject({ kind: "attach", candidate: { runtimeId: "space" } });
    expect(ensureSpaceMachine).toHaveBeenCalledTimes(1);
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["the machine is stopped", () => statusSequence([stopped()])],
    ["no machine is listed", () => statusSequence([])],
    ["the status read fails", () => vi.fn(async () => null)],
  ])("fails at once when the ensure did not answer and %s", async (_name, makeStatus) => {
    // A credits or capacity refusal leaves no launch.
    const clock = fakeClock();
    const fetchStatus = makeStatus();
    await expect(coldStart({ ensureSpaceMachine: async () => false, fetchStatus, ...clock }))
      .resolves.toEqual({ kind: "error", errorKind: "machine", reason: "space machine ensure failed" });
    expect(fetchStatus).toHaveBeenCalledTimes(1);
    expect(clock.sleeps).toEqual([]);
  });

  it.each([
    ["stopped without a launch", stopped()],
    ["stopped by a person", launching({ stopReason: "user_stop", stopRequestedAt: "2026-10-24T17:50:00.000Z" })],
    ["gone", null],
  ])("ends the wait on two reads in a row that show it %s", async (_name, ended) => {
    const clock = fakeClock();
    const endedRead = ended ? [ended] : [];
    // One such read, as while the controller replaces a stalled launch, is ridden out.
    const fetchStatus = statusSequence([launching()], endedRead, [launching({ launchRequestedAt: "2026-10-24T17:53:40.000Z" })], endedRead, endedRead, [host()]);
    await expect(coldStart({ fetchStatus, ...clock }))
      .resolves.toEqual({ kind: "error", errorKind: "machine", reason: "space machine start ended" });
    expect(fetchStatus).toHaveBeenCalledTimes(5);
    expect(clock.now()).toBe(8_000);
  });

  it("counts a status read that fails as neither on its way nor ended", async () => {
    const clock = fakeClock();
    const answers: Array<ControllerRuntimeStatusEntry[] | null> = [[launching()], [stopped()], null, null, [launching()], [host()]];
    const fetchStatus = vi.fn(async () => {
      const next = answers.shift()!;
      return next ? { runtimes: next, preferredRuntimeId: null } : null;
    });
    await expect(coldStart({ fetchStatus, ...clock })).resolves.toMatchObject({ kind: "attach" });
  });

  it("keeps waiting while the machine has registered but lists no origin yet", async () => {
    // It can take work but has nothing to attach to yet: that is not a start
    // that ended, also over several reads at the 10 s cadence.
    const clock = fakeClock();
    const registered = host({ origin: null });
    const fetchStatus = vi.fn(async () => ({
      runtimes: [clock.now() < 60_000 ? launching() : clock.now() < 90_000 ? registered : host()],
      preferredRuntimeId: null,
    }));
    await expect(coldStart({ fetchStatus, ...clock }))
      .resolves.toMatchObject({ kind: "attach", candidate: { runtimeId: "space", mode: "lazy" } });
    expect(clock.now()).toBe(90_000);
    expect(clock.sleeps).toEqual([...Array<number>(30).fill(2_000), 10_000, 10_000, 10_000]);
  });

  it("ends the wait like any start once a launch was seen after an ensure that did not answer", async () => {
    const clock = fakeClock();
    const fetchStatus = statusSequence([launching()], [stopped()], [stopped()], [host()]);
    await expect(coldStart({ ensureSpaceMachine: async () => false, fetchStatus, ...clock }))
      .resolves.toEqual({ kind: "error", errorKind: "machine", reason: "space machine start ended" });
    expect(fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("says it is slow a minute after the press while the ensure has not answered yet", async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const pressedAtMs = Date.now();
    const slowAtMs: number[] = [];
    // Both 45 s attempts time out behind the controller's launch lock.
    const ensureSpaceMachine = () => new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 90_000); });
    const result = coldStart({
      ensureSpaceMachine,
      fetchStatus: statusSequence([launching()], [host()]),
      onSlow: () => { slowAtMs.push(Date.now() - pressedAtMs); },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(slowAtMs).toEqual([60_000]);
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(result).resolves.toMatchObject({ kind: "attach" });
    expect(slowAtMs).toEqual([60_000]);
  });

  it("never says it is slow after it returned or was cancelled", async () => {
    vi.useFakeTimers();
    onTestFinished(() => { vi.useRealTimers(); });
    const onSlow = vi.fn();
    await expect(coldStart({ fetchStatus: statusSequence([host()]), onSlow })).resolves.toMatchObject({ kind: "attach" });
    const controller = new AbortController();
    const cancelled = coldStart({
      ensureSpaceMachine: () => new Promise<boolean>((resolve) => { setTimeout(() => resolve(true), 90_000); }),
      fetchStatus: statusSequence([launching()]),
      onSlow,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await expect(cancelled).resolves.toEqual({ kind: "cancelled" });
    expect(onSlow).not.toHaveBeenCalled();
  });

  it("gives up at ten minutes from the press on a launch that never comes up", async () => {
    const clock = fakeClock();
    const onSlow = vi.fn();
    await expect(coldStart({ pinnedRuntimeId: "space", fetchStatus: statusSequence([launching()]), onSlow, ...clock }))
      .resolves.toEqual({ kind: "error", errorKind: "machine", reason: "space machine did not come up in time" });
    expect(clock.now()).toBe(SPACE_MACHINE_COLD_START_TIMEOUT_MS);
    expect(SPACE_MACHINE_COLD_START_TIMEOUT_MS).toBe(10 * 60_000);
    expect(onSlow).toHaveBeenCalledTimes(1);
  });
});

describe("spaceMachineLaunchOnItsWay", () => {
  const launch = (overrides: Partial<ControllerRuntimeStatusEntry> = {}) => entry({
    status: "requested", health: "offline", origin: null, lastSeenAt: null,
    createdAt: "2026-09-02T08:00:00.000Z", launchRequestedAt: "2026-10-24T17:48:31.000Z", ...overrides,
  });

  it("is a launch of the space's own machine that was asked for and not stopped since", () => {
    expect(spaceMachineLaunchOnItsWay(launch())).toBe(true);
    expect(spaceMachineLaunchOnItsWay(launch({ status: "launching" }))).toBe(true);
    // A platform stop's mark on the lease is still a launch that stalled.
    expect(spaceMachineLaunchOnItsWay(launch({ stopReason: "idle", stopRequestedAt: "2026-10-24T17:50:00.000Z" }))).toBe(true);
  });

  it("is not one without a requested launch, once seen, after a person's stop, or on another machine", () => {
    expect(spaceMachineLaunchOnItsWay(launch({ launchRequestedAt: undefined }))).toBe(false);
    expect(spaceMachineLaunchOnItsWay(launch({ status: "stopped" }))).toBe(false);
    expect(spaceMachineLaunchOnItsWay(launch({ lastSeenAt: "2026-10-24T17:53:15.000Z" }))).toBe(false);
    expect(spaceMachineLaunchOnItsWay(launch({ stopReason: "user_stop", stopRequestedAt: "2026-10-24T17:50:00.000Z" }))).toBe(false);
    expect(spaceMachineLaunchOnItsWay(launch({ displayName: "Browser session" }))).toBe(false);
    expect(spaceMachineLaunchOnItsWay(launch({ isPrivateSelfHosted: true }))).toBe(false);
    expect(spaceMachineLaunchOnItsWay(null)).toBe(false);
  });
});

describe("attach copy", () => {
  it("is written without em dashes", () => {
    for (const copy of Object.values(SHARED_BROWSER_HOST_COPY)) expect(copy).not.toMatch(/—/);
  });
});
