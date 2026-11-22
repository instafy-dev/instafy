// @vitest-environment jsdom

import { act, useCallback, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationSurfaceTabs, type ConversationSurface } from "../../../../workspace/ConversationSurfaceLayout";
import { DEFAULT_CONVERSATION_SURFACES, selectConversationView } from "../../../../workspace/conversationSurfaces";
import { BrowserPauseRow } from "../BrowserPauseRow";
import { resolveBrowserTransportSelection } from "../browserTransportPreference";
import { useBrowserPauseTab } from "../useBrowserPauseTab";
import type { BrowserTransport } from "../usePersonalBrowserBridge";
import type { OpenBrowserPause } from "../useShowBrowserOnRequest";

const pause: OpenBrowserPause = { messageId: "pause", runId: "run-1", runtimeId: "runtime-1", pageId: "PAGE1" };

// Desktop, with nothing saved for this chat on this device: the chat's view
// would show this device's own browser.
const DESKTOP_LOCATION = resolveBrowserTransportSelection({ resume: null, preference: null, personalAvailable: true });

type ChatProps = {
  /** The browser the chat's view shows on this device. */
  location: BrowserTransport;
  /** This device already has a view for the chat. */
  hasView?: boolean;
  /** The person closed the chat's view on this device. */
  viewClosed?: boolean;
  /** This device's record of the chat's view has been read. */
  hydrated?: boolean;
  /** The conversation's view bar shows the chat's views, in place of the chat's own tabs. */
  viewBar?: boolean;
  waiting?: OpenBrowserPause | null;
};

/**
 * ChatPanel's part, which is wired to a dozen providers and so is not
 * mounted here (chatPanelBrowserPauseRow.test.ts reads its wiring). A pick
 * selects the view, and Browser opens the view when it is not open
 * (handleBrowserSubtabChange). Revealing Instafy's browser makes it the one
 * the view shows (revealSharedBrowserApproval). The conversation's view bar
 * only selects Browser among the chat's views (ConversationWorkspaceViews).
 */
function Chat({
  location: initialLocation,
  hasView = false,
  viewClosed: closedAtFirst = false,
  hydrated = true,
  viewBar = false,
  waiting = pause,
}: ChatProps) {
  const [location, setLocation] = useState(initialLocation);
  const [viewOpen, setViewOpen] = useState(hasView);
  const [viewClosed, setViewClosed] = useState(closedAtFirst);
  const [surfaces, setSurfaces] = useState(DEFAULT_CONVERSATION_SURFACES);
  const selectView = useCallback((id: string) => {
    setSurfaces((state) => selectConversationView(state, id));
    if (id === "browser") {
      setViewOpen(true);
      setViewClosed(false);
    }
  }, []);
  const revealInstafyBrowser = useCallback(() => setLocation("shared"), []);
  const { offersTab, open, select } = useBrowserPauseTab({
    pause: waiting,
    hasView: viewOpen,
    viewStateHydrated: hydrated,
    viewClosed,
    browserPicked: viewBar && surfaces.activeId === "browser" && !viewOpen,
    revealInstafyBrowser,
    selectView,
  });
  const resources: ConversationSurface[] = viewOpen || offersTab
    ? [{ id: "browser", label: "Browser", panelId: "browser-panel" }]
    : [];
  const activeId = surfaces.activeId === "browser" && !viewOpen ? "chat" : surfaces.activeId;
  const browserVisible = viewOpen && activeId === "browser";
  return (
    <>
      <ConversationSurfaceTabs
        chatPanelId="chat-panel"
        resources={resources}
        activeId={activeId}
        resourceId="browser"
        split={false}
        wide={false}
        ratio={0.55}
        onSplitChange={() => {}}
        onSelect={viewBar ? (id) => setSurfaces((state) => selectConversationView(state, id)) : select}
      />
      {browserVisible ? <div data-testid={location === "shared" ? "instafy-browser" : "device-browser"} /> : null}
      <BrowserPauseRow pause={waiting} browserVisible={browserVisible && location === "shared"} avatar={null} onOpen={open} />
    </>
  );
}

describe("useBrowserPauseTab", () => {
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
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  const render = (chat: ReactElement) => act(async () => root.render(chat));
  const browserTab = () => container.querySelector<HTMLButtonElement>('[data-testid="conversation-subtab-browser"]');
  const chatTab = () => container.querySelector<HTMLButtonElement>('[data-testid="conversation-subtab-chat"]');
  const row = () => container.querySelector('[data-testid="browser-pause-row"]');
  const openRow = () => container.querySelector<HTMLButtonElement>('[data-testid="browser-pause-open"]');
  const onScreen = () => {
    if (container.querySelector('[data-testid="instafy-browser"]')) return "Instafy's browser";
    if (container.querySelector('[data-testid="device-browser"]')) return "this device's browser";
    return "Chat";
  };

  // Review, Nov 22: on Desktop, which shows its own browser for a chat with no
  // view saved, the Browser tab a waiting pause kept opened that browser,
  // with no page, no outlines and no pause. Only the row reached Instafy's.
  it("opens Instafy's browser from the Browser tab a pause keeps, where the view would show this device's own", async () => {
    expect(DESKTOP_LOCATION).toBe("personal");
    await render(<Chat location={DESKTOP_LOCATION} />);
    expect(browserTab()).not.toBeNull();
    expect(onScreen()).toBe("Chat");
    await act(async () => browserTab()!.click());
    expect(onScreen()).toBe("Instafy's browser");
    // Instafy's browser is on screen: the row has nothing left to offer.
    expect(row()).toBeNull();
  });

  it("opens Instafy's browser from the keyboard too", async () => {
    await render(<Chat location={DESKTOP_LOCATION} />);
    await act(async () => {
      chatTab()!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
    });
    expect(onScreen()).toBe("Instafy's browser");
  });

  it("opens Instafy's browser when the conversation's view bar picks that tab", async () => {
    await render(<Chat location={DESKTOP_LOCATION} viewBar />);
    expect(onScreen()).toBe("Chat");
    await act(async () => browserTab()!.click());
    expect(onScreen()).toBe("Instafy's browser");
    expect(row()).toBeNull();
  });

  it("opens a view this device already has where it is, and the row still leads to Instafy's browser", async () => {
    await render(<Chat location="personal" hasView />);
    await act(async () => browserTab()!.click());
    expect(onScreen()).toBe("this device's browser");
    expect(row()).not.toBeNull();
    await act(async () => openRow()!.click());
    expect(onScreen()).toBe("Instafy's browser");
  });

  it("keeps a view the person closed here closed: no tab, and the row leads back", async () => {
    await render(<Chat location={DESKTOP_LOCATION} viewClosed />);
    expect(browserTab()).toBeNull();
    await act(async () => openRow()!.click());
    expect(onScreen()).toBe("Instafy's browser");
  });

  it("offers no tab while no pause waits, nor before this device's record of the view is read", async () => {
    await render(<Chat key="none" location={DESKTOP_LOCATION} waiting={null} />);
    expect(browserTab()).toBeNull();
    expect(row()).toBeNull();
    await render(<Chat key="unread" location={DESKTOP_LOCATION} hydrated={false} />);
    expect(browserTab()).toBeNull();
    // The row does not wait for that record.
    expect(row()).not.toBeNull();
  });
});
