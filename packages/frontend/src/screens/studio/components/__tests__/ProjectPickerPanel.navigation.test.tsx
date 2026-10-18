// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectPickerPanel } from "../ProjectPickerPanel";

const mocks = vi.hoisted(() => ({
  createProject: vi.fn(), switchProject: vi.fn(), openPanelTab: vi.fn(),
  projects: vi.fn(), merged: vi.fn(),
  access: { projectAccessBlocked: false, projectAccessDeleted: false },
}));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: mocks.projects }));
vi.mock("../../../../projects/useMergedControllerProjects", () => ({ useMergedControllerProjects: mocks.merged }));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => mocks.access }));
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
    mocks.access = { projectAccessBlocked: false, projectAccessDeleted: false };
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

  it("says the list is still loading while only the spaces this browser knows are shown", async () => {
    mocks.projects.mockReturnValue({ projectList: [alpha], activeProjectId: A,
      createProject: mocks.createProject, switchProject: mocks.switchProject });
    mocks.merged.mockReturnValue({ mergedProjects: [alpha], remoteLoading: true, remoteError: null, remoteRefreshing: false });
    const render = () => act(async () => root.render(<BrowserRouter><ProjectPickerPanel onCreateProject={() => {}} searchTerm="" onSearchTermChange={() => {}} /></BrowserRouter>));
    const loadingStatus = () => container.querySelector('[data-testid="project-picker-discovery-loading"]');
    await render();
    expect(container.querySelector(`[data-testid="project-picker-card-${A}"]`)).not.toBeNull();
    expect(loadingStatus()?.getAttribute("role")).toBe("status");
    expect(loadingStatus()?.textContent).toBe("Loading spaces…");

    mocks.merged.mockReturnValue({ mergedProjects: [alpha, beta], remoteLoading: false, remoteError: null, remoteRefreshing: false });
    await render();
    expect(container.querySelector(`[data-testid="project-picker-card-${B}"]`)).not.toBeNull();
    expect(loadingStatus()).toBeNull();
  });

  it.each([
    ["no active space", [], null, { orgId: null, orgName: null }],
    ["a space in a team", [{ ...alpha, orgId: "team-1", orgName: "Acme" }], A, { orgId: "team-1", orgName: "Acme" }],
  ])("creates a space with %s without sending a display label as a team", async (_label, projectList, activeProjectId, expectedOrg) => {
    // The empty Spaces page used to send its "Personal" heading, and the
    // controller minted a second personal team for a user who had one.
    window.history.replaceState(null, "", "/studio?panel=projects");
    const onCreateProject = vi.fn();
    mocks.projects.mockReturnValue({ projectList, activeProjectId,
      createProject: mocks.createProject, switchProject: mocks.switchProject });
    mocks.merged.mockReturnValue({ mergedProjects: projectList, remoteLoading: false, remoteError: null, remoteRefreshing: false });
    await act(async () => root.render(<BrowserRouter><ProjectPickerPanel onCreateProject={onCreateProject} searchTerm="" onSearchTermChange={() => {}} /></BrowserRouter>));
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="project-picker-new-project"]')!.click());
    const nameInput = container.querySelector<HTMLInputElement>('[data-testid="project-picker-new-project-name"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(nameInput, "My bookkeeping");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => nameInput.form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(onCreateProject).toHaveBeenCalledExactlyOnceWith("My bookkeeping", expectedOrg);
  });

  it.each([
    [false, "Space not found", true],
    [true, "This space was deleted", false],
  ])("names a blocked space deleted=%s plainly and offers only what can help", async (deleted, heading, offersActions) => {
    mocks.access = { projectAccessBlocked: true, projectAccessDeleted: deleted };
    mocks.projects.mockReturnValue({ projectList: [beta], activeProjectId: B,
      createProject: mocks.createProject, switchProject: mocks.switchProject });
    mocks.merged.mockReturnValue({ mergedProjects: [beta], remoteLoading: false, remoteError: null, remoteRefreshing: false });
    await act(async () => root.render(<BrowserRouter><ProjectPickerPanel onCreateProject={() => {}} searchTerm="" onSearchTermChange={() => {}} /></BrowserRouter>));
    const blocker = container.querySelector('[data-testid="project-missing-blocker"]');
    expect(blocker?.querySelector("h3")?.textContent).toBe(heading);
    expect(blocker?.textContent).toContain("Pick another space below");
    expect(blocker?.querySelector('[data-testid="project-missing-open-requested"]') !== null).toBe(offersActions);
    expect(blocker?.querySelector('[data-testid="project-missing-report-bug"]') !== null).toBe(offersActions);
    expect(container.querySelector(`[data-testid="project-picker-card-${B}"]`)).not.toBeNull();
  });
});
