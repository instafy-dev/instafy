// What the conversation's views show at each beat: the tabs in the views bar,
// the resource beside the chat, and the Shared Browser's state. A pure
// function of (scenario, beat), like the transcript: LandingViews,
// LandingFileView and LandingBrowserView draw whatever it says.
//
// Everything here is something the studio does (docs/Shared-Browser.md):
// - a file Kim pointed to is open beside the chat, and clicking a file
//   reference opens the result with its lines selected;
// - the Shared Browser opens only from Ada's press on Octo's "Continue in
//   browser" card, starts ("Starting Shared Browser"), asks her to approve
//   the preview's site before Octo may read it (the prompt asks in Octo's
//   words, and she presses Allow site), then shows Octo's work: the edge glow while it controls the page, its cursor at
//   each click (lingering 4 s), and the ticker's captions in the runtime's own
//   words ("Go to …", the page title, Scroll, Click "…");
// - Kim's named pointer is on the same page, never on the control Octo
//   clicked;
// - in one view the press brings the browser to the front (the studio selects
//   it as it opens) and nothing brings the chat back on its own: once Octo is
//   done, Ada taps Chat (her press shows on the tab first) to read what it
//   found, and Kim's reply.

import { beatReached, type PaneFile, type SessionScenario, type TurnBeatId } from "./landingTurnScript";

/** ActionTicker.tsx's action types the landing uses, which pick the dot's colour. */
export type BrowserActionType = "navigate" | "nav_result" | "click" | "scroll";

export interface BrowserTicker {
  type: BrowserActionType;
  label: string;
}

export interface ViewTab {
  /** "chat", "browser", or "file:<path>" (conversationSurfaces.ts ids). */
  id: string;
  kind: "chat" | "browser" | "file";
  label: string;
  /** The full path a file tab's title shows. */
  title: string;
  /**
   * Opened by a click on a file reference beside the chat. One view keeps the
   * conversation in front instead (its artifact is the inline file card), so
   * only a split shows the tab.
   */
  splitOnly?: boolean;
  /** The amber Approve badge (a site approval waits). */
  attention?: boolean;
}

export interface BrowserStage {
  /** The session is up (before that, the Starting Shared Browser card). */
  connected: boolean;
  /** The preview is loaded (before that, a blank page). */
  page: boolean;
  /** The site approval over the page, in Octo's words. */
  approval: "none" | "site";
  /** Ada's press on the approval's Allow button is going down. */
  allowPressed: boolean;
  /** Octo controls the page (the edge glow). */
  glow: boolean;
  /** The address field: null shows the placeholder. */
  address: string | null;
  placeholder: string;
  ticker: BrowserTicker | null;
  /** Octo's cursor at its click (it lingers 4 s after the click). */
  cursor: boolean;
  /**
   * Kim's pointer: not on the page yet, resting beside the Compare plans
   * heading, or beside the Team column of the comparison as she answers
   * (never on the button Octo clicked).
   */
  kim: "away" | "rest" | "compare";
  teamSelected: boolean;
  scrolled: boolean;
  /** Who is in the browser, in the participants button's order. */
  participants: ("ada" | "kim")[];
}

export interface PaneState {
  tabs: ViewTab[];
  /** The resource the split's pane shows. */
  selected: string;
  /** What one view shows: the chat, or the browser while Octo works in it. */
  single: "chat" | "browser";
  /** The view tab Ada's press is going down on (one view only shows it), or null. */
  pressed: string | null;
  file: { tab: string; file: PaneFile; select: readonly [number, number] | null } | null;
  browser: BrowserStage | null;
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const fileTab = (file: PaneFile, splitOnly = false): ViewTab => ({
  id: `file:${file.path}`,
  kind: "file",
  label: basename(file.path),
  title: file.path,
  ...(splitOnly ? { splitOnly } : {}),
});

function browserStage(scenario: SessionScenario, beat: number): BrowserStage {
  const at = (id: TurnBeatId) => beatReached(scenario, beat, id);
  const script = scenario.browser!;
  const connected = at("handoff");
  const working = at("browse") && !at("browseDone");
  const ticker: BrowserTicker | null = at("click")
    ? { type: "click", label: `Click "${script.clickLabel}"` }
    : at("scroll")
      ? { type: "scroll", label: "Scroll" }
      : at("loaded")
        ? { type: "nav_result", label: script.title }
        : at("navigate")
          ? { type: "navigate", label: `Go to ${script.url}` }
          : null;
  return {
    connected,
    page: at("navigate"),
    approval: at("allowed") ? "none" : at("approve") ? "site" : "none",
    allowPressed: at("allowPress") && !at("allowed"),
    glow: working,
    address: at("navigate") ? script.url : null,
    placeholder: connected ? "Enter an address" : "Connecting to Shared Browser…",
    ticker,
    cursor: at("click") && !at("settle"),
    // Kim's pointer comes onto the page once Octo has scrolled to the plans,
    // and moves to the plan comparison, away from Octo's click, as she answers.
    kim: at("kimTyping") ? "compare" : at("scroll") ? "rest" : "away",
    teamSelected: at("click"),
    scrolled: at("scroll"),
    participants: at("loaded") ? ["ada", "kim"] : ["ada"],
  };
}

export function paneStateFor(scenario: SessionScenario, beat: number): PaneState {
  const at = (id: TurnBeatId) => beatReached(scenario, beat, id);
  const { open, artifact } = scenario.pane;
  const openTab = fileTab(open);

  if (scenario.browser) {
    const browserOpen = at("press");
    const browser = browserOpen ? browserStage(scenario, beat) : null;
    // The studio lists the browser before the files (ConversationWorkspaceViews.tsx).
    const tabs: ViewTab[] = browserOpen
      ? [
          {
            id: "browser",
            kind: "browser",
            label: "Browser",
            title: "Browser",
            ...(browser!.approval !== "none" ? { attention: true } : {}),
          },
          openTab,
        ]
      : [openTab];
    // The press selects the browser (useChatBrowserRequest.ts activate), and
    // it stays in front of one view until Ada's own tap on Chat once Octo is
    // done: her press shows on the tab, then the chat is in front.
    const backToChat = at("kimTyping");
    return {
      tabs,
      selected: browserOpen ? "browser" : openTab.id,
      single: browserOpen && !backToChat ? "browser" : "chat",
      pressed: at("browseDone") && !backToChat ? "chat" : null,
      file: { tab: openTab.id, file: open, select: null },
      browser,
    };
  }

  if (artifact && !artifact.sameTab) {
    const shown = at("artifact");
    const resultTab = fileTab(artifact.file, true);
    return {
      tabs: shown ? [openTab, resultTab] : [openTab],
      selected: shown ? resultTab.id : openTab.id,
      single: "chat",
      pressed: null,
      file: shown ? { tab: resultTab.id, file: artifact.file, select: artifact.select } : { tab: openTab.id, file: open, select: null },
      browser: null,
    };
  }

  // The same file, edited in place: its content changes once Octo's files
  // land, and the click on the file card selects the changed lines.
  return {
    tabs: [openTab],
    selected: openTab.id,
    single: "chat",
    pressed: null,
    file: {
      tab: openTab.id,
      file: artifact && at("files") ? artifact.file : open,
      select: artifact && at("artifact") ? artifact.select : null,
    },
    browser: null,
  };
}
