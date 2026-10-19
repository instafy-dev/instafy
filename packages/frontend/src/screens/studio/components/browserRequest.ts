import { createContext } from "react";
import { isSkillSetupOpener } from "../../../conversations/skillCommands";
import type { ChatMessage } from "../types";
import { extractMessageDetails, getMessageType } from "./chatMessageMetadata";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

export type BrowserRequest = {
  task: string;
  location: "auto" | "device" | "workspace";
  /**
   * False when the runtime that offered the card has no browser of its own
   * (`workspaceBrowser: false`). Older runtimes never say, so a missing value
   * reads as available.
   */
  workspaceBrowser: boolean;
};

/** What this Studio can open for a request_browser card. */
export type BrowserRequestHost = {
  transport: BrowserTransport;
  personalAvailable: boolean;
  /** The Workspace browser is already known not to open for this runtime. */
  sharedUnavailable: boolean;
};

/**
 * Provided by ChatPanel. Without it (thread previews, tests) a card is shown
 * as it always was and the press reports any failure.
 */
export const BrowserRequestHostContext = createContext<BrowserRequestHost | null>(null);

export function browserRequestFromMessage(message: ChatMessage): BrowserRequest | null {
  if (message.role !== "assistant") return null;
  if (getMessageType(message) !== "action_request") return null;
  const details = extractMessageDetails(message.metadata);
  const value = details?.browserRequest as Record<string, unknown> | undefined;
  if (!value || typeof value.task !== "string" || !value.task.trim() || value.task.length > 8_000) return null;
  if (value.location !== "auto" && value.location !== "device" && value.location !== "workspace") return null;
  return { task: value.task.trim(), location: value.location, workspaceBrowser: value.workspaceBrowser !== false };
}

function workspaceBrowserUnavailable(request: BrowserRequest, host: Omit<BrowserRequestHost, "transport">) {
  return !request.workspaceBrowser || host.sharedUnavailable;
}

export function browserRequestTransport(
  request: BrowserRequest,
  current: BrowserTransport,
  host: Omit<BrowserRequestHost, "transport"> | null = null,
): BrowserTransport {
  if (request.location === "device") return "personal";
  if (request.location === "workspace") return "shared";
  // "auto" keeps the selected browser, unless that is the Workspace browser,
  // it cannot open here, and the browser on this device can.
  if (host && current === "shared" && host.personalAvailable && workspaceBrowserUnavailable(request, host)) {
    return "personal";
  }
  return current;
}

/** Why pressing this card cannot open a browser here, or null when it can. */
export function browserRequestUnavailableReason(request: BrowserRequest, host: BrowserRequestHost): string | null {
  const transport = browserRequestTransport(request, host.transport, host);
  if (transport === "personal") {
    return host.personalAvailable ? null : "This uses the browser on your device. Open this chat in the Instafy desktop app to continue.";
  }
  return workspaceBrowserUnavailable(request, host) ? "Instafy's browser is not available in this workspace." : null;
}

const ADDRESS_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;
const LEADING_HOST_PATTERN = /^\s*(?:please\s+)?(?:open|go to|visit)\s+((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63})(?=[/:\s,;)]|\.?$|\.\s)/i;

/**
 * The hosts a card's task will open, as the card shows them before the press:
 * every http(s) address in the task, or else the host a task opens with
 * ("Open app.example.com and ..."). At most three, in order, without repeats.
 */
export function browserRequestDestinations(task: string): string[] {
  const hosts: string[] = [];
  const add = (host: string) => {
    const normalized = host.toLowerCase().replace(/\.$/, "");
    if (normalized && !hosts.includes(normalized)) hosts.push(normalized);
  };
  for (const match of task.matchAll(ADDRESS_PATTERN)) {
    try {
      add(new URL(match[0]).hostname);
    } catch {
      // Not an address after all.
    }
  }
  if (hosts.length === 0) {
    const leading = LEADING_HOST_PATTERN.exec(task);
    if (leading?.[1]) add(leading[1]);
  }
  return hosts.slice(0, 3);
}

/**
 * Whether the card sits in a conversation a person opened with a skill setup
 * (`/skills import ... --start` or `/skills start <name>`). Such a walk ends on
 * the provider's screen and the setup goes on in chat, so the composer returns
 * to chat when the walk is done.
 */
export function browserRequestInSkillSetup(messages: ChatMessage[], messageId: string): boolean {
  const index = messages.findIndex((message) => message.id === messageId);
  return index > 0 && messages
    .slice(0, index)
    .some((message) => message.role === "user" && typeof message.content === "string" && isSkillSetupOpener(message.content));
}

export function browserRequestContinuation(request: Omit<BrowserRequest, "workspaceBrowser">): string {
  return `Continue this browser task using the browser attached to this turn. Inspect its current state first, preserve existing session state, and avoid repeating work that is already complete.\n\n${request.task}`;
}
