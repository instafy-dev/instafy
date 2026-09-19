import type { ComponentType } from "react";
import { Discord, Github } from "iconoir-react";
import { FreeFinanceMark, NotionMark, SlackMark } from "../screens/studio/components/connectorMarks";

/**
 * The static, first-party list of hosts a chat link may wear a mark for.
 *
 * Chat text reaches the person near-verbatim from the model, and the model
 * reads SKILL.md files fetched from arbitrary repositories. A markdown link
 * shows only its label, so a pack could write "Open Notion" over any address
 * it liked and the person would have nothing to read but the word Notion.
 *
 * So a link is drawn one of two ways. A host on this list is a host a reviewer
 * approved in this file, and it carries its own mark: the person sees the
 * product, not a string. Every other host is written out beside the label, so
 * the label can never be the only thing they have to go on.
 *
 * The marks are bundled, never fetched. A favicon pulled from the named host
 * would hand it the reader's address the moment a hostile link rendered, which
 * is a tracking pixel wearing a padlock, and it would put an image where the
 * design language asks for an inline glyph at label size.
 */
export type KnownLinkHost = {
  /** Matched against the URL host, and against any subdomain of it. */
  host: string;
  /** What the person knows it as. */
  name: string;
  mark: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
};

export const KNOWN_LINK_HOSTS: readonly KnownLinkHost[] = [
  { host: "notion.so", name: "Notion", mark: NotionMark },
  { host: "notion.com", name: "Notion", mark: NotionMark },
  { host: "github.com", name: "GitHub", mark: Github },
  { host: "slack.com", name: "Slack", mark: SlackMark },
  { host: "discord.com", name: "Discord", mark: Discord },
  { host: "freefinance.at", name: "FreeFinance", mark: FreeFinanceMark },
];

/** The host of a link, lowercased and stripped of a leading www, or null. */
export function readLinkHost(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * The catalogue entry for a link's host, or null when nothing approved it.
 *
 * A subdomain of an approved host matches; a host that merely ends with the
 * same letters does not. "notion.so.evil.test" and "evilnotion.so" are both
 * strangers, which is the whole point of matching on a label boundary.
 */
export function describeKnownLinkHost(url: string): KnownLinkHost | null {
  const host = readLinkHost(url);
  if (!host) {
    return null;
  }
  return (
    KNOWN_LINK_HOSTS.find((entry) => host === entry.host || host.endsWith(`.${entry.host}`)) ?? null
  );
}

/**
 * Whether the label already tells the person where they are going, so that
 * repeating the host beside it would only be noise.
 */
export function labelAlreadyNamesHost(label: string, host: string): boolean {
  return label.toLowerCase().includes(host);
}
