// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchPendingApprovalMock, decideApprovalMock } = vi.hoisted(() => ({
  fetchPendingApprovalMock: vi.fn(),
  decideApprovalMock: vi.fn(),
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    browserSessions: {
      fetchPendingApproval: fetchPendingApprovalMock,
      decideApproval: decideApprovalMock,
    },
  },
}));

import { useSharedBrowserApproval } from "../useSharedBrowserApproval";

const pending = {
  runtimeId: "11111111-1111-4111-8111-111111111111",
  request: {
    version: 1 as const,
    approvalId: "22222222-2222-4222-8222-222222222222",
    kind: "action" as const,
    ownerId: "33333333-3333-4333-8333-333333333333",
    runId: "44444444-4444-4444-8444-444444444444",
    initiatorUserId: "55555555-5555-4555-8555-555555555555",
    browserPageId: "page-1",
    operation: "click" as const,
    sourceOrigin: "https://example.test",
    destinationOrigin: "https://example.test",
    destinationFingerprint: "a".repeat(64),
    snapshotId: "b".repeat(64),
    targetFingerprint: "c".repeat(64),
    payloadFingerprint: "d".repeat(64),
    requestedAtMs: 1_000,
    expiresAtMs: 31_000,
    requestFingerprint: "e".repeat(64),
    display: { label: "click Sign in", destinationOrigin: "https://example.test" },
  },
};

function Harness({
  active = true,
  browserSessionId = "browser-surface-1",
  runtimeId = pending.runtimeId,
  browserPageId = pending.request.browserPageId,
  originAccessToken = "origin-token",
}: {
  active?: boolean;
  browserSessionId?: string;
  runtimeId?: string;
  browserPageId?: string;
  originAccessToken?: string;
}) {
  const approval = useSharedBrowserApproval({
    active,
    projectId: "project-1",
    browserSessionId,
    runtimeId,
    browserPageId,
    originEndpoint: "https://origin.example.test",
    originAccessToken,
  });
  return (
    <div>
      <span data-testid="pending">{approval.pending?.request.approvalId ?? "none"}</span>
      <span data-testid="error">{approval.error ?? "none"}</span>
      <span data-testid="routine-run">{approval.routineApprovedRunId ?? "none"}</span>
      <span data-testid="submitting">{String(approval.submitting)}</span>
      <button type="button" onClick={() => void approval.decide("allow_once")}>
        Decide
      </button>
      <button data-testid="allow-routine" type="button" onClick={() => void approval.decide("allow_routine")}>
        Allow routine browsing
      </button>
    </div>
  );
}

describe("useSharedBrowserApproval", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    fetchPendingApprovalMock.mockReset();
    decideApprovalMock.mockReset();
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

  it("polls immediately, submits the exact pending request, and suppresses consumed flicker", async () => {
    fetchPendingApprovalMock.mockResolvedValue(pending);
    decideApprovalMock.mockResolvedValue(true);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe(
      pending.request.approvalId,
    );

    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(decideApprovalMock).toHaveBeenCalledWith(
      expect.objectContaining({ pending, decision: "allow_once" }),
    );
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("none");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(fetchPendingApprovalMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("none");
  });

  it("does not poll when the approval surface is inactive", async () => {
    await act(async () => {
      root.render(<Harness active={false} />);
      await Promise.resolve();
    });
    expect(fetchPendingApprovalMock).not.toHaveBeenCalled();
  });

  it("keeps the live request visible while polling reconnects after a network loss", async () => {
    fetchPendingApprovalMock
      .mockResolvedValueOnce(pending)
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(pending);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe(
      pending.request.approvalId,
    );
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe(
      "Approval connection interrupted. Reconnecting…",
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fetchPendingApprovalMock).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe(
      pending.request.approvalId,
    );
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe("none");
  });

  it("retains the exact request when a decision write fails and permits a safe retry", async () => {
    fetchPendingApprovalMock.mockResolvedValue(pending);
    decideApprovalMock
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(true);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      container.querySelector("button")?.click();
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe(
      pending.request.approvalId,
    );
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe(
      "Could not save the approval. Check your connection and try again.",
    );

    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(decideApprovalMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("none");
  });

  it("clears approval state when the mounted browser surface changes", async () => {
    fetchPendingApprovalMock
      .mockResolvedValueOnce(pending)
      .mockImplementation(() => new Promise(() => undefined));
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe(
      pending.request.approvalId,
    );

    await act(async () => {
      root.render(<Harness browserSessionId="browser-surface-2" />);
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("none");
    expect(fetchPendingApprovalMock).toHaveBeenCalledTimes(2);
  });

  it("shows the routine grant only after an accepted origin decision for its exact run", async () => {
    const originPending = { ...pending, request: { ...pending.request, kind: "origin" as const } };
    fetchPendingApprovalMock.mockResolvedValue(originPending);
    decideApprovalMock.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await act(async () => { root.render(<Harness />); });
    const routineButton = container.querySelector('[data-testid="allow-routine"]') as HTMLButtonElement;
    await act(async () => { routineButton.click(); });
    expect(container.querySelector('[data-testid="routine-run"]')?.textContent).toBe("none");
    await act(async () => { routineButton.click(); });
    expect(container.querySelector('[data-testid="routine-run"]')?.textContent).toBe(pending.request.runId);
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("none");
    await act(async () => { root.render(<Harness browserPageId="page-2" />); });
    expect(container.querySelector('[data-testid="routine-run"]')?.textContent).toBe("none");
  });

  it.each([
    { browserSessionId: "browser-surface-2" },
    { runtimeId: "runtime-2" },
    { browserPageId: "page-2" },
    { originAccessToken: "rotated-token" },
    { active: false },
  ])("ignores late accepted decisions after the scope changes: %j", async (changedScope) => {
    const originPending = { ...pending, request: { ...pending.request, kind: "origin" as const } };
    const nextPending = { ...pending, request: { ...pending.request, approvalId: "new-approval", runId: "new-run" } };
    fetchPendingApprovalMock.mockResolvedValueOnce(originPending).mockResolvedValue(nextPending);
    let resolveDecision!: (accepted: boolean) => void;
    decideApprovalMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveDecision = resolve; }));
    await act(async () => { root.render(<Harness />); });
    await act(async () => { (container.querySelector('[data-testid="allow-routine"]') as HTMLButtonElement).click(); });
    const signal = decideApprovalMock.mock.calls[0][0].signal as AbortSignal;
    await act(async () => { root.render(<Harness {...changedScope} />); });
    expect(signal.aborted).toBe(true);
    await act(async () => { resolveDecision(true); });
    expect(container.querySelector('[data-testid="routine-run"]')?.textContent).toBe("none");
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe(
      changedScope.active === false ? "none" : "new-approval",
    );
    expect(container.querySelector('[data-testid="submitting"]')?.textContent).toBe("false");
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe("none");
  });

  it("does not clear a newly polled approval when an earlier decision completes", async () => {
    const nextPending = { ...pending, request: { ...pending.request, approvalId: "next-approval" } };
    fetchPendingApprovalMock.mockResolvedValueOnce(pending).mockResolvedValue(nextPending);
    let resolveDecision!: (accepted: boolean) => void;
    decideApprovalMock.mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveDecision = resolve; }));
    await act(async () => { root.render(<Harness />); });
    await act(async () => { container.querySelector("button")?.click(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    await act(async () => { resolveDecision(true); });
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("next-approval");
    expect(container.querySelector('[data-testid="routine-run"]')?.textContent).toBe("none");
  });

  it("does not let a stale failure clear the new scope's submission or grant", async () => {
    const originPending = { ...pending, request: { ...pending.request, kind: "origin" as const } };
    const nextPending = { ...originPending, request: { ...originPending.request, approvalId: "next-approval", runId: "next-run" } };
    fetchPendingApprovalMock.mockResolvedValueOnce(originPending).mockResolvedValue(nextPending);
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (accepted: boolean) => void;
    decideApprovalMock
      .mockImplementationOnce(() => new Promise<boolean>((_resolve, reject) => { rejectOld = reject; }))
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { resolveNew = resolve; }));
    await act(async () => { root.render(<Harness />); });
    await act(async () => { (container.querySelector('[data-testid="allow-routine"]') as HTMLButtonElement).click(); });
    await act(async () => { root.render(<Harness browserSessionId="browser-surface-2" />); });
    await act(async () => { (container.querySelector('[data-testid="allow-routine"]') as HTMLButtonElement).click(); });
    await act(async () => { rejectOld(new Error("old request failed")); });
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("next-approval");
    expect(container.querySelector('[data-testid="submitting"]')?.textContent).toBe("true");
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe("none");
    await act(async () => { resolveNew(true); });
    expect(container.querySelector('[data-testid="routine-run"]')?.textContent).toBe("next-run");
    expect(container.querySelector('[data-testid="submitting"]')?.textContent).toBe("false");
  });
});
