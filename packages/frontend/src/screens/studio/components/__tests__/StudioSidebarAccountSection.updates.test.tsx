// @vitest-environment jsdom

import { act, createRef, useState, type ComponentProps } from "react";
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
    // React Aria restores overlay focus on the next frame. Finish it before
    // another test creates a new focus scope.
    await act(async () => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderAccount(input: {
    showLabels: boolean;
    updatePresentation: AppUpdatePresentation;
    profileMenuOpen?: boolean;
    onOpenSupport?: () => void;
    presentation?: "sidebar" | "header";
    onOpenProfileSettings?: () => void;
    onSignOut?: () => void;
    installEntry?: ComponentProps<typeof StudioSidebarAccountSection>["installEntry"];
    isLargeScreen?: boolean;
  }) {
    function Account() {
      const [open, setOpen] = useState(input.profileMenuOpen ?? false);
      return <StudioSidebarAccountSection
          footerRef={createRef<HTMLDivElement>()}
          presentation={input.presentation}
          onOpenProfileSettings={input.onOpenProfileSettings ?? vi.fn()}
          onSignOut={input.onSignOut ?? vi.fn()}
          showLabels={input.showLabels}
          collapsedSidebarDensity="comfortable"
          profileMenuOpen={open}
          onProfileMenuOpenChange={setOpen}
          avatarUrl={null}
          userId="taylor-user"
          displayName="Example User"
          accountSubtitle="user@example.com"
          installEntry={input.installEntry === undefined ? { kind: "desktop", version: "0.2.0" } : input.installEntry}
          isLargeScreen={input.isLargeScreen ?? true}
          shouldRenderUpdateEntry
          updatePresentation={input.updatePresentation}
          onUpdateEntryClick={vi.fn()}
          onUpdateEntryContextMenu={vi.fn()}
          onUpdateEntryPointerDown={vi.fn()}
          clearUpdateLongPress={vi.fn()}
          onOpenSupport={input.onOpenSupport ?? vi.fn()}
          onOpenDiagnostics={vi.fn()}
          hasAppLogErrors={false}
          updateDialogOpen={false}
          onUpdateDialogOpenChange={vi.fn()}
          updateMetadata={null}
          updateDialogShowDetails={false}
          onUpdateDialogShowDetailsChange={vi.fn()}
          onUpdatePrimaryAction={vi.fn()}
          updateActionPending={false}
        />;
    }
    await act(async () => root.render(<Account />));
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

  it("keeps Support available without a second unread indicator", async () => {
    await renderAccount({ showLabels: true, updatePresentation: presentation("neutral"), profileMenuOpen: true });
    expect(container.querySelector('[data-testid="profile-support-indicator"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="profile-support-unread-count"]')).toBeNull();
    expect(container.querySelector('[data-testid="sidebar-profile-menu"]')?.hasAttribute("aria-describedby")).toBe(false);
    expect(document.body.querySelector('[data-testid="profile-support-button"]')?.textContent).toBe("Support");
  });

  it.each([true, false])("offers account actions in desktop and compact surfaces (wide: %s)", async (isLargeScreen) => {
    const onOpenProfileSettings = vi.fn();
    await renderAccount({ showLabels: false, presentation: isLargeScreen ? "sidebar" : "header", isLargeScreen,
      updatePresentation: presentation("attention"), profileMenuOpen: true, onOpenProfileSettings });
    expect(document.body.querySelector('[data-testid="profile-account-sheet"]') !== null).toBe(!isLargeScreen);
    expect(document.body.querySelector('[data-testid="notifications-toggle-button"]')).toBeNull();
    expect(document.body.querySelector('[aria-label="Theme: Light"]')).toBeNull();
    expect(document.body.querySelector('[data-testid="profile-updates-button"]')).not.toBeNull();
    const settings = document.body.querySelector<HTMLElement>('[data-testid="profile-settings-button"]');
    expect(settings?.textContent).toBe("Your settings");
    await act(async () => settings?.click());
    expect(onOpenProfileSettings).toHaveBeenCalledOnce();
  });

  it("keeps diagnostics in a closed secondary disclosure", async () => {
    await renderAccount({ showLabels: true, updatePresentation: presentation("neutral"), profileMenuOpen: true });
    const details = document.body.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe("Advanced");
    expect(details?.querySelector('[data-testid="profile-diagnostics-button"]')).not.toBeNull();
  });

  it("opens the compact avatar sheet without navigating, and restores focus when closed", async () => {
    const onOpenProfileSettings = vi.fn();
    await renderAccount({ showLabels: false, presentation: "header", isLargeScreen: false,
      updatePresentation: presentation("neutral"), onOpenProfileSettings });
    const trigger = container.querySelector<HTMLButtonElement>('[data-testid="topbar-profile-button"]')!;
    await act(async () => { trigger.focus(); trigger.click(); });
    expect(document.body.querySelector('[data-testid="profile-account-sheet"]')).not.toBeNull();
    expect(onOpenProfileSettings).not.toHaveBeenCalled();
    const close = document.body.querySelector<HTMLButtonElement>('[aria-label="Close account menu"]')!;
    await act(async () => { close.focus(); close.click(); });
    expect(document.body.querySelector('[data-testid="profile-account-sheet"]')).toBeNull();
    await act(async () => { await vi.waitFor(() => expect(document.activeElement).toBe(trigger)); });
  });

  it("dismisses the compact account sheet with Escape", async () => {
    await renderAccount({ showLabels: false, presentation: "header", isLargeScreen: false,
      updatePresentation: presentation("neutral"), profileMenuOpen: true });
    await act(async () => {
      document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(document.body.querySelector('[data-testid="profile-account-sheet"]')).toBeNull();
  });

});
