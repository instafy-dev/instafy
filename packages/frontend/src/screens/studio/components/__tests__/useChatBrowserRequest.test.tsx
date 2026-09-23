// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../types";
import { useChatBrowserRequest } from "../useChatBrowserRequest";

type Options = Parameters<typeof useChatBrowserRequest>[0];
function Harness({ value }: { value: Options }) { useChatBrowserRequest(value); return null; }
function request(location = "auto"): ChatMessage {
  return { id: "request-1", role: "assistant", content: "Continue in browser", timestamp: 1,
    metadata: { messageType: "action_request", details: { browserRequest: { task: "Continue comparing our earlier choices.", location } } } };
}

describe("Chat browser request handoff", () => {
  let root: Root;
  let container: HTMLDivElement;
  let value: Options;
  async function render() { await act(async () => root.render(<Harness value={{ ...value }} />)); }
  async function begin(messageId = "request-1") {
    const detail: { messageId: string; completion?: Promise<unknown> } = { messageId };
    let result: Promise<Error | null> | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent("instafy:request-browser", { detail }));
      result = detail.completion?.then(() => null, (error: Error) => error);
    });
    return { result, detail };
  }
  async function advance(ms = 100) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

  beforeEach(() => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    value = { identity: "user/project/conversation", messages: [request()], canWrite: true, ready: true,
      transport: "personal", open: false, busy: false, personalAvailable: true, personalReady: false, sharedReady: false,
      activate: vi.fn(), continueTask: vi.fn(async () => true), onError: vi.fn() };
  });
  afterEach(async () => {
    await act(async () => root.unmount()); await advance(); container.remove(); vi.useRealTimers();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it.each(["personal", "shared"] as const)("uses the selected %s browser and continues the task only once ready", async (transport) => {
    value.transport = transport; await render();
    const attempt = await begin();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith(transport);
    await advance(); expect(value.continueTask).not.toHaveBeenCalled();
    value.open = true; value.personalReady = true; value.sharedReady = true; await render(); await advance();
    expect(await attempt.result).toBeNull();
    expect(value.continueTask).toHaveBeenCalledExactlyOnceWith(transport, expect.stringContaining("Continue comparing our earlier choices."));
  });

  it("honors an explicit Workspace request after a native default and waits for the original run to finish", async () => {
    value.messages = [request("workspace")]; value.busy = true; await render();
    const attempt = await begin(); expect(value.activate).toHaveBeenCalledWith("shared");
    value.transport = "shared"; value.open = true; value.sharedReady = true; await render(); await advance();
    expect(value.continueTask).not.toHaveBeenCalled();
    value.busy = false; await render(); await advance(); expect(await attempt.result).toBeNull();
  });

  it("continues an action wrapped by the controller's persisted job-message metadata", async () => {
    const message = request();
    value.messages = [{ ...message, metadata: {
      messageType: "action_request",
      details: { ...message.metadata, runtimeId: "ordinary-chat-runtime" },
    } }];
    await render();
    const attempt = await begin();
    expect(value.activate).toHaveBeenCalledExactlyOnceWith("personal");
    value.open = true; value.personalReady = true;
    await render(); await advance();
    expect(await attempt.result).toBeNull();
    expect(value.continueTask).toHaveBeenCalledExactlyOnceWith("personal", expect.stringContaining("Continue comparing our earlier choices."));
  });

  it("keeps an unavailable native profile from silently becoming a Workspace task", async () => {
    value.messages = [request("device")]; value.transport = "shared"; value.personalAvailable = false; await render();
    const attempt = await begin();
    expect(await attempt.result).toMatchObject({ message: expect.stringContaining("desktop app") });
    expect(value.activate).not.toHaveBeenCalled(); expect(value.continueTask).not.toHaveBeenCalled();
  });

  it.each(["identity", "permission", "closed", "transport"])("cancels when %s changes during startup", async (change) => {
    await render(); const attempt = await begin();
    value.open = true; await render(); await advance();
    if (change === "identity") value.identity = "another conversation";
    if (change === "permission") value.canWrite = false;
    if (change === "closed") value.open = false;
    if (change === "transport") value.transport = "shared";
    await render(); await advance();
    expect(await attempt.result).toBeInstanceOf(Error); expect(value.continueTask).not.toHaveBeenCalled();
  });

  it("does not replay history or trust event arguments from an unrelated message", async () => {
    await render(); await advance(60_100); expect(value.activate).not.toHaveBeenCalled();
    expect((await begin("different-message")).detail.completion).toBeUndefined();
    value.messages = [{ ...request(), role: "user" }]; await render();
    expect((await begin()).detail.completion).toBeUndefined();
  });

  it("bounds failed startup and retains a retry path", async () => {
    await render(); const attempt = await begin(); await advance(60_100);
    expect(await attempt.result).toMatchObject({ message: expect.stringContaining("not ready") });
    expect(value.onError).toHaveBeenCalled(); expect(value.continueTask).not.toHaveBeenCalled();
    value.open = true; value.personalReady = true; await render(); const retry = await begin(); await advance();
    expect(await retry.result).toBeNull(); expect(value.continueTask).toHaveBeenCalledTimes(1);
  });
});
