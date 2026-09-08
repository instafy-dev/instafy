// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPickerPanel } from "../ProjectPickerPanel";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(), switchProject: vi.fn(), openPanelTab: vi.fn(),
  projects: vi.fn(), merged: vi.fn(),
}));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: mocks.projects }));
vi.mock("../../../../projects/useMergedControllerProjects", () => ({ useMergedControllerProjects: mocks.merged }));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => ({ projectAccessBlocked: false }) }));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => ({ openPanelTab: mocks.openPanelTab }) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../../../runtime/useRuntime", () => ({ useRuntime: () => ({ runtime: { controllerProjectMissing: false } }) }));
vi.mock("../../workspaceControls", () => ({ useWorkspaceControls: () => ({}) }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => false }));
vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { core: { enabled: false } } }));

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const alpha = { id: A, name: "Alpha", orgId: null, orgName: "Personal" };
const beta = { id: B, name: "Beta", orgId: null, orgName: "Personal" };

describe("ProjectPickerPanel overview navigation", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    window.history.replaceState({ idx: 0, key: "overview-visit" }, "", `/studio?projectId=${A}&panel=projects&conversationId=old-chat&conversationControllerId=old-controller&jobId=old-job&browserRuntimeId=old-browser`);
    mocks.merged.mockReturnValue({ mergedProjects: [alpha, beta], remoteLoading: false, remoteError: null, remoteRefreshing: false });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); document.body.replaceChildren();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each([false, true])("pushes a clean space destination without replacing the overview (cached=%s)", async cached => {
    mocks.projects.mockReturnValue({ projectList: cached ? [alpha, beta] : [alpha], activeProjectId: A,
      createProject: mocks.createProject, switchProject: mocks.switchProject });
    const previousLength = window.history.length;
    await act(async () => root.render(<BrowserRouter><ProjectPickerPanel onCreateProject={() => {}} searchTerm="" onSearchTermChange={() => {}} /></BrowserRouter>));
    const target = container.querySelector<HTMLButtonElement>(`[data-testid="project-picker-card-${B}"]`);
    expect(target).not.toBeNull();
    await act(async () => target!.click());
    expect(Object.fromEntries(new URLSearchParams(window.location.search))).toEqual({ projectId: B });
    expect(window.history.state.idx).toBe(1);
    expect(window.history.state.key).not.toBe("overview-visit");
    expect(window.history.length).toBe(previousLength + 1);
    expect(mocks.createProject).not.toHaveBeenCalled();
    expect(mocks.switchProject).not.toHaveBeenCalled();
    expect(mocks.openPanelTab).not.toHaveBeenCalled();
  });
});
