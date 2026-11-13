import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_DESKTOP_EXTENSION_ID,
  ClaudeCodeDesktopActionError,
  claudeCodeDesktopHostAvailable,
  forgetClaudeCodeDesktopRefusalForTests,
  invokeClaudeCodeDesktopAction,
  parseClaudeCodeDesktopStatus,
  readClaudeCodeDesktopStatus,
  readThisComputerRuntimeId,
} from "../claudeCodeDesktop";

const CONTROLLER_URL = "https://controller.example.test";

function stubDesktop(bridge: Partial<NonNullable<Window["instafyDesktop"]>> | undefined) {
  vi.stubGlobal("window", bridge ? { instafyDesktop: bridge } : {});
}

afterEach(() => {
  vi.unstubAllGlobals();
  forgetClaudeCodeDesktopRefusalForTests();
});

describe("parseClaudeCodeDesktopStatus", () => {
  it("keeps only the exact status shape", () => {
    expect(
      parseClaudeCodeDesktopStatus({ supported: true, found: true, path: "/opt/homebrew/bin/claude", consented: false }),
    ).toEqual({ supported: true, found: true, path: "/opt/homebrew/bin/claude", consented: false });
    expect(parseClaudeCodeDesktopStatus({ supported: true, found: false, consented: false })).toEqual({
      supported: true,
      found: false,
      path: null,
      consented: false,
    });
    expect(parseClaudeCodeDesktopStatus({ supported: "true", found: true, consented: true })).toBeNull();
    expect(parseClaudeCodeDesktopStatus({ supported: true, found: true })).toBeNull();
    expect(parseClaudeCodeDesktopStatus([])).toBeNull();
    expect(parseClaudeCodeDesktopStatus(null)).toBeNull();
    expect(
      parseClaudeCodeDesktopStatus({ supported: true, found: true, consented: true, path: 42 }),
    ).toMatchObject({ path: null });
  });

  // While it is on, Desktop answers the path in use, and what Find or Locate
  // turned up beside it (docs/Local-Engine-Turns.md 4.1).
  it("reads what Find or Locate turned up beside the path in use, and the login-shell setting Desktop names", () => {
    expect(
      parseClaudeCodeDesktopStatus({
        supported: true,
        found: true,
        path: "/opt/homebrew/bin/claude",
        consented: true,
        candidatePath: "/Users/sam/.local/bin/claude",
        candidateProblem: "shell_setting_unusable",
        shellSetting: "NODE_EXTRA_CA_CERTS",
      }),
    ).toEqual({
      supported: true,
      found: true,
      path: "/opt/homebrew/bin/claude",
      consented: true,
      candidatePath: "/Users/sam/.local/bin/claude",
      candidateProblem: "shell_setting_unusable",
      shellSetting: "NODE_EXTRA_CA_CERTS",
    });
    expect(
      parseClaudeCodeDesktopStatus({
        supported: true,
        found: false,
        path: "/opt/homebrew/bin/claude",
        consented: false,
        problem: "shell_setting_unusable",
        shellSetting: "CLAUDE_CONFIG_DIR",
      }),
    ).toMatchObject({ problem: "shell_setting_unusable", shellSetting: "CLAUDE_CONFIG_DIR" });
    expect(
      parseClaudeCodeDesktopStatus({ supported: true, found: true, consented: true, candidateProblem: "not_found" }),
    ).toMatchObject({ candidateProblem: "not_found" });
    // The path in use beside itself: new login-shell values Find read for it (D26).
    expect(
      parseClaudeCodeDesktopStatus({
        supported: true,
        found: false,
        path: "/opt/homebrew/bin/claude",
        consented: true,
        problem: "shell_setting_unusable",
        shellSetting: "NODE_EXTRA_CA_CERTS",
        candidatePath: "/opt/homebrew/bin/claude",
      }),
    ).toEqual({
      supported: true,
      found: false,
      path: "/opt/homebrew/bin/claude",
      consented: true,
      problem: "shell_setting_unusable",
      shellSetting: "NODE_EXTRA_CA_CERTS",
      candidatePath: "/opt/homebrew/bin/claude",
    });
  });

  it("leaves out a field it doesn't know the value of, and ignores fields it doesn't know", () => {
    const parsed = parseClaudeCodeDesktopStatus({
      supported: true,
      found: true,
      consented: true,
      path: "/opt/homebrew/bin/claude",
      candidatePath: "",
      candidateProblem: "made_up",
      problem: "made_up_too",
      shellSetting: "HTTPS_PROXY",
      somethingNew: { nested: true },
    });
    expect(parsed).toEqual({ supported: true, found: true, path: "/opt/homebrew/bin/claude", consented: true });
    expect(
      parseClaudeCodeDesktopStatus({
        supported: true,
        found: true,
        consented: true,
        candidatePath: `/${"x".repeat(5000)}`,
      }),
    ).not.toHaveProperty("candidatePath");
  });
});

describe("the Desktop module", () => {
  it("is asked nothing outside Desktop", async () => {
    stubDesktop(undefined);
    expect(claudeCodeDesktopHostAvailable()).toBe(false);
    await expect(readClaudeCodeDesktopStatus(CONTROLLER_URL)).resolves.toBeNull();
    await expect(readThisComputerRuntimeId("project-1")).resolves.toBeNull();
  });

  it("is asked for its status through Desktop's extension API", async () => {
    const invokeDesktopExtension = vi.fn(async () => ({ supported: true, found: true, consented: true }));
    stubDesktop({ invokeDesktopExtension });
    expect(claudeCodeDesktopHostAvailable()).toBe(true);
    await expect(readClaudeCodeDesktopStatus(CONTROLLER_URL)).resolves.toEqual({
      supported: true,
      found: true,
      path: null,
      consented: true,
    });
    // Desktop keys the consent by the controller Studio names and the session it reads itself.
    expect(invokeDesktopExtension).toHaveBeenCalledWith({
      extensionId: CLAUDE_CODE_DESKTOP_EXTENSION_ID,
      method: "status",
      controllerUrl: CONTROLLER_URL,
    });
    expect(CLAUDE_CODE_DESKTOP_EXTENSION_ID).toBe("claude-code");
    invokeDesktopExtension.mockClear();
    await readClaudeCodeDesktopStatus(null);
    expect(invokeDesktopExtension).toHaveBeenCalledWith({
      extensionId: CLAUDE_CODE_DESKTOP_EXTENSION_ID,
      method: "status",
    });
  });

  it("reads an answer of another shape as nothing to offer", async () => {
    stubDesktop({ invokeDesktopExtension: vi.fn(async () => "yes") });
    await expect(readClaudeCodeDesktopStatus(CONTROLLER_URL)).resolves.toBeNull();
  });

  it("asks a Desktop without the module once, and not again on this page", async () => {
    const invokeDesktopExtension = vi.fn(async () => {
      throw new Error("Unknown desktop extension");
    });
    stubDesktop({ invokeDesktopExtension });
    await expect(readClaudeCodeDesktopStatus(CONTROLLER_URL)).resolves.toBeNull();
    await expect(readClaudeCodeDesktopStatus(CONTROLLER_URL)).resolves.toBeNull();
    expect(invokeDesktopExtension).toHaveBeenCalledTimes(1);
  });

  // A refused action is the person's to read, never a sign that Desktop has
  // no module: only a refused `status` stops the status reads.
  it("keeps asking for the status after Desktop refuses an action", async () => {
    const invokeDesktopExtension = vi.fn(async (request: InstafyDesktopExtensionInvokeOptions) => {
      if (request.method === "detect") {
        throw new Error(
          "Error invoking remote method 'instafy:desktopExtensionInvoke': Error: Find the claude program on this computer first.",
        );
      }
      return { supported: true, found: false, consented: false };
    });
    stubDesktop({ invokeDesktopExtension });
    await expect(invokeClaudeCodeDesktopAction("detect", CONTROLLER_URL)).rejects.toEqual(
      new ClaudeCodeDesktopActionError("Find the claude program on this computer first."),
    );
    await expect(readClaudeCodeDesktopStatus(CONTROLLER_URL)).resolves.toMatchObject({ supported: true });
    await expect(readClaudeCodeDesktopStatus(CONTROLLER_URL)).resolves.toMatchObject({ supported: true });
    expect(invokeDesktopExtension.mock.calls.map(([request]) => request.method)).toEqual(["detect", "status", "status"]);
  });

  // Electron hands the renderer a rejection's `toString()`: "<name>: <message>".
  it("keeps only Desktop's own words of a refusal, whatever the error's name", async () => {
    for (const thrown of [
      "Error invoking remote method 'instafy:desktopExtensionInvoke': Error: Instafy is still working on this computer, so that change was not made.",
      "Error invoking remote method 'instafy:desktopExtensionInvoke': DesktopExtensionChangeNotMadeError: Instafy is still working on this computer, so that change was not made.",
      "Error invoking remote method 'instafy:desktopExtensionInvoke': TypeError: Instafy is still working on this computer, so that change was not made.",
    ]) {
      stubDesktop({
        invokeDesktopExtension: vi.fn(async () => {
          throw new Error(thrown);
        }),
      });
      await expect(invokeClaudeCodeDesktopAction("enable", CONTROLLER_URL)).rejects.toEqual(
        new ClaudeCodeDesktopActionError("Instafy is still working on this computer, so that change was not made."),
      );
    }
  });

  it("still sends an action after a refused status, and asks for the status again once one is answered", async () => {
    let statusRefused = true;
    const invokeDesktopExtension = vi.fn(async (request: InstafyDesktopExtensionInvokeOptions) => {
      if (request.method === "status" && statusRefused) {
        throw new Error("Unknown desktop extension");
      }
      return { supported: true, found: true, path: "/opt/homebrew/bin/claude", consented: false };
    });
    stubDesktop({ invokeDesktopExtension });
    await expect(readClaudeCodeDesktopStatus(CONTROLLER_URL)).resolves.toBeNull();
    statusRefused = false;
    // Not asked again on this page...
    await expect(readClaudeCodeDesktopStatus(CONTROLLER_URL)).resolves.toBeNull();
    expect(invokeDesktopExtension).toHaveBeenCalledTimes(1);
    // ...until an action shows that Desktop has the module.
    await expect(invokeClaudeCodeDesktopAction("detect", CONTROLLER_URL)).resolves.toMatchObject({ found: true });
    await expect(readClaudeCodeDesktopStatus(CONTROLLER_URL)).resolves.toMatchObject({ found: true });
    expect(invokeDesktopExtension.mock.calls.map(([request]) => request.method)).toEqual(["status", "detect", "status"]);
  });

  it("names this computer's runtime only for the space Desktop runs", async () => {
    const desktopRuntimeStatus = vi.fn(async () => ({
      running: true,
      projectId: "project-1",
      runtimeId: " runtime-1 ",
    }));
    stubDesktop({ desktopRuntimeStatus });
    await expect(readThisComputerRuntimeId("project-1")).resolves.toBe("runtime-1");
    await expect(readThisComputerRuntimeId("project-2")).resolves.toBeNull();
    desktopRuntimeStatus.mockResolvedValueOnce({ running: false, projectId: "project-1", runtimeId: "runtime-1" });
    await expect(readThisComputerRuntimeId("project-1")).resolves.toBeNull();
    desktopRuntimeStatus.mockRejectedValueOnce(new Error("gone"));
    await expect(readThisComputerRuntimeId("project-1")).resolves.toBeNull();
  });
});
