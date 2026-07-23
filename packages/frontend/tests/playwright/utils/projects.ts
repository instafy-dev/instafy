import type { Page } from "@playwright/test";

declare global {
  interface Window {
    __INSTAFY_STORE__?: {
      getState?: () => {
        switchProject?: (projectId: string) => void;
      } & Record<string, unknown>;
    };
  }
}

export async function waitForMonacoModel(page: Page, filePath: string) {
  const escaped = filePath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const selector = `[data-studio-editor="true"][data-studio-editor-path="${escaped}"]`;
  await page.waitForSelector(selector, { state: "attached" });
}

export async function switchToProject(page: Page, projectId: string): Promise<boolean> {
  if (!projectId) {
    return false;
  }
  try {
    const switched = await page.evaluate((id) => {
      const store = window.__INSTAFY_STORE__;
      const state = store?.getState?.();
      const switchProject = state?.switchProject;
      if (typeof switchProject !== "function") {
        return false;
      }
      switchProject(id);
      return true;
    }, projectId);
    return Boolean(switched);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[switchToProject] Unable to switch project: ${message}`);
    return false;
  }
}
