import { expect, test, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { expectPointerCapability } from "./inputEmulation";

const baseline = process.env.INSTAFY_REVIEW_CAPTURE === "before";
test.beforeEach(async ({ page, hasTouch }) => expectPointerCapability(page, hasTouch ?? false));
async function inViewport(locator: Locator, width: number) {
  await expect(locator).toBeVisible();
  const bounds = (await locator.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(-1);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(width + 1);
}
async function keyboardOpen(page: Page, locator: Locator) {
  await locator.focus();
  await page.keyboard.press("Enter");
}

for (const { width, hasTouch } of [{ width: 390, hasTouch: true }, { width: 1280, hasTouch: false }, { width: 2560, hasTouch: false }]) {
  test.describe(`${width}px`, () => {
    test.use({ hasTouch, viewport: { width, height: 900 } });
    for (const theme of ["Light", "Dark"]) test(`${theme} dialogs, navigation and feedback`, async ({ page }, testInfo) => {
      const errors: string[] = [];
      const externalRequests: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => { if (/^https?:/.test(request.url()) && !/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(request.url())) externalRequests.push(request.url()); });
      await page.goto("/tests/fixtures/dialogs-feedback/index.html");
      await page.getByRole("radiogroup", { name: "Theme" }).getByText(theme, { exact: true }).click();
      const capture = async (name: string) => {
        const folder = process.env.INSTAFY_REVIEW_SCREENSHOTS;
        if (folder) await fs.mkdir(folder, { recursive: true });
        await page.screenshot({ animations: "disabled", path: folder ? path.join(folder, `${width}-${theme.toLowerCase()}-${name}.png`) : testInfo.outputPath(`${name}.png`) });
      };

      const historyTrigger = page.getByTestId("open-history");
      await historyTrigger.click();
      const history = page.getByRole("dialog", { name: /Remove history entry/ });
      await inViewport(history, width);
      await expect(page.getByTestId("review-history-confirm-cancel")).toBeFocused();
      await capture("history-confirm");
      await page.keyboard.press("Escape");
      await expect(history).toHaveCount(0);
      await expect(historyTrigger).toBeFocused();

      const agentTrigger = page.getByTestId("open-agent");
      await agentTrigger.click();
      const displayName = page.getByTestId("agent-profile-display-name-input");
      await displayName.fill("Writing assistant draft");
      await inViewport(page.getByRole("dialog", { name: "Edit agent", exact: true }), width);
      await capture("agent-profile");
      await page.setViewportSize({ width, height: 420 });
      const save = page.getByTestId("agent-profile-save");
      await inViewport(save, width);
      expect((await save.boundingBox())!.y + (await save.boundingBox())!.height).toBeLessThanOrEqual(420);
      await expect(displayName).toHaveValue("Writing assistant draft");
      await page.setViewportSize({ width, height: 900 });
      await page.getByTestId("agent-profile-description-input").fill("Keep replies concise and include clear next steps.");
      await capture("agent-behavior");
      await save.click();
      await expect(page.getByRole("dialog", { name: "Edit agent", exact: true })).toHaveCount(0);
      await expect(agentTrigger).toBeFocused();
      await expect(page.getByTestId("review-status")).toContainText("Agent saved");

      const inviteTrigger = page.getByTestId("open-invite");
      await inviteTrigger.click();
      const invite = page.getByTestId("chat-invite-modal");
      await inViewport(invite, width);
      await capture("invite");
      const email = page.getByTestId("composer-invite-email-input");
      await email.fill("teammate@example.test");
      await page.setViewportSize({ width, height: 420 });
      await expect(email).toHaveValue("teammate@example.test");
      await email.scrollIntoViewIfNeeded();
      await inViewport(email, width);
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "Close invite modal", exact: true }).click();
      await expect(inviteTrigger).toBeFocused();
      await inviteTrigger.click();
      await email.fill("teammate@example.test");
      await page.getByTestId("composer-device-handoff-show-qr").click();
      const qr = page.getByRole("dialog", { name: "Invite QR code", exact: true });
      await expect(qr).toBeVisible();
      // React Aria makes the underlying modal inert. This Playwright version's
      // role locator still matches inert nodes, so inspect Chrome's actual AX tree.
      const accessibility = await page.context().newCDPSession(page);
      await expect.poll(async () => {
        const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
        return nodes.filter(node => !node.ignored && node.role?.value === "dialog").map(node => node.name?.value);
      }).toEqual(["Invite QR code"]);
      // Keep this read-only session until context teardown: detaching a CDP
      // session can reset Chromium's touch emulation for the remaining checks.
      await page.getByRole("button", { name: "Close QR code", exact: true }).click();
      await expect(qr).toHaveCount(0);
      if (!baseline) await expect(page.getByTestId("composer-device-handoff-show-qr")).toBeFocused();
      await expect(email).toHaveValue("teammate@example.test");
      await page.getByRole("button", { name: "Close invite modal", exact: true }).click();
      await expect(invite).toHaveCount(0);
      if (!baseline) await expect(inviteTrigger).toBeFocused();

      // A private chat starts from the invite menu of an ordinary chat, with its teammate.
      const publicInviteTrigger = page.getByTestId("open-invite-public");
      await publicInviteTrigger.click();
      await inViewport(invite, width);
      const startPrivate = page.getByRole("button", { name: "Start a private chat with Taylor Morgan", exact: true });
      await startPrivate.scrollIntoViewIfNeeded();
      await inViewport(startPrivate, width);
      await capture("invite-start-private-chat");
      await startPrivate.click();
      await expect(invite).toHaveCount(0);
      await expect(page.getByTestId("review-status")).toContainText("Private chat selected: Taylor Morgan");

      // New chat makes a chat at once: no Public or Private menu.
      await page.getByRole("button", { name: "Navigation", exact: true }).click();
      const newChat = page.getByTestId("topbar-new-conversation");
      await keyboardOpen(page, newChat);
      await expect(page.getByTestId("review-status")).toContainText("New chat selected in local review.");
      await expect(page.getByRole("dialog")).toHaveCount(0);

      const spaces = page.getByTestId("sidebar-space-button");
      await keyboardOpen(page, spaces);
      await inViewport(page.getByTestId("sidebar-recent-spaces-popover"), width);
      await capture("space-picker");
      await page.getByTestId("sidebar-space-search").fill("Research");
      await page.getByTestId("sidebar-recent-space-space-5").click();
      await expect(spaces).toContainText("Research");
      await expect(spaces).toBeFocused();
      const more = page.getByTestId("mobile-header-more");
      await keyboardOpen(page, more);
      await inViewport(page.getByTestId("mobile-header-actions"), width);
      await capture("compact-more");
      await page.keyboard.press("Escape");
      await expect(more).toBeFocused();

      await page.getByRole("button", { name: "Feedback", exact: true }).click();
      await expect(page.getByTestId("org-invite-role-conflict")).toBeVisible();
      await capture("invite-conflict");
      await page.getByTestId("org-invite-role-conflict-dismiss").click();
      await expect(page.getByTestId("org-invite-role-conflict")).toHaveCount(0);
      await page.getByTestId("feedback-scenarios").getByRole("button", { name: "Pending", exact: true }).click();
      await expect(page.getByTestId("org-invite-role-conflict-apply")).toBeDisabled();
      await expect(page.getByTestId("org-invite-role-conflict-dismiss")).toBeDisabled();
      await page.getByTestId("feedback-scenarios").getByRole("button", { name: "Error", exact: true }).click();
      await expect(page.getByText("Invitations could not be loaded. Try again later.", { exact: true })).toBeVisible();
      if (!baseline) await expect(page.getByRole("alert")).toContainText("Invitations could not be loaded");
      await capture("settings-error");
      await page.getByTestId("feedback-scenarios").getByRole("button", { name: "Loading", exact: true }).click();
      await expect(page.getByText("Loading invitations…", { exact: true })).toBeVisible();
      if (!baseline) await expect(page.getByRole("status").filter({ hasText: "Loading invitations…" })).toBeVisible();
      expect(errors).toEqual([]);
      expect(externalRequests).toEqual([]);
    });
  });
}

for (const width of [320, 390]) test(`${width}px long feedback and short navigation keep actions reachable`, async ({ page }) => {
  await page.setViewportSize({ width, height: 568 });
  await page.goto("/tests/fixtures/dialogs-feedback/index.html?panel=feedback&long=1");
  await expect(page.getByTestId("org-invite-role-conflict")).toBeVisible();
  await inViewport(page.getByTestId("org-invite-role-conflict-apply"), width);
  await inViewport(page.getByTestId("org-invite-role-conflict-dismiss"), width);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.getByRole("button", { name: "Dialogs", exact: true }).click();
  await page.getByTestId("open-invite-public").click();
  await page.setViewportSize({ width, height: 420 });
  const lastTeammate = page.getByRole("button", { name: "Start a private chat with Team member 17", exact: true });
  await lastTeammate.scrollIntoViewIfNeeded();
  await expect(lastTeammate).toBeInViewport();
  await inViewport(lastTeammate, width);
  await page.getByRole("button", { name: "Close invite modal", exact: true }).click();
  await page.getByRole("button", { name: "Navigation", exact: true }).click();
  const spaces = page.getByTestId("sidebar-space-button");
  await keyboardOpen(page, spaces);
  await page.getByTestId("sidebar-space-search").fill("Team planning");
  await expect(page.getByTestId("sidebar-recent-space-space-7")).toBeVisible();
  await page.getByTestId("sidebar-space-search").fill("");
  const browse = page.getByTestId("sidebar-browse-all-spaces");
  await browse.scrollIntoViewIfNeeded();
  await expect(browse).toBeInViewport();
  await browse.click();
  await expect(page.getByTestId("review-status")).toContainText("Browse all spaces");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
});
