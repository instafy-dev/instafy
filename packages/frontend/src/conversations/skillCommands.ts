const SKILL_FILE_NAME = "SKILL.md";
const SKILLS_FOLDER_NAMES = new Set([".agents", "skills"]);

export function normalizeSkillName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function humanizeSkillName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!normalized) {
    return "Unnamed skill";
  }
  return normalized
    .split(" ")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function splitSourcePath(value: string): string[] {
  return value
    .replace(/\\+/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function deriveSkillNameHintFromImportSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }

  const pickFromSegments = (segments: string[]): string | null => {
    if (segments.length === 0) {
      return null;
    }
    const last = segments[segments.length - 1]?.trim() ?? "";
    const candidate =
      last.toLowerCase() === SKILL_FILE_NAME.toLowerCase() && segments.length >= 2
        ? segments[segments.length - 2] ?? ""
        : last;
    const normalized = normalizeSkillName(candidate);
    return normalized || null;
  };

  try {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      return null;
    }

    if (
      parsed.hostname.toLowerCase() === "github.com" &&
      segments.length >= 5 &&
      (segments[2] === "blob" || segments[2] === "tree")
    ) {
      const githubPathSegments = segments.slice(4);
      return pickFromSegments(githubPathSegments);
    }

    return pickFromSegments(segments);
  } catch {
    return pickFromSegments(splitSourcePath(trimmed));
  }
}

/**
 * Human label for the toast after a send: the repo name for a bare repo, a
 * tree root or a `.agents/skills` folder; the folder name for one skill
 * folder; the parent folder for a SKILL.md link; the last path segment for a
 * workspace path; the trimmed source when nothing better exists.
 */
export function deriveSkillSourceLabel(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return trimmed;
  }

  const stripGitSuffix = (value: string) => value.replace(/\.git$/i, "");

  const labelFromPath = (segments: string[]): string | null => {
    const meaningful = [...segments];
    while (meaningful.length > 0) {
      const last = meaningful[meaningful.length - 1] ?? "";
      if (last.toLowerCase() === SKILL_FILE_NAME.toLowerCase()) {
        meaningful.pop();
        continue;
      }
      if (SKILLS_FOLDER_NAMES.has(last.toLowerCase())) {
        meaningful.pop();
        continue;
      }
      break;
    }
    const last = meaningful[meaningful.length - 1];
    return last ? last : null;
  };

  try {
    const parsed = new URL(trimmed);
    const segments = parsed.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
    if (segments.length === 0) {
      return trimmed;
    }
    if (parsed.hostname.toLowerCase() === "github.com" && segments.length >= 2) {
      const repo = stripGitSuffix(segments[1] ?? "");
      if (segments.length >= 4 && (segments[2] === "blob" || segments[2] === "tree")) {
        const label = labelFromPath(segments.slice(4));
        return label ?? repo ?? trimmed;
      }
      return repo || trimmed;
    }
    return labelFromPath(segments.map(stripGitSuffix)) ?? trimmed;
  } catch {
    return labelFromPath(splitSourcePath(trimmed)) ?? trimmed;
  }
}

export type BuildSkillImportMessageParams = {
  source: string;
  skillName?: string | null;
  overwrite?: boolean;
  start?: boolean;
};

/**
 * The one line every surface sends:
 * `/skills import <source>[ --name <name>][ --overwrite][ --start]`.
 * Order is fixed: name, overwrite, start.
 */
export function buildSkillImportMessage(params: BuildSkillImportMessageParams): string {
  const source = params.source.trim();
  if (!source) {
    throw new Error("Skill source is required.");
  }
  if (/\s/.test(source)) {
    throw new Error("Skill source cannot contain spaces.");
  }
  const parts = ["/skills import", source];
  const name = normalizeSkillName(params.skillName ?? "");
  if (name) {
    parts.push("--name", name);
  }
  if (params.overwrite) {
    parts.push("--overwrite");
  }
  if (params.start) {
    parts.push("--start");
  }
  return parts.join(" ");
}

export function buildSkillStartMessage(slug: string): string {
  return `/skills start ${slug.trim()}`;
}
