import type { ProviderEventLogEntry } from "./providerEventLog";
import { formatProviderEventSummaryLine } from "./providerEventPresentation";

export function formatProviderEventReactionLabel(
  reaction: ProviderEventLogEntry["reaction"],
) {
  switch (reaction) {
    case "surface_in_conversation":
      return "Surface in chat";
    case "candidate_agent_trigger":
      return "Trigger candidate";
    case "record_only":
    default:
      return "Recorded only";
  }
}

export function formatProviderEventLogEntrySummary(entry: ProviderEventLogEntry) {
  return (
    formatProviderEventSummaryLine([entry.latestEvent], { includeRecordOnly: true }) ??
    entry.latestEvent.kind
  );
}
