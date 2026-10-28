import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Send } from "iconoir-react";
import { IconButton } from "../../../src/components/Button";
import { Surface } from "../../../src/components/Surface";
import { Text } from "../../../src/components/Text";
import { StudioMenuSeparator } from "../../../src/components/aria/StudioMenu";
import { ChatInput, type ChatInputHandle } from "../../../src/screens/studio/components/chat-input/ChatInput";
import { BrowserTransportSelector } from "../../../src/screens/studio/components/PersonalBrowserSurface";
import { SharedBrowserSessionControl } from "../../../src/screens/studio/components/SharedBrowserSessionControl";
import { SharedBrowserDataClearAction } from "../../../src/screens/studio/components/SharedBrowserDataClearAction";
import { LocalBrowserTabPublisher } from "../../../src/screens/studio/components/LocalBrowserSharing";
import { OctoSilenceHint } from "../../../src/screens/studio/components/OctoSilenceHint";
import type { BrowserRuntimeCandidate } from "../../../src/screens/studio/components/browserSessionRuntimeEnsure";
import "../../../src/styles/tailwind.css";

const query = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", query.get("theme") === "dark");
const surface = query.get("surface") ?? "slash";
const candidates: BrowserRuntimeCandidate[] = [
  { runtimeId: "review-workspace-machine", originId: "review-origin", endpoint: null, mode: "lazy" },
  { runtimeId: "a1b2c3d4-review-session", originId: "review-origin-2", endpoint: null, mode: "session" },
  { runtimeId: "e5f6g7h8-review-session", originId: "review-origin-3", endpoint: null, mode: "session" },
];

function ComposerReview() {
  const [value, setValue] = useState("");
  const [editorState, setEditorState] = useState<string | null>(null);
  const [hintVisible, setHintVisible] = useState(true);
  const editor = useRef<ChatInputHandle>(null);
  useEffect(() => {
    if (surface === "slash" || surface === "mentions") editor.current?.focus();
  }, []);
  return <>
    <div className="flex-1 p-5">
      <Text as="p" variant="body" tone="secondary">Review the browser handoff and keep the changes easy to follow.</Text>
    </div>
    <section className="mx-auto w-full max-w-4xl space-y-2 p-3" aria-label="Composer review">
      {surface === "silence" && hintVisible ? <OctoSilenceHint onDismiss={() => setHintVisible(false)} /> : null}
      <Surface radius="3xl" shadow="none" className="flex items-end gap-2 p-2">
        <div className="min-w-0 flex-1 px-2">
          <ChatInput ref={editor} value={value} editorState={editorState} placeholder="Message Octo…" ariaLabel="Review message"
            agentHandles={["writer", "researcher", "accessibility-review"]}
            agentProfiles={[
              { handle: "writer", displayName: "Writer" },
              { handle: "researcher", displayName: "Researcher" },
              { handle: "accessibility-review", displayName: "Accessibility review" },
            ]}
            mentionableUsers={[
              { userId: "review-alice", fullName: "Alice Morgan", email: "alice@example.test", role: "editor", createdAt: "2026-01-01" },
              { userId: "review-bob", fullName: "Bob Chen", email: "bob@example.test", role: "editor", createdAt: "2026-01-01" },
            ]}
            onChange={(text, serialized) => { setValue(text); setEditorState(serialized); }}
            onKeyDown={() => {}} compactViewport={matchMedia("(max-width:639px)").matches} />
        </div>
        <IconButton variant="primary" size="md" radius="full" aria-label="Send preview message" onPress={() => {}}>
          <Send className="h-5 w-5" aria-hidden="true" />
        </IconButton>
      </Surface>
      <output hidden data-testid="review-message-value">{value}</output>
      <output hidden data-testid="review-hint-visible">{String(hintVisible)}</output>
    </section>
  </>;
}

function BrowserMenuReview() {
  const [mode, setMode] = useState<"personal" | "shared">(query.get("mode") === "personal" ? "personal" : "shared");
  const [session, setSession] = useState(candidates[0].runtimeId);
  const [sessionsOpen, setSessionsOpen] = useState(query.has("open"));
  const [lastAction, setLastAction] = useState("");
  const busy = query.has("busy");
  return <>
    <div className="flex min-w-0 items-center justify-between gap-3 border-b border-slate-200 px-3 py-2 dark:border-[var(--color-studio-dark-panel-border)]" data-testid="review-browser-toolbar">
      {surface === "location" ? <BrowserTransportSelector checked={!query.has("checking")} personalAvailable={!query.has("unavailable")}
        mode={mode} onModeChange={setMode} /> : null}
      {surface === "sharing" ? <LocalBrowserTabPublisher projectId="review-project" userId="review-owner" ownerId="review-owner-binding" canShare /> : null}
      <Text as="span" variant="bodyCompact" tone="muted" className="min-w-0 flex-1 truncate">example.test/research</Text>
      {surface === "sessions" ? <SharedBrowserSessionControl runtimeId={session}
        resumeUrl={query.has("long") ? `https://example.test/studio?session=${"long-session-".repeat(24)}` : "https://example.test/studio?session=review"} open={sessionsOpen} busy={busy} candidates={candidates}
        error={query.has("error") ? "Could not refresh sessions. Your current browser is still available." : null}
        canStart onOpenChange={setSessionsOpen} onChoose={id => { setSession(id); setSessionsOpen(false); setLastAction(`resume:${id}`); }}
        onStart={() => { setLastAction("start"); setSessionsOpen(false); }} onRefresh={() => setLastAction("refresh")}
        footer={<><StudioMenuSeparator /><SharedBrowserDataClearAction canClear projectId="review-project"
          onClearStart={() => setLastAction("clear-start")} onClearSettled={success => setLastAction(`clear:${success}`)} /></>} /> : null}
    </div>
    <div className="flex-1 p-5"><Text as="p" variant="body" tone="secondary">Research notes</Text></div>
    <output hidden data-testid="review-browser-mode">{mode}</output>
    <output hidden data-testid="review-browser-session">{session}</output>
    <output hidden data-testid="review-browser-action">{lastAction}</output>
  </>;
}

function Review() {
  const browser = ["location", "sessions", "sharing"].includes(surface);
  return <main className="flex min-h-dvh flex-col bg-white text-slate-900 dark:bg-[var(--color-studio-dark-panel)] dark:text-slate-100" data-testid="suggestion-browser-menu-review">
    <header className="px-5 py-4"><Text as="h1" variant="bodyStrong">{browser ? "Browser research" : "Website research"}</Text><Text as="p" variant="caption" tone="muted">Production controls · local review data</Text></header>
    {browser ? <BrowserMenuReview /> : <ComposerReview />}
  </main>;
}

createRoot(document.getElementById("root")!).render(<Review />);
