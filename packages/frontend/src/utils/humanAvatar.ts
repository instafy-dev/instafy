const GENERIC_NAMES = new Set(["you", "guest", "account", "user", "teammate", "member", "owner", "unknown", "unknown user", "human"]);

/** Display names only: email addresses and generic UI labels are not a person's initials. */
export function resolveHumanAvatarInitials(displayName: string | null | undefined): string | null {
  const name = displayName?.trim().normalize("NFC") ?? "";
  if (!name || name.includes("@") || GENERIC_NAMES.has(name.toLowerCase())) return null;
  const words = name.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu);
  if (!words?.length) return null;
  const first = Array.from(words[0]);
  return (words.length > 1
    ? `${first[0]}${Array.from(words[words.length - 1])[0]}`
    : first.slice(0, 2).join("")).toUpperCase();
}

const HUMAN_AVATAR_PALETTE = [
  { background: "#e6e9e8", foreground: "#43524d", darkBackground: "#303c37", darkForeground: "#d0ded6" },
  { background: "#e1e9ee", foreground: "#3d5363", darkBackground: "#2b3943", darkForeground: "#cbdde9" },
  { background: "#e9e4ed", foreground: "#594967", darkBackground: "#3b3243", darkForeground: "#ddd0e7" },
  { background: "#eee3e5", foreground: "#6b4851", darkBackground: "#453237", darkForeground: "#e9d0d7" },
  { background: "#ece7de", foreground: "#63533c", darkBackground: "#40392d", darkForeground: "#e5d9c2" },
  { background: "#e3e9df", foreground: "#4f5b41", darkBackground: "#353e2f", darkForeground: "#d6e0cb" },
] as const;

/** Color is a function of the stable user ID, never the editable name or photo. */
export function resolveHumanAvatarColors(userId: string | null | undefined) {
  const id = userId?.trim();
  if (!id) return HUMAN_AVATAR_PALETTE[0];
  let hash = 2166136261;
  for (const character of id) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 16777619);
  }
  return HUMAN_AVATAR_PALETTE[(hash >>> 0) % HUMAN_AVATAR_PALETTE.length];
}
