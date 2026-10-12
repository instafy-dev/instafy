import { describe, expect, it } from "vitest";
import { createCheckoutTmpIgnore } from "../../devWatchIgnore";

describe("dev server tmp/ watch filter", () => {
  it("ignores scratch worktrees under the main checkout's tmp/", () => {
    const ignore = createCheckoutTmpIgnore("/repo/instafy");
    expect(ignore("/repo/instafy/tmp/feature/packages/frontend/src/main.tsx")).toBe(true);
    expect(ignore("/repo/instafy/packages/frontend/tmp/cache.json")).toBe(true);
  });

  it("still watches a worktree whose own path runs through tmp/", () => {
    const ignore = createCheckoutTmpIgnore("/repo/instafy/tmp/feature");
    expect(ignore("/repo/instafy/tmp/feature/packages/frontend/src/main.tsx")).toBe(false);
    expect(ignore("/repo/instafy/tmp/feature/packages/frontend/vite.config.ts")).toBe(false);
    expect(ignore("/repo/instafy/tmp/feature/tmp/nested/src/x.ts")).toBe(true);
  });

  it("leaves paths outside the checkout and the root itself alone", () => {
    const ignore = createCheckoutTmpIgnore("/repo/instafy");
    expect(ignore("/repo/instafy")).toBe(false);
    expect(ignore("/elsewhere/tmp/x.ts")).toBe(false);
    expect(ignore("/repo/instafy/src/tmpfile.ts")).toBe(false);
  });
});
