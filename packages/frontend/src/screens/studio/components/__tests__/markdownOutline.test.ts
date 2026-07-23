import { describe, expect, it } from "vitest";
import { buildMarkdownOutlineTree, createMarkdownHeadingSlug, parseMarkdownOutline } from "../../../../components/markdownOutline";

describe("parseMarkdownOutline", () => {
  it("extracts markdown headings with depth, line numbers, and unique slugs", () => {
    const outline = parseMarkdownOutline([
      "# Overview",
      "",
      "## Install",
      "",
      "## Install",
      "",
      "Details",
      "-------",
    ].join("\n"));

    expect(outline).toEqual([
      { title: "Overview", depth: 1, line: 1, slug: "overview" },
      { title: "Install", depth: 2, line: 3, slug: "install" },
      { title: "Install", depth: 2, line: 5, slug: "install-2" },
      { title: "Details", depth: 2, line: 7, slug: "details" },
    ]);
  });

  it("ignores headings inside fenced code blocks", () => {
    const outline = parseMarkdownOutline([
      "# Intro",
      "",
      "```md",
      "## Not real",
      "```",
      "",
      "## Real",
    ].join("\n"));

    expect(outline).toEqual([
      { title: "Intro", depth: 1, line: 1, slug: "intro" },
      { title: "Real", depth: 2, line: 7, slug: "real" },
    ]);
  });
});

describe("createMarkdownHeadingSlug", () => {
  it("normalizes punctuation and accents", () => {
    expect(createMarkdownHeadingSlug("Crème brûlée: Setup & Usage")).toBe("creme-brulee-setup-usage");
  });
});

describe("buildMarkdownOutlineTree", () => {
  it("nests child headings under the nearest shallower parent", () => {
    const tree = buildMarkdownOutlineTree([
      { title: "Intro", depth: 1, line: 1, slug: "intro" },
      { title: "Install", depth: 2, line: 3, slug: "install" },
      { title: "Linux", depth: 3, line: 5, slug: "linux" },
      { title: "Usage", depth: 2, line: 9, slug: "usage" },
    ]);

    expect(tree).toEqual([
      {
        title: "Intro",
        depth: 1,
        line: 1,
        slug: "intro",
        children: [
          {
            title: "Install",
            depth: 2,
            line: 3,
            slug: "install",
            children: [
              {
                title: "Linux",
                depth: 3,
                line: 5,
                slug: "linux",
                children: [],
              },
            ],
          },
          {
            title: "Usage",
            depth: 2,
            line: 9,
            slug: "usage",
            children: [],
          },
        ],
      },
    ]);
  });
});
