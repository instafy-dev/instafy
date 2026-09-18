import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../../types";
import { resolveComposerUiSuggestedReplies } from "../chatMessageDetailHelpers";

function createAssistantMessage(metadata: Record<string, unknown>): ChatMessage {
  return {
    id: "assistant-message",
    role: "assistant",
    content: "Choose what happens next.",
    timestamp: 1,
    metadata,
  };
}

describe("resolveComposerUiSuggestedReplies", () => {
  it("suppresses deterministic GitHub import actions from the composer", () => {
    const message = createAssistantMessage({
      messageType: "integration_request",
      ui: { suggestedReply: "Import the repo now." },
      details: {
        provider: "github",
        resumeAction: {
          kind: "github_import",
          repo: "https://github.com/example/private-repo",
        },
      },
    });

    expect(resolveComposerUiSuggestedReplies(message)).toEqual([]);
  });

  it("suppresses historical snake-case GitHub import actions too", () => {
    const message = createAssistantMessage({
      message_type: "integration_request",
      ui: { suggested_reply: "Import the repo now." },
      details: {
        resume_action: {
          kind: "GITHUB_IMPORT",
          repo: "example/private-repo",
        },
      },
    });

    expect(resolveComposerUiSuggestedReplies(message)).toEqual([]);
  });

  it("suppresses a secret request, which the card answers from its own button", () => {
    const message = createAssistantMessage({
      messageType: "secret_request",
      ui: { suggestedReply: "I saved NOTION_API_KEY. Try again." },
      details: { name: "NOTION_API_KEY" },
    });

    expect(resolveComposerUiSuggestedReplies(message)).toEqual([]);
  });

  it("suppresses a historical snake-case secret request too", () => {
    const message = createAssistantMessage({
      message_type: "SECRET_REQUEST",
      ui: { suggested_reply: "I added CLOUDFLARE_API_TOKEN. Try again." },
    });

    expect(resolveComposerUiSuggestedReplies(message)).toEqual([]);
  });

  it("keeps ordinary assistant suggestions available", () => {
    const message = createAssistantMessage({
      ui: { suggestedReplies: ["Summarize the architecture."] },
    });

    expect(resolveComposerUiSuggestedReplies(message)).toEqual([
      "Summarize the architecture.",
    ]);
  });
});
