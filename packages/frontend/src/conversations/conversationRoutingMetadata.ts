import { normalizeCustomAgentHandle } from "../assistants/localBuiltInAssistantCatalog";

export interface ConversationRoutingPreferences {
  assistantEnabled: boolean;
  extraAgentHandles: string[];
}

export const DEFAULT_CONVERSATION_ROUTING_PREFERENCES: ConversationRoutingPreferences = Object.freeze({
  assistantEnabled: true,
  extraAgentHandles: [],
});

const CONVERSATION_ROUTING_METADATA_PREFIX = "instafy_conversation_routing_v1_";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getConversationRoutingMetadataKey(userId: string): string {
  return `${CONVERSATION_ROUTING_METADATA_PREFIX}${userId}`;
}

export function normalizeConversationRoutingHandles(
  handles: Iterable<unknown> | null | undefined,
): string[] {
  if (!handles) {
    return [];
  }
  const normalized = new Set<string>();
  for (const handle of handles) {
    if (typeof handle !== "string") {
      continue;
    }
    const candidate = normalizeCustomAgentHandle(handle);
    if (candidate) {
      normalized.add(candidate);
    }
  }
  return Array.from(normalized);
}

function normalizeConversationRoutingPreferencesValue(
  value: unknown,
): ConversationRoutingPreferences | null {
  if (typeof value === "boolean") {
    return {
      assistantEnabled: value,
      extraAgentHandles: [],
    };
  }
  if (!isPlainObject(value)) {
    return null;
  }
  const assistantEnabled =
    typeof value.assistantEnabled === "boolean"
      ? value.assistantEnabled
      : typeof value.enabled === "boolean"
        ? value.enabled
        : null;
  if (assistantEnabled === null) {
    return null;
  }
  const handles = Array.isArray(value.extraAgentHandles)
    ? value.extraAgentHandles
    : Array.isArray(value.agentHandles)
      ? value.agentHandles
      : [];
  return {
    assistantEnabled,
    extraAgentHandles: normalizeConversationRoutingHandles(handles),
  };
}

export function extractConversationRoutingPreferences(
  metadata: Record<string, unknown> | null | undefined,
  userId: string | null | undefined,
): ConversationRoutingPreferences | null {
  if (!metadata || !userId) {
    return null;
  }
  const key = getConversationRoutingMetadataKey(userId);
  return normalizeConversationRoutingPreferencesValue(metadata[key]);
}

export function createConversationRoutingMetadataPatch(
  userId: string | null | undefined,
  preferences: ConversationRoutingPreferences,
  updatedAt: string = new Date().toISOString(),
): Record<string, unknown> {
  if (!userId) {
    return {};
  }
  return {
    [getConversationRoutingMetadataKey(userId)]: {
      assistantEnabled: preferences.assistantEnabled,
      extraAgentHandles: normalizeConversationRoutingHandles(preferences.extraAgentHandles),
      updatedAt,
    },
  };
}
