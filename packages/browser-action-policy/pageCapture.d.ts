import type { PageSecretSignals } from "./redaction";

export type PagePolicySources = {
  kind: "page-policy";
  secretPatterns: string[];
  credentialContext: string;
  placeholder: string;
  maskedText: string;
};

/** One page a person chose to send, masked. A secret screen carries no title or text. */
export type SentPageView = {
  url: string;
  title: string;
  text: string;
  secretScreen: boolean;
  /** The page had more text than one sent page carries. */
  truncated: boolean;
};

type RedactionApi = typeof import("./redaction");

export declare const MAX_SENT_PAGE_TEXT_CHARS: number;
export declare const SENT_PAGE_MASK_MARGIN_CHARS: number;
export declare function pagePolicySources(redaction: RedactionApi): PagePolicySources;
export declare function pageSecretSignalsInPage(sources: PagePolicySources): PageSecretSignals | null;
export declare function maskSentPage(
  redaction: Pick<RedactionApi, "redactUrl" | "redactPageObservation">,
  page: { url: string; title: string; text: string; signals: PageSecretSignals | null } | null,
  options?: { withhold?: boolean },
): SentPageView;
export declare function captureSentPage(
  redaction: RedactionApi,
  options?: { withhold?: boolean },
): SentPageView | { unsupported: true };
