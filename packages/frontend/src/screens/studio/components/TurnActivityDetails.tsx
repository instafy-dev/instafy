import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, EditPencil, Lock, NavArrowDown, NavArrowRight, Xmark } from "iconoir-react";
import { IconButton } from "../../../components/Button";
import { Spinner } from "../../../components/Spinner";
import type { ChatMessage } from "../types";
import { displayActivityHost } from "./activityHost";
import { parseCommandExecutionOutput } from "./chatContentHelpers";
import { extractMessageDetails } from "./chatMessageMetadata";
import { CommandOutputBlock } from "./CommandOutputBlock";
import { renderThreadCompactEventIcon, stripShellWrapperFromCommand } from "./threadPreviewHelpers";
import { isBrowserToolStep, turnStepFromMessage, type DetailItem, type StepState, type TurnStep } from "./turnActivity";

/** Details lists at most this many rows before "Show earlier steps". */
export const TURN_ACTIVITY_DETAILS_ROW_CAP = 60;

const ROW_CLASS = "flex min-h-6 min-w-0 items-center gap-1.5 rounded-lg pr-1 text-xs pointer-coarse:min-h-11";
const ICON_CLASS = "h-3.5 w-3.5 flex-none text-slate-400 dark:text-slate-500";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function StepStateGlyph({ state }: { state: StepState }) {
  if (state === "running") {
    return <Spinner aria-label="Running" tone="slate" size="xs" className="h-3 w-3 flex-none" />;
  }
  // Its turn ended before it did: the label says so, and nothing spins or
  // ticks. The empty slot keeps the row's output chevron in line.
  if (state === "unfinished") {
    return <span aria-hidden="true" className="h-3.5 w-3.5 flex-none" />;
  }
  if (state === "failed") {
    return (
      <Xmark role="img" aria-label="Failed" className="h-3.5 w-3.5 flex-none text-rose-500 dark:text-rose-300" />
    );
  }
  return <Check role="img" aria-label="Done" className="h-3.5 w-3.5 flex-none text-slate-400 dark:text-slate-500" />;
}

// A label may be 48 characters: it truncates (whole in its title) and leaves
// room for the command, so the row's state and output chevron stay on screen
// at phone width.
function StepLabel({ text }: { text: string }) {
  return text ? (
    <span
      className="min-w-0 max-w-[60%] truncate font-medium text-slate-700 dark:text-slate-100"
      title={text}
      data-testid="turn-activity-step-label"
    >
      {text}
    </span>
  ) : null;
}

/**
 * A command in Details: its label, the command in mono with its shell wrapper
 * stripped (the full command in the title), its state, and its output behind a
 * chevron, collapsed until opened; once open it streams. On its own in the
 * conversation (`standalone`) the row never shows the command itself: a
 * command line can carry ids and is the plumbing the turn's default view
 * leaves out, so it waits behind the chevron with the output.
 */
function CommandStepRow({ step, standalone = false }: { step: TurnStep; standalone?: boolean }) {
  const [open, setOpen] = useState(false);
  const parsed = parseCommandExecutionOutput(step.message);
  const rawCommand = (parsed.command ?? step.message.content).trim();
  const command = stripShellWrapperFromCommand(rawCommand);
  const output = parsed.output?.trim() ? parsed.output : null;
  const label = step.label;
  const canOpen = standalone ? Boolean(command || output) : Boolean(output);
  const toggleLabel = standalone
    ? open
      ? "Hide command"
      : "Show command"
    : open
      ? "Hide output"
      : "Show output";
  return (
    <div className="min-w-0" data-testid="turn-activity-command">
      <div className={ROW_CLASS}>
        {renderThreadCompactEventIcon("command", ICON_CLASS)}
        <StepLabel text={label} />
        {standalone ? (
          <span className="flex-1" />
        ) : (
          <span
            className="min-w-0 flex-1 truncate font-mono text-xxs text-slate-500 dark:text-slate-400"
            title={rawCommand}
          >
            {command}
          </span>
        )}
        <StepStateGlyph state={step.state} />
        {canOpen ? (
          <IconButton
            aria-label={toggleLabel}
            aria-expanded={open}
            variant="ghost"
            size="xs"
            radius="full"
            tone="muted"
            onPress={() => setOpen((current) => !current)}
            data-testid="turn-activity-command-output-toggle"
            className="flex-none pointer-coarse:h-11 pointer-coarse:w-11"
          >
            {open ? (
              <NavArrowDown aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <NavArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </IconButton>
        ) : null}
      </div>
      {open ? (
        <div className="mt-1 mb-1.5 min-w-0 space-y-1">
          {standalone && command ? (
            <div
              className="truncate font-mono text-xxs text-slate-500 dark:text-slate-400"
              title={rawCommand}
              data-testid="turn-activity-command-text"
            >
              {command}
            </div>
          ) : null}
          {output ? <CommandOutputBlock command={null} output={output} status={parsed.status} compact /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A command on its own in the conversation: one label row, with the command
 * and its output one press away and never opened for the person.
 */
export function TurnCommandRow({ message }: { message: ChatMessage }) {
  const metadata = isRecord(message.metadata) ? message.metadata : null;
  const jobId = typeof metadata?.jobId === "string" ? metadata.jobId.trim() : null;
  const step = turnStepFromMessage(message, jobId || null);
  return step ? <CommandStepRow step={step} standalone /> : null;
}

// The row's second line: the site, the tool, the query or the files.
function stepDescription(step: TurnStep): { detail: string | null; mono: boolean } {
  const details = extractMessageDetails(isRecord(step.message.metadata) ? step.message.metadata : null);
  const text = (key: string) => (typeof details?.[key] === "string" ? (details[key] as string).trim() : "");
  switch (step.kind) {
    case "tool": {
      const server = text("server");
      const tool = text("tool");
      const activity = step.activity;
      if (isBrowserToolStep(step)) {
        // A browser step shows the site it was on, or nothing: never the
        // tool's name. A look at the tabs names no page, and a label that
        // names the site already says it.
        const host = activity?.host && activity.step !== "tabs" ? displayActivityHost(activity.host) : null;
        return { detail: host && !step.label.includes(host) ? host : null, mono: false };
      }
      const descriptor = server && tool ? `${server}/${tool}` : server || tool;
      const host = activity?.host ? displayActivityHost(activity.host) : null;
      return { detail: host ?? (descriptor || null), mono: !host };
    }
    case "search":
      return { detail: text("query") || null, mono: false };
    case "edit": {
      const paths = Array.isArray(details?.paths)
        ? (details.paths as unknown[]).filter((path): path is string => typeof path === "string")
        : [];
      return { detail: paths.length > 0 ? paths.join(", ") : null, mono: true };
    }
    default:
      return { detail: null, mono: false };
  }
}

/** Rows that read the same and hold nothing behind them: one row, with how many times. */
function sameRow(a: TurnStep, b: TurnStep): boolean {
  if (a.kind === "command" || a.kind !== b.kind || a.state !== b.state || a.label !== b.label) {
    return false;
  }
  const first = stepDescription(a);
  const second = stepDescription(b);
  return first.detail === second.detail && first.mono === second.mono;
}

function OtherStepRow({ step, times = 1 }: { step: TurnStep; times?: number }) {
  const { detail, mono } = stepDescription(step);
  const icon =
    step.kind === "edit" ? (
      <EditPencil aria-hidden="true" className={ICON_CLASS} />
    ) : (
      renderThreadCompactEventIcon(step.kind === "search" ? "search" : "tool", ICON_CLASS)
    );
  return (
    <div className={ROW_CLASS} data-testid={`turn-activity-${step.kind}`}>
      {icon}
      <StepLabel text={step.label} />
      {detail ? (
        <span
          className={`min-w-0 flex-1 truncate text-slate-500 dark:text-slate-400 ${mono ? "font-mono text-xxs" : ""}`}
          title={detail}
        >
          {detail}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {times > 1 ? (
        <span
          className="flex-none text-xxs tabular-nums text-slate-500 dark:text-slate-400"
          aria-label={`${times} times`}
          data-testid="turn-activity-step-times"
        >
          ×{times}
        </span>
      ) : null}
      <StepStateGlyph state={step.state} />
    </div>
  );
}

/** A browser prompt the person answered, or left: "You allowed a search on visitlisboa.com". */
function ApprovalRow({ text }: { text: string }) {
  return (
    <div className={ROW_CLASS} data-testid="turn-activity-approval">
      <Lock aria-hidden="true" className={ICON_CLASS} />
      <span className="min-w-0 flex-1 truncate text-slate-600 dark:text-slate-300" title={text}>
        {text}
      </span>
    </div>
  );
}

export type TurnActivityDetailsProps = {
  id: string;
  items: readonly DetailItem[];
  /** Octo's notes, reasoning titles and plan updates render as the turn's update rows. */
  renderUpdate: (message: ChatMessage) => ReactNode;
  /** Rendered after the steps (child threads). */
  footer?: ReactNode;
};

/**
 * Everything a turn did, in order: each command with its output collapsed,
 * tool calls, web searches, file edits, and Octo's notes. Builders find all of
 * it here; the turn's default view is only its activity line and reply.
 */
export function TurnActivityDetails({ id, items, renderUpdate, footer }: TurnActivityDetailsProps) {
  const [showAll, setShowAll] = useState(false);
  const hiddenCount = showAll ? 0 : Math.max(0, items.length - TURN_ACTIVITY_DETAILS_ROW_CAP);
  const visible = hiddenCount > 0 ? items.slice(hiddenCount) : items;
  // "Show earlier steps" goes away once pressed: focus moves to the first row
  // it revealed instead of falling back to the page.
  const firstRowRef = useRef<HTMLDivElement | null>(null);
  const focusFirstRow = useRef(false);
  useEffect(() => {
    if (showAll && focusFirstRow.current) {
      focusFirstRow.current = false;
      firstRowRef.current?.focus();
    }
  }, [showAll]);
  // Steps in a row that read the same ("Browsed httpbin.org" nine times) are
  // one row that says how many: "Browsed httpbin.org ×9". A command keeps its
  // own row, since its output is behind it.
  const runs: Array<{ item: DetailItem; times: number }> = [];
  for (const item of visible) {
    const last = runs.at(-1);
    if (last && last.item.kind === "step" && item.kind === "step" && sameRow(last.item.step, item.step)) {
      last.times += 1;
    } else {
      runs.push({ item, times: 1 });
    }
  }
  const rows = runs.flatMap(({ item, times }) => {
    const content =
      item.kind === "update" ? (
        renderUpdate(item.message)
      ) : item.kind === "approval" ? (
        <ApprovalRow text={item.text} />
      ) : item.step.kind === "command" ? (
        <CommandStepRow step={item.step} />
      ) : (
        <OtherStepRow step={item.step} times={times} />
      );
    return content === null || content === undefined || content === false ? [] : [{ id: item.id, content }];
  });
  return (
    <div id={id} data-testid="turn-activity-details" className="min-w-0 py-1">
      {hiddenCount > 0 ? (
        <button
          type="button"
          onClick={() => {
            focusFirstRow.current = true;
            setShowAll(true);
          }}
          data-testid="turn-activity-details-earlier"
          className="mb-1 text-xs text-slate-500 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-100 pointer-coarse:min-h-11"
        >
          Show {hiddenCount} earlier step{hiddenCount === 1 ? "" : "s"}
        </button>
      ) : null}
      <div role="list" aria-label="Steps" className="min-w-0 space-y-0.5">
        {rows.map((row, index) => (
          <div
            role="listitem"
            key={row.id}
            ref={index === 0 ? firstRowRef : undefined}
            tabIndex={index === 0 && showAll ? -1 : undefined}
            className="min-w-0 rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:focus-visible:ring-primary-300/80"
          >
            {row.content}
          </div>
        ))}
      </div>
      {footer}
    </div>
  );
}
