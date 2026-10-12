import { ChatBubble, Globe, Page, ViewColumns3, Xmark } from "iconoir-react";
import * as chrome from "./landingStudioChrome";
import type { PaneState, ViewTab } from "./landingPanes";

// The conversation's views (ConversationSurfaceLayout.tsx ConversationSurfaceTabs):
// in the header from md (under the tab strip), beside the composer on phones.
// Presentational spans only: nothing in the window takes focus.

type Presentation = "header" | "composer";

const CHAT_TAB: ViewTab = { id: "chat", kind: "chat", label: "Chat", title: "Chat" };

function TabIcon({ tab }: { tab: ViewTab }) {
  const className = "h-3.5 w-3.5";
  if (tab.kind === "chat") return <ChatBubble className={className} aria-hidden="true" />;
  return tab.kind === "browser" ? <Globe className={className} aria-hidden="true" /> : <Page className={className} aria-hidden="true" />;
}

function Tab({ tab, selected, pressed, presentation }: { tab: ViewTab; selected: boolean; pressed: boolean; presentation: Presentation }) {
  const segmented = presentation === "composer";
  const tone = segmented ? (selected ? chrome.VIEWS_SEGMENT_SELECTED : chrome.VIEWS_TAB_IDLE) : selected ? chrome.VIEWS_TAB_SELECTED : chrome.VIEWS_TAB_IDLE;
  return (
    <span
      data-testid="landing-view-tab"
      data-view-id={tab.id}
      data-selected={selected ? "true" : "false"}
      data-pressed={pressed ? "true" : undefined}
      title={tab.title}
      className={`${segmented ? chrome.VIEWS_SEGMENT : chrome.VIEWS_TAB_WRAP} ${tone}`}
    >
      <span
        className={
          `${segmented ? `${chrome.VIEWS_SEGMENT_TAB} ${selected ? chrome.VIEWS_SEGMENT_TAB_SELECTED : ""}` : `${chrome.VIEWS_TAB} ${selected ? chrome.VIEWS_TAB_UNDERLINE : ""}`}${
            pressed ? ` ${chrome.VIEWS_TAB_PRESSED}` : ""
          }`
        }
      >
        <span className="shrink-0">
          <TabIcon tab={tab} />
        </span>
        {/* TabLabel: the label truncates, and the attention (amber Approve
            text) follows it whole. */}
        <span className={chrome.VIEWS_TAB_LABEL}>{tab.label}</span>
        {tab.attention ? (
          <span className={chrome.VIEWS_APPROVE_BADGE} data-testid="landing-view-approve">
            Approve
          </span>
        ) : null}
      </span>
      {tab.kind === "file" ? (
        <span className={chrome.VIEWS_TAB_CLOSE}>
          <Xmark className="h-3.5 w-3.5" aria-hidden="true" />
        </span>
      ) : null}
    </span>
  );
}

/**
 * The views bar under the window's tab strip (md and up). Side by side, the
 * chat column keeps its toolbar ("Chat") and the tabs name the resources, the
 * selected one shown beside the chat; in one view Chat is the first tab.
 */
export function LandingViewsBar({ pane, split }: { pane: PaneState; split: boolean }) {
  const tabs = split ? pane.tabs : [CHAT_TAB, ...pane.tabs.filter((tab) => !tab.splitOnly)];
  const selected = split ? pane.selected : pane.single === "browser" ? "browser" : "chat";
  return (
    <div aria-hidden="true" data-testid="landing-views-bar" data-layout={split ? "split" : "single"} className={chrome.VIEWS_BAR}>
      {split ? (
        <div className={chrome.VIEWS_CHAT_TOOLBAR} style={{ width: `${(1 - chrome.SPLIT_RESOURCE_RATIO) * 100}%` }}>
          <ChatBubble className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Chat</span>
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
        {tabs.map((tab) => (
          <Tab key={tab.id} tab={tab} selected={tab.id === selected} pressed={!split && tab.id === pane.pressed} presentation="header" />
        ))}
      </div>
      {split ? (
        <span className={chrome.VIEWS_SPLIT_TOGGLE} title="Show one view" data-cub-anchor="action">
          <ViewColumns3 className="h-4 w-4" aria-hidden="true" />
        </span>
      ) : null}
    </div>
  );
}

/** Phones: the same views as a segmented control above the composer. */
export function LandingViewsSegmented({ pane }: { pane: PaneState }) {
  const tabs = [CHAT_TAB, ...pane.tabs.filter((tab) => !tab.splitOnly)];
  const selected = pane.single === "browser" ? "browser" : "chat";
  return (
    <div aria-hidden="true" data-testid="landing-views-segmented" className={chrome.VIEWS_SEGMENTED}>
      {tabs.map((tab) => (
        <Tab key={tab.id} tab={tab} selected={tab.id === selected} pressed={tab.id === pane.pressed} presentation="composer" />
      ))}
    </div>
  );
}
