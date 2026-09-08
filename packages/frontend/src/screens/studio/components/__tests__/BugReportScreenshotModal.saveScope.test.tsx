// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BugReportScreenshotModal } from "../BugReportScreenshotModal";

vi.mock("../ImageMarkupEditor", () => ({
  ImageMarkupEditor: ({ src, onSave }: { src: string; onSave: (blob: Blob) => Promise<void> }) => (
    <button data-testid="save-markup" data-source={src} onClick={() => { void onSave(new Blob(["png"], { type: "image/png" })); }}>
      Save markup
    </button>
  ),
}));

describe("bug-report screenshot save scope", () => {
  let host: HTMLDivElement;
  let root: Root;
  let setSource: (src: string) => void;
  let setOpen: (open: boolean) => void;
  const close = vi.fn();
  const saved = vi.fn();
  const dataUrl = "data:image/png;base64,cG5n";

  function Harness({ afterSave }: { afterSave?: () => Promise<void> }) {
    const [src, updateSource] = useState("blob:original");
    const [open, updateOpen] = useState(true);
    setSource = updateSource;
    setOpen = updateOpen;
    return <BugReportScreenshotModal isOpen={open} src={src} alt="Screenshot" editable
      onOpenChange={(next) => { close(next); updateOpen(next); }}
      onSave={async (next) => {
        saved(next);
        updateSource(next);
        await afterSave?.();
      }} />;
  }

  async function startSave(afterSave?: () => Promise<void>) {
    await act(async () => root.render(<Harness afterSave={afterSave} />));
    await act(async () => host.querySelector<HTMLButtonElement>("[data-testid=save-markup]")!.click());
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("closes after the parent saves markup by updating the selected screenshot source", async () => {
    await startSave();
    await act(async () => { await vi.waitFor(() => expect(saved).toHaveBeenCalledWith(dataUrl)); });
    expect(close).toHaveBeenCalledExactlyOnceWith(false);
    expect(host.querySelector("[data-testid=save-markup]")).toBeNull();
  });

  it("closes after an accepted parent save updates the source before its promise resolves", async () => {
    let finishSave!: () => void;
    const completion = new Promise<void>((resolve) => { finishSave = resolve; });
    await startSave(() => completion);
    await act(async () => { await vi.waitFor(() => expect(saved).toHaveBeenCalledWith(dataUrl)); });
    expect(host.querySelector("[data-testid=save-markup]")?.getAttribute("data-source")).toBe(dataUrl);
    expect(close).not.toHaveBeenCalled();
    await act(async () => finishSave());
    expect(close).toHaveBeenCalledExactlyOnceWith(false);
    expect(host.querySelector("[data-testid=save-markup]")).toBeNull();
  });

  it("does not save or close a different screenshot when conversion finishes late", async () => {
    const read = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(() => undefined);
    await startSave();
    const reader = read.mock.contexts[0] as FileReader;
    await act(async () => setSource("blob:unrelated"));
    Object.defineProperty(reader, "result", { value: dataUrl });
    await act(async () => reader.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>));
    expect(saved).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid=save-markup]")?.getAttribute("data-source")).toBe("blob:unrelated");
  });

  it("does not close a different screenshot selected during an accepted asynchronous save", async () => {
    let finishSave!: () => void;
    const completion = new Promise<void>((resolve) => { finishSave = resolve; });
    await startSave(() => completion);
    await act(async () => { await vi.waitFor(() => expect(saved).toHaveBeenCalledWith(dataUrl)); });
    await act(async () => setSource("blob:unrelated"));
    await act(async () => finishSave());
    expect(close).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid=save-markup]")?.getAttribute("data-source")).toBe("blob:unrelated");
  });

  it("does not close a new modal session even when it reopens the accepted screenshot", async () => {
    let finishSave!: () => void;
    const completion = new Promise<void>((resolve) => { finishSave = resolve; });
    await startSave(() => completion);
    await act(async () => { await vi.waitFor(() => expect(saved).toHaveBeenCalledWith(dataUrl)); });
    await act(async () => setOpen(false));
    await act(async () => setOpen(true));
    await act(async () => finishSave());
    expect(close).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid=save-markup]")?.getAttribute("data-source")).toBe(dataUrl);
  });
});
