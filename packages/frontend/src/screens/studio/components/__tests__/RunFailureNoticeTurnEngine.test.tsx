// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveRunFailurePresentation,
  type RunFailurePresentation,
  type TurnEngineTurnOwner,
} from "../../../../conversations/runFailurePresentation";
import type { ControllerRuntimeStatusEntry } from "../../../../services/runtimeController/runtimes";
import type { ChatMessage } from "../../types";
import {
  RunFailureMessageBody,
  RunFailureRetryProvider,
  type RunFailureRetryContextValue,
} from "../RunFailureNotice";

const runtimeState = vi.hoisted(() => ({ runtimeStatuses: [] as ControllerRuntimeStatusEntry[] }));

vi.mock("../../../../runtime/RuntimeStateProvider", async () => ({
  ...(await vi.importActual<typeof import("../../../../runtime/RuntimeStateProvider")>(
    "../../../../runtime/RuntimeStateProvider",
  )),
  useOptionalRuntimeState: () => runtimeState,
}));

const RAW = "claude: Invalid API key · Please run /login";
const SENDER_SENTENCE =
  "Claude Code isn't signed in on this computer. Open a terminal, run claude and sign in, then send your message again.";

// A failed Claude Code turn as the controller records it (docs/Local-Engine-Turns.md 2.6).
const FAILURE: ChatMessage = {
  id: "failure-lane",
  role: "assistant",
  authorId: null,
  content: RAW,
  timestamp: 2,
  files: null,
  messageType: "error",
  metadata: {
    source: "agent",
    outcome: "failed",
    messageType: "error",
    jobId: "job-lane",
    aiAccessMode: "claude-code",
    claudeCode: { version: 1 },
    claudeCodeFailure: "not_signed_in",
    runtimePreference: { runtimeId: "runtime-mac", source: "conversation" },
  },
};

function presentation(): RunFailurePresentation {
  const resolved = resolveRunFailurePresentation({ metadata: FAILURE.metadata, content: FAILURE.content, assumeFailed: true });
  if (!resolved) {
    throw new Error("expected a failure presentation");
  }
  return resolved;
}

function context(owner: TurnEngineTurnOwner | null, overrides: Partial<RunFailureRetryContextValue> = {}) {
  return {
    pendingRetryKey: null,
    requestRetry: vi.fn(),
    autoRetryingKey: null,
    isRetrySuperseded: () => false,
    onConnectAi: vi.fn(),
    turnEngineOwnerOf: () => owner,
    ...overrides,
  } satisfies RunFailureRetryContextValue;
}

describe("the failure card of a turn-engine turn", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    runtimeState.runtimeStatuses = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(value: RunFailureRetryContextValue | null) {
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={value}>
          <RunFailureMessageBody message={FAILURE} presentation={presentation()} />
        </RunFailureRetryProvider>,
      );
    });
  }

  const query = (testId: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  const sentence = () => container.querySelector('[data-testid="run-failure-body"] p')?.textContent ?? "";

  it("gives its sender the code's sentence and no Try again, Manage AI or Connect AI", async () => {
    await render(context({ isViewer: true, name: "Ada" }));
    expect(sentence()).toBe(SENDER_SENTENCE);
    expect(query("run-failure-retry")).toBeNull();
    expect(query("run-failure-retried")).toBeNull();
    expect(query("run-failure-manage-ai")).toBeNull();
    expect(query("run-failure-connect-ai")).toBeNull();
    // Without a way back to the composer, the sender has nothing to press but Details.
    expect(query("run-failure-turn-engine-resend")).toBeNull();
    await act(async () => {
      query("run-failure-details-toggle")?.click();
    });
    expect(query("run-failure-details")?.textContent).toBe(RAW);
  });

  it("puts the sender's message back with the engine chosen, and sends nothing itself", async () => {
    const resendWithTurnEngine = vi.fn();
    const requestRetry = vi.fn();
    await render(context({ isViewer: true, name: null }, { resendWithTurnEngine, requestRetry }));
    const resend = query("run-failure-turn-engine-resend");
    expect(resend?.textContent).toBe("Send again with Claude Code");
    await act(async () => {
      resend?.click();
    });
    expect(resendWithTurnEngine).toHaveBeenCalledExactlyOnceWith(FAILURE);
    expect(requestRetry).not.toHaveBeenCalled();
  });

  it("adds what the sender's own runtime says about the version", async () => {
    runtimeState.runtimeStatuses = [
      {
        runtimeId: "runtime-mac",
        claudeCode: { ready: true, reason: null, cli: "2.3.0", verified: false, planSignIn: true },
      } as ControllerRuntimeStatusEntry,
    ];
    await render(context({ isViewer: true, name: null }));
    expect(sentence()).toBe(
      `${SENDER_SENTENCE} If you're signed in, this newer Claude Code may no longer let other apps use your sign-in.`,
    );
  });

  it("tells a teammate only that it couldn't finish, with no Try again and no way to send it as theirs", async () => {
    const resendWithTurnEngine = vi.fn();
    await render(context({ isViewer: false, name: "Ada" }, { resendWithTurnEngine }));
    expect(sentence()).toBe("Claude Code couldn't finish this turn on Ada's computer.");
    expect(query("run-failure-retry")).toBeNull();
    expect(query("run-failure-turn-engine-resend")).toBeNull();
    // The sender's wording stays theirs; Details still has the raw text.
    expect(container.textContent).not.toContain("Open a terminal");
  });

  it("words it for everyone else when the chat cannot tell who sent it", async () => {
    await render(context(null));
    expect(sentence()).toBe("Claude Code couldn't finish this turn on the sender's computer.");
    expect(query("run-failure-retry")).toBeNull();
    await render(null);
    expect(sentence()).toBe("Claude Code couldn't finish this turn on the sender's computer.");
    expect(query("run-failure-retry")).toBeNull();
  });
});
