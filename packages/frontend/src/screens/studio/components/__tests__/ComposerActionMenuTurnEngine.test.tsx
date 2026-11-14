// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerActionMenu, type ComposerTurnEngineRow } from "../ComposerActionMenu";

vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: () => "web" } }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn() } }));

// The trigger is a pass-through so the popover content always renders.
vi.mock("react-aria-components", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-aria-components")>();
  return {
    ...original,
    DialogTrigger: ({ children, isOpen }: { children: ReactNode; isOpen?: boolean }) => (
      <div data-testid="mock-dialog-trigger" data-open={isOpen ? "true" : "false"}>
        {children}
      </div>
    ),
  };
});

vi.mock("../../../../components/aria/StudioPopover", () => ({
  StudioDialogPopover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

function row(overrides: Partial<ComposerTurnEngineRow> = {}): ComposerTurnEngineRow {
  return {
    id: "claude-code",
    icon: <svg data-testid="turn-engine-icon" />,
    title: "Claude Code for the next message",
    description: "Uses your own Claude Code sign-in, under Anthropic's current terms.",
    hint: "Instafy gives Claude Code only your message. Everyone who can see this chat sees its steps and reply.",
    testId: "composer-action-menu-claude-code",
    pending: false,
    disabledReason: null,
    action: null,
    ...overrides,
  };
}

describe("ComposerActionMenu turn-engine rows", () => {
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
    turnEngineRows: ComposerTurnEngineRow[],
    options: { onChooseTurnEngine?: (engineId: string) => void; mutationDisabled?: boolean } = {},
  ) {
    await act(async () => {
      root.render(
        <ComposerActionMenu
          pendingNewBrowser={false}
          onOpenBrowser={vi.fn()}
          onOpenNewBrowser={vi.fn()}
          onOpenInvite={vi.fn()}
          onImportGithubRepo={vi.fn()}
          onInsertCommand={vi.fn()}
          triggerIconClassName="h-[22px] w-[22px]"
          turnEngineRows={turnEngineRows}
          onChooseTurnEngine={options.onChooseTurnEngine ?? vi.fn()}
          mutationDisabled={options.mutationDisabled}
        />,
      );
    });
  }

  const find = (testId: string) => container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  it("shows no row when no engine is offered", async () => {
    await renderMenu([]);
    expect(find("composer-action-menu-claude-code")).toBeNull();
  });

  it("offers an engine beside the new-tab request, with its line and hint", async () => {
    const onChooseTurnEngine = vi.fn();
    await renderMenu([row()], { onChooseTurnEngine });
    const engineRow = find("composer-action-menu-claude-code")!;
    expect(engineRow.textContent).toContain("Claude Code for the next message");
    expect(engineRow.textContent).toContain("under Anthropic's current terms.");
    expect(engineRow.textContent).toContain("Instafy gives Claude Code only your message.");
    expect(engineRow.textContent).not.toContain("Next");
    // A sibling of "Ask AI for a new tab", right after it.
    const newTab = find("composer-action-menu-open-new-browser")!;
    expect(newTab.compareDocumentPosition(engineRow)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    await act(async () => engineRow.click());
    expect(onChooseTurnEngine).toHaveBeenCalledWith("claude-code");
    expect(find("mock-dialog-trigger")?.getAttribute("data-open")).toBe("false");
  });

  it("marks the engine chosen for the next message", async () => {
    await renderMenu([row({ pending: true })]);
    expect(find("composer-action-menu-claude-code")?.textContent).toContain("Next");
  });

  it("shows a row that cannot be chosen as disabled, with its reason and action", async () => {
    const onChooseTurnEngine = vi.fn();
    const start = vi.fn();
    await renderMenu(
      [
        row({
          disabledReason: "This space isn't running on this computer.",
          action: { label: "Start on this computer", testId: "composer-action-menu-claude-code-start", onPress: start },
        }),
      ],
      { onChooseTurnEngine },
    );
    const engineRow = find("composer-action-menu-claude-code")!;
    expect(engineRow.textContent).toContain("This space isn't running on this computer.");
    expect(engineRow.textContent).not.toContain("Instafy gives Claude Code only your message.");
    expect(engineRow.getAttribute("aria-disabled") === "true" || engineRow.hasAttribute("disabled")).toBe(true);
    expect(engineRow.parentElement?.getAttribute("title")).toBe("This space isn't running on this computer.");
    await act(async () => engineRow.click());
    expect(onChooseTurnEngine).not.toHaveBeenCalled();
    await act(async () => find("composer-action-menu-claude-code-start")!.click());
    expect(start).toHaveBeenCalledOnce();
  });

  it("offers no engine to a viewer who cannot send here", async () => {
    await renderMenu([row()], { mutationDisabled: true });
    expect(find("composer-action-menu-claude-code")).toBeNull();
  });
});
