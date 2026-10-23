// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreparedEmailInviteNotice } from "../PreparedEmailInviteNotice";

const mocks = vi.hoisted(() => ({ copy: vi.fn(), share: vi.fn(), status: vi.fn() }));
vi.mock("../../../../runtime/runtimeMenuShared", () => ({ writeClipboardText: mocks.copy }));
vi.mock("../../../../status/useStatus", () => ({ useStatus: () => ({ showStatus: mocks.status }) }));
vi.mock("../../../../sharing/nearbyInviteShare", () => ({
  canUseNearbyInviteShare: () => true,
  isNearbyInviteShareDismissalError: () => false,
  shareNearbyInvite: mocks.share,
}));

describe("PreparedEmailInviteNotice", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<PreparedEmailInviteNotice testIdPrefix="invite" invite={{
      acceptUrl: "https://example.test/invite/inert", email: "alexandria@example.test", role: "builder",
    }} />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each(["copy", "share"] as const)("preserves focus and blocks duplicate %s requests while pending", async (action) => {
    let resolve!: () => void;
    mocks[action].mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="invite-${action}"]`)!;
    button.focus();
    await act(async () => button.click());
    expect(document.activeElement).toBe(button);
    await act(async () => button.click());
    expect(mocks[action]).toHaveBeenCalledOnce();
    await act(async () => resolve());
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Instafy has not sent an email.");
  });

  it("reports a failed copy and allows retry", async () => {
    mocks.copy.mockRejectedValueOnce(new Error("Clipboard unavailable.")).mockResolvedValueOnce(undefined);
    const copy = container.querySelector<HTMLButtonElement>('[data-testid="invite-copy"]')!;
    await act(async () => copy.click());
    expect(mocks.status).toHaveBeenCalledWith("Clipboard unavailable.", "error", 3500);
    await act(async () => copy.click());
    expect(mocks.copy).toHaveBeenCalledTimes(2);
  });
});
