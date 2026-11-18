// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listReports: vi.fn(),
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
vi.mock("../../../../debug/useAppLogs", () => ({
  useAppLogs: () => ({ logs: [] }),
}));
vi.mock("../BugReportDialog", () => ({
  BugReportDialog: () => null,
}));
vi.mock("../BugReportInboxDialog", () => ({
  BugReportInboxDialog: () => null,
}));
vi.mock("../shakeReportPreference", () => ({
  getStoredShakeReportEnabled: () => false,
  setStoredShakeReportEnabled: vi.fn(),
}));
vi.mock("../useShakeToReport", () => ({
  NATIVE_SHAKE_REPORT_EVENT: "instafy:test-shake",
  useShakeToReport: () => undefined,
}));

import { Status } from "../../../../status/Status";
import { StatusProvider } from "../../../../status/StatusProvider";
import { useStudioBugReportController } from "../useStudioBugReportController";
import { NOTIFICATION_FEED_CHANGED_EVENT } from "../../../../notifications/notificationFeedEvents";

function page(unreadCount: number, unreadResolutionCount: number) {
  return {
    reports: [],
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
  return <output data-testid="support-unread-count">{support.supportUnreadCount}</output>;
}

async function flushAsyncEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("support resolutions with the real status queue", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.listReports.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    document.body.innerHTML = "";
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("counts resolutions for the signed-in account and queues no toast for them", async () => {
    mocks.listReports
      .mockResolvedValueOnce(page(1, 1))
      .mockResolvedValueOnce(page(2, 2))
      .mockResolvedValue(page(0, 0));

    const render = async (userId: string) => {
      await act(async () => {
        root.render(
          <StatusProvider>
            <Status />
            <Harness userId={userId} />
          </StatusProvider>,
        );
      });
      await flushAsyncEffects();
    };
    const unreadCount = () => document.querySelector('[data-testid="support-unread-count"]')?.textContent;

    await render("user-a");
    expect(unreadCount()).toBe("1");
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();

    await act(async () => window.dispatchEvent(new Event(NOTIFICATION_FEED_CHANGED_EVENT)));
    await flushAsyncEffects();
    expect(mocks.listReports).toHaveBeenNthCalledWith(2, 100, null, "user-a");
    expect(unreadCount()).toBe("2");
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();

    await render("user-b");
    expect(mocks.listReports).toHaveBeenLastCalledWith(100, null, "user-b");
    expect(unreadCount()).toBe("0");
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
  });
});
