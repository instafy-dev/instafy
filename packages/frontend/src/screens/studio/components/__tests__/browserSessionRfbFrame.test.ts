import { describe, expect, it, vi } from "vitest";
import { observeBrowserRfbFrames } from "../browserSessionRfbFrame";

function viewer() {
  return {
    _FBU: { encoding: 0 as number | null },
    _display: { flush: vi.fn(async (): Promise<void> => undefined) },
    _handleRect: vi.fn(() => true),
    _framebufferUpdate() { return this._handleRect(); },
  };
}

describe("RFB painted frame observation", () => {
  it("waits for queued pixel decoding to flush, not protocol or size announcements", async () => {
    const rfb = viewer();
    const paint = vi.fn();
    let finish!: () => void;
    rfb._display.flush.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    observeBrowserRfbFrames(rfb, paint, () => "page-1");
    rfb._FBU.encoding = -223;
    rfb._framebufferUpdate();
    expect(rfb._display.flush).not.toHaveBeenCalled();
    rfb._FBU.encoding = 7;
    rfb._framebufferUpdate();
    expect(paint).not.toHaveBeenCalled();
    finish();
    await Promise.resolve();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it("waits for the full update and does not count partially decoded rectangles", async () => {
    const rfb = viewer();
    rfb._handleRect.mockReturnValueOnce(false);
    const paint = vi.fn();
    observeBrowserRfbFrames(rfb, paint, () => "page-1");
    expect(rfb._framebufferUpdate()).toBe(false);
    await Promise.resolve();
    expect(paint).not.toHaveBeenCalled();
    expect(rfb._framebufferUpdate()).toBe(true);
    await Promise.resolve();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it("recognizes TightPNG pixels despite their negative encoding number", async () => {
    const rfb = viewer();
    rfb._FBU.encoding = -260;
    const paint = vi.fn();
    observeBrowserRfbFrames(rfb, paint, () => "page-1");
    rfb._framebufferUpdate();
    await Promise.resolve();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it("does not mistake a positive VMware cursor announcement for page pixels", async () => {
    const rfb = viewer();
    rfb._FBU.encoding = 0x574d5664;
    const paint = vi.fn();
    observeBrowserRfbFrames(rfb, paint, () => "page-1");
    rfb._framebufferUpdate();
    await Promise.resolve();
    expect(rfb._display.flush).not.toHaveBeenCalled();
    expect(paint).not.toHaveBeenCalled();
  });

  it("restores noVNC methods and ignores a disposed connection's late decode", async () => {
    const rfb = viewer();
    const original = { update: rfb._framebufferUpdate, rect: rfb._handleRect };
    const paint = vi.fn();
    const dispose = observeBrowserRfbFrames(rfb, paint, () => "page-1")!;
    rfb._framebufferUpdate();
    dispose();
    await Promise.resolve();
    expect(paint).not.toHaveBeenCalled();
    expect(rfb._framebufferUpdate).toBe(original.update);
    expect(rfb._handleRect).toBe(original.rect);
  });

  it.each(["page-2:epoch-0", "page-1:epoch-1"])("ignores a pending decode after scope invalidation to %s", async nextScope => {
    const rfb = viewer();
    const paint = vi.fn();
    let scope = "page-1:epoch-0";
    let finish!: () => void;
    rfb._display.flush.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    observeBrowserRfbFrames(rfb, paint, () => scope);
    rfb._framebufferUpdate();
    scope = nextScope;
    finish();
    await Promise.resolve();
    expect(paint).not.toHaveBeenCalled();
    rfb._framebufferUpdate();
    finish();
    await Promise.resolve();
    expect(paint).toHaveBeenCalledTimes(1);
  });

  it("leaves unsupported viewer internals alone", () => {
    expect(observeBrowserRfbFrames({}, vi.fn(), () => "page-1")).toBeNull();
    expect(observeBrowserRfbFrames(null, vi.fn(), () => "page-1")).toBeNull();
  });
});
