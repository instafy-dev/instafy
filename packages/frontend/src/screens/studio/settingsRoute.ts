export type ProjectSettingsCategory = "overview" | "access" | "providers" | "ai" | "danger";
export type OrganizationSettingsCategory = "profile" | "members" | "ai" | "billing" | "danger";

export function resolveOrganizationSettingsCategory(search: string): OrganizationSettingsCategory | null {
  const category = new URLSearchParams(search).get("settingsCategory");
  return category === "profile" || category === "members" || category === "ai" || category === "billing" || category === "danger"
    ? category : null;
}

export function buildOrganizationSettingsCategorySearch(
  search: string,
  category: OrganizationSettingsCategory,
  organizationId: string | null,
): string {
  const params = new URLSearchParams(search);
  params.set("panel", "settings");
  params.set("settingsTab", "org");
  if (organizationId) params.set("settingsOrgId", organizationId);
  else params.delete("settingsOrgId");
  if (category === "profile") params.delete("settingsCategory");
  else params.set("settingsCategory", category);
  return params.toString();
}

export function resolveProjectSettingsCategory(search: string): ProjectSettingsCategory | null {
  try {
    const category = new URLSearchParams(search).get("settingsCategory");
    return category === "overview" ||
      category === "access" ||
      category === "providers" ||
      category === "ai" ||
      category === "danger"
      ? category
      : null;
  } catch {
    return null;
  }
}

export function buildProjectSettingsCategorySearch(
  search: string,
  category: ProjectSettingsCategory,
): string {
  const params = new URLSearchParams(search);

  // Settings can render before the workspace route-sync effect commits these params.
  // Keep category presses from replacing that pending route with a chat route.
  params.set("panel", "settings");
  params.set("settingsTab", "project");

  if (category === "overview") {
    params.delete("settingsCategory");
  } else {
    params.set("settingsCategory", category);
  }

  return params.toString();
}
