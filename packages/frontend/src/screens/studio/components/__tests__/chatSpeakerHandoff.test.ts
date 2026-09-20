import { describe, expect, it } from "vitest";
import { hasReachedSpeakerHandoffLine, resolveSpeakerHandoffLine } from "../chatSpeakerMarker";

// Numbers measured in the running studio: the scroller's top at 114, a 41px
// roster row over it with 8px of padding, a 33px pill, a 28px inline
// identity, and a 48px header inset. The pill's centre is 24.5px below the
// scroller's top whether or not a pill is showing.

describe("speaker handoff line", () => {
  it("is the centre of the overlay's box, with or without a pill in it", () => {
    expect(resolveSpeakerHandoffLine(114, { top: 122, height: 33 }, 48)).toBe(138.5);
    expect(resolveSpeakerHandoffLine(114, { top: 138.5, height: 0 }, 48)).toBe(138.5);
  });

  it("falls back to the header inset when there is no overlay to measure", () => {
    expect(resolveSpeakerHandoffLine(114, null, 48)).toBe(162);
  });

  it("hands off when the identity's centre reaches the line, not its top edge", () => {
    const line = 138.5;
    // Identity top at the bottom of the fade (48px down): still fully
    // readable, and the first version already swapped here.
    expect(hasReachedSpeakerHandoffLine(162, { top: 162, height: 28 }, line)).toBe(false);
    // Centre 4px above the line: swap, on the pill's own row.
    expect(hasReachedSpeakerHandoffLine(120, { top: 120, height: 28 }, line)).toBe(true);
    // Exactly on the line.
    expect(hasReachedSpeakerHandoffLine(124.5, { top: 124.5, height: 28 }, line)).toBe(true);
  });

  it("uses the marker's own top edge when no identity is visible", () => {
    const line = 138.5;
    expect(hasReachedSpeakerHandoffLine(140, null, line)).toBe(false);
    expect(hasReachedSpeakerHandoffLine(138, null, line)).toBe(true);
    // A label the layout hides measures as an empty box and counts as absent.
    expect(hasReachedSpeakerHandoffLine(140, { top: 0, height: 0 }, line)).toBe(false);
  });
});
