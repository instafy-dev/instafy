import { describe, expect, it } from "vitest";
import { buildDesktopStudioDeepLink } from "../desktopStudioDeepLink";

describe("buildDesktopStudioDeepLink", () => {
  const projectId = "11111111-1111-4111-8111-111111111111";
  const runtimeId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  it("copies only validated non-secret Studio routing fields", () => {
    expect(
      buildDesktopStudioDeepLink(
        "project-1",
        "https://prod.instafy.dev/studio?panel=settings&settingsTab=project" +
          "&settingsCategory=providers&controllerAccessToken=query-secret" +
          "&code=oauth-code&arbitrary=private#access_token=fragment-secret",
      ),
    ).toBe(
      "instafy://studio?projectId=project-1&panel=settings&settingsTab=project" +
        "&settingsCategory=providers",
    );
  });

  it("drops invalid allowlisted values and every fragment", () => {
    expect(
      buildDesktopStudioDeepLink(
        " project-1 ",
        "https://prod.instafy.dev/studio?panel=unknown&settingsTab=private" +
          "&settingsCategory=token-shaped#private-fragment",
      ),
    ).toBe("instafy://studio?projectId=project-1");
  });

  it("preserves only the project-bound Shared Browser locator when opening in Desktop", () => {
    expect(buildDesktopStudioDeepLink(projectId,
      `https://instafy.dev/studio?projectId=${projectId}&panel=chat&browserRuntimeId=${runtimeId}` +
      "&controllerAccessToken=inert-query&url=https%3A%2F%2Fexample.test&settingsTab=project#inert-fragment",
    )).toBe(`instafy://studio?projectId=${projectId}&panel=chat&browserRuntimeId=${runtimeId.toLowerCase()}`);
  });

  it.each([
    `https://instafy.dev/studio?projectId=${projectId}&panel=chat&browserRuntimeId=not-a-runtime`,
    `https://instafy.dev/studio?projectId=${projectId}&panel=chat&browserRuntimeId=${runtimeId}&browserRuntimeId=${runtimeId}`,
    `https://instafy.dev/studio?projectId=22222222-2222-4222-8222-222222222222&panel=chat&browserRuntimeId=${runtimeId}`,
    `https://instafy.dev/studio?projectId=${projectId}&projectId=${projectId}&panel=chat&browserRuntimeId=${runtimeId}`,
    `https://instafy.dev/other?projectId=${projectId}&panel=chat&browserRuntimeId=${runtimeId}`,
  ])("drops an invalid, ambiguous, or different-project runtime locator: %s", (url) => {
    expect(buildDesktopStudioDeepLink(projectId, url)).toBe(`instafy://studio?projectId=${projectId}&panel=chat`);
  });
});
