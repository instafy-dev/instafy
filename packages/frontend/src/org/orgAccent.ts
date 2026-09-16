export const ORG_ACCENTS = ["slate", "blue", "violet", "pink", "red", "orange", "green", "teal"] as const;
export type OrgAccent = (typeof ORG_ACCENTS)[number];

export function normalizeOrgAccent(value: unknown): OrgAccent | null {
  return typeof value === "string" && (ORG_ACCENTS as readonly string[]).includes(value)
    ? value as OrgAccent : null;
}
