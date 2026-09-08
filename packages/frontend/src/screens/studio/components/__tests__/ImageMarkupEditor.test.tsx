// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ImageMarkupEditor, type ImageMarkupEditorProps } from "../ImageMarkupEditor";
import { BugReportScreenshotModal } from "../BugReportScreenshotModal";

describe("image markup editing", () => {
  let host: HTMLDivElement;
  let root: Root;
  let images: HTMLImageElement[];
  let frames: Map<number, FrameRequestCallback>;
  let frameId: number;
  const context = {
    clearRect: vi.fn(), drawImage: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    lineCap: "butt", lineJoin: "miter", strokeStyle: "", lineWidth: 0,
  };
  let exportBlob: MockInstance<HTMLCanvasElement["toBlob"]>;
  const save = vi.fn();
  const cancel = vi.fn();
  const savingChanged = vi.fn();
  const canvas = () => host.querySelector("canvas")!;
  const button = (text: string) => Array.from(host.querySelectorAll("button")).find((item) => item.textContent === text)!;
  async function click(text: string) { await act(async () => button(text).click()); }
  async function render(props: Partial<ImageMarkupEditorProps> = {}) {
    await act(async () => root.render(<ImageMarkupEditor src="blob:first" alt="sample.png" onSave={save} onCancel={cancel} onSavingChange={savingChanged} {...props} />));
  }
  async function load(width = 4096, height = 2048) {
    const image = images[images.length - 1];
    Object.defineProperties(image, { naturalWidth: { value: width }, naturalHeight: { value: height } });
    await act(async () => image.onload?.(new Event("load")));
  }
  function pointer(type: string, x: number, y: number, pointerId = 1, pointerType = "pen") {
    const event = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
    Object.defineProperties(event, { pointerId: { value: pointerId }, pointerType: { value: pointerType } });
    canvas().dispatchEvent(event);
  }
  function paint() {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((frame) => frame(0));
  }
  async function stroke() {
    await act(async () => {
      pointer("pointerdown", 20, 10);
      pointer("pointermove", 100, 50);
      pointer("pointerup", 180, 90);
      paint();
    });
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    save.mockReset();
    images = [];
    frames = new Map();
    frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    vi.stubGlobal("Image", function () { const image = document.createElement("img"); images.push(image); return image; });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 200, height: 100 } as DOMRect);
    Object.defineProperties(HTMLCanvasElement.prototype, {
      setPointerCapture: { value: vi.fn(), configurable: true },
      hasPointerCapture: { value: vi.fn(() => true), configurable: true },
      releasePointerCapture: { value: vi.fn(), configurable: true },
    });
    exportBlob = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["png"], { type: "image/png" })));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("bounds the backing/export resolution, maps scaled pen input and exports a PNG Blob", async () => {
    await render();
    await load();
    expect([canvas().width, canvas().height]).toEqual([2048, 1024]);
    expect(host.textContent).toContain("optimized to 2048 × 1024");
    await stroke();
    expect(context.moveTo).toHaveBeenCalledWith(204.8, 102.4);
    expect(context.lineTo).toHaveBeenCalledWith(1843.2, 921.6);
    await click("Save markup");
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(save.mock.calls[0][0].type).toBe("image/png");
    expect(exportBlob).toHaveBeenCalledWith(expect.any(Function), "image/png");
    expect(savingChanged.mock.calls).toEqual([[true], [false]]);
  });

  it("freezes the source frame once, reuses the bounded base, and releases both backing stores on close", async () => {
    await render(); await load();
    const image = images[0];
    const editor = canvas();
    const base = context.drawImage.mock.calls[1][0] as HTMLCanvasElement;
    expect(base).toBeInstanceOf(HTMLCanvasElement);
    expect(base).not.toBe(editor);
    expect([base.width, base.height]).toEqual([2048, 1024]);
    expect(image.hasAttribute("src")).toBe(false);
    expect(image.onload).toBeNull();
    context.drawImage.mockClear();
    await stroke();
    await click("Undo");
    await act(async () => paint());
    await click("Save markup");
    expect(context.drawImage.mock.calls.length).toBeGreaterThan(0);
    expect(context.drawImage.mock.calls.every(([source]) => source === base)).toBe(true);
    await act(async () => root.render(null));
    expect([base.width, base.height, editor.width, editor.height]).toEqual([1, 1, 1, 1]);
  });

  it("draws an arrow with its two head segments, then Undo and Clear remove complete gestures", async () => {
    await render(); await load(200, 100);
    await click("Arrow");
    expect(button("Arrow").getAttribute("aria-pressed")).toBe("true");
    await stroke();
    expect(context.lineTo).toHaveBeenCalledTimes(3);
    expect(context.lineTo.mock.calls[0]).toEqual([180, 90]);
    await click("Undo");
    context.stroke.mockClear();
    await act(async () => paint());
    expect(context.stroke).not.toHaveBeenCalled();
    await click("Pen"); await stroke();
    await click("Clear drawing");
    context.stroke.mockClear();
    await act(async () => paint());
    expect(context.stroke).not.toHaveBeenCalled();
    expect(button("Undo").disabled).toBe(true);
  });

  it("ignores a second pointer and discards a cancelled gesture", async () => {
    await render(); await load(200, 100);
    await act(async () => {
      pointer("pointerdown", 10, 10, 1, "touch");
      pointer("pointerdown", 90, 90, 2, "touch");
      pointer("pointermove", 80, 80, 2, "touch");
      pointer("pointerup", 80, 80, 2, "touch");
      pointer("pointermove", 30, 30, 1, "touch");
      paint();
    });
    expect(context.lineTo.mock.calls).toEqual([[30, 30]]);
    await act(async () => { pointer("pointercancel", 30, 30, 1, "touch"); paint(); });
    expect(button("Undo").disabled).toBe(true);
    await click("Save markup");
    expect(save).toHaveBeenCalledOnce();
  });

  it("coalesces many pointer updates into one frame and bounds the stored gesture", async () => {
    await render(); await load(200, 100);
    context.drawImage.mockClear(); context.lineTo.mockClear();
    await act(async () => {
      pointer("pointerdown", 0, 0);
      const framesAfterStart = frames.size;
      for (let i = 0; i < 2000; i += 1) pointer("pointermove", i % 200, i % 100);
      expect(frames.size).toBe(framesAfterStart);
      expect(context.drawImage).not.toHaveBeenCalled();
      pointer("pointerup", 199, 99);
      paint();
    });
    expect(context.drawImage).toHaveBeenCalledOnce();
    expect(context.lineTo.mock.calls.length).toBeLessThanOrEqual(512);
    expect(context.lineTo).toHaveBeenLastCalledWith(199, 99);
  });

  it("bounds stroke history and allows drawing again after Undo", async () => {
    await render(); await load(200, 100);
    await act(async () => {
      for (let i = 0; i < 70; i += 1) {
        pointer("pointerdown", i, i);
        pointer("pointerup", i + 1, i + 1);
      }
      paint();
    });
    expect(context.stroke).toHaveBeenCalledTimes(64);
    expect(host.textContent).toContain("Drawing limit reached");
    await click("Undo");
    expect(host.textContent).not.toContain("Drawing limit reached");
    await stroke();
    expect(host.textContent).toContain("Drawing limit reached");
  });

  it("retains edits and exposes an error when save fails; disables mutations until retry is possible", async () => {
    let rejectSave!: (reason: Error) => void;
    save.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectSave = reject; }));
    await render(); await load(200, 100); await stroke();
    await click("Save markup");
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(Array.from(host.querySelectorAll("button")).every((item) => item.disabled)).toBe(true);
    await act(async () => { pointer("pointerdown", 30, 30); pointer("pointerup", 50, 50); });
    await act(async () => rejectSave(new Error("Attachment changed.")));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Attachment changed.");
    expect(button("Undo").disabled).toBe(false);
    context.stroke.mockClear();
    await click("Save markup");
    expect(context.stroke).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledTimes(2);
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it("reports a failed PNG export without discarding drawing, and Cancel never exports", async () => {
    await render(); await load(); await stroke();
    exportBlob.mockImplementationOnce((callback: BlobCallback) => callback(null));
    await click("Save markup");
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("PNG export failed");
    expect(save).not.toHaveBeenCalled();
    expect(button("Undo").disabled).toBe(false);
    await click("Cancel");
    expect(cancel).toHaveBeenCalledOnce();
    expect(exportBlob).toHaveBeenCalledOnce();
  });

  it("shrinks an oversized PNG on a temporary canvas without changing the editor or losing strokes", async () => {
    await render(); await load(); await stroke();
    const large = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" });
    exportBlob.mockImplementationOnce((callback: BlobCallback) => callback(large));
    save.mockRejectedValueOnce(new Error("Try again"));
    context.drawImage.mockClear();
    await click("Save markup");
    expect(exportBlob).toHaveBeenCalledTimes(2);
    expect(context.drawImage).toHaveBeenCalledWith(canvas(), 0, 0, 1536, 768);
    expect([canvas().width, canvas().height]).toEqual([2048, 1024]);
    expect(host.textContent).toContain("optimized to 1536 × 768");
    expect(button("Undo").disabled).toBe(false);
    expect(save.mock.calls[0][0].size).toBeLessThanOrEqual(5 * 1024 * 1024);
  });

  it.each([4, 9])("honors a %i MiB consumer budget without exceeding the 5 MiB shared limit", async (megabytes) => {
    const expectedLimit = Math.min(megabytes, 5) * 1024 * 1024;
    await render({ maxExportBytes: megabytes * 1024 * 1024 }); await load(200, 100);
    expect(host.textContent).toContain(`${Math.min(megabytes, 5)} MB`);
    exportBlob.mockImplementationOnce((callback: BlobCallback) => callback(new Blob([new Uint8Array(expectedLimit + 1)], { type: "image/png" })));
    await click("Save markup");
    expect(exportBlob).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][0].size).toBeLessThanOrEqual(expectedLimit);
  });

  it("bounds failed size optimization and keeps the original drawing available", async () => {
    await render(); await load(); await stroke();
    const large = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: "image/png" });
    exportBlob.mockImplementation((callback: BlobCallback) => callback(large));
    await click("Save markup");
    expect(exportBlob).toHaveBeenCalledTimes(8);
    expect(save).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("5 MB image limit");
    expect([canvas().width, canvas().height]).toEqual([2048, 1024]);
    expect(button("Undo").disabled).toBe(false);
  });

  it("never delivers an old asynchronous export after a source change", async () => {
    let finishExport!: BlobCallback;
    exportBlob.mockImplementationOnce((callback: BlobCallback) => { finishExport = callback; });
    await render(); await load(); await stroke(); await click("Save markup");
    await render({ src: "blob:second" }); await load(100, 100);
    await act(async () => finishExport(new Blob(["old"], { type: "image/png" })));
    expect(save).not.toHaveBeenCalled();
    expect(button("Undo").disabled).toBe(true);
    expect(savingChanged).toHaveBeenLastCalledWith(false);
    await click("Save markup");
    expect(save).toHaveBeenCalledOnce();
  });

  it.each(["source change", "close and reopen", "unmount"])("discards pending bug-report data URL conversion after %s", async (transition) => {
    const readDataUrl = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(() => undefined);
    const onOpenChange = vi.fn();
    const modal = (src = "blob:screenshot", isOpen = true) => <BugReportScreenshotModal isOpen={isOpen} src={src} alt="Screenshot" editable onSave={save} onOpenChange={onOpenChange} />;
    await act(async () => root.render(modal()));
    await load(200, 100); await click("Save markup");
    const reader = readDataUrl.mock.contexts[0] as FileReader;
    expect(reader).toBeDefined();
    if (transition === "source change") {
      await act(async () => root.render(modal("blob:other")));
    } else if (transition === "close and reopen") {
      await act(async () => root.render(modal("blob:screenshot", false)));
      await act(async () => root.render(modal()));
    } else {
      await act(async () => root.render(null));
    }
    Object.defineProperty(reader, "result", { value: "data:image/png;base64,cG5n" });
    await act(async () => reader.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>));
    expect(save).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("preserves bug-report data URL save and close behavior through the shared editor", async () => {
    const onOpenChange = vi.fn();
    await act(async () => root.render(<BugReportScreenshotModal isOpen src="blob:screenshot" alt="Screenshot" editable onSave={save} onOpenChange={onOpenChange} />));
    await load(200, 100);
    expect(host.querySelector('[data-testid="bug-report-screenshot-annotator"]')).not.toBeNull();
    expect(canvas().dataset.testid).toBe("bug-report-screenshot-canvas");
    expect(host.textContent).toContain("4 MB");
    exportBlob.mockImplementationOnce((callback: BlobCallback) => callback(new Blob([new Uint8Array(4 * 1024 * 1024 + 1)], { type: "image/png" })));
    await stroke(); await click("Save markup");
    await act(async () => { await vi.waitFor(() => expect(save).toHaveBeenCalledWith("data:image/png;base64,cG5n")); });
    expect(exportBlob).toHaveBeenCalledTimes(2);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
