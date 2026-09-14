import type { UserProfile } from "./ProfileProvider";

/** Seed a missing profile once; saved profiles, including cleared fields, take precedence. */
export function resolveProfileDefaults(metadata: unknown): UserProfile {
  const values = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  let fullName: string | null = null;
  for (const key of ["full_name", "name", "display_name", "user_name", "preferred_username", "username"]) {
    const raw = values[key];
    if (typeof raw !== "string") continue;
    const name = raw.trim().replace(/\s+/gu, " ");
    // Some providers put the email address in their name/username claim.
    if (name && !name.includes("@")) {
      fullName = name;
      break;
    }
  }
  const avatarUrl = [values.avatar_url, values.picture]
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()))
    ?.trim() ?? null;
  return { fullName, avatarUrl };
}
