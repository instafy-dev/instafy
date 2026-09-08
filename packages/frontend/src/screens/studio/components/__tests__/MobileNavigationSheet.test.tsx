/** @vitest-environment jsdom */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileNavigationSheet, type MobileNavigationSection, type MobileNavigationSheetProps } from "../MobileNavigationSheet";
import type { ConversationState } from "../../../../conversations/ConversationsProvider";
import type { ProjectListItem } from "../../../../projects/useProjects";
import { buildStudioDestinationSearch, type StudioDestination } from "../../../../navigation/studioNavigation";

const mocks = vi.hoisted(() => ({
  project: { activeProjectId: "space-a", activeProjectName: "Alpha", projectAccessPending: false, projectAccessBlocked: false },
  conversations: vi.fn(), projects: vi.fn(), merged: vi.fn(), navigate: vi.fn(), nativeBack: vi.fn(),
  retryChats: vi.fn(), retrySpaces: vi.fn(), createProject: vi.fn(), switchProject: vi.fn(),
}));
vi.mock("../../../../projects/useProject", () => ({ useProject: () => mocks.project }));
vi.mock("../../../../conversations/ConversationsProvider", () => ({ useConversations: mocks.conversations }));
vi.mock("../../../../projects/useProjects", () => ({ useProjects: mocks.projects }));
vi.mock("../../../../projects/useMergedControllerProjects", () => ({ useMergedControllerProjects: mocks.merged }));
vi.mock("../../../../navigation/useStudioNavigation", () => ({ useStudioNavigation: () => mocks.navigate }));
vi.mock("../../../../native/useNativeBackButtonAction", () => ({ useNativeBackButtonAction: mocks.nativeBack }));

const chat = (localId: string, title: string, lifecycleStatus: ConversationState["lifecycleStatus"] = "active", createdAt = 1) => ({
  localId, title, lifecycleStatus, controllerId: `controller-${localId}`, createdAt,
}) as ConversationState;
const local = { id: "space-a", name: "Alpha", orgId: "team-a", orgName: "First team", state: {} } as ProjectListItem;
const remote = { id: "space-b", name: "Beta", orgId: "team-b", orgName: "Second team", state: null, isRemoteOnly: true };
const historyState = () => ({
  projectKey: "space-a", activeConversationId: "a", conversations: [chat("a", "Alpha chat"), chat("b", "Beta chat", "active", 2)],
  remoteConversationHistoryResolved: true, remoteConversationHistoryError: null as string | null, retryRemoteConversationHistory: mocks.retryChats,
});
const discoveryState = () => ({
  mergedProjects: [{ ...local, isRemoteOnly: false }, remote], remoteLoading: false, remoteError: null as string | null,
  remoteRefreshing: false, retryRemoteProjects: mocks.retrySpaces,
});

describe("MobileNavigationSheet", () => {
  let root: Root;
  let container: HTMLDivElement;
  let props: MobileNavigationSheetProps;
  let originalViewport: PropertyDescriptor | undefined;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    Object.assign(mocks.project, { activeProjectId: "space-a", activeProjectName: "Alpha", projectAccessPending: false, projectAccessBlocked: false });
    mocks.conversations.mockReturnValue(historyState());
    mocks.projects.mockReturnValue({ projectList: [local], activeProjectId: "space-a", createProject: mocks.createProject, switchProject: mocks.switchProject });
    mocks.merged.mockReturnValue(discoveryState());
    props = {
      section: "chats", onSectionChange: vi.fn(), onClose: vi.fn(),
      history: { canGoBack: true, canGoForward: false, goBack: vi.fn(), goForward: vi.fn() },
      onNewChat: vi.fn(), onOpenFiles: vi.fn(), onOpenAllChats: vi.fn(), onOpenAllSpaces: vi.fn(),
    };
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    originalViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); document.body.replaceChildren();
    if (originalViewport) Object.defineProperty(window, "visualViewport", originalViewport);
    else Reflect.deleteProperty(window, "visualViewport");
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render() { await act(async () => root.render(<MobileNavigationSheet {...props} />)); }
  function button(label: string) {
    const result = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((node) => node.textContent === label);
    expect(result, `button ${label}`).toBeDefined(); return result!;
  }
  async function click(label: string) { await act(async () => button(label).click()); }
  async function search(value: string) {
    const input = document.querySelector<HTMLInputElement>("input[type=search]")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("opens a real modal without focusing search; every control requests a 48px target", async () => {
    await render();
    expect(document.querySelector('[role=dialog]')?.getAttribute("aria-label")).toBe("Navigation");
    const input = document.querySelector<HTMLInputElement>("input[type=search]")!;
    expect(input.autofocus).toBe(false); expect(document.activeElement).not.toBe(input);
    expect(input.classList.contains("!text-base")).toBe(true);
    for (const node of document.querySelectorAll("button,input")) {
      // React Aria's hidden dismissal sentinels are not visible sheet targets.
      if (node.getAttribute("aria-label") === "Dismiss") continue;
      expect(node.classList.contains("!min-h-12")).toBe(true);
      expect(node.classList.contains("!min-w-12")).toBe(true);
    }
    expect(mocks.merged).not.toHaveBeenCalled();
    expect(mocks.nativeBack).toHaveBeenCalledWith(true, props.onClose);
    expect(document.querySelector('[data-testid=mobile-navigation-footer]')?.contains(input)).toBe(true);
  });

  it("filters only active loaded chats and uses exact typed identity after closing", async () => {
    mocks.conversations.mockReturnValue({ ...historyState(), conversations: [chat("a", "Alpha chat"), chat("b", "Beta chat"), chat("hidden", "Hidden", "hidden"), chat("deleted", "Deleted", "deleted"), chat("archived", "Archived", "archived")] });
    await render();
    expect(document.body.textContent).toContain("Loaded chats in Alpha");
    for (const label of ["Hidden", "Deleted", "Archived"]) expect(document.body.textContent).not.toContain(label);
    await search("  bEtA  "); expect(document.body.textContent).not.toContain("Alpha chat");
    const order: string[] = [];
    props.onClose = vi.fn(() => order.push("close")); mocks.navigate.mockImplementation(() => order.push("navigate")); await render();
    await click("Beta chat");
    expect(order).toEqual(["close", "navigate"]);
    expect(mocks.navigate).toHaveBeenCalledWith({ kind: "conversation", projectId: "space-a", conversationId: "b", conversationControllerId: "controller-b" });
  });

  it("does not claim exhaustive search and exposes the All chats fallback", async () => {
    await render(); await search("missing");
    expect(document.body.textContent).toContain("No matching loaded chats.");
    expect(document.body.textContent).not.toContain("New chat"); expect(document.body.textContent).not.toContain("Files");
    await click("All chats"); expect(props.onClose).toHaveBeenCalledTimes(1); expect(props.onOpenAllChats).toHaveBeenCalledTimes(1);
    expect(props.onSectionChange).not.toHaveBeenCalled(); expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("bounds rendered lists while search can still find entries beyond the initial cap", async () => {
    mocks.conversations.mockReturnValue({ ...historyState(), conversations: Array.from({ length: 45 }, (_, index) => chat(`chat-${index}`, `Loaded chat ${index}`, "active", index)) });
    await render();
    expect(document.querySelectorAll('[aria-label="Loaded chats"] li')).toHaveLength(40);
    expect(document.body.textContent).toContain("Showing 40 of 45 matching loaded chats");
    await search("Loaded chat 0"); expect(document.querySelectorAll('[aria-label="Loaded chats"] li')).toHaveLength(1);
    expect(document.body.textContent).toContain("Loaded chat 0");
    props.section = "spaces";
    mocks.merged.mockReturnValue({ ...discoveryState(), mergedProjects: Array.from({ length: 85 }, (_, index) => ({ ...remote, id: `space-${index}`, name: `Space ${String(index).padStart(2, "0")}` })) });
    await render(); expect(document.querySelectorAll('[aria-label="Accessible spaces"] li')).toHaveLength(80);
    expect(document.body.textContent).toContain("Showing 80 of 85 matching spaces");
    await search("Space 84"); expect(document.querySelectorAll('[aria-label="Accessible spaces"] li')).toHaveLength(1);
  });

  it("withholds a previous space's list and access-blocked chats", async () => {
    mocks.conversations.mockReturnValue({ ...historyState(), projectKey: "old-space" }); await render();
    expect(document.body.textContent).not.toContain("Alpha chat"); expect(document.body.textContent).toContain("Loading this space’s chats");
    mocks.project.projectAccessBlocked = true; await render();
    expect(document.body.textContent).toContain("Chat access is unavailable"); expect(document.body.textContent).not.toContain("Alpha chat");
  });

  it("retains loaded chats after a refresh error and offers retry rather than false empty state", async () => {
    mocks.conversations.mockReturnValue({ ...historyState(), remoteConversationHistoryError: "read failed" }); await render();
    expect(document.body.textContent).toContain("Alpha chat"); expect(document.body.textContent).toContain("Couldn’t refresh chats");
    await click("Retry chats"); expect(mocks.retryChats).toHaveBeenCalledTimes(1); expect(props.onClose).not.toHaveBeenCalled();
    mocks.conversations.mockReturnValue({ ...historyState(), conversations: [], remoteConversationHistoryResolved: false, remoteConversationHistoryError: "read failed" }); await render();
    expect(document.body.textContent).not.toContain("No active chats");
  });

  it("mounts all-team space discovery only on selection and keeps per-section filters", async () => {
    function Harness() { const [section, setSection] = useState<MobileNavigationSection>("chats"); return <MobileNavigationSheet {...props} section={section} onSectionChange={setSection} />; }
    await act(async () => root.render(<Harness />)); await search("Beta"); expect(mocks.merged).not.toHaveBeenCalled();
    await click("Spaces"); expect(mocks.merged).toHaveBeenCalledWith({ localProjects: [local], includeAllOrgs: true });
    expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("");
    await search("SECOND TEAM"); expect(document.body.textContent).toContain("BetaSecond team"); expect(document.body.textContent).not.toContain("AlphaFirst team");
    await click("Chats"); expect(document.querySelector<HTMLInputElement>("input")?.value).toBe("Beta");
    expect(document.body.textContent).not.toContain("Alpha chat");
  });

  it.each(["remote-only", "already cached"])("navigates URL-first to a %s space after closing, without legacy store mutations", async (kind) => {
    props.section = "spaces";
    const order: string[] = []; props.onClose = vi.fn(() => order.push("close"));
    mocks.navigate.mockImplementation(() => order.push("navigate"));
    if (kind === "already cached") {
      mocks.projects.mockReturnValue({ projectList: [local, { ...remote, state: {} }], activeProjectId: "space-a", createProject: mocks.createProject, switchProject: mocks.switchProject });
    }
    await render(); await click("BetaSecond team");
    expect(order).toEqual(["close", "navigate"]);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({ kind: "conversation", projectId: "space-b" });
    expect(mocks.createProject).not.toHaveBeenCalled(); expect(mocks.switchProject).not.toHaveBeenCalled();
    // Exercise the actual destination builder with the emitted contract: a
    // space visit must not relabel the old chat/job or browser-session locator.
    const destination = mocks.navigate.mock.calls[0][0] as StudioDestination;
    const next = new URLSearchParams(buildStudioDestinationSearch(
      "?projectId=space-a&conversationId=old-local&conversationControllerId=old-controller&jobId=old-job&browserRuntimeId=old-browser&panel=settings&settingsTab=project&settingsCategory=ai&settingsItem=audio&workspaceTab=files",
      destination,
    ));
    expect(Object.fromEntries(next)).toEqual({ projectId: "space-b" });
  });

  it("selecting the current space only closes, without a new visit or legacy mutations", async () => {
    props.section = "spaces"; await render(); await click("AlphaFirst teamCurrent");
    expect(props.onClose).toHaveBeenCalledTimes(1); expect(mocks.createProject).not.toHaveBeenCalled(); expect(mocks.switchProject).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it("distinguishes failed space discovery from no matches and allows retry", async () => {
    props.section = "spaces"; mocks.merged.mockReturnValue({ ...discoveryState(), remoteError: "Couldn’t load spaces." }); await render();
    await search("missing"); expect(document.body.textContent).toContain("Couldn’t load spaces."); expect(document.body.textContent).not.toContain("No matching spaces");
    await click("Retry spaces"); expect(mocks.retrySpaces).toHaveBeenCalledTimes(1);
    mocks.merged.mockReturnValue(discoveryState()); await render(); expect(document.body.textContent).toContain("No matching spaces.");
    await click("All spaces"); expect(props.onOpenAllSpaces).toHaveBeenCalledTimes(1);
  });

  it("disables unknown Forward; enabled Forward and quick actions close before acting", async () => {
    await render(); expect(button("Forward").disabled).toBe(true); await click("Forward");
    expect(props.onClose).not.toHaveBeenCalled(); expect(props.history.goForward).not.toHaveBeenCalled();
    const order: string[] = []; props.onClose = vi.fn(() => order.push("close"));
    props.history = { ...props.history, canGoForward: true, goForward: vi.fn(() => order.push("forward")) }; await render();
    await click("Forward"); expect(order).toEqual(["close", "forward"]);
    await click("New chat"); await click("Files"); expect(props.onNewChat).toHaveBeenCalledTimes(1); expect(props.onOpenFiles).toHaveBeenCalledTimes(1);
    await click("Close"); expect(props.onClose).toHaveBeenCalledTimes(4);
  });

  it("keeps the same focused search and Close row while keyboard mode hides secondary navigation", async () => {
    await render();
    const input = document.querySelector<HTMLInputElement>("input[type=search]")!;
    const close = button("Close");
    await act(async () => input.focus()); await search("Beta");
    props.keyboardOpen = true; await render();
    expect(document.querySelector("input[type=search]")).toBe(input);
    expect(document.activeElement).toBe(input); expect(input.value).toBe("Beta"); expect(button("Close")).toBe(close);
    expect(document.querySelector('[data-testid=mobile-navigation-secondary]')).toBeNull();
    expect((document.querySelector('[data-testid=mobile-navigation-footer]') as HTMLElement).style.paddingBottom).toBe("0.5rem");
    expect(document.body.textContent).toContain("Beta chat");
    props.keyboardOpen = false; await render();
    expect(document.querySelector("input[type=search]")).toBe(input); expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Beta"); expect(button("Close")).toBe(close);
    expect(document.querySelector('[data-testid=mobile-navigation-secondary]')).not.toBeNull();
    expect(button("Forward").disabled).toBe(true);
  });

  it("tracks visual viewport offset and keyboard resize without shrinking the backdrop, and removes listeners", async () => {
    const viewport = Object.assign(new EventTarget(), { offsetTop: 20, height: 500, scale: 1 });
    const remove = vi.spyOn(viewport, "removeEventListener");
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    await render();
    const modal = document.querySelector('[role=dialog]')!.parentElement!;
    expect(modal.style.bottom).toContain("520px"); expect(modal.style.height).toBe("auto"); expect(modal.style.maxHeight).toContain("500px");
    expect(document.querySelector('[role=dialog]')?.classList.contains("[max-height:inherit]")).toBe(true);
    expect(modal.parentElement!.className).toContain("fixed inset-0");
    await act(async () => { viewport.height = 260; viewport.offsetTop = 30; viewport.scale = 2; viewport.dispatchEvent(new Event("resize")); await new Promise((resolve) => requestAnimationFrame(resolve)); });
    expect(modal.style.bottom).toContain("290px"); expect(modal.style.maxHeight).toContain("260px");
    await act(async () => root.render(null));
    expect(remove.mock.calls.map(([name]) => name)).toEqual(expect.arrayContaining(["resize", "scroll"]));
  });
});
