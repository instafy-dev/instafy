import { describe, expect, it } from "vitest";
import { buildStudioDestinationSearch } from "../studioNavigation";

describe("Studio destination construction", () => {
  it("opens an exact message and clears its target on ordinary conversation or panel navigation", () => {
    const target = buildStudioDestinationSearch("?projectId=old&messageId=stale", {
      kind: "conversation", projectId: "A", conversationControllerId: "remote", messageId: "saved-message",
    });
    expect(Object.fromEntries(new URLSearchParams(target))).toEqual({ projectId: "A", conversationControllerId: "remote", messageId: "saved-message" });
    expect(new URLSearchParams(buildStudioDestinationSearch(target, { kind: "conversation", projectId: "A", conversationControllerId: "remote" })).has("messageId")).toBe(false);
    expect(new URLSearchParams(buildStudioDestinationSearch(target, { kind: "panel", panel: "home" })).has("messageId")).toBe(false);
    expect(new URLSearchParams(buildStudioDestinationSearch(target, { kind: "drawer", workspaceTab: "history" })).get("messageId")).toBe("saved-message");
  });
  it.each([
    "?projectId=A&panel=settings&settingsTab=org&settingsOrgId=empty-team&settingsCategory=members",
    "?projectId=A&panel=settings&settingsTab=profile&settingsCategory=ai&settingsItem=audio&teamId=personal",
    "?projectId=A&conversationId=thread&jobId=run",
  ])("opening and closing the space picker preserves the underlying destination: %s", (search) => {
    const opened = buildStudioDestinationSearch(search, { kind: "drawer", workspaceTab: "workspaces" });
    expect(new URLSearchParams(opened).get("workspaceTab")).toBe("workspaces");
    expect(buildStudioDestinationSearch(opened, { kind: "drawer", workspaceTab: null })).toBe(search);
  });
  it("retains selected-team context on global pages and clears it for space work", () => {
    const team = "22222222-2222-4222-8222-222222222222";
    const settings = `?projectId=A&panel=settings&settingsTab=org&settingsOrgId=${team}&settingsCategory=members&settingsItem=old`;
    const home = buildStudioDestinationSearch(settings, { kind: "panel", panel: "home", teamId: team });
    expect(Object.fromEntries(new URLSearchParams(home))).toEqual({ projectId: "A", panel: "home", teamId: team });
    const profile = buildStudioDestinationSearch(home, { kind: "panel", panel: "settings", settingsTab: "profile" });
    expect(new URLSearchParams(profile).get("teamId")).toBe(team);
    expect(Object.fromEntries(new URLSearchParams(buildStudioDestinationSearch(profile, { kind: "conversation", projectId: "A" })))).toEqual({ projectId: "A" });
  });

  it("opens an explicit empty-team profile without stale account settings or drawer state", () => {
    const next = buildStudioDestinationSearch("?projectId=A&panel=settings&settingsTab=profile&teamId=personal&settingsItem=audio&workspaceTab=workspaces", {
      kind: "panel", panel: "settings", settingsTab: "org", settingsOrgId: "empty-team", settingsCategory: "profile",
    });
    expect(Object.fromEntries(new URLSearchParams(next))).toEqual({ projectId: "A", panel: "settings", settingsTab: "org", settingsOrgId: "empty-team", settingsCategory: "profile" });
  });

  it("restores only the remembered Studio route, including its exact team or job scope", () => {
    const saved = "?projectId=A&conversationId=thread&jobId=run";
    expect(buildStudioDestinationSearch("?projectId=B&panel=home&teamId=other", { kind: "route", search: saved })).toBe(saved);
    const teamPicker = "?projectId=A&panel=settings&settingsTab=org&settingsOrgId=empty-team&settingsCategory=members&workspaceTab=workspaces";
    expect(buildStudioDestinationSearch("?projectId=B", { kind: "route", search: teamPicker })).toBe(teamPicker);
  });
  it("opens an exact conversation without retaining a previous job, drawer or settings section", () => {
    const next = new URLSearchParams(buildStudioDestinationSearch(
      "?projectId=A&conversationId=old&conversationControllerId=old-controller&panel=settings&settingsTab=project&settingsCategory=ai&settingsItem=audio&workspaceTab=files&jobId=old-job&reviewTab=old-review&view=start",
      { kind: "conversation", projectId: "A", conversationId: "local", conversationControllerId: "controller" },
    ));
    expect(Object.fromEntries(next)).toEqual({ projectId: "A", conversationId: "local", conversationControllerId: "controller" });
  });

  it("does not relabel an old chat or browser locator when changing spaces", () => {
    const next = new URLSearchParams(buildStudioDestinationSearch(
      "?projectId=A&conversationId=old-local&browserRuntimeId=old-runtime", { kind: "conversation", projectId: "B", conversationControllerId: "remote-chat" },
    ));
    expect(Object.fromEntries(next)).toEqual({ projectId: "B", conversationControllerId: "remote-chat" });
  });

  it("opens a space-only destination without inheriting the previous chat or panel", () => {
    const next = new URLSearchParams(buildStudioDestinationSearch(
      "?projectId=A&conversationId=old-local&conversationControllerId=old-controller&jobId=old-job&browserRuntimeId=old-runtime&panel=settings&settingsTab=project&settingsCategory=ai&settingsItem=audio&workspaceTab=files&reviewTab=old-review&view=start",
      { kind: "conversation", projectId: "B" },
    ));
    expect(Object.fromEntries(next)).toEqual({ projectId: "B" });
  });

  it("retains the exact chat context while opening an explicit settings destination", () => {
    const next = new URLSearchParams(buildStudioDestinationSearch(
      "?projectId=A&conversationId=local&conversationControllerId=remote&settingsTab=project&settingsCategory=danger&settingsItem=old",
      { kind: "panel", panel: "settings", settingsTab: "profile", settingsCategory: "preferences" },
    ));
    expect(Object.fromEntries(next)).toEqual({ projectId: "A", conversationId: "local", conversationControllerId: "remote", panel: "settings", settingsTab: "profile", settingsCategory: "preferences" });
  });

  it("Home is an explicit destination and a job is a separate visit in its containing chat", () => {
    expect(new URLSearchParams(buildStudioDestinationSearch("?projectId=A&jobId=old", { kind: "panel", panel: "home" })).get("panel")).toBe("home");
    expect(new URLSearchParams(buildStudioDestinationSearch("?projectId=A", { kind: "conversation", projectId: "A", conversationId: "local", jobId: "job" })).get("jobId")).toBe("job");
  });

  it("opens the URL-owned workspace drawer without retaining a different drawer or job", () => {
    const search = buildStudioDestinationSearch(
      "?projectId=A&conversationId=local&conversationControllerId=remote&workspaceTab=history&jobId=old",
      { kind: "panel", panel: "chat", workspaceTab: "workspaces" },
    );
    expect(Object.fromEntries(new URLSearchParams(search))).toEqual({
      projectId: "A", conversationId: "local", conversationControllerId: "remote", workspaceTab: "workspaces",
    });
    expect(new URLSearchParams(buildStudioDestinationSearch(search, { kind: "panel", panel: "chat" })).has("workspaceTab")).toBe(false);
  });
});
