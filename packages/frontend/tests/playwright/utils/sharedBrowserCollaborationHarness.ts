import { expect, type Locator, type Page, type Response } from "@playwright/test";

import { installSharedBrowserSocketProbe } from "./sharedBrowserSocketProbe.js";

export {
  collaborationSocketProbeSnapshot,
  disruptLatestBrowserTransportSockets,
  disruptLatestCollaborationSocket,
  expectExistingInputAccepted,
  expectExistingInputRejected,
  inputSocketProbeSnapshot,
  latestOpenInputSocket,
  waitForOpenInputSocket,
  type CollaborationSocketProbeSnapshot,
  type InputSocketProbeSnapshot,
} from "./sharedBrowserSocketProbe.js";

const FIXTURE_PANEL_WIDTH_PX = 620;

export type BrowserGrantBinding = {
  browserSessionId: string;
  originId: string;
  runtimeId: string;
};

export async function constrainBrowserPanelForCdp(page: Page) {
  const root = page.getByTestId("chat-panel-root");
  await expect(root).toBeVisible({ timeout: 30_000 });
  await root.evaluate((element, width) => {
    element.style.width = `${width}px`;
    element.style.maxWidth = `${width}px`;
    element.style.flex = `0 0 ${width}px`;
    element.style.alignSelf = "flex-start";
  }, FIXTURE_PANEL_WIDTH_PX);
  await expect
    .poll(async () => Math.round((await root.boundingBox())?.width ?? 0))
    .toBe(FIXTURE_PANEL_WIDTH_PX);
}

function isBrowserControlGrantResponse(response: Response) {
  if (!response.ok() || response.request().method() !== "POST") {
    return false;
  }
  let pathname = "";
  try {
    pathname = new URL(response.url()).pathname;
  } catch {
    return false;
  }
  if (!pathname.endsWith("/access_token")) {
    return false;
  }
  try {
    const body = response.request().postDataJSON() as {
      protocol?: unknown;
      scopes?: unknown;
      preferRuntime?: unknown;
      browserSessionId?: unknown;
    };
    return (
      body.protocol === "http" &&
      Array.isArray(body.scopes) &&
      body.scopes.includes("browser.view") &&
      body.scopes.includes("browser.control") &&
      typeof body.preferRuntime === "string" &&
      body.preferRuntime.length > 0 &&
      typeof body.browserSessionId === "string" &&
      body.browserSessionId.length > 0
    );
  } catch {
    return false;
  }
}

export async function openSharedBrowser(
  page: Page,
  options: { constrainForCdp?: boolean } = {},
): Promise<BrowserGrantBinding> {
  const constrainForCdp = options.constrainForCdp ?? true;
  if (constrainForCdp) {
    await constrainBrowserPanelForCdp(page);
  }
  await installSharedBrowserSocketProbe(page);
  const grantResponsePromise = page.waitForResponse(isBrowserControlGrantResponse, {
    timeout: 240_000,
  });

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent("instafy:browser-open", { detail: {} }));
  });
  const sharedButton = page.getByTestId("browser-transport-shared");
  await expect(sharedButton).toBeVisible({ timeout: 30_000 });
  await sharedButton.click();

  const modal = page.getByTestId("browser-session-modal");
  await expect(modal).toBeVisible({ timeout: 60_000 });
  await expect(modal.getByTestId("browser-session-status")).toContainText("Ready", {
    timeout: 240_000,
  });
  const stage = modal.getByTestId("browser-session-stage");
  if (constrainForCdp) {
    await expect(stage).toHaveAttribute(
      "data-shared-browser-viewer",
      "cdp-screencast",
      { timeout: 60_000 },
    );
    await expect(modal.getByTestId("shared-browser-cdp-screencast")).toBeVisible();
  } else {
    await expect(stage).toHaveAttribute(
      "data-shared-browser-viewer",
      /^(?:cdp-screencast|rfb|webrtc)$/,
      { timeout: 60_000 },
    );
    await expect(sharedPixelSurface(page)).toBeVisible({ timeout: 60_000 });
  }

  const grantResponse = await grantResponsePromise;
  const grantRequest = grantResponse.request().postDataJSON() as {
    browserSessionId: string;
    preferRuntime: string;
  };
  const grantPayload = (await grantResponse.json()) as { originId?: unknown };
  if (typeof grantPayload.originId !== "string" || !grantPayload.originId.trim()) {
    throw new Error("Shared Browser access grant omitted its origin id.");
  }
  return {
    browserSessionId: grantRequest.browserSessionId.trim(),
    originId: grantPayload.originId.trim(),
    runtimeId: grantRequest.preferRuntime.trim(),
  };
}

export function sharedSurface(page: Page) {
  return page
    .getByTestId("browser-session-modal")
    .getByTestId("shared-browser-cdp-screencast");
}

export function sharedPixelSurface(page: Page): Locator {
  return page
    .getByTestId("browser-session-modal")
    .locator("canvas:visible, video:visible")
    .first();
}

export async function expectSharedBlankSurfacePainted(page: Page) {
  const modal = page.getByTestId("browser-session-modal");
  await expect
    .poll(
      () =>
        sharedSurface(page).evaluate((element) => {
          const canvas = element as HTMLCanvasElement;
          const context = canvas.getContext("2d");
          if (!context || canvas.width < 1 || canvas.height < 1) {
            return null;
          }
          const pixel = context.getImageData(
            Math.floor(canvas.width / 2),
            Math.floor(canvas.height / 2),
            1,
            1,
          ).data;
          return (
            pixel[3] === 255 && pixel[0] >= 245 && pixel[1] >= 245 && pixel[2] >= 245
          );
        }),
      {
        message: "the Shared Browser about:blank canvas should have a painted light frame",
        timeout: 15_000,
      },
    )
    .toBe(true);
  await expect(modal.getByTestId("browser-session-frozen-frame")).toHaveCount(0, {
    timeout: 15_000,
  });
  await expect
    .poll(
      () =>
        sharedSurface(page).evaluate((element) => {
          let current: HTMLElement | null = element as HTMLElement;
          while (current) {
            const style = window.getComputedStyle(current);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
              return false;
            }
            if (current.dataset.testid === "browser-session-stage") {
              break;
            }
            current = current.parentElement;
          }
          return true;
        }),
      {
        message: "the painted Shared Browser canvas should not be hidden by reconnect UI",
        timeout: 15_000,
      },
    )
    .toBe(true);
}

export function collaborationState(page: Page) {
  return page.getByTestId("shared-browser-collaboration-control-state");
}

export function collaborationAction(page: Page) {
  return page.getByTestId("shared-browser-collaboration-control-action");
}

export async function authenticatedActorLabel(page: Page): Promise<string> {
  const label = await page.evaluate(async () => {
    const client = (window as Window & {
      __INSTAFY_SUPABASE__?: {
        auth?: {
          getUser?: () => Promise<{
            data?: {
              user?: {
                email?: string | null;
                user_metadata?: Record<string, unknown> | null;
              } | null;
            };
          }>;
        };
      };
    }).__INSTAFY_SUPABASE__;
    const user = (await client?.auth?.getUser?.())?.data?.user ?? null;
    const metadata = user?.user_metadata ?? null;
    for (const key of ["full_name", "name", "display_name"]) {
      const value = metadata?.[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
    const email = user?.email?.trim() ?? "";
    return email ? email.split("@", 1)[0] ?? "" : "";
  });
  return label.trim() || "Teammate";
}
