import type { ProviderEventLogEntry } from "./providerEventLog";
import { getProviderEventConfig } from "./providerEventConfig";

export type SelectProviderTriggerCandidatesOptions = {
  maxEntries?: number;
};

export type ProviderTriggerCandidate = ProviderEventLogEntry;

export function selectProviderTriggerCandidates(
  entries: ProviderEventLogEntry[],
  options?: SelectProviderTriggerCandidatesOptions,
): ProviderTriggerCandidate[] {
  const config = getProviderEventConfig();
  const maxEntries = Math.max(
    1,
    Math.floor(options?.maxEntries ?? config.triggerMaxEntries),
  );
  return entries
    .filter((entry) => entry.reaction === "candidate_agent_trigger")
    .slice(0, maxEntries);
}
