import { RemoteControlSurface } from "./RemoteControlSurface";
import { localTabVideoViewer } from "../../../services/runtimeController/localTabVideoViewer";
import { readLocalExploreState, readLocalTabFrame, type LocalExploreState } from "../../../services/runtimeController/localTabExplore";
import { attachRemoteBrowserInput, type RemoteBrowserInputMessage } from "./remoteBrowserInput";
import { localTabInput } from "./localTabInput";
import { RemoteBrowserMobileKeyboard } from "./RemoteBrowserMobileKeyboard";
import { useExpandedBrowserViewport } from "./useExpandedBrowserViewport";
import { readLocalTabControlState, type LocalTabControlState } from "../../../services/runtimeController/localTabControl";
import { useCallback, useEffect, useRef, useState } from "react";
import { MoreHoriz, NavArrowDown, NavArrowLeft, Xmark } from "iconoir-react";
import { BrowserToolsPopover } from "./BrowserToolsPopover";
import { Button, IconButton } from "../../../components/Button";
import { Select } from "../../../components/Select";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { browserShareClient, type BrowserShare } from "../../../services/runtimeController/browserShares";

export function SharedLocalTabViewer({ projectId, share, onClose, onEnded }: { projectId: string; share: BrowserShare; onClose: () => void; onEnded: (id: string) => void }) {
  const [videoStream,setVideoStream]=useState<MediaStream|null>(null);
  const [videoReady,setVideoReady]=useState(false);
  const [videoElement,setVideoElement]=useState<HTMLVideoElement|null>(null);
  const videoRef=useRef<ReturnType<typeof localTabVideoViewer>|null>(null);
  useEffect(()=>{
    if(!videoElement)return;
    videoElement.srcObject=videoStream;
    if(videoStream)void videoElement.play().catch(()=>{});
    return ()=>{videoElement.srcObject=null;};
  },[videoElement,videoStream]);
  const [image, setImage] = useState<string | null>(null);
  const [state, setState] = useState("Connecting…");
  const [canReconnect, setCanReconnect] = useState(false);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [explore,setExplore] = useState<LocalExploreState | null>(null);
  const exploreRef = useRef(explore); exploreRef.current = explore;
  const exploring = Boolean(explore?.view);
  const [control,setControl]=useState<LocalTabControlState|null>(null);
  const controlRef=useRef(control); controlRef.current=control;
  const socketRef=useRef<WebSocket|null>(null);
  const acknowledgeFrame = useRef<(() => void) | null>(null);
  const [surface,setSurface]=useState<HTMLDivElement|null>(null);
  const [panOnly,setPanOnly]=useState(false);
  const panRef=useRef(panOnly); panRef.current=panOnly;
  const selfControls=Boolean(control?.grant && control.grant.connectionId===control.connectionId);
  const command=useCallback((type:string, fields:Record<string,unknown>={})=>{const socket=socketRef.current;if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type,...fields}));},[]);
  const sendInput=useCallback((message:RemoteBrowserInputMessage)=>{
    const current=controlRef.current, socket=socketRef.current;
    const view=exploreRef.current?.view;
    if (view) {
      if (panRef.current || socket?.readyState !== WebSocket.OPEN) return;
      if (message.type === "key" && message.key === "Escape" && message.kind !== "keyUp") { command("exploreReturn"); return; }
      const input = localTabInput(message);
      if (input && socket.bufferedAmount < 64*1024) command("exploreInput", {viewId:view.viewId, input});
      return;
    }
    if(!current?.grant || current.grant.connectionId!==current.connectionId || panRef.current || socket?.readyState!==WebSocket.OPEN) return;
    if(message.type==="key" && message.key==="Escape" && message.kind!=="keyUp") { command("releaseControl");return; }
    const input=localTabInput(message);
    if(input && socket.bufferedAmount<64*1024)socket.send(JSON.stringify({type:"input",grantId:current.grant.id,input}));
  },[command]);
  useEffect(()=>{
    if(!surface)return;
    // Rebinding discards gestures queued for the previous view or control grant.
    return attachRemoteBrowserInput(surface,{
      enabled:()=>Boolean((exploreRef.current?.view || (controlRef.current?.grant && controlRef.current.grant.connectionId===controlRef.current.connectionId)) && !panRef.current),
      getViewport:()=>({width:1,height:1,dpr:1,deviceWidth:1,deviceHeight:1}),
      send:sendInput,
    }).dispose;
  },[surface,sendInput,explore?.view?.viewId,control?.grant?.id]);
  useEffect(() => {
    const abort = new AbortController();
    setState("Connecting…");
    setCanReconnect(false);
    setPanOnly(false);
    setZoom("fit");
    let imageUrl: string | null = null;
    let stalled: number | undefined;
    function clear() { videoRef.current?.dispose();videoRef.current=null;setVideoStream(null);setVideoReady(false);acknowledgeFrame.current?.(); setExplore(null); exploreRef.current=null; setControl(null); controlRef.current=null; if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null; setImage(null); }
    void browserShareClient(projectId).then(async client => {
      if (abort.signal.aborted) return null;
      if (connectionAttempt > 0 && !(await client.list()).some(entry => entry.id === share.id)) {
        if (!abort.signal.aborted) { setState("Sharing ended or access was removed."); onEnded(share.id); }
        return null;
      }
      return typeof RTCPeerConnection!=="undefined" ? client.connect(share.id,"watch",abort.signal,undefined,undefined,1) : client.connect(share.id,"watch",abort.signal);
    }).then(socket => {
      if (!socket) return;
      if (abort.signal.aborted) { socket.close(); return; }
      socketRef.current=socket;
      if(typeof RTCPeerConnection!=="undefined")videoRef.current=localTabVideoViewer(socket,stream=>{
        if(abort.signal.aborted || socketRef.current !== socket)return;
        setVideoStream(stream);setVideoReady(false);
      });
      const armStall = (timeout = 10_000) => {
        window.clearTimeout(stalled);
        stalled = window.setTimeout(() => { if(videoRef.current?.playing){armStall();return;} clear(); socket.close(); }, timeout);
      };
      armStall();
      socket.addEventListener("message", event => {
        if (abort.signal.aborted || socketRef.current !== socket) return;
        if (typeof event.data === "string") {
          try {
            const value=JSON.parse(event.data), independent=readLocalExploreState(value);
            videoRef.current?.receive(value);
            if (independent) {
              const changed=independent.view?.viewId !== exploreRef.current?.view?.viewId;
              exploreRef.current=independent; setExplore(independent);
              if (changed) {
                videoRef.current?.setView(independent.view?.viewId ?? null);
                acknowledgeFrame.current?.();
                if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=null;setImage(null);setPanOnly(false);setZoom("fit");
                // A new native page may take up to 15 seconds to load its first image.
                armStall(independent.view ? 20_000 : 10_000);
              }
              return;
            }
            const next=readLocalTabControlState(value); if(next) { controlRef.current=next; setControl(next); } } catch { /* Ignore unknown protocol messages. */ }
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        const acknowledge = () => {
          acknowledgeFrame.current = null;
          if (socket.frameFlowVersion === 1 && socket.readyState === WebSocket.OPEN)
            socket.send('{"type":"frameAck"}');
        };
        if(videoRef.current?.playing){acknowledge();return;}
        const bytes=readLocalTabFrame(event.data,exploreRef.current?.view?.viewId ?? null);
        if (!bytes) { acknowledge(); return; }
        acknowledgeFrame.current = acknowledge;
        armStall();
        const previous = imageUrl;
        imageUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
        setImage(imageUrl); setState("Live tab from a desktop · View only");
        if (previous) URL.revokeObjectURL(previous);
      });
      socket.addEventListener("close", () => {
        if (abort.signal.aborted) return;
        window.clearTimeout(stalled); socketRef.current=null; clear();
        setState("Connection closed. Reconnect to check this share."); setCanReconnect(true);
      });
    }).catch(() => { if (!abort.signal.aborted) { clear(); setState("Could not connect. Check your connection and try again."); setCanReconnect(true); } });
    return () => { abort.abort(); videoRef.current?.dispose();videoRef.current=null;acknowledgeFrame.current=null; socketRef.current=null; controlRef.current=null; exploreRef.current=null; window.clearTimeout(stalled); if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [projectId, share.id, onEnded, connectionAttempt]);
  const [modeOpen, setModeOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const expandedViewportStyle = useExpandedBrowserViewport(fullscreen);
  const [keyboardOccupiedHeight, setKeyboardOccupiedHeight] = useState(0);
  const [zoom, setZoom] = useState("fit");
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!viewport) return;
    const measure = () => {
      const { width, height } = viewport.getBoundingClientRect();
      setBounds(current => current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [viewport]);
  const viewerViewport = useCallback(() => ({ width: Math.min(1920,Math.max(240,Math.floor(bounds.width || 390))), height: Math.min(1440,Math.max(160,Math.floor(bounds.height || 500))), dpr: Math.min(3,Math.max(1,window.devicePixelRatio || 1)) }), [bounds.width,bounds.height]);
  useEffect(() => {
    const viewId = explore?.view?.viewId;
    if (!viewId || !bounds.width || !bounds.height) return;
    const timer = window.setTimeout(() => command("exploreResize",{viewId,viewport:viewerViewport()}),150);
    return () => window.clearTimeout(timer);
  },[explore?.view?.viewId,bounds.width,bounds.height,viewerViewport,command]);
  useEffect(()=>{videoRef.current?.setViewport(viewerViewport());},[viewerViewport]);
  const hasPicture=Boolean(image || videoReady);
  const fit = imageSize.width && imageSize.height && bounds.width && bounds.height
    ? Math.min(bounds.width / imageSize.width, bounds.height / imageSize.height) : 1;
  const scale = zoom === "fit" ? fit : Number(zoom);
  const width = imageSize.width ? imageSize.width * scale : undefined;
  const height = imageSize.height ? imageSize.height * scale : undefined;
  const inlineHeight = Math.max(160, bounds.width && imageSize.width ? bounds.width * imageSize.height / imageSize.width : 240);
  const panel = <section aria-label="Shared local browser tab" className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden border border-slate-300 bg-slate-950 ${fullscreen ? "h-full border-0" : "rounded-lg"}`} style={{ paddingBottom: keyboardOccupiedHeight }} data-testid="local-browser-share-viewer">
    <div role="toolbar" aria-label="Shared tab controls" data-testid="local-tab-toolbar" className="flex h-14 shrink-0 items-center gap-1 bg-slate-100 px-1.5 text-xs text-slate-800 dark:bg-slate-900 dark:text-slate-100">
      {exploring ? <IconButton className="!h-11 !w-11 shrink-0" variant="ghost" aria-label="Back in your browsing page" onPress={() => command("exploreNavigate", {viewId:explore!.view!.viewId,action:"back"})}><NavArrowLeft aria-hidden="true" className="h-5 w-5" /></IconButton> : null}
      <BrowserToolsPopover label="Shared tab view" isOpen={modeOpen} onOpenChange={setModeOpen} trigger={
        <Button variant="ghost" className="!h-11 min-w-0 gap-1" aria-label="Choose shared tab view" data-testid="local-tab-view-mode">
          <span className="truncate">{exploring ? "Browsing" : selfControls ? "You control" : explore?.requested ? "Browse requested" : control?.requested ? "Control requested" : "Following"}</span><NavArrowDown aria-hidden="true" className="h-4 w-4 shrink-0" />
        </Button>
      }>
        <p className="font-medium">{exploring ? "Browsing independently" : selfControls ? "Controlling the shared tab" : "Following the shared tab"}</p>
        <p className="text-xs text-slate-500">{exploring ? "Your page and scroll are separate. Website logins and saved data are shared. Reload to see others’ changes; behavior depends on the website." : "Watch the owner’s page, or ask to browse with your own page and scroll. Independent browsing shares this browser’s website logins and saved data."}</p>
        {explore?.available ? <Button size="sm" variant="secondary" data-testid="local-tab-explore-action" isDisabled={!exploring && selfControls} onPress={() => { command(exploring || explore.requested ? "exploreReturn" : "exploreRequest", exploring || explore.requested ? {} : {viewport:viewerViewport()}); setModeOpen(false); }}>{exploring ? "Follow owner again" : explore.requested ? "Cancel browsing request" : "Browse independently"}</Button> : null}
      </BrowserToolsPopover>
      <span role="status" className="sr-only">{exploring ? "Browsing independently · Shared website session" : hasPicture && selfControls ? "Live tab · You control" : hasPicture && control?.grant ? "Live tab · Another participant controls" : state}</span>
      <div className="flex-1" />
      {selfControls && !exploring ? <Button size="sm" className="!h-11 shrink-0" variant="secondary" data-testid="local-tab-control-action" aria-label="Release control" onPress={() => command("releaseControl")}>Release</Button> : null}
      <RemoteBrowserMobileKeyboard inlineTrigger enabled={(selfControls || exploring) && !panOnly && hasPicture} onMessage={sendInput} onOccupiedHeightChange={setKeyboardOccupiedHeight} />
      <BrowserToolsPopover label="Shared tab options" isOpen={toolsOpen} onOpenChange={setToolsOpen} trigger={
        <IconButton className="!h-11 !w-11 shrink-0" variant="ghost" aria-label="Shared tab options"><MoreHoriz aria-hidden="true" className="h-5 w-5" /></IconButton>
      }>
        <Select aria-label="Shared tab zoom" value={zoom} disabled={!hasPicture} size="sm" onChange={event => {
          setZoom(event.target.value);
          if (viewport) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
        }}>
          <option value="fit">Fit to view</option><option value="1">100% · Read size</option><option value="1.5">150%</option><option value="2">200%</option>
        </Select>
        <div className="flex flex-col items-stretch gap-1">
          <Button size="sm" variant="ghost" onPress={() => { setToolsOpen(false); setFullscreen(current => !current); }} aria-label={fullscreen ? "Minimize shared tab" : "Expand shared tab"}>{fullscreen ? "Minimize" : "Expand"}</Button>
          {exploring ? <Button size="sm" variant="ghost" aria-label="Reload your browsing page" onPress={() => { command("exploreNavigate",{viewId:explore!.view!.viewId,action:"reload"}); setToolsOpen(false); }}>Reload</Button> : null}
          {!exploring && !selfControls && hasPicture && control?.available ? <Button size="sm" variant="ghost" data-testid="local-tab-control-action" onPress={() => { command(control.requested ? "releaseControl" : "requestControl"); setToolsOpen(false); }}>{control.requested ? "Cancel control request" : "Request control"}</Button> : null}
          {selfControls || exploring ? <Button size="sm" variant="ghost" aria-pressed={panOnly} onPress={() => { setPanOnly(current => !current); setToolsOpen(false); }}>{panOnly ? "Control page" : "Pan view"}</Button> : null}
        </div>
        <p className="text-xs text-slate-500">{exploring ? "Your page and scroll are separate. Website logins and saved data are shared. Reload to see others’ changes; behavior depends on the website." : selfControls ? "You can click and type using the owner’s account. Release returns control to the owner." : "You are viewing the shared page. Request control to click and type using the owner’s account."}</p>
      </BrowserToolsPopover>
      <IconButton className="!h-11 !w-11 shrink-0" variant="ghost" aria-label="Leave shared tab" onPress={onClose}><Xmark aria-hidden="true" className="h-5 w-5" /></IconButton>
    </div>
    {!hasPicture ? <div className="flex items-center justify-between gap-2 p-3 text-xs text-slate-300"><span>{state}</span>{canReconnect ? <Button size="sm" variant="secondary" data-testid="local-tab-reconnect" onPress={() => { setCanReconnect(false); setConnectionAttempt(attempt => attempt + 1); }}>Reconnect</Button> : null}</div> : null}
    <div className={`relative min-h-0 min-w-0 ${fullscreen ? "flex flex-1 flex-col" : ""}`}>
    <div ref={setViewport} tabIndex={hasPicture ? 0 : undefined} role="region" aria-label="Shared tab image viewport" data-testid="local-browser-share-pan"
      className={`relative min-h-0 min-w-0 overflow-auto overscroll-contain ${fullscreen ? "flex-1" : ""}`}
      style={fullscreen ? undefined : { height: exploring ? "min(55vh,480px)" : hasPicture ? inlineHeight : 0, maxHeight: "55vh" }}>
      {image || videoStream ? <div className="grid min-h-full min-w-full place-items-center" style={{ width, height }}>
        <div ref={setSurface} tabIndex={(selfControls || exploring) && !panOnly ? 0 : -1}
          className="relative select-none [-webkit-touch-callout:none] [-webkit-user-drag:none]"
          style={{width,height,touchAction:(selfControls || exploring) && !panOnly ? "none" : "auto"}}>
          {image && !videoReady ? <img alt="Live shared browser tab" src={image} className="block max-w-none select-none [-webkit-touch-callout:none] [-webkit-user-drag:none]" style={{width,height}} draggable={false} data-testid="local-browser-share-image"
            onLoad={event=>{acknowledgeFrame.current?.();if(videoRef.current?.playing)return;const img=event.currentTarget;setImageSize(current=>current.width===img.naturalWidth && current.height===img.naturalHeight ? current : {width:img.naturalWidth,height:img.naturalHeight});}} /> : null}
          {videoStream ? <video ref={setVideoElement} autoPlay muted playsInline aria-label="Live shared browser tab"
            className={videoReady ? "block max-w-none" : "absolute inset-0 opacity-0"} style={{width,height}} data-testid="local-browser-share-video"
            onLoadedData={event=>{if(event.currentTarget.srcObject!==videoStream || !videoRef.current?.decoded(videoStream))return;acknowledgeFrame.current?.();setVideoReady(true);setState("Live tab from a desktop · View only");const v=event.currentTarget;setImageSize({width:v.videoWidth,height:v.videoHeight});}}
            onResize={event=>{const v=event.currentTarget;if(videoRef.current?.playing && v.srcObject===videoStream && v.videoWidth && v.videoHeight)setImageSize(current=>current.width===v.videoWidth && current.height===v.videoHeight ? current : {width:v.videoWidth,height:v.videoHeight});}} /> : null}
        </div>
      </div> : null}
    </div>
    {hasPicture && !selfControls && !exploring ? <RemoteControlSurface controller="Another participant" working /> : null}
    </div>
  </section>;
  // Moving the presentation into a dialog keeps this component's socket alive.
  // Zoom and native overflow change only the local image, never the host page.
  return fullscreen ? <StudioDialogModal isOpen onOpenChange={setFullscreen} isDismissable dialogAriaLabel="Shared browser tab"
    data-testid="local-browser-share-expanded" style={expandedViewportStyle}
    className="!items-stretch !justify-stretch !p-0" modalClassName="!h-full !w-screen !max-w-none !rounded-none !border-0 !shadow-none !overflow-hidden"
    dialogClassName="h-full min-h-0 pt-[var(--instafy-safe-area-inset-top)] pb-[var(--instafy-safe-area-inset-bottom)] pl-[var(--instafy-safe-area-inset-left)] pr-[var(--instafy-safe-area-inset-right)]">
    {panel}
  </StudioDialogModal> : panel;
}
