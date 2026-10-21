import { useRef, type ReactNode } from "react";
import { CursorPointer, Group } from "iconoir-react";
import { Dialog, DialogTrigger } from "react-aria-components";
import { StudioPopover } from "../../../components/aria/StudioPopover";
import { Button } from "../../../components/Button";
import { Text } from "../../../components/Text";
import type { SharedBrowserControlOwner } from "./sharedBrowserControlOwner";
import {
  collaborationSelfOwnsControl,
  collaborationSelfParticipant,
  type SharedBrowserCollaborationClientState,
  type SharedBrowserCollaborationParticipant,
} from "./sharedBrowserCollaboration";

function participantInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
  }
  return (parts[0] ?? "?").slice(0, 2).toUpperCase();
}

function participantById(
  participants: SharedBrowserCollaborationParticipant[],
  participantId: string | null | undefined,
): SharedBrowserCollaborationParticipant | null {
  if (!participantId) {
    return null;
  }
  return participants.find((participant) => participant.id === participantId) ?? null;
}

export function SharedBrowserCollaborationControls({
  client,
  compact,
  localControlOwner,
  onGrantControl,
  onReleaseControl,
  onRequestControl,
  onTakeControl,
  children,
}: {
  client: SharedBrowserCollaborationClientState;
  compact: boolean;
  localControlOwner: SharedBrowserControlOwner;
  onGrantControl: (participantId: string) => void;
  onReleaseControl: () => void;
  onRequestControl: () => void;
  onTakeControl: () => void;
  children?: ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const state = client.state;
  const participants = state?.participants ?? [];
  const self = collaborationSelfParticipant(client);
  const selfOwnsControl = collaborationSelfOwnsControl(client);
  const serverOwner = state?.controlOwner ?? null;
  const agentDisplayName =
    serverOwner?.kind === "agent"
      ? serverOwner.displayName
      : localControlOwner.kind === "agent"
        ? localControlOwner.displayName
        : null;
  const humanOwner =
    serverOwner?.kind === "human"
      ? participantById(participants, serverOwner.participantId)
      : null;
  const firstRequester =
    selfOwnsControl && state?.requests.length
      ? participantById(participants, state.requests[0])
      : null;
  const requestPending = Boolean(
    client.participantId && state?.requests.includes(client.participantId),
  );

  let statusLabel = "Control syncing…";
  if (agentDisplayName) {
    statusLabel = `${agentDisplayName} controls`;
  } else if (selfOwnsControl) {
    statusLabel = "You control";
  } else if (serverOwner?.kind === "human") {
    statusLabel = `${humanOwner?.displayName ?? "Teammate"} controls`;
  } else if (state) {
    statusLabel = "Control available";
  }

  let action:
    | { label: string; kind: string; disabled: boolean; run: () => void }
    | null = null;
  if (!agentDisplayName && self?.canControl && state) {
    if (selfOwnsControl && firstRequester) {
      action = {
        label: `Give control to ${firstRequester.displayName}`,
        kind: "grant",
        disabled: false,
        run: () => onGrantControl(firstRequester.id),
      };
    } else if (selfOwnsControl) {
      action = {
        label: "Release control",
        kind: "release",
        disabled: false,
        run: onReleaseControl,
      };
    } else if (serverOwner === null) {
      action = {
        label: "Take control",
        kind: "take",
        disabled: false,
        run: onTakeControl,
      };
    } else if (serverOwner.kind === "human") {
      action = {
        label: requestPending ? "Control requested" : "Request control",
        kind: "request",
        disabled: requestPending,
        run: onRequestControl,
      };
    }
  }

  const visibleParticipants = participants.slice(0, compact ? 1 : 3);
  const participantNames = participants.map((participant) => participant.displayName).join(", ");

  const pendingRequestCount = selfOwnsControl ? state?.requests.length ?? 0 : 0;
  const requestLabel = pendingRequestCount
    ? `${pendingRequestCount} pending control ${pendingRequestCount === 1 ? "request" : "requests"}`
    : requestPending ? "Control requested" : null;
  const participantAvatars = participants.length > 0 ? (
    <span
      aria-label={`In Shared Browser: ${participantNames}`}
      className="flex shrink-0 items-center -space-x-1.5"
      data-testid="shared-browser-participants"
      role="group"
      title={participantNames}
    >
      {visibleParticipants.map((participant) => {
        const ownsControl =
          serverOwner?.kind === "human" && serverOwner.participantId === participant.id;
        return (
          <span
            aria-hidden="true"
            className={`inline-flex items-center justify-center rounded-full border-2 border-slate-50 text-[9px] font-semibold text-white dark:border-slate-900 ${
              compact ? "h-5 w-5" : "h-6 w-6"
            } ${ownsControl ? "ring-2 ring-primary-400/70" : ""}`}
            key={participant.id}
            style={{ backgroundColor: participant.color }}
          >
            {participantInitials(participant.displayName)}
          </span>
        );
      })}
      {participants.length > visibleParticipants.length ? (
        <span
          aria-hidden="true"
          className={`inline-flex items-center justify-center rounded-full border-2 border-slate-50 bg-slate-600 px-1 text-[9px] font-semibold text-white dark:border-slate-900 ${compact ? "h-5 min-w-5" : "h-6 min-w-6"}`}
        >
          +{participants.length - visibleParticipants.length}
        </span>
      ) : null}
    </span>
  ) : null;
  const hasListedController = Boolean(agentDisplayName || humanOwner);
  const controlIndicator = (
    <Text as="span" variant="caption" tone="muted" role="img" aria-label={statusLabel} title={statusLabel}
      className="inline-flex shrink-0 items-center gap-1"
      data-testid="shared-browser-controller-indicator">
      <CursorPointer aria-hidden="true" className="h-3.5 w-3.5" />
      Controls
    </Text>
  );
  const ownershipStatus = compact ? (
    <Text
      as="span"
      variant="caption"
      tone="muted"
      className={hasListedController ? "sr-only" : "block"}
      data-testid="shared-browser-collaboration-control-state"
      role="status"
      title={statusLabel}
    >
      {statusLabel}
    </Text>
  ) : (
    <span
      className={`inline-flex h-7 min-w-0 items-center rounded-full border px-2 text-xxs font-medium ${
        selfOwnsControl
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : agentDisplayName
            ? "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300"
            : "border-slate-300/80 bg-slate-100/80 text-slate-600 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-300"
      }`}
      data-testid="shared-browser-collaboration-control-state"
      role="status"
      title={statusLabel}
    >
      <span className="max-w-28 truncate">{statusLabel}</span>
    </span>
  );
  const controlAction = action ? (
    <Button
      aria-label={action.label}
      preset="inline"
      variant="secondary"
      className={compact ? "max-w-full whitespace-normal text-left" : "max-w-36 shrink-0"}
      data-action={action.kind}
      data-testid="shared-browser-collaboration-control-action"
      isDisabled={action.disabled}
      onPress={() => {
        // Requesting disables the action; granting moves it out of this row.
        // Keep focus inside the popup before either change removes button focus.
        if (compact && (action.kind === "request" || action.kind === "grant")) dialogRef.current?.focus();
        action.run();
      }}
      title={action.label}
      type="button"
    >
      <span className={compact ? "break-words" : "truncate"}>{compact && action.kind === "grant" ? "Give control" : action.label}</span>
    </Button>
  ) : null;
  // In the popup, associate the short grant action with its complete recipient
  // name. Other controls remain in the footer; the wide toolbar keeps its label.
  const grantInParticipantRow = compact && action?.kind === "grant";
  const footerAction = grantInParticipantRow ? null : controlAction;

  return (
    <div
      aria-label="Shared browser collaboration"
      className="flex min-w-0 shrink-0 items-center gap-2"
      data-browser-session-safe-zone="true"
      data-testid="shared-browser-collaboration"
      role="group"
    >
      {compact ? (
        <DialogTrigger>
          <Button
            aria-label={`Browser participants and control: ${statusLabel}. ${participantNames || "No participants connected"}${requestLabel ? `. ${requestLabel}` : ""}`}
            className="relative shrink-0"
            data-testid="shared-browser-collaboration-toggle"
            preset="toolbar"
            title={`Browser participants and control — ${statusLabel}`}
            variant="ghost"
          >
            {participantAvatars ?? <Group aria-hidden="true" className="h-4 w-4" />}
            {pendingRequestCount ? (
              <span
                aria-hidden="true"
                className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[9px] font-semibold text-slate-950"
                data-testid="shared-browser-control-requests"
              >
                {pendingRequestCount}
              </span>
            ) : null}
          </Button>
          <StudioPopover
            placement="bottom end"
            offset={6}
            className="w-72 max-w-[calc(100vw-1.5rem)] p-3"
            data-browser-session-safe-zone="true"
          >
            <Dialog ref={dialogRef} aria-label="Browser participants and control" className="outline-none">
              {pendingRequestCount ? (
                <Text variant="caption" tone="muted" className="mb-3">{requestLabel}</Text>
              ) : null}
              {participants.length || agentDisplayName ? (
                <ul aria-label="Browser participants" className="space-y-3">
                  {participants.map((participant) => (
                    <li className="flex min-w-0 items-start gap-2" key={participant.id} data-participant-id={participant.id}>
                      <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: participant.color }} />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-baseline gap-2">
                          <Text as="span" variant="bodyCompact" tone="primary" className="min-w-0 flex-1 break-words" data-participant-name="">
                            {participant.displayName}
                            {participant.id === client.participantId ? <Text as="span" variant="caption" tone="muted"> (you)</Text> : null}
                          </Text>
                          {!agentDisplayName && humanOwner?.id === participant.id ? controlIndicator : null}
                        </div>
                        {state?.requests.includes(participant.id) ? (
                          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
                            <Text as="span" variant="caption" tone="muted">Requested</Text>
                            {grantInParticipantRow && firstRequester?.id === participant.id ? controlAction : null}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                  {agentDisplayName ? (
                    <li className="flex min-w-0 items-baseline gap-2" data-controller-kind="agent">
                      <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-violet-500" />
                      <Text as="span" variant="bodyCompact" tone="primary" className="min-w-0 flex-1 break-words" data-participant-name="">{agentDisplayName}</Text>
                      {controlIndicator}
                    </li>
                  ) : null}
                </ul>
              ) : null}
              <div className={hasListedController || !participants.length ? undefined : "mt-3"}>{ownershipStatus}</div>
              {footerAction || children ? (
                <div className={`space-y-2 ${participants.length || agentDisplayName ? "mt-3 border-t border-slate-200 pt-3 dark:border-slate-700" : "mt-2"}`}>
                  <div className="flex flex-wrap justify-end gap-2">
                    {footerAction}
                    {children}
                  </div>
                </div>
              ) : null}
            </Dialog>
          </StudioPopover>
          <span className="sr-only" role="status">{statusLabel}{requestLabel ? `. ${requestLabel}` : ""}</span>
        </DialogTrigger>
      ) : (
        <>
          {children}
          {participantAvatars}
          {ownershipStatus}
          {controlAction}
        </>
      )}
    </div>
  );
}
