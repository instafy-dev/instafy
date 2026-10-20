import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../types";
import { sitePreviewFromMessage } from "../sitePreviewRequest";

const PREVIEW_ID = "11111111-1111-4111-8111-111111111111";

// As the controller stores the card: wrapped the way agent updates are.
function card(overrides: Record<string, unknown> = {}): ChatMessage {
  return {
    id: "card-1", role: "assistant", content: "Site preview is ready to preview.", timestamp: 1,
    metadata: { source: "agent", kind: "update", messageType: "action_request", details: { messageType: "action_request", details: {
      testId: "preview-ready-card", icon: "preview", overline: "Ready to preview", title: "Site preview",
      preview: { previewId: PREVIEW_ID, port: 4173, path: "/" },
      actions: [{ id: "open-preview", label: "Open", variant: "primary", event: "instafy:open-preview" }],
      ...overrides,
    } } },
  };
}

describe("sitePreviewFromMessage", () => {
  it("reads the controller's card and ignores any URL in it", () => {
    expect(sitePreviewFromMessage(card({
      href: "https://elsewhere.test",
      preview: { previewId: PREVIEW_ID, port: 4173, path: "/x/", url: "https://elsewhere.test" },
    }))).toEqual({ previewId: PREVIEW_ID, title: "Site preview", port: 4173 });
  });

  it("names an untitled preview Preview", () => {
    expect(sitePreviewFromMessage(card({ title: "  " }))?.title).toBe("Preview");
  });

  it.each([
    ["a user message", { ...card(), role: "user" as const }],
    ["a URL as the id", card({ preview: { previewId: "https://p-x--y.preview.test/", port: 4173 } })],
    ["a host as the id", card({ preview: { previewId: "p-x.preview.test", port: 4173 } })],
    ["a port out of range", card({ preview: { previewId: PREVIEW_ID, port: 70_000 } })],
    ["no port", card({ preview: { previewId: PREVIEW_ID } })],
    ["no preview", card({ preview: undefined })],
  ])("refuses %s", (_name, message) => {
    expect(sitePreviewFromMessage(message)).toBeNull();
  });
});
