import { describe, expect, it, vi } from "vitest";
import { readTextAttachmentPage, TEXT_ATTACHMENT_PAGE_BYTES } from "../textAttachmentPage";

describe("text attachment pages", () => {
  it.each(["é", "界", "🐙"])("keeps a boundary through %s intact across pages", async (character) => {
    const content = `${"a".repeat(TEXT_ATTACHMENT_PAGE_BYTES - 1)}${character}tail`;
    const blob = new Blob([content]);
    const slice = vi.spyOn(blob, "slice");
    const first = await readTextAttachmentPage(blob, 0);
    expect(first.content).toBe("a".repeat(TEXT_ATTACHMENT_PAGE_BYTES - 1));
    expect(first.nextOffset).toBe(TEXT_ATTACHMENT_PAGE_BYTES - 1);
    const next = await readTextAttachmentPage(blob, first.nextOffset!);
    expect(next.nextOffset).toBeNull();
    expect(first.content + next.content).toBe(content);
    expect((await readTextAttachmentPage(blob, 0)).content).toBe(first.content);
    expect(slice).toHaveBeenCalledWith(0, TEXT_ATTACHMENT_PAGE_BYTES + 4);
  });

  it("handles empty files and makes progress through malformed UTF-8", async () => {
    expect(await readTextAttachmentPage(new Blob([]), 0)).toEqual({ content: "", nextOffset: null });
    const page = await readTextAttachmentPage(new Blob([new Uint8Array(TEXT_ATTACHMENT_PAGE_BYTES + 20).fill(0x80)]), 0);
    expect(page.nextOffset).toBeGreaterThan(0);
    expect(page.content.length).toBeGreaterThan(0);
  });

  it("preserves a byte-order-mark character inside the file at a page boundary", async () => {
    const content = `${"a".repeat(TEXT_ATTACHMENT_PAGE_BYTES)}\ufefftail`;
    const blob = new Blob([content]);
    const first = await readTextAttachmentPage(blob, 0);
    const second = await readTextAttachmentPage(blob, first.nextOffset!);
    expect(first.content + second.content).toBe(content);
  });
});
