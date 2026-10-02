export const PERSONAL_ORG_LABEL = "Personal team";
export const PERSONAL_ORG_DISPLAY_NAME = "Personal";

export function isPersonalOrgName(name: string | null | undefined): boolean {
  const trimmed = (name ?? "").trim();
  return (
    trimmed.length === 0 ||
    trimmed === PERSONAL_ORG_LABEL ||
    trimmed === PERSONAL_ORG_DISPLAY_NAME ||
    trimmed === "Personal organization" ||
    trimmed === "Personal workspace" ||
    trimmed === "Personal team"
  );
}

export function getOrgDisplayName(name: string | null | undefined): string {
  if (isPersonalOrgName(name)) {
    return PERSONAL_ORG_DISPLAY_NAME;
  }
  return (name ?? "").trim();
}

/**
 * Compact 1–2 letter monogram for every team avatar chip, taken from the
 * team's display name: the first letter of the first two words, or one letter
 * for a one-word name. The personal team reads "P" whether a caller holds the
 * stored name ("Personal team") or the display name ("Personal").
 */
export function getOrgInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "?";
  }
  const words = getOrgDisplayName(trimmed).split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    return words[0].slice(0, 1).toUpperCase();
  }
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

const UUIDISH_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i;

/**
 * Short, human suffix used to tell apart orgs that share a display name
 * (e.g. several "Personal" teams). Human-chosen slugs pass through;
 * machine slugs like "user-624ae065-1cfe-…" collapse to their first hex
 * chunk instead of dumping a UUID into the switcher.
 */
export function getOrgDisambiguator(slug: string | null | undefined, id: string): string {
  const trimmed = (slug ?? "").trim();
  if (trimmed && trimmed.length <= 24 && !UUIDISH_PATTERN.test(trimmed)) {
    return trimmed;
  }
  const hex = trimmed.match(/[0-9a-f]{8}/i)?.[0] ?? id.match(/[0-9a-f]{8}/i)?.[0];
  return hex ?? id.slice(0, 8);
}
