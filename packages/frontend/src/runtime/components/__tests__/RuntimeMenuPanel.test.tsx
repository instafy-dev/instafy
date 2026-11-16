// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { RuntimeMenuPanel, blockerSpaceMachinesDestination } from "../RuntimeMenuPanel";
import type { RuntimeMenuOption } from "../../useRuntimeMenu";
import {
  HostedRuntimeBlockerSpaceError,
  type HostedRuntimeLimitErrorDetails,
} from "../../hostedRuntimeLimitError";

function runtimeOption(
  overrides: Partial<RuntimeMenuOption> = {},
): RuntimeMenuOption {
  return {
    id: "cloud-runtime-1",
    label: "Instafy Cloud",
    detail: null,
    state: "offline",
    badge: null,
    isSessionOverride: false,
    tunnel: null,
    needsActivation: false,
    isLikelyLocal: false,
    ...overrides,
  };
}

describe("RuntimeMenuPanel", () => {
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

  async function renderPanel({
    runtimeEnsureError = null,
    runtimeEnsureLimit = null,
    onRetryHosted,
    hostedRuntimeEnsuring = false,
    hostedRuntimeTakeoverInProgress = false,
    runtimeOptions = [],
    selectedRuntimeId = null,
    onStartRuntime,
    onShowSelfHostHelp,
    interactionMode,
    emptyStateDetail,
  }: {
    runtimeEnsureError?: string | null;
    runtimeEnsureLimit?: HostedRuntimeLimitErrorDetails | null;
    onRetryHosted?: () => void | Promise<boolean>;
    hostedRuntimeEnsuring?: boolean;
    hostedRuntimeTakeoverInProgress?: boolean;
    runtimeOptions?: RuntimeMenuOption[];
    selectedRuntimeId?: string | null;
    onStartRuntime?: (runtimeId: string | null) => void;
    onShowSelfHostHelp?: () => void;
    interactionMode?: "picker" | "manage";
    emptyStateDetail?: string;
  }) {
    await act(async () => {
      root.render(
        <RuntimeMenuPanel
          runtimeEnsureError={runtimeEnsureError}
          runtimeEnsureLimit={runtimeEnsureLimit}
          connectionWarning={null}
          onRetryHosted={onRetryHosted}
          hostedRuntimeEnsuring={hostedRuntimeEnsuring}
          hostedRuntimeTakeoverInProgress={hostedRuntimeTakeoverInProgress}
          runtimeOptions={runtimeOptions}
          selectedRuntimeId={selectedRuntimeId}
          onSelectOption={vi.fn()}
          onStartRuntime={onStartRuntime}
          onShowSelfHostHelp={onShowSelfHostHelp}
          emptyStateMessage="No machine is connected to this space yet."
          emptyStateDetail={emptyStateDetail}
          interactionMode={interactionMode}
        />,
      );
    });
  }

  it("offers a hosted machine start action when no machine exists", async () => {
    const onRetryHosted = vi.fn(async () => true);
    await renderPanel({ onRetryHosted });

    const startButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-start-cloud"]',
    );
    expect(startButton).not.toBeNull();
    expect(startButton?.textContent).toContain("Start a hosted machine");
    expect(container.querySelector('[data-testid="runtime-reconnect-cloud"]')).toBeNull();

    await act(async () => {
      startButton?.click();
    });

    expect(onRetryHosted).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the menu's start", null, [], "runtime-start-cloud", "Starting a hosted machine…"],
    ["Reconnect", "provider offline", [runtimeOption({ provider: "instafy-cloud" })], "runtime-reconnect-cloud", "Reconnecting the hosted machine…"],
  ] as const)("keeps keyboard focus on %s while its own press waits", async (
    _label,
    runtimeEnsureError,
    runtimeOptions,
    testId,
    pendingLabel,
  ) => {
    let finishStart: (started: boolean) => void = () => {};
    const onRetryHosted = vi.fn(
      () => new Promise<boolean>((resolve) => { finishStart = resolve; }),
    );
    const options = [...runtimeOptions];
    await renderPanel({ runtimeEnsureError, onRetryHosted, runtimeOptions: options });

    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    await act(async () => {
      button?.focus();
      button?.click();
    });
    // The hook reports the start it is making as an ensure in progress.
    await renderPanel({ runtimeEnsureError, onRetryHosted, hostedRuntimeEnsuring: true, runtimeOptions: options });

    expect(container.querySelector(`[data-testid="${testId}"]`)).toBe(button);
    expect(button?.textContent).toBe(pendingLabel);
    expect(button?.disabled).toBe(false);
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    await act(async () => {
      finishStart(true);
    });
  });

  it("names the space's selected machine the way its row does", async () => {
    await renderPanel({
      runtimeOptions: [runtimeOption({ provider: "instafy-cloud", state: "online" })],
      selectedRuntimeId: "cloud-runtime-1",
    });

    expect(container.textContent).toContain("Selected machine: Instafy Cloud");
    expect(container.textContent).toContain("Use best available");
    expect(container.textContent).not.toMatch(/pinned/i);
  });

  it("promotes reconnect over the empty action after a hosted runtime failure", async () => {
    const onRetryHosted = vi.fn(async () => true);
    await renderPanel({
      runtimeEnsureError: "provider offline",
      onRetryHosted,
      onStartRuntime: vi.fn(),
      runtimeOptions: [runtimeOption({ provider: "instafy-cloud" })],
    });

    const reconnectButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-reconnect-cloud"]',
    );
    expect(reconnectButton).not.toBeNull();
    expect(reconnectButton?.textContent).toContain("Reconnect the hosted machine");
    expect(container.textContent).toContain("Reconnect to try again, or view details to see the error.");
    expect(container.querySelector('[data-testid="runtime-start-cloud"]')).toBeNull();
    expect(container.querySelector('[data-testid="runtime-start-existing"]')).toBeNull();

    await act(async () => {
      reconnectButton?.click();
    });

    expect(onRetryHosted).toHaveBeenCalledTimes(1);
  });

  it("offers Try again, not Reconnect, when the space shows no hosted machine", async () => {
    // A refusal before launch (a limit, capacity, credits) creates no hosted
    // machine, so there is none to reconnect.
    for (const runtimeOptions of [[], [runtimeOption({ provider: "self-hosted", label: "Self-hosted machine" })]]) {
      let finishRetry: (started: boolean) => void = () => {};
      const onRetryHosted = vi.fn(
        () => new Promise<boolean>((resolve) => { finishRetry = resolve; }),
      );
      await renderPanel({ runtimeEnsureError: "provider offline", onRetryHosted, runtimeOptions });

      const retryButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="runtime-reconnect-cloud"]',
      );
      expect(retryButton?.textContent).toBe("Try again");
      expect(container.textContent).toContain("Try again, or view details to see the error.");
      expect(container.textContent).not.toMatch(/reconnect/i);

      await act(async () => {
        retryButton?.click();
      });
      expect(onRetryHosted).toHaveBeenCalledTimes(1);
      // While it waits it says what it does, and still names no machine to reconnect.
      expect(retryButton?.textContent).toBe("Starting a hosted machine…");
      expect(container.textContent).not.toMatch(/reconnect/i);
      await act(async () => {
        finishRetry(true);
      });
    }
  });

  it("promotes a restartable offline runtime when no runtime is usable", async () => {
    const onRetryHosted = vi.fn(async () => true);
    const onStartRuntime = vi.fn();
    await renderPanel({
      onRetryHosted,
      onStartRuntime,
      runtimeOptions: [runtimeOption()],
    });

    const startButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-start-existing"]',
    );
    expect(startButton).not.toBeNull();
    expect(startButton?.textContent).toContain("Start Instafy Cloud");
    expect(container.querySelector('[data-testid="runtime-start-cloud"]')).toBeNull();

    await act(async () => {
      startButton?.click();
    });

    expect(onStartRuntime).toHaveBeenCalledTimes(1);
    expect(onStartRuntime).toHaveBeenCalledWith("cloud-runtime-1");
    expect(onRetryHosted).not.toHaveBeenCalled();
  });

  it("announces a retry failure while keeping reconnect available", async () => {
    await renderPanel({
      runtimeEnsureError: "provider offline",
      onRetryHosted: vi.fn(async () => false),
      runtimeOptions: [runtimeOption()],
    });

    const reconnect = container.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-reconnect-cloud"]',
    );
    await act(async () => {
      reconnect?.click();
    });

    const error = container.querySelector('[data-testid="runtime-action-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain("The hosted machine still didn't start.");
    expect(reconnect?.disabled).toBe(false);
  });

  it("does not promote an offline runtime while another runtime is usable", async () => {
    await renderPanel({
      onRetryHosted: vi.fn(async () => true),
      onStartRuntime: vi.fn(),
      runtimeOptions: [
        runtimeOption(),
        runtimeOption({ id: "ready-runtime", label: "Ready runtime", state: "online" }),
      ],
    });

    expect(container.querySelector('[data-testid="runtime-start-existing"]')).toBeNull();
  });

  it("points at the blocking space when the blocker cannot be stopped from here", async () => {
    const blockerProjectId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const limitError =
      'Instafy Cloud runtime limit reached for this organization (1 active; max 1). Active runtime "Hosted Runtime" is attached to project "Acme" (project bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb, runtime aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa). Stop/remove that runtime, then retry.';
    const onTakeOver = vi.fn(async () => {
      throw new HostedRuntimeBlockerSpaceError({
        blockerProjectId,
        blockerProjectLabel: "Acme",
      });
    });
    let currentSearch = "";
    function LocationProbe() {
      currentSearch = useLocation().search;
      return null;
    }
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/studio?projectId=current-project"]}>
          <LocationProbe />
          <RuntimeMenuPanel
            runtimeEnsureError={limitError}
            connectionWarning={null}
            onRetryHosted={vi.fn(async () => false)}
            onTakeOverHostedRuntimeLimit={onTakeOver}
            runtimeOptions={[runtimeOption()]}
            selectedRuntimeId={null}
            onSelectOption={vi.fn()}
          />
        </MemoryRouter>,
      );
    });

    const takeOverButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Stop blocker and retry"),
    );
    expect(takeOverButton).toBeDefined();
    await act(async () => {
      takeOverButton?.click();
    });

    expect(onTakeOver).toHaveBeenCalledTimes(1);
    const notice = container.querySelector('[data-testid="runtime-blocker-space-notice"]');
    expect(notice?.textContent).toContain(
      'The blocking machine in "Acme" can\'t be stopped from here. Open that space and stop it there.',
    );
    expect(container.querySelector('[data-testid="runtime-action-error"]')).toBeNull();

    const openSpace = container.querySelector<HTMLButtonElement>(
      '[data-testid="runtime-open-blocker-space"]',
    );
    expect(openSpace?.textContent).toContain("Open space");
    await act(async () => {
      openSpace?.click();
    });

    const params = new URLSearchParams(currentSearch);
    expect(params.get("projectId")).toBe(blockerProjectId);
    expect(params.get("panel")).toBe("machines");
    expect(blockerSpaceMachinesDestination(blockerProjectId)).toEqual({
      kind: "route",
      search: `?projectId=${blockerProjectId}&panel=machines`,
    });
  });

  it("hides the blocking-space notice once the limit no longer holds", async () => {
    const limitError =
      'Instafy Cloud runtime limit reached for this organization (1 active; max 1). Active runtime "Hosted Runtime" is attached to project "Acme" (project bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb, runtime aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa). Stop/remove that runtime, then retry.';
    const onTakeOver = vi.fn(async () => {
      throw new HostedRuntimeBlockerSpaceError({
        blockerProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        blockerProjectLabel: "Acme",
      });
    });
    const renderWithError = async (runtimeEnsureError: string) => {
      await act(async () => {
        root.render(
          <MemoryRouter initialEntries={["/studio?projectId=current-project"]}>
            <RuntimeMenuPanel
              runtimeEnsureError={runtimeEnsureError}
              connectionWarning={null}
              onRetryHosted={vi.fn(async () => false)}
              onTakeOverHostedRuntimeLimit={onTakeOver}
              runtimeOptions={[runtimeOption()]}
              selectedRuntimeId={null}
              onSelectOption={vi.fn()}
            />
          </MemoryRouter>,
        );
      });
    };
    await renderWithError(limitError);

    const takeOverButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("Stop blocker and retry"),
    );
    await act(async () => {
      takeOverButton?.click();
    });
    expect(container.querySelector('[data-testid="runtime-blocker-space-notice"]')).not.toBeNull();

    // The ensure behind the takeover can end in a different refusal; the
    // notice about the blocking space must not be shown next to it.
    await renderWithError("This team is out of credits for today.");

    expect(container.querySelector('[data-testid="runtime-blocker-space-notice"]')).toBeNull();
    expect(container.querySelector('[data-testid="runtime-open-blocker-space"]')).toBeNull();
    expect(container.textContent).toContain("Instafy couldn't start a hosted machine");
  });

  describe("on the Machines page", () => {
    const hostedSentence =
      "Instafy starts a hosted machine for this space when you message an agent.";

    it("says what a machine is for and offers a neutral start flush with the heading", async () => {
      const onRetryHosted = vi.fn(async () => true);
      await renderPanel({
        onRetryHosted,
        interactionMode: "manage",
        emptyStateDetail: "Agents do their work on a machine.",
      });

      expect(container.textContent).toContain("No machine is connected to this space yet.");
      expect(container.textContent).toContain(`Agents do their work on a machine. ${hostedSentence}`);
      expect(container.textContent).not.toMatch(/runtime|Instafy Cloud/i);
      const startButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="runtime-start-cloud"]',
      );
      expect(startButton?.textContent).toBe("Start one now");
      // Content width in the shared neutral tone, not the menu's accent bar.
      expect(startButton?.className).not.toContain("w-full");
      expect(startButton?.className).not.toContain("bg-primary-600");
      expect(startButton?.className).toContain("bg-slate-100");
      // No inset of its own: the text and the button start at the heading's edge.
      expect(startButton?.parentElement?.className).not.toMatch(/\bp[xl]-/);

      await act(async () => {
        startButton?.click();
      });
      expect(onRetryHosted).toHaveBeenCalledTimes(1);
    });

    it("keeps keyboard focus on Start while its own press waits", async () => {
      let finishStart: (started: boolean) => void = () => {};
      const onRetryHosted = vi.fn(
        () => new Promise<boolean>((resolve) => { finishStart = resolve; }),
      );
      await renderPanel({ onRetryHosted, interactionMode: "manage" });

      const startButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="runtime-start-cloud"]',
      );
      await act(async () => {
        startButton?.focus();
        startButton?.click();
      });
      // The hook reports the start it is making as an ensure in progress.
      await renderPanel({ onRetryHosted, hostedRuntimeEnsuring: true, interactionMode: "manage" });

      const pendingButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="runtime-start-cloud"]',
      );
      expect(pendingButton).toBe(startButton);
      expect(pendingButton?.textContent).toBe("Starting a hosted machine…");
      // Pending, not disabled: native disabled would drop focus.
      expect(pendingButton?.disabled).toBe(false);
      expect(pendingButton?.getAttribute("aria-disabled")).toBe("true");
      expect(document.activeElement).toBe(pendingButton);

      await act(async () => {
        startButton?.click();
      });
      expect(onRetryHosted).toHaveBeenCalledTimes(1);
      await act(async () => {
        finishStart(true);
      });
    });

    it("disables Start while a start asked for elsewhere, or a takeover, is under way", async () => {
      const startButton = () =>
        container.querySelector<HTMLButtonElement>('[data-testid="runtime-start-cloud"]');
      const onRetryHosted = vi.fn(async () => true);

      await renderPanel({ onRetryHosted, hostedRuntimeEnsuring: true, interactionMode: "manage" });
      expect(startButton()?.textContent).toBe("Starting a hosted machine…");
      expect(startButton()?.disabled).toBe(true);

      await renderPanel({ onRetryHosted, hostedRuntimeTakeoverInProgress: true, interactionMode: "manage" });
      expect(startButton()?.textContent).toBe("Start one now");
      expect(startButton()?.disabled).toBe(true);
    });

    it("names no hosted machine where it can't offer to start one", async () => {
      await renderPanel({
        interactionMode: "manage",
        emptyStateDetail: "Agents do their work on a machine.",
      });

      expect(container.textContent).toContain("Agents do their work on a machine.");
      expect(container.textContent).not.toContain("hosted");
      expect(container.querySelector('[data-testid="runtime-start-cloud"]')).toBeNull();
    });

    it("leaves what starts a machine to the warning after a failure", async () => {
      await renderPanel({
        runtimeEnsureError: "This team is out of credits for today, so a hosted machine can't start.",
        onRetryHosted: vi.fn(async () => true),
        interactionMode: "manage",
        emptyStateDetail: "Agents do their work on a machine.",
      });

      expect(container.textContent).toContain("Instafy couldn't start a hosted machine");
      expect(container.textContent).toContain("Try again, or view details to see the error.");
      expect(container.textContent).not.toContain(hostedSentence);
      expect(container.querySelector('[data-testid="runtime-start-cloud"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="runtime-reconnect-cloud"]')?.textContent,
      ).toBe("Try again");
    });

    it("says the server isn't set up for hosted machines and offers no try that would fail the same way", async () => {
      const onShowSelfHostHelp = vi.fn();
      await renderPanel({
        runtimeEnsureError: "provider 'instafy-cloud' is not configured on this controller",
        onRetryHosted: vi.fn(async () => true),
        onShowSelfHostHelp,
        interactionMode: "manage",
        emptyStateDetail: "Agents do their work on a machine.",
      });

      expect(container.textContent).toContain("Instafy couldn't start a hosted machine");
      expect(container.textContent).toContain(
        "This server isn't set up to start hosted machines. Ask whoever runs this Instafy server to set it up.",
      );
      expect(container.textContent).not.toContain(hostedSentence);
      expect(container.textContent).not.toMatch(/reconnect|try again/i);
      expect(container.querySelector('[data-testid="runtime-reconnect-cloud"]')).toBeNull();
      expect(container.querySelector('[data-testid="runtime-start-cloud"]')).toBeNull();
      // The raw refusal stays one press away.
      expect(container.textContent).toContain("View details");

      const connect = container.querySelector<HTMLButtonElement>(
        '[data-testid="runtime-connect-own-machine"]',
      );
      expect(connect?.textContent).toBe("Connect your own machine");
      await act(async () => {
        connect?.click();
      });
      expect(onShowSelfHostHelp).toHaveBeenCalledTimes(1);

      // Without a way to open that dialog, the panel points nowhere.
      await renderPanel({
        runtimeEnsureError: "provider 'instafy-cloud' is not configured on this controller",
        onRetryHosted: vi.fn(async () => true),
        interactionMode: "manage",
      });
      expect(container.querySelector('[data-testid="runtime-connect-own-machine"]')).toBeNull();
      expect(container.querySelector('[data-testid="runtime-reconnect-cloud"]')).toBeNull();
    });

    it("keeps Start on an offline machine neutral and at its label's width", async () => {
      await renderPanel({
        onStartRuntime: vi.fn(),
        runtimeOptions: [runtimeOption()],
        interactionMode: "manage",
      });

      const startButton = container.querySelector<HTMLButtonElement>(
        '[data-testid="runtime-start-existing"]',
      );
      expect(startButton?.className).not.toContain("w-full");
      expect(startButton?.className).not.toContain("bg-primary-600");
    });
  });

  it("counts the team's hosted machines and names a blocker only by its own name", async () => {
    await renderPanel({
      runtimeEnsureError: "runtime limit reached",
      runtimeEnsureLimit: {
        limitReached: true,
        activeCount: 3,
        maxActiveCount: 3,
        blockerRuntimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        blockerProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        blockerRuntimeLabel: "Hosted Runtime",
        blockerProjectLabel: "Acme",
      },
      onRetryHosted: vi.fn(async () => true),
      runtimeOptions: [runtimeOption()],
    });

    expect(container.textContent).toContain("Hosted machine limit reached");
    expect(container.textContent).toContain(
      '3/3 hosted machines for this team are in use. The blocking machine is in the space "Acme".',
    );
    // The stored "Hosted Runtime" is no name of the machine's own, and the
    // summary already names the space: no line for the blocking machine.
    expect(container.textContent).not.toContain("Blocking machine:");
    expect(container.textContent).not.toContain("Hosted Runtime");

    await renderPanel({
      runtimeEnsureError: "runtime limit reached",
      runtimeEnsureLimit: {
        limitReached: true,
        activeCount: 3,
        maxActiveCount: 3,
        blockerRuntimeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        blockerProjectId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        blockerRuntimeLabel: "Browser session",
        blockerProjectLabel: "Acme",
      },
      onRetryHosted: vi.fn(async () => true),
      runtimeOptions: [runtimeOption()],
    });

    // A machine's own name stays its name.
    expect(container.textContent).toContain("Blocking machine: Browser session.");

    await renderPanel({
      runtimeEnsureError: "Instafy Cloud runtime limit reached for this organization.",
      onRetryHosted: vi.fn(async () => true),
      runtimeOptions: [runtimeOption()],
    });

    expect(container.textContent).toContain("All hosted machines for this team are in use.");
  });
});
