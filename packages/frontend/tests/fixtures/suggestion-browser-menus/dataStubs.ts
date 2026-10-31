import { RUN_STOP_FIXTURE_STUBS } from "../run-stop-control/dataStubs";

/** All reviewed editors, menus, rows and controls are production components.
 * Only service/account/native boundaries are inert. No capture or transport is started. */
export const SUGGESTION_BROWSER_MENU_STUBS: Record<string, string> = {
  ...RUN_STOP_FIXTURE_STUBS,
  "/src/screens/studio/components/SharedLocalTabViewer.tsx": "export const SharedLocalTabViewer = () => null;",
  "/src/screens/studio/components/useBrowserHumanInput.ts": "export const LET_OCTO_CONTINUE = 'Let Octo continue'; export const BROWSER_HUMAN_INPUT_CONTINUE_PROMPT = ''; export const isLetOctoContinuePrompt = () => false; export const useBrowserHumanInput = () => { throw new Error('This fixture reviews browser menus only'); };",
  "/src/runtime/runtimeMenuShared.ts": "export const writeClipboardText = async () => {};",
  "/src/services/runtimeController/browserProfiles.ts": `
    export const clearSharedBrowserData = async () => ({ success: true });
    export const fetchSharedBrowserProfileStatus = async () => ({ success: true, status: { enabled: false, lastSavedAt: null, savedByRuntimeId: null } });
  `,
  "/src/services/runtimeController/browserShares.ts": `
    const people = [
      { userId: "review-alice", fullName: "Alice Morgan", email: "alice@example.test" },
      { userId: "review-bob", fullName: "Bob Chen", email: "bob@example.test" },
      { userId: "review-charlie", fullName: "Charlie with a longer display name", email: "charlie@example.test" },
    ];
    let audience = [];
    const removed = new Set();
    export async function browserShareClient() {
      return {
        list: async () => [],
        people: async (query = "") => ({ people: people.filter(person => (person.fullName + person.email).toLowerCase().includes(query.toLowerCase())), hasMore: false }),
        viewers: async () => audience.map(person => ({ ...person, active: true, removed: removed.has(person.userId) })),
        removeViewer: async (_shareId, userId) => { removed.add(userId); },
        stop: async () => {},
        connect: async () => { throw new Error("No tab-sharing transport in this fixture"); },
      };
    }
    export async function publishLocalBrowserTab(projectId, _ownerId, signal, ended, selection) {
      audience = selection.audience === "space" ? people : people.filter(person => selection.viewerUserIds.includes(person.userId));
      signal.addEventListener("abort", () => ended(), { once: true });
      return { id: "review-share", projectId, ownerUserId: "review-owner", audience: selection.audience, mode: "view" };
    }
  `,
};
