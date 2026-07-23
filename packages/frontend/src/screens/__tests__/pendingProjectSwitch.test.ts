import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingProjectSwitch,
  readPendingProjectSwitch,
  writePendingProjectSwitch,
} from "../pendingProjectSwitch";

function createSessionStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("window", {
    sessionStorage: createSessionStorageMock(),
    localStorage: createSessionStorageMock(),
  });
});

afterEach(() => {
  clearPendingProjectSwitch();
  vi.unstubAllGlobals();
});

describe("pendingProjectSwitch", () => {
  it("persists the pending switch to memory and both storage layers", () => {
    writePendingProjectSwitch("850a0f5b-ca83-40b9-8ada-8f54caaacf79", 12_345);

    expect(readPendingProjectSwitch()).toEqual({
      projectId: "850a0f5b-ca83-40b9-8ada-8f54caaacf79",
      at: 12_345,
    });
    expect(window.sessionStorage.getItem("instafy.pendingProjectSwitch")).not.toBeNull();
    expect(window.localStorage.getItem("instafy.pendingProjectSwitch")).not.toBeNull();
  });

  it("hydrates the in-memory switch from local storage after a relaunch", () => {
    window.localStorage.setItem(
      "instafy.pendingProjectSwitch",
      JSON.stringify({
        projectId: "b0f7c165-18d1-420d-90da-be8c29018e0d",
        at: 54_321,
      }),
    );

    expect(readPendingProjectSwitch()).toEqual({
      projectId: "b0f7c165-18d1-420d-90da-be8c29018e0d",
      at: 54_321,
    });
  });

  it("clears both storage layers", () => {
    writePendingProjectSwitch("850a0f5b-ca83-40b9-8ada-8f54caaacf79", 12_345);

    clearPendingProjectSwitch();

    expect(readPendingProjectSwitch()).toBeNull();
    expect(window.sessionStorage.getItem("instafy.pendingProjectSwitch")).toBeNull();
    expect(window.localStorage.getItem("instafy.pendingProjectSwitch")).toBeNull();
  });
});
