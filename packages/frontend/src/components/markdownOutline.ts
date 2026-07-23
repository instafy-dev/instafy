export type MarkdownOutlineItem = {
  title: string;
  depth: number;
  line: number;
  slug: string;
};

export type MarkdownOutlineTreeItem = MarkdownOutlineItem & {
  children: MarkdownOutlineTreeItem[];
};

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX_HEADING_PATTERN = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/;
const SETEXT_H1_PATTERN = /^ {0,3}=+\s*$/;
const SETEXT_H2_PATTERN = /^ {0,3}-+\s*$/;

function normalizeMarkdownHeadingText(raw: string): string {
  return raw
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~]+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function createMarkdownHeadingSlug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

  return normalized.length > 0 ? normalized : "section";
}

function createUniqueHeadingSlug(slugCounts: Map<string, number>, title: string): string {
  const baseSlug = createMarkdownHeadingSlug(title);
  const count = slugCounts.get(baseSlug) ?? 0;
  slugCounts.set(baseSlug, count + 1);
  return count === 0 ? baseSlug : `${baseSlug}-${count + 1}`;
}

export function parseMarkdownOutline(markdown: string): MarkdownOutlineItem[] {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const slugCounts = new Map<string, number>();
  const outline: MarkdownOutlineItem[] = [];
  let activeFence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(FENCE_PATTERN);
    if (fenceMatch) {
      const fence = fenceMatch[1] ?? "";
      const fenceMarker = fence.charAt(0);
      if (!activeFence) {
        activeFence = fenceMarker;
      } else if (activeFence === fenceMarker) {
        activeFence = null;
      }
      continue;
    }

    if (activeFence) {
      continue;
    }

    const atxMatch = line.match(ATX_HEADING_PATTERN);
    if (atxMatch) {
      const title = normalizeMarkdownHeadingText(atxMatch[2] ?? "");
      if (title.length > 0) {
        outline.push({
          title,
          depth: Math.min(6, Math.max(1, (atxMatch[1] ?? "#").length)),
          line: index + 1,
          slug: createUniqueHeadingSlug(slugCounts, title),
        });
      }
      continue;
    }

    const currentLine = normalizeMarkdownHeadingText(line);
    const nextLine = lines[index + 1] ?? "";
    if (!currentLine) {
      continue;
    }

    let setextDepth: number | null = null;
    if (SETEXT_H1_PATTERN.test(nextLine)) {
      setextDepth = 1;
    } else if (SETEXT_H2_PATTERN.test(nextLine)) {
      setextDepth = 2;
    }

    if (setextDepth) {
      outline.push({
        title: currentLine,
        depth: setextDepth,
        line: index + 1,
        slug: createUniqueHeadingSlug(slugCounts, currentLine),
      });
      index += 1;
    }
  }

  return outline;
}

export function buildMarkdownOutlineTree(items: MarkdownOutlineItem[]): MarkdownOutlineTreeItem[] {
  const roots: MarkdownOutlineTreeItem[] = [];
  const stack: MarkdownOutlineTreeItem[] = [];

  for (const item of items) {
    const node: MarkdownOutlineTreeItem = {
      ...item,
      children: [],
    };

    while (stack.length > 0 && stack[stack.length - 1]!.depth >= node.depth) {
      stack.pop();
    }

    const parent = stack[stack.length - 1];
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }

    stack.push(node);
  }

  return roots;
}
