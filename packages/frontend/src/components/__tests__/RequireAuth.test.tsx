// @vitest-environment jsdom

import { act, lazy, Suspense, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequireAuth } from "../RequireAuth";

const auth = vi.hoisted(() => ({ loading: true, user: null as { id: string } | null }));
const loadProtectedPage = vi.fn(async () => ({ default: () => <p>Private workspace</p> }));

vi.mock("../../providers/AuthProvider", () => ({ useAuth: () => auth }));

function LoginDestination() {
  const location = useLocation();
  return <div data-testid="login-destination">{location.pathname}{location.search}</div>;
}

describe("RequireAuth entry handoff", () => {
  let container: HTMLDivElement;
  let root: Root;
  let ProtectedPage: ComponentType;

  const render = async () => {
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/studio?projectId=project-1&from=landing"]}>
          <Routes>
            <Route path="/studio" element={
              <RequireAuth>
                <Suspense fallback={<p>Loading protected bundle</p>}><ProtectedPage /></Suspense>
              </RequireAuth>
            } />
            <Route path="/login" element={<LoginDestination />} />
          </Routes>
        </MemoryRouter>,
      );
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    auth.loading = true;
    auth.user = null;
    loadProtectedPage.mockClear();
    ProtectedPage = lazy(loadProtectedPage);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("shows one polite handoff with a swimming Octo while withholding private content and premature redirects", async () => {
    await render();

    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(container.textContent).toContain("Getting things ready…");
    expect(container.textContent).not.toContain("Instafy");
    expect(container.textContent).not.toContain("Private workspace");
    expect(container.querySelector('[data-testid="login-destination"]')).toBeNull();
    expect(loadProtectedPage).not.toHaveBeenCalled();
    expect(container.querySelector('[data-octo-motion="thinking"]')?.getAttribute("data-octo-animated"))
      .toBe("true");
    expect(container.querySelector('animate[data-octo-animation="tentacle"]')).not.toBeNull();
  });

  it("respects reduced-motion changes during loading and releases its listener when the session is ready", async () => {
    let reducedMotion = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
    }));
    await render();

    expect(container.querySelector('[data-octo-motion="thinking"]')?.getAttribute("data-octo-animated"))
      .toBe("false");
    expect(container.querySelector("animate, animateTransform")).toBeNull();
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(loadProtectedPage).not.toHaveBeenCalled();
    expect(listeners.size).toBe(1);

    await act(async () => {
      reducedMotion = false;
      listeners.forEach((listener) => listener());
    });
    expect(container.querySelector('[data-octo-animated="true"]')).not.toBeNull();
    expect(container.querySelector("animate, animateTransform")).not.toBeNull();

    await act(async () => {
      reducedMotion = true;
      listeners.forEach((listener) => listener());
    });
    expect(container.querySelector('[data-octo-animated="true"]')).toBeNull();
    expect(container.querySelector("animate, animateTransform")).toBeNull();
    expect(loadProtectedPage).not.toHaveBeenCalled();

    auth.loading = false;
    auth.user = { id: "user-1" };
    await render();
    expect(container.textContent).toBe("Private workspace");
    expect(container.querySelector('[data-testid="entry-loading-screen"]')).toBeNull();
    expect(listeners.size).toBe(0);
  });

  it("opens protected content when the restored session is ready", async () => {
    await render();
    auth.loading = false;
    auth.user = { id: "user-1" };
    await render();

    expect(container.textContent).toBe("Private workspace");
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.querySelector('[data-testid="login-destination"]')).toBeNull();
    expect(loadProtectedPage).toHaveBeenCalledTimes(1);
  });

  it("retains the complete requested destination when a signed-out session resolves", async () => {
    await render();
    auth.loading = false;
    await render();

    const destination = container.querySelector('[data-testid="login-destination"]')?.textContent ?? "";
    expect(destination.startsWith("/login?")).toBe(true);
    expect(new URLSearchParams(destination.split("?")[1]).get("redirect"))
      .toBe("/studio?projectId=project-1&from=landing");
    expect(container.textContent).not.toContain("Private workspace");
    expect(container.querySelector('[data-testid="entry-loading-screen"]')).toBeNull();
    expect(loadProtectedPage).not.toHaveBeenCalled();
  });
});
