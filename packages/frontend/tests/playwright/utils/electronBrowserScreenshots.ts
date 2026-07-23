import type { Page } from "@playwright/test";

import type { ElectronStudioLaunch } from "./electronBrowserLiveHarness.js";

export type ElectronBrowserScreenshot = {
  personalViewportPng: Buffer | null;
  windowPng: Buffer;
};

/**
 * Capture the real Electron BrowserWindow and, when requested, composite the
 * separate Personal Browser WebContentsView into its renderer cutout. A plain
 * Playwright page screenshot cannot see that native view.
 */
export async function captureElectronBrowserWindow(
  app: ElectronStudioLaunch["app"],
  page: Page,
  options: {
    includePersonal?: boolean;
    personalBrowserUrl?: string;
  } = {},
): Promise<ElectronBrowserScreenshot> {
  const includePersonal = options.includePersonal ?? false;
  const capture = await app.evaluate(
    async (
      { BrowserWindow, desktopCapturer, webContents },
      args: { includePersonal: boolean; personalBrowserUrl?: string },
    ) => {
      const window = BrowserWindow.getAllWindows().find(
        (candidate) => !candidate.isDestroyed(),
      );
      if (!window) {
        throw new Error("Electron BrowserWindow is unavailable.");
      }

      if (!args.includePersonal) {
        try {
          const [width, height] = window.getSize();
          const mediaSourceId = window.getMediaSourceId();
          const sources = await desktopCapturer.getSources({
            types: ["window"],
            thumbnailSize: { width: width * 2, height: height * 2 },
            fetchWindowIcons: false,
          });
          const mediaWindowId = mediaSourceId.split(":").slice(0, 2).join(":");
          const source = sources.find((candidate) =>
            candidate.id.startsWith(`${mediaWindowId}:`),
          );
          if (source && !source.thumbnail.isEmpty()) {
            return {
              base64: source.thumbnail.toPNG().toString("base64"),
              mode: "desktop" as const,
              personalBase64: null,
            };
          }
        } catch {
          // macOS can deny desktop capture without Screen Recording consent.
        }
      }

      const mainImage = await window.capturePage();
      const personalContents = args.includePersonal
        ? webContents.getAllWebContents().find((candidate) => {
            if (
              candidate.id === window.webContents.id ||
              candidate.isDestroyed() ||
              !/^https?:\/\//.test(candidate.getURL())
            ) {
              return false;
            }
            return (
              !args.personalBrowserUrl ||
              candidate.getURL() === args.personalBrowserUrl
            );
          })
        : null;
      const personalImage = personalContents
        ? await personalContents.capturePage()
        : null;
      return {
        base64: mainImage.toPNG().toString("base64"),
        mode: "web-contents" as const,
        personalBase64: personalImage?.toPNG().toString("base64") ?? null,
      };
    },
    {
      includePersonal,
      personalBrowserUrl: options.personalBrowserUrl,
    },
  );

  let windowBase64 = capture.base64;
  if (capture.mode === "web-contents" && includePersonal) {
    if (!capture.personalBase64) {
      throw new Error("Personal Browser WebContentsView is unavailable for capture.");
    }
    const viewport = await page
      .getByTestId("personal-browser-viewport")
      .boundingBox();
    const rendererSize = await page.evaluate(() => ({
      height: window.innerHeight,
      width: window.innerWidth,
    }));
    if (!viewport) {
      throw new Error("Personal Browser viewport bounds are unavailable for capture.");
    }
    windowBase64 = await page.evaluate(
      async ({ mainBase64, personalBase64, rendererSize, viewport }) => {
        const loadImage = (value: string) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () =>
              reject(new Error("Browser screenshot image decode failed."));
            image.src = `data:image/png;base64,${value}`;
          });
        const [mainImage, personalImage] = await Promise.all([
          loadImage(mainBase64),
          loadImage(personalBase64),
        ]);
        const canvas = document.createElement("canvas");
        canvas.width = mainImage.naturalWidth;
        canvas.height = mainImage.naturalHeight;
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Browser screenshot canvas is unavailable.");
        }
        const scaleX = canvas.width / rendererSize.width;
        const scaleY = canvas.height / rendererSize.height;
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(mainImage, 0, 0);
        // BrowserWindow.capturePage can encode the separate native-view cutout
        // as opaque black. Clear only that known rectangle before compositing;
        // never rewrite black pixels after drawing the real browser page.
        context.fillRect(
          viewport.x * scaleX,
          viewport.y * scaleY,
          viewport.width * scaleX,
          viewport.height * scaleY,
        );
        context.drawImage(
          personalImage,
          viewport.x * scaleX,
          viewport.y * scaleY,
          viewport.width * scaleX,
          viewport.height * scaleY,
        );
        return canvas
          .toDataURL("image/png")
          .replace(/^data:image\/png;base64,/, "");
      },
      {
        mainBase64: capture.base64,
        personalBase64: capture.personalBase64,
        rendererSize,
        viewport,
      },
    );
  }

  return {
    personalViewportPng: capture.personalBase64
      ? Buffer.from(capture.personalBase64, "base64")
      : null,
    windowPng: Buffer.from(windowBase64, "base64"),
  };
}
