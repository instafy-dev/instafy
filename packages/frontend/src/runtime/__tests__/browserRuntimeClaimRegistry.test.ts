import { describe, expect, it } from "vitest";
import {
  beginBrowserRuntimeClaim,
  isBrowserRuntimeClaimActive,
} from "../browserRuntimeClaimRegistry";

describe("browserRuntimeClaimRegistry", () => {
  it("keeps a project claimed until every mounted browser owner releases it", () => {
    const projectId = "browser-claim-nested";
    const releaseFirst = beginBrowserRuntimeClaim(projectId);
    const releaseSecond = beginBrowserRuntimeClaim(projectId);

    expect(isBrowserRuntimeClaimActive(projectId)).toBe(true);
    releaseFirst();
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(true);
    releaseSecond();
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(false);
  });

  it("makes release idempotent without clearing a later owner", () => {
    const projectId = "browser-claim-idempotent";
    const releaseFirst = beginBrowserRuntimeClaim(projectId);
    releaseFirst();
    const releaseSecond = beginBrowserRuntimeClaim(projectId);

    releaseFirst();
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(true);
    releaseSecond();
    expect(isBrowserRuntimeClaimActive(projectId)).toBe(false);
  });
});
