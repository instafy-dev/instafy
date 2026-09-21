import { readLocalExploreState, readLocalTabFrame, type LocalExploreState } from "../../../services/runtimeController/localTabExplore";
import { attachRemoteBrowserInput, type RemoteBrowserInputMessage } from "./remoteBrowserInput";
import { localTabInput } from "./localTabInput";
import { RemoteBrowserMobileKeyboard } from "./RemoteBrowserMobileKeyboard";
import { useExpandedBrowserViewport } from "./useExpandedBrowserViewport";
import { readLocalTabControlState, type LocalTabControlState } from "../../../services/runtimeController/localTabControl";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/Button";
import { Select } from "../../../components/Select";
import { StudioDialogModal } from "../../../components/aria/StudioModal";
import { browserShareClient, type BrowserShare } from "../../../services/runtimeController/browserShares";

export function SharedLocalTabViewer({ projectId, share, onClose, onEnded }: { projectId: string; share: BrowserShare; onClose: () => void; onEnded: (id: string) => void }) {
  const [image, setImage] = useState<string | null>(null);
  const [state, setState] = useState("Connecting…");
  const [explore,setExplore] = useState<LocalExploreState | null>(null);
  const exploreRef = useRef(explore); exploreRef.current = explore;
  const exploring = Boolean(explore?.view);
  const [control,setControl]=useState<LocalTabControlState|null>(null);
  const controlRef=useRef(control); controlRef.current=control;
  const socketRef=useRef<WebSocket|null>(null);
  const acknowledgeFrame = useRef<(() => void) | null>(null);
  const [surface,setSurface]=useState<HTMLImageElement|null>(null);
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
    return attachRemoteBrowserInput(surface,{
      enabled:()=>Boolean((exploreRef.current?.view || (controlRef.current?.grant && controlRef.current.grant.connectionId===controlRef.current.connectionId)) && !panRef.current),
      getViewport:()=>({width:1,height:1,dpr:1,deviceWidth:1,deviceHeight:1}),
      send:sendInput,
    }).dispose;
  },[surface,sendInput]);
  useEffect(() => {
    const abort = new AbortController();
    let imageUrl: string | null = null;
    let stalled: number | undefined;
    function clear() { acknowledgeFrame.current?.(); setExplore(null); exploreRef.current=null; setControl(null); controlRef.current=null; if (imageUrl) URL.revokeObjectURL(imageUrl); imageUrl = null; setImage(null); }
    void browserShareClient(projectId).then(client => client.connect(share.id, "watch", abort.signal)).then(socket => {
      if (abort.signal.aborted) { socket.close(); return; }
      socketRef.current=socket;
      const armStall = (timeout = 10_000) => {
        window.clearTimeout(stalled);
        stalled = window.setTimeout(() => { clear(); socket.close(); }, timeout);
      };
      armStall();
      socket.addEventListener("message", event => {
        if (abort.signal.aborted) return;
        if (typeof event.data === "string") {
          try {
            const value=JSON.parse(event.data), independent=readLocalExploreState(value);
            if (independent) {
              const changed=independent.view?.viewId !== exploreRef.current?.view?.viewId;
              exploreRef.current=independent; setExplore(independent);
              if (changed) {
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
        const bytes=readLocalTabFrame(event.data,exploreRef.current?.view?.viewId ?? null);
        if (!bytes) { acknowledge(); return; }
        acknowledgeFrame.current = acknowledge;
        armStall();
        const previous = imageUrl;
        imageUrl = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
        setImage(imageUrl); setState("Live tab from a desktop · View only");
        if (previous) URL.revokeObjectURL(previous);
      });
      socket.addEventListener("close", () => { window.clearTimeout(stalled); clear(); if (!abort.signal.aborted) { setState("Sharing ended"); onEnded(share.id); } });
    }).catch(() => { if (!abort.signal.aborted) { clear(); setState("This tab share is unavailable or has ended."); onEnded(share.id); } });
    return () => { acknowledgeFrame.current=null; socketRef.current=null; controlRef.current=null; exploreRef.current=null; abort.abort(); window.clearTimeout(stalled); if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [projectId, share.id, onEnded]);
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
  const fit = imageSize.width && imageSize.height && bounds.width && bounds.height
    ? Math.min(bounds.width / imageSize.width, bounds.height / imageSize.height) : 1;
  const scale = zoom === "fit" ? fit : Number(zoom);
  const width = imageSize.width ? imageSize.width * scale : undefined;
  const height = imageSize.height ? imageSize.height * scale : undefined;
  const inlineHeight = Math.max(160, bounds.width && imageSize.width ? bounds.width * imageSize.height / imageSize.width : 240);
  const panel = <section aria-label="Shared local browser tab" className={`relative flex min-h-0 min-w-0 flex-col overflow-hidden border border-slate-300 bg-slate-950 ${fullscreen ? "h-full border-0" : "rounded-lg"}`} style={{ paddingBottom: keyboardOccupiedHeight }} data-testid="local-browser-share-viewer">
    <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 bg-slate-100 p-2 text-xs text-slate-800 dark:bg-slate-900 dark:text-slate-100">
      <div className="flex w-full items-center justify-between gap-2">
        <span role="status">{exploring ? "Explore · Your own view" : image && selfControls ? "Live tab · You control" : image && control?.grant ? "Live tab · Another participant controls" : state}</span><Button size="sm" variant="ghost" onPress={onClose}>Leave</Button>
      </div>
      <div className={keyboardOccupiedHeight > 0 ? "hidden" : "flex flex-wrap items-center gap-2"}>
        <Select aria-label="Shared tab zoom" value={zoom} disabled={!image} fullWidth={false} size="xs" onChange={event => {
          setZoom(event.target.value);
          if (viewport) { viewport.scrollLeft = 0; viewport.scrollTop = 0; }
        }}>
          <option value="fit">Fit to view</option><option value="1">100% · Read size</option><option value="1.5">150%</option><option value="2">200%</option>
        </Select>
        <Button size="sm" variant="ghost" onPress={() => setFullscreen(current => !current)} aria-label={fullscreen ? "Minimize shared tab" : "Expand shared tab"}>{fullscreen ? "Minimize" : "Expand"}</Button>
      </div>
      {!exploring && image && control?.available ? <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" data-testid="local-tab-control-action" onPress={()=>command(selfControls||control.requested?"releaseControl":"requestControl")}>{selfControls?"Release control":control.requested?"Cancel request":"Request control"}</Button>
        {selfControls ? <Button size="sm" variant="ghost" aria-pressed={panOnly} onPress={()=>setPanOnly(current=>!current)}>{panOnly?"Control page":"Pan view"}</Button> : null}
      </div> : null}
      {explore?.available ? <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="secondary" data-testid="local-tab-explore-action" isDisabled={!exploring && selfControls} onPress={() => command(exploring || explore.requested ? "exploreReturn" : "exploreRequest", exploring || explore.requested ? {} : {viewport:viewerViewport()})}>{exploring ? "Return to follow" : explore.requested ? "Cancel Explore request" : "Explore independently"}</Button>
        {exploring ? <><Button size="sm" variant="ghost" aria-label="Back in your Explore view" onPress={() => command("exploreNavigate",{viewId:explore.view!.viewId,action:"back"})}>Back</Button><Button size="sm" variant="ghost" aria-label="Reload your Explore view" onPress={() => command("exploreNavigate",{viewId:explore.view!.viewId,action:"reload"})}>Reload</Button></> : null}
      </div> : null}
      {keyboardOccupiedHeight > 0 ? null : exploring ? <p className="w-full text-slate-500 dark:text-slate-400 [@media(max-height:500px)]:hidden">Your layout and scroll are separate. Saved changes use the owner’s account.</p> : selfControls && !panOnly ? <p className="w-full text-slate-500 dark:text-slate-400 [@media(max-height:500px)]:hidden">Click the page to type. Scroll moves the shared page.</p> : zoom !== "fit" && image ? <p className="w-full text-slate-500 dark:text-slate-400 [@media(max-height:500px)]:hidden">Scroll to pan your view.</p> : null}
    </div>
    <div ref={setViewport} tabIndex={image ? 0 : undefined} role="region" aria-label="Shared tab image viewport" data-testid="local-browser-share-pan"
      className={`relative min-h-0 min-w-0 overflow-auto overscroll-contain ${fullscreen ? "flex-1" : ""}`}
      style={fullscreen ? undefined : { height: exploring ? "min(55vh,480px)" : image ? inlineHeight : 0, maxHeight: "55vh" }}>
      {image ? <div className="grid min-h-full min-w-full place-items-center" style={{ width, height }}>
        <img ref={setSurface} tabIndex={(selfControls || exploring) && !panOnly ? 0 : -1} alt="Live shared browser tab" src={image} className="block max-w-none select-none [-webkit-touch-callout:none] [-webkit-user-drag:none]" style={{ width, height, touchAction: (selfControls || exploring) && !panOnly ? "none" : "auto" }} draggable={false} data-testid="local-browser-share-image"
          onLoad={event => { acknowledgeFrame.current?.(); const img = event.currentTarget; setImageSize(current => current.width === img.naturalWidth && current.height === img.naturalHeight ? current : { width: img.naturalWidth, height: img.naturalHeight }); }} />
      </div> : null}
    </div>
    <RemoteBrowserMobileKeyboard enabled={(selfControls || exploring) && !panOnly && Boolean(image)} onMessage={sendInput} onOccupiedHeightChange={setKeyboardOccupiedHeight} />
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
