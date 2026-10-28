// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSessionRecovery, BrowserSessionReconnecting, type BrowserSessionRecoveryProps } from "../BrowserSessionRecovery";
import { hostedBrowserViewState } from "../hostedBrowserViewState";
import { RUNTIME_DEBUG_STORAGE_KEY } from "../../../../runtime/utils/runtimeDebug";

describe("browser recovery presentation", () => {
  let container: HTMLDivElement;
  let root: Root;
  const retry = vi.fn();
  const hide = vi.fn();
  const takeOver = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    retry.mockReset(); hide.mockReset(); takeOver.mockReset();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem(RUNTIME_DEBUG_STORAGE_KEY);
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  async function render(overrides: Partial<BrowserSessionRecoveryProps> = {}) {
    await act(async () => root.render(<BrowserSessionRecovery
      viewState={hostedBrowserViewState({ status: "error", hasConnection: false, failure: { kind: "off", reason: "host stopped" } })}
      reason="host stopped" onRetry={retry} {...overrides} />));
  }
  const button = (name: string) => Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(node => node.textContent === name);

  it.each(["overlay", "compact"] as const)("keeps one Off sentence and its explicit open action in %s", async presentation => {
    await render({ presentation, onHide: hide });
    const sentences = container.querySelectorAll('[data-testid="browser-session-view-sentence"]');
    expect(sentences).toHaveLength(1);
    expect(sentences[0].textContent).toBe("Instafy's browser is off.");
    expect(container.querySelector("details")).toBeNull();
    expect(container.textContent).not.toContain("host stopped");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button("Open browser")!.click());
    expect(retry).toHaveBeenCalledOnce();
    if (presentation === "compact") {
      await act(async () => button("Hide")!.click());
      expect(hide).toHaveBeenCalledOnce();
    } else expect(button("Hide")).toBeUndefined();
  });

  it("keeps blocked states free of a retry and technical reasons debug-only", async () => {
    await render({ viewState: { kind: "blocked", sentence: "Ask a space manager to enable browsing.", action: null } });
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-debug-reason]')?.getAttribute("data-debug-reason")).toBe("host stopped");
    expect(container.querySelector("details")).toBeNull();
    window.localStorage.setItem(RUNTIME_DEBUG_STORAGE_KEY, "1");
    await render();
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")?.textContent).toBe("Technical details");
    expect(details.textContent).toContain("host stopped");
  });

  it.each(["overlay", "compact"] as const)("preserves runtime-limit consent and busy actions in %s", async presentation => {
    const runtimeLimit = { summary: "All 2 Instafy Cloud runtimes for this team are in use.",
      blockerProjectCopy: "“Team research machine” is running in “Long-running research space”.", busy: false, onTakeOver: takeOver };
    await render({ presentation, runtimeLimit });
    expect(takeOver).not.toHaveBeenCalled();
    expect(container.textContent).toContain(runtimeLimit.blockerProjectCopy);
    expect(container.textContent).toContain("This can interrupt work running there.");
    await act(async () => button("Stop and open here")!.click());
    expect(takeOver).toHaveBeenCalledOnce();
    await act(async () => button("Try again")!.click());
    expect(retry).toHaveBeenCalledOnce();
    await render({ presentation, runtimeLimit: { ...runtimeLimit, busy: true } });
    expect(button("Opening here...")?.disabled).toBe(true);
    expect(button("Try again")?.disabled).toBe(true);
    await act(async () => { button("Opening here...")!.click(); button("Try again")!.click(); });
    expect(takeOver).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });

  it("offers only retry when no runtime takeover is available", async () => {
    await render({ runtimeLimit: { summary: "All Instafy Cloud runtime slots are in use.", busy: false } });
    expect(button("Stop and open here")).toBeUndefined();
    expect(container.textContent).toContain("Stop another cloud runtime, then try again.");
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });

  it("announces opening and reconnecting once without enabling a recovery action", async () => {
    await render({ reason: null, viewState: { kind: "opening", sentence: "Opening Instafy's browser…", action: null } });
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Opening Instafy's browser…");
    expect(container.querySelector("button")).toBeNull();
    await act(async () => root.render(<BrowserSessionReconnecting />));
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Reconnecting…");
    expect(container.querySelector("button")).toBeNull();
  });
});
