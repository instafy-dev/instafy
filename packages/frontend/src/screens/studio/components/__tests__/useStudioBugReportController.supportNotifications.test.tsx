// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerBugReportSummary } from "../../../../services/runtimeController/bugReports";
import { NOTIFICATION_RECEIVED_EVENT } from "../../../../notifications/notificationPresentation";

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
    reports: [] as ControllerBugReportSummary[],
    hasMore: false,
    nextCursor: null,
    unreadCount,
    unreadResolutionCount: unnotifiedResolutionCount,
    unnotifiedResolutionCount,
  };
}

function Harness({ userId, legacyResolutionToasts }: { userId: string | null; legacyResolutionToasts?: boolean }) {
  const support = useStudioBugReportController({
    currentUserId: userId,
    activeProjectId: null,
    activeConversationId: null,
    activeConversationLocalId: null,
    activeRuntimeId: null,
    controllerProjectMissing: false,
    buildLogs: [],
    legacyResolutionToasts,
  });
  return (
    <>
      <output data-testid="support-unread-count">{support.supportUnreadCount}</output>
      <output data-testid="support-unread-reports">{JSON.stringify(support.supportUnreadReports)}</output>
      <output data-testid="support-loading">{String(support.supportNotificationsLoading)}</output>
      <output data-testid="support-error">{support.supportNotificationsError}</output>
      <button onClick={() => void support.refreshSupportNotifications(false)}>Retry support</button>
      {support.dialogs}
    </>
  );
}

function unreadReport(overrides: Partial<ControllerBugReportSummary> = {}): ControllerBugReportSummary {
  return {
    id: REPORT_ID, message: "My tab cannot be dragged", createdAt: "2026-09-01T12:00:00Z", activityAt: "2026-09-06T12:00:00Z", updatedAt: null,
    projectId: null, status: "resolved", screenshotCount: 0, customerLastMessageAt: null,
    supportLastMessageAt: "2026-09-05T12:00:00Z", resolvedAt: "2026-09-06T12:00:00Z", hasUnreadResolution: true, hasUnreadSupportActivity: true,
    ...overrides,
  };
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

  it("publishes customer-safe unread summaries even when legacy resolution toasts are disabled", async () => {
    mocks.listReports.mockResolvedValue({ ...page(1, 1), reports: [unreadReport(), unreadReport({ id: "22222222-2222-4222-8222-222222222222", hasUnreadSupportActivity: false })] });
    await act(async () => root.render(<Harness userId="user-a" legacyResolutionToasts={false} />));
    await flushAsyncEffects();
    const reports = JSON.parse(container.querySelector('[data-testid="support-unread-reports"]')!.textContent!);
    expect(reports).toEqual([{
      id: REPORT_ID, title: "My tab cannot be dragged", projectId: null, activityAt: "2026-09-06T12:00:00Z",
      supportLastMessageAt: "2026-09-05T12:00:00Z", resolvedAt: "2026-09-06T12:00:00Z", hasUnreadResolution: true,
    }]);
    expect(mocks.claimResolutionAlerts).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="support-loading"]')?.textContent).toBe("false");
  });

  it("loads past the first page until all counted unread reports have a Home destination", async () => {
    const firstCursor = { activityAt: "2026-09-04T12:00:00Z", id: REPORT_ID };
    const secondId = "22222222-2222-4222-8222-222222222222";
    const secondCursor = { activityAt: "2026-09-02T12:00:00Z", id: secondId };
    mocks.listReports
      .mockResolvedValueOnce({ ...page(2, 0), reports: [unreadReport({ hasUnreadSupportActivity: false })], hasMore: true, nextCursor: firstCursor })
      .mockResolvedValueOnce({ ...page(2, 0), reports: [unreadReport()], hasMore: true, nextCursor: secondCursor })
      .mockResolvedValueOnce({ ...page(2, 0), reports: [unreadReport({ id: secondId })], hasMore: true, nextCursor: { activityAt: "2026-09-01T12:00:00Z", id: secondId } });
    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();
    expect(mocks.listReports).toHaveBeenNthCalledWith(2, 100, firstCursor, "user-a");
    expect(mocks.listReports).toHaveBeenNthCalledWith(3, 100, secondCursor, "user-a");
    expect(mocks.listReports).toHaveBeenCalledTimes(3);
    const reports = JSON.parse(container.querySelector('[data-testid="support-unread-reports"]')!.textContent!);
    expect(reports.map((report: { id: string }) => report.id)).toEqual([REPORT_ID, secondId]);
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("2");
  });

  it("abandons old-account pagination without exposing its summaries to the next account", async () => {
    let resolveOldPage!: (value: ReturnType<typeof page>) => void;
    const pending = new Promise<ReturnType<typeof page>>(resolve => { resolveOldPage = resolve; });
    mocks.listReports
      .mockResolvedValueOnce({ ...page(1, 0), hasMore: true, nextCursor: { activityAt: "2026-09-04T12:00:00Z", id: REPORT_ID } })
      .mockReturnValueOnce(pending)
      .mockResolvedValue(page(0, 0));
    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();
    expect(container.querySelector('[data-testid="support-loading"]')?.textContent).toBe("true");
    await act(async () => root.render(<Harness userId="user-b" />));
    await act(async () => resolveOldPage({ ...page(1, 0), reports: [unreadReport()] }));
    await flushAsyncEffects();
    expect(container.querySelector('[data-testid="support-unread-reports"]')?.textContent).toBe("[]");
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("0");
    expect(container.querySelector('[data-testid="support-loading"]')?.textContent).toBe("false");
    expect(mocks.listReports).toHaveBeenCalledTimes(3);
  });

  it("retains previous support rows on refresh failure and allows a quiet retry", async () => {
    mocks.listReports.mockResolvedValueOnce({ ...page(1, 0), reports: [unreadReport()] }).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(page(0, 0));
    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();
    await act(async () => window.dispatchEvent(new Event("focus")));
    await flushAsyncEffects();
    expect(container.querySelector('[data-testid="support-unread-reports"]')?.textContent).toContain(REPORT_ID);
    expect(container.querySelector('[data-testid="support-error"]')?.textContent).toContain("couldn’t be loaded");
    expect(container.querySelector('[data-testid="support-loading"]')?.textContent).toBe("false");
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    await flushAsyncEffects();
    expect(container.querySelector('[data-testid="support-unread-reports"]')?.textContent).toBe("[]");
    expect(container.querySelector('[data-testid="support-error"]')?.textContent).toBe("");
    expect(mocks.showStatus).not.toHaveBeenCalled();
  });

  it("refreshes source support read state immediately after Home or the report acknowledges durable activity", async () => {
    mocks.listReports.mockResolvedValueOnce({ ...page(1, 0), reports: [unreadReport()] }).mockResolvedValue(page(0, 1));
    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("1");
    await act(async () => window.dispatchEvent(new Event(NOTIFICATION_RECEIVED_EVENT)));
    await flushAsyncEffects();
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("0");
    expect(container.querySelector('[data-testid="support-unread-reports"]')?.textContent).toBe("[]");
    expect(mocks.claimResolutionAlerts).not.toHaveBeenCalled();
  });

  it("stops a repeated paging cursor and exposes a retry instead of looping forever", async () => {
    const repeating = { ...page(2, 0), reports: [], hasMore: true, nextCursor: { activityAt: "2026-09-04T12:00:00Z", id: REPORT_ID } };
    mocks.listReports.mockResolvedValue(repeating);
    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();
    expect(mocks.listReports).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="support-error"]')?.textContent).toContain("couldn’t be loaded");
    expect(container.querySelector('[data-testid="support-loading"]')?.textContent).toBe("false");
  });

  describe("polling gate", () => {
    function setVisibility(state: "visible" | "hidden") {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    }
    async function advance(ms: number) {
      await act(async () => { vi.advanceTimersByTime(ms); });
      await flushAsyncEffects();
    }
    beforeEach(() => {
      setVisibility("visible");
      window.dispatchEvent(new Event("pointerdown"));
      mocks.listReports.mockResolvedValue(page(0, 0));
    });
    afterEach(() => setVisibility("visible"));

    it("backs off to 120 s after 3 min without input", async () => {
      await act(async () => root.render(<Harness userId="user-a" />));
      await flushAsyncEffects();
      await advance(5_000);
      await act(async () => window.dispatchEvent(new Event("pointerdown")));
      await advance(180_000);
      expect(mocks.listReports).toHaveBeenCalledTimes(1 + 9);
      await advance(115_000);
      expect(mocks.listReports).toHaveBeenCalledTimes(10);
      await advance(5_000);
      expect(mocks.listReports).toHaveBeenCalledTimes(11);
    });

    it("stops polling while hidden and refreshes once when the tab is visible again", async () => {
      await act(async () => root.render(<Harness userId="user-a" />));
      await flushAsyncEffects();
      expect(mocks.listReports).toHaveBeenCalledTimes(1);
      await act(async () => setVisibility("hidden"));
      await advance(120_000);
      expect(mocks.listReports).toHaveBeenCalledTimes(1);
      await act(async () => setVisibility("visible"));
      await flushAsyncEffects();
      expect(mocks.listReports).toHaveBeenCalledTimes(2);
    });
  });
});
