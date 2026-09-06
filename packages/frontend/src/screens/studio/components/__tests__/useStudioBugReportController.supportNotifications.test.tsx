// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimResolutionAlerts: vi.fn(),
  hideStatus: vi.fn(),
  listReports: vi.fn(),
  showStatus: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    bugReports: {
      claimResolutionAlerts: mocks.claimResolutionAlerts,
      listPage: mocks.listReports,
    },
  },
}));
vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ hideStatus: mocks.hideStatus, showStatus: mocks.showStatus }),
}));
vi.mock("../../../../debug/useAppLogs", () => ({
  useAppLogs: () => ({ logs: [] }),
}));
vi.mock("../BugReportDialog", () => ({
  BugReportDialog: () => null,
}));
vi.mock("../BugReportInboxDialog", () => ({
  BugReportInboxDialog: ({
    initialReportRequest,
    isOpen,
  }: {
    initialReportRequest?: { reportId: string } | null;
    isOpen: boolean;
  }) =>
    isOpen ? (
      <div data-testid="mock-support-inbox" data-report-id={initialReportRequest?.reportId ?? ""} />
    ) : null,
}));
vi.mock("../shakeReportPreference", () => ({
  getStoredShakeReportEnabled: () => false,
  setStoredShakeReportEnabled: vi.fn(),
}));
vi.mock("../useShakeToReport", () => ({
  NATIVE_SHAKE_REPORT_EVENT: "instafy:test-shake",
  useShakeToReport: () => undefined,
}));

import { useStudioBugReportController } from "../useStudioBugReportController";

const REPORT_ID = "11111111-1111-4111-8111-111111111111";

function page(unreadCount: number, unnotifiedResolutionCount: number) {
  return {
    reports: [],
    hasMore: false,
    nextCursor: null,
    unreadCount,
    unreadResolutionCount: unnotifiedResolutionCount,
    unnotifiedResolutionCount,
  };
}

function Harness({ userId }: { userId: string | null }) {
  const support = useStudioBugReportController({
    currentUserId: userId,
    activeProjectId: null,
    activeConversationId: null,
    activeConversationLocalId: null,
    activeRuntimeId: null,
    controllerProjectMissing: false,
    buildLogs: [],
  });
  return (
    <>
      <output data-testid="support-unread-count">{support.supportUnreadCount}</output>
      {support.dialogs}
    </>
  );
}

async function flushAsyncEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useStudioBugReportController support notifications", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.claimResolutionAlerts.mockReset();
    mocks.hideStatus.mockReset();
    mocks.listReports.mockReset();
    mocks.showStatus.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("polls while visible, claims once, and opens the resolved report from the toast", async () => {
    mocks.listReports
      .mockResolvedValueOnce(page(2, 1))
      .mockResolvedValue(page(2, 0));
    mocks.claimResolutionAlerts.mockResolvedValue({
      claimedCount: 1,
      latestReportId: REPORT_ID,
      latestResolvedAt: "2026-09-05T12:00:00Z",
    });

    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();

    expect(mocks.listReports).toHaveBeenCalledWith(100, null, "user-a");
    expect(mocks.claimResolutionAlerts).toHaveBeenCalledWith("user-a");
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("2");
    expect(mocks.showStatus).toHaveBeenCalledWith(
      "Your Instafy support report was resolved.",
      "success",
      12_000,
      expect.objectContaining({ actionLabel: "View report" }),
    );

    const toastOptions = mocks.showStatus.mock.calls[0]?.[3] as { onAction: () => void };
    await act(async () => toastOptions.onAction());
    expect(
      container.querySelector('[data-testid="mock-support-inbox"]')?.getAttribute("data-report-id"),
    ).toBe(REPORT_ID);

    await act(async () => vi.advanceTimersByTime(20_000));
    await flushAsyncEffects();
    expect(mocks.listReports).toHaveBeenCalledTimes(2);
    expect(mocks.claimResolutionAlerts).toHaveBeenCalledTimes(1);
  });

  it("does not toast when another tab won the server claim", async () => {
    mocks.listReports.mockResolvedValue(page(1, 1));
    mocks.claimResolutionAlerts.mockResolvedValue({
      claimedCount: 0,
      latestReportId: null,
      latestResolvedAt: null,
    });

    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();

    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("1");
    expect(mocks.showStatus).not.toHaveBeenCalled();
  });

  it("pins a pending resolution claim to the account that observed it", async () => {
    let resolveClaim!: (value: {
      claimedCount: number;
      latestReportId: string | null;
      latestResolvedAt: string | null;
    }) => void;
    const pendingClaim = new Promise<{
      claimedCount: number;
      latestReportId: string | null;
      latestResolvedAt: string | null;
    }>((resolve) => {
      resolveClaim = resolve;
    });
    mocks.listReports.mockResolvedValueOnce(page(1, 1)).mockResolvedValue(page(0, 0));
    mocks.claimResolutionAlerts.mockReturnValue(pendingClaim);

    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();
    expect(mocks.claimResolutionAlerts).toHaveBeenCalledWith("user-a");

    await act(async () => root.render(<Harness userId="user-b" />));
    await act(async () => {
      resolveClaim({
        claimedCount: 1,
        latestReportId: REPORT_ID,
        latestResolvedAt: "2026-09-05T12:00:00Z",
      });
      await pendingClaim;
    });
    await flushAsyncEffects();

    expect(mocks.claimResolutionAlerts).toHaveBeenCalledTimes(1);
    expect(mocks.showStatus).not.toHaveBeenCalled();
  });

  it("clears account-scoped UI immediately and disables an old toast action on identity change", async () => {
    let resolveUserB!: (value: ReturnType<typeof page>) => void;
    const userBPage = new Promise<ReturnType<typeof page>>((resolve) => {
      resolveUserB = resolve;
    });
    mocks.listReports
      .mockResolvedValueOnce(page(4, 1))
      .mockReturnValueOnce(userBPage);
    mocks.claimResolutionAlerts.mockResolvedValue({
      claimedCount: 1,
      latestReportId: REPORT_ID,
      latestResolvedAt: "2026-09-05T12:00:00Z",
    });

    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();
    const toastOptions = mocks.showStatus.mock.calls[0]?.[3] as { id: string; onAction: () => void };

    await act(async () => root.render(<Harness userId="user-b" />));
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("0");
    expect(container.querySelector('[data-testid="mock-support-inbox"]')).toBeNull();
    expect(mocks.hideStatus).toHaveBeenCalledWith(toastOptions.id);

    await act(async () => toastOptions.onAction());
    expect(container.querySelector('[data-testid="mock-support-inbox"]')).toBeNull();

    await act(async () => {
      resolveUserB(page(1, 0));
      await userBPage;
    });
    await flushAsyncEffects();
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("1");
  });
});
