import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Globe, MoreHoriz, NavArrowLeft, Refresh } from "iconoir-react";
import { Button, IconButton } from "../../../src/components/Button";
import { Text } from "../../../src/components/Text";
import { ConversationSurfaceTabs } from "../../../src/workspace/ConversationSurfaceLayout";
import { BrowserSessionModal } from "../../../src/screens/studio/components/BrowserSessionModal";
import { BrowserChromeShell, BrowserStatusPill } from "../../../src/screens/studio/components/BrowserChromeShell";
import { BrowserTransportSelector } from "../../../src/screens/studio/components/PersonalBrowserSurface";
import "./review.css";

declare const __BROWSER_BOUNDARIES_BASELINE__: boolean;
const params = new URLSearchParams(location.search);
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const noop = () => {};
const resources = [{ id: "browser", label: "Browser", panelId: "review-browser", icon: <Globe className="h-3.5 w-3.5" /> }];

function Review() {
  const [activeId, setActiveId] = useState("browser");
  const [composerView, setComposerView] = useState("chat");
  const [dark, setDark] = useState(params.get("theme") === "dark");
  const [address, setAddress] = useState("https://fixture.example.test");
  return (
    <main className="review-page">
      <header className="review-heading">
        <div>
          <Text as="h1" variant="bodyStrong" tone="primary">Browser boundaries · {__BROWSER_BOUNDARIES_BASELINE__ ? "Before" : "After"}</Text>
          <Text as="p" variant="caption" tone="secondary">Production controls with a sample composer. Browser transport is disabled.</Text>
        </div>
        <Button preset="inline" variant="ghost" onPress={() => {
          document.documentElement.classList.toggle("dark", !dark);
          setDark(!dark);
        }}>{dark ? "Light" : "Dark"}</Button>
      </header>
      <section aria-label="Conversation and browser boundary" className="review-section">
        <Text as="h2" variant="bodyStrong" tone="primary">Conversation → browser</Text>
        <div className="review-browser">
          <ConversationSurfaceTabs chatPanelId="review-chat" resources={resources} activeId={activeId} resourceId="browser"
            split={false} wide={false} ratio={.55} onSelect={setActiveId} onSplitChange={noop} />
          <div id="review-chat" role="tabpanel" aria-label="Chat" hidden={activeId !== "chat"} className="review-chat">Sample chat content. Switch to Browser to inspect its top boundary.</div>
          <div id="review-browser" role="tabpanel" aria-label="Browser" hidden={activeId !== "browser"} className="review-session">
            <BrowserSessionModal isOpen onOpenChange={noop} projectId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
              currentUserId="review-user" preferRuntimeId={null} resumeRuntimeId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
              presentation="docked" fillContainer canControlBrowser sharedBrowserCapabilitiesResolved={false}
              sharedBrowserViewerKind="cdp-screencast" sharedBrowserAvailableViewerKinds={["cdp-screencast"]}
              toolbarLeading={<BrowserTransportSelector checked compact mode="shared" personalAvailable onModeChange={noop} />}
              sharedBrowserChrome={{
                compact: true, resolved: true, pendingAction: null, error: null,
                pages: [{ id: "review-page", url: "https://fixture.example.test", host: "fixture.example.test", label: "Review", title: "Review page", isActive: true }],
                onNavigate: noop, onBack: noop, onForward: noop, onReload: noop, onFocusPage: noop, onClearError: noop,
              }} />
          </div>
        </div>
      </section>
      <section aria-label="Wrapping browser toolbar" className="review-section">
        <Text as="h2" variant="bodyStrong" tone="primary">One toolbar, even when controls wrap</Text>
        <BrowserChromeShell label="Review browser controls" testId="review-wrapped-chrome"
          leading={<Globe className="h-4 w-4" aria-hidden />}
          navigation={<>
            <IconButton size="sm" variant="ghost" aria-label="Back"><NavArrowLeft className="h-4 w-4" /></IconButton>
            <IconButton size="sm" variant="ghost" aria-label="Reload"><Refresh className="h-4 w-4" /></IconButton>
          </>}
          address={<input className="review-address" aria-label="Review address" value={address} onChange={event => setAddress(event.target.value)} />}
          status={<BrowserStatusPill state="paused" />}
          actions={<IconButton size="sm" variant="ghost" aria-label="Review options"><MoreHoriz className="h-4 w-4" /></IconButton>} />
        <p className="review-content">Sample scrollable page content begins below the toolbar divider.</p>
      </section>
      <section aria-label="Composer view switcher" className="review-section">
        <Text as="h2" variant="bodyStrong" tone="primary">Chat / Browser beside the composer</Text>
        <div className="review-composer">
          <ConversationSurfaceTabs presentation="composer" chatPanelId="sample-chat" resources={resources}
            activeId={composerView} resourceId="browser" split={false} wide={false} ratio={.55}
            onSelect={setComposerView} onSplitChange={noop} />
          <textarea className="review-draft" aria-label="Sample draft" placeholder="Continue this conversation…" />
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Review />);
