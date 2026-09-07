// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveMonospaceFontFamily } from "../typography";

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("--font-mono");
});

describe("editor font family", () => {
  it("resolves the shared CSS font stack into a family string for canvas measurements", () => {
    document.documentElement.style.setProperty("--font-mono", '  ui-monospace, "Example Mono", monospace  ');
    expect(resolveMonospaceFontFamily()).toBe('ui-monospace, "Example Mono", monospace');
  });

  it("keeps a monospace fallback when the stylesheet is unavailable", () => {
    expect(resolveMonospaceFontFamily()).toBe("monospace");
  });

  it("can render without a browser", () => {
    vi.stubGlobal("window", undefined);
    expect(resolveMonospaceFontFamily()).toBe("monospace");
  });
});
