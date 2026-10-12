// The landing example plays one scripted task per scenario. Playback is a pure
// function of (scenario, beat): useLandingScenarioDeck schedules the beats with
// one set of timeouts and the window draws whatever the beat says. Nothing in
// this module runs a timer or touches the DOM.
//
// Two of the scenarios are one workspace turn (TURN_BEATS). Launching a site is
// a workspace turn plus the browser handoff it asks for (BROWSER_TURN_BEATS):
// Octo builds the page and posts the preview link, then asks to continue in
// the browser; only Ada's press on that card opens the Shared Browser and
// sends the browser turn, which is how the studio really reaches a browser
// (runtime-agent/src/jobs/browser_request.rs, useChatBrowserRequest.ts).

export type TurnBeatId =
  | "rest"
  | "typing"
  | "send"
  | "own"
  | "thinking"
  | "step1"
  | "step2"
  | "step3"
  | "step4"
  | "step5"
  | "done"
  | "files"
  | "counts"
  | "artifact"
  // The browser handoff (BROWSER_TURN_BEATS only).
  | "tap"
  | "press"
  | "handoff"
  | "browse"
  | "approve"
  | "routine"
  | "allowPress"
  | "allowed"
  | "navigate"
  | "loaded"
  | "scroll"
  | "click"
  | "browseDone"
  | "kimTyping"
  | "reply"
  | "settle";

export interface TurnBeat {
  id: TurnBeatId;
  atMs: number;
}

// The workspace turn rests by 7400 ms, under its 11000 ms rotation, so the
// scenario finishes and then holds its finished frame for about 3.6 s: the
// completed state is the point of the card, so it gets the longest look.
// Octo's message lands in order (summary, file counts, then the artifact) and
// only once it has settled does Kim start typing, so nobody answers a
// half-written message.
export const TURN_BEATS: readonly TurnBeat[] = [
  { id: "rest", atMs: 0 },
  { id: "typing", atMs: 120 },
  { id: "send", atMs: 1560 },
  { id: "own", atMs: 1700 },
  { id: "thinking", atMs: 1900 },
  { id: "step1", atMs: 2350 },
  { id: "step2", atMs: 2800 },
  { id: "step3", atMs: 3250 },
  { id: "step4", atMs: 3700 },
  { id: "step5", atMs: 4200 },
  { id: "done", atMs: 4850 },
  { id: "files", atMs: 5150 },
  { id: "counts", atMs: 5450 },
  { id: "artifact", atMs: 5850 },
  { id: "kimTyping", atMs: 6650 },
  { id: "reply", atMs: 7400 },
];

/** Indices shared by every turn plan: the workspace turn up to its artifact, and its two closing beats in TURN_BEATS. */
export const BEAT = {
  REST: 0,
  TYPING: 1,
  SEND: 2,
  OWN: 3,
  THINKING: 4,
  STEP1: 5,
  STEP2: 6,
  STEP3: 7,
  STEP4: 8,
  STEP5: 9,
  DONE: 10,
  FILES: 11,
  COUNTS: 12,
  ARTIFACT: 13,
  /** TURN_BEATS only; other plans name it (beatIndex). */
  KIM_TYPING: 14,
  /** TURN_BEATS only; other plans name it (beatIndex). */
  REPLY: 15,
} as const;

// The browser task keeps the workspace turn's beats up to its artifact (the
// "Continue in browser" card), so Octo's first run and Cub's lent arm keep
// their time in every scenario. The card then holds long enough to read before
// Ada presses it (tap is her press going down, press is the button busy and
// the browser opening), the Shared Browser starts beside the chat, her
// continuation goes out once it is connected, and Octo's browser run asks her
// to approve the preview's site: the prompt opens at its top (approve), she
// scrolls it to the routine browsing box and ticks it (routine), then presses
// Allow. Octo goes to the page, scrolls to the plans and clicks Choose Team,
// each ticker caption up long enough to read (about 1.1 s), so its cursor
// rests on the button it clicked, and posts what it saw. In one view Ada then
// taps Chat (browseDone to kimTyping) to read it; Kim, whose pointer is on the
// same page, replies. settle is when Octo's cursor fades (it lingers 4 s after
// its last click, BrowserCursorOverlay.tsx); the finished frame (finishedBeat)
// is Kim's reply, inside that linger, so it keeps Octo's cursor on its click.
export const BROWSER_TURN_BEATS: readonly TurnBeat[] = [
  ...TURN_BEATS.slice(0, BEAT.ARTIFACT + 1),
  { id: "tap", atMs: 7050 },
  { id: "press", atMs: 7300 },
  { id: "handoff", atMs: 8100 },
  { id: "browse", atMs: 8200 },
  { id: "approve", atMs: 8350 },
  { id: "routine", atMs: 9350 },
  { id: "allowPress", atMs: 10200 },
  { id: "allowed", atMs: 10450 },
  { id: "navigate", atMs: 10600 },
  { id: "loaded", atMs: 11800 },
  { id: "scroll", atMs: 12900 },
  { id: "click", atMs: 14000 },
  { id: "browseDone", atMs: 14900 },
  { id: "kimTyping", atMs: 15300 },
  { id: "reply", atMs: 15850 },
  { id: "settle", atMs: 18000 },
];

export interface TurnPlan {
  beats: readonly TurnBeat[];
  /** How long the deck shows the scenario before rotating on (ms from beat 0). */
  dwellMs: number;
}

export const WORKSPACE_TURN: TurnPlan = { beats: TURN_BEATS, dwellMs: 11_000 };
// Kim's reply rests 3.5 s, like the workspace turn's, and the frame Octo's
// cursor has faded from (settle) about a second and a half, before the deck
// moves on.
export const BROWSER_TURN: TurnPlan = { beats: BROWSER_TURN_BEATS, dwellMs: 19_400 };

export const TURN_END_BEAT: number = BEAT.REPLY;
/** Octo's roster coin is popped from the first of these beats up to, not including, the second (Cub's tap target). */
export const OCTO_COIN_POP_BEATS = [BEAT.THINKING, BEAT.COUNTS] as const;

export const TURN_END_MS = TURN_BEATS[TURN_END_BEAT].atMs;

// The composer typewriter: one tick every 60 ms, enough characters per tick
// that every prompt lands inside the typing beat's 1440 ms window.
export const TYPEWRITER_TICK_MS = 60;
export const TYPEWRITER_TICKS = 24;

// The chip kinds the studio's compact activity rail really draws
// (threadPreviewHelpers.tsx renderThreadCompactEventIcon).
export type TurnStepKind = "tool" | "command" | "plan" | "thinking";

export interface TurnStep {
  kind: TurnStepKind;
  // Only captions the thread preview really shows: "Calling tool…",
  // "Updating plan…", "Thinking…", or a command's own text
  // (threadPreviewState.ts). A Shared Browser step is a tool call.
  caption: string;
  // A delegate's lowercase handle: the chip shows its initial and the caption
  // wears the owner badge, as the real rail does for another agent's step.
  ownerHandle?: string;
}

export interface TurnFile {
  path: string;
  added: number;
  removed: number;
  // The chip whose file card is open once the artifact beat lands.
  active?: boolean;
}

export interface TurnDiffRow {
  kind: "hunk" | "add" | "del" | "context";
  text: string;
}

/**
 * One piece of a message as the studio renders it (ChatMessageContent.tsx):
 * prose, an inline code token, a workspace file reference chip (folder, name
 * and line) or a link.
 */
export type MessagePart = string | { code: string } | { file: string; line?: number } | { link: string };

/** The message's text as a reader sees it (a file chip reads as its path and line). */
export function messageText(parts: readonly MessagePart[]): string {
  return parts
    .map((part) =>
      typeof part === "string"
        ? part
        : "code" in part
          ? part.code
          : "file" in part
            ? `${part.file}${part.line ? `:${part.line}` : ""}`
            : part.link,
    )
    .join("");
}

/** Monaco's token colours the landing's editor copies (monacoThemes.ts). */
export type CodeTokenKind = "plain" | "keyword" | "string" | "type";
export type CodeLine = string | readonly { text: string; kind: CodeTokenKind }[];

export interface PaneFile {
  path: string;
  /** FilesPanel.tsx getEditorLanguage: .csv is plaintext; .md has no line numbers. */
  language: "plaintext" | "typescript" | "markdown";
  lines: readonly CodeLine[];
}

/**
 * What the conversation's resource pane shows (ChatPanel.tsx resource
 * surface). open is the file Kim pointed to, open beside the chat from the
 * first frame. On the artifact beat a click on the file reference (or the file
 * card's filename) opens the result and selects its lines
 * (useFilesPanelViewerState.ts): in its own tab, or in the open tab when it is
 * the same file, whose content has changed since the files landed.
 */
export interface ScenarioPane {
  open: PaneFile;
  artifact?: { file: PaneFile; select: readonly [number, number]; sameTab?: boolean };
}

/** The browser half of the site scenario. */
export interface BrowserScript {
  /** The task request_browser carries (browserRequest.ts), sent back by Ada's press. */
  task: string;
  /** The preview's tunnel origin (instafy tunnel start; *.rt.instafy.dev). */
  origin: string;
  url: string;
  /** The page title nav_result reports. */
  title: string;
  /** The label of the control Octo clicks (Click "…"). */
  clickLabel: string;
  steps: TurnStep[];
  summary: string;
}

export interface SessionScenario {
  id: string;
  label: string;
  title: string;
  // The space the chat lives in, named plainly for what it is (the rail
  // shows it under the team): Finance, Checkout, Website.
  space: string;
  prompt: string;
  // The scenario's own agent: its roster coin (crew flame) and the coin's
  // name follow the active scenario. Octo keeps its own ink coin.
  presenceAgent: string;
  presenceHandle: string;
  opener: string;
  steps: [TurnStep, TurnStep, TurnStep, TurnStep, TurnStep];
  /** Octo's summary as rendered. */
  summaryParts: MessagePart[];
  /** The summary's text (messageText of summaryParts). */
  summary: string;
  files: TurnFile[];
  // The file rail's summary toggle label; null when a single file has no toggle.
  railLabel: string | null;
  /** The open file card under the rail (ChatFileChangeList.tsx): a created file's rows, or an edit's hunk. */
  card?: { change: "created" | "updated"; rows: TurnDiffRow[] };
  pane: ScenarioPane;
  browser?: BrowserScript;
  reply: string;
}

/** The message browserRequestContinuation (browserRequest.ts) sends as Ada when she presses the card. */
export function browserContinuation(task: string): string {
  return `Continue this browser task using the browser attached to this turn. Inspect its current state first, preserve existing session state, and avoid repeating work that is already complete.\n\n${task}`;
}

const BANK_EXPORT: PaneFile = {
  path: "ledger/2026-02-bank.csv",
  language: "plaintext",
  lines: [
    "date,description,amount",
    "2026-02-01,Stripe payout,4812.50",
    "2026-02-03,Figma seats,-45.00",
    "2026-02-04,Acme AB,-2140.00",
    "2026-02-04,Acme AB,-2140.00",
    "2026-02-06,Office rent,-1800.00",
    "2026-02-09,Stripe payout,3120.75",
    "2026-02-11,Linear seat,-89.90",
    "2026-02-13,Coffee club,-64.00",
    "2026-02-14,Stripe payout,5230.10",
    "2026-02-17,Hetzner,-212.40",
    "2026-02-19,Bank charge,-12.00",
    "2026-02-21,AWS,-312.44",
    "2026-02-24,Stripe payout,2988.00",
    "2026-02-26,Notion seats,-48.00",
    "2026-02-27,Payroll,-9400.00",
    "2026-02-28,Stripe payout,4410.20",
    "2026-02-28,Bank interest,3.12",
    "2026-02-28,Card fees,-27.60",
    "2026-02-28,Transfer to savings,-2000.00",
    "2026-02-28,VAT payment,-1960.00",
    "2026-02-28,Insurance,-118.00",
  ],
};

// Every review row fits the 40 mono characters the file card holds at phone
// width, so the card reads whole there instead of wrapping.
const REVIEW_ROWS = [
  "date,description,amount,note",
  "2026-02-04,Acme AB,-2140.00,duplicate?",
  "2026-02-11,Linear seat,-89.90,receipt?",
  "2026-02-19,Bank charge,-12.00,category?",
];

const kw = (text: string) => ({ text, kind: "keyword" as const });
const str = (text: string) => ({ text, kind: "string" as const });
const ty = (text: string) => ({ text, kind: "type" as const });
const tx = (text: string) => ({ text, kind: "plain" as const });

const routerFile = (checkoutImport: CodeLine, checkoutUse: CodeLine): PaneFile => ({
  path: "apps/api/src/router.ts",
  language: "typescript",
  lines: [
    [kw("import"), tx(" { "), ty("Router"), tx(" } "), kw("from"), tx(" "), str('"express"'), tx(";")],
    checkoutImport,
    [kw("import"), tx(" { usersApi } "), kw("from"), tx(" "), str('"./users"'), tx(";")],
    [kw("import"), tx(" { teamsApi } "), kw("from"), tx(" "), str('"./teams"'), tx(";")],
    "",
    [kw("export"), tx(" "), kw("const"), tx(" router = "), ty("Router"), tx("();")],
    checkoutUse,
    [tx("router.use("), str('"/users"'), tx(", usersApi);")],
    [tx("router.use("), str('"/teams"'), tx(", teamsApi);")],
  ],
});

const ROUTER_BEFORE = routerFile(
  [kw("import"), tx(" { checkoutApi } "), kw("from"), tx(" "), str('"./routes"'), tx(";")],
  [tx("router.use("), str('"/checkout"'), tx(", checkoutApi);")],
);
const ROUTER_AFTER = routerFile(
  [kw("import"), tx(" checkout "), kw("from"), tx(" "), str('"@forma/checkout"'), tx(";")],
  [tx("router.use("), str('"/checkout"'), tx(", checkout.api);")],
);

// Monaco's markdown grammar colours headings as keywords. Everything the
// pricing page says comes from here (LandingBrowserView.tsx PricingPage).
const PRICING_NOTES: PaneFile = {
  path: "notes/pricing.md",
  language: "markdown",
  lines: [
    [kw("# Pricing")],
    "",
    "Simple plans. Room to grow.",
    "",
    [kw("## Starter: $19 a month")],
    "For one person getting started.",
    "1 member, email support.",
    "",
    [kw("## Team: $49 a month")],
    "Everything in Starter, plus shared spaces.",
    "Up to 20 members, priority support.",
    "",
    [kw("## Questions")],
    "Change plans at any time.",
    "Yearly billing: two months free.",
  ],
};

// The tunnel id has no digit-x-digit run: Inter's contextual alternates would
// draw that "x" as a multiplication sign.
const SITE_BROWSER: BrowserScript = {
  task: "Click through the Team plan.",
  origin: "https://k7m2qa.rt.instafy.dev",
  url: "https://k7m2qa.rt.instafy.dev/pricing",
  title: "Pricing · Forma",
  clickLabel: "Choose Team",
  steps: [
    { kind: "tool", caption: "Calling tool…" },
    { kind: "tool", caption: "Calling tool…" },
    { kind: "tool", caption: "Calling tool…" },
    { kind: "tool", caption: "Calling tool…" },
  ],
  summary: "Clicked through the preview: both plans load, and Choose Team selects the Team plan.",
};

function scenario(entry: Omit<SessionScenario, "summary">): SessionScenario {
  return { ...entry, summary: messageText(entry.summaryParts) };
}

export const SESSION_SCENARIOS: SessionScenario[] = [
  // Order is what the deck plays first, and the first eleven seconds decide
  // whether a visitor who is not a developer reads on. Closing the books
  // leads because it is the least technical of the three: it shows the same
  // mechanics (a run, its steps, a file, a reply from a colleague) without
  // asking anyone to know what an API package or a router is. Building a
  // feature follows one rotation later, which is where the visitor who came
  // for that finds it.
  scenario({
    id: "books",
    label: "Close the books",
    title: "February close",
    space: "Finance",
    prompt: "Reconcile February against the bank export and set aside anything that needs a second look.",
    // Named like the other two crew members (Canary, Pixel) so the colleague
    // is never mistaken for the ledger the scenario is about.
    presenceAgent: "Quill",
    presenceHandle: "quill",
    opener: "February's bank export is in the ledger folder. Two card payments look doubled.",
    steps: [
      { kind: "tool", caption: "Calling tool…" },
      { kind: "command", caption: "python scripts/reconcile.py 2026-02" },
      { kind: "plan", caption: "Updating plan…" },
      { kind: "tool", caption: "Calling tool…", ownerHandle: "quill" },
      { kind: "command", caption: "python scripts/reconcile.py 2026-02 --review" },
    ],
    summaryParts: [
      "February is reconciled: 18 of 21 bank rows match the ledger, and Quill checked the VAT lines. Three rows need a second look, each with a note; the Acme charge at ",
      { file: "ledger/2026-02-review.csv", line: 2 },
      " looks doubled.",
    ],
    files: [{ path: "ledger/2026-02-review.csv", added: 4, removed: 0, active: true }],
    railLabel: null,
    // A .csv has no table preview in the studio: a created file's card lists
    // every line as an added row (ChatFileChangeList.tsx), and the editor
    // shows it as plaintext with line numbers (FilesPanel.tsx).
    card: { change: "created", rows: REVIEW_ROWS.map((row) => ({ kind: "add" as const, text: `+${row}` })) },
    pane: {
      open: BANK_EXPORT,
      artifact: { file: { path: "ledger/2026-02-review.csv", language: "plaintext", lines: REVIEW_ROWS }, select: [2, 2] },
    },
    reply: "The Acme one is a duplicate, I'll void it. Thanks both.",
  }),
  scenario({
    id: "code",
    label: "Build a feature",
    title: "Checkout flow",
    space: "Checkout",
    prompt: "Give checkout its own package, and make sure the payment flow still works.",
    presenceAgent: "Canary",
    presenceHandle: "canary",
    opener: "Checkout still lives inside the API package. Can we split it before launch?",
    steps: [
      { kind: "tool", caption: "Calling tool…" },
      { kind: "command", caption: "pnpm test --filter checkout" },
      { kind: "plan", caption: "Updating plan…" },
      { kind: "command", caption: "pnpm test --filter payments", ownerHandle: "canary" },
      { kind: "command", caption: "pnpm typecheck" },
    ],
    summaryParts: [
      "Checkout is its own package now and the API routes import it. Canary ran ",
      { code: "pnpm test --filter payments" },
      ": 12 passed. Three files changed, ready for review.",
    ],
    files: [
      { path: "packages/checkout/index.ts", added: 31, removed: 0 },
      { path: "apps/api/src/router.ts", added: 2, removed: 2, active: true },
      { path: "packages/checkout/checkout.test.ts", added: 3, removed: 0 },
    ],
    railLabel: "Edited 3 files",
    // Every row fits the 40 mono characters the card holds at phone width, so
    // the diff reads whole there instead of wrapping or being clipped.
    card: {
      change: "updated",
      rows: [
        { kind: "hunk", text: "@@ -1,7 +1,7 @@" },
        { kind: "del", text: '-import { checkoutApi } from "./routes";' },
        { kind: "add", text: '+import checkout from "@forma/checkout";' },
        { kind: "context", text: " export const router = Router();" },
        { kind: "del", text: '-router.use("/checkout", checkoutApi);' },
        { kind: "add", text: '+router.use("/checkout", checkout.api);' },
      ],
    },
    // A click on the card's filename reveals the change's first range
    // (ChatFileChangeList.tsx primaryRange): the import on line 2.
    pane: { open: ROUTER_BEFORE, artifact: { file: ROUTER_AFTER, select: [2, 2], sameTab: true } },
    reply: "Nice. I'll review the router change after lunch.",
  }),
  scenario({
    id: "site",
    label: "Launch a site",
    title: "Pricing page",
    space: "Website",
    // Asking for a preview link is the consent the tunnel needs
    // (instafy-frontend-previews SKILL.md: never open one unasked).
    prompt: "Build a pricing page for the new plans and share a preview link, then click through it in the browser.",
    presenceAgent: "Pixel",
    presenceHandle: "pixel",
    opener: "Plans are final: Starter 19, Team 49. Copy is in notes/pricing.md.",
    steps: [
      { kind: "tool", caption: "Calling tool…" },
      { kind: "command", caption: "pnpm dev --port 4173" },
      { kind: "plan", caption: "Updating plan…" },
      { kind: "tool", caption: "Calling tool…", ownerHandle: "pixel" },
      { kind: "command", caption: "instafy tunnel start --port 4173" },
    ],
    summaryParts: [
      "The pricing page follows notes/pricing.md, and Pixel did the layout. Preview URL: ",
      { link: SITE_BROWSER.url },
    ],
    files: [
      { path: "site/pricing.html", added: 64, removed: 0 },
      { path: "site/pricing.css", added: 38, removed: 0 },
    ],
    railLabel: "Created 2 files",
    pane: { open: PRICING_NOTES },
    browser: SITE_BROWSER,
    reply: "Opened the link on my phone too. Looks right.",
  }),
];

/** The beats and dwell a scenario plays: the browser task for a scenario with a browser half. */
export function turnPlanFor(scenario: SessionScenario): TurnPlan {
  return scenario.browser ? BROWSER_TURN : WORKSPACE_TURN;
}

/** The index of a beat in the scenario's plan, or -1 when the plan has no such beat. */
export function beatIndex(scenario: SessionScenario, id: TurnBeatId): number {
  return turnPlanFor(scenario).beats.findIndex((entry) => entry.id === id);
}

/** The scenario's turn has reached the beat (never, for a beat its plan does not have). */
export function beatReached(scenario: SessionScenario, beat: number, id: TurnBeatId): boolean {
  const index = beatIndex(scenario, id);
  return index >= 0 && beat >= index;
}

/** The scenario's last beat: where its playback ends. */
export function turnEndBeat(scenario: SessionScenario): number {
  return turnPlanFor(scenario).beats.length - 1;
}

/**
 * The frame a scenario rests on whenever it is not playing (reduced motion,
 * offscreen, a hidden tab): Kim's reply, every message in. In the site
 * scenario that is 1.85 s after Octo's click, inside the 4 s its cursor
 * lingers, so the frame keeps Octo's cursor on the button it clicked.
 */
export function finishedBeat(scenario: SessionScenario): number {
  return beatIndex(scenario, "reply");
}

/** The id of a beat of the scenario's plan. */
export function beatId(scenario: SessionScenario, beat: number): TurnBeatId {
  const beats = turnPlanFor(scenario).beats;
  return beats[Math.max(0, Math.min(beats.length - 1, beat))].id;
}
