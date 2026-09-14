import { normalizeOrgAccent } from "../org/orgAccent";
import { getOrgInitials } from "../org/orgNaming";
import "./OrgIdentity.css";

/** Decorative identity; the adjoining org name supplies its accessible label. */
export function OrgIdentity({ name, avatarUrl, accentColor, className = "" }: {
  name: string;
  avatarUrl?: string | null;
  accentColor?: string | null;
  className?: string;
}) {
  return <span aria-hidden="true" data-testid="org-identity" data-org-accent={normalizeOrgAccent(accentColor) ?? "slate"}
    className={`org-accent-avatar inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg font-medium ${className}`}>
    {avatarUrl ? <img src={avatarUrl} alt="" draggable={false} className="h-full w-full object-cover" /> : getOrgInitials(name)}
  </span>;
}
