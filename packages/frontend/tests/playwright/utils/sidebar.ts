import { expect, type Page } from "@playwright/test";

/** Open the shared team/space directory through the current responsive navigation. */
export async function openTeamDirectory(page: Page, timeout = 30_000) {
  const directory = page.getByTestId("sidebar-project-switcher-menu");
  if (await directory.isVisible()) return;

  const browseTeams = page.getByTestId("sidebar-browse-teams");
  const teamMenu = page.getByTestId("sidebar-team-menu-trigger");
  const globalNavigation = page.getByTestId("topbar-team-selector");
  const spaceNavigation = page.getByTestId("mobile-header-picker");
  const compactNavigation = page.getByTestId("topbar-sidebar-toggle");
  // Await the real shell instead of choosing a posture while it is still loading.
  await expect(browseTeams.or(teamMenu).or(globalNavigation).or(spaceNavigation).or(compactNavigation).filter({ visible: true }).first())
    .toBeVisible({ timeout });

  if (await browseTeams.isVisible()) {
    await browseTeams.click();
  } else {
    if (!(await teamMenu.isVisible())) {
      if (await globalNavigation.isVisible()) await globalNavigation.click();
      else if (await spaceNavigation.isVisible()) await spaceNavigation.click();
      else await compactNavigation.click();
    }
    await teamMenu.click();
    await page.getByTestId("sidebar-team-menu-switch").click();
  }
  await expect(directory).toBeVisible({ timeout });
}

export async function openSidebarPrimaryItem(page: Page, itemId: string) {
  await page.getByTestId(`sidebar-nav-${itemId}`).click();
}

export async function openSidebarSecondaryItem(page: Page, itemId: string) {
  const directEntry = page.getByTestId(`sidebar-more-item-${itemId}`).first();
  if (await directEntry.isVisible().catch(() => false)) {
    await directEntry.click();
    return;
  }

  const moreButton = page.getByTestId("sidebar-nav-more");
  await expect(moreButton).toBeVisible();
  await moreButton.click();
  await page.getByTestId(`sidebar-more-item-${itemId}`).first().click();
}

export async function openCreditsPanel(page: Page) {
  await openSidebarPrimaryItem(page, "credits");
}

export async function openSecretsPanel(page: Page) {
  await openSidebarSecondaryItem(page, "secrets");
}
