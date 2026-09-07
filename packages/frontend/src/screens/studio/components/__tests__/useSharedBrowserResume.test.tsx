// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSharedBrowserResume } from "../useSharedBrowserResume";

const projectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const runtimeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const search = `?projectId=${projectId}&browserRuntimeId=${runtimeId}`;
type Options = Parameters<typeof useSharedBrowserResume>[0];
let current: ReturnType<typeof useSharedBrowserResume>;
function Harness(props: Options) { current = useSharedBrowserResume(props); return null; }

describe("authenticated Shared resume routing", () => {
  let root: Root;
  let container: HTMLDivElement;
  const onResume = vi.fn();
  const onReplaceSearch = vi.fn();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div"); document.body.append(container); root = createRoot(container); onResume.mockReset(); onReplaceSearch.mockReset();
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
  const render = async (overrides: Partial<Options> = {}) => act(async () => {
    root.render(<Harness search={search} projectId={projectId} userId="user-1" ready onResume={onResume} onReplaceSearch={onReplaceSearch} {...overrides} />);
  });
  it("waits for sign-in, the matching project, and initialized browser preferences", async () => {
    await render({ userId: null }); await render({ projectId: "other" }); await render({ ready: false });
    expect(onResume).not.toHaveBeenCalled();
    await render(); expect(onResume).toHaveBeenCalledExactlyOnceWith(runtimeId);
    await render(); expect(onResume).toHaveBeenCalledTimes(1);
  });
  it("resumes a new explicit target and does not keep reopening a manually closed session", async () => {
    await render(); await render({ ready: false }); await render();
    expect(onResume).toHaveBeenCalledTimes(1);
    const nextId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await render({ search: `?projectId=${projectId}&browserRuntimeId=${nextId}` });
    expect(onResume).toHaveBeenLastCalledWith(nextId);
  });
  it("does not replay a removed or malformed locator, and fences account changes", async () => {
    await render({ search: "?browserRuntimeId=invalid" }); expect(onResume).not.toHaveBeenCalled();
    await render(); await render({ userId: null }); await render({ userId: "user-2" });
    expect(onResume).toHaveBeenCalledTimes(2);
    await render({ search: "" }); expect(onResume).toHaveBeenCalledTimes(2);
  });
  it("acknowledges its own resolved-session URL update without reopening a closed browser", async () => {
    const nextId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await render();
    await act(async () => current.acknowledgeRuntimeResolved(nextId));
    expect(onReplaceSearch).toHaveBeenCalledExactlyOnceWith(`?projectId=${projectId}&browserRuntimeId=${nextId}`);
    // A state update can render before the replacement navigation arrives.
    await render({ ready: false });
    await render({ ready: false, search: onReplaceSearch.mock.calls[0]![0] });
    await render({ search: onReplaceSearch.mock.calls[0]![0] });
    expect(onResume).toHaveBeenCalledExactlyOnceWith(runtimeId);
    // A later genuinely incoming locator remains explicit intent.
    await render();
    expect(onResume).toHaveBeenCalledTimes(2);
    expect(onResume).toHaveBeenLastCalledWith(runtimeId);
  });
  it("does not let an old account or project resolution rewrite the current route", async () => {
    await render();
    const stale = current.acknowledgeRuntimeResolved;
    await render({ userId: "user-2" });
    await act(async () => stale("cccccccc-cccc-4ccc-8ccc-cccccccccccc"));
    expect(onReplaceSearch).not.toHaveBeenCalled();
    await render({ search: "?panel=chat" });
    await act(async () => current.acknowledgeRuntimeResolved(runtimeId));
    expect(onReplaceSearch).not.toHaveBeenCalled();
  });
});
