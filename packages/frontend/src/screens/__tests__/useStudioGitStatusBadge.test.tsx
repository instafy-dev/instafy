// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPollingGate } from "../../runtime/pollingGate";
import {
  CONTROLLER_STREAM_RECONNECTED_EVENT,
  GIT_STATUS_CHANGE_DEBOUNCE_MS,
  GIT_STATUS_FALLBACK_INTERVAL_MS,
  useStudioGitStatusBadge,
  WORKSPACE_CHANGE_EVENT,
  WORKSPACE_COMMIT_EVENT,
  type StudioGitStatusBadgeInput,
} from "../useStudioGitStatusBadge";

const mocks = vi.hoisted(() => ({
  fetchStatus: vi.fn(),
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      git: {
        fetchStatus: mocks.fetchStatus,
      },
    },
  },
}));

function status(dirtyCount: number, supported = true) {
  return { supported, dirtyCount, dirtyPaths: [], pathGroups: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function Probe(input: StudioGitStatusBadgeInput) {
  const badge = useStudioGitStatusBadge(input);
  return <div data-testid="badge" data-supported={String(badge.gitSupported)}>{badge.gitDirtyCount}</div>;
}

const ready: StudioGitStatusBadgeInput = {
  activeProjectId: "project-1",
  controllerProjectMissing: false,
  projectReadyForWorkspace: true,
  effectiveRuntimeId: "runtime-1",
  runtimeReady: true,
};

function dispatch(name: string, detail?: unknown) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

describe("useStudioGitStatusBadge", () => {
  let container: HTMLDivElement;
  let root: Root;

  const badge = () => container.querySelector('[data-testid="badge"]');

  async function render(input: StudioGitStatusBadgeInput) {
    await act(async () => root.render(<Probe {...input} />));
  }

  async function advance(ms: number) {
    await act(async () => { vi.advanceTimersByTime(ms); });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    installPollingGate();
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pointerdown"));
    mocks.fetchStatus.mockReset();
    mocks.fetchStatus.mockResolvedValue(status(3));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("fetches once when the project is ready and shows the count", async () => {
    await render(ready);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
    expect(mocks.fetchStatus).toHaveBeenCalledWith({ projectId: "project-1", runtimeId: "runtime-1", limit: 1 });
    expect(badge()?.textContent).toBe("3");
    expect(badge()?.getAttribute("data-supported")).toBe("true");
  });

  it("does not fetch before the project is ready", async () => {
    await render({ ...ready, projectReadyForWorkspace: false });
    expect(mocks.fetchStatus).not.toHaveBeenCalled();
    await render(ready);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("stays quiet for a minute and falls back to one fetch every two minutes while active", async () => {
    await render(ready);
    await advance(60_000);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
    await advance(GIT_STATUS_FALLBACK_INTERVAL_MS - 60_000);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
  });

  it("coalesces a burst of workspace changes into one debounced fetch", async () => {
    await render(ready);
    mocks.fetchStatus.mockResolvedValue(status(7));
    await act(async () => {
      dispatch(WORKSPACE_CHANGE_EVENT, { projectId: "project-1", kind: "workspace.file_changed" });
      vi.advanceTimersByTime(200);
      dispatch(WORKSPACE_CHANGE_EVENT, { projectId: "project-1", kind: "workspace.file_changed" });
      vi.advanceTimersByTime(200);
      dispatch(WORKSPACE_CHANGE_EVENT, { projectId: "project-1", kind: "workspace.file_changed" });
    });
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
    await advance(GIT_STATUS_CHANGE_DEBOUNCE_MS - 1);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
    expect(badge()?.textContent).toBe("7");
  });

  it("ignores workspace events for another project", async () => {
    await render(ready);
    await act(async () => {
      dispatch(WORKSPACE_CHANGE_EVENT, { projectId: "project-2", kind: "workspace.file_changed" });
      dispatch(WORKSPACE_COMMIT_EVENT, { projectId: "project-2" });
    });
    await advance(GIT_STATUS_CHANGE_DEBOUNCE_MS);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("refetches at once on a commit and on a stream reconnect", async () => {
    await render(ready);
    mocks.fetchStatus.mockResolvedValue(status(0));
    await act(async () => { dispatch(WORKSPACE_COMMIT_EVENT, { projectId: "project-1" }); });
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
    expect(badge()?.textContent).toBe("0");
    await act(async () => { dispatch(CONTROLLER_STREAM_RECONNECTED_EVENT); });
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("leaves the badge unsupported after a failed fetch and pauses the fallback until the next event", async () => {
    mocks.fetchStatus.mockResolvedValue(null);
    await render(ready);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
    expect(badge()?.getAttribute("data-supported")).toBe("false");
    await advance(GIT_STATUS_FALLBACK_INTERVAL_MS);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(1);
    mocks.fetchStatus.mockResolvedValue(status(2));
    await act(async () => { dispatch(WORKSPACE_CHANGE_EVENT, { projectId: "project-1", kind: "workspace.file_changed" }); });
    await advance(GIT_STATUS_CHANGE_DEBOUNCE_MS);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
    expect(badge()?.textContent).toBe("2");
    // Keep the gate active so the fallback runs at its active cadence.
    await act(async () => { window.dispatchEvent(new Event("pointerdown")); });
    await advance(GIT_STATUS_FALLBACK_INTERVAL_MS);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(3);
  });

  it("drops an in-flight result when the runtime changes", async () => {
    const first = deferred<ReturnType<typeof status>>();
    const second = deferred<ReturnType<typeof status>>();
    mocks.fetchStatus.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await render(ready);
    await render({ ...ready, effectiveRuntimeId: "runtime-2" });
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
    await act(async () => { first.resolve(status(9)); });
    expect(badge()?.textContent).toBe("0");
    await act(async () => { second.resolve(status(4)); });
    expect(badge()?.textContent).toBe("4");
  });

  it("clears the badge and cancels a pending debounce when the project switches", async () => {
    await render(ready);
    expect(badge()?.textContent).toBe("3");
    await act(async () => { dispatch(WORKSPACE_CHANGE_EVENT, { projectId: "project-1", kind: "workspace.file_changed" }); });
    mocks.fetchStatus.mockResolvedValue(status(1));
    await render({ ...ready, activeProjectId: "project-2" });
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
    expect(mocks.fetchStatus).toHaveBeenLastCalledWith({ projectId: "project-2", runtimeId: "runtime-1", limit: 1 });
    await advance(GIT_STATUS_CHANGE_DEBOUNCE_MS);
    expect(mocks.fetchStatus).toHaveBeenCalledTimes(2);
    expect(badge()?.textContent).toBe("1");
  });
});
