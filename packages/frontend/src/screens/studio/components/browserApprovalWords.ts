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

function shownHost(origin: string | null | undefined): string | null {
  const host = hostOf(origin);
  return host ? displayActivityHost(host) : null;
}

function cut(label: string): string {
  const characters = [...label.trim()];
  return characters.length <= MAX_LABEL_CHARS ? characters.join("") : `${characters.slice(0, MAX_LABEL_CHARS - 1).join("")}…`;
}

/**
 * What the agent waits to do, in one sentence: "Octo wants to send the form
 * “Search” on visitlisboa.com." The label is the runtime's already-masked
 * name of the control, the only place the page's own words appear, because
 * the person needs them to decide.
 */
export function browserApprovalSentence(agent: string, request: BrowserApprovalWordsRequest): string {
  // The step's category leads the runtime's label ("Delete, cancel or sign
  // out: Delete account"): only the control's name goes in quotes, and the
  // category, when it adds something, follows as its own sentence.
  const { label: name, note } = splitBrowserApprovalLabel(request.display.label);
  const sentence = stepSentence(agent, request, name);
  return note ? `${sentence} ${note}` : sentence;
}

function stepSentence(agent: string, request: BrowserApprovalWordsRequest, name: string): string {
  const destination = shownHost(request.display.destinationOrigin) ?? shownHost(request.destinationOrigin);
  const site = shownHost(request.sourceOrigin) ?? destination ?? "this site";
  const label = cut(name);
  const quoted = label ? ` “${label}”` : "";
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
