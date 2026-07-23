import { describe, expect, it } from "vitest";
import {
  normalizePersonalBrowserUrl,
  personalBrowserIdentityScope,
  resolveDefaultBrowserTransport,
  resolvePersonalBrowserRuntimeOverride,
} from "../usePersonalBrowserBridge";

describe("personal browser bridge helpers", () => {
  it("changes identity scope when either the project or local user profile changes", () => {
    const first = personalBrowserIdentityScope("project-a", "instafy-user:user-a");
    expect(first).toBeTruthy();
    expect(personalBrowserIdentityScope("project-a", "instafy-user:user-a")).toBe(first);
    expect(personalBrowserIdentityScope("project-a", "instafy-user:user-b")).not.toBe(first);
    expect(personalBrowserIdentityScope("project-b", "instafy-user:user-a")).not.toBe(first);
    expect(personalBrowserIdentityScope(null, "instafy-user:user-a")).toBeNull();
  });

  it("prefers Personal only after the desktop bridge confirms support and enablement", () => {
    expect(resolveDefaultBrowserTransport({ checked: false, supported: true, enabled: true })).toBe("shared");
    expect(resolveDefaultBrowserTransport({ checked: true, supported: false, enabled: true })).toBe("shared");
    expect(resolveDefaultBrowserTransport({ checked: true, supported: true, enabled: false })).toBe("shared");
    expect(resolveDefaultBrowserTransport({ checked: true, supported: true, enabled: true })).toBe("personal");
  });

  it("normalizes web addresses and rejects privileged schemes", () => {
    expect(normalizePersonalBrowserUrl("example.com/path")).toBe("https://example.com/path");
    expect(normalizePersonalBrowserUrl("example.test:5173/path")).toBe(
      "https://example.test:5173/path",
    );
    expect(normalizePersonalBrowserUrl("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizePersonalBrowserUrl("about:blank")).toBe("about:blank");
    expect(normalizePersonalBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(normalizePersonalBrowserUrl("file:///etc/passwd")).toBeNull();
    expect(normalizePersonalBrowserUrl("data:text/html,test")).toBeNull();
    expect(normalizePersonalBrowserUrl("https://user:secret@example.com")).toBeNull();
    expect(normalizePersonalBrowserUrl("   ")).toBeNull();
  });

  it("pins one send only when the desktop agent is ready and resumed", () => {
    expect(
      resolvePersonalBrowserRuntimeOverride({
        agentControlEnabled: false,
        agentPhase: "ready",
        browserState: "ready",
        runtimeId: "desktop-personal-project-1",
      }),
    ).toBeNull();
    expect(
      resolvePersonalBrowserRuntimeOverride({
        agentControlEnabled: true,
        agentPhase: "starting",
        browserState: "ready",
        runtimeId: "desktop-personal-project-1",
      }),
    ).toBeNull();
    expect(
      resolvePersonalBrowserRuntimeOverride({
        agentControlEnabled: true,
        agentPhase: "ready",
        browserState: "ready",
        runtimeId: "desktop-personal-project-1",
      }),
    ).toEqual({
      runtimeId: "desktop-personal-project-1",
      runtimeDisplayName: "Personal Browser on this device",
      preferRuntime: false,
    });
  });
});
