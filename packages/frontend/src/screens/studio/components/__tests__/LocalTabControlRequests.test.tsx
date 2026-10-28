// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalTabControlRequests } from "../LocalTabControlRequests";

describe("LocalTabControlRequests", () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: ComponentProps<typeof LocalTabControlRequests>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    props = {
      people: [{ userId: "alice", fullName: "Alice", email: "alice@example.test" }, { userId: "bob", fullName: "Bob", email: "bob@example.test" }],
      state: { type: "controlState", available: true, connectionId: "owner", requested: false, grant: null,
        requests: [{ userId: "bob", connectionId: "bob-tab" }, { userId: "alice", connectionId: "alice-tab" }] },
      control: { grant: vi.fn().mockResolvedValue(undefined), revoke: vi.fn().mockResolvedValue(undefined), deny: vi.fn() },
      explore: { approve: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined), deny: vi.fn() },
      exploreState: { type: "exploreState", available: true, requested: false, view: null, views: [],
        requests: [{ userId: "alice", connectionId: "alice-explore", viewport: { width: 390, height: 844, dpr: 2 } }] },
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  const render = async () => act(async () => root.render(<LocalTabControlRequests {...props} />));

  it("keeps control requests in server order and sends each action to its original recipient", async () => {
    await render();
    const grantButtons = container.querySelectorAll<HTMLButtonElement>('[data-testid="local-tab-grant-control"]');
    expect(grantButtons[0].parentElement!.textContent).toContain("Bob requests control");
    expect(grantButtons[1].parentElement!.textContent).toContain("Alice requests control");
    await act(async () => grantButtons[0].click());
    expect(props.control.grant).toHaveBeenCalledExactlyOnceWith("bob-tab");
    await act(async () => [...container.querySelectorAll<HTMLButtonElement>("button")].filter(button => button.textContent === "Decline")[1].click());
    expect(props.control.deny).toHaveBeenCalledExactlyOnceWith("alice-tab");
    await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="local-tab-allow-explore"]')!.click());
    expect(props.explore!.approve).toHaveBeenCalledExactlyOnceWith(props.exploreState!.requests![0]);
  });

  it("shows the complete failure and clears it after retry while preserving grant limits", async () => {
    const message = "The participant's connection is unavailable. Ask them to reconnect before granting control; the current browser remains yours.";
    vi.mocked(props.control.grant).mockRejectedValueOnce(new Error(message));
    await render();
    const grant = container.querySelector<HTMLButtonElement>('[data-testid="local-tab-grant-control"]')!;
    await act(async () => grant.click());
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(message);
    expect(grant.disabled).toBe(false);
    await act(async () => grant.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    props.state = { ...props.state!, grant: { id: "grant", userId: "bob", connectionId: "bob-tab" } };
    props.exploreState = { ...props.exploreState!, views: Array.from({ length: 4 }, (_, index) => ({ ...props.exploreState!.requests![0], viewId: `view-${index}` })) };
    await render();
    expect([...container.querySelectorAll<HTMLButtonElement>('[data-testid="local-tab-grant-control"]')].every(button => button.disabled)).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('[data-testid="local-tab-allow-explore"]')!.disabled).toBe(true);
  });
});
