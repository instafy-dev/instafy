import { describe, expect, it } from "vitest";

import {
  looksLikeInternalLearnedBlocksStatus,
  resolveAssistantStatusHeadline,
} from "../assistantStatusHeuristics";

describe("assistantStatusHeuristics", () => {
  it("recognizes learned-block loader updates as internal status noise", () => {
    expect(
      looksLikeInternalLearnedBlocksStatus(
        "Loaded learned blocks: blocks/innsbruck-listing-navigation/SKILL.md",
      ),
    ).toBe(true);
  });

  it("does not hide ordinary assistant copy", () => {
    expect(
      looksLikeInternalLearnedBlocksStatus("Loaded the page and found the current oil price."),
    ).toBe(false);
  });
});

describe("resolveAssistantStatusHeadline", () => {
  it("keeps only the heading of a reasoning summary part", () => {
    expect(
      resolveAssistantStatusHeadline(
        "**Clarifying whitespace handling**\n\nThe user seems to mean whitespace generally, not just tabs. The expression `/^[ \\r\\n]|[ \\t]/` misses them.",
      ),
    ).toBe("Clarifying whitespace handling");
    expect(
      resolveAssistantStatusHeadline(
        "  **Calculating hash output**  \r\n\r\nI need to compute an exact value for the digest.",
      ),
    ).toBe("Calculating hash output");
  });

  it("returns a heading that has no body", () => {
    expect(resolveAssistantStatusHeadline("**Planning the migration**")).toBe("Planning the migration");
  });

  it("keeps the first line when there is no bold heading", () => {
    expect(resolveAssistantStatusHeadline("Thinking…")).toBe("Thinking…");
    expect(resolveAssistantStatusHeadline("Context automatically compacted")).toBe(
      "Context automatically compacted",
    );
    expect(resolveAssistantStatusHeadline("Retrying: upstream timeout")).toBe("Retrying: upstream timeout");
    expect(resolveAssistantStatusHeadline("Reading the config\nthen the lockfile")).toBe("Reading the config");
  });

  it("does not treat bold that does not open the text as a heading", () => {
    expect(resolveAssistantStatusHeadline("I will **not** change tabs\n\nThe user asked for spaces.")).toBe(
      "I will not change tabs",
    );
    // Bold that opens a line of prose is emphasis, not a heading on its own line.
    expect(resolveAssistantStatusHeadline("**Note:** the build failed\n\nDetails follow.")).toBe(
      "Note: the build failed",
    );
  });

  it("returns an empty string for empty or blank text", () => {
    expect(resolveAssistantStatusHeadline("")).toBe("");
    expect(resolveAssistantStatusHeadline("   \n\n  ")).toBe("");
    expect(resolveAssistantStatusHeadline("** **")).toBe("");
  });
});
