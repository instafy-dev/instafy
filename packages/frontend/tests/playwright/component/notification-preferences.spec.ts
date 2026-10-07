import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { NotificationPreferences } from "../../../src/notifications/notificationContract";
import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE = "/__notification-preferences__";
const API = "/__notification-preferences-controller__";
const USER = "11111111-1111-4111-8111-111111111111";
const TOKEN = "notification-preferences-fixture";

async function mountPreferences(page: Page) {
  const deps = await resolveViteReactDependencies(page);
  const initial: NotificationPreferences = {
    hidePreviews: true,
    preferences: ["support", "conversations", "runs", "automations"].flatMap(category =>
      ["web_push", "apns", "local"].map(channel => ({
        category, channel, enabled: !(category === "support" && channel === "local"),
      }))) as NotificationPreferences["preferences"],
  };
  const saved = structuredClone(initial);
  const patches: Partial<NotificationPreferences>[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route(`**${API}/me/notifications/preferences`, async route => {
    const request = route.request();
    expect(request.headers().authorization).toBe(`Bearer ${TOKEN}`);
    if (request.method() === "POST") {
      const patch = request.postDataJSON() as Partial<NotificationPreferences>;
      patches.push(patch);
      if (typeof patch.hidePreviews === "boolean") saved.hidePreviews = patch.hidePreviews;
      for (const preference of patch.preferences ?? []) {
        const index = saved.preferences.findIndex(item => item.category === preference.category && item.channel === preference.channel);
        saved.preferences[index] = preference;
      }
    }
    await route.fulfill({ json: { ok: true, ...saved } });
  });
  await page.route("**/src/services/runtimeController/core.ts*", route => route.fulfill({
    contentType: "application/javascript",
    body: `export const runtimeControllerEnabled=true;
      export const controllerBaseUrl=location.origin+${JSON.stringify(API)};
      export const resolveControllerRequestContext=async(accessToken)=>({baseUrl:controllerBaseUrl,accessToken});
      export const readControllerError=async(response,fallback)=>(await response.json().catch(()=>null))?.error??fallback;`,
  }));
  await page.route("**/src/sdk/instafy/index.ts*", route => route.fulfill({
    contentType: "application/javascript",
    body: `import * as notifications from '/src/services/runtimeController/productNotifications.ts';
      export const controllerClient={notifications:{getPreferences:notifications.getProductNotificationPreferences,savePreferences:notifications.saveProductNotificationPreferences}};`,
  }));
  await page.route(`**${FIXTURE}`, route => route.fulfill({ contentType: "text/html", body: `<!doctype html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <script type="module">import R from '/@react-refresh';R.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>x=>x;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="${FIXTURE}.js"></script></head><body><div id="root"></div></body></html>` }));
  await page.route(`**${FIXTURE}.js`, route => route.fulfill({ contentType: "application/javascript", body: `
    import '/src/styles/tailwind.css';
    import ReactNS from ${JSON.stringify(deps.react)};import ReactDOMNS from ${JSON.stringify(deps.reactDomClient)};
    import { NotificationPreferencesSettings } from '/src/notifications/NotificationPreferencesSettings.tsx';
    import { setNotificationSession } from '/src/notifications/notificationSession.ts';
    const R=ReactNS.default??ReactNS,h=R.createElement,{createRoot}=ReactDOMNS.default??ReactDOMNS;
    setNotificationSession({userId:${JSON.stringify(USER)},accessToken:${JSON.stringify(TOKEN)}});
    createRoot(document.getElementById('root')).render(h('main',{className:'min-h-dvh bg-white p-5 text-slate-900 sm:p-8'},
      h('div',{className:'mx-auto max-w-2xl'},h('h1',{className:'mb-6 text-xl font-semibold'},'Notifications'),
        h(NotificationPreferencesSettings,{userId:${JSON.stringify(USER)},accessToken:${JSON.stringify(TOKEN)}}))));` }));
  await page.goto(FIXTURE);
  await expect(page.getByRole("switch", { name: "Support Browser push", exact: true })).toBeVisible();
  await expect(page.getByTestId("notification-device-permission")).not.toContainText("Checking");
  return { initial, saved, patches, errors };
}

async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}

for (const viewport of [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1280, height: 900 }]) {
  test(`notification settings keep current-channel controls compact and independent on ${viewport.name}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const fixture = await mountPreferences(page);
    const others = page.getByTestId("notification-other-channels");
    await expect(others).not.toHaveAttribute("open", "");
    await expect(page.getByRole("switch")).toHaveCount(6);
    await expect(page.getByRole("switch", { name: "Support iPhone push", exact: true })).toBeHidden();
    await expect(page.getByRole("status", { name: "Notification saving status" })).toHaveText("Changes save automatically.");
    const rows = page.getByTestId("notification-channel-web_push").locator("label");
    await expect(rows).toHaveCount(4);
    const geometry = await rows.evaluateAll(elements => elements.map(element => {
      const row = element.getBoundingClientRect();
      const track = element.querySelector<HTMLElement>('span[aria-hidden="true"]')!.getBoundingClientRect();
      return { height: row.height, right: row.right, trackRight: track.right, trackWidth: track.width };
    }));
    for (const row of geometry) {
      expect(row.height).toBeGreaterThanOrEqual(44);
      expect(row.trackWidth).toBeGreaterThan(0);
      expect(Math.abs(row.right - row.trackRight)).toBeLessThanOrEqual(1);
      expect(Math.abs(row.trackRight - geometry[0].trackRight)).toBeLessThanOrEqual(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await capture(page, info, `notification-preferences-${viewport.name}-initial`);

    // React Aria keeps its semantic input visually hidden. Click the visible
    // label/track surface that a user actually presses, without forcing input clicks.
    await rows.filter({ has: page.getByRole("switch", { name: "Support Browser push", exact: true }) }).click();
    await expect(page.getByRole("switch", { name: "Support Browser push", exact: true })).not.toBeChecked();
    expect(fixture.patches).toEqual([{ preferences: [{ category: "support", channel: "web_push", enabled: false }] }]);
    expect(fixture.saved.preferences.filter(item => item.channel !== "web_push")).toEqual(fixture.initial.preferences.filter(item => item.channel !== "web_push"));
    expect(fixture.saved.hidePreviews).toBe(true);
    await others.locator("summary").click();
    await expect(page.getByRole("switch")).toHaveCount(14);
    await expect(page.getByRole("switch", { name: "Support iPhone push", exact: true })).toBeChecked();
    await expect(page.getByRole("switch", { name: "Support In-app and desktop alerts", exact: true })).not.toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
    await capture(page, info, `notification-preferences-${viewport.name}-channels`);
    await others.locator("summary").click();
    await expect(page.getByRole("switch")).toHaveCount(6);
    await expect(page.getByRole("switch", { name: "Support Browser push", exact: true })).not.toBeChecked();
    expect(fixture.errors).toEqual([]);
  });
}
