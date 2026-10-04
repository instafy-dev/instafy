// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRecovery: vi.fn(),
  versioning: {
    projectId: "project-1" as string | null,
    originId: "origin-1" as string | null,
    historyReady: true,
  },
}));

vi.mock("../../../../sdk/instafy", () => ({
  controllerClient: { workspace: { git: { fetchRecovery: mocks.fetchRecovery } } },
}));
vi.mock("../../../../workspace/useActiveWorkspaceVersioning", () => ({
  useActiveWorkspaceVersioning: () => mocks.versioning,
}));

import { resetUnsavedWorkStoreForTests } from "../../../../workspace/unsavedWorkStore";
import { useUnsavedWorkNotice, type UnsavedWorkNotice } from "../useUnsavedWorkNotice";

type Message = { metadata?: Record<string, unknown> | null };

function recovery(ref: string, extra: Record<string, unknown> = {}) {
  return {
    ref,
    rev: "a".repeat(40),
    kind: "unpublished",
    subject: "",
    date: null,
    origin: null,
    paths: ["a.txt"],
    base: null,
    dismissible: true,
    ...extra,
  };
}

function ok(entries: unknown[]) {
  return { status: "ok", entries, originId: "origin-1", originMode: "hosted" };
}

function applyMessage(ref: string): Message {
  return { metadata: { artifacts: [{ kind: "origin/apply", metadata: { recoveryRef: ref } }] } };
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      await Promise.resolve();
    }
  });
}

describe("useUnsavedWorkNotice", () => {
  let container: HTMLDivElement;
  let root: Root;
  let notice: UnsavedWorkNotice | null = null;

  function Probe({ userId, messages }: { userId: string | null; messages: Message[] }) {
    notice = useUnsavedWorkNotice({ userId, messages });
    return null;
  }

  async function render(userId: string | null = "user-1", messages: Message[] = []) {
    await act(async () => root.render(<Probe userId={userId} messages={messages} />));
    await flush();
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    resetUnsavedWorkStoreForTests();
    window.localStorage.clear();
    mocks.versioning = { projectId: "project-1", originId: "origin-1", historyReady: true };
    mocks.fetchRecovery.mockReset();
    mocks.fetchRecovery.mockResolvedValue(
      ok([
        recovery("refs/instafy/recovery/o/a"),
        recovery("refs/instafy/recovery/o/b"),
        recovery("refs/instafy/salvage/gateway/c", { kind: "salvage", restoredRev: "f".repeat(40) }),
      ]),
    );
    notice = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("stays silent in legacy spaces and lists nothing", async () => {
    mocks.versioning = { projectId: "project-1", originId: "origin-1", historyReady: false };
    await render();
    expect(notice).toBeNull();
    expect(mocks.fetchRecovery).not.toHaveBeenCalled();
  });

  it("appears once per new entry and per viewer, and Dismiss remembers it", async () => {
    await render();
    expect(notice?.count).toBe(2);
    await act(async () => notice?.onDismiss());
    expect(notice).toBeNull();
    expect(window.localStorage.getItem("instafy.unsavedWork.seen.project-1.user-1")).toContain(
      "refs/instafy/recovery/o/a@",
    );

    // Back again later: still seen.
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(notice).toBeNull();

    // Another viewer on this browser has not seen it.
    await render("user-2");
    expect(notice?.count).toBe(2);
  });

  it("Open History marks the entries seen and opens the drawer", async () => {
    const opened: unknown[] = [];
    const listener = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener("instafy:open-source-control", listener);
    await render();
    await act(async () => notice?.onOpenHistory());
    window.removeEventListener("instafy:open-source-control", listener);
    expect(opened).toEqual([{ projectId: "project-1" }]);
    expect(notice).toBeNull();
  });

  it("lists again when a finished turn reports a new recovery ref", async () => {
    await render("user-1", [applyMessage("refs/instafy/recovery/o/a")]);
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);

    await render("user-1", [applyMessage("refs/instafy/recovery/o/a")]);
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(1);

    mocks.fetchRecovery.mockResolvedValue(
      ok([recovery("refs/instafy/recovery/o/a"), recovery("refs/instafy/recovery/o/b"), recovery("refs/instafy/recovery/o/new")]),
    );
    await render("user-1", [applyMessage("refs/instafy/recovery/o/a"), applyMessage("refs/instafy/recovery/o/new")]);
    expect(mocks.fetchRecovery).toHaveBeenCalledTimes(2);
    expect(notice?.count).toBe(3);
  });
});
