/**
 * The rules the controller saves an AI connection's name by
 * (`packages/runtime-controller/src/credential_labels.rs`), so Studio never
 * sends a name it would refuse. `credential_label_fixtures.json`, beside that
 * file, pins both copies.
 *
 * A connection's name is also the display name of the agent made for it, and
 * teammates see that agent, so a name holds no email address.
 */

/** The most characters a name has once trimmed, counted as code points. */
export const CREDENTIAL_LABEL_MAX_LENGTH = 60;

export const CREDENTIAL_LABEL_INVALID_MESSAGE = "Use a name of 1 to 60 characters on one line.";
export const CREDENTIAL_LABEL_HAS_EMAIL_MESSAGE =
  "Leave the email address out of the name. Teammates see it on this connection's agent.";

export type CredentialLabelCheck =
  | { ok: true; label: string }
  | {
      ok: false;
      code: "credential_label_invalid" | "credential_label_has_email";
      message: string;
    };

// Unicode's White_Space, which Rust's `str::trim` trims: unlike
// `String.prototype.trim`, it keeps U+FEFF and trims U+0085.
const EDGE_WHITE_SPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;
const CONTROL = /^\p{Cc}$/u;
// In a `u` pattern only a lone surrogate matches, which no Rust string holds.
const LONE_SURROGATE = /^\p{Cs}$/u;
const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;
// The default-ignorable characters a name keeps, because scripts and emoji
// need them: the zero-width non-joiner and joiner, and the variation selectors.
const KEPT_IN_NAMES = /^[\u200C\u200D\p{Variation_Selector}]$/u;
const COMBINING_MARK = /^\p{M}$/u;
const ALPHANUMERIC = /^[\p{Alphabetic}\p{N}]$/u;
const ALPHABETIC = /^\p{Alphabetic}$/u;
const AT_SIGNS = new Set(["@", "\uFF20", "\uFE6B"]);
const DOMAIN_DOTS = new Set([".", "\uFF0E", "\uFF61", "\u3002", "\uFE52", "\u2024"]);
const LOCAL_PART_PUNCTUATION = new Set(Array.from("!#$%&'*+-/=?^_`{|}~."));

const BLACK_FLAG = "\u{1F3F4}";
const CANCEL_TAG = "\u{E007F}";
const TAG_SPEC = /^[\u{E0020}-\u{E007E}]$/u;

/**
 * Where an emoji tag sequence that starts at `start` ends, past its last
 * character, when one does: the black flag, one or more tag characters
 * U+E0020 to U+E007E, and the cancel tag, as Unicode writes the flags of
 * England, Scotland and Wales.
 */
function emojiTagSequenceEnd(characters: string[], start: number): number | null {
  if (characters[start] !== BLACK_FLAG) {
    return null;
  }
  let index = start + 1;
  while (index < characters.length && TAG_SPEC.test(characters[index])) {
    index += 1;
  }
  return index > start + 1 && characters[index] === CANCEL_TAG ? index + 1 : null;
}

/**
 * Whether a name holds a control character, a line or paragraph separator, or
 * a default-ignorable character a name does not keep: the text-direction marks
 * and the ones that show nothing could make a name read as something else,
 * hide an email address, or be a whole name that looks empty. The tag
 * characters of a well-formed emoji tag sequence are kept; any other tag
 * character is refused.
 */
function breaksAOneLineName(characters: string[]): boolean {
  let index = 0;
  while (index < characters.length) {
    const end = emojiTagSequenceEnd(characters, index);
    if (end !== null) {
      index = end;
      continue;
    }
    const character = characters[index];
    if (
      CONTROL.test(character) ||
      LONE_SURROGATE.test(character) ||
      character === "\u2028" ||
      character === "\u2029" ||
      (DEFAULT_IGNORABLE.test(character) && !KEPT_IN_NAMES.test(character))
    ) {
      return true;
    }
    index += 1;
  }
  return false;
}

function isDomainCharacter(character: string): boolean {
  return (
    ALPHANUMERIC.test(character) ||
    character === "-" ||
    DOMAIN_DOTS.has(character) ||
    COMBINING_MARK.test(character)
  );
}

function isEmailDomain(domain: string[]): boolean {
  // A full stop that ends the sentence is not part of the address.
  let end = domain.length;
  while (end > 0 && DOMAIN_DOTS.has(domain[end - 1])) {
    end -= 1;
  }
  const parts: string[][] = [[]];
  for (const character of domain.slice(0, end)) {
    if (DOMAIN_DOTS.has(character)) {
      parts.push([]);
    } else {
      parts[parts.length - 1].push(character);
    }
  }
  const last = parts[parts.length - 1];
  return (
    parts.length >= 2 &&
    parts.every((part) => part.length > 0) &&
    last.length >= 2 &&
    last.some((character) => ALPHABETIC.test(character))
  );
}

/**
 * Whether `text` holds an email address: an at sign with a character of an
 * address's local part right before it and a domain of two or more parts after
 * it, the last of two or more characters with a letter among them. It reads
 * the text as a person sees it: in NFKC form, without default-ignorable
 * characters, and with each combining mark part of the letter it sits on.
 */
export function holdsEmailAddress(text: string): boolean {
  const characters = Array.from(text.normalize("NFKC")).filter(
    (character) => !DEFAULT_IGNORABLE.test(character),
  );
  return characters.some((character, at) => {
    if (!AT_SIGNS.has(character)) {
      return false;
    }
    let before = at - 1;
    while (before >= 0 && COMBINING_MARK.test(characters[before])) {
      before -= 1;
    }
    if (before < 0) {
      return false;
    }
    const previous = characters[before];
    if (!ALPHANUMERIC.test(previous) && !LOCAL_PART_PUNCTUATION.has(previous)) {
      return false;
    }
    const domain: string[] = [];
    for (const next of characters.slice(at + 1)) {
      if (!isDomainCharacter(next)) {
        break;
      }
      domain.push(next);
    }
    return isEmailDomain(domain);
  });
}

/** `raw` trimmed when the controller would save a connection with it, or why not. */
export function checkCredentialLabel(raw: string): CredentialLabelCheck {
  const label = raw.replace(EDGE_WHITE_SPACE, "");
  const characters = Array.from(label);
  if (
    characters.length === 0 ||
    characters.length > CREDENTIAL_LABEL_MAX_LENGTH ||
    breaksAOneLineName(characters)
  ) {
    return { ok: false, code: "credential_label_invalid", message: CREDENTIAL_LABEL_INVALID_MESSAGE };
  }
  if (holdsEmailAddress(label)) {
    return { ok: false, code: "credential_label_has_email", message: CREDENTIAL_LABEL_HAS_EMAIL_MESSAGE };
  }
  return { ok: true, label };
}

/** A saved name, trimmed, when it follows the rules; null when it is missing or does not. */
export function savableCredentialLabel(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const check = checkCredentialLabel(raw);
  return check.ok ? check.label : null;
}

/** `value` cut to the most characters a name has, counted as the controller counts them. */
export function clampCredentialLabel(value: string): string {
  const characters = Array.from(value);
  return characters.length > CREDENTIAL_LABEL_MAX_LENGTH
    ? characters.slice(0, CREDENTIAL_LABEL_MAX_LENGTH).join("")
    : value;
}
