import {
  withRuntimeExpectations,
} from "../../../conversations/conversationRuntimeExpectations";
import type { SubmitConversationRuntimeOverride } from "../../../conversations/useConversation";
import type { BrowserSessionPageTarget } from "./browserSessionPages";

export const SHARED_BROWSER_CONSENT_VERSION = 1;

export type SharedBrowserSubmitRouting =
  | { kind: "standard"; runtimeOverride: null }
  | { kind: "blocked"; runtimeOverride: null }
  | { kind: "shared"; runtimeOverride: SubmitConversationRuntimeOverride };

export function withBrowserRuntimeExpectations(
  metadata: Record<string, unknown>,
  options: { commandExecution?: boolean } = {},
): Record<string, unknown> {
  return withRuntimeExpectations(metadata, {
    workspaceFileChanges: false,
    commandExecution: options.commandExecution ?? true,
    browserExecution: true,
  });
}

export function withPersonalBrowserRuntimeExpectations(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return withBrowserRuntimeExpectations(metadata, { commandExecution: false });
}

export function resolveSharedBrowserSubmitRouting(input: {
  active: boolean;
  messageRequiresAi: boolean;
  resolvedRuntimeId: string | null;
  terminalRequest: unknown;
}): SharedBrowserSubmitRouting {
  if (!input.active || !input.messageRequiresAi || input.terminalRequest) {
    return { kind: "standard", runtimeOverride: null };
  }

  const runtimeId = input.resolvedRuntimeId?.trim() ?? "";
  if (!runtimeId) {
    return { kind: "blocked", runtimeOverride: null };
  }

  return {
    kind: "shared",
    runtimeOverride: {
      runtimeId,
      runtimeDisplayName: null,
      // Shared Browser work must stay on the runtime that owns the visible
      // page. Treat it as an exact preference so dispatch cannot silently
      // move the job to another hosted runtime.
      preferRuntime: true,
    },
  };
}

export function buildSharedBrowserSubmitMetadata(input: {
  baseMetadata: Record<string, unknown> | null;
  browserPageTarget: BrowserSessionPageTarget | null;
  runtimeId: string;
}): Record<string, unknown> {
  const pageTarget = input.browserPageTarget;
  const metadata = {
    ...(input.baseMetadata ?? {}),
    browserTransport: "shared",
    browserConsentVersion: SHARED_BROWSER_CONSENT_VERSION,
    browserRuntimeId: input.runtimeId,
    ...(pageTarget
      ? {
          browserPageId: pageTarget.id,
          browserPageUrl: pageTarget.url,
          browserPageHost: pageTarget.host,
          browserPageLabel: pageTarget.label,
        }
      : {}),
  };

  return withBrowserRuntimeExpectations(metadata, { commandExecution: false });
}
