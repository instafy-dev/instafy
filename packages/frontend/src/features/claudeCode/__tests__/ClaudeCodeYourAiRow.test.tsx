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
const NATIVE_CLAUDE = "/Users/sam/.local/bin/claude";
const NOT_MADE =
  "Error invoking remote method 'instafy:desktopExtensionInvoke': DesktopExtensionChangeNotMadeError: Instafy is still working on this computer, so that change was not made.";

type DesktopStatus = {
  supported: boolean;
  found: boolean;
  consented: boolean;
  path?: string;
  problem?: string;
  candidatePath?: string;
  candidateProblem?: string;
  shellSetting?: string;
};

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
    expect(text("credentials-claude-code-path")).toBe("Not found");
    expect(text("credentials-claude-code-status")).toBe(
      "Other accounts on this computer can change this file, so Instafy Desktop won't use it. Locate a copy only you can change.",
    );
  });

  // D26: Desktop checks a login-shell CLAUDE_CONFIG_DIR or NODE_EXTRA_CA_CERTS
  // as runtime-agent does before every turn, and names the one it can't use.
  it("names the login-shell setting Desktop can't use, and the copy itself is not blamed", async () => {
    desktopStatus = {
      supported: true,
      found: false,
      consented: false,
      path: CLAUDE,
      problem: "shell_setting_unusable",
      shellSetting: "NODE_EXTRA_CA_CERTS",
    };
    await render();
    // Desktop checks the settings only once the program passed: it was found.
    expect(text("credentials-claude-code-path")).toBe(`Found at ${CLAUDE}`);
    expect(text("credentials-claude-code-status")).toBe(
      "Your login shell sets NODE_EXTRA_CA_CERTS to something Instafy Desktop can't use. It must be the full path of a file that only you can change. Fix it, then choose Find.",
    );
    expect(button("credentials-claude-code-enable")?.disabled).toBe(true);

    // Once it is on, a folder that changed after consent shows the same way.
    desktopStatus = {
      supported: true,
      found: false,
      consented: true,
      path: CLAUDE,
      problem: "shell_setting_unusable",
      shellSetting: "CLAUDE_CONFIG_DIR",
    };
    await render();
    expect(text("credentials-claude-code-path")).toBe(`Found at ${CLAUDE}`);
    expect(text("credentials-claude-code-status")).toBe(
      "Your login shell sets CLAUDE_CONFIG_DIR to something Instafy Desktop can't use. It must be the full path of a folder that only you can change. Fix it, then choose Find.",
    );

    // A Desktop that names no setting still gets a sentence about settings.
    desktopStatus = { supported: true, found: false, consented: false, path: CLAUDE, problem: "shell_setting_unusable" };
    await render();
    expect(text("credentials-claude-code-status")).toContain("CLAUDE_CONFIG_DIR or NODE_EXTRA_CA_CERTS");
    expect(bannedWordIn(text("credentials-claude-code-row") ?? "")).toBeNull();
  });

  // docs/Local-Engine-Turns.md 4.1: while it is on, Find and Locate answer
  // the path in use, with what they turned up beside it.
  it("shows what Find turned up beside the copy in use, and uses it only once the person confirms it", async () => {
    const on = { supported: true, found: true, consented: true, path: CLAUDE };
    desktopStatus = on;
    invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
      if (options.method === "status") return desktopStatus;
      if (options.method === "detect") return { ...on, candidatePath: NATIVE_CLAUDE };
      if (options.method === "enable") return { ...on, path: NATIVE_CLAUDE };
      throw new Error("unexpected");
    });
    await render();
    expect(text("credentials-claude-code-candidate")).toBeNull();
    expect(button("credentials-claude-code-enable")).toBeNull();

    await press("credentials-claude-code-detect");
    // Turns keep the copy in use, and so does the row.
    expect(text("credentials-claude-code-path")).toBe(`Found at ${CLAUDE}`);
    expect(text("credentials-claude-code-status")).toBe("Ready on this computer.");
    expect(text("credentials-claude-code-candidate-path")).toBe(`Also found at ${NATIVE_CLAUDE}`);
    expect(text("credentials-claude-code-candidate-status")).toBe("Choose Use for my messages to use it instead.");
    expect(button("credentials-claude-code-disable")?.textContent).toBe("Turn off");
    expect(button("credentials-claude-code-enable")?.textContent).toBe("Use for my messages");

    // Desktop's own consent dialog confirms it.
    await press("credentials-claude-code-enable");
    expect(invokeDesktopExtension).toHaveBeenCalledWith(expect.objectContaining({ method: "enable" }));
    expect(text("credentials-claude-code-path")).toBe(`Found at ${NATIVE_CLAUDE}`);
    expect(text("credentials-claude-code-candidate")).toBeNull();
    expect(button("credentials-claude-code-enable")).toBeNull();
  });

  // D26: a recorded NODE_EXTRA_CA_CERTS whose file went away after consent
  // makes every turn refuse. Once the person fixes their login shell, Find
  // reads new settings for the copy in use, and only Use for my messages,
  // through Desktop's consent dialog, puts them in use (4.1). The answers are
  // Desktop's own (packages/desktop-app/test/claude-code-desktop.test.mjs).
  it("offers new login-shell settings Find read for the copy in use, once the recorded ones no longer work", async () => {
    const on = { supported: true, found: true, consented: true, path: CLAUDE };
    const stale = { ...on, found: false, problem: "shell_setting_unusable", shellSetting: "NODE_EXTRA_CA_CERTS" };
    const renewed = { ...stale, candidatePath: CLAUDE };
    desktopStatus = stale;
    fetchRuntimeStatus.mockResolvedValue(statusAnswer({ ...READY, ready: false, reason: "binary_unsafe" }));
    invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
      if (options.method === "status") return desktopStatus;
      if (options.method === "detect") return renewed;
      if (options.method === "enable") return on;
      throw new Error("unexpected");
    });
    await render();
    expect(text("credentials-claude-code-path")).toBe(`Found at ${CLAUDE}`);
    expect(text("credentials-claude-code-status")).toBe(
      "Your login shell sets NODE_EXTRA_CA_CERTS to something Instafy Desktop can't use. It must be the full path of a file that only you can change. Fix it, then choose Find.",
    );
    expect(text("credentials-claude-code-candidate")).toBeNull();
    expect(button("credentials-claude-code-enable")).toBeNull();

    await press("credentials-claude-code-detect");
    // Turns keep the recorded settings, and the row keeps the copy in use,
    // with no second path: the new settings are for that same copy.
    expect(text("credentials-claude-code-path")).toBe(`Found at ${CLAUDE}`);
    expect(text("credentials-claude-code-candidate-path")).toBeNull();
    expect(text("credentials-claude-code-candidate-status")).toBe(
      "Find read new settings from your login shell that Instafy Desktop can use with this copy. Choose Use for my messages to use them.",
    );
    expect(button("credentials-claude-code-disable")?.textContent).toBe("Turn off");
    expect(button("credentials-claude-code-enable")?.textContent).toBe("Use for my messages");
    expect(button("credentials-claude-code-enable")?.disabled).toBe(false);
    expect(bannedWordIn(text("credentials-claude-code-row") ?? "")).toBeNull();

    // Desktop's own consent dialog confirms them, and the runtime it starts
    // with the new grant is ready.
    fetchRuntimeStatus.mockResolvedValue(statusAnswer(READY));
    await press("credentials-claude-code-enable");
    expect(invokeDesktopExtension).toHaveBeenCalledWith(
      expect.objectContaining({ extensionId: "claude-code", method: "enable", controllerUrl: CONTROLLER_URL }),
    );
    expect(text("credentials-claude-code-path")).toBe(`Found at ${CLAUDE}`);
    expect(text("credentials-claude-code-status")).toBe("Ready on this computer.");
    expect(text("credentials-claude-code-candidate")).toBeNull();
    expect(button("credentials-claude-code-enable")).toBeNull();
  });

  it("keeps the copy in use when Find turns up nothing, or one Desktop won't use", async () => {
    const on = { supported: true, found: true, consented: true, path: CLAUDE };
    desktopStatus = on;
    let found: DesktopStatus = { ...on, candidateProblem: "not_found" };
    invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
      if (options.method === "status") return desktopStatus;
      if (options.method === "detect") return found;
      throw new Error("unexpected");
    });
    await render();
    await press("credentials-claude-code-detect");
    expect(text("credentials-claude-code-path")).toBe(`Found at ${CLAUDE}`);
    expect(text("credentials-claude-code-status")).toBe("Ready on this computer.");
    expect(text("credentials-claude-code-candidate-path")).toBeNull();
    expect(text("credentials-claude-code-candidate-status")).toBe(
      "Find didn't turn up any other copy. Your messages keep using this one.",
    );
    expect(button("credentials-claude-code-enable")).toBeNull();

    found = {
      ...on,
      candidatePath: NATIVE_CLAUDE,
      candidateProblem: "shell_setting_unusable",
      shellSetting: "CLAUDE_CONFIG_DIR",
    };
    await press("credentials-claude-code-detect");
    expect(text("credentials-claude-code-path")).toBe(`Found at ${CLAUDE}`);
    expect(text("credentials-claude-code-candidate-path")).toBe(`Also found at ${NATIVE_CLAUDE}`);
    expect(text("credentials-claude-code-candidate-status")).toBe(
      "Your login shell sets CLAUDE_CONFIG_DIR to something Instafy Desktop can't use. It must be the full path of a folder that only you can change. Fix it, then choose Find.",
    );
    expect(button("credentials-claude-code-enable")).toBeNull();

    found = { ...on, candidatePath: NATIVE_CLAUDE, candidateProblem: "not_executable" };
    await press("credentials-claude-code-detect");
    expect(text("credentials-claude-code-candidate-status")).toBe(
      "Instafy Desktop can't run the file at this path. Locate the claude program.",
    );
    expect(button("credentials-claude-code-enable")).toBeNull();
  });

  it("shows only Desktop's words for a change it didn't make, whatever its error's name", async () => {
    desktopStatus = { supported: true, found: true, consented: false, path: CLAUDE };
    invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
      if (options.method === "status") return desktopStatus;
      throw new Error(NOT_MADE);
    });
    await render();
    await press("credentials-claude-code-enable");
    expect(text("credentials-claude-code-error")).toBe(
      "Instafy is still working on this computer, so that change was not made.",
    );
  });

  // Desktop puts a refused change back after the person chose Keep working. A
  // status read that began before that (a focus while Desktop asked) must not
  // show the change beside the words that say it wasn't made.
  it("reads the status again after a refused change, so an older read never shows it as made", async () => {
    const off = { supported: true, found: true, consented: false, path: CLAUDE };
    desktopStatus = off;
    let heldStatus = null as { resolve: (status: DesktopStatus) => void } | null;
    let holdNextStatus = false;
    let rejectEnable = null as ((error: Error) => void) | null;
    invokeDesktopExtension.mockImplementation((options: { method: string }) => {
      if (options.method === "status") {
        if (holdNextStatus) {
          holdNextStatus = false;
          return new Promise<DesktopStatus>((resolve) => {
            heldStatus = { resolve };
          });
        }
        return Promise.resolve(desktopStatus);
      }
      if (options.method === "enable") {
        // Desktop wrote the record, then shows its "still working" sheet.
        desktopStatus = { ...off, consented: true };
        return new Promise((_, reject) => {
          rejectEnable = reject;
        });
      }
      return Promise.reject(new Error("unexpected"));
    });
    await render();
    const methods = () => invokeDesktopExtension.mock.calls.map(([request]) => request.method);

    await press("credentials-claude-code-enable");
    expect(methods()).toEqual(["status", "enable"]);
    // The window gets focus while the sheet is open: that read sees the record.
    holdNextStatus = true;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(heldStatus).not.toBeNull();

    // Keep working: Desktop puts the store back and refuses the change. The
    // row reads the status again.
    desktopStatus = off;
    await act(async () => {
      rejectEnable?.(new Error(NOT_MADE));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(methods()).toEqual(["status", "enable", "status", "status"]);

    // The read from before the refusal answers last, and changes nothing.
    await act(async () => {
      heldStatus?.resolve({ ...off, consented: true });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(text("credentials-claude-code-error")).toBe(
      "Instafy is still working on this computer, so that change was not made.",
    );
    expect(text("credentials-claude-code-status")).toBe(
      "Off. Choose Use for my messages to turn it on for this computer.",
    );
    expect(button("credentials-claude-code-disable")).toBeNull();
    expect(button("credentials-claude-code-enable")?.textContent).toBe("Use for my messages");
  });
});
