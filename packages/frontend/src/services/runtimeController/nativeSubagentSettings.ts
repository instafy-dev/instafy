import { controllerJsonRequest } from "./client";

export interface NativeSubagentSettings {
  canManage: boolean;
  maxNativeSubagents?: number;
  limits: { maxNativeSubagents?: { min: number; max: number; default: number } };
}

export async function loadNativeSubagentSettings(projectId: string): Promise<NativeSubagentSettings> {
  const result = await controllerJsonRequest<NativeSubagentSettings>({
    path: `/projects/${encodeURIComponent(projectId)}/multi-agent-settings`,
    fallbackError: "Unable to load AI helper settings.",
  });
  if (!result.success) throw new Error(result.error);
  return result.value;
}

export async function saveNativeSubagentSettings(projectId: string, maxNativeSubagents: number): Promise<NativeSubagentSettings> {
  const result = await controllerJsonRequest<NativeSubagentSettings>({
    path: `/projects/${encodeURIComponent(projectId)}/multi-agent-settings`,
    method: "PATCH",
    body: { maxNativeSubagents },
    fallbackError: "Unable to save AI helper settings.",
  });
  if (!result.success) throw new Error(result.error);
  return result.value;
}
