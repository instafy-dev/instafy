import { describe, expect, it } from "vitest";

import { looksLikeInternalLearnedBlocksStatus } from "../assistantStatusHeuristics";

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
