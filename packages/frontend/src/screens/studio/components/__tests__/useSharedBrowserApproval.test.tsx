// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeSharedBrowserApprovalRequest } from "../../../../sdk/instafy";

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

import {
  APPROVAL_INTERRUPTED_GRACE_MS,
  APPROVAL_INTERRUPTED_MESSAGE,
  useSharedBrowserApproval,
  type SharedBrowserApprovalState,
} from "../useSharedBrowserApproval";

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

let latestApproval: SharedBrowserApprovalState | null = null;

function Harness({
  active = true,
  browserSessionId = "browser-surface-1",
  runtimeId = pending.runtimeId,
  browserPageId = pending.request.browserPageId,
  originAccessToken = "origin-token",
  accepts,
}: {
  active?: boolean;
  browserSessionId?: string;
  runtimeId?: string;
  browserPageId?: string;
  originAccessToken?: string;
  accepts?: (request: RuntimeSharedBrowserApprovalRequest) => boolean;
}) {
  const approval = useSharedBrowserApproval({
    active,
    projectId: "project-1",
    browserSessionId,
    runtimeId,
    browserPageId,
    originEndpoint: "https://origin.example.test",
    originAccessToken,
    acceptsRequest: accepts,
  });
  latestApproval = approval;
  const shownApprovalId = approval.pending?.request.approvalId ?? "";
  return (
    <div>
      <span data-testid="pending">{approval.pending?.request.approvalId ?? "none"}</span>
      <span data-testid="error">{approval.error ?? "none"}</span>
      <span data-testid="routine-run">{approval.routineApprovedRunId ?? "none"}</span>
      <span data-testid="submitting">{String(approval.submitting)}</span>
      <span data-testid="last-decision">
        {approval.lastDecision ? `${approval.lastDecision.approvalId}:${approval.lastDecision.decision}` : "none"}
      </span>
      <button type="button" onClick={() => void approval.decide("allow_once", shownApprovalId)}>
        Decide
      </button>
      <button data-testid="allow-routine" type="button" onClick={() => void approval.decide("allow_routine", shownApprovalId)}>
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
    latestApproval = null;
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

  it("remembers the decision the origin accepted, for every surface that shows the prompt", async () => {
    fetchPendingApprovalMock.mockResolvedValue(pending);
    decideApprovalMock.mockResolvedValueOnce(false).mockResolvedValue(true);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    const lastDecision = () => container.querySelector('[data-testid="last-decision"]')?.textContent;
    expect(lastDecision()).toBe("none");
    // A refused decision is not one.
    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(lastDecision()).toBe("none");
    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
    });
    expect(lastDecision()).toBe(`${pending.request.approvalId}:allow_once`);
    // A new grant starts over.
    await act(async () => {
      root.render(<Harness originAccessToken="rotated-token" />);
      await Promise.resolve();
    });
    expect(lastDecision()).toBe("none");
  });

  // Local test, Oct 31: another chat's prompt, with Deny and Allow, showed in
  // a chat's Browser view. A lane whose caller keeps only its own prompts
  // never holds another: it is not shown, not answered, and the lane reads at
  // the pace of no prompt.
  it("holds, shows and answers only the prompts its caller accepts", async () => {
    const otherTabs = { ...pending, request: { ...pending.request, approvalId: "other-approval", browserPageId: "page-2" } };
    fetchPendingApprovalMock.mockResolvedValue(otherTabs);
    decideApprovalMock.mockResolvedValue(true);
    const shown = () => container.querySelector('[data-testid="pending"]')?.textContent;
    await act(async () => { root.render(<Harness accepts={(request) => request.browserPageId === "page-1"} />); });
    expect(fetchPendingApprovalMock).toHaveBeenCalledTimes(1);
    expect(shown()).toBe("none");
    await act(async () => { await latestApproval!.decide("allow_once", "other-approval"); });
    expect(decideApprovalMock).not.toHaveBeenCalled();
    // The next read comes at the run's 1.5 s, not the 400 ms of a shown prompt.
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    expect(fetchPendingApprovalMock).toHaveBeenCalledTimes(1);
    fetchPendingApprovalMock.mockResolvedValue(pending);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_100); });
    expect(fetchPendingApprovalMock).toHaveBeenCalledTimes(2);
    expect(shown()).toBe(pending.request.approvalId);
    // What the caller accepts changes: the prompt goes at once, before the
    // next read, and a press can no longer answer it.
    await act(async () => { root.render(<Harness accepts={() => false} />); });
    expect(fetchPendingApprovalMock).toHaveBeenCalledTimes(2);
    expect(shown()).toBe("none");
    await act(async () => { await latestApproval!.decide("allow_once", pending.request.approvalId); });
    expect(decideApprovalMock).not.toHaveBeenCalled();
  });

  it("does not poll when the approval surface is inactive", async () => {
    await act(async () => {
      root.render(<Harness active={false} />);
      await Promise.resolve();
    });
    expect(fetchPendingApprovalMock).not.toHaveBeenCalled();
  });

  it("keeps the live request visible, and quiet, through one failed read", async () => {
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
    expect(fetchPendingApprovalMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe(
      pending.request.approvalId,
    );
    // One failed read between good ones says nothing.
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe("none");

    // The read after a failure waits twice as long.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fetchPendingApprovalMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fetchPendingApprovalMock).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe(
      pending.request.approvalId,
    );
    expect(container.querySelector('[data-testid="error"]')?.textContent).toBe("none");
  });

  it("says the connection was interrupted only once reads keep failing, backing off, and clears it on the next good read", async () => {
    let failing = true;
    fetchPendingApprovalMock.mockImplementation(async () => {
      if (fetchPendingApprovalMock.mock.calls.length === 1) return pending;
      if (failing) throw new TypeError("network unavailable");
      return pending;
    });
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    const error = () => container.querySelector('[data-testid="error"]')?.textContent;
    const readTimes: number[] = [];
    for (let elapsed = 0; elapsed < 8_000; elapsed += 100) {
      const before = fetchPendingApprovalMock.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      if (fetchPendingApprovalMock.mock.calls.length > before) readTimes.push(elapsed + 100);
      if (elapsed + 100 < APPROVAL_INTERRUPTED_GRACE_MS) expect(error()).toBe("none");
    }
    // 400 ms after the good read, then 800, 1.6 s and 3.2 s after each failure.
    expect(readTimes).toEqual([400, 1_200, 2_800, 6_000]);
    expect(error()).toBe(APPROVAL_INTERRUPTED_MESSAGE);
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe(
      pending.request.approvalId,
    );
    failing = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_400);
    });
    expect(error()).toBe("none");
  });

  it("does not read again at once when its lane stops and starts again a moment later", async () => {
    fetchPendingApprovalMock.mockResolvedValue(null);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(fetchPendingApprovalMock).toHaveBeenCalledTimes(1);
    // The lane flips off and on twenty times within 200 ms (Oct 28: the tab
    // under it came and went ten times a second).
    for (let flip = 0; flip < 20; flip += 1) {
      await act(async () => {
        root.render(<Harness active={flip % 2 === 0 ? false : true} />);
        await vi.advanceTimersByTimeAsync(10);
      });
    }
    expect(fetchPendingApprovalMock.mock.calls.length).toBeLessThanOrEqual(2);
    // A new lane (another page) still reads at once.
    const reads = fetchPendingApprovalMock.mock.calls.length;
    await act(async () => {
      root.render(<Harness browserPageId="page-2" />);
      await Promise.resolve();
    });
    expect(fetchPendingApprovalMock.mock.calls.length).toBe(reads + 1);
  });

  it("reads at most once per gap while its page keeps changing between two tabs", async () => {
    fetchPendingApprovalMock.mockResolvedValue(null);
    await act(async () => {
      root.render(<Harness />);
      await Promise.resolve();
    });
    expect(fetchPendingApprovalMock).toHaveBeenCalledTimes(1);
    // The active tab under the lane changes back and forth every 10 ms for a
    // second: each change is a new page, but not a read per change.
    for (let flip = 0; flip < 100; flip += 1) {
      await act(async () => {
        root.render(<Harness browserPageId={flip % 2 === 0 ? "page-2" : "page-1"} />);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
    }
    expect(fetchPendingApprovalMock.mock.calls.length).toBeLessThanOrEqual(1 + Math.ceil(1_000 / 400));
    // The page that stays is read within the gap.
    const reads = fetchPendingApprovalMock.mock.calls.length;
    await act(async () => {
      root.render(<Harness browserPageId="page-2" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(fetchPendingApprovalMock.mock.calls.length).toBe(reads + 1);
    expect(fetchPendingApprovalMock.mock.calls.at(-1)?.[0]).toMatchObject({ browserPageId: "page-2" });
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

  it("answers only the prompt that was shown, not one polled since", async () => {
    // The poll updates what the lane holds before the next render shows it.
    const nextPending = { ...pending, request: { ...pending.request, approvalId: "next-approval" } };
    fetchPendingApprovalMock.mockResolvedValueOnce(pending).mockResolvedValue(nextPending);
    decideApprovalMock.mockResolvedValue(true);
    await act(async () => { root.render(<Harness />); });
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe(pending.request.approvalId);
    const shown = latestApproval!;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
      await shown.decide("allow_once", pending.request.approvalId);
    });
    expect(decideApprovalMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="pending"]')?.textContent).toBe("next-approval");
    expect(container.querySelector('[data-testid="last-decision"]')?.textContent).toBe("none");
    await act(async () => { await latestApproval!.decide("allow_once", "next-approval"); });
    expect(decideApprovalMock).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ pending: nextPending, decision: "allow_once" }),
    );
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
