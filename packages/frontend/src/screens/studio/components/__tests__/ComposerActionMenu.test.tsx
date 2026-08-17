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

  async function renderMenu(
    showNewBrowserAction: boolean,
    showInviteAction = true,
    sendActions: { onQueueMessage?: () => void; onStashDraft?: () => void } = {},
  ) {
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
          {...sendActions}
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

  it("offers accessible one-shot Queue and Stash actions with shortcuts", async () => {
    const onQueueMessage = vi.fn();
    const onStashDraft = vi.fn();
    await renderMenu(true, true, { onQueueMessage, onStashDraft });

    const queue = container.querySelector('[data-testid="composer-action-menu-queue"]') as HTMLButtonElement;
    const stash = container.querySelector('[data-testid="composer-action-menu-stash"]') as HTMLButtonElement;
    expect(queue.textContent).toContain("Queue message");
    expect(stash.textContent).toContain("Stash draft");
    expect(queue.querySelector("kbd")?.getAttribute("aria-label")).toMatch(/plus Enter/);
    expect(stash.querySelector("kbd")?.getAttribute("aria-label")).toMatch(/Shift plus Enter/);

    await act(async () => queue.click());
    await act(async () => stash.click());
    expect(onQueueMessage).toHaveBeenCalledTimes(1);
    expect(onStashDraft).toHaveBeenCalledTimes(1);
  });
});
