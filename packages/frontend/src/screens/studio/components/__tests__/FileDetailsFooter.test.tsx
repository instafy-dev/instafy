// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileDetailsFooter } from "../FileDetailsFooter";
import { registerNativeBackAction } from "../../../../native/nativeBackButtonCoordinator";

const native = vi.hoisted(() => ({ addListener: vi.fn() }));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "android" } }));
vi.mock("@capacitor/app", () => ({ App: native }));

describe("FileDetailsFooter", () => {
  let container: HTMLDivElement;
  let root: Root;
  let nativeBack: (() => void) | undefined;
  let unregisterPage: (() => void) | undefined;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    native.addListener.mockImplementation(async (_event: string, handler: () => void) => {
      nativeBack = handler;
      return { remove: async () => undefined };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    unregisterPage?.();
    unregisterPage = undefined;
    await act(async () => root.unmount());
    container.remove();
    vi.clearAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const dialog = () => document.querySelector('[role="dialog"][aria-label="File details"]');
  const trigger = () => container.querySelector<HTMLButtonElement>('[data-testid="files-viewer-details"]')!;
  const open = () => act(async () => { trigger().focus(); trigger().click(); });

  it("closes details before handling native Back on the underlying page, preserving save status and focus", async () => {
    const leavePage = vi.fn();
    unregisterPage = registerNativeBackAction(leavePage, 20);
    await act(async () => root.render(<FileDetailsFooter status="Unsaved changes" facts={[
      { label: "Size", value: "12 B" },
      { label: "Modified", value: "October 21, 2026" },
    ]} />));
    expect(container.textContent).not.toContain("October 21");
    await open();
    expect(dialog()?.textContent).toContain("October 21, 2026");
    await act(async () => nativeBack?.());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(dialog()).toBeNull();
    expect(leavePage).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Unsaved changes");
    await act(async () => nativeBack?.());
    expect(leavePage).toHaveBeenCalledOnce();
  });

  it("does not invent save status or missing metadata, and resets the details when the file changes", async () => {
    await act(async () => root.render(<FileDetailsFooter key="a" status={null} facts={[{ label: "Size", value: "0 B" }]} />));
    expect(container.querySelector('[role="status"]')).toBeNull();
    await open();
    expect(dialog()?.textContent).toContain("Size0 B");
    expect(dialog()?.textContent).not.toContain("Modified");
    expect(dialog()?.textContent).not.toContain("MIME");
    await act(async () => root.render(<FileDetailsFooter key="b" status={null} facts={[{ label: "MIME", value: "image/png" }]} />));
    expect(dialog()).toBeNull();
    await open();
    expect(dialog()?.textContent).toContain("image/png");
    expect(dialog()?.textContent).not.toContain("Size");
    await act(async () => root.render(<FileDetailsFooter key="c" status={null} facts={[]} />));
    expect(container.querySelector("footer")).toBeNull();
  });
});
