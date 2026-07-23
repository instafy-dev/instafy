import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildPreparedEmailInviteMailtoUrl,
  buildPreparedEmailInviteSharePayload,
  openPreparedEmailInviteComposer,
} from "../preparedEmailInvite";

const invite = {
  acceptUrl: "https://instafy.dev/invite?token=secure-token",
  email: "teammate@example.com",
  role: "viewer",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("prepared email invite sharing", () => {
  it("builds a pre-addressed email that is explicit about manual delivery", () => {
    const url = new URL(buildPreparedEmailInviteMailtoUrl(invite));

    expect(url.protocol).toBe("mailto:");
    expect(decodeURIComponent(url.pathname)).toBe(invite.email);
    expect(url.searchParams.get("subject")).toBe("Your Instafy invitation");
    expect(url.searchParams.get("body")).toContain(invite.acceptUrl);
    expect(url.searchParams.get("body")).toContain("Instafy did not send this automatically");
  });

  it("keeps the accept URL available to a native or web share sheet", () => {
    expect(buildPreparedEmailInviteSharePayload(invite)).toMatchObject({
      dialogTitle: "Share prepared invite",
      title: "Your Instafy invitation",
      url: invite.acceptUrl,
    });
  });

  it("opens mailto in a separate context instead of replacing Studio", () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });

    openPreparedEmailInviteComposer(invite);

    expect(open).toHaveBeenCalledWith(
      expect.stringMatching(/^mailto:/),
      "_blank",
      "noopener,noreferrer",
    );
  });
});
