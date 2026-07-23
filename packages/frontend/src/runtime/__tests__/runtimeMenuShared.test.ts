import { afterEach, describe, expect, it, vi } from "vitest";

import { writeClipboardText } from "../runtimeMenuShared";

describe("writeClipboardText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("falls back to document copy when navigator clipboard write is denied", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("Write permission denied.");
    });
    vi.stubGlobal("navigator", {
      clipboard: { writeText },
    });

    const focus = vi.fn();
    const select = vi.fn();
    const appendChild = vi.fn();
    const removeChild = vi.fn();
    const execCommand = vi.fn(() => true);
    const textarea = {
      value: "",
      style: {},
      focus,
      select,
    };

    vi.stubGlobal("document", {
      createElement: vi.fn(() => textarea),
      body: {
        appendChild,
        removeChild,
      },
      execCommand,
    });

    await expect(writeClipboardText("hello")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(appendChild).toHaveBeenCalledWith(textarea);
    expect(removeChild).toHaveBeenCalledWith(textarea);
    expect(focus).toHaveBeenCalled();
    expect(select).toHaveBeenCalled();
  });
});
