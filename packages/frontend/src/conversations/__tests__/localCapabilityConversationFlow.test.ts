import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../screens/studio/types";
import { runLocalCapabilityConversationFlow } from "../localCapabilityConversationFlow";

vi.mock("../localBuiltInCapabilityDispatch", () => ({
  dispatchLocalBuiltInCapabilityPrompt: vi.fn(),
}));
vi.mock("../../extensions/providerEventChannel", () => ({
  dispatchObservedProviderEvents: vi.fn(),
}));

import { dispatchLocalBuiltInCapabilityPrompt } from "../localBuiltInCapabilityDispatch";
import { dispatchObservedProviderEvents } from "../../extensions/providerEventChannel";

const dispatchLocalBuiltInCapabilityPromptMock = vi.mocked(dispatchLocalBuiltInCapabilityPrompt);
const dispatchObservedProviderEventsMock = vi.mocked(dispatchObservedProviderEvents);

function createMessageStore(initialMessages: Record<string, ChatMessage[]>) {
  const store = new Map<string, ChatMessage[]>(
    Object.entries(initialMessages).map(([conversationId, messages]) => [
      conversationId,
      messages.map((message) => ({ ...message })),
    ]),
  );

  return {
    store,
    appendMessages(conversationId: string, messages: ChatMessage[]) {
      const existing = store.get(conversationId) ?? [];
      store.set(conversationId, [...existing, ...messages]);
    },
    updateMessage(
      conversationId: string,
      messageId: string,
      updater: (message: ChatMessage) => ChatMessage,
    ) {
      const messages = store.get(conversationId) ?? [];
      store.set(
        conversationId,
        messages.map((message) => (message.id === messageId ? updater(message) : message)),
      );
    },
  };
}

describe("local capability conversation flow", () => {
  beforeEach(() => {
    dispatchLocalBuiltInCapabilityPromptMock.mockReset();
    dispatchObservedProviderEventsMock.mockReset();
  });

  it("forwards conversation history and persists both sides of a local turn", async () => {
    dispatchLocalBuiltInCapabilityPromptMock.mockResolvedValue({
      handled: true,
      responseText: "Octo turned on the desk lamp.",
      metadata: {
        localCapability: {
          id: "device_toggle",
          status: "completed",
        },
      },
    });

    const messages = createMessageStore({
      "conversation-1": [
        {
          id: "user-1",
          role: "user",
          content: "@octo turn on the desk lamp",
          timestamp: 1,
          metadata: {
            client: {
              sessionId: "client-1",
            },
          },
        },
        {
          id: "assistant-context",
          role: "assistant",
          content: "Octo can control local devices.",
          timestamp: 2,
          metadata: {
            localCapability: {
              id: "device_toggle",
              status: "available",
            },
          },
        },
      ],
    });

    const recordMessageToController = vi
      .fn()
      .mockResolvedValueOnce({
        id: "controller-user-1",
        role: "user",
        content: "@octo turn on the desk lamp",
        timestamp: 3,
        metadata: {
          persisted: true,
        },
      } satisfies ChatMessage)
      .mockResolvedValueOnce({
        id: "controller-assistant-1",
        role: "assistant",
        content: "Octo turned on the desk lamp.",
        timestamp: 4,
        messageType: "status",
        metadata: {
          persisted: true,
        },
      } satisfies ChatMessage);

    const result = await runLocalCapabilityConversationFlow({
      handle: "octo",
      prompt: "@octo turn on the desk lamp",
      conversationId: "conversation-1",
      displayConversationId: "conversation-1",
      promptMetadata: {
        client: {
          sessionId: "client-1",
        },
      },
      userMessageId: "user-1",
      conversationMessages: messages.store.get("conversation-1") ?? [],
      appendMessages: messages.appendMessages,
      updateMessage: messages.updateMessage,
      recordMessageToController,
    });

    expect(result.handled).toBe(true);
    expect(result.promptMetadata).toMatchObject({
      client: {
        sessionId: "client-1",
      },
    });
    expect(dispatchLocalBuiltInCapabilityPromptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: "octo",
        conversationId: "conversation-1",
        conversationMessages: expect.arrayContaining([
          expect.objectContaining({ id: "assistant-context" }),
        ]),
      }),
    );
    expect(recordMessageToController).toHaveBeenNthCalledWith(
      1,
      "conversation-1",
      "@octo turn on the desk lamp",
      expect.objectContaining({
        client: {
          sessionId: "client-1",
        },
      }),
      "user",
    );
    expect(recordMessageToController).toHaveBeenNthCalledWith(
      2,
      "conversation-1",
      "Octo turned on the desk lamp.",
      expect.objectContaining({
        clientMessageId: expect.any(String),
        localCapability: {
          id: "device_toggle",
          status: "completed",
        },
      }),
      "assistant",
    );

    const finalMessages = messages.store.get("conversation-1") ?? [];
    expect(finalMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "controller-user-1",
          role: "user",
        }),
        expect.objectContaining({
          id: "controller-assistant-1",
          role: "assistant",
          metadata: expect.objectContaining({
            persisted: true,
            localCapability: expect.objectContaining({
              id: "device_toggle",
              status: "completed",
            }),
          }),
        }),
      ]),
    );
    expect(dispatchObservedProviderEventsMock).not.toHaveBeenCalled();
  });

  it("promotes provider events from capability metadata into assistant message metadata", async () => {
    dispatchLocalBuiltInCapabilityPromptMock.mockResolvedValue({
      handled: true,
      responseText: "Octo captured a photo.",
      metadata: {
        localCapability: {
          id: "camera_observation",
          status: "completed",
        },
        capabilityEvents: [
          {
            kind: "camera.photo_captured",
            providerId: "camera",
            providerType: "phone_camera",
            executionContext: {
              providerId: "camera",
              runtime: {
                backendId: "phone_camera",
                transportKind: "local_provider_host",
              },
            },
            artifactRefs: [
              {
                kind: "image_capture",
                uri: "/tmp/capture-1.jpg",
              },
            ],
            payload: {
              mode: "single",
              lens: "rear",
              completedCount: 1,
              captureId: "capture-1",
            },
          },
        ],
      },
    });

    const messages = createMessageStore({
      "conversation-camera": [
        {
          id: "user-1",
          role: "user",
          content: "@octo take a photo",
          timestamp: 1,
          metadata: null,
        },
      ],
    });

    const recordMessageToController = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "assistant-camera-1",
        role: "assistant",
        content: "Octo captured a photo.",
        timestamp: 2,
        messageType: "status",
        metadata: {
          persisted: true,
        },
      } satisfies ChatMessage);

    const result = await runLocalCapabilityConversationFlow({
      handle: "octo",
      prompt: "@octo take a photo",
      conversationId: "conversation-camera",
      displayConversationId: "conversation-camera",
      promptMetadata: null,
      userMessageId: "user-1",
      conversationMessages: messages.store.get("conversation-camera") ?? [],
      appendMessages: messages.appendMessages,
      updateMessage: messages.updateMessage,
      recordMessageToController,
    });

    expect(result.handled).toBe(true);
    expect(recordMessageToController).toHaveBeenNthCalledWith(
      2,
      "conversation-camera",
      "Octo captured a photo.",
      expect.objectContaining({
        providerEvents: [
          expect.objectContaining({
            kind: "camera.photo_captured",
            providerId: "camera",
            artifactRefs: [
              expect.objectContaining({
                kind: "image_capture",
                uri: "/tmp/capture-1.jpg",
              }),
            ],
          }),
        ],
      }),
      "assistant",
    );

    const finalMessages = messages.store.get("conversation-camera") ?? [];
    expect(finalMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assistant-camera-1",
          metadata: expect.objectContaining({
            persisted: true,
            providerEvents: [
              expect.objectContaining({
                kind: "camera.photo_captured",
                providerId: "camera",
              }),
            ],
          }),
        }),
      ]),
    );
    expect(dispatchObservedProviderEventsMock).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: "camera.photo_captured",
        providerId: "camera",
      }),
    ]);
  });

  it("captures provider events emitted during capability execution callbacks", async () => {
    dispatchLocalBuiltInCapabilityPromptMock.mockImplementation(async (options) => {
      options.onCapabilityEvent?.({
        kind: "camera.photo_captured",
        providerId: "camera",
        providerType: "phone_camera",
        executionContext: {
          providerId: "camera",
          runtime: {
            backendId: "phone_camera",
            transportKind: "native_mobile",
            executionSurface: "extension_runtime",
          },
        },
        artifactRefs: [
          {
            kind: "image_capture",
            uri: "/tmp/capture-callback.jpg",
          },
        ],
        payload: {
          mode: "single",
          lens: "rear",
          completedCount: 1,
          captureId: "capture-callback",
        },
      });
      return {
        handled: true,
        responseText: "Octo captured a photo from the live callback path.",
        metadata: {
          localCapability: {
            id: "camera_observation",
            status: "completed",
          },
        },
      };
    });

    const messages = createMessageStore({
      "conversation-camera-callback": [
        {
          id: "user-1",
          role: "user",
          content: "@octo take a photo",
          timestamp: 1,
          metadata: null,
        },
      ],
    });

    const recordMessageToController = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "assistant-camera-callback-1",
        role: "assistant",
        content: "Octo captured a photo from the live callback path.",
        timestamp: 2,
        messageType: "status",
        metadata: {
          persisted: true,
        },
      } satisfies ChatMessage);

    const result = await runLocalCapabilityConversationFlow({
      handle: "octo",
      prompt: "@octo take a photo",
      conversationId: "conversation-camera-callback",
      displayConversationId: "conversation-camera-callback",
      promptMetadata: null,
      userMessageId: "user-1",
      conversationMessages: messages.store.get("conversation-camera-callback") ?? [],
      appendMessages: messages.appendMessages,
      updateMessage: messages.updateMessage,
      recordMessageToController,
    });

    expect(result.handled).toBe(true);
    expect(recordMessageToController).toHaveBeenNthCalledWith(
      2,
      "conversation-camera-callback",
      "Octo captured a photo from the live callback path.",
      expect.objectContaining({
        capabilityEvents: [
          expect.objectContaining({
            kind: "camera.photo_captured",
            providerId: "camera",
          }),
        ],
        providerEvents: [
          expect.objectContaining({
            kind: "camera.photo_captured",
            providerId: "camera",
            artifactRefs: [
              expect.objectContaining({
                kind: "image_capture",
                uri: "/tmp/capture-callback.jpg",
              }),
            ],
          }),
        ],
      }),
      "assistant",
    );

    const finalMessages = messages.store.get("conversation-camera-callback") ?? [];
    expect(finalMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assistant-camera-callback-1",
          metadata: expect.objectContaining({
            persisted: true,
            capabilityEvents: [
              expect.objectContaining({
                kind: "camera.photo_captured",
                providerId: "camera",
              }),
            ],
            providerEvents: [
              expect.objectContaining({
                kind: "camera.photo_captured",
                providerId: "camera",
              }),
            ],
          }),
        }),
      ]),
    );
    expect(dispatchObservedProviderEventsMock).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: "camera.photo_captured",
        providerId: "camera",
      }),
    ]);
  });

  it("surfaces and then clears structured camera request status metadata", async () => {
    dispatchLocalBuiltInCapabilityPromptMock.mockImplementation(async (options) => {
      options.onStatus?.({
        text: "Waiting for Marcus phone to accept the front selfie request.",
        metadata: {
          cameraRequest: {
            text: "Waiting for Marcus phone to accept the front selfie request.",
            tone: "secondary",
            deviceLabel: "Marcus phone",
            requestState: "pending",
            presenceStatus: "online",
            requiresPermission: false,
            hasRecentFailure: false,
          },
        },
      });
      return {
        handled: true,
        responseText: "Octo captured a front photo from Camera.",
        metadata: {
          localCapability: {
            id: "camera_observation",
            status: "completed",
          },
        },
      };
    });

    const updates: ChatMessage[] = [];
    const messages = createMessageStore({
      "conversation-camera-status": [
        {
          id: "user-1",
          role: "user",
          content: "@octo capture a front selfie",
          timestamp: 1,
          metadata: null,
        },
      ],
    });

    const updateMessage = (
      conversationId: string,
      messageId: string,
      updater: (message: ChatMessage) => ChatMessage,
    ) => {
      messages.updateMessage(conversationId, messageId, (message) => {
        const next = updater(message);
        updates.push(next);
        return next;
      });
    };

    const recordMessageToController = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "assistant-camera-status-1",
        role: "assistant",
        content: "Octo captured a front photo from Camera.",
        timestamp: 2,
        messageType: "status",
        metadata: {
          persisted: true,
        },
      } satisfies ChatMessage);

    const result = await runLocalCapabilityConversationFlow({
      handle: "octo",
      prompt: "@octo capture a front selfie",
      conversationId: "conversation-camera-status",
      displayConversationId: "conversation-camera-status",
      promptMetadata: null,
      userMessageId: "user-1",
      conversationMessages: messages.store.get("conversation-camera-status") ?? [],
      appendMessages: messages.appendMessages,
      updateMessage,
      recordMessageToController,
    });

    expect(result.handled).toBe(true);
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          content: "Waiting for Marcus phone to accept the front selfie request.",
          metadata: expect.objectContaining({
            cameraRequest: expect.objectContaining({
              deviceLabel: "Marcus phone",
              requestState: "pending",
            }),
          }),
        }),
      ]),
    );
    expect(recordMessageToController).toHaveBeenNthCalledWith(
      2,
      "conversation-camera-status",
      "Octo captured a front photo from Camera.",
      expect.not.objectContaining({
        cameraRequest: expect.anything(),
      }),
      "assistant",
    );

    const finalMessages = messages.store.get("conversation-camera-status") ?? [];
    expect(finalMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assistant-camera-status-1",
          content: "Octo captured a front photo from Camera.",
          metadata: expect.objectContaining({
            localCapability: expect.objectContaining({
              status: "completed",
            }),
          }),
        }),
      ]),
    );
    const finalAssistant = finalMessages.find(
      (message) => message.id === "assistant-camera-status-1",
    );
    expect(finalAssistant?.metadata).toEqual(
      expect.not.objectContaining({
        cameraRequest: expect.anything(),
      }),
    );
  });

  it("persists the user turn before the handled local capability completes", async () => {
    let resolveCapability: ((value: {
      handled: boolean;
      responseText: string;
      metadata: {
        localCapability: {
          id: string;
          status: string;
        };
      };
    }) => void) | null = null;
    dispatchLocalBuiltInCapabilityPromptMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveCapability = resolve;
        }),
    );

    const messages = createMessageStore({
      "conversation-camera-persist-early": [
        {
          id: "user-1",
          role: "user",
          content: "@octo capture a front selfie",
          timestamp: 1,
          metadata: null,
        },
      ],
    });

    const recordMessageToController = vi
      .fn()
      .mockResolvedValueOnce({
        id: "controller-user-early",
        role: "user",
        content: "@octo capture a front selfie",
        timestamp: 2,
        metadata: {
          persisted: true,
        },
      } satisfies ChatMessage)
      .mockResolvedValueOnce({
        id: "controller-assistant-early",
        role: "assistant",
        content: "Octo captured a front photo from Camera.",
        timestamp: 3,
        messageType: "status",
        metadata: {
          persisted: true,
        },
      } satisfies ChatMessage);

    const flowPromise = runLocalCapabilityConversationFlow({
      handle: "octo",
      prompt: "@octo capture a front selfie",
      conversationId: "conversation-camera-persist-early",
      displayConversationId: "conversation-camera-persist-early",
      promptMetadata: null,
      userMessageId: "user-1",
      conversationMessages: messages.store.get("conversation-camera-persist-early") ?? [],
      appendMessages: messages.appendMessages,
      updateMessage: messages.updateMessage,
      recordMessageToController,
    });

    await vi.waitFor(() => {
      expect(recordMessageToController).toHaveBeenNthCalledWith(
        1,
        "conversation-camera-persist-early",
        "@octo capture a front selfie",
        null,
        "user",
      );
    });

    expect(messages.store.get("conversation-camera-persist-early")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "controller-user-early",
          role: "user",
        }),
      ]),
    );

    expect(resolveCapability).not.toBeNull();
    resolveCapability!({
      handled: true,
      responseText: "Octo captured a front photo from Camera.",
      metadata: {
        localCapability: {
          id: "camera_observation",
          status: "completed",
        },
      },
    });

    const result = await flowPromise;

    expect(result.handled).toBe(true);
    expect(recordMessageToController).toHaveBeenNthCalledWith(
      2,
      "conversation-camera-persist-early",
      "Octo captured a front photo from Camera.",
      expect.objectContaining({
        localCapability: {
          id: "camera_observation",
          status: "completed",
        },
      }),
      "assistant",
    );
  });

  it("preserves device-aware camera success text when the selected phone is known", async () => {
    dispatchLocalBuiltInCapabilityPromptMock.mockResolvedValue({
      handled: true,
      responseText: "Octo captured a front photo on Marcus phone.",
      metadata: {
        localCapability: {
          id: "camera_observation",
          status: "completed",
        },
      },
    });

    const messages = createMessageStore({
      "conversation-camera-device-success": [
        {
          id: "user-1",
          role: "user",
          content: "@octo capture a front selfie",
          timestamp: 1,
          metadata: null,
        },
      ],
    });

    const recordMessageToController = vi
      .fn()
      .mockResolvedValueOnce({
        id: "controller-user-device-success",
        role: "user",
        content: "@octo capture a front selfie",
        timestamp: 2,
        metadata: {
          persisted: true,
        },
      } satisfies ChatMessage)
      .mockResolvedValueOnce({
        id: "controller-assistant-device-success",
        role: "assistant",
        content: "Octo captured a front photo on Marcus phone.",
        timestamp: 3,
        messageType: "status",
        metadata: {
          persisted: true,
        },
      } satisfies ChatMessage);

    const result = await runLocalCapabilityConversationFlow({
      handle: "octo",
      prompt: "@octo capture a front selfie",
      conversationId: "conversation-camera-device-success",
      displayConversationId: "conversation-camera-device-success",
      promptMetadata: null,
      userMessageId: "user-1",
      conversationMessages: messages.store.get("conversation-camera-device-success") ?? [],
      appendMessages: messages.appendMessages,
      updateMessage: messages.updateMessage,
      recordMessageToController,
    });

    expect(result.handled).toBe(true);
    expect(recordMessageToController).toHaveBeenNthCalledWith(
      2,
      "conversation-camera-device-success",
      "Octo captured a front photo on Marcus phone.",
      expect.objectContaining({
        localCapability: {
          id: "camera_observation",
          status: "completed",
        },
      }),
      "assistant",
    );
    expect(messages.store.get("conversation-camera-device-success")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "controller-assistant-device-success",
          role: "assistant",
          content: "Octo captured a front photo on Marcus phone.",
        }),
      ]),
    );
  });
});
