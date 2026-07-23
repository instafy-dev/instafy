import type { ProviderEventEnvelope } from "@instafy/provider-contract";
import { resolveProviderEventHostReaction, type ProviderEventHostReaction } from "./providerEventPolicy";
import {
  collectProviderEventEnvelopes,
  serializeProviderEventIdentity,
} from "./providerEvents";
import { getProviderEventConfig } from "./providerEventConfig";

export type ProviderEventLogEntry = {
  key: string;
  reaction: ProviderEventHostReaction;
  count: number;
  firstTimestampNs: number;
  lastTimestampNs: number;
  latestEvent: ProviderEventEnvelope<Record<string, unknown>>;
};

export type AppendProviderEventLogOptions = {
  maxEntries?: number;
  coalesceWindowMs?: number;
};

function getTimestampNs(event: ProviderEventEnvelope<Record<string, unknown>>) {
  return typeof event.timestampNs === "number" && Number.isFinite(event.timestampNs)
    ? Math.max(0, Math.floor(event.timestampNs))
    : Date.now() * 1_000_000;
}

function readPayloadString(payload: Record<string, unknown> | null, key: string) {
  const value = payload?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim().toLowerCase() : "";
}

function buildProviderEventCoalescingKey(
  event: ProviderEventEnvelope<Record<string, unknown>>,
  reaction: ProviderEventHostReaction,
) {
  const payload =
    typeof event.payload === "object" && event.payload !== null && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;

  return [
    event.kind.trim().toLowerCase(),
    event.providerId?.trim().toLowerCase() ?? "",
    event.providerType?.trim().toLowerCase() ?? "",
    reaction,
    readPayloadString(payload, "mode"),
    readPayloadString(payload, "lens"),
    readPayloadString(payload, "label"),
    readPayloadString(payload, "category"),
    readPayloadString(payload, "actionId"),
  ].join("|");
}

export function appendProviderEventLog(
  existing: ProviderEventLogEntry[],
  values: unknown,
  options?: AppendProviderEventLogOptions,
): ProviderEventLogEntry[] {
  const config = getProviderEventConfig();
  const maxEntries = Math.max(1, Math.floor(options?.maxEntries ?? config.logMaxEntries));
  const coalesceWindowNs =
    Math.max(0, Math.floor(options?.coalesceWindowMs ?? config.coalesceWindowMs)) * 1_000_000;
  const next = [...existing];

  for (const event of collectProviderEventEnvelopes(values)) {
    const reaction = resolveProviderEventHostReaction(event);
    const timestampNs = getTimestampNs(event);
    const key = buildProviderEventCoalescingKey(event, reaction);
    const latestEntry = next[0];
    const identity = serializeProviderEventIdentity(event);

    if (
      latestEntry &&
      serializeProviderEventIdentity(latestEntry.latestEvent as Record<string, unknown>) === identity
    ) {
      continue;
    }

    if (
      latestEntry &&
      latestEntry.key === key &&
      timestampNs - latestEntry.lastTimestampNs <= coalesceWindowNs
    ) {
      next[0] = {
        ...latestEntry,
        count: latestEntry.count + 1,
        lastTimestampNs: timestampNs,
        latestEvent: event,
      };
      continue;
    }

    next.unshift({
      key,
      reaction,
      count: 1,
      firstTimestampNs: timestampNs,
      lastTimestampNs: timestampNs,
      latestEvent: event,
    });
  }

  return next.slice(0, maxEntries);
}
