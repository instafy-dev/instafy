import type { ControllerBugReportSummary } from "../../services/runtimeController/bugReports";
import { isUUID } from "../../utils/uuid";

/** Customer-visible unread activity only; report details and diagnostics stay in the report. */
export interface HomeSupportReport {
  id: string;
  title: string;
  projectId: string | null;
  activityAt: string | null;
  supportLastMessageAt: string | null;
  resolvedAt: string | null;
  hasUnreadResolution: boolean;
}

export function buildHomeSupportReports(reports: ControllerBugReportSummary[]): HomeSupportReport[] {
  const unread = new Map<string, HomeSupportReport>();
  for (const report of reports) {
    if (!report.hasUnreadSupportActivity || !isUUID(report.id)) continue;
    const id = report.id.toLowerCase();
    if (unread.has(id)) continue;
    const title = report.message.replace(/\s+/g, " ").trim();
    const supportTimes = [report.supportLastMessageAt, report.resolvedAt]
      .filter((at): at is string => at !== null && Number.isFinite(Date.parse(at)))
      .sort((a, b) => Date.parse(b) - Date.parse(a));
    unread.set(id, {
      id,
      title: title ? title.length > 160 ? `${title.slice(0, 159)}…` : title : "Support report",
      projectId: report.projectId && isUUID(report.projectId) ? report.projectId.toLowerCase() : null,
      activityAt: supportTimes[0] ?? report.activityAt ?? report.createdAt,
      supportLastMessageAt: report.supportLastMessageAt,
      resolvedAt: report.resolvedAt,
      hasUnreadResolution: report.hasUnreadResolution,
    });
  }
  return [...unread.values()];
}
