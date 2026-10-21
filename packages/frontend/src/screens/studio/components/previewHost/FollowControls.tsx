import { Presentation } from "iconoir-react";
import { Button } from "../../../../components/Button";
import { HumanAvatar } from "../../../../components/HumanAvatar";
import type { FollowPerson } from "../../../../services/runtimeController/previewFollow";
import { followLabels, presentMenuLabel, type FollowLabels, type FollowRole } from "./followMode";
import type { FollowRipple, usePreviewFollow } from "./usePreviewFollow";

/**
 * What people see of follow mode (docs/Follow-Mode.md): the chip and Present
 * in the preview's bar (upstream's browser bar, on desktop and phone alike),
 * the ring around a followed frame and the presenter's tap ripples.
 * No popups: every state is visible where the person already looks. Generic:
 * nothing here knows what the site is.
 */

type Action = () => void;

/** Followers' faces beside "Presenting", each with a ring: these people see your view. */
export function FollowerAvatars({ followers, ringClass }: { followers: FollowPerson[]; ringClass: string }) {
  if (!followers.length) return null;
  const shown = followers.slice(0, 3);
  const names = followers.map(person => person.name).join(", ");
  return <span className="flex shrink-0 items-center" role="img" aria-label={`Watching: ${names}`} data-testid="follow-watchers">
    {shown.map((person, index) => (
      <HumanAvatar key={person.id} userId={person.id} displayName={person.name} avatarUrl={person.avatarUrl ?? undefined}
        className={`h-[22px] w-[22px] text-[10px] ring-2 ${ringClass} ${index ? "-ml-1.5" : ""}`} />
    ))}
    {followers.length > 3 ? <span className="ml-1 text-[11px] font-semibold">+{followers.length - 3}</span> : null}
  </span>;
}

const watchingText = (count: number) => count === 1 ? "1 watching" : `${count} watching`;

/** One chip in the preview bar. Presenter violet, others a soft violet with Follow. */
export function FollowBarChip({ role, labels, presenter, followers, followerCount, onAction }: {
  role: FollowRole;
  labels: FollowLabels;
  presenter: FollowPerson | null;
  followers: FollowPerson[];
  followerCount: number;
  onAction: Action;
}) {
  if (!labels.status || !labels.actionText) return null;
  const strong = role === "presenting" || role === "following";
  return <span data-testid="follow-bar-chip" data-role={role} role="group" aria-label={labels.status}
    className={`inline-flex h-[30px] min-w-0 shrink items-center gap-2 rounded-full pl-2.5 pr-1 text-[12.5px] font-semibold ${strong
      ? "bg-violet-700 text-white dark:bg-violet-500 dark:text-violet-950"
      : "bg-violet-100 text-slate-900 dark:bg-violet-950/70 dark:text-slate-100"}`}>
    {role === "presenting"
      ? <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-full bg-white shadow-[0_0_0_3px_rgba(255,255,255,0.35)]" />
      : presenter ? <HumanAvatar userId={presenter.id} displayName={presenter.name} avatarUrl={presenter.avatarUrl ?? undefined} className="h-[22px] w-[22px] text-[10px]" /> : null}
    <span className="min-w-0 truncate" data-testid="follow-status">{labels.status}</span>
    {role === "presenting" ? (followers.length
      ? <FollowerAvatars followers={followers} ringClass="ring-violet-700 dark:ring-violet-500" />
      : <span className="shrink-0 text-xs font-medium opacity-80">{followerCount ? watchingText(followerCount) : "Nobody yet"}</span>) : null}
    <button type="button" data-testid="follow-action" data-action={labels.action ?? undefined} onClick={onAction}
      className={`h-6 shrink-0 rounded-full px-2.5 text-xs font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 ${strong
        ? "bg-white text-violet-900 hover:bg-violet-50"
        : "bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-400 dark:text-violet-950"}`}>
      {labels.actionText}
    </button>
  </span>;
}

/** A 2 px violet ring around the frame while following: whose view this is stays visible. */
export function FollowRing() {
  return <div aria-hidden="true" data-testid="follow-ring" className="pointer-events-none absolute inset-0 z-[6] ring-2 ring-inset ring-violet-600 dark:ring-violet-400" />;
}

/** Where the presenter tapped, with their name, for 1.2 s (for a site that does not draw taps itself). */
export function FollowRipples({ ripples }: { ripples: FollowRipple[] }) {
  if (!ripples.length) return null;
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[5] overflow-hidden">
    {ripples.map(ripple => (
      // A 56 px box centred on the tap: the outer ring, the inner dot, and the presenter's name beside it.
      <span key={ripple.id} data-testid="follow-ripple" className="absolute -ml-7 -mt-7 h-14 w-14" style={{ left: `${ripple.x * 100}%`, top: `${ripple.y * 100}%` }}>
        <span className="absolute inset-0 rounded-full border-[3px] border-violet-600 opacity-90 motion-safe:animate-ping dark:border-violet-400" />
        <span className="absolute inset-3 rounded-full border-[3px] border-violet-600 bg-violet-600/25 dark:border-violet-400" />
        <span className="absolute left-[52px] -top-1.5 whitespace-nowrap rounded-full bg-violet-600 px-2 py-0.5 text-[11.5px] font-bold text-white dark:bg-violet-400 dark:text-violet-950">{ripple.name}</span>
      </span>
    ))}
  </div>;
}

/** "Lena took over from Kim", "Kim stopped presenting", "📍 Your location is left out": a few seconds, never in the way. */
export function FollowToast({ text, testId = "follow-note" }: { text: string; testId?: string }) {
  return <div role="status" aria-live="polite" data-testid={testId}
    className="pointer-events-none absolute inset-x-0 top-2 z-20 flex justify-center px-3">
    <span className="max-w-full truncate rounded-full bg-slate-900/90 px-3 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur">{text}</span>
  </div>;
}

type PreviewFollow = ReturnType<typeof usePreviewFollow>;

/**
 * Follow mode in the preview bar: who presents (the chip, with Follow or
 * Stop) and Present, offered only for a site that said it can share its view
 * (`layout-ack` "view"). Nothing for a site that cannot.
 */
export function SitePreviewFollowControls({ follow, supportsView }: {
  follow: PreviewFollow;
  supportsView: boolean;
}) {
  const state = follow.state;
  const labels = followLabels(state);
  const presenter = state.presence?.presenter ?? null;
  const onAction = () => {
    switch (labels.action) {
      case "stop-presenting": follow.stopPresenting(); return;
      case "stop-elsewhere": follow.stopElsewhere(); return;
      case "follow":
      case "follow-again": follow.follow(); return;
      case "stop-following": follow.stopFollowing(); return;
      default: return;
    }
  };
  const present = presentMenuLabel({ supportsView, state });
  const offerPresent = supportsView && state.role !== "presenting" && state.role !== "following" && !present.disabled;
  return <>
    <FollowBarChip role={state.role} labels={labels} presenter={presenter} followers={follow.followers}
      followerCount={state.presence?.followers ?? 0} onAction={onAction} />
    {offerPresent ? (
      <Button variant="ghost" size="sm" radius="full" data-testid="follow-present" aria-label={present.text} title={present.detail ?? present.text}
        className="max-[540px]:h-10" onPress={() => void follow.present()}>
        <Presentation className="h-4 w-4" aria-hidden="true" />
        <span className="max-[400px]:sr-only">Present</span>
      </Button>
    ) : null}
  </>;
}
