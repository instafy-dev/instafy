import { describe, expect, it } from "vitest";
import {
  doesWorkspaceTabMatchPanelRoute,
  resolveLeftDrawerFromSearch,
  resolvePendingUrlSearchSync,
  resolveProjectScopedWorkspaceRouteValues,
  resolveWorkspaceUrlSyncBaseSearch,
  workspaceRouteScopeReady,
} from "../useStudioLayoutWorkspaceRouting";

describe("pending route scope", () => {
  const projectA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const projectB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  it("does not hydrate pending IDs while access or the destination space's conversations are loading", () => {
    expect(workspaceRouteScopeReady({ search: `?projectId=${projectB}`, projectReady: false, activeProjectId: projectA, conversationsProjectKey: projectA })).toBe(false);
    expect(workspaceRouteScopeReady({ search: `?projectId=${projectB}`, projectReady: true, activeProjectId: projectA, conversationsProjectKey: projectA })).toBe(false);
    expect(workspaceRouteScopeReady({ search: `?projectId=${projectB}`, projectReady: true, activeProjectId: projectB, conversationsProjectKey: projectA })).toBe(false);
    expect(workspaceRouteScopeReady({ search: `?projectId=%20${projectB}%20`, projectReady: true, activeProjectId: projectB, conversationsProjectKey: projectB })).toBe(true);
  });
});

describe("doesWorkspaceTabMatchPanelRoute", () => {
  it("requires the active tab to render the routed Files workspace", () => {
    expect(
      doesWorkspaceTabMatchPanelRoute({ panel: "code", tabKind: "panel", tabPanel: "code" }),
    ).toBe(true);
    expect(
      doesWorkspaceTabMatchPanelRoute({ panel: "code", tabKind: "file", tabPanel: null }),
    ).toBe(true);
    expect(
      doesWorkspaceTabMatchPanelRoute({
        panel: "code",
        tabKind: "conversation",
        tabPanel: null,
      }),
    ).toBe(false);
  });

  it("accepts conversation-backed Chat tabs but not unrelated panels", () => {
    expect(
      doesWorkspaceTabMatchPanelRoute({
        panel: "chat",
        tabKind: "conversation",
        tabPanel: null,
      }),
    ).toBe(true);
    expect(
      doesWorkspaceTabMatchPanelRoute({ panel: "chat", tabKind: "jobThread", tabPanel: null }),
    ).toBe(true);
    expect(
      doesWorkspaceTabMatchPanelRoute({ panel: "chat", tabKind: "panel", tabPanel: "home" }),
    ).toBe(false);
  });

  it("requires exact panel tabs for the remaining routed panels", () => {
    expect(
      doesWorkspaceTabMatchPanelRoute({
        panel: "settings",
        tabKind: "panel",
        tabPanel: "settings",
      }),
    ).toBe(true);
    expect(
      doesWorkspaceTabMatchPanelRoute({
        panel: "settings",
        tabKind: "panel",
        tabPanel: "projects",
      }),
    ).toBe(false);
  });
});

describe("resolveLeftDrawerFromSearch", () => {
  it("restores only supported drawer values from browser history", () => {
    expect(resolveLeftDrawerFromSearch("?workspaceTab=files")).toBe("files");
    expect(resolveLeftDrawerFromSearch("?workspaceTab=history")).toBe("history");
    expect(resolveLeftDrawerFromSearch("?workspaceTab=sourceControl")).toBe("sourceControl");
    expect(resolveLeftDrawerFromSearch("?workspaceTab=workspaces")).toBe("workspaces");
    expect(resolveLeftDrawerFromSearch("?workspaceTab=unknown")).toBeNull();
    expect(resolveLeftDrawerFromSearch("?panel=code")).toBeNull();
  });
});

describe("resolvePendingUrlSearchSync", () => {
  it("defers hydration while React Router still exposes the source URL after a push", () => {
    expect(
      resolvePendingUrlSearchSync({
        browserSearch: "?workspaceTab=files",
        pendingSearch: "?projectId=project-1",
        routedSearch: "?projectId=project-1",
      }),
    ).toEqual({
      nextPendingSearch: "?projectId=project-1",
      shouldDeferHydration: true,
    });
  });

  it("clears the marker when React Router reaches the pushed URL", () => {
    expect(
      resolvePendingUrlSearchSync({
        browserSearch: "?workspaceTab=files",
        pendingSearch: "?projectId=project-1",
        routedSearch: "?workspaceTab=files",
      }),
    ).toEqual({
      nextPendingSearch: null,
      shouldDeferHydration: false,
    });
  });

  it("hydrates a rapid Back navigation that returns to the pending source URL", () => {
    expect(
      resolvePendingUrlSearchSync({
        browserSearch: "?projectId=project-1",
        pendingSearch: "?projectId=project-1",
        routedSearch: "?projectId=project-1",
      }),
    ).toEqual({
      nextPendingSearch: null,
      shouldDeferHydration: false,
    });
  });

  it("defers stale intermediate route hydration across two rapid pushes", () => {
    expect(
      resolvePendingUrlSearchSync({
        browserSearch: "?panel=settings&settingsTab=project",
        pendingSearch: "?panel=secrets",
        routedSearch: "?panel=settings&settingsTab=org",
      }),
    ).toEqual({
      nextPendingSearch: "?panel=secrets",
      shouldDeferHydration: true,
    });
  });

  it("does not defer when no URL sync is pending", () => {
    expect(
      resolvePendingUrlSearchSync({
        browserSearch: "",
        pendingSearch: null,
        routedSearch: "",
      }),
    ).toEqual({
      nextPendingSearch: null,
      shouldDeferHydration: false,
    });
  });
});

describe("resolveWorkspaceUrlSyncBaseSearch", () => {
  it.each([null, "replace"] as const)("does not overwrite a newer explicit destination with a settled old route (%s)", (pendingNavigationMode) => {
    expect(resolveWorkspaceUrlSyncBaseSearch({
      browserSearch: "?projectId=project-1",
      lastHydratedSearch: "?projectId=project-1&panel=home",
      routedSearch: "?projectId=project-1&panel=home",
      pendingNavigationMode,
    })).toBeNull();
  });
  it("chains a rapid second push from the URL already committed by the browser", () => {
    expect(
      resolveWorkspaceUrlSyncBaseSearch({
        browserSearch: "?panel=secrets",
        lastHydratedSearch: null,
        pendingNavigationMode: "push",
        routedSearch: "?panel=settings&settingsTab=org",
      }),
    ).toBe("?panel=secrets");
  });

  it("waits for route hydration when no user navigation is pending", () => {
    expect(
      resolveWorkspaceUrlSyncBaseSearch({
        browserSearch: "?panel=secrets",
        lastHydratedSearch: null,
        pendingNavigationMode: null,
        routedSearch: "?panel=settings&settingsTab=org",
      }),
    ).toBeNull();
  });

  it("uses the routed search once it is fully hydrated", () => {
    expect(
      resolveWorkspaceUrlSyncBaseSearch({
        browserSearch: "?panel=secrets",
        lastHydratedSearch: "?panel=secrets",
        pendingNavigationMode: null,
        routedSearch: "?panel=secrets",
      }),
    ).toBe("?panel=secrets");
  });
});

describe("resolveProjectScopedWorkspaceRouteValues", () => {
  const projectScopedValues = {
    conversationId: "conversation-from-project-one",
    conversationControllerId: "controller-conversation-from-project-one",
    jobId: "job-from-project-one",
    reviewTabId: "review-from-project-one",
  };

  it("clears old conversation and workspace identities while the provider changes projects", () => {
    expect(
      resolveProjectScopedWorkspaceRouteValues({
        activeProjectId: "project-two",
        conversationsProjectKey: "project-one",
        ...projectScopedValues,
      }),
    ).toEqual({
      conversationId: null,
      conversationControllerId: null,
      jobId: null,
      reviewTabId: null,
    });
  });

  it("keeps project-scoped identities once the conversation provider is aligned", () => {
    expect(
      resolveProjectScopedWorkspaceRouteValues({
        activeProjectId: "project-one",
        conversationsProjectKey: "project-one",
        ...projectScopedValues,
      }),
    ).toEqual(projectScopedValues);
  });
});
