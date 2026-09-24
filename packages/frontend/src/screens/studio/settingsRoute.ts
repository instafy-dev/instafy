import { useCallback, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { SettingsTab } from "./types";

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
  const params = new URLSearchParams(buildSettingsSectionSearch(search, "org", category));
  const selectedId = organizationId?.trim();
  if (selectedId) params.set("settingsOrgId", selectedId);
  else params.delete("settingsOrgId");
  return params.toString();
}

const categoriesByTab = {
  org: ["profile", "members", "ai", "billing", "danger"],
  project: ["overview", "access", "providers", "ai", "danger"],
  profile: ["account", "appearance", "notifications", "preferences", "advanced"],
} as const;

export function isSettingsCategory(tab: SettingsTab, category: string): boolean {
  return (categoriesByTab[tab] as readonly string[]).includes(category);
}

export function resolveSettingsRoute(search: string, fallbackTab: SettingsTab = "org") {
  const params = new URLSearchParams(search);
  const requestedTab = params.get("settingsTab");
  const tab: SettingsTab = params.get("panel") === "settings" &&
    (requestedTab === "org" || requestedTab === "project" || requestedTab === "profile")
    ? requestedTab
    : fallbackTab;
  const requestedCategory = params.get("panel") === "settings" ? params.get("settingsCategory") ?? "" : "";
  const category = isSettingsCategory(tab, requestedCategory)
    ? requestedCategory
    : categoriesByTab[tab][0];
  const requestedItem = params.get("panel") === "settings" ? params.get("settingsItem") : null;
  return {
    tab,
    category,
    // Runtime/provider capability changes may remove an item. The rendering
    // caller additionally validates this ID against the available item list.
    itemId: tab === "project" && category === "ai" && requestedItem && requestedItem.length <= 256
      ? requestedItem
      : null,
  };
}

export function buildSettingsSectionSearch(
  search: string,
  tab: SettingsTab,
  category: string,
  itemId?: string | null,
): string {
  if (!isSettingsCategory(tab, category)) throw new Error("Unknown settings category");
  const params = new URLSearchParams(search);
  params.set("panel", "settings");
  params.set("settingsTab", tab);
  if (tab !== "org") params.delete("settingsOrgId");
  if (category === categoriesByTab[tab][0]) params.delete("settingsCategory");
  else params.set("settingsCategory", category);
  params.delete("settingsItem");
  if (tab === "project" && category === "ai" && itemId && itemId.length <= 256) {
    params.set("settingsItem", itemId);
  }
  return params.toString();
}

/** Section selection has one navigation authority; form/filter changes never call it. */
export function useSettingsRoute(fallbackTab: SettingsTab) {
  const location = useLocation();
  const navigate = useNavigate();
  const route = resolveSettingsRoute(location.search, fallbackTab);
  // Consecutive presses can share one React render. Chain those selections
  // without treating them as a second writer of the rendered category.
  const pending = useRef<{ sourceKey: string; search: string } | null>(null);
  if (pending.current?.sourceKey !== location.key) pending.current = null;
  const selectSection = useCallback((category: string, itemId?: string | null) => {
    if (!isSettingsCategory(route.tab, category)) return;
    const source = pending.current?.sourceKey === location.key ? pending.current.search : location.search;
    const current = resolveSettingsRoute(source, fallbackTab);
    if (current.category === category && (itemId === undefined || current.itemId === itemId)) return;
    const search = buildSettingsSectionSearch(source, route.tab, category, itemId);
    pending.current = { sourceKey: location.key, search };
    // A fresh PUSH must not inherit the previous entry's canonical visit key.
    navigate({ pathname: location.pathname, search: `?${search}`, hash: location.hash });
  }, [fallbackTab, location.hash, location.key, location.pathname, location.search, navigate, route.tab]);
  return { ...route, selectSection };
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
  return buildSettingsSectionSearch(search, "project", category);
}
