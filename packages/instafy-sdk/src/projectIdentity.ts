/** Small, portable space identity: no uploaded assets or arbitrary CSS values. */
export const SPACE_ICONS = ["🚀", "🛠️", "💡", "🌱", "🎨", "📚", "🔬", "🎯", "🌍", "⚡", "🏡", "🧩"] as const;
export const SPACE_COLORS = ["slate", "blue", "violet", "pink", "red", "orange", "green", "teal"] as const;

export type SpaceIcon = (typeof SPACE_ICONS)[number];
export type SpaceColor = (typeof SPACE_COLORS)[number];

export interface ProjectIdentity {
  projectIcon?: SpaceIcon | null;
  projectColor?: SpaceColor | null;
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
