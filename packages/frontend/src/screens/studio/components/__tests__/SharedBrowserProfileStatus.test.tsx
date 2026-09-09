// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedBrowserProfileStatusResult } from "../../../../services/runtimeController/browserProfiles";

const fetchStatus = vi.hoisted(() => vi.fn());
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { browserProfiles: { fetchStatus } },
}));

import { SharedBrowserProfileStatus } from "../SharedBrowserProfileStatus";

const runtimeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const otherRuntimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const savedAt = "2026-09-07T12:00:00.000Z";
const off: SharedBrowserProfileStatusResult = {
  success: true, status: { enabled: false, lastSavedAt: null, savedByRuntimeId: null },
};
const empty: SharedBrowserProfileStatusResult = {
  success: true, status: { enabled: true, lastSavedAt: null, savedByRuntimeId: null },
};
const saved: SharedBrowserProfileStatusResult = {
  success: true, status: { enabled: true, lastSavedAt: savedAt, savedByRuntimeId: runtimeId },
};

function deferred() {
  let resolve!: (value: SharedBrowserProfileStatusResult) => void;
  const promise = new Promise<SharedBrowserProfileStatusResult>((next) => { resolve = next; });
  return { resolve, promise };
}

describe("SharedBrowserProfileStatus", () => {
  let container: HTMLDivElement;
  let root: Root;
  let visibility: DocumentVisibilityState;
  const heading = () => container.querySelector('[role="status"]')?.textContent;
  const render = async (overrides: Partial<ComponentProps<typeof SharedBrowserProfileStatus>> = {}) => {
    await act(async () => root.render(
      <SharedBrowserProfileStatus active projectId="project-1" runtimeId={runtimeId} currentUserId="user-1" {...overrides} />,
    ));
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    fetchStatus.mockReset();
    fetchStatus.mockResolvedValue(off);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.useRealTimers();
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("distinguishes recovery off from sharing a live browser", async () => {
    await render();
    expect(fetchStatus).toHaveBeenCalledExactlyOnceWith("project-1");
    expect(heading()).toBe("Login recovery off");
    expect(container.textContent).toContain("This running browser can still be shared across devices.");
    expect(container.textContent).toContain("New login data is not being backed up.");
    expect(container.querySelector("time")).toBeNull();
  });

  it("does not call enabled-but-empty storage a recoverable login", async () => {
    fetchStatus.mockResolvedValue(empty);
    await render();
    expect(heading()).toBe("Login recovery enabled");
    expect(container.textContent).toContain("No saved snapshot yet. Login recovery is not ready.");
    expect(container.querySelector("time")).toBeNull();
  });

  it("identifies a completed save from this exact runtime and explains what it excludes", async () => {
    fetchStatus.mockResolvedValue(saved);
    await render();
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(savedAt);
    expect(container.textContent).toContain("Saved by this session.");
    expect(container.textContent).toContain("Snapshots contain shared cookies and site data, not open tabs or unfinished forms.");
    expect(container.textContent).toContain("Changes since the last successful save may be lost.");
  });

  it.each([otherRuntimeId, null])("does not claim another or unknown runtime's save is current: %s", async (savedByRuntimeId) => {
    fetchStatus.mockResolvedValue({ success: true, status: { enabled: true, lastSavedAt: savedAt, savedByRuntimeId } });
    await render();
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(savedAt);
    expect(container.textContent).toContain("Not confirmed as a save from this session.");
    expect(container.textContent).not.toContain("Saved by this session.");
  });

  it("keeps an older stored snapshot visible when recovery policy is off", async () => {
    fetchStatus.mockResolvedValue({ success: true, status: { enabled: false, lastSavedAt: savedAt, savedByRuntimeId: otherRuntimeId } });
    await render();
    expect(heading()).toBe("Login recovery off");
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(savedAt);
    expect(container.textContent).toContain("An older snapshot remains stored; recovery is disabled.");
  });

  it.each(["returned", "thrown"])("reports %s failures as unknown rather than off or saved", async (mode) => {
    if (mode === "returned") fetchStatus.mockResolvedValue({ success: false, error: "inert-controller-detail" });
    else fetchStatus.mockRejectedValue(new Error("inert-controller-detail"));
    await render();
    expect(heading()).toBe("Save status unavailable");
    expect(container.textContent).toContain("We cannot verify stored browser data.");
    expect(container.textContent).not.toContain("inert-controller-detail");
    expect(container.textContent).not.toContain("Login recovery off");
    expect(container.querySelector("time")).toBeNull();
  });

  it.each([{ active: false }, { currentUserId: null }])("does not render or poll when inactive or signed out: %j", async (props) => {
    await render(props);
    await act(async () => vi.advanceTimersByTime(120_000));
    expect(container.textContent).toBe("");
    expect(fetchStatus).not.toHaveBeenCalled();
  });

  it("does not fetch without a project", async () => {
    await render({ projectId: " " });
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(fetchStatus).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Login recovery off");
  });

  it("pauses hidden-page polling and resumes on visibility without overlapping requests", async () => {
    visibility = "hidden";
    const pending = deferred();
    fetchStatus.mockReturnValueOnce(pending.promise);
    await render();
    await act(async () => vi.advanceTimersByTime(90_000));
    expect(fetchStatus).not.toHaveBeenCalled();
    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetchStatus).toHaveBeenCalledOnce();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(60_000);
    });
    expect(fetchStatus).toHaveBeenCalledOnce();
    await act(async () => pending.resolve(saved));
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    visibility = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(90_000);
    });
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });

  it.each([{ currentUserId: "user-2" }, { projectId: "project-2" }])("ignores late metadata from a previous account or project: %j", async (next) => {
    const old = deferred();
    const current = deferred();
    fetchStatus.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    await render();
    await render(next);
    expect(heading()).toBe("Checking saved browser data…");
    await act(async () => current.resolve(off));
    expect(heading()).toBe("Login recovery off");
    await act(async () => old.resolve(saved));
    expect(heading()).toBe("Login recovery off");
    expect(container.querySelector("time")).toBeNull();
  });

  it("does not reuse a previously successful observation after closing and reopening", async () => {
    fetchStatus.mockResolvedValueOnce(saved);
    await render();
    expect(container.querySelector("time")).not.toBeNull();
    await render({ active: false });
    const fresh = deferred();
    fetchStatus.mockReturnValueOnce(fresh.promise);
    await render();
    expect(heading()).toBe("Checking saved browser data…");
    expect(container.querySelector("time")).toBeNull();
    await act(async () => fresh.resolve(empty));
    expect(container.textContent).toContain("No saved snapshot yet.");
  });

  it("ignores a previous opening's pending response and stops work after unmount", async () => {
    const old = deferred();
    const fresh = deferred();
    fetchStatus.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    await render();
    await render({ active: false });
    await render();
    await act(async () => old.resolve(saved));
    expect(heading()).toBe("Checking saved browser data…");
    expect(container.querySelector("time")).toBeNull();
    await act(async () => root.render(null));
    await act(async () => {
      fresh.resolve(saved);
      vi.advanceTimersByTime(120_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.textContent).toBe("");
    expect(fetchStatus).toHaveBeenCalledTimes(2);
  });
});
