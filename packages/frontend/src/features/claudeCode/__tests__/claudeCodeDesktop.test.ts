import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_DESKTOP_EXTENSION_ID,
  claudeCodeDesktopHostAvailable,
  forgetClaudeCodeDesktopRefusalForTests,
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
