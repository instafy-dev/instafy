// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControllerRuntimeClaudeCode,
  FetchRuntimeStatusResult,
} from "../../../services/runtimeController/runtimes";
import { CLAUDE_CODE_FIRST_USE_NOTE_STORAGE_KEY, ClaudeCodeYourAiRow } from "../ClaudeCodeYourAiRow";
import { CLAUDE_CODE_COPY } from "../claudeCodeCopy";
import { forgetClaudeCodeDesktopRefusalForTests } from "../claudeCodeDesktop";
import { bannedWordIn } from "./claudeCodeBannedWords";

const CONTROLLER_URL = "https://controller.example.test";
const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const RUNTIME_ID = "99999999-8888-4777-8666-555555555555";
const CLAUDE = "/opt/homebrew/bin/claude";
const NATIVE_CLAUDE = "/home/sam/.local/bin/claude";
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
    // Nothing to consent to before a program is found, so the row doesn't ask for it.
    expect(text("credentials-claude-code-status")).toBe(
      "Off. Choose Find or Locate… to pick the claude program, then Use for my messages.",
    );
    expect(button("credentials-claude-code-enable")?.disabled).toBe(true);

    await press("credentials-claude-code-detect");
    expect(invokeDesktopExtension).toHaveBeenCalledWith(
      expect.objectContaining({ extensionId: "claude-code", method: "detect", controllerUrl: CONTROLLER_URL }),
    );
    expect(text("credentials-claude-code-path")).toBe(`Found at ${CLAUDE}`);
    expect(text("credentials-claude-code-status")).toBe(
      "Off. Choose Use for my messages to turn it on for this computer.",
    );
    expect(button("credentials-claude-code-enable")?.textContent).toBe("Use for my messages");
    expect(button("credentials-claude-code-enable")?.disabled).toBe(false);

    await press("credentials-claude-code-enable");
    expect(invokeDesktopExtension).toHaveBeenCalledWith(expect.objectContaining({ method: "enable" }));
    expect(text("credentials-claude-code-status")).toBe("Ready on this computer.");
    expect(button("credentials-claude-code-disable")?.textContent).toBe("Turn off");
  });

  it("shows the one-time note once it is on, until it is read", async () => {
    // This computer's runtime found no Claude plan sign-in.
    fetchRuntimeStatus.mockResolvedValue(statusAnswer({ ...READY, planSignIn: false }));
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

  it("leaves the note out once this computer's runtime found the Claude plan sign-in it asks for", async () => {
    // Before the runtime has reported, the note shows; not beside "Ready" for someone signed in.
    fetchRuntimeStatus.mockResolvedValue(statusAnswer(null));
    await render();
    expect(text("credentials-claude-code-first-use")).not.toBeNull();

    fetchRuntimeStatus.mockResolvedValue(statusAnswer(READY));
    await render();
    expect(text("credentials-claude-code-status")).toBe("Ready on this computer.");
    expect(text("credentials-claude-code-first-use")).toBeNull();
    // Not read, only not needed: it isn't marked as read.
    expect(window.localStorage.getItem(CLAUDE_CODE_FIRST_USE_NOTE_STORAGE_KEY)).toBeNull();
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
    // The shell no longer sets the recorded value, and choosing Find is done:
    // the status line says what the runtime says, and the candidate what is left.
    expect(text("credentials-claude-code-status")).not.toContain("Your login shell sets");
    expect(text("credentials-claude-code-row")).not.toContain("Fix it, then choose Find.");
    expect(text("credentials-claude-code-status")).toBe(CLAUDE_CODE_COPY.yourAi.notReady.binary_unsafe);
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

  // Turning it on alters the running runtime's grant, so Desktop replaces that
  // runtime before it answers (docs/Local-Engine-Turns.md 4.3); the new one is
  // listed only once it has registered with the controller.
  describe("while Desktop replaces this computer's runtime after a change", () => {
    const replacementId = (n: number) => `aaaaaaaa-bbbb-4ccc-8ddd-${String(n).padStart(12, "0")}`;
    const NEW_RUNTIME_ID = replacementId(1);
    const STATUS = "credentials-claude-code-status";
    let replacements = 0;

    function listing(runtimeId: string, claudeCode: ControllerRuntimeClaudeCode | null): FetchRuntimeStatusResult {
      return {
        runtimes: [{ runtimeId, status: "online", claudeCode } as never],
        preferredRuntimeId: null,
        claudeCodeLane: true,
      };
    }

    async function wait(ms: number) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
        // Let the read the last timer started finish before the test looks.
        for (let i = 0; i < 5; i += 1) {
          await vi.advanceTimersByTimeAsync(0);
        }
      });
    }

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      replacements = 0;
      desktopStatus = { supported: true, found: true, consented: false, path: CLAUDE };
      // The running runtime was started with no grant: listed, reporting nothing.
      fetchRuntimeStatus.mockResolvedValue(listing(RUNTIME_ID, null));
      invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
        if (options.method === "status") return desktopStatus;
        if (options.method === "enable") {
          // Desktop records the consent, and has replaced the runtime when it answers.
          desktopStatus = { ...desktopStatus, consented: true };
          if (desktopRuntime.running) {
            replacements += 1;
            desktopRuntime = { running: true, projectId: PROJECT_ID, runtimeId: replacementId(replacements) };
          }
          return desktopStatus;
        }
        throw new Error("unexpected");
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("says it is checking this computer, then the new runtime's readiness, and stops reading", async () => {
      await render();
      expect(text(STATUS)).toBe("Off. Choose Use for my messages to turn it on for this computer.");

      await press("credentials-claude-code-enable");
      // Not "Start this space on this computer": the space runs, on a runtime not listed yet.
      expect(text(STATUS)).toBe("Checking this computer…");
      // Nor the sign-in note yet: the new runtime may report the sign-in it asks for.
      expect(text("credentials-claude-code-first-use")).toBeNull();
      await wait(1_000);
      expect(text(STATUS)).toBe("Checking this computer…");

      fetchRuntimeStatus.mockResolvedValue(listing(NEW_RUNTIME_ID, READY));
      await wait(2_000);
      expect(text(STATUS)).toBe("Ready on this computer.");
      expect(text("credentials-claude-code-first-use")).toBeNull();
      const reads = fetchRuntimeStatus.mock.calls.length;
      await wait(60_000);
      expect(fetchRuntimeStatus.mock.calls.length).toBe(reads);
      expect(text(STATUS)).toBe("Ready on this computer.");
    });

    it("checks a runtime started since the row last read, as one started while Your AI is open", async () => {
      // The row read when this computer ran no runtime.
      desktopRuntime = { running: false };
      Object.assign(window, { __INSTAFY_ACTIVE_PROJECT_ID__: PROJECT_ID });
      fetchRuntimeStatus.mockResolvedValue(statusAnswer(null, { listed: false }));
      await render();
      expect(text(STATUS)).toBe("Off. Choose Use for my messages to turn it on for this computer.");

      // The space starts on this computer, and nothing makes the row read again.
      desktopRuntime = { running: true, projectId: PROJECT_ID, runtimeId: RUNTIME_ID };
      fetchRuntimeStatus.mockResolvedValue(listing(RUNTIME_ID, null));
      await press("credentials-claude-code-enable");
      expect(text(STATUS)).toBe("Checking this computer…");

      fetchRuntimeStatus.mockResolvedValue(listing(NEW_RUNTIME_ID, READY));
      await wait(1_000);
      expect(text(STATUS)).toBe("Ready on this computer.");
    });

    it("goes on checking through a later action that replaces nothing, until the new runtime is listed", async () => {
      await render();
      await press("credentials-claude-code-enable");
      expect(text(STATUS)).toBe("Checking this computer…");

      // Find while it checks: Desktop keeps the runtime it just started.
      invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
        if (options.method === "status") return desktopStatus;
        if (options.method === "detect") return desktopStatus;
        throw new Error("unexpected");
      });
      await press("credentials-claude-code-detect");
      expect(text(STATUS)).toBe("Checking this computer…");

      fetchRuntimeStatus.mockResolvedValue(listing(NEW_RUNTIME_ID, READY));
      await wait(1_000);
      expect(text(STATUS)).toBe("Ready on this computer.");
    });

    it("goes on checking after a change Desktop refused, while the new runtime registers", async () => {
      await render();
      await press("credentials-claude-code-enable");
      expect(text(STATUS)).toBe("Checking this computer…");

      // Locate while it checks, and the person keeps the work going.
      invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
        if (options.method === "status") return desktopStatus;
        if (options.method === "locate") throw new Error(NOT_MADE);
        throw new Error("unexpected");
      });
      await press("credentials-claude-code-locate");
      expect(text("credentials-claude-code-error")).toBe(
        "Instafy is still working on this computer, so that change was not made.",
      );
      expect(text(STATUS)).toBe("Checking this computer…");

      fetchRuntimeStatus.mockResolvedValue(listing(NEW_RUNTIME_ID, READY));
      await wait(1_000);
      expect(text(STATUS)).toBe("Ready on this computer.");
    });

    it("doesn't wait when a read after the change fails but Desktop kept its runtime", async () => {
      invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
        if (options.method === "status") return desktopStatus;
        if (options.method === "enable") {
          desktopStatus = { ...desktopStatus, consented: true };
          return desktopStatus;
        }
        throw new Error("unexpected");
      });
      await render();
      const before = fetchRuntimeStatus.mock.calls.length;
      fetchRuntimeStatus.mockRejectedValueOnce(new Error("offline"));
      await press("credentials-claude-code-enable");
      expect(text(STATUS)).not.toBe("Checking this computer…");
      await wait(60_000);
      expect(fetchRuntimeStatus.mock.calls.length - before).toBe(1);
    });

    it("stops after about 30 seconds when no new runtime is listed", async () => {
      await render();
      const before = fetchRuntimeStatus.mock.calls.length;
      await press("credentials-claude-code-enable");
      expect(text(STATUS)).toBe("Checking this computer…");
      await wait(29_000);
      expect(text(STATUS)).toBe("Checking this computer…");
      await wait(1_000);
      expect(text(STATUS)).toBe("Start this space on this computer to check it here.");
      // The read with Desktop's answer, then one after each wait.
      expect(fetchRuntimeStatus.mock.calls.length - before).toBe(1 + 7);
      await wait(60_000);
      expect(fetchRuntimeStatus.mock.calls.length - before).toBe(1 + 7);
    });

    it("doesn't wait when Desktop kept its runtime, as it keeps a Personal Browser one", async () => {
      invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
        if (options.method === "status") return desktopStatus;
        if (options.method === "enable") {
          desktopStatus = { ...desktopStatus, consented: true };
          return desktopStatus;
        }
        throw new Error("unexpected");
      });
      await render();
      const before = fetchRuntimeStatus.mock.calls.length;
      await press("credentials-claude-code-enable");
      expect(text(STATUS)).toBe(
        "Claude Code isn't ready on this computer yet. It's checked again when this space starts.",
      );
      await wait(60_000);
      expect(fetchRuntimeStatus.mock.calls.length - before).toBe(1);
    });

    it("doesn't wait when the runtime Desktop was to start in its place didn't start", async () => {
      invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
        if (options.method === "status") return desktopStatus;
        if (options.method === "enable") {
          // The change was made, and the replacement didn't start.
          desktopStatus = { ...desktopStatus, consented: true };
          desktopRuntime = { running: false };
          return desktopStatus;
        }
        throw new Error("unexpected");
      });
      Object.assign(window, { __INSTAFY_ACTIVE_PROJECT_ID__: PROJECT_ID });
      await render();
      const before = fetchRuntimeStatus.mock.calls.length;
      await press("credentials-claude-code-enable");
      expect(text(STATUS)).toBe("Start this space on this computer to check it here.");
      await wait(60_000);
      expect(fetchRuntimeStatus.mock.calls.length - before).toBe(1);
    });

    it("reads once when this computer runs no runtime, since nothing starts until the space does", async () => {
      desktopRuntime = { running: false };
      Object.assign(window, { __INSTAFY_ACTIVE_PROJECT_ID__: PROJECT_ID });
      fetchRuntimeStatus.mockResolvedValue(statusAnswer(null, { listed: false }));
      await render();
      const before = fetchRuntimeStatus.mock.calls.length;
      await press("credentials-claude-code-enable");
      expect(text(STATUS)).toBe("Start this space on this computer to check it here.");
      await wait(60_000);
      expect(fetchRuntimeStatus.mock.calls.length - before).toBe(1);
    });

    it("ends the reads when the row goes away, or another action begins", async () => {
      await render();
      await press("credentials-claude-code-enable");
      expect(text(STATUS)).toBe("Checking this computer…");
      // Turn off while it checks: that change leaves it off, so nothing more is read for the first one.
      invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
        if (options.method === "status") return desktopStatus;
        if (options.method === "disable") {
          desktopStatus = { ...desktopStatus, consented: false };
          return desktopStatus;
        }
        throw new Error("unexpected");
      });
      await press("credentials-claude-code-disable");
      expect(text(STATUS)).toBe("Off. Choose Use for my messages to turn it on for this computer.");
      const afterOff = fetchRuntimeStatus.mock.calls.length;
      await wait(60_000);
      expect(fetchRuntimeStatus.mock.calls.length).toBe(afterOff);

      // Unmounted while checking: no read after it.
      desktopStatus = { ...desktopStatus, consented: false };
      invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
        if (options.method === "status") return desktopStatus;
        if (options.method === "enable") {
          desktopStatus = { ...desktopStatus, consented: true };
          replacements += 1;
          desktopRuntime = { running: true, projectId: PROJECT_ID, runtimeId: replacementId(replacements) };
          return desktopStatus;
        }
        throw new Error("unexpected");
      });
      await render();
      await press("credentials-claude-code-enable");
      expect(text(STATUS)).toBe("Checking this computer…");
      await act(async () => root.unmount());
      const atUnmount = fetchRuntimeStatus.mock.calls.length;
      await wait(60_000);
      expect(fetchRuntimeStatus.mock.calls.length).toBe(atUnmount);
      root = createRoot(container);
    });
  });
});
