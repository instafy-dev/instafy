import { describe, expect, it } from "vitest";

// External feature modules (composed via the application feature manifest)
// resolve this module with a dynamic import and destructure its members at
// runtime, so a missing export is invisible to the type checker in this
// repository and fails only in the composed application. This test pins the
// runtime surface those callers rely on.
describe("feature-api/controller runtime surface", () => {
  it("exports the controller client and project provider helpers", async () => {
    const namespace = await import("../controller");
    expect(typeof namespace.controllerClient).toBe("object");
    expect(typeof namespace.getProjectIntegrationByProvider).toBe("function");
    expect(typeof namespace.getProjectProviderSelectedDevice).toBe("function");
  });
});
