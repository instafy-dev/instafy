import type { BuiltInAssistantHandle } from "../assistants/localBuiltInAssistantCatalog";
import { getLocalCapabilityAssistantDefinition } from "../assistants/localBuiltInAssistantCatalog";
import { dispatchObservedProviderEvents } from "../extensions/providerEventChannel";
import {
  collectCapabilityEventRecords,
  collectProviderEventEnvelopes,
} from "../extensions/providerEvents";
import type { ChatMessage } from "../screens/studio/types";
import { dispatchLocalBuiltInCapabilityPrompt } from "./localBuiltInCapabilityDispatch";
import {
  deriveLocalCapabilityPromptMetadataPatch,
  type LocalCapabilityStatusValue,
} from "../capabilities/localCapabilityRuntime";
import {
  isMetadataRecord,
  mergeLocalCapabilityMetadata,
} from "./localCapabilityMetadata";
import { generateUUID } from "../utils/uuid";

type UpdateConversationMessage = (
  conversationId: string,
  messageId: string,
  updater: (message: ChatMessage) => ChatMessage,
) => void;

type AppendConversationMessages = (conversationId: string, messages: ChatMessage[]) => void;

type RecordConversationMessage = (
  conversationId: string,
  content: string,
  metadata?: Record<string, unknown> | null,
  role?: ChatMessage["role"],
) => Promise<ChatMessage | null>;

export interface RunLocalCapabilityConversationFlowOptions {
  handle: BuiltInAssistantHandle;
  prompt: string;
  projectId?: string | null;
  conversationId: string;
  displayConversationId: string;
  promptMetadata: Record<string, unknown> | null;
  userMessageId: string;
  conversationMessages: ChatMessage[];
  appendMessages: AppendConversationMessages;
  updateMessage: UpdateConversationMessage;
  recordMessageToController: RecordConversationMessage;
  onCapabilityError?: (message: string) => void;
}

export interface LocalCapabilityConversationFlowResult {
  handled: boolean;
  promptMetadata: Record<string, unknown> | null;
}

function createAssistantStatusMessage(
  handle: BuiltInAssistantHandle,
  assistantLabel: string,
  clientMessageId: string,
): ChatMessage {
  return {
    id: `assistant-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    role: "assistant",
    authorId: handle,
    content: `${assistantLabel} is preparing the local capability action…`,
    timestamp: Date.now(),
    files: null,
    messageType: "status",
    metadata: {
      clientMessageId,
      messageType: "status",
      agent: {
        handle,
        displayName: assistantLabel,
      },
      localCapability: {
        status: "in_progress",
      },
    },
  };
}

function normalizeLocalCapabilityStatusUpdate(status: LocalCapabilityStatusValue): {
  text: string;
  metadata: Record<string, unknown> | null;
} {
  if (typeof status === "string") {
    return {
      text: status,
      metadata: null,
    };
  }
  return {
    text: status.text,
    metadata: isMetadataRecord(status.metadata) ? status.metadata : null,
  };
}

export async function runLocalCapabilityConversationFlow(
  options: RunLocalCapabilityConversationFlowOptions,
): Promise<LocalCapabilityConversationFlowResult> {
  const assistantDefinition = getLocalCapabilityAssistantDefinition(options.handle);
  const assistantLabel = assistantDefinition?.displayName ?? options.handle;
  const conversationMetadataPatch = deriveLocalCapabilityPromptMetadataPatch({
    handle: options.handle,
    prompt: options.prompt,
    conversationMessages: options.conversationMessages,
  });

  let nextPromptMetadata = options.promptMetadata;
  if (conversationMetadataPatch) {
    nextPromptMetadata = mergeLocalCapabilityMetadata(
      nextPromptMetadata,
      conversationMetadataPatch,
    );

    options.updateMessage(options.displayConversationId, options.userMessageId, (previous) => {
      const previousMetadata = isMetadataRecord(previous.metadata) ? previous.metadata : null;
      return {
        ...previous,
        metadata: mergeLocalCapabilityMetadata(previousMetadata, nextPromptMetadata),
      };
    });
  }

  const assistantClientMessageId = generateUUID();
  const assistantMessage = createAssistantStatusMessage(
    options.handle,
    assistantLabel,
    assistantClientMessageId,
  );
  options.appendMessages(options.conversationId, [assistantMessage]);

  // Once the prompt has been routed into the handled local-capability flow, persist the
  // user turn immediately so controller-backed clients can observe it while the capability
  // is still running (for example while waiting on a remote phone camera capture).
  const recordedUserMessagePromise = options
    .recordMessageToController(options.conversationId, options.prompt, nextPromptMetadata, "user")
    .then((recordedUserMessage) => {
      if (recordedUserMessage) {
        options.updateMessage(options.displayConversationId, options.userMessageId, () => recordedUserMessage);
      }
      return recordedUserMessage;
    })
    .catch(() => null);

  const updateAssistantCapabilityMessage = (
    content: string,
    status: "in_progress" | "completed" | "failed",
    extraMetadata?: Record<string, unknown> | null,
  ) => {
    options.updateMessage(options.conversationId, assistantMessage.id, (previous) => {
      const previousMetadata = isMetadataRecord(previous.metadata) ? previous.metadata : {};
      const previousLocalCapability = isMetadataRecord(previousMetadata.localCapability)
        ? previousMetadata.localCapability
        : {};
      const normalizedExtraMetadata = extraMetadata ? { ...extraMetadata } : null;
      if (
        status !== "in_progress" &&
        (!normalizedExtraMetadata || !Object.prototype.hasOwnProperty.call(normalizedExtraMetadata, "cameraRequest"))
      ) {
        if (normalizedExtraMetadata) {
          normalizedExtraMetadata.cameraRequest = null;
        }
      }
      return {
        ...previous,
        content,
        messageType: status === "failed" ? "error" : "status",
        metadata: mergeLocalCapabilityMetadata(previousMetadata, normalizedExtraMetadata, {
          agent: {
            handle: options.handle,
            displayName: assistantLabel,
          },
          localCapability: {
            ...previousLocalCapability,
            status,
          },
        }),
      };
    });
  };

  const observedCapabilityEvents: Record<string, unknown>[] = [];
  const capabilityResult = await dispatchLocalBuiltInCapabilityPrompt({
    handle: options.handle,
    prompt: options.prompt,
    conversationId: options.conversationId,
    projectId: options.projectId ?? null,
    conversationMessages: options.conversationMessages,
    onStatus: (statusUpdate) => {
      const normalizedStatusUpdate = normalizeLocalCapabilityStatusUpdate(statusUpdate);
      updateAssistantCapabilityMessage(
        normalizedStatusUpdate.text,
        "in_progress",
        normalizedStatusUpdate.metadata,
      );
    },
    onCapabilityEvent: (event) => {
      observedCapabilityEvents.push(event);
    },
  });

  if (!capabilityResult.handled) {
    updateAssistantCapabilityMessage(
      `${assistantLabel} could not start the local capability action.`,
      "failed",
    );
    return {
      handled: false,
      promptMetadata: nextPromptMetadata,
    };
  }

  const assistantResponseText =
    capabilityResult.responseText ?? `${assistantLabel} finished the local capability action.`;
  const resultMetadata = isMetadataRecord(capabilityResult.metadata) ? capabilityResult.metadata : null;
  const capabilityEvents = collectCapabilityEventRecords(
    resultMetadata?.capabilityEvents,
    observedCapabilityEvents,
  );
  const providerEvents = collectProviderEventEnvelopes(
    resultMetadata?.providerEvents,
    capabilityEvents,
  );
  const resultLocalCapability =
    resultMetadata && isMetadataRecord(resultMetadata.localCapability)
      ? resultMetadata.localCapability
      : null;
  const assistantMetadata = {
    ...(resultMetadata ?? {}),
    ...(capabilityEvents.length > 0 ? { capabilityEvents } : {}),
    ...(providerEvents.length > 0 ? { providerEvents } : {}),
    clientMessageId: assistantClientMessageId,
    messageType: capabilityResult.error ? "error" : "status",
    agent: {
      handle: options.handle,
      displayName: assistantLabel,
    },
    localCapability: {
      ...(resultLocalCapability ?? {}),
      status:
        capabilityResult.error
          ? "failed"
          : typeof resultLocalCapability?.status === "string"
            ? resultLocalCapability.status
            : "completed",
    },
  } satisfies Record<string, unknown>;

  if (providerEvents.length > 0) {
    dispatchObservedProviderEvents(providerEvents);
  }

  updateAssistantCapabilityMessage(
    assistantResponseText,
    capabilityResult.error ? "failed" : "completed",
    assistantMetadata,
  );
  await recordedUserMessagePromise;

  const recordedAssistantMessage = await options.recordMessageToController(
    options.conversationId,
    assistantResponseText,
    assistantMetadata,
    "assistant",
  );
  if (recordedAssistantMessage) {
    options.updateMessage(options.conversationId, assistantMessage.id, (previous) => {
      const previousMetadata = isMetadataRecord(previous.metadata) ? previous.metadata : null;
      const recordedMetadata = isMetadataRecord(recordedAssistantMessage.metadata)
        ? recordedAssistantMessage.metadata
        : null;
      return {
        ...recordedAssistantMessage,
        messageType:
          recordedAssistantMessage.messageType ??
          previous.messageType ??
          (capabilityResult.error ? "error" : "status"),
        metadata: mergeLocalCapabilityMetadata(
          previousMetadata,
          assistantMetadata,
          recordedMetadata,
        ),
      };
    });
  }

  if (capabilityResult.error) {
    options.onCapabilityError?.(capabilityResult.error);
  }

  return {
    handled: true,
    promptMetadata: nextPromptMetadata,
  };
}
