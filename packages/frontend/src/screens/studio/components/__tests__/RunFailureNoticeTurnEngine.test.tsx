// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Registers the application's turn engines, as the application does when it
// builds its feature composition at startup (features/turnEngineRegistry.ts).
import "../../../../features/applicationFrontendFeatureComposition";
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

function presentationOf(message: ChatMessage): RunFailurePresentation {
  const resolved = resolveRunFailurePresentation({ metadata: message.metadata, content: message.content, assumeFailed: true });
  if (!resolved) {
    throw new Error("expected a failure presentation");
  }
  return resolved;
}

const STEPS = <div data-testid="fixture-turn-steps">Edited README.md</div>;

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

  async function render(
    value: RunFailureRetryContextValue | null,
    { message = FAILURE, steps = null }: { message?: ChatMessage; steps?: ReactNode } = {},
  ) {
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={value}>
          <RunFailureMessageBody message={message} presentation={presentationOf(message)} steps={steps} />
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

  // docs/Local-Engine-Turns.md 5.5: "Teammates see only" that it couldn't
  // finish. The raw text is about the sender's own sign-in, plan or computer.
  it("tells a teammate only that it couldn't finish, with no Try again and no way to send it as theirs", async () => {
    const resendWithTurnEngine = vi.fn();
    await render(context({ isViewer: false, name: "Ada" }, { resendWithTurnEngine }));
    expect(sentence()).toBe("Claude Code couldn't finish this turn on Ada's computer.");
    expect(query("run-failure-retry")).toBeNull();
    expect(query("run-failure-turn-engine-resend")).toBeNull();
    // The sender's wording and the raw text stay theirs: with no steps, there
    // is no Details to open.
    expect(container.textContent).not.toContain("Open a terminal");
    expect(query("run-failure-details-toggle")).toBeNull();
    expect(container.textContent).not.toContain(RAW);
  });

  it("gives a teammate's Details the turn's steps, never the raw text", async () => {
    await render(context({ isViewer: false, name: "Ada" }), { steps: STEPS });
    await act(async () => {
      query("run-failure-details-toggle")?.click();
    });
    expect(container.querySelector('[data-testid="fixture-turn-steps"]')?.textContent).toBe("Edited README.md");
    expect(query("run-failure-details")).toBeNull();
    expect(container.textContent).not.toContain(RAW);

    // Its sender gets both.
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await render(context({ isViewer: true, name: "Ada" }), { steps: STEPS });
    await act(async () => {
      query("run-failure-details-toggle")?.click();
    });
    expect(query("run-failure-details")?.textContent).toBe(RAW);
    expect(container.querySelector('[data-testid="fixture-turn-steps"]')).not.toBeNull();
  });

  it("words it for everyone else when the chat cannot tell who sent it", async () => {
    await render(context(null));
    expect(sentence()).toBe("Claude Code couldn't finish this turn on the sender's computer.");
    expect(query("run-failure-retry")).toBeNull();
    expect(container.textContent).not.toContain(RAW);
    await render(null);
    expect(sentence()).toBe("Claude Code couldn't finish this turn on the sender's computer.");
    expect(query("run-failure-retry")).toBeNull();
    expect(container.textContent).not.toContain(RAW);
  });
});

// A failure the controller did not stamp, or one of an engine this Studio was
// not built with, reads as any other failure: only the controller's stamp
// makes the engine word it. Its card still never sends the turn again.
describe("the failure card of a turn without the controller's stamp", () => {
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

  function failure(metadata: Record<string, unknown>): ChatMessage {
    return { ...FAILURE, id: "failure-plain", content: "The build script stopped halfway", metadata };
  }

  async function render(message: ChatMessage, value: RunFailureRetryContextValue) {
    await act(async () => {
      root.render(
        <RunFailureRetryProvider value={value}>
          <RunFailureMessageBody message={message} presentation={presentationOf(message)} />
        </RunFailureRetryProvider>,
      );
    });
  }

  const query = (testId: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  const sentence = () => container.querySelector('[data-testid="run-failure-body"] p')?.textContent ?? "";

  it("reads a recorded message that names the engine as an ordinary failure, without Try again or Retried", async () => {
    // What any member could record: the mode, without the stamp or the code.
    const recorded = failure({ source: "agent", messageType: "error", outcome: "failed", aiAccessMode: "claude-code" });
    await render(recorded, context({ isViewer: true, name: "Ada" }, { isRetrySuperseded: () => true }));
    expect(sentence()).toBe("The build script stopped halfway");
    expect(container.textContent).not.toContain("Claude Code");
    expect(query("run-failure-retry")).toBeNull();
    expect(query("run-failure-retried")).toBeNull();
    expect(query("run-failure-turn-engine-resend")).toBeNull();
  });

  it("never offers Try again for an engine this Studio was not built with", async () => {
    const otherEngine = failure({ source: "agent", outcome: "failed", jobId: "job-1", aiAccessMode: "future-engine" });
    await render(otherEngine, context(null));
    expect(sentence()).toBe("The build script stopped halfway");
    expect(query("run-failure-retry")).toBeNull();
  });

  it("never offers Try again for a failure whose prompt was a turn-engine one", async () => {
    const plain = failure({ source: "agent", outcome: "failed", jobId: "job-1", aiAccessMode: "managed" });
    await render(plain, context(null, { isTurnEngineTurn: () => true }));
    expect(query("run-failure-retry")).toBeNull();
    // Any other failure keeps its Try again.
    await render(plain, context(null, { isTurnEngineTurn: () => false }));
    expect(query("run-failure-retry")?.textContent).toBe("Try again");
  });
});
