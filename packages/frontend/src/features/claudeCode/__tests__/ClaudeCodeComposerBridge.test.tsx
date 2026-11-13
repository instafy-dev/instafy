/** @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FrontendTurnEngineComposerContext,
  FrontendTurnEngineComposerOffer,
} from "../../frontendFeatureModule";
import type { RuntimeMenuOption } from "../../../runtime/useRuntimeMenu";
import type { FetchRuntimeStatusResult } from "../../../services/runtimeController/runtimes";
import { ClaudeCodeComposerBridge } from "../ClaudeCodeComposerBridge";
import { CLAUDE_CODE_COPY } from "../claudeCodeCopy";
import {
  CLAUDE_CODE_DESKTOP_EXTENSION_ID,
  forgetClaudeCodeDesktopRefusalForTests,
} from "../claudeCodeDesktop";

const PROJECT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const RUNTIME_ID = "11111111-2222-4333-8444-555555555555";

function runtimeOption(overrides: Partial<RuntimeMenuOption> = {}): RuntimeMenuOption {
  return {
    id: RUNTIME_ID,
    label: "This computer",
    detail: null,
    state: "online",
    badge: null,
    isSessionOverride: false,
    tunnel: null,
    needsActivation: false,
    isLikelyLocal: true,
    claudeCode: { ready: true, reason: null, cli: "2.1.314", verified: true, planSignIn: false },
    ...overrides,
  };
}

describe("ClaudeCodeComposerBridge", () => {
  let container: HTMLDivElement;
  let root: Root;
  let offers: Array<FrontendTurnEngineComposerOffer | null>;
  let onOfferChange: (offer: FrontendTurnEngineComposerOffer | null) => void;
  let fetchRuntimeStatus: ReturnType<typeof vi.fn>;
  let invokeDesktopExtension: ReturnType<typeof vi.fn>;
  let desktopRuntimeStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    offers = [];
    onOfferChange = (offer) => {
      offers.push(offer);
    };
    fetchRuntimeStatus = vi.fn(async () => ({
      runtimes: [],
      preferredRuntimeId: null,
      claudeCodeLane: true,
    }) satisfies FetchRuntimeStatusResult);
    invokeDesktopExtension = vi.fn(async () => ({ supported: true, found: true, consented: true }));
    desktopRuntimeStatus = vi.fn(async () => ({ running: true, projectId: PROJECT_ID, runtimeId: RUNTIME_ID }));
    window.instafyDesktop = {
      notify: vi.fn(),
      invokeDesktopExtension,
      desktopRuntimeStatus,
    } as unknown as Window["instafyDesktop"];
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete window.instafyDesktop;
    forgetClaudeCodeDesktopRefusalForTests();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function context(overrides: Partial<FrontendTurnEngineComposerContext> = {}): FrontendTurnEngineComposerContext {
    return {
      projectId: PROJECT_ID,
      threadKind: null,
      runtimeOptions: [runtimeOption()],
      fetchRuntimeStatus: fetchRuntimeStatus as unknown as FrontendTurnEngineComposerContext["fetchRuntimeStatus"],
      resolveControllerUrl: async () => "https://controller.example.test",
      startOnThisComputer: vi.fn(),
      ...overrides,
    };
  }

  async function render(value: FrontendTurnEngineComposerContext) {
    await act(async () => {
      root.render(<ClaudeCodeComposerBridge context={value} onOfferChange={onOfferChange} />);
    });
    // Let Desktop's and the controller's answers land.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  const latestOffer = () => offers.at(-1) ?? null;

  it("offers nothing outside Desktop, and asks the controller nothing", async () => {
    delete window.instafyDesktop;
    await render(context());
    expect(latestOffer()).toBeNull();
    expect(fetchRuntimeStatus).not.toHaveBeenCalled();
  });

  it("offers nothing where Desktop does not support it, and asks the controller nothing", async () => {
    invokeDesktopExtension.mockResolvedValue({ supported: false, found: false, consented: false });
    await render(context());
    expect(invokeDesktopExtension).toHaveBeenCalledWith({
      extensionId: CLAUDE_CODE_DESKTOP_EXTENSION_ID,
      method: "status",
      controllerUrl: "https://controller.example.test",
    });
    expect(latestOffer()).toBeNull();
    expect(fetchRuntimeStatus).not.toHaveBeenCalled();
  });

  it("offers nothing unless the space status carries claudeCodeLane", async () => {
    fetchRuntimeStatus.mockResolvedValue({ runtimes: [], preferredRuntimeId: null });
    await render(context());
    expect(fetchRuntimeStatus).toHaveBeenCalledWith({ projectId: PROJECT_ID, quietOnAbort: true });
    expect(latestOffer()).toBeNull();
  });

  it("offers a choosable row and its token while this computer's runtime is ready", async () => {
    await render(context());
    const offer = latestOffer();
    expect(offer).not.toBeNull();
    expect(offer?.row).toEqual({
      title: "Claude Code for the next message",
      description: "Uses your own Claude Code sign-in, under Anthropic's current terms.",
      hint: "Instafy gives Claude Code only your message. Everyone who can see this chat sees its steps and reply.",
      testId: "composer-action-menu-claude-code",
      disabledReason: null,
      action: null,
    });
    expect(offer?.token).toEqual({
      label: "Claude Code · next message",
      cancelLabel: "Don't use Claude Code",
      testId: "composer-claude-code",
    });
  });

  it("says the turn runs on the person's Claude plan only when the runtime reports a plan sign-in", async () => {
    await render(
      context({
        runtimeOptions: [
          runtimeOption({
            claudeCode: { ready: true, reason: null, cli: "2.1.314", verified: true, planSignIn: true },
          }),
        ],
      }),
    );
    expect(latestOffer()?.row.description).toBe(
      "Runs on your own Claude plan, under Anthropic's current terms.",
    );
  });

  it("shows the row disabled with a Start action when the space is not running on this computer", async () => {
    desktopRuntimeStatus.mockResolvedValue({ running: false });
    const value = context();
    await render(value);
    const row = latestOffer()?.row;
    expect(row?.disabledReason).toBe(CLAUDE_CODE_COPY.notRunningHere);
    expect(row?.action).toMatchObject({
      label: CLAUDE_CODE_COPY.startAction,
      testId: "composer-action-menu-claude-code-start",
    });
    row?.action?.onPress();
    expect(value.startOnThisComputer).toHaveBeenCalledOnce();
  });

  it("shows the row disabled, with its reason, when it is not set up, not ready, or in a thread", async () => {
    invokeDesktopExtension.mockResolvedValue({ supported: true, found: false, consented: false });
    await render(context());
    expect(latestOffer()?.row.disabledReason).toBe(CLAUDE_CODE_COPY.notSetUp);

    invokeDesktopExtension.mockResolvedValue({ supported: true, found: true, consented: true });
    await render(
      context({
        projectId: "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      }),
    );
    // Desktop runs this computer's runtime for the other space.
    expect(latestOffer()?.row.disabledReason).toBe(CLAUDE_CODE_COPY.notRunningHere);

    await render(
      context({
        runtimeOptions: [
          runtimeOption({
            claudeCode: { ready: false, reason: "bare_default", cli: "2.2.0", verified: false, planSignIn: false },
          }),
        ],
      }),
    );
    expect(latestOffer()?.row.disabledReason).toBe(CLAUDE_CODE_COPY.notReady.bare_default);

    await render(context({ threadKind: "thread" }));
    expect(latestOffer()?.row.disabledReason).toBe(CLAUDE_CODE_COPY.inThread);
  });

  it("withdraws its offer when it unmounts", async () => {
    await render(context());
    expect(latestOffer()).not.toBeNull();
    await act(async () => {
      root.render(<></>);
    });
    expect(latestOffer()).toBeNull();
  });
});
