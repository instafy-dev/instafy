import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../../../components/Button";
import { InlineNotice } from "../../../components/InlineNotice";
import { LoadingStatus } from "../../../components/LoadingStatus";
import { SettingsFormLayout } from "../../../components/SettingsFormLayout";
import { Text } from "../../../components/Text";
import { useAuth } from "../../../providers/AuthProvider";
import { useStatus } from "../../../status/useStatus";
import { controllerClient, type MyMachine } from "../../../sdk/instafy";
import { spaceDisplayName } from "../../../projects/spaceName";
import { formatRelativeTimestamp } from "../homeFeed";
import { SettingsSection } from "./SettingsSection";

const PENDING_STATUS = "pending";

const STATUS_LABELS: Record<string, string> = {
  ready: "Online",
  running: "Online",
  busy: "Online",
  draining: "Online",
  requested: "Starting",
  requesting: "Starting",
  registering: "Starting",
  launching: "Starting",
  starting: "Starting",
  stopping: "Stopping",
  stopped: "Stopped",
  offline: "Offline",
  removed: "Removed",
  failed: "Failed",
};

// Each row is one runtime in one space, so a computer used in several spaces
// has a row in each, and revoking a row ends that space's access only.
const MY_MACHINES_DESCRIPTION = (
  <>
    Computers and servers that run work in your spaces for you, such as Instafy Desktop and machines started with{" "}
    <span className="font-mono">instafy runtime start</span>. A computer used in several spaces is listed once per
    space. Revoke one you lost or no longer use: its access to that space ends now, and it stops if it is running.
    Revoke all ends every one, in every space. Revoking doesn't sign you out on it, so a machine that still has your
    sign-in can start again: to end that too, sign out everywhere.
  </>
);

// Signing out everywhere ends every sign-in, this one too; only an access
// token a device already holds lasts, at the database and file storage,
// until it expires.
const SIGN_OUT_EVERYWHERE_DESCRIPTION =
  "Lost a computer or phone? End every sign-in of yours, in every browser, app and terminal, this one too. It also " +
  "revokes all your machines and the access to your devices you gave agents, and stops your notifications on every " +
  "device. To use Instafy again, sign in again. A device with Instafy already open may keep some access for up to " +
  "an hour, until the sign-in it holds expires.";

const SIGN_OUT_EVERYWHERE_QUESTION =
  "Sign out everywhere? Every browser, app and terminal signed in as you is signed out, this one too, and all your " +
  "machines are revoked. To use Instafy again, sign in again.";

// A row and the list take focus only after a revocation (they are not in the
// tab order), and show it with the shared focus ring.
const FOCUS_TARGET_CLASSES =
  "rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-[var(--color-studio-dark-canvas)]";

/** The name a machine is shown with. */
export function myMachineName(machine: MyMachine): string {
  if (machine.displayName) return machine.displayName;
  if (machine.status === PENDING_STATUS) return "New machine";
  if (machine.personalBrowser) return "Personal Browser";
  return "Self-hosted machine";
}

/** The space a machine runs work in, named as its row names it. */
function myMachineSpace(machine: MyMachine, startOfSentence = false): string {
  if (machine.projectReadable) return spaceDisplayName(machine.projectName);
  return `${startOfSentence ? "A" : "a"} space you can no longer open`;
}

function timeOf(value: string | null): number {
  return value ? Date.parse(value) : Number.NaN;
}

function ago(value: string | null, nowMs: number): string | null {
  const at = timeOf(value);
  const relative = formatRelativeTimestamp(Number.isFinite(at) ? at : null, nowMs);
  if (!relative) return null;
  return relative === "just now" ? relative : `${relative} ago`;
}

/** Revoked, and when, for a machine you revoked; otherwise its status. */
function myMachineState(machine: MyMachine, nowMs: number): string {
  if (!machine.revoked) return STATUS_LABELS[machine.status.toLowerCase()] ?? machine.status;
  // Its tokens no longer work there, whatever state it was left in.
  const revoked = ago(machine.revokedAt, nowMs);
  return revoked ? `Revoked ${revoked}` : "Revoked";
}

/**
 * When it was last heard from. Revoking a running machine stops it, and that
 * stop stamps last seen with its own time, a moment after the revocation's:
 * a revoked machine shows last seen only for a sighting from before that.
 */
function myMachineLastSeen(machine: MyMachine, nowMs: number): string | null {
  // Without both times, no stamp is known to come first.
  if (machine.revoked && !(timeOf(machine.lastSeenAt) < timeOf(machine.revokedAt))) return null;
  return ago(machine.lastSeenAt, nowMs);
}

/** The space, the state and when it was last heard from. */
export function myMachineDetail(machine: MyMachine, nowMs: number): string {
  const parts = [myMachineSpace(machine, true)];
  if (machine.personalBrowser && machine.displayName) parts.push("Personal Browser");
  if (machine.status === PENDING_STATUS && !machine.revoked) {
    const minted = ago(machine.mintedAt, nowMs);
    parts.push(minted ? `Token made ${minted}, not connected yet` : "Not connected yet");
  } else {
    parts.push(myMachineState(machine, nowMs));
    const seen = myMachineLastSeen(machine, nowMs);
    if (seen) parts.push(`last seen ${seen}`);
  }
  return parts.join(" · ");
}

/**
 * What a row's Revoke asks. A row is one runtime in one space, so it names
 * that space: the same computer's rows in other spaces keep their access.
 * Starting a machine in a space takes write access to it, so a space you can
 * no longer open has no way back to offer.
 */
function revokeQuestion(machine: MyMachine): string {
  const question = `Revoke “${myMachineName(machine)}” in ${myMachineSpace(machine)}?`;
  if (machine.status === PENDING_STATUS) {
    return [
      question,
      "No machine has connected with its token yet, and the token stops working now.",
      machine.projectReadable
        ? "To connect a machine there, start it from Instafy on that machine."
        : "You can't connect a machine there unless you get access to that space back.",
    ].join(" ");
  }
  return [
    question,
    "Its access to that space ends now, and it stops if it is running.",
    machine.projectReadable
      ? "To use it there again, start it again from Instafy on that machine."
      : "You can't use it there again unless you get access to that space back.",
  ].join(" ");
}

/** Where focus goes once a revocation pressed from the focused control succeeds. */
interface FocusAfterRevoke {
  /** The row revoked, or null for Revoke all. */
  runtimeId: string | null;
  /** The rows listed after it when it was pressed. */
  nextIds: string[];
  /** Its section, whose heading takes focus once no row is listed. */
  section: Element | null;
}

/**
 * The focus to restore after a revocation pressed on `control`, or null when
 * the control did not have focus (a mouse click in Safari, a script): then
 * focus was never on it and is not this list's to move.
 */
function focusAfterRevoke(control: Element, runtimeId: string | null, after: MyMachine[]): FocusAfterRevoke | null {
  if (typeof document === "undefined" || document.activeElement !== control) return null;
  return { runtimeId, nextIds: after.map((row) => row.runtimeId), section: control.closest("section") };
}

/**
 * The row it revoked, which stays listed as revoked. A token it revoked is
 * gone, so the next row's Revoke (or that row, revoked too) takes focus; with
 * no row after it, the list; with no row at all, the section's heading.
 */
function focusTargetAfterRevoke(
  request: FocusAfterRevoke,
  rows: ReadonlyMap<string, HTMLElement>,
  list: HTMLElement | null,
): HTMLElement | null {
  const row = request.runtimeId === null ? undefined : rows.get(request.runtimeId);
  if (row) return row;
  for (const id of request.nextIds) {
    const next = rows.get(id);
    if (next) return next.querySelector<HTMLElement>("button") ?? next;
  }
  if (list) return list;
  const heading = request.section?.querySelector<HTMLElement>("h3") ?? null;
  // A heading takes focus only when it is given a tabindex.
  heading?.setAttribute("tabindex", "-1");
  return heading;
}

/**
 * Sign out everywhere: every sign-in of yours ends, this one too, so this
 * page goes to sign-in once it succeeds.
 */
function SignOutEverywhereSection({ isDisabled }: { isDisabled: boolean }) {
  const { signOutEverywhere } = useAuth();
  const { showStatus } = useStatus();
  const [pending, setPending] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const signOut = useCallback(async () => {
    if (typeof window !== "undefined" && !window.confirm(SIGN_OUT_EVERYWHERE_QUESTION)) {
      return;
    }
    setPending(true);
    try {
      await signOutEverywhere();
      // Shown on the sign-in page this one goes to.
      showStatus("Signed out everywhere.", "success", 2500);
    } catch (error) {
      // Nothing was signed out: the controller signs out all or nothing.
      showStatus(error instanceof Error ? error.message : "Unable to sign out everywhere.", "error", 4500);
    } finally {
      if (mountedRef.current) setPending(false);
    }
  }, [showStatus, signOutEverywhere]);

  return (
    <SettingsSection
      title="Sign out everywhere"
      description={SIGN_OUT_EVERYWHERE_DESCRIPTION}
      data-testid="sign-out-everywhere-section"
      actions={
        <Button
          variant="outline"
          tone="danger"
          size="sm"
          radius="lg"
          onPress={() => void signOut()}
          // Pending, not disabled, so it keeps focus while it works.
          isPending={pending}
          isDisabled={!pending && isDisabled}
          data-testid="sign-out-everywhere"
        >
          Sign out everywhere
        </Button>
      }
    />
  );
}

/** Profile → Machines: your own machines in every space, with Revoke. */
export function MyMachinesSettings() {
  const { user } = useAuth();
  return <ScopedMyMachinesSettings key={user?.id ?? "signed-out"} userId={user?.id ?? null} />;
}

function ScopedMyMachinesSettings({ userId }: { userId: string | null }) {
  const { showStatus } = useStatus();
  const queryClient = useQueryClient();
  const queryKey = useMemo(() => ["my-machines", userId] as const, [userId]);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const machinesQuery = useQuery({
    queryKey,
    enabled: Boolean(userId),
    staleTime: 0,
    queryFn: async () => {
      const result = await controllerClient.runtimes.listMine();
      if (!result.success) throw new Error(result.error || "Unable to load your machines.");
      return result.machines;
    },
  });
  const { refetch } = machinesQuery;
  const loading = machinesQuery.isFetching;
  // Offline, the read waits rather than fails: nothing is fetching and
  // nothing failed, yet the list may never have been read.
  const offline = machinesQuery.isPaused;
  const hasRead = machinesQuery.data !== undefined;
  const loadError = machinesQuery.error
    ? hasRead ? "Couldn't refresh your machines. Try again." : "Couldn't load your machines. Try again."
    : null;
  // Never act on a list that may be out of date: a machine revoked elsewhere
  // or a space left meanwhile shows only after a good read.
  const machines = useMemo(() => loadError ? [] : machinesQuery.data ?? [], [loadError, machinesQuery.data]);
  // A revoked machine stays listed, as revoked, until it is started again.
  const anyRevocable = machines.some((machine) => !machine.revoked);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const nowMs = machinesQuery.dataUpdatedAt || Date.now();
  const detailIdPrefix = useId();
  const listRef = useRef<HTMLUListElement | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const focusAfterRevokeRef = useRef<FocusAfterRevoke | null>(null);

  // A revoked row's Revoke becomes status text, and Revoke all goes once
  // nothing is left to revoke. Once the list read after the revocation
  // renders, focus moves from the control that went to the stable row.
  useLayoutEffect(() => {
    const request = focusAfterRevokeRef.current;
    if (!request || pendingId !== null) return;
    focusAfterRevokeRef.current = null;
    // Only focus that went with its control: never take it from where the
    // person moved it while the revocation ran.
    const active = document.activeElement;
    if (active && active !== document.body) return;
    focusTargetAfterRevoke(request, rowRefs.current, listRef.current)?.focus();
  }, [pendingId]);

  const revoke = useCallback(
    async (
      selection: { runtimeIds: string[] } | { all: true },
      question: string,
      done: string,
      focusAfter: FocusAfterRevoke | null,
    ) => {
      if (typeof window !== "undefined" && !window.confirm(question)) {
        return;
      }
      setPendingId("all" in selection ? "all" : selection.runtimeIds[0] ?? null);
      try {
        const result = await controllerClient.runtimes.revokeMine(selection);
        // The list changed either way: a machine may have been revoked, or
        // stopped being yours, elsewhere.
        await queryClient.invalidateQueries({ queryKey, exact: true });
        if (!mountedRef.current) return;
        if (!result.success) {
          // Its Revoke stays, and keeps focus.
          showStatus(result.error || "Unable to revoke the machine.", "error", 4500);
          return;
        }
        focusAfterRevokeRef.current = focusAfter;
        const ended = result.revoked.length + result.pendingEnded.length;
        showStatus(ended > 0 ? done : "There was nothing to revoke.", "success", 2500);
      } catch (error) {
        if (mountedRef.current) {
          showStatus(error instanceof Error ? error.message : "Unable to revoke the machine.", "error", 4500);
        }
      } finally {
        if (mountedRef.current) setPendingId(null);
      }
    },
    [queryClient, queryKey, showStatus],
  );

  const revokeOne = useCallback((machine: MyMachine, control: Element) => {
    const index = machines.findIndex((row) => row.runtimeId === machine.runtimeId);
    void revoke(
      { runtimeIds: [machine.runtimeId] },
      revokeQuestion(machine),
      "Machine revoked.",
      focusAfterRevoke(control, machine.runtimeId, machines.slice(index + 1)),
    );
  }, [machines, revoke]);

  const revokeAll = useCallback((control: Element) => {
    void revoke(
      { all: true },
      "Revoke all your machines? Their access ends now, in every space, and the ones running stop. To use one again, start it again from Instafy on that machine.",
      "Your machines were revoked.",
      focusAfterRevoke(control, null, []),
    );
  }, [revoke]);

  const busy = pendingId !== null;

  return (
    <SettingsFormLayout data-testid="my-machines-settings">
      <SettingsSection
        title="Your machines"
        description={MY_MACHINES_DESCRIPTION}
        actions={anyRevocable ? (
          <Button
            variant="outline"
            tone="danger"
            size="sm"
            radius="lg"
            onPress={(event) => revokeAll(event.target)}
            // Pending, not disabled, so it keeps focus while it works.
            isPending={pendingId === "all"}
            isDisabled={pendingId !== "all" && (busy || loading || offline)}
            data-testid="my-machines-revoke-all"
          >
            Revoke all
          </Button>
        ) : undefined}
      >
        {!userId ? (
          <Text variant="bodyCompact" tone="muted">Sign in to see your machines.</Text>
        ) : null}

        {userId && loading ? (
          <LoadingStatus>{hasRead ? "Refreshing your machines…" : "Loading your machines…"}</LoadingStatus>
        ) : null}

        {userId && offline ? (
          <InlineNotice tone="warning" role="status" data-testid="my-machines-offline">
            {hasRead
              ? "You're offline. Your machines refresh once you're back online."
              : "You're offline. Your machines show here once you're back online."}
          </InlineNotice>
        ) : null}

        {loadError ? (
          <InlineNotice tone="danger" role="alert" actions={
            <Button variant="text" tone="danger" size="sm" onPress={() => void refetch()} isDisabled={loading}>
              Retry
            </Button>
          }>{loadError}</InlineNotice>
        ) : null}

        {userId && hasRead && !loading && !offline && !loadError && machines.length === 0 ? (
          <div className="space-y-1" data-testid="my-machines-empty">
            <Text variant="bodyStrong" tone="secondary">No machines.</Text>
            <Text variant="bodyCompact" tone="muted">
              A computer shows here once it runs work in one of your spaces with your sign-in.
            </Text>
          </div>
        ) : null}

        {machines.length > 0 ? (
          <ul
            ref={listRef}
            // Focus lands here after Revoke all.
            tabIndex={-1}
            className={`space-y-4 ${FOCUS_TARGET_CLASSES}`}
            data-testid="my-machines-list"
          >
            {machines.map((machine) => {
              const name = myMachineName(machine);
              const rowBusy = pendingId === machine.runtimeId;
              const detailId = `${detailIdPrefix}-detail-${machine.runtimeId}`;
              return (
                <li
                  key={machine.runtimeId}
                  ref={(node) => {
                    if (node) rowRefs.current.set(machine.runtimeId, node);
                    else rowRefs.current.delete(machine.runtimeId);
                  }}
                  // Focus returns to the stable row once its Revoke becomes
                  // status text.
                  tabIndex={-1}
                  className={`flex flex-wrap items-start justify-between gap-x-6 gap-y-2 ${FOCUS_TARGET_CLASSES}`}
                  data-testid={`my-machines-row-${machine.runtimeId}`}
                >
                  <div className="min-w-0 grow basis-64">
                    <Text variant="bodyStrong" tone="primary" className="break-words">{name}</Text>
                    <Text id={detailId} variant="caption" tone="muted" className="mt-0.5 break-words">
                      {myMachineDetail(machine, nowMs)}
                    </Text>
                  </div>
                  {machine.revoked ? null : (
                    <Button
                      onPress={(event) => revokeOne(machine, event.target)}
                      variant="ghost"
                      tone="danger"
                      size="sm"
                      radius="full"
                      // The pressed Revoke is pending, not disabled, so it
                      // keeps focus while it works; the others wait.
                      isPending={rowBusy}
                      isDisabled={busy && !rowBusy}
                      // The same computer is listed under one name in each
                      // space it is used in, so the space tells the rows apart.
                      aria-label={`Revoke ${name} in ${myMachineSpace(machine)}`}
                      aria-describedby={detailId}
                      data-testid={`my-machines-revoke-${machine.runtimeId}`}
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </SettingsSection>
      {userId ? <SignOutEverywhereSection isDisabled={busy} /> : null}
    </SettingsFormLayout>
  );
}
