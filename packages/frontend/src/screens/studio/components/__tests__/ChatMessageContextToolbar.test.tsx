// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatMessageContextToolbar } from "../ChatMessageContextToolbar";
import { StudioSearchReturnProvider } from "../StudioSearchReturnContext";

const layout = vi.hoisted(() => ({ isLargeScreen: true }));
vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => layout.isLargeScreen }));

describe("message context navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  const returnToResults = vi.fn();
  const render = async (originToken: string | null) => {
    await act(async () => root.render(<StudioSearchReturnProvider value={{ originToken, returnToResults }}>
      <ChatMessageContextToolbar />
    </StudioSearchReturnProvider>));
  };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
    layout.isLargeScreen = true;
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("omits the toolbar entirely without a saved search origin", async () => {
    await render(null);
    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
    expect(returnToResults).not.toHaveBeenCalled();
  });

  it("leaves compact search return to the top navigation without a duplicate row", async () => {
    layout.isLargeScreen = false;
    await render("owned-checkpoint");
    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps desktop Back to results independent of the message target, without status or latest controls", async () => {
    await render("owned-checkpoint");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-message-return-latest"]')).toBeNull();
    expect(container.querySelectorAll("button")).toHaveLength(1);
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-back-to-search-results"]')!.click());
    expect(returnToResults).toHaveBeenCalledOnce();
    await render(null);
    expect(container.textContent).toBe("");
  });
});
