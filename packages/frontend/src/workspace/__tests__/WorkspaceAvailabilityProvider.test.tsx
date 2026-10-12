// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceAvailabilityProvider, useWorkspaceAvailability, type WorkspaceAvailabilityScope } from "../WorkspaceAvailabilityProvider";
import { WorkspaceAvailabilityBanner } from "../WorkspaceAvailabilityBanner";

const mocks = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock("../../services/runtimeController/workspaceAvailabilityProbe", () => ({ probeWorkspaceAvailability: mocks.probe }));
let latest: ReturnType<typeof useWorkspaceAvailability>;
function Consumer() {
  latest = useWorkspaceAvailability();
  return <><WorkspaceAvailabilityBanner /><div data-testid="studio-context-workspace-focus" tabIndex={-1}>Content</div></>;
}
describe("shared workspace availability", () => {
  let root: Root;
  let container: HTMLDivElement;
  const scope: WorkspaceAvailabilityScope = { projectId: "a", originId: "origin-a", routing: "default" };
  const render = async (value = scope) => {
    await act(async () => root.render(<WorkspaceAvailabilityProvider scope={value}><Consumer /></WorkspaceAvailabilityProvider>));
  };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    mocks.probe.mockReset().mockResolvedValue({ kind: "available" });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    container = document.createElement("div"); document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    vi.useRealTimers(); vi.restoreAllMocks();
  });
  it("does not probe a healthy page or promote feature errors to a shared outage", async () => {
    await render();
    expect(mocks.probe).not.toHaveBeenCalled();
    for (const kind of ["available", "unknown"]) {
      mocks.probe.mockResolvedValue({ kind });
      await act(async () => latest.retry());
      expect(latest.issue).toBeNull();
    }
    expect(container.querySelector('[data-testid="workspace-availability-banner"]')).toBeNull();
  });
  it("coalesces failures from several screens into one probe and one notice", async () => {
    let resolve!: (value: { kind: string }) => void;
    mocks.probe.mockReturnValue(new Promise((done) => { resolve = done; }));
    await render();
    await act(async () => { latest.reportFailure(); latest.reportFailure(); });
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    await act(async () => resolve({ kind: "connection" }));
    expect(container.querySelectorAll('[data-testid="workspace-availability-banner"]')).toHaveLength(1);
    expect(latest.issue?.kind).toBe("connection");
    await act(async () => latest.reportFailure());
    expect(mocks.probe).toHaveBeenCalledTimes(1);
  });
  it("rechecks a confirmed outage and signals consumers only after recovery", async () => {
    mocks.probe.mockResolvedValueOnce({ kind: "unavailable" }).mockResolvedValue({ kind: "available" });
    await render();
    await act(async () => latest.reportFailure());
    expect(latest.recoveryVersion).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(latest.issue).toBeNull(); expect(latest.recoveryVersion).toBe(1);
    expect(mocks.probe).toHaveBeenLastCalledWith({ projectId: "a", originId: "origin-a", runtimeId: null, routing: "default" });
    await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
    expect(mocks.probe).toHaveBeenCalledTimes(2);
  });
  it("keeps a confirmed outage for an inconclusive probe, without treating it as success", async () => {
    mocks.probe.mockResolvedValueOnce({ kind: "connection" }).mockResolvedValue({ kind: "unknown" });
    await render(); await act(async () => latest.reportFailure()); await act(async () => latest.retry());
    expect(latest.issue?.kind).toBe("connection"); expect(latest.recoveryVersion).toBe(0);
  });
  it("does not loop unauthorized requests", async () => {
    mocks.probe.mockResolvedValue({ kind: "access" });
    await render(); await act(async () => latest.reportFailure());
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Couldn’t access workspace files.");
  });
  it("hides the previous space's issue immediately and ignores late responses", async () => {
    let resolve!: (value: { kind: string }) => void;
    mocks.probe.mockReturnValue(new Promise((done) => { resolve = done; }));
    await render(); await act(async () => latest.reportFailure());
    const oldReport = latest.reportFailure;
    await render({ projectId: "b", routing: "default", originId: "origin-b" });
    await act(async () => { resolve({ kind: "access" }); oldReport(); });
    expect(latest.issue).toBeNull(); expect(latest.checking).toBe(false);
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    mocks.probe.mockResolvedValue({ kind: "unavailable" });
    await act(async () => latest.reportFailure());
    expect(latest.issue?.kind).toBe("unavailable");
  });
  it("responds to reconnection while preserving Retry focus during the request", async () => {
    mocks.probe.mockResolvedValue({ kind: "connection" });
    await render(); await act(async () => latest.reportFailure());
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="workspace-availability-retry"]')!;
    await act(async () => retry.focus());
    let resolve!: (value: { kind: string }) => void;
    mocks.probe.mockReturnValue(new Promise((done) => { resolve = done; }));
    await act(async () => { retry.click(); retry.click(); });
    expect(mocks.probe).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(retry);
    await act(async () => resolve({ kind: "available" }));
    expect(document.activeElement?.getAttribute("data-testid")).toBe("studio-context-workspace-focus");
  });
  it("resumes on browser reconnection but skips probes while hidden", async () => {
    mocks.probe.mockResolvedValueOnce({ kind: "connection" }).mockResolvedValue({ kind: "available" });
    await render(); await act(async () => latest.reportFailure());
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(latest.issue).toBeNull(); expect(latest.recoveryVersion).toBe(1);
  });
});
