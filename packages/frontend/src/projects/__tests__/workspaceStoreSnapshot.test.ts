// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { useWorkspaceStore } from "../../store";

describe("workspace store snapshots", () => {
  const initialState = useWorkspaceStore.getState();

  afterEach(() => {
    useWorkspaceStore.setState(initialState, true);
    window.localStorage.clear();
  });

  it("opens a snapshot an earlier build saved with the site-builder fields", () => {
    const projectId = "33333333-3333-4333-8333-333333333333";
    const saved = {
      metadata: { ...initialState.state.metadata, projectName: "Earlier space" },
      // Saved by earlier builds, like the fields below. Nothing reads them now.
      code: { ...initialState.state.code, provider: null },
      org: { id: "org-1", name: "Earlier team" },
      content: { headline: "Hello" },
      deployment: { subdomain: "", hostingPlan: "instafy" },
      versionControl: { enabled: false, provider: "github", mode: "managed", status: "idle", lastSyncedAt: null, automationEnabled: true },
      collaboration: { enabled: false, inviteToken: null, allowGuestEditors: false, pendingInvites: [] },
    };
    window.localStorage.setItem(
      "instafy.workspace.user:earlier-build",
      JSON.stringify({ projects: { [projectId]: saved }, activeProjectId: projectId }),
    );

    expect(() => useWorkspaceStore.getState().setWorkspaceScope("earlier-build")).not.toThrow();
    const store = useWorkspaceStore.getState();
    expect(store.activeProjectId).toBe(projectId);
    expect(store.state.metadata.projectName).toBe("Earlier space");
    expect(store.state.org).toEqual({ id: "org-1", name: "Earlier team" });

    store.updateCode((code) => ({ ...code, summary: "Edited after the upgrade" }));
    const updated = useWorkspaceStore.getState();
    expect(updated.state.code.summary).toBe("Edited after the upgrade");
    expect(updated.projects[projectId].code.summary).toBe("Edited after the upgrade");
  });
});
