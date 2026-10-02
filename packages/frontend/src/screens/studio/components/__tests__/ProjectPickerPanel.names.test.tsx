// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPickerPanel } from "../ProjectPickerPanel";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(), switchProject: vi.fn(), getSummaryResult: vi.fn(),
  projects: vi.fn(), merged: vi.fn(), controllerProjectMissing: false,
}));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: mocks.projects }));
vi.mock("../../../../projects/useMergedControllerProjects", () => ({ useMergedControllerProjects: mocks.merged }));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => ({ projectAccessBlocked: false }) }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => ({ openPanelTab: vi.fn() }) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ runtime: { controllerProjectMissing: mocks.controllerProjectMissing } }),
}));
vi.mock("../../workspaceControls", () => ({ useWorkspaceControls: () => ({}) }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => false }));
vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { core: { enabled: false }, projects: { getSummaryResult: mocks.getSummaryResult } },
}));

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const alpha = { id: A, name: "Alpha", orgId: null, orgName: "Personal" };
// A space this device has not opened: the merged list shows the placeholder
// words for its missing name.
const untitled = { id: B, name: "Untitled space", orgId: null, orgName: "Personal" };

describe("ProjectPickerPanel unnamed spaces", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.controllerProjectMissing = false;
    mocks.projects.mockReturnValue({ projectList: [alpha], activeProjectId: A,
      createProject: mocks.createProject, switchProject: mocks.switchProject });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); document.body.replaceChildren();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render() {
    await act(async () => root.render(<BrowserRouter><ProjectPickerPanel onCreateProject={() => {}} searchTerm="" onSearchTermChange={() => {}} /></BrowserRouter>));
  }

  it("keeps an unnamed space unnamed when its settings open from the list", async () => {
    window.history.replaceState(null, "", `/studio?projectId=${A}&panel=projects`);
    mocks.merged.mockReturnValue({ mergedProjects: [alpha, untitled], remoteLoading: false, remoteError: null, remoteRefreshing: false });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(`[data-testid="project-picker-card-menu-button-${B}"]`)!.click());
    const settings = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((node) => node.textContent === "Settings");
    expect(settings).toBeDefined();
    await act(async () => settings!.click());
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: B, projectName: undefined }));
  });

  it("keeps a requested space unnamed instead of naming it after its id", async () => {
    window.history.replaceState(null, "", `/studio?projectId=${B}&panel=projects`);
    mocks.controllerProjectMissing = true;
    mocks.merged.mockReturnValue({ mergedProjects: [alpha], remoteLoading: false, remoteError: null, remoteRefreshing: false });
    mocks.getSummaryResult.mockResolvedValue({ summary: { projectId: B, projectName: null, orgId: null, orgName: null } });
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="project-missing-open-requested"]')!.click());
    expect(mocks.getSummaryResult).toHaveBeenCalledWith(B);
    expect(mocks.createProject).toHaveBeenCalledWith(expect.objectContaining({ projectId: B, projectName: undefined }));
  });
});
