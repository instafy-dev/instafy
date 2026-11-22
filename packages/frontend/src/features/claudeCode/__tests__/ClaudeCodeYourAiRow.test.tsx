// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ControllerRuntimeClaudeCode,
  ControllerRuntimeClaudeCodeLogin,
  FetchRuntimeStatusResult,
} from "../../../services/runtimeController/runtimes";
import { CLAUDE_CODE_FIRST_USE_NOTE_STORAGE_KEY, ClaudeCodeYourAiRow } from "../ClaudeCodeYourAiRow";
import { CLAUDE_CODE_COPY } from "../claudeCodeCopy";
import { forgetClaudeCodeDesktopRefusalForTests } from "../claudeCodeDesktop";
import { claudeCodeLoginsSnapshot, setClaudeCodeLoginsLoaderForTests } from "../claudeCodeLoginsStore";
import { formatUsageLimitResetTime } from "../../../conversations/usageLimitReset";
import { bannedWordIn } from "./claudeCodeBannedWords";

// The person's logins, as GET/POST/PATCH/DELETE /me/claude-code-logins
// answer (docs/Local-Engine-Turns.md 11.19). Nothing reaches a controller.
const loginsClient = vi.hoisted(() => ({
  listClaudeCodeLogins: vi.fn(),
  createClaudeCodeLogin: vi.fn(),
  renameClaudeCodeLogin: vi.fn(),
  deleteClaudeCodeLogin: vi.fn(),
}));
vi.mock("../../../services/runtimeController/claudeCodeLogins", () => ({
  ...loginsClient,
  normalizeClaudeCodeLoginLabel: (value: unknown) => {
    const label = typeof value === "string" ? value.trim() : "";
    return label.length >= 1 && label.length <= 60 && !/\p{Cc}/u.test(label) ? label : null;
  },
}));
vi.mock("../claudeCodeLoginsViewer", () => ({ watchClaudeCodeLoginsViewer: () => {} }));

const CONTROLLER_URL = "https://controller.example.test";
const PROJECT_ID = "11111111-2222-4333-8444-555555555555";
const RUNTIME_ID = "99999999-8888-4777-8666-555555555555";
const CLAUDE = "/opt/homebrew/bin/claude";
const NATIVE_CLAUDE = "/home/sam/.local/bin/claude";
const NOT_MADE =
  "Error invoking remote method 'instafy:desktopExtensionInvoke': DesktopExtensionChangeNotMadeError: Instafy is still working on this computer, so that change was not made.";

// The person's first login, set up here in Claude Code's usual folder.
const LOGIN = "6f1c2a43-7b7e-4c51-9a0e-2d4b1f6a8c01";
const WORK = "0b8e5d27-91a4-4f6c-b3d2-5e7a9c1f4e02";
const ELSEWHERE = "3c9d1e58-2a7b-4f60-8c1d-9e2f3a4b5c03";
const WORK_FOLDER = "/Users/sam/.claude-work";
const FIRST = { id: LOGIN, label: "Claude Code", createdAt: "2026-11-01T09:00:00Z" };

type DesktopLogin = { id: string; folder: string | null; problem?: string };

type DesktopStatus = {
  supported: boolean;
  found: boolean;
  consented: boolean;
  path?: string;
  problem?: string;
  candidatePath?: string;
  candidateProblem?: string;
  shellSetting?: string;
  logins?: DesktopLogin[];
};

const SIGNED_IN: ControllerRuntimeClaudeCodeLogin = {
  ready: true,
  reason: null,
  resetsAt: null,
  planSignIn: true,
  signedIn: true,
};

/** This computer's runtime: the program ready, and the first login ready and signed in. */
const READY: ControllerRuntimeClaudeCode = {
  ready: true,
  reason: null,
  cli: "2.1.320",
  verified: true,
  logins: { [LOGIN]: SIGNED_IN },
};

/** The capability with the first login's entry changed. */
function withLogin(overrides: Partial<ControllerRuntimeClaudeCodeLogin>): ControllerRuntimeClaudeCode {
  return { ...READY, logins: { [LOGIN]: { ...SIGNED_IN, ...overrides } } };
}

/** Desktop on, with the first login in the usual folder. */
const ON: DesktopStatus = { supported: true, found: true, consented: true, path: CLAUDE, logins: [{ id: LOGIN, folder: null }] };

let desktopStatus: DesktopStatus;
let desktopRuntime: { running: boolean; projectId?: string; runtimeId?: string };
let invokeDesktopExtension: ReturnType<typeof vi.fn>;
let fetchRuntimeStatus: ReturnType<typeof vi.fn>;
/** The person's logins as the controller lists them, oldest first. */
let personLogins: Array<{ id: string; label: string; createdAt: string }>;

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
    // jsdom has no CSS.escape, which the folder choice's list box uses.
    vi.stubGlobal("CSS", { escape: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&") });
    forgetClaudeCodeDesktopRefusalForTests();
    setClaudeCodeLoginsLoaderForTests(null);
    window.localStorage.clear();
    personLogins = [FIRST];
    loginsClient.listClaudeCodeLogins.mockReset().mockImplementation(async () => ({ success: true, logins: [...personLogins] }));
    loginsClient.createClaudeCodeLogin.mockReset().mockImplementation(async (label: string) => {
      const login = { id: personLogins.length === 0 ? LOGIN : WORK, label, createdAt: "2026-11-22T10:00:00Z" };
      personLogins = [...personLogins, login];
      return { success: true, login };
    });
    loginsClient.renameClaudeCodeLogin.mockReset().mockImplementation(async (id: string, label: string) => {
      personLogins = personLogins.map((login) => (login.id === id ? { ...login, label } : login));
      return { success: true, login: personLogins.find((login) => login.id === id) };
    });
    loginsClient.deleteClaudeCodeLogin.mockReset().mockImplementation(async (id: string) => {
      personLogins = personLogins.filter((login) => login.id !== id);
      return { success: true };
    });
    desktopStatus = ON;
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  async function type(testId: string, value: string) {
    const input = container.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
    expect(input, testId).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function choose(testId: string, label: string) {
    await press(testId);
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent === label);
    expect(option, label).toBeDefined();
    await act(async () => option?.click());
  }

  const desktopCalls = (method: string) =>
    invokeDesktopExtension.mock.calls.map(([request]) => request).filter((request) => request.method === method);
  const login = (id: string, part?: string) => text(`credentials-claude-code-login-${id}${part ? `-${part}` : ""}`);

  it("shows only in Desktop, where it is supported, for a person the lane covers", async () => {
    delete (window as { instafyDesktop?: unknown }).instafyDesktop;
    await render();
    expect(container.innerHTML).toBe("");
    expect(fetchRuntimeStatus).not.toHaveBeenCalled();

    Object.assign(window, { instafyDesktop: { invokeDesktopExtension, desktopRuntimeStatus: async () => desktopRuntime } });
    desktopStatus = { supported: false, found: false, consented: false };
    await render();
    expect(container.innerHTML).toBe("");

    desktopStatus = ON;
    fetchRuntimeStatus.mockResolvedValue(statusAnswer(READY, { lane: false }));
    await render();
    expect(container.innerHTML).toBe("");
    // Nobody the lane doesn't cover has logins to list.
    expect(loginsClient.listClaudeCodeLogins).not.toHaveBeenCalled();

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
    fetchRuntimeStatus.mockResolvedValue(statusAnswer(withLogin({ planSignIn: false })));
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
    personLogins = [];
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
      "Off. Choose Find or Locate… to pick the claude program, then Use Claude Code on this computer.",
    );
    expect(button("credentials-claude-code-enable")?.disabled).toBe(true);

    await press("credentials-claude-code-detect");
    expect(invokeDesktopExtension).toHaveBeenCalledWith(
      expect.objectContaining({ extensionId: "claude-code", method: "detect", controllerUrl: CONTROLLER_URL }),
    );
    expect(text("credentials-claude-code-path")).toBe(`Found at ${CLAUDE}`);
    expect(text("credentials-claude-code-status")).toBe(
      "Off. Choose Use Claude Code on this computer to turn it on.",
    );
    expect(button("credentials-claude-code-enable")?.textContent).toBe("Use Claude Code on this computer");
    expect(button("credentials-claude-code-enable")?.disabled).toBe(false);

    invokeDesktopExtension.mockImplementation(async (options: { method: string; payload?: { loginId?: string } }) => {
      if (options.method === "status") return desktopStatus;
      if (options.method === "enable") {
        desktopStatus = { ...ON, logins: [{ id: options.payload?.loginId ?? "", folder: null }] };
        return desktopStatus;
      }
      throw new Error("unexpected");
    });
    await press("credentials-claude-code-enable");
    // docs/Local-Engine-Turns.md 11.19: a login named "Claude Code" first,
    // then Desktop's dialog for that login, by its id and name only.
    expect(loginsClient.createClaudeCodeLogin).toHaveBeenCalledWith("Claude Code");
    expect(desktopCalls("enable")).toEqual([
      expect.objectContaining({ extensionId: "claude-code", payload: { loginId: LOGIN, label: "Claude Code" } }),
    ]);
    expect(loginsClient.deleteClaudeCodeLogin).not.toHaveBeenCalled();
    expect(text("credentials-claude-code-status")).toBe("Ready on this computer.");
    expect(button("credentials-claude-code-disable")?.textContent).toBe("Turn off");
    expect(login(LOGIN, "label")).toBe("Claude Code");
    expect(login(LOGIN, "folder")).toBe("Claude Code's usual folder");
    expect(login(LOGIN, "status")).toBe("Ready.");
  });

  it("shows the one-time note once it is on, until it is read", async () => {
    // This computer's runtime found no Claude plan sign-in.
    fetchRuntimeStatus.mockResolvedValue(statusAnswer(withLogin({ planSignIn: false })));
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
    const on = ON;
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
    expect(text("credentials-claude-code-candidate-status")).toBe("Choose Use Claude Code on this computer to use it instead.");
    expect(button("credentials-claude-code-disable")?.textContent).toBe("Turn off");
    expect(button("credentials-claude-code-enable")?.textContent).toBe("Use Claude Code on this computer");

    // Desktop's own consent dialog confirms it, with no login: a confirm never adds one.
    await press("credentials-claude-code-enable");
    expect(invokeDesktopExtension).toHaveBeenCalledWith(expect.objectContaining({ method: "enable" }));
    expect(desktopCalls("enable")[0]).not.toHaveProperty("payload");
    expect(loginsClient.createClaudeCodeLogin).not.toHaveBeenCalled();
    expect(text("credentials-claude-code-path")).toBe(`Found at ${NATIVE_CLAUDE}`);
    expect(text("credentials-claude-code-candidate")).toBeNull();
    expect(button("credentials-claude-code-enable")).toBeNull();
  });

  // D26: a recorded NODE_EXTRA_CA_CERTS whose file went away after consent
  // makes every turn refuse. Once the person fixes their login shell, Find
  // reads new settings for the copy in use, and only Use Claude Code on this
  // computer, through Desktop's consent dialog, puts them in use (4.1). The
  // answers are Desktop's own (packages/desktop-app/test/claude-code-desktop.test.mjs).
  it("offers new login-shell settings Find read for the copy in use, once the recorded ones no longer work", async () => {
    const on = ON;
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
      "Find read new settings from your login shell that Instafy Desktop can use with this copy. Choose Use Claude Code on this computer to use them.",
    );
    expect(button("credentials-claude-code-disable")?.textContent).toBe("Turn off");
    expect(button("credentials-claude-code-enable")?.textContent).toBe("Use Claude Code on this computer");
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
    const on = ON;
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
      "Find didn't turn up any other copy, so this one stays in use.",
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
    personLogins = [];
    await render();
    await press("credentials-claude-code-enable");
    expect(text("credentials-claude-code-error")).toBe(
      "Instafy is still working on this computer, so that change was not made.",
    );
    // The login made for it was set up nowhere: it is deleted again.
    expect(loginsClient.createClaudeCodeLogin).toHaveBeenCalledWith("Claude Code");
    expect(loginsClient.deleteClaudeCodeLogin).toHaveBeenCalledWith(LOGIN);
  });

  // Desktop puts a refused change back after the person chose Keep working. A
  // status read that began before that (a focus while Desktop asked) must not
  // show the change beside the words that say it wasn't made.
  it("reads the status again after a refused change, so an older read never shows it as made", async () => {
    const off = { supported: true, found: true, consented: false, path: CLAUDE };
    desktopStatus = off;
    personLogins = [];
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
        desktopStatus = { ...off, consented: true, logins: [{ id: LOGIN, folder: null }] };
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
      "Off. Choose Use Claude Code on this computer to turn it on.",
    );
    expect(button("credentials-claude-code-disable")).toBeNull();
    expect(button("credentials-claude-code-enable")?.textContent).toBe("Use Claude Code on this computer");
  });

  // docs/Local-Engine-Turns.md 11.19, docs/Settings-UI.md (Your AI): each
  // login is a Claude Code folder the person signed in to themselves.
  describe("the person's Claude Code logins", () => {
    const WORK_LOGIN = { id: WORK, label: "Work", createdAt: "2026-11-02T09:00:00Z" };
    // Added on another computer, not set up on this one.
    const LAPTOP_LOGIN = { id: ELSEWHERE, label: "Laptop", createdAt: "2026-11-03T09:00:00Z" };
    const BOTH_HERE: DesktopStatus = { ...ON, logins: [{ id: LOGIN, folder: null }, { id: WORK, folder: WORK_FOLDER }] };

    /** Desktop answering the login methods as its module does, each with the status after it. */
    function desktopSetsUp({ cancel = false }: { cancel?: boolean } = {}) {
      invokeDesktopExtension.mockImplementation(
        async (options: { method: string; payload?: { loginId?: string; folder?: string } }) => {
          const loginId = options.payload?.loginId ?? "";
          switch (options.method) {
            case "status":
              return desktopStatus;
            case "enable":
              if (!cancel) {
                desktopStatus = { ...ON, logins: [{ id: loginId, folder: null }] };
              }
              return desktopStatus;
            case "addLogin":
              if (!cancel) {
                const folder = options.payload?.folder === "choose" ? WORK_FOLDER : null;
                desktopStatus = { ...desktopStatus, logins: [...(desktopStatus.logins ?? []), { id: loginId, folder }] };
              }
              return desktopStatus;
            case "removeLogin": {
              const logins = (desktopStatus.logins ?? []).filter((entry) => entry.id !== loginId);
              desktopStatus = logins.length > 0 ? { ...desktopStatus, logins } : { ...desktopStatus, consented: false, logins };
              return desktopStatus;
            }
            default:
              throw new Error(`unexpected ${options.method}`);
          }
        },
      );
    }

    it("lists each login with its folder on this computer and what this computer says of it", async () => {
      const resetsAt = new Date(Date.now() + 2 * 60 * 60_000);
      personLogins = [FIRST, WORK_LOGIN, LAPTOP_LOGIN];
      desktopStatus = BOTH_HERE;
      fetchRuntimeStatus.mockResolvedValue(
        statusAnswer({
          ...READY,
          logins: {
            [LOGIN]: { ...SIGNED_IN, signedIn: false },
            [WORK]: { ...SIGNED_IN, ready: false, reason: "plan_limit", resetsAt: resetsAt.toISOString() },
          },
        }),
      );
      await render();
      expect(text("credentials-claude-code-logins")).toContain("Logins");
      expect(login(LOGIN, "label")).toBe("Claude Code");
      expect(login(LOGIN, "folder")).toBe("Claude Code's usual folder");
      // A sign-out never makes a login not ready, so the row says it first.
      expect(login(LOGIN, "status")).toBe("Not signed in yet. In a terminal, run claude and sign in with /login.");
      expect(login(WORK, "label")).toBe("Work");
      expect(login(WORK, "folder")).toBe(WORK_FOLDER);
      expect(login(WORK, "status")).toBe(
        `Reached its Claude plan's limit. Ready again at ${formatUsageLimitResetTime(resetsAt.getTime())}.`,
      );
      // A login added on another computer has no folder here.
      expect(login(ELSEWHERE, "folder")).toBeNull();
      expect(login(ELSEWHERE, "status")).toBe("Not set up on this computer");
      expect(button(`credentials-claude-code-login-${ELSEWHERE}-set-up`)?.textContent).toBe("Set up on this computer");
      expect(button(`credentials-claude-code-login-${ELSEWHERE}-remove`)).toBeNull();
      expect(button(`credentials-claude-code-login-${LOGIN}-set-up`)).toBeNull();
      for (const id of [LOGIN, WORK]) {
        expect(button(`credentials-claude-code-login-${id}-rename`)?.textContent).toBe("Rename");
        expect(button(`credentials-claude-code-login-${id}-remove`)?.textContent).toBe("Remove from this computer");
        expect(button(`credentials-claude-code-login-${id}-delete`)?.textContent).toBe("Delete");
      }
      expect(button("credentials-claude-code-login-add")?.textContent).toBe("Add a login");
      // Not every login here reports a Claude plan sign-in: the plan isn't named.
      fetchRuntimeStatus.mockResolvedValue(
        statusAnswer({ ...READY, logins: { [LOGIN]: SIGNED_IN, [WORK]: { ...SIGNED_IN, planSignIn: false } } }),
      );
      await render();
      expect(text("credentials-claude-code-sign-in")).toBe(
        "Uses your own Claude Code sign-in, under Anthropic's current terms.",
      );
      expect(login(LOGIN, "status")).toBe("Ready.");
      expect(bannedWordIn(text("credentials-claude-code-row") ?? "")).toBeNull();
    });

    it("says when a login's folder is refused, not checked yet, signed out, or the program can't take turns", async () => {
      personLogins = [FIRST, WORK_LOGIN];
      desktopStatus = { ...ON, logins: [{ id: LOGIN, folder: null }, { id: WORK, folder: WORK_FOLDER, problem: "writable_by_others" }] };
      fetchRuntimeStatus.mockResolvedValue(statusAnswer({ ...READY, logins: { [WORK]: { ...SIGNED_IN, ready: false, reason: "binary_unsafe" } } }));
      await render();
      expect(login(WORK, "status")).toBe(CLAUDE_CODE_COPY.yourAi.logins.folderUnusable);
      // Set up here, and this computer's runtime doesn't report it yet.
      expect(login(LOGIN, "status")).toBe("Not checked on this computer yet. It's checked again when this space starts.");

      // The runtime refuses the folder though Desktop didn't say.
      desktopStatus = BOTH_HERE;
      await render();
      expect(login(WORK, "status")).toBe(CLAUDE_CODE_COPY.yourAi.logins.folderUnusable);

      fetchRuntimeStatus.mockResolvedValue(
        statusAnswer({ ...READY, logins: { [LOGIN]: SIGNED_IN, [WORK]: { ...SIGNED_IN, signedIn: false } } }),
      );
      await render();
      expect(login(WORK, "status")).toBe(
        "Not signed in yet. In a terminal, run claude with CLAUDE_CONFIG_DIR set to this folder and sign in with /login.",
      );

      // The program can't take turns: the row says why, once, for every login.
      const notReady = { ...SIGNED_IN, ready: false, reason: "unsupported_version" as const };
      fetchRuntimeStatus.mockResolvedValue(
        statusAnswer({ ...READY, ready: false, reason: "unsupported_version", logins: { [LOGIN]: notReady, [WORK]: notReady } }),
      );
      await render();
      expect(text("credentials-claude-code-status")).toBe(
        "This version of Claude Code can't take turns from Instafy. Update Claude Code.",
      );
      expect(login(LOGIN, "status")).toBeNull();
      expect(login(WORK, "status")).toBeNull();
      expect(bannedWordIn(text("credentials-claude-code-row") ?? "")).toBeNull();
    });

    it("deletes the login it made for Use Claude Code on this computer when the person cancels Desktop's dialog", async () => {
      personLogins = [];
      desktopStatus = { supported: true, found: true, consented: false, path: CLAUDE };
      desktopSetsUp({ cancel: true });
      await render();
      expect(text("credentials-claude-code-logins")).toBeNull();
      await press("credentials-claude-code-enable");
      expect(loginsClient.createClaudeCodeLogin).toHaveBeenCalledWith("Claude Code");
      expect(desktopCalls("enable")).toEqual([
        expect.objectContaining({ payload: { loginId: LOGIN, label: "Claude Code" } }),
      ]);
      expect(loginsClient.deleteClaudeCodeLogin).toHaveBeenCalledWith(LOGIN);
      // Cancelling is no error.
      expect(text("credentials-claude-code-error")).toBeNull();
      expect(text("credentials-claude-code-status")).toBe("Off. Choose Use Claude Code on this computer to turn it on.");
      expect(claudeCodeLoginsSnapshot()).toEqual([]);
    });

    it("sets up a login from another computer here, while nothing is set up here, without making another", async () => {
      personLogins = [LAPTOP_LOGIN];
      desktopStatus = { supported: true, found: true, consented: false, path: CLAUDE };
      desktopSetsUp();
      await render();
      expect(login(ELSEWHERE, "status")).toBe("Not set up on this computer");
      // The first login here takes the folder Desktop reads from the login shell, or the usual one.
      await press(`credentials-claude-code-login-${ELSEWHERE}-set-up`);
      expect(desktopCalls("enable")).toEqual([
        expect.objectContaining({ payload: { loginId: ELSEWHERE, label: "Laptop" } }),
      ]);
      expect(desktopCalls("addLogin")).toEqual([]);
      expect(loginsClient.createClaudeCodeLogin).not.toHaveBeenCalled();
      expect(login(ELSEWHERE, "folder")).toBe("Claude Code's usual folder");
      expect(login(ELSEWHERE, "status")).toBe("Not checked on this computer yet. It's checked again when this space starts.");
      expect(button("credentials-claude-code-disable")?.textContent).toBe("Turn off");
    });

    it("asks for the new first login's name when the person has logins elsewhere already", async () => {
      personLogins = [LAPTOP_LOGIN];
      desktopStatus = { supported: true, found: true, consented: false, path: CLAUDE };
      desktopSetsUp();
      await render();
      await press("credentials-claude-code-enable");
      expect(loginsClient.createClaudeCodeLogin).not.toHaveBeenCalled();
      expect(container.querySelector<HTMLInputElement>('[data-testid="credentials-claude-code-enable-name"]')?.value).toBe(
        "Claude Code",
      );
      await type("credentials-claude-code-enable-name", "  Desk ");
      await press("credentials-claude-code-enable-form-submit");
      expect(loginsClient.createClaudeCodeLogin).toHaveBeenCalledWith("Desk");
      expect(desktopCalls("enable")).toEqual([expect.objectContaining({ payload: { loginId: WORK, label: "Desk" } })]);
      expect(text("credentials-claude-code-enable-form")).toBeNull();
      expect(login(WORK, "label")).toBe("Desk");
    });

    it("adds a login with its name and folder through Desktop's dialog, and deletes it again when the person cancels", async () => {
      desktopSetsUp({ cancel: true });
      await render();
      await press("credentials-claude-code-login-add");
      // The first login uses the usual folder here, which Desktop refuses for another.
      expect(text("credentials-claude-code-login-add-folder")).toContain("Choose a folder…");
      await type("credentials-claude-code-login-add-name", "Work");
      await press("credentials-claude-code-login-add-form-submit");
      expect(loginsClient.createClaudeCodeLogin).toHaveBeenCalledWith("Work");
      expect(desktopCalls("addLogin")).toEqual([
        expect.objectContaining({ extensionId: "claude-code", payload: { loginId: WORK, label: "Work", folder: "choose" } }),
      ]);
      // Studio never passes a path.
      expect(JSON.stringify(desktopCalls("addLogin").map((request) => request.payload))).not.toContain("/");
      expect(loginsClient.deleteClaudeCodeLogin).toHaveBeenCalledWith(WORK);
      expect(login(WORK)).toBeNull();

      desktopSetsUp();
      fetchRuntimeStatus.mockResolvedValue(statusAnswer({ ...READY, logins: { [LOGIN]: SIGNED_IN, [WORK]: SIGNED_IN } }));
      await press("credentials-claude-code-login-add");
      await type("credentials-claude-code-login-add-name", "Work");
      await choose("credentials-claude-code-login-add-folder", "Choose a folder…");
      await press("credentials-claude-code-login-add-form-submit");
      expect(desktopCalls("addLogin")).toHaveLength(2);
      expect(loginsClient.deleteClaudeCodeLogin).toHaveBeenCalledTimes(1);
      expect(text("credentials-claude-code-login-add-form")).toBeNull();
      expect(login(WORK, "folder")).toBe(WORK_FOLDER);
      expect(login(WORK, "status")).toBe("Ready.");
    });

    it("deletes a new login Desktop refused to set up, in Desktop's own words", async () => {
      invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
        if (options.method === "status") return desktopStatus;
        throw new Error(
          "Error invoking remote method 'instafy:desktopExtensionInvoke': Error: Another of your Claude Code logins on this computer already uses Claude Code's usual folder.",
        );
      });
      await render();
      await press("credentials-claude-code-login-add");
      await type("credentials-claude-code-login-add-name", "Work");
      await press("credentials-claude-code-login-add-form-submit");
      expect(text("credentials-claude-code-error")).toBe(
        "Another of your Claude Code logins on this computer already uses Claude Code's usual folder.",
      );
      expect(loginsClient.deleteClaudeCodeLogin).toHaveBeenCalledWith(WORK);
      // The form stays, for another folder.
      expect(text("credentials-claude-code-login-add-form")).not.toBeNull();
    });

    it("words the controller's refusals of a new login plainly, and keeps the form", async () => {
      desktopSetsUp();
      await render();
      await press("credentials-claude-code-login-add");
      await type("credentials-claude-code-login-add-name", "claude code");
      const refuse = (code: string | null, error = "409 Conflict") =>
        loginsClient.createClaudeCodeLogin.mockResolvedValueOnce({ success: false, error, code });
      const submit = () => press("credentials-claude-code-login-add-form-submit");

      refuse("claude_code_login_label_taken");
      await submit();
      expect(text("credentials-claude-code-error")).toBe("You already have a login with this name. Choose another.");
      refuse("claude_code_turn_not_allowed", "403 Forbidden");
      await submit();
      expect(text("credentials-claude-code-error")).toBe("Claude Code turns aren't on for your account.");
      refuse("claude_code_login_limit");
      await submit();
      expect(text("credentials-claude-code-error")).toBe("You have 10 Claude Code logins, the most you can have.");
      refuse(null, "Unable to add a Claude Code login: upstream request failed");
      await submit();
      expect(text("credentials-claude-code-error")).toBe("Instafy couldn't change your Claude Code logins. Try again.");
      expect(desktopCalls("addLogin")).toEqual([]);
      expect(text("credentials-claude-code-login-add-form")).not.toBeNull();

      // A name that is not one never reaches the controller.
      await type("credentials-claude-code-login-add-name", "Work\u0007");
      await submit();
      expect(text("credentials-claude-code-error")).toBe("A login's name is 1 to 60 characters on one line, and can't hold double quotes or invisible characters.");
      expect(loginsClient.createClaudeCodeLogin).toHaveBeenCalledTimes(4);
      expect(bannedWordIn(text("credentials-claude-code-row") ?? "")).toBeNull();
    });

    it("sets up here a login added on another computer, in the folder the person picks, and never deletes it", async () => {
      personLogins = [FIRST, LAPTOP_LOGIN];
      desktopSetsUp({ cancel: true });
      await render();
      await press(`credentials-claude-code-login-${ELSEWHERE}-set-up`);
      await choose(`credentials-claude-code-login-${ELSEWHERE}-folder`, "Choose a folder…");
      await press(`credentials-claude-code-login-${ELSEWHERE}-set-up-form-submit`);
      expect(desktopCalls("addLogin")).toEqual([
        expect.objectContaining({ payload: { loginId: ELSEWHERE, label: "Laptop", folder: "choose" } }),
      ]);
      expect(desktopCalls("enable")).toEqual([]);
      expect(loginsClient.createClaudeCodeLogin).not.toHaveBeenCalled();
      // Cancelled: the login stays the person's, for the computers that have it.
      expect(loginsClient.deleteClaudeCodeLogin).not.toHaveBeenCalled();
      expect(login(ELSEWHERE, "status")).toBe("Not set up on this computer");

      // With no login in the usual folder here, that folder is the one offered first.
      desktopStatus = { ...ON, logins: [{ id: LOGIN, folder: "/Users/sam/.claude-personal" }] };
      desktopSetsUp();
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      await press(`credentials-claude-code-login-${ELSEWHERE}-set-up`);
      expect(text(`credentials-claude-code-login-${ELSEWHERE}-folder`)).toContain("Claude Code's usual folder");
      await press(`credentials-claude-code-login-${ELSEWHERE}-set-up-form-submit`);
      expect(desktopCalls("addLogin")[1]).toEqual(
        expect.objectContaining({ payload: { loginId: ELSEWHERE, label: "Laptop", folder: "usual" } }),
      );
      expect(login(ELSEWHERE, "folder")).toBe("Claude Code's usual folder");
    });

    it("renames a login, and says why the controller refused a name", async () => {
      personLogins = [FIRST, WORK_LOGIN];
      loginsClient.renameClaudeCodeLogin.mockResolvedValueOnce({
        success: false,
        error: "409 Conflict",
        code: "claude_code_login_label_taken",
      });
      await render();
      await press(`credentials-claude-code-login-${LOGIN}-rename`);
      expect(
        container.querySelector<HTMLInputElement>(`[data-testid="credentials-claude-code-login-${LOGIN}-rename-name"]`)?.value,
      ).toBe("Claude Code");
      await type(`credentials-claude-code-login-${LOGIN}-rename-name`, "Work");
      await press(`credentials-claude-code-login-${LOGIN}-rename-form-submit`);
      expect(loginsClient.renameClaudeCodeLogin).toHaveBeenCalledWith(LOGIN, "Work");
      expect(text("credentials-claude-code-error")).toBe("You already have a login with this name. Choose another.");

      await type(`credentials-claude-code-login-${LOGIN}-rename-name`, "  Personal ");
      await press(`credentials-claude-code-login-${LOGIN}-rename-form-submit`);
      expect(loginsClient.renameClaudeCodeLogin).toHaveBeenLastCalledWith(LOGIN, "Personal");
      expect(text("credentials-claude-code-error")).toBeNull();
      expect(login(LOGIN, "label")).toBe("Personal");
      // Everything else that names the login reads its new name.
      expect(claudeCodeLoginsSnapshot()?.[0]?.label).toBe("Personal");
      // A name is the controller's alone: nothing changes on this computer.
      expect(invokeDesktopExtension.mock.calls.every(([request]) => request.method === "status")).toBe(true);
    });

    it("removes a login from this computer only, and the last one turns Claude Code off here", async () => {
      personLogins = [FIRST, WORK_LOGIN];
      desktopStatus = BOTH_HERE;
      desktopSetsUp();
      await render();
      await press(`credentials-claude-code-login-${WORK}-remove`);
      expect(desktopCalls("removeLogin")).toEqual([expect.objectContaining({ payload: { loginId: WORK } })]);
      expect(loginsClient.deleteClaudeCodeLogin).not.toHaveBeenCalled();
      expect(login(WORK, "status")).toBe("Not set up on this computer");
      expect(login(WORK, "folder")).toBeNull();

      await press(`credentials-claude-code-login-${LOGIN}-remove`);
      expect(text("credentials-claude-code-status")).toBe("Off. Choose Use Claude Code on this computer to turn it on.");
      expect(login(LOGIN, "status")).toBe("Not set up on this computer");
    });

    it("deletes a login everywhere only after saying what happens to its agents", async () => {
      personLogins = [FIRST, WORK_LOGIN, LAPTOP_LOGIN];
      desktopStatus = BOTH_HERE;
      desktopSetsUp();
      const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValue(true);
      await render();
      await press(`credentials-claude-code-login-${WORK}-delete`);
      expect(confirm).toHaveBeenCalledWith('Delete "Work"? Agents that use it switch to your first login.');
      expect(loginsClient.deleteClaudeCodeLogin).not.toHaveBeenCalled();
      expect(desktopCalls("removeLogin")).toEqual([]);

      // Set up here: removed from this computer first, then deleted.
      await press(`credentials-claude-code-login-${WORK}-delete`);
      expect(desktopCalls("removeLogin")).toEqual([expect.objectContaining({ payload: { loginId: WORK } })]);
      expect(loginsClient.deleteClaudeCodeLogin).toHaveBeenCalledWith(WORK);
      expect(login(WORK)).toBeNull();

      // Not set up here: only deleted.
      await press(`credentials-claude-code-login-${ELSEWHERE}-delete`);
      expect(loginsClient.deleteClaudeCodeLogin).toHaveBeenLastCalledWith(ELSEWHERE);
      expect(desktopCalls("removeLogin")).toHaveLength(1);
      expect(login(ELSEWHERE)).toBeNull();
    });

    it("deletes nothing when Desktop keeps the login because a turn is running", async () => {
      personLogins = [FIRST, WORK_LOGIN];
      desktopStatus = BOTH_HERE;
      invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
        if (options.method === "status") return desktopStatus;
        throw new Error(NOT_MADE);
      });
      vi.spyOn(window, "confirm").mockReturnValue(true);
      await render();
      await press(`credentials-claude-code-login-${WORK}-delete`);
      expect(text("credentials-claude-code-error")).toBe(
        "Instafy is still working on this computer, so that change was not made.",
      );
      expect(loginsClient.deleteClaudeCodeLogin).not.toHaveBeenCalled();
      expect(login(WORK, "folder")).toBe(WORK_FOLDER);
    });

    it("shows a login this computer still has that the person deleted, to remove from here", async () => {
      personLogins = [FIRST];
      desktopStatus = BOTH_HERE;
      await render();
      expect(login(WORK, "label")).toBe("A login you deleted");
      expect(login(WORK, "folder")).toBe(WORK_FOLDER);
      expect(button(`credentials-claude-code-login-${WORK}-remove`)).not.toBeNull();
      expect(button(`credentials-claude-code-login-${WORK}-rename`)).toBeNull();
      expect(button(`credentials-claude-code-login-${WORK}-delete`)).toBeNull();
    });

    it("says so in place of Add a login once the person has ten", async () => {
      personLogins = [
        FIRST,
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `aaaaaaaa-bbbb-4ccc-8ddd-${String(index).padStart(12, "0")}`,
          label: `Login ${index + 2}`,
          createdAt: "2026-11-05T09:00:00Z",
        })),
      ];
      await render();
      expect(button("credentials-claude-code-login-add")).toBeNull();
      expect(text("credentials-claude-code-login-limit")).toBe("You have 10 Claude Code logins, the most you can have.");
    });

    it("says it couldn't load the logins, and keeps the row's own actions", async () => {
      loginsClient.listClaudeCodeLogins.mockResolvedValue({ success: false, error: "503", code: null });
      await render();
      expect(text("credentials-claude-code-logins-error")).toBe("Instafy couldn't load your Claude Code logins. Try again.");
      expect(button("credentials-claude-code-login-add")).toBeNull();
      expect(button("credentials-claude-code-disable")?.textContent).toBe("Turn off");
      // The list comes back with the next read.
      loginsClient.listClaudeCodeLogins.mockImplementation(async () => ({ success: true, logins: [...personLogins] }));
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(text("credentials-claude-code-logins-error")).toBeNull();
      expect(login(LOGIN, "status")).toBe("Ready.");
    });
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
      personLogins = [];
      desktopStatus = { supported: true, found: true, consented: false, path: CLAUDE };
      // The running runtime was started with no grant: listed, reporting nothing.
      fetchRuntimeStatus.mockResolvedValue(listing(RUNTIME_ID, null));
      invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
        if (options.method === "status") return desktopStatus;
        if (options.method === "enable") {
          // Desktop records the consent, and has replaced the runtime when it answers.
          desktopStatus = { ...desktopStatus, consented: true, logins: [{ id: LOGIN, folder: null }] };
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
      expect(text(STATUS)).toBe("Off. Choose Use Claude Code on this computer to turn it on.");

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
      expect(text(STATUS)).toBe("Off. Choose Use Claude Code on this computer to turn it on.");

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
          desktopStatus = { ...desktopStatus, consented: true, logins: [{ id: LOGIN, folder: null }] };
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
          desktopStatus = { ...desktopStatus, consented: true, logins: [{ id: LOGIN, folder: null }] };
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
          desktopStatus = { ...desktopStatus, consented: true, logins: [{ id: LOGIN, folder: null }] };
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
          desktopStatus = { ...desktopStatus, consented: false, logins: [] };
          return desktopStatus;
        }
        throw new Error("unexpected");
      });
      await press("credentials-claude-code-disable");
      expect(text(STATUS)).toBe("Off. Choose Use Claude Code on this computer to turn it on.");
      const afterOff = fetchRuntimeStatus.mock.calls.length;
      await wait(60_000);
      expect(fetchRuntimeStatus.mock.calls.length).toBe(afterOff);

      // Unmounted while checking: no read after it.
      desktopStatus = { ...desktopStatus, consented: false, logins: [] };
      personLogins = [];
      invokeDesktopExtension.mockImplementation(async (options: { method: string }) => {
        if (options.method === "status") return desktopStatus;
        if (options.method === "enable") {
          desktopStatus = { ...desktopStatus, consented: true, logins: [{ id: LOGIN, folder: null }] };
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
