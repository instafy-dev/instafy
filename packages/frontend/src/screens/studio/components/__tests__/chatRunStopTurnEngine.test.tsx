// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { ChatRunStopNotice, ChatRunStopNoticeProvider } from "../ChatRunStopNotice";
import { useChatRunStopContinuation } from "../useChatRunStopContinuation";
import type { SubmitMessageFn } from "../useChatSubmitFlow";

const REQUEST = "Fix the failing login test";

function asked(metadata: Record<string, unknown>): ChatMessage {
  return {
    id: "asked-1", role: "user", authorId: "viewer", content: REQUEST, timestamp: 0, files: null,
    metadata: { runId: "run-1", ...metadata },
  };
}

const notice: ChatMessage = {
  id: "stop-1", role: "assistant", authorId: null, content: "", timestamp: 1, files: null,
  messageType: "run_cancellation", metadata: { details: {
    stopRequested: true, actorUserId: "viewer", agentHandles: ["octo"], jobIds: ["job-1"], runIds: ["run-1"],
  } },
};

// docs/Local-Engine-Turns.md 11.14: version 1 hid Continue under a Stop of a
// Claude Code turn, since its automatic send never carried the per-message
// choice. In version 2 the agent's AI decides, so Continue carries a stopped
// Claude Code turn on as it does any other, to the same agent.
describe("Continue under a Stop of a turn-engine turn", () => {
  let root: Root;
  let container: HTMLDivElement;
  let controls: ReturnType<typeof useChatRunStopContinuation>;
  const submit = vi.fn<SubmitMessageFn>();
  let props: Parameters<typeof useChatRunStopContinuation>[0];
  function Harness() {
    controls = useChatRunStopContinuation(props);
    return <ChatRunStopNoticeProvider value={controls}><ChatRunStopNotice message={notice} /></ChatRunStopNoticeProvider>;
  }
  async function render(messages: ChatMessage[]) {
    props = { ...props, messages };
    await act(async () => root.render(<Harness />));
  }
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    submit.mockReset();
    submit.mockResolvedValue(true);
    props = { conversationId: "chat", viewerUserId: "viewer", humanLabelByUserId: new Map(), canWrite: true,
      busy: false, messages: [], hasNewer: false, queuedSends: [], submitMessage: submit };
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  const continueButton = () => container.querySelector('[data-testid="chat-run-stop-continue"]');

  it("is offered for the controller's stamped prompt, as for any other", async () => {
    await render([
      asked({ aiAccessMode: "claude-code", claudeCode: { version: 1 }, prompt_metadata: { aiAccessMode: "claude-code" } }),
      notice,
    ]);
    expect(controls.canContinue(notice)).toBe(true);
    expect(continueButton()).not.toBeNull();
  });

  it("is offered for the same Stop of an ordinary turn", async () => {
    await render([asked({}), notice]);
    expect(controls.canContinue(notice)).toBe(true);
    expect(continueButton()).not.toBeNull();
  });
});
