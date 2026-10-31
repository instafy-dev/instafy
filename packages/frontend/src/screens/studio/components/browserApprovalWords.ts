import { displayActivityHost } from "./activityHost";
import { splitBrowserApprovalLabel } from "./browserApprovalLabel";
import { isActivityHost } from "./turnActivity";

/**
 * The words of an Instafy's browser prompt, shared by the chat's approval
 * row and the browser view's sheet, so both ask in Octo's own words: "Octo
 * wants to use visitlisboa.com."
 */
export type BrowserApprovalWordsRequest = {
  kind: "origin" | "action";
  operation: string;
  sourceOrigin: string | null;
  destinationOrigin: string | null;
  display: {
    label: string;
    destinationOrigin: string | null;
  };
};

/** The page's own words in a prompt are cut to this many characters. */
const MAX_LABEL_CHARS = 40;

const LABEL_ADDRESS_PATTERN = /https?:\/\/[^\s\u2026]+/gi;

/**
 * The exact page a prompt's step will load, as host and path, when the
 * runtime names it: a site prompt or a navigation names its address in its
 * label (cut with "…" when long). Only an address on the prompt's own site
 * counts, and a prompt from an older runtime names none, so the site is
 * shown then.
 */
export function sharedBrowserApprovalTargetAddress(
  request: Pick<BrowserApprovalWordsRequest, "kind" | "operation" | "destinationOrigin" | "display">,
): string | null {
  if (request.kind !== "origin" && request.operation !== "navigate") return null;
  const site = request.display.destinationOrigin?.trim() || request.destinationOrigin?.trim() || "";
  if (!site) return null;
  const label = request.display.label;
  for (const match of label.matchAll(LABEL_ADDRESS_PATTERN)) {
    let url: URL;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    if (url.origin !== site) continue;
    const path = url.pathname === "/" && !url.search ? "" : `${url.pathname}${url.search}`;
    const cut = label.charAt((match.index ?? 0) + match[0].length) === "\u2026";
    return `${url.host}${path}${cut ? "\u2026" : ""}`;
  }
  return null;
}

function hostOf(origin: string | null | undefined): string | null {
  const value = origin?.trim();
  if (!value) return null;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host ? host.replace(/^www\./u, "") : null;
  } catch {
    return null;
  }
}

/** A host for the activity line: only a name the line's rules accept. */
export function activityHostOf(origin: string | null | undefined): string | null {
  const host = hostOf(origin);
  return isActivityHost(host) ? host : null;
}

/**
 * Where a step on the page goes, as a host with no scheme ("httpbin.org"),
 * for the browser view's sheet to say "Goes to httpbin.org": a link's or a
 * form's address. Null when the sentence already names it: a site prompt or
 * a navigation names its page, and a form sent to another site says "It
 * goes to …". On the page's own site only a step that sends fields goes
 * somewhere: the runtime binds Enter, Space and a click on a box in a form
 * to the page's address even when the step sends nothing.
 */
export function browserApprovalGoesTo(
  request: Pick<BrowserApprovalWordsRequest, "kind" | "operation" | "sourceOrigin" | "destinationOrigin" | "display">,
): string | null {
  if (request.kind !== "action" || request.operation === "navigate") return null;
  const destination = shownHost(request.display.destinationOrigin) ?? shownHost(request.destinationOrigin);
  if (!destination) return null;
  const site = shownHost(request.sourceOrigin) ?? destination;
  if (destination !== site) return request.operation === "form-submit" ? null : destination;
  return controlWords(splitBrowserApprovalLabel(request.display.label).label).sends ? destination : null;
}

function shownHost(origin: string | null | undefined): string | null {
  const host = hostOf(origin);
  return host ? displayActivityHost(host) : null;
}

function cut(label: string, max = MAX_LABEL_CHARS): string {
  const characters = [...label.trim()];
  return characters.length <= max ? characters.join("") : `${characters.slice(0, max - 1).join("")}…`;
}

/** The list of fields a prompt says a form step sends is cut to this many characters. */
const MAX_SENDS_CHARS = 120;
// How the runtime writes a control's two names and what a form step sends:
// `Submit order · Sends: Customer name, Telephone` and
// `Agree and close (also called "Agree and close: Agree to our data processing and close")`.
const SENDS_SEPARATOR = " \u00b7 Sends: ";
const ALSO_CALLED = /^(.*) \(also called "(.*)"\)$/su;
// An older runtime led with the other name: `Learn More: Configure (shown as "Learn More")`.
const SHOWN_AS = /^(.*) \(shown as "(.*)"\)$/su;
// How the runtime writes a choice: the option, then the list it is in, by the
// list's own name: `São Bento · In: Start`.
const IN_SEPARATOR = " \u00b7 In: ";

/** A choice's option and the list it is in, from the runtime's label. */
function choiceWords(name: string): { option: string; list: string } {
  const at = name.lastIndexOf(IN_SEPARATOR);
  return at < 0
    ? { option: name.trim(), list: "" }
    : { option: name.slice(0, at).trim(), list: name.slice(at + IN_SEPARATOR.length).trim() };
}

type ControlWords = {
  /** The text the control shows, which the person finds on the page. */
  shown: string;
  /** Its other name, when it says more than it shows. */
  other: string;
  /** The fields a form step sends, by name, never their values. */
  sends: string;
};

function controlWords(name: string): ControlWords {
  let rest = name;
  let sends = "";
  const at = rest.lastIndexOf(SENDS_SEPARATOR);
  if (at >= 0) {
    sends = rest.slice(at + SENDS_SEPARATOR.length).trim();
    rest = rest.slice(0, at);
  }
  const also = ALSO_CALLED.exec(rest);
  if (also) return { shown: also[1], other: also[2], sends };
  const older = SHOWN_AS.exec(rest);
  if (older) return { shown: older[2], other: older[1], sends };
  return { shown: rest, other: "", sends };
}

/**
 * What the agent waits to do, in one sentence: "Octo wants to send the form
 * “Search” on visitlisboa.com." The label is the runtime's already-masked
 * name of the control, the only place the page's own words appear, because
 * the person needs them to decide. Each of its names is cut on its own, so
 * the text the control shows is never lost to a longer one, and a form step
 * says which fields it sends: "Sends: Customer name, Telephone."
 */
export function browserApprovalSentence(agent: string, request: BrowserApprovalWordsRequest): string {
  // The step's category leads the runtime's label ("Delete, cancel or sign
  // out: Delete account"): only the control's name goes in quotes, and the
  // category, when it adds something, follows as its own sentence.
  const { label, note } = splitBrowserApprovalLabel(request.display.label);
  const words = controlWords(label);
  const sentence = stepSentence(agent, request, label, words);
  const sends = words.sends ? ` Sends: ${cut(words.sends, MAX_SENDS_CHARS).replace(/[.\s]+$/u, "")}.` : "";
  return `${sentence}${sends}${note ? ` ${note}` : ""}`;
}

function stepSentence(agent: string, request: BrowserApprovalWordsRequest, name: string, words: ControlWords): string {
  const destination = shownHost(request.display.destinationOrigin) ?? shownHost(request.destinationOrigin);
  const site = shownHost(request.sourceOrigin) ?? destination ?? "this site";
  const label = cut(words.shown);
  const other = cut(words.other);
  const quoted = label ? ` “${label}”${other ? ` (also called “${other}”)` : ""}` : "";
  // The exact page a site prompt or a navigation will load, when the runtime names it.
  const page = sharedBrowserApprovalTargetAddress(request);
  switch (request.operation) {
    case "approve-origin":
      return page ? `${agent} wants to open ${page}.` : `${agent} wants to use ${destination ?? site}.`;
    case "navigate":
      return `${agent} wants to open ${page ?? destination ?? "a page"}.`;
    case "click":
      return `${agent} wants to click${quoted} on ${site}.`;
    case "type":
      return `${agent} wants to type into${quoted || " a field"} on ${site}.`;
    case "choose": {
      // "Octo wants to choose “São Bento” in “Start” on metrodoporto.pt."
      const choice = choiceWords(name);
      const option = cut(choice.option);
      const list = cut(choice.list);
      return `${agent} wants to choose ${option ? `“${option}”` : "an option"}${list ? ` in “${list}”` : ""} on ${site}.`;
    }
    case "form-submit": {
      const elsewhere = destination && destination !== site ? ` It goes to ${destination}.` : "";
      return `${agent} wants to send ${label ? `the form${quoted}` : "a form"} on ${site}.${elsewhere}`;
    }
    case "press-enter":
      return `${agent} wants to press Enter on${quoted || " a control"} on ${site}.`;
    case "press-space":
      return `${agent} wants to press Space on${quoted || " a control"} on ${site}.`;
    case "press-key": {
      // The runtime names the key itself: "Press Tab on Search".
      const key = cut(name.replace(/^Press /u, ""));
      return `${agent} wants to press ${key || "a key"} on ${site}.`;
    }
    default:
      return `${agent} wants to take a step${quoted} on ${site}.`;
  }
}
