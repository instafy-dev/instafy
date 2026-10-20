import { describe, expect, it, vi } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../../services/runtimeController";
import type { SharedBrowserHostSnapshot } from "../../../../services/runtimeController/browserSession";
import { resolveBrowserRuntimeSelection } from "../browserSessionRuntimeEnsure";
import {
  SHARED_BROWSER_HOST_COPY,
  shouldStartSpaceMachineForBrowser,
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

/** A clock that only moves when the loop sleeps. */
function fakeClock() {
  let nowMs = 0;
  const sleeps: number[] = [];
  return {
    now: () => nowMs,
    sleep: vi.fn(async (ms: number) => { sleeps.push(ms); nowMs += ms; return true; }),
    sleeps,
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
    expect(clock.sleeps.every((ms) => ms === 500)).toBe(true);
  });

  it.each(["idle", "failed"] as const)("asks a viewer to get a builder when the browser is %s", async (state) => {
    const { value, startHost } = client([snapshot(state)]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: false, client: value, ...fakeClock() }))
      .resolves.toEqual({ kind: "error", message: SHARED_BROWSER_HOST_COPY.askBuilder });
    expect(startHost).not.toHaveBeenCalled();
  });

  it("says a poisoned browser needs the machine to restart, and never starts it", async () => {
    const { value, startHost } = client([snapshot("poisoned")]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...fakeClock() }))
      .resolves.toEqual({ kind: "error", message: SHARED_BROWSER_HOST_COPY.poisoned });
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

  it.each([
    ["browser_host_poisoned", SHARED_BROWSER_HOST_COPY.poisoned],
    ["machine_stopping", SHARED_BROWSER_HOST_COPY.machineStopping],
    ["something_new", SHARED_BROWSER_HOST_COPY.didNotStart],
  ])("ends on a start refused with %s", async (code, message) => {
    const { value } = client([snapshot("idle")], [new Refused(code)]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...fakeClock() }))
      .resolves.toEqual({ kind: "error", message });
  });

  it("does not restart a browser that failed after this wait started it", async () => {
    const { value, startHost } = client([snapshot("failed"), snapshot("starting"), snapshot("failed")]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...fakeClock() }))
      .resolves.toEqual({ kind: "error", message: SHARED_BROWSER_HOST_COPY.didNotStart });
    expect(startHost).toHaveBeenCalledTimes(1);
  });

  it("gives up after its cap with a retry hint", async () => {
    const { value } = client([snapshot("starting")]);
    const clock = fakeClock();
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...clock }))
      .resolves.toEqual({ kind: "error", message: SHARED_BROWSER_HOST_COPY.didNotStart });
    expect(clock.now()).toBe(120_000);
  });

  it("reports no host (404) as not available", async () => {
    const { value } = client([null]);
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, ...fakeClock() }))
      .resolves.toEqual({ kind: "error", message: SHARED_BROWSER_HOST_COPY.notAvailable });
  });

  it("stops quietly once cancelled", async () => {
    const controller = new AbortController();
    const { value } = client([snapshot("starting")]);
    const clock = fakeClock();
    clock.sleep.mockImplementation(async () => { controller.abort(); return false; });
    await expect(waitForSharedBrowserHostReady({ ...base, canControl: true, client: value, signal: controller.signal, ...clock }))
      .resolves.toEqual({ kind: "cancelled" });
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

  it("fails when the machine does not start or does not come up within three minutes", async () => {
    await expect(startSpaceMachineForBrowser({
      projectId: "project-1", pinnedRuntimeId: null, conversationRuntimeId: null,
      ensureSpaceMachine: async () => false, fetchStatus: statusSequence([]), ...fakeClock(),
    })).resolves.toEqual({ kind: "error", message: SHARED_BROWSER_HOST_COPY.machineDidNotStart });
    const clock = fakeClock();
    await expect(startSpaceMachineForBrowser({
      projectId: "project-1", pinnedRuntimeId: "space", conversationRuntimeId: null,
      ensureSpaceMachine: async () => true, fetchStatus: statusSequence([entry({ status: "starting" })]), ...clock,
    })).resolves.toEqual({ kind: "error", message: SHARED_BROWSER_HOST_COPY.machineDidNotStart });
    expect(clock.now()).toBe(180_000);
  });
});

describe("attach copy", () => {
  it("is written without em dashes", () => {
    for (const copy of Object.values(SHARED_BROWSER_HOST_COPY)) expect(copy).not.toMatch(/—/);
  });
});
