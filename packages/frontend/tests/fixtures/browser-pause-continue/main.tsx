import { createElement, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RuntimeBrowserSessionAction } from "../../../src/sdk/instafy";
import { BrowserSessionModal } from "../../../src/screens/studio/components/BrowserSessionModal";
import { sharedBrowserConversationRunIds } from "../../../src/screens/studio/components/browserHandoffRouting";
import { shouldUseCompactBrowserChrome } from "../../../src/screens/studio/components/browserSessionLayout";
import { useStudioDesktopLayout } from "../../../src/screens/studio/useStudioDesktopLayout";
import type { RunRecord } from "../../../src/types";
import "../../../src/styles/tailwind.css";

// A chat's Browser view after the sign-in pause: a card's browser turn opened
// a site, then a typed turn ("open its sign-in page and pause there") opened
// the sign-in page and ended waiting for the person's fields. The modal and
// its controls are production components; boundaries.ts holds the stand-ins.

const params = new URLSearchParams(location.search);
const PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUNTIME_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CARD_RUN_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PAUSE_RUN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const USER_ID = "review-user";
const PARTICIPANT_ID = "review-participant";
const PAGE = {
  id: "PAGE1", url: "https://code.example/login", host: "code.example", label: "Sign in to Code Example",
  title: "Sign in to Code Example", isActive: true, lastReferencedAt: 0,
};
const noop = () => {};

declare global {
  interface Window {
    __browserPauseReview: {
      hooks: { createElement: typeof createElement; useEffect: typeof useEffect; useRef: typeof useRef; useState: typeof useState };
      participantId: string;
      /** Who holds the browser when the view opens: the person, or nobody. */
      owner: { kind: "human"; participantId: string } | null;
      takeControlCalls: number;
      actions: RuntimeBrowserSessionAction[];
      continuations: string[];
    };
  }
}

const now = Date.now();
const step = (seq: number, label: string, url: string | null): RuntimeBrowserSessionAction => ({
  seq, ts: now - 60_000 + seq, pageId: PAGE.id, type: "navigate", label, url, x: null, y: null, viewportW: null, viewportH: null,
});
window.__browserPauseReview = {
  hooks: { createElement, useEffect, useRef, useState },
  participantId: PARTICIPANT_ID,
  owner: params.get("control") === "free" ? null : { kind: "human", participantId: PARTICIPANT_ID },
  takeControlCalls: 0,
  actions: [
    // The card's turn.
    step(1, "Go to https://code.example/", "https://code.example/"),
    // The typed turn: the sign-in page, then the pause on its fields.
    step(2, "Go to https://code.example/login", "https://code.example/login"),
    {
      ...step(3, "Waiting for you", null), type: "human_input",
      humanInputRequest: {
        version: 1, handoffId: "review-handoff", runId: PAUSE_RUN_ID, initiatorUserId: USER_ID, browserPageId: PAGE.id,
        origin: "https://code.example", createdAtMs: now, expiresAtMs: now + 600_000,
        fields: [{ label: "Username or email address" }, { label: "Password" }],
      },
    } as RuntimeBrowserSessionAction,
  ],
  continuations: [],
};

const run = (id: string, minutesAgo: number) => ({
  id, projectId: PROJECT_ID, conversationId: CONVERSATION_ID, status: "completed",
  createdAt: new Date(now - minutesAgo * 60_000).toISOString(),
  metadata: { browserTransport: "shared", browserRuntimeId: RUNTIME_ID, browserPageId: PAGE.id, initiatingUserId: USER_ID },
}) as unknown as RunRecord;
const humanInputRunIds = sharedBrowserConversationRunIds([run(CARD_RUN_ID, 3), run(PAUSE_RUN_ID, 1)], {
  projectId: PROJECT_ID, conversationId: CONVERSATION_ID, runtimeId: RUNTIME_ID, pageId: PAGE.id,
});

function ChatBrowserView() {
  // Studio's chat column: beside its 14rem sidebar on a desktop-wide window,
  // the whole width on a phone. Its toolbar is compact as ChatPanel decides.
  const desktop = useStudioDesktopLayout();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const panel = panelRef.current!;
    const measure = () => setPanelWidth(Math.round(panel.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);
  const compact = shouldUseCompactBrowserChrome({ containerWidth: panelWidth, compactViewport: !desktop });
  return (
    <main style={{ display: "flex", width: "100%", height: "100dvh" }}>
      {desktop ? <nav aria-label="Chats" style={{ width: "14rem", flex: "none", borderRight: "1px solid #e2e8f0" }} /> : null}
      <div ref={panelRef} data-testid="review-chat-panel" data-compact={compact ? "true" : "false"}
        style={{ display: "flex", flex: "1 1 0%", minWidth: 0, flexDirection: "column" }}>
        <BrowserSessionModal isOpen onOpenChange={noop} projectId={PROJECT_ID} currentUserId={USER_ID}
          browserSessionId="review-session" preferRuntimeId={null} resumeRuntimeId={RUNTIME_ID}
          presentation="docked" fillContainer transportActive canControlBrowser canClearBrowserData
          controlOwner={{ kind: "human" }} conversationId={CONVERSATION_ID} chatPageIds={[PAGE.id]}
          humanInputIdentityKey={JSON.stringify([USER_ID, PROJECT_ID, CONVERSATION_ID, "shared", true, RUNTIME_ID, PAGE.id])}
          humanInputRunIds={humanInputRunIds} onTakeOverAgent={null}
          onContinueAfterHumanInput={async (message) => { window.__browserPauseReview.continuations.push(message); return true; }}
          sharedBrowserCapabilitiesResolved sharedBrowserCapabilitiesAvailable
          sharedBrowserViewerKind="cdp-screencast" sharedBrowserAvailableViewerKinds={["cdp-screencast"]}
          sharedBrowserChrome={{
            compact, resolved: true, pendingAction: null, error: null, pages: [PAGE],
            onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop,
          }} />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<ChatBrowserView />);
