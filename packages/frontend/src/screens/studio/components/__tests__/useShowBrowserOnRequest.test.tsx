// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShowBrowserOnRequest } from "../useShowBrowserOnRequest";

describe("useShowBrowserOnRequest", () => {
  let container: HTMLDivElement;
  let root: Root;

  function Harness({ open, token, show }: { open: boolean; token: number; show: () => void }) {
    useShowBrowserOnRequest(open, token, show);
    return null;
  }

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

  // Local drive, Oct 29: a card Studio opened by itself switched to the
  // Browser view. Only a press does now; Studio's own open stays in Chat.
  it("shows the browser once per request, and never for an open nobody asked to see", async () => {
    const show = vi.fn();
    const render = (open: boolean, token: number) => act(async () => root.render(<Harness open={open} token={token} show={show} />));
    // A press asks to show it: shown once the browser is open.
    await render(false, 1);
    expect(show).not.toHaveBeenCalled();
    await render(true, 1);
    expect(show).toHaveBeenCalledTimes(1);
    // The browser closes, and Studio opens it again by itself: no request.
    await render(false, 1);
    await render(true, 1);
    expect(show).toHaveBeenCalledTimes(1);
    // The next press shows it again.
    await render(true, 2);
    expect(show).toHaveBeenCalledTimes(2);
  });
});
