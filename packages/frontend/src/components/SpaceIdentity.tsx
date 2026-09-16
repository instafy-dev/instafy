import { useState } from "react";
import { normalizeSpaceAvatarUrl, normalizeSpaceColor, normalizeSpaceIcon } from "@instafy/sdk/project-identity";

const COLOR_CLASSES = {
  slate: "bg-slate-100 text-slate-700 dark:bg-slate-700 dark:text-slate-100",
  blue: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-100",
  violet: "bg-violet-100 text-violet-800 dark:bg-violet-900 dark:text-violet-100",
  pink: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-100",
  red: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-100",
  orange: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-100",
  green: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-100",
  teal: "bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-100",
} as const;

/** Decorative identity; the adjoining space name provides the accessible label. */
export function SpaceIdentity({ name, icon, color, avatarUrl, className = "" }: {
  name?: string | null;
  icon?: string | null;
  color?: string | null;
  avatarUrl?: string | null;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageUrl = avatarUrl?.startsWith("blob:") ? avatarUrl : normalizeSpaceAvatarUrl(avatarUrl);
  const symbol = normalizeSpaceIcon(icon) ?? Array.from(name?.trim() || "S")[0].toLocaleUpperCase();
  return <span
    aria-hidden="true"
    data-testid="space-identity"
    className={`inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg text-sm font-semibold ${COLOR_CLASSES[normalizeSpaceColor(color) ?? "slate"]} ${className}`}
  >{imageUrl && imageUrl !== failedUrl ? <img src={imageUrl} alt="" draggable={false} className="h-full w-full object-cover" onError={() => setFailedUrl(imageUrl)} /> : symbol}</span>;
}
