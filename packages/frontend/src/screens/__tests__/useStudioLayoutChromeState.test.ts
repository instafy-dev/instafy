import { describe, expect, it } from "vitest";
import { shouldDismissLeftDrawerForKeydown } from "../useStudioLayoutChromeState";

describe("shouldDismissLeftDrawerForKeydown", () => {
  it("dismisses the drawer for an unhandled Escape key", () => {
    expect(
      shouldDismissLeftDrawerForKeydown({
        key: "Escape",
        defaultPrevented: false,
      }),
    ).toBe(true);
  });

  it("leaves the drawer open when a nested surface consumes Escape", () => {
    expect(
      shouldDismissLeftDrawerForKeydown({
        key: "Escape",
        defaultPrevented: true,
      }),
    ).toBe(false);
  });

  it("ignores unrelated keys", () => {
    expect(
      shouldDismissLeftDrawerForKeydown({
        key: "Enter",
        defaultPrevented: false,
      }),
    ).toBe(false);
  });
});
