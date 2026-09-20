export type ChatSlashCommandOption = {
  command: string;
  description: string;
  searchTerms?: string[];
  hidden?: boolean;
};

export const CHAT_SLASH_COMMANDS: ChatSlashCommandOption[] = [
  {
    command: "/invite",
    description: "Invite a teammate to this space by email.",
    searchTerms: ["member", "collaborator", "share", "email"],
  },
  {
    command: "/learn",
    description: "Apply recent learnings to project memory.",
    searchTerms: ["memory", "skills", "optimize"],
  },
  {
    command: "/goal",
    description: "Set or inspect the active goal for this conversation.",
    searchTerms: ["objective", "continue", "complete", "blocked"],
  },
  {
    command: "/skills",
    description: "List, add, or start skills in this space.",
    searchTerms: ["skill", "install", "import", "add", "start", "pack"],
  },
  {
    command: "/skills import",
    description:
      "Add skills from a GitHub repo, skill folder, SKILL.md link, or path; add --start to run their setup.",
    searchTerms: ["install", "add", "pack"],
    hidden: true,
  },
  {
    command: "/skills start",
    description: "Start an installed skill's Getting started flow.",
    searchTerms: ["run", "setup", "onboard"],
    hidden: true,
  },
  {
    command: "/learn collect",
    description: "Scan recent runs and collect learning candidates only.",
    searchTerms: ["scan", "collect", "memory"],
    hidden: true,
  },
  {
    command: "/terminal",
    description: "Run a shell command in the active runtime.",
    searchTerms: ["shell", "command", "bash", "run"],
  },
  {
    command: "/term",
    description: "Alias for /terminal.",
    searchTerms: ["shell", "command", "alias", "terminal"],
    hidden: true,
  },
];

export function filterChatSlashCommands(query: string | null): ChatSlashCommandOption[] {
  const lowered = (query ?? "").trim().toLowerCase();
  const normalized = lowered.replace(/^\//, "");
  if (!normalized) {
    return CHAT_SLASH_COMMANDS.filter((option) => !option.hidden);
  }
  return CHAT_SLASH_COMMANDS.filter((option) => {
    if (option.hidden) {
      return false;
    }
    const commandTerms = option.command
      .toLowerCase()
      .replace(/^\//, "")
      .split(/[ :]+/g)
      .filter((term) => term.length > 0);
    if (commandTerms.some((term) => term.startsWith(normalized) || term.includes(normalized))) {
      return true;
    }
    return (option.searchTerms ?? []).some((term) => {
      const loweredTerm = term.toLowerCase();
      return loweredTerm.startsWith(normalized) || loweredTerm.includes(normalized);
    });
  });
}
