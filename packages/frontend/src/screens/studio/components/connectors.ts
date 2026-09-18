import type { ComponentType } from "react";
import { Discord, Github, Puzzle } from "iconoir-react";
import { buildSkillImportMessage } from "../../../conversations/skillCommands";
import { FreeFinanceMark, NotionMark, SlackMark } from "./connectorMarks";

// The static, first-party, build-time connector list: the one place in
// packages/frontend where product names and the secret names their setup asks
// for may appear. Never fetched, never merged with server data, never editable
// from the UI: a name shown here is one a reviewer approved in this file.

export type ConnectorKind = "skill" | "github" | "other";

/**
 * "available" routes and confirms as usual. "soon" is listed only in the
 * Connect sheet, greyed with a "Soon" Badge and never pressable
 * (routeConnectorSelection returns without action, so the confirm stage is
 * unreachable for it); the card chips and the composer rows leave it out
 * entirely, so every entry a first-run card offers leads somewhere. An entry
 * may be "soon" when the only missing piece is its pack folder; when the
 * missing piece is platform machinery, it is not in this file at all.
 */
export type ConnectorAvailability = "available" | "soon";

export type ConnectorCategoryId = "chat" | "docs" | "code" | "finance" | "email" | "files";

export type ConnectorCategory = {
  id: ConnectorCategoryId;
  label: string;
};

// Section order in the browse sheet. Only categories with at least one
// connector render.
export const CONNECTOR_CATEGORIES: readonly ConnectorCategory[] = [
  { id: "chat", label: "Chat and community" },
  { id: "docs", label: "Docs and notes" },
  { id: "code", label: "Code" },
  { id: "finance", label: "Finance and bookkeeping" },
  // Empty today, and invisible because the sheet drops a section with no
  // rows. "email" is the landing slot for the first mail pack, which needs a
  // third-party OAuth broker in the controller before it can be written at
  // all: a project secret is a flat environment string with no refresh or
  // expiry, so a token that must rotate would look fine at setup and die
  // later. "files" waits on a pack in the same way.
  { id: "email", label: "Email and calendar" },
  { id: "files", label: "Files" },
];

// The browse sheet's "Popular" row shows at most this many marks.
export const FEATURED_CONNECTOR_LIMIT = 8;

type ConnectorBase = {
  /** Chip, row and menu-row id, and testId suffix: connect-chip-<id>, connect-row-<id>. */
  id: string;
  /** Chip and menu-row label, and sheet title: "Connect <name>". */
  name: string;
  mark: ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
};

/**
 * One value a connector's setup asks a person to fetch. Display only: nothing
 * here is sent anywhere, and the value itself never passes through this file.
 * `valueLabel` is the provider's own on-screen name for it, so the card, the
 * Connect sheet and the pack all call it what the person will read in the
 * provider's UI.
 */
export type ConnectorCredential = {
  /** The environment variable name the runtime asks for, uppercase. */
  name: string;
  /** What the provider calls this value on screen, e.g. "Installation access token". */
  valueLabel: string;
};

type ProductConnectorBase = ConnectorBase & {
  category: ConnectorCategoryId;
  /** See ConnectorAvailability. A skill is "soon" until its pack repo is published. */
  availability: ConnectorAvailability;
  /**
   * One customer-language sentence saying what connecting this tool lets
   * Instafy do. It is the purpose line on the secret card and the first line
   * of the Connect sheet's confirm stage, so it must read to someone who has
   * never seen an API key: no variable names, no file paths, no repo names.
   */
  purpose: string;
  /**
   * The values this connector's setup asks for, in the order the setup asks.
   * Omitted when nothing is pasted (GitHub signs in with a device code). Kept
   * in step with `needs` by the drift test in __tests__/connectors.test.ts.
   */
  credentials?: readonly ConnectorCredential[];
  /**
   * A second errand inside the provider that setup cannot do for the person,
   * written as one customer-language sentence. Notion is the case this exists
   * for: a brand new connection can see nothing until each page is shared with
   * it, so a perfectly good token still finds nothing. The Connect sheet adds
   * it to the needs line; a connector with no such errand leaves it unset.
   */
  sharingNote?: string;
  /**
   * Curated, not measured: a featured connector sits in the sheet's "Popular"
   * row, in the composer's Connect rows and, once it is available, as a chip
   * on the getting-started card. Nothing counts installs or usage.
   */
  featured: boolean;
  /** Lowercase search terms matched by filterConnectors, next to the name. */
  keywords: readonly string[];
  /** Short muted meta shown on the row when the tool serves one market. */
  region?: string;
};

export type SkillConnector = ProductConnectorBase & {
  kind: "skill";
  /** Import URL (a GitHub tree URL to one skill folder today). */
  source: string;
  /** "owner/repo" shown in the sheet. */
  sourceLabel: string;
  /** Folder under .agents/skills. */
  skillName: string;
  /** "Setup will ask for" phrases, each naming its secret. Display text only. */
  needs: string[];
  /**
   * Display-only. Set when the tool is used through its web app inside the
   * shared display: the human signs in there once and the project's browser
   * profile keeps the session. Unset until a connector actually works that
   * way; only ConnectSheet reads it.
   */
  app?: { url: string };
};

/**
 * Routes to the existing GitHub import and device-login flow rather than a
 * skill import: it installs nothing, so it never carries the connected glyph.
 */
export type GithubConnector = ProductConnectorBase & { kind: "github" };

export type ProductConnector = SkillConnector | GithubConnector;

/** "Paste a skill link": the sheet's footer action, never a row or a chip. */
export type OtherConnector = ConnectorBase & { kind: "other" };

export type Connector = ProductConnector | OtherConnector;

export const CONNECTORS: readonly Connector[] = [
  {
    id: "slack",
    // Flip to "available" once packs/team/.agents/skills/slack lands in instafy-dev/skills.
    availability: "soon",
    name: "Slack",
    mark: SlackMark,
    kind: "skill",
    category: "chat",
    featured: true,
    purpose: "Instafy can read and post in the Slack channels you add it to.",
    keywords: ["chat", "team", "messages"],
    source: "https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills/slack",
    sourceLabel: "instafy-dev/skills",
    skillName: "slack",
    needs: ["a Slack Bot User OAuth Token (SLACK_BOT_TOKEN)"],
    credentials: [{ name: "SLACK_BOT_TOKEN", valueLabel: "Bot User OAuth Token" }],
  },
  // Ordering rule for the featured entries, which is what the card's chip row
  // and the sheet's Popular row read: a named product the customer already
  // uses comes first, and the developer entry follows it. The first-run chip
  // row is the first offer someone sees in an empty chat, and leading it with
  // a repo import says "this is for programmers" before any copy can say
  // otherwise. Notion therefore leads and GitHub sits next to it; a product
  // tool added later enters at the front and GitHub drifts right, with no
  // layout change anywhere.
  {
    id: "notion",
    availability: "available",
    name: "Notion",
    mark: NotionMark,
    kind: "skill",
    category: "docs",
    featured: true,
    purpose:
      "Instafy can search and read the Notion pages you share with it, and add notes to them after you confirm each one.",
    keywords: ["notes", "docs", "wiki", "database"],
    source: "https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills/notion",
    sourceLabel: "instafy-dev/skills",
    skillName: "notion",
    // Notion's own on-screen name since the 2026 rename: Installation access
    // token, on an internal connection's Configuration tab. The pack, this
    // list and the secret card all use that name and no other.
    needs: ["a Notion Installation access token (NOTION_API_KEY)"],
    credentials: [{ name: "NOTION_API_KEY", valueLabel: "Installation access token" }],
    sharingNote:
      "You will also pick which pages to share with it; Instafy walks you through that here.",
  },
  {
    id: "github",
    availability: "available",
    name: "GitHub",
    mark: Github,
    kind: "github",
    category: "code",
    featured: true,
    purpose: "Instafy can work with your GitHub repositories.",
    keywords: ["repo", "git", "code", "pull request"],
  },
  {
    id: "discord",
    // Flip to "available" once packs/team/.agents/skills/discord lands in instafy-dev/skills.
    availability: "soon",
    name: "Discord",
    mark: Discord,
    kind: "skill",
    category: "chat",
    featured: true,
    purpose: "Instafy can read and post in the Discord channels you add it to.",
    keywords: ["chat", "community", "server"],
    source: "https://github.com/instafy-dev/skills/tree/main/packs/team/.agents/skills/discord",
    sourceLabel: "instafy-dev/skills",
    skillName: "discord",
    needs: ["a Discord Bot token (DISCORD_BOT_TOKEN)"],
    credentials: [{ name: "DISCORD_BOT_TOKEN", valueLabel: "Bot token" }],
  },
  {
    id: "freefinance",
    availability: "available",
    name: "FreeFinance",
    mark: FreeFinanceMark,
    kind: "skill",
    category: "finance",
    // Featured, and last of the three that can be picked today: Notion leads
    // the row and GitHub follows it by the ordering rule above. This still
    // leaves two of the five card slots free.
    featured: true,
    purpose: "Instafy can read your FreeFinance bookkeeping data.",
    region: "Austria",
    keywords: ["bookkeeping", "accounting", "buchhaltung", "invoices", "uva"],
    source: "https://github.com/instafy-dev/skills/tree/main/packs/bookkeeping/.agents/skills/freefinance",
    sourceLabel: "instafy-dev/skills",
    skillName: "freefinance",
    needs: [
      "a FreeFinance Technical user id (FREEFINANCE_API_CLIENT_ID)",
      "its Technical user secret (FREEFINANCE_API_CLIENT_SECRET)",
    ],
    credentials: [
      { name: "FREEFINANCE_API_CLIENT_ID", valueLabel: "Technical user id" },
      { name: "FREEFINANCE_API_CLIENT_SECRET", valueLabel: "Technical user secret" },
    ],
  },
  { id: "other", name: "Paste a skill link", mark: Puzzle, kind: "other" },
];

export function isProductConnector(connector: Connector): connector is ProductConnector {
  return connector.kind === "skill" || connector.kind === "github";
}

/** Every product connector in list order; the paste link is not one. */
export const PRODUCT_CONNECTORS: readonly ProductConnector[] = CONNECTORS.filter(isProductConnector);

/**
 * True when the connector can be selected today. The paste link is always
 * available; a product connector is available unless its pack is still "soon".
 */
export function isConnectorAvailable(connector: Connector): boolean {
  return connector.kind === "other" || connector.availability === "available";
}

/** Every curated entry in list order, "soon" ones included. */
export const FEATURED_CONNECTORS: readonly ProductConnector[] = PRODUCT_CONNECTORS.filter(
  (connector) => connector.featured,
);

/**
 * Featured entries that can be selected today: the sheet's "Popular" row
 * (which hides itself while fewer than two are available) and the composer's
 * Connect rows, which fall back to "Browse all tools" alone when this is empty.
 */
export const AVAILABLE_FEATURED_CONNECTORS: readonly ProductConnector[] =
  FEATURED_CONNECTORS.filter(isConnectorAvailable);

/**
 * The card's own cap, measured rather than inherited from the sheet's
 * FEATURED_CONNECTOR_LIMIT. With the shipped chip (mark, name, gap-1.5,
 * px-2.5) and the trailing "More tools" link, a 390 px phone gives the step
 * 340 px and wraps at 27 px a line: five chips plus the link measure 60 px
 * (two lines) and six measure 92 px (three), while desktop holds five on one
 * 27 px line. Five is therefore the largest row that stays at two lines on a
 * phone, which is the height the card can spend on tools. Everything past it
 * lives behind "More tools" in the categorised, searchable sheet.
 */
export const CARD_CHIP_LIMIT = 5;

/**
 * The getting-started card's chip row: every featured tool that can be picked
 * today, in list order, capped at CARD_CHIP_LIMIT. GitHub is one of them now
 * that the card no longer carries its own import button; its chip opens the
 * same repo import and device login as before. A "soon" entry is not here at
 * all: the sheet lists it with a Soon Badge, which is where a tool that leads
 * nowhere belongs.
 */
export const CARD_TOOL_CONNECTORS: readonly ProductConnector[] =
  AVAILABLE_FEATURED_CONNECTORS.slice(0, CARD_CHIP_LIMIT);

/**
 * The same row for a member without write access: only the entries whose
 * press sends nothing into the conversation. A repo import opens a form and
 * writes files; a skill chip ends at the sheet's Connect button, which sends
 * the import line, so it is dropped rather than offered and refused.
 */
export const CARD_READ_ONLY_TOOL_CONNECTORS: readonly ProductConnector[] =
  CARD_TOOL_CONNECTORS.filter((connector) => connector.kind === "github");

export function connectorCategoryLabel(id: ConnectorCategoryId): string {
  return CONNECTOR_CATEGORIES.find((category) => category.id === id)?.label ?? id;
}

/**
 * Case-insensitive substring match over name, keywords, category label and
 * region. An empty (or whitespace) query returns every product connector.
 */
export function filterConnectors(query: string): ProductConnector[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return [...PRODUCT_CONNECTORS];
  }
  return PRODUCT_CONNECTORS.filter((connector) => {
    const haystack = [
      connector.name,
      ...connector.keywords,
      connectorCategoryLabel(connector.category),
      connector.region ?? "",
    ];
    return haystack.some((term) => term.toLowerCase().includes(needle));
  });
}

/**
 * The connector that asks for this secret name, with the credential entry that
 * names it. Case-insensitive, first match in list order wins; two connectors
 * claiming one name would need a real key rather than this lookup, and the
 * drift test keeps the names honest until that happens.
 *
 * Returns null for a name no first-party connector declares, which is how a
 * card falls back to the model's own description: the status quo, not a
 * regression.
 */
export function findConnectorCredential(
  secretName: string | null | undefined,
): { connector: ProductConnector; credential: ConnectorCredential } | null {
  const needle = (secretName ?? "").trim().toUpperCase();
  if (!needle) {
    return null;
  }
  for (const connector of PRODUCT_CONNECTORS) {
    for (const credential of connector.credentials ?? []) {
      if (credential.name.trim().toUpperCase() === needle) {
        return { connector, credential };
      }
    }
  }
  return null;
}

export function buildConnectorImportMessage(connector: SkillConnector): string {
  return buildSkillImportMessage({
    source: connector.source,
    skillName: connector.skillName,
    overwrite: false,
    start: true,
  });
}
