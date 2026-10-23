// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsNudgeBubble } from "../NotificationsNudgeBubble";

describe("NotificationsNudgeBubble", () => {
  let root: Root;
  let container: HTMLDivElement;

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

  it("keeps the pending action focused, blocks duplicate requests and announces success", async () => {
    let resolve!: (enabled: boolean) => void;
    const onEnable = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const onDismiss = vi.fn();
    await act(async () => root.render(<NotificationsNudgeBubble onEnable={onEnable} onDismiss={onDismiss} />));
    const [enable, dismiss] = [...container.querySelectorAll("button")];
    enable.focus();
    await act(async () => enable.click());
    expect(document.activeElement).toBe(enable);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Requesting permission…");
    await act(async () => { enable.click(); dismiss.click(); });
    expect(onEnable).toHaveBeenCalledOnce();
    expect(onDismiss).not.toHaveBeenCalled();
    await act(async () => resolve(true));
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Notifications enabled.");
    expect(container.querySelector("button")).toBeNull();
  });

  it("announces a rejected request and lets the user retry or dismiss", async () => {
    const onEnable = vi.fn().mockRejectedValueOnce(new Error("Permission request failed.")).mockResolvedValue(false);
    const onDismiss = vi.fn();
    await act(async () => root.render(<NotificationsNudgeBubble onEnable={onEnable} onDismiss={onDismiss} />));
    const [enable, dismiss] = [...container.querySelectorAll("button")];
    await act(async () => enable.click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Permission request failed.");
    await act(async () => enable.click());
    expect(onEnable).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Notifications were not enabled.");
    await act(async () => dismiss.click());
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
