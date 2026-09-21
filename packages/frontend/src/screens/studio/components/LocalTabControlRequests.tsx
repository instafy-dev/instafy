import type {
  LocalExploreState,
  LocalExploreControl,
} from "../../../services/runtimeController/localTabExplore";
import { useEffect, useState } from "react";
import { Button } from "../../../components/Button";
import {
  browserShareClient,
  type BrowserShareViewer,
} from "../../../services/runtimeController/browserShares";
import type {
  LocalTabControlState,
  LocalTabPublisherControl,
} from "../../../services/runtimeController/localTabControl";

export function LocalTabControlRequests({
  projectId,
  shareId,
  state,
  control,
  explore,
  exploreState,
}: {
  projectId: string;
  shareId: string;
  state: LocalTabControlState | null;
  control: LocalTabPublisherControl;
  explore?: LocalExploreControl;
  exploreState?: LocalExploreState | null;
}) {
  const [people, setPeople] = useState<BrowserShareViewer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestIds = [
    ...(state?.requests ?? []),
    ...(exploreState?.requests ?? []),
    ...(exploreState?.views ?? []),
  ]
    .map((r) => r.connectionId)
    .join(",");
  const ownerId = state?.grant?.userId;
  useEffect(() => {
    let disposed = false;
    if (requestIds || ownerId)
      void browserShareClient(projectId)
        .then((c) => c.viewers(shareId))
        .then((p) => {
          if (!disposed) setPeople(p);
        })
        .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [projectId, shareId, requestIds, ownerId]);
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
    <div className="space-y-1 text-xs" data-testid="local-tab-control-owner">
      {state?.grant ? (
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
            <span>{label(request.userId)} wants to explore independently</span>
            <Button
              size="sm"
              data-testid="local-tab-allow-explore"
              isDisabled={busy || (exploreState.views?.length ?? 0) >= 4}
              onPress={() => void act(() => explore.approve(request))}
            >
              Allow Explore
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onPress={() => explore.deny(request.connectionId)}
            >
              Decline
            </Button>
            <span className="text-slate-500">
              Opens a separate page using this browser’s signed-in accounts.
              Saved changes may appear in your tab.
            </span>
          </div>
        ) : null,
      )}
      {exploreState?.views?.map((view) =>
        explore ? (
          <div key={view.viewId} className="flex flex-wrap items-center gap-2">
            <span>{label(view.userId)} is exploring independently</span>
            <Button
              size="sm"
              variant="ghost"
              data-testid="local-tab-end-explore"
              onPress={() => void act(() => explore.close(view.viewId))}
            >
              End Explore
            </Button>
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
