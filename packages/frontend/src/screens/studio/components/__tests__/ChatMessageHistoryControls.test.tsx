// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageHistoryControls } from "../ChatMessageHistoryControls";

describe("historical message paging controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onLoadNewer = vi.fn();
  const onReturnToLatest = vi.fn();
  const defaults = {
    messageTargetActive: true, loadingNewer: false, newerError: null, canReturnToLatest: true,
    onLoadNewer, onReturnToLatest,
  };
  const render = async (props: Partial<ComponentProps<typeof ChatMessageHistoryControls>> = {}) => {
    await act(async () => root.render(<ChatMessageHistoryControls {...defaults} {...props} />));
  };
  const retry = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-message-load-newer"]');
  const latest = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-message-return-latest"]');
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps Latest while ordinary newer paging requires no button", async () => {
    await render();
    expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Latest"]);
    expect(latest()?.getAttribute("aria-label")).toBe("Jump to latest");
    expect(latest()?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => latest()!.click());
    expect(onReturnToLatest).toHaveBeenCalledOnce();
    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it("announces loading without blocking the exit to live messages", async () => {
    await render({ loadingNewer: true });
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading messages…");
    expect(retry()).toBeNull();
    expect(latest()?.disabled).toBe(false);
    await act(async () => latest()!.click());
    expect(onReturnToLatest).toHaveBeenCalledOnce();
  });

  it("offers Retry only after an error and keeps it distinct from Latest", async () => {
    await render({ newerError: "Could not load newer messages." });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not load newer messages.");
    expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Retry", "Latest"]);
    expect(retry()?.getAttribute("aria-label")).toBe("Retry loading newer messages");
    await act(async () => retry()!.click());
    expect(onLoadNewer).toHaveBeenCalledOnce();
    expect(onReturnToLatest).not.toHaveBeenCalled();
    await render({ loadingNewer: true });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(latest()?.disabled).toBe(false);
    await render();
    expect(retry()).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("keeps Latest available after loading has stopped, unless navigation is not ready", async () => {
    await render({ newerError: "Could not load newer messages." });
    expect(latest()?.disabled).toBe(false);
    await render({ canReturnToLatest: false });
    expect(latest()?.disabled).toBe(true);
    await act(async () => latest()!.click());
    expect(onReturnToLatest).not.toHaveBeenCalled();
  });

  it("adds no historical controls to a normal live conversation", async () => {
    await render({ messageTargetActive: false });
    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
  });
});
