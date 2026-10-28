import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../../src/components/Button";
import { Surface } from "../../../src/components/Surface";
import { Text } from "../../../src/components/Text";
import { SharedBrowserApprovalPrompt, type SharedBrowserApprovalDecision, type SharedBrowserApprovalPromptRequest } from "../../../src/screens/studio/components/SharedBrowserApprovalPrompt";
import { LocalTabControlRequests } from "../../../src/screens/studio/components/LocalTabControlRequests";
import { BrowserToolsPopover } from "../../../src/screens/studio/components/BrowserToolsPopover";
import { BrowserHumanInputStatus } from "../../../src/screens/studio/components/BrowserHumanInputControls";
import { BrowserReadingRow } from "../../../src/screens/studio/components/BrowserReadingRow";
import { SharedBrowserProfileStatus } from "../../../src/screens/studio/components/SharedBrowserProfileStatus";
import { ChatRunStopControl, ChatRunStopFeedback } from "../../../src/screens/studio/components/ChatRunStopControl";
import { MessageContent } from "../../../src/screens/studio/components/ChatMessageContent";
import type { ChatRunStopController } from "../../../src/screens/studio/components/useChatRunStop";
import type { LocalTabControlState } from "../../../src/services/runtimeController/localTabControl";
import type { LocalExploreState } from "../../../src/services/runtimeController/localTabExplore";
import "../../../src/styles/tailwind.css";

const query = new URLSearchParams(location.search);
const surface = query.get("surface") ?? "approval";
document.documentElement.classList.toggle("dark", query.get("theme") === "dark");
const LONG_ERROR = "The browser could not confirm the control change. Your current page and unfinished work are still available. Check your connection and try again before continuing.";
const STOP_ERROR = "The run could not be stopped. The AI may still be working. Check your connection and retry stopping before starting another task.";
const people = [
  { userId: "alice", fullName: "Alice Morgan", email: "alice@example.test" },
  { userId: "bob", fullName: "Bob Chen", email: "bob@example.test" },
  { userId: "charlie", fullName: "Charlie with a longer display name", email: "charlie@example.test" },
];

function Approval() {
  const [decision, setDecision] = useState("");
  const [pending, setPending] = useState(query.has("submitting"));
  const [visible, setVisible] = useState(true);
  const request: SharedBrowserApprovalPromptRequest = {
    approvalId: "review-approval", kind: surface === "action-approval" ? "action" : "origin",
    operation: "navigate", sourceOrigin: "https://example.test", destinationOrigin: "https://research.example.test",
    expiresAtMs: Date.now() + 3_600_000,
    display: { label: `Open https://research.example.test/${surface === "action-approval" ? "reports/" + "very-long-destination-segment/".repeat(8) : "research/overview"}`, destinationOrigin: "https://research.example.test" },
  };
  const decide = (next: SharedBrowserApprovalDecision) => {
    setDecision(next);
    if (query.has("pending")) setPending(true);
    else setVisible(false);
  };
  return <div className="relative min-h-0 flex-1" data-testid="review-approval-host">
    <div className="p-5"><Text as="p" variant="body">Research notes and browser preview</Text></div>
    {visible ? <SharedBrowserApprovalPrompt request={request} submitting={pending}
      error={query.has("error") ? LONG_ERROR : null} onDecision={decide} /> : null}
    <output hidden data-testid="review-decision">{decision}</output>
  </div>;
}

function Controls() {
  const [open, setOpen] = useState(query.has("open"));
  const [action, setAction] = useState("");
  const [state, setState] = useState<LocalTabControlState>({ type: "controlState", available: true, connectionId: "owner", requested: false,
    grant: query.has("granted") ? { id: "grant-alice", connectionId: "alice-connection", userId: "alice" } : null,
    requests: [...(query.has("granted") ? [] : [{ connectionId: "alice-connection", userId: "alice" }]), { connectionId: "charlie-connection", userId: "charlie" }],
  });
  const [explore, setExplore] = useState<LocalExploreState>({ type: "exploreState", available: true, requested: false, view: null, views: [],
    requests: [{ connectionId: "bob-connection", userId: "bob", viewport: { width: 390, height: 844, dpr: 1 } }],
  });
  const pending = useRef<(() => void) | null>(null);
  useEffect(() => {
    const resolve = () => { pending.current?.(); pending.current = null; };
    window.addEventListener("review:resolve", resolve);
    return () => window.removeEventListener("review:resolve", resolve);
  }, []);
  const perform = async (name: string, update: () => void) => {
    setAction(name);
    if (query.has("pending")) await new Promise<void>(resolve => { pending.current = resolve; });
    if (query.has("fail")) throw new Error(LONG_ERROR);
    update();
  };
  return <div className="p-3">
    <BrowserToolsPopover label="Sharing settings" isOpen={open} onOpenChange={setOpen} placement="bottom start"
      trigger={<Button preset="toolbar" variant="ghost" data-testid="review-controls-trigger">Sharing settings</Button>}>
      <Text variant="bodyStrong">Browser participants</Text>
      <LocalTabControlRequests people={people} state={state} exploreState={explore}
        control={{
          grant: connectionId => perform(`allow:${connectionId}`, () => setState(previous => ({ ...previous,
            grant: { id: "review-grant", connectionId, userId: previous.requests!.find(item => item.connectionId === connectionId)!.userId },
            requests: previous.requests!.filter(item => item.connectionId !== connectionId),
          }))),
          revoke: () => perform("take-back", () => setState(previous => ({ ...previous, grant: null }))),
          deny: connectionId => { setAction(`deny:${connectionId}`); setState(previous => ({ ...previous, requests: previous.requests!.filter(item => item.connectionId !== connectionId) })); },
        }}
        explore={{
          approve: request => perform(`browse:${request.connectionId}`, () => setExplore(previous => ({ ...previous, requests: [], views: [{ ...request, viewId: "review-view" }] }))),
          deny: connectionId => { setAction(`deny-browse:${connectionId}`); setExplore(previous => ({ ...previous, requests: [] })); },
          close: async () => {},
        }} />
    </BrowserToolsPopover>
    <output hidden data-testid="review-control-action">{action}</output>
    <output hidden data-testid="review-control-grant">{state.grant?.userId ?? "none"}</output>
  </div>;
}

function Handoff() {
  const [requested, setRequested] = useState(query.has("open"));
  const [busy, setBusy] = useState<"takeover" | "continue" | null>(null);
  const [action, setAction] = useState("");
  return <div className="p-3"><BrowserHumanInputStatus identityKey="review-handoff" request={null} canTakeOver humanControlConfirmed={false}
    onTakeOver={async () => {}} onContinue={async () => true}
    state={{ active: false, request: null, busy, error: LONG_ERROR, takeoverRequested: requested,
      requestTakeOver: () => setRequested(true), dismissTakeOver: () => setRequested(false),
      takeOver: async () => { setAction("take-over"); if (query.has("pending")) setBusy("takeover"); else setRequested(false); },
      continueTask: async () => { setAction("continue"); },
    }} /><output hidden data-testid="review-handoff-action">{action}</output></div>;
}

function Reading() {
  const [action, setAction] = useState("");
  return <><BrowserReadingRow agentName="Octo" canTakeOver error={LONG_ERROR} takingOver={query.has("pending")}
    pages={[{ id: "page-one", url: "https://example.test/research", host: "example.test", label: "Research", title: "Research report with a longer title", isActive: true, lastReferencedAt: 1, openedBy: "agent", agentTabNumber: 1 }]}
    onTakeOver={() => setAction("take-over")} /><output hidden data-testid="review-reading-action">{action}</output></>;
}

function Stop() {
  const [phase, setPhase] = useState<"error" | "stopping">("error");
  const controller: ChatRunStopController = { visible: true, phase, feedbackId: "review-stop-error", targets: [], groups: [], error: STOP_ERROR,
    confirmationTargets: null, requestStop: () => {}, confirmStop: () => {}, dismissConfirmation: () => {}, retry: () => setPhase("stopping") };
  return <div className="mt-auto p-3"><Surface radius="3xl" shadow="none" className="mx-auto max-w-3xl p-3">
    <Text as="p" variant="body" className="pb-3">Please compare these reports.</Text>
    <div className="flex justify-end"><ChatRunStopControl controller={controller} /></div>
    <ChatRunStopFeedback controller={controller} />
  </Surface><output hidden data-testid="review-stop-phase">{phase}</output></div>;
}

function Recovery() {
  const [panel, setPanel] = useState("");
  useEffect(() => {
    const navigate = (event: Event) => setPanel((event as CustomEvent<string>).detail);
    window.addEventListener("review:navigation", navigate);
    return () => window.removeEventListener("review:navigation", navigate);
  }, []);
  return <div className="mx-auto w-full max-w-3xl p-4"><MessageContent content="AI credentials need reconnecting. Reconnect AI credentials, then retry the message." projectId="review-project" />
    <output hidden data-testid="review-recovery-panel">{panel}</output></div>;
}

function Review() {
  return <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-white text-slate-900 dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-100" data-testid="browser-approval-feedback-review">
    <header className="shrink-0 border-b border-slate-200 px-4 py-3 dark:border-[var(--color-studio-dark-panel-border)]"><Text as="h1" variant="bodyStrong">Browser research</Text><Text as="p" variant="caption" tone="muted">Production controls · local review data</Text></header>
    {surface === "approval" || surface === "action-approval" ? <Approval /> : surface === "controls" ? <Controls /> : surface === "handoff-error" ? <Handoff /> : surface === "reading-error" ? <Reading /> : surface === "stop-error" ? <Stop /> : surface === "recovery" ? <Recovery /> :
      <div className="mx-auto w-full max-w-md p-4"><SharedBrowserProfileStatus projectId="review-project" runtimeId="review-runtime" active currentUserId="review-user" /></div>}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Review />);
