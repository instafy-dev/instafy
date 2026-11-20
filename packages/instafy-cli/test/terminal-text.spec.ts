import { describe, expect, it } from "vitest";
import { shownJson } from "../src/terminal-text.js";

// What a terminal acts on that `JSON.stringify` prints as it is: DEL, the C1 controls, the line and
// paragraph separators, and the bidirectional marks.
const LEFT_RAW = [
  0x7f,
  ...Array.from({ length: 0x20 }, (_, index) => 0x80 + index),
  0x61c,
  0x200e,
  0x200f,
  0x2028,
  0x2029,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
].map((code) => String.fromCharCode(code));

describe("shownJson", () => {
  it("escapes what JSON.stringify leaves as it is, and still parses to the same values", () => {
    const text = LEFT_RAW.join("");
    // In a key, after an escaped backslash, and nested.
    const value = { [`key ${text}`]: [text, `\\${text}`, { nested: `a${text}b` }], plain: "x" };
    const printed = shownJson(value);
    expect(LEFT_RAW.filter((character) => printed.includes(character))).toEqual([]);
    expect(JSON.parse(printed)).toEqual(value);
    expect(shownJson(["\u009b2J", "\u2028", "\u202e"])).toBe(
      ["[", String.raw`  "\u009b2J",`, String.raw`  "\u2028",`, String.raw`  "\u202e"`, "]"].join("\n"),
    );
  });

  it("prints anything else as JSON.stringify does, indented by two spaces", () => {
    const value = {
      name: "Studio Mac é 日本 \u{1f469}\u200d\u{1f4bb} \u200b\u200d",
      controls: "\u001b[2K\r\n\t\u0000",
      lookalike: String.raw`\u009b`,
      list: [1, null, true, { empty: [] }],
    };
    expect(shownJson(value)).toBe(JSON.stringify(value, null, 2));
    expect(JSON.parse(shownJson(value))).toEqual(value);
  });
});
