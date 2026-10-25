import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentSettings } from "../src/agents.js";
import { requestControllerApiJson } from "../src/api.js";
import { text } from "@clack/prompts";

vi.mock("../src/api.js", () => ({ requestControllerApiJson: vi.fn() }));
vi.mock("@clack/prompts", () => ({ text: vi.fn(), isCancel: (value: unknown) => typeof value === "symbol" }));

const settings = {
  maxAgentsPerPlan: 64,
  maxConcurrentAgents: 8,
  canManage: true,
  limits: {
    maxAgentsPerPlan: { min: 1, max: 256, default: 64 },
    maxConcurrentAgents: { min: 1, max: 64, default: 8 },
  },
};
const request = vi.mocked(requestControllerApiJson);
const prompt = vi.mocked(text);
const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CI", "false");
  vi.spyOn(console, "log").mockImplementation(() => {});
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  request.mockResolvedValue(settings);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [stream, descriptor] of [[process.stdin, stdinTTY], [process.stdout, stdoutTTY]] as const) {
    if (descriptor) Object.defineProperty(stream, "isTTY", descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  }
});

describe("interactive multi-agent settings", () => {
  it("uses controller defaults and bounds and sends only changed fields", async () => {
    prompt.mockResolvedValueOnce("64").mockResolvedValueOnce("12");
    await agentSettings({ project: "space-id", interactive: true });
    expect(prompt.mock.calls.map(([options]) => options.defaultValue)).toEqual(["64", "8"]);
    const validate = prompt.mock.calls[1][0].validate!;
    expect(validate("65")).toBe("Enter a whole number from 1 to 64.");
    expect(validate("1.5")).toContain("positive whole number");
    expect(validate("12")).toBeUndefined();
    expect(validate("")).toBeUndefined();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ method: "PATCH", jsonBody: { maxConcurrentAgents: 12 } }));
  });

  it("does not persist a partially entered edit when the second prompt is cancelled", async () => {
    prompt.mockResolvedValueOnce("100").mockResolvedValueOnce(Symbol("cancel"));
    await expect(agentSettings({ project: "space-id", interactive: true })).rejects.toThrow("No settings were changed");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "GET" }));
  });

  it("avoids writing unchanged settings", async () => {
    prompt.mockResolvedValueOnce("64").mockResolvedValueOnce("8");
    await agentSettings({ project: "space-id", interactive: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects conflicting automation flags before making a request", async () => {
    await expect(agentSettings({ project: "space-id", interactive: true, json: true })).rejects.toThrow("without --json or setting flags");
    await expect(agentSettings({ project: "space-id", interactive: true, maxConcurrentAgents: "12" })).rejects.toThrow("without --json or setting flags");
    expect(request).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
  });
});


describe("native helper settings", () => {
  const nativeSettings = {
    ...settings,
    maxNativeSubagents: 3,
    limits: { ...settings.limits, maxNativeSubagents: { min: 1, max: 64, default: 3 } },
  };

  it("patches only the native limit and displays its separate scope", async () => {
    request.mockResolvedValueOnce(nativeSettings).mockResolvedValueOnce({ ...nativeSettings, maxNativeSubagents: 10 });
    await agentSettings({ project: "space-id", maxNativeSubagents: "10" });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ method: "PATCH", jsonBody: { maxNativeSubagents: 10 } }));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("native helpers per parent (excluding the parent): 10"));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("tracked workers across this space: 8"));
  });

  it("edits the advertised native limit with controller-provided bounds", async () => {
    request.mockResolvedValue({ ...nativeSettings, limits: { ...nativeSettings.limits, maxNativeSubagents: { min: 1, max: 16, default: 3 } } });
    prompt.mockResolvedValueOnce("64").mockResolvedValueOnce("8").mockResolvedValueOnce("10");
    await agentSettings({ project: "space-id", interactive: true });
    expect(prompt.mock.calls.map(([options]) => options.defaultValue)).toEqual(["64", "8", "3"]);
    expect(prompt.mock.calls[2][0].validate!("17")).toBe("Enter a whole number from 1 to 16.");
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ method: "PATCH", jsonBody: { maxNativeSubagents: 10 } }));
  });

  it("cancels the entire interactive edit at the native setting", async () => {
    request.mockResolvedValue(nativeSettings);
    prompt.mockResolvedValueOnce("100").mockResolvedValueOnce("12").mockResolvedValueOnce(Symbol("cancel"));
    await expect(agentSettings({ project: "space-id", interactive: true })).rejects.toThrow("No settings were changed");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    settings,
    { ...settings, maxNativeSubagents: 3 },
    { ...settings, limits: nativeSettings.limits },
  ])("rejects an unadvertised native flag without sending any partial patch", async (response) => {
    request.mockResolvedValue(response);
    await expect(agentSettings({ project: "space-id", maxConcurrentAgents: "12", maxNativeSubagents: "10" })).rejects.toThrow("does not support --max-native-subagents");
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "GET" }));
  });

  it("rejects a native value beyond the controller's limit before patching", async () => {
    request.mockResolvedValue(nativeSettings);
    await expect(agentSettings({ project: "space-id", maxNativeSubagents: "65" })).rejects.toThrow("between 1 and 64");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
