// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopTitleBarFree, DESKTOP_TITLE_BAR_TAB_OFFSET_PX } from "../../lib/desktopShell";
import { WorkspaceTabs } from "../WorkspaceTabs";

vi.mock("../../lib/desktopShell", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/desktopShell")>(),
  desktopTitleBarFree: vi.fn(() => false),
}));
vi.mock("../WorkspaceTabsProvider", () => ({ useWorkspaceTabs: () => ({ tabs: [], activeTabId: null }) }));
vi.mock("../../conversations/ConversationsProvider", () => ({ useConversations: () => ({ conversations: [] }) }));
vi.mock("../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: null }) }));
vi.mock("../useWorkspace", () => ({ useWorkspaceUi: () => ({ requestConversationInvite: vi.fn() }) }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: {} }));

describe("WorkspaceTabs titlebar clearance", () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not add another inset when the enclosing context header clears window controls", async () => {
    vi.mocked(desktopTitleBarFree).mockReturnValue(true);
    await act(async () => root.render(<WorkspaceTabs titleBarInset={false} leading={<button>Go back</button>} />));
    expect(container.querySelector('[data-testid="workspace-tabs"]')?.classList.contains("pl-6")).toBe(false);
  });

  it.each([true, false])("clears leading controls and tabs only in the integrated shell: %s", async (integrated) => {
    vi.mocked(desktopTitleBarFree).mockReturnValue(integrated);
    await act(async () => root.render(<WorkspaceTabs leading={<button>Go back</button>} emptyStateContent={<button>Home</button>} />));
    const row = container.querySelector<HTMLElement>('[data-testid="workspace-tabs"]')!;
    const leading = Array.from(row.querySelectorAll("button")).find((button) => button.textContent === "Go back")!;
    expect(row.classList.contains("pl-6")).toBe(integrated);
    expect(row.contains(leading)).toBe(true);
    // The inset belongs to the whole row, not a later child after Back/Forward,
    // and is not doubled inside the scrolling strip.
    expect(row.querySelector(".pl-6")).toBeNull();
    expect(DESKTOP_TITLE_BAR_TAB_OFFSET_PX).toBe(24);
  });
});
