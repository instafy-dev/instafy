import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const stylesFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tailwind.css");

describe("mobile text-entry zoom guardrail", () => {
  it("keeps mobile text-entry controls at 16px to avoid iOS focus zoom", () => {
    const css = fs.readFileSync(stylesFile, "utf8");

    expect(css).toMatch(/@media\s*\(max-width:\s*639px\)/);
    expect(css).toContain('[contenteditable="true"][role="textbox"]');
    expect(css).toContain('font-size: 16px;');
    expect(css).toContain('line-height: 1.25rem;');
    expect(css).toContain('input:not([type="button"])');
    expect(css).toContain(':not([type="file"])');
    expect(css).toContain(':not([type="checkbox"])');
  });
});
