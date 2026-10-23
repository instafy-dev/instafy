import type { ControllerAutomation } from "../../../src/sdk/instafy";

const params = new URLSearchParams(window.location.search);
const schedule = params.get("schedule");
const mode = params.get("save") ?? "success";
let settleSave: (() => void) | undefined;
const automation: ControllerAutomation = {
  id: "review-automation", projectId: "review-space", userId: "review-user", name: "Daily project review",
  promptText: "Review the latest changes and summarize anything that needs attention.", metadata: {},
  scheduleKind: schedule === "once" || schedule === "hourly" ? schedule : "weekly",
  runAt: "2027-01-05T09:00:00Z", intervalHours: 4, byDay: ["mo", "tu", "we", "th", "fr"], byHour: 9, byMinute: 0,
  timezone: "Europe/Vienna", runtimeMode: "auto", runtimeProvider: null, conversationId: null,
  silentWhenNothingToReport: true, status: "active", lockedUntil: null, lastRunAt: null,
  nextRunAt: "2027-01-05T08:00:00Z", lastError: null,
  createdAt: "2026-10-22T09:00:00Z", updatedAt: "2026-10-22T09:00:00Z",
};
let records = [automation];
async function save(input: Partial<ControllerAutomation>) {
  window.dispatchEvent(new CustomEvent("review:save", { detail: input }));
  if (mode === "error") throw new Error("Could not save automation. Your changes are still here.");
  if (mode === "pending") await new Promise<void>(resolve => { settleSave = resolve; });
  records = [{ ...automation, ...input }];
  return records[0];
}
export function completePendingSave() { settleSave?.(); }
export const controllerClient = {
  automations: {
    listForProject: async () => records,
    create: save,
    update: save,
    delete: async () => { records = []; },
    runNow: async () => ({ success: true }),
  },
  runs: { fetch: async () => ({ runs: [], notFound: false, unauthorized: false, forbidden: false }) },
};
export const useAuth = () => ({ user: { id: "review-user" } });
export const useProjects = () => ({ activeProjectId: "review-space" });
export const useRuntimeState = () => ({ runs: {} });
export const useWorkspaceTabs = () => ({ openConversationTab() {}, requestUrlPush() {} });
