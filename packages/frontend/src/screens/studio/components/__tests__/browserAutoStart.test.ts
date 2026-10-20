import { beforeEach, describe, expect, it } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../../services/runtimeController";
import type { ChatMessage } from "../../types";
import {
  BROWSER_AUTO_START_COPY,
  browserAutoStartAddressesSeen,
  browserAutoStartHeldByComposerOrLayout,
  browserAutoStartPlan,
  browserAutoStartedRecently,
  claimBrowserAutoStart,
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

function plan(overrides: Partial<BrowserAutoStartPlanInput> = {}) {
  return browserAutoStartPlan({
    transport: "shared", personalAvailable: false, personalOwnAi: false, projectId: PROJECT,
    runtimes: [runtime()], ...overrides,
  });
}

describe("browserAutoStartPlan", () => {
  it("never opens Instafy's hosted browser by itself, whoever started the session running here", () => {
    // The controller does not record who started a session, so Studio cannot
    // tell the person's own from a teammate's: the card waits for a press.
    expect(plan({ runtimes: [runtime(), browserSession] }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession });
    expect(plan({ runtimes: [browserSession] }))
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

  it("leaves the card to the person while side-by-side view is off", () => {
    // The browser would open over the chat the person is reading.
    expect(browserAutoStartHeldByComposerOrLayout({ draft: "", wideSurfaces: true, splitView: false })).toBe(true);
    expect(browserAutoStartHeldByComposerOrLayout({ draft: "", wideSurfaces: false, splitView: true })).toBe(true);
    expect(browserAutoStartHeldByComposerOrLayout({ draft: " Wait ", wideSurfaces: true, splitView: true })).toBe(true);
    expect(browserAutoStartHeldByComposerOrLayout({ draft: "  ", wideSurfaces: true, splitView: true })).toBe(false);
  });

  it("writes its copy without em dashes", () => {
    for (const copy of Object.values(BROWSER_AUTO_START_COPY)) expect(copy).not.toMatch(/—/);
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
    ["an address only a notice named", [message({ authorId: ME, content: "Octo opened Instafy's browser at cheapflights.example",
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
