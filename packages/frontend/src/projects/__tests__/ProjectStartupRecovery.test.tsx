// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "../../store";
import { ProjectAccessRecoveryBanner, StudioStartupGate } from "../../screens/StudioStartup";
import { ProjectAccessProvider, useProjectAccess } from "../ProjectAccessProvider";
import { ProjectStateProvider, useProjectState } from "../ProjectStateProvider";

const REMEMBERED_PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
const mocks = vi.hoisted(() => ({ create: vi.fn(), getSummaryResult: vi.fn() }));

vi.mock("../../lib/supabaseClient", () => ({ hasSupabaseConfig: true }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { projects: mocks } }));
vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => ({ user: { id: "startup-user" }, loading: false }) }));

function WorkspaceProbe() {
  const { activeProjectId } = useProjectState();
  const access = useProjectAccess();
  return <output data-project={activeProjectId} data-write={String(access.canWriteProject)} data-resolved={String(access.projectCapabilitiesResolved)} />;
}

describe("remembered project startup recovery", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    mocks.create.mockReset();
    mocks.getSummaryResult.mockReset();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, "", "/studio");
    useWorkspaceStore.setState({ projects: {}, activeProjectId: "" });
    window.localStorage.setItem("instafy.lastProjectId", REMEMBERED_PROJECT_ID);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    useWorkspaceStore.setState({ projects: {}, activeProjectId: "" });
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each(["empty", "different active project"])("recovers the remembered UUID with %s local state and no URL project", async (localState) => {
    if (localState === "different active project") {
      useWorkspaceStore.getState().createProject({ projectId: OTHER_PROJECT_ID, projectName: "Other space" });
    }
    mocks.getSummaryResult
      .mockResolvedValueOnce({ summary: null, notFound: false, forbidden: false, unauthorized: false })
      .mockResolvedValue({
        summary: {
          projectId: REMEMBERED_PROJECT_ID,
          projectName: "Remembered space",
          orgId: "remembered-org",
          orgName: "Team",
          effectiveRole: "viewer",
          canWrite: false,
        },
        notFound: false, forbidden: false, unauthorized: false,
      });

    await act(async () => root.render(
      <MemoryRouter initialEntries={["/studio"]}>
        <ProjectStateProvider>
          <ProjectAccessProvider>
            <StudioStartupGate><WorkspaceProbe /><ProjectAccessRecoveryBanner /></StudioStartupGate>
          </ProjectAccessProvider>
        </ProjectStateProvider>
      </MemoryRouter>,
    ));

    expect(container.querySelector('[data-testid="entry-loading-screen"]')).toBeNull();
    expect(container.querySelector("output")?.getAttribute("data-project")).toBe(REMEMBERED_PROJECT_ID);
    expect(container.querySelector("output")?.getAttribute("data-write")).toBe("false");
    expect(container.querySelector("output")?.getAttribute("data-resolved")).toBe("false");
    expect(container.querySelector("button")?.textContent).toBe("Retry");
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(1);
    expect(mocks.getSummaryResult).toHaveBeenLastCalledWith(REMEMBERED_PROJECT_ID, { signal: expect.any(AbortSignal) });

    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(mocks.getSummaryResult).toHaveBeenCalledTimes(2);
    expect(mocks.getSummaryResult).toHaveBeenLastCalledWith(REMEMBERED_PROJECT_ID, { signal: expect.any(AbortSignal) });
    expect(container.querySelector("output")?.getAttribute("data-resolved")).toBe("true");
    expect(container.querySelector("output")?.getAttribute("data-write")).toBe("false");
    expect(container.querySelector("button")).toBeNull();
    expect(useWorkspaceStore.getState().activeProjectId).toBe(REMEMBERED_PROJECT_ID);
    expect(useWorkspaceStore.getState().projects[REMEMBERED_PROJECT_ID]?.metadata.projectName).toBe("Remembered space");
    expect(useWorkspaceStore.getState().projects[REMEMBERED_PROJECT_ID]?.org.id).toBe("remembered-org");
    if (localState === "different active project") {
      expect(useWorkspaceStore.getState().projects[OTHER_PROJECT_ID]?.metadata.projectName).toBe("Other space");
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
