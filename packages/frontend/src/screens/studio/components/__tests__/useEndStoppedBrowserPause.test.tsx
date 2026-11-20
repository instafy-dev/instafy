// @vitest-environment jsdom
//
// A local test, Nov 20: a Stop during a sign-in pause stopped the turn at
// once, and the page in Instafy's browser kept its outlined fields. The
// outlines are the page's own, so the browser takes them off.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../sdk/instafy", () => ({ controllerClient: { browserSessions: { endHumanInput: vi.fn() } } }));
import { useEndStoppedBrowserPause } from "../useEndStoppedBrowserPause";

type Options = Parameters<typeof useEndStoppedBrowserPause>[0];

describe("useEndStoppedBrowserPause", () => {
  let root: Root;
  let container: HTMLDivElement;
  const end = vi.fn<NonNullable<Options["end"]>>();
  let props: Options;
  function Harness() { useEndStoppedBrowserPause(props); return null; }
  async function render(next: Partial<Options> = {}) {
    props = { ...props, ...next };
    await act(async () => { root.render(<Harness />); });
  }
  const pause = { handoffId: "handoff-1", browserPageId: "PAGE1" };
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    end.mockReset().mockResolvedValue(true);
    props = { request: null, projectId: "project-1", browserSessionId: "session-1", preferRuntimeId: "runtime-1", end };
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

  it("asks the browser to end the pause a Stop ended, once, and nothing while no pause was stopped", async () => {
    await render();
    expect(end).not.toHaveBeenCalled();
    await render({ request: pause });
    expect(end).toHaveBeenCalledExactlyOnceWith({
      projectId: "project-1", browserSessionId: "session-1", preferRuntimeId: "runtime-1", pageId: "PAGE1", handoffId: "handoff-1",
    });
    // The same pause, read from the log again: nothing more is sent.
    await render({ request: { ...pause } });
    await render({ request: { ...pause } });
    expect(end).toHaveBeenCalledTimes(1);
    // A later pause that is stopped too is ended by itself.
    await render({ request: { handoffId: "handoff-2", browserPageId: "PAGE1" } });
    expect(end).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenLastCalledWith(expect.objectContaining({ handoffId: "handoff-2" }));
  });

  it("stays quiet when the browser cannot end it: an older browser, or a pause that is no longer the page's", async () => {
    end.mockRejectedValue(new Error("offline"));
    await render({ request: pause });
    await act(async () => { await Promise.resolve(); });
    expect(end).toHaveBeenCalledTimes(1);
    end.mockResolvedValue(false);
    await render({ request: { handoffId: "handoff-2", browserPageId: "PAGE1" } });
    await act(async () => { await Promise.resolve(); });
    expect(end).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("");
  });

  it("sends nothing without a space to send it for", async () => {
    await render({ request: pause, projectId: null });
    expect(end).not.toHaveBeenCalled();
  });
});
