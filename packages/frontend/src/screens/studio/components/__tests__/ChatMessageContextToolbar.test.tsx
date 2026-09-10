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
  const returnToLatest = vi.fn();
  const render = async (originToken: string | null, messageTargetActive = true) => {
    await act(async () => root.render(<StudioSearchReturnProvider value={{ originToken, returnToResults }}>
      <ChatMessageContextToolbar messageTargetActive={messageTargetActive} findingMessage={false}
        canReturnToLatest onReturnToLatest={returnToLatest} />
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

  it("labels a direct message link accurately without inventing a search origin", async () => {
    await render(null);
    expect(container.querySelector('[data-testid="chat-message-context"]')?.textContent).toBe("Earlier message");
    expect(container.querySelector('[data-testid="chat-back-to-search-results"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-message-return-latest"]')!.click());
    expect(returnToLatest).toHaveBeenCalledOnce();
    expect(returnToResults).not.toHaveBeenCalled();
  });

  it("leaves search return to the compact header and removes the toolbar at latest", async () => {
    layout.isLargeScreen = false;
    await render("owned-checkpoint");
    expect(container.querySelector('[data-testid="chat-back-to-search-results"]')).toBeNull();
    expect(container.querySelector('[data-testid="chat-message-context"]')?.textContent).toBe("Search result");
    expect(container.querySelector('[data-testid="chat-message-return-latest"]')?.textContent).toBe("Jump to latest");
    await render("owned-checkpoint", false);
    expect(container.textContent).toBe("");
    layout.isLargeScreen = true;
    await render("owned-checkpoint", false);
    expect(container.querySelector('[data-testid="chat-back-to-search-results"]')).not.toBeNull();
  });

  it("keeps Back to results accessible after returning to latest history", async () => {
    await render("owned-checkpoint");
    expect(container.querySelector('[data-testid="chat-message-context"]')?.textContent).toBe("Search result");
    await render("owned-checkpoint", false);
    expect(container.querySelector('[data-testid="chat-message-return-latest"]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="chat-back-to-search-results"]')!.click());
    expect(returnToResults).toHaveBeenCalledOnce();
    await render(null, false);
    expect(container.textContent).toBe("");
  });
});
