// Every class string the landing example copies from the studio, one constant
// each, with the file and line it came from. All strings are static so
// Tailwind's scanner sees them. Where a studio string carries a cool-slate
// dark border or background (slate-700/800 borders, slate-900/950 fills) the
// same-tier darkSurfaces helper is substituted and the comment says so.
// Crew colours are inline styles at the call sites (landingCrew.ts), never
// classes, and so are the label colours that read on them.

import {
  DARK_ACTIVE_BG_CLASS,
  DARK_CANVAS_CLASS,
  DARK_DIVIDER_BORDER_CLASS,
  DARK_DIVIDER_CLASS,
  DARK_PANEL_BG_CLASS,
  DARK_PANEL_BORDER_CLASS,
  DARK_PANEL_SURFACE_CLASS,
  DARK_RAIL_SURFACE_CLASS,
  DARK_RAISED_CONTROL_BG_CLASS,
  DARK_RAISED_CONTROL_BORDER_CLASS,
  DARK_RAISED_CONTROL_CLASS,
} from "../../theme/darkSurfaces";

// ---------------------------------------------------------------------------
// Focus ring (landing-only): the example's own controls (the chips and the
// join link) sit on the landing's paper canvas, so their ring offset matches
// that canvas in both themes rather than a panel.

export const CANVAS_RING_OFFSET = "focus-visible:ring-offset-[var(--marketing-canvas)]";

// ---------------------------------------------------------------------------
// Frame and workspace surface

// StudioLayout.tsx:1987 (canvas) with the landing card's own radius and shadow.
// Landing-only: the shadow's negative spread keeps the paper above the top
// edge exactly --marketing-canvas, the colour Cub's body is filled with where
// he sits on the ledge (a soft halo there would show his outline as a lighter
// patch). It is the approved hero's window shadow. The window has a fixed
// height, like the studio's screen: a longer conversation scrolls inside it
// (TurnColumn keeps the newest message in view, as the chat does), so no
// scenario or beat ever changes the page's layout. From 1184px (the split) it
// fits the first view: the viewport less its top in the document
// (--landing-deck-top, landingDeckLayout.ts useLandingDeckFit) and a 16px
// margin, between 19rem and the full 47rem (74rem is 1184px, written in rem
// so it sorts after md), so the conversation's newest
// message, the composer and the browser's stage down to its ticker are on
// screen without a scroll, down to a 1366x768 laptop's 657px first view.
export const FRAME = `group/deck relative flex h-[52rem] overflow-hidden rounded-2xl border border-slate-200/70 bg-slate-50 text-left shadow-[0_1px_0_rgba(15,23,42,0.03),0_2px_6px_-2px_rgba(15,23,42,0.06),0_36px_80px_-40px_rgba(15,23,42,0.3)] md:h-[47rem] min-[74rem]:h-[clamp(19rem,calc(100svh_-_var(--landing-deck-top,29rem)_-_1rem),47rem)] ${DARK_CANVAS_CLASS} ${DARK_PANEL_BORDER_CLASS} dark:shadow-studio-dark-panel`;

// StudioLayout.tsx:1947 workspace surface (tab strip + panel).
export const WORKSPACE = `flex min-w-0 flex-1 flex-col overflow-hidden bg-white text-slate-700 shadow-sm ${DARK_PANEL_BG_CLASS} dark:text-slate-200`;

// ---------------------------------------------------------------------------
// Rail (StudioSidebar.tsx)

// StudioSidebar.tsx:1296-1308: the nav surface; widths (w-56 / w-[4rem]) and
// display classes are added at the call site. The studio nav is h-full under
// a h-screen shell; inside the content-sized frame that percentage resolves
// to auto, so the rail relies on the flex row's stretch instead.
export const RAIL_SURFACE = `group relative min-h-0 shrink-0 self-stretch flex-col overflow-hidden border-r border-slate-200/70 bg-slate-50/80 pb-4 text-slate-600 dark:text-slate-300 ${DARK_RAIL_SURFACE_CLASS}`;
// StudioSidebar.tsx:1318 (overflow-y-auto becomes hidden: the example never scrolls).
export const RAIL_LIST = "min-h-0 flex-1 space-y-1 overflow-hidden pb-2";

// StudioSidebar.tsx:90 EXPANDED_SIDEBAR_ROW_LAYOUT_CLASS + Button ghost sm lg fullWidth (Button.tsx:12-40, py-1.5 override).
export const ROW_EXPANDED = "inline-flex w-full items-center justify-start gap-2.5 rounded-lg px-3 py-1.5 text-sm font-medium";
// StudioSidebar.tsx:97-101 row tones.
export const ROW_EXPANDED_ACTIVE = `bg-white text-slate-900 ${DARK_ACTIVE_BG_CLASS} dark:text-slate-50`;
export const ROW_EXPANDED_INACTIVE = "text-slate-600 dark:text-slate-300";
// StudioSidebar.tsx:92 compact density (navHeight < 760) collapsed row.
export const ROW_COLLAPSED = "inline-flex w-full items-center justify-center rounded-lg px-1 py-1";

// StudioSidebar.tsx:343-352 icon shell; expanded keeps the h-9 shell, the
// collapsed rail at compact density (236-262) uses h-8.
export const SHELL_EXPANDED = "relative flex h-9 w-9 min-w-[2.25rem] items-center justify-center rounded-lg border transition-colors";
export const SHELL_COLLAPSED = "relative flex h-8 w-8 min-w-[2rem] items-center justify-center rounded-lg border transition-colors";
// In the expanded rail an active glyph is primary and the row turns white;
// the blue tile is collapsed-only.
export const SHELL_EXPANDED_ACTIVE = "border-transparent bg-transparent text-primary-600 dark:text-primary-500";
export const SHELL_COLLAPSED_ACTIVE = "border-primary-200 bg-primary-50 text-primary-600 dark:border-primary-500/40 dark:bg-primary-500/10 dark:text-primary-500";
export const SHELL_INACTIVE = "border-transparent text-slate-400 dark:text-slate-500";
// StudioSidebar.tsx:1414-1420 borderless deck shell around SidebarOrgDeck.
export const DECK_SHELL_EXPANDED = "relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg";
export const DECK_SHELL_COLLAPSED = "relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg";

// StudioSidebar.tsx:1383-1386 (Home) and StudioSidebarMorePanels.tsx:150-152 (More) labels.
export const RAIL_LABEL = "flex flex-1 items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200";
// StudioSidebar.tsx:1424-1436 the two-line team-and-spaces label.
export const RAIL_TEAM_LABEL = "flex min-w-0 flex-1 items-center justify-between gap-2 text-left";
// StudioRecentChats.tsx:134-139 the Chats trigger label.
export const RAIL_CHATS_LABEL = "flex min-w-0 flex-1 items-center justify-between gap-2 text-sm font-medium";

// StudioRecentChats.tsx:180 (expanded list wrapper) and 50 (list).
export const RECENT_LIST_WRAP = "ml-6 mr-3 py-2";
export const RECENT_LIST = "space-y-1";
// StudioRecentChats.tsx:74-79 recent chat row (Button ghost sm lg fullWidth).
export const RECENT_CHAT_ROW = "inline-flex w-full min-h-9 min-w-0 items-center gap-2 rounded-lg px-2.5 text-left";
export const RECENT_CHAT_ROW_SELECTED = `bg-white text-slate-900 ${DARK_ACTIVE_BG_CLASS} dark:text-slate-50`;
export const RECENT_CHAT_ROW_IDLE = "text-slate-600 dark:text-slate-300";
// StudioRecentChats.tsx:81 the title span.
export const RECENT_CHAT_TITLE = "min-w-0 flex-1 truncate text-sm";
export const RECENT_CHAT_TITLE_SELECTED = "font-medium text-slate-900 dark:text-slate-50";
export const RECENT_CHAT_TITLE_IDLE = "font-normal text-slate-700 dark:text-slate-300";
// StudioRecentChats.tsx:86 the "Running" status text.
export const RECENT_CHAT_STATUS = "shrink-0 text-xs font-normal text-slate-600 dark:text-slate-400";
// StudioRecentChats.tsx:99-117 Browse all chats.
export const BROWSE_ALL_ROW = "mt-1 inline-flex w-full min-h-9 items-center rounded-lg px-2.5 text-left";
export const BROWSE_ALL_LABEL = "flex w-full min-w-0 items-center justify-between gap-2 text-sm font-normal text-slate-600 dark:text-slate-400";

// StudioSidebarAccountSection.tsx:189 (footer) and 212-219 (expanded profile row,
// Button ghost sm lg with w-full justify-start gap-3 text-left).
export const RAIL_FOOTER = "flex shrink-0 flex-col gap-3 pt-6";
export const RAIL_FOOTER_COLLAPSED = "flex shrink-0 flex-col items-center gap-3 pt-6";
export const PROFILE_ROW = "inline-flex w-full items-center justify-start gap-3 rounded-lg px-2.5 py-1.5 text-left text-sm font-medium text-slate-700 dark:text-slate-200";
// StudioSidebarAccountSection.tsx:56-58 avatarShellClassName("h-9 w-9"); the
// neutral bg-slate-50/text-slate-700 give way to Ada's crew pink and its ink
// label so Ada keeps one colour everywhere in the example (inline style at the
// call site). Its edge is the coin's (AVATAR_SHELL): the avatar coin shadow in
// light, the raised-control border in dark.
export const PROFILE_AVATAR = `relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-full text-sm font-medium shadow-avatar-coin dark:border ${DARK_RAISED_CONTROL_BORDER_CLASS}`;
// StudioSidebarAccountSection.tsx:246-262 collapsed profile (IconButton ghost sm lg).
export const PROFILE_INITIAL_COLLAPSED = "inline-flex h-8 w-8 items-center justify-center rounded-lg text-sm font-medium text-slate-700 dark:text-slate-200";

// ---------------------------------------------------------------------------
// Tab strip (WorkspaceTabs.tsx) and phone bar (StudioTopBar.tsx)

// The window's top bar row (landing-only): the tab strip (md+) or the phone
// bar, with the roster laid over its right end the way the approved hero puts
// the roster in the window's first row, level with the ledge Cub sits on. The
// bar keeps a spacer where the roster lies (--roster-w wide), and from 1000px
// (LANDING_CUB_LAYOUT.cornerMinWidth) the roster stops --roster-end short of
// the window's right end: the room Cub's front arms and corner drape hang in,
// 2.1 perch units (u = clamp(48px, 5.5vw, 84px), the engine's desktop perch
// size), so Octo's coin sits left of him and his lent arm is a short hook.
// --cub-perch names the room the bar left (header or corner) and Cub reads it
// (cub/landingCub.ts), so his perch follows this media query, never the
// host's own width, which a classic scrollbar makes narrower than the
// viewport the query sees. landingCub.test.ts keeps these numbers equal to
// the engine's.
export const TOP_BAR =
  "relative flex-none [--roster-w:114px] [--roster-end:16px] [--cub-perch:header] md:[--roster-w:142px] min-[1000px]:[--roster-end:calc(2.1*clamp(48px,5.5vw,84px))] min-[1000px]:[--cub-perch:corner]";

// WorkspaceTabs.tsx:636-650 strip and its baseline span. Landing-only:
// isolate keeps the strip's own z-indexes (the active tab, the actions slot)
// inside the strip, so they never rise into the hero's stacking context above
// the hero's creature layer (see LandingHero.tsx); and in dark the strip takes
// the panel's surface instead of the canvas, so the window's top band reads as
// one slab under Cub rather than as open page.
export const TAB_STRIP = `relative isolate hidden md:flex max-w-full flex-none items-end gap-2 bg-white pr-2 pb-0 pt-0 ${DARK_PANEL_BG_CLASS}`;
export const TAB_BASELINE = `pointer-events-none absolute inset-x-0 bottom-0 z-0 h-px bg-slate-200/70 ${DARK_DIVIDER_CLASS}`;
// WorkspaceTabs.tsx:58-79 (base + active fused-white) and 916-930 (first tab
// flush: no top-left radius, transparent left border). Spans need none of
// the "!" overrides the react-aria Button needed.
export const TAB_ACTIVE = `relative z-10 -mb-px inline-flex h-[48px] items-center gap-2 rounded-t-xl rounded-tl-none rounded-b-none border border-slate-200/70 border-b-white border-l-transparent bg-white px-4 text-sm font-medium text-slate-950 after:pointer-events-none after:absolute after:-bottom-px after:left-0 after:right-0 after:h-[2px] after:bg-white ${DARK_PANEL_BG_CLASS} dark:text-slate-50 ${DARK_PANEL_BORDER_CLASS} dark:border-b-transparent dark:border-l-transparent dark:after:bg-[var(--color-studio-dark-panel)]`;
// WorkspaceTabs.tsx:992-1004 tab content.
export const TAB_CONTENT = "min-w-0 flex flex-1 items-center justify-start gap-1.5";
// WorkspaceTabs.tsx:1010-1016 close glyph (IconButton ghost xs full).
export const TAB_CLOSE = "inline-flex h-6 w-6 items-center justify-center rounded-full text-slate-500 dark:text-slate-400";
// StudioTopBar.tsx:327-332 desktopTabActionButtonClassName (the "+" and MoreHoriz).
export const TAB_ACTION = "inline-flex h-[48px] w-12 flex-none items-center justify-center rounded-none border border-transparent text-slate-500 dark:text-slate-300";
// WorkspaceTabs.tsx:735 actions slot.
export const TAB_ACTIONS = "relative z-20 ml-2 flex flex-none items-center self-end pl-2.5";
// useNotificationCenter.tsx:151-152 bell (IconButton ghost full h-10 w-10).
export const TAB_BELL = "inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-500 dark:text-slate-300";
// Landing-only: where the roster lies over the strip's right end (TOP_BAR).
export const TAB_ROSTER_SPACE = "flex-none self-stretch w-[calc(var(--roster-w)+var(--roster-end)-4px)]";

// StudioTopBar.tsx:521 phone grid; dark takes the panel's surface like the
// tab strip. Landing-only: the sidebar toggle, the bell and "+" give their
// room to the title and the roster, as in the approved hero's phone layout
// (the title, then the roster).
export const PHONE_BAR = `grid md:hidden grid-cols-[minmax(0,1fr)_auto] items-center gap-2 bg-white px-4 py-2 ${DARK_PANEL_BG_CLASS}`;
export const PHONE_ROSTER_SPACE = "h-10 w-[var(--roster-w)]";
// StudioTopBar.tsx:50 COMPACT_TAB_SELECTOR_CLASS (Button ghost xs full).
export const PHONE_PILL = "inline-flex h-10 min-w-0 max-w-full items-center gap-2 rounded-xl bg-slate-100 px-2.5 text-xs font-semibold text-slate-950 dark:bg-white/[0.06] dark:text-slate-50";

// ---------------------------------------------------------------------------
// Roster and transcript

// ConversationRoster.tsx:92-103, moved into the window's top bar row
// (TOP_BAR) and spaced like the approved hero's roster: 28px coins 10px apart
// (24px, 6px apart on phones), never overlapping. In the tab strip the coins
// sit level with the bell (their top 14px under the ledge), so the hook Cub
// lends Octo has room to curl. Landing-only: z-[4] lifts the (transparent)
// roster above the hero's creature layer at z-[3], so the coins always draw on
// top of the arm that reaches for them. No ancestor up to the hero may create
// a stacking context, or the lift stops there.
export const ROSTER =
  "pointer-events-none absolute right-[var(--roster-end)] top-0 z-[4] flex h-14 items-center gap-1.5 md:h-12 md:items-end md:gap-2.5 md:pb-1.5";
// The ring is a 1px separator in the bar's own colour, not an outline: on the
// bar it does not show, and where Cub's arm passes behind a coin it keeps a
// sliver of bar between them. The coin's avatar coin shadow draws over it.
export const ROSTER_RING = "rounded-full ring-1 ring-white dark:ring-[var(--color-studio-dark-panel)]";
// The scenario agent's coin is a rounded square (AVATAR_SHELL_AGENT); its ring follows it.
export const ROSTER_RING_AGENT = "rounded-[30%] ring-1 ring-white dark:ring-[var(--color-studio-dark-panel)]";

// ChatTranscriptViewport.tsx:82-90 without the scrollbar. Landing-only:
// isolate keeps the transcript's own z-indexes below the hero's creature
// layer; and with the roster moved up into the top bar, the conversation
// starts 16px under that bar rather than 8px under a roster row.
export const TRANSCRIPT = "relative isolate flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-2 pt-4 sm:px-4";
// The transcript's scroll (landing-only): the column moves up as the newest
// message lands, the way the chat stays pinned to its bottom
// (browserSessionLayout.ts shouldPinChatMessagesToBottom). Instant on the
// first paint and on a scenario change, eased afterwards.
export const TRANSCRIPT_SCROLL = "transition-transform duration-0 ease-out group-data-[deck-settled]/deck:duration-500 motion-reduce:transition-none";

// ChatMessageAvatar.tsx wrapper: in light the coin's only edge is the avatar
// coin shadow every coin shares, Octo's included (docs/Brand.md); in dark a
// hairline border, the cool-slate border (700/800) replaced by the
// raised-control border tier, and the small shadow. Humans fill with their
// crew colour inline, label colour included.
export const AVATAR_SHELL = `flex shrink-0 items-center justify-center overflow-hidden rounded-full shadow-avatar-coin dark:border dark:shadow-sm ${DARK_RAISED_CONTROL_BORDER_CLASS}`;
// An agent other than Octo: the same coin as a rounded square (the prototype's
// roster), crew fill and initial inline; the shadow follows the square.
export const AVATAR_SHELL_AGENT = `flex shrink-0 items-center justify-center overflow-hidden rounded-[30%] shadow-avatar-coin dark:border dark:shadow-sm ${DARK_RAISED_CONTROL_BORDER_CLASS}`;
export const AVATAR_2XS = "h-6 w-6 text-xxs";
// The roster's coins (the approved hero's 28px, 11.5px initials; 24px on phones).
export const AVATAR_ROSTER = "h-6 w-6 text-xxs md:h-7 md:w-7 md:text-[11.5px]";
export const AVATAR_SM = "h-8 w-8 text-xs";
export const AVATAR_HUMAN = "font-semibold";
// Octo's coin is not copied here: the landing renders the studio's own
// OctoCoin (src/components/OctoCoin.tsx), sized by AVATAR_ROSTER / AVATAR_SM.

// AssistantSpeakerIdentityLabel (AssistantSpeakerIdentityPill.tsx) and HumanSpeakerIdentityLabel (chatHumanIdentity.tsx).
export const SPEAKER_LABEL = "inline-flex max-w-full items-center gap-2 text-xs text-slate-500 dark:text-slate-400";
export const SPEAKER_NAME = "min-w-0 truncate font-semibold text-slate-600 dark:text-slate-300";
export const SPEAKER_TIME = "flex-none text-xxs font-medium text-slate-400 dark:text-slate-500";

// ChatMessageEntries.tsx:101-137 NotchedMessageShell with the teammate tone (327-331).
export const SHELL_MESSAGE = "group relative inline-flex w-fit max-w-[min(92%,56rem)] min-w-0 flex-col items-start py-1 text-sm text-slate-800 dark:text-slate-200";
export const SHELL_MESSAGE_BODY = "w-full min-w-0";
// ChatMessageEntries.tsx:325-330 the current user's own bubble.
export const OWN_BUBBLE = `group relative inline-flex w-fit max-w-[min(92%,56rem)] min-w-0 flex-col items-start rounded-2xl rounded-br-none bg-slate-50/90 px-3.5 py-2.5 text-sm text-slate-800 ring-1 ring-inset ring-slate-200/70 ${DARK_RAISED_CONTROL_BG_CLASS} dark:text-slate-200 dark:ring-[color:var(--color-studio-dark-raised-control-border)]`;


// AgentJobThreadPreviewLayout.tsx:1283-1290 thread root; spine offsets from
// useAgentJobThreadPreviewState.ts:885-891 with a 0 safe inset. The studio
// root is overflow-hidden; here the spine sits 26px outside the root (its
// containing block is the body inside it) and would be clipped, so the root
// stays overflow-visible. Every wide child (diff card, code block, captions)
// clips or truncates itself, so nothing can escape sideways.
export const THREAD_ROOT = "w-full min-w-0 max-w-2xl text-sm text-slate-700 dark:text-slate-200";
// AgentJobThreadPreviewLayout.tsx agent-job-thread-avatar: Octo's coin sits
// above the thread spine that runs up into it, so the spine never cuts the
// coin's edge.
export const THREAD_AVATAR = "relative z-10";
export const THREAD_BODY = "relative flex flex-col";
export const THREAD_SPINE_LEFT = "-30px";
export const THREAD_SPINE_MAIN =
  "pointer-events-none absolute left-[var(--thread-spine-left)] transition-opacity duration-0 ease-out group-data-[deck-settled]/deck:duration-200 motion-reduce:transition-none";
export const THREAD_SPINE_NOTCH = "pointer-events-none absolute top-0 h-full left-[var(--thread-spine-left)]";
// TurnActivityLine.tsx: the turn's one activity line, muted caption text on
// one 20px line that truncates, at every beat, so the pinned transcript never
// bobs as its words change; while the turn runs its words sweep, and once it
// ended Details follows them.
export const ACTIVITY_SECTION = "relative py-1";
export const ACTIVITY_ROW = "flex h-5 max-w-full min-w-0 items-center gap-1.5 pl-1 text-xs leading-5 text-slate-500 dark:text-slate-400";
export const ACTIVITY_TEXT = "min-w-0 truncate";
export const ACTIVITY_TEXT_LIVE = "instafy-status-sweep min-w-0 truncate";
export const ACTIVITY_DETAILS = "inline-flex flex-none items-center gap-0.5 font-medium";
// AgentJobThreadPreviewLayout.tsx:1626-1650 the completed summary section.
export const SUMMARY_SECTION = "relative pt-2 pb-0";
export const SUMMARY_STACK = "space-y-1.5";
// ChatMessageContent.tsx:1790 container and 1859-1873 paragraph measure.
export const MESSAGE_CONTENT = "text-sm leading-relaxed break-words [overflow-wrap:anywhere]";
export const MESSAGE_PARAGRAPH = "text-sm leading-relaxed max-w-[70ch] whitespace-pre-wrap break-words [overflow-wrap:anywhere]";
// ChatMessageContent.tsx:134-137 INLINE_CODE_TOKEN_CLASS.
export const INLINE_CODE = "inline rounded bg-slate-950/[0.025] px-[0.2em] py-[0.04em] font-mono text-[0.92em] leading-[1.18] text-slate-700 [box-decoration-break:clone] align-baseline dark:bg-white/[0.035] dark:text-slate-200";
// ChatMessageContent.tsx:167-170 WORKSPACE_FILE_REFERENCE_TOKEN_CLASS, its
// folder (1204) and name (1208) spans. HOVER is its hover tone, which the
// reference wears on the beat Ada opens it.
export const FILE_REFERENCE = "inline-flex min-w-0 max-w-[14rem] items-center overflow-hidden rounded-[0.34rem] bg-primary-50/70 px-1.5 py-[0.08em] font-mono text-[0.92em] leading-[1.18] text-primary-700 ring-1 ring-inset ring-primary-200/80 shadow-[inset_0_-1px_0_rgba(0,122,204,0.08)] align-baseline sm:max-w-[24rem] dark:bg-primary-300/10 dark:text-primary-200 dark:ring-primary-300/20 dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.035)]";
export const FILE_REFERENCE_HOVER = "bg-primary-100/80 text-primary-800 dark:bg-primary-300/15 dark:text-primary-100";
export const FILE_REFERENCE_FOLDER = "min-w-0 truncate text-slate-600 dark:text-slate-400";
export const FILE_REFERENCE_NAME = "min-w-0 max-w-full flex-none truncate";
// ChatMessageContent.tsx:1664-1672 a link (an unknown host whose label already
// names it). Landing-only: it wraps as a whole onto its own line where it fits
// (the studio's break-all would split the preview URL mid-word in the split's
// chat column).
export const MESSAGE_LINK = "[overflow-wrap:anywhere] text-primary-600 underline underline-offset-2 dark:text-primary-300";
// AgentJobThreadPreviewLayout.tsx:1728-1736 the end stub.
export const END_STUB = "relative h-4";

// ChatFileChangeList.tsx:84-91 rail chips (hover and focus dress dropped: spans).
export const CHIP_BASE = "inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border px-2.5 text-xs";
export const SUMMARY_TOGGLE = `${CHIP_BASE} -ml-1.5 border-transparent px-1.5 font-medium text-slate-700 dark:text-slate-200`;
export const ACTION_CHIP = `${CHIP_BASE} border-transparent font-medium text-slate-600 dark:text-slate-300`;
export const CHIP_FILE = `${CHIP_BASE} border-slate-200/70 bg-white/75 font-mono text-slate-700 dark:border-white/[0.09] dark:bg-white/[0.045] dark:text-slate-200`;
export const CHIP_FILE_ACTIVE = `${CHIP_BASE} border-primary-300/70 bg-primary-50/70 font-mono text-primary-800 dark:border-primary-300/50 dark:bg-primary-300/[0.16] dark:text-primary-200`;
// ChatFileChangeList.tsx:762-767 rail root and row.
export const FILE_RAIL = "mt-2 text-sm";
export const FILE_RAIL_ROW = "flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1.5";
// ChatFileChangeList.tsx:96-112 LineDelta and the loading pill (780-784).
export const LINE_DELTA = "[grid-area:1/1] inline-flex shrink-0 translate-y-px items-center gap-1 font-mono text-xxs";
export const LINE_DELTA_ADDED = "text-emerald-700 dark:text-emerald-300/85";
export const LINE_DELTA_REMOVED = "text-rose-700 dark:text-rose-300/85";
export const LOADING_PILL = "[grid-area:1/1] h-2 w-5 shrink-0 animate-pulse rounded-full bg-slate-200 dark:bg-white/[0.10]";
// ChatFileChangeList.tsx:828-831 divider.
export const FILE_RAIL_DIVIDER = "mx-0.5 h-4 w-px shrink-0 self-center bg-slate-200 dark:bg-white/[0.1]";
// ChatFileChangeList.tsx:909-1030 the diff card.
export const DIFF_CARD = "mt-2 overflow-hidden rounded-xl border border-slate-200/70 bg-white/75 shadow-sm shadow-slate-900/5 dark:border-white/[0.08] dark:bg-white/[0.035] dark:shadow-none";
export const DIFF_CARD_HEADER = "flex items-center justify-between gap-3 px-3 py-1.5";
// ChatFileChangeList.tsx:39-44 resolveChangeMeta("changed") and 50-57 ("created").
export const DIFF_BADGE_UPDATED = "shrink-0 rounded-full border border-secondary-200/80 bg-secondary-50/80 px-2 py-0.5 text-3xs font-medium text-secondary-700 dark:border-secondary-400/25 dark:bg-secondary-400/[0.07] dark:text-secondary-200/85";
export const DIFF_BADGE_CREATED = "shrink-0 rounded-full border border-primary-200/80 bg-primary-50/80 px-2 py-0.5 text-3xs font-medium text-primary-700 dark:border-primary-400/25 dark:bg-primary-400/[0.07] dark:text-primary-200/85";
export const DIFF_FILENAME = "min-w-0 truncate font-mono text-xs text-slate-700 dark:text-slate-300";
export const DIFF_GLYPHS = "flex shrink-0 items-center gap-1 text-slate-400 dark:text-slate-500";
export const DIFF_BODY = "border-t border-slate-200/70 bg-slate-50/80 font-mono text-xs dark:border-white/[0.07] dark:bg-white/[0.02]";
// The studio row is whitespace-pre inside a scrolling card; this copy wraps
// (and takes a size step at phone width) because DIFF_CARD is overflow-hidden,
// so an over-long row would otherwise be clipped mid-token with no affordance,
// and overflow-x-auto is not an option: Chromium turns an overflowing scroller
// into a keyboard tab stop and nothing inside the window may take focus.
export const DIFF_ROW = "px-2 text-[0.65rem] sm:px-3 sm:text-xs py-0.5 whitespace-pre-wrap [overflow-wrap:anywhere]";

// ChatTypingRows.tsx:218-232 the peer typing row.
export const PEER_TYPING_ROW = "flex items-center gap-2";

// ---------------------------------------------------------------------------
// Conversation views and the resource pane (ConversationSurfaceLayout.tsx,
// ConversationWorkspaceViews.tsx, ResizablePanels.tsx, ChatPanel.tsx resource
// surface). A file or the Shared Browser opens beside the chat: side by side
// when the panel is at least 1024px wide (the split default, the resource at
// 55%), one view at a time with Chat and resource tabs below that.

/** conversationSurfaces.ts DEFAULT_CONVERSATION_SURFACES: the resource takes 55% of a split. */
export const SPLIT_RESOURCE_RATIO = 0.55;

// ConversationSurfaceLayout.tsx:57 the views bar (header presentation): its
// tabs are min-h-11 (44px) over a 1px border, 45px in all.
export const VIEWS_BAR = `hidden md:flex min-w-0 shrink-0 items-center border-b border-slate-200/70 bg-white ${DARK_DIVIDER_BORDER_CLASS} ${DARK_PANEL_BG_CLASS}`;
// Landing-only: Cub's floor (TurnColumn's data-cub-anchor="floor") sits that
// 45px higher from md, where the views bar comes between the top bar and the
// conversation, so his front arms hang to where they did before it.
export const VIEWS_BAR_FLOOR_LIFT = "md:-top-[45px]";
// :59 the chat toolbar over the chat column of a split (its roster lives in
// the window's top bar on the landing, docs/Brand.md).
export const VIEWS_CHAT_TOOLBAR = "flex min-w-0 shrink-0 items-center gap-1.5 px-4 text-xs text-slate-500 dark:text-slate-400";
// :76 a tab's wrapper, selected or not.
export const VIEWS_TAB_WRAP = "flex min-w-0 shrink-0 items-center";
export const VIEWS_TAB_SELECTED = "text-slate-900 dark:text-slate-100";
export const VIEWS_TAB_IDLE = "text-slate-500 dark:text-slate-400";
// :83 the header tab (hover dress dropped: spans) and its primary underline when selected.
export const VIEWS_TAB = "relative flex min-h-11 min-w-0 max-w-52 items-center gap-1.5 px-3 text-xs after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:h-[1.5px] after:rounded-full";
export const VIEWS_TAB_UNDERLINE = "after:bg-primary-600 dark:after:bg-primary-400";
// TabPresentation.tsx TabLabel.
export const VIEWS_TAB_LABEL = "min-w-0 flex-1 truncate";
// Ada's press going down on a view tab (one view, the Chat tab once Octo is
// done in the browser): the studio's pressed tone for a ghost control
// (Button.tsx ghost data-[pressed]), which reads on the segmented control's
// grey as well as on the views bar's white.
export const VIEWS_TAB_PRESSED = "bg-slate-200/80 text-slate-900 dark:bg-[var(--color-studio-dark-active)] dark:text-slate-50";
// TabPresentation.tsx TabCloseButton (IconButton ghost xs full) with mr-1 text-inherit.
export const VIEWS_TAB_CLOSE = "mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-inherit";
// :88 Show one view (IconButton ghost sm, radius none, mx-1) at the bar's far right.
export const VIEWS_SPLIT_TOGGLE = "mx-1 ml-auto inline-flex h-8 w-8 shrink-0 items-center justify-center text-slate-700 dark:text-slate-200";
// ConversationWorkspaceViews.tsx:48 the Browser tab's attention while a site
// approval waits: plain amber text after the label (TabLabel's children).
export const VIEWS_APPROVE_BADGE = "text-amber-600";
// :57, :76 and :83 in the composer presentation (phones, beside the composer):
// a segmented control. Dark cool-slate fills (800/80, 700) are replaced by
// the raised-control and active tiers.
export const VIEWS_SEGMENTED = `mb-2 flex md:hidden min-w-0 items-center gap-1 rounded-2xl bg-slate-100/90 p-1 ${DARK_RAISED_CONTROL_BG_CLASS}`;
export const VIEWS_SEGMENT = "flex min-w-0 flex-1 items-center rounded-xl";
export const VIEWS_SEGMENT_SELECTED = `bg-white text-slate-900 shadow-sm ${DARK_ACTIVE_BG_CLASS} dark:text-slate-100`;
export const VIEWS_SEGMENT_TAB = "relative flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-xl px-2 text-sm";
export const VIEWS_SEGMENT_TAB_SELECTED = "font-medium text-primary-700 dark:text-primary-300";

// ResizablePanels.tsx:38 the split's 1px handle.
export const SPLIT_DIVIDER = `w-px shrink-0 self-stretch bg-slate-200 ${DARK_DIVIDER_CLASS}`;
// ChatPanel.tsx:5915-5961 the resource pane (a full-height column in a split,
// the whole view area in one view).
// The call site positions it (a column of the split, or over the transcript).
export const RESOURCE_PANE = `flex min-h-0 min-w-0 flex-col overflow-hidden bg-white ${DARK_PANEL_BG_CLASS}`;

// FilesPanel.tsx:2113 the editor header when embedded beside the chat (the
// title is screen-reader only, so only the controls show): Undo and Redo
// (HistoryControls.tsx, IconButton ghost sm full), Preview for Markdown
// (Button outline sm full, min-w-[6.5rem]) and Save (IconButton primary sm full).
export const FILE_HEADER = `flex shrink-0 items-center justify-end gap-1.5 border-b border-slate-200/70 px-4 py-2.5 sm:gap-2 ${DARK_DIVIDER_BORDER_CLASS}`;
export const FILE_HEADER_HISTORY = "inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 dark:text-slate-300";
export const FILE_HEADER_PREVIEW = `inline-flex h-8 min-w-[6.5rem] items-center justify-center gap-2 rounded-full border border-slate-200 bg-white px-2.5 text-sm font-medium text-slate-700 shadow-sm shadow-slate-200/40 ${DARK_RAISED_CONTROL_CLASS} dark:text-slate-100 dark:shadow-none`;
export const FILE_HEADER_SAVE = "inline-flex h-8 w-8 items-center justify-center rounded-full bg-primary-600 text-white shadow-sm shadow-primary-600/20";
// The Monaco editor in the studio's themes (monacoThemes.ts vscode-light-modern
// and vscode-dark-modern: background, foreground, line numbers, selection)
// with FilesPanel's options (14px mono, no minimap, line numbers except for
// Markdown and text).
export const EDITOR = "relative min-h-0 flex-1 overflow-hidden bg-white pt-1 font-mono text-[14px] leading-[19px] text-[#1f2328] dark:bg-[#1f1f1f] dark:text-[#d4d4d4]";
export const EDITOR_LINE = "flex h-[19px] whitespace-pre";
export const EDITOR_GUTTER = "w-[64px] shrink-0 select-none pr-[26px] text-right text-[#8c959f] dark:text-[#858585]";
export const EDITOR_GUTTER_ACTIVE = "text-[#24292f] dark:text-[#c6c6c6]";
// Without line numbers Monaco keeps a narrow left margin.
export const EDITOR_GUTTER_NONE = "w-[26px] shrink-0";
export const EDITOR_SELECTION = "bg-[#add6ff] dark:bg-[#264f78]";
export const EDITOR_TOKEN = {
  plain: "",
  keyword: "text-[#0000ff] dark:text-[#569cd6]",
  string: "text-[#a31515] dark:text-[#ce9178]",
  type: "text-[#267f99] dark:text-[#4ec9b0]",
} as const;

// BrowserChromeShell (compact) with the Shared Browser's toolbar pieces:
// BrowserTransportSelector's compact location button (PersonalBrowserSurface.tsx,
// Button ghost icon h-10 w-11), BrowserAddressField (AddressInput xs full,
// the Go button's NavArrowRight), the compact participants button
// (SharedBrowserCollaborationControls.tsx:216-237, one 20px avatar and +N)
// and Browser options (SharedBrowserSessionControl.tsx, IconButton ghost sm full).
export const BROWSER_LOCATION = "inline-flex h-10 w-11 shrink-0 items-center justify-center gap-0.5 rounded-lg text-slate-700 dark:text-slate-200";
// BrowserAddressField as a span; dark cool-slate background (950) replaced by the raised-control tier.
export const ADDRESS_FIELD = `relative block h-8 w-full min-w-0 truncate rounded-full border border-slate-200 bg-white pl-3 pr-9 text-xs leading-[30px] text-slate-800 shadow-inner ${DARK_RAISED_CONTROL_CLASS} dark:text-slate-100`;
export const ADDRESS_PLACEHOLDER = "text-slate-400 dark:text-slate-500";
export const ADDRESS_GO = "absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-slate-400";
export const BROWSER_PARTICIPANTS = "relative inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center rounded-full px-1.5";
export const BROWSER_PARTICIPANT_STACK = "flex shrink-0 items-center -space-x-1.5";
// The avatar's 2px ring takes the toolbar's colour (dark cool-slate 900 replaced by the soft panel tier).
export const BROWSER_PARTICIPANT = "inline-flex h-5 w-5 items-center justify-center rounded-full border-2 border-slate-50 text-[9px] font-semibold dark:border-[color:var(--color-studio-dark-panel-soft)]";
export const BROWSER_PARTICIPANT_MORE = "inline-flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-slate-50 bg-slate-600 px-1 text-[9px] font-semibold text-white dark:border-[color:var(--color-studio-dark-panel-soft)]";
export const BROWSER_OPTIONS = "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-700 dark:text-slate-200";
// BrowserSessionModal.tsx the viewport: slate under a live page, black only in
// dark mode (BROWSER_LIVE_STAGE_CLASS), and slate while the session starts
// (dark cool-slate 950 replaced by the canvas tier).
export const BROWSER_VIEWPORT = "relative min-h-0 flex-1 overflow-hidden";
export const BROWSER_VIEWPORT_STARTING = `bg-slate-100 ${DARK_CANVAS_CLASS}`;
export const BROWSER_VIEWPORT_LIVE = "bg-slate-100 dark:bg-black";
// :2855-2941 the starting card.
export const BROWSER_STATE_WRAP = "pointer-events-none absolute inset-0 flex items-center justify-center p-6";
export const BROWSER_STATE_CARD = `w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 text-left text-sm text-slate-700 shadow-xl ${DARK_PANEL_SURFACE_CLASS} dark:text-slate-200`;
// The page is a rendered website: light in both themes.
export const BROWSER_PAGE = "absolute inset-0 overflow-hidden bg-white text-slate-900";
export const BROWSER_PAGE_SCROLL = "transition-transform duration-500 ease-out motion-reduce:transition-none";

// BrowserCursorOverlay.tsx:160-190 Octo's cursor (no name: the agent's
// pointer is an unlabeled white arrow with an emerald ripple at each click)
// and SharedBrowserParticipantPointers.tsx:95-127 a teammate's named pointer.
export const POINTER_PATH = "M4 2.5 L4 15.5 L7.7 12.2 L10.1 17.4 L12.3 16.3 L9.9 11.2 L14.6 11.2 Z";
export const POINTER_LAYER = "pointer-events-none absolute inset-0 overflow-hidden";
export const AI_CURSOR = "absolute transition-[left,top,opacity] duration-300 ease-out motion-reduce:transition-none";
export const AI_CURSOR_RIPPLE = "absolute left-0 top-0 h-[22px] w-[22px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-emerald-400/40 motion-safe:animate-ping";
export const POINTER_SVG = "relative -translate-x-[3px] -translate-y-[2px] drop-shadow-[0_1px_2px_rgba(0,0,0,0.55)]";
// The studio moves a teammate's pointer in 75 ms linear steps as positions
// arrive (at most every 50 ms); one eased glide stands in for that stream.
export const PARTICIPANT_POINTER = "absolute transition-[left,top,opacity] duration-700 ease-out motion-reduce:transition-none";
export const PARTICIPANT_LABEL = "absolute left-3 top-3 max-w-32 truncate rounded-full px-2 py-0.5 text-[10px] font-semibold shadow-sm";

// ActionTicker.tsx overlay and pill (bg-slate-900/80 in both themes, as the real ticker) and its dots by action type.
export const TICKER_OVERLAY = "pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-2";
export const TICKER_PILL = "flex max-w-[92%] items-center gap-2 rounded-full border border-white/10 bg-slate-900/80 px-3 py-1 text-xxs font-medium text-slate-100 shadow-sm backdrop-blur-sm";
export const TICKER_DOT = "h-1.5 w-1.5 shrink-0 rounded-full";
export const TICKER_DOT_TONE = {
  navigate: "bg-sky-400",
  nav_result: "bg-sky-400",
  click: "bg-emerald-400",
  scroll: "bg-slate-400",
} as const;

// SharedBrowserApprovalPrompt.tsx: the site approval over the stage. Surface,
// Text and the dialog footer are shared components; the drawn controls and
// animated content remain noninteractive so the demo holds no tab stop.
export const APPROVAL_SCRIM = "absolute inset-0 z-30 flex items-end justify-center overflow-hidden bg-slate-950/60 p-2 backdrop-blur-[2px] sm:items-center sm:p-4";
export const APPROVAL_SHEET = "flex max-h-full w-full max-w-md flex-col overflow-hidden";
// StudioDialogBody's responsive gutter and geometry. The studio's content
// scrolls (overflow-y-auto); the landing's never does, so it holds no tab stop.
export const APPROVAL_CONTENT = "min-h-0 flex-1 overflow-hidden overscroll-contain px-4 py-4 sm:px-5 space-y-4";
export const APPROVAL_LOCK = "mt-0.5 h-4 w-4 shrink-0";
// The sentence the studio's sheet asks with (its title).
export const APPROVAL_SENTENCE = "min-w-0 flex-1 break-words";
export const APPROVAL_SITE = "px-3 py-2.5";
export const APPROVAL_SITE_TEXT = "mt-0.5 break-all";
export const APPROVAL_ACTIONS = "flex flex-col gap-2 min-[420px]:flex-row min-[420px]:justify-end";
// Button preset=form: flat 12px corners and pointer-adaptive targets. These
// spans retain the landing's simulation rather than introducing real controls.
const APPROVAL_BUTTON = "inline-flex w-full items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium pointer-coarse:min-h-11 pointer-coarse:min-w-11 min-[420px]:w-auto";
export const APPROVAL_BUTTON_SECONDARY = `${APPROVAL_BUTTON} bg-slate-100 text-slate-700 dark:bg-[var(--color-studio-dark-active)] dark:text-slate-100`;
export const APPROVAL_BUTTON_PRIMARY = `${APPROVAL_BUTTON} bg-primary-600 text-white transition-[background-color,transform] duration-150 ease-out motion-reduce:transition-none`;

// Button.tsx at sm, radius full: secondary (Deny) and primary.
export const BUTTON_SECONDARY = "inline-flex w-full items-center justify-center gap-2 rounded-full bg-slate-100 px-2.5 py-1.5 text-sm font-medium text-slate-700 shadow-sm shadow-slate-200/60 min-[420px]:w-auto dark:bg-[var(--color-studio-dark-active)] dark:text-slate-100 dark:shadow-none";
export const BUTTON_PRIMARY = "inline-flex items-center justify-center gap-2 rounded-full bg-primary-600 px-2.5 py-1.5 text-sm font-medium text-white shadow-sm shadow-primary-600/20 transition-[background-color,box-shadow,transform] duration-150 ease-out motion-reduce:transition-none";
// Button.tsx data-[pressed] on the primary tone: Ada's press going down.
export const BUTTON_PRIMARY_PRESSED = "translate-y-px scale-[0.98] bg-primary-800 shadow-none";
// Button.tsx data-[disabled] (a busy action is disabled).
export const BUTTON_DISABLED = "opacity-60";

// ChatActionCard.tsx:41-90 (Surface default, 2xl, sm shadow) as the
// "Continue in browser" request renders it (runtime-agent browser_request.rs).
export const ACTION_CARD = "max-w-[min(80%,42rem)] px-3 py-2.5 text-sm text-slate-700 dark:text-slate-200";

// ---------------------------------------------------------------------------
// Composer (ChatComposerSurface.tsx:1301-1370, chatComposerAffordances.ts:77-80,
// chat-input/ChatInput.tsx:343, Button.tsx primary)

export const COMPOSER_WRAP = "px-3 pb-2 sm:px-4";
// ChatComposerSurface.tsx:1301-1312 Surface overrides.
export const COMPOSER_SURFACE = `flex flex-col overflow-hidden border-slate-200/70 bg-slate-50 p-1.5 ${DARK_RAISED_CONTROL_BG_CLASS} ${DARK_PANEL_BORDER_CLASS}`;
export const COMPOSER_ROW = "relative flex items-end gap-2";
export const COMPOSER_LEADING = "flex flex-none items-center gap-0.5";
export const COMPOSER_TRAILING = "flex flex-none items-center justify-end gap-0.5";
// ChatComposerSurface.tsx:203 COMPOSER_EDITOR_WRAPPER_CLASS.
export const COMPOSER_EDITOR = "flex min-h-9 min-w-0 flex-1 flex-col justify-center";
// IconButton md xl + composerGhostActionClass (chatComposerAffordances.ts:77-80).
export const GHOST_ACTION = "inline-flex h-9 w-9 items-center justify-center rounded-xl [&_svg]:text-slate-600 dark:[&_svg]:text-slate-300";
export const COMPOSER_ICON = "h-[22px] w-[22px]";
// Button.tsx primary tone at IconButton md xl; pressed = translate-y-px scale-[0.98].
export const SEND_PRIMARY = "inline-flex h-9 w-9 items-center justify-center rounded-xl bg-primary-600 text-white dark:bg-primary-500";
export const SEND_PRESSED = "translate-y-px scale-[0.98]";
// chat-input/ChatInput.tsx:343 placeholder and editor text.
export const PLACEHOLDER = "pointer-events-none absolute inset-x-0 block overflow-hidden text-ellipsis whitespace-nowrap pr-2 text-base leading-5 text-slate-400 sm:text-sm dark:text-slate-500";
export const TYPED_TEXT = "absolute inset-x-0 block overflow-hidden text-ellipsis whitespace-nowrap pr-2 text-base leading-5 text-slate-900 sm:text-sm dark:text-slate-100";
export const CARET = "ml-px inline-block h-4 w-px translate-y-[3px] bg-slate-900 motion-safe:animate-pulse dark:bg-slate-100";

// ---------------------------------------------------------------------------
// Reveal (landing-only): persistent beat elements are laid out at final size
// and only fade and lift into place, so no beat ever shifts layout. min-w-0
// because reveals share grid cells: a grid item's automatic minimum is its
// min-content width, and the mono diff and code blocks would otherwise widen
// the whole transcript past the frame on a phone.
// The fade takes time only once the window has painted (data-deck-settled on
// the frame, group/deck): until then its duration is 0, so the first paint
// shows the beat it starts on outright, never the finished turn fading out
// behind it.
export const REVEAL_BASE =
  "min-w-0 transition-[opacity,transform] duration-0 ease-out group-data-[deck-settled]/deck:duration-200 motion-reduce:transition-none";
export const REVEAL_SHOWN = "opacity-100 translate-y-0";
export const REVEAL_HIDDEN = "opacity-0 translate-y-1";
export const REVEAL_SLIDE_SHOWN = "opacity-100 translate-x-0";
export const REVEAL_SLIDE_HIDDEN = "opacity-0 translate-x-1";
