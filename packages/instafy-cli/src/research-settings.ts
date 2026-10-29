import { requestControllerApiJson } from "./api.js";
import { findProjectManifest } from "./project-manifest.js";

type SettingKey = "maxPageLoads" | "maxPageLoadsPerSite";
type Settings = Record<SettingKey, number> & {
  canManage: boolean;
  limits: Record<SettingKey, { min: number; max: number; default: number }>;
};
export type ResearchSettingsOptions = Partial<Record<SettingKey, string>> & {
  project?: string;
  controllerUrl?: string;
  accessToken?: string;
  interactive?: boolean;
  json?: boolean;
};
const fields = [
  { key: "maxPageLoads", label: "Fresh pages per task" },
  { key: "maxPageLoadsPerSite", label: "Fresh pages per site per task" },
] as const;

function integer(raw: string, label: string): number {
  if (!/^[1-9]\d*$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${label} must be a positive whole number.`);
  }
  return Number(raw);
}

export async function researchSettings(options: ResearchSettingsOptions): Promise<void> {
  const patch: Partial<Record<SettingKey, number>> = {};
  for (const field of fields) {
    if (options[field.key] !== undefined) patch[field.key] = integer(options[field.key]!, field.label);
  }
  if (options.interactive) {
    if (options.json || Object.keys(patch).length) throw new Error("Use --interactive without --json or setting flags.");
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CI === "true") {
      throw new Error("--interactive requires a terminal. Use --max-page-loads and --max-page-loads-per-site instead.");
    }
  }
  const project = [options.project, process.env.SPACE_ID, process.env.INSTAFY_SPACE_ID, process.env.PROJECT_ID, process.env.INSTAFY_PROJECT_ID]
    .map(value => value?.trim()).find(Boolean) ?? findProjectManifest(process.cwd()).manifest?.spaceId;
  if (!project) throw new Error("No space configured. Pass --space, set SPACE_ID, or run `instafy space init`.");
  const request = {
    path: `/projects/${encodeURIComponent(project)}/research-settings`,
    controllerUrl: options.controllerUrl,
    accessToken: options.accessToken,
  };
  let settings = await requestControllerApiJson<Settings>({ ...request, method: "GET" });
  if ((options.interactive || Object.keys(patch).length) && !settings.canManage) {
    throw new Error("Only space managers can change research settings.");
  }
  for (const field of fields) {
    if (!settings.limits?.[field.key] || !Number.isInteger(settings[field.key])) {
      throw new Error("This controller does not support research settings. Update it before changing the budget.");
    }
  }
  if (options.interactive) {
    const { isCancel, text } = await import("@clack/prompts");
    console.log("The parent and its helpers share one budget. Changes apply to new tasks; running tasks retain their allowance.");
    for (const field of fields) {
      const bounds = settings.limits[field.key];
      const entered = await text({
        message: `${field.label} (${bounds.min}–${bounds.max}; default ${bounds.default})`,
        defaultValue: String(settings[field.key]),
        placeholder: String(settings[field.key]),
        validate(raw) {
          try {
            const value = integer(raw || String(settings[field.key]), field.label);
            if (value < bounds.min || value > bounds.max) return `Enter a whole number from ${bounds.min} to ${bounds.max}.`;
            if (field.key === "maxPageLoadsPerSite" && value > (patch.maxPageLoads ?? settings.maxPageLoads)) return "The per-site limit cannot exceed the task limit.";
          } catch (error) { return (error as Error).message; }
        },
      });
      if (isCancel(entered)) throw new Error("Cancelled. No settings were changed.");
      const value = integer(String(entered), field.label);
      if (value !== settings[field.key]) patch[field.key] = value;
    }
  }
  for (const field of fields) {
    const value = patch[field.key];
    const bounds = settings.limits[field.key];
    if (value !== undefined && (value < bounds.min || value > bounds.max)) throw new Error(`${field.label} must be between ${bounds.min} and ${bounds.max}.`);
  }
  if ((patch.maxPageLoadsPerSite ?? settings.maxPageLoadsPerSite) > (patch.maxPageLoads ?? settings.maxPageLoads)) {
    throw new Error("The per-site limit cannot exceed the task limit.");
  }
  if (Object.keys(patch).length) settings = await requestControllerApiJson<Settings>({ ...request, method: "PATCH", jsonBody: patch });
  if (options.json) { console.log(JSON.stringify(settings, null, 2)); return; }
  console.log(`Research budget for space ${project}`);
  for (const field of fields) console.log(`${field.label}: ${settings[field.key]}`);
  console.log("Shared by the parent and all helpers, including continued worker jobs. Cached reads are free. Changes apply to new tasks.");
  if (!settings.canManage) console.log("Read-only: only space managers can change this budget.");
}
