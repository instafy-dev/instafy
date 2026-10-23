export type PersonalBrowserStep = "navigate" | "click" | "type" | "submit" | "press";

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
  | "sensitive";

export type PersonalBrowserStepRefusalCode =
  | "step_refused_secret"
  | "step_refused_sign_in"
  | "step_refused_upload"
  | "sensitive_input_blocked";

export type PersonalBrowserStepClassification = {
  verdict: "allow" | "ask" | "refuse";
  category: PersonalBrowserStepCategory;
  reason: string;
  code?: PersonalBrowserStepRefusalCode;
  /** Set on an ordinary "change" control whose label commits a change, such as Save or Speichern. */
  commit?: boolean;
};

export type PersonalBrowserStepContext = {
  /** The current page address, used to tell same-page anchors and same-site searches apart. */
  pageUrl?: string;
  /** The address a navigate step opens. */
  url?: string;
  /** The key a press step sends. */
  key?: string;
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
export declare function isEditable(target: PersonalBrowserStepTarget): boolean;
export declare function isSearchField(target: PersonalBrowserStepTarget): boolean;
