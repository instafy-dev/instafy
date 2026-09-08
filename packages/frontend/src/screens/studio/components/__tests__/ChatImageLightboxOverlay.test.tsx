// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatImageLightboxOverlay } from "../ChatPanelOverlays";

function Harness() {
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null);
  return <>
    {["first.png", "second.png"].map((name) => (
      <button key={name} data-testid={name} onClick={() => setImage({ src: "data:image/png;base64,AA==", alt: name })}>
        Preview {name}
      </button>
    ))}
    <button data-testid="background-remove">Remove image</button>
    <ChatImageLightboxOverlay imageLightbox={image} onClose={() => setImage(null)} />
  </>;
}

describe("image preview keyboard focus", () => {
  let container: HTMLDivElement;
  let root: Root;
  const get = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
  async function settleFocus() {
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
  async function open(name: string) {
    await act(async () => {
      get(name).focus();
      get(name).click();
    });
    await settleFocus();
  }

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<Harness />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("focuses the close action and keeps background controls outside the modal focus scope", async () => {
    await open("second.png");
    const close = get("chat-image-lightbox-close");
    expect(document.activeElement).toBe(close);
    expect(document.querySelector('[role="dialog"]')?.getAttribute("aria-label")).toBe("Image preview");
    await act(async () => get("background-remove").focus());
    expect(document.activeElement).toBe(close);
  });

  it.each(["Escape", "close"])("restores the originating thumbnail after %s, including reopening another image", async (action) => {
    for (const name of ["second.png", "first.png"]) {
      await open(name);
      await act(async () => {
        if (action === "Escape") {
          document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        } else {
          get("chat-image-lightbox-close").click();
        }
      });
      await settleFocus();
      expect(get("chat-image-lightbox")).toBeNull();
      await vi.waitFor(() => expect(document.activeElement).toBe(get(name)));
    }
  });

  it("keeps the preview open when the image itself is clicked", async () => {
    await open("first.png");
    await act(async () => get("chat-image-lightbox-image").click());
    expect(get("chat-image-lightbox")).not.toBeNull();
  });
});
