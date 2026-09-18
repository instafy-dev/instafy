// The landing example plays one scripted turn per scenario. Playback is a pure
// function of (scenario, beat): LandingSessionDeck schedules the beats with
// one set of timeouts and LandingStudioWindow draws whatever the beat says.
// Nothing in this module runs a timer or touches the DOM.

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
  | "kimTyping"
  | "reply";

export interface TurnBeat {
  id: TurnBeatId;
  atMs: number;
}

// The turn rests by 7400 ms, under the 11000 ms rotation, so every scenario
// finishes and then holds its finished frame for about 3.6 s: the completed
// state is the point of the card, so it gets the longest look. Octo's message
// lands in order (summary, file counts, then the artifact) and only once it has
// settled does Kim start typing, so nobody answers a half-written message.
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
  KIM_TYPING: 14,
  REPLY: 15,
} as const;

export const TURN_END_BEAT: number = BEAT.REPLY;
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
  // "Updating plan…", "Thinking…", "Running command…" or the command text.
  caption: string;
  // A delegate's lowercase handle: the chip shows its initial and the caption
  // wears the owner badge, as the real rail does for another agent's step.
  ownerHandle?: string;
}

export interface TurnFile {
  path: string;
  added: number;
  removed: number;
  // The chip whose diff card is open once the artifact beat lands.
  active?: boolean;
}

export interface TurnDiffRow {
  kind: "hunk" | "add" | "del" | "context";
  text: string;
}

export interface SessionScenario {
  id: string;
  label: string;
  title: string;
  prompt: string;
  // The scenario's own agent, named on the purple presence cursor in the hero
  // artwork so the cursor follows the active scenario (Octo keeps its own).
  presenceAgent: string;
  presenceHandle: string;
  opener: string;
  steps: [TurnStep, TurnStep, TurnStep, TurnStep, TurnStep];
  summary: string;
  codeLines?: string[];
  files: TurnFile[];
  // The file rail's summary toggle label; null when a single file has no toggle.
  railLabel: string | null;
  diffRows?: TurnDiffRow[];
  reply: string;
}

export const SESSION_SCENARIOS: SessionScenario[] = [
  // Order is what the deck plays first, and the first eleven seconds decide
  // whether a visitor who is not a developer reads on. Closing the books
  // leads because it is the least technical of the three: it shows the same
  // mechanics (a run, its steps, a file, a reply from a colleague) without
  // asking anyone to know what an API package or a router is. Building a
  // feature follows one rotation later, which is where the visitor who came
  // for that finds it.
  {
    id: "books",
    label: "Close the books",
    title: "February close",
    prompt: "Reconcile February against the bank export and set aside anything that needs a second look.",
    // Named like the other two crew members (Canary, Pixel) so the colleague
    // is never mistaken for the ledger the scenario is about.
    presenceAgent: "Quill",
    presenceHandle: "quill",
    opener: "February's bank export is in the ledger folder. Two card payments look doubled.",
    steps: [
      { kind: "tool", caption: "Calling tool…" },
      { kind: "command", caption: "Matching February against the bank export" },
      { kind: "plan", caption: "Updating plan…" },
      { kind: "tool", caption: "Calling tool…", ownerHandle: "quill" },
      { kind: "command", caption: "Pulling the rows that need a second look" },
    ],
    summary:
      "February is reconciled: 214 of 217 bank rows match the ledger. Quill checked the VAT lines, and the three rows that need a second look are in review.csv with a note on each.",
    // Short enough that the ledger columns still line up at phone width, where
    // the block wraps instead of scrolling. The escaped no-break space keeps
    // the thousands group whole (a literal one would be invisible in source).
    codeLines: [
      "February: 214 of 217 rows matched",
      "02-04  Acme AB     2\u00a0140.00  duplicate?",
      "02-11  Linear seat    89.90  receipt?",
      "02-19  Bank charge    12.00  category?",
    ],
    files: [{ path: "ledger/2026-02-review.csv", added: 4, removed: 0 }],
    railLabel: null,
    reply: "The Acme one is a duplicate, I'll void it. Thanks both.",
  },
  {
    id: "code",
    label: "Build a feature",
    title: "Checkout flow",
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
    summary:
      "Checkout is its own package now. The API routes import it, and Canary ran the payment tests: 12 passed. Three files changed, ready for review.",
    files: [
      { path: "packages/checkout/index.ts", added: 31, removed: 0 },
      { path: "apps/api/src/router.ts", added: 7, removed: 9, active: true },
      { path: "packages/checkout/checkout.test.ts", added: 3, removed: 0 },
    ],
    railLabel: "Edited 3 files",
    // Every row fits the 40 mono characters the card holds at phone width, so
    // the diff reads whole there instead of wrapping or being clipped.
    diffRows: [
      { kind: "hunk", text: "@@ -1,6 +1,6 @@" },
      { kind: "del", text: '-import { checkoutApi } from "./routes";' },
      { kind: "add", text: '+import checkout from "@forma/checkout";' },
      { kind: "context", text: " export const router = Router();" },
      { kind: "del", text: '-router.use("/checkout", checkoutApi);' },
      { kind: "add", text: '+router.use("/checkout", checkout.api);' },
    ],
    reply: "Nice. I'll review the router change after lunch.",
  },
  {
    id: "site",
    label: "Launch a site",
    title: "Pricing page",
    prompt: "Build a simple pricing page for the new plans. Make it feel good on a phone, too.",
    presenceAgent: "Pixel",
    presenceHandle: "pixel",
    opener: "Plans are final: Starter 19, Team 49. Copy is in notes/pricing.md.",
    steps: [
      { kind: "tool", caption: "Calling tool…" },
      { kind: "command", caption: "pnpm dev --port 4173" },
      { kind: "plan", caption: "Updating plan…" },
      { kind: "tool", caption: "Calling tool…", ownerHandle: "pixel" },
      { kind: "tool", caption: "Calling tool…" },
    ],
    summary:
      "The pricing page is up at forma.site/pricing. Both plans share one layout and stack on a phone; Pixel walked it at 390 wide in the shared browser.",
    files: [
      { path: "site/pricing.html", added: 64, removed: 0 },
      { path: "site/pricing.css", added: 38, removed: 0 },
    ],
    railLabel: "Created 2 files",
    reply: "Looks right on my phone. Ship it.",
  },
];
