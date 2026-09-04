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

// @vitest-environment jsdom is not needed for the pure helpers below; they
// guard against a missing window themselves, and here we give them a stub.
describe("sidebar collapse persistence", () => {
  const storage = new Map<string, string>();
  const stubWindow = {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    },
  };

  it("defaults to collapsed until the user chooses, then remembers the choice", async () => {
    storage.clear();
    (globalThis as { window?: unknown }).window = stubWindow;
    try {
      const { readStoredSidebarCollapsed, writeStoredSidebarCollapsed } = await import(
        "../useStudioLayoutChromeState"
      );
      expect(readStoredSidebarCollapsed()).toBe(true);
      writeStoredSidebarCollapsed(false);
      expect(readStoredSidebarCollapsed()).toBe(false);
      writeStoredSidebarCollapsed(true);
      expect(readStoredSidebarCollapsed()).toBe(true);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("stays collapsed when storage throws", async () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    };
    try {
      const { readStoredSidebarCollapsed, writeStoredSidebarCollapsed } = await import(
        "../useStudioLayoutChromeState"
      );
      expect(() => writeStoredSidebarCollapsed(false)).not.toThrow();
      expect(readStoredSidebarCollapsed()).toBe(true);
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
