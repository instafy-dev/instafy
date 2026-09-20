// @vitest-environment jsdom

import { notifyManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerAutomation } from "../../../../sdk/instafy";
import type { RunRecord } from "../../../../types";
import type { FetchControllerRunsResult } from "../../../../services/runtimeController/runs";
import { AutomationsPanel } from "../AutomationsPanel";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), openConversationTab: vi.fn(), requestUrlPush: vi.fn(),
  fetchRuns: vi.fn(), projectId: "project-a", userId: "user-a",
  runs: {} as Record<string, RunRecord>,
}));
vi.mock("../../../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: mocks.userId } }) }));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: () => ({ activeProjectId: mocks.projectId }) }));
vi.mock("../../../../runtime/RuntimeStateProvider", () => ({ useRuntimeState: () => ({ runs: mocks.runs }) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => ({ openConversationTab: mocks.openConversationTab, requestUrlPush: mocks.requestUrlPush }) }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { automations: { listForProject: mocks.list }, runs: { fetch: mocks.fetchRuns } } }));
vi.mock("../SettingsShell", () => ({ SettingsShell: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => <div>{actions}{children}</div> }));
vi.mock("../../../../components/aria/StudioModal", () => ({ StudioDialogModal: () => null }));

const automation: ControllerAutomation = {
  id: "automation-a", projectId: "project-a", userId: "user-a", name: "Check reports",
  promptText: "Check reports", metadata: {}, scheduleKind: "once", runAt: "2026-09-08T10:00:00Z",
  intervalHours: null, byDay: [], byHour: null, byMinute: null, timezone: "UTC",
  runtimeMode: "auto", runtimeProvider: null, conversationId: "thread-a",
  silentWhenNothingToReport: false, status: "paused", lockedUntil: null,
  lastRunAt: "2026-09-08T10:00:00Z", nextRunAt: null, lastError: null,
  createdAt: "2026-09-08T09:00:00Z", updatedAt: "2026-09-08T10:00:00Z",
};

const completedRun: RunRecord = {
  id: "run-a", projectId: "project-a", sessionId: null, conversationId: "thread-a", promptId: null,
  runType: "prompt", status: "success", progress: 100, progressStage: null, previewUrl: null,
  lastMessage: "Repository access is required before a fix can be made.", metadata: { automation: { id: "automation-a" } },
  createdAt: "2026-09-08T10:00:01Z", updatedAt: "2026-09-08T10:05:00Z",
};

function fetchedRuns(runs: RunRecord[] = []): FetchControllerRunsResult {
  return { runs, notFound: false, unauthorized: false, forbidden: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { resolve, promise };
}

describe("automation activity and thread navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    notifyManager.setNotifyFunction((callback) => { act(callback); });
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    vi.clearAllMocks();
    mocks.runs = {};
    mocks.projectId = "project-a";
    mocks.userId = "user-a";
    mocks.list.mockReset().mockResolvedValue([automation]);
    mocks.fetchRuns.mockReset().mockImplementation(async () => fetchedRuns(Object.values(mocks.runs)));
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    notifyManager.setNotifyFunction((callback) => { callback(); });
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render({ pendingRunHistory = false, expectedStatus }: { pendingRunHistory?: boolean; expectedStatus?: string } = {}) {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><AutomationsPanel /></QueryClientProvider>));
    // The list mounts a second query for history, which can itself reconcile
    // a live run. Wait for that observable cascade, not a fixed render delay.
    await vi.waitFor(() => {
      const listKey = ["project-automations", mocks.userId, mocks.projectId];
      expect(queryClient.getQueryState(listKey)?.status).toBe("success");
      const loaded = queryClient.getQueryData<ControllerAutomation[]>(listKey)!;
      for (const entry of loaded) {
        expect(container.querySelector(`[data-testid="automation-row-${entry.id}"]`)).not.toBeNull();
      }
      const history = queryClient.getQueryState(["automation-recent-runs", mocks.userId, mocks.projectId]);
      if (pendingRunHistory) {
        expect(history?.fetchStatus).toBe("fetching");
        expect(container.textContent).toContain("Loading recent turn details…");
      } else {
        expect(queryClient.isFetching({ type: "active" })).toBe(0);
        expect(container.textContent).not.toContain("Loading recent turn details…");
      }
      if (expectedStatus) expect(status()).toContain(expectedStatus);
    });
  }
  const status = () => container.querySelector('[data-testid="automation-run-status-automation-a"]')?.textContent;

  it("makes the thread directly reachable and requests URL navigation before activation", async () => {
    await render();
    const button = container.querySelector<HTMLButtonElement>('[data-testid="automation-open-thread-automation-a"]');
    expect(button?.textContent).toBe("View thread");
    await act(async () => button!.click());
    expect(mocks.openConversationTab).toHaveBeenCalledWith("thread-a");
    expect(mocks.requestUrlPush).toHaveBeenCalledTimes(1);
    expect(mocks.requestUrlPush.mock.invocationCallOrder[0]).toBeLessThan(mocks.openConversationTab.mock.invocationCallOrder[0]);
  });

  it("applies the same URL intent to the existing menu action", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Automation actions"]')!.click());
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((node) => node.textContent === "Open thread");
    expect(item).toBeDefined();
    await act(async () => item!.click());
    expect(mocks.openConversationTab).toHaveBeenCalledWith("thread-a");
    expect(mocks.requestUrlPush.mock.invocationCallOrder[0]).toBeLessThan(mocks.openConversationTab.mock.invocationCallOrder[0]);
  });

  it("separates schedule completion from a completed turn whose summary still needs action", async () => {
    mocks.runs = { [completedRun.id]: completedRun };
    await render({ expectedStatus: "Turn completed" });
    expect(container.querySelector('[data-testid="automation-schedule-status-automation-a"]')?.textContent).toBe("One-time schedule finished");
    expect(status()).toContain("Turn completed");
    expect(status()).toContain("Repository access is required before a fix can be made.");
    expect(container.querySelector('[data-testid="automation-next-run-automation-a"]')?.textContent).toBe("Next run: None scheduled");
    expect(container.textContent).toContain("Last launch attempt:");
    expect(container.textContent).not.toContain("Done");
  });

  it("shows launch failure separately and does not reuse an older successful turn", async () => {
    mocks.list.mockResolvedValue([{ ...automation, lastError: "Runtime unavailable" }]);
    mocks.runs = { [completedRun.id]: { ...completedRun, createdAt: "2026-09-08T09:00:00Z" } };
    await render();
    expect(container.textContent).toContain("Launch failed: Runtime unavailable");
    expect(container.textContent).not.toContain("Turn completed");
    expect(container.querySelector('[data-testid="automation-open-thread-automation-a"]')).not.toBeNull();
  });

  it("updates from the shared live run state and replaces missing details honestly", async () => {
    await render({ expectedStatus: "Recent turn details are unavailable" });
    expect(status()).toContain("Recent turn details are unavailable");
    mocks.runs = { [completedRun.id]: { ...completedRun, status: "in_progress", lastMessage: "Inspecting the report" } };
    await render({ expectedStatus: "Turn running" });
    expect(status()).toContain("Turn running");
    expect(status()).toContain("Latest update: Inspecting the report");
    mocks.runs = { [completedRun.id]: { ...completedRun, status: "failed" } };
    await render({ expectedStatus: "Turn failed" });
    expect(status()).toContain("Turn failed");
  });

  it("loads recent outcomes on the first visit with one bounded request shared by all rows", async () => {
    const secondAutomation = { ...automation, id: "automation-b", conversationId: "thread-b", name: "Second check" };
    const secondRun = { ...completedRun, id: "run-b", conversationId: "thread-b", metadata: { automation: { id: "automation-b" } } };
    mocks.list.mockResolvedValue([automation, secondAutomation]);
    mocks.fetchRuns.mockResolvedValue(fetchedRuns([completedRun, secondRun]));
    await render({ expectedStatus: "Turn completed" });
    expect(status()).toContain("Turn completed");
    expect(status()).toContain("Repository access is required");
    expect(container.querySelector('[data-testid="automation-run-status-automation-b"]')?.textContent).toContain("Turn completed");
    expect(mocks.fetchRuns).toHaveBeenCalledExactlyOnceWith({ projectId: "project-a", limit: 100 });
    expect(mocks.runs).toEqual({});
  });

  it("does not present unmatched records in a full recent page as the latest outcome", async () => {
    mocks.fetchRuns.mockResolvedValue(fetchedRuns(Array.from({ length: 100 }, (_, index) => ({
      ...completedRun, id: `other-${index}`, metadata: { automation: { id: "other" } },
    }))));
    await render({ expectedStatus: "Recent turn details are unavailable" });
    expect(status()).toContain("Recent turn details are unavailable");
    expect(status()).not.toContain("Turn completed");
  });

  it.each(["forbidden", "unauthorized", "notFound"] as const)("clears previously authorized run details after %s", async (flag) => {
    mocks.runs = { [completedRun.id]: completedRun };
    await render({ expectedStatus: "Turn completed" });
    expect(status()).toContain("Turn completed");
    mocks.fetchRuns.mockResolvedValue({ ...fetchedRuns(), [flag]: true });
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["automation-recent-runs", "user-a", "project-a"] }); });
    await render({ expectedStatus: "Turn details are unavailable for this account." });
    expect(status()).toBe("Turn details are unavailable for this account.");
    expect(status()).not.toContain(completedRun.lastMessage);
    // Empty client responses can mean a transport failure; they must not
    // resurrect previously authorized text from the shared runtime store.
    mocks.fetchRuns.mockResolvedValue(fetchedRuns());
    await act(async () => { await queryClient.refetchQueries({ queryKey: ["automation-recent-runs", "user-a", "project-a"] }); });
    await render({ expectedStatus: "Recent turn details are unavailable" });
    expect(status()).not.toContain("Turn completed");
  });

  it("does not reuse another account's history or unvalidated live run entries", async () => {
    mocks.runs = { [completedRun.id]: completedRun };
    await render({ expectedStatus: "Turn completed" });
    expect(status()).toContain("Turn completed");
    mocks.userId = "user-b";
    mocks.list.mockResolvedValue([{ ...automation, userId: "user-b" }]);
    const pending = deferred<FetchControllerRunsResult>();
    mocks.fetchRuns.mockReturnValue(pending.promise);
    await render({ pendingRunHistory: true });
    expect(status()).toBe("Loading recent turn details…");
    expect(container.textContent).not.toContain(completedRun.lastMessage);
    await act(async () => pending.resolve(fetchedRuns()));
    await render({ expectedStatus: "Recent turn details are unavailable" });
    expect(status()).not.toContain("Turn completed");
  });

  it("discards the old space's delayed run response after switching spaces", async () => {
    const pending = deferred<FetchControllerRunsResult>();
    mocks.fetchRuns.mockReturnValueOnce(pending.promise).mockResolvedValue(fetchedRuns());
    await render({ pendingRunHistory: true });
    mocks.projectId = "project-b";
    mocks.list.mockResolvedValue([{ ...automation, id: "automation-b", projectId: "project-b", conversationId: "thread-b", name: "New space check" }]);
    await render();
    await act(async () => pending.resolve(fetchedRuns([completedRun])));
    await render();
    expect(container.textContent).toContain("New space check");
    expect(container.textContent).not.toContain(completedRun.lastMessage);
    expect(mocks.fetchRuns).toHaveBeenLastCalledWith({ projectId: "project-b", limit: 100 });
  });

  it("shows unavailable history after a fetch error without claiming no run occurred", async () => {
    mocks.fetchRuns.mockRejectedValue(new Error("Offline"));
    await render({ expectedStatus: "Recent turn details are unavailable" });
    expect(status()).toContain("Recent turn details are unavailable");
    expect(status()).not.toContain("Turn completed");
    expect(container.querySelector('[data-testid="automation-open-thread-automation-a"]')).not.toBeNull();
  });

  it("does not expose a thread button before a thread exists", async () => {
    mocks.list.mockResolvedValue([{ ...automation, conversationId: null, lastRunAt: null, status: "active", nextRunAt: "2026-09-09T10:00:00Z" }]);
    await render();
    expect(container.querySelector('[data-testid="automation-open-thread-automation-a"]')).toBeNull();
    expect(container.textContent).toContain("No launch recorded yet.");
    expect(container.querySelector('[data-testid="automation-next-run-automation-a"]')?.textContent).not.toContain("Not scheduled");
  });

  it("reconciles an unseen live turn once without fetching again for every progress update", async () => {
    mocks.runs = { [completedRun.id]: { ...completedRun, status: "queued" } };
    mocks.fetchRuns.mockResolvedValue(fetchedRuns());
    await render({ expectedStatus: "Recent turn details are unavailable" });
    expect(mocks.fetchRuns).toHaveBeenCalledTimes(2);
    mocks.runs = { [completedRun.id]: { ...completedRun, status: "in_progress", progress: 40 } };
    await render();
    mocks.runs = { [completedRun.id]: completedRun };
    await render();
    expect(mocks.fetchRuns).toHaveBeenCalledTimes(2);
    expect(status()).not.toContain("Turn completed");
  });
});
