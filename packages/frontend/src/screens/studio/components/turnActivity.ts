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

export type DetailItem = { kind: "step"; id: string; step: TurnStep } | { kind: "update"; id: string; message: ChatMessage };

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
  return host ? text.replace("{host}", host) : text;
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
};

function groupCount(group: Group): number | null {
  if (group.unknown) {
    return null;
  }
  if (group.paths && group.paths.size > 0) {
    return group.paths.size;
  }
  return group.known;
}

/** The done line from the turn's labelled steps, or null when none is shown. */
function summarizeGroups(steps: TurnStep[]): string | null {
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
        group = { entry, known: 0, unknown: false, members: 0, first: index, last: index, paths: null };
        groups.set(groupKey, group);
      }
      group.members += 1;
      group.last = index;
      if (entry.count === null) {
        group.unknown = true;
      } else {
        group.known += entry.count;
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
  const phrases = [...content, ...outcome].map((group) =>
    doneWords(group.entry.done as ActivityDone, groupCount(group), group.entry.host),
  );
  return phrases.length > 0 ? phrases.join(", ") : null;
}

function stepLabel(activity: StepActivity | null, state: StepState): string | null {
  if (!activity) {
    return null;
  }
  if (state !== "running" && activity.done) {
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

export type SummarizeTurnActivityOptions = {
  jobId: string | null;
  phase: TurnActivityPhase;
  /** The person viewing can answer a request the turn waits on. */
  viewerCanAnswer?: boolean;
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
  const order: Array<{ kind: "step"; key: string } | { kind: "update"; message: ChatMessage }> = [];
  const updateIds = new Set((options.updates ?? []).map((update) => update.id));
  let newestStepIndex = -1;
  let newestStatus: { index: number; activity: StepActivity } | null = null;

  threadMessages.forEach((message, index) => {
    const type = (getMessageType(message) ?? "").trim().toLowerCase();
    const kind = STEP_TYPES[type];
    if (kind) {
      newestStepIndex = index;
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
      }
    }
    if (updateIds.has(message.id)) {
      order.push({ kind: "update", message });
    }
  });

  const details: DetailItem[] = order.map((item) => {
    if (item.kind === "update") {
      return { kind: "update", id: item.message.id, message: item.message };
    }
    const step = steps[stepIndexByKey.get(item.key) ?? 0];
    return { kind: "step", id: item.key, step };
  });

  const stepCount = steps.length;
  let live: string | null = null;
  let summary: string | null = null;
  if (phase === "starting") {
    live = "Starting…";
  } else if (phase === "stale") {
    live = "Status unavailable";
  } else if (phase === "running") {
    const status = newestStatus as { index: number; activity: StepActivity } | null;
    const runningStep = [...steps].reverse().find((step) => step.state === "running") ?? null;
    if (options.viewerCanAnswer) {
      live = "Waiting for you";
    } else if (status && status.index > newestStepIndex && status.activity.live) {
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
    const done = summarizeGroups(steps) ?? neutralCounts(steps);
    if (phase === "cancelled") {
      summary = done ? `Stopped · ${done}` : "Stopped";
    } else {
      summary = done ? capitalize(done) : null;
    }
  }

  return { live, summary, stepCount, details };
}
