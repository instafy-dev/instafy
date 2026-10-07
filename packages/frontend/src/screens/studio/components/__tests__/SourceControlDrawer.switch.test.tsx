// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  origin: null as { originId: string; mode: string } | null,
}));

vi.mock("../../../../projects/useProject", () => ({
  useProject: () => ({ activeProjectId: "project-1" }),
}));
vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ desktopOrigin: mocks.origin }),
}));
vi.mock("../../../../services/runtimeController/workspaceGit", () => ({
  fetchWorkspaceGitStatusFromController: mocks.status,
}));
vi.mock("../LegacyChangesDrawer", () => ({
  LegacyChangesDrawer: ({ arrivalNotice }: { arrivalNotice?: string | null }) => (
    <div data-testid="legacy-body" data-arrival={arrivalNotice ?? ""}>
      <button type="button" data-testid="legacy-refresh">
        Refresh
      </button>
    </div>
  ),
}));
vi.mock("../HistoryDrawer", () => ({
  HistoryDrawer: ({
    versioning,
    probeFailed,
    arrived,
    arrivalNotice,
  }: {
    versioning: { historyReady: boolean; chromeMode: string };
    probeFailed?: boolean;
    arrived?: boolean;
    arrivalNotice?: string | null;
  }) => (
    <div
      data-testid="history-body"
      data-ready={String(versioning.historyReady)}
      data-mode={versioning.chromeMode}
      data-probe-failed={String(probeFailed === true)}
      data-arrived={String(arrived === true)}
      data-arrival={arrivalNotice ?? ""}
    >
      <button type="button" data-testid="history-retry">
        Retry
      </button>
    </div>
  ),
}));

import { resetWorkspaceVersioningProbesForTests } from "../../../../services/runtimeController/workspaceVersioning";
import { resetWorkspaceVersioningCacheForTests } from "../../../../services/runtimeController/workspaceVersioningCache";
import { SourceControlDrawer } from "../SourceControlDrawer";

function status(stateless?: boolean) {
  return { supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [], ...(stateless ? { stateless: true } : {}) };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  });
}

describe("SourceControlDrawer switch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetWorkspaceVersioningCacheForTests();
    resetWorkspaceVersioningProbesForTests();
    window.localStorage.clear();
    mocks.status.mockReset();
    mocks.status.mockResolvedValue(status());
    mocks.origin = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render() {
    await act(async () => root.render(<SourceControlDrawer />));
    await flush();
  }

  it("keeps today's Changes drawer without an origin and makes no probe", async () => {
    await render();
    expect(container.querySelector('[data-testid="legacy-body"]')).not.toBeNull();
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("keeps today's Changes drawer on the stateful gateway", async () => {
    mocks.origin = { originId: "gateway", mode: "hosted" };
    await render();
    expect(container.querySelector('[data-testid="legacy-body"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="history-body"]')).toBeNull();
    // Opening the drawer checks the mode with one pinned status call.
    expect(mocks.status).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", originId: "gateway", routing: "default", limit: 1 }),
    );
  });

  it("shows History on the stateless gateway", async () => {
    mocks.origin = { originId: "gateway", mode: "hosted" };
    mocks.status.mockResolvedValue(status(true));
    await render();
    const history = container.querySelector('[data-testid="history-body"]');
    expect(history?.getAttribute("data-ready")).toBe("true");
    expect(history?.getAttribute("data-mode")).toBe("stateless");
  });

  it("shows History for a Desktop origin without a status call", async () => {
    mocks.origin = { originId: "desk", mode: "desktop" };
    await render();
    expect(container.querySelector('[data-testid="history-body"]')?.getAttribute("data-mode")).toBe("desktop");
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("shows History chrome from the last mode while the probe runs, and falls back to Changes", async () => {
    window.localStorage.setItem("instafy.versioning.mode.project-1", "stateless");
    mocks.origin = { originId: "gateway", mode: "hosted" };
    let answer!: (value: unknown) => void;
    mocks.status.mockReturnValue(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await render();
    expect(container.querySelector('[data-testid="history-body"]')?.getAttribute("data-ready")).toBe("false");
    await act(async () => answer(status()));
    await flush();
    expect(container.querySelector('[data-testid="legacy-body"]')).not.toBeNull();
  });

  describe("when one drawer replaces the other", () => {
    function pendingProbe() {
      let answer!: (value: unknown) => void;
      mocks.status.mockReturnValue(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      return (value: unknown) => answer(value);
    }

    const body = (testId: string) => container.querySelector(`[data-testid="${testId}"]`);

    it("hands the keyboard to Changes when History goes away under it", async () => {
      window.localStorage.setItem("instafy.versioning.mode.project-1", "stateless");
      mocks.origin = { originId: "gateway", mode: "hosted" };
      const answer = pendingProbe();
      await render();
      const retry = container.querySelector<HTMLButtonElement>('[data-testid="history-retry"]');
      await act(async () => retry?.focus());
      expect(document.activeElement).toBe(retry);
      await act(async () => answer(status()));
      await flush();
      expect(body("legacy-body")?.getAttribute("data-arrival")).toBe("This space shows Changes instead of History.");
    });

    it("hands the keyboard to History when Changes goes away under it", async () => {
      // This device last saw the space in Changes.
      window.localStorage.setItem("instafy.versioning.mode.project-1", "legacy");
      mocks.origin = { originId: "gateway", mode: "hosted" };
      const answer = pendingProbe();
      await render();
      const refresh = container.querySelector<HTMLButtonElement>('[data-testid="legacy-refresh"]');
      await act(async () => refresh?.focus());
      await act(async () => answer(status(true)));
      await flush();
      expect(body("history-body")?.getAttribute("data-arrived")).toBe("true");
      expect(body("history-body")?.getAttribute("data-arrival")).toBe("This space shows History instead of Changes.");
    });

    it("does not say History replaced Changes in a space that never showed Changes", async () => {
      // A new space: no mode remembered here and no answer yet, so Changes
      // only stood in while the mode was checked.
      mocks.origin = { originId: "gateway", mode: "hosted" };
      const answer = pendingProbe();
      await render();
      const refresh = container.querySelector<HTMLButtonElement>('[data-testid="legacy-refresh"]');
      await act(async () => refresh?.focus());
      await act(async () => answer(status(true)));
      await flush();
      expect(body("history-body")?.getAttribute("data-arrived")).toBe("true");
      expect(body("history-body")?.getAttribute("data-arrival")).toBe("");
    });

    it("moves nothing when the keyboard was elsewhere", async () => {
      window.localStorage.setItem("instafy.versioning.mode.project-1", "stateless");
      mocks.origin = { originId: "gateway", mode: "hosted" };
      const answer = pendingProbe();
      const outside = document.createElement("button");
      document.body.appendChild(outside);
      try {
        await render();
        await act(async () => outside.focus());
        await act(async () => answer(status()));
        await flush();
        expect(body("legacy-body")?.getAttribute("data-arrival")).toBe("");
        expect(document.activeElement).toBe(outside);
      } finally {
        outside.remove();
      }
    });
  });

  it("tells History when the probe made on opening got no answer", async () => {
    window.localStorage.setItem("instafy.versioning.mode.project-1", "stateless");
    mocks.origin = { originId: "gateway", mode: "hosted" };
    let fail!: (reason: unknown) => void;
    mocks.status.mockReturnValue(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    await render();
    const history = () => container.querySelector('[data-testid="history-body"]');
    expect(history()?.getAttribute("data-ready")).toBe("false");
    expect(history()?.getAttribute("data-probe-failed")).toBe("false");
    await act(async () => fail(new TypeError("Failed to fetch")));
    await flush();
    expect(history()?.getAttribute("data-ready")).toBe("false");
    expect(history()?.getAttribute("data-probe-failed")).toBe("true");
  });
});
