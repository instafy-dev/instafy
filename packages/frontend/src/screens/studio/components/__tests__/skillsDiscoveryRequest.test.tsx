// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeSkillsDiscoveryRequest,
  requestSkillsDiscovery,
  subscribeSkillsDiscoveryRequest,
  useSkillsDiscoveryRequest,
} from "../skillsDiscoveryRequest";

function Consumer({ onRequest }: { onRequest: (query: string) => void }) {
  useSkillsDiscoveryRequest(onRequest);
  return null;
}

describe("skillsDiscoveryRequest", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // Drain anything a previous test left pending.
    consumeSkillsDiscoveryRequest();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("holds one query until it is consumed, then clears it", () => {
    expect(consumeSkillsDiscoveryRequest()).toBeNull();
    requestSkillsDiscovery("quickbooks");
    expect(consumeSkillsDiscoveryRequest()).toBe("quickbooks");
    expect(consumeSkillsDiscoveryRequest()).toBeNull();
    requestSkillsDiscovery("one");
    requestSkillsDiscovery("two");
    expect(consumeSkillsDiscoveryRequest()).toBe("two");
  });

  it("notifies subscribers on every request until they unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSkillsDiscoveryRequest(listener);
    requestSkillsDiscovery("a");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    requestSkillsDiscovery("b");
    expect(listener).toHaveBeenCalledTimes(1);
    consumeSkillsDiscoveryRequest();
  });

  it("delivers a query pending at mount, then live requests, and stops after unmount", async () => {
    const onRequest = vi.fn();
    requestSkillsDiscovery("quickbooks");
    await act(async () => {
      root.render(<Consumer onRequest={onRequest} />);
    });
    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(onRequest).toHaveBeenCalledWith("quickbooks");
    expect(consumeSkillsDiscoveryRequest()).toBeNull();

    await act(async () => {
      requestSkillsDiscovery("xero");
    });
    expect(onRequest).toHaveBeenCalledTimes(2);
    expect(onRequest).toHaveBeenLastCalledWith("xero");
    expect(consumeSkillsDiscoveryRequest()).toBeNull();

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    requestSkillsDiscovery("late");
    expect(onRequest).toHaveBeenCalledTimes(2);
    // The late request waits for the next mount.
    expect(consumeSkillsDiscoveryRequest()).toBe("late");
  });

  it("delivers nothing when no query is pending at mount", async () => {
    const onRequest = vi.fn();
    await act(async () => {
      root.render(<Consumer onRequest={onRequest} />);
    });
    expect(onRequest).not.toHaveBeenCalled();
  });
});
