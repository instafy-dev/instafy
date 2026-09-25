import type { ChatMessage } from "../types";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

export type BrowserRequest = {
  task: string;
  location: "auto" | "device" | "workspace";
};

export function browserRequestFromMessage(message: ChatMessage): BrowserRequest | null {
  if (message.role !== "assistant") return null;
  if (getMessageType(message) !== "action_request") return null;
  const details = extractMessageDetails(message.metadata);
  const value = details?.browserRequest as Record<string, unknown> | undefined;
  if (!value || typeof value.task !== "string" || !value.task.trim() || value.task.length > 8_000) return null;
  if (value.location !== "auto" && value.location !== "device" && value.location !== "workspace") return null;
  return { task: value.task.trim(), location: value.location };
}

export function browserRequestTransport(request: BrowserRequest, current: BrowserTransport): BrowserTransport {
  if (request.location === "device") return "personal";
  if (request.location === "workspace") return "shared";
  return current;
}

export function browserRequestContinuation(request: BrowserRequest): string {
  return `Continue this browser task using the browser attached to this turn. Inspect its current state first, preserve existing session state, and avoid repeating work that is already complete.\n\n${request.task}`;
}
