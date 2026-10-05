import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { QueuedChatSendItem } from "../chatSendQueueStorage";
import { useChatSendQueuePresentation } from "../useChatSendQueuePresentation";

const queued: QueuedChatSendItem = {
  id: "queued-1",
  message: "And this too",
  editorState: null,
  createdAt: 1,
  targetAgentHandles: ["octo"],
  browserPageTarget: null,
  browserLaunchMode: null,
};

type PresentationInput = Parameters<typeof useChatSendQueuePresentation>[0];

function presentation(overrides: Partial<PresentationInput>) {
  let result: ReturnType<typeof useChatSendQueuePresentation> | null = null;
  function Probe() {
    result = useChatSendQueuePresentation({
      activeConversationControllerId: "conversation-1",
      activeConversationRun: null,
      agentByHandle: new Map(),
      chatSendQueue: [queued],
      currentRuntime: null,
      hostedRuntimeEnsuring: false,
      isAssistantTyping: false,
      resolvePromptAgentTargets: () => ({ targetHandles: [] }),
      runtimeControllerEnabled: true,
      runtimeEnsureError: null,
      runtimeReady: false,
      sendingAttachment: false,
      stalledLaunchRetryAvailable: false,
      stalledLaunchRetryPending: false,
      waitingForPreferredRuntime: true,
      ...overrides,
    });
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return result!;
}

describe("useChatSendQueuePresentation", () => {
  it("offers Try again instead of an endless Starting… once the launch has stalled", () => {
    const starting = presentation({});
    expect(starting.queueStatusLabel).toBe("Starting runtime");
    expect(starting.queueStatusAction).toEqual({ label: "Starting…", disabled: true, pending: true });

    const stalled = presentation({ stalledLaunchRetryAvailable: true });
    // The label still lets queued messages use the controller's send path.
    expect(stalled.queueStatusLabel).toBe("Starting runtime");
    expect(stalled.queueStatusAction).toEqual({ label: "Try again", disabled: false, pending: false });

    // While the retry is in flight the same action shows it.
    expect(
      presentation({
        stalledLaunchRetryAvailable: true,
        stalledLaunchRetryPending: true,
        hostedRuntimeEnsuring: true,
      }).queueStatusAction,
    ).toEqual({ label: "Try again", disabled: false, pending: true });
  });

  it("has no action without queued messages", () => {
    expect(presentation({ chatSendQueue: [], stalledLaunchRetryAvailable: true }).queueStatusAction).toBeNull();
  });
});
