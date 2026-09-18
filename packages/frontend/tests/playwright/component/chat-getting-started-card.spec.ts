import { expect, test, type Page } from "@playwright/test";

import { resolveViteReactDependencies } from "./viteComponentDependencies.js";

const FIXTURE_PATH = "/__chat-getting-started-card-fixture__";

async function mountGettingStartedCard(
  page: Page,
  options: {
    managedAiOffer?: {
      label: string;
      dailyPromptLimit: number;
      remainingPrompts: number | null;
      creditBurnAmount?: number;
      paused?: boolean;
    } | null;
    selectedAi?: "managed" | "connected" | null;
    connectedAiLabel?: string | null;
    collapsed?: boolean;
    canChangeAiChoice?: boolean;
    aiViewState?: "resolving" | "choice" | "workspace";
    personalAiConnectionState?: "missing" | "needs_default" | null;
  } = {},
): Promise<void> {
  const deps = await resolveViteReactDependencies(page);
  const managedAiOffer =
    options.managedAiOffer === undefined
      ? { label: "Instafy AI", dailyPromptLimit: 20, remainingPrompts: 7, creditBurnAmount: 1, paused: false }
      : options.managedAiOffer === null
        ? null
        : { creditBurnAmount: 1, paused: false, ...options.managedAiOffer };
  const selectedAi = options.selectedAi ?? null;
  const connectedAiLabel = options.connectedAiLabel ?? null;
  const collapsed = options.collapsed ?? false;
  const canChangeAiChoice = options.canChangeAiChoice ?? false;
  const aiViewState = options.aiViewState ?? "choice";
  const personalAiConnectionState =
    options.personalAiConnectionState === undefined
      ? aiViewState === "choice"
        ? "missing"
        : null
      : options.personalAiConnectionState;
  const main = `
    import "/src/styles/tailwind.css";
    import ReactNS from "${deps.react}";
    import ReactDomClientNS from "${deps.reactDomClient}";
    import { ChatGettingStartedCard } from "/src/screens/studio/components/ChatGettingStartedCard.tsx";
    const React = ReactNS.default ?? ReactNS;
    const { createRoot } = ReactDomClientNS.default ?? ReactDomClientNS;
    const h = React.createElement;
    window.__onboardingActions = [];
    createRoot(document.getElementById("root")).render(
      h("main", {
        className: "overflow-hidden bg-slate-100 p-3 dark:bg-slate-900",
        style: { height: "100dvh" },
      },
        h("div", {
          className: "h-full overflow-y-auto",
          "data-testid": "onboarding-scroll-container",
        },
          h(ChatGettingStartedCard, {
            mode: "root",
            collapsed: ${JSON.stringify(collapsed)},
            onSelectMode: (mode) => window.__onboardingActions.push(["mode", mode]),
            onSelectConnector: (connector) => window.__onboardingActions.push(["connector", connector.id]),
            onBrowseConnectors: () => window.__onboardingActions.push(["browse"]),
            installedSkillNames: new Set(),
            showConnectTools: true,
            managedAiOffer: ${JSON.stringify(managedAiOffer)},
            selectedAi: ${JSON.stringify(selectedAi)},
            connectedAiLabel: ${JSON.stringify(connectedAiLabel)},
            aiViewState: ${JSON.stringify(aiViewState)},
            canChangeAiChoice: ${JSON.stringify(canChangeAiChoice)},
            personalAiConnectionState: ${JSON.stringify(personalAiConnectionState)},
            onStartWithManagedAi: () => window.__onboardingActions.push(["managed"]),
            onConnectOwnAi: () => window.__onboardingActions.push(["connect"]),
            onChangeAiChoice: () => window.__onboardingActions.push(["change-ai"]),
            githubRepoDraft: "",
            githubRefDraft: "",
            githubImportBusy: false,
            githubImportElapsedSeconds: 0,
            githubImportError: null,
            githubDeviceAuthSession: null,
            githubDeviceAuthError: null,
            onGithubRepoDraftChange: () => {},
            onGithubRefDraftChange: () => {},
            onBeginGithubDeviceAuth: () => {},
            onCancelGithubDeviceAuth: () => {},
            onImportGithub: () => {},
          }),
        ),
      ),
    );
    window.__mounted = true;`;

  const html = `<!doctype html><html><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
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

  await page.route(`**${FIXTURE_PATH}`, (route) =>
    route.fulfill({ contentType: "text/html", body: html }),
  );
  await page.route(`**${FIXTURE_PATH}/main.js`, (route) =>
    route.fulfill({ contentType: "application/javascript", body: main }),
  );

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(FIXTURE_PATH);
  await page.waitForFunction(() => (window as { __mounted?: boolean }).__mounted === true, {
    timeout: 20_000,
  });
  expect(errors, errors.join("; ")).toEqual([]);
}

test.describe("chat getting-started card", () => {
  test("keeps AI choices immediate and task ideas opt-in on a narrow phone", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 480 });
    await mountGettingStartedCard(page);

    const card = page.getByTestId("onboarding-getting-started");
    const scrollContainer = page.getByTestId("onboarding-scroll-container");
    await expect(card).toBeVisible();
    await expect(card.getByText("Choose your AI", { exact: true })).toBeInViewport();
    await expect(card.getByTestId("onboarding-use-managed-ai")).toContainText(
      "7 of 20 free prompts left today",
    );
    await expect(card.getByTestId("onboarding-connect-own-ai")).toContainText("Connect AI");
    await expect(card).not.toContainText("Bring my own AI");
    // The workspace step is gated behind the AI choice: one decision at a time.
    await expect(card.getByTestId("onboarding-workspace-step")).toHaveCount(0);
    await expect(card.getByTestId("connect-chip-strip")).toHaveCount(0);

    const geometry = await page.evaluate(() => {
      const cardElement = document.querySelector<HTMLElement>(
        '[data-testid="onboarding-getting-started"]',
      );
      const scrollElement = document.querySelector<HTMLElement>(
        '[data-testid="onboarding-scroll-container"]',
      );
      if (!cardElement || !scrollElement) {
        return null;
      }
      const cardRect = cardElement.getBoundingClientRect();
      const scrollRect = scrollElement.getBoundingClientRect();
      return {
        cardLeft: cardRect.left,
        cardRight: cardRect.right,
        cardTop: cardRect.top,
        scrollLeft: scrollRect.left,
        scrollRight: scrollRect.right,
        scrollTop: scrollRect.top,
        scrollHeight: scrollElement.scrollHeight,
        clientHeight: scrollElement.clientHeight,
        documentWidth: document.documentElement.scrollWidth,
      };
    });

    expect(geometry).not.toBeNull();
    expect(geometry!.cardLeft).toBeGreaterThanOrEqual(geometry!.scrollLeft - 1);
    expect(geometry!.cardRight).toBeLessThanOrEqual(geometry!.scrollRight + 1);
    expect(geometry!.cardTop).toBeGreaterThanOrEqual(geometry!.scrollTop - 1);
    expect(geometry!.scrollHeight).toBeLessThanOrEqual(geometry!.clientHeight + 1);
    expect(geometry!.documentWidth).toBeLessThanOrEqual(360);
    await expect(scrollContainer).toHaveJSProperty("scrollTop", 0);

    await card.getByTestId("onboarding-connect-own-ai").click();
    await expect
      .poll(() => page.evaluate(() => (window as { __onboardingActions?: unknown[] }).__onboardingActions))
      .toContainEqual(["connect"]);
  });

  test("keeps both decision steps unavailable while AI setup resolves", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mountGettingStartedCard(page, { aiViewState: "resolving" });

    const card = page.getByTestId("onboarding-getting-started");
    await expect(card.getByTestId("onboarding-ai-resolving")).toContainText(
      "Checking your AI setup",
    );
    await expect(card.getByTestId("onboarding-use-managed-ai")).toHaveCount(0);
    await expect(card.getByTestId("onboarding-connect-own-ai")).toHaveCount(0);
    await expect(card.getByTestId("onboarding-workspace-step")).toHaveCount(0);
  });

  test("uses two AI columns at desktop width", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await mountGettingStartedCard(page);

    const managedBox = await page.getByTestId("onboarding-use-managed-ai").boundingBox();
    const connectBox = await page.getByTestId("onboarding-connect-own-ai").boundingBox();
    const cardBox = await page.getByTestId("onboarding-getting-started").boundingBox();
    expect(managedBox).not.toBeNull();
    expect(connectBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    expect(Math.abs(managedBox!.y - connectBox!.y)).toBeLessThanOrEqual(1);
    expect(cardBox!.width).toBeLessThanOrEqual(560);
  });

  test("offers one wrapping row of live tools when AI is already connected", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mountGettingStartedCard(page, {
      selectedAi: "connected",
      aiViewState: "workspace",
    });

    const card = page.getByTestId("onboarding-getting-started");
    await expect(card.getByTestId("onboarding-ai-choice")).toHaveCount(0);
    await expect(card).toContainText("Using your connected AI");
    await expect(card.getByTestId("onboarding-change-ai")).toHaveCount(0);
    await expect(card.getByText("Start with a tool you already use", { exact: true })).toBeVisible();
    // Every featured tool that can be picked today: GitHub first because it
    // needs no key pasted, then Notion and FreeFinance, then the More tools
    // link. Nothing pending is named here and nothing is disabled.
    await expect(card.getByTestId("connect-coming-soon")).toHaveCount(0);
    await expect(card.locator('button[data-testid^="connect-chip-"]')).toHaveCount(3);
    await expect(card.getByTestId("connect-chip-github")).toBeEnabled();
    await expect(card.getByTestId("connect-chip-notion")).toBeEnabled();
    await expect(card.getByTestId("connect-chip-freefinance")).toBeEnabled();
    await expect(card).not.toContainText("Soon");
    await expect(card.getByTestId("connect-more-tools")).toBeVisible();
    // The action cards and their vocabulary are gone.
    await expect(card.getByTestId("onboarding-action-import-github-repo")).toHaveCount(0);
    await expect(card.getByTestId("onboarding-action-start-from-scratch")).toHaveCount(0);
    await expect(card).not.toContainText("Start from scratch");
    await expect(card).not.toContainText("Connect a tool");
    await expect(card.getByTestId("onboarding-type-hint")).toHaveText(
      "Or just type what you want below.",
    );

    // One line at 375: the chips and the link share a row, and the card is
    // far shorter than the two stacked action cards it replaces.
    const boxes = await Promise.all([
      card.getByTestId("connect-chip-github").boundingBox(),
      card.getByTestId("connect-chip-notion").boundingBox(),
      card.getByTestId("connect-chip-freefinance").boundingBox(),
      card.getByTestId("connect-more-tools").boundingBox(),
    ]);
    for (const box of boxes) {
      expect(box).not.toBeNull();
    }
    // Centres, not top edges: the bordered chip is two pixels taller than the
    // borderless link, so equal tops would mean the link hangs low. Sharing a
    // centre line is what "one row" means for controls of different heights.
    const centres = boxes.map((box) => box!.y + box!.height / 2);
    expect(Math.abs(centres[0]! - centres[1]!)).toBeLessThanOrEqual(1);
    expect(Math.abs(centres[0]! - centres[2]!)).toBeLessThanOrEqual(1);
    const cardBox = await card.boundingBox();
    expect(cardBox!.height).toBeLessThanOrEqual(200);
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(375);
  });

  test("routes the card's GitHub chip to the import mode, never through connector routing", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mountGettingStartedCard(page, {
      selectedAi: "connected",
      aiViewState: "workspace",
    });

    const card = page.getByTestId("onboarding-getting-started");
    await expect(card.getByTestId("connect-chip-github")).toHaveAttribute(
      "aria-label",
      "Import from GitHub",
    );
    await card.getByTestId("connect-chip-github").click();
    // The host is told to switch mode. Reporting it as a connector instead
    // would reach beginGithubImport, whose force flag overrides every later
    // show gate, including dismissal.
    await expect
      .poll(() => page.evaluate(() => (window as { __onboardingActions?: unknown[] }).__onboardingActions))
      .toContainEqual(["mode", "github"]);
    const reported = await page.evaluate(
      () => (window as { __onboardingActions?: unknown[][] }).__onboardingActions ?? [],
    );
    expect(reported.filter((entry) => entry[0] === "connector")).toEqual([]);

    await card.getByTestId("connect-chip-notion").click();
    await expect
      .poll(() => page.evaluate(() => (window as { __onboardingActions?: unknown[] }).__onboardingActions))
      .toContainEqual(["connector", "notion"]);
  });

  test("names the selected free AI and exposes the real change action", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mountGettingStartedCard(page, {
      selectedAi: "managed",
      canChangeAiChoice: true,
      aiViewState: "workspace",
    });

    const card = page.getByTestId("onboarding-getting-started");
    await expect(card.getByTestId("onboarding-ai-status")).toHaveText(
      "Using free Instafy AI: 20 prompts a day, 1 credit each·Change AI",
    );
    await expect(card).not.toContainText("Using your connected AI");
    await card.getByTestId("onboarding-change-ai").click();
    await expect
      .poll(() => page.evaluate(() => (window as { __onboardingActions?: unknown[] }).__onboardingActions))
      .toContainEqual(["change-ai"]);
  });

  test("shows an exhausted live allowance without promising it can start", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mountGettingStartedCard(page, {
      managedAiOffer: {
        label: "Instafy AI",
        dailyPromptLimit: 20,
        remainingPrompts: 0,
      },
    });

    const card = page.getByTestId("onboarding-getting-started");
    await expect(card).toContainText("Today's free prompts are used (20/day).");
    await expect(card).toContainText("Connect your own AI to keep going");
    await expect(card.getByTestId("onboarding-use-managed-ai")).toBeDisabled();
    await expect(card.getByTestId("onboarding-connect-own-ai")).toBeEnabled();
  });

  test("uses the full AI row for a connect-only state", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await mountGettingStartedCard(page, { managedAiOffer: null });

    const connectBox = await page.getByTestId("onboarding-connect-own-ai").boundingBox();
    const choiceBox = await page.getByTestId("onboarding-ai-choice").boundingBox();
    expect(connectBox).not.toBeNull();
    expect(choiceBox).not.toBeNull();
    expect(connectBox!.width).toBeGreaterThan(choiceBox!.width * 0.85);
  });

  test("surfaces choosing a default for an already-saved connection", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mountGettingStartedCard(page, {
      managedAiOffer: null,
      personalAiConnectionState: "needs_default",
    });

    await expect(page.getByTestId("onboarding-choose-connected-ai")).toContainText(
      "Choose connected AI",
    );
    await expect(page.getByTestId("onboarding-connect-own-ai")).toHaveCount(0);
  });

  test("names the saved connection and routes Change AI for it", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mountGettingStartedCard(page, {
      selectedAi: "connected",
      connectedAiLabel: "Local Codex login (dev)",
      canChangeAiChoice: true,
      aiViewState: "workspace",
    });

    const card = page.getByTestId("onboarding-getting-started");
    await expect(card.getByTestId("onboarding-ai-status")).toHaveText(
      "Using Local Codex login (dev)·Change AI",
    );
    await expect(card).not.toContainText("\u2014");
    await card.getByTestId("onboarding-change-ai").click();
    await expect
      .poll(() => page.evaluate(() => (window as { __onboardingActions?: unknown[] }).__onboardingActions))
      .toContainEqual(["change-ai"]);
  });

  test("keeps the AI step a choice with one Connect AI button while the free tier is paused", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mountGettingStartedCard(page, {
      managedAiOffer: { label: "Instafy AI", dailyPromptLimit: 20, remainingPrompts: 7, paused: true },
    });

    const card = page.getByTestId("onboarding-getting-started");
    await expect(card.getByText("Choose your AI", { exact: true })).toBeVisible();
    await expect(card.getByTestId("onboarding-ai-choice-line")).toHaveText(
      "Free Instafy AI is paused right now. Connect your own AI to start; you pay your provider directly and Instafy adds nothing.",
    );
    await expect(card.getByTestId("onboarding-use-managed-ai")).toHaveCount(0);
    await expect(card.getByTestId("onboarding-ai-choice").getByRole("button")).toHaveCount(1);
    await expect(card.getByTestId("onboarding-connect-own-ai")).toContainText("Connect AI");
    const connectBox = await card.getByTestId("onboarding-connect-own-ai").boundingBox();
    const choiceBox = await card.getByTestId("onboarding-ai-choice").boundingBox();
    expect(connectBox!.width).toBeGreaterThan(choiceBox!.width * 0.85);
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(375);
  });

  test("collapses to one row of ghost buttons while a draft exists, on the phone too", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mountGettingStartedCard(page, {
      collapsed: true,
      selectedAi: "connected",
      connectedAiLabel: "Local Codex login (dev)",
      canChangeAiChoice: true,
      aiViewState: "workspace",
    });

    const card = page.getByTestId("onboarding-getting-started");
    await expect(card).toHaveAttribute("data-collapsed", "true");
    await expect(card.getByRole("heading")).toHaveCount(0);
    await expect(card.getByTestId("onboarding-ai-status")).toHaveCount(0);
    const row = card.getByTestId("onboarding-collapsed-row");
    await expect(row.getByRole("button")).toHaveText([
      "Import a repo",
      "Notion",
      "More tools",
    ]);
    const boxes = await Promise.all(
      (await row.getByRole("button").all()).map((button) => button.boundingBox()),
    );
    for (const box of boxes) {
      expect(box).not.toBeNull();
    }
    // One row: every button sits on the same line.
    expect(Math.abs(boxes[0]!.y - boxes[2]!.y)).toBeLessThanOrEqual(1);
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth).toBeLessThanOrEqual(375);
    await row.getByRole("button", { name: "Notion" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as { __onboardingActions?: unknown[] }).__onboardingActions))
      .toContainEqual(["connector", "notion"]);
    await row.getByRole("button", { name: "Import a repo" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as { __onboardingActions?: unknown[] }).__onboardingActions))
      .toContainEqual(["mode", "github"]);
  });

  test("describes a non-positive daily cap as uncapped", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await mountGettingStartedCard(page, {
      managedAiOffer: {
        label: "Instafy AI",
        dailyPromptLimit: 0,
        remainingPrompts: null,
      },
    });

    await expect(page.getByTestId("onboarding-use-managed-ai")).toContainText(
      "No daily prompt cap.",
    );
  });
});
