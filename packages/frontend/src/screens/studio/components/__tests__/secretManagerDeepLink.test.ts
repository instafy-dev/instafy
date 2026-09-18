// @vitest-environment jsdom

import { describe, expect, it, beforeEach } from "vitest";
import {
  readPendingProjectSecretPrefill,
  setPendingProjectSecretPrefill,
} from "../secretManagerDeepLink";

describe("secret manager deep link", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("carries which value to open on, and never the value itself", () => {
    // The guarantee the CodeQL suppression at the storage site rests on: this
    // prefill names a secret, it does not carry one. A caller that smuggles a
    // value in loses it at the boundary rather than putting it in storage.
    setPendingProjectSecretPrefill({
      projectId: "project-1",
      name: "NOTION_API_KEY",
      description: "Notion installation access token",
      agentHandles: ["octo"],
      // A field that does not exist on the type, as an untyped caller or a
      // stale stored payload could supply.
      ...({ value: "ntn_not-a-real-token" } as Record<string, unknown>),
    });

    const raw = window.sessionStorage.getItem("instafy.projectSecrets.pendingCreate.v1") ?? "";
    expect(raw).not.toBe("");
    expect(raw).not.toContain("ntn_not-a-real-token");
    expect(raw).not.toContain("value");

    const restored = readPendingProjectSecretPrefill();
    expect(restored?.name).toBe("NOTION_API_KEY");
    expect(restored && "value" in restored).toBe(false);
  });

  it("drops a value smuggled into the stored payload", () => {
    window.sessionStorage.setItem(
      "instafy.projectSecrets.pendingCreate.v1",
      JSON.stringify({ name: "NOTION_API_KEY", value: "ntn_not-a-real-token" }),
    );
    const restored = readPendingProjectSecretPrefill();
    expect(restored?.name).toBe("NOTION_API_KEY");
    expect(restored && "value" in restored).toBe(false);
  });
});
