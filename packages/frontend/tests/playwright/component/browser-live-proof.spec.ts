import { expect, test } from "@playwright/test";

import {
  browserActionsShowClickThenNavigationToHost,
  remoteSurfaceHasRenderedFrame,
} from "../utils/electronBrowserLiveHarness.js";

test.describe("live browser smoke proof", () => {
  test("rejects empty solid frames and accepts a frame with page detail", async ({ page }) => {
    await page.setContent(
      '<canvas data-testid="surface" width="320" height="200" style="width:320px;height:200px"></canvas>',
    );
    const surface = page.getByTestId("surface");

    await surface.evaluate((element) => {
      const context = (element as HTMLCanvasElement).getContext("2d");
      if (!context) {
        throw new Error("2D canvas context unavailable");
      }
      context.fillStyle = "#000";
      context.fillRect(0, 0, 320, 200);
    });
    expect(await remoteSurfaceHasRenderedFrame(surface)).toBe(false);

    await surface.evaluate((element) => {
      const context = (element as HTMLCanvasElement).getContext("2d");
      if (!context) {
        throw new Error("2D canvas context unavailable");
      }
      context.fillStyle = "#000";
      context.fillRect(0, 0, 320, 200);
      context.fillStyle = "#fff";
      context.fillRect(120, 70, 80, 60);
      context.fillStyle = "#111";
      context.fillRect(132, 88, 52, 8);
    });
    expect(await remoteSurfaceHasRenderedFrame(surface)).toBe(false);

    await surface.evaluate((element) => {
      const context = (element as HTMLCanvasElement).getContext("2d");
      if (!context) {
        throw new Error("2D canvas context unavailable");
      }
      context.fillStyle = "#fff";
      context.fillRect(0, 0, 320, 200);
    });
    expect(await remoteSurfaceHasRenderedFrame(surface)).toBe(false);

    await surface.evaluate((element) => {
      const context = (element as HTMLCanvasElement).getContext("2d");
      if (!context) {
        throw new Error("2D canvas context unavailable");
      }
      context.fillStyle = "#fff";
      context.fillRect(0, 0, 320, 200);
      context.fillStyle = "#111";
      context.fillRect(48, 52, 224, 18);
      context.fillRect(48, 86, 150, 12);
    });
    expect(await remoteSurfaceHasRenderedFrame(surface)).toBe(true);
  });

  test("accepts sparse detail on a high-resolution page", async ({ page }) => {
    await page.setContent(
      '<canvas data-testid="surface" width="2048" height="1080" style="width:1024px;height:540px"></canvas>',
    );
    const surface = page.getByTestId("surface");
    await surface.evaluate((element) => {
      const context = (element as HTMLCanvasElement).getContext("2d");
      if (!context) {
        throw new Error("2D canvas context unavailable");
      }
      context.fillStyle = "#f0f0f0";
      context.fillRect(0, 0, 2048, 1080);
      context.fillStyle = "#222";
      context.font = "36px sans-serif";
      context.fillText("Example Domain", 410, 180);
      context.font = "22px sans-serif";
      context.fillText("A small amount of real page content.", 410, 245);
      context.fillStyle = "#4455aa";
      context.fillRect(410, 285, 150, 3);
    });

    expect(await remoteSurfaceHasRenderedFrame(surface)).toBe(true);
  });

  test("requires an observed click before the destination navigation result", () => {
    expect(
      browserActionsShowClickThenNavigationToHost(
        [
          { type: "nav_result", url: "https://example.com/" },
          { type: "click", url: "https://example.com/" },
          { type: "nav_result", url: "https://www.iana.org/help/example-domains" },
        ],
        "iana.org",
      ),
    ).toBe(true);

    expect(
      browserActionsShowClickThenNavigationToHost(
        [
          { type: "nav_result", url: "https://www.iana.org/help/example-domains" },
          { type: "click", url: "https://www.iana.org/help/example-domains" },
        ],
        "iana.org",
      ),
    ).toBe(false);
    expect(
      browserActionsShowClickThenNavigationToHost(
        [
          { type: "click", url: "https://example.com/" },
          { type: "nav_result", url: "https://iana.org.example.test/" },
        ],
        "iana.org",
      ),
    ).toBe(false);
  });
});
