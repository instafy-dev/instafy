import { describe, expect, it } from "vitest";
import { buildSharedBrowserResumeUrl, clearStaleSharedBrowserResumeTarget, parseSharedBrowserResumeTarget, replaceSharedBrowserResumeRuntime } from "../sharedBrowserResume";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runtimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("Shared Browser resume locators", () => {
  it("constructs only authenticated routing IDs, never copies ambient credentials or page URLs", () => {
    const link = buildSharedBrowserResumeUrl("https://studio.example.test/studio?token=inert&controllerUrl=https://other.test#private", { projectId, runtimeId });
    expect(link).toBe(`https://studio.example.test/studio?projectId=${projectId}&panel=chat&browserRuntimeId=${runtimeId}`);
    expect(parseSharedBrowserResumeTarget(new URL(link!).search)).toEqual({ projectId, runtimeId });
  });
  it("normalizes UUID casing", () => {
    expect(parseSharedBrowserResumeTarget(`?projectId=${projectId.toUpperCase()}&browserRuntimeId=${runtimeId.toUpperCase()}`)).toEqual({ projectId, runtimeId });
  });
  it.each([
    "", `?projectId=${projectId}`, `?browserRuntimeId=${runtimeId}`,
    `?projectId=${projectId}&browserRuntimeId=not-a-runtime`,
    `?projectId=${projectId}&browserRuntimeId=${runtimeId}&browserRuntimeId=${runtimeId}`,
    `?projectId=${projectId}&projectId=${projectId}&browserRuntimeId=${runtimeId}`,
    `?projectId=other&browserRuntimeId=${runtimeId}`,
    `?projectId=${projectId}&browserRuntimeId=https%3A%2F%2Fpage.test`,
  ])("rejects incomplete, malformed, or ambiguous routing %s", (search) => {
    expect(parseSharedBrowserResumeTarget(search)).toBeNull();
  });
  it.each(["javascript:alert(1)", "file:///studio", "https://name:password@studio.test", "not-a-url"])("does not build an unsafe locator base %s", (base) => {
    expect(buildSharedBrowserResumeUrl(base, { projectId, runtimeId })).toBeNull();
  });
  it("does not relabel a previous space's runtime during workspace URL synchronization", () => {
    const params = new URLSearchParams(`projectId=${projectId}&panel=chat&browserRuntimeId=${runtimeId}`);
    const nextProjectId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    expect(clearStaleSharedBrowserResumeTarget(params, nextProjectId)).toBe(true);
    params.set("projectId", nextProjectId);
    expect(parseSharedBrowserResumeTarget(params.toString())).toBeNull();
    expect(params.get("panel")).toBe("chat");
  });
  it("retains a valid locator during same-space panel and conversation navigation", () => {
    const params = new URLSearchParams(`projectId=${projectId}&panel=settings&browserRuntimeId=${runtimeId}`);
    expect(clearStaleSharedBrowserResumeTarget(params, projectId)).toBe(false);
    expect(parseSharedBrowserResumeTarget(params.toString())).toEqual({ projectId, runtimeId });
  });
  it("drops invalid and no-longer-project-bound runtime hints without manufacturing a new one", () => {
    const params = new URLSearchParams(`projectId=${projectId}&browserRuntimeId=${runtimeId}`);
    expect(clearStaleSharedBrowserResumeTarget(params, null)).toBe(true);
    expect(params.has("browserRuntimeId")).toBe(false);
    params.set("browserRuntimeId", "invalid");
    expect(clearStaleSharedBrowserResumeTarget(params, projectId)).toBe(true);
  });
  it("updates only an existing same-space locator after another session resolves", () => {
    const nextId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const search = `?projectId=${projectId}&panel=chat&conversationId=local-1&browserRuntimeId=${runtimeId}`;
    const updated = replaceSharedBrowserResumeRuntime(search, projectId, nextId.toUpperCase());
    expect(parseSharedBrowserResumeTarget(updated!)).toEqual({ projectId, runtimeId: nextId });
    expect(new URLSearchParams(updated!).get("conversationId")).toBe("local-1");
    expect(replaceSharedBrowserResumeRuntime(search, projectId, runtimeId)).toBeNull();
    expect(replaceSharedBrowserResumeRuntime(search, nextId, nextId)).toBeNull();
    expect(replaceSharedBrowserResumeRuntime(search, projectId, "not-a-runtime")).toBeNull();
    expect(replaceSharedBrowserResumeRuntime(`?projectId=${projectId}`, projectId, nextId)).toBeNull();
    expect(replaceSharedBrowserResumeRuntime(`${search}&browserRuntimeId=${nextId}`, projectId, nextId)).toBeNull();
  });
});
