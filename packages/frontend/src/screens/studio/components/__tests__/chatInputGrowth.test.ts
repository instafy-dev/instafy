import { describe, expect, it } from "vitest";
import {
  CHAT_INPUT_CONTROL_HEIGHT_CLASS,
  CHAT_INPUT_CONTROL_HEIGHT_COARSE_POINTER_PX,
  CHAT_INPUT_CONTROL_HEIGHT_FINE_POINTER_PX,
  CHAT_INPUT_LINE_HEIGHT_PX,
  CHAT_INPUT_OVERLAY_TOP_CLASS,
  CHAT_INPUT_VERTICAL_PADDING_CLASS,
  CHAT_INPUT_VERTICAL_PADDING_COARSE_POINTER_PX,
  CHAT_INPUT_VERTICAL_PADDING_FINE_POINTER_PX,
  resolveChatInputMaxHeightPx,
  resolveChatInputMaxLines,
  resolveChatInputVerticalPaddingPx,
} from "../chat-input/chatInputGrowth";

// Tailwind's spacing scale: one unit is 0.25rem = 4px.
const TAILWIND_SPACING_UNIT_PX = 4;

// `py-2` -> 8, `min-h-11` -> 44. Each class pair is "<fine> pointer-coarse:<coarse>".
function spacingPx(token: string, utility: string): number {
  const match = token.match(new RegExp(`^${utility}-(\\d+(?:\\.\\d+)?)$`));
  if (!match) {
    throw new Error(`not a ${utility}-<n> token: ${token}`);
  }
  return Number(match[1]) * TAILWIND_SPACING_UNIT_PX;
}

function finePointerAndCoarsePointerPx(classPair: string, utility: string): [number, number] {
  const tokens = classPair.split(/\s+/);
  expect(tokens).toHaveLength(2);
  const [fine, coarse] = tokens;
  expect(fine.includes(":")).toBe(false);
  expect(coarse.startsWith("pointer-coarse:")).toBe(true);
  return [spacingPx(fine, utility), spacingPx(coarse.replace("pointer-coarse:", ""), utility)];
}

describe("chatInputGrowth", () => {
  it("caps the editor at 6 lines below sm and 10 lines at sm+", () => {
    expect(resolveChatInputMaxLines({ compactViewport: true })).toBe(6);
    expect(resolveChatInputMaxLines({ compactViewport: false })).toBe(10);
  });

  it("pads the editor so a line centres on the row's controls: (control − line) / 2 a side", () => {
    // The controls are IconButton md: 36px on a fine pointer, 44px on a
    // coarse one. A 20px line plus both paddings is exactly the control
    // height, so a single line — and, under items-end, the last line of a
    // wrapped draft — sits on the control centres.
    expect(CHAT_INPUT_CONTROL_HEIGHT_FINE_POINTER_PX).toBe(36);
    expect(CHAT_INPUT_CONTROL_HEIGHT_COARSE_POINTER_PX).toBe(44);
    expect(CHAT_INPUT_VERTICAL_PADDING_FINE_POINTER_PX).toBe(8);
    expect(CHAT_INPUT_VERTICAL_PADDING_COARSE_POINTER_PX).toBe(12);
    expect(resolveChatInputVerticalPaddingPx({ coarsePointer: false })).toBe(
      (CHAT_INPUT_CONTROL_HEIGHT_FINE_POINTER_PX - CHAT_INPUT_LINE_HEIGHT_PX) / 2,
    );
    expect(resolveChatInputVerticalPaddingPx({ coarsePointer: true })).toBe(
      (CHAT_INPUT_CONTROL_HEIGHT_COARSE_POINTER_PX - CHAT_INPUT_LINE_HEIGHT_PX) / 2,
    );
    expect(CHAT_INPUT_LINE_HEIGHT_PX + 2 * CHAT_INPUT_VERTICAL_PADDING_FINE_POINTER_PX).toBe(
      CHAT_INPUT_CONTROL_HEIGHT_FINE_POINTER_PX,
    );
    expect(CHAT_INPUT_LINE_HEIGHT_PX + 2 * CHAT_INPUT_VERTICAL_PADDING_COARSE_POINTER_PX).toBe(
      CHAT_INPUT_CONTROL_HEIGHT_COARSE_POINTER_PX,
    );
  });

  it("puts the same numbers on the editor as classes, each with its pointer-coarse variant", () => {
    expect(finePointerAndCoarsePointerPx(CHAT_INPUT_CONTROL_HEIGHT_CLASS, "min-h")).toEqual([
      CHAT_INPUT_CONTROL_HEIGHT_FINE_POINTER_PX,
      CHAT_INPUT_CONTROL_HEIGHT_COARSE_POINTER_PX,
    ]);
    expect(finePointerAndCoarsePointerPx(CHAT_INPUT_VERTICAL_PADDING_CLASS, "py")).toEqual([
      CHAT_INPUT_VERTICAL_PADDING_FINE_POINTER_PX,
      CHAT_INPUT_VERTICAL_PADDING_COARSE_POINTER_PX,
    ]);
    // The overlays (placeholder, ghost remainder) sit on the first line, so
    // their top offset is the editor's top padding.
    expect(finePointerAndCoarsePointerPx(CHAT_INPUT_OVERLAY_TOP_CLASS, "top")).toEqual([
      CHAT_INPUT_VERTICAL_PADDING_FINE_POINTER_PX,
      CHAT_INPUT_VERTICAL_PADDING_COARSE_POINTER_PX,
    ]);
  });

  it("turns the line cap into a pixel max-height that folds both paddings in", () => {
    // box-sizing folds the padding into max-height, so the cap must carry
    // both sides for the visible area to land on a whole line count.
    for (const compactViewport of [true, false]) {
      for (const coarsePointer of [true, false]) {
        const lines = resolveChatInputMaxLines({ compactViewport });
        const padding = resolveChatInputVerticalPaddingPx({ coarsePointer });
        const maxHeight = resolveChatInputMaxHeightPx({ compactViewport, coarsePointer });
        expect(maxHeight).toBe(lines * CHAT_INPUT_LINE_HEIGHT_PX + 2 * padding);
        expect((maxHeight - 2 * padding) / CHAT_INPUT_LINE_HEIGHT_PX).toBe(lines);
      }
    }
    expect(resolveChatInputMaxHeightPx({ compactViewport: true, coarsePointer: false })).toBe(6 * 20 + 16);
    expect(resolveChatInputMaxHeightPx({ compactViewport: true, coarsePointer: true })).toBe(6 * 20 + 24);
    expect(resolveChatInputMaxHeightPx({ compactViewport: false, coarsePointer: false })).toBe(10 * 20 + 16);
    expect(resolveChatInputMaxHeightPx({ compactViewport: false, coarsePointer: true })).toBe(10 * 20 + 24);
  });
});
