import { beforeEach, describe, expect, it } from "vitest";
import type { ControllerRuntimeStatusEntry } from "../../../../services/runtimeController";
import type { ChatMessage } from "../../types";
import {
  BROWSER_AUTO_START_COPY,
  browserAutoStartAddressesSeen,
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
    runtimes: [runtime()], ownSessionRuntimeId: null, ...overrides,
  });
}

describe("browserAutoStartPlan", () => {
  it("reuses the browser session this person opened in this conversation", () => {
    expect(plan({ runtimes: [runtime(), browserSession], ownSessionRuntimeId: SESSION_ID }))
      .toEqual({ kind: "reuse", runtimeId: SESSION_ID });
  });

  it("never continues on a browser session someone else started", () => {
    // The session runs, but this person never opened it here: a teammate's
    // sign-ins and pages stay theirs, so the card waits for a press.
    expect(plan({ runtimes: [runtime(), browserSession] }))
      .toEqual({ kind: "button", reason: BROWSER_AUTO_START_COPY.otherSession });
    expect(plan({ runtimes: [runtime(), browserSession], ownSessionRuntimeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }))
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
      ownSessionRuntimeId: SESSION_ID,
    }, BROWSER_AUTO_START_COPY.severalSessions],
    ["this space's runtimes are not known", { runtimes: null }, null],
  ] as const)("leaves the button when %s", (_name, overrides, reason) => {
    expect(plan(overrides as Partial<BrowserAutoStartPlanInput>)).toEqual({ kind: "button", reason });
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
  function seen(task: string, earlier: ChatMessage[], options: { skillSetup?: boolean } = {}) {
    const messages = [...earlier, card(task)];
    return browserAutoStartAddressesSeen({
      task, messages, cardIndex: messages.length - 1, currentUserId: ME, skillSetup: options.skillSetup ?? false,
    });
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

  it("opens the address a skill declares in a skill setup", () => {
    expect(seen("Open https://app.freefinance.at and take me to API keys.", [], { skillSetup: true })).toBe(true);
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
