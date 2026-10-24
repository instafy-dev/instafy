import { useMemo } from "react";
import { collectPlanReruns, describePlanRerun, type PlanRerun } from "./planReruns";

/**
 * One quiet line for a lane the controller started again: what happened, and
 * a link to the run that now stands for it. Not a failure, so not red.
 */
export function PlanRerunNotice({
  subject,
  rerun,
  onOpen,
  className = "",
}: {
  /** Who it happened to: a lane's handle, or "This lane". */
  subject: string;
  rerun: PlanRerun;
  onOpen?: ((jobId: string) => void) | null;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={`text-xxs leading-relaxed text-slate-500 dark:text-slate-400 ${className}`}
      data-testid="plan-rerun-notice"
      data-rerun-reason={rerun.reason || undefined}
    >
      {subject} {describePlanRerun(rerun.reason)}.
      {onOpen ? (
        <button
          type="button"
          className="ml-1 inline-flex items-center font-medium text-primary-700 hover:text-primary-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 dark:text-primary-200 dark:hover:text-primary-100"
          onClick={() => onOpen(rerun.jobId)}
          data-testid="plan-rerun-open"
        >
          Open continuation
        </button>
      ) : null}
    </div>
  );
}

/**
 * The end of a plan job's run trace: when the controller ran the job's agent
 * again, one quiet line to the run that stands for it; otherwise nothing.
 */
export function RunTraceRerunNotice({
  jobId,
  sources,
  onOpen,
}: {
  jobId: string;
  /** The conversation's runs and messages; reruns name the job they ran again. */
  sources: ReadonlyArray<{ metadata?: Record<string, unknown> | null }>;
  onOpen: (jobId: string) => void;
}) {
  const rerun = useMemo(() => collectPlanReruns(sources).latest(jobId), [jobId, sources]);
  return rerun ? <PlanRerunNotice subject="This lane" rerun={rerun} onOpen={onOpen} className="px-1" /> : null;
}
