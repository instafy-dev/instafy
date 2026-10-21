// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocationBlockedNotice, LocationMarker, locationBlockedText, LocationSitesList, LocationToast, LOCATION_BLOCKED_MS, LOCATION_TOAST_MS } from "../previewHost/PreviewLocation";
import { PersonalLocationSettings } from "../PersonalLocationSettings";
import {
  listLocationSites,
  locationSiteKey,
  recordLocationDelivery,
  resetLocationSitesForTests,
  setLocationStopped,
} from "../previewHost/locationSites";

vi.mock("../../useStudioDesktopLayout", () => ({ useStudioDesktopLayout: () => true }));

const cafes = { key: locationSiteKey({ projectId: "p1", title: "Cafés", port: 4180, path: "/" }), projectId: "p1", title: "Cafés", space: "Stockholm" };
const shoes = { key: locationSiteKey({ projectId: "p2", title: "Shoes", port: 4173, path: "/" }), projectId: "p2", title: "Shoes", space: "Running" };

describe("location in previews: marker, toast and list", () => {
  let root: Root;
  let container: HTMLDivElement;
  async function render(node: React.ReactNode) { await act(async () => root.render(node)); }
  async function click(element: Element | null) {
    expect(element).not.toBeNull();
    await act(async () => (element as HTMLElement).click());
  }
  const rows = () => [...container.querySelectorAll<HTMLElement>("[data-testid=location-site-row]")];

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear(); resetLocationSitesForTests();
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount()); container.remove(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("the marker names the site, and pulses only while it follows the person", async () => {
    await render(<LocationMarker title="Cafés" watching={false} />);
    const marker = container.querySelector<HTMLElement>("[data-testid=preview-location-marker]")!;
    expect(marker.getAttribute("role")).toBe("img");
    expect(marker.getAttribute("aria-label")).toBe("Cafés can see your location");
    expect(marker.querySelector(".motion-safe\\:animate-ping")).toBeNull();
    expect(marker.querySelector("[data-testid=preview-location-following]")).toBeNull();
    await render(<LocationMarker title="Cafés" watching />);
    expect(marker.dataset.watching).toBe("true");
    expect(marker.getAttribute("aria-label")).toBe("Cafés can see your location, following you");
    expect(marker.querySelector(".motion-safe\\:animate-ping")).not.toBeNull();
    // With reduced motion the ping is hidden; a steady ring still says it is following.
    const ring = marker.querySelector<HTMLElement>("[data-testid=preview-location-following]");
    expect(ring?.className).toContain("motion-safe:hidden");
    expect(ring?.className).not.toContain("motion-reduce:hidden");
  });

  it("the toast reads the site's name with Stop, and goes by itself", async () => {
    const onStop = vi.fn(); const onDismiss = vi.fn();
    await render(<LocationToast title="Cafés" onStop={onStop} onDismiss={onDismiss} />);
    const toast = container.querySelector("[data-testid=preview-location-toast]")!;
    expect(toast.getAttribute("role")).toBe("status");
    expect(toast.textContent).toBe("📍Cafés can see your location·Stop");
    await click(container.querySelector("[data-testid=preview-location-toast-stop]"));
    expect(onStop).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(LOCATION_TOAST_MS); });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("wraps a long site name instead of cutting it off", async () => {
    await render(<LocationToast title="Running shoes for flat feet" onStop={vi.fn()} onDismiss={vi.fn()} />);
    const toast = container.querySelector<HTMLElement>("[data-testid=preview-location-toast]")!;
    expect(toast.querySelector(".truncate")).toBeNull();
    expect(toast.querySelector(".line-clamp-2")?.textContent).toBe("Running shoes for flat feet can see your location");
  });

  it("when Instafy itself is blocked, says where to turn it on: the app's settings on desktop, the browser's on the web", async () => {
    const onDismiss = vi.fn();
    await render(<LocationBlockedNotice onDismiss={onDismiss} />);
    const text = () => container.querySelector("[data-testid=preview-location-blocked]")?.textContent ?? "";
    expect(text()).toContain("browser's site settings");
    await render(null);
    window.instafyDesktop = { notify: async () => true, locationPermissionStatus: async () => ({ state: "denied" as const }) };
    try {
      await render(<LocationBlockedNotice onDismiss={onDismiss} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(text()).toContain("Settings → Profile → Location");
      expect(text()).toContain("Location Permission… menu item");
    } finally {
      delete window.instafyDesktop;
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(LOCATION_BLOCKED_MS); });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("on desktop, points to the operating system when the app itself allows location (or macOS decides)", async () => {
    for (const state of ["granted", "system"] as const) {
      window.instafyDesktop = { notify: async () => true, locationPermissionStatus: async () => ({ state }) };
      try {
        await render(<LocationBlockedNotice onDismiss={() => undefined} />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        const text = container.querySelector("[data-testid=preview-location-blocked]")?.textContent ?? "";
        expect(text).not.toContain("Settings → Profile → Location");
        expect(text).toMatch(/blocks location for Instafy/);
      } finally {
        delete window.instafyDesktop;
      }
      await render(null);
    }
    expect(locationBlockedText("system", "MacIntel")).toContain("System Settings → Privacy & Security → Location Services");
    expect(locationBlockedText("system", "Win32")).toContain("Settings → Privacy & security → Location");
    expect(locationBlockedText("system", "Linux x86_64")).toContain("Your computer blocks location");
  });

  it("lists the sites that received location (title, space, last time) with Stop and Share again", async () => {
    vi.setSystemTime(1_000_000_000);
    recordLocationDelivery(cafes, 1_000_000_000 - 5 * 60_000);
    recordLocationDelivery(shoes, 1_000_000_000 - 2 * 3_600_000);
    await render(<LocationSitesList />);
    expect(rows().map(row => row.textContent)).toEqual([
      expect.stringContaining("CafésStockholm · Last sent 5m ago"),
      expect.stringContaining("ShoesRunning · Last sent 2h ago"),
    ]);
    await click(rows()[0].querySelector("[data-testid=location-site-stop]"));
    expect(listLocationSites().find(site => site.key === cafes.key)?.stopped).toBe(true);
    expect(rows()[0].dataset.stopped).toBe("true");
    expect(rows()[0].textContent).toContain("Stockholm · Stopped");
    await click(rows()[0].querySelector("[data-testid=location-site-allow]"));
    expect(listLocationSites().find(site => site.key === cafes.key)?.stopped).toBe(false);
    // Each row's only action is Stop (or Share again): nothing that looks like revoking but isn't.
    expect(rows().map(row => [...row.querySelectorAll("button")].map(button => button.textContent))).toEqual([["Stop"], ["Stop"]]);
  });

  it("says so when no site has received it", async () => {
    await render(<LocationSitesList />);
    expect(container.querySelector("[data-testid=location-sites-empty]")?.textContent).toContain("No site");
  });

  it("is in Studio's settings under Profile → Location", async () => {
    setLocationStopped(shoes, true);
    await render(<PersonalLocationSettings />);
    expect(container.querySelector("[data-testid=personal-location-settings]")?.textContent).toContain("Sites that can see your location");
    expect(rows().map(row => row.textContent)).toEqual([expect.stringContaining("ShoesRunning · Stopped")]);
  });

  it("shows the desktop app's own location answer with Reset, and nothing on the web", async () => {
    await render(<PersonalLocationSettings />);
    expect(container.querySelector("[data-testid=desktop-location-permission]")).toBeNull();
    await render(null);

    const reset = vi.fn(async () => ({ state: "ask" as const }));
    window.instafyDesktop = {
      notify: async () => true,
      locationPermissionStatus: async () => ({ state: "denied" as const }),
      resetLocationPermission: reset,
    };
    try {
      await render(<PersonalLocationSettings />);
      const state = () => container.querySelector("[data-testid=desktop-location-state]")?.textContent;
      expect(state()).toContain("Not allowed");
      expect(state()).toContain("Location Permission… menu item");
      await click(container.querySelector("[data-testid=desktop-location-reset]"));
      expect(reset).toHaveBeenCalledTimes(1);
      expect(state()).toContain("Not asked yet");
      // Nothing to reset before an answer, and no way to grant from Studio.
      expect(container.querySelector("[data-testid=desktop-location-reset]")).toBeNull();
    } finally {
      delete window.instafyDesktop;
    }
  });

  it("on macOS, where the system asks, says where to change it and offers no Reset", async () => {
    window.instafyDesktop = {
      notify: async () => true,
      locationPermissionStatus: async () => ({ state: "system" as const }),
      resetLocationPermission: vi.fn(async () => ({ state: "system" as const })),
    };
    try {
      await render(<PersonalLocationSettings />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(container.querySelector("[data-testid=desktop-location-state]")?.textContent)
        .toContain("System Settings → Privacy & Security → Location Services");
      expect(container.querySelector("[data-testid=desktop-location-reset]")).toBeNull();
    } finally {
      delete window.instafyDesktop;
    }
  });
});
