// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  origin: null as { originId: string; mode: string } | null,
  // The project the controller has answered for, with an origin or none.
  answered: "project-1" as string | null,
}));

vi.mock("../../../../projects/useProject", () => ({
  useProject: () => ({ activeProjectId: "project-1" }),
}));
vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ desktopOrigin: mocks.origin, desktopOriginAnsweredProjectId: mocks.answered }),
}));
vi.mock("../../../../services/runtimeController/workspaceGit", () => ({
  fetchWorkspaceGitStatusFromController: mocks.status,
}));
vi.mock("../HistoryDrawer", () => ({
  HistoryDrawer: ({
    versioning,
    probeFailed,
  }: {
    versioning: { historyReady: boolean; chromeMode: string };
    probeFailed?: boolean;
  }) => (
    <div
      data-testid="history-body"
      data-ready={String(versioning.historyReady)}
      data-mode={versioning.chromeMode}
      data-probe-failed={String(probeFailed === true)}
    />
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

describe("SourceControlDrawer", () => {
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
    mocks.answered = "project-1";
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

  const history = () => container.querySelector('[data-testid="history-body"]');

  it("shows History, not ready, without an origin and makes no probe", async () => {
    await render();
    expect(history()?.getAttribute("data-ready")).toBe("false");
    expect(history()?.getAttribute("data-probe-failed")).toBe("false");
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("waits for the space's origin, and checks the mode once the origin comes", async () => {
    window.localStorage.setItem("instafy.versioning.mode.project-1", "stateless");
    mocks.answered = null;
    mocks.status.mockResolvedValue(status(true));
    await render();
    // History waits for the origin: nothing was asked, so nothing failed.
    expect(history()?.getAttribute("data-ready")).toBe("false");
    expect(history()?.getAttribute("data-probe-failed")).toBe("false");
    expect(mocks.status).not.toHaveBeenCalled();

    mocks.origin = { originId: "gateway", mode: "hosted" };
    mocks.answered = "project-1";
    await render();
    expect(history()?.getAttribute("data-ready")).toBe("true");
    expect(history()?.getAttribute("data-probe-failed")).toBe("false");
  });

  it("checks the mode with one pinned status call when it opens", async () => {
    mocks.origin = { originId: "gateway", mode: "hosted" };
    mocks.status.mockResolvedValue(status(true));
    await render();
    expect(mocks.status).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-1", originId: "gateway", routing: "default", limit: 1 }),
    );
    expect(history()?.getAttribute("data-ready")).toBe("true");
    expect(history()?.getAttribute("data-mode")).toBe("stateless");
  });

  it("keeps History not ready on a gateway that does not answer stateless", async () => {
    mocks.origin = { originId: "gateway", mode: "hosted" };
    await render();
    expect(history()?.getAttribute("data-ready")).toBe("false");
    expect(history()?.getAttribute("data-probe-failed")).toBe("false");
  });

  it("shows History for a Desktop origin without a status call", async () => {
    mocks.origin = { originId: "desk", mode: "desktop" };
    await render();
    expect(history()?.getAttribute("data-mode")).toBe("desktop");
    expect(history()?.getAttribute("data-ready")).toBe("true");
    expect(mocks.status).not.toHaveBeenCalled();
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
    expect(history()?.getAttribute("data-ready")).toBe("false");
    expect(history()?.getAttribute("data-probe-failed")).toBe("false");
    await act(async () => fail(new TypeError("Failed to fetch")));
    await flush();
    expect(history()?.getAttribute("data-ready")).toBe("false");
    expect(history()?.getAttribute("data-probe-failed")).toBe("true");
  });
});
