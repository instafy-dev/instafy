// How a browser step's host reads in the chat: "visitlisboa.com", and
// "münchen.de" rather than "xn--mnchen-3ya.de".
//
// The runtime names a host in lower-case ASCII, with an international name in
// punycode (runtime-contracts' chat_activity.rs). Shown as is, a person would
// not recognise their own city's site. Shown in Unicode, a name that mixes
// scripts can pass for another site ("аpple.com" with a Cyrillic "а"). So a
// name is shown in Unicode only when all its letters are of one script, or of
// one of the script sets a CJK name writes together with Latin (Unicode's
// "highly restrictive" profile, UTS #39); any other name stays in punycode.

const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 128;
const MAX_INT = 0x7fffffff;

function digitOf(codePoint: number): number {
  if (codePoint >= 0x30 && codePoint <= 0x39) return codePoint - 22;
  if (codePoint >= 0x41 && codePoint <= 0x5a) return codePoint - 0x41;
  if (codePoint >= 0x61 && codePoint <= 0x7a) return codePoint - 0x61;
  return BASE;
}

function adapt(delta: number, points: number, first: boolean): number {
  let scaled = first ? Math.floor(delta / DAMP) : delta >> 1;
  scaled += Math.floor(scaled / points);
  let k = 0;
  while (scaled > ((BASE - T_MIN) * T_MAX) >> 1) {
    scaled = Math.floor(scaled / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * scaled) / (scaled + SKEW));
}

/** RFC 3492: the Unicode of one punycode label (without "xn--"), or null when it is not valid. */
export function decodePunycodeLabel(input: string): string | null {
  const output: number[] = [];
  const basicEnd = Math.max(0, input.lastIndexOf("-"));
  for (let index = 0; index < basicEnd; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint >= 0x80) return null;
    output.push(codePoint);
  }
  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  for (let index = basicEnd > 0 ? basicEnd + 1 : 0; index < input.length; ) {
    const before = i;
    let weight = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = digitOf(input.charCodeAt(index));
      index += 1;
      if (digit >= BASE || digit > Math.floor((MAX_INT - i) / weight)) return null;
      i += digit * weight;
      const threshold = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < threshold) break;
      if (weight > Math.floor(MAX_INT / (BASE - threshold))) return null;
      weight *= BASE - threshold;
    }
    const length = output.length + 1;
    bias = adapt(i - before, length, before === 0);
    if (Math.floor(i / length) > MAX_INT - n) return null;
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i, 0, n);
    i += 1;
  }
  return String.fromCodePoint(...output);
}

const SCRIPTS = [
  "Latin", "Greek", "Cyrillic", "Armenian", "Hebrew", "Arabic", "Syriac", "Thaana", "Devanagari", "Bengali",
  "Gurmukhi", "Gujarati", "Oriya", "Tamil", "Telugu", "Kannada", "Malayalam", "Sinhala", "Thai", "Lao", "Tibetan",
  "Myanmar", "Georgian", "Hangul", "Ethiopic", "Khmer", "Mongolian", "Han", "Hiragana", "Katakana", "Bopomofo",
].map((name) => ({ name, pattern: new RegExp(`^\\p{Script=${name}}$`, "u") }));

// The script sets a name may mix (UTS #39, highly restrictive).
const ALLOWED_MIXES: readonly (readonly string[])[] = [
  ["Latin", "Han", "Hiragana", "Katakana"],
  ["Latin", "Han", "Bopomofo"],
  ["Latin", "Han", "Hangul"],
];

/** The scripts of a name's letters, or null when it has a character a host name should not. */
function scriptsOf(text: string): Set<string> | null {
  const scripts = new Set<string>();
  for (const character of text) {
    if (character === "." || character === "-" || /^[0-9]$/u.test(character) || /^\p{M}$/u.test(character)) {
      continue;
    }
    if (!/^\p{L}$/u.test(character)) return null;
    const script = SCRIPTS.find((candidate) => candidate.pattern.test(character));
    if (!script) return null;
    scripts.add(script.name);
  }
  return scripts;
}

function oneScript(scripts: Set<string>): boolean {
  return scripts.size <= 1 || ALLOWED_MIXES.some((mix) => [...scripts].every((script) => mix.includes(script)));
}

/** A host as the chat shows it: in Unicode when it is in one script, otherwise as the runtime named it. */
export function displayActivityHost(host: string): string {
  if (!host.includes("xn--")) {
    return host;
  }
  const labels: string[] = [];
  for (const label of host.split(".")) {
    if (!label.startsWith("xn--")) {
      labels.push(label);
      continue;
    }
    const decoded = decodePunycodeLabel(label.slice(4));
    if (!decoded || decoded.toLowerCase() !== decoded) {
      return host;
    }
    labels.push(decoded);
  }
  const unicode = labels.join(".");
  const scripts = scriptsOf(unicode);
  return scripts && oneScript(scripts) ? unicode : host;
}
