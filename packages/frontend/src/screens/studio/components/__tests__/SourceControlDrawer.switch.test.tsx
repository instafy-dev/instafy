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
  LegacyChangesDrawer: () => <div data-testid="legacy-body" />,
}));
vi.mock("../HistoryDrawer", () => ({
  HistoryDrawer: ({ versioning }: { versioning: { historyReady: boolean; chromeMode: string } }) => (
    <div data-testid="history-body" data-ready={String(versioning.historyReady)} data-mode={versioning.chromeMode} />
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
});
