// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimResolutionAlerts: vi.fn(),
  listReports: vi.fn(),
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
  useStudioBugReportController({
    currentUserId: userId,
    activeProjectId: null,
    activeConversationId: null,
    activeConversationLocalId: null,
    activeRuntimeId: null,
    controllerProjectMissing: false,
    buildLogs: [],
  });
  return null;
}

async function flushAsyncEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("support resolution alerts with the real status queue", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.claimResolutionAlerts.mockReset();
    mocks.listReports.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.useRealTimers();
    document.body.innerHTML = "";
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("removes every visible or queued alert when the signed-in account changes", async () => {
    mocks.listReports
      .mockResolvedValueOnce(page(1, 1))
      .mockResolvedValueOnce(page(2, 1))
      .mockResolvedValue(page(0, 0));
    mocks.claimResolutionAlerts
      .mockResolvedValueOnce({
        claimedCount: 1,
        latestReportId: "11111111-1111-4111-8111-111111111111",
        latestResolvedAt: "2026-09-05T12:00:00Z",
      })
      .mockResolvedValueOnce({
        claimedCount: 1,
        latestReportId: "22222222-2222-4222-8222-222222222222",
        latestResolvedAt: "2026-09-05T12:01:00Z",
      });

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

    await render("user-a");
    expect(document.body.textContent).toContain("Your Instafy support report was resolved.");

    await act(async () => window.dispatchEvent(new Event("focus")));
    await flushAsyncEffects();
    expect(mocks.claimResolutionAlerts).toHaveBeenNthCalledWith(1, "user-a");
    expect(mocks.claimResolutionAlerts).toHaveBeenNthCalledWith(2, "user-a");
    expect(document.querySelectorAll('[data-testid="status-toast"]')).toHaveLength(1);

    await render("user-b");

    expect(document.body.textContent).not.toContain("Your Instafy support report was resolved.");
    expect(document.querySelector('[data-testid="status-toast"]')).toBeNull();
  });
});
