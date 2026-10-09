// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
  fetchRecovery: vi.fn(),
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      git: {
        fetchStatus: mocks.fetchStatus,
        fetchRecovery: mocks.fetchRecovery,
      },
    },
  },
}));

import { markUnsavedWorkSeen, unsavedWorkSeenKey } from "../../workspace/unsavedWorkSeen";
import {
  resetUnsavedWorkStoreForTests,
  setUnsavedWorkLiveOrigins,
  UNSAVED_WORK_STOP_REFETCH_DELAY_MS,
} from "../../workspace/unsavedWorkStore";
import {
  unsavedWorkBadgeLabel,
  useWorkspaceVersioningBadge,
  type WorkspaceVersioningBadgeInput,
} from "../useWorkspaceVersioningBadge";

function Probe(input: WorkspaceVersioningBadgeInput) {
  const { badge } = useWorkspaceVersioningBadge(input);
  return <div data-testid="badge" data-label={badge?.label ?? ""}>{badge?.count ?? 0}</div>;
}

function recovery(ref: string, extra: Record<string, unknown> = {}) {
  return {
    ref,
    rev: "a".repeat(40),
    kind: "unpublished",
    subject: "",
    date: null,
    origin: null,
    paths: ["a.txt"],
    base: null,
    ...extra,
  };
}

const base: WorkspaceVersioningBadgeInput = {
  activeProjectId: "project-1",
  controllerProjectMissing: false,
  projectReadyForWorkspace: true,
  effectiveRuntimeId: "runtime-1",
  runtimeReady: true,
  chromeMode: "legacy",
  historyReady: false,
  originId: "origin-1",
};

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  });
}

describe("useWorkspaceVersioningBadge", () => {
  let container: HTMLDivElement;
  let root: Root;
  const badge = () => container.querySelector('[data-testid="badge"]');

  async function render(input: WorkspaceVersioningBadgeInput) {
    await act(async () => root.render(<Probe {...input} />));
    await flush();
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetUnsavedWorkStoreForTests();
    window.localStorage.clear();
    mocks.fetchStatus.mockReset();
    mocks.fetchRecovery.mockReset();
    mocks.fetchStatus.mockResolvedValue({ supported: true, dirtyCount: 2, dirtyPaths: [], pathGroups: [] });
    mocks.fetchRecovery.mockResolvedValue({
      status: "ok",
      entries: [
        recovery("refs/instafy/recovery/o/a"),
        recovery("refs/instafy/recovery/o/b", { restoredRev: "f".repeat(40) }),
      ],
      originId: "origin-1",
      originMode: "hosted",
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    resetUnsavedWorkStoreForTests();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps today's uncommitted-changes badge in legacy and never lists unsaved work", async () => {
    await render(base);
    expect(mocks.fetchStatus).toHaveBeenCalledWith({ projectId: "project-1", runtimeId: "runtime-1", limit: 1 });
    expect(badge()?.textContent).toBe("2");
    expect(badge()?.getAttribute("data-label")).toBe("2 uncommitted changes");
    expect(mocks.fetchRecovery).not.toHaveBeenCalled();
  });

  it("counts pending unsaved work in a stateless space with no status call", async () => {
    await render({ ...base, chromeMode: "stateless", historyReady: true });
    expect(mocks.fetchStatus).not.toHaveBeenCalled();
    expect(mocks.fetchRecovery).toHaveBeenCalledWith({ projectId: "project-1", originId: "origin-1" });
    // The restored entry no longer counts.
    expect(badge()?.textContent).toBe("1");
    expect(badge()?.getAttribute("data-label")).toBe("1 unsaved work entry");
  });

  it("makes no call at all while the History mode is only a guess", async () => {
    await render({ ...base, chromeMode: "desktop", historyReady: false });
    expect(mocks.fetchStatus).not.toHaveBeenCalled();
    expect(mocks.fetchRecovery).not.toHaveBeenCalled();
    expect(badge()?.textContent).toBe("0");
  });

  it("shows no badge for a Desktop origin without a recovery route", async () => {
    mocks.fetchRecovery.mockResolvedValue({ status: "unsupported", entries: [], originId: "origin-1", originMode: "desktop" });
    await render({ ...base, chromeMode: "desktop", historyReady: true });
    expect(mocks.fetchStatus).not.toHaveBeenCalled();
    expect(badge()?.textContent).toBe("0");
  });

  it("counts every pending entry, whether this viewer has seen it or not", async () => {
    const unpublished = recovery("refs/instafy/recovery/o/a");
    mocks.fetchRecovery.mockResolvedValue({ status: "ok", entries: [unpublished], originId: "origin-1", originMode: "hosted" });
    await render({ ...base, chromeMode: "stateless", historyReady: true });
    expect(badge()?.textContent).toBe("1");
    await act(async () => {
      markUnsavedWorkSeen("project-1", "user-1", [unsavedWorkSeenKey(unpublished)]);
    });
    expect(badge()?.textContent).toBe("1");
  });

  it("leaves a running workspace's rolling save off the badge", async () => {
    const running = "11111111-1111-4111-8111-111111111111";
    const stopped = "22222222-2222-4222-8222-222222222222";
    mocks.fetchRecovery.mockResolvedValue({
      status: "ok",
      entries: [
        recovery("refs/instafy/recovery/o/a", { origin: running }),
        recovery("refs/instafy/recovery/w1/working", { kind: "unsaved", origin: running, rollingSave: true }),
        recovery("refs/instafy/recovery/w2/working", { kind: "unsaved", origin: stopped, rollingSave: true }),
      ],
      originId: "origin-1",
      originMode: "hosted",
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Until the runtime status answers, no rolling save counts.
    await render({ ...base, chromeMode: "stateless", historyReady: true });
    expect(badge()?.textContent).toBe("1");

    // The stopped origin's save waits for the list to be read again: it may
    // have stopped, and saved once more, after the list in hand was read.
    await act(async () => setUnsavedWorkLiveOrigins("project-1", [running]));
    expect(badge()?.textContent).toBe("1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNSAVED_WORK_STOP_REFETCH_DELAY_MS);
    });
    await flush();
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(2);
    expect(badge()?.textContent).toBe("2");
    expect(badge()?.getAttribute("data-label")).toBe("2 unsaved work entries");
  });

  it("labels several entries in the plural", () => {
    expect(unsavedWorkBadgeLabel(3)).toBe("3 unsaved work entries");
  });
});
