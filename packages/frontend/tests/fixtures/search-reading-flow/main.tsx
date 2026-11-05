import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, useLocation, useNavigate } from "react-router-dom";
import { ResizablePanels } from "../../../src/components/ResizablePanels";
import { Button } from "../../../src/components/Button";
import { buildStudioDestinationSearch } from "../../../src/navigation/studioNavigation";
import { getStudioVisitKey } from "../../../src/navigation/studioVisit";
import { useStudioHistory } from "../../../src/navigation/useStudioHistory";
import { useStudioSearchHistory } from "../../../src/screens/studio/useStudioSearchHistory";
import { StudioSearchContext } from "../../../src/screens/studio/components/StudioSearchContext";
import { StudioSidebarTeamMenu } from "../../../src/screens/studio/components/StudioSidebarTeamMenu";
import { StudioRecentSpaces } from "../../../src/screens/studio/components/StudioRecentSpaces";
import { StudioSearchReturnProvider } from "../../../src/screens/studio/components/StudioSearchReturnContext";
import { useStudioSearch, type StudioSearchRecord, type StudioSearchRequest } from "../../../src/screens/studio/components/useStudioSearch";
import { MobileStudioHistoryControls } from "../../../src/screens/studio/components/MobileStudioHistoryControls";
import { ChatTranscriptViewport } from "../../../src/screens/studio/components/ChatTranscriptViewport";
import { ChatColumn } from "../../../src/screens/studio/components/ChatColumn";
import { ConversationMessageRows } from "../../../src/screens/studio/components/ConversationMessageRows";
import { ChatMessageAvatar } from "../../../src/screens/studio/components/ChatMessageAvatar";
import { ChatMessageHistoryControls } from "../../../src/screens/studio/components/ChatMessageHistoryControls";
import { ChatNewMessagesButton } from "../../../src/screens/studio/components/ChatNewMessagesButton";
import { ChatImageLightboxOverlay } from "../../../src/screens/studio/components/ChatPanelOverlays";
import { useChatScrollController } from "../../../src/screens/studio/components/useChatScrollOrchestration";
import { resolveChatScrollHistoryVisit } from "../../../src/screens/studio/components/chatScrollHistory";
import { useChatNewerHistoryPaging } from "../../../src/screens/studio/components/useChatNewerHistoryPaging";
import { useChatRunStop } from "../../../src/screens/studio/components/useChatRunStop";
import { Composer } from "./Composer";
import { CONVERSATION_ID, PROJECT_ID, TARGET_ID, TARGET_TEXT, newerMessages, olderMessages } from "./scenario";
import "../../../src/styles/tailwind.css";
import "../../../src/screens/studio/StudioContextLayout.css";
import "./review.css";

declare const __SEARCH_READING_BASELINE__: boolean;

const params = new URLSearchParams(location.search);
// The image review's frozen source already has the above-composer latest action.
// Preserve the original search review's older baseline composition separately.
const legacyHistoryLayout = __SEARCH_READING_BASELINE__ && params.get("review") !== "image";
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
const noop = () => {};
const org = { id: "review-org", name: params.has("longNames") ? "Design Lab and Independent Research Collective" : "Design Lab" };
const space = { id: PROJECT_ID, name: params.has("longNames") ? "Website refresh and navigation accessibility research" : "Website refresh" };
const initialSearch = { restoreKey: "initial", query: "", scope: "space" as const, scrollTop: 0, resultId: "", resultLimit: 100, messagePageCount: 1 };
const placeholder = <span aria-hidden="true" className="h-8 w-8 shrink-0 pointer-events-none" />;

function Conversation({ onReturnToLatest }: { onReturnToLatest: () => void }) {
  const location = useLocation();
  const target = new URLSearchParams(location.search).get("messageId");
  const [pageCount, setPageCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [padding, setPadding] = useState(150);
  const [scrollbarInset, setScrollbarInset] = useState(0);
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const attempted = useRef(false);
  const messages = useMemo(() => target ? [...olderMessages, ...newerMessages.slice(0, pageCount * 4)] : [...olderMessages, ...newerMessages], [pageCount, target]);
  const visit = resolveChatScrollHistoryVisit({ location, userId: "review-user", projectId: PROJECT_ID,
    conversationsProjectKey: PROJECT_ID, conversationId: CONVERSATION_ID, conversationControllerId: null });
  const scroll = useChatScrollController({ activeConversationId: CONVERSATION_ID, historyVisit: visit,
    hasMoreHistory: false, isHistoryLoading: false, loadOlderMessages: noop, messages });
  const returnLatest = onReturnToLatest;
  const loadNewer = useCallback(async () => {
    setLoading(true);
    setError(null);
    await new Promise(resolve => setTimeout(resolve, 180));
    if (params.get("history") === "retry" && !attempted.current) {
      attempted.current = true;
      setError("Could not load the next messages. Try again.");
    } else setPageCount(value => value + 1);
    setLoading(false);
  }, []);
  useChatNewerHistoryPaging({ visitKey: scroll.scrollSnapshotKey, routeKey: location.key,
    enabled: Boolean(target), hasNewer: pageCount < 3, loading, error,
    scrollContainerRef: scroll.scrollContainerRef, isReadingReady: scroll.isHistoryReadingReady,
    loadNewer, onReachLatest: returnLatest });
  useEffect(() => {
    const composer = root.current?.querySelector('[data-testid="chat-composer-overlay"]') ?? root.current?.querySelector("form");
    const observer = new ResizeObserver(() => { if (composer) setPadding(composer.getBoundingClientRect().height + 24); });
    if (composer) observer.observe(composer);
    return () => observer.disconnect();
  }, [scroll.scrollContainerRef]);
  const controller = useChatRunStop({ conversationId: null, targets: [], canStop: false, viewerUserId: null });
  const renderAvatar: Parameters<typeof ConversationMessageRows>[0]["renderAssistantAvatar"] = (metadata, agent, options) => <ChatMessageAvatar kind="assistant" metadata={metadata} agent={agent} motion={options?.motion} />;
  return <div ref={root} className="reading-chat" data-testid="review-chat-pane" data-history-pages={pageCount} data-message-target={target ?? ""}>
    <ChatTranscriptViewport ariaLabel="Autumn launch notes" identityLayout="solo" scrollContainerRef={scroll.scrollContainerRef}
      scrollPaddingBottom={padding} onScrollbarWidthChange={setScrollbarInset}>
      <div ref={scroll.handleScrollContentRef}>
        <ChatColumn className="space-y-2.5">
          <ConversationMessageRows messages={messages} currentUserId="review-user" chatClientSessionId="review-session"
            projectId={PROJECT_ID} runtimeId={null} conversationLocalId={CONVERSATION_ID} conversationControllerId={null}
            identityLayout="solo" scrollSnapshotKey={scroll.scrollSnapshotKey} targetedMessageId={target} highlightedMessageId={scroll.highlightedMessageId}
            firstPlanMessageId={null} humanLabelByUserId={new Map()} runAgentIdentityByRunId={new Map()} runAgentHandleByRunId={new Map()}
            renderAssistantAvatar={renderAvatar} assistantAvatarPlaceholder={placeholder}
            onOpenImage={(src, alt) => setLightbox({ src, alt })}
            onRequestActions={noop} onRequestActionsAtPoint={noop} onMessageContextMenu={noop} />
          <ChatMessageHistoryControls messageTargetActive={Boolean(target)} loadingNewer={loading} newerError={error}
            canReturnToLatest onLoadNewer={loadNewer} onReturnToLatest={returnLatest} hideLatest={!legacyHistoryLayout} />
        </ChatColumn>
      </div>
    </ChatTranscriptViewport>
    <Composer controller={controller} scrollbarInset={scrollbarInset}
      aboveComposer={target && !legacyHistoryLayout ? <ChatNewMessagesButton {...{ hasNewMessages: false, readingRegionRef: scroll.scrollContainerRef }} onPress={returnLatest} /> : null} />
    <ChatImageLightboxOverlay imageLightbox={lightbox} onClose={() => setLightbox(null)} />
  </div>;
}

function Review() {
  const location = useLocation();
  const navigate = useNavigate();
  const history = useStudioHistory();
  const isConversation = new URLSearchParams(location.search).has("conversationId");
  const searchHistory = useStudioSearchHistory("review-user", getStudioVisitKey(location), "review-search");
  const [request, setRequest] = useState<StudioSearchRequest>({ open: true, scope: "space", query: "" });
  const [ratio, setRatio] = useState(.58);
  const openMessage = (messageId?: string) => {
    const search = buildStudioDestinationSearch(location.search, { kind: "conversation", projectId: PROJECT_ID, conversationId: CONVERSATION_ID, messageId });
    void navigate({ pathname: location.pathname, search }, { state: { instafySearchOriginToken: searchHistory.getOriginToken() } });
  };
  const query = request.query.trim();
  const hits = query.length >= 2 ? Array.from({ length: 14 }, (_, index): StudioSearchRecord => ({
    id: index ? `message-followup-${index}` : "message-original", title: "Autumn launch notes", description: "Design Lab / Website refresh",
    keywords: "navigation notes", group: "Messages", orgId: org.id, spaceId: space.id,
    message: { excerpt: index ? `Navigation follow-up ${index}: keep the project links readable on every page and preserve the labels from the original notes.` : TARGET_TEXT,
      query, matchRanges: [], authorLabel: index ? "Octo" : "You", createdAt: "2026-10-28T09:16:00Z" },
    activate: () => openMessage(index ? `older-followup-${index % 8}` : TARGET_ID),
  })).filter(record => record.message!.excerpt.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
    .map(record => { const start = record.message!.excerpt.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      return { ...record, message: { ...record.message!, matchRanges: [{ start, end: start + query.length }] } }; }) : [];
  const records: StudioSearchRecord[] = [...hits, { id: "chat-launch", title: "Autumn launch notes", description: "Design Lab / Website refresh", keywords: "navigation notes", group: "Chats", orgId: org.id, spaceId: space.id, activate: () => openMessage() }];
  const search = useStudioSearch({ scopeKey: "review-search", org, space, records, fullPage: true,
    onRequestChange: setRequest, restoreSession: searchHistory.restoredSession ?? (!isConversation ? initialSearch : null),
    onBeforeResultActivate: searchHistory.remember,
    notice: "Search includes accessible chat messages and recent chat titles. Files match listed names; file contents are not included." });
  const split = innerWidth >= 1100 && params.get("layout") !== "full";
  const returnLatest = useCallback(() => {
    const search = buildStudioDestinationSearch(location.search, { kind: "conversation", projectId: PROJECT_ID, conversationId: CONVERSATION_ID });
    void navigate({ pathname: location.pathname, search }, { replace: true, state: location.state });
  }, [location.pathname, location.search, location.state, navigate]);
  const context = <StudioSearchContext scope={search.scope} onBroaden={search.changeScope} context={{ teamName: org.name,
    team: <StudioSidebarTeamMenu teamName={org.name} compact={false} active={false}
      presentation={innerWidth < 900 ? "path" : "standard"} mobile={innerWidth < 900}
      rowClassName="" iconClassName="" onOpenOverview={() => search.changeScope("org", true)}
      onSwitchTeam={() => search.changeScope("org", true)} />,
    space: <StudioRecentSpaces spaces={[space]} teamName={org.name} activeProjectId={space.id} recency={{ [space.id]: 1 }}
      presentation="path" collapsed={false} expanded={false} onExpandedChange={noop} rowClassName="" iconClassName=""
      onSelectSpace={() => search.changeScope("space", true)} onBrowseAll={() => search.changeScope("org", true)} />,
    onBrowseTeams: () => search.changeScope("org", true) }} />;
  const chat = <section className="reading-chat-shell"><header className="reading-chat-header"><MobileStudioHistoryControls history={history} /><span>Autumn launch notes</span></header><Conversation onReturnToLatest={returnLatest} /></section>;
  return <StudioSearchReturnProvider value={{ originToken: searchHistory.originToken, returnToResults: searchHistory.returnToResults }}>
    <main className="studio-context-layout reading-review" data-testid="search-reading-review">
      {isConversation ? <ResizablePanels main={chat} side={<aside className="reading-reference"><small>WEBSITE REFRESH</small><h1>A clearer way<br />to find your work.</h1><p>The original reference stays beside the conversation while you read the review.</p><img src="/landing-tentacles.jpg" alt="Original landing page artwork" /><p className="reading-local-note">Local review data · no connected account or runtime</p></aside>}
        mode={split ? "split" : "main"} ratio={ratio} minRatio={.3} maxRatio={.7} onRatioChange={setRatio} onRatioPreview={noop} />
        : <div className="studio-context-search-screen"><header className="studio-context-search-mobile" aria-label="Search">{search.renderControl(false, context)}</header>
          <div className="px-1"><MobileStudioHistoryControls history={history} returnToSearch={false} /></div>
          <div className="flex min-h-0 min-w-0 flex-1" aria-label="Search results" data-testid="studio-search-screen">{search.results}</div>
          {!search.open ? <Button onPress={search.openSearch}>Search chats</Button> : null}
        </div>}
    </main>
  </StudioSearchReturnProvider>;
}

createRoot(document.getElementById("root")!).render(<BrowserRouter><Review /></BrowserRouter>);
