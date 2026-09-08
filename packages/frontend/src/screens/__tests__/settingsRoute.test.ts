import { describe, expect, it } from "vitest";
import {
  buildProjectSettingsCategorySearch,
  buildSettingsSectionSearch,
  resolveProjectSettingsCategory,
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

describe("settings sections in all scopes", () => {
  it.each([
    ["org", "members", "billing"],
    ["project", "overview", "providers"],
    ["profile", "account", "preferences"],
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
      .toEqual({ tab: "org", category: "members", itemId: null });
    expect(resolveSettingsRoute("?panel=credits&settingsTab=project&settingsCategory=ai&settingsItem=speech", "profile"))
      .toEqual({ tab: "profile", category: "account", itemId: null });
    expect(() => buildSettingsSectionSearch("", "profile", "providers")).toThrow("Unknown settings category");
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
