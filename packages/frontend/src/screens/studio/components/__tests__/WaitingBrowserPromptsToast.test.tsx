// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Status } from "../../../../status/Status";
import { StatusProvider, type StatusContextValue } from "../../../../status/StatusProvider";
import { useStatus } from "../../../../status/useStatus";
import type { RunRecord } from "../../../../types";

const mocks = vi.hoisted(() => ({
  requestAccessToken: vi.fn(),
  fetchPendingApproval: vi.fn(),
  decideApproval: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: { origin: { requestAccessToken: mocks.requestAccessToken } },
    browserSessions: { fetchPendingApproval: mocks.fetchPendingApproval, decideApproval: mocks.decideApproval },
  },
}));

import { WaitingBrowserPrompts, type WaitingPromptChat } from "../WaitingBrowserPrompts";

const me = "55555555-5555-4555-8555-555555555555";
const project = "77777777-7777-4777-8777-777777777777";
const machine = "11111111-1111-4111-8111-111111111111";
const chatA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const chatB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const runA = "44444444-4444-4444-8444-44444444444a";
const approvalId = "22222222-2222-4222-8222-222222222222";
const WAITING = "Octo is waiting for your OK in “Open visitporto.travel in your browser”.";

const chats: WaitingPromptChat[] = [
  { localId: "local-a", controllerId: chatA, title: "Open visitporto.travel in your browser" },
  { localId: "local-b", controllerId: chatB, title: "Plan 3 days in Seville" },
];

function browserRun(): RunRecord {
  const now = new Date().toISOString();
  return {
    id: runA, projectId: project, sessionId: null, conversationId: chatA, promptId: null, runType: "prompt",
    status: "in_progress", progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
    metadata: { browserTransport: "shared", initiatingUserId: me, browserRuntimeId: machine, browserPageId: "page-a" },
    createdAt: now, updatedAt: now,
  } as RunRecord;
}

function waitingPrompt() {
  return {
    runtimeId: machine,
    request: {
      version: 1 as const, approvalId, kind: "action" as const, ownerId: "33333333-3333-4333-8333-333333333333", runId: runA,
      initiatorUserId: me, browserPageId: "page-a", operation: "click" as const,
      sourceOrigin: "https://en.metrodoporto.pt", destinationOrigin: "https://en.metrodoporto.pt",
      destinationFingerprint: "a".repeat(64), snapshotId: null, targetFingerprint: null, payloadFingerprint: null,
      requestedAtMs: Date.now(), expiresAtMs: Date.now() + 120_000, requestFingerprint: "e".repeat(64),
      display: { label: "Edit", destinationOrigin: "https://en.metrodoporto.pt" },
    },
  };
}

let status: StatusContextValue | null = null;

function Studio() {
  status = useStatus();
  return (
    <>
      <WaitingBrowserPrompts
        enabled
        userId={me}
        projectId={project}
        runs={{ [runA]: browserRun() }}
        chats={chats}
        chatOnScreen={chatB}
        onView={() => {}}
        onWaitingChange={() => {}}
      />
      <Status />
    </>
  );
}

// The toast is the only thing on a phone's chat screen that says another chat
// waits for the person's OK: the closed chat switcher shows only this chat.
describe("the waiting-prompt toast, with Studio's own toasts", () => {
  let container: HTMLDivElement;
  let root: Root;
  const toasts = () => [...document.querySelectorAll('[data-testid="status-toast"]')].map((toast) => toast.textContent ?? "");

  beforeEach(async () => {
    vi.useFakeTimers();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.requestAccessToken.mockResolvedValue({ token: "view-token", endpoint: "https://origin.example.test", expiresIn: 300 });
    mocks.fetchPendingApproval.mockImplementation(async () => waitingPrompt());
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    status = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<StatusProvider><Studio /></StatusProvider>));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.replaceChildren();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  // "Copied message." or an error in the chat on screen closed the waiting
  // toast for good, while the prompt still waited: it then ran out unseen.
  it("comes back once a toast that replaced it closes, while the prompt still waits", async () => {
    expect(toasts()).toEqual([`${WAITING}View`]);
    await act(async () => status!.showStatus("Copied message.", "success", 2_000, { presentation: "confirmation" }));
    expect(toasts()).toEqual(["Copied message."]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
    expect(toasts()).toEqual([`${WAITING}View`]);

    // An error the person has to close first: the waiting toast is back after it.
    await act(async () => status!.showStatus("Couldn't copy that message.", "error", 0));
    expect(toasts()).toEqual(["Couldn't copy that message."]);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(toasts()).toEqual(["Couldn't copy that message."]);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.click());
    expect(toasts()).toEqual([`${WAITING}View`]);
    // Nothing here answers the prompt.
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("stays closed once the person closes it, and goes when the prompt does", async () => {
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Dismiss notification"]')!.click());
    expect(toasts()).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(toasts()).toEqual([]);
  });

  it("goes when the prompt is answered while another toast shows", async () => {
    await act(async () => status!.showStatus("Copied message.", "success", 2_000, { presentation: "confirmation" }));
    mocks.fetchPendingApproval.mockImplementation(async () => null);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(toasts()).toEqual([]);
  });
});
