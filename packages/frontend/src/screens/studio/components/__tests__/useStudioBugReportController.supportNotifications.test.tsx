// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerBugReportSummary } from "../../../../services/runtimeController/bugReports";
import { NOTIFICATION_RECEIVED_EVENT } from "../../../../notifications/notificationPresentation";
import { NOTIFICATION_FEED_CHANGED_EVENT } from "../../../../notifications/notificationFeedEvents";

const mocks = vi.hoisted(() => ({
  listReports: vi.fn(),
  showStatus: vi.fn(),
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false },
}));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    bugReports: {
      listPage: mocks.listReports,
    },
  },
}));
vi.mock("../../../../status/useStatus", () => ({
  useStatus: () => ({ showStatus: mocks.showStatus }),
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
    initialReportRequest?: { reportId: string; requestKey: number } | null;
    isOpen: boolean;
  }) =>
    isOpen ? (
      <div
        data-testid="mock-support-inbox"
        data-report-id={initialReportRequest?.reportId ?? ""}
        data-request-key={initialReportRequest?.requestKey ?? ""}
      />
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

function page(unreadCount: number, unreadResolutionCount = 0) {
  return {
    reports: [] as ControllerBugReportSummary[],
    hasMore: false,
    nextCursor: null,
    unreadCount,
    unreadResolutionCount,
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
  });
  return (
    <>
      <output data-testid="support-unread-count">{support.supportUnreadCount}</output>
      <output data-testid="support-unread-reports">{JSON.stringify(support.supportUnreadReports)}</output>
      <output data-testid="support-loading">{String(support.supportNotificationsLoading)}</output>
      <output data-testid="support-error">{support.supportNotificationsError}</output>
      <button onClick={() => void support.refreshSupportNotifications()}>Retry support</button>
      <button onClick={() => support.onOpenBugReportInbox(REPORT_ID)}>Open report</button>
      <button onClick={() => support.onOpenBugReportInbox()}>Open support</button>
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
    mocks.listReports.mockReset();
    mocks.showStatus.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("polls while visible and counts a resolution without a toast", async () => {
    // One report has an unread reply, the other was resolved and not seen yet.
    mocks.listReports.mockResolvedValue({
      ...page(2, 1),
      reports: [
        unreadReport({ id: "22222222-2222-4222-8222-222222222222", status: "waiting_for_customer", resolvedAt: null, hasUnreadResolution: false }),
        unreadReport(),
      ],
    });

    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();

    expect(mocks.listReports).toHaveBeenCalledWith(100, null, "user-a");
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("2");
    const reports = JSON.parse(container.querySelector('[data-testid="support-unread-reports"]')!.textContent!);
    expect(reports.find((report: { id: string }) => report.id === REPORT_ID)?.hasUnreadResolution).toBe(true);

    await act(async () => window.dispatchEvent(new Event(NOTIFICATION_FEED_CHANGED_EVENT)));
    await flushAsyncEffects();
    expect(mocks.listReports).toHaveBeenCalledTimes(2);
    expect(mocks.showStatus).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="mock-support-inbox"]')).toBeNull();
  });

  it("opens the inbox at a requested report for the account that asked", async () => {
    mocks.listReports.mockResolvedValue(page(0));
    const inbox = () => container.querySelector('[data-testid="mock-support-inbox"]');
    const press = (name: string) => act(async () => {
      Array.from(container.querySelectorAll("button")).find((button) => button.textContent === name)!.click();
    });
    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();

    // A notification, a support link and Home open a given report.
    await press("Open report");
    expect(inbox()?.getAttribute("data-report-id")).toBe(REPORT_ID);
    const firstRequestKey = inbox()?.getAttribute("data-request-key");
    // Asking for the same report again is a new request, so the inbox reloads it.
    await press("Open report");
    expect(inbox()?.getAttribute("data-request-key")).not.toBe(firstRequestKey);
    // A plain open drops the earlier target.
    await press("Open support");
    expect(inbox()?.getAttribute("data-report-id")).toBe("");

    // The open inbox belongs to one account: another account starts with it closed.
    await press("Open report");
    await act(async () => root.render(<Harness userId="user-b" />));
    expect(inbox()).toBeNull();
    await press("Open support");
    expect(inbox()?.getAttribute("data-report-id")).toBe("");
  });

  it("clears account-scoped UI immediately on identity change", async () => {
    let resolveUserB!: (value: ReturnType<typeof page>) => void;
    const userBPage = new Promise<ReturnType<typeof page>>((resolve) => {
      resolveUserB = resolve;
    });
    mocks.listReports
      .mockResolvedValueOnce(page(4))
      .mockReturnValueOnce(userBPage);

    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("4");

    await act(async () => root.render(<Harness userId="user-b" />));
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("0");
    expect(container.querySelector('[data-testid="mock-support-inbox"]')).toBeNull();

    await act(async () => {
      resolveUserB(page(1));
      await userBPage;
    });
    await flushAsyncEffects();
    expect(mocks.listReports).toHaveBeenLastCalledWith(100, null, "user-b");
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("1");
  });

  it("publishes customer-safe unread summaries", async () => {
    mocks.listReports.mockResolvedValue({ ...page(1), reports: [unreadReport(), unreadReport({ id: "22222222-2222-4222-8222-222222222222", hasUnreadSupportActivity: false })] });
    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();
    const reports = JSON.parse(container.querySelector('[data-testid="support-unread-reports"]')!.textContent!);
    expect(reports).toEqual([{
      id: REPORT_ID, title: "My tab cannot be dragged", projectId: null, activityAt: "2026-09-06T12:00:00Z",
      supportLastMessageAt: "2026-09-05T12:00:00Z", resolvedAt: "2026-09-06T12:00:00Z", hasUnreadResolution: true,
    }]);
    expect(container.querySelector('[data-testid="support-loading"]')?.textContent).toBe("false");
  });

  it("loads past the first page until all counted unread reports have a Home destination", async () => {
    const firstCursor = { activityAt: "2026-09-04T12:00:00Z", id: REPORT_ID };
    const secondId = "22222222-2222-4222-8222-222222222222";
    const secondCursor = { activityAt: "2026-09-02T12:00:00Z", id: secondId };
    mocks.listReports
      .mockResolvedValueOnce({ ...page(2), reports: [unreadReport({ hasUnreadSupportActivity: false })], hasMore: true, nextCursor: firstCursor })
      .mockResolvedValueOnce({ ...page(2), reports: [unreadReport()], hasMore: true, nextCursor: secondCursor })
      .mockResolvedValueOnce({ ...page(2), reports: [unreadReport({ id: secondId })], hasMore: true, nextCursor: { activityAt: "2026-09-01T12:00:00Z", id: secondId } });
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
      .mockResolvedValueOnce({ ...page(1), hasMore: true, nextCursor: { activityAt: "2026-09-04T12:00:00Z", id: REPORT_ID } })
      .mockReturnValueOnce(pending)
      .mockResolvedValue(page(0));
    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();
    expect(container.querySelector('[data-testid="support-loading"]')?.textContent).toBe("true");
    await act(async () => root.render(<Harness userId="user-b" />));
    await act(async () => resolveOldPage({ ...page(1), reports: [unreadReport()] }));
    await flushAsyncEffects();
    expect(container.querySelector('[data-testid="support-unread-reports"]')?.textContent).toBe("[]");
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("0");
    expect(container.querySelector('[data-testid="support-loading"]')?.textContent).toBe("false");
    expect(mocks.listReports).toHaveBeenCalledTimes(3);
  });

  it("retains previous support rows on refresh failure and allows a quiet retry", async () => {
    mocks.listReports.mockResolvedValueOnce({ ...page(1), reports: [unreadReport()] }).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(page(0));
    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();
    await act(async () => window.dispatchEvent(new Event(NOTIFICATION_FEED_CHANGED_EVENT)));
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
    mocks.listReports.mockResolvedValueOnce({ ...page(1), reports: [unreadReport()] }).mockResolvedValue(page(0));
    await act(async () => root.render(<Harness userId="user-a" />));
    await flushAsyncEffects();
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("1");
    await act(async () => window.dispatchEvent(new Event(NOTIFICATION_RECEIVED_EVENT)));
    await flushAsyncEffects();
    expect(container.querySelector('[data-testid="support-unread-count"]')?.textContent).toBe("0");
    expect(container.querySelector('[data-testid="support-unread-reports"]')?.textContent).toBe("[]");
    expect(mocks.showStatus).not.toHaveBeenCalled();
  });

  it("stops a repeated paging cursor and exposes a retry instead of looping forever", async () => {
    const repeating = { ...page(2), reports: [], hasMore: true, nextCursor: { activityAt: "2026-09-04T12:00:00Z", id: REPORT_ID } };
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
      mocks.listReports.mockResolvedValue(page(0));
    });
    afterEach(() => setVisibility("visible"));

    it("falls back to one read every 5 min while active and every 15 min once idle", async () => {
      await act(async () => root.render(<Harness userId="user-a" />));
      await flushAsyncEffects();
      await advance(299_999);
      expect(mocks.listReports).toHaveBeenCalledTimes(1);
      // Three minutes without input already moved the next read to 15 min.
      await advance(1);
      expect(mocks.listReports).toHaveBeenCalledTimes(1);
      await advance(600_000);
      expect(mocks.listReports).toHaveBeenCalledTimes(2);
      // Someone keeps using the tab: one read 5 min after the last.
      for (let step = 0; step < 3; step += 1) {
        await act(async () => window.dispatchEvent(new Event("pointerdown")));
        await advance(99_999);
      }
      expect(mocks.listReports).toHaveBeenCalledTimes(2);
      await advance(3);
      expect(mocks.listReports).toHaveBeenCalledTimes(3);
    });

    it("refreshes when the notification feed changes instead of on a fast timer", async () => {
      await act(async () => root.render(<Harness userId="user-a" />));
      await flushAsyncEffects();
      await advance(60_000);
      expect(mocks.listReports).toHaveBeenCalledTimes(1);
      await act(async () => window.dispatchEvent(new Event(NOTIFICATION_FEED_CHANGED_EVENT)));
      await flushAsyncEffects();
      expect(mocks.listReports).toHaveBeenCalledTimes(2);
    });

    it("leaves a quick visibility or focus return to the notification feed", async () => {
      await act(async () => root.render(<Harness userId="user-a" />));
      await flushAsyncEffects();
      for (let flip = 0; flip < 14; flip += 1) {
        await act(async () => setVisibility("hidden"));
        await advance(2_300);
        await act(async () => setVisibility("visible"));
        await act(async () => window.dispatchEvent(new Event("focus")));
        await advance(2_300);
      }
      expect(mocks.listReports).toHaveBeenCalledTimes(1);
    });

    it("stops polling while hidden and refreshes once when the tab comes back after a due read", async () => {
      await act(async () => root.render(<Harness userId="user-a" />));
      await flushAsyncEffects();
      expect(mocks.listReports).toHaveBeenCalledTimes(1);
      await act(async () => setVisibility("hidden"));
      await advance(900_000);
      expect(mocks.listReports).toHaveBeenCalledTimes(1);
      await act(async () => setVisibility("visible"));
      await flushAsyncEffects();
      expect(mocks.listReports).toHaveBeenCalledTimes(2);
    });
  });
});
