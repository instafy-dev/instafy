import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__credits-usage-responsive-fixture__";

async function mountUsageRates(page: Page, options: { containerWidth?: number } = {}): Promise<void> {
  const deps = await resolveViteReactDependencies(page);
  const usageRateRows = [
    {
      key: "live-access",
      label: "Live access",
      rate: {
        reason: "tunnel",
        enabled: true,
        amount: 1,
        intervalSeconds: 60,
        creditsPerMinute: 1,
      },
    },
    {
      key: "hosted-runtime",
      label: "Hosted runtime",
      rate: {
        reason: "hosted_runtime",
        enabled: false,
        amount: 0,
        intervalSeconds: 300,
        creditsPerMinute: 0,
      },
    },
  ];
  const managedAiUsage = {
    reason: "managed_ai",
    enabled: true,
    label: "Managed AI",
    creditsPerPrompt: 12,
    dailyPromptLimit: 200,
    modelLabel: "GPT-5 Codex",
    inputUsdMicrosPer1k: 1_250,
    cachedInputUsdMicrosPer1k: 125,
    outputUsdMicrosPer1k: 10_000,
  };

  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { CreditsUsageRates } from "/src/screens/studio/components/CreditsUsageRates.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    createRoot(document.getElementById("root")).render(
      h("main", { className: "w-full p-4" },
        h("div", {
          "data-testid": "credits-usage-fixture-container",
          style: ${JSON.stringify(
            options.containerWidth ? { width: `${options.containerWidth}px`, maxWidth: "100%" } : {},
          )},
        },
          h(CreditsUsageRates, {
            usageRateRows: ${JSON.stringify(usageRateRows)},
            managedAiUsage: ${JSON.stringify(managedAiUsage)},
            unitLabel: "credits",
            displayCurrency: "USD",
          }),
        ),
      ),
    );
    window.__mounted = true;`;

  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <script type="module">
      import RefreshRuntime from "/@react-refresh";
      RefreshRuntime.injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="/@vite/client"></script>
    <script type="module" src="${FIXTURE_PATH}/main.js"></script>
    </head><body><div id="root"></div></body></html>`;

  const javascript = (body: string) => ({ contentType: "application/javascript", body });
  await page.route(`**${FIXTURE_PATH}`, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) => route.fulfill(javascript(main)));

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await page.waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true, {
    timeout: 20_000,
  });
  expect(errors, errors.join("; ")).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const testSurfaces = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid^="credits-"]'),
    ).filter((element) => getComputedStyle(element).display !== "none");
    return {
      viewportWidth: window.innerWidth,
      documentWidth: root.scrollWidth,
      overflowingSurfaces: testSurfaces
        .filter((element) => element.scrollWidth > element.clientWidth + 1)
        .map((element) => element.dataset.testid ?? element.tagName),
      outOfBoundsSurfaces: testSurfaces
        .filter((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left < -1 || rect.right > window.innerWidth + 1;
        })
        .map((element) => element.dataset.testid ?? element.tagName),
    };
  });

  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewportWidth);
  expect(geometry.overflowingSurfaces).toEqual([]);
  expect(geometry.outOfBoundsSurfaces).toEqual([]);
}

test.describe("credits usage responsive layout", () => {
  test("uses readable stacked details at 360px without horizontal overflow", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 649 });
    await mountUsageRates(page);

    const activeServices = page.getByTestId("credits-active-services-mobile");
    const promptUsage = page.getByTestId("credits-prompt-usage-mobile");
    await expect(activeServices).toBeVisible();
    await expect(promptUsage).toBeVisible();
    await expect(page.getByTestId("credits-active-services-table")).toBeHidden();
    await expect(page.getByTestId("credits-prompt-usage-table")).toBeHidden();

    await expect(activeServices).toContainText("Credits/min");
    await expect(activeServices).toContainText("Billing interval");
    await expect(activeServices).toContainText("Not metered");
    await expect(promptUsage).toContainText("Reserve");
    await expect(promptUsage).toContainText("Token pricing");
    await expect(promptUsage).toContainText("Input $1.25/1M");
    await expect(promptUsage).toContainText("Cached $0.13/1M");
    await expect(promptUsage).toContainText("Output $10/1M");
    await expectNoHorizontalOverflow(page);
  });

  test("keeps the table presentation at the landscape breakpoint", async ({ page }) => {
    await page.setViewportSize({ width: 705, height: 412 });
    await mountUsageRates(page);

    const activeServices = page.getByTestId("credits-active-services-table");
    const promptUsage = page.getByTestId("credits-prompt-usage-table");
    await expect(activeServices).toBeVisible();
    await expect(promptUsage).toBeVisible();
    await expect(page.getByTestId("credits-active-services-mobile")).toBeHidden();
    await expect(page.getByTestId("credits-prompt-usage-mobile")).toBeHidden();
    await expect(activeServices).toContainText("Service");
    await expect(promptUsage).toContainText("Daily cap");
    await expectNoHorizontalOverflow(page);
  });

  test("uses stacked details in a narrow Credits pane within a wide viewport", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await mountUsageRates(page, { containerWidth: 326 });

    await expect(page.getByTestId("credits-usage-fixture-container")).toHaveCSS("width", "326px");
    await expect(page.getByTestId("credits-active-services-mobile")).toBeVisible();
    await expect(page.getByTestId("credits-prompt-usage-mobile")).toBeVisible();
    await expect(page.getByTestId("credits-active-services-table")).toBeHidden();
    await expect(page.getByTestId("credits-prompt-usage-table")).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });
});
