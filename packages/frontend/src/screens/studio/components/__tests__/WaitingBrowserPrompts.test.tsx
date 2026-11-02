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

import { WaitingBrowserPrompts, waitingPromptToastText, type WaitingPromptChat } from "../WaitingBrowserPrompts";

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
    expect(options).toMatchObject({ actionLabel: "View", nonPreemptive: true });
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
    expect(waitingChats()).toEqual([]);

    // Nor for a prompt the origin hands back that is not the person's own run's.
    await render({ runs: [browserRun(runA, chatA)] });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(mocks.fetchPendingApproval).toHaveBeenCalled();
    expect(mocks.showStatus).not.toHaveBeenCalled();
    expect(waitingChats()).toEqual([]);
  });

  it("takes the toast and the tab's Approve away once the prompt is answered or runs out", async () => {
    mocks.fetchPendingApproval.mockResolvedValue(promptFor(runA));
    await render({ runs: [browserRun(runA, chatA)] });
    expect(mocks.showStatus).toHaveBeenCalledTimes(1);
    expect(waitingChats()).toEqual([chatA]);
    mocks.fetchPendingApproval.mockResolvedValue(null);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
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
