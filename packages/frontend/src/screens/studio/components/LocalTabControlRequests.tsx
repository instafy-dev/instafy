import type {
  LocalExploreState,
  LocalExploreControl,
} from "../../../services/runtimeController/localTabExplore";
import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import type { BrowserSharePerson } from "../../../services/runtimeController/browserShares";
import type {
  LocalTabControlState,
  LocalTabPublisherControl,
} from "../../../services/runtimeController/localTabControl";

export function LocalTabControlRequests({
  people,
  state,
  control,
  explore,
  exploreState,
  showTakeBack = true,
}: {
  showTakeBack?: boolean;
  people: readonly BrowserSharePerson[];
  state: LocalTabControlState | null;
  control: LocalTabPublisherControl;
  explore?: LocalExploreControl;
  exploreState?: LocalExploreState | null;
}) {
  const requestsRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // An approved/declined request removes its focused button. Keep Escape and
    // keyboard navigation in the management dialog after the server responds.
    if (document.activeElement === document.body) {
      requestsRef.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
    }
  }, [state?.requests, exploreState?.requests, exploreState?.views]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const label = (id: string) => {
    const p = people.find((p) => p.userId === id);
    return p?.fullName || p?.email || "A participant";
  };
  async function act(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change control.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div ref={requestsRef} className="space-y-1 text-xs" data-testid="local-tab-control-owner">
      {state?.grant && showTakeBack ? (
        <div className="flex flex-wrap items-center gap-2">
          <span role="status">
            {label(state.grant.userId)} controls this tab
          </span>
          <Button
            size="sm"
            data-testid="local-tab-take-back"
            onPress={() => void act(control.revoke)}
          >
            Take back control
          </Button>
        </div>
      ) : null}
      {state?.requests?.map((request) => (
        <div
          key={request.connectionId}
          className="flex flex-wrap items-center gap-2"
        >
          <span>{label(request.userId)} requests control</span>
          <Button
            size="sm"
            data-testid="local-tab-grant-control"
            isDisabled={busy || Boolean(state.grant)}
            onPress={() => void act(() => control.grant(request.connectionId))}
          >
            Allow control
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onPress={() => control.deny(request.connectionId)}
          >
            Decline
          </Button>
          <span className="text-slate-500">
            They can click and type in this tab using its signed-in accounts.
          </span>
        </div>
      ))}
      {exploreState?.requests?.map((request) =>
        explore ? (
          <div
            key={`explore-${request.connectionId}`}
            className="flex flex-wrap items-center gap-2"
          >
            <span>{label(request.userId)} wants to browse independently</span>
            <Button
              size="sm"
              data-testid="local-tab-allow-explore"
              isDisabled={busy || (exploreState.views?.length ?? 0) >= 4}
              onPress={() => void act(() => explore.approve(request))}
            >
              Allow browsing
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => explore.deny(request.connectionId)}
            >
              Decline
            </Button>
            <span className="text-slate-500">
              Their page and scroll are separate. Website logins and saved data
              are shared; changes depend on the website.
            </span>
          </div>
        ) : null,
      )}
      {error ? (
        <p role="alert" className="text-rose-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
