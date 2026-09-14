import type { ComponentType } from "react";
import { Discord, Github, Puzzle } from "iconoir-react";
import { buildSkillImportMessage } from "../../../conversations/skillCommands";
import { FreeFinanceMark, NotionMark, SlackMark } from "./connectorMarks";

// The static, first-party, build-time connector list: the one place in
// packages/frontend where product names and the secret names their setup asks
// for may appear. Never fetched, never merged with server data, never editable
// from the UI (the same trust model as ONBOARDING_PATHS).

export type ConnectorKind = "skill" | "github" | "other";

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

type ProductConnectorBase = ConnectorBase & {
  category: ConnectorCategoryId;
  /**
   * Curated, not measured: a featured connector sits in the sheet's "Popular"
   * row, in the composer's Connect rows and (skills only) as a card chip.
   * Nothing counts installs or usage.
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

/** Routes to the existing GitHub import and device-login flow; never a card chip. */
export type GithubConnector = ProductConnectorBase & { kind: "github" };

export type ProductConnector = SkillConnector | GithubConnector;

/** "Paste a skill link": the sheet's footer action, never a row or a chip. */
export type OtherConnector = ConnectorBase & { kind: "other" };

export type Connector = ProductConnector | OtherConnector;

export const CONNECTORS: readonly Connector[] = [
  {
    id: "slack",
    name: "Slack",
    mark: SlackMark,
    kind: "skill",
    category: "chat",
    featured: true,
    keywords: ["chat", "team", "messages"],
    source: "https://github.com/instafy-dev/team-integrations/tree/main/.agents/skills/slack",
    sourceLabel: "instafy-dev/team-integrations",
    skillName: "slack",
    needs: ["a Slack app bot token (SLACK_BOT_TOKEN)"],
  },
  {
    id: "notion",
    name: "Notion",
    mark: NotionMark,
    kind: "skill",
    category: "docs",
    featured: true,
    keywords: ["notes", "docs", "wiki", "database"],
    source: "https://github.com/instafy-dev/team-integrations/tree/main/.agents/skills/notion",
    sourceLabel: "instafy-dev/team-integrations",
    skillName: "notion",
    needs: ["a Notion internal integration token (NOTION_API_KEY)"],
  },
  {
    id: "discord",
    name: "Discord",
    mark: Discord,
    kind: "skill",
    category: "chat",
    featured: true,
    keywords: ["chat", "community", "server"],
    source: "https://github.com/instafy-dev/team-integrations/tree/main/.agents/skills/discord",
    sourceLabel: "instafy-dev/team-integrations",
    skillName: "discord",
    needs: ["a Discord bot token (DISCORD_BOT_TOKEN)"],
  },
  {
    id: "freefinance",
    name: "FreeFinance",
    mark: FreeFinanceMark,
    kind: "skill",
    category: "finance",
    featured: false,
    region: "Austria",
    keywords: ["bookkeeping", "accounting", "buchhaltung", "invoices", "uva"],
    source: "https://github.com/instafy-dev/bookkeeping-pack/tree/main/.agents/skills/freefinance",
    sourceLabel: "instafy-dev/bookkeeping-pack",
    skillName: "freefinance",
    needs: ["a FreeFinance technical user (FREEFINANCE_TECHNICAL_USER)"],
  },
  {
    id: "github",
    name: "GitHub",
    mark: Github,
    kind: "github",
    category: "code",
    featured: true,
    keywords: ["repo", "git", "code", "pull request"],
  },
  { id: "other", name: "Paste a skill link", mark: Puzzle, kind: "other" },
];

export function isProductConnector(connector: Connector): connector is ProductConnector {
  return connector.kind === "skill" || connector.kind === "github";
}

/** Every product connector in list order; the paste link is not one. */
export const PRODUCT_CONNECTORS: readonly ProductConnector[] = CONNECTORS.filter(isProductConnector);

/** The curated "Popular" row and the composer's Connect rows, in list order. */
export const FEATURED_CONNECTORS: readonly ProductConnector[] = PRODUCT_CONNECTORS.filter(
  (connector) => connector.featured,
);

/**
 * The getting-started card's chips: featured skills only. GitHub is not a
 * chip because the card already carries the "Import a GitHub repo" button.
 */
export const CARD_CHIP_CONNECTORS: readonly SkillConnector[] = FEATURED_CONNECTORS.filter(
  (connector): connector is SkillConnector => connector.kind === "skill",
);

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

export function buildConnectorImportMessage(connector: SkillConnector): string {
  return buildSkillImportMessage({
    source: connector.source,
    skillName: connector.skillName,
    overwrite: false,
    start: true,
  });
}
