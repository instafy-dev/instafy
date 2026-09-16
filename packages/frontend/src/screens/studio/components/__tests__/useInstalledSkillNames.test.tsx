// @vitest-environment jsdom

import { act, type MutableRefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: {
    workspace: {
      files: {
        list: listMock,
      },
    },
  },
}));

import { useInstalledSkillNames } from "../useInstalledSkillNames";

type HookOptions = Parameters<typeof useInstalledSkillNames>[0];
type HookResult = ReturnType<typeof useInstalledSkillNames>;

function Harness({
  options,
  resultRef,
}: {
  options: HookOptions;
  resultRef: MutableRefObject<HookResult | null>;
}) {
  resultRef.current = useInstalledSkillNames(options);
  return null;
}

describe("useInstalledSkillNames", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    listMock.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function renderHook(options: HookOptions) {
    const resultRef: MutableRefObject<HookResult | null> = { current: null };
    await act(async () => {
      root.render(<Harness options={options} resultRef={resultRef} />);
    });
    return resultRef;
  }

  it("lists .agents/skills once and keeps the directory names", async () => {
    listMock.mockResolvedValue([
      { name: "slack", path: ".agents/skills/slack", kind: "directory" },
      { name: "README.md", path: ".agents/skills/README.md", kind: "file" },
      { name: "notion", path: ".agents/skills/notion", kind: "directory" },
    ]);

    const result = await renderHook({ projectId: "project-1", runtimeId: "runtime-1" });

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith({
      projectId: "project-1",
      path: ".agents/skills",
      runtimeId: "runtime-1",
    });
    expect([...result.current!.names].sort()).toEqual(["notion", "slack"]);
  });

  it("yields an empty set for a null listing or an error", async () => {
    listMock.mockResolvedValueOnce(null);
    const nullResult = await renderHook({ projectId: "project-1", runtimeId: null });
    expect(nullResult.current!.names.size).toBe(0);

    listMock.mockRejectedValueOnce(new Error("offline"));
    await act(async () => {
      await nullResult.current!.refresh();
    });
    expect(nullResult.current!.names.size).toBe(0);
  });

  it("re-lists on refresh()", async () => {
    listMock.mockResolvedValueOnce([
      { name: "slack", path: ".agents/skills/slack", kind: "directory" },
    ]);
    const result = await renderHook({ projectId: "project-1", runtimeId: null });
    expect([...result.current!.names]).toEqual(["slack"]);

    listMock.mockResolvedValueOnce([
      { name: "slack", path: ".agents/skills/slack", kind: "directory" },
      { name: "alpha", path: ".agents/skills/alpha", kind: "directory" },
    ]);
    await act(async () => {
      await result.current!.refresh();
    });
    expect(listMock).toHaveBeenCalledTimes(2);
    expect([...result.current!.names].sort()).toEqual(["alpha", "slack"]);
  });

  it.each([
    { projectId: null, label: "null" },
    { projectId: "", label: "empty" },
    { projectId: "   ", label: "whitespace" },
  ])("performs no request for a $label project id", async ({ projectId }) => {
    const result = await renderHook({ projectId, runtimeId: "runtime-1" });
    await act(async () => {
      await result.current!.refresh();
    });
    expect(listMock).not.toHaveBeenCalled();
    expect(result.current!.names.size).toBe(0);
  });
});
