/**
 * Projects currently owned by an open Shared Browser surface.
 *
 * The runtime status stream publishes a browser takeover's deliberate stop before
 * the browser-specific ensure can finish. Generic runtime recovery must stand down
 * for the full browser session; otherwise it can win the replacement lease and
 * relaunch the runtime without the browser image or environment.
 */
export const BROWSER_RUNTIME_CLAIM_CHANGED_EVENT =
  "instafy:browser-runtime-claim-changed";

const activeClaims = new Map<string, number>();

function normalizeProjectId(projectId: string | null | undefined): string {
  return projectId?.trim() ?? "";
}

function emitClaimChanged(projectId: string, active: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(
    new CustomEvent(BROWSER_RUNTIME_CLAIM_CHANGED_EVENT, {
      detail: { projectId, active },
    }),
  );
}

export function beginBrowserRuntimeClaim(projectId: string): () => void {
  const normalizedProjectId = normalizeProjectId(projectId);
  if (!normalizedProjectId) {
    return () => {};
  }

  const previousCount = activeClaims.get(normalizedProjectId) ?? 0;
  activeClaims.set(normalizedProjectId, previousCount + 1);
  if (previousCount === 0) {
    emitClaimChanged(normalizedProjectId, true);
  }

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const nextCount = Math.max(
      0,
      (activeClaims.get(normalizedProjectId) ?? 1) - 1,
    );
    if (nextCount > 0) {
      activeClaims.set(normalizedProjectId, nextCount);
      return;
    }
    activeClaims.delete(normalizedProjectId);
    emitClaimChanged(normalizedProjectId, false);
  };
}

export function isBrowserRuntimeClaimActive(
  projectId: string | null | undefined,
): boolean {
  const normalizedProjectId = normalizeProjectId(projectId);
  return Boolean(
    normalizedProjectId && (activeClaims.get(normalizedProjectId) ?? 0) > 0,
  );
}
