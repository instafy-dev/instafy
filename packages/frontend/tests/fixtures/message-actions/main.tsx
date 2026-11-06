import { useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { MoreHoriz } from "iconoir-react";
import { Button, IconButton } from "../../../src/components/Button";
import { Text } from "../../../src/components/Text";
import { ChatInvitePromptOverlay, ChatMessageMenuOverlay } from "../../../src/screens/studio/components/ChatPanelOverlays";
import { clampFloatingSurfacePositionToStudioViewport } from "../../../src/utils/floatingSurfacePosition";
import "../../../src/styles/tailwind.css";
import "./review.css";

type MessageMenu = ComponentProps<typeof ChatMessageMenuOverlay>["messageMenu"];
const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
if (params.get("text") === "large") document.documentElement.style.fontSize = "24px";

const usage: ComponentProps<typeof ChatMessageMenuOverlay>["selectedMessageTokenUsage"] = {
  inputTokens: 18720, cachedInputTokens: 12288, outputTokens: 1340,
  context: { mode: "full", estimatedPromptTokens: 18720, estimatedPromptUsagePercent: 15,
    estimatedHistoryTokens: 14400, modelContextWindow: 128000,
    totalTurns: 24, includedTurns: 18, summarizedTurns: 4, omittedTurns: 2 },
};
const initialDraft = "@Alex Can you review the updated navigation before we send it?";

function App() {
  const [menu, setMenu] = useState<MessageMenu>(null);
  const [invite, setInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(initialDraft);
  const [event, setEvent] = useState("No action yet");
  const surface = params.get("surface") ?? "actions";
  const longNames = params.get("names") === "long";
  const showMenu = (element: HTMLElement, view: "actions" | "token_usage") => {
    element.focus({ preventScroll: true });
    const rect = element.getBoundingClientRect();
    const edge = params.get("anchor") === "edge";
    const position = clampFloatingSurfacePositionToStudioViewport({
      clientX: edge ? innerWidth - 16 : rect.left, clientY: edge ? innerHeight - 16 : rect.bottom + 8,
      surfaceWidth: 256, surfaceHeight: 200, padding: 12,
    });
    setMenu({ kind: "message", messageId: "review-message", view, ...position });
  };
  const action = (value: string) => { setEvent(value); setMenu(null); };
  const openSurface = (element: HTMLElement) => {
    element.focus({ preventScroll: true });
    if (surface.startsWith("invite")) { setBusy(surface === "invite-busy"); setInvite(true); }
    else showMenu(element, surface === "stats" ? "token_usage" : "actions");
  };
  return <main className="review-page">
    <header className="review-header"><Text as="h1" variant="subtitle" tone="primary">Website refresh</Text><Text variant="caption" tone="muted">Private chat · Local interaction fixture</Text></header>
    <section className="review-conversation" aria-label="Conversation">
      <article className="review-message">
        <div className="review-message-heading"><Text as="span" variant="bodyStrong" tone="primary">Octo</Text><IconButton aria-label="Message actions" data-testid="message-actions-trigger" variant="ghost" size="sm" onPress={event => showMenu(event.target, "actions")}><MoreHoriz aria-hidden="true" className="h-4 w-4" /></IconButton></div>
        <Text tone="primary">The navigation is ready for review.</Text>
        <Text tone="secondary">Keep related controls together, preserve the draft, and make the return path easy to find.</Text>
        <Text variant="caption" tone="muted">Selected passage: “Keep related controls together”</Text>
      </article>
      <div className="review-launch"><Button preset="inline" variant="outline" data-testid="review-open" onPress={event => openSurface(event.target)}>{surface === "stats" ? "Review message stats" : surface.startsWith("invite") ? "Review invitation" : "Review message actions"}</Button></div>
    </section>
    <form className="review-composer" onSubmit={event => { event.preventDefault(); setInvite(true); }}>
      <label htmlFor="draft"><Text as="span" variant="captionStrong" tone="muted">Draft</Text></label>
      <textarea id="draft" data-testid="review-draft" value={draft} onChange={event => setDraft(event.target.value)} rows={3} />
      <div className="review-composer-actions"><Text variant="caption" tone="muted">Alex hasn’t joined this private chat.</Text><Button type="button" preset="inline" variant="ghost" data-testid="invite-trigger" onPress={event => { event.target.focus({ preventScroll: true }); setBusy(false); setInvite(true); }}>Mention teammate</Button></div>
    </form>
    <output data-testid="review-event" className="review-event">{event}</output>
    <ChatMessageMenuOverlay messageMenu={menu} selectedMessageTimestamp={Date.UTC(2026, 10, 5, 10, 42)} selectedMessageTokenUsage={usage}
      onClose={() => setMenu(null)} selectedTextAvailable
      onShowActionsView={() => setMenu(value => value ? { ...value, view: "actions" } : null)}
      onShowTokenUsageView={() => setMenu(value => value ? { ...value, view: "token_usage" } : null)}
      onCopySelectedMessage={() => action("Copied message")}
      onCopyConversation={() => action("Copied conversation")}
      onCopyTokenUsage={() => { setEvent("Copied stats"); }}
      onReplyToSelection={() => action("Reply to selection")}
      onSummarizeSelection={() => action("Summarize selection")}
      onExplainSelection={() => action("Explain selection")}
      onOpenThread={() => action("Opened thread")} />
    <ChatInvitePromptOverlay invitePrompt={invite ? { missingUsers: longNames ? [
      { displayName: "Alexandria Constantinopoulos", handle: "alexandria" },
      { displayName: "Samir Devendrakumar-Ramachandran", handle: "samir" },
      { displayName: "Jamie from the design accessibility team", handle: "jamie" },
    ] : [{ displayName: "Alex", handle: "alex" }] } : null} invitePromptBusy={busy}
      onClose={() => { setInvite(false); setEvent("Invitation cancelled"); }}
      onSendWithout={() => { setInvite(false); setEvent("Sent without mention"); }}
      onInviteAndSend={() => { setBusy(true); setEvent("Invitation started"); }} />
  </main>;
}

createRoot(document.getElementById("root")!).render(<App />);
