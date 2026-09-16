/** Portable space identity. Images use uploaded asset URLs; colors use a fixed palette. */
export const SPACE_ICONS = ["🚀", "🛠️", "💡", "🌱", "🎨", "📚", "🔬", "🎯", "🌍", "⚡", "🏡", "🧩"] as const;
export const SPACE_COLORS = ["slate", "blue", "violet", "pink", "red", "orange", "green", "teal"] as const;

export type SpaceIcon = (typeof SPACE_ICONS)[number];
export type SpaceColor = (typeof SPACE_COLORS)[number];

export interface ProjectIdentity {
  projectIcon?: SpaceIcon | null;
  projectColor?: SpaceColor | null;
  projectAvatarUrl?: string | null;
}

/** Omitted fields stay unchanged; null explicitly restores the default. */
export interface ProjectIdentityUpdate extends ProjectIdentity {
  projectId: string;
}

export function normalizeSpaceIcon(value: unknown): SpaceIcon | null {
  return typeof value === "string" && (SPACE_ICONS as readonly string[]).includes(value)
    ? value as SpaceIcon : null;
}

export function normalizeSpaceColor(value: unknown): SpaceColor | null {
  return typeof value === "string" && (SPACE_COLORS as readonly string[]).includes(value)
    ? value as SpaceColor : null;
}

/** Persist only network image URLs. Draft blob URLs never enter project metadata. */
export function normalizeSpaceAvatarUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
