import { useCallback, useEffect, useRef, useState } from "react";
import {
  CHAT_BROWSER_TAB_COPY,
  CHAT_BROWSER_VIEW_START,
  nextChatBrowserViewStep,
  type ChatBrowserViewState,
} from "./chatBrowserTab";
import { diag, diagChat, diagId } from "../../../browserFlakeDiag";

type ViewInput = Omit<Parameters<typeof nextChatBrowserViewStep>[0], "state" | "tab"> & {
  scopeKey: string;
  tabId: string | null;
  tabActive: boolean;
  resolveTab: () => Promise<unknown>;
  focusTab: (pageId: string) => Promise<unknown>;
};

export type ChatBrowserTabOpening = {
  pending: boolean;
  error: string | null;
  onRetry: () => void;
};

/** One automatic tab attempt per view; a failed attempt has an explicit, scoped retry. */
export function useChatBrowserView(input: ViewInput): ChatBrowserTabOpening | null {
  const { scopeKey, onScreen, free, chatId, tabId, tabActive, canOpenTab,
    chatTurnUnderWay, anyTurnUnderWay, resolveTab, focusTab } = input;
  const state = useRef<ChatBrowserViewState>(CHAT_BROWSER_VIEW_START);
  const generation = useRef(0);
  const pending = useRef(false);
  const latest = useRef(input);
  latest.current = input;
  const [attempt, setAttempt] = useState(0);
  const [feedback, setFeedback] = useState<{ scopeKey: string; pending: boolean; error: string | null } | null>(null);

  useEffect(() => {
    diag("view:reset", { scope: diagId("V", scopeKey), onScreen });
    state.current = CHAT_BROWSER_VIEW_START;
    pending.current = false;
    setFeedback(null);
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [scopeKey, onScreen]);

  useEffect(() => {
    const next = nextChatBrowserViewStep({
      onScreen, free, chatId, tab: tabId ? { id: tabId, isActive: tabActive } : null,
      canOpenTab, chatTurnUnderWay, anyTurnUnderWay, state: state.current,
    });
    if (next.step !== "none" || JSON.stringify(next.state) !== JSON.stringify(state.current)) {
      diag("view:step", {
        step: next.step,
        scope: diagId("V", scopeKey),
        onScreen,
        free,
        chat: diagChat(chatId),
        tab: diagId("P", tabId),
        tabActive,
        canOpenTab,
        chatTurn: chatTurnUnderWay,
        anyTurn: anyTurnUnderWay,
        before: { ...state.current, shown: state.current.shown ? "set" : null, blankTabFor: diagChat(state.current.blankTabFor) },
        after: { ...next.state, shown: next.state.shown ? "set" : null, blankTabFor: diagChat(next.state.blankTabFor) },
      });
    }
    state.current = next.state;
    if (tabId) setFeedback(null);
    if (next.step === "open-blank-tab") {
      const requestGeneration = generation.current;
      pending.current = true;
      setFeedback({ scopeKey, pending: true, error: null });
      void resolveTab().then(() => {
        if (requestGeneration === generation.current) setFeedback(null);
      }).catch((error: unknown) => {
        if (requestGeneration !== generation.current) return;
        setFeedback({ scopeKey, pending: false,
          error: error instanceof Error && error.message ? error.message : CHAT_BROWSER_TAB_COPY.notOpened });
      }).finally(() => {
        if (requestGeneration === generation.current) pending.current = false;
      });
    } else if (next.step === "focus" && tabId) {
      void focusTab(tabId).catch(() => false);
    }
  }, [scopeKey, onScreen, free, chatId, tabId, tabActive, canOpenTab, chatTurnUnderWay,
    anyTurnUnderWay, resolveTab, focusTab, attempt]);

  const onRetry = useCallback(() => {
    const current = latest.current;
    if (pending.current || !current.onScreen || !current.free || !current.canOpenTab || current.tabId) return;
    state.current = { ...state.current, blankTabFor: null };
    setAttempt((value) => value + 1);
  }, []);

  return onScreen && free && canOpenTab && !tabId && feedback?.scopeKey === scopeKey
    ? { pending: feedback.pending, error: feedback.error, onRetry }
    : null;
}
