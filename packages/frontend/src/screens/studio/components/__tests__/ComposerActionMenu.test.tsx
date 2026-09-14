// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerActionMenu } from "../ComposerActionMenu";
import { CONNECTORS, FEATURED_CONNECTORS, type ProductConnector } from "../connectors";

// The trigger is a pass-through so the popover content always renders. It
// mirrors the menu's controlled open state so a test can observe closeMenu()
// (data-open flips to "false") and open the menu the way a trigger press would.
vi.mock("react-aria-components", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-aria-components")>();
  return {
    ...original,
    DialogTrigger: ({
      children,
      isOpen,
      onOpenChange,
    }: {
      children: ReactNode;
      isOpen?: boolean;
      onOpenChange?: (open: boolean) => void;
    }) => (
      <div data-testid="mock-dialog-trigger" data-open={isOpen ? "true" : "false"}>
        <button type="button" data-testid="mock-dialog-trigger-open" onClick={() => onOpenChange?.(true)} />
        {children}
      </div>
    ),
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
    sendActions: {
      onQueueMessage?: () => void;
      onStashDraft?: () => void;
      onUploadImage?: () => void;
      uploadImageDisabled?: boolean;
      onInsertSuggestion?: () => void;
      onStartVoiceInput?: () => void;
      voiceInputDisabled?: boolean;
      onToggleVoiceReplies?: () => void;
      voiceRepliesEnabled?: boolean;
      voiceRepliesDisabled?: boolean;
      mutationDisabled?: boolean;
      onSelectConnector?: (connector: ProductConnector) => void;
      onBrowseConnectors?: () => void;
      installedSkillNames?: ReadonlySet<string>;
    } = {},
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
          triggerIconClassName="h-[22px] w-[22px]"
          {...sendActions}
        />,
      );
    });
  }

  it("omits the folded composer controls unless the composer hands them over", async () => {
    await renderMenu(true);

    expect(container.querySelector('[data-testid="composer-action-menu-upload-image"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-action-menu-insert-suggestion"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-action-menu-voice-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-action-menu-voice-replies"]')).toBeNull();
  });

  it("offers Upload image and Insert suggestion from the composer actions", async () => {
    const onUploadImage = vi.fn();
    const onInsertSuggestion = vi.fn();
    await renderMenu(true, true, { onUploadImage, onInsertSuggestion });

    const upload = container.querySelector('[data-testid="composer-action-menu-upload-image"]') as HTMLButtonElement;
    const suggestion = container.querySelector(
      '[data-testid="composer-action-menu-insert-suggestion"]',
    ) as HTMLButtonElement;
    expect(upload.textContent).toContain("Upload image");
    expect(suggestion.textContent).toContain("Insert suggestion");

    await act(async () => upload.click());
    await act(async () => suggestion.click());
    expect(onUploadImage).toHaveBeenCalledTimes(1);
    expect(onInsertSuggestion).toHaveBeenCalledTimes(1);
  });

  it("keeps image upload gated while unavailable or mutations are disabled", async () => {
    await renderMenu(true, true, { onUploadImage: vi.fn(), uploadImageDisabled: true });
    expect(
      container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-upload-image"]')?.disabled,
    ).toBe(true);

    await renderMenu(true, true, { onUploadImage: vi.fn(), mutationDisabled: true });
    expect(container.querySelector('[data-testid="composer-action-menu-upload-image"]')).toBeNull();
  });

  it("keeps dictation reachable when the composer hands it to the menu", async () => {
    const onStartVoiceInput = vi.fn();
    await renderMenu(true, true, { onStartVoiceInput });

    const dictate = container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-voice-input"]')!;
    expect(dictate.textContent).toContain("Dictate message");
    await act(async () => dictate.click());
    expect(onStartVoiceInput).toHaveBeenCalledTimes(1);
  });

  it.each([
    { voiceRepliesEnabled: false, label: "Turn on spoken replies" },
    { voiceRepliesEnabled: true, label: "Turn off spoken replies" },
  ])("offers '$label' for spoken replies", async ({ voiceRepliesEnabled, label }) => {
    const onToggleVoiceReplies = vi.fn();
    await renderMenu(true, true, { onToggleVoiceReplies, voiceRepliesEnabled });

    const replies = container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-voice-replies"]')!;
    expect(replies.textContent).toContain(label);
    await act(async () => replies.click());
    expect(onToggleVoiceReplies).toHaveBeenCalledTimes(1);
  });

  it("does not invoke unavailable dictation or spoken reply actions", async () => {
    const onStartVoiceInput = vi.fn();
    const onToggleVoiceReplies = vi.fn();
    await renderMenu(true, true, {
      onStartVoiceInput,
      voiceInputDisabled: true,
      onToggleVoiceReplies,
      voiceRepliesDisabled: true,
    });

    const dictate = container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-voice-input"]')!;
    const replies = container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-voice-replies"]')!;
    expect(dictate.disabled).toBe(true);
    expect(replies.disabled).toBe(true);
    await act(async () => {
      dictate.click();
      replies.click();
    });
    expect(onStartVoiceInput).not.toHaveBeenCalled();
    expect(onToggleVoiceReplies).not.toHaveBeenCalled();
  });

  it("omits dictation and spoken replies while mutations are disabled", async () => {
    await renderMenu(true, true, {
      onStartVoiceInput: vi.fn(),
      onToggleVoiceReplies: vi.fn(),
      mutationDisabled: true,
    });

    expect(container.querySelector('[data-testid="composer-action-menu-voice-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-action-menu-voice-replies"]')).toBeNull();
  });

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

  it("lists Connect a tool right after Import GitHub repo and opens the connect view", async () => {
    const onSelectConnector = vi.fn();
    const onBrowseConnectors = vi.fn();
    await renderMenu(true, true, { onSelectConnector, onBrowseConnectors });

    const rows = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid^="composer-action-menu-"]'),
    ).map((row) => row.dataset.testid);
    const importIndex = rows.indexOf("composer-action-menu-import-github");
    expect(importIndex).toBeGreaterThanOrEqual(0);
    expect(rows[importIndex + 1]).toBe("composer-action-menu-connect");
    expect(rows[importIndex + 2]).toBe("composer-action-menu-open-browser");

    const menuState = container.querySelector<HTMLDivElement>('[data-testid="mock-dialog-trigger"]')!;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="mock-dialog-trigger-open"]')?.click(),
    );
    expect(menuState.dataset.open).toBe("true");

    const connect = container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-connect"]')!;
    expect(connect.textContent).toContain("Connect a tool");
    // The row opens a further list, so it carries a chevron like Commands.
    expect(connect.querySelectorAll("svg").length).toBe(2);
    await act(async () => connect.click());
    // The row switches views: no handler call, the menu stays open, and the
    // connect view lists a back row plus one row per connector, in order.
    expect(onSelectConnector).not.toHaveBeenCalled();
    expect(menuState.dataset.open).toBe("true");
    expect(container.querySelector('[data-testid="composer-action-menu-import-github"]')).toBeNull();
    const back = container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-connect-back"]');
    expect(back?.textContent).toContain("Connect a tool");
    const connectRows = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[data-testid^="composer-action-menu-connect-"]'),
    ).map((row) => row.dataset.testid);
    // Back, the featured rows in list order, then Browse all tools. Niche
    // tools and the paste link live in the sheet, not the menu.
    expect(connectRows).toEqual([
      "composer-action-menu-connect-back",
      ...FEATURED_CONNECTORS.map((entry) => `composer-action-menu-connect-${entry.id}`),
      "composer-action-menu-connect-browse",
    ]);
    expect(connectRows).toEqual([
      "composer-action-menu-connect-back",
      "composer-action-menu-connect-slack",
      "composer-action-menu-connect-notion",
      "composer-action-menu-connect-discord",
      "composer-action-menu-connect-github",
      "composer-action-menu-connect-browse",
    ]);
    expect(container.querySelector('[data-testid="composer-action-menu-connect-other"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-action-menu-connect-freefinance"]')).toBeNull();
    expect(container.textContent).not.toContain("Paste a skill link");
    expect(
      container.querySelector('[data-testid="composer-action-menu-connect-browse"]')?.textContent,
    ).toContain("Browse all tools");
    expect(container.textContent).not.toContain("Connected");
    expect(container.textContent).not.toContain("\u2014");

    // Arrow keys move between rows like a menu, wrapping at both ends.
    const pressKey = (element: Element | null | undefined, key: string) =>
      act(async () => {
        element?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      });
    await act(async () => back?.focus());
    expect(document.activeElement).toBe(back);
    await pressKey(back, "ArrowDown");
    expect((document.activeElement as HTMLElement | null)?.dataset.testid).toBe(
      "composer-action-menu-connect-slack",
    );
    await pressKey(document.activeElement, "ArrowUp");
    expect(document.activeElement).toBe(back);
    await pressKey(back, "ArrowUp");
    expect((document.activeElement as HTMLElement | null)?.dataset.testid).toBe(
      "composer-action-menu-connect-browse",
    );
    await pressKey(document.activeElement, "ArrowDown");
    expect(document.activeElement).toBe(back);
    await pressKey(back, "End");
    expect((document.activeElement as HTMLElement | null)?.dataset.testid).toBe(
      "composer-action-menu-connect-browse",
    );
    await pressKey(document.activeElement, "Home");
    expect(document.activeElement).toBe(back);
    expect(onSelectConnector).not.toHaveBeenCalled();

    // Back returns to the main view without reporting anything.
    await act(async () => back?.click());
    expect(container.querySelector('[data-testid="composer-action-menu-import-github"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="composer-action-menu-connect-slack"]')).toBeNull();
    expect(onSelectConnector).not.toHaveBeenCalled();
    expect(onBrowseConnectors).not.toHaveBeenCalled();
  });

  it("closes the menu and opens the browse sheet from Browse all tools", async () => {
    const onSelectConnector = vi.fn();
    const onBrowseConnectors = vi.fn();
    await renderMenu(true, true, { onSelectConnector, onBrowseConnectors });

    const menuState = container.querySelector<HTMLDivElement>('[data-testid="mock-dialog-trigger"]')!;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="mock-dialog-trigger-open"]')?.click(),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-connect"]')?.click(),
    );
    const browse = container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-connect-browse"]')!;
    expect(browse.querySelectorAll("svg")).toHaveLength(1);
    await act(async () => browse.click());
    expect(onBrowseConnectors).toHaveBeenCalledTimes(1);
    expect(onSelectConnector).not.toHaveBeenCalled();
    expect(menuState.dataset.open).toBe("false");
    expect(container.querySelector('[data-testid="composer-action-menu-connect-browse"]')).toBeNull();
  });

  it("omits Browse all tools when no browse handler is given", async () => {
    await renderMenu(true, true, { onSelectConnector: vi.fn() });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="mock-dialog-trigger-open"]')?.click(),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-connect"]')?.click(),
    );
    expect(container.querySelector('[data-testid="composer-action-menu-connect-slack"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="composer-action-menu-connect-browse"]')).toBeNull();
  });

  it("reports the pressed connector row and closes the menu", async () => {
    const onSelectConnector = vi.fn();
    await renderMenu(true, true, { onSelectConnector, installedSkillNames: new Set(["notion"]) });

    const menuState = container.querySelector<HTMLDivElement>('[data-testid="mock-dialog-trigger"]')!;
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="mock-dialog-trigger-open"]')?.click(),
    );
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-connect"]')?.click(),
    );

    // Installed rows carry the Badge; the others carry no end slot.
    const notion = container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-connect-notion"]')!;
    const slack = container.querySelector<HTMLButtonElement>('[data-testid="composer-action-menu-connect-slack"]')!;
    expect(notion.textContent).toContain("Connected");
    expect(slack.textContent).not.toContain("Connected");
    expect(container.querySelector('[data-testid="composer-action-menu-connect-github"]')?.textContent).not.toContain(
      "Connected",
    );

    await act(async () => slack.click());
    expect(onSelectConnector).toHaveBeenCalledTimes(1);
    expect(onSelectConnector.mock.calls[0][0]).toBe(CONNECTORS.find((entry) => entry.id === "slack"));
    // closeMenu() flipped the controlled open state to false and reset the view.
    expect(menuState.dataset.open).toBe("false");
    expect(container.querySelector('[data-testid="composer-action-menu-import-github"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="composer-action-menu-connect-slack"]')).toBeNull();
  });

  it("hides Connect a tool without a handler or while mutations are disabled", async () => {
    await renderMenu(true);
    expect(container.querySelector('[data-testid="composer-action-menu-connect"]')).toBeNull();

    await renderMenu(true, true, { onSelectConnector: vi.fn(), mutationDisabled: true });
    expect(container.querySelector('[data-testid="composer-action-menu-connect"]')).toBeNull();
    expect(container.querySelector('[data-testid="composer-action-menu-import-github"]')).toBeNull();
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
    expect(container.querySelector('[data-testid="composer-action-menu-enter-hint"]')?.textContent).toBe(
      "Enter sends or steers · ⇧Enter adds a line",
    );
    expect(container.querySelector('[role="separator"]')).not.toBeNull();

    await act(async () => queue.click());
    await act(async () => stash.click());
    expect(onQueueMessage).toHaveBeenCalledTimes(1);
    expect(onStashDraft).toHaveBeenCalledTimes(1);
  });
});
