import { describe, expect, it } from "vitest";
import {
  buildProjectSettingsCategorySearch,
  resolveProjectSettingsCategory,
  buildOrganizationSettingsCategorySearch,
  resolveOrganizationSettingsCategory,
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
  });

  it("returns to profile without carrying a previous team's category or ID", () => {
    const search = buildOrganizationSettingsCategorySearch("?settingsCategory=danger&settingsOrgId=old-team", "profile", null);
    const params = new URLSearchParams(search);
    expect(params.has("settingsCategory")).toBe(false);
    expect(params.has("settingsOrgId")).toBe(false);
    expect(params.get("settingsTab")).toBe("org");
  });

  it("accepts team categories on reload and rejects unrelated space categories", () => {
    expect(resolveOrganizationSettingsCategory("?settingsCategory=billing")).toBe("billing");
    expect(resolveOrganizationSettingsCategory("?settingsCategory=profile")).toBe("profile");
    expect(resolveOrganizationSettingsCategory("?settingsCategory=providers")).toBeNull();
  });
});
