import { expect, type Page } from "@playwright/test";

const CLICK_INPUT_MESSAGE_COUNT = 2;

type InputSocketProbeEntry = {
  socket: WebSocket;
  ready: boolean;
  closed: boolean;
  errors: string[];
  pageId: string | null;
  resizes: Array<{ width: number; height: number; dpr: number }>;
};

type CollaborationSocketProbeEntry = {
  socket: WebSocket;
  opened: boolean;
  closed: boolean;
  participantId: string | null;
  receivedTypes: string[];
  latestState: Record<string, unknown> | null;
};

type RendererSocketProbeEntry = {
  socket: WebSocket;
  closed: boolean;
};

type SharedBrowserSocketProbeWindow = Window & {
  __INSTAFY_SHARED_BROWSER_SOCKET_PROBE__?: {
    collaborationEntries: CollaborationSocketProbeEntry[];
    inputEntries: InputSocketProbeEntry[];
    rendererEntries: RendererSocketProbeEntry[];
  };
};

export type InputSocketProbeSnapshot = {
  ready: boolean;
  closed: boolean;
  open: boolean;
  errors: string[];
  pageId: string | null;
  resizes: Array<{ width: number; height: number; dpr: number }>;
};

export type CollaborationSocketProbeSnapshot = {
  closed: boolean;
  latestState: Record<string, unknown> | null;
  open: boolean;
  opened: boolean;
  participantId: string | null;
  receivedTypes: string[];
};

export async function installSharedBrowserSocketProbe(page: Page) {
  await page.evaluate(() => {
    const runtimeWindow = window as SharedBrowserSocketProbeWindow;
    if (runtimeWindow.__INSTAFY_SHARED_BROWSER_SOCKET_PROBE__) {
      return;
    }
    const probe = {
      collaborationEntries: [] as CollaborationSocketProbeEntry[],
      inputEntries: [] as InputSocketProbeEntry[],
      rendererEntries: [] as RendererSocketProbeEntry[],
    };
    runtimeWindow.__INSTAFY_SHARED_BROWSER_SOCKET_PROBE__ = probe;
    const NativeWebSocket = window.WebSocket;

    function ProbedWebSocket(
      this: unknown,
      url: string | URL,
      protocols?: string | string[],
    ): WebSocket {
      const socket =
        typeof protocols === "undefined"
          ? new NativeWebSocket(url)
          : new NativeWebSocket(url, protocols);
      let parsedUrl: URL | null = null;
      try {
        parsedUrl = new URL(String(url), window.location.href);
      } catch {
        // An invalid URL will be handled by the native constructor.
      }
      if (parsedUrl?.pathname.endsWith("/browser/input")) {
        const entry: InputSocketProbeEntry = {
          socket,
          ready: false,
          closed: false,
          errors: [],
          pageId: parsedUrl.searchParams.get("pageId")?.trim() || null,
          resizes: [],
        };
        probe.inputEntries.push(entry);
        const nativeSend = socket.send.bind(socket);
        socket.send = ((data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
          if (typeof data === "string") {
            try {
              const message = JSON.parse(data) as Record<string, unknown>;
              if (
                message.type === "resize" &&
                typeof message.width === "number" &&
                typeof message.height === "number" &&
                typeof message.dpr === "number"
              ) {
                entry.resizes.push({
                  width: message.width,
                  height: message.height,
                  dpr: message.dpr,
                });
              }
            } catch {
              // The native socket remains authoritative for malformed data.
            }
          }
          nativeSend(data);
        }) as WebSocket["send"];
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            return;
          }
          try {
            const message = JSON.parse(event.data) as {
              type?: unknown;
              message?: unknown;
            };
            if (message.type === "ready") {
              entry.ready = true;
            }
            if (message.type === "error" && typeof message.message === "string") {
              entry.errors.push(message.message);
            }
          } catch {
            // The probe records only the bounded JSON input protocol.
          }
        });
        socket.addEventListener("close", () => {
          entry.closed = true;
        });
      }
      if (parsedUrl?.pathname.endsWith("/browser/screencast")) {
        const entry: RendererSocketProbeEntry = {
          socket,
          closed: false,
        };
        probe.rendererEntries.push(entry);
        socket.addEventListener("close", () => {
          entry.closed = true;
        });
      }
      if (parsedUrl?.pathname.endsWith("/browser/collaboration")) {
        const entry: CollaborationSocketProbeEntry = {
          socket,
          opened: false,
          closed: false,
          participantId: null,
          receivedTypes: [],
          latestState: null,
        };
        probe.collaborationEntries.push(entry);
        socket.addEventListener("open", () => {
          entry.opened = true;
        });
        socket.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            return;
          }
          try {
            const message = JSON.parse(event.data) as Record<string, unknown>;
            const type = typeof message.type === "string" ? message.type : "";
            if (type) {
              entry.receivedTypes.push(type);
              if (entry.receivedTypes.length > 100) {
                entry.receivedTypes.shift();
              }
            }
            if (type === "welcome" && typeof message.participantId === "string") {
              entry.participantId = message.participantId.trim() || null;
            }
            if (type === "state") {
              entry.latestState = message;
            }
          } catch {
            // The production parser owns validation; this probe only retains
            // already bounded test evidence.
          }
        });
        socket.addEventListener("close", () => {
          entry.closed = true;
        });
      }
      return socket;
    }

    ProbedWebSocket.prototype = NativeWebSocket.prototype;
    Object.setPrototypeOf(ProbedWebSocket, NativeWebSocket);
    window.WebSocket = ProbedWebSocket as unknown as typeof WebSocket;
  });
}

export async function inputSocketProbeSnapshot(
  page: Page,
): Promise<InputSocketProbeSnapshot[]> {
  return page.evaluate(() => {
    const probe = (window as SharedBrowserSocketProbeWindow)
      .__INSTAFY_SHARED_BROWSER_SOCKET_PROBE__;
    return (probe?.inputEntries ?? []).map((entry) => ({
      ready: entry.ready,
      closed: entry.closed,
      open: entry.socket.readyState === WebSocket.OPEN,
      errors: [...entry.errors],
      pageId: entry.pageId,
      resizes: entry.resizes.map((resize) => ({ ...resize })),
    }));
  });
}

export async function collaborationSocketProbeSnapshot(
  page: Page,
): Promise<CollaborationSocketProbeSnapshot[]> {
  return page.evaluate(() => {
    const probe = (window as SharedBrowserSocketProbeWindow)
      .__INSTAFY_SHARED_BROWSER_SOCKET_PROBE__;
    return (probe?.collaborationEntries ?? []).map((entry) => ({
      closed: entry.closed,
      latestState: entry.latestState,
      open: entry.socket.readyState === WebSocket.OPEN,
      opened: entry.opened,
      participantId: entry.participantId,
      receivedTypes: [...entry.receivedTypes],
    }));
  });
}

export async function disruptLatestCollaborationSocket(page: Page) {
  return page.evaluate(() => {
    const entries = (window as SharedBrowserSocketProbeWindow)
      .__INSTAFY_SHARED_BROWSER_SOCKET_PROBE__?.collaborationEntries ?? [];
    const index = entries.findLastIndex(
      (entry) => !entry.closed && entry.socket.readyState === WebSocket.OPEN,
    );
    if (index < 0) {
      throw new Error("No open Shared Browser collaboration socket is available.");
    }
    const entry = entries[index];
    entry.socket.close(4001, "e2e network interruption");
    return {
      entryCount: entries.length,
      index,
      participantId: entry.participantId,
    };
  });
}

export async function disruptLatestBrowserTransportSockets(page: Page) {
  return page.evaluate(() => {
    const probe = (window as SharedBrowserSocketProbeWindow)
      .__INSTAFY_SHARED_BROWSER_SOCKET_PROBE__;
    const rendererEntries = probe?.rendererEntries ?? [];
    const inputEntries = probe?.inputEntries ?? [];
    const rendererIndex = rendererEntries.findLastIndex(
      (entry) => !entry.closed && entry.socket.readyState === WebSocket.OPEN,
    );
    const inputIndex = inputEntries.findLastIndex(
      (entry) => !entry.closed && entry.socket.readyState === WebSocket.OPEN,
    );
    if (rendererIndex < 0 || inputIndex < 0) {
      throw new Error(
        "Open Shared Browser renderer and input sockets are required for interruption.",
      );
    }
    const inputEntry = inputEntries[inputIndex];
    rendererEntries[rendererIndex].socket.close(4001, "e2e pixel interruption");
    inputEntry.socket.close(4001, "e2e input interruption");
    return {
      inputEntryCount: inputEntries.length,
      pageId: inputEntry.pageId,
      rendererEntryCount: rendererEntries.length,
    };
  });
}

export async function waitForOpenInputSocket(page: Page) {
  await expect
    .poll(async () =>
      (await inputSocketProbeSnapshot(page)).some(
        (entry) => entry.ready && entry.open && !entry.closed,
      ),
    )
    .toBe(true);
}

export async function latestOpenInputSocket(page: Page) {
  const entries = await inputSocketProbeSnapshot(page);
  return (
    [...entries]
      .reverse()
      .find((entry) => entry.ready && entry.open && !entry.closed) ?? null
  );
}

async function sendInputThroughExistingSocket(
  page: Page,
  point: { x: number; y: number },
) {
  await page.evaluate(({ x, y }) => {
    const entries = (window as SharedBrowserSocketProbeWindow)
      .__INSTAFY_SHARED_BROWSER_SOCKET_PROBE__?.inputEntries ?? [];
    const entry = [...entries]
      .reverse()
      .find(
        (candidate) =>
          candidate.ready &&
          !candidate.closed &&
          candidate.socket.readyState === WebSocket.OPEN,
      );
    if (!entry) {
      throw new Error("No open Shared Browser input socket is available.");
    }
    const common = {
      type: "mouse",
      x,
      y,
      button: "left",
      modifiers: 0,
      clickCount: 1,
    };
    entry.socket.send(
      JSON.stringify({
        ...common,
        kind: "mousePressed",
        buttons: 1,
      }),
    );
    entry.socket.send(
      JSON.stringify({
        ...common,
        kind: "mouseReleased",
        buttons: 0,
      }),
    );
  }, point);
}

function inputProbeErrorCount(entries: InputSocketProbeSnapshot[]) {
  return entries.reduce((total, entry) => total + entry.errors.length, 0);
}

function inputProbeHasOpenSocket(entries: InputSocketProbeSnapshot[]) {
  return entries.some((entry) => entry.ready && entry.open && !entry.closed);
}

export async function expectExistingInputAccepted(
  page: Page,
  point: { x: number; y: number },
) {
  const before = await inputSocketProbeSnapshot(page);
  expect(inputProbeHasOpenSocket(before)).toBe(true);
  const errorCountBefore = inputProbeErrorCount(before);
  await sendInputThroughExistingSocket(page, point);
  // Accepted CDP input is intentionally one-way. Give the origin enough time
  // to return a non-fatal authorization error if ownership changed between
  // socket setup and this exact message.
  await page.waitForTimeout(250);
  const after = await inputSocketProbeSnapshot(page);
  expect(inputProbeHasOpenSocket(after)).toBe(true);
  expect(inputProbeErrorCount(after)).toBe(errorCountBefore);
}

export async function expectExistingInputRejected(
  page: Page,
  point: { x: number; y: number },
) {
  const before = await inputSocketProbeSnapshot(page);
  expect(inputProbeHasOpenSocket(before)).toBe(true);
  const errorCountBefore = inputProbeErrorCount(before);
  await sendInputThroughExistingSocket(page, point);
  await expect
    .poll(async () => {
      const after = await inputSocketProbeSnapshot(page);
      return {
        errorCount: inputProbeErrorCount(after),
        hasOpenSocket: inputProbeHasOpenSocket(after),
        errors: after.flatMap((entry) => entry.errors).join("\n"),
      };
    })
    .toEqual({
      errorCount: errorCountBefore + CLICK_INPUT_MESSAGE_COUNT,
      hasOpenSocket: true,
      errors: expect.stringMatching(/controlled by another participant/i),
    });
}
