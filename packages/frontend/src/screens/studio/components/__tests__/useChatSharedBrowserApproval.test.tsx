// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../../../../types";

const mocks = vi.hoisted(() => ({
  requestAccessToken: vi.fn(),
  fetchPendingApproval: vi.fn(),
  decideApproval: vi.fn(),
  fetchPages: vi.fn(),
  fetchHost: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: { origin: { requestAccessToken: mocks.requestAccessToken } },
    browserSessions: {
      fetchPendingApproval: mocks.fetchPendingApproval,
      decideApproval: mocks.decideApproval,
      fetchPages: mocks.fetchPages,
      fetchHost: mocks.fetchHost,
    },
  },
}));

import {
  CHAT_SHARED_BROWSER_APPROVAL_GRANT_RETRY_MS,
  useChatSharedBrowserApproval,
  type ChatSharedBrowserApproval,
} from "../useChatSharedBrowserApproval";

const userId = "55555555-5555-4555-8555-555555555555";
const runtimeId = "11111111-1111-4111-8111-111111111111";
const runId = "44444444-4444-4444-8444-444444444444";
const approvalId = "22222222-2222-4222-8222-222222222222";

function run(overrides: Partial<RunRecord> = {}, metadata: Record<string, unknown> = {}): RunRecord {
  return {
    id: runId, projectId: "project-1", sessionId: null, conversationId: "conversation-1", promptId: null,
    runType: "prompt", status: "in_progress", progress: 0, progressStage: null, previewUrl: null, lastMessage: null,
    metadata: { browserTransport: "shared", initiatingUserId: userId, browserRuntimeId: runtimeId, browserPageId: "page-of-the-job", ...metadata },
    createdAt: null, updatedAt: null, ...overrides,
  } as RunRecord;
}

function pendingFor(overrides: Record<string, unknown> = {}) {
  return {
    runtimeId,
    request: {
      version: 1 as const, approvalId: "22222222-2222-4222-8222-222222222222", kind: "action" as const,
      ownerId: "33333333-3333-4333-8333-333333333333", runId, initiatorUserId: userId, browserPageId: "page-of-the-job",
      operation: "click" as const, sourceOrigin: "https://app.example.test", destinationOrigin: "https://app.example.test",
      destinationFingerprint: "a".repeat(64), snapshotId: null, targetFingerprint: null, payloadFingerprint: null,
      requestedAtMs: Date.now(), expiresAtMs: Date.now() + 120_000, requestFingerprint: "e".repeat(64),
      display: { label: "Menü ein-/ausklappen", destinationOrigin: null },
      ...overrides,
    },
  };
}

let latest: ChatSharedBrowserApproval | null = null;
function Harness(props: { enabled?: boolean; runs: RunRecord[]; viewer?: string | null }) {
  latest = useChatSharedBrowserApproval({
    enabled: props.enabled ?? true,
    projectId: "project-1",
    userId: props.viewer === undefined ? userId : props.viewer,
    runs: props.runs,
    browserSessionId: "browser-surface-1",
  });
  return null;
}

describe("useChatSharedBrowserApproval", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    latest = null;
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.requestAccessToken.mockResolvedValue({ token: "approval-token", endpoint: "https://origin.example.test", expiresIn: 300 });
    mocks.fetchPendingApproval.mockResolvedValue(pendingFor());
    mocks.decideApproval.mockResolvedValue(true);
    mocks.fetchPages.mockRejectedValue(Object.assign(new Error("browser pages unavailable (503)"), { status: 503 }));
    mocks.fetchHost.mockRejectedValue(Object.assign(new Error("browser host unavailable (503)"), { status: 503 }));
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

  async function render(props: Parameters<typeof Harness>[0]) {
    await act(async () => { root.render(<Harness {...props} />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  }

  it("polls the job's own prompt with no browser view, and answers it", async () => {
    // Dogfood, Oct 24: the browser view was in error, its pages list empty,
    // so nothing polled and the run's prompt expired unseen.
    await render({ runs: [run()] });
    expect(mocks.requestAccessToken).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      protocol: "http",
      scopes: ["browser.view", "browser.control"],
      preferRuntime: runtimeId,
      browserSessionId: "browser-surface-1",
    }));
    expect(mocks.fetchPendingApproval).toHaveBeenCalledWith(expect.objectContaining({
      originEndpoint: "https://origin.example.test",
      originAccessToken: "approval-token",
      runtimeId,
      browserPageId: "page-of-the-job",
    }));
    expect(latest?.target?.runId).toBe(runId);
    expect(latest?.approval.pending?.request.approvalId).toBe(approvalId);
    await act(async () => { await latest!.approval.decide("allow_once", approvalId); });
    expect(mocks.decideApproval).toHaveBeenCalledWith(expect.objectContaining({
      originAccessToken: "approval-token",
      pending: expect.objectContaining({ runtimeId, request: expect.objectContaining({ approvalId: "22222222-2222-4222-8222-222222222222", runId }) }),
      decision: "allow_once",
    }));
    expect(latest?.approval.pending).toBeNull();
    expect(latest?.approval.lastDecision).toEqual({ approvalId: "22222222-2222-4222-8222-222222222222", decision: "allow_once" });
    // It never reads pages, the host or the picture.
    expect(mocks.fetchPages).not.toHaveBeenCalled();
    expect(mocks.fetchHost).not.toHaveBeenCalled();
  });

  it.each([
    ["it is turned off", { enabled: false, runs: [run()] }],
    ["no browser job runs", { runs: [run({}, { browserTransport: undefined })] }],
    ["a teammate started the run", { runs: [run()], viewer: "66666666-6666-4666-8666-666666666666" }],
  ])("asks for no grant and polls nothing when %s", async (_label, props) => {
    await render(props);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(mocks.requestAccessToken).not.toHaveBeenCalled();
    expect(mocks.fetchPendingApproval).not.toHaveBeenCalled();
    expect(latest?.target).toBeNull();
  });

  it("keeps another run's or another person's prompt out, and never answers it", async () => {
    mocks.fetchPendingApproval.mockResolvedValue(pendingFor({ runId: "99999999-9999-4999-8999-999999999999" }));
    await render({ runs: [run()] });
    expect(mocks.fetchPendingApproval).toHaveBeenCalled();
    expect(latest?.approval.pending).toBeNull();
    // Not even when asked for it by its own id: the lane holds it from its poll.
    await act(async () => { await latest!.approval.decide("allow_once", approvalId); });
    mocks.fetchPendingApproval.mockResolvedValue(pendingFor({ initiatorUserId: "66666666-6666-4666-8666-666666666666" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(latest?.approval.pending).toBeNull();
    await act(async () => { await latest!.approval.decide("allow_once", approvalId); });
    expect(mocks.decideApproval).not.toHaveBeenCalled();
  });

  it("never answers a prompt polled after the one on screen, even another run's", async () => {
    // A press lands between a poll and the render that would show its answer.
    await render({ runs: [run()] });
    expect(latest!.approval.pending?.request.approvalId).toBe(approvalId);
    const shownDecide = latest!.approval.decide;
    const otherRuns = pendingFor({ approvalId: "99999999-9999-4999-8999-999999999999", runId: "66666666-6666-4666-8666-666666666666",
      display: { label: "Delete invoice", destinationOrigin: null } });
    mocks.fetchPendingApproval.mockResolvedValue(otherRuns);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      await shownDecide("allow_once", approvalId);
    });
    expect(mocks.decideApproval).not.toHaveBeenCalled();
    expect(latest!.approval.pending).toBeNull();
    // A newer prompt of this run is answered only by a press for it.
    const newer = pendingFor({ approvalId: "88888888-8888-4888-8888-888888888888" });
    mocks.fetchPendingApproval.mockResolvedValue(newer);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
      await shownDecide("allow_once", approvalId);
    });
    expect(mocks.decideApproval).not.toHaveBeenCalled();
    await act(async () => { await latest!.approval.decide("allow_once", newer.request.approvalId); });
    expect(mocks.decideApproval).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pending: newer, decision: "allow_once" }));
  });

  it("asks for its grant again after a failure, and renews it before it expires", async () => {
    mocks.requestAccessToken.mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ token: "approval-token", endpoint: "https://origin.example.test", expiresIn: 300 });
    await render({ runs: [run()] });
    expect(mocks.fetchPendingApproval).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(CHAT_SHARED_BROWSER_APPROVAL_GRANT_RETRY_MS); });
    expect(mocks.requestAccessToken).toHaveBeenCalledTimes(2);
    expect(mocks.fetchPendingApproval).toHaveBeenCalled();
    // 300 s grant: renewed 30 s before it ends, with a fresh mint.
    await act(async () => { await vi.advanceTimersByTimeAsync(270_000); });
    expect(mocks.requestAccessToken).toHaveBeenCalledTimes(3);
    expect(mocks.requestAccessToken).toHaveBeenLastCalledWith(expect.objectContaining({ forceRefresh: true }));
  });

  it("stops polling once the run is no longer running", async () => {
    await render({ runs: [run()] });
    const polls = mocks.fetchPendingApproval.mock.calls.length;
    await render({ runs: [run({ status: "success" })] });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(mocks.fetchPendingApproval).toHaveBeenCalledTimes(polls);
    expect(latest?.target).toBeNull();
    expect(latest?.approval.pending).toBeNull();
  });
});
