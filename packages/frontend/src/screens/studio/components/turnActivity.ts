// A turn's plain-language activity line (docs/Chat-Activity.md): "Built the
// map, read 6 pages, looked up 14 places" once it is done, "Looking up
// places…" while it runs.
//
// The words come only from the `activity` a runtime attached to a step and the
// controller checked and lifted to the message's top level. A label is never
// built from command output, page text or text Octo wrote: the only values that
// fill one are a count and, for a browser step, a host the runtime checked.
// Every label is checked again here with the rules in runtime-contracts'
// chat_activity.rs; `chat_activity_fixtures.json` pins both copies. A step
// without a valid label counts as an unlabelled one ("Ran 3 commands"), so
// older runtimes and history read the same way.

import { resolveRetryingStatusPresentation } from "../../../conversations/runFailurePresentation";
import type { ChatMessage } from "../types";
import { displayActivityHost } from "./activityHost";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";

export type ActivityRole = "content" | "outcome" | "quiet";
export type ActivityDone = string | { one: string; other?: string; some?: string };

export type ActivityEntry = {
  key: string;
  role: ActivityRole;
  live?: string;
  done?: ActivityDone;
  /** How many times the step ran; null when that is not known (a loop). */
  count: number | null;
  when?: "success";
  host?: string;
  pageKey?: string;
  step?: string;
  approval?: string;
};

export type StepActivity = ActivityEntry & { also: ActivityEntry[] };

const MAX_LIVE_CHARS = 40;
const MAX_DONE_CHARS = 48;
const MAX_ALSO = 3;
const MAX_COUNT = 100_000;
const MAX_HOST_CHARS = 64;
const LABEL_PUNCTUATION = "'’,.-–·:;()&!?";
const ROLES: readonly string[] = ["content", "outcome", "quiet"];
const APPROVALS: readonly string[] = ["once", "routine", "free", "denied", "expired"];
const ENTRY_KEYS = new Set(["key", "role", "live", "done", "count", "when", "host", "pageKey", "step", "approval"]);
const ALPHABETIC = /^\p{Alphabetic}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Plain words: letters, ASCII digits, single spaces and a little punctuation, no address. */
export function isPlainLabelText(text: string): boolean {
  if (text === "" || text.trim() !== text || text.includes("  ")) {
    return false;
  }
  const characters = [...text];
  const allowed = characters.every(
    (character) =>
      ALPHABETIC.test(character) || /^[0-9 ]$/u.test(character) || LABEL_PUNCTUATION.includes(character),
  );
  if (!allowed) {
    return false;
  }
  const dottedWord = characters.some(
    (character, index) =>
      character === "." &&
      index + 1 < characters.length &&
      (ALPHABETIC.test(characters[index + 1]) || /^[0-9]$/u.test(characters[index + 1])),
  );
  return !dottedWord && !text.toLowerCase().includes("www");
}

function withoutPlaceholder(text: string, placeholder: string, allowed: boolean): string | null {
  const found = text.split(placeholder).length - 1;
  if (found === 0) {
    return text;
  }
  // A plain word stands in for the host, so the words around it follow the same rules.
  return found === 1 && allowed ? text.replace(placeholder, "host") : null;
}

export function isLiveLabel(text: unknown, allowHost = false): text is string {
  if (typeof text !== "string") {
    return false;
  }
  const bare = withoutPlaceholder(text, "{host}", allowHost);
  return (
    bare !== null &&
    [...text].length <= MAX_LIVE_CHARS &&
    /^\p{Uppercase}/u.test(bare) &&
    isPlainLabelText(bare)
  );
}

export function isDoneForm(text: unknown, count: boolean, allowHost = false): text is string {
  if (typeof text !== "string" || text.split("{n}").length - 1 !== (count ? 1 : 0)) {
    return false;
  }
  const filled = text.replace("{n}", "999");
  const bare = withoutPlaceholder(filled, "{host}", allowHost);
  return (
    bare !== null &&
    [...filled].length <= MAX_DONE_CHARS &&
    /^\p{Lowercase}/u.test(bare) &&
    isPlainLabelText(bare)
  );
}

function checkDone(value: unknown, allowHost: boolean): ActivityDone | null {
  if (typeof value === "string") {
    return isDoneForm(value, false, allowHost) ? value : null;
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !["one", "other", "some"].includes(key))) {
    return null;
  }
  const { one, other, some } = value;
  if (!isDoneForm(one, false, allowHost)) {
    return null;
  }
  if (other !== undefined && !isDoneForm(other, true, allowHost)) {
    return null;
  }
  if (some !== undefined && !isDoneForm(some, false, allowHost)) {
    return null;
  }
  if (other !== undefined && some === undefined) {
    return null;
  }
  return {
    one,
    ...(other !== undefined ? { other: other as string } : {}),
    ...(some !== undefined ? { some: some as string } : {}),
  };
}

export function isActivityHost(host: unknown): host is string {
  return (
    typeof host === "string" &&
    host.length > 0 &&
    host.length <= MAX_HOST_CHARS &&
    host.includes(".") &&
    !host.startsWith("www.") &&
    host
      .split(".")
      .every((label) => label.length > 0 && !label.startsWith("-") && !label.endsWith("-") && /^[a-z0-9-]+$/u.test(label))
  );
}

function checkEntry(value: unknown, topLevel: boolean): ActivityEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (Object.keys(value).some((key) => !ENTRY_KEYS.has(key) && !(topLevel && (key === "v" || key === "also")))) {
    return null;
  }
  const { key, role } = value;
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > 128 ||
    !/^[a-z0-9][a-z0-9/_.*:-]*$/u.test(key) ||
    typeof role !== "string" ||
    !ROLES.includes(role)
  ) {
    return null;
  }
  const entry: ActivityEntry = { key, role: role as ActivityRole, count: 1 };
  if (value.host !== undefined) {
    if (!isActivityHost(value.host)) {
      return null;
    }
    entry.host = value.host;
  }
  const allowHost = entry.host !== undefined;
  if (value.live !== undefined) {
    if (!isLiveLabel(value.live, allowHost)) {
      return null;
    }
    entry.live = value.live;
  }
  if (value.done !== undefined) {
    const done = checkDone(value.done, allowHost);
    if (done === null) {
      return null;
    }
    entry.done = done;
  } else if (role !== "quiet") {
    return null;
  }
  if (value.count === null) {
    entry.count = null;
  } else if (value.count !== undefined) {
    if (typeof value.count !== "number" || !Number.isInteger(value.count) || value.count < 1 || value.count > MAX_COUNT) {
      return null;
    }
    entry.count = value.count;
  }
  if (value.when !== undefined) {
    if (value.when !== "success") {
      return null;
    }
    entry.when = "success";
  }
  if (value.pageKey !== undefined) {
    if (typeof value.pageKey !== "string" || !/^[0-9a-f]{16}$/u.test(value.pageKey)) {
      return null;
    }
    entry.pageKey = value.pageKey;
  }
  if (value.step !== undefined) {
    if (typeof value.step !== "string" || !/^[a-z][a-z_]{0,23}$/u.test(value.step)) {
      return null;
    }
    entry.step = value.step;
  }
  if (value.approval !== undefined) {
    if (typeof value.approval !== "string" || !APPROVALS.includes(value.approval)) {
      return null;
    }
    entry.approval = value.approval;
  }
  return entry;
}

/** A step's `activity` with only the fields this version knows, or null when it breaks a rule. */
export function checkActivity(value: unknown): StepActivity | null {
  if (!isRecord(value) || value.v !== 1) {
    return null;
  }
  const entry = checkEntry(value, true);
  if (!entry) {
    return null;
  }
  const rawAlso = value.also ?? [];
  if (!Array.isArray(rawAlso) || rawAlso.length > MAX_ALSO) {
    return null;
  }
  const also: ActivityEntry[] = [];
  for (const item of rawAlso) {
    const checked = checkEntry(item, false);
    if (!checked) {
      return null;
    }
    also.push(checked);
  }
  return { ...entry, also };
}

/**
 * The activity a runtime attached to this step: only at the top level of an
 * assistant message the agent wrote for this turn's job, never one a person
 * recorded or one nested in its details.
 */
export function readStepActivity(message: ChatMessage, jobId: string | null): StepActivity | null {
  if (message.role !== "assistant" || !isRecord(message.metadata)) {
    return null;
  }
  const metadata = message.metadata;
  if (metadata.source !== "agent") {
    return null;
  }
  if (jobId && (typeof metadata.jobId !== "string" || metadata.jobId.trim() !== jobId)) {
    return null;
  }
  return checkActivity(metadata.activity);
}

export type StepKind = "command" | "tool" | "search" | "edit";
/**
 * "unfinished": the step was still running when its turn ended, so nothing it
 * would have done is known to have happened.
 */
export type StepState = "running" | "done" | "failed" | "unfinished";

export type TurnStep = {
  kind: StepKind;
  message: ChatMessage;
  activity: StepActivity | null;
  state: StepState;
  /**
   * The label Details shows beside the step: from its activity, else a
   * neutral one for its kind ("Ran a command"). A finished step reads in
   * the past tense, a failed one as what it tried ("Tried searching the web"),
   * and one its turn ended before as what it did not finish ("Didn't finish
   * finding places to stay").
   */
  label: string;
  /**
   * A look around the workspace (`pwd`, `ls`, `cat`, a `--help`) that the
   * runtime marked as such: Details lists it, the line never counts it.
   */
  plumbing?: true;
};

export type DetailItem =
  | { kind: "step"; id: string; step: TurnStep }
  | { kind: "update"; id: string; message: ChatMessage }
  /** A browser prompt the person answered, or left: "You allowed a search on visitlisboa.com". */
  | { kind: "approval"; id: string; text: string };

export type BrowserApprovalOutcome = "allowed" | "denied" | "expired";

/**
 * A browser prompt of this turn's run that was answered (or left to expire)
 * while this tab watched, from the approval lane. Only the operation and the
 * sites the runtime's request names; never the prompt's label, which may
 * carry the page's own words.
 */
export type SessionBrowserApproval = {
  approvalId: string;
  outcome: BrowserApprovalOutcome;
  operation: string;
  /** The site the step is on: an action's page, or the site a site prompt asks for. */
  host: string | null;
  /** Where a navigation goes. */
  destinationHost: string | null;
};

export type TurnActivityPhase = "starting" | "running" | "completed" | "failed" | "cancelled" | "stale";

export type TurnActivity = {
  /** The running line ("Looking up places…"), while the turn runs. */
  live: string | null;
  /** The done line ("Read 6 pages, looked up 14 places"), once it ended. */
  summary: string | null;
  stepCount: number;
  details: DetailItem[];
};

/** The line before the model has begun, and before its first step. */
export const STARTING_LINE = "Starting…";
/** The line while the model works with no step running. */
export const THINKING_LINE = "Thinking…";
/** The line while a request in the turn waits on the person viewing it. */
export const WAITING_FOR_YOU_LINE = "Waiting for you";

const STEP_TYPES: Record<string, StepKind> = {
  command_execution: "command",
  mcp_tool_call: "tool",
  web_search: "search",
  file_change: "edit",
};
const RUNNING_STATES = new Set(["in_progress", "queued", "started", "running", "applying", "refreshing", "pending"]);
const FAILED_STATES = new Set(["failed", "failure", "error", "errored", "declined", "cancelled", "canceled"]);

function stepState(message: ChatMessage): StepState {
  const details = extractMessageDetails(isRecord(message.metadata) ? message.metadata : null);
  const status = typeof details?.status === "string" ? details.status.trim().toLowerCase() : "";
  if (RUNNING_STATES.has(status)) {
    return "running";
  }
  const exitCode = details?.exitCode ?? details?.exit_code;
  if (FAILED_STATES.has(status) || (typeof exitCode === "number" && exitCode !== 0)) {
    return "failed";
  }
  return "done";
}

function stepKey(message: ChatMessage, kind: StepKind): string {
  const details = extractMessageDetails(isRecord(message.metadata) ? message.metadata : null);
  const itemId = typeof details?.itemId === "string" ? details.itemId.trim() : "";
  return itemId ? `${kind}:${itemId}` : `message:${message.id}`;
}

function stepPaths(message: ChatMessage): string[] {
  const details = extractMessageDetails(isRecord(message.metadata) ? message.metadata : null);
  const paths = details?.paths;
  return Array.isArray(paths) ? paths.filter((path): path is string => typeof path === "string") : [];
}

function fillHost(text: string, host: string | undefined): string {
  return host ? text.replace("{host}", displayActivityHost(host)) : text;
}

/** One group's words for a count: `one`, `other` with the count, or `some`. */
export function doneWords(done: ActivityDone, count: number | null, host?: string): string {
  if (typeof done === "string") {
    return fillHost(done, host);
  }
  if (count === null) {
    return fillHost(done.some ?? done.one, host);
  }
  if (count === 1 || done.other === undefined) {
    return fillHost(done.one, host);
  }
  return fillHost(done.other.replace("{n}", String(count)), host);
}

function capitalize(text: string): string {
  const [first = "", ...rest] = [...text];
  return first.toUpperCase() + rest.join("");
}

/** A running label in the middle of a sentence: "Searching the web" reads "searching the web". */
function lowerFirst(text: string): string {
  const [first = "", second = "", ...rest] = [...text];
  // "PDF export" keeps its capitals.
  return /^\p{Uppercase}$/u.test(second) ? text : first.toLowerCase() + second + rest.join("");
}

/** "tried searching the web": a step that failed, in the past tense, never as what it would have done. */
function triedWords(live: string, host?: string): string {
  return `tried ${lowerFirst(fillHost(live, host))}`;
}

/**
 * The entry a step is named by: its first that says what the step did or
 * made. In a chain the meaningful command wins over the quiet setup before it
 * ("uw geocode Baixa; uw stay …" finds places to stay); a step of quiet
 * commands only is named by its first.
 */
export function primaryEntry(activity: StepActivity): ActivityEntry {
  return [activity, ...activity.also].find((entry) => entry.role !== "quiet") ?? activity;
}

// Steps no runtime labelled (an unlisted command, an older runtime) read as
// what is sure of their kind, the words the line's own neutral count uses. An
// unlabelled command may read a file, but as often stops a site by its
// process, writes a file or deletes one, so it never reads as a look around.
// The command itself stays the row's second line.
const NEUTRAL_LABELS: Record<StepKind, { live: string; done: string }> = {
  command: { live: "Running a command", done: "ran a command" },
  tool: { live: "Using a tool", done: "used a tool" },
  search: { live: "Searching the web", done: "searched the web" },
  edit: { live: "Editing files", done: "edited files" },
};

// Steps that leave a site open or stopped. The preview card already says the
// site opened, so the line names one only when no other step finished: then
// it is the last of them that succeeded, and a site it stopped and opened
// again is open, never "stopped the preview".
const PREVIEW_RESULTS = new Map<string, string>([
  ["instafy/preview-open", "opened a preview"],
  ["instafy/preview-close", "stopped the preview"],
]);

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many.replace("{n}", String(count));
}

/**
 * "ran 5 commands, used 2 tools": what an unlabelled turn did, by kind. A look
 * around the workspace is not counted: a turn that only did that and answered
 * (or posted a card) has no line, as a plain answer has none.
 */
function neutralCounts(allSteps: TurnStep[]): string | null {
  const steps = allSteps.filter((step) => !step.plumbing);
  const commands = steps.filter((step) => step.kind === "command").length;
  const tools = steps.filter((step) => step.kind === "tool" || step.kind === "search").length;
  const files = new Set<string>();
  let unnamedEdits = 0;
  for (const step of steps) {
    if (step.kind !== "edit") {
      continue;
    }
    const paths = stepPaths(step.message);
    if (paths.length === 0) {
      unnamedEdits += 1;
    }
    paths.forEach((path) => files.add(path));
  }
  const edited = files.size + unnamedEdits;
  const parts = [
    commands > 0 ? plural(commands, "ran a command", "ran {n} commands") : null,
    tools > 0 ? plural(tools, "used a tool", "used {n} tools") : null,
    edited > 0 ? plural(edited, "edited a file", "edited {n} files") : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : null;
}

type Group = {
  entry: ActivityEntry;
  known: number;
  unknown: boolean;
  members: number;
  first: number;
  last: number;
  paths: Set<string> | null;
  /** The distinct pages a browser group opened or read, by the runtime's key of each address. */
  pageKeys: Set<string> | null;
  /** Its steps that named no page key. */
  unkeyed: number;
};

// Browser groups that count pages, not steps: reading the same page twice is
// "read a page". A search counts each time it ran.
const PAGE_COUNTED_KEYS = new Set(["browser/read", "browser/open"]);
// A browser step taken before any site was known ("used the browser").
const BROWSER_WITHOUT_SITE = "browser/use";
const BROWSER_READ = "browser/read";
// Browser steps that can take the tab to another page. A look at the page
// before the first of them that worked is a look at the page the turn started
// on, which another turn (or another chat) left there.
const PAGE_MOVING_STEPS = new Set(["navigate", "open_tab", "click", "search", "submit", "press"]);

function movesThePage(step: TurnStep): boolean {
  const entry = step.activity;
  return (
    step.state === "done" &&
    entry !== null &&
    entry.key.startsWith("browser/") &&
    entry.step !== undefined &&
    PAGE_MOVING_STEPS.has(entry.step)
  );
}

function groupCount(group: Group): number | null {
  if (group.unknown) {
    return null;
  }
  if (group.paths && group.paths.size > 0) {
    return group.paths.size;
  }
  if (group.pageKeys && group.pageKeys.size > 0) {
    return group.pageKeys.size + group.unkeyed;
  }
  return group.known;
}

/**
 * A group's done words. After a group on the same site, its trailing
 * " on {host}" goes: "Searched visitlisboa.com, read 2 pages".
 */
function groupWords(group: Group, previousHost: string | null): string {
  let done = group.entry.done as ActivityDone;
  const host = group.entry.host;
  if (host && host === previousHost) {
    const trim = (form: string) => (form.endsWith(" on {host}") ? form.slice(0, -" on {host}".length) : form);
    done = typeof done === "string"
      ? trim(done)
      : {
        one: trim(done.one),
        ...(done.other !== undefined ? { other: trim(done.other) } : {}),
        ...(done.some !== undefined ? { some: trim(done.some) } : {}),
      };
  }
  return doneWords(done, groupCount(group), host);
}

/**
 * The done line from the turn's labelled steps, or null when none is shown,
 * with the host of the first group it shows.
 *
 * What the turn made leads ("Built the map, read 6 pages, looked up 14
 * places"), then the step that answered and the biggest other thing it did.
 * Only a step that ended counts, and the steps are in the order they last
 * changed (a step's newest message), as the turn's stored steps are. A step
 * that failed counts for nothing it would have done: when nothing else is left
 * to say, the line says what was tried ("Tried searching the web"). A preview
 * the turn opened or stopped, and a look at the page the turn started on, are
 * named only when the turn did nothing else.
 */
function summarizeGroups(steps: TurnStep[]): { text: string | null; firstHost: string | null } {
  const groups = new Map<string, Group>();
  // Looks at the page the browser was on when the turn began.
  const startPage = new Map<string, Group>();
  const firstMove = steps.findIndex(movesThePage);
  // Assigned in the loop below; the assertions keep them from narrowing to null.
  let tried = null as ActivityEntry | null;
  let result = null as string | null;
  steps.forEach((step, index) => {
    if (!step.activity) {
      return;
    }
    const lookAtStartPage = firstMove === -1 || index < firstMove;
    // A step the person said no to, or left, is named by its answer instead.
    const declined = step.activity.approval === "denied" || step.activity.approval === "expired";
    for (const entry of [step.activity, ...step.activity.also]) {
      if (step.state === "failed") {
        if (!tried && !declined && entry.role !== "quiet" && entry.live) {
          tried = entry;
        }
        continue;
      }
      // Only a step that ended counts, whatever its label's `when` says: one
      // still running (or that its turn ended before) has found nothing yet.
      if (step.state !== "done") {
        continue;
      }
      const previewResult = PREVIEW_RESULTS.get(entry.key);
      if (previewResult !== undefined) {
        // A chain's entries come in the order it ran them, so the later
        // preview step overwrites the earlier one.
        result = previewResult;
        continue;
      }
      if (entry.role === "quiet") {
        continue;
      }
      if (!entry.done) {
        continue;
      }
      const groupKey = entry.host ? `${entry.key}@${entry.host}` : entry.key;
      const into = entry.key === BROWSER_READ && lookAtStartPage ? startPage : groups;
      let group = into.get(groupKey);
      if (!group) {
        group = {
          entry, known: 0, unknown: false, members: 0, first: index, last: index, paths: null, pageKeys: null, unkeyed: 0,
        };
        into.set(groupKey, group);
      }
      group.members += 1;
      group.last = index;
      if (entry.count === null) {
        group.unknown = true;
      } else {
        group.known += entry.count;
      }
      if (PAGE_COUNTED_KEYS.has(entry.key)) {
        if (entry.pageKey) {
          group.pageKeys ??= new Set();
          group.pageKeys.add(entry.pageKey);
        } else {
          group.unkeyed += entry.count ?? 1;
        }
      }
      if (entry.key === "builtin/edit" && step.kind === "edit") {
        const paths = stepPaths(step.message);
        if (paths.length > 0) {
          group.paths ??= new Set();
          paths.forEach((path) => group?.paths?.add(path));
        }
      }
    }
  });
  const all = [...groups.values()];
  const weight = (group: Group) => groupCount(group) ?? group.members;
  // "Used the browser" is a browser step before any site was known. Once a
  // step names its site it says nothing more: "Opened 2 pages on
  // visitlisboa.com", not "Used the browser, opened 2 pages on visitlisboa.com".
  const namesASite = [...all, ...startPage.values()].some(
    (group) => group.entry.key.startsWith("browser/") && group.entry.host,
  );
  const contentGroups = all.filter(
    (group) => group.entry.role === "content" && !(namesASite && group.entry.key === BROWSER_WITHOUT_SITE),
  );
  // The step that answered is the last thing the turn did, and it leads:
  // "Read a page on carris.pt", never the first page opened on the way. The
  // biggest of the rest follows it (the later one when they tie). On one site
  // they read in the order they ran: "Searched visitlisboa.com, read 2 pages".
  const answered = contentGroups.reduce<Group | null>(
    (latest, group) => (latest === null || group.last > latest.last ? group : latest),
    null,
  );
  const other = contentGroups
    .filter((group) => group !== answered)
    .sort((a, b) => weight(b) - weight(a) || b.last - a.last)
    .at(0);
  const content = !answered
    ? []
    : !other
      ? [answered]
      : other.entry.host !== undefined && other.entry.host === answered.entry.host && other.first < answered.first
        ? [other, answered]
        : [answered, other];
  const outcome = all
    .filter((group) => group.entry.role === "outcome")
    .sort((a, b) => b.last - a.last)
    .slice(0, 1);
  const shown = [...outcome, ...content];
  const phrases: string[] = shown.length === 0 && result ? [result] : [];
  let previousHost: string | null = null;
  for (const group of shown) {
    phrases.push(groupWords(group, previousHost));
    previousHost = group.entry.host ?? null;
  }
  if (phrases.length === 0 && tried?.live) {
    return { text: triedWords(tried.live, tried.host), firstHost: tried.host ?? null };
  }
  if (phrases.length === 0 && startPage.size > 0) {
    // The turn only looked at the page it started on: that is what it did.
    const looks = [...startPage.values()].sort((a, b) => a.first - b.first);
    return {
      text: looks.map((group) => groupWords(group, null)).join(", "),
      firstHost: looks[0].entry.host ?? null,
    };
  }
  return {
    text: phrases.length > 0 ? phrases.join(", ") : null,
    firstHost: shown.find((group) => group.entry.host)?.entry.host ?? null,
  };
}

type AnsweredApproval = {
  outcome: BrowserApprovalOutcome;
  /** What was asked: the site itself, opening a page, or a step on the site. */
  noun: { kind: "site" } | { kind: "opening"; destination: string | null } | { kind: "step"; words: string };
  host: string | null;
};

const STEP_APPROVAL_OUTCOMES: Record<string, BrowserApprovalOutcome> = {
  once: "allowed",
  denied: "denied",
  expired: "expired",
};

/** What a browser step that waited on a prompt was, from its own activity (after a reload too). */
function stepAnsweredApproval(activity: StepActivity | null): AnsweredApproval | null {
  const outcome = activity?.approval ? STEP_APPROVAL_OUTCOMES[activity.approval] : undefined;
  if (!activity || !outcome) {
    return null;
  }
  const host = activity.host ?? null;
  switch (activity.step) {
    case "search":
      return { outcome, noun: { kind: "step", words: "a search" }, host };
    case "navigate":
    case "open_tab":
      return { outcome, noun: { kind: "opening", destination: host }, host };
    case "click":
      return { outcome, noun: { kind: "step", words: "a click" }, host };
    case "submit":
      return { outcome, noun: { kind: "step", words: "a form" }, host };
    case "type":
      return { outcome, noun: { kind: "step", words: "typing" }, host };
    case "press":
      return { outcome, noun: { kind: "step", words: "a key press" }, host };
    default:
      return { outcome, noun: { kind: "site" }, host };
  }
}

/** What a prompt answered in this tab asked, from the runtime's operation. */
function sessionAnsweredApproval(approval: SessionBrowserApproval): AnsweredApproval {
  const host = isActivityHost(approval.host) ? approval.host : null;
  const step = (words: string): AnsweredApproval => ({ outcome: approval.outcome, noun: { kind: "step", words }, host });
  switch (approval.operation) {
    case "approve-origin":
      return { outcome: approval.outcome, noun: { kind: "site" }, host };
    case "navigate":
      return {
        outcome: approval.outcome,
        noun: { kind: "opening", destination: isActivityHost(approval.destinationHost) ? approval.destinationHost : host },
        host,
      };
    case "click":
      return step("a click");
    case "type":
      return step("typing");
    case "form-submit":
      return step("a form");
    case "press-enter":
    case "press-space":
    case "press-key":
      return step("a key press");
    default:
      return step("a step");
  }
}

/**
 * "you allowed a search on visitlisboa.com", "you said no to opening
 * carris.pt", "skipped a click on carris.pt: no answer in time". The host is
 * left out when it is the site the line already names first.
 */
function approvalWords(approval: AnsweredApproval, namedHost: string | null): string {
  const host = approval.host && approval.host !== namedHost ? displayActivityHost(approval.host) : null;
  const noun =
    approval.noun.kind === "site"
      ? (host ?? "the site")
      : approval.noun.kind === "opening"
        ? approval.noun.destination
          ? `opening ${displayActivityHost(approval.noun.destination)}`
          : "opening a page"
        : `${approval.noun.words}${host ? ` on ${host}` : ""}`;
  switch (approval.outcome) {
    case "allowed":
      return `you allowed ${noun}`;
    case "denied":
      return `you said no to ${noun}`;
    default:
      return `skipped ${noun}: no answer in time`;
  }
}

/** One clause for the turn's answered prompts: the latest outcome, counted when it repeats. */
function approvalsClause(answered: readonly AnsweredApproval[], namedHost: string | null): string | null {
  const latest = answered.at(-1);
  if (!latest) {
    return null;
  }
  const same = answered.filter((approval) => approval.outcome === latest.outcome).length;
  if (same === 1) {
    return approvalWords(latest, namedHost);
  }
  switch (latest.outcome) {
    case "allowed":
      return `you allowed ${same} steps`;
    case "denied":
      return `you said no to ${same} steps`;
    default:
      return `skipped ${same} steps: no answer in time`;
  }
}

function neutralDone(kind: StepKind, message: ChatMessage): string {
  if (kind === "edit") {
    const paths = new Set(stepPaths(message)).size;
    return paths > 0 ? plural(paths, "edited a file", "edited {n} files") : NEUTRAL_LABELS.edit.done;
  }
  return NEUTRAL_LABELS[kind].done;
}

// A browser step that only listed or switched the browser's tabs names no
// page. Its row says so in words, never with the tool's name.
const BROWSER_TABS_LABEL = { live: "Looking at the tabs", done: "looked at the tabs" };
// A step of Instafy's own browsers that no runtime labelled (an older one).
const BROWSER_NEUTRAL_LABEL = { live: "Using the browser", done: "used the browser" };

/** Instafy's own browsers: Details names their steps by site, never by tool. */
export const BROWSER_TOOL_SERVERS: ReadonlySet<string> = new Set([
  "instafy_shared_browser",
  "instafy_personal_browser",
  "instafy_local_browser",
]);

/** A tool call made in one of Instafy's own browsers. */
export function isBrowserToolStep(step: Pick<TurnStep, "kind" | "message" | "activity">): boolean {
  if (step.kind !== "tool") {
    return false;
  }
  if (step.activity?.key.startsWith("browser/")) {
    return true;
  }
  const details = extractMessageDetails(isRecord(step.message.metadata) ? step.message.metadata : null);
  const server = typeof details?.server === "string" ? details.server.trim() : "";
  return BROWSER_TOOL_SERVERS.has(server);
}

function isBrowserTabsStep(entry: ActivityEntry | null): boolean {
  return Boolean(entry?.key.startsWith("browser/") && entry.step === "tabs");
}

function stepLabel(kind: StepKind, message: ChatMessage, activity: StepActivity | null, state: StepState): string {
  const entry = activity ? primaryEntry(activity) : null;
  const tabs = isBrowserTabsStep(entry);
  const unlabelledBrowserStep = !entry && isBrowserToolStep({ kind, message, activity });
  const live = tabs
    ? BROWSER_TABS_LABEL.live
    : entry?.live
      ? fillHost(entry.live, entry.host)
      : unlabelledBrowserStep
        ? BROWSER_NEUTRAL_LABEL.live
        : NEUTRAL_LABELS[kind].live;
  if (state === "running") {
    return live;
  }
  // Its turn ended first: it says what it did not finish, in the past, never
  // as if it still ran ("Finding places to stay") or had found something.
  if (state === "unfinished") {
    return `Didn't finish ${lowerFirst(live)}`;
  }
  // A failed step says what it tried ("Tried checking the map"), never what
  // it would have done ("Built the map").
  if (state === "failed") {
    return capitalize(triedWords(live));
  }
  if (tabs) {
    return capitalize(BROWSER_TABS_LABEL.done);
  }
  if (entry?.done) {
    return capitalize(doneWords(entry.done, entry.count, entry.host));
  }
  if (unlabelledBrowserStep) {
    return capitalize(BROWSER_NEUTRAL_LABEL.done);
  }
  // A quiet step its runtime gave no past form keeps its own words.
  return entry ? live : capitalize(neutralDone(kind, message));
}

// A command made only of looks around the workspace (`pwd`, `ls`, `cat`,
// `rg --files`, a `--help`), as the runtime marks it. Its row reads as any
// unlabelled command's; it only leaves the line's count.
const PLUMBING_KEY = "builtin/plumbing";
// The runtime's status for the save at the end of a turn (activity_labels.rs).
const SAVE_KEY = "runtime/save";

/** One step as Details shows it, or null when the message is not a step. */
export function turnStepFromMessage(message: ChatMessage, jobId: string | null): TurnStep | null {
  const kind = STEP_TYPES[(getMessageType(message) ?? "").trim().toLowerCase()];
  if (!kind) {
    return null;
  }
  const checked = readStepActivity(message, jobId);
  const plumbing = kind === "command" && checked?.key === PLUMBING_KEY && checked.also.length === 0;
  const activity = plumbing ? null : checked;
  const state = stepState(message);
  return {
    kind,
    message,
    activity,
    state,
    label: stepLabel(kind, message, activity, state),
    ...(plumbing ? { plumbing: true as const } : {}),
  };
}

/** The step as its turn left it: one still running when the turn ended did not finish. */
function endedStep(step: TurnStep): TurnStep {
  return step.state === "running"
    ? { ...step, state: "unfinished", label: stepLabel(step.kind, step.message, step.activity, "unfinished") }
    : step;
}

function isRuntimeStatus(message: ChatMessage): boolean {
  return (getMessageType(message) ?? "").trim().toLowerCase() === "status";
}

// A note that starts as a JSON object (or a list of them) is data, not words:
// `{"task": …}`, `{"url": …, "facts": […]}`.
const JSON_NOTE = /^\s*(?:\[\s*)?\{\s*"[^"\n]+"\s*:/u;

/**
 * Whether Details lists this note: Octo's notes, reasoning titles and plan
 * updates. A status the runtime writes itself ("Trying again…", "Saving your
 * changes") is neither a step nor a note, and a note that is only data (a
 * browser card's request, the findings a browser turn hands back) repeats what
 * the card or the reply already says; the findings stay in the hand-back.
 */
export function isDetailsNote(message: ChatMessage): boolean {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  if (isRuntimeStatus(message) && readStepActivity(message, null) !== null) {
    return false;
  }
  if (resolveRetryingStatusPresentation({ metadata, content: message.content })) {
    return false;
  }
  const details = extractMessageDetails(metadata);
  if (isRecord(metadata?.browserFindings) || isRecord(details?.browserFindings)) {
    return false;
  }
  return !JSON_NOTE.test(message.content);
}

/**
 * The done line of a turn that ran no step but left something in Details:
 * Octo's notes, a plan, a thread it started. Neutral counts only, never the
 * notes' own words (they are free text the model wrote after reading pages),
 * so Details stays reachable: "Wrote 2 notes", "Made a plan, wrote a note".
 * Reasoning titles alone leave no line, as they leave Details closed, and a
 * status the runtime wrote itself (a retry, its label attached) is no note.
 */
export function detailsOnlySummary(items: readonly DetailItem[], threads = 0): string | null {
  let notes = 0;
  let plans = 0;
  for (const item of items) {
    if (item.kind !== "update") continue;
    const type = (getMessageType(item.message) ?? "").trim().toLowerCase();
    if (type === "reasoning") continue;
    if (readStepActivity(item.message, null) !== null) continue;
    if (type === "todo_list") plans += 1;
    else notes += 1;
  }
  const parts = [
    plans > 0 ? "made a plan" : null,
    notes > 0 ? plural(notes, "wrote a note", "wrote {n} notes") : null,
    threads > 0 ? plural(threads, "started a thread", "started {n} threads") : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? capitalize(parts.join(", ")) : null;
}

/** A finished turn stores at most this many steps with its reply. */
const MAX_RECORDED_STEPS = 400;

/**
 * The steps of a finished turn as the controller stored them with its reply
 * (`turnSteps`: each step's type, status, exit code, files and checked
 * activity), as step messages the line counts. A page of history can start in
 * the middle of a long turn, so after a reload the loaded steps may be only its
 * last ones; these are all of them, and the line reads as it did when the turn
 * ended. Null when the reply carries none (an older controller, a turn with no
 * steps), or is not the agent's reply for this turn.
 */
export function readTurnStepsRecord(message: ChatMessage, jobId: string | null): ChatMessage[] | null {
  if (message.role !== "assistant" || !isRecord(message.metadata)) {
    return null;
  }
  const metadata = message.metadata;
  if (metadata.source !== "agent" || !jobId || (typeof metadata.jobId === "string" ? metadata.jobId.trim() : "") !== jobId) {
    return null;
  }
  const record = metadata.turnSteps;
  if (!isRecord(record) || record.v !== 1 || !Array.isArray(record.steps) || !Array.isArray(record.activities)) {
    return null;
  }
  const { activities, steps } = record as { activities: unknown[]; steps: unknown[] };
  if (steps.length === 0 || steps.length > MAX_RECORDED_STEPS) {
    return null;
  }
  const messages: ChatMessage[] = [];
  for (const [index, value] of steps.entries()) {
    if (!isRecord(value) || typeof value.type !== "string" || !STEP_TYPES[value.type]) {
      return null;
    }
    const details: Record<string, unknown> = { itemId: `recorded-${index}` };
    if (typeof value.status === "string") details.status = value.status;
    if (typeof value.exitCode === "number" && Number.isInteger(value.exitCode)) details.exitCode = value.exitCode;
    if (Array.isArray(value.paths)) details.paths = value.paths.filter((path) => typeof path === "string");
    const activity =
      typeof value.activity === "number" && Number.isInteger(value.activity) ? activities[value.activity] : undefined;
    messages.push({
      id: `turn-step:${jobId}:${index}`,
      role: "assistant",
      content: "",
      timestamp: index,
      messageType: value.type,
      metadata: {
        source: "agent",
        jobId,
        messageType: value.type,
        details,
        ...(activity !== undefined ? { activity } : {}),
      },
    });
  }
  return messages;
}

export type SummarizeTurnActivityOptions = {
  jobId: string | null;
  phase: TurnActivityPhase;
  /** The person viewing can answer a request the turn waits on. */
  viewerCanAnswer?: boolean;
  /**
   * Browser prompts of this turn's run answered while this tab watched. The
   * steps' own activity says the same once they end (and after a reload);
   * these stand in when no step does, as with an older runtime.
   */
  approvals?: readonly SessionBrowserApproval[];
  /** Non-step messages Details lists between the steps (notes, plan updates). */
  updates?: readonly ChatMessage[];
};

/**
 * The turn's activity line and the steps behind its Details. Only steps
 * (commands, tool calls, web searches, file edits) and the runtime's own
 * statuses feed the line; the model's notes and reasoning never do.
 */
export function summarizeTurnActivity(
  threadMessages: readonly ChatMessage[],
  options: SummarizeTurnActivityOptions,
): TurnActivity {
  const { jobId, phase } = options;
  const stepIndexByKey = new Map<string, number>();
  const steps: TurnStep[] = [];
  // Where each step's newest message sits in the thread.
  const stepMessageIndex: number[] = [];
  const order: Array<{ kind: "step"; key: string } | { kind: "update"; message: ChatMessage }> = [];
  const updateIds = new Set((options.updates ?? []).map((update) => update.id));
  // A runtime status ("Saving your changes", "Retrying") names the line only
  // while it is the newest thing in the turn: any later message (a step, the
  // model reasoning or writing again, the save's own "done" status) ends it.
  let newestOtherIndex = -1;
  let newestStatus: { index: number; activity: StepActivity } | null = null;
  // The turn's save ("Saving your changes" once the model is done) is a point
  // the turn moved past: a step still running from before it never names the
  // line again. A retry is not: the turn goes on after it.
  let newestSaveIndex = -1;

  threadMessages.forEach((message, index) => {
    const type = (getMessageType(message) ?? "").trim().toLowerCase();
    const kind = STEP_TYPES[type];
    if (kind) {
      newestOtherIndex = index;
      const key = stepKey(message, kind);
      const step = turnStepFromMessage(message, jobId) as TurnStep;
      const existing = stepIndexByKey.get(key);
      if (existing !== undefined) {
        // The newest message of a step stands for it (started, then completed).
        steps[existing] = step;
        stepMessageIndex[existing] = index;
        return;
      }
      stepIndexByKey.set(key, steps.length);
      steps.push(step);
      stepMessageIndex.push(index);
      order.push({ kind: "step", key });
      return;
    }
    if (isRuntimeStatus(message)) {
      const activity = readStepActivity(message, jobId);
      if (activity) {
        newestStatus = { index, activity };
        if (activity.key === SAVE_KEY) {
          newestSaveIndex = index;
        }
      } else {
        newestOtherIndex = index;
      }
    } else {
      newestOtherIndex = index;
    }
    if (updateIds.has(message.id) && isDetailsNote(message)) {
      order.push({ kind: "update", message });
    }
  });
  // Once the turn has ended, a step still running did not finish: its row
  // says so, with no spinner, and it counts for nothing it would have done.
  if (phase === "completed" || phase === "failed" || phase === "cancelled") {
    steps.forEach((step, index) => {
      steps[index] = endedStep(step);
    });
  }

  const answered: AnsweredApproval[] = [];
  const details: DetailItem[] = order.flatMap((item): DetailItem[] => {
    if (item.kind === "update") {
      return [{ kind: "update", id: item.message.id, message: item.message }];
    }
    const step = steps[stepIndexByKey.get(item.key) ?? 0];
    const approval = step.state === "running" ? null : stepAnsweredApproval(step.activity);
    if (!approval) {
      return [{ kind: "step", id: item.key, step }];
    }
    answered.push(approval);
    return [
      { kind: "step", id: item.key, step },
      { kind: "approval", id: `approval:${item.key}`, text: capitalize(approvalWords(approval, null)) },
    ];
  });
  if (answered.length === 0) {
    for (const approval of options.approvals ?? []) {
      const sessionApproval = sessionAnsweredApproval(approval);
      answered.push(sessionApproval);
      details.push({
        kind: "approval",
        id: `approval:${approval.approvalId}`,
        text: capitalize(approvalWords(sessionApproval, null)),
      });
    }
  }

  const stepCount = steps.length;
  let live: string | null = null;
  let summary: string | null = null;
  if (phase === "starting") {
    // A turn Instafy tries again by itself starts as any turn does: one
    // "Starting…", never a "Trying again…" of its own.
    live = STARTING_LINE;
  } else if (phase === "stale") {
    live = "Status unavailable";
  } else if (phase === "running") {
    const status = newestStatus as { index: number; activity: StepActivity } | null;
    const runningStep =
      [...steps.keys()]
        .reverse()
        .filter((index) => steps[index].state === "running" && stepMessageIndex[index] > newestSaveIndex)
        .map((index) => steps[index])
        .at(0) ?? null;
    const runningEntry = runningStep?.activity ? primaryEntry(runningStep.activity) : null;
    if (options.viewerCanAnswer) {
      live = WAITING_FOR_YOU_LINE;
    } else if (stepCount === 0) {
      // From the send until the turn's first step the line says one thing,
      // however long that takes: the model reasoning, or the runtime retrying
      // its request, is still the turn starting.
      live = STARTING_LINE;
    } else if (status && status.index > newestOtherIndex && status.activity.live) {
      live = `${fillHost(status.activity.live, status.activity.host)}…`;
    } else if (runningStep) {
      const label = runningEntry?.live
        ? fillHost(runningEntry.live, runningEntry.host)
        : runningStep.kind === "edit"
          ? "Editing files"
          : "Working";
      live = `${label}…`;
    } else {
      live = THINKING_LINE;
    }
  } else {
    // In the order the steps last changed: a step that started before another
    // and ended after it is the later one. Studio's thread keeps a command
    // where its newest message is, and the turn's stored steps are in the same
    // order, so the line reads the same before and after its reply lands.
    const groups = summarizeGroups(
      [...steps.keys()].sort((a, b) => stepMessageIndex[a] - stepMessageIndex[b]).map((index) => steps[index]),
    );
    const clause = approvalsClause(answered, groups.firstHost);
    const done = [groups.text ?? neutralCounts(steps), clause].filter((part): part is string => Boolean(part)).join(" · ");
    if (phase === "cancelled") {
      summary = done ? `Stopped · ${done}` : "Stopped";
    } else {
      summary = done ? capitalize(done) : null;
    }
  }

  return { live, summary, stepCount, details };
}
