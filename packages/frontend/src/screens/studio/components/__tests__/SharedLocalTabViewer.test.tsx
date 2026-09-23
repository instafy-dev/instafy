// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chooseSelectValue } from "../../../../test-utils/select";
import { SharedLocalTabViewer } from "../SharedLocalTabViewer";
import { browserShareClient } from "../../../../services/runtimeController/browserShares";
vi.mock("../../../../services/runtimeController/browserShares", () => ({ browserShareClient: vi.fn() }));

let container: HTMLDivElement;
let root: Root;
let socket: EventTarget & { close: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
let connect: ReturnType<typeof vi.fn>;
let list: ReturnType<typeof vi.fn>;
let ended: ReturnType<typeof vi.fn<(id: string) => void>>;
const share = { id: "share", projectId: "project", ownerUserId: "owner", audience: "space", mode: "view" } as const;
const image = () => document.querySelector<HTMLImageElement>('[data-testid="local-browser-share-image"]')!;
const pan = () => document.querySelector<HTMLDivElement>('[data-testid="local-browser-share-pan"]')!;
const press = (label: string) => act(async () => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());
async function click(label: string) {
  if (["Expand shared tab", "Minimize shared tab"].includes(label)) await press("Shared tab options");
  await press(label);
}
async function exploreAction() {
  await press("Choose shared tab view");
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="local-tab-explore-action"]')!.click());
}
async function frame() {
  await act(async () => socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([255,216,255,217]).buffer })));
  Object.defineProperties(image(), { naturalWidth: { value: 1600, configurable: true }, naturalHeight: { value: 900, configurable: true } });
  await act(async () => image().dispatchEvent(new Event("load")));
}
async function zoom(value: string) {
  await press("Shared tab options");
  await chooseSelectValue(document.querySelector('[aria-label="Shared tab zoom"]'), value);
  await press("Shared tab options");
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  socket = Object.assign(new EventTarget(), { close: vi.fn(), send: vi.fn() });
  connect = vi.fn().mockResolvedValue(socket); ended = vi.fn();
  list = vi.fn().mockResolvedValue([share]);
  vi.mocked(browserShareClient).mockResolvedValue({ connect, list } as never);
  let sequence = 0;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: vi.fn(() => `blob:frame-${++sequence}`), revokeObjectURL: vi.fn() }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x:0, y:0, left:0, top:0, right:390, bottom:700, width:390, height:700, toJSON: () => ({}) });
  await act(async () => root.render(<SharedLocalTabViewer projectId="project" share={share} onClose={vi.fn()} onEnded={ended} />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("fits the frame, then preserves local zoom/pan across new frames without sending page input", async () => {
  await frame(); expect(image().style.width).toBe("390px");
  await zoom("1"); expect(image().style.width).toBe("1600px");
  pan().scrollLeft = 250; pan().scrollTop = 80;
  await act(async () => pan().dispatchEvent(new Event("scroll", { bubbles: true })));
  await frame(); expect(pan().scrollLeft).toBe(250); expect(pan().scrollTop).toBe(80);
  expect(image().style.width).toBe("1600px"); expect(socket.send).not.toHaveBeenCalled();
  await zoom("fit"); expect(pan().scrollLeft).toBe(0); expect(image().style.width).toBe("390px");
});

it("acknowledges each negotiated frame only after decoding, including discarded old-view frames", async () => {
  Object.assign(socket, { frameFlowVersion: 1, readyState: WebSocket.OPEN });
  await act(async () => socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([255,216,255,217]).buffer })));
  expect(socket.send).not.toHaveBeenCalled();
  await act(async () => image().dispatchEvent(new Event("load")));
  expect(socket.send).toHaveBeenCalledTimes(1);
  expect(socket.send).toHaveBeenLastCalledWith('{"type":"frameAck"}');
  await act(async () => image().dispatchEvent(new Event("load")));
  expect(socket.send).toHaveBeenCalledTimes(1);
  await act(async () => socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([0]).buffer })));
  expect(socket.send).toHaveBeenCalledTimes(2);
});

it("expands and minimizes without reconnecting or ending the session", async () => {
  await frame(); await click("Expand shared tab");
  expect(document.querySelector('[role="dialog"][aria-label="Shared browser tab"]')).not.toBeNull();
  await zoom("1.5"); await frame(); expect(image().style.width).toBe("2400px");
  await click("Minimize shared tab");
  expect(container.querySelector("img")).not.toBeNull();
  expect(connect).toHaveBeenCalledTimes(1); expect(connect).toHaveBeenCalledWith("share", "watch", expect.any(AbortSignal));
  expect(socket.close).not.toHaveBeenCalled(); expect(ended).not.toHaveBeenCalled();
});

it("clears an expanded, zoomed frame immediately when access is revoked", async () => {
  await frame(); await click("Expand shared tab"); await zoom("2");
  await act(async () => socket.dispatchEvent(new Event("close")));
  expect(document.querySelector('[data-testid="local-browser-share-image"]')).toBeNull();
  expect(document.body.textContent).toContain("Connection closed"); expect(ended).not.toHaveBeenCalled();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame-1");
});

it("reconnects as a viewer without restoring input authority or accepting late events from the old socket", async () => {
  Object.assign(socket, { readyState: WebSocket.OPEN, bufferedAmount: 0 });
  const grant = JSON.stringify({ type: "controlState", available: true, connectionId: "old",
    requested: false, grant: { id: "grant", connectionId: "old", userId: "viewer" } });
  await frame();
  await act(async () => socket.dispatchEvent(new MessageEvent("message", { data: grant })));
  await click("Expand shared tab");
  const oldSocket = socket;
  await act(async () => oldSocket.dispatchEvent(new Event("close")));
  socket = Object.assign(new EventTarget(), { close: vi.fn(), send: vi.fn(), readyState: WebSocket.OPEN, bufferedAmount: 0 });
  connect.mockResolvedValue(socket);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="local-tab-reconnect"]')!.click());
  expect(list).toHaveBeenCalledTimes(1);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(connect.mock.calls[0][2].aborted).toBe(true);
  await frame();
  await act(async () => {
    oldSocket.dispatchEvent(new MessageEvent("message", { data: grant }));
    oldSocket.dispatchEvent(new Event("close"));
    image().dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true }));
  });
  expect(image()).not.toBeNull();
  expect(socket.send).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("View only");
  expect(document.querySelector('[role="dialog"][aria-label="Shared browser tab"]')).not.toBeNull();
  expect(ended).not.toHaveBeenCalled();
});

it("only retires a share when a fresh authorized listing confirms it is gone", async () => {
  await frame();
  await act(async () => socket.dispatchEvent(new Event("close")));
  list.mockRejectedValueOnce(new Error("offline"));
  const reconnect = () => act(async () => document.querySelector<HTMLButtonElement>('[data-testid="local-tab-reconnect"]')!.click());
  await reconnect();
  expect(ended).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Check your connection");
  list.mockResolvedValue([]);
  await reconnect();
  expect(ended).toHaveBeenCalledWith("share");
  expect(connect).toHaveBeenCalledTimes(1);
  expect(image()).toBeNull();
  expect(document.body.textContent).toContain("Sharing ended or access was removed");
  expect(document.querySelector('[data-testid="local-tab-reconnect"]')).toBeNull();
});

it("keeps the expanded viewer inside the phone's visible area when the keyboard opens", async () => {
  const viewport = Object.assign(new EventTarget(), { height: 700, offsetTop: 0 });
  vi.stubGlobal("visualViewport", viewport);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  await frame(); await click("Expand shared tab");
  const expanded = document.querySelector<HTMLElement>('[data-testid="local-browser-share-expanded"]')!;
  expect(expanded.style.height).toBe("700px");
  viewport.height = 360; viewport.offsetTop = 20;
  await act(async () => {
    viewport.dispatchEvent(new Event("resize"));
    frames.splice(0).forEach(callback => callback(0));
  });
  expect(expanded.style.height).toBe("360px");
  expect(expanded.style.top).toBe("20px");
  await frame();
  expect(image()).not.toBeNull();
  expect(connect).toHaveBeenCalledTimes(1);
  expect(socket.close).not.toHaveBeenCalled();
  viewport.height = 700; viewport.offsetTop = 0;
  await act(async () => {
    viewport.dispatchEvent(new Event("resize"));
    frames.splice(0).forEach(callback => callback(0));
  });
  expect(expanded.style.height).toBe("700px");
});

it("reserves the mobile input bar without losing typing focus or the release action", async () => {
  await frame();
  await act(async () => socket.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
    type: "controlState", available: true, connectionId: "own", requested: false,
    grant: { id: "grant", connectionId: "own", userId: "viewer" },
  }) })));
  await click("Expand shared tab");
  vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
    const keyboard = this.dataset.testid === "shared-browser-mobile-keyboard";
    return { x: 0, y: keyboard ? 635 : 0, left: 0, top: keyboard ? 635 : 0,
      right: 390, bottom: 700, width: 390, height: keyboard ? 65 : 700, toJSON: () => ({}) };
  });
  await click("Open remote keyboard");
  const input = document.querySelector('[aria-label="Type into the focused page field"]');
  const panel = document.querySelector<HTMLElement>('[data-testid="local-browser-share-viewer"]')!;
  expect(panel.style.paddingBottom).toBe("65px");
  expect(document.querySelector('[aria-label="Shared tab zoom"]')).toBeNull();
  expect(document.querySelector('[data-testid="local-tab-control-action"]')?.getAttribute("aria-label")).toBe("Release control");
  await frame();
  expect(document.activeElement).toBe(input);
  await click("Close remote keyboard");
  expect(panel.style.paddingBottom).toBe("0px");
  expect(document.querySelector('button[aria-label="Shared tab options"]')).not.toBeNull();
});

it("requests control and forwards keys only for this connection's grant, then becomes a spectator immediately",async()=>{
  Object.assign(socket,{readyState:WebSocket.OPEN,bufferedAmount:0});await frame();
  const state={type:"controlState",available:true,connectionId:"self",requested:false,grant:null as null|{id:string;connectionId:string;userId:string}};
  const update=async()=>act(async()=>socket.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(state)})));
  const type=async()=>act(async()=>image().dispatchEvent(new KeyboardEvent("keydown",{key:"a",bubbles:true,cancelable:true})));
  await update();await type();expect(socket.send).not.toHaveBeenCalled();
  await press("Shared tab options");
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="local-tab-control-action"]')!.click());expect(socket.send).toHaveBeenLastCalledWith('{"type":"requestControl"}');
  state.grant={id:"grant",connectionId:"other-window",userId:"same-user"};await update();await type();expect(socket.send).toHaveBeenCalledTimes(1);
  state.grant.connectionId="self";await update();await type();
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({type:"input",grantId:"grant",input:{type:"text",text:"a"}});
  state.grant=null;await update();await type();expect(socket.send).toHaveBeenCalledTimes(2);
  expect(image()).not.toBeNull();expect(connect).toHaveBeenCalledTimes(1);
});

it("discards batched scroll input when the connection receives a different grant", async () => {
  Object.assign(socket, { readyState: WebSocket.OPEN, bufferedAmount: 0 });
  await frame();
  const grant = (id: string) => new MessageEvent("message", { data: JSON.stringify({
    type: "controlState", available: true, connectionId: "self", requested: false,
    grant: { id, connectionId: "self", userId: "viewer" },
  }) });
  await act(async () => socket.dispatchEvent(grant("old")));
  vi.useFakeTimers();
  try {
    await act(async () => {
      image().dispatchEvent(new WheelEvent("wheel", {
        clientX: 100, clientY: 100, deltaY: 20, bubbles: true, cancelable: true,
      }));
      socket.dispatchEvent(grant("new"));
    });
    await act(async () => vi.advanceTimersByTime(20));
    expect(socket.send).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

it("Explore requests owner approval, scopes frames and input, and returns to Follow without reconnecting",async()=>{
  const {localExploreFrame}=await import("../../../../services/runtimeController/localTabExplore");
  Object.assign(socket,{readyState:WebSocket.OPEN,bufferedAmount:0});await frame();
  const viewId="11111111-1111-4111-8111-111111111111";
  const state={type:"exploreState",available:true,requested:false,view:null as null|{viewId:string;connectionId:string;userId:string;viewport:{width:number;height:number;dpr:number}}};
  const update=async()=>act(async()=>socket.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(state)})));
  await update();await exploreAction();
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({type:"exploreRequest",viewport:{width:390,height:700}});
  state.view={viewId,connectionId:"own",userId:"viewer",viewport:{width:390,height:700,dpr:1}};await update();expect(image()).toBeNull();
  await act(async()=>socket.dispatchEvent(new MessageEvent("message",{data:new Uint8Array([255,216,255,217]).buffer})));expect(image()).toBeNull();
  await act(async()=>socket.dispatchEvent(new MessageEvent("message",{data:localExploreFrame(viewId,new Uint8Array([255,216,255,217])).buffer})));
  await act(async()=>image().dispatchEvent(new KeyboardEvent("keydown",{key:"a",bubbles:true,cancelable:true})));
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({type:"exploreInput",viewId,input:{type:"text",text:"a"}});
  await exploreAction();expect(socket.send).toHaveBeenLastCalledWith('{"type":"exploreReturn"}');
  state.view=null;await update();expect(image()).toBeNull();await frame();expect(image()).not.toBeNull();expect(connect).toHaveBeenCalledTimes(1);
});

it("opens view choices without requesting authority or reconnecting, and restores focus on Escape", async () => {
  await frame();
  const trigger = document.querySelector<HTMLButtonElement>('[data-testid="local-tab-view-mode"]')!;
  await press("Choose shared tab view");
  expect(document.querySelector('[role="dialog"][aria-label="Shared tab view"]')?.textContent).toContain("this browser’s website logins and saved data");
  expect(socket.send).not.toHaveBeenCalled();
  await act(async () => {
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-label="Shared tab view"]')!;
    dialog.focus();
    dialog.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape",bubbles:true,cancelable:true}));
  });
  expect(document.querySelector('[role="dialog"][aria-label="Shared tab view"]')).toBeNull();
  expect(connect).toHaveBeenCalledTimes(1);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});


it("shows pending browsing and control requests in the compact toolbar without implying approval", async () => {
  await frame();
  const label = () => document.querySelector('[data-testid="local-tab-view-mode"]')?.textContent;
  const update = async (state: object) => act(async () => socket.dispatchEvent(new MessageEvent("message", {data:JSON.stringify(state)})));
  expect(label()).toBe("Following");
  await update({type:"controlState",available:true,connectionId:"own",requested:true,grant:null});
  expect(label()).toBe("Control requested");
  expect(document.querySelector('[aria-label="Release control"]')).toBeNull();
  await update({type:"controlState",available:true,connectionId:"own",requested:false,grant:null});
  expect(label()).toBe("Following");
  await update({type:"exploreState",available:true,requested:true,view:null});
  expect(label()).toBe("Browse requested");
  await update({type:"exploreState",available:true,requested:false,view:{viewId:"11111111-1111-4111-8111-111111111111",connectionId:"own",userId:"viewer",viewport:{width:390,height:700,dpr:1}}});
  expect(label()).toBe("Browsing");
  await press("Choose shared tab view");
  const description = document.querySelector('[role="dialog"][aria-label="Shared tab view"]')?.textContent;
  expect(description).toContain("Website logins and saved data are shared");
  expect(description).toContain("behavior depends on the website");
  expect(document.querySelectorAll('[data-testid="local-tab-toolbar"]')).toHaveLength(1);
});


it("shows the edge cue while following, clears it for self control, independent browsing and disconnect", async () => {
  const cue = () => document.querySelector('[data-testid="browser-agent-surface"]');
  const state = (value: unknown) => act(async () => socket.dispatchEvent(new MessageEvent("message", {data: JSON.stringify(value)})));
  const control = {type:"controlState",available:true,connectionId:"self",requested:false,grant:null};
  expect(cue()).toBeNull();
  await frame();
  expect(cue()?.textContent).toContain("Another participant has control");
  expect(cue()?.querySelector("button")).toBeNull(); // Following must still allow local pan/zoom.
  await state({...control,grant:{id:"other-grant",connectionId:"other",userId:"other"}});
  expect(cue()).not.toBeNull();
  await state({...control,grant:{id:"own-grant",connectionId:"self",userId:"me"}});
  expect(cue()).toBeNull();
  await state(control);
  expect(cue()).not.toBeNull();
  await state({type:"exploreState",available:true,requested:false,view:{viewId:"11111111-1111-4111-8111-111111111111",connectionId:"self",userId:"me",viewport:{width:390,height:700,dpr:1}}});
  expect(cue()).toBeNull();
  await state({type:"exploreState",available:true,requested:false,view:null});
  await frame();
  expect(cue()).not.toBeNull();
  await act(async () => socket.dispatchEvent(new Event("close")));
  expect(cue()).toBeNull();
});
