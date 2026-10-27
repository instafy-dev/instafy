import { expect, test, type Page } from "@playwright/test";
import { RUN_STOP_FIXTURE_STUBS } from "../../fixtures/run-stop-control/dataStubs";

const FIXTURE = "/tests/fixtures/run-stop-control/index.html";
const OCTO_JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SCRIBE_JOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function openFixture(page: Page, scenario = "thinking") {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  for (const [path, body] of Object.entries(RUN_STOP_FIXTURE_STUBS)) {
    await page.route(`**${path}*`, route => route.fulfill({ contentType: "application/javascript", body }));
  }
  await page.goto(FIXTURE);
  await expect(page.getByRole("heading", { name: "Run Stop playground" }), errors.join("; ")).toBeVisible();
  if (scenario !== "thinking") await page.getByRole("combobox", { name: "Scenario" }).selectOption(scenario);
  return errors;
}

async function requests(page: Page): Promise<string[][]> {
  return JSON.parse(await page.getByTestId("cancel-requests").textContent() ?? "[]");
}

async function expectRequestCount(page: Page, count: number) {
  await expect(page.getByTestId("cancel-request-count")).toHaveText(`Cancel requests: ${count}`);
}

for (const scenario of ["thinking", "rail", "command"]) {
  test(`one icon-only Stop lives in the composer during ${scenario} and updates immediately`, async ({ page }) => {
    test.setTimeout(60_000);
    const errors = await openFixture(page, scenario);
    const stop = page.getByTestId("chat-run-stop-button");
    await expect(stop).toHaveCount(1);
    await expect(stop).toHaveAccessibleName("Stop");
    await expect(page.getByTestId("composer-preview").getByTestId("chat-run-stop-button")).toHaveCount(1);
    await expect(page.getByTestId("stop-preview").getByTestId("chat-run-stop-button")).toHaveCount(0);
    await expect(stop.getByText("Stop", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("chat-send-button")).toHaveCount(0);
    if (scenario === "thinking") await expect(page.getByTestId("turn-activity-line")).toHaveCount(0);
    await stop.click();
    await expect(stop).toHaveAccessibleName("Stopping…");
    await expect(stop).toBeDisabled();
    await page.keyboard.press("Escape");
    await expectRequestCount(page, 1);
    await expect(page.getByTestId("simulation-finished")).toBeVisible();
    await expect(stop).toHaveCount(0);
    await expect(page.getByTestId("chat-send-button")).toBeVisible();
    expect(await requests(page)).toEqual([[OCTO_JOB]]);
    expect(errors).toEqual([]);
  });
}

test("drafts keep their text and Send action while Stop remains a separate composer control", async ({ page }) => {
  const errors = await openFixture(page, "rail");
  const editor = page.getByRole("textbox", { name: "Ask Octo" });
  const draft = "Keep my unfinished next instruction";
  await editor.fill(draft);
  await expect(page.getByTestId("composer-draft")).toHaveText(draft);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled();
  await expect(page.getByTestId("chat-run-stop-button")).toHaveCount(1);
  await page.getByTestId("chat-run-stop-button").click();
  await expect(page.getByTestId("simulation-finished")).toBeVisible();
  await expect(editor).toHaveText(draft);
  await expect(page.getByTestId("sent-messages")).toHaveText("[]");
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("sent-messages")).toHaveText(JSON.stringify([draft]));
  await expect(editor).toHaveText("");
  expect(errors).toEqual([]);
});

test("active voice capture keeps its microphone when a run can be stopped", async ({ page }) => {
  const errors = await openFixture(page, "recording");
  await expect(page.getByTestId("chat-voice-input-button")).toBeVisible();
  await expect(page.getByTestId("composer-preview").getByTestId("chat-run-stop-button")).toHaveCount(1);
  await expect(page.getByTestId("chat-send-button")).toHaveCount(0);
  await expect(page.getByTestId("stop-preview").getByTestId("chat-run-stop-button")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("two agents share one target menu; Escape dismisses it before stopping both", async ({ page }) => {
  const errors = await openFixture(page, "two");
  const stop = page.getByTestId("chat-run-stop-button");
  await expect(stop).toHaveCount(1);
  await stop.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Stop Octo", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Stop Scribe", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Stop both", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expectRequestCount(page, 0);
  await stop.click();
  await page.getByRole("menuitem", { name: "Stop Octo", exact: true }).click();
  await expectRequestCount(page, 1);
  await expect(stop).toHaveAccessibleName("Stop");
  expect(await requests(page)).toEqual([[OCTO_JOB]]);
  await page.keyboard.press("Escape");
  await expectRequestCount(page, 2);
  expect(await requests(page)).toEqual([[OCTO_JOB], [SCRIBE_JOB]]);
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await page.keyboard.press("Escape");
  await expectRequestCount(page, 1);
  expect(await requests(page)).toEqual([[OCTO_JOB, SCRIBE_JOB]]);
  expect(errors).toEqual([]);
});

test("composer slash menu and dialog Escape handlers take precedence, and opening Details is not a stop", async ({ page }) => {
  const errors = await openFixture(page, "rail");
  await page.getByRole("button", { name: "Open dialog", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Preview dialog" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expectRequestCount(page, 0);
  const editor = page.getByRole("textbox", { name: "Ask Octo" });
  await editor.fill("/");
  await expect(page.getByTestId("chat-slash-command-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-slash-command-menu")).toHaveCount(0);
  await expectRequestCount(page, 0);
  await expect(editor).toHaveText("/");
  await editor.fill("");
  await page.getByTestId("turn-activity-line").click();
  await expect(page.getByTestId("turn-activity-details")).toBeVisible();
  await expectRequestCount(page, 0);
  await page.keyboard.press("Escape");
  await expectRequestCount(page, 1);
  expect(errors).toEqual([]);
});

test("read-only and lingering snapshots expose no Stop action", async ({ page }) => {
  const errors = await openFixture(page, "viewer");
  await expect(page.getByTestId("assistant-typing-indicator")).toBeVisible();
  await expect(page.getByTestId("chat-run-stop-button")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expectRequestCount(page, 0);
  await page.getByRole("combobox", { name: "Scenario" }).selectOption("thinking");
  await expect(page.getByTestId("chat-run-stop-button")).toBeVisible();
  await page.getByRole("button", { name: "Simulate completion", exact: true }).click();
  await expect(page.getByTestId("assistant-typing-indicator")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByTestId("chat-run-stop-button")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expectRequestCount(page, 0);
  expect(errors).toEqual([]);
});

test("another person's turn requires confirmation for click and Escape", async ({ page }) => {
  const errors = await openFixture(page, "other");
  await page.getByTestId("chat-run-stop-button").click();
  const dialog = page.getByRole("dialog", { name: "Stop another person's turn?" });
  await expect(dialog).toBeVisible();
  await expectRequestCount(page, 0);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expectRequestCount(page, 0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expectRequestCount(page, 0);
  await dialog.getByRole("button", { name: "Stop Octo", exact: true }).click();
  await expectRequestCount(page, 1);
  expect(await requests(page)).toEqual([[OCTO_JOB]]);
  expect(errors).toEqual([]);
});

test("failure retries exact jobs; stale completion and accepted requests are distinct", async ({ page }) => {
  const errors = await openFixture(page, "failure");
  await page.getByTestId("chat-run-stop-button").click();
  await expect(page.getByRole("button", { name: "Retry stop", exact: true })).toBeVisible();
  await expect(page.getByTestId("chat-run-stop-error")).toContainText("Simulated connection failure");
  await page.getByRole("button", { name: "Retry stop", exact: true }).click();
  await expectRequestCount(page, 2);
  expect(await requests(page)).toEqual([[OCTO_JOB], [OCTO_JOB]]);
  await page.getByRole("combobox", { name: "Scenario" }).selectOption("stale");
  await page.getByTestId("chat-run-stop-button").click();
  await expect(page.getByTestId("simulation-finished")).toBeVisible();
  await expect(page.getByTestId("chat-run-stop-error")).toHaveCount(0);
  await page.getByRole("combobox", { name: "Scenario" }).selectOption("requested");
  await page.getByTestId("chat-run-stop-button").click();
  await expect(page.getByRole("button", { name: "Stop requested", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expectRequestCount(page, 1);
  await page.getByRole("button", { name: "Simulate completion", exact: true }).click();
  await expect(page.getByTestId("chat-run-stop-button")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("the persisted notice continues with one fresh targeted turn", async ({ page }) => {
  const errors = await openFixture(page);
  await page.getByTestId("chat-run-stop-button").click();
  await expect(page.getByTestId("chat-run-stop-notice")).toContainText("You asked Octo to stop.");
  const continueButton = page.getByTestId("chat-run-stop-continue");
  await expect(continueButton).toBeVisible();
  await continueButton.click();
  await expect(continueButton).toHaveCount(0);
  await expect(page.getByTestId("chat-run-stop-button")).toHaveAccessibleName("Stop");
  expect(JSON.parse(await page.getByTestId("continuation-requests").textContent() ?? "[]")).toEqual([["octo"]]);
  await page.getByTestId("chat-run-stop-button").click();
  await expectRequestCount(page, 2);
  const submitted = await requests(page);
  expect(submitted[0]).toEqual([OCTO_JOB]);
  expect(submitted[1]).toHaveLength(1);
  expect(submitted[1][0]).not.toBe(OCTO_JOB);
  expect(errors).toEqual([]);
});

test("an unacknowledged request times out with explicit retry", async ({ page }) => {
  const errors = await openFixture(page, "timeout");
  await page.clock.install();
  await page.getByTestId("chat-run-stop-button").click();
  await expect(page.getByRole("button", { name: "Stopping…", exact: true })).toBeDisabled();
  await page.clock.fastForward(20_001);
  await expect(page.getByRole("button", { name: "Retry stop", exact: true })).toBeEnabled();
  await expect(page.getByTestId("chat-run-stop-error")).toContainText("may still take effect");
  await expectRequestCount(page, 1);
  expect(errors).toEqual([]);
});

test.describe("true touch Stop target", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test("remains reachable for empty and drafted composers, two agents and both themes", async ({ page }) => {
    const errors = await openFixture(page, "rail");
    for (const theme of ["Dark", "Light"]) {
      await page.getByRole("radiogroup", { name: "Preview theme" }).getByText(theme, { exact: true }).click();
      await expect(page.getByTestId("stop-preview").getByTestId("chat-run-stop-button")).toHaveCount(0);
      const stop = page.getByTestId("chat-run-stop-button");
      const geometry = await stop.evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height, right: rect.right, viewport: innerWidth,
          pageWidth: document.documentElement.scrollWidth, coarse: matchMedia("(pointer: coarse)").matches };
      });
      expect(geometry.coarse).toBe(true);
      expect(geometry.width).toBeGreaterThanOrEqual(44);
      expect(geometry.height).toBeGreaterThanOrEqual(44);
      expect(geometry.right).toBeLessThanOrEqual(390);
      expect(geometry.pageWidth).toBe(geometry.viewport);
    }
    const editor = page.getByRole("textbox", { name: "Ask Octo" });
    await editor.fill("A draft to keep on my phone");
    const stopBounds = (await page.getByTestId("chat-run-stop-button").boundingBox())!;
    const sendBounds = (await page.getByTestId("chat-send-button").boundingBox())!;
    expect(stopBounds.width).toBeGreaterThanOrEqual(44);
    expect(stopBounds.x + stopBounds.width).toBeLessThanOrEqual(sendBounds.x);
    await page.getByTestId("chat-run-stop-button").tap();
    await expectRequestCount(page, 1);
    await expect(page.getByTestId("simulation-finished")).toBeVisible();
    await expect(editor).toHaveText("A draft to keep on my phone");
    expect(await requests(page)).toEqual([[OCTO_JOB]]);
    await page.getByRole("combobox", { name: "Scenario" }).selectOption("failure");
    await page.getByTestId("chat-run-stop-button").tap();
    await expect(page.getByTestId("chat-run-stop-error")).toBeVisible();
    const errorBounds = (await page.getByTestId("chat-run-stop-error").boundingBox())!;
    const composerBounds = (await page.getByTestId("composer-preview").boundingBox())!;
    expect(errorBounds.x + errorBounds.width).toBeLessThanOrEqual(composerBounds.x + composerBounds.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.getByRole("combobox", { name: "Scenario" }).selectOption("two");
    await page.getByTestId("chat-run-stop-button").tap();
    await page.getByRole("menuitem", { name: "Stop both", exact: true }).tap();
    await expectRequestCount(page, 1);
    expect(await requests(page)).toEqual([[OCTO_JOB, SCRIBE_JOB]]);
    expect(errors).toEqual([]);
  });
});
