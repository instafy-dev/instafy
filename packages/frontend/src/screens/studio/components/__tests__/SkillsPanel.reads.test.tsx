// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsPanel } from "../SkillsPanel";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  listAt: vi.fn(),
  readAt: vi.fn(),
  getRawUrl: vi.fn(),
  versioning: { mode: "legacy" as "legacy" | "stateless", originId: null as string | null },
  /** What the panel asked the versioning hook for, render by render. */
  versioningInputs: [] as Array<{ projectId?: string | null; origin?: unknown }>,
  projectId: "space-a",
  runtime: {
    effectiveRuntimeId: "runtime-1",
    desktopOrigin: null as unknown,
    desktopOriginProjectId: null as string | null,
  },
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      files: { list: mocks.list, read: mocks.read, listAt: mocks.listAt, readAt: mocks.readAt, getRawUrl: mocks.getRawUrl },
    },
  },
}));
vi.mock("../../../../workspace/useWorkspaceVersioning", () => ({
  useWorkspaceVersioning: (input: { projectId?: string | null; origin?: unknown }) => {
    mocks.versioningInputs.push(input);
    return { mode: mocks.versioning.mode, originId: mocks.versioning.originId };
  },
}));
vi.mock("../../../../runtime/useRuntime", () => ({ useRuntime: () => mocks.runtime }));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: mocks.projectId }) }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../../../conversations/useConversation", () => ({
  useConversation: () => ({
    activeConversationId: null,
    assistantEnabled: false,
    onInputChange: vi.fn(),
    onSubmit: vi.fn(),
    isAssistantTyping: false,
  }),
}));
vi.mock("../../../../workspace/WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({ openPanelTab: vi.fn(), requestUrlPush: vi.fn() }),
}));
vi.mock("../SettingsShell", () => ({ SettingsShell: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => <div>{actions}{children}</div> }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => false }));
vi.mock("../SkillsDiscoverySection", () => ({ SkillsDiscoverySection: () => null }));
vi.mock("../SkillsImportModal", () => ({ SkillsImportModal: () => null }));
vi.mock("../skillsDiscoveryRequest", () => ({ useSkillsDiscoveryRequest: () => undefined }));
vi.mock("../useSkillsImportFlow", () => ({
  useSkillsImportFlow: () => ({
    importSource: "",
    setImportSource: vi.fn(),
    importName: "",
    setImportName: vi.fn(),
    importOverwrite: false,
    setImportOverwrite: vi.fn(),
    importPending: false,
    addSkillModalOpen: false,
    setAddSkillModalOpen: vi.fn(),
    queueSkillImportTask: vi.fn(),
    handleSubmitImport: vi.fn(),
    handleOpenAddSkillModal: vi.fn(),
  }),
}));
vi.mock("../useSkillsDiscoveryState", () => ({
  useSkillsDiscoveryState: () => ({
    discoveryQuery: "",
    setDiscoveryQuery: vi.fn(),
    discoveryLaneFilter: "all",
    discoveryCategoryFilter: "all",
    discoverySort: "relevance",
    discoveryLoading: false,
    discoveryError: null,
    discoveryWarnings: [],
    discoveryLaneCounts: {},
    totalDiscoveryCount: 0,
    discoveryCategoryOptions: [],
    preparedDiscoveryResults: [],
    setDiscoverySort: vi.fn(),
    handleDiscoverySearchSubmit: vi.fn(),
    handleDiscoveryLaneChange: vi.fn(),
    handleDiscoveryCategoryFilterChange: vi.fn(),
    markDiscoverySourceIconBroken: vi.fn(),
    runDiscoverySearch: vi.fn(async () => undefined),
  }),
}));

describe("SkillsPanel reads", () => {
  let root: Root;
  let container: HTMLDivElement;

  async function render() {
    await act(async () => root.render(<SkillsPanel />));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.versioning.mode = "legacy";
    mocks.versioning.originId = null;
    mocks.versioningInputs.length = 0;
    mocks.projectId = "space-a";
    mocks.runtime.desktopOrigin = null;
    mocks.runtime.desktopOriginProjectId = null;
    mocks.list.mockImplementation(async ({ path }: { path: string }) =>
      path === ".agents/skills"
        ? [{ name: "writer", path: ".agents/skills/writer", kind: "directory" }]
        : [{ name: "SKILL.md", path: `${path}/SKILL.md`, kind: "file" }],
    );
    mocks.read.mockResolvedValue({ contentText: "# Writer\n\nWrites things.\n" });
    mocks.listAt.mockResolvedValue({ ok: true, entries: [], rev: null, originId: "origin-1", originMode: "hosted" });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("offers one Import action next to the empty state", async () => {
    mocks.list.mockResolvedValue([]);
    await render();
    expect(container.querySelector('[data-testid="skills-new"]')).toBeNull();
    expect(container.querySelector('[data-testid="skills-empty-new"]')?.textContent).toContain("Import");
    expect(Array.from(container.querySelectorAll("button")).filter(button => button.textContent?.trim() === "Import")).toHaveLength(1);
  });

  it("keeps Import in the toolbar when there are installed skills", async () => {
    await render();
    expect(container.querySelector('[data-testid="skills-new"]')?.textContent).toContain("Import");
    expect(container.querySelector('[data-testid="skills-empty-new"]')).toBeNull();
  });

  it("does not send today's requests again in legacy mode when the origin id arrives", async () => {
    await render();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith({ projectId: "space-a", path: ".agents/skills", runtimeId: "runtime-1" });

    mocks.versioning.originId = "origin-1";
    await render();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(mocks.read).toHaveBeenCalledTimes(1);
    expect(mocks.listAt).not.toHaveBeenCalled();
  });

  it("reads the new origin when the pinned origin changes in a versioned mode", async () => {
    mocks.versioning.mode = "stateless";
    mocks.versioning.originId = "origin-1";
    await render();
    expect(mocks.listAt).toHaveBeenCalledTimes(1);
    mocks.versioning.originId = "origin-2";
    await render();
    expect(mocks.listAt).toHaveBeenCalledTimes(2);
    expect(mocks.listAt).toHaveBeenLastCalledWith(expect.objectContaining({ originId: "origin-2" }));
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("never pairs a cloud space with the previous Desktop space's origin", async () => {
    const desk = { originId: "desk-origin", endpoint: "http://desk", mode: "desktop" };
    mocks.projectId = "desk-space";
    mocks.runtime.desktopOrigin = desk;
    mocks.runtime.desktopOriginProjectId = "desk-space";
    await render();
    expect(mocks.versioningInputs.at(-1)).toMatchObject({ projectId: "desk-space", origin: desk });

    // The user opens a cloud space; the store still holds the Desktop summary.
    mocks.versioningInputs.length = 0;
    mocks.projectId = "space-a";
    await render();
    expect(mocks.versioningInputs.length).toBeGreaterThan(0);
    for (const input of mocks.versioningInputs) {
      expect(input).toMatchObject({ projectId: "space-a", origin: null });
    }
  });
});
