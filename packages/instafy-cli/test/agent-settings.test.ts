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
