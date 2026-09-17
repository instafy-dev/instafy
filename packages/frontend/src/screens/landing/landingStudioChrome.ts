// Every class string the landing example copies from the studio, one constant
// each, with the file and line it came from. All strings are static so
// Tailwind's scanner sees them. Where a studio string carries a cool-slate
// dark border or background (slate-700/800 borders, slate-900/950 fills) the
// same-tier darkSurfaces helper is substituted and the comment says so.
// Crew colours are inline styles at the call sites, never classes.

import {
  DARK_ACTIVE_BG_CLASS,
  DARK_CANVAS_CLASS,
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
// Focus ring (landing-only): the deck's own controls sit on the dark landing
// canvas, so their ring offset matches that canvas rather than a panel.

export const CANVAS_RING_OFFSET = "dark:focus-visible:ring-offset-[var(--color-studio-dark-canvas)]";

// ---------------------------------------------------------------------------
// Frame and workspace surface

// StudioLayout.tsx:1987 (canvas) with the landing card's own radius and shadow.
export const FRAME = `relative flex overflow-hidden rounded-2xl border border-slate-200/70 bg-slate-50 text-left shadow-card-lg md:min-h-[44rem] ${DARK_CANVAS_CLASS} ${DARK_PANEL_BORDER_CLASS} dark:shadow-studio-dark-panel`;

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
// neutral bg-slate-50/text-slate-700 give way to the crew pink and white so
// Ada keeps one colour everywhere in the example (inline style at the call site).
export const PROFILE_AVATAR = `relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-slate-200 text-sm font-medium text-white ${DARK_RAISED_CONTROL_BORDER_CLASS}`;
// StudioSidebarAccountSection.tsx:246-262 collapsed profile (IconButton ghost sm lg).
export const PROFILE_INITIAL_COLLAPSED = "inline-flex h-8 w-8 items-center justify-center rounded-lg text-sm font-medium text-slate-700 dark:text-slate-200";

// ---------------------------------------------------------------------------
// Tab strip (WorkspaceTabs.tsx) and phone bar (StudioTopBar.tsx)

// WorkspaceTabs.tsx:636-650 strip and its baseline span.
export const TAB_STRIP = `relative hidden md:flex max-w-full flex-none items-end gap-2 bg-white pr-2 pb-0 pt-0 ${DARK_CANVAS_CLASS}`;
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

// StudioTopBar.tsx:521 phone grid.
export const PHONE_BAR = `grid md:hidden grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 bg-white px-4 py-2 ${DARK_CANVAS_CLASS}`;
// StudioTopBar.tsx:526-537 round toggle (IconButton ghost full md).
export const PHONE_ROUND_ACTION = "inline-flex h-10 w-10 items-center justify-center rounded-full text-slate-600 dark:text-slate-200";
// StudioTopBar.tsx:50 COMPACT_TAB_SELECTOR_CLASS (Button ghost xs full).
export const PHONE_PILL = "inline-flex h-10 min-w-0 max-w-full items-center gap-2 rounded-xl bg-slate-100 px-2.5 text-xs font-semibold text-slate-950 dark:bg-white/[0.06] dark:text-slate-50";

// ---------------------------------------------------------------------------
// Roster and transcript

// ConversationRoster.tsx:92-103.
export const ROSTER_ROW = "flex-none px-3 pt-2 sm:px-4";
export const ROSTER_HANDLE = "flex items-center gap-1 px-1 py-0.5";
export const ROSTER_STACK = "flex items-center -space-x-1.5";
export const ROSTER_RING = "rounded-full ring-1 ring-white dark:ring-[var(--color-studio-dark-panel)]";

// ChatTranscriptViewport.tsx:82-90 without the scrollbar.
export const TRANSCRIPT = "relative flex min-h-0 flex-1 flex-col overflow-hidden px-3 pb-2 pt-2 sm:px-4";

// ChatMessageAvatar.tsx:96-140 wrapper; dark cool-slate border (700/800) replaced by
// the raised-control border tier. Humans fill with the crew hex inline.
export const AVATAR_SHELL = `flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-slate-200 shadow-sm ${DARK_RAISED_CONTROL_BORDER_CLASS}`;
export const AVATAR_2XS = "h-6 w-6 text-xxs";
export const AVATAR_SM = "h-8 w-8 text-xs";
export const AVATAR_HUMAN = "font-semibold text-white";
// ChatMessageAvatar.tsx:140-149 the canonical Octo: white coin in both themes (Brand.md:42).
export const OCTO_COIN = "flex h-full w-full items-center justify-center bg-white";
export const OCTO_MARK = "h-[85%] w-[85%] text-brand-ink";
// The scenario agent inherits its purple from the wrapper's inline color.
export const OCTO_MARK_TINTED = "h-[85%] w-[85%]";

// AssistantSpeakerIdentityPill.tsx:100-138 and chatHumanIdentity.tsx:52-75.
export const SPEAKER_LABEL = "inline-flex max-w-full items-center gap-2 text-xs text-slate-500 dark:text-slate-400";
export const SPEAKER_NAME = "min-w-0 truncate font-semibold text-slate-600 dark:text-slate-300";
export const SPEAKER_TIME = "flex-none text-xxs font-medium text-slate-400 dark:text-slate-500";

// ChatMessageEntries.tsx:101-137 NotchedMessageShell with the teammate tone (327-331).
export const SHELL_MESSAGE = "group relative inline-flex w-fit max-w-[min(92%,56rem)] min-w-0 flex-col items-start py-1 text-sm text-slate-800 dark:text-slate-200";
export const SHELL_MESSAGE_BODY = "w-full min-w-0";
// ChatMessageEntries.tsx:325-330 the current user's own bubble.
export const OWN_BUBBLE = `group relative inline-flex w-fit max-w-[min(92%,56rem)] min-w-0 flex-col items-start rounded-2xl rounded-br-none bg-slate-50/90 px-3.5 py-2.5 text-sm text-slate-800 ring-1 ring-inset ring-slate-200/70 ${DARK_RAISED_CONTROL_BG_CLASS} dark:text-slate-200 dark:ring-[color:var(--color-studio-dark-raised-control-border)]`;

// ChatTypingRows.tsx:53-84 the assistant status line.
export const TYPING_LINE = "flex min-h-8 w-fit max-w-full min-w-0 items-center gap-2 px-1 text-sm text-slate-500 dark:text-slate-400";
export const TYPING_LINE_TEXT = "instafy-status-sweep min-w-0 max-w-full text-xs";

// AgentJobThreadPreviewLayout.tsx:1283-1290 thread root; spine offsets from
// useAgentJobThreadPreviewState.ts:885-891 with a 0 safe inset. The studio
// root is overflow-hidden; here the spine sits 26px outside the root (its
// containing block is the body inside it) and would be clipped, so the root
// stays overflow-visible. Every wide child (diff card, code block, captions)
// clips or truncates itself, so nothing can escape sideways.
export const THREAD_ROOT = "w-full min-w-0 max-w-2xl text-sm text-slate-700 dark:text-slate-200";
export const THREAD_BODY = "relative flex flex-col";
export const THREAD_SPINE_LEFT = "-30px";
export const THREAD_SPINE_MAIN = "pointer-events-none absolute left-[var(--thread-spine-left)] transition-opacity duration-200 ease-out motion-reduce:transition-none";
export const THREAD_SPINE_NOTCH = "pointer-events-none absolute top-0 h-full left-[var(--thread-spine-left)]";
// AgentJobThreadPreviewLayout.tsx:1385-1395 the compact rail row.
export const RAIL_ROW = "group relative py-1";
export const RAIL_ROW_INNER = "flex min-w-0 w-full items-center gap-2 rounded-lg py-0.5 pr-1";
export const RAIL_ROW_TRACK = "flex min-w-0 flex-1 items-center rounded-lg py-0.5";
export const RAIL_CHIPS = "flex shrink-0 items-center -space-x-2 pl-0.5 py-0.5";
// AgentJobThreadPreviewLayout.tsx:1449-1451 chip; dark cool-slate border and background (700/900) replaced by the raised-control tier.
export const RAIL_CHIP = `inline-flex h-6 w-6 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 shadow-sm ${DARK_RAISED_CONTROL_CLASS} dark:text-slate-300`;
// AgentJobThreadPreviewLayout.tsx:1409 another agent's chip shows its initial.
export const RAIL_CHIP_INITIAL = "text-3xs font-semibold";
// AgentJobThreadPreviewLayout.tsx:878-910 the caption row under the rail.
export const CAPTION_SECTION = "relative py-1";
export const CAPTION_ROW = "flex min-w-0 items-center gap-1.5 pl-1 text-xs text-slate-600 dark:text-slate-400";
export const CAPTION_TEXT = "instafy-status-sweep min-w-0 truncate";
// AgentJobThreadPreviewLayout.tsx:686-693 owner badge; dark cool-slate border and background (700/80, 900/70) replaced by the raised-control tier.
export const OWNER_BADGE = `inline-flex max-w-28 flex-none items-center rounded-full border border-slate-200/70 bg-white/70 px-1.5 py-0.5 text-xxs font-semibold leading-none text-slate-600 ${DARK_RAISED_CONTROL_CLASS} dark:text-slate-300`;
// AgentJobThreadPreviewLayout.tsx:896-908 the rose Stop (IconButton ghost xs full).
export const STOP_GLYPH = "ml-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-rose-500 dark:text-rose-300";
// AgentJobThreadPreviewLayout.tsx:1626-1650 the completed summary section.
export const SUMMARY_SECTION = "relative pt-2 pb-0";
export const SUMMARY_STACK = "space-y-1.5";
// ChatMessageContent.tsx:1790 container and 1859-1873 paragraph measure.
export const MESSAGE_CONTENT = "text-sm leading-relaxed break-words [overflow-wrap:anywhere]";
export const MESSAGE_PARAGRAPH = "text-sm leading-relaxed max-w-[70ch] whitespace-pre-wrap break-words [overflow-wrap:anywhere]";
// ChatMessageContent.tsx:137-140 CODE_BLOCK_CLASS. The studio block scrolls
// sideways (overflow-x-auto whitespace-pre); this copy wraps instead, because
// Chromium turns an overflowing scroller into a keyboard tab stop and nothing
// inside the window may take focus. Desktop widths never wrap.
export const CODE_BLOCK_CLASS = "block max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] rounded-lg bg-slate-950/[0.035] px-3 py-3 font-mono text-[0.85em] leading-normal text-slate-700 dark:bg-white/[0.055] dark:text-slate-200";
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
// ChatFileChangeList.tsx:39-44 resolveChangeMeta("changed").
export const DIFF_BADGE_UPDATED = "shrink-0 rounded-full border border-secondary-200/80 bg-secondary-50/80 px-2 py-0.5 text-3xs font-medium text-secondary-700 dark:border-secondary-400/25 dark:bg-secondary-400/[0.07] dark:text-secondary-200/85";
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
// Docked browser (BrowserSessionModal.tsx:2967, SharedBrowserChrome.tsx:243,
// BrowserChromeShell.tsx:14-50, ActionTicker.tsx)

// BrowserSessionModal.tsx:2967 docked wrapper; dark cool-slate border and
// background (800/950) replaced by the panel tier. The studio centres the dock
// over the composer; here it sits inside Octo's message, so it starts at the
// message gutter like the diff card instead of floating in the middle.
export const DOCK_WRAPPER = `w-full max-w-[24rem] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl ${DARK_PANEL_SURFACE_CLASS}`;
// The docked stage keeps DOCKED_BROWSER_ASPECT_RATIO (16:9). A website stays
// light in both themes: it is a rendered site, not app chrome.
export const DOCK_STAGE = "relative aspect-video w-full overflow-hidden bg-white text-slate-900";
// SharedBrowserChrome.tsx:227-233 navigation glyphs (IconButton ghost full sm).
export const DOCK_NAV_GLYPH = "inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-500 dark:text-slate-400";
// SharedBrowserChrome.tsx:243 address input as a span; dark cool-slate background (950) replaced by the raised-control tier.
export const ADDRESS_FIELD = `relative block h-8 w-full min-w-0 rounded-full border border-slate-200 bg-white pl-3 pr-9 text-xs leading-8 text-slate-800 shadow-inner ${DARK_RAISED_CONTROL_CLASS} dark:text-slate-100`;
export const ADDRESS_GO = "absolute right-1 top-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-slate-400";
// BrowserChromeShell.tsx:14-50 BrowserStatusPill classes as a plain span (no role=status).
export const STATUS_PILL = "inline-flex h-7 shrink-0 items-center gap-1 rounded-full border px-2 text-xxs font-medium";
export const STATUS_PILL_READY = "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
// dark cool-slate border and background (700, 900/70) replaced by the raised-control tier.
export const STATUS_PILL_STARTING = `border-slate-300/80 bg-slate-100/80 text-slate-600 ${DARK_RAISED_CONTROL_CLASS} dark:text-slate-300`;
// ActionTicker.tsx overlay and pill (bg-slate-900/80 in both themes, as the real ticker).
export const TICKER_OVERLAY = "pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center p-2";
export const TICKER_PILL = "flex max-w-[92%] items-center gap-2 rounded-full border border-white/10 bg-slate-900/80 px-3 py-1 text-xxs font-medium text-slate-100 shadow-sm backdrop-blur-sm";
export const TICKER_DOT = "h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400";

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
export const REVEAL_BASE = "min-w-0 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none";
export const REVEAL_SHOWN = "opacity-100 translate-y-0";
export const REVEAL_HIDDEN = "opacity-0 translate-y-1";
export const REVEAL_SLIDE_SHOWN = "opacity-100 translate-x-0";
export const REVEAL_SLIDE_HIDDEN = "opacity-0 translate-x-1";
