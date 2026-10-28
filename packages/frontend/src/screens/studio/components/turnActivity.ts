// A turn's plain-language activity line (docs/Chat-Activity.md): "Looked up 14
// places, read 6 pages, built the map" once it is done, "Looking up places…"
// while it runs.
//
// The words come only from the `activity` a runtime attached to a step and the
// controller checked and lifted to the message's top level. A label is never
// built from command output, page text or text Octo wrote: the only values that
// fill one are a count and, for a browser step, a host the runtime checked.
// Every label is checked again here with the rules in runtime-contracts'
// chat_activity.rs; `chat_activity_fixtures.json` pins both copies. A step
// without a valid label counts as an unlabelled one ("Ran 3 commands"), so
// older runtimes and history read the same way.

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
export type StepState = "running" | "done" | "failed";

export type TurnStep = {
  kind: StepKind;
  message: ChatMessage;
  activity: StepActivity | null;
  state: StepState;
  /** The label Details shows beside the step, from its activity. */
  label: string | null;
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
  /** The done line ("Looked up 14 places, read 6 pages"), once it ended. */
  summary: string | null;
  stepCount: number;
  details: DetailItem[];
};

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

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many.replace("{n}", String(count));
}

/** "ran 5 commands, used 2 tools": what an unlabelled turn did, by kind. */
function neutralCounts(steps: TurnStep[]): string | null {
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
 */
function summarizeGroups(steps: TurnStep[]): { text: string | null; firstHost: string | null } {
  const groups = new Map<string, Group>();
  steps.forEach((step, index) => {
    if (!step.activity) {
      return;
    }
    for (const entry of [step.activity, ...step.activity.also]) {
      if (entry.role === "quiet" || !entry.done) {
        continue;
      }
      if (entry.when === "success" && step.state !== "done") {
        continue;
      }
      const groupKey = entry.host ? `${entry.key}@${entry.host}` : entry.key;
      let group = groups.get(groupKey);
      if (!group) {
        group = {
          entry, known: 0, unknown: false, members: 0, first: index, last: index, paths: null, pageKeys: null, unkeyed: 0,
        };
        groups.set(groupKey, group);
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
  const content = all
    .filter((group) => group.entry.role === "content")
    .sort((a, b) => weight(b) - weight(a) || a.first - b.first)
    .slice(0, 2)
    .sort((a, b) => a.first - b.first);
  const outcome = all
    .filter((group) => group.entry.role === "outcome")
    .sort((a, b) => b.last - a.last)
    .slice(0, 1);
  const shown = [...content, ...outcome];
  let previousHost: string | null = null;
  const phrases = shown.map((group) => {
    const words = groupWords(group, previousHost);
    previousHost = group.entry.host ?? null;
    return words;
  });
  return {
    text: phrases.length > 0 ? phrases.join(", ") : null,
    firstHost: shown[0]?.entry.host ?? null,
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

function stepLabel(activity: StepActivity | null, state: StepState): string | null {
  if (!activity) {
    return null;
  }
  // A failed step names what it was doing ("Checking the map"), never what it
  // would have done ("Built the map").
  if (state === "done" && activity.done) {
    return capitalize(doneWords(activity.done, activity.count, activity.host));
  }
  return activity.live ? fillHost(activity.live, activity.host) : null;
}

/** One step as Details shows it, or null when the message is not a step. */
export function turnStepFromMessage(message: ChatMessage, jobId: string | null): TurnStep | null {
  const kind = STEP_TYPES[(getMessageType(message) ?? "").trim().toLowerCase()];
  if (!kind) {
    return null;
  }
  const activity = readStepActivity(message, jobId);
  const state = stepState(message);
  return { kind, message, activity, state, label: stepLabel(activity, state) };
}

function isRuntimeStatus(message: ChatMessage): boolean {
  return (getMessageType(message) ?? "").trim().toLowerCase() === "status";
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
  /** The turn is Instafy trying a failed one again by itself: it starts with "Trying again…". */
  retry?: boolean;
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
  const order: Array<{ kind: "step"; key: string } | { kind: "update"; message: ChatMessage }> = [];
  const updateIds = new Set((options.updates ?? []).map((update) => update.id));
  // A runtime status ("Saving your changes", "Retrying") names the line only
  // while it is the newest thing in the turn: any later message (a step, the
  // model reasoning or writing again, the save's own "done" status) ends it.
  let newestOtherIndex = -1;
  let newestStatus: { index: number; activity: StepActivity } | null = null;

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
        return;
      }
      stepIndexByKey.set(key, steps.length);
      steps.push(step);
      order.push({ kind: "step", key });
      return;
    }
    if (isRuntimeStatus(message)) {
      const activity = readStepActivity(message, jobId);
      if (activity) {
        newestStatus = { index, activity };
      } else {
        newestOtherIndex = index;
      }
    } else {
      newestOtherIndex = index;
    }
    if (updateIds.has(message.id)) {
      order.push({ kind: "update", message });
    }
  });

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
    live = options.retry ? "Trying again…" : "Starting…";
  } else if (phase === "stale") {
    live = "Status unavailable";
  } else if (phase === "running") {
    const status = newestStatus as { index: number; activity: StepActivity } | null;
    const runningStep = [...steps].reverse().find((step) => step.state === "running") ?? null;
    if (options.viewerCanAnswer) {
      live = "Waiting for you";
    } else if (status && status.index > newestOtherIndex && status.activity.live) {
      live = `${fillHost(status.activity.live, status.activity.host)}…`;
    } else if (runningStep) {
      const label = runningStep.activity?.live
        ? fillHost(runningStep.activity.live, runningStep.activity.host)
        : runningStep.kind === "edit"
          ? "Editing files"
          : "Working";
      live = `${label}…`;
    } else {
      live = "Thinking…";
    }
  } else {
    const groups = summarizeGroups(steps);
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
