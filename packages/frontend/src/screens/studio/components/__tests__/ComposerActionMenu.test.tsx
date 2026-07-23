// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerActionMenu } from "../ComposerActionMenu";

vi.mock("react-aria-components", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-aria-components")>();
  return {
    ...original,
    DialogTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

vi.mock("../../../../components/aria/StudioPopover", () => ({
  StudioDialogPopover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

describe("ComposerActionMenu", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderMenu(showNewBrowserAction: boolean, showInviteAction = true) {
    await act(async () => {
      root.render(
        <ComposerActionMenu
          pendingNewBrowser={false}
          showNewBrowserAction={showNewBrowserAction}
          showInviteAction={showInviteAction}
          onOpenBrowser={vi.fn()}
          onOpenNewBrowser={vi.fn()}
          onOpenInvite={vi.fn()}
          onImportGithubRepo={vi.fn()}
          onInsertCommand={vi.fn()}
        />,
      );
    });
  }

  it("labels the additional-page action as Shared-specific", async () => {
    await renderMenu(true);

    expect(container.querySelector('[data-testid="composer-action-menu-open-new-browser"]')).not.toBeNull();
    expect(container.textContent).toContain("New shared site");
  });

  it("hides the Shared-only additional-page action in Personal mode", async () => {
    await renderMenu(false);

    expect(container.querySelector('[data-testid="composer-action-menu-open-new-browser"]')).toBeNull();
    expect(container.textContent).not.toContain("New shared site");
    expect(container.querySelector('[data-testid="composer-action-menu-open-browser"]')).not.toBeNull();
  });

  it("hides the invite action when the current member cannot share the space", async () => {
    await renderMenu(true, false);

    expect(container.querySelector('[data-testid="composer-action-menu-invite"]')).toBeNull();
    expect(container.textContent).not.toContain("Invite teammates");
  });
});
