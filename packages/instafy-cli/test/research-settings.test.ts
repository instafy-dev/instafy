import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { researchSettings } from "../src/research-settings.js";
import { requestControllerApiJson } from "../src/api.js";
import { text } from "@clack/prompts";

vi.mock("../src/api.js", () => ({ requestControllerApiJson: vi.fn() }));
vi.mock("@clack/prompts", () => ({ text: vi.fn(), isCancel: (value: unknown) => typeof value === "symbol" }));
const settings = { maxPageLoads: 12, maxPageLoadsPerSite: 4, canManage: true, limits: {
  maxPageLoads: { min: 1, max: 200, default: 12 }, maxPageLoadsPerSite: { min: 1, max: 200, default: 4 },
} };
const request = vi.mocked(requestControllerApiJson);
const prompt = vi.mocked(text);
const descriptors = [process.stdin, process.stdout].map(stream => Object.getOwnPropertyDescriptor(stream, "isTTY"));
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("CI", "false");
  vi.spyOn(console, "log").mockImplementation(() => {});
  for (const stream of [process.stdin, process.stdout]) Object.defineProperty(stream, "isTTY", { configurable: true, value: true });
  request.mockResolvedValue(settings);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  [process.stdin, process.stdout].forEach((stream, index) => {
    if (descriptors[index]) Object.defineProperty(stream, "isTTY", descriptors[index]!);
    else delete (stream as { isTTY?: boolean }).isTTY;
  });
});

describe("research settings", () => {
  it("changes only the requested field and reports the saved configuration", async () => {
    request.mockResolvedValueOnce(settings).mockResolvedValueOnce({ ...settings, maxPageLoadsPerSite: 8 });
    await researchSettings({ project: "space-id", maxPageLoadsPerSite: "8", json: true });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({
      path: "/projects/space-id/research-settings", method: "PATCH", jsonBody: { maxPageLoadsPerSite: 8 },
    }));
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0]).maxPageLoadsPerSite).toBe(8);
  });
  it("uses server bounds and atomically saves an interactive edit", async () => {
    prompt.mockResolvedValueOnce("20").mockResolvedValueOnce("10");
    await researchSettings({ project: "space-id", interactive: true });
    expect(prompt.mock.calls.map(([options]) => options.defaultValue)).toEqual(["12", "4"]);
    expect(prompt.mock.calls[1][0].validate!("21")).toContain("cannot exceed");
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ jsonBody: { maxPageLoads: 20, maxPageLoadsPerSite: 10 } }));
  });
  it("does not persist partial interactive edits on cancellation", async () => {
    prompt.mockResolvedValueOnce("20").mockResolvedValueOnce(Symbol("cancel"));
    await expect(researchSettings({ project: "space-id", interactive: true })).rejects.toThrow("No settings were changed");
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([{ maxPageLoads: "0" }, { maxPageLoads: "2.5" }, { maxPageLoads: "201" }, { maxPageLoads: "3" }, { maxPageLoadsPerSite: "13" }])("rejects invalid budgets without a PATCH: %j", async options => {
    await expect(researchSettings({ project: "space-id", ...options })).rejects.toThrow();
    expect(request.mock.calls.every(([call]) => call.method === "GET")).toBe(true);
  });
  it("allows read-only inspection but rejects changes by a member", async () => {
    request.mockResolvedValue({ ...settings, canManage: false });
    await researchSettings({ project: "space-id", json: true });
    await expect(researchSettings({ project: "space-id", maxPageLoads: "20" })).rejects.toThrow("Only space managers");
    expect(request.mock.calls.every(([call]) => call.method === "GET")).toBe(true);
  });
  it("rejects unsupported settings instead of sending a partial PATCH", async () => {
    request.mockResolvedValue({ ...settings, limits: {} });
    await expect(researchSettings({ project: "space-id", maxPageLoads: "20" })).rejects.toThrow("does not support");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
