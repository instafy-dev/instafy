import type {
  Event as ElectronEvent,
  Input,
  MouseInputEvent,
  Rectangle,
  View,
  WebContents,
  WebContentsView,
} from "electron";

const SHIELD_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'"
    />
    <style>
      :root, body { width: 100%; height: 100%; margin: 0; background: transparent; }
      body { cursor: pointer; overflow: hidden; user-select: none; }
      /* Match BrowserAgentSurface's mosaic in this isolated native document. */
      .mosaic {
        position: fixed; inset: 0; pointer-events: none; opacity: 0;
        mask-image: repeating-linear-gradient(90deg, #000 0 22px, transparent 22px 26px), repeating-linear-gradient(0deg, #000 0 22px, transparent 22px 26px);
        mask-composite: intersect;
      }
      .mosaic::before, .mosaic::after {
        content: ""; position: absolute; inset: 0 auto 0 -100%; width: 300%;
        background: radial-gradient(ellipse 24% 65% at 50% 50%, #818cf81f, #38bdf80a 50%, transparent 75%);
        animation: mosaic-wave 12s ease-in-out infinite alternate paused;
      }
      .mosaic::after { background: radial-gradient(ellipse 28% 55% at 50% 50%, #a78bfa18, #818cf808 50%, transparent 75%); animation-duration: 17s; animation-direction: alternate-reverse; }
      body[data-working="true"] .mosaic { opacity: 1; }
      body[data-working="true"] .mosaic::before, body[data-working="true"] .mosaic::after { animation-play-state: running; will-change: transform; }
      .status {
        position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%);
        padding: 8px 14px; border: 1px solid #ffffff26; border-radius: 999px;
        background: #0f172ae6; color: white;
        font: 500 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        white-space: nowrap; opacity: 0; pointer-events: none;
      }
      body:hover .status { opacity: 1; }
      @keyframes mosaic-wave { 0% { transform: translate(-28%, -8%) rotate(-8deg); } 50% { transform: translate(0, 8%) rotate(0deg); } 100% { transform: translate(28%, -8%) rotate(8deg); } }
      @media (prefers-reduced-motion: reduce) { .mosaic::before, .mosaic::after { animation: none; transform: none; will-change: auto !important; } }
    </style>
  </head>
  <body role="button" tabindex="0" aria-label="AI has browser control. Click to take over, or press Escape to pause."><div class="mosaic" aria-hidden="true"></div><div class="status">Click to take over · Esc to pause</div></body>
</html>`;

const SHIELD_URL = `data:text/html;charset=utf-8,${encodeURIComponent(SHIELD_HTML)}`;

type PersonalBrowserInputShieldOptions = {
  createView: () => WebContentsView;
  onEmergencyEscape: () => void;
  onTakeOverRequest?: () => void;
};

export class PersonalBrowserInputShield {
  private readonly createView: PersonalBrowserInputShieldOptions["createView"];
  private readonly onEmergencyEscape: PersonalBrowserInputShieldOptions["onEmergencyEscape"];
  private readonly onTakeOverRequest: () => void;
  private working = false;
  private loaded = false;
  private appliedWorking: boolean | null = null;
  private owner: View | null = null;
  private protectedContents: WebContents | null = null;
  private shieldView: WebContentsView | null = null;
  private active = false;
  private injectedInputDepth = 0;
  async withInjectedInput<T>(operation: () => Promise<T>): Promise<T> {
    this.injectedInputDepth++;
    try { return await operation(); } finally { this.injectedInputDepth--; }
  }
  private readonly handleProtectedInput = (event: ElectronEvent, input: Input) => {
    if (!this.injectedInputDepth) this.handleBeforeInput(event,input);
  };
  private visible = false;
  private showing = false;
  private bounds: Rectangle = { x: 0, y: 0, width: 1, height: 1 };
  private emergencyEscapeQueued = false;

  constructor(options: PersonalBrowserInputShieldOptions) {
    this.createView = options.createView;
    this.onEmergencyEscape = options.onEmergencyEscape;
    this.onTakeOverRequest = options.onTakeOverRequest ?? (() => undefined);
  }

  attach(owner: View, protectedContents: WebContents) {
    if (this.protectedContents !== protectedContents) {
      this.protectedContents?.removeListener("before-input-event", this.handleProtectedInput);
      this.protectedContents = protectedContents;
      protectedContents.on("before-input-event", this.handleProtectedInput);
    }
    if (this.owner !== owner) {
      if (this.owner && this.shieldView) {
        this.owner.removeChildView(this.shieldView);
      }
      this.owner = owner;
    }
    this.syncView();
  }

  sync(active: boolean, visible: boolean, bounds: Rectangle, working = false) {
    this.active = active;
    this.visible = visible;
    this.bounds = bounds;
    this.working = active && visible && working;
    this.syncActivity();
    this.syncView();
  }

  destroy() {
    this.active = false;
    this.visible = false;
    this.showing = false;
    this.protectedContents?.removeListener("before-input-event", this.handleProtectedInput);
    this.protectedContents = null;
    const view = this.shieldView;
    this.shieldView = null;
    this.loaded = false;
    this.appliedWorking = null;
    if (!view) {
      this.owner = null;
      return;
    }
    this.owner?.removeChildView(view);
    view.webContents.removeListener("before-input-event", this.handleShieldInput);
    view.webContents.removeListener("before-mouse-event", this.handleMouseInput);
    if (!view.webContents.isDestroyed()) {
      view.webContents.close({ waitForBeforeUnload: false });
    }
    this.owner = null;
  }

  private readonly handleBeforeInput = (event: ElectronEvent, input: Input) => {
    if (!this.active) return;
    event.preventDefault();
    if (
      input.type === "keyDown" &&
      (input.key === "Escape" || input.code === "Escape") &&
      !this.emergencyEscapeQueued
    ) {
      this.emergencyEscapeQueued = true;
      queueMicrotask(() => {
        this.emergencyEscapeQueued = false;
        if (this.active) {
          this.onEmergencyEscape();
        }
      });
    }
  };

  private readonly handleShieldInput = (event: ElectronEvent, input: Input) => {
    this.handleBeforeInput(event, input);
    if (this.active && this.visible && input.type === "keyDown" && ["Enter", " "].includes(input.key)) {
      this.onTakeOverRequest();
    }
  };

  private readonly handleMouseInput = (event: ElectronEvent, input: MouseInputEvent) => {
    if (!this.active) return;
    event.preventDefault();
    if (this.visible && input.type === "mouseUp" && input.button === "left") this.onTakeOverRequest();
  };

  private syncActivity() {
    const view = this.shieldView;
    if (!this.loaded || !view || view.webContents.isDestroyed() || this.appliedWorking === this.working) return;
    this.appliedWorking = this.working;
    void view.webContents.executeJavaScript(`document.body.dataset.working = "${this.working}"`).catch(() => undefined);
  }

  private ensureView(): WebContentsView | null {
    if (this.shieldView) {
      return this.shieldView;
    }
    if (!this.owner) {
      return null;
    }
    const view = this.createView();
    view.setBackgroundColor("#00000000");
    view.setVisible(false);
    view.setBounds(this.bounds);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.on("before-input-event", this.handleShieldInput);
    view.webContents.on("before-mouse-event", this.handleMouseInput);
    view.webContents.on("context-menu", (event) => event.preventDefault());
    this.shieldView = view;
    void view.webContents.loadURL(SHIELD_URL).then(() => {
      if (this.shieldView !== view) return;
      this.loaded = true;
      this.syncActivity();
    }).catch(() => undefined);
    return view;
  }

  private syncView() {
    if (!this.active) {
      this.showing = false;
      if (this.shieldView) {
        this.shieldView.setVisible(false);
      }
      if (this.visible && this.protectedContents && !this.protectedContents.isDestroyed()) {
        this.protectedContents.focus();
      }
      return;
    }
    // Attaching even a hidden native view can steal focus from a DOM menu.
    // Keep keyboard interception active, but defer mounting the shield until
    // the protected page is visible again.
    if (!this.visible) {
      this.showing = false;
      this.shieldView?.setVisible(false);
      return;
    }
    const view = this.ensureView();
    if (!view || !this.owner) {
      return;
    }
    view.setBounds(this.bounds);
    // Re-adding an existing child moves it above the protected Personal view,
    // so pointer, wheel, and drag input cannot race the agent's isolated DOM
    // mutation. Keyboard input is independently intercepted on both contents.
    this.owner.addChildView(view);
    view.setVisible(this.visible);
    if (this.visible && !this.showing && !view.webContents.isDestroyed()) {
      view.webContents.focus();
    }
    this.showing = this.visible;
  }
}
