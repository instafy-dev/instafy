import { useEffect, useState, type ReactNode } from "react";
import { Button as AriaButton, DialogTrigger, Heading, type PopoverProps } from "react-aria-components";
import { Xmark } from "iconoir-react";
import type { ControllerHumanProfile } from "@instafy/sdk/human-profiles";
import { Button, IconButton } from "../components/Button";
import { HumanAvatar } from "../components/HumanAvatar";
import { ResponsiveDialogSurface } from "../components/aria/ResponsiveDialogSurface";
import { useAuth } from "../providers/AuthProvider";
import { fetchHumanProfile } from "./humanProfileService";

type ProfileState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; profile: ControllerHumanProfile };

function HumanProfileContent({ projectId, userId, onClose }: {
  projectId: string;
  userId: string;
  onClose: () => void;
}) {
  const { user, session } = useAuth();
  const token = session?.access_token ?? null;
  const viewerId = user?.id ?? null;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    projectId: string;
    userId: string;
    viewerId: string | null;
    token: string | null;
    state: ProfileState;
  } | null>(null);

  useEffect(() => {
    const request = new AbortController();
    const context = { projectId, userId, viewerId, token };
    if (!viewerId || !token) {
      setResult({ ...context, state: { status: "error" } });
      return;
    }
    setResult({ ...context, state: { status: "loading" } });
    void fetchHumanProfile({ projectId, userId, accessToken: token, signal: request.signal }).then(
      (profile) => {
        if (!request.signal.aborted) setResult({ ...context, state: { status: "ready", profile } });
      },
      () => {
        if (!request.signal.aborted) setResult({ ...context, state: { status: "error" } });
      },
    );
    return () => request.abort();
  }, [projectId, userId, viewerId, token, attempt]);

  // Hide the previous account/space's data during render, before effect cleanup.
  const state: ProfileState = result?.projectId === projectId && result.userId === userId
    && result.viewerId === viewerId && result.token === token ? result.state : { status: "loading" };
  const profile = state.status === "ready" ? state.profile : null;
  const displayName = profile?.displayName?.trim() || "Teammate";

  return (
    <div className="space-y-4 p-4" data-human-profile-card="">
      <div className="flex items-start gap-3">
        {profile ? <HumanAvatar userId={profile.userId} displayName={profile.displayName} avatarUrl={profile.avatarUrl} className="h-12 w-12 text-sm" /> : null}
        <Heading slot="title" className="min-w-0 flex-1 self-center break-words text-sm font-semibold text-slate-800 dark:text-slate-100">
          {profile ? displayName : "Profile"}
        </Heading>
        <IconButton aria-label="Close profile" variant="ghost" size="sm" className="-mr-1 -mt-1 h-11 w-11 shrink-0 lg:h-8 lg:w-8" onPress={onClose}>
          <Xmark className="h-4 w-4" aria-hidden="true" />
        </IconButton>
      </div>
      {state.status === "loading" ? <p role="status" className="text-sm text-slate-500 dark:text-slate-400">Loading profile…</p> : null}
      {state.status === "error" ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-slate-600 dark:text-slate-300">This profile could not be loaded. Access to this space may have changed.</p>
          <Button variant="secondary" size="sm" radius="xl" className="min-h-11 lg:min-h-9" onPress={() => setAttempt((value) => value + 1)}>Try again</Button>
        </div>
      ) : null}
      {profile ? (
        <div className="space-y-1.5">
          <h3 className="text-xs font-medium text-slate-500 dark:text-slate-400">About</h3>
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700 dark:text-slate-200">
            {profile.bio?.trim() || "No introduction yet."}
          </p>
        </div>
      ) : null}
    </div>
  );
}

interface HumanProfilePopoverProps {
  projectId?: string | null;
  userId?: string | null;
  displayName: string;
  children: ReactNode;
  className?: string;
  placement?: PopoverProps["placement"];
}

function ScopedHumanProfilePopover({ projectId, userId, displayName, children, className, placement = "bottom start" }: HumanProfilePopoverProps & { projectId: string; userId: string }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <AriaButton aria-label={`View profile for ${displayName}`} className={`outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 ${className ?? "inline-flex rounded-full"}`}>
        {children}
      </AriaButton>
      {open ? (
        <ResponsiveDialogSurface
          desktop={{ placement, offset: 8, className: "w-80 max-w-[calc(100vw-2rem)] overflow-hidden p-0" }}
          mobile={{ modalClassName: "max-w-sm", dialogAriaLabel: "Person profile" }}
          mobileFullScreen={false}
        >
          <HumanProfileContent projectId={projectId} userId={userId} onClose={close} />
        </ResponsiveDialogSurface>
      ) : null}
    </DialogTrigger>
  );
}

/** Only known people inside the current space can open a card; never a global directory. */
export function HumanProfilePopover(props: HumanProfilePopoverProps) {
  const projectId = props.projectId?.trim();
  const userId = props.userId?.trim();
  if (!projectId || !userId) return <span className={props.className}>{props.children}</span>;
  // A switch of space/person closes and disposes any already-open card.
  return <ScopedHumanProfilePopover key={`${projectId}:${userId}`} {...props} projectId={projectId} userId={userId} />;
}
