// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StudioSearchResultCopy, highlightStudioSearchExcerpt } from "../StudioSearchResultCopy";

function render(text: string, ranges: Array<{ start: number; end: number }>) {
  const node = document.createElement("div");
  node.innerHTML = renderToStaticMarkup(<span>{highlightStudioSearchExcerpt(text, ranges)}</span>);
  return node;
}

describe("Studio message search excerpts", () => {
  it("highlights controller UTF-16 ranges and preserves all surrounding text", () => {
    const text = "😀 Repair the broken search, then search again.";
    const first = text.indexOf("search");
    const last = text.lastIndexOf("search");
    const node = render(text, [{ start: first, end: first + 6 }, { start: last, end: last + 6 }]);
    expect(node.textContent).toBe(text);
    expect(Array.from(node.querySelectorAll("mark")).map((mark) => mark.textContent)).toEqual(["search", "search"]);
  });

  it("renders source markup as plain text and ignores invalid ranges", () => {
    const text = '<img src=x onerror="alert(1)"> search';
    const start = text.indexOf("search");
    const node = render(text, [{ start: -1, end: 8 }, { start, end: text.length }, { start: 0, end: 500 }, { start: 2.5, end: 8 }]);
    expect(node.querySelector("img")).toBeNull();
    expect(node.textContent).toBe(text);
    expect(node.querySelectorAll("mark")).toHaveLength(1);
    expect(node.querySelector("mark")?.textContent).toBe("search");
  });

  it("merges overlapping ranges without duplicating excerpt text", () => {
    const node = render("Repair search", [{ start: 7, end: 13 }, { start: 9, end: 12 }, { start: 8, end: 13 }]);
    expect(node.textContent).toBe("Repair search");
    expect(node.querySelectorAll("mark")).toHaveLength(1);
  });

  it("shows the chat, scope, author and timestamp beside a message excerpt", () => {
    const node = document.createElement("div");
    node.innerHTML = renderToStaticMarkup(<StudioSearchResultCopy title="Fix navigation" description="Team / Core" message={{
      excerpt: "The tab gets stuck", query: "stuck", matchRanges: [{ start: 13, end: 18 }],
      authorLabel: "Assistant", createdAt: "2026-09-10T10:30:00Z",
    }} />);
    expect(node.querySelector("strong")?.textContent).toBe("Fix navigation");
    expect(node.textContent).toContain("Team / Core");
    expect(node.textContent).toContain("Assistant");
    expect(node.querySelector("time")?.dateTime).toBe("2026-09-10T10:30:00Z");
    expect(node.querySelector("mark")?.textContent).toBe("stuck");
  });
});
