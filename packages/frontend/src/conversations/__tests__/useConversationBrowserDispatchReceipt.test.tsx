// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialConversation, type ConversationState } from "../conversationState";
import type { SubmitConversationOptions } from "../conversationSubmitTypes";

const { sendMessage, createBlank, recordMessage, resolveParticipation } = vi.hoisted(() => ({
  sendMessage: vi.fn(), createBlank: vi.fn(), recordMessage: vi.fn(), resolveParticipation: vi.fn(),
}));
vi.mock("../../sdk/instafy", async () => {
  const actual = await vi.importActual<typeof import("../../sdk/instafy")>("../../sdk/instafy");
  return { ...actual, controllerClient: {
    ...actual.controllerClient,
    core: { ...actual.controllerClient.core, enabled: true },
    conversations: { ...actual.controllerClient.conversations, sendMessage, createBlank, recordMessage, resolveParticipation },
    runtimes: { ...actual.controllerClient.runtimes, ensure: vi.fn(), fetchStatus: vi.fn() },
  } };
});
vi.mock("../useConversationAutoTitle", () => ({ useConversationAutoTitle: () => ({
  maybeAutoTitleConversation: vi.fn(), queueAutoTitleConversation: vi.fn(),
}) }));

import { useConversationSubmitFlow } from "../useConversationSubmitFlow";

const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const CONTROLLER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RUNTIME_ID = "99999999-8888-4777-8666-555555555555";
const prompt = "I have finished the manual browser step. Continue the previous browser task on this same page.";
const browserOptions: SubmitConversationOptions = {
  requireDispatch: true, expectedLaneIdle: true, agentHandles: ["octo"], imageFiles: [], editorState: null,
  runtimeOverride: { runtimeId: RUNTIME_ID, runtimeDisplayName: null, preferRuntime: false },
  metadata: { browserTransport: "shared", browserConsentVersion: 1, browserRuntimeId: RUNTIME_ID, browserPageId: "page-1" },
};
type Flow = ReturnType<typeof useConversationSubmitFlow>;
function Harness({ conversation, onReady }: { conversation: ConversationState; onReady: (flow: Flow) => void }) {
  const flow = useConversationSubmitFlow({
    conversations: [conversation], activeConversation: conversation, activeProjectId: PROJECT_ID,
    currentUserId: "user-1", preferredRuntimeId: null, runtimeStatuses: [], effectiveRuntimeId: null,
    effectiveRuntimeSource: "auto", showStatus: vi.fn(), createConversation: vi.fn(), selectConversation: vi.fn(),
    markConversationRead: vi.fn(), setConversationDraft: vi.fn(), setConversationControllerId: vi.fn(),
    setConversationTitle: vi.fn(), setConversationGoal: vi.fn(), appendMessages: vi.fn(), updateMessage: vi.fn(),
    linkRunToConversation: vi.fn(),
  });
  onReady(flow);
  return null;
}

describe("browser continuation through real submit flow and controller dispatch", () => {
  let root: Root;
  let container: HTMLDivElement;
  let conversation: ConversationState;
  let flow: Flow;
  beforeEach(async () => {
    vi.clearAllMocks();
    sendMessage.mockReset(); createBlank.mockReset(); recordMessage.mockReset(); resolveParticipation.mockReset();
    sendMessage.mockResolvedValue({ runId: "accepted-run" });
    resolveParticipation.mockResolvedValue("unsupported");
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    conversation = createInitialConversation({ localId: "conversation-local", controllerId: CONTROLLER_ID });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => root.render(<Harness conversation={conversation} onReady={(value) => { flow = value; }} />));
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each(["controller unavailable", "expectedLaneIdle: browser lane is busy"])("rejects failed dispatch: %s", async (message) => {
    sendMessage.mockRejectedValue(new Error(message));
    await expect(flow.handleSubmit("conversation-local", prompt, browserOptions)).rejects.toThrow(message);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toMatchObject({ expectedLaneIdle: true, runtimeId: RUNTIME_ID });
    expect(recordMessage).not.toHaveBeenCalled();
  });

  it.each([null, {}, { runId: null, runIds: [] }])("requires an actual controller run, not a record-only response: %j", async (response) => {
    sendMessage.mockResolvedValue(response);
    await expect(flow.handleSubmit("conversation-local", prompt, browserOptions)).rejects.toThrow(/Controller unavailable|did not start a browser turn/);
  });

  it.each([{ runId: "accepted-run" }, { runIds: ["accepted-run"] }])("acknowledges accepted runs without exposing callbacks on the wire: %j", async (response) => {
    sendMessage.mockResolvedValue(response);
    const assertDispatchCurrent = vi.fn();
    await expect(flow.handleSubmit("conversation-local", prompt, { ...browserOptions, assertDispatchCurrent })).resolves.toBeUndefined();
    expect(assertDispatchCurrent).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).not.toHaveProperty("assertDispatchCurrent");
    expect(sendMessage.mock.calls[0][0]).not.toHaveProperty("requireDispatch");
    expect(resolveParticipation).not.toHaveBeenCalled();
  });

  it("preserves ordinary caller error reporting without changing its void return", async () => {
    sendMessage.mockRejectedValue(new Error("controller unavailable"));
    await expect(flow.handleSubmit("conversation-local", prompt, { ...browserOptions, requireDispatch: false })).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge early no-dispatch paths", async () => {
    await expect(flow.handleSubmit("conversation-local", "", browserOptions)).rejects.toThrow("not dispatched");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rechecks identity after asynchronous conversation preflight before sending", async () => {
    conversation.controllerId = null;
    let complete!: (value: { conversationId: string }) => void;
    createBlank.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    let current = true;
    const assertDispatchCurrent = vi.fn(() => { if (!current) throw new Error("browser identity changed"); });
    const result = flow.handleSubmit("conversation-local", prompt, { ...browserOptions, assertDispatchCurrent }).catch((error) => error);
    await act(async () => { await Promise.resolve(); });
    expect(createBlank).toHaveBeenCalledTimes(1);
    current = false;
    complete({ conversationId: CONTROLLER_ID });
    expect(await result).toMatchObject({ message: "browser identity changed" });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
