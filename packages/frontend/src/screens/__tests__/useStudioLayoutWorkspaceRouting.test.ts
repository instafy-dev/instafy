import { describe, expect, it } from "vitest";
import {
  resolveLeftDrawerFromSearch,
  resolvePendingUrlSearchSync,
  resolveProjectScopedWorkspaceRouteValues,
  resolveWorkspaceUrlSyncBaseSearch,
} from "../useStudioLayoutWorkspaceRouting";

describe("resolveLeftDrawerFromSearch", () => {
  it("restores only supported drawer values from browser history", () => {
    expect(resolveLeftDrawerFromSearch("?workspaceTab=files")).toBe("files");
    expect(resolveLeftDrawerFromSearch("?workspaceTab=history")).toBe("history");
    expect(resolveLeftDrawerFromSearch("?workspaceTab=sourceControl")).toBe("sourceControl");
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
