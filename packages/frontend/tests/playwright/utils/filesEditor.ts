import { expect, type Page, type Request, type Response } from "@playwright/test";

/** The explorer row test id for a workspace path. */
export function filesEntryTestId(path: string): string {
  return `files-entry-${path.replace(/[^a-zA-Z0-9]/g, "-")}`;
}

export async function waitForFilesConnected(page: Page, timeoutMs = 180_000): Promise<void> {
  await expect(page.getByText(/Opening files…|Still opening files…|Reconnecting to your files…/)).toHaveCount(0, {
    timeout: timeoutMs,
  });
}

/** Open Files, reload the explorer, and open a root-level text file in the editor. */
export async function openFileInFiles(page: Page, projectId: string, path: string): Promise<void> {
  await page.getByTestId("sidebar-nav-code").click();
  await waitForFilesConnected(page);
  await page.evaluate((pid) => {
    window.dispatchEvent(new CustomEvent("instafy:workspace-commit", { detail: { projectId: pid } }));
  }, projectId);
  const entry = page.getByTestId(filesEntryTestId(path));
  await expect(entry).toBeVisible({ timeout: 60_000 });
  await entry.click();
  await expect(page.getByTestId("monaco-editor")).toBeVisible({ timeout: 60_000 });
}

/** Replace the editor's whole text by typing. */
export async function replaceEditorText(page: Page, text: string): Promise<void> {
  const textarea = page.getByTestId("monaco-editor").locator("textarea.inputarea");
  await textarea.click({ force: true });
  await expect(textarea).toBeFocused({ timeout: 10_000 });
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(text, { delay: 5 });
}

/** Cmd/Ctrl+S from the focused editor. */
export async function pressSaveShortcut(page: Page): Promise<void> {
  await page.keyboard.press("ControlOrMeta+S");
}

function originPath(request: Request): string {
  try {
    return new URL(request.url()).pathname;
  } catch {
    return "";
  }
}

export function isOriginApply(request: Request): boolean {
  return request.method() === "POST" && /\/apply$/.test(originPath(request));
}

export function isOriginGitSync(request: Request): boolean {
  return request.method() === "POST" && /\/git\/sync$/.test(originPath(request));
}

export function isOriginEntries(request: Request): boolean {
  return request.method() === "GET" && /\/entries$/.test(originPath(request));
}

/** Record origin requests by kind from now on. */
export function recordOriginRequests(page: Page) {
  const applies: Request[] = [];
  const syncs: Request[] = [];
  const entries: string[] = [];
  page.on("request", (request) => {
    if (isOriginApply(request)) applies.push(request);
    if (isOriginGitSync(request)) syncs.push(request);
    if (isOriginEntries(request)) entries.push(request.url());
  });
  return { applies, syncs, entries };
}

/** The apply manifest's JSON text, from the multipart body. */
export function applyManifestText(request: Request): string {
  return request.postDataBuffer()?.toString("latin1") ?? "";
}

export function waitForApply(page: Page): Promise<Response> {
  return page.waitForResponse((response) => isOriginApply(response.request()), { timeout: 60_000 });
}
