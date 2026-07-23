export const OPEN_BUG_REPORT_EVENT = "instafy:open-bug-report";
export const BUG_REPORT_DIALOG_STATE_EVENT = "instafy:bug-report-dialog-state";

export interface OpenBugReportDetail {
  message?: string;
  details?: string;
  projectId?: string | null;
}

export interface BugReportDialogStateDetail {
  open: boolean;
}

export function dispatchOpenBugReport(detail?: OpenBugReportDetail) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<OpenBugReportDetail>(OPEN_BUG_REPORT_EVENT, {
      detail: detail ?? {},
    }),
  );
}

export function dispatchBugReportDialogState(detail: BugReportDialogStateDetail) {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<BugReportDialogStateDetail>(BUG_REPORT_DIALOG_STATE_EVENT, {
      detail,
    }),
  );
}
