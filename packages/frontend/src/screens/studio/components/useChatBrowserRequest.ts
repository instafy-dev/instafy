import { useEffect, useRef } from "react";
import type { ChatMessage } from "../types";
import { browserRequestContinuation, browserRequestFromMessage, browserRequestTransport } from "./browserRequest";
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
  activate: (transport: BrowserTransport) => void;
  continueTask: (transport: BrowserTransport, message: string) => Promise<boolean>;
  onError: (message: string) => void;
};

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

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ messageId?: string; completion?: Promise<unknown> }>).detail;
      const captured = latest.current;
      const message = captured.messages.find((entry) => entry.id === detail?.messageId);
      const request = message && browserRequestFromMessage(message);
      if (!request || !detail) return;
      const epoch = generation.current;
      detail.completion = (async () => {
        if (pending.current) throw new Error("A browser task is already opening.");
        if (!captured.canWrite || !captured.ready) throw new Error("Wait for this conversation and browser selection to be ready.");
        const transport = browserRequestTransport(request, captured.transport);
        if (transport === "personal" && !captured.personalAvailable) {
          throw new Error("This task uses the browser on this device. Open it in the Instafy desktop app or choose Workspace explicitly.");
        }
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
}
