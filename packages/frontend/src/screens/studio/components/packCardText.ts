// Pack-authored card text, cleaned again on read.
//
// The words on the secret card come from the skill that asked, which is a
// SKILL.md fetched from a public repository at run time. The runtime cleans
// them once, before it persists them (packages/runtime-agent/src/jobs/card_text.rs),
// so every client including iOS gets a clean string. This is the second gate:
// messages persisted by an older runtime exist forever, and the card is the
// last line before a DOM node.
//
// Both gates are pinned to the same fixture list, at
// packages/runtime-agent/src/jobs/card_text_fixtures.json, so a rule changed on
// one side and not the other fails a test on both.
//
// The rules reject rather than repair. The card has its own wording for every
// absence, and an absence cannot be made to say anything; a half-sentence a
// pack composed on purpose can.

/** A heading, so an over-long one is refused rather than cut mid-phrase. */
export const MAX_VALUE_LABEL_CHARS = 48;
export const MAX_VALUE_LABEL_WORDS = 6;
export const MAX_DESCRIPTION_CHARS = 200;
export const MAX_WHERE_TO_GET_CHARS = 160;
/** No word a person reads is this long, and an unbreakable one overflows the card. */
export const MAX_UNBROKEN_RUN_CHARS = 30;

export type CardTextField = "valueLabel" | "description" | "whereToGet";

const CAPS: Record<CardTextField, number> = {
  valueLabel: MAX_VALUE_LABEL_CHARS,
  description: MAX_DESCRIPTION_CHARS,
  whereToGet: MAX_WHERE_TO_GET_CHARS,
};

const EM_DASH = "\u2014";
const ELLIPSIS = "\u2026";

/**
 * The curated identity names. A pack may name the product its own card already
 * resolved to, and nothing else: a description saying "Notion" on a card
 * wearing another mark is an attempt to borrow an identity the catalogue did
 * not grant. The last four are not connectors at all; they are the sign-in
 * brands a hostile pack reaches for, so they are never anyone's own name.
 */
const IDENTITY_PRODUCT_NAMES = [
  "slack",
  "notion",
  "github",
  "discord",
  "freefinance",
  "google",
  "apple",
  "microsoft",
  "facebook",
];

/**
 * Our own name. A pack may say what the value lets Instafy do, because that is
 * the sentence the prompt asks it for, but it may never put our name in the
 * card's heading and it may never speak as us: the card is already our surface,
 * so "Instafy verification code" over a real input is first-party chrome a pack
 * did not earn.
 */
const OWN_PRODUCT_NAME = "instafy";
const FIRST_PARTY_AUTHORITY_PHRASES = [
  "instafy support",
  "instafy security",
  "instafy team",
  "instafy staff",
  "instafy admin",
  "instafy will never",
];

/**
 * Claims about what happens to the value. The card says where the value is
 * kept, in our words, one line below whatever the pack wrote; a second claim
 * beside it can only weaken or contradict the first, and the worst of them
 * ("reply in the chat with your login") instructs the person to do the exact
 * thing our caption promises never happens.
 */
const HANDLING_CLAIM_TERMS = [
  "stored",
  "store",
  "saved",
  "kept",
  "encrypted",
  "deleted",
  "secure",
  "safe",
  "sent to",
  "shared with",
  "in the chat",
  "in this chat",
  "reply with",
  "paste it in the chat",
];

/** The values Instafy will not take from anyone, in our words, not the pack's. */
const HUMAN_CREDENTIAL_TERMS = [
  "password",
  "passwords",
  "passphrase",
  "passphrases",
  "passcode",
  "passcodes",
  "pin",
  "pins",
  "cvv",
  "cvc",
  "card number",
  "credit card",
  "debit card",
  "recovery phrase",
  "seed phrase",
  "mnemonic",
  "social security",
  "ssn",
];

/**
 * The refusal classes the card may print, named from this fixed table and never
 * from a pack's own words. Each entry is the class as the card prints it and
 * the name fragments that select it, mirroring REFUSED_CLASSES in card_text.rs.
 */
const REFUSED_CLASS_FRAGMENTS: readonly (readonly [string, readonly string[]])[] = [
  ["password", ["password", "passwd", "pwd"]],
  ["passphrase", ["passphrase"]],
  ["PIN", ["pin"]],
  ["card number", ["cardnumber", "ccnumber", "cvv", "cvc"]],
  ["recovery phrase", ["mnemonic", "seedphrase", "recoveryphrase"]],
];

export const REFUSED_SECRET_CLASSES = REFUSED_CLASS_FRAGMENTS.map(([label]) => label);

// Bidi overrides and isolates, zero width characters, and every C0/C1 control
// that is not a space of some kind. Deleted before anything is measured, so
// neither a reordering nor a padded length survives to the cap. Tab, newline
// and carriage return are left for the collapse below, which turns them into
// one space rather than closing the words up against each other.
// eslint-disable-next-line no-control-regex
const STRIPPED = /[\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const COMBINING_MARK = /\p{M}/u;

/**
 * One ASCII letter for a character that is drawn like one, mirroring
 * fold_confusable in card_text.rs. A name rule that compares literal ASCII is a
 * name rule a pack walks past by spelling Apple with a Cyrillic A, so every
 * term test runs against the skeleton while the card renders the original.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  "\u0430": "a", "\u0410": "a",
  "\u0435": "e", "\u0415": "e",
  "\u043E": "o", "\u041E": "o",
  "\u0440": "p", "\u0420": "p",
  "\u0441": "c", "\u0421": "c",
  "\u0445": "x", "\u0425": "x",
  "\u0443": "y", "\u0423": "y",
  "\u0456": "i", "\u0406": "i",
  "\u0455": "s", "\u0405": "s",
  "\u0458": "j", "\u0408": "j",
  "\u043A": "k", "\u041A": "k",
  "\u043C": "m", "\u041C": "m",
  "\u0442": "t", "\u0422": "t",
  "\u0432": "b", "\u0412": "b",
  "\u043D": "h", "\u041D": "h",
  "\u0433": "r",
  // Greek
  "\u03BF": "o", "\u039F": "o",
  "\u03BD": "n", "\u039D": "n",
  "\u03B1": "a", "\u0391": "a",
  "\u03C1": "p", "\u03A1": "p",
  "\u03B5": "e", "\u0395": "e",
  "\u03B9": "i", "\u0399": "i",
  "\u03BA": "k", "\u039A": "k",
  "\u03C4": "t", "\u03A4": "t",
  "\u03C5": "y", "\u03A5": "y",
  "\u03C7": "x", "\u03A7": "x",
  "\u039C": "m",
  "\u0392": "b",
  "\u0397": "h",
  "\u0396": "z",
  // Dotless Latin and its neighbours
  "\u0131": "i",
  "\u0237": "j",
};

/**
 * The string every term rule reads. NFKD folds the fullwidth and the decorated
 * forms (so a fullwidth s is still a password), the marks come off (so a zalgo
 * run is still the word underneath), the confusable letters become their ASCII
 * twins, and the whole thing lowercases.
 */
function skeleton(text: string): string {
  let out = "";
  for (const char of text.normalize("NFKD")) {
    if (COMBINING_MARK.test(char)) {
      continue;
    }
    out += CONFUSABLES[char] ?? char;
  }
  return out.toLowerCase();
}

/**
 * At most two combining marks on one base. One or two is an accent; a run of
 * forty is a pack drawing a column of its own down our card, and each mark
 * costs it a single character against the cap.
 */
function limitCombiningMarks(text: string): string {
  let out = "";
  let marks = 0;
  for (const char of text) {
    if (COMBINING_MARK.test(char)) {
      if (marks >= 2) {
        continue;
      }
      marks += 1;
    } else {
      marks = 0;
    }
    out += char;
  }
  return out;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word (or whole-phrase) match, so "pinned" is not a PIN. */
function containsTerm(haystack: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeForRegExp(term)}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * A host name written without its scheme. The link rule was scheme-only, so
 * dropping four characters from an example walked a domain onto the card, under
 * the connector's own mark. A trailing sentence full stop is legal because it
 * comes off before the last label is read.
 */
const HOST_SHAPE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+([/?#].*)?$/;

function looksLikeHost(token: string): boolean {
  const trimmed = token.replace(/[.,;:!?]+$/u, "");
  if (!HOST_SHAPE.test(trimmed)) {
    return false;
  }
  const host = trimmed.split(/[/?#]/u)[0] ?? "";
  const labels = host.split(".");
  const last = labels[labels.length - 1] ?? "";
  return last.length >= 2 && /^[A-Za-z]+$/.test(last);
}

/**
 * Box drawing, block elements and geometric shapes. No honest sentence about a
 * provider's screen needs one, and every one of them is a brick in a banner the
 * pack is drawing for itself.
 */
function isDrawingCharacter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x2500 && code <= 0x25ff) || (code >= 0x2b00 && code <= 0x2bff);
}

/**
 * Punctuation for the repetition rule: anything that is neither a letter, a
 * digit nor a space. Box drawing characters are not punctuation to Unicode, but
 * a run of them is how a pack draws chrome we did not draw, which is the thing
 * the rule exists to stop.
 */
function isRulePunctuation(char: string): boolean {
  return !/[\p{L}\p{N}]/u.test(char) && !/\s/u.test(char);
}

function hasPunctuationRun(text: string): boolean {
  let runChar: string | null = null;
  let runLength = 0;
  for (const char of text) {
    if (isRulePunctuation(char) && char === runChar) {
      runLength += 1;
      if (runLength >= 3) {
        return true;
      }
      continue;
    }
    runChar = isRulePunctuation(char) ? char : null;
    runLength = 1;
  }
  return false;
}

/**
 * The one product name this string may contain. The resolved connector's name
 * when the catalogue claimed the request; otherwise the product the asking
 * skill's own folder name is built from, so a pack declaring
 * skill "google-calendar" may write "Google" while a card wearing Notion's mark
 * still may not. A resolved owner always wins.
 */
function allowedIdentity(owner: string | null, skillSlug: string | null): string | null {
  if (owner) {
    return owner.toLowerCase();
  }
  const slug = (skillSlug ?? "").trim().toLowerCase();
  if (!slug) {
    return null;
  }
  const parts = slug.split("-");
  return IDENTITY_PRODUCT_NAMES.find((product) => parts.includes(product)) ?? null;
}

function rejects(text: string, allowed: string | null, field: CardTextField): boolean {
  // Markup, a Markdown link, code formatting, a link of any kind, and the em
  // dash the file-level copy gate cannot reach at run time.
  if (/<\S/.test(text) || text.includes("](") || text.includes("`") || text.includes(EM_DASH)) {
    return true;
  }
  const lower = text.toLowerCase();
  if (lower.includes("http://") || lower.includes("https://") || lower.includes("www.")) {
    return true;
  }
  // A host with the scheme dropped is still a place to be sent.
  if (lower.split(/\s+/u).some(looksLikeHost)) {
    return true;
  }
  if (hasPunctuationRun(text)) {
    return true;
  }
  // The same banner with a space or an alternation in it defeats a run rule and
  // nothing else about it is honest. One drawing character is enough, and rule
  // punctuation over a quarter of the string is a drawing whatever glyphs it
  // used.
  const characters = [...text];
  if (characters.some(isDrawingCharacter)) {
    return true;
  }
  const dense = characters.filter((char) => !/\s/u.test(char)).length;
  const punctuation = characters.filter(isRulePunctuation).length;
  if (punctuation * 4 > dense) {
    return true;
  }

  // Everything below reads the skeleton, so a confusable letter cannot buy a
  // pack a word our table holds.
  const skeletonText = skeleton(lower);
  let run = 0;
  for (const char of skeletonText) {
    if (/\s/u.test(char)) {
      run = 0;
      continue;
    }
    run += 1;
    if (run > MAX_UNBROKEN_RUN_CHARS) {
      return true;
    }
  }
  if (HUMAN_CREDENTIAL_TERMS.some((term) => containsTerm(skeletonText, term))) {
    return true;
  }
  if (HANDLING_CLAIM_TERMS.some((term) => containsTerm(skeletonText, term))) {
    return true;
  }
  if (FIRST_PARTY_AUTHORITY_PHRASES.some((phrase) => containsTerm(skeletonText, phrase))) {
    return true;
  }
  // Our own name is never a heading a pack writes. It stays legal in a
  // sentence, because "what this value lets Instafy do" is the sentence the
  // prompt asks the pack for.
  if (field === "valueLabel" && containsTerm(skeletonText, OWN_PRODUCT_NAME)) {
    return true;
  }
  return IDENTITY_PRODUCT_NAMES.some(
    (product) => product !== allowed && containsTerm(skeletonText, product),
  );
}

/**
 * The owner's own name, off the front of a heading the card is about to put
 * that name in front of. "Notion Installation access token" is a heading a pack
 * derives honestly from a "What it is" cell, and rendering it whole makes the
 * card's largest text read "Notion Notion Installation access token".
 */
function stripLeadingOwner(text: string, owner: string | null): string {
  const name = (owner ?? "").trim();
  if (!name) {
    return text;
  }
  const head = [...text].slice(0, [...name].length).join("");
  if (head.toLowerCase() !== name.toLowerCase()) {
    return text;
  }
  const rest = [...text].slice([...name].length).join("");
  if (rest.length === 0) {
    // The heading was the owner's name and nothing else, so it is an absence:
    // the card says "Connect Notion" rather than "Notion Notion".
    return "";
  }
  return /^\s/u.test(rest) ? rest.trimStart() : text;
}

function truncateAtWord(text: string, cap: number): string {
  const chars = [...text];
  if (chars.length <= cap) {
    return text;
  }
  const head = chars.slice(0, cap - 1);
  // Both gates count characters here. Comparing an index into the string
  // against a character cap cut a Cyrillic sentence in a different place from
  // the runtime's, which is drift in the one thing the shared fixtures exist to
  // prevent.
  const lastSpace = head.lastIndexOf(" ");
  const cut = lastSpace >= Math.floor(cap / 2) ? head.slice(0, lastSpace) : head;
  let end = cut.length;
  while (end > 0) {
    const char = cut[end - 1]!;
    if (/\s/u.test(char) || isRulePunctuation(char)) {
      end -= 1;
      continue;
    }
    break;
  }
  const trimmed = cut.slice(0, end).join("");
  return trimmed.length > 0 ? `${trimmed}${ELLIPSIS}` : "";
}

/**
 * One pack-authored string, ready to be put in a DOM node, or null.
 *
 * `owner` is the resolved connector's product name: the one product name this
 * string may contain. When nothing resolved, `skillSlug` stands in for it, so a
 * pack whose folder is "google-calendar" may write "Google" while a card that
 * resolved to Notion may still write only "Notion". Pass both as null and every
 * catalogue name rejects.
 */
export function sanitizeCardText(
  value: unknown,
  field: CardTextField,
  owner: string | null = null,
  skillSlug: string | null = null,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const collapsed = limitCombiningMarks(value.normalize("NFC").replace(STRIPPED, ""))
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .join(" ");
  if (!collapsed) {
    return null;
  }
  if (rejects(collapsed, allowedIdentity(owner, skillSlug), field)) {
    return null;
  }
  const cap = CAPS[field];
  if (field === "valueLabel") {
    // The card puts the product name in front of this heading, so the pack's
    // own copy of it comes off before anything is measured.
    const heading = stripLeadingOwner(collapsed, owner);
    if (!heading || [...heading].length > cap) {
      return null;
    }
    // A heading, so a trailing full stop is dropped rather than shown: the card
    // puts the product name in front of it and never a sentence after it.
    const trimmed = heading.replace(/[.!?]+$/u, "").trim();
    if (!trimmed) {
      return null;
    }
    if (trimmed.split(" ").filter(Boolean).length > MAX_VALUE_LABEL_WORDS) {
      return null;
    }
    return trimmed;
  }
  const capped = truncateAtWord(collapsed, cap);
  return capped.length > 0 ? capped : null;
}

/** The folder name under .agents/skills, reduced to what a folder name may be. */
export function sanitizeSkillSlug(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 && slug.length <= 64 ? slug : null;
}

/**
 * The class of human login credential this variable name asks for, if any, by
 * the same table and the same rules as refused_secret_class in card_text.rs.
 * The runtime refuses these on the way in; this gate refuses them again on the
 * way out, because a message an older runtime persisted outlives the deploy and
 * the card is the last line before a DOM node.
 */
export function refusedSecretClass(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const lower = value.toLowerCase();
  const squashed = lower.replace(/[^a-z0-9]/g, "");
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  for (const [label, fragments] of REFUSED_CLASS_FRAGMENTS) {
    for (const fragment of fragments) {
      // "pin" is a whole word: PIN_CODE is refused, PINNED_REPO is not.
      const matched =
        fragment === "pin" ? tokens.includes("pin") : squashed.includes(fragment);
      if (matched) {
        return label;
      }
    }
  }
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const pair = `${tokens[index]} ${tokens[index + 1]}`;
    if (pair === "card number") {
      return "card number";
    }
    if (pair === "recovery phrase" || pair === "seed phrase") {
      return "recovery phrase";
    }
  }
  return null;
}

/**
 * The refusal class the card prints, or null. Only a key from our own table is
 * accepted: the runtime refuses the request, and the card names the class in
 * our words rather than repeating whatever the pack called it.
 */
export function normalizeRefusedSecretClass(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const needle = value.trim().toLowerCase();
  return REFUSED_SECRET_CLASSES.find((entry) => entry.toLowerCase() === needle) ?? null;
}

/**
 * True when the name is one we understand well enough to write to. Validated,
 * never cleaned: a name that needs repairing is a name we do not understand,
 * and guessing at a destination is the one failure this card cannot have.
 */
export function isValidSecretName(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value.trim());
}
