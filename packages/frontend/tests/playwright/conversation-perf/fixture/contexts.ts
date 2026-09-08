// The benchmark mounts the production transcript and history query. Runtime,
// workspace mutations and surrounding providers are explicitly out of scope.
const noop = () => undefined;
export const useWorkspaceTabs = () => ({ openConversationTab: noop, openPanelTab: noop, openJobThreadTab: noop, requestUrlPush: noop, openGitDiffTab: noop });
export const useStatus = () => ({ showStatus: noop });
export const useRuntime = () => ({ runs: [], effectiveRuntimeId: null, runtimeReady: false });
export const useRuntimeMenuOptions = () => ({ runtimes: [] });
export const useProject = () => ({ activeProjectId: "fixture-project" });
export const useConversations = () => ({ conversations: [], activeConversation: null });
export const useConversation = () => ({ activeConversationId: null, agentHandles: [] });
