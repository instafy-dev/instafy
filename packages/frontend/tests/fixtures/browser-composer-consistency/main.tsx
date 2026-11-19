import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Globe } from "iconoir-react";
import { Text } from "../../../src/components/Text";
import { PersonalBrowserTabRow } from "../../../src/screens/studio/components/PersonalBrowserSurface";
import { SharedLocalTabViewer } from "../../../src/screens/studio/components/SharedLocalTabViewer";
import { LocalBrowserTabPublisher } from "../../../src/screens/studio/components/LocalBrowserSharing";
import { BrowserChromeShell, BrowserStatusPill } from "../../../src/screens/studio/components/BrowserChromeShell";
import { BrowserAddressField } from "../../../src/screens/studio/components/BrowserAddressField";
import { useChatRunStop } from "../../../src/screens/studio/components/useChatRunStop";
import { MessageContent } from "../../../src/screens/studio/components/ChatMessageContent";
import { ConversationSurfaceTabs } from "../../../src/workspace/ConversationSurfaceLayout";
import { Composer } from "../run-stop-control/Composer";
import { share } from "../style-followups-controls/browserData";
import "../../../src/styles/tailwind.css";
import "./review.css";

const query = new URLSearchParams(location.search);
const surface = query.get("surface") ?? "tabs";
const browserReview = ["tabs", "shared", "takeback"].includes(surface);
const theme = query.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
if (query.get("text") === "large") document.documentElement.style.fontSize = "24px";
const normalDraft = "Please compare these screenshots.\nKeep the controls easy to reach.";
const mentionDraft = "@octo review the spacing.\n@researcher compare the layout with @alex.";
const mentionState = JSON.stringify({ root: { children: [
  { children: [
    { type: "assistant-mention", version: 1, token: "@octo", text: "@octo", detail: 0, format: 0, mode: "token", style: "" },
    { type: "text", version: 1, text: " review the spacing.", detail: 0, format: 0, mode: "normal", style: "" },
  ], type: "paragraph", version: 1, direction: null, format: "", indent: 0 },
  { children: [
    { type: "agent-mention", version: 1, handle: "researcher", displayName: "Researcher", text: "@researcher", detail: 0, format: 0, mode: "token", style: "" },
    { type: "text", version: 1, text: " compare the layout with ", detail: 0, format: 0, mode: "normal", style: "" },
    { type: "user-mention", version: 1, userId: "review-alex", handle: "alex", displayName: "Alex", text: "@alex", detail: 0, format: 0, mode: "token", style: "" },
    { type: "text", version: 1, text: ".", detail: 0, format: 0, mode: "normal", style: "" },
  ], type: "paragraph", version: 1, direction: null, format: "", indent: 0 },
], type: "root", version: 1, direction: null, format: "", indent: 0 } });

function BrowserReview() {
  const [event, setEvent] = useState("");
  const [closed, setClosed] = useState(false);
  const [takebackRequest, setTakebackRequest] = useState<string>();
  const [address, setAddress] = useState("https://notes.example.test/design-review");
  const [tabs, setTabs] = useState([
    { id: "mine", title: "My design review notes", url: "https://notes.example.test/design-review", active: true, openedBy: "user" as const },
    { id: "research", title: "Accessibility research and design recommendations for narrow screens", url: "https://research.example.test/mobile-layout", active: false, openedBy: "agent" as const },
    { id: "guide", title: "Interface spacing guide", url: "https://guide.example.test/spacing", active: false, openedBy: "agent" as const },
  ]);
  const onEnded = useCallback(() => setEvent("ended"), []);
  useEffect(() => {
    const observe = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      setEvent(detail);
      if (detail === "native-takeback") setTakebackRequest("review-takeback");
    };
    window.addEventListener("consistency-review-action", observe);
    window.addEventListener("style-review-action", observe);
    return () => { window.removeEventListener("consistency-review-action", observe); window.removeEventListener("style-review-action", observe); };
  }, []);
  return <section className="consistency-browser" aria-label="Browser preview" data-testid="review-browser">
    {surface === "shared" ? closed ? <Text role="status">Shared tab closed.</Text> : <SharedLocalTabViewer projectId="review-project" share={share} onClose={() => setClosed(true)} onEnded={onEnded} /> : <>
      <BrowserChromeShell compact label="Browser navigation" clearsToasts={false} testId="review-browser-toolbar"
        address={<BrowserAddressField testIdPrefix="review-address" value={address} onValueChange={setAddress} currentPage={{ url: address, title: "Design review" }} historyUserId={null} onNavigate={() => true} />}
        status={<BrowserStatusPill state="ready" compact />} />
      {surface === "takeback" ? <div className="consistency-publisher"><LocalBrowserTabPublisher projectId="review-project" userId="review-owner" ownerId="review-owner" canShare takeoverRequestId={takebackRequest} /></div> : <PersonalBrowserTabRow tabs={tabs} locked={query.has("locked")}
        onSelect={id => { setTabs(current => current.map(tab => ({ ...tab, active: tab.id === id }))); setEvent(`select:${id}`); }}
        onClose={id => { setTabs(current => current.filter(tab => tab.id !== id)); setEvent(`close:${id}`); }} />}
      <div className="consistency-webpage"><span>FIELDNOTES</span><h1>A calmer place to work.</h1><p>Thoughtful tools leave room for your ideas. Compare the details and keep your conversation close.</p><hr /><h2>Design review</h2><p>Review how the page, its tabs and browser controls work together.</p></div>
    </>}
    <output hidden data-testid="review-browser-event">{event}</output>
  </section>;
}

function ComposerReview() {
  const [activeView, setActiveView] = useState("chat");
  const [suggestionReady, setSuggestionReady] = useState(query.get("state") !== "delayed");
  useEffect(() => {
    if (surface !== "ghost" || suggestionReady) return;
    const timer = window.setTimeout(() => setSuggestionReady(true), 3000);
    return () => window.clearTimeout(timer);
  }, [suggestionReady]);
  const controller = useChatRunStop({ conversationId: null, targets: [], canStop: false, viewerUserId: null });
  const isAccess = surface === "readonly" || surface === "checking";
  const draft = query.get("draft") ?? (surface === "mentions" ? mentionDraft : surface === "placeholder" ? "" : surface === "ghost" ? "Please compare" : normalDraft);
  return <section className="consistency-conversation" aria-label="Conversation preview" data-testid="review-conversation">
    <div className="consistency-transcript"><Text as="h2" variant="bodyStrong" tone="primary">Design review</Text><Text as="p" variant="body" tone="muted">Compare the layout on a phone and a larger screen.</Text>
      <div className="consistency-reply"><MessageContent content="@octo can compare the spacing while @scribe checks the wording." /></div>
    </div>
    <Composer controller={controller} readOnly={isAccess} recording={false} fullPage attachmentCount={0}
      accessNotice={surface === "readonly" ? "You have view-only access to this space. Ask a space administrator for permission to send messages and make changes." : undefined}
      accessChecking={surface === "checking"} queueReview={{ count: 0, initialDraft: draft }}
      chatInputOverrides={{ ...(surface === "mentions" ? { editorState: mentionState, agentHandles: ["octo", "scribe", "researcher"] } : {}), ...(surface === "ghost" && suggestionReady ? { ghostSuggestionRemainder: " these screenshots and focus on spacing." } : {}), ...(surface === "recording" ? { recordingIndicatorActive: true } : {}) }}
      viewNavigation={<ConversationSurfaceTabs presentation="composer" chatPanelId="review-chat" activeId={activeView} resourceId="browser" resources={[{ id: "browser", label: "Browser", panelId: "review-browser-view", icon: <Globe className="h-3.5 w-3.5" /> }]} split={false} wide={false} ratio={.55} onSelect={setActiveView} onSplitChange={() => {}} />} />
    <output hidden data-testid="review-view">{activeView}</output>
  </section>;
}
createRoot(document.getElementById("root")!).render(<main className={`consistency-app ${browserReview ? "browser-primary" : "composer-primary"}`} data-testid="review-app">
  <header className="consistency-heading"><Text variant="bodyStrong" tone="primary">Workspace review</Text><Text variant="caption" tone="muted">Production components · inert data</Text></header>
  <div className="consistency-layout"><ComposerReview /><BrowserReview /></div>
</main>);
