import type { Page } from "@playwright/test";

export type GenerationOutcome =
  | {
      status: "succeeded";
      snippet: string;
      lastPrompt: string;
      provider: string | null;
      projectId: string | null;
      summary: string | null;
      error?: string | null;
    }
  | {
      status: "failed";
      snippet?: string;
      lastPrompt: string;
      provider?: string | null;
      projectId: string | null;
      summary?: string | null;
      error: string | null;
    };

export async function waitForGeneration(page: Page, opts?: { timeout?: number }): Promise<GenerationOutcome> {
  const handle = await page.waitForFunction(
    () => {
      const store = (window as typeof window & { __INSTAFY_STORE__?: any }).__INSTAFY_STORE__;
      const state = store?.getState?.();
      if (!state) {
        return null;
      }
      const code = state.state?.code;
      const appFile = code?.files?.find((file: { path?: string }) => file?.path === "src/App.tsx");
      if (code?.status === "succeeded" && code.lastGeneratedAt) {
        return {
          status: "succeeded",
          snippet: appFile?.generated ?? appFile?.modified ?? code.summary ?? "",
          lastPrompt: code.lastPrompt,
          provider: code.provider,
          projectId: state.activeProjectId,
          summary: code.summary ?? null,
          error: code.error ?? null
        } satisfies GenerationOutcome;
      }
      if (code?.status === "failed") {
        return {
          status: "failed",
          snippet: appFile?.generated ?? appFile?.modified ?? code.summary ?? "",
          lastPrompt: code.lastPrompt,
          provider: code.provider,
          projectId: state.activeProjectId,
          summary: code.summary ?? null,
          error: code.error ?? null
        } satisfies GenerationOutcome;
      }
      return null;
    },
    { timeout: opts?.timeout ?? 60000 }
  );

  return handle.jsonValue() as Promise<GenerationOutcome>;
}
