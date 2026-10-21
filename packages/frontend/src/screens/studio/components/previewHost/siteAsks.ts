/**
 * Ask Octo from a site in a preview pane (docs/Bound-Sites.md §2a), for any
 * site: a click on the site's "Ask Octo" button reaches Studio as
 * `{source:<kit>, v:1, type:"ask", payload:{id, intent, label, params, ref,
 * say?, confirm?, withheld?, coarsened?}}` and becomes a normal chat message
 * from the person who clicked, billed like typing it.
 *
 * Everything in the payload comes from the page, so it is a request, never a
 * decision: this file checks its shape and sizes, renders the chat line
 * itself (the intent's `say` template, else the label and a short summary of
 * the params, each value cleaned and capped), and keeps the caps Studio puts
 * on one person's asks from one site. The page never chooses the words of a
 * message beyond those fields, never adds a mention, a command or a link, and
 * cannot send more than one ask at a time or six in ten minutes.
 */

export type SiteAsk = {
  /** The page's id for this click; answers (`ask-status`) name it. */
  id: string;
  /** The intent's name in the site's manifest, e.g. `check_size`. */
  intent: string;
  /** The intent's button label. */
  label: string;
  /** The params as the page sent them (a viewer's position already rounded by the page). */
  params: Record<string, unknown>;
  /** What the click is about, `<collection>:<id>`, or null. */
  ref: string | null;
  /** The intent's own chat line, `{param}` placeholders and all, or null. */
  say: string | null;
  /** The intent asks Studio to confirm with the person first. */
  confirm: boolean;
  /** Params the page left out (private ones, position details). */
  withheld: string[];
  /** Params the page rounded (a position to about 100 m). */
  coarsened: string[];
};

/** Why an ask was not read: its id when it had a usable one, so the page still hears "declined". */
export type SiteAskParse = { ok: true; ask: SiteAsk } | { ok: false; id: string | null };

export const ASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const INTENT_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
/** The bind protocol's ref shape (Bound-Sites.md §2). */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}:[A-Za-z0-9_.:-]{1,120}$/;
const PARAM_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const ASK_LABEL_MAX_CHARS = 120;
export const ASK_SAY_MAX_CHARS = 120;
/** All params together, as JSON: the controller refuses larger ones too. */
export const ASK_PARAMS_MAX_BYTES = 2048;
const ASK_MAX_PARAMS = 24;
const ASK_PARAM_STRING_MAX_CHARS = 500;
const ASK_PARAMS_MAX_DEPTH = 3;
/** The chat line before " · via <site>", and the whole message. */
export const ASK_LINE_MAX_CHARS = 140;
export const ASK_MESSAGE_MAX_CHARS = 200;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** Plain JSON, not too deep, no long strings. */
function plainParamValue(value: unknown, depth: number): boolean {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= ASK_PARAM_STRING_MAX_CHARS;
  if (depth >= ASK_PARAMS_MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.length <= ASK_MAX_PARAMS && value.every(item => plainParamValue(item, depth + 1));
  if (isRecord(value)) {
    const entries = Object.entries(value);
    return entries.length <= ASK_MAX_PARAMS && entries.every(([key, item]) => PARAM_KEY_RE.test(key) && plainParamValue(item, depth + 1));
  }
  return false;
}

function paramNames(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > ASK_MAX_PARAMS) return null;
  if (!value.every(item => typeof item === "string" && PARAM_KEY_RE.test(item))) return null;
  return [...new Set(value as string[])];
}

/** Reads one ask payload. Anything malformed, too large or with an odd field is refused whole. */
export function parseSiteAsk(payload: unknown): SiteAskParse {
  if (!isRecord(payload)) return { ok: false, id: null };
  const id = typeof payload.id === "string" && ASK_ID_RE.test(payload.id) ? payload.id : null;
  const fail: SiteAskParse = { ok: false, id };
  if (!id) return fail;
  if (typeof payload.intent !== "string" || !INTENT_RE.test(payload.intent)) return fail;
  const label = typeof payload.label === "string" ? payload.label.trim() : "";
  if (!label || label.length > ASK_LABEL_MAX_CHARS) return fail;
  const params = payload.params === undefined ? {} : payload.params;
  if (!isRecord(params) || Object.keys(params).length > ASK_MAX_PARAMS) return fail;
  if (!Object.entries(params).every(([key, value]) => PARAM_KEY_RE.test(key) && plainParamValue(value, 1))) return fail;
  if (byteLength(JSON.stringify(params)) > ASK_PARAMS_MAX_BYTES) return fail;
  const ref = payload.ref === undefined || payload.ref === null ? null : payload.ref;
  if (ref !== null && (typeof ref !== "string" || !REF_RE.test(ref))) return fail;
  const say = payload.say === undefined || payload.say === null ? null : payload.say;
  if (say !== null && (typeof say !== "string" || !say.trim() || say.length > ASK_SAY_MAX_CHARS)) return fail;
  if (payload.confirm !== undefined && typeof payload.confirm !== "boolean") return fail;
  const withheld = paramNames(payload.withheld);
  const coarsened = paramNames(payload.coarsened);
  if (!withheld || !coarsened) return fail;
  return {
    ok: true,
    ask: { id, intent: payload.intent, label, params: params as Record<string, unknown>, ref, say, confirm: payload.confirm === true, withheld, coarsened },
  };
}

// ---------------------------------------------------------------------------
// The chat line

/**
 * Letters, digits, emoji and everyday punctuation only. No markdown, no
 * mentions (@), no code, no brackets for links, no line breaks: what the page
 * sends cannot format, link, mention or command anything in the chat.
 */
const UNSAFE_CHARS = /[^\p{L}\p{N}\p{M}\p{Extended_Pictographic} .,:;'"?!&+%€$£¥°()/–—·-]/gu;
const LEADING_NON_WORD = /^[^\p{L}\p{N}\p{Extended_Pictographic}]+/u;

function cap(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** One line of plain words: control characters, markup and extra spaces gone, capped. */
export function cleanAskText(value: string, max: number): string {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  return cap(cleaned, max);
}

/** `shoes:karhu-ikoni-3` → `Karhu ikoni 3`: what the click is about, in words. */
export function humanizeRef(ref: string): string {
  const id = ref.slice(ref.indexOf(":") + 1);
  const words = cleanAskText(id.replace(/[-_.:]+/g, " "), 60);
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

function hostOf(value: string): string | null {
  if (!/^https?:\/\//i.test(value)) return null;
  try {
    return new URL(value).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/** Params whose value reads on its own ("Karhu ikoni 3", not "name Karhu ikoni 3"). */
const SELF_NAMED_PARAMS = new Set(["name", "title", "query", "q", "text", "topic", "place", "city", "item", "product"]);
/** Params that are wiring, not words: the ref is said separately, the rest means nothing to a reader. */
const QUIET_PARAMS = new Set(["ref", "attr", "id", "cid", "oid", "ui", "refresh"]);
const SUMMARY_MAX_PARAMS = 3;

/** One param's value in words, or null when it has none worth saying. */
function paramWords(key: string, value: unknown, ask: SiteAsk): string | null {
  if (ask.coarsened.includes(key)) return "my location";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "string" || !value.trim()) return null;
  const host = hostOf(value.trim());
  if (host) return cleanAskText(host, 60) || null;
  if (key === "ref" || REF_RE.test(value)) return humanizeRef(value) || null;
  return cleanAskText(value, 60) || null;
}

function renderSay(template: string, ask: SiteAsk): string {
  return template.replace(/\{\s*([A-Za-z0-9_]+)\s*\}/g, (_, key: string) => {
    if (key === "ref" && !(key in ask.params) && ask.ref) return humanizeRef(ask.ref);
    return paramWords(key, ask.params[key], ask) ?? "";
  });
}

function summarize(ask: SiteAsk): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(ask.params)) {
    if (parts.length >= SUMMARY_MAX_PARAMS) break;
    if (QUIET_PARAMS.has(key)) continue;
    const words = paramWords(key, value, ask);
    if (!words) continue;
    const isHost = typeof value === "string" && hostOf(value.trim()) !== null;
    parts.push(isHost || SELF_NAMED_PARAMS.has(key) || ask.coarsened.includes(key) ? words : `${cleanAskText(key.replace(/_/g, " "), 24)} ${words}`);
  }
  return parts.join(", ");
}

/**
 * The message Studio sends for an ask, as the person who clicked would say
 * it: "Is size 10 in stock for Karhu ikoni 3? · via Running shoes". The site's
 * title is the preview's own (what Octo named it), not the page's.
 */
export function renderAskMessage(ask: SiteAsk, siteTitle: string): string {
  const ref = ask.ref ? humanizeRef(ask.ref) : "";
  const summary = summarize(ask);
  const raw = ask.say
    ? renderSay(ask.say, ask)
    : `${ask.label}${ref ? ` · ${ref}` : ""}${summary ? ` (${summary})` : ""}`;
  let line = cleanAskText(raw, ASK_LINE_MAX_CHARS).replace(LEADING_NON_WORD, "");
  if (!line) line = cleanAskText(ask.label, ASK_LINE_MAX_CHARS).replace(LEADING_NON_WORD, "") || "Ask Octo";
  const site = cleanAskText(siteTitle, 60);
  return cap(site ? `${line} · via ${site}` : line, ASK_MESSAGE_MAX_CHARS);
}

/**
 * `metadata.siteIntent` on the message: which preview and intent it came
 * from, as structured data for Octo. The controller drops it unless the
 * sender may see an open preview with that id in this space, and re-checks
 * its sizes, so a composer cannot fake "via a site".
 */
export function buildSiteIntentMetadata(previewId: string, ask: SiteAsk): { siteIntent: Record<string, unknown> } {
  const siteIntent: Record<string, unknown> = { previewId, askId: ask.id, intent: ask.intent, ref: ask.ref, params: ask.params };
  if (ask.withheld.length) siteIntent.withheld = ask.withheld;
  if (ask.coarsened.length) siteIntent.coarsened = ask.coarsened;
  return { siteIntent };
}

// ---------------------------------------------------------------------------
// Caps

/** One ask at a time per person and site, and at most six in ten minutes. */
export const ASK_WINDOW_MS = 10 * 60_000;
export const ASK_WINDOW_MAX = 6;
/** An ask whose run Studio never saw end stops holding the slot after this long. */
export const ASK_IN_FLIGHT_MAX_MS = 15 * 60_000;
const SEEN_IDS_MAX = 500;

export const ASK_BUSY_TEXT = "Octo is still answering your last question from this site. Try again when it's done.";

export type AskAdmission = { ok: true } | { ok: false; reason: string; duplicate?: true };

/**
 * The caps on one person's asks from one site, shared by every pane in this
 * Studio tab. `key` is the person and the site; ids already seen there are
 * dropped (a page that repeats a message does not ask twice).
 */
export function createAskLimiter(now: () => number = () => Date.now()) {
  const sent = new Map<string, number[]>();
  const inFlight = new Map<string, { id: string; at: number }>();
  const seen = new Map<string, Set<string>>();

  return {
    admit(key: string, id: string): AskAdmission {
      const ids = seen.get(key) ?? new Set<string>();
      if (ids.has(id)) return { ok: false, reason: "Already asked.", duplicate: true };
      const at = now();
      const busy = inFlight.get(key);
      if (busy && at - busy.at < ASK_IN_FLIGHT_MAX_MS) return { ok: false, reason: ASK_BUSY_TEXT };
      const recent = (sent.get(key) ?? []).filter(time => at - time < ASK_WINDOW_MS);
      if (recent.length >= ASK_WINDOW_MAX) {
        const minutes = Math.max(1, Math.ceil((ASK_WINDOW_MS - (at - recent[0])) / 60_000));
        return { ok: false, reason: `You asked from this site ${ASK_WINDOW_MAX} times in 10 minutes. Try again in ${minutes} min.` };
      }
      ids.add(id);
      if (ids.size > SEEN_IDS_MAX) ids.delete(ids.values().next().value as string);
      seen.set(key, ids);
      recent.push(at);
      sent.set(key, recent);
      inFlight.set(key, { id, at });
      return { ok: true };
    },
    /** The ask ended (sent and answered, declined or failed): the next one may go. */
    settle(key: string, id: string) {
      if (inFlight.get(key)?.id === id) inFlight.delete(key);
    },
    /** Declined before anything was sent: it does not count against the ten minutes. */
    refund(key: string, id: string) {
      this.settle(key, id);
      const list = sent.get(key);
      if (list?.length) list.pop();
    },
  };
}

export type AskLimiter = ReturnType<typeof createAskLimiter>;

/** The one limiter for this Studio tab: two panes of the same site share it. */
export const studioAskLimiter: AskLimiter = createAskLimiter();

/** How a run's status reads for the ask that started it. */
export type AskRunOutcome = "running" | "done" | "failed";

/**
 * The outcome of each ask in a conversation's runs (`metadata.siteIntent.askId`,
 * which the controller keeps only when it verified it): running while any of
 * its runs is, else done when one succeeded, else failed.
 */
export function askOutcomesFromRuns(
  runs: Iterable<{ conversationId: string | null; status: string; metadata: Record<string, unknown> | null }>,
  conversationId: string | null,
): ReadonlyMap<string, AskRunOutcome> {
  const outcomes = new Map<string, AskRunOutcome>();
  if (!conversationId) return outcomes;
  for (const run of runs) {
    if (run.conversationId !== conversationId) continue;
    const siteIntent = run.metadata?.siteIntent;
    const askId = isRecord(siteIntent) && typeof siteIntent.askId === "string" ? siteIntent.askId : null;
    if (!askId) continue;
    const status = run.status;
    const outcome: AskRunOutcome = status === "success" || status === "merged" ? "done"
      : status === "failed" || status === "canceled" ? "failed" : "running";
    const current = outcomes.get(askId);
    if (current === "running" || outcome === "running") outcomes.set(askId, "running");
    else if (current === "done" || outcome === "done") outcomes.set(askId, "done");
    else outcomes.set(askId, "failed");
  }
  return outcomes;
}

// ---------------------------------------------------------------------------
// The conversation's side

export const ASK_SIGNED_OUT_TEXT = "Sign in to Instafy to ask Octo.";
export const ASK_CHECKING_ACCESS_TEXT = "Checking your access to this space. Try again in a moment.";
export const ASK_VIEW_ONLY_TEXT = "You can view this space but not send messages in it, so you can't ask Octo here.";

/**
 * `caps.ask` for the person looking at a conversation's preview pane: true
 * when they may send messages there (the composer's own access), else why not.
 */
export function siteAskAccess({ userId, capabilitiesResolved, writeDisabled }: {
  userId: string | null;
  /** The space's capabilities for this person are known. */
  capabilitiesResolved: boolean | null | undefined;
  /** The composer may not send here (view-only, or not known yet). */
  writeDisabled: boolean;
}): true | string {
  if (!userId) return ASK_SIGNED_OUT_TEXT;
  if (capabilitiesResolved !== true) return ASK_CHECKING_ACCESS_TEXT;
  return writeDisabled ? ASK_VIEW_ONLY_TEXT : true;
}

/** The composer's submit, as the conversational undo request uses it. */
export type ComposerSubmit = (
  override: { message: string; editorState: null; metadata: Record<string, unknown>; targetAgentHandles: string[] },
  options: { automatic: true; onQueued: () => void },
) => Promise<boolean>;

/**
 * Sends an ask the way the person would type it, to Octo: an app-made send
 * (the composer's draft, focus and browser targeting stay as they are), and a
 * message queued behind a busy turn counts as sent.
 */
export function composerAskSender(submit: ComposerSubmit) {
  return async ({ text, metadata }: { text: string; metadata: Record<string, unknown> }): Promise<boolean> => {
    let queued = false;
    const submitted = await submit(
      { message: text, editorState: null, metadata, targetAgentHandles: ["octo"] },
      { automatic: true, onQueued: () => { queued = true; } },
    );
    return submitted || queued;
  };
}
