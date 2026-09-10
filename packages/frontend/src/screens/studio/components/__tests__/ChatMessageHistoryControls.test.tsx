// @vitest-environment jsdom
import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageHistoryControls } from "../ChatMessageHistoryControls";

describe("historical message paging controls", () => {
  let container: HTMLDivElement;
  let root: Root;
  const onLoadNewer = vi.fn();
  const onReturnToLatest = vi.fn();
  const defaults = {
    messageTargetActive: true, hasNewer: true, loading: false, canReturnToLatest: true,
    onLoadNewer, onReturnToLatest,
  };
  const render = async (props: Partial<ComponentProps<typeof ChatMessageHistoryControls>> = {}) => {
    await act(async () => root.render(<ChatMessageHistoryControls {...defaults} {...props} />));
  };
  const newer = () => container.querySelector<HTMLButtonElement>('[data-testid="chat-message-load-newer"]');
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

  it("orders paging before Latest and keeps their actions distinct", async () => {
    await render();
    expect([...container.querySelectorAll("button")].map(button => button.textContent)).toEqual(["Load newer messages", "Latest"]);
    expect(latest()?.getAttribute("aria-label")).toBe("Jump to latest");
    expect(latest()?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    await act(async () => newer()!.click());
    expect(onLoadNewer).toHaveBeenCalledOnce();
    expect(onReturnToLatest).not.toHaveBeenCalled();
    await act(async () => latest()!.click());
    expect(onReturnToLatest).toHaveBeenCalledOnce();
  });

  it.each([false, true])("offers Latest even without a newer page (loading: %s)", async loading => {
    await render({ hasNewer: false, loading });
    expect(newer()).toBeNull();
    expect(latest()?.disabled).toBe(false);
    await act(async () => latest()!.click());
    expect(onReturnToLatest).toHaveBeenCalledOnce();
  });

  it("guards each action independently", async () => {
    await render({ loading: true });
    expect(newer()?.disabled).toBe(true);
    expect(latest()?.disabled).toBe(false);
    await render({ canReturnToLatest: false });
    expect(newer()?.disabled).toBe(false);
    expect(latest()?.disabled).toBe(true);
  });

  it("keeps the exit available while a newer-page request fails", async () => {
    let rejectPage: (error: Error) => void = () => {};
    const page = new Promise<void>((_, reject) => { rejectPage = reject; });
    function PagingHarness() {
      const [loading, setLoading] = useState(false);
      const [error, setError] = useState<string | null>(null);
      return <>
        {error ? <div role="alert">{error}</div> : null}
        <ChatMessageHistoryControls {...defaults} loading={loading} onLoadNewer={() => {
          setLoading(true);
          void page.catch((failure: Error) => setError(failure.message)).finally(() => setLoading(false));
        }} />
      </>;
    }
    await act(async () => root.render(<PagingHarness />));
    await act(async () => newer()!.click());
    expect(newer()?.disabled).toBe(true);
    expect(latest()?.disabled).toBe(false);
    await act(async () => { rejectPage(new Error("Newer messages could not be loaded.")); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be loaded");
    expect(newer()?.disabled).toBe(false);
    expect(latest()?.disabled).toBe(false);
    await act(async () => latest()!.click());
    expect(onReturnToLatest).toHaveBeenCalledOnce();
  });

  it("adds no historical controls to a normal latest conversation", async () => {
    await render({ messageTargetActive: false });
    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
  });
});
