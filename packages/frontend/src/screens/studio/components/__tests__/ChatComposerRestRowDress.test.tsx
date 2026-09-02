// @vitest-environment jsdom

import { forwardRef, type ComponentProps } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IconButton } from "../../../../components/Button";
import { COMPOSER_SEND_REST_CLASS, ChatComposerSurface } from "../ChatComposerSurface";
import { CHAT_INPUT_CONTROL_HEIGHT_CLASS } from "../chat-input/chatInputGrowth";
import { resolveChatComposerAffordances } from "../chatComposerAffordances";
import { deriveChatVoiceComposerViewState } from "../chatVoiceComposerViewState";

// The sibling geometry test mocks the "+" menu and the mic strip to prove the
// row does not move when the draft changes. This file mounts the REAL trigger
// and the REAL mic beside the surface's own image and Send buttons, with the
// REAL classes from resolveChatComposerAffordances, and reads the dress each
// control actually ends up wearing. Only the parts that pull in a browser
// dock, a modal, a notice or the Lexical editor are stubbed.
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
    showComposerHomeButton: false,
    onOpenHome: () => undefined,
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

function isUnprefixed(token: string) {
  return !token.replace(/\[[^\]]*\]/g, "[]").includes(":");
}

// The tokens that define a control's surface — its box, radius, fill, edge
// and shadow — in either theme and any interaction state.
const SURFACE_ROOT_PATTERN = /^(?:border|bg|shadow|ring|rounded|h|w)-/;
function surfaceTokensOf(tokens: Set<string>) {
  return new Set(
    Array.from(tokens).filter((token) => SURFACE_ROOT_PATTERN.test(utilityRoot(token))),
  );
}
function surfaceTokens(node: Element | null | undefined) {
  return surfaceTokensOf(classTokens(node));
}

function sortedTokens(tokens: Set<string>) {
  return Array.from(tokens).sort();
}

function symmetricDifference(left: Set<string>, right: Set<string>) {
  const result = new Set<string>();
  for (const token of left) {
    if (!right.has(token)) result.add(token);
  }
  for (const token of right) {
    if (!left.has(token)) result.add(token);
  }
  return result;
}

function splitTokens(classes: string) {
  return classes.split(/\s+/).filter(Boolean);
}

const REST_TOKENS = splitTokens(COMPOSER_SEND_REST_CLASS);

type ControlName = "plus" | "image" | "mic" | "send";

describe("ChatComposerSurface rest-row dress", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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

  async function renderRow(value: string, compactBrowserViewport = false) {
    const props = createProps({ value, compactBrowserViewport });
    await act(async () => root.render(<ChatComposerSurface {...props} />));
    return props;
  }

  function control(name: ControlName) {
    const testId = {
      plus: "composer-action-menu-trigger",
      image: "chat-image-upload-button",
      mic: "chat-voice-input-button",
      send: "chat-send-button",
    }[name];
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  // Bare IconButtons, so the test follows the design system rather than
  // restating it: the ghost IconButton is the rest dress, and the primary /
  // ghost variant delta is what Send may change when it lights up.
  async function probeIconButtons() {
    const probe = document.createElement("div");
    document.body.appendChild(probe);
    const probeRoot = createRoot(probe);
    await act(async () =>
      probeRoot.render(
        <>
          <IconButton variant="primary" size="md" radius="xl" data-testid="probe-primary" />
          <IconButton variant="ghost" size="md" radius="xl" data-testid="probe-ghost" />
        </>,
      ),
    );
    const primary = classTokens(probe.querySelector('[data-testid="probe-primary"]'));
    const ghost = classTokens(probe.querySelector('[data-testid="probe-ghost"]'));
    await act(async () => probeRoot.unmount());
    probe.remove();
    return { primary, ghost, variantDelta: symmetricDifference(primary, ghost) };
  }

  it.each([
    { viewport: "at sm+", compactBrowserViewport: false, controls: ["plus", "image", "mic", "send"] },
    { viewport: "below sm", compactBrowserViewport: true, controls: ["plus", "mic", "send"] },
  ] as { viewport: string; compactBrowserViewport: boolean; controls: ControlName[] }[])(
    "dresses every rest-row control $viewport as the same ghost IconButton, muting only Send's glyph",
    async ({ compactBrowserViewport, controls }) => {
      // The founder's screenshot: "+", image and mic as filled squares and
      // Send as a border-only outline with a dim icon — a fourth control in a
      // different dress. The rule now: the composer card is the only surface.
      // Every rest-row control is an icon-only ghost IconButton — no fill, no
      // border, no shadow — with the ghost variant's quiet hover surface and
      // its box for the hit target.
      const props = await renderRow("", compactBrowserViewport);
      const { ghost } = await probeIconButtons();
      const familyTokens = splitTokens(props.composerGhostActionClass);
      const nodes = controls.map((name) => {
        const node = control(name);
        expect(node, name).not.toBeNull();
        return node as Element;
      });
      const [reference] = nodes;

      for (const node of nodes) {
        // The ghost IconButton IS the dress: the same surface tokens as a bare
        // ghost IconButton of the same size and radius, on every control.
        expect(sortedTokens(surfaceTokens(node))).toEqual(sortedTokens(surfaceTokensOf(ghost)));
        expect(sortedTokens(surfaceTokens(node))).toEqual(sortedTokens(surfaceTokens(reference)));
        // No fill, border or shadow of its own: the only unprefixed fill token
        // is `bg-transparent`; hover / pressed / focus tokens are the quiet
        // surface the design system gives every ghost control.
        const unprefixedRoots = Array.from(classTokens(node))
          .filter(isUnprefixed)
          .map(utilityRoot);
        expect(unprefixedRoots.filter((rootToken) => rootToken.startsWith("bg-"))).toEqual([
          "bg-transparent",
        ]);
        expect(unprefixedRoots.filter((rootToken) => /^(?:border|shadow|ring)-/.test(rootToken))).toEqual(
          [],
        );
        // Beyond the surface, nothing but a text colour may differ.
        const delta = Array.from(symmetricDifference(classTokens(node), classTokens(reference)));
        expect(delta.filter((token) => !utilityRoot(token).startsWith("text-"))).toEqual([]);
        expect(node.getAttribute("class")).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      }

      // Siblings wear the family's glyph tone; Send wears the muted one and
      // nothing else of its own.
      for (const node of nodes.filter((node) => node !== control("send"))) {
        for (const token of familyTokens) expect(classTokens(node).has(token)).toBe(true);
        for (const token of REST_TOKENS) expect(classTokens(node).has(token)).toBe(false);
      }
      const send = control("send");
      expect(send?.getAttribute("data-send-rest")).toBe("true");
      for (const token of REST_TOKENS) expect(classTokens(send).has(token)).toBe(true);
      for (const token of familyTokens) expect(classTokens(send).has(token)).toBe(false);

      // Both tones are glyph-only and each light class has a dark pair.
      for (const tokens of [familyTokens, REST_TOKENS]) {
        expect(tokens.every((token) => utilityRoot(token).startsWith("text-"))).toBe(true);
        expect(tokens.filter((token) => token.startsWith("dark:"))).toHaveLength(
          tokens.filter((token) => !token.startsWith("dark:")).length,
        );
      }

      // The card is the input: the editor wrapper carries no surface of its own.
      const editorWrapper = container.querySelector('[data-testid="chat-input"]')?.parentElement;
      expect(editorWrapper).not.toBeNull();
      expect(sortedTokens(surfaceTokens(editorWrapper))).toEqual([]);
    },
  );

  it("lights Send up with the primary dress only, leaving its siblings ghost", async () => {
    await renderRow("");
    const rest = {
      plus: classTokens(control("plus")),
      image: classTokens(control("image")),
      mic: classTokens(control("mic")),
      send: classTokens(control("send")),
    };

    const lit = await renderRow("a");
    expect(lit.sendButtonVariant).toBe("primary");
    expect(control("send")?.getAttribute("data-send-rest")).toBe("false");

    // Siblings: untouched by the draft; the mic stays ghost.
    expect(sortedTokens(classTokens(control("plus")))).toEqual(sortedTokens(rest.plus));
    expect(sortedTokens(classTokens(control("image")))).toEqual(sortedTokens(rest.image));
    expect(sortedTokens(classTokens(control("mic")))).toEqual(sortedTokens(rest.mic));

    // Send: every token that changed is part of the ghost -> primary flip —
    // the IconButton variant delta, the primary dress and the muting it sheds.
    // The box (size, radius) survives: lighting up is colour only.
    const { variantDelta } = await probeIconButtons();
    const allowed = new Set([
      ...variantDelta,
      ...splitTokens(lit.composerPrimaryActionClass),
      ...REST_TOKENS,
    ]);
    const delta = Array.from(symmetricDifference(rest.send, classTokens(control("send"))));
    expect(delta.length).toBeGreaterThan(0);
    expect(delta.filter((token) => !allowed.has(token))).toEqual([]);
    expect(delta.filter((token) => /^(?:h|w|rounded)-/.test(utilityRoot(token)))).toEqual([]);
    for (const token of splitTokens(lit.composerPrimaryActionClass)) {
      expect(classTokens(control("send")).has(token)).toBe(true);
    }
    for (const token of REST_TOKENS) {
      expect(classTokens(control("send")).has(token)).toBe(false);
    }
  });

  it("draws the four rest-row glyphs at one size and stroke", async () => {
    // Founder feedback at desktop width: "'Ask for something' text alignment
    // with the picture icon etc?" Measured on the rest row: the "+" glyph was
    // 16px (the menu sized its own Plus with h-4 w-4) while image, mic and
    // Send were 22px at stroke 1.5. Rule: the surface hands one icon class
    // to all four controls and no control sizes a glyph of its own.
    const props = await renderRow("");
    const iconTokens = new Set(splitTokens(props.composerActionIconClass));
    const sizeTokensOf = (tokens: Set<string>) =>
      sortedTokens(
        new Set(Array.from(tokens).filter((token) => /^(?:h|w|size)-/.test(utilityRoot(token)))),
      );
    expect(sizeTokensOf(iconTokens)).toHaveLength(2);

    const glyphs = (["plus", "image", "mic", "send"] as ControlName[]).map((name) => {
      const svg = control(name)?.querySelector("svg");
      expect(svg, name).not.toBeNull();
      return svg as SVGElement;
    });
    const [reference] = glyphs;
    expect(reference.getAttribute("stroke-width")).not.toBeNull();
    for (const svg of glyphs) {
      for (const token of iconTokens) expect(classTokens(svg).has(token)).toBe(true);
      expect(sizeTokensOf(classTokens(svg))).toEqual(sizeTokensOf(iconTokens));
      expect(svg.getAttribute("stroke-width")).toBe(reference.getAttribute("stroke-width"));
    }
  });

  it.each([
    { viewport: "at sm+", compactBrowserViewport: false },
    { viewport: "below sm", compactBrowserViewport: true },
  ])(
    "sizes the editor wrapper to the controls and gives the text a 4px gutter $viewport",
    async ({ compactBrowserViewport }) => {
      // Measured: every button box 36px centred at y=685 while the editor's
      // single-line box was 24px centred at y=681 — its wrapper was min-h-11
      // (44px) on every pointer, centred in a 36px row, so the text sat 4px
      // above the icon centres. And box-to-text was 8px, the inter-button
      // gap; with the glyphs inset 7px in their boxes that read as 15px
      // glyph-to-text against a 25px glyph rhythm — the text looked pushed
      // away from the image icon. Rules: the wrapper is exactly as tall as
      // the controls, fine and coarse, and centres the editor (the editor
      // itself pads to the same height and folds that padding into its line
      // cap — chatInputGrowth.test.ts, ChatInput.test.tsx); the row's own
      // gap is 4px while the groups keep the button rhythm.
      await renderRow("", compactBrowserViewport);
      const { ghost } = await probeIconButtons();
      const wrapper = classTokens(container.querySelector('[data-testid="chat-input"]')?.parentElement);

      // The button's own height (h-9) is the wrapper's minimum (min-h-9), and
      // the coarse-pointer minimum is the very token the button carries.
      const buttonHeight = Array.from(ghost).find((token) => /^h-[^:]+$/.test(token));
      const coarseMinHeight = Array.from(ghost).find((token) => token.startsWith("pointer-coarse:min-h-"));
      expect(buttonHeight).toBeDefined();
      expect(coarseMinHeight).toBeDefined();
      expect(wrapper.has(`min-${buttonHeight}`)).toBe(true);
      expect(wrapper.has(coarseMinHeight as string)).toBe(true);
      for (const token of splitTokens(CHAT_INPUT_CONTROL_HEIGHT_CLASS)) expect(wrapper.has(token)).toBe(true);
      // ...and no other height of its own.
      expect(
        sortedTokens(
          new Set(Array.from(wrapper).filter((token) => /^(?:min-h|max-h|h)-/.test(utilityRoot(token)))),
        ),
      ).toEqual(sortedTokens(new Set([`min-${buttonHeight}`, coarseMinHeight as string])));
      for (const token of ["flex", "flex-col", "justify-center"]) expect(wrapper.has(token)).toBe(true);

      const row = classTokens(container.querySelector('[data-testid="chat-composer-text-row"]'));
      const groups = [
        classTokens(container.querySelector('[data-testid="chat-composer-leading-controls"]')),
        classTokens(container.querySelector('[data-testid="chat-composer-trailing-controls"]')),
      ];
      const gapTokens = (tokens: Set<string>) =>
        sortedTokens(new Set(Array.from(tokens).filter((token) => utilityRoot(token).startsWith("gap-"))));
      expect(row.has("items-end")).toBe(true);
      expect(gapTokens(row)).toEqual(["gap-1"]);
      for (const group of groups) expect(gapTokens(group)).toEqual(["gap-1.5", "sm:gap-2"]);
    },
  );
});
