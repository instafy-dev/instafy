import { describe, expect, it } from "vitest";
import {
  buildProjectSettingsCategorySearch,
  buildSettingsSectionSearch,
  resolveProjectSettingsCategory,
  buildOrganizationSettingsCategorySearch,
  resolveOrganizationSettingsCategory,
  resolveSettingsRoute,
} from "../studio/settingsRoute";

describe("project settings routing", () => {
  it("keeps project settings active when a category is selected from stale search state", () => {
    const search = buildProjectSettingsCategorySearch(
      "?projectId=project-1&conversationId=conversation-1",
      "access",
    );
    const params = new URLSearchParams(search);

    expect(params.get("projectId")).toBe("project-1");
    expect(params.get("conversationId")).toBe("conversation-1");
    expect(params.get("panel")).toBe("settings");
    expect(params.get("settingsTab")).toBe("project");
    expect(params.get("settingsCategory")).toBe("access");
  });

  it("uses the default category without leaving a stale category param", () => {
    const search = buildProjectSettingsCategorySearch(
      "?panel=settings&settingsTab=project&settingsCategory=access",
      "overview",
    );
    const params = new URLSearchParams(search);

    expect(params.get("panel")).toBe("settings");
    expect(params.get("settingsTab")).toBe("project");
    expect(params.has("settingsCategory")).toBe(false);
  });

  it("resolves only supported project settings categories", () => {
    expect(resolveProjectSettingsCategory("?settingsCategory=providers")).toBe("providers");
    expect(resolveProjectSettingsCategory("?settingsCategory=unknown")).toBeNull();
  });
});

describe("team settings routing", () => {
  it("keeps the selected empty team independent of the active project", () => {
    const search = buildOrganizationSettingsCategorySearch("?projectId=other-project&panel=chat", "members", "empty-team");
    const params = new URLSearchParams(search);
    expect(params.get("projectId")).toBe("other-project");
    expect(params.get("panel")).toBe("settings");
    expect(params.get("settingsTab")).toBe("org");
    expect(params.get("settingsOrgId")).toBe("empty-team");
    expect(resolveOrganizationSettingsCategory(search)).toBe("members");
    expect(resolveSettingsRoute(search)).toEqual({ tab: "org", category: "members", itemId: null });
  });

  it("returns to profile without carrying a previous team's category or ID", () => {
    const search = buildOrganizationSettingsCategorySearch("?settingsCategory=danger&settingsOrgId=old-team", "profile", null);
    const params = new URLSearchParams(search);
    expect(params.has("settingsCategory")).toBe(false);
    expect(params.has("settingsOrgId")).toBe(false);
    expect(params.get("settingsTab")).toBe("org");
    expect(resolveSettingsRoute(search)).toEqual({ tab: "org", category: "profile", itemId: null });
  });

  it("opens Team profile from a space audio item without inheriting its category or item", () => {
    const search = buildOrganizationSettingsCategorySearch(
      "?panel=settings&projectId=other-space&settingsTab=project&settingsCategory=ai&settingsItem=speech",
      "profile",
      "empty-team",
    );
    const params = new URLSearchParams(search);
    expect(resolveSettingsRoute(search)).toEqual({ tab: "org", category: "profile", itemId: null });
    expect(params.get("settingsOrgId")).toBe("empty-team");
    expect(params.get("projectId")).toBe("other-space");
    expect(params.has("settingsItem")).toBe(false);
    expect(resolveSettingsRoute(`${search}&settingsCategory=profile`).category).toBe("profile");
  });

  it("retains team scope across sections and clears it when entering space or account settings", () => {
    const team = buildOrganizationSettingsCategorySearch("?projectId=other-space", "profile", "empty-team");
    const members = buildSettingsSectionSearch(team, "org", "members");
    expect(new URLSearchParams(members).get("settingsOrgId")).toBe("empty-team");
    for (const next of [buildSettingsSectionSearch(members, "project", "overview"), buildSettingsSectionSearch(members, "profile", "account")]) {
      expect(new URLSearchParams(next).has("settingsOrgId")).toBe(false);
      expect(new URLSearchParams(next).get("projectId")).toBe("other-space");
    }
  });

  it("accepts team categories on reload and rejects unrelated space categories", () => {
    expect(resolveOrganizationSettingsCategory("?settingsCategory=billing")).toBe("billing");
    expect(resolveOrganizationSettingsCategory("?settingsCategory=profile")).toBe("profile");
    expect(resolveOrganizationSettingsCategory("?settingsCategory=providers")).toBeNull();
  });
});

describe("settings sections in all scopes", () => {
  it.each([
    ["org", "profile", "billing"],
    ["project", "overview", "providers"],
    ["profile", "account", "preferences"],
    ["profile", "account", "notifications"],
  ] as const)("round trips %s categories and defaults", (tab, defaultCategory, category) => {
    const search = buildSettingsSectionSearch("?projectId=space&filter=local", tab, category);
    expect(resolveSettingsRoute(`?${search}`)).toEqual({ tab, category, itemId: null });
    expect(new URLSearchParams(search).get("filter")).toBe("local");
    const defaultSearch = buildSettingsSectionSearch(search, tab, defaultCategory);
    expect(new URLSearchParams(defaultSearch).has("settingsCategory")).toBe(false);
    expect(resolveSettingsRoute(defaultSearch).category).toBe(defaultCategory);
  });

  it("uses the incoming routed tab, not the previous rendered tab", () => {
    expect(resolveSettingsRoute("?panel=settings&settingsTab=profile&settingsCategory=preferences", "project"))
      .toEqual({ tab: "profile", category: "preferences", itemId: null });
    expect(resolveSettingsRoute("?panel=settings&settingsTab=org&settingsCategory=providers"))
      .toEqual({ tab: "org", category: "profile", itemId: null });
    expect(resolveSettingsRoute("?panel=credits&settingsTab=project&settingsCategory=ai&settingsItem=speech", "profile"))
      .toEqual({ tab: "profile", category: "account", itemId: null });
    expect(() => buildSettingsSectionSearch("", "profile", "providers")).toThrow("Unknown settings category");
  });

  it("opens account notification settings without inheriting the selected team's scope", () => {
    const search = buildSettingsSectionSearch("?panel=settings&settingsTab=org&settingsOrgId=team&projectId=space&settingsCategory=members", "profile", "notifications");
    expect(resolveSettingsRoute(search)).toEqual({ tab: "profile", category: "notifications", itemId: null });
    expect(new URLSearchParams(search).has("settingsOrgId")).toBe(false);
    expect(new URLSearchParams(search).get("projectId")).toBe("space");
  });

  it("round trips a bounded capability item only under project audio and clears it on category changes", () => {
    const search = buildSettingsSectionSearch("?projectId=space", "project", "ai", "provider:speech");
    expect(resolveSettingsRoute(search)).toEqual({ tab: "project", category: "ai", itemId: "provider:speech" });
    for (const next of [buildSettingsSectionSearch(search, "project", "overview"), buildSettingsSectionSearch(search, "org", "ai")]) {
      expect(new URLSearchParams(next).has("settingsItem")).toBe(false);
      expect(resolveSettingsRoute(next).itemId).toBeNull();
    }
    expect(resolveSettingsRoute(`?panel=settings&settingsTab=project&settingsCategory=ai&settingsItem=${"a".repeat(257)}`).itemId).toBeNull();
  });
});
