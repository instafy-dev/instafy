import { createHash, timingSafeEqual } from "node:crypto";

import {
  classifyStep,
  isEditable as isPolicyEditable,
  isSearchField as isPolicySearchField,
  type PersonalBrowserStep,
  type PersonalBrowserStepClassification,
  type PersonalBrowserStepContext,
} from "./personalBrowserActionPolicy";

export const PERSONAL_BROWSER_PARTITION_PREFIX = "persist:instafy-personal-";
export const MAX_PERSONAL_BROWSER_URL_LENGTH = 4_096;
export const MAX_PERSONAL_BROWSER_TEXT_LENGTH = 16_384;
export type PersonalBrowserApprovalMode = "ask" | "routine";

export function normalizePersonalBrowserApprovalMode(value: unknown): PersonalBrowserApprovalMode {
  if (value === undefined || value === "ask") return "ask";
  if (value === "routine") return "routine";
  throw new Error("Personal Browser approval mode must be ask or routine.");
}
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PersonalBrowserBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
  visible?: boolean;
  occluded?: boolean;
  /** Decorative activity only; never grants control. */
  agentWorking?: boolean;
};

export type PersonalBrowserEditableDescriptor = {
  tag?: string | null;
  type?: string | null;
  name?: string | null;
  id?: string | null;
  autocomplete?: string | null;
  ariaLabel?: string | null;
  placeholder?: string | null;
  inputMode?: string | null;
};

export type PersonalBrowserActionDescriptor = {
  tag?: string | null;
  role?: string | null;
  type?: string | null;
  text?: string | null;
  ariaLabel?: string | null;
  title?: string | null;
  value?: string | null;
  href?: string | null;
  /** Empty means no native form owner; absent means ownership was not observed. */
  formOwnerIdentity?: string | null;
  formActionText?: string | null;
  /** The clicked element is the link itself, not a child inheriting its address. */
  linkSelf?: boolean;
  download?: boolean;
  formMethod?: string | null;
  formActionUrl?: string | null;
  formHasPassword?: boolean;
  /** Number of password fields in the owning form. */
  formPasswordCount?: number;
  /** The element is the text field right before its form's first password field. */
  signInIdentifier?: boolean;
  formFieldCount?: number;
  /** Every submit label of the owning form, at most 200 characters. */
  formSubmitLabels?: string | null;
  /** Enclosing page areas, nearest first: dialog, search, nav, menu, tree, tablist, pagination. */
  areas?: string | null;
  /** Whether the element opens a menu or popup; never whether it is open now. */
  menuOpener?: boolean;
  /** A heading, dialog title or row around the element names a credential. */
  credentialContext?: boolean;
  contentEditable?: boolean;
  /** The element is, or sits in, a table row or list entry. */
  row?: boolean;
  /** Nearest dialog title, heading and row text, at most 200 characters. Not part of the fingerprint. */
  contextLabel?: string | null;
  /** Masked text such as •••• sits next to the element. Not part of the fingerprint. */
  nearMaskedText?: boolean;
  /** Icon class names and similar hints. Not part of the fingerprint. */
  iconHint?: string | null;
};

export type PersonalBrowserActivationTarget = PersonalBrowserActionDescriptor &
  PersonalBrowserEditableDescriptor & {
    identity?: string | null;
    disabled?: boolean;
  };

export const PERSONAL_BROWSER_SECURITY_FINGERPRINT_FIELDS = [
  "identity",
  "tag",
  "role",
  "type",
  "name",
  "id",
  "autocomplete",
  "ariaLabel",
  "placeholder",
  "inputMode",
  "text",
  "title",
  "value",
  "href",
  "formOwnerIdentity",
  "formActionText",
  "disabled",
  // Structural fields only. Whether a menu is open right now and heading text
  // stay out, so opening a menu does not cancel a pending approval.
  "linkSelf",
  "download",
  "formMethod",
  "formActionUrl",
  "formHasPassword",
  "formFieldCount",
  "areas",
  "menuOpener",
  "credentialContext",
  "contentEditable",
  "row",
] as const;

const SENSITIVE_EDITABLE_PATTERN =
  /(?:\bpass(?:word|code|phrase)?\b|\bpin\b|\bone[\s_-]*time\b|\botp\b|\b2fa\b|\bmfa\b|\bverification[\s_-]*code\b|\bsecurity[\s_-]*code\b|\bcvv\b|\bcvc\b|\bcard[\s_-]*(?:number|code)\b|\bcredit[\s_-]*card\b|\bdebit[\s_-]*card\b|\bpayment\b)/i;

const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
  "current-password",
  "new-password",
  "one-time-code",
  "cc-number",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-name",
]);

const HIGH_IMPACT_ACTION_PATTERN =
  /(?:\b(?:buy|purchase|pay|checkout|place[\s_-]*order|delete|remove|erase|destroy|send|post|publish|submit|authorize|approve|allow|confirm[\s_-]*(?:order|payment|purchase)|transfer|withdraw|book|reserve|sign[\s_-]*(?:contract|document|agreement))\b)/i;

const ALLOWED_PRESS_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Backspace",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  " ",
]);

const ACTIVATION_KEYS = new Set(["Enter", " "]);
const SENSITIVE_MUTATION_KEYS = new Set(["Enter", " ", "Backspace", "Delete"]);

function requireFiniteInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return Math.round(value);
}

export function isPersonalBrowserFeatureEnabled(value: string | undefined): boolean {
  if (typeof value !== "string" || !value.trim()) {
    return true;
  }
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export function normalizePersonalBrowserProfileKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Personal Browser requires a local profile key.");
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > 512) {
    throw new Error("Personal Browser profile key must be between 1 and 512 characters.");
  }
  return normalized;
}

export function normalizePersonalBrowserProfileUserId(value: unknown): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw new Error("Personal Browser requires a valid profileUserId UUID.");
  }
  return value.trim().toLowerCase();
}

export function derivePersonalBrowserPartition(profileKey: unknown): string {
  const normalized = normalizePersonalBrowserProfileKey(profileKey);
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  return `${PERSONAL_BROWSER_PARTITION_PREFIX}${digest.slice(0, 40)}`;
}

export function normalizePersonalBrowserUrl(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "about:blank";
  }
  if (typeof value !== "string") {
    throw new Error("Personal Browser URL must be a string.");
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_PERSONAL_BROWSER_URL_LENGTH) {
    throw new Error("Personal Browser URL is empty or too long.");
  }
  if (trimmed.toLowerCase() === "about:blank") {
    return "about:blank";
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Personal Browser URL must be an absolute http or https URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Personal Browser only supports http, https, and about:blank URLs.");
  }
  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new Error("Personal Browser URL must not contain credentials.");
  }
  return parsed.toString();
}

export function getPersonalBrowserOrigin(value: unknown): string | null {
  const normalized = normalizePersonalBrowserUrl(value);
  if (normalized === "about:blank") {
    return null;
  }
  return new URL(normalized).origin;
}

export function normalizePersonalBrowserBounds(value: unknown): PersonalBrowserBounds {
  if (!value || typeof value !== "object") {
    throw new Error("Personal Browser bounds are required.");
  }
  const candidate = value as Record<string, unknown>;
  const x = requireFiniteInteger(candidate.x, "bounds.x");
  const y = requireFiniteInteger(candidate.y, "bounds.y");
  const width = requireFiniteInteger(candidate.width, "bounds.width");
  const height = requireFiniteInteger(candidate.height, "bounds.height");
  if (x < 0 || y < 0 || width < 1 || height < 1) {
    throw new Error("Personal Browser bounds must be positive and start inside the window.");
  }
  if (x > 100_000 || y > 100_000 || width > 100_000 || height > 100_000) {
    throw new Error("Personal Browser bounds exceed the supported range.");
  }
  return {
    x,
    y,
    width,
    height,
    ...(typeof candidate.visible === "boolean" ? { visible: candidate.visible } : {}),
    ...(typeof candidate.occluded === "boolean" ? { occluded: candidate.occluded } : {}),
    ...(typeof candidate.agentWorking === "boolean" ? { agentWorking: candidate.agentWorking } : {}),
  };
}

export function normalizePersonalBrowserElementIndex(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 499) {
    throw new Error("index must be an integer between 0 and 499.");
  }
  return value;
}

export function requirePersonalBrowserTarget(value: { selector?: unknown; index?: unknown }): {
  index: number;
} {
  if (value.selector !== undefined) {
    throw new Error("Personal Browser actions accept snapshot indices only.");
  }
  const index = normalizePersonalBrowserElementIndex(value.index);
  if (index === undefined) {
    throw new Error("A snapshot index is required.");
  }
  return { index };
}

export function normalizePersonalBrowserText(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("text must be a string.");
  }
  if (value.length > MAX_PERSONAL_BROWSER_TEXT_LENGTH) {
    throw new Error("text exceeds the Personal Browser limit.");
  }
  return value;
}

export function normalizePersonalBrowserPressKey(value: unknown): string {
  if (typeof value !== "string" || !ALLOWED_PRESS_KEYS.has(value)) {
    throw new Error("key is not allowed by the Personal Browser control API.");
  }
  return value;
}

export function normalizePersonalBrowserScroll(value: unknown): { x: number; y: number } {
  const candidate = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const normalizeAxis = (axis: "x" | "y") => {
    const raw = candidate[axis] ?? 0;
    const amount = requireFiniteInteger(raw, `scroll.${axis}`);
    return Math.max(-10_000, Math.min(10_000, amount));
  };
  const x = normalizeAxis("x");
  const y = normalizeAxis("y");
  if (x === 0 && y === 0) {
    throw new Error("scroll requires a non-zero x or y amount.");
  }
  return { x, y };
}

function descriptorText(value: PersonalBrowserEditableDescriptor): string {
  return [value.tag, value.type, value.name, value.id, value.ariaLabel, value.placeholder, value.inputMode]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

export function isSensitivePersonalBrowserEditable(
  value: PersonalBrowserEditableDescriptor,
): boolean {
  const type = value.type?.trim().toLowerCase();
  if (type === "password") {
    return true;
  }
  const autocomplete = value.autocomplete?.trim().toLowerCase() ?? "";
  if (
    autocomplete
      .split(/\s+/)
      .some((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.has(token) || token.startsWith("cc-"))
  ) {
    return true;
  }
  return SENSITIVE_EDITABLE_PATTERN.test(descriptorText(value));
}

export function isHighImpactPersonalBrowserAction(
  value: PersonalBrowserActionDescriptor,
): boolean {
  const text = [value.text, value.ariaLabel, value.title, value.value, value.href, value.formActionText]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
  return HIGH_IMPACT_ACTION_PATTERN.test(text);
}

/**
 * Classifies one agent step. Refusals apply in every approval mode; the
 * category names the approval dialog.
 */
export function classifyPersonalBrowserStep(
  step: PersonalBrowserStep,
  value: PersonalBrowserActivationTarget,
  context: Omit<PersonalBrowserStepContext, "sensitive"> = {},
): PersonalBrowserStepClassification {
  return classifyStep(step, value, {
    ...context,
    sensitive: isSensitivePersonalBrowserEditable(value),
  });
}

export function personalBrowserActivationRequiresConfirmation(
  value: PersonalBrowserActionDescriptor,
  approvalMode: PersonalBrowserApprovalMode = "ask",
): boolean {
  const tag = value.tag?.trim().toLowerCase();
  const role = value.role?.trim().toLowerCase();
  const type = value.type?.trim().toLowerCase();
  if (approvalMode === "routine") {
    return isHighImpactPersonalBrowserAction(value);
  }
  return (
    isHighImpactPersonalBrowserAction(value) ||
    tag === "button" ||
    tag === "a" ||
    role === "button" ||
    role === "link" ||
    Boolean(value.href) ||
    (tag === "input" && ["button", "submit", "image"].includes(type ?? "")) ||
    // Ask mode also asks for checkboxes, switches, menu items and
    // script-driven controls unless they are structurally free.
    classifyPersonalBrowserStep("click", value).verdict === "ask"
  );
}

export function isPersonalBrowserActivationKey(key: string): boolean {
  return ACTIVATION_KEYS.has(key);
}

export function personalBrowserKeyRequiresConfirmation(
  key: string,
  value: PersonalBrowserActionDescriptor,
  approvalMode: PersonalBrowserApprovalMode = "ask",
): boolean {
  // The session-wide routine grant also covers ordinary keyboard submissions.
  if (approvalMode === "routine") {
    return isPersonalBrowserActivationKey(key) && isHighImpactPersonalBrowserAction(value);
  }
  return (
    isPersonalBrowserActivationKey(key) &&
    (personalBrowserActivationRequiresConfirmation(value) ||
      (key === "Enter" && Boolean(value.formOwnerIdentity?.trim() || value.formActionText?.trim())) ||
      // A chat box can send on keydown without any form. Enter on a field
      // that is not proven to be search asks.
      (key === "Enter" && isPolicyEditable(value) && !isPolicySearchField(value)))
  );
}

export function personalBrowserKeyMutatesSensitiveField(key: string): boolean {
  return SENSITIVE_MUTATION_KEYS.has(key);
}

export function personalBrowserTargetSecurityFingerprint(
  descriptor: PersonalBrowserActivationTarget,
): string {
  const source = descriptor as Record<string, unknown>;
  return JSON.stringify(
    Object.fromEntries(
      PERSONAL_BROWSER_SECURITY_FINGERPRINT_FIELDS.map((field) => [
        field,
        field === "disabled" ? source[field] === true : source[field] ?? "",
      ]),
    ),
  );
}

export function personalBrowserActivationTargetsMatch(
  expected: { url: string; origin: string | null; descriptor: PersonalBrowserActivationTarget },
  current: { url: string; origin: string | null; descriptor: PersonalBrowserActivationTarget },
  options: { compareSecurity?: boolean } = {},
): boolean {
  if (
    !expected.descriptor.identity ||
    expected.url !== current.url ||
    expected.origin !== current.origin ||
    expected.descriptor.identity !== current.descriptor.identity
  ) {
    return false;
  }
  return (
    options.compareSecurity === false ||
    personalBrowserTargetSecurityFingerprint(expected.descriptor) ===
      personalBrowserTargetSecurityFingerprint(current.descriptor)
  );
}

export function sanitizePersonalBrowserBrokerStatus<
  T extends { url: string; title?: string },
>(status: T, mayExposePageIdentity: boolean): T {
  if (mayExposePageIdentity) {
    return status;
  }
  const sanitized = { ...status, url: "" };
  delete sanitized.title;
  return sanitized;
}

export function readPersonalBrowserBearerToken(value: string | string[] | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(value.trim());
  return match?.[1] ?? null;
}

export function constantTimePersonalBrowserTokenMatch(actual: string | null, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function isAllowedPersonalBrowserControlHost(value: string | undefined, port: number): boolean {
  return value === `127.0.0.1:${port}`;
}
