import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../../../src/styles/tailwind.css";
import { useConversationHistoryState } from "../../../../src/conversations/useConversationHistoryState";
import { createInitialConversation } from "../../../../src/conversations/conversationState";
import { ConversationMessageRows } from "../../../../src/screens/studio/components/ConversationMessageRows";
import { ChatTranscriptViewport } from "../../../../src/screens/studio/components/ChatTranscriptViewport";
import { retainConversationHistoryCache } from "../../../../src/conversations/conversationHistoryCache";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 30_000 } } });
retainConversationHistoryCache(queryClient);
const noop = () => undefined;
const empty = new Map();
const idFor = (org: number, space: number, chat: number) => `00000000-0000-4000-8000-${String(org * 100 + space * 10 + chat).padStart(12, "0")}`;
const navigation: { kind: string; elapsedMs: number; loadingShown: boolean }[] = [];
let pending: { kind: string; startedAt: number; loadingShown: boolean } | null = null;

function cacheSnapshot() {
  const pairs = new Map<string, { active: boolean; bytes: number; pages: number }>();
  for (const query of queryClient.getQueryCache().getAll()) {
    if (!["conversation-messages", "conversation-messages-latest"].includes(String(query.queryKey[0]))) continue;
    if (typeof query.queryKey[2] !== "string") continue;
    const key = JSON.stringify(query.queryKey.slice(1));
    const pair = pairs.get(key) ?? { active: false, bytes: 0, pages: 0 };
    pair.active ||= query.getObserversCount() > 0;
    pair.bytes += (JSON.stringify(query.state.data)?.length ?? 0) * 2;
    if (query.queryKey[0] === "conversation-messages") pair.pages = (query.state.data as { pages?: unknown[] })?.pages?.length ?? 0;
    pairs.set(key, pair);
  }
  const inactive = [...pairs.values()].filter((pair) => !pair.active);
  return {
    inactiveConversations: inactive.length,
    inactivePayloadBytes: inactive.reduce((total, pair) => total + pair.bytes, 0),
    maxInactivePages: Math.max(0, ...inactive.map((pair) => pair.pages)),
    activeConversations: [...pairs.values()].filter((pair) => pair.active).length,
    rows: document.querySelectorAll('[data-testid="chat-message-row"]').length,
    deferredRows: document.querySelectorAll('[data-chat-row-deferred="true"]').length,
    historyQueries: queryClient.getQueryCache().getAll().length,
  };
}

declare global {
  interface Window {
    __CONVERSATION_PERF__: {
      snapshot: typeof cacheSnapshot;
      navigation: typeof navigation;
      clearNavigation: () => void;
    };
    __INSTAFY_CONTROLLER_TOKEN__?: string | null;
  }
}
window.__CONVERSATION_PERF__ = { snapshot: cacheSnapshot, navigation, clearNavigation: () => { navigation.length = 0; } };

function Fixture() {
  const [scope, setScope] = useState({ org: 1, space: 1, chat: 1 });
  const [mounted, setMounted] = useState(true);
  const [count, setCount] = useState(0);
  const conversationId = idFor(scope.org, scope.space, scope.chat);
  const conversation = useMemo(() => ({ ...createInitialConversation({ localId: conversationId }), controllerId: conversationId }), [conversationId]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const history = useConversationHistoryState({ activeConversation: mounted ? conversation : null, currentUserId: "perf-user", runs: {}, setConversationControllerId: noop, replaceMessages: noop });
  const navigate = (next: typeof scope, kind: string) => {
    pending = { kind, startedAt: performance.now(), loadingShown: false };
    setScope(next);
    setMounted(true);
  };
  useLayoutEffect(() => {
    if (pending && history.isInitialHistoryLoading) pending.loadingShown = true;
    if (!pending || history.isInitialHistoryLoading || history.initialHistoryError || !history.messages.length) return;
    const request = pending;
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => {
      if (pending !== request) return;
      navigation.push({ kind: request.kind, elapsedMs: performance.now() - request.startedAt, loadingShown: request.loadingShown });
      pending = null;
    }); });
    return () => cancelAnimationFrame(frame);
  }, [conversationId, history.messages, history.isInitialHistoryLoading, history.initialHistoryError]);
  useEffect(() => setCount(history.messages.length), [history.messages.length]);
  return <main className="flex h-dvh flex-col bg-white text-slate-900">
    <header className="flex flex-wrap gap-2 border-b p-2">
      <strong>Production chat data/renderer benchmark</strong>
      {[1, 2, 3].map((org) => <button key={org} data-testid={`org-${org}`} onClick={() => navigate({ org, space: 1, chat: 1 }, "org")}>Org {org}</button>)}
      {[1, 2, 3].map((space) => <button key={space} data-testid={`space-${space}`} onClick={() => navigate({ ...scope, space, chat: 1 }, "space")}>Space {space}</button>)}
      {[1, 2, 3].map((chat) => <button key={chat} data-testid={`tab-${chat}`} onClick={() => navigate({ ...scope, chat }, "tab")}>Chat {chat}</button>)}
      <button data-testid="load-older" disabled={!history.hasMoreHistory || history.isHistoryLoading} onClick={() => void history.loadOlderMessages()}>Load older messages</button>
      <button data-testid="refresh" onClick={() => window.dispatchEvent(new Event("instafy:controller-stream-reconnected"))}>Refresh history</button>
      <button data-testid="release" onClick={() => setMounted(false)}>Close transcript</button>
      <output data-testid="scope" data-conversation={conversationId} data-count={count}>{scope.org}/{scope.space}/{scope.chat}: {count} messages</output>
    </header>
    {history.isInitialHistoryLoading ? <p data-testid="loading">Loading messages…</p> : null}
    {history.initialHistoryError ? <p data-testid="error">{history.initialHistoryError}<button data-testid="retry" onClick={() => void history.retryInitialHistory()}>Retry</button></p> : null}
    <ChatTranscriptViewport scrollContainerRef={scrollRef} ariaLabel="Benchmark messages">
      <ConversationMessageRows key={conversationId} messages={history.messages} currentUserId="perf-user" chatClientSessionId="fixture"
        projectId={idFor(scope.org, scope.space, 0)} runtimeId={null} conversationLocalId={conversationId} conversationControllerId={conversationId}
        firstPlanMessageId={null} humanLabelByUserId={empty} runAgentIdentityByRunId={empty} runAgentHandleByRunId={empty}
        renderAssistantAvatar={() => <span>O</span>} assistantAvatarPlaceholder={<span />} onRequestActions={noop} onRequestActionsAtPoint={noop}
        onCancelTerminalCommand={null} onMessageContextMenu={noop} />
    </ChatTranscriptViewport>
  </main>;
}

createRoot(document.getElementById("root")!).render(<QueryClientProvider client={queryClient}><Fixture /></QueryClientProvider>);
