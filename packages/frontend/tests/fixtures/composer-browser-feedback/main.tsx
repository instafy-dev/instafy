import { useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Globe, NavArrowLeft, Refresh } from "iconoir-react";
import { IconButton } from "../../../src/components/Button";
import { Text } from "../../../src/components/Text";
import { BrowserAddressField } from "../../../src/screens/studio/components/BrowserAddressField";
import { BrowserChromeShell, BrowserStatusPill, type BrowserChromeState } from "../../../src/screens/studio/components/BrowserChromeShell";
import { useChatRunStop } from "../../../src/screens/studio/components/useChatRunStop";
import { ConversationSurfaceTabs } from "../../../src/workspace/ConversationSurfaceLayout";
import { Composer } from "../run-stop-control/Composer";
import "../../../src/styles/tailwind.css";
import "./review.css";

const query = new URLSearchParams(location.search);
const surface = query.get("surface") ?? "actions";
const browserReview = surface.startsWith("browser-");
const theme = query.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.style.colorScheme = theme;
if (query.get("text") === "large") document.documentElement.style.fontSize = "24px";
const initialDraft = query.get("draft") ?? "Please compare these screenshots.\nFocus on the spacing and controls.";
const initialAddress = "https://notes.example.test/design-review";
const errorMessage = "The browser could not reopen this page. Your chat and unfinished work are still available. Check your connection, then try again.";

function BrowserReview() {
  const [address, setAddress] = useState(initialAddress);
  const [event, setEvent] = useState("");
  const [feedback, setFeedback] = useState(surface === "browser-error" ? errorMessage : surface === "browser-success" ? "Browser data cleared. You can continue with a new page." : null);
  const requested = query.get("state");
  const [state, setState] = useState<BrowserChromeState>(surface === "browser-status"
    ? requested === "starting" || requested === "off" || requested === "unavailable" ? requested : "paused"
    : "ready");
  const pane = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);
  useLayoutEffect(() => {
    const node = pane.current;
    if (!node) return;
    const update = () => setCompact(node.clientWidth < 640);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return <section ref={pane} className="review-browser" aria-label="Browser preview" data-testid="review-browser">
    <BrowserChromeShell label="Browser navigation" compact={compact} testId="review-browser-toolbar" clearsToasts={false}
      navigation={<>
        <IconButton aria-label="Back" variant="ghost" isDisabled><NavArrowLeft className="h-4 w-4" aria-hidden="true" /></IconButton>
        <IconButton aria-label="Reload" variant="ghost" onPress={() => setEvent("reload")}><Refresh className="h-4 w-4" aria-hidden="true" /></IconButton>
      </>}
      address={<BrowserAddressField testIdPrefix="review-address" value={address} onValueChange={setAddress}
        currentPage={{ url: initialAddress, title: "Design review" }} historyUserId={null}
        onNavigate={value => { setAddress(value); setEvent("navigate"); return true; }} />}
      status={<BrowserStatusPill state={state} compact={compact} testId="review-browser-status"
        detail={state === "paused" ? "Octo is paused while you review the page." : undefined}
        resume={state === "paused" ? { disabled: query.has("pending"), onPress: () => { setState("ready"); setEvent("resume"); } } : undefined} />}
      feedback={feedback} feedbackTone={surface === "browser-success" ? "success" : "error"}
      feedbackId="review-browser-feedback" feedbackTestId="review-browser-feedback"
      onDismissFeedback={() => { setFeedback(null); setEvent("dismiss"); }} />
    <div className="review-webpage">
      <span className="review-webpage-kicker">FIELDNOTES</span>
      <h1>A calmer place to work.</h1>
      <p>Thoughtful tools leave room for your ideas. Review the latest notes, compare the details, and keep your conversation close.</p>
      <div className="review-webpage-rule" />
      <h2>Design review</h2>
      <p>Look at the relationship between the page, its controls and the feedback that helps you keep moving.</p>
    </div>
    <output hidden data-testid="review-browser-event">{event}</output>
  </section>;
}

function ComposerReview() {
  const [activeView, setActiveView] = useState("chat");
  const controller = useChatRunStop({ conversationId: null, targets: [], canStop: false, viewerUserId: null });
  const goalStatus = query.get("goal") === "paused" ? "paused" : query.get("goal") === "blocked" ? "blocked" : "active";
  return <section className="review-conversation" aria-label="Conversation preview" data-testid="review-conversation">
    <div className="review-transcript">
      <Text as="h2" variant="bodyStrong" tone="primary">Design review</Text>
      <Text as="p" variant="body" tone="muted">Compare the layout on a phone and a larger screen.</Text>
      <div className="review-reply"><Text as="p" variant="body" tone="primary">I’ll check the spacing, focus states and feedback while keeping your draft in place.</Text></div>
    </div>
    <Composer controller={controller} readOnly={query.has("disabled")} recording={surface === "recording"}
      fullPage attachmentCount={0}
      utilityReview={surface === "goal" ? { goalStatus } : undefined}
      queueReview={{ count: 0, initialDraft: surface === "recording" ? "" : initialDraft }}
      viewNavigation={<ConversationSurfaceTabs presentation="composer" chatPanelId="review-chat" activeId={activeView} resourceId="browser"
        resources={[{ id: "browser", label: "Browser", panelId: "review-browser-view", icon: <Globe className="h-3.5 w-3.5" /> }]}
        split={false} wide={false} ratio={.55} onSelect={setActiveView} onSplitChange={() => {}} />} />
    <output hidden data-testid="review-view">{activeView}</output>
  </section>;
}

function Review() {
  return <main className={`review-app ${browserReview ? "review-browser-primary" : "review-composer-primary"}`} data-testid="review-app">
    <header className="review-heading"><Text variant="bodyStrong" tone="primary">Workspace review</Text><Text variant="caption" tone="muted">Production components · local sample data</Text></header>
    <div className="review-layout" data-testid="review-layout"><ComposerReview /><BrowserReview /></div>
  </main>;
}

createRoot(document.getElementById("root")!).render(<Review />);
