import { localTabVideoPublisher } from "./localTabVideoPublisher";
import { readLocalExploreState, type LocalExploreState, type LocalExploreControl } from "./localTabExplore";
import { localTabExplorePublisher, supportsLocalExplore } from "./localTabExplorePublisher";
import { localTabFrameFilter } from "./localTabFrameFilter";
import { localTabFrameSender, type LocalTabSocket } from "./localTabFrameSender";
import { readLocalTabControlState, type LocalTabControlState, type LocalTabPublisherControl } from "./localTabControl";
import { controllerJsonRequest } from "./client";
import { resolveControllerRequestContext } from "./core";

export type BrowserShareAudience = { audience: "space" } | { audience: "selected"; viewerUserIds: string[] };
export type BrowserShare = { id: string; projectId: string; ownerUserId: string; audience: "space" | "selected"; mode: "view" };
export type LocalTabPublication = BrowserShare & { control?: LocalTabPublisherControl; explore?: LocalExploreControl };
export type BrowserSharePerson = { userId: string; fullName: string | null; email: string | null };
export type BrowserShareViewer = BrowserSharePerson & { active: boolean; removed: boolean };

export async function browserShareClient(projectId: string) {
  const context = await resolveControllerRequestContext(null);
  const base = `/projects/${encodeURIComponent(projectId)}/browser-shares`;
  async function request<T>(path: string, method: "GET" | "POST" | "DELETE", body?: unknown) {
    const result = await controllerJsonRequest<T>({ path: base + path, method, body, requestContext: context,
      allowEmptyResponse: method === "DELETE", fallbackError: "Could not reach tab sharing." });
    if (!result.success) throw new Error(result.error);
    return result.value;
  }
  return {
    list: () => request<BrowserShare[]>("", "GET"),
    create: (audience: BrowserShareAudience) => request<BrowserShare>("", "POST", { ...audience, mode: "view" }),
    people: (query = "") => request<{ people: BrowserSharePerson[]; hasMore: boolean }>(`/people?q=${encodeURIComponent(query)}`, "GET"),
    viewers: (id: string) => request<BrowserShareViewer[]>(`/${encodeURIComponent(id)}/viewers`, "GET"),
    removeViewer: (id: string, userId: string) => request<void>(`/${encodeURIComponent(id)}/viewers/${encodeURIComponent(userId)}`, "DELETE"),
    stop: (id: string) => request<void>(`/${encodeURIComponent(id)}`, "DELETE"),
    connect: (id: string, role: "publish" | "watch", signal: AbortSignal, controlVersion?: 1, exploreVersion?: 1, videoVersion?: 1): Promise<LocalTabSocket> => new Promise((resolve, reject) => {
      if (signal.aborted || !context.accessToken) { reject(new Error("Tab sharing cancelled.")); return; }
      const url = new URL(context.baseUrl + base + `/${encodeURIComponent(id)}/${role}`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("frameFlowVersion", "1");
      if(videoVersion)url.searchParams.set("videoVersion","1");
      const socket: LocalTabSocket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      let ready = false;
      const timeout = window.setTimeout(() => fail(), 12_000);
      function abort() { socket.close(); if (!ready) fail(); }
      function fail() { window.clearTimeout(timeout); socket.close(); reject(new Error("This tab share is unavailable or has ended.")); }
      signal.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", () => {
        if (!signal.aborted) socket.send(JSON.stringify({ accessToken: context.accessToken, ...(controlVersion ? { controlVersion } : {}), ...(exploreVersion ? { exploreVersion } : {}) }));
      });
      socket.addEventListener("message", function handshake(event) {
        let message; try { message = JSON.parse(event.data); } catch { return; }
        if (message?.type === "ready") {
          socket.frameFlowVersion = message.frameFlowVersion === 1 ? 1 : undefined;
          ready = true; window.clearTimeout(timeout);
          socket.removeEventListener("message", handshake); resolve(socket);
        }
      });
      socket.addEventListener("error", () => { if (!ready) fail(); });
      socket.addEventListener("close", () => {
        signal.removeEventListener("abort", abort); if (!ready) fail();
      });
    }),
  };
}

/** Bounded capture/publish loop. Aborting closes the stream before async cleanup. */
export async function publishLocalBrowserTab(projectId: string, ownerId: string, signal: AbortSignal, onEnded: (error?: string) => void, audience: BrowserShareAudience, onControlState?: (state: LocalTabControlState) => void, onExploreState?: (state: LocalExploreState) => void): Promise<LocalTabPublication | undefined> {
  const bridge = window.instafyDesktop;
  if (!bridge?.browserTabShareStart || !bridge.browserTabShareFrame || !bridge.browserTabShareStop) throw new Error("Update Instafy Desktop to share this tab.");
  let client: Awaited<ReturnType<typeof browserShareClient>> | undefined;
  let captureId: string | undefined;
  let share: BrowserShare | undefined;
  let socket: WebSocket | undefined;
  let frames: ReturnType<typeof localTabFrameSender> | undefined;
  let video: ReturnType<typeof localTabVideoPublisher> | undefined;
  let explore: ReturnType<typeof localTabExplorePublisher> | undefined;
  let stopped = false;
  let timer: number | undefined;
  let grantTimer: number | undefined;
  let operation = 0;
  let localGrant: string | null = null;
  let pendingGrant = false;
  const controlSupported = Boolean(bridge.browserTabShareControl && bridge.browserTabShareRenew && bridge.browserTabShareInput);
  const send = (value: unknown) => { if (!stopped && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  async function revoke(notify = true) {
    operation++; localGrant = null; pendingGrant = false; window.clearTimeout(grantTimer);
    // Stop input in the local main process before waiting for the controller.
    if (captureId && controlSupported) await bridge!.browserTabShareControl!({ownerId,captureId,grantId:null});
    if (notify) send({type:"releaseControl"});
  }
  const controls: LocalTabPublisherControl = {
    async grant(connectionId) {
      if (stopped || !captureId || !controlSupported) throw new Error("Tab control is unavailable.");
      if (localGrant) throw new Error("Take back control before granting it again.");
      const generation=++operation, grantId=crypto.randomUUID();
      localGrant=grantId; pendingGrant=true;
      try {
        await bridge!.browserTabShareControl!({ownerId,captureId,grantId});
        if (stopped || operation!==generation) return;
        send({type:"grantControl",connectionId,grantId});
        grantTimer=window.setTimeout(()=>{if(localGrant===grantId && pendingGrant) void revoke().catch(()=>stop("Tab control could not be released."));},2500);
      } catch(error) { if (operation===generation) { localGrant=null; pendingGrant=false; } throw error; }
    },
    revoke: () => revoke(),
    deny: connectionId => send({type:"denyControl",connectionId}),
  };
  async function cleanup() {
    video?.dispose();
    frames?.dispose();
    explore?.dispose();
    operation++; localGrant=null; window.clearTimeout(timer); window.clearTimeout(grantTimer); socket?.close();
    if (captureId) await bridge!.browserTabShareStop!({ ownerId, captureId }).catch(() => undefined);
    if (share) await client?.stop(share.id).catch(() => undefined);
  }
  function stop(error?: string) {
    if (stopped) return;
    stopped = true; signal.removeEventListener("abort", abort); void cleanup(); onEnded(error);
  }
  const abort = () => stop();
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) { stop(); return; }
    client = await browserShareClient(projectId);
    if (stopped || signal.aborted) { stop(); return; }
    ({ captureId } = await bridge.browserTabShareStart({ ownerId }));
    if (stopped || signal.aborted) { await cleanup(); return; }
    share = await client.create(audience);
    if (stopped || signal.aborted) { await cleanup(); return; }
    socket = await client.connect(share.id, "publish", signal, controlSupported ? 1 : undefined, supportsLocalExplore(bridge) ? 1 : undefined, bridge.browserTabVideo ? 1 : undefined);
    if (stopped || signal.aborted) { await cleanup(); return; }
    frames = localTabFrameSender(socket);
    if(bridge.browserTabVideo)video=localTabVideoPublisher(bridge,ownerId,captureId!,socket);
    if (supportsLocalExplore(bridge)) explore = localTabExplorePublisher(bridge, ownerId, captureId!, socket, frames, viewId => video?.needsFrames(viewId) ?? true);
    socket.addEventListener("close", () => stop("Tab sharing ended."));
    socket.addEventListener("message", event => {
      if (stopped || typeof event.data !== "string") return;
      let message; try { message=JSON.parse(event.data); } catch { return; }
      video?.receive(message);
      const exploreState=readLocalExploreState(message);
      if (exploreState) { explore?.state(exploreState); onExploreState?.(exploreState); return; }
      explore?.input(message);
      const state=readLocalTabControlState(message);
      if (state) {
        onControlState?.(state);
        const grant=localGrant;
        if (grant && state.grant?.id===grant) {
          pendingGrant=false; window.clearTimeout(grantTimer);
          void bridge!.browserTabShareRenew!({ownerId,captureId:captureId!,grantId:grant}).then(active=>{
            if (!active && localGrant===grant) return revoke();
          }).catch(()=>{ if (localGrant===grant) void revoke().catch(()=>stop("Tab control could not be released.")); });
        } else if (grant && !pendingGrant) {
          void revoke(false).catch(()=>stop("Tab control could not be released."));
        }
      } else if (message?.type==="input" && localGrant && message.grantId===localGrant) {
        const grant=localGrant; pendingGrant=false; window.clearTimeout(grantTimer);
        void bridge!.browserTabShareInput!({ownerId,captureId:captureId!,grantId:grant,input:message.input}).catch(()=>{
          if (localGrant===grant) void revoke().catch(()=>stop("Tab control could not be released."));
        });
      }
    });
    const shouldPublish = localTabFrameFilter();
    const frame = async () => {
      if (stopped || !socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        if (socket.bufferedAmount < 1024 * 1024 && (video?.needsFrames(null) ?? true)) {
          const bytes = await bridge!.browserTabShareFrame!({ ownerId, captureId: captureId! });
          if (stopped || signal.aborted) return;
          if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 1024 * 1024 && shouldPublish(bytes)) frames!.offer("follow", bytes);
        }
        timer = window.setTimeout(() => void frame(), 200);
      } catch (error) { stop(error instanceof Error ? error.message : "Tab sharing ended."); }
    };
    void frame();
    return { ...share, ...(controlSupported ? {control:controls} : {}), ...(explore ? {explore:explore.control} : {}) };
  } catch (error) {
    stop(signal.aborted ? undefined : error instanceof Error ? error.message : "Could not share this tab.");
    await cleanup();
  }
}
