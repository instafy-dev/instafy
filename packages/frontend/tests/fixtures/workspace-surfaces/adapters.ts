import { useSyncExternalStore } from "react";
import { filesApi, filesControllerExtras, isFilesReviewReadOnly } from "./filesAdapters";

export const REVIEW_PROJECT_ID = "review-space";
let revision = 0;
const listeners = new Set<() => void>();
const subscribe = (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; };
const changed = () => { revision += 1; listeners.forEach(callback => callback()); };
const useReviewData = () => useSyncExternalStore(subscribe, () => revision);
export function showStatus(message: string) {
  window.dispatchEvent(new CustomEvent("review:status", { detail: message }));
}
export function navigateReview(panel: string) {
  window.dispatchEvent(new CustomEvent("review:navigate", { detail: panel }));
}
const noop = () => {};
const project = { id: REVIEW_PROJECT_ID, name: "Product workshop", runtimeSize: "standard" };
export const useProject = () => ({ activeProjectId: REVIEW_PROJECT_ID, activeProject: project, projectCapabilitiesResolved: true, canWriteProject: !isFilesReviewReadOnly() });
export const useProjects = () => ({ activeProjectId: REVIEW_PROJECT_ID, activeProject: project, projects: [project] });
export const useActiveWorkspaceVersioning = () => ({ mode: "legacy", originId: null, historyReady: false });
const availability = { issue: null, reportFailure: noop, recoveryVersion: 0 };
export const useWorkspaceAvailability = () => availability;
export const useStatus = () => ({ showStatus });
export const useAuth = () => ({ user: { id: "review-user" }, session: null });
const conversations: unknown[] = [];
export const useConversations = () => ({ conversations });
const submit = async () => { showStatus("Review only: the skill setup message was not sent to an AI."); return { ok: true }; };
export const useConversation = () => ({ activeConversationId: "review-chat", assistantEnabled: true, onSubmit: submit, isAssistantTyping: false });
const tabs = {
  openPanelTab: (panel: string) => { if (panel === "code") navigateReview("files"); else showStatus(`Review only: ${panel} is outside these three surfaces.`); },
  openConversationTab: () => showStatus("Review only: chat navigation is outside these three surfaces."),
  requestUrlPush: noop,
  openFileTab: noop,
};
export const useWorkspaceTabs = () => tabs;

const baseMachine = { badge: null, isSessionOverride: false, tunnel: null, needsActivation: false, isLikelyLocal: false, provider: "self-hosted", runtimeImage: "instafy/runtime:review" };
const resources = { cpuPct: 24, cpuLimitCores: 4, memoryUsedBytes: 2147483648, memoryLimitBytes: 8589934592, diskUsedBytes: 10737418240, diskLimitBytes: 42949672960, updatedAt: "2026-10-17T08:00:00.000Z" };
let machines = [
  { ...baseMachine, id: "review-local", label: "Workshop Mac", detail: "Local tools and workspace files for everyday development.", state: "online", isLikelyLocal: true, resources },
  { ...baseMachine, id: "review-stopped", label: "Build machine", detail: "A separate machine for builds and longer tasks.", state: "offline" },
  { ...baseMachine, id: "review-hosted", label: "Cloud workspace", detail: "Shared hosted machine for this space.", state: "online", provider: "instafy-cloud", resources },
];
let preferredRuntimeId: string | null = "review-local";
const updateMachine = async (id: string, state: string) => {
  machines = machines.map(machine => machine.id === id ? { ...machine, state } : machine);
  changed(); showStatus(`Review only: machine is now ${state}.`); return true;
};
const runtimeOps = {
  setPreferredRuntime: async (id: string | null) => { preferredRuntimeId = id; changed(); showStatus("Review only: shared machine selection updated."); },
  ensureHostedRuntime: async () => true,
  hostedRuntimeEnsuring: false, hostedRuntimeTakeoverInProgress: false,
  takeOverHostedRuntimeLimit: async () => false,
  copyTunnelDetails: () => showStatus("Review only: no tunnel credentials were copied."),
  terminateRuntime: (id: string) => updateMachine(id, "offline"),
  startRuntime: (id: string) => updateMachine(id, "online"),
  removeRuntime: async (id: string) => { machines = machines.filter(machine => machine.id !== id); changed(); showStatus("Review only: machine removed from this page until reload."); return true; },
  showDesktopRuntimeHelp: () => showStatus("Review only: desktop machine setup is not connected."),
  runtimeEnsureError: null, runtimeEnsureLimit: null, refreshRuntimeStatuses: noop,
};
export function useRuntime() { useReviewData(); return { ...runtimeOps, preferredRuntimeId, effectiveRuntimeId: "review-local", runtimeReady: true, waitingForPreferredRuntime: false, localWorkspace: null, desktopOrigin: null, runs: [], runtime: {} }; }
export function useRuntimeMenuOptions() {
  useReviewData();
  return { runtimeOptions: machines, currentRuntime: machines.find(machine => machine.id === preferredRuntimeId) ?? machines[0], runtime: { ...runtimeOps, preferredRuntimeId } };
}
export const getRuntimeResourceHistory = (id: string) => id === "review-stopped" ? [] : [18, 22, 19, 34, 29, 21, 24].map((cpuPct, index) => ({
  at: 1792224000000 + index * 10000, cpuPct, memPct: 25, memUsedBytes: 2147483648, memLimitBytes: 8589934592,
  diskPct: 25, diskUsedBytes: 10737418240, diskLimitBytes: 42949672960,
}));

const initialAgents = [
  { id: "review-agent-writer", handle: "writer", displayName: "Writer", avatarSeed: "writer", runtimeId: null, bio: "Helps with product notes and documentation." },
  { id: "review-agent-builder", handle: "builder", displayName: "Builder", avatarSeed: "builder", runtimeId: "review-stopped", bio: "Works on builds and tests." },
];
let agents = [...initialAgents];
export type ReviewAgentCount = "single" | "several";
export function setReviewAgentCount(count: ReviewAgentCount) {
  agents = [...initialAgents];
  if (count === "several") {
    agents.push(...["product-research", "interface-review", "documentation", "release-planning", "integration-tests", "accessibility", "performance-review"].map(handle => ({
      id: `review-agent-${handle}`, handle, displayName: handle, avatarSeed: handle,
      runtimeId: "review-local", bio: "Local review agent for inspecting wrapping and alignment.",
    })));
  }
  changed();
}
export const listMyAgents = async () => ({ success: true, agents: [...agents] });
export const updateMyAgent = async (id: string, update: { runtimeId?: string | null }) => {
  agents = agents.map(agent => agent.id === id ? { ...agent, runtimeId: update.runtimeId ?? null } : agent);
  showStatus("Review only: agent assignment updated locally."); return { success: true };
};
export const getPublicAgentProfile = async (_projectId: string, id: string) => ({ success: true, value: agents.find(agent => agent.id === id) });

const skillFiles = new Map([
  [".agents/skills/review/SKILL.md", "# Product review\n\nReview a proposed change, explain trade-offs and check the experience across small and large screens.\n"],
  [".agents/skills/writing/SKILL.md", "# Writing and documentation\n\nTurn product decisions into clear, useful instructions. Keep important context while using simple language and concrete examples that the whole team can follow.\n"],
  [".agents/skills/research/SKILL.disabled.md", "# Research\n\nGather sources and compare options before making a recommendation.\n"],
]);
const skillList = async ({ path }: { path: string }) => {
  if (path === ".agents/skills") return [...new Set([...skillFiles.keys()].map(key => key.split("/").slice(0, 3).join("/")))].map(path => ({ path, name: path.split("/").at(-1), kind: "directory" }));
  return [...skillFiles.keys()].filter(key => key.startsWith(`${path}/`)).map(path => ({ path, name: path.split("/").at(-1), kind: "file" }));
};
const skillApi = {
  list: skillList,
  read: async ({ path }: { path: string }) => ({ path, isText: true, size: skillFiles.get(path)?.length ?? 0, mimeType: "text/markdown", contentText: skillFiles.get(path) ?? null }),
  write: async ({ path, content }: { path: string; content: string }) => { skillFiles.set(path, content); return { ok: true }; },
  delete: async ({ path }: { path: string }) => { [...skillFiles.keys()].filter(key => key === path || key.startsWith(`${path}/`)).forEach(key => skillFiles.delete(key)); return { ok: true }; },
  getRawUrl: async () => null,
};
const mergedFiles = { ...filesApi };
for (const [method, handler] of Object.entries(skillApi)) {
  Object.assign(mergedFiles, { [method]: (input: { path?: string }) => (input.path ?? "").startsWith(".agents/skills")
    ? (handler as (input: unknown) => unknown)(input)
    : (filesApi as Record<string, (input: unknown) => unknown>)[method]?.(input) });
}
export const controllerClient = {
  ...filesControllerExtras,
  core: { enabled: true },
  workspace: { ...(filesControllerExtras as { workspace?: object }).workspace, files: mergedFiles },
  projects: { bootstrapMemory: async () => ({ ok: true, committed: false, reason: "Fixture data is already installed." }) },
};
