// Redaction is shared with the hosted Shared Browser, which embeds the same
// plain script. Desktop bundles it from the workspace package.
export * from "@instafy/browser-action-policy/redaction";
// Masking a page a person sends to the chat (Send page to Octo), shared with
// the Shared Browser's origin.
export { MAX_SENT_PAGE_LINKS, MAX_SENT_PAGE_TEXT_CHARS, maskSentPage, pageLinksInPage } from "@instafy/browser-action-policy/pageCapture";
export type { RawPageLink, SentPageLink, SentPageView } from "@instafy/browser-action-policy/pageCapture";
