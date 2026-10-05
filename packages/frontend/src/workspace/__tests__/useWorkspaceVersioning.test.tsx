// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ status: vi.fn() }));

vi.mock("../../services/runtimeController/workspaceGit", () => ({
  fetchWorkspaceGitStatusFromController: mocks.status,
}));

import {
  noteVersioningSignal,
  resetWorkspaceVersioningProbesForTests,
  VERSIONING_STALE_MS,
} from "../../services/runtimeController/workspaceVersioning";
import { resetWorkspaceVersioningCacheForTests } from "../../services/runtimeController/workspaceVersioningCache";
import {
  useWorkspaceVersioning,
  type UseWorkspaceVersioningInput,
  type WorkspaceVersioningState,
} from "../useWorkspaceVersioning";

let latest: WorkspaceVersioningState | null = null;

function Probe(props: UseWorkspaceVersioningInput & { capture?: boolean }) {
  const state = useWorkspaceVersioning(props);
  if (props.capture !== false) {
    latest = state;
  }
  return <div data-mode={state.mode} />;
}

function statusResult(stateless?: boolean) {
  return { supported: true, dirtyCount: 0, dirtyPaths: [], pathGroups: [], ...(stateless === undefined ? {} : { stateless }) };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }
  });
}

const gateway = { originId: "gateway", mode: "hosted" };

describe("useWorkspaceVersioning", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetWorkspaceVersioningCacheForTests();
    resetWorkspaceVersioningProbesForTests();
    mocks.status.mockReset();
    mocks.status.mockResolvedValue(statusResult());
    window.localStorage.clear();
    latest = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(props: UseWorkspaceVersioningInput) {
    await act(async () => {
      root.render(<Probe {...props} />);
    });
    await flush();
  }

  it("a Desktop origin resolves to desktop without a status call", async () => {
    await render({ projectId: "p", origin: { originId: "desk", mode: "desktop" } });
    expect(latest).toMatchObject({ mode: "desktop", resolved: true, firstPaintMode: "desktop", originId: "desk", originMode: "desktop" });
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("is legacy until the probe answers, with the stored guess for first paint", async () => {
    window.localStorage.setItem("instafy.versioning.mode.p", "stateless");
    let resolveStatus: (value: unknown) => void = () => {};
    mocks.status.mockReturnValue(new Promise((resolve) => { resolveStatus = resolve; }));
    await render({ projectId: "p", origin: gateway });
    expect(latest).toMatchObject({ mode: "legacy", resolved: false, firstPaintMode: "stateless" });

    resolveStatus(statusResult(true));
    await flush();
    expect(latest).toMatchObject({ mode: "stateless", resolved: true, stateless: true, firstPaintMode: "stateless" });
    expect(mocks.status).toHaveBeenCalledWith(expect.objectContaining({ originId: "gateway", routing: "default", limit: 1 }));
  });

  it("is legacy without an origin and makes no request", async () => {
    await render({ projectId: "p", origin: null });
    expect(latest).toMatchObject({ mode: "legacy", resolved: false, originId: null });
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("does not probe while disabled", async () => {
    await render({ projectId: "p", origin: gateway, enabled: false });
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("probes again at once when a response contradicts the cached mode", async () => {
    await render({ projectId: "p", origin: gateway });
    expect(latest?.mode).toBe("legacy");
    mocks.status.mockResolvedValue(statusResult(true));

    await act(async () => {
      noteVersioningSignal("gateway", "committed");
    });
    await flush();

    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(latest).toMatchObject({ mode: "stateless", resolved: true });
  });

  it("probes again when a contradicting response arrives during the first probe", async () => {
    let resolveStatus: (value: unknown) => void = () => {};
    mocks.status.mockReturnValueOnce(new Promise((resolve) => { resolveStatus = resolve; }));
    await render({ projectId: "p", origin: gateway });
    mocks.status.mockResolvedValue(statusResult(true));

    await act(async () => {
      noteVersioningSignal("gateway", "committed");
    });
    resolveStatus(statusResult());
    await flush();

    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(latest).toMatchObject({ mode: "stateless", resolved: true });
  });

  it("re-checks on focus and stream reconnect only when the result is older than 60 s", async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    await render({ projectId: "p", origin: gateway });
    expect(mocks.status).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
    expect(mocks.status).toHaveBeenCalledTimes(1);

    now.mockReturnValue(start + VERSIONING_STALE_MS + 1);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("instafy:controller-stream-reconnected"));
    });
    await flush();
    expect(mocks.status).toHaveBeenCalledTimes(2);
  });

  it("refresh forces a probe (the History drawer opening)", async () => {
    await render({ projectId: "p", origin: gateway });
    mocks.status.mockResolvedValue(statusResult(true));
    await act(async () => {
      await latest?.refresh();
    });
    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(latest?.mode).toBe("stateless");
  });

  it("instances share one probe and the project switch probes the new key", async () => {
    await act(async () => {
      root.render(
        <>
          <Probe projectId="p" origin={gateway} />
          <Probe projectId="p" origin={gateway} capture={false} />
        </>,
      );
    });
    await flush();
    expect(mocks.status).toHaveBeenCalledTimes(1);

    await render({ projectId: "q", origin: gateway });
    expect(mocks.status).toHaveBeenCalledTimes(2);
    expect(mocks.status.mock.calls[1][0]).toMatchObject({ projectId: "q" });
  });
});
