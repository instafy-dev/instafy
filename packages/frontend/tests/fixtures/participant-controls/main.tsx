import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../../src/components/Button";
import { Text } from "../../../src/components/Text";
import { ConversationRoster } from "../../../src/screens/studio/components/ConversationRoster";
import { setParticipantsDrawerOpen, useParticipantsDrawerOpen } from "../../../src/screens/studio/components/chatParticipantsStore";
import { SharedBrowserChrome } from "../../../src/screens/studio/components/SharedBrowserChrome";
import { SharedBrowserCollaborationControls } from "../../../src/screens/studio/components/SharedBrowserCollaborationControls";
import { SharedBrowserSessionControl } from "../../../src/screens/studio/components/SharedBrowserSessionControl";
import { BrowserExpandButton } from "../../../src/screens/studio/components/BrowserExpandButton";
import { BrowserStatusPill } from "../../../src/screens/studio/components/BrowserChromeShell";
import { BrowserTransportSelector } from "../../../src/screens/studio/components/PersonalBrowserSurface";
import { SharedBrowserApprovalPrompt } from "../../../src/screens/studio/components/SharedBrowserApprovalPrompt";
import { StudioDialogModal } from "../../../src/components/aria/StudioModal";
import { StudioDialogBody, StudioDialogHeader } from "../../../src/components/aria/StudioDialogLayout";
import { shouldUseCompactBrowserChrome } from "../../../src/screens/studio/components/browserSessionLayout";
import { collaborationSelfOwnsControl, type SharedBrowserCollaborationClientState, type SharedBrowserCollaborationState } from "../../../src/screens/studio/components/sharedBrowserCollaboration";
import "./review.css";

const scenarios = ["self", "peer", "requested", "incoming", "agent", "read-only", "empty", "approval"] as const;
type Scenario = typeof scenarios[number];
const params = new URLSearchParams(location.search);
const requestedScenario = params.get("state");
const initialScenario: Scenario = scenarios.find(value => value === requestedScenario) ?? "self";
const explicitCompact = params.get("compact");
const showControls = params.get("controls") !== "0";
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");

const basePeople = [
  { id: "self", displayName: "Taylor Chen", color: "#0284c7" },
  { id: "peer", displayName: "Alexandria Montgomery, Platform and Accessibility Engineering", color: "#7c3aed" },
  { id: "grace", displayName: "Grace Rivera", color: "#15803d" },
  { id: "sam", displayName: "Sam Patel", color: "#b45309" },
  { id: "riley", displayName: "Riley Kim", color: "#be123c" },
  { id: "jordan", displayName: "Jordan Morgan", color: "#0f766e" },
];
const count = Math.max(6, Math.min(24, Number(params.get("count")) || 6));
const people = Array.from({ length: count }, (_, index) => basePeople[index] ?? {
  id: `person-${index + 1}`, displayName: `Review participant ${index + 1}`, color: basePeople[index % basePeople.length].color,
});
const agents = [
  { handle: "octo", displayName: "Octo", avatarSeed: "octo" },
  { handle: "reviewer", displayName: "Reviewer", avatarSeed: "reviewer" },
];

function clientFor(scenario: Scenario): SharedBrowserCollaborationClientState {
  if (scenario === "empty") return { connectionStatus: "connected", participantId: null, state: null, error: null };
  return {
    connectionStatus: "connected", participantId: "self", error: null,
    state: {
      revision: 1,
      participants: people.map(person => ({ ...person, canControl: !(scenario === "read-only" && person.id === "self"), pageId: "review-page", cursor: null })),
      controlOwner: scenario === "agent" || scenario === "approval" ? { kind: "agent", displayName: "Octo" }
        : { kind: "human", participantId: ["peer", "requested", "read-only"].includes(scenario) ? "peer" : "self" },
      requests: scenario === "requested" ? ["self"] : scenario === "incoming" ? ["peer", "grace"] : [],
    },
  };
}

function Review() {
  const [scenario, setScenario] = useState(initialScenario);
  const [client, setClient] = useState(() => clientFor(initialScenario));
  const [dark, setDark] = useState(params.get("theme") === "dark");
  const [address, setAddress] = useState("https://fixture.example.test/project-review");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [approvalVisible, setApprovalVisible] = useState(initialScenario === "approval" || params.get("approval") === "1");
  const [actionLog, setActionLog] = useState("No local action yet.");
  const drawerOpen = useParticipantsDrawerOpen();
  const previousDrawerOpen = useRef(drawerOpen);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [surfaceWidth, setSurfaceWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const update = () => setSurfaceWidth(surface.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (previousDrawerOpen.current !== drawerOpen) {
      setActionLog(`Conversation participants drawer requested: ${drawerOpen ? "open" : "closed"}. Drawer content is outside this fixture.`);
      previousDrawerOpen.current = drawerOpen;
    }
  }, [drawerOpen]);
  const compact = explicitCompact === "1" ? true : explicitCompact === "0" ? false
    : shouldUseCompactBrowserChrome({ containerWidth: surfaceWidth, compactViewport: innerWidth <= 900 });
  const changeState = (update: (state: SharedBrowserCollaborationState) => SharedBrowserCollaborationState, message: string) => {
    setClient(current => current.state ? { ...current, state: { ...update(current.state), revision: current.state.revision + 1 } } : current);
    setActionLog(message);
  };
  const record = (message: string) => setActionLog(message);
  const owner = client.state?.controlOwner?.kind === "agent" ? client.state.controlOwner : { kind: "human" as const };
  const humans = scenario === "empty" ? [] : people.map(person => ({ userId: person.id, label: person.displayName, isSelf: person.id === "self" }));
  const selectScenario = (next: Scenario) => {
    setScenario(next);
    setClient(clientFor(next));
    setOptionsOpen(false);
    setApprovalVisible(next === "approval");
    record(`Local scenario: ${next}.`);
  };

  return <main className="review-page">
    {showControls ? <header className="review-heading">
      <div><Text as="h1" variant="bodyStrong" tone="primary">Participant controls review</Text>
        <Text as="p" variant="caption" tone="muted">Production controls. All participants and actions are local examples.</Text></div>
      <div className="review-controls">
        <label>State <select aria-label="Review state" value={scenario} onChange={event => selectScenario(event.target.value as Scenario)}>
          {scenarios.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <Button preset="inline" variant="ghost" onPress={() => { document.documentElement.classList.toggle("dark", !dark); setDark(!dark); }}>{dark ? "Light" : "Dark"}</Button>
      </div>
    </header> : null}
    <section className="review-section" aria-label="Conversation participants review">
      <Text as="h2" variant="bodyStrong" tone="primary">Conversation participants</Text>
      <div className="review-surface" data-testid="review-conversation-surface">
        <div className="review-conversation-header">
          <Text variant="bodyStrong" tone="primary">Project review</Text>
          <ConversationRoster placement="header" humans={humans} agents={scenario === "empty" ? [] : agents} hasCredentialWarning={scenario === "agent"} />
        </div>
        <div className="review-content"><Text as="p" variant="body" tone="secondary">A shared conversation with people and AI participants.</Text>
          <Text as="p" variant="caption" tone="muted">Sample chat content. The roster opens a labelled local member preview; the full participants drawer is outside this review.</Text></div>
      </div>
    </section>
    <section className="review-section" aria-label="Browser participants review">
      <Text as="h2" variant="bodyStrong" tone="primary">Browser participants and control</Text>
      <div ref={surfaceRef} className="review-surface" data-testid="review-browser-surface" data-compact={compact} data-expanded={expanded}>
        <SharedBrowserChrome compact={compact} resolved
          pages={[{ id: "review-page", url: address, host: "fixture.example.test", label: "Project review", title: "Project review", isActive: true, canGoBack: true, canGoForward: true }]}
          pendingAction={null} error={null} controlOwner={owner} interactionEnabled={collaborationSelfOwnsControl(client)}
          onNavigate={(_id, value) => { setAddress(value); record("Address updated locally; no navigation started."); }}
          onBack={() => record("Back selected locally.")} onForward={() => record("Forward selected locally.")} onReload={() => record("Reload selected locally.")}
          onFocusPage={() => record("Page selected locally.")} onClearError={() => record("Message dismissed locally.")}
          toolbarLeading={<BrowserTransportSelector checked compact={compact} mode="shared" personalAvailable onModeChange={mode => record(`Browser location ${mode} selected locally; no browser started.`)} />}
          toolbarStatus={compact ? null : <BrowserStatusPill state="ready" />}
          toolbarActions={navigation => <>
            <SharedBrowserCollaborationControls client={client} compact={compact} localControlOwner={owner}
              onRequestControl={() => changeState(state => ({ ...state, requests: [...state.requests, "self"] }), "Control requested locally.")}
              onReleaseControl={() => changeState(state => ({ ...state, controlOwner: null, requests: [] }), "Control released locally.")}
              onTakeControl={() => changeState(state => ({ ...state, controlOwner: { kind: "human", participantId: "self" } }), "Control taken locally.")}
              onGrantControl={id => changeState(state => ({ ...state, controlOwner: { kind: "human", participantId: id }, requests: state.requests.filter(request => request !== id) }), `Control granted to ${people.find(person => person.id === id)?.displayName ?? id} locally.`)} />
            <SharedBrowserSessionControl runtimeId="local-review" resumeUrl={null} open={optionsOpen} busy={false} candidates={[]} error={null} canStart
              onOpenChange={setOptionsOpen} onChoose={() => record("Session selected locally.")} onRefresh={() => record("Sessions refreshed locally.")}
              onStart={() => { record("New session selected locally; no browser started."); setOptionsOpen(false); }}
              actions={compact ? <>{navigation}<BrowserExpandButton expanded={expanded} showLabel onPress={() => { setExpanded(!expanded); setOptionsOpen(false); record("Browser expansion toggled locally."); }} /></> : null} />
            {!compact ? <BrowserExpandButton expanded={expanded} onPress={() => { setExpanded(!expanded); record("Browser expansion toggled locally."); }} /> : null}
          </>} />
        <div className={`review-content review-browser-page ${approvalVisible ? "review-approval-page" : ""}`}><Text as="p" variant="bodyStrong" tone="primary">Project overview</Text>
          <Text as="p" variant="body" tone="secondary">Review the page together, request control, or hand it to a teammate.</Text>
          <Text as="p" variant="caption" tone="muted">This is sample page content. No remote browser, authentication or transport is started.</Text>
          {approvalVisible ? <SharedBrowserApprovalPrompt request={{ approvalId: "review-approval", kind: "origin", operation: "navigate", sourceOrigin: null, destinationOrigin: "https://fixture.example.test", expiresAtMs: Date.now() + 600_000, display: { label: "Project overview", destinationOrigin: "https://fixture.example.test" } }} submitting={false}
            onDecision={decision => { record(`Approval decision ${decision} recorded locally; no permission or browser action changed.`); setApprovalVisible(false); }} /> : null}
        </div>
      </div>
    </section>
    <Text as="p" variant="caption" tone="muted" role="status" className="review-log" data-testid="review-action-log">{actionLog}</Text>
    <StudioDialogModal isOpen={drawerOpen} onOpenChange={setParticipantsDrawerOpen} isDismissable dialogAriaLabel="Conversation participant preview" layout="editor" gutter="responsive">
      <StudioDialogHeader title="Conversation participants" description="Local preview only. The production participants drawer is not mounted." onClose={() => setParticipantsDrawerOpen(false)} closeLabel="Close participant preview" />
      <StudioDialogBody scrollable><ul className="space-y-2">{humans.map(human => <li key={human.userId}><Text variant="body" tone="primary">{human.label}{human.isSelf ? " (you)" : ""}</Text></li>)}</ul></StudioDialogBody>
    </StudioDialogModal>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Review />);
