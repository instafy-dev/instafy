import {
  localExploreFrame,
  type LocalExploreControl,
  type LocalExploreState,
  type LocalExploreViewport,
} from "./localTabExplore";
import { localTabFrameFilter } from "./localTabFrameFilter";
type Bridge = NonNullable<Window["instafyDesktop"]>;
export function supportsLocalExplore(bridge: Bridge) {
  return Boolean(
    bridge.browserTabExploreOpen &&
      bridge.browserTabExploreRenew &&
      bridge.browserTabExploreFrame &&
      bridge.browserTabExploreResize &&
      bridge.browserTabExploreInput &&
      bridge.browserTabExploreNavigate &&
      bridge.browserTabExploreClose,
  );
}
export function localTabExplorePublisher(
  bridge: Bridge,
  ownerId: string,
  captureId: string,
  socket: WebSocket,
) {
  type LocalView = {
    viewport: LocalExploreViewport;
    confirmed: boolean;
    timer?: number;
    framing: boolean;
    shouldPublish: ReturnType<typeof localTabFrameFilter>;
  };
  const views = new Map<string, LocalView>();
  let disposed = false;
  const send = (message: unknown) => {
    if (!disposed && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  };
  const options = (viewId: string) => ({ ownerId, captureId, viewId });
  async function close(viewId: string) {
    const view = views.get(viewId);
    views.delete(viewId);
    window.clearTimeout(view?.timer);
    await bridge.browserTabExploreClose!(options(viewId)).catch(
      () => undefined,
    );
    send({ type: "exploreClose", viewId });
  }
  const control: LocalExploreControl = {
    async approve(request) {
      if (disposed) throw new Error("Tab sharing ended.");
      const { viewId } = await bridge.browserTabExploreOpen!({
        ownerId,
        captureId,
        viewport: request.viewport,
      });
      if (disposed) {
        await bridge.browserTabExploreClose!(options(viewId)).catch(
          () => undefined,
        );
        return;
      }
      const view: LocalView = {
        viewport: request.viewport,
        confirmed: false,
        framing: false,
        shouldPublish: localTabFrameFilter(),
      };
      views.set(viewId, view);
      view.timer = window.setTimeout(() => {
        if (!view.confirmed) void close(viewId);
      }, 2500);
      send({
        type: "exploreApprove",
        connectionId: request.connectionId,
        viewId,
      });
    },
    deny: (connectionId) => send({ type: "exploreDeny", connectionId }),
    close,
  };
  function state(snapshot: LocalExploreState) {
    if (disposed) return;
    for (const [viewId, local] of views) {
      const current = snapshot.views?.find((view) => view.viewId === viewId);
      if (!current) {
        if (local.confirmed) void close(viewId);
        continue;
      }
      local.confirmed = true;
      window.clearTimeout(local.timer);
      void bridge.browserTabExploreRenew!(options(viewId))
        .then((alive) => {
          if (!alive) void close(viewId);
        })
        .catch(() => close(viewId));
      if (JSON.stringify(current.viewport) !== JSON.stringify(local.viewport)) {
        local.viewport = current.viewport;
        void bridge.browserTabExploreResize!({
          ...options(viewId),
          value: current.viewport,
        }).catch(() => close(viewId));
      }
    }
    // Controller authority never creates or reopens a native view by itself.
    for (const current of snapshot.views ?? [])
      if (!views.has(current.viewId))
        send({ type: "exploreClose", viewId: current.viewId });
  }
  function input(message: {
    type?: string;
    viewId?: string;
    input?: unknown;
    action?: unknown;
  }) {
    const viewId = message.viewId;
    if (disposed || !viewId || !views.get(viewId)?.confirmed) return;
    if (message.type === "exploreInput")
      void bridge.browserTabExploreInput!({
        ...options(viewId),
        value: message.input,
      }).catch(() => close(viewId));
    if (
      message.type === "exploreNavigate" &&
      ["back", "forward", "reload"].includes(String(message.action))
    )
      void bridge.browserTabExploreNavigate!({
        ...options(viewId),
        value: message.action as "back" | "forward" | "reload",
      }).catch(() => close(viewId));
  }
  function frames() {
    for (const [viewId, view] of views) {
      if (
        disposed ||
        !view.confirmed ||
        view.framing ||
        socket.readyState !== WebSocket.OPEN ||
        socket.bufferedAmount >= 1024 * 1024
      )
        continue;
      view.framing = true;
      // Each view has at most one pending capture. A slow or navigating page
      // must not hold up the other participants' independent streams.
      void (async () => {
        try {
          const bytes = await bridge.browserTabExploreFrame!(options(viewId));
          if (
            bytes &&
            !disposed &&
            views.get(viewId) === view &&
            socket.readyState === WebSocket.OPEN &&
            socket.bufferedAmount < 1024 * 1024 &&
            view.shouldPublish(bytes)
          )
            socket.send(localExploreFrame(viewId, bytes));
        } catch {
          await close(viewId);
        } finally {
          view.framing = false;
        }
      })();
    }
  }
  let timer: number;
  const tick = () => {
    frames();
    if (!disposed) timer = window.setTimeout(tick, 200);
  };
  tick();
  return {
    control,
    state,
    input,
    dispose() {
      disposed = true;
      window.clearTimeout(timer);
      for (const id of views.keys()) void close(id);
    },
  };
}
