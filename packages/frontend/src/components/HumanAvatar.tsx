import type { CSSProperties } from "react";
import { User } from "iconoir-react";
import { resolveHumanAvatarColors, resolveHumanAvatarInitials } from "../utils/humanAvatar";

export interface HumanAvatarProps {
  userId?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  photoAlt?: string;
  className?: string;
  "data-testid"?: string;
}

/** A person's photo or stable identity fallback. Surrounding controls own their accessible name. */
export function HumanAvatar({ userId, displayName, avatarUrl, photoAlt = "", className, "data-testid": testId }: HumanAvatarProps) {
  const photo = avatarUrl?.trim();
  const initials = resolveHumanAvatarInitials(displayName);
  const colors = resolveHumanAvatarColors(userId);
  return (
    <span
      aria-hidden={photoAlt ? undefined : true}
      data-testid={testId}
      data-human-avatar=""
      className={[
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold bg-[var(--human-avatar-background)] text-[var(--human-avatar-foreground)] dark:bg-[var(--human-avatar-dark-background)] dark:text-[var(--human-avatar-dark-foreground)]",
        className ?? "h-8 w-8 text-xs",
      ].join(" ")}
      style={{
        "--human-avatar-background": colors.background,
        "--human-avatar-foreground": colors.foreground,
        "--human-avatar-dark-background": colors.darkBackground,
        "--human-avatar-dark-foreground": colors.darkForeground,
      } as CSSProperties}
    >
      {photo ? <img src={photo} alt={photoAlt} draggable={false} decoding="async" className="h-full w-full object-cover" />
        : initials ? <span>{initials}</span> : <User className="h-[55%] w-[55%]" aria-hidden="true" />}
    </span>
  );
}
