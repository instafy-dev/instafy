import { describe, expect, it } from "vitest";
import {
  CHAT_INPUT_LINE_HEIGHT_PX,
  resolveChatInputMaxHeightPx,
  resolveChatInputMaxLines,
} from "../chat-input/chatInputGrowth";

describe("chatInputGrowth", () => {
  it("caps the editor at 6 lines below sm and 10 lines at sm+", () => {
    expect(resolveChatInputMaxLines({ compactViewport: true })).toBe(6);
    expect(resolveChatInputMaxLines({ compactViewport: false })).toBe(10);
  });

  it("turns the line cap into a pixel max-height that includes the editor padding", () => {
    // py-1 below sm (8px), sm:py-0.5 at sm+ (4px); box-sizing folds it in.
    expect(resolveChatInputMaxHeightPx({ compactViewport: true })).toBe(6 * CHAT_INPUT_LINE_HEIGHT_PX + 8);
    expect(resolveChatInputMaxHeightPx({ compactViewport: false })).toBe(10 * CHAT_INPUT_LINE_HEIGHT_PX + 4);
  });
});
