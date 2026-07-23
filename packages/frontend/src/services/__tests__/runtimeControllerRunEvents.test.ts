// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.hoisted(() => vi.fn());

vi.mock("../../lib/supabaseClient", () => ({
  supabase: {
    auth: {
      getSession: getSessionMock,
    },
  },
}));

class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback =
      typeof listener === "function"
        ? listener
        : (event: Event) => listener.handleEvent(event);
    const current = this.listeners.get(type) ?? [];
    current.push(callback);
    this.listeners.set(type, current);
  }

  close() {
    this.closed = true;
  }

  emitMessage(payload: unknown) {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify(payload),
      }),
    );
  }
}

describe("runtime controller project access events", () => {
  beforeEach(() => {
    vi.resetModules();
    getSessionMock.mockReset();
    getSessionMock.mockResolvedValue({
      data: { session: { access_token: "test-access-token" } },
    });
    FakeEventSource.instances = [];
    window.history.replaceState(
      null,
      "",
      "/studio?controllerUrl=https%3A%2F%2Fcontroller.example.test",
    );
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.clear();
  });

  it("subscribes to and forwards project.access_changed invalidations", async () => {
    const { subscribeToRunsFromController } = await import(
      "../runtimeController/runs"
    );
    const onEvent = vi.fn();
    const unsubscribe = subscribeToRunsFromController({
      projectId: "11111111-1111-4111-8111-111111111111",
      quietErrors: true,
      onRun: vi.fn(),
      onEvent,
    });

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    const kinds = new URL(source.url).searchParams.getAll("kinds[]");
    expect(kinds).toContain("project.access_changed");

    const event = {
      kind: "project.access_changed",
      project_id: "11111111-1111-4111-8111-111111111111",
      data: { reason: "membership_changed" },
    };
    source.emitMessage(event);

    expect(onEvent).toHaveBeenCalledWith(event);
    unsubscribe();
    expect(source.closed).toBe(true);
  });
});
