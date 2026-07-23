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
}: {
  client: SharedBrowserCollaborationClientState;
  compact: boolean;
  localControlOwner: SharedBrowserControlOwner;
  onGrantControl: (participantId: string) => void;
  onReleaseControl: () => void;
  onRequestControl: () => void;
  onTakeControl: () => void;
}) {
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
    | { label: string; compactLabel: string; kind: string; disabled: boolean; run: () => void }
    | null = null;
  if (!agentDisplayName && self?.canControl && state) {
    if (selfOwnsControl && firstRequester) {
      action = {
        label: `Give control to ${firstRequester.displayName}`,
        compactLabel: `Give ${firstRequester.displayName}`,
        kind: "grant",
        disabled: false,
        run: () => onGrantControl(firstRequester.id),
      };
    } else if (selfOwnsControl) {
      action = {
        label: "Release control",
        compactLabel: "Release",
        kind: "release",
        disabled: false,
        run: onReleaseControl,
      };
    } else if (serverOwner === null) {
      action = {
        label: "Take control",
        compactLabel: "Take",
        kind: "take",
        disabled: false,
        run: onTakeControl,
      };
    } else if (serverOwner.kind === "human") {
      action = {
        label: requestPending ? "Control requested" : "Request control",
        compactLabel: requestPending
          ? "Requested"
          : `Ask ${humanOwner?.displayName ?? "teammate"}`,
        kind: "request",
        disabled: requestPending,
        run: onRequestControl,
      };
    }
  }

  const visibleParticipants = participants.slice(0, compact ? 1 : 3);
  const participantNames = participants.map((participant) => participant.displayName).join(", ");

  return (
    <div
      aria-label="Shared browser collaboration"
      className="flex min-w-0 items-center gap-1 max-[540px]:flex-1 max-[540px]:justify-end max-[540px]:gap-1"
      data-testid="shared-browser-collaboration"
      role="group"
    >
      {participants.length > 0 ? (
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
                className={`inline-flex items-center justify-center rounded-full border-2 border-slate-50 text-[9px] font-semibold text-white shadow-sm dark:border-slate-900 ${
                  compact ? "h-5 w-5" : "h-6 w-6"
                } ${
                  ownsControl ? "ring-2 ring-primary-400/70" : ""
                }`}
                key={participant.id}
                style={{ backgroundColor: participant.color }}
                title={participant.displayName}
              >
                {participantInitials(participant.displayName)}
              </span>
            );
          })}
          {participants.length > visibleParticipants.length ? (
            <span
              aria-hidden="true"
              className={`inline-flex items-center justify-center rounded-full border-2 border-slate-50 bg-slate-600 px-1 text-[9px] font-semibold text-white shadow-sm dark:border-slate-900 ${compact ? "h-5 min-w-5" : "h-6 min-w-6"}`}
            >
              +{participants.length - visibleParticipants.length}
            </span>
          ) : null}
        </span>
      ) : null}
      <span
        className={`inline-flex h-7 min-w-0 items-center rounded-full border font-medium ${
          compact ? "max-w-24 px-1.5 text-[10px]" : "px-2 text-xxs"
        } ${
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
        <span className={`${compact ? "max-w-20" : "max-w-28"} truncate`}>{statusLabel}</span>
      </span>
      {action ? (
        <button
          aria-label={action.label}
          className={`inline-flex max-w-28 shrink-0 touch-manipulation items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-full border border-primary-500/30 bg-primary-500/10 px-2 text-xxs font-semibold text-primary-700 transition hover:bg-primary-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 disabled:cursor-default disabled:opacity-60 dark:text-primary-300 ${compact ? "h-10" : "h-7 pointer-coarse:min-h-11"}`}
          data-action={action.kind}
          data-testid="shared-browser-collaboration-control-action"
          disabled={action.disabled}
          onClick={action.run}
          title={action.label}
          type="button"
        >
          {compact ? action.compactLabel : action.label}
        </button>
      ) : null}
    </div>
  );
}
