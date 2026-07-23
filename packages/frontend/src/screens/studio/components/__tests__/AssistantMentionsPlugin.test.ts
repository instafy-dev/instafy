import { describe, expect, it } from "vitest";

import { startsWithAssistantMention } from "../../../../conversations/assistantMentions";
import { buildAssistantMentionOptionConfigs } from "../chat-input/AssistantMentionsPlugin";

describe("AssistantMentionsPlugin", () => {
  it("keeps provider-backed handles out of default mention options", () => {
    const tokens = buildAssistantMentionOptionConfigs({}).map((option) => option.token);

    expect(tokens).toContain("@octo");
    expect(tokens).not.toContain("@demo");
  });

  it("shows configured custom agent handles as mention options", () => {
    const tokens = buildAssistantMentionOptionConfigs({
      agentHandles: ["ben"],
      agentProfiles: [
        {
          handle: "ben",
          displayName: "Ben",
          avatarSeed: "ben",
        },
      ],
    }).map((option) => option.token);

    expect(tokens).toContain("@octo");
    expect(tokens).toContain("@ben");
    expect(tokens).not.toContain("@demo");
  });

  it("can show a provider-backed handle only when it is explicitly configured", () => {
    const tokens = buildAssistantMentionOptionConfigs({
      agentHandles: ["demo"],
    }).map((option) => option.token);

    expect(tokens).toContain("@demo");
  });

  it("keeps human handles off built-in assistant handles and aliases", () => {
    const options = buildAssistantMentionOptionConfigs({
      mentionableUsers: [
        {
          userId: "user-ai",
          email: "ai@example.com",
          fullName: "Ai Chen",
          role: "builder",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          userId: "user-octo",
          email: "octo.something@example.com",
          fullName: "Octo Something",
          role: "builder",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const userOptions = options.filter((option) => option.kind === "user");
    expect(userOptions.map((option) => option.token)).toEqual(["@ai2", "@octo2"]);
    for (const option of userOptions) {
      // The suffixed pill must not read back as an assistant route.
      expect(startsWithAssistantMention(`${option.token} can you take this?`)).toBe(false);
    }
  });

  it("keeps human handles off configured project agent handles", () => {
    const options = buildAssistantMentionOptionConfigs({
      agentHandles: ["maria"],
      mentionableUsers: [
        {
          userId: "user-maria",
          email: "maria@example.com",
          fullName: "Maria Lopez",
          role: "builder",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });

    const userTokens = options
      .filter((option) => option.kind === "user")
      .map((option) => option.token);
    expect(userTokens).toEqual(["@maria2"]);
    expect(options.filter((option) => option.kind === "agent").map((option) => option.token)).toEqual([
      "@maria",
    ]);
  });
});
