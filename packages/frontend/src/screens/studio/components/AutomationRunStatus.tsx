import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Text } from "../../../components/Text";
import { useRuntimeState } from "../../../runtime/RuntimeStateProvider";
import { controllerClient, type ControllerAutomation } from "../../../sdk/instafy";
import type { RunRecord } from "../../../types";
import { getAutomationLatestRun, getAutomationRunPresentation } from "./automationRunPresentation";

type RunHistory = { status: "loading" | "available" | "denied" | "unavailable"; runs: RunRecord[] };
const AutomationRunHistoryContext = createContext<RunHistory>({ status: "unavailable", runs: [] });
export const AUTOMATION_RECENT_RUN_LIMIT = 100;

type RunHistoryProps = {
  projectId: string | null;
  userId: string | null;
  automations: ControllerAutomation[];
  children: ReactNode;
};

export function AutomationRunHistoryProvider(props: RunHistoryProps) {
  if (!props.projectId || !props.userId || !props.automations.some((automation) => automation.lastRunAt && automation.conversationId && !automation.lastError)) {
    return props.children;
  }
  return <LoadedAutomationRunHistory {...props} projectId={props.projectId} userId={props.userId} />;
}

function LoadedAutomationRunHistory({ projectId, userId, automations, children }: RunHistoryProps & { projectId: string; userId: string }) {
  const { runs } = useRuntimeState();
  const refreshedRunIds = useRef(new Set<string>());
  const history = useQuery({
    queryKey: ["automation-recent-runs", userId, projectId],
    staleTime: 30_000,
    retry: false,
    queryFn: async ({ signal }): Promise<RunHistory> => {
      const result = await controllerClient.runs.fetch({ projectId, limit: AUTOMATION_RECENT_RUN_LIMIT });
      // The existing client does not accept AbortSignal; discarded scopes must
      // still never publish their eventual response into this component.
      if (signal.aborted) throw new DOMException("Run history query canceled", "AbortError");
      if (result.unauthorized || result.forbidden || result.notFound) return { status: "denied", runs: [] };
      // This client also returns an empty list for transport failures. Neither
      // that response nor a bounded recent page proves an automation never ran.
      return { status: result.runs.length ? "available" : "unavailable", runs: result.runs };
    },
  });
  const snapshot = history.data;
  const { refetch } = history;
  useEffect(() => {
    if (!snapshot || snapshot.status === "denied" || history.isFetching || history.isError) return;
    const authorizedIds = new Set(snapshot.runs.map((run) => run.id));
    const unseen = automations.flatMap((automation) => {
      const run = getAutomationLatestRun(automation, Object.values(runs));
      return run && !authorizedIds.has(run.id) && !refreshedRunIds.current.has(run.id) ? [run.id] : [];
    });
    if (!unseen.length) return;
    // Reconcile a newly observed automation turn once through the authorized
    // shared list. No row fetches or polling, and no retries on status churn.
    unseen.forEach((id) => refreshedRunIds.current.add(id));
    void refetch();
  }, [automations, history.isError, history.isFetching, refetch, runs, snapshot]);

  const value = useMemo<RunHistory>(() => {
    if (history.isError) return { status: "unavailable", runs: [] };
    if (!snapshot) return { status: "loading", runs: [] };
    if (snapshot.status !== "available") return snapshot;
    return {
      status: "available",
      runs: snapshot.runs.map((record) => {
        const live = runs[record.id];
        // Only update records authorized by this user's project query. A
        // previous session's unvalidated store entries cannot supply a result.
        if (!live || live.projectId !== projectId || live.conversationId !== record.conversationId) return record;
        return Date.parse(live.updatedAt ?? "") >= Date.parse(record.updatedAt ?? "") ? live : record;
      }),
    };
  }, [history.isError, projectId, runs, snapshot]);
  return <AutomationRunHistoryContext.Provider value={value}>{children}</AutomationRunHistoryContext.Provider>;
}

export function AutomationRunStatus({ automation }: { automation: ControllerAutomation }) {
  const history = useContext(AutomationRunHistoryContext);
  const latestRun = useMemo(() => getAutomationLatestRun(automation, history.runs), [automation, history.runs]);
  if (!latestRun) {
    return (
      <Text variant="caption" tone="muted" data-testid={`automation-run-status-${automation.id}`}>
        {history.status === "loading" ? "Loading recent turn details…"
          : history.status === "denied" ? "Turn details are unavailable for this account."
          : "Recent turn details are unavailable. Open the thread to review its activity."}
      </Text>
    );
  }
  const presentation = getAutomationRunPresentation(latestRun);
  return (
    <div className="min-w-0 space-y-1" data-testid={`automation-run-status-${automation.id}`}>
      <Text variant="caption" tone={presentation.tone}>{presentation.label}</Text>
      {presentation.summary ? (
        <Text variant="caption" tone="secondary" className="line-clamp-3 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
          <span className="font-medium">{presentation.summaryLabel}: </span>{presentation.summary}
        </Text>
      ) : null}
    </div>
  );
}
