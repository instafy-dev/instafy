import { useEffect, useRef } from "react";
import type { ChatMessage } from "../types";
import {
  browserRequestContinuation,
  browserRequestFromMessage,
  browserRequestInSkillSetup,
  browserRequestTransport,
  browserRequestUnavailableReason,
} from "./browserRequest";
import type { BrowserTransport } from "./usePersonalBrowserBridge";

type Options = {
  identity: string;
  messages: ChatMessage[];
  canWrite: boolean;
  ready: boolean;
  transport: BrowserTransport;
  open: boolean;
  busy: boolean;
  personalAvailable: boolean;
  personalReady: boolean;
  sharedReady: boolean;
  /** The Workspace browser is already known not to open for this runtime. */
  sharedUnavailable: boolean;
  activate: (transport: BrowserTransport) => void;
  continueTask: (transport: BrowserTransport, message: string) => Promise<boolean>;
  /** Puts the composer back in chat. Called once a skill setup's walk has finished. */
  returnToChat: () => void;
  onError: (message: string) => void;
};

/** A walk this hook sent, until its run has been seen to start and finish. */
type Walk = { epoch: number; transport: BrowserTransport; started: boolean };

/** A walk whose run is not seen starting within this window is not followed. */
const WALK_START_WINDOW_MS = 30_000;

// The model requests a handoff through the same structured action mechanism as
// other Studio capabilities. Only a click on that message starts the browser and
// grants native agent control; rendering old history never replays a task.
export function useChatBrowserRequest(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const generation = useRef(0);
  const previousIdentity = useRef(options.identity);
  if (previousIdentity.current !== options.identity) {
    previousIdentity.current = options.identity;
    generation.current += 1;
  }
  const pending = useRef(false);
  const walk = useRef<Walk | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: string; completion?: Promise<unknown> }>).detail;
      const captured = latest.current;
      const message = captured.messages.find((entry) => entry.id === detail?.messageId);
      const request = message && browserRequestFromMessage(message);
      if (!message || !request || !detail) return;
      const messageId = message.id;
      const epoch = generation.current;
      detail.completion = (async () => {
        if (pending.current) throw new Error("A browser task is already opening.");
        if (!captured.canWrite || !captured.ready) throw new Error("Wait for this conversation and browser selection to be ready.");
        const host = {
          transport: captured.transport,
          personalAvailable: captured.personalAvailable,
          sharedUnavailable: captured.sharedUnavailable,
        };
        const unavailable = browserRequestUnavailableReason(request, host);
        if (unavailable) throw new Error(unavailable);
        const transport = browserRequestTransport(request, captured.transport, host);
        pending.current = true;
        try {
          captured.activate(transport);
          const deadline = Date.now() + 60_000;
          let activated = false;
          // Let React commit the chosen surface before considering a cached
          // ready runtime. Identity, closure and explicit location changes cancel
          // the handoff instead of sending it to a different browser.
          await new Promise((resolve) => window.setTimeout(resolve, 0));
          for (;;) {
            const current = latest.current;
            if (generation.current !== epoch || !current.canWrite ||
                (activated && (!current.open || current.transport !== transport))) {
              throw new Error("The browser or conversation changed before this task could continue.");
            }
            activated ||= current.open && current.transport === transport;
            if (activated && !current.busy && (transport === "personal" ? current.personalReady : current.sharedReady)) {
              const sent = await current.continueTask(transport, browserRequestContinuation(request));
              if (!sent) throw new Error("The browser task was not sent. You can retry from its message.");
              // A skill setup's walk ends on the provider's screen and the
              // setup goes on in chat: the person's next reply is an answer to
              // the setup, not another browser task (which would run without
              // the workspace's values and start from a page snapshot).
              if (browserRequestInSkillSetup(current.messages, messageId)) {
                const sentWalk: Walk = { epoch, transport, started: latest.current.busy };
                walk.current = sentWalk;
                window.setTimeout(() => {
                  if (walk.current === sentWalk && !sentWalk.started) walk.current = null;
                }, WALK_START_WINDOW_MS);
              }
              return;
            }
            if (Date.now() >= deadline) throw new Error("The browser is not ready yet. Finish opening it, then retry from the message.");
            await new Promise((resolve) => window.setTimeout(resolve, 100));
          }
        } finally {
          pending.current = false;
        }
      })().catch((error: unknown) => {
        if (generation.current === epoch) latest.current.onError(error instanceof Error ? error.message : "Unable to continue in the browser.");
        throw error;
      });
    };
    window.addEventListener("instafy:request-browser", handler);
    return () => {
      generation.current += 1;
      window.removeEventListener("instafy:request-browser", handler);
    };
  }, []);

  // The walk's run shows as busy while it works. Once it is seen to finish, a
  // still-open browser on the same transport hands the composer back to chat.
  useEffect(() => {
    const sentWalk = walk.current;
    if (!sentWalk) return;
    if (generation.current !== sentWalk.epoch) {
      walk.current = null;
      return;
    }
    if (options.busy) {
      sentWalk.started = true;
      return;
    }
    if (!sentWalk.started) return;
    walk.current = null;
    const current = latest.current;
    if (current.open && current.transport === sentWalk.transport) current.returnToChat();
  }, [options.busy, options.identity]);
}
