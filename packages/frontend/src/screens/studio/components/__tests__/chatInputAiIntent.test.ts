import { describe, expect, it, vi } from "vitest";
import {
  resolveChatInputCanRunAmbientParticipationPreflight,
  resolveChatInputHasBrowserTask,
  resolveChatInputRequiresAi,
} from "../chatInputAiIntent";

describe("resolveChatInputRequiresAi", () => {
  it("keeps a truly empty first-run composer out of the credential gate", () => {
    const resolvePromptAgentTargets = vi.fn(() => ({
      targetHandles: ["octo"],
      explicitMentionedHandles: [],
    }));

    expect(
      resolveChatInputRequiresAi({
        activeConversationMessages: [],
        inputValue: "",
        hasImageAttachments: false,
        fallbackSuggestion: null,
        resolvePromptAgentTargets,
      }),
    ).toBe(false);
    expect(resolvePromptAgentTargets).not.toHaveBeenCalled();
  });

  it("still gates an image-only assistant request", () => {
    expect(
      resolveChatInputRequiresAi({
        activeConversationMessages: [],
        inputValue: "",
        hasImageAttachments: true,
        fallbackSuggestion: null,
        resolvePromptAgentTargets: vi.fn(() => ({
          targetHandles: ["octo"],
          explicitMentionedHandles: [],
        })),
      }),
    ).toBe(true);
  });

  it("keeps image-only teammate sharing available when the assistant is off", () => {
    expect(
      resolveChatInputRequiresAi({
        activeConversationMessages: [],
        inputValue: "",
        hasImageAttachments: true,
        fallbackSuggestion: null,
        resolvePromptAgentTargets: vi.fn(() => ({
          targetHandles: [],
          explicitMentionedHandles: [],
        })),
      }),
    ).toBe(false);
  });

  it("uses an empty-send fallback suggestion when deciding whether AI is required", () => {
    expect(
      resolveChatInputRequiresAi({
        activeConversationMessages: [],
        inputValue: "",
        hasImageAttachments: false,
        fallbackSuggestion: "Summarize the next steps",
        resolvePromptAgentTargets: vi.fn(() => ({
          targetHandles: ["octo"],
          explicitMentionedHandles: [],
        })),
      }),
    ).toBe(true);
  });

  it("uses the selected or explicitly mentioned agent for text", () => {
    expect(
      resolveChatInputRequiresAi({
        activeConversationMessages: [],
        inputValue: "Please review this",
        hasImageAttachments: false,
        fallbackSuggestion: null,
        resolvePromptAgentTargets: () => ({
          targetHandles: ["octo"],
          explicitMentionedHandles: [],
        }),
      }),
    ).toBe(true);
  });

  it("still invokes AI setup for @octo in an otherwise human-only conversation", () => {
    expect(
      resolveChatInputRequiresAi({
        activeConversationMessages: [],
        inputValue: "@octo can you check this?",
        hasImageAttachments: false,
        fallbackSuggestion: null,
        resolvePromptAgentTargets: () => ({
          targetHandles: [],
          explicitMentionedHandles: [],
        }),
      }),
    ).toBe(true);
  });

  it("keeps an explicit GitHub repo import available before AI is connected", () => {
    const resolvePromptAgentTargets = vi.fn(() => ({
      targetHandles: ["octo"],
      explicitMentionedHandles: [],
    }));

    expect(
      resolveChatInputRequiresAi({
        activeConversationMessages: [],
        inputValue: "Continue with https://github.com/octocat/Hello-World.",
        hasImageAttachments: false,
        fallbackSuggestion: null,
        resolvePromptAgentTargets,
      }),
    ).toBe(false);
    expect(resolvePromptAgentTargets).not.toHaveBeenCalled();
  });

  it("keeps /invite validation available before AI is connected", () => {
    const resolvePromptAgentTargets = vi.fn(() => ({
      targetHandles: ["octo"],
      explicitMentionedHandles: [],
    }));

    expect(
      resolveChatInputRequiresAi({
        activeConversationMessages: [],
        inputValue: "/invite teammate@example.com",
        hasImageAttachments: false,
        fallbackSuggestion: null,
        resolvePromptAgentTargets,
      }),
    ).toBe(false);
    expect(resolvePromptAgentTargets).not.toHaveBeenCalled();
  });

  it("keeps a GitHub repo-link import outside the AI gate when it has an attachment", () => {
    expect(
      resolveChatInputRequiresAi({
        activeConversationMessages: [],
        inputValue: "Import https://github.com/octocat/Hello-World",
        hasImageAttachments: true,
        fallbackSuggestion: null,
        resolvePromptAgentTargets: vi.fn(() => ({
          targetHandles: ["octo"],
          explicitMentionedHandles: [],
        })),
      }),
    ).toBe(false);
  });
});

describe("resolveChatInputCanRunAmbientParticipationPreflight", () => {
  const defaultSelection = {
    activeHandles: ["octo"],
    targetHandles: ["octo"],
    explicitMentionedHandles: [],
    usesDefaultAssistantOnly: true,
  };

  function resolveCandidate(
    overrides: Partial<
      Parameters<typeof resolveChatInputCanRunAmbientParticipationPreflight>[0]
    > = {},
  ) {
    return resolveChatInputCanRunAmbientParticipationPreflight({
      inputValue: "Marcus, should we choose option A?",
      hasImageAttachments: false,
      fallbackSuggestion: null,
      activeConversationControllerId: "controller-1",
      conversationHasHumanPeer: true,
      assistantEnabled: true,
      threadKind: null,
      ownerAgentHandle: null,
      hasBrowserTask: false,
      replyToOcto: false,
      defaultAssistantHandle: "octo",
      resolvePromptAgentTargets: () => defaultSelection,
      ...overrides,
    });
  }

  it("allows a synced ambient default-Octo turn with a human peer to reach the classifier", () => {
    expect(resolveCandidate()).toBe(true);
  });

  it("keeps normal synchronous AI gates for a solo conversation", () => {
    expect(resolveCandidate({ conversationHasHumanPeer: false })).toBe(false);
  });

  it("allows a human greeting after Shared Browser was opened but the chat tab is active", () => {
    const hasBrowserTask = resolveChatInputHasBrowserTask({
      inputValue: "Hi Marcus, what do you think?",
      hasImageAttachments: false,
      fallbackSuggestion: null,
      personalBrowserActive: false,
      sharedBrowserModeActive: false,
      pendingNewBrowser: false,
      sharedBrowserPageTargetAvailable: true,
    });

    expect(hasBrowserTask).toBe(false);
    expect(
      resolveCandidate({
        inputValue: "Hi Marcus, what do you think?",
        hasBrowserTask,
      }),
    ).toBe(true);
  });

  it("keeps an auto-targeted interaction with an open Shared Browser behind AI gates", () => {
    const hasBrowserTask = resolveChatInputHasBrowserTask({
      inputValue: "Click the blue button there",
      hasImageAttachments: false,
      fallbackSuggestion: null,
      personalBrowserActive: false,
      sharedBrowserModeActive: false,
      pendingNewBrowser: false,
      sharedBrowserPageTargetAvailable: true,
    });

    expect(hasBrowserTask).toBe(true);
    expect(resolveCandidate({ hasBrowserTask })).toBe(false);
  });

  it.each([
    ["an unsynced conversation", { activeConversationControllerId: null }],
    ["an explicit Octo mention", { inputValue: "@octo answer this" }],
    ["a browser task", { hasBrowserTask: true }],
    ["an image attachment", { hasImageAttachments: true }],
    ["a slash command", { inputValue: "/terminal pnpm test" }],
    ["a reply to Octo", { replyToOcto: true }],
    ["an agent thread", { threadKind: "agent" }],
  ])("keeps normal synchronous AI gates for %s", (_label, overrides) => {
    expect(resolveCandidate(overrides)).toBe(false);
  });

  it("keeps custom-agent targets behind their normal synchronous gates", () => {
    expect(
      resolveCandidate({
        resolvePromptAgentTargets: () => ({
          activeHandles: ["octo", "reviewer"],
          targetHandles: ["reviewer"],
          explicitMentionedHandles: ["reviewer"],
          usesDefaultAssistantOnly: false,
        }),
      }),
    ).toBe(false);
  });
});
