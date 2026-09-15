// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getProjectRecencyStorageKey, PROJECT_RECENCY_CHANGE_EVENT, recordProjectOpened, type ProjectRecencyMap } from "../projectRecency";
import { useProjectRecency } from "../useProjectRecency";

const firstAccount = "first@example.test";
const secondAccount = "second@example.test";

describe("useProjectRecency", () => {
  let container: HTMLDivElement;
  let root: Root;
  let renders: Array<{ account: string | null | undefined; recency: ProjectRecencyMap }>;

  function Probe({ account }: { account?: string | null }) {
    const recency = useProjectRecency(account);
    renders.push({ account, recency });
    return <output>{JSON.stringify(recency)}</output>;
  }
  async function render(account?: string | null) {
    await act(async () => root.render(<Probe account={account} />));
  }
  const latest = () => JSON.parse(container.textContent || "{}");

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    renders = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("reads without writing and reacts immediately to same-tab visits", async () => {
    recordProjectOpened("first", 10, firstAccount);
    const set = vi.spyOn(Storage.prototype, "setItem");
    await render(firstAccount);
    expect(latest()).toEqual({ first: 10 });
    expect(set).not.toHaveBeenCalled();
    await act(async () => recordProjectOpened("second", 20, firstAccount));
    expect(latest()).toEqual({ second: 20, first: 10 });
  });

  it("never renders previous-account or legacy history during account changes", async () => {
    recordProjectOpened("legacy", 50);
    recordProjectOpened("first", 10, firstAccount);
    recordProjectOpened("second", 20, secondAccount);
    await render(firstAccount);
    await render(secondAccount);
    expect(renders.filter((entry) => entry.account === secondAccount).every((entry) => JSON.stringify(entry.recency) === '{"second":20}')).toBe(true);
    await render(null);
    expect(latest()).toEqual({});
    await render();
    expect(latest()).toEqual({});
    await render(" FIRST@EXAMPLE.TEST ");
    expect(latest()).toEqual({ first: 10 });
  });

  it("responds to matching cross-tab writes and clears, ignoring unrelated events", async () => {
    await render(firstAccount);
    const key = getProjectRecencyStorageKey(firstAccount)!;
    window.localStorage.setItem(key, '{"from-other-tab":30}');
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: "unrelated" })));
    expect(latest()).toEqual({});
    await act(async () => recordProjectOpened("other-account", 50, secondAccount));
    expect(latest()).toEqual({});
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key })));
    expect(latest()).toEqual({ "from-other-tab": 30 });
    window.localStorage.clear();
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(latest()).toEqual({});
  });

  it("does not show old history when storage becomes unavailable", async () => {
    recordProjectOpened("first", 10, firstAccount);
    await render(firstAccount);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: getProjectRecencyStorageKey(firstAccount) })));
    expect(latest()).toEqual({});
    await render(secondAccount);
    expect(latest()).toEqual({});
  });

  it("removes its listeners on scope change and unmount", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    await render(firstAccount);
    await render(secondAccount);
    expect(remove).toHaveBeenCalledWith("storage", expect.any(Function));
    expect(remove).toHaveBeenCalledWith(PROJECT_RECENCY_CHANGE_EVENT, expect.any(Function));
    remove.mockClear();
    await act(async () => root.render(null));
    expect(remove).toHaveBeenCalledWith("storage", expect.any(Function));
    expect(remove).toHaveBeenCalledWith(PROJECT_RECENCY_CHANGE_EVENT, expect.any(Function));
  });
});
