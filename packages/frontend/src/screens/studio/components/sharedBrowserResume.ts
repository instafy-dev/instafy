const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHARED_BROWSER_RUNTIME_PARAM = "browserRuntimeId";

export type SharedBrowserResumeTarget = { projectId: string; runtimeId: string };

export function parseSharedBrowserResumeTarget(search: string): SharedBrowserResumeTarget | null {
  const params = new URLSearchParams(search);
  const projectId = params.get("projectId");
  const runtimeId = params.get(SHARED_BROWSER_RUNTIME_PARAM);
  if (params.getAll("projectId").length !== 1 || params.getAll(SHARED_BROWSER_RUNTIME_PARAM).length !== 1 ||
      !projectId || !runtimeId || !UUID.test(projectId) || !UUID.test(runtimeId)) return null;
  return { projectId: projectId.toLowerCase(), runtimeId: runtimeId.toLowerCase() };
}

/** Run before rewriting projectId: a locator must never be relabeled as another space. */
export function clearStaleSharedBrowserResumeTarget(params: URLSearchParams, nextProjectId: string | null): boolean {
  if (!params.has(SHARED_BROWSER_RUNTIME_PARAM)) return false;
  const target = parseSharedBrowserResumeTarget(params.toString());
  if (target && target.projectId === nextProjectId?.toLowerCase()) return false;
  params.delete(SHARED_BROWSER_RUNTIME_PARAM);
  return true;
}

/** Keep an incoming locator aligned with a later, explicitly resolved session. */
export function replaceSharedBrowserResumeRuntime(search: string, projectId: string, runtimeId: string): string | null {
  const target = parseSharedBrowserResumeTarget(search);
  if (!target || target.projectId !== projectId.toLowerCase() || !UUID.test(runtimeId) ||
      target.runtimeId === runtimeId.toLowerCase()) return null;
  const params = new URLSearchParams(search);
  params.set(SHARED_BROWSER_RUNTIME_PARAM, runtimeId.toLowerCase());
  return `?${params.toString()}`;
}

/** A locator, never an access grant: only opaque IDs cross devices. */
export function buildSharedBrowserResumeUrl(appUrl: string, target: SharedBrowserResumeTarget): string | null {
  if (!UUID.test(target.projectId) || !UUID.test(target.runtimeId)) return null;
  try {
    const base = new URL(appUrl);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) return null;
    const url = new URL("/studio", base.origin);
    url.searchParams.set("projectId", target.projectId.toLowerCase());
    url.searchParams.set("panel", "chat");
    url.searchParams.set(SHARED_BROWSER_RUNTIME_PARAM, target.runtimeId.toLowerCase());
    return url.toString();
  } catch { return null; }
}
