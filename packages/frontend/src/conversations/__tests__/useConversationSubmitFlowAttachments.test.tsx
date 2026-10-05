// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversation, type ConversationState } from "../conversationState";
import type { SubmitConversationOptions } from "../conversationSubmitTypes";
import type { ChatMessage } from "../../screens/studio/types";

const mocks = vi.hoisted(() => ({
  calls: [] as string[],
  sendMessage: vi.fn(),
  createBlank: vi.fn(),
  recordMessage: vi.fn(),
  resolveParticipation: vi.fn(),
  applyChanges: vi.fn(),
  upload: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../sdk/instafy")>("../../sdk/instafy");
  return { ...actual, controllerClient: {
    ...actual.controllerClient,
    core: { ...actual.controllerClient.core, enabled: true },
    conversations: {
      ...actual.controllerClient.conversations,
      sendMessage: mocks.sendMessage,
      createBlank: mocks.createBlank,
      recordMessage: mocks.recordMessage,
      resolveParticipation: mocks.resolveParticipation,
    },
    runtimes: { ...actual.controllerClient.runtimes, ensure: vi.fn(), fetchStatus: vi.fn() },
    workspace: {
      ...actual.controllerClient.workspace,
      origin: { ...actual.controllerClient.workspace.origin, applyChanges: mocks.applyChanges },
    },
  } };
});
vi.mock("../../lib/supabaseClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/supabaseClient")>();
  return {
    ...actual,
    hasSupabaseConfig: true,
    supabase: {
      ...actual.supabase,
      storage: { from: () => ({ upload: mocks.upload, remove: mocks.remove }) },
    },
  };
});
vi.mock("../useConversationAutoTitle", () => ({ useConversationAutoTitle: () => ({
  maybeAutoTitleConversation: vi.fn(), queueAutoTitleConversation: vi.fn(),
}) }));

import { ChatAttachmentUploadError } from "../../lib/chatAttachments";
import { useConversationSubmitFlow } from "../useConversationSubmitFlow";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const EXISTING_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CREATED_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

type Flow = ReturnType<typeof useConversationSubmitFlow>;
type FlowArgs = Parameters<typeof useConversationSubmitFlow>[0];

describe("chat attachments through the real submit flow", () => {
  let root: Root;
  let container: HTMLDivElement;
  let flow: Flow;
  let args: Pick<FlowArgs, "appendMessages" | "showStatus" | "setConversationControllerId">;

  async function render(conversation: ConversationState) {
    function Harness() {
      flow = useConversationSubmitFlow({
        conversations: [conversation], activeConversation: conversation, activeProjectId: PROJECT_ID,
        currentUserId: "user-1", preferredRuntimeId: null, runtimeStatuses: [], effectiveRuntimeId: null,
        effectiveRuntimeSource: "auto", createConversation: vi.fn(), selectConversation: vi.fn(),
        markConversationRead: vi.fn(), setConversationDraft: vi.fn(),
        setConversationTitle: vi.fn(), setConversationGoal: vi.fn(), updateMessage: vi.fn(),
        linkRunToConversation: vi.fn(), ...args,
      });
      return null;
    }
    await act(async () => root.render(<Harness />));
  }

  const image = () => new File(["png-bytes"], "Screen Shot.png", { type: "image/png" });
  const sendOptions = (extra: SubmitConversationOptions = {}): SubmitConversationOptions => ({
    agentHandles: ["octo"], editorState: null, ...extra,
  });
  const appendedMessages = () =>
    (args.appendMessages as ReturnType<typeof vi.fn>).mock.calls.flatMap(([, messages]) => messages as ChatMessage[]);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.sendMessage.mockReset().mockImplementation(async () => {
      mocks.calls.push("send");
      return { runId: "run-1" };
    });
    mocks.createBlank.mockReset().mockImplementation(async () => {
      mocks.calls.push("create");
      return { conversationId: CREATED_ID };
    });
    mocks.upload.mockReset().mockImplementation(async (path: string) => {
      mocks.calls.push(`upload:${path}`);
      return { data: { path }, error: null };
    });
    mocks.remove.mockReset().mockResolvedValue({ data: [], error: null });
    mocks.recordMessage.mockReset();
    mocks.resolveParticipation.mockReset().mockResolvedValue("unsupported");
    args = { appendMessages: vi.fn(), showStatus: vi.fn(), setConversationControllerId: vi.fn() };
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("creates a new chat before its first upload and sends the message to that same chat", async () => {
    await render(createInitialConversation({ localId: "conversation-local", controllerId: null }));
    await act(async () => {
      await flow.handleSubmit("conversation-local", "What is in this screenshot?", sendOptions({ imageFiles: [image()] }));
    });

    expect(mocks.createBlank).toHaveBeenCalledTimes(1);
    expect(mocks.createBlank.mock.calls[0][0]).toMatchObject({ projectId: PROJECT_ID });
    expect(mocks.calls[0]).toBe("create");
    expect(mocks.calls[1]).toMatch(new RegExp(`^upload:${PROJECT_ID}/${CREATED_ID}/${UUID}\\.png$`));
    expect(mocks.calls.at(-1)).toBe("send");
    expect(args.setConversationControllerId).toHaveBeenCalledWith("conversation-local", CREATED_ID);

    const storagePath = mocks.upload.mock.calls[0][0] as string;
    const expectedAttachments = [{
      kind: "image",
      storagePath,
      fileName: "Screen-Shot.png",
      mimeType: "image/png",
      sizeBytes: 9,
    }];
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessage.mock.calls[0][0]).toMatchObject({
      conversationId: CREATED_ID,
      projectId: PROJECT_ID,
      metadata: expect.objectContaining({ attachments: expectedAttachments }),
    });
    // The message shows up once, already carrying its stored attachments.
    const [userMessage] = appendedMessages();
    expect(userMessage.metadata).toMatchObject({ attachments: expectedAttachments });
    // Nothing goes into the workspace any more.
    expect(mocks.applyChanges).not.toHaveBeenCalled();
  });

  // Not an attachment case, but this is the real submit flow's harness.
  it("sends no auto-save choice with a prompt and drops the retired stored one", async () => {
    window.localStorage.setItem("instafy.git.autoSyncAfterApply", "0");
    await render(createInitialConversation({ localId: "conversation-local", controllerId: EXISTING_ID }));
    await act(async () => {
      await flow.handleSubmit("conversation-local", "Edit the README", sendOptions());
    });

    expect(mocks.sendMessage).toHaveBeenCalledTimes(1);
    const metadata = mocks.sendMessage.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(metadata).toHaveProperty("clientMessageId");
    expect(metadata).not.toHaveProperty("git");
    expect(JSON.stringify(metadata)).not.toContain("autoSyncAfterApply");
    expect(window.localStorage.getItem("instafy.git.autoSyncAfterApply")).toBeNull();
  });

  it("uploads into an existing chat's folder without creating another chat", async () => {
    await render(createInitialConversation({ localId: "conversation-local", controllerId: EXISTING_ID }));
    await act(async () => {
      await flow.handleSubmit("conversation-local", "Compare these", sendOptions({ imageFiles: [image(), image()] }));
    });
    expect(mocks.createBlank).not.toHaveBeenCalled();
    expect(mocks.upload).toHaveBeenCalledTimes(2);
    for (const [path] of mocks.upload.mock.calls) {
      expect(path).toMatch(new RegExp(`^${PROJECT_ID}/${EXISTING_ID}/${UUID}\\.png$`));
    }
    expect(mocks.sendMessage.mock.calls[0][0].conversationId).toBe(EXISTING_ID);
  });

  it("sends merge snapshots as kind file text attachments in the same folder", async () => {
    await render(createInitialConversation({ localId: "conversation-local", controllerId: EXISTING_ID }));
    const textFiles = [
      new File(["base"], "App.tsx.base.txt", { type: "text/plain" }),
      new File(["local!"], "App.tsx.local.txt", { type: "text/plain" }),
    ];
    await act(async () => {
      await flow.handleSubmit("conversation-local", "Merge my edits", sendOptions({ textFiles }));
    });
    const attachments = mocks.sendMessage.mock.calls[0][0].metadata.attachments;
    expect(attachments).toEqual([
      expect.objectContaining({ kind: "file", fileName: "App.tsx.base.txt", mimeType: "text/plain", sizeBytes: 4 }),
      expect.objectContaining({ kind: "file", fileName: "App.tsx.local.txt", mimeType: "text/plain", sizeBytes: 6 }),
    ]);
    for (const attachment of attachments) {
      expect(attachment.storagePath).toMatch(new RegExp(`^${PROJECT_ID}/${EXISTING_ID}/${UUID}\\.txt$`));
    }
    expect(mocks.applyChanges).not.toHaveBeenCalled();
  });

  it("sends nothing and shows nothing when an upload fails, and says why in plain copy", async () => {
    mocks.upload.mockResolvedValue({
      data: null,
      error: { message: "new row violates row-level security policy", status: 400, statusCode: "403" },
    });
    await render(createInitialConversation({ localId: "conversation-local", controllerId: EXISTING_ID }));
    let failure: unknown = null;
    await act(async () => {
      failure = await flow
        .handleSubmit("conversation-local", "What is in this screenshot?", sendOptions({ imageFiles: [image()] }))
        .catch((error) => error);
    });
    expect(failure).toBeInstanceOf(ChatAttachmentUploadError);
    expect((failure as Error).message).toBe("You can't add attachments to this chat.");
    expect(args.showStatus).toHaveBeenCalledWith(
      "Your message wasn't sent. You can't add attachments to this chat.",
      "error",
      6000,
    );
    expect(args.appendMessages).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(mocks.recordMessage).not.toHaveBeenCalled();
  });

  it("tells the composer the images are stored as the message is shown, before it is sent", async () => {
    await render(createInitialConversation({ localId: "conversation-local", controllerId: EXISTING_ID }));
    const onAttachmentsStored = vi.fn(() => {
      mocks.calls.push("stored");
      expect(args.appendMessages).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await flow.handleSubmit("conversation-local", "Look", sendOptions({ imageFiles: [image()], onAttachmentsStored }));
    });
    expect(onAttachmentsStored).toHaveBeenCalledTimes(1);
    expect(mocks.calls.slice(-2)).toEqual(["stored", "send"]);
  });

  it("leaves a failed upload's copy to a caller that shows it itself", async () => {
    mocks.upload.mockResolvedValue({ data: null, error: { message: "{}", status: 503 } });
    await render(createInitialConversation({ localId: "conversation-local", controllerId: EXISTING_ID }));
    const onAttachmentsStored = vi.fn();
    let failure: unknown = null;
    await act(async () => {
      failure = await flow
        .handleSubmit(
          "conversation-local",
          "Merge my edits",
          sendOptions({
            textFiles: [new File(["base"], "App.tsx.base.txt", { type: "text/plain" })],
            callerReportsAttachmentErrors: true,
            onAttachmentsStored,
          }),
        )
        .catch((error) => error);
    });
    expect((failure as Error).message).toBe("Storage isn't responding right now. Try again in a moment.");
    expect(args.showStatus).not.toHaveBeenCalled();
    expect(onAttachmentsStored).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });

  it("uploads nothing when the new chat cannot be created", async () => {
    mocks.createBlank.mockResolvedValue(null);
    await render(createInitialConversation({ localId: "conversation-local", controllerId: null }));
    let failure: unknown = null;
    await act(async () => {
      failure = await flow
        .handleSubmit("conversation-local", "Look", sendOptions({ imageFiles: [image()] }))
        .catch((error) => error);
    });
    expect(failure).toBeInstanceOf(ChatAttachmentUploadError);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(args.appendMessages).not.toHaveBeenCalled();
    expect(mocks.sendMessage).not.toHaveBeenCalled();
  });
});
