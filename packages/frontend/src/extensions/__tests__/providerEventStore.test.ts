import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchDebugInjectedProviderEvents, dispatchObservedProviderEvents } from "../providerEventChannel";
import {
  appendProviderEventsToStore,
  clearProviderEventLogStore,
  getProviderEventLogSnapshot,
  subscribeToProviderEventLog,
} from "../providerEventStore";

describe("providerEventStore", () => {
  afterEach(() => {
    clearProviderEventLogStore();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("updates the shared log when provider events are appended directly", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToProviderEventLog(listener);

    appendProviderEventsToStore([
      {
        kind: "camera.photo_captured",
        providerId: "camera-primary",
        providerType: "phone_camera",
        timestampNs: 100,
        payload: { lens: "rear", mode: "single" },
      },
    ]);

    const [entry] = getProviderEventLogSnapshot();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(entry?.latestEvent.kind).toBe("camera.photo_captured");
    expect(entry?.reaction).toBe("surface_in_conversation");

    unsubscribe();
  });

  it("bridges observed and injected window events into the shared log", () => {
    const eventTarget = new EventTarget();
    vi.stubGlobal("window", {
      addEventListener: eventTarget.addEventListener.bind(eventTarget),
      removeEventListener: eventTarget.removeEventListener.bind(eventTarget),
      dispatchEvent: eventTarget.dispatchEvent.bind(eventTarget),
    });

    const listener = vi.fn();
    const unsubscribe = subscribeToProviderEventLog(listener);

    dispatchObservedProviderEvents([
      {
        kind: "audio.wake_word_detected",
        providerId: "phone-mic",
        providerType: "phone_audio",
        timestampNs: 200,
        payload: { label: "hey instafy" },
      },
    ]);
    dispatchDebugInjectedProviderEvents([
      {
        kind: "robot.telemetry_sampled",
        providerId: "demo",
        providerType: "robot_embodiment",
        timestampNs: 300,
        payload: { category: "heartbeat" },
      },
    ]);

    const entries = getProviderEventLogSnapshot();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.latestEvent.kind).toBe("robot.telemetry_sampled");
    expect(entries[1]?.latestEvent.kind).toBe("audio.wake_word_detected");

    unsubscribe();
  });

  it("clears the shared log and notifies listeners once", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToProviderEventLog(listener);

    appendProviderEventsToStore([
      {
        kind: "camera.photo_captured",
        providerId: "camera-primary",
        providerType: "phone_camera",
        timestampNs: 100,
        payload: { lens: "rear", mode: "single" },
      },
    ]);
    listener.mockReset();

    clearProviderEventLogStore();

    expect(getProviderEventLogSnapshot()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
