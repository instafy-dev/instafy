// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveChatComposerAffordances } from "../chatComposerAffordances";
import type { QueuedChatSendItem } from "../chatSendQueueStorage";
import { useChatSendQueuePresentation } from "../useChatSendQueuePresentation";

type PresentationInput = Parameters<typeof useChatSendQueuePresentation>[0];
type MachineState = Pick<
  PresentationInput,
  "hostedRuntimeEnsuring" | "runtimeEnsureError" | "runtimeReady" | "waitingForPreferredRuntime"
>;

const QUEUED: QueuedChatSendItem = {
  id: "queued-1",
  message: "Add a due date to each todo",
  editorState: null,
  createdAt: 1,
  targetAgentHandles: ["octo"],
  browserPageTarget: null,
  browserLaunchMode: null,
};

const NOT_READY: MachineState = {
  hostedRuntimeEnsuring: false,
  runtimeEnsureError: null,
  runtimeReady: false,
  waitingForPreferredRuntime: false,
};

let presentation: ReturnType<typeof useChatSendQueuePresentation> | null = null;

function Probe({ machine }: { machine: MachineState }) {
  presentation = useChatSendQueuePresentation({
    activeConversationControllerId: "controller-1",
    activeConversationRun: null,
    chatSendQueue: [QUEUED],
    currentRuntime: null,
    isAssistantTyping: false,
    resolvePromptAgentTargets: () => ({ targetHandles: [] }),
    runtimeControllerEnabled: true,
    sendingAttachment: false,
    ...machine,
  });
  return null;
}

// The composer compares the queue's status label by its words, so a label
// changed in one of the two files but not the other would hold the queue.
describe("a queued message while the space's machine isn't ready", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    presentation = null;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each<[string, MachineState, string]>([
    ["the selected machine isn't ready", { ...NOT_READY, waitingForPreferredRuntime: true }, "Waiting for a machine"],
    ["a hosted machine is starting", { ...NOT_READY, hostedRuntimeEnsuring: true }, "Waiting for a machine"],
    ["a hosted machine didn't start", { ...NOT_READY, runtimeEnsureError: "No capacity" }, "Machine didn't start"],
    ["no machine is ready", NOT_READY, "Machine not ready"],
  ])("can still be sent through the controller when %s", async (_state, machine, label) => {
    await act(async () => {
      root.render(<Probe machine={machine} />);
    });

    expect(presentation?.queueStatusLabel).toBe(label);
    const { queueCanSendNow } = resolveChatComposerAffordances({
      composerGhostSuggestionRemainder: null,
      credentialsReady: true,
      activeConversationControllerId: "controller-1",
      imageAttachmentCount: 0,
      deferAiGatesForAmbientParticipation: false,
      inputRequiresAi: false,
      inputValue: "",
      onboardingInputLocked: false,
      outOfCredits: false,
      runtimeControllerEnabled: true,
      queueStatusLabel: presentation?.queueStatusLabel ?? null,
      sendingAttachment: false,
      sharedBrowserSendBlocked: false,
      submissionPending: false,
      totalQueuedCount: presentation?.totalQueuedCount ?? 0,
      voiceHoldActive: false,
      voiceInputListening: false,
      voiceInputStarting: false,
      voiceInputTranscribing: false,
    });
    expect(queueCanSendNow).toBe(true);
  });
});
