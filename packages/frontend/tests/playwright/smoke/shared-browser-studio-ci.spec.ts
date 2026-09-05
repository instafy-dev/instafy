import { expect, test, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// This lane deliberately does not import the ordinary Studio harness/global
// setup: those also support developer credentials and model-driven journeys.
const ENABLED = process.env.PLAYWRIGHT_SHARED_BROWSER_STUDIO_CI === "1";
const PROOF_VALUE = "studio-proof";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type StudioFixture = {
  baseURL: string;
  controllerURL: string;
  projectId: string;
  userId: string;
  storageKey: string;
  localStorageValue: string;
  fixturePageURL: string;
  fixtureControlURL: string;
  fixtureControlToken: string;
};

type FixtureState = {
  cookie: string;
  storage: string | null;
  httpOnlyVisible: boolean;
  submissions: number;
  observations: number;
  modelJobs: number;
};

type BrowserGrant = { runtimeId: string; originId: string; browserSessionId: string };

function readFixture(): StudioFixture {
  const fixturePath = process.env.INSTAFY_STUDIO_E2E_FIXTURE;
  if (!fixturePath || !path.isAbsolute(fixturePath)) {
    throw new Error("The Studio CI lane requires an absolute disposable fixture JSON path.");
  }
  const stat = fs.lstatSync(fixturePath);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 64 * 1024) {
    throw new Error("The Studio fixture must be a bounded, single-link, mode-0600 regular file.");
  }
  const value = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as StudioFixture;
  for (const key of ["baseURL", "controllerURL", "fixtureControlURL"] as const) {
    const url = new URL(value[key]);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
        url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      throw new Error(`Studio fixture ${key} must be an explicit loopback HTTP origin.`);
    }
  }
  if (!UUID.test(value.projectId) || !UUID.test(value.userId) ||
      value.fixturePageURL !== "http://studio-browser-fixture.test/" ||
      typeof value.fixtureControlToken !== "string" || value.fixtureControlToken.length < 16 ||
      typeof value.storageKey !== "string" || !/^sb-[a-z0-9-]+-auth-token$/.test(value.storageKey) ||
      typeof value.localStorageValue !== "string") {
    throw new Error("The disposable Studio fixture identity/site contract is invalid.");
  }
  const session = JSON.parse(value.localStorageValue) as { user?: { id?: string }; access_token?: string };
  if (session.user?.id !== value.userId || typeof session.access_token !== "string") {
    throw new Error("The disposable Supabase session does not match the fixture user.");
  }
  const claims = JSON.parse(Buffer.from(session.access_token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
    role?: unknown;
    sub?: unknown;
  };
  if (claims.role !== "authenticated" || claims.sub !== value.userId) {
    throw new Error("Only the fixture user's ordinary authenticated session may enter Studio.");
  }
  return value;
}

async function control<T>(fixture: StudioFixture, pathname: string, data?: unknown): Promise<T> {
  // Node-only requests keep the fixture control token out of the Studio browser
  // and its trace. This fixture-control token is not an application credential.
  const response = await fetch(new URL(pathname, fixture.fixtureControlURL), {
    method: data === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${fixture.fixtureControlToken}`,
      ...(data === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(120_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`Disposable Studio control ${pathname} failed (${response.status}).`);
  }
  return await response.json() as T;
}

async function state(fixture: StudioFixture): Promise<FixtureState> {
  const result = await control<FixtureState>(fixture, "/state");
  expect(typeof result.cookie).toBe("string");
  expect(result.storage === null || typeof result.storage === "string").toBe(true);
  expect(typeof result.httpOnlyVisible).toBe("boolean");
  for (const count of [result.submissions, result.observations, result.modelJobs]) {
    expect(Number.isSafeInteger(count) && count >= 0).toBe(true);
  }
  expect(result.modelJobs, "this human-driven journey must not launch a model job").toBe(0);
  return result;
}

function cookies(value: string): Record<string, string> {
  return Object.fromEntries(value.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const separator = part.indexOf("=");
    return [part.slice(0, separator), part.slice(separator + 1)];
  }));
}

async function expectSignedIn(page: Page, fixture: StudioFixture) {
  await expect.poll(async () => page.evaluate(async () => {
    const client = (window as typeof window & {
      __INSTAFY_SUPABASE__?: { auth: { getUser: () => Promise<{ data: { user: { id: string } | null } }> } };
    }).__INSTAFY_SUPABASE__;
    return (await client?.auth.getUser())?.data.user?.id ?? null;
  }), { timeout: 60_000 }).toBe(fixture.userId);
  expect(new URL(page.url()).pathname).toBe("/studio");
  expect(new URL(page.url()).searchParams.get("projectId")).toBe(fixture.projectId);
}

async function openSharedBrowser(page: Page) {
  await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 90_000 });
  await page.getByTestId("composer-action-menu-trigger").click();
  await page.getByTestId("composer-action-menu-open-browser").click();
  await page.getByTestId("browser-transport-shared").click();
  await expectBrowserReady(page);
}

async function expectBrowserReady(page: Page) {
  const modal = page.getByTestId("browser-session-modal");
  await expect(modal).toBeVisible({ timeout: 60_000 });
  await expect(modal.getByTestId("browser-session-status")).toContainText("Ready", { timeout: 180_000 });
  await expect(modal.getByTestId("browser-session-stage"))
    .toHaveAttribute("data-shared-browser-viewer", "cdp-screencast");
  await expect(modal.getByTestId("shared-browser-collaboration-control-state"))
    .toHaveText("You control", { timeout: 30_000 });
  await expect(modal.getByTestId("shared-browser-cdp-screencast")).toBeVisible();
  await expect(modal.getByTestId("shared-browser-cdp-screencast")).toHaveAttribute("data-input-enabled", "true");
  await expect(modal.getByTestId("shared-browser-address")).toBeEnabled();
}

async function expectPaintedFixture(surface: Locator) {
  await expect.poll(async () => surface.evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    if (canvas.width < 300 || canvas.height < 100) return false;
    const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
    if (!pixels) return false;
    let light = 0;
    let dark = 0;
    for (let offset = 0; offset < pixels.length; offset += 4) {
      if (pixels[offset + 3] < 250) continue;
      if (pixels[offset] > 220 && pixels[offset + 1] > 220 && pixels[offset + 2] > 220) light++;
      if (pixels[offset] < 150 || pixels[offset + 1] < 150 || pixels[offset + 2] < 150) dark++;
    }
    return light > 1_000 && dark > 100;
  }), { timeout: 30_000 }).toBe(true);
}

async function navigateAndObserve(page: Page, fixture: StudioFixture, expected: "empty" | "signed-in") {
  const baseline = await state(fixture);
  const address = page.getByTestId("shared-browser-address");
  await address.fill(fixture.fixturePageURL);
  await address.press("Enter");
  await expect(address).toHaveValue(fixture.fixturePageURL, { timeout: 45_000 });
  await expect.poll(async () => (await state(fixture)).observations, { timeout: 45_000 })
    .toBeGreaterThan(baseline.observations);
  const observed = await state(fixture);
  expect(cookies(observed.cookie)).toEqual(expected === "empty" ? {} : {
    fixture_js: PROOF_VALUE,
    fixture_http: PROOF_VALUE,
  });
  expect(observed.storage).toBe(expected === "empty" ? null : PROOF_VALUE);
  expect(observed.httpOnlyVisible).toBe(false);
  await expectPaintedFixture(page.getByTestId("shared-browser-cdp-screencast"));
  await expect(page.getByTestId("browser-session-frozen-frame")).toBeHidden();
  return observed;
}

async function clickRemoteInput(page: Page) {
  const point = await page.getByTestId("shared-browser-cdp-screencast").evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const bounds = canvas.getBoundingClientRect();
    const width = Number(canvas.getAttribute("data-remote-content-width")) || canvas.width;
    const height = Number(canvas.getAttribute("data-remote-content-height")) || canvas.height;
    const scale = Math.min(bounds.width / width, bounds.height / height);
    // The disposable site's input is at (20,20), size 300x50. Map a real
    // physical pointer into the painted remote viewport, excluding gutters.
    return {
      x: bounds.left + (bounds.width - width * scale) / 2 + 100 * scale,
      y: bounds.top + (bounds.height - height * scale) / 2 + 40 * scale,
    };
  });
  await page.mouse.click(point.x, point.y);
  // A missed remote click must fail before typing/Enter could reach Studio's
  // chat composer and accidentally enqueue an agent job.
  await expect(page.getByTestId("shared-browser-cdp-screencast")).toBeFocused();
}

test.describe("Disposable signed-in Studio Shared Browser", () => {
  test.skip(!ENABLED, "The standalone Studio CI lane provisions its own local Supabase/runtime fixture.");
  test.setTimeout(600_000);

  test("signed-in Studio controls Shared Browser, restores its login, and clears project data", async ({ page: initialPage }) => {
    let page = initialPage;
    const context = page.context();
    const fixture = readFixture();
    const grants: BrowserGrant[] = [];
    const observeGrants = (target: Page) => target.on("response", async response => {
      if (!response.ok() || response.request().method() !== "POST" ||
          response.url() !== new URL("/access_token", fixture.controllerURL).toString()) return;
      const request = response.request().postDataJSON() as Record<string, unknown> | null;
      if (request?.projectId !== fixture.projectId || request.protocol !== "http" ||
          !Array.isArray(request.scopes) || !request.scopes.includes("browser.control") ||
          !request.scopes.includes("browser.view") || typeof request.preferRuntime !== "string" ||
          typeof request.browserSessionId !== "string") return;
      const payload = await response.json() as { originId?: unknown };
      if (typeof payload.originId === "string") grants.push({
        runtimeId: request.preferRuntime,
        originId: payload.originId,
        browserSessionId: request.browserSessionId,
      });
    });
    observeGrants(page);
    const latestGrant = async (excludedRuntimeIds: string[] = []): Promise<BrowserGrant> => {
      await expect.poll(() => grants.some(grant => !excludedRuntimeIds.includes(grant.runtimeId)),
        { timeout: 180_000 }).toBe(true);
      return grants.filter(grant => !excludedRuntimeIds.includes(grant.runtimeId)).at(-1)!;
    };

    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(new URL("/login", fixture.baseURL).toString());
    // The session is minted by the real disposable local Auth server. Only
    // ordinary user session material enters the browser; no service-role key.
    await page.evaluate(({ storageKey, localStorageValue }) => {
      localStorage.setItem(storageKey, localStorageValue);
    }, { storageKey: fixture.storageKey, localStorageValue: fixture.localStorageValue });
    const studioURL = new URL("/studio", fixture.baseURL);
    studioURL.searchParams.set("projectId", fixture.projectId);
    await page.goto(studioURL.toString());
    await expectSignedIn(page, fixture);
    await openSharedBrowser(page);
    const initial = await latestGrant();
    expect(UUID.test(initial.runtimeId)).toBe(true);
    await control(fixture, "/ready", { runtimeId: initial.runtimeId });
    await navigateAndObserve(page, fixture, "empty");

    await control(fixture, "/checkpoint", {});
    const beforeLogin = await state(fixture);
    await clickRemoteInput(page);
    await page.keyboard.type(PROOF_VALUE, { delay: 35 });
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await state(fixture)).submissions, { timeout: 30_000 })
      .toBe(beforeLogin.submissions + 1);
    await navigateAndObserve(page, fixture, "signed-in");
    await control(fixture, "/wait-snapshot", { runtimeId: initial.runtimeId });

    // Close the viewer first so its reconnect loop cannot race the explicit
    // production stop. A fresh tab retains real Auth localStorage but does not
    // inherit the previous tab's restored browser/sessionStorage selection.
    await page.close();
    const stopped = await control<{ retiredRuntimeId: string }>(fixture, "/stop-runtime", {
      runtimeId: initial.runtimeId,
    });
    expect(stopped.retiredRuntimeId).toBe(initial.runtimeId);
    page = await context.newPage();
    observeGrants(page);
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto(studioURL.toString());
    await expectSignedIn(page, fixture);
    await openSharedBrowser(page);
    const replacement = await latestGrant([initial.runtimeId]);
    expect(replacement.originId).not.toBe(initial.originId);
    await control(fixture, "/ready", { runtimeId: replacement.runtimeId });
    const restored = await navigateAndObserve(page, fixture, "signed-in");
    expect(restored.submissions).toBe(beforeLogin.submissions + 1);

    const clearResponse = page.waitForResponse(response =>
      response.request().method() === "DELETE" &&
      response.url() === new URL(`/projects/${fixture.projectId}/browser-profile`, fixture.controllerURL).toString());
    page.once("dialog", async dialog => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toContain("Clear Shared Browser data for everyone in this space?");
      await dialog.accept();
    });
    await page.getByTestId("shared-browser-clear-data").click();
    expect((await clearResponse).ok()).toBe(true);
    await expectBrowserReady(page);
    const cleared = await latestGrant([initial.runtimeId, replacement.runtimeId]);
    expect(cleared.originId).not.toBe(replacement.originId);
    await control(fixture, "/ready", { runtimeId: cleared.runtimeId });
    const empty = await navigateAndObserve(page, fixture, "empty");
    expect(empty.submissions).toBe(restored.submissions);
    await expectSignedIn(page, fixture);
    expect((await state(fixture)).modelJobs).toBe(0);
  });
});
