/** The steps a host classifies. "choose" picks one option of a list by its label (`ctx.option`). */
export type PersonalBrowserStep = "navigate" | "click" | "type" | "choose" | "submit" | "press";

export type PersonalBrowserStepCategory =
  | "purchase"
  | "transfer"
  | "message"
  | "permission"
  | "credential"
  | "download"
  | "destructive"
  | "may_show_secret"
  | "change"
  | "navigation"
  | "disclosure"
  | "dismiss"
  | "search"
  | "focus"
  | "keyboard"
  | "reveal_secret"
  | "sign_in"
  | "upload"
  | "consent"
  | "sensitive";

export type PersonalBrowserStepRefusalCode =
  | "step_refused_secret"
  | "step_refused_sign_in"
  | "step_refused_upload"
  | "step_refused_consent"
  | "sensitive_input_blocked";

export type PersonalBrowserStepClassification = {
  verdict: "allow" | "ask" | "refuse";
  category: PersonalBrowserStepCategory;
  reason: string;
  code?: PersonalBrowserStepRefusalCode;
  /**
   * Set on an ordinary "change" control whose label commits a change, such as
   * a Save or Speichern button. Never set on a menu item, tab, tree item,
   * disclosure or menu opener, navigation-area item, or a list (a select,
   * combobox or listbox) or its options.
   */
  commit?: boolean;
  /**
   * Set on a cookie or consent banner's button that refuses consent ("Reject
   * all", "Only necessary"), found by its words and by the describer's
   * `consentContext`. It shares nothing, so a host may take it without a
   * prompt in every approval mode. A control or link in the same banner
   * whose words accept is refused instead (`step_refused_consent`), unless
   * the accept is limited to the necessary cookies or to a selection, which
   * asks with `commit`.
   */
  consentRejection?: boolean;
};

export type PersonalBrowserStepContext = {
  /** The current page address, used to tell same-page anchors and same-site searches apart. */
  pageUrl?: string;
  /** The address a navigate step opens. */
  url?: string;
  /** The key a press step sends. */
  key?: string;
  /** The label of the option a choose step picks. */
  option?: string;
  /** Whether the target is a password, code or payment field. */
  sensitive?: boolean;
};

/** Loose descriptor shape; every field is optional. */
export type PersonalBrowserStepTarget = { [field: string]: unknown };

export declare const CATEGORY_TITLES: Readonly<Record<string, string>>;

export declare function classifyStep(
  op: PersonalBrowserStep,
  target: PersonalBrowserStepTarget,
  ctx?: PersonalBrowserStepContext,
): PersonalBrowserStepClassification;
export declare function classifyAddress(url: string): PersonalBrowserStepClassification | null;
export declare function categoryTitle(category: string): string | null;
export declare function refusalFor(
  category: string,
): { code: PersonalBrowserStepRefusalCode; message: string } | null;
export declare function stepLabels(target: PersonalBrowserStepTarget): {
  accessible: string;
  visible: string;
  differ: boolean;
};
/** Page hints for a control with no accessible name or visible text. */
export type UnnamedControlHints = {
  tag?: string | null;
  role?: string | null;
  type?: string | null;
  /** data-bs-original-title, data-original-title, data-tooltip or aria-description. */
  tooltip?: string | null;
  /** Text of the elements aria-describedby names. */
  describedBy?: string | null;
  /** The first image's alt text, an svg title or an icon's own label. */
  image?: string | null;
  /** The control shows an image (an avatar, a logo). */
  hasImage?: boolean;
  /** Icon and class names, as the page describer collects them. */
  iconHint?: string | null;
  /** Where the control sits in the visible page, such as "top right". */
  position?: string | null;
  /** The short text right beside it (controlNameRulesInPage's nearbyTextOf). */
  nearby?: string | null;
};
/** A short generic name such as "profile picture button, top right"; never "button 5". */
export declare function unnamedControlName(hints: UnnamedControlHints): string;
/** Run inside the page from its source: the text a control draws, and the text right beside it. */
export declare function controlNameRulesInPage(): {
  shownTextOf(element: Element, max?: number): string;
  nearbyTextOf(element: Element, max?: number): string;
};
/** True for text that names nothing, such as a bare media type ("image/svg+xml"). */
export declare function isPlaceholderName(value: unknown): boolean;
export declare function isEditable(target: PersonalBrowserStepTarget): boolean;
export declare function isSearchField(target: PersonalBrowserStepTarget): boolean;
/**
 * A field the person fills to sign in and the agent never types into: a
 * password or one-time code field, or the account identifier typing into
 * which is refused as a sign-in. Hosts name these so the agent pauses there.
 */
export declare function isSignInField(target: PersonalBrowserStepTarget): boolean;
/**
 * A link or button that only opens a site's sign-in page ("Sign in", "Log in"
 * outside any form with a password field, never a form's submit button).
 * Hosts name it on a page with no sign-in fields yet, so a sign-in the person
 * needs gets to its fields.
 */
export declare function isSignInOpener(target: PersonalBrowserStepTarget): boolean;
/**
 * Enter in a site's own search box (or typing into it with submit) that a
 * host may let go without a prompt under routine browsing: a known GET
 * submission of the page's own origin in the same tab, to a public address,
 * through a search field the classifier allows, sending at most 64 entries
 * none of which the redaction rules would mask (alone or as "name=value"),
 * to an address that is not risky once those entries are its query.
 * `submittedEntries` are the [name, value] pairs the submission sends: the
 * field with the typed text and the form's other controls, hidden ones and
 * the default button included; a host tests them and keeps none of them.
 */
export declare function isFreeSiteSearch(
  target: PersonalBrowserStepTarget,
  pageUrl: string,
  submittedEntries: readonly (readonly [name: string, value: string])[],
): boolean;
