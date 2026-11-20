import type { SubmitConversationRuntimeOverride } from "../../../conversations/useConversation";
import type { BrowserSessionPageTarget } from "./browserSessionPages";

export type ChatMessageStashEnvelope = {
  targetAgentHandles: string[];
  browserPageTarget: BrowserSessionPageTarget | null;
  browserLaunchMode: "new_page" | null;
  metadata: Record<string, unknown> | null;
  runtimeOverride: SubmitConversationRuntimeOverride | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readNullableRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

export function normalizeChatMessageStashEnvelope(
  value: unknown,
): ChatMessageStashEnvelope {
  const record = isRecord(value) ? value : {};
  const targetAgentHandles = Array.isArray(record.targetAgentHandles)
    ? record.targetAgentHandles
        .filter((handle): handle is string => typeof handle === "string")
        .map((handle) => handle.trim().replace(/^@+/, "").toLowerCase())
        .filter((handle, index, all) => handle.length > 0 && all.indexOf(handle) === index)
    : [];
  const browserTargetRecord = readNullableRecord(record.browserPageTarget);
  const browserPageTarget: BrowserSessionPageTarget | null =
    browserTargetRecord &&
    ["id", "url", "host", "label"].every(
      (key) => typeof browserTargetRecord[key] === "string",
    )
      ? {
          id: browserTargetRecord.id as string,
          url: browserTargetRecord.url as string,
          host: browserTargetRecord.host as string,
          label: browserTargetRecord.label as string,
        }
      : null;
  const runtimeRecord = readNullableRecord(record.runtimeOverride);
  const runtimeId =
    runtimeRecord && typeof runtimeRecord.runtimeId === "string"
      ? runtimeRecord.runtimeId.trim()
      : "";
  const runtimeOverride: SubmitConversationRuntimeOverride | null = runtimeId
    ? {
        runtimeId,
        runtimeDisplayName:
          typeof runtimeRecord?.runtimeDisplayName === "string"
            ? runtimeRecord.runtimeDisplayName
            : null,
        preferRuntime:
          typeof runtimeRecord?.preferRuntime === "boolean"
            ? runtimeRecord.preferRuntime
            : null,
      }
    : null;
  return {
    targetAgentHandles,
    browserPageTarget,
    browserLaunchMode: record.browserLaunchMode === "new_page" ? "new_page" : null,
    metadata: readNullableRecord(record.metadata),
    runtimeOverride,
  };
}
