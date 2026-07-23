import { describe, expect, it } from "vitest";
import {
  buildProjectSettingsCategorySearch,
  resolveProjectSettingsCategory,
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
