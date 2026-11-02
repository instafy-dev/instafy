import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Globe, Lock, NavArrowLeft, Refresh } from "iconoir-react";
import { clampFloatingSurfacePositionToStudioViewport } from "../../../src/utils/floatingSurfacePosition";
import { ResizablePanels } from "../../../src/components/ResizablePanels";
import { ChatTranscriptViewport } from "../../../src/screens/studio/components/ChatTranscriptViewport";
import { ChatColumn } from "../../../src/screens/studio/components/ChatColumn";
import { ChatBubbleRow } from "../../../src/screens/studio/components/ChatBubbleRow";
import { ChatMessageAvatar } from "../../../src/screens/studio/components/ChatMessageAvatar";
import { ConversationMessageRows } from "../../../src/screens/studio/components/ConversationMessageRows";
import { StoppedTurnRow, WorkspaceStartStalledRow } from "../../../src/screens/studio/components/ChatSystemRows";
import { ChatTypingRows } from "../../../src/screens/studio/components/ChatTypingRows";
import { ChatMessageMenuOverlay } from "../../../src/screens/studio/components/ChatPanelOverlays";
import { BrowserApprovalRow } from "../../../src/screens/studio/components/BrowserApprovalRow";
import type { SharedBrowserApprovalState } from "../../../src/screens/studio/components/useSharedBrowserApproval";
import { useChatRunStop } from "../../../src/screens/studio/components/useChatRunStop";
import { ConversationSurfaceTabs } from "../../../src/workspace/ConversationSurfaceLayout";
import { Composer } from "../run-stop-control/Composer";
import type { ChatMessage } from "../../../src/screens/studio/types";
import { OPEN_AGENT_PROFILE_EVENT } from "../../../src/screens/studio/components/agentProfileOpen";
import { timelineMessages } from "./timelineScenario";
import "../../../src/styles/tailwind.css";
import "./review.css";

const query = new URLSearchParams(location.search);
const group = query.get("people") === "group";
const timeline = query.has("timeline");
const multiTyping = query.get("typing") === "multi";
const working = query.get("state") === "working" || (!timeline && query.get("state") !== "completed");
const busy = query.get("status") === "busy";
const statusLabel = busy ? "Octo’s workspace is busy with another task. Your message is kept and will continue when the workspace is available." : "Checking the opening hours…";
const theme = query.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
document.documentElement.dataset.reviewScrollbar = query.get("scrollbar") === "classic" ? "classic" : "system";
const noop = () => {};
const placeholder = <span aria-hidden="true" className="h-8 w-8 shrink-0 pointer-events-none" />;
const stamp = Date.UTC(2026,10,2,10);
const messages: ChatMessage[] = timeline ? timelineMessages(group) : [
  ...Array.from({ length: 4 }, (_, i) => [
    { id:`question-${i}`, role:"user" as const, timestamp:stamp+i*120000, content:["Could you compare these two places for our weekend?","I would prefer somewhere quiet, with a short walk from the train.","Keep the old town in the plan, but leave enough time for lunch.","Please check the opening hours before choosing the afternoon stop."][i], authorId:"review-user" },
    { id:`answer-${i}`, role:"assistant" as const, timestamp:stamp+i*120000+10000, content:["I'll compare the travel time, walking distance, and what is open on Sunday. I’ll keep the source page beside our chat so you can inspect the details.","Both places are easy to reach by train. The riverside route is quieter, while the old town has more places to stop for a coffee.","The small garden is a good first stop. It leaves the afternoon free for the old town and avoids doubling back across the river.","The garden opens at ten. The museum’s own page lists a later Sunday opening, so I’d visit it after lunch."][i], metadata:{agent:{handle:"octo",avatarSeed:"octo"}} },
  ]).flat(),
  ...(group ? [{id:"group-human",role:"user" as const,timestamp:stamp+490000,content:"I can meet you at the station. Please keep the walking route under an hour.",authorId:"review-teammate"}, {id:"group-agent",role:"assistant" as const,timestamp:stamp+500000,content:"The riverside route is 3.2 km. I checked the walking distance, and it should fit comfortably before lunch.",metadata:{agent:{handle:"route-planner",id:"review-agent-planner",avatarSeed:"review-planner"}}}] : []),
  {id:"latest-user",role:"user",timestamp:stamp+510000,content:"That sounds good. Can you put the stops in a sensible order and keep the source links?",authorId:"review-user"},
  {id:"latest-assistant",role:"assistant",timestamp:stamp+520000,content:"Start at the station, follow the river to the garden, then walk into the old town for lunch. The museum fits best afterward.\n\nThe route leaves a little room to stop along the way. I’m checking the official opening-hours page before I add the final link.",metadata:{agent:{handle:"octo",avatarSeed:"octo"}}},
];

if (!working && !timeline) messages[messages.length-1].content = "Start at the station, follow the river to the garden, then walk into the old town for lunch. The museum fits best afterward.\n\nThe Sunday opening hours are confirmed. This plan leaves a little room to stop along the way without rushing back for the train.";

if (query.has("sameHandle")) messages.splice(messages.length-2,0,{id:"second-planner",role:"assistant",timestamp:stamp+505000,content:"I checked the accessible route separately. The station exit leads directly to the riverside path.",metadata:{agent:{handle:"route-planner",id:"review-agent-planner-two",avatarSeed:"review-planner-two"}}});

if (query.has("error")) Object.assign(messages[messages.length-1], {messageType:"error", content:"The page could not be opened. Your draft is still here; you can try again.", metadata:{messageType:"error",agent:{handle:"octo",avatarSeed:"octo"}}});

if (query.has("stress")) messages[messages.length-1].content += "\n\nA long source path: https://river-garden.example.test/visits/" + "opening-hours-and-access-".repeat(12) + "\n\n```text\n" + "a_very_long_unbroken_value_".repeat(18) + "\n```";

function BrowserPage() {
  return <div className="review-page" data-testid="sample-browser-page"><div className="review-address"><NavArrowLeft className="h-4 w-4"/><Refresh className="h-4 w-4"/><Lock className="h-3 w-3"/> river-garden.example.test/visit</div><article className="review-article"><small>RIVER GARDEN · VISITOR INFORMATION</small><h1>A slower morning by the river.</h1><p>Walk through the garden, follow the water, and leave time for a coffee in the old town.</p><section><h2>Plan your visit</h2><p>Sunday · 10:00–18:00<br/>Last entry · 17:30<br/>A short walk from the station.</p></section><section><h2>Getting here</h2><p>Follow the riverside path from the station. The route is mostly level, with benches beside the garden entrance.</p></section><section><p>Local sample page for layout review. No live browser session is connected.</p></section></article></div>;
}

function Review() {
  const scroll = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const paneWidth = Number(query.get("pane")) || 420;
  const split = innerWidth >= 900 && query.get("layout") !== "full";
  const [ratio,setRatio] = useState(split ? 1-paneWidth/innerWidth : .55);
  const [padding,setPadding] = useState(140);
  const [scrollbarInset,setScrollbarInset] = useState(0);
  const [event,setEvent] = useState("");
  const [approvalOutcome,setApprovalOutcome] = useState("");
  const [messageMenu,setMessageMenu] = useState<Parameters<typeof ChatMessageMenuOverlay>[0]["messageMenu"]>(null);
  const openMessageMenu = (messageId: string, clientX: number, clientY: number) => setMessageMenu({kind:"message", messageId, ...clampFloatingSurfacePositionToStudioViewport({clientX,clientY,surfaceWidth:256,surfaceHeight:200,padding:12}), view:"actions"});
  const controller = useChatRunStop({conversationId:null,targets:[],canStop:false,viewerUserId:null});
  const renderAvatar: Parameters<typeof ConversationMessageRows>[0]["renderAssistantAvatar"] = (metadata,agent,options) => <ChatMessageAvatar kind="assistant" metadata={metadata} agent={agent} motion={options?.motion}/>;
  useEffect(() => {
    const capture = (value: Event) => setEvent(JSON.stringify((value as CustomEvent).detail));
    window.addEventListener(OPEN_AGENT_PROFILE_EVENT,capture);
    const composer = root.current?.querySelector('[data-testid="chat-composer-overlay"]') ?? root.current?.querySelector('form');
    const observer = new ResizeObserver(() => {if (composer) setPadding(composer.getBoundingClientRect().height+24);});
    if (composer) observer.observe(composer);
    return () => {observer.disconnect(); window.removeEventListener(OPEN_AGENT_PROFILE_EVENT,capture);};
  },[]);
  const approval: SharedBrowserApprovalState = {
    pending: approvalOutcome || !working ? null : {runtimeId:"review-runtime",request:{version:1,approvalId:"review-approval",kind:"action",ownerId:"review-owner",runId:"review-run",initiatorUserId:"review-user",browserPageId:"review-page",operation:"form-submit",sourceOrigin:"https://river-garden.example.test",destinationOrigin:"https://river-garden.example.test",destinationFingerprint:"a".repeat(64),snapshotId:null,targetFingerprint:null,payloadFingerprint:null,requestedAtMs:Date.now(),expiresAtMs:Date.now()+600000,requestFingerprint:"b".repeat(64),display:{label:"Search",destinationOrigin:null}}},
    submitting:false,error:null,routineApprovedRunId:null,lastDecision:null,decide:async decision => {setApprovalOutcome(decision);setEvent(`Browser request: ${decision}`);},
  };
  const chat = <div ref={root} className="review-chat" data-testid="review-chat-pane">
    <ChatTranscriptViewport ariaLabel="Trip research" scrollContainerRef={scroll} scrollPaddingBottom={padding} {...{onScrollbarWidthChange:setScrollbarInset, identityLayout:group ? "participants" as const : "solo" as const}}>
      <ChatColumn className="space-y-2.5">
        <ConversationMessageRows messages={messages} currentUserId="review-user" {...{identityLayout:group ? "participants" as const : "solo" as const}} chatClientSessionId="review-session" projectId="review-project" runtimeId={null} conversationLocalId="review-conversation" conversationControllerId={null} firstPlanMessageId={null} humanLabelByUserId={new Map([["review-teammate","Alex Morgan"]])} runAgentIdentityByRunId={new Map()} runAgentHandleByRunId={new Map()} renderAssistantAvatar={renderAvatar} assistantAvatarPlaceholder={placeholder} onRequestActions={(id,rect)=>{if(rect) openMessageMenu(id,rect.left+256+12 <= innerWidth ? rect.left : rect.right-256,rect.bottom+6);}} onRequestActionsAtPoint={openMessageMenu} onMessageContextMenu={(event,id)=>{event.preventDefault();openMessageMenu(id,event.clientX,event.clientY);}}/>
        {working ? <StoppedTurnRow text="Your earlier turn was stopped. The draft is still here."/> : null}
        <BrowserApprovalRow agentDisplayName="Octo" approval={approval} frame={row=><ChatBubbleRow avatar={placeholder}>{row}</ChatBubbleRow>}/>
        {query.has("warning") ? <WorkspaceStartStalledRow agentDisplayName="Octo" retryPending={false} onRetry={() => setEvent("Workspace retry requested")}/> : null}
        <ChatTypingRows peerTypingLabel={multiTyping ? "Alex is typing…" : null} isAssistantTyping={working} {...{identityLayout:group ? "participants" as const : "solo" as const}} isAssistantTypingCoveredByJobThreadPreview={false} typingAgents={multiTyping ? [{handle:"octo",displayName:"Octo",avatarSeed:"octo",isThinking:true},{handle:"route-planner",displayName:"route-planner",avatarSeed:"review-planner",id:"review-agent-planner",isThinking:false}] : []} hasMultipleTypingAgents={multiTyping} typingAgentHandle="octo" typingAgentAvatarSeed="octo" typingIndicatorState={{phase:busy ? "waiting" : "thinking",label:statusLabel}} typingStatusLabel={statusLabel} typingStatusAriaLabel={statusLabel} typingStatusWraps={busy} isThinkingLabelExpanded={false} onToggleThinkingLabel={noop} latestDisplayedMessageId="latest-assistant" renderAssistantAvatar={renderAvatar}/>
      </ChatColumn>
    </ChatTranscriptViewport>
    <Composer controller={controller} readOnly={false} recording={false} fullPage scrollbarInset={scrollbarInset} queueReview={{count:0,initialDraft:"Keep the riverside route."}}
      viewNavigation={!split && innerWidth < 900 ? <ConversationSurfaceTabs presentation="composer" chatPanelId="review-chat" resources={[{id:"browser",label:"Browser",panelId:"review-browser",icon:<Globe className="h-4 w-4"/>}]} activeId="chat" resourceId="browser" split={false} wide={false} ratio={.55} onSelect={noop} onSplitChange={noop}/> : undefined}/>
  </div>;
  return <main className="review-app"><header className="review-header"><strong>Fixture · {timeline ? "Chat timeline" : "Chat reading space"}</strong><small>{group ? "You, Alex and two agents" : "You and Octo"} · {working ? "Working" : "Completed"} · Local sample data{query.get("scrollbar") === "classic" ? " · visible 12px scrollbar" : ""}</small></header><div className="review-body"><ResizablePanels main={chat} side={<BrowserPage/>} mode={split ? "split":"main"} ratio={ratio} minRatio={.25} maxRatio={.75} onRatioChange={setRatio} onRatioPreview={noop}/></div><ChatMessageMenuOverlay messageMenu={messageMenu} {...{selectedMessageTimestamp:messages.find(message=>message.id===messageMenu?.messageId)?.timestamp ?? null}} selectedMessageTokenUsage={null} onClose={()=>setMessageMenu(null)} onShowActionsView={()=>setMessageMenu(menu=>menu ? {...menu,view:"actions"} : null)} onShowTokenUsageView={()=>setMessageMenu(menu=>menu ? {...menu,view:"token_usage"} : null)} onCopySelectedMessage={()=>setEvent(`Copy requested: ${messageMenu?.messageId}`)} onCopyConversation={noop} onCopyTokenUsage={noop}/><output className="review-output" data-testid="review-event">{event}</output></main>;
}
createRoot(document.getElementById("root")!).render(<Review/>);
