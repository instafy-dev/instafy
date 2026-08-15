import type { SettingsTab, StudioPanel } from "../types";
import {
  resolveProjectSettingsCategory,
  type ProjectSettingsCategory,
} from "../settingsRoute";

const STUDIO_PANELS = new Set<StudioPanel>([
  "home",
  "chat",
  "code",
  "extensions",
  "skills",
  "secrets",
  "ai",
  "automations",
  "credits",
  "sourceControl",
  "projects",
  "settings",
]);
const SETTINGS_TABS = new Set<SettingsTab>(["org", "project", "profile"]);

function resolveStudioPanel(value: string | null): StudioPanel | null {
  return value && STUDIO_PANELS.has(value as StudioPanel) ? (value as StudioPanel) : null;
}

function resolveSettingsTab(value: string | null): SettingsTab | null {
  return value && SETTINGS_TABS.has(value as SettingsTab) ? (value as SettingsTab) : null;
}

function appendSettingsRoute(
  source: URLSearchParams,
  destination: URLSearchParams,
  panel: StudioPanel | null,
): void {
  if (panel !== "settings") {
    return;
  }
  const settingsTab = resolveSettingsTab(source.get("settingsTab"));
  if (!settingsTab) {
    return;
  }
  destination.set("settingsTab", settingsTab);
  if (settingsTab !== "project") {
    return;
  }
  const settingsCategory: ProjectSettingsCategory | null =
    resolveProjectSettingsCategory(source.toString());
  if (settingsCategory) {
    destination.set("settingsCategory", settingsCategory);
  }
}

export function buildDesktopStudioDeepLink(
  projectId: string | null,
  currentUrl = typeof window !== "undefined" ? window.location.href : null,
): string {
  const params = new URLSearchParams();
  const normalizedProjectId = projectId?.trim();
  if (normalizedProjectId) {
    params.set("projectId", normalizedProjectId);
  }

  if (currentUrl) {
    try {
      const current = new URL(currentUrl);
      const panel = resolveStudioPanel(current.searchParams.get("panel"));
      if (panel) {
        params.set("panel", panel);
      }
      appendSettingsRoute(current.searchParams, params, panel);
    } catch {
      // Fall back to the explicit project route only.
    }
  }

  const query = params.toString();
  return `instafy://studio${query ? `?${query}` : ""}`;
}
