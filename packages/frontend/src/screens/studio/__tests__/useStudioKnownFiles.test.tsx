// @vitest-environment jsdom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getStudioWorkspaceOwnerKey, useStudioKnownFiles, type StudioDirectoryListing } from "../useStudioKnownFiles";

describe("already-browsed Studio file metadata", () => {
  let root: Root;
  let container: HTMLDivElement;
  let scope: [string | null, string | null, string];
  let current: ReturnType<typeof useStudioKnownFiles>;
  let publishFromChild = false;
  function Child({ publish }: { publish: typeof current.recordDirectory }) {
    useEffect(() => { publish({ projectId: scope[1]!, directory: "", entries: [{ path: "INSTAFY.md", kind: "file" }] }); }, [publish]);
    return null;
  }
  function Harness() {
    current = useStudioKnownFiles(...scope);
    return publishFromChild ? <Child publish={current.recordDirectory} /> : null;
  }
  async function render(next = scope) {
    scope = next;
    await act(async () => root.render(<Harness />));
  }
  async function publish(directory: string, entries: StudioDirectoryListing["entries"], projectId = "space-a") {
    await act(async () => current.recordDirectory({ directory, entries, projectId }));
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    scope = ["viewer-a", "space-a", "origin-a"];
    publishFromChild = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("retains safe file paths only, deduplicating listings without copying contents", async () => {
    await render();
    await publish("", [
      { path: "INSTAFY.md", kind: "file" }, { path: "INSTAFY.md", kind: "file" },
      { path: "src", kind: "directory" }, { path: "socket", kind: "other" },
      { path: "src/unlisted.ts", kind: "file" }, { path: "../secret", kind: "file" },
      { path: "/etc/passwd", kind: "file" }, { path: "C:\\private", kind: "file" },
      { path: "null\0.md", kind: "file" },
    ]);
    expect(current.files).toEqual([{ projectId: "space-a", path: "INSTAFY.md", fileId: "INSTAFY.md" }]);
    await publish("src", [{ path: "src/main.ts", kind: "file" }, { path: "elsewhere.ts", kind: "file" }]);
    expect(current.files.map((file) => file.path)).toEqual(["INSTAFY.md", "src/main.ts"]);
    await publish("../private", [{ path: "../private/token", kind: "file" }]);
    await publish("", [{ path: "foreign.md", kind: "file" }], "space-b");
    expect(current.files.map((file) => file.path)).toEqual(["INSTAFY.md", "src/main.ts"]);
  });

  it("replaces refreshed directories and drops descendants of removed folders", async () => {
    await render();
    await publish("", [{ path: "src", kind: "directory" }, { path: "old.md", kind: "file" }]);
    await publish("src", [{ path: "src/nested", kind: "directory" }, { path: "src/old.ts", kind: "file" }]);
    await publish("src/nested", [{ path: "src/nested/file.ts", kind: "file" }]);
    await publish("src", [{ path: "src/new.ts", kind: "file" }]);
    expect(current.files.map((file) => file.path)).toEqual(["old.md", "src/new.ts"]);
    await publish("", [{ path: "new.md", kind: "file" }]);
    expect(current.files.map((file) => file.path)).toEqual(["new.md"]);
    await publish("src/nested", [{ path: "src/nested/stale.ts", kind: "file" }]);
    expect(current.files.map((file) => file.path)).toEqual(["new.md"]);
  });

  it.each([0, 1, 2])("clears and rejects late A → B → A callbacks for scope field %s", async (index) => {
    await render();
    const oldPublish = current.recordDirectory;
    await publish("", [{ path: "private.md", kind: "file" }]);
    const changed = [...scope] as typeof scope;
    changed[index] = "different-owner";
    await render(changed);
    expect(current.files).toEqual([]);
    await render(["viewer-a", "space-a", "origin-a"]);
    await act(async () => oldPublish({ projectId: "space-a", directory: "", entries: [{ path: "stale.md", kind: "file" }] }));
    expect(current.files).toEqual([]);
    await publish("", [{ path: "fresh.md", kind: "file" }]);
    expect(current.files.map((file) => file.path)).toEqual(["fresh.md"]);
  });

  it("rejects anonymous publication and callbacks after unmount", async () => {
    await render([null, "space-a", "origin-a"]);
    await publish("", [{ path: "private.md", kind: "file" }]);
    expect(current.files).toEqual([]);
    await render(["viewer-a", "space-a", "origin-a"]);
    const oldPublish = current.recordDirectory;
    await act(async () => root.render(null));
    await act(async () => oldPublish({ projectId: "space-a", directory: "", entries: [{ path: "private.md", kind: "file" }] }));
    await render();
    expect(current.files).toEqual([]);
  });

  it("does not wipe a child listing published in the same commit as a scope change", async () => {
    publishFromChild = true;
    await render();
    expect(current.files.map((file) => file.path)).toEqual(["INSTAFY.md"]);
    await render(["viewer-a", "space-b", "origin-b"]);
    expect(current.files).toEqual([{ projectId: "space-b", path: "INSTAFY.md", fileId: "INSTAFY.md" }]);
  });

  it("distinguishes workspace device/folder/origin changes without depending on heartbeats", () => {
    const source = { effectiveRuntimeId: "runtime", localWorkspace: { deviceId: "device", path: "folder", status: "online" as const }, desktopOrigin: { originId: "origin", endpoint: "https://origin.example", mode: "local" } };
    const key = getStudioWorkspaceOwnerKey(source);
    expect(getStudioWorkspaceOwnerKey({ ...source, localWorkspace: { ...source.localWorkspace, lastHeartbeat: "later" } })).toBe(key);
    expect(getStudioWorkspaceOwnerKey({ ...source, localWorkspace: { ...source.localWorkspace, path: "other-folder" } })).not.toBe(key);
    expect(getStudioWorkspaceOwnerKey({ ...source, localWorkspace: { ...source.localWorkspace, deviceId: "other-device" } })).not.toBe(key);
    expect(getStudioWorkspaceOwnerKey({ ...source, desktopOrigin: { ...source.desktopOrigin, originId: "other-origin" } })).not.toBe(key);
  });
});
