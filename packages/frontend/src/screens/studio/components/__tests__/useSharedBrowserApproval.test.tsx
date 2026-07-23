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
}: {
  active?: boolean;
  browserSessionId?: string;
}) {
  const approval = useSharedBrowserApproval({
    active,
    projectId: "project-1",
    browserSessionId,
    runtimeId: pending.runtimeId,
    browserPageId: pending.request.browserPageId,
    originEndpoint: "https://origin.example.test",
    originAccessToken: "origin-token",
  });
  return (
    <div>
      <span data-testid="pending">{approval.pending?.request.approvalId ?? "none"}</span>
      <span data-testid="error">{approval.error ?? "none"}</span>
      <button type="button" onClick={() => void approval.decide("allow_once")}>
        Decide
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
});
