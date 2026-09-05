// @vitest-environment jsdom

import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("native OTA app-shell readiness", () => {
  let container: HTMLDivElement;
  let root: Root;
  let readiness: typeof import("../appReady");
  let NativeOtaAppReady: typeof import("../NativeOtaAppReady").NativeOtaAppReady;
  const acknowledged = vi.fn();

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.clearAllMocks();
    readiness = await import("../appReady");
    ({ NativeOtaAppReady } = await import("../NativeOtaAppReady"));
    void readiness.waitForNativeOtaAppMounted().then(acknowledged);
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("does not acknowledge module loading, then acknowledges only once after a StrictMode shell commit", async () => {
    await Promise.resolve();
    expect(acknowledged).not.toHaveBeenCalled();
    await act(async () => root.render(<StrictMode><p>Signing in…</p><NativeOtaAppReady /></StrictMode>));
    expect(container.textContent).toBe("Signing in…");
    expect(acknowledged).not.toHaveBeenCalled();
    await act(async () => vi.runAllTimersAsync());
    expect(acknowledged).toHaveBeenCalledTimes(1);
    readiness.markNativeOtaAppMounted();
    await readiness.waitForNativeOtaAppMounted();
    expect(acknowledged).toHaveBeenCalledTimes(1);
  });

  it("cancels acknowledgment when the shell unmounts before the commit settles", async () => {
    await act(async () => root.render(<NativeOtaAppReady />));
    await act(async () => root.render(null));
    await act(async () => vi.runAllTimersAsync());
    expect(acknowledged).not.toHaveBeenCalled();
  });

  it.each(["render", "effect"])("does not acknowledge the router error fallback after an initial %s error", async (phase) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function BrokenRoute() {
      useEffect(() => {
        if (phase === "effect") throw new Error("initial commit failed");
      }, []);
      if (phase === "render") throw new Error("initial render failed");
      return <p>Broken route</p>;
    }
    const router = createMemoryRouter([{
      path: "/",
      element: <><Outlet /><NativeOtaAppReady /></>,
      errorElement: <p>Route error</p>,
      children: [{ index: true, element: <BrokenRoute /> }],
    }]);
    await act(async () => root.render(<RouterProvider router={router} />));
    expect(container.textContent).toBe("Route error");
    await act(async () => vi.runAllTimersAsync());
    expect(acknowledged).not.toHaveBeenCalled();
    router.dispose();
  });
});
