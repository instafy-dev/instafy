// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "../WorkspaceTabs";
import { createTabForPanel, type WorkspaceTabState } from "../workspaceTabFactories";

const fixture = vi.hoisted(() => ({
  tabs: [] as WorkspaceTabState[],
  activeTabId: "",
  focusTab: vi.fn<(id: string) => void>(),
  closeTab: vi.fn<(id: string) => void>(),
  moveTab: vi.fn<(id: string, index: number) => void>(),
  requestUrlPush: vi.fn(),
}));

vi.mock("../WorkspaceTabsProvider", () => ({
  useWorkspaceTabs: () => ({
    ...fixture,
    keepTabOpen: vi.fn(),
    openConversationTab: vi.fn(),
  }),
}));
vi.mock("../../conversations/ConversationsProvider", () => ({
  useConversations: () => ({
    conversations: [],
    createConversation: vi.fn(),
    setConversationControllerId: vi.fn(),
    setConversationTitle: vi.fn(),
    setConversationLifecycleStatus: vi.fn(),
  }),
}));
vi.mock("../../projects/useProject", () => ({ useProject: () => ({ activeProjectId: "project-1" }) }));
vi.mock("../../status/useStatus", () => ({ useStatus: () => ({ showStatus: vi.fn() }) }));
vi.mock("../useWorkspace", () => ({ useWorkspaceUi: () => ({ requestConversationInvite: vi.fn() }) }));
vi.mock("../../sdk/instafy", () => ({ controllerClient: { conversations: {} } }));
vi.mock("../../lib/desktopShell", () => ({ desktopTitleBarFree: () => false }));

const panelId = "workspace-tab-machines";
const firstId = "workspace-tab-home";

function TabsHarness() {
  const [tabs, setTabs] = useState(() => [
    createTabForPanel("home"),
    createTabForPanel("machines"),
    createTabForPanel("team"),
  ]);
  const [activeTabId, setActiveTabId] = useState(firstId);
  fixture.tabs = tabs;
  fixture.activeTabId = activeTabId;
  fixture.focusTab.mockImplementation(setActiveTabId);
  fixture.closeTab.mockImplementation((id) => setTabs((current) => current.filter((tab) => tab.id !== id)));
  fixture.moveTab.mockImplementation((id, index) => setTabs((current) => {
    const next = [...current];
    const [moved] = next.splice(next.findIndex((tab) => tab.id === id), 1);
    next.splice(index, 0, moved);
    return next;
  }));
  return <WorkspaceTabs />;
}

class TestPointerEvent extends MouseEvent {
  readonly pointerId = 1;
  readonly pointerType = "mouse";
  readonly isPrimary = true;
}

describe("Workspace tab pointer dragging", () => {
  let container: HTMLDivElement;
  let root: Root;

  const trigger = (id: string) => container.querySelector<HTMLElement>(`[data-workspace-tab-trigger="${id}"]`)!;
  const order = () => Array.from(container.querySelectorAll<HTMLElement>("[data-workspace-tab-trigger]"))
    .map((node) => node.dataset.workspaceTabTrigger);

  async function pointer(target: EventTarget, type: string, x: number) {
    await act(async () => target.dispatchEvent(new TestPointerEvent(type, {
      clientX: x, clientY: 24, button: 0, buttons: type === "pointerup" ? 0 : 1,
      bubbles: true, cancelable: true,
    })));
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("PointerEvent", TestPointerEvent);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    // Keep the real DndContext, PointerSensor and HorizontalTabStrip. jsdom
    // supplies no layout, so give the three tab shells fixed adjacent bounds.
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const tab = this.matches("[data-workspace-tab-trigger]")
        ? this
        : this.classList.contains("group/tab")
          ? this.querySelector<HTMLElement>("[data-workspace-tab-trigger]")
          : null;
      const index = tab ? order().indexOf(tab.dataset.workspaceTabTrigger) : -1;
      const x = index < 0 ? 0 : index * 160;
      const width = index < 0 ? 480 : 160;
      return { x, y: 0, left: x, top: 0, right: x + width, bottom: 48, width, height: 48, toJSON: () => ({}) };
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(480);
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(480);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<TabsHarness />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    // PointerSensor keeps its document click suppression for 50ms after a
    // completed drag. Dispose it before the next test's independent click.
    await act(async () => vi.runOnlyPendingTimersAsync());
    container.remove();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("selects an inactive panel, then reorders it on the next pointer drag", async () => {
    expect(trigger(firstId).querySelector("[aria-current=page]")).not.toBeNull();
    await pointer(trigger(panelId), "pointerdown", 240);
    await pointer(document, "pointerup", 240);
    await act(async () => trigger(panelId).click());
    expect(trigger(panelId).querySelector("[aria-current=page]")).not.toBeNull();
    expect(fixture.requestUrlPush).toHaveBeenCalledTimes(1);
    expect(fixture.moveTab).not.toHaveBeenCalled();

    await pointer(trigger(panelId), "pointerdown", 240);
    await pointer(document, "pointermove", 228);
    await pointer(document, "pointermove", 80);
    await pointer(document, "pointerup", 80);

    expect(fixture.moveTab).toHaveBeenCalledExactlyOnceWith(panelId, 0);
    expect(order()).toEqual([panelId, firstId, "workspace-tab-team"]);
    expect(trigger(panelId).querySelector("[aria-current=page]")).not.toBeNull();
    expect(fixture.requestUrlPush).toHaveBeenCalledTimes(1);
  });

  it("keeps the close control from selecting or dragging an inactive panel", async () => {
    const close = trigger(panelId).querySelector<HTMLButtonElement>("button")!;
    await pointer(close, "pointerdown", 300);
    await pointer(document, "pointermove", 80);
    await pointer(document, "pointerup", 80);
    await act(async () => close.click());

    expect(fixture.closeTab).toHaveBeenCalledExactlyOnceWith(panelId);
    expect(fixture.focusTab).not.toHaveBeenCalled();
    expect(fixture.moveTab).not.toHaveBeenCalled();
    expect(order()).toEqual([firstId, "workspace-tab-team"]);
    expect(trigger(firstId).querySelector("[aria-current=page]")).not.toBeNull();
  });
});
