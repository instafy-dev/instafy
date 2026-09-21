import {
  BrowserWindow,
  type Session,
  type BrowserWindowConstructorOptions,
} from "electron";
import { dispatchBrowserTabInput } from "./browserTabInput";
import { type ExplorePage, type ExploreViewport } from "./browserTabExplore";
import { normalizePersonalBrowserUrl } from "./personalBrowserSecurity";

/** Separate native renderer in the already approved owner's browser session. */
export function createBrowserTabExplorePage(
  session: Session,
  startUrl: string,
  initial: ExploreViewport,
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow = (
    options,
  ) => new BrowserWindow(options),
): ExplorePage {
  const url = normalizePersonalBrowserUrl(startUrl);
  if (!/^https?:/.test(url))
    throw new Error("Open a web page before allowing Explore.");
  const window = createWindow({
    show: false,
    focusable: false,
    width: initial.width,
    height: initial.height,
    webPreferences: {
      session,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      disableDialogs: true,
    },
  });
  const contents = window.webContents;
  let viewport = initial,
    revision = 0,
    transientCaptureFailures = 0,
    closed = false,
    loaded = false,
    failure: Error | null = null;
  contents.setAudioMuted(true);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-attach-webview", (event) => event.preventDefault());
  const guard = (event: { preventDefault(): void }, value: string) => {
    try {
      normalizePersonalBrowserUrl(value);
    } catch {
      event.preventDefault();
    }
  };
  contents.on("will-navigate", guard);
  contents.on("will-redirect", guard);
  contents.on("will-frame-navigate", (event) => guard(event, event.url));
  contents.on("render-process-gone", () => {
    failure = new Error("Explore renderer stopped.");
  });
  async function applyViewport(next: ExploreViewport) {
    viewport = next;
    revision++;
    window.setContentSize(next.width, next.height);
    await contents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: next.width,
      height: next.height,
      deviceScaleFactor: next.dpr,
      mobile: false,
      screenWidth: next.width,
      screenHeight: next.height,
    });
  }
  const timeout = setTimeout(() => {
    failure = new Error("Explore page did not load.");
  }, 15_000);
  timeout.unref();
  const initializing = contents
    .loadURL("about:blank")
    .then(() => {
      contents.debugger.attach("1.3");
      return applyViewport(initial);
    })
    .then(() =>
      contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
        enabled: true,
      }),
    )
    .then(() => contents.loadURL(url))
    .then(() => {
      loaded = true;
      clearTimeout(timeout);
    })
    .catch((error) => {
      clearTimeout(timeout);
      if (!closed) failure = error;
    });
  return {
    async frame() {
      if (failure) throw failure;
      if (!loaded || closed) return null;
      const generation = revision;
      // Electron's capture lease keeps a hidden renderer painting across
      // navigation. A CDP screenshot can otherwise wait forever for a surface.
      let captureTimeout: ReturnType<typeof setTimeout> | undefined;
      let image;
      try {
        image = await Promise.race([
          contents.capturePage(undefined, {
            stayHidden: true,
            stayAwake: false,
          }),
          new Promise<never>((_resolve, reject) => {
            captureTimeout = setTimeout(
              () => reject(new Error("Explore capture timed out.")),
              3000,
            );
            captureTimeout.unref?.();
          }),
        ]);
        transientCaptureFailures = 0;
      } catch (error) {
        // Chromium can briefly have no compositor surface during navigation.
        // Drop that frame, but bound retries so a broken renderer closes its view.
        if (
          error instanceof Error &&
          error.message === "UnknownVizError" &&
          ++transientCaptureFailures <= 3
        )
          return null;
        throw error;
      } finally {
        clearTimeout(captureTimeout);
      }
      if (closed || generation !== revision) return null;
      const width = Math.max(1, Math.round(viewport.width * viewport.dpr));
      const height = Math.max(1, Math.round(viewport.height * viewport.dpr));
      const size = image.getSize();
      if (!size.width || !size.height) return null;
      // Native capture may be limited by the owner's display backing scale.
      // A higher requested DPR must never manufacture extra pixels by upscaling.
      const scale = Math.min(1, width / size.width, height / size.height);
      if (scale < 1)
        image = image.resize({
          width: Math.max(1, Math.floor(size.width * scale)),
          height: Math.max(1, Math.floor(size.height * scale)),
          quality: "good",
        });
      return image.toJPEG(80);
    },
    async resize(next) {
      await initializing;
      if (!closed) await applyViewport(next);
    },
    input: (input, current) =>
      dispatchBrowserTabInput(contents, viewport, input, current),
    async navigate(action) {
      if (action === "back" && contents.navigationHistory.canGoBack())
        contents.navigationHistory.goBack();
      if (action === "forward" && contents.navigationHistory.canGoForward())
        contents.navigationHistory.goForward();
      if (action === "reload") contents.reload();
    },
    close() {
      closed = true;
      clearTimeout(timeout);
      if (!window.isDestroyed()) window.destroy();
    },
  };
}
