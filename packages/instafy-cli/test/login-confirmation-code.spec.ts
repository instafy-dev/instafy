import { describe, expect, it } from "vitest";
import { cliLoginConfirmationCode } from "../src/auth.js";

describe("@instafy/cli login confirmation code", () => {
  // The Studio page shows the same code for the same state:
  // packages/frontend/src/screens/__tests__/CliLoginPage.test.tsx checks this pair.
  it("is the state's first 8 characters, uppercased, as XXXX-XXXX", () => {
    expect(cliLoginConfirmationCode("0f1e2d3c4b5a69788796a5b4c3d2e1f0")).toBe("0F1E-2D3C");
  });
});
