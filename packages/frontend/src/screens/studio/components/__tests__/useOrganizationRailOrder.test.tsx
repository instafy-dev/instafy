// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOrganizationRailOrder } from "../useOrganizationRailOrder";

type Organization = { key: string; label: string };
type HookResult = ReturnType<typeof useOrganizationRailOrder<Organization>>;
const organizations: Organization[] = [
  { key: "alpha", label: "Alpha" },
  { key: "beta", label: "Beta" },
  { key: "gamma", label: "Gamma" },
];
const storageKey = (userId: string) => `instafy:organization-rail-order:v1:${encodeURIComponent(userId)}`;

function Harness({ userId, items, resultRef, onRender }: {
  userId: string | null | undefined;
  items: readonly Organization[];
  resultRef: { current: HookResult | null };
  onRender?: (keys: string[]) => void;
}) {
  resultRef.current = useOrganizationRailOrder(userId, items);
  onRender?.(resultRef.current.orderedOrganizations.map((organization) => organization.key));
  return null;
}

describe("useOrganizationRailOrder", () => {
  let container: HTMLDivElement;
  let root: Root;
  let resultRef: { current: HookResult | null };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resultRef = { current: null };
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    window.localStorage.clear();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  async function render(userId: string | null | undefined = "user-1", items = organizations, onRender?: (keys: string[]) => void) {
    await act(async () => root.render(<Harness userId={userId} items={items} resultRef={resultRef} onRender={onRender} />));
  }

  const keys = () => resultRef.current!.orderedOrganizations.map((organization) => organization.key);
  const saved = (userId = "user-1") => JSON.parse(window.localStorage.getItem(storageKey(userId)) ?? "null");

  it("moves organizations in either direction, saves only IDs, and restores the order after remount", async () => {
    await render();
    expect(keys()).toEqual(["alpha", "beta", "gamma"]);
    expect(saved()).toBeNull();
    await act(async () => resultRef.current!.moveOrganization("gamma", "alpha"));
    expect(keys()).toEqual(["gamma", "alpha", "beta"]);
    expect(saved()).toEqual(["gamma", "alpha", "beta"]);
    expect(resultRef.current!.orderedOrganizations[0]).toBe(organizations[2]);
    await act(async () => resultRef.current!.moveOrganization("gamma", "beta"));
    expect(keys()).toEqual(["alpha", "beta", "gamma"]);
    await act(async () => resultRef.current!.moveOrganization("beta", "alpha"));
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(keys()).toEqual(["beta", "alpha", "gamma"]);
  });

  it("preserves a saved order through empty and partial loads, then appends new organizations", async () => {
    window.localStorage.setItem(storageKey("user-1"), JSON.stringify(["gamma", "beta", "alpha"]));
    await render("user-1", []);
    expect(keys()).toEqual([]);
    expect(saved()).toEqual(["gamma", "beta", "alpha"]);
    await render("user-1", [organizations[0], organizations[2]]);
    expect(keys()).toEqual(["gamma", "alpha"]);
    await act(async () => resultRef.current!.moveOrganization("alpha", "gamma"));
    expect(saved()).toEqual(["alpha", "beta", "gamma"]);
    await render("user-1", [{ key: "new", label: "A new team" }, ...organizations]);
    expect(keys()).toEqual(["alpha", "beta", "gamma", "new"]);
    await act(async () => resultRef.current!.moveOrganization("new", "gamma"));
    expect(saved()).toEqual(["alpha", "beta", "new", "gamma"]);
  });

  it("isolates accounts immediately and ignores callbacks retained from the previous account", async () => {
    window.localStorage.setItem(storageKey("user-1"), JSON.stringify(["gamma", "alpha", "beta"]));
    window.localStorage.setItem(storageKey("user-2"), JSON.stringify(["beta", "gamma", "alpha"]));
    await render();
    const staleMove = resultRef.current!.moveOrganization;
    const onRender = vi.fn();
    await render("user-2", organizations, onRender);
    expect(onRender.mock.calls.every(([order]) => JSON.stringify(order) === JSON.stringify(["beta", "gamma", "alpha"]))).toBe(true);
    await act(async () => staleMove("gamma", "beta"));
    expect(saved("user-1")).toEqual(["gamma", "alpha", "beta"]);
    expect(saved("user-2")).toEqual(["beta", "gamma", "alpha"]);
    expect(keys()).toEqual(["beta", "gamma", "alpha"]);
    await act(async () => resultRef.current!.moveOrganization("alpha", "beta"));
    expect(saved("user-2")).toEqual(["alpha", "beta", "gamma"]);
    await render("user-1");
    expect(keys()).toEqual(["gamma", "alpha", "beta"]);
  });

  it("does not save outgoing organization data when the next account has not loaded", async () => {
    await render();
    await act(async () => resultRef.current!.moveOrganization("gamma", "alpha"));
    await render("user-2");
    expect(saved("user-2")).toBeNull();
    await render("user-2", []);
    expect(saved("user-2")).toBeNull();
    await render("user-2", [{ key: "second", label: "Second account team" }]);
    expect(keys()).toEqual(["second"]);
    expect(saved("user-2")).toBeNull();
  });

  it.each(["not json", "null", '{"alpha":1}', "42"])("recovers from invalid storage %s", async (value) => {
    window.localStorage.setItem(storageKey("user-1"), value);
    await render();
    expect(keys()).toEqual(["alpha", "beta", "gamma"]);
    await act(async () => resultRef.current!.moveOrganization("beta", "alpha"));
    expect(saved()).toEqual(["beta", "alpha", "gamma"]);
  });

  it("ignores invalid and duplicate saved IDs and renders each organization once", async () => {
    window.localStorage.setItem(storageKey("user-1"), JSON.stringify(["beta", "beta", null, 5, "", "  ", {}, "alpha"]));
    await render("user-1", [...organizations, { key: "beta", label: "Duplicate" }]);
    expect(keys()).toEqual(["beta", "alpha", "gamma"]);
    expect(resultRef.current!.orderedOrganizations[0]).toBe(organizations[1]);
    await act(async () => resultRef.current!.moveOrganization("gamma", "beta"));
    expect(saved()).toEqual(["gamma", "beta", "alpha"]);
  });

  it("ignores missing and unchanged drag targets", async () => {
    await render();
    await act(async () => {
      resultRef.current!.moveOrganization("alpha", "alpha");
      resultRef.current!.moveOrganization("missing", "beta");
      resultRef.current!.moveOrganization("beta", "missing");
    });
    expect(keys()).toEqual(["alpha", "beta", "gamma"]);
    expect(saved()).toBeNull();
  });

  it("does not save or inherit a signed-out preference", async () => {
    await render();
    await act(async () => resultRef.current!.moveOrganization("gamma", "alpha"));
    await render(null);
    await act(async () => resultRef.current!.moveOrganization("beta", "alpha"));
    expect(keys()).toEqual(["alpha", "beta", "gamma"]);
    expect(window.localStorage.length).toBe(1);
    expect(saved()).toEqual(["gamma", "alpha", "beta"]);
  });

  it("still reorders when storage is unavailable", async () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("Unavailable"); });
    await render();
    await act(async () => resultRef.current!.moveOrganization("gamma", "alpha"));
    expect(keys()).toEqual(["gamma", "alpha", "beta"]);
  });

  it("updates from another tab without writing back or reacting to other accounts", async () => {
    await render();
    const write = vi.spyOn(Storage.prototype, "setItem");
    window.localStorage.setItem(storageKey("user-2"), JSON.stringify(["gamma", "alpha", "beta"]));
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: storageKey("user-2") })));
    expect(keys()).toEqual(["alpha", "beta", "gamma"]);
    window.localStorage.setItem(storageKey("user-1"), JSON.stringify(["beta", "gamma", "alpha"]));
    write.mockClear();
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: storageKey("user-1") })));
    expect(keys()).toEqual(["beta", "gamma", "alpha"]);
    expect(write).not.toHaveBeenCalled();
    window.localStorage.clear();
    await act(async () => window.dispatchEvent(new StorageEvent("storage", { key: null })));
    expect(keys()).toEqual(["alpha", "beta", "gamma"]);
    expect(write).not.toHaveBeenCalled();
  });
});
