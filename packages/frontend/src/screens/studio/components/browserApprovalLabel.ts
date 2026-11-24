/**
 * The runtime leads a browser prompt's label with the step's category, so a
 * person sees what kind of step it is without a protocol change: "Delete,
 * cancel or sign out: Delete account". The titles are the runtime's own
 * fixed list (`CATEGORY_TITLES` in `@instafy/browser-action-policy`), never
 * page text. Studio quotes only the control's name and says the category,
 * when it adds something, in a sentence of its own. An ordinary step's
 * category ("Change something") adds nothing.
 */
const CATEGORY_NOTES: ReadonlyArray<readonly [title: string, note: string | null]> = [
  ["Purchase or payment", "It may buy something or start a payment."],
  ["Money transfer", "It may move money."],
  ["Send a message", "It may send a message as you."],
  ["Sharing or access change", "It may share something or change who has access."],
  ["Key or password change", "It may change a key or password."],
  ["Download or export", "It may download or export data."],
  ["Delete, cancel or sign out", "It may delete, cancel or sign out of something."],
  ["May show a secret", "It may show a key or another secret."],
  ["Change something", null],
];

export type BrowserApprovalLabel = {
  /** The control's own name, as the runtime masked it. */
  label: string;
  /** What the category adds, as one sentence, or null. */
  note: string | null;
};

export function splitBrowserApprovalLabel(raw: string): BrowserApprovalLabel {
  const label = raw.trim();
  for (const [title, note] of CATEGORY_NOTES) {
    if (label === title) return { label: "", note };
    if (label.startsWith(`${title}: `)) return { label: label.slice(title.length + 2).trim(), note };
  }
  return { label, note: null };
}

/**
 * The runtime leads a site's own search's label with these words, in place
 * of a category (`SITE_SEARCH_TITLE` in runtime-agent's
 * `shared-browser-cli.js`): Enter in a search field, or typing into it with
 * submit, that the browser's policy puts in its search category and whose
 * form makes it a search by its structure, a GET of the page's own site;
 * never a field in no form. Never the page's own words: the runtime leads a
 * page's words that would show so, however they are spaced, with "Change
 * something". A form that posts, or goes to another site, is never in that
 * category, whatever its words say ("Find…").
 */
export const SITE_SEARCH_TITLE = "Search this site";

/**
 * What a site search's label says after its title, the fields its form
 * sends besides the search ("" for a form with no other field), or null for
 * a label the runtime did not lead with the title.
 */
export function siteSearchLabel(raw: string): string | null {
  const label = raw.trim();
  if (label === SITE_SEARCH_TITLE) return "";
  return label.startsWith(`${SITE_SEARCH_TITLE}: `) ? label.slice(SITE_SEARCH_TITLE.length + 2).trim() : null;
}
