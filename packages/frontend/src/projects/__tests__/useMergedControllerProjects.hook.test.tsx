// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { MutableRefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerProjectSummary } from "../../sdk/instafy";

const listProjectsMock = vi.hoisted(() => vi.fn());
const listOrganizationsMock = vi.hoisted(() => vi.fn());
const getSummaryMock = vi.hoisted(() => vi.fn());
const authStateMock = vi.hoisted(() => ({
  loading: false,
  session: { access_token: "token-123" },
  user: { id: "user-1" },
}));

vi.mock("../../sdk/instafy", () => ({
  controllerClient: {
    core: { enabled: true },
    projects: {
      listResult: listProjectsMock,
      getSummaryResult: getSummaryMock,
    },
    organizations: {
      list: listOrganizationsMock,
    },
  },
}));

vi.mock("../../providers/AuthProvider", () => ({
  useAuth: () => authStateMock,
}));

import { useMergedControllerProjects } from "../useMergedControllerProjects";
import { PROJECT_ACCESS_REFRESH_EVENT } from "../projectAccessEvents";

type HookResult = ReturnType<typeof useMergedControllerProjects>;

function Harness({ resultRef, orgId = null, requestedProjectId = null }: {
  resultRef: MutableRefObject<HookResult | null>;
  orgId?: string | null;
  requestedProjectId?: string | null;
}) {
  resultRef.current = useMergedControllerProjects({
    localProjects: [],
    orgId,
    requestedProjectId,
  });
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const projectA = { projectId: "project-a", orgId: "org-a", projectName: "Space A" };
const projectB = { projectId: "project-b", orgId: "org-b", projectName: "Space B" };

function successfulProjects(projects: ControllerProjectSummary[]) {
  return { status: "success" as const, projects };
}

describe("useMergedControllerProjects accessible discovery", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listProjectsMock.mockReset();
    listOrganizationsMock.mockReset().mockResolvedValue([]);
    getSummaryMock.mockReset();
    authStateMock.loading = false;
    authStateMock.session = { access_token: "token-123" };
    authStateMock.user = { id: "user-1" };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("loads project-only memberships from personal scope without enumerating organizations", async () => {
    listProjectsMock.mockResolvedValue(successfulProjects([
      {
        projectId: "11111111-1111-4111-8111-111111111111",
        projectName: "Directly shared space",
        orgId: "22222222-2222-4222-8222-222222222222",
        orgName: "External team",
      },
    ]));
    const resultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });

    expect(listProjectsMock).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) });
    expect(listOrganizationsMock).not.toHaveBeenCalled();
    expect(resultRef.current?.remoteLoadedScope).toBeNull();
    expect(resultRef.current?.mergedProjects).toEqual([
      expect.objectContaining({
        id: "11111111-1111-4111-8111-111111111111",
        name: "Directly shared space",
        orgId: "22222222-2222-4222-8222-222222222222",
        isRemoteOnly: true,
      }),
    ]);
  });

  it("falls back to legacy organization discovery while GET /projects is rolling out", async () => {
    listProjectsMock
      .mockResolvedValueOnce({ status: "unsupported" })
      .mockResolvedValueOnce(successfulProjects([
        {
          projectId: "33333333-3333-4333-8333-333333333333",
          projectName: "Existing team space",
          orgId: "44444444-4444-4444-8444-444444444444",
          orgName: "Existing team",
        },
      ]));
    listOrganizationsMock.mockResolvedValue([
      { id: "44444444-4444-4444-8444-444444444444" },
    ]);
    const resultRef: MutableRefObject<HookResult | null> = { current: null };

    await act(async () => {
      root.render(<Harness resultRef={resultRef} />);
    });

    expect(listProjectsMock).toHaveBeenNthCalledWith(1, { signal: expect.any(AbortSignal) });
    expect(listProjectsMock).toHaveBeenNthCalledWith(2, {
      orgId: "44444444-4444-4444-8444-444444444444",
      signal: expect.any(AbortSignal),
    });
    expect(resultRef.current?.mergedProjects).toEqual([
      expect.objectContaining({
        id: "33333333-3333-4333-8333-333333333333",
        name: "Existing team space",
        isRemoteOnly: true,
      }),
    ]);
  });

  it("switches warm organizations immediately without repeating accessible discovery", async () => {
    listProjectsMock.mockResolvedValue(successfulProjects([projectA, projectB]));
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-a" />); });

    for (const [orgId, project] of [["org-b", projectB], ["org-a", projectA]] as const) {
      await act(async () => { root.render(<Harness resultRef={resultRef} orgId={orgId} />); });
      expect(resultRef.current?.remoteProjects).toEqual([project]);
      expect(resultRef.current?.remoteLoadedScope).toBe(orgId);
      expect(resultRef.current?.remoteLoading).toBe(false);
    }
    expect(listProjectsMock).toHaveBeenCalledTimes(1);
  });

  it("keeps one initial discovery request when the selected organization changes", async () => {
    const discovery = deferred<ReturnType<typeof successfulProjects>>();
    listProjectsMock.mockReturnValue(discovery.promise);
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-a" />); });
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-b" />); });
    await act(async () => { discovery.resolve(successfulProjects([projectA, projectB])); });

    expect(listProjectsMock).toHaveBeenCalledTimes(1);
    expect(resultRef.current?.remoteProjects).toEqual([projectB]);
    expect(resultRef.current?.remoteLoadedScope).toBe("org-b");
  });

  it("revalidates after token refresh without blocking cached organization switches", async () => {
    const refresh = deferred<ReturnType<typeof successfulProjects>>();
    listProjectsMock.mockResolvedValueOnce(successfulProjects([projectA, projectB])).mockReturnValueOnce(refresh.promise);
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-a" />); });
    authStateMock.session = { access_token: "refreshed-token" };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-b" />); });

    expect(listProjectsMock).toHaveBeenCalledTimes(2);
    expect(resultRef.current?.remoteProjects).toEqual([projectB]);
    expect(resultRef.current?.remoteLoadedScope).toBe("org-b");
    expect(resultRef.current?.remoteLoading).toBe(false);
    await act(async () => { refresh.resolve(successfulProjects([{ ...projectB, projectName: "Renamed B" }])); });
    expect(resultRef.current?.remoteProjects[0]?.projectName).toBe("Renamed B");
  });

  it("refreshes discovery on focus while retaining the current list", async () => {
    const refresh = deferred<ReturnType<typeof successfulProjects>>();
    listProjectsMock.mockResolvedValueOnce(successfulProjects([projectA])).mockReturnValueOnce(refresh.promise);
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} />); });
    await act(async () => { window.dispatchEvent(new Event("focus")); });

    expect(listProjectsMock).toHaveBeenCalledTimes(2);
    expect(resultRef.current?.remoteLoading).toBe(false);
    expect(resultRef.current?.remoteProjects).toEqual([projectA]);
    await act(async () => { refresh.resolve(successfulProjects([projectB])); });
    expect(resultRef.current?.remoteProjects).toEqual([projectB]);
  });

  it("settles a failed cold discovery and retries on the next foreground visit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    listProjectsMock.mockRejectedValueOnce(new Error("controller unavailable")).mockResolvedValueOnce(successfulProjects([projectA]));
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    try {
      await act(async () => { root.render(<Harness resultRef={resultRef} />); });
      expect(resultRef.current?.remoteLoading).toBe(false);
      expect(resultRef.current?.remoteProjects).toEqual([]);
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(resultRef.current?.remoteProjects).toEqual([projectA]);
      expect(listProjectsMock).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  it("retains warm discovery on a reported error and accepts authoritative empty results", async () => {
    listProjectsMock.mockResolvedValueOnce(successfulProjects([projectA, projectB]))
      .mockResolvedValueOnce({ status: "error" }).mockResolvedValueOnce(successfulProjects([]));
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-a" />); });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-b" />); });

    expect(resultRef.current?.remoteProjects).toEqual([projectB]);
    expect(resultRef.current?.remoteLoading).toBe(false);
    expect(resultRef.current?.remoteLoadedScope).toBe("org-b");
    expect(listOrganizationsMock).not.toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(resultRef.current?.remoteProjects).toEqual([]);
    expect(resultRef.current?.remoteLoadedScope).toBe("org-b");
    expect(listOrganizationsMock).not.toHaveBeenCalled();
  });

  it("settles reported cold errors without treating them as unsupported endpoints", async () => {
    listProjectsMock.mockResolvedValue({ status: "error" });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-a" />); });

    expect(resultRef.current?.remoteLoading).toBe(false);
    expect(resultRef.current?.remoteLoadedScope).toBeNull();
    expect(listOrganizationsMock).not.toHaveBeenCalled();
  });

  it("recovers a failed first discovery for the requested team without a foreground event", async () => {
    vi.useFakeTimers();
    listProjectsMock.mockResolvedValueOnce({ status: "error" })
      .mockResolvedValueOnce(successfulProjects([projectA, projectB]));
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-a" />); });
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-b" />); });

    expect(resultRef.current?.remoteLoadedScope).toBeNull();
    expect(resultRef.current?.remoteError).toBe("Couldn't load spaces.");
    expect(resultRef.current?.remoteRefreshing).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(999); });
    expect(listProjectsMock).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(listProjectsMock).toHaveBeenCalledTimes(2);
    expect(resultRef.current?.remoteProjects).toEqual([projectB]);
    expect(resultRef.current?.remoteLoadedScope).toBe("org-b");
    expect(resultRef.current?.remoteError).toBeNull();
    expect(resultRef.current?.remoteLoading).toBe(false);
  });

  it("bounds automatic retries and allows explicit recovery after they are exhausted", async () => {
    vi.useFakeTimers();
    listProjectsMock.mockResolvedValue({ status: "error" });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-b" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(listProjectsMock).toHaveBeenCalledTimes(4);
    expect(resultRef.current?.remoteLoadedScope).toBeNull();
    expect(resultRef.current?.remoteError).toBe("Couldn't load spaces.");
    const retry = deferred<ReturnType<typeof successfulProjects>>();
    listProjectsMock.mockReturnValueOnce(retry.promise);
    await act(async () => {
      resultRef.current?.retryRemoteProjects();
      resultRef.current?.retryRemoteProjects();
    });
    expect(listProjectsMock).toHaveBeenCalledTimes(5);
    expect(resultRef.current?.remoteRefreshing).toBe(true);
    expect(resultRef.current?.remoteError).toBe("Couldn't load spaces.");
    await act(async () => { retry.resolve(successfulProjects([projectB])); });

    expect(resultRef.current?.remoteProjects).toEqual([projectB]);
    expect(resultRef.current?.remoteError).toBeNull();
    expect(resultRef.current?.remoteRefreshing).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["personal spaces", "an empty personal scope"])("resolves a requested personal scope only after discovery succeeds with %s", async (resultKind) => {
    vi.useFakeTimers();
    const firstRead = deferred<{ status: "error" }>();
    const retry = deferred<ReturnType<typeof successfulProjects>>();
    const personalProjects = resultKind === "personal spaces"
      ? [{ projectId: "personal-project", projectName: "Personal space", orgId: null }]
      : [];
    listProjectsMock.mockReturnValueOnce(firstRead.promise).mockReturnValueOnce(retry.promise);
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-a" />); });
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId={null} />); });

    expect(resultRef.current?.remoteLoadedScope).toBeNull();
    expect(resultRef.current?.remoteDiscoveryResolved).toBe(false);
    await act(async () => { firstRead.resolve({ status: "error" }); });

    // A settled failure is no longer busy, but must not consume the pending
    // personal selection as though an authoritative empty list had arrived.
    expect(resultRef.current?.remoteLoading).toBe(false);
    expect(resultRef.current?.remoteDiscoveryResolved).toBe(false);
    expect(resultRef.current?.remoteError).toBe("Couldn't load spaces.");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(resultRef.current?.remoteRefreshing).toBe(true);
    expect(resultRef.current?.remoteDiscoveryResolved).toBe(false);

    await act(async () => { retry.resolve(successfulProjects(personalProjects)); });

    expect(resultRef.current?.remoteLoadedScope).toBeNull();
    expect(resultRef.current?.remoteDiscoveryResolved).toBe(true);
    expect(resultRef.current?.remoteProjects).toEqual(personalProjects);
    expect(resultRef.current?.remoteError).toBeNull();
  });

  it("keeps a warm list visible throughout a failed refresh and its retry", async () => {
    vi.useFakeTimers();
    const retry = deferred<ReturnType<typeof successfulProjects>>();
    listProjectsMock.mockResolvedValueOnce(successfulProjects([projectA, projectB]))
      .mockResolvedValueOnce({ status: "error" }).mockReturnValueOnce(retry.promise);
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-a" />); });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-b" />); });

    expect(resultRef.current?.remoteProjects).toEqual([projectB]);
    expect(resultRef.current?.remoteError).toBe("Couldn't refresh spaces. Your saved list is still shown.");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(resultRef.current?.remoteRefreshing).toBe(true);
    expect(resultRef.current?.remoteLoading).toBe(false);
    expect(resultRef.current?.remoteProjects).toEqual([projectB]);
    await act(async () => { retry.resolve(successfulProjects([projectB])); });
    expect(resultRef.current?.remoteError).toBeNull();
  });

  it("cancels a pending discovery on account change and ignores its late response", async () => {
    const first = deferred<ReturnType<typeof successfulProjects>>();
    listProjectsMock.mockReturnValueOnce(first.promise).mockResolvedValueOnce(successfulProjects([projectB]));
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-a" />); });
    const signal = listProjectsMock.mock.calls[0]?.[0].signal as AbortSignal;
    authStateMock.user = { id: "user-2" };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-b" />); });
    expect(signal.aborted).toBe(true);
    await act(async () => { first.resolve(successfulProjects([projectA])); });

    expect(resultRef.current?.remoteProjects).toEqual([projectB]);
    expect(resultRef.current?.remoteError).toBeNull();
  });

  it("cancels scheduled retries when discovery unmounts", async () => {
    vi.useFakeTimers();
    listProjectsMock.mockResolvedValue({ status: "error" });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} />); });
    await act(async () => { root.render(null); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(listProjectsMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["organizations", "projects"])("retains warm discovery when legacy %s discovery fails", async (failureSource) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    listProjectsMock.mockResolvedValueOnce(successfulProjects([projectA, projectB]))
      .mockResolvedValueOnce({ status: "unsupported" });
    if (failureSource === "organizations") {
      listOrganizationsMock.mockRejectedValueOnce(new Error("org discovery unavailable"));
    } else {
      listOrganizationsMock.mockResolvedValueOnce([{ id: "org-a" }, { id: "org-b" }]);
      listProjectsMock.mockResolvedValueOnce(successfulProjects([])).mockResolvedValueOnce({ status: "error" });
    }
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    try {
      await act(async () => { root.render(<Harness resultRef={resultRef} />); });
      await act(async () => { window.dispatchEvent(new Event("focus")); });
      expect(resultRef.current?.remoteProjects).toEqual([projectA, projectB]);
      expect(resultRef.current?.remoteLoading).toBe(false);
      expect(listOrganizationsMock).toHaveBeenCalledWith({ throwOnError: true, signal: expect.any(AbortSignal) });
    } finally {
      warn.mockRestore();
    }
  });

  it("isolates cached and late discovery and requested-project results between users", async () => {
    const oldRefresh = deferred<ReturnType<typeof successfulProjects>>();
    const nextDiscovery = deferred<ReturnType<typeof successfulProjects>>();
    const oldRequested = deferred<{ summary: typeof projectA }>();
    const nextRequested = deferred<{ summary: typeof projectA }>();
    listProjectsMock.mockResolvedValueOnce(successfulProjects([projectA]))
      .mockReturnValueOnce(oldRefresh.promise).mockReturnValueOnce(nextDiscovery.promise);
    getSummaryMock.mockResolvedValueOnce({ summary: projectA })
      .mockReturnValueOnce(oldRequested.promise).mockReturnValueOnce(nextRequested.promise);
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} requestedProjectId="project-a" />); });
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    authStateMock.user = { id: "user-2" };
    await act(async () => { root.render(<Harness resultRef={resultRef} requestedProjectId="project-a" />); });

    expect(resultRef.current?.remoteProjects).toEqual([]);
    expect(resultRef.current?.remoteLoading).toBe(true);
    expect(resultRef.current?.remoteDiscoveryResolved).toBe(false);
    await act(async () => {
      nextDiscovery.resolve(successfulProjects([projectB]));
      nextRequested.resolve({ summary: projectB });
    });
    await act(async () => {
      oldRefresh.resolve(successfulProjects([projectA]));
      oldRequested.resolve({ summary: projectA });
    });
    expect(resultRef.current?.mergedProjects.map((project) => project.id)).toEqual(["project-b"]);
  });

  it.each(["focus", PROJECT_ACCESS_REFRESH_EVENT])("revalidates requested project access on %s", async (eventName) => {
    listProjectsMock.mockResolvedValue(successfulProjects([]));
    getSummaryMock.mockResolvedValueOnce({ summary: projectA })
      .mockResolvedValueOnce({ summary: null, notFound: false, forbidden: true, unauthorized: false });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} requestedProjectId="project-a" />); });
    expect(resultRef.current?.remoteProjects).toEqual([projectA]);
    await act(async () => { window.dispatchEvent(new Event(eventName)); });

    expect(getSummaryMock).toHaveBeenCalledTimes(2);
    expect(resultRef.current?.remoteProjects).toEqual([]);
    expect(resultRef.current?.mergedProjects).toEqual([]);
  });

  it("preserves a directly shared requested project during a transient refresh failure", async () => {
    listProjectsMock.mockResolvedValue(successfulProjects([]));
    getSummaryMock.mockResolvedValueOnce({ summary: projectA })
      .mockResolvedValueOnce({ summary: null, notFound: false, forbidden: false, unauthorized: false });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} requestedProjectId="project-a" />); });
    await act(async () => { window.dispatchEvent(new Event("focus")); });

    expect(resultRef.current?.remoteProjects).toEqual([projectA]);
    expect(resultRef.current?.remoteLoading).toBe(false);
  });

  it("ignores a requested summary fetched before an in-flight access invalidation", async () => {
    const initialSummary = deferred<{ summary: typeof projectA }>();
    listProjectsMock.mockResolvedValue(successfulProjects([]));
    getSummaryMock.mockReturnValueOnce(initialSummary.promise)
      .mockResolvedValueOnce({ summary: null, notFound: true, forbidden: false, unauthorized: false });
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} requestedProjectId="project-a" />); });
    await act(async () => { window.dispatchEvent(new Event(PROJECT_ACCESS_REFRESH_EVENT)); });
    await act(async () => { initialSummary.resolve({ summary: projectA }); });

    expect(getSummaryMock).toHaveBeenCalledTimes(2);
    expect(resultRef.current?.remoteProjects).toEqual([]);
  });

  it("revalidates an access change that arrives during a discovery request", async () => {
    const discovery = deferred<ReturnType<typeof successfulProjects>>();
    listProjectsMock.mockReturnValueOnce(discovery.promise).mockResolvedValueOnce(successfulProjects([projectB]));
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} />); });
    await act(async () => { window.dispatchEvent(new Event(PROJECT_ACCESS_REFRESH_EVENT)); });
    await act(async () => { discovery.resolve(successfulProjects([projectA])); });

    expect(listProjectsMock).toHaveBeenCalledTimes(2);
    expect(resultRef.current?.remoteProjects).toEqual([projectB]);
  });

  it("reuses legacy discovery when switching between organizations", async () => {
    listProjectsMock.mockResolvedValueOnce({ status: "unsupported" })
      .mockResolvedValueOnce(successfulProjects([projectA])).mockResolvedValueOnce(successfulProjects([projectB]));
    listOrganizationsMock.mockResolvedValue([{ id: "org-a" }, { id: "org-b" }]);
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-a" />); });
    await act(async () => { root.render(<Harness resultRef={resultRef} orgId="org-b" />); });

    expect(listProjectsMock).toHaveBeenCalledTimes(3);
    expect(listOrganizationsMock).toHaveBeenCalledTimes(1);
    expect(listProjectsMock).toHaveBeenNthCalledWith(2, { orgId: "org-a", signal: expect.any(AbortSignal) });
    expect(listProjectsMock).toHaveBeenNthCalledWith(3, { orgId: "org-b", signal: expect.any(AbortSignal) });
    expect(resultRef.current?.remoteProjects).toEqual([projectB]);
    expect(resultRef.current?.remoteLoading).toBe(false);
  });
});
