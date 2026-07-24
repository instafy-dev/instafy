// @vitest-environment jsdom

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdatePresentation } from "../../../../updates/releaseMetadata";
import { StudioSidebarAccountSection } from "../StudioSidebarAccountSection";

function presentation(
  emphasis: AppUpdatePresentation["emphasis"],
): AppUpdatePresentation {
  return {
    title: emphasis === "danger" ? "Update check failed" : "Update available",
    detail: emphasis === "danger" ? "Retry" : "New",
    emphasis,
    show: true,
  };
}

describe("StudioSidebarAccountSection update indicator", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderAccount(input: {
    showLabels: boolean;
    updatePresentation: AppUpdatePresentation;
    profileMenuOpen?: boolean;
    showInstallEntry?: boolean;
  }) {
    await act(async () => {
      root.render(
        <StudioSidebarAccountSection
          footerRef={createRef<HTMLDivElement>()}
          showLabels={input.showLabels}
          collapsedSidebarDensity="comfortable"
          profileMenuOpen={input.profileMenuOpen ?? false}
          onProfileMenuOpenChange={vi.fn()}
          avatarUrl={null}
          initials="EU"
          displayName="Example User"
          accountSubtitle="user@example.com"
          resolvedTheme="light"
          onThemeModeChange={vi.fn()}
          showInstallEntry={input.showInstallEntry ?? true}
          shouldRenderUpdateEntry
          updatePresentation={input.updatePresentation}
          onUpdateEntryClick={vi.fn()}
          onUpdateEntryContextMenu={vi.fn()}
          onUpdateEntryPointerDown={vi.fn()}
          clearUpdateLongPress={vi.fn()}
          notificationsPending={false}
          notificationsEnabled={false}
          onToggleNotifications={vi.fn()}
          onOpenDiagnostics={vi.fn()}
          hasAppLogErrors={false}
          updateDialogOpen={false}
          onUpdateDialogOpenChange={vi.fn()}
          updateMetadata={null}
          updateDialogShowDetails={false}
          onUpdateDialogShowDetailsChange={vi.fn()}
          onUpdatePrimaryAction={vi.fn()}
          updateActionPending={false}
        />,
      );
    });
  }

  it("keeps an attention dot on the expanded avatar while the menu is closed", async () => {
    await renderAccount({
      showLabels: true,
      updatePresentation: presentation("attention"),
    });

    const indicator = container.querySelector('[data-testid="profile-update-indicator"]');
    expect(indicator?.getAttribute("data-tone")).toBe("attention");
    const profileButton = container.querySelector('[data-testid="sidebar-profile-menu"]');
    const descriptionId = profileButton?.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe(
      "Update available. New.",
    );
  });

  it("keeps an error dot on the collapsed avatar while the menu is closed", async () => {
    await renderAccount({
      showLabels: false,
      updatePresentation: presentation("danger"),
    });

    const indicator = container.querySelector('[data-testid="profile-update-indicator"]');
    expect(indicator?.getAttribute("data-tone")).toBe("danger");
  });

  it("does not badge neutral updater state", async () => {
    await renderAccount({
      showLabels: true,
      updatePresentation: presentation("neutral"),
    });

    expect(container.querySelector('[data-testid="profile-update-indicator"]')).toBeNull();
    expect(
      container
        .querySelector('[data-testid="sidebar-profile-menu"]')
        ?.hasAttribute("aria-describedby"),
    ).toBe(false);
  });

  it.each([true, false])(
    "keeps the install journey available from the web account menu (labels: %s)",
    async (showLabels) => {
      await renderAccount({
        showLabels,
        updatePresentation: presentation("neutral"),
        profileMenuOpen: true,
        showInstallEntry: true,
      });

      const installLink = document.body.querySelector<HTMLAnchorElement>(
        '[data-testid="profile-install-button"]',
      );
      expect(installLink?.getAttribute("href")).toBe("/install#desktop");
      expect(installLink?.getAttribute("target")).toBe("_blank");
      expect(installLink?.getAttribute("rel")).toBe("noreferrer");
      expect(installLink?.textContent).toContain("Install Instafy");
    },
  );

  it("hides the install journey inside native app surfaces", async () => {
    await renderAccount({
      showLabels: true,
      updatePresentation: presentation("neutral"),
      profileMenuOpen: true,
      showInstallEntry: false,
    });

    expect(document.body.querySelector('[data-testid="profile-install-button"]')).toBeNull();
  });
});
