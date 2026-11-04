// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";

const mocks = vi.hoisted(() => ({
  requestAccessToken: vi.fn(),
  fetchPendingApproval: vi.fn(),
  decideApproval: vi.fn(),
  showStatus: vi.fn(),
  hideStatus: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: { origin: { requestAccessToken: mocks.requestAccessToken } },
    browserSessions: { fetchPendingApproval: mocks.fetchPendingApproval, decideApproval: mocks.decideApproval },
  },
}));
vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ queue: null, showStatus: mocks.showStatus, hideStatus: mocks.hideStatus }),
}));

import {
  chatReadingOwnPrompts,
  openChatAwaitingOk,
  WAITING_PROMPT_REREAD_GRACE_MS,
  WaitingBrowserPrompts,
  waitingPromptToastText,
  withChatsAwaitingOk,
  type WaitingPromptChat,
} from "../WaitingBrowserPrompts";
import {
  conversationSurfaceScope,
  DEFAULT_CONVERSATION_SURFACES,
  openConversationFile,
  openConversationPreview,
  selectConversationView,
  type ConversationSurfaces,
} from "../../../../workspace/conversationSurfaces";

const me = "55555555-5555-4555-8555-555555555555";
const teammate = "66666666-6666-4666-8666-666666666666";
const project = "77777777-7777-4777-8777-777777777777";
const machine = "11111111-1111-4111-8111-111111111111";
const otherMachine = "12121212-1212-4121-8121-121212121212";
const chatA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const chatB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const chatC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const chatD = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const runA = "44444444-4444-4444-8444-44444444444a";
const runC = "44444444-4444-4444-8444-44444444444c";
const runD = "44444444-4444-4444-8444-44444444444d";
const approvalId = "22222222-2222-4222-8222-222222222222";

const chats: WaitingPromptChat[] = [
  { localId: "local-a", controllerId: chatA, title: "Open visitporto.travel in your browser" },
  { localId: "local-b", controllerId: chatB, title: "Plan 3 days in Seville" },
];

function browserRun(id: string, conversationId: string, metadata: Record<string, unknown> = {}, updatedAt = new Date().toISOString()): RunRecord {
  return {
    id, projectId: project, sessionId: null, conversationId, promptId: null, runType: "prompt", status: "in_progress",
    progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
    metadata: { browserTransport: "shared", initiatingUserId: me, browserRuntimeId: machine, browserPageId: `page-${id.slice(-1)}`, ...metadata },
    createdAt: updatedAt, updatedAt,
  } as RunRecord;
}

function promptFor(run: string, overrides: Record<string, unknown> = {}) {
  return {
    runtimeId: machine,
    request: {
      version: 1 as const, approvalId, kind: "action" as const, ownerId: "33333333-3333-4333-8333-333333333333", runId: run,
      initiatorUserId: me, browserPageId: `page-${run.slice(-1)}`, operation: "click" as const,
      sourceOrigin: "https://en.metrodoporto.pt", destinationOrigin: "https://en.metrodoporto.pt",
      destinationFingerprint: "a".repeat(64), snapshotId: null, targetFingerprint: null, payloadFingerprint: null,
      requestedAtMs: Date.now(), expiresAtMs: Date.now() + 120_000, requestFingerprint: "e".repeat(64),
      display: { label: "Edit", destinationOrigin: "https://en.metrodoporto.pt" },
      ...overrides,
    },
  };
}

type Props = Parameters<typeof WaitingBrowserPrompts>[0];

describe("WaitingBrowserPrompts", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onView = vi.fn();
  const onWaitingChange = vi.fn();
  const waitingChats = () => [...(onWaitingChange.mock.calls.at(-1)?.[0] ?? [])];

  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of [...Object.values(mocks), onView, onWaitingChange]) mock.mockReset();
    mocks.requestAccessToken.mockResolvedValue({ token: "view-token", endpoint: "https://origin.example.test", expiresIn: 300 });
    mocks.fetchPendingApproval.mockResolvedValue(null);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  /** Time passing as in a browser: React draws between the reads and timers. */
  async function step(ms: number, by = 100) {
    for (let done = 0; done < ms; done += by) {
      await act(async () => { await vi.advanceTimersByTimeAsync(Math.min(by, ms - done)); });
    }
  }

  async function render(props: Omit<Partial<Props>, "runs"> & { runs: RunRecord[] }) {
    await act(async () => {
      root.render(
        <WaitingBrowserPrompts
          enabled
          userId={me}
          projectId={project}
          chats={chats}
          chatOnScreen={chatB}
          onView={onView}
          onWaitingChange={onWaitingChange}
          {...props}
          runs={Object.fromEntries(props.runs.map((run) => [run.id, run]))}
        />,
      );
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }

  // "Octo wants to click “Edit” on en.metrodoporto.pt." waited 2 minutes in
  // one chat while the person was in another, and ran out unseen.
  it("tells the person in chat B, within 2 s, that chat A waits for their OK, and View opens chat A", async () => {
    await render({ runs: [browserRun(runA, chatA)] });
    // A view-only grant for the turn's machine, and a read of its own page.
    expect(mocks.requestAccessToken).toHaveBeenCalledWith(expect.objectContaining({
      projectId: project, scopes: ["browser.view"], preferRuntime: machine,
    }));
    expect(mocks.fetchPendingApproval).toHaveBeenCalledWith(expect.objectContaining({
      originAccessToken: "view-token", runtimeId: machine, browserPageId: "page-a",
    }));
    expect(mocks.showStatus).not.toHaveBeenCalled();

    // The turn asks just after a read.
    mocks.fetchPendingApproval.mockResolvedValue(promptFor(runA));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mocks.showStatus).toHaveBeenCalledTimes(1);
    const [text, intent, duration, options] = mocks.showStatus.mock.calls[0]!;
    expect(text).toBe("Octo is waiting for your OK in “Open visitporto.travel in your browser”.");
    expect(text).not.toMatch(/Edit|metrodoporto|click/);
    expect(intent).toBe("info");
    expect(duration).toBe(0);
    expect(options).toMatchObject({ actionLabel: "View", behavior: { kind: "action-required" }, nonPreemptive: true });
    // Chat A's tab says Approve.
    expect(waitingChats()).toEqual([chatA]);

    // A read later still waits: one toast for one prompt.
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mocks.showStatus).toHaveBeenCalledTimes(1);

    options.onAction();
    expect(onView).toHaveBeenCalledWith({ conversationId: chatA, localId: "local-a" });

    // Chat A on screen reads its own prompt: the toast and the tab's Approve go,
    // and nothing here reads chat A any more.
    await render({ runs: [browserRun(runA, chatA)], chatOnScreen: chatA });
    expect(mocks.hideStatus).toHaveBeenCalledWith(options.id);
    expect(waitingChats()).toEqual([]);
    const reads = mocks.fetchPendingApproval.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(mocks.fetchPendingApproval).toHaveBeenCalledTimes(reads);
    // Nothing here ever answers a prompt.
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("raises nothing for a prompt in a turn another member started", async () => {
    mocks.fetchPendingApproval.mockResolvedValue(promptFor(runA, { initiatorUserId: teammate }));
    await render({ runs: [browserRun(runA, chatA, { initiatingUserId: teammate })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(mocks.requestAccessToken).not.toHaveBeenCalled();
    expect(mocks.fetchPendingApproval).not.toHaveBeenCalled();
    expect(mocks.showStatus).not.toHaveBeenCalled();
    // Nothing waits, so the tabs are not told anything.
    expect(onWaitingChange).not.toHaveBeenCalled();

    // Nor for a prompt the origin hands back that is not the person's own run's.
    await render({ runs: [browserRun(runA, chatA)] });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(mocks.fetchPendingApproval).toHaveBeenCalled();
    expect(mocks.showStatus).not.toHaveBeenCalled();
    expect(waitingChats()).toEqual([]);
  });

  it("takes the toast and the tab's Approve away once the prompt is answered elsewhere", async () => {
    mocks.fetchPendingApproval.mockResolvedValue(promptFor(runA));
    await render({ runs: [browserRun(runA, chatA)] });
    expect(mocks.showStatus).toHaveBeenCalledTimes(1);
    expect(waitingChats()).toEqual([chatA]);
    // Answered in Studio on another device: the next read finds none, and
    // after a re-read's grace the toast and the mark go.
    mocks.fetchPendingApproval.mockResolvedValue(null);
    await step(1_000);
    expect(mocks.hideStatus).not.toHaveBeenCalled();
    await step(WAITING_PROMPT_REREAD_GRACE_MS);
    expect(mocks.hideStatus).toHaveBeenCalledWith(mocks.showStatus.mock.calls[0]![3].id);
    expect(waitingChats()).toEqual([]);
  });

  // The read's grant is renewed every few minutes, and a renewed lane reads its
  // prompt again from nothing: the toast went and came back, the tab's Approve
  // blinked, and a toast the person had closed came back.
  it("keeps the toast and the tab's Approve while its grant is renewed", async () => {
    let minted = 0;
    // A grant that lives 31 s is renewed after 1 s.
    mocks.requestAccessToken.mockImplementation(async () => ({ token: `view-token-${++minted}`, endpoint: "https://origin.example.test", expiresIn: 31 }));
    mocks.fetchPendingApproval.mockImplementation(async () => promptFor(runA));
    await render({ runs: [browserRun(runA, chatA)] });
    expect(mocks.showStatus).toHaveBeenCalledTimes(1);
    expect(waitingChats()).toEqual([chatA]);
    const told = onWaitingChange.mock.calls.length;

    await step(3_500);
    expect(minted).toBeGreaterThanOrEqual(3);
    expect(mocks.fetchPendingApproval).toHaveBeenCalledWith(expect.objectContaining({ originAccessToken: `view-token-${minted}` }));
    expect(mocks.hideStatus).not.toHaveBeenCalled();
    expect(mocks.showStatus).toHaveBeenCalledTimes(1);
    expect(onWaitingChange).toHaveBeenCalledTimes(told);
  });

  it("takes the toast away as soon as the prompt runs out", async () => {
    const prompt = promptFor(runA, { expiresAtMs: Date.now() + 3_000 });
    mocks.fetchPendingApproval.mockImplementation(async () => prompt);
    await render({ runs: [browserRun(runA, chatA)] });
    expect(mocks.showStatus).toHaveBeenCalledTimes(1);
    await step(2_900);
    expect(mocks.hideStatus).not.toHaveBeenCalled();
    // Gone with the first read after its time, with no grace.
    await step(500);
    expect(mocks.hideStatus).toHaveBeenCalledWith(mocks.showStatus.mock.calls[0]![3].id);
    expect(waitingChats()).toEqual([]);
  });

  it("reads one prompt a machine, of the person's newest turn there, and none for the chat on screen", async () => {
    const older = browserRun(runA, chatA, {}, "2026-11-02T03:48:00.000Z");
    const newer = browserRun(runC, chatC, {}, "2026-11-02T03:49:00.000Z");
    const elsewhere = browserRun(runD, chatD, { browserRuntimeId: otherMachine }, "2026-11-02T03:47:00.000Z");
    vi.setSystemTime(new Date("2026-11-02T03:50:00.000Z"));
    await render({ runs: [older, newer, elsewhere] });
    const pages = () => new Set(mocks.fetchPendingApproval.mock.calls.map(([call]) => `${call.runtimeId} ${call.browserPageId}`));
    expect(pages()).toEqual(new Set([`${machine} page-c`, `${otherMachine} page-d`]));

    // With chat C on screen, its own lane reads that machine; only chat D's is read here.
    mocks.fetchPendingApproval.mockClear();
    await render({ runs: [older, newer, elsewhere], chatOnScreen: chatC });
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(pages()).toEqual(new Set([`${otherMachine} page-d`]));
  });

  it("names the chat only by a name the person gave it", () => {
    expect(waitingPromptToastText("Octo", "  Plan 3 days\nin Seville ")).toBe("Octo is waiting for your OK in “Plan 3 days in Seville”.");
    expect(waitingPromptToastText("Octo", null)).toBe("Octo is waiting for your OK in another chat.");
  });
});

// What Studio's layout does with what the watcher says.
describe("a waiting prompt in Studio's layout", () => {
  it("says Approve on the tab of the chat a prompt waits in, found by its controller id", () => {
    const tabs = [
      { id: "porto", conversationId: "local-a", controllerId: chatA.toUpperCase(), title: "Open visitporto.travel in your browser" },
      { id: "seville", conversationId: "local-b", controllerId: chatB, title: "Plan 3 days in Seville" },
      { id: "new", conversationId: "local-c", controllerId: null, title: "New chat" },
    ];
    expect(withChatsAwaitingOk(tabs, new Set([chatA])).map((tab) => [tab.id, tab.attention ?? false]))
      .toEqual([["porto", true], ["seville", false], ["new", false]]);
    // Nothing waits: the same tabs.
    expect(withChatsAwaitingOk(tabs, new Set())).toBe(tabs);
  });

  it("reads a job thread's chat here: a job thread's panel does not read its chat's prompts", () => {
    expect(chatReadingOwnPrompts("jobThread", chatA)).toBeNull();
    expect(chatReadingOwnPrompts("conversation", chatA)).toBe(chatA);
    expect(chatReadingOwnPrompts("panel", chatA)).toBe(chatA);
    expect(chatReadingOwnPrompts(undefined, null)).toBeNull();
  });

  it("opens the waiting chat on View with Chat in front of a file or a site, and keeps Browser in front", () => {
    const states = new Map<string, ConversationSurfaces>();
    const updateSurfaces = (scope: string | null, change: (state: ConversationSurfaces) => ConversationSurfaces) => {
      if (scope) states.set(scope, change(states.get(scope) ?? DEFAULT_CONVERSATION_SURFACES));
    };
    const navigate = vi.fn();
    // The scope chat A's own panel reads its views from.
    const scope = conversationSurfaceScope(me, project, "local-a")!;
    const view = () => openChatAwaitingOk({ userId: me, projectId: project, chat: { conversationId: chatA, localId: "local-a" }, updateSurfaces, navigate });

    states.set(scope, openConversationFile(DEFAULT_CONVERSATION_SURFACES, { id: "file:sites/porto/app.js", path: "sites/porto/app.js" }));
    view();
    expect(states.get(scope)?.activeId).toBe("chat");
    expect(navigate).toHaveBeenLastCalledWith({ kind: "conversation", projectId: project, conversationId: "local-a", conversationControllerId: chatA });

    states.set(scope, openConversationPreview(states.get(scope)!, { previewId: "preview-0001", title: "Livraria Lello · Porto" }));
    view();
    expect(states.get(scope)?.activeId).toBe("chat");

    states.set(scope, selectConversationView(states.get(scope)!, "browser"));
    view();
    expect(states.get(scope)?.activeId).toBe("browser");

    // A chat the list does not hold yet opens by its controller id alone.
    states.clear();
    openChatAwaitingOk({ userId: me, projectId: project, chat: { conversationId: chatD, localId: null }, updateSurfaces, navigate });
    expect(states.size).toBe(0);
    expect(navigate).toHaveBeenLastCalledWith({ kind: "conversation", projectId: project, conversationId: null, conversationControllerId: chatD });
  });
});
