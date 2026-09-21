// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { browserShareClient, publishLocalBrowserTab } from "../runtimeController/browserShares";
import { resolveControllerRequestContext } from "../runtimeController/core";
import { controllerJsonRequest } from "../runtimeController/client";
vi.mock("../runtimeController/core", () => ({ resolveControllerRequestContext: vi.fn() }));
vi.mock("../runtimeController/client", () => ({ controllerJsonRequest: vi.fn() }));

class Socket extends EventTarget {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1; bufferedAmount = 0; binaryType = ""; sent: unknown[] = [];
  constructor(readonly url: string) {
    super(); Socket.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(value: unknown) {
    this.sent.push(value);
    if (typeof value === "string") queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: '{"type":"ready"}' })));
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
beforeEach(() => {
  Socket.instances = []; vi.stubGlobal("WebSocket", Socket);
  vi.mocked(resolveControllerRequestContext).mockResolvedValue({ baseUrl: "https://controller.example", accessToken: "test-session" } as never);
  vi.mocked(controllerJsonRequest).mockImplementation(async () => ({ success: true, value: { id: "share", projectId: "project", ownerUserId: "user", audience: "space", mode: "view" }, response: new Response() }) as never);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); delete window.instafyDesktop; });

it("keeps a static Follow stream alive with periodic images and sends changes on the next capture", async () => {
  vi.useFakeTimers();
  const frame = vi.fn().mockResolvedValue(new Uint8Array([255, 216, 1, 255, 217]));
  window.instafyDesktop = {
    notify: vi.fn(),
    browserTabShareStart: vi.fn().mockResolvedValue({ captureId: "capture" }),
    browserTabShareFrame: frame,
    browserTabShareStop: vi.fn().mockResolvedValue(undefined),
  };
  const abort = new AbortController();
  await publishLocalBrowserTab("project", "owner", abort.signal, vi.fn(), { audience: "space" });
  await vi.advanceTimersByTimeAsync(12_000);
  const images = () => Socket.instances[0].sent.filter(value => value instanceof Uint8Array);
  expect(frame).toHaveBeenCalledTimes(61);
  expect(images()).toHaveLength(7);
  const changed = new Uint8Array([255, 216, 2, 255, 217]);
  frame.mockResolvedValue(changed);
  await vi.advanceTimersByTimeAsync(200);
  expect(images()).toHaveLength(8);
  expect(images().at(-1)).toEqual(changed);
  abort.abort();
  await vi.advanceTimersByTimeAsync(12_000);
  expect(images()).toHaveLength(8);
});

it("sends identity only in the authenticated handshake and abort closes the socket", async () => {
  const client = await browserShareClient("project"); const abort = new AbortController();
  await client.connect("share", "watch", abort.signal);
  const socket = Socket.instances[0];
  expect(String(socket.url)).toBe("wss://controller.example/projects/project/browser-shares/share/watch");
  expect(socket.sent).toEqual([JSON.stringify({ accessToken: "test-session" })]);
  abort.abort(); expect(socket.readyState).toBe(3);
});

it("Stop while controller identity is resolving never starts native capture", async () => {
  let resolve!: (value: never) => void;
  vi.mocked(resolveControllerRequestContext).mockReturnValue(new Promise(r => { resolve = r; }));
  const start = vi.fn(); const ended = vi.fn();
  window.instafyDesktop = { notify: vi.fn(), browserTabShareStart: start, browserTabShareFrame: vi.fn(), browserTabShareStop: vi.fn() };
  const abort = new AbortController(); const running = publishLocalBrowserTab("project", "owner", abort.signal, ended, { audience: "space" });
  abort.abort(); resolve({ baseUrl: "https://controller.example", accessToken: "test" } as never); await running;
  expect(start).not.toHaveBeenCalled(); expect(ended).toHaveBeenCalledTimes(1);
});

it("Stop suppresses a pending native image and deletes only the created share", async () => {
  let finish!: (image: Uint8Array) => void;
  const stop = vi.fn().mockResolvedValue(undefined); const ended = vi.fn();
  window.instafyDesktop = { notify: vi.fn(), browserTabShareStart: vi.fn().mockResolvedValue({ captureId: "capture" }),
    browserTabShareFrame: vi.fn(() => new Promise<Uint8Array>(r => { finish = r; })), browserTabShareStop: stop };
  const abort = new AbortController(); await publishLocalBrowserTab("project", "owner", abort.signal, ended, { audience: "space" });
  abort.abort(); finish(new Uint8Array([255,216,255,217])); await flush();
  expect(Socket.instances[0].sent).toHaveLength(1);
  expect(stop).toHaveBeenCalledWith({ ownerId: "owner", captureId: "capture" });
  expect(vi.mocked(controllerJsonRequest).mock.calls.at(-1)?.[0]).toMatchObject({ method: "DELETE", path: "/projects/project/browser-shares/share" });
  expect(ended).toHaveBeenCalledTimes(1);
});

it("cancellation during share creation cleans its late response without opening a publisher", async () => {
  let finish!: (value: never) => void;
  vi.mocked(controllerJsonRequest).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const stop = vi.fn().mockResolvedValue(undefined);
  window.instafyDesktop = { notify: vi.fn(), browserTabShareStart: vi.fn().mockResolvedValue({ captureId: "capture" }), browserTabShareFrame: vi.fn(), browserTabShareStop: stop };
  const abort = new AbortController(); const task = publishLocalBrowserTab("project", "owner", abort.signal, vi.fn(), { audience: "space" });
  await flush(); abort.abort(); finish({ success: true, value: { id: "late" } } as never); await task;
  expect(Socket.instances).toHaveLength(0);
  expect(vi.mocked(controllerJsonRequest).mock.calls.at(-1)?.[0]).toMatchObject({ method: "DELETE", path: "/projects/project/browser-shares/late" });
});


it("preserves selected-person scope and uses exact session/person removal routes", async () => {
  const client = await browserShareClient("project");
  await client.create({ audience: "selected", viewerUserIds: ["alice"] });
  expect(vi.mocked(controllerJsonRequest).mock.calls.at(-1)?.[0]).toMatchObject({ method: "POST", body: { audience: "selected", viewerUserIds: ["alice"], mode: "view" } });
  await client.removeViewer("share", "alice");
  expect(vi.mocked(controllerJsonRequest).mock.calls.at(-1)?.[0]).toMatchObject({ method: "DELETE", path: "/projects/project/browser-shares/share/viewers/alice" });
  await client.people("a+b@example.test");
  expect(vi.mocked(controllerJsonRequest).mock.calls.at(-1)?.[0]).toMatchObject({ path: "/projects/project/browser-shares/people?q=a%2Bb%40example.test" });
});

it("grants only after native approval and blocks late input before controller revocation returns", async () => {
  const nativeControl=vi.fn().mockResolvedValue(undefined), nativeInput=vi.fn().mockResolvedValue(undefined), nativeRenew=vi.fn().mockResolvedValue(true);
  window.instafyDesktop={notify:vi.fn(),browserTabShareStart:vi.fn().mockResolvedValue({captureId:"capture"}),browserTabShareFrame:vi.fn(()=>new Promise<Uint8Array>(()=>{})),browserTabShareStop:vi.fn().mockResolvedValue(undefined),browserTabShareControl:nativeControl,browserTabShareInput:nativeInput,browserTabShareRenew:nativeRenew};
  const abort=new AbortController();const publication=await publishLocalBrowserTab("project","owner",abort.signal,vi.fn(),{audience:"space"});
  const socket=Socket.instances[0];expect(JSON.parse(socket.sent[0] as string).controlVersion).toBe(1);
  await publication!.control!.grant("viewer-connection");
  const command=JSON.parse(socket.sent.at(-1) as string);expect(command).toMatchObject({type:"grantControl",connectionId:"viewer-connection"});
  expect(nativeControl).toHaveBeenLastCalledWith({ownerId:"owner",captureId:"capture",grantId:command.grantId});
  const state={type:"controlState",available:true,connectionId:"publisher",requested:false,requests:[],grant:{id:command.grantId,connectionId:"viewer-connection",userId:"viewer"}};
  socket.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(state)}));await flush();
  const input={type:"input",grantId:command.grantId,input:{type:"text",text:"hello"}};
  socket.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(input)}));await flush();expect(nativeInput).toHaveBeenCalledTimes(1);
  let finish!:()=>void;nativeControl.mockImplementationOnce(()=>new Promise<void>(r=>{finish=r;}));
  const release=publication!.control!.revoke();
  socket.dispatchEvent(new MessageEvent("message",{data:JSON.stringify(input)}));await flush();expect(nativeInput).toHaveBeenCalledTimes(1);
  expect(JSON.parse(socket.sent.at(-1) as string).type).toBe("grantControl");
  finish();await release;expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({type:"releaseControl"});
  abort.abort();
});

it("a rejected native renewal releases controller authority rather than re-enabling it",async()=>{
  const nativeControl=vi.fn().mockResolvedValue(undefined);
  window.instafyDesktop={notify:vi.fn(),browserTabShareStart:vi.fn().mockResolvedValue({captureId:"capture"}),browserTabShareFrame:vi.fn(()=>new Promise<Uint8Array>(()=>{})),browserTabShareStop:vi.fn().mockResolvedValue(undefined),browserTabShareControl:nativeControl,browserTabShareInput:vi.fn(),browserTabShareRenew:vi.fn().mockResolvedValue(false)};
  const abort=new AbortController();const publication=await publishLocalBrowserTab("project","owner",abort.signal,vi.fn(),{audience:"space"});
  await publication!.control!.grant("connection");const socket=Socket.instances[0];const {grantId}=JSON.parse(socket.sent.at(-1) as string);
  socket.dispatchEvent(new MessageEvent("message",{data:JSON.stringify({type:"controlState",available:true,connectionId:"publisher",requested:false,grant:{id:grantId,connectionId:"connection",userId:"viewer"}})}));await flush();
  expect(nativeControl).toHaveBeenLastCalledWith({ownerId:"owner",captureId:"capture",grantId:null});
  expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({type:"releaseControl"});abort.abort();
});
