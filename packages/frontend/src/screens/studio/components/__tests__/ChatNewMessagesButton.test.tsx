// @vitest-environment jsdom
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatNewMessagesButton } from "../ChatNewMessagesButton";

describe("return to the latest conversation", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("offers an exit from an old message without implying that a new message arrived", async () => {
    const onPress = vi.fn();
    await act(async () => root.render(<ChatNewMessagesButton hasNewMessages={false} onPress={onPress} />));
    const button = container.querySelector("button")!;
    expect(button.textContent).toBe("Return to latest");
    expect(button.getAttribute("aria-label")).toBe("Jump to latest");
    await act(async () => button.click());
    expect(onPress).toHaveBeenCalledOnce();
  });

  it("moves the activating control's focus to the reader before that control disappears", async () => {
    const readingRegionRef = createRef<HTMLDivElement>();
    const onPress = vi.fn();
    const content = (show: boolean) => <>
      <div ref={readingRegionRef} role="log" tabIndex={-1} aria-label="Conversation messages" />
      <input aria-label="Draft" defaultValue="Keep this draft" />
      {show ? <ChatNewMessagesButton hasNewMessages={false} onPress={onPress} readingRegionRef={readingRegionRef} /> : null}
    </>;
    await act(async () => root.render(content(true)));
    const button = container.querySelector("button")!;
    button.focus();
    await act(async () => button.click());
    expect(onPress).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(readingRegionRef.current);
    await act(async () => root.render(content(false)));
    expect(document.activeElement).toBe(readingRegionRef.current);
    expect(container.querySelector("input")?.value).toBe("Keep this draft");
  });
});
