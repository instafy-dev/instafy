// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControllerRuntimeClaudeCode,
  FetchRuntimeStatusResult,
} from "../../../services/runtimeController/runtimes";
import { CLAUDE_CODE_FIRST_USE_NOTE_STORAGE_KEY, ClaudeCodeYourAiRow } from "../ClaudeCodeYourAiRow";
import { forgetClaudeCodeDesktopRefusalForTests } from "../claudeCodeDesktop";
import { bannedWordIn } from "./claudeCodeBannedWords";

const CONTROLLER_URL = "https://controller.example.test";
const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const RUNTIME_ID = "99999999-8888-4777-8666-555555555555";
const CLAUDE = "/opt/homebrew/bin/claude";

type DesktopStatus = { supported: boolean; found: boolean; consented: boolean; path?: string; problem?: string };

const READY: ControllerRuntimeClaudeCode = { ready: true, reason: null, cli: "2.1.320", verified: true, planSignIn: true };

let desktopStatus: DesktopStatus;
let desktopRuntime: { running: boolean; projectId?: string; runtimeId?: string };
let invokeDesktopExtension: ReturnType<typeof vi.fn>;
let fetchRuntimeStatus: ReturnType<typeof vi.fn>;

function statusAnswer(
  claudeCode: ControllerRuntimeClaudeCode | null,
  { lane = true, listed = true }: { lane?: boolean; listed?: boolean } = {},
): FetchRuntimeStatusResult {
  return {
    runtimes: listed ? [{ runtimeId: RUNTIME_ID, status: "online", claudeCode } as never] : [],
    preferredRuntimeId: null,
    ...(lane ? { claudeCodeLane: true as const } : {}),
  };
}

describe("Claude Code in Your AI", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    forgetClaudeCodeDesktopRefusalForTests();
    window.localStorage.clear();
    desktopStatus = { supported: true, found: true, consented: true, path: CLAUDE };
    desktopRuntime = { running: true, projectId: PROJECT_ID, runtimeId: RUNTIME_ID };
    invokeDesktopExtension = vi.fn(async (options: { method: string }) => {
      if (options.method === "status") {
        return desktopStatus;
      }
      throw new Error(`unexpected ${options.method}`);
    });
    fetchRuntimeStatus = vi.fn(async () => statusAnswer(READY));
    Object.assign(window, {
      instafyDesktop: { invokeDesktopExtension, desktopRuntimeStatus: async () => desktopRuntime },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (window as { instafyDesktop?: unknown }).instafyDesktop;
    delete (window as { __INSTAFY_ACTIVE_PROJECT_ID__?: unknown }).__INSTAFY_ACTIVE_PROJECT_ID__;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  // Each render mounts the row anew: it reads Desktop and the controller when
  // it mounts, and again when the window gets focus.
  async function render() {
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => {
      root.render(
        <ClaudeCodeYourAiRow
          fetchRuntimeStatus={fetchRuntimeStatus as never}
          resolveControllerUrl={async () => CONTROLLER_URL}
        />,
      );
    });
  }

  const text = (testId: string) => container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
  const button = (testId: string) => container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

  async function press(testId: string) {
    await act(async () => {
      button(testId)?.click();
    });
  }

  it("shows only in Desktop, where it is supported, for a person the lane covers", async () => {
    delete (window as { instafyDesktop?: unknown }).instafyDesktop;
    await render();
    expect(container.innerHTML).toBe("");
    expect(fetchRuntimeStatus).not.toHaveBeenCalled();

    Object.assign(window, { instafyDesktop: { invokeDesktopExtension, desktopRuntimeStatus: async () => desktopRuntime } });
    desktopStatus = { supported: false, found: false, consented: false };
    await render();
    expect(container.innerHTML).toBe("");

    desktopStatus = { supported: true, found: true, consented: true, path: CLAUDE };
    fetchRuntimeStatus.mockResolvedValue(statusAnswer(READY, { lane: false }));
    await render();
    expect(container.innerHTML).toBe("");

    fetchRuntimeStatus.mockResolvedValue(statusAnswer(READY));
    await render();
    expect(text("credentials-claude-code-row")).toContain("Claude Code on this computer");
    // Desktop is asked about the controller Studio talks to; the controller about this computer's space.
    expect(invokeDesktopExtension).toHaveBeenCalledWith(
      expect.objectContaining({ extensionId: "claude-code", method: "status", controllerUrl: CONTROLLER_URL }),
    );
    expect(fetchRuntimeStatus).toHaveBeenCalledWith(expect.objectContaining({ projectId: PROJECT_ID }));
  });

  it("is never a connection to make the default, and promises nothing about price", async () => {
    await render();
    const row = text("credentials-claude-code-row") ?? "";
    expect(row).not.toMatch(/default/i);
    expect(row).not.toMatch(/\bincluded\b/i);
    expect(row).toContain("Anthropic's current terms");
    expect(bannedWordIn(row)).toBeNull();
  });

  it("names the plan only when this computer's runtime found a Claude plan sign-in", async () => {
    await render();
    expect(text("credentials-claude-code-sign-in")).toBe("Runs on your own Claude plan, under Anthropic's current terms.");
    fetchRuntimeStatus.mockResolvedValue(statusAnswer({ ...READY, planSignIn: false }));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(text("credentials-claude-code-sign-in")).toBe(
      "Uses your own Claude Code sign-in, under Anthropic's current terms.",
    );
  });

  it("says where Claude Code was found and whether this computer can take a turn, with a remedy when not", async () => {
    await render();
    expect(text("credentials-claude-code-path")).toBe(`Found at ${CLAUDE}`);
    expect(text("credentials-claude-code-status")).toBe("Ready on this computer.");

    fetchRuntimeStatus.mockResolvedValue(statusAnswer({ ...READY, ready: false, reason: "unsupported_version" }));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(text("credentials-claude-code-status")).toBe(
      "This version of Claude Code can't take turns from Instafy. Update Claude Code.",
    );

    fetchRuntimeStatus.mockResolvedValue(statusAnswer(null));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(text("credentials-claude-code-status")).toBe(
      "Claude Code isn't ready on this computer yet. It's checked again when this space starts.",
    );
  });

  it("asks to start the open space here when this computer runs none", async () => {
    desktopRuntime = { running: false };
    Object.assign(window, { __INSTAFY_ACTIVE_PROJECT_ID__: PROJECT_ID });
    fetchRuntimeStatus.mockResolvedValue(statusAnswer(null, { listed: false }));
    await render();
    expect(text("credentials-claude-code-status")).toBe("Start this space on this computer to check it here.");
  });

  it("finds Claude Code, then turns it on through Desktop's own consent dialog", async () => {
    desktopStatus = { supported: true, found: false, consented: false };
    invokeDesktopExtension.mockImplementation(async (options: { method: string; controllerUrl?: string }) => {
      if (options.method === "status") return desktopStatus;
      if (options.method === "detect") return { supported: true, found: true, consented: false, path: CLAUDE };
      if (options.method === "enable") return { supported: true, found: true, consented: true, path: CLAUDE };
      throw new Error("unexpected");
    });
    await render();
    expect(text("credentials-claude-code-path")).toBe("Not found");
    expect(text("credentials-claude-code-status")).toBe(
      "Off. Choose Use for my messages to turn it on for this computer.",
    );
    // Nothing to consent to before a program is found.
    expect(button("credentials-claude-code-enable")?.disabled).toBe(true);

    await press("credentials-claude-code-detect");
    expect(invokeDesktopExtension).toHaveBeenCalledWith(
      expect.objectContaining({ extensionId: "claude-code", method: "detect", controllerUrl: CONTROLLER_URL }),
    );
    expect(text("credentials-claude-code-path")).toBe(`Found at ${CLAUDE}`);
    expect(button("credentials-claude-code-enable")?.textContent).toBe("Use for my messages");
    expect(button("credentials-claude-code-enable")?.disabled).toBe(false);

    await press("credentials-claude-code-enable");
    expect(invokeDesktopExtension).toHaveBeenCalledWith(expect.objectContaining({ method: "enable" }));
    expect(text("credentials-claude-code-status")).toBe("Ready on this computer.");
    expect(button("credentials-claude-code-disable")?.textContent).toBe("Turn off");
  });

  it("shows the one-time note once it is on, until it is read", async () => {
    await render();
    expect(text("credentials-claude-code-first-use")).toContain(
      "Sign in to Claude Code on this computer first: run claude in a terminal once.",
    );
    await press("credentials-claude-code-first-use-dismiss");
    expect(text("credentials-claude-code-first-use")).toBeNull();
    expect(window.localStorage.getItem(CLAUDE_CODE_FIRST_USE_NOTE_STORAGE_KEY)).toBe("1");
    await render();
    expect(text("credentials-claude-code-first-use")).toBeNull();
  });

  it("turns it off, and says what Desktop refused in Desktop's own words", async () => {
    invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
      if (options.method === "status") return desktopStatus;
      if (options.method === "disable") return { supported: true, found: true, consented: false, path: CLAUDE };
      throw new Error(
        "Error invoking remote method 'instafy:desktopExtensionInvoke': Error: Sign in to Instafy in this window, then try again.",
      );
    });
    await render();
    await press("credentials-claude-code-locate");
    expect(text("credentials-claude-code-error")).toBe("Sign in to Instafy in this window, then try again.");
    await press("credentials-claude-code-disable");
    expect(invokeDesktopExtension).toHaveBeenCalledWith(expect.objectContaining({ method: "disable" }));
    expect(text("credentials-claude-code-error")).toBeNull();
    expect(button("credentials-claude-code-enable")).not.toBeNull();
  });

  it("says why Desktop won't use the program it has", async () => {
    desktopStatus = { supported: true, found: false, consented: false, path: CLAUDE, problem: "writable_by_others" };
    await render();
    expect(text("credentials-claude-code-status")).toBe(
      "Other accounts on this computer can change this file, so Instafy Desktop won't use it. Locate a copy only you can change.",
    );
  });
});
