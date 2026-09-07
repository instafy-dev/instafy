// @vitest-environment jsdom

import { forwardRef, type ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IconButton } from "../../../../components/Button";
import { ChatComposerSurface } from "../ChatComposerSurface";
import { CHAT_INPUT_CONTROL_HEIGHT_CLASS } from "../chat-input/chatInputGrowth";
import { resolveChatComposerAffordances } from "../chatComposerAffordances";
import { deriveChatVoiceComposerViewState } from "../chatVoiceComposerViewState";

// Mount the real menu trigger, microphone and Send button with the product's
// affordance classes. Browser providers and Lexical are irrelevant to these
// checks; the shared controls must retain the same pointer-sized hit targets
// when the one primary slot changes from microphone to Send.
vi.mock("../ChatBrowserDock", () => ({
  ChatBrowserDock: () => null,
}));

vi.mock("../ComposerInviteModal", () => ({
  ComposerInviteModal: () => null,
}));

vi.mock("../../../extensions/ProviderTriggerNotice", () => ({
  ProviderTriggerNotice: () => null,
}));

vi.mock("../chat-input/ChatInput", () => ({
  ChatInput: forwardRef(function MockChatInput(_props: Record<string, unknown>, _ref) {
    void _ref;
    return <div data-testid="chat-input" />;
  }),
}));

type SurfaceProps = ComponentProps<typeof ChatComposerSurface>;

function affordancesFor(inputValue: string) {
  return resolveChatComposerAffordances({
    composerGhostSuggestionRemainder: null,
    credentialsReady: true,
    activeConversationControllerId: "controller-1",
    imageAttachmentCount: 0,
    deferAiGatesForAmbientParticipation: false,
    inputRequiresAi: false,
    inputValue,
    onboardingInputLocked: false,
    outOfCredits: false,
    runtimeControllerEnabled: false,
    queueStatusLabel: null,
    sendingAttachment: false,
    submissionPending: false,
    totalQueuedCount: 0,
    voiceHoldActive: false,
    voiceInputListening: false,
    voiceInputStarting: false,
    voiceInputTranscribing: false,
  });
}

function voiceFlagsFor(value: string) {
  const state = deriveChatVoiceComposerViewState({
    chatVoiceInteractionMode: "hold",
    composerHasSendPayload: value.trim().length > 0,
    continuousAwaitingAssistantReply: false,
    continuousConversationActive: false,
    continuousPauseMessage: null,
    continuousVoiceResolving: false,
    voiceHoldActive: false,
    voiceInputListening: false,
    voiceInputStarting: false,
    voiceInputSupported: true,
    voiceInputTranscript: "",
    voiceInputTranscribing: false,
  });
  return {
    showVoicePrimaryAction: state.showVoicePrimaryAction,
    showVoiceSecondaryAction: state.showVoiceSecondaryAction,
  };
}

function createProps({
  value,
  compactBrowserViewport,
}: {
  value: string;
  compactBrowserViewport: boolean;
}): SurfaceProps {
  const affordances = affordancesFor(value);
  return {
    browserDockProps: {} as never,
    composerOverlayRef: { current: null },
    composerAutoHidden: false,
    compactBrowserViewport,
    onSubmit: (event) => event.preventDefault(),
    queueSurfaceProps: {
      totalQueuedCount: 0,
      editingQueuedItem: null,
      chatSendQueueExpanded: false,
      collapsedQueuedMessageSummary: null,
      queueCanSendNow: false,
      chatSendQueueDisplay: [],
      sendingAttachment: false,
      inputValue: value,
      onToggleExpanded: () => undefined,
      onSendQueuedMessageNow: () => undefined,
      onRemoveQueuedItem: () => undefined,
      onReorderQueuedItem: () => undefined,
      onEditQueuedMessage: () => undefined,
      onCancelQueuedEdit: () => undefined,
      onRequeueEditedMessage: () => undefined,
      onSendEditedMessageNow: () => undefined,
    },
    activeGoal: null,
    activeGoalHealth: null,
    onPauseGoal: () => undefined,
    onResumeGoal: () => undefined,
    onClearGoal: () => undefined,
    onHelpUnblockGoal: () => undefined,
    goalDetailsCollapseToken: 0,
    nativeKeyboardOpen: false,
    onboardingInputLocked: false,
    onDragOver: () => undefined,
    onDrop: () => undefined,
    chatInputRef: { current: null },
    chatInputProps: {
      value,
      editorState: null,
      placeholder: "Ask for something…",
      agentHandles: [],
      onChange: () => undefined,
      onKeyDown: () => undefined,
    } as never,
    imageInputRef: { current: null },
    onImageInputChange: () => undefined,
    imageAttachments: [],
    onOpenImage: () => undefined,
    onRemoveImageAttachment: () => undefined,
    showVoiceStatus: false,
    voiceStatusMessage: "",
    providerTriggerNoticeProps: null,
    showComposerNavigationButton: false,
    onOpenNavigation: () => undefined,
    homeAttentionCount: 0,
    homeAttentionBadge: "",
    composerActionMenuProps: {
      pendingNewBrowser: false,
      onOpenBrowser: () => undefined,
      onOpenNewBrowser: () => undefined,
      onOpenInvite: () => undefined,
      onImportGithubRepo: () => undefined,
      onInsertCommand: () => undefined,
    },
    onOpenImagePicker: () => undefined,
    sendingAttachment: false,
    showMobileGhostSuggestionAcceptButton: false,
    onAcceptGhostSuggestion: () => undefined,
    ...voiceFlagsFor(value),
    voiceConversationActionStripProps: {
      showVoiceRepliesToggle: false,
      voiceActionActive: false,
      voiceListening: false,
      voiceStarting: false,
      voiceTranscribing: false,
      voiceState: "idle",
      voiceRoute: "provider",
      voiceCapture: "hosted",
      onVoicePressStart: () => undefined,
      onVoicePressEnd: () => undefined,
    },
    sendButtonDisabled: affordances.sendButtonDisabled,
    sendButtonVariant: affordances.sendButtonVariant,
    onSendButtonPress: () => undefined,
    composerGhostActionClass: affordances.composerGhostActionClass,
    composerPrimaryActionClass: affordances.composerPrimaryActionClass,
    composerActionIconClass: affordances.composerActionIconClass,
    inviteModalProps: {} as never,
  };
}

function classTokens(node: Element | null | undefined) {
  return new Set((node?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
}

// A token's utility root with its variant prefixes stripped: `dark:[&_svg]:
// text-slate-300` -> `text-slate-300`, `data-[hovered]:bg-slate-100` ->
// `bg-slate-100`. Bracket contents are blanked first so an arbitrary value
// such as `border-[color:var(--x)]` cannot read as a variant prefix.
function utilityRoot(token: string) {
  return token.replace(/\[[^\]]*\]/g, "[]").split(":").pop() ?? "";
}

function targetSizeTokens(node: Element | null) {
  return Array.from(classTokens(node)).filter((token) => /^(?:min-h|min-w|h|w|rounded)-/.test(utilityRoot(token))).sort();
}

function surfaceTokens(node: Element | null | undefined) {
  return Array.from(classTokens(node)).filter((token) => /^(?:border|bg|shadow|ring|rounded|h|w)-/.test(utilityRoot(token))).sort();
}

function glyphSizeTokens(node: Element | null) {
  return Array.from(classTokens(node)).filter((token) => /^(?:h|w|size)-/.test(utilityRoot(token))).sort();
}

describe("ChatComposerSurface compact controls", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderRow(value: string, compactBrowserViewport = false, overrides: Partial<SurfaceProps> = {}) {
    const props = { ...createProps({ value, compactBrowserViewport }), ...overrides };
    await act(async () => root.render(<ChatComposerSurface {...props} />));
    return props;
  }

  function control(name: "plus" | "mic" | "send") {
    const testId = { plus: "composer-action-menu-trigger", mic: "chat-voice-input-button", send: "chat-send-button" }[name];
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  async function probeIconButton() {
    const probe = document.createElement("div");
    document.body.appendChild(probe);
    const probeRoot = createRoot(probe);
    await act(async () => probeRoot.render(<IconButton variant="ghost" size="md" radius="xl" />));
    const button = probe.querySelector("button");
    const result = { target: targetSizeTokens(button), surface: surfaceTokens(button) };
    await act(async () => probeRoot.unmount());
    probe.remove();
    return result;
  }

  it.each([false, true])("keeps quiet controls in the shared ghost style (compact=%s)", async (compactBrowserViewport) => {
    const props = await renderRow("", compactBrowserViewport);
    const ghost = await probeIconButton();
    expect(control("send")).toBeNull();
    expect(container.querySelector('[data-testid="chat-image-upload-button"]')).toBeNull();
    for (const name of ["plus", "mic"] as const) {
      const button = control(name);
      expect(button).not.toBeNull();
      expect(surfaceTokens(button)).toEqual(ghost.surface);
      for (const token of props.composerGhostActionClass.split(/\s+/)) expect(classTokens(button).has(token)).toBe(true);
      expect(button?.getAttribute("class")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    }
    const wrapper = container.querySelector('[data-testid="chat-input"]')?.parentElement;
    expect(surfaceTokens(wrapper)).toEqual([]);
  });

  it.each([false, true])("keeps the same hit target and glyph scale when the microphone changes to Send (compact=%s)", async (compactBrowserViewport) => {
    await renderRow("", compactBrowserViewport);
    const plus = control("plus");
    const mic = control("mic");
    const micGlyph = mic?.querySelector("svg") ?? null;
    const micSize = targetSizeTokens(mic);
    const glyphSize = glyphSizeTokens(micGlyph);
    const stroke = micGlyph?.getAttribute("stroke-width");
    const editor = container.querySelector('[data-testid="chat-input"]');
    expect(mic).not.toBeNull();
    expect(stroke).not.toBeNull();
    expect(glyphSizeTokens(plus?.querySelector("svg") ?? null)).toEqual(glyphSize);
    const ghost = await probeIconButton();
    expect(micSize).toEqual(ghost.target);
    expect(micSize.some((token) => token.startsWith("pointer-coarse:min-h-"))).toBe(true);
    expect(micSize.some((token) => token.startsWith("pointer-coarse:min-w-"))).toBe(true);

    const props = await renderRow("A message", compactBrowserViewport);
    const send = control("send");
    expect(control("mic")).toBeNull();
    expect(control("plus")).toBe(plus);
    expect(container.querySelector('[data-testid="chat-input"]')).toBe(editor);
    expect(send).not.toBeNull();
    expect(send?.getAttribute("data-send-rest")).toBe("false");
    expect(targetSizeTokens(send)).toEqual(micSize);
    expect(glyphSizeTokens(send?.querySelector("svg") ?? null)).toEqual(glyphSize);
    expect(send?.querySelector("svg")?.getAttribute("stroke-width")).toBe(stroke);
    for (const token of props.composerPrimaryActionClass.split(/\s+/)) expect(classTokens(send).has(token)).toBe(true);

    await renderRow("", compactBrowserViewport);
    expect(control("send")).toBeNull();
    expect(targetSizeTokens(control("mic"))).toEqual(micSize);
    expect(container.querySelector('[data-testid="chat-input"]')).toBe(editor);
  });

  it("keeps a quiet Send fallback when voice capture is unsupported", async () => {
    await renderRow("", false, { showVoicePrimaryAction: false, showVoiceSecondaryAction: false });
    const ghost = await probeIconButton();
    expect(control("mic")).toBeNull();
    expect(control("send")).not.toBeNull();
    expect(control("send")?.getAttribute("data-send-rest")).toBe("true");
    expect(surfaceTokens(control("send"))).toEqual(ghost.surface);
  });

  it("keeps the real microphone mounted through hold capture and transcript arrival", async () => {
    const idleProps = createProps({ value: "", compactBrowserViewport: true });
    await renderRow("", true);
    const mic = control("mic");
    const input = container.querySelector('[data-testid="chat-input"]');
    await renderRow("spoken words", true, {
      showVoiceStatus: true,
      voiceConversationActionStripProps: {
        ...idleProps.voiceConversationActionStripProps,
        voiceInteractionMode: "hold",
        voiceActionActive: true,
        voiceListening: true,
      },
    });
    expect(control("mic")).toBe(mic);
    expect(control("send")).toBeNull();
    expect(mic?.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[data-testid="chat-input"]')).toBe(input);
    await renderRow("spoken words", true);
    expect(control("mic")).toBeNull();
    expect(control("send")).not.toBeNull();
  });

  it.each([false, true])("aligns the growing editor with the shared control height (compact=%s)", async (compactBrowserViewport) => {
    await renderRow("", compactBrowserViewport);
    const wrapper = classTokens(container.querySelector('[data-testid="chat-input"]')?.parentElement);
    for (const token of CHAT_INPUT_CONTROL_HEIGHT_CLASS.split(/\s+/)) expect(wrapper.has(token)).toBe(true);
    const row = classTokens(container.querySelector('[data-testid="chat-composer-text-row"]'));
    expect(row.has("items-end")).toBe(true);
  });
});
