// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real status client and cache run here; only the token mint and the
// network are stubbed, so the status call reports signals as it does in
// production.
const mocks = vi.hoisted(() => ({ token: vi.fn() }));

vi.mock("../../services/runtimeController/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../services/runtimeController/core")>()),
  runtimeControllerEnabled: true,
  normalizeOriginEndpointForClient: (value: string) => value,
}));
vi.mock("../../services/runtimeController/origins", () => ({ requestOriginAccessToken: mocks.token }));

import { fetchWorkspaceGitStatusFromController } from "../../services/runtimeController/workspaceGit";
import {
  getCachedWorkspaceVersioning,
  noteVersioningSignal,
  probeWorkspaceVersioning,
  resetWorkspaceVersioningProbesForTests,
} from "../../services/runtimeController/workspaceVersioning";
import { resetWorkspaceVersioningCacheForTests } from "../../services/runtimeController/workspaceVersioningCache";
import { useWorkspaceVersioning, type WorkspaceVersioningState } from "../useWorkspaceVersioning";

const gateway = { originId: "gateway", mode: "hosted" };
const STATUS_URL = "https://controller.test/origin/gateway/git/status?limit=1";

function statusBody(stateless?: boolean) {
  return { supported: true, dirtyCount: 0, dirtyPaths: [], ...(stateless === undefined ? {} : { stateless }) };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function statusCalls() {
  return vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/git/status"));
}

let latest: WorkspaceVersioningState | null = null;

function Probe() {
  latest = useWorkspaceVersioning({ projectId: "p", origin: gateway });
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
    }
  });
}

describe("the probe's own status answer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetWorkspaceVersioningCacheForTests();
    resetWorkspaceVersioningProbesForTests();
    mocks.token.mockReset();
    mocks.token.mockResolvedValue({
      originId: "gateway",
      endpoint: "https://controller.test/origin/gateway",
      mode: "hosted",
      token: "t",
      expiresIn: 60,
      scopes: ["fs.read"],
      leaseId: null,
    });
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    latest = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("a legacy-to-stateless refresh sends exactly one /git/status, even if a follow-up would fail", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, statusBody()));
    await act(async () => {
      root.render(<Probe />);
    });
    await flush();
    expect(latest).toMatchObject({ mode: "legacy", resolved: true });
    expect(statusCalls()).toHaveLength(1);

    // The gateway now answers stateless; anything after that fails.
    vi.mocked(fetch)
      .mockResolvedValueOnce(json(200, statusBody(true)))
      .mockResolvedValue(new Response("down", { status: 503 }));
    let refreshed: unknown = null;
    await act(async () => {
      refreshed = await latest?.refresh();
    });
    await flush();

    expect(statusCalls()).toHaveLength(2);
    expect(String(statusCalls()[1][0])).toBe(STATUS_URL);
    expect(refreshed).toMatchObject({ mode: "stateless", stale: false });
    expect(getCachedWorkspaceVersioning("p", "gateway")).toMatchObject({ mode: "stateless", stale: false });
    expect(latest).toMatchObject({ mode: "stateless", resolved: true });
  });

  it("another call's stateless answer is still an outside signal", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, statusBody()));
    await probeWorkspaceVersioning({ projectId: "p", origin: gateway });
    vi.mocked(fetch).mockResolvedValueOnce(json(200, statusBody(true)));
    await fetchWorkspaceGitStatusFromController({ projectId: "p", originId: "gateway", routing: "default" });
    expect(getCachedWorkspaceVersioning("p", "gateway")).toMatchObject({ mode: "legacy", stale: true });
  });

  it("a failing probe after a contradicting signal never stores a fresh legacy entry", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json(200, statusBody()));
    await act(async () => {
      root.render(<Probe />);
    });
    await flush();

    vi.mocked(fetch).mockResolvedValue(new Response("down", { status: 503 }));
    await act(async () => {
      noteVersioningSignal("gateway", "committed");
    });
    await flush();

    // One re-probe for the signal, which fails; no loop, and no fresh legacy.
    expect(statusCalls()).toHaveLength(2);
    expect(getCachedWorkspaceVersioning("p", "gateway")).toMatchObject({ mode: "legacy", stale: true });
    await flush();
    expect(statusCalls()).toHaveLength(2);
  });
});
