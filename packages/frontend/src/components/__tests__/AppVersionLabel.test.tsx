// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppVersionLabel } from "../AppVersionLabel";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as { instafyDesktop?: unknown }).instafyDesktop;
});

function label() {
  return container.querySelector('[data-testid="app-version-label"]')?.textContent ?? null;
}

async function renderLabel() {
  await act(async () => {
    root.render(<AppVersionLabel />);
  });
}

describe("AppVersionLabel", () => {
  it("reports the shell version inside the desktop app", async () => {
    // The shell version is what updates and what a user can act on; showing
    // the frontend build there would answer a question nobody asked while
    // hiding the one they did.
    (window as { instafyDesktop?: unknown }).instafyDesktop = {
      desktopUpdaterStatus: async () => ({
        isEnabled: true,
        channel: "stable",
        currentVersion: "0.2.3",
        feedUrl: "https://downloads.instafy.dev/desktop-app/stable",
        phase: "idle",
      }),
    };
    await renderLabel();
    expect(label()).toBe("Instafy 0.2.3");
  });

  it("falls back to the frontend build when the bridge read fails", async () => {
    // An empty slot would read as a rendering bug rather than a degraded read.
    (window as { instafyDesktop?: unknown }).instafyDesktop = {
      desktopUpdaterStatus: async () => {
        throw new Error("bridge unavailable");
      },
    };
    await renderLabel();
    expect(label()).toBeTruthy();
  });

  it("shows the frontend build on the web, where no bridge exists", async () => {
    await renderLabel();
    expect(label()).toBeTruthy();
  });
});
