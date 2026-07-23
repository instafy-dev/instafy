import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const frontendHtml = readFileSync(new URL("../../../index.html", import.meta.url), "utf8");
const staticHeaders = readFileSync(new URL("../../../public/_headers", import.meta.url), "utf8");

describe("invite token referrer protection", () => {
  it("sets the document policy before scripts and external resources", () => {
    const policyIndex = frontendHtml.indexOf('<meta name="referrer" content="no-referrer" />');
    const firstScriptIndex = frontendHtml.indexOf("<script");
    const firstLinkIndex = frontendHtml.indexOf("<link");

    expect(policyIndex).toBeGreaterThan(-1);
    expect(policyIndex).toBeLessThan(firstScriptIndex);
    expect(policyIndex).toBeLessThan(firstLinkIndex);
  });

  it("sets the same policy on hosted HTML responses", () => {
    expect(staticHeaders).toMatch(/^\/\*\s+Referrer-Policy: no-referrer\s*$/m);
  });
});
