import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SOCIAL_CARD_IMAGE } from "../seo";

/**
 * The social card (public/og-image.png) is served at a content-versioned URL so
 * link unfurlers drop a cached older card. `pnpm generate:og-image` rewrites the
 * URL whenever it regenerates the card; these checks run on every pull request,
 * so a card committed without its URL (or a page spelling the bare path) fails
 * here rather than in a native release lane.
 */
const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (...segments: string[]) => fs.readFileSync(path.join(frontendRoot, ...segments));
const CARD_URL = /["'`](\/og-image\.png(?:\?[^"'`]*)?)["'`]/g;

function cardUrls(text: string): string[] {
  return [...text.matchAll(CARD_URL)].map((match) => match[1]);
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  const pending = [path.join(frontendRoot, directory)];
  while (pending.length) {
    const current = pending.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "__tests__") pending.push(absolute);
      } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
        files.push(absolute);
      }
    }
  }
  return files;
}

describe("social card URL", () => {
  const digest = createHash("sha256").update(read("public", "og-image.png")).digest("hex");
  const expected = `/og-image.png?sha=${digest.slice(0, 12)}`;

  it("versions SOCIAL_CARD_IMAGE by the committed card's content", () => {
    expect(SOCIAL_CARD_IMAGE).toBe(expected);
  });

  it("points both static meta tags in index.html at the same URL", () => {
    expect(cardUrls(read("index.html").toString("utf8"))).toEqual([expected, expected]);
  });

  it("is never spelled by a page: pages pass SOCIAL_CARD_IMAGE", () => {
    const seo = path.join(frontendRoot, "src", "utils", "seo.ts");
    // hosted/robot is a generated copy of an upstream integration. The hosted web
    // release requires it to stay byte-identical to that export, so it changes
    // only by re-exporting from upstream, never by hand here.
    const vendoredRobotSlice = path.join(frontendRoot, "hosted", "robot") + path.sep;
    const offenders = [...sourceFiles("src"), ...sourceFiles("hosted")]
      .filter((file) => !file.startsWith(vendoredRobotSlice))
      .filter((file) => file !== seo && cardUrls(fs.readFileSync(file, "utf8")).length > 0)
      .map((file) => path.relative(frontendRoot, file));
    expect(offenders).toEqual([]);
  });
});
