import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

// The preview card as a link preview, mounted from the production view with synthetic props: phone and desktop
// widths, light and dark, the keyboard and the names a screen reader reads. No controller, no site.
const FIXTURE_PATH = "/__preview-card-fixture__";

async function mountCards(page: Page, dark: boolean): Promise<void> {
  const deps = await resolveViteReactDependencies(page);
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { SitePreviewCardView } from "/src/screens/studio/components/SitePreviewCardView.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    document.documentElement.classList.toggle("dark", ${dark});
    // A picture of a map, drawn here: the card shows whatever the controller hands it.
    const canvas = document.createElement("canvas");
    canvas.width = 640; canvas.height = 400;
    const g = canvas.getContext("2d");
    g.fillStyle = "#dfe9d8"; g.fillRect(0, 0, 640, 400);
    g.strokeStyle = "#7aa6c2"; g.lineWidth = 18; g.beginPath(); g.moveTo(0, 300); g.bezierCurveTo(200, 250, 420, 360, 640, 280); g.stroke();
    g.fillStyle = "#c0392b"; for (const [x, y] of [[180, 140], [320, 210], [470, 120]]) { g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.fill(); }
    const picture = { url: canvas.toDataURL("image/png") };
    window.__opened = [];
    const base = { visibility: "private", facts: "Trip · 3 days · 14 places", pictureTone: "normal", status: null, state: "live",
      pressable: true, busy: false, followLine: null, actions: [] };
    const cards = [
      { ...base, id: "live", title: "Lisbon weekend", picture },
      { ...base, id: "plain", title: "A rather long title for a site that has no picture of its own yet", picture: null, facts: null },
      { ...base, id: "stopped", title: "Lisbon weekend", picture, pictureTone: "gray", state: "stopped", status: { text: "Stopped · opening restarts it" } },
      { ...base, id: "blocked", title: "Lisbon weekend", picture: null, state: "stopped", pressable: false,
        status: { text: "Stopped · only people who can edit this space can start it" } },
      { ...base, id: "starting", title: "Lisbon weekend", picture, pictureTone: "dim", state: "stopped", wake: "waking", pressable: false, busy: true,
        status: { text: "Starting…", busy: true } },
      { ...base, id: "presenting", title: "Lisbon weekend", picture, state: "not_responding", status: { text: "Not responding", title: "Nothing answers on port 4173" },
        followLine: "Kim is presenting · 2 watching",
        actions: [{ id: "follow", label: "Follow Kim", testId: "preview-ready-follow", onPress: () => window.__opened.push("follow") },
                  { id: "restart", label: "Start again", testId: "preview-ready-restart", onPress: () => window.__opened.push("restart") }] },
    ];
    createRoot(document.getElementById("root")).render(
      h("main", { className: "min-h-dvh bg-white p-4 dark:bg-[var(--color-studio-dark-canvas)]" },
        h("div", { className: "flex max-w-2xl flex-col gap-4" },
          cards.map(({ id, ...props }) => h("div", { key: id, "data-case": id },
            h(SitePreviewCardView, { ...props, onOpen: () => window.__opened.push(id) }))))));
  `;
  // The React plugin's preamble, as the app's own index.html gets it, so the production .tsx modules load.
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    </head><body><div id="root"></div><script type="module" src="${FIXTURE_PATH}/main.js"></script></body></html>`;
  await page.route(`**${FIXTURE_PATH}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill({ contentType: "application/javascript", body: main }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  // A cold transform server may take a while on its first module graph.
  await expect(page.getByTestId("preview-ready-card"), errors.join("\n")).toHaveCount(6, { timeout: 60_000 });
}

const card = (page: Page, id: string) => page.locator(`[data-case=${id}] [data-testid=preview-ready-card]`);

for (const dark of [false, true]) {
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    test(`fits ${viewport.width}px ${dark ? "dark" : "light"}, one line each for title and facts`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await mountCards(page, dark);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      for (const id of ["live", "plain", "stopped", "blocked", "starting", "presenting"]) {
        const box = (await card(page, id).boundingBox())!;
        // 20rem at most, and within the phone's width.
        expect(box.width).toBeLessThanOrEqual(320.5);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }
      // The picture keeps 16:10 above the title.
      const picture = (await card(page, "live").getByTestId("preview-card-picture").boundingBox())!;
      expect(Math.abs(picture.width / picture.height - 1.6)).toBeLessThan(0.02);
      // A long title stays on one line, and a card with a title alone is still a 44 px tap target.
      const title = card(page, "plain").locator("[data-preview-card-open] span");
      expect(await title.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(24);
      expect((await card(page, "plain").boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // A reason is read whole: the status wraps rather than being cut.
      const reason = card(page, "blocked").getByRole("status");
      expect(await reason.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      // A live site's picture is drawn in full once it has faded in.
      await expect.poll(() => card(page, "live").locator("img").evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
      await page.screenshot({ path: testInfo.outputPath(`preview-cards-${viewport.width}-${dark ? "dark" : "light"}.png`), fullPage: true });
    });
  }
}

test("names the card, the lock and the status for screen readers", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await mountCards(page, false);
  await expect(card(page, "live").getByRole("button", { name: "Open Lisbon weekend", exact: true })).toBeVisible();
  await expect(card(page, "live").getByRole("img", { name: "Only space members can open this" })).toBeVisible();
  await expect(card(page, "live")).not.toContainText("Only space members");
  await expect(card(page, "stopped").getByRole("button", { name: "Open Lisbon weekend, stopped, opening restarts it" })).toBeVisible();
  await expect(card(page, "stopped").getByRole("status")).toHaveText("Stopped · opening restarts it");
  await expect(card(page, "live").getByRole("status")).toHaveText("");
  await expect(card(page, "blocked").getByRole("button", { name: /^Open Lisbon weekend, stopped/ })).toHaveAttribute("aria-disabled", "true");
  await expect(card(page, "starting").getByRole("button", { name: /^Open Lisbon weekend, starting/ })).toHaveAttribute("aria-busy", "true");
});

test("opens on a press anywhere on the card and from the keyboard, rings the whole card on focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mountCards(page, false);
  const opened = () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  // One tab stop for the card; keyboard focus rings the whole card.
  const resting = await card(page, "live").evaluate((el) => getComputedStyle(el).boxShadow);
  await page.keyboard.press("Tab");
  await expect(card(page, "live").getByRole("button", { name: "Open Lisbon weekend", exact: true })).toBeFocused();
  expect(await card(page, "live").evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe(resting);
  await page.keyboard.press("Enter");
  expect(await opened()).toEqual(["live"]);
  // The next tab stop is the next card: the lock and the picture are not stops of their own.
  await page.keyboard.press("Tab");
  await expect(card(page, "plain").locator("[data-preview-card-open]")).toBeFocused();
  // A press on the picture opens it: the button's area is the whole card, so the press lands on the button.
  const picture = (await card(page, "live").getByTestId("preview-card-picture").boundingBox())!;
  await page.mouse.click(picture.x + picture.width / 2, picture.y + picture.height / 2);
  expect(await opened()).toEqual(["live", "live"]);
  // A card that cannot be pressed does nothing, and does not look pressable.
  await card(page, "blocked").click();
  expect(await opened()).toEqual(["live", "live"]);
  expect(await card(page, "blocked").locator("[data-preview-card-open]").evaluate((el) => getComputedStyle(el).cursor)).toBe("default");
  // Secondary buttons sit above the card's own and press on their own.
  await card(page, "presenting").getByTestId("preview-ready-follow").click();
  expect(await opened()).toEqual(["live", "live", "follow"]);
});
