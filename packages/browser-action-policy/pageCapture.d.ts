import type { PageSecretSignals } from "./redaction";

export type PagePolicySources = {
  kind: "page-policy";
  secretPatterns: string[];
  credentialContext: string;
  placeholder: string;
  maskedText: string;
  digitCode: string;
  codeWord: string;
  codeNearby: number;
};

/** One link of a sent page, masked. `linkOnly` names the link-only site it leads to. */
export type SentPageLink = { text: string; href: string; linkOnly?: string };

/** A link as the page lists it, before masking. */
export type RawPageLink = { text: string; href: string };

/** One page a person chose to send, masked. A secret screen carries no title, text or links. */
export type SentPageView = {
  url: string;
  title: string;
  text: string;
  secretScreen: boolean;
  /** The page had more text than one sent page carries. */
  truncated: boolean;
  /** Its web links, at most MAX_SENT_PAGE_LINKS; none when link-only sites could not be told apart. */
  links: SentPageLink[];
};

type RedactionApi = typeof import("./redaction");

export declare const MAX_SENT_PAGE_TEXT_CHARS: number;
export declare const MAX_SENT_PAGE_LINKS: number;
export declare const SENT_PAGE_MASK_MARGIN_CHARS: number;
export declare function pagePolicySources(redaction: RedactionApi): PagePolicySources;
export declare function pageSecretSignalsInPage(sources: PagePolicySources): PageSecretSignals | null;
export declare function pageLinksInPage(limit: number): RawPageLink[];
export declare function maskSentPage(
  redaction: Pick<RedactionApi, "redactUrl" | "redactPageObservation">,
  page: { url: string; title: string; text: string; signals: PageSecretSignals | null; links?: RawPageLink[] } | null,
  options?: { withhold?: boolean; linkOnlySite?: ((address: string) => string | null) | null },
): SentPageView;
export declare function captureSentPage(
  redaction: RedactionApi,
  options?: { withhold?: boolean; linkOnly?: { api: typeof import("./linkOnly"); sites: unknown } | null },
): SentPageView | { unsupported: true };
