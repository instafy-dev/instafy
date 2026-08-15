import { describe, expect, it } from "vitest";
import { buildDesktopStudioDeepLink } from "../desktopStudioDeepLink";

describe("buildDesktopStudioDeepLink", () => {
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
});
