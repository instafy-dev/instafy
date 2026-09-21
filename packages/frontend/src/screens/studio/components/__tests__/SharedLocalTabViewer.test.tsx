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
let ended: ReturnType<typeof vi.fn<(id: string) => void>>;
const share = { id: "share", projectId: "project", ownerUserId: "owner", audience: "space", mode: "view" } as const;
const image = () => document.querySelector<HTMLImageElement>('[data-testid="local-browser-share-image"]')!;
const pan = () => document.querySelector<HTMLDivElement>('[data-testid="local-browser-share-pan"]')!;
const click = (label: string) => act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click());
async function frame() {
  await act(async () => socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array([255,216,255,217]).buffer })));
  Object.defineProperties(image(), { naturalWidth: { value: 1600, configurable: true }, naturalHeight: { value: 900, configurable: true } });
  await act(async () => image().dispatchEvent(new Event("load")));
}
async function zoom(value: string) {
  await chooseSelectValue(document.querySelector('[aria-label="Shared tab zoom"]'), value);
}
beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  socket = Object.assign(new EventTarget(), { close: vi.fn(), send: vi.fn() });
  connect = vi.fn().mockResolvedValue(socket); ended = vi.fn();
  vi.mocked(browserShareClient).mockResolvedValue({ connect } as never);
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
  expect(document.body.textContent).toContain("Sharing ended"); expect(ended).toHaveBeenCalledWith("share");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:frame-1");
});

it("requests control and forwards keys only for this connection's grant, then becomes a spectator immediately",async()=>{
  Object.assign(socket,{readyState:WebSocket.OPEN,bufferedAmount:0});await frame();
  const state={type:"controlState",available:true,connectionId:"self",requested:false,grant:null as null|{id:string;connectionId:string;userId:string}};
  const update=async()=>act(async()=>socket.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(state)})));
  const type=async()=>act(async()=>image().dispatchEvent(new KeyboardEvent("keydown",{key:"a",bubbles:true,cancelable:true})));
  await update();await type();expect(socket.send).not.toHaveBeenCalled();
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="local-tab-control-action"]')!.click());expect(socket.send).toHaveBeenLastCalledWith('{"type":"requestControl"}');
  state.grant={id:"grant",connectionId:"other-window",userId:"same-user"};await update();await type();expect(socket.send).toHaveBeenCalledTimes(1);
  state.grant.connectionId="self";await update();await type();
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({type:"input",grantId:"grant",input:{type:"text",text:"a"}});
  state.grant=null;await update();await type();expect(socket.send).toHaveBeenCalledTimes(2);
  expect(image()).not.toBeNull();expect(connect).toHaveBeenCalledTimes(1);
});

it("Explore requests owner approval, scopes frames and input, and returns to Follow without reconnecting",async()=>{
  const {localExploreFrame}=await import("../../../../services/runtimeController/localTabExplore");
  Object.assign(socket,{readyState:WebSocket.OPEN,bufferedAmount:0});await frame();
  const viewId="11111111-1111-4111-8111-111111111111";
  const state={type:"exploreState",available:true,requested:false,view:null as null|{viewId:string;connectionId:string;userId:string;viewport:{width:number;height:number;dpr:number}}};
  const update=async()=>act(async()=>socket.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(state)})));
  await update();await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="local-tab-explore-action"]')!.click());
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toMatchObject({type:"exploreRequest",viewport:{width:390,height:700}});
  state.view={viewId,connectionId:"own",userId:"viewer",viewport:{width:390,height:700,dpr:1}};await update();expect(image()).toBeNull();
  await act(async()=>socket.dispatchEvent(new MessageEvent("message",{data:new Uint8Array([255,216,255,217]).buffer})));expect(image()).toBeNull();
  await act(async()=>socket.dispatchEvent(new MessageEvent("message",{data:localExploreFrame(viewId,new Uint8Array([255,216,255,217])).buffer})));
  await act(async()=>image().dispatchEvent(new KeyboardEvent("keydown",{key:"a",bubbles:true,cancelable:true})));
  expect(JSON.parse(socket.send.mock.calls.at(-1)![0])).toEqual({type:"exploreInput",viewId,input:{type:"text",text:"a"}});
  await act(async()=>document.querySelector<HTMLButtonElement>('[data-testid="local-tab-explore-action"]')!.click());expect(socket.send).toHaveBeenLastCalledWith('{"type":"exploreReturn"}');
  state.view=null;await update();expect(image()).toBeNull();await frame();expect(image()).not.toBeNull();expect(connect).toHaveBeenCalledTimes(1);
});
