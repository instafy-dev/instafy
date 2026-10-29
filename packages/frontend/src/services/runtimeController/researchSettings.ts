import { controllerJsonRequest } from "./client";

export interface ResearchSettings {
  maxPageLoads: number;
  maxPageLoadsPerSite: number;
  canManage: boolean;
  limits: Record<"maxPageLoads" | "maxPageLoadsPerSite", { min: number; max: number; default: number }>;
}

export async function loadResearchSettings(projectId: string): Promise<ResearchSettings> {
  const result = await controllerJsonRequest<ResearchSettings>({
    path: `/projects/${encodeURIComponent(projectId)}/research-settings`,
    fallbackError: "Unable to load research settings.",
  });
  if (!result.success) throw new Error(result.error);
  return result.value;
}

export async function saveResearchSettings(projectId: string, settings: Pick<ResearchSettings, "maxPageLoads" | "maxPageLoadsPerSite">): Promise<ResearchSettings> {
  const result = await controllerJsonRequest<ResearchSettings>({
    path: `/projects/${encodeURIComponent(projectId)}/research-settings`,
    method: "PATCH", body: settings, fallbackError: "Unable to save research settings.",
  });
  if (!result.success) throw new Error(result.error);
  return result.value;
}
