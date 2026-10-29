import { beforeEach, describe, expect, it } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../../services/runtimeController";
import type { SharedBrowserHostSnapshot } from "../../../../services/runtimeController/browserSession";
import type { ChatMessage } from "../../types";
import {
  BROWSER_AUTO_START_COPY,
  browserAutoStartAddressesSeen,
  browserAutoStartHeldByDraft,
  browserAutoStartHeldByOther,
  browserAutoStartPlan,
  browserAutoStartedRecently,
  claimBrowserAutoStart,
  conversationBrowserHostId,
  forgetBrowserAutoStartsForTests,
  hostsNamedIn,
  isBrowserAutoStartDeclined,
  markBrowserAutoStartDeclined,
  recordBrowserAutoStart,
  type BrowserAutoStartPlanInput,
} from "../browserAutoStart";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date().toISOString();
const SESSION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function runtime(overrides: Partial<ControllerRuntimeStatusEntry> = {}): ControllerRuntimeStatusEntry {
  return {
    runtimeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "ready", provider: "instafy-cloud", idleTtlSeconds: 900,
    isLocal: false, isPreferred: true, health: "online", displayName: "hosted runtime", lastSeenAt: NOW, createdAt: NOW,
    ...overrides,
  };
}
const browserSession = runtime({
  runtimeId: SESSION_ID, displayName: "Browser session",
  origin: { originId: "origin-1", endpoint: "https://origin.test", protocols: ["http"] } as ControllerRuntimeStatusEntry["origin"],
});

const MACHINE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SECOND_MACHINE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const NOW_MS = Date.parse("2026-10-20T12:00:00Z");
function lazyHost(overrides: Partial<ControllerRuntimeStatusEntry> = {}): ControllerRuntimeStatusEntry {
  return runtime({
    origin: { originId: "origin-space", endpoint: "https://origin.test", protocols: ["http"] } as ControllerRuntimeStatusEntry["origin"],
    sharedBrowserHost: { version: 1, mode: "lazy" },
    ...overrides,
  });
}
function readyHost(overrides: Partial<SharedBrowserHostSnapshot> = {}): SharedBrowserHostSnapshot {
  return {
    version: 1, mode: "lazy", state: "ready", generation: "gen-1", failure: null, startedByYou: false,
    othersPresent: false, controlledByOther: false, agentRunActive: false, agentRunStartedByYou: false, ...overrides,
  };
}

function plan(overrides: Partial<BrowserAutoStartPlanInput> = {}) {
  return browserAutoStartPlan({
    transport: "shared", personalAvailable: false, personalOwnAi: false, projectId: PROJECT,
    runtimes: [runtime()], ...overrides,
  });
}

describe("browserAutoStartPlan", () => {
  it.each([
    ["no host policy", {}],
    ["the policy is off", { sharedBrowserHostPolicy: "off" as const }],
    ["the space is covered", { sharedBrowserHostPolicy: "covered" as const, conversationRuntimeId: SESSION_ID }],
  ])("never opens a separate browser session by itself, whoever started it (%s)", (_name, overrides) => {
    // The controller does not record who started a session, so Studio cannot
    // tell the person's own from a teammate's: the card waits for a press.
    expect(plan({ runtimes: [runtime(), browserSession], ...overrides }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession });
    expect(plan({ runtimes: [browserSession], ...overrides }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession });
  });

  it("opens the browser on this device for a person on their own AI", () => {
    expect(plan({ transport: "personal", personalAvailable: true, personalOwnAi: true })).toEqual({ kind: "personal" });
    expect(plan({ transport: "personal", personalAvailable: true, personalOwnAi: false }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.personalNeedsOwnAi });
  });

  it("never switches this space's own machine to the browser, idle or not", () => {
    // Studio cannot see a preview, dev server or terminal session still
    // running there, and a restart would stop it.
    expect(plan()).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.restartsMachine });
    expect(plan({ runtimes: [runtime(), runtime({ runtimeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", status: "stopped" })] }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.restartsMachine });
  });

  it("never opens by itself in a covered space whose machine has no browser on demand, or is stopped (row 3)", () => {
    // A live machine that did not report Instafy's browser on demand (an
    // older image) would have to restart as the browser.
    const covered = { sharedBrowserHostPolicy: "covered" as const, conversationRuntimeId: MACHINE_ID, host: readyHost(), hostReadAtMs: NOW_MS, nowMs: NOW_MS };
    expect(plan({ ...covered, runtimes: [runtime()] }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.restartsMachine });
    // A stopped machine is never started by itself.
    expect(plan({ ...covered, runtimes: [lazyHost({ status: "stopped" })] }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.firstMachine });
    // A live host without an origin, or one that is not the conversation's.
    expect(plan({ ...covered, runtimes: [lazyHost({ origin: undefined })] }))
      .toEqual({ kind: "button", reason: null });
    expect(plan({ ...covered, conversationRuntimeId: "ffffffff-ffff-4fff-8fff-ffffffffffff", runtimes: [lazyHost()] }))
      .toEqual({ kind: "button", reason: null });
  });

  it.each([
    ["there is no cloud machine in this space", { runtimes: [] }, BROWSER_AUTO_START_COPY.firstMachine],
    ["only a desktop or self-hosted machine runs here", {
      runtimes: [runtime({ provider: "desktop", isLocal: true }), runtime({ isPrivateSelfHosted: true })],
    }, BROWSER_AUTO_START_COPY.firstMachine],
    ["the space has several cloud machines", {
      runtimes: [runtime(), runtime({ runtimeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" })],
    }, BROWSER_AUTO_START_COPY.anotherMachine],
    ["the machine is not this space's standard machine", { runtimes: [runtime({ displayName: "GPU worker" })] }, BROWSER_AUTO_START_COPY.secondMachine],
    ["several browser sessions are running", {
      runtimes: [browserSession, { ...browserSession, runtimeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }],
    }, BROWSER_AUTO_START_COPY.severalSessions],
    ["this space's runtimes are not known", { runtimes: null }, null],
  ] as const)("leaves the button when %s", (_name, overrides, reason) => {
    expect(plan(overrides as Partial<BrowserAutoStartPlanInput>)).toEqual({ kind: "button", reason });
  });

  it.each([
    ["is starting again", { status: "requested", health: "offline", origin: undefined }],
    ["has a late heartbeat", { lastSeenAt: "2026-10-27T10:00:00Z", idleTtlSeconds: 300, health: "idle" }],
    ["reports itself offline", { health: "offline" }],
  ] as const)("says the browser session is running, never a second machine, while its machine %s", (_name, overrides) => {
    // A press opens that machine again (the controller restarts one that
    // stopped answering); the card says what the cards of other
    // conversations say for the same machine.
    const stuck = { ...browserSession, ...overrides } as ControllerRuntimeStatusEntry;
    expect(plan({ runtimes: [stuck] })).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession });
    expect(plan({ runtimes: [runtime(), stuck] }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession });
    // Once it has stopped, a press starts it, as for any stopped machine.
    expect(plan({ runtimes: [{ ...stuck, status: "stopped" }] }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.firstMachine });
  });

  it("never counts Instafy's browser on the space's own machine as a running session", () => {
    // Until Studio may open it by itself, a live host is still a press, and
    // a press opens it in place: it neither restarts nor adds a machine.
    const host = runtime({
      origin: { originId: "origin-space", endpoint: "https://origin.test", protocols: ["http"] } as ControllerRuntimeStatusEntry["origin"],
      sharedBrowserHost: { version: 1, mode: "lazy" },
    });
    expect(plan({ runtimes: [host] })).toEqual({ kind: "button", reason: null });
    expect(plan({ runtimes: [host, browserSession] }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession });
    // Without the controller's host field (older controller, policy off),
    // the same machine keeps today's reason.
    expect(plan({ runtimes: [{ ...host, sharedBrowserHost: undefined }] }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.restartsMachine });
  });

  it("holds a card only for a draft, never for a narrow pane or side-by-side view off", () => {
    // Owner decision ("Always, no prompt"): the browser takes the view as a
    // press does, so the layout plays no part. Only the input it reads exists.
    expect(browserAutoStartHeldByDraft({ draft: "" })).toBe(false);
    expect(browserAutoStartHeldByDraft({ draft: "  \n" })).toBe(false);
    expect(browserAutoStartHeldByDraft({ draft: " Wait " })).toBe(true);
    // The held card says why, in plain words.
    expect(BROWSER_AUTO_START_COPY.draftHeld).toBe("Opens by itself once your draft is empty.");
    expect(BROWSER_AUTO_START_COPY.draftHeld).not.toMatch(/\u2014/);
  });

  it("holds a card while a sign-in handoff is pending after its request cleared", () => {
    const idle = { browserRunActive: false, remoteController: false, humanInputRequest: false, pendingHandoff: false };
    expect(browserAutoStartHeldByOther(idle)).toBe(false);
    // Desktop drops humanInputRequest on the sign-in redirect; the handoff
    // Studio saw still holds the card.
    expect(browserAutoStartHeldByOther({ ...idle, pendingHandoff: true })).toBe(true);
    expect(browserAutoStartHeldByOther({ ...idle, humanInputRequest: true })).toBe(true);
    expect(browserAutoStartHeldByOther({ ...idle, browserRunActive: true })).toBe(true);
    expect(browserAutoStartHeldByOther({ ...idle, remoteController: true })).toBe(true);
  });

  it("writes its copy without em dashes", () => {
    for (const copy of Object.values(BROWSER_AUTO_START_COPY)) expect(copy).not.toMatch(/—/);
  });
});

describe("browserAutoStartPlan for Instafy's browser on the conversation's own machine", () => {
  function hostPlan(overrides: Partial<BrowserAutoStartPlanInput> = {}) {
    return plan({
      runtimes: [lazyHost()], sharedBrowserHostPolicy: "covered", conversationRuntimeId: MACHINE_ID,
      host: readyHost(), hostReadAtMs: NOW_MS - 1_000, nowMs: NOW_MS, ...overrides,
    });
  }

  it.each(["idle", "ready", "stopping"] as const)("opens it by itself when it is %s and nobody else has it (row 8)", (state) => {
    expect(hostPlan({ host: readyHost({ state }) })).toEqual({ kind: "attach", runtimeId: MACHINE_ID });
  });

  it("opens it while the person's own start is still running, and their own agent run works in it", () => {
    expect(hostPlan({ host: readyHost({ state: "starting", startedByYou: true }) }))
      .toEqual({ kind: "attach", runtimeId: MACHINE_ID });
    expect(hostPlan({ host: readyHost({ agentRunActive: true, agentRunStartedByYou: true }) }))
      .toEqual({ kind: "attach", runtimeId: MACHINE_ID });
  });

  it("keeps today's buttons without a covering policy (row 2)", () => {
    expect(hostPlan({ sharedBrowserHostPolicy: null })).toEqual({ kind: "button", reason: null });
    expect(hostPlan({ sharedBrowserHostPolicy: undefined })).toEqual({ kind: "button", reason: null });
    expect(hostPlan({ sharedBrowserHostPolicy: "off", runtimes: [lazyHost({ sharedBrowserHost: undefined })] }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.restartsMachine });
  });

  it("leaves a separate browser session running beside it to a press (row 4)", () => {
    expect(hostPlan({ runtimes: [lazyHost(), browserSession] }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession });
    expect(hostPlan({ runtimes: [lazyHost(), browserSession, { ...browserSession, runtimeId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }] }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.severalSessions });
  });

  it("asks for a fresh reading first when it has none or the last arrived over five seconds ago (row 5)", () => {
    expect(hostPlan({ host: null, hostReadAtMs: null })).toEqual({ kind: "pending" });
    expect(hostPlan({ hostReadAtMs: undefined })).toEqual({ kind: "pending" });
    expect(hostPlan({ hostReadAtMs: NOW_MS - 5_001 })).toEqual({ kind: "pending" });
    expect(hostPlan({ hostReadAtMs: NOW_MS - 5_000 })).toEqual({ kind: "attach", runtimeId: MACHINE_ID });
  });

  it("leaves a fresh answer of no browser on that machine to a press", () => {
    expect(hostPlan({ host: null })).toEqual({ kind: "button", reason: null });
  });

  it("leaves a poisoned browser a button, with the reason (row 6)", () => {
    // Only the machine's restart brings it back, and Studio never restarts one.
    expect(hostPlan({ host: readyHost({ state: "poisoned" }) }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.hostPoisoned });
  });

  // Local drive, Oct 29: one card waited for a press, the next opened by
  // itself, the third waited again. On the space's own machine a card now
  // opens by itself whether its browser runs or not, and the open starts it.
  it.each(["failed", "unknown"] as const)("opens a %s browser by itself, as a press would, starting it (row 8)", (state) => {
    expect(hostPlan({ host: readyHost({ state }) })).toEqual({ kind: "attach", runtimeId: MACHINE_ID });
  });

  it("counts the conversation's machine as the browser's host whatever its last heartbeat said", () => {
    // A heartbeat later than the machine's idle time made the card a button
    // that never opened; a reading of the browser says whether it answers.
    const late = lazyHost({ lastSeenAt: new Date(Date.now() - 20 * 60_000).toISOString(), idleTtlSeconds: 300, health: "idle" });
    expect(hostPlan({ runtimes: [late], host: null, hostReadAtMs: null })).toEqual({ kind: "pending" });
    expect(hostPlan({ runtimes: [late] })).toEqual({ kind: "attach", runtimeId: MACHINE_ID });
    // A machine that is starting, or has stopped, still waits for a press.
    expect(hostPlan({ runtimes: [lazyHost({ status: "requested" })] })).not.toMatchObject({ kind: "attach" });
    expect(hostPlan({ runtimes: [lazyHost({ status: "stopped" })] })).not.toMatchObject({ kind: "attach" });
  });

  it.each([
    ["someone else has it open", { othersPresent: true }],
    ["someone else controls it", { controlledByOther: true }],
    ["another person's agent run works in it", { agentRunActive: true }],
    ["someone else is starting it", { state: "starting" as const }],
  ])("holds the card while %s (row 7)", (_name, overrides) => {
    expect(hostPlan({ host: readyHost(overrides) })).toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.hostInUse });
  });

  it("never opens Instafy's browser for the browser on this device (row 1)", () => {
    expect(hostPlan({ transport: "personal", personalAvailable: true, personalOwnAi: true })).toEqual({ kind: "personal" });
  });

  // A new space's first conversation names no machine until a press picks
  // one: it runs on the space's machine, and its card opens that machine's
  // browser by itself instead of waiting for a press.
  it("opens the space's one machine for a conversation that names none", () => {
    expect(hostPlan({ conversationRuntimeId: null })).toEqual({ kind: "attach", runtimeId: MACHINE_ID });
    expect(conversationBrowserHostId({ sharedBrowserHostPolicy: "covered", conversationRuntimeId: null, runtimes: [lazyHost()] }))
      .toBe(MACHINE_ID);
    // Two such machines leave it to a press; so do a stopped one and a space that is not covered.
    expect(hostPlan({ conversationRuntimeId: null, runtimes: [lazyHost(), lazyHost({ runtimeId: SECOND_MACHINE_ID })] }))
      .not.toMatchObject({ kind: "attach" });
    expect(hostPlan({ conversationRuntimeId: null, runtimes: [lazyHost({ status: "stopped" })] })).not.toMatchObject({ kind: "attach" });
    expect(hostPlan({ conversationRuntimeId: null, sharedBrowserHostPolicy: null })).not.toMatchObject({ kind: "attach" });
    // A conversation that names another machine never opens this one.
    expect(hostPlan({ conversationRuntimeId: SECOND_MACHINE_ID })).not.toMatchObject({ kind: "attach" });
  });
});

describe("addresses Studio may open by itself", () => {
  const ME = "user-1";
  function message(overrides: Partial<ChatMessage>): ChatMessage {
    return { id: `m-${Math.random()}`, role: "user", content: "", timestamp: 1, ...overrides };
  }
  function card(task: string): ChatMessage {
    return message({ role: "assistant", content: "Continue this task in Instafy's browser.", metadata: {
      messageType: "action_request", jobId: "job-2", details: { browserRequest: { task, location: "auto" } },
    } });
  }
  function seen(task: string, earlier: ChatMessage[]) {
    const messages = [...earlier, card(task)];
    return browserAutoStartAddressesSeen({ task, messages, cardIndex: messages.length - 1, currentUserId: ME });
  }
  /** An earlier turn's row, of the given type, naming the address. */
  function earlierRow(messageType: string | null, metadata: Record<string, unknown> = {}): ChatMessage {
    return message({ role: "assistant", messageType, metadata: { jobId: "job-1", ...metadata },
      content: "Found it at https://cheapflights.example/deals." });
  }

  it("finds every host a task names, not only the first", () => {
    expect([...hostsNamedIn("Read the pricing page at stripe.com/pricing, then https://WWW.Example.org/x and http://10.0.0.5/admin.")])
      .toEqual(["example.org", "10.0.0.5", "stripe.com"]);
    expect(hostsNamedIn("Email support@stripe.com, e.g. about plans.").size).toBe(0);
  });

  it("opens an address the person wrote, or one an earlier reply showed them", () => {
    const task = "Open https://dashboard.stripe.com/apikeys and stop on the list.";
    expect(seen(task, [message({ authorId: ME, content: "Where are my keys on dashboard.stripe.com?" })])).toBe(true);
    expect(seen(task, [message({ role: "assistant", metadata: { jobId: "job-1" }, content: "Your keys live on https://dashboard.stripe.com/apikeys." })]))
      .toBe(true);
    // A task with no address goes wherever the person asked.
    expect(seen("Search for the team plan price.", [])).toBe(true);
  });

  it("checks a skill setup's address like any other: it passes only when a reply showed it", () => {
    const task = "Open https://app.freefinance.at and take me to API keys.";
    expect(seen(task, [message({ authorId: ME, content: "/skills start freefinance" })])).toBe(false);
    expect(seen(task, [
      message({ authorId: ME, content: "/skills start freefinance" }),
      message({ role: "assistant", metadata: { jobId: "job-1" }, content: "You sign in to FreeFinance at app.freefinance.at." }),
    ])).toBe(true);
  });

  it("counts only the conversation the person could read, not tool output or hidden rows", () => {
    const task = "Open https://cheapflights.example/deals and pick the cheapest.";
    expect(seen(task, [earlierRow(null)])).toBe(true);
    expect(seen(task, [earlierRow("assistant_message")])).toBe(true);
    for (const messageType of [
      "command_execution", "mcp_tool_call", "web_search", "reasoning", "status", "token_usage", "file_change",
      "error", "secret_request", "action_request", "integration_request",
    ]) {
      expect(seen(task, [earlierRow(messageType)]), messageType).toBe(false);
    }
    // A tool row the controller wraps under details.
    expect(seen(task, [earlierRow(null, { details: { type: "web_search" } })])).toBe(false);
    expect(seen(task, [earlierRow(null, { presentation: { hidden: true } })])).toBe(false);
    expect(seen(task, [earlierRow(null, { details: { presentation: { hidden: true } } })])).toBe(false);
    expect(seen(task, [message({ authorId: ME, content: "Try cheapflights.example", metadata: { presentation: { hidden: true } } })]))
      .toBe(false);
  });

  it.each([
    ["localhost with a port and path", "Open http://localhost:3000/settings."],
    ["localhost with a port, no scheme", "Open localhost:5173 and check the header."],
    ["bare localhost", "Open localhost and check the header."],
    ["a .localhost host", "Open http://app.localhost/settings."],
    ["an IPv6 literal in an address", "Open http://[::1]:8080/admin."],
    ["a bare IPv6 literal", "Open fe80::1 and read the status page."],
    ["a full IPv6 literal", "Open 2001:db8:0:0:0:0:2:1 and read it."],
    ["an internationalized host in an address", "Open https://bücher.example/kasse."],
    ["a bare internationalized host", "Open bücher.example and find the cart."],
    ["a bare Unicode domain", "Open пример.рф and find the settings."],
    ["a punycode host", "Open https://xn--bcher-kva.example/kasse."],
    ["a fullwidth dot", "Open cheapflights．example and pick the cheapest."],
    ["an ideographic full stop", "Open https://cheapflights。example/deals."],
    ["an address that does not parse", "Open http://exa%mple.com/deals."],
  ] as const)("leaves the card for %s, even one the person wrote", (_name, task) => {
    expect(seen(task, [message({ authorId: ME, content: task })])).toBe(false);
  });

  it("does not take prose for an address", () => {
    for (const task of [
      "Откройте настройки, т.е. страницу ключей.",
      "設定を開いてください。次にキーを表示します。",
      "Stop at 12:30:45 and use std::fs as the example.",
    ]) {
      expect(seen(task, []), task).toBe(true);
    }
  });

  it.each([
    ["an address Octo found during the turn that sent the card", [
      message({ authorId: ME, content: "Find me a cheap flight." }),
      message({ role: "assistant", metadata: { jobId: "job-2" }, content: "The best deal is on cheapflights.example." }),
    ]],
    ["an address only a teammate wrote", [message({ authorId: "user-2", content: "Try cheapflights.example" })]],
    ["an address only a notice named", [message({ authorId: ME, content: "Octo opened Instafy's browser for cheapflights.example",
      metadata: { browserRequestOf: "job:job-0" } })]],
    ["a look-alike of an address the person wrote", [message({ authorId: ME, content: "Use flights.example" })]],
  ] as const)("leaves the card for %s", (_name, earlier) => {
    expect(seen("Open https://cheapflights.example/deals and pick the cheapest.", [...earlier])).toBe(false);
  });
});

describe("what this page remembers about automatic starts", () => {
  beforeEach(() => forgetBrowserAutoStartsForTests());

  it("claims a card once", () => {
    expect(claimBrowserAutoStart("job:1")).toBe(true);
    expect(claimBrowserAutoStart("job:1")).toBe(false);
    expect(claimBrowserAutoStart("")).toBe(false);
  });

  it("starts one card per conversation in ten minutes and remembers declines", () => {
    recordBrowserAutoStart("conversation", 1_000);
    expect(browserAutoStartedRecently("conversation", 1_000 + 9 * 60_000)).toBe(true);
    expect(browserAutoStartedRecently("conversation", 1_000 + 10 * 60_000)).toBe(false);
    expect(isBrowserAutoStartDeclined("conversation")).toBe(false);
    markBrowserAutoStartDeclined("conversation");
    expect(isBrowserAutoStartDeclined("conversation")).toBe(true);
    forgetBrowserAutoStartsForTests();
    expect(isBrowserAutoStartDeclined("conversation")).toBe(false);
  });
});
