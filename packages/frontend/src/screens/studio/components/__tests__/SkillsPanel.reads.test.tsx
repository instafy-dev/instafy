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
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      files: { list: mocks.list, read: mocks.read, listAt: mocks.listAt, readAt: mocks.readAt, getRawUrl: mocks.getRawUrl },
    },
  },
}));
vi.mock("../../../../workspace/useWorkspaceVersioning", () => ({
  useWorkspaceVersioning: () => ({ mode: mocks.versioning.mode, originId: mocks.versioning.originId }),
}));
vi.mock("../../../../runtime/useRuntime", () => ({
  useRuntime: () => ({ effectiveRuntimeId: "runtime-1", desktopOrigin: null }),
}));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: "space-a" }) }));
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
vi.mock("../SettingsShell", () => ({ SettingsShell: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("../InstalledSkillsSection", () => ({ InstalledSkillsSection: () => null }));
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
});
