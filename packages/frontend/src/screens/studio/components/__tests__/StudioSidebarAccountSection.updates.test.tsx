// @vitest-environment jsdom

import { act, createRef, type ComponentProps } from "react";
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
    onOpenSupport?: () => void;
    supportUnreadCount?: number;
    installEntry?: ComponentProps<typeof StudioSidebarAccountSection>["installEntry"];
    isLargeScreen?: boolean;
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
          installEntry={input.installEntry === undefined ? { kind: "desktop", version: "0.2.0" } : input.installEntry}
          isLargeScreen={input.isLargeScreen ?? true}
          shouldRenderUpdateEntry
          updatePresentation={input.updatePresentation}
          onUpdateEntryClick={vi.fn()}
          onUpdateEntryContextMenu={vi.fn()}
          onUpdateEntryPointerDown={vi.fn()}
          clearUpdateLongPress={vi.fn()}
          notificationsPending={false}
          notificationsEnabled={false}
          onToggleNotifications={vi.fn()}
          onOpenSupport={input.onOpenSupport ?? vi.fn()}
          supportUnreadCount={input.supportUnreadCount}
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
    "places the desktop install action before the profile (labels: %s)",
    async (showLabels) => {
      await renderAccount({
        showLabels,
        updatePresentation: presentation("neutral"),
        profileMenuOpen: true,
      });

      const installLink = container.querySelector<HTMLAnchorElement>(
        '[data-testid="sidebar-get-desktop"]',
      );
      expect(installLink?.getAttribute("href")).toBe("/install#desktop");
      expect(installLink?.getAttribute("target")).toBe("_blank");
      expect(installLink?.getAttribute("rel")).toBe("noreferrer");
      expect(installLink?.getAttribute("aria-label")).toBe("Get desktop app");
      expect(installLink?.title).toBe("Get desktop app · v0.2.0");
      expect(installLink?.textContent).toBe(showLabels ? "Get desktop app" : "");
      const profile = container.querySelector('[data-testid="sidebar-profile-menu"]')!;
      expect(installLink!.compareDocumentPosition(profile) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(document.body.querySelector('[data-testid="profile-install-button"]')).toBeNull();
    },
  );

  it("hides the install journey inside native app surfaces", async () => {
    await renderAccount({
      showLabels: true,
      updatePresentation: presentation("neutral"),
      profileMenuOpen: true,
      installEntry: null,
    });

    expect(document.body.querySelector('[data-testid="profile-install-button"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-get-desktop"]')).toBeNull();
  });

  it("keeps desktop acquisition in the profile menu for a compact desktop browser window", async () => {
    await renderAccount({
      showLabels: true,
      updatePresentation: presentation("neutral"),
      profileMenuOpen: true,
      isLargeScreen: false,
    });

    expect(container.querySelector('[data-testid="sidebar-get-desktop"]')).toBeNull();
    const link = document.body.querySelector<HTMLAnchorElement>('[data-testid="profile-install-button"]');
    expect(link?.textContent).toBe("Get desktop app");
    expect(link?.getAttribute("href")).toBe("/install#desktop");
  });

  it.each([true, false])("keeps mobile availability in the profile menu, including wide tablets (wide: %s)", async (isLargeScreen) => {
    await renderAccount({
      showLabels: true,
      updatePresentation: presentation("neutral"),
      profileMenuOpen: true,
      isLargeScreen,
      installEntry: { kind: "mobile-soon" },
    });

    expect(container.querySelector('[data-testid="sidebar-get-desktop"]')).toBeNull();
    const link = document.body.querySelector<HTMLAnchorElement>('[data-testid="profile-install-button"]');
    expect(link?.textContent).toContain("Get the app");
    expect(link?.textContent).toContain("Soon");
    expect(link?.getAttribute("href")).toBe("/install#mobile");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  it("opens personal Support directly from the profile menu", async () => {
    const onOpenSupport = vi.fn();
    await renderAccount({
      showLabels: true,
      updatePresentation: presentation("neutral"),
      profileMenuOpen: true,
      onOpenSupport,
    });

    const supportButton = document.body.querySelector<HTMLElement>(
      '[data-testid="profile-support-button"]',
    );
    expect(supportButton?.textContent).toContain("Support");
    await act(async () => {
      supportButton?.click();
    });
    expect(onOpenSupport).toHaveBeenCalledTimes(1);
  });

  it("badges unread support activity on the profile avatar and Support menu item", async () => {
    await renderAccount({
      showLabels: true,
      updatePresentation: presentation("neutral"),
      profileMenuOpen: true,
      supportUnreadCount: 3,
    });

    expect(container.querySelector('[data-testid="profile-support-indicator"]')).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="profile-support-unread-count"]')?.textContent,
    ).toBe("3");
    const profileButton = container.querySelector('[data-testid="sidebar-profile-menu"]');
    const descriptionId = profileButton?.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId ?? "")?.textContent).toBe(
      "3 unread support updates.",
    );
  });

  it.each([true, false])("keeps both support and update announcements beside desktop acquisition (labels: %s)", async (showLabels) => {
    await renderAccount({
      showLabels,
      updatePresentation: presentation("attention"),
      supportUnreadCount: 1,
      profileMenuOpen: true,
    });

    const profileButton = container.querySelector('[data-testid="sidebar-profile-menu"]');
    const descriptions = profileButton?.getAttribute("aria-describedby")?.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(descriptions).toEqual(["Update available. New.", "1 unread support update."]);
    expect(container.querySelector('[data-testid="profile-support-indicator"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="profile-update-indicator"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-get-desktop"]')).not.toBeNull();
    expect(document.body.querySelector('[data-testid="profile-support-button"]')?.textContent).toContain("Support");
    expect(document.body.querySelector('[data-testid="profile-install-button"]')).toBeNull();
  });
});
