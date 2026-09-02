import { AttentionBadge } from "../../../components/AttentionBadge";
import { getOrgInitials } from "../../../org/orgNaming";

export interface SidebarOrgDeckTeam {
  key: string;
  name: string;
  avatarUrl: string | null;
}

interface SidebarOrgDeckProps {
  /** The team the sidebar currently treats as selected; null while unknown. */
  team: SidebarOrgDeckTeam | null;
  /** How many teams the user belongs to — the deck shows edges only above one. */
  teamCount: number;
  /** Attention across the OTHER teams (the active team's count lives on Home). */
  otherAttentionCount: number;
  /** A team switch is in flight. */
  pending?: boolean;
  className?: string;
}

// The sidebar's one org anchor. It fills the nav row's icon shell in both the
// collapsed and expanded rail, so it never changes shape when the rail does —
// the previous chip strip re-flowed from a column to a row on expand and
// shoved every nav item below it. Membership in more than one team reads as a
// deck: two card edges peek out behind the active team, and the badge rolls
// up attention from the other teams. The picker itself is the existing team
// popover; this is only its handle.
export function SidebarOrgDeck({
  team,
  teamCount,
  otherAttentionCount,
  pending = false,
  className,
}: SidebarOrgDeckProps) {
  const stacked = teamCount > 1;
  return (
    <span
      className={["relative block h-full w-full", className].filter(Boolean).join(" ")}
      data-testid="sidebar-org-deck"
      data-stacked={stacked ? "true" : undefined}
      aria-busy={pending || undefined}
    >
      {stacked ? (
        <>
          <span
            aria-hidden="true"
            data-testid="sidebar-org-deck-edge"
            className="absolute inset-0 translate-x-[4px] translate-y-[4px] rounded-lg bg-slate-300/50 dark:bg-white/[0.07]"
          />
          <span
            aria-hidden="true"
            data-testid="sidebar-org-deck-edge"
            className="absolute inset-0 translate-x-[2px] translate-y-[2px] rounded-lg bg-slate-300/80 dark:bg-white/[0.11]"
          />
        </>
      ) : null}
      <span
        data-testid="sidebar-org-deck-card"
        className={[
          "absolute inset-0 flex items-center justify-center overflow-hidden rounded-lg text-xxs font-semibold",
          "bg-primary-600 text-white dark:bg-primary-500",
          pending ? "animate-pulse" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {team?.avatarUrl ? (
          <img
            src={team.avatarUrl}
            alt=""
            aria-hidden="true"
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          getOrgInitials(team?.name ?? "")
        )}
      </span>
      <AttentionBadge
        count={otherAttentionCount}
        aria-hidden
        testId="sidebar-org-deck-attention"
        className="absolute -right-1.5 -top-1.5 z-10 ring-2 ring-slate-50 dark:ring-[color:var(--color-studio-dark-rail)]"
      />
    </span>
  );
}
