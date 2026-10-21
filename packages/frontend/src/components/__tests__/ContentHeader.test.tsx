import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ContentHeader } from "../ContentHeader";

describe("ContentHeader accessibility", () => {
  it("provides a file heading without introducing a page-banner landmark", () => {
    // Studio's working panes need not sit within main/section, so a header
    // element here would be exposed as an additional page-level banner.
    const html = renderToStaticMarkup(<ContentHeader title="src/example.ts" titleAs="h4" />);
    expect(html).toMatch(/^<div /);
    expect(html).not.toMatch(/<header\b|role="banner"/);
    expect(html).toMatch(/<h4\b[^>]*>src\/example.ts<\/h4>/);
  });

  it("retains the heading and actions when a surrounding tab owns the visible name", () => {
    const html = renderToStaticMarkup(<ContentHeader title="guide.md" titleHidden
      subtitle="docs/guide.md" icon={<span>Decorative icon</span>} actions={<button>Save</button>} />);
    expect(html).toMatch(/<h3\b[^>]*class="[^"]*sr-only[^"]*">guide.md<\/h3>/);
    expect(html).toContain("<button>Save</button>");
    expect(html).not.toContain("docs/guide.md");
    expect(html).not.toContain("Decorative icon");
  });
});
