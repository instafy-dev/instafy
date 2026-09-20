import { describe, expect, it, beforeEach } from "vitest";
import {
  clearPendingProjectSecretPrefill,
  readPendingProjectSecretPrefill,
  setPendingProjectSecretPrefill,
} from "../secretManagerDeepLink";

describe("secret manager deep link", () => {
  beforeEach(() => {
    clearPendingProjectSecretPrefill();
  });

  it("carries which value to open on, and never the value itself", () => {
    // The guarantee the whole deep link rests on: this prefill names a secret,
    // it does not carry one. A caller that smuggles a value in loses it at the
    // boundary rather than having it kept.
    setPendingProjectSecretPrefill({
      projectId: "project-1",
      name: "NOTION_API_KEY",
      description: "Notion installation access token",
      agentHandles: ["octo"],
      // A field that does not exist on the type, as an untyped caller could
      // supply.
      ...({ value: "ntn_not-a-real-token" } as Record<string, unknown>),
    });

    const restored = readPendingProjectSecretPrefill();
    expect(restored?.name).toBe("NOTION_API_KEY");
    expect(restored && "value" in restored).toBe(false);
    expect(JSON.stringify(restored)).not.toContain("ntn_not-a-real-token");
  });

  it("hands out a copy the caller cannot reach back through", () => {
    setPendingProjectSecretPrefill({ projectId: "project-1", name: "NOTION_API_KEY" });
    const first = readPendingProjectSecretPrefill();
    expect(first).not.toBeNull();
    first!.name = "SOMETHING_ELSE";
    expect(readPendingProjectSecretPrefill()?.name).toBe("NOTION_API_KEY");
  });

  it("keeps nothing once the panel has taken it", () => {
    setPendingProjectSecretPrefill({ projectId: "project-1", name: "NOTION_API_KEY" });
    clearPendingProjectSecretPrefill();
    expect(readPendingProjectSecretPrefill()).toBeNull();
  });

  it("does not forget a waiting prefill when handed one that names nothing", () => {
    setPendingProjectSecretPrefill({ projectId: "project-1", name: "NOTION_API_KEY" });
    setPendingProjectSecretPrefill({ projectId: "project-1", name: "   " });
    expect(readPendingProjectSecretPrefill()?.name).toBe("NOTION_API_KEY");
  });
});
