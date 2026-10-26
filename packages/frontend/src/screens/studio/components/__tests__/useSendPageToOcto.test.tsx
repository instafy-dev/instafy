// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSessionPageCaptureError } from "../../../../services/runtimeController/browserSession";
import { MAX_STAGED_SENT_PAGES, useChatComposerAttachments } from "../useChatComposerAttachments";
import { SENT_PAGE_STATUS, type SentPageRead } from "../sentPageAttachment";
import { sentPageFailureMessage, useSendPageToOcto } from "../useSendPageToOcto";

const READ: SentPageRead = {
  url: "https://shop.example/orders/42",
  title: "Order 42",
  text: "Ships Monday.",
  secretScreen: false,
  truncated: false,
  readAt: "2026-10-26T09:30:00.000Z",
};

type Probe = {
  attachments: ReturnType<typeof useChatComposerAttachments>;
  sendPage: ReturnType<typeof useSendPageToOcto>;
};
let latest: Probe;
const showStatus = vi.fn();

function Composer({ draftKey, unavailableReason = null }: { draftKey: string; unavailableReason?: string | null }) {
  const attachments = useChatComposerAttachments({ draftKey, isInputLocked: () => false, showStatus, unavailableReason });
  const sendPage = useSendPageToOcto({
    attachSentPage: attachments.attachSentPage,
    showStatus,
    unavailableReason,
    identityKey: draftKey,
  });
  latest = { attachments, sendPage };
  return null;
}

describe("Send page to Octo", () => {
  let root: Root;
  let container: HTMLDivElement;

  async function render(draftKey = "chat-a", unavailableReason: string | null = null) {
    await act(async () => root.render(<Composer draftKey={draftKey} unavailableReason={unavailableReason} />));
  }
  async function press(read: () => Promise<SentPageRead | null>, viewer: "personal" | "shared" = "shared") {
    let result = false;
    await act(async () => {
      result = await latest.sendPage.send(viewer, read);
    });
    return result;
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    showStatus.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("reads a page only when the person presses, once per press", async () => {
    const read = vi.fn(async () => READ);
    await render();
    await render();
    await render("chat-b");
    await render("chat-a");
    expect(read).not.toHaveBeenCalled();

    expect(await press(read)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(await press(read)).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    // Nothing reads again afterwards: no timer, no subscription.
    await render();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stages the page in the composer with its address and read time", async () => {
    await render();
    await press(async () => READ, "personal");
    const [staged] = latest.attachments.imageAttachments;
    expect(staged.page).toEqual({
      url: READ.url,
      host: "shop.example",
      title: "Order 42",
      readAt: READ.readAt,
      viewer: "personal",
    });
    expect(staged.previewUrl).toBe("");
    expect(staged.file.type).toBe("text/markdown");
    const markdown = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(staged.file);
    });
    expect(markdown).toContain(`- Read: ${READ.readAt}`);
    expect(showStatus).toHaveBeenCalledWith(SENT_PAGE_STATUS.attached, "success", 3500);
    // The person can take it back before sending, like any attachment.
    await act(async () => latest.attachments.removeImageAttachment(staged.id));
    expect(latest.attachments.imageAttachments).toEqual([]);
  });

  it("never stages a page that seemed to show a secret", async () => {
    await render();
    expect(await press(async () => ({ ...READ, secretScreen: true, text: "", title: "" }))).toBe(false);
    expect(latest.attachments.imageAttachments).toEqual([]);
    expect(showStatus).toHaveBeenCalledWith(SENT_PAGE_STATUS.withheld, "warning", 5000);
  });

  it("reads nothing where the server cannot store attachments", async () => {
    const read = vi.fn(async () => READ);
    await render("chat-a", "This server can't store attachments.");
    expect(await press(read)).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(showStatus).toHaveBeenCalledWith("This server can't store attachments.", "info", 4000);
  });

  it("runs one send at a time and drops a read that finishes in another chat", async () => {
    await render();
    let finish: (page: SentPageRead) => void = () => undefined;
    const slow = () => new Promise<SentPageRead>((resolve) => { finish = resolve; });
    let first: Promise<boolean> = Promise.resolve(false);
    await act(async () => {
      first = latest.sendPage.send("shared", slow);
    });
    expect(latest.sendPage.pendingViewer).toBe("shared");
    const second = vi.fn(async () => READ);
    await act(async () => {
      await latest.sendPage.send("shared", second);
    });
    expect(second).not.toHaveBeenCalled();
    await render("chat-b");
    await act(async () => {
      finish(READ);
      await first;
    });
    expect(latest.attachments.imageAttachments).toEqual([]);
    await render("chat-a");
    expect(latest.attachments.imageAttachments).toEqual([]);
    expect(latest.sendPage.pendingViewer).toBeNull();
  });

  it("caps the pages one message carries", async () => {
    await render();
    for (let index = 0; index < MAX_STAGED_SENT_PAGES; index += 1) {
      expect(await press(async () => READ)).toBe(true);
    }
    expect(await press(async () => READ)).toBe(false);
    expect(latest.attachments.imageAttachments).toHaveLength(MAX_STAGED_SENT_PAGES);
  });

  it("says why a page could not be sent in plain words", async () => {
    await render();
    expect(await press(async () => null)).toBe(false);
    expect(showStatus).toHaveBeenLastCalledWith(SENT_PAGE_STATUS.unsupported, "info", 4500);
    expect(await press(async () => ({ ...READ, url: "about:blank" }))).toBe(false);
    expect(showStatus).toHaveBeenLastCalledWith(SENT_PAGE_STATUS.notWebPage, "info", 4000);
    expect(await press(async () => {
      throw new BrowserSessionPageCaptureError(503, "browser cdp rejected Runtime.evaluate: page text");
    })).toBe(false);
    expect(showStatus).toHaveBeenLastCalledWith(SENT_PAGE_STATUS.unreadable, "error", 4500);
  });
});

describe("sentPageFailureMessage", () => {
  it("maps each browser's refusals to plain copy", () => {
    expect(sentPageFailureMessage(new BrowserSessionPageCaptureError(409, "x", "not_web_page"))).toBe(SENT_PAGE_STATUS.notWebPage);
    expect(sentPageFailureMessage(new BrowserSessionPageCaptureError(409, "x", "changed"))).toBe(SENT_PAGE_STATUS.changed);
    expect(sentPageFailureMessage(new BrowserSessionPageCaptureError(404, "x"))).toBe(SENT_PAGE_STATUS.unsupported);
    expect(sentPageFailureMessage(new BrowserSessionPageCaptureError(401, "x"))).toBe(SENT_PAGE_STATUS.notAllowed);
    expect(
      sentPageFailureMessage(new Error("Error invoking remote method 'instafy:personalBrowserReadPage': Error: Open a web page first.")),
    ).toBe(SENT_PAGE_STATUS.notWebPage);
    expect(
      sentPageFailureMessage(new Error("Error invoking remote method 'instafy:personalBrowserReadPage': Error: The page changed while it was read. Try again.")),
    ).toBe(SENT_PAGE_STATUS.changed);
    expect(sentPageFailureMessage(new Error("anything else"))).toBe(SENT_PAGE_STATUS.unreadable);
  });
});
