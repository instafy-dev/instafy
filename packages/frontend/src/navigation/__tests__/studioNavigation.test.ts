import { describe, expect, it } from "vitest";
import { buildStudioDestinationSearch } from "../studioNavigation";

describe("Studio destination construction", () => {
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
