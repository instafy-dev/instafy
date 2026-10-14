import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "../../../src/components/Button";
import { Text } from "../../../src/components/Text";
import { SegmentedControl } from "../../../src/components/SegmentedControl";
import { StudioDialogModal } from "../../../src/components/aria/StudioModal";
import { StudioDialogBody, StudioDialogHeader } from "../../../src/components/aria/StudioDialogLayout";
import { AgentJobThreadPreviewLayout } from "../../../src/screens/studio/components/AgentJobThreadPreviewLayout";
import { ChatTypingRows } from "../../../src/screens/studio/components/ChatTypingRows";
import { ChatMessageAvatar } from "../../../src/screens/studio/components/ChatMessageAvatar";
import { ChatRunStopNotice, ChatRunStopNoticeProvider } from "../../../src/screens/studio/components/ChatRunStopNotice";
import { useChatRunStopContinuation } from "../../../src/screens/studio/components/useChatRunStopContinuation";
import { useChatRunStop, type ChatRunStopTarget } from "../../../src/screens/studio/components/useChatRunStop";
import type { ThreadCompactEvent } from "../../../src/screens/studio/components/threadPreviewHelpers";
import type { ChatMessage } from "../../../src/screens/studio/types";
import { Composer } from "./Composer";
import "../../../src/styles/tailwind.css";

const VIEWER = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = "22222222-2222-4222-8222-222222222222";
const OCTO: ChatRunStopTarget = {
  jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", runId: "aaaaaaaa-0000-4000-8000-000000000001",
  agentHandle: "octo", agentDisplayName: "Octo", initiatingUserId: VIEWER,
};
const SCRIBE: ChatRunStopTarget = {
  jobId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", runId: "bbbbbbbb-0000-4000-8000-000000000002",
  agentHandle: "scribe", agentDisplayName: "Scribe", initiatingUserId: VIEWER,
};
const SCENARIOS = [
  ["thinking", "Thinking · before any commands"], ["rail", "Working · icon rail"],
  ["command", "Working · single command"], ["recording", "Recording · preserve microphone"], ["two", "Two agents · choose a target"],
  ["other", "Another person's turn"], ["viewer", "Read-only viewer"],
  ["failure", "Cancel request fails"], ["timeout", "Cancel request times out"],
  ["stale", "Run finished before Stop"], ["requested", "Accepted · waiting for live status"],
] as const;
type Scenario = typeof SCENARIOS[number][0];
const command = "pnpm --filter @instafy/frontend exec playwright test tests/playwright/component/run-stop-control.spec.ts --reporter=list";
const message: ChatMessage = {
  id: "fixture-run-thread", role: "assistant", authorId: null, content: "", timestamp: 0,
  files: null, messageType: "agent_job_thread",
  metadata: { messageType: "agent_job_thread", jobId: OCTO.jobId, agent: { handle: "octo" } },
};
const events: ThreadCompactEvent[] = [
  { id: "thinking", kind: "thinking", previewText: "Reviewing the task" },
  { id: "search", kind: "search", previewText: "Looking up the relevant files" },
  { id: "command", kind: "command", previewText: command },
];

function Rail({ single, running }: { single: boolean; running: boolean }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const visible = single ? [events[2]] : events;
  return <AgentJobThreadPreviewLayout
    message={message} projectId="fixture-project" branchThreads={[]} hideThreadSpine
    showHeaderAvatar={false} showHeaderIdentity={false} assistantAvatarMotion="idle" hiddenUpdateCount={0}
    isHybridCompactionActive={false} isThreadPreviewExpanded={false}
    visibleCompactEvents={visible} overflowCompactCount={0} latestCompactEventId={visible.at(-1)!.id}
    showCompactRailWaitingSpinner={!single && running} isThreadUnresolved={running}
    singleCompactEvent={single ? events[2] : null} singleCompactEventLabel={command}
    showSingleCompactEventStatusSweep={running} canCancelTerminalRun={false} cancelPending={false}
    compactRailStatusText={command} shouldSweepCompactRailStatusText={running}
    showCollapsedCompactRailStatus={!single} showLiveCommandOutput={false} showLiveCommandPlaceholder={single && running}
    showCollapsedCommandToggle={false} showCollapsedCommandOutput={false}
    latestCommandExecution={{ command, output: null, status: running ? "in_progress" : "completed" }}
    latestCommandAgentHandle={null} latestCommandPreview={command} updatesForInlineRendering={[]} expandedUpdateIds={{}}
    finalSummaryMessage={null} hasPreview={false} previewText="" showSummaryBody={false}
    suppressSummaryRunningStatus={false} isCompleted={!running} showRunningSpinnerFallback={false}
    shouldAnimateThreadLiveState={running} runningStatusLabel={null} useCompactRunningPreview={false}
    runningPreviewHasOverflow={false} latestFiles={null} isRunning={running} finalSpineTone="primary"
    threadPreviewRootRef={rootRef} threadPreviewRef={railRef} runningPreviewContainerRef={previewRef}
    threadPreviewRootStyle={{}} threadPreviewRailStyle={{ top: "32px", bottom: "0px" }}
    threadSpineJunctionOffsetClass="left-0" threadSpineHeaderOffsetClass="left-0" summaryBodyPaddingTopClass="pt-1"
    onOpenBranchThread={() => {}} onExpandThreadPreview={() => {}} onCollapseThreadPreview={() => {}}
    onToggleThreadPreview={() => {}} onToggleCommandOutput={() => {}} onToggleUpdateExpanded={() => {}}
    onCancelRun={() => { throw new Error("Legacy cancel must not be invoked"); }}
    MessageContent={({ content }) => <span>{content}</span>} ChatFileChangeList={() => null}
  />;
}

function Simulation({ scenario }: { scenario: Scenario }) {
  const [targets, setTargets] = useState<ChatRunStopTarget[]>(() => scenario === "two" ? [OCTO, SCRIBE]
    : [{ ...OCTO, initiatingUserId: scenario === "other" ? "another-person" : VIEWER }]);
  const [requests, setRequests] = useState<string[][]>([]);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [continuations, setContinuations] = useState<string[][]>([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [labelExpanded, setLabelExpanded] = useState(false);
  const useRail = scenario === "rail" || scenario === "command";
  const controller = useChatRunStop({
    conversationId: CONVERSATION, targets, viewerUserId: VIEWER, canStop: scenario !== "viewer", active: true,
    cancelJobs: async (conversationId, jobIds) => {
      if (conversationId !== CONVERSATION) throw new Error("Incorrect conversation");
      setRequests(current => [...current, [...jobIds]]);
      if (scenario === "timeout") return new Promise(() => {});
      await new Promise(resolve => setTimeout(resolve, 750));
      if (scenario === "failure") throw new Error("Simulated connection failure. Try again.");
      return {
        ok: true,
        canceledJobIds: scenario === "stale" ? [] : [...jobIds],
        canceledRunIds: scenario === "stale" ? [] : targets.filter(target => jobIds.includes(target.jobId)).map(target => target.runId),
        alreadyFinishedJobIds: scenario === "stale" ? [...jobIds] : [],
      };
    },
    onStopped: (result, captured) => {
      if (scenario !== "requested") setTargets(current => current.filter(target => !captured.some(stopped => stopped.jobId === target.jobId)));
      const stopped = captured.filter(target => result.canceledJobIds.includes(target.jobId));
      if (stopped.length) setHistory(current => [...current, {
        ...message, id: crypto.randomUUID(), messageType: "run_cancellation", timestamp: Date.now(),
        metadata: { details: { stopRequested: true, actorUserId: VIEWER,
          agentHandles: stopped.map(target => target.agentHandle), jobIds: stopped.map(target => target.jobId),
          runIds: stopped.map(target => target.runId) } },
      }]);
    },
  });
  const continuation = useChatRunStopContinuation({
    conversationId: CONVERSATION, viewerUserId: VIEWER, humanLabelByUserId: new Map(),
    canWrite: scenario !== "viewer", busy: targets.length > 0, messages: history, queuedSends: [],
    submitMessage: async (override) => {
      const handles = override?.targetAgentHandles ?? [];
      setContinuations(current => [...current, [...handles]]);
      await new Promise(resolve => setTimeout(resolve, 350));
      setHistory(current => [...current, { ...message, id: crypto.randomUUID(), role: "user",
        content: override?.message ?? "", metadata: override?.metadata ?? null }]);
      setTargets(handles.map(handle => ({ ...(handle === "scribe" ? SCRIBE : OCTO),
        jobId: crypto.randomUUID(), runId: crypto.randomUUID(), initiatingUserId: VIEWER })));
      return true;
    },
  });
  const running = targets.length > 0;
  const identities = targets.map(target => ({ handle: target.agentHandle, displayName: target.agentDisplayName, avatarSeed: target.agentHandle, isThinking: true }));
  return <>
    <section className="min-h-52 rounded-2xl border border-slate-200 bg-white px-4 py-5 dark:border-slate-700 dark:bg-[var(--color-studio-dark-panel)]" aria-label="Live preview" data-testid="stop-preview">
      <Text as="p" variant="caption" tone="muted" className="mb-5">{scenario === "viewer" ? "Read-only access" : "Live activity"}</Text>
        {useRail ? <div className="mx-auto max-w-2xl"><Rail single={scenario === "command"} running={running} /></div> : null}
        <ChatTypingRows peerTypingLabel={null} isAssistantTyping={running}
          isAssistantTypingCoveredByJobThreadPreview={useRail}
          typingAgents={identities} hasMultipleTypingAgents={identities.length > 1}
          typingAgentHandle={targets[0]?.agentHandle ?? "octo"} typingAgentAvatarSeed={targets[0]?.agentHandle ?? "octo"}
          typingIndicatorState={{ phase: "thinking", label: "Thinking…" }} typingStatusLabel="Thinking…"
          typingStatusAriaLabel={identities.length > 1 ? "Octo and Scribe are thinking" : "Octo is thinking"}
          isThinkingLabelExpanded={labelExpanded} onToggleThinkingLabel={() => setLabelExpanded(value => !value)}
          latestDisplayedMessageId="last-message"
          renderAssistantAvatar={(_metadata, identity) => <ChatMessageAvatar kind="assistant" agent={identity ?? { handle: "octo", avatarSeed: "octo" }} />}
        />
      <ChatRunStopNoticeProvider value={continuation}>
        {history.filter(entry => entry.messageType === "run_cancellation").map(entry => <ChatRunStopNotice key={entry.id} message={entry} />)}
      </ChatRunStopNoticeProvider>
      {!running ? <Text as="p" variant="caption" tone="muted" data-testid="simulation-finished">The simulated run is no longer active.</Text> : null}
    </section>
    <Composer controller={controller}
      readOnly={scenario === "viewer"} recording={scenario === "recording"} />
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onPress={() => setModalOpen(true)}>Open dialog</Button>
      <Button variant="outline" size="sm" onPress={() => setTargets([])}>Simulate completion</Button>
    </div>
    <Text as="p" variant="caption" tone="muted" role="status" data-testid="cancel-request-count">Cancel requests: {requests.length}</Text>
    <output hidden data-testid="cancel-requests">{JSON.stringify(requests)}</output>
    <output hidden data-testid="continuation-requests">{JSON.stringify(continuations)}</output>
    <StudioDialogModal isOpen={modalOpen} onOpenChange={setModalOpen} isDismissable dialogAriaLabel="Preview dialog">
      <StudioDialogHeader title="Preview dialog" onClose={() => setModalOpen(false)} />
      <StudioDialogBody><Text>Escape closes this dialog before it can stop a run.</Text></StudioDialogBody>
    </StudioDialogModal>
  </>;
}

function Playground() {
  const [scenario, setScenario] = useState<Scenario>("thinking");
  const [revision, setRevision] = useState(0);
  const [theme, setTheme] = useState("light");
  return <main className="mx-auto max-w-5xl space-y-5 p-4 sm:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1"><Text as="h1" variant="title" tone="primary">Run Stop playground</Text>
        <Text as="p" variant="body" tone="muted">Actual interface components with simulated runs.</Text></div>
      <SegmentedControl aria-label="Preview theme" value={theme} onChange={value => { setTheme(value); document.documentElement.classList.toggle("dark", value === "dark"); }}
        width="fit" options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
    </header>
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm text-slate-600 dark:text-slate-300">Scenario
        <select aria-label="Scenario" value={scenario} onChange={event => setScenario(event.target.value as Scenario)}
          className="min-h-11 max-w-full rounded-lg border border-slate-300 bg-white px-3 text-slate-800 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100">
          {SCENARIOS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>
      <Button variant="outline" onPress={() => setRevision(value => value + 1)}>Restart</Button>
    </div>
    <Simulation key={`${scenario}:${revision}`} scenario={scenario} />
    <Text as="p" variant="caption" tone="muted">Try Stop or Escape. Choose two agents to open the target menu. Requests here never reach a real account or run.</Text>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Playground />);
