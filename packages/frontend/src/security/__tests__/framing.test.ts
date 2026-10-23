import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const staticHeaders = readFileSync(new URL("../../../public/_headers", import.meta.url), "utf8");

function frameAncestors(headers: string): string[] | null {
  const line = headers
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => /^content-security-policy:/i.test(entry));
  if (!line) return null;
  const directive = line
    .slice(line.indexOf(":") + 1)
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("frame-ancestors "));
  return directive ? directive.split(/\s+/).slice(1) : null;
}

describe("hosted Studio framing", () => {
  it("lets only Studio itself (and browser extensions) frame hosted pages", () => {
    // Studio holds a signed-in session in first-party storage. A page on any other origin, including another host
    // under the same parent domain, must not be able to frame it and lay its own UI over Studio's controls.
    const sources = frameAncestors(staticHeaders) ?? [];
    expect(sources[0]).toBe("'self'");
    for (const source of sources.slice(1)) {
      expect(source).toMatch(/^[a-z-]+-extension:$/);
    }
  });
});
