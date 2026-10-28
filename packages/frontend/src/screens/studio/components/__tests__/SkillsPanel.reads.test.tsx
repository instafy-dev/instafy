// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillsPanel } from "../SkillsPanel";

/** A pack SKILL.md as the runtime writes it into a space: its marker line names the sha256 of the file without that line. */
function runtimeSkillCopy(unmarkedHead: string, rest: string): string {
  const unmarked = `${unmarkedHead}${rest}`;
  const hash = createHash("sha256").update(unmarked).digest("hex");
  return `${unmarkedHead}<!-- instafy:managed-skill sha256:${hash} -->\n${rest}`;
}

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  openPanelTab: vi.fn(),
  requestConnectTools: vi.fn(),
  discover: vi.fn(),
  openImport: vi.fn(),
  submitImport: vi.fn(),
  importModalProps: null as null | { workspaceUnavailable?: boolean; onSubmitImport: () => void },
  read: vi.fn(),
  listAt: vi.fn(),
  readAt: vi.fn(),
  getRawUrl: vi.fn(),
  versioning: { mode: "legacy" as "legacy" | "stateless", originId: null as string | null },
  /** What the panel asked the versioning hook for, render by render. */
  versioningInputs: [] as Array<{ projectId?: string | null; origin?: unknown }>,
  projectId: "space-a",
  availability: {
    issue: null as null | { kind: "connection" | "unavailable" | "access" },
    recoveryVersion: 0,
    reportFailure: vi.fn(),
  },
  runtime: {
    effectiveRuntimeId: "runtime-1",
    desktopOrigin: null as unknown,
    desktopOriginProjectId: null as string | null,
    runtimeStatuses: [] as unknown[],
  },
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    skills: { discover: mocks.discover },
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
vi.mock("../../../../workspace/WorkspaceAvailabilityProvider", () => ({ useWorkspaceAvailability: () => mocks.availability }));
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
  useWorkspaceTabs: () => ({ openPanelTab: mocks.openPanelTab, requestUrlPush: vi.fn() }),
}));
vi.mock("../connectToolRequest", () => ({ requestConnectTools: mocks.requestConnectTools }));
vi.mock("../SettingsShell", () => ({ SettingsShell: ({ children, actions }: { children: ReactNode; actions: ReactNode }) => <div>{actions}{children}</div> }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => false }));
vi.mock("../SkillsImportModal", () => ({ SkillsImportModal: (props: NonNullable<typeof mocks.importModalProps>) => {
  mocks.importModalProps = props;
  return null;
} }));
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
    handleSubmitImport: mocks.submitImport,
    handleOpenAddSkillModal: mocks.openImport,
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
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    vi.clearAllMocks();
    mocks.versioning.mode = "legacy";
    mocks.versioning.originId = null;
    mocks.versioningInputs.length = 0;
    mocks.projectId = "space-a";
    mocks.availability.issue = null;
    mocks.availability.recoveryVersion = 0;
    mocks.runtime.desktopOrigin = null;
    mocks.runtime.desktopOriginProjectId = null;
    mocks.runtime.runtimeStatuses = [];
    mocks.runtime.effectiveRuntimeId = "runtime-1";
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
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function openActions() {
    await act(async () => container.querySelector<HTMLElement>('[data-testid="skills-actions"]')?.click());
    return document.querySelector('[role="menu"]');
  }

  it("keeps custom import and restore defaults in the menu when empty", async () => {
    mocks.list.mockResolvedValue([]);
    await render();
    expect(container.querySelector('[data-testid="skills-new"]')).toBeNull();
    const menu = await openActions();
    expect(menu?.querySelectorAll('[data-testid="skills-new"]')).toHaveLength(1);
    expect(menu?.querySelector('[data-testid="skills-bootstrap"]')).not.toBeNull();
    await act(async () => menu?.querySelector<HTMLElement>('[data-testid="skills-new"]')?.click());
    expect(mocks.openImport).toHaveBeenCalledOnce();
  });

  it("keeps Import available when there are installed skills", async () => {
    await render();
    const menu = await openActions();
    expect(menu?.querySelector('[data-testid="skills-new"]')?.textContent).toContain("Import");
    expect(menu?.querySelector('[data-testid="skills-bootstrap"]')).toBeNull();
  });

  it("opens the shared tool chooser in the current chat without importing anything", async () => {
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="skills-connect-tool"]')?.click());
    expect(mocks.requestConnectTools).toHaveBeenCalledWith({ projectId: "space-a", conversationId: null });
    expect(mocks.openPanelTab).toHaveBeenCalledWith("chat", { activate: true });
  });

  it("manages installed skills without requesting an external catalog and keeps custom import explicit", async () => {
    await render();
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Installed skills");
    expect(container.querySelector('[data-testid="skills-tab-discover"]')).toBeNull();
    expect(container.querySelector('[data-testid="skills-list"]')).not.toBeNull();
    const menu = await openActions();
    const customImport = menu?.querySelector<HTMLElement>('[data-testid="skills-new"]');
    expect(customImport?.textContent).toContain("Import custom skill");
    await act(async () => customImport?.click());
    expect(mocks.openImport).toHaveBeenCalledOnce();
    expect(mocks.requestConnectTools).not.toHaveBeenCalled();
  });

  it("defers confirmed workspace failures to the shared notice, without showing an empty skills list", async () => {
    mocks.list.mockResolvedValue(null);
    await render();
    expect(mocks.availability.reportFailure).toHaveBeenCalledOnce();
    mocks.availability.issue = { kind: "unavailable" };
    await render();
    expect(container.querySelector('[data-testid="skills-load-error"]')).toBeNull();
    expect(container.textContent).not.toContain("No installed skills");
    const menu = await openActions();
    expect(menu?.querySelector('[data-testid="skills-new"]')?.getAttribute("aria-disabled")).toBe("true");
    expect(menu?.querySelector('[data-testid="skills-bootstrap"]')).toBeNull();
  });

  it("retains loaded skills through an outage, disables mutations and reloads after recovery", async () => {
    await render();
    mocks.list.mockResolvedValue(null);
    const menu = await openActions();
    await act(async () => menu?.querySelector<HTMLElement>('[data-testid="skills-refresh"]')?.click());
    mocks.availability.issue = { kind: "connection" };
    await render();
    expect(container.querySelector('[data-testid="skills-item-writer"]')).not.toBeNull();
    expect(container.textContent).toContain("Showing the last loaded skills.");
    expect(container.querySelector<HTMLInputElement>('[role="switch"]')?.disabled).toBe(true);
    mocks.list.mockResolvedValue([]);
    mocks.availability.issue = null;
    mocks.availability.recoveryVersion = 1;
    await render();
    expect(container.textContent).toContain("No installed skills yet.");
    expect(container.querySelector('[data-testid="skills-load-error"]')).toBeNull();
  });

  it("does not show another space's retained skills when the new space fails", async () => {
    await render();
    mocks.projectId = "space-b";
    mocks.list.mockResolvedValue(null);
    mocks.availability.issue = { kind: "unavailable" };
    await render();
    expect(container.querySelector('[data-testid="skills-item-writer"]')).toBeNull();
    expect(container.textContent).not.toContain("No installed skills");
  });

  it("guards an already-open import callback through an outage and enables it after recovery", async () => {
    await render();
    mocks.availability.issue = { kind: "connection" };
    await render();
    expect(mocks.importModalProps?.workspaceUnavailable).toBe(true);
    await act(async () => mocks.importModalProps?.onSubmitImport());
    expect(mocks.submitImport).not.toHaveBeenCalled();

    mocks.availability.issue = null;
    mocks.availability.recoveryVersion = 1;
    await render();
    expect(mocks.importModalProps?.workspaceUnavailable).toBe(false);
    await act(async () => mocks.importModalProps?.onSubmitImport());
    expect(mocks.submitImport).toHaveBeenCalledExactlyOnceWith({ closeModalOnSuccess: true });
  });

  it("offers one recovery action when loading fails and does not present an empty list", async () => {
    mocks.list.mockResolvedValue(null);
    await render();
    expect(container.querySelector('[data-testid="skills-load-error"]')?.textContent).toContain("Unable to list skills");
    expect(container.textContent).not.toContain("No installed skills yet");
    const menu = await openActions();
    expect(menu?.querySelector('[data-testid="skills-refresh"]')).toBeNull();
    expect(menu?.querySelector('[data-testid="skills-bootstrap"]')).toBeNull();
    await act(async () => menu?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    const readsBeforeRetry = mocks.list.mock.calls.length;
    await act(async () => container.querySelector<HTMLElement>('[data-testid="skills-retry"]')?.click());
    expect(mocks.list.mock.calls.length).toBeGreaterThan(readsBeforeRetry);
  });

  it("keeps Retry focused and prevents repeat requests while recovery is pending", async () => {
    mocks.list.mockResolvedValue(null);
    await render();
    let finishRetry!: (value: null) => void;
    mocks.list.mockReturnValueOnce(new Promise<null>((resolve) => { finishRetry = resolve; }));
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="skills-retry"]')!;
    await act(async () => { retry.focus(); retry.click(); });
    expect(container.querySelector('[data-testid="skills-retry"]')).toBe(retry);
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    const readsWhilePending = mocks.list.mock.calls.length;
    await act(async () => retry.click());
    expect(mocks.list.mock.calls.length).toBe(readsWhilePending);
    await act(async () => finishRetry(null));
    expect(document.activeElement).toBe(retry);
    expect(retry.getAttribute("aria-disabled")).not.toBe("true");
  });

  it.each([false, true])("recovers without stealing focus from another control: focus moved %s", async (moveFocus) => {
    mocks.list.mockResolvedValue(null);
    await render();
    let finishRetry!: (value: []) => void;
    mocks.list.mockReturnValueOnce(new Promise<[]>((resolve) => { finishRetry = resolve; }));
    const retry = container.querySelector<HTMLButtonElement>('[data-testid="skills-retry"]')!;
    const connect = container.querySelector<HTMLButtonElement>('[data-testid="skills-connect-tool"]')!;
    await act(async () => { retry.focus(); retry.click(); });
    if (moveFocus) await act(async () => connect.focus());
    await act(async () => finishRetry([]));
    expect(container.querySelector('[data-testid="skills-retry"]')).toBeNull();
    expect(document.activeElement).toBe(moveFocus ? connect : container.querySelector("h2"));
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

  it("lists the skill packs the space's runtime installs, which are never saved with the space", async () => {
    // a cloud space reads its committed files: the runtime's pack copy is not among them
    mocks.versioning.mode = "stateless";
    mocks.versioning.originId = "origin-1";
    mocks.listAt.mockResolvedValue({ ok: true, entries: [], rev: "r1", originId: "origin-1", originMode: "hosted" });
    mocks.runtime.runtimeStatuses = [
      { runtimeId: "runtime-old", isPreferred: false, skillPacks: [{ name: "interactive-map", version: "0.1.2", title: "Old", summary: null }] },
      { runtimeId: "runtime-1", isPreferred: false, skillPacks: [{ name: "interactive-map", version: "0.1.4", title: "Interactive map sites", summary: "Interactive maps, trips and place lookups as an Instafy skill pack" }] },
    ];
    await render();
    const row = container.querySelector('[data-testid="skills-included-interactive-map"]');
    expect(row?.textContent).toContain("Interactive map sites");
    expect(row?.textContent).toContain("Interactive maps, trips and place lookups");
    expect(container.querySelector('[data-testid="skills-included-label-interactive-map"]')?.textContent).toBe("Included with Instafy · 0.1.4");
    // the runtime manages it: no switch, no uninstall, no file to open
    expect(row?.querySelector('[role="switch"]')).toBeNull();
    expect(container.querySelector('[data-testid="skills-uninstall-interactive-map"]')).toBeNull();
    expect(container.textContent).not.toContain("No installed skills yet.");
  });

  it("shows the runtime's own copy of a pack in a workspace listing as included, and a space's own copy as its skill", async () => {
    const runtimeCopy = runtimeSkillCopy("---\nname: interactive-map\n---\n> Installed with the runtime.\n", "\n# Interactive map sites\n\nA site is a folder.\n");
    const files: Record<string, string> = {
      ".agents/skills/interactive-map/SKILL.md": runtimeCopy,
      ".agents/skills/writer/SKILL.md": "# Writer\n\nWrites things.\n",
    };
    mocks.list.mockImplementation(async ({ path }: { path: string }) =>
      path === ".agents/skills"
        ? [{ name: "interactive-map", path: ".agents/skills/interactive-map", kind: "directory" }, { name: "writer", path: ".agents/skills/writer", kind: "directory" }]
        : [{ name: "SKILL.md", path: `${path}/SKILL.md`, kind: "file" }],
    );
    mocks.read.mockImplementation(async ({ path }: { path: string }) => ({ contentText: files[path] ?? null }));
    await render();
    expect(container.querySelector('[data-testid="skills-included-interactive-map"]')?.textContent).toContain("Interactive map sites");
    expect(container.querySelector('[data-testid="skills-toggle-interactive-map"]')).toBeNull();
    expect(container.querySelector('[data-testid="skills-item-writer"]')).not.toBeNull();

    // edited in the space (the marker no longer names the file's hash): the runtime leaves it alone and it is saved
    // with the space, so it is the space's own skill, with its switch
    files[".agents/skills/interactive-map/SKILL.md"] = runtimeCopy.replace("A site is a folder.", "A site is a folder. Always dark.");
    mocks.projectId = "space-edited";
    await render();
    expect(container.querySelector('[data-testid="skills-item-interactive-map"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="skills-toggle-interactive-map"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="skills-included-interactive-map"]')).toBeNull();

    // imported in full (no runtime marker): the space's own skill, with its switch, and not listed twice
    files[".agents/skills/interactive-map/SKILL.md"] = "# Interactive map sites\n\nMy own copy.\n";
    mocks.runtime.runtimeStatuses = [{ runtimeId: "runtime-1", isPreferred: true, skillPacks: [{ name: "interactive-map", version: "0.1.4", title: "Interactive map sites", summary: null }] }];
    mocks.projectId = "space-b";
    await render();
    expect(container.querySelector('[data-testid="skills-item-interactive-map"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="skills-included-interactive-map"]')).toBeNull();
  });

  it("lists the packs of the runtime that runs the space, not another runtime's", async () => {
    mocks.versioning.mode = "stateless";
    mocks.versioning.originId = "origin-1";
    mocks.listAt.mockResolvedValue({ ok: true, entries: [], rev: "r1", originId: "origin-1", originMode: "hosted" });
    // the space runs on runtime-1, which names no packs (an older runtime); another, preferred runtime has one
    mocks.runtime.runtimeStatuses = [
      { runtimeId: "runtime-1", isPreferred: false },
      { runtimeId: "runtime-cloud", isPreferred: true, skillPacks: [{ name: "interactive-map", version: "0.1.4", title: "Interactive map sites", summary: null }] },
    ];
    await render();
    expect(container.querySelector('[data-testid="skills-included-interactive-map"]')).toBeNull();
    expect(container.textContent).toContain("No installed skills yet.");

    // no runtime chosen for the space yet: the preferred runtime's packs
    mocks.runtime.effectiveRuntimeId = null as unknown as string;
    mocks.projectId = "space-b";
    await render();
    expect(container.querySelector('[data-testid="skills-included-label-interactive-map"]')?.textContent).toBe("Included with Instafy · 0.1.4");
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
