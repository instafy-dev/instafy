// A cloned repository chooses some of the text the CLI prints about it: the path of its
// `.instafy/space.json`, and the values in that file. A terminal acts on control characters
// rather than showing them, so a folder name or a value could rewrite or hide what a command
// says. These show such text with those characters escaped.

function escaped(character: string): string {
  return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

/**
 * A value as an error shows it: quoted, cut to 80 characters, and with anything but printable
 * ASCII escaped, which also makes a lookalike of an expected character visible.
 */
export function shownValue(value: string): string {
  const quoted = JSON.stringify(value.slice(0, 80)).replace(/[^\x20-\x7e]/g, escaped);
  return value.length > 80 ? `${quoted}…` : quoted;
}

/**
 * A path as a message shows it: what a terminal acts on rather than shows, the control characters
 * and the line and paragraph separators, and the bidirectional marks that reorder text are
 * escaped. Everything else is left as it is, joiners in names included.
 */
export function shownPath(file: string): string {
  return file.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, escaped);
}

/**
 * A value as `--json` prints it: `JSON.stringify` with two-space indentation, which escapes only
 * the control characters up to U+001F. The others `shownPath` escapes, DEL, the C1 controls, the
 * line and paragraph separators and the bidirectional marks, are written as `\uXXXX` escapes too.
 * None of them can stand outside a string in JSON, and inside one the escape reads as the same
 * character, so the output is still JSON and parses to the same values.
 */
export function shownJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, escaped);
}
